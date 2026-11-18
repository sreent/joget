import { COMPARISON_OPERATORS, conditionRefs, isRef, isRelativeTime, timeOf, type Condition, type Operand } from '@platform/authz';
import { mapRefs } from './condition-refs.js';
import { calculationKind, expressionRefs, mapExpressionRefs, operandsOf, operatorOf, roundTo, type Expression } from './expressions.js';
import { entityFields, fieldKind, isOrderedKind, isSortableKind, isWritable, lineOwners, type FieldInfo, type StoredDefinition } from './fields.js';
import { JSON_PATH, MAX_FLOW_DEPTH, MAX_FLOW_STEPS, type AppFlow, type Field, type FlowRun, type FlowStart, type FlowStep, type FlowType, type Voters, type WaitFor } from './schema.js';
import { scheduleIssues } from './schedules.js';
import { canonicalValue } from './values.js';
import { atProcessLevel, flowSubject, flowWaits, innerLists, stepWaits, withLists } from './waiting.js';

/*
 * Flows (design §6.2, §6.11): checking them before they are saved, carrying renames into them, and
 * saying what each does, for change requests. A flow's variables have kinds, which the checks work
 * out step by step, so a mistake shows when the flow is saved, not when it runs. In a flow that
 * waits, the record is the data: a variable lives until the flow waits, and no longer.
 */

interface Issue {
  readonly path: string;
  readonly message: string;
}

/** What a value is: a field's kind, or any, for what can't be known before the flow runs. */
type ValueKind = FieldInfo['kind'] | 'null' | 'any';

/** What a variable holds: a value, a record, a list of records, or a line of a record. */
export type VarKind =
  | { readonly kind: 'value'; readonly value: ValueKind }
  | { readonly kind: 'record'; readonly entity: string }
  | { readonly kind: 'list'; readonly entity: string }
  | { readonly kind: 'line'; readonly entity: string };

/** Names that a flow's variables can't take: the record of a find, and the person, keep theirs. */
export const RESERVED_VARIABLES: readonly string[] = ['record', 'principal'];

const KIND_WORDS: Readonly<Record<ValueKind, string>> = {
  text: 'text',
  uuid: 'an ID of a person or a record',
  number: 'a number',
  boolean: 'yes or no',
  date: 'a date',
  datetime: 'a time',
  'text[]': 'a list of options',
  null: 'nothing',
  any: 'any value',
};

const value = (kind: ValueKind): VarKind => ({ kind: 'value', value: kind });

/** A flow type as a variable's kind. */
export function kindOfType(type: FlowType): VarKind {
  return type.type === 'record' || type.type === 'list' ? { kind: type.type, entity: type.entity } : value(type.type);
}

function describeKind(kind: VarKind): string {
  switch (kind.kind) {
    case 'value':
      return KIND_WORDS[kind.value];
    case 'record':
      return `a record of ${kind.entity}`;
    case 'list':
      return `a list of ${kind.entity}`;
    case 'line':
      return `a line of ${kind.entity}`;
  }
}

const sameKind = (a: VarKind, b: VarKind): boolean =>
  a.kind === b.kind && (a.kind === 'value' ? (a.value === 'any' || (b as typeof a).value === 'any' || (b as typeof a).value === 'null' || a.value === (b as typeof a).value) : a.entity === (b as typeof a).entity);

/** The steps of a list, and of every list inside it, with where each is. */
export function flowSteps(steps: readonly FlowStep[], base = 'steps'): Array<{ readonly step: FlowStep; readonly path: string }> {
  return steps.flatMap((step, index) => {
    const at = `${base}[${index}]`;
    return [{ step, path: at }, ...innerLists(step, at).flatMap((list) => flowSteps(list.steps, list.path))];
  });
}

type Scope = Map<string, VarKind>;

/** What walking a flow needs of the definition: its entities' fields and its flows. Saved or not. */
interface FlowLookup {
  readonly entities: Readonly<Record<string, { readonly label: string; readonly fields: readonly Field[] }>>;
  readonly flows?: Readonly<Record<string, AppFlow>> | undefined;
}

const SYSTEM_KINDS: Readonly<Record<string, ValueKind>> = { id: 'uuid', version: 'number', owner: 'uuid', created_at: 'datetime', created_by: 'uuid', updated_at: 'datetime', updated_by: 'uuid' };

/** The kind of a field of a record, or of a line, which has only its ID besides its own fields. */
function fieldKindIn(entity: { readonly fields: readonly Field[] }, name: string, line: boolean): ValueKind | undefined {
  if (line ? name === 'id' : Object.hasOwn(SYSTEM_KINDS, name)) return SYSTEM_KINDS[name];
  const field = entity.fields.find((f) => f.name === name);
  return field && field.type !== 'lines' ? fieldKind(field) : undefined;
}

/**
 * Walk a flow's steps with the kinds of its variables, as each step sees them. Each list of steps
 * is a block: a variable it gives a value first lives until the block ends. In a flow that waits,
 * a step that waits, or decides between ways that do, sees only the flow's input, and so do the
 * steps after it: `gone` names the variables that went with the wait.
 */
function walk(
  definition: FlowLookup,
  flow: AppFlow,
  visit: (step: FlowStep, scope: Scope, path: string, depth: number, gone: ReadonlySet<string>) => void,
  declare: (scope: Scope, name: string, kind: VarKind, path: string) => void = (scope, name, kind) => void scope.set(name, kind),
  /** For renames: the name a lines field has now, given the name a step uses. */
  linesName: (entity: string, name: string) => string = (_, name) => name,
): void {
  const flows = definition.flows ?? {};
  const listItem = (of: string, scope: Scope): VarKind | undefined => {
    const [root, lines] = of.split('.') as [string, string | undefined];
    const holder = scope.get(root);
    if (!lines) return holder?.kind === 'list' ? { kind: 'record', entity: holder.entity } : undefined;
    if (holder?.kind !== 'record') return undefined;
    const field = definition.entities[holder.entity]?.fields.find((f) => f.name === linesName(holder.entity, lines));
    return field?.type === 'lines' ? { kind: 'line', entity: field.entity } : undefined;
  };
  const inputs: Scope = new Map(Object.entries(flow.input).map(([name, type]) => [name, kindOfType(type)]));
  const waits = flowWaits(flow, flows);
  const block = (steps: readonly FlowStep[], outer: Scope, outerGone: ReadonlySet<string>, base: string, depth: number): void => {
    const scope = new Map(outer);
    let gone = outerGone;
    steps.forEach((step, index) => {
      const at = `${base}[${index}]`;
      // A loop or an error handler that waits is refused, and checked as it stands.
      const point = waits && step.type !== 'each' && step.type !== 'try' && atProcessLevel(step, flows);
      if (point) gone = new Set([...gone, ...[...scope.keys()].filter((name) => !inputs.has(name))]);
      const here = point ? new Map(inputs) : scope;
      visit(step, here, at, depth, gone);
      const inner = (steps: readonly FlowStep[], path: string, from: Scope = here) => block(steps, from, gone, path, depth + 1);
      switch (step.type) {
        case 'set': {
          const known = here.get(step.var);
          if (!known) declare(here, step.var, value(step.value === null ? 'any' : expressionKind(definition, step.value, here)), at);
          break;
        }
        case 'find':
          declare(here, step.var, { kind: step.first ? 'record' : 'list', entity: step.entity }, at);
          break;
        case 'create':
          if (step.var) declare(here, step.var, { kind: 'record', entity: step.entity }, at);
          break;
        case 'call': {
          const output = flows[step.flow]?.output;
          if (step.var && output) declare(here, step.var, kindOfType(output), at);
          break;
        }
        case 'total':
          declare(here, step.var, value('number'), at);
          break;
        case 'call_service':
          for (const [name, result] of Object.entries(step.results)) declare(here, name, value(result.type), at);
          break;
        case 'each': {
          const loop = new Map(here);
          const item = listItem(step.in, here);
          if (item) declare(loop, step.as, item, at);
          inner(step.steps, `${at}.steps`, loop);
          break;
        }
        case 'try': {
          inner(step.steps, `${at}.steps`);
          const handler = new Map(here);
          if (step.error) declare(handler, step.error, value('text'), at);
          inner(step.catch, `${at}.catch`, handler);
          break;
        }
        default:
          // Branches, a task's outcomes and its deadline, and ways: each starts from what the step sees.
          for (const list of innerLists(step, at)) inner(list.steps, list.path);
      }
      if (point) {
        scope.clear();
        for (const [name, kind] of inputs) scope.set(name, kind);
      }
    });
  };
  block(flow.steps, inputs, new Set(), 'steps', 1);
}

/** The kind of value an expression gives, with the variables in scope. Unknown references give any. */
function expressionKind(definition: FlowLookup, expression: Expression, scope: Scope): ValueKind {
  if (expression === null) return 'null';
  if (typeof expression === 'string') return 'text';
  if (typeof expression === 'number') return 'number';
  if (typeof expression === 'boolean') return 'boolean';
  if (Array.isArray(expression)) return 'text[]';
  if (typeof expression !== 'object') return 'any';
  if ('ref' in expression) {
    const resolved = refKind(definition, expression.ref, scope);
    if (!resolved.ok) return 'any';
    return resolved.kind.kind === 'value' ? resolved.kind.value : resolved.kind.kind === 'record' ? 'uuid' : 'any';
  }
  if ('today' in expression) return 'date';
  if ('now' in expression) return 'datetime';
  const op = operatorOf(expression);
  return op ? calculationKind(op, operandsOf(expression).map((operand) => expressionKind(definition, operand, scope))).kind : 'any';
}

type Resolved = { readonly ok: true; readonly kind: VarKind } | { readonly ok: false; readonly message: string };

/**
 * What a reference names, with the variables in scope: `principal.id`, a variable, or a field of a
 * record or line variable. `record.<field>` is a find's own and is checked there.
 */
function refKind(definition: FlowLookup, ref: string, scope: Scope): Resolved {
  const [root, ...path] = ref.split('.') as [string, ...string[]];
  if (root === 'principal') return path.length === 1 ? { ok: true, kind: value(path[0] === 'id' ? 'uuid' : 'any') } : { ok: false, message: `${ref}: name a property, for example principal.id` };
  if (root === 'record') return { ok: false, message: `${ref}: a flow names records by its variables. record.<field> is for a find's condition` };
  const held = scope.get(root);
  if (!held) return { ok: false, message: `${ref}: no variable ${root} here` };
  if (!path.length) return { ok: true, kind: held };
  if (held.kind === 'value') return { ok: false, message: `${ref}: ${root} holds ${KIND_WORDS[held.value]}, which has no fields` };
  if (held.kind === 'list') return { ok: false, message: `${ref}: ${root} is a list. Loop over it with an each step, or count it with a total step` };
  if (path.length > 1) return { ok: false, message: `${ref}: refer to a field as ${root}.<field>` };
  const entity = definition.entities[held.entity];
  if (!entity) return { ok: false, message: `${ref}: no entity ${held.entity}` };
  const kind = fieldKindIn(entity, path[0]!, held.kind === 'line');
  if (kind) return { ok: true, kind: value(kind) };
  const lines = entity.fields.some((f) => f.name === path[0] && f.type === 'lines');
  return { ok: false, message: lines ? `${ref}: a lines field. Loop over it with an each step, or total it` : `${ref}: ${entity.label} has no field ${path[0]}` };
}

/**
 * The variables each step of a flow sees, by the step's path (`steps[2]`, `steps[0].then[1]`),
 * with what each holds: for a designer that offers only what is there.
 */
export function flowScopes(definition: FlowLookup, flow: AppFlow): Map<string, ReadonlyMap<string, VarKind>> {
  const scopes = new Map<string, ReadonlyMap<string, VarKind>>();
  walk(definition, flow, (_step, scope, path) => void scopes.set(path, new Map(scope)));
  return scopes;
}

/** The variables after the last step of a list of steps: for a step added at its end. */
export function flowScopeAfter(definition: FlowLookup, flow: AppFlow, listPath: string): ReadonlyMap<string, VarKind> {
  // Walk a copy of the flow with a placeholder at the end of the list, and read its scope.
  const marker: FlowStep = { type: 'return' };
  const insert = (steps: readonly FlowStep[], base: string): FlowStep[] => {
    const out = steps.map((step, index) => withLists(step, `${base}[${index}]`, insert));
    return base === listPath ? [...out, marker] : out;
  };
  const steps = insert(flow.steps, 'steps');
  let found: ReadonlyMap<string, VarKind> = new Map();
  walk(definition, { ...flow, steps }, (step, scope) => {
    if (step === marker) found = new Map(scope);
  });
  return found;
}

/** Check a flow before it is saved: its variables, what each step names, and that values fit. */
function checkFlow(definition: StoredDefinition, name: string, flow: AppFlow, issues: Issue[]): void {
  const base = `flows.${name}`;
  const owners = lineOwners(definition);
  const flows = definition.flows ?? {};
  const issue = (path: string, message: string) => issues.push({ path: `${base}.${path}`, message });

  // A flow that waits keeps its place on one record, and runs on the process engine with no person.
  const waits = flowWaits(flow, flows);
  const subject = flowSubject(flow);
  if (waits) {
    if (!subject) issue('input', 'A flow that waits keeps its place on one record: give it one input, a record of what it is about');
    if (flow.output) issue('output', 'A flow that waits gives no result: what it does shows on its record');
    // The engine can't keep a place inside a loop over a list or an error handler yet; a repeat can.
    const ending = new Set<string>();
    for (const { step, path } of flowSteps(flow.steps)) {
      if (step.type !== 'each' && step.type !== 'try' && step.type !== 'repeat') continue;
      const lists = innerLists(step, path);
      if (step.type !== 'repeat' && lists.some((list) => list.steps.some((inner) => stepWaits(inner, flows)))) {
        issue(path, step.type === 'each' ? "A loop over a list can't hold steps that wait yet: move them out of it, or repeat them while a condition holds" : "An error handler can't hold steps that wait yet: move them out of it");
      }
      for (const list of lists) for (const found of flowSteps(list.steps, list.path)) if (found.step.type === 'return') ending.add(found.path);
    }
    for (const path of ending) issue(path, 'A flow that waits ends outside its loops and error handlers: move this step out');
  }
  // A reminder runs beside its task, which still waits: it neither waits nor ends the flow.
  for (const { step, path } of flowSteps(flow.steps)) {
    if (step.type !== 'task') continue;
    (step.reminders ?? []).forEach((reminder, index) => {
      const at = `${path}.reminders[${index}]`;
      if (!reminder.steps.length) issue(`${at}.steps`, 'Say what the reminder does: give it a step');
      for (const found of flowSteps(reminder.steps, `${at}.steps`)) {
        const own = found.step.type;
        if (own === 'return') issue(found.path, "A reminder can't end the flow: give the task a deadline for that");
        else if (own === 'task' || own === 'wait' || own === 'first_of' || own === 'all_at_once' || (own === 'call' && stepWaits(found.step, flows))) {
          issue(found.path, "A reminder runs in one go, while its task waits: it can't wait itself");
        }
      }
    });
  }
  /** The variables that went when the flow last waited, as the step being checked sees them. */
  let gone: ReadonlySet<string> = new Set();
  const lost = (name: string, ref = name) => `${ref}: ${name} doesn't live on after the flow waits. Keep the value in a field of the record, and read it from there`;
  const noVariable = (name: string) => (gone.has(name) ? lost(name) : `No variable ${name} here`);
  /** What a reference names. In a flow that waits there is no person, and a variable doesn't live on across a wait. */
  const resolve = (ref: string, scope: Scope): Resolved => {
    const root = ref.split('.')[0]!;
    if (waits && root === 'principal') return { ok: false, message: `${ref}: a flow that waits runs with no person` };
    if (!scope.has(root) && gone.has(root)) return { ok: false, message: lost(root, ref) };
    return refKind(definition, ref, scope);
  };

  /** An entity a flow can work with: one of the app's, and not lines, which belong to their record. */
  const entityIssue = (entity: string): string | null => {
    if (!definition.entities[entity]) return `No entity named ${entity}`;
    const owner = owners.get(entity);
    return owner ? `${entity} holds the lines of ${owner.parent}: work with them through ${owner.parent}` : null;
  };
  const typeIssue = (type: FlowType, at: string) => {
    if (type.type !== 'record' && type.type !== 'list') return;
    const problem = entityIssue(type.entity);
    if (problem) issue(`${at}.entity`, problem);
  };
  for (const [input, type] of Object.entries(flow.input)) {
    if (RESERVED_VARIABLES.includes(input)) issue(`input.${input}`, `${input} is a name the platform keeps: choose another`);
    typeIssue(type, `input.${input}`);
  }
  if (flow.output) typeIssue(flow.output, 'output');

  const kindAt = (expression: Expression, scope: Scope, at: string): ValueKind => {
    if (expression === null || typeof expression !== 'object' || Array.isArray(expression)) return expressionKind(definition, expression, scope);
    if ('ref' in expression) {
      const resolved = resolve(expression.ref, scope);
      if (!resolved.ok) {
        issue(at, resolved.message);
        return 'any';
      }
      if (resolved.kind.kind === 'list') issue(at, `${expression.ref} is a list, not a value. Count it with a total step`);
      if (resolved.kind.kind === 'line') issue(at, `${expression.ref} is a line, not a value: use one of its fields`);
      return resolved.kind.kind === 'value' ? resolved.kind.value : resolved.kind.kind === 'record' ? 'uuid' : 'any';
    }
    if ('today' in expression) return 'date';
    if ('now' in expression) return 'datetime';
    const op = operatorOf(expression);
    if (!op) return 'any';
    if (op === 'if') condition((expression as { if: readonly [Condition, Expression, Expression] }).if[0], scope, at);
    const worked = calculationKind(op, operandsOf(expression).map((operand) => kindAt(operand, scope, at)));
    for (const message of worked.problems) issue(at, message);
    return worked.kind;
  };

  /** A value fits the field it goes into. Literals are checked as the field would check them. */
  const fits = (info: FieldInfo, expression: Expression, scope: Scope, at: string) => {
    const label = info.field?.label ?? info.name;
    const kind = kindAt(expression, scope, at);
    if (expression === null) {
      if (info.field?.required) issue(at, `${label} is required, so a flow can't empty it`);
      return;
    }
    if (typeof expression !== 'object' || Array.isArray(expression)) {
      const literal = info.field?.type === 'number' && typeof expression === 'number' ? roundTo(expression, info.field.decimals) : expression;
      const result = canonicalValue(info, literal);
      if (!result.ok) issue(at, `${label}: ${result.issue.message}`);
      return;
    }
    if (!(kind === 'any' || kind === 'null' || kind === info.kind || (info.kind === 'date' && kind === 'datetime'))) {
      issue(at, `${label} holds ${KIND_WORDS[info.kind]}, and this gives ${KIND_WORDS[kind]}`);
    }
  };

  /** Values for a record's fields: each field can be written by a flow, and each value fits it. */
  const values = (entity: string, given: Readonly<Record<string, Expression>>, scope: Scope, at: string, line = false) => {
    const known = definition.entities[entity];
    if (!known) return;
    const fields = entityFields(known, { line });
    for (const [field, expression] of Object.entries(given)) {
      const info = fields.get(field);
      const where = `${at}.${field}`;
      if (!info) issue(where, known.fields.some((f) => f.name === field && f.type === 'lines') ? `${field} holds lines: add one with an add_line step` : `${known.label} has no field ${field}`);
      else if (line && info.system) issue(where, `${field} is set by the platform`);
      else if (!isWritable(info)) issue(where, info.system ? `${field} is set by the platform` : `${field} is worked out from lines`);
      else if (info.field?.type === 'file') issue(where, "A flow can't set a file");
      else fits(info, expression, scope, where);
    }
  };
  const required = (entity: string, given: Readonly<Record<string, Expression>>, at: string, what: string) => {
    for (const field of definition.entities[entity]?.fields ?? []) {
      if (field.type === 'lines' || !field.required) continue;
      const defaulted = 'default' in field && field.default !== undefined;
      const rollup = field.type === 'number' && field.rollup;
      if (!(field.name in given) && !defaulted && !rollup) issue(at, `${what} needs ${field.label}: give it a value`);
    }
  };

  /** A condition: its references are variables, `principal.id`, and in a find, `record.<field>` of what it looks at. */
  const condition = (c: Condition, scope: Scope, at: string, find?: ReadonlyMap<string, FieldInfo>) => {
    const kindOfOperand = (operand: Operand): ValueKind | undefined => {
      if (!isRef(operand)) return undefined;
      const [root, field, ...rest] = operand.ref.split('.');
      if (root === 'record' && find) {
        const info = field && !rest.length ? find.get(field) : undefined;
        return info?.kind;
      }
      const resolved = resolve(operand.ref, scope);
      return resolved.ok && resolved.kind.kind === 'value' ? resolved.kind.value : undefined;
    };
    for (const ref of conditionRefs(c)) {
      const [root, field, ...rest] = ref.split('.');
      if (root === 'record' && find) {
        if (!field || rest.length) issue(at, `${ref}: refer to a field as record.<field>`);
        else if (!find.has(field)) issue(at, `${ref}: no such field`);
        continue;
      }
      const resolved = resolve(ref, scope);
      if (!resolved.ok) issue(at, resolved.message);
      else if (resolved.kind.kind === 'record') issue(at, `${ref} is a record: compare its ID, as ${ref}.id`);
      else if (resolved.kind.kind !== 'value') issue(at, `${ref} is ${describeKind(resolved.kind)}, not a value`);
    }
    const visit = (inner: Condition): void => {
      if ('all' in inner) return inner.all.forEach(visit);
      if ('any' in inner) return inner.any.forEach(visit);
      if ('not' in inner) return visit(inner.not);
      if ('exists' in inner || 'in' in inner) return;
      const op = (['eq', 'ne', ...COMPARISON_OPERATORS] as const).find((key) => key in inner)!;
      if (op === 'eq' || op === 'ne') return;
      const [left, right] = (inner as Record<string, readonly [Operand, Operand]>)[op]!;
      // Numbers compare with numbers, and dates and times with each other.
      const order = (operand: Operand): 'number' | 'time' | 'other' | undefined => {
        if (isRelativeTime(operand)) return 'time';
        const kind = isRef(operand) ? kindOfOperand(operand) : typeof operand === 'number' ? 'number' : timeOf(operand) !== undefined ? 'date' : 'text';
        if (kind === undefined || kind === 'any' || kind === 'null') return undefined;
        return !isOrderedKind(kind) ? 'other' : kind === 'number' ? 'number' : 'time';
      };
      const [a, b] = [order(left), order(right)];
      const words = (operand: Operand) => (isRef(operand) ? operand.ref : JSON.stringify(operand));
      for (const [operand, side] of [[left, a], [right, b]] as const) {
        if (side === 'other') issue(at, `${op} compares numbers, dates and times, and ${words(operand)} is none of them`);
      }
      if (a && b && a !== 'other' && b !== 'other' && a !== b) issue(at, `${op} compares a number with a number, or a date or a time with a date or a time: not ${words(left)} with ${words(right)}`);
    };
    visit(c);
  };

  /** The field of a record or a line that a reference names, as `leave.manager`. */
  const fieldOf = (ref: string, scope: Scope): Field | undefined => {
    const [root, name, ...rest] = ref.split('.');
    const held = root ? scope.get(root) : undefined;
    if (!name || rest.length || !held || (held.kind !== 'record' && held.kind !== 'line')) return undefined;
    return definition.entities[held.entity]?.fields.find((f) => f.name === name);
  };
  /** A value that names a person: the person running the flow, a user field of a record, or who owns, created or last changed it. */
  const isPerson = (expression: Expression, scope: Scope): boolean => {
    if (expression === null || typeof expression !== 'object' || Array.isArray(expression) || !('ref' in expression)) return false;
    const [root, name, ...rest] = expression.ref.split('.');
    if (expression.ref === 'principal.id') return true;
    if (!rest.length && scope.get(root ?? '')?.kind === 'record' && ['owner', 'created_by', 'updated_by'].includes(name ?? '')) return true;
    return fieldOf(expression.ref, scope)?.type === 'user';
  };

  /** A list to loop over or total: a list variable, or a lines field of a record variable. */
  const listOf = (of: string, scope: Scope, at: string): { readonly kind: 'record' | 'line'; readonly entity: string } | undefined => {
    const [root, lines] = of.split('.') as [string, string | undefined];
    const holder = scope.get(root);
    if (!holder) {
      issue(at, noVariable(root));
      return undefined;
    }
    if (!lines) {
      if (holder.kind === 'list') return { kind: 'record', entity: holder.entity };
      issue(at, `${root} holds ${describeKind(holder)}, not a list`);
      return undefined;
    }
    if (holder.kind !== 'record') {
      issue(at, `${root} holds ${describeKind(holder)}: only a record has lines`);
      return undefined;
    }
    const field = definition.entities[holder.entity]?.fields.find((f) => f.name === lines);
    if (field?.type === 'lines') return { kind: 'line', entity: field.entity };
    issue(at, `${lines} isn't a lines field of ${holder.entity}`);
    return undefined;
  };

  /** A variable that holds a record, for a step that changes it. */
  const recordVar = (name: string, scope: Scope, at: string): string | undefined => {
    const held = scope.get(name);
    if (held?.kind === 'record') return held.entity;
    issue(at, held ? `${name} holds ${describeKind(held)}, not a record` : noVariable(name));
    return undefined;
  };

  /** A value for an input or the result: a value fits its type; a record or a list is a variable that holds one. */
  const typed = (type: FlowType, expression: Expression | undefined, scope: Scope, at: string) => {
    if (expression === undefined) return;
    const wanted = kindOfType(type);
    if (wanted.kind !== 'value') {
      const named = expression !== null && typeof expression === 'object' && !Array.isArray(expression) && 'ref' in expression && !expression.ref.includes('.') ? scope.get(expression.ref) : undefined;
      if (!named || !sameKind(wanted, named)) {
        const ref = expression !== null && typeof expression === 'object' && !Array.isArray(expression) && 'ref' in expression ? expression.ref : undefined;
        issue(at, !named && ref && gone.has(ref) ? lost(ref) : `Give ${describeKind(wanted)}: a variable that holds one`);
      }
      return;
    }
    const kind = kindAt(expression, scope, at);
    if (!(kind === 'any' || kind === 'null' || kind === wanted.value || (wanted.value === 'date' && kind === 'datetime'))) issue(at, `This gives ${KIND_WORDS[kind]}, not ${KIND_WORDS[wanted.value]}`);
  };

  // A flow that waits starts by itself on its record; a flow that needs no input, on a schedule.
  const inputs: Scope = new Map(Object.entries(flow.input).map(([input, type]) => [input, kindOfType(type)]));
  (flow.starts ?? []).forEach((start, index) => {
    const at = `starts[${index}]`;
    // The engine checks the date fields of the record, as it does for a wait.
    if (!waits) issue(at, 'Only a flow that waits starts by itself on a record. Run a flow that runs in one go from an action, or on a schedule');
    else if ('condition' in start) condition(start.condition, inputs, `${at}.condition`);
  });
  if (flow.schedule) {
    if (waits) issue('schedule', 'A flow that waits keeps its place on one record, so it starts on records, not on a schedule: say how in its starts');
    else if (Object.keys(flow.input).length) issue('schedule', 'A flow on a schedule runs with nobody to give it input: give it no input, and find the records it works on');
    for (const problem of scheduleIssues(flow.schedule)) issue(`schedule${problem.path}`, problem.message);
  }

  let count = 0;
  walk(
    definition,
    flow,
    (step, scope, at, depth, goneHere) => {
      gone = goneHere;
      count++;
      if (depth > MAX_FLOW_DEPTH) issue(at, `Steps go ${MAX_FLOW_DEPTH} levels deep at most: move some into a flow of their own, and call it`);
      switch (step.type) {
        case 'set':
          kindAt(step.value, scope, `${at}.value`);
          return;
        case 'find': {
          const problem = entityIssue(step.entity);
          if (problem) return issue(`${at}.entity`, problem);
          const fields = entityFields(definition.entities[step.entity]!);
          if (step.where) condition(step.where, scope, `${at}.where`, fields);
          for (const [i, sort] of (step.sort ?? []).entries()) {
            const info = fields.get(sort.field);
            if (!info) issue(`${at}.sort[${i}].field`, `No field named ${sort.field}`);
            else if (!isSortableKind(info.kind)) issue(`${at}.sort[${i}].field`, `${sort.field} can't be sorted on`);
          }
          return;
        }
        case 'create': {
          const problem = entityIssue(step.entity);
          if (problem) return issue(`${at}.entity`, problem);
          values(step.entity, step.values, scope, `${at}.values`);
          required(step.entity, step.values, `${at}.values`, `A new ${definition.entities[step.entity]!.label}`);
          return;
        }
        case 'change': {
          const entity = recordVar(step.record, scope, `${at}.record`);
          if (entity) values(entity, step.values, scope, `${at}.values`);
          if (!Object.keys(step.values).length) issue(`${at}.values`, 'Say what changes');
          return;
        }
        case 'delete':
          recordVar(step.record, scope, `${at}.record`);
          return;
        case 'add_line': {
          const entity = recordVar(step.record, scope, `${at}.record`);
          if (!entity) return;
          const field = definition.entities[entity]!.fields.find((f) => f.name === step.field);
          if (field?.type !== 'lines') return issue(`${at}.field`, `${step.field} isn't a lines field of ${entity}`);
          values(field.entity, step.values, scope, `${at}.values`, true);
          required(field.entity, step.values, `${at}.values`, 'Each line');
          return;
        }
        case 'each':
          listOf(step.in, scope, `${at}.in`);
          if (scope.has(step.as) || RESERVED_VARIABLES.includes(step.as)) issue(`${at}.as`, `${step.as} is taken here: choose another name`);
          if (!step.steps.length) issue(`${at}.steps`, 'A loop needs a step');
          return;
        case 'if':
          condition(step.when, scope, `${at}.when`);
          if (!step.then.length && !step.else.length) issue(at, 'A branch needs at least one step');
          return;
        case 'repeat':
          condition(step.while, scope, `${at}.while`);
          if (!step.steps.length) issue(`${at}.steps`, 'A loop needs a step');
          return;
        case 'call_service': {
          const connection = definition.connections?.[step.connection];
          if (!connection) issue(`${at}.connection`, `No connection named ${step.connection}`);
          else if (connection.kind !== 'service') issue(`${at}.connection`, `${connection.label} is a Teams channel: a notice posts to it, with an inform step`);
          kindAt(step.path, scope, `${at}.path`);
          for (const [name, expression] of Object.entries(step.query)) kindAt(expression, scope, `${at}.query.${name}`);
          for (const [name, expression] of Object.entries(step.body ?? {})) kindAt(expression, scope, `${at}.body.${name}`);
          if (step.body && step.method === 'GET') issue(`${at}.body`, 'A GET sends nothing: send values with POST, PUT or PATCH, or as the query');
          // Personal data leaves the app only for a service that says it takes it, as a reviewer sees.
          if (connection?.kind === 'service' && !connection.personalData) {
            const parts: Array<readonly [string, Expression]> = [['path', step.path], ...Object.entries(step.query).map(([name, e]) => [`query.${name}`, e] as const), ...Object.entries(step.body ?? {}).map(([name, e]) => [`body.${name}`, e] as const)];
            for (const [part, expression] of parts) {
              for (const ref of expressionRefs(expression)) {
                if (fieldOf(ref, scope)?.classification === 'pii') issue(`${at}.${part}`, `${ref} is personal data, and ${connection.label} doesn't take it. Leave it out, or say on the connection that it takes personal data`);
              }
            }
          }
          return;
        }
        case 'inform': {
          if (step.teams !== undefined) {
            const channel = definition.connections?.[step.teams];
            if (!channel) issue(`${at}.teams`, `No connection named ${step.teams}`);
            else if (channel.kind !== 'teams') issue(`${at}.teams`, `${channel.label} isn't a Teams channel`);
          }
          step.to.forEach((recipient, index) => {
            const where = `${at}.to[${index}]`;
            if ('role' in recipient) {
              if (!definition.roles[recipient.role]) issue(`${where}.role`, `No role named ${recipient.role}`);
              return;
            }
            const before = issues.length;
            kindAt(recipient.person, scope, `${where}.person`);
            if (issues.length > before) return;
            if (!isPerson(recipient.person, scope)) issue(`${where}.person`, 'Name a person: a user field of a record, such as leave.manager, or the person running the flow');
          });
          kindAt(step.title, scope, `${at}.title`);
          if (step.message !== undefined) kindAt(step.message, scope, `${at}.message`);
          if (step.about) recordVar(step.about, scope, `${at}.about`);
          // Email and Teams leave the app: personal data stays in its notices in the app.
          if (step.email || step.teams !== undefined) {
            const how = step.email ? 'email' : 'Teams';
            for (const [part, expression] of [['title', step.title], ['message', step.message]] as const) {
              for (const ref of expression === undefined ? [] : expressionRefs(expression)) {
                if (fieldOf(ref, scope)?.classification === 'pii') issue(`${at}.${part}`, `${ref} is personal data, and ${how} takes it out of the app: leave it out, or tell people in the app only`);
              }
            }
          }
          return;
        }
        case 'check':
          condition(step.assert, scope, `${at}.assert`);
          return;
        case 'call': {
          const callee = flows[step.flow];
          if (!callee) return issue(`${at}.flow`, `No flow named ${step.flow}`);
          const theirs = flowSubject(callee);
          if (flowWaits(callee, flows) && theirs && subject && theirs.entity !== subject.entity) {
            issue(`${at}.flow`, `${callee.label} waits, and is about ${theirs.entity}: a flow that waits runs it on its own record only`);
          }
          for (const [input, type] of Object.entries(callee.input)) {
            if (!(input in step.input)) issue(`${at}.input`, `${callee.label} needs ${input}`);
            else typed(type, step.input[input], scope, `${at}.input.${input}`);
          }
          for (const input of Object.keys(step.input)) if (!(input in callee.input)) issue(`${at}.input.${input}`, `${callee.label} takes no ${input}`);
          if (step.var && !callee.output) issue(`${at}.var`, `${callee.label} gives no result to keep`);
          return;
        }
        case 'try':
          // The designer adds a handler with nothing in it yet: say what it needs, in words.
          if (!step.steps.length) issue(`${at}.steps`, 'Put the steps that the handler guards inside it');
          return;
        case 'total': {
          const item = listOf(step.of, scope, `${at}.of`);
          if (step.op === 'count') {
            if (step.field) issue(`${at}.field`, 'A count needs no field');
            return;
          }
          if (!step.field) return issue(`${at}.field`, `Say which number field to ${step.op === 'sum' ? 'total' : step.op === 'avg' ? 'average' : step.op}`);
          if (!item) return;
          const entity = definition.entities[item.entity];
          const info = entity ? entityFields(entity, { line: item.kind === 'line' }).get(step.field) : undefined;
          if (info?.kind !== 'number') issue(`${at}.field`, `${step.field} isn't a number field of ${item.entity}`);
          return;
        }
        case 'return':
          if (!flow.output) {
            if (step.value !== undefined) issue(`${at}.value`, `${flow.label} gives no result: leave the value out, or give the flow a result`);
          } else if (step.value === undefined) issue(`${at}.value`, `${flow.label} gives ${describeKind(kindOfType(flow.output))}: say which`);
          else typed(flow.output, step.value, scope, `${at}.value`);
          return;
        case 'task': {
          const names = step.outcomes.map((outcome) => outcome.name);
          names.forEach((name, index) => {
            if (names.indexOf(name) !== index) issue(`${at}.outcomes[${index}].name`, `Another outcome is named ${name}: give each its own name`);
          });
          return;
        }
        case 'wait':
          if ('condition' in step.for) condition(step.for.condition, scope, `${at}.for.condition`);
          return;
        case 'first_of':
          if (step.ways.length < 2) issue(`${at}.ways`, 'Give two ways or more: the first of them to happen goes on');
          step.ways.forEach((way, index) => {
            if ('condition' in way.for) condition(way.for.condition, scope, `${at}.ways[${index}].for.condition`);
          });
          return;
        case 'all_at_once':
          if (step.ways.length < 2) issue(`${at}.ways`, 'Give two ways or more: they run at once');
          step.ways.forEach((way, index) => {
            if (!way.steps.length) issue(`${at}.ways[${index}].steps`, 'Put a step in this way');
          });
          return;
      }
    },
    (scope, variable, kind, at) => {
      if (RESERVED_VARIABLES.includes(variable)) issue(at, `${variable} is a name the platform keeps: choose another`);
      const held = scope.get(variable);
      if (held && !sameKind(held, kind)) issue(at, `${variable} holds ${describeKind(held)} here, not ${describeKind(kind)}`);
      scope.set(variable, held ?? kind);
    },
  );
  if (count > MAX_FLOW_STEPS) issue('steps', `A flow has ${MAX_FLOW_STEPS} steps at most: move some into a flow of their own`);
  if (!flow.steps.length) issue('steps', 'A flow needs a step');
}

/** Check every flow, the flows that call each other, and the roles and actions that name flows. */
export function checkFlows(definition: StoredDefinition, issues: Issue[]): void {
  const flows = definition.flows ?? {};
  for (const [name, flow] of Object.entries(flows)) checkFlow(definition, name, flow, issues);

  // A flow never calls itself, however far round: a loop of calls would never end.
  const calls = new Map(Object.entries(flows).map(([name, flow]) => [name, [...new Set(flowSteps(flow.steps).flatMap(({ step }) => (step.type === 'call' ? [step.flow] : [])))]]));
  const reported = new Set<string>();
  const visit = (name: string, trail: readonly string[]): void => {
    if (trail.includes(name)) {
      const cycle = [...trail.slice(trail.indexOf(name)), name];
      // The same loop, whichever flow it is seen from, is reported once.
      const key = [...new Set(cycle)].sort().join(' ');
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({ path: `flows.${name}`, message: `Flows call each other in a loop: ${cycle.join(' → ')}` });
      }
      return;
    }
    for (const next of calls.get(name) ?? []) if (flows[next]) visit(next, [...trail, name]);
  };
  for (const name of Object.keys(flows)) visit(name, []);

  // Connections hold no secret: each environment keeps its own, which the platform adds to each call.
  for (const [name, connection] of Object.entries(definition.connections ?? {})) {
    if (connection.kind !== 'service') continue;
    const at = `connections.${name}.url`;
    let url: URL | undefined;
    try {
      url = new URL(connection.url);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) issues.push({ path: at, message: 'Give the address as https://, such as https://api.example.com/v1' });
    else if (url.username || url.password) issues.push({ path: at, message: "Keep secrets out of the address: each environment keeps the connection's secret" });
    else if (url.search || url.hash) issues.push({ path: at, message: 'End the address before any query: each step adds its own' });
  }
  // A webhook runs a flow in one go, with input from places in the request.
  for (const [name, hook] of Object.entries(definition.webhooks ?? {})) {
    const at = `webhooks.${name}`;
    const flow = flows[hook.flow];
    if (!flow) {
      issues.push({ path: `${at}.flow`, message: `No flow named ${hook.flow}` });
      continue;
    }
    if (flowWaits(flow, flows)) {
      issues.push({ path: `${at}.flow`, message: `${flow.label} waits for people or for time: a webhook runs a flow that runs in one go` });
      continue;
    }
    for (const input of Object.keys(flow.input)) if (!(input in hook.input)) issues.push({ path: `${at}.input`, message: `${flow.label} needs ${input}: say where in the request it is` });
    for (const [input, place] of Object.entries(hook.input)) {
      if (!(input in flow.input)) issues.push({ path: `${at}.input.${input}`, message: `${flow.label} takes no ${input}` });
      else if (!place || !JSON_PATH.test(place)) issues.push({ path: `${at}.input.${input}`, message: 'Name a place in the request, such as order.id' });
      else if (flow.input[input]!.type === 'list') issues.push({ path: `${at}.input.${input}`, message: `${input} is a list, which a webhook can't give` });
    }
  }

  for (const [role, spec] of Object.entries(definition.roles)) {
    (spec.flows ?? []).forEach((flow, index) => {
      if (!flows[flow]) issues.push({ path: `roles.${role}.flows[${index}]`, message: `No flow named ${flow}` });
    });
  }
  for (const [name, action] of Object.entries(definition.actions)) {
    if (action.flow) checkFlowRun(definition, action.flow, { entity: action.entity, person: true }, `actions.${name}.flow`, issues);
  }
}

/**
 * Check what an action or a service task gives the flow it runs: each of its inputs, worked out
 * from the record (`record.<field>`, or `record` itself for a record input) and, where a person
 * runs it, `principal.id`.
 */
export function checkFlowRun(definition: StoredDefinition, run: FlowRun, from: { readonly entity: string; readonly person: boolean }, path: string, issues: Issue[]): void {
  const flow = definition.flows?.[run.flow];
  if (!flow) {
    issues.push({ path: `${path}.flow`, message: `No flow named ${run.flow}` });
    return;
  }
  const entity = definition.entities[from.entity];
  const fields = entity ? entityFields(entity) : new Map<string, FieldInfo>();
  for (const [input, type] of Object.entries(flow.input)) {
    const at = `${path}.input.${input}`;
    const given = run.input[input];
    if (given === undefined) {
      issues.push({ path: `${path}.input`, message: `${flow.label} needs ${input}` });
      continue;
    }
    if (type.type === 'list') {
      issues.push({ path: at, message: `${input} is a list, which a record can't give` });
      continue;
    }
    if (type.type === 'record') {
      const isRecord = given !== null && typeof given === 'object' && !Array.isArray(given) && 'ref' in given && given.ref === 'record';
      if (!isRecord || type.entity !== from.entity) issues.push({ path: at, message: `${input} is a record of ${type.entity}: give record, the ${from.entity} itself` });
      continue;
    }
    for (const ref of given !== null && typeof given === 'object' && !Array.isArray(given) ? refsOf(given) : []) {
      const [root, field, ...rest] = ref.split('.');
      if (root === 'principal') {
        if (!from.person) issues.push({ path: at, message: `${ref}: a process runs the flow with no person` });
      } else if (root !== 'record' || !field || rest.length) issues.push({ path: at, message: `${ref}: give values from record.<field>${from.person ? ' or principal.id' : ''}` });
      else if (!fields.has(field)) issues.push({ path: at, message: `${ref}: no such field` });
    }
  }
  for (const input of Object.keys(run.input)) if (!(input in flow.input)) issues.push({ path: `${path}.input.${input}`, message: `${flow.label} takes no ${input}` });
}

function refsOf(expression: Expression): string[] {
  return expressionRefs(expression);
}

/** What a flow does to records, by entity, the flows it calls and whom its tasks ask: what a change request names. */
export function flowWork(definition: StoredDefinition, flow: AppFlow): {
  readonly finds: readonly string[];
  readonly creates: readonly string[];
  readonly changes: readonly string[];
  readonly deletes: readonly string[];
  readonly calls: readonly string[];
  /** Each task, as "<role>: <task>". */
  readonly asks: readonly string[];
  /** Whom it tells: a role, the person a user field names, or the person running it. */
  readonly tells: readonly string[];
  /** The connections it calls, and the Teams channels it posts to. */
  readonly connects: readonly string[];
} {
  const work = { finds: new Set<string>(), creates: new Set<string>(), changes: new Set<string>(), deletes: new Set<string>(), calls: new Set<string>(), asks: new Set<string>(), tells: new Set<string>(), connects: new Set<string>() };
  walk(definition, flow, (step, scope) => {
    const held = (name: string) => {
      const kind = scope.get(name);
      return kind?.kind === 'record' ? kind.entity : undefined;
    };
    switch (step.type) {
      case 'find':
        work.finds.add(step.entity);
        return;
      case 'create':
        work.creates.add(step.entity);
        return;
      case 'change':
      case 'add_line': {
        const entity = held(step.record);
        if (entity) work.changes.add(entity);
        return;
      }
      case 'delete': {
        const entity = held(step.record);
        if (entity) work.deletes.add(entity);
        return;
      }
      case 'call':
        work.calls.add(step.flow);
        return;
      case 'task':
        work.asks.add(`${definition.roles[step.role]?.label ?? step.role}: ${step.label}`);
        return;
      case 'call_service':
        work.connects.add(step.connection);
        return;
      case 'inform':
        if (step.teams !== undefined) work.connects.add(step.teams);
        for (const recipient of step.to) {
          if ('role' in recipient) work.tells.add(definition.roles[recipient.role]?.label ?? recipient.role);
          else {
            const ref = recipient.person !== null && typeof recipient.person === 'object' && !Array.isArray(recipient.person) && 'ref' in recipient.person ? recipient.person.ref : undefined;
            const [root, name] = ref?.split('.') ?? [];
            const kind = root ? scope.get(root) : undefined;
            const field = kind && (kind.kind === 'record' || kind.kind === 'line') ? definition.entities[kind.entity]?.fields.find((f) => f.name === name) : undefined;
            const system: Readonly<Record<string, string>> = { owner: 'the owner', created_by: 'whoever created it', updated_by: 'whoever last changed it' };
            work.tells.add(ref === 'principal.id' ? 'the person running it' : field ? `the ${field.label.toLowerCase()}` : (system[name ?? ''] ?? ref ?? 'someone'));
          }
        }
        return;
      default:
        return;
    }
  });
  return {
    finds: [...work.finds],
    creates: [...work.creates],
    changes: [...work.changes],
    deletes: [...work.deletes],
    calls: [...work.calls],
    asks: [...work.asks],
    tells: [...work.tells],
    connects: [...work.connects],
  };
}

/**
 * Carry renames of entities and fields into flows. Field names follow the kind of each variable,
 * so `claim.total` follows a rename of the field total of the claim's entity.
 */
export function renameInFlows(
  definition: StoredDefinition,
  flows: Readonly<Record<string, AppFlow>>,
  entityName: (old: string) => string,
  fieldName: (entity: string) => (field: string) => string,
): Record<string, AppFlow> {
  const typeOf = (type: FlowType): FlowType => (type.type === 'record' || type.type === 'list' ? { ...type, entity: entityName(type.entity) } : type);
  // The entities of the flows' inputs and results, renamed, so that variables are typed by the new names.
  const renamedFlows = Object.fromEntries(
    Object.entries(flows).map(([name, flow]) => [name, { ...flow, input: Object.fromEntries(Object.entries(flow.input).map(([input, type]) => [input, typeOf(type)])), ...(flow.output ? { output: typeOf(flow.output) } : {}) }]),
  ) as Record<string, AppFlow>;
  const lookup: StoredDefinition = { ...definition, flows: renamedFlows };

  const ref = (scope: Scope) => (path: string) => {
    const [root, field, ...rest] = path.split('.');
    const held = root ? scope.get(root) : undefined;
    if (!field || rest.length || !held || (held.kind !== 'record' && held.kind !== 'line')) return path;
    return `${root}.${fieldName(held.entity)(field)}`;
  };
  const expression = (scope: Scope) => (e: Expression) => mapExpressionRefs(e, ref(scope));
  const condition = (scope: Scope, entity?: string) => (c: Condition) =>
    mapRefs(c, (path) => (entity && path.startsWith('record.') ? `record.${fieldName(entity)(path.slice('record.'.length))}` : ref(scope)(path)));
  const valuesOf = (entity: string | undefined, given: Readonly<Record<string, Expression>>, scope: Scope) =>
    Object.fromEntries(Object.entries(given).map(([field, e]) => [entity ? fieldName(entity)(field) : field, expression(scope)(e)]));
  const listPath = (of: string, scope: Scope) => {
    const [root, lines] = of.split('.');
    const held = root ? scope.get(root) : undefined;
    return lines && held?.kind === 'record' ? `${root}.${fieldName(held.entity)(lines)}` : of;
  };
  /** What a wait waits for: a date field of the record, or a condition on it, follows renames. */
  const waitFor = (wait: WaitFor, scope: Scope, field: (name: string) => string): WaitFor =>
    'date' in wait ? { ...wait, date: field(wait.date) } : 'condition' in wait ? { condition: condition(scope)(wait.condition) } : wait;
  /** How a flow starts by itself: a date field of its record, or a condition on it, follows renames. */
  const startOf = (start: FlowStart, scope: Scope, field: (name: string) => string): FlowStart =>
    'date' in start ? { ...start, date: field(start.date) } : 'condition' in start ? { condition: condition(scope)(start.condition) } : start;
  const voters = (people: Voters, field: (name: string) => string): Voters =>
    'fields' in people ? { fields: people.fields.map(field) } : 'lineOf' in people ? { ...people, lineOf: field(people.lineOf) } : people;

  return Object.fromEntries(
    Object.entries(renamedFlows).map(([name, flow]) => {
      // Rename step by step: each step sees the kinds its variables have where it stands.
      const renamed = new Map<string, FlowStep>();
      // A task and a wait name fields of the record the flow is about.
      const about = flowSubject(flow)?.entity;
      const field = about ? fieldName(about) : (name: string) => name;
      walk(lookup, { ...flow, steps: flow.steps.map((step) => renameEntities(step, entityName)) }, (step, scope, path) => {
        const held = (variable: string) => {
          const kind = scope.get(variable);
          return kind?.kind === 'record' || kind?.kind === 'line' ? kind.entity : undefined;
        };
        const item = (of: string) => {
          const [root, lines] = of.split('.');
          const kind = root ? scope.get(root) : undefined;
          if (!lines) return kind?.kind === 'list' ? kind.entity : undefined;
          const field = kind?.kind === 'record' ? lookup.entities[kind.entity]?.fields.find((f) => f.name === fieldName(kind.entity)(lines)) : undefined;
          return field?.type === 'lines' ? entityName(field.entity) : undefined;
        };
        let next: FlowStep;
        switch (step.type) {
          case 'set':
            next = { ...step, value: expression(scope)(step.value) };
            break;
          case 'find':
            next = {
              ...step,
              ...(step.where ? { where: condition(scope, step.entity)(step.where) } : {}),
              ...(step.sort ? { sort: step.sort.map((sort) => ({ ...sort, field: fieldName(step.entity)(sort.field) })) } : {}),
            };
            break;
          case 'create':
            next = { ...step, values: valuesOf(step.entity, step.values, scope) };
            break;
          case 'change':
            next = { ...step, values: valuesOf(held(step.record), step.values, scope) };
            break;
          case 'add_line': {
            const entity = held(step.record);
            const lines = entity ? fieldName(entity)(step.field) : step.field;
            const field = entity ? lookup.entities[entity]?.fields.find((f) => f.name === lines) : undefined;
            next = { ...step, field: lines, values: valuesOf(field?.type === 'lines' ? entityName(field.entity) : undefined, step.values, scope) };
            break;
          }
          case 'each':
            next = { ...step, in: listPath(step.in, scope) };
            break;
          case 'if':
            next = { ...step, when: condition(scope)(step.when) };
            break;
          case 'repeat':
            next = { ...step, while: condition(scope)(step.while) };
            break;
          case 'call_service':
            next = {
              ...step,
              path: expression(scope)(step.path),
              query: valuesOf(undefined, step.query, scope),
              ...(step.body ? { body: valuesOf(undefined, step.body, scope) } : {}),
            };
            break;
          case 'inform':
            next = {
              ...step,
              to: step.to.map((recipient) => ('person' in recipient ? { person: expression(scope)(recipient.person) } : recipient)),
              title: expression(scope)(step.title),
              ...(step.message !== undefined ? { message: expression(scope)(step.message) } : {}),
            };
            break;
          case 'check':
            next = { ...step, assert: condition(scope)(step.assert) };
            break;
          case 'call':
            next = { ...step, input: valuesOf(undefined, step.input, scope) };
            break;
          case 'total': {
            const entity = item(step.of);
            next = { ...step, of: listPath(step.of, scope), ...(step.field && entity ? { field: fieldName(entity)(step.field) } : {}) };
            break;
          }
          case 'return':
            next = step.value === undefined ? step : { ...step, value: expression(scope)(step.value) };
            break;
          case 'task':
            next = {
              ...step,
              ...(step.assignee ? { assignee: 'field' in step.assignee ? { field: field(step.assignee.field) } : { ...step.assignee, managerOf: field(step.assignee.managerOf) } } : {}),
              ...(step.department ? { department: { of: field(step.department.of) } } : {}),
              ...(step.several ? { several: { ...step.several, people: voters(step.several.people, field) } } : {}),
            };
            break;
          case 'wait':
            next = { ...step, for: waitFor(step.for, scope, field) };
            break;
          case 'first_of':
            next = { ...step, ways: step.ways.map((way) => ({ ...way, for: waitFor(way.for, scope, field) })) };
            break;
          default:
            next = step;
        }
        renamed.set(path, next);
      }, undefined, (entity, lines) => fieldName(entity)(lines));
      // Put the renamed steps back together, list by list.
      const rebuild = (steps: readonly FlowStep[], base: string): FlowStep[] =>
        steps.map((original, index) => {
          const at = `${base}[${index}]`;
          return withLists(renamed.get(at) ?? original, at, rebuild);
        });
      const steps = flow.steps.map((step) => renameEntities(step, entityName));
      const inputs: Scope = new Map(Object.entries(flow.input).map(([input, type]) => [input, kindOfType(type)]));
      return [name, { ...flow, ...(flow.starts ? { starts: flow.starts.map((start) => startOf(start, inputs, field)) } : {}), steps: rebuild(steps, 'steps') }];
    }),
  );
}

/** A step with the entities it names renamed, inside lists too. */
function renameEntities(step: FlowStep, entityName: (old: string) => string): FlowStep {
  const own = step.type === 'find' || step.type === 'create' ? { ...step, entity: entityName(step.entity) } : step;
  return withLists(own, '', (steps) => steps.map((inner) => renameEntities(inner, entityName)));
}
