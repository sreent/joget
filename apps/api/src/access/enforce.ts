import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { checkAnyPermission, checkQuery } from './check.js';
import { requireAuth, type AccessRule } from './rules.js';

export interface RouteAccess {
  readonly method: string;
  readonly url: string;
  readonly kind: AccessRule['kind'];
  readonly action?: string;
}

/**
 * Refuse to register any route without an access rule. Must be installed before routes are added.
 * Returns the registry of declared rules, which tests use to review what is public.
 */
export function requireAccessRules(app: FastifyInstance, registry: RouteAccess[] = []): RouteAccess[] {
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!access) {
      throw new Error(`Route ${methods.join(',')} ${route.url} has no access rule. Every route must set config.access.`);
    }
    for (const method of methods) {
      registry.push({
        method,
        url: route.url,
        kind: access.kind,
        ...((access.kind === 'permission' || access.kind === 'query') && typeof access.action !== 'function'
          ? { action: typeof access.action === 'string' ? access.action : access.action.join('|') }
          : {}),
      });
    }
  });
  return registry;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Authenticate every non-public request, then authorize permission routes through the PDP. */
export function installAccessControl(app: FastifyInstance, ctx: AppContext): void {
  const publicOrigin = new URL(ctx.config.PUBLIC_BASE_URL).origin;
  app.decorateRequest('auth', null);
  app.decorateRequest('decision', null);
  app.decorateRequest('queryDecision', null);

  app.addHook('onRequest', async (request) => {
    // Defence in depth against cross-site request forgery, on top of SameSite=Lax cookies.
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== publicOrigin) {
        throw forbidden('origin_mismatch', 'Cross-origin requests that change state are not allowed');
      }
    }
    const access = request.routeOptions.config?.access;
    if (!access || access.kind === 'public') return; // no rule means no route matched: the 404 handler answers
    // A bearer token wins over a session cookie; an invalid token is an error, never a fallback.
    const auth = (await ctx.tokens.authenticate(request)) ?? (await ctx.sessions.authenticate(request));
    if (!auth) throw unauthorized();
    request.auth = auth;
  });

  app.addHook('preHandler', async (request) => {
    const access = request.routeOptions.config?.access;
    if (access?.kind !== 'permission' && access?.kind !== 'query') return;
    const auth = requireAuth(request);
    const resource = await access.resource(request);
    const action = typeof access.action === 'function' ? await access.action(request) : access.action;
    const context = access.context ? await access.context(request) : undefined;
    const policy = access.policy ? await access.policy(request) : undefined;
    const options = { ...(context ? { context } : {}), ...(policy ? { policy } : {}) };
    if (access.kind === 'query') {
      if (typeof action !== 'string') throw new Error('A query access rule names exactly one action');
      request.queryDecision = await checkQuery(ctx, request, auth, action, resource, options);
    } else {
      request.decision = await checkAnyPermission(ctx, request, auth, typeof action === 'string' ? [action] : action, resource, options);
    }
  });
}
