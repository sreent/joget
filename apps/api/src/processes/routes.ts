import { NAME_PATTERN } from '@platform/app-model';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkPermission } from '../access/check.js';
import { once, requireAuth } from '../access/rules.js';
import type { LoadedApp } from '../apps/catalog.js';
import { processResource } from '../apps/resources.js';
import { envOf } from '../apps/routes.js';
import type { AppRuntime } from '../apps/runtime.js';
import { ActionResultOut, AppParams, EnvQuery } from '../apps/schemas.js';
import type { AppContext } from '../context.js';
import { unprocessable } from '../errors.js';
import { plannedRun } from '../flows/schedules.js';
import type { ProcessEngine } from './engine.js';
import { type Operation, reassignTask, requireOperator } from './operators.js';

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
  /** The instance whose call activity started it. */
  calledBy: z.uuid().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

const InstanceDetailOut = InstanceOut.extend({
  tasks: z.array(TaskOut),
  events: z.array(
    z.object({ at: z.string(), kind: z.string(), element: z.string().nullable(), name: z.string().nullable(), by: z.uuid().nullable(), detail: z.unknown() }),
  ),
});

const InstanceParams = AppParams.extend({ instanceId: z.uuid() });

const SignalOut = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['waiting', 'delivered']),
  /** How many instances heard it, and how many processes it started, once it went out. */
  heard: z.int().nullable(),
  started: z.int().nullable(),
});

/**
 * Business processes (design §6.10), which flows that wait run as (§6.11): people's tasks across
 * apps, starting one on a record by hand, and the instances of an app for whoever runs it: its
 * owner in a personal space, operators in a team space, who see where each instance waits and try
 * a stuck one again.
 */
export function processRoutes(ctx: AppContext, runtime: AppRuntime, engine: ProcessEngine): FastifyPluginAsyncZod {
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  // The check needs the space's kind, so the handler makes it, with the same audited refusal an access rule gives.
  const operate = (request: FastifyRequest, loaded: LoadedApp, operation: Operation) =>
    requireOperator(ctx, runtime, request, requireAuth(request), loaded, operation);

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
          summary:
            'Complete a task with one of its outcomes. An outcome that runs an action runs it as you; from an API token it may become a proposal to approve first',
          params: z.object({ taskId: z.uuid() }),
          body: z.object({
            outcome: z.string().min(1).max(63),
            values: z.record(z.string(), z.unknown()).optional().describe("The action's input, when the outcome's action takes some"),
            provenance: z.unknown().optional(),
          }),
          response: {
            200: z.object({ task: TaskOut, result: ActionResultOut.nullable() }),
            202: z.object({ task: TaskOut, result: ActionResultOut.nullable() }),
          },
        },
      },
      async (request, reply) => {
        const done = await engine.complete(request, requireAuth(request), request.params.taskId, request.body);
        return reply.status(done.result?.status === 'needs_confirmation' ? 202 : 200).send(done);
      },
    );

    const reassign = (request: FastifyRequest, taskId: string, to: string) => reassignTask(ctx, runtime, engine, request, requireAuth(request), taskId, to);

    app.post(
      '/v1/tasks/:taskId/reassign',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'Give a task to someone else who holds its role: yours to a colleague, or any task of an app you operate',
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
        await checkPermission(ctx, request, auth, 'process.start', processResource(ctx.org.id, loaded, request.params.process), {
          policy: await runtime.policy(loaded),
        });
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
        return {
          instances: await engine.instances(loaded, { limit, ...(status ? { status } : {}), ...(stuck ? { stuck } : {}), ...(recordId ? { recordId } : {}) }),
        };
      },
    );

    app.get(
      '/v1/apps/:appId/flows/:flow/live',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary:
            'Where the cases of a flow that waits are now: how many wait at each step, how many are stuck there, and since when the first of them has waited. For a flow on a schedule, when it runs next',
          params: AppParams.extend({ flow: z.string().regex(NAME_PATTERN) }),
          querystring: EnvQuery,
          response: {
            200: z.object({
              running: z.int(),
              steps: z.array(z.object({ path: z.string(), waiting: z.int(), stuck: z.int(), since: z.string() })),
              schedule: z.object({ nextRunAt: z.string(), lastRunAt: z.string().nullable(), lastError: z.string().nullable() }).optional(),
            }),
          },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await operate(request, loaded, 'ops.monitor.read');
        const schedule = await plannedRun(ctx.db, loaded.env.id, request.params.flow);
        return { ...(await engine.live(loaded, request.params.flow)), ...(schedule ? { schedule } : {}) };
      },
    );

    app.get(
      '/v1/apps/:appId/flows/:flow/live/cases',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'The cases that wait at one step of a flow now, the longest waiting first: what its live count opens',
          params: AppParams.extend({ flow: z.string().regex(NAME_PATTERN) }),
          querystring: EnvQuery.extend({
            path: z.string().min(1).max(500).describe('The step, as steps[2].then[0]'),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: {
            200: z.object({
              cases: z.array(z.object({ instanceId: z.uuid(), recordId: z.uuid(), since: z.string(), stuck: z.boolean(), error: z.string().optional() })),
            }),
          },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await operate(request, loaded, 'ops.monitor.read');
        return { cases: await engine.casesAt(loaded, request.params.flow, request.query.path, request.query.limit) };
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
      '/v1/apps/:appId/signals',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['processes'],
          summary: 'Throw a signal to every process of the app that waits for it. For a record, the processes that it starts start on that record',
          params: AppParams,
          querystring: EnvQuery,
          body: z.strictObject({
            name: z.string().regex(NAME_PATTERN, 'Use lowercase letters, digits and underscores, starting with a letter'),
            entity: z.string().regex(NAME_PATTERN).optional(),
            recordId: z.uuid().optional(),
          }),
          response: { 201: SignalOut },
        },
      },
      async (request, reply) => {
        const loaded = await theApp(request);
        await operate(request, loaded, 'process.admin');
        const { name, entity, recordId } = request.body;
        if ((entity === undefined) !== (recordId === undefined)) throw unprocessable('record_incomplete', 'Name both the entity and the record, or neither');
        const signal = await engine.throwSignal(request, loaded, name, entity && recordId ? { entity, id: recordId } : null);
        reply.code(201);
        return { id: signal.id, name: signal.name, status: signal.status, heard: signal.heard, started: signal.started };
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
