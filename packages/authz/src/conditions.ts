/**
 * A small, serializable condition language for conditional grants and guardrails.
 *
 * Conditions are plain JSON, so they can be stored, diffed, reviewed and compiled to SQL filters
 * for record-level security. A friendlier text syntax (a CEL subset) can compile to this same
 * structure.
 *
 * Semantics are deliberately strict: a reference to a missing value never equals anything, never
 * compares, and is never `in` a list. Only `not` and `exists` can turn a missing value into `true`.
 * Non-finite numbers (NaN, Infinity) count as missing values.
 *
 * Numbers compare, and so do dates and times: ISO 8601 text, such as `2026-11-18` or
 * `2026-11-18T09:30:00Z`, where a date is the start of its day in UTC. `{ today: n }` is the date
 * `n` days from today, and `{ now: n }` the time `n` hours from now, in UTC; `n` may be negative.
 */
export type Operand = string | number | boolean | null | { readonly ref: string } | RelativeTime;

/** A date or a time worked out from the clock when the condition is evaluated. */
export type RelativeTime = { readonly today: number } | { readonly now: number };

/**
 * Where an environment may carry the time to evaluate against, as a Date or ISO text. Without it,
 * the clock's time. It can't clash with a reference, which starts with a letter.
 */
export const CLOCK = '$now';

export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly eq: readonly [Operand, Operand] }
  | { readonly ne: readonly [Operand, Operand] }
  | { readonly in: readonly [Operand, Operand | readonly Operand[]] }
  | { readonly lt: readonly [Operand, Operand] }
  | { readonly lte: readonly [Operand, Operand] }
  | { readonly gt: readonly [Operand, Operand] }
  | { readonly gte: readonly [Operand, Operand] }
  | { readonly exists: string };

/** The values a condition can refer to, for example `{ principal, resource, context }`. */
export type ConditionEnv = Readonly<Record<string, unknown>>;

/** What is left of a condition once the known values are filled in: a constant, or a condition on the rest. */
export type Residual = boolean | Condition;

const MISSING: unique symbol = Symbol('missing');
type Value = unknown | typeof MISSING;

export const COMPARISON_OPERATORS = ['lt', 'lte', 'gt', 'gte'] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];
const BINARY = ['eq', 'ne', ...COMPARISON_OPERATORS] as const;
type BinaryOperator = (typeof BINARY)[number];
const MAX_DEPTH = 32;

export function isRef(operand: Operand): operand is { readonly ref: string } {
  return typeof operand === 'object' && operand !== null && 'ref' in operand;
}

/** True for a date or a time relative to the clock. */
export function isRelativeTime(operand: Operand): operand is RelativeTime {
  return typeof operand === 'object' && operand !== null && ('today' in operand || 'now' in operand);
}

/** The time an environment carries, or the clock's. */
function clockOf(env: ConditionEnv): Date {
  const given = env[CLOCK];
  if (given instanceof Date) return given;
  if (typeof given === 'string' && !Number.isNaN(Date.parse(given))) return new Date(given);
  return new Date();
}

/** A relative date or time as the ISO text that a field holds: a date for `today`, a time for `now`. */
export function relativeValue(operand: RelativeTime, now: Date): string {
  if ('today' in operand) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + operand.today));
    return day.toISOString().slice(0, 10);
  }
  return new Date(now.getTime() + operand.now * 3_600_000).toISOString();
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The moment ISO text names, in milliseconds, or undefined if it names none: a date is the start of its day in UTC. */
export function timeOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (DATE.test(value)) return Date.parse(`${value}T00:00:00Z`);
  return DATE_TIME.test(value) ? Date.parse(value) : undefined;
}

function resolve(env: ConditionEnv, path: string): Value {
  let current: unknown = env;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return MISSING;
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined || (typeof current === 'number' && !Number.isFinite(current))) return MISSING;
  return current;
}

function valueOf(operand: Operand, env: ConditionEnv): Value {
  if (isRef(operand)) return resolve(env, operand.ref);
  return isRelativeTime(operand) ? relativeValue(operand, clockOf(env)) : operand;
}

function isScalar(value: Value): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** The binary operators, on resolved values. Shared by full and partial evaluation, so they cannot drift apart. */
function binary(op: BinaryOperator, a: Value, b: Value): boolean {
  if (op === 'eq' || op === 'ne') {
    if (a === MISSING || b === MISSING || !isScalar(a) || !isScalar(b)) return false;
    return op === 'eq' ? a === b : a !== b;
  }
  // Numbers compare; so do dates and times, by the moments they name.
  const [x, y] = typeof a === 'number' && typeof b === 'number' ? [a, b] : [timeOf(a), timeOf(b)];
  if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) return false;
  switch (op) {
    case 'lt':
      return x < y;
    case 'lte':
      return x <= y;
    case 'gt':
      return x > y;
    case 'gte':
      return x >= y;
  }
}

/** `in`, on resolved values: the needle must be a present scalar, and the haystack a list. */
function member(needle: Value, haystack: Value): boolean {
  if (needle === MISSING || !isScalar(needle) || !Array.isArray(haystack)) return false;
  return haystack.some((item) => item !== MISSING && item === needle);
}

function binaryOperator(condition: Condition): BinaryOperator | undefined {
  return BINARY.find((op) => op in condition);
}

/** Evaluate a condition against an environment. */
export function evaluateCondition(condition: Condition, env: ConditionEnv): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, env));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, env));
  if ('not' in condition) return !evaluateCondition(condition.not, env);
  if ('exists' in condition) return resolve(env, condition.exists) !== MISSING;
  if ('in' in condition) {
    const [needle, haystack] = condition.in;
    const items: Value = Array.isArray(haystack)
      ? (haystack as readonly Operand[]).map((operand) => valueOf(operand, env))
      : valueOf(haystack as Operand, env);
    return member(valueOf(needle, env), items);
  }
  const op = binaryOperator(condition);
  if (!op) return false;
  const [left, right] = (condition as Record<BinaryOperator, readonly [Operand, Operand]>)[op];
  return binary(op, valueOf(left, env), valueOf(right, env));
}

/** True if a reference points into one of the pending roots, for example `record.status` for `record`. */
function isPendingRef(ref: string, pending: readonly string[]): boolean {
  return pending.some((root) => ref === root || ref.startsWith(`${root}.`));
}

/** An operand after substitution: still pending, or a known value (possibly missing). */
type Partial = { readonly pending: true; readonly operand: Operand } | { readonly pending: false; readonly value: Value };

function substitute(operand: Operand, env: ConditionEnv, pending: readonly string[]): Partial {
  if (isRef(operand) && isPendingRef(operand.ref, pending)) return { pending: true, operand };
  return { pending: false, value: valueOf(operand, env) };
}

/** A known value as a literal operand. Only called for present scalars. */
function literal(value: Value): Operand {
  return value as string | number | boolean | null;
}

function simplifyAll(parts: readonly Residual[]): Residual {
  if (parts.includes(false)) return false;
  const rest = parts.filter((part): part is Condition => part !== true);
  if (rest.length === 0) return true;
  return rest.length === 1 ? rest[0]! : { all: rest };
}

function simplifyAny(parts: readonly Residual[]): Residual {
  if (parts.includes(true)) return true;
  const rest = parts.filter((part): part is Condition => part !== false);
  if (rest.length === 0) return false;
  return rest.length === 1 ? rest[0]! : { any: rest };
}

/**
 * Evaluate what can be evaluated now, and leave the rest for later.
 *
 * References under the `pending` roots (for example `record`) stay in place; everything else is
 * looked up in `env` and replaced by its value, and every part that no longer depends on a pending
 * value is folded to a constant. The result is `true`, `false`, or a condition that refers only to
 * pending values. For every value of the pending roots, evaluating the residual gives the same
 * answer as evaluating the original condition with everything known.
 *
 * This is how record-level grants become database filters: the principal's attributes are filled
 * in, and what remains is a condition on the record, compiled to SQL.
 */
export function partialEvaluate(condition: Condition, env: ConditionEnv, pending: readonly string[]): Residual {
  if ('all' in condition) return simplifyAll(condition.all.map((c) => partialEvaluate(c, env, pending)));
  if ('any' in condition) return simplifyAny(condition.any.map((c) => partialEvaluate(c, env, pending)));
  if ('not' in condition) {
    const inner = partialEvaluate(condition.not, env, pending);
    return typeof inner === 'boolean' ? !inner : { not: inner };
  }
  if ('exists' in condition) {
    return isPendingRef(condition.exists, pending) ? condition : resolve(env, condition.exists) !== MISSING;
  }
  if ('in' in condition) return partialIn(condition.in, env, pending);

  const op = binaryOperator(condition);
  if (!op) return false;
  const [left, right] = (condition as Record<BinaryOperator, readonly [Operand, Operand]>)[op];
  const a = substitute(left, env, pending);
  const b = substitute(right, env, pending);
  if (!a.pending && !b.pending) return binary(op, a.value, b.value);
  // A known operand that can never take part in this comparison decides it, whatever the record holds.
  for (const side of [a, b]) {
    if (side.pending) continue;
    if (side.value === MISSING) return false;
    if (op === 'eq' || op === 'ne' ? !isScalar(side.value) : typeof side.value !== 'number' && timeOf(side.value) === undefined) return false;
  }
  const operand = (side: Partial): Operand => (side.pending ? side.operand : literal(side.value));
  return { [op]: [operand(a), operand(b)] } as unknown as Condition;
}

function partialIn(args: readonly [Operand, Operand | readonly Operand[]], env: ConditionEnv, pending: readonly string[]): Residual {
  const [needleOperand, haystackOperand] = args;
  const needle = substitute(needleOperand, env, pending);
  if (!needle.pending && (needle.value === MISSING || !isScalar(needle.value))) return false;

  if (!Array.isArray(haystackOperand)) {
    const haystack = substitute(haystackOperand as Operand, env, pending);
    if (haystack.pending) {
      return { in: [needle.pending ? needle.operand : literal(needle.value), haystack.operand] };
    }
    if (!needle.pending) return member(needle.value, haystack.value);
    // A pending needle and a known haystack: keep the items that could still match.
    if (!Array.isArray(haystack.value)) return false;
    const items = (haystack.value as unknown[]).filter((item) => isScalar(item) && !(typeof item === 'number' && !Number.isFinite(item)));
    return items.length === 0 ? false : { in: [needle.operand, items.map(literal)] };
  }

  const items = (haystackOperand as readonly Operand[]).map((operand) => substitute(operand, env, pending));
  const pendingItems = items.filter((item): item is Extract<Partial, { pending: true }> => item.pending).map((item) => item.operand);
  const knownItems = items
    .filter((item): item is Extract<Partial, { pending: false }> => !item.pending)
    .map((item) => item.value)
    .filter((value) => value !== MISSING && isScalar(value));
  if (!needle.pending) {
    if (knownItems.some((value) => value === needle.value)) return true;
    return pendingItems.length === 0 ? false : { in: [literal(needle.value), pendingItems] };
  }
  const list = [...knownItems.map(literal), ...pendingItems];
  return list.length === 0 ? false : { in: [needle.operand, list] };
}

/** Every reference a condition makes, in order of appearance, without duplicates. */
export function conditionRefs(condition: Condition): string[] {
  const refs = new Set<string>();
  const visit = (c: Condition): void => {
    if ('all' in c) return c.all.forEach(visit);
    if ('any' in c) return c.any.forEach(visit);
    if ('not' in c) return visit(c.not);
    if ('exists' in c) {
      refs.add(c.exists);
      return;
    }
    const operands: Operand[] = [];
    if ('in' in c) {
      operands.push(c.in[0]);
      if (Array.isArray(c.in[1])) operands.push(...(c.in[1] as readonly Operand[]));
      else operands.push(c.in[1] as Operand);
    } else {
      const op = binaryOperator(c);
      if (op) operands.push(...(c as Record<BinaryOperator, readonly [Operand, Operand]>)[op]);
    }
    for (const operand of operands) if (isRef(operand)) refs.add(operand.ref);
  };
  visit(condition);
  return [...refs];
}

function isOperand(value: unknown): value is Operand {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (typeof value !== 'object' || Object.keys(value as object).length !== 1) return false;
  const object = value as Record<string, unknown>;
  // Ten years either way, in days or in hours.
  if ('today' in object) return Number.isInteger(object['today']) && Math.abs(object['today'] as number) <= 3650;
  if ('now' in object) return Number.isInteger(object['now']) && Math.abs(object['now'] as number) <= 87_600;
  return typeof object['ref'] === 'string' && (object['ref'] as string).length > 0;
}

/** Validate untrusted JSON (for example, read from the database) as a condition. */
export function isCondition(value: unknown, depth = 0): value is Condition {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0]!;
  const arg = (value as Record<string, unknown>)[key];
  switch (key) {
    case 'all':
    case 'any':
      return Array.isArray(arg) && arg.length > 0 && arg.every((c) => isCondition(c, depth + 1));
    case 'not':
      return isCondition(arg, depth + 1);
    case 'exists':
      return typeof arg === 'string' && arg.length > 0;
    case 'in':
      return (
        Array.isArray(arg) &&
        arg.length === 2 &&
        isOperand(arg[0]) &&
        (isOperand(arg[1]) || (Array.isArray(arg[1]) && arg[1].every(isOperand)))
      );
    default:
      return (
        (BINARY as readonly string[]).includes(key) &&
        Array.isArray(arg) &&
        arg.length === 2 &&
        arg.every(isOperand)
      );
  }
}
