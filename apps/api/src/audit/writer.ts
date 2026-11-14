import {
  auditEventDigest,
  canonicalJson,
  uuidv7,
  type AuditActor,
  type AuditEvent,
  type AuditOutcome,
  type AuditTarget,
} from '@platform/audit';
import type { Resource } from '@platform/authz';
import { auditEvents, type Executor } from '@platform/db';
import { trace } from '@opentelemetry/api';
import type { FastifyRequest } from 'fastify';

export interface AuditEntry {
  readonly action: string;
  readonly outcome?: AuditOutcome;
  readonly target?: AuditTarget;
  readonly spaceId?: string | null;
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
  const actor: AuditActor = request.auth
    ? { type: 'user', id: request.auth.user.id, via: 'api', sessionId: request.auth.sessionId }
    : { type: 'anonymous', id: 'anonymous', via: 'api' };
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
    appId: null,
    env: null,
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
    appId: null,
    env: null,
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
