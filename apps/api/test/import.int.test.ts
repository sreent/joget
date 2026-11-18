import { EXPENSE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Data from other systems, end to end (design §6.1): records come in from CSV, each line a create
 * with its checks, rules and permissions, all of them or none; and go out as CSV to whoever's role
 * may export them, on the audit log.
 */

let t: TestApp;
let alice: Session; // builds the app
let bob: Session; // requester: reads trips, and may not bring them in or take them out
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
const trips = () => `/v1/apps/${appId}/entities/trip/records`;
const importUrl = () => `/v1/apps/${appId}/entities/trip/import`;

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

function withTrips() {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.trip = {
    label: 'Trip',
    pluralLabel: 'Trips',
    titleField: 'name',
    history: true,
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'budget', label: 'Budget', type: 'number', decimals: 2, min: 0 },
      { name: 'starts', label: 'Starts', type: 'date' },
      {
        name: 'kind',
        label: 'Kind',
        type: 'choice',
        options: [
          { value: 'client', label: 'Client visit' },
          { value: 'team', label: 'Team offsite' },
        ],
      },
      { name: 'lead', label: 'Lead', type: 'user' },
      { name: 'with_tax', label: 'With tax', type: 'number', decimals: 2, formula: { mul: [{ ref: 'record.budget' }, 1.09] } },
      { name: 'related', label: 'Related trips', type: 'reference', entity: 'trip', multiple: true },
    ],
  };
  draft.roles.requester.entities.trip = { read: true };
  return draft;
}

const csv = (...lines: string[]) => lines.join('\n');
async function names(): Promise<string[]> {
  return ((await inject({ method: 'GET', url: trips(), ...as(alice) }, 200)).json().records as Array<{ values: { name: string } }>)
    .map((r) => r.values.name)
    .sort();
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob] = [await t.login('alice'), await t.login('bob')];
  appId = (
    await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Trips', definition: withTrips() } }, 201)
  ).json().app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
});

afterAll(async () => {
  await t?.close();
});

describe('bringing records in from CSV', () => {
  const first = csv(
    'Name,Budget,Starts,Kind,Lead,With tax,Colour',
    'Tokyo summit,"1,200.00",2026-12-01,Client visit,BOB@example.com,999,red',
    'Penang retreat,800,2027-01-15,team,,,',
  );

  it('checks a file first: which field each column fills, and nothing written', async () => {
    const dry = (await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: first, name: 'trips.csv', dryRun: true } }, 200)).json();
    expect(dry).toEqual({
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Budget', field: 'budget' },
        { header: 'Starts', field: 'starts' },
        { header: 'Kind', field: 'kind' },
        { header: 'Lead', field: 'lead' },
        { header: 'With tax', field: null, note: 'The platform works this field out' },
        { header: 'Colour', field: null, note: 'No field has this name' },
      ],
      rows: 2,
      issues: [],
      created: 0,
    });
    expect(await names()).toEqual([]);
  });

  it('writes every line as a create: values as people write them, people by email, formulas worked out, history naming the file', async () => {
    expect((await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: first, name: 'trips.csv' } }, 201)).json()).toMatchObject({
      rows: 2,
      issues: [],
      created: 2,
    });
    const records = (await inject({ method: 'GET', url: trips(), ...as(alice) }, 200)).json().records as Array<{ id: string; values: Record<string, unknown> }>;
    const tokyo = records.find((r) => r.values['name'] === 'Tokyo summit')!;
    expect(tokyo.values).toMatchObject({ budget: 1200, starts: '2026-12-01', kind: 'client', lead: bob.userId, with_tax: 1308 });
    const history = (await inject({ method: 'GET', url: `${trips()}/${tokyo.id}/history`, ...as(alice) }, 200)).json().history;
    expect(JSON.stringify(history)).toContain('"location":"line 2"');
    expect(JSON.stringify(history)).toContain('"document":"trips.csv"');
  });

  it('refuses the whole file when a line has a problem, and says which line and field', async () => {
    const bad = csv('Name,Budget,Kind,Lead', 'Kyoto,10,team,', 'Osaka,-5,team,', 'Nara,10,Holiday,', 'Kobe,10,team,nobody@example.com');
    const dry = (await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: bad, dryRun: true } }, 200)).json();
    expect(dry.issues).toEqual([
      { row: 3, field: 'budget', message: expect.stringContaining('At least 0') },
      { row: 4, field: 'kind', message: 'Expected one of: Client visit, Team offsite' },
      { row: 5, field: 'lead', message: 'Nobody here has the email address nobody@example.com' },
    ]);
    const refused = (await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: bad } }, 422)).json();
    expect(refused).toMatchObject({ error: 'invalid_import', message: expect.stringMatching(/^Line 3: /) });
    expect(await names()).toEqual(['Penang retreat', 'Tokyo summit']);
  });

  it('finds, even in a dry run, what only writing finds, such as a value another record holds in a unique field', async () => {
    const twice = csv('Name', 'Kyoto', 'Tokyo summit');
    const dry = (await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: twice, dryRun: true } }, 200)).json();
    expect(dry.issues).toEqual([{ row: 3, message: 'Another record already has that value in a unique field' }]);
    expect(await names()).toEqual(['Penang retreat', 'Tokyo summit']);
  });

  it('finds records by their title, among those the person may read', async () => {
    const linked = csv('Name,Related trips', 'Kyoto,Tokyo summit; Penang retreat', 'Hakone,Atlantis');
    expect((await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: linked, dryRun: true } }, 200)).json().issues).toEqual([
      { row: 3, field: 'related', message: 'No trip you can see is titled Atlantis' },
    ]);
    await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: csv('Name,Related trips', 'Kyoto,Tokyo summit; Penang retreat') } }, 201);
    const records = (await inject({ method: 'GET', url: trips(), ...as(alice) }, 200)).json().records as Array<{
      id: string;
      values: Record<string, unknown>;
      titles?: Record<string, string>;
    }>;
    const kyoto = records.find((r) => r.values['name'] === 'Kyoto')!;
    expect(Object.values(kyoto.titles ?? {}).sort()).toEqual(['Penang retreat', 'Tokyo summit']);
  });

  it('needs the role to create the records, and refuses a file it can not read', async () => {
    await inject({ method: 'POST', url: importUrl(), ...as(bob), payload: { csv: csv('Name', 'Bali') } }, 403);
    expect((await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: 'Name\n"Bali' } }, 422)).json()).toMatchObject({
      error: 'invalid_csv',
    });
    expect((await inject({ method: 'POST', url: importUrl(), ...as(alice), payload: { csv: 'Colour\nred' } }, 422)).json()).toMatchObject({
      error: 'no_columns',
    });
  });
});

describe('taking records out as CSV', () => {
  it('gives the records as people read them, safe to open in a spreadsheet, on the audit log', async () => {
    await inject({ method: 'POST', url: trips(), ...as(alice), payload: { values: { name: '=HYPERLINK("http://example.com")' } } }, 201);
    const response = await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/trip/export`, ...as(alice) }, 200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="Trips.csv"');
    const lines = response.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('ID,Name,Budget,Starts,Kind,Lead,With tax,Related trips,Owner,Created,Last changed');
    const tokyo = lines.find((line) => line.includes(',Tokyo summit,'))!;
    expect(tokyo).toContain(',Tokyo summit,1200,2026-12-01,Client visit,bob@example.com,1308,,alice@example.com,');
    expect(lines.find((line) => line.includes('Kyoto'))).toContain(',"Tokyo summit; Penang retreat",');
    expect(lines.some((line) => line.includes(`,"'=HYPERLINK(""http://example.com"")",`))).toBe(true);
    const events = await t.ctx.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'record.export'), eq(auditEvents.appId, appId)));
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toMatchObject({ records: 4 });
  });

  it("needs a role that may export: reading isn't enough", async () => {
    await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/trip/export`, ...as(bob) }, 403);
  });
});
