import { COMPARISON_OPERATORS, evaluateCondition, isRef, isRelativeTime, relativeValue, timeOf, type Condition, type Operand } from '@platform/authz';
import { jsTypeOf, type FieldInfo, type ValueKind } from './fields.js';
import { isCanonicalUuid, type FieldValue } from './values.js';

/**
 * SQL for the built-in store. Every identifier comes from a validated definition (stable IDs,
 * system column names) and is quoted anyway; every value is a parameter. Nothing a caller sends
 * is ever spliced into SQL text.
 */
export class SqlBuilder {
  readonly values: unknown[] = [];

  /** A placeholder for a value, with an explicit type so PostgreSQL never has to guess. */
  param(value: unknown, cast?: string): string {
    this.values.push(value);
    return `$${this.values.length}${cast ? `::${cast}` : ''}`;
  }
}

export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

export class CompileError extends Error {
  override readonly name = 'CompileError';
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Quote an identifier. Only platform-generated names are accepted. */
export function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new CompileError(`Unexpected identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export function sqlType(kind: ValueKind): string {
  switch (kind) {
    case 'text':
      return 'text';
    case 'uuid':
      return 'uuid';
    case 'number':
      return 'numeric';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamptz';
    case 'text[]':
      return 'text[]';
  }
}

type Term =
  | { readonly kind: 'column'; readonly info: FieldInfo; readonly sql: string }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null };

const SQL_COMPARISON = { lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

/**
 * Compile a condition on a record to a SQL boolean expression.
 *
 * The condition must refer only to `record.<field>` (run partialEvaluate first). The SQL gives
 * exactly the answer evaluateCondition gives for the record in canonical form, where empty
 * values are missing: every comparison is `IS TRUE`, so NULL never leaks into the logic, and
 * `not` behaves as it does in TypeScript.
 */
export function compileCondition(
  condition: Condition,
  fields: ReadonlyMap<string, FieldInfo>,
  sql: SqlBuilder,
  alias = 'r',
): string {
  const column = (ref: string): Extract<Term, { kind: 'column' }> => {
    if (!ref.startsWith('record.')) throw new CompileError(`${ref} should have been filled in before compiling`);
    const info = fields.get(ref.slice('record.'.length));
    if (!info) throw new CompileError(`No field ${ref}`);
    return { kind: 'column', info, sql: `${alias}.${ident(info.column)}` };
  };
  const term = (operand: Operand): Term => {
    // Today and now are filled in as a request is checked; one that reaches here takes the clock's.
    if (isRelativeTime(operand)) return { kind: 'literal', value: relativeValue(operand, new Date()) };
    if (!isRef(operand)) return { kind: 'literal', value: operand };
    return column(operand.ref);
  };
  const isDateKind = (kind: ValueKind) => kind === 'date' || kind === 'datetime';

  /** A parameter equal to `value` as a stored value of the column, or null if no stored value can equal it. */
  const equalTo = (info: FieldInfo, value: string | number | boolean | null): string | null => {
    const type = jsTypeOf(info.kind);
    if (value === null || type === 'array' || typeof value !== type) return null;
    if (info.kind === 'uuid' && !isCanonicalUuid(value)) return null;
    // A date equals only a date, and a time a time: other text would not even cast.
    if (info.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
    if (info.kind === 'datetime' && (timeOf(value) === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(value)))) return null;
    if (typeof value === 'string' && value.includes('\u0000')) return null;
    return sql.param(value, sqlType(info.kind));
  };

  /** Two columns' values as comparable SQL, or null if their values can never be equal. */
  const comparable = (a: Extract<Term, { kind: 'column' }>, b: Extract<Term, { kind: 'column' }>): [string, string] | null => {
    const ta = jsTypeOf(a.info.kind);
    if (ta === 'array' || ta !== jsTypeOf(b.info.kind)) return null;
    // Text and UUID columns both hold strings: compare them as text.
    return ta === 'string' && a.info.kind !== b.info.kind ? [`${a.sql}::text`, `${b.sql}::text`] : [a.sql, b.sql];
  };

  const constant = (c: Condition): string => (evaluateCondition(c, {}) ? 'TRUE' : 'FALSE');

  const visit = (c: Condition): string => {
    if ('all' in c) return `(${c.all.map(visit).join(' AND ')})`;
    if ('any' in c) return `(${c.any.map(visit).join(' OR ')})`;
    if ('not' in c) return `(NOT ${visit(c.not)})`;
    // Any field can be tested for a value, dates included.
    if ('exists' in c) return `(${column(c.exists).sql} IS NOT NULL)`;
    if ('in' in c) return compileIn(c.in[0], c.in[1]);
    const op = (['eq', 'ne', ...COMPARISON_OPERATORS] as const).find((key) => key in c)!;
    const [left, right] = (c as Record<string, readonly [Operand, Operand]>)[op]!;
    const a = term(left);
    const b = term(right);
    if (a.kind === 'literal' && b.kind === 'literal') return constant(c);

    if (op === 'eq' || op === 'ne') {
      if (a.kind === 'column' && b.kind === 'column') {
        const pair = comparable(a, b);
        if (pair) return `((${pair[0]} ${op === 'eq' ? '=' : '<>'} ${pair[1]}) IS TRUE)`;
        // Present values of different types are never equal, so `ne` holds when both are present.
        const scalars = jsTypeOf(a.info.kind) !== 'array' && jsTypeOf(b.info.kind) !== 'array';
        return op === 'eq' || !scalars ? 'FALSE' : `(${a.sql} IS NOT NULL AND ${b.sql} IS NOT NULL)`;
      }
      const column = (a.kind === 'column' ? a : b) as Extract<Term, { kind: 'column' }>;
      const value = (a.kind === 'literal' ? a : b) as Extract<Term, { kind: 'literal' }>;
      const parameter = equalTo(column.info, value.value);
      if (op === 'eq') return parameter ? `((${column.sql} = ${parameter}) IS TRUE)` : 'FALSE';
      if (jsTypeOf(column.info.kind) === 'array') return 'FALSE';
      return parameter ? `((${column.sql} <> ${parameter}) IS TRUE)` : `(${column.sql} IS NOT NULL)`;
    }

    // Numbers compare, and so do dates and times. Decide that before creating any parameter, so none goes unused.
    const isNumber = (t: Term) => (t.kind === 'column' ? t.info.kind === 'number' : typeof t.value === 'number');
    const isTime = (t: Term) => (t.kind === 'column' ? isDateKind(t.info.kind) : timeOf(t.value) !== undefined);
    if (isTime(a) && isTime(b)) {
      // A date is the start of its day in UTC, as evaluateCondition takes it.
      const moment = (t: Term) =>
        t.kind === 'column' ? (t.info.kind === 'date' ? `(${t.sql}::timestamp AT TIME ZONE 'UTC')` : t.sql) : sql.param(new Date(timeOf(t.value)!).toISOString(), 'timestamptz');
      return `((${moment(a)} ${SQL_COMPARISON[op]} ${moment(b)}) IS TRUE)`;
    }
    if (!isNumber(a) || !isNumber(b)) return 'FALSE';
    const side = (t: Term) => (t.kind === 'column' ? t.sql : sql.param(t.value, 'numeric'));
    return `((${side(a)} ${SQL_COMPARISON[op]} ${side(b)}) IS TRUE)`;
  };

  const compileIn = (needleOperand: Operand, haystackOperand: Operand | readonly Operand[]): string => {
    const needle = term(needleOperand);
    if (!Array.isArray(haystackOperand)) {
      const haystack = term(haystackOperand as Operand);
      // Only a list can contain anything, and the only lists records hold are multiple choices.
      if (haystack.kind === 'literal' || haystack.info.kind !== 'text[]') return 'FALSE';
      if (needle.kind === 'literal') {
        const value = needle.value;
        if (typeof value !== 'string' || value.includes('\u0000')) return 'FALSE';
        return `((${sql.param(value, 'text')} = ANY(${haystack.sql})) IS TRUE)`;
      }
      return jsTypeOf(needle.info.kind) === 'string' ? `((${needle.sql}::text = ANY(${haystack.sql})) IS TRUE)` : 'FALSE';
    }

    const items = (haystackOperand as readonly Operand[]).map(term);
    const clauses: string[] = [];
    if (needle.kind === 'literal') {
      if (items.some((item) => item.kind === 'literal' && item.value === needle.value)) return 'TRUE';
      for (const item of items) {
        if (item.kind !== 'column') continue;
        const parameter = equalTo(item.info, needle.value);
        if (parameter) clauses.push(`((${item.sql} = ${parameter}) IS TRUE)`);
      }
    } else {
      if (jsTypeOf(needle.info.kind) === 'array') return 'FALSE';
      const literals = items.flatMap((item) => {
        if (item.kind !== 'literal') return [];
        const type = jsTypeOf(needle.info.kind);
        const value = item.value;
        if (value === null || typeof value !== type) return [];
        if (needle.info.kind === 'uuid' && !isCanonicalUuid(value)) return [];
        if (typeof value === 'string' && value.includes('\u0000')) return [];
        return [value];
      });
      if (literals.length) clauses.push(`((${needle.sql} = ANY(${sql.param(literals, `${sqlType(needle.info.kind)}[]`)})) IS TRUE)`);
      for (const item of items) {
        if (item.kind !== 'column') continue;
        const pair = comparable(needle, item);
        if (pair) clauses.push(`((${pair[0]} = ${pair[1]}) IS TRUE)`);
      }
    }
    return clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE';
  };

  return visit(condition);
}

/** The SQL that reads a column as its canonical JSON value (see ValueKind). */
export function selectExpression(info: FieldInfo, alias = 'r'): string {
  const column = `${alias}.${ident(info.column)}`;
  switch (info.kind) {
    case 'date':
      return `to_char(${column}, 'YYYY-MM-DD')`;
    case 'datetime':
      return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case 'number':
      // numeric arrives as text, so precision is never lost on the way; see fromDatabase.
      return `${column}::text`;
    default:
      return column;
  }
}

/** Convert what selectExpression produced back to a canonical value. */
export function fromDatabase(info: FieldInfo, raw: unknown): FieldValue {
  if (raw === null || raw === undefined) return null;
  if (info.kind === 'number') return Number(raw);
  if (info.kind === 'text[]') return Array.isArray(raw) && raw.length ? (raw as string[]) : null;
  return raw as FieldValue;
}

/** A canonical value as a parameter, with the column's type. */
export function toDatabase(sql: SqlBuilder, info: FieldInfo, value: FieldValue): string {
  return sql.param(value, sqlType(info.kind));
}

export interface SortKey {
  readonly info: FieldInfo;
  readonly direction: 'asc' | 'desc';
}

/**
 * Keyset pagination: the condition for rows strictly after `after` in the order of `keys`, which
 * must end with the record ID so the order is total. Empty values sort last in both directions.
 */
export function afterCursor(keys: readonly SortKey[], after: readonly FieldValue[], sql: SqlBuilder, alias = 'r'): string {
  if (after.length !== keys.length) throw new CompileError('The cursor does not match the sort order');
  const column = (key: SortKey) => `${alias}.${ident(key.info.column)}`;
  const equal = (key: SortKey, value: FieldValue) => (value === null ? `${column(key)} IS NULL` : `${column(key)} = ${toDatabase(sql, key.info, value)}`);
  const beyond = (key: SortKey, value: FieldValue) =>
    value === null
      ? 'FALSE'
      : `(${column(key)} ${key.direction === 'asc' ? '>' : '<'} ${toDatabase(sql, key.info, value)} OR ${column(key)} IS NULL)`;
  const branches = keys.map((key, index) => {
    const prefix = keys.slice(0, index).map((k, i) => equal(k, after[i]!));
    return `(${[...prefix, beyond(key, after[index]!)].join(' AND ')})`;
  });
  return `(${branches.join(' OR ')})`;
}

export function orderBy(keys: readonly SortKey[], alias = 'r'): string {
  return keys.map((key) => `${alias}.${ident(key.info.column)} ${key.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`).join(', ');
}
