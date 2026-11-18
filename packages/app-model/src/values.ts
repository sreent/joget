import {
  entityFields,
  isWritable,
  lineOwners,
  rollupOf,
  type FieldInfo,
  type StoredDefinition,
  type StoredEntity,
  type StoredLinesField,
} from './fields.js';
import { MAX_NUMBER_MAGNITUDE } from './schema.js';

/** When a record is written, and by whom: what a default such as today or the person works out from. */
export interface WriteContext {
  readonly now?: Date | undefined;
  /** The person who writes the record, if a person does. */
  readonly person?: string | undefined;
}

/** A record value in its canonical JSON form (see ValueKind). `null` is an empty value. */
export type FieldValue = string | number | boolean | readonly string[] | null;
export type RecordValues = Readonly<Record<string, FieldValue>>;

/** A line as a caller sends it: with the ID of a line to keep or change, or without one for a new line. */
export interface LineInput {
  readonly id?: string;
  readonly values: Readonly<Record<string, FieldValue>>;
}

/** A line as it is stored, or as it will be: new lines have no ID until they are written. */
export interface LineValues {
  readonly id: string | null;
  readonly values: RecordValues;
}

/** A record's lines, by lines field. */
export type RecordLines = Readonly<Record<string, readonly LineValues[]>>;

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
/**
 * A field's default, as the field holds it: a fixed value; a day so many days from today; a time so
 * many hours from now; or the person who writes the record. Undefined when it has none, or when no
 * person writes it.
 */
export function defaultValue(info: FieldInfo, at: WriteContext = {}): FieldValue | undefined {
  const field = info.field;
  if (!field || !('default' in field) || field.default === undefined) return undefined;
  const given: unknown = field.default;
  let raw = given;
  if (given !== null && typeof given === 'object' && !Array.isArray(given)) {
    const now = (at.now ?? new Date()).getTime();
    if ('today' in given && typeof given.today === 'number') raw = new Date(now + given.today * 86_400_000).toISOString().slice(0, 10);
    else if ('now' in given && typeof given.now === 'number') raw = new Date(now + given.now * 3_600_000).toISOString();
    else if ('me' in given) raw = at.person;
  }
  if (raw === undefined) return undefined;
  const result = canonicalValue(info, raw);
  return result.ok ? result.value : undefined;
}

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
    case 'file':
      return uuid(value);
    case 'lines':
      return fail('invalid_type', 'Lines are checked as a list');
  }
}

export interface InputCheck {
  /** The canonical values of the fields given (or defaulted, for creates). */
  readonly values: Record<string, FieldValue>;
  /** The lines given, by lines field, each line's values canonical. Complete them with completeLines. */
  readonly lines: Record<string, LineInput[]>;
  readonly issues: ValueIssue[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Check the lines a caller sends for one lines field: each line's ID and values, not yet whether they're complete. */
function checkLines(lineEntity: StoredEntity, field: StoredLinesField, raw: unknown, issues: ValueIssue[]): LineInput[] {
  if (raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push({ field: field.name, code: 'invalid_type', message: 'Expected a list of lines' });
    return [];
  }
  if (raw.length > field.max) issues.push({ field: field.name, code: 'too_big', message: `At most ${field.max} lines` });
  const fields = entityFields(lineEntity, { line: true });
  const seen = new Set<string>();
  const lines: LineInput[] = [];
  raw.slice(0, field.max).forEach((item, index) => {
    const at = `${field.name}[${index}]`;
    if (!isPlainObject(item)) {
      issues.push({ field: at, code: 'invalid_type', message: 'Expected a line: an object of its values' });
      return;
    }
    const values: Record<string, FieldValue> = {};
    let id: string | undefined;
    for (const [name, value] of Object.entries(item)) {
      if (name === 'id') {
        const result = value === undefined || value === null ? undefined : uuid(value);
        if (result && !result.ok) issues.push({ field: `${at}.id`, ...result.issue });
        else if (result?.ok) {
          id = result.value as string;
          if (seen.has(id)) issues.push({ field: `${at}.id`, code: 'invalid_type', message: 'This line is listed twice' });
          seen.add(id);
        }
        continue;
      }
      const info = fields.get(name);
      if (!info) {
        issues.push({ field: `${at}.${name}`, code: 'unknown_field', message: `${lineEntity.label} has no field ${name}` });
        continue;
      }
      if (!isWritable(info)) {
        issues.push({ field: `${at}.${name}`, code: 'not_writable', message: `${name} can't be set here` });
        continue;
      }
      const result = canonicalValue(info, value);
      if (!result.ok) issues.push({ field: `${at}.${name}`, ...result.issue });
      else values[name] = result.value;
    }
    lines.push(id ? { id, values } : { values });
  });
  return lines;
}

/**
 * Turn the lines a caller sent into the lines a record will have, given the lines it has now:
 * a line with an ID changes that line, keeping what isn't given; a line without one is new, with
 * the field defaults. Lines left out are removed. Required fields are checked on the result.
 */
export function completeLines(
  lineEntity: StoredEntity,
  field: StoredLinesField,
  input: readonly LineInput[],
  current: readonly LineValues[],
  writing: WriteContext = {},
): { readonly lines: LineValues[]; readonly issues: ValueIssue[] } {
  const issues: ValueIssue[] = [];
  const fields = entityFields(lineEntity, { line: true });
  const byId = new Map(current.flatMap((line) => (line.id ? [[line.id, line] as const] : [])));
  const lines: LineValues[] = [];
  input.forEach((line, index) => {
    const at = `${field.name}[${index}]`;
    const base = line.id ? byId.get(line.id) : undefined;
    if (line.id && !base) {
      issues.push({ field: `${at}.id`, code: 'invalid_uuid', message: 'This record has no such line' });
      return;
    }
    const values: Record<string, FieldValue> = {};
    for (const declared of lineEntity.fields) {
      if (declared.name in line.values) values[declared.name] = line.values[declared.name]!;
      else if (base) values[declared.name] = base.values[declared.name] ?? null;
      else values[declared.name] = defaultValue(fields.get(declared.name)!, writing) ?? null;
      if (declared.required && values[declared.name] === null) {
        issues.push({ field: `${at}.${declared.name}`, code: 'required', message: `${declared.label} is required` });
      }
    }
    lines.push({ id: line.id ?? null, values });
  });
  if (field.required && lines.length === 0 && input.length === 0) {
    issues.push({ field: field.name, code: 'required', message: `${field.label}: add at least one line` });
  }
  return { lines, issues };
}

/**
 * The values of an entity's rollups, worked out from its lines. Only rollups over the lines fields
 * given are worked out. Sums are exact: values have at most their field's decimal places, so they
 * add up as whole numbers of the smallest unit.
 */
export function rollupValues(
  definition: StoredDefinition,
  entityName: string,
  lines: RecordLines,
): { readonly values: Record<string, FieldValue>; readonly issues: ValueIssue[] } {
  const entity = definition.entities[entityName]!;
  const fields = entityFields(entity);
  const values: Record<string, FieldValue> = {};
  const issues: ValueIssue[] = [];
  for (const field of entity.fields) {
    const rollup = rollupOf(field);
    if (!rollup) continue;
    const [op, path] = Object.entries(rollup)[0] as ['sum' | 'min' | 'max' | 'count', string];
    const [linesName, sub] = path.split('.') as [string, string | undefined];
    const current = lines[linesName];
    if (!current) continue;
    let value: FieldValue;
    if (op === 'count') value = current.length;
    else {
      const linesField = entity.fields.find((f) => f.name === linesName);
      const source = linesField?.type === 'lines' ? definition.entities[linesField.entity]?.fields.find((f) => f.name === sub) : undefined;
      const decimals = source?.type === 'number' ? source.decimals : 0;
      const numbers = current.map((line) => line.values[sub!]).filter((v): v is number => typeof v === 'number');
      if (op === 'sum') {
        const scale = 10 ** decimals;
        value = Number((numbers.reduce((total, n) => total + Math.round(n * scale), 0) / scale).toFixed(decimals));
      } else value = numbers.length ? (op === 'min' ? Math.min(...numbers) : Math.max(...numbers)) : null;
    }
    const result = canonicalValue(fields.get(field.name)!, value);
    if (result.ok) values[field.name] = result.value;
    else issues.push({ field: field.name, ...result.issue, message: `${field.label}: ${result.issue.message}` });
  }
  return { values, issues };
}

/**
 * Check what a caller wants to write to a record of an entity.
 *
 * - `create` fills in field defaults and requires every required field.
 * - `update` checks only the fields given, and refuses to empty a required one.
 *
 * Lines come back separately, checked line by line; completeLines finishes them once the record's
 * current lines are known. `allowed`, if given, limits which fields may be written at all, for
 * example to an action's inputs.
 */
export function checkInput(
  definition: StoredDefinition,
  entityName: string,
  input: Readonly<Record<string, unknown>>,
  options: {
    readonly mode: 'create' | 'update';
    readonly allowed?: ReadonlySet<string>;
    /** Values set regardless of the input, for example by an action. They win over the input. */
    readonly fixed?: Readonly<Record<string, unknown>>;
    /** Fields that get their value later, for example from an action's flow before it saves: no input is required for them. */
    readonly given?: ReadonlySet<string>;
    /** When, and by whom, for defaults such as today or the person. */
    readonly at?: WriteContext;
  },
): InputCheck {
  const entity = definition.entities[entityName]!;
  const fields = entityFields(entity, { line: lineOwners(definition).has(entityName) });
  const values: Record<string, FieldValue> = {};
  const lines: Record<string, LineInput[]> = {};
  const issues: ValueIssue[] = [];
  for (const [name, raw] of Object.entries(input)) {
    const linesField = entity.fields.find((f): f is StoredLinesField => f.name === name && f.type === 'lines');
    if (linesField) {
      if (options.allowed && !options.allowed.has(name)) issues.push({ field: name, code: 'not_writable', message: `${name} can't be set here` });
      else lines[name] = checkLines(definition.entities[linesField.entity]!, linesField, raw, issues);
      continue;
    }
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
    // Lines are complete only once the record's current lines are known; rollups are worked out from them.
    if (field.type === 'lines' || rollupOf(field)) continue;
    if (options.mode === 'create' && !(field.name in values)) {
      const given = defaultValue(fields.get(field.name)!, options.at);
      if (given !== undefined) values[field.name] = given;
    }
    const value = values[field.name];
    const emptied = field.name in values && value === null;
    // A field whose value was refused already has its issue; don't report it as missing too.
    const refused = issues.some((issue) => issue.field === field.name);
    const later = options.given?.has(field.name) && value === undefined;
    if (field.required && !refused && !later && (options.mode === 'create' ? value === undefined || value === null : emptied)) {
      issues.push({ field: field.name, code: 'required', message: `${field.label} is required` });
    }
  }
  return { values, lines, issues };
}

/** A record as conditions see it: empty values are left out, so they count as missing. */
export function conditionRecord(values: RecordValues): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}
