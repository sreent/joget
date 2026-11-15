import { auditEvents, users } from '@platform/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealPending } from '../src/audit/sealer.js';
import { recordAudit, SYSTEM_ACTOR } from '../src/audit/writer.js';
import { identity, startTestApp, type Session, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Session; // bootstrap org owner
let bob: Session;
let carol: Session; // in the IdP group "builders"
let dave: Session; // will become an org admin
let financeSpaceId: string;

const as = (session: Session) => ({ cookies: session.cookies, headers: { origin: 'http://platform.test' } });
const grant = (session: Session, body: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/v1/bindings', ...as(session), payload: body });

beforeAll(async () => {
  t = await startTestApp();
  t.idp.identities.set('carol', identity('carol', { groups: ['builders'] }));
  alice = await t.login('alice');
  bob = await t.login('bob');
  carol = await t.login('carol');
  dave = await t.login('dave');
});

afterAll(async () => {
  await t?.close();
});

describe('every route is protected', () => {
  it('declares an access rule on each route, and only health checks and sign-in are public', () => {
    const publicRoutes = t.server.routes.filter((r) => r.kind === 'public').map((r) => `${r.method} ${r.url}`);
    expect(publicRoutes.sort()).toEqual(['GET /auth/callback', 'GET /auth/login', 'GET /healthz', 'GET /readyz']);
  });

  it('turns away anonymous callers and cross-origin writes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/spaces' })).statusCode).toBe(401);
    const crossSite = await t.app.inject({
      method: 'POST',
      url: '/v1/spaces',
      cookies: alice.cookies,
      headers: { origin: 'https://evil.example' },
      payload: { name: 'x' },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error).toBe('origin_mismatch');
  });

  it('answers health and readiness probes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ status: 'ready' });
  });
});

describe('sign-in provisions people just in time', () => {
  it('gives every user a personal space, and makes the bootstrap owner an org owner', async () => {
    const spaces = (await t.app.inject({ method: 'GET', url: '/v1/spaces', ...as(bob) })).json().spaces;
    expect(spaces).toEqual([expect.objectContaining({ id: bob.personalSpaceId, kind: 'personal', ownerUserId: bob.userId })]);

    const orgBindings = await t.app.inject({ method: 'GET', url: `/v1/bindings?scopeType=org&scopeId=${t.ctx.org.id}`, ...as(alice) });
    expect(orgBindings.statusCode).toBe(200);
    expect(orgBindings.json().bindings).toEqual([
      expect.objectContaining({
        roleId: 'org.owner',
        principal: expect.objectContaining({ id: alice.userId }),
        grantedBy: { type: 'system', id: null },
      }),
    ]);
  });

  it('syncs IdP groups at every sign-in', async () => {
    t.idp.identities.set('erin', identity('erin', { groups: ['finance', 'engineering'] }));
    let erin = await t.login('erin');
    const groupsOf = async (s: Session) =>
      ((await t.app.inject({ method: 'GET', url: '/v1/me', ...as(s) })).json().groups as Array<{ name: string }>).map((g) => g.name).sort();
    expect(await groupsOf(erin)).toEqual(['engineering', 'finance']);

    t.idp.identities.set('erin', identity('erin', { groups: ['finance'] }));
    erin = await t.login('erin');
    expect(await groupsOf(erin)).toEqual(['finance']);
  });

  it('answers 503 while the identity provider is unreachable, and recovers when it is back', async () => {
    t.idp.reachable = false;
    try {
      const login = await t.app.inject({ method: 'GET', url: '/auth/login' });
      expect(login.statusCode).toBe(503);
      expect(login.json()).toMatchObject({ error: 'idp_unavailable' });
    } finally {
      t.idp.reachable = true;
    }
    expect((await t.app.inject({ method: 'GET', url: '/auth/login' })).statusCode).toBe(302);
  });

  it('refuses deprovisioned users', async () => {
    const frank = await t.login('frank');
    await t.handle.db.update(users).set({ status: 'deprovisioned' }).where(eq(users.id, frank.userId));
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', ...as(frank) })).statusCode).toBe(401);
    await expect(t.login('frank')).rejects.toThrow();
  });
});

describe('roles, permission sets and bindings', () => {
  it('denies by default, explains why, and audits the denial', async () => {
    const response = await t.app.inject({ method: 'POST', url: '/v1/spaces', ...as(bob), payload: { name: 'Shadow IT', coOwnerUserIds: [alice.userId] } });
    expect(response.statusCode).toBe(403);
    expect(response.json().details).toEqual({ action: 'space.create', reasons: [{ kind: 'no_matching_grant' }] });

    const [denied] = await t.handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'access.denied'), sql`${auditEvents.actor}->>'id' = ${bob.userId}`));
    expect(denied).toMatchObject({ outcome: 'denied', reason: { action: 'space.create' } });
  });

  it('requires a justification for org-level grants', async () => {
    const builders = await groupId('builders');
    const response = await grant(alice, { principal: { type: 'group', id: builders }, roleId: 'org.space_creator', scope: { type: 'org', id: t.ctx.org.id } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('justification_required');
  });

  it('lets an owner grant a role to an IdP group, after which its members can act', async () => {
    const builders = await groupId('builders');
    const response = await grant(alice, {
      principal: { type: 'group', id: builders },
      roleId: 'org.space_creator',
      scope: { type: 'org', id: t.ctx.org.id },
      justification: 'Builders may create team spaces',
    });
    expect(response.statusCode, response.body).toBe(201);

    const created = await t.app.inject({ method: 'POST', url: '/v1/spaces', ...as(carol), payload: { name: 'Finance', coOwnerUserIds: [bob.userId] } });
    expect(created.statusCode, created.body).toBe(201);
    financeSpaceId = created.json().id;

    const members = (await t.app.inject({ method: 'GET', url: `/v1/spaces/${financeSpaceId}/members`, ...as(bob) })).json().members;
    expect(members.map((m: { principal: { id: string }; roleId: string }) => [m.principal.id, m.roleId]).sort()).toEqual(
      [
        [bob.userId, 'space.owner'],
        [carol.userId, 'space.owner'],
      ].sort(),
    );
  });

  it('requires at least two owners for a team space, and keeps them', async () => {
    const lonely = await t.app.inject({ method: 'POST', url: '/v1/spaces', ...as(carol), payload: { name: 'Solo' } });
    expect(lonely.json().error).toBe('not_enough_owners');

    const members = (await t.app.inject({ method: 'GET', url: `/v1/spaces/${financeSpaceId}/members`, ...as(carol) })).json().members;
    const bobsOwnership = members.find((m: { principal: { id: string } }) => m.principal.id === bob.userId);
    const revoke = await t.app.inject({ method: 'POST', url: `/v1/bindings/${bobsOwnership.id}/revoke`, ...as(carol), payload: {} });
    expect(revoke.statusCode).toBe(409);
    expect(revoke.json().error).toBe('minimum_owners');
  });

  it('stops privilege escalation: you can only grant what you hold', async () => {
    const madeAdmin = await grant(alice, {
      principal: { type: 'user', id: dave.userId },
      roleId: 'org.admin',
      scope: { type: 'org', id: t.ctx.org.id },
      justification: 'Dave runs platform administration',
      expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    });
    expect(madeAdmin.statusCode, madeAdmin.body).toBe(201);

    const escalation = await grant(dave, {
      principal: { type: 'user', id: bob.userId },
      roleId: 'org.owner',
      scope: { type: 'org', id: t.ctx.org.id },
      justification: 'Promote Bob',
    });
    expect(escalation.statusCode).toBe(403);
    expect(escalation.json().error).toBe('privilege_escalation');
    expect(escalation.json().details.missing).toEqual(expect.arrayContaining(['org.guardrail.manage', 'org.audit.read']));

    const allowed = await grant(dave, {
      principal: { type: 'user', id: bob.userId },
      roleId: 'org.space_creator',
      scope: { type: 'org', id: t.ctx.org.id },
      justification: 'Bob leads the finance apps',
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it('enforces separation of duties', async () => {
    const response = await grant(alice, {
      principal: { type: 'user', id: dave.userId },
      roleId: 'org.auditor',
      scope: { type: 'org', id: t.ctx.org.id },
      justification: 'Also audit',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'sod_conflict',
      details: { conflicts: [expect.objectContaining({ ruleId: 'sod.auditor-independence', conflictingRoleId: 'org.admin' })] },
    });
  });

  it('demands fresh MFA for access administration', async () => {
    t.clock.offsetMs = 20 * 60_000;
    try {
      const response = await grant(alice, {
        principal: { type: 'user', id: bob.userId },
        roleId: 'space.viewer',
        scope: { type: 'space', id: financeSpaceId },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().details.reasons).toEqual([expect.objectContaining({ kind: 'step_up_required', maxMfaAgeSeconds: 900 })]);
    } finally {
      t.clock.offsetMs = 0;
    }
  });

  it('explains why someone can or cannot do something', async () => {
    const explain = (userId: string) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/access/explain',
        ...as(alice),
        payload: { userId, action: 'space.create', resource: { type: 'org', id: t.ctx.org.id } },
      });
    const forErin = (await explain((await userIdOf('erin'))!)).json();
    expect(forErin.decision).toEqual({ allowed: false, action: 'space.create', reasons: [{ kind: 'no_matching_grant' }] });
    const forCarol = (await explain(carol.userId)).json();
    expect(forCarol.decision.allowed).toBe(true);
    expect(forCarol.decision.reasons[0]).toMatchObject({ kind: 'granted', roleId: 'org.space_creator', permissionSetId: 'ps.org.space_creation' });
  });
});

describe('personal spaces', () => {
  it('stay private from org admins, who can still freeze them', async () => {
    const peek = await t.app.inject({ method: 'GET', url: `/v1/spaces/${bob.personalSpaceId}`, ...as(alice) });
    expect(peek.statusCode).toBe(403);
    expect(peek.json().details.reasons[0].kind).toBe('personal_space_boundary');

    const aliceSees = (await t.app.inject({ method: 'GET', url: '/v1/spaces', ...as(alice) })).json().spaces.map((s: { id: string }) => s.id);
    expect(aliceSees).toContain(financeSpaceId);
    expect(aliceSees).not.toContain(bob.personalSpaceId);

    const freeze = await t.app.inject({ method: 'POST', url: `/v1/spaces/${bob.personalSpaceId}/freeze`, ...as(alice), payload: { reason: 'Offboarding' } });
    expect(freeze.statusCode, freeze.body).toBe(200);
    expect(freeze.json().status).toBe('frozen');
  });

  it('cannot be shared through bindings', async () => {
    const response = await grant(bob, { principal: { type: 'user', id: carol.userId }, roleId: 'space.viewer', scope: { type: 'space', id: carol.personalSpaceId } });
    expect(response.statusCode).toBe(403);
  });
});

describe('guardrails', () => {
  it('make frozen spaces read-only, for everyone', async () => {
    const freeze = await t.app.inject({ method: 'POST', url: `/v1/spaces/${financeSpaceId}/freeze`, ...as(alice), payload: { reason: 'Quarter-end review' } });
    expect(freeze.statusCode).toBe(200);
    const response = await grant(carol, { principal: { type: 'user', id: dave.userId }, roleId: 'space.builder', scope: { type: 'space', id: financeSpaceId } });
    expect(response.statusCode).toBe(403);
    expect(response.json().details.reasons).toEqual([
      expect.objectContaining({ kind: 'denied_by_guardrail', guardrailId: 'gr.space.frozen-read-only' }),
    ]);
  });
});

describe('the audit log', () => {
  it('records sign-ins, provisioning, grants, denials and freezes', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/v1/audit/events?limit=500', ...as(alice) });
    expect(response.statusCode).toBe(200);
    const actions = new Set(response.json().events.map((e: { action: string }) => e.action));
    for (const action of ['auth.login', 'user.provision', 'directory.membership.sync', 'space.create', 'binding.create', 'access.denied', 'space.freeze', 'access.explain']) {
      expect(actions).toContain(action);
    }
    const rejected = await t.app.inject({ method: 'GET', url: '/v1/audit/events', ...as(bob) });
    expect(rejected.statusCode).toBe(403);
  });

  it('commits audit events together with the change, or not at all', async () => {
    await expect(
      t.ctx.db.transaction(async (tx) => {
        await recordAudit(tx, { orgId: t.ctx.org.id, actor: SYSTEM_ACTOR, context: {}, now: new Date() }, { action: 'test.rolled_back' });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await t.handle.db.$count(auditEvents, eq(auditEvents.action, 'test.rolled_back'))).toBe(0);
  });

  it('seals the log and verifies it end to end', async () => {
    expect(await sealPending(t.ctx.db, t.ctx.auditSigner, { safetyWindowSeconds: 0 })).toBeGreaterThan(0);
    const report = (await t.app.inject({ method: 'GET', url: '/v1/audit/verify', ...as(alice) })).json();
    expect(report).toMatchObject({ ok: true, problems: [], unsealedEvents: 0 });
    expect(report.eventsChecked).toBeGreaterThan(20);
  });

  it('detects tampering, even by a database superuser who bypasses the append-only trigger', async () => {
    await t.handle.db.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
    await t.handle.db.execute(sql`update audit_events set outcome = 'success' where action = 'access.denied'`);
    await t.handle.db.execute(sql`alter table audit_events enable trigger audit_events_append_only`);

    const report = (await t.app.inject({ method: 'GET', url: '/v1/audit/verify', ...as(alice) })).json();
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'event_digest_mismatch' })]));
  });
});

async function groupId(name: string): Promise<string> {
  const me = (await t.app.inject({ method: 'GET', url: '/v1/me', ...as(carol) })).json();
  const group = me.groups.find((g: { name: string }) => g.name === name);
  if (!group) throw new Error(`carol is not in ${name}`);
  return group.id;
}

async function userIdOf(subject: string): Promise<string | undefined> {
  const [row] = await t.handle.db.select({ id: users.id }).from(users).where(eq(users.subject, subject));
  return row?.id;
}
