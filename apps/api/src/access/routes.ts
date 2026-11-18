import { uuidv7 } from '@platform/audit';
import {
  type Binding,
  findEscalation,
  findSodConflicts,
  isValidPermissionPattern,
  MANAGED_SOD_RULES,
  type Principal,
  SYSTEM_ASSIGNED_ROLES,
} from '@platform/authz';
import { bindings, groups, serviceAccounts, users } from '@platform/db';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditScopeFor, recordAudit, spaceIdOf } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { BindingOut, describeBindings } from './describe.js';
import { type BindingRow, toBinding } from './policy-service.js';
import { bindingManageAction, loadSpace, scopeResource } from './resources.js';
import { once, requireAuth } from './rules.js';

const Scope = z.object({ type: z.enum(['org', 'space']), id: z.uuid() });

const CreateBinding = z
  .object({
    principal: z.object({ type: z.enum(['user', 'group', 'service_account']), id: z.uuid() }),
    roleId: z.string().min(1).max(100).optional(),
    permissionSetId: z.string().min(1).max(100).optional(),
    scope: Scope,
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    justification: z.string().trim().min(1).max(500).optional(),
  })
  .refine((body) => (body.roleId === undefined) !== (body.permissionSetId === undefined), {
    message: 'Give exactly one of roleId or permissionSetId',
  });
type CreateBinding = z.infer<typeof CreateBinding>;

const Explain = z.object({
  userId: z.uuid(),
  action: z.string().refine(isValidPermissionPattern, 'Not a valid permission'),
  resource: Scope,
  context: z.record(z.string(), z.unknown()).optional(),
  /** Explain as if the user had just completed MFA, so step-up rules don't hide the underlying grants. */
  assumeFreshMfa: z.boolean().default(true),
});

export function accessRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  /** The scope named in a request body, as a resource. Computed once per request. */
  const scopeIn = (request: FastifyRequest, pick: (body: never) => z.infer<typeof Scope>) =>
    once(request, 'scope', () => scopeResource(ctx.db, ctx.org.id, pick(request.body as never)));
  const bindingScope = (request: FastifyRequest) => scopeIn(request, (body: CreateBinding) => body.scope);
  const explainScope = (request: FastifyRequest) => scopeIn(request, (body: z.infer<typeof Explain>) => body.resource);

  const theBinding = (request: FastifyRequest) =>
    once(request, 'binding', async () => {
      const [row] = await ctx.db
        .select()
        .from(bindings)
        .where(and(eq(bindings.id, (request.params as { bindingId: string }).bindingId), eq(bindings.orgId, ctx.org.id)));
      if (!row) throw notFound('Binding');
      return row;
    });

  return async (app) => {
    app.get(
      '/v1/roles',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['access'], summary: 'The roles and permission sets that can be granted' },
      },
      async () => {
        const policy = await ctx.policy.policy();
        return {
          roles: [...policy.roles.values()].map((role) => ({ ...role, systemAssigned: SYSTEM_ASSIGNED_ROLES.includes(role.id) })),
          permissionSets: [...policy.permissionSets.values()],
        };
      },
    );

    app.get(
      '/v1/bindings',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'access.binding.read',
            resource: (request) => {
              const query = request.query as { scopeType: 'org' | 'space'; scopeId: string };
              return once(request, 'scope', () => scopeResource(ctx.db, ctx.org.id, { type: query.scopeType, id: query.scopeId }));
            },
          },
        },
        schema: {
          tags: ['access'],
          summary: 'Bindings at a scope',
          querystring: z.object({
            scopeType: z.enum(['org', 'space']),
            scopeId: z.uuid(),
            includeRevoked: z.enum(['true', 'false']).default('false'),
          }),
          response: { 200: z.object({ bindings: z.array(BindingOut) }) },
        },
      },
      async (request) => {
        const { scopeType, scopeId, includeRevoked } = request.query;
        const rows = await ctx.db
          .select()
          .from(bindings)
          .where(
            and(
              eq(bindings.orgId, ctx.org.id),
              eq(bindings.scopeType, scopeType),
              eq(bindings.scopeId, scopeId),
              includeRevoked === 'true' ? undefined : isNull(bindings.revokedAt),
            ),
          );
        return { bindings: await describeBindings(ctx.db, rows) };
      },
    );

    app.post(
      '/v1/bindings',
      {
        config: {
          access: {
            kind: 'permission',
            action: async (request) => bindingManageAction((request.body as CreateBinding).scope.type),
            resource: bindingScope,
          },
        },
        schema: {
          tags: ['access'],
          summary: 'Grant a role or permission set to a user or group at a scope',
          body: CreateBinding,
          response: { 201: BindingOut },
        },
      },
      async (request, reply) => {
        const auth = requireAuth(request);
        const body = request.body;
        const now = ctx.now();
        const audit = auditScopeFor(request, ctx.org.id, now);
        const resource = await bindingScope(request);

        if (body.scope.type === 'space') {
          const space = await loadSpace(ctx.db, ctx.org.id, body.scope.id);
          if (space.kind === 'personal') {
            throw unprocessable('personal_space_bindings', 'Access to personal spaces is managed by the platform. Share individual apps instead.');
          }
        }
        if (body.scope.type === 'org' && !body.justification) {
          throw unprocessable('justification_required', 'Org-level grants need a justification');
        }
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
        if (expiresAt && expiresAt <= now) throw unprocessable('expiry_in_past', 'expiresAt must be in the future');

        const policy = await ctx.policy.policy();
        const definition = body.roleId ? policy.roles.get(body.roleId) : policy.permissionSets.get(body.permissionSetId!);
        if (!definition) throw unprocessable('unknown_role', `Unknown ${body.roleId ? 'role' : 'permission set'}`);
        if (body.roleId && SYSTEM_ASSIGNED_ROLES.includes(body.roleId)) {
          throw unprocessable('system_assigned_role', `${definition.name} is assigned by the platform and cannot be granted`);
        }
        if (definition.scopeType !== body.scope.type) {
          throw unprocessable('scope_mismatch', `${definition.name} is for ${definition.scopeType} scope, not ${body.scope.type}`);
        }

        const target = await loadPrincipal(ctx, body.principal);
        const changes = {
          after: {
            principalType: body.principal.type,
            principalId: body.principal.id,
            roleId: body.roleId ?? null,
            permissionSetId: body.permissionSetId ?? null,
            scope: body.scope,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        };
        const deny = async (error: string, details: Record<string, unknown>) =>
          recordAudit(ctx.db, audit, {
            action: 'binding.create',
            outcome: 'denied',
            target: { type: body.principal.type, id: body.principal.id },
            spaceId: spaceIdOf(resource),
            reason: { error, ...details },
            changes,
          });

        // You can only hand out permissions you hold yourself at this scope.
        const granterBindings = await ctx.policy.bindingsFor(auth.principal);
        const missing = findEscalation(
          policy,
          auth.principal,
          resource.scopes,
          granterBindings,
          body.roleId ? { roleId: body.roleId } : { permissionSetId: body.permissionSetId! },
          now,
        );
        if (missing.length > 0) {
          await deny('privilege_escalation', { missing });
          throw forbidden('privilege_escalation', 'You can only grant permissions that you hold yourself at this scope', { missing });
        }

        // Separation of duties: the target must not end up holding conflicting roles.
        const conflicts = findSodConflicts(body.roleId, await bindingsOfTarget(ctx, target), MANAGED_SOD_RULES, now);
        if (conflicts.length > 0) {
          await deny('sod_conflict', { conflicts });
          throw conflict('sod_conflict', 'This grant would break separation of duties', { conflicts });
        }

        const created = await ctx.db.transaction(async (tx) => {
          const sameGrant = and(
            eq(bindings.principalType, body.principal.type),
            eq(bindings.principalId, body.principal.id),
            eq(bindings.scopeType, body.scope.type),
            eq(bindings.scopeId, body.scope.id),
            body.roleId ? eq(bindings.roleId, body.roleId) : eq(bindings.permissionSetId, body.permissionSetId!),
            isNull(bindings.revokedAt),
          );
          const [existing] = await tx.select().from(bindings).where(sameGrant);
          if (existing) {
            if (!existing.expiresAt || existing.expiresAt > now) throw conflict('already_granted', 'This principal already holds that grant here');
            // An expired grant is closed off before the new one starts, keeping history intact.
            await tx.update(bindings).set({ revokedAt: now }).where(eq(bindings.id, existing.id));
          }
          const [row] = await tx
            .insert(bindings)
            .values({
              id: uuidv7(now.getTime()),
              orgId: ctx.org.id,
              principalType: body.principal.type,
              principalId: body.principal.id,
              roleId: body.roleId ?? null,
              permissionSetId: body.permissionSetId ?? null,
              scopeType: body.scope.type,
              scopeId: body.scope.id,
              expiresAt,
              justification: body.justification ?? null,
              grantedByType: auth.actor.type,
              grantedBy: auth.actor.id,
              createdAt: now,
            })
            .returning();
          await recordAudit(tx, audit, {
            action: 'binding.create',
            target: { type: 'binding', id: row!.id },
            spaceId: spaceIdOf(resource),
            reason: { decision: request.decision?.reasons ?? [], ...(body.justification ? { justification: body.justification } : {}) },
            changes,
          });
          return row!;
        });
        const [described] = await describeBindings(ctx.db, [created]);
        return reply.status(201).send(described!);
      },
    );

    app.post(
      '/v1/bindings/:bindingId/revoke',
      {
        config: {
          access: {
            kind: 'permission',
            action: async (request) => bindingManageAction((await theBinding(request)).scopeType),
            resource: async (request) => {
              const row = await theBinding(request);
              return scopeResource(ctx.db, ctx.org.id, { type: row.scopeType, id: row.scopeId });
            },
          },
        },
        schema: {
          tags: ['access'],
          summary: 'Revoke a binding. History is kept.',
          params: z.object({ bindingId: z.uuid() }),
          body: z.object({ justification: z.string().trim().min(1).max(500).optional() }).default({}),
          response: { 200: BindingOut },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const row = await theBinding(request);
        const now = ctx.now();
        if (row.revokedAt) throw conflict('already_revoked', 'This binding is already revoked');
        if (row.roleId && SYSTEM_ASSIGNED_ROLES.includes(row.roleId)) {
          throw unprocessable('system_assigned_role', 'This binding is managed by the platform');
        }
        if (row.roleId === 'space.owner' || row.roleId === 'org.owner') {
          const minimum = row.roleId === 'org.owner' ? 1 : ctx.config.MIN_TEAM_SPACE_OWNERS;
          const owners = await ctx.db.$count(
            bindings,
            and(
              eq(bindings.roleId, row.roleId),
              eq(bindings.scopeType, row.scopeType),
              eq(bindings.scopeId, row.scopeId),
              isNull(bindings.revokedAt),
              or(isNull(bindings.expiresAt), gt(bindings.expiresAt, now)),
            ),
          );
          if (owners <= minimum) {
            throw conflict('minimum_owners', `At least ${minimum} owner(s) must remain. Add another owner first.`);
          }
        }
        const resource = await scopeResource(ctx.db, ctx.org.id, { type: row.scopeType, id: row.scopeId });
        const revoked = await ctx.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(bindings)
            .set({ revokedAt: now, revokedByType: auth.actor.type, revokedBy: auth.actor.id })
            .where(and(eq(bindings.id, row.id), isNull(bindings.revokedAt)))
            .returning();
          if (!updated) throw conflict('already_revoked', 'This binding is already revoked');
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
            action: 'binding.revoke',
            target: { type: 'binding', id: row.id },
            spaceId: spaceIdOf(resource),
            reason: request.body.justification ? { justification: request.body.justification } : {},
            changes: {
              before: {
                principalType: row.principalType,
                principalId: row.principalId,
                roleId: row.roleId,
                permissionSetId: row.permissionSetId,
                scope: { type: row.scopeType, id: row.scopeId },
              },
            },
          });
          return updated;
        });
        const [described] = await describeBindings(ctx.db, [revoked]);
        return described!;
      },
    );

    app.post(
      '/v1/access/explain',
      {
        config: { access: { kind: 'permission', action: 'access.binding.read', resource: explainScope } },
        schema: {
          tags: ['access'],
          summary: 'Why can (or can’t) a user do something? Returns the decision and its reasons.',
          body: Explain,
        },
      },
      async (request) => {
        const body = request.body;
        const [user] = await ctx.db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, body.userId), eq(users.orgId, ctx.org.id)));
        if (!user) throw unprocessable('unknown_user', 'No such user');
        const now = ctx.now();
        const principal = await ctx.policy.userPrincipal(user.id, body.assumeFreshMfa ? { mfaAt: now } : {});
        const resource = await explainScope(request);
        const decision = await ctx.policy.authorize(principal, body.action, resource, body.context);
        await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, now), {
          action: 'access.explain',
          target: { type: 'user', id: user.id },
          spaceId: spaceIdOf(resource),
          reason: { action: body.action, allowed: decision.allowed },
        });
        return { userId: user.id, groupIds: principal.groupIds, decision };
      },
    );
  };
}

type Target = { type: 'user' | 'group' | 'service_account'; id: string };

async function loadPrincipal(ctx: AppContext, principal: Target): Promise<Target> {
  if (principal.type === 'user') {
    const [row] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, principal.id), eq(users.orgId, ctx.org.id), eq(users.status, 'active')));
    if (!row) throw unprocessable('unknown_principal', 'No such active user');
  } else if (principal.type === 'service_account') {
    const [row] = await ctx.db
      .select({ id: serviceAccounts.id })
      .from(serviceAccounts)
      .where(and(eq(serviceAccounts.id, principal.id), eq(serviceAccounts.orgId, ctx.org.id), eq(serviceAccounts.status, 'active')));
    if (!row) throw unprocessable('unknown_principal', 'No such active service account');
  } else {
    const [row] = await ctx.db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, principal.id), eq(groups.orgId, ctx.org.id)));
    if (!row) throw unprocessable('unknown_principal', 'No such group');
  }
  return principal;
}

/**
 * The bindings that separation of duties must consider for a target: for a user, their own and
 * their groups'; for a group or a service account, its own. (Conflicts that arise only through a
 * group's members are left to periodic access reviews.)
 */
async function bindingsOfTarget(ctx: AppContext, target: Target): Promise<Binding[]> {
  if (target.type === 'user') {
    const principal: Principal = await ctx.policy.userPrincipal(target.id);
    return ctx.policy.bindingsFor(principal);
  }
  const rows: BindingRow[] = await ctx.db
    .select()
    .from(bindings)
    .where(and(eq(bindings.principalType, target.type), eq(bindings.principalId, target.id), isNull(bindings.revokedAt)));
  return rows.map(toBinding);
}
