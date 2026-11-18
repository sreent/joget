import type { Condition } from '@platform/authz';
import { mapRefs } from './condition-refs.js';
import { mapExpressionRefs, type Expression, type ExpressionValue } from './expressions.js';
import { entityFields, isWritable, type FieldInfo, type StoredDefinition } from './fields.js';
import { checkFlowRun, flowSteps, RESERVED_VARIABLES } from './flows.js';
import { withFormulas } from './formulas.js';
import type { Action, AppFlow, FlowRun, FlowStep, SimpleStep, Step } from './schema.js';
import { canonicalValue, defaultValue, fitValue, rollupValues, type FieldValue, type LineValues, type RecordLines, type RecordValues, type ValueIssue, type WriteContext } from './values.js';
import { flowWaits } from './waiting.js';

/*
 * The flow an action runs before it saves (design §6.2). It runs on the record as the action shapes
 * it, whenever the change is worked out: so a preview and a proposal show its result, and a person
 * approves exactly that. It is a flow like any other, in the one language of the app's logic. What
 * it may do is narrower: it changes only the record its action saves, and nothing elsewhere, since
 * a preview saves nothing.
 */

interface Issue {
  readonly path: string;
  readonly message: string;
}

/** A value as its field holds it; or undefined, with the issue, when the field can't hold it. */
function assign(info: FieldInfo | undefined, raw: ExpressionValue, field: string, where: string, issues: ValueIssue[], label = info?.field?.label ?? field): FieldValue | undefined {
  if (!info || !isWritable(info) || info.field?.type === 'file') {
    issues.push({ field, code: 'not_writable', message: `${where}: ${label} can't be set here` });
    return undefined;
  }
  const result = canonicalValue(info, fitValue(info, raw));
  if (!result.ok) {
    issues.push({ field, code: result.issue.code, message: `${where}: ${label}: ${result.issue.message}` });
    return undefined;
  }
  if (result.value === null && info.field?.required) {
    issues.push({ field, code: 'required', message: `${where}: ${label} is required, and this leaves it empty` });
    return undefined;
  }
  return result.value;
}

/** A draft as it was at one moment. */
export interface DraftState {
  readonly record: RecordValues;
  readonly lines: RecordLines;
  readonly set: readonly string[];
  readonly linesAdded: readonly string[];
}

/**
 * The record an action saves, as the flow before it saves shapes it. Each value is fitted to its
 * field and checked as the field checks it, and the rollups follow the lines. Nothing reaches the
 * database: the action writes what the draft ends with.
 */
export class Draft {
  readonly #definition: StoredDefinition;
  readonly #entity: string;
  readonly #record: Record<string, FieldValue>;
  readonly #lines: Record<string, LineValues[]>;
  readonly #set = new Set<string>();
  readonly #linesAdded = new Set<string>();
  readonly #at: WriteContext;

  constructor(definition: StoredDefinition, entity: string, record: RecordValues, lines: RecordLines, at: WriteContext = {}) {
    this.#definition = definition;
    this.#entity = entity;
    this.#at = at;
    this.#record = { ...record };
    this.#lines = Object.fromEntries(Object.entries(lines).map(([name, list]) => [name, [...list]]));
  }

  /** The record now: every value it had, with the values set and the rollups of its lines. */
  get record(): RecordValues {
    return { ...this.#record };
  }

  /** The lines of each lines field, with the lines added, which have no ID yet. */
  get lines(): RecordLines {
    return this.#lines;
  }

  /** The fields that got values. */
  get set(): readonly string[] {
    return [...this.#set];
  }

  /** The lines fields that got lines. */
  get linesAdded(): readonly string[] {
    return [...this.#linesAdded];
  }

  /** The draft as it is now, to go back to: what an error handler undoes. */
  snapshot(): DraftState {
    return { record: { ...this.#record }, lines: Object.fromEntries(Object.entries(this.#lines).map(([name, list]) => [name, [...list]])), set: this.set, linesAdded: this.linesAdded };
  }

  restore(state: DraftState): void {
    for (const key of Object.keys(this.#record)) delete this.#record[key];
    Object.assign(this.#record, state.record);
    for (const key of Object.keys(this.#lines)) delete this.#lines[key];
    for (const [name, list] of Object.entries(state.lines)) this.#lines[name] = [...list];
    this.#set.clear();
    for (const field of state.set) this.#set.add(field);
    this.#linesAdded.clear();
    for (const field of state.linesAdded) this.#linesAdded.add(field);
  }

  /** Set fields to values. A value that its field can't hold is an issue, and then none is set. `where` starts each issue's message. */
  change(values: Readonly<Record<string, ExpressionValue>>, where: string): ValueIssue[] {
    const fields = entityFields(this.#definition.entities[this.#entity]!);
    const issues: ValueIssue[] = [];
    const next: Record<string, FieldValue> = {};
    for (const [field, raw] of Object.entries(values)) {
      const value = assign(fields.get(field), raw, field, where, issues);
      if (value !== undefined) next[field] = value;
    }
    if (issues.length) return issues;
    Object.assign(this.#record, next);
    for (const field of Object.keys(next)) this.#set.add(field);
    return this.#derive();
  }

  /** Work out the record's formulas again, from its values now. */
  #derive(): ValueIssue[] {
    const worked = withFormulas(this.#definition.entities[this.#entity]!, this.#record);
    Object.assign(this.#record, worked.values);
    return worked.issues;
  }

  /** Add a line to a lines field. Fields it gives no value get their defaults. */
  addLine(field: string, values: Readonly<Record<string, ExpressionValue>>, where: string): ValueIssue[] {
    const entity = this.#definition.entities[this.#entity]!;
    const linesField = entity.fields.find((f) => f.name === field);
    if (linesField?.type !== 'lines') return [{ field, code: 'unknown_field', message: `${where}: ${entity.label} has no lines field ${field}` }];
    const current = this.#lines[field] ?? [];
    if (current.length >= linesField.max) return [{ field, code: 'too_big', message: `${where}: ${linesField.label} can have at most ${linesField.max} lines` }];
    const lineEntity = this.#definition.entities[linesField.entity]!;
    const lineFields = entityFields(lineEntity, { line: true });
    const position = `${field}[${current.length}]`;
    const issues: ValueIssue[] = [];
    const line: Record<string, FieldValue> = {};
    for (const declared of lineEntity.fields) {
      let value: FieldValue | undefined = null;
      if (Object.hasOwn(values, declared.name)) value = assign(lineFields.get(declared.name), values[declared.name]!, `${position}.${declared.name}`, where, issues, declared.label);
      else value = defaultValue(lineFields.get(declared.name)!, this.#at) ?? null;
      if (value === undefined) continue;
      if (declared.required && value === null) issues.push({ field: `${position}.${declared.name}`, code: 'required', message: `${where}: ${declared.label} is required` });
      line[declared.name] = value;
    }
    if (issues.length) return issues;
    // The line's formulas, then the record's totals of its lines, then the record's formulas.
    const worked = withFormulas(lineEntity, line, { line: true });
    if (worked.issues.length) return worked.issues.map((issue) => ({ ...issue, field: `${position}.${issue.field}` }));
    const next = [...current, { id: null, values: worked.values }];
    // What follows sees the new totals.
    const rollups = rollupValues(this.#definition, this.#entity, { [field]: next });
    if (rollups.issues.length) return rollups.issues;
    this.#lines[field] = next;
    this.#linesAdded.add(field);
    Object.assign(this.#record, rollups.values);
    return this.#derive();
  }
}

/** The flow an action runs before it saves, and the variables of the flow that hold the record it saves. */
export function beforeOf(
  definition: { readonly flows?: Readonly<Record<string, AppFlow>> | undefined },
  action: Pick<Action, 'entity' | 'before'>,
): { readonly name: string; readonly flow: AppFlow; readonly drafts: ReadonlySet<string> } | undefined {
  const run = action.before;
  const flow = run ? definition.flows?.[run.flow] : undefined;
  if (!run || !flow) return undefined;
  const drafts = Object.entries(flow.input).flatMap(([input, type]) => (type.type === 'record' && type.entity === action.entity && isRecordRef(run.input[input]) ? [input] : []));
  return { name: run.flow, flow, drafts: new Set(drafts) };
}

function isRecordRef(expression: Expression | undefined): boolean {
  return expression !== null && typeof expression === 'object' && !Array.isArray(expression) && 'ref' in expression && expression.ref === 'record';
}

/**
 * The fields and lines fields that an action's flow before it saves always gives a value: at its
 * top level, or on both sides of a branch. The caller need not give them.
 */
export function beforeGives(definition: { readonly flows?: Readonly<Record<string, AppFlow>> | undefined }, action: Pick<Action, 'entity' | 'before'>): Set<string> {
  const found = beforeOf(definition, action);
  if (!found) return new Set();
  const given = (steps: readonly FlowStep[]): Set<string> => {
    const names = new Set<string>();
    for (const step of steps) {
      if (step.type === 'change' && found.drafts.has(step.record)) for (const field of Object.keys(step.values)) names.add(field);
      if (step.type === 'add_line' && found.drafts.has(step.record)) names.add(step.field);
      if (step.type === 'if') {
        const other = given(step.else);
        for (const name of given(step.then)) if (other.has(name)) names.add(name);
      }
    }
    return names;
  };
  return given(found.flow.steps);
}

/** Whether a part of a definition refers to the person who runs it. */
function mentionsPrincipal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mentionsPrincipal);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, inner]) => ((key === 'ref' || key === 'exists') && typeof inner === 'string' && (inner === 'principal' || inner.startsWith('principal.'))) || mentionsPrincipal(inner),
  );
}

/**
 * Whether an action reads the person who runs it: in its condition, its steps, or its flow before
 * it saves and the flows that flow calls. A process runs actions with no person.
 */
export function readsPrincipal(
  definition: { readonly flows?: Readonly<Record<string, AppFlow>> | undefined },
  action: { readonly where?: Condition | undefined; readonly steps?: readonly Step[] | undefined; readonly before?: FlowRun | undefined },
): boolean {
  if (mentionsPrincipal(action.where) || mentionsPrincipal(action.steps)) return true;
  if (!action.before) return false;
  if (mentionsPrincipal(action.before.input)) return true;
  const seen = new Set<string>();
  const visit = (name: string): boolean => {
    const flow = definition.flows?.[name];
    if (seen.has(name) || !flow) return false;
    seen.add(name);
    return mentionsPrincipal(flow.steps) || flowSteps(flow.steps).some(({ step }) => step.type === 'call' && visit(step.flow));
  };
  return visit(action.before.flow);
}

/** A name for a flow that no flow has yet: the name asked for, or with a number after it. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, 62 - String(n).length)}_${n}`;
    if (!taken.has(name)) return name;
  }
}

const BEFORE_LABEL = ': before it saves';

/**
 * An action's steps as the flow that runs before it saves: the same logic, in the language of
 * every other flow. The record the steps name is the flow's input, named after its entity.
 */
export function stepsFlow(action: Pick<Action, 'label' | 'entity' | 'steps'>, name: string, taken: ReadonlySet<string>): { readonly name: string; readonly flow: AppFlow; readonly run: FlowRun } {
  const variable = RESERVED_VARIABLES.includes(action.entity) ? `the_${action.entity}`.slice(0, 63) : action.entity;
  const ref = (r: string) => (r === 'record' ? variable : r.startsWith('record.') ? `${variable}.${r.slice('record.'.length)}` : r);
  const values = (given: Readonly<Record<string, Expression>>) => Object.fromEntries(Object.entries(given).map(([field, expression]) => [field, mapExpressionRefs(expression, ref)]));
  const convert = (step: Step | SimpleStep): FlowStep => {
    switch (step.type) {
      case 'set':
        return { type: 'change', record: variable, values: values({ [step.field]: step.value }) };
      case 'add_line':
        return { type: 'add_line', record: variable, field: step.field, values: values(step.values) };
      case 'check':
        return { type: 'check', assert: mapRefs(step.assert, ref), message: step.message, severity: step.severity, ...(step.fields?.length ? { fields: step.fields.map((field) => `${variable}.${field}`) } : {}) };
      case 'if':
        return { type: 'if', when: mapRefs(step.when, ref), then: step.then.map(convert), else: step.else.map(convert) };
    }
  };
  const flowName = freeName(`${name.slice(0, 63 - '_before'.length)}_before`, taken);
  return {
    name: flowName,
    flow: {
      label: `${action.label.slice(0, 200 - BEFORE_LABEL.length).trim()}${BEFORE_LABEL}`,
      description: `What ${action.label} does before it saves. It was the action's steps.`,
      input: { [variable]: { type: 'record', entity: action.entity } },
      steps: (action.steps ?? []).map(convert),
    },
    run: { flow: flowName, input: { [variable]: { ref: 'record' } } },
  };
}

/**
 * Move the steps of each action into a flow that runs before it saves, and note each move. An
 * action that has a flow before it saves already keeps its steps, for the checks to report.
 */
export function moveSteps(definition: StoredDefinition, notes: string[]): StoredDefinition {
  if (!Object.values(definition.actions).some((action) => action.steps !== undefined && !action.before)) return definition;
  const flows: Record<string, AppFlow> = { ...definition.flows };
  const actions: Record<string, Action> = { ...definition.actions };
  for (const [name, action] of Object.entries(definition.actions)) {
    if (action.steps === undefined || action.before) continue;
    const { steps, ...rest } = action;
    if (!steps.length) {
      actions[name] = rest;
      continue;
    }
    const moved = stepsFlow(action, name, new Set(Object.keys(flows)));
    flows[moved.name] = moved.flow;
    actions[name] = { ...rest, before: moved.run };
    notes.push(`The steps of ${action.label} are now the flow ${moved.flow.label}, which runs before it saves`);
  }
  return { ...definition, flows, actions };
}

/** Whether a flow, or one it calls, changes records, tells people, or calls a service in a way that changes something there. */
function flowWrites(definition: StoredDefinition, name: string, seen = new Set<string>()): boolean {
  const flow = definition.flows?.[name];
  if (seen.has(name) || !flow) return false;
  seen.add(name);
  return flowSteps(flow.steps).some(({ step }) => {
    switch (step.type) {
      case 'create':
      case 'change':
      case 'add_line':
      case 'delete':
      case 'inform':
        return true;
      case 'call_service':
        return step.method !== 'GET';
      case 'call':
        return flowWrites(definition, step.flow, seen);
      default:
        return false;
    }
  });
}

/** The variables a step gives values: what a step that runs before an action saves keeps apart from its record. */
function givesVariables(step: FlowStep): string[] {
  switch (step.type) {
    case 'set':
    case 'find':
    case 'total':
      return [step.var];
    case 'create':
    case 'call':
      return step.var ? [step.var] : [];
    case 'each':
      return [step.as];
    case 'try':
      return step.error ? [step.error] : [];
    case 'call_service':
      return Object.keys(step.results);
    default:
      return [];
  }
}

/**
 * Check the flows that actions run before they save. Each runs in one go, on the record its action
 * saves, which is the only record it changes. It tells nobody, and it changes nothing elsewhere:
 * it runs for previews too, which save nothing.
 */
export function checkBeforeFlows(definition: StoredDefinition, issues: Issue[]): void {
  for (const [name, action] of Object.entries(definition.actions)) {
    if (!action.before) continue;
    const path = `actions.${name}.before`;
    if (action.steps?.length) issues.push({ path: `actions.${name}.steps`, message: `${action.label} runs a flow before it saves: move these steps into it` });
    const known = issues.length;
    checkFlowRun(definition, action.before, { entity: action.entity, person: true }, path, issues);
    const found = beforeOf(definition, action);
    // What it changes is known only once it gets its record.
    if (!found || issues.length > known) continue;
    const { flow, drafts } = found;
    if (flowWaits(flow, definition.flows)) {
      issues.push({ path: `${path}.flow`, message: `${flow.label} waits, and a flow that runs before an action saves runs in one go` });
      continue;
    }
    const record = definition.entities[action.entity]?.label.toLowerCase() ?? action.entity;
    const only = `it runs before ${action.label} saves, so it changes only the ${record} it saves`;
    for (const { step, path: at } of flowSteps(flow.steps)) {
      const issue = (message: string) => issues.push({ path: `flows.${found.name}.${at}`, message });
      for (const variable of givesVariables(step)) if (drafts.has(variable)) issue(`${variable} holds the ${record} that ${action.label} saves: keep other values in other variables`);
      switch (step.type) {
        case 'create':
          issue(`This flow can't create records: ${only}. Create them in a flow that runs after it saves`);
          break;
        case 'delete':
          issue(`This flow can't delete records: ${only}`);
          break;
        case 'change':
        case 'add_line':
          if (!drafts.has(step.record)) issue(`${step.record} isn't the ${record} that ${action.label} saves: ${only}`);
          break;
        case 'inform':
          issue(`This flow tells nobody: it runs before ${action.label} saves, and for its previews too. Tell people in a flow that runs after it saves`);
          break;
        case 'call_service':
          if (step.method !== 'GET') issue(`This flow only reads from services: it runs for previews too, and a ${step.method} changes something there`);
          break;
        case 'call': {
          const callee = definition.flows?.[step.flow];
          if (callee && flowWrites(definition, step.flow)) issue(`${callee.label} changes records or tells people, and this flow calls only flows that read: ${only}`);
          break;
        }
        default:
          break;
      }
    }
  }
}
