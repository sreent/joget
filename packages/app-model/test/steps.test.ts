import { describe, expect, it } from 'vitest';
import {
  buildCard,
  capabilityChanges,
  evaluateExpression,
  EXPENSE_APP,
  isExpression,
  runSteps,
  stepName,
  validateDefinition,
  type Expression,
  type StoredDefinition,
} from '@platform/app-model';

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

/** The example app, changed by `edit`. */
function edited(edit: (draft: Record<string, any>) => void): Record<string, any> {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  edit(draft);
  return draft;
}

const ALICE = '0193a7c4-0000-7000-8000-000000000001';
const BOB = '0193a7c4-0000-7000-8000-000000000002';
const CLAIM = '0193a7c4-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-11-17T08:30:00.000Z');
const scope = { record: { total: 302.4, title: 'Singapore trip', owner: BOB, iban: null }, principal: { id: ALICE }, now: NOW };
const evaluate = (expression: Expression) => evaluateExpression(expression, scope);

describe('expressions', () => {
  it('work out constants, references, today, now and small sums', () => {
    expect(evaluate('approved')).toEqual({ ok: true, value: 'approved' });
    expect(evaluate({ ref: 'record.total' })).toEqual({ ok: true, value: 302.4 });
    expect(evaluate({ ref: 'principal.id' })).toEqual({ ok: true, value: ALICE });
    expect(evaluate({ ref: 'record.trip' })).toEqual({ ok: true, value: null });
    expect(evaluate({ today: true })).toEqual({ ok: true, value: '2026-11-17' });
    expect(evaluate({ now: true })).toEqual({ ok: true, value: '2026-11-17T08:30:00.000Z' });
    expect(evaluate({ mul: [{ ref: 'record.total' }, 0.09] })).toMatchObject({ ok: true });
    expect(evaluate({ round: [{ mul: [{ ref: 'record.total' }, 0.09] }, 2] })).toEqual({ ok: true, value: 27.22 });
    expect(evaluate({ round: [1.005, 2] })).toEqual({ ok: true, value: 1.01 });
    expect(evaluate({ sub: [{ ref: 'record.total' }, 2.4] })).toEqual({ ok: true, value: 300 });
    expect(evaluate({ concat: ['Claim: ', { ref: 'record.title' }, ' (', { ref: 'record.trip' }, ')'] })).toEqual({ ok: true, value: 'Claim: Singapore trip ()' });
  });

  it('leave a calculation empty when a value is empty, and refuse to divide by zero', () => {
    expect(evaluate({ add: [{ ref: 'record.iban' }, 1] })).toEqual({ ok: true, value: null });
    expect(evaluate({ div: [{ ref: 'record.total' }, 0] })).toEqual({ ok: false, message: 'It divides by zero' });
    expect(evaluate({ add: [{ ref: 'record.title' }, 1] })).toEqual({ ok: false, message: 'add works on numbers' });
  });

  it('accept only the shapes they know', () => {
    expect(isExpression({ ref: 'record.total' })).toBe(true);
    expect(isExpression({ ref: 'record.total', add: [1, 2] })).toBe(false);
    expect(isExpression({ pow: [2, 3] })).toBe(false);
    expect(isExpression({ sub: [1, 2, 3] })).toBe(false);
    expect(isExpression({ round: [1.5, 7] })).toBe(false);
    expect(isExpression(Number.NaN)).toBe(false);
    let deep: Expression = 1;
    for (let i = 0; i < 10; i++) deep = { add: [deep, 1] };
    expect(isExpression(deep)).toBe(false);
  });
});

describe('steps', () => {
  const definition = valid(EXPENSE_APP);
  const claim = { id: CLAIM, title: 'Singapore trip', trip: 'Singapore', total: 302.4, status: 'approved', iban: 'SG12 3456', approver: null, owner: BOB };
  const approve = (record: Record<string, unknown>, by = ALICE) =>
    runSteps({ definition, entity: 'expense_claim', steps: definition.actions['approve_claim']!.steps!, record: record as never, lines: {}, principal: { id: by }, now: NOW });

  it('record the approver and pay the claim through an a7c skill, with the real values', () => {
    const result = approve(claim);
    expect(result.issues).toEqual([]);
    expect(result.failed).toBeUndefined();
    expect(result.record['approver']).toBe(ALICE);
    expect(result.set).toEqual(['approver']);
    expect(result.skills).toEqual([
      { step: 'steps[3]', label: 'Pay the claim', skill: 'finance/pay-expense-claim', input: { claim: CLAIM, title: 'Singapore trip', amount: 302.4, account: 'SG12 3456' } },
    ]);
  });

  it('take the branch for a large claim, and stop when people approve their own', () => {
    expect(approve({ ...claim, total: 1500 }).skills.map((call) => `${call.step} ${call.skill}`)).toEqual([
      'steps[2].then[0] finance/check-large-claim',
      'steps[3] finance/pay-expense-claim',
    ]);
    const own = approve(claim, BOB);
    expect(own.failed).toEqual({ rule: 'steps[0]', severity: 'error', message: "You can't approve your own claim", fields: [] });
    expect(own.skills).toEqual([]);
    expect(own.record['approver']).toBeNull();
    expect(stepName('steps[2].then[0]')).toBe('Step 3, then 1');
  });

  it('add lines, and later steps see the new totals', () => {
    const app = valid(
      edited((d) => {
        d.actions.add_per_diem = {
          label: 'Add a per diem',
          description: 'Add the daily meal allowance to a claim.',
          entity: 'expense_claim',
          operation: 'update',
          input: [],
          steps: [
            { type: 'add_line', field: 'lines', values: { date: { today: true }, merchant: 'Per diem', category: 'meals', amount: 50 } },
            { type: 'check', assert: { lte: [{ ref: 'record.total' }, 400] }, severity: 'warning', message: 'The claim is now over SGD 400', fields: ['total'] },
            { type: 'set', field: 'trip', value: { concat: [{ ref: 'record.trip' }, ', with a per diem'] } },
          ],
        };
      }),
    );
    const line = { id: '0193a7c4-0000-7000-8000-0000000000d1', values: { date: '2026-11-03', merchant: 'Hotel', category: 'hotel', amount: 360, receipt: null } };
    const result = runSteps({
      definition: app,
      entity: 'expense_claim',
      steps: app.actions['add_per_diem']!.steps!,
      record: { ...claim, total: 360 },
      lines: { lines: [line] },
      principal: { id: ALICE },
      now: NOW,
    });
    expect(result.issues).toEqual([]);
    expect(result.lines['lines']).toEqual([line, { id: null, values: { date: '2026-11-17', merchant: 'Per diem', category: 'meals', amount: 50, receipt: null } }]);
    expect(result.record['total']).toBe(410);
    expect(result.findings).toEqual([{ rule: 'steps[1]', severity: 'warning', message: 'The claim is now over SGD 400', fields: ['total'] }]);
    expect(result.record['trip']).toBe('Singapore, with a per diem');
    expect(result.linesAdded).toEqual(['lines']);
  });

  it('refuse a value its field cannot hold, naming the step', () => {
    const app = valid(
      edited((d) => {
        d.actions.approve_claim.steps = [{ type: 'set', field: 'title', value: { concat: [{ ref: 'record.iban' }, { ref: 'record.iban' }] } }];
      }),
    );
    const result = runSteps({ definition: app, entity: 'expense_claim', steps: app.actions['approve_claim']!.steps!, record: { ...claim, iban: null }, lines: {}, principal: { id: ALICE }, now: NOW });
    expect(result.issues).toEqual([{ field: 'title', code: 'required', message: 'Step 1: Title is required, and the step leaves it empty' }]);
  });
});

describe('checking steps', () => {
  it('names what is wrong with each step', () => {
    const issues = issuesOf(
      edited((d) => {
        d.actions.approve_claim.steps = [
          { type: 'set', field: 'colour', value: 'red' },
          { type: 'set', field: 'total', value: 1 },
          { type: 'set', field: 'lines', value: null },
          { type: 'set', field: 'trip', value: { ref: 'record.total' } },
          { type: 'set', field: 'approver', value: { ref: 'record.lines' } },
          { type: 'set', field: 'status', value: 'paid' },
          { type: 'add_line', field: 'lines', values: { merchant: 'Per diem', amount: { mul: ['two', 25] } } },
          { type: 'if', when: { eq: [{ ref: 'record.colour' }, 'red'] }, then: [] },
          { type: 'skill', label: 'Tell someone', skill: 'Finance/Pay', input: {} },
        ];
      }),
    );
    expect(issues).toEqual([
      'actions.approve_claim.steps[8].skill: Name a skill as project/skill, for example finance/pay-expense-claim',
    ]);
    const deeper = issuesOf(
      edited((d) => {
        d.actions.approve_claim.steps = [
          { type: 'set', field: 'colour', value: 'red' },
          { type: 'set', field: 'total', value: 1 },
          { type: 'set', field: 'lines', value: null },
          { type: 'set', field: 'trip', value: { ref: 'record.total' } },
          { type: 'set', field: 'approver', value: { ref: 'record.lines' } },
          { type: 'set', field: 'status', value: 'paid' },
          { type: 'add_line', field: 'lines', values: { merchant: 'Per diem', amount: { mul: ['two', 25] } } },
          { type: 'if', when: { eq: [{ ref: 'record.colour' }, 'red'] }, then: [] },
        ];
      }),
    );
    expect(deeper).toEqual([
      'actions.approve_claim.steps[0].field: No field named colour',
      'actions.approve_claim.steps[1].field: total is worked out from lines',
      'actions.approve_claim.steps[2].field: lines holds lines: add one with an "add a line" step',
      'actions.approve_claim.steps[3].value: Trip holds text, and this gives a number',
      "actions.approve_claim.steps[4].value: record.lines: a step can't use lines one by one. Add a rollup, such as a total, and use that",
      'actions.approve_claim.steps[5].value: Status: Expected one of: draft, submitted, approved',
      'actions.approve_claim.steps[6].values.amount: mul works on numbers, not on text',
      'actions.approve_claim.steps[6].values: Each line needs Date: give it a value',
      'actions.approve_claim.steps[6].values: Each line needs Category: give it a value',
      'actions.approve_claim.steps[7].when: record.colour: no such field',
      'actions.approve_claim.steps[7]: A branch needs at least one step',
    ]);
  });

  it('count a field the steps always set as given, for a new record', () => {
    const withoutTitle = edited((d) => {
      d.actions.submit_claim.input = ['trip', 'lines', 'iban'];
      d.forms.claim_form.sections[0].fields[0].readOnly = true;
    });
    expect(issuesOf(withoutTitle)).toEqual(['actions.submit_claim.input: title is required, so the action must take it as input, set it, or the field needs a default']);
    const branchOnly = edited((d) => {
      d.actions.submit_claim.input = ['trip', 'lines', 'iban'];
      d.forms.claim_form.sections[0].fields[0].readOnly = true;
      d.actions.submit_claim.steps = [{ type: 'if', when: { exists: 'record.trip' }, then: [{ type: 'set', field: 'title', value: { ref: 'record.trip' } }] }];
    });
    expect(issuesOf(branchOnly)).toHaveLength(1);
    const bothSides = edited((d) => {
      d.actions.submit_claim.input = ['trip', 'lines', 'iban'];
      d.forms.claim_form.sections[0].fields[0].readOnly = true;
      d.actions.submit_claim.steps = [
        {
          type: 'if',
          when: { exists: 'record.trip' },
          then: [{ type: 'set', field: 'title', value: { concat: ['Trip to ', { ref: 'record.trip' }] } }],
          else: [{ type: 'set', field: 'title', value: 'A claim' }],
        },
      ];
    });
    expect(issuesOf(bothSides)).toEqual([]);
  });

  it('carry renames into steps', () => {
    const first = valid(EXPENSE_APP);
    const next = structuredClone(first) as unknown as Record<string, any>;
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'approver').name = 'approved_by';
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'iban').name = 'account';
    const result = validateDefinition(next, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const steps = result.definition.actions['approve_claim']!.steps!;
    expect(steps[1]).toEqual({ type: 'set', field: 'approved_by', value: { ref: 'principal.id' } });
    expect(steps[3]).toMatchObject({ input: { account: { ref: 'record.account' } } });
  });
});

describe('steps in review', () => {
  it('name each a7c skill an action gains or loses, for reviewers', () => {
    const base = valid(EXPENSE_APP);
    const head = valid(
      edited((d) => {
        d.actions.approve_claim.steps = d.actions.approve_claim.steps.filter((step: { type: string }) => step.type !== 'if');
        d.actions.approve_claim.steps.push({ type: 'skill', label: 'Tell the requester', skill: 'people/notify', input: { person: { ref: 'record.owner' } } });
      }),
      base,
    );
    expect(capabilityChanges(base, head).map((change) => change.text)).toEqual([
      'approve_claim now starts the a7c skill people/notify: Tell the requester',
      'approve_claim no longer starts the a7c skill finance/check-large-claim',
    ]);
    const reordered = valid(
      edited((d) => {
        d.actions.approve_claim.steps.reverse();
      }),
      base,
    );
    expect(capabilityChanges(base, reordered).map((change) => change.text)).toEqual(['approve_claim runs different steps']);
  });

  it('list the skills a change starts on its card, without their input', () => {
    const definition = valid(EXPENSE_APP);
    const card = buildCard({
      definition,
      entity: 'expense_claim',
      title: 'Approve an expense claim',
      show: ['status'],
      values: { status: 'approved' },
      findings: [],
      skills: [{ label: 'Pay the claim', skill: 'finance/pay-expense-claim' }],
    });
    expect(card.then).toEqual([{ label: 'Pay the claim', skill: 'finance/pay-expense-claim' }]);
  });
});
