import { describe, expect, it } from 'vitest';
import {
  accessChanges,
  adHocStarts,
  addDuration,
  automaticStarts,
  canRepeat,
  caughtSignals,
  capabilityChanges,
  decideVotes,
  decisionsBy,
  diffDefinitions,
  eventSubCatcher,
  eventSubsIn,
  flowsOut,
  insideOf,
  isAdHoc,
  isEventSub,
  linkTarget,
  LEAVE_APP,
  lintDefinition,
  messageActions,
  mergeDefinitions,
  plainStartOf,
  processGraph,
  processWork,
  reachable,
  scopeOf,
  sentMessages,
  signalStarts,
  startsOf,
  thrownSignals,
  timerFiresAt,
  validateDefinition,
  votesNeeded,
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

describe('inclusive gateways, messages and errors', () => {
  /** The leave app with withdrawal, a payroll update that can fail, and an inclusive gateway for who hears of it. */
  const more = (edit: (process: Record<string, any>) => void = () => undefined) =>
    leave((process, definition) => {
      definition['actions'].withdraw_leave = { label: 'Withdraw', description: 'Withdraw a leave request.', entity: 'leave_request', operation: 'update', input: [], set: { status: 'rejected' } };
      definition['actions'].tell_payroll = { label: 'Tell payroll', description: 'Mark the leave as known to payroll.', entity: 'leave_request', operation: 'update', input: [], set: { reason: 'Payroll knows' } };
      definition['roles'].employee.actions.push('withdraw_leave');
      process.elements.withdrawn = { type: 'boundaryEvent', name: 'Withdrawn', attachedTo: 'decide', message: { action: 'withdraw_leave' } };
      process.elements.gone = { type: 'endEvent', name: 'Withdrawn' };
      process.elements.who = { type: 'inclusiveGateway', name: 'Who hears?' };
      process.elements.payroll = { type: 'serviceTask', name: 'Tell payroll', action: 'tell_payroll' };
      process.elements.failed = { type: 'boundaryEvent', name: 'Payroll failed', attachedTo: 'payroll', error: true };
      process.elements.fix = { type: 'userTask', name: 'Tell payroll by hand', role: 'manager', outcomes: [{ name: 'done', label: 'Done' }] };
      process.elements.wait = { type: 'intermediateCatchEvent', name: 'Until withdrawn', message: { action: 'withdraw_leave' } };
      process.elements.joined = { type: 'inclusiveGateway' };
      process.flows.on_approve.to = 'who';
      process.flows.long = { from: 'who', to: 'payroll', when: { gt: [{ ref: 'record.days' }, 5] } };
      process.flows.always = { from: 'who', to: 'wait', when: { gte: [{ ref: 'record.days' }, 0] } };
      process.flows.paid = { from: 'payroll', to: 'joined' };
      process.flows.to_fix = { from: 'failed', to: 'fix' };
      process.flows.fixed = { from: 'fix', to: 'joined' };
      process.flows.waited = { from: 'wait', to: 'joined' };
      process.flows.done = { from: 'joined', to: 'approved' };
      process.flows.withdraw = { from: 'withdrawn', to: 'gone' };
      delete process.diagram;
      edit(process);
    });

  it('pass the checks, and an inclusive gateway takes every flow whose condition holds', () => {
    const definition = valid(more());
    const process = definition.processes!['leave_approval']!;
    expect(flowsOut(process, processGraph(process), 'who', { record: { days: 8 }, outcomes: {} })).toEqual({ ok: true, flows: ['long', 'always'] });
    expect(flowsOut(process, processGraph(process), 'who', { record: { days: 2 }, outcomes: {} })).toEqual({ ok: true, flows: ['always'] });
    expect(reachable(process, processGraph(process), 'decide')).toContain('gone');
    expect(messageActions(process)).toEqual(['withdraw_leave']);
  });

  it('are checked: one kind of event each, on the task that suits it', () => {
    expect(
      issuesOf(
        more((process) => {
          process.elements.failed.interrupting = false;
          process.elements.withdrawn.attachedTo = 'payroll';
          process.elements.wait.timer = { duration: 'P1D' };
          process.elements.also = { type: 'boundaryEvent', attachedTo: 'decide', message: { action: 'approve_leave' } };
          process.flows.also_out = { from: 'also', to: 'gone' };
        }),
      ),
    ).toEqual([
      "processes.leave_approval.elements.withdrawn.attachedTo: Tell payroll can't have a timer, a message, a condition or a signal on its boundary: they sit on a user task, a receive task, a sub-process or a call activity",
      'processes.leave_approval.elements.failed.interrupting: An error always ends what it sits on',
      'processes.leave_approval.elements.wait: Until withdrawn waits for a timer, a message, a condition or a signal, or is a link: one of these',
      "processes.leave_approval.elements.also.message.action: approve_leave decides Decide on the leave, so it can't also interrupt it",
    ]);
  });
});

/**
 * The leave app, where a review of approved leave runs in a sub-process. Inside it, the review
 * calls the team's cover plan, a process about the team the request refers to, and a second look
 * at the request itself.
 */
function nested(edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined): Record<string, any> {
  return leave((process, definition) => {
    definition['entities'].team = {
      label: 'Team',
      pluralLabel: 'Teams',
      titleField: 'name',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'lead', label: 'Lead', type: 'user' },
      ],
    };
    definition['entities'].leave_request.fields.push({ name: 'team', label: 'Team', type: 'reference', entity: 'team' });
    const simple = (label: string, entity: string, task: string) => ({
      label,
      entity,
      elements: {
        start: { type: 'startEvent' },
        task: { type: 'userTask', name: task, role: 'manager', outcomes: [{ name: 'done', label: 'Done' }] },
        end: { type: 'endEvent' },
      },
      flows: { into: { from: 'start', to: 'task' }, out: { from: 'task', to: 'end' } },
    });
    definition['processes'].cover_plan = simple('Cover plan', 'team', 'Plan the cover');
    definition['processes'].second_look = simple('Second look', 'leave_request', 'Look again');
    process.elements.review = { type: 'subProcess', name: 'Review' };
    process.elements.review_start = { type: 'startEvent', in: 'review' };
    process.elements.cover = { type: 'callActivity', name: 'Plan the cover', in: 'review', process: 'cover_plan', record: 'team' };
    process.elements.look = { type: 'callActivity', name: 'Look again', in: 'review', process: 'second_look' };
    process.elements.review_end = { type: 'endEvent', in: 'review' };
    process.elements.too_long = { type: 'boundaryEvent', name: 'Too long', attachedTo: 'review', timer: { duration: 'P5D' } };
    process.elements.review_failed = { type: 'boundaryEvent', attachedTo: 'review', error: true };
    process.flows.on_approve.to = 'review';
    process.flows.r1 = { from: 'review_start', to: 'cover' };
    process.flows.r2 = { from: 'cover', to: 'look' };
    process.flows.r3 = { from: 'look', to: 'review_end' };
    process.flows.reviewed = { from: 'review', to: 'approved' };
    process.flows.late = { from: 'too_long', to: 'approved' };
    process.flows.failed = { from: 'review_failed', to: 'approved' };
    delete process.diagram;
    edit(process, definition);
  });
}

describe('sub-processes and call activities', () => {
  it('pass the checks: a sub-process holds its own start and end, and a call runs on this record or on one it refers to', () => {
    const definition = valid(nested());
    const process = definition.processes!['leave_approval']!;
    expect(scopeOf(process, 'cover')).toBe('review');
    expect(scopeOf(process, 'too_long')).toBeUndefined();
    expect([...insideOf(process, 'review')].sort()).toEqual(['cover', 'look', 'review_end', 'review_start']);
    expect(processWork(process).calls).toEqual(['cover_plan', 'second_look']);
    // The start event inside the review starts nothing on its own.
    expect(startsOf(definition, 'request_leave')).toEqual([{ process: 'leave_approval', element: 'requested' }]);
    expect(plainStartOf(process)).toBe('requested');
    expect(plainStartOf(definition.processes!['cover_plan']!)).toBe('start');
  });

  it('are checked: what holds what, flows that cross the edge, and what a call runs on', () => {
    const issues = issuesOf(
      nested((process, definition) => {
        process.elements.review_start.actions = ['approve_leave'];
        process.elements.stray = { type: 'endEvent', in: 'decide' };
        process.flows.out_of_it = { from: 'review_start', to: 'rejected' };
        process.elements.look.record = 'manager';
        process.elements.wrong = { type: 'callActivity', name: 'Wrong record', in: 'review', process: 'cover_plan' };
        process.flows.r2.to = 'wrong';
        process.flows.r2b = { from: 'wrong', to: 'look' };
        process.elements.too_long.message = { action: 'approve_leave' };
        delete process.elements.too_long.timer;
        definition['processes'].second_look.elements.start.actions = ['request_leave'];
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        "processes.leave_approval.flows.out_of_it: A flow can't cross the edge of a sub-process: Start event review_start is in Review, and Leave rejected is in the process itself",
        "processes.leave_approval.elements.review_start: A start event inside a sub-process starts when the sub-process does: it names no action, timer, condition or signal",
        "processes.leave_approval.elements.stray.in: Decide on the leave isn't a sub-process: only a sub-process holds other elements",
        "processes.leave_approval.elements.look.record: manager doesn't refer to a record",
        'processes.leave_approval.elements.look.process: Second look has no start event without actions, where a call starts it',
        'processes.leave_approval.elements.wrong.record: Cover plan is about team: name the reference field whose record it runs on',
      ]),
    );
    expect(issuesOf(nested((process) => void (process.elements.too_long = { type: 'boundaryEvent', attachedTo: 'review', message: { action: 'withdraw' } })))).toEqual(
      expect.arrayContaining(['processes.leave_approval.elements.too_long.message.action: No action named withdraw']),
    );
  });

  it('are checked: a sub-process starts once and ends, and processes call no one in a ring', () => {
    expect(
      issuesOf(
        nested((process, definition) => {
          delete process.elements.review_end;
          delete process.flows.r3;
          process.flows.r3 = { from: 'look', to: 'review_start_2' };
          process.elements.review_start_2 = { type: 'startEvent', in: 'review' };
          definition['processes'].second_look.elements.again = { type: 'callActivity', name: 'Approve again', process: 'leave_approval' };
          definition['processes'].second_look.flows.out.to = 'again';
          definition['processes'].second_look.flows.on = { from: 'again', to: 'end' };
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'processes.leave_approval.elements.review: Review starts at one start event inside it',
        'processes.leave_approval.elements.review: Review needs an end event inside it',
        'processes.leave_approval.elements.look.process: Second look calls Leave approval in turn, so they would call each other without end',
        'processes.second_look.elements.again.process: Leave approval calls Second look in turn, so they would call each other without end',
      ]),
    );
    expect(issuesOf(nested((process) => void (process.elements.look.process = 'leave_approval')))).toEqual(
      expect.arrayContaining(["processes.leave_approval.elements.look.process: A process can't call itself"]),
    );
  });

  it('are named in a change request: what a process calls', () => {
    const before = valid(leave());
    const after = valid(nested());
    expect(capabilityChanges(before, after).map((change) => change.text)).toEqual([
      'Leave approval now calls cover_plan',
      'Leave approval now calls second_look',
      'New process Cover plan, on Team: another process calls it',
      'New process Second look, on Leave request: another process calls it',
    ]);
    expect(lintDefinition(after).filter((finding) => finding.startsWith('Nothing starts'))).toEqual([]);
  });
});

/**
 * The leave app with the other tasks and the simple events: a rule check first, a script that
 * flags long leave, a milestone, messages sent to payroll and to the team the request names, a
 * link, and a receive task that waits for the confirmation with a deadline.
 */
function tasks(edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined): Record<string, any> {
  return leave((process, definition) => {
    definition['entities'].team = {
      label: 'Team',
      pluralLabel: 'Teams',
      titleField: 'name',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text' },
      ],
    };
    definition['entities'].leave_request.fields.push({ name: 'team', label: 'Team', type: 'reference', entity: 'team' });
    const update = (entity: string, label: string, set: Record<string, string>) => ({ label, description: `${label}.`, entity, operation: 'update', input: [], set, confirm: 'none' });
    definition['actions'].tell_payroll = update('leave_request', 'Tell payroll', { reason: 'Payroll knows' });
    definition['actions'].confirm_leave = update('leave_request', 'Confirm the leave', { reason: 'Confirmed' });
    definition['actions'].note_team = update('team', 'Note the team', { note: 'Someone is away' });
    Object.assign(process.elements, {
      rules_check: { type: 'businessRuleTask', name: 'Check the rules', rules: ['long_leave'] },
      flag: { type: 'scriptTask', name: 'Flag long leave', steps: [{ type: 'set', field: 'reason', value: 'Long leave' }] },
      milestone: { type: 'intermediateThrowEvent', name: 'Approved' },
      tell: { type: 'sendTask', name: 'Tell payroll', message: { action: 'tell_payroll' } },
      team_note: { type: 'intermediateThrowEvent', name: 'Tell the team', message: { action: 'note_team', record: 'team' } },
      jump: { type: 'intermediateThrowEvent', link: 'finish' },
      land: { type: 'intermediateCatchEvent', link: 'finish' },
      confirm: { type: 'receiveTask', name: 'Wait for the confirmation', message: { action: 'confirm_leave' } },
      late: { type: 'boundaryEvent', attachedTo: 'confirm', timer: { duration: 'P2D' } },
    });
    process.elements.rejected.message = { action: 'tell_payroll' };
    process.flows.to_decide.to = 'rules_check';
    process.flows.on_approve.to = 'milestone';
    Object.assign(process.flows, {
      passed: { from: 'rules_check', to: 'decide', outcome: 'passed' },
      warned: { from: 'rules_check', to: 'flag', outcome: 'warned' },
      failed: { from: 'rules_check', to: 'rejected', outcome: 'failed' },
      flagged: { from: 'flag', to: 'decide' },
      m1: { from: 'milestone', to: 'tell' },
      m2: { from: 'tell', to: 'team_note' },
      m3: { from: 'team_note', to: 'jump' },
      m4: { from: 'land', to: 'confirm' },
      m5: { from: 'confirm', to: 'approved' },
      m6: { from: 'late', to: 'approved' },
    });
    delete process.diagram;
    edit(process, definition);
  });
}

describe('script, rule check, send and receive tasks, and simple events', () => {
  it('pass the checks, and a rule check chooses its flow by what it finds', () => {
    const definition = valid(tasks());
    const process = definition.processes!['leave_approval']!;
    const graph = processGraph(process);
    expect(flowsOut(process, graph, 'rules_check', { record: {}, outcomes: {} }, 'warned')).toEqual({ ok: true, flows: ['warned'] });
    expect(linkTarget(process, 'jump')).toBe('land');
    expect(reachable(process, graph, 'tell')).toContain('confirm');
    expect(messageActions(process)).toEqual(['confirm_leave']);
    expect(sentMessages(process)).toEqual([
      { element: 'rejected', action: 'tell_payroll' },
      { element: 'tell', action: 'tell_payroll' },
      { element: 'team_note', action: 'note_team', record: 'team' },
    ]);
    expect(processWork(process)).toMatchObject({ actions: ['tell_payroll', 'note_team'], scripts: ['Flag long leave'] });
  });

  it('are checked: what a script, a rule check, a message and a link may do', () => {
    const issues = issuesOf(
      tasks((process, definition) => {
        process.elements.flag.steps = [{ type: 'set', field: 'reason', value: { ref: 'principal.id' } }];
        process.elements.rules_check.rules = ['no_such_rule'];
        process.elements.tell.message = { action: 'note_team' };
        process.elements.team_note.message = { action: 'note_team', record: 'manager' };
        process.elements.confirm.message = { action: 'confirm_leave', record: 'team' };
        process.elements.jump.link = 'elsewhere';
        definition['rules'].other = { entity: 'team', assert: { exists: 'record.name' }, severity: 'warning', message: 'Name the team' };
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        "processes.leave_approval.elements.flag.steps: Flag long leave reads the person who runs it, but a process runs it with no person",
        'processes.leave_approval.elements.rules_check.rules[0]: No rule named no_such_rule',
        'processes.leave_approval.elements.tell.message.action: note_team works on team, not on leave_request',
        "processes.leave_approval.elements.team_note.message.record: manager doesn't refer to a record",
        'processes.leave_approval.elements.confirm.message.record: A process hears actions on its own record only',
        'processes.leave_approval.elements.jump.link: No catch link named elsewhere is where Event jump is',
      ]),
    );
    expect(issuesOf(tasks((process) => void (process.elements.flag.steps = [])))).toEqual(expect.arrayContaining(['processes.leave_approval.elements.flag.steps: Flag long leave needs a step']));
    expect(
      issuesOf(
        tasks((process) => {
          process.flows.into_land = { from: 'milestone', to: 'land' };
          process.elements.again = { type: 'intermediateCatchEvent', link: 'finish' };
          process.flows.again_out = { from: 'again', to: 'approved' };
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'processes.leave_approval.elements.land: Event land takes over from its throw link: no flow leads into it',
        'processes.leave_approval.elements.again.link: Another catch link here is already named finish',
      ]),
    );
  });

  it('carry a renamed reference field into a message, and a renamed field into a script', () => {
    const before = valid(tasks());
    const renamed = structuredClone(before) as unknown as Record<string, any>;
    const fields = renamed['entities'].leave_request.fields as Array<{ name: string }>;
    fields.find((field) => field.name === 'team')!.name = 'squad';
    fields.find((field) => field.name === 'reason')!.name = 'why';
    const result = validateDefinition(renamed, before, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const process = result.definition.processes!['leave_approval']!;
    expect(process.elements['team_note']).toMatchObject({ message: { action: 'note_team', record: 'squad' } });
    expect(process.elements['flag']).toMatchObject({ steps: [{ type: 'set', field: 'why', value: 'Long leave' }] });
  });
});

/**
 * The leave app with processes that start by themselves, and a wait for the first of several
 * events: a reminder on the first day of leave, a review when leave grows long, and, after the
 * decision, a wait for the confirmation, a withdrawal, long leave or two days.
 */
function waits(edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined): Record<string, any> {
  return leave((process, definition) => {
    const update = (label: string, set: Record<string, string>) => ({ label, description: `${label}.`, entity: 'leave_request', operation: 'update', input: [], set, confirm: 'none' });
    definition['actions'].confirm_leave = update('Confirm the leave', { reason: 'Confirmed' });
    definition['actions'].withdraw_leave = update('Withdraw the leave', { status: 'rejected' });
    const simple = (label: string, start: Record<string, unknown>) => ({
      label,
      entity: 'leave_request',
      elements: { start: { type: 'startEvent', ...start }, end: { type: 'endEvent' } },
      flows: { through: { from: 'start', to: 'end' } },
    });
    definition['processes'].first_day = simple('First day', { timer: { date: 'starts' } });
    definition['processes'].long_review = simple('Long review', { condition: { gt: [{ ref: 'record.days' }, 10] } });
    Object.assign(process.elements, {
      gate: { type: 'eventBasedGateway', name: 'What comes first?' },
      two_days: { type: 'intermediateCatchEvent', name: 'Two days', timer: { duration: 'P2D' } },
      withdrawn: { type: 'intermediateCatchEvent', name: 'Withdrawn', message: { action: 'withdraw_leave' } },
      long: { type: 'intermediateCatchEvent', name: 'Long now', condition: { gt: [{ ref: 'record.days' }, 10] } },
      confirm: { type: 'receiveTask', name: 'Confirmed', message: { action: 'confirm_leave' } },
      shorter: { type: 'boundaryEvent', attachedTo: 'decide', interrupting: false, condition: { lt: [{ ref: 'record.days' }, 2] } },
      note: { type: 'manualTask', name: 'Tell the team' },
    });
    process.flows.on_approve.to = 'gate';
    Object.assign(process.flows, {
      g1: { from: 'gate', to: 'two_days' },
      g2: { from: 'gate', to: 'withdrawn' },
      g3: { from: 'gate', to: 'long' },
      g4: { from: 'gate', to: 'confirm' },
      w1: { from: 'two_days', to: 'approved' },
      w2: { from: 'withdrawn', to: 'approved' },
      w3: { from: 'long', to: 'approved' },
      w4: { from: 'confirm', to: 'approved' },
      s1: { from: 'shorter', to: 'note' },
      s2: { from: 'note', to: 'approved' },
    });
    delete process.diagram;
    edit(process, definition);
  });
}

describe('conditions, event-based gateways and starts by themselves', () => {
  it('pass the checks, and name the starts that need no person', () => {
    const definition = valid(waits());
    expect(automaticStarts(definition, 'leave_request')).toEqual([
      { process: 'first_day', element: 'start', timer: { date: 'starts' } },
      { process: 'long_review', element: 'start', condition: { gt: [{ ref: 'record.days' }, 10] } },
    ]);
    expect(capabilityChanges(valid(leave()), definition).map((change) => change.text)).toEqual(
      expect.arrayContaining([
        "New process First day, on Leave request: it starts by itself on each record's starts",
        'New process Long review, on Leave request: it starts by itself when record.days > 10 comes to hold',
      ]),
    );
  });

  it('are checked: one way to start, events that wait after the gateway, and no task outcome before a start', () => {
    const issues = issuesOf(
      waits((process, definition) => {
        definition['processes'].first_day.elements.start.actions = ['request_leave'];
        definition['processes'].long_review.elements.start.condition = { eq: [{ ref: 'tasks.decide.outcome' }, 'approve'] };
        process.flows.g3.to = 'note';
        process.flows.extra = { from: 'requested', to: 'two_days' };
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'processes.first_day.elements.start: Start event start starts on actions, a timer, a condition or a signal: one of these',
        'processes.long_review.elements.start.condition: tasks.decide.outcome: the process has no user task decide',
        "processes.leave_approval.flows.g3: Tell the team doesn't wait: after What comes first? come events that wait for a timer, a message, a condition or a signal, or receive tasks",
        'processes.leave_approval.elements.two_days: Two days waits after What comes first? only: no other flow leads into it',
      ]),
    );
  });
});

/**
 * The leave app where approved leave books a room in a transaction, which a cancel end undoes;
 * a review that escalates to HR when it runs late; and a budget check that ends with an error code
 * that its sub-process catches.
 */
function raises(edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined): Record<string, any> {
  return leave((process, definition) => {
    const update = (label: string, set: Record<string, string>) => ({ label, description: `${label}.`, entity: 'leave_request', operation: 'update', input: [], set, confirm: 'none' });
    definition['actions'].book_room = update('Book a room', { reason: 'Room booked' });
    definition['actions'].free_room = update('Free the room', { reason: 'Room freed' });
    Object.assign(process.elements, {
      booking: { type: 'subProcess', name: 'Booking', transaction: true },
      b_start: { type: 'startEvent', in: 'booking' },
      book: { type: 'serviceTask', name: 'Book a room', in: 'booking', action: 'book_room', undo: 'free_room' },
      b_check: { type: 'exclusiveGateway', in: 'booking' },
      b_end: { type: 'endEvent', in: 'booking' },
      b_cancel: { type: 'endEvent', name: 'Too long', in: 'booking', cancel: true },
      cancelled: { type: 'boundaryEvent', attachedTo: 'booking', cancel: true },
      review: { type: 'subProcess', name: 'Review' },
      r_start: { type: 'startEvent', in: 'review' },
      late: { type: 'intermediateThrowEvent', name: 'Late', in: 'review', escalation: { code: 'late' } },
      r_end: { type: 'endEvent', in: 'review' },
      no_budget: { type: 'endEvent', name: 'No budget', in: 'review', error: { code: 'no_budget' } },
      r_gate: { type: 'exclusiveGateway', in: 'review' },
      heard: { type: 'boundaryEvent', attachedTo: 'review', interrupting: false, escalation: { code: 'late' } },
      broke: { type: 'boundaryEvent', attachedTo: 'review', error: { code: 'no_budget' } },
      undo_all: { type: 'intermediateThrowEvent', name: 'Undo', compensate: true },
      hr: { type: 'manualTask', name: 'Tell HR' },
    });
    process.flows.on_approve.to = 'booking';
    Object.assign(process.flows, {
      b1: { from: 'b_start', to: 'book' },
      b2: { from: 'book', to: 'b_check' },
      b3: { from: 'b_check', to: 'b_cancel', when: { gt: [{ ref: 'record.days' }, 10] } },
      b4: { from: 'b_check', to: 'b_end', default: true },
      after_booking: { from: 'booking', to: 'review' },
      after_cancel: { from: 'cancelled', to: 'approved' },
      r1: { from: 'r_start', to: 'r_gate' },
      r2: { from: 'r_gate', to: 'late', when: { gt: [{ ref: 'record.days' }, 5] } },
      r3: { from: 'r_gate', to: 'no_budget', when: { gt: [{ ref: 'record.days' }, 20] } },
      r4: { from: 'r_gate', to: 'r_end', default: true },
      r5: { from: 'late', to: 'r_end' },
      after_review: { from: 'review', to: 'approved' },
      to_hr: { from: 'heard', to: 'hr' },
      from_hr: { from: 'hr', to: 'approved' },
      to_undo: { from: 'broke', to: 'undo_all' },
      undone: { from: 'undo_all', to: 'rejected' },
    });
    delete process.diagram;
    edit(process, definition);
  });
}

describe('errors, escalations, undo and transactions', () => {
  it('pass the checks, and an undo action is something the process runs by itself', () => {
    const definition = valid(raises());
    expect(processWork(definition.processes!['leave_approval']!).actions).toEqual(['book_room', 'free_room']);
  });

  it('are checked: a cancel in a transaction with a way out, an error that something catches, an escalation on what holds work', () => {
    const issues = issuesOf(
      raises((process, definition) => {
        delete process.elements.cancelled;
        delete process.flows.after_cancel;
        process.elements.stray_cancel = { type: 'endEvent', in: 'review', cancel: true };
        process.flows.r6 = { from: 'r_gate', to: 'stray_cancel', when: { lt: [{ ref: 'record.days' }, 1] } };
        process.elements.broke.error = { code: 'other' };
        process.elements.on_task = { type: 'boundaryEvent', attachedTo: 'decide', escalation: true };
        process.flows.on_task_out = { from: 'on_task', to: 'rejected' };
        process.elements.book.undo = 'request_leave';
        process.elements.coded = { type: 'boundaryEvent', attachedTo: 'book', error: { code: 'full' } };
        process.flows.coded_out = { from: 'coded', to: 'b_end' };
        definition['actions'].free_room.entity = 'leave_request';
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'processes.leave_approval.elements.booking: Booking has a cancel end event inside it, but no cancel event on its boundary to leave by',
        'processes.leave_approval.elements.stray_cancel.cancel: A cancel end event sits in a transaction',
        'processes.leave_approval.elements.no_budget.error: Nothing catches the error that No budget raises: put it in a sub-process with an error event, or call this process from one with an error event on the call',
        "processes.leave_approval.elements.on_task.attachedTo: Decide on the leave can't hear an escalation: an escalation event sits on a sub-process or a call, for what escalates inside it",
        'processes.leave_approval.elements.book.undo: request_leave creates a record: an undo changes the record back',
        'processes.leave_approval.elements.coded.error: Boundary event coded catches only the error full, but a task that fails raises no code: leave the code out',
      ]),
    );
  });
});

describe('signals', () => {
  /** The leave app where closing the office takes the manager's task away, and a follow-up on each request starts when its leave closes. */
  const signalled = (edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined) =>
    leave((process, definition) => {
      Object.assign(process.elements, {
        closed: { type: 'boundaryEvent', name: 'Office closed', attachedTo: 'decide', signal: 'office_closed' },
        shut: { type: 'endEvent', name: 'Closed', signal: 'leave_closed' },
      });
      process.flows.on_closed = { from: 'closed', to: 'shut' };
      delete process.diagram;
      definition['processes'].follow_up = {
        label: 'Follow-up',
        entity: 'leave_request',
        elements: {
          start: { type: 'startEvent', signal: 'leave_closed' },
          wait: { type: 'intermediateCatchEvent', name: 'Until it opens', signal: 'office_open' },
          end: { type: 'endEvent' },
        },
        flows: { f1: { from: 'start', to: 'wait' }, f2: { from: 'wait', to: 'end' } },
      };
      edit(process, definition);
    });

  it('pass the checks where a process throws one, waits for one, or starts on one', () => {
    const definition = valid(signalled());
    expect(caughtSignals(definition.processes!['follow_up']!)).toEqual(['leave_closed', 'office_open']);
    expect(thrownSignals(definition.processes!['leave_approval']!)).toEqual(['leave_closed']);
    expect(signalStarts(definition, 'leave_closed', 'leave_request')).toEqual([{ process: 'follow_up', element: 'start' }]);
    expect(signalStarts(definition, 'leave_closed', 'team')).toEqual([]);
    expect(lintDefinition(definition)).toEqual([]);
  });

  it('are checked: a start has one trigger, and a signal waits on what waits', () => {
    const issues = issuesOf(
      signalled((process, definition) => {
        definition['processes'].follow_up.elements.start.timer = { duration: 'P1D' };
        process.elements.closed.attachedTo = 'requested';
      }),
    );
    expect(issues).toEqual([
      "processes.leave_approval.elements.closed.attachedTo: Leave requested can't have a timer, a message, a condition or a signal on its boundary: they sit on a user task, a receive task, a sub-process or a call activity",
      'processes.follow_up.elements.start: Start event start starts on actions, a timer, a condition or a signal: one of these',
    ]);
  });
});

describe('event sub-processes', () => {
  /**
   * The leave app where a withdrawal while the process runs ends it; where HR hears of a request
   * that waits five days, beside the rest; and where a rejection raises an error that an event
   * sub-process catches.
   */
  const withSubs = (edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined) =>
    leave((process, definition) => {
      definition['actions'].withdraw_leave = { label: 'Withdraw', description: 'Withdraw.', entity: 'leave_request', operation: 'update', input: [], set: { status: 'rejected' }, confirm: 'none' };
      Object.assign(process.elements, {
        withdrawn: { type: 'subProcess', name: 'If withdrawn', event: true },
        w_start: { type: 'startEvent', in: 'withdrawn', actions: ['withdraw_leave'] },
        w_end: { type: 'endEvent', name: 'Withdrawn', in: 'withdrawn' },
        late: { type: 'subProcess', name: 'If late', event: true },
        l_start: { type: 'startEvent', in: 'late', timer: { duration: 'P5D' }, interrupting: false },
        l_tell: { type: 'manualTask', name: 'Tell HR', in: 'late' },
        l_end: { type: 'endEvent', in: 'late' },
        failed: { type: 'subProcess', name: 'If refused', event: true },
        f_start: { type: 'startEvent', in: 'failed', error: { code: 'refused' } },
        f_end: { type: 'endEvent', name: 'Refused', in: 'failed' },
      });
      process.elements.rejected.error = { code: 'refused' };
      Object.assign(process.flows, {
        w1: { from: 'w_start', to: 'w_end' },
        l1: { from: 'l_start', to: 'l_tell' },
        l2: { from: 'l_tell', to: 'l_end' },
        f1: { from: 'f_start', to: 'f_end' },
      });
      delete process.diagram;
      edit(process, definition);
    });

  it('pass the checks, and catch what is raised beside them', () => {
    const definition = valid(withSubs());
    const process = definition.processes!['leave_approval']!;
    expect(eventSubsIn(process, undefined)).toEqual([
      { id: 'withdrawn', start: 'w_start' },
      { id: 'late', start: 'l_start' },
      { id: 'failed', start: 'f_start' },
    ]);
    expect(isEventSub(process, 'late')).toBe(true);
    expect(messageActions(process)).toContain('withdraw_leave');
    expect(eventSubCatcher(process, undefined, 'error', 'refused')).toEqual({ id: 'failed', start: 'f_start' });
    expect(eventSubCatcher(process, undefined, 'error', 'other')).toBeUndefined();
  });

  it('are checked: no flow in or out, one trigger, and errors only in an event sub-process', () => {
    const issues = issuesOf(
      withSubs((process) => {
        process.elements.w_start.actions = [];
        process.elements.l_start.timer = undefined;
        process.elements.l_start.error = true;
        process.elements.requested.escalation = true;
        process.flows.into = { from: 'w_end', to: 'late' };
      }),
    );
    expect(issues).toEqual([
      'processes.leave_approval.flows.into.from: Withdrawn is an end event: no flow leaves it',
      'processes.leave_approval.flows.into: A flow can\'t cross the edge of a sub-process: Withdrawn is in If withdrawn, and If late is in the process itself',
      'processes.leave_approval.elements.requested: Leave requested starts the process: only a start event in an event sub-process catches an error or an escalation, or lets the rest go on',
      'processes.leave_approval.elements.w_start: Start event w_start starts its event sub-process on an action, a timer, a condition, a signal, an error or an escalation: one of these',
      "processes.leave_approval.elements.late: If late starts on its start event's trigger: no flow leads into it or out of it",
      'processes.leave_approval.elements.l_start.interrupting: An error always ends what it comes from',
    ]);
  });
});

describe('ad hoc sub-processes', () => {
  /** The leave app where the manager checks the dates and the team in any order, and the checks end once the dates are done. */
  const adHoc = (edit: (process: Record<string, any>) => void = () => undefined) =>
    leave((process) => {
      Object.assign(process.elements, {
        checks: { type: 'subProcess', name: 'Checks', adHoc: true, completeWhen: { eq: [{ ref: 'tasks.dates.outcome' }, 'done'] } },
        dates: { type: 'userTask', name: 'Check the dates', in: 'checks', role: 'manager', outcomes: [{ name: 'done', label: 'Done' }] },
        team: { type: 'userTask', name: 'Check the team', in: 'checks', role: 'manager', outcomes: [{ name: 'done', label: 'Done' }] },
        note: { type: 'scriptTask', name: 'Note the checks', in: 'checks', steps: [{ type: 'set', field: 'reason', value: 'Checking' }] },
      });
      process.flows.to_decide.to = 'checks';
      process.flows.after_checks = { from: 'checks', to: 'decide' };
      delete process.diagram;
      edit(process);
    });

  it('pass the checks: what has no flow into it starts at once, and a path ends where none leads on', () => {
    const process = valid(adHoc()).processes!['leave_approval']!;
    expect(isAdHoc(process, 'checks')).toBe(true);
    expect(adHocStarts(process, processGraph(process), 'checks')).toEqual(['dates', 'team', 'note']);
  });

  it('are checked: no start or end inside, and a condition only on an ad hoc sub-process', () => {
    expect(issuesOf(adHoc((process) => (process.elements.stray = { type: 'endEvent', in: 'checks' })))).toEqual([
      'processes.leave_approval.elements.checks: Checks is ad hoc: it has no start or end event inside it',
    ]);
    expect(issuesOf(adHoc((process) => delete process.elements.checks.adHoc))).toEqual(
      expect.arrayContaining(["processes.leave_approval.elements.checks.completeWhen: Checks isn't ad hoc: only an ad hoc sub-process ends on a condition"]),
    );
  });
});

describe('complex gateways', () => {
  /** The leave app where two of three checks are enough to go on to the decision. */
  const complex = (edit: (process: Record<string, any>) => void = () => undefined) =>
    leave((process) => {
      Object.assign(process.elements, {
        split: { type: 'parallelGateway' },
        a: { type: 'manualTask', name: 'Check A' },
        b: { type: 'manualTask', name: 'Check B' },
        c: { type: 'manualTask', name: 'Check C' },
        enough: { type: 'complexGateway', name: 'Two checks', waitFor: 2 },
      });
      process.flows.to_decide.to = 'split';
      Object.assign(process.flows, {
        s1: { from: 'split', to: 'a' },
        s2: { from: 'split', to: 'b' },
        s3: { from: 'split', to: 'c' },
        j1: { from: 'a', to: 'enough' },
        j2: { from: 'b', to: 'enough' },
        j3: { from: 'c', to: 'enough' },
        out: { from: 'enough', to: 'decide' },
      });
      delete process.diagram;
      edit(process);
    });

  it('pass the checks, and take their flows out as an inclusive gateway does', () => {
    const process = valid(complex()).processes!['leave_approval']!;
    expect(flowsOut(process, processGraph(process), 'enough', { record: {}, outcomes: {} })).toEqual({ ok: true, flows: ['out'] });
  });

  it('are checked: they wait for no more paths than lead into them', () => {
    expect(issuesOf(complex((process) => (process.elements.enough.waitFor = 4)))).toEqual(['processes.leave_approval.elements.enough.waitFor: Two checks waits for 4 paths, but 3 lead into it']);
  });
});

describe('loops', () => {
  /**
   * The leave app where the manager decides again while they reject, twice at most; and where a
   * script notes long leave before each time, while it is long, three times at most.
   */
  const looping = (edit: (process: Record<string, any>) => void = () => undefined) =>
    leave((process) => {
      process.elements.decide.repeat = { while: { eq: [{ ref: 'tasks.decide.outcome' }, 'reject'] }, max: 2 };
      process.elements.note = {
        type: 'scriptTask',
        name: 'Note long leave',
        steps: [{ type: 'set', field: 'reason', value: 'Long' }],
        repeat: { while: { gt: [{ ref: 'record.days' }, 10] }, max: 3, before: true },
      };
      process.flows.to_decide.to = 'note';
      process.flows.noted = { from: 'note', to: 'decide' };
      delete process.diagram;
      edit(process);
    });

  it('pass the checks, and a rename of a field carries into their conditions', () => {
    const before = valid(looping());
    expect(canRepeat(before.processes!['leave_approval']!.elements['note'])).toBe(true);
    const renamed = structuredClone(before) as unknown as Record<string, any>;
    renamed['entities'].leave_request.fields.find((field: { name: string }) => field.name === 'days').name = 'working_days';
    const result = validateDefinition(renamed, before, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.definition.processes!['leave_approval']!.elements['note']).toMatchObject({ repeat: { while: { gt: [{ ref: 'record.working_days' }, 10] } } });
  });

  it('are checked: a task that leaves by its outcome checks after it runs, and votes repeat no task', () => {
    expect(
      issuesOf(
        looping((process) => {
          process.elements.decide.repeat.before = true;
        }),
      ),
    ).toEqual(['processes.leave_approval.elements.decide.repeat.before: Decide on the leave leaves by its outcome, so it checks whether to repeat after it runs, not before']);
    expect(
      issuesOf(
        looping((process) => {
          process.elements.decide.several = { people: { everyone: true }, decide: { first: true } };
        }),
      ),
    ).toEqual(expect.arrayContaining(['processes.leave_approval.elements.decide.repeat: Decide on the leave repeats, or several people decide it: one of the two']));
  });
});

describe('calls for each record', () => {
  /** The leave app where each day of a request gets a check of its own, by a process about the days. */
  const forEach = (edit: (process: Record<string, any>, definition: Record<string, any>) => void = () => undefined) =>
    leave((process, definition) => {
      definition['entities'].leave_day = {
        label: 'Leave day',
        pluralLabel: 'Leave days',
        fields: [
          { name: 'request', label: 'Request', type: 'reference', entity: 'leave_request', required: true },
          { name: 'day', label: 'Day', type: 'date' },
        ],
      };
      definition['processes'].day_check = {
        label: 'Day check',
        entity: 'leave_day',
        elements: { start: { type: 'startEvent' }, look: { type: 'manualTask', name: 'Look at the day' }, end: { type: 'endEvent' } },
        flows: { f1: { from: 'start', to: 'look' }, f2: { from: 'look', to: 'end' } },
      };
      process.elements.days = { type: 'callActivity', name: 'Check each day', process: 'day_check', each: { field: 'request' } };
      process.flows.to_decide.to = 'days';
      process.flows.checked = { from: 'days', to: 'decide' };
      delete process.diagram;
      edit(process, definition);
    });

  it('pass the checks, and a rename of the field carries into the call', () => {
    const before = valid(forEach());
    const renamed = structuredClone(before) as unknown as Record<string, any>;
    renamed['entities'].leave_day.fields.find((field: { name: string }) => field.name === 'request').name = 'leave';
    const result = validateDefinition(renamed, before, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.definition.processes!['leave_approval']!.elements['days']).toMatchObject({ each: { field: 'leave' } });
  });

  it('are checked: the field refers to this record, and the call runs on one record or for each', () => {
    expect(issuesOf(forEach((process) => (process.elements.days.each.field = 'day')))).toEqual([
      "processes.leave_approval.elements.days.each.field: day doesn't refer to leave_request: a call runs for each record that refers to this one",
    ]);
    expect(issuesOf(forEach((process) => (process.elements.days.record = 'manager')))).toEqual(
      expect.arrayContaining(['processes.leave_approval.elements.days: Check each day runs on the record a field names, or for each record that refers to this one: one of the two']),
    );
  });
});

describe('votes, when several people decide', () => {
  const all = { count: 'all', outcome: 'approve', otherwise: 'reject' } as const;
  it('decide as soon as the outcome is sure, either way', () => {
    expect(decideVotes(all, 3, ['approve', 'approve'])).toBeNull();
    expect(decideVotes(all, 3, ['approve', 'approve', 'approve'])).toBe('approve');
    // One rejection makes "everyone approves" impossible: it decides at once.
    expect(decideVotes(all, 3, ['approve', 'reject'])).toBe('reject');
    expect(decideVotes({ ...all, count: 'majority' }, 4, ['approve', 'reject', 'approve'])).toBeNull();
    expect(decideVotes({ ...all, count: 'majority' }, 4, ['approve', 'reject', 'approve', 'approve'])).toBe('approve');
    expect(decideVotes({ ...all, count: 2 }, 5, ['reject', 'reject', 'reject', 'approve'])).toBeNull();
    expect(decideVotes({ ...all, count: 2 }, 5, ['reject', 'reject', 'reject', 'reject'])).toBe('reject');
    expect(decideVotes({ first: true }, 3, [])).toBeNull();
    expect(decideVotes({ first: true }, 3, ['reject'])).toBe('reject');
    expect(votesNeeded({ ...all, count: 'majority' }, 5)).toBe(3);
  });

  it('are checked: voters that name people, outcomes the task has, and actions with no one person', () => {
    expect(
      issuesOf(
        leave((process) => {
          process.elements.decide.assignee = { field: 'manager' };
          process.elements.decide.several = { people: { fields: ['manager', 'reason'] }, decide: { count: 3, outcome: 'approve', otherwise: 'maybe' } };
        }),
      ),
    ).toEqual([
      'processes.leave_approval.elements.decide.assignee: Several people decide this task, so it has no one assignee',
      "processes.leave_approval.elements.decide.several.people.fields[1]: reason doesn't name a person",
      'processes.leave_approval.elements.decide.several.decide.otherwise: Decide on the leave has no outcome maybe',
      'processes.leave_approval.elements.decide.several.decide.count: 3 votes are needed, but only 2 people vote',
      "processes.leave_approval.elements.decide.outcomes[0].action: approve_leave reads the person who runs it, but when several people decide, it runs with no one person",
      "processes.leave_approval.elements.decide.outcomes[1].action: reject_leave reads the person who runs it, but when several people decide, it runs with no one person",
    ]);
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
      'processes.leave_approval.flows.on_reject: Only a flow out of an exclusive or inclusive gateway has a condition or is its default',
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
          process.elements.pay = { type: 'serviceTask', name: 'Pay', action: 'approve_leave' };
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
      'processes.leave_approval.elements.pay.action: approve_leave reads the person who runs it, but a service task runs it with no person',
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
      "processes.leave_approval.elements.late.attachedTo: Event wait can't have a timer, a message, a condition or a signal on its boundary: they sit on a user task, a receive task, a sub-process or a call activity",
      "processes.leave_approval.elements.island: Island can't be reached from a start event",
      "processes.leave_approval.elements.island_end: End event island_end can't be reached from a start event",
      'processes.leave_approval.diagram.shapes.gone: No element gone',
    ]);
  });

  it('route a task by the directory: the manager of whoever a field names, or the department', () => {
    const routed = leave((process) => {
      process.elements.decide.assignee = { managerOf: 'owner', levels: 2 };
      process.elements.decide.department = { of: 'owner' };
    });
    expect(issuesOf(routed)).toEqual([]);
    expect(
      issuesOf(
        leave((process) => {
          process.elements.decide.assignee = { managerOf: 'reason' };
          process.elements.decide.department = { of: 'days' };
        }),
      ),
    ).toEqual([
      "processes.leave_approval.elements.decide.assignee.managerOf: reason doesn't name a person",
      "processes.leave_approval.elements.decide.department.of: days doesn't name a person",
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

  it('carry a rename of the reference field that a call runs on', () => {
    const before = valid(nested());
    const renamed = structuredClone(before) as unknown as Record<string, any>;
    renamed['entities'].leave_request.fields.find((field: { name: string }) => field.name === 'team').name = 'squad';
    const result = validateDefinition(renamed, before, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.definition.processes!['leave_approval']!.elements['cover']).toMatchObject({ process: 'cover_plan', record: 'squad' });
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
      leave((process, definition) => {
        definition['actions'].mark_recorded = {
          label: 'Mark as recorded',
          description: 'Record that payroll knows of the leave.',
          entity: 'leave_request',
          operation: 'update',
          input: [],
          steps: [{ type: 'set', field: 'decided_on', value: { today: true } }],
        };
        definition['roles'].manager.actions.push('mark_recorded');
        process.elements.pay = { type: 'serviceTask', name: 'Record it', action: 'mark_recorded' };
        process.flows.on_approve.to = 'pay';
        process.flows.paid = { from: 'pay', to: 'approved' };
      }),
    );
    expect(capabilityChanges(head, paying).map((change) => change.text)).toEqual(['New tool mark_recorded: updates Leave request, and asks the person to confirm a preview', 'Leave approval now runs mark_recorded by itself']);
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
});
