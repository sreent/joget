import type { Condition } from '@platform/authz';
import { entityFields, tableName, type FieldInfo, type StoredEntity } from './fields.js';
import type { EnvironmentNames } from './migrations.js';
import { afterCursor, compileCondition, fromDatabase, ident, orderBy, selectExpression, SqlBuilder, toDatabase, type SortKey, type SqlQuery } from './sql.js';
import type { FieldValue, RecordValues } from './values.js';

/** A record as the platform returns it: system fields, and the values of user fields. */
export interface StoredRecord {
  readonly id: string;
  readonly version: number;
  readonly owner: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly values: Readonly<Record<string, FieldValue>>;
}

/** Every value of a record, system fields included, as conditions see them. */
export function recordValues(record: StoredRecord): RecordValues {
  return {
    ...record.values,
    id: record.id,
    version: record.version,
    owner: record.owner,
    created_at: record.createdAt,
    created_by: record.createdBy,
    updated_at: record.updatedAt,
    updated_by: record.updatedBy,
  };
}

const SYSTEM_COLUMNS = ['id', 'version', 'owner', 'created_at', 'created_by', 'updated_at', 'updated_by'] as const;

const tableOf = (names: EnvironmentNames, entity: StoredEntity) => `${ident(names.schema)}.${ident(tableName(entity.id))}`;

export interface SelectRecords {
  readonly names: EnvironmentNames;
  readonly entity: StoredEntity;
  /** The user fields to return. System fields always come back. */
  readonly fields: readonly string[];
  /**
   * The record filters of the read grants: a row must satisfy at least one. Each conditional one
   * also comes back as a flag on the row, so the caller knows which grants apply to which row.
   */
  readonly grants: readonly (true | Condition)[];
  /** Guardrails that hide some records. */
  readonly exclude?: readonly Condition[];
  /** More conditions every row must satisfy, such as a query's filter. */
  readonly where?: readonly (true | Condition)[];
  readonly id?: string;
  readonly sort?: ReadonlyArray<{ readonly field: string; readonly direction: 'asc' | 'desc' }>;
  /** The sort values of the last row of the previous page. */
  readonly after?: readonly FieldValue[];
  readonly limit?: number;
  /** Lock the rows for the rest of the transaction, for a write. */
  readonly forUpdate?: boolean;
}

export interface RecordSelect extends SqlQuery {
  /** For each flag column, in order, the index of its grant. */
  readonly flagGrants: readonly number[];
  /** The full sort order, ending with the record ID, to build cursors with. */
  readonly sortKeys: readonly SortKey[];
}

/**
 * Read records under a decision's filters. Without any grant, nothing matches: callers can't
 * accidentally read without a permission check.
 */
export function selectRecords(query: SelectRecords): RecordSelect {
  const sql = new SqlBuilder();
  const fields = entityFields(query.entity);
  const field = (name: string) => {
    const info = fields.get(name);
    if (!info) throw new Error(`No field ${name}`);
    return info;
  };
  const condition = (c: true | Condition) => (c === true ? 'TRUE' : compileCondition(c, fields, sql));

  const select = [
    ...SYSTEM_COLUMNS.map((column) => `${selectExpression(field(column))} as ${ident(column)}`),
    ...query.fields.filter((name) => !(SYSTEM_COLUMNS as readonly string[]).includes(name)).map((name) => `${selectExpression(field(name))} as ${ident(field(name).column)}`),
  ];
  const flagGrants: number[] = [];
  query.grants.forEach((grant, index) => {
    if (grant === true) return;
    select.push(`${condition(grant)} as ${ident(`g${flagGrants.length}`)}`);
    flagGrants.push(index);
  });

  const where = [
    query.grants.length ? `(${query.grants.map(condition).join(' OR ')})` : 'FALSE',
    ...(query.exclude ?? []).map((c) => `NOT ${condition(c)}`),
    ...(query.where ?? []).map(condition),
    ...(query.id !== undefined ? [`r.id = ${sql.param(query.id, 'uuid')}`] : []),
  ];
  const sortKeys: SortKey[] = [
    ...(query.sort ?? []).map((s) => ({ info: field(s.field), direction: s.direction })),
    { info: field('id'), direction: query.sort?.at(-1)?.direction ?? 'desc' },
  ];
  if (query.after) where.push(afterCursor(sortKeys, query.after, sql));

  const text =
    `select ${select.join(', ')} from ${tableOf(query.names, query.entity)} r where ${where.join(' and ')}` +
    ` order by ${orderBy(sortKeys)}` +
    (query.limit !== undefined ? ` limit ${sql.param(query.limit, 'int')}` : '') +
    (query.forUpdate ? ' for update' : '');
  return { text, values: sql.values, flagGrants, sortKeys };
}

/** A row from selectRecords, as a record, with the flags of its conditional grants. */
export function parseRecord(entity: StoredEntity, row: Readonly<Record<string, unknown>>, flagCount = 0): { record: StoredRecord; flags: boolean[] } {
  const fields = entityFields(entity);
  const values: Record<string, FieldValue> = {};
  for (const field of entity.fields) {
    const info = fields.get(field.name)!;
    if (info.column in row) values[field.name] = fromDatabase(info, row[info.column]);
  }
  const system = (name: (typeof SYSTEM_COLUMNS)[number]) => fromDatabase(fields.get(name)!, row[name]);
  return {
    record: {
      id: system('id') as string,
      version: system('version') as number,
      owner: system('owner') as string,
      createdAt: system('created_at') as string,
      createdBy: system('created_by') as string,
      updatedAt: system('updated_at') as string,
      updatedBy: system('updated_by') as string,
      values,
    },
    flags: Array.from({ length: flagCount }, (_, i) => row[`g${i}`] === true),
  };
}

/** The sort values of a record, to continue after it. */
export function cursorOf(record: StoredRecord, keys: readonly SortKey[]): FieldValue[] {
  const values = recordValues(record);
  return keys.map((key) => values[key.info.name] ?? null);
}

function returning(entity: StoredEntity): string {
  const fields = entityFields(entity);
  return [...fields.values()].map((info) => `${selectExpression(info)} as ${ident(info.column)}`).join(', ');
}

export function insertRecord(
  names: EnvironmentNames,
  entity: StoredEntity,
  record: { readonly id: string; readonly owner: string; readonly actor: string; readonly at: string; readonly values: RecordValues },
): SqlQuery {
  const sql = new SqlBuilder();
  const fields = entityFields(entity);
  const columns = ['id', 'version', 'owner', 'created_at', 'created_by', 'updated_at', 'updated_by'].map(ident);
  const values = [
    sql.param(record.id, 'uuid'),
    '1',
    sql.param(record.owner, 'uuid'),
    sql.param(record.at, 'timestamptz'),
    sql.param(record.actor, 'uuid'),
    sql.param(record.at, 'timestamptz'),
    sql.param(record.actor, 'uuid'),
  ];
  for (const [name, value] of Object.entries(record.values)) {
    const info = fields.get(name);
    if (!info || info.system) continue;
    columns.push(ident(info.column));
    values.push(toDatabase(sql, info, value));
  }
  return { text: `insert into ${tableOf(names, entity)} as r (${columns.join(', ')}) values (${values.join(', ')}) returning ${returning(entity)}`, values: sql.values };
}

/** Update the given fields (and `owner`, if given), and bump the version. */
export function updateRecord(
  names: EnvironmentNames,
  entity: StoredEntity,
  change: { readonly id: string; readonly actor: string; readonly at: string; readonly values: RecordValues },
): SqlQuery {
  const sql = new SqlBuilder();
  const fields = entityFields(entity);
  const sets = ['version = r.version + 1', `updated_at = ${sql.param(change.at, 'timestamptz')}`, `updated_by = ${sql.param(change.actor, 'uuid')}`];
  for (const [name, value] of Object.entries(change.values)) {
    const info = fields.get(name);
    if (!info || (info.system && name !== 'owner')) continue;
    sets.push(`${ident(info.column)} = ${toDatabase(sql, info, value)}`);
  }
  return {
    text: `update ${tableOf(names, entity)} as r set ${sets.join(', ')} where r.id = ${sql.param(change.id, 'uuid')} returning ${returning(entity)}`,
    values: sql.values,
  };
}

export function deleteRecord(names: EnvironmentNames, entity: StoredEntity, id: string): SqlQuery {
  return { text: `delete from ${tableOf(names, entity)} as r where r.id = $1::uuid`, values: [id] };
}

/** One field's change in a record's history, under the field's stable ID so renames keep their history. */
export interface HistoryChange {
  readonly name: string;
  readonly before: FieldValue;
  readonly after: FieldValue;
  readonly source?: unknown;
}

export interface HistoryEntry {
  readonly id: string;
  readonly entityId: string;
  readonly recordId: string;
  readonly version: number;
  readonly operation: 'create' | 'update' | 'delete';
  readonly changes: Readonly<Record<string, HistoryChange>>;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly onBehalfOf: string | null;
  readonly via: string;
  readonly at: string;
  readonly auditEventId: string | null;
}

/** The changes between two versions of a record, keyed by field ID. */
export function diffRecords(entity: StoredEntity, before: RecordValues | null, after: RecordValues | null, sources: Readonly<Record<string, unknown>> = {}): Record<string, HistoryChange> {
  const changes: Record<string, HistoryChange> = {};
  const same = (a: FieldValue, b: FieldValue) => JSON.stringify(a) === JSON.stringify(b);
  for (const field of entity.fields) {
    const was = before?.[field.name] ?? null;
    const now = after?.[field.name] ?? null;
    if (!same(was, now)) changes[field.id] = { name: field.name, before: was, after: now, ...(sources[field.name] ? { source: sources[field.name] } : {}) };
  }
  const [wasOwner, nowOwner] = [before?.['owner'] ?? null, after?.['owner'] ?? null];
  if (!same(wasOwner, nowOwner)) changes['owner'] = { name: 'owner', before: wasOwner, after: nowOwner };
  return changes;
}

export function insertHistory(names: EnvironmentNames, entry: HistoryEntry): SqlQuery {
  return {
    text:
      `insert into ${ident(names.schema)}.history (id, entity_id, record_id, version, operation, changes, actor_type, actor_id, on_behalf_of, via, occurred_at, audit_event_id) ` +
      'values ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7, $8::uuid, $9::uuid, $10, $11::timestamptz, $12::uuid)',
    values: [entry.id, entry.entityId, entry.recordId, entry.version, entry.operation, JSON.stringify(entry.changes), entry.actorType, entry.actorId, entry.onBehalfOf, entry.via, entry.at, entry.auditEventId],
  };
}

export function selectHistory(names: EnvironmentNames, entity: StoredEntity, recordId: string): SqlQuery {
  return {
    text:
      `select id, version, operation, changes, actor_type, actor_id, on_behalf_of, via, ` +
      `to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at, audit_event_id ` +
      `from ${ident(names.schema)}.history where entity_id = $1 and record_id = $2::uuid order by occurred_at, id`,
    values: [entity.id, recordId],
  };
}

/** Field infos by name, for callers that need column details. */
export function fieldInfo(entity: StoredEntity, name: string): FieldInfo | undefined {
  return entityFields(entity).get(name);
}
