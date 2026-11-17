import { describe, expect, it } from 'vitest';
import { capabilityChanges, compileAppPolicy, EXPENSE_APP, LEAVE_PROCESS_APP, lintDefinition, validateDefinition, type StoredDefinition } from '@platform/app-model';

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

/** The example app with a budget for each category, which a flow keeps up to date. */
function withFlows(edit: (draft: Record<string, any>) => void = () => undefined): Record<string, any> {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.budget = {
    label: 'Budget',
    fields: [
      { name: 'category', label: 'Category', type: 'text', required: true },
      { name: 'spent', label: 'Spent', type: 'number', decimals: 2 },
      { name: 'cap', label: 'Cap', type: 'number', decimals: 2 },
    ],
  };
  draft.roles.approver.entities.budget = { read: true };
  draft.flows = {
    record_spend: {
      label: 'Record the spend',
      description: "Adds each line of an approved claim to its category's budget.",
      input: { claim: { type: 'record', entity: 'expense_claim' } },
      output: { type: 'number' },
      steps: [
        {
          type: 'each',
          in: 'claim.lines',
          as: 'line',
          steps: [
            { type: 'find', var: 'budget', entity: 'budget', where: { eq: [{ ref: 'record.category' }, { ref: 'line.category' }] }, first: true },
            {
              type: 'if',
              when: { exists: 'budget.id' },
              then: [{ type: 'change', record: 'budget', values: { spent: { add: [{ ref: 'budget.spent' }, { ref: 'line.amount' }] } } }],
              else: [{ type: 'create', entity: 'budget', values: { category: { ref: 'line.category' }, spent: { ref: 'line.amount' } }, var: 'budget' }],
            },
          ],
        },
        { type: 'total', var: 'spent', of: 'claim.lines', op: 'sum', field: 'amount' },
        { type: 'check', assert: { gt: [{ ref: 'spent' }, 0] }, message: 'An approved claim spends something' },
        { type: 'return', value: { ref: 'spent' } },
      ],
    },
    over_budget: {
      label: 'Budgets over their cap',
      input: {},
      output: { type: 'number' },
      steps: [
        { type: 'find', var: 'budgets', entity: 'budget', sort: [{ field: 'spent', direction: 'desc' }], limit: 50 },
        { type: 'set', var: 'over', value: 0 },
        {
          type: 'each',
          in: 'budgets',
          as: 'budget',
          steps: [{ type: 'if', when: { gt: [{ ref: 'budget.spent' }, { ref: 'budget.cap' }] }, then: [{ type: 'set', var: 'over', value: { add: [{ ref: 'over' }, 1] } }] }],
        },
        { type: 'return', value: { ref: 'over' } },
      ],
    },
  };
  draft.actions.approve_claim.flow = { flow: 'record_spend', input: { claim: { ref: 'record' } } };
  edit(draft);
  return draft;
}

describe('flows', () => {
  it('pass the checks: loops over lines, finds, changes and creates related records, totals and returns', () => {
    const definition = valid(withFlows());
    expect(Object.keys(definition.flows!)).toEqual(['record_spend', 'over_budget']);
    expect(definition.actions['approve_claim']!.flow).toEqual({ flow: 'record_spend', input: { claim: { ref: 'record' } } });
  });

  it('say what is wrong with a step, naming the step', () => {
    const issues = issuesOf(
      withFlows((d) => {
        d.flows.broken = {
          label: 'Broken',
          input: { claim: { type: 'record', entity: 'expense_claim' }, record: { type: 'text' } },
          steps: [
            { type: 'set', var: 'title', value: { ref: 'claim.colour' } },
            { type: 'set', var: 'whose', value: { ref: 'record.owner' } },
            { type: 'find', var: 'lines', entity: 'expense_line' },
            { type: 'find', var: 'budgets', entity: 'budget', where: { eq: [{ ref: 'record.size' }, 1] } },
            { type: 'set', var: 'many', value: { ref: 'budgets' } },
            { type: 'create', entity: 'budget', values: { spent: 'lots' } },
            { type: 'change', record: 'budgets', values: { cap: 1 } },
            { type: 'add_line', record: 'claim', field: 'title', values: {} },
            { type: 'each', in: 'claim.title', as: 'item', steps: [{ type: 'set', var: 'x', value: 1 }] },
            { type: 'total', var: 'sum', of: 'claim.lines', op: 'sum' },
            { type: 'check', assert: { gt: [{ ref: 'claim.title' }, 1] }, message: 'Never' },
            { type: 'call', flow: 'record_spend', input: { claim: { ref: 'title' }, extra: 1 } },
            { type: 'call', flow: 'nowhere', input: {} },
            { type: 'try', steps: [], catch: [] },
            { type: 'return', value: 1 },
          ],
        };
      }),
    );
    expect(issues).toEqual([
      'flows.broken.input.record: record is a name the platform keeps: choose another',
      'flows.broken.steps[0].value: claim.colour: Expense claim has no field colour',
      'flows.broken.steps[1].value: record.owner: a flow names records by its variables. record.<field> is for a find\'s condition',
      'flows.broken.steps[2].entity: expense_line holds the lines of expense_claim: work with them through expense_claim',
      'flows.broken.steps[3].where: record.size: no such field',
      'flows.broken.steps[4].value: budgets is a list, not a value. Count it with a total step',
      'flows.broken.steps[5].values.spent: Spent: Expected a number',
      'flows.broken.steps[5].values: A new Budget needs Category: give it a value',
      'flows.broken.steps[6].record: budgets holds a list of budget, not a record',
      'flows.broken.steps[7].field: title isn\'t a lines field of expense_claim',
      'flows.broken.steps[8].in: title isn\'t a lines field of expense_claim',
      'flows.broken.steps[9].field: Say which number field to total',
      'flows.broken.steps[10].assert: gt compares numbers, and claim.title isn\'t one',
      'flows.broken.steps[11].input.claim: Give a record of expense_claim: a variable that holds one',
      'flows.broken.steps[11].input.extra: Record the spend takes no extra',
      'flows.broken.steps[12].flow: No flow named nowhere',
      'flows.broken.steps[13].steps: Put the steps that the handler guards inside it',
      'flows.broken.steps[14].value: Broken gives no result: leave the value out, or give the flow a result',
    ]);
  });

  it('keep each variable to its block and its kind', () => {
    const issues = issuesOf(
      withFlows((d) => {
        d.flows.scoped = {
          label: 'Scoped',
          input: { claim: { type: 'record', entity: 'expense_claim' } },
          steps: [
            { type: 'if', when: { exists: 'claim.trip' }, then: [{ type: 'set', var: 'where', value: { ref: 'claim.trip' } }] },
            { type: 'set', var: 'again', value: { ref: 'where' } },
            { type: 'set', var: 'claim', value: 'text' },
            { type: 'find', var: 'claim', entity: 'budget', first: true },
          ],
        };
      }),
    );
    expect(issues).toEqual([
      'flows.scoped.steps[1].value: where: no variable where here',
      'flows.scoped.steps[3]: claim holds a record of expense_claim here, not a record of budget',
    ]);
  });

  it('refuse flows that call each other in a loop', () => {
    const issues = issuesOf(
      withFlows((d) => {
        d.flows.ping = { label: 'Ping', steps: [{ type: 'call', flow: 'pong' }] };
        d.flows.pong = { label: 'Pong', steps: [{ type: 'call', flow: 'ping' }] };
      }),
    );
    expect(issues).toEqual(['flows.ping: Flows call each other in a loop: ping → pong → ping']);
  });

  it('check what an action or a service task gives its flow', () => {
    expect(
      issuesOf(
        withFlows((d) => {
          d.actions.approve_claim.flow = { flow: 'record_spend', input: { claim: { ref: 'record.title' }, who: { ref: 'principal.id' } } };
        }),
      ),
    ).toEqual([
      'actions.approve_claim.flow.input.claim: claim is a record of expense_claim: give record, the expense_claim itself',
      'actions.approve_claim.flow.input.who: Record the spend takes no who',
    ]);

    const leave = structuredClone(LEAVE_PROCESS_APP) as unknown as Record<string, any>;
    leave.flows = {
      note: { label: 'Note', input: { days: { type: 'number' }, by: { type: 'text' } }, steps: [{ type: 'check', assert: { gt: [{ ref: 'days' }, 0] }, message: 'Days' }] },
    };
    leave.processes.leave_approval.elements.decide_note = { type: 'serviceTask', name: 'Note it', flow: { flow: 'note', input: { days: { ref: 'record.days' }, by: { ref: 'principal.id' } } } };
    leave.processes.leave_approval.flows.on_approve.to = 'decide_note';
    leave.processes.leave_approval.flows.noted = { from: 'decide_note', to: 'approved' };
    delete leave.processes.leave_approval.diagram;
    expect(issuesOf(leave)).toEqual(['processes.leave_approval.elements.decide_note.flow.input.by: principal.id: a process runs the flow with no person']);
    leave.processes.leave_approval.elements.decide_note.flow.input.by = 'process';
    expect(issuesOf(leave)).toEqual([]);
    leave.processes.leave_approval.elements.decide_note.action = 'approve_leave';
    expect(issuesOf(leave)).toContain('processes.leave_approval.elements.decide_note: Note it runs an action or a flow: one of the two');
  });

  it('carry renames of fields into flows, through the kinds of their variables', () => {
    const first = valid(withFlows());
    const next = structuredClone(first) as unknown as Record<string, any>;
    next.entities.budget.fields.find((f: { name: string }) => f.name === 'spent').name = 'used';
    next.entities.expense_line.fields.find((f: { name: string }) => f.name === 'amount').name = 'value';
    next.entities.expense_line.fields.find((f: { name: string }) => f.name === 'category').name = 'kind';
    const result = validateDefinition(next, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [each, total] = result.definition.flows!['record_spend']!.steps as any[];
    expect(each.steps[0].where).toEqual({ eq: [{ ref: 'record.category' }, { ref: 'line.kind' }] });
    expect(each.steps[1].then[0].values).toEqual({ used: { add: [{ ref: 'budget.used' }, { ref: 'line.value' }] } });
    expect(each.steps[1].else[0].values).toEqual({ category: { ref: 'line.kind' }, used: { ref: 'line.value' } });
    expect(total).toMatchObject({ of: 'claim.lines', field: 'value' });
    expect((result.definition.flows!['over_budget']!.steps[0] as any).sort).toEqual([{ field: 'used', direction: 'desc' }]);
    expect(result.notes).toEqual(expect.arrayContaining(['Updated references for the rename budget.spent → used']));
  });

  it('tell reviewers what a flow does to records, and who may run it', () => {
    const base = valid(EXPENSE_APP);
    const head = valid(withFlows((d) => void (d.roles.approver.flows = ['over_budget'])), base);
    const texts = capabilityChanges(base, head).map((change) => change.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'approve_claim now runs the flow record_spend once it saves',
        'New flow Record the spend: it finds Budget; creates Budget; changes Budget',
        'New flow Budgets over their cap: it finds Budget',
      ]),
    );
    const { permissionSets } = compileAppPolicy('0193a7c4-0000-7000-8000-00000000abcd', head);
    expect(permissionSets.find((set) => set.id.endsWith('approver'))!.grants).toContainEqual({ permission: 'flow.run', resource: 'over_budget' });
    expect(lintDefinition(head)).toEqual([]);
    expect(lintDefinition(valid(withFlows((d) => void (d.actions.approve_claim.flow = undefined))))).toEqual(
      expect.arrayContaining(['Nothing runs the flow Record the spend: no action, process task, other flow or role names it']),
    );
  });
});
