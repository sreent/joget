import { EXPENSE_APP } from '@platform/app-model';
import { apiTokens, auditEvents, proposals } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Agents act for one named person (design §6.4): a Security admin approves an agent and caps
 * what it may do; the agent exchanges a person's IdP token for a short-lived Ambit token; and
 * everything it does is the person's errands, attributed to both, confirmed only by the person.
 */

let t: TestApp;
let alice: Session; // org owner and Security admin, builds the app
let bob: Session; // uses it through the agent
let carol: Session;
let appId: string;
let agentId: string;
let agentToken: string; // the agent's own service-account token

const as = (session: Session) => ({ cookies: session.cookies });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

const exchange = (token: string, fields: Record<string, string>) =>
  inject({
    method: 'POST',
    url: '/v1/oauth/token',
    ...bearer(token),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token_type: ID_TOKEN, ...fields }).toString(),
  });

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await inject({ method: 'POST', url: '/mcp', ...bearer(token), payload: { jsonrpc: '2.0', id: 1, method, params } }, 200);
  return response.json() as { result: any };
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
  const created = await inject(
    { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: EXPENSE_APP } },
    201,
  );
  appId = created.json().app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
  const team = await inject({ method: 'POST', url: '/v1/spaces', ...as(alice), payload: { name: 'Agents', coOwnerUserIds: [carol.userId] } }, 201);
  const account = await inject(
    { method: 'POST', url: `/v1/spaces/${team.json().id}/service-accounts`, ...as(alice), payload: { name: 'agentos', description: 'The company assistant' } },
    201,
  );
  agentId = account.json().id;
  const token = await inject(
    { method: 'POST', url: `/v1/service-accounts/${agentId}/tokens`, ...as(alice), payload: { name: 'agentos', scopes: ['space.read'], expiresInDays: 30 } },
    201,
  );
  agentToken = token.json().token;
});

afterAll(async () => {
  await t?.close();
});

describe('approving an agent', () => {
  it('refuses to exchange tokens for a service account nobody approved', async () => {
    const refused = await exchange(agentToken, { subject_token: 'idtoken:bob' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'unauthorized_client' });
  });

  it('lets only a Security admin approve it, with capped scopes', async () => {
    const payload = { scopes: ['app.run', 'action.run', 'query.run'], justification: 'Company assistant in Teams' };
    await inject({ method: 'PUT', url: `/v1/service-accounts/${agentId}/agent`, ...as(bob), payload }, 403);
    const tooMuch = await inject(
      { method: 'PUT', url: `/v1/service-accounts/${agentId}/agent`, ...as(alice), payload: { ...payload, scopes: ['access.binding.manage'] } },
      400,
    );
    expect(tooMuch.json().error).toBe('invalid_request');
    const approved = await inject({ method: 'PUT', url: `/v1/service-accounts/${agentId}/agent`, ...as(alice), payload }, 200);
    expect(approved.json().agent).toMatchObject({ scopes: ['action.run', 'app.run', 'query.run'], approvedBy: alice.userId });
  });
});

describe('acting for one named person', () => {
  let delegated: string;

  it("trades the person's IdP token for a short-lived token that acts for them", async () => {
    const response = await exchange(agentToken, { subject_token: 'idtoken:bob' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body).toMatchObject({
      token_type: 'Bearer',
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      expires_in: 600,
      scope: 'action.run app.run query.run',
    });
    expect(body.access_token).toMatch(/^plt_dlg_/);
    delegated = body.access_token;
    const me = (await inject({ method: 'GET', url: '/v1/me', ...bearer(delegated) }, 200)).json();
    expect(me).toMatchObject({ id: bob.userId, agent: { id: agentId, name: 'agentos' }, credential: { kind: 'token' } });
    // Acting for Bob, it may look a colleague up to fill a person field, as Bob could. On its own it may not.
    const found = (await inject({ method: 'GET', url: '/v1/people?search=carol', ...bearer(delegated) }, 200)).json();
    expect(found.people).toMatchObject([{ id: carol.userId, name: 'Carol' }]);
    expect((await inject({ method: 'GET', url: '/v1/people?search=carol', ...bearer(agentToken) }, 403)).json().error).toBe('person_required');
  });

  it('refuses tokens the IdP did not issue, scopes beyond the approval, and anyone but the agent', async () => {
    const forged = await exchange(agentToken, { subject_token: 'forged' });
    expect(forged.json()).toMatchObject({ error: 'invalid_grant' });
    const broad = await exchange(agentToken, { subject_token: 'idtoken:bob', scope: 'app.run record.read' });
    expect(broad.json()).toMatchObject({ error: 'invalid_scope' });
    // Neither a person's own token nor a delegated token can exchange.
    const pat = (
      await inject({ method: 'POST', url: '/v1/me/tokens', ...as(bob), payload: { name: 'mine', scopes: ['app.run'], expiresInDays: 1 } }, 201)
    ).json().token;
    expect((await exchange(pat, { subject_token: 'idtoken:carol' })).json()).toMatchObject({ error: 'unauthorized_client' });
    expect((await exchange(delegated, { subject_token: 'idtoken:carol' })).json()).toMatchObject({ error: 'unauthorized_client' });
  });

  it("shows the agent the person's errands, and turns an action into a proposal attributed to both", async () => {
    const tools = (await rpc(delegated, 'tools/list')).result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(tools).toEqual(['expenses__my_claims', 'expenses__my_spending', 'expenses__submit_claim']);
    const call = await rpc(delegated, 'tools/call', {
      name: 'expenses__submit_claim',
      arguments: {
        values: { title: 'Team dinner', lines: [{ date: '2026-11-12', merchant: 'Jumbo', category: 'meals', amount: 86 }] },
        provenance: { 'lines[0].amount': { source: 'document', document: 'receipt.pdf' } },
      },
    });
    const proposalId = call.result.structuredContent.proposal.id;
    const [row] = await t.ctx.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(row).toMatchObject({ proposedByType: 'service_account', proposedBy: agentId, onBehalfOf: bob.userId });
    const [event] = await t.ctx.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'proposal.create'), eq(auditEvents.appId, appId)));
    expect(event!.actor).toMatchObject({ type: 'service_account', id: agentId, via: 'mcp', onBehalfOf: bob.userId });

    const page = await inject({ method: 'GET', url: `/review/${proposalId}`, ...as(bob) }, 200);
    expect(page.body).toContain('Prepared by agentos, acting for you');

    // The agent can't approve, mint tokens, or touch records directly.
    const digest = row!.digest;
    expect((await inject({ method: 'POST', url: `/v1/proposals/${proposalId}/approve`, ...bearer(delegated), payload: { digest } }, 403)).json().error).toBe(
      'session_required',
    );
    await inject({ method: 'POST', url: '/v1/me/tokens', ...bearer(delegated), payload: { name: 'x', scopes: ['app.run'], expiresInDays: 1 } }, 403);
    await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/expense_claim/records`, ...bearer(delegated) }, 403);

    // The person approves, and the agent sees the outcome.
    await inject({ method: 'POST', url: `/v1/proposals/${proposalId}/approve`, ...as(bob), payload: { digest } }, 200);
    const outcome = (await inject({ method: 'GET', url: `/v1/proposals/${proposalId}`, ...bearer(delegated) }, 200)).json();
    expect(outcome.status).toBe('approved');
  });

  it("doesn't change who the person is or which groups they're in", async () => {
    t.idp.identities.set('bob', { ...t.idp.identities.get('bob')!, groups: [], name: 'Someone else' });
    const again = await exchange(agentToken, { subject_token: 'idtoken:bob' });
    expect(again.statusCode).toBe(200);
    const me = (await inject({ method: 'GET', url: '/v1/me', ...as(bob) }, 200)).json();
    expect(me.displayName).toBe('Bob');
  });

  it('expires quickly, and dies with the approval', async () => {
    t.clock.offsetMs = 11 * 60_000;
    expect((await inject({ method: 'GET', url: '/v1/me', ...bearer(delegated) }, 401)).json().message).toMatch(/expired/);
    t.clock.offsetMs = 0;

    const fresh = (await exchange(agentToken, { subject_token: 'idtoken:bob' })).json().access_token;
    await inject({ method: 'GET', url: '/v1/me', ...bearer(fresh) }, 200);
    await inject({ method: 'DELETE', url: `/v1/service-accounts/${agentId}/agent`, ...as(alice), payload: { reason: 'Replaced' } }, 200);
    expect((await inject({ method: 'GET', url: '/v1/me', ...bearer(fresh) }, 401)).json().message).toMatch(/revoked/);
    const tokens = await t.ctx.db.select().from(apiTokens).where(eq(apiTokens.actorServiceAccountId, agentId));
    expect(tokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect((await exchange(agentToken, { subject_token: 'idtoken:bob' })).json()).toMatchObject({ error: 'unauthorized_client' });
  });
});
