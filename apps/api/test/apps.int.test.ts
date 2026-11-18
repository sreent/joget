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
const line = (merchant: string, category: string, amount: number, date = '2026-11-02') => ({ date, merchant, category, amount });
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
    expect(body.plan.steps).toEqual([
      { kind: 'create_entity', description: 'Create expense_claim', destructive: false },
      { kind: 'create_entity', description: 'Create expense_line, the lines of expense_claim.lines', destructive: false },
    ]);
  });

  it('starts team apps empty, and refuses other people\'s personal spaces', async () => {
    const team = await inject({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Finance', coOwnerUserIds: [carol.userId] } }, 201);
    const refused = await inject({ method: 'POST', url: `/v1/spaces/${team.json().id}/apps`, ...as(alice), payload: { name: 'Team app', definition: EXPENSE_APP } }, 422);
    expect(refused.json().error).toBe('team_app_starts_empty');
    const created = await inject({ method: 'POST', url: `/v1/spaces/${team.json().id}/apps`, ...as(alice), payload: { name: 'Team app' } }, 201);
    expect(created.json().app).toMatchObject({ kind: 'team', revision: 1, environment: null, environments: [], access: { build: true, run: false } });
    await inject({ method: 'POST', url: `/v1/spaces/${bob.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Sneaky' } }, 403);
  });

  it('runs the rules on the server, on every line, whatever the client', async () => {
    const zero = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Lunch', lines: [line('Cafe', 'meals', 12), line('Free lunch', 'meals', 0)] } } }, 422);
    expect(zero.json()).toMatchObject({ error: 'rule_failed', details: { findings: [{ rule: 'positive_amount', fields: ['lines[1].amount'], line: { field: 'lines', index: 1 } }] } });
    const typo = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Taxi', lines: [line('Grab', 'taxi', 12)] } } }, 422);
    expect(typo.json().details.issues).toEqual([expect.objectContaining({ field: 'lines[0].category', code: 'invalid_option' })]);
    const none = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Nothing' } } }, 422);
    expect(none.json().details.issues).toEqual([expect.objectContaining({ field: 'lines', code: 'required' })]);
  });

  it('lets the owner use their own app fully, and works out the total', async () => {
    const created = await inject({
      method: 'POST',
      url: records(),
      ...as(alice),
      payload: { values: { title: 'Conference', iban: 'SG00 ALICE', total: 1, lines: [line('Ticket', 'travel', 450)] } },
    }, 422);
    expect(created.json().details.issues).toEqual([expect.objectContaining({ field: 'total', code: 'not_writable' })]);
    const ok = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Conference', iban: 'SG00 ALICE', lines: [line('Ticket', 'travel', 450), line('Taxi', 'travel', 0.1), line('Bus', 'travel', 0.2)] } } }, 201);
    const record = ok.json();
    expect(record).toMatchObject({ version: 1, owner: alice.userId, values: { title: 'Conference', status: 'draft', iban: 'SG00 ALICE', total: 450.3 }, masked: [] });
    expect(record.values.lines.map((l: { merchant: string; id: string }) => [l.merchant, typeof l.id])).toEqual([['Ticket', 'string'], ['Taxi', 'string'], ['Bus', 'string']]);
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
    dropping.flows.check_approval.steps = dropping.flows.check_approval.steps.filter((step: { values?: object }) => !(step.values && 'approver' in step.values));
    dropping.roles.approver.entities.expense_claim.update.fields = { include: ['status'] };
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
    expect(listed).toEqual([expect.objectContaining({ id: appId, access: { build: false, run: true, share: false, edit: false, compose: false, roles: ['requester'] } })]);
    await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(bob) }, 403);
    await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(bob), payload: { email: 'carol@example.com', role: 'requester' } }, 403);
  });

  it('describes what each person can use, for screens', async () => {
    const bobs = (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(bob) }, 200)).json();
    expect(bobs.entities.expense_claim.can).toEqual({ read: true, create: true, update: false, delete: false });
    expect(bobs.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'iban')).toMatchObject({ read: 'full', create: true, update: false });
    expect(bobs.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'total')).toMatchObject({ computed: true, create: false, read: 'full' });
    const lines = bobs.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'lines');
    expect(lines).toMatchObject({ type: 'lines', create: true, lines: { max: 50, label: 'Receipt' } });
    expect(lines.lines.fields.map((f: { name: string; create: boolean }) => `${f.name}:${f.create}`)).toEqual(['date:true', 'merchant:true', 'category:true', 'amount:true', 'receipt:true']);
    // Lines are part of a claim, never a page of their own.
    expect(Object.keys(bobs.entities)).toEqual(['expense_claim']);
    expect(Object.keys(bobs.actions)).toEqual(['submit_claim']);
    expect(Object.keys(bobs.forms)).toEqual(['claim_form']);
    const carols = (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(carol) }, 200)).json();
    expect(carols.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'iban')).toMatchObject({ read: 'masked', update: false });
    expect(carols.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'status')).toMatchObject({ update: true });
    expect(Object.keys(carols.actions)).toEqual(['approve_claim']);
    expect(carols.forms).toEqual({});
  });

  it('shows each person only the records and fields their role allows', async () => {
    const submitted = await inject({
      method: 'POST',
      url: `/v1/apps/${appId}/actions/submit_claim/run`,
      ...as(bob),
      payload: { values: { title: 'Taxi to the airport', journey: 'Singapore', lines: [line('Comfort', 'travel', 32.4)], iban: 'SG11 BOB' } },
    }, 201);
    expect(submitted.json()).toMatchObject({ status: 'done', record: { owner: bob.userId, values: { status: 'submitted', iban: 'SG11 BOB', total: 32.4 } } });

    const mine = (await inject({ method: 'GET', url: records(), ...as(bob) }, 200)).json().records;
    expect(mine.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Taxi to the airport']);

    const forApproval = (await inject({ method: 'GET', url: records(), ...as(carol) }, 200)).json().records;
    expect(forApproval).toHaveLength(1);
    expect(forApproval[0].values).not.toHaveProperty('iban');
    expect(forApproval[0].masked).toEqual(['iban']);
    expect(forApproval[0].values.lines).toEqual([{ id: expect.any(String), ...line('Comfort', 'travel', 32.4), receipt: null }]);

    // Carol may change only the status, and only through what her role allows: not the lines either.
    const lines = forApproval[0].values.lines.map((l: { id: string }) => ({ ...l, amount: 1 }));
    const relined = await inject({ method: 'PATCH', url: `${records()}/${forApproval[0].id}`, ...as(carol), payload: { values: { lines } } }, 403);
    expect(relined.json().error).toBe('not_allowed');
    const edit = await inject({ method: 'PATCH', url: `${records()}/${forApproval[0].id}`, ...as(carol), payload: { values: { title: 'Cheaper' } } }, 403);
    expect(edit.json().error).toBe('not_allowed');
    // Alice's draft is invisible to Carol, so it doesn't exist as far as she can tell.
    const aliceDraft = (await inject({ method: 'GET', url: records(), ...as(alice) }, 200)).json().records.find((r: { owner: string }) => r.owner === alice.userId);
    await inject({ method: 'PATCH', url: `${records()}/${aliceDraft.id}`, ...as(carol), payload: { values: { status: 'approved' } } }, 404);
  });

  it('gives each person the pages and menu their role uses, and runs a page\'s list under their permissions', async () => {
    const ui = async (session: Session) => (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(session) }, 200)).json();
    const [alices, bobs, carols] = [await ui(alice), await ui(bob), await ui(carol)];
    // The builder holds none of the app's roles, so sees every page; each colleague sees the pages for their role.
    // The menu orders pages; the definition's map of them has no order of its own.
    expect(Object.keys(alices.pages).sort()).toEqual(['my_claims', 'spending', 'to_approve']);
    expect(Object.keys(bobs.pages).sort()).toEqual(['my_claims', 'spending']);
    expect(Object.keys(carols.pages).sort()).toEqual(['my_claims', 'spending', 'to_approve']);
    expect(bobs.navigation).toEqual({
      home: 'my_claims',
      // The heading over the page for approvers goes with it: nothing is left under it for Bob.
      items: [
        { page: 'my_claims', label: 'My claims' },
        { form: 'claim_form', label: 'Claim an expense' },
        { entity: 'expense_claim', label: 'All claims' },
        { page: 'spending', label: 'Spending' },
      ],
    });
    // Carol can't claim, so she gets no button and no menu item for it. She can approve, so the row action is hers.
    expect(carols.navigation.items).toEqual([
      { page: 'my_claims', label: 'My claims' },
      { entity: 'expense_claim', label: 'All claims' },
      { page: 'spending', label: 'Spending' },
      { heading: 'Approvals' },
      { page: 'to_approve', label: 'To approve' },
    ]);
    expect(carols.pages.my_claims.blocks.map((block: { type: string }) => block.type)).toEqual(['list']);
    expect(carols.pages.to_approve.blocks[1]).toMatchObject({
      type: 'list',
      path: '1',
      actions: ['approve_claim'],
      columns: [{ name: 'title' }, { name: 'total' }, { name: 'owner', label: 'Owner' }, { name: 'created_at', label: 'Created' }],
    });
    expect(bobs.pages.my_claims.blocks[1].actions).toEqual([]);

    const rows = async (session: Session, page: string, block: number) =>
      (await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/${page}/blocks/${block}/records`, ...as(session) }, 200)).json().records as Array<{ values: Record<string, unknown> }>;
    // "To approve" is the submitted claims that Carol may read; "My claims" is whoever asks.
    expect((await rows(carol, 'to_approve', 1)).map((record) => record.values['title'])).toEqual(['Taxi to the airport']);
    expect((await rows(bob, 'my_claims', 1)).map((record) => record.values['title'])).toEqual(['Taxi to the airport']);
    expect(await rows(carol, 'my_claims', 1)).toEqual([]);
    // A list reads its columns only.
    expect(Object.keys((await rows(bob, 'my_claims', 1))[0]!.values).sort()).toEqual(['status', 'title', 'total']);
    await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/my_claims/blocks/0/records`, ...as(bob) }, 404);
    await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/nowhere/blocks/1/records`, ...as(bob) }, 404);
  });

  it('works out a dashboard\'s numbers over what each person may read, and never over what their role hides', async () => {
    const summary = async (session: Session, block: number, expected = 200) =>
      (await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/spending/blocks/${block}/summary`, ...as(session) }, expected)).json();
    const carols = (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(carol) }, 200)).json();
    expect(carols.pages.spending.blocks.map((block: { type: string; path: string }) => `${block.type}:${block.path}`)).toEqual(['stat:0', 'stat:1', 'stat:2', 'chart:3', 'chart:4']);
    expect(carols.pages.spending.blocks[3]).toMatchObject({ title: 'Spending by category (SGD)', show: 'bar', width: 'half', op: 'sum', decimals: 2, group: { label: 'Category', kind: 'value' } });
    expect(carols.pages.spending.blocks[4]).toMatchObject({ show: 'column', group: { label: 'Date', kind: 'period', period: 'month' } });

    // Bob's taxi claim is the one submitted claim; Alice's is a draft, which Carol can't read.
    expect(await summary(carol, 0)).toEqual({ value: 1 });
    expect(await summary(bob, 0)).toEqual({ value: 1 });
    expect(await summary(alice, 0)).toEqual({ value: 1 });
    // Receipts: Carol reads only submitted and approved claims; Alice reads all of them.
    expect(await summary(carol, 2)).toEqual({ value: 1 });
    expect((await summary(alice, 2)).value).toBeGreaterThan(1);
    expect(await summary(carol, 3)).toEqual({ groups: [{ key: 'travel', label: 'Travel', value: 32.4 }], other: null, more: 0 });
    const months = await summary(carol, 4);
    expect(months.groups).toEqual([{ key: '2026-11-01', label: '2026-11-01', value: 32.4 }]);

    // Approved this year: a range on when claims were made, and nothing approved yet.
    expect(await summary(carol, 1)).toEqual({ value: 0 });
    await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/my_claims/blocks/1/summary`, ...as(bob) }, 404);
  });

  it('refuses a number over a field a role masks, and leaves it off that person\'s page', async () => {
    const { revision, definition } = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
    definition.pages.spending.blocks.push({ type: 'chart', title: 'By bank account', entity: 'expense_claim', measure: { op: 'count' }, group: { field: 'iban' } });
    await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), payload: { definition, baseRevision: revision } }, 200);
    // Carol sees bank accounts masked, so the chart isn't on her page, and its numbers are refused.
    const carols = (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(carol) }, 200)).json();
    expect(carols.pages.spending.blocks.map((block: { path: string }) => block.path)).not.toContain('5');
    const refused = await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/spending/blocks/5/summary`, ...as(carol) }, 403);
    expect(refused.json().error).toBe('hidden_field');
    // Bob reads his own bank account in full, so he may group by it.
    expect((await inject({ method: 'GET', url: `/v1/apps/${appId}/pages/spending/blocks/5/summary`, ...as(bob) }, 200)).json()).toEqual({
      groups: [{ key: 'SG11 BOB', label: 'SG11 BOB', value: 1 }],
      other: null,
      more: 0,
    });
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
    // Its steps recorded the approver, and the history says the platform set it.
    expect(history[1].changes).toEqual([
      { field: 'status', before: 'submitted', after: 'approved' },
      { field: 'approver', before: null, after: carol.userId, source: { source: 'platform' } },
    ]);
    expect(history[1].actor).toEqual({ type: 'user', id: carol.userId, onBehalfOf: null });
    // Changes come in the entity's field order, the owner last.
    const { definition } = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
    const order: string[] = [...definition.entities.expense_claim.fields.map((f: { name: string }) => f.name), 'owner'];
    const created = history[0].changes.map((c: { field: string }) => c.field);
    expect(created).toEqual([...created].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(created.at(-1)).toBe('owner');
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
    // Errands, not raw tables: the agent can run actions and queries, and touch records only through them.
    agentToken = await mintPat(bob, ['app.run', 'action.run', 'query.run']);
    const direct = await inject({ method: 'POST', url: records(), ...bearer(agentToken), payload: { values: { title: 'Sneaky', lines: [line('Shop', 'meals', 5)] } } }, 403);
    expect(direct.json().details.reasons).toEqual([{ kind: 'outside_token_scope' }]);
    await inject({ method: 'GET', url: records(), ...bearer(agentToken) }, 403);
    const init = await rpc(agentToken, '/mcp', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    const tools = (await rpc(agentToken, '/mcp', 'tools/list')).result.tools as Array<{ name: string; inputSchema: any }>;
    // Bob's own side project shows in full; in Alice's app, only what his requester role allows.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'expenses__my_claims',
      'expenses__my_spending',
      'expenses__submit_claim',
      'side_project__approve_claim',
      'side_project__my_claims',
      'side_project__my_spending',
      'side_project__submit_claim',
    ]);
    const submit = tools.find((tool) => tool.name === 'expenses__submit_claim')!;
    const lines = submit.inputSchema.properties.values.properties.lines;
    expect(lines).toMatchObject({ type: 'array', minItems: 1, maxItems: 50, items: { required: ['date', 'merchant', 'category', 'amount'], additionalProperties: false } });
    expect(lines.items.properties.category).toMatchObject({ type: 'string', enum: ['travel', 'hotel', 'meals'] });
    expect(submit.inputSchema.properties.values.required).toEqual(['title', 'lines']);
  });

  it('answers questions that total and group, over only the records the person may read', async () => {
    // Bob's own receipts, worked out here, as the query should.
    const mine = (await inject({ method: 'GET', url: records(), ...as(bob) }, 200)).json().records as Array<{ owner: string; values: { lines: Array<{ category: string; amount: number; date: string }> } }>;
    const year = new Date().toISOString().slice(0, 4);
    const totals = new Map<string, number>();
    for (const record of mine.filter((r) => r.owner === bob.userId)) {
      for (const l of record.values.lines.filter((l) => l.date.startsWith(year))) totals.set(l.category, Number(((totals.get(l.category) ?? 0) + l.amount).toFixed(2)));
    }
    const expected = [...totals].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value }));
    expect(expected.length).toBeGreaterThan(0);

    const answered = (await inject({ method: 'POST', url: `/v1/apps/${appId}/queries/my_spending/run`, ...as(bob), payload: {} }, 200)).json();
    expect(answered.groups.map(({ key, value }: { key: string; value: number }) => ({ key, value }))).toEqual(expected);
    expect(answered.groups[0].label).toMatch(/^[A-Z]/);
    // Carol's role doesn't include the query.
    await inject({ method: 'POST', url: `/v1/apps/${appId}/queries/my_spending/run`, ...as(carol), payload: {} }, 403);

    // The agent asks the same question as a tool, and gets the same answer.
    const tools = (await rpc(agentToken, '/mcp', 'tools/list')).result.tools as Array<{ name: string; description: string }>;
    expect(tools.find((tool) => tool.name === 'expenses__my_spending')!.description).toContain('Returns a number for each group');
    const call = await rpc(agentToken, '/mcp', 'tools/call', { name: 'expenses__my_spending', arguments: {} });
    expect(call.result.structuredContent).toEqual(answered);
  });

  it('turns an agent\'s action into a proposal, with the rule findings and where each value came from', async () => {
    const call = await rpc(agentToken, '/mcp', 'tools/call', {
      name: 'expenses__submit_claim',
      arguments: {
        values: { title: 'Singapore trip', journey: 'Singapore', lines: [line('Marina Bay Sands', 'hotel', 270), line('Comfort', 'travel', 32.4)] },
        provenance: { 'lines[0].amount': { source: 'document', document: 'receipt.jpg' }, journey: { source: 'agent', note: 'From the calendar' } },
      },
    });
    const result = call.result.structuredContent;
    expect(result.status).toBe('needs_confirmation');
    expect(result.card.findings).toEqual([expect.objectContaining({ rule: 'hotel_cap', severity: 'warning', line: { field: 'lines', index: 0 } })]);
    expect(result.card.tables[0].rows.map((row: { id: string | null }) => typeof row.id)).toEqual(['string', 'string']);
    expect(call.result.content[0].text).toMatch(/^Waiting for the person to confirm/);
    proposalId = result.proposal.id;
    // Nothing is written until Bob approves.
    const mine = (await inject({ method: 'GET', url: records(), ...as(bob) }, 200)).json().records;
    expect(mine.map((r: { values: { title: string } }) => r.values.title)).not.toContain('Singapore trip');
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
    expect(review.body).toContain('<link rel="stylesheet" href="/assets/ocean.css">');
    expect(review.body).toContain('Prepared by an agent, acting for you');
    expect(review.body).toContain('Singapore trip: SGD 302.40');
    expect(review.body).toContain('Line 1: Hotel is above the SGD 250 nightly cap');
    expect(review.body).toContain('Marina Bay Sands');
    expect(review.body).toContain('Read from receipt.jpg');
    expect(review.body).toContain('Inferred by the agent: From the calendar');

    // Bob corrects the hotel line: its other values, and the taxi line, keep where they came from.
    const sealed = (await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...as(bob) }, 200)).json();
    const [hotel, taxi] = sealed.card.tables[0].rows.map((row: { id: string }) => row.id);
    const form = new URLSearchParams({
      title: 'Singapore trip',
      journey: 'Singapore',
      iban: '',
      'lines[0][id]': hotel,
      'lines[0][date]': '2026-11-02',
      'lines[0][merchant]': 'Marina Bay Sands',
      'lines[0][category]': 'hotel',
      'lines[0][amount]': '240',
      'lines[1][id]': taxi,
      'lines[1][date]': '2026-11-02',
      'lines[1][merchant]': 'Comfort',
      'lines[1][category]': 'travel',
      'lines[1][amount]': '32.4',
      'lines[2][date]': '',
      'lines[2][merchant]': '',
      'lines[2][category]': '',
      'lines[2][amount]': '',
    });
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
    expect(record).toMatchObject({ owner: bob.userId, values: { title: 'Singapore trip', total: 272.4, status: 'submitted' } });
    // The lines are the ones Bob saw, with the IDs the proposal gave them.
    const sealed = (await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...as(bob) }, 200)).json();
    expect(record.values.lines.map((l: { id: string; amount: number }) => [l.id, l.amount])).toEqual(sealed.card.tables[0].rows.map((row: { id: string }, i: number) => [row.id, [240, 32.4][i]]));
    const history = (await inject({ method: 'GET', url: `${records()}/${record.id}/history`, ...as(bob) }, 200)).json().history;
    const sources = Object.fromEntries(history[0].changes.map((c: { field: string; source?: { source: string } }) => [c.field, c.source?.source ?? null]));
    expect(sources).toMatchObject({ journey: 'agent', title: null });
    const added = history[0].changes.find((c: { field: string }) => c.field === 'lines').lines.added;
    expect(added.map((l: { values: { merchant: string } }) => l.values.merchant)).toEqual(['Marina Bay Sands', 'Comfort']);
    expect(added[0].sources).toEqual({ amount: { source: 'person' } });
    expect(added[1].sources).toBeUndefined();

    const twice = await inject({ method: 'POST', url: `/v1/proposals/${proposalId}/approve`, ...as(bob), payload: { digest: proposal.digest } }, 409);
    expect(twice.json().error).toBe('not_pending');

    const audit = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.appId, appId), eq(auditEvents.action, 'record.create')));
    const fromProposal = audit.find((event) => (event.reason as { proposal?: string } | null)?.proposal === proposalId);
    expect(fromProposal).toBeDefined();
    expect(fromProposal!.changes).toEqual({ fields: expect.arrayContaining(['lines', 'title', 'total']) });
    expect(JSON.stringify(fromProposal)).not.toContain('Marina Bay');
  });

  it('answers queries as the person, through MCP', async () => {
    const result = (await rpc(agentToken, '/mcp', 'tools/call', { name: 'expenses__my_claims', arguments: {} })).result;
    expect(result.structuredContent.records.map((r: { values: { title: string; total: number } }) => [r.values.title, r.values.total])).toEqual([
      ['Singapore trip', 272.4],
      ['Taxi to the airport', 32.4],
    ]);
    expect(result.content[0].text).toMatch(/^2 record\(s\)/);
  });
});

describe('lines', () => {
  it('changes only what is sent, keeps the order, and records every change', async () => {
    const created = (await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Week in Penang', lines: [line('Hotel', 'hotel', 200), line('Taxi', 'travel', 20), line('Dinner', 'meals', 40)] } } }, 201)).json();
    const [hotel, taxi] = created.values.lines;
    // Keep the taxi, cheaper; drop dinner; add a ferry; put the taxi first.
    const updated = await inject({
      method: 'PATCH',
      url: `${records()}/${created.id}`,
      ...as(alice),
      payload: { version: 1, values: { lines: [{ id: taxi.id, amount: 18 }, { id: hotel.id }, line('Ferry', 'travel', 12)] }, provenance: { 'lines[0].amount': { source: 'person' } } },
    }, 200);
    const record = updated.json();
    expect(record).toMatchObject({ version: 2, values: { total: 230 } });
    expect(record.values.lines.map((l: { merchant: string; amount: number }) => `${l.merchant} ${l.amount}`)).toEqual(['Taxi 18', 'Hotel 200', 'Ferry 12']);
    expect(record.values.lines[0].id).toBe(taxi.id);

    const history = (await inject({ method: 'GET', url: `${records()}/${created.id}/history`, ...as(alice) }, 200)).json().history;
    const change = history[1].changes.find((c: { field: string }) => c.field === 'lines').lines;
    expect(change).toMatchObject({
      added: [{ values: { merchant: 'Ferry', amount: 12 } }],
      removed: [{ values: { merchant: 'Dinner', amount: 40 } }],
      changed: [{ id: taxi.id, changes: [{ field: 'amount', before: 20, after: 18, source: { source: 'person' } }] }],
      reordered: true,
    });
    expect(history[1].changes.find((c: { field: string }) => c.field === 'total')).toEqual({ field: 'total', before: 260, after: 230 });

    // Sending the same lines again changes nothing.
    const same = await inject({ method: 'PATCH', url: `${records()}/${created.id}`, ...as(alice), payload: { values: { lines: record.values.lines } } }, 200);
    expect(same.json().version).toBe(2);
    const unknown = await inject({ method: 'PATCH', url: `${records()}/${created.id}`, ...as(alice), payload: { values: { lines: [{ id: '0193a7c4-0000-7000-8000-000000000999', amount: 1 }] } } }, 422);
    expect(unknown.json().details.issues).toEqual([expect.objectContaining({ field: 'lines[0].id' })]);
  });

  it('shows each role only the fields of lines it may see', async () => {
    const current = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
    const definition = structuredClone(current.definition);
    definition.roles.approver.entities.expense_claim.read.mask = ['lines.merchant'];
    await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), payload: { definition, baseRevision: current.revision } }, 200);
    const claims = (await inject({ method: 'GET', url: records(), ...as(carol) }, 200)).json().records;
    const taxi = claims.find((r: { values: { title: string } }) => r.values.title === 'Taxi to the airport');
    expect(taxi.masked).toEqual(['lines.merchant', 'iban']);
    expect(taxi.values.lines).toEqual([{ id: expect.any(String), date: '2026-11-02', category: 'travel', amount: 32.4, receipt: null }]);
    const history = (await inject({ method: 'GET', url: `${records()}/${taxi.id}/history`, ...as(carol) }, 200)).json().history;
    expect(history[0].changes.find((c: { field: string }) => c.field === 'lines').lines.added).toEqual([
      { id: expect.any(String), values: { date: '2026-11-02', category: 'travel', amount: 32.4, receipt: null }, masked: ['merchant'] },
    ]);
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
    expect(apps.map((a: { name: string }) => a.name)).toEqual(['Expenses', 'Team app']);
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
    for (const section of dropping.forms.claim_form.sections) section.fields = section.fields.filter((f: { field: string }) => f.field !== 'journey');
    const held = await rpc(builderToken, '/mcp/build', 'tools/call', { name: 'apply_change', arguments: { app_id: appId, definition: dropping } });
    expect(held.result).toMatchObject({ isError: true, structuredContent: { error: 'destructive_change' } });
    expect(held.result.structuredContent.details.plan.steps).toEqual([expect.objectContaining({ kind: 'drop_field', records: 2 })]);

    const asToken = await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition?confirmDestructive=true`, ...bearer(builderToken), payload: { definition: dropping } }, 403);
    expect(asToken.json().error).toBe('session_required');
  });

  it('changes a definition with small edits: checked first, and saved on request', async () => {
    const edit = (args: Record<string, unknown>) => rpc(builderToken, '/mcp/build', 'tools/call', { name: 'edit_definition', arguments: { app_id: appId, ...args } });
    const fieldsNow = async () => {
      const current = (await rpc(builderToken, '/mcp/build', 'tools/call', { name: 'get_definition', arguments: { app_id: appId } })).result.structuredContent;
      return { revision: current.revision, names: current.definition.entities.expense_claim.fields.map((field: { name: string }) => field.name) };
    };
    const edits = [{ op: 'add', path: '/entities/expense_claim/fields/-', value: { name: 'cost_centre', label: 'Cost centre', type: 'text' } }];
    const checked = await edit({ edits });
    expect(checked.result.isError).toBeUndefined();
    expect(checked.result.structuredContent.plan).toMatchObject({ steps: [{ kind: 'add_field' }] });
    const before = await fieldsNow();
    expect(before.names).not.toContain('cost_centre');
    const saved = await edit({ edits, apply: true, base_revision: before.revision });
    expect(saved.result.structuredContent.plan).toMatchObject({ steps: [{ kind: 'add_field' }] });
    expect((await fieldsNow()).names).toContain('cost_centre');

    // An edit that leads nowhere changes nothing, and one that the checks refuse names the problem.
    expect((await edit({ edits: [{ op: 'replace', path: '/entities/nothing/label', value: 'x' }] })).result).toMatchObject({ isError: true, structuredContent: { error: 'edit_failed' } });
    expect((await edit({ edits: [{ op: 'replace', path: '/entities/expense_claim/label', value: '' }] })).result).toMatchObject({ isError: true, structuredContent: { error: 'invalid_definition' } });
  });

  it("can't reach apps the person can't build", async () => {
    const bobToken = await mintPat(bob, ['app.read', 'app.edit']);
    const denied = await rpc(bobToken, '/mcp/build', 'tools/call', { name: 'get_definition', arguments: { app_id: appId } });
    expect(denied.result).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
  });
});

describe('the look', () => {
  it('serves Ocean and its fonts from Ambit itself, and nothing else', async () => {
    const css = await inject({ method: 'GET', url: '/assets/ocean.css', ...as(bob) }, 200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.body).toContain('--accent: var(--ocean-600);');
    const font = await inject({ method: 'GET', url: '/assets/fonts/plex-sans-400.woff2', ...as(bob) }, 200);
    expect(font.headers['content-type']).toBe('font/woff2');
    await inject({ method: 'GET', url: '/assets/..%2Fpackage.json', ...as(bob) }, 400);
    await inject({ method: 'GET', url: '/assets/fonts/OFL-plex-sans.txt', ...as(bob) }, 400);
    await inject({ method: 'GET', url: '/assets/ocean.css' }, 401);
  });
});

describe('guardrails', () => {
  it('make a frozen space read-only for everyone, data included', async () => {
    await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/freeze`, ...as(alice), payload: { reason: 'Audit' } }, 200);
    const refused = await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(bob), payload: { values: { title: 'Lunch', lines: [line('Cafe', 'meals', 18)] } } }, 403);
    expect(refused.json().details.reasons).toEqual([expect.objectContaining({ kind: 'denied_by_guardrail', guardrailId: 'gr.space.frozen-read-only' })]);
    // Reading still works.
    await inject({ method: 'GET', url: records(), ...as(bob) }, 200);
  });
});
