import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retryTransient } from '../src/apps/transaction.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Two transactions that take the same two rows in opposite orders wait for each other.
 * PostgreSQL ends one of them, and the retry runs it again once the other is through.
 */
let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe('a deadlock', () => {
  it('ends one of the two transactions, which then runs again and gets through', async () => {
    const pool = t.handle.pool;
    await pool.query('create table deadlock_probe (id int primary key, n int not null)');
    await pool.query('insert into deadlock_probe values (1, 0), (2, 0)');
    let retries = 0;
    const cross = (first: number, second: number) =>
      retryTransient(
        async () => {
          const client = await pool.connect();
          try {
            await client.query('begin');
            await client.query('update deadlock_probe set n = n + 1 where id = $1', [first]);
            await client.query('select pg_sleep(0.3)');
            await client.query('update deadlock_probe set n = n + 1 where id = $1', [second]);
            await client.query('commit');
          } catch (error) {
            await client.query('rollback');
            throw error;
          } finally {
            client.release();
          }
        },
        { onRetry: () => retries++ },
      );
    await Promise.all([cross(1, 2), cross(2, 1)]);
    expect(retries).toBeGreaterThanOrEqual(1);
    expect((await pool.query('select n from deadlock_probe order by id')).rows).toEqual([{ n: 2 }, { n: 2 }]);
  });
});
