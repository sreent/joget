import {
  authorize,
  createPolicy,
  isCondition,
  type Binding,
  type Decision,
  type Guardrail,
  type PermissionSet,
  type Policy,
  type Principal,
  type Resource,
  type Role,
} from '@platform/authz';
import {
  bindings,
  groupMembers,
  guardrails,
  permissionSetGrants,
  permissionSets,
  rolePermissionSets,
  roles,
  type Database,
  type Executor,
} from '@platform/db';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { metrics, trace } from '@opentelemetry/api';

const decisions = metrics.getMeter('platform-api').createCounter('authz_decisions_total', {
  description: 'Authorization decisions by the policy decision point',
});

export type BindingRow = typeof bindings.$inferSelect;

export function toBinding(row: BindingRow): Binding {
  return {
    id: row.id,
    principalType: row.principalType,
    principalId: row.principalId,
    ...(row.roleId ? { roleId: row.roleId } : {}),
    ...(row.permissionSetId ? { permissionSetId: row.permissionSetId } : {}),
    scope: { type: row.scopeType, id: row.scopeId },
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

/** Loads policy definitions (cached briefly) and bindings (always fresh), and asks the PDP. */
export class PolicyService {
  readonly #db: Database;
  readonly #orgId: string;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  #cached: { policy: Policy; loadedAt: number } | undefined;

  constructor(db: Database, orgId: string, now: () => Date, ttlMs = 30_000) {
    this.#db = db;
    this.#orgId = orgId;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  async policy(): Promise<Policy> {
    const now = Date.now();
    if (!this.#cached || now - this.#cached.loadedAt > this.#ttlMs) {
      this.#cached = { policy: await this.#load(), loadedAt: now };
    }
    return this.#cached.policy;
  }

  /** Forget cached definitions, for example after a permission set or guardrail changes. */
  invalidate(): void {
    this.#cached = undefined;
  }

  async #load(): Promise<Policy> {
    const db = this.#db;
    const visible = <T extends { orgId: unknown }>(table: T) =>
      or(isNull(table.orgId as never), eq(table.orgId as never, this.#orgId));

    const setRows = await db.select().from(permissionSets).where(visible(permissionSets));
    const grantRows = setRows.length
      ? await db.select().from(permissionSetGrants).where(inArray(permissionSetGrants.permissionSetId, setRows.map((s) => s.id)))
      : [];
    const roleRows = await db.select().from(roles).where(visible(roles));
    const roleSetRows = roleRows.length
      ? await db.select().from(rolePermissionSets).where(inArray(rolePermissionSets.roleId, roleRows.map((r) => r.id)))
      : [];
    const guardrailRows = await db.select().from(guardrails).where(visible(guardrails));

    const sets: PermissionSet[] = setRows.map((set) => ({
      id: set.id,
      name: set.name,
      scopeType: set.scopeType,
      managed: set.managed,
      grants: grantRows
        .filter((grant) => grant.permissionSetId === set.id)
        .map((grant) => ({
          permission: grant.permission,
          ...(grant.resourceSelector !== '*' ? { resource: grant.resourceSelector } : {}),
          ...(grant.condition && isCondition(grant.condition) ? { condition: grant.condition } : {}),
        })),
    }));
    const roleList: Role[] = roleRows.map((role) => ({
      id: role.id,
      name: role.name,
      scopeType: role.scopeType,
      managed: role.managed,
      permissionSetIds: roleSetRows.filter((rs) => rs.roleId === role.id).map((rs) => rs.permissionSetId),
    }));
    const guardrailList: Guardrail[] = guardrailRows.map((row) => ({
      id: row.id,
      name: row.name,
      actions: row.actions,
      effect: row.effect,
      enabled: row.enabled,
      managed: row.managed,
      ...(row.condition && isCondition(row.condition) ? { when: row.condition } : {}),
      ...(row.maxMfaAgeSeconds !== null ? { maxMfaAgeSeconds: row.maxMfaAgeSeconds } : {}),
    }));
    return createPolicy({ permissionSets: sets, roles: roleList, guardrails: guardrailList });
  }

  /** Active bindings of a principal and of every group it belongs to. */
  async bindingsFor(principal: Principal, executor: Executor = this.#db): Promise<Binding[]> {
    const direct = and(eq(bindings.principalType, principal.type), eq(bindings.principalId, principal.id));
    const viaGroups = principal.groupIds.length
      ? and(eq(bindings.principalType, 'group'), inArray(bindings.principalId, [...principal.groupIds]))
      : undefined;
    const rows = await executor
      .select()
      .from(bindings)
      .where(and(eq(bindings.orgId, this.#orgId), isNull(bindings.revokedAt), or(direct, viaGroups)));
    return rows.map(toBinding);
  }

  /** The principal for a user, with their current group memberships. */
  async userPrincipal(userId: string, options: { mfaAt?: Date } = {}, executor: Executor = this.#db): Promise<Principal> {
    const rows = await executor.select({ groupId: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId));
    return { type: 'user', id: userId, groupIds: rows.map((r) => r.groupId), ...(options.mfaAt ? { mfaAt: options.mfaAt } : {}) };
  }

  async authorize(
    principal: Principal,
    action: string,
    resource: Resource,
    context?: Record<string, unknown>,
  ): Promise<Decision> {
    const [policy, candidateBindings] = await Promise.all([this.policy(), this.bindingsFor(principal)]);
    const decision = authorize(policy, {
      principal,
      action,
      resource,
      bindings: candidateBindings,
      now: this.#now(),
      ...(context ? { context } : {}),
    });
    decisions.add(1, { decision: decision.allowed ? 'allow' : 'deny', action });
    trace.getActiveSpan()?.setAttributes({
      'platform.authz.action': action,
      'platform.authz.allowed': decision.allowed,
      'platform.resource.type': resource.type,
    });
    return decision;
  }
}
