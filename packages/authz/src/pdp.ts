import { isCondition, partialEvaluate, type Condition, type ConditionEnv } from './conditions.js';
import type {
  AuthorizationRequest,
  Binding,
  Decision,
  Guardrail,
  PermissionGrant,
  PermissionSet,
  Principal,
  Reason,
  Resource,
  Role,
  ScopeRef,
} from './model.js';
import { isValidPermissionPattern, matchesPermission, matchesSelector } from './permissions.js';

/**
 * Org-level grants do not reach inside personal spaces, apart from these administrative
 * permissions. Reading personal-space content as an admin requires break-glass access.
 */
export const PERSONAL_SPACE_ORG_PERMISSIONS: readonly string[] = ['space.freeze', 'space.transfer'];

const DEFAULT_MAX_MFA_AGE_SECONDS = 900;

/** The static part of authorization: definitions of permission sets, roles and guardrails. */
export interface Policy {
  readonly permissionSets: ReadonlyMap<string, PermissionSet>;
  readonly roles: ReadonlyMap<string, Role>;
  readonly guardrails: readonly Guardrail[];
}

export class PolicyError extends Error {
  override readonly name = 'PolicyError';
}

function validateGrant(set: PermissionSet, grant: PermissionGrant): void {
  if (!isValidPermissionPattern(grant.permission)) {
    throw new PolicyError(`Permission set ${set.id} has an invalid permission pattern "${grant.permission}"`);
  }
  for (const [what, condition] of [['condition', grant.condition], ['check', grant.check]] as const) {
    if (condition !== undefined && !isCondition(condition)) {
      throw new PolicyError(`Permission set ${set.id} has an invalid ${what} on "${grant.permission}"`);
    }
  }
  const names = grant.fields ? ('include' in grant.fields ? grant.fields.include : grant.fields.exclude) : [];
  if (![...names, ...(grant.mask ?? [])].every((name) => typeof name === 'string' && name.length > 0)) {
    throw new PolicyError(`Permission set ${set.id} has invalid field names on "${grant.permission}"`);
  }
}

/** Build a policy, rejecting definitions that are malformed or reference unknown permission sets. */
export function createPolicy(input: {
  permissionSets: readonly PermissionSet[];
  roles: readonly Role[];
  guardrails?: readonly Guardrail[];
}): Policy {
  const permissionSets = new Map<string, PermissionSet>();
  for (const set of input.permissionSets) {
    if (permissionSets.has(set.id)) throw new PolicyError(`Duplicate permission set ${set.id}`);
    for (const grant of set.grants) validateGrant(set, grant);
    permissionSets.set(set.id, set);
  }
  const roles = new Map<string, Role>();
  for (const role of input.roles) {
    if (roles.has(role.id)) throw new PolicyError(`Duplicate role ${role.id}`);
    for (const setId of role.permissionSetIds) {
      const set = permissionSets.get(setId);
      if (!set) throw new PolicyError(`Role ${role.id} references unknown permission set ${setId}`);
      if (set.scopeType !== role.scopeType) {
        throw new PolicyError(`Role ${role.id} (${role.scopeType}) includes ${setId}, which is for ${set.scopeType}`);
      }
    }
    roles.set(role.id, role);
  }
  const guardrails = input.guardrails ?? [];
  for (const guardrail of guardrails) {
    if (guardrail.actions.length === 0 || !guardrail.actions.every(isValidPermissionPattern)) {
      throw new PolicyError(`Guardrail ${guardrail.id} has invalid actions`);
    }
    if (guardrail.when !== undefined && !isCondition(guardrail.when)) {
      throw new PolicyError(`Guardrail ${guardrail.id} has an invalid condition`);
    }
  }
  return { permissionSets, roles, guardrails };
}

/**
 * A policy plus more definitions, for example the roles an app defines for itself. The additions
 * must not redefine anything in the base: they can only add.
 */
export function mergePolicies(base: Policy, extra: Policy): Policy {
  for (const id of extra.permissionSets.keys()) {
    if (base.permissionSets.has(id)) throw new PolicyError(`Permission set ${id} is already defined`);
  }
  for (const id of extra.roles.keys()) {
    if (base.roles.has(id)) throw new PolicyError(`Role ${id} is already defined`);
  }
  return {
    permissionSets: new Map([...base.permissionSets, ...extra.permissionSets]),
    roles: new Map([...base.roles, ...extra.roles]),
    guardrails: [...base.guardrails, ...extra.guardrails],
  };
}

/** A grant that applies at a resource's scope chain, with the binding it came from. */
export interface EffectiveGrant {
  readonly binding: Binding;
  readonly roleId?: string;
  readonly permissionSet: PermissionSet;
  readonly grant: PermissionGrant;
  /** True for org-level grants seen from inside a personal space: only PERSONAL_SPACE_ORG_PERMISSIONS apply. */
  readonly outsidePersonalBoundary: boolean;
}

function bindingAppliesToPrincipal(binding: Binding, principal: Principal): boolean {
  switch (binding.principalType) {
    case 'group':
      return principal.groupIds.includes(binding.principalId);
    case 'user':
    case 'service_account':
      return binding.principalType === principal.type && binding.principalId === principal.id;
  }
}

function isActive(binding: Binding, now: Date): boolean {
  if (binding.revokedAt && binding.revokedAt.getTime() <= now.getTime()) return false;
  return !binding.expiresAt || binding.expiresAt.getTime() > now.getTime();
}

/** Every grant the principal holds that applies somewhere in the given scope chain. */
export function effectiveGrants(
  policy: Policy,
  principal: Principal,
  scopes: readonly ScopeRef[],
  bindings: readonly Binding[],
  now: Date = new Date(),
): EffectiveGrant[] {
  const personalIndex = scopes.findIndex((scope) => scope.type === 'space' && scope.personal === true);
  const result: EffectiveGrant[] = [];
  for (const binding of bindings) {
    if (!bindingAppliesToPrincipal(binding, principal) || !isActive(binding, now)) continue;
    const scopeIndex = scopes.findIndex((scope) => scope.type === binding.scope.type && scope.id === binding.scope.id);
    if (scopeIndex === -1) continue;
    const outsidePersonalBoundary = personalIndex !== -1 && scopeIndex > personalIndex;
    const role = binding.roleId ? policy.roles.get(binding.roleId) : undefined;
    const setIds = role ? role.permissionSetIds : binding.permissionSetId ? [binding.permissionSetId] : [];
    for (const setId of setIds) {
      const permissionSet = policy.permissionSets.get(setId);
      if (!permissionSet) continue;
      for (const grant of permissionSet.grants) {
        result.push({
          binding,
          ...(role ? { roleId: role.id } : {}),
          permissionSet,
          grant,
          outsidePersonalBoundary,
        });
      }
    }
  }
  return result;
}

function conditionEnv(request: AuthorizationRequest): ConditionEnv {
  const { principal, resource } = request;
  return {
    principal: { ...principal.attributes, id: principal.id, type: principal.type, groupIds: principal.groupIds },
    resource: { ...resource.attributes, type: resource.type, id: resource.id, selector: resource.selector },
    context: request.context ?? {},
    ...(request.record ? { record: request.record } : {}),
  };
}

/** A grant that allows a query, and the part of its conditions that depends on the pending values. */
export interface QueryGrant {
  readonly bindingId: string;
  readonly roleId?: string;
  readonly permissionSetId: string;
  readonly scope: Pick<ScopeRef, 'type' | 'id'>;
  readonly grant: PermissionGrant;
  /** `true`, or the condition on the pending values (for example the record) that the grant requires. */
  readonly filter: true | Condition;
  /** For writes: `true`, or the condition the changed record must satisfy. */
  readonly check: true | Condition;
}

/** A guardrail that denies the action for the resources matching `when`. */
export interface QueryExclusion {
  readonly guardrailId: string;
  readonly name: string;
  readonly effect: Guardrail['effect'];
  readonly when: Condition;
}

export type QueryDecision =
  | { readonly allowed: false; readonly action: string; readonly reasons: readonly Reason[] }
  | {
      readonly allowed: true;
      readonly action: string;
      /** Every grant that allows the action for at least some resources. Allowed = any of their filters. */
      readonly grants: readonly QueryGrant[];
      /** Guardrails that deny the action for some resources: exclude those that match any of these. */
      readonly exclude: readonly QueryExclusion[];
      readonly reasons: readonly Reason[];
    };

function deny(action: string, reasons: Reason[]): QueryDecision & { allowed: false } {
  return { allowed: false, action, reasons };
}

/**
 * Decide an action over many resources at once, for example reading the records of an entity.
 *
 * Values under the `pending` roots (by default `record`) are not known yet. Every condition is
 * evaluated as far as it can be, and the part that depends on pending values comes back as a
 * filter: the caller applies it, typically by compiling it to SQL. A request whose conditions
 * do not depend on pending values gets constant filters, and the result is exactly `authorize`'s.
 *
 * Grants are additive; guardrails are the only source of explicit denial.
 */
export function authorizeQuery(
  policy: Policy,
  request: AuthorizationRequest,
  pending: readonly string[] = ['record'],
): QueryDecision {
  const { principal, action, resource } = request;
  const now = request.now ?? new Date();

  if (principal.tokenScopes && !principal.tokenScopes.some((scope) => matchesPermission(scope, action))) {
    return deny(action, [{ kind: 'outside_token_scope' }]);
  }

  const env = conditionEnv(request);
  const grants: QueryGrant[] = [];
  const boundary = new Set<string>();
  const unmetConditions = new Set<string>();

  for (const candidate of effectiveGrants(policy, principal, resource.scopes, request.bindings, now)) {
    if (!matchesPermission(candidate.grant.permission, action)) continue;
    if (!matchesSelector(candidate.grant.resource, resource.selector)) continue;
    if (candidate.outsidePersonalBoundary && !PERSONAL_SPACE_ORG_PERMISSIONS.includes(action)) {
      boundary.add(candidate.binding.id);
      continue;
    }
    const filter = candidate.grant.condition ? partialEvaluate(candidate.grant.condition, env, pending) : true;
    const check = candidate.grant.check ? partialEvaluate(candidate.grant.check, env, pending) : true;
    if (filter === false || check === false) {
      unmetConditions.add(candidate.binding.id);
      continue;
    }
    grants.push({
      bindingId: candidate.binding.id,
      ...(candidate.roleId ? { roleId: candidate.roleId } : {}),
      permissionSetId: candidate.permissionSet.id,
      scope: { type: candidate.binding.scope.type, id: candidate.binding.scope.id },
      grant: candidate.grant,
      filter,
      check,
    });
  }

  if (grants.length === 0) {
    const reasons: Reason[] = [];
    if (boundary.size > 0) reasons.push({ kind: 'personal_space_boundary', bindingIds: [...boundary] });
    if (unmetConditions.size > 0) reasons.push({ kind: 'condition_not_met', bindingIds: [...unmetConditions] });
    if (reasons.length === 0) reasons.push({ kind: 'no_matching_grant' });
    return deny(action, reasons);
  }

  const denials: Reason[] = [];
  const exclude: QueryExclusion[] = [];
  for (const guardrail of policy.guardrails) {
    if (guardrail.enabled === false) continue;
    if (!guardrail.actions.some((pattern) => matchesPermission(pattern, action))) continue;
    const when = guardrail.when ? partialEvaluate(guardrail.when, env, pending) : true;
    if (when === false) continue;
    if (guardrail.effect === 'step_up') {
      const maxMfaAgeSeconds = guardrail.maxMfaAgeSeconds ?? DEFAULT_MAX_MFA_AGE_SECONDS;
      const fresh =
        principal.mfaAt !== undefined && (now.getTime() - principal.mfaAt.getTime()) / 1000 <= maxMfaAgeSeconds;
      if (fresh) continue;
      if (when === true) {
        denials.push({ kind: 'step_up_required', guardrailId: guardrail.id, name: guardrail.name, maxMfaAgeSeconds });
        continue;
      }
    } else if (when === true) {
      denials.push({ kind: 'denied_by_guardrail', guardrailId: guardrail.id, name: guardrail.name });
      continue;
    }
    exclude.push({ guardrailId: guardrail.id, name: guardrail.name, effect: guardrail.effect, when });
  }
  if (denials.length > 0) return deny(action, denials);

  return {
    allowed: true,
    action,
    grants,
    exclude,
    reasons: grants.map((grant) => ({
      kind: 'granted' as const,
      bindingId: grant.bindingId,
      ...(grant.roleId ? { roleId: grant.roleId } : {}),
      permissionSetId: grant.permissionSetId,
      permission: grant.grant.permission,
      scope: grant.scope,
    })),
  };
}

/**
 * Decide whether a principal may perform an action on a resource.
 *
 * Grants are additive; guardrails are the only source of explicit denial. Every decision explains
 * itself through `reasons`. Record conditions are evaluated against `request.record`; a condition
 * on a record that was not given fails.
 */
export function authorize(policy: Policy, request: AuthorizationRequest): Decision {
  const decision = authorizeQuery(policy, request, []);
  return { allowed: decision.allowed, action: decision.action, reasons: decision.reasons };
}

/** Convenience: the scope chain for a resource directly in a space. */
export function spaceScopes(orgId: string, space: { id: string; personal: boolean }): ScopeRef[] {
  return [
    { type: 'space', id: space.id, personal: space.personal },
    { type: 'org', id: orgId },
  ];
}

/** Convenience: the scope chain for an org-level resource. */
export function orgScopes(orgId: string): ScopeRef[] {
  return [{ type: 'org', id: orgId }];
}

/** Convenience: a resource that is the scope itself (a space, or the org). */
export function scopeResource(scopes: readonly ScopeRef[], attributes?: Record<string, unknown>): Resource {
  const self = scopes[0];
  if (!self) throw new PolicyError('A resource needs at least one scope');
  return { type: self.type, id: self.id, scopes, ...(attributes ? { attributes } : {}) };
}
