import { applyEdits, DefinitionEdits, MAX_EDITS, runnable, TEMPLATES, type StoredDefinition, type StoredField } from '@platform/app-model';
import { spaces } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkPermission } from '../access/check.js';
import { spaceResource } from '../access/resources.js';
import { requireAuth } from '../access/rules.js';
import type { AppContext, AuthContext } from '../context.js';
import { HttpError, notFound, unprocessable } from '../errors.js';
import { changeRequestRequired, type AppBuilder } from './builder.js';
import { isTeamApp, type LoadedApp } from './catalog.js';
import type { Delivery } from '../delivery/service.js';
import { opsTools } from '../ops/tools.js';
import type { ProcessEngine } from '../processes/engine.js';
import { appResource } from './resources.js';
import { definitionGuide } from './guide.js';
import { describeApp, isNotLive, visibleApps } from './routes.js';
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

export interface Tool {
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

/**
 * The JSON Schema of a field's value, as an agent sends it. Line fields are required only on new
 * records. A file is sent by ID, after uploading it to `uploadUrl`.
 */
function fieldSchema(field: StoredField, definition: StoredDefinition, operation: 'create' | 'update', uploadUrl: string): Record<string, unknown> {
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
    case 'file':
      return {
        ...about,
        type: 'string',
        format: 'uuid',
        description: `The ID of a file you uploaded for the person: POST its content to ${uploadUrl}, with its type (${field.accept.join(' or ')}). Give its ID here.`,
      };
    case 'lines': {
      const lineEntity = definition.entities[field.entity]!;
      const properties: Record<string, unknown> = {
        id: { type: 'string', format: 'uuid', description: 'Leave it out for a new line. To change a line the record has, give its ID and the values to change.' },
      };
      const required: string[] = [];
      for (const f of lineEntity.fields) {
        properties[f.name] = fieldSchema(f, definition, operation, uploadUrl);
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
/** The tools of the apps the person may use, and whether any of those apps has a business process. */
async function capabilityTools(ctx: AppContext, runtime: AppRuntime, request: FastifyRequest, auth: AuthContext): Promise<{ tools: Tool[]; processes: boolean }> {
  const tools: Tool[] = [];
  const taken = new Set<string>();
  let processes = false;
  for (const summary of await visibleApps(ctx, runtime, auth)) {
    if (!summary.access.run) continue;
    // Agents use a team app in Prod. One that isn't live there yet offers no tools.
    const loaded = await ctx.apps.load(summary.id).catch((error: unknown) => {
      if (isNotLive(error)) return null;
      throw error;
    });
    if (!loaded) continue;
    if (Object.keys(runnable(loaded.definition).processes ?? {}).length) processes = true;
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
      if (query.summary) {
        const grouped = query.summary.group !== undefined;
        tools.push({
          name: toolName(loaded.app.handle, name, taken, loaded.app.id),
          title: query.label,
          description: `${query.description} (App: ${loaded.app.name}. ${
            grouped
              ? `Returns a number for each group, as { groups: [{ key, label, value }], other, more }: at most ${query.summary.limit} groups, the largest first or the latest periods. other totals the rest where they add up, and more counts them.`
              : 'Returns one number, as { value }.'
          } It counts only the records the person may read.)`,
          inputSchema: { type: 'object', properties: params, ...(required.length ? { required } : {}), additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false },
          run: async (parameters) => runtime.runQuery(request, auth, loaded, name, { parameters }),
          summarize: (result) => {
            if ('value' in (result as object)) return `The number is ${(result as { value: number | null }).value ?? 'empty'}.`;
            const { groups, more } = result as { groups: unknown[]; more: number };
            return `${groups.length} group(s)${more ? `, and ${more} more` : ''}.`;
          },
        });
        continue;
      }
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
  return { tools, processes };
}

const TaskId = z.uuid();
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The person's tasks in business processes (design §6.10): agents show them, and complete them as the person decides. */
function taskTools(engine: ProcessEngine, request: FastifyRequest, auth: AuthContext): Tool[] {
  return [
    {
      name: 'my_tasks',
      title: 'My tasks',
      description:
        "The person's tasks in Ambit's business processes: decisions that wait for them, or for a role of theirs, soonest due first. Each names its app, its record, its outcomes and when it is due. Show them to the person, and complete one only when they say which outcome.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => ({ tasks: await engine.inbox(auth, { status: 'open', limit: 50 }) }),
      summarize: (result) => `${(result as { tasks: unknown[] }).tasks.length} task(s) wait.`,
    },
    {
      name: 'complete_task',
      title: 'Complete a task',
      description:
        "Complete one of the person's tasks with the outcome they chose, such as approve. The outcome's action becomes a proposal, as any action an agent runs: give the person its review link. The task completes when they approve it.",
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', format: 'uuid', description: 'From my_tasks' },
          outcome: { type: 'string', description: "One of the task's outcomes, by name" },
          values: { type: 'object', description: "The input of the outcome's action, if it takes any" },
        },
        required: ['task_id', 'outcome'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (args) => {
        const id = TaskId.safeParse(args['task_id']);
        if (!id.success) throw unprocessable('invalid_task', 'Give the ID of a task from my_tasks');
        return engine.complete(request, auth, id.data, { outcome: String(args['outcome']), ...(isObject(args['values']) ? { values: args['values'] } : {}) });
      },
      summarize: (result) => {
        const done = result as { task: { name: string; status: string }; result: { status: string } | null };
        return done.result?.status === 'needs_confirmation' ? `${done.task.name} waits until the person approves the proposal.` : `${done.task.name} is ${done.task.status}.`;
      },
    },
  ];
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
    properties[input] = fieldSchema(field, loaded.definition, action.operation, new URL(`/v1/apps/${loaded.app.id}/files`, ctx.config.PUBLIC_BASE_URL).href);
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
function builderTools(ctx: AppContext, builder: AppBuilder, runtime: AppRuntime, delivery: Delivery, request: FastifyRequest, auth: AuthContext): Tool[] {
  const app = async (args: Record<string, unknown>, action: string) => {
    if (typeof args['app_id'] !== 'string') throw new HttpError(400, 'invalid_arguments', 'app_id is required');
    const found = await ctx.apps.ref(args['app_id']);
    await checkPermission(ctx, request, auth, action, appResource(ctx.org.id, found));
    return found;
  };
  /** The sandbox a change applies to: of a personal app or a working copy. A team app changes through change requests. */
  const sandbox = async (args: Record<string, unknown>) => {
    const found = await app(args, 'app.edit');
    if (isTeamApp(found)) throw changeRequestRequired(found);
    return ctx.apps.load(found.app.id);
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
      run: async () => definitionGuide(),
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
      description: `Create an app in the person's personal space, from a definition, from a template, or blank. Its sandbox is ready at once. Templates: ${TEMPLATES.map((t) => `${t.id} (${t.name})`).join(', ')}.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          handle: { type: 'string', description: 'A short identifier; agent tool names start with it' },
          description: { type: 'string' },
          ...definition,
          template: { type: 'string', enum: TEMPLATES.map((t) => t.id), description: 'Start from this template instead of a definition' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      run: async (args) => {
        if (auth.actor.type !== 'user') throw new HttpError(403, 'person_required', 'Only people have personal spaces');
        const [space] = await ctx.db.select().from(spaces).where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, auth.actor.id)));
        if (!space) throw notFound('Personal space');
        await checkPermission(ctx, request, auth, 'app.create', spaceResource(ctx.org.id, space));
        const template = typeof args['template'] === 'string' ? TEMPLATES.find((t) => t.id === args['template']) : undefined;
        if (args['template'] !== undefined && !template) throw notFound('Template');
        const start = template ? template.definition : args['definition'];
        const { appId, plan } = await builder.create(request, auth, space, {
          name: String(args['name'] ?? ''),
          ...(typeof args['handle'] === 'string' ? { handle: args['handle'] } : {}),
          ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
          ...(start !== undefined ? { definition: start } : {}),
        });
        return { app: await describeApp(ctx, runtime, auth, await ctx.apps.ref(appId)), plan };
      },
    },
    {
      name: 'get_definition',
      title: "Read an app's definition",
      description:
        "An app's current definition and revision. Edit it, then plan_change or apply_change. A team app's definition is its main line: change it in a working copy (start_working_copy), then submit_change.",
      inputSchema: { type: 'object', properties: appId, required: ['app_id'], additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const found = await app(args, 'app.read');
        return { revision: found.app.currentRevision, definition: await ctx.apps.mainDefinition(found) };
      },
    },
    {
      name: 'plan_change',
      title: 'Check a change',
      description: 'Validate a new definition and see what saving it would do (the migration steps, and how many records each destructive step touches), without saving.',
      inputSchema: { type: 'object', properties: { ...appId, ...definition }, required: ['app_id', 'definition'], additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async (args) => ({ plan: (await builder.plan(await sandbox(args), args['definition'])).plan }),
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
        const loaded = await sandbox(args);
        const plan = await builder.save(request, auth, loaded, args['definition'], {
          ...(typeof args['base_revision'] === 'number' ? { baseRevision: args['base_revision'] } : {}),
          confirmDestructive: false,
        });
        return { plan };
      },
    },
    {
      name: 'edit_definition',
      title: 'Change a definition with small edits',
      description:
        "Change an app's definition with JSON Patch edits: add, replace or remove a value at a JSON pointer, such as /entities/claim/fields/- for a new last field. They apply in order to the current definition, all or none, so you needn't send all of it. Without apply, the edits are only checked: the problems the checks find, or what saving would do. With apply, they are saved to the app's sandbox, as apply_change saves.",
      inputSchema: {
        type: 'object',
        properties: {
          ...appId,
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EDITS,
            items: {
              type: 'object',
              properties: { op: { enum: ['add', 'replace', 'remove'] }, path: { type: 'string', description: 'A JSON pointer' }, value: { description: 'The value, for add and replace' } },
              required: ['op', 'path'],
              additionalProperties: false,
            },
          },
          apply: { type: 'boolean', description: 'Save the edits to the sandbox; without it, only check them' },
          base_revision: { type: 'integer', description: 'The revision you edited, from get_definition' },
        },
        required: ['app_id', 'edits'],
        additionalProperties: false,
      },
      run: async (args) => {
        const loaded = await sandbox(args);
        const edits = DefinitionEdits.safeParse(args['edits']);
        if (!edits.success) throw new HttpError(400, 'invalid_arguments', 'edits are add, replace or remove edits, each with a JSON pointer path');
        const result = applyEdits(loaded.definition, edits.data);
        if (!result.ok) throw unprocessable('edit_failed', `Nothing changed: edit ${result.index + 1} failed: ${result.message}`);
        if (args['apply'] !== true) return { plan: (await builder.plan(loaded, result.definition)).plan };
        const plan = await builder.save(request, auth, loaded, result.definition, {
          ...(typeof args['base_revision'] === 'number' ? { baseRevision: args['base_revision'] } : {}),
          confirmDestructive: false,
        });
        return { plan };
      },
    },
    {
      name: 'start_working_copy',
      title: 'Edit a team app in your space',
      description:
        "A team app changes through change requests. This makes (or finds) the person's working copy of it in their personal space: change the copy with apply_change, then submit_change.",
      inputSchema: { type: 'object', properties: appId, required: ['app_id'], additionalProperties: false },
      run: async (args) => {
        if (auth.actor.type !== 'user') throw new HttpError(403, 'person_required', 'Only people have personal spaces');
        const team = await app(args, 'app.edit');
        const { appId: copyId, created, samples } = await delivery.workingCopy(request, auth, team);
        return { app: await describeApp(ctx, runtime, auth, await ctx.apps.ref(copyId)), created, sampleRecords: samples };
      },
    },
    {
      name: 'submit_change',
      title: 'Submit a change for review',
      description:
        "Submit the changes in a working copy: opens a change request in the team space, with automatic checks and a preview, or brings the open one up to date. Reviewers approve it; the person can't approve their own change.",
      inputSchema: {
        type: 'object',
        properties: { ...appId, title: { type: 'string', description: 'What the change does, in a few words' }, description: { type: 'string' } },
        required: ['app_id'],
        additionalProperties: false,
      },
      run: async (args) => {
        if (auth.actor.type !== 'user') throw new HttpError(403, 'person_required', 'Only people submit changes');
        const copy = await app(args, 'app.edit');
        if (!copy.app.workingCopyOf) throw new HttpError(422, 'not_a_working_copy', 'Submit from a working copy: see start_working_copy');
        await checkPermission(ctx, request, auth, 'change.open', appResource(ctx.org.id, await ctx.apps.ref(copy.app.workingCopyOf)));
        const cr = await delivery.submit(request, auth, await ctx.apps.load(copy.app.id), {
          ...(typeof args['title'] === 'string' ? { title: args['title'] } : {}),
          ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
        });
        return { changeRequest: { id: cr.id, number: cr.number, title: cr.title, status: cr.status, checks: cr.checks } };
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

export function mcpRoutes(ctx: AppContext, builder: AppBuilder, runtime: AppRuntime, delivery: Delivery, processes: ProcessEngine): FastifyPluginAsyncZod {
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
        async (request, auth) => {
          const { tools, processes: used } = await capabilityTools(ctx, runtime, request, auth);
          return used ? [...tools, ...taskTools(processes, request, auth)] : tools;
        },
      ),
    );
    await app.register(
      serve(
        ctx,
        '/mcp/build',
        {
          name: 'ambit-builder',
          instructions:
            "Build apps as the signed-in person: read describe_format first, then create_app or get_definition, plan_change and apply_change. Changes apply at once to the person's sandbox; anything that deletes data waits for them. A team app changes through change requests: start_working_copy, change the copy, then submit_change for review.",
        },
        async (request, auth) => builderTools(ctx, builder, runtime, delivery, request, auth),
      ),
    );
    await app.register(
      serve(
        ctx,
        '/mcp/ops',
        {
          name: 'ambit-ops',
          instructions:
            "Operate apps within the caller's operator permissions: watch process instances, try stuck work again, cancel an instance, throw a signal, and give a task to someone else. Start with list_apps. Cancelling ends an instance for good: confirm with the person first. Deciding tasks, approving and deleting data are not here: they stay with people.",
        },
        async (request, auth) => opsTools(ctx, runtime, processes, request, auth),
      ),
    );
  };
}
