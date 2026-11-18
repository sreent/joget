import { columnName, formulaOf, hasFiles, lineOwners, refersToMany, rollupOf, tableName, type StoredDefinition, type StoredEntity, type StoredField } from './fields.js';
import { formulaFields, formulaUpdates } from './formulas.js';
import { NAME_PATTERN } from './schema.js';
import { ident } from './sql.js';

/** Where an app environment's data lives: its schema, and the role that alone may use it. */
export interface EnvironmentNames {
  readonly schema: string;
  readonly role: string;
}

/**
 * Schema and role names for an app's environment, for example `app_0193..._sandbox`. A team app
 * has a preview for each change request, so a preview's names carry the request's number.
 */
export function environmentNames(appId: string, kind: 'sandbox' | 'staging' | 'prod'): EnvironmentNames;
export function environmentNames(appId: string, kind: 'preview', changeRequest: number): EnvironmentNames;
export function environmentNames(appId: string, kind: 'sandbox' | 'preview' | 'staging' | 'prod', changeRequest?: number): EnvironmentNames {
  const suffix = kind === 'preview' ? `preview${changeRequest!}` : kind;
  const name = `app_${appId.replaceAll('-', '').toLowerCase()}_${suffix}`;
  return { schema: name, role: name };
}

export type MigrationStep = { readonly destructive: boolean; readonly description: string } & (
  | { readonly kind: 'create_entity'; readonly entity: string }
  | { readonly kind: 'drop_entity'; readonly entity: string }
  | { readonly kind: 'rename_entity'; readonly from: string; readonly to: string }
  | { readonly kind: 'reshape_entity'; readonly entity: string }
  | { readonly kind: 'add_field'; readonly entity: string; readonly field: string }
  | { readonly kind: 'drop_field'; readonly entity: string; readonly field: string }
  | { readonly kind: 'rename_field'; readonly entity: string; readonly from: string; readonly to: string }
  | { readonly kind: 'retype_field'; readonly entity: string; readonly field: string; readonly from: string; readonly to: string }
  | { readonly kind: 'add_unique'; readonly entity: string; readonly field: string }
  | { readonly kind: 'drop_unique'; readonly entity: string; readonly field: string }
  | { readonly kind: 'require_field'; readonly entity: string; readonly field: string }
  | { readonly kind: 'compute_field'; readonly entity: string; readonly field: string }
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

/**
 * The column type a field needs, or null for a lines field, whose lines have a table of their own.
 * Fields with the same physical type can change without touching data.
 */
export function physicalType(field: StoredField, entities: Readonly<Record<string, StoredEntity>>): string | null {
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
      // A list of records has no foreign key: the platform keeps it true as it writes and deletes.
      return field.multiple ? `uuid[] of ${tableName(entities[field.entity]!.id)}` : `uuid references ${tableName(entities[field.entity]!.id)}`;
    case 'file':
      return 'uuid references files';
    case 'lines':
      return null;
  }
}

const isUnique = (field: StoredField) => 'unique' in field && field.unique === true;

/** A string literal for a comment. Only identifier-shaped names are ever written, so no text a builder typed reaches the SQL. */
function nameLiteral(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Unexpected name ${name}`);
  return `'${name}'`;
}

/** What a table looks like: a record table, or the lines of a record table (by the parent entity's ID). */
function shapeOf(definition: StoredDefinition | undefined, name: string): string | null {
  if (!definition) return null;
  const owner = lineOwners(definition).get(name);
  return owner ? definition.entities[owner.parent]!.id : null;
}

/** What a rollup depends on, by stable IDs: when this changes, the stored values must be worked out again. */
function rollupSignature(definition: StoredDefinition, entity: StoredEntity, field: StoredField): string | null {
  const rollup = rollupOf(field);
  if (!rollup) return null;
  const [op, path] = Object.entries(rollup)[0] as [string, string];
  const [linesName, sub] = path.split('.');
  const lines = entity.fields.find((f) => f.name === linesName);
  if (lines?.type !== 'lines') return null;
  const lineEntity = definition.entities[lines.entity]!;
  const source = sub ? lineEntity.fields.find((f) => f.name === sub) : undefined;
  return JSON.stringify([op, lines.id, lineEntity.id, source?.id ?? null, source ? physicalType(source, definition.entities) : null]);
}

/** What an entity's formulas depend on: each formula and the field that keeps it. A change means working them out again. */
function formulaSignature(entity: StoredEntity): string {
  return JSON.stringify(
    formulaFields(entity).map((field) => [field.id, formulaOf(field), field.type, 'decimals' in field ? field.decimals : null, 'maxLength' in field ? field.maxLength : null, 'min' in field ? (field.min ?? null) : null, 'max' in field ? (field.max ?? null) : null]),
  );
}

/** The statement that works out a stored rollup for every record, or null if the field is no rollup. */
function rollupUpdate(
  definition: StoredDefinition,
  entity: StoredEntity,
  field: StoredField,
  tableOf: (id: string) => string,
  column: (field: StoredField) => string,
): string | null {
  const rollup = rollupOf(field);
  if (!rollup) return null;
  const [op, path] = Object.entries(rollup)[0] as [string, string];
  const [linesName, sub] = path.split('.');
  const lines = entity.fields.find((f) => f.name === linesName);
  if (lines?.type !== 'lines') return null;
  const lineEntity = definition.entities[lines.entity]!;
  const source = sub ? lineEntity.fields.find((f) => f.name === sub) : undefined;
  const aggregate = op === 'count' ? 'count(*)' : op === 'sum' ? `coalesce(sum(l.${column(source!)}), 0)` : `${op}(l.${column(source!)})`;
  return `update ${tableOf(entity.id)} as r set ${column(field)} = (select ${aggregate} from ${tableOf(lineEntity.id)} l where l.parent_id = r.id)`;
}

/**
 * Work out every stored rollup again. Run it when an environment goes forward again after a
 * rollback: the older release did not keep the newer rollups up to date.
 */
export function recomputeRollups(definition: StoredDefinition, names: EnvironmentNames): string[] {
  const schema = ident(names.schema);
  const tableOf = (id: string) => `${schema}.${ident(tableName(id))}`;
  const column = (field: StoredField) => ident(columnName(field.id));
  // Formulas too: a line's, then the rollups of its lines, then the record's own.
  const owners = lineOwners(definition);
  const formulas = (line: boolean) =>
    Object.entries(definition.entities).flatMap(([name, entity]) => (owners.has(name) === line ? formulaUpdates(entity, tableOf(entity.id), { line }) : []));
  const rollups = Object.values(definition.entities).flatMap((entity) =>
    entity.fields.flatMap((field) => {
      const statement = rollupUpdate(definition, entity, field, tableOf, column);
      return statement ? [statement] : [];
    }),
  );
  return [...formulas(true), ...rollups, ...formulas(false)];
}

/**
 * The steps that turn `previous` into `next`, and the DDL that makes them so.
 *
 * Entities and fields are matched by stable ID, so renames touch no data. A changed column type
 * is dropped and added again, which loses the column's values and so counts as destructive. So
 * does turning an entity into the lines of another, or back: its table is made again.
 */
export function planMigration(previous: StoredDefinition | undefined, next: StoredDefinition, names: EnvironmentNames): MigrationPlan {
  const schema = ident(names.schema);
  const role = ident(names.role);
  const tableOf = (id: string) => `${schema}.${ident(tableName(id))}`;
  const table = (entity: StoredEntity) => tableOf(entity.id);
  const column = (field: StoredField) => ident(columnName(field.id));
  const index = (entity: StoredEntity, field: StoredField, suffix: string) => ident(`${tableName(entity.id)}_${columnName(field.id)}_${suffix}`);

  const before = new Map(Object.entries(previous?.entities ?? {}).map(([name, entity]) => [entity.id, { name, entity }]));
  const after = new Map(Object.entries(next.entities).map(([name, entity]) => [entity.id, { name, entity }]));
  const ownersAfter = lineOwners(next);

  const steps: MigrationStep[] = [];
  const impact: Array<{ step: number; sql: string }> = [];
  const dropTables: string[] = [];
  const drops: string[] = [];
  const creates: string[] = [];
  const lineCreates: string[] = [];
  const adds: string[] = [];
  const references: string[] = [];
  const indexes: string[] = [];
  const comments: string[] = [];
  const computes: string[] = [];
  /** Entities whose tables start empty in this migration. */
  const fresh = new Set<string>();
  const step = (s: MigrationStep, impactSql?: string) => {
    if (impactSql) impact.push({ step: steps.length, sql: impactSql });
    steps.push(s);
  };

  const addColumn = (entity: StoredEntity, field: StoredField) => {
    const type = physicalType(field, next.entities);
    if (type === null) return;
    if (refersToMany(field)) {
      adds.push(`alter table ${table(entity)} add column ${column(field)} uuid[]`);
      // Which records hold a record in their list: for pages about it, and before it is deleted.
      indexes.push(`create index ${index(entity, field, 'idx')} on ${table(entity)} using gin (${column(field)})`);
    } else if (field.type === 'reference' || field.type === 'file') {
      // A file stays while anything refers to it: a record, a line, or their history.
      const target = field.type === 'reference' ? tableOf(next.entities[field.entity]!.id) : `${schema}.files`;
      references.push(`alter table ${table(entity)} add column ${column(field)} uuid references ${target} (id) on delete restrict`);
      references.push(`create index ${index(entity, field, 'idx')} on ${table(entity)} (${column(field)})`);
    } else {
      adds.push(`alter table ${table(entity)} add column ${column(field)} ${type}`);
    }
    if (isUnique(field)) indexes.push(`create unique index ${index(entity, field, 'key')} on ${table(entity)} (${column(field)})`);
    comments.push(`comment on column ${table(entity)}.${column(field)} is ${nameLiteral(field.name)}`);
  };

  const createTable = (name: string, entity: StoredEntity) => {
    const parent = shapeOf(next, name);
    fresh.add(entity.id);
    if (parent === null) {
      creates.push(
        `create table ${table(entity)} (id uuid primary key, version integer not null default 1, owner uuid not null, ` +
          'created_at timestamptz not null, created_by uuid not null, updated_at timestamptz not null, updated_by uuid not null)',
        `create index ${ident(`${tableName(entity.id)}_owner_idx`)} on ${table(entity)} (owner)`,
        `grant select, insert, update, delete on ${table(entity)} to ${role}`,
      );
    } else {
      // Lines belong to their record: they go when it goes, and keep their order.
      lineCreates.push(
        `create table ${table(entity)} (id uuid primary key, parent_id uuid not null references ${tableOf(parent)} (id) on delete cascade, position integer not null)`,
        `create index ${ident(`${tableName(entity.id)}_parent_idx`)} on ${table(entity)} (parent_id, position)`,
        `grant select, insert, update, delete on ${table(entity)} to ${role}`,
      );
    }
    comments.push(`comment on table ${table(entity)} is ${nameLiteral(name)}`);
    for (const field of entity.fields) addColumn(entity, field);
  };

  const describeShape = (name: string) => {
    const owner = ownersAfter.get(name);
    return owner ? `the lines of ${owner.parent}.${owner.field}` : 'records of its own';
  };

  for (const [id, { name, entity }] of after) {
    const old = before.get(id);
    if (!old) {
      const owner = ownersAfter.get(name);
      step({ kind: 'create_entity', entity: name, destructive: false, description: owner ? `Create ${name}, the lines of ${owner.parent}.${owner.field}` : `Create ${name}` });
      createTable(name, entity);
      continue;
    }
    if (shapeOf(previous, old.name) !== shapeOf(next, name)) {
      step(
        { kind: 'reshape_entity', entity: name, destructive: true, description: `Make ${name} ${describeShape(name)}, which deletes its records` },
        `select count(*)::int as n from ${table(old.entity)}`,
      );
      dropTables.push(table(old.entity));
      createTable(name, entity);
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
      if (field.type === 'lines') {
        // The lines themselves go with their entity, whose own step says so.
        step({ kind: 'drop_field', entity: name, field: field.name, destructive: false, description: `Remove the lines field ${name}.${field.name}` });
        continue;
      }
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
        if (field.required && field.type !== 'lines') {
          step(
            { kind: 'require_field', entity: name, field: field.name, destructive: false, description: `Existing ${name} records have no ${field.name} yet` },
            `select count(*)::int as n from ${table(entity)}`,
          );
        }
        continue;
      }
      if (oldField.name !== field.name) {
        step({ kind: 'rename_field', entity: name, from: oldField.name, to: field.name, destructive: false, description: `Rename ${name}.${oldField.name} to ${field.name}; no data changes` });
        if (field.type !== 'lines') comments.push(`comment on column ${table(entity)}.${column(field)} is ${nameLiteral(field.name)}`);
      }
      // A reference's type names its target table, so pointing it at another entity counts as a new type.
      const [oldType, newType] = [physicalType(oldField, previous!.entities), physicalType(field, next.entities)];
      // A reference to one record becomes a list of records that holds it, losing nothing.
      if (oldType !== newType && oldField.type === 'reference' && !oldField.multiple && field.type === 'reference' && field.multiple && oldType === `uuid references ${tableName(next.entities[field.entity]!.id)}`) {
        step({ kind: 'retype_field', entity: name, field: field.name, from: 'reference', to: 'references', destructive: false, description: `Let ${name}.${field.name} hold several records; each record keeps the one it has` });
        const list = ident(`${columnName(field.id)}_list`);
        drops.push(
          `alter table ${table(entity)} add column ${list} uuid[]`,
          `update ${table(entity)} set ${list} = array[${column(oldField)}] where ${column(oldField)} is not null`,
          // Its foreign key and its index go with it.
          `alter table ${table(entity)} drop column ${column(oldField)}`,
          `alter table ${table(entity)} rename column ${list} to ${column(field)}`,
        );
        indexes.push(`create index ${index(entity, field, 'idx')} on ${table(entity)} using gin (${column(field)})`);
        comments.push(`comment on column ${table(entity)}.${column(field)} is ${nameLiteral(field.name)}`);
        continue;
      }
      if (oldType !== newType) {
        step(
          {
            kind: 'retype_field',
            entity: name,
            field: field.name,
            from: oldField.type,
            to: field.type,
            destructive: oldType !== null,
            description: `Change ${name}.${field.name} from ${oldField.type} to ${field.type}${oldType !== null ? ', which deletes its values' : ''}`,
          },
          oldType !== null ? `select count(*)::int as n from ${table(entity)} where ${column(oldField)} is not null` : undefined,
        );
        if (oldType !== null) drops.push(`alter table ${table(entity)} drop column ${column(oldField)}`);
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
        if (field.type === 'lines') {
          const lines = next.entities[field.entity]!;
          step(
            { kind: 'require_field', entity: name, field: field.name, destructive: false, description: `Make ${name}.${field.name} need at least one line; records without any keep working until edited` },
            `select count(*)::int as n from ${table(entity)} r where not exists (select from ${table(lines)} l where l.parent_id = r.id)`,
          );
        } else {
          step(
            { kind: 'require_field', entity: name, field: field.name, destructive: false, description: `Make ${name}.${field.name} required; existing records without a value keep working until edited` },
            `select count(*)::int as n from ${table(entity)} where ${column(field)} is null`,
          );
        }
      }
    }
  }

  // Formulas are stored too. A line's come first, then its record's rollups, then the record's own.
  const lineFormulas: string[] = [];
  const recordFormulas: string[] = [];
  const formulasChanged = new Set<string>();
  for (const [id, { entity }] of after) {
    if (fresh.has(id) || !formulaFields(entity).length) continue;
    const old = before.get(id);
    if (!old || formulaSignature(old.entity) !== formulaSignature(entity)) formulasChanged.add(id);
  }
  const rolledUp = new Set<string>();

  // Rollups are stored, so existing records need them worked out when what they depend on changes.
  for (const [id, { name, entity }] of after) {
    if (fresh.has(id)) continue;
    const old = before.get(id)!;
    for (const field of entity.fields) {
      const signature = rollupSignature(next, entity, field);
      if (signature === null) continue;
      const oldField = old.entity.fields.find((f) => f.id === field.id);
      const lines = entity.fields.find((f) => f.type === 'lines' && f.name === Object.values(rollupOf(field)!)[0]!.split('.')[0]);
      const lineEntity = next.entities[(lines as { entity: string }).entity]!;
      const unchanged = oldField && rollupSignature(previous!, old.entity, oldField) === signature && !fresh.has(lineEntity.id) && !formulasChanged.has(lineEntity.id);
      if (unchanged) continue;
      rolledUp.add(id);
      step(
        { kind: 'compute_field', entity: name, field: field.name, destructive: false, description: `Work out ${name}.${field.name} for existing records` },
        `select count(*)::int as n from ${table(entity)}`,
      );
      computes.push(rollupUpdate(next, entity, field, tableOf, column)!);
    }
  }

  for (const [id, { name, entity }] of after) {
    if (fresh.has(id) || !(formulasChanged.has(id) || rolledUp.has(id)) || !formulaFields(entity).length) continue;
    const line = ownersAfter.has(name);
    for (const field of formulaFields(entity)) {
      step({ kind: 'compute_field', entity: name, field: field.name, destructive: false, description: `Work out ${name}.${field.name} for existing ${line ? 'lines' : 'records'}` }, `select count(*)::int as n from ${table(entity)}`);
    }
    (line ? lineFormulas : recordFormulas).push(...formulaUpdates(entity, table(entity), { line }));
  }

  const dropped = [...before].filter(([id]) => !after.has(id));
  for (const [, { name, entity }] of dropped) {
    step({ kind: 'drop_entity', entity: name, destructive: true, description: `Delete ${name} and all its records` }, `select count(*)::int as n from ${table(entity)}`);
    dropTables.push(table(entity));
  }
  // Drop the tables together, so references between them don't get in the way.
  if (dropTables.length) drops.unshift(`drop table ${dropTables.join(', ')}`);

  // Environments made before file fields existed get their file tables with their first file field.
  const fileTables = hasFiles(next) && !hasFiles(previous ?? { entities: {} }) ? filesTables(names) : [];

  return {
    steps,
    destructive: steps.some((s) => s.destructive),
    statements: [...drops, ...fileTables, ...creates, ...lineCreates, ...adds, ...references, ...indexes, ...comments, ...lineFormulas, ...computes, ...recordFormulas],
    impact,
  };
}

/**
 * An environment's files: what each is, who uploaded it and for whom, and, in the database store,
 * its content. A file is attached once a record refers to it; until then it expires. The role may
 * add and read files, and attach them, but never delete one: the platform removes expired files.
 */
export function filesTables(names: EnvironmentNames): string[] {
  const schema = ident(names.schema);
  const role = ident(names.role);
  return [
    `create table if not exists ${schema}.files (id uuid primary key, name text not null, content_type text not null, size bigint not null, ` +
      `sha256 text not null, storage_key text not null, scan text not null check (scan in ('clean', 'not_scanned')), ` +
      `created_at timestamptz not null, created_by uuid not null, on_behalf_of uuid, ` +
      `attached_at timestamptz, entity_id text, record_id uuid, expires_at timestamptz)`,
    `create index if not exists files_expiry_idx on ${schema}.files (expires_at) where attached_at is null`,
    `create table if not exists ${schema}.file_contents (file_id uuid primary key references ${schema}.files (id) on delete cascade, content bytea not null)`,
    `grant select, insert on ${schema}.files, ${schema}.file_contents to ${role}`,
    `grant update (attached_at, entity_id, record_id, expires_at) on ${schema}.files to ${role}`,
  ];
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
    ...filesTables(names),
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
