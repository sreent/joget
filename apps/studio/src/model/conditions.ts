import type { Definition, Field } from '../types.js';

/**
 * Conditions as builders edit them: a list of clauses that must all hold, or any one, each a field,
 * an operator and a value. The definition stores conditions as JSON trees; this converts both ways.
 * A condition with a shape the builder can't show stays as JSON (toModel returns null).
 */

export type Condition = Definition['rules'][string]['assert'];
type Comparison = Extract<Condition, { eq: unknown }>;
export type Operand = Comparison['eq'][number];
/** A value in a condition: one value, or a list of them for "is one of". */
export type Literal = string | number | boolean | null | readonly string[];

export type Op = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notIn' | 'contains' | 'exists' | 'missing';
export const COMPARE = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;

/**
 * The other side of a clause: a value; a reference such as `principal.id` or `input.status`; or
 * today or now, so many days or hours away.
 */
export type Side =
  | { readonly kind: 'value'; readonly value: Literal }
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'relative'; readonly unit: 'today' | 'now'; readonly amount: number };

export interface Clause {
  readonly ref: string;
  readonly op: Op;
  /** None for `exists` and `missing`; a list of values for `in` and `notIn`. */
  readonly right?: Side;
}

export interface Group {
  readonly match: 'all' | 'any';
  readonly items: ReadonlyArray<Clause | Group>;
}

export const isGroup = (item: Clause | Group): item is Group => 'match' in item;
const isRef = (operand: unknown): operand is { ref: string } => typeof operand === 'object' && operand !== null && !Array.isArray(operand) && typeof (operand as { ref?: unknown }).ref === 'string';
const relativeOf = (operand: unknown): Extract<Side, { kind: 'relative' }> | null => {
  if (typeof operand !== 'object' || operand === null || Array.isArray(operand)) return null;
  const object = operand as Record<string, unknown>;
  if (typeof object['today'] === 'number') return { kind: 'relative', unit: 'today', amount: object['today'] };
  if (typeof object['now'] === 'number') return { kind: 'relative', unit: 'now', amount: object['now'] };
  return null;
};
const isLiteral = (operand: unknown): operand is Literal =>
  operand === null || ['string', 'number', 'boolean'].includes(typeof operand) || (Array.isArray(operand) && operand.every((item) => typeof item === 'string'));

function clauseOf(condition: Condition): Clause | null {
  if ('exists' in condition) return { ref: condition.exists, op: 'exists' };
  if ('not' in condition) {
    const inner = condition.not;
    if ('exists' in inner) return { ref: inner.exists, op: 'missing' };
    const clause = 'in' in inner ? clauseOf(inner) : null;
    return clause?.op === 'in' ? { ...clause, op: 'notIn' } : null;
  }
  if ('in' in condition) {
    const [needle, haystack]: readonly [unknown, unknown] = condition.in;
    if (isRef(needle) && Array.isArray(haystack) && isLiteral(haystack)) return { ref: needle.ref, op: 'in', right: { kind: 'value', value: haystack } };
    if (isLiteral(needle) && isRef(haystack)) return { ref: haystack.ref, op: 'contains', right: { kind: 'value', value: needle } };
    return null;
  }
  for (const op of COMPARE) {
    if (!(op in condition)) continue;
    const [left, right] = (condition as Record<string, readonly [unknown, unknown]>)[op]!;
    if (!isRef(left)) return null;
    if (isRef(right)) return { ref: left.ref, op, right: { kind: 'ref', ref: right.ref } };
    const relative = relativeOf(right);
    if (relative) return { ref: left.ref, op, right: relative };
    return isLiteral(right) ? { ref: left.ref, op, right: { kind: 'value', value: right } } : null;
  }
  return null;
}

/** A condition as a group the builder can show, or null if it has a shape the builder can't. Groups nest one level. */
export function toModel(condition: Condition | undefined, depth = 0): Group | null {
  if (!condition) return { match: 'all', items: [] };
  if ('all' in condition || 'any' in condition) {
    const parts = 'all' in condition ? condition.all : condition.any;
    const items = parts.map((part) => ('all' in part || 'any' in part ? (depth < 1 ? toModel(part, depth + 1) : null) : clauseOf(part)));
    if (items.some((item) => item === null)) return null;
    return { match: 'all' in condition ? 'all' : 'any', items: items as Array<Clause | Group> };
  }
  const clause = clauseOf(condition);
  return clause ? { match: 'all', items: [clause] } : null;
}

function clauseJson(clause: Clause): Condition {
  const ref = { ref: clause.ref };
  const right: unknown =
    clause.right?.kind === 'ref' ? { ref: clause.right.ref } : clause.right?.kind === 'relative' ? { [clause.right.unit]: clause.right.amount } : (clause.right?.value ?? null);
  const list: readonly unknown[] = Array.isArray(right) ? right : right === null ? [] : [right];
  switch (clause.op) {
    case 'exists':
      return { exists: clause.ref };
    case 'missing':
      return { not: { exists: clause.ref } };
    case 'in':
      return { in: [ref, list] } as Condition;
    case 'notIn':
      return { not: { in: [ref, list] } } as Condition;
    case 'contains':
      return { in: [right, ref] } as Condition;
    default:
      return { [clause.op]: [ref, right] } as unknown as Condition;
  }
}

/** A group as a condition, or undefined if it has nothing in it. A group of one is just that one. */
export function fromModel(group: Group): Condition | undefined {
  const items = group.items.flatMap((item) => {
    const condition = isGroup(item) ? fromModel(item) : clauseJson(item);
    return condition ? [condition] : [];
  });
  if (!items.length) return undefined;
  if (items.length === 1) return items[0];
  return (group.match === 'all' ? { all: items } : { any: items }) as Condition;
}

/** What a reference holds, so the builder offers the right operators and inputs. */
export type Kind = 'text' | 'number' | 'boolean' | 'choice' | 'multi' | 'person' | 'id' | 'ids' | 'date';

export interface RefChoice {
  readonly ref: string;
  readonly label: string;
  readonly kind: Kind;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

function kindOf(field: Field): Kind | null {
  switch (field.type) {
    case 'text':
    case 'email':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'choice':
      return field.multiple ? 'multi' : 'choice';
    case 'user':
      return 'person';
    case 'reference':
      return field.multiple ? 'ids' : 'id';
    case 'file':
      return 'id';
    case 'date':
    case 'datetime':
      return 'date';
    case 'lines':
      return null;
  }
}

const SYSTEM: ReadonlyArray<RefChoice> = [
  { ref: 'record.owner', label: 'Owner', kind: 'person' },
  { ref: 'record.created_by', label: 'Created by', kind: 'person' },
  { ref: 'record.updated_by', label: 'Last changed by', kind: 'person' },
  { ref: 'record.created_at', label: 'Created', kind: 'date' },
  { ref: 'record.updated_at', label: 'Last changed', kind: 'date' },
];

/** The fields a condition on an entity's records can test. Lines have only their own fields. */
export function recordChoices(definition: Definition, entity: string, line = false): RefChoice[] {
  const fields = definition.entities[entity]?.fields ?? [];
  const own = fields.flatMap((field): RefChoice[] => {
    const kind = kindOf(field);
    if (!kind) return [];
    return [{ ref: `record.${field.name}`, label: field.label, kind, ...(field.type === 'choice' ? { options: field.options } : {}) }];
  });
  return line ? own : [...own, ...SYSTEM];
}

/** The operators that suit a kind. Dates and times compare: before, after, or on. */
export function opsFor(kind: Kind): Op[] {
  switch (kind) {
    case 'number':
      return ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'missing'];
    case 'text':
    case 'choice':
      return ['eq', 'ne', 'in', 'notIn', 'exists', 'missing'];
    case 'multi':
      return ['contains', 'exists', 'missing'];
    // A list of records: whether it holds any.
    case 'ids':
      return ['exists', 'missing'];
    case 'boolean':
    case 'person':
    case 'id':
      return ['eq', 'ne', 'exists', 'missing'];
    case 'date':
      return ['lt', 'lte', 'gt', 'gte', 'eq', 'ne', 'exists', 'missing'];
  }
}

/** How a builder reads an operator: dates and times are before or after, other values less or more. */
export function opLabel(op: Op, kind: Kind | 'other'): string {
  if (kind !== 'date') return OP_LABELS[op];
  return { eq: 'is on', ne: 'is not on', lt: 'is before', lte: 'is on or before', gt: 'is after', gte: 'is on or after' }[op as 'eq'] ?? OP_LABELS[op];
}

/** Today or now, so many days or hours away, in words: "today", "3 days from today", "2 hours ago". */
export function relativeWords(side: { readonly unit: 'today' | 'now'; readonly amount: number }): string {
  const unit = side.unit === 'today' ? 'day' : 'hour';
  if (side.amount === 0) return side.unit;
  const amount = Math.abs(side.amount);
  const units = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return side.amount < 0 ? `${units} ago` : `${units} from ${side.unit}`;
}

export const OP_LABELS: Record<Op, string> = {
  eq: 'is',
  ne: 'is not',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is more than',
  gte: 'is at least',
  in: 'is one of',
  notIn: 'is none of',
  contains: 'includes',
  exists: 'has a value',
  missing: 'is empty',
};

/** A new clause on a reference: the first operator that suits it, with an empty value. */
export function newClause(choice: RefChoice, clock = true): Clause {
  const op = opsFor(choice.kind)[0]!;
  // A date starts out compared with today, or, where the clock can't be read, with a date.
  if (choice.kind === 'date') return { ref: choice.ref, op, right: clock ? { kind: 'relative', unit: 'today', amount: 0 } : { kind: 'value', value: new Date().toISOString().slice(0, 10) } };
  return { ref: choice.ref, op, ...(op === 'exists' ? {} : { right: { kind: 'value', value: defaultValue(choice, op) } }) };
}

export function defaultValue(choice: RefChoice, op: Op): Literal {
  if (op === 'in' || op === 'notIn') return [];
  switch (choice.kind) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'choice':
    case 'multi':
      return choice.options?.[0]?.value ?? '';
    default:
      return '';
  }
}
