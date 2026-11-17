import { describe, expect, it } from 'vitest';
import {
  capabilityChanges,
  compileAppPolicy,
  compileFlow,
  decisionsBy,
  flowScopes,
  flowSubject,
  flowWaits,
  LEAVE_APP,
  lintDefinition,
  LEAVE_PROCESS_APP,
  runnable,
  startsOf,
  validateDefinition,
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

/** The leave template, with an HR role, and its flows changed by `edit`. */
function leave(edit: (definition: Record<string, any>) => void = () => undefined): Record<string, any> {
  const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
  definition.roles.hr = {
    label: 'HR',
    description: 'Looks at long leave.',
    entities: { leave_request: { read: true, update: { fields: { include: ['status', 'reason'] } } } },
    actions: ['approve_leave', 'reject_leave'],
  };
  edit(definition);
  return definition;
}

/** A flow that waits, with a stretch of steps, a decision that leads to a task, a wait, the first of two waits, and two ways at once. */
const REVIEW = {
  label: 'Review',
  input: { leave: { type: 'record', entity: 'leave_request' } },
  steps: [
    { type: 'set', var: 'note', value: 'Seen' },
    { type: 'change', record: 'leave', values: { reason: { ref: 'note' } } },
    {
      type: 'if',
      when: { gt: [{ ref: 'leave.days' }, 10] },
      then: [{ type: 'task', label: 'Look at long leave', role: 'hr', outcomes: [{ name: 'fine', label: 'Fine', steps: [{ type: 'change', record: 'leave', values: { reason: 'Long' } }] }] }],
    },
    { type: 'wait', for: { duration: 'P2D' } },
    {
      type: 'first_of',
      ways: [
        { for: { action: 'reject_leave' }, steps: [{ type: 'return' }] },
        { for: { date: 'starts' }, steps: [] },
      ],
    },
    {
      type: 'all_at_once',
      ways: [
        { steps: [{ type: 'change', record: 'leave', values: { status: 'approved' } }] },
        { steps: [{ type: 'task', label: 'Tell payroll', role: 'hr', outcomes: [{ name: 'done', label: 'Done' }] }] },
      ],
    },
  ],
};

describe('a flow that waits', () => {
  it('is how the leave template asks the manager, and compiles to the process the engine runs', () => {
    const definition = valid(LEAVE_APP);
    const flow = definition.flows!['leave_approval']!;
    expect(flowWaits(flow, definition.flows)).toBe(true);
    expect(flowSubject(flow)).toEqual({ name: 'leave', entity: 'leave_request' });
    expect(lintDefinition(definition)).toEqual([]);
    // A reviewer reads whom it waits for.
    expect(capabilityChanges(valid(LEAVE_PROCESS_APP), definition)).toContainEqual({ tool: 'leave_approval', change: 'added', text: 'New flow Leave approval: it waits for Manager: Decide on the leave' });

    const compiled = compileFlow(definition, 'leave_approval', flow)!;
    expect(compiled.parts).toEqual({});
    expect(compiled.process.entity).toBe('leave_request');
    expect(compiled.process.elements).toEqual({
      start: { type: 'startEvent', name: 'Leave approval', actions: [] },
      start_by_action: { type: 'startEvent', name: 'Ask for leave', actions: ['request_leave'] },
      start_meet: { type: 'exclusiveGateway', name: 'Where the starts meet' },
      steps_0: {
        type: 'userTask',
        name: 'Decide on the leave',
        role: 'manager',
        assignee: { field: 'manager' },
        outcomes: [
          { name: 'approve', label: 'Approve', action: 'approve_leave' },
          { name: 'reject', label: 'Reject', action: 'reject_leave' },
        ],
        due: 'P3D',
        card: 'leave_review',
      },
      steps_0_meet: { type: 'exclusiveGateway', name: 'Where the ways meet' },
      end: { type: 'endEvent', name: 'Leave approval', terminate: false },
    });
    expect(Object.values(compiled.process.flows)).toEqual(
      expect.arrayContaining([
        { from: 'steps_0', to: 'steps_0_meet', outcome: 'approve', name: 'Approve' },
        { from: 'steps_0', to: 'steps_0_meet', outcome: 'reject', name: 'Reject' },
        { from: 'steps_0_meet', to: 'end' },
      ]),
    );
    expect(compiled.at.get('steps_0')).toBe('steps[0]');

    // The engines see it as a process; builders see a flow.
    expect(definition.processes).toBeUndefined();
    const runs = runnable(definition);
    expect(runnable(definition)).toBe(runs);
    expect(startsOf(runs, 'request_leave')).toEqual([{ process: 'leave_approval', element: 'start_by_action' }]);
    expect(decisionsBy(runs, 'reject_leave')).toEqual([{ process: 'leave_approval', element: 'steps_0', outcome: 'reject' }]);
  });

  it('runs the steps between two waits in one go, as a flow of their own', () => {
    const definition = valid(leave((d) => void (d.flows.review = REVIEW)));
    const compiled = compileFlow(definition, 'review', definition.flows!['review']!)!;
    const types = Object.fromEntries(Object.entries(compiled.process.elements).map(([id, element]) => [id, element.type]));
    expect(types).toEqual({
      start: 'startEvent',
      steps_0: 'serviceTask',
      steps_2: 'exclusiveGateway',
      steps_2_then_0: 'userTask',
      steps_2_then_0_outcomes_0_steps_0: 'serviceTask',
      steps_2_meet: 'exclusiveGateway',
      steps_3: 'intermediateCatchEvent',
      steps_4: 'eventBasedGateway',
      'steps_4_ways_0': 'intermediateCatchEvent',
      steps_4_ways_0_steps_0: 'endEvent',
      'steps_4_ways_1': 'intermediateCatchEvent',
      steps_5: 'parallelGateway',
      steps_5_ways_0_steps_0: 'serviceTask',
      steps_5_ways_1_steps_0: 'userTask',
      steps_5_join: 'parallelGateway',
      end: 'endEvent',
    });
    // The first two steps are one stretch, which reads the record afresh.
    expect(compiled.parts['review.steps_0']).toEqual({
      label: 'Review: set a value and change',
      input: { leave: { type: 'record', entity: 'leave_request' } },
      steps: definition.flows!['review']!.steps.slice(0, 2),
    });
    expect(compiled.process.elements['steps_0']).toMatchObject({ type: 'serviceTask', flow: { flow: 'review.steps_0', input: { leave: { ref: 'record' } } } });
    // The engine reads the record where the flow reads its variable.
    expect(Object.values(compiled.process.flows)).toContainEqual({ from: 'steps_2', to: 'steps_2_then_0', when: { gt: [{ ref: 'record.days' }, 10] }, name: 'Yes' });
    expect(Object.values(compiled.process.flows)).toContainEqual({ from: 'steps_2', to: 'steps_2_meet', default: true, name: 'No' });
    expect(compiled.process.elements['steps_3']).toEqual({ type: 'intermediateCatchEvent', name: 'Waits 2 days', timer: { duration: 'P2D' } });
    expect(compiled.process.elements['steps_4_ways_0']).toEqual({ type: 'intermediateCatchEvent', name: 'Waits for Reject the leave', message: { action: 'reject_leave' } });
    expect(compiled.process.elements['steps_4_ways_1']).toEqual({ type: 'intermediateCatchEvent', name: 'Waits until First day', timer: { date: 'starts' } });
    expect(compiled.process.elements['steps_4_ways_0_steps_0']).toEqual({ type: 'endEvent', name: 'Ends here', terminate: true });
    // The way that ends the flow doesn't meet the other.
    expect(Object.values(compiled.process.flows).filter((flow) => flow.to === 'steps_5')).toEqual([{ from: 'steps_4_ways_1', to: 'steps_5' }]);
    expect(lintDefinition(definition)).toEqual(['Nothing runs the flow Review: no action, process task, other flow or role names it']);
  });

  it('keeps no value in a variable across a wait, and has no person', () => {
    const later = structuredClone(REVIEW) as Record<string, any>;
    later.steps.push({ type: 'change', record: 'leave', values: { reason: { ref: 'note' } } });
    later.steps.push({ type: 'change', record: 'leave', values: { reason: { ref: 'principal.id' } } });
    later.steps[2].when = { eq: [{ ref: 'note' }, 'Seen'] };
    expect(issuesOf(leave((d) => void (d.flows.review = later)))).toEqual([
      "flows.review.steps[2].when: note: note doesn't live on after the flow waits. Keep the value in a field of the record, and read it from there",
      "flows.review.steps[6].values.reason: note: note doesn't live on after the flow waits. Keep the value in a field of the record, and read it from there",
      'flows.review.steps[7].values.reason: principal.id: a flow that waits runs with no person',
    ]);
    // A step after a wait sees only the record.
    const definition = valid(leave((d) => void (d.flows.review = REVIEW)));
    const scopes = flowScopes(definition, definition.flows!['review']!);
    expect([...scopes.get('steps[1]')!.keys()]).toEqual(['leave', 'note']);
    expect([...scopes.get('steps[3]')!.keys()]).toEqual(['leave']);
  });

  it('keeps its place on one record, outside loops and error handlers', () => {
    expect(
      issuesOf(
        leave((d) => {
          d.flows.review = {
            label: 'Review',
            input: { leave: { type: 'record', entity: 'leave_request' }, days: { type: 'number' } },
            output: { type: 'number' },
            steps: [
              { type: 'find', var: 'all', entity: 'leave_request' },
              { type: 'each', in: 'all', as: 'one', steps: [{ type: 'wait', for: { duration: 'P1D' } }, { type: 'return', value: 1 }] },
              { type: 'try', steps: [{ type: 'task', label: 'Look', role: 'hr', outcomes: [{ name: 'ok', label: 'OK' }, { name: 'ok', label: 'Also OK' }] }] },
              { type: 'first_of', ways: [{ for: { duration: 'P1D' }, steps: [] }] },
              { type: 'all_at_once', ways: [{ steps: [] }, { steps: [{ type: 'wait', for: { signal: 'go' } }] }] },
            ],
          };
        }),
      ),
    ).toEqual([
      'flows.review.input: A flow that waits keeps its place on one record: give it one input, a record of what it is about',
      'flows.review.output: A flow that waits gives no result: what it does shows on its record',
      "flows.review.steps[1]: A loop can't hold steps that wait yet: move them out of it",
      "flows.review.steps[2]: An error handler can't hold steps that wait yet: move them out of it",
      'flows.review.steps[1].steps[1]: A flow that waits ends outside its loops and error handlers: move this step out',
      'flows.review.steps[2].steps[0].outcomes[1].name: Another outcome is named ok: give each its own name',
      'flows.review.steps[3].ways: Give two ways or more: the first of them to happen goes on',
      'flows.review.steps[4].ways[0].steps: Put a step in this way',
    ]);
  });

  it('shows what its tasks and waits name on the steps that name them', () => {
    const broken = structuredClone(REVIEW) as Record<string, any>;
    broken.steps[2].then[0].role = 'nobody';
    broken.steps[2].then[0].outcomes[0].action = 'request_leave';
    broken.steps[4].ways[1].for = { date: 'reason' };
    broken.steps[5].ways[1].steps[0].assignee = { field: 'kind' };
    expect(issuesOf(leave((d) => void (d.flows.review = broken)))).toEqual([
      'flows.review.steps[2].then[0].role: No role named nobody',
      'flows.review.steps[2].then[0].outcomes[0].action: request_leave creates a record; here an action changes the process\'s own record',
      "flows.review.steps[4].ways[1].for.date: reason isn't a date or a time",
      "flows.review.steps[5].ways[1].steps[0].assignee.field: kind doesn't name a person",
    ]);
  });

  it('runs on its own record only, and a process task runs a flow that runs in one go', () => {
    expect(
      issuesOf(
        leave((d) => {
          d.entities.team = { label: 'Team', pluralLabel: 'Teams', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }] };
          d.flows.team_check = { label: 'Team check', input: { team: { type: 'record', entity: 'team' } }, steps: [{ type: 'wait', for: { duration: 'P1D' } }] };
          d.flows.review = { label: 'Review', input: { leave: { type: 'record', entity: 'leave_request' } }, steps: [{ type: 'call', flow: 'team_check', input: { team: { ref: 'leave' } } }] };
        }),
      ),
    ).toEqual([
      'flows.review.steps[0].flow: Team check waits, and is about team: a flow that waits runs it on its own record only',
      'flows.review.steps[0].input.team: Give a record of team: a variable that holds one',
    ]);
    const legacy = structuredClone(LEAVE_PROCESS_APP) as unknown as Record<string, any>;
    legacy.flows = { later: { label: 'Later', input: { leave: { type: 'record', entity: 'leave_request' } }, steps: [{ type: 'wait', for: { duration: 'P1D' } }] } };
    legacy.processes.leave_approval.elements.noting = { type: 'serviceTask', name: 'Note it', flow: { flow: 'later', input: { leave: { ref: 'record' } } } };
    legacy.processes.leave_approval.flows.on_approve.to = 'noting';
    legacy.processes.leave_approval.flows.noted = { from: 'noting', to: 'approved' };
    legacy.flows.leave_approval = legacy.flows.later;
    expect(issuesOf(legacy)).toEqual([
      'processes.leave_approval.elements.noting.flow.flow: Later waits: a process task runs a flow that runs in one go',
      'flows.leave_approval: A process is also named leave_approval, and a flow that waits runs as one: rename one of them',
    ]);
  });

  it('lets a role start it by hand, and carries renames into its tasks and waits', () => {
    const first = valid(
      leave((d) => {
        d.roles.manager.flows = ['leave_approval'];
        d.flows.leave_approval.steps.push({ type: 'wait', for: { date: 'starts' } }, { type: 'wait', for: { condition: { gt: [{ ref: 'leave.days' }, 1] } } });
      }),
    );
    const { permissionSets } = compileAppPolicy('0193a7c4-0000-7000-8000-00000000abcd', first);
    expect(permissionSets.find((set) => set.id.endsWith('manager'))!.grants).toEqual(
      expect.arrayContaining([
        { permission: 'flow.run', resource: 'leave_approval' },
        { permission: 'process.start', resource: 'leave_approval' },
      ]),
    );
    const next = structuredClone(first) as unknown as Record<string, any>;
    const fields = next.entities.leave_request.fields as Array<{ name: string }>;
    fields.find((f) => f.name === 'manager')!.name = 'approver';
    fields.find((f) => f.name === 'starts')!.name = 'first_day';
    fields.find((f) => f.name === 'days')!.name = 'working_days';
    const renamed = valid(next, first);
    expect(renamed.flows!['leave_approval']!.steps).toEqual([
      expect.objectContaining({ type: 'task', assignee: { field: 'approver' } }),
      { type: 'wait', for: { date: 'first_day' } },
      { type: 'wait', for: { condition: { gt: [{ ref: 'leave.working_days' }, 1] } } },
    ]);
  });
});
