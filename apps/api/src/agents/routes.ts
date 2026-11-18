import { apiTokens, serviceAccounts } from '@platform/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { orgResource } from '../access/resources.js';
import { once, requireAuth, requireSession } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import { IdpUnavailableError, InvalidSubjectTokenError } from '../auth/oidc.js';
import { provisionUser } from '../auth/provisioning.js';
import type { AppContext } from '../context.js';
import { conflict, HttpError, notFound } from '../errors.js';
import { ServiceAccountOut, toServiceAccountOut } from '../tokens/routes.js';

/**
 * What an agent may ever do for a person. Agents work through errands, the actions and queries
 * apps publish, never on raw records or on access itself (design §6.4).
 */
export const AGENT_SCOPES = ['app.run', 'action.run', 'query.run', 'record.read'] as const;

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const SUBJECT_TOKEN_TYPES = ['urn:ietf:params:oauth:token-type:id_token', 'urn:ietf:params:oauth:token-type:jwt', ACCESS_TOKEN];

const ServiceAccountParams = z.object({ serviceAccountId: z.uuid() });

/** An OAuth error response (RFC 6749 §5.2), which token endpoints answer instead of Ambit's own errors. */
function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.status(status).header('cache-control', 'no-store').send({ error, error_description: description });
}

/**
 * Agents: service accounts that a Security admin approves to act for people, and the token
 * exchange (RFC 8693) through which they get a short-lived token for one named person. Any agent
 * can use it: agentos, a Copilot Studio bot, or one of our own.
 */
export function agentRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const theAccount = (request: FastifyRequest) =>
    once(request, 'agent-account', async () => {
      const { serviceAccountId } = request.params as { serviceAccountId: string };
      const [row] = await ctx.db
        .select()
        .from(serviceAccounts)
        .where(and(eq(serviceAccounts.id, serviceAccountId), eq(serviceAccounts.orgId, ctx.org.id)));
      if (!row) throw notFound('Service account');
      return row;
    });
  const approval = { kind: 'permission' as const, action: 'access.agent.approve', resource: async () => orgResource(ctx.org.id) };

  return async (app) => {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    app.put(
      '/v1/service-accounts/:serviceAccountId/agent',
      {
        config: { access: approval },
        schema: {
          tags: ['agents'],
          summary: 'Approve a service account to act for people as an agent, and cap what it may do for them',
          params: ServiceAccountParams,
          body: z.object({ scopes: z.array(z.enum(AGENT_SCOPES)).min(1), justification: z.string().trim().min(1).max(500) }),
          response: { 200: ServiceAccountOut },
        },
      },
      async (request) => {
        const auth = requireSession(request);
        const account = await theAccount(request);
        if (account.status !== 'active') throw conflict('disabled', 'This service account is disabled');
        const scopes = [...new Set(request.body.scopes)].sort();
        const now = ctx.now();
        const updated = await ctx.db.transaction(async (tx) => {
          const [row] = await tx
            .update(serviceAccounts)
            .set({ agentScopes: scopes, agentApprovedAt: now, agentApprovedBy: auth.actor.id })
            .where(eq(serviceAccounts.id, account.id))
            .returning();
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
            action: 'agent.approve',
            target: { type: 'service_account', id: account.id, name: account.name },
            spaceId: account.spaceId,
            reason: { justification: request.body.justification },
            changes: { before: { scopes: account.agentScopes }, after: { scopes } },
          });
          return row!;
        });
        return toServiceAccountOut(updated);
      },
    );

    app.delete(
      '/v1/service-accounts/:serviceAccountId/agent',
      {
        config: { access: approval },
        schema: {
          tags: ['agents'],
          summary: 'Stop a service account acting for people. Its tokens for people stop working at once',
          params: ServiceAccountParams,
          body: z.object({ reason: z.string().trim().min(1).max(500) }),
          response: { 200: ServiceAccountOut },
        },
      },
      async (request) => {
        const auth = requireSession(request);
        const account = await theAccount(request);
        if (!account.agentScopes) throw conflict('not_an_agent', 'This service account is not approved as an agent');
        const now = ctx.now();
        const updated = await ctx.db.transaction(async (tx) => {
          const [row] = await tx
            .update(serviceAccounts)
            .set({ agentScopes: null, agentApprovedAt: null, agentApprovedBy: null })
            .where(eq(serviceAccounts.id, account.id))
            .returning();
          const revoked = await tx
            .update(apiTokens)
            .set({ revokedAt: now, revokedByType: auth.actor.type, revokedBy: auth.actor.id })
            .where(and(eq(apiTokens.actorServiceAccountId, account.id), isNull(apiTokens.revokedAt)))
            .returning({ id: apiTokens.id });
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
            action: 'agent.revoke',
            target: { type: 'service_account', id: account.id, name: account.name },
            spaceId: account.spaceId,
            reason: { justification: request.body.reason },
            changes: { before: { scopes: account.agentScopes }, after: { scopes: null }, revokedTokens: revoked.length },
          });
          return row!;
        });
        return toServiceAccountOut(updated);
      },
    );

    app.post(
      '/v1/oauth/token',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['agents'],
          summary:
            "Token exchange (RFC 8693): an approved agent, authenticated with its own service-account token, trades a person's IdP token for a short-lived Ambit token that acts for that person",
          body: z.record(z.string(), z.unknown()),
        },
      },
      async (request, reply) => {
        const auth = requireAuth(request);
        const body = request.body as Record<string, unknown>;
        if (auth.actor.type !== 'service_account' || auth.agent) {
          return oauthError(reply, 400, 'unauthorized_client', 'Only an approved agent, using its own service-account token, can exchange tokens');
        }
        if (body['grant_type'] !== TOKEN_EXCHANGE) return oauthError(reply, 400, 'unsupported_grant_type', `Use ${TOKEN_EXCHANGE}`);
        const subjectToken = body['subject_token'];
        if (typeof subjectToken !== 'string' || !SUBJECT_TOKEN_TYPES.includes(String(body['subject_token_type']))) {
          return oauthError(reply, 400, 'invalid_request', "Send the person's ID token, or a JWT access token, as subject_token, with its subject_token_type");
        }
        if (body['requested_token_type'] !== undefined && body['requested_token_type'] !== ACCESS_TOKEN) {
          return oauthError(reply, 400, 'invalid_request', `Ambit issues ${ACCESS_TOKEN} only`);
        }
        const [agent] = await ctx.db.select().from(serviceAccounts).where(eq(serviceAccounts.id, auth.actor.id));
        if (!agent?.agentScopes) return oauthError(reply, 400, 'unauthorized_client', 'This service account is not approved to act for people');
        const requested = typeof body['scope'] === 'string' && body['scope'].trim() ? body['scope'].trim().split(/\s+/) : agent.agentScopes;
        const beyond = requested.filter((scope) => !agent.agentScopes!.includes(scope));
        if (beyond.length) return oauthError(reply, 400, 'invalid_scope', `This agent may not ask for: ${beyond.join(', ')}`);

        const now = ctx.now();
        const audit = auditScopeFor(request, ctx.org.id, now);
        let identity;
        try {
          identity = await ctx.oidc.verifyToken(subjectToken);
        } catch (error) {
          if (error instanceof IdpUnavailableError)
            return oauthError(reply, 503, 'temporarily_unavailable', 'The identity provider cannot be reached right now');
          if (!(error instanceof InvalidSubjectTokenError)) throw error;
          await recordAudit(ctx.db, audit, {
            action: 'token.exchange',
            outcome: 'denied',
            reason: { error: 'invalid_subject_token', detail: error.message.slice(0, 200) },
          });
          return oauthError(reply, 400, 'invalid_grant', 'The subject token is not a valid token from the identity provider for Ambit');
        }
        try {
          const issued = await ctx.db.transaction(async (tx) => {
            const person = await provisionUser(tx, { orgId: ctx.org.id, config: ctx.config, identity, audit, mode: 'exchange' });
            const expiresAt = new Date(now.getTime() + ctx.config.DELEGATED_TOKEN_TTL_SECONDS * 1000);
            const { token, row } = await ctx.tokens.issueDelegated(tx, {
              userId: person.userId,
              agentId: agent.id,
              agentName: agent.name,
              scopes: requested,
              expiresAt,
            });
            await recordAudit(
              tx,
              { ...audit, actor: { ...audit.actor, onBehalfOf: person.userId } },
              {
                action: 'token.exchange',
                target: { type: 'api_token', id: row.id, name: row.displayPrefix },
                spaceId: agent.spaceId,
                reason: { issuer: identity.issuer, scopes: requested, expiresAt: expiresAt.toISOString() },
              },
            );
            return { token, scopes: requested };
          });
          return reply.header('cache-control', 'no-store').send({
            access_token: issued.token,
            issued_token_type: ACCESS_TOKEN,
            token_type: 'Bearer',
            expires_in: ctx.config.DELEGATED_TOKEN_TTL_SECONDS,
            scope: issued.scopes.join(' '),
          });
        } catch (error) {
          if (error instanceof HttpError && error.code === 'account_deprovisioned') {
            return oauthError(reply, 400, 'invalid_grant', 'That person can no longer use Ambit');
          }
          throw error;
        }
      },
    );
  };
}
