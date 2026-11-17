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
      'Pages lay out lists of records, text and buttons for people in screens, and navigation is the menu. Neither protects data: roles do, and each person sees only what their role can use.',
      'An action can have steps, which run after its input and its set values, in order: {"type": "set", "field", "value"}, {"type": "add_line", "field": "<lines field>", "values": {...}}, {"type": "check", "assert": <condition>, "message", "severity": "error" | "warning"}, {"type": "if", "when": <condition>, "then": [...], "else": [...]} (one level deep).',
      'Flows are what happens in the app, like Mendix microflows, under "flows": {"<name>": {"label", "input": {"<name>": {"type": "text" | "number" | "boolean" | "date" | "datetime"} | {"type": "record" | "list", "entity"}}, "output"?, "steps": [...]}}. Steps: set (a variable), find (records of an entity into a list, or one with "first"; its "where" condition reads record.<field> of what it looks at), create, change, delete, add_line (on a record variable), each (loop over a list variable, or a record variable\'s lines as "claim.lines"), if, check, call (another flow), try (with "catch", "rollback" and "error"), total (count, sum, avg, min or max of a list) and return. Expressions and conditions read variables as <variable> or <variable>.<field>. A flow without waits runs in one transaction.',
      'A flow can wait for people and for time: {"type": "task", "label", "role", "assignee"?: {"field"} | {"managerOf", "levels"}, "outcomes": [{"name", "label", "action"?, "steps": [...]}], "due"?, "card"?, "deadline"?: {"after", "steps"}} puts a task in a person\'s inbox and goes on by the way of the outcome they choose; {"type": "wait", "for": {"duration"} | {"date": "<field>"} | {"action"} | {"condition"} | {"signal"}} waits; {"type": "first_of", "ways": [{"for", "steps"}]} waits for the first of several things; {"type": "all_at_once", "ways": [{"steps"}]} runs ways at once and goes on when each has ended. Durations are ISO 8601, such as P3D. A flow that waits has one input, a record of the entity it is about, and no output. It keeps its place on that record, and has no person: a value in a variable doesn\'t live on across a wait, so keep it in a field of the record. Loops and error handlers don\'t hold steps that wait. The leave template has a flow that waits to start from.',
      'An action runs a flow once it saves, with "flow": {"flow": "<name>", "input": {"<input>": {"ref": "record"} or an expression on record.<field>}}. For a flow that waits, the input is {"<input>": {"ref": "record"}}: the action starts the flow on its record. A role lists the flows its holders may run in "flows": through the API, or on a record by hand for a flow that waits. Write no "processes": a flow that waits does what a process did.',
      'Step values are expressions: a literal, {"ref": "record.<field>" | "principal.id"}, {"today": true}, {"now": true}, {"add": [a, b, ...]}, {"sub": [a, b]}, {"mul": [a, b, ...]}, {"div": [a, b]}, {"round": [a, digits]} or {"concat": [a, b, ...]}. A number is rounded to its field\'s decimal places. Steps set only fields the person running the action may write.',
    ],
  };
}
