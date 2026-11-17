import type { StoredDefinition } from './fields.js';
import { alwaysGiven } from './steps.js';
import { checkInput, type InputCheck } from './values.js';

/**
 * Check a caller's input for an action. Only the action's inputs may be given; the values the
 * action sets itself always win. For creates, defaults are filled in and required fields enforced.
 */
export function checkActionInput(definition: StoredDefinition, actionName: string, input: Readonly<Record<string, unknown>>): InputCheck {
  const action = definition.actions[actionName];
  if (!action) throw new Error(`No action ${actionName}`);
  // A field the steps always set needs no input: the steps give it its value.
  return checkInput(definition, action.entity, input, { mode: action.operation, allowed: new Set(action.input), fixed: action.set, given: alwaysGiven(action.steps ?? []) });
}
