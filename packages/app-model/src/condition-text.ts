import { type Condition, isRef, isRelativeTime, type Operand } from '@platform/authz';

/*
 * Conditions as text, such as `record.days > 10 && record.kind == "annual"`: for a change request
 * and a canvas to show a condition that has no words of its own. The text maps one to one onto the
 * JSON conditions the platform stores.
 */

function operandText(operand: Operand): string {
  if (isRef(operand)) return operand.ref;
  if (isRelativeTime(operand)) {
    const [base, n, unit] = 'today' in operand ? ['today', operand.today, 'day'] : ['now', operand.now, 'hour'];
    return n === 0 ? base : `${base} ${n > 0 ? '+' : '-'} ${Math.abs(n)} ${unit}${Math.abs(n) === 1 ? '' : 's'}`;
  }
  return JSON.stringify(operand);
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
