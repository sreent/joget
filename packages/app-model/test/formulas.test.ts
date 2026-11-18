import { describe, expect, it } from 'vitest';
import { environmentNames, EXPENSE_APP, formulaFields, planMigration, validateDefinition, withFormulas, type StoredDefinition } from '@platform/app-model';

/** Formulas (design §6.1): fields the platform works out from a record's own fields, and stores. */

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

function edited(edit: (draft: Record<string, any>) => void): Record<string, any> {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  edit(draft);
  return draft;
}

const ref = (field: string) => ({ ref: `record.${field}` });

/** The example with formulas: a line's tax, the claim's total with tax, a due date, and a heading. */
export const withFormulasApp = () =>
  edited((d) => {
    d.entities.expense_line.fields.push({ name: 'tax', label: 'Tax (SGD)', type: 'number', decimals: 2, formula: { mul: [ref('amount'), 0.09] } });
    d.entities.expense_claim.fields.push(
      { name: 'with_tax', label: 'With tax (SGD)', type: 'number', decimals: 2, formula: { round: [{ mul: [ref('total'), 1.09] }, 2] } },
      { name: 'per_line', label: 'Per receipt (SGD)', type: 'number', decimals: 2, formula: { div: [ref('with_tax'), ref('receipts')] } },
      { name: 'receipts', label: 'Receipts', type: 'number', rollup: { count: 'lines' } },
      { name: 'claimed_on', label: 'Claimed on', type: 'date' },
      { name: 'pay_by', label: 'Pay by', type: 'date', formula: { add_days: [ref('claimed_on'), 30] } },
      { name: 'heading', label: 'Heading', type: 'text', formula: { concat: [ref('title'), ': ', { coalesce: [ref('trip'), 'no trip'] }, ', SGD ', ref('total')] } },
      { name: 'large', label: 'Large', type: 'boolean', formula: { if: [{ gt: [ref('total'), 1000] }, true, false] } },
    );
  });

describe('formulas', () => {
  const definition = valid(withFormulasApp());
  const claim = definition.entities['expense_claim']!;

  it('are worked out each after the formulas it reads', () => {
    expect(formulaFields(claim).map((field) => field.name)).toEqual(['with_tax', 'per_line', 'pay_by', 'heading', 'large']);
    const worked = withFormulas(claim, { title: 'Tokyo', trip: null, total: 302.4, receipts: 2, claimed_on: '2026-11-18' });
    expect(worked.issues).toEqual([]);
    expect(worked.values).toMatchObject({ with_tax: 329.62, per_line: 164.81, pay_by: '2026-12-18', heading: 'Tokyo: no trip, SGD 302.4', large: false });
  });

  it('give nothing where a value is missing or a division has nothing to divide by', () => {
    expect(withFormulas(claim, { title: 'Empty', total: 0, receipts: 0, claimed_on: null }).values).toMatchObject({ with_tax: 0, per_line: null, pay_by: null });
  });

  it("work out a line's values, without the noise of binary numbers", () => {
    const line = definition.entities['expense_line']!;
    // 1.15 × 3 is 3.4499999999999997 in binary; worked out as people expect, it is 3.45.
    expect(withFormulas(line, { amount: 38.333333 }, { line: true }).values['tax']).toBe(3.45);
    expect(withFormulas(line, { amount: 1.15 * 3 }, { line: true }).values['tax']).toBe(0.31);
  });

  it('say what is wrong with a formula', () => {
    const issues = issuesOf(
      edited((d) => {
        d.entities.expense_claim.fields.push(
          { name: 'a', label: 'A', type: 'text', formula: { upper: [ref('title')] } },
          { name: 'b', label: 'B', type: 'text', formula: { concat: [{ ref: 'principal.id' }, '!'] } },
          { name: 'c', label: 'C', type: 'date', formula: { today: true } },
          { name: 'd', label: 'D', type: 'number', formula: ref('lines') },
          { name: 'e', label: 'E', type: 'number', formula: ref('title') },
          { name: 'f', label: 'F', type: 'number', formula: ref('g') },
          { name: 'g', label: 'G', type: 'number', formula: ref('f') },
          { name: 'h', label: 'H', type: 'number', required: true, formula: 1 },
          { name: 'i', label: 'I', type: 'text', formula: { concat: [ref('owner'), '!'] } },
          { name: 'j', label: 'J', type: 'boolean', formula: { if: [{ lt: [ref('total'), 0] }, { if: [{ gt: [ref('updated_at'), { now: -1 }] }, true, false] }, false] } },
        );
      }),
    );
    expect(issues).toEqual([
      'entities.expense_claim.fields[7].formula: A formula can\'t use upper yet',
      "entities.expense_claim.fields[8].formula: principal.id: a formula reads the record's own fields, not the person who writes it",
      "entities.expense_claim.fields[9].formula: A formula can't read today or now: once stored, its value would go stale",
      "entities.expense_claim.fields[10].formula: record.lines: a formula can't read lines one by one. Add a rollup, such as a total, and read that",
      'entities.expense_claim.fields[11].formula: E holds a number, and this formula gives text',
      'entities.expense_claim.fields[14].required: The platform works this field out, so nobody can be asked to fill it in',
      'entities.expense_claim.fields[15].formula: record.owner: a formula reads the fields of the app, not those the platform keeps, such as the owner or when the record was made',
      "entities.expense_claim.fields[16].formula: A formula's choice reads the fields of the app, not those the platform keeps",
      "entities.expense_claim.fields[16].formula: A formula's choice can't compare with today or now: once stored, its value would go stale",
      "entities.expense_claim.fields[12].formula: F's formula reads itself, through other formulas: break the loop",
      "entities.expense_claim.fields[13].formula: G's formula reads itself, through other formulas: break the loop",
    ]);
  });

  it('follow renames of the fields they read', () => {
    const first = valid(withFormulasApp());
    const next = structuredClone(first) as any;
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'total').name = 'sum';
    const renamed = valid(next, first);
    expect(renamed.entities['expense_claim']!.fields.find((f) => f.name === 'with_tax')).toMatchObject({ formula: { round: [{ mul: [{ ref: 'record.sum' }, 1.09] }, 2] } });
  });

  it("are worked out for existing records once they're new or change: lines first, then rollups, then records", () => {
    const names = environmentNames('0193a7c4-0000-7000-8000-0000000033ae', 'sandbox');
    const base = valid(EXPENSE_APP);
    const next = valid(withFormulasApp(), base);
    const plan = planMigration(base, next, names);
    // A line's new formula means its record's rollups are worked out again too.
    expect(plan.steps.filter((step) => step.kind === 'compute_field').map((step) => step.description)).toEqual([
      'Work out expense_claim.total for existing records',
      'Work out expense_claim.receipts for existing records',
      'Work out expense_claim.with_tax for existing records',
      'Work out expense_claim.per_line for existing records',
      'Work out expense_claim.pay_by for existing records',
      'Work out expense_claim.heading for existing records',
      'Work out expense_claim.large for existing records',
      'Work out expense_line.tax for existing lines',
    ]);
    const updates = plan.statements.filter((statement) => statement.startsWith('update'));
    expect(updates).toHaveLength(8);
    const tax = updates.findIndex((statement) => statement.includes('0.09'));
    const rollups = updates.findIndex((statement) => statement.includes('l.parent_id = r.id'));
    const withTax = updates.findIndex((statement) => statement.includes('1.09'));
    expect(tax).toBe(0);
    expect(rollups).toBeGreaterThan(tax);
    expect(withTax).toBeGreaterThan(rollups);
    // Nothing changed, nothing to work out.
    expect(planMigration(next, next, names).statements.filter((statement) => statement.startsWith('update'))).toEqual([]);
  });
});
