/**
 * A small, serializable condition language for conditional grants and guardrails.
 *
 * Conditions are plain JSON, so they can be stored, diffed, reviewed and later compiled to SQL
 * filters for record-level security. A friendlier text syntax (a CEL subset) can compile to this
 * same structure.
 *
 * Semantics are deliberately strict: a reference to a missing value never equals anything, never
 * compares, and is never `in` a list. Only `not` and `exists` can turn a missing value into `true`.
 */
export type Operand = string | number | boolean | null | { readonly ref: string };

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

const MISSING: unique symbol = Symbol('missing');
type Value = unknown | typeof MISSING;

const COMPARATORS = ['lt', 'lte', 'gt', 'gte'] as const;
const BINARY = ['eq', 'ne', ...COMPARATORS] as const;
const MAX_DEPTH = 32;

function isRef(operand: Operand): operand is { readonly ref: string } {
  return typeof operand === 'object' && operand !== null;
}

function resolve(env: ConditionEnv, path: string): Value {
  let current: unknown = env;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return MISSING;
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined ? MISSING : current;
}

function valueOf(operand: Operand, env: ConditionEnv): Value {
  return isRef(operand) ? resolve(env, operand.ref) : operand;
}

function isScalar(value: Value): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Evaluate a condition against an environment. */
export function evaluateCondition(condition: Condition, env: ConditionEnv): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, env));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, env));
  if ('not' in condition) return !evaluateCondition(condition.not, env);
  if ('exists' in condition) return resolve(env, condition.exists) !== MISSING;
  if ('in' in condition) {
    const needle = valueOf(condition.in[0], env);
    const haystackOperand = condition.in[1];
    const haystack: Value = Array.isArray(haystackOperand)
      ? haystackOperand.map((operand: Operand) => valueOf(operand, env))
      : valueOf(haystackOperand as Operand, env);
    if (needle === MISSING || !isScalar(needle) || !Array.isArray(haystack)) return false;
    return haystack.some((item) => item !== MISSING && item === needle);
  }
  if ('eq' in condition || 'ne' in condition) {
    const [left, right] = 'eq' in condition ? condition.eq : condition.ne;
    const a = valueOf(left, env);
    const b = valueOf(right, env);
    if (a === MISSING || b === MISSING || !isScalar(a) || !isScalar(b)) return false;
    return 'eq' in condition ? a === b : a !== b;
  }
  for (const op of COMPARATORS) {
    if (op in condition) {
      const [left, right] = (condition as Record<string, readonly [Operand, Operand]>)[op]!;
      const a = valueOf(left, env);
      const b = valueOf(right, env);
      if (typeof a !== 'number' || typeof b !== 'number') return false;
      switch (op) {
        case 'lt':
          return a < b;
        case 'lte':
          return a <= b;
        case 'gt':
          return a > b;
        case 'gte':
          return a >= b;
      }
    }
  }
  return false;
}

function isOperand(value: unknown): value is Operand {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  return (
    typeof value === 'object' &&
    Object.keys(value as object).length === 1 &&
    typeof (value as { ref?: unknown }).ref === 'string' &&
    (value as { ref: string }).ref.length > 0
  );
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
