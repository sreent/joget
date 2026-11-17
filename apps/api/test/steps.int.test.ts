import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPENSE_APP } from '@platform/app-model';
import { auditEvents, skillCalls } from '@platform/db';
import { and, asc, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { a7cRunner, SkillDispatcher, SkillStartError, type SkillRunner, type SkillStart } from '../src/skills/dispatcher.js';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Steps in actions, end to end (design §6.2): they check, set values and add lines inside the
 * action's own transaction, and the a7c skills they start wait in an outbox until the change
 * commits. A dispatcher then starts each in a7c once, and tries again while a7c is away.
 */

let t: TestApp;
let alice: Session; // builds the app
let bob: Session; // requester
let carol: Session; // approver
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const line = (merchant: string, category: string, amount: number) => ({ date: '2026-11-02', merchant, category, amount });
const records = () => `/v1/apps/${appId}/entities/expense_claim/records`;
const run = (action: string) => `/v1/apps/${appId}/actions/${action}/run`;

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

async function claim(session: Session, title: string, amounts: number[], iban = 'SG11 BOB') {
  const lines = amounts.map((amount, i) => line(`Shop ${i + 1}`, 'travel', amount));
  return (await inject({ method: 'POST', url: run('submit_claim'), ...as(session), payload: { values: { title, lines, iban } } }, 201)).json().record;
}

const callsOf = (recordId: string) => t.ctx.db.select().from(skillCalls).where(eq(skillCalls.recordId, recordId)).orderBy(asc(skillCalls.step));

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
  const created = await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: EXPENSE_APP } }, 201);
  appId = created.json().app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'carol@example.com', role: 'approver' } }, 201);
});

afterAll(async () => {
  await t?.close();
});

describe('steps in actions', () => {
  it('approve a claim: record the approver, and queue its payment in a7c with the real values', async () => {
    const submitted = await claim(bob, 'Singapore trip', [270, 32.4]);
    const preview = (await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: submitted.id, dryRun: true } }, 200)).json();
    expect(preview.card.then).toEqual([{ label: 'Pay the claim', skill: 'finance/pay-expense-claim' }]);
    expect(preview.card.fields).toContainEqual(expect.objectContaining({ name: 'approver', value: carol.userId, source: { source: 'platform' } }));
    expect(await callsOf(submitted.id)).toEqual([]);

    const done = (await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: submitted.id } }, 200)).json();
    expect(done).toMatchObject({ status: 'done', record: { values: { status: 'approved', approver: carol.userId } } });
    // Carol sees the bank account masked; the skill gets it in full, to pay the claim.
    expect(done.record.masked).toContain('iban');
    const [call, ...others] = await callsOf(submitted.id);
    expect(others).toEqual([]);
    expect(call).toMatchObject({
      action: 'approve_claim',
      step: 'steps[3]',
      skill: 'finance/pay-expense-claim',
      label: 'Pay the claim',
      tier: 'personal',
      status: 'pending',
      onBehalfOf: carol.userId,
      proposalId: null,
      input: { claim: submitted.id, title: 'Singapore trip', amount: 302.4, account: 'SG11 BOB' },
    });
    const queued = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'skill_call.queue'), eq(auditEvents.appId, appId)));
    expect(queued.map((event) => (event.target as { id: string }).id)).toEqual([call!.id]);

    // Whoever reads the record sees which skills it started and how they went, never their input.
    const listed = (await inject({ method: 'GET', url: `${records()}/${submitted.id}/skill-calls`, ...as(carol) }, 200)).json();
    expect(listed.calls).toEqual([expect.objectContaining({ id: call!.id, label: 'Pay the claim', status: 'pending', tier: 'personal' })]);
    expect(listed.calls[0]).not.toHaveProperty('input');
    // The owner of a personal space runs its outbox; a colleague with a role in the app doesn't.
    await inject({ method: 'GET', url: `/v1/apps/${appId}/skill-calls`, ...as(carol) }, 403);
    expect((await inject({ method: 'GET', url: `/v1/apps/${appId}/skill-calls`, ...as(alice) }, 200)).json().calls).toHaveLength(1);
  });

  it('stop people approving their own claims, and take the branch for a large one', async () => {
    const own = await claim(alice, 'My own trip', [40]);
    const refused = await inject({ method: 'POST', url: run('approve_claim'), ...as(alice), payload: { recordId: own.id } }, 422);
    expect(refused.json()).toMatchObject({ error: 'rule_failed', message: "You can't approve your own claim", details: { findings: [{ rule: 'steps[0]', severity: 'error' }] } });
    expect((await inject({ method: 'GET', url: `${records()}/${own.id}`, ...as(alice) }, 200)).json().values.status).toBe('submitted');

    const large = await claim(bob, 'Conference', [900, 600]);
    await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: large.id } }, 200);
    expect((await callsOf(large.id)).map((c) => [c.step, c.skill, (c.input as { amount: number }).amount])).toEqual([
      ['steps[2].then[0]', 'finance/check-large-claim', 1500],
      ['steps[3]', 'finance/pay-expense-claim', 1500],
    ]);
  });

  it('seal the skills into an agent\'s proposal, and queue them only when the person approves', async () => {
    const submitted = await claim(bob, 'Kuala Lumpur', [120]);
    const response = await inject({ method: 'POST', url: '/v1/me/tokens', ...as(carol), payload: { name: 'agent', scopes: ['app.run', 'action.run', 'query.run'], expiresInDays: 7 } }, 201);
    const agent = response.json().token as string;
    const rpc = async (method: string, params: Record<string, unknown> = {}) =>
      (await inject({ method: 'POST', url: '/mcp', ...bearer(agent), payload: { jsonrpc: '2.0', id: 1, method, params } }, 200)).json().result;
    const tools = (await rpc('tools/list')).tools as Array<{ name: string; description: string }>;
    expect(tools.find((tool) => tool.name === 'expenses__approve_claim')!.description).toContain('Once saved, it starts work in other systems: Ask finance to check a large claim; Pay the claim.');

    const proposed = (await rpc('tools/call', { name: 'expenses__approve_claim', arguments: { record_id: submitted.id } })).structuredContent;
    expect(proposed).toMatchObject({ status: 'needs_confirmation', card: { then: [{ label: 'Pay the claim' }] } });
    expect(await callsOf(submitted.id)).toEqual([]);
    const page = await inject({ method: 'GET', url: `/review/${proposed.proposal.id}`, ...as(carol) }, 200);
    expect(page.body).toContain('Once you approve');
    expect(page.body).toContain('Pay the claim');

    await inject({ method: 'POST', url: `/v1/proposals/${proposed.proposal.id}/approve`, ...as(carol), payload: { digest: proposed.proposal.digest } }, 200);
    expect(await callsOf(submitted.id)).toEqual([expect.objectContaining({ skill: 'finance/pay-expense-claim', proposalId: proposed.proposal.id, onBehalfOf: carol.userId })]);
  });

  it('run steps on a new record, which the skills it starts can name by its ID', async () => {
    const current = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
    const definition = structuredClone(current.definition);
    definition.actions.claim_per_diem = {
      label: 'Claim a per diem',
      description: 'Claim the daily meal allowance for a trip.',
      entity: 'expense_claim',
      operation: 'create',
      input: ['trip'],
      set: { status: 'submitted' },
      steps: [
        { type: 'set', field: 'title', value: { concat: ['Per diem: ', { ref: 'record.trip' }] } },
        { type: 'add_line', field: 'lines', values: { date: { today: true }, merchant: 'Per diem', category: 'meals', amount: 50 } },
        { type: 'skill', label: 'Tell the requester', skill: 'people/notify', input: { claim: { ref: 'record.id' }, total: { ref: 'record.total' }, person: { ref: 'principal.id' } } },
      ],
    };
    definition.roles.requester.actions.push('claim_per_diem');
    await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), headers: { 'if-match': `"${current.revision}"` }, payload: { definition } }, 200);

    const done = (await inject({ method: 'POST', url: run('claim_per_diem'), ...as(bob), payload: { values: { trip: 'Penang' } } }, 201)).json();
    expect(done.record.values).toMatchObject({ title: 'Per diem: Penang', total: 50, status: 'submitted' });
    expect(done.record.values.lines).toEqual([expect.objectContaining({ merchant: 'Per diem', category: 'meals', amount: 50 })]);
    expect(await callsOf(done.record.id)).toEqual([expect.objectContaining({ skill: 'people/notify', input: { claim: done.record.id, total: 50, person: bob.userId } })]);
  });
});

describe('the dispatcher', () => {
  /** A stand-in for a7c: the nth try of a call takes the nth answer for its skill, and the last answer repeats. */
  function fakeA7c(answers: Record<string, Array<'ok' | 'away' | 'refuse'>>) {
    const seen: SkillStart[] = [];
    const runner: SkillRunner = {
      async start(call) {
        const tries = seen.filter((earlier) => earlier.id === call.id).length;
        seen.push(call);
        const list = answers[call.skill] ?? ['ok'];
        const answer = list[Math.min(tries, list.length - 1)]!;
        if (answer === 'away') throw new SkillStartError('a7c answered 503', true);
        if (answer === 'refuse') throw new SkillStartError('a7c answered 403 (forbidden)', false);
        return { runId: `run-${seen.length}` };
      },
    };
    return { runner, seen };
  }

  it('start each call once, try again while a7c is away, and give up when it refuses', async () => {
    const a7c = fakeA7c({ 'finance/pay-expense-claim': ['away', 'ok'], 'finance/check-large-claim': ['refuse'], 'people/notify': ['ok'] });
    const dispatcher = new SkillDispatcher(t.ctx.db, a7c.runner, { now: t.ctx.now, maxAttempts: 5 });
    expect(await dispatcher.dispatchDue()).toBe(5);
    const after = await t.ctx.db.select().from(skillCalls).where(eq(skillCalls.appId, appId));
    const bySkill = (skill: string) => after.filter((call) => call.skill === skill);
    expect(bySkill('finance/pay-expense-claim').map((call) => [call.status, call.attempts, call.lastError])).toEqual(Array(3).fill(['pending', 1, 'a7c answered 503']));
    expect(bySkill('finance/check-large-claim')).toEqual([expect.objectContaining({ status: 'failed', lastError: 'a7c answered 403 (forbidden)', attempts: 1 })]);
    expect(bySkill('people/notify')).toEqual([expect.objectContaining({ status: 'started', runId: expect.stringMatching(/^run-/) })]);
    // Nothing is due until the wait is over.
    expect(await dispatcher.dispatchDue()).toBe(0);

    t.clock.offsetMs = 60_000;
    try {
      expect(await dispatcher.dispatchDue()).toBe(3);
    } finally {
      t.clock.offsetMs = 0;
    }
    const paid = await t.ctx.db.select().from(skillCalls).where(and(eq(skillCalls.appId, appId), eq(skillCalls.skill, 'finance/pay-expense-claim')));
    expect(paid.map((call) => [call.status, call.attempts])).toEqual(Array(3).fill(['started', 2]));
    // Each try names the call by its ID: a7c's idempotency key, so a7c starts it once.
    const tries = a7c.seen.filter((call) => call.skill === 'finance/pay-expense-claim').map((call) => call.id);
    expect(new Set(tries).size).toBe(3);
    expect(tries).toHaveLength(6);
    expect(a7c.seen.find((call) => call.skill === 'finance/pay-expense-claim')).toMatchObject({ tier: 'personal', input: { amount: expect.any(Number) } });

    const failures = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'skill_call.fail'), eq(auditEvents.appId, appId)));
    expect(failures).toEqual([expect.objectContaining({ outcome: 'error', reason: expect.objectContaining({ skill: 'finance/check-large-claim', error: 'a7c answered 403 (forbidden)' }) })]);
  });

  it('lets the owner try a failed call again, under the same idempotency key', async () => {
    const [failed] = await t.ctx.db.select().from(skillCalls).where(and(eq(skillCalls.appId, appId), eq(skillCalls.status, 'failed')));
    await inject({ method: 'POST', url: `/v1/apps/${appId}/skill-calls/${failed!.id}/retry`, ...as(carol) }, 403);
    const again = (await inject({ method: 'POST', url: `/v1/apps/${appId}/skill-calls/${failed!.id}/retry`, ...as(alice) }, 200)).json();
    expect(again).toMatchObject({ id: failed!.id, status: 'pending', attempts: 0 });
    await inject({ method: 'POST', url: `/v1/apps/${appId}/skill-calls/${failed!.id}/retry`, ...as(alice) }, 409);

    const a7c = fakeA7c({});
    await new SkillDispatcher(t.ctx.db, a7c.runner, { now: t.ctx.now, maxAttempts: 5 }).dispatchDue();
    expect(a7c.seen.map((call) => call.id)).toEqual([failed!.id]);
    const listed = (await inject({ method: 'GET', url: `/v1/apps/${appId}/skill-calls?status=failed`, ...as(alice) }, 200)).json();
    expect(listed.calls).toEqual([]);
  });
});

describe('a7c, as the dispatcher calls it', () => {
  let server: Server;
  let url: string;
  const requests: Array<{ path: string; headers: IncomingMessage['headers']; body: unknown }> = [];
  const answers: Array<[number, unknown]> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        requests.push({ path: request.url ?? '', headers: request.headers, body: JSON.parse(body) });
        const [status, answer] = answers.shift() ?? [500, {}];
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('starts a run with runs.start, the token from its file, and the call\'s ID as the idempotency key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ambit-a7c-'));
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, 'a-test-token\n');
    const runner = a7cRunner({ url, tokenFile });
    const call = { id: '0193a7c4-0000-7000-8000-0000000000a1', skill: 'finance/pay-expense-claim', tier: 'production' as const, input: { amount: 302.4 } };

    answers.push([200, { run: '0193a7c4-0000-7000-8000-0000000000b1' }]);
    expect(await runner.start(call)).toEqual({ runId: '0193a7c4-0000-7000-8000-0000000000b1' });
    expect(requests[0]).toMatchObject({
      path: '/api/v1/operations/runs.start',
      headers: { authorization: 'Bearer a-test-token', 'idempotency-key': `ambit-skill-call-${call.id}`, 'content-type': 'application/json' },
      body: { skill: 'finance/pay-expense-claim', tier: 'production', input: { amount: 302.4 } },
    });

    answers.push([503, {}]);
    await expect(runner.start(call)).rejects.toMatchObject({ message: 'a7c answered 503', retry: true });
    answers.push([403, { error: { kind: 'forbidden' } }]);
    await expect(runner.start(call)).rejects.toMatchObject({ message: 'a7c answered 403 (forbidden)', retry: false });
    await expect(a7cRunner({ url: 'http://127.0.0.1:1', tokenFile }).start(call)).rejects.toMatchObject({ retry: true });
  });
});
