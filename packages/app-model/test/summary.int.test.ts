import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  entityFields,
  environmentNames,
  EXPENSE_APP,
  insertRecord,
  planMigration,
  provisionEnvironment,
  summarize,
  validateDefinition,
  writeLines,
  type StoredDefinition,
  type Summarize,
} from '@platform/app-model';

/**
 * Numbers and charts in a real PostgreSQL: counts and totals over records and over their lines,
 * groups by a field and by month, the largest groups first, and only the records the grants let
 * through. Everything runs in one transaction that is rolled back.
 */

const names = environmentNames('0193a7c4-0000-7000-8000-0000000022ae', 'sandbox');
const ALICE = '0193a7c4-0000-7000-8000-000000000001';
const BOB = '0193a7c4-0000-7000-8000-000000000002';
const id = (n: number) => `0193a7c4-0000-7000-8000-${String(n).padStart(12, '0')}`;

let client: pg.Client;
let definition: StoredDefinition;
const claims = () => definition.entities['expense_claim']!;
const lineEntity = () => definition.entities['expense_line']!;
const claimField = (name: string) => entityFields(claims()).get(name)!;
const lineField = (name: string) => entityFields(lineEntity(), { line: true }).get(name)!;

async function run(query: Omit<Summarize, 'names' | 'entity'>) {
  const statement = summarize({ names, entity: claims(), ...query });
  return (await client.query(statement.text, statement.values as unknown[])).rows;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('Integration tests need TEST_DATABASE_URL');
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('begin');
  const result = validateDefinition(EXPENSE_APP);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  definition = result.definition;
  for (const statement of [...provisionEnvironment(names), ...planMigration(undefined, definition, names).statements]) await client.query(statement);
  const claim = async (n: number, owner: string, status: string, total: number, lines: Array<[string, string, number]>) => {
    const insert = insertRecord(names, claims(), { id: id(n), owner, actor: owner, at: '2026-11-15T00:00:00.000Z', values: { title: `Claim ${n}`, status, total } });
    await client.query(insert.text, insert.values as unknown[]);
    const next = lines.map(([date, category, amount], i) => ({ id: id(n * 100 + i), values: { date, merchant: 'Shop', category, amount, receipt: null } }));
    for (const statement of writeLines(names, lineEntity(), id(n), [], next)) await client.query(statement.text, statement.values as unknown[]);
  };
  await claim(1, ALICE, 'submitted', 300, [['2026-10-03', 'hotel', 250], ['2026-10-04', 'meals', 50]]);
  await claim(2, ALICE, 'approved', 40, [['2026-11-01', 'travel', 40]]);
  await claim(3, BOB, 'submitted', 120, [['2026-11-02', 'hotel', 100], ['2026-11-02', 'meals', 20]]);
});

afterAll(async () => {
  await client?.query('rollback');
  await client?.end();
});

describe('summaries in PostgreSQL', () => {
  it('counts and totals records, and only those the grants let through', async () => {
    expect(await run({ grants: [true], measure: { op: 'count', onLines: false } })).toEqual([{ value: '3' }]);
    expect(await run({ grants: [true], measure: { op: 'sum', info: claimField('total'), onLines: false } })).toEqual([{ value: '460' }]);
    const alicesOnly = { eq: [{ ref: 'record.owner' }, ALICE] } as const;
    expect(await run({ grants: [alicesOnly], measure: { op: 'sum', info: claimField('total'), onLines: false } })).toEqual([{ value: '340' }]);
    expect(await run({ grants: [], measure: { op: 'count', onLines: false } })).toEqual([{ value: '0' }]);
  });

  it('works over lines: counts them, totals their amounts, and counts each record once', async () => {
    const over = { lineEntity: lineEntity(), grants: [true] as const };
    expect(await run({ ...over, measure: { op: 'count', onLines: true } })).toEqual([{ value: '5' }]);
    expect(await run({ ...over, measure: { op: 'sum', info: lineField('amount'), onLines: true } })).toEqual([{ value: '460' }]);
    expect(await run({ ...over, measure: { op: 'count', onLines: false } })).toEqual([{ value: '3' }]);
  });

  it('groups by a field of the lines, largest first, with the total of every group', async () => {
    const rows = await run({
      lineEntity: lineEntity(),
      grants: [true],
      measure: { op: 'sum', info: lineField('amount'), onLines: true },
      group: { info: lineField('category'), onLines: true, limit: 2 },
    });
    expect(rows.map(({ key, value, total, groups }) => ({ key, value, total, groups: Number(groups) }))).toEqual([
      { key: 'hotel', value: '350', total: '460', groups: 3 },
      { key: 'meals', value: '70', total: '460', groups: 3 },
    ]);
  });

  it('groups dates by month, latest first, and keeps to a time range', async () => {
    const byMonth = await run({
      lineEntity: lineEntity(),
      grants: [true],
      measure: { op: 'sum', info: lineField('amount'), onLines: true },
      group: { info: lineField('date'), onLines: true, period: 'month', limit: 12 },
    });
    expect(byMonth.map(({ key, value }) => [key, value])).toEqual([
      ['2026-11-01', '160'],
      ['2026-10-01', '300'],
    ]);
    const since = await run({
      lineEntity: lineEntity(),
      grants: [true],
      measure: { op: 'sum', info: lineField('amount'), onLines: true },
      since: { info: lineField('date'), onLines: true, from: '2026-11-01' },
    });
    expect(since).toEqual([{ value: '160' }]);
  });

  it('groups by status and by owner, the people as their IDs', async () => {
    const byStatus = await run({ grants: [true], measure: { op: 'count', onLines: false }, group: { info: claimField('status'), onLines: false, limit: 8 } });
    expect(byStatus.map(({ key, value }) => [key, value])).toEqual([
      ['submitted', '2'],
      ['approved', '1'],
    ]);
    const byOwner = await run({ grants: [true], measure: { op: 'sum', info: claimField('total'), onLines: false }, group: { info: claimField('owner'), onLines: false, limit: 8 } });
    expect(byOwner.map(({ key, value }) => [key, value])).toEqual([
      [ALICE, '340'],
      [BOB, '120'],
    ]);
  });
});
