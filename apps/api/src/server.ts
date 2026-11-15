import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { installAccessControl, requireAccessRules, type RouteAccess } from './access/enforce.js';
import { accessRoutes } from './access/routes.js';
import { auditRoutes } from './audit/routes.js';
import { agentRoutes } from './agents/routes.js';
import { AppBuilder } from './apps/builder.js';
import { mcpRoutes } from './apps/mcp.js';
import { proposalRoutes } from './apps/proposal-routes.js';
import { appRoutes } from './apps/routes.js';
import { AppRuntime } from './apps/runtime.js';
import { runtimeRoutes } from './apps/runtime-routes.js';
import { authRoutes } from './auth/routes.js';
import { designRoutes } from './design/routes.js';
import type { AppContext } from './context.js';
import { HttpError } from './errors.js';
import { healthRoutes } from './health/routes.js';
import { spaceRoutes } from './spaces/routes.js';
import { tokenRoutes } from './tokens/routes.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface Server {
  readonly app: FastifyInstance;
  /** Every route with its declared access rule, for review and tests. */
  readonly routes: readonly RouteAccess[];
}

export async function buildServer(ctx: AppContext, options: { logger?: FastifyServerOptions['logger'] } = {}): Promise<Server> {
  const app = Fastify({
    logger: options.logger ?? {
      level: ctx.config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: ctx.config.TRUST_PROXY,
    requestIdHeader: false,
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    exposeHeadRoutes: false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Order matters: the access-rule check must see every route, and cookies must be parsed
  // before sessions are authenticated.
  const routes = requireAccessRules(app);
  await app.register(cookie, { secret: ctx.config.COOKIE_SECRET });
  await app.register(helmet);
  await app.register(swagger, {
    openapi: {
      info: { title: 'Ambit API', version: '0.1.0', description: 'Governance kernel and capability core: identity, spaces, roles and permission sets, apps, records, actions, queries, proposals, audit.' },
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: ctx.config.SESSION_COOKIE_NAME },
          token: { type: 'http', scheme: 'bearer', description: 'A platform API token (plt_pat_... or plt_sat_...)' },
        },
      },
      security: [{ session: [] }, { token: [] }],
    },
    transform: jsonSchemaTransform,
  });
  installAccessControl(app, ctx);

  app.setErrorHandler((error, request, reply) => {
    // People who open a review link before signing in are sent to sign in, and then back.
    if (error instanceof HttpError && error.statusCode === 401 && request.method === 'GET' && request.url.startsWith('/review/')) {
      return reply.redirect(`/auth/login?returnTo=${encodeURIComponent(request.url)}`);
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({ error: 'invalid_request', message: 'The request is not valid', details: error.validation });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'A response did not match its schema');
      return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
    }
    const { statusCode, code, message } = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const status = typeof statusCode === 'number' ? statusCode : 500;
    if (status < 500) {
      return reply.status(status).send({
        error: typeof code === 'string' ? code : 'bad_request',
        message: typeof message === 'string' ? message : 'Bad request',
      });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'not_found', message: 'No such route' }));

  await app.register(healthRoutes(ctx));
  await app.register(authRoutes(ctx));
  await app.register(spaceRoutes(ctx));
  await app.register(accessRoutes(ctx));
  await app.register(auditRoutes(ctx));
  await app.register(tokenRoutes(ctx));
  const builder = new AppBuilder(ctx);
  const runtime = new AppRuntime(ctx);
  await app.register(appRoutes(ctx, builder, runtime));
  await app.register(runtimeRoutes(ctx, runtime));
  await app.register(proposalRoutes(ctx, runtime));
  await app.register(mcpRoutes(ctx, builder, runtime));
  await app.register(designRoutes());
  await app.register(agentRoutes(ctx));
  app.get(
    '/openapi.json',
    { config: { access: { kind: 'authenticated' } }, schema: { hide: true } },
    async () => app.swagger(),
  );

  await app.ready();
  return { app, routes };
}
