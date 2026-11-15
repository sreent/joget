import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteRecord,
  environmentNames,
  EXPENSE_APP,
  insertRecord,
  parseLines,
  planMigration,
  provisionEnvironment,
  selectLines,
  validateDefinition,
  writeLines,
  type StoredDefinition,
  type StoredLine,
} from '@platform/app-model';

/**
 * Lines in a real PostgreSQL: they keep their order, a write touches only what differs, they go
 * with their record, and a new rollup is worked out for the records already there. Everything
 * runs in one transaction that is rolled back, so the database is left as it was.
 */

const names = environmentNames('0193a7c4-0000-7000-8000-0000000011ae', 'sandbox');
const USER = '0193a7c4-0000-7000-8000-000000000001';
const CLAIM = '0193a7c4-0000-7000-8000-0000000000c1';
const id = (n: number) => `0193a7c4-0000-7000-8000-${String(n).padStart(12, '0')}`;

let client: pg.Client;
let definition: StoredDefinition;

function valid(input: unknown, previous?: StoredDefinition): StoredDefinition {
  const result = validateDefinition(input, previous);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

const lineEntity = () => definition.entities['expense_line']!;
async function lines(parent = CLAIM): Promise<StoredLine[]> {
  const query = selectLines(names, lineEntity(), [parent]);
  return parseLines(lineEntity(), (await client.query(query.text, query.values as unknown[])).rows).get(parent) ?? [];
}
async function write(current: StoredLine[], next: StoredLine[]) {
  for (const statement of writeLines(names, lineEntity(), CLAIM, current, next)) await client.query(statement.text, statement.values as unknown[]);
}
const line = (n: number, merchant: string, amount: number): StoredLine => ({ id: id(n), values: { date: '2026-11-02', merchant, category: 'travel', amount } });

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('Integration tests need TEST_DATABASE_URL');
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('begin');
  definition = valid(EXPENSE_APP);
  for (const statement of [...provisionEnvironment(names), ...planMigration(undefined, definition, names).statements]) await client.query(statement);
  const claim = insertRecord(names, definition.entities['expense_claim']!, { id: CLAIM, owner: USER, actor: USER, at: '2026-11-15T00:00:00.000Z', values: { title: 'Trip', status: 'draft' } });
  await client.query(claim.text, claim.values as unknown[]);
});

afterAll(async () => {
  await client?.query('rollback');
  await client?.end();
});

describe('lines in PostgreSQL', () => {
  it('keeps them in order, and changes only what differs', async () => {
    const [taxi, hotel, dinner] = [line(1, 'Taxi', 32.4), line(2, 'Hotel', 270), line(3, 'Dinner', 86)];
    await write([], [taxi, hotel]);
    expect(await lines()).toEqual([taxi, hotel]);

    const cheaper = { ...hotel, values: { ...hotel.values, amount: 240 } };
    await write([taxi, hotel], [cheaper, dinner, taxi]);
    expect(await lines()).toEqual([cheaper, dinner, taxi]);

    await write([cheaper, dinner, taxi], [dinner]);
    expect(await lines()).toEqual([dinner]);
  });

  it('works out a new rollup for the records already there', async () => {
    const next = structuredClone(definition) as any;
    next.entities.expense_claim.fields.push({ name: 'receipts', label: 'Receipts', type: 'number', rollup: { count: 'lines' } });
    const counted = valid(next, definition);
    const plan = planMigration(definition, counted, names);
    expect(plan.steps.map((s) => s.kind)).toEqual(['add_field', 'compute_field']);
    for (const statement of plan.statements) await client.query(statement);
    const column = `f_${counted.entities['expense_claim']!.fields.find((f) => f.name === 'receipts')!.id}`;
    const total = `f_${counted.entities['expense_claim']!.fields.find((f) => f.name === 'total')!.id}`;
    const { rows } = await client.query(`select "${column}"::int as receipts, "${total}" as total from "${names.schema}"."e_${counted.entities['expense_claim']!.id}"`);
    // The total was never written here, so it is still empty: rollups are worked out on writes, and when they change.
    expect(rows).toEqual([{ receipts: 1, total: null }]);
    definition = counted;
  });

  it('deletes them with their record', async () => {
    const query = deleteRecord(names, definition.entities['expense_claim']!, CLAIM);
    await client.query(query.text, query.values as unknown[]);
    expect(await lines()).toEqual([]);
  });
});
