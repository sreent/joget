import { EXPENSE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * An app's tests, end to end (design §6.7): each makes its records, has someone in a role run an
 * action, and checks what comes of it, in a transaction that is undone. The builder runs them, and
 * every change request runs them on its preview: a test that fails stops the merge.
 */

let t: TestApp;
let alice: Session; // owns the Finance space, and builds a personal app
let carol: Session; // builder
let dave: Session; // reviewer
let erin: Session; // release manager
let olivia: Session; // the other owner of the Finance space

type Json = Record<string, any>;
const as = (session: Session) => ({ cookies: session.cookies });
const receipt = { date: '2026-11-02', merchant: 'Comfort', category: 'travel', amount: 25 };

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const json = async (options: InjectOptions, expected: number): Promise<Json> => (await inject(options, expected)).json();

/** The example's tests: what a requester and an approver may do, and one that expects a wrong total. */
const TESTS = {
  submits: {
    label: 'A requester submits a claim',
    when: { action: 'submit_claim', as: 'requester', values: { title: 'Taxi', lines: [receipt] } },
    then: { outcome: 'saved', values: { status: 'submitted', total: 25, lines: [{ merchant: 'Comfort', amount: 25 }] } },
  },
  own: {
    label: 'Nobody approves their own claim',
    given: { mine: { entity: 'expense_claim', values: { title: 'Taxi', lines: [receipt], status: 'submitted' } } },
    when: { action: 'approve_claim', as: 'approver', record: 'mine' },
    then: { outcome: 'refused', message: "can't approve your own claim" },
  },
  requester_cannot_approve: {
    label: "A requester can't approve",
    given: { mine: { entity: 'expense_claim', values: { title: 'Taxi', lines: [receipt], status: 'submitted' } } },
    when: { action: 'approve_claim', as: 'requester', record: 'mine' },
    then: { outcome: 'refused' },
  },
  wrong_total: {
    label: 'A claim adds up its receipts',
    when: { action: 'submit_claim', as: 'requester', values: { title: 'Taxi', lines: [receipt, receipt] } },
    then: { outcome: 'saved', values: { total: 60 } },
  },
  no_title: {
    label: 'A test whose record has no title',
    given: { bad: { entity: 'expense_claim', values: { lines: [receipt] } } },
    when: { action: 'approve_claim', as: 'approver', record: 'bad' },
    then: { outcome: 'refused' },
  },
};

const withTests = (tests: Json) => ({ ...structuredClone(EXPENSE_APP), tests });

beforeAll(async () => {
  t = await startTestApp();
  [alice, carol, dave, erin, olivia] = [await t.login('alice'), await t.login('carol'), await t.login('dave'), await t.login('erin'), await t.login('olivia')];
});

afterAll(async () => {
  await t?.close();
});

describe("a personal app's tests", () => {
  it('run each as someone in its role, report what came of it, and leave nothing behind', async () => {
    const appId = (await json({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: withTests(TESTS) } }, 201)).app.id;
    const ran = await json({ method: 'POST', url: `/v1/apps/${appId}/tests/run`, ...as(alice), payload: {} }, 200);
    const byName = Object.fromEntries((ran.results as Json[]).map((result) => [result.name, result]));
    expect(ran).toMatchObject({ passed: 3, failed: 2 });
    expect(byName['submits']).toMatchObject({ passed: true, outcome: 'saved' });
    expect(byName['own']).toMatchObject({ passed: true, outcome: 'refused', message: expect.stringContaining("can't approve your own claim") });
    expect(byName['requester_cannot_approve']).toMatchObject({ passed: true, outcome: 'refused' });
    expect(byName['wrong_total']).toMatchObject({ passed: false, outcome: 'saved', mismatches: [{ field: 'total', expected: 60, actual: 50 }] });
    expect(byName['no_title']).toMatchObject({ passed: false, outcome: 'error', message: expect.stringMatching(/^The test can't make bad: /) });
    // Only some tests, when asked.
    expect((await json({ method: 'POST', url: `/v1/apps/${appId}/tests/run`, ...as(alice), payload: { only: ['own'] } }, 200)).results).toHaveLength(1);

    // Nothing stays: no record, and no refusal on the audit log for the person a test acts as.
    expect((await json({ method: 'GET', url: `/v1/apps/${appId}/entities/expense_claim/records`, ...as(alice) }, 200)).records).toEqual([]);
    const denied = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'access.denied'), eq(auditEvents.appId, appId)));
    expect(denied).toEqual([]);
  });
});

describe("a change request's tests", () => {
  it('run on its preview, and stop the merge while one fails', async () => {
    const spaceId = (await json({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Finance', coOwnerUserIds: [olivia.userId] } }, 201)).id;
    const grant = (session: Session, roleId: string) =>
      inject({ method: 'POST', url: '/v1/bindings', ...as(alice), payload: { principal: { type: 'user', id: session.userId }, roleId, scope: { type: 'space', id: spaceId } } }, 201);
    await grant(carol, 'space.builder');
    await grant(dave, 'space.reviewer');
    await grant(erin, 'space.release_manager');
    const teamId = (await json({ method: 'POST', url: `/v1/spaces/${spaceId}/apps`, ...as(carol), payload: { name: 'Expenses' } }, 201)).app.id;
    const copyId = (await json({ method: 'POST', url: `/v1/apps/${teamId}/working-copy`, ...as(carol) }, 200)).app.id;
    const edit = async (tests: Json) => {
      const current = await json({ method: 'GET', url: `/v1/apps/${copyId}/definition`, ...as(carol) }, 200);
      await json({ method: 'PUT', url: `/v1/apps/${copyId}/definition`, ...as(carol), payload: { definition: withTests(tests), baseRevision: current.revision } }, 200);
    };

    await edit({ submits: TESTS.submits, wrong_total: TESTS.wrong_total });
    const cr = await json({ method: 'POST', url: `/v1/apps/${copyId}/submit`, ...as(carol), payload: { title: 'Expense claims, with tests' } }, 201);
    expect(cr.checks.tests).toMatchObject({ passed: 1, failed: 1, results: expect.arrayContaining([expect.objectContaining({ name: 'wrong_total', passed: false })]) });
    await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/reviews`, ...as(dave), payload: { verdict: 'approve' } }, 200);
    const stopped = await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/merge`, ...as(erin) }, 409);
    expect(stopped.json()).toMatchObject({ error: 'tests_failing', message: expect.stringContaining('A claim adds up its receipts') });

    // Put right, the change's tests pass, and once approved again it merges.
    await edit({ submits: TESTS.submits, adds_up: { ...TESTS.wrong_total, then: { outcome: 'saved', values: { total: 50 } } } });
    const updated = await json({ method: 'POST', url: `/v1/apps/${copyId}/submit`, ...as(carol), payload: {} }, 200);
    expect(updated.checks.tests).toMatchObject({ passed: 2, failed: 0 });
    await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/reviews`, ...as(dave), payload: { verdict: 'approve' } }, 200);
    expect((await json({ method: 'POST', url: `/v1/change-requests/${cr.id}/merge`, ...as(erin) }, 200)).status).toBe('merged');

    // Live in Prod, the app's tests don't run there, among the records people use.
    const release = await json({ method: 'POST', url: `/v1/apps/${teamId}/releases`, ...as(erin), payload: {} }, 201);
    const requested = await json({ method: 'POST', url: `/v1/apps/${teamId}/deployments`, ...as(erin), payload: { releaseId: release.id, env: 'prod' } }, 201);
    await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/approve`, ...as(dave) }, 200);
    await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/execute`, ...as(erin) }, 200);
    const inProd = await inject({ method: 'POST', url: `/v1/apps/${teamId}/tests/run`, ...as(carol), payload: {} }, 422);
    expect(inProd.json()).toMatchObject({ error: 'not_a_sandbox' });
    expect((await json({ method: 'POST', url: `/v1/apps/${copyId}/tests/run`, ...as(carol), payload: {} }, 200)).passed).toBe(2);
  });
});
