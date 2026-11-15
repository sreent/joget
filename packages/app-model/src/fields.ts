import type { AppDefinition, Entity, Field, SystemField } from './schema.js';

/** A field with its stable ID, as stored once the platform has assigned IDs. */
export type StoredField = Field & { readonly id: string };
export type StoredEntity = Omit<Entity, 'id' | 'fields'> & { readonly id: string; readonly fields: readonly StoredField[] };
/** A validated definition in which every entity and field has its stable ID. */
export type StoredDefinition = Omit<AppDefinition, 'entities'> & { readonly entities: Readonly<Record<string, StoredEntity>> };

export type LinesField = Extract<Field, { type: 'lines' }>;
export type StoredLinesField = Extract<StoredField, { type: 'lines' }>;

export const isLinesField = <T extends Field>(field: T): field is Extract<T, { type: 'lines' }> => field.type === 'lines';

/** An entity's lines fields, in order. */
export function linesFieldsOf(entity: StoredEntity): StoredLinesField[] {
  return entity.fields.filter(isLinesField);
}

/** A field computed from lines, if it is one. */
export function rollupOf(field: Field): Extract<Field, { type: 'number' }>['rollup'] {
  return field.type === 'number' ? field.rollup : undefined;
}

/** Where a line entity belongs: the entity whose lines it holds, and the lines field. */
export interface LineOwner {
  readonly parent: string;
  readonly field: string;
}

/**
 * The line entities of a definition, each with where it belongs. An entity named by a lines field
 * is part of that field's entity (a validated definition names each at most once).
 */
export function lineOwners(definition: { readonly entities: Readonly<Record<string, { readonly fields: readonly Field[] }>> }): ReadonlyMap<string, LineOwner> {
  const owners = new Map<string, LineOwner>();
  for (const [parent, entity] of Object.entries(definition.entities)) {
    for (const field of entity.fields) {
      if (field.type === 'lines' && !owners.has(field.entity)) owners.set(field.entity, { parent, field: field.name });
    }
  }
  return owners;
}

/**
 * How a value is represented, in JSON and in conditions:
 * `text` and `uuid` are strings, `date` is `YYYY-MM-DD`, `datetime` is an ISO 8601 UTC timestamp
 * with milliseconds, and `text[]` is a non-empty list of strings. An empty value is `null` in
 * JSON and counts as missing in conditions.
 */
export type ValueKind = 'text' | 'uuid' | 'number' | 'boolean' | 'date' | 'datetime' | 'text[]';

export interface FieldInfo {
  readonly name: string;
  readonly kind: ValueKind;
  /** The database column. User fields are named after their stable ID. */
  readonly column: string;
  readonly system: boolean;
  /** The definition, for user fields. */
  readonly field?: StoredField;
}

const SYSTEM_KINDS: Record<SystemField, ValueKind> = {
  id: 'uuid',
  version: 'number',
  owner: 'uuid',
  created_at: 'datetime',
  created_by: 'uuid',
  updated_at: 'datetime',
  updated_by: 'uuid',
};

export function fieldKind(field: Field): ValueKind {
  switch (field.type) {
    case 'text':
    case 'email':
      return 'text';
    case 'choice':
      return field.multiple ? 'text[]' : 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'reference':
    case 'user':
      return 'uuid';
    case 'lines':
      throw new Error(`${field.name} holds lines, which have no single value`);
  }
}

export const columnName = (fieldId: string): string => `f_${fieldId}`;
export const tableName = (entityId: string): string => `e_${entityId}`;

/**
 * Every field with a single value that a record of the entity has, system fields first, by name.
 * Lines fields are left out: their lines live in a table of their own. A line has one system
 * field, its `id`: it belongs to its record, which has the rest.
 */
export function entityFields(entity: StoredEntity, options: { readonly line?: boolean } = {}): ReadonlyMap<string, FieldInfo> {
  const fields = new Map<string, FieldInfo>();
  for (const [name, kind] of Object.entries(SYSTEM_KINDS)) {
    if (!options.line || name === 'id') fields.set(name, { name, kind, column: name, system: true });
  }
  for (const field of entity.fields) {
    if (field.type === 'lines') continue;
    fields.set(field.name, { name: field.name, kind: fieldKind(field), column: columnName(field.id), system: false, field });
  }
  return fields;
}

/** The fields of an entity of a definition, as entityFields, knowing whether it is a line entity. */
export function definitionFields(definition: StoredDefinition, entityName: string): ReadonlyMap<string, FieldInfo> {
  return entityFields(definition.entities[entityName]!, { line: lineOwners(definition).has(entityName) });
}

/** The JavaScript type of a kind's values in conditions. */
export function jsTypeOf(kind: ValueKind): 'string' | 'number' | 'boolean' | 'array' {
  switch (kind) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'text[]':
      return 'array';
    default:
      return 'string';
  }
}

/** Kinds that conditions can test. Dates and timestamps can't be compared yet, so they are left out. */
export function isConditionKind(kind: ValueKind): boolean {
  return kind !== 'date' && kind !== 'datetime';
}

/** Kinds a list can be sorted by. */
export function isSortableKind(kind: ValueKind): boolean {
  return kind !== 'text[]';
}

/** Fields a caller may write: every user field that isn't worked out from lines, plus `owner`. */
export function isWritable(info: FieldInfo): boolean {
  if (info.field) return !rollupOf(info.field);
  return info.name === 'owner';
}
