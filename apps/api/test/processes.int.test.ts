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
    expect(refused.json()).toMatchObject({ error: 'invalid_bpmn', details: { issues: [{ path: 'bpmn.decide', message: 'Ambit runs no code: write the script as Ambit\'s steps (scriptFormat urn:ambit:steps), or run one of the app\'s actions with a service task: "Compute" (decide)' }] } });
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

describe('sub-processes and call activities', () => {
  it('runs a sub-process to its end, and ends all of it on a message or on a failure inside it', async () => {
    const app = await leaveApp('Leave, with a review', (definition) => {
      definition['actions'].withdraw_leave = {
        label: 'Withdraw the leave',
        description: 'Withdraw a leave request that waits for a decision.',
        entity: 'leave_request',
        operation: 'update',
        input: [],
        set: { status: 'rejected' },
        where: { eq: [{ ref: 'record.status' }, 'submitted'] },
      };
      // Payroll takes short leave only: for long leave, the action doesn't apply, and fails.
      definition['actions'].note_review = {
        label: 'Note the review',
        description: 'Note that the leave is under review.',
        entity: 'leave_request',
        operation: 'update',
        input: [],
        set: { reason: 'Under review' },
        where: { lte: [{ ref: 'record.days' }, 10] },
      };
      definition['roles'].employee.actions.push('withdraw_leave');
      definition['processes'].leave_approval = {
        label: 'Leave, with a review',
        entity: 'leave_request',
        elements: {
          requested: { type: 'startEvent', actions: ['request_leave'] },
          review: { type: 'subProcess', name: 'Review' },
          review_start: { type: 'startEvent', in: 'review' },
          split: { type: 'parallelGateway', in: 'review' },
          check: { type: 'userTask', name: 'Check the dates', in: 'review', role: 'manager', assignee: { field: 'manager' }, outcomes: [{ name: 'done', label: 'Done' }] },
          note: { type: 'serviceTask', name: 'Note the review', in: 'review', action: 'note_review' },
          join: { type: 'parallelGateway', in: 'review' },
          review_end: { type: 'endEvent', in: 'review' },
          withdrawn: { type: 'boundaryEvent', name: 'Withdrawn', attachedTo: 'review', message: { action: 'withdraw_leave' } },
          failed: { type: 'boundaryEvent', name: 'Review failed', attachedTo: 'review', error: true },
          by_hand: { type: 'userTask', name: 'Sort it out by hand', role: 'manager', assignee: { field: 'manager' }, outcomes: [{ name: 'done', label: 'Done' }] },
          reviewed: { type: 'endEvent', name: 'Reviewed' },
          gone: { type: 'endEvent', name: 'Leave withdrawn' },
        },
        flows: {
          f1: { from: 'requested', to: 'review' },
          r1: { from: 'review_start', to: 'split' },
          r2: { from: 'split', to: 'check' },
          r3: { from: 'split', to: 'note' },
          r4: { from: 'check', to: 'join' },
          r5: { from: 'note', to: 'join' },
          r6: { from: 'join', to: 'review_end' },
          f2: { from: 'review', to: 'reviewed' },
          f3: { from: 'withdrawn', to: 'gone' },
          f4: { from: 'failed', to: 'by_hand' },
          f5: { from: 'by_hand', to: 'reviewed' },
        },
      };
    });
    const tasksFor = async (recordId: string) => (await inbox(bob)).filter((task: { recordId: string }) => task.recordId === recordId);
    const kinds = (instance: { events: Array<{ kind: string; element: string | null }> }) => instance.events.map((event) => [event.kind, event.element]);

    // Short leave: the sub-process runs both paths in it, and ends when nothing runs in it any more.
    const short = await ask(app, { days: 2 });
    let [instance] = await processesOf(app, short.record.id);
    expect(instance).toMatchObject({ status: 'running', waiting: expect.arrayContaining([{ element: 'review', name: 'Review' }, { element: 'check', name: 'Check the dates' }]) });
    await complete(bob, (await tasksFor(short.record.id))[0].id, 'done');
    [instance] = await processesOf(app, short.record.id);
    expect(instance.status).toBe('completed');
    expect(kinds(instance)).toEqual([
      ['started', 'requested'],
      ['entered', 'review'],
      ['task_opened', 'check'],
      ['ran', 'note'],
      ['task_completed', 'check'],
      ['exited', 'review'],
      ['ended', 'reviewed'],
    ]);

    // Withdrawn while the review runs: the message on its boundary ends all of it, the open task too.
    const withdrawn = await ask(app, { days: 3, starts: '2027-09-06', ends: '2027-09-08' });
    expect(await tasksFor(withdrawn.record.id)).toHaveLength(1);
    await inject({ method: 'POST', url: `/v1/apps/${app}/actions/withdraw_leave/run`, ...as(alice), payload: { recordId: withdrawn.record.id } }, 200);
    expect(await tasksFor(withdrawn.record.id)).toEqual([]);
    [instance] = await processesOf(app, withdrawn.record.id);
    expect(instance).toMatchObject({ status: 'completed', tasks: [{ element: 'check', status: 'cancelled' }] });
    expect(instance.events.at(-1)).toMatchObject({ kind: 'ended', element: 'gone' });

    // Long leave: the action inside fails, and the error event on the sub-process takes the path by hand.
    const long = await ask(app, { days: 12, starts: '2027-10-04', ends: '2027-10-19' });
    [instance] = await processesOf(app, long.record.id);
    expect(instance).toMatchObject({ status: 'running', stuck: [], waiting: [{ element: 'by_hand', name: 'Sort it out by hand' }] });
    expect(instance.events.find((event: { kind: string }) => event.kind === 'error_caught')).toMatchObject({ element: 'failed', detail: { task: 'note' } });
    expect(instance.tasks.map((task: { element: string; status: string }) => [task.element, task.status])).toEqual([
      ['check', 'cancelled'],
      ['by_hand', 'open'],
    ]);
    await complete(bob, (await tasksFor(long.record.id))[0].id, 'done');
    expect((await processesOf(app, long.record.id))[0].status).toBe('completed');
  });

  it('calls a process on the team the request refers to, and goes on when it ends; a cancel goes both ways', async () => {
    const app = await leaveApp('Leave, with cover', (definition) => {
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
      definition['actions'].request_leave.input.push('team');
      definition['actions'].add_team = { label: 'Add a team', description: 'Add a team.', entity: 'team', operation: 'create', input: ['name', 'lead'], set: {}, confirm: 'none' };
      definition['roles'].employee.entities.team = { read: true, create: true };
      definition['roles'].employee.actions.push('add_team');
      definition['roles'].manager.entities.team = { read: true };
      definition['processes'].cover_plan = {
        label: 'Cover plan',
        entity: 'team',
        elements: {
          start: { type: 'startEvent' },
          plan: { type: 'userTask', name: 'Plan the cover', role: 'manager', assignee: { field: 'lead' }, outcomes: [{ name: 'done', label: 'Done' }] },
          end: { type: 'endEvent', name: 'Covered' },
        },
        flows: { f1: { from: 'start', to: 'plan' }, f2: { from: 'plan', to: 'end' } },
      };
      const process = definition['processes'].leave_approval;
      process.elements.cover = { type: 'callActivity', name: 'Plan the cover', process: 'cover_plan', record: 'team' };
      process.flows.on_approve.to = 'cover';
      process.flows.covered = { from: 'cover', to: 'approved' };
      delete process.diagram;
    });
    const team = await json({ method: 'POST', url: `/v1/apps/${app}/actions/add_team/run`, ...as(alice), payload: { values: { name: 'Payments', lead: bob.userId } } }, 201);
    const teamProcesses = async () => (await json({ method: 'GET', url: `/v1/apps/${app}/entities/team/records/${team.record.id}/processes`, ...as(alice) }, 200)).instances;
    const decide = async (recordId: string) => {
      const [task] = (await inbox(bob)).filter((open: { recordId: string; element: string }) => open.recordId === recordId && open.element === 'decide');
      await complete(bob, task.id, 'approve');
    };
    const planTask = async () => (await inbox(bob)).filter((open: { recordId: string }) => open.recordId === team.record.id);

    // Approved: the leave waits while the team's lead plans the cover, on the team's record.
    const asked = await ask(app, { team: team.record.id, starts: '2027-11-01', ends: '2027-11-02', days: 2 });
    await decide(asked.record.id);
    let [leave] = await processesOf(app, asked.record.id);
    expect(leave).toMatchObject({ status: 'running', waiting: [{ element: 'cover', name: 'Plan the cover' }] });
    const [cover] = await teamProcesses();
    expect(cover).toMatchObject({ process: 'cover_plan', status: 'running', calledBy: leave.id, entity: 'team', recordId: team.record.id });
    expect(leave.events.find((event: { kind: string }) => event.kind === 'called')).toMatchObject({ element: 'cover', detail: { process: 'cover_plan', instance: cover.id } });
    const [plan] = await planTask();
    expect(plan).toMatchObject({ name: 'Plan the cover', entity: 'team', assignee: { id: bob.userId } });
    await complete(bob, plan.id, 'done');
    [leave] = await processesOf(app, asked.record.id);
    expect(leave.status).toBe('completed');
    expect(leave.events.slice(-2)).toMatchObject([
      { kind: 'returned', element: 'cover', detail: { instance: cover.id } },
      { kind: 'ended', element: 'approved' },
    ]);

    // An operator cancels the called instance: the call waits for them, and trying again calls it anew.
    const second = await ask(app, { team: team.record.id, starts: '2027-11-08', ends: '2027-11-09', days: 2 });
    await decide(second.record.id);
    let running = (await teamProcesses()).find((instance: { status: string }) => instance.status === 'running');
    await json({ method: 'POST', url: `/v1/apps/${app}/process-instances/${running.id}/cancel`, ...as(alice) }, 200);
    [leave] = await processesOf(app, second.record.id);
    expect(leave).toMatchObject({ status: 'running', stuck: [{ element: 'cover', error: 'Cover plan was cancelled: try again to start it anew' }] });
    await json({ method: 'POST', url: `/v1/apps/${app}/process-instances/${leave.id}/retry`, ...as(alice) }, 200);
    expect(await planTask()).toHaveLength(1);

    // Cancelling the leave's instance cancels the cover plan it waits for.
    await json({ method: 'POST', url: `/v1/apps/${app}/process-instances/${leave.id}/cancel`, ...as(alice) }, 200);
    expect(await planTask()).toEqual([]);
    running = (await teamProcesses()).filter((instance: { status: string }) => instance.status === 'running');
    expect(running).toEqual([]);
  });
});

describe('rule checks, scripts, messages that a process sends, receive tasks and links', () => {
  it('checks the rules, changes the record by script, tells payroll and the team, and waits for the confirmation', async () => {
    const app = await leaveApp('Leave, with checks', (definition) => {
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
      definition['actions'].request_leave.input.push('team');
      const update = (entity: string, label: string, set: Record<string, string>, where?: unknown) => ({
        label,
        description: `${label}.`,
        entity,
        operation: 'update',
        input: [],
        set,
        confirm: 'none',
        ...(where ? { where } : {}),
      });
      definition['actions'].add_team = { label: 'Add a team', description: 'Add a team.', entity: 'team', operation: 'create', input: ['name'], set: {}, confirm: 'none' };
      definition['actions'].note_team = update('team', 'Note the team', { note: 'Someone is away' });
      definition['actions'].confirm_leave = update('leave_request', 'Confirm the leave', { decided_on: '2027-01-04' });
      definition['actions'].tell_payroll = update('leave_request', 'Tell payroll', { status: 'approved' });
      definition['actions'].withdraw_leave = update('leave_request', 'Withdraw the leave', { status: 'rejected' }, { eq: [{ ref: 'record.status' }, 'submitted'] });
      definition['roles'].employee.entities.team = { read: true, create: true };
      definition['roles'].employee.actions.push('add_team', 'confirm_leave', 'withdraw_leave');
      // The team's process waits until a leave request of the team sends it a note.
      definition['processes'].team_watch = {
        label: 'Team watch',
        entity: 'team',
        elements: {
          added: { type: 'startEvent', actions: ['add_team'] },
          noted: { type: 'intermediateCatchEvent', name: 'Until noted', message: { action: 'note_team' } },
          end: { type: 'endEvent', name: 'Told' },
        },
        flows: { f1: { from: 'added', to: 'noted' }, f2: { from: 'noted', to: 'end' } },
      };
      definition['processes'].leave_approval = {
        label: 'Leave, with checks',
        entity: 'leave_request',
        elements: {
          requested: { type: 'startEvent', actions: ['request_leave'] },
          check: { type: 'businessRuleTask', name: 'Check the rules', rules: ['long_leave'] },
          note: { type: 'scriptTask', name: 'Note the check', steps: [{ type: 'set', field: 'reason', value: 'Checked' }] },
          flag: { type: 'scriptTask', name: 'Flag long leave', steps: [{ type: 'set', field: 'reason', value: 'Long leave' }] },
          checked: { type: 'intermediateThrowEvent', name: 'Checked' },
          tell_team: { type: 'intermediateThrowEvent', name: 'Tell the team', message: { action: 'note_team', record: 'team' } },
          jump: { type: 'intermediateThrowEvent', link: 'on' },
          land: { type: 'intermediateCatchEvent', link: 'on' },
          wait: { type: 'receiveTask', name: 'Wait for the confirmation', message: { action: 'confirm_leave' } },
          withdrawn: { type: 'boundaryEvent', name: 'Withdrawn', attachedTo: 'wait', message: { action: 'withdraw_leave' } },
          gone: { type: 'endEvent', name: 'Withdrawn' },
          told: { type: 'sendTask', name: 'Tell payroll', message: { action: 'tell_payroll' } },
          done: { type: 'endEvent', name: 'Done' },
        },
        flows: {
          f1: { from: 'requested', to: 'check' },
          passed: { from: 'check', to: 'note', outcome: 'passed' },
          warned: { from: 'check', to: 'flag', outcome: 'warned' },
          failed: { from: 'check', to: 'done', outcome: 'failed' },
          f2: { from: 'note', to: 'checked' },
          f3: { from: 'flag', to: 'checked' },
          f4: { from: 'checked', to: 'tell_team' },
          f5: { from: 'tell_team', to: 'jump' },
          f6: { from: 'land', to: 'wait' },
          f7: { from: 'wait', to: 'told' },
          f8: { from: 'told', to: 'done' },
          f9: { from: 'withdrawn', to: 'gone' },
        },
      };
    });
    const team = await json({ method: 'POST', url: `/v1/apps/${app}/actions/add_team/run`, ...as(alice), payload: { values: { name: 'Payments' } } }, 201);
    const teamInstances = async () => (await json({ method: 'GET', url: `/v1/apps/${app}/entities/team/records/${team.record.id}/processes`, ...as(alice) }, 200)).instances;
    expect((await teamInstances())[0]).toMatchObject({ process: 'team_watch', status: 'running' });
    const record = (id: string) => json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${id}`, ...as(alice) }, 200);

    // Short leave passes the check: the script notes it, the team hears of it, and the process waits for the confirmation.
    const short = await ask(app, { days: 2, team: team.record.id, starts: '2027-06-07', ends: '2027-06-08' });
    let [leave] = await processesOf(app, short.record.id);
    expect(leave).toMatchObject({ status: 'running', waiting: [{ element: 'wait', name: 'Wait for the confirmation' }] });
    expect(leave.events.map((event: { kind: string; element: string | null }) => [event.kind, event.element])).toEqual([
      ['started', 'requested'],
      ['checked', 'check'],
      ['ran', 'note'],
      ['reached', 'checked'],
      ['sent', 'tell_team'],
    ]);
    expect(leave.events[1].detail).toEqual({ outcome: 'passed', rules: [] });
    expect((await record(short.record.id)).values.reason).toBe('Checked');
    expect((await teamInstances())[0]).toMatchObject({ status: 'completed' });

    // The confirmation moves it on: it tells payroll, and ends.
    await inject({ method: 'POST', url: `/v1/apps/${app}/actions/confirm_leave/run`, ...as(alice), payload: { recordId: short.record.id } }, 200);
    [leave] = await processesOf(app, short.record.id);
    expect(leave.status).toBe('completed');
    expect(leave.events.slice(-3).map((event: { kind: string; element: string | null }) => [event.kind, event.element])).toEqual([
      ['message', 'wait'],
      ['sent', 'told'],
      ['ended', 'done'],
    ]);
    expect((await record(short.record.id)).values.status).toBe('approved');

    // Long leave warns: the script flags it. Withdrawn while the process waits, the receive task ends.
    const long = await ask(app, { days: 12, team: team.record.id, starts: '2027-07-05', ends: '2027-07-20' });
    expect((await record(long.record.id)).values.reason).toBe('Long leave');
    await inject({ method: 'POST', url: `/v1/apps/${app}/actions/withdraw_leave/run`, ...as(alice), payload: { recordId: long.record.id } }, 200);
    [leave] = await processesOf(app, long.record.id);
    expect(leave.status).toBe('completed');
    expect(leave.events.find((event: { kind: string }) => event.kind === 'checked').detail).toEqual({ outcome: 'warned', rules: ['long_leave'] });
    expect(leave.events.at(-1)).toMatchObject({ kind: 'ended', element: 'gone' });
  });

  it('runs one sub-process twice at once, and a failed check in a script takes its error path', async () => {
    const app = await leaveApp('Leave, reviewed twice', (definition) => {
      definition['processes'].leave_approval = {
        label: 'Leave, reviewed twice',
        entity: 'leave_request',
        elements: {
          requested: { type: 'startEvent', actions: ['request_leave'] },
          split: { type: 'parallelGateway' },
          review: { type: 'subProcess', name: 'Review' },
          review_start: { type: 'startEvent', in: 'review' },
          look: { type: 'userTask', name: 'Look at it', in: 'review', role: 'manager', assignee: { field: 'manager' }, outcomes: [{ name: 'done', label: 'Done' }] },
          review_end: { type: 'endEvent', in: 'review' },
          guard: {
            type: 'scriptTask',
            name: 'Guard short leave',
            steps: [{ type: 'check', assert: { lte: [{ ref: 'record.days' }, 5] }, message: 'Leave is long' }],
          },
          too_long: { type: 'boundaryEvent', attachedTo: 'guard', error: true },
          done: { type: 'endEvent', name: 'Done' },
          long: { type: 'endEvent', name: 'Too long' },
        },
        flows: {
          f1: { from: 'requested', to: 'split' },
          a: { from: 'split', to: 'review' },
          b: { from: 'split', to: 'review' },
          c: { from: 'split', to: 'guard' },
          r1: { from: 'review_start', to: 'look' },
          r2: { from: 'look', to: 'review_end' },
          out: { from: 'review', to: 'done' },
          g: { from: 'guard', to: 'done' },
          e: { from: 'too_long', to: 'long' },
        },
      };
    });
    const asked = await ask(app, { days: 8, starts: '2027-08-02', ends: '2027-08-11' });
    const tasks = async () => (await inbox(bob)).filter((task: { recordId: string }) => task.recordId === asked.record.id);
    let [instance] = await processesOf(app, asked.record.id);
    expect(instance.waiting.filter((at: { element: string }) => at.element === 'review')).toHaveLength(2);
    expect(instance.events.find((event: { kind: string }) => event.kind === 'error_caught')).toMatchObject({ element: 'too_long', detail: { task: 'guard', error: 'Leave is long' } });
    expect(await tasks()).toHaveLength(2);
    // Each run ends on its own.
    await complete(bob, (await tasks())[0].id, 'done');
    [instance] = await processesOf(app, asked.record.id);
    expect(instance).toMatchObject({ status: 'running', waiting: [{ element: 'review', name: 'Review' }, { element: 'look', name: 'Look at it' }] });
    await complete(bob, (await tasks())[0].id, 'done');
    [instance] = await processesOf(app, asked.record.id);
    expect(instance.status).toBe('completed');
    expect(instance.events.filter((event: { kind: string }) => event.kind === 'exited')).toHaveLength(2);
  });
});

describe('conditions, event-based gateways and starts by themselves', () => {
  /** The leave app with actions that change the days and the first day, a confirmation and a withdrawal. */
  const withChanges = (definition: Record<string, any>) => {
    const update = (label: string, set: Record<string, unknown>) => ({ label, description: `${label}.`, entity: 'leave_request', operation: 'update', input: [], set, confirm: 'none' });
    definition['actions'].make_long = update('Make it long', { days: 12 });
    definition['actions'].make_short = update('Make it short', { days: 1 });
    definition['actions'].move_start = update('Start on 5 January', { starts: '2026-01-05' });
    definition['actions'].confirm_leave = update('Confirm the leave', { reason: 'Confirmed' });
    definition['actions'].withdraw_leave = update('Withdraw the leave', { reason: 'Withdrawn' });
    definition['roles'].employee.actions.push('make_long', 'make_short', 'move_start', 'confirm_leave', 'withdraw_leave');
  };
  const run = (app: string, action: string, recordId: string) => inject({ method: 'POST', url: `/v1/apps/${app}/actions/${action}/run`, ...as(alice), payload: { recordId } }, 200);
  const processOf = async (app: string, recordId: string, process: string) =>
    (await processesOf(app, recordId)).find((instance: { process: string }) => instance.process === process);

  it('starts a process when a change makes its condition hold, and on the first day of leave', async () => {
    const app = await leaveApp('Leave, starting by itself', (definition) => {
      withChanges(definition);
      const simple = (label: string, start: Record<string, unknown>) => ({
        label,
        entity: 'leave_request',
        elements: {
          start: { type: 'startEvent', ...start },
          note: { type: 'userTask', name: label, role: 'manager', assignee: { field: 'manager' }, outcomes: [{ name: 'done', label: 'Done' }] },
          end: { type: 'endEvent' },
        },
        flows: { f1: { from: 'start', to: 'note' }, f2: { from: 'note', to: 'end' } },
      });
      definition['processes'].long_review = simple('Review long leave', { condition: { gt: [{ ref: 'record.days' }, 10] } });
      definition['processes'].first_day = simple('Cover the first day', { timer: { date: 'starts' } });
    });
    // Long from the start: the condition holds where there was no record before.
    const long = await ask(app, { days: 12, starts: '2030-02-04', ends: '2030-02-19' });
    expect(await processOf(app, long.record.id, 'long_review')).toMatchObject({ status: 'running' });
    expect((await processOf(app, long.record.id, 'long_review')).events[0]).toMatchObject({ kind: 'started', detail: { condition: true } });
    // Short at first; a change that makes it long starts the review, and a change that keeps it long starts nothing more.
    const short = await ask(app, { days: 2, starts: '2030-03-04', ends: '2030-03-05' });
    expect(await processOf(app, short.record.id, 'long_review')).toBeUndefined();
    await run(app, 'make_long', short.record.id);
    expect(await processOf(app, short.record.id, 'long_review')).toMatchObject({ status: 'running' });

    // The first day of leave starts its process; moving the first day moves the start.
    expect(await processOf(app, short.record.id, 'first_day')).toBeUndefined();
    await t.server.processes.fireDue();
    expect(await processOf(app, short.record.id, 'first_day')).toBeUndefined();
    await run(app, 'move_start', short.record.id);
    await t.server.processes.fireDue();
    expect(await processOf(app, short.record.id, 'first_day')).toMatchObject({ status: 'running' });
    expect((await processOf(app, short.record.id, 'first_day')).events[0]).toMatchObject({ kind: 'started', detail: { timer: true } });
  });

  it('waits for the first of several events, and hears a condition on a task', async () => {
    const app = await leaveApp('Leave, waiting for what comes first', (definition) => {
      withChanges(definition);
      const process = definition['processes'].leave_approval;
      Object.assign(process.elements, {
        gate: { type: 'eventBasedGateway', name: 'What comes first?' },
        two_days: { type: 'intermediateCatchEvent', name: 'Two days', timer: { duration: 'P2D' } },
        withdrawn: { type: 'intermediateCatchEvent', name: 'Withdrawn', message: { action: 'withdraw_leave' } },
        shortened: { type: 'intermediateCatchEvent', name: 'Shortened', condition: { lt: [{ ref: 'record.days' }, 2] } },
        confirmed: { type: 'receiveTask', name: 'Confirmed', message: { action: 'confirm_leave' } },
        grew: { type: 'boundaryEvent', name: 'Grew long', attachedTo: 'decide', interrupting: false, condition: { gt: [{ ref: 'record.days' }, 10] } },
        hr_look: { type: 'userTask', name: 'Look at long leave', role: 'hr', outcomes: [{ name: 'done', label: 'Done' }] },
        looked: { type: 'endEvent', name: 'Looked' },
      });
      process.flows.on_approve.to = 'gate';
      Object.assign(process.flows, {
        g1: { from: 'gate', to: 'two_days' },
        g2: { from: 'gate', to: 'withdrawn' },
        g3: { from: 'gate', to: 'shortened' },
        g4: { from: 'gate', to: 'confirmed' },
        w1: { from: 'two_days', to: 'approved' },
        w2: { from: 'withdrawn', to: 'approved' },
        w3: { from: 'shortened', to: 'approved' },
        w4: { from: 'confirmed', to: 'approved' },
        l1: { from: 'grew', to: 'hr_look' },
        l2: { from: 'hr_look', to: 'looked' },
      });
      delete process.diagram;
    });
    const approve = async (recordId: string) => {
      const [task] = (await inbox(bob)).filter((open: { recordId: string; element: string }) => open.recordId === recordId && open.element === 'decide');
      await complete(bob, task.id, 'approve');
    };
    const taken = async (recordId: string) => (await processOf(app, recordId, 'leave_approval')).events.find((event: { element: string | null }) => ['two_days', 'withdrawn', 'shortened', 'confirmed'].includes(event.element ?? ''));

    // While the manager decides, the leave grows long: HR looks at it beside the decision.
    const first = await ask(app, { days: 4, starts: '2030-04-01', ends: '2030-04-04' });
    await run(app, 'make_long', first.record.id);
    expect((await inbox(carol)).filter((task: { recordId: string }) => task.recordId === first.record.id).map((task: { name: string }) => task.name)).toEqual(['Look at long leave']);
    // Growing again doesn't make it happen again: the condition held before the change.
    await run(app, 'make_long', first.record.id);
    expect((await inbox(carol)).filter((task: { recordId: string }) => task.recordId === first.record.id)).toHaveLength(1);
    // Approved: the confirmation comes first.
    await approve(first.record.id);
    expect(await processOf(app, first.record.id, 'leave_approval')).toMatchObject({ waiting: expect.arrayContaining([{ element: 'gate', name: 'What comes first?' }]) });
    await run(app, 'confirm_leave', first.record.id);
    expect(await taken(first.record.id)).toMatchObject({ kind: 'message', element: 'confirmed' });

    // Another leave: shortened before anything else.
    const second = await ask(app, { days: 4, starts: '2030-05-06', ends: '2030-05-09' });
    await approve(second.record.id);
    await run(app, 'make_short', second.record.id);
    expect(await taken(second.record.id)).toMatchObject({ kind: 'condition', element: 'shortened' });
    // The confirmation that comes after it moves nothing: the gateway no longer waits.
    await run(app, 'confirm_leave', second.record.id);
    const done = await processOf(app, second.record.id, 'leave_approval');
    expect(done.status).toBe('completed');
    expect(done.events.filter((event: { kind: string }) => event.kind === 'message')).toEqual([]);

    // A third: withdrawn first.
    const third = await ask(app, { days: 4, starts: '2030-06-03', ends: '2030-06-06' });
    await approve(third.record.id);
    await run(app, 'withdraw_leave', third.record.id);
    expect(await taken(third.record.id)).toMatchObject({ kind: 'message', element: 'withdrawn' });
  });
});

describe('errors with codes, escalations, undo and transactions', () => {
  /** The leave app with a room to book and to free again, and a note for HR. */
  const withRoom = (definition: Record<string, any>) => {
    definition['entities'].leave_request.fields.push({ name: 'room', label: 'Room', type: 'text' }, { name: 'hr_note', label: 'Note for HR', type: 'text' });
    const update = (label: string, set: Record<string, string>) => ({ label, description: `${label}.`, entity: 'leave_request', operation: 'update', input: [], set, confirm: 'none' });
    definition['actions'].book_room = update('Book a room', { room: 'Booked' });
    definition['actions'].free_room = update('Free the room', { room: 'Freed' });
    definition['actions'].tell_hr = update('Tell HR', { hr_note: 'Late' });
  };
  const values = async (app: string, id: string) => (await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${id}`, ...as(alice) }, 200)).values;
  const kinds = (instance: { events: Array<{ kind: string; element: string | null }> }) => instance.events.map((event) => [event.kind, event.element]);

  it('books a room in a transaction, and a cancel inside it frees the room again', async () => {
    const app = await leaveApp('Leave, with a room', (definition) => {
      withRoom(definition);
      definition['processes'].leave_approval = {
        label: 'Leave, with a room',
        entity: 'leave_request',
        elements: {
          requested: { type: 'startEvent', actions: ['request_leave'] },
          booking: { type: 'subProcess', name: 'Booking', transaction: true },
          b_start: { type: 'startEvent', in: 'booking' },
          book: { type: 'serviceTask', name: 'Book a room', in: 'booking', action: 'book_room', undo: 'free_room' },
          b_gate: { type: 'exclusiveGateway', in: 'booking' },
          b_cancel: { type: 'endEvent', name: 'Too long', in: 'booking', cancel: true },
          b_end: { type: 'endEvent', in: 'booking' },
          cancelled: { type: 'boundaryEvent', name: 'Cancelled', attachedTo: 'booking', cancel: true },
          booked: { type: 'endEvent', name: 'Booked' },
          no_room: { type: 'endEvent', name: 'No room' },
        },
        flows: {
          f1: { from: 'requested', to: 'booking' },
          b1: { from: 'b_start', to: 'book' },
          b2: { from: 'book', to: 'b_gate' },
          b3: { from: 'b_gate', to: 'b_cancel', when: { gt: [{ ref: 'record.days' }, 10] } },
          b4: { from: 'b_gate', to: 'b_end', default: true },
          f2: { from: 'booking', to: 'booked' },
          f3: { from: 'cancelled', to: 'no_room' },
        },
      };
    });

    // Short leave: the transaction completes, and the room stays booked.
    const short = await ask(app, { days: 3, starts: '2027-09-06', ends: '2027-09-08' });
    let [instance] = await processesOf(app, short.record.id);
    expect(instance.status).toBe('completed');
    expect(kinds(instance)).toEqual([
      ['started', 'requested'],
      ['entered', 'booking'],
      ['ran', 'book'],
      ['exited', 'booking'],
      ['ended', 'booked'],
    ]);
    expect(instance.events[2].detail).toEqual({ action: 'book_room', scope: expect.any(String), undo: 'free_room', recordId: short.record.id });
    expect((await values(app, short.record.id)).room).toBe('Booked');

    // Long leave: the cancel end undoes the booking, and the path leaves by the cancel event.
    const long = await ask(app, { days: 12, starts: '2027-10-04', ends: '2027-10-19' });
    [instance] = await processesOf(app, long.record.id);
    expect(instance.status).toBe('completed');
    expect(kinds(instance)).toEqual([
      ['started', 'requested'],
      ['entered', 'booking'],
      ['ran', 'book'],
      ['compensated', 'book'],
      ['transaction_cancelled', 'cancelled'],
      ['ended', 'no_room'],
    ]);
    expect(instance.events[3].detail).toMatchObject({ of: expect.any(String), action: 'free_room', from: 'b_cancel' });
    expect(instance.events[4].detail).toEqual({ transaction: 'booking', from: 'b_cancel' });
    expect((await values(app, long.record.id)).room).toBe('Freed');
  });

  it('hears an escalation from a called process, and an error from it undoes what the caller did', async () => {
    const app = await leaveApp('Leave, with a budget', (definition) => {
      withRoom(definition);
      definition['processes'].budget_check = {
        label: 'Budget check',
        entity: 'leave_request',
        elements: {
          start: { type: 'startEvent' },
          gate: { type: 'exclusiveGateway', name: 'How long?' },
          no_budget: { type: 'endEvent', name: 'No budget', error: { code: 'no_budget' } },
          late: { type: 'intermediateThrowEvent', name: 'Late', escalation: { code: 'late' } },
          fine: { type: 'endEvent', name: 'Fine' },
        },
        flows: {
          f1: { from: 'start', to: 'gate' },
          over: { from: 'gate', to: 'no_budget', when: { gt: [{ ref: 'record.days' }, 20] } },
          long: { from: 'gate', to: 'late', when: { all: [{ gt: [{ ref: 'record.days' }, 5] }, { lte: [{ ref: 'record.days' }, 20] }] } },
          short: { from: 'gate', to: 'fine', default: true },
          f2: { from: 'late', to: 'fine' },
        },
      };
      definition['processes'].leave_approval = {
        label: 'Leave, with a budget',
        entity: 'leave_request',
        elements: {
          requested: { type: 'startEvent', actions: ['request_leave'] },
          book: { type: 'serviceTask', name: 'Book a room', action: 'book_room', undo: 'free_room' },
          check: { type: 'callActivity', name: 'Check the budget', process: 'budget_check' },
          heard: { type: 'boundaryEvent', name: 'Late', attachedTo: 'check', interrupting: false, escalation: { code: 'late' } },
          tell: { type: 'serviceTask', name: 'Tell HR', action: 'tell_hr' },
          broke: { type: 'boundaryEvent', name: 'No budget', attachedTo: 'check', error: { code: 'no_budget' } },
          undo: { type: 'intermediateThrowEvent', name: 'Undo', compensate: true },
          approved: { type: 'endEvent', name: 'Approved' },
          told: { type: 'endEvent', name: 'Told' },
          refused: { type: 'endEvent', name: 'Refused' },
        },
        flows: {
          f1: { from: 'requested', to: 'book' },
          f2: { from: 'book', to: 'check' },
          f3: { from: 'check', to: 'approved' },
          f4: { from: 'heard', to: 'tell' },
          f5: { from: 'tell', to: 'told' },
          f6: { from: 'broke', to: 'undo' },
          f7: { from: 'undo', to: 'refused' },
        },
      };
    });
    const of = async (recordId: string, process: string) => (await processesOf(app, recordId)).find((instance: { process: string }) => instance.process === process);

    // Short leave: the budget holds, and the leave is approved with its room.
    const short = await ask(app, { days: 3, starts: '2027-11-15', ends: '2027-11-17' });
    let leave = await of(short.record.id, 'leave_approval');
    expect(leave.status).toBe('completed');
    expect(leave.events.at(-1)).toMatchObject({ kind: 'ended', element: 'approved' });

    // Longer leave: the check escalates, HR hears of it, and the check goes on to its end.
    const longer = await ask(app, { days: 8, starts: '2027-11-22', ends: '2027-12-01' });
    leave = await of(longer.record.id, 'leave_approval');
    const check = await of(longer.record.id, 'budget_check');
    expect(check).toMatchObject({ status: 'completed', calledBy: leave.id });
    expect(leave.status).toBe('completed');
    expect(leave.events.find((event: { kind: string }) => event.kind === 'escalated')).toMatchObject({ element: 'heard', detail: { from: 'late', code: 'late', instance: check.id } });
    expect(await values(app, longer.record.id)).toMatchObject({ room: 'Booked', hr_note: 'Late' });

    // Leave beyond the budget: the check ends with an error, which the call catches, and the caller frees the room.
    const over = await ask(app, { days: 25, starts: '2028-01-03', ends: '2028-02-04' });
    leave = await of(over.record.id, 'leave_approval');
    const failed = await of(over.record.id, 'budget_check');
    expect(failed.status).toBe('cancelled');
    expect(failed.events.at(-1)).toMatchObject({ kind: 'cancelled', element: 'no_budget' });
    expect(leave.status).toBe('completed');
    expect(kinds(leave)).toEqual([
      ['started', 'requested'],
      ['ran', 'book'],
      ['called', 'check'],
      ['error_caught', 'broke'],
      ['compensated', 'book'],
      ['ended', 'refused'],
    ]);
    expect(leave.events[3].detail).toEqual({ from: 'no_budget', code: 'no_budget', instance: failed.id });
    expect((await values(app, over.record.id)).room).toBe('Freed');

    // Started by itself, nothing catches the error: the path waits for an operator.
    const alone = (await inject({ method: 'POST', url: `/v1/apps/${app}/processes/budget_check/start`, ...as(alice), payload: { recordId: over.record.id } }, 201)).json();
    expect(alone).toMatchObject({ status: 'running', stuck: [{ element: 'no_budget', error: 'No budget: nothing catches the error no_budget' }] });
  });
});

describe('signals', () => {
  it('reach every process of the app that waits for them, start processes on a record, and reach only what waited', async () => {
    const app = await leaveApp('Leave, with signals', (definition) => {
      const process = definition['processes'].leave_approval;
      // Closing the office takes each manager's task away, and the request's leave closes.
      Object.assign(process.elements, {
        closed: { type: 'boundaryEvent', name: 'Office closed', attachedTo: 'decide', signal: 'office_closed' },
        shut: { type: 'endEvent', name: 'Closed', signal: 'leave_closed' },
      });
      process.flows.on_closed = { from: 'closed', to: 'shut' };
      delete process.diagram;
      // On each request whose leave closed, a follow-up waits until the office opens.
      definition['processes'].follow_up = {
        label: 'Follow-up',
        entity: 'leave_request',
        elements: {
          start: { type: 'startEvent', signal: 'leave_closed' },
          wait: { type: 'intermediateCatchEvent', name: 'Until it opens', signal: 'office_open' },
          end: { type: 'endEvent', name: 'Followed up' },
        },
        flows: { f1: { from: 'start', to: 'wait' }, f2: { from: 'wait', to: 'end' } },
      };
    });
    const signal = (session: Session, payload: Record<string, unknown>, expected = 201) => inject({ method: 'POST', url: `/v1/apps/${app}/signals`, ...as(session), payload }, expected);
    const of = async (recordId: string, process: string) => (await processesOf(app, recordId)).find((instance: { process: string }) => instance.process === process);
    const kinds = (instance: { events: Array<{ kind: string; element: string | null }> }) => instance.events.map((event) => [event.kind, event.element]);

    const first = await ask(app, { starts: '2028-03-06', ends: '2028-03-07', days: 2 });
    const second = await ask(app, { starts: '2028-03-13', ends: '2028-03-14', days: 2 });
    // Only an operator throws a signal by hand.
    await signal(bob, { name: 'office_closed' }, 403);
    await signal(alice, { name: 'office_closed', entity: 'leave_request' }, 422);

    // The office closes: both managers' tasks go, and each request's leave closes with a signal of its own.
    expect((await signal(alice, { name: 'office_closed' })).json()).toMatchObject({ name: 'office_closed', status: 'delivered', heard: 2, started: 0 });
    let leave = await of(first.record.id, 'leave_approval');
    expect(leave.status).toBe('completed');
    expect(kinds(leave).slice(-3)).toEqual([
      ['signal', 'closed'],
      ['signalled', 'shut'],
      ['ended', 'shut'],
    ]);
    expect((await inbox(bob)).filter((task: { recordId: string }) => [first.record.id, second.record.id].includes(task.recordId))).toEqual([]);
    // The timer workers deliver those: the follow-up starts on each request, and waits until the office opens.
    expect(await of(first.record.id, 'follow_up')).toBeUndefined();
    await t.server.processes.fireDue();
    let follow = await of(first.record.id, 'follow_up');
    expect(follow).toMatchObject({ status: 'running', waiting: [{ element: 'wait', name: 'Until it opens' }] });
    expect(follow.events[0]).toMatchObject({ kind: 'started', element: 'start', detail: { signal: true } });
    expect(await of(second.record.id, 'follow_up')).toMatchObject({ status: 'running' });

    // A signal reaches only what waited when it was thrown: one thrown an hour ago goes unheard.
    const [where] = (await t.handle.pool.query('select org_id, app_id, environment_id from process_instances where id = $1', [follow.id])).rows;
    const anHourAgo = new Date(Date.now() + t.clock.offsetMs - 3_600_000);
    await t.handle.pool.query(
      `insert into process_signals (id, org_id, app_id, environment_id, name, thrown_at, next_attempt_at) values (gen_random_uuid(), $1, $2, $3, 'office_open', $4, $4)`,
      [where.org_id, where.app_id, where.environment_id, anHourAgo],
    );
    await t.server.processes.fireDue();
    expect((await of(first.record.id, 'follow_up')).status).toBe('running');

    // The office opens: both follow-ups hear it and end.
    expect((await signal(alice, { name: 'office_open' })).json()).toMatchObject({ status: 'delivered', heard: 2 });
    follow = await of(first.record.id, 'follow_up');
    expect(follow.status).toBe('completed');
    expect(kinds(follow).slice(-2)).toEqual([
      ['signal', 'wait'],
      ['ended', 'end'],
    ]);

    // An operator's signal for a record starts the processes it starts there.
    const third = await ask(app, { starts: '2028-03-20', ends: '2028-03-21', days: 2 });
    expect((await signal(alice, { name: 'leave_closed', entity: 'leave_request', recordId: third.record.id })).json()).toMatchObject({ heard: 0, started: 1 });
    expect(await of(third.record.id, 'follow_up')).toMatchObject({ status: 'running' });
    leave = await of(third.record.id, 'leave_approval');
    expect(leave).toMatchObject({ status: 'running', waiting: [{ element: 'decide' }] });
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

  it('ends a call that takes too long, with the process it called', async () => {
    const app = await leaveApp('Leave, with a second look', (definition) => {
      definition['processes'].second_look = {
        label: 'Second look',
        entity: 'leave_request',
        elements: {
          start: { type: 'startEvent' },
          look: { type: 'userTask', name: 'Look again', role: 'hr', outcomes: [{ name: 'done', label: 'Done' }] },
          end: { type: 'endEvent' },
        },
        flows: { f1: { from: 'start', to: 'look' }, f2: { from: 'look', to: 'end' } },
      };
      const process = definition['processes'].leave_approval;
      process.elements.again = { type: 'callActivity', name: 'Second look', process: 'second_look' };
      process.elements.slow = { type: 'boundaryEvent', name: 'A day late', attachedTo: 'again', timer: { duration: 'P1D' } };
      process.flows.on_approve.to = 'again';
      process.flows.looked = { from: 'again', to: 'approved' };
      process.flows.too_slow = { from: 'slow', to: 'approved' };
      delete process.diagram;
    });
    const asked = await ask(app, { starts: '2027-12-06', ends: '2027-12-07', days: 2 });
    const mine = async (session: Session) => (await inbox(session)).filter((task: { recordId: string }) => task.recordId === asked.record.id);
    await complete(bob, (await mine(bob))[0].id, 'approve');
    expect((await mine(carol)).map((task: { name: string }) => task.name)).toEqual(['Look again']);

    t.clock.offsetMs += 86_400_000 + 60_000;
    [bob, carol, alice] = [await t.login('bob'), await t.login('carol'), await t.login('alice')];
    expect(await t.server.processes.fireDue()).toBeGreaterThanOrEqual(1);
    expect(await mine(carol)).toEqual([]);
    const instances = await processesOf(app, asked.record.id);
    const leave = instances.find((instance: { process: string }) => instance.process === 'leave_approval');
    const look = instances.find((instance: { process: string }) => instance.process === 'second_look');
    expect(leave.status).toBe('completed');
    expect(leave.events.slice(-2)).toMatchObject([
      { kind: 'timer_fired', element: 'slow' },
      { kind: 'ended', element: 'approved' },
    ]);
    expect(look).toMatchObject({ status: 'cancelled', calledBy: leave.id, tasks: [{ status: 'cancelled' }] });
  });
});
