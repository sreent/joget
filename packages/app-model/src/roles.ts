import type { PermissionGrant, PermissionSet, QueryExclusion, QueryGrant, Role } from '@platform/authz';
import { evaluateCondition } from '@platform/authz';
import type { StoredDefinition } from './fields.js';
import { conditionRecord, type RecordValues } from './values.js';

/** The policy ID of an app role. App roles are bound at environment scope. */
export const appRoleId = (appId: string, role: string): string => `app:${appId}:${role}`;

/** The role name inside an app, from a policy ID, or null if the ID isn't one of that app's roles. */
export function appRoleName(appId: string, id: string): string | null {
  const prefix = `app:${appId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/**
 * Compile an app's roles into permission sets for the policy engine (design §5.5). Each role
 * becomes one permission set and one role with the same ID:
 *
 * - `app.run` for every role, so its holders can use the app;
 * - `action.run` and `query.run` for the role's actions and queries;
 * - `record.*` grants per entity, with record conditions, field selections and masks. Fields
 *   classified as PII are masked unless the role unmasks them.
 */
export function compileAppPolicy(appId: string, definition: StoredDefinition): { permissionSets: PermissionSet[]; roles: Role[] } {
  const permissionSets: PermissionSet[] = [];
  const roles: Role[] = [];
  for (const [name, role] of Object.entries(definition.roles)) {
    const id = appRoleId(appId, name);
    const grants: PermissionGrant[] = [{ permission: 'app.run' }];
    for (const action of role.actions) grants.push({ permission: 'action.run', resource: action });
    for (const query of role.queries) grants.push({ permission: 'query.run', resource: query });
    for (const [entityName, permissions] of Object.entries(role.entities)) {
      const entity = definition.entities[entityName];
      if (!entity) continue;
      const pii = entity.fields.filter((field) => field.classification === 'pii').map((field) => field.name);
      const { read, create, update, delete: remove } = permissions;
      if (read) {
        const access = read === true ? {} : read;
        const unmask = new Set(access.unmask ?? []);
        const mask = [...new Set([...pii.filter((field) => !unmask.has(field)), ...(access.mask ?? [])])];
        grants.push({
          permission: 'record.read',
          resource: entityName,
          ...(access.where ? { condition: access.where } : {}),
          ...(access.fields ? { fields: access.fields } : {}),
          ...(mask.length ? { mask } : {}),
        });
      }
      if (create) {
        const access = create === true ? {} : create;
        grants.push({
          permission: 'record.create',
          resource: entityName,
          ...(access.check ? { check: access.check } : {}),
          ...(access.fields ? { fields: access.fields } : {}),
        });
      }
      if (update) {
        const access = update === true ? {} : update;
        grants.push({
          permission: 'record.update',
          resource: entityName,
          ...(access.where ? { condition: access.where } : {}),
          ...(access.check ? { check: access.check } : {}),
          ...(access.fields ? { fields: access.fields } : {}),
        });
      }
      if (remove) {
        const access = remove === true ? {} : remove;
        grants.push({ permission: 'record.delete', resource: entityName, ...(access.where ? { condition: access.where } : {}) });
      }
      if (permissions.export) grants.push({ permission: 'record.export', resource: entityName });
    }
    permissionSets.push({ id, name: role.label, scopeType: 'env', grants });
    roles.push({ id, name: role.label, scopeType: 'env', permissionSetIds: [id] });
  }
  return { permissionSets, roles };
}

export type FieldAccess = 'full' | 'masked' | 'hidden';

/** True if a grant's field selection covers a field. A grant without one covers every field. */
export function covers(grant: PermissionGrant, field: string): boolean {
  if (!grant.fields) return true;
  return 'include' in grant.fields ? grant.fields.include.includes(field) : !grant.fields.exclude.includes(field);
}

/** How a field shows to someone who holds these read grants for a record: the best any grant allows. */
export function fieldAccess(grants: readonly PermissionGrant[], field: string): FieldAccess {
  let best: FieldAccess = 'hidden';
  for (const grant of grants) {
    if (!covers(grant, field)) continue;
    if (!grant.mask?.includes(field)) return 'full';
    best = 'masked';
  }
  return best;
}

/** The read grants that apply to one record. */
export function grantsFor(grants: readonly QueryGrant[], values: RecordValues): QueryGrant[] {
  const record = conditionRecord(values);
  return grants.filter((grant) => grant.filter === true || evaluateCondition(grant.filter, { record }));
}

/** The first guardrail exclusion that matches a record, if any. */
export function excludedBy(exclusions: readonly QueryExclusion[], values: RecordValues): QueryExclusion | undefined {
  const record = conditionRecord(values);
  return exclusions.find((exclusion) => evaluateCondition(exclusion.when, { record }));
}

/**
 * Whether a write is allowed: some grant must cover every field it changes, hold for the record
 * as it was (its filter; none for creates), and hold for the record as it will be (its check).
 */
export function writeGrant(
  grants: readonly QueryGrant[],
  change: { readonly fields: readonly string[]; readonly before?: RecordValues; readonly after: RecordValues },
): QueryGrant | undefined {
  const before = change.before ? conditionRecord(change.before) : undefined;
  const after = conditionRecord(change.after);
  return grants.find(
    (grant) =>
      change.fields.every((field) => covers(grant.grant, field)) &&
      (grant.filter === true || (before !== undefined && evaluateCondition(grant.filter, { record: before }))) &&
      (grant.check === true || evaluateCondition(grant.check, { record: after })),
  );
}
