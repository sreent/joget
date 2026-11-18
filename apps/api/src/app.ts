import { createEd25519Signer, createEd25519Verifier, publicKeyPemFor } from '@platform/audit';
import { type Database, ensureSingleOrg, seedManagedPolicy } from '@platform/db';
import type pg from 'pg';
import { PolicyService } from './access/policy-service.js';
import { AppCatalog } from './apps/catalog.js';
import type { OidcProvider } from './auth/oidc.js';
import { SessionService } from './auth/sessions.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { clamdScanner, noScanner, type Scanner } from './files/scan.js';
import { FileService } from './files/service.js';
import { type BlobStore, createBlobStore } from './files/store.js';
import { TokenService } from './tokens/service.js';

/** Seed the managed policy, find (or create) the organization, and wire the services together. */
export async function createAppContext(input: {
  config: Config;
  db: Database;
  pool: pg.Pool;
  oidc: OidcProvider;
  auditSigningKeyPem: string;
  now?: () => Date;
  /** For tests: where files go, and how they're scanned. Otherwise from the configuration. */
  fileStore?: BlobStore;
  scanner?: Scanner;
}): Promise<AppContext> {
  const { config, db, pool, oidc } = input;
  const now = input.now ?? (() => new Date());
  await seedManagedPolicy(db);
  const org = await ensureSingleOrg(db, config.ORG_NAME);
  const policy = new PolicyService(db, org.id, now);
  const sessions = new SessionService(db, config, policy, now);
  const tokens = new TokenService(db, policy, org.id, now);
  const auditSigner = createEd25519Signer(config.AUDIT_SIGNING_KEY_ID, input.auditSigningKeyPem);
  const auditVerifier = createEd25519Verifier({
    ...config.AUDIT_VERIFY_PUBLIC_KEYS,
    [config.AUDIT_SIGNING_KEY_ID]: publicKeyPemFor(input.auditSigningKeyPem),
  });
  const apps = new AppCatalog(db, org.id);
  const scanner = input.scanner ?? (config.FILE_SCANNER === 'clamav' ? clamdScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT }) : noScanner);
  const files = new FileService({ config, db, pool, org, now }, input.fileStore ?? createBlobStore(config), scanner);
  return { config, db, pool, apps, org, oidc, policy, sessions, tokens, files, auditSigner, auditVerifier, now };
}
