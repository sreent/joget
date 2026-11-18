import { LEAVE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Flows that wait (design §6.11). The leave template's flow puts the decision in the inbox of the
 * manager that the request names. A flow waits for time, for the first of two things and for two
 * ways at once, built the same way as any flow, and runs the steps between two waits in one go.
 * A person whose role may run the flow starts it on a record by hand, and a value that a flow keeps
 * in a variable doesn't live on across a wait.
 */

let t: TestApp;
let alice: Session; // builds the leave app, and asks for leave
let bob: Session; // a manager
let carol: Session; // HR

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
    description: 'Tells payroll about leave.',
    entities: { leave_request: { read: true } },
    actions: [],
  };
  edit(definition);
  const started = await json(
    { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name, bundle: definition } },
    201,
  );
  for (const [subject, role] of [
    ['bob', 'manager'],
    ['carol', 'hr'],
  ] as const) {
    await inject({ method: 'POST', url: `/v1/apps/${started.app.id}/shares`, ...as(alice), payload: { email: `${subject}@example.com`, role } }, 201);
  }
  return started.app.id;
}

const ask = (app: string) =>
  json(
    {
      method: 'POST',
      url: `/v1/apps/${app}/actions/request_leave/run`,
      ...as(alice),
      payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: bob.userId } },
    },
    201,
  );
const inbox = async (session: Session) => (await json({ method: 'GET', url: '/v1/me/tasks?status=open', ...as(session) }, 200)).tasks;
const taskOn = async (session: Session, recordId: string, name: string) =>
  (await inbox(session)).find((task: { recordId: string; name: string }) => task.recordId === recordId && task.name === name);
const processOf = async (app: string, recordId: string) =>
  (await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${recordId}/processes`, ...as(alice) }, 200)).instances[0];
const recordOf = async (app: string, recordId: string) =>
  (await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${recordId}`, ...as(alice) }, 200)).values;
const complete = (session: Session, taskId: string, outcome: string) =>
  json({ method: 'POST', url: `/v1/tasks/${taskId}/complete`, ...as(session), payload: { outcome } }, 200);
/** Let the timers fire that are due this much later. The clock goes back after, so that sessions stay signed in. */
async function later(ms: number): Promise<void> {
  const was = t.clock.offsetMs;
  t.clock.offsetMs = was + ms;
  try {
    await t.server.processes.fireDue();
  } finally {
    t.clock.offsetMs = was;
  }
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
});

afterAll(async () => {
  await t?.close();
});

describe('a flow that waits', () => {
  it('puts the decision in the inbox of the manager the request names, and ends once it is made', async () => {
    const app = (
      await json({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name: 'Leave', template: 'leave' } }, 201)
    ).app.id;
    await inject({ method: 'POST', url: `/v1/apps/${app}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'manager' } }, 201);
    const asked = await ask(app);

    const task = await taskOn(bob, asked.record.id, 'Decide on the leave');
    expect(task).toMatchObject({
      process: 'leave_approval',
      assignee: { id: bob.userId },
      outcomes: [
        { name: 'approve', label: 'Approve', action: 'approve_leave' },
        { name: 'reject', label: 'Reject', action: 'reject_leave' },
      ],
      card: 'leave_review',
    });
    // The record shows the step its flow waits at, by the step's path.
    expect(await processOf(app, asked.record.id)).toMatchObject({
      process: 'leave_approval',
      status: 'running',
      waiting: [{ element: 'steps_0', name: 'Decide on the leave' }],
    });
    // Live, the flow's canvas counts the cases at each step: for whoever runs the app, not for a manager.
    await ask(app);
    const live = await json({ method: 'GET', url: `/v1/apps/${app}/flows/leave_approval/live`, ...as(alice) }, 200);
    expect(live).toMatchObject({ running: 2, steps: [{ path: 'steps[0]', waiting: 2, stuck: 0 }] });
    expect(Date.parse(live.steps[0].since)).toBeLessThanOrEqual(Date.now());
    await inject({ method: 'GET', url: `/v1/apps/${app}/flows/leave_approval/live`, ...as(bob) }, 403);

    await complete(bob, task.id, 'approve');
    expect(await recordOf(app, asked.record.id)).toMatchObject({ status: 'approved' });
    const done = await processOf(app, asked.record.id);
    expect(done).toMatchObject({ status: 'completed', waiting: [] });
    expect(done.events.at(-1)).toMatchObject({ kind: 'ended', element: 'end' });
  });

  it('waits for time, for two ways at once, and for the first of two things', async () => {
    const app = await leaveApp('Leave, with cover', (definition) => {
      definition['flows'].leave_approval.steps = [
        { type: 'wait', for: { duration: 'P2D' } },
        { type: 'change', record: 'leave', values: { reason: 'Waited two days' } },
        {
          type: 'all_at_once',
          ways: [
            { steps: [{ type: 'task', label: 'Book cover', role: 'manager', assignee: { field: 'manager' }, outcomes: [{ name: 'done', label: 'Done' }] }] },
            { steps: [{ type: 'task', label: 'Tell payroll', role: 'hr', outcomes: [{ name: 'done', label: 'Done' }] }] },
          ],
        },
        {
          type: 'first_of',
          ways: [
            { for: { action: 'reject_leave' }, steps: [{ type: 'return' }] },
            {
              for: { condition: { eq: [{ ref: 'leave.status' }, 'approved'] } },
              steps: [{ type: 'change', record: 'leave', values: { reason: 'Approved, and covered' } }],
            },
          ],
        },
      ];
    });
    const covered = async () => {
      const asked = await ask(app);
      const id = asked.record.id as string;
      expect(await processOf(app, id)).toMatchObject({ waiting: [{ element: 'steps_0', name: 'Waits 2 days' }] });
      // Two days on, the flow changes the record in one go, and the two ways start at once.
      await later(2 * 86_400_000 + 60_000);
      expect(await recordOf(app, id)).toMatchObject({ reason: 'Waited two days' });
      const cover = await taskOn(bob, id, 'Book cover');
      const payroll = await taskOn(carol, id, 'Tell payroll');
      expect([cover, payroll].every(Boolean)).toBe(true);
      await complete(bob, cover.id, 'done');
      // The way that has ended waits where the ways meet.
      expect((await processOf(app, id)).waiting).toEqual(
        expect.arrayContaining([
          { element: 'steps_2_join', name: 'Each way has ended' },
          { element: 'steps_2_ways_1_steps_0', name: 'Tell payroll' },
        ]),
      );
      await complete(carol, payroll.id, 'done');
      // Both ways have ended: the flow waits for the first of a rejection and an approval.
      expect((await processOf(app, id)).waiting).toEqual([{ element: 'steps_3', name: 'The first of' }]);
      return id;
    };

    const approved = await covered();
    await inject({ method: 'POST', url: `/v1/apps/${app}/actions/approve_leave/run`, ...as(bob), payload: { recordId: approved } }, 200);
    expect(await recordOf(app, approved)).toMatchObject({ status: 'approved', reason: 'Approved, and covered' });
    expect(await processOf(app, approved)).toMatchObject({ status: 'completed' });

    const rejected = await covered();
    await inject({ method: 'POST', url: `/v1/apps/${app}/actions/reject_leave/run`, ...as(bob), payload: { recordId: rejected } }, 200);
    expect(await recordOf(app, rejected)).toMatchObject({ status: 'rejected', reason: 'Waited two days' });
    const ended = await processOf(app, rejected);
    expect(ended).toMatchObject({ status: 'completed' });
    expect(ended.events.at(-1)).toMatchObject({ kind: 'ended', element: 'steps_3_ways_0_steps_0' });
  });

  it('starts on a record by hand, for a role that may run it, and never runs in one go', async () => {
    const app = await leaveApp('Leave, by hand', (definition) => {
      delete definition['actions'].request_leave.flow;
      definition['roles'].manager.flows = ['leave_approval'];
    });
    const asked = await ask(app);
    expect(await processOf(app, asked.record.id)).toBeUndefined();
    const refused = await json(
      { method: 'POST', url: `/v1/apps/${app}/flows/leave_approval/run`, ...as(bob), payload: { input: { leave: asked.record.id } } },
      409,
    );
    expect(refused).toMatchObject({ error: 'flow_waits' });
    await inject({ method: 'POST', url: `/v1/apps/${app}/processes/leave_approval/start`, ...as(carol), payload: { recordId: asked.record.id } }, 403);
    const started = await json(
      { method: 'POST', url: `/v1/apps/${app}/processes/leave_approval/start`, ...as(bob), payload: { recordId: asked.record.id } },
      201,
    );
    expect(started).toMatchObject({ process: 'leave_approval', waiting: [{ element: 'steps_0', name: 'Decide on the leave' }] });
  });

  it('refuses a value kept in a variable across a wait, on the step that reads it', async () => {
    const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
    definition['flows'].leave_approval.steps.unshift({ type: 'set', var: 'asked_on', value: { today: true } });
    definition['flows'].leave_approval.steps.push({ type: 'change', record: 'leave', values: { decided_on: { ref: 'asked_on' } } });
    const refused = await json(
      { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Leave, kept', definition } },
      422,
    );
    expect(refused.details.issues).toEqual([
      {
        path: 'flows.leave_approval.steps[2].values.decided_on',
        message: "asked_on: asked_on doesn't live on after the flow waits. Keep the value in a field of the record, and read it from there",
      },
    ]);
  });
});
