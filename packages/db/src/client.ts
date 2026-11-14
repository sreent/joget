import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything queries can run on: the database, or a transaction. */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly maxConnections?: number;
  readonly applicationName?: string;
  /**
   * Bounds how long a transaction can stay open while idle. The audit sealer relies on
   * transactions being short (design §9.3), so keep this below the sealer's safety window.
   */
  readonly idleInTransactionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'platform',
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 15_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** An arbitrary, fixed key for advisory locks that serialize migrations and seeding. */
export const SCHEMA_LOCK_KEY = 727_001;

/** Apply pending migrations. Safe to call from several processes at once: they take turns. */
export async function migrateDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    try {
      await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
