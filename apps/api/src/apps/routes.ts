import { appRoleName, AppDefinition, EXPENSE_APP } from '@platform/app-model';
import { appEnvironments, appRevisions, apps, bindings, spaces } from '@platform/db';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { describeBindings, BindingOut } from '../access/describe.js';
import { loadSpace, spaceResource } from '../access/resources.js';
import { once, requireAuth, requireSession, requireUser } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { notFound, unprocessable } from '../errors.js';
import type { AppBuilder } from './builder.js';
import type { LoadedApp } from './catalog.js';
import { appResource } from './resources.js';
import type { AppRuntime } from './runtime.js';
import { AppOut, AppParams, PlanOut } from './schemas.js';
import { describeUi } from './ui.js';

/** An app as the API shows it, with what the caller may do. */
export async function describeApp(ctx: AppContext, runtime: AppRuntime, auth: AuthContext, loaded: LoadedApp): Promise<z.infer<typeof AppOut>> {
  const policy = await runtime.policy(loaded);
  const resource = appResource(ctx.org.id, loaded);
  const can = async (action: string) => (await ctx.policy.authorize(auth.principal, action, resource, undefined, policy)).allowed;
  const [build, run, share] = await Promise.all([can('app.read'), can('app.run'), can('app.share')]);
  const held = await ctx.policy.bindingsFor(auth.principal);
  const roles = held
    .filter((binding) => binding.scope.type === 'env' && binding.scope.id === loaded.env.id && binding.roleId)
    .map((binding) => appRoleName(loaded.app.id, binding.roleId!))
    .filter((name): name is string => name !== null);
  const { app } = loaded;
  return {
    id: app.id,
    spaceId: app.spaceId,
    handle: app.handle,
    name: app.name,
    description: app.description,
    ownerUserId: app.ownerUserId,
    revision: app.currentRevision,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
    access: { build, run, share, roles },
  };
}

/** Every app the caller can build or use: those in their spaces, and those shared with them. */
export async function visibleApps(ctx: AppContext, runtime: AppRuntime, auth: AuthContext): Promise<Array<z.infer<typeof AppOut>>> {
  const held = await ctx.policy.bindingsFor(auth.principal);
  const spaceIds = held.filter((b) => b.scope.type === 'space').map((b) => b.scope.id);
  const envIds = held.filter((b) => b.scope.type === 'env').map((b) => b.scope.id);
  const personal = auth.actor.type === 'user'
    ? await ctx.db.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, auth.actor.id)))
    : [];
  const inSpaces = [...spaceIds, ...personal.map((s) => s.id)];
  const candidates = await ctx.db
    .selectDistinct({ id: apps.id })
    .from(apps)
    .leftJoin(appEnvironments, eq(appEnvironments.appId, apps.id))
    .where(
      and(
        eq(apps.orgId, ctx.org.id),
        eq(apps.status, 'active'),
        or(inSpaces.length ? inArray(apps.spaceId, inSpaces) : undefined, envIds.length ? inArray(appEnvironments.id, envIds) : undefined),
      ),
    );
  const described = await Promise.all(
    candidates.map(async ({ id }) => describeApp(ctx, runtime, auth, await ctx.apps.load(id)).catch(() => null)),
  );
  return described
    .filter((app): app is z.infer<typeof AppOut> => app !== null && (app.access.build || app.access.run))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function appRoutes(ctx: AppContext, builder: AppBuilder, runtime: AppRuntime): FastifyPluginAsyncZod {
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId));
  const asResource = async (request: FastifyRequest) => appResource(ctx.org.id, await theApp(request));
  const policy = async (request: FastifyRequest) => runtime.policy(await theApp(request));
  const appRule = (action: string) => ({ kind: 'permission' as const, action, resource: asResource, policy });

  return async (app) => {
    app.post(
      '/v1/spaces/:spaceId/apps',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'app.create',
            resource: async (request) => spaceResource(ctx.org.id, await loadSpace(ctx.db, ctx.org.id, (request.params as { spaceId: string }).spaceId)),
          },
        },
        schema: {
          tags: ['apps'],
          summary: 'Create an app in your personal space, optionally with a first definition',
          params: z.object({ spaceId: z.uuid() }),
          body: z.object({
            name: z.string().trim().min(1).max(100),
            handle: z.string().optional().describe('A short identifier, unique in the space. Agent tool names start with it.'),
            description: z.string().trim().max(2000).optional(),
            definition: z.unknown().optional(),
          }),
          response: { 201: z.object({ app: AppOut, plan: PlanOut }) },
        },
      },
      async (request, reply) => {
        const auth = requireUser(request);
        const space = await loadSpace(ctx.db, ctx.org.id, request.params.spaceId);
        const { appId, plan } = await builder.create(request, auth, space, {
          name: request.body.name,
          ...(request.body.handle !== undefined ? { handle: request.body.handle } : {}),
          ...(request.body.description !== undefined ? { description: request.body.description } : {}),
          ...(request.body.definition !== undefined ? { definition: request.body.definition } : {}),
        });
        return reply.status(201).send({ app: await describeApp(ctx, runtime, auth, await ctx.apps.load(appId)), plan });
      },
    );

    app.get(
      '/v1/apps',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['apps'], summary: 'Apps you can build or use, including those shared with you', response: { 200: z.object({ apps: z.array(AppOut) }) } },
      },
      async (request) => ({ apps: await visibleApps(ctx, runtime, requireAuth(request)) }),
    );

    app.get(
      '/v1/apps/:appId',
      {
        config: { access: appRule('app.run') },
        schema: { tags: ['apps'], summary: 'One app, and what you may do with it', params: AppParams, response: { 200: AppOut } },
      },
      async (request) => describeApp(ctx, runtime, requireAuth(request), await theApp(request)),
    );

    app.get(
      '/v1/apps/:appId/ui',
      {
        config: { access: appRule('app.run') },
        schema: {
          tags: ['apps'],
          summary: 'What you can use in an app, for screens: entities and fields with your access, forms, actions and queries',
          params: AppParams,
          response: {
            200: z.object({
              app: AppOut,
              entities: z.record(z.string(), z.unknown()),
              forms: z.record(z.string(), z.unknown()),
              actions: z.record(z.string(), z.unknown()),
              queries: z.record(z.string(), z.unknown()),
            }),
          },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        return { app: await describeApp(ctx, runtime, auth, loaded), ...(await describeUi(ctx, runtime, request, auth, loaded)) };
      },
    );

    app.patch(
      '/v1/apps/:appId',
      {
        config: { access: appRule('app.edit') },
        schema: {
          tags: ['apps'],
          summary: "Rename an app or change its description",
          params: AppParams,
          body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(2000).nullable().optional() }),
          response: { 200: AppOut },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        const changes = {
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.description !== undefined ? { description: request.body.description } : {}),
        };
        const now = ctx.now();
        await ctx.db.transaction(async (tx) => {
          await tx.update(apps).set({ ...changes, updatedAt: now }).where(eq(apps.id, loaded.app.id));
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
            action: 'app.update',
            target: { type: 'app', id: loaded.app.id, name: loaded.app.name },
            spaceId: loaded.space.id,
            appId: loaded.app.id,
            changes: { before: { name: loaded.app.name, description: loaded.app.description }, after: changes },
          });
        });
        return describeApp(ctx, runtime, auth, await ctx.apps.load(loaded.app.id));
      },
    );

    app.delete(
      '/v1/apps/:appId',
      {
        config: { access: appRule('app.delete') },
        schema: {
          tags: ['apps'],
          summary: 'Delete an app and all its data. Type its name to confirm',
          params: AppParams,
          body: z.object({ confirm: z.string() }),
        },
      },
      async (request, reply) => {
        const auth = requireSession(request);
        const loaded = await theApp(request);
        if (request.body.confirm !== loaded.app.name) throw unprocessable('confirmation_mismatch', `Type the app's name, ${loaded.app.name}, to confirm`);
        await builder.remove(request, auth, loaded);
        return reply.status(204).send();
      },
    );

    app.get(
      '/v1/apps/:appId/definition',
      {
        config: { access: appRule('app.read') },
        schema: {
          tags: ['apps'],
          summary: "The app's current definition: entities, rules, actions, queries, cards and roles",
          params: AppParams,
          response: { 200: z.object({ revision: z.number().int(), definition: z.record(z.string(), z.unknown()) }) },
        },
      },
      async (request, reply) => {
        const loaded = await theApp(request);
        reply.header('etag', `"${loaded.app.currentRevision}"`);
        return { revision: loaded.app.currentRevision, definition: loaded.definition as unknown as Record<string, unknown> };
      },
    );

    const DefinitionBody = z.object({
      definition: z.unknown(),
      baseRevision: z.number().int().positive().optional().describe('The revision you edited. The save is refused if the app has moved on.'),
    });
    const baseRevisionOf = (request: FastifyRequest, body: z.infer<typeof DefinitionBody>) => {
      const ifMatch = request.headers['if-match'];
      const fromHeader = typeof ifMatch === 'string' ? Number(ifMatch.replaceAll('"', '').replace(/^W\//, '')) : undefined;
      return body.baseRevision ?? (Number.isInteger(fromHeader) ? fromHeader : undefined);
    };

    app.post(
      '/v1/apps/:appId/definition/plan',
      {
        config: { access: appRule('app.edit') },
        schema: {
          tags: ['apps'],
          summary: 'Check a new definition and see what saving it would do, without saving',
          params: AppParams,
          body: DefinitionBody,
          response: { 200: z.object({ plan: PlanOut, definition: z.record(z.string(), z.unknown()) }) },
        },
      },
      async (request) => {
        const { definition, plan } = await builder.plan(await theApp(request), request.body.definition);
        return { plan, definition: definition as unknown as Record<string, unknown> };
      },
    );

    app.put(
      '/v1/apps/:appId/definition',
      {
        config: { access: appRule('app.edit') },
        schema: {
          tags: ['apps'],
          summary: "Save a new definition. In a personal sandbox it applies at once; a change that deletes data needs confirmDestructive",
          params: AppParams,
          querystring: z.object({ confirmDestructive: z.enum(['true', 'false']).optional() }),
          body: DefinitionBody,
          response: { 200: z.object({ plan: PlanOut }) },
        },
      },
      async (request) => {
        const plan = await builder.save(request, requireAuth(request), await theApp(request), request.body.definition, {
          ...(baseRevisionOf(request, request.body) !== undefined ? { baseRevision: baseRevisionOf(request, request.body)! } : {}),
          confirmDestructive: request.query.confirmDestructive === 'true',
        });
        return { plan };
      },
    );

    app.get(
      '/v1/apps/:appId/revisions',
      {
        config: { access: appRule('app.read') },
        schema: {
          tags: ['apps'],
          summary: "The app's saved definitions, newest first",
          params: AppParams,
          response: {
            200: z.object({
              revisions: z.array(
                z.object({
                  revision: z.number().int(),
                  digest: z.string(),
                  createdBy: z.object({ type: z.string(), id: z.uuid().nullable() }),
                  createdAt: z.string(),
                  summary: z.unknown(),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        const rows = await ctx.db
          .select({ revision: appRevisions.revision, digest: appRevisions.digest, type: appRevisions.createdByType, id: appRevisions.createdBy, at: appRevisions.createdAt, summary: appRevisions.summary })
          .from(appRevisions)
          .where(eq(appRevisions.appId, loaded.app.id))
          .orderBy(desc(appRevisions.revision))
          .limit(200);
        return {
          revisions: rows.map((row) => ({ revision: row.revision, digest: row.digest, createdBy: { type: row.type, id: row.id }, createdAt: row.at.toISOString(), summary: row.summary })),
        };
      },
    );

    app.get(
      '/v1/apps/:appId/revisions/:revision',
      {
        config: { access: appRule('app.read') },
        schema: {
          tags: ['apps'],
          summary: 'One saved definition',
          params: AppParams.extend({ revision: z.coerce.number().int().positive() }),
          response: { 200: z.object({ revision: z.number().int(), definition: z.record(z.string(), z.unknown()) }) },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        if (request.params.revision > loaded.app.currentRevision) throw notFound('Revision');
        const definition = await ctx.apps.definition(loaded.app.id, request.params.revision);
        return { revision: request.params.revision, definition: definition as unknown as Record<string, unknown> };
      },
    );

    app.get(
      '/v1/apps/:appId/shares',
      {
        config: { access: appRule('app.share') },
        schema: { tags: ['apps'], summary: 'Who the app is shared with, and in which role', params: AppParams, response: { 200: z.object({ shares: z.array(BindingOut) }) } },
      },
      async (request) => {
        const loaded = await theApp(request);
        const rows = await ctx.db
          .select()
          .from(bindings)
          .where(and(eq(bindings.scopeType, 'env'), eq(bindings.scopeId, loaded.env.id), isNull(bindings.revokedAt), isNotNull(bindings.appRoleId)));
        return { shares: await describeBindings(ctx.db, rows) };
      },
    );

    app.post(
      '/v1/apps/:appId/shares',
      {
        config: { access: appRule('app.share') },
        schema: {
          tags: ['apps'],
          summary: 'Share the app with a colleague, in one of its roles',
          params: AppParams,
          body: z
            .object({ email: z.email().optional(), userId: z.uuid().optional(), role: z.string().min(1), expiresAt: z.iso.datetime().optional() })
            .refine((body) => (body.email === undefined) !== (body.userId === undefined), 'Give either email or userId'),
          response: { 201: BindingOut },
        },
      },
      async (request, reply) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        const { email, userId, role, expiresAt } = request.body;
        const bindingId = await builder.share(request, auth, loaded, {
          role,
          ...(email ? { email } : {}),
          ...(userId ? { userId } : {}),
          ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
        });
        const rows = await ctx.db.select().from(bindings).where(eq(bindings.id, bindingId));
        return reply.status(201).send((await describeBindings(ctx.db, rows))[0]!);
      },
    );

    app.delete(
      '/v1/apps/:appId/shares/:bindingId',
      {
        config: { access: appRule('app.share') },
        schema: { tags: ['apps'], summary: 'Stop sharing the app with someone', params: AppParams.extend({ bindingId: z.uuid() }) },
      },
      async (request, reply) => {
        await builder.unshare(request, requireAuth(request), await theApp(request), request.params.bindingId);
        return reply.status(204).send();
      },
    );

    app.get(
      '/v1/app-model/schema',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['apps'],
          summary: 'The app definition format as JSON Schema, with a complete example',
          response: { 200: z.object({ schema: z.unknown(), example: z.unknown() }) },
        },
      },
      async () => ({ schema: definitionJsonSchema(), example: EXPENSE_APP }),
    );
  };
}

let cachedSchema: unknown;
/** The definition format as JSON Schema. Conditions are described in prose, as JSON Schema can't express them well. */
export function definitionJsonSchema(): unknown {
  cachedSchema ??= z.toJSONSchema(AppDefinition, { unrepresentable: 'any', io: 'input' });
  return cachedSchema;
}
