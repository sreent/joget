import { ident } from '@platform/app-model';
import { schema, type Database } from '@platform/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
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

/** A 64-bit advisory-lock key for an environment, from the random part of its UUIDv7. */
function lockKey(environmentId: string): string {
  return BigInt.asIntN(64, BigInt(`0x${environmentId.replaceAll('-', '').slice(16)}`)).toString();
}

/** Take an environment's exclusive lock in a transaction of one's own, before changing its data model. */
export async function lockEnvironment(client: pg.PoolClient, environmentId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock($1::bigint)', [lockKey(environmentId)]);
}

/**
 * Run work on an environment's data in one transaction.
 *
 * Record work takes a shared lock on the environment and data-model changes an exclusive one, so a
 * schema change never runs under a query compiled for the previous data model. App-data SQL runs
 * as the environment's NOLOGIN role, which can reach that schema's tables and nothing else.
 */
export async function withAppTransaction<T>(
  pool: pg.Pool,
  env: EnvironmentRow,
  mode: 'records' | 'schema',
  work: (tx: AppTransaction) => Promise<T>,
): Promise<T> {
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

/** Run work in one transaction on a dedicated connection, for DDL together with platform rows. */
export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient, db: Database) => Promise<T>): Promise<T> {
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
