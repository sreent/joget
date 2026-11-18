import {
  EXPENSE_APP,
  environmentNames,
  insertRecord,
  parseLines,
  parseRecord,
  planMigration,
  provisionEnvironment,
  recomputeRollups,
  rollupValues,
  type StoredDefinition,
  selectLines,
  selectRecords,
  validateDefinition,
  withFormulas,
  writeLines,
} from '@platform/app-model';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Formulas in a real PostgreSQL: records written before their formulas existed get them from the
 * migration's SQL, and those values are the ones the platform works out as it writes a record.
 * Everything runs in one transaction that is rolled back.
 */

const names = environmentNames('0193a7c4-0000-7000-8000-0000000044ae', 'sandbox');
const ALICE = '0193a7c4-0000-7000-8000-000000000001';
const id = (n: number) => `0193a7c4-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ref = (field: string) => ({ ref: `record.${field}` });

let client: pg.Client;
let definition: StoredDefinition;

/**
 * Claims as amounts are stored, to their field's two decimal places. Some taxes land on half a cent,
 * as 16.5 × 0.09 = 1.485, which binary numbers hold as 1.4849999…
 */
const inputs: Array<{ title: string; trip: string | null; claimed_on: string | null; left_at: string | null; amounts: number[] }> = [
  // Times near a change of clocks, and near the end of a day, as the session's time zone mustn't count.
  { title: 'Tokyo', trip: 'Summit', claimed_on: '2026-11-18', left_at: '2026-03-29T00:30:00.000Z', amounts: [38.33, 16.5, 270] },
  { title: 'Lunch', trip: null, claimed_on: '2026-02-27', left_at: '2026-11-18T23:59:59.999Z', amounts: [12.5, 0.5] },
  { title: "O'Hare", trip: 'Chicago', claimed_on: null, left_at: null, amounts: [999.99, 0.01, 600] },
];

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('Integration tests need TEST_DATABASE_URL');
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('begin');
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.expense_line.fields.push({ name: 'tax', label: 'Tax (SGD)', type: 'number', decimals: 2, formula: { mul: [ref('amount'), 0.09] } });
  draft.entities.expense_claim.fields.push(
    { name: 'with_tax', label: 'With tax (SGD)', type: 'number', decimals: 2, formula: { round: [{ mul: [ref('total'), 1.09] }, 2] } },
    { name: 'per_line', label: 'Per receipt (SGD)', type: 'number', decimals: 2, formula: { div: [ref('with_tax'), ref('receipts')] } },
    { name: 'receipts', label: 'Receipts', type: 'number', rollup: { count: 'lines' } },
    { name: 'claimed_on', label: 'Claimed on', type: 'date' },
    { name: 'pay_by', label: 'Pay by', type: 'date', formula: { add_days: [ref('claimed_on'), 30] } },
    {
      name: 'heading',
      label: 'Heading',
      type: 'text',
      formula: { concat: [ref('title'), ': ', { coalesce: [ref('trip'), 'no trip'] }, ', SGD ', ref('total'), ', ', ref('claimed_on')] },
    },
    { name: 'large', label: 'Large', type: 'boolean', formula: { if: [{ gt: [ref('total'), 1000] }, true, false] } },
    { name: 'days', label: 'Days to pay', type: 'number', formula: { days_between: [ref('claimed_on'), ref('pay_by')] } },
    { name: 'left_at', label: 'Left at', type: 'datetime' },
    { name: 'back_at', label: 'Back by', type: 'datetime', formula: { add_days: [ref('left_at'), 1.5] } },
    { name: 'left_on', label: 'Left on', type: 'date', formula: ref('left_at') },
    { name: 'waited', label: 'Days waited', type: 'number', formula: { days_between: [ref('left_at'), ref('claimed_on')] } },
    { name: 'note', label: 'Note', type: 'text', formula: { concat: ['Back by ', ref('back_at'), ', left on ', ref('left_on')] } },
  );
  const result = validateDefinition(draft);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  definition = result.definition;
  // A session in a time zone with a change of clocks: formulas must not depend on it.
  await client.query("set local time zone 'Europe/London'");
  await client.query("set local datestyle = 'SQL, DMY'");
  for (const statement of [...provisionEnvironment(names), ...planMigration(undefined, definition, names).statements]) await client.query(statement);
  // Records as they were before their formulas: nothing worked out yet.
  const claims = definition.entities['expense_claim']!;
  const lines = definition.entities['expense_line']!;
  for (const [n, input] of inputs.entries()) {
    const insert = insertRecord(names, claims, {
      id: id(n + 1),
      owner: ALICE,
      actor: ALICE,
      at: '2026-11-15T00:00:00.000Z',
      values: { title: input.title, trip: input.trip, claimed_on: input.claimed_on, left_at: input.left_at, status: 'submitted' },
    });
    await client.query(insert.text, insert.values as unknown[]);
    const next = input.amounts.map((amount, i) => ({
      id: id((n + 1) * 100 + i),
      values: { date: '2026-10-03', merchant: 'Shop', category: 'hotel', amount, receipt: null },
    }));
    for (const statement of writeLines(names, lines, id(n + 1), [], next)) await client.query(statement.text, statement.values as unknown[]);
  }
  for (const statement of recomputeRollups(definition, names)) await client.query(statement);
});

afterAll(async () => {
  await client?.query('rollback');
  await client?.end();
});

describe('formulas in PostgreSQL', () => {
  it('work out for existing records exactly what the platform works out as it writes them', async () => {
    const claims = definition.entities['expense_claim']!;
    const lineEntity = definition.entities['expense_line']!;
    const select = selectRecords({ names, entity: claims, fields: claims.fields.filter((f) => f.type !== 'lines').map((f) => f.name), grants: [true] });
    const stored = (await client.query(select.text, select.values as unknown[])).rows.map((row) => parseRecord(claims, row).record);
    const lineRows = selectLines(
      names,
      lineEntity,
      stored.map((record) => record.id),
    );
    const storedLines = parseLines(lineEntity, (await client.query(lineRows.text, lineRows.values as unknown[])).rows);
    expect(stored).toHaveLength(inputs.length);
    for (const record of stored) {
      const input = inputs[Number(record.id.slice(-1)) - 1]!;
      // As the platform writes: a line's formulas, then the rollups, then the record's formulas.
      const lines = input.amounts.map((amount) => ({
        id: null,
        values: withFormulas(lineEntity, { date: '2026-10-03', merchant: 'Shop', category: 'hotel', amount, receipt: null }, { line: true }).values,
      }));
      const rollups = rollupValues(definition, 'expense_claim', { lines }).values;
      const expected = withFormulas(claims, {
        title: input.title,
        trip: input.trip,
        claimed_on: input.claimed_on,
        left_at: input.left_at,
        status: 'submitted',
        ...rollups,
      });
      expect(expected.issues).toEqual([]);
      for (const name of ['total', 'receipts', 'with_tax', 'per_line', 'pay_by', 'heading', 'large', 'days', 'back_at', 'left_on', 'waited', 'note']) {
        expect(record.values[name], `${input.title}: ${name}`).toEqual(expected.values[name]);
      }
      const got = (storedLines.get(record.id) ?? []).map((line) => line.values['tax']);
      expect(got, `${input.title}: tax`).toEqual(lines.map((line) => line.values['tax']));
    }
  });
});
