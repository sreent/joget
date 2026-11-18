import { LEAVE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Dates in conditions (design §6.2): a rule that a leave can't start in the past, a query of the
 * leave still to come, worked out in the database, and values worked out with dates and text.
 */

let t: TestApp;
let alice: Session;
let bob: Session;

const as = (session: Session) => ({ cookies: session.cookies });
async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const json = async (options: InjectOptions, expected: number) => (await inject(options, expected)).json();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob] = [await t.login('alice'), await t.login('bob')];
});

afterAll(async () => {
  await t?.close();
});

describe('dates in conditions', () => {
  it('check a leave against today, find what is still to come, and work values out with dates and text', async () => {
    const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
    definition['rules'].starts_ahead = {
      entity: 'leave_request',
      assert: { gte: [{ ref: 'record.starts' }, { today: 0 }] },
      message: "The leave can't start in the past",
      fields: ['starts'],
    };
    definition['rules'].ends_after = {
      entity: 'leave_request',
      assert: { gte: [{ ref: 'record.ends' }, { ref: 'record.starts' }] },
      message: 'The leave ends on or after its first day',
      fields: ['ends'],
    };
    definition['queries'].upcoming = {
      label: 'Leave to come',
      description: 'The leave of the person you act for that starts within the next 30 days.',
      entity: 'leave_request',
      fields: ['starts', 'days'],
      filter: {
        all: [
          { eq: [{ ref: 'record.owner' }, { ref: 'principal.id' }] },
          { gte: [{ ref: 'record.starts' }, { today: 0 }] },
          { lt: [{ ref: 'record.starts' }, { today: 30 }] },
        ],
      },
    };
    definition['roles'].employee.queries.push('upcoming');
    // The request works out its reason from the dates, in capitals, when the employee gives none.
    definition['actions'].request_leave.steps = [
      {
        type: 'set',
        field: 'reason',
        value: {
          if: [
            { exists: 'record.reason' },
            { ref: 'record.reason' },
            { upper: [{ concat: ['Leave of ', { days_between: [{ ref: 'record.starts' }, { ref: 'record.ends' }] }, ' days'] }] },
          ],
        },
      },
    ];
    const app = (
      await json({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Leave, with dates', definition } }, 201)
    ).app.id;
    const ask = (starts: string, ends: string, expected: number) =>
      inject(
        {
          method: 'POST',
          url: `/v1/apps/${app}/actions/request_leave/run`,
          ...as(alice),
          payload: { values: { kind: 'annual', starts, ends, days: 2, manager: bob.userId } },
        },
        expected,
      );

    const late = (await ask(day(-1), day(1), 422)).json();
    expect(JSON.stringify(late)).toContain("The leave can't start in the past");
    expect(JSON.stringify((await ask(day(5), day(3), 422)).json())).toContain('The leave ends on or after its first day');
    const soon = (await ask(day(3), day(5), 201)).json();
    await ask(day(60), day(62), 201);

    const record = await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${soon.record.id}`, ...as(alice) }, 200);
    expect(record.values.reason).toBe('LEAVE OF 2 DAYS');
    // Worked out in the database: only the leave within the next 30 days.
    const upcoming = await json({ method: 'POST', url: `/v1/apps/${app}/queries/upcoming/run`, ...as(alice), payload: {} }, 200);
    expect(JSON.stringify(upcoming)).toContain(day(3));
    expect(JSON.stringify(upcoming)).not.toContain(day(60));
  });
});
