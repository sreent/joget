import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkAnyPermission } from '../access/check.js';
import { once, requireAuth } from '../access/rules.js';
import type { LoadedApp } from '../apps/catalog.js';
import { appResource } from '../apps/resources.js';
import { envOf } from '../apps/routes.js';
import type { AppRuntime } from '../apps/runtime.js';
import { AppParams, EnvQuery, SkillCallOut } from '../apps/schemas.js';
import type { AppContext } from '../context.js';

/**
 * The a7c skill calls of an app's actions, for whoever runs the app: its owner in a personal space,
 * operators in a team space. They see how each call went, and can try a failed one again.
 */
export function skillRoutes(ctx: AppContext, runtime: AppRuntime): FastifyPluginAsyncZod {
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  // The check needs the space's kind, so the handler makes it, with the same audited refusal an access rule gives.
  const allow = async (request: FastifyRequest, loaded: LoadedApp, operation: 'ops.monitor.read' | 'ops.job.retry') => {
    const actions = loaded.space.kind === 'personal' ? ['app.edit'] : [operation];
    await checkAnyPermission(ctx, request, requireAuth(request), actions, appResource(ctx.org.id, loaded), { policy: await runtime.policy(loaded) });
  };

  return async (app) => {
    app.get(
      '/v1/apps/:appId/skill-calls',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['apps'],
          summary: "The a7c skills an app's actions started in an environment, newest first",
          params: AppParams,
          querystring: EnvQuery.extend({
            status: z.enum(['pending', 'started', 'failed']).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: { 200: z.object({ calls: z.array(SkillCallOut) }) },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await allow(request, loaded, 'ops.monitor.read');
        return { calls: await runtime.skillCalls(loaded, { limit: request.query.limit, ...(request.query.status ? { status: request.query.status } : {}) }) };
      },
    );

    app.post(
      '/v1/apps/:appId/skill-calls/:callId/retry',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['apps'],
          summary: 'Try a failed skill call again. a7c gets the same idempotency key, so it never starts a run twice',
          params: AppParams.extend({ callId: z.uuid() }),
          querystring: EnvQuery,
          response: { 200: SkillCallOut },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        await allow(request, loaded, 'ops.job.retry');
        return runtime.retrySkillCall(request, loaded, request.params.callId);
      },
    );
  };
}
