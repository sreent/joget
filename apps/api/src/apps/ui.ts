import { covers, fieldAccess, lineOwners, rollupOf, type FieldAccess, type StoredDefinition, type StoredField } from '@platform/app-model';
import type { PermissionGrant } from '@platform/authz';
import type { FastifyRequest } from 'fastify';
import type { AppContext, AuthContext } from '../context.js';
import type { LoadedApp } from './catalog.js';
import { recordResource } from './resources.js';
import type { AppRuntime } from './runtime.js';

/** A field as screens need it: its definition, and what the caller may do with it. */
export interface UiField {
  readonly name: string;
  readonly label: string;
  readonly type: StoredField['type'];
  readonly required: boolean;
  readonly description?: string;
  readonly options?: ReadonlyArray<{ value: string; label: string }>;
  readonly multiple?: boolean;
  readonly entity?: string;
  readonly decimals?: number;
  readonly maxLength?: number;
  readonly multiline?: boolean;
  /** For a file field: the kinds it takes. */
  readonly accept?: readonly string[];
  /** True for a number worked out from lines: shown, never entered. */
  readonly computed?: boolean;
  /** How it is worked out, such as `{ sum: 'lines.amount' }`, so screens can show it while people type. */
  readonly rollup?: Readonly<Record<string, string>>;
  /** For a lines field: the most lines, what a line is called and named by, and its fields, with what the caller may do with them. */
  readonly lines?: { readonly max: number; readonly label: string; readonly titleField: string | null; readonly fields: UiField[] };
  /** How the caller sees it at best: some records may show less. */
  readonly read: Exclude<FieldAccess, 'hidden'> | null;
  readonly create: boolean;
  readonly update: boolean;
}

function describeField(field: StoredField): Omit<UiField, 'read' | 'create' | 'update' | 'lines'> {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.description ? { description: field.description } : {}),
    ...(field.type === 'choice' ? { options: field.options, multiple: field.multiple } : {}),
    ...(field.type === 'reference' || field.type === 'lines' ? { entity: field.entity } : {}),
    ...(field.type === 'number' ? { decimals: field.decimals, ...(field.rollup ? { computed: true, rollup: field.rollup as Record<string, string> } : {}) } : {}),
    ...(field.type === 'text' ? { maxLength: field.maxLength, multiline: field.multiline } : {}),
    ...(field.type === 'file' ? { accept: [...field.accept] } : {}),
  };
}

type Grants = { readonly read: PermissionGrant[]; readonly create: PermissionGrant[]; readonly update: PermissionGrant[] };

/**
 * A field with what the caller may do with it, given their grants, or null if it's nothing to
 * them. A field worked out from lines is never entered; a lines field carries its lines' fields,
 * which grants name as `lines.amount`.
 */
function uiField(definition: StoredDefinition, field: StoredField, grants: Grants, path = field.name): UiField | null {
  const access = fieldAccess(grants.read, path);
  const computed = Boolean(rollupOf(field));
  const canCreate = !computed && grants.create.some((grant) => covers(grant, path));
  const canUpdate = !computed && grants.update.some((grant) => covers(grant, path));
  if (access === 'hidden' && !canCreate) return null;
  let lines: UiField['lines'];
  if (field.type === 'lines') {
    const lineEntity = definition.entities[field.entity]!;
    lines = {
      max: field.max,
      label: lineEntity.label,
      titleField: lineEntity.titleField ?? null,
      fields: lineEntity.fields.flatMap((f) => uiField(definition, f, grants, `${field.name}.${f.name}`) ?? []),
    };
  }
  return { ...describeField(field), ...(lines ? { lines } : {}), read: access === 'hidden' ? null : access, create: canCreate, update: canUpdate };
}

/**
 * What the caller can use in an app, for generated screens: entities with their fields, forms,
 * and the actions and queries they may run. Builders read the definition; everyone else reads this.
 */
export async function describeUi(ctx: AppContext, runtime: AppRuntime, request: FastifyRequest, auth: AuthContext, loaded: LoadedApp) {
  void request;
  const policy = await runtime.policy(loaded);
  const decide = (action: string, entity: string) => ctx.policy.query(auth.principal, action, recordResource(ctx.org.id, loaded, entity), { policy });
  const allowed = async (kind: 'action' | 'query', name: string) =>
    (await ctx.policy.authorize(auth.principal, `${kind}.run`, runtime.capability(loaded, kind, name), undefined, policy)).allowed;

  const entities: Record<string, unknown> = {};
  const visibleFields = new Map<string, Set<string>>();
  const owners = lineOwners(loaded.definition);
  for (const [name, entity] of Object.entries(loaded.definition.entities)) {
    // Lines are shown with their records, never as records of their own.
    if (owners.has(name)) continue;
    const [read, create, update, remove] = await Promise.all(['record.read', 'record.create', 'record.update', 'record.delete'].map((action) => decide(action, name)));
    if (!read!.allowed && !create!.allowed) continue;
    const grantsOf = (decision: typeof read) => (decision!.allowed ? decision!.grants.map((g) => g.grant) : []);
    const grants = { read: grantsOf(read), create: grantsOf(create), update: grantsOf(update) };
    const fields: UiField[] = entity.fields.flatMap((field) => uiField(loaded.definition, field, grants) ?? []);
    visibleFields.set(name, new Set(fields.map((f) => f.name)));
    entities[name] = {
      label: entity.label,
      pluralLabel: entity.pluralLabel ?? entity.label,
      titleField: entity.titleField ?? null,
      can: { read: read!.allowed, create: create!.allowed, update: update!.allowed, delete: remove!.allowed },
      fields,
    };
  }

  const actions: Record<string, unknown> = {};
  for (const [name, action] of Object.entries(loaded.definition.actions)) {
    if (!visibleFields.has(action.entity) || !(await allowed('action', name))) continue;
    actions[name] = { label: action.label, description: action.description, entity: action.entity, operation: action.operation, input: action.input, confirm: action.confirm };
  }
  const queries: Record<string, unknown> = {};
  for (const [name, query] of Object.entries(loaded.definition.queries)) {
    if (!visibleFields.has(query.entity) || !(await allowed('query', name))) continue;
    queries[name] = { label: query.label, description: query.description, entity: query.entity, fields: query.fields, parameters: query.parameters };
  }
  const forms: Record<string, unknown> = {};
  for (const [name, form] of Object.entries(loaded.definition.forms)) {
    const visible = visibleFields.get(form.entity);
    const entity = entities[form.entity] as { can: { create: boolean; update: boolean } } | undefined;
    // A form is usable through its action, or for creating or editing records directly.
    if (!visible || !entity || (form.action ? !(form.action in actions) : !entity.can.create && !entity.can.update)) continue;
    forms[name] = {
      label: form.label,
      entity: form.entity,
      ...(form.action ? { action: form.action } : {}),
      sections: form.sections
        .map((section) => ({ ...section, fields: section.fields.filter((item) => visible.has(item.field) || ['id', 'owner', 'created_at', 'updated_at'].includes(item.field)) }))
        .filter((section) => section.fields.length),
    };
  }
  return { entities, forms, actions, queries };
}
