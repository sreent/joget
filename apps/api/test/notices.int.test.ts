import { LEAVE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { desc, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mail } from '../src/notices/mail.js';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Notices (design §6.12). A flow tells people in the app, and by email to each who takes it; a
 * task tells whom it waits for as it opens, when it is due soon and when it is overdue. A notice
 * goes only to people the app is shared with, and each person reads only their own.
 */

let t: TestApp;
let alice: Session; // builds the leave app, and asks for leave
let bob: Session; // a manager
let dave: Session; // nobody shared the app with him
const sent: Mail[] = [];

const as = (session: Session) => ({ cookies: session.cookies });
async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const json = async (options: InjectOptions, expected: number) => (await inject(options, expected)).json();
const noticesOf = async (session: Session, unread = false) =>
  json({ method: 'GET', url: `/v1/me/notices${unread ? '?unread=true' : ''}`, ...as(session) }, 200);
/** Do what time brings at a time: the timers, the task deadlines and the emails. The clock goes back after, so that sessions stay signed in. */
async function at(time: number): Promise<void> {
  const was = t.clock.offsetMs;
  t.clock.offsetMs = time - Date.now();
  try {
    await t.server.processes.fireDue();
    await t.server.notices.taskDeadlines();
    await t.server.notices.deliverDue();
  } finally {
    t.clock.offsetMs = was;
  }
}

beforeAll(async () => {
  t = await startTestApp({}, { mailer: { send: async (mail) => void sent.push(mail) } });
  [alice, bob, dave] = [await t.login('alice'), await t.login('bob'), await t.login('dave')];
});

afterAll(async () => {
  await t?.close();
});

describe('notices', () => {
  it('tell the manager a task came, tell the requester what was decided, and go by email', async () => {
    const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
    const approve = definition['flows'].leave_approval.steps[0].outcomes[0];
    approve.steps = [
      {
        type: 'inform',
        to: [{ person: { ref: 'leave.owner' } }, { person: { ref: 'leave.manager' } }],
        title: { concat: ['Your leave of ', { ref: 'leave.days' }, ' days is approved'] },
        message: { concat: ['It starts on ', { ref: 'leave.starts' }] },
        about: 'leave',
      },
    ];
    const app = (
      await json({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name: 'Leave', bundle: definition } }, 201)
    ).app.id;
    await inject({ method: 'POST', url: `/v1/apps/${app}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'manager' } }, 201);
    const asked = await json(
      {
        method: 'POST',
        url: `/v1/apps/${app}/actions/request_leave/run`,
        ...as(alice),
        payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: bob.userId } },
      },
      201,
    );

    // The task tells Bob it came to him, in the app and by email.
    const bobs = await noticesOf(bob);
    expect(bobs).toMatchObject({
      unread: 1,
      notices: [
        {
          kind: 'task_assigned',
          title: 'Decide on the leave',
          app: { id: app, name: 'Leave' },
          about: { entity: 'leave_request', recordId: asked.record.id, label: 'Leave request: Annual leave' },
        },
      ],
    });
    expect(bobs.notices[0].message).toMatch(/^It waits for you, by /);
    await t.server.notices.deliverDue();
    expect(sent).toEqual([expect.objectContaining({ to: 'bob@example.com', subject: 'Leave: Decide on the leave' })]);
    expect(sent[0]!.text).toContain('/studio/tasks');

    // Bob turns email off: notices still come in the app.
    expect(await json({ method: 'PUT', url: '/v1/me/notices/settings', ...as(bob), payload: { email: false } }, 200)).toEqual({
      email: false,
      emailAvailable: true,
    });
    const task = (await json({ method: 'GET', url: '/v1/me/tasks?status=open', ...as(bob) }, 200)).tasks.find(
      (each: { recordId: string }) => each.recordId === asked.record.id,
    );
    await json({ method: 'POST', url: `/v1/tasks/${task.id}/complete`, ...as(bob), payload: { outcome: 'approve' } }, 200);
    // The flow tells Alice and Bob, with words from the record, and links to it.
    const alices = await noticesOf(alice, true);
    expect(alices.notices).toEqual([
      expect.objectContaining({
        kind: 'inform',
        title: 'Your leave of 4 days is approved',
        message: 'It starts on 2026-12-21',
        about: { entity: 'leave_request', recordId: asked.record.id, label: 'Leave request: Annual leave' },
      }),
    ]);
    expect((await noticesOf(bob, true)).notices.map((notice: { title: string }) => notice.title)).toEqual([
      'Your leave of 4 days is approved',
      'Decide on the leave',
    ]);
    sent.length = 0;
    await t.server.notices.deliverDue();
    expect(sent.map((mail) => mail.to)).toEqual(['alice@example.com']);
    expect(sent[0]!.text).toContain(`/studio/apps/${app}/leave_request/${asked.record.id}`);

    // Each reads only their own, and marks what they saw read.
    await inject({ method: 'POST', url: '/v1/me/notices/read', ...as(dave), payload: { ids: [alices.notices[0].id] } }, 200);
    expect((await noticesOf(alice, true)).unread).toBe(1);
    expect(await json({ method: 'POST', url: '/v1/me/notices/read', ...as(alice), payload: { ids: [alices.notices[0].id] } }, 200)).toEqual({ unread: 0 });
    expect(await json({ method: 'POST', url: '/v1/me/notices/read', ...as(bob), payload: { upTo: new Date(Date.now() + 1000).toISOString() } }, 200)).toEqual({
      unread: 0,
    });
    expect(await json({ method: 'GET', url: '/v1/me/notices/unread', ...as(bob) }, 200)).toEqual({ unread: 0 });
  });

  it('go only to people the app is shared with', async () => {
    const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
    definition['flows'].tell = {
      label: 'Tell the manager',
      input: { leave: { type: 'record', entity: 'leave_request' } },
      steps: [{ type: 'inform', to: [{ person: { ref: 'leave.manager' } }], title: 'A leave request', about: 'leave', email: false }],
    };
    delete definition['actions'].request_leave.flow;
    definition['actions'].request_leave.flow = { flow: 'tell', input: { leave: { ref: 'record' } } };
    const app = (
      await json(
        { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name: 'Leave, told', bundle: definition } },
        201,
      )
    ).app.id;
    // Dave is named as the manager, but the app isn't shared with him.
    await json(
      {
        method: 'POST',
        url: `/v1/apps/${app}/actions/request_leave/run`,
        ...as(alice),
        payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: dave.userId } },
      },
      201,
    );
    expect((await noticesOf(dave)).notices.filter((notice: { app: { id: string } }) => notice.app.id === app)).toEqual([]);
    const [event] = await t.ctx.db.select().from(auditEvents).where(eq(auditEvents.action, 'flow.run')).orderBy(desc(auditEvents.occurredAt)).limit(1);
    expect(event?.reason).toMatchObject({ told: { people: 0, left: 1 } });
  });

  it('tell whom a task waits for that it is due soon, and that it is overdue, once each', async () => {
    const app = (
      await json(
        { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name: 'Leave, due', template: 'leave' } },
        201,
      )
    ).app.id;
    await inject({ method: 'POST', url: `/v1/apps/${app}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'manager' } }, 201);
    await inject({ method: 'PUT', url: '/v1/me/notices/settings', ...as(bob), payload: { email: true } }, 200);
    await json(
      {
        method: 'POST',
        url: `/v1/apps/${app}/actions/request_leave/run`,
        ...as(alice),
        payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: bob.userId } },
      },
      201,
    );
    const task = (await json({ method: 'GET', url: '/v1/me/tasks?status=open', ...as(bob) }, 200)).tasks.find(
      (each: { app: { id: string } }) => each.app.id === app,
    );
    const due = Date.parse(task.due);
    const titles = async () =>
      (await noticesOf(bob)).notices.filter((notice: { app: { id: string } }) => notice.app.id === app).map((notice: { title: string }) => notice.title);
    await at(due - 25 * 3_600_000);
    expect(await titles()).toEqual(['Decide on the leave']);
    await at(due - 12 * 3_600_000);
    await at(due - 11 * 3_600_000);
    expect(await titles()).toEqual(['Due soon: Decide on the leave', 'Decide on the leave']);
    sent.length = 0;
    await at(due + 3_600_000);
    await at(due + 2 * 3_600_000);
    expect(await titles()).toEqual(['Overdue: Decide on the leave', 'Due soon: Decide on the leave', 'Decide on the leave']);
    expect(sent.map((mail) => mail.subject)).toEqual(['Leave, due: Overdue: Decide on the leave']);
  });
});
