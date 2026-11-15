import type { AppDefinition, Entity, Field, SystemField } from './schema.js';

/** A field with its stable ID, as stored once the platform has assigned IDs. */
export type StoredField = Field & { readonly id: string };
export type StoredEntity = Omit<Entity, 'id' | 'fields'> & { readonly id: string; readonly fields: readonly StoredField[] };
/** A validated definition in which every entity and field has its stable ID. */
export type StoredDefinition = Omit<AppDefinition, 'entities'> & { readonly entities: Readonly<Record<string, StoredEntity>> };

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
  }
}

export const columnName = (fieldId: string): string => `f_${fieldId}`;
export const tableName = (entityId: string): string => `e_${entityId}`;

/** Every field a record of the entity has, system fields first, by name. */
export function entityFields(entity: StoredEntity): ReadonlyMap<string, FieldInfo> {
  const fields = new Map<string, FieldInfo>();
  for (const [name, kind] of Object.entries(SYSTEM_KINDS)) fields.set(name, { name, kind, column: name, system: true });
  for (const field of entity.fields) {
    fields.set(field.name, { name: field.name, kind: fieldKind(field), column: columnName(field.id), system: false, field });
  }
  return fields;
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

/** Fields a caller may write: every user field, plus `owner`. */
export function isWritable(info: FieldInfo): boolean {
  return !info.system || info.name === 'owner';
}
