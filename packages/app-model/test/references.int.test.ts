import {
  compileCondition,
  EXPENSE_APP,
  entityFields,
  environmentNames,
  insertRecord,
  parseRecord,
  planMigration,
  provisionEnvironment,
  SqlBuilder,
  type StoredDefinition,
  selectRecords,
  validateDefinition,
} from '@platform/app-model';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * References to several records in a real PostgreSQL: a reference to one record grows into a
 * list that holds it, and a condition finds the records whose list holds one. Everything runs in
 * one transaction that is rolled back.
 */

const names = environmentNames('0193a7c4-0000-7000-8000-0000000044b0', 'sandbox');
const ALICE = '0193a7c4-0000-7000-8000-000000000001';
const id = (n: number) => `0193a7c4-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-18T00:00:00.000Z';

let client: pg.Client;
let single: StoredDefinition;
let many: StoredDefinition;

function withTrips(multiple: boolean, previous?: StoredDefinition): StoredDefinition {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.trip = { label: 'Trip', pluralLabel: 'Trips', titleField: 'name', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }] };
  draft.entities.expense_claim.fields.push({ name: 'trips', label: 'Trips', type: 'reference', entity: 'trip', ...(multiple ? { multiple: true } : {}) });
  // A new version keeps the IDs of the one before, as the builder does.
  const result = validateDefinition(
    previous
      ? {
          ...draft,
          entities: Object.fromEntries(Object.entries(draft.entities).map(([name, entity]: [string, any]) => [name, keepIds(entity, previous.entities[name])])),
        }
      : draft,
    previous,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

function keepIds(entity: Record<string, any>, before: StoredDefinition['entities'][string] | undefined): Record<string, any> {
  if (!before) return entity;
  return {
    ...entity,
    id: before.id,
    fields: entity.fields.map((field: Record<string, unknown>) => ({ ...field, id: before.fields.find((f) => f.name === field['name'])?.id })),
  };
}

async function claims(definition: StoredDefinition): Promise<Map<string, unknown>> {
  const entity = definition.entities['expense_claim']!;
  const select = selectRecords({ names, entity, fields: ['title', 'trips'], grants: [true] });
  const rows = (await client.query(select.text, select.values as unknown[])).rows;
  return new Map(rows.map((row) => parseRecord(entity, row).record).map((record) => [record.values['title'] as string, record.values['trips'] ?? null]));
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('Integration tests need TEST_DATABASE_URL');
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('begin');
  single = withTrips(false);
  for (const statement of [...provisionEnvironment(names), ...planMigration(undefined, single, names).statements]) await client.query(statement);
  const trip = single.entities['trip']!;
  const claim = single.entities['expense_claim']!;
  for (const [n, name] of ['Tokyo', 'Penang'].entries()) {
    const insert = insertRecord(names, trip, { id: id(n + 1), owner: ALICE, actor: ALICE, at: AT, values: { name } });
    await client.query(insert.text, insert.values as unknown[]);
  }
  for (const [n, [title, trips]] of (
    [
      ['Hotel', id(1)],
      ['Flight', id(2)],
      ['Lunch', null],
    ] as const
  ).entries()) {
    const insert = insertRecord(names, claim, { id: id(n + 11), owner: ALICE, actor: ALICE, at: AT, values: { title, trips, status: 'submitted' } });
    await client.query(insert.text, insert.values as unknown[]);
  }
  many = withTrips(true, single);
});

afterAll(async () => {
  await client?.query('rollback');
  await client?.end();
});

describe('references to several records in PostgreSQL', () => {
  it('grow from a reference to one record, each record keeping the one it had', async () => {
    expect(await claims(single)).toEqual(
      new Map([
        ['Hotel', id(1)],
        ['Flight', id(2)],
        ['Lunch', null],
      ]),
    );
    const plan = planMigration(single, many, names);
    expect(plan.steps.map((step) => step.destructive)).toEqual([false]);
    for (const statement of plan.statements) await client.query(statement);
    expect(await claims(many)).toEqual(
      new Map([
        ['Hotel', [id(1)]],
        ['Flight', [id(2)]],
        ['Lunch', null],
      ]),
    );
  });

  it('find the records whose list holds one', async () => {
    const claim = many.entities['expense_claim']!;
    const trips = claim.fields.find((f) => f.name === 'trips')!;
    await client.query(`update "${names.schema}"."e_${claim.id}" set "f_${trips.id}" = $1::uuid[] where id = $2`, [[id(2), id(1)], id(12)]);
    const sql = new SqlBuilder();
    const where = compileCondition({ in: [id(1), { ref: 'record.trips' }] }, entityFields(claim), sql);
    const rows = (await client.query(`select id from "${names.schema}"."e_${claim.id}" r where ${where} order by id`, [...sql.values])).rows;
    expect(rows.map((row) => row.id)).toEqual([id(11), id(12)]);
  });
});
