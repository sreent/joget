import type { FastifyRequest } from 'fastify';
import { checkAnyPermission } from '../access/check.js';
import type { LoadedApp } from '../apps/catalog.js';
import { appResource } from '../apps/resources.js';
import type { AppRuntime } from '../apps/runtime.js';
import type { AppContext, AuthContext } from '../context.js';
import { notFound } from '../errors.js';
import type { ProcessEngine, TaskView } from './engine.js';

/*
 * Operating an app: watching its processes, trying stuck work again, and steering
 * its processes. The owner of a personal app operates it. In a team space, operators do, with the
 * ops permissions. Steering a process (cancelling it, throwing a signal) needs process.admin in
 * both. The API's routes and the operators' MCP tools share these checks.
 */

export type Operation = 'ops.monitor.read' | 'ops.job.retry' | 'process.admin';

const actionsFor = (loaded: LoadedApp, operation: Operation): string[] => (loaded.space.kind === 'personal' && operation !== 'process.admin' ? ['app.edit'] : [operation]);

/** Refuse unless the caller may do the operation on the app, with the audited refusal of an access rule. */
export async function requireOperator(ctx: AppContext, runtime: AppRuntime, request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, operation: Operation): Promise<void> {
  await checkAnyPermission(ctx, request, auth, actionsFor(loaded, operation), appResource(ctx.org.id, loaded), { policy: await runtime.policy(loaded) });
}

/** Whether the caller may do the operation on the app. */
export async function operates(ctx: AppContext, runtime: AppRuntime, auth: AuthContext, loaded: LoadedApp, operation: Operation): Promise<boolean> {
  const policy = await runtime.policy(loaded);
  for (const action of actionsFor(loaded, operation)) {
    if ((await ctx.policy.authorize(auth.principal, action, appResource(ctx.org.id, loaded), undefined, policy)).allowed) return true;
  }
  return false;
}

/** Give a task to someone else who holds its role: the caller's own task, or any task of an app that they operate. */
export async function reassignTask(
  ctx: AppContext,
  runtime: AppRuntime,
  engine: ProcessEngine,
  request: FastifyRequest,
  auth: AuthContext,
  taskId: string,
  to: string,
): Promise<TaskView> {
  const place = await engine.taskPlace(taskId);
  if (!place) throw notFound('Task');
  const loaded = await ctx.apps.load(place.appId, { id: place.environmentId });
  const action = loaded.space.kind === 'personal' ? 'app.edit' : 'ops.task.reassign';
  const operator = (await ctx.policy.authorize(auth.principal, action, appResource(ctx.org.id, loaded), undefined, await runtime.policy(loaded))).allowed;
  return engine.reassign(request, auth, taskId, to, { operator });
}
