import { beforeGives } from './before.js';
import type { StoredDefinition } from './fields.js';
import { checkInput, type InputCheck, type WriteContext } from './values.js';

/**
 * Check a caller's input for an action. Only the action's inputs may be given; the values the
 * action sets itself always win. For creates, defaults are filled in and required fields enforced.
 */
export function checkActionInput(
  definition: StoredDefinition,
  actionName: string,
  input: Readonly<Record<string, unknown>>,
  at: WriteContext = {},
): InputCheck {
  const action = definition.actions[actionName];
  if (!action) throw new Error(`No action ${actionName}`);
  // A field that the flow before it saves always sets needs no input: the flow gives it its value.
  return checkInput(definition, action.entity, input, {
    mode: action.operation,
    allowed: new Set(action.input),
    fixed: action.set,
    given: beforeGives(definition, action),
    at,
  });
}
