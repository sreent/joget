import { trace } from '@opentelemetry/api';
import { type AuditActor, type AuditEvent, type AuditOutcome, type AuditTarget, auditEventDigest, canonicalJson, uuidv7 } from '@platform/audit';
import type { Resource } from '@platform/authz';
import { auditEvents, type Executor } from '@platform/db';
import type { FastifyRequest } from 'fastify';

export interface AuditEntry {
  readonly action: string;
  readonly outcome?: AuditOutcome;
  readonly target?: AuditTarget;
  readonly spaceId?: string | null;
  readonly appId?: string | null;
  /** The environment kind, for example `sandbox` or `prod`. */
  readonly env?: string | null;
  readonly reason?: Record<string, unknown>;
  readonly changes?: Record<string, unknown>;
  /** Overrides the actor taken from the request, for example the platform itself. */
  readonly actor?: AuditActor;
}

/** Who is acting and from where: shared by every event a request writes. */
export interface AuditScope {
  readonly orgId: string;
  readonly actor: AuditActor;
  readonly context: Record<string, unknown>;
  readonly now: Date;
}

export const SYSTEM_ACTOR: AuditActor = { type: 'system', id: 'platform', via: 'system' };

export function auditScopeFor(request: FastifyRequest, orgId: string, now: Date): AuditScope {
  const auth = request.auth;
  const via = request.url.startsWith('/mcp') ? 'mcp' : 'api';
  const credential = auth ? (auth.credential.kind === 'session' ? { sessionId: auth.credential.sessionId } : { tokenId: auth.credential.tokenId }) : {};
  // An agent acting for a person is the actor, on the person's behalf: the log names both.
  const actor: AuditActor = !auth
    ? { type: 'anonymous', id: 'anonymous', via }
    : auth.agent
      ? { type: 'service_account', id: auth.agent.id, via, ...credential, onBehalfOf: auth.actor.id }
      : { type: auth.actor.type, id: auth.actor.id, via, ...credential };
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  const userAgent = request.headers['user-agent'];
  return {
    orgId,
    actor,
    now,
    context: {
      ip: request.ip,
      requestId: request.id,
      ...(userAgent ? { userAgent: userAgent.slice(0, 512) } : {}),
      ...(traceId ? { traceId } : {}),
    },
  };
}

/** Normalize to exactly the JSON that will be stored, so the digest matches what is read back. */
function json<T>(value: T | null | undefined): T | null {
  return value === null || value === undefined ? null : (JSON.parse(canonicalJson(value)) as T);
}

/**
 * Write one audit event. Pass the transaction that makes the change, so the change and its audit
 * record commit together or not at all.
 */
export async function recordAudit(executor: Executor, scope: AuditScope, entry: AuditEntry): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: uuidv7(scope.now.getTime()),
    occurredAt: scope.now,
    orgId: scope.orgId,
    spaceId: entry.spaceId ?? null,
    appId: entry.appId ?? null,
    env: entry.env ?? null,
    actor: json(entry.actor ?? scope.actor)!,
    action: entry.action,
    target: json(entry.target),
    outcome: entry.outcome ?? 'success',
    reason: json(entry.reason),
    changes: json(entry.changes),
    context: json(scope.context),
  };
  await executor.insert(auditEvents).values({
    id: event.id,
    occurredAt: event.occurredAt,
    orgId: event.orgId,
    spaceId: event.spaceId ?? null,
    appId: event.appId ?? null,
    env: event.env ?? null,
    actor: event.actor as unknown as Record<string, unknown>,
    action: event.action,
    target: (event.target ?? null) as Record<string, unknown> | null,
    outcome: event.outcome,
    reason: (event.reason ?? null) as Record<string, unknown> | null,
    changes: (event.changes ?? null) as Record<string, unknown> | null,
    context: (event.context ?? null) as Record<string, unknown> | null,
    digest: auditEventDigest(event),
  });
  return event;
}

/** The space a resource sits in, if any. */
export function spaceIdOf(resource: Resource): string | null {
  return resource.scopes.find((scope) => scope.type === 'space')?.id ?? null;
}

/** The app a resource belongs to, if any, and its environment kind. */
export function appOf(resource: Resource): { appId: string | null; env: string | null } {
  const env = resource.attributes?.['env'];
  return { appId: resource.scopes.find((scope) => scope.type === 'app')?.id ?? null, env: typeof env === 'string' ? env : null };
}
