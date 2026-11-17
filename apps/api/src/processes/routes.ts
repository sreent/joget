import { bpmnToProcesses, NAME_PATTERN, processToBpmn } from '@platform/app-model';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkAnyPermission, checkPermission } from '../access/check.js';
import { once, requireAuth } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import { changeRequestRequired, type AppBuilder } from '../apps/builder.js';
import { isTeamApp, type LoadedApp } from '../apps/catalog.js';
import { appResource, processResource } from '../apps/resources.js';
import { envOf } from '../apps/routes.js';
import type { AppRuntime } from '../apps/runtime.js';
import { ActionResultOut, AppParams, EnvQuery, PlanOut } from '../apps/schemas.js';
import type { AppContext } from '../context.js';
import { notFound, unprocessable } from '../errors.js';
import type { ProcessEngine } from './engine.js';

const TaskOut = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['open', 'completed', 'cancelled']),
  app: z.object({ id: z.uuid(), name: z.string() }),
  environment: z.object({ id: z.uuid() }),
  process: z.string(),
  instanceId: z.uuid(),
  element: z.string(),
  entity: z.string(),
  recordId: z.uuid(),
  role: z.string(),
  assignee: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
  outcomes: z.array(z.object({ name: z.string(), label: z.string(), action: z.string().optional() })),
  card: z.string().nullable(),
  due: z.string().nullable(),
  overdue: z.boolean(),
  several: z.boolean(),
  voters: z.number().int().nullable(),
  outcome: z.string().nullable(),
  completedBy: z.uuid().nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});

const InstanceOut = z.object({
  id: z.uuid(),
  process: z.string(),
  label: z.string(),
  revision: z.number().int(),
  entity: z.string(),
  recordId: z.uuid(),
  status: z.enum(['running', 'completed', 'cancelled']),
  stuck: z.array(z.object({ element: z.string(), name: z.string(), error: z.string() })),
  waiting: z.array(z.object({ element: z.string(), name: z.string() })),
  startedBy: z.uuid().nullable(),
  startedByAction: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

const InstanceDetailOut = InstanceOut.extend({
  tasks: z.array(TaskOut),
  events: z.array(z.object({ at: z.string(), kind: z.string(), element: z.string().nullable(), name: z.string().nullable(), by: z.uuid().nullable(), detail: z.unknown() })),
});

const InstanceParams = AppParams.extend({ instanceId: z.uuid() });

/**
 * Business processes (design §6.10): people's tasks across apps, starting a process by hand,
 * and the instances of an app for whoever runs it: its owner in a personal space, operators in a
 * team space, who see where each instance waits and try a stuck one again.
 */
export function processRoutes(ctx: AppContext, runtime: AppRuntime, engine: ProcessEngine, builder: AppBuilder): FastifyPluginAsyncZod {
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  // The check needs the space's kind, so the handler makes it, with the same audited refusal an access rule gives.
  const operate = async (request: FastifyRequest, loaded: LoadedApp, operation: 'ops.monitor.read' | 'ops.job.retry' | 'process.admin') => {
    const actions = loaded.space.kind === 'personal' && operation !== 'process.admin' ? ['app.edit'] : [operation];
    await checkAnyPermission(ctx, request, requireAuth(request), actions, appResource(ctx.org.id, loaded), { policy: await runtime.policy(loaded) });
  };

  const appRule = (action: string) => ({
    kind: 'permission' as const,
    action,
    resource: async (request: FastifyRequest) => appResource(ctx.org.id, await ctx.apps.ref((request.params as { appId: string }).appId)),
  });

  return async (app) => {
    app.get(
      '/v1/apps/:appId/processes/:process/bpmn',
      {
        config: { access: appRule('app.export') },
        schema: {
          tags: ['processes'],
          summary: "Download one of an app's processes as a BPMN 2.0 file, with its diagram: from the app's main line",
          params: AppParams.extend({ process: z.string().min(1).max(63) }),
        },
      },
      async (request, reply) => {
        const ref = await ctx.apps.ref(request.params.appId);
        const definition = await ctx.apps.mainDefinition(ref);
        if (!definition.processes?.[request.params.process]) throw notFound('Process');
        await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, ctx.now()), {
          action: 'app.export',
          target: { type: 'app', id: ref.app.id, name: ref.app.name },
          spaceId: ref.space.id,
          appId: ref.app.id,
          reason: { revision: ref.app.currentRevision, process: request.params.process, format: 'bpmn' },
        });
        return reply
          .type('application/xml; charset=utf-8')
          .header('content-disposition', `attachment; filename="${request.params.process}.bpmn"`)
          .send(processToBpmn(definition, request.params.process));
      },
    );

    app.post(
      '/v1/apps/:appId/processes/import',
      {
        config: { access: appRule('app.edit') },
        schema: {
          tags: ['processes'],
          summary: "Add the processes of a BPMN 2.0 file to a personal app, or a working copy of a team app. Anything Ambit can't run is refused, by name",
          params: AppParams,
          body: z.object({
            xml: z.string().min(1).max(5_000_000),
            entity: z.string().regex(NAME_PATTERN).optional().describe("The entity whose records the processes are about, unless the file names it or the app has one"),
            as: z.string().regex(NAME_PATTERN).optional().describe('The name for the one process of the file: it replaces a process of that name'),
          }),
          response: { 200: z.object({ plan: PlanOut, processes: z.array(z.string()), notes: z.array(z.string()) }) },
        },
      },
      async (request) => {
        const ref = await ctx.apps.ref(request.params.appId);
        if (isTeamApp(ref)) throw changeRequestRequired(ref);
        const loaded = await ctx.apps.load(ref.app.id);
        const current = loaded.definition;
        const { as, entity, xml } = request.body;
        const others = Object.fromEntries(Object.entries(current.processes ?? {}).filter(([name]) => name !== as));
        const read = bpmnToProcesses(xml, { ...current, processes: others }, entity ? { entity } : {});
        if (!read.ok) {
          throw unprocessable('invalid_bpmn', "The file has parts Ambit can't run", { issues: read.issues.map((issue) => ({ path: issue.element ? `bpmn.${issue.element}` : 'bpmn', message: issue.message })) });
        }
        const found = Object.values(read.processes);
        if (as && found.length !== 1) throw unprocessable('one_process', `The file holds ${found.length} processes: give a name only for a file with one`);
        const imported = as ? { [as]: found[0]! } : read.processes;
        const plan = await builder.save(request, requireAuth(request), loaded, { ...current, processes: { ...others, ...imported } }, { confirmDestructive: false });
        return { plan, processes: Object.keys(imported), notes: [...read.notes] };
      },
    );

    app.get(
      '/v1/me/tasks',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'Your tasks across apps: those that wait for you, and those of your roles that wait for nobody in particular. Soonest due first',
          querystring: z.object({ status: z.enum(['open', 'closed']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
          response: { 200: z.object({ tasks: z.array(TaskOut) }) },
        },
      },
      async (request) => ({ tasks: await engine.inbox(requireAuth(request), { status: request.query.status, limit: request.query.limit }) }),
    );

    app.post(
      '/v1/tasks/:taskId/complete',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: "Complete a task with one of its outcomes. An outcome that runs an action runs it as you; from an API token it may become a proposal to approve first",
          params: z.object({ taskId: z.uuid() }),
          body: z.object({
            outcome: z.string().min(1).max(63),
            values: z.record(z.string(), z.unknown()).optional().describe("The action's input, when the outcome's action takes some"),
            provenance: z.unknown().optional(),
          }),
          response: { 200: z.object({ task: TaskOut, result: ActionResultOut.nullable() }), 202: z.object({ task: TaskOut, result: ActionResultOut.nullable() }) },
        },
      },
      async (request, reply) => {
        const done = await engine.complete(request, requireAuth(request), request.params.taskId, request.body);
        return reply.status(done.result?.status === 'needs_confirmation' ? 202 : 200).send(done);
      },
    );

    const reassign = async (request: FastifyRequest, taskId: string, to: string) => {
      const auth = requireAuth(request);
      const place = await engine.taskPlace(taskId);
      if (!place) throw notFound('Task');
      const loaded = await ctx.apps.load(place.appId, { id: place.environmentId });
      // Operators move any task of the app: its owner in a personal space, ops.task.reassign in a team space.
      const action = loaded.space.kind === 'personal' ? 'app.edit' : 'ops.task.reassign';
      const operator = (await ctx.policy.authorize(auth.principal, action, appResource(ctx.org.id, loaded), undefined, await runtime.policy(loaded))).allowed;
      return engine.reassign(request, auth, taskId, to, { operator });
    };

    app.post(
      '/v1/tasks/:taskId/reassign',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: "Give a task to someone else who holds its role: yours to a colleague, or any task of an app you operate",
          params: z.object({ taskId: z.uuid() }),
          body: z.object({ userId: z.uuid() }),
          response: { 200: TaskOut },
        },
      },
      async (request) => reassign(request, request.params.taskId, request.body.userId),
    );

    app.post(
      '/v1/tasks/:taskId/claim',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'Take a task that waits for anyone with your role, so others know you have it',
          params: z.object({ taskId: z.uuid() }),
          response: { 200: TaskOut },
        },
      },
      async (request) => reassign(request, request.params.taskId, requireAuth(request).actor.id),
    );

    app.post(
      '/v1/apps/:appId/processes/:process/start',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'Start a process on a record by hand, if your role may start it',
          params: AppParams.extend({ process: z.string().min(1).max(63) }),
          querystring: EnvQuery,
          body: z.object({ recordId: z.uuid() }),
          response: { 201: InstanceOut },
        },
      },
      async (request, reply) => {
        const loaded = await theApp(request);
        const auth = requireAuth(request);
        await checkPermission(ctx, request, auth, 'process.start', processResource(ctx.org.id, loaded, request.params.process), { policy: await runtime.policy(loaded) });
        return reply.status(201).send(await engine.start(request, auth, loaded, request.params.process, request.body.recordId));
      },
    );

    app.get(
      '/v1/apps/:appId/entities/:entity/records/:recordId/processes',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'The processes that run, or ran, on a record you can see, and where they wait',
          params: AppParams.extend({ entity: z.string().min(1).max(63), recordId: z.uuid() }),
          querystring: EnvQuery,
          response: { 200: z.object({ instances: z.array(InstanceDetailOut) }) },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        // Whoever can see the record can see where its processes are: the record's own permissions decide.
        await runtime.get(request, requireAuth(request), loaded, request.params.entity, request.params.recordId);
        const instances = await engine.instances(loaded, { recordId: request.params.recordId, limit: 20 });
        return { instances: await Promise.all(instances.map((instance) => engine.instance(loaded, instance.id))) };
      },
    );

    app.get(
      '/v1/apps/:appId/process-instances',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: "An app's process instances in an environment, newest first",
          params: AppParams,
          querystring: EnvQuery.extend({
            status: z.enum(['running', 'completed', 'cancelled']).optional(),
            stuck: z.stringbool().optional().describe('Only those stuck where an operator must try again'),
            recordId: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: { 200: z.object({ instances: z.array(InstanceOut) }) },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await operate(request, loaded, 'ops.monitor.read');
        const { status, stuck, recordId, limit } = request.query;
        return { instances: await engine.instances(loaded, { limit, ...(status ? { status } : {}), ...(stuck ? { stuck } : {}), ...(recordId ? { recordId } : {}) }) };
      },
    );

    app.get(
      '/v1/apps/:appId/process-instances/:instanceId',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'A process instance, with its tasks and what happened in it',
          params: InstanceParams,
          querystring: EnvQuery,
          response: { 200: InstanceDetailOut },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await operate(request, loaded, 'ops.monitor.read');
        return engine.instance(loaded, request.params.instanceId);
      },
    );

    app.post(
      '/v1/apps/:appId/process-instances/:instanceId/retry',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'Try a stuck instance again from where it stopped',
          params: InstanceParams,
          querystring: EnvQuery,
          response: { 200: InstanceOut },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await operate(request, loaded, 'ops.job.retry');
        return engine.retry(request, loaded, request.params.instanceId);
      },
    );

    app.post(
      '/v1/apps/:appId/process-instances/:instanceId/cancel',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'End a running instance where it is. Its open tasks and timers end with it',
          params: InstanceParams,
          querystring: EnvQuery,
          response: { 200: InstanceOut },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await operate(request, loaded, 'process.admin');
        return engine.cancel(request, loaded, request.params.instanceId);
      },
    );
  };
}
