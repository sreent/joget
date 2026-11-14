import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Create a throwaway database for one integration test file.
 *
 * Needs TEST_DATABASE_URL: a PostgreSQL URL for a role that may create databases, for example
 * postgres://postgres:postgres@localhost:5432/postgres
 */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const adminUrl = process.env['TEST_DATABASE_URL'];
  if (!adminUrl) {
    throw new Error(
      'Integration tests need TEST_DATABASE_URL, a PostgreSQL URL for a role that can create databases ' +
        '(for example postgres://postgres:postgres@localhost:5432/postgres).',
    );
  }
  const name = `test_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  await withAdmin(adminUrl, (client) => client.query(`create database "${name}"`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => withAdmin(adminUrl, (client) => client.query(`drop database if exists "${name}" with (force)`)).then(() => undefined),
  };
}

async function withAdmin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
