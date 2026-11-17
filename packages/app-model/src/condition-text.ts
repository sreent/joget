import { isCondition, isRef, type Condition, type Operand } from '@platform/authz';

/*
 * Conditions as text, such as `record.days > 10 && record.kind == "annual"`: how a BPMN file
 * carries them, so a person can read them in any modeller. The text maps one to one onto the
 * JSON conditions the platform stores.
 */

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function operandText(operand: Operand): string {
  return isRef(operand) ? operand.ref : JSON.stringify(operand);
}

/** Write a condition as text. */
export function conditionText(condition: Condition): string {
  const write = (c: Condition, inside: 'and' | 'or' | 'not' | null): string => {
    if ('all' in c) {
      if (!c.all.length) return 'true';
      const text = c.all.map((part) => write(part, 'and')).join(' && ');
      return inside === 'not' && c.all.length > 1 ? `(${text})` : text;
    }
    if ('any' in c) {
      if (!c.any.length) return 'false';
      const text = c.any.map((part) => write(part, 'or')).join(' || ');
      return (inside === 'and' || inside === 'not') && c.any.length > 1 ? `(${text})` : text;
    }
    if ('not' in c) return `!(${write(c.not, null)})`;
    if ('exists' in c) return `has(${c.exists})`;
    if ('in' in c) {
      const [needle, haystack] = c.in;
      const list = Array.isArray(haystack) ? `[${(haystack as readonly Operand[]).map(operandText).join(', ')}]` : operandText(haystack as Operand);
      return `${operandText(needle)} in ${list}`;
    }
    const [op, symbol] = (
      [
        ['eq', '=='],
        ['ne', '!='],
        ['lt', '<'],
        ['lte', '<='],
        ['gt', '>'],
        ['gte', '>='],
      ] as const
    ).find(([key]) => key in c)!;
    const [left, right] = (c as Record<string, readonly [Operand, Operand]>)[op]!;
    return `${operandText(left)} ${symbol} ${operandText(right)}`;
  };
  return write(condition, null);
}

type Token =
  | { readonly kind: 'path'; readonly text: string }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'op'; readonly text: string };

export type ParsedCondition = { readonly ok: true; readonly condition: Condition } | { readonly ok: false; readonly message: string };

const KEYWORDS: Readonly<Record<string, string>> = { and: '&&', or: '||', not: '!' };
const COMPARISONS: Readonly<Record<string, 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'>> = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const string = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/.exec(rest);
    if (string) {
      const body = string[1] ?? string[2]!.replace(/\\'/g, "'").replace(/"/g, '\\"');
      tokens.push({ kind: 'literal', value: JSON.parse(`"${body}"`) as string });
      at += string[0].length;
      continue;
    }
    const number = /^-?\d+(\.\d+)?(?![\w.])/.exec(rest);
    if (number) {
      tokens.push({ kind: 'literal', value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    const op = /^(==|!=|<=|>=|&&|\|\||[<>=!()[\],])/.exec(rest);
    if (op) {
      tokens.push({ kind: 'op', text: op[0] === '=' ? '==' : op[0] });
      at += op[0].length;
      continue;
    }
    const path = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*/.exec(rest);
    if (path) {
      const word = path[0];
      if (word === 'true' || word === 'false') tokens.push({ kind: 'literal', value: word === 'true' });
      else if (word === 'null') tokens.push({ kind: 'literal', value: null });
      else if (word in KEYWORDS) tokens.push({ kind: 'op', text: KEYWORDS[word]! });
      else if (word === 'in' || word === 'has' || word === 'exists') tokens.push({ kind: 'op', text: word === 'exists' ? 'has' : word });
      else tokens.push({ kind: 'path', text: word });
      at += word.length;
      continue;
    }
    throw new Error(`Can't read "${rest.slice(0, 12)}"`);
  }
  return tokens;
}

/**
 * Read a condition from text. Names are kept as they are, or mapped by `resolve`, which turns a
 * name into a reference, or says it knows none (for example, a bare `days` into `record.days`).
 * A `${…}` or `#{…}` around the whole text, as some engines write, is taken off.
 */
export function parseConditionText(input: string, resolve: (name: string) => string | undefined = (name) => name): ParsedCondition {
  const text = input.trim().replace(/^[$#]\{([\s\S]*)\}$/, '$1');
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const isOp = (text: string) => peek()?.kind === 'op' && (peek() as { text: string }).text === text;
  const expect = (text: string) => {
    if (!isOp(text)) throw new Error(`Expected ${text}`);
    at++;
  };
  const operand = (): Operand => {
    const token = tokens[at++];
    if (!token || token.kind === 'op') throw new Error('Expected a name or a value');
    if (token.kind === 'literal') return token.value;
    const ref = resolve(token.text);
    if (!ref) throw new Error(`Unknown name ${token.text}`);
    return { ref };
  };
  const primary = (): Condition => {
    if (isOp('(')) {
      at++;
      const inner = or();
      expect(')');
      return inner;
    }
    if (isOp('has')) {
      at++;
      expect('(');
      const target = operand();
      expect(')');
      if (!isRef(target)) throw new Error('has() takes a name');
      return { exists: target.ref };
    }
    const next = peek();
    if (next?.kind === 'literal' && typeof next.value === 'boolean' && !['==', '!=', '<', '<=', '>', '>=', 'in'].includes((tokens[at + 1] as { text?: string } | undefined)?.text ?? '')) {
      at++;
      return next.value ? { all: [] } : { any: [] };
    }
    const left = operand();
    if (isOp('in')) {
      at++;
      if (isOp('[')) {
        at++;
        const items: Operand[] = [];
        if (!isOp(']')) {
          items.push(operand());
          while (isOp(',')) {
            at++;
            items.push(operand());
          }
        }
        expect(']');
        return { in: [left, items] };
      }
      return { in: [left, operand()] };
    }
    const token = peek();
    const symbol = token?.kind === 'op' ? token.text : '';
    const op = COMPARISONS[symbol];
    if (!op) {
      // A bare yes-or-no name, as engines often write a flag: `approved` means it is true.
      if (isRef(left)) return { eq: [left, true] };
      throw new Error('Expected a comparison');
    }
    at++;
    const right = operand();
    if ((op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') && [left, right].some((value) => !isRef(value) && !isNumber(value))) throw new Error(`${symbol} compares numbers`);
    const pair: [Operand, Operand] = [left, right];
    switch (op) {
      case 'eq':
        return { eq: pair };
      case 'ne':
        return { ne: pair };
      case 'lt':
        return { lt: pair };
      case 'lte':
        return { lte: pair };
      case 'gt':
        return { gt: pair };
      case 'gte':
        return { gte: pair };
    }
  };
  const unary = (): Condition => {
    if (isOp('!')) {
      at++;
      return { not: unary() };
    }
    return primary();
  };
  const and = (): Condition => {
    const parts = [unary()];
    while (isOp('&&')) {
      at++;
      parts.push(unary());
    }
    return parts.length === 1 ? parts[0]! : { all: parts };
  };
  const or = (): Condition => {
    const parts = [and()];
    while (isOp('||')) {
      at++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0]! : { any: parts };
  };
  try {
    if (!tokens.length) return { ok: false, message: 'The condition is empty' };
    const condition = or();
    if (at < tokens.length) throw new Error('Unexpected text after the condition');
    if (!isCondition(condition)) throw new Error('Not a valid condition');
    return { ok: true, condition };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
