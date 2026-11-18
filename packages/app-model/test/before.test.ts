import { describe, expect, it } from 'vitest';
import {
  AppDefinition,
  beforeGives,
  capabilityChanges,
  Draft,
  evaluateExpression,
  EXPENSE_APP,
  isExpression,
  readsPrincipal,
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

/** Approval steps, as an older definition has them: nobody approves their own claim, and a large claim needs a bank account. */
const APPROVAL_STEPS = [
  { type: 'check', assert: { ne: [{ ref: 'record.owner' }, { ref: 'principal.id' }] }, message: "You can't approve your own claim" },
  { type: 'set', field: 'approver', value: { ref: 'principal.id' } },
  {
    type: 'if',
    when: { gt: [{ ref: 'record.total' }, 1000] },
    then: [{ type: 'check', assert: { exists: 'record.iban' }, message: 'A large claim needs a bank account', fields: ['iban'] }],
  },
];
const withSteps = () =>
  edited((d) => {
    delete d.actions.approve_claim.before;
    delete d.flows.check_approval;
    d.actions.approve_claim.steps = structuredClone(APPROVAL_STEPS);
  });

/** The example, with a flow of its own that runs before an approval saves. */
const withBefore = (steps: unknown[], input: Record<string, unknown> = { claim: { type: 'record', entity: 'expense_claim' } }) =>
  edited((d) => {
    d.flows.check_approval = { label: 'Check the approval', input, steps };
  });

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

describe('a draft of the record an action saves', () => {
  const definition = valid(EXPENSE_APP);
  const claim = { id: CLAIM, title: 'Singapore trip', trip: 'Singapore', total: 360, status: 'submitted', iban: 'SG12 3456', approver: null, owner: BOB };
  const hotel = { id: '0193a7c4-0000-7000-8000-0000000000d1', values: { date: '2026-11-03', merchant: 'Hotel', category: 'hotel', amount: 360, receipt: null } };

  it('sets values as their fields hold them, and says which it set', () => {
    const draft = new Draft(definition, 'expense_claim', claim, {});
    expect(draft.change({ approver: ALICE, trip: 'Singapore and Penang' }, 'Check the approval')).toEqual([]);
    expect(draft.record).toMatchObject({ approver: ALICE, trip: 'Singapore and Penang', title: 'Singapore trip' });
    expect(draft.set).toEqual(['approver', 'trip']);
  });

  it('refuses a value its field cannot hold, and then sets nothing', () => {
    const draft = new Draft(definition, 'expense_claim', claim, {});
    expect(draft.change({ trip: 'Penang', title: null, total: 5, status: 'paid' }, 'Check the approval')).toEqual([
      { field: 'title', code: 'required', message: 'Check the approval: Title is required, and this leaves it empty' },
      { field: 'total', code: 'not_writable', message: "Check the approval: Total (SGD) can't be set here" },
      { field: 'status', code: 'invalid_option', message: 'Check the approval: Status: Expected one of: draft, submitted, approved' },
    ]);
    expect(draft.record['trip']).toBe('Singapore');
    expect(draft.set).toEqual([]);
  });

  it('adds lines with their defaults, and the rollups follow', () => {
    const draft = new Draft(definition, 'expense_claim', claim, { lines: [hotel] });
    expect(draft.addLine('lines', { date: '2026-11-17T08:30:00.000Z', merchant: 'Per diem', category: 'meals', amount: 50.004 }, 'Add a per diem')).toEqual([]);
    expect(draft.lines['lines']).toEqual([hotel, { id: null, values: { date: '2026-11-17', merchant: 'Per diem', category: 'meals', amount: 50, receipt: null } }]);
    expect(draft.record['total']).toBe(410);
    expect(draft.linesAdded).toEqual(['lines']);
    expect(draft.addLine('lines', { merchant: 'Taxi', amount: 12 }, 'Add a taxi')).toEqual([
      { field: 'lines[2].date', code: 'required', message: 'Add a taxi: Date is required' },
      { field: 'lines[2].category', code: 'required', message: 'Add a taxi: Category is required' },
    ]);
    expect(draft.lines['lines']).toHaveLength(2);
    expect(draft.addLine('nothing', {}, 'Add')).toEqual([{ field: 'nothing', code: 'unknown_field', message: 'Add: Expense claim has no lines field nothing' }]);
  });
});

describe('the flow an action runs before it saves', () => {
  it('moves the steps of an older definition into a flow, which does the same', () => {
    const result = validateDefinition(withSteps(), undefined, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    const action = result.definition.actions['approve_claim']!;
    expect(action.steps).toBeUndefined();
    expect(action.before).toEqual({ flow: 'approve_claim_before', input: { expense_claim: { ref: 'record' } } });
    expect(result.definition.flows!['approve_claim_before']).toEqual({
      label: 'Approve an expense claim: before it saves',
      description: "What Approve an expense claim does before it saves. It was the action's steps.",
      input: { expense_claim: { type: 'record', entity: 'expense_claim' } },
      steps: [
        { type: 'check', assert: { ne: [{ ref: 'expense_claim.owner' }, { ref: 'principal.id' }] }, message: "You can't approve your own claim", severity: 'error' },
        { type: 'change', record: 'expense_claim', values: { approver: { ref: 'principal.id' } } },
        {
          type: 'if',
          when: { gt: [{ ref: 'expense_claim.total' }, 1000] },
          then: [{ type: 'check', assert: { exists: 'expense_claim.iban' }, message: 'A large claim needs a bank account', severity: 'error', fields: ['expense_claim.iban'] }],
          else: [],
        },
      ],
    });
    expect(result.notes).toContain('The steps of Approve an expense claim are now the flow Approve an expense claim: before it saves, which runs before it saves');
    // What it moved is a definition like any other: it saves, and checks again the same.
    expect(AppDefinition.safeParse(result.definition).success).toBe(true);
    expect(validateDefinition(result.definition, result.definition, ids())).toMatchObject({ ok: true, notes: [] });
  });

  it('gives the moved flow a name no flow has', () => {
    const taken = edited((d) => {
      delete d.actions.approve_claim.before;
      d.flows.approve_claim_before = d.flows.check_approval;
      d.actions.approve_claim.steps = [{ type: 'set', field: 'approver', value: { ref: 'principal.id' } }];
    });
    expect(valid(taken).actions['approve_claim']!.before).toEqual({ flow: 'approve_claim_before_2', input: { expense_claim: { ref: 'record' } } });
  });

  it('changes only the record its action saves, and nothing elsewhere', () => {
    const issues = issuesOf(
      edited((d) => {
        d.connections = { crm: { kind: 'service', label: 'CRM', url: 'https://crm.example.com', auth: { type: 'none' } } };
        d.flows.audit = { label: 'Keep a copy', input: { claim: { type: 'record', entity: 'expense_claim' } }, steps: [{ type: 'change', record: 'claim', values: { trip: 'Copied' } }] };
        d.flows.check_approval = {
          label: 'Check the approval',
          input: { claim: { type: 'record', entity: 'expense_claim' } },
          steps: [
            { type: 'find', var: 'other', entity: 'expense_claim', first: true },
            { type: 'change', record: 'other', values: { trip: 'Changed' } },
            { type: 'create', entity: 'expense_claim', values: { title: 'Another', trip: 'Penang', status: 'draft' } },
            { type: 'delete', record: 'other' },
            { type: 'inform', to: [{ role: 'approver' }], title: 'Approved' },
            { type: 'call_service', connection: 'crm', method: 'POST', path: '/claims', body: {} },
            { type: 'call_service', connection: 'crm', path: '/rates' },
            { type: 'call', flow: 'audit', input: { claim: { ref: 'claim' } } },
            { type: 'find', var: 'claim', entity: 'expense_claim', first: true },
          ],
        };
      }),
    );
    expect(issues).toEqual([
      "flows.check_approval.steps[1]: other isn't the expense claim that Approve an expense claim saves: it runs before Approve an expense claim saves, so it changes only the expense claim it saves",
      "flows.check_approval.steps[2]: This flow can't create records: it runs before Approve an expense claim saves, so it changes only the expense claim it saves. Create them in a flow that runs after it saves",
      "flows.check_approval.steps[3]: This flow can't delete records: it runs before Approve an expense claim saves, so it changes only the expense claim it saves",
      'flows.check_approval.steps[4]: This flow tells nobody: it runs before Approve an expense claim saves, and for its previews too. Tell people in a flow that runs after it saves',
      'flows.check_approval.steps[5]: This flow only reads from services: it runs for previews too, and a POST changes something there',
      'flows.check_approval.steps[7]: Keep a copy changes records or tells people, and this flow calls only flows that read: it runs before Approve an expense claim saves, so it changes only the expense claim it saves',
      'flows.check_approval.steps[8]: claim holds the expense claim that Approve an expense claim saves: keep other values in other variables',
    ]);
  });

  it('runs in one go, and gets the record itself', () => {
    const waits = edited((d) => {
      d.flows.check_approval.steps = [{ type: 'wait', for: { duration: 'P1D' } }];
    });
    expect(issuesOf(waits)).toContain('actions.approve_claim.before.flow: Check the approval waits, and a flow that runs before an action saves runs in one go');
    const given = edited((d) => {
      d.actions.approve_claim.before = { flow: 'check_approval', input: { claim: { ref: 'record.total' } } };
    });
    expect(issuesOf(given)).toEqual(['actions.approve_claim.before.input.claim: claim is a record of expense_claim: give record, the expense_claim itself']);
    const both = edited((d) => {
      d.actions.approve_claim.steps = [{ type: 'set', field: 'approver', value: { ref: 'principal.id' } }];
    });
    expect(issuesOf(both)).toEqual(['actions.approve_claim.steps: Approve an expense claim runs a flow before it saves: move these steps into it']);
  });

  it('checks the values a check is about', () => {
    const issues = issuesOf(
      withBefore([{ type: 'check', assert: { exists: 'claim.iban' }, message: 'Give a bank account', fields: ['claim.colour', 'other.iban'] }]),
    );
    expect(issues).toEqual(['flows.check_approval.steps[0].fields[0]: claim.colour: Expense claim has no field colour', 'flows.check_approval.steps[0].fields[1]: other.iban: no variable other here']);
  });

  it('counts a field that it always sets as given, for a new record', () => {
    const titled = (steps: unknown[]) =>
      edited((d) => {
        d.actions.submit_claim.input = ['trip', 'lines', 'iban'];
        d.actions.submit_claim.before = { flow: 'name_claim', input: { claim: { ref: 'record' } } };
        d.forms.claim_form.sections[0].fields[0].readOnly = true;
        d.flows.name_claim = { label: 'Name the claim', input: { claim: { type: 'record', entity: 'expense_claim' } }, steps };
      });
    const trip = { exists: 'claim.trip' };
    const branchOnly = titled([{ type: 'if', when: trip, then: [{ type: 'change', record: 'claim', values: { title: { ref: 'claim.trip' } } }] }]);
    expect(issuesOf(branchOnly)).toEqual(['actions.submit_claim.input: title is required, so the action must take it as input, set it, or the field needs a default']);
    const bothSides = titled([
      {
        type: 'if',
        when: trip,
        then: [{ type: 'change', record: 'claim', values: { title: { concat: ['Trip to ', { ref: 'claim.trip' }] } } }],
        else: [{ type: 'change', record: 'claim', values: { title: 'A claim' } }],
      },
    ]);
    expect(issuesOf(bothSides)).toEqual([]);
    const definition = valid(bothSides);
    expect([...beforeGives(definition, definition.actions['submit_claim']!)]).toEqual(['title']);
  });

  it('knows when it reads the person who runs it', () => {
    const definition = valid(EXPENSE_APP);
    expect(readsPrincipal(definition, definition.actions['approve_claim']!)).toBe(true);
    expect(readsPrincipal(definition, definition.actions['submit_claim']!)).toBe(false);
    const calling = (value: Expression) =>
      valid(
        edited((d) => {
          d.flows.who = { label: 'Who', input: {}, steps: [{ type: 'set', var: 'someone', value }] };
          d.flows.check_approval = { label: 'Check the approval', input: { claim: { type: 'record', entity: 'expense_claim' } }, steps: [{ type: 'call', flow: 'who', input: {} }] };
        }),
      );
    const quiet = calling('nobody');
    expect(readsPrincipal(quiet, quiet.actions['approve_claim']!)).toBe(false);
    const asks = calling({ ref: 'principal.id' });
    expect(readsPrincipal(asks, asks.actions['approve_claim']!)).toBe(true);
  });

  it('follows renames into the flow', () => {
    const first = valid(EXPENSE_APP);
    const next = structuredClone(first) as unknown as Record<string, any>;
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'approver').name = 'approved_by';
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'total').name = 'sum';
    const result = validateDefinition(next, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const steps = result.definition.flows!['check_approval']!.steps;
    expect(steps[1]).toEqual({ type: 'change', record: 'claim', values: { approved_by: { ref: 'principal.id' } } });
    expect(steps[2]).toMatchObject({ assert: { lte: [{ ref: 'claim.sum' }, 1000] }, fields: ['claim.sum'] });
  });

  it('says in a change request when an action runs another flow before it saves', () => {
    const base = valid(EXPENSE_APP);
    const head = valid(
      edited((d) => {
        d.flows.approve_quietly = { label: 'Approve quietly', input: { claim: { type: 'record', entity: 'expense_claim' } }, steps: [{ type: 'change', record: 'claim', values: { approver: { ref: 'principal.id' } } }] };
        d.actions.approve_claim.before = { flow: 'approve_quietly', input: { claim: { ref: 'record' } } };
      }),
      base,
    );
    expect(capabilityChanges(base, head).map((change) => change.text)).toEqual(['approve_claim now runs the flow approve_quietly before it saves', 'New flow Approve quietly: it changes Expense claim']);
  });
});
