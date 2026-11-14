import type { Binding, Principal, ScopeRef } from './model.js';
import { effectiveGrants, type Policy } from './pdp.js';
import { patternCovers, selectorCovers } from './permissions.js';

/** Two sets of roles that one principal must never hold at the same time. */
export interface SodRule {
  readonly id: string;
  readonly name: string;
  readonly roleIds: readonly string[];
  readonly conflictsWith: readonly string[];
}

export interface SodConflict {
  readonly ruleId: string;
  readonly name: string;
  readonly roleId: string;
  readonly conflictingRoleId: string;
  readonly conflictingBindingId: string;
}

/**
 * Separation-of-duties check for a new role binding.
 *
 * `existing` must hold the active bindings of the same principal: for a user, include the bindings
 * of the groups they belong to.
 */
export function findSodConflicts(
  roleId: string | undefined,
  existing: readonly Binding[],
  rules: readonly SodRule[],
  now: Date = new Date(),
): SodConflict[] {
  if (!roleId) return [];
  const conflicts: SodConflict[] = [];
  for (const binding of existing) {
    if (!binding.roleId) continue;
    if (binding.revokedAt && binding.revokedAt <= now) continue;
    if (binding.expiresAt && binding.expiresAt <= now) continue;
    for (const rule of rules) {
      const forward = rule.roleIds.includes(roleId) && rule.conflictsWith.includes(binding.roleId);
      const backward = rule.conflictsWith.includes(roleId) && rule.roleIds.includes(binding.roleId);
      if (forward || backward) {
        conflicts.push({
          ruleId: rule.id,
          name: rule.name,
          roleId,
          conflictingRoleId: binding.roleId,
          conflictingBindingId: binding.id,
        });
      }
    }
  }
  return conflicts;
}

/**
 * Privilege-escalation check: a principal may only grant permissions it holds itself,
 * unconditionally, at the target scope.
 *
 * Returns the permissions of the role or permission set that the granter does not hold. An empty
 * array means the grant is not an escalation.
 */
export function findEscalation(
  policy: Policy,
  granter: Principal,
  scopes: readonly ScopeRef[],
  granterBindings: readonly Binding[],
  target: { readonly roleId?: string; readonly permissionSetId?: string },
  now: Date = new Date(),
): string[] {
  const setIds = target.roleId
    ? (policy.roles.get(target.roleId)?.permissionSetIds ?? [])
    : target.permissionSetId
      ? [target.permissionSetId]
      : [];
  const held = effectiveGrants(policy, granter, scopes, granterBindings, now).filter(
    (grant) => !grant.outsidePersonalBoundary && grant.grant.condition === undefined,
  );
  const missing = new Set<string>();
  for (const setId of setIds) {
    const set = policy.permissionSets.get(setId);
    if (!set) {
      missing.add(`unknown permission set ${setId}`);
      continue;
    }
    for (const wanted of set.grants) {
      const covered = held.some(
        (h) => patternCovers(h.grant.permission, wanted.permission) && selectorCovers(h.grant.resource, wanted.resource),
      );
      if (!covered) missing.add(wanted.permission);
    }
  }
  return [...missing];
}
