import { EXPENSE_APP, LEAVE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Flows, end to end (design §6.2): an action runs one in its own transaction; a process task runs
 * one with the app's authority; roles run them through the API. A flow finds, creates, changes and
 * deletes records, loops, totals, calls other flows and catches errors. A failure undoes it all.
 */

let t: TestApp;
let alice: Session; // builds the app
let bob: Session; // requester
let carol: Session; // approver
let appId: string;

type Json = Record<string, any>;
const as = (session: Session) => ({ cookies: session.cookies });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const line = (merchant: string, category: string, amount: number) => ({ date: '2026-11-02', merchant, category, amount });

async function inject(options: InjectOptions, expected: number): Promise<Json> {
  const response = await t.app.inject(options);
  expect(response.statusCode, response.body).toBe(expected);
  return response.body ? response.json() : {};
}
const run = (session: Session | string, flow: string, payload: Json = {}, expected = 200) =>
  inject({ method: 'POST', url: `/v1/apps/${appId}/flows/${flow}/run`, ...(typeof session === 'string' ? bearer(session) : as(session)), payload }, expected);
const budgets = async () =>
  Object.fromEntries(
    ((await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/budget/records?limit=50`, ...as(alice) }, 200)).records as Json[]).map((record) => [record.values.category, record.values.spent]),
  );
async function claim(title: string, lines: Json[], trip = 'Singapore') {
  return (await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(bob), payload: { values: { title, trip, lines, iban: 'SG11 BOB' } } }, 201)).record;
}

/** The example app, with a budget for each category that its approval keeps up to date. */
function withFlows(): Json {
  const draft = structuredClone(EXPENSE_APP) as unknown as Json;
  draft.entities.budget = {
    label: 'Budget',
    fields: [
      { name: 'category', label: 'Category', type: 'text', required: true, unique: true },
      { name: 'spent', label: 'Spent', type: 'number', decimals: 2 },
      { name: 'cap', label: 'Cap', type: 'number', decimals: 2 },
    ],
  };
  draft.roles.approver.entities.budget = { read: true };
  draft.roles.approver.flows = ['over_budget', 'report'];
  draft.flows = {
    ...draft.flows,
    record_spend: {
      label: 'Record the spend',
      input: { claim: { type: 'record', entity: 'expense_claim' } },
      output: { type: 'number' },
      steps: [
        { type: 'check', assert: { ne: [{ ref: 'claim.trip' }, 'Mars'] }, message: 'Nobody travels to Mars on expenses' },
        {
          type: 'each',
          in: 'claim.lines',
          as: 'line',
          steps: [
            { type: 'find', var: 'budget', entity: 'budget', where: { eq: [{ ref: 'record.category' }, { ref: 'line.category' }] }, first: true },
            {
              type: 'if',
              when: { exists: 'budget.id' },
              then: [{ type: 'change', record: 'budget', values: { spent: { add: [{ ref: 'budget.spent' }, { ref: 'line.amount' }] } } }],
              else: [{ type: 'create', entity: 'budget', values: { category: { ref: 'line.category' }, spent: { ref: 'line.amount' }, cap: 500 }, var: 'budget' }],
            },
          ],
        },
        { type: 'total', var: 'spent', of: 'claim.lines', op: 'sum', field: 'amount' },
        { type: 'return', value: { ref: 'spent' } },
      ],
    },
    over_budget: {
      label: 'Budgets over their cap',
      output: { type: 'number' },
      steps: [
        { type: 'find', var: 'all', entity: 'budget', limit: 100 },
        { type: 'set', var: 'over', value: 0 },
        { type: 'each', in: 'all', as: 'budget', steps: [{ type: 'if', when: { gt: [{ ref: 'budget.spent' }, { ref: 'budget.cap' }] }, then: [{ type: 'set', var: 'over', value: { add: [{ ref: 'over' }, 1] } }] }] },
        { type: 'return', value: { ref: 'over' } },
      ],
    },
    report: {
      label: 'Report',
      input: { prefix: { type: 'text' } },
      output: { type: 'text' },
      steps: [
        { type: 'call', flow: 'over_budget', var: 'over' },
        { type: 'return', value: { concat: [{ ref: 'prefix' }, { ref: 'over' }] } },
      ],
    },
    open_budget: {
      label: 'Open a budget',
      input: { category: { type: 'text' } },
      output: { type: 'text' },
      steps: [
        { type: 'set', var: 'said', value: 'opened' },
        {
          type: 'try',
          steps: [{ type: 'create', entity: 'budget', values: { category: { ref: 'category' }, spent: 0, cap: 100 } }],
          catch: [{ type: 'set', var: 'said', value: { concat: ['not opened: ', { ref: 'why' }] } }],
          error: 'why',
        },
        { type: 'return', value: { ref: 'said' } },
      ],
    },
    clear_unused: {
      label: 'Clear unused budgets',
      output: { type: 'number' },
      steps: [
        { type: 'find', var: 'unused', entity: 'budget', where: { eq: [{ ref: 'record.spent' }, 0] }, limit: 100 },
        { type: 'each', in: 'unused', as: 'budget', steps: [{ type: 'delete', record: 'budget' }] },
        { type: 'total', var: 'cleared', of: 'unused', op: 'count' },
        { type: 'return', value: { ref: 'cleared' } },
      ],
    },
  };
  draft.actions.approve_claim.flow = { flow: 'record_spend', input: { claim: { ref: 'record' } } };
  return draft;
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
  appId = (await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: withFlows() } }, 201)).app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'carol@example.com', role: 'approver' } }, 201);
});

afterAll(async () => {
  await t?.close();
});

describe('flows', () => {
  it('run when an action saves, in its transaction: loop over lines, find, create and change related records', async () => {
    const first = await claim('Singapore trip', [line('Cafe', 'meals', 12), line('Marina Bay', 'hotel', 300)]);
    await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/approve_claim/run`, ...as(carol), payload: { recordId: first.id } }, 200);
    expect(await budgets()).toEqual({ meals: 12, hotel: 300 });

    const second = await claim('Kuala Lumpur', [line('Hawker', 'meals', 8.5), line('Shangri-La', 'hotel', 280)]);
    await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/approve_claim/run`, ...as(carol), payload: { recordId: second.id } }, 200);
    expect(await budgets()).toEqual({ meals: 20.5, hotel: 580 });

    // The writes are Carol's, made through the flow; the audit log names both.
    const runs = await t.handle.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'flow.run'), eq(auditEvents.appId, appId)));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ actor: { type: 'user', id: carol.userId }, reason: { trigger: { kind: 'action', name: 'approve_claim' }, writes: { created: 2, changed: 0, deleted: 0 } } });
    const created = await t.handle.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'record.create'), eq(auditEvents.appId, appId)));
    expect(created.filter((event) => (event.context as Json)['flow'] === 'record_spend')).toHaveLength(2);
  });

  it('undo the whole action when a check fails', async () => {
    const mars = await claim('Red planet', [line('Rocket', 'travel', 99)], 'Mars');
    const refused = await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/approve_claim/run`, ...as(carol), payload: { recordId: mars.id } }, 422);
    expect(refused).toMatchObject({ error: 'rule_failed', message: 'Nobody travels to Mars on expenses' });
    expect((await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/expense_claim/records/${mars.id}`, ...as(bob) }, 200)).values.status).toBe('submitted');
    expect(await budgets()).toEqual({ meals: 20.5, hotel: 580 });
  });

  it('run through the API for the roles that name them, call other flows, and show a dry run', async () => {
    await inject({ method: 'PATCH', url: `/v1/apps/${appId}/entities/budget/records/${(await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/budget/records?limit=50`, ...as(alice) }, 200)).records.find((r: Json) => r.values.category === 'hotel').id}`, ...as(alice), payload: { values: { cap: 500 } } }, 200);
    expect(await run(carol, 'over_budget')).toEqual({ output: 1, findings: [], writes: { created: 0, changed: 0, deleted: 0 }, dryRun: false });
    expect((await run(carol, 'report', { input: { prefix: 'Over: ' } })).output).toBe('Over: 1');
    expect((await run(bob, 'over_budget', {}, 403)).error).toBe('forbidden');
    expect((await run(carol, 'report', { input: {} }, 422)).details.issues).toEqual([{ field: 'prefix', message: 'Give prefix' }]);

    // A dry run does it all, and then undoes it.
    const dry = await run(alice, 'open_budget', { input: { category: 'parking' }, dryRun: true });
    expect(dry).toMatchObject({ output: 'opened', writes: { created: 1 }, dryRun: true });
    expect(Object.keys(await budgets())).not.toContain('parking');
  });

  it('catch an error, undo the steps it covers, and go on', async () => {
    expect((await run(alice, 'open_budget', { input: { category: 'parking' } })).output).toBe('opened');
    const again = await run(alice, 'open_budget', { input: { category: 'parking' } });
    expect(again).toMatchObject({ output: 'not opened: Another record already has that value in a unique field', writes: { created: 0 } });
    expect(Object.keys(await budgets()).filter((category) => category === 'parking')).toHaveLength(1);
  });

  it("delete only by a person's hand: a token may try it, and a person does it", async () => {
    const script = (await inject({ method: 'POST', url: '/v1/me/tokens', ...as(alice), payload: { name: 'script', scopes: ['app.run', 'flow.run', 'record.read'] } }, 201)).token;
    expect(await run(script, 'clear_unused', {}, 403)).toMatchObject({ error: 'session_required', details: { step: 'data.delete' } });
    expect(await run(script, 'clear_unused', { dryRun: true })).toMatchObject({ output: 1, writes: { deleted: 1 }, dryRun: true });
    expect(Object.keys(await budgets())).toContain('parking');
    expect((await run(alice, 'clear_unused')).output).toBe(1);
    expect(Object.keys(await budgets())).not.toContain('parking');
  });

  it("run between the waits of a flow that waits, with the app's authority, and leave nothing behind when they fail", async () => {
    const leave = structuredClone(LEAVE_APP) as unknown as Json;
    leave.entities.leave_request.fields.push({ name: 'remark', label: 'Remark', type: 'text' });
    // Once the manager approves, the flow stamps the request, and checks it in the same go.
    leave.flows.leave_approval.steps[0].outcomes[0].steps = [
      { type: 'change', record: 'leave', values: { remark: { concat: ['Approved for ', { ref: 'leave.days' }, ' days'] } } },
      { type: 'check', assert: { lt: [{ ref: 'leave.days' }, 20] }, message: 'Long leave needs HR' },
    ];
    const leaveId = (await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Leave', definition: leave } }, 201)).app.id;
    await inject({ method: 'POST', url: `/v1/apps/${leaveId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'manager' } }, 201);

    const ask = async (days: number) =>
      (await inject({ method: 'POST', url: `/v1/apps/${leaveId}/actions/request_leave/run`, ...as(alice), payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days, manager: bob.userId } } }, 201)).record;
    const decide = async (recordId: string) => {
      const task = (await inject({ method: 'GET', url: '/v1/me/tasks', ...as(bob) }, 200)).tasks.find((each: Json) => each.recordId === recordId);
      await inject({ method: 'POST', url: `/v1/tasks/${task.id}/complete`, ...as(bob), payload: { outcome: 'approve' } }, 200);
    };
    const short = await ask(4);
    await decide(short.id);
    expect((await inject({ method: 'GET', url: `/v1/apps/${leaveId}/entities/leave_request/records/${short.id}`, ...as(alice) }, 200)).values.remark).toBe('Approved for 4 days');

    // A long leave fails the flow's check: its change is undone, and the instance waits for an operator.
    const long = await ask(25);
    await decide(long.id);
    expect((await inject({ method: 'GET', url: `/v1/apps/${leaveId}/entities/leave_request/records/${long.id}`, ...as(alice) }, 200)).values.remark).toBeNull();
    const [stuck] = (await inject({ method: 'GET', url: `/v1/apps/${leaveId}/process-instances?stuck=true`, ...as(alice) }, 200)).instances;
    expect(stuck).toMatchObject({ recordId: long.id, stuck: [{ element: 'steps_0_outcomes_0_steps_0', error: 'Leave approval: change and check: Long leave needs HR' }] });
    // Live, the canvas shows the case stuck at the stamp.
    expect((await inject({ method: 'GET', url: `/v1/apps/${leaveId}/flows/leave_approval/live`, ...as(alice) }, 200)).steps).toEqual([
      expect.objectContaining({ path: 'steps[0].outcomes[0].steps[0]', waiting: 0, stuck: 1 }),
    ]);
    // The decision before the stamp stays: a failure after the flow saves can't undo it.
    expect((await inject({ method: 'GET', url: `/v1/apps/${leaveId}/entities/leave_request/records/${long.id}`, ...as(alice) }, 200)).values.status).toBe('approved');
  });
});
