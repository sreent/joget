import { describe, expect, it } from 'vitest';
import { EXPENSE_APP, LEAVE_APP, validateDefinition, type FlowStep } from '@platform/app-model';
import type { Definition } from '../types.js';
import { normalize } from './edit.js';
import {
  addBeforeFlow,
  addFlow,
  describeFlowStep,
  insertStep,
  labelledLists,
  layoutFlow,
  listAt,
  liveWords,
  moveStep,
  moveStepTo,
  newStep,
  problemsByStep,
  removeFlow,
  removeStep,
  recipientWords,
  replaceStep,
  scopeAt,
  startRun,
  stepAt,
  stepWords,
  updateFlow,
  variableChoices,
  type StepType,
} from './flows.js';

/** The example app, with budgets that a flow keeps up to date as claims are approved. */
function app(): Definition {
  const definition = normalize(structuredClone(EXPENSE_APP) as unknown as Definition);
  const budget: Definition['entities'][string] = {
    label: 'Budget',
    pluralLabel: 'Budgets',
    fields: [
      { name: 'category', label: 'Category', type: 'text', required: true },
      { name: 'spent', label: 'Spent', type: 'number', decimals: 2 },
    ],
  } as Definition['entities'][string];
  const steps: FlowStep[] = [
    {
      type: 'each',
      in: 'claim.lines',
      as: 'line',
      steps: [
        { type: 'find', var: 'budget', entity: 'budget', where: { eq: [{ ref: 'record.category' }, { ref: 'line.category' }] }, first: true, limit: 1 },
        {
          type: 'if',
          when: { exists: 'budget.id' },
          then: [{ type: 'change', record: 'budget', values: { spent: { add: [{ ref: 'budget.spent' }, { ref: 'line.amount' }] } } }],
          else: [{ type: 'create', entity: 'budget', values: { category: { ref: 'line.category' }, spent: { ref: 'line.amount' } }, var: 'budget' }],
        },
      ],
    },
    { type: 'total', var: 'spent', of: 'claim.lines', op: 'sum', field: 'amount' },
    { type: 'check', assert: { gt: [{ ref: 'spent' }, 0] }, message: 'An approved claim spends something', severity: 'error' },
    { type: 'return', value: { ref: 'spent' } },
  ];
  return {
    ...definition,
    entities: { ...definition.entities, budget },
    roles: { ...definition.roles, approver: { ...definition.roles['approver']!, entities: { ...definition.roles['approver']!.entities, budget: { read: true } }, flows: ['record_spend'] } },
    flows: { ...definition.flows, record_spend: { label: 'Record the spend', input: { claim: { type: 'record', entity: 'expense_claim' } }, output: { type: 'number' }, steps } },
    actions: { ...definition.actions, approve_claim: { ...definition.actions['approve_claim']!, flow: { flow: 'record_spend', input: { claim: { ref: 'record' } } } } },
  };
}

const issues = (definition: Definition) => {
  const result = validateDefinition(definition);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
};
const spend = (definition: Definition) => definition.flows!['record_spend']!;

describe('editing flows', () => {
  it('starts from a flow that passes the checks', () => {
    expect(issues(app())).toEqual([]);
  });

  it('finds steps and lists of steps by their paths, inside loops and branches', () => {
    const flow = spend(app());
    expect(listAt(flow, 'steps')).toHaveLength(4);
    expect(listAt(flow, 'steps[0].steps')).toHaveLength(2);
    expect(stepAt(flow, 'steps[0].steps[1].then[0]')).toMatchObject({ type: 'change', record: 'budget' });
    expect(stepAt(flow, 'steps[0].steps[1].else[0]')).toMatchObject({ type: 'create', entity: 'budget' });
    expect(listAt(flow, 'steps[1].steps')).toBeUndefined();
    expect(stepAt(flow, 'steps[9]')).toBeUndefined();
  });

  it('moves a step, with all it holds, to another arrow or into another way, and never into itself', () => {
    const before = app();
    const flow = spend(before);
    const loop = stepAt(flow, 'steps[0]')!;
    // Out of the loop, to the end of the flow: the loop's own path stays.
    const out = moveStepTo(before, 'record_spend', 'steps[0].steps[1]', { list: 'steps', index: 4 })!;
    expect(out.path).toBe('steps[4]');
    expect(stepAt(spend(out.definition), 'steps[4]')).toEqual(stepAt(flow, 'steps[0].steps[1]'));
    expect(listAt(spend(out.definition), 'steps[0].steps')).toHaveLength(1);
    // Into a way of the step after it: that step moves up, and so does its way's path.
    const find = stepAt(flow, 'steps[0].steps[0]');
    const down = moveStepTo(before, 'record_spend', 'steps[0].steps[0]', { list: 'steps[0].steps[1].then', index: 1 })!;
    expect(down.path).toBe('steps[0].steps[0].then[1]');
    expect(stepAt(spend(down.definition), 'steps[0].steps[0]')).toMatchObject({ type: 'if' });
    expect(stepAt(spend(down.definition), 'steps[0].steps[0].then[1]')).toEqual(find);
    // Later in its own list: it goes before the step at the place, as an arrow says.
    const later = moveStepTo(before, 'record_spend', 'steps[0]', { list: 'steps', index: 3 })!;
    expect(later.path).toBe('steps[2]');
    expect(stepAt(spend(later.definition), 'steps[2]')).toEqual(loop);
    // Where it is already, or into itself: nothing moves.
    expect(moveStepTo(before, 'record_spend', 'steps[0]', { list: 'steps', index: 1 })).toBeNull();
    expect(moveStepTo(before, 'record_spend', 'steps[0]', { list: 'steps[0].steps', index: 0 })).toBeNull();
  });

  it('finds the step each problem is about: the deepest step its path names', () => {
    const flow = spend(app());
    const problems = [
      { path: 'flows.record_spend.steps[0].steps[1].then[0].values.spent', message: 'a' },
      { path: 'flows.record_spend.steps[0].steps[1].when', message: 'b' },
      { path: 'flows.record_spend.steps[0].steps[1].then[0].values.left', message: 'c' },
      { path: 'flows.record_spend.input.claim', message: 'd' },
      { path: 'flows.other.steps[0]', message: 'e' },
      { path: 'entities.budget.fields[0]', message: 'f' },
    ];
    expect(problemsByStep(flow, 'record_spend', problems)).toEqual(
      new Map([
        ['steps[0].steps[1].then[0]', ['a', 'c']],
        ['steps[0].steps[1]', ['b']],
        ['', ['d']],
      ]),
    );
  });

  it('inserts, replaces, moves and removes steps where their paths say', () => {
    let definition = insertStep(app(), 'record_spend', 'steps[0].steps[1].then', 1, { type: 'set', var: 'touched', value: true });
    expect(listAt(spend(definition), 'steps[0].steps[1].then')!.map((step) => step.type)).toEqual(['change', 'set']);
    definition = moveStep(definition, 'record_spend', 'steps[0].steps[1].then[1]', -1);
    expect(listAt(spend(definition), 'steps[0].steps[1].then')!.map((step) => step.type)).toEqual(['set', 'change']);
    // A move past either end of the list does nothing.
    expect(moveStep(definition, 'record_spend', 'steps[0].steps[1].then[0]', -1)).toEqual(definition);
    definition = replaceStep(definition, 'record_spend', 'steps[0].steps[1].then[0]', { type: 'set', var: 'touched', value: false });
    expect(stepAt(spend(definition), 'steps[0].steps[1].then[0]')).toEqual({ type: 'set', var: 'touched', value: false });
    definition = removeStep(definition, 'record_spend', 'steps[0].steps[1].then[0]');
    expect(spend(definition)).toEqual(spend(app()));
    expect(issues(definition)).toEqual([]);
  });

  it('knows the variables at each place: the input, the loop item, and what steps before it found', () => {
    const definition = app();
    const names = (scope: ReadonlyMap<string, unknown>) => [...scope.keys()];
    expect(names(scopeAt(definition, 'record_spend', { path: 'steps[0]' }))).toEqual(['claim']);
    expect(names(scopeAt(definition, 'record_spend', { path: 'steps[0].steps[0]' }))).toEqual(['claim', 'line']);
    expect(names(scopeAt(definition, 'record_spend', { path: 'steps[0].steps[1].then[0]' }))).toEqual(['claim', 'line', 'budget']);
    // At the end of a list, a new step sees what the list's last step left.
    expect(names(scopeAt(definition, 'record_spend', { list: 'steps', index: 4 }))).toEqual(['claim', 'spent']);
    const choices = variableChoices(definition, scopeAt(definition, 'record_spend', { path: 'steps[0].steps[1]' })).map((choice) => choice.ref);
    expect(choices).toEqual(expect.arrayContaining(['claim.id', 'claim.title', 'line.amount', 'budget.spent']));
    expect(choices).not.toContain('claim.lines');
  });

  it('adds new steps that fit the variables where they go, and pass the checks', () => {
    let { definition, name } = addFlow(app(), 'Tidy a claim');
    expect(name).toBe('tidy_a_claim');
    definition = updateFlow(definition, name, { input: { claim: { type: 'record', entity: 'expense_claim' } } });
    const add = (list: string, index: number, type: StepType) => {
      const step = newStep(definition, name, scopeAt(definition, name, { list, index }), type);
      definition = insertStep(definition, name, list, index, step);
      return step;
    };
    expect(add('steps', 0, 'find')).toEqual({ type: 'find', var: 'found', entity: 'expense_claim', limit: 100 });
    expect(add('steps', 1, 'each')).toEqual({ type: 'each', in: 'claim.lines', as: 'item', steps: [] });
    expect(add('steps[1].steps', 0, 'set')).toEqual({ type: 'set', var: 'value', value: 0 });
    expect(add('steps', 2, 'total')).toEqual({ type: 'total', var: 'total', of: 'claim.lines', op: 'count' });
    expect(add('steps', 3, 'if')).toEqual({ type: 'if', when: { exists: 'claim.id' }, then: [], else: [] });
    expect(add('steps[3].then', 0, 'change')).toEqual({ type: 'change', record: 'claim', values: {} });
    expect(add('steps', 4, 'check')).toMatchObject({ type: 'check', severity: 'error' });
    expect(add('steps', 5, 'try')).toEqual({ type: 'try', steps: [], catch: [], rollback: true });
    expect(add('steps', 6, 'call')).toEqual({ type: 'call', flow: 'check_approval', input: {} });
    // A second variable of a kind gets a name of its own.
    expect(add('steps', 7, 'find')).toMatchObject({ var: 'found_2' });
    // What a builder still has to say, the checks name in words.
    expect(issues(definition)).toEqual([
      `flows.${name}.steps[3].then[0].values: Say what changes`,
      `flows.${name}.steps[5].steps: Put the steps that the handler guards inside it`,
      `flows.${name}.steps[6].input: Check the approval needs claim`,
    ]);
    definition = replaceStep(definition, name, 'steps[3].then[0]', { type: 'change', record: 'claim', values: { title: { concat: [{ ref: 'claim.title' }, ' (checked)'] } } });
    // The loop's `value` is gone outside the loop, so the name is free again.
    expect(add('steps[5].steps', 0, 'set')).toEqual({ type: 'set', var: 'value', value: 0 });
    definition = replaceStep(definition, name, 'steps[6]', { type: 'call', flow: 'record_spend', input: { claim: { ref: 'claim' } } });
    expect(issues(definition)).toEqual([]);
  });

  it('describes steps in words for the canvas', () => {
    const definition = app();
    const flow = spend(definition);
    expect(flow.steps.map((step) => describeFlowStep(definition, step))).toEqual(['For each line in claim.lines', 'Total amount of claim.lines → spent', 'Stop unless spent is more than 0', 'Return spent']);
    expect(describeFlowStep(definition, stepAt(flow, 'steps[0].steps[0]')!)).toBe('Find a Budget where Category is line.category → budget');
    expect(describeFlowStep(definition, stepAt(flow, 'steps[0].steps[1].then[0]')!)).toBe('Change budget: spent');
  });

  it('removes a flow, and the roles and actions that named it', () => {
    const definition = removeFlow(app(), 'record_spend');
    expect(Object.keys(definition.flows!)).toEqual(['check_approval']);
    expect(definition.roles['approver']!.flows).toEqual([]);
    expect(definition.actions['approve_claim']!.flow).toBeUndefined();
    expect(issues(definition)).toEqual([]);
  });

  it('writes a flow for an action to run before it saves, which takes the record', () => {
    const made = addBeforeFlow(removeFlow(app(), 'check_approval'), 'approve_claim');
    expect(made.name).toBe('approve_an_expense_claim_before_it_saves');
    expect(made.definition.flows![made.name]).toEqual({ label: 'Approve an expense claim: before it saves', input: { expense_claim: { type: 'record', entity: 'expense_claim' } }, steps: [] });
    expect(made.definition.actions['approve_claim']!.before).toEqual({ flow: made.name, input: { expense_claim: { ref: 'record' } } });
    // A flow needs a step: the checks say so, on the flow, until the builder adds one.
    expect(issues(made.definition)).toEqual([`flows.${made.name}.steps: A flow needs a step`]);
    expect(removeFlow(made.definition, made.name).actions['approve_claim']).not.toHaveProperty('before');
  });

  it('starts what an action gives a flow: the record itself, and plain values', () => {
    let definition = app();
    expect(startRun(definition, 'record_spend', 'expense_claim')).toEqual({ flow: 'record_spend', input: { claim: { ref: 'record' } } });
    // A record of another entity, or a list, is left out for the checks to name.
    expect(startRun(definition, 'record_spend', 'budget')).toEqual({ flow: 'record_spend', input: {} });
    definition = updateFlow(definition, 'record_spend', {
      input: { claim: { type: 'record', entity: 'expense_claim' }, rate: { type: 'number' }, note: { type: 'text' }, on: { type: 'date' }, at: { type: 'datetime' }, urgent: { type: 'boolean' } },
    });
    expect(startRun(definition, 'record_spend', 'expense_claim').input).toEqual({ claim: { ref: 'record' }, rate: 0, note: '', on: { today: true }, at: { now: true }, urgent: false });
  });
});

describe('the flow canvas', () => {
  /** Where the canvas offers to add a step: on its arrows, and in the slots of empty lists. */
  const places = (definition: Definition, flow: string, width = 5000) => {
    const laid = layoutFlow(definition, definition.flows![flow]!, width);
    return [
      ...laid.edges.flatMap((edge) => (edge.insert ? [`${edge.insert.list}@${edge.insert.index}`] : [])),
      ...laid.nodes.flatMap((node) => (node.kind === 'slot' ? [`${node.list}@0`] : [])),
    ].sort();
  };

  it('lays steps left to right: a loop as a frame, a decision as a diamond whose ways meet, and a return as the end', () => {
    const definition = app();
    const { nodes, edges } = layoutFlow(definition, spend(definition), 5000);
    const kinds = Object.fromEntries(nodes.map((node) => [node.id, node.kind]));
    expect(kinds).toMatchObject({
      start: 'start',
      'steps[0]': 'frame',
      'steps[0].steps[0]': 'step',
      'steps[0].steps[1]': 'decision',
      'steps[0].steps[1]:merge': 'merge',
      'steps[1]': 'step',
      'steps[3]': 'end',
    });
    // A return ends the flow: no other end, and nothing after it.
    expect(nodes.some((node) => node.id === 'end')).toBe(false);
    expect(edges.some((edge) => edge.source === 'steps[3]')).toBe(false);
    expect(edges.filter((edge) => edge.source === 'steps[0].steps[1]').map((edge) => edge.label?.text)).toEqual(['yes', 'no']);
    // Each step sits to the right of the one before it, on one row.
    const at = (id: string) => nodes.find((node) => node.id === id)!;
    expect(at('start').x).toBeLessThan(at('steps[0]').x);
    expect(at('steps[0]').x + at('steps[0]').width).toBeLessThan(at('steps[1]').x);
    expect(at('steps[1]').x).toBeLessThan(at('steps[2]').x);
    expect(at('steps[1]').y).toBe(at('steps[2]').y);
    // The no way runs below the yes way; the find kept in the frame, and the box says what it does.
    expect(at('steps[0].steps[1].else[0]').y).toBeGreaterThan(at('steps[0].steps[1].then[0]').y);
    expect(at('steps[0].steps[0]')).toMatchObject({ kindLabel: 'Find', label: 'A Budget', tone: 'reads' });
    expect(at('steps[0].steps[1].then[0]')).toMatchObject({ kindLabel: 'Change', tone: 'changes' });
  });

  it('offers each place for a new step once, except after a return', () => {
    expect(places(app(), 'record_spend')).toEqual(
      [
        'steps@0',
        'steps@1',
        'steps@2',
        'steps@3',
        'steps[0].steps@0',
        'steps[0].steps@1',
        'steps[0].steps@2',
        'steps[0].steps[1].then@0',
        'steps[0].steps[1].then@1',
        'steps[0].steps[1].else@0',
        'steps[0].steps[1].else@1',
      ].sort(),
    );
  });

  it('shows an empty flow, branch or handler as a slot that takes the first step', () => {
    let { definition, name } = addFlow(app(), 'Empty');
    expect(places(definition, name)).toEqual(['steps@0']);
    expect(layoutFlow(definition, definition.flows![name]!).edges.every((edge) => !edge.insert)).toBe(true);
    definition = insertStep(definition, name, 'steps', 0, { type: 'try', steps: [], catch: [], rollback: true });
    expect(places(definition, name)).toEqual(['steps@0', 'steps@1', 'steps[0].catch@0', 'steps[0].steps@0']);
    const { edges } = layoutFlow(definition, definition.flows![name]!);
    expect(edges.find((edge) => edge.label?.text === 'if it fails')).toMatchObject({ source: 'steps[0]:out', target: 'slot:steps[0].catch' });
  });

  it('wraps a long flow into rows, and carries it on from one row to the next', () => {
    let { definition, name } = addFlow(app(), 'Long');
    for (let i = 0; i < 8; i++) definition = insertStep(definition, name, 'steps', i, { type: 'set', var: `v${i}`, value: i });
    const { nodes, edges } = layoutFlow(definition, definition.flows![name]!, 760);
    const at = (id: string) => nodes.find((node) => node.id === id)!;
    const rows = [...new Set(nodes.filter((node) => node.kind === 'step').map((node) => node.y))];
    expect(rows.length).toBeGreaterThan(1);
    expect(Math.max(...nodes.map((node) => node.x + node.width))).toBeLessThanOrEqual(760);
    // The first step of a later row starts back at the left, and the arrow into it takes a new step.
    const first = nodes.filter((node) => node.kind === 'step' && node.y === rows[1]).sort((a, b) => a.x - b.x)[0]!;
    expect(first.x).toBeLessThan(at('steps[1]').x);
    const index = Number(/\[(\d+)\]/.exec(first.id)![1]);
    expect(edges.find((edge) => edge.target === first.id)?.insert).toMatchObject({ list: 'steps', index });
    expect(places(definition, name, 760)).toEqual(Array.from({ length: 9 }, (_, i) => `steps@${i}`).sort());
  });

  /** The leave template, as the studio has it: with what its parts leave out filled in. */
  const leave = (): Definition => {
    const result = validateDefinition(LEAVE_APP);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.definition as unknown as Definition;
  };

  it('draws a flow that waits: a task with a way on for each outcome, a deadline below it, waits as rings, and a bar where it saves', () => {
    const definition = leave();
    const flow = definition.flows!['leave_approval']!;
    const task = flow.steps[0] as Extract<FlowStep, { type: 'task' }>;
    const steps: FlowStep[] = [
      { ...task, deadline: { after: 'P3D', steps: [] } },
      { type: 'wait', for: { date: 'starts' } },
      { type: 'first_of', ways: [{ for: { action: 'reject_leave' }, steps: [{ type: 'return' }] }, { for: { duration: 'P2D' }, steps: [] }] },
      { type: 'all_at_once', ways: [{ steps: [] }, { steps: [] }] },
    ];
    const waits = { ...definition, flows: { leave_approval: { ...flow, steps } } };
    const { nodes, edges } = layoutFlow(waits, waits.flows.leave_approval, 5000);
    const at = (id: string) => nodes.find((node) => node.id === id)!;
    expect(at('steps[0]')).toMatchObject({ kind: 'step', kindLabel: "Person's task", label: 'Decide on the leave', about: 'within 3 days', who: { kind: 'person', initial: 'M', words: 'the manager' } });
    // A way on for each outcome, which meet again; the deadline hangs below the task by a dashed line.
    expect(edges.filter((edge) => edge.source === 'steps[0]' && edge.label).map((edge) => edge.label!.text)).toEqual(['Approve', 'Reject']);
    expect(at('steps[0]:deadline')).toMatchObject({ kind: 'wait', label: 'After 3 days', caption: 'below', path: 'steps[0]' });
    expect(at('steps[0]:deadline').y).toBeGreaterThan(at('steps[0]').y + at('steps[0]').height);
    expect(edges.find((edge) => edge.target === 'steps[0]:deadline')).toMatchObject({ dashed: true });
    expect(at('steps[0]:merge').kind).toBe('merge');
    // Waits are rings; the first of starts each of its ways with what it waits for.
    expect(at('steps[1]')).toMatchObject({ kind: 'wait', label: 'Waits until First day', icon: 'clock' });
    expect(at('steps[2]')).toMatchObject({ kind: 'frame', label: 'The first of' });
    expect(at('steps[2].ways[0]')).toMatchObject({ kind: 'wait', label: 'Waits for Reject the leave', icon: 'message' });
    expect(at('steps[3]')).toMatchObject({ kind: 'frame', label: 'All at once', about: 'when both are done' });
    // The flow saves before each place where it waits: the task, the wait, and the first of.
    expect(edges.filter((edge) => edge.save).map((edge) => edge.target).sort()).toEqual(['steps[0]', 'steps[1]', 'steps[2]:in']);
    // Every way takes a step; what a way of the first of waits for is not a step.
    expect(places(waits, 'leave_approval')).toEqual(
      [
        'steps@0',
        'steps@1',
        'steps@2',
        'steps@3',
        'steps@4',
        'steps[0].deadline.steps@0',
        'steps[0].outcomes[0].steps@0',
        'steps[0].outcomes[1].steps@0',
        'steps[2].ways[0].steps@0',
        'steps[2].ways[1].steps@0',
        'steps[3].ways[0].steps@0',
        'steps[3].ways[1].steps@0',
      ].sort(),
    );
  });

  it('adds steps that wait only where a flow can keep its place on a record', () => {
    const definition = leave();
    const scope = scopeAt(definition, 'leave_approval', { list: 'steps', index: 1 });
    expect(newStep(definition, 'leave_approval', scope, 'first_of')).toEqual({
      type: 'first_of',
      ways: [
        { for: { action: 'approve_leave' }, steps: [] },
        { for: { duration: 'P3D' }, steps: [] },
      ],
    });
    expect(newStep(definition, 'leave_approval', scope, 'task')).toMatchObject({ type: 'task', role: 'employee', outcomes: [{ name: 'approve' }, { name: 'reject' }] });
    // Steps on a task's way are found by their paths, as any other.
    const next = insertStep(definition, 'leave_approval', 'steps[0].outcomes[1].steps', 0, { type: 'change', record: 'leave', values: { reason: 'Rejected' } });
    expect(stepAt(next.flows!['leave_approval']!, 'steps[0].outcomes[1].steps[0]')).toMatchObject({ type: 'change' });
    expect(issues(next)).toEqual([]);
  });

  it('lists a flow by its ways, and says live how many cases wait at a step', () => {
    const definition = leave();
    const task = definition.flows!['leave_approval']!.steps[0]!;
    expect(labelledLists(definition, task, 'steps[0]').map((list) => [list.label, list.path])).toEqual([
      ['Approve', 'steps[0].outcomes[0].steps'],
      ['Reject', 'steps[0].outcomes[1].steps'],
    ]);
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(liveWords({ waiting: 3, stuck: 0, since: '2026-11-15T12:00:00Z' }, now)).toBe('3 waiting · 2 days');
    expect(liveWords({ waiting: 0, stuck: 1, since: '2026-11-17T09:00:00Z' }, now)).toBe('1 stuck · 3 hours');
    expect(liveWords({ waiting: 1, stuck: 0, since: '2026-11-17T11:59:00Z' }, now)).toBe('1 waiting · 1 minute');
    expect(liveWords({ waiting: 1, stuck: 0, since: '2026-11-17T11:59:50Z' }, now)).toBe('1 waiting · under a minute');
  });

  it('wraps a flow that waits where it saves, and folds a frame to one box', () => {
    const definition = leave();
    const flow = definition.flows!['leave_approval']!;
    const set = (i: number): FlowStep => ({ type: 'change', record: 'leave', values: { reason: `Step ${i}` } });
    const steps: FlowStep[] = [set(1), set(2), { type: 'wait', for: { duration: 'P1D' } }, set(3), set(4), set(5), set(6)];
    const waits = { ...definition, flows: { leave_approval: { ...flow, steps } } };
    const { nodes } = layoutFlow(waits, waits.flows.leave_approval, 1000);
    const at = (id: string) => nodes.find((node) => node.id === id)!;
    // The row breaks before the wait, though more would fit on it: the wait starts the next row.
    expect(at('steps[2]').y).toBeGreaterThan(at('steps[1]').y);
    expect(at('steps[2]').x).toBeLessThan(at('steps[1]').x);
    expect(at('steps[1]').y).toBe(at('steps[0]').y);

    const loop: FlowStep = { type: 'each', in: 'leave.lines', as: 'line', steps: [set(7), set(8)] };
    const looped = { ...definition, flows: { leave_approval: { ...flow, steps: [loop] } } };
    const open = layoutFlow(looped, looped.flows.leave_approval, 5000);
    expect(open.nodes.find((node) => node.id === 'steps[0]')!.kind).toBe('frame');
    const shut = layoutFlow(looped, looped.flows.leave_approval, 5000, new Set(['steps[0]']));
    expect(shut.nodes.find((node) => node.id === 'steps[0]')).toMatchObject({ kind: 'step', folded: true, about: '2 steps inside' });
    expect(shut.nodes.some((node) => node.id === 'steps[0].steps[0]')).toBe(false);
  });
  it('hangs reminders below a task before its deadline, frames steps that repeat, and says how a flow starts by itself', () => {
    const definition = leave();
    const flow = definition.flows!['leave_approval']!;
    const task = flow.steps[0] as Extract<FlowStep, { type: 'task' }>;
    const steps: FlowStep[] = [
      {
        type: 'repeat',
        while: { eq: [{ ref: 'leave.status' }, 'submitted'] },
        max: 3,
        steps: [{ ...task, reminders: [{ after: 'P1D', steps: [{ type: 'change', record: 'leave', values: { reason: 'Reminded' } }] }], deadline: { after: 'P3D', steps: [] } }],
      },
    ];
    const waits = { ...definition, flows: { leave_approval: { ...flow, starts: [{ date: 'starts', before: 'P2D' }, { created: true as const }], steps } } };
    const { nodes, edges } = layoutFlow(waits, waits.flows.leave_approval, 5000);
    const at = (id: string) => nodes.find((node) => node.id === id)!;
    expect(at('steps[0]')).toMatchObject({ kind: 'frame', label: 'Repeats while leave.status is “submitted”', about: '3 times at most' });
    // The reminder hangs first, the deadline below it; the reminder's way ends by itself.
    const reminder = at('steps[0].steps[0]:reminder:0');
    expect(reminder).toMatchObject({ kind: 'wait', label: 'After 1 day', about: 'a reminder', icon: 'bell', path: 'steps[0].steps[0]' });
    expect(at('steps[0].steps[0]:deadline').y).toBeGreaterThan(reminder.y + reminder.height);
    expect(edges.find((edge) => edge.target === 'steps[0].steps[0]:deadline')).toMatchObject({ dashed: true, source: 'steps[0].steps[0]:reminder:0' });
    expect(at('steps[0].steps[0]:reminder:0:end')).toMatchObject({ kind: 'end', label: 'Reminded' });
    expect(edges.some((edge) => edge.source === 'steps[0].steps[0].reminders[0].steps[0]' && edge.target === 'steps[0].steps[0]:reminder:0:end')).toBe(true);
    expect(labelledLists(waits, steps[0]!.type === 'repeat' ? steps[0]!.steps[0]! : steps[0]!, 'steps[0].steps[0]').map((list) => list.label)).toEqual([
      'Approve',
      'Reject',
      'After 1 day, a reminder',
      'After 3 days, the task ends',
    ]);
    expect(at('start')).toMatchObject({ about: 'on 2 days before First day, or 1 more way' });
    const scheduled = { ...definition, flows: { tidy: { label: 'Tidy', input: {}, schedule: { every: 'weekday' as const, at: '07:30', zone: 'Europe/London' }, steps: [] } } };
    expect(layoutFlow(scheduled, scheduled.flows.tidy).nodes.find((node) => node.id === 'start')).toMatchObject({ about: 'every weekday at 07:30, Europe/London time' });
  });
  it('tells people: whom the record names first, in words, and outside the app when it emails', () => {
    const definition = leave();
    const flow = definition.flows!['leave_approval']!;
    const scope = scopeAt(definition, 'leave_approval', { list: 'steps', index: 1 });
    const step = newStep(definition, 'leave_approval', scope, 'inform');
    expect(step).toEqual({ type: 'inform', to: [{ person: { ref: 'leave.manager' } }], title: 'Say what happened', about: 'leave', email: true });
    const told = { ...step, to: [{ person: { ref: 'leave.owner' } }, { role: 'manager' }], title: { concat: ['Approved: ', { ref: 'leave.days' }, ' days'] } } as Extract<FlowStep, { type: 'inform' }>;
    expect(recipientWords(definition, told)).toBe('the owner and Manager');
    expect(stepWords(definition, told)).toEqual({ kind: 'Informs people', words: '"Approved: " & leave.days & " days"', about: 'to the owner and Manager, by email too', tone: 'outside' });
    expect(stepWords(definition, { ...told, title: 'Approved' })).toMatchObject({ words: 'Approved' });
    expect(stepWords(definition, { ...told, email: false })).not.toHaveProperty('tone');
    expect(describeFlowStep(definition, told)).toBe('Tell the owner and Manager: "Approved: " & leave.days & " days"');
    expect(flow.steps.length).toBeGreaterThan(0);
  });
  it('calls a service through a connection, outside the app', () => {
    const definition = {
      ...leave(),
      connections: { payroll: { kind: 'service' as const, label: 'Payroll', url: 'https://payroll.example.com/api', auth: { type: 'bearer' as const }, personalData: false } },
    } as Definition;
    const scope = scopeAt(definition, 'leave_approval', { list: 'steps', index: 1 });
    const step = newStep(definition, 'leave_approval', scope, 'call_service');
    expect(step).toEqual({ type: 'call_service', connection: 'payroll', method: 'GET', path: '', query: {}, results: {} });
    const call = { ...step, path: '/balances', results: { days_left: { from: 'data.days', type: 'number' } } } as Extract<FlowStep, { type: 'call_service' }>;
    expect(stepWords(definition, call)).toEqual({ kind: 'Calls a service', words: 'Payroll', about: 'GET /balances → days_left', tone: 'outside' });
    expect(describeFlowStep(definition, call)).toBe('Call Payroll: GET "/balances"');
  });
});
