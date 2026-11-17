import { auditEvents } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Templates, export and import: an app starts from a template or from a file, in a personal space
 * at once, or in a team space as a change request. A file carries the definition, never data.
 */

let t: TestApp;
let alice: Session; // builds apps, and owns a team space
let bob: Session; // a colleague in one of Alice's apps
let carol: Session; // builds in the team space
let leaveId: string;
let bundle: Record<string, any>;

const as = (session: Session) => ({ cookies: session.cookies });
async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const json = async (options: InjectOptions, expected: number) => (await inject(options, expected)).json();
const importInto = (session: Session, spaceId: string, payload: Record<string, unknown>, expected = 201) =>
  inject({ method: 'POST', url: `/v1/spaces/${spaceId}/apps/import`, ...as(session), payload }, expected);

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
});

afterAll(async () => {
  await t?.close();
});

describe('templates', () => {
  it('lists what a builder can start from', async () => {
    const { templates } = await json({ method: 'GET', url: '/v1/templates', ...as(bob) }, 200);
    expect(templates.map((template: { id: string; entities: string[] }) => [template.id, template.entities])).toEqual([
      ['expenses', ['Expense claims']],
      ['leave', ['Leave requests']],
      ['purchasing', ['Purchase requests']],
    ]);
  });

  it('starts an app in a personal space from a template, which works as it says', async () => {
    const started = (await importInto(alice, alice.personalSpaceId, { template: 'leave' })).json();
    leaveId = started.app.id;
    expect(started).toMatchObject({ app: { kind: 'personal', name: 'Leave requests' }, changeRequest: null, asExported: null });
    expect(started.plan.steps.map((step: { kind: string }) => step.kind)).toEqual(['create_entity']);

    // Bob decides on Alice's leave: his decision records the day it was made.
    await inject({ method: 'POST', url: `/v1/apps/${leaveId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'manager' } }, 201);
    const asked = await json(
      {
        method: 'POST',
        url: `/v1/apps/${leaveId}/actions/request_leave/run`,
        ...as(alice),
        payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: bob.userId } },
      },
      201,
    );
    const decided = await json({ method: 'POST', url: `/v1/apps/${leaveId}/actions/approve_leave/run`, ...as(bob), payload: { recordId: asked.record.id } }, 200);
    expect(decided.record.values).toMatchObject({ status: 'approved', decided_on: new Date().toISOString().slice(0, 10) });
  });
});

describe('export and import', () => {
  it('exports the definition, never the data, for whoever builds the app', async () => {
    const response = await inject({ method: 'GET', url: `/v1/apps/${leaveId}/export`, ...as(alice) }, 200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="leave_requests.ambit.json"');
    bundle = response.json();
    expect(bundle).toMatchObject({ format: 'ambit.app/v1', app: { name: 'Leave requests', handle: 'leave_requests' }, revision: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Object.keys(bundle['definition'].entities)).toEqual(['leave_request']);
    expect(JSON.stringify(bundle)).not.toContain('2026-12-21');
    // Bob uses the app; he doesn't build it.
    await inject({ method: 'GET', url: `/v1/apps/${leaveId}/export`, ...as(bob) }, 403);
    const exported = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'app.export'), eq(auditEvents.appId, leaveId)));
    expect(exported).toHaveLength(1);
  });

  it('imports a file as it was exported, edited, or as a bare definition', async () => {
    const copy = (await importInto(alice, alice.personalSpaceId, { bundle, name: 'Leave (copy)' })).json();
    expect(copy).toMatchObject({ app: { name: 'Leave (copy)', kind: 'personal' }, asExported: true });
    const imported = await json({ method: 'GET', url: `/v1/apps/${copy.app.id}/definition`, ...as(alice) }, 200);
    expect(imported.definition).toEqual(bundle['definition']);
    // Nobody's records came with it.
    expect((await json({ method: 'GET', url: `/v1/apps/${copy.app.id}/entities/leave_request/records`, ...as(alice) }, 200)).records).toEqual([]);

    const edited = structuredClone(bundle);
    edited['definition'].entities.leave_request.label = 'Holiday request';
    expect((await importInto(alice, alice.personalSpaceId, { bundle: edited, name: 'Holidays' })).json().asExported).toBe(false);
    const bare = (await importInto(alice, alice.personalSpaceId, { bundle: bundle['definition'], name: 'Bare' })).json();
    expect(bare).toMatchObject({ app: { name: 'Bare' }, asExported: null });

    expect((await importInto(alice, alice.personalSpaceId, { bundle: { format: 'joget.jwa/1' } }, 422)).json().error).toBe('unknown_format');
    const broken = structuredClone(bundle);
    broken['definition'].roles.manager.actions = ['nonexistent'];
    expect((await importInto(alice, alice.personalSpaceId, { bundle: broken, name: 'Broken' }, 422)).json().error).toBe('invalid_definition');
    await importInto(alice, bob.personalSpaceId, { template: 'leave' }, 403);
  });

  it('imports into a team space as a change request, for the space to review', async () => {
    const spaceId = (await json({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Operations', coOwnerUserIds: [bob.userId] } }, 201)).id;
    await importInto(carol, spaceId, { template: 'purchasing' }, 403);
    await inject(
      { method: 'POST', url: '/v1/bindings', ...as(alice), payload: { principal: { type: 'user', id: carol.userId }, roleId: 'space.builder', scope: { type: 'space', id: spaceId } } },
      201,
    );
    const started = (await importInto(carol, spaceId, { template: 'purchasing' })).json();
    expect(started).toMatchObject({ app: { kind: 'team', name: 'Purchase requests', environments: [] }, plan: null, changeRequest: { number: 1 } });
    const cr = await json({ method: 'GET', url: `/v1/change-requests/${started.changeRequest.id}`, ...as(carol) }, 200);
    expect(cr).toMatchObject({ title: 'Start Purchase requests from a template', status: 'open' });
    expect(cr.checks.capabilities.map((c: { text: string }) => c.text)).toContain(
      'New tool approve_purchase: updates Purchase request, and asks the person to confirm a preview. It starts the a7c skill procurement/raise-purchase-order',
    );
  });
});
