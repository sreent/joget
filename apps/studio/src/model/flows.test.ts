import { describe, expect, it } from 'vitest';
import { EXPENSE_APP, validateDefinition, type FlowStep } from '@platform/app-model';
import type { Definition } from '../types.js';
import { normalize } from './edit.js';
import {
  addFlow,
  describeFlowStep,
  insertStep,
  layoutFlow,
  listAt,
  moveStep,
  newStep,
  removeFlow,
  removeStep,
  replaceStep,
  scopeAt,
  startRun,
  stepAt,
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
    flows: { record_spend: { label: 'Record the spend', input: { claim: { type: 'record', entity: 'expense_claim' } }, output: { type: 'number' }, steps } },
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
    expect(add('steps', 6, 'call')).toEqual({ type: 'call', flow: 'record_spend', input: {} });
    // A second variable of a kind gets a name of its own.
    expect(add('steps', 7, 'find')).toMatchObject({ var: 'found_2' });
    // What a builder still has to say, the checks name in words.
    expect(issues(definition)).toEqual([
      `flows.${name}.steps[3].then[0].values: Say what changes`,
      `flows.${name}.steps[5].steps: Put the steps that the handler guards inside it`,
      `flows.${name}.steps[6].input: Record the spend needs claim`,
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
    expect(definition.flows).toEqual({});
    expect(definition.roles['approver']!.flows).toEqual([]);
    expect(definition.actions['approve_claim']!.flow).toBeUndefined();
    expect(issues(definition)).toEqual([]);
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
});
