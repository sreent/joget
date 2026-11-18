import type { Condition } from '@platform/authz';
import { type Expression, type ExpressionOperator, evaluateExpression, expressionRefs, operandsOf, operatorOf } from './expressions.js';
import { entityFields, type FieldInfo, formulaOf, type StoredEntity, type StoredField, type ValueKind } from './fields.js';
import { compileCondition, ident, SqlBuilder } from './sql.js';
import { canonicalValue, type FieldValue, fitValue, type RecordValues, type ValueIssue } from './values.js';

/*
 * Formulas (design §6.1): a field the platform works out from the record's own fields each time the
 * record is written, and stores. A line's formulas come first, then the record's totals of its
 * lines, then the record's formulas, each after those it reads. When a formula is new or changes,
 * a migration works it out again for the records there are, in SQL that gives the same values.
 * That is why a formula takes only the operations below: each has SQL that gives what it gives.
 */

/** The operations a formula may use. */
export const FORMULA_OPERATORS: readonly ExpressionOperator[] = ['add', 'sub', 'mul', 'div', 'round', 'concat', 'if', 'coalesce', 'add_days', 'days_between'];

/** A moment no formula reads: formulas take no today or now, which would go stale once stored. */
const NO_TIME = new Date(0);

/** The fields of an entity that have a formula, each after the formulas it reads. Formulas in a loop are left in place: the checks refuse them. */
export function formulaFields(entity: Pick<StoredEntity, 'fields'>): StoredField[] {
  const formulas = new Map(entity.fields.flatMap((field) => (formulaOf(field) ? [[field.name, field] as const] : [])));
  const ordered: StoredField[] = [];
  const seen = new Set<string>();
  const visit = (field: StoredField) => {
    if (seen.has(field.name)) return;
    seen.add(field.name);
    for (const ref of expressionRefs(formulaOf(field)!)) {
      const [root, name] = ref.split('.');
      const read = root === 'record' && name ? formulas.get(name) : undefined;
      if (read) visit(read);
    }
    ordered.push(field);
  };
  for (const field of formulas.values()) visit(field);
  return ordered;
}

/**
 * A record, or a line, with its formulas worked out from its other values. A formula that can't be
 * worked out, such as one that divides by zero, gives nothing. A value its field can't hold is an
 * issue, as an entered value would be.
 */
export function withFormulas(
  entity: StoredEntity,
  values: RecordValues,
  options: { readonly line?: boolean } = {},
): { readonly values: Record<string, FieldValue>; readonly issues: ValueIssue[] } {
  const out: Record<string, FieldValue> = { ...values };
  const ordered = formulaFields(entity);
  if (!ordered.length) return { values: out, issues: [] };
  const fields = entityFields(entity, { line: options.line ?? false });
  const issues: ValueIssue[] = [];
  for (const field of ordered) {
    const info = fields.get(field.name)!;
    const worked = evaluateExpression(formulaOf(field)!, { record: out, principal: {}, now: NO_TIME });
    // Numbers are worked out in binary: ten decimal places take away its noise, as SQL's exact numbers have none.
    const raw = !worked.ok ? null : typeof worked.value === 'number' ? Number(worked.value.toFixed(10)) : worked.value;
    const result = canonicalValue(info, fitValue(info, raw));
    if (result.ok) out[field.name] = result.value;
    else {
      out[field.name] = null;
      issues.push({ field: field.name, code: result.issue.code, message: `${field.label}: ${result.issue.message}` });
    }
  }
  return { values: out, issues };
}

/** A SQL builder that writes each value into the statement itself: migrations are statements without parameters. */
class InlineSql extends SqlBuilder {
  override param(value: unknown, cast?: string): string {
    const quote = (text: string) => {
      if (text.includes('\u0000')) throw new Error('A formula holds a character SQL text can not');
      return `'${text.replaceAll("'", "''")}'`;
    };
    const literal =
      value === null || value === undefined
        ? 'null'
        : typeof value === 'number'
          ? Number.isFinite(value)
            ? String(value)
            : 'null'
          : typeof value === 'boolean'
            ? String(value)
            : Array.isArray(value)
              ? `array[${value.map((each) => quote(String(each))).join(', ')}]::text[]`
              : quote(String(value));
    return cast ? `(${literal})::${cast}` : literal;
  }
}

type Part = { readonly sql: string; readonly kind: ValueKind | 'null' };

/** A value as the text that concat gives it: a number without trailing zeros, a time as ISO 8601 in UTC. */
function textOf(part: Part): string {
  switch (part.kind) {
    case 'number':
      return `trim_scale(${part.sql})::text`;
    case 'date':
      // Not ::text, which follows the session's date style.
      return `to_char(${part.sql}, 'YYYY-MM-DD')`;
    case 'datetime':
      return `to_char(${part.sql} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case 'text[]':
    case 'uuid[]':
      return `array_to_string(${part.sql}, ', ')`;
    case 'text':
    case 'null':
      return part.sql;
    default:
      return `${part.sql}::text`;
  }
}

/** A date or a time as seconds since 1970, in UTC whatever the session's time zone. */
function epochOf(part: Part): string {
  return part.kind === 'date' ? `extract(epoch from ((${part.sql})::timestamp at time zone 'UTC'))` : `extract(epoch from ${part.sql})`;
}

/** A formula as SQL over a row of its entity's table, giving what withFormulas gives. */
export function formulaSql(expression: Expression, fields: ReadonlyMap<string, FieldInfo>, alias: string): Part {
  const sql = new InlineSql();
  const go = (e: Expression): Part => {
    if (e === null) return { sql: 'null', kind: 'null' };
    if (typeof e === 'number') return { sql: sql.param(e, 'numeric'), kind: 'number' };
    if (typeof e === 'string') return { sql: sql.param(e, 'text'), kind: 'text' };
    if (typeof e === 'boolean') return { sql: sql.param(e, 'boolean'), kind: 'boolean' };
    if (Array.isArray(e)) return { sql: sql.param(e), kind: 'text[]' };
    if ('ref' in e) {
      const info = fields.get(e.ref.slice('record.'.length));
      if (!info) throw new Error(`No field ${e.ref}`);
      return { sql: `${alias}.${ident(info.column)}`, kind: info.kind };
    }
    const op = operatorOf(e);
    if (!op || !FORMULA_OPERATORS.includes(op)) throw new Error(`A formula can't use ${op ?? 'this'}`);
    const parts = operandsOf(e).map(go);
    const [a, b] = parts as [Part, Part];
    switch (op) {
      case 'add':
      case 'mul':
        return { sql: `(${parts.map((part) => part.sql).join(op === 'add' ? ' + ' : ' * ')})`, kind: 'number' };
      case 'sub':
        return { sql: `(${a.sql} - ${b.sql})`, kind: 'number' };
      case 'div':
        // Dividing by zero gives nothing, as the formula does.
        return { sql: `(${a.sql} / nullif(${b.sql}, 0))`, kind: 'number' };
      case 'round':
        return { sql: `round((${a.sql})::numeric, ${(e as { round: readonly [Expression, number] }).round[1]})`, kind: 'number' };
      case 'concat':
        return { sql: `concat(${parts.map(textOf).join(', ')})`, kind: 'text' };
      case 'coalesce': {
        const kind = parts.find((part) => part.kind !== 'null')?.kind ?? 'null';
        const filled = (part: Part) =>
          part.kind === 'text'
            ? `nullif(${part.sql}, '')`
            : part.kind === 'text[]' || part.kind === 'uuid[]'
              ? `nullif(${part.sql}, '{}'::${part.kind})`
              : part.sql;
        return { sql: `coalesce(${parts.map(filled).join(', ')})`, kind };
      }
      case 'if': {
        const when = (e as { if: readonly [Condition, Expression, Expression] }).if[0];
        return { sql: `(case when ${compileCondition(when, fields, sql, alias)} then ${a.sql} else ${b.sql} end)`, kind: a.kind !== 'null' ? a.kind : b.kind };
      }
      case 'add_days':
        if (a.kind === 'null') return { sql: 'null', kind: 'null' };
        // A date moves by whole days, rounded half up as JavaScript rounds; a time by the exact
        // amount, in UTC so that a change of clocks doesn't count, and to the millisecond.
        if (a.kind === 'datetime')
          return {
            sql: `(date_trunc('milliseconds', (${a.sql}) at time zone 'UTC' + (${b.sql})::numeric * interval '1 day') at time zone 'UTC')`,
            kind: 'datetime',
          };
        return { sql: `(${a.sql} + floor((${b.sql})::numeric + 0.5)::int)`, kind: 'date' };
      case 'days_between':
        if (a.kind === 'null' || b.kind === 'null') return { sql: 'null::numeric', kind: 'number' };
        if (a.kind === 'date' && b.kind === 'date') return { sql: `(${b.sql} - ${a.sql})`, kind: 'number' };
        // Whole days, cut towards zero, between two moments: a date is the start of its day in UTC.
        return { sql: `trunc((${epochOf(b)} - ${epochOf(a)}) / 86400)`, kind: 'number' };
      default:
        throw new Error(`A formula can't use ${op}`);
    }
  };
  return go(expression);
}

/**
 * The statements that work out an entity's formulas again for every record, or every line, in the
 * order withFormulas works them out. A value its field can't hold is left empty.
 */
export function formulaUpdates(entity: StoredEntity, table: string, options: { readonly line?: boolean } = {}): string[] {
  const fields = entityFields(entity, { line: options.line ?? false });
  return formulaFields(entity).map((field) => {
    const info = fields.get(field.name)!;
    const part = formulaSql(formulaOf(field)!, fields, 'r');
    let value = part.sql;
    if (field.type === 'number') {
      value = `round((${value})::numeric, ${field.decimals})`;
      const bounds = [field.min !== undefined ? `v < ${field.min}` : null, field.max !== undefined ? `v > ${field.max}` : null].filter(Boolean);
      if (bounds.length) value = `(select case when ${bounds.join(' or ')} then null else v end from (select ${value} as v) as worked)`;
    } else if (field.type === 'date') value = part.kind === 'datetime' ? `((${value}) at time zone 'UTC')::date` : `(${value})::date`;
    else if (field.type === 'text')
      value = `(select case when char_length(v) > ${field.maxLength} then null else v end from (select (${part.kind === 'text' ? value : textOf(part)}) as v) as worked)`;
    return `update ${table} as r set ${ident(info.column)} = ${value}`;
  });
}
