import { EXPENSE_APP } from '@platform/app-model';
import { definitionJsonSchema } from './routes.js';

/**
 * What an AI client needs to write an app's definition: its JSON Schema, a complete example (an
 * expense-claim app), and notes on what the schema can't say. The MCP builder tools and the
 * studio's chat give the same guide.
 */
export function definitionGuide(): { readonly schema: unknown; readonly example: unknown; readonly notes: readonly string[] } {
  return {
    schema: definitionJsonSchema(),
    example: EXPENSE_APP,
    notes: [
      'Conditions are JSON: {"eq": [a, b]}, "ne", "lt", "lte", "gt", "gte", {"in": [needle, [list]]}, {"exists": "record.field"}, {"all": [...]}, {"any": [...]}, {"not": c}. Operands are literals or {"ref": "record.<field>" | "principal.id" | "input.<parameter>"}.',
      'An empty field is missing: it never equals anything. Test for emptiness with exists.',
      'Entities and fields get stable IDs when first saved. Keep them when you edit a definition: a field that keeps its ID under a new name is a rename, and renames carry through to every reference.',
      'Actions need a description written for agents, and a confirmation level: none, preview or review.',
      'Processes are BPMN 2.0, each about one record of an entity. Elements go by ID: a startEvent names the actions that start it; a userTask names the role that may do it, its outcomes and the action each runs; a serviceTask runs an update action, with no person; exclusiveGateway, parallelGateway, intermediateCatchEvent and boundaryEvent (with a timer: an ISO 8601 duration or a date field) and endEvent. The schema lists every other element: script, send, receive and rule-check tasks, inclusive, complex and event-based gateways, message, signal, condition, error and escalation events, sub-processes (with `in` on what they hold), transactions, event and ad hoc sub-processes, calls and loops. Flows join elements: a flow out of a user task names an outcome, and one out of an exclusive gateway has a condition or is its default. Conditions read record.<field> and tasks.<task>.outcome. The leave template has a process to start from.',
      'Pages lay out lists of records, text and buttons for people in screens, and navigation is the menu. Neither protects data: roles do, and each person sees only what their role can use.',
      'An action can have steps, which run after its input and its set values, in order: {"type": "set", "field", "value"}, {"type": "add_line", "field": "<lines field>", "values": {...}}, {"type": "check", "assert": <condition>, "message", "severity": "error" | "warning"}, {"type": "if", "when": <condition>, "then": [...], "else": [...]} (one level deep).',
      'Step values are expressions: a literal, {"ref": "record.<field>" | "principal.id"}, {"today": true}, {"now": true}, {"add": [a, b, ...]}, {"sub": [a, b]}, {"mul": [a, b, ...]}, {"div": [a, b]}, {"round": [a, digits]} or {"concat": [a, b, ...]}. A number is rounded to its field\'s decimal places. Steps set only fields the person running the action may write.',
    ],
  };
}
