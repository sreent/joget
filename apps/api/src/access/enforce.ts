import type { FastifyInstance } from 'fastify';
import { auditScopeFor, recordAudit, spaceIdOf } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
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
        ...(access.kind === 'permission' && typeof access.action === 'string' ? { action: access.action } : {}),
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
    const auth = await ctx.sessions.authenticate(request);
    if (!auth) throw unauthorized();
    request.auth = auth;
  });

  app.addHook('preHandler', async (request) => {
    const access = request.routeOptions.config?.access;
    if (access?.kind !== 'permission') return;
    const auth = requireAuth(request);
    const resource = await access.resource(request);
    const action = typeof access.action === 'string' ? access.action : await access.action(request);
    const context = access.context ? await access.context(request) : undefined;
    const decision = await ctx.policy.authorize(auth.principal, action, resource, context);
    if (!decision.allowed) {
      await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, ctx.now()), {
        action: 'access.denied',
        outcome: 'denied',
        target: { type: resource.type, id: resource.id ?? '' },
        spaceId: spaceIdOf(resource),
        reason: { action, reasons: decision.reasons },
      });
      throw forbidden('forbidden', `You are not allowed to ${action} here`, { action, reasons: decision.reasons });
    }
    request.decision = decision;
  });
}
