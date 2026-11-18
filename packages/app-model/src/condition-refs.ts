import { type Condition, isRef, type Operand } from '@platform/authz';

/** A condition with its references renamed. */
export function mapRefs(condition: Condition, rename: (ref: string) => string): Condition {
  const operand = (o: Operand): Operand => (isRef(o) ? { ref: rename(o.ref) } : o);
  if ('all' in condition) return { all: condition.all.map((c) => mapRefs(c, rename)) };
  if ('any' in condition) return { any: condition.any.map((c) => mapRefs(c, rename)) };
  if ('not' in condition) return { not: mapRefs(condition.not, rename) };
  if ('exists' in condition) return { exists: rename(condition.exists) };
  if ('in' in condition) {
    const [needle, haystack] = condition.in;
    return { in: [operand(needle), Array.isArray(haystack) ? (haystack as readonly Operand[]).map(operand) : operand(haystack as Operand)] };
  }
  const [op, args] = Object.entries(condition)[0] as [string, readonly [Operand, Operand]];
  return { [op]: [operand(args[0]), operand(args[1])] } as unknown as Condition;
}
