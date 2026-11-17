import { describe, expect, it } from 'vitest';
import {
  accessChanges,
  addDuration,
  capabilityChanges,
  decisionsBy,
  diffDefinitions,
  flowsOut,
  LEAVE_APP,
  lintDefinition,
  mergeDefinitions,
  processGraph,
  skillStepIssues,
  startsOf,
  timerFiresAt,
  validateDefinition,
  type Process,
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

/** The leave template, with its process changed by `edit`. */
function leave(edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined): Record<string, any> {
  const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
  edit(definition['processes'].leave_approval, definition);
  return definition;
}

describe('a process in BPMN 2.0', () => {
  it('passes the checks, and says what starts it and what completes its task', () => {
    const definition = valid(leave());
    expect(lintDefinition(definition)).toEqual([]);
    expect(startsOf(definition, 'request_leave')).toEqual([{ process: 'leave_approval', element: 'requested' }]);
    expect(decisionsBy(definition, 'reject_leave')).toEqual([{ process: 'leave_approval', element: 'decide', outcome: 'reject' }]);
    expect(decisionsBy(definition, 'request_leave')).toEqual([]);
  });

  it('takes the flow of the outcome a person chooses', () => {
    const process = valid(leave()).processes!['leave_approval']!;
    const graph = processGraph(process);
    const state = { record: {}, outcomes: {} };
    expect(flowsOut(process, graph, 'requested', state)).toEqual({ ok: true, flows: ['to_decide'] });
    expect(flowsOut(process, graph, 'decide', state, 'reject')).toEqual({ ok: true, flows: ['on_reject'] });
    expect(flowsOut(process, graph, 'decide', state, 'maybe')).toEqual({ ok: false, message: 'Decide on the leave: no flow leads on from the outcome maybe' });
    expect(flowsOut(process, graph, 'approved', state)).toEqual({ ok: true, flows: [] });
  });

  it('decides at an exclusive gateway by the record, in the order of its flows, or by its default', () => {
    const definition = valid(
      leave((process) => {
        process.elements.long = { type: 'exclusiveGateway', name: 'Long leave?' };
        process.elements.hr = { type: 'userTask', name: 'Check the cover', role: 'manager', outcomes: [{ name: 'done', label: 'Done' }] };
        process.flows.on_approve.to = 'long';
        process.flows.over_ten = { from: 'long', to: 'hr', name: 'Over 10 days', when: { gt: [{ ref: 'record.days' }, 10] } };
        process.flows.otherwise = { from: 'long', to: 'approved', default: true };
        process.flows.checked = { from: 'hr', to: 'approved' };
        delete process.diagram.edges.on_approve;
      }),
    );
    const process = definition.processes!['leave_approval']!;
    const graph = processGraph(process);
    expect(flowsOut(process, graph, 'long', { record: { days: 12 }, outcomes: {} })).toEqual({ ok: true, flows: ['over_ten'] });
    expect(flowsOut(process, graph, 'long', { record: { days: 2 }, outcomes: {} })).toEqual({ ok: true, flows: ['otherwise'] });
    const noDefault: Process = { ...process, flows: Object.fromEntries(Object.entries(process.flows).filter(([id]) => id !== 'otherwise')) };
    expect(flowsOut(noDefault, processGraph(noDefault), 'long', { record: { days: 2 }, outcomes: {} })).toEqual({
      ok: false,
      message: "Long leave?: no flow's condition holds, and it has no default flow",
    });
  });

  it('can decide by the outcome of an earlier task, as models from other tools do', () => {
    const definition = valid(
      leave((process) => {
        process.elements.which = { type: 'exclusiveGateway' };
        process.flows = {
          to_decide: { from: 'requested', to: 'decide' },
          to_which: { from: 'decide', to: 'which' },
          yes: { from: 'which', to: 'approved', when: { eq: [{ ref: 'tasks.decide.outcome' }, 'approve'] } },
          no: { from: 'which', to: 'rejected', default: true },
        };
        delete process.diagram;
      }),
    );
    const process = definition.processes!['leave_approval']!;
    expect(flowsOut(process, processGraph(process), 'which', { record: {}, outcomes: { decide: 'approve' } })).toEqual({ ok: true, flows: ['yes'] });
  });
});

describe('timers', () => {
  const at = new Date('2026-01-31T09:30:00.000Z');
  it('add ISO 8601 durations in UTC, months by the calendar', () => {
    expect(addDuration(at, 'P3D').toISOString()).toBe('2026-02-03T09:30:00.000Z');
    expect(addDuration(at, 'PT4H30M').toISOString()).toBe('2026-01-31T14:00:00.000Z');
    expect(addDuration(at, 'P1M').toISOString()).toBe('2026-02-28T09:30:00.000Z');
    expect(addDuration(at, 'P1Y1M1W1DT1H1M1S').toISOString()).toBe('2027-03-08T10:31:01.000Z');
    expect(() => addDuration(at, 'P')).toThrow();
  });

  it('fire on a date field at the start of its day, and not at all without one', () => {
    expect(timerFiresAt({ date: 'starts' }, at, { starts: '2026-12-21' })?.toISOString()).toBe('2026-12-21T00:00:00.000Z');
    expect(timerFiresAt({ date: 'starts' }, at, {})).toBeNull();
    expect(timerFiresAt({ duration: 'P2D' }, at, {})?.toISOString()).toBe('2026-02-02T09:30:00.000Z');
  });
});

describe('the checks of a process', () => {
  it('refuse flows and elements that BPMN 2.0 or Ambit cannot run', () => {
    expect(
      issuesOf(
        leave((process) => {
          process.flows.back = { from: 'approved', to: 'requested' };
          process.flows.to_ghost = { from: 'decide', to: 'ghost', outcome: 'approve' };
          process.flows.on_reject.when = { eq: [{ ref: 'record.status' }, 'submitted'] };
          process.elements.decide.outcomes.push({ name: 'later', label: 'Later' });
        }),
      ),
    ).toEqual([
      'processes.leave_approval.flows.on_reject: Only a flow out of an exclusive gateway has a condition or is its default',
      'processes.leave_approval.flows.back.from: Leave approved is an end event: no flow leaves it',
      'processes.leave_approval.flows.back.to: Leave requested is a start event: no flow leads into it',
      'processes.leave_approval.flows.to_ghost.to: No element ghost',
      'processes.leave_approval.elements.decide: Approve: one flow follows each outcome',
      'processes.leave_approval.elements.decide: Later leads nowhere: draw a flow for it',
    ]);
  });

  it('check that tasks name roles, people, actions and cards that fit', () => {
    expect(
      issuesOf(
        leave((process, definition) => {
          process.elements.decide.role = 'boss';
          process.elements.decide.assignee = { field: 'reason' };
          process.elements.decide.outcomes[1].action = 'request_leave';
          process.elements.decide.card = 'nowhere';
          process.elements.pay = { type: 'serviceTask', name: 'Pay', action: 'approve_leave', skill: 'hr/pay', input: { who: { ref: 'principal.id' } } };
          process.flows.to_pay = { from: 'requested', to: 'pay' };
          definition['roles'].employee.processes = ['nothing'];
        }),
      ),
    ).toEqual([
      'processes.leave_approval.elements.requested: Leave requested leads on by one flow: use a gateway to split the path',
      'processes.leave_approval.elements.decide.role: No role named boss',
      "processes.leave_approval.elements.decide.assignee.field: reason doesn't name a person",
      "processes.leave_approval.elements.decide.outcomes[1].action: request_leave creates a record; here an action changes the process's own record",
      'processes.leave_approval.elements.decide.card: No card named nowhere',
      'processes.leave_approval.elements.pay: Pay runs an action or starts an a7c skill: one of the two',
      "processes.leave_approval.elements.pay.input.who: principal.id: a process's skill input reads fields of the record",
      'processes.leave_approval.elements.pay: Pay leads on by one flow',
      'roles.employee.processes[0]: No process named nothing',
    ]);
    expect(issuesOf(leave((process, definition) => void (definition['roles'].manager.actions = ['approve_leave'])))).toEqual([
      "processes.leave_approval.elements.decide.outcomes[1].action: Manager can't run reject_leave, so nobody who may do the task could choose Reject",
    ]);
  });

  it('check conditions, timers, boundaries, reachability and the diagram', () => {
    expect(
      issuesOf(
        leave((process) => {
          process.elements.which = { type: 'exclusiveGateway' };
          process.elements.wait = { type: 'intermediateCatchEvent', timer: { date: 'reason' } };
          process.elements.late = { type: 'boundaryEvent', attachedTo: 'wait', timer: { duration: 'P1D' } };
          process.elements.island = { type: 'task', name: 'Island' };
          process.elements.island_end = { type: 'endEvent' };
          process.flows.on_approve.to = 'which';
          process.flows.mine = { from: 'which', to: 'wait', when: { eq: [{ ref: 'principal.id' }, 'x'] } };
          process.flows.odd = { from: 'which', to: 'approved', when: { eq: [{ ref: 'tasks.decide.outcome' }, 'maybe'] } };
          process.flows.bare = { from: 'which', to: 'rejected' };
          process.flows.waited = { from: 'wait', to: 'approved' };
          process.flows.too_late = { from: 'late', to: 'rejected' };
          process.flows.loop = { from: 'island', to: 'island_end' };
          process.flows.self = { from: 'island_end', to: 'island' };
          process.diagram.shapes.gone = { x: 0, y: 0, width: 10, height: 10 };
        }),
      ),
    ).toEqual([
      "processes.leave_approval.flows.mine.when: principal.id: a process's conditions can refer to the record and to its tasks' outcomes",
      'processes.leave_approval.flows.odd.when: tasks.decide.outcome is approve or reject, never "maybe"',
      'processes.leave_approval.flows.self.from: End event island_end is an end event: no flow leaves it',
      'processes.leave_approval.flows.bare: A flow out of Exclusive gateway which needs a condition, or must be its default',
      "processes.leave_approval.elements.wait.timer.date: reason isn't a date or a time",
      "processes.leave_approval.elements.late.attachedTo: Timer wait isn't a user task: a timer sits on a user task",
      "processes.leave_approval.elements.island: Island can't be reached from a start event",
      "processes.leave_approval.elements.island_end: End event island_end can't be reached from a start event",
      'processes.leave_approval.diagram.shapes.gone: No element gone',
    ]);
  });

  it('carry a rename of the entity or a field into the process', () => {
    const before = valid(leave());
    const renamed = structuredClone(before) as unknown as Record<string, any>;
    renamed['entities'].absence = renamed['entities'].leave_request;
    delete renamed['entities'].leave_request;
    renamed['entities'].absence.fields.find((field: { name: string }) => field.name === 'manager').name = 'line_manager';
    for (const section of ['rules', 'actions', 'queries', 'cards', 'forms']) {
      for (const artifact of Object.values(renamed[section]) as Array<{ entity: string }>) artifact.entity = 'absence';
    }
    for (const role of Object.values(renamed['roles']) as Array<{ entities: Record<string, unknown> }>) {
      role.entities['absence'] = role.entities['leave_request'];
      delete role.entities['leave_request'];
    }
    for (const page of Object.values(renamed['pages']) as Array<{ blocks: Array<{ entity?: string }> }>) for (const block of page.blocks) if (block.entity) block.entity = 'absence';
    const result = validateDefinition(renamed, before, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const process = result.definition.processes!['leave_approval']!;
    expect(process.entity).toBe('absence');
    expect(process.elements['decide']).toMatchObject({ assignee: { field: 'line_manager' } });
  });
});

describe('a process in review', () => {
  const head = valid(leave());
  const base = valid({ ...leave(), processes: undefined });

  it('says what starts a new process, and what it runs by itself', () => {
    expect(diffDefinitions(base, head)).toContainEqual({ section: 'processes', name: 'leave_approval', change: 'added', details: [] });
    expect(capabilityChanges(base, head)).toEqual([
      { tool: 'leave_approval', change: 'added', text: 'New process Leave approval, on Leave request: request_leave starts it' },
    ]);
    const paying = valid(
      leave((process) => {
        process.elements.pay = { type: 'serviceTask', name: 'Record it', action: 'approve_leave' };
        process.flows.on_approve.to = 'pay';
        process.flows.paid = { from: 'pay', to: 'approved' };
      }),
    );
    expect(capabilityChanges(head, paying).map((change) => change.text)).toEqual(['Leave approval now runs approve_leave by itself']);
  });

  it("ignores a change of layout, and names a change of the flow", () => {
    const moved = valid(leave((process) => void (process.diagram.shapes.decide.x = 300)));
    expect(capabilityChanges(head, moved)).toEqual([]);
    expect(diffDefinitions(head, moved)).toEqual([{ section: 'processes', name: 'leave_approval', change: 'changed', details: [] }]);
    const due = valid(leave((process) => void (process.elements.decide.due = 'P5D')));
    expect(capabilityChanges(head, due).map((change) => change.text)).toEqual(['The flow of Leave approval changed']);
  });

  it('shows who may start a process by hand in the permission diff', () => {
    const startable = valid(leave((_process, definition) => void (definition['roles'].employee.processes = ['leave_approval'])));
    expect(accessChanges(head, startable)).toEqual([{ role: 'employee', kind: 'gains', text: 'Employee can now start Leave approval' }]);
  });

  it('merges processes like any artifact, and adds none to a definition without them', () => {
    const merged = mergeDefinitions(base, head, base);
    expect(merged.ok && Object.keys((merged.definition['processes'] ?? {}) as object)).toEqual(['leave_approval']);
    const none = mergeDefinitions(base, base, base);
    expect(none.ok && 'processes' in none.definition).toBe(false);
  });

  it('refuses a skill in a process where no a7c is connected', () => {
    const skilled = valid(
      leave((process) => {
        process.elements.pay = { type: 'serviceTask', name: 'Tell payroll', skill: 'hr/record-leave', input: { days: { ref: 'record.days' } } };
        process.flows.on_approve.to = 'pay';
        process.flows.told = { from: 'pay', to: 'approved' };
      }),
    );
    expect(skillStepIssues(skilled)).toEqual([
      {
        path: 'processes.leave_approval.elements.pay',
        message: "Tell payroll: this installation doesn't connect a7c, so a process can't start an a7c skill. Leave the task out, or ask an admin to connect a7c",
      },
    ]);
  });
});
