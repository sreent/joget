import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { flowWaits, NAME_PATTERN } from '@platform/app-model';
import { appEnvironments } from '@platform/db';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { once, requireAuth } from '../access/rules.js';
import { appResource } from '../apps/resources.js';
import { envOf } from '../apps/routes.js';
import type { Writer } from '../apps/runtime.js';
import { EnvQuery } from '../apps/schemas.js';
import { withAppTransaction } from '../apps/transaction.js';
import { recordAudit } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import { HttpError, notFound, unprocessable } from '../errors.js';
import type { FlowEngine } from '../flows/engine.js';
import type { Secrets } from './secrets.js';
import { valueAt } from './services.js';

/*
 * Integration's routes (design §6.13). Builders see whether each environment keeps the secrets its
 * connections and webhooks need, and never the secrets themselves. Whoever manages connections
 * there sets them: a personal app's owner, or a team space's admins. Another system's request to a
 * webhook runs its flow, once its signature shows it holds the environment's key.
 */

const SecretOut = z.object({ set: z.boolean(), setAt: z.string().nullable() });
const Params = z.object({ appId: z.uuid(), name: z.string().regex(NAME_PATTERN) });
/** How long a webhook's signed request stays good: a signature older than this is refused, so a copy can't be sent again later. */
const SIGNATURE_WINDOW_MS = 5 * 60_000;

/** A webhook's signature: the HMAC-SHA256 of its time and its body, under the environment's key. */
export function webhookSignature(key: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function integrationRoutes(ctx: AppContext, flows: FlowEngine, secrets: Secrets): FastifyPluginAsyncZod {
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  const appRule = (action: string) => ({
    kind: 'permission' as const,
    action,
    resource: async (request: FastifyRequest) => appResource(ctx.org.id, await theApp(request)),
  });
  const raw = new WeakMap<FastifyRequest, string>();

  return async (app) => {
    app.get(
      '/v1/apps/:appId/connections',
      {
        config: { access: appRule('app.read') },
        schema: {
          tags: ['integration'],
          summary: "The app's connections and webhooks, with whether the environment keeps the secret each needs. Never the secrets",
          params: z.object({ appId: z.uuid() }),
          querystring: EnvQuery,
          response: {
            200: z.object({
              connections: z.array(
                z.object({
                  name: z.string(),
                  kind: z.enum(['service', 'teams']),
                  label: z.string(),
                  host: z.string().nullable(),
                  needsSecret: z.boolean(),
                  secret: SecretOut,
                }),
              ),
              webhooks: z.array(z.object({ name: z.string(), label: z.string(), flow: z.string(), url: z.string(), secret: SecretOut })),
            }),
          },
        },
      },
      async (request) => {
        const loaded = await theApp(request);
        const states = await secrets.states(ctx.db, loaded.env.id);
        const state = (kind: string, name: string) => states.get(`${kind}/${name}`) ?? { set: false, setAt: null };
        const base = ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '');
        return {
          connections: Object.entries(loaded.definition.connections ?? {}).map(([name, connection]) => ({
            name,
            kind: connection.kind,
            label: connection.label,
            host: connection.kind === 'service' && URL.canParse(connection.url) ? new URL(connection.url).host : null,
            needsSecret: connection.kind === 'teams' || connection.auth.type !== 'none',
            secret: state('connection', name),
          })),
          webhooks: Object.entries(loaded.definition.webhooks ?? {}).map(([name, hook]) => ({
            name,
            label: hook.label,
            flow: hook.flow,
            url: `${base}/v1/hooks/${loaded.env.id}/${name}`,
            secret: state('webhook', name),
          })),
        };
      },
    );

    app.put(
      '/v1/apps/:appId/connections/:name/secret',
      {
        config: { access: appRule('connection.manage') },
        schema: {
          tags: ['integration'],
          summary:
            "Set the secret a connection proves who it is with, in this environment: a token, a password, a key, or a Teams channel's address. Nothing shows it again",
          params: Params,
          querystring: EnvQuery,
          body: z.object({ value: z.string().min(1).max(4000) }),
          response: { 200: SecretOut },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        const connection = loaded.definition.connections?.[request.params.name];
        if (!connection) throw notFound('Connection');
        const address = /^https:\/\//.test(request.body.value) || (ctx.config.OUTBOUND_ALLOW_HTTP && /^http:\/\//.test(request.body.value));
        if (connection.kind === 'teams' && !address) throw unprocessable('invalid_values', "Give the Teams channel's webhook address, as https://");
        const state = await secrets.set(ctx.db, { id: loaded.env.id, appId: loaded.app.id }, 'connection', request.params.name, request.body.value, auth);
        await recordAudit(
          ctx.db,
          { orgId: ctx.org.id, actor: { type: auth.actor.type, id: auth.actor.id, via: 'api' }, now: ctx.now(), context: {} },
          {
            action: 'connection.secret.set',
            target: { type: 'connection', id: request.params.name, name: connection.label },
            spaceId: loaded.space.id,
            appId: loaded.app.id,
            env: loaded.env.kind,
          },
        );
        return state;
      },
    );

    app.delete(
      '/v1/apps/:appId/connections/:name/secret',
      {
        config: { access: appRule('connection.manage') },
        schema: {
          tags: ['integration'],
          summary: "Remove a connection's secret from this environment: its calls fail until a new one is set",
          params: Params,
          querystring: EnvQuery,
          response: { 200: SecretOut },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        if (await secrets.clear(ctx.db, loaded.env.id, 'connection', request.params.name)) {
          await recordAudit(
            ctx.db,
            { orgId: ctx.org.id, actor: { type: auth.actor.type, id: auth.actor.id, via: 'api' }, now: ctx.now(), context: {} },
            {
              action: 'connection.secret.clear',
              target: { type: 'connection', id: request.params.name },
              spaceId: loaded.space.id,
              appId: loaded.app.id,
              env: loaded.env.kind,
            },
          );
        }
        return { set: false, setAt: null };
      },
    );

    app.post(
      '/v1/apps/:appId/webhooks/:name/secret',
      {
        config: { access: appRule('connection.manage') },
        schema: {
          tags: ['integration'],
          summary:
            'Make a new key for a webhook in this environment, in place of the one it had. The key is shown this once: the other system signs each request with it',
          params: Params,
          querystring: EnvQuery,
          response: { 200: z.object({ key: z.string(), url: z.string(), setAt: z.string() }) },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        const hook = loaded.definition.webhooks?.[request.params.name];
        if (!hook) throw notFound('Webhook');
        const key = randomBytes(32).toString('base64url');
        const state = await secrets.set(ctx.db, { id: loaded.env.id, appId: loaded.app.id }, 'webhook', request.params.name, key, auth);
        await recordAudit(
          ctx.db,
          { orgId: ctx.org.id, actor: { type: auth.actor.type, id: auth.actor.id, via: 'api' }, now: ctx.now(), context: {} },
          {
            action: 'webhook.key.make',
            target: { type: 'webhook', id: request.params.name, name: hook.label },
            spaceId: loaded.space.id,
            appId: loaded.app.id,
            env: loaded.env.kind,
          },
        );
        return { key, url: `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/hooks/${loaded.env.id}/${request.params.name}`, setAt: state.setAt! };
      },
    );

    // Another system's request: its body stays as it came, for its signature.
    await app.register(async (plugin) => {
      const hooks = plugin.withTypeProvider<ZodTypeProvider>();
      hooks.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (request, body, done) => {
        const text = typeof body === 'string' ? body : body.toString('utf8');
        raw.set(request, text);
        try {
          done(null, text ? JSON.parse(text) : {});
        } catch {
          done(new HttpError(400, 'bad_json', 'The body is not JSON'), undefined);
        }
      });
      hooks.post(
        '/v1/hooks/:environmentId/:name',
        {
          config: { access: { kind: 'public' } },
          schema: {
            tags: ['integration'],
            summary:
              "Another system runs a webhook's flow. It signs each request: X-A3T-Timestamp, the time in seconds, and X-A3T-Signature, sha256= and the HMAC-SHA256 in hex of the time, a dot and the body, under the webhook's key",
            params: z.object({ environmentId: z.uuid(), name: z.string().regex(NAME_PATTERN) }),
            response: { 200: z.object({ output: z.unknown(), findings: z.array(z.string()) }) },
          },
        },
        async (request) => {
          const { environmentId, name } = request.params;
          // Whatever is wrong, the caller learns only that its request isn't one this hook takes.
          const refused = () => new HttpError(401, 'not_signed', 'The request is not signed with this webhook’s key');
          const [env] = await ctx.db
            .select({ appId: appEnvironments.appId, status: appEnvironments.status })
            .from(appEnvironments)
            .where(eq(appEnvironments.id, environmentId));
          if (!env || env.status !== 'active') throw refused();
          const loaded = await ctx.apps.load(env.appId, { id: environmentId });
          const hook = loaded.definition.webhooks?.[name];
          const key = hook ? await secrets.reveal(ctx.db, environmentId, 'webhook', name) : undefined;
          const timestamp = String(request.headers['x-a3t-timestamp'] ?? '');
          const signature = String(request.headers['x-a3t-signature'] ?? '');
          const at = Number(timestamp) * 1000;
          if (!hook || !key || !Number.isFinite(at) || Math.abs(ctx.now().getTime() - at) > SIGNATURE_WINDOW_MS) throw refused();
          const expected = Buffer.from(webhookSignature(key, timestamp, raw.get(request) ?? ''));
          const given = Buffer.from(signature);
          if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw refused();
          const flow = loaded.definition.flows?.[hook.flow];
          if (!flow || flowWaits(flow, loaded.definition.flows) || loaded.app.movedTo) throw notFound('Webhook');
          const fromRequest = Object.fromEntries(Object.entries(hook.input).map(([input, place]) => [input, valueAt(request.body, place)]));
          const writer: Writer = {
            actorId: loaded.app.id,
            scope: (now) => ({ orgId: ctx.org.id, now, actor: { type: 'system', id: `webhook:${name}`, via: 'system' }, context: { webhook: name } }),
            history: { actorType: 'webhook', actorId: loaded.app.id, onBehalfOf: null },
          };
          const result = await withAppTransaction(ctx.pool, loaded.env, 'records', async (tx) => {
            const input = await flows.inputFromIds(tx, loaded, flow, fromRequest);
            return flows.run(tx, loaded, hook.flow, input, { writer, principal: {}, auth: null, trigger: { kind: 'webhook', name } });
          });
          return { output: result.output ?? null, findings: result.findings.map((finding) => finding.message) };
        },
      );
    });
  };
}
