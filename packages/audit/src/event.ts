import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from './canonical.js';

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditActor {
  readonly type: 'user' | 'service_account' | 'system' | 'anonymous';
  readonly id: string;
  readonly via?: 'ui' | 'api' | 'cli' | 'system';
  readonly sessionId?: string;
  readonly tokenId?: string;
  /** Set during impersonation: the user whose identity is being used. */
  readonly onBehalfOf?: string;
}

export interface AuditTarget {
  readonly type: string;
  readonly id: string;
  readonly name?: string;
}

/** One audit record (design §9.2). Everything here is covered by the event digest. */
export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly orgId: string;
  readonly spaceId?: string | null;
  readonly appId?: string | null;
  readonly env?: string | null;
  readonly actor: AuditActor;
  /** From the action catalog, for example `binding.create` or `auth.login`. */
  readonly action: string;
  readonly target?: AuditTarget | null;
  readonly outcome: AuditOutcome;
  /** The decision basis: bindings, guardrails, a change request, a justification. */
  readonly reason?: Readonly<Record<string, unknown>> | null;
  /** Before/after values. Never put secret values here. */
  readonly changes?: Readonly<Record<string, unknown>> | null;
  /** Request metadata: IP address, user agent, request ID, trace ID. */
  readonly context?: Readonly<Record<string, unknown>> | null;
}

const DIGEST_VERSION = 1;

/** The SHA-256 digest (hex) of an event's canonical form. Absent and null fields hash the same. */
export function auditEventDigest(event: AuditEvent): string {
  const body = {
    v: DIGEST_VERSION,
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    orgId: event.orgId,
    spaceId: event.spaceId ?? null,
    appId: event.appId ?? null,
    env: event.env ?? null,
    actor: event.actor,
    action: event.action,
    target: event.target ?? null,
    outcome: event.outcome,
    reason: event.reason ?? null,
    changes: event.changes ?? null,
    context: event.context ?? null,
  };
  return sha256Hex(canonicalJson(body));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A time-ordered UUID (RFC 9562, version 7). */
export function uuidv7(timestampMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(timestampMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
