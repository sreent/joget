import { EXPENSE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Steps that stay with a person on every channel (design §5.7): approving a proposal or a change
 * request, deploying to Prod, and deleting data. An agent, a script or a pipeline prepares them;
 * only the person, signed in, does them. Proposals are in apps.int.test.ts and agents.int.test.ts.
 */

let t: TestApp;
let alice: Session; // org owner, and an owner of the Finance space
let carol: Session; // builder
let dave: Session; // reviewer
let erin: Session; // release manager
let spaceId: string;
let teamId: string;
let copyId: string;
/** The token of a pipeline in CI: a service account with the release manager's role. */
let pipeline: string;

type Json = Record<string, any>;
const as = (session: Session) => ({ cookies: session.cookies });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function inject(options: InjectOptions, expected: number): Promise<Json> {
  const response = await t.app.inject(options);
  expect(response.statusCode, response.body).toBe(expected);
  return response.body ? response.json() : {};
}

/** A script's token: the person's own, with some of their permissions. */
const scriptOf = async (session: Session, scopes: string[]): Promise<string> =>
  (await inject({ method: 'POST', url: '/v1/me/tokens', ...as(session), payload: { name: 'script', scopes } }, 201)).token;

/** The refusal of a step that stays with a person. */
const keptForPerson = (body: Json, step: string) => expect(body).toMatchObject({ error: 'session_required', details: { step } });

/** A change to the working copy, submitted as a change request. */
async function propose(title: string, edit: (definition: Json) => void): Promise<Json> {
  const current = await inject({ method: 'GET', url: `/v1/apps/${copyId}/definition`, ...as(carol) }, 200);
  edit(current.definition);
  await inject(
    { method: 'PUT', url: `/v1/apps/${copyId}/definition`, ...as(carol), payload: { definition: current.definition, baseRevision: current.revision } },
    200,
  );
  return inject({ method: 'POST', url: `/v1/apps/${copyId}/submit`, ...as(carol), payload: { title } }, 201);
}

/** Take a change to Prod: the pipeline releases it and asks; a reviewer approves; a release manager makes it live. */
async function toProd(): Promise<void> {
  const release = await inject({ method: 'POST', url: `/v1/apps/${teamId}/releases`, ...bearer(pipeline), payload: {} }, 201);
  expect(
    await inject(
      { method: 'POST', url: `/v1/apps/${teamId}/deployments`, ...bearer(pipeline), payload: { releaseId: release.id, env: 'staging', execute: true } },
      201,
    ),
  ).toMatchObject({
    status: 'succeeded',
  });
  const prod = await inject(
    { method: 'POST', url: `/v1/apps/${teamId}/deployments`, ...bearer(pipeline), payload: { releaseId: release.id, env: 'prod', execute: true } },
    201,
  );
  expect(prod).toMatchObject({ status: 'awaiting_approval' });
  await inject({ method: 'POST', url: `/v1/deployments/${prod.id}/approve`, ...as(dave) }, 200);
  await inject({ method: 'POST', url: `/v1/deployments/${prod.id}/execute`, ...as(erin) }, 200);
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, carol, dave, erin] = await Promise.all([t.login('alice'), t.login('carol'), t.login('dave'), t.login('erin')]);
  const olivia = await t.login('olivia');
  spaceId = (await inject({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Finance', coOwnerUserIds: [olivia.userId] } }, 201)).id;
  const grant = (principal: { type: 'user' | 'service_account'; id: string }, roleId: string) =>
    inject({ method: 'POST', url: '/v1/bindings', ...as(alice), payload: { principal, roleId, scope: { type: 'space', id: spaceId } } }, 201);
  await grant({ type: 'user', id: carol.userId }, 'space.builder');
  await grant({ type: 'user', id: dave.userId }, 'space.reviewer');
  await grant({ type: 'user', id: erin.userId }, 'space.release_manager');
  const account = await inject({ method: 'POST', url: `/v1/spaces/${spaceId}/service-accounts`, ...as(alice), payload: { name: 'ci-deployer' } }, 201);
  await grant({ type: 'service_account', id: account.id }, 'space.release_manager');
  const scopes = ['app.read', 'release.create', 'deploy.read', 'deploy.request', 'deploy.execute', 'deploy.rollback'];
  pipeline = (await inject({ method: 'POST', url: `/v1/service-accounts/${account.id}/tokens`, ...as(alice), payload: { name: 'pipeline', scopes } }, 201))
    .token;

  teamId = (await inject({ method: 'POST', url: `/v1/spaces/${spaceId}/apps`, ...as(carol), payload: { name: 'Expenses' } }, 201)).app.id;
  copyId = (await inject({ method: 'POST', url: `/v1/apps/${teamId}/working-copy`, ...as(carol) }, 200)).app.id;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('steps that stay with a person', () => {
  it('approving a change request: a script reviews and comments, and only the reviewer, signed in, approves', async () => {
    const cr = await propose('Expense claims', (definition) => Object.assign(definition, structuredClone(EXPENSE_APP)));
    const script = await scriptOf(dave, ['change.review', 'change.approve']);
    await inject(
      { method: 'POST', url: `/v1/change-requests/${cr.id}/reviews`, ...bearer(script), payload: { verdict: 'comment', comment: 'The checks pass.' } },
      200,
    );
    keptForPerson(
      await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/reviews`, ...bearer(script), payload: { verdict: 'approve' } }, 403),
      'change.approve',
    );
    expect((await inject({ method: 'GET', url: `/v1/change-requests/${cr.id}`, ...as(dave) }, 200)).approvals.approvedBy).toEqual([]);

    await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/reviews`, ...as(dave), payload: { verdict: 'approve' } }, 200);
    await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/merge`, ...as(erin) }, 200);
  });

  it('deploying to Prod: a pipeline releases, deploys to Staging and asks for Prod; people approve it and make it live', async () => {
    const release = await inject({ method: 'POST', url: `/v1/apps/${teamId}/releases`, ...bearer(pipeline), payload: {} }, 201);
    expect(
      await inject(
        { method: 'POST', url: `/v1/apps/${teamId}/deployments`, ...bearer(pipeline), payload: { releaseId: release.id, env: 'staging', execute: true } },
        201,
      ),
    ).toMatchObject({
      environment: 'staging',
      status: 'succeeded',
    });
    const prod = await inject(
      { method: 'POST', url: `/v1/apps/${teamId}/deployments`, ...bearer(pipeline), payload: { releaseId: release.id, env: 'prod', execute: true } },
      201,
    );
    expect(prod).toMatchObject({ environment: 'prod', status: 'awaiting_approval' });

    // Neither the pipeline nor the reviewer's own token approves it.
    await inject({ method: 'POST', url: `/v1/deployments/${prod.id}/approve`, ...bearer(pipeline) }, 403);
    await inject({ method: 'POST', url: `/v1/deployments/${prod.id}/approve`, ...bearer(await scriptOf(dave, ['deploy.read', 'deploy.approve'])) }, 403);
    await inject({ method: 'POST', url: `/v1/deployments/${prod.id}/approve`, ...as(dave) }, 200);

    // Approved, it still goes live only by a person's hand.
    keptForPerson(await inject({ method: 'POST', url: `/v1/deployments/${prod.id}/execute`, ...bearer(pipeline) }, 403), 'deploy.prod');
    expect(await inject({ method: 'POST', url: `/v1/deployments/${prod.id}/execute`, ...as(erin) }, 200)).toMatchObject({
      status: 'succeeded',
      executedBy: { id: erin.userId },
    });
  });

  it('rolling back: the pipeline rolls Staging back, and only a person rolls Prod back', async () => {
    const cr = await propose('Record the vendor', (definition) =>
      definition.entities.expense_claim.fields.push({ name: 'vendor', label: 'Vendor', type: 'text' }),
    );
    await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/reviews`, ...as(dave), payload: { verdict: 'approve' } }, 200);
    await inject({ method: 'POST', url: `/v1/change-requests/${cr.id}/merge`, ...as(erin) }, 200);
    await toProd();

    expect(await inject({ method: 'POST', url: `/v1/apps/${teamId}/environments/staging/rollback`, ...bearer(pipeline) }, 200)).toMatchObject({
      kind: 'rollback',
      status: 'succeeded',
    });
    keptForPerson(await inject({ method: 'POST', url: `/v1/apps/${teamId}/environments/prod/rollback`, ...bearer(pipeline) }, 403), 'rollback.prod');
    expect(await inject({ method: 'POST', url: `/v1/apps/${teamId}/environments/prod/rollback`, ...as(erin) }, 200)).toMatchObject({
      kind: 'rollback',
      status: 'succeeded',
    });
  });

  it('deleting data: a script plans a change that deletes data, and the person confirms it; records and apps go only by their hand', async () => {
    const appId = (
      await inject(
        { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name: 'Trips', template: 'expenses' } },
        201,
      )
    ).app.id;
    const records = `/v1/apps/${appId}/entities/expense_claim/records`;
    const before = await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200);
    before.definition.entities.expense_claim.fields.push({ name: 'notes', label: 'Notes', type: 'text' });
    await inject(
      { method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), payload: { definition: before.definition, baseRevision: before.revision } },
      200,
    );
    const lines = [{ date: '2026-11-02', merchant: 'Cafe', category: 'meals', amount: 12 }];
    const record = await inject(
      { method: 'POST', url: records, ...as(alice), payload: { values: { title: 'Dinner', notes: 'With the auditors', lines } } },
      201,
    );
    const script = await scriptOf(alice, ['app.read', 'app.edit', 'app.delete', 'record.read', 'record.delete']);

    // The script sees the plan of a change that deletes the notes, and can't confirm it.
    const current = await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...bearer(script) }, 200);
    current.definition.entities.expense_claim.fields = current.definition.entities.expense_claim.fields.filter((field: Json) => field.name !== 'notes');
    const change = { definition: current.definition, baseRevision: current.revision };
    const refused = await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition?confirmDestructive=true`, ...bearer(script), payload: change }, 403);
    keptForPerson(refused, 'data.delete');
    expect(refused.details.plan).toMatchObject({ destructive: true, steps: [expect.objectContaining({ description: expect.stringContaining('notes') })] });
    await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition?confirmDestructive=true`, ...as(alice), payload: change }, 200);

    keptForPerson(await inject({ method: 'DELETE', url: `${records}/${record.id}`, ...bearer(script) }, 403), 'data.delete');
    await inject({ method: 'GET', url: `${records}/${record.id}`, ...bearer(script) }, 200);
    await inject({ method: 'DELETE', url: `${records}/${record.id}`, ...as(alice) }, 204);

    expect((await inject({ method: 'DELETE', url: `/v1/apps/${appId}`, ...bearer(script), payload: { confirm: 'Trips' } }, 403)).error).toBe(
      'session_required',
    );
    await inject({ method: 'DELETE', url: `/v1/apps/${appId}`, ...as(alice), payload: { confirm: 'Trips' } }, 204);
  });
});
