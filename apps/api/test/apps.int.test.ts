import { EXPENSE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Phase 1's exit criterion, end to end: a person builds an app in their personal space and shares
 * it with two colleagues; an agent acting for one of them prepares a claim; the colleague edits it
 * on the review page and approves it; every step is permissioned, ruled, recorded and audited.
 */

let t: TestApp;
let alice: Session; // builds the app
let bob: Session; // requester
let carol: Session; // approver
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const records = () => `/v1/apps/${appId}/entities/expense_claim/records`;

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

async function mintPat(session: Session, scopes: string[]): Promise<string> {
  const response = await inject({ method: 'POST', url: '/v1/me/tokens', ...as(session), payload: { name: 'agent', scopes, expiresInDays: 7 } }, 201);
  return response.json().token as string;
}

async function rpc(token: string, path: string, method: string, params: Record<string, unknown> = {}) {
  const response = await inject({ method: 'POST', url: path, ...bearer(token), payload: { jsonrpc: '2.0', id: 1, method, params } }, 200);
  return response.json() as { result?: any; error?: { code: number; message: string } };
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
});

afterAll(async () => {
  await t?.close();
});

describe('building an app in a personal space', () => {
  it('creates the app and its sandbox from a definition', async () => {
    const created = await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: EXPENSE_APP } }, 201);
    const body = created.json();
    appId = body.app.id;
    expect(body.app).toMatchObject({ handle: 'expenses', revision: 1, access: { build: true, run: true, share: true } });
    expect(body.plan.steps).toEqual([{ kind: 'create_entity', description: 'Create expense_claim', destructive: false }]);
  });

  it('refuses team spaces for now, and other people\'s personal spaces', async () => {
    const team = await inject({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Finance', coOwnerUserIds: [carol.userId] } }, 201);
    const refused = await inject({ method: 'POST', url: `/v1/spaces/${team.json().id}/apps`, ...as(alice), payload: { name: 'Team app' } }, 422);
    expect(refused.json().error).toBe('team_space_apps_later');
    await inject({ method: 'POST', url: `/v1/spaces/${bob.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Sneaky' } }, 403);
  });

  it('runs the rules on the server, whatever the client', async () => {
    const zero = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Free lunch', category: 'meals', amount: 0 } } }, 422);
    expect(zero.json()).toMatchObject({ error: 'rule_failed', details: { findings: [{ rule: 'positive_amount' }] } });
    const typo = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Taxi', category: 'taxi', amount: 12 } } }, 422);
    expect(typo.json().details.issues).toEqual([expect.objectContaining({ field: 'category', code: 'invalid_option' })]);
  });

  it('lets the owner use their own app fully', async () => {
    const created = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Conference ticket', category: 'travel', amount: 450, iban: 'SG00 ALICE' } } }, 201);
    expect(created.json()).toMatchObject({ version: 1, owner: alice.userId, values: { title: 'Conference ticket', status: 'draft', iban: 'SG00 ALICE' }, masked: [] });
  });

  it('carries renames through without touching data, and holds back changes that delete it', async () => {
    const current = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
    const definition = structuredClone(current.definition);
    definition.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'trip').name = 'journey';
    const saved = await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), headers: { 'if-match': '"1"' }, payload: { definition } }, 200);
    expect(saved.json().plan).toMatchObject({ revision: 2, destructive: false, steps: [{ kind: 'rename_field' }] });
    expect(saved.json().plan.notes).toEqual(['Updated references for the rename expense_claim.trip → journey']);

    const stale = await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), payload: { definition, baseRevision: 1 } }, 412);
    expect(stale.json().error).toBe('revision_mismatch');

    // The server carried the rename into the action and the card: start from what it saved.
    const saved2 = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
    expect(saved2.definition.actions.submit_claim.input).toContain('journey');
    const dropping = structuredClone(saved2.definition);
    dropping.entities.expense_claim.fields = dropping.entities.expense_claim.fields.filter((f: { name: string }) => f.name !== 'approver');
    const held = await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), payload: { definition: dropping } }, 409);
    expect(held.json()).toMatchObject({ error: 'destructive_change', details: { plan: { destructive: true, steps: [{ kind: 'drop_field', records: 0 }] } } });
    // The rename kept its ID, so the next revision still knows the field.
    const revisions = (await inject({ method: 'GET', url: `/v1/apps/${appId}/revisions`, ...as(alice) }, 200)).json().revisions;
    expect(revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
  });
});

describe('sharing with colleagues', () => {
  it('shares the app with two colleagues, in different roles', async () => {
    await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
    await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'carol@example.com', role: 'approver' } }, 201);
    const again = await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 409);
    expect(again.json().error).toBe('already_shared');
    const shares = (await inject({ method: 'GET', url: `/v1/apps/${appId}/shares`, ...as(alice) }, 200)).json().shares;
    expect(shares.map((s: { appRoleId: string }) => s.appRoleId.split(':').at(-1))).toEqual(['requester', 'approver']);
  });

  it('lets colleagues use the app, but not build or reshare it', async () => {
    const listed = (await inject({ method: 'GET', url: '/v1/apps', ...as(bob) }, 200)).json().apps;
    expect(listed).toEqual([expect.objectContaining({ id: appId, access: { build: false, run: true, share: false, roles: ['requester'] } })]);
    await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(bob) }, 403);
    await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(bob), payload: { email: 'carol@example.com', role: 'requester' } }, 403);
  });

  it('shows each person only the records and fields their role allows', async () => {
    const submitted = await inject({
      method: 'POST',
      url: `/v1/apps/${appId}/actions/submit_claim/run`,
      ...as(bob),
      payload: { values: { title: 'Taxi to the airport', journey: 'Singapore', category: 'travel', amount: 32.4, iban: 'SG11 BOB' } },
    }, 201);
    expect(submitted.json()).toMatchObject({ status: 'done', record: { owner: bob.userId, values: { status: 'submitted', iban: 'SG11 BOB' } } });

    const mine = (await inject({ method: 'GET', url: records(), ...as(bob) }, 200)).json().records;
    expect(mine.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Taxi to the airport']);

    const forApproval = (await inject({ method: 'GET', url: records(), ...as(carol) }, 200)).json().records;
    expect(forApproval).toHaveLength(1);
    expect(forApproval[0].values).not.toHaveProperty('iban');
    expect(forApproval[0].masked).toEqual(['iban']);

    // Carol may change only the status, and only through what her role allows.
    const edit = await inject({ method: 'PATCH', url: `${records()}/${forApproval[0].id}`, ...as(carol), payload: { values: { amount: 1 } } }, 403);
    expect(edit.json().error).toBe('not_allowed');
    // Alice's draft is invisible to Carol, so it doesn't exist as far as she can tell.
    const aliceDraft = (await inject({ method: 'GET', url: records(), ...as(alice) }, 200)).json().records.find((r: { owner: string }) => r.owner === alice.userId);
    await inject({ method: 'PATCH', url: `${records()}/${aliceDraft.id}`, ...as(carol), payload: { values: { status: 'approved' } } }, 404);
  });

  it('runs actions under the caller\'s record permissions, and keeps the history', async () => {
    const claim = (await inject({ method: 'GET', url: records(), ...as(carol) }, 200)).json().records[0];
    const approved = await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/approve_claim/run`, ...as(carol), payload: { recordId: claim.id } }, 200);
    expect(approved.json()).toMatchObject({ status: 'done', record: { version: 2, values: { status: 'approved' } } });
    await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/approve_claim/run`, ...as(carol), payload: { recordId: claim.id } }, 403);
    await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(carol), payload: { values: {} } }, 403);

    const history = (await inject({ method: 'GET', url: `${records()}/${claim.id}/history`, ...as(bob) }, 200)).json().history;
    expect(history.map((h: { operation: string; actor: { id: string } }) => [h.operation, h.actor.id])).toEqual([
      ['create', bob.userId],
      ['update', carol.userId],
    ]);
    expect(history[1].changes).toEqual([{ field: 'status', before: 'submitted', after: 'approved' }]);
    // Carol sees the same history with the bank account masked.
    const carolsView = (await inject({ method: 'GET', url: `${records()}/${claim.id}/history`, ...as(carol) }, 200)).json().history;
    expect(carolsView[0].changes).toContainEqual({ field: 'iban', masked: true });
  });

  it('keeps personal apps private from org admins', async () => {
    // Alice is an org owner, yet Bob's personal app is his alone.
    const bobs = await inject({ method: 'POST', url: `/v1/spaces/${bob.personalSpaceId}/apps`, ...as(bob), payload: { name: 'Side project', definition: EXPENSE_APP } }, 201);
    // Org roles carry no record permissions at all, and org grants would stop at the personal-space boundary anyway.
    const denied = await inject({ method: 'GET', url: `/v1/apps/${bobs.json().app.id}/entities/expense_claim/records`, ...as(alice) }, 403);
    expect(denied.json().details.reasons).toEqual([{ kind: 'no_matching_grant' }]);
    await inject({ method: 'GET', url: `/v1/apps/${bobs.json().app.id}`, ...as(alice) }, 403);
  });
});

describe('agents propose, people approve', () => {
  let agentToken: string;
  let proposalId: string;

  it('publishes what the person may do as MCP tools', async () => {
    agentToken = await mintPat(bob, ['app.run', 'action.run', 'query.run', 'record.read', 'record.create']);
    const init = await rpc(agentToken, '/mcp', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    const tools = (await rpc(agentToken, '/mcp', 'tools/list')).result.tools as Array<{ name: string; inputSchema: any }>;
    // Bob's own side project shows in full; in Alice's app, only what his requester role allows.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'expenses__my_claims',
      'expenses__submit_claim',
      'side_project__approve_claim',
      'side_project__my_claims',
      'side_project__submit_claim',
    ]);
    const submit = tools.find((tool) => tool.name === 'expenses__submit_claim')!;
    expect(submit.inputSchema.properties.values.properties.category).toMatchObject({ type: 'string', enum: ['travel', 'hotel', 'meals'] });
    expect(submit.inputSchema.properties.values.required).toEqual(['title', 'category', 'amount']);
  });

  it('turns an agent\'s action into a proposal, with the rule findings and where each value came from', async () => {
    const call = await rpc(agentToken, '/mcp', 'tools/call', {
      name: 'expenses__submit_claim',
      arguments: {
        values: { title: 'Marina Bay hotel', journey: 'Singapore', category: 'hotel', amount: 270 },
        provenance: { amount: { source: 'document', document: 'receipt.jpg' }, journey: { source: 'agent', note: 'From the calendar' } },
      },
    });
    const result = call.result.structuredContent;
    expect(result.status).toBe('needs_confirmation');
    expect(result.card.findings).toEqual([expect.objectContaining({ rule: 'hotel_cap', severity: 'warning' })]);
    expect(call.result.content[0].text).toMatch(/^Waiting for the person to confirm/);
    proposalId = result.proposal.id;
    // Nothing is written until Bob approves.
    const mine = (await inject({ method: 'GET', url: records(), ...as(bob) }, 200)).json().records;
    expect(mine.map((r: { values: { title: string } }) => r.values.title)).not.toContain('Marina Bay hotel');
  });

  it('never lets the agent approve, even with the person\'s own token', async () => {
    const proposal = (await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...bearer(agentToken) }, 200)).json();
    const attempt = await inject({ method: 'POST', url: `/v1/proposals/${proposalId}/approve`, ...bearer(agentToken), payload: { digest: proposal.digest } }, 403);
    expect(attempt.json().error).toBe('session_required');
    await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...as(carol) }, 404);
  });

  it('shows the person a review page, sends them to sign in first if needed, and lets them edit', async () => {
    const anonymous = await inject({ method: 'GET', url: `/review/${proposalId}` }, 302);
    expect(anonymous.headers.location).toBe(`/auth/login?returnTo=${encodeURIComponent(`/review/${proposalId}`)}`);

    const review = await inject({ method: 'GET', url: `/review/${proposalId}`, ...as(bob) }, 200);
    expect(review.body).toContain('Marina Bay hotel: SGD 270.00');
    expect(review.body).toContain('Hotel is above the SGD 250 nightly cap');
    expect(review.body).toContain('Read from receipt.jpg');
    expect(review.body).toContain('Inferred by the agent: From the calendar');

    const form = new URLSearchParams({ title: 'Marina Bay hotel', journey: 'Singapore', category: 'hotel', amount: '240', iban: '' });
    const revised = await inject({
      method: 'POST',
      url: `/review/${proposalId}/revise`,
      ...as(bob),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form.toString(),
    }, 303);
    const next = String(revised.headers.location).split('/').at(-1)!;
    expect(next).not.toBe(proposalId);
    const old = (await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...as(bob) }, 200)).json();
    expect(old.status).toBe('superseded');
    proposalId = next;
    const page = await inject({ method: 'GET', url: `/review/${proposalId}`, ...as(bob) }, 200);
    expect(page.body).toContain('Edited by you');
    expect(page.body).not.toContain('nightly cap');
  });

  it('commits exactly the approved change, and only once', async () => {
    const proposal = (await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...as(bob) }, 200)).json();
    const wrong = await inject({ method: 'POST', url: `/v1/proposals/${proposalId}/approve`, ...as(bob), payload: { digest: 'not-the-digest' } }, 409);
    expect(wrong.json().error).toBe('digest_mismatch');

    const approved = await inject({
      method: 'POST',
      url: `/review/${proposalId}/approve`,
      ...as(bob),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ digest: proposal.digest }).toString(),
    }, 303);
    expect(approved.headers.location).toBe(`/review/${proposalId}`);
    const done = (await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...as(bob) }, 200)).json();
    expect(done).toMatchObject({ status: 'approved', resultRecordId: expect.any(String) });

    const record = (await inject({ method: 'GET', url: `${records()}/${done.resultRecordId}`, ...as(bob) }, 200)).json();
    expect(record).toMatchObject({ owner: bob.userId, values: { title: 'Marina Bay hotel', amount: 240, status: 'submitted' } });
    const history = (await inject({ method: 'GET', url: `${records()}/${record.id}/history`, ...as(bob) }, 200)).json().history;
    const sources = Object.fromEntries(history[0].changes.map((c: { field: string; source?: { source: string } }) => [c.field, c.source?.source ?? null]));
    expect(sources).toMatchObject({ amount: 'person', journey: 'agent', title: null });

    const twice = await inject({ method: 'POST', url: `/v1/proposals/${proposalId}/approve`, ...as(bob), payload: { digest: proposal.digest } }, 409);
    expect(twice.json().error).toBe('not_pending');

    const audit = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.appId, appId), eq(auditEvents.action, 'record.create')));
    const fromProposal = audit.find((event) => (event.reason as { proposal?: string } | null)?.proposal === proposalId);
    expect(fromProposal).toBeDefined();
    expect(fromProposal!.changes).toEqual({ fields: expect.arrayContaining(['amount', 'title']) });
    expect(JSON.stringify(fromProposal)).not.toContain('Marina Bay');
  });

  it('answers queries as the person, through MCP', async () => {
    const result = (await rpc(agentToken, '/mcp', 'tools/call', { name: 'expenses__my_claims', arguments: {} })).result;
    expect(result.structuredContent.records.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Marina Bay hotel', 'Taxi to the airport']);
    expect(result.content[0].text).toMatch(/^2 record\(s\)/);
  });
});

describe('building with an AI client', () => {
  let builderToken: string;

  it('describes the format and lists the apps', async () => {
    builderToken = await mintPat(alice, ['app.create', 'app.read', 'app.edit', 'app.run']);
    const format = (await rpc(builderToken, '/mcp/build', 'tools/call', { name: 'describe_format', arguments: {} })).result.structuredContent;
    expect(format.schema).toHaveProperty('properties.entities');
    expect(format.example).toEqual(EXPENSE_APP);
    const apps = (await rpc(builderToken, '/mcp/build', 'tools/call', { name: 'list_apps', arguments: {} })).result.structuredContent.apps;
    expect(apps.map((a: { name: string }) => a.name)).toEqual(['Expenses']);
  });

  it('applies changes live, but leaves changes that delete data to the person', async () => {
    const current = (await rpc(builderToken, '/mcp/build', 'tools/call', { name: 'get_definition', arguments: { app_id: appId } })).result.structuredContent;
    const definition = structuredClone(current.definition);
    definition.entities.expense_claim.fields.push({ name: 'project_code', label: 'Project code', type: 'text', maxLength: 20 });
    const added = await rpc(builderToken, '/mcp/build', 'tools/call', { name: 'apply_change', arguments: { app_id: appId, definition, base_revision: current.revision } });
    expect(added.result.isError).toBeUndefined();
    expect(added.result.structuredContent.plan).toMatchObject({ steps: [{ kind: 'add_field' }] });

    const dropping = structuredClone(definition);
    dropping.entities.expense_claim.fields = dropping.entities.expense_claim.fields.filter((f: { name: string }) => f.name !== 'journey');
    dropping.actions.submit_claim.input = dropping.actions.submit_claim.input.filter((f: string) => f !== 'journey');
    dropping.cards.claim_review.show = dropping.cards.claim_review.show.filter((f: string) => f !== 'journey');
    const held = await rpc(builderToken, '/mcp/build', 'tools/call', { name: 'apply_change', arguments: { app_id: appId, definition: dropping } });
    expect(held.result).toMatchObject({ isError: true, structuredContent: { error: 'destructive_change' } });
    expect(held.result.structuredContent.details.plan.steps).toEqual([expect.objectContaining({ kind: 'drop_field', records: 2 })]);

    const asToken = await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition?confirmDestructive=true`, ...bearer(builderToken), payload: { definition: dropping } }, 403);
    expect(asToken.json().error).toBe('session_required');
  });

  it("can't reach apps the person can't build", async () => {
    const bobToken = await mintPat(bob, ['app.read', 'app.edit']);
    const denied = await rpc(bobToken, '/mcp/build', 'tools/call', { name: 'get_definition', arguments: { app_id: appId } });
    expect(denied.result).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
  });
});

describe('guardrails', () => {
  it('make a frozen space read-only for everyone, data included', async () => {
    await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/freeze`, ...as(alice), payload: { reason: 'Audit' } }, 200);
    const refused = await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(bob), payload: { values: { title: 'Lunch', category: 'meals', amount: 18 } } }, 403);
    expect(refused.json().details.reasons).toEqual([expect.objectContaining({ kind: 'denied_by_guardrail', guardrailId: 'gr.space.frozen-read-only' })]);
    // Reading still works.
    await inject({ method: 'GET', url: records(), ...as(bob) }, 200);
  });
});
