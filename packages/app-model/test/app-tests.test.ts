import { EXPENSE_APP, type StoredDefinition, testMismatches, validateDefinition, withGivenIds } from '@platform/app-model';
import { describe, expect, it } from 'vitest';

/** The app's tests (design §6.7): records first, an action someone in a role runs, and what must come of it. */

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

const receipt = { date: '2026-11-02', merchant: 'Comfort', category: 'travel', amount: 25 };

function withTests(tests: Record<string, unknown>): Record<string, any> {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.tests = tests;
  return draft;
}

const SUBMITS = {
  label: 'A requester submits a claim',
  when: { action: 'submit_claim', as: 'requester', values: { title: 'Taxi', lines: [receipt] } },
  then: { outcome: 'saved', values: { status: 'submitted', total: 25 } },
};
const OWN = {
  label: 'Nobody approves their own claim',
  given: { mine: { entity: 'expense_claim', values: { title: 'Taxi', lines: [receipt], status: 'submitted' } } },
  when: { action: 'approve_claim', as: 'approver', record: 'mine' },
  then: { outcome: 'refused', message: "can't approve your own claim" },
};

describe("an app's tests", () => {
  it('pass the checks when they name what the app has', () => {
    const definition = valid(withTests({ submits: SUBMITS, own: OWN }));
    expect(definition.tests?.['own']).toMatchObject({ given: { mine: { entity: 'expense_claim' } }, when: { record: 'mine', values: {} } });
  });

  it('say what they name that the app has not', () => {
    expect(
      issuesOf(
        withTests({
          a: { ...SUBMITS, when: { ...SUBMITS.when, action: 'pay_claim' } },
          b: { ...SUBMITS, when: { ...SUBMITS.when, as: 'auditor', values: { title: 'Taxi', colour: 'red', status: 'approved' } } },
          c: { ...OWN, when: { action: 'approve_claim', as: 'approver' } },
          d: { ...SUBMITS, when: { ...SUBMITS.when, record: 'mine' } },
          e: { ...OWN, given: { line: { entity: 'expense_line', values: receipt } }, when: { ...OWN.when, record: 'line' } },
          f: { ...SUBMITS, when: { ...SUBMITS.when, values: { title: 'Taxi', trip: { given: 'nowhere' } } } },
        }),
      ),
    ).toEqual([
      'tests.a.when.action: No action named pay_claim',
      'tests.b.when.as: No role named auditor',
      'tests.b.when.values.colour: Expense claim has no field colour',
      "tests.b.when.values.status: status isn't one of the action's inputs",
      'tests.c.when.record: Approve an expense claim changes a record: name one that the test makes',
      'tests.d.when.record: Submit an expense claim makes its own record: it changes none',
      'tests.e.given.line.entity: expense_line is the lines of another entity: make that record, with its lines',
      'tests.e.when.record: line is a record of expense_line, and Approve an expense claim changes one of expense_claim',
      'tests.f.when.values.trip: The test makes no record named nowhere',
    ]);
  });

  it('follow the renames of the fields they name', () => {
    const first = valid(withTests({ submits: SUBMITS }));
    const next = structuredClone(first) as any;
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'total').name = 'sum';
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'title').name = 'heading';
    next.actions.submit_claim.input = next.actions.submit_claim.input.map((name: string) => (name === 'title' ? 'heading' : name));
    const renamed = valid(next, first);
    expect(renamed.tests?.['submits']).toMatchObject({ when: { values: { heading: 'Taxi' } }, then: { values: { status: 'submitted', sum: 25 } } });
  });

  it('name the records they make first by their IDs as they run, and say where a record differs', () => {
    const made = new Map([
      ['tokyo', 'id-1'],
      ['penang', 'id-2'],
    ]);
    expect(withGivenIds({ trip: { given: 'tokyo' }, trips: [{ given: 'penang' }, { given: 'tokyo' }], title: 'Taxi' }, made)).toEqual({
      trip: 'id-1',
      trips: ['id-2', 'id-1'],
      title: 'Taxi',
    });
    expect(testMismatches({ status: 'submitted', total: 25, trip: null }, { status: 'draft', total: 25 })).toEqual([
      { field: 'status', expected: 'submitted', actual: 'draft' },
    ]);
  });
});
