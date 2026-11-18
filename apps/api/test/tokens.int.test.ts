import { sha256Hex } from '@platform/audit';
import { apiTokens, auditEvents, users } from '@platform/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Session; // bootstrap org owner
let bob: Session;
let carol: Session;
let teamSpaceId: string;

const as = (session: Session) => ({ cookies: session.cookies, headers: { origin: 'http://platform.test' } });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function mintPat(session: Session, scopes: string[], extra: Record<string, unknown> = {}) {
  const response = await t.app.inject({ method: 'POST', url: '/v1/me/tokens', ...as(session), payload: { name: 'test token', scopes, ...extra } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; token: string; displayPrefix: string; scopes: string[] };
}

beforeAll(async () => {
  t = await startTestApp();
  alice = await t.login('alice');
  bob = await t.login('bob');
  carol = await t.login('carol');
  const space = await t.app.inject({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Integrations', coOwnerUserIds: [bob.userId] } });
  expect(space.statusCode, space.body).toBe(201);
  teamSpaceId = space.json().id;
});

afterAll(async () => {
  await t?.close();
});

describe('personal access tokens', () => {
  it('are shown once and stored only as a hash', async () => {
    const created = await mintPat(alice, ['space.read', 'org.audit.read'], { expiresInDays: 7 });
    expect(created.token).toMatch(/^plt_pat_[A-Za-z0-9_-]{32}$/);
    expect(created.displayPrefix).toBe(created.token.slice(0, 16));
    expect(created.scopes).toEqual(['org.audit.read', 'space.read']);

    const [row] = await t.handle.db.select().from(apiTokens).where(eq(apiTokens.id, created.id));
    expect(row!.secretHash).toBe(sha256Hex(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);

    const listed = (await t.app.inject({ method: 'GET', url: '/v1/me/tokens', ...as(alice) })).json().tokens;
    expect(listed[0]).toMatchObject({ id: created.id, displayPrefix: created.displayPrefix });
    expect(listed[0]).not.toHaveProperty('token');
  });

  it('act as their owner, narrowed to their scopes', async () => {
    const { token } = await mintPat(alice, ['space.read']);
    const me = (await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(token) })).json();
    expect(me).toMatchObject({ type: 'user', id: alice.userId, credential: { kind: 'token', scopes: ['space.read'] } });

    expect((await t.app.inject({ method: 'GET', url: `/v1/spaces/${teamSpaceId}`, ...bearer(token) })).statusCode).toBe(200);
    const outside = await t.app.inject({ method: 'POST', url: '/v1/spaces', ...bearer(token), payload: { name: 'Nope', coOwnerUserIds: [bob.userId] } });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().details.reasons).toEqual([{ kind: 'outside_token_scope' }]);
  });

  it('never exceed what the owner holds', async () => {
    const { token } = await mintPat(bob, ['org.audit.read']);
    const response = await t.app.inject({ method: 'GET', url: '/v1/audit/events', ...bearer(token) });
    expect(response.statusCode).toBe(403);
    expect(response.json().details.reasons).toEqual([{ kind: 'no_matching_grant' }]);
  });

  it('cannot mint more tokens, sign out, or pass a fresh-MFA guardrail', async () => {
    const { token } = await mintPat(alice, ['token.personal.create', 'space.member.manage']);
    const mint = await t.app.inject({ method: 'POST', url: '/v1/me/tokens', ...bearer(token), payload: { name: 'child', scopes: ['space.read'] } });
    expect(mint.statusCode).toBe(403);
    expect(mint.json().error).toBe('session_required');

    const logout = await t.app.inject({ method: 'POST', url: '/auth/logout', ...bearer(token) });
    expect(logout.json().error).toBe('session_required');

    const grant = await t.app.inject({
      method: 'POST',
      url: '/v1/bindings',
      ...bearer(token),
      payload: { principal: { type: 'user', id: carol.userId }, roleId: 'space.viewer', scope: { type: 'space', id: teamSpaceId } },
    });
    expect(grant.statusCode).toBe(403);
    expect(grant.json().details.reasons).toEqual([expect.objectContaining({ kind: 'step_up_required' })]);
  });

  it('respect the maximum lifetime and reject vague or unknown scopes', async () => {
    for (const payload of [
      { name: 'too long', scopes: ['space.read'], expiresInDays: 365 },
      { name: 'everything', scopes: ['*'] },
      { name: 'made up', scopes: ['rocket.launch'] },
      { name: 'empty', scopes: [] },
    ]) {
      const response = await t.app.inject({ method: 'POST', url: '/v1/me/tokens', ...as(alice), payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('stop working once revoked, expired, or when the owner is deprovisioned, and each refusal is audited', async () => {
    const revoked = await mintPat(carol, ['space.read']);
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(revoked.token) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: `/v1/me/tokens/${revoked.id}/revoke`, ...as(carol) })).statusCode).toBe(200);
    const afterRevoke = await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(revoked.token) });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json().message).toContain('revoked');

    const expiring = await mintPat(carol, ['space.read'], { expiresInDays: 1 });
    t.clock.offsetMs = 2 * 86_400_000;
    try {
      expect((await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(expiring.token) })).json().message).toContain('expired');
    } finally {
      t.clock.offsetMs = 0;
    }

    const dora = await t.login('dora');
    const orphaned = await mintPat(dora, ['space.read']);
    await t.handle.db.update(users).set({ status: 'deprovisioned' }).where(eq(users.id, dora.userId));
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(orphaned.token) })).json().message).toContain('owner deprovisioned');

    const problems = (await t.handle.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.token.rejected'))).map((e) => e.reason?.['problem']);
    expect(problems).toEqual(expect.arrayContaining(['revoked', 'expired', 'owner_deprovisioned']));
  });

  it('turn away malformed and unknown tokens', async () => {
    for (const authorization of ['Bearer nope', 'Basic YWxpY2U6c2VjcmV0', `Bearer plt_pat_${'A'.repeat(32)}`]) {
      expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization } })).statusCode).toBe(401);
    }
  });

  it('record when they were last used, for access reviews', async () => {
    const { id, token } = await mintPat(alice, ['space.read']);
    await t.app.inject({ method: 'GET', url: '/v1/spaces', ...bearer(token) });
    const [row] = await t.handle.db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('service accounts', () => {
  let accountId: string;
  let accountToken: string;

  it('live in team spaces, and start with no access at all', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: `/v1/spaces/${teamSpaceId}/service-accounts`,
      ...as(bob),
      payload: { name: 'ci-deployer', description: 'Deploys from CI' },
    });
    expect(created.statusCode, created.body).toBe(201);
    accountId = created.json().id;

    const inPersonal = await t.app.inject({ method: 'POST', url: `/v1/spaces/${bob.personalSpaceId}/service-accounts`, ...as(bob), payload: { name: 'x' } });
    expect(inPersonal.statusCode).toBe(403);

    const issued = await t.app.inject({
      method: 'POST',
      url: `/v1/service-accounts/${accountId}/tokens`,
      ...as(bob),
      payload: { name: 'github-actions', scopes: ['space.read', 'space.create'] },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    accountToken = issued.json().token;
    expect(accountToken).toMatch(/^plt_sat_/);

    const me = (await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(accountToken) })).json();
    expect(me).toMatchObject({ type: 'service_account', id: accountId, displayName: 'ci-deployer', groups: [], personalSpaceId: null });
    const denied = await t.app.inject({ method: 'GET', url: `/v1/spaces/${teamSpaceId}`, ...bearer(accountToken) });
    expect(denied.json().details.reasons).toEqual([{ kind: 'no_matching_grant' }]);
  });

  it('gain permissions only through bindings', async () => {
    const granted = await t.app.inject({
      method: 'POST',
      url: '/v1/bindings',
      ...as(bob),
      payload: { principal: { type: 'service_account', id: accountId }, roleId: 'space.viewer', scope: { type: 'space', id: teamSpaceId } },
    });
    expect(granted.statusCode, granted.body).toBe(201);
    expect(granted.json()).toMatchObject({ principal: { type: 'service_account', name: 'ci-deployer' }, grantedBy: { type: 'user', id: bob.userId } });

    expect((await t.app.inject({ method: 'GET', url: `/v1/spaces/${teamSpaceId}`, ...bearer(accountToken) })).statusCode).toBe(200);
    const listed = (await t.app.inject({ method: 'GET', url: '/v1/spaces', ...bearer(accountToken) })).json().spaces;
    expect(listed.map((s: { id: string }) => s.id)).toEqual([teamSpaceId]);
  });

  it('cannot create team spaces, because only people can own them', async () => {
    const granted = await t.app.inject({
      method: 'POST',
      url: '/v1/bindings',
      ...as(alice),
      payload: {
        principal: { type: 'service_account', id: accountId },
        roleId: 'org.space_creator',
        scope: { type: 'org', id: t.ctx.org.id },
        justification: 'Testing that owners must be people',
      },
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const attempt = await t.app.inject({
      method: 'POST',
      url: '/v1/spaces',
      ...bearer(accountToken),
      payload: { name: 'Robots', coOwnerUserIds: [alice.userId] },
    });
    expect(attempt.statusCode).toBe(403);
    expect(attempt.json().error).toBe('person_required');
  });

  it('are disabled together with all of their tokens', async () => {
    const disabled = await t.app.inject({
      method: 'POST',
      url: `/v1/service-accounts/${accountId}/disable`,
      ...as(bob),
      payload: { reason: 'Rotating CI credentials' },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().status).toBe('disabled');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(accountToken) })).statusCode).toBe(401);

    const reissue = await t.app.inject({
      method: 'POST',
      url: `/v1/service-accounts/${accountId}/tokens`,
      ...as(bob),
      payload: { name: 'again', scopes: ['space.read'] },
    });
    expect(reissue.json().error).toBe('service_account_disabled');
    const tokens = (await t.app.inject({ method: 'GET', url: `/v1/service-accounts/${accountId}/tokens`, ...as(bob) })).json().tokens;
    expect(tokens.every((token: { revokedAt: string | null }) => token.revokedAt !== null)).toBe(true);
  });
});

describe('organization oversight', () => {
  it('lets security see every token and revoke anyone’s', async () => {
    const { id, token } = await mintPat(bob, ['space.read']);
    const all = (await t.app.inject({ method: 'GET', url: '/v1/tokens', ...as(alice) })).json().tokens;
    expect(all.map((x: { id: string }) => x.id)).toContain(id);

    const revoked = await t.app.inject({ method: 'POST', url: `/v1/tokens/${id}/revoke`, ...as(alice), payload: { justification: 'Leaked in a build log' } });
    expect(revoked.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', ...bearer(token) })).statusCode).toBe(401);

    expect((await t.app.inject({ method: 'GET', url: '/v1/tokens', ...as(bob) })).statusCode).toBe(403);
  });

  it('audits the whole token lifecycle, and names the token behind each action', async () => {
    const { id, token } = await mintPat(alice, ['space.freeze']);
    const frozen = await t.app.inject({ method: 'POST', url: `/v1/spaces/${teamSpaceId}/freeze`, ...bearer(token), payload: { reason: 'Done testing' } });
    expect(frozen.statusCode, frozen.body).toBe(200);

    const [freeze] = await t.handle.db.select().from(auditEvents).where(eq(auditEvents.action, 'space.freeze'));
    expect(freeze!.actor).toMatchObject({ type: 'user', id: alice.userId, tokenId: id });

    const actions = new Set(
      (
        await t.handle.db
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(sql`${auditEvents.action} like any (array['token.%', 'service_account.%'])`)
      ).map((e) => e.action),
    );
    expect([...actions].sort()).toEqual(['service_account.create', 'service_account.disable', 'token.create', 'token.revoke']);
  });
});
