import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { once, requireAuth, requireQueryDecision } from '../access/rules.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { recordResource } from './resources.js';
import type { AppRuntime } from './runtime.js';
import { envOf } from './routes.js';
import { ActionResultOut, AppParams, EntityParams, EnvQuery, PageOut, ProvenanceIn, RecordOut, RecordParams } from './schemas.js';

/** `amount,-created_at` → ascending amount, then newest first. */
function parseSort(sort: string | undefined) {
  if (!sort) return undefined;
  const keys = sort.split(',').map((key) => key.trim()).filter(Boolean);
  if (keys.length > 3) throw badRequest('invalid_sort', 'Sort by at most three fields');
  return keys.map((key) => (key.startsWith('-') ? { field: key.slice(1), direction: 'desc' as const } : { field: key, direction: 'asc' as const }));
}

/** The records API, queries and actions: the runtime of the built-in store (design §6). */
export function runtimeRoutes(ctx: AppContext, runtime: AppRuntime): FastifyPluginAsyncZod {
  /** The app in the environment the request names: Prod by default for a team app, or Staging, or a preview. */
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  const policy = async (request: FastifyRequest) => runtime.policy(await theApp(request));
  const records = async (request: FastifyRequest) => {
    const loaded = await theApp(request);
    const entity = (request.params as { entity: string }).entity;
    runtime.entity(loaded, entity); // 404 for an unknown entity, before any permission is weighed
    return recordResource(ctx.org.id, loaded, entity);
  };
  const recordRule = (action: string) => ({ kind: 'query' as const, action, resource: records, policy });
  const capability = (kind: 'action' | 'query') => async (request: FastifyRequest) => {
    const loaded = await theApp(request);
    const name = (request.params as { name: string }).name;
    const defined = kind === 'action' ? loaded.definition.actions[name] : loaded.definition.queries[name];
    if (!defined) throw notFound(kind === 'action' ? 'Action' : 'Query');
    return runtime.capability(loaded, kind, name);
  };

  return async (app) => {
    app.get(
      '/v1/apps/:appId/entities/:entity/records',
      {
        config: { access: recordRule('record.read') },
        schema: {
          tags: ['records'],
          summary: 'Records you can see, newest first unless you sort them',
          params: EntityParams,
          querystring: EnvQuery.extend({
            limit: z.coerce.number().int().min(1).max(200).default(50),
            cursor: z.string().max(4000).optional(),
            sort: z.string().max(200).optional().describe('Comma-separated fields; prefix with - for descending'),
          }),
          response: { 200: PageOut },
        },
      },
      async (request) => {
        const sort = parseSort(request.query.sort);
        return runtime.list(request, requireAuth(request), await theApp(request), request.params.entity, {
          decision: requireQueryDecision(request),
          limit: request.query.limit,
          ...(sort ? { sort } : {}),
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        });
      },
    );

    app.get(
      '/v1/apps/:appId/entities/:entity/records/:recordId',
      {
        config: { access: recordRule('record.read') },
        schema: { tags: ['records'], summary: 'One record', params: RecordParams, querystring: EnvQuery, response: { 200: RecordOut } },
      },
      async (request) =>
        runtime.get(request, requireAuth(request), await theApp(request), request.params.entity, request.params.recordId, requireQueryDecision(request)),
    );

    app.post(
      '/v1/apps/:appId/entities/:entity/records',
      {
        config: { access: recordRule('record.create') },
        schema: {
          tags: ['records'],
          summary: 'Create a record. Rules run on the server, whatever the client',
          params: EntityParams,
          querystring: EnvQuery,
          body: z.object({ values: z.record(z.string(), z.unknown()), provenance: ProvenanceIn }),
          response: { 201: RecordOut },
        },
      },
      async (request, reply) => {
        const record = await runtime.create(request, requireAuth(request), await theApp(request), request.params.entity, request.body, requireQueryDecision(request));
        return reply.status(201).send(record);
      },
    );

    app.patch(
      '/v1/apps/:appId/entities/:entity/records/:recordId',
      {
        config: { access: recordRule('record.update') },
        schema: {
          tags: ['records'],
          summary: 'Change some fields of a record. Give the version you read to avoid overwriting someone else',
          params: RecordParams,
          querystring: EnvQuery,
          body: z.object({ values: z.record(z.string(), z.unknown()), version: z.number().int().positive().optional(), provenance: ProvenanceIn }),
          response: { 200: RecordOut },
        },
      },
      async (request) =>
        runtime.update(request, requireAuth(request), await theApp(request), request.params.entity, request.params.recordId, request.body, requireQueryDecision(request)),
    );

    app.delete(
      '/v1/apps/:appId/entities/:entity/records/:recordId',
      {
        config: { access: recordRule('record.delete') },
        schema: { tags: ['records'], summary: 'Delete a record. Its history is kept', params: RecordParams, querystring: EnvQuery },
      },
      async (request, reply) => {
        await runtime.remove(request, requireAuth(request), await theApp(request), request.params.entity, request.params.recordId, requireQueryDecision(request));
        return reply.status(204).send();
      },
    );

    app.get(
      '/v1/apps/:appId/entities/:entity/records/:recordId/history',
      {
        config: { access: recordRule('record.read') },
        schema: {
          tags: ['records'],
          summary: "A record's history: who changed which field, when, how, and where each value came from",
          params: RecordParams,
          querystring: EnvQuery,
          response: {
            200: z.object({
              history: z.array(
                z.object({
                  version: z.number().int(),
                  operation: z.enum(['create', 'update', 'delete']),
                  at: z.string(),
                  actor: z.object({ type: z.string(), id: z.uuid().nullable(), onBehalfOf: z.uuid().nullable() }),
                  via: z.string(),
                  changes: z.array(z.record(z.string(), z.unknown())),
                }),
              ),
            }),
          },
        },
      },
      async (request) => ({
        history: await runtime.history(request, requireAuth(request), await theApp(request), request.params.entity, request.params.recordId),
      }),
    );

    app.get(
      '/v1/apps/:appId/pages/:page/blocks/:block/records',
      {
        config: {
          access: {
            kind: 'query',
            action: 'record.read',
            resource: async (request) => {
              const loaded = await theApp(request);
              const { page, block } = request.params as { page: string; block: string };
              return recordResource(ctx.org.id, loaded, runtime.listBlock(loaded, page, Number(block)).entity);
            },
            policy,
          },
        },
        schema: {
          tags: ['records'],
          summary: "The records of a list on one of the app's pages, under your record permissions",
          params: AppParams.extend({ page: z.string().min(1).max(63), block: z.coerce.number().int().min(0).max(29) }),
          querystring: EnvQuery.extend({ cursor: z.string().max(4000).optional() }),
          response: { 200: PageOut },
        },
      },
      async (request) =>
        runtime.runList(request, requireAuth(request), await theApp(request), request.params.page, request.params.block, {
          decision: requireQueryDecision(request),
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        }),
    );

    app.post(
      '/v1/apps/:appId/queries/:name/run',
      {
        config: { access: { kind: 'permission', action: 'query.run', resource: capability('query'), policy } },
        schema: {
          tags: ['capabilities'],
          summary: "Run one of the app's queries, under your record permissions",
          params: AppParams.extend({ name: z.string().min(1).max(63) }),
          querystring: EnvQuery,
          body: z.object({
            parameters: z.record(z.string(), z.unknown()).default({}),
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().max(4000).optional(),
          }),
          response: { 200: PageOut },
        },
      },
      async (request) =>
        runtime.runQuery(request, requireAuth(request), await theApp(request), request.params.name, {
          parameters: request.body.parameters,
          ...(request.body.limit ? { limit: request.body.limit } : {}),
          ...(request.body.cursor ? { cursor: request.body.cursor } : {}),
        }),
    );

    app.post(
      '/v1/apps/:appId/actions/:name/run',
      {
        config: { access: { kind: 'permission', action: 'action.run', resource: capability('action'), policy } },
        schema: {
          tags: ['capabilities'],
          summary: "Run one of the app's actions. From an API token, anything that needs confirmation becomes a proposal for the person to approve",
          params: AppParams.extend({ name: z.string().min(1).max(63) }),
          querystring: EnvQuery,
          body: z.object({
            values: z.record(z.string(), z.unknown()).default({}),
            recordId: z.uuid().optional(),
            version: z.number().int().positive().optional(),
            provenance: ProvenanceIn,
            dryRun: z.boolean().optional().describe('Check everything and return the review card, without changing anything'),
          }),
          response: { 200: ActionResultOut, 201: ActionResultOut, 202: ActionResultOut },
        },
      },
      async (request, reply) => {
        const loaded = await theApp(request);
        const result = await runtime.runAction(request, requireAuth(request), loaded, request.params.name, request.body);
        const created = result.status === 'done' && loaded.definition.actions[request.params.name]?.operation === 'create';
        return reply.status(result.status === 'needs_confirmation' ? 202 : created ? 201 : 200).send(result);
      },
    );
  };
}
