import type { Definition } from '../types.js';
import { toName } from './edit.js';

/** One of the app's tests: records first, an action someone in a role runs, and what must come of it (design §6.7). */
export type AppTest = NonNullable<Definition['tests']>[string];

/** A new test, named after its label. It starts with an action that makes a record, run by a role that may run it. */
export function addTest(definition: Definition, label: string): { definition: Definition; name: string } {
  const name = toName(label, Object.keys(definition.tests ?? {}));
  const actions = Object.entries(definition.actions);
  const action = (actions.find(([, each]) => each.operation === 'create') ?? actions[0])?.[0] ?? '';
  const role = Object.entries(definition.roles).find(([, each]) => each.actions.includes(action))?.[0] ?? Object.keys(definition.roles)[0] ?? '';
  const test: AppTest = { label, given: {}, when: { action, as: role, values: {} }, then: { outcome: 'saved', values: {} } };
  return { definition: { ...definition, tests: { ...definition.tests, [name]: test } }, name };
}

export function updateTest(definition: Definition, name: string, test: AppTest): Definition {
  return { ...definition, tests: { ...definition.tests, [name]: test } };
}

/** Take a test out; with none left, the definition has no tests at all. */
export function removeTest(definition: Definition, name: string): Definition {
  const { [name]: _removed, ...rest } = definition.tests ?? {};
  const next = { ...definition };
  if (Object.keys(rest).length) next.tests = rest;
  else delete next.tests;
  return next;
}

/** A name for a test's next record: the entity's name, numbered when it's taken. */
export function givenName(test: AppTest, entity: string): string {
  return toName(entity, Object.keys(test.given));
}

/** The records a test makes first that are of an entity, by name: what a reference in the test can name. */
export function givenOf(test: AppTest, entity: string): string[] {
  return Object.entries(test.given).flatMap(([name, record]) => (record.entity === entity ? [name] : []));
}
