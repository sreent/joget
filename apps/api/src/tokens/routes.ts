import { uuidv7 } from '@platform/audit';
import { isKnownPermissionPattern } from '@platform/authz';
import { apiTokens, type Executor, serviceAccounts, spaces } from '@platform/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadSpace, orgResource, spaceResource } from '../access/resources.js';
import { once, requireAuth, requireSession, requireUser } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import type { TokenOwner, TokenRow } from './service.js';

/** Token scopes: explicit permissions or patterns from the catalog. A bare `*` is not allowed. */
const Scopes = z
  .array(
    z.string().refine((scope) => scope !== '*' && isKnownPermissionPattern(scope), {
      message: 'Use permissions or patterns from the catalog, for example space.read or app.*. A bare * is not allowed.',
    }),
  )
  .min(1)
  .max(50)
  .transform((scopes) => [...new Set(scopes)].sort());

const tokenRequest = (maxDays: number) =>
  z.object({
    name: z.string().trim().min(1).max(100),
    scopes: Scopes,
    expiresInDays: z.number().int().min(1).max(maxDays).default(Math.min(30, maxDays)),
  });

const TokenOut = z.object({
  id: z.uuid(),
  name: z.string(),
  displayPrefix: z.string(),
  owner: z.object({ type: z.enum(['user', 'service_account']), id: z.uuid() }),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  createdAt: z.string(),
  createdBy: z.uuid(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
/** Returned once, at creation: the only time the token itself is ever shown. */
const CreatedTokenOut = TokenOut.extend({ token: z.string() });

export const ServiceAccountOut = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  createdBy: z.uuid(),
  createdAt: z.string(),
  disabledAt: z.string().nullable(),
  /** Set when a Security admin approved it to act for people: the most it may do for anyone. */
  agent: z.object({ scopes: z.array(z.string()), approvedAt: z.string(), approvedBy: z.uuid() }).nullable(),
});

function toTokenOut(row: TokenRow): z.infer<typeof TokenOut> {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.displayPrefix,
    owner: row.userId ? { type: 'user', id: row.userId } : { type: 'service_account', id: row.serviceAccountId! },
    scopes: row.scopes,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export function toServiceAccountOut(row: typeof serviceAccounts.$inferSelect): z.infer<typeof ServiceAccountOut> {
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    description: row.description,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
    agent:
      row.agentScopes && row.agentApprovedAt && row.agentApprovedBy
        ? { scopes: row.agentScopes, approvedAt: row.agentApprovedAt.toISOString(), approvedBy: row.agentApprovedBy }
        : null,
  };
}

const TokenParams = z.object({ tokenId: z.uuid() });
const ServiceAccountParams = z.object({ serviceAccountId: z.uuid() });

export function tokenRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const days = (n: number) => new Date(ctx.now().getTime() + n * 86_400_000);

  /** The caller's personal space: personal access tokens are authorized against it. */
  const personalSpace = (request: FastifyRequest) =>
    once(request, 'personal-space', async () => {
      const auth = requireSession(request);
      const [space] = await ctx.db
        .select()
        .from(spaces)
        .where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, auth.actor.id)));
      if (!space) throw notFound('Personal space');
      return spaceResource(ctx.org.id, space);
    });

  const theServiceAccount = (request: FastifyRequest) =>
    once(request, 'service-account', async () => {
      const { serviceAccountId } = request.params as { serviceAccountId: string };
      const [row] = await ctx.db
        .select()
        .from(serviceAccounts)
        .where(and(eq(serviceAccounts.id, serviceAccountId), eq(serviceAccounts.orgId, ctx.org.id)));
      if (!row) throw notFound('Service account');
      return row;
    });
  const serviceAccountSpace = async (request: FastifyRequest) =>
    spaceResource(ctx.org.id, await loadSpace(ctx.db, ctx.org.id, (await theServiceAccount(request)).spaceId));

  async function revoke(executor: Executor, request: FastifyRequest, token: TokenRow, justification?: string) {
    const auth = requireAuth(request);
    if (token.revokedAt) throw conflict('already_revoked', 'This token is already revoked');
    const [updated] = await executor
      .update(apiTokens)
      .set({ revokedAt: ctx.now(), revokedByType: auth.actor.type, revokedBy: auth.actor.id })
      .where(and(eq(apiTokens.id, token.id), isNull(apiTokens.revokedAt)))
      .returning();
    if (!updated) throw conflict('already_revoked', 'This token is already revoked');
    await recordAudit(executor, auditScopeFor(request, ctx.org.id, ctx.now()), {
      action: 'token.revoke',
      target: { type: 'api_token', id: token.id, name: token.name },
      reason: justification ? { justification } : {},
      changes: { before: { owner: toTokenOut(token).owner, scopes: token.scopes } },
    });
    return updated;
  }

  async function issue(request: FastifyRequest, owner: TokenOwner, body: { name: string; scopes: string[]; expiresInDays: number }, spaceId: string | null) {
    const auth = requireSession(request);
    return ctx.db.transaction(async (tx) => {
      const { token, row } = await ctx.tokens.issue(tx, {
        owner,
        name: body.name,
        scopes: body.scopes,
        expiresAt: days(body.expiresInDays),
        createdBy: auth.actor.id,
      });
      await recordAudit(tx, auditScopeFor(request, ctx.org.id, ctx.now()), {
        action: 'token.create',
        target: { type: 'api_token', id: row.id, name: row.name },
        spaceId,
        reason: { decision: request.decision?.reasons ?? [] },
        changes: { after: { owner, scopes: row.scopes, expiresAt: row.expiresAt.toISOString(), displayPrefix: row.displayPrefix } },
      });
      return { ...toTokenOut(row), token };
    });
  }

  return async (app) => {
    // Personal access tokens: a person's own, narrower credential for scripts and tools.
    app.post(
      '/v1/me/tokens',
      {
        config: { access: { kind: 'permission', action: 'token.personal.create', resource: personalSpace } },
        schema: {
          tags: ['tokens'],
          summary: 'Create a personal access token. Its permissions are your own, narrowed to the scopes you pick.',
          body: tokenRequest(ctx.config.PAT_MAX_TTL_DAYS),
          response: { 201: CreatedTokenOut },
        },
      },
      async (request, reply) => {
        const auth = requireSession(request);
        return reply.status(201).send(await issue(request, { type: 'user', id: auth.actor.id }, request.body, null));
      },
    );

    app.get(
      '/v1/me/tokens',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['tokens'], summary: 'Your API tokens (never the secrets)', response: { 200: z.object({ tokens: z.array(TokenOut) }) } },
      },
      async (request) => {
        const { actor } = requireAuth(request);
        const owner = actor.type === 'user' ? eq(apiTokens.userId, actor.id) : eq(apiTokens.serviceAccountId, actor.id);
        const rows = await ctx.db.select().from(apiTokens).where(owner).orderBy(desc(apiTokens.createdAt));
        return { tokens: rows.map(toTokenOut) };
      },
    );

    app.post(
      '/v1/me/tokens/:tokenId/revoke',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['tokens'], summary: 'Revoke one of your own tokens', params: TokenParams, response: { 200: TokenOut } },
      },
      async (request) => {
        const { actor } = requireAuth(request);
        const [token] = await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, request.params.tokenId));
        const mine = token && (actor.type === 'user' ? token.userId === actor.id : token.serviceAccountId === actor.id);
        if (!token || !mine) throw notFound('Token');
        return toTokenOut(await ctx.db.transaction((tx) => revoke(tx, request, token)));
      },
    );

    // Service accounts: non-human principals owned by a team space.
    app.get(
      '/v1/spaces/:spaceId/service-accounts',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'space.read',
            resource: async (request) => spaceResource(ctx.org.id, await loadSpace(ctx.db, ctx.org.id, (request.params as { spaceId: string }).spaceId)),
          },
        },
        schema: {
          tags: ['service accounts'],
          summary: 'Service accounts owned by a space',
          params: z.object({ spaceId: z.uuid() }),
          response: { 200: z.object({ serviceAccounts: z.array(ServiceAccountOut) }) },
        },
      },
      async (request) => {
        const rows = await ctx.db.select().from(serviceAccounts).where(eq(serviceAccounts.spaceId, request.params.spaceId));
        return { serviceAccounts: rows.map(toServiceAccountOut) };
      },
    );

    app.post(
      '/v1/spaces/:spaceId/service-accounts',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'space.service_account.manage',
            resource: async (request) => spaceResource(ctx.org.id, await loadSpace(ctx.db, ctx.org.id, (request.params as { spaceId: string }).spaceId)),
          },
        },
        schema: {
          tags: ['service accounts'],
          summary: 'Create a service account in a team space. It can do nothing until it is granted roles.',
          params: z.object({ spaceId: z.uuid() }),
          body: z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).optional() }),
          response: { 201: ServiceAccountOut },
        },
      },
      async (request, reply) => {
        const auth = requireUser(request);
        const space = await loadSpace(ctx.db, ctx.org.id, request.params.spaceId);
        if (space.kind !== 'team') throw unprocessable('team_space_required', 'Service accounts belong to team spaces');
        const now = ctx.now();
        const created = await ctx.db.transaction(async (tx) => {
          const [existing] = await tx
            .select({ id: serviceAccounts.id })
            .from(serviceAccounts)
            .where(and(eq(serviceAccounts.spaceId, space.id), eq(serviceAccounts.name, request.body.name)));
          if (existing) throw conflict('name_taken', 'This space already has a service account with that name');
          const [row] = await tx
            .insert(serviceAccounts)
            .values({
              id: uuidv7(now.getTime()),
              orgId: ctx.org.id,
              spaceId: space.id,
              name: request.body.name,
              description: request.body.description ?? null,
              createdBy: auth.actor.id,
              createdAt: now,
            })
            .returning();
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
            action: 'service_account.create',
            target: { type: 'service_account', id: row!.id, name: row!.name },
            spaceId: space.id,
            changes: { after: { name: row!.name, spaceId: space.id } },
          });
          return row!;
        });
        return reply.status(201).send(toServiceAccountOut(created));
      },
    );

    app.post(
      '/v1/service-accounts/:serviceAccountId/disable',
      {
        config: { access: { kind: 'permission', action: 'space.service_account.manage', resource: serviceAccountSpace } },
        schema: {
          tags: ['service accounts'],
          summary: 'Disable a service account and revoke all of its tokens',
          params: ServiceAccountParams,
          body: z.object({ reason: z.string().trim().min(1).max(500) }),
          response: { 200: ServiceAccountOut },
        },
      },
      async (request) => {
        const account = await theServiceAccount(request);
        if (account.status !== 'active') throw conflict('already_disabled', 'This service account is already disabled');
        const auth = requireAuth(request);
        const now = ctx.now();
        const updated = await ctx.db.transaction(async (tx) => {
          const [row] = await tx.update(serviceAccounts).set({ status: 'disabled', disabledAt: now }).where(eq(serviceAccounts.id, account.id)).returning();
          const revoked = await tx
            .update(apiTokens)
            .set({ revokedAt: now, revokedByType: auth.actor.type, revokedBy: auth.actor.id })
            .where(and(eq(apiTokens.serviceAccountId, account.id), isNull(apiTokens.revokedAt)))
            .returning({ id: apiTokens.id });
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
            action: 'service_account.disable',
            target: { type: 'service_account', id: account.id, name: account.name },
            spaceId: account.spaceId,
            reason: { justification: request.body.reason },
            changes: { before: { status: 'active' }, after: { status: 'disabled' }, revokedTokenIds: revoked.map((t) => t.id) },
          });
          return row!;
        });
        return toServiceAccountOut(updated);
      },
    );

    app.get(
      '/v1/service-accounts/:serviceAccountId/tokens',
      {
        config: { access: { kind: 'permission', action: 'space.read', resource: serviceAccountSpace } },
        schema: {
          tags: ['service accounts'],
          summary: "A service account's tokens (never the secrets)",
          params: ServiceAccountParams,
          response: { 200: z.object({ tokens: z.array(TokenOut) }) },
        },
      },
      async (request) => {
        const account = await theServiceAccount(request);
        const rows = await ctx.db.select().from(apiTokens).where(eq(apiTokens.serviceAccountId, account.id)).orderBy(desc(apiTokens.createdAt));
        return { tokens: rows.map(toTokenOut) };
      },
    );

    app.post(
      '/v1/service-accounts/:serviceAccountId/tokens',
      {
        config: { access: { kind: 'permission', action: 'space.service_account.manage', resource: serviceAccountSpace } },
        schema: {
          tags: ['service accounts'],
          summary: 'Issue a token for a service account. It can do only what the account is granted, narrowed to the scopes.',
          params: ServiceAccountParams,
          body: tokenRequest(ctx.config.SERVICE_ACCOUNT_TOKEN_MAX_TTL_DAYS),
          response: { 201: CreatedTokenOut },
        },
      },
      async (request, reply) => {
        const account = await theServiceAccount(request);
        if (account.status !== 'active') throw conflict('service_account_disabled', 'This service account is disabled');
        return reply.status(201).send(await issue(request, { type: 'service_account', id: account.id }, request.body, account.spaceId));
      },
    );

    app.post(
      '/v1/service-accounts/:serviceAccountId/tokens/:tokenId/revoke',
      {
        config: { access: { kind: 'permission', action: 'space.service_account.manage', resource: serviceAccountSpace } },
        schema: {
          tags: ['service accounts'],
          summary: "Revoke one of a service account's tokens",
          params: ServiceAccountParams.extend({ tokenId: z.uuid() }),
          response: { 200: TokenOut },
        },
      },
      async (request) => {
        const account = await theServiceAccount(request);
        const [token] = await ctx.db
          .select()
          .from(apiTokens)
          .where(and(eq(apiTokens.id, request.params.tokenId), eq(apiTokens.serviceAccountId, account.id)));
        if (!token) throw notFound('Token');
        return toTokenOut(await ctx.db.transaction((tx) => revoke(tx, request, token)));
      },
    );

    // Organization-wide oversight: every token is visible to security, and anyone's can be revoked.
    app.get(
      '/v1/tokens',
      {
        config: { access: { kind: 'permission', action: 'access.token.read', resource: async () => orgResource(ctx.org.id) } },
        schema: {
          tags: ['tokens'],
          summary: 'Every API token in the organization (never the secrets)',
          querystring: z.object({ includeRevoked: z.enum(['true', 'false']).default('false') }),
          response: { 200: z.object({ tokens: z.array(TokenOut) }) },
        },
      },
      async (request) => {
        const rows = await ctx.db
          .select()
          .from(apiTokens)
          .where(and(eq(apiTokens.orgId, ctx.org.id), request.query.includeRevoked === 'true' ? undefined : isNull(apiTokens.revokedAt)))
          .orderBy(desc(apiTokens.createdAt));
        return { tokens: rows.map(toTokenOut) };
      },
    );

    app.post(
      '/v1/tokens/:tokenId/revoke',
      {
        config: { access: { kind: 'permission', action: 'access.token.revoke', resource: async () => orgResource(ctx.org.id) } },
        schema: {
          tags: ['tokens'],
          summary: "Revoke anyone's token, for example after a leak",
          params: TokenParams,
          body: z.object({ justification: z.string().trim().min(1).max(500) }),
          response: { 200: TokenOut },
        },
      },
      async (request) => {
        const [token] = await ctx.db
          .select()
          .from(apiTokens)
          .where(and(eq(apiTokens.id, request.params.tokenId), eq(apiTokens.orgId, ctx.org.id)));
        if (!token) throw notFound('Token');
        return toTokenOut(await ctx.db.transaction((tx) => revoke(tx, request, token, request.body.justification)));
      },
    );
  };
}
