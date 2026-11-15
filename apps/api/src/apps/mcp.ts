import { EXPENSE_APP, type StoredDefinition, type StoredField } from '@platform/app-model';
import { spaces } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkPermission } from '../access/check.js';
import { spaceResource } from '../access/resources.js';
import { requireAuth } from '../access/rules.js';
import type { AppContext, AuthContext } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import type { AppBuilder } from './builder.js';
import type { LoadedApp } from './catalog.js';
import { appResource } from './resources.js';
import { definitionJsonSchema, describeApp, visibleApps } from './routes.js';
import type { AppRuntime } from './runtime.js';

/**
 * MCP endpoints (design §6.2, §6.5), over MCP's Streamable HTTP transport, answering each request
 * with plain JSON:
 *
 * - `/mcp` publishes every action and query the caller may run as a tool, for agents;
 * - `/mcp/build` lets AI clients such as Claude build apps, with the builder's own permissions.
 *
 * Both run as the caller. The same permission checks, rules, confirmations and audit apply as
 * for the REST API: an MCP client gets nothing the person couldn't do themselves.
 */

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
  /** A sentence for people and models, summarizing the result. */
  summarize?(result: unknown): string;
}

type JsonRpcId = string | number;

const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

/** The JSON Schema of a field's value, as an agent sends it. Line fields are required only on new records. */
function fieldSchema(field: StoredField, definition: StoredDefinition, operation: 'create' | 'update'): Record<string, unknown> {
  const about = { title: field.label, ...(field.description ? { description: field.description } : {}) };
  switch (field.type) {
    case 'text':
      return { ...about, type: 'string', maxLength: field.maxLength };
    case 'email':
      return { ...about, type: 'string', format: 'email' };
    case 'number':
      return {
        ...about,
        type: field.decimals === 0 ? 'integer' : 'number',
        ...(field.min !== undefined ? { minimum: field.min } : {}),
        ...(field.max !== undefined ? { maximum: field.max } : {}),
      };
    case 'boolean':
      return { ...about, type: 'boolean' };
    case 'date':
      return { ...about, type: 'string', format: 'date' };
    case 'datetime':
      return { ...about, type: 'string', format: 'date-time' };
    case 'choice': {
      const values = field.options.map((option) => option.value);
      const labels = field.options.map((option) => `${option.value} (${option.label})`).join(', ');
      return field.multiple
        ? { ...about, type: 'array', items: { type: 'string', enum: values }, uniqueItems: true, description: `Any of: ${labels}` }
        : { ...about, type: 'string', enum: values, description: `One of: ${labels}` };
    }
    case 'reference':
      return { ...about, type: 'string', format: 'uuid', description: `The ID of a ${field.entity} record` };
    case 'user':
      return { ...about, type: 'string', format: 'uuid', description: "A person's ID" };
    case 'lines': {
      const lineEntity = definition.entities[field.entity]!;
      const properties: Record<string, unknown> = {
        id: { type: 'string', format: 'uuid', description: 'Leave it out for a new line. To change a line the record has, give its ID and the values to change.' },
      };
      const required: string[] = [];
      for (const f of lineEntity.fields) {
        properties[f.name] = fieldSchema(f, definition, operation);
        if (operation === 'create' && f.required && !('default' in f && f.default !== undefined)) required.push(f.name);
      }
      return {
        ...about,
        type: 'array',
        description: `${field.description ? `${field.description} ` : ''}${lineEntity.pluralLabel ?? lineEntity.label}, one item per line, in order.${
          operation === 'update' ? ' Send every line the record should have: lines left out are removed.' : ''
        }`,
        ...(field.required ? { minItems: 1 } : {}),
        maxItems: field.max,
        items: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
      };
    }
  }
}

const PROVENANCE_SCHEMA = {
  type: 'object',
  description:
    'Where each value came from, by field name; for a value in a line, by its place, such as lines[0].amount. Say it for every value you did not get from the person: it is shown to them and to approvers.',
  additionalProperties: {
    oneOf: [
      { type: 'object', properties: { source: { const: 'document' }, document: { type: 'string' }, location: { type: 'string' } }, required: ['source'], additionalProperties: false },
      { type: 'object', properties: { source: { const: 'agent' }, note: { type: 'string', description: 'How you inferred it' } }, required: ['source'], additionalProperties: false },
      { type: 'object', properties: { source: { const: 'person' } }, required: ['source'], additionalProperties: false },
    ],
  },
};

function toolName(handle: string, name: string, taken: Set<string>, appId: string): string {
  let candidate = `${handle}__${name}`.slice(0, 64);
  if (taken.has(candidate)) candidate = `${handle}_${appId.replaceAll('-', '').slice(-6)}__${name}`.slice(0, 64);
  taken.add(candidate);
  return candidate;
}

/** The tools an agent acting as this caller may use: every action and query they are allowed to run. */
async function capabilityTools(ctx: AppContext, runtime: AppRuntime, request: FastifyRequest, auth: AuthContext): Promise<Tool[]> {
  const tools: Tool[] = [];
  const taken = new Set<string>();
  for (const summary of await visibleApps(ctx, runtime, auth)) {
    if (!summary.access.run) continue;
    const loaded = await ctx.apps.load(summary.id);
    const policy = await runtime.policy(loaded);
    const allowed = async (kind: 'action' | 'query', name: string) =>
      (await ctx.policy.authorize(auth.principal, `${kind}.run`, runtime.capability(loaded, kind, name), undefined, policy)).allowed;
    for (const [name, action] of Object.entries(loaded.definition.actions)) {
      if (!(await allowed('action', name))) continue;
      tools.push(actionTool(ctx, runtime, request, auth, loaded, name, toolName(loaded.app.handle, name, taken, loaded.app.id)));
    }
    for (const [name, query] of Object.entries(loaded.definition.queries)) {
      if (!(await allowed('query', name))) continue;
      const params = Object.fromEntries(
        Object.entries(query.parameters).map(([param, spec]) => [param, { type: spec.type === 'text' ? 'string' : spec.type, description: spec.description }]),
      );
      const required = Object.entries(query.parameters).filter(([, spec]) => spec.required).map(([param]) => param);
      tools.push({
        name: toolName(loaded.app.handle, name, taken, loaded.app.id),
        title: query.label,
        description: `${query.description} (App: ${loaded.app.name}. Returns at most ${query.limit} records; pass the cursor to get more.)`,
        inputSchema: {
          type: 'object',
          properties: { ...params, cursor: { type: 'string', description: 'From the previous result, to get the next page' } },
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: async ({ cursor, ...parameters }) =>
          runtime.runQuery(request, auth, loaded, name, { parameters, ...(typeof cursor === 'string' ? { cursor } : {}) }),
        summarize: (result) => {
          const page = result as { records: unknown[]; nextCursor: string | null };
          return `${page.records.length} record(s)${page.nextCursor ? ', and more: pass the cursor to continue' : ''}.`;
        },
      });
    }
  }
  return tools;
}

function actionTool(ctx: AppContext, runtime: AppRuntime, request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, name: string, tool: string): Tool {
  const action = loaded.definition.actions[name]!;
  const entity = loaded.definition.entities[action.entity]!;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const input of action.input) {
    if (input === 'owner') {
      properties['owner'] = { type: 'string', format: 'uuid', description: 'Who the record belongs to. Leave it out for the person you act for.' };
      continue;
    }
    const field = entity.fields.find((f) => f.name === input)!;
    properties[input] = fieldSchema(field, loaded.definition, action.operation);
    if (field.required && !('default' in field && field.default !== undefined) && !(input in action.set)) required.push(input);
  }
  const confirm =
    action.confirm === 'none'
      ? 'It runs straight away.'
      : `The person must confirm it before it commits (${action.confirm}): the call returns a proposal with a review link to give them.`;
  return {
    name: tool,
    title: action.label,
    description: `${action.description} (App: ${loaded.app.name}. ${confirm} Use dry_run to see the review card and any rule findings first.)`,
    inputSchema: {
      type: 'object',
      properties: {
        values: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
        ...(action.operation === 'update' ? { record_id: { type: 'string', format: 'uuid', description: `The ${action.entity} record to change` } } : {}),
        provenance: PROVENANCE_SCHEMA,
        dry_run: { type: 'boolean', description: 'Check the values and return the review card without changing anything' },
      },
      required: action.operation === 'update' ? ['values', 'record_id'] : ['values'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args) =>
      runtime.runAction(request, auth, loaded, name, {
        values: (args['values'] as Record<string, unknown>) ?? {},
        ...(typeof args['record_id'] === 'string' ? { recordId: args['record_id'] } : {}),
        ...(args['provenance'] !== undefined ? { provenance: args['provenance'] } : {}),
        ...(args['dry_run'] === true ? { dryRun: true } : {}),
      }),
    summarize: (result) => {
      const r = result as { status: string; proposal?: { reviewUrl: string; expiresAt: string }; findings?: Array<{ message: string }>; record?: { id: string } };
      if (r.status === 'needs_confirmation') {
        return `Waiting for the person to confirm. Give them this link to review and approve it: ${r.proposal!.reviewUrl} (it expires ${r.proposal!.expiresAt}).`;
      }
      if (r.status === 'preview') {
        const findings = r.findings?.length ? ` Rule findings: ${r.findings.map((f) => f.message).join('; ')}.` : ' No rule findings.';
        return `Preview only; nothing changed.${findings}`;
      }
      return `Done. Record ${r.record?.id}.`;
    },
  };
}

/** Tools for AI clients that build apps, such as Claude: the builder API, as the builder. */
function builderTools(ctx: AppContext, builder: AppBuilder, runtime: AppRuntime, request: FastifyRequest, auth: AuthContext): Tool[] {
  const app = async (args: Record<string, unknown>, action: string) => {
    if (typeof args['app_id'] !== 'string') throw new HttpError(400, 'invalid_arguments', 'app_id is required');
    const loaded = await ctx.apps.load(args['app_id']);
    await checkPermission(ctx, request, auth, action, appResource(ctx.org.id, loaded), { policy: await runtime.policy(loaded) });
    return loaded;
  };
  const appId = { app_id: { type: 'string', format: 'uuid' } };
  const definition = { definition: { type: 'object', description: 'A complete app definition. See describe_format.' } };
  return [
    {
      name: 'describe_format',
      title: 'Describe the app definition format',
      description:
        'The JSON Schema of app definitions, a complete example (an expense-claim app), and notes on conditions. Read it before writing a definition.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async () => ({
        schema: definitionJsonSchema(),
        example: EXPENSE_APP,
        notes: [
          'Conditions are JSON: {"eq": [a, b]}, "ne", "lt", "lte", "gt", "gte", {"in": [needle, [list]]}, {"exists": "record.field"}, {"all": [...]}, {"any": [...]}, {"not": c}. Operands are literals or {"ref": "record.<field>" | "principal.id" | "input.<parameter>"}.',
          'An empty field is missing: it never equals anything. Test for emptiness with exists.',
          'Entities and fields get stable IDs when first saved. Keep them when you edit a definition: a field that keeps its ID under a new name is a rename, and renames carry through to every reference.',
          'Actions need a description written for agents, and a confirmation level: none, preview or review.',
        ],
      }),
    },
    {
      name: 'list_apps',
      title: 'List apps',
      description: 'The apps you can build or use, with their IDs and revisions.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async () => ({ apps: await visibleApps(ctx, runtime, auth) }),
    },
    {
      name: 'create_app',
      title: 'Create an app',
      description: "Create an app in the person's personal space, optionally with a first definition. Its sandbox is ready at once.",
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, handle: { type: 'string', description: 'A short identifier; agent tool names start with it' }, description: { type: 'string' }, ...definition },
        required: ['name'],
        additionalProperties: false,
      },
      run: async (args) => {
        if (auth.actor.type !== 'user') throw new HttpError(403, 'person_required', 'Only people have personal spaces');
        const [space] = await ctx.db.select().from(spaces).where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, auth.actor.id)));
        if (!space) throw notFound('Personal space');
        await checkPermission(ctx, request, auth, 'app.create', spaceResource(ctx.org.id, space));
        const { appId, plan } = await builder.create(request, auth, space, {
          name: String(args['name'] ?? ''),
          ...(typeof args['handle'] === 'string' ? { handle: args['handle'] } : {}),
          ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
          ...(args['definition'] !== undefined ? { definition: args['definition'] } : {}),
        });
        return { app: await describeApp(ctx, runtime, auth, await ctx.apps.load(appId)), plan };
      },
    },
    {
      name: 'get_definition',
      title: "Read an app's definition",
      description: "An app's current definition and revision. Edit it, then plan_change or apply_change.",
      inputSchema: { type: 'object', properties: appId, required: ['app_id'], additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const loaded = await app(args, 'app.read');
        return { revision: loaded.app.currentRevision, definition: loaded.definition as StoredDefinition };
      },
    },
    {
      name: 'plan_change',
      title: 'Check a change',
      description: 'Validate a new definition and see what saving it would do (the migration steps, and how many records each destructive step touches), without saving.',
      inputSchema: { type: 'object', properties: { ...appId, ...definition }, required: ['app_id', 'definition'], additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async (args) => ({ plan: (await builder.plan(await app(args, 'app.edit'), args['definition'])).plan }),
    },
    {
      name: 'apply_change',
      title: 'Save a change',
      description:
        "Save a new definition to the app's sandbox, where it applies at once. A change that deletes data is refused here: the person must confirm it themselves, signed in.",
      inputSchema: {
        type: 'object',
        properties: { ...appId, ...definition, base_revision: { type: 'integer', description: 'The revision you edited, from get_definition' } },
        required: ['app_id', 'definition'],
        additionalProperties: false,
      },
      run: async (args) => {
        const loaded = await app(args, 'app.edit');
        const plan = await builder.save(request, auth, loaded, args['definition'], {
          ...(typeof args['base_revision'] === 'number' ? { baseRevision: args['base_revision'] } : {}),
          confirmDestructive: false,
        });
        return { plan };
      },
    },
  ];
}

function serve(
  ctx: AppContext,
  path: string,
  server: { name: string; instructions: string },
  tools: (request: FastifyRequest, auth: AuthContext) => Promise<Tool[]>,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(path, { config: { access: { kind: 'authenticated' } }, schema: { hide: true, body: z.unknown() } }, async (request, reply) => {
      const auth = requireAuth(request);
      const message = request.body as { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: Record<string, unknown> } | unknown[];
      if (Array.isArray(message) || typeof message !== 'object' || message === null || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return reply.status(400).send(rpcError(null, -32600, 'Invalid request'));
      }
      const { id, method, params = {} } = message;
      if (id === undefined) return reply.status(202).send(); // a notification, such as notifications/initialized
      switch (method) {
        case 'initialize': {
          const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: server.name, version: '0.1.0' },
              instructions: server.instructions,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list': {
          const list = await tools(request, auth);
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: list.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations ? { annotations } : {}) })) },
          };
        }
        case 'tools/call': {
          const name = params['name'];
          const args = (params['arguments'] ?? {}) as Record<string, unknown>;
          const tool = (await tools(request, auth)).find((t) => t.name === name);
          if (!tool) return reply.send(rpcError(id, -32602, `Unknown tool: ${String(name)}`));
          try {
            const result = await tool.run(args);
            const summary = tool.summarize?.(result);
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: summary ? `${summary}\n\n${JSON.stringify(result)}` : JSON.stringify(result) }],
                structuredContent: result,
              },
            };
          } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            // Tool errors go back to the model as results, so it can correct itself.
            const details = error.details !== undefined ? `\n${JSON.stringify(error.details)}` : '';
            return {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}${details}` }], structuredContent: { error: error.code, message: error.message, details: error.details ?? null } },
            };
          }
        }
        default:
          return reply.send(rpcError(id, -32601, `Method not found: ${method}`));
      }
    });
    app.get(path, { config: { access: { kind: 'authenticated' } }, schema: { hide: true } }, async (_request, reply) =>
      reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed', message: 'This server answers each request directly and offers no event stream' }),
    );
  };
}

export function mcpRoutes(ctx: AppContext, builder: AppBuilder, runtime: AppRuntime): FastifyPluginAsyncZod {
  return async (app) => {
    await app.register(
      serve(
        ctx,
        '/mcp',
        {
          name: 'ambit',
          instructions:
            'Tools here act for the signed-in person, within their permissions. Actions that need confirmation return a proposal: give the person its review link, and never claim it is done until they approve it. Report where each value came from in provenance.',
        },
        (request, auth) => capabilityTools(ctx, runtime, request, auth),
      ),
    );
    await app.register(
      serve(
        ctx,
        '/mcp/build',
        {
          name: 'ambit-builder',
          instructions:
            "Build apps as the signed-in person: read describe_format first, then create_app or get_definition, plan_change and apply_change. Changes apply at once to the person's sandbox; anything that deletes data waits for them.",
        },
        async (request, auth) => builderTools(ctx, builder, runtime, request, auth),
      ),
    );
  };
}
