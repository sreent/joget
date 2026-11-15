import type { Decision, Policy, QueryDecision, Resource } from '@platform/authz';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../context.js';
import { forbidden } from '../errors.js';

/**
 * Every route must declare exactly one access rule in `config.access`. The server refuses to start
 * if any route lacks one (see enforce.ts), so no endpoint can be left unprotected by accident.
 */
export type AccessRule =
  /** Anyone, signed in or not. Keep this list short: health checks and the login flow. */
  | { readonly kind: 'public' }
  /** Any signed-in user. For endpoints about the caller themselves, such as /v1/me. */
  | { readonly kind: 'authenticated' }
  /** A permission check by the policy decision point. */
  | ({ readonly kind: 'permission' } & PermissionCheck)
  /**
   * A permission check over many resources, such as an entity's records. The request is refused
   * only if no grant can apply at all; the handler applies the record filters the decision carries.
   */
  | ({ readonly kind: 'query' } & PermissionCheck);

interface PermissionCheck {
  readonly action: string | ((request: FastifyRequest) => Promise<string>);
  readonly resource: (request: FastifyRequest) => Promise<Resource>;
  readonly context?: (request: FastifyRequest) => Promise<Record<string, unknown>>;
  /** The policy to decide with, when it's more than the platform's: for example with an app's own roles. */
  readonly policy?: (request: FastifyRequest) => Promise<Policy>;
}

export type AllowedQuery = Extract<QueryDecision, { allowed: true }>;

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: AccessRule;
  }
  interface FastifyRequest {
    /** Set for every non-public route once the session is verified. */
    auth: AuthContext | null;
    /** Set for permission routes once the policy decision point allows the request. */
    decision: Decision | null;
    /** Set for query routes: the grants that apply, with their record filters. */
    queryDecision: AllowedQuery | null;
  }
}

/** The decision of a query route. */
export function requireQueryDecision(request: FastifyRequest): AllowedQuery {
  if (!request.queryDecision) throw new Error('requireQueryDecision() called on a route without a query access rule');
  return request.queryDecision;
}

/** The authenticated caller, for handlers on non-public routes. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error('requireAuth() called on a route without authentication');
  return request.auth;
}

/** The caller, who must be a person rather than a service account. */
export function requireUser(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.actor.type !== 'user') throw forbidden('person_required', 'Only people can do this, not service accounts');
  return auth;
}

/** The caller, who must be a person signed in interactively: API tokens cannot do this. */
export function requireSession(request: FastifyRequest): AuthContext & { credential: { kind: 'session'; sessionId: string } } {
  const auth = requireUser(request);
  if (auth.credential.kind !== 'session') {
    throw forbidden('session_required', 'Sign in interactively to do this. API tokens cannot.');
  }
  return auth as AuthContext & { credential: { kind: 'session'; sessionId: string } };
}

const memo = new WeakMap<FastifyRequest, Map<string, Promise<unknown>>>();

/** Compute a value once per request, for example a row needed by both the access rule and the handler. */
export function once<T>(request: FastifyRequest, key: string, compute: () => Promise<T>): Promise<T> {
  let cache = memo.get(request);
  if (!cache) {
    cache = new Map();
    memo.set(request, cache);
  }
  let value = cache.get(key) as Promise<T> | undefined;
  if (!value) {
    value = compute();
    cache.set(key, value);
  }
  return value;
}
