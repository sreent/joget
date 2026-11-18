import { uuidv7 } from '@platform/audit';
import { appSecrets, type Database } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppContext, AuthContext } from '../context.js';
import { HttpError } from '../errors.js';

/*
 * The secrets that environments keep for their apps (design §6.13): what a connection proves who
 * it is with, and the keys that sign webhooks' requests. Each is sealed with AES-256-GCM under the
 * installation's key, bound to its environment, its kind and its name, so a sealed secret copied
 * to another row doesn't open. Nothing shows a secret again once it is kept, and a flow never
 * sees one: the platform adds it to each call itself.
 */

export type SecretKind = 'connection' | 'webhook';
export interface SecretState {
  readonly set: boolean;
  readonly setAt: string | null;
}

export class Secrets {
  readonly #ctx: AppContext;
  #key: { readonly id: string; readonly bytes: Buffer } | null | undefined;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** The installation's key: from its file, or, outside production, worked out from the cookie secret. */
  #sealingKey(): { readonly id: string; readonly bytes: Buffer } {
    if (this.#key === undefined) {
      const { SECRETS_KEY_FILE, COOKIE_SECRET, NODE_ENV } = this.#ctx.config;
      let bytes: Buffer | null = null;
      if (SECRETS_KEY_FILE) bytes = Buffer.from(readFileSync(SECRETS_KEY_FILE, 'utf8').trim(), 'base64');
      else if (NODE_ENV !== 'production') bytes = Buffer.from(hkdfSync('sha256', COOKIE_SECRET, 'a3t', 'app secrets', 32));
      if (bytes && bytes.length !== 32) throw new Error('SECRETS_KEY_FILE must hold 32 bytes in base64');
      this.#key = bytes ? { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes } : null;
    }
    if (!this.#key) throw new HttpError(409, 'secrets_off', 'This installation keeps no secrets yet: its operators set SECRETS_KEY_FILE first');
    return this.#key;
  }

  #seal(value: string, bound: string): string {
    const key = this.#sealingKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.bytes, nonce);
    cipher.setAAD(Buffer.from(bound));
    const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', key.id, nonce.toString('base64'), sealed.toString('base64'), cipher.getAuthTag().toString('base64')].join(':');
  }

  #open(sealed: string, bound: string): string {
    const [version, keyId, nonce, data, tag] = sealed.split(':');
    const key = this.#sealingKey();
    if (version !== 'v1' || keyId !== key.id || !nonce || !data || !tag) throw new Error('A secret sealed with another key: set it again');
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(nonce, 'base64'));
    decipher.setAAD(Buffer.from(bound));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Keep a secret for an environment, in place of the one it had. */
  async set(db: Database, env: { readonly id: string; readonly appId: string }, kind: SecretKind, name: string, value: string, auth: AuthContext): Promise<SecretState> {
    const now = this.#ctx.now();
    const sealed = this.#seal(value, `${env.id}/${kind}/${name}`);
    await db
      .insert(appSecrets)
      .values({ id: uuidv7(now.getTime()), orgId: this.#ctx.org.id, appId: env.appId, environmentId: env.id, kind, name, sealed, setByType: auth.actor.type, setBy: auth.actor.id, setAt: now })
      .onConflictDoUpdate({ target: [appSecrets.environmentId, appSecrets.kind, appSecrets.name], set: { sealed, setByType: auth.actor.type, setBy: auth.actor.id, setAt: now } });
    return { set: true, setAt: now.toISOString() };
  }

  async clear(db: Database, environmentId: string, kind: SecretKind, name: string): Promise<boolean> {
    const gone = await db
      .delete(appSecrets)
      .where(and(eq(appSecrets.environmentId, environmentId), eq(appSecrets.kind, kind), eq(appSecrets.name, name)))
      .returning({ id: appSecrets.id });
    return gone.length > 0;
  }

  /** Whether an environment keeps each secret, and since when: never the secrets themselves. */
  async states(db: Database, environmentId: string): Promise<ReadonlyMap<string, SecretState>> {
    const rows = await db.select({ kind: appSecrets.kind, name: appSecrets.name, setAt: appSecrets.setAt }).from(appSecrets).where(eq(appSecrets.environmentId, environmentId));
    return new Map(rows.map((row) => [`${row.kind}/${row.name}`, { set: true, setAt: row.setAt.toISOString() }]));
  }

  /** A secret, for the platform to add to a call itself. Undefined if the environment keeps none. */
  async reveal(db: Database, environmentId: string, kind: SecretKind, name: string): Promise<string | undefined> {
    const [row] = await db
      .select({ sealed: appSecrets.sealed })
      .from(appSecrets)
      .where(and(eq(appSecrets.environmentId, environmentId), eq(appSecrets.kind, kind), eq(appSecrets.name, name)));
    return row ? this.#open(row.sealed, `${environmentId}/${kind}/${name}`) : undefined;
  }
}
