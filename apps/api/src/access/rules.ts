import type { Decision, Resource } from '@platform/authz';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../context.js';

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
  | {
      readonly kind: 'permission';
      readonly action: string | ((request: FastifyRequest) => Promise<string>);
      readonly resource: (request: FastifyRequest) => Promise<Resource>;
      readonly context?: (request: FastifyRequest) => Promise<Record<string, unknown>>;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: AccessRule;
  }
  interface FastifyRequest {
    /** Set for every non-public route once the session is verified. */
    auth: AuthContext | null;
    /** Set for permission routes once the policy decision point allows the request. */
    decision: Decision | null;
  }
}

/** The signed-in user, for handlers on non-public routes. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error('requireAuth() called on a route without authentication');
  return request.auth;
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
