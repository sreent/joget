/**
 * Values that steps work out (design §6.2). An expression is plain JSON, like a condition, so it
 * can be stored, compared and reviewed: a constant; a reference to a field of the record
 * (`record.total`) or to the person (`principal.id`); today's date or the time now, in UTC; or a
 * small calculation. There are no loops and no calls, so an expression always ends, and gives the
 * same value for the same record, person and time.
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
  | { readonly concat: readonly Expression[] };

/** A value an expression gives: what a field holds, in its canonical JSON form. */
export type ExpressionValue = string | number | boolean | readonly string[] | null;

export const EXPRESSION_OPERATORS = ['add', 'sub', 'mul', 'div', 'round', 'concat'] as const;
export type ExpressionOperator = (typeof EXPRESSION_OPERATORS)[number];

const MAX_DEPTH = 8;
const MAX_OPERANDS = 10;
const MAX_LITERAL_LENGTH = 10_000;
const REF = /^[a-z]+\.[A-Za-z_][A-Za-z0-9_]*$/;

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
    case 'sub':
    case 'div':
      return operands(2, 2);
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

/** The references an expression makes, such as `record.total` and `principal.id`. */
export function expressionRefs(expression: Expression): string[] {
  if (!isObject(expression)) return [];
  if ('ref' in expression) return [expression.ref];
  const op = operatorOf(expression);
  if (!op) return [];
  const operands = op === 'round' ? [(expression as { round: readonly [Expression, number] }).round[0]] : ((expression as Record<string, readonly Expression[]>)[op] ?? []);
  return operands.flatMap(expressionRefs);
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
  const operands = (expression as Record<string, readonly Expression[]>)[op]!.map((operand) => mapExpressionRefs(operand, map));
  return { [op]: operands } as unknown as Expression;
}

export interface ExpressionScope {
  /** The record as the steps have made it so far. Empty values are `null` or left out. */
  readonly record: Readonly<Record<string, unknown>>;
  readonly principal: Readonly<Record<string, unknown>>;
  readonly now: Date;
}

export type Evaluated = { readonly ok: true; readonly value: ExpressionValue } | { readonly ok: false; readonly message: string };

const value = (v: ExpressionValue): Evaluated => ({ ok: true, value: v });
const failure = (message: string): Evaluated => ({ ok: false, message });

function scalar(raw: unknown): ExpressionValue {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) return raw as string[];
  return null;
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
    const [root, name] = expression.ref.split('.') as [string, string];
    if (root === 'record') return value(scalar(Object.hasOwn(scope.record, name) ? scope.record[name] : null));
    if (root === 'principal') return value(scalar(Object.hasOwn(scope.principal, name) ? scope.principal[name] : null));
    return failure(`${expression.ref}: steps can refer to record and principal`);
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
  const operands: ExpressionValue[] = [];
  for (const operand of (expression as Record<string, readonly Expression[]>)[op]!) {
    const result = evaluateExpression(operand, scope);
    if (!result.ok) return result;
    operands.push(result.value);
  }
  if (op === 'concat') {
    return value(operands.map((v) => (v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v))).join(''));
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
