import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';

/** Liveness and readiness probes for Kubernetes. */
export function healthRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/healthz', { config: { access: { kind: 'public' } }, schema: { tags: ['health'] } }, async () => ({ status: 'ok' }));

    app.get('/readyz', { config: { access: { kind: 'public' } }, schema: { tags: ['health'] } }, async (_request, reply) => {
      try {
        await ctx.db.execute(sql`select 1`);
        return { status: 'ready' };
      } catch {
        return reply.status(503).send({ status: 'unavailable', reason: 'database' });
      }
    });
  };
}
