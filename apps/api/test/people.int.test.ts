import { randomUUID } from 'node:crypto';
import { users } from '@platform/db';
import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/** The directory that apps need: naming who records mention, and finding a colleague for a person field. */

let t: TestApp;
let alice: Session;
let bob: Session;
let dave: Session;
let accountId: string;
let accountToken: string;

const as = (session: Session) => ({ cookies: session.cookies });

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const people = async (query: string, session: Session = alice) => (await inject({ method: 'GET', url: `/v1/people?${query}`, ...as(session) }, 200)).json().people;

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, dave] = [await t.login('alice'), await t.login('bob'), await t.login('dave')];
  const team = await inject({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Finance', coOwnerUserIds: [bob.userId] } }, 201);
  const account = await inject({ method: 'POST', url: `/v1/spaces/${team.json().id}/service-accounts`, ...as(alice), payload: { name: 'Importer', description: 'Loads claims' } }, 201);
  accountId = account.json().id;
  const token = await inject({ method: 'POST', url: `/v1/service-accounts/${accountId}/tokens`, ...as(alice), payload: { name: 'importer', scopes: ['space.read'], expiresInDays: 1 } }, 201);
  accountToken = token.json().token;
  // Dave has left: records still name him, but he can't be picked any more.
  await t.ctx.db.update(users).set({ status: 'deprovisioned' }).where(eq(users.id, dave.userId));
});

afterAll(async () => {
  await t?.close();
});

describe('the people directory', () => {
  it('finds active colleagues by part of a name or email', async () => {
    expect(await people('search=bo')).toEqual([{ id: bob.userId, kind: 'person', name: 'Bob', email: 'bob@example.com', active: true }]);
    expect((await people('search=EXAMPLE.com')).map((p: { name: string }) => p.name)).toEqual(['Alice', 'Bob']);
    expect(await people('search=dave')).toEqual([]);
    // Wildcards are literal: "a_i" would match "ali" if "_" were one.
    expect(await people('search=a_i')).toEqual([]);
    expect(await people('search=%25%25')).toEqual([]);
  });

  it('names the people and agents that records and history mention, including those who have left', async () => {
    const found = await people(`ids=${[bob.userId, accountId, dave.userId, randomUUID(), bob.userId].join(',')}`, bob);
    expect(found).toEqual(
      expect.arrayContaining([
        { id: bob.userId, kind: 'person', name: 'Bob', active: true },
        { id: dave.userId, kind: 'person', name: 'Dave', active: false },
        { id: accountId, kind: 'agent', name: 'Importer', active: true },
      ]),
    );
    expect(found).toHaveLength(3);
    expect(await people('ids=')).toEqual([]);
  });

  it('refuses service accounts acting as themselves, and malformed lookups', async () => {
    await inject({ method: 'GET', url: '/v1/people?search=bob' }, 401);
    const refused = await inject({ method: 'GET', url: '/v1/people?search=bob', headers: { authorization: `Bearer ${accountToken}` } }, 403);
    expect(refused.json().error).toBe('person_required');
    expect((await inject({ method: 'GET', url: '/v1/people', ...as(alice) }, 400)).json().error).toBe('invalid_query');
    expect((await inject({ method: 'GET', url: '/v1/people?search=bob&ids=', ...as(alice) }, 400)).json().error).toBe('invalid_query');
    expect((await inject({ method: 'GET', url: '/v1/people?ids=bob', ...as(alice) }, 400)).json().error).toBe('invalid_ids');
    const many = Array.from({ length: 101 }, () => randomUUID()).join(',');
    expect((await inject({ method: 'GET', url: `/v1/people?ids=${many}`, ...as(alice) }, 400)).json().error).toBe('too_many_ids');
    await inject({ method: 'GET', url: '/v1/people?search=b', ...as(alice) }, 400);
  });
});
