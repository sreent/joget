import {
  conditionText,
  dateWords,
  durationWords,
  scheduleWords,
  startWords,
  flowScopeAfter,
  flowScopes,
  flowSteps,
  flowSubject,
  flowWaits,
  stepWaits,
  withLists,
  type AppFlow,
  type Expression,
  type FlowRun,
  type FlowStep,
  type FlowType,
  type VarKind,
  type WaitFor,
} from '@platform/app-model';
import type { Definition } from '../types.js';
import { isGroup, opLabel, recordChoices, relativeWords, toModel, type Clause, type Condition, type Group, type Kind, type RefChoice } from './conditions.js';
import { toName } from './edit.js';

/*
 * Flows as builders edit them (design §6.2, §6.11). A step is found by its path, as the checks name
 * it: `steps[2]`, `steps[0].then[1]` inside a branch, or `steps[1].outcomes[0].steps[0]` on the way
 * of a task's outcome. A list of steps is found by its own path: `steps`, `steps[0].then`. Each
 * edit returns a new definition.
 */

export type StepType = FlowStep['type'];
type Flows = NonNullable<Definition['flows']>;

export const STEP_NAMES: Readonly<Record<StepType, string>> = {
  set: 'Set a variable',
  find: 'Find records',
  create: 'Create a record',
  change: 'Change a record',
  delete: 'Delete a record',
  add_line: 'Add a line',
  each: 'For each',
  repeat: 'Repeat while',
  if: 'Decision',
  check: 'Check',
  call: 'Call a flow',
  try: 'Handle errors',
  total: 'Count or total',
  return: 'Return a result',
  task: "Person's task",
  wait: 'Wait',
  first_of: 'The first of',
  all_at_once: 'All at once',
  inform: 'Inform people',
  call_service: 'Call a service',
};

/** The kinds of step a builder is offered, in groups, in order. */
export const STEP_GROUPS: ReadonlyArray<{ readonly label: string; readonly types: readonly StepType[]; readonly waits?: boolean }> = [
  { label: 'Records', types: ['find', 'create', 'change', 'add_line', 'delete'] },
  { label: 'Logic', types: ['set', 'if', 'each', 'repeat', 'total', 'check', 'call', 'try', 'return'] },
  { label: 'People and time', types: ['task', 'wait', 'first_of', 'all_at_once'], waits: true },
  { label: 'Tell and connect', types: ['inform', 'call_service'] },
];
export const STEP_TYPES: readonly StepType[] = STEP_GROUPS.flatMap((group) => group.types);

/** A step's path as its list and its place there: `steps[0].then[1]` is `steps[0].then` and 1. */
export function splitPath(path: string): { readonly list: string; readonly index: number } {
  const match = /^(.*)\[(\d+)\]$/.exec(path);
  if (!match) throw new Error(`Not a step's path: ${path}`);
  return { list: match[1]!, index: Number(match[2]) };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The list of steps at a list's path, such as `steps[0].then` or `steps[1].outcomes[0].steps`. */
export function listAt(flow: AppFlow, list: string): readonly FlowStep[] | undefined {
  const tokens = list.match(/[a-z_]+|\[\d+\]/g) ?? [];
  if (tokens[0] !== 'steps') return undefined;
  // Walk the path: `steps`, then `[0]`, then `then`, and so on.
  let at: unknown = flow;
  for (const token of tokens) {
    if (token.startsWith('[')) at = Array.isArray(at) ? at[Number(token.slice(1, -1))] : undefined;
    else at = isRecord(at) ? at[token] : undefined;
  }
  return Array.isArray(at) ? (at as readonly FlowStep[]) : undefined;
}

export function stepAt(flow: AppFlow, path: string): FlowStep | undefined {
  const { list, index } = splitPath(path);
  return listAt(flow, list)?.[index];
}

/** A copy of the steps with the list at a path changed. */
function changeList(steps: readonly FlowStep[], base: string, list: string, change: (steps: FlowStep[]) => FlowStep[]): FlowStep[] {
  if (base === list) return change([...steps]);
  return steps.map((step, index) => {
    const at = `${base}[${index}]`;
    return list.startsWith(`${at}.`) ? withLists(step, at, (inner, path) => changeList(inner, path, list, change)) : step;
  });
}

function withFlow(definition: Definition, name: string, change: (flow: AppFlow) => AppFlow): Definition {
  const flow = definition.flows?.[name];
  if (!flow) return definition;
  return { ...definition, flows: { ...definition.flows, [name]: change(flow) } };
}

const withSteps = (definition: Definition, name: string, list: string, change: (steps: FlowStep[]) => FlowStep[]) =>
  withFlow(definition, name, (flow) => ({ ...flow, steps: changeList(flow.steps, 'steps', list, change) }));

export function insertStep(definition: Definition, name: string, list: string, index: number, step: FlowStep): Definition {
  return withSteps(definition, name, list, (steps) => [...steps.slice(0, index), step, ...steps.slice(index)]);
}

export function replaceStep(definition: Definition, name: string, path: string, step: FlowStep): Definition {
  const { list, index } = splitPath(path);
  return withSteps(definition, name, list, (steps) => steps.map((existing, i) => (i === index ? step : existing)));
}

export function removeStep(definition: Definition, name: string, path: string): Definition {
  const { list, index } = splitPath(path);
  return withSteps(definition, name, list, (steps) => steps.filter((_, i) => i !== index));
}

/** Move a step up or down its list. */
export function moveStep(definition: Definition, name: string, path: string, by: -1 | 1): Definition {
  const { list, index } = splitPath(path);
  return withSteps(definition, name, list, (steps) => {
    const to = index + by;
    if (to < 0 || to >= steps.length) return steps;
    const next = [...steps];
    [next[index], next[to]] = [next[to]!, next[index]!];
    return next;
  });
}

/** A new flow, with a name worked out from its label. */
export function addFlow(definition: Definition, label: string): { definition: Definition; name: string } {
  const flows: Flows = definition.flows ?? {};
  const name = toName(label, Object.keys(flows));
  return { definition: { ...definition, flows: { ...flows, [name]: { label, input: {}, steps: [] } } }, name };
}

/** Remove a flow, and the roles' and actions' mentions of it. Process tasks that run it are left for the checks to name. */
export function removeFlow(definition: Definition, name: string): Definition {
  const flows = { ...(definition.flows ?? {}) };
  delete flows[name];
  const roles = Object.fromEntries(Object.entries(definition.roles).map(([role, spec]) => [role, spec.flows ? { ...spec, flows: spec.flows.filter((flow) => flow !== name) } : spec]));
  const actions = Object.fromEntries(
    Object.entries(definition.actions).map(([action, spec]) => {
      if (spec.flow?.flow !== name) return [action, spec];
      const { flow: _, ...rest } = spec;
      return [action, rest];
    }),
  );
  return { ...definition, flows, roles, actions } as Definition;
}

/**
 * What an action or a process task gives a flow, to start with: the record itself for an input
 * that takes a record of its entity, and a plain value for the rest. An input that a record can't
 * give is left out, for the checks to name.
 */
export function startRun(definition: Definition, flow: string, entity: string): FlowRun {
  const input: Record<string, Expression> = {};
  for (const [name, type] of Object.entries(definition.flows?.[flow]?.input ?? {})) {
    if (type.type === 'record' || type.type === 'list') {
      if (type.type === 'record' && type.entity === entity) input[name] = { ref: 'record' };
      continue;
    }
    input[name] = type.type === 'number' ? 0 : type.type === 'boolean' ? false : type.type === 'date' ? { today: true } : type.type === 'datetime' ? { now: true } : '';
  }
  return { flow, input };
}

export function updateFlow(definition: Definition, name: string, patch: Partial<Pick<AppFlow, 'label' | 'description' | 'input' | 'output' | 'starts' | 'schedule'>>): Definition {
  return withFlow(definition, name, (flow) => {
    const next: Record<string, unknown> = { ...flow };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') delete next[key];
      else next[key] = value;
    }
    return next as AppFlow;
  });
}

/** The variables a step sees, or, for a step added at the end of a list, those after its last step. */
export function scopeAt(definition: Definition, name: string, at: { readonly path: string } | { readonly list: string; readonly index: number }): ReadonlyMap<string, VarKind> {
  const flow = definition.flows?.[name];
  if (!flow) return new Map();
  if ('path' in at) return flowScopes(definition, flow).get(at.path) ?? new Map();
  const list = listAt(flow, at.list) ?? [];
  if (at.index < list.length) return flowScopes(definition, flow).get(`${at.list}[${at.index}]`) ?? new Map();
  return flowScopeAfter(definition, flow, at.list);
}

const fresh = (scope: ReadonlyMap<string, VarKind>, base: string): string => {
  if (!scope.has(base)) return base;
  for (let n = 2; ; n++) if (!scope.has(`${base}_${n}`)) return `${base}_${n}`;
};

/** Entities a flow works with: the app's own, not lines, which belong to their record. */
export function flowEntities(definition: Definition): string[] {
  const lines = new Set(Object.values(definition.entities).flatMap((entity) => entity.fields.flatMap((field) => (field.type === 'lines' ? [field.entity] : []))));
  return Object.keys(definition.entities).filter((name) => !lines.has(name));
}

/** The record variables in scope, and the lists one can loop over: list variables, and records' lines. */
export function recordVariables(scope: ReadonlyMap<string, VarKind>): string[] {
  return [...scope].flatMap(([name, kind]) => (kind.kind === 'record' ? [name] : []));
}

type ListChoice = { readonly value: string; readonly label: string; readonly entity: string; readonly line: boolean };

export function listChoices(definition: Definition, scope: ReadonlyMap<string, VarKind>): ListChoice[] {
  return [...scope].flatMap(([name, kind]): ListChoice[] => {
    if (kind.kind === 'list') return [{ value: name, label: `${name} (${definition.entities[kind.entity]?.pluralLabel ?? kind.entity})`, entity: kind.entity, line: false }];
    if (kind.kind !== 'record') return [];
    return (definition.entities[kind.entity]?.fields ?? []).flatMap((field) =>
      field.type === 'lines' ? [{ value: `${name}.${field.name}`, label: `${name}: ${field.label}`, entity: field.entity, line: true }] : [],
    );
  });
}

const KINDS: Readonly<Record<string, Kind>> = { text: 'text', uuid: 'id', number: 'number', boolean: 'boolean', date: 'date', datetime: 'date', 'text[]': 'multi', any: 'text', null: 'text' };

/** What conditions and values can read at a place: variables, and the fields of record and line variables. */
export function variableChoices(definition: Definition, scope: ReadonlyMap<string, VarKind>): RefChoice[] {
  return [...scope].flatMap(([name, kind]): RefChoice[] => {
    if (kind.kind === 'value') return [{ ref: name, label: name, kind: KINDS[kind.value] ?? 'text' }];
    if (kind.kind === 'list') return [];
    const entity = definition.entities[kind.entity];
    const fields = (entity?.fields ?? []).flatMap((field): RefChoice[] => {
      if (field.type === 'lines') return [];
      const fieldKind: Kind =
        field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : field.type === 'choice' ? (field.multiple ? 'multi' : 'choice') : field.type === 'user' ? 'person' : field.type === 'reference' || field.type === 'file' ? 'id' : field.type === 'date' || field.type === 'datetime' ? 'date' : 'text';
      return [{ ref: `${name}.${field.name}`, label: `${name}: ${field.label}`, kind: fieldKind, ...(field.type === 'choice' ? { options: field.options } : {}) }];
    });
    return [{ ref: `${name}.id`, label: `${name}: ID`, kind: 'id' }, ...fields];
  });
}

/** The update actions of an entity: what a task's outcome runs, and what a wait can wait for. */
export function updateActionsOf(definition: Definition, entity: string | undefined): string[] {
  return Object.entries(definition.actions).flatMap(([name, action]) => (entity && action.entity === entity && action.operation === 'update' ? [name] : []));
}

/** Whether a flow can wait: it keeps its place on one record, its one input. */
export const canWait = (flow: AppFlow | undefined): boolean => Boolean(flow && flowSubject(flow));

/** A new step of a kind, with values that fit what the flow has where it goes. */
export function newStep(definition: Definition, name: string, scope: ReadonlyMap<string, VarKind>, type: StepType): FlowStep {
  const entity = flowEntities(definition)[0] ?? 'entity';
  const records = recordVariables(scope);
  const lists = listChoices(definition, scope);
  const anyValue = variableChoices(definition, scope)[0]?.ref;
  const test = anyValue ? { exists: anyValue } : { exists: 'principal.id' };
  switch (type) {
    case 'set':
      return { type, var: fresh(scope, 'value'), value: 0 };
    case 'find':
      return { type, var: fresh(scope, 'found'), entity, limit: 100 };
    case 'create':
      return { type, entity, values: {}, var: fresh(scope, 'created') };
    case 'change':
      return { type, record: records[0] ?? '', values: {} };
    case 'delete':
      return { type, record: records[0] ?? '' };
    case 'add_line': {
      const holder = lists.find((list) => list.line);
      return { type, record: holder?.value.split('.')[0] ?? records[0] ?? '', field: holder?.value.split('.')[1] ?? '', values: {} };
    }
    case 'each':
      return { type, in: lists[0]?.value ?? '', as: fresh(scope, 'item'), steps: [] };
    case 'repeat':
      return { type, while: test, max: 10, steps: [] };
    case 'if':
      return { type, when: test, then: [], else: [] };
    case 'check':
      return { type, assert: test, message: 'Say what must hold, and why', severity: 'error' };
    case 'call': {
      const other = Object.keys(definition.flows ?? {}).find((flow) => flow !== name);
      return { type, flow: other ?? '', input: {} };
    }
    case 'try':
      return { type, steps: [], catch: [], rollback: true };
    case 'total':
      return { type, var: fresh(scope, 'total'), of: lists[0]?.value ?? '', op: 'count' };
    case 'return':
      return { type };
    case 'task':
      return {
        type,
        label: 'Decide',
        role: Object.keys(definition.roles)[0] ?? '',
        outcomes: [
          { name: 'approve', label: 'Approve', steps: [] },
          { name: 'reject', label: 'Reject', steps: [] },
        ],
      };
    case 'wait':
      return { type, for: { duration: 'P1D' } };
    case 'first_of': {
      const action = updateActionsOf(definition, flowSubject(definition.flows?.[name] ?? { label: '', input: {}, steps: [] })?.entity)[0];
      return { type, ways: [{ for: action ? { action } : { duration: 'P1D' }, steps: [] }, { for: { duration: 'P3D' }, steps: [] }] };
    }
    case 'all_at_once':
      return { type, ways: [{ steps: [] }, { steps: [] }] };
    case 'inform': {
      // Whom the first record's first user field names, or the person running it.
      const person = variableChoices(definition, scope).find((choice) => choice.kind === 'person')?.ref;
      const flow = definition.flows?.[name];
      const waits = flow ? flowWaits(flow, definition.flows) : false;
      return { type, to: [person ? { person: { ref: person } } : waits ? { role: Object.keys(definition.roles)[0] ?? '' } : { person: { ref: 'principal.id' } }], title: 'Say what happened', ...(records[0] ? { about: records[0] } : {}), email: true };
    }
    case 'call_service': {
      const service = Object.entries(definition.connections ?? {}).find(([, connection]) => connection.kind === 'service')?.[0];
      return { type, connection: service ?? '', method: 'GET', path: '', query: {}, results: {} };
    }
  }
}

/** A value in words, briefly. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.join(', ');
  const object = value as Record<string, unknown>;
  if (typeof object['ref'] === 'string') return object['ref'];
  if (object['today']) return 'today';
  if (object['now']) return 'now';
  const [op, args] = Object.entries(object)[0] ?? [];
  const symbols: Record<string, string> = { add: ' + ', sub: ' − ', mul: ' × ', div: ' ÷ ', concat: ' & ' };
  if (!op || !Array.isArray(args)) return 'a calculation';
  if (symbols[op]) return args.map(valueText).join(symbols[op]);
  const [a, b, c] = args as unknown[];
  switch (op) {
    case 'round':
      return `round ${valueText(a)}`;
    case 'add_days':
      return `${valueText(a)} + ${valueText(b)} days`;
    case 'add_hours':
      return `${valueText(a)} + ${valueText(b)} hours`;
    case 'days_between':
      return `days from ${valueText(a)} to ${valueText(b)}`;
    case 'if':
      return `${isRecord(a) ? conditionText(a as Condition) : 'a condition'} ? ${valueText(b)} : ${valueText(c)}`;
    case 'coalesce':
      return args.map(valueText).join(' or else ');
    default:
      return `${op}(${args.map(valueText).join(', ')})`;
  }
}

/**
 * A condition in words, for the canvas: the fields of the records a find looks at by their labels,
 * and variables by their names. A condition with a shape the builder can't show stays as text.
 */
function conditionWords(definition: Definition, condition: Condition, entity?: string): string {
  const model = toModel(condition);
  if (!model) return conditionText(condition);
  const fields = entity ? recordChoices(definition, entity) : [];
  const ref = (path: string) => (path === 'principal.id' ? 'the person running it' : (fields.find((choice) => choice.ref === path)?.label ?? path));
  const literal = (value: unknown) => (Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? `“${value}”` : String(value));
  const clause = (c: Clause) => {
    const right = !c.right ? '' : c.right.kind === 'ref' ? ref(c.right.ref) : c.right.kind === 'relative' ? relativeWords(c.right) : literal(c.right.value);
    // A date or a time is before or after; other values are less or more.
    const dated = c.right?.kind === 'relative' || (c.right?.kind === 'value' && typeof c.right.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c.right.value)) || fields.find((choice) => choice.ref === c.ref)?.kind === 'date';
    return `${ref(c.ref)} ${opLabel(c.op, dated ? 'date' : 'other')}${right ? ` ${right}` : ''}`;
  };
  const group = (g: Group): string => g.items.map((item) => (isGroup(item) ? `(${group(item)})` : clause(item))).join(g.match === 'all' ? ' and ' : ' or ');
  return group(model);
}

/** What a step does, in a few words, for its box on the canvas. */
export function describeFlowStep(definition: Definition, step: FlowStep): string {
  const label = (entity: string) => definition.entities[entity]?.label ?? entity;
  switch (step.type) {
    case 'set':
      return `${step.var} = ${valueText(step.value)}`;
    case 'find':
      return `Find ${step.first ? 'a' : 'the'} ${step.first ? label(step.entity) : (definition.entities[step.entity]?.pluralLabel ?? label(step.entity))}${step.where ? ` where ${conditionWords(definition, step.where, step.entity)}` : ''} → ${step.var}`;
    case 'create':
      return `Create ${label(step.entity)}${step.var ? ` → ${step.var}` : ''}`;
    case 'change':
      return `Change ${step.record}: ${Object.keys(step.values).join(', ') || 'nothing yet'}`;
    case 'delete':
      return `Delete ${step.record}`;
    case 'add_line':
      return `Add a line to ${step.record}.${step.field}`;
    case 'each':
      return `For each ${step.as} in ${step.in}`;
    case 'repeat':
      return `Repeat while ${conditionWords(definition, step.while)}, ${step.max} times at most`;
    case 'if':
      return `If ${conditionWords(definition, step.when)}`;
    case 'check':
      return `${step.severity === 'warning' ? 'Warn' : 'Stop'} unless ${conditionWords(definition, step.assert)}`;
    case 'call':
      return `Call ${definition.flows?.[step.flow]?.label ?? (step.flow || 'a flow')}${step.var ? ` → ${step.var}` : ''}`;
    case 'try':
      return step.rollback === false ? 'Try, and keep what it did if it fails' : 'Try, and undo it if it fails';
    case 'total':
      return `${step.op === 'count' ? 'Count' : step.op === 'sum' ? 'Total' : step.op === 'avg' ? 'Average' : step.op === 'min' ? 'Lowest' : 'Highest'} ${step.field ? `${step.field} of ` : ''}${step.of} → ${step.var}`;
    case 'return':
      return step.value === undefined ? 'Return' : `Return ${valueText(step.value)}`;
    case 'task':
      return `${step.label}: ${definition.roles[step.role]?.label ?? step.role} chooses ${step.outcomes.map((outcome) => outcome.label).join(' or ')}`;
    case 'wait':
      return waitWords(definition, step.for).words;
    case 'first_of':
      return `The first of: ${step.ways.map((way) => waitWords(definition, way.for).words.toLowerCase()).join(', or ')}`;
    case 'all_at_once':
      return `${step.ways.length} ways at once`;
    case 'inform':
      return `Tell ${recipientWords(definition, step)}: ${valueText(step.title)}`;
    case 'call_service':
      return `Call ${definition.connections?.[step.connection]?.label ?? (step.connection || 'a service')}: ${step.method} ${valueText(step.path) || '/'}`;
  }
}

/** Whom an inform step tells, in words: "the manager and HR". */
export function recipientWords(definition: Definition, step: Extract<FlowStep, { type: 'inform' }>): string {
  const names = step.to.map((recipient) => {
    if ('role' in recipient) return definition.roles[recipient.role]?.label ?? (recipient.role || 'a role');
    const ref = recipient.person !== null && typeof recipient.person === 'object' && !Array.isArray(recipient.person) && 'ref' in recipient.person ? recipient.person.ref : undefined;
    if (ref === 'principal.id') return 'the person running it';
    const field = ref?.split('.')[1];
    const system: Readonly<Record<string, string>> = { owner: 'the owner', created_by: 'whoever created it', updated_by: 'whoever last changed it' };
    return (field && system[field]) ?? (field ? `the ${field.replaceAll('_', ' ')}` : 'someone');
  });
  return names.length < 2 ? (names[0] ?? 'nobody') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What a wait waits for, in words: on the record of the entity a flow is about. */
export function waitWords(definition: Definition, wait: WaitFor, entity?: string): { words: string; about?: string; icon: WaitIcon } {
  if ('duration' in wait) return { words: `Waits ${durationWords(wait.duration)}`, icon: 'clock' };
  if ('date' in wait) return { words: `Waits until ${dateWords(wait, fieldLabelOf(definition, entity))}`, about: 'of the record', icon: 'clock' };
  if ('action' in wait) return { words: `Waits for ${definition.actions[wait.action]?.label ?? wait.action}`, about: 'on the record', icon: 'message' };
  if ('condition' in wait) return { words: 'Waits until it holds', about: conditionWords(definition, wait.condition), icon: 'decide' };
  return { words: `Waits for ${wait.signal}`, about: 'a signal', icon: 'bell' };
}

/** The label of a field of the entity a flow is about, or the field's name. */
const fieldLabelOf = (definition: Definition, entity: string | undefined) => (field: string) => (entity ? definition.entities[entity]?.fields.find((f) => f.name === field)?.label : undefined) ?? field;

/** How a flow starts, in words, for its start ring and its list: on a schedule, by itself on a record, or with its input. */
export function startsWords(definition: Definition, flow: AppFlow): string {
  const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  if (flow.schedule) return lowerFirst(scheduleWords(flow.schedule));
  const subject = flowSubject(flow);
  const [first, ...more] = flow.starts ?? [];
  if (first && subject) {
    const entity = definition.entities[subject.entity];
    const said = 'condition' in first ? `when ${conditionWords(definition, first.condition)}` : lowerFirst(startWords(first, entity?.label ?? subject.entity, fieldLabelOf(definition, subject.entity)));
    return more.length ? `${said}, or ${more.length} more way${more.length === 1 ? '' : 's'}` : said;
  }
  const inputs = Object.keys(flow.input);
  return inputs.length ? `with ${inputs.join(', ')}` : 'when it runs';
}

/** The lists of steps a step holds, each with what a builder calls it: for the list view of a canvas. */
export function labelledLists(definition: Definition, step: FlowStep, path: string, entity?: string): Array<{ label: string; steps: readonly FlowStep[]; path: string }> {
  switch (step.type) {
    case 'if':
      return [
        { label: 'If yes', steps: step.then, path: `${path}.then` },
        { label: 'If no', steps: step.else, path: `${path}.else` },
      ];
    case 'each':
      return [{ label: `For each ${step.as}`, steps: step.steps, path: `${path}.steps` }];
    case 'repeat':
      return [{ label: 'Repeats while it holds', steps: step.steps, path: `${path}.steps` }];
    case 'try':
      return [
        { label: 'The steps it guards', steps: step.steps, path: `${path}.steps` },
        { label: 'If they fail', steps: step.catch, path: `${path}.catch` },
      ];
    case 'task':
      return [
        ...step.outcomes.map((outcome, index) => ({ label: outcome.label, steps: outcome.steps, path: `${path}.outcomes[${index}].steps` })),
        ...(step.reminders ?? []).map((reminder, index) => ({ label: `After ${durationWords(reminder.after)}, a reminder`, steps: reminder.steps, path: `${path}.reminders[${index}].steps` })),
        ...(step.deadline ? [{ label: `After ${durationWords(step.deadline.after)}, the task ends`, steps: step.deadline.steps, path: `${path}.deadline.steps` }] : []),
      ];
    case 'first_of':
      return step.ways.map((way, index) => ({ label: waitWords(definition, way.for, entity).words, steps: way.steps, path: `${path}.ways[${index}].steps` }));
    case 'all_at_once':
      return step.ways.map((way, index) => ({ label: `Way ${index + 1}`, steps: way.steps, path: `${path}.ways[${index}].steps` }));
    default:
      return [];
  }
}

/** How long ago a time was, roughly: "under a minute", "5 minutes", "3 hours", "2 days". */
export function since(time: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(time)) / 60_000));
  if (minutes < 1) return 'under a minute';
  const [amount, unit] = minutes < 60 ? [minutes, 'minute'] : minutes < 48 * 60 ? [Math.round(minutes / 60), 'hour'] : [Math.round(minutes / 1440), 'day'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

/** What the live view says of a step: how many cases wait there, how many are stuck, and the longest wait. */
export function liveWords(step: { waiting: number; stuck: number; since: string }, now = Date.now()): string {
  return [step.waiting ? `${step.waiting} waiting` : '', step.stuck ? `${step.stuck} stuck` : '', since(step.since, now)].filter(Boolean).join(' · ');
}

/** A flow type in words. */
export function typeText(definition: Definition, type: FlowType | undefined): string {
  if (!type) return 'nothing';
  if (type.type === 'record') return `a ${definition.entities[type.entity]?.label ?? type.entity}`;
  if (type.type === 'list') return `a list of ${definition.entities[type.entity]?.pluralLabel ?? type.entity}`;
  return { text: 'text', number: 'a number', boolean: 'yes or no', date: 'a date', datetime: 'a time' }[type.type];
}

/*
 * The canvas (design §6.11), as Ocean's LogicNode draws a3t's flows and Mendix lays out a microflow:
 * left to right, a box for each step, a diamond for each decision, a frame round a loop and round
 * the steps an error handler guards, rings where a flow starts and ends. The layout is the
 * studio's own, so nobody drags a step into place, and a long flow wraps into rows, as text does.
 * Every arrow can take a new step, and an empty list shows a place for one.
 */

export type NodeKind = 'start' | 'end' | 'step' | 'decision' | 'merge' | 'frame' | 'slot' | 'port' | 'wait';
export type Tone = 'reads' | 'changes' | 'outside';
/** What a wait's ring shows: a clock for time, a message for an action, a tick for a condition, a bell for a signal. */
export type WaitIcon = 'clock' | 'message' | 'decide' | 'bell';

export interface CanvasNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** A step's path, for steps, decisions, frames, waits, and the end a return makes. A deadline's ring has its task's. */
  readonly path?: string;
  /** For a slot: the list it adds to. */
  readonly list?: string;
  readonly step?: FlowStep;
  /** A box's kind of step, in small capitals. */
  readonly kindLabel?: string;
  /** Its words: inside a box, above a diamond, at a frame's head, by a ring. */
  readonly label?: string;
  /** A second line: under a box's words, or a ring's. */
  readonly about?: string;
  /** What the step does, for its icon's colour. */
  readonly tone?: Tone;
  /** Who acts, at a box's foot: a person with a role, by the role's initial, or the app's own authority. */
  readonly who?: { readonly kind: 'person' | 'own'; readonly initial?: string; readonly words: string };
  /** A wait's icon, and where its words go. */
  readonly icon?: WaitIcon;
  readonly caption?: 'above' | 'below';
  /** A frame folded to one box, which unfolds again. */
  readonly folded?: boolean;
}

export interface CanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** The arrow at right angles, with rounded corners, ending where its head starts. */
  readonly d: string;
  readonly head?: { readonly x: number; readonly y: number; readonly dir: 'right' | 'left' | 'down' | 'up' };
  readonly label?: { readonly text: string; readonly x: number; readonly y: number };
  /** Where a step goes that is added on this arrow, and where its "+" sits. */
  readonly insert?: { readonly list: string; readonly index: number; readonly x: number; readonly y: number };
  /** A deadline hangs below its task by a dashed line. */
  readonly dashed?: boolean;
  /** Where the flow saves, just before it waits: a bar across the arrow. */
  readonly save?: { readonly x: number; readonly y: number };
}

// Sizes at Ocean's root size (15px): a step 11rem by about 5rem, a decision 3.4rem, a ring 2.4rem, a wait 2rem.
const BOX_W = 165;
const BOX_H = 76;
const RING = 36;
const WAIT = 30;
const DIAMOND = 51;
const MERGE = 28;
const GAP = 48;
const BRANCH_GAP = 76;
const ROW = 44;
const PAD_X = 24;
const PAD_TOP = 42;
const PAD_BOTTOM = 26;
const SLOT_W = 150;
const SLOT_H = 40;
const WRAP_GAP = 76;
const MARGIN = 28;
/** How far the words of a ring reach above or below it. */
const CAPTION = 44;
/** The narrowest frame: its head says what it is. */
const FRAME_MIN = 230;
/** About how wide a character of a ring's words is, at their size. */
const CAPTION_CHAR = 6;

type Pt = readonly [number, number];
type Side = 'left' | 'right' | 'top' | 'bottom';
interface Anchor {
  readonly id: string;
  readonly at: Pt;
  readonly side: Side;
  /** A slot: arrows into and out of it offer no "+", since it has its own. */
  readonly slot?: boolean;
}
interface Wire {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly points: Pt[];
  readonly head: boolean;
  readonly dashed?: boolean;
  readonly label?: { readonly text: string; readonly at: Pt };
  readonly insert?: { readonly list: string; readonly index: number; readonly at: Pt };
}
/** A piece of the canvas, laid out from its own origin: its entry at (0, 0), its line along y = 0. */
interface Piece {
  readonly width: number;
  readonly up: number;
  readonly down: number;
  readonly nodes: CanvasNode[];
  readonly wires: Wire[];
  readonly entry: Anchor;
  readonly exits: Anchor[];
}
/** What laying out a flow needs: the definition, and the entity of the record a flow that waits is about. */
interface Ctx {
  readonly definition: Definition;
  readonly entity?: string | undefined;
  /** The paths of the frames folded to one box. */
  readonly folded: ReadonlySet<string>;
}

const add = ([x, y]: Pt, dx: number, dy: number): Pt => [x + dx, y + dy];
function moved(piece: Piece, dx: number, dy: number): Piece {
  const anchor = (a: Anchor): Anchor => ({ ...a, at: add(a.at, dx, dy) });
  return {
    ...piece,
    nodes: piece.nodes.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy })),
    wires: piece.wires.map((wire) => ({
      ...wire,
      points: wire.points.map((p) => add(p, dx, dy)),
      ...(wire.label ? { label: { ...wire.label, at: add(wire.label.at, dx, dy) } } : {}),
      ...(wire.insert ? { insert: { ...wire.insert, at: add(wire.insert.at, dx, dy) } } : {}),
    })),
    entry: anchor(piece.entry),
    exits: piece.exits.map(anchor),
  };
}

let wires = 0;
/** An arrow from one anchor to another, at right angles. */
function wire(
  from: Anchor,
  to: Anchor,
  options: { label?: string; insert?: { list: string; index: number }; head?: boolean; near?: boolean; late?: boolean; dashed?: boolean } = {},
): Wire {
  const [x1, y1] = from.at;
  const [x2, y2] = to.at;
  let points: Pt[];
  if (from.side === 'right' && to.side === 'left') {
    if (Math.abs(y1 - y2) < 2) points = [from.at, [x2, y1]];
    else {
      // A way turns near where it leaves, near where it arrives, or halfway.
      const xm = options.near ? x1 + 18 : options.late ? x2 - 18 : (x1 + x2) / 2;
      points = [from.at, [xm, y1], [xm, y2], to.at];
    }
  } else if (from.side === 'bottom' && to.side === 'left') points = [from.at, [x1, y2], to.at];
  else if (from.side === 'right' && to.side === 'bottom') points = [from.at, [x2, y1], to.at];
  else points = [from.at, to.at];
  const slot = from.slot || to.slot;
  // A word goes near the start of its arrow, on the part that leaves the step; a "+" near its end.
  const first = points[0]!;
  const second = points[1]!;
  // A way that turns down near its step carries its word on the part that goes down, clear of the way on.
  const labelAt: Pt =
    options.near && points.length > 2 ? [second[0], (second[1] + points[2]![1]) / 2]
    : second[1] === first[1] ? [first[0] + Math.min(26, (second[0] - first[0]) / 2), first[1]]
    : [first[0], (first[1] + second[1]) / 2];
  const last = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const insertAt: Pt = before[1] === last[1] ? [last[0] - Math.min(22, Math.max(12, (last[0] - before[0]) / 2)), last[1]] : [last[0], (before[1] + last[1]) / 2];
  return {
    id: `w${++wires}`,
    source: from.id,
    target: to.id,
    points,
    head: options.head ?? !options.dashed,
    ...(options.dashed ? { dashed: true } : {}),
    ...(options.label ? { label: { text: options.label, at: labelAt } } : {}),
    ...(options.insert && !slot ? { insert: { ...options.insert, at: insertAt } } : {}),
  };
}

/** Who a task waits for, in a few words: the role's holders, one of them the record names, or several who vote. */
function whoWords(definition: Definition, step: Extract<FlowStep, { type: 'task' }>, entity: string | undefined): string {
  const role = definition.roles[step.role]?.label ?? step.role;
  const field = (name: string) => (entity ? definition.entities[entity]?.fields.find((f) => f.name === name)?.label.toLowerCase() : undefined) ?? name;
  if (step.several) return `several in ${role}, who vote`;
  if (step.assignee && 'field' in step.assignee) return `the ${field(step.assignee.field)}`;
  if (step.assignee) return `${step.assignee.levels > 1 ? "the manager's manager" : 'the manager'} of the ${field(step.assignee.managerOf)}`;
  if (step.department) return `${role}, in the ${field(step.department.of)}'s department`;
  return `anyone in ${role}`;
}

/** A step in a few words, for its box: its kind, its words, a line about it, and what it does. */
export function stepWords(definition: Definition, step: FlowStep, entity?: string): { kind: string; words: string; about?: string; tone?: Tone } {
  const label = (entity: string) => definition.entities[entity]?.label ?? entity;
  const plural = (entity: string) => definition.entities[entity]?.pluralLabel ?? label(entity);
  switch (step.type) {
    case 'set':
      return { kind: 'Set a value', words: step.var, about: `to ${valueText(step.value)}` };
    case 'find':
      return { kind: 'Find', words: step.first ? `A ${label(step.entity)}` : plural(step.entity), about: `${step.where ? `where ${conditionWords(definition, step.where, step.entity)}` : 'all of them'} → ${step.var}`, tone: 'reads' };
    case 'create':
      return { kind: 'Create', words: `A ${label(step.entity)}`, ...(step.var ? { about: `→ ${step.var}` } : {}), tone: 'changes' };
    case 'change':
      return { kind: 'Change', words: step.record, about: Object.keys(step.values).join(', ') || 'nothing yet', tone: 'changes' };
    case 'delete':
      return { kind: 'Delete', words: step.record, about: 'stays with a person', tone: 'changes' };
    case 'add_line':
      return { kind: 'Add a line', words: `${step.record}.${step.field}`, tone: 'changes' };
    case 'check':
      return { kind: 'Check', words: step.message, about: `${step.severity === 'warning' ? 'warns' : 'stops'} unless ${conditionWords(definition, step.assert)}` };
    case 'call': {
      const callee = definition.flows?.[step.flow];
      const writes = callee ? flowSteps(callee.steps).some(({ step: inner }) => ['create', 'change', 'delete', 'add_line'].includes(inner.type)) : false;
      const waits = stepWaits(step, definition.flows);
      return { kind: waits ? 'Runs a flow that waits' : 'Runs a flow', words: callee?.label ?? (step.flow || 'a flow'), ...(step.var ? { about: `→ ${step.var}` } : {}), ...(writes ? { tone: 'changes' as const } : {}) };
    }
    case 'total':
      return { kind: 'Count or total', words: step.of, about: `${step.op === 'count' ? 'how many' : `${step.op} of ${step.field ?? ''}`} → ${step.var}` };
    case 'if':
      return { kind: 'Decision', words: conditionWords(definition, step.when) };
    case 'each':
      return { kind: 'For each', words: `For each ${step.as} in ${step.in}` };
    case 'repeat':
      return { kind: 'Repeat', words: `Repeats while ${conditionWords(definition, step.while)}`, about: `${step.max} times at most` };
    case 'try':
      return { kind: 'Handle errors', words: 'Handle errors', about: step.rollback === false ? 'keeps what it did' : 'undoes what it did' };
    case 'return':
      return { kind: 'Ends', words: 'Ends', ...(step.value !== undefined ? { about: `returns ${valueText(step.value)}` } : {}) };
    case 'task':
      return { kind: "Person's task", words: step.label, ...(step.due ? { about: `within ${durationWords(step.due)}` } : {}) };
    case 'wait': {
      const words = waitWords(definition, step.for, entity);
      return { kind: 'Wait', words: words.words, ...(words.about ? { about: words.about } : {}) };
    }
    case 'first_of':
      return { kind: 'The first of', words: 'The first of', about: 'whichever comes first' };
    case 'all_at_once':
      return { kind: 'All at once', words: 'All at once', about: step.ways.length === 2 ? 'when both are done' : 'when each way is done' };
    case 'call_service': {
      const kept = Object.keys(step.results);
      return {
        kind: 'Calls a service',
        words: definition.connections?.[step.connection]?.label ?? (step.connection || 'A service'),
        about: `${step.method} ${typeof step.path === 'string' ? step.path || '/' : valueText(step.path)}${kept.length ? ` → ${kept.join(', ')}` : ''}`,
        tone: 'outside',
      };
    }
    case 'inform':
      // Email leaves the app: the step is outside, as a service is.
      return {
        kind: 'Informs people',
        words: typeof step.title === 'string' ? step.title : valueText(step.title),
        about: `to ${recipientWords(definition, step)}${step.email ? ', by email too' : ''}`,
        ...(step.email ? { tone: 'outside' as const } : {}),
      };
  }
}

function slotPiece(list: string): Piece {
  const id = `slot:${list}`;
  return {
    width: SLOT_W,
    up: SLOT_H / 2,
    down: SLOT_H / 2,
    nodes: [{ id, kind: 'slot', x: 0, y: -SLOT_H / 2, width: SLOT_W, height: SLOT_H, list }],
    wires: [],
    entry: { id, at: [0, 0], side: 'left', slot: true },
    exits: [{ id, at: [SLOT_W, 0], side: 'right', slot: true }],
  };
}

/** A wait's ring, with its words above it, or below it for a deadline. */
function waitPiece(node: Omit<CanvasNode, 'kind' | 'x' | 'y' | 'width' | 'height'>): Piece {
  const below = node.caption === 'below';
  return {
    width: WAIT,
    up: WAIT / 2 + (below ? 8 : CAPTION),
    down: WAIT / 2 + (below ? CAPTION : 8),
    nodes: [{ ...node, kind: 'wait', x: 0, y: -WAIT / 2, width: WAIT, height: WAIT }],
    wires: [],
    entry: { id: node.id, at: [0, 0], side: 'left' },
    exits: [{ id: node.id, at: [WAIT, 0], side: 'right' }],
  };
}

function listPiece(c: Ctx, steps: readonly FlowStep[], list: string): Piece {
  if (!steps.length) return slotPiece(list);
  let x = 0;
  let up = 0;
  let down = 0;
  const nodes: CanvasNode[] = [];
  const all: Wire[] = [];
  let entry: Anchor | undefined;
  let exits: Anchor[] = [];
  steps.forEach((step, index) => {
    const piece = moved(stepPiece(c, step, `${list}[${index}]`), x + (index ? GAP : 0), 0);
    if (index === 0) entry = piece.entry;
    for (const exit of exits) all.push(wire(exit, piece.entry, { insert: { list, index } }));
    nodes.push(...piece.nodes);
    all.push(...piece.wires);
    exits = piece.exits;
    x += (index ? GAP : 0) + piece.width;
    up = Math.max(up, piece.up);
    down = Math.max(down, piece.down);
  });
  return { width: x, up, down, nodes, wires: all, entry: entry!, exits };
}

/** Ways stacked in rows, the first on the line: where each starts, and how far they reach. */
function stack(ways: readonly Piece[], x: number, firstDown: number): { placed: Piece[]; width: number; down: number } {
  let y = 0;
  let down = firstDown;
  const placed = ways.map((way, index) => {
    if (index) y = down + ROW + way.up;
    down = y + way.down;
    return moved(way, x, y);
  });
  return { placed, width: Math.max(0, ...ways.map((way) => way.width)), down: Math.max(down, firstDown) };
}

/** Where ways meet again: the one on the line from the left, the others from below. */
function meet(path: string, rows: ReadonlyArray<{ readonly piece: Piece; readonly list: string; readonly length: number }>, mx: number): { node: CanvasNode; wires: Wire[]; exit: Anchor } {
  const node: CanvasNode = { id: `${path}:merge`, kind: 'merge', x: mx, y: -MERGE / 2, width: MERGE, height: MERGE };
  const all = rows.flatMap((row) =>
    row.piece.exits.map((exit) =>
      wire(exit, Math.abs(exit.at[1]) < 2 ? { id: node.id, at: [mx, 0], side: 'left' } : { id: node.id, at: [mx + MERGE / 2, MERGE / 2], side: 'bottom' }, { insert: { list: row.list, index: row.length } }),
    ),
  );
  return { node, wires: all, exit: { id: node.id, at: [mx + MERGE, 0], side: 'right' } };
}

/** A box: what most steps are. */
function boxPiece(node: Omit<CanvasNode, 'kind' | 'x' | 'y' | 'width' | 'height'>): Piece {
  return {
    width: BOX_W,
    up: BOX_H / 2 + 14,
    down: BOX_H / 2 + 16,
    nodes: [{ ...node, kind: 'step', x: 0, y: -BOX_H / 2, width: BOX_W, height: BOX_H }],
    wires: [],
    entry: { id: node.id, at: [0, 0], side: 'left' },
    exits: [{ id: node.id, at: [BOX_W, 0], side: 'right' }],
  };
}

function stepPiece(c: Ctx, step: FlowStep, path: string): Piece {
  const { definition } = c;
  const words = stepWords(definition, step, c.entity);
  if (step.type === 'if') {
    const yes = listPiece(c, step.then, `${path}.then`);
    const no = listPiece(c, step.else, `${path}.else`);
    const bx = DIAMOND + BRANCH_GAP;
    const noY = Math.max(DIAMOND / 2, yes.down) + ROW + no.up;
    const placedYes = moved(yes, bx, 0);
    const placedNo = moved(no, bx, noY);
    const width = Math.max(yes.width, no.width);
    const decision: CanvasNode = { id: path, kind: 'decision', x: 0, y: -DIAMOND / 2, width: DIAMOND, height: DIAMOND, path, step, label: words.words };
    const left: Anchor = { id: path, at: [0, 0], side: 'left' };
    const nodes = [decision, ...placedYes.nodes, ...placedNo.nodes];
    const all = [
      ...placedYes.wires,
      ...placedNo.wires,
      wire({ id: path, at: [DIAMOND, 0], side: 'right' }, placedYes.entry, { label: 'yes', insert: { list: `${path}.then`, index: 0 } }),
      wire({ id: path, at: [DIAMOND / 2, DIAMOND / 2], side: 'bottom' }, placedNo.entry, { label: 'no', insert: { list: `${path}.else`, index: 0 } }),
    ];
    const continues = placedYes.exits.length + placedNo.exits.length > 0;
    if (!continues) return { width: bx + width, up: Math.max(DIAMOND / 2 + 40, yes.up), down: noY + no.down, nodes, wires: all, entry: left, exits: [] };
    const met = meet(path, [{ piece: placedYes, list: `${path}.then`, length: step.then.length }, { piece: placedNo, list: `${path}.else`, length: step.else.length }], bx + width + GAP);
    return { width: met.exit.at[0], up: Math.max(DIAMOND / 2 + 40, yes.up), down: noY + no.down, nodes: [...nodes, met.node], wires: [...all, ...met.wires], entry: left, exits: [met.exit] };
  }
  if (step.type === 'task') {
    // A person's task: a box, a way on for each outcome, and a deadline that hangs below it.
    const box = boxPiece({
      id: path,
      path,
      step,
      kindLabel: words.kind,
      label: words.words,
      ...(words.about ? { about: words.about } : {}),
      who: { kind: 'person', initial: (definition.roles[step.role]?.label ?? step.role).slice(0, 1).toUpperCase(), words: whoWords(definition, step, c.entity) },
    });
    const bx = BOX_W + BRANCH_GAP;
    const ways = step.outcomes.map((outcome, index) => ({ piece: listPiece(c, outcome.steps, `${path}.outcomes[${index}].steps`), list: `${path}.outcomes[${index}].steps`, length: outcome.steps.length, label: outcome.label }));
    const { placed, width: waysWidth, down } = stack(
      ways.map((way) => way.piece),
      bx,
      box.down,
    );
    const from: Anchor = { id: path, at: [BOX_W, 0], side: 'right' };
    const rows = placed.map((piece, index) => ({ piece, list: ways[index]!.list, length: ways[index]!.length }));
    const nodes = [...box.nodes, ...placed.flatMap((piece) => piece.nodes)];
    const all = [...placed.flatMap((piece) => piece.wires), ...placed.map((piece, index) => wire(from, piece.entry, { label: ways[index]!.label, near: index > 0, insert: { list: ways[index]!.list, index: 0 } }))];
    let bottom = down;
    let width = waysWidth;
    // What hangs below the task, from its foot on the left, dashed, in the order it comes: each
    // reminder, whose way ends by itself while the task waits on; then the deadline, whose way goes on.
    // It hangs near the box's left edge, as Ocean draws it, clear of who acts at the box's foot.
    const hangX = 33;
    let hang: Anchor = { id: path, at: [hangX, BOX_H / 2], side: 'bottom' };
    const hanging = [
      ...(step.reminders ?? []).map((reminder, index) => ({
        id: `${path}:reminder:${index}`,
        list: `${path}.reminders[${index}].steps`,
        steps: reminder.steps,
        label: `After ${durationWords(reminder.after)}`,
        about: 'a reminder',
        icon: 'bell' as const,
        ends: true,
      })),
      ...(step.deadline ? [{ id: `${path}:deadline`, list: `${path}.deadline.steps`, steps: step.deadline.steps, label: `After ${durationWords(step.deadline.after)}`, about: 'the task ends', icon: 'clock' as const, ends: false }] : []),
    ];
    for (const item of hanging) {
      const after = listPiece(c, item.steps, item.list);
      const ringY = Math.max(hang.at[1] + 46 + WAIT / 2, bottom + ROW + Math.max(after.up, WAIT / 2 + 8));
      const ring = moved(waitPiece({ id: item.id, path, step, label: item.label, about: item.about, icon: item.icon, caption: 'below' }), hangX - WAIT / 2, ringY);
      const placedAfter = moved(after, bx, ringY);
      nodes.push(...ring.nodes, ...placedAfter.nodes);
      all.push(
        ...placedAfter.wires,
        wire(hang, { id: ring.entry.id, at: [hangX, ringY - WAIT / 2], side: 'top' }, { dashed: true }),
        wire(ring.exits[0]!, placedAfter.entry, { insert: { list: item.list, index: 0 } }),
      );
      if (item.ends) {
        const endX = bx + after.width + GAP;
        const end: CanvasNode = { id: `${item.id}:end`, kind: 'end', x: endX, y: ringY - RING / 2, width: RING, height: RING, label: 'Reminded' };
        nodes.push(end);
        for (const exit of placedAfter.exits) all.push(wire(exit, { id: end.id, at: [endX, ringY], side: 'left' }, { insert: { list: item.list, index: item.steps.length } }));
        width = Math.max(width, after.width + GAP + RING);
      } else {
        rows.push({ piece: placedAfter, list: item.list, length: item.steps.length });
        width = Math.max(width, after.width);
      }
      bottom = ringY + Math.max(WAIT / 2 + CAPTION, after.down);
      // The next hangs from below this one's words.
      hang = { id: item.id, at: [hangX, ringY + WAIT / 2 + CAPTION - 4], side: 'bottom' };
    }
    const up = Math.max(box.up, ways[0]?.piece.up ?? 0);
    const exits = rows.flatMap((row) => row.piece.exits);
    // One way on needs no place to meet.
    if (rows.length === 1 || !exits.length) return { width: bx + width, up, down: bottom, nodes, wires: all, entry: box.entry, exits };
    const met = meet(path, rows, bx + width + GAP);
    return { width: met.exit.at[0], up, down: bottom, nodes: [...nodes, met.node], wires: [...all, ...met.wires], entry: box.entry, exits: [met.exit] };
  }
  if (step.type === 'wait') {
    const said = waitWords(definition, step.for, c.entity);
    return waitPiece({ id: path, path, step, label: said.words, ...(said.about ? { about: said.about } : {}), icon: said.icon, caption: 'above' });
  }
  if ((step.type === 'each' || step.type === 'repeat' || step.type === 'try' || step.type === 'first_of' || step.type === 'all_at_once') && c.folded.has(path)) {
    // A folded frame is one box, which says how many steps it holds.
    const inner = labelledLists(definition, step, path, c.entity).reduce((sum, list) => sum + flowSteps(list.steps).length, 0);
    return boxPiece({ id: path, path, step, kindLabel: words.kind, label: words.words, about: `${inner} step${inner === 1 ? '' : 's'} inside`, folded: true });
  }
  if (step.type === 'each' || step.type === 'repeat' || step.type === 'try' || step.type === 'first_of' || step.type === 'all_at_once') {
    // A frame round steps: a loop's, those an error handler guards, or ways in rows.
    const rows =
      step.type === 'each' || step.type === 'repeat' || step.type === 'try'
        ? [{ piece: listPiece(c, step.steps, `${path}.steps`), list: `${path}.steps`, length: step.steps.length, ring: false }]
        : step.ways.map((way, index) => {
            const list = `${path}.ways[${index}].steps`;
            const steps = listPiece(c, way.steps, list);
            if (!('for' in way)) return { piece: steps, list, length: way.steps.length, ring: false };
            // A way of the first of starts with what it waits for.
            const said = waitWords(definition, way.for, c.entity);
            const ring = waitPiece({ id: `${path}.ways[${index}]`, path, step, label: said.words, ...(said.about ? { about: said.about } : {}), icon: said.icon, caption: 'above' });
            const placedSteps = moved(steps, WAIT + GAP, 0);
            const piece: Piece = {
              width: WAIT + GAP + steps.width,
              up: Math.max(ring.up, steps.up),
              down: Math.max(ring.down, steps.down),
              nodes: [...ring.nodes, ...placedSteps.nodes],
              wires: [...placedSteps.wires, wire(ring.exits[0]!, placedSteps.entry, { insert: { list, index: 0 } })],
              entry: ring.entry,
              exits: placedSteps.exits,
            };
            return { piece, list, length: way.steps.length, ring: true };
          });
    const fans = rows.length > 1;
    const { placed, width: inner } = stack(
      rows.map((row) => row.piece),
      PAD_X,
      rows[0]!.piece.down,
    );
    // Wide enough for its head's words, however little it holds.
    const frameW = Math.max(PAD_X + inner + PAD_X + (fans ? 12 : 0), FRAME_MIN);
    const top = -(rows[0]!.piece.up + PAD_TOP);
    const last = placed[placed.length - 1]!;
    const bottom = last.entry.at[1] + rows[rows.length - 1]!.piece.down + PAD_BOTTOM;
    const frame: CanvasNode = { id: path, kind: 'frame', x: 0, y: top, width: frameW, height: bottom - top, path, step, label: words.words, ...(words.about ? { about: words.about } : {}) };
    const portIn: CanvasNode = { id: `${path}:in`, kind: 'port', x: 0, y: 0, width: 0, height: 0 };
    const portOut: CanvasNode = { id: `${path}:out`, kind: 'port', x: frameW, y: 0, width: 0, height: 0 };
    const inAnchor: Anchor = { id: portIn.id, at: [0, 0], side: 'left' };
    const outAnchor: Anchor = { id: portOut.id, at: [frameW, 0], side: 'right' };
    const all = [
      ...placed.flatMap((piece) => piece.wires),
      ...placed.map((piece, index) => wire({ ...inAnchor, side: 'right' }, piece.entry, { near: fans, ...(rows[index]!.ring ? {} : { insert: { list: rows[index]!.list, index: 0 } }) })),
      ...placed.flatMap((piece, index) => piece.exits.map((exit) => wire(exit, { ...outAnchor, side: 'left' }, { late: fans, insert: { list: rows[index]!.list, index: rows[index]!.length }, head: false }))),
    ];
    const nodes = [frame, portIn, portOut, ...placed.flatMap((piece) => piece.nodes)];
    // A way that ends the flow ends it: the frame goes on only if a way does.
    const exits = placed.some((piece) => piece.exits.length) ? [outAnchor] : [];
    if (step.type !== 'try') return { width: frameW, up: -top + 14, down: bottom, nodes, wires: all, entry: inAnchor, exits };
    // An error handler: its way if the steps fail turns down to the steps that run then, and meets the way on.
    const handler = listPiece(c, step.catch, `${path}.catch`);
    const hx = frameW + BRANCH_GAP;
    const hy = bottom + ROW + handler.up;
    const placedHandler = moved(handler, hx, hy);
    const mx = hx + handler.width + GAP;
    const merge: CanvasNode = { id: `${path}:merge`, kind: 'merge', x: mx, y: -MERGE / 2, width: MERGE, height: MERGE };
    all.push(
      ...placedHandler.wires,
      wire(outAnchor, { id: merge.id, at: [mx, 0], side: 'left' }, { label: 'done' }),
      wire(outAnchor, placedHandler.entry, { label: 'if it fails', near: true, insert: { list: `${path}.catch`, index: 0 } }),
      ...placedHandler.exits.map((exit) => wire(exit, { id: merge.id, at: [mx + MERGE / 2, MERGE / 2], side: 'bottom' }, { insert: { list: `${path}.catch`, index: step.catch.length } })),
    );
    return { width: mx + MERGE, up: -top + 14, down: hy + handler.down, nodes: [...nodes, ...placedHandler.nodes, merge], wires: all, entry: inAnchor, exits: [{ id: merge.id, at: [mx + MERGE, 0], side: 'right' }] };
  }
  if (step.type === 'return') {
    const ring: CanvasNode = { id: path, kind: 'end', x: 0, y: -RING / 2, width: RING, height: RING, path, step, label: words.words, ...(words.about ? { about: words.about } : {}) };
    return { width: RING, up: RING / 2 + 8, down: RING / 2 + CAPTION, nodes: [ring], wires: [], entry: { id: path, at: [0, 0], side: 'left' }, exits: [] };
  }
  const writes = step.type === 'create' || step.type === 'change' || step.type === 'delete' || step.type === 'add_line';
  return boxPiece({
    id: path,
    path,
    step,
    kindLabel: words.kind,
    label: words.words,
    ...(words.about ? { about: words.about } : {}),
    ...(words.tone ? { tone: words.tone } : {}),
    // A flow writes with the app's authority, in the name of whoever started it.
    ...(writes ? { who: { kind: 'own' as const, words: 'the app' } } : {}),
  });
}

/** A path at right angles through its points, with rounded corners, short of its head. */
function pathOf(points: readonly Pt[], head: boolean): { d: string; head?: CanvasEdge['head'] } {
  const pts = points.map((p) => [...p] as [number, number]);
  let tip: CanvasEdge['head'];
  if (head && pts.length >= 2) {
    const last = pts[pts.length - 1]!;
    const before = pts[pts.length - 2]!;
    const dir = last[1] === before[1] ? (last[0] >= before[0] ? 'right' : 'left') : last[1] >= before[1] ? 'down' : 'up';
    tip = { x: last[0], y: last[1], dir };
    const back = { right: [-9, 0], left: [9, 0], down: [0, -9], up: [0, 9] }[dir];
    pts[pts.length - 1] = [last[0] + back[0]!, last[1] + back[1]!];
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  let d = `M${round(pts[0]![0])} ${round(pts[0]![1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    const next = pts[i + 1];
    if (!next) {
      d += ` L${round(x)} ${round(y)}`;
      break;
    }
    const [px, py] = pts[i - 1]!;
    const r = Math.min(8, Math.abs(x - px || y - py) / 2, Math.abs(next[0] - x || next[1] - y) / 2);
    const inX = x - Math.sign(x - px) * r;
    const inY = y - Math.sign(y - py) * r;
    const outX = x + Math.sign(next[0] - x) * r;
    const outY = y + Math.sign(next[1] - y) * r;
    d += ` L${round(inX)} ${round(inY)} Q${round(x)} ${round(y)} ${round(outX)} ${round(outY)}`;
  }
  return { d, ...(tip ? { head: tip } : {}) };
}

/**
 * The places where a flow that waits saves: before a person's task, a wait, the first of several
 * waits and a run of a flow that waits. What runs between two of them commits together.
 */
function savesBefore(flow: AppFlow, definition: Definition, nodes: readonly CanvasNode[]): Set<string> {
  if (!flowWaits(flow, definition.flows)) return new Set();
  return new Set(
    nodes.flatMap((node) => {
      const step = node.step;
      if (!step || node.id !== node.path || !savesAt(step, definition)) return [];
      return [step.type === 'first_of' && !node.folded ? `${node.path}:in` : node.id];
    }),
  );
}

/** Whether a flow saves before a step: a person's task, a wait, the first of several, or a run of a flow that waits. */
function savesAt(step: FlowStep, definition: Definition): boolean {
  return step.type === 'task' || step.type === 'wait' || step.type === 'first_of' || (step.type === 'call' && stepWaits(step, definition.flows));
}

/** Lay a flow out for the canvas: left to right, and in rows where it's longer than the width given. */
export function layoutFlow(
  definition: Definition,
  flow: AppFlow,
  maxWidth = 980,
  folded: ReadonlySet<string> = new Set(),
): { readonly nodes: CanvasNode[]; readonly edges: CanvasEdge[]; readonly width: number; readonly height: number } {
  wires = 0;
  const c: Ctx = { definition, entity: flowSubject(flow)?.entity, folded };
  // The start ring's words sit centred under it: a long line of them needs room on the left.
  const about = startsWords(definition, flow);
  const lead = Math.max(0, Math.round((about.length * CAPTION_CHAR) / 2 - RING / 2 - MARGIN + 6));
  const start: Piece = {
    width: lead + RING,
    up: RING / 2 + 8,
    down: RING / 2 + CAPTION,
    nodes: [{ id: 'start', kind: 'start', x: lead, y: -RING / 2, width: RING, height: RING, label: 'Starts', about }],
    wires: [],
    entry: { id: 'start', at: [lead, 0], side: 'left' },
    exits: [{ id: 'start', at: [lead + RING, 0], side: 'right' }],
  };
  const pieces: Array<{ piece: Piece; index?: number }> = [{ piece: start }];
  if (!flow.steps.length) pieces.push({ piece: slotPiece('steps') });
  flow.steps.forEach((step, index) => pieces.push({ piece: stepPiece(c, step, `steps[${index}]`), index }));
  const last = pieces[pieces.length - 1]!.piece;
  if (last.exits.length) {
    pieces.push({
      piece: {
        width: RING,
        up: RING / 2 + 8,
        down: RING / 2 + CAPTION,
        nodes: [{ id: 'end', kind: 'end', x: 0, y: -RING / 2, width: RING, height: RING, label: 'Ends', ...(flow.output ? { about: 'with its result' } : {}) }],
        wires: [],
        entry: { id: 'end', at: [0, 0], side: 'left' },
        exits: [],
      },
    });
  }
  // Rows: pieces go on until the next would pass the width, then the flow wraps. A flow that waits
  // wraps where it saves, where it can, so that each row is one stretch of work.
  const savesHere = (item: { index?: number }) => item.index !== undefined && savesAt(flow.steps[item.index]!, definition);
  const reach = (row: typeof pieces, first: boolean) => row.reduce((x, item) => x + item.piece.width + GAP, MARGIN + (first ? 0 : 36));
  const rows: Array<typeof pieces> = [[]];
  for (const item of pieces) {
    const row = rows[rows.length - 1]!;
    if (!row.length || reach(row, rows.length === 1) + item.piece.width <= maxWidth) {
      row.push(item);
      continue;
    }
    // Never so that the start stands alone on its row.
    const at = row.findLastIndex((each, i) => i > 1 && savesHere(each));
    const next = at > 0 ? row.splice(at) : [];
    rows.push(next);
    if (next.length && reach(next, false) + item.piece.width > maxWidth) rows.push([item]);
    else rows[rows.length - 1]!.push(item);
  }
  const nodes: CanvasNode[] = [];
  const all: Wire[] = [];
  let top = MARGIN;
  let previous: { exits: Anchor[]; lane: number } | undefined;
  rows.forEach((row, r) => {
    const up = Math.max(...row.map((item) => item.piece.up));
    const down = Math.max(...row.map((item) => item.piece.down));
    const cy = top + up;
    let cx = MARGIN + (r ? 36 : 0);
    row.forEach((item, i) => {
      const placed = moved(item.piece, cx, cy);
      const index = item.index ?? (item.piece.nodes[0]?.id === 'end' ? flow.steps.length : 0);
      if (i === 0 && previous) {
        // The way on wraps: down past the row it leaves, back to the left, and into the next row.
        for (const exit of previous.exits) {
          const [x1, y1] = exit.at;
          const [x2, y2] = placed.entry.at;
          const lane = previous.lane;
          const w: Wire = {
            id: `w${++wires}`,
            source: exit.id,
            target: placed.entry.id,
            points: [exit.at, [x1 + 22, y1], [x1 + 22, lane], [MARGIN, lane], [MARGIN, y2], [x2, y2]],
            head: true,
            ...(placed.entry.slot ? {} : { insert: { list: 'steps', index, at: [(MARGIN + x1) / 2, lane] as Pt } }),
          };
          all.push(w);
        }
      } else if (previous || i > 0) {
        const exits = i > 0 ? (row[i - 1] as { placedExits?: Anchor[] }).placedExits ?? [] : [];
        for (const exit of exits) all.push(wire(exit, placed.entry, { insert: { list: 'steps', index } }));
      }
      (item as { placedExits?: Anchor[] }).placedExits = placed.exits;
      nodes.push(...placed.nodes);
      all.push(...placed.wires);
      cx += placed.width + GAP;
    });
    const tail = row[row.length - 1] as { placedExits?: Anchor[] };
    previous = { exits: tail.placedExits ?? [], lane: cy + down + WRAP_GAP / 2 };
    top = cy + down + WRAP_GAP;
  });
  const width = Math.max(...nodes.map((node) => node.x + node.width)) + MARGIN;
  const height = top - WRAP_GAP + MARGIN;
  const saves = savesBefore(flow, definition, nodes);
  const edges: CanvasEdge[] = all.map((w) => {
    const path = pathOf(w.points, w.head);
    // A bar just before the step that waits; the "+" moves back to make room for it.
    const end = w.points[w.points.length - 1]!;
    const before = w.points[w.points.length - 2]!;
    const flat = before[1] === end[1] && end[0] - before[0] >= 30;
    const save = saves.has(w.target) && !w.dashed && flat ? { x: end[0] - 15, y: end[1] } : undefined;
    const insert = w.insert && save ? { ...w.insert, at: [Math.min(w.insert.at[0], end[0] - 34), w.insert.at[1]] as Pt } : w.insert;
    return {
      id: w.id,
      source: w.source,
      target: w.target,
      d: path.d,
      ...(path.head ? { head: path.head } : {}),
      ...(w.dashed ? { dashed: true } : {}),
      ...(save ? { save } : {}),
      ...(w.label ? { label: { text: w.label.text, x: w.label.at[0], y: w.label.at[1] } } : {}),
      ...(insert ? { insert: { list: insert.list, index: insert.index, x: insert.at[0], y: insert.at[1] } } : {}),
    };
  });
  return { nodes, edges, width, height };
}
