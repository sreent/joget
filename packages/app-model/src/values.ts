import { entityFields, isWritable, type FieldInfo, type StoredEntity } from './fields.js';
import { MAX_NUMBER_MAGNITUDE } from './schema.js';

/** A record value in its canonical JSON form (see ValueKind). `null` is an empty value. */
export type FieldValue = string | number | boolean | readonly string[] | null;
export type RecordValues = Readonly<Record<string, FieldValue>>;

export interface ValueIssue {
  readonly field: string;
  readonly code:
    | 'unknown_field'
    | 'not_writable'
    | 'required'
    | 'invalid_type'
    | 'too_long'
    | 'too_small'
    | 'too_big'
    | 'too_precise'
    | 'invalid_option'
    | 'invalid_email'
    | 'invalid_uuid'
    | 'invalid_date'
    | 'invalid_datetime'
    | 'duplicate_option';
  readonly message: string;
}

type Result = { readonly ok: true; readonly value: FieldValue } | { readonly ok: false; readonly issue: Omit<ValueIssue, 'field'> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isCanonicalUuid = (value: unknown): value is string => typeof value === 'string' && CANONICAL_UUID.test(value);

const ok = (value: FieldValue): Result => ({ ok: true, value });
const fail = (code: ValueIssue['code'], message: string): Result => ({ ok: false, issue: { code, message } });

function text(value: unknown, maxLength: number): Result {
  if (typeof value !== 'string') return fail('invalid_type', 'Expected text');
  if (value.includes('\u0000')) return fail('invalid_type', 'Text cannot contain NUL characters');
  if (value === '') return ok(null);
  if ([...value].length > maxLength) return fail('too_long', `At most ${maxLength} characters`);
  return ok(value);
}

function uuid(value: unknown): Result {
  if (typeof value !== 'string' || !UUID.test(value)) return fail('invalid_uuid', 'Expected an ID (a UUID)');
  return ok(value.toLowerCase());
}

/** Check one value against its field, and return it in canonical form. */
export function canonicalValue(info: FieldInfo, value: unknown): Result {
  if (value === null || value === undefined) return ok(null);
  const field = info.field;
  if (!field) {
    // Of the system fields, only `owner` is ever written.
    return info.kind === 'uuid' ? uuid(value) : fail('not_writable', `${info.name} is set by the platform`);
  }
  switch (field.type) {
    case 'text':
      return text(value, field.maxLength);
    case 'email': {
      const result = text(value, 320);
      if (!result.ok || result.value === null) return result;
      return EMAIL.test(result.value as string) ? result : fail('invalid_email', 'Expected an email address');
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('invalid_type', 'Expected a number');
      if (Math.abs(value) > MAX_NUMBER_MAGNITUDE) return fail('too_big', `At most ${MAX_NUMBER_MAGNITUDE} in size`);
      if (Number(value.toFixed(field.decimals)) !== value) {
        return fail('too_precise', field.decimals === 0 ? 'Expected a whole number' : `At most ${field.decimals} decimal places`);
      }
      if (field.min !== undefined && value < field.min) return fail('too_small', `At least ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail('too_big', `At most ${field.max}`);
      return ok(value === 0 ? 0 : value);
    }
    case 'boolean':
      return typeof value === 'boolean' ? ok(value) : fail('invalid_type', 'Expected true or false');
    case 'date': {
      const match = typeof value === 'string' ? DATE.exec(value) : null;
      if (!match) return fail('invalid_date', 'Expected a date as YYYY-MM-DD');
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const date = new Date(Date.UTC(year, month - 1, day));
      const valid = year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
      return valid ? ok(value as string) : fail('invalid_date', 'Not a real date');
    }
    case 'datetime': {
      if (typeof value !== 'string' || !DATETIME.test(value)) {
        return fail('invalid_datetime', 'Expected an ISO 8601 timestamp with a time zone, such as 2026-11-15T09:30:00Z');
      }
      const time = new Date(value);
      const year = time.getUTCFullYear();
      if (Number.isNaN(time.getTime()) || year < 1 || year > 9999) return fail('invalid_datetime', 'Not a real time');
      return ok(time.toISOString());
    }
    case 'choice': {
      const allowed = field.options.map((option) => option.value);
      if (!field.multiple) {
        if (typeof value !== 'string') return fail('invalid_type', 'Expected one of the options');
        return allowed.includes(value) ? ok(value) : fail('invalid_option', `Expected one of: ${allowed.join(', ')}`);
      }
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return fail('invalid_type', 'Expected a list of options');
      }
      if (new Set(value).size !== value.length) return fail('duplicate_option', 'Each option can be chosen once');
      const unknown = value.filter((item) => !allowed.includes(item));
      if (unknown.length) return fail('invalid_option', `Not options: ${unknown.join(', ')}`);
      if (value.length === 0) return ok(null);
      // Canonical order is the order of the options, so equal choices always look the same.
      return ok(allowed.filter((option) => value.includes(option)));
    }
    case 'reference':
    case 'user':
      return uuid(value);
  }
}

export interface InputCheck {
  /** The canonical values of the fields given (or defaulted, for creates). */
  readonly values: Record<string, FieldValue>;
  readonly issues: ValueIssue[];
}

/**
 * Check what a caller wants to write.
 *
 * - `create` fills in field defaults and requires every required field.
 * - `update` checks only the fields given, and refuses to empty a required one.
 *
 * `allowed`, if given, limits which fields may be written at all, for example to an action's inputs.
 */
export function checkInput(
  entity: StoredEntity,
  input: Readonly<Record<string, unknown>>,
  options: {
    readonly mode: 'create' | 'update';
    readonly allowed?: ReadonlySet<string>;
    /** Values set regardless of the input, for example by an action. They win over the input. */
    readonly fixed?: Readonly<Record<string, unknown>>;
  },
): InputCheck {
  const fields = entityFields(entity);
  const values: Record<string, FieldValue> = {};
  const issues: ValueIssue[] = [];
  for (const [name, raw] of Object.entries(input)) {
    const info = fields.get(name);
    if (!info) {
      issues.push({ field: name, code: 'unknown_field', message: `${entity.label} has no field ${name}` });
      continue;
    }
    if (!isWritable(info) || (options.allowed && !options.allowed.has(name))) {
      issues.push({ field: name, code: 'not_writable', message: `${name} can't be set here` });
      continue;
    }
    const result = canonicalValue(info, raw);
    if (!result.ok) issues.push({ field: name, ...result.issue });
    else values[name] = result.value;
  }
  for (const [name, raw] of Object.entries(options.fixed ?? {})) {
    const info = fields.get(name);
    const result = info ? canonicalValue(info, raw) : undefined;
    if (result?.ok) values[name] = result.value;
  }
  for (const field of entity.fields) {
    if (options.mode === 'create' && !(field.name in values) && 'default' in field && field.default !== undefined) {
      const result = canonicalValue(fields.get(field.name)!, field.default);
      if (result.ok) values[field.name] = result.value;
    }
    const value = values[field.name];
    const emptied = field.name in values && value === null;
    // A field whose value was refused already has its issue; don't report it as missing too.
    const refused = issues.some((issue) => issue.field === field.name);
    if (field.required && !refused && (options.mode === 'create' ? value === undefined || value === null : emptied)) {
      issues.push({ field: field.name, code: 'required', message: `${field.label} is required` });
    }
  }
  return { values, issues };
}

/** A record as conditions see it: empty values are left out, so they count as missing. */
export function conditionRecord(values: RecordValues): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}
