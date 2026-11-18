import { EXPENSE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Pages about one record, end to end (design §6.5): a page shows a record's fields, and in tabs
 * the records that refer to it and a number over them: master and detail. Each list still shows
 * only what the person may read.
 */

let t: TestApp;
let alice: Session; // builds the app
let bob: Session; // requester
let appId: string;
let trip: string;
let other: string;

const as = (session: Session) => ({ cookies: session.cookies });
const block = (path: string, kind: 'records' | 'summary', record?: string) => `/v1/apps/${appId}/pages/trip_page/blocks/${path}/${kind}${record ? `?record=${record}` : ''}`;

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

/** The example with trips: a claim may be for a trip, and a page about one trip shows its claims. */
function withTrips() {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.trip = { label: 'Trip', pluralLabel: 'Trips', titleField: 'name', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }] };
  draft.entities.expense_claim.fields.push({ name: 'for_trip', label: 'For trip', type: 'reference', entity: 'trip' });
  draft.actions.submit_claim.input.push('for_trip');
  draft.roles.requester.entities.trip = { read: true };
  draft.pages.trip_page = {
    label: 'Trip',
    record: { entity: 'trip' },
    blocks: [
      { type: 'fields', fields: ['name', 'created_at'] },
      {
        type: 'tabs',
        tabs: [
          { label: 'Claims', blocks: [{ type: 'list', entity: 'expense_claim', columns: ['title', 'total'], of: 'for_trip', open: 'claim_page' }] },
          { label: 'Spent', blocks: [{ type: 'stat', label: 'Spent on it', entity: 'expense_claim', measure: { op: 'sum', field: 'total' }, of: 'for_trip' }] },
        ],
      },
    ],
  };
  draft.pages.claim_page = { label: 'Claim', record: { entity: 'expense_claim' }, blocks: [{ type: 'fields', fields: ['title', 'total', 'status'] }] };
  return draft;
}

async function claim(session: Session, title: string, amount: number, forTrip: string) {
  const values = { title, lines: [{ date: '2026-11-02', merchant: 'Shop', category: 'travel', amount }], for_trip: forTrip };
  return (await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(session), payload: { values } }, 201)).json().record;
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob] = [await t.login('alice'), await t.login('bob')];
  appId = (await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: withTrips() } }, 201)).json().app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
  const trips = `/v1/apps/${appId}/entities/trip/records`;
  trip = (await inject({ method: 'POST', url: trips, ...as(alice), payload: { values: { name: 'Tokyo summit' } } }, 201)).json().id;
  other = (await inject({ method: 'POST', url: trips, ...as(alice), payload: { values: { name: 'Penang retreat' } } }, 201)).json().id;
  await claim(alice, 'Hotel', 300, trip);
  await claim(bob, 'Flight', 900, trip);
  await claim(bob, 'Train', 40, other);
});

afterAll(async () => {
  await t?.close();
});

describe('a page about one record', () => {
  it('tells screens its record, its fields, and its tabs, with a path for each block', async () => {
    const ui = (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(bob) }, 200)).json();
    expect(ui.pages.trip_page).toMatchObject({
      record: { entity: 'trip' },
      blocks: [
        { type: 'fields', path: '0', fields: ['name', 'created_at'] },
        {
          type: 'tabs',
          tabs: [
            { label: 'Claims', blocks: [{ type: 'list', path: '1.0.0', of: 'for_trip', open: 'claim_page' }] },
            { label: 'Spent', blocks: [{ type: 'stat', path: '1.1.0', of: 'for_trip' }] },
          ],
        },
      ],
    });
  });

  it('lists the records that refer to it, of those the person may read, and works out a number over them', async () => {
    const titles = async (session: Session, record: string) =>
      ((await inject({ method: 'GET', url: block('1.0.0', 'records', record), ...as(session) }, 200)).json().records as Array<{ values: { title: string } }>).map((r) => r.values.title).sort();
    expect(await titles(alice, trip)).toEqual(['Flight', 'Hotel']);
    // Bob reads only his own claims, on any page.
    expect(await titles(bob, trip)).toEqual(['Flight']);
    expect(await titles(bob, other)).toEqual(['Train']);
    expect((await inject({ method: 'GET', url: block('1.1.0', 'summary', trip), ...as(alice) }, 200)).json()).toMatchObject({ value: 1200 });
    expect((await inject({ method: 'GET', url: block('1.1.0', 'summary', trip), ...as(bob) }, 200)).json()).toMatchObject({ value: 900 });
  });

  it('needs the record, and a block at its path', async () => {
    expect((await inject({ method: 'GET', url: block('1.0.0', 'records'), ...as(alice) }, 422)).json()).toMatchObject({ error: 'record_required' });
    await inject({ method: 'GET', url: block('1.1.0', 'records', trip), ...as(alice) }, 404);
    await inject({ method: 'GET', url: block('9.9.9', 'records', trip), ...as(alice) }, 404);
    await inject({ method: 'GET', url: block('x', 'records', trip), ...as(alice) }, 400);
  });
});
