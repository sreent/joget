import { NAME_PATTERN } from '@platform/app-model';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { envSelector, type LoadedApp } from '../apps/catalog.js';
import type { Tool } from '../apps/mcp.js';
import { visibleApps } from '../apps/routes.js';
import type { AppRuntime } from '../apps/runtime.js';
import { EnvQuery } from '../apps/schemas.js';
import type { AppContext, AuthContext } from '../context.js';
import { forbidden, unprocessable } from '../errors.js';
import { searchPeople } from '../people/routes.js';
import type { ProcessEngine } from '../processes/engine.js';
import { operates, reassignTask, requireOperator, type Operation } from '../processes/operators.js';

/*
 * The operators' MCP tools (`/mcp/ops`): watch an app's process instances and a7c skill calls, try
 * stuck or failed work again, cancel an instance, throw a signal and move a task. They do what the
 * API's operator routes do, with the same checks. Deciding tasks, approving and deleting data are
 * not here: those steps stay with people (design §5.7).
 */

const AppArgs = z.strictObject({
  app_id: z.uuid().describe('From list_apps'),
  env: EnvQuery.shape.env,
});
const InstanceArgs = AppArgs.extend({ instance_id: z.uuid().describe('From list_instances') });

/** The tool's arguments, checked against its schema. */
function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw unprocessable('invalid_arguments', z.prettifyError(parsed.error));
  return parsed.data;
}

/** A tool whose schema checks its arguments and describes them to the client. */
function tool<T>(spec: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodType<T>;
  readonly annotations: Record<string, unknown>;
  readonly run: (args: T) => Promise<unknown>;
  readonly summarize?: (result: unknown) => string;
}): Tool {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(spec.input, { io: 'input' }) as Record<string, unknown>;
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema,
    annotations: spec.annotations,
    run: (args) => spec.run(parse(spec.input, args)),
    ...(spec.summarize ? { summarize: spec.summarize } : {}),
  };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function opsTools(ctx: AppContext, runtime: AppRuntime, engine: ProcessEngine, request: FastifyRequest, auth: AuthContext): Tool[] {
  /** The app in the environment that the arguments name, once the caller may do the operation there. */
  const operated = async (args: z.infer<typeof AppArgs>, operation: Operation): Promise<LoadedApp> => {
    const loaded = await ctx.apps.load(args.app_id, envSelector(args.env));
    await requireOperator(ctx, runtime, request, auth, loaded, operation);
    return loaded;
  };
  const watching = { readOnlyHint: true, openWorldHint: false };

  return [
    tool({
      name: 'list_apps',
      title: 'Apps you operate',
      description:
        'The apps you operate, with the environments where you operate them: your own personal apps, and team apps where you are an operator. Start here.',
      input: z.strictObject({}),
      annotations: watching,
      run: async () => {
        const operated: Array<{ id: string; name: string; kind: 'personal' | 'team'; environments: string[] }> = [];
        for (const app of await visibleApps(ctx, runtime, auth)) {
          const kinds = app.kind === 'team' ? (app.environments ?? []).map((env) => env.kind).filter((kind) => kind === 'prod' || kind === 'staging') : ['sandbox' as const];
          const environments: string[] = [];
          for (const kind of kinds) {
            const loaded = await ctx.apps.load(app.id, kind === 'sandbox' ? 'default' : kind).catch(() => null);
            if (loaded && (await operates(ctx, runtime, auth, loaded, 'ops.monitor.read'))) environments.push(kind);
          }
          if (environments.length) operated.push({ id: app.id, name: app.name, kind: app.kind, environments });
        }
        return { apps: operated };
      },
      summarize: (result) => `You operate ${count((result as { apps: unknown[] }).apps.length, 'app')}.`,
    }),
    tool({
      name: 'list_instances',
      title: 'Process instances',
      description:
        "An app's process instances in an environment, newest first: where each one waits, and which are stuck where an operator must try again. env is prod (the default), staging or a preview's environment ID; leave it out for a personal app.",
      input: AppArgs.extend({
        status: z.enum(['running', 'completed', 'cancelled']).optional(),
        stuck: z.boolean().optional().describe('Only the instances that are stuck'),
        record_id: z.uuid().optional().describe('Only the instances of this record'),
        limit: z.int().min(1).max(200).default(50),
      }),
      annotations: watching,
      run: async (args) => {
        const loaded = await operated(args, 'ops.monitor.read');
        const instances = await engine.instances(loaded, {
          limit: args.limit,
          ...(args.status ? { status: args.status } : {}),
          ...(args.stuck ? { stuck: true } : {}),
          ...(args.record_id ? { recordId: args.record_id } : {}),
        });
        return { instances };
      },
      summarize: (result) => {
        const { instances } = result as { instances: Array<{ stuck: unknown[] }> };
        const stuck = instances.filter((instance) => instance.stuck.length).length;
        return `${count(instances.length, 'instance')}${stuck ? `, ${stuck} stuck` : ''}.`;
      },
    }),
    tool({
      name: 'get_instance',
      title: 'A process instance',
      description: 'One process instance: its tasks, where it waits, why it is stuck, and what happened in it, oldest first.',
      input: InstanceArgs,
      annotations: watching,
      run: async (args) => engine.instance(await operated(args, 'ops.monitor.read'), args.instance_id),
    }),
    tool({
      name: 'retry_instance',
      title: 'Try a stuck instance again',
      description:
        'Try a stuck instance again from where it stopped. Fix the cause first, such as a value of the record or a step of the definition: get_instance says why it is stuck.',
      input: InstanceArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (args) => engine.retry(request, await operated(args, 'ops.job.retry'), args.instance_id),
    }),
    tool({
      name: 'cancel_instance',
      title: 'Cancel an instance',
      description: 'End a running instance where it is. Its open tasks and timers end with it. This cannot be undone: confirm with the person first.',
      input: InstanceArgs,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      run: async (args) => engine.cancel(request, await operated(args, 'process.admin'), args.instance_id),
    }),
    tool({
      name: 'throw_signal',
      title: 'Throw a signal',
      description:
        "Throw a signal to every process of the app that waits for it, such as a change of policy. Name a record's entity and ID to start, on that record, the processes that the signal starts.",
      input: AppArgs.extend({
        name: z.string().regex(NAME_PATTERN, 'Use lowercase letters, digits and underscores, starting with a letter'),
        entity: z.string().regex(NAME_PATTERN).optional(),
        record_id: z.uuid().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (args) => {
        if ((args.entity === undefined) !== (args.record_id === undefined)) throw unprocessable('record_incomplete', 'Name both the entity and the record, or neither');
        const loaded = await operated(args, 'process.admin');
        const signal = await engine.throwSignal(request, loaded, args.name, args.entity && args.record_id ? { entity: args.entity, id: args.record_id } : null);
        return { id: signal.id, name: signal.name, status: signal.status, heard: signal.heard, started: signal.started };
      },
    }),
    tool({
      name: 'reassign_task',
      title: 'Give a task to someone else',
      description: 'Give an open task to someone else who holds its role, for example while its assignee is away. Find the person with find_people.',
      input: z.strictObject({ task_id: z.uuid().describe('From get_instance'), user_id: z.uuid().describe('From find_people') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (args) => reassignTask(ctx, runtime, engine, request, auth, args.task_id, args.user_id),
    }),
    tool({
      name: 'find_people',
      title: 'Find people',
      description: 'Find active people by part of their name or email, for reassign_task.',
      input: z.strictObject({ search: z.string().trim().min(2).max(100) }),
      annotations: watching,
      run: async (args) => {
        if (auth.actor.type !== 'user') throw forbidden('person_required', 'Only people, and agents acting for them, look people up');
        return { people: await searchPeople(ctx, args.search) };
      },
    }),
    tool({
      name: 'list_skill_calls',
      title: 'Skill calls',
      description: "The a7c skills that an app's actions started, newest first. A failed call says why; try it again with retry_skill_call.",
      input: AppArgs.extend({ status: z.enum(['pending', 'started', 'failed']).optional(), limit: z.int().min(1).max(200).default(50) }),
      annotations: watching,
      run: async (args) => ({ calls: await runtime.skillCalls(await operated(args, 'ops.monitor.read'), { limit: args.limit, ...(args.status ? { status: args.status } : {}) }) }),
      summarize: (result) => `${count((result as { calls: unknown[] }).calls.length, 'call')}.`,
    }),
    tool({
      name: 'retry_skill_call',
      title: 'Try a failed skill call again',
      description: 'Try a failed skill call again. a7c gets the same idempotency key, so it never starts a run twice.',
      input: AppArgs.extend({ call_id: z.uuid().describe('From list_skill_calls') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      run: async (args) => runtime.retrySkillCall(request, await operated(args, 'ops.job.retry'), args.call_id),
    }),
  ];
}
