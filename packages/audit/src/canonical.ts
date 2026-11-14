/**
 * Deterministic JSON for hashing: object keys sorted by UTF-16 code units, no insignificant
 * whitespace, `undefined` object members dropped, dates as ISO 8601 strings. For the JSON values
 * the audit log uses, this matches RFC 8785 (JSON Canonicalization Scheme).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, 0);
}

const MAX_DEPTH = 64;

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('Value is nested too deeply to canonicalize');
  if (value === null) return 'null';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Invalid dates cannot be canonicalized');
    return JSON.stringify(value.toISOString());
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers cannot be canonicalized');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : serialize(item, depth + 1))).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`Only plain objects can be canonicalized, got ${proto?.constructor?.name ?? 'unknown'}`);
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(record[key], depth + 1)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`Values of type ${typeof value} cannot be canonicalized`);
  }
}
