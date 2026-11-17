import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkAnyPermission, checkPermission } from '../access/check.js';
import { once, requireAuth } from '../access/rules.js';
import type { LoadedApp } from '../apps/catalog.js';
import { appResource, processResource } from '../apps/resources.js';
import { envOf } from '../apps/routes.js';
import type { AppRuntime } from '../apps/runtime.js';
import { ActionResultOut, AppParams, EnvQuery } from '../apps/schemas.js';
import type { AppContext } from '../context.js';
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
export function processRoutes(ctx: AppContext, runtime: AppRuntime, engine: ProcessEngine): FastifyPluginAsyncZod {
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  // The check needs the space's kind, so the handler makes it, with the same audited refusal an access rule gives.
  const operate = async (request: FastifyRequest, loaded: LoadedApp, operation: 'ops.monitor.read' | 'ops.job.retry' | 'process.admin') => {
    const actions = loaded.space.kind === 'personal' && operation !== 'process.admin' ? ['app.edit'] : [operation];
    await checkAnyPermission(ctx, request, requireAuth(request), actions, appResource(ctx.org.id, loaded), { policy: await runtime.policy(loaded) });
  };

  return async (app) => {
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
