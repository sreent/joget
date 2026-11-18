import { describe, expect, it } from 'vitest';
import { canonicalValue, compileCondition, entityFields, environmentNames, EXPENSE_APP, planMigration, SqlBuilder, validateDefinition, type StoredDefinition } from '@platform/app-model';

/** References to several records (design §6.1): many to many, as a list of IDs the platform keeps true. */

const ids = () => {
  let n = 0;
  return () => `id${String(++n).padStart(4, '0')}`;
};

function valid(input: unknown, previous?: StoredDefinition): StoredDefinition {
  const result = validateDefinition(input, previous, ids());
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.definition;
}

function issuesOf(input: unknown): string[] {
  const result = validateDefinition(input, undefined, ids());
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

/** The example with trips: a claim can be for one trip, or for several. */
function withTrips(multiple: boolean, edit: (draft: Record<string, any>) => void = () => {}): Record<string, any> {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.trip = { label: 'Trip', pluralLabel: 'Trips', titleField: 'name', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }] };
  draft.entities.expense_claim.fields.push({ name: 'trips', label: 'Trips', type: 'reference', entity: 'trip', ...(multiple ? { multiple: true } : {}) });
  edit(draft);
  return draft;
}

const T1 = '0193a7c4-0000-7000-8000-000000000001';
const T2 = '0193a7c4-0000-7000-8000-000000000002';
const names = environmentNames('0193a7c4-0000-7000-8000-0000000044af', 'sandbox');

describe('a reference to several records', () => {
  const definition = valid(withTrips(true));
  const claim = definition.entities['expense_claim']!;
  const info = entityFields(claim).get('trips')!;

  it('holds a list of IDs, each once, in the order given', () => {
    expect(info.kind).toBe('uuid[]');
    expect(canonicalValue(info, [T2, T1.toUpperCase(), T2])).toEqual({ ok: true, value: [T2, T1] });
    expect(canonicalValue(info, [])).toEqual({ ok: true, value: null });
    expect(canonicalValue(info, T1)).toMatchObject({ ok: false, issue: { code: 'invalid_type' } });
    expect(canonicalValue(info, ['nope'])).toMatchObject({ ok: false, issue: { code: 'invalid_uuid' } });
    const many = Array.from({ length: 101 }, (_, i) => `0193a7c4-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(canonicalValue(info, many)).toMatchObject({ ok: false, issue: { code: 'too_big', message: 'At most 100 records' } });
  });

  it('is tested with "in", by ID, and names no record where one record is needed', () => {
    const issues = issuesOf(
      withTrips(true, (d) => {
        d.entities.expense_claim.titleField = 'trips';
        d.rules.known_trip = { entity: 'expense_claim', assert: { in: ['Tokyo', { ref: 'record.trips' }] }, message: 'A known trip' };
        d.rules.one_trip = { entity: 'expense_claim', assert: { eq: [{ ref: 'record.trips' }, T1] }, message: 'One trip' };
      }),
    );
    expect(issues).toEqual([
      'entities.expense_claim.titleField: trips holds several records, so it can\'t name a record',
      'rules.known_trip.assert: trips holds records: look for one by its ID',
      'rules.one_trip.assert: trips holds several records: test it with "in"',
    ]);
  });

  it('finds the records whose list holds one, in SQL', () => {
    const sql = new SqlBuilder();
    const where = compileCondition({ in: [T1, { ref: 'record.trips' }] }, entityFields(claim), sql);
    expect(where).toBe(`(($1::uuid = ANY(r."f_${claim.fields.find((f) => f.name === 'trips')!.id}")) IS TRUE)`);
    expect(sql.values).toEqual([T1]);
  });

  it('is a list of IDs in the database, indexed to find the records that hold one', () => {
    const plan = planMigration(valid(withTrips(false, (d) => d.entities.expense_claim.fields.pop())), definition, names);
    const table = `"${names.schema}"."e_${claim.id}"`;
    const column = `"f_${claim.fields.find((f) => f.name === 'trips')!.id}"`;
    expect(plan.statements).toContain(`alter table ${table} add column ${column} uuid[]`);
    expect(plan.statements).toContain(`create index "e_${claim.id}_${column.slice(1, -1)}_idx" on ${table} using gin (${column})`);
  });

  it('grows from a reference to one record without losing it, and back only by deleting the lists', () => {
    const single = valid(withTrips(false));
    const many = valid(withTrips(true), single);
    const table = `"${names.schema}"."e_${single.entities['expense_claim']!.id}"`;
    const field = single.entities['expense_claim']!.fields.find((f) => f.name === 'trips')!;
    const up = planMigration(single, many, names);
    expect(up.steps).toEqual([expect.objectContaining({ kind: 'retype_field', destructive: false, description: 'Let expense_claim.trips hold several records; each record keeps the one it has' })]);
    expect(up.statements.slice(0, 4)).toEqual([
      `alter table ${table} add column "f_${field.id}_list" uuid[]`,
      `update ${table} set "f_${field.id}_list" = array["f_${field.id}"] where "f_${field.id}" is not null`,
      `alter table ${table} drop column "f_${field.id}"`,
      `alter table ${table} rename column "f_${field.id}_list" to "f_${field.id}"`,
    ]);
    const down = planMigration(many, valid(withTrips(false), many), names);
    expect(down.steps).toEqual([expect.objectContaining({ kind: 'retype_field', destructive: true })]);
    // Pointing a list at another entity empties it: its IDs name records of the old one.
    const elsewhere = valid(
      withTrips(true, (d) => {
        d.entities.place = { label: 'Place', pluralLabel: 'Places', fields: [{ name: 'name', label: 'Name', type: 'text' }] };
        d.entities.expense_claim.fields.at(-1).entity = 'place';
      }),
      many,
    );
    expect(planMigration(many, elsewhere, names).steps).toContainEqual(expect.objectContaining({ kind: 'retype_field', field: 'trips', destructive: true }));
  });
});
