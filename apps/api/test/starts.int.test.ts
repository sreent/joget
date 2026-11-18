import { LEAVE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Flows that start by themselves (design §6.11). A flow that waits starts on a record as the
 * record is created, a time after a date of it, or when a change makes a condition on it hold. A
 * task reminds while it waits, and steps that wait repeat while a condition holds. A flow that
 * needs no input runs on a schedule, once at each time, with the app's authority.
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
async function leaveApp(name: string, edit: (definition: Record<string, any>) => void): Promise<string> {
  const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
  definition['roles'].hr = { label: 'HR', description: 'Tells payroll about leave.', entities: { leave_request: { read: true } }, actions: [] };
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

const ask = async (app: string, reason = 'Holiday') =>
  (
    await json(
      {
        method: 'POST',
        url: `/v1/apps/${app}/actions/request_leave/run`,
        ...as(alice),
        payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, reason, manager: bob.userId } },
      },
      201,
    )
  ).record.id as string;
const inbox = async (session: Session) => (await json({ method: 'GET', url: '/v1/me/tasks?status=open', ...as(session) }, 200)).tasks;
const tasksOn = async (session: Session, recordId: string, name: string) =>
  (await inbox(session)).filter((task: { recordId: string; name: string }) => task.recordId === recordId && task.name === name);
const processesOf = async (app: string, recordId: string) =>
  (await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${recordId}/processes`, ...as(alice) }, 200)).instances;
const recordOf = async (app: string, recordId: string) =>
  (await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${recordId}`, ...as(alice) }, 200)).values;
const complete = (session: Session, taskId: string, outcome: string) =>
  json({ method: 'POST', url: `/v1/tasks/${taskId}/complete`, ...as(session), payload: { outcome } }, 200);
/** Let the timers fire, and the scheduled flows run, that are due at a time. The clock goes back after, so that sessions stay signed in. */
async function at(time: string | number): Promise<void> {
  const was = t.clock.offsetMs;
  t.clock.offsetMs = (typeof time === 'number' ? Date.now() + time : Date.parse(time)) - Date.now();
  try {
    await t.server.processes.fireDue();
    await t.server.schedules.runDue();
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

describe('a flow that starts by itself', () => {
  it('starts as a record is created, when a condition comes to hold, and a day after a date of the record', async () => {
    const app = await leaveApp('Leave, by itself', (definition) => {
      delete definition['actions'].request_leave.flow;
      const approval = definition['flows'].leave_approval;
      approval.starts = [{ created: true }];
      approval.steps[0].reminders = [{ after: 'P1D', steps: [{ type: 'change', record: 'leave', values: { reason: 'Reminded' } }] }];
      definition['flows'].payroll = {
        label: 'Tell payroll',
        input: { leave: { type: 'record', entity: 'leave_request' } },
        starts: [{ condition: { eq: [{ ref: 'leave.status' }, 'approved'] } }],
        steps: [{ type: 'task', label: 'Tell payroll', role: 'hr', outcomes: [{ name: 'done', label: 'Done' }] }],
      };
      definition['flows'].welcome_back = {
        label: 'Welcome back',
        input: { leave: { type: 'record', entity: 'leave_request' } },
        starts: [{ date: 'ends', after: 'P1D' }],
        steps: [{ type: 'task', label: 'Welcome back', role: 'manager', assignee: { field: 'manager' }, outcomes: [{ name: 'done', label: 'Done' }] }],
      };
    });
    const id = await ask(app);
    // No action starts the approval: the record's creation does.
    expect(await processesOf(app, id)).toMatchObject([
      { process: 'leave_approval', status: 'running', waiting: [{ element: 'steps_0', name: 'Decide on the leave' }] },
    ]);
    const [task] = await tasksOn(bob, id, 'Decide on the leave');
    expect(task).toBeDefined();

    // A day on, the reminder changes the record; the task still waits.
    await at(86_400_000 + 60_000);
    expect(await recordOf(app, id)).toMatchObject({ reason: 'Reminded' });
    expect(await tasksOn(bob, id, 'Decide on the leave')).toHaveLength(1);

    // The approval makes the payroll flow's condition hold.
    expect(await tasksOn(carol, id, 'Tell payroll')).toEqual([]);
    await complete(bob, task.id, 'approve');
    expect(await tasksOn(carol, id, 'Tell payroll')).toHaveLength(1);

    // The day after the last day of leave, the manager welcomes the person back.
    await at('2026-12-24T23:59:00Z');
    expect(await tasksOn(bob, id, 'Welcome back')).toEqual([]);
    await at('2026-12-25T00:01:00Z');
    expect(await tasksOn(bob, id, 'Welcome back')).toHaveLength(1);
    expect((await processesOf(app, id)).map((instance: { process: string }) => instance.process).sort()).toEqual(['leave_approval', 'payroll', 'welcome_back']);
  });

  it('repeats steps that wait while a condition on the record holds, up to its most times', async () => {
    const app = await leaveApp('Leave, again', (definition) => {
      definition['flows'].leave_approval.steps = [
        {
          type: 'repeat',
          while: { eq: [{ ref: 'leave.status' }, 'submitted'] },
          max: 2,
          steps: [
            {
              type: 'task',
              label: 'Decide',
              role: 'manager',
              assignee: { field: 'manager' },
              outcomes: [
                { name: 'approve', label: 'Approve', action: 'approve_leave' },
                { name: 'later', label: 'Decide later' },
              ],
            },
            { type: 'change', record: 'leave', values: { reason: 'Looked at' } },
          ],
        },
      ];
    });
    const approved = await ask(app);
    await complete(bob, (await tasksOn(bob, approved, 'Decide'))[0].id, 'later');
    // The condition still holds: the manager decides again.
    const again = await tasksOn(bob, approved, 'Decide');
    expect(again).toHaveLength(1);
    await complete(bob, again[0].id, 'approve');
    expect(await recordOf(app, approved)).toMatchObject({ status: 'approved', reason: 'Looked at' });
    expect(await processesOf(app, approved)).toMatchObject([{ status: 'completed' }]);

    // Twice at most: then the flow goes on, and ends.
    const put = await ask(app);
    for (let time = 0; time < 2; time++) await complete(bob, (await tasksOn(bob, put, 'Decide'))[0].id, 'later');
    expect(await tasksOn(bob, put, 'Decide')).toEqual([]);
    expect(await processesOf(app, put)).toMatchObject([{ status: 'completed' }]);
    expect(await recordOf(app, put)).toMatchObject({ status: 'submitted' });
  });
});

describe('a flow on a schedule', () => {
  it('runs once at each time, with the app’s authority, and stops when its schedule goes', async () => {
    const tidy = {
      label: 'Tidy up',
      schedule: { every: 'day', at: '07:00' },
      steps: [
        { type: 'find', var: 'open', entity: 'leave_request', where: { eq: [{ ref: 'record.status' }, 'submitted'] } },
        { type: 'each', in: 'open', as: 'request', steps: [{ type: 'change', record: 'request', values: { reason: 'Tidied' } }] },
      ],
    };
    const app = await leaveApp('Leave, tidied', (definition) => {
      definition['flows'].tidy = tidy;
    });
    const [first, second] = [await ask(app), await ask(app)];
    const live = async () => json({ method: 'GET', url: `/v1/apps/${app}/flows/tidy/live`, ...as(alice) }, 200);
    const planned = await live();
    const next = new Date(Date.now());
    next.setUTCHours(7, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    expect(planned.schedule).toEqual({ nextRunAt: next.toISOString(), lastRunAt: null, lastError: null });

    const around = (ms: number) => new Date(next.getTime() + ms).toISOString();
    await at(around(-60_000));
    expect(await recordOf(app, first)).toMatchObject({ reason: 'Holiday' });
    await at(around(60_000));
    for (const id of [first, second]) expect(await recordOf(app, id)).toMatchObject({ reason: 'Tidied' });
    const history = await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${first}/history`, ...as(alice) }, 200);
    expect(history.history.map((entry: { actor: { type: string } }) => entry.actor.type)).toContain('schedule');
    const after = await live();
    expect(after.schedule.nextRunAt).toBe(new Date(next.getTime() + 86_400_000).toISOString());
    expect(Date.parse(after.schedule.lastRunAt)).toBeGreaterThan(next.getTime());

    // Once at each time: the same time again runs nothing.
    await inject(
      { method: 'PATCH', url: `/v1/apps/${app}/entities/leave_request/records/${first}`, ...as(alice), payload: { values: { reason: 'Back again' } } },
      200,
    );
    await at(around(120_000));
    expect(await recordOf(app, first)).toMatchObject({ reason: 'Back again' });

    // A definition without the schedule stops it.
    const current = await json({ method: 'GET', url: `/v1/apps/${app}/definition`, ...as(alice) }, 200);
    delete current.definition.flows.tidy.schedule;
    await inject({ method: 'PUT', url: `/v1/apps/${app}/definition`, ...as(alice), payload: { definition: current.definition } }, 200);
    expect((await live()).schedule).toBeUndefined();
  });

  it('refuses a schedule on a flow that waits, or that needs input', async () => {
    const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
    definition['flows'].leave_approval.schedule = { every: 'day', at: '07:00' };
    const refused = await json(
      { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Leave, at seven', definition } },
      422,
    );
    expect(refused.details.issues).toEqual([
      {
        path: 'flows.leave_approval.schedule',
        message: 'A flow that waits keeps its place on one record, so it starts on records, not on a schedule: say how in its starts',
      },
    ]);
  });
});
