import { EXPENSE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * The flow an action runs before it saves, end to end (design §6.2): it checks the record, sets
 * values, branches and adds lines inside the action's own transaction, so a preview and a
 * proposal show its result, and a person approves exactly that.
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
const record = { claim: { type: 'record', entity: 'expense_claim' } };

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

async function claim(session: Session, title: string, amounts: number[], iban: string | null = 'SG11 BOB') {
  const lines = amounts.map((amount, i) => line(`Shop ${i + 1}`, 'travel', amount));
  return (
    await inject({ method: 'POST', url: run('submit_claim'), ...as(session), payload: { values: { title, lines, ...(iban ? { iban } : {}) } } }, 201)
  ).json().record;
}

/** Change the app's definition, as its builder does. */
async function redefine(edit: (definition: Record<string, any>) => void) {
  const current = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
  const definition = structuredClone(current.definition);
  edit(definition);
  return (
    await inject(
      { method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), headers: { 'if-match': `"${current.revision}"` }, payload: { definition } },
      200,
    )
  ).json().plan;
}

/** The example, with its approval checks: nobody approves their own claim, and a large claim needs a bank account. */
function withChecks() {
  const definition = structuredClone(EXPENSE_APP) as unknown as { flows: Record<string, unknown> };
  definition.flows['check_approval'] = {
    label: 'Check the approval',
    input: record,
    steps: [
      { type: 'check', assert: { ne: [{ ref: 'claim.owner' }, { ref: 'principal.id' }] }, message: "You can't approve your own claim" },
      { type: 'change', record: 'claim', values: { approver: { ref: 'principal.id' } } },
      {
        type: 'if',
        when: { gt: [{ ref: 'claim.total' }, 1000] },
        then: [{ type: 'check', assert: { exists: 'claim.iban' }, message: 'A large claim needs a bank account', fields: ['claim.iban'] }],
      },
    ],
  };
  return definition;
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
  const created = await inject(
    { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: withChecks() } },
    201,
  );
  appId = created.json().app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'carol@example.com', role: 'approver' } }, 201);
});

afterAll(async () => {
  await t?.close();
});

describe('the flow an action runs before it saves', () => {
  it('approve a claim: the flow records the approver, and the preview shows it first', async () => {
    const submitted = await claim(bob, 'Singapore trip', [270, 32.4]);
    const preview = (await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: submitted.id, dryRun: true } }, 200)).json();
    expect(preview.card.fields).toContainEqual(expect.objectContaining({ name: 'approver', value: carol.userId, source: { source: 'platform' } }));
    expect((await inject({ method: 'GET', url: `${records()}/${submitted.id}`, ...as(carol) }, 200)).json().values.approver).toBeNull();

    const done = (await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: submitted.id } }, 200)).json();
    expect(done).toMatchObject({ status: 'done', record: { values: { status: 'approved', approver: carol.userId } } });
    expect(done.record.masked).toContain('iban');
  });

  it('stop people approving their own claims, and take the branch for a large one', async () => {
    const own = await claim(alice, 'My own trip', [40]);
    const refused = await inject({ method: 'POST', url: run('approve_claim'), ...as(alice), payload: { recordId: own.id } }, 422);
    expect(refused.json()).toMatchObject({
      error: 'rule_failed',
      message: "You can't approve your own claim",
      details: { findings: [{ rule: 'flows.check_approval.steps[0]', severity: 'error' }] },
    });
    expect((await inject({ method: 'GET', url: `${records()}/${own.id}`, ...as(alice) }, 200)).json().values.status).toBe('submitted');

    const large = await claim(bob, 'Conference', [900, 600], null);
    const stopped = await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: large.id } }, 422);
    expect(stopped.json()).toMatchObject({
      error: 'rule_failed',
      message: 'A large claim needs a bank account',
      details: { findings: [{ rule: 'flows.check_approval.steps[2].then[0]', fields: ['iban'] }] },
    });
    const paid = await claim(bob, 'Workshop', [900, 600]);
    await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: paid.id } }, 200);
  });

  it("seal the flow's result into an agent's proposal, and write it only when the person approves", async () => {
    const submitted = await claim(bob, 'Kuala Lumpur', [120]);
    const response = await inject(
      { method: 'POST', url: '/v1/me/tokens', ...as(carol), payload: { name: 'agent', scopes: ['app.run', 'action.run', 'query.run'], expiresInDays: 7 } },
      201,
    );
    const agent = response.json().token as string;
    const rpc = async (method: string, params: Record<string, unknown> = {}) =>
      (await inject({ method: 'POST', url: '/mcp', ...bearer(agent), payload: { jsonrpc: '2.0', id: 1, method, params } }, 200)).json().result;

    const proposed = (await rpc('tools/call', { name: 'expenses__approve_claim', arguments: { record_id: submitted.id } })).structuredContent;
    expect(proposed).toMatchObject({ status: 'needs_confirmation' });
    expect(proposed.card.fields).toContainEqual(expect.objectContaining({ name: 'approver', value: carol.userId }));
    expect((await inject({ method: 'GET', url: `${records()}/${submitted.id}`, ...as(carol) }, 200)).json().values.approver).toBeNull();

    await inject({ method: 'POST', url: `/v1/proposals/${proposed.proposal.id}/approve`, ...as(carol), payload: { digest: proposed.proposal.digest } }, 200);
    expect((await inject({ method: 'GET', url: `${records()}/${submitted.id}`, ...as(carol) }, 200)).json().values).toMatchObject({
      status: 'approved',
      approver: carol.userId,
    });
  });

  it('shape a new record: set a value and add a line, whose total the record shows', async () => {
    await redefine((definition) => {
      definition.flows.add_per_diem = {
        label: 'Add the per diem',
        input: record,
        steps: [
          { type: 'change', record: 'claim', values: { title: { concat: ['Per diem: ', { ref: 'claim.trip' }] } } },
          { type: 'add_line', record: 'claim', field: 'lines', values: { date: { today: true }, merchant: 'Per diem', category: 'meals', amount: 50 } },
        ],
      };
      definition.actions.claim_per_diem = {
        label: 'Claim a per diem',
        description: 'Claim the daily meal allowance for a trip.',
        entity: 'expense_claim',
        operation: 'create',
        input: ['trip'],
        set: { status: 'submitted' },
        before: { flow: 'add_per_diem', input: { claim: { ref: 'record' } } },
      };
      definition.roles.requester.actions.push('claim_per_diem');
    });

    const done = (await inject({ method: 'POST', url: run('claim_per_diem'), ...as(bob), payload: { values: { trip: 'Penang' } } }, 201)).json();
    expect(done.record.values).toMatchObject({ title: 'Per diem: Penang', total: 50, status: 'submitted' });
    expect(done.record.values.lines).toEqual([expect.objectContaining({ merchant: 'Per diem', category: 'meals', amount: 50 })]);
  });

  it('read the lines the record has, and undo what an error handler catches', async () => {
    await redefine((definition) => {
      definition.flows.tidy = {
        label: 'Tidy the claim',
        input: record,
        steps: [
          { type: 'total', var: 'count', of: 'claim.lines', op: 'count' },
          { type: 'total', var: 'largest', of: 'claim.lines', op: 'max', field: 'amount' },
          {
            type: 'change',
            record: 'claim',
            values: { trip: { concat: [{ ref: 'claim.title' }, ': ', { ref: 'count' }, ' lines, up to ', { ref: 'largest' }] } },
          },
          {
            type: 'try',
            steps: [
              { type: 'change', record: 'claim', values: { title: 'Changed, then undone' } },
              { type: 'check', assert: { gt: [{ ref: 'count' }, 5] }, message: 'Only a long claim gets a new title' },
            ],
          },
        ],
      };
      definition.actions.tidy_claim = {
        label: 'Tidy a claim',
        description: 'Note how many lines a claim has.',
        entity: 'expense_claim',
        operation: 'update',
        input: [],
        confirm: 'none',
        before: { flow: 'tidy', input: { claim: { ref: 'record' } } },
      };
      definition.roles.requester.actions.push('tidy_claim');
      definition.roles.requester.entities.expense_claim.update = { fields: { include: ['trip', 'title'] } };
    });

    const mine = await claim(bob, 'Tokyo', [120, 80.5]);
    const preview = (await inject({ method: 'POST', url: run('tidy_claim'), ...as(bob), payload: { recordId: mine.id, dryRun: true } }, 200)).json();
    expect(preview.card.fields).toContainEqual(expect.objectContaining({ name: 'trip', value: 'Tokyo: 2 lines, up to 120' }));
    const done = (await inject({ method: 'POST', url: run('tidy_claim'), ...as(bob), payload: { recordId: mine.id } }, 200)).json();
    expect(done.record.values).toMatchObject({ trip: 'Tokyo: 2 lines, up to 120', title: 'Tokyo' });
  });

  it("move an older definition's steps into a flow, which does what they did", async () => {
    const plan = await redefine((definition) => {
      delete definition.actions.approve_claim.before;
      definition.actions.approve_claim.steps = [
        { type: 'check', assert: { ne: [{ ref: 'record.owner' }, { ref: 'principal.id' }] }, message: "You can't approve your own claim" },
        { type: 'set', field: 'approver', value: { ref: 'principal.id' } },
      ];
    });
    expect(plan.notes).toContain(
      'The steps of Approve an expense claim are now the flow Approve an expense claim: before it saves, which runs before it saves',
    );
    const saved = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json().definition;
    expect(saved.actions.approve_claim).not.toHaveProperty('steps');
    expect(saved.actions.approve_claim.before).toEqual({ flow: 'approve_claim_before', input: { expense_claim: { ref: 'record' } } });

    const submitted = await claim(bob, 'Jakarta', [75]);
    const done = (await inject({ method: 'POST', url: run('approve_claim'), ...as(carol), payload: { recordId: submitted.id } }, 200)).json();
    expect(done.record.values).toMatchObject({ status: 'approved', approver: carol.userId });
    const own = await claim(alice, 'My own', [10]);
    expect((await inject({ method: 'POST', url: run('approve_claim'), ...as(alice), payload: { recordId: own.id } }, 422)).json()).toMatchObject({
      details: { findings: [{ rule: 'flows.approve_claim_before.steps[0]' }] },
    });
  });
});
