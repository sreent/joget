import { CLOCK, type Condition, conditionRefs, evaluateCondition, isCondition, timeOf } from '@platform/authz';
import { mapRefs } from './condition-refs.js';

/**
 * Values that steps work out (design §6.2). An expression is plain JSON, like a condition, so it
 * can be stored, compared and reviewed: a constant; a reference to a field of the record
 * (`record.total`) or to the person (`principal.id`); today's date or the time now, in UTC; or a
 * small calculation: arithmetic, dates and times moved by days or hours, the days between two
 * dates, a value chosen by a condition, and text made upper or lower case, trimmed, cut or
 * measured. There are no loops and no calls, so an expression always ends, and gives the same
 * value for the same record, person and time.
 */
export type Expression =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | { readonly ref: string }
  | { readonly today: true }
  | { readonly now: true }
  | { readonly add: readonly Expression[] }
  | { readonly sub: readonly [Expression, Expression] }
  | { readonly mul: readonly Expression[] }
  | { readonly div: readonly [Expression, Expression] }
  | { readonly round: readonly [Expression, number] }
  | { readonly concat: readonly Expression[] }
  /** A date or a time, so many days later (or earlier, when negative). */
  | { readonly add_days: readonly [Expression, Expression] }
  /** A time, so many hours later (or earlier). */
  | { readonly add_hours: readonly [Expression, Expression] }
  /** The whole days from the first date or time to the second. */
  | { readonly days_between: readonly [Expression, Expression] }
  /** The second value if the condition holds, else the third. */
  | { readonly if: readonly [Condition, Expression, Expression] }
  | { readonly upper: readonly [Expression] }
  | { readonly lower: readonly [Expression] }
  | { readonly trim: readonly [Expression] }
  /** How many characters a text has: 0 for an empty one. */
  | { readonly text_length: readonly [Expression] }
  /** The first so many characters of a text. */
  | { readonly left: readonly [Expression, Expression] }
  /** The first value that isn't empty. */
  | { readonly coalesce: readonly Expression[] };

/** A value an expression gives: what a field holds, in its canonical JSON form. */
export type ExpressionValue = string | number | boolean | readonly string[] | null;

export const EXPRESSION_OPERATORS = [
  'add',
  'sub',
  'mul',
  'div',
  'round',
  'concat',
  'add_days',
  'add_hours',
  'days_between',
  'if',
  'upper',
  'lower',
  'trim',
  'text_length',
  'left',
  'coalesce',
] as const;
export type ExpressionOperator = (typeof EXPRESSION_OPERATORS)[number];

const MAX_DEPTH = 8;
const MAX_OPERANDS = 10;
const MAX_LITERAL_LENGTH = 10_000;
/**
 * A reference: `record.<field>` or `principal.id` in an action's steps; in a flow also a variable,
 * as `claim`, `claim.total` or, for a value from a REST service, a longer path.
 */
const REF = /^[a-z][a-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62}){0,8}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** True if a value is a well-formed expression. It says nothing of whether its references exist. */
export function isExpression(value: unknown, depth = 0): value is Expression {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= MAX_LITERAL_LENGTH;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 200 && value.every((item) => typeof item === 'string' && item.length <= 100);
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0]!;
  const argument = value[key];
  const operands = (min: number, max: number) =>
    Array.isArray(argument) && argument.length >= min && argument.length <= max && argument.every((item) => isExpression(item, depth + 1));
  switch (key) {
    case 'ref':
      return typeof argument === 'string' && REF.test(argument);
    case 'today':
    case 'now':
      return argument === true;
    case 'add':
    case 'mul':
    case 'concat':
      return operands(2, MAX_OPERANDS);
    case 'coalesce':
      return operands(2, MAX_OPERANDS);
    case 'sub':
    case 'div':
    case 'add_days':
    case 'add_hours':
    case 'days_between':
    case 'left':
      return operands(2, 2);
    case 'upper':
    case 'lower':
    case 'trim':
    case 'text_length':
      return operands(1, 1);
    case 'if':
      return (
        Array.isArray(argument) &&
        argument.length === 3 &&
        isCondition(argument[0]) &&
        isExpression(argument[1], depth + 1) &&
        isExpression(argument[2], depth + 1)
      );
    case 'round':
      return (
        Array.isArray(argument) &&
        argument.length === 2 &&
        isExpression(argument[0], depth + 1) &&
        Number.isInteger(argument[1]) &&
        (argument[1] as number) >= 0 &&
        (argument[1] as number) <= 6
      );
    default:
      return false;
  }
}

/** The operator of a calculation, if the expression is one. */
export function operatorOf(expression: Expression): ExpressionOperator | undefined {
  if (!isObject(expression)) return undefined;
  return EXPRESSION_OPERATORS.find((op) => op in expression);
}

/** The operands of a calculation that are expressions: all of them, but a rounding's digits and a choice's condition. */
export function operandsOf(expression: Expression): readonly Expression[] {
  const op = operatorOf(expression);
  if (!op) return [];
  if (op === 'round') return [(expression as { round: readonly [Expression, number] }).round[0]];
  if (op === 'if') return (expression as { if: readonly [Condition, Expression, Expression] }).if.slice(1) as Expression[];
  return (expression as Record<string, readonly Expression[]>)[op] ?? [];
}

/** The references an expression makes, such as `record.total` and `principal.id`, those of a choice's condition too. */
export function expressionRefs(expression: Expression): string[] {
  if (!isObject(expression)) return [];
  if ('ref' in expression) return [expression.ref];
  const own = operatorOf(expression) === 'if' ? conditionRefs((expression as { if: readonly [Condition, Expression, Expression] }).if[0]) : [];
  return [...own, ...operandsOf(expression).flatMap(expressionRefs)];
}

/** The same expression with each reference mapped, for example after a field is renamed. */
export function mapExpressionRefs(expression: Expression, map: (ref: string) => string): Expression {
  if (!isObject(expression)) return expression;
  if ('ref' in expression) return { ref: map(expression.ref) };
  const op = operatorOf(expression);
  if (!op) return expression;
  if (op === 'round') {
    const [value, digits] = (expression as { round: readonly [Expression, number] }).round;
    return { round: [mapExpressionRefs(value, map), digits] };
  }
  if (op === 'if') {
    const [when, then, otherwise] = (expression as { if: readonly [Condition, Expression, Expression] }).if;
    return { if: [mapRefs(when, map), mapExpressionRefs(then, map), mapExpressionRefs(otherwise, map)] };
  }
  const operands = (expression as Record<string, readonly Expression[]>)[op]!.map((operand) => mapExpressionRefs(operand, map));
  return { [op]: operands } as unknown as Expression;
}

/** The kinds of value an expression can give, as a field's value kinds, with nothing and anything. */
export type CalculationKind = 'text' | 'uuid' | 'number' | 'boolean' | 'date' | 'datetime' | 'text[]' | 'uuid[]' | 'null' | 'any';

const KIND_WORDS: Readonly<Record<CalculationKind, string>> = {
  text: 'text',
  uuid: 'an ID of a person or a record',
  number: 'a number',
  boolean: 'yes or no',
  date: 'a date',
  datetime: 'a time',
  'text[]': 'a list of options',
  'uuid[]': 'a list of records',
  null: 'nothing',
  any: 'any value',
};

/**
 * The kind of value a calculation gives, from the kinds of its operands (for a choice, of its two
 * values), and what doesn't fit, in words. The checks of steps and of flows share it.
 */
export function calculationKind(
  op: ExpressionOperator,
  kinds: readonly CalculationKind[],
): { readonly kind: CalculationKind; readonly problems: readonly string[] } {
  const loose = (kind: CalculationKind | undefined) => kind === undefined || kind === 'null' || kind === 'any';
  const problems: string[] = [];
  const need = (kind: CalculationKind | undefined, fit: readonly CalculationKind[], what: string) => {
    if (!loose(kind) && !fit.includes(kind!)) problems.push(`${op} works on ${what}, not on ${KIND_WORDS[kind!]}`);
  };
  const first = kinds.find((kind) => !loose(kind));
  switch (op) {
    case 'concat':
    case 'upper':
    case 'lower':
    case 'trim':
      return { kind: 'text', problems };
    case 'text_length':
      return { kind: 'number', problems };
    case 'left':
      need(kinds[1], ['number'], 'a number of characters');
      return { kind: 'text', problems };
    case 'coalesce':
    case 'if':
      return { kind: first ?? 'any', problems };
    case 'add_days':
      need(kinds[0], ['date', 'datetime'], 'a date or a time');
      need(kinds[1], ['number'], 'a number of days');
      return { kind: kinds[0] === 'datetime' ? 'datetime' : loose(kinds[0]) ? 'any' : 'date', problems };
    case 'add_hours':
      need(kinds[0], ['date', 'datetime'], 'a time');
      need(kinds[1], ['number'], 'a number of hours');
      return { kind: 'datetime', problems };
    case 'days_between':
      for (const kind of kinds) need(kind, ['date', 'datetime'], 'dates and times');
      return { kind: 'number', problems };
    default:
      for (const kind of kinds) if (!loose(kind) && kind !== 'number') problems.push(`${op} works on numbers, not on ${KIND_WORDS[kind]}`);
      return { kind: 'number', problems };
  }
}

export interface ExpressionScope {
  /** The record as the steps have made it so far. Empty values are `null` or left out. */
  readonly record: Readonly<Record<string, unknown>>;
  readonly principal: Readonly<Record<string, unknown>>;
  readonly now: Date;
  /** A flow's variables: values, records (with their `id`) and lists of records. */
  readonly vars?: Readonly<Record<string, unknown>>;
}

export type Evaluated = { readonly ok: true; readonly value: ExpressionValue } | { readonly ok: false; readonly message: string };

const value = (v: ExpressionValue): Evaluated => ({ ok: true, value: v });
const failure = (message: string): Evaluated => ({ ok: false, message });

const DAY = 86_400_000;
const isDate = (v: ExpressionValue): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Dates and times moved by days or hours, and the days between two of them. An empty operand gives an empty value. */
function dates(op: 'add_days' | 'add_hours' | 'days_between', operands: readonly ExpressionValue[]): Evaluated {
  const [first, second] = operands;
  if (first === null || second === null || first === undefined || second === undefined) return value(null);
  if (op === 'days_between') {
    const [from, to] = [timeOf(first), timeOf(second)];
    if (from === undefined || to === undefined) return failure('days_between works on dates and times');
    return value(Math.trunc((to - from) / DAY));
  }
  const at = timeOf(first);
  if (at === undefined) return failure(`${op} works on ${op === 'add_days' ? 'a date or a time' : 'a time'}`);
  if (typeof second !== 'number') return failure(`${op} adds a number`);
  // A date moves by whole days and stays a date; a time moves by the exact amount.
  if (op === 'add_days' && isDate(first)) return value(new Date(at + Math.round(second) * DAY).toISOString().slice(0, 10));
  return value(new Date(at + second * (op === 'add_days' ? DAY : 3_600_000)).toISOString());
}

function scalar(raw: unknown): ExpressionValue {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) return raw as string[];
  // A record stands for its ID, so a step can put it in a reference field.
  if (isObject(raw) && typeof raw['id'] === 'string') return raw['id'];
  return null;
}

/** The value at a path inside a variable, or undefined if the path leads nowhere. */
export function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let at = root;
  for (const key of path) {
    if (!isObject(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

/**
 * Round half away from zero to a number of decimal places. It works on the decimal text of the
 * number, so 1.005 rounds to 1.01, as a person expects, and not to 1.00.
 */
export function roundTo(n: number, digits: number): number {
  const sign = n < 0 ? -1 : 1;
  const text = String(Math.abs(n));
  const rounded = text.includes('e') ? Math.round(Math.abs(n) * 10 ** digits) / 10 ** digits : Number(`${Math.round(Number(`${text}e${digits}`))}e-${digits}`);
  const result = sign * rounded;
  return result === 0 ? 0 : result;
}

/** Work out an expression. A calculation with an empty operand is empty, as in a spreadsheet's blank cell. */
export function evaluateExpression(expression: Expression, scope: ExpressionScope): Evaluated {
  if (!isObject(expression)) return value(expression as ExpressionValue);
  if ('ref' in expression) {
    const [root, ...path] = expression.ref.split('.') as [string, ...string[]];
    if (root === 'record') return value(scalar(path.length ? valueAtPath(scope.record, path) : scope.record));
    if (root === 'principal') return value(scalar(valueAtPath(scope.principal, path)));
    if (scope.vars && Object.hasOwn(scope.vars, root)) return value(scalar(valueAtPath(scope.vars[root], path)));
    return failure(`${expression.ref}: ${scope.vars ? 'no such variable' : 'steps can refer to record and principal'}`);
  }
  if ('today' in expression) return value(scope.now.toISOString().slice(0, 10));
  if ('now' in expression) return value(scope.now.toISOString());
  const op = operatorOf(expression);
  if (!op) return failure('Not a valid expression');
  if (op === 'round') {
    const [inner, digits] = (expression as { round: readonly [Expression, number] }).round;
    const result = evaluateExpression(inner, scope);
    if (!result.ok || result.value === null) return result;
    return typeof result.value === 'number' ? value(roundTo(result.value, digits)) : failure('round works on numbers');
  }
  if (op === 'if') {
    const [when, then, otherwise] = (expression as { if: readonly [Condition, Expression, Expression] }).if;
    const env = { ...scope.vars, record: scope.record, principal: scope.principal, [CLOCK]: scope.now };
    return evaluateExpression(evaluateCondition(when, env) ? then : otherwise, scope);
  }
  const operands: ExpressionValue[] = [];
  for (const operand of (expression as Record<string, readonly Expression[]>)[op]!) {
    const result = evaluateExpression(operand, scope);
    if (!result.ok) return result;
    operands.push(result.value);
  }
  if (op === 'concat') {
    return value(operands.map((v) => (v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v))).join(''));
  }
  if (op === 'coalesce') return value(operands.find((v) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)) ?? null);
  const text = (v: ExpressionValue) => (v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v));
  switch (op) {
    case 'upper':
      return value(operands[0] === null ? null : text(operands[0]!).toUpperCase());
    case 'lower':
      return value(operands[0] === null ? null : text(operands[0]!).toLowerCase());
    case 'trim':
      return value(operands[0] === null ? null : text(operands[0]!).trim());
    case 'text_length':
      return value([...text(operands[0] ?? null)].length);
    case 'left': {
      const [whole, count] = operands;
      if (whole === null || count === null) return value(null);
      if (typeof count !== 'number' || count < 0) return failure('left takes a number of characters');
      return value([...text(whole!)].slice(0, Math.floor(count)).join(''));
    }
    case 'add_days':
    case 'add_hours':
    case 'days_between':
      return dates(op, operands);
    default:
      break;
  }
  if (operands.some((v) => v === null)) return value(null);
  if (!operands.every((v): v is number => typeof v === 'number')) return failure(`${op} works on numbers`);
  const numbers = operands as number[];
  switch (op) {
    case 'add':
      return value(numbers.reduce((total, n) => total + n, 0));
    case 'mul':
      return value(numbers.reduce((total, n) => total * n, 1));
    case 'sub':
      return value(numbers[0]! - numbers[1]!);
    case 'div':
      return numbers[1] === 0 ? failure('It divides by zero') : value(numbers[0]! / numbers[1]!);
  }
}
