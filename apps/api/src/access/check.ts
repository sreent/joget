import type { Decision, Policy, Resource } from '@platform/authz';
import type { FastifyRequest } from 'fastify';
import { appOf, auditScopeFor, recordAudit, spaceIdOf } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { forbidden } from '../errors.js';
import type { AllowedQuery } from './rules.js';

export interface CheckOptions {
  readonly policy?: Policy;
  readonly context?: Record<string, unknown>;
}

async function deny(ctx: AppContext, request: FastifyRequest, action: string, resource: Resource, reasons: Decision['reasons']): Promise<never> {
  await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, ctx.now()), {
    action: 'access.denied',
    outcome: 'denied',
    target: { type: resource.type, id: resource.id ?? resource.selector ?? '' },
    spaceId: spaceIdOf(resource),
    ...appOf(resource),
    reason: { action, reasons },
  });
  throw forbidden('forbidden', `You are not allowed to ${action} here`, { action, reasons });
}

/** Ask the policy decision point, and refuse (with an audited denial) unless it allows. */
export async function checkPermission(
  ctx: AppContext,
  request: FastifyRequest,
  auth: AuthContext,
  action: string,
  resource: Resource,
  options: CheckOptions = {},
): Promise<Decision> {
  const decision = await ctx.policy.authorize(auth.principal, action, resource, options.context, options.policy);
  if (!decision.allowed) await deny(ctx, request, action, resource, decision.reasons);
  return decision;
}

/** Like checkPermission, for an action over many records: returns the grants with their record filters. */
export async function checkQuery(
  ctx: AppContext,
  request: FastifyRequest,
  auth: AuthContext,
  action: string,
  resource: Resource,
  options: CheckOptions = {},
): Promise<AllowedQuery> {
  const decision = await ctx.policy.query(auth.principal, action, resource, options);
  if (!decision.allowed) await deny(ctx, request, action, resource, decision.reasons);
  return decision as AllowedQuery;
}

/** A principal's attributes as conditions see them: the same view the policy engine uses. */
export function principalEnv(auth: AuthContext): Record<string, unknown> {
  const { principal } = auth;
  return { ...principal.attributes, id: principal.id, type: principal.type, groupIds: principal.groupIds };
}
