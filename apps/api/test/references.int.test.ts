import { EXPENSE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * References, end to end (design §6.1): a claim can be for several trips. The platform keeps the
 * list true as a foreign key keeps a reference to one record, shows the titles of the records a
 * person may read, finds records by their title for a picker, and a page about a trip lists the
 * claims whose list holds it.
 */

let t: TestApp;
let alice: Session; // builds the app, and plans trips
let bob: Session; // requester
let carol: Session; // approver: reads claims, not trips
let appId: string;
let tokyo: string;
let penang: string;

const as = (session: Session) => ({ cookies: session.cookies });
const trips = () => `/v1/apps/${appId}/entities/trip/records`;
const claims = () => `/v1/apps/${appId}/entities/expense_claim/records`;
const receipt = { date: '2026-11-02', merchant: 'Shop', category: 'travel', amount: 40 };

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

function withTrips() {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.trip = { label: 'Trip', pluralLabel: 'Trips', titleField: 'name', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }] };
  draft.entities.expense_claim.fields.push({ name: 'trips', label: 'Trips', type: 'reference', entity: 'trip', multiple: true });
  draft.actions.submit_claim.input.push('trips');
  draft.roles.requester.entities.trip = { read: true };
  draft.pages.trip_page = {
    label: 'Trip',
    record: { entity: 'trip' },
    blocks: [{ type: 'list', entity: 'expense_claim', columns: ['title', 'trips'], of: 'trips' }],
  };
  return draft;
}

async function submit(session: Session, title: string, list: unknown, expected = 201) {
  return inject(
    { method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(session), payload: { values: { title, lines: [receipt], trips: list } } },
    expected,
  );
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
  appId = (
    await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: withTrips() } }, 201)
  ).json().app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'carol@example.com', role: 'approver' } }, 201);
  tokyo = (await inject({ method: 'POST', url: trips(), ...as(alice), payload: { values: { name: 'Tokyo summit' } } }, 201)).json().id;
  penang = (await inject({ method: 'POST', url: trips(), ...as(alice), payload: { values: { name: 'Penang 100% retreat' } } }, 201)).json().id;
});

afterAll(async () => {
  await t?.close();
});

describe('references to several records', () => {
  it('hold the records given, each once, and show their titles to whoever may read them', async () => {
    const done = (await submit(bob, 'Both trips', [penang, tokyo, penang])).json();
    expect(done.record.values.trips).toEqual([penang, tokyo]);
    expect(done.record.titles).toEqual({ [penang]: 'Penang 100% retreat', [tokyo]: 'Tokyo summit' });
    // Carol approves claims but can't read trips: she sees the IDs, and no titles.
    const seen = (await inject({ method: 'GET', url: `${claims()}/${done.record.id}`, ...as(carol) }, 200)).json();
    expect(seen.values.trips).toEqual([penang, tokyo]);
    expect(seen).not.toHaveProperty('titles');
  });

  it('take only records that exist', async () => {
    const missing = '0193a7c4-0000-7000-8000-00000000dead';
    const refused = (await submit(bob, 'Nowhere', [tokyo, missing], 422)).json();
    expect(refused).toMatchObject({ error: 'unknown_reference', details: { missing: [missing] } });
  });

  it('keep the records they hold: a trip a claim is for stays until the claim lets it go', async () => {
    const solo = (await inject({ method: 'POST', url: trips(), ...as(alice), payload: { values: { name: 'Solo trip' } } }, 201)).json().id;
    const claim = (await submit(alice, 'Solo', [solo])).json().record;
    expect((await inject({ method: 'DELETE', url: `${trips()}/${solo}`, ...as(alice) }, 409)).json()).toMatchObject({ error: 'record_referenced' });
    await inject({ method: 'PATCH', url: `${claims()}/${claim.id}`, ...as(alice), payload: { values: { trips: [] }, version: claim.version } }, 200);
    await inject({ method: 'DELETE', url: `${trips()}/${solo}`, ...as(alice) });
    await inject({ method: 'GET', url: `${trips()}/${solo}`, ...as(alice) }, 404);
  });

  it('let a page about a trip list the claims whose list holds it', async () => {
    await submit(bob, 'Only Tokyo', [tokyo]);
    const listed = async (trip: string) =>
      (
        (await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/trip_page/blocks/0/records?record=${trip}`, ...as(bob) }, 200)).json().records as Array<{
          values: { title: string };
        }>
      )
        .map((record) => record.values.title)
        .sort();
    expect(await listed(tokyo)).toEqual(['Both trips', 'Only Tokyo']);
    expect(await listed(penang)).toEqual(['Both trips']);
  });

  it('find records by their title, for a picker, matching % and _ as plain characters', async () => {
    const found = async (search: string) =>
      (
        (await inject({ method: 'GET', url: `${trips()}?search=${encodeURIComponent(search)}`, ...as(bob) }, 200)).json().records as Array<{
          values: { name: string };
        }>
      ).map((r) => r.values.name);
    expect(await found('TOKYO')).toEqual(['Tokyo summit']);
    expect(await found('100%')).toEqual(['Penang 100% retreat']);
    expect(await found('%')).toEqual(['Penang 100% retreat']);
    expect(await found('_')).toEqual([]);
    // Claims have a title too; an entity without one can't be searched.
    expect((await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/expense_line/records?search=x`, ...as(alice) })).statusCode).toBeGreaterThanOrEqual(
      400,
    );
  });
});
