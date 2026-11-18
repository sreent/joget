import type { Condition } from '@platform/authz';
import { columnName, entityFields, type FieldInfo, type StoredDefinition, type StoredEntity, type StoredField, tableName } from './fields.js';
import type { EnvironmentNames } from './migrations.js';
import type { Period, TimeRange } from './schema.js';
import { afterCursor, compileCondition, fromDatabase, ident, orderBy, type SortKey, SqlBuilder, type SqlQuery, selectExpression, toDatabase } from './sql.js';
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
  /** Text a field must contain, in any case, as a picker finds a record by its title. */
  readonly search?: { readonly field: string; readonly text: string };
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

  const lines = new Set(query.entity.fields.filter((f) => f.type === 'lines').map((f) => f.name));
  const select = [
    ...SYSTEM_COLUMNS.map((column) => `${selectExpression(field(column))} as ${ident(column)}`),
    // Lines live in tables of their own: selectLines reads them.
    ...query.fields
      .filter((name) => !(SYSTEM_COLUMNS as readonly string[]).includes(name) && !lines.has(name))
      .map((name) => `${selectExpression(field(name))} as ${ident(field(name).column)}`),
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
    // The text is a pattern of its own: % and _ in it are plain characters.
    ...(query.search
      ? [
          `(${selectExpression(field(query.search.field))})::text ilike ${sql.param(`%${query.search.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, 'text')} escape '\\'`,
        ]
      : []),
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
    const info = fields.get(field.name);
    if (info && info.column in row) values[field.name] = fromDatabase(info, row[info.column]);
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
  return {
    text: `insert into ${tableOf(names, entity)} as r (${columns.join(', ')}) values (${values.join(', ')}) returning ${returning(entity)}`,
    values: sql.values,
  };
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

/**
 * Lock records against deletion until the transaction ends, and say which exist. A list of records
 * takes only records that exist, and keeps them, as a foreign key keeps a reference to one.
 */
export function lockRecords(names: EnvironmentNames, entity: StoredEntity, ids: readonly string[]): SqlQuery {
  return { text: `select r.id from ${tableOf(names, entity)} as r where r.id = any($1::uuid[]) for key share`, values: [ids] };
}

/** Each field, of an entity or of its lines, that holds several records of an entity. */
export function listsOf(definition: StoredDefinition, target: string): Array<{ readonly entity: StoredEntity; readonly field: StoredField }> {
  return Object.values(definition.entities).flatMap((entity) =>
    entity.fields.filter((field) => field.type === 'reference' && field.multiple === true && field.entity === target).map((field) => ({ entity, field })),
  );
}

/** Whether a list of records, in any record or line, holds a record: while one does, the record stays. */
export function selectHeld(names: EnvironmentNames, lists: ReturnType<typeof listsOf>, id: string): SqlQuery {
  const parts = lists.map(({ entity, field }) => `select from ${tableOf(names, entity)} as r where r.${ident(columnName(field.id))} @> array[$1::uuid]`);
  return { text: `select exists (${parts.join(' union all ')}) as held`, values: [id] };
}

/** A line as stored: its ID and its values. Its place is its position in the record's list. */
export interface StoredLine {
  readonly id: string;
  readonly values: Readonly<Record<string, FieldValue>>;
}

/**
 * Read the lines of some records of the entity whose lines these are, in each record's order.
 * One query serves a whole page of records. Only the fields named come back.
 */
export function selectLines(names: EnvironmentNames, lineEntity: StoredEntity, parentIds: readonly string[], fields?: readonly string[]): SqlQuery {
  const infos = [...entityFields(lineEntity, { line: true }).values()].filter((info) => !info.system && (!fields || fields.includes(info.name)));
  const select = ['l.id', 'l.parent_id', ...infos.map((info) => `${selectExpression(info, 'l')} as ${ident(info.column)}`)];
  return {
    text: `select ${select.join(', ')} from ${tableOf(names, lineEntity)} l where l.parent_id = any($1::uuid[]) order by l.parent_id, l.position`,
    values: [parentIds],
  };
}

/** Rows from selectLines, as each record's lines, by record ID. */
export function parseLines(lineEntity: StoredEntity, rows: ReadonlyArray<Readonly<Record<string, unknown>>>): Map<string, StoredLine[]> {
  const infos = [...entityFields(lineEntity, { line: true }).values()].filter((info) => !info.system);
  const byParent = new Map<string, StoredLine[]>();
  for (const row of rows) {
    const values: Record<string, FieldValue> = {};
    for (const info of infos) if (info.column in row) values[info.name] = fromDatabase(info, row[info.column]);
    const parent = row['parent_id'] as string;
    byParent.set(parent, [...(byParent.get(parent) ?? []), { id: row['id'] as string, values }]);
  }
  return byParent;
}

/**
 * Make a record's lines what they should be, in this order: delete those left out, change those
 * kept where they differ, and add the new ones. Every line in `next` has its ID: new lines get
 * theirs before they are written.
 */
export function writeLines(
  names: EnvironmentNames,
  lineEntity: StoredEntity,
  parentId: string,
  current: readonly StoredLine[],
  next: readonly StoredLine[],
): SqlQuery[] {
  const table = tableOf(names, lineEntity);
  const infos = [...entityFields(lineEntity, { line: true }).values()].filter((info) => !info.system);
  const same = (a: FieldValue | undefined, b: FieldValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const statements: SqlQuery[] = [];
  const kept = new Set(next.map((line) => line.id));
  if (current.some((line) => !kept.has(line.id))) {
    statements.push({ text: `delete from ${table} where parent_id = $1::uuid and not (id = any($2::uuid[]))`, values: [parentId, [...kept]] });
  }
  const before = new Map(current.map((line, position) => [line.id, { line, position }]));
  const added: Array<{ line: StoredLine; position: number }> = [];
  next.forEach((line, position) => {
    const old = before.get(line.id);
    if (!old) return void added.push({ line, position });
    const changed = infos.filter((info) => !same(old.line.values[info.name], line.values[info.name]));
    if (!changed.length && old.position === position) return;
    const sql = new SqlBuilder();
    const sets = [
      `position = ${sql.param(position, 'int')}`,
      ...changed.map((info) => `${ident(info.column)} = ${toDatabase(sql, info, line.values[info.name] ?? null)}`),
    ];
    statements.push({
      text: `update ${table} set ${sets.join(', ')} where id = ${sql.param(line.id, 'uuid')} and parent_id = ${sql.param(parentId, 'uuid')}`,
      values: sql.values,
    });
  });
  if (added.length) {
    const sql = new SqlBuilder();
    const rows = added.map(
      ({ line, position }) =>
        `(${[sql.param(line.id, 'uuid'), sql.param(parentId, 'uuid'), sql.param(position, 'int'), ...infos.map((info) => toDatabase(sql, info, line.values[info.name] ?? null))].join(', ')})`,
    );
    const columns = ['id', 'parent_id', 'position', ...infos.map((info) => ident(info.column))];
    statements.push({ text: `insert into ${table} (${columns.join(', ')}) values ${rows.join(', ')}`, values: sql.values });
  }
  return statements;
}

/** How a record's lines changed, with each line's values under its fields' stable IDs. */
export interface LinesChange {
  readonly added: ReadonlyArray<{
    readonly id: string;
    readonly values: Readonly<Record<string, FieldValue>>;
    readonly sources?: Readonly<Record<string, unknown>>;
  }>;
  readonly removed: ReadonlyArray<{ readonly id: string; readonly values: Readonly<Record<string, FieldValue>> }>;
  readonly changed: ReadonlyArray<{
    readonly id: string;
    readonly changes: Readonly<Record<string, { readonly before: FieldValue; readonly after: FieldValue; readonly source?: unknown }>>;
  }>;
  /** True if the lines that stayed are in a different order. */
  readonly reordered: boolean;
}

/**
 * The changes between a record's lines before and after a write, or null if there are none.
 * `sources` gives where values came from, by the line's position and field name: `2.amount`.
 */
export function diffLines(
  lineEntity: StoredEntity,
  before: readonly StoredLine[],
  after: readonly StoredLine[],
  sources: Readonly<Record<string, unknown>> = {},
): LinesChange | null {
  const same = (a: FieldValue | undefined, b: FieldValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const byId = (line: StoredLine) => Object.fromEntries(lineEntity.fields.map((f) => [f.id, line.values[f.name] ?? null]));
  const old = new Map(before.map((line) => [line.id, line]));
  const now = new Set(after.map((line) => line.id));
  const added: Array<LinesChange['added'][number]> = [];
  const changed: Array<LinesChange['changed'][number]> = [];
  after.forEach((line, position) => {
    const was = old.get(line.id);
    const sourceOf = (field: string) => sources[`${position}.${field}`];
    if (!was) {
      const lineSources = Object.fromEntries(lineEntity.fields.flatMap((f) => (sourceOf(f.name) ? [[f.id, sourceOf(f.name)]] : [])));
      added.push({ id: line.id, values: byId(line), ...(Object.keys(lineSources).length ? { sources: lineSources } : {}) });
      return;
    }
    const changes = Object.fromEntries(
      lineEntity.fields.flatMap((f) => {
        const [b, a] = [was.values[f.name] ?? null, line.values[f.name] ?? null];
        return same(b, a) ? [] : [[f.id, { before: b, after: a, ...(sourceOf(f.name) ? { source: sourceOf(f.name) } : {}) }]];
      }),
    );
    if (Object.keys(changes).length) changed.push({ id: line.id, changes });
  });
  const removed = before.filter((line) => !now.has(line.id)).map((line) => ({ id: line.id, values: byId(line) }));
  const keptBefore = before.filter((line) => now.has(line.id)).map((line) => line.id);
  const keptAfter = after.filter((line) => old.has(line.id)).map((line) => line.id);
  const reordered = keptBefore.some((id, index) => keptAfter[index] !== id);
  if (!added.length && !removed.length && !changed.length && !reordered) return null;
  return { added, removed, changed, reordered };
}

/** One field's change in a record's history, under the field's stable ID so renames keep their history. */
export type HistoryChange =
  | { readonly name: string; readonly before: FieldValue; readonly after: FieldValue; readonly source?: unknown }
  | { readonly name: string; readonly lines: LinesChange };

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
export function diffRecords(
  entity: StoredEntity,
  before: RecordValues | null,
  after: RecordValues | null,
  sources: Readonly<Record<string, unknown>> = {},
): Record<string, HistoryChange> {
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
    values: [
      entry.id,
      entry.entityId,
      entry.recordId,
      entry.version,
      entry.operation,
      JSON.stringify(entry.changes),
      entry.actorType,
      entry.actorId,
      entry.onBehalfOf,
      entry.via,
      entry.at,
      entry.auditEventId,
    ],
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

/** How a summary works out its number, and on which column. */
export interface SummaryMeasure {
  readonly op: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** The number field, or for a count of lines, nothing. */
  readonly info?: FieldInfo;
  /** True if the field (or the count) is of the lines. */
  readonly onLines: boolean;
}

export interface Summarize {
  readonly names: EnvironmentNames;
  readonly entity: StoredEntity;
  /** When the summary works over lines: their entity. Each record then appears once per line. */
  readonly lineEntity?: StoredEntity;
  /** As for selectRecords: the record filters of the read grants, and what guardrails hide. */
  readonly grants: readonly (true | Condition)[];
  readonly exclude?: readonly Condition[];
  readonly where?: readonly (true | Condition)[];
  readonly measure: SummaryMeasure;
  /** Groups: a field's values, or periods of a date. Without one, a single number. */
  readonly group?: { readonly info: FieldInfo; readonly onLines: boolean; readonly period?: Period; readonly limit: number };
  /** Only rows from this moment on: an ISO date for a date field, an ISO time for a time. */
  readonly since?: { readonly info: FieldInfo; readonly onLines: boolean; readonly from: string };
}

/**
 * Work out a number over the records a decision lets the caller read, or over their lines: one
 * number, or one per group. Rows: `value`, and with groups `key`, the total of every group, and
 * how many groups there are, so the caller can fold the rest into "Other". Numbers come back as
 * text, so no precision is lost.
 */
export function summarize(query: Summarize): SqlQuery {
  const sql = new SqlBuilder();
  const fields = entityFields(query.entity);
  const condition = (c: true | Condition) => (c === true ? 'TRUE' : compileCondition(c, fields, sql));
  const joined = query.lineEntity !== undefined;
  const column = (info: FieldInfo, onLines: boolean) => `${onLines ? 'l' : 'r'}.${ident(info.column)}`;

  const { measure } = query;
  const aggregate =
    measure.op === 'count'
      ? measure.onLines
        ? 'count(l.id)'
        : joined
          ? 'count(distinct r.id)'
          : 'count(*)'
      : `${measure.op}(${column(measure.info!, measure.onLines)})`;

  const where = [
    query.grants.length ? `(${query.grants.map(condition).join(' OR ')})` : 'FALSE',
    ...(query.exclude ?? []).map((c) => `NOT ${condition(c)}`),
    ...(query.where ?? []).map(condition),
  ];
  if (query.since) {
    const type = query.since.info.kind === 'date' ? 'date' : 'timestamptz';
    where.push(`${column(query.since.info, query.since.onLines)} >= ${sql.param(query.since.from, type)}`);
  }
  const from = `${tableOf(query.names, query.entity)} r${joined ? ` join ${tableOf(query.names, query.lineEntity!)} l on l.parent_id = r.id` : ''}`;
  if (!query.group) return { text: `select (${aggregate})::text as value from ${from} where ${where.join(' and ')}`, values: sql.values };

  const { info, onLines, period, limit } = query.group;
  const at = column(info, onLines);
  const key = period
    ? `to_char(date_trunc(${sql.param(period, 'text')}, ${info.kind === 'date' ? `${at}::timestamp` : `${at} AT TIME ZONE 'UTC'`}), 'YYYY-MM-DD')`
    : info.kind === 'uuid'
      ? `${at}::text`
      : at;
  // Periods: the latest; anything else: the largest.
  const order = period ? 'key desc nulls last' : 'value_n desc nulls last, key asc nulls last';
  const text =
    `select ${key} as key, (${aggregate})::text as value, ${aggregate} as value_n, (sum(${aggregate}) over ())::text as total, count(*) over () as groups` +
    ` from ${from} where ${where.join(' and ')} group by 1 order by ${order} limit ${sql.param(limit, 'int')}`;
  return { text, values: sql.values };
}

/** When a time range starts, in UTC: as a date for date fields, and as a time for time fields. */
export function rangeStart(within: TimeRange['within'], now: Date): { readonly date: string; readonly time: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const start =
    within === 'this_month'
      ? Date.UTC(y, m, 1)
      : within === 'this_quarter'
        ? Date.UTC(y, m - (m % 3), 1)
        : within === 'this_year'
          ? Date.UTC(y, 0, 1)
          : within === 'last_12_months'
            ? Date.UTC(y, m - 11, 1)
            : Date.UTC(y, m, d - (within === 'last_30_days' ? 30 : 90));
  const time = new Date(start).toISOString();
  return { date: time.slice(0, 10), time };
}
