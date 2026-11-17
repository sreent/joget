import type { Definition } from '../types.js';
import { isName, lineOwner, toName } from './edit.js';
import { forgetRole, renameRowAction } from './pages.js';
import { forgetInProcesses } from './processes.js';

/**
 * Pure edits of rules, actions, queries, review cards and roles in a draft. Each returns a new
 * definition. Renames and removals carry through to what refers to the item, so the draft stays
 * whole: forms and roles name actions, roles name queries, and actions name cards.
 */

export type Section = 'rules' | 'actions' | 'queries' | 'cards' | 'roles';
type Item<S extends Section> = Definition[S][string];

const clone = <T>(value: T): T => structuredClone(value);

/** Entities whose records stand on their own, not lines of another. */
export function recordEntities(definition: Definition): string[] {
  return Object.keys(definition.entities).filter((name) => !lineOwner(definition, name));
}

/** Fields a caller may write: not worked out from lines. Lines fields are listed too. */
export function writableFields(definition: Definition, entity: string): string[] {
  return (definition.entities[entity]?.fields ?? []).filter((f) => !(f.type === 'number' && f.rollup)).map((f) => f.name);
}

/** A new item of a section, with a name from its label, and defaults that pass the platform's checks. */
export function addItem(definition: Definition, section: Section, label: string): { definition: Definition; name: string } {
  const next = clone(definition);
  const name = toName(label, Object.keys(next[section]));
  const entity = recordEntities(next)[0] ?? Object.keys(next.entities)[0] ?? '';
  const fields = next.entities[entity]?.fields ?? [];
  const first = next.entities[entity]?.titleField ?? fields.find((f) => f.type !== 'lines')?.name ?? 'id';
  switch (section) {
    case 'rules':
      next.rules[name] = { entity, assert: { exists: `record.${first}` }, severity: 'error', message: label } as Item<'rules'>;
      break;
    case 'actions':
      next.actions[name] = {
        label,
        description: `${label}. Say when an agent should use it.`,
        entity,
        operation: 'create',
        input: writableFields(next, entity),
        set: {},
        confirm: 'preview',
      } as Item<'actions'>;
      break;
    case 'queries':
      next.queries[name] = {
        label,
        description: `${label}. Say what it answers.`,
        entity,
        fields: [first, 'created_at'],
        parameters: {},
        sort: [{ field: 'created_at', direction: 'desc' }],
        limit: 50,
      } as Item<'queries'>;
      break;
    case 'cards':
      next.cards[name] = { entity, title: `{{${first}}}`, show: [first] } as Item<'cards'>;
      break;
    case 'roles':
      next.roles[name] = { label, entities: {}, actions: [], queries: [] } as Item<'roles'>;
      break;
  }
  return { definition: next, name };
}

/** Change an item's properties. A key set to undefined is removed. */
export function updateItem<S extends Section>(definition: Definition, section: S, name: string, patch: Partial<Item<S>>): Definition {
  const next = clone(definition);
  const item = next[section][name] as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete item[key];
    else item[key] = value;
  }
  return next;
}

/**
 * Rename an item, and what refers to it. Roles can't be renamed: people are shared with a role by
 * its name, and would lose access.
 */
export function renameItem(definition: Definition, section: Section, from: string, to: string): Definition {
  if (section === 'roles' || from === to || !isName(to) || to in definition[section]) return definition;
  const next = clone(definition);
  next[section] = Object.fromEntries(Object.entries(next[section]).map(([key, value]) => [key === from ? to : key, value])) as never;
  if (section === 'actions') {
    for (const form of Object.values(next.forms)) if (form.action === from) form.action = to;
    for (const role of Object.values(next.roles)) role.actions = (role.actions ?? []).map((a) => (a === from ? to : a));
    renameRowAction(next, from, to);
  }
  if (section === 'queries') for (const role of Object.values(next.roles)) role.queries = (role.queries ?? []).map((q) => (q === from ? to : q));
  if (section === 'cards') for (const action of Object.values(next.actions)) if (action.card === from) action.card = to;
  return next;
}

/** Remove an item, and every reference to it. */
export function removeItem(definition: Definition, section: Section, name: string): Definition {
  const next = clone(definition);
  delete next[section][name];
  if (section === 'actions') {
    for (const form of Object.values(next.forms)) if (form.action === name) delete form.action;
    for (const role of Object.values(next.roles)) role.actions = (role.actions ?? []).filter((a) => a !== name);
    renameRowAction(next, name);
  }
  if (section === 'roles') forgetRole(next, name);
  if (section === 'queries') for (const role of Object.values(next.roles)) role.queries = (role.queries ?? []).filter((q) => q !== name);
  if (section === 'cards') {
    for (const action of Object.values(next.actions)) if (action.card === name) delete action.card;
    for (const process of Object.values(next.processes ?? {})) for (const element of Object.values(process.elements)) if (element.type === 'userTask' && element.card === name) delete element.card;
  }
  if (section === 'actions') return forgetInProcesses(next, { action: name });
  return next;
}

/** Set what a role may do with an entity's records. An empty set of permissions removes the entity from the role. */
export function setRoleEntity(definition: Definition, role: string, entity: string, permissions: Definition['roles'][string]['entities'][string] | undefined): Definition {
  const next = clone(definition);
  const target = next.roles[role]!;
  if (!permissions || Object.values(permissions).every((value) => value === undefined || value === false)) delete target.entities[entity];
  else target.entities[entity] = Object.fromEntries(Object.entries(permissions).filter(([, value]) => value !== undefined && value !== false)) as typeof permissions;
  return next;
}

/** A role, in a few words: what it may do with an entity's records. */
export function summarizeAccess(access: Definition['roles'][string]['entities'][string] | undefined): string {
  if (!access) return 'No access';
  const parts: string[] = [];
  const scoped = (value: unknown) => typeof value === 'object' && value !== null && 'where' in value;
  if (access.read) parts.push(scoped(access.read) ? 'Reads some' : 'Reads all');
  if (access.create) parts.push('Creates');
  if (access.update) parts.push(scoped(access.update) ? 'Changes some' : 'Changes all');
  if (access.delete) parts.push(scoped(access.delete) ? 'Deletes some' : 'Deletes all');
  if (access.export) parts.push('Exports');
  return parts.length ? parts.join(' · ') : 'No access';
}

export { toName };
