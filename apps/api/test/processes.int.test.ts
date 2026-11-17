import { LEAVE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Business processes in BPMN 2.0 (design §6.10): an action starts one, a task waits in the inbox of
 * the person it names, and their decision, wherever they make it, moves the process on. A service
 * task acts by itself, a gateway decides by the record, a stuck instance waits for an operator, and
 * a deadline that passes takes a task away.
 */

let t: TestApp;
let alice: Session; // builds the leave app, and asks for leave
let bob: Session; // a manager
let carol: Session; // HR, who decides when a manager is late
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const json = async (options: InjectOptions, expected: number) => (await inject(options, expected)).json();

/** A leave app in Alice's personal space, from the template changed by `edit`, with Bob as a manager and Carol in HR. */
async function leaveApp(name: string, edit: (definition: Record<string, any>) => void = () => undefined): Promise<string> {
  const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
  definition['roles'].hr = {
    label: 'HR',
    description: 'Decides on leave when a manager is late.',
    entities: { leave_request: { read: true, update: { where: { eq: [{ ref: 'record.status' }, 'submitted'] }, fields: { include: ['status', 'decided_on'] } } } },
    actions: ['approve_leave', 'reject_leave'],
  };
  edit(definition);
  const started = await json({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name, bundle: definition } }, 201);
  for (const [subject, role] of [['bob', 'manager'], ['carol', 'hr']] as const) {
    await inject({ method: 'POST', url: `/v1/apps/${started.app.id}/shares`, ...as(alice), payload: { email: `${subject}@example.com`, role } }, 201);
  }
  return started.app.id;
}

const ask = (app: string, values: Record<string, unknown> = {}) =>
  json(
    {
      method: 'POST',
      url: `/v1/apps/${app}/actions/request_leave/run`,
      ...as(alice),
      payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: bob.userId, ...values } },
    },
    201,
  );
const inbox = async (session: Session, status: 'open' | 'closed' = 'open') => (await json({ method: 'GET', url: `/v1/me/tasks?status=${status}`, ...as(session) }, 200)).tasks;
const processesOf = async (app: string, recordId: string) =>
  (await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${recordId}/processes`, ...as(alice) }, 200)).instances;
const complete = (session: Session, taskId: string, outcome: string, expected = 200) =>
  json({ method: 'POST', url: `/v1/tasks/${taskId}/complete`, ...as(session), payload: { outcome } }, expected);

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
  appId = await leaveApp('Leave');
});

afterAll(async () => {
  await t?.close();
});

describe('a process that an action starts', () => {
  it("puts its task in the inbox of the manager it names, whose decision moves it on", async () => {
    const asked = await ask(appId);
    const [task, ...others] = await inbox(bob);
    expect(others).toEqual([]);
    expect(task).toMatchObject({
      name: 'Decide on the leave',
      status: 'open',
      app: { id: appId, name: 'Leave' },
      process: 'leave_approval',
      recordId: asked.record.id,
      role: 'manager',
      assignee: { id: bob.userId },
      outcomes: [
        { name: 'approve', label: 'Approve', action: 'approve_leave' },
        { name: 'reject', label: 'Reject', action: 'reject_leave' },
      ],
      card: 'leave_review',
      overdue: false,
    });
    expect(Date.parse(task.due) - Date.now()).toBeGreaterThan(3 * 86_400_000 - 60_000);
    expect(await inbox(carol)).toEqual([]);

    // The record shows where its process waits.
    const [instance] = await processesOf(appId, asked.record.id);
    expect(instance).toMatchObject({ label: 'Leave approval', status: 'running', startedBy: alice.userId, startedByAction: 'request_leave', waiting: [{ element: 'decide', name: 'Decide on the leave' }] });

    // Alice may change her own request, but the decision waits for Bob.
    const refused = await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/approve_leave/run`, ...as(alice), payload: { recordId: asked.record.id } }, 403);
    expect(refused.json()).toMatchObject({ error: 'task_assigned', message: expect.stringMatching(/^Decide on the leave waits for /) });

    // Bob decides in his inbox: the outcome runs approve_leave, as Bob.
    const done = await complete(bob, task.id, 'approve');
    expect(done).toMatchObject({
      task: { status: 'completed', outcome: 'approve', completedBy: bob.userId },
      result: { status: 'done', record: { values: { status: 'approved', decided_on: new Date().toISOString().slice(0, 10) } } },
    });
    expect(await inbox(bob)).toEqual([]);
    expect((await inbox(bob, 'closed')).map((closed: { name: string; outcome: string }) => [closed.name, closed.outcome])).toEqual([['Decide on the leave', 'approve']]);

    const detail = await json({ method: 'GET', url: `/v1/apps/${appId}/process-instances/${instance.id}`, ...as(alice) }, 200);
    expect(detail).toMatchObject({ status: 'completed', waiting: [], stuck: [] });
    expect(detail.events.map((event: { kind: string; element: string | null }) => [event.kind, event.element])).toEqual([
      ['started', 'requested'],
      ['task_opened', 'decide'],
      ['task_completed', 'decide'],
      ['ended', 'approved'],
    ]);
    const audited = (await t.ctx.db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.appId, appId))).map((row) => row.action);
    expect(audited).toEqual(expect.arrayContaining(['process.start', 'process.task.assign', 'process.task.complete', 'process.end']));
  });

  it('completes the task when its outcome\'s action runs anywhere else, such as a row button', async () => {
    const asked = await ask(appId, { starts: '2027-01-04', ends: '2027-01-05', days: 2 });
    await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/reject_leave/run`, ...as(bob), payload: { recordId: asked.record.id } }, 200);
    expect(await inbox(bob)).toEqual([]);
    const [instance] = await processesOf(appId, asked.record.id);
    expect(instance).toMatchObject({ status: 'completed', tasks: [{ status: 'completed', outcome: 'reject', completedBy: bob.userId }] });
    expect(instance.events.at(-1)).toMatchObject({ kind: 'ended', element: 'rejected', name: 'Leave rejected' });
  });

  it('runs once at a time on a record, and starts by hand for those whose role may start it', async () => {
    const asked = await ask(appId, { starts: '2027-02-01', ends: '2027-02-01', days: 1 });
    const start = (session: Session, expected: number) =>
      inject({ method: 'POST', url: `/v1/apps/${appId}/processes/leave_approval/start`, ...as(session), payload: { recordId: asked.record.id } }, expected);
    expect((await start(alice, 409)).json()).toMatchObject({ error: 'process_running', message: 'Leave approval already runs for this record' });
    const [task] = (await inbox(bob)).filter((open: { recordId: string }) => open.recordId === asked.record.id);
    await complete(bob, task.id, 'approve');
    // Bob's role doesn't let him start it; Alice, who owns the app, may.
    await start(bob, 403);
    const again = (await start(alice, 201)).json();
    expect(again).toMatchObject({ status: 'running', startedByAction: null, waiting: [{ element: 'decide' }] });
    const cancelled = await json({ method: 'POST', url: `/v1/apps/${appId}/process-instances/${again.id}/cancel`, ...as(alice) }, 200);
    expect(cancelled).toMatchObject({ status: 'cancelled', waiting: [] });
    expect((await inbox(bob)).filter((open: { recordId: string }) => open.recordId === asked.record.id)).toEqual([]);
  });

  it("completes the task once the person approves their agent's proposal", async () => {
    const asked = await ask(appId, { starts: '2027-03-01', ends: '2027-03-02', days: 2 });
    const [task] = (await inbox(bob)).filter((open: { recordId: string }) => open.recordId === asked.record.id);
    const token = (await json({ method: 'POST', url: '/v1/me/tokens', ...as(bob), payload: { name: 'agent', scopes: ['app.run', 'action.run', 'query.run'], expiresInDays: 1 } }, 201)).token;
    const rpc = async (method: string, params: Record<string, unknown> = {}) =>
      (await json({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method, params } }, 200)).result;
    // Bob's agent finds the task among his, and completes it as he decides: that makes a proposal.
    const listed = (await rpc('tools/call', { name: 'my_tasks', arguments: {} })).structuredContent.tasks;
    expect(listed.map((open: { id: string }) => open.id)).toContain(task.id);
    const proposed = (await rpc('tools/call', { name: 'complete_task', arguments: { task_id: task.id, outcome: 'approve' } })).structuredContent;
    expect(proposed).toMatchObject({ task: { status: 'open' }, result: { status: 'needs_confirmation' } });
    await inject({ method: 'POST', url: `/v1/proposals/${proposed.result.proposal.id}/approve`, ...as(bob), payload: { digest: proposed.result.proposal.digest } }, 200);
    const [instance] = await processesOf(appId, asked.record.id);
    expect(instance).toMatchObject({ status: 'completed', tasks: [{ status: 'completed', outcome: 'approve', completedBy: bob.userId }] });
  });
});

describe('a process that works by itself', () => {
  it('approves short leave with a service task, decides by the record, and waits for an operator where it gets stuck', async () => {
    const fast = await leaveApp('Leave, fast', (definition) => {
      definition['actions'].approve_short = {
        label: 'Approve short leave',
        description: 'Approve leave of two days or less, which needs no manager.',
        entity: 'leave_request',
        operation: 'update',
        input: [],
        set: { status: 'approved' },
        where: { eq: [{ ref: 'record.status' }, 'submitted'] },
        steps: [{ type: 'set', field: 'decided_on', value: { today: true } }],
      };
      definition['roles'].manager.actions.push('approve_short');
      const process = definition['processes'].leave_approval;
      process.elements.how_long = { type: 'exclusiveGateway', name: 'How long?' };
      process.elements.auto = { type: 'serviceTask', name: 'Approve it', action: 'approve_short' };
      process.flows.to_decide = { from: 'requested', to: 'how_long' };
      process.flows.long = { from: 'how_long', to: 'decide', name: 'Over 10 days', when: { gt: [{ ref: 'record.days' }, 10] } };
      process.flows.short = { from: 'how_long', to: 'auto', name: 'Two days or less', when: { lte: [{ ref: 'record.days' }, 2] } };
      process.flows.auto_done = { from: 'auto', to: 'approved' };
      delete process.diagram;
    });

    // Two days: the process approves it in the same transaction as the request.
    const short = await ask(fast, { days: 2 });
    expect(short.record.values).toMatchObject({ status: 'approved' });
    const [done] = await processesOf(fast, short.record.id);
    expect(done.events.map((event: { kind: string; element: string | null }) => [event.kind, event.element])).toEqual([
      ['started', 'requested'],
      ['ran', 'auto'],
      ['ended', 'approved'],
    ]);
    const history = await json({ method: 'GET', url: `/v1/apps/${fast}/entities/leave_request/records/${short.record.id}/history`, ...as(alice) }, 200);
    expect(JSON.stringify(history)).toContain('process');

    // Five days: no flow's condition holds, so the instance waits at the gateway for an operator.
    const middle = await ask(fast, { days: 5 });
    const stuck = (await json({ method: 'GET', url: `/v1/apps/${fast}/process-instances?stuck=true`, ...as(alice) }, 200)).instances;
    expect(stuck).toMatchObject([{ recordId: middle.record.id, status: 'running', stuck: [{ element: 'how_long', name: 'How long?', error: "How long?: no flow's condition holds, and it has no default flow" }] }]);
    await inject({ method: 'GET', url: `/v1/apps/${fast}/process-instances`, ...as(bob) }, 403);

    // Alice corrects the request and tries it again: it goes on to Bob.
    await inject({ method: 'PATCH', url: `/v1/apps/${fast}/entities/leave_request/records/${middle.record.id}`, ...as(alice), payload: { values: { days: 12 } } }, 200);
    const retried = await json({ method: 'POST', url: `/v1/apps/${fast}/process-instances/${stuck[0].id}/retry`, ...as(alice) }, 200);
    expect(retried).toMatchObject({ stuck: [], waiting: [{ element: 'decide', name: 'Decide on the leave' }] });
    expect((await inbox(bob)).map((task: { recordId: string }) => task.recordId)).toContain(middle.record.id);
  });
});

describe('BPMN 2.0 files', () => {
  it('carry a process from one app to another, and refuse what Ambit cannot run', async () => {
    const exported = await inject({ method: 'GET', url: `/v1/apps/${appId}/processes/leave_approval/bpmn`, ...as(alice) }, 200);
    expect(exported.headers['content-type']).toMatch(/^application\/xml/);
    expect(exported.headers['content-disposition']).toBe('attachment; filename="leave_approval.bpmn"');
    expect(exported.body).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<bpmn:definitions /);
    await inject({ method: 'GET', url: `/v1/apps/${appId}/processes/leave_approval/bpmn`, ...as(bob) }, 403);

    // An app without the process takes it in from the file, as it was.
    const bare = await leaveApp('Leave, imported', (definition) => void delete definition['processes']);
    const imported = await json({ method: 'POST', url: `/v1/apps/${bare}/processes/import`, ...as(alice), payload: { xml: exported.body } }, 200);
    expect(imported).toMatchObject({ processes: ['leave_approval'], notes: [] });
    const [source, copy] = await Promise.all(
      [appId, bare].map(async (id) => (await json({ method: 'GET', url: `/v1/apps/${id}/definition`, ...as(alice) }, 200)).definition.processes.leave_approval),
    );
    expect(copy).toEqual(source);

    const script = exported.body.replace('<bpmn:task ', '<bpmn:task ').replace(/<bpmn:userTask id="decide"[^>]*>/, '<bpmn:scriptTask id="decide" name="Compute">').replace('</bpmn:userTask>', '</bpmn:scriptTask>');
    const refused = await inject({ method: 'POST', url: `/v1/apps/${bare}/processes/import`, ...as(alice), payload: { xml: script, as: 'leave_approval' } }, 422);
    expect(refused.json()).toMatchObject({ error: 'invalid_bpmn', details: { issues: [{ path: 'bpmn.decide', message: 'Ambit doesn\'t run a script task yet: "Compute" (decide)' }] } });
  });
});

describe('routing from the directory', () => {
  it("sends a task to the requester's manager, up the line, to their cover, or to a department", async () => {
    const [dave, erin] = [await t.login('dave'), await t.login('erin')];
    const directory = (person: Session, body: Record<string, unknown>) =>
      inject({ method: 'PATCH', url: `/v1/people/${person.userId}/directory`, ...as(alice), payload: body }, 200);
    // Alice reports to Bob, who reports to Erin. Alice and Carol work in Sales, Dave in Finance.
    await directory(alice, { managerId: bob.userId, department: 'Sales' });
    await directory(bob, { managerId: erin.userId });
    await directory(carol, { department: 'Sales' });
    await directory(dave, { department: 'Finance' });
    // A loop in the reporting line is refused, and only directory admins set it.
    expect((await inject({ method: 'PATCH', url: `/v1/people/${erin.userId}/directory`, ...as(alice), payload: { managerId: alice.userId } }, 422)).json().error).toBe('reporting_loop');
    await inject({ method: 'PATCH', url: `/v1/people/${carol.userId}/directory`, ...as(bob), payload: { department: 'Finance' } }, 403);

    const routed = await leaveApp('Leave, by the directory', (definition) => {
      const process = definition['processes'].leave_approval;
      // The requester's manager decides; then the manager's manager, for long leave; then HR in the requester's department.
      process.elements.decide.assignee = { managerOf: 'owner' };
      process.elements.second = { type: 'userTask', name: 'Second approval', role: 'manager', assignee: { managerOf: 'owner', levels: 2 }, outcomes: [{ name: 'done', label: 'Done' }] };
      process.elements.file = { type: 'userTask', name: 'File it', role: 'hr', department: { of: 'owner' }, outcomes: [{ name: 'done', label: 'Done' }] };
      process.flows.on_approve.to = 'second';
      process.flows.seconded = { from: 'second', to: 'file' };
      process.flows.filed = { from: 'file', to: 'approved' };
      delete process.diagram;
    });
    for (const [subject, role] of [['erin', 'manager'], ['dave', 'hr'], ['carol', 'manager']] as const) {
      await inject({ method: 'POST', url: `/v1/apps/${routed}/shares`, ...as(alice), payload: { email: `${subject}@example.com`, role } }, 201);
    }
    const tasksOf = async (session: Session) => (await inbox(session)).filter((task: { app: { id: string } }) => task.app.id === routed);

    // The form names Carol as the manager, but the process asks the directory: Bob.
    const asked = await ask(routed, { manager: carol.userId });
    const [first] = await tasksOf(bob);
    expect(first).toMatchObject({ name: 'Decide on the leave', assignee: { id: bob.userId } });
    expect(await tasksOf(carol)).toEqual([]);

    // Bob hands it to Carol, who holds the role too; not to Dave, who doesn't.
    expect((await inject({ method: 'POST', url: `/v1/tasks/${first.id}/reassign`, ...as(bob), payload: { userId: dave.userId } }, 422)).json().error).toBe('not_in_role');
    await json({ method: 'POST', url: `/v1/tasks/${first.id}/reassign`, ...as(bob), payload: { userId: carol.userId } }, 200);
    expect(await tasksOf(bob)).toEqual([]);
    await complete(carol, first.id, 'approve');

    // Two levels up: Erin.
    const [second] = await tasksOf(erin);
    expect(second).toMatchObject({ name: 'Second approval', recordId: asked.record.id });
    await complete(erin, second.id, 'done');

    // HR in Alice's department: Carol sees it and takes it; Dave, in Finance, neither sees nor decides it.
    expect(await tasksOf(dave)).toEqual([]);
    const [filing] = await tasksOf(carol);
    expect(filing).toMatchObject({ name: 'File it', assignee: null });
    expect((await inject({ method: 'POST', url: `/v1/tasks/${filing.id}/complete`, ...as(dave), payload: { outcome: 'done' } }, 403)).json().error).toBe('task_department');
    expect(await json({ method: 'POST', url: `/v1/tasks/${filing.id}/claim`, ...as(carol) }, 200)).toMatchObject({ assignee: { id: carol.userId } });
    await complete(carol, filing.id, 'done');
    expect((await processesOf(routed, asked.record.id))[0]).toMatchObject({ status: 'completed' });

    // While Bob is away, Carol covers for him: the next request goes to her.
    await inject({ method: 'PUT', url: '/v1/me/cover', ...as(bob), payload: { coverId: carol.userId, until: new Date(Date.now() + 7 * 86_400_000).toISOString() } }, 200);
    const covered = await ask(routed, { starts: '2027-04-01', ends: '2027-04-01', days: 1 });
    const [cover] = (await tasksOf(carol)).filter((task: { recordId: string }) => task.recordId === covered.record.id);
    expect(cover).toMatchObject({ name: 'Decide on the leave', assignee: { id: carol.userId } });
    const [instance] = await processesOf(routed, covered.record.id);
    expect(instance.events.find((event: { kind: string }) => event.kind === 'task_opened').detail).toMatchObject({ assignee: carol.userId, covering: bob.userId });
    await inject({ method: 'PUT', url: '/v1/me/cover', ...as(bob), payload: { coverId: null } }, 200);
    await inject({ method: 'POST', url: `/v1/apps/${routed}/process-instances/${instance.id}/cancel`, ...as(alice) }, 200);
  });
});

describe('several people deciding', () => {
  /** A leave app whose decision is a vote: its outcomes' actions read no one person. */
  const votingApp = (name: string, several: Record<string, unknown>) =>
    leaveApp(name, (definition) => {
      for (const [action, status] of [['mark_approved', 'approved'], ['mark_rejected', 'rejected']] as const) {
        definition['actions'][action] = {
          label: `Mark as ${status}`,
          description: `Record that the leave is ${status}.`,
          entity: 'leave_request',
          operation: 'update',
          input: [],
          set: { status },
          where: { eq: [{ ref: 'record.status' }, 'submitted'] },
          steps: [{ type: 'set', field: 'decided_on', value: { today: true } }],
        };
      }
      definition['roles'].manager.actions.push('mark_approved', 'mark_rejected');
      const decide = definition['processes'].leave_approval.elements.decide;
      delete decide.assignee;
      decide.outcomes = [
        { name: 'approve', label: 'Approve', action: 'mark_approved' },
        { name: 'reject', label: 'Reject', action: 'mark_rejected' },
      ];
      decide.several = several;
    });
  const votesOn = async (session: Session, recordId: string) => (await inbox(session)).filter((task: { recordId: string }) => task.recordId === recordId);

  it('lets everyone with the role vote, and one rejection rejects when all must approve', async () => {
    const app = await votingApp('Leave, by everyone', { people: { everyone: true }, decide: { count: 'all', outcome: 'approve', otherwise: 'reject' } });
    await inject({ method: 'POST', url: `/v1/apps/${app}/shares`, ...as(alice), payload: { email: 'carol@example.com', role: 'manager' } }, 201);
    const asked = await ask(app, { starts: '2027-05-03', ends: '2027-05-04', days: 2 });
    const [bobs] = await votesOn(bob, asked.record.id);
    const [carols] = await votesOn(carol, asked.record.id);
    expect(bobs).toMatchObject({ name: 'Decide on the leave', several: true, voters: 2, assignee: { id: bob.userId } });
    expect(carols).toMatchObject({ several: true, voters: 2, assignee: { id: carol.userId } });

    await complete(bob, bobs.id, 'approve');
    expect(await votesOn(bob, asked.record.id)).toEqual([]);
    expect((await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${asked.record.id}`, ...as(alice) }, 200)).values.status).toBe('submitted');
    // The decision is the votes': nobody runs its action around them, and an agent can't vote.
    expect((await inject({ method: 'POST', url: `/v1/apps/${app}/actions/mark_approved/run`, ...as(alice), payload: { recordId: asked.record.id } }, 403)).json().error).toBe('votes_pending');
    const token = (await json({ method: 'POST', url: '/v1/me/tokens', ...as(carol), payload: { name: 'agent', scopes: ['app.run', 'action.run'], expiresInDays: 1 } }, 201)).token;
    expect((await inject({ method: 'POST', url: `/v1/tasks/${carols.id}/complete`, headers: { authorization: `Bearer ${token}` }, payload: { outcome: 'approve' } }, 403)).json().error).toBe('person_only');

    await complete(carol, carols.id, 'reject');
    expect((await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${asked.record.id}`, ...as(alice) }, 200)).values.status).toBe('rejected');
    const [instance] = await processesOf(app, asked.record.id);
    expect(instance.status).toBe('completed');
    expect(instance.events.map((event: { kind: string; element: string | null }) => [event.kind, event.element])).toEqual([
      ['started', 'requested'],
      ['task_opened', 'decide'],
      ['task_opened', 'decide'],
      ['voted', 'decide'],
      ['voted', 'decide'],
      ['ran', 'decide'],
      ['task_completed', 'decide'],
      ['ended', 'rejected'],
    ]);
  });

  it('asks up the reporting line one after another, until the line agrees', async () => {
    const erin = await t.login('erin');
    const app = await votingApp('Leave, up the line', { people: { lineOf: 'owner', levels: 2 }, sequential: true, decide: { count: 'all', outcome: 'approve', otherwise: 'reject' } });
    await inject({ method: 'POST', url: `/v1/apps/${app}/shares`, ...as(alice), payload: { email: 'erin@example.com', role: 'manager' } }, 201);
    // Alice reports to Bob, who reports to Erin (set by the routing test): Bob first, then Erin.
    const asked = await ask(app, { starts: '2027-06-07', ends: '2027-06-08', days: 2 });
    expect(await votesOn(erin, asked.record.id)).toEqual([]);
    const [first] = await votesOn(bob, asked.record.id);
    expect(first).toMatchObject({ several: true, voters: 2 });
    await complete(bob, first.id, 'approve');
    const [second] = await votesOn(erin, asked.record.id);
    expect(second).toMatchObject({ name: 'Decide on the leave', assignee: { id: erin.userId } });
    await complete(erin, second.id, 'approve');
    expect((await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${asked.record.id}`, ...as(alice) }, 200)).values.status).toBe('approved');
    expect((await processesOf(app, asked.record.id))[0]).toMatchObject({ status: 'completed' });
  });
});

describe('inclusive gateways, messages and errors', () => {
  /** The leave app with a withdrawal, and a payroll update that applies to approved leave only. */
  const withMore = (definition: Record<string, any>) => {
    definition['actions'].withdraw_leave = {
      label: 'Withdraw the leave',
      description: 'Withdraw a leave request that waits for a decision.',
      entity: 'leave_request',
      operation: 'update',
      input: [],
      set: { status: 'rejected' },
      where: { eq: [{ ref: 'record.status' }, 'submitted'] },
    };
    definition['actions'].tell_payroll = {
      label: 'Tell payroll',
      description: 'Record that payroll knows of approved leave.',
      entity: 'leave_request',
      operation: 'update',
      input: [],
      set: { reason: 'Payroll knows' },
      where: { eq: [{ ref: 'record.status' }, 'approved'] },
    };
    definition['roles'].employee.actions.push('withdraw_leave');
    definition['roles'].manager.actions.push('tell_payroll');
  };

  it('takes every path whose condition holds, catches a failed action, and joins what can still arrive', async () => {
    const app = await leaveApp('Leave, with payroll', (definition) => {
      withMore(definition);
      definition['processes'].leave_approval = {
        label: 'Leave, with payroll',
        entity: 'leave_request',
        elements: {
          requested: { type: 'startEvent', actions: ['request_leave'] },
          who: { type: 'inclusiveGateway', name: 'Who hears?' },
          payroll: { type: 'serviceTask', name: 'Tell payroll', action: 'tell_payroll' },
          failed: { type: 'boundaryEvent', name: 'Payroll refused', attachedTo: 'payroll', error: true },
          by_hand: { type: 'userTask', name: 'Tell payroll by hand', role: 'manager', assignee: { field: 'manager' }, outcomes: [{ name: 'done', label: 'Done' }] },
          team: { type: 'manualTask', name: 'Tell the team' },
          joined: { type: 'inclusiveGateway' },
          done: { type: 'endEvent', name: 'Everyone knows' },
        },
        flows: {
          f1: { from: 'requested', to: 'who' },
          long: { from: 'who', to: 'payroll', name: 'Over 5 days', when: { gt: [{ ref: 'record.days' }, 5] } },
          always: { from: 'who', to: 'team', name: 'Always', when: { gte: [{ ref: 'record.days' }, 0] } },
          paid: { from: 'payroll', to: 'joined' },
          refused: { from: 'failed', to: 'by_hand' },
          by_hand_done: { from: 'by_hand', to: 'joined' },
          told: { from: 'team', to: 'joined' },
          f2: { from: 'joined', to: 'done' },
        },
      };
    });
    // Two days: only the team hears; the join has nothing else to wait for.
    const short = await ask(app, { days: 2 });
    expect((await processesOf(app, short.record.id))[0]).toMatchObject({ status: 'completed' });

    // Eight days: payroll too. Its action doesn't apply to leave that waits for a decision, so the error path
    // gives the work to the manager, and the join waits for it.
    const long = await ask(app, { days: 8, starts: '2027-07-05', ends: '2027-07-14' });
    let [instance] = await processesOf(app, long.record.id);
    expect(instance).toMatchObject({ status: 'running', stuck: [], waiting: expect.arrayContaining([{ element: 'by_hand', name: 'Tell payroll by hand' }, { element: 'joined', name: 'Inclusive gateway joined' }]) });
    expect(instance.events.find((event: { kind: string }) => event.kind === 'error_caught')).toMatchObject({ element: 'failed', detail: { task: 'payroll' } });
    const [task] = (await inbox(bob)).filter((open: { recordId: string }) => open.recordId === long.record.id);
    await complete(bob, task.id, 'done');
    [instance] = await processesOf(app, long.record.id);
    expect(instance).toMatchObject({ status: 'completed' });
    expect(instance.events.at(-1)).toMatchObject({ kind: 'ended', element: 'done' });
  });

  it("hears an action as a message: withdrawing interrupts the manager's task, and a waiting event moves on", async () => {
    const app = await leaveApp('Leave, withdrawable', (definition) => {
      withMore(definition);
      const process = definition['processes'].leave_approval;
      process.elements.withdrawn = { type: 'boundaryEvent', name: 'Withdrawn', attachedTo: 'decide', message: { action: 'withdraw_leave' } };
      process.elements.gone = { type: 'endEvent', name: 'Leave withdrawn' };
      process.flows.withdraw = { from: 'withdrawn', to: 'gone' };
      definition['processes'].watch = {
        label: 'Watch for withdrawal',
        entity: 'leave_request',
        elements: {
          requested: { type: 'startEvent', actions: ['request_leave'] },
          wait: { type: 'intermediateCatchEvent', name: 'Until withdrawn', message: { action: 'withdraw_leave' } },
          done: { type: 'endEvent', name: 'Seen' },
        },
        flows: { f1: { from: 'requested', to: 'wait' }, f2: { from: 'wait', to: 'done' } },
      };
    });
    const asked = await ask(app, { starts: '2027-08-02', ends: '2027-08-03', days: 2 });
    expect((await processesOf(app, asked.record.id)).map((instance: { process: string; status: string }) => [instance.process, instance.status]).sort()).toEqual([
      ['leave_approval', 'running'],
      ['watch', 'running'],
    ]);
    await inject({ method: 'POST', url: `/v1/apps/${app}/actions/withdraw_leave/run`, ...as(alice), payload: { recordId: asked.record.id } }, 200);
    expect((await inbox(bob)).filter((task: { recordId: string }) => task.recordId === asked.record.id)).toEqual([]);
    const instances = await processesOf(app, asked.record.id);
    const approval = instances.find((instance: { process: string }) => instance.process === 'leave_approval');
    const watch = instances.find((instance: { process: string }) => instance.process === 'watch');
    expect(approval).toMatchObject({ status: 'completed', tasks: [{ status: 'cancelled' }] });
    expect(approval.events.at(-1)).toMatchObject({ kind: 'ended', element: 'gone' });
    expect(watch).toMatchObject({ status: 'completed' });
    expect(watch.events.map((event: { kind: string }) => event.kind)).toEqual(['started', 'message', 'ended']);
  });
});

describe('a deadline', () => {
  it('takes a late task away from the manager, to HR', async () => {
    const strict = await leaveApp('Leave, with a deadline', (definition) => {
      const process = definition['processes'].leave_approval;
      process.elements.late = { type: 'boundaryEvent', name: 'Three days late', attachedTo: 'decide', timer: { duration: 'P3D' } };
      process.elements.hr_decides = {
        type: 'userTask',
        name: 'Decide instead of the manager',
        role: 'hr',
        outcomes: [
          { name: 'approve', label: 'Approve', action: 'approve_leave' },
          { name: 'reject', label: 'Reject', action: 'reject_leave' },
        ],
      };
      process.flows.escalate = { from: 'late', to: 'hr_decides' };
      process.flows.hr_approve = { from: 'hr_decides', to: 'approved', outcome: 'approve' };
      process.flows.hr_reject = { from: 'hr_decides', to: 'rejected', outcome: 'reject' };
    });
    const asked = await ask(strict);
    expect(await t.server.processes.fireDue()).toBe(0);

    // Three days on, the timer fires: Bob's task ends, and HR gets one.
    t.clock.offsetMs = 3 * 86_400_000 + 60_000;
    [bob, carol, alice] = [await t.login('bob'), await t.login('carol'), await t.login('alice')];
    expect(await t.server.processes.fireDue()).toBe(1);
    expect((await inbox(bob)).filter((task: { recordId: string }) => task.recordId === asked.record.id)).toEqual([]);
    const [hr] = (await inbox(carol)).filter((task: { recordId: string }) => task.recordId === asked.record.id);
    expect(hr).toMatchObject({ name: 'Decide instead of the manager', role: 'hr', assignee: null, recordId: asked.record.id });
    await complete(carol, hr.id, 'reject');

    const [instance] = await processesOf(strict, asked.record.id);
    expect(instance.status).toBe('completed');
    expect(instance.tasks.map((task: { element: string; status: string }) => [task.element, task.status])).toEqual([
      ['decide', 'cancelled'],
      ['hr_decides', 'completed'],
    ]);
    expect(instance.events.map((event: { kind: string; element: string | null }) => [event.kind, event.element])).toEqual([
      ['started', 'requested'],
      ['task_opened', 'decide'],
      ['timer_fired', 'late'],
      ['task_cancelled', 'decide'],
      ['task_opened', 'hr_decides'],
      ['task_completed', 'hr_decides'],
      ['ended', 'rejected'],
    ]);
  });
});
