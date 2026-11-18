import { describe, expect, it } from 'vitest';
import { isTransient, retryTransient } from '../src/apps/transaction.js';
import { HttpError } from '../src/errors.js';

/** An error as the driver raises it, with PostgreSQL's code, and as Drizzle wraps it. */
const pgError = (code: string) => Object.assign(new Error('could not serialize'), { code });
const wrapped = (code: string) => Object.assign(new Error('Failed query'), { cause: pgError(code) });

describe('a transaction that loses to another', () => {
  it('knows a deadlock and a serialization failure, also inside a wrapper, and nothing else', () => {
    expect(isTransient(pgError('40P01'))).toBe(true);
    expect(isTransient(wrapped('40001'))).toBe(true);
    expect(isTransient(pgError('23505'))).toBe(false);
    expect(isTransient(new Error('plain'))).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });

  it('runs again until it gets through, and gives up with 503 after the last try', async () => {
    let runs = 0;
    const retried: number[] = [];
    await expect(
      retryTransient(
        async () => {
          runs++;
          if (runs < 3) throw wrapped('40P01');
          return 'done';
        },
        { onRetry: (attempt) => retried.push(attempt) },
      ),
    ).resolves.toBe('done');
    expect(retried).toEqual([1, 2]);

    runs = 0;
    const busy = await retryTransient(
      async () => {
        runs++;
        throw pgError('40P01');
      },
      { attempts: 2 },
    ).catch((error: unknown) => error);
    expect(runs).toBe(2);
    expect(busy).toBeInstanceOf(HttpError);
    expect(busy).toMatchObject({ statusCode: 503, code: 'busy' });
  });

  it('lets any other error through at once', async () => {
    let runs = 0;
    await expect(
      retryTransient(async () => {
        runs++;
        throw pgError('23505');
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(runs).toBe(1);
  });
});
