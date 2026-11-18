import { uuidv7 } from '@platform/audit';
import { authorize } from '@platform/authz';
import { bindings, spaces, users } from '@platform/db';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BindingOut, describeBindings } from '../access/describe.js';
import { loadSpace, orgResource, type SpaceRow, spaceResource } from '../access/resources.js';
import { once, requireAuth, requireUser } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import { conflict, unprocessable } from '../errors.js';

export const SpaceOut = z.object({
  id: z.uuid(),
  kind: z.enum(['personal', 'team']),
  name: z.string(),
  status: z.enum(['active', 'frozen', 'archived']),
  ownerUserId: z.uuid().nullable(),
  createdAt: z.string(),
});

export function toSpaceOut(space: SpaceRow): z.infer<typeof SpaceOut> {
  return {
    id: space.id,
    kind: space.kind,
    name: space.name,
    status: space.status,
    ownerUserId: space.ownerUserId,
    createdAt: space.createdAt.toISOString(),
  };
}

const SpaceParams = z.object({ spaceId: z.uuid() });

export function spaceRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const theSpace = (request: FastifyRequest) => once(request, 'space', () => loadSpace(ctx.db, ctx.org.id, (request.params as { spaceId: string }).spaceId));
  const spaceAsResource = async (request: FastifyRequest) => spaceResource(ctx.org.id, await theSpace(request));

  return async (app) => {
    app.get(
      '/v1/spaces',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['spaces'],
          summary: 'Spaces you can see: your personal space and the team spaces you belong to',
          response: { 200: z.object({ spaces: z.array(SpaceOut) }) },
        },
      },
      async (request) => {
        const { principal } = requireAuth(request);
        const [policy, held] = await Promise.all([ctx.policy.policy(), ctx.policy.bindingsFor(principal)]);
        const spaceIds = held.filter((b) => b.scope.type === 'space').map((b) => b.scope.id);
        const holdsOrgBinding = held.some((b) => b.scope.type === 'org');
        const candidates = await ctx.db
          .select()
          .from(spaces)
          .where(
            and(
              eq(spaces.orgId, ctx.org.id),
              or(spaceIds.length ? inArray(spaces.id, spaceIds) : undefined, holdsOrgBinding ? eq(spaces.kind, 'team') : undefined),
            ),
          );
        const now = ctx.now();
        const visible = candidates.filter(
          (space) => authorize(policy, { principal, action: 'space.read', resource: spaceResource(ctx.org.id, space), bindings: held, now }).allowed,
        );
        visible.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'personal' ? -1 : 1));
        return { spaces: visible.map(toSpaceOut) };
      },
    );

    app.post(
      '/v1/spaces',
      {
        config: { access: { kind: 'permission', action: 'space.create', resource: async () => orgResource(ctx.org.id) } },
        schema: {
          tags: ['spaces'],
          summary: 'Create a team space. You become an owner, together with the co-owners you name.',
          body: z.object({
            name: z.string().trim().min(1).max(100),
            coOwnerUserIds: z.array(z.uuid()).max(10).default([]),
          }),
          response: { 201: SpaceOut },
        },
      },
      async (request, reply) => {
        // Team spaces are owned by people, so a service account cannot create one.
        const auth = requireUser(request);
        const coOwners = [...new Set(request.body.coOwnerUserIds)].filter((id) => id !== auth.actor.id);
        const minimum = ctx.config.MIN_TEAM_SPACE_OWNERS;
        if (coOwners.length + 1 < minimum) {
          throw unprocessable('not_enough_owners', `A team space needs at least ${minimum} owners. Name ${minimum - 1} co-owner(s).`);
        }
        if (coOwners.length > 0) {
          const found = await ctx.db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.orgId, ctx.org.id), eq(users.status, 'active'), inArray(users.id, coOwners)));
          const missing = coOwners.filter((id) => !found.some((u) => u.id === id));
          if (missing.length) throw unprocessable('unknown_user', 'Some co-owners are not active users', { missing });
        }

        const now = ctx.now();
        const audit = auditScopeFor(request, ctx.org.id, now);
        const owners = [auth.actor.id, ...coOwners];
        const space = await ctx.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(spaces)
            .values({ id: uuidv7(now.getTime()), orgId: ctx.org.id, kind: 'team', name: request.body.name, createdBy: auth.actor.id, createdAt: now })
            .returning();
          await recordAudit(tx, audit, {
            action: 'space.create',
            target: { type: 'space', id: created!.id, name: created!.name },
            spaceId: created!.id,
            changes: { after: { kind: 'team', name: created!.name, owners } },
          });
          for (const userId of owners) {
            const bindingId = uuidv7(now.getTime());
            await tx.insert(bindings).values({
              id: bindingId,
              orgId: ctx.org.id,
              principalType: 'user',
              principalId: userId,
              roleId: 'space.owner',
              scopeType: 'space',
              scopeId: created!.id,
              grantedByType: 'user',
              grantedBy: auth.actor.id,
              createdAt: now,
            });
            await recordAudit(tx, audit, {
              action: 'binding.create',
              target: { type: 'binding', id: bindingId },
              spaceId: created!.id,
              changes: { after: { principalType: 'user', principalId: userId, roleId: 'space.owner', scope: { type: 'space', id: created!.id } } },
            });
          }
          return created!;
        });
        return reply.status(201).send(toSpaceOut(space));
      },
    );

    app.get(
      '/v1/spaces/:spaceId',
      {
        config: { access: { kind: 'permission', action: 'space.read', resource: spaceAsResource } },
        schema: { tags: ['spaces'], summary: 'One space', params: SpaceParams, response: { 200: SpaceOut } },
      },
      async (request) => toSpaceOut(await theSpace(request)),
    );

    app.post(
      '/v1/spaces/:spaceId/freeze',
      {
        config: { access: { kind: 'permission', action: 'space.freeze', resource: spaceAsResource } },
        schema: {
          tags: ['spaces'],
          summary: 'Freeze a space: everything in it becomes read-only',
          params: SpaceParams,
          body: z.object({ reason: z.string().trim().min(1).max(500) }),
          response: { 200: SpaceOut },
        },
      },
      async (request) => {
        const space = await theSpace(request);
        if (space.status !== 'active') throw conflict('not_active', `The space is already ${space.status}`);
        const audit = auditScopeFor(request, ctx.org.id, ctx.now());
        const updated = await ctx.db.transaction(async (tx) => {
          const [row] = await tx.update(spaces).set({ status: 'frozen' }).where(eq(spaces.id, space.id)).returning();
          await recordAudit(tx, audit, {
            action: 'space.freeze',
            target: { type: 'space', id: space.id, name: space.name },
            spaceId: space.id,
            reason: { justification: request.body.reason },
            changes: { before: { status: space.status }, after: { status: 'frozen' } },
          });
          return row!;
        });
        return toSpaceOut(updated);
      },
    );

    app.get(
      '/v1/spaces/:spaceId/members',
      {
        config: { access: { kind: 'permission', action: 'space.read', resource: spaceAsResource } },
        schema: {
          tags: ['spaces'],
          summary: 'Who holds which role in a space',
          params: SpaceParams,
          response: { 200: z.object({ members: z.array(BindingOut) }) },
        },
      },
      async (request) => {
        const space = await theSpace(request);
        const rows = await ctx.db
          .select()
          .from(bindings)
          .where(and(eq(bindings.scopeType, 'space'), eq(bindings.scopeId, space.id), isNull(bindings.revokedAt)));
        return { members: await describeBindings(ctx.db, rows) };
      },
    );
  };
}
