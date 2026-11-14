import { evaluateCondition, isCondition, type ConditionEnv } from './conditions.js';
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

/** Build a policy, rejecting definitions that are malformed or reference unknown permission sets. */
export function createPolicy(input: {
  permissionSets: readonly PermissionSet[];
  roles: readonly Role[];
  guardrails?: readonly Guardrail[];
}): Policy {
  const permissionSets = new Map<string, PermissionSet>();
  for (const set of input.permissionSets) {
    if (permissionSets.has(set.id)) throw new PolicyError(`Duplicate permission set ${set.id}`);
    for (const grant of set.grants) {
      if (!isValidPermissionPattern(grant.permission)) {
        throw new PolicyError(`Permission set ${set.id} has an invalid permission pattern "${grant.permission}"`);
      }
      if (grant.condition !== undefined && !isCondition(grant.condition)) {
        throw new PolicyError(`Permission set ${set.id} has an invalid condition on "${grant.permission}"`);
      }
    }
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
  };
}

function deny(action: string, reasons: Reason[]): Decision {
  return { allowed: false, action, reasons };
}

/**
 * Decide whether a principal may perform an action on a resource.
 *
 * Grants are additive; guardrails are the only source of explicit denial. Every decision explains
 * itself through `reasons`.
 */
export function authorize(policy: Policy, request: AuthorizationRequest): Decision {
  const { principal, action, resource } = request;
  const now = request.now ?? new Date();

  if (principal.tokenScopes && !principal.tokenScopes.some((scope) => matchesPermission(scope, action))) {
    return deny(action, [{ kind: 'outside_token_scope' }]);
  }

  const env = conditionEnv(request);
  const matching: EffectiveGrant[] = [];
  const boundary = new Set<string>();
  const unmetConditions = new Set<string>();

  for (const candidate of effectiveGrants(policy, principal, resource.scopes, request.bindings, now)) {
    if (!matchesPermission(candidate.grant.permission, action)) continue;
    if (!matchesSelector(candidate.grant.resource, resource.selector)) continue;
    if (candidate.outsidePersonalBoundary && !PERSONAL_SPACE_ORG_PERMISSIONS.includes(action)) {
      boundary.add(candidate.binding.id);
      continue;
    }
    if (candidate.grant.condition && !evaluateCondition(candidate.grant.condition, env)) {
      unmetConditions.add(candidate.binding.id);
      continue;
    }
    matching.push(candidate);
  }

  if (matching.length === 0) {
    const reasons: Reason[] = [];
    if (boundary.size > 0) reasons.push({ kind: 'personal_space_boundary', bindingIds: [...boundary] });
    if (unmetConditions.size > 0) reasons.push({ kind: 'condition_not_met', bindingIds: [...unmetConditions] });
    if (reasons.length === 0) reasons.push({ kind: 'no_matching_grant' });
    return deny(action, reasons);
  }

  const denials: Reason[] = [];
  for (const guardrail of policy.guardrails) {
    if (guardrail.enabled === false) continue;
    if (!guardrail.actions.some((pattern) => matchesPermission(pattern, action))) continue;
    if (guardrail.when && !evaluateCondition(guardrail.when, env)) continue;
    if (guardrail.effect === 'deny') {
      denials.push({ kind: 'denied_by_guardrail', guardrailId: guardrail.id, name: guardrail.name });
    } else {
      const maxMfaAgeSeconds = guardrail.maxMfaAgeSeconds ?? DEFAULT_MAX_MFA_AGE_SECONDS;
      const fresh =
        principal.mfaAt !== undefined && (now.getTime() - principal.mfaAt.getTime()) / 1000 <= maxMfaAgeSeconds;
      if (!fresh) {
        denials.push({ kind: 'step_up_required', guardrailId: guardrail.id, name: guardrail.name, maxMfaAgeSeconds });
      }
    }
  }
  if (denials.length > 0) return deny(action, denials);

  return {
    allowed: true,
    action,
    reasons: matching.map((grant) => ({
      kind: 'granted',
      bindingId: grant.binding.id,
      ...(grant.roleId ? { roleId: grant.roleId } : {}),
      permissionSetId: grant.permissionSet.id,
      permission: grant.grant.permission,
      scope: { type: grant.binding.scope.type, id: grant.binding.scope.id },
    })),
  };
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
