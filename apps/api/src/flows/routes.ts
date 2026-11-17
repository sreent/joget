import { NAME_PATTERN } from '@platform/app-model';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkPermission, principalEnv } from '../access/check.js';
import { requireAuth } from '../access/rules.js';
import { flowResource } from '../apps/resources.js';
import { envOf } from '../apps/routes.js';
import type { AppRuntime } from '../apps/runtime.js';
import { AppParams, EnvQuery } from '../apps/schemas.js';
import { withAppTransaction } from '../apps/transaction.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import type { FlowEngine, FlowResult } from './engine.js';

const FlowOut = z.object({
  /** What the flow gave back: a value, a record or a list of records. */
  output: z.unknown(),
  findings: z.array(z.object({ flow: z.string(), message: z.string() })),
  writes: z.object({ created: z.int(), changed: z.int(), deleted: z.int() }),
  /** A dry run did all of it, and then undid it. */
  dryRun: z.boolean(),
});

/** A dry run's result, on its way out of the transaction that it undoes. */
class DryRun {
  constructor(readonly result: FlowResult) {}
}

/**
 * Running an app's flows through the API (design §6.2): for the roles that name them, and for the
 * owner of a personal app, who tries them while building. A dry run shows what a flow would do,
 * and undoes it.
 */
export function flowRoutes(ctx: AppContext, runtime: AppRuntime, flows: FlowEngine): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/v1/apps/:appId/flows/:flow/run',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['flows'],
          summary: 'Run a flow of the app. Records and lists in its input go by their IDs. A dry run does it all, and then undoes it',
          params: AppParams.extend({ flow: z.string().regex(NAME_PATTERN) }),
          querystring: EnvQuery,
          body: z.strictObject({ input: z.record(z.string(), z.unknown()).default({}), dryRun: z.boolean().default(false) }),
          response: { 200: FlowOut },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const loaded = await ctx.apps.load(request.params.appId, envOf(request));
        const name = request.params.flow;
        const flow = loaded.definition.flows?.[name];
        if (!flow) throw notFound('Flow');
        await checkPermission(ctx, request, auth, 'flow.run', flowResource(ctx.org.id, loaded, name), { policy: await runtime.policy(loaded) });
        const { dryRun } = request.body;
        const caller = {
          writer: runtime.writerFor(request, auth),
          principal: principalEnv(auth),
          // A dry run changes nothing, so a token may try a flow that deletes.
          auth: dryRun ? null : auth,
          trigger: { kind: 'api' as const, name },
        };
        const shape = (result: FlowResult, dry: boolean) => ({ output: result.output ?? null, findings: [...result.findings], writes: result.writes, dryRun: dry });
        try {
          const result = await withAppTransaction(ctx.pool, loaded.env, 'records', async (tx) => {
            const input = await flows.inputFromIds(tx, loaded, flow, request.body.input);
            const ran = await flows.run(tx, loaded, name, input, caller);
            if (dryRun) throw new DryRun(ran);
            return ran;
          });
          return shape(result, false);
        } catch (error) {
          if (error instanceof DryRun) return shape(error.result, true);
          throw error;
        }
      },
    );
  };
}
