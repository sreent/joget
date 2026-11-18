import type { PermissionGrant, PermissionSet, QueryExclusion, QueryGrant, Role } from '@platform/authz';
import { evaluateCondition } from '@platform/authz';
import { isComputed, type StoredDefinition, type StoredEntity } from './fields.js';
import { conditionRecord, type LineValues, type RecordValues } from './values.js';
import { flowWaits } from './waiting.js';

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
 * - `action.run` and `query.run` for the role's actions and queries, `process.start` for the
 *   processes it may start by hand, and `flow.run` for the flows it may run through the API: for
 *   a flow that waits, `process.start` too, as it runs on a record;
 * - `record.*` grants per entity, with record conditions, field selections and masks. Fields
 *   classified as PII are masked unless the role unmasks them, the fields of lines too.
 *
 * Line entities get no grants of their own: their lines are part of a record, so the record's
 * grants cover them, and name their fields as `lines.amount`.
 */
export function compileAppPolicy(appId: string, definition: StoredDefinition): { permissionSets: PermissionSet[]; roles: Role[] } {
  const permissionSets: PermissionSet[] = [];
  const roles: Role[] = [];
  for (const [name, role] of Object.entries(definition.roles)) {
    const id = appRoleId(appId, name);
    const grants: PermissionGrant[] = [{ permission: 'app.run' }];
    for (const action of role.actions) grants.push({ permission: 'action.run', resource: action });
    for (const query of role.queries) grants.push({ permission: 'query.run', resource: query });
    for (const process of role.processes ?? []) grants.push({ permission: 'process.start', resource: process });
    for (const flow of role.flows ?? []) {
      grants.push({ permission: 'flow.run', resource: flow });
      // A flow that waits runs on a record: the role may start it there, as it would a process.
      const found = definition.flows?.[flow];
      if (found && flowWaits(found, definition.flows)) grants.push({ permission: 'process.start', resource: flow });
    }
    for (const [entityName, permissions] of Object.entries(role.entities)) {
      const entity = definition.entities[entityName];
      if (!entity) continue;
      const pii = entity.fields.flatMap((field) => {
        if (field.type !== 'lines') return field.classification === 'pii' ? [field.name] : [];
        const lines = definition.entities[field.entity];
        return (lines?.fields ?? []).filter((f) => f.classification === 'pii').map((f) => `${field.name}.${f.name}`);
      });
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

/** A field of lines, `lines.amount`, as its lines field and its own name; or a plain field. */
function splitPath(field: string): [string, string | undefined] {
  const dot = field.indexOf('.');
  return dot === -1 ? [field, undefined] : [field.slice(0, dot), field.slice(dot + 1)];
}

/**
 * True if a grant's field selection covers a field. A grant without one covers every field.
 *
 * Fields of lines are named `lines.amount`. Including `lines` includes all of its fields;
 * including only `lines.amount` includes the lines with that one field. Excluding `lines`
 * excludes them all; excluding `lines.amount`, just that field.
 */
export function covers(grant: PermissionGrant, field: string): boolean {
  if (!grant.fields) return true;
  const [lines, sub] = splitPath(field);
  if ('include' in grant.fields) {
    const include = grant.fields.include;
    return sub === undefined
      ? include.includes(field) || include.some((name) => name.startsWith(`${field}.`))
      : include.includes(lines) || include.includes(field);
  }
  const exclude = grant.fields.exclude;
  return !exclude.includes(field) && !(sub !== undefined && exclude.includes(lines));
}

/**
 * How a field shows to someone who holds these read grants for a record: the best any grant
 * allows. A field of lines is masked if it or its lines field is.
 */
export function fieldAccess(grants: readonly PermissionGrant[], field: string): FieldAccess {
  const [lines, sub] = splitPath(field);
  let best: FieldAccess = 'hidden';
  for (const grant of grants) {
    if (!covers(grant, field)) continue;
    if (!grant.mask?.includes(field) && !(sub !== undefined && grant.mask?.includes(lines))) return 'full';
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
 * The fields of lines a change writes, for writeGrant. Adding, removing or reordering lines writes
 * the lines field and every field of its lines; changing lines writes just the fields that change.
 */
export function linesWritten(lineEntity: StoredEntity, field: string, before: readonly LineValues[], after: readonly LineValues[]): string[] {
  // What the platform works out, a line's formulas, nobody writes.
  const entered = lineEntity.fields.filter((f) => !isComputed(f));
  const all = [field, ...entered.map((f) => `${field}.${f.name}`)];
  const old = new Map(before.flatMap((line) => (line.id ? [[line.id, line] as const] : [])));
  const kept = after.map((line) => (line.id ? old.get(line.id) : undefined));
  if (kept.some((line) => !line) || before.length !== after.length || before.some((line, i) => line.id !== after[i]!.id)) return all;
  const changed = entered.filter((f) =>
    after.some((line, i) => JSON.stringify(line.values[f.name] ?? null) !== JSON.stringify(kept[i]!.values[f.name] ?? null)),
  );
  return changed.map((f) => `${field}.${f.name}`);
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
