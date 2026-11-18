import { AppDefinition, appRoleName, EXPENSE_APP, NAME_PATTERN } from '@platform/app-model';
import type { Decision, Resource } from '@platform/authz';
import { appEnvironments, appRevisions, apps, bindings, changeRequests, type Executor, releases, spaces } from '@platform/db';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkAnyPermission } from '../access/check.js';
import { BindingOut, describeBindings } from '../access/describe.js';
import { loadSpace, spaceResource } from '../access/resources.js';
import { once, requireAuth, requireSession, requireUser } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { HttpError, notFound, unprocessable } from '../errors.js';
import { type AppBuilder, changeRequestRequired } from './builder.js';
import { type AppRef, type EnvironmentRow, envSelector, isLoaded, isTeamApp, type LoadedApp } from './catalog.js';
import { appResource, environmentResource } from './resources.js';
import type { AppRuntime } from './runtime.js';
import { AppOut, AppParams, type EnvironmentOut, EnvQuery, PlanOut, TestsOut } from './schemas.js';
import { describeUi } from './ui.js';

type AppOutput = z.infer<typeof AppOut>;
type EnvironmentOutput = z.infer<typeof EnvironmentOut>;

/** Stands for "no author", so the separation-of-duties guardrail can be asked about a role alone. */
export const NO_AUTHOR = '00000000-0000-0000-0000-000000000000';

/** True if the policy allows, or would once the caller signs in again with MFA. */
export const permits = (decision: Decision): boolean =>
  decision.allowed || (decision.reasons.length > 0 && decision.reasons.every((reason) => reason.kind === 'step_up_required'));

/** Environments as the API shows them, with the numbers of their releases and change requests. */
export async function describeEnvironments(db: Executor, rows: readonly EnvironmentRow[]): Promise<EnvironmentOutput[]> {
  const releaseIds = rows.flatMap((row) => (row.activeReleaseId ? [row.activeReleaseId] : []));
  const requestIds = rows.flatMap((row) => (row.changeRequestId ? [row.changeRequestId] : []));
  const numbers = new Map<string, number>();
  if (releaseIds.length) {
    for (const row of await db.select({ id: releases.id, number: releases.number }).from(releases).where(inArray(releases.id, releaseIds)))
      numbers.set(row.id, row.number);
  }
  if (requestIds.length) {
    for (const row of await db
      .select({ id: changeRequests.id, number: changeRequests.number })
      .from(changeRequests)
      .where(inArray(changeRequests.id, requestIds))) {
      numbers.set(row.id, row.number);
    }
  }
  const order = { prod: 0, staging: 1, preview: 2, sandbox: 3 } as const;
  return [...rows]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      revision: row.activeRevision,
      release: row.activeReleaseId ? { id: row.activeReleaseId, number: numbers.get(row.activeReleaseId)! } : null,
      changeRequest: row.changeRequestId ? { id: row.changeRequestId, number: numbers.get(row.changeRequestId)! } : null,
    }));
}

/** The app in its default environment (the sandbox, or Prod of a team app), or just the app if that isn't live yet. */
async function defaultView(ctx: AppContext, ref: AppRef): Promise<AppRef | LoadedApp> {
  const env = await ctx.apps.environment(ref, 'default');
  return env ? ctx.apps.load(ref.app.id, { id: env.id }) : ref;
}

/** An app as the API shows it, with what the caller may do. `selected` is the environment asked about, if any. */
export async function describeApp(ctx: AppContext, runtime: AppRuntime, auth: AuthContext, ref: AppRef, selected?: LoadedApp): Promise<AppOutput> {
  const team = isTeamApp(ref);
  const view = selected ?? (await defaultView(ctx, ref));
  const loaded = isLoaded(view) ? view : undefined;
  const policy = loaded ? await runtime.policy(loaded) : await ctx.policy.policy();
  const onApp = appResource(ctx.org.id, view);
  const can = async (action: string, resource: Resource = onApp, context?: Record<string, unknown>) =>
    permits(await ctx.policy.authorize(auth.principal, action, resource, context, policy));

  const envRows = team
    ? await ctx.db
        .select()
        .from(appEnvironments)
        .where(and(eq(appEnvironments.appId, ref.app.id), eq(appEnvironments.status, 'active'), ne(appEnvironments.kind, 'preview')))
    : [];
  const environments = team ? await describeEnvironments(ctx.db, envRows) : undefined;
  const [environment] = loaded ? await describeEnvironments(ctx.db, [loaded.env]) : [null];

  // A team app's users may hold its roles in Staging only, so ask each environment that runs.
  const runIn = async (): Promise<boolean> => {
    if (loaded && loaded.env.kind !== 'prod' && (await can('app.run'))) return true;
    for (const row of envRows) {
      const inEnv = await ctx.apps.load(ref.app.id, { id: row.id });
      if (permits(await ctx.policy.authorize(auth.principal, 'app.run', appResource(ctx.org.id, inEnv), undefined, await runtime.policy(inEnv)))) return true;
    }
    return false;
  };
  const [build, run, edit, share, compose] = await Promise.all([
    can('app.read'),
    team ? runIn() : loaded ? can('app.run') : false,
    can('app.edit'),
    can(team ? 'env.binding.manage' : 'app.share'),
    // A team app changes through a working copy, where the chat works too.
    team ? false : can('app.compose'),
  ]);
  const held = await ctx.policy.bindingsFor(auth.principal);
  const roles = loaded
    ? held
        .filter((binding) => binding.scope.type === 'env' && binding.scope.id === loaded.env.id && binding.roleId)
        .map((binding) => appRoleName(ref.app.id, binding.roleId!))
        .filter((name): name is string => name !== null)
    : [];

  let delivery: AppOutput['access']['delivery'];
  if (team) {
    const prodRow = envRows.find((row) => row.kind === 'prod');
    const prod = environmentResource(ctx.org.id, ref, 'prod', prodRow);
    const sod = { authorId: NO_AUTHOR };
    const [review, approve, merge, release, deploy, approveDeploy, execute, rollback] = await Promise.all([
      can('change.review'),
      can('change.approve', onApp, sod),
      can('change.merge'),
      can('release.create'),
      can('deploy.request', prod),
      can('deploy.approve', prod, sod),
      can('deploy.execute', prod),
      can('deploy.rollback', prod),
    ]);
    delivery = { review, approve, merge, release, deploy, approveDeploy, execute, rollback, manageAccess: share };
  }

  let workingCopyOf: AppOutput['workingCopyOf'] = null;
  if (ref.app.workingCopyOf) {
    const [teamApp] = await ctx.db
      .select({ id: apps.id, name: apps.name, revision: apps.currentRevision })
      .from(apps)
      .where(eq(apps.id, ref.app.workingCopyOf));
    const [open] = await ctx.db
      .select({ id: changeRequests.id, number: changeRequests.number })
      .from(changeRequests)
      .where(and(eq(changeRequests.workingCopyId, ref.app.id), eq(changeRequests.status, 'open')));
    if (teamApp) {
      workingCopyOf = {
        appId: teamApp.id,
        name: teamApp.name,
        baseRevision: ref.app.baseRevision!,
        behind: teamApp.revision !== ref.app.baseRevision,
        changeRequest: open ?? null,
      };
    }
  }
  let myWorkingCopyId: string | null | undefined;
  if (team) {
    const [copy] =
      auth.actor.type === 'user'
        ? await ctx.db
            .select({ id: apps.id })
            .from(apps)
            .where(and(eq(apps.workingCopyOf, ref.app.id), eq(apps.ownerUserId, auth.actor.id), eq(apps.status, 'active')))
        : [];
    myWorkingCopyId = copy?.id ?? null;
  }

  // Where a personal app went, or is going: a promotion to a team space (design §3).
  let movedTo: AppOutput['movedTo'];
  let promotion: AppOutput['promotion'];
  if (!team) {
    movedTo = null;
    promotion = null;
    if (ref.app.movedTo) {
      const [to] = await ctx.db.select({ appId: apps.id, name: apps.name }).from(apps).where(eq(apps.id, ref.app.movedTo));
      movedTo = to ?? null;
    } else {
      const [to] = await ctx.db
        .select({ appId: apps.id, name: apps.name })
        .from(apps)
        .where(and(eq(apps.promotedFrom, ref.app.id), eq(apps.status, 'active')));
      if (to) {
        const [cr] = await ctx.db
          .select({ id: changeRequests.id, number: changeRequests.number, status: changeRequests.status })
          .from(changeRequests)
          .where(eq(changeRequests.appId, to.appId))
          .orderBy(desc(changeRequests.number))
          .limit(1);
        promotion = { ...to, changeRequest: cr ?? null };
      }
    }
  }

  const { app } = ref;
  return {
    id: app.id,
    spaceId: app.spaceId,
    kind: team ? 'team' : 'personal',
    handle: app.handle,
    name: app.name,
    description: app.description,
    ownerUserId: app.ownerUserId,
    revision: app.currentRevision,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
    environment: environment ?? null,
    ...(environments ? { environments } : {}),
    workingCopyOf,
    ...(myWorkingCopyId !== undefined ? { myWorkingCopyId } : {}),
    ...(movedTo !== undefined ? { movedTo, promotion } : {}),
    ...(team ? { promotedFrom: app.promotedFrom } : {}),
    access: { build, run, share, edit, compose, roles, ...(delivery ? { delivery } : {}) },
  };
}

/** Every app the caller can build or use: those in their spaces, and those shared with them. */
export async function visibleApps(ctx: AppContext, runtime: AppRuntime, auth: AuthContext): Promise<AppOutput[]> {
  const held = await ctx.policy.bindingsFor(auth.principal);
  const spaceIds = held.filter((b) => b.scope.type === 'space').map((b) => b.scope.id);
  const envIds = held.filter((b) => b.scope.type === 'env').map((b) => b.scope.id);
  const personal =
    auth.actor.type === 'user'
      ? await ctx.db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, auth.actor.id)))
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
  const described = await Promise.all(candidates.map(async ({ id }) => describeApp(ctx, runtime, auth, await ctx.apps.ref(id)).catch(() => null)));
  return described.filter((app): app is AppOutput => app !== null && (app.access.build || app.access.run)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The environment a request names with `?env=`: Prod, Staging or a preview's ID. */
export const envOf = (request: FastifyRequest) => envSelector((request.query as { env?: string } | undefined)?.env);

export function appRoutes(ctx: AppContext, builder: AppBuilder, runtime: AppRuntime): FastifyPluginAsyncZod {
  const theRef = (request: FastifyRequest) => once(request, 'ref', () => ctx.apps.ref((request.params as { appId: string }).appId));
  /** The app in the environment the request names: its runtime. */
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  /** The app in its default environment if that is live, else the app alone: for describing it. */
  const theView = (request: FastifyRequest) => once(request, 'view', async () => defaultView(ctx, await theRef(request)));
  const viewPolicy = async (request: FastifyRequest) => {
    const view = await theView(request);
    return isLoaded(view) ? runtime.policy(view) : ctx.policy.policy();
  };
  /** Building checks the app itself: a team app's definition is its main line, whichever environment runs what. */
  const buildRule = (action: string) => ({
    kind: 'permission' as const,
    action,
    resource: async (request: FastifyRequest) => appResource(ctx.org.id, await theRef(request)),
  });
  const runRule = (action: string) => ({
    kind: 'permission' as const,
    action,
    resource: async (request: FastifyRequest) => appResource(ctx.org.id, await theApp(request)),
    policy: async (request: FastifyRequest) => runtime.policy(await theApp(request)),
  });
  /** A personal app is shared with people; a team app's environments are granted to people and groups by space admins. */
  const accessRule = {
    kind: 'permission' as const,
    action: async (request: FastifyRequest) => (isTeamApp(await theRef(request)) ? 'env.binding.manage' : 'app.share'),
    resource: async (request: FastifyRequest) => appResource(ctx.org.id, await theApp(request)),
    policy: async (request: FastifyRequest) => runtime.policy(await theApp(request)),
  };
  /** The sandbox of a personal app or working copy, which saving changes. A team app has none to change. */
  const sandboxOf = async (request: FastifyRequest): Promise<LoadedApp> => {
    const ref = await theRef(request);
    if (isTeamApp(ref)) throw changeRequestRequired(ref);
    return ctx.apps.load(ref.app.id);
  };

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
          summary: 'Create an app: in your personal space, optionally with a first definition; or, empty, in a team space',
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
        return reply.status(201).send({ app: await describeApp(ctx, runtime, auth, await ctx.apps.ref(appId)), plan });
      },
    );

    app.get(
      '/v1/apps',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['apps'],
          summary: 'Apps you can build or use, including those shared with you',
          response: { 200: z.object({ apps: z.array(AppOut) }) },
        },
      },
      async (request) => ({ apps: await visibleApps(ctx, runtime, requireAuth(request)) }),
    );

    app.get(
      '/v1/apps/:appId',
      {
        // Builders read a team app, and its users run it, in Prod or maybe only in Staging. describeApp
        // asks each environment, so the check is the handler's: anyone with neither is refused below.
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['apps'], summary: 'One app, and what you may do with it', params: AppParams, response: { 200: AppOut } },
      },
      async (request) => {
        const auth = requireAuth(request);
        const described = await describeApp(ctx, runtime, auth, await theRef(request));
        if (!described.access.build && !described.access.run) {
          // The same audited refusal an access rule gives.
          await checkAnyPermission(ctx, request, auth, ['app.read', 'app.run'], appResource(ctx.org.id, await theView(request)), {
            policy: await viewPolicy(request),
          });
        }
        return described;
      },
    );

    app.get(
      '/v1/apps/:appId/ui',
      {
        config: { access: runRule('app.run') },
        schema: {
          tags: ['apps'],
          summary: 'What you can use in an app, for screens: entities and fields with your access, forms, actions and queries',
          params: AppParams,
          querystring: EnvQuery,
          response: {
            200: z.object({
              app: AppOut,
              entities: z.record(z.string(), z.unknown()),
              forms: z.record(z.string(), z.unknown()),
              actions: z.record(z.string(), z.unknown()),
              queries: z.record(z.string(), z.unknown()),
              /** The pages you may use, with the columns and buttons that are yours. */
              pages: z.record(z.string(), z.unknown()),
              /** The app's menu as yours, or null for the default: every form and list you may use. */
              navigation: z.object({ home: z.string().nullable(), items: z.array(z.record(z.string(), z.string())) }).nullable(),
            }),
          },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        return { app: await describeApp(ctx, runtime, auth, loaded, loaded), ...(await describeUi(ctx, runtime, request, auth, loaded)) };
      },
    );

    app.patch(
      '/v1/apps/:appId',
      {
        config: { access: buildRule('app.edit') },
        schema: {
          tags: ['apps'],
          summary: 'Rename an app or change its description',
          params: AppParams,
          body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(2000).nullable().optional() }),
          response: { 200: AppOut },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const ref = await theRef(request);
        const changes = {
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.description !== undefined ? { description: request.body.description } : {}),
        };
        const now = ctx.now();
        await ctx.db.transaction(async (tx) => {
          await tx
            .update(apps)
            .set({ ...changes, updatedAt: now })
            .where(eq(apps.id, ref.app.id));
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
            action: 'app.update',
            target: { type: 'app', id: ref.app.id, name: ref.app.name },
            spaceId: ref.space.id,
            appId: ref.app.id,
            changes: { before: { name: ref.app.name, description: ref.app.description }, after: changes },
          });
        });
        return describeApp(ctx, runtime, auth, await ctx.apps.ref(ref.app.id));
      },
    );

    app.delete(
      '/v1/apps/:appId',
      {
        config: { access: buildRule('app.delete') },
        schema: {
          tags: ['apps'],
          summary: 'Delete an app and all its data. Type its name to confirm',
          params: AppParams,
          body: z.object({ confirm: z.string() }),
        },
      },
      async (request, reply) => {
        const auth = requireSession(request);
        const ref = await theRef(request);
        if (request.body.confirm !== ref.app.name) throw unprocessable('confirmation_mismatch', `Type the app's name, ${ref.app.name}, to confirm`);
        if (isTeamApp(ref)) throw unprocessable('team_app_delete', 'Team apps cannot be deleted yet. A space owner can freeze the space instead.');
        await builder.remove(request, auth, await ctx.apps.load(ref.app.id));
        return reply.status(204).send();
      },
    );

    app.get(
      '/v1/apps/:appId/definition',
      {
        config: { access: buildRule('app.read') },
        schema: {
          tags: ['apps'],
          summary: "The app's current definition: entities, rules, actions, queries, cards and roles. For a team app, its main line",
          params: AppParams,
          response: { 200: z.object({ revision: z.number().int(), definition: z.record(z.string(), z.unknown()) }) },
        },
      },
      async (request, reply) => {
        const ref = await theRef(request);
        reply.header('etag', `"${ref.app.currentRevision}"`);
        return { revision: ref.app.currentRevision, definition: (await ctx.apps.mainDefinition(ref)) as unknown as Record<string, unknown> };
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
      '/v1/apps/:appId/tests/run',
      {
        config: { access: buildRule('app.edit') },
        schema: {
          tags: ['apps'],
          summary: "Run the app's saved tests, each in a transaction that is undone: in the sandbox, or in the environment the request names",
          params: AppParams,
          querystring: EnvQuery,
          body: z.strictObject({ only: z.array(z.string().regex(NAME_PATTERN)).max(100).optional() }),
          response: { 200: TestsOut },
        },
      },
      async (request) => {
        const results = await runtime.runTests(request, await theApp(request), request.body.only);
        return { passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results };
      },
    );

    app.post(
      '/v1/apps/:appId/definition/plan',
      {
        config: { access: buildRule('app.edit') },
        schema: {
          tags: ['apps'],
          summary: 'Check a new definition and see what saving it would do, without saving',
          params: AppParams,
          body: DefinitionBody,
          response: { 200: z.object({ plan: PlanOut, definition: z.record(z.string(), z.unknown()) }) },
        },
      },
      async (request) => {
        const { definition, plan } = await builder.plan(await sandboxOf(request), request.body.definition);
        return { plan, definition: definition as unknown as Record<string, unknown> };
      },
    );

    app.put(
      '/v1/apps/:appId/definition',
      {
        config: { access: buildRule('app.edit') },
        schema: {
          tags: ['apps'],
          summary:
            'Save a new definition. In a personal sandbox it applies at once; a change that deletes data needs confirmDestructive. Team apps change through change requests',
          params: AppParams,
          querystring: z.object({ confirmDestructive: z.enum(['true', 'false']).optional() }),
          body: DefinitionBody,
          response: { 200: z.object({ plan: PlanOut }) },
        },
      },
      async (request) => {
        const plan = await builder.save(request, requireAuth(request), await sandboxOf(request), request.body.definition, {
          ...(baseRevisionOf(request, request.body) !== undefined ? { baseRevision: baseRevisionOf(request, request.body)! } : {}),
          confirmDestructive: request.query.confirmDestructive === 'true',
        });
        return { plan };
      },
    );

    app.get(
      '/v1/apps/:appId/revisions',
      {
        config: { access: buildRule('app.read') },
        schema: {
          tags: ['apps'],
          summary: "The app's saved definitions on its main line, newest first",
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
        const ref = await theRef(request);
        const rows = await ctx.db
          .select({
            revision: appRevisions.revision,
            digest: appRevisions.digest,
            type: appRevisions.createdByType,
            id: appRevisions.createdBy,
            at: appRevisions.createdAt,
            summary: appRevisions.summary,
          })
          .from(appRevisions)
          .where(and(eq(appRevisions.appId, ref.app.id), isNull(appRevisions.changeRequestId)))
          .orderBy(desc(appRevisions.revision))
          .limit(200);
        return {
          revisions: rows.map((row) => ({
            revision: row.revision,
            digest: row.digest,
            createdBy: { type: row.type, id: row.id },
            createdAt: row.at.toISOString(),
            summary: row.summary,
          })),
        };
      },
    );

    app.get(
      '/v1/apps/:appId/revisions/:revision',
      {
        config: { access: buildRule('app.read') },
        schema: {
          tags: ['apps'],
          summary: 'One saved definition: of the main line, or the head of a change request',
          params: AppParams.extend({ revision: z.coerce.number().int().positive() }),
          response: { 200: z.object({ revision: z.number().int(), definition: z.record(z.string(), z.unknown()) }) },
        },
      },
      async (request) => {
        const ref = await theRef(request);
        const [row] = await ctx.db
          .select({ revision: appRevisions.revision })
          .from(appRevisions)
          .where(and(eq(appRevisions.appId, ref.app.id), eq(appRevisions.revision, request.params.revision)));
        if (!row) throw notFound('Revision');
        const definition = await ctx.apps.definition(ref.app.id, request.params.revision);
        return { revision: request.params.revision, definition: definition as unknown as Record<string, unknown> };
      },
    );

    app.get(
      '/v1/apps/:appId/shares',
      {
        config: { access: accessRule },
        schema: {
          tags: ['apps'],
          summary: "Who holds the app's roles: for a personal app, who it is shared with; for a team app, who may use the environment",
          params: AppParams,
          querystring: EnvQuery,
          response: { 200: z.object({ shares: z.array(BindingOut) }) },
        },
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
        config: { access: accessRule },
        schema: {
          tags: ['apps'],
          summary: "Give a colleague (or, in a team app, a group) one of the app's roles",
          params: AppParams,
          querystring: EnvQuery,
          body: z
            .object({
              email: z.email().optional(),
              userId: z.uuid().optional(),
              groupId: z.uuid().optional(),
              role: z.string().min(1),
              expiresAt: z.iso.datetime().optional(),
            })
            .refine((body) => [body.email, body.userId, body.groupId].filter((v) => v !== undefined).length === 1, 'Give one of email, userId or groupId'),
          response: { 201: BindingOut },
        },
      },
      async (request, reply) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        const { email, userId, groupId, role, expiresAt } = request.body;
        const bindingId = await builder.share(request, auth, loaded, {
          role,
          ...(email ? { email } : {}),
          ...(userId ? { userId } : {}),
          ...(groupId ? { groupId } : {}),
          ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
        });
        const rows = await ctx.db.select().from(bindings).where(eq(bindings.id, bindingId));
        return reply.status(201).send((await describeBindings(ctx.db, rows))[0]!);
      },
    );

    app.delete(
      '/v1/apps/:appId/shares/:bindingId',
      {
        config: { access: accessRule },
        schema: { tags: ['apps'], summary: 'Take a role away again', params: AppParams.extend({ bindingId: z.uuid() }), querystring: EnvQuery },
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

/** For handlers that must tell "not live yet" apart from other errors. */
export const isNotLive = (error: unknown): boolean => error instanceof HttpError && error.code === 'not_live';
