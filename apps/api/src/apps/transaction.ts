import { ident } from '@platform/app-model';
import { schema, type Database } from '@platform/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { HttpError } from '../errors.js';
import type { EnvironmentRow } from './catalog.js';

export interface AppTransaction {
  /** Platform tables and audit events, in the same transaction. */
  readonly db: Database;
  /** The definition revision whose data model the environment has, read under the lock. */
  readonly revision: number;
  /** The revision the environment runs, read under the lock. Behind `revision` after a rollback. */
  readonly activeRevision: number;
  /** Run SQL on app data, as the environment's own database role (design §6.8). */
  query<R extends pg.QueryResultRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<pg.QueryResult<R>>;
  /** Run SQL as the platform itself, for example DDL. */
  platformQuery<R extends pg.QueryResultRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<pg.QueryResult<R>>;
}

/** How many times a transaction runs at most while it keeps losing to others. */
export const TRANSACTION_ATTEMPTS = 4;

const codeOf = (value: unknown): unknown => (typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined);
const causeOf = (value: unknown): unknown => (typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined);

/**
 * Whether an error means that the transaction lost to another one and can simply run again: a
 * deadlock (40P01) or a serialization failure (40001). Drizzle keeps the driver's error as its cause.
 */
export function isTransient(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current !== undefined && depth < 4; depth++, current = causeOf(current)) {
    const code = codeOf(current);
    if (code === '40P01' || code === '40001') return true;
  }
  return false;
}

/**
 * Run a transaction again when it loses to another. PostgreSQL ends one of two transactions that
 * wait for each other: for example, a call that locks its own record and then another's, while a
 * change there takes the two records the other way round. The work starts again from the
 * beginning each time, so it must change nothing outside the database. After the last try, the
 * request fails with 503, and the person can try again.
 */
export async function retryTransient<T>(run: () => Promise<T>, options: { readonly attempts?: number; readonly onRetry?: (attempt: number) => void } = {}): Promise<T> {
  const attempts = options.attempts ?? TRANSACTION_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransient(error)) throw error;
      if (attempt >= attempts) throw new HttpError(503, 'busy', 'Others changed the same records at the same moment. Try again.');
      options.onRetry?.(attempt);
      // A short wait, longer each time and partly by chance, so that the two don't meet again.
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 40));
    }
  }
}

/** A 64-bit advisory-lock key for an environment, from the random part of its UUIDv7. */
function lockKey(environmentId: string): string {
  return BigInt.asIntN(64, BigInt(`0x${environmentId.replaceAll('-', '').slice(16)}`)).toString();
}

/** Take an environment's exclusive lock in a transaction of one's own, before changing its data model. */
export async function lockEnvironment(client: pg.PoolClient, environmentId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock($1::bigint)', [lockKey(environmentId)]);
}

/**
 * Run work on an environment's data in one transaction, and again if it loses to another.
 *
 * Record work takes a shared lock on the environment and data-model changes an exclusive one, so a
 * schema change never runs under a query compiled for the previous data model. App-data SQL runs
 * as the environment's NOLOGIN role, which can reach that schema's tables and nothing else.
 */
export function withAppTransaction<T>(pool: pg.Pool, env: EnvironmentRow, mode: 'records' | 'schema', work: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return retryTransient(() => appTransaction(pool, env, mode, work));
}

async function appTransaction<T>(pool: pg.Pool, env: EnvironmentRow, mode: 'records' | 'schema', work: (tx: AppTransaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query(mode === 'records' ? 'select pg_advisory_xact_lock_shared($1::bigint)' : 'select pg_advisory_xact_lock($1::bigint)', [lockKey(env.id)]);
    const current = await client.query<{ applied_revision: number; active_revision: number }>(
      'select applied_revision, active_revision from app_environments where id = $1',
      [env.id],
    );
    const role = ident(env.dbRole);
    const tx: AppTransaction = {
      db: drizzle(client, { schema }),
      revision: current.rows[0]?.applied_revision ?? env.appliedRevision,
      activeRevision: current.rows[0]?.active_revision ?? env.activeRevision,
      async query(text, values = []) {
        await client.query(`set local role ${role}`);
        try {
          return await client.query(text, [...values]);
        } finally {
          await client.query('set local role none').catch(() => undefined);
        }
      },
      platformQuery: (text, values = []) => client.query(text, [...values]),
    };
    const result = await work(tx);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Run work in one transaction on a dedicated connection, for DDL together with platform rows, and again if it loses to another. */
export function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient, db: Database) => Promise<T>): Promise<T> {
  return retryTransient(() => transaction(pool, work));
}

async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient, db: Database) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    const result = await work(client, drizzle(client, { schema }));
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
