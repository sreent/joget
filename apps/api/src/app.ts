import { createEd25519Signer, createEd25519Verifier, publicKeyPemFor } from '@platform/audit';
import { ensureSingleOrg, seedManagedPolicy, type Database } from '@platform/db';
import type pg from 'pg';
import { AppCatalog } from './apps/catalog.js';
import { PolicyService } from './access/policy-service.js';
import type { OidcProvider } from './auth/oidc.js';
import { SessionService } from './auth/sessions.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { TokenService } from './tokens/service.js';

/** Seed the managed policy, find (or create) the organization, and wire the services together. */
export async function createAppContext(input: {
  config: Config;
  db: Database;
  pool: pg.Pool;
  oidc: OidcProvider;
  auditSigningKeyPem: string;
  now?: () => Date;
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
  return { config, db, pool, apps, org, oidc, policy, sessions, tokens, auditSigner, auditVerifier, now };
}
