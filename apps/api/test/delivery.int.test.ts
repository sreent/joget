import { EXPENSE_APP } from '@platform/app-model';
import { appEnvironments, auditEvents, changeRequests, skillCalls } from '@platform/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Phase 2's exit criterion, end to end: a change goes from a builder's personal space, through a
 * reviewed preview, to Prod, and is rolled back in under a minute. Around it: separation of
 * duties, fresh MFA for Prod, signed and immutable releases, and data-deleting changes on their own.
 */

let t: TestApp;
let alice: Session; // org owner, and an owner of the Finance space
let olivia: Session; // the other owner of the Finance space
let carol: Session; // builder, and a reviewer of other people's changes
let gina: Session; // another builder
let dave: Session; // reviewer
let erin: Session; // release manager
let frank: Session; // uses the app in Prod, and has no role in the space
let spaceId: string;
let teamId: string;
let copyId: string;
let firstCr: { id: string; number: number; preview: { environmentId: string } };

type Json = Record<string, any>;
const as = (session: Session) => ({ cookies: session.cookies });
const line = (merchant: string, amount: number) => ({ date: '2026-11-02', merchant, category: 'meals', amount });
/** A claim as a requester may create it: submitted. */
const claim = (title: string, extra: Json = {}) => ({ values: { title, status: 'submitted', lines: [line('Cafe', 12)], ...extra } });

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

const json = async (options: InjectOptions, expected: number): Promise<Json> => (await inject(options, expected)).json();

/** Change a working copy's definition, as the studio does: read it, edit it, save it. */
async function editCopy(session: Session, appId: string, edit: (definition: Json) => void, query = '') {
  const current = await json({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(session) }, 200);
  edit(current.definition);
  return json({ method: 'PUT', url: `/v1/apps/${appId}/definition${query}`, ...as(session), payload: { definition: current.definition, baseRevision: current.revision } }, 200);
}

const submit = (session: Session, appId: string, title: string, expected = 201) =>
  json({ method: 'POST', url: `/v1/apps/${appId}/submit`, ...as(session), payload: { title } }, expected);
const review = (session: Session, crId: string, verdict: string, comment?: string, expected = 200) =>
  inject({ method: 'POST', url: `/v1/change-requests/${crId}/reviews`, ...as(session), payload: { verdict, ...(comment ? { comment } : {}) } }, expected);
const merge = (session: Session, crId: string, expected = 200) => inject({ method: 'POST', url: `/v1/change-requests/${crId}/merge`, ...as(session) }, expected);
const cut = (session: Session, payload: Json = {}, expected = 201) => inject({ method: 'POST', url: `/v1/apps/${teamId}/releases`, ...as(session), payload }, expected);
const deploy = (session: Session, payload: Json, expected = 201) => inject({ method: 'POST', url: `/v1/apps/${teamId}/deployments`, ...as(session), payload }, expected);
const prodRecords = (query = '') => `/v1/apps/${teamId}/entities/expense_claim/records${query}`;

/** Approve, merge and release a change, as reviewer and release manager. */
async function shipToMain(crId: string): Promise<void> {
  await review(dave, crId, 'approve');
  await merge(erin, crId);
}

/** Deploy a release to Prod: requested by the release manager, approved by the reviewer, executed. */
async function deployToProd(releaseId: string, confirmDestructive = false): Promise<Json> {
  const requested = (await deploy(erin, { releaseId, env: 'prod', confirmDestructive })).json();
  await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/approve`, ...as(dave) }, 200);
  return json({ method: 'POST', url: `/v1/deployments/${requested.id}/execute`, ...as(erin) }, 200);
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, olivia, carol, gina, dave, erin, frank] = await Promise.all([
    t.login('alice'),
    t.login('olivia'),
    t.login('carol'),
    t.login('gina'),
    t.login('dave'),
    t.login('erin'),
    t.login('frank'),
  ]);
  spaceId = (await json({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Finance', coOwnerUserIds: [olivia.userId] } }, 201)).id;
  const grant = (session: Session, roleId: string) =>
    inject({ method: 'POST', url: '/v1/bindings', ...as(alice), payload: { principal: { type: 'user', id: session.userId }, roleId, scope: { type: 'space', id: spaceId } } }, 201);
  await grant(carol, 'space.builder');
  await grant(carol, 'space.reviewer');
  await grant(gina, 'space.builder');
  await grant(dave, 'space.reviewer');
  await grant(erin, 'space.release_manager');
});

afterAll(async () => {
  await t?.close();
});

describe('team apps and working copies', () => {
  it('starts a team app empty, with no environment, and refuses changes made directly to it', async () => {
    const created = await json({ method: 'POST', url: `/v1/spaces/${spaceId}/apps`, ...as(carol), payload: { name: 'Expenses' } }, 201);
    teamId = created.app.id;
    expect(created.app).toMatchObject({ kind: 'team', environment: null, environments: [], myWorkingCopyId: null, access: { build: true, edit: true, run: false } });
    expect(created.app.access.delivery).toMatchObject({ review: true, approve: true, merge: false, release: false, deploy: false });

    const refused = await inject({ method: 'PUT', url: `/v1/apps/${teamId}/definition`, ...as(carol), payload: { definition: EXPENSE_APP } }, 409);
    expect(refused.json().error).toBe('change_request_required');
    const notLive = await inject({ method: 'GET', url: `/v1/apps/${teamId}/ui`, ...as(carol) }, 404);
    expect(notLive.json().error).toBe('not_live');
  });

  it('makes a working copy in the builder\'s personal space, once, with the main line\'s stable IDs', async () => {
    const made = await json({ method: 'POST', url: `/v1/apps/${teamId}/working-copy`, ...as(carol) }, 200);
    expect(made).toMatchObject({ created: true, sampleRecords: 0 });
    copyId = made.app.id;
    expect(made.app).toMatchObject({ kind: 'personal', spaceId: carol.personalSpaceId, workingCopyOf: { appId: teamId, baseRevision: 1, behind: false, changeRequest: null } });
    const again = await json({ method: 'POST', url: `/v1/apps/${teamId}/working-copy`, ...as(carol) }, 200);
    expect(again).toMatchObject({ created: false, app: { id: copyId } });
    expect((await json({ method: 'GET', url: `/v1/apps/${teamId}`, ...as(carol) }, 200)).myWorkingCopyId).toBe(copyId);

    // A viewer of the space can't change it, so gets no working copy.
    await inject({ method: 'POST', url: `/v1/apps/${teamId}/working-copy`, ...as(frank) }, 403);
  });

  it('lets the builder change the copy at once, with test data that stays in their space', async () => {
    await editCopy(carol, copyId, (definition) => Object.assign(definition, structuredClone(EXPENSE_APP)));
    await inject(
      { method: 'POST', url: `/v1/apps/${copyId}/entities/expense_claim/records`, ...as(carol), payload: { values: { title: 'Test claim', lines: [line('Cafe', 12)] } } },
      201,
    );
    const nothing = await inject({ method: 'POST', url: `/v1/apps/${teamId}/submit`, ...as(carol), payload: { title: 'Wrong place' } }, 422);
    expect(nothing.json().error).toBe('not_a_working_copy');
  });
});

describe('change requests', () => {
  it('opens a change request with its checks and a preview', async () => {
    const cr = await submit(carol, copyId, 'First version of expense claims');
    firstCr = cr as typeof firstCr;
    expect(cr).toMatchObject({ number: 1, status: 'open', author: { id: carol.userId }, baseRevision: 1, behind: false, conflicts: [], destructive: false });
    expect(cr.checks.migration.steps.map((s: Json) => s.kind)).toEqual(['create_entity', 'create_entity']);
    expect(cr.checks.access.map((a: Json) => `${a.kind}: ${a.text}`)).toEqual(
      expect.arrayContaining(['gains: Requester is a new role', 'gains: Approver can now update Expense claim, for records that match a condition']),
    );
    expect(cr.checks.capabilities.map((c: Json) => c.text)).toContain('New tool submit_claim: creates Expense claim, and asks the person to review it in full');
    expect(cr.checks.lint).toEqual([]);
    expect(cr.changes).toEqual(expect.arrayContaining([expect.objectContaining({ section: 'entities', name: 'expense_claim', change: 'added' })]));
    expect(cr.preview.environmentId).toEqual(expect.any(String));
    expect(cr.approvals).toEqual({ required: 1, approvedBy: [], changesRequestedBy: [], ready: false });

    const copy = await json({ method: 'GET', url: `/v1/apps/${copyId}`, ...as(carol) }, 200);
    expect(copy.workingCopyOf.changeRequest).toEqual({ id: cr.id, number: 1 });
    const again = await inject({ method: 'POST', url: `/v1/apps/${copyId}/submit`, ...as(carol), payload: {} }, 422);
    expect(again.json().error).toBe('no_new_changes');
  });

  it('lets reviewers click through the preview, with test data of its own, and nobody else', async () => {
    const preview = `?env=${firstCr.preview.environmentId}`;
    const ui = await json({ method: 'GET', url: `/v1/apps/${teamId}/ui${preview}`, ...as(dave) }, 200);
    expect(ui.app.environment).toMatchObject({ kind: 'preview', changeRequest: { id: firstCr.id, number: 1 } });
    expect(Object.keys(ui.entities)).toContain('expense_claim');
    await inject({ method: 'POST', url: prodRecords(preview), ...as(dave), payload: { values: { title: 'Preview claim', status: 'submitted', lines: [line('Taxi', 30)] } } }, 201);
    const listed = await json({ method: 'GET', url: prodRecords(preview), ...as(dave) }, 200);
    expect(listed.records.map((r: Json) => r.values.title)).toEqual(['Preview claim']);
    // Trying a change starts its skills in a7c's team tier, never in production.
    await inject({ method: 'POST', url: `/v1/apps/${teamId}/actions/approve_claim/run${preview}`, ...as(carol), payload: { recordId: listed.records[0].id } }, 200);
    expect(await t.ctx.db.select().from(skillCalls).where(eq(skillCalls.recordId, listed.records[0].id))).toEqual([
      expect.objectContaining({ tier: 'team', environmentId: firstCr.preview.environmentId, skill: 'finance/pay-expense-claim' }),
    ]);

    // Frank has no role in the space: no preview for him.
    await inject({ method: 'GET', url: `/v1/apps/${teamId}/ui${preview}`, ...as(frank) }, 403);
    // The builder's test data never reaches the preview, and the preview's never reaches Prod.
    await inject({ method: 'GET', url: prodRecords(), ...as(dave) }, 404);
  });

  it('keeps the author from approving their own change, and only release managers merge', async () => {
    const own = await review(carol, firstCr.id, 'approve', undefined, 403);
    expect(own.json().details.reasons).toEqual([expect.objectContaining({ kind: 'denied_by_guardrail', guardrailId: 'gr.sod.author-cannot-approve' })]);
    await merge(carol, firstCr.id, 403);
    await merge(dave, firstCr.id, 403);
    const early = await merge(erin, firstCr.id, 409);
    expect(early.json().error).toBe('not_approved');
  });

  it('asks for changes, takes an update to the same change request, and needs approval of the new version', async () => {
    await review(dave, firstCr.id, 'request_changes', 'Approving should need a full review');
    expect((await merge(erin, firstCr.id, 409)).json().message).toMatch(/asked for changes/);

    await editCopy(carol, copyId, (definition) => {
      definition.actions.approve_claim.confirm = 'review';
    });
    const updated = await submit(carol, copyId, 'First version of expense claims', 200);
    expect(updated).toMatchObject({ id: firstCr.id, number: 1 });
    expect(updated.reviews.map((r: Json) => [r.verdict, r.current])).toEqual([['request_changes', false]]);
    expect(updated.approvals).toMatchObject({ approvedBy: [], changesRequestedBy: [], ready: false });
    // The preview moved to the new version, and kept its test data.
    const listed = await json({ method: 'GET', url: prodRecords(`?env=${firstCr.preview.environmentId}`), ...as(dave) }, 200);
    expect(listed.records.map((r: Json) => r.values.title)).toEqual(['Preview claim']);

    const approved = (await review(dave, firstCr.id, 'approve')).json();
    expect(approved.approvals).toMatchObject({ approvedBy: [{ id: dave.userId }], ready: true });
  });

  it('merges into the main line, removes the preview, and brings the author\'s copy in step', async () => {
    const merged = (await merge(erin, firstCr.id)).json();
    expect(merged).toMatchObject({ status: 'merged', preview: null });
    const team = await json({ method: 'GET', url: `/v1/apps/${teamId}`, ...as(carol) }, 200);
    expect(team.revision).toBe(merged.mergedRevision);
    const copy = await json({ method: 'GET', url: `/v1/apps/${copyId}`, ...as(carol) }, 200);
    expect(copy.workingCopyOf).toMatchObject({ baseRevision: merged.mergedRevision, behind: false, changeRequest: null });
    const [preview] = await t.ctx.db.select().from(appEnvironments).where(eq(appEnvironments.id, firstCr.preview.environmentId));
    expect(preview!.status).toBe('deleted');
    const schema = await t.handle.pool.query('select 1 from information_schema.schemata where schema_name = $1', [preview!.schemaName]);
    expect(schema.rowCount).toBe(0);
    const main = await json({ method: 'GET', url: `/v1/apps/${teamId}/definition`, ...as(dave) }, 200);
    expect(main.definition.actions.approve_claim.confirm).toBe('review');
  });
});

describe('releases and deployments', () => {
  let release1: Json;
  let release2: Json;

  it('cuts a signed release that nobody can change', async () => {
    await cut(carol, {}, 403);
    release1 = (await cut(erin, { notes: 'Expense claims, first version' })).json();
    expect(release1).toMatchObject({ number: 1, verified: true, destructive: false, liveIn: [], changes: [{ number: 1, author: { id: carol.userId } }] });
    expect((await cut(erin, {}, 409)).json().error).toBe('nothing_new');
    await expect(t.handle.pool.query("update releases set notes = 'tampered' where id = $1", [release1.id])).rejects.toThrow(/Releases are immutable/);
    await expect(t.handle.pool.query('delete from releases where id = $1', [release1.id])).rejects.toThrow(/Releases are immutable/);
  });

  it('deploys to Staging at once, for testers the space admins name', async () => {
    const staged = (await deploy(erin, { releaseId: release1.id, env: 'staging', execute: true })).json();
    expect(staged).toMatchObject({ environment: 'staging', status: 'succeeded', approvals: { required: 0 }, release: { number: 1 } });
    await inject({ method: 'POST', url: `/v1/apps/${teamId}/shares?env=staging`, ...as(carol), payload: { email: 'frank@example.com', role: 'requester' } }, 403);
    await inject({ method: 'POST', url: `/v1/apps/${teamId}/shares?env=staging`, ...as(alice), payload: { email: 'frank@example.com', role: 'requester' } }, 201);
    await inject({ method: 'POST', url: prodRecords('?env=staging'), ...as(frank), payload: claim('Staging claim') }, 201);
    const listed = await json({ method: 'GET', url: '/v1/apps', ...as(frank) }, 200);
    expect(listed.apps).toEqual([expect.objectContaining({ id: teamId, access: expect.objectContaining({ build: false, run: true }) })]);
    // A role in Staging alone is enough to see the app, though Prod isn't live yet.
    expect((await json({ method: 'GET', url: `/v1/apps/${teamId}`, ...as(frank) }, 200)).access.run).toBe(true);
    await inject({ method: 'GET', url: `/v1/apps/${teamId}/ui?env=nonsense`, ...as(frank) }, 400);
  });

  it('needs an approval for Prod from someone who wrote none of its changes, and fresh MFA', async () => {
    const requested = (await deploy(erin, { releaseId: release1.id, env: 'prod' })).json();
    expect(requested).toMatchObject({ status: 'awaiting_approval', approvals: { required: 1, by: [] }, authors: [{ id: carol.userId }] });
    expect(requested.plan.notes).toContain('Creates Prod: the app\'s first deployment there');
    expect((await deploy(erin, { releaseId: release1.id, env: 'prod' }, 409)).json().error).toBe('deployment_open');

    const author = await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/approve`, ...as(carol) }, 403);
    expect(author.json().details.reasons[0].guardrailId).toBe('gr.sod.author-cannot-approve');
    expect((await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/execute`, ...as(erin) }, 409)).json().error).toBe('not_approved');

    t.clock.offsetMs = 20 * 60_000;
    try {
      const stale = await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/approve`, ...as(dave) }, 403);
      expect(stale.json().details.reasons[0]).toMatchObject({ kind: 'step_up_required', guardrailId: 'gr.step-up.production-deploy' });
    } finally {
      t.clock.offsetMs = 0;
    }
    expect((await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/approve`, ...as(dave) }, 200)).json().status).toBe('approved');
    const done = await json({ method: 'POST', url: `/v1/deployments/${requested.id}/execute`, ...as(erin) }, 200);
    expect(done).toMatchObject({ status: 'succeeded', executedBy: { id: erin.userId } });

    const team = await json({ method: 'GET', url: `/v1/apps/${teamId}`, ...as(erin) }, 200);
    expect(team.environments.map((e: Json) => [e.kind, e.release?.number])).toEqual([['prod', 1], ['staging', 1]]);
  });

  it('serves Prod to the people given a role there, with Prod data only', async () => {
    await inject({ method: 'POST', url: `/v1/apps/${teamId}/shares?env=prod`, ...as(olivia), payload: { email: 'frank@example.com', role: 'requester' } }, 201);
    await inject({ method: 'POST', url: prodRecords(), ...as(frank), payload: claim('Prod claim') }, 201);
    const listed = await json({ method: 'GET', url: prodRecords(), ...as(frank) }, 200);
    expect(listed.records.map((r: Json) => r.values.title)).toEqual(['Prod claim']);
    // Builders and reviewers build the app; they don't see its Prod data.
    await inject({ method: 'GET', url: prodRecords(), ...as(carol) }, 403);
    await inject({ method: 'GET', url: prodRecords(), ...as(dave) }, 403);
    // In Prod, the skills an action starts run in a7c's production tier.
    await inject({ method: 'POST', url: `/v1/apps/${teamId}/shares?env=prod`, ...as(olivia), payload: { email: 'gina@example.com', role: 'approver' } }, 201);
    const prodClaim = listed.records[0];
    await inject({ method: 'POST', url: `/v1/apps/${teamId}/actions/approve_claim/run`, ...as(gina), payload: { recordId: prodClaim.id } }, 200);
    expect(await t.ctx.db.select().from(skillCalls).where(eq(skillCalls.recordId, prodClaim.id))).toEqual([expect.objectContaining({ tier: 'production', onBehalfOf: gina.userId })]);
  });

  it('goes to Prod with a second change, then rolls back in under a minute, keeping the data', async () => {
    await editCopy(carol, copyId, (definition) => {
      definition.entities.expense_claim.fields.push({ name: 'vendor', label: 'Vendor', type: 'text' });
    });
    const cr = await submit(carol, copyId, 'Record the vendor');
    expect(cr.checks.migration.steps).toEqual([{ kind: 'add_field', description: 'Add expense_claim.vendor', destructive: false }]);
    expect(cr.checks.access).toEqual(
      expect.arrayContaining([
        { role: 'requester', kind: 'gains', text: 'Requester can now see Expense claim.vendor', holders: 2 },
        { role: 'approver', kind: 'gains', text: 'Approver can now see Expense claim.vendor', holders: 1 },
      ]),
    );
    await shipToMain(cr.id);
    release2 = (await cut(erin)).json();
    expect(release2).toMatchObject({ number: 2, steps: [{ kind: 'add_field' }], changes: [{ number: 2 }] });
    await deployToProd(release2.id);
    await inject({ method: 'POST', url: prodRecords(), ...as(frank), payload: claim('With vendor', { vendor: 'Acme' }) }, 201);

    const started = Date.now();
    const rolledBack = await json({ method: 'POST', url: `/v1/apps/${teamId}/environments/prod/rollback`, ...as(erin) }, 200);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(rolledBack).toMatchObject({ kind: 'rollback', status: 'succeeded', release: { number: 1 }, fromRelease: { number: 2 } });
    expect(rolledBack.durationMs).toBeLessThan(60_000);

    // Release 1 runs again: it doesn't know the vendor, but the value stays in the data.
    const listed = await json({ method: 'GET', url: prodRecords(), ...as(frank) }, 200);
    const withVendor = listed.records.find((r: Json) => r.values.title === 'With vendor');
    expect(withVendor.values.vendor).toBeUndefined();
    await inject({ method: 'POST', url: prodRecords(), ...as(frank), payload: claim('After rollback') }, 201);
    const unknown = await inject({ method: 'POST', url: prodRecords(), ...as(frank), payload: claim('Too new', { vendor: 'Acme' }) }, 422);
    expect(unknown.json().details.issues).toEqual([expect.objectContaining({ field: 'vendor' })]);
    const team = await json({ method: 'GET', url: `/v1/apps/${teamId}`, ...as(erin) }, 200);
    expect(team.environments.find((e: Json) => e.kind === 'prod').release.number).toBe(1);
    expect((await json({ method: 'GET', url: `/v1/apps/${teamId}/releases`, ...as(erin) }, 200)).releases.map((r: Json) => [r.number, r.liveIn])).toEqual([
      [2, []],
      [1, ['prod', 'staging']],
    ]);
  });

  it('goes forward again, and the value is back', async () => {
    const requested = (await deploy(erin, { releaseId: release2.id, env: 'prod' })).json();
    expect(requested.plan.steps).toEqual([]);
    expect(requested.plan.notes).toContain('Works out stored totals again, because the environment ran an older release for a while');
    await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/approve`, ...as(dave) }, 200);
    await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/execute`, ...as(erin) }, 200);
    const listed = await json({ method: 'GET', url: prodRecords(), ...as(frank) }, 200);
    expect(listed.records.find((r: Json) => r.values.title === 'With vendor').values.vendor).toBe('Acme');
  });

  it('puts a change that deletes data in a release of its own, deploys releases in order, and never rolls one back', async () => {
    await editCopy(
      carol,
      copyId,
      (definition) => {
        definition.entities.expense_claim.fields = definition.entities.expense_claim.fields.filter((f: Json) => f.name !== 'vendor');
      },
      '?confirmDestructive=true',
    );
    const deleting = await submit(carol, copyId, 'Stop recording the vendor');
    expect(deleting).toMatchObject({ destructive: true, checks: { migration: { destructive: true } } });
    await shipToMain(deleting.id);
    await editCopy(carol, copyId, (definition) => {
      definition.queries.my_claims.limit = 20;
    });
    const harmless = await submit(carol, copyId, 'Shorter lists');
    await shipToMain(harmless.id);

    const together = await cut(erin, {}, 409);
    expect(together.json()).toMatchObject({ error: 'destructive_change_alone', details: { deleting: [{ number: deleting.number }] } });
    const release3 = (await cut(erin, { revision: together.json().details.suggestedRevision })).json();
    expect(release3).toMatchObject({ number: 3, destructive: true, changes: [{ number: deleting.number }] });
    const release4 = (await cut(erin)).json();
    expect(release4).toMatchObject({ number: 4, destructive: false, changes: [{ number: harmless.number }] });

    expect((await deploy(erin, { releaseId: release4.id, env: 'prod' }, 409)).json().error).toBe('deploy_in_order');
    const unconfirmed = await deploy(erin, { releaseId: release3.id, env: 'prod' }, 409);
    expect(unconfirmed.json()).toMatchObject({ error: 'destructive_change', details: { plan: { destructive: true, steps: [{ kind: 'drop_field', records: 1 }] } } });
    await deployToProd(release3.id, true);
    const refused = await inject({ method: 'POST', url: `/v1/apps/${teamId}/environments/prod/rollback`, ...as(erin) }, 409);
    expect(refused.json().error).toBe('cannot_roll_back');
    await deployToProd(release4.id);
  });

  it('records every step in the audit log', async () => {
    const rows = await t.ctx.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.appId, teamId), inArray(auditEvents.action, ['change.open', 'change.update', 'change.approve', 'change.merge', 'release.create', 'deploy.request', 'deploy.approve', 'deploy.execute', 'deploy.rollback'])));
    expect(new Set(rows.map((row) => row.action))).toEqual(
      new Set(['change.open', 'change.update', 'change.approve', 'change.merge', 'release.create', 'deploy.request', 'deploy.approve', 'deploy.execute', 'deploy.rollback']),
    );
  });
});

describe('builders working at the same time', () => {
  it('merges changes to different parts three ways, and refuses changes to the same part', async () => {
    const made = await json({ method: 'POST', url: `/v1/apps/${teamId}/working-copy`, ...as(gina) }, 200);
    const ginaCopy = made.app.id as string;
    // A new copy of a team app that has content comes with sample records, never with Prod data.
    expect(made.sampleRecords).toBe(3);
    const samples = await json({ method: 'GET', url: `/v1/apps/${ginaCopy}/entities/expense_claim/records`, ...as(gina) }, 200);
    expect(samples.records.map((r: Json) => r.values.title).sort()).toEqual(['Sample expense claim 1', 'Sample expense claim 2', 'Sample expense claim 3']);
    expect(samples.records[0].values.lines).toHaveLength(2);
    await editCopy(gina, ginaCopy, (definition) => {
      definition.actions.submit_claim.description = 'File a claim. Ask the person to check every receipt first.';
    });
    const ginaCr = await submit(gina, ginaCopy, 'Clearer tool description');

    await editCopy(carol, copyId, (definition) => {
      definition.queries.my_claims.limit = 30;
    });
    const carolCr = await submit(carol, copyId, 'Longer lists');
    await shipToMain(carolCr.id);

    const behind = await json({ method: 'GET', url: `/v1/change-requests/${ginaCr.id}`, ...as(dave) }, 200);
    expect(behind).toMatchObject({ behind: true, conflicts: [] });
    await shipToMain(ginaCr.id);
    const main = await json({ method: 'GET', url: `/v1/apps/${teamId}/definition`, ...as(dave) }, 200);
    expect(main.definition.queries.my_claims.limit).toBe(30);
    expect(main.definition.actions.submit_claim.description).toMatch(/^File a claim/);

    // Gina's copy lacks Carol's change, so it is behind; taking it in brings it level.
    const copy = await json({ method: 'GET', url: `/v1/apps/${ginaCopy}`, ...as(gina) }, 200);
    expect(copy.workingCopyOf.behind).toBe(true);
    const synced = await json({ method: 'POST', url: `/v1/apps/${ginaCopy}/sync`, ...as(gina) }, 200);
    expect(synced.app.workingCopyOf.behind).toBe(false);

    // Both change the same action: the second to merge conflicts.
    await editCopy(gina, ginaCopy, (definition) => {
      definition.actions.approve_claim.description = 'Approve a claim once its receipts are checked.';
    });
    const first = await submit(gina, ginaCopy, 'Approval wording');
    await editCopy(carol, copyId, (definition) => {
      definition.actions.approve_claim.description = 'Approve a submitted claim.';
    });
    const second = await submit(carol, copyId, 'Other approval wording');
    await shipToMain(first.id);
    const conflicting = await json({ method: 'GET', url: `/v1/change-requests/${second.id}`, ...as(dave) }, 200);
    expect(conflicting.conflicts).toEqual([{ section: 'actions', name: 'approve_claim', ours: 'changed', theirs: 'changed' }]);
    await review(dave, second.id, 'approve');
    const refused = await merge(erin, second.id, 409);
    expect(refused.json()).toMatchObject({ error: 'merge_conflict', details: { conflicts: [{ name: 'approve_claim' }] } });
    expect((await inject({ method: 'POST', url: `/v1/apps/${copyId}/sync`, ...as(carol) }, 409)).json().error).toBe('merge_conflict');
    const closed = await json({ method: 'POST', url: `/v1/change-requests/${second.id}/close`, ...as(carol) }, 200);
    expect(closed.status).toBe('closed');
    const environments = await t.ctx.db.select().from(appEnvironments).where(and(eq(appEnvironments.appId, teamId), eq(appEnvironments.kind, 'preview'), eq(appEnvironments.status, 'active')));
    expect(environments).toEqual([]);
  });
});

describe('promotion from a personal space', () => {
  let sourceId: string;
  let promotedId: string;
  const sourceRecords = () => `/v1/apps/${sourceId}/entities/expense_claim/records`;

  it('moves a personal app into a team space through a change request, and leaves its data where it is', async () => {
    sourceId = (await json({ method: 'POST', url: `/v1/spaces/${gina.personalSpaceId}/apps`, ...as(gina), payload: { name: 'Trips', definition: EXPENSE_APP } }, 201)).app.id;
    await inject({ method: 'POST', url: `/v1/apps/${sourceId}/shares`, ...as(gina), payload: { email: 'frank@example.com', role: 'requester' } }, 201);
    await inject({ method: 'POST', url: sourceRecords(), ...as(frank), payload: claim('Before the move') }, 201);

    // Frank builds nothing in Finance, so he can't move an app there.
    const franks = (await json({ method: 'POST', url: `/v1/spaces/${frank.personalSpaceId}/apps`, ...as(frank), payload: { name: 'Mine', definition: EXPENSE_APP } }, 201)).app.id;
    await inject({ method: 'POST', url: `/v1/apps/${franks}/promote`, ...as(frank), payload: { spaceId } }, 403);
    // Only the owner moves an app.
    await inject({ method: 'POST', url: `/v1/apps/${sourceId}/promote`, ...as(frank), payload: { spaceId } }, 403);

    const promoted = await json({ method: 'POST', url: `/v1/apps/${sourceId}/promote`, ...as(gina), payload: { spaceId, name: 'Team trips' } }, 201);
    promotedId = promoted.app.id;
    expect(promoted.app).toMatchObject({ kind: 'team', name: 'Team trips', spaceId, promotedFrom: sourceId, environments: [] });
    expect(promoted.changeRequest).toMatchObject({ number: 1, status: 'open', title: 'Bring in Trips from a personal space', author: { id: gina.userId } });
    expect(promoted.changeRequest.checks.migration.steps.map((step: Json) => step.kind)).toEqual(['create_entity', 'create_entity']);
    expect((await inject({ method: 'POST', url: `/v1/apps/${sourceId}/promote`, ...as(gina), payload: { spaceId } }, 409)).json().error).toBe('promotion_open');

    // Until the team app runs in Prod, the personal app works as before, and says where it is going.
    const source = await json({ method: 'GET', url: `/v1/apps/${sourceId}`, ...as(gina) }, 200);
    expect(source).toMatchObject({ movedTo: null, promotion: { appId: promotedId, name: 'Team trips', changeRequest: { number: 1, status: 'open' } } });
    await inject({ method: 'POST', url: sourceRecords(), ...as(frank), payload: claim('Still here') }, 201);
  });

  it('makes the personal app read-only once the team app runs in Prod, and keeps its data readable', async () => {
    const [cr] = await t.ctx.db.select().from(changeRequests).where(eq(changeRequests.appId, promotedId));
    await review(dave, cr!.id, 'approve');
    await merge(erin, cr!.id);
    const release = (await inject({ method: 'POST', url: `/v1/apps/${promotedId}/releases`, ...as(erin), payload: {} }, 201)).json();
    const requested = (await inject({ method: 'POST', url: `/v1/apps/${promotedId}/deployments`, ...as(erin), payload: { releaseId: release.id, env: 'prod' } }, 201)).json();
    await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/approve`, ...as(dave) }, 200);
    await inject({ method: 'POST', url: `/v1/deployments/${requested.id}/execute`, ...as(erin) }, 200);

    const source = await json({ method: 'GET', url: `/v1/apps/${sourceId}`, ...as(gina) }, 200);
    expect(source).toMatchObject({ movedTo: { appId: promotedId, name: 'Team trips' }, access: { edit: false, share: false } });
    const refused = await inject({ method: 'POST', url: sourceRecords(), ...as(frank), payload: claim('After the move') }, 403);
    expect(refused.json().details.reasons).toEqual([expect.objectContaining({ kind: 'denied_by_guardrail', guardrailId: 'gr.app.moved-read-only' })]);
    const kept = await json({ method: 'GET', url: sourceRecords(), ...as(frank) }, 200);
    expect(kept.records.map((r: Json) => r.values.title).sort()).toEqual(['Before the move', 'Still here']);
    const current = await json({ method: 'GET', url: `/v1/apps/${sourceId}/definition`, ...as(gina) }, 200);
    await inject({ method: 'PUT', url: `/v1/apps/${sourceId}/definition`, ...as(gina), payload: { definition: current.definition, baseRevision: current.revision } }, 403);
    await inject({ method: 'POST', url: `/v1/apps/${sourceId}/promote`, ...as(gina), payload: { spaceId } }, 403);
    const moved = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'app.moved'), eq(auditEvents.appId, sourceId)));
    expect(moved).toHaveLength(1);
  });
});
