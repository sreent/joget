import { evaluateCondition, type Condition, type Operand } from '@platform/authz';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { afterCursor, compileCondition, orderBy, SqlBuilder, type FieldInfo, type SortKey } from '@platform/app-model';
import { conditionRecord, type FieldValue } from '../src/values.js';

/**
 * The SQL compiler must agree with the policy engine. For thousands of random conditions over
 * random records, the rows PostgreSQL selects must be exactly the rows evaluateCondition accepts.
 */

const U1 = '0193a7c4-0000-7000-8000-000000000001';
const U2 = '0193a7c4-0000-7000-8000-000000000002';

const FIELDS: FieldInfo[] = [
  { name: 't1', kind: 'text', column: 't1', system: false },
  { name: 't2', kind: 'text', column: 't2', system: false },
  { name: 'u1', kind: 'uuid', column: 'u1', system: false },
  { name: 'n1', kind: 'number', column: 'n1', system: false },
  { name: 'n2', kind: 'number', column: 'n2', system: false },
  { name: 'b1', kind: 'boolean', column: 'b1', system: false },
  { name: 'm1', kind: 'text[]', column: 'm1', system: false },
  { name: 'r1', kind: 'uuid[]', column: 'r1', system: false },
];
const fieldMap = new Map(FIELDS.map((field) => [field.name, field]));

const VALUES: Record<string, FieldValue[]> = {
  t1: ['a', 'b', 'A', U1, null],
  t2: ['a', 'b', null],
  u1: [U1, U2, null],
  n1: [0, 1, 2.5, -1, null],
  n2: [0, 1, null],
  b1: [true, false, null],
  m1: [['a'], ['a', 'b'], ['b'], null],
  r1: [[U1], [U1, U2], [U2], null],
};
const LITERALS: Operand[] = ['a', 'b', 'A', U1, U1.toUpperCase(), 'not-a-uuid', 'a\u0000', 0, 1, 2.5, -1, true, false, null];

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]! };
}

function generateCondition(seed: number): Condition {
  const { next, pick } = random(seed);
  const operand = (): Operand => (next() < 0.55 ? { ref: `record.${pick(FIELDS).name}` } : pick(LITERALS));
  const condition = (depth: number): Condition => {
    const roll = next();
    if (depth > 0 && roll < 0.25) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 3) }, () => condition(depth - 1));
      return next() < 0.5 ? { all: parts } : { any: parts };
    }
    if (depth > 0 && roll < 0.35) return { not: condition(depth - 1) };
    const leaf = pick(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in-list', 'in-ref', 'exists'] as const);
    if (leaf === 'exists') return { exists: `record.${pick(FIELDS).name}` };
    if (leaf === 'in-list') return { in: [operand(), Array.from({ length: Math.floor(next() * 4) }, operand)] };
    if (leaf === 'in-ref') return { in: [operand(), { ref: `record.${pick(FIELDS).name}` }] };
    return { [leaf]: [operand(), operand()] } as unknown as Condition;
  };
  return condition(3);
}

let client: pg.Client;
const records: Array<{ id: number; values: Record<string, FieldValue> }> = [];

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('Integration tests need TEST_DATABASE_URL');
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    'create temp table r (id int primary key, t1 text, t2 text, u1 uuid, n1 numeric, n2 numeric, b1 boolean, m1 text[], r1 uuid[])',
  );
  // Every combination would be too many: take a deterministic sample with every value of every field.
  const { pick } = random(42);
  for (let id = 1; id <= 160; id++) {
    const values: Record<string, FieldValue> = {};
    for (const field of FIELDS) values[field.name] = pick(VALUES[field.name]!);
    records.push({ id, values });
    await client.query('insert into r values ($1, $2, $3, $4::uuid, $5::numeric, $6::numeric, $7, $8::text[], $9::uuid[])', [
      id,
      values['t1'],
      values['t2'],
      values['u1'],
      values['n1'],
      values['n2'],
      values['b1'],
      values['m1'],
      values['r1'],
    ]);
  }
});

afterAll(async () => {
  await client?.end();
});

describe('compileCondition agrees with evaluateCondition', () => {
  it('on random conditions over every kind of value, NULLs included', async () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const condition = generateCondition(seed);
      const sql = new SqlBuilder();
      const where = compileCondition(condition, fieldMap, sql);
      const result = await client.query<{ id: number }>(`select id from r where ${where} order by id`, [...sql.values]);
      const selected = result.rows.map((row) => row.id);
      const expected = records.filter((r) => evaluateCondition(condition, { record: conditionRecord(r.values) })).map((r) => r.id);
      expect(selected, `seed ${seed}: ${JSON.stringify(condition)}\n${where}`).toEqual(expected);
    }
  });
});

describe('afterCursor pages through every row exactly once', () => {
  it('for mixed directions with empty values', async () => {
    const keys: SortKey[] = [
      { info: fieldMap.get('t2')!, direction: 'asc' },
      { info: fieldMap.get('n1')!, direction: 'desc' },
      { info: { name: 'id', kind: 'number', column: 'id', system: true }, direction: 'asc' },
    ];
    const seen: number[] = [];
    let after: FieldValue[] | null = null;
    for (let page = 0; page < 100; page++) {
      const sql = new SqlBuilder();
      const where: string = after ? `where ${afterCursor(keys, after, sql)}` : '';
      const result: pg.QueryResult<{ id: number; t2: string | null; n1: string | null }> = await client.query(
        `select id, t2, n1::text as n1 from r ${where} order by ${orderBy(keys)} limit 7`,
        [...sql.values],
      );
      if (result.rows.length === 0) break;
      seen.push(...result.rows.map((row) => row.id));
      const last = result.rows.at(-1)!;
      after = [last.t2, last.n1 === null ? null : Number(last.n1), last.id];
    }
    const all = await client.query<{ id: number }>(`select id from r order by ${orderBy(keys)}`);
    expect(seen).toEqual(all.rows.map((row) => row.id));
  });
});
