import type { AppTest } from './schema.js';

/*
 * The app's tests (design §6.7): records first, an action that someone in a role runs, and what
 * must come of it. The API runs them in a transaction that it undoes; these are the parts that
 * need no database.
 */

const isGiven = (value: unknown): value is { readonly given: string } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { given?: unknown }).given === 'string';

/** The records a value names as `{ "given": "<name>" }`, itself or in its list. */
export function givenRefs(value: unknown): string[] {
  if (isGiven(value)) return [value.given];
  return Array.isArray(value) ? value.flatMap(givenRefs) : [];
}

/** Values with each `{ "given": "<name>" }` as the ID of the record the test made by that name. */
export function withGivenIds(values: Readonly<Record<string, unknown>>, ids: ReadonlyMap<string, string>): Record<string, unknown> {
  const resolve = (value: unknown): unknown => (isGiven(value) ? (ids.get(value.given) ?? value) : Array.isArray(value) ? value.map(resolve) : value);
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, resolve(value)]));
}

/** Where a record differs from what a test expects of it: each field, what it should hold, and what it holds. */
export function testMismatches(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): Array<{ readonly field: string; readonly expected: unknown; readonly actual: unknown }> {
  // An empty value is null, as records hold it.
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return Object.entries(expected).flatMap(([field, value]) => (same(value, actual[field]) ? [] : [{ field, expected: value ?? null, actual: actual[field] ?? null }]));
}

/** The names of the records a test makes, in the order it makes them. */
export const givenNames = (test: AppTest): string[] => Object.keys(test.given);
