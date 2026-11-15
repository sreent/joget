import type { StoredDefinition } from './fields.js';
import { checkInput, type InputCheck } from './values.js';

/**
 * Check a caller's input for an action. Only the action's inputs may be given; the values the
 * action sets itself always win. For creates, defaults are filled in and required fields enforced.
 */
export function checkActionInput(definition: StoredDefinition, actionName: string, input: Readonly<Record<string, unknown>>): InputCheck {
  const action = definition.actions[actionName];
  if (!action) throw new Error(`No action ${actionName}`);
  const entity = definition.entities[action.entity]!;
  return checkInput(entity, input, { mode: action.operation, allowed: new Set(action.input), fixed: action.set });
}
