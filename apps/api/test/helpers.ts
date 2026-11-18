import { randomUUID } from 'node:crypto';
import { generateEd25519KeyPair } from '@platform/audit';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '@platform/db';
import { createTestDatabase } from '@platform/db/testing';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { createAppContext } from '../src/app.js';
import { IdpUnavailableError, InvalidSubjectTokenError, type OidcIdentity, type OidcProvider } from '../src/auth/oidc.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import type { ModelClient } from '../src/compose/composer.js';
import type { Mailer } from '../src/notices/mail.js';
import { buildServer, type Server } from '../src/server.js';

export function identity(subject: string, overrides: Partial<OidcIdentity> = {}): OidcIdentity {
  return {
    issuer: 'https://idp.test',
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    name: subject.charAt(0).toUpperCase() + subject.slice(1),
    groups: [],
    amr: ['pwd', 'mfa'],
    acr: null,
    authTime: null,
    ...overrides,
  };
}

/** A stand-in identity provider: the authorization code is simply the user's subject. */
export class FakeIdp implements OidcProvider {
  readonly identities = new Map<string, OidcIdentity>();
  /** Set to false to simulate an outage: the provider then fails the way the real one does. */
  reachable = true;

  async startLogin({ redirectUri }: { redirectUri: string }) {
    if (!this.reachable) throw new IdpUnavailableError(new Error('connect ECONNREFUSED'));
    const state = randomUUID();
    return {
      url: `https://idp.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      state,
      nonce: randomUUID(),
      codeVerifier: randomUUID(),
    };
  }

  /** A fake IdP token is `idtoken:<subject>`: it names that person, as a signed ID token would. */
  async verifyToken(token: string) {
    if (!this.reachable) throw new IdpUnavailableError(new Error('connect ECONNREFUSED'));
    const subject = /^idtoken:([a-z0-9-]+)$/.exec(token)?.[1];
    if (!subject) throw new InvalidSubjectTokenError('signature verification failed');
    return this.identities.get(subject) ?? identity(subject);
  }

  async completeLogin({ callbackUrl, state }: { callbackUrl: URL; state: string }) {
    if (!this.reachable) throw new IdpUnavailableError(new Error('connect ECONNREFUSED'));
    if (callbackUrl.searchParams.get('state') !== state) throw new Error('state mismatch');
    const found = this.identities.get(callbackUrl.searchParams.get('code') ?? '');
    if (!found) throw new Error('invalid authorization code');
    return found;
  }
}

export interface Session {
  readonly cookies: Record<string, string>;
  readonly userId: string;
  readonly personalSpaceId: string;
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly server: Server;
  readonly ctx: AppContext;
  readonly handle: DatabaseHandle;
  readonly idp: FakeIdp;
  /** Move the API's clock, for example to make an MFA login stale. */
  readonly clock: { offsetMs: number };
  login(subject: string): Promise<Session>;
  close(): Promise<void>;
}

export async function startTestApp(env: Record<string, string> = {}, options: { readonly models?: ModelClient; readonly mailer?: Mailer } = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  const handle = createDatabase(database.url);
  await migrateDatabase(handle.pool);
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://platform.test',
    DATABASE_URL: database.url,
    OIDC_ISSUER: 'https://idp.test',
    OIDC_CLIENT_ID: 'platform',
    COOKIE_SECRET: 'test-cookie-secret-that-is-long-enough',
    COOKIE_SECURE: 'false',
    ORG_NAME: 'Acme',
    ORG_OWNER_EMAILS: 'alice@example.com',
    AUDIT_SEAL_INTERVAL_SECONDS: '0',
    AUDIT_SEAL_SAFETY_WINDOW_SECONDS: '0',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const idp = new FakeIdp();
  const clock = { offsetMs: 0 };
  const ctx = await createAppContext({
    config,
    db: handle.db,
    pool: handle.pool,
    oidc: idp,
    auditSigningKeyPem: generateEd25519KeyPair().privateKeyPem,
    now: () => new Date(Date.now() + clock.offsetMs),
  });
  const server = await buildServer(ctx, { logger: false, ...(options.models ? { models: options.models } : {}), ...(options.mailer ? { mailer: options.mailer } : {}) });
  const { app } = server;

  return {
    app,
    server,
    ctx,
    handle,
    idp,
    clock,
    async login(subject) {
      if (!idp.identities.has(subject)) idp.identities.set(subject, identity(subject));
      const start = await app.inject({ method: 'GET', url: '/auth/login' });
      expect(start.statusCode).toBe(302);
      const state = new URL(String(start.headers.location)).searchParams.get('state');
      const loginCookie = start.cookies.find((c) => c.name === 'platform_login');
      const callback = await app.inject({
        method: 'GET',
        url: `/auth/callback?code=${encodeURIComponent(subject)}&state=${state}`,
        cookies: { platform_login: loginCookie!.value },
      });
      expect(callback.statusCode, callback.body).toBe(302);
      const session = callback.cookies.find((c) => c.name === 'platform_session');
      const cookies = { platform_session: session!.value };
      const me = await app.inject({ method: 'GET', url: '/v1/me', cookies });
      expect(me.statusCode, me.body).toBe(200);
      return { cookies, userId: me.json().id, personalSpaceId: me.json().personalSpaceId };
    },
    async close() {
      await app.close();
      await handle.close();
      await database.drop();
    },
  };
}
