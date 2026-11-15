import { generateEd25519KeyPair } from '@platform/audit';
import { createDatabase, migrateDatabase } from '@platform/db';
import { createAppContext } from './app.js';
import { startAuditSealer } from './audit/sealer.js';
import { startFileSweeper } from './files/service.js';
import { createResilientOidcProvider } from './auth/oidc.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL, { applicationName: 'platform-api' });
if (config.RUN_MIGRATIONS) await migrateDatabase(database.pool);

const warnings: string[] = [];
let signingKey = config.AUDIT_SIGNING_KEY_PEM;
if (!signingKey) {
  // Only reachable outside production: configuration validation requires a key there.
  signingKey = generateEd25519KeyPair().privateKeyPem;
  warnings.push(
    'AUDIT_SIGNING_KEY_PEM is not set, so a temporary key is in use: seals made now cannot be verified after a restart. ' +
      'Create a key with `pnpm --filter @platform/api audit:keygen`.',
  );
}

let reportIdpError = (error: unknown) => console.error('Cannot reach the identity provider', error);
const oidc = createResilientOidcProvider(config, (error) => reportIdpError(error));
const ctx = await createAppContext({ config, db: database.db, pool: database.pool, oidc, auditSigningKeyPem: signingKey });
const { app } = await buildServer(ctx);
for (const warning of warnings) app.log.warn(warning);
reportIdpError = (error) => app.log.error({ err: error }, 'Cannot reach the identity provider: sign-in answers 503 until it can');
void oidc.warmUp();

const stopSealer =
  config.AUDIT_SEAL_INTERVAL_SECONDS > 0
    ? startAuditSealer(ctx.db, ctx.auditSigner, {
        intervalSeconds: config.AUDIT_SEAL_INTERVAL_SECONDS,
        safetyWindowSeconds: config.AUDIT_SEAL_SAFETY_WINDOW_SECONDS,
        logger: app.log,
      })
    : () => {};

const stopSweeper = config.FILE_SWEEP_INTERVAL_SECONDS > 0 ? startFileSweeper(ctx.files, { intervalSeconds: config.FILE_SWEEP_INTERVAL_SECONDS, logger: app.log }) : () => {};
if (config.FILE_SCANNER === 'none') {
  app.log.warn(config.NODE_ENV === 'production' ? 'FILE_SCANNER is none, so uploads are refused: set up a clamd server' : 'FILE_SCANNER is none: uploads are kept without a malware check');
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  stopSealer();
  stopSweeper();
  await app.close();
  await database.close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
