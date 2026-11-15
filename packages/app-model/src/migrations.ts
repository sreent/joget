import { columnName, tableName, type StoredDefinition, type StoredEntity, type StoredField } from './fields.js';
import { NAME_PATTERN } from './schema.js';
import { ident } from './sql.js';

/** Where an app environment's data lives: its schema, and the role that alone may use it. */
export interface EnvironmentNames {
  readonly schema: string;
  readonly role: string;
}

/** Schema and role names for an app's environment, for example `app_0193..._sandbox`. */
export function environmentNames(appId: string, kind: 'sandbox' | 'staging' | 'prod'): EnvironmentNames {
  const name = `app_${appId.replaceAll('-', '').toLowerCase()}_${kind}`;
  return { schema: name, role: name };
}

export type MigrationStep = { readonly destructive: boolean; readonly description: string } & (
  | { readonly kind: 'create_entity'; readonly entity: string }
  | { readonly kind: 'drop_entity'; readonly entity: string }
  | { readonly kind: 'rename_entity'; readonly from: string; readonly to: string }
  | { readonly kind: 'add_field'; readonly entity: string; readonly field: string }
  | { readonly kind: 'drop_field'; readonly entity: string; readonly field: string }
  | { readonly kind: 'rename_field'; readonly entity: string; readonly from: string; readonly to: string }
  | { readonly kind: 'retype_field'; readonly entity: string; readonly field: string; readonly from: string; readonly to: string }
  | { readonly kind: 'add_unique'; readonly entity: string; readonly field: string }
  | { readonly kind: 'drop_unique'; readonly entity: string; readonly field: string }
  | { readonly kind: 'require_field'; readonly entity: string; readonly field: string }
);

export interface MigrationPlan {
  readonly steps: readonly MigrationStep[];
  /** True if any step loses data: it then needs the builder's explicit confirmation. */
  readonly destructive: boolean;
  /** The DDL, in order. Empty when only names, labels or rules changed. */
  readonly statements: readonly string[];
  /** Queries that count what each step touches, by step index, for the builder to see first. */
  readonly impact: ReadonlyArray<{ readonly step: number; readonly sql: string }>;
}

/** The column type a field needs. Fields with the same physical type can change without touching data. */
export function physicalType(field: StoredField, entities: Readonly<Record<string, StoredEntity>>): string {
  switch (field.type) {
    case 'text':
    case 'email':
      return 'text';
    case 'choice':
      return field.multiple ? 'text[]' : 'text';
    case 'number':
      return 'numeric';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamptz';
    case 'user':
      return 'uuid';
    case 'reference':
      return `uuid references ${tableName(entities[field.entity]!.id)}`;
  }
}

const isUnique = (field: StoredField) => 'unique' in field && field.unique === true;

/** A string literal for a comment. Only identifier-shaped names are ever written, so no text a builder typed reaches the SQL. */
function nameLiteral(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Unexpected name ${name}`);
  return `'${name}'`;
}

/**
 * The steps that turn `previous` into `next`, and the DDL that makes them so.
 *
 * Entities and fields are matched by stable ID, so renames touch no data. A changed column type
 * is dropped and added again, which loses the column's values and so counts as destructive.
 */
export function planMigration(previous: StoredDefinition | undefined, next: StoredDefinition, names: EnvironmentNames): MigrationPlan {
  const schema = ident(names.schema);
  const role = ident(names.role);
  const table = (entity: StoredEntity) => `${schema}.${ident(tableName(entity.id))}`;
  const column = (field: StoredField) => ident(columnName(field.id));
  const index = (entity: StoredEntity, field: StoredField, suffix: string) => ident(`${tableName(entity.id)}_${columnName(field.id)}_${suffix}`);

  const before = new Map(Object.entries(previous?.entities ?? {}).map(([name, entity]) => [entity.id, { name, entity }]));
  const after = new Map(Object.entries(next.entities).map(([name, entity]) => [entity.id, { name, entity }]));

  const steps: MigrationStep[] = [];
  const impact: Array<{ step: number; sql: string }> = [];
  const creates: string[] = [];
  const drops: string[] = [];
  const adds: string[] = [];
  const references: string[] = [];
  const indexes: string[] = [];
  const comments: string[] = [];
  const step = (s: MigrationStep, impactSql?: string) => {
    if (impactSql) impact.push({ step: steps.length, sql: impactSql });
    steps.push(s);
  };

  const addColumn = (entity: StoredEntity, field: StoredField) => {
    const type = physicalType(field, next.entities);
    if (field.type === 'reference') {
      const target = `${schema}.${ident(tableName(next.entities[field.entity]!.id))}`;
      references.push(`alter table ${table(entity)} add column ${column(field)} uuid references ${target} (id) on delete restrict`);
      references.push(`create index ${index(entity, field, 'idx')} on ${table(entity)} (${column(field)})`);
    } else {
      adds.push(`alter table ${table(entity)} add column ${column(field)} ${type}`);
    }
    if (isUnique(field)) indexes.push(`create unique index ${index(entity, field, 'key')} on ${table(entity)} (${column(field)})`);
    comments.push(`comment on column ${table(entity)}.${column(field)} is ${nameLiteral(field.name)}`);
  };

  for (const [id, { name, entity }] of after) {
    const old = before.get(id);
    if (!old) {
      step({ kind: 'create_entity', entity: name, destructive: false, description: `Create ${name}` });
      creates.push(
        `create table ${table(entity)} (id uuid primary key, version integer not null default 1, owner uuid not null, ` +
          'created_at timestamptz not null, created_by uuid not null, updated_at timestamptz not null, updated_by uuid not null)',
        `create index ${ident(`${tableName(entity.id)}_owner_idx`)} on ${table(entity)} (owner)`,
        `grant select, insert, update, delete on ${table(entity)} to ${role}`,
      );
      comments.push(`comment on table ${table(entity)} is ${nameLiteral(name)}`);
      for (const field of entity.fields) addColumn(entity, field);
      continue;
    }
    if (old.name !== name) {
      step({ kind: 'rename_entity', from: old.name, to: name, destructive: false, description: `Rename ${old.name} to ${name}; no data changes` });
      comments.push(`comment on table ${table(entity)} is ${nameLiteral(name)}`);
    }
    const oldFields = new Map(old.entity.fields.map((field) => [field.id, field]));
    const newFields = new Map(entity.fields.map((field) => [field.id, field]));
    for (const [fieldId, field] of oldFields) {
      if (newFields.has(fieldId)) continue;
      step(
        { kind: 'drop_field', entity: name, field: field.name, destructive: true, description: `Delete ${name}.${field.name} and its values` },
        `select count(*)::int as n from ${table(entity)} where ${column(field)} is not null`,
      );
      drops.push(`alter table ${table(entity)} drop column ${column(field)}`);
    }
    for (const [fieldId, field] of newFields) {
      const oldField = oldFields.get(fieldId);
      if (!oldField) {
        step({ kind: 'add_field', entity: name, field: field.name, destructive: false, description: `Add ${name}.${field.name}` });
        addColumn(entity, field);
        if (field.required) {
          step(
            { kind: 'require_field', entity: name, field: field.name, destructive: false, description: `Existing ${name} records have no ${field.name} yet` },
            `select count(*)::int as n from ${table(entity)}`,
          );
        }
        continue;
      }
      if (oldField.name !== field.name) {
        step({ kind: 'rename_field', entity: name, from: oldField.name, to: field.name, destructive: false, description: `Rename ${name}.${oldField.name} to ${field.name}; no data changes` });
        comments.push(`comment on column ${table(entity)}.${column(field)} is ${nameLiteral(field.name)}`);
      }
      // A reference's type names its target table, so pointing it at another entity counts as a new type.
      if (physicalType(oldField, previous!.entities) !== physicalType(field, next.entities)) {
        step(
          { kind: 'retype_field', entity: name, field: field.name, from: oldField.type, to: field.type, destructive: true, description: `Change ${name}.${field.name} from ${oldField.type} to ${field.type}, which deletes its values` },
          `select count(*)::int as n from ${table(entity)} where ${column(oldField)} is not null`,
        );
        drops.push(`alter table ${table(entity)} drop column ${column(oldField)}`);
        addColumn(entity, field);
        continue;
      }
      if (isUnique(field) && !isUnique(oldField)) {
        step(
          { kind: 'add_unique', entity: name, field: field.name, destructive: false, description: `Make ${name}.${field.name} unique` },
          `select count(*)::int as n from (select ${column(field)} from ${table(entity)} where ${column(field)} is not null group by 1 having count(*) > 1) duplicates`,
        );
        indexes.push(`create unique index ${index(entity, field, 'key')} on ${table(entity)} (${column(field)})`);
      } else if (!isUnique(field) && isUnique(oldField)) {
        step({ kind: 'drop_unique', entity: name, field: field.name, destructive: false, description: `Allow repeated values in ${name}.${field.name}` });
        indexes.push(`drop index ${schema}.${index(entity, field, 'key')}`);
      }
      if (field.required && !oldField.required) {
        step(
          { kind: 'require_field', entity: name, field: field.name, destructive: false, description: `Make ${name}.${field.name} required; existing records without a value keep working until edited` },
          `select count(*)::int as n from ${table(entity)} where ${column(field)} is null`,
        );
      }
    }
  }
  const dropped = [...before].filter(([id]) => !after.has(id));
  for (const [, { name, entity }] of dropped) {
    step({ kind: 'drop_entity', entity: name, destructive: true, description: `Delete ${name} and all its records` }, `select count(*)::int as n from ${table(entity)}`);
  }
  // Drop the tables together, so references between them don't get in the way.
  if (dropped.length) drops.push(`drop table ${dropped.map(([, { entity }]) => table(entity)).join(', ')}`);

  return {
    steps,
    destructive: steps.some((s) => s.destructive),
    statements: [...drops, ...creates, ...adds, ...references, ...indexes, ...comments],
    impact,
  };
}

/**
 * Create an environment's schema and its role. The role can use the schema's tables and nothing
 * else; the platform, which owns the schema, switches to it for every query on app data. Record
 * history is append-only for the role.
 */
export function provisionEnvironment(names: EnvironmentNames): string[] {
  const schema = ident(names.schema);
  const role = ident(names.role);
  return [
    `do $$ begin if not exists (select from pg_roles where rolname = '${names.role}') then create role ${role} nologin; end if; end $$`,
    `grant ${role} to current_user`,
    `create schema ${schema}`,
    `grant usage on schema ${schema} to ${role}`,
    `create table ${schema}.history (id uuid primary key, entity_id text not null, record_id uuid not null, version integer not null, ` +
      `operation text not null check (operation in ('create', 'update', 'delete')), changes jsonb not null, actor_type text not null, ` +
      `actor_id uuid, on_behalf_of uuid, via text not null, occurred_at timestamptz not null, audit_event_id uuid)`,
    `create index history_record_idx on ${schema}.history (entity_id, record_id, occurred_at)`,
    `grant select, insert on ${schema}.history to ${role}`,
  ];
}

/** Remove an environment: its schema with all data, and its role. */
export function dropEnvironment(names: EnvironmentNames): string[] {
  const role = ident(names.role);
  return [
    `drop schema if exists ${ident(names.schema)} cascade`,
    `do $$ begin if exists (select from pg_roles where rolname = '${names.role}') then ` +
      `execute 'drop owned by ${role}'; execute 'drop role ${role}'; end if; end $$`,
  ];
}
