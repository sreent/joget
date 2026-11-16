import { appEnvironments, changeRequests, deployments, releases } from '@platform/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkPermission } from '../access/check.js';
import { once, requireAuth, requireUser } from '../access/rules.js';
import { isTeamApp, type AppRef } from '../apps/catalog.js';
import { appResource, environmentResource } from '../apps/resources.js';
import { describeApp, describeEnvironments, NO_AUTHOR } from '../apps/routes.js';
import type { AppRuntime } from '../apps/runtime.js';
import { AppOut, AppParams, EnvironmentOut, PlanOut } from '../apps/schemas.js';
import type { AppContext } from '../context.js';
import { unprocessable } from '../errors.js';
import type { ChangeRequestRow, Delivery, DeploymentRow, ReleaseRow } from './service.js';

const PersonRef = z.object({ id: z.uuid(), name: z.string() });
const StepOut = z.object({ kind: z.string(), description: z.string(), destructive: z.boolean(), records: z.number().int().optional() });

const ChangeRequestSummaryOut = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  status: z.enum(['open', 'merged', 'closed']),
  author: PersonRef,
  baseRevision: z.number().int(),
  headRevision: z.number().int(),
  mergedRevision: z.number().int().nullable(),
  /** True if Prod would lose data to this change. */
  destructive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ChecksOut = z.object({
  validation: z.object({ ok: z.boolean(), notes: z.array(z.string()) }),
  migration: z.object({ destructive: z.boolean(), steps: z.array(StepOut) }),
  access: z.array(z.object({ role: z.string(), kind: z.enum(['gains', 'loses', 'changes']), text: z.string(), holders: z.number().int() })),
  capabilities: z.array(z.object({ tool: z.string(), change: z.enum(['added', 'removed', 'changed']), text: z.string() })),
  lint: z.array(z.string()),
});

const ChangeRequestOut = ChangeRequestSummaryOut.extend({
  description: z.string().nullable(),
  workingCopyId: z.uuid().nullable(),
  headDigest: z.string(),
  checks: ChecksOut,
  /** What the change does, artifact by artifact. */
  changes: z.array(
    z.object({
      section: z.string(),
      name: z.string(),
      change: z.enum(['added', 'removed', 'changed']),
      from: z.string().optional(),
      details: z.array(z.string()),
    }),
  ),
  /** True when the main line moved on since the change began; conflicts, if any, block the merge. */
  behind: z.boolean(),
  conflicts: z.array(z.object({ section: z.string(), name: z.string(), ours: z.string(), theirs: z.string() })),
  reviews: z.array(
    z.object({
      id: z.uuid(),
      reviewer: PersonRef,
      verdict: z.enum(['approve', 'request_changes', 'comment']),
      comment: z.string().nullable(),
      createdAt: z.string(),
      /** False for a review of an earlier version of the change. */
      current: z.boolean(),
    }),
  ),
  approvals: z.object({ required: z.number().int(), approvedBy: z.array(PersonRef), changesRequestedBy: z.array(PersonRef), ready: z.boolean() }),
  /** The preview reviewers click through, while the change is open. */
  preview: z.object({ environmentId: z.uuid() }).nullable(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});

const ReleaseOut = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  number: z.number().int(),
  revision: z.number().int(),
  digest: z.string(),
  destructive: z.boolean(),
  notes: z.string().nullable(),
  changes: z.array(z.object({ id: z.uuid(), number: z.number().int(), title: z.string(), author: PersonRef })),
  steps: z.array(StepOut),
  createdBy: PersonRef.nullable(),
  createdAt: z.string(),
  manifestDigest: z.string(),
  keyId: z.string(),
  /** True if the release is as it was signed. */
  verified: z.boolean(),
  /** Where it runs now. */
  liveIn: z.array(z.enum(['staging', 'prod'])),
});

const DeploymentOut = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  environment: z.enum(['staging', 'prod']),
  kind: z.enum(['deploy', 'rollback']),
  status: z.enum(['awaiting_approval', 'approved', 'succeeded', 'failed', 'cancelled']),
  release: z.object({ id: z.uuid(), number: z.number().int() }),
  fromRelease: z.object({ id: z.uuid(), number: z.number().int() }).nullable(),
  destructive: z.boolean(),
  plan: z.object({ steps: z.array(StepOut), notes: z.array(z.string()) }),
  approvals: z.object({ required: z.number().int(), by: z.array(PersonRef) }),
  /** People whose changes it carries: they cannot approve it. */
  authors: z.array(PersonRef),
  requestedBy: PersonRef.nullable(),
  requestedAt: z.string(),
  executedBy: PersonRef.nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
});

const CrParams = z.object({ changeRequestId: z.uuid() });
const DeploymentParams = z.object({ deploymentId: z.uuid() });
const EnvKind = z.enum(['staging', 'prod']);

type PersonNames = Map<string, string>;
const person = (names: PersonNames, id: string | null) => (id ? { id, name: names.get(id) ?? 'Someone' } : null);

/** Governed delivery for team apps: working copies, change requests, releases, deployments (design §6.7, §7.1). */
export function deliveryRoutes(ctx: AppContext, delivery: Delivery, runtime: AppRuntime): FastifyPluginAsyncZod {
  const theRef = (request: FastifyRequest) => once(request, 'ref', () => ctx.apps.ref((request.params as { appId: string }).appId));
  const theTeamApp = async (request: FastifyRequest): Promise<AppRef> => {
    const ref = await theRef(request);
    if (!isTeamApp(ref)) throw unprocessable('not_a_team_app', `${ref.app.name} is a personal app: it changes live, without change requests`);
    return ref;
  };
  /** A working copy and the team app it changes. */
  const theCopy = (request: FastifyRequest) =>
    once(request, 'copy', async () => {
      const copy = await theRef(request);
      if (!copy.app.workingCopyOf) throw unprocessable('not_a_working_copy', `${copy.app.name} is not a working copy of a team app`);
      return { copy, team: await ctx.apps.ref(copy.app.workingCopyOf) };
    });
  const theCr = (request: FastifyRequest) => once(request, 'cr', () => delivery.changeRequest((request.params as { changeRequestId: string }).changeRequestId));
  const crTeam = (request: FastifyRequest) => once(request, 'crTeam', async () => ctx.apps.ref((await theCr(request)).appId));
  const theDeployment = (request: FastifyRequest) => once(request, 'deployment', () => delivery.deployment((request.params as { deploymentId: string }).deploymentId));
  const deploymentResource = async (request: FastifyRequest) => {
    const deployment = await theDeployment(request);
    const team = await ctx.apps.ref(deployment.appId);
    return environmentResource(ctx.org.id, team, deployment.environmentKind, await ctx.apps.environment(team, deployment.environmentKind));
  };
  const onTeamApp = (action: string | readonly string[]) => ({
    kind: 'permission' as const,
    action,
    resource: async (request: FastifyRequest) => appResource(ctx.org.id, await theTeamApp(request)),
  });
  const onCr = (action: string) => ({ kind: 'permission' as const, action, resource: async (request: FastifyRequest) => appResource(ctx.org.id, await crTeam(request)) });

  const describeCr = async (cr: ChangeRequestRow): Promise<z.infer<typeof ChangeRequestOut>> => {
    const reviews = await delivery.reviewsOf(cr);
    const state = delivery.approvalState(cr, reviews);
    const { changes, conflicts, behind } = await delivery.compare(cr);
    const names = await delivery.names([cr.authorId, ...reviews.map((review) => review.reviewerId)]);
    const preview = cr.status === 'open' ? await describeEnvironmentsOf(await ctx.apps.ref(cr.appId), cr.id) : null;
    const checks = cr.checks as unknown as z.infer<typeof ChecksOut>;
    return {
      ...summary(cr, names),
      description: cr.description,
      workingCopyId: cr.workingCopyId,
      headDigest: cr.headDigest,
      checks,
      changes: changes.map((change) => ({ ...change, details: [...change.details] })),
      behind,
      conflicts: [...conflicts],
      reviews: reviews.map((review) => ({
        id: review.id,
        reviewer: person(names, review.reviewerId)!,
        verdict: review.verdict,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
        current: review.headDigest === cr.headDigest,
      })),
      approvals: {
        required: state.required,
        approvedBy: state.approvedBy.map((id) => person(names, id)!),
        changesRequestedBy: state.changesRequestedBy.map((id) => person(names, id)!),
        ready: state.ready,
      },
      preview,
      mergedAt: cr.mergedAt?.toISOString() ?? null,
      closedAt: cr.closedAt?.toISOString() ?? null,
    };
  };
  const describeEnvironmentsOf = async (team: AppRef, changeRequestId: string) => {
    const env = (await describeEnvironments(ctx.db, await previewsOf(team))).find((e) => e.changeRequest?.id === changeRequestId);
    return env ? { environmentId: env.id } : null;
  };
  const previewsOf = async (team: AppRef) =>
    ctx.db
      .select()
      .from(appEnvironments)
      .where(and(eq(appEnvironments.appId, team.app.id), eq(appEnvironments.kind, 'preview'), eq(appEnvironments.status, 'active')));
  const summary = (cr: ChangeRequestRow, names: PersonNames): z.infer<typeof ChangeRequestSummaryOut> => ({
    id: cr.id,
    appId: cr.appId,
    number: cr.number,
    title: cr.title,
    status: cr.status,
    author: person(names, cr.authorId)!,
    baseRevision: cr.baseRevision,
    headRevision: cr.headRevision,
    mergedRevision: cr.mergedRevision,
    destructive: (cr.checks as { migration?: { destructive?: boolean } }).migration?.destructive === true,
    createdAt: cr.createdAt.toISOString(),
    updatedAt: cr.updatedAt.toISOString(),
  });

  const describeReleases = async (team: AppRef, rows: readonly ReleaseRow[]): Promise<Array<z.infer<typeof ReleaseOut>>> => {
    const envs = await delivery.environments(team);
    type Contents = { steps?: Array<z.infer<typeof StepOut>>; changes?: Array<{ id: string; number: number; title: string; authorId: string }> };
    const names = await delivery.names(rows.flatMap((row) => [row.createdBy, ...((row.contents as Contents).changes ?? []).map((c) => c.authorId)]));
    return Promise.all(
      rows.map(async (row) => {
        const contents = row.contents as Contents;
        return {
          id: row.id,
          appId: row.appId,
          number: row.number,
          revision: row.revision,
          digest: row.digest,
          destructive: row.destructive,
          notes: row.notes,
          changes: (contents.changes ?? []).map((change) => ({ id: change.id, number: change.number, title: change.title, author: person(names, change.authorId)! })),
          steps: contents.steps ?? [],
          createdBy: row.createdByType === 'user' ? person(names, row.createdBy) : null,
          createdAt: row.createdAt.toISOString(),
          manifestDigest: row.manifestDigest,
          keyId: row.keyId,
          verified: await delivery.verify(row).catch(() => false),
          liveIn: envs.filter((env) => env.activeReleaseId === row.id).map((env) => env.kind as 'staging' | 'prod'),
        };
      }),
    );
  };

  const describeDeployments = async (rows: readonly DeploymentRow[]): Promise<Array<z.infer<typeof DeploymentOut>>> => {
    const releaseIds = [...new Set(rows.flatMap((row) => [row.releaseId, ...(row.fromReleaseId ? [row.fromReleaseId] : [])]))];
    const numbers = new Map(
      releaseIds.length ? (await ctx.db.select({ id: releases.id, number: releases.number }).from(releases).where(inArray(releases.id, releaseIds))).map((r) => [r.id, r.number]) : [],
    );
    const approvals = new Map(await Promise.all(rows.map(async (row) => [row.id, await delivery.approvalsOf(row)] as const)));
    const authors = new Map(await Promise.all(rows.map(async (row) => [row.id, row.kind === 'deploy' ? await delivery.authorsOf(row) : []] as const)));
    const names = await delivery.names([
      ...rows.flatMap((row) => [row.requestedBy, row.executedBy]),
      ...[...approvals.values()].flat().map((a) => a.approverId),
      ...[...authors.values()].flat(),
    ]);
    return rows.map((row) => {
      const plan = row.plan as { steps?: Array<z.infer<typeof StepOut>>; notes?: string[] };
      return {
        id: row.id,
        appId: row.appId,
        environment: row.environmentKind,
        kind: row.kind,
        status: row.status,
        release: { id: row.releaseId, number: numbers.get(row.releaseId)! },
        fromRelease: row.fromReleaseId ? { id: row.fromReleaseId, number: numbers.get(row.fromReleaseId)! } : null,
        destructive: row.destructive,
        plan: { steps: plan.steps ?? [], notes: plan.notes ?? [] },
        approvals: { required: row.approvalsRequired, by: (approvals.get(row.id) ?? []).map((a) => person(names, a.approverId)!) },
        authors: (authors.get(row.id) ?? []).map((id) => person(names, id)!),
        requestedBy: row.requestedByType === 'user' ? person(names, row.requestedBy) : null,
        requestedAt: row.requestedAt.toISOString(),
        executedBy: row.executedByType === 'user' ? person(names, row.executedBy) : null,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
        error: row.error,
      };
    });
  };

  return async (app) => {
    // ---- Working copies ----

    app.post(
      '/v1/apps/:appId/working-copy',
      {
        config: { access: onTeamApp('app.edit') },
        schema: {
          tags: ['delivery'],
          summary: 'Edit in my space: your working copy of a team app, made the first time you ask. Change it freely, then submit the change',
          params: AppParams,
          response: { 200: z.object({ app: AppOut, created: z.boolean(), sampleRecords: z.number().int() }) },
        },
      },
      async (request) => {
        const auth = requireUser(request);
        const { appId, created, samples } = await delivery.workingCopy(request, auth, await theTeamApp(request));
        return { app: await describeApp(ctx, runtime, auth, await ctx.apps.ref(appId)), created, sampleRecords: samples };
      },
    );

    app.post(
      '/v1/apps/:appId/sync',
      {
        config: {
          access: { kind: 'permission', action: 'app.edit', resource: async (request) => appResource(ctx.org.id, (await theCopy(request)).copy) },
        },
        schema: {
          tags: ['delivery'],
          summary: "Take the team app's newer changes into your working copy. Changes to the same parts conflict, and nothing changes",
          params: AppParams,
          querystring: z.object({ confirmDestructive: z.enum(['true', 'false']).optional() }),
          response: { 200: z.object({ plan: PlanOut.nullable(), app: AppOut }) },
        },
      },
      async (request) => {
        const auth = requireUser(request);
        const { copy } = await theCopy(request);
        const { plan } = await delivery.sync(request, auth, await ctx.apps.load(copy.app.id), { confirmDestructive: request.query.confirmDestructive === 'true' });
        return { plan, app: await describeApp(ctx, runtime, auth, await ctx.apps.ref(copy.app.id)) };
      },
    );

    app.post(
      '/v1/apps/:appId/submit',
      {
        config: {
          access: { kind: 'permission', action: 'change.open', resource: async (request) => appResource(ctx.org.id, (await theCopy(request)).team) },
        },
        schema: {
          tags: ['delivery'],
          summary: 'Submit the changes in your working copy: opens a change request in the team space, or brings your open one up to date',
          params: AppParams,
          body: z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(5000).optional() }),
          response: { 200: ChangeRequestOut, 201: ChangeRequestOut },
        },
      },
      async (request, reply) => {
        const auth = requireUser(request);
        const { copy } = await theCopy(request);
        const before = await ctx.db.select({ id: changeRequests.id }).from(changeRequests).where(and(eq(changeRequests.workingCopyId, copy.app.id), eq(changeRequests.status, 'open')));
        const cr = await delivery.submit(request, auth, await ctx.apps.load(copy.app.id), {
          ...(request.body.title ? { title: request.body.title } : {}),
          ...(request.body.description !== undefined ? { description: request.body.description } : {}),
        });
        return reply.status(before.length ? 200 : 201).send(await describeCr(cr));
      },
    );

    // ---- Change requests ----

    app.get(
      '/v1/apps/:appId/change-requests',
      {
        config: { access: onTeamApp('app.read') },
        schema: {
          tags: ['delivery'],
          summary: "A team app's change requests, newest first",
          params: AppParams,
          querystring: z.object({ status: z.enum(['open', 'merged', 'closed', 'all']).default('all') }),
          response: { 200: z.object({ changeRequests: z.array(ChangeRequestSummaryOut) }) },
        },
      },
      async (request) => {
        const team = await theTeamApp(request);
        const rows = await ctx.db
          .select()
          .from(changeRequests)
          .where(and(eq(changeRequests.appId, team.app.id), request.query.status === 'all' ? undefined : eq(changeRequests.status, request.query.status)))
          .orderBy(desc(changeRequests.number))
          .limit(200);
        const names = await delivery.names(rows.map((row) => row.authorId));
        return { changeRequests: rows.map((row) => summary(row, names)) };
      },
    );

    app.get(
      '/v1/change-requests/:changeRequestId',
      {
        config: { access: onCr('app.read') },
        schema: {
          tags: ['delivery'],
          summary: 'One change request: its changes, the automatic checks, its reviews and its preview',
          params: CrParams,
          response: { 200: ChangeRequestOut },
        },
      },
      async (request) => describeCr(await theCr(request)),
    );

    app.get(
      '/v1/change-requests/:changeRequestId/definitions',
      {
        config: { access: onCr('app.read') },
        schema: {
          tags: ['delivery'],
          summary: "The definitions a change request compares: its base on the main line, and its head",
          params: CrParams,
          response: { 200: z.object({ base: z.record(z.string(), z.unknown()), head: z.record(z.string(), z.unknown()) }) },
        },
      },
      async (request) => {
        const cr = await theCr(request);
        const [base, head] = await Promise.all([ctx.apps.definition(cr.appId, cr.baseRevision), ctx.apps.definition(cr.appId, cr.headRevision)]);
        return { base: base as unknown as Record<string, unknown>, head: head as unknown as Record<string, unknown> };
      },
    );

    app.post(
      '/v1/change-requests/:changeRequestId/reviews',
      {
        config: {
          access: {
            kind: 'permission',
            // Approving is separate from reviewing, and the author may not approve (a guardrail, design §5.7).
            action: async (request) => ((request.body as { verdict?: string }).verdict === 'approve' ? 'change.approve' : 'change.review'),
            resource: async (request) => appResource(ctx.org.id, await crTeam(request)),
            context: async (request) => ({ authorId: (await theCr(request)).authorId }),
          },
        },
        schema: {
          tags: ['delivery'],
          summary: 'Review a change request: approve it, ask for changes, or comment. Someone other than its author must approve it',
          params: CrParams,
          body: z.object({ verdict: z.enum(['approve', 'request_changes', 'comment']), comment: z.string().trim().max(5000).optional() }),
          response: { 200: ChangeRequestOut },
        },
      },
      async (request) => {
        const auth = requireUser(request);
        const cr = await theCr(request);
        await delivery.review(request, auth, cr, { verdict: request.body.verdict, ...(request.body.comment ? { comment: request.body.comment } : {}) });
        return describeCr(await delivery.changeRequest(cr.id));
      },
    );

    app.post(
      '/v1/change-requests/:changeRequestId/merge',
      {
        config: { access: onCr('change.merge') },
        schema: {
          tags: ['delivery'],
          summary: 'Merge an approved change request into the main line. Its preview goes away',
          params: CrParams,
          response: { 200: ChangeRequestOut },
        },
      },
      async (request) => describeCr(await delivery.merge(request, requireAuth(request), await theCr(request))),
    );

    app.post(
      '/v1/change-requests/:changeRequestId/close',
      {
        config: {
          access: {
            kind: 'permission',
            // The author withdraws their own change; a release manager may close anyone's.
            action: async (request) => ((await theCr(request)).authorId === request.auth?.actor.id ? 'change.open' : 'change.merge'),
            resource: async (request) => appResource(ctx.org.id, await crTeam(request)),
          },
        },
        schema: { tags: ['delivery'], summary: 'Close a change request without merging it', params: CrParams, response: { 200: ChangeRequestOut } },
      },
      async (request) => describeCr(await delivery.close(request, requireAuth(request), await theCr(request))),
    );

    // ---- Releases ----

    app.get(
      '/v1/apps/:appId/releases',
      {
        config: { access: onTeamApp(['app.read', 'deploy.read']) },
        schema: { tags: ['delivery'], summary: "A team app's releases, newest first, each checked against its signature", params: AppParams, response: { 200: z.object({ releases: z.array(ReleaseOut) }) } },
      },
      async (request) => {
        const team = await theTeamApp(request);
        const rows = await ctx.db.select().from(releases).where(eq(releases.appId, team.app.id)).orderBy(desc(releases.number)).limit(100);
        return { releases: await describeReleases(team, rows) };
      },
    );

    app.post(
      '/v1/apps/:appId/releases',
      {
        config: { access: onTeamApp('release.create') },
        schema: {
          tags: ['delivery'],
          summary: 'Cut a release from the main line: immutable, hashed and signed. A change that deletes data goes in a release of its own',
          params: AppParams,
          body: z.object({
            revision: z.number().int().positive().optional().describe('A main-line revision. Defaults to the newest.'),
            notes: z.string().trim().max(5000).optional(),
          }),
          response: { 201: ReleaseOut },
        },
      },
      async (request, reply) => {
        const team = await theTeamApp(request);
        const release = await delivery.cutRelease(request, requireAuth(request), team, {
          ...(request.body.revision !== undefined ? { revision: request.body.revision } : {}),
          ...(request.body.notes !== undefined ? { notes: request.body.notes } : {}),
        });
        return reply.status(201).send((await describeReleases(team, [release]))[0]!);
      },
    );

    // ---- Deployments ----

    app.get(
      '/v1/apps/:appId/deployments',
      {
        config: { access: onTeamApp(['app.read', 'deploy.read']) },
        schema: {
          tags: ['delivery'],
          summary: "A team app's environments and deployments, newest first",
          params: AppParams,
          response: { 200: z.object({ environments: z.array(EnvironmentOut), deployments: z.array(DeploymentOut) }) },
        },
      },
      async (request) => {
        const team = await theTeamApp(request);
        const rows = await ctx.db.select().from(deployments).where(eq(deployments.appId, team.app.id)).orderBy(desc(deployments.requestedAt)).limit(100);
        return { environments: await describeEnvironments(ctx.db, await delivery.environments(team)), deployments: await describeDeployments(rows) };
      },
    );

    app.post(
      '/v1/apps/:appId/deployments',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'deploy.request',
            resource: async (request) => {
              const team = await theTeamApp(request);
              const kind = (request.body as { env: 'staging' | 'prod' }).env;
              return environmentResource(ctx.org.id, team, kind, await ctx.apps.environment(team, kind));
            },
          },
        },
        schema: {
          tags: ['delivery'],
          summary: 'Ask to deploy a release to Staging or Prod. Prod waits for approvals; a deployment that deletes data needs confirmDestructive',
          params: AppParams,
          body: z.object({
            releaseId: z.uuid(),
            env: EnvKind,
            confirmDestructive: z.boolean().default(false),
            execute: z.boolean().default(false).describe('Deploy at once when no approval is needed, as for Staging'),
          }),
          response: { 201: DeploymentOut },
        },
      },
      async (request, reply) => {
        const auth = requireAuth(request);
        const team = await theTeamApp(request);
        let deployment = await delivery.requestDeployment(request, auth, team, {
          releaseId: request.body.releaseId,
          env: request.body.env,
          confirmDestructive: request.body.confirmDestructive,
        });
        if (request.body.execute && deployment.status === 'approved') {
          await checkPermission(ctx, request, auth, 'deploy.execute', environmentResource(ctx.org.id, team, deployment.environmentKind, await ctx.apps.environment(team, deployment.environmentKind)));
          deployment = await delivery.execute(request, auth, deployment);
        }
        return reply.status(201).send((await describeDeployments([deployment]))[0]!);
      },
    );

    app.post(
      '/v1/deployments/:deploymentId/approve',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'deploy.approve',
            resource: deploymentResource,
            context: async (request) => ({ authorId: (await delivery.authorsOf(await theDeployment(request)))[0] ?? NO_AUTHOR }),
          },
        },
        schema: {
          tags: ['delivery'],
          summary: 'Approve a deployment. Nobody who authored one of its changes may; Prod needs a fresh MFA sign-in',
          params: DeploymentParams,
          response: { 200: DeploymentOut },
        },
      },
      async (request) => {
        const auth = requireUser(request);
        const deployment = await theDeployment(request);
        // The access rule asked about the first author; every other author counts as much (design §5.7).
        const resource = await deploymentResource(request);
        for (const authorId of (await delivery.authorsOf(deployment)).slice(1)) {
          await checkPermission(ctx, request, auth, 'deploy.approve', resource, { context: { authorId } });
        }
        return (await describeDeployments([await delivery.approveDeployment(request, auth, deployment)]))[0]!;
      },
    );

    app.post(
      '/v1/deployments/:deploymentId/execute',
      {
        config: { access: { kind: 'permission', action: 'deploy.execute', resource: deploymentResource } },
        schema: {
          tags: ['delivery'],
          summary: 'Execute an approved deployment: apply its migration and make the release live, in one transaction',
          params: DeploymentParams,
          response: { 200: DeploymentOut },
        },
      },
      async (request) => (await describeDeployments([await delivery.execute(request, requireAuth(request), await theDeployment(request))]))[0]!,
    );

    app.post(
      '/v1/deployments/:deploymentId/cancel',
      {
        config: { access: { kind: 'permission', action: 'deploy.request', resource: deploymentResource } },
        schema: { tags: ['delivery'], summary: 'Cancel a deployment that has not run', params: DeploymentParams, response: { 200: DeploymentOut } },
      },
      async (request) => (await describeDeployments([await delivery.cancel(request, requireAuth(request), await theDeployment(request))]))[0]!,
    );

    app.post(
      '/v1/apps/:appId/environments/:env/rollback',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'deploy.rollback',
            resource: async (request) => {
              const team = await theTeamApp(request);
              const kind = (request.params as { env: 'staging' | 'prod' }).env;
              return environmentResource(ctx.org.id, team, kind, await ctx.apps.environment(team, kind));
            },
          },
        },
        schema: {
          tags: ['delivery'],
          summary: 'Roll an environment back to the release that ran there before. It takes effect at once; Prod needs a fresh MFA sign-in',
          params: AppParams.extend({ env: EnvKind }),
          response: { 200: DeploymentOut },
        },
      },
      async (request) => {
        const deployment = await delivery.rollback(request, requireAuth(request), await theTeamApp(request), request.params.env);
        return (await describeDeployments([deployment]))[0]!;
      },
    );
  };
}
