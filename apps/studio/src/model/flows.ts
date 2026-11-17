import { conditionText, flowScopeAfter, flowScopes, type AppFlow, type Expression, type FlowRun, type FlowStep, type FlowType, type VarKind } from '@platform/app-model';
import type { Definition } from '../types.js';
import { isGroup, OP_LABELS, recordChoices, toModel, type Clause, type Condition, type Group, type Kind, type RefChoice } from './conditions.js';
import { toName } from './edit.js';

/*
 * Flows as builders edit them (design §6.2). A step is found by its path, as the checks name it:
 * `steps[2]`, or `steps[0].then[1]` inside a branch. A list of steps is found by its own path:
 * `steps`, `steps[0].then`. Each edit returns a new definition.
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
  if: 'Decision',
  check: 'Check',
  call: 'Call a flow',
  try: 'Handle errors',
  total: 'Count or total',
  return: 'Return a result',
};

/** The order in which a builder is offered the kinds of step. */
export const STEP_TYPES: readonly StepType[] = ['find', 'create', 'change', 'add_line', 'delete', 'set', 'if', 'each', 'total', 'check', 'call', 'try', 'return'];

/** A step's path as its list and its place there: `steps[0].then[1]` is `steps[0].then` and 1. */
export function splitPath(path: string): { readonly list: string; readonly index: number } {
  const match = /^(.*)\[(\d+)\]$/.exec(path);
  if (!match) throw new Error(`Not a step's path: ${path}`);
  return { list: match[1]!, index: Number(match[2]) };
}

/** The steps that a step holds, by the name of their list. */
function inner(step: FlowStep, key: string): readonly FlowStep[] | undefined {
  if (step.type === 'each' && key === 'steps') return step.steps;
  if (step.type === 'if' && (key === 'then' || key === 'else')) return step[key];
  if (step.type === 'try' && (key === 'steps' || key === 'catch')) return step[key];
  return undefined;
}

/** The list of steps at a list's path, such as `steps[0].then`. */
export function listAt(flow: AppFlow, list: string): readonly FlowStep[] | undefined {
  const tokens = list.match(/[a-z_]+|\[\d+\]/g) ?? [];
  if (tokens[0] !== 'steps') return undefined;
  // Walk the path: `steps`, then `[0]`, then `then`, and so on.
  let at: readonly FlowStep[] | FlowStep | undefined = flow.steps;
  for (const token of tokens.slice(1)) {
    if (token.startsWith('[')) at = Array.isArray(at) ? (at as readonly FlowStep[])[Number(token.slice(1, -1))] : undefined;
    else at = at && !Array.isArray(at) ? inner(at as FlowStep, token) : undefined;
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
    if (!list.startsWith(`${at}.`)) return step;
    if (step.type === 'each') return { ...step, steps: changeList(step.steps, `${at}.steps`, list, change) };
    if (step.type === 'if') return { ...step, then: changeList(step.then, `${at}.then`, list, change), else: changeList(step.else, `${at}.else`, list, change) };
    if (step.type === 'try') return { ...step, steps: changeList(step.steps, `${at}.steps`, list, change), catch: changeList(step.catch, `${at}.catch`, list, change) };
    return step;
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

export function updateFlow(definition: Definition, name: string, patch: Partial<Pick<AppFlow, 'label' | 'description' | 'input' | 'output'>>): Definition {
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
  if (op && Array.isArray(args) && symbols[op]) return args.map(valueText).join(symbols[op]);
  if (op === 'round' && Array.isArray(args)) return `round ${valueText(args[0])}`;
  return 'a calculation';
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
    const right = !c.right ? '' : c.right.kind === 'ref' ? ref(c.right.ref) : literal(c.right.value);
    return `${ref(c.ref)} ${OP_LABELS[c.op]}${right ? ` ${right}` : ''}`;
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
  }
}

/** A flow type in words. */
export function typeText(definition: Definition, type: FlowType | undefined): string {
  if (!type) return 'nothing';
  if (type.type === 'record') return `a ${definition.entities[type.entity]?.label ?? type.entity}`;
  if (type.type === 'list') return `a list of ${definition.entities[type.entity]?.pluralLabel ?? type.entity}`;
  return { text: 'text', number: 'a number', boolean: 'yes or no', date: 'a date', datetime: 'a time' }[type.type];
}

/*
 * The canvas (design §6.2). Steps go down the page; a decision's two paths go side by side and
 * meet again below; a loop and an error handler frame their steps. Every arrow between steps can
 * take a new step, and an empty list shows a place for one.
 */

export interface CanvasNode {
  readonly id: string;
  readonly kind: 'start' | 'end' | 'step' | 'decision' | 'slot' | 'join' | 'frame';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** For a step: its path. For a slot: the list it adds to. For a frame: the step it frames. */
  readonly path?: string;
  readonly list?: string;
  readonly step?: FlowStep;
  readonly label?: string;
}

export interface CanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: 'yes' | 'no' | 'fail' | 'next';
  readonly label?: string;
  /** Where a step goes that is added on this arrow. */
  readonly insert?: { readonly list: string; readonly index: number };
  /** The arrow back to the top of a loop. */
  readonly back?: boolean;
}

const W = 260;
const H = 56;
const GAP = 40;
const INDENT = 28;
const COLUMN = 48;
const JOIN = 12;
const PAD = 14;

interface Laid {
  readonly nodes: CanvasNode[];
  readonly edges: CanvasEdge[];
  readonly width: number;
  readonly height: number;
  readonly entry: string;
  readonly exits: string[];
}

/** Lay a flow out for the canvas. */
export function layoutFlow(definition: Definition, flow: AppFlow): { readonly nodes: CanvasNode[]; readonly edges: CanvasEdge[] } {
  const start: CanvasNode = { id: 'start', kind: 'start', x: W / 2 - 18, y: 0, width: 36, height: 36 };
  const body = layoutList(definition, flow.steps, 'steps', 0, 36 + GAP);
  const end: CanvasNode = { id: 'end', kind: 'end', x: W / 2 - 18, y: 36 + GAP + body.height + GAP, width: 36, height: 36 };
  const edges: CanvasEdge[] = [{ id: 'start>', source: 'start', target: body.entry, insert: { list: 'steps', index: 0 } }, ...body.edges];
  for (const exit of body.exits) edges.push({ id: `${exit}>end`, source: exit, target: 'end', insert: { list: 'steps', index: flow.steps.length } });
  // A return ends the flow: one in the flow's own steps leads to the end, and takes no step after it.
  flow.steps.forEach((step, index) => {
    if (step.type === 'return') edges.push({ id: `steps[${index}]>end`, source: `steps[${index}]`, target: 'end' });
  });
  // An empty list's slot has its own button: the arrows around it offer no second one.
  const slotted = edges.map((edge) => {
    if (!edge.source.startsWith('slot:') && !edge.target.startsWith('slot:')) return edge;
    const { insert: _, ...rest } = edge;
    return rest;
  });
  return { nodes: [start, ...body.nodes, end], edges: slotted };
}

function layoutList(definition: Definition, steps: readonly FlowStep[], list: string, x: number, y: number): Laid {
  if (!steps.length) {
    const slot: CanvasNode = { id: `slot:${list}`, kind: 'slot', x, y, width: W, height: 40, list };
    return { nodes: [slot], edges: [], width: W, height: 40, entry: slot.id, exits: [slot.id] };
  }
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  let top = y;
  let width = W;
  let entry = '';
  let exits: string[] = [];
  steps.forEach((step, index) => {
    const laid = layoutStep(definition, step, `${list}[${index}]`, x, top);
    nodes.push(...laid.nodes);
    edges.push(...laid.edges);
    if (index === 0) entry = laid.entry;
    for (const exit of exits) edges.push({ id: `${exit}>${laid.entry}`, source: exit, target: laid.entry, insert: { list, index } });
    exits = laid.exits;
    top += laid.height + GAP;
    width = Math.max(width, laid.width);
  });
  return { nodes, edges, width, height: top - GAP - y, entry, exits };
}

function layoutStep(definition: Definition, step: FlowStep, path: string, x: number, y: number): Laid {
  const box = (kind: CanvasNode['kind'] = 'step'): CanvasNode => ({ id: path, kind, x, y, width: W, height: H, path, step, label: describeFlowStep(definition, step) });
  if (step.type === 'if') {
    const decision = box('decision');
    const branchY = y + H + GAP;
    const yes = layoutList(definition, step.then, `${path}.then`, x, branchY);
    const no = layoutList(definition, step.else, `${path}.else`, x + yes.width + COLUMN, branchY);
    const joinY = branchY + Math.max(yes.height, no.height) + GAP;
    const join: CanvasNode = { id: `${path}:join`, kind: 'join', x: W / 2 - JOIN / 2 + x, y: joinY, width: JOIN, height: JOIN };
    const edges: CanvasEdge[] = [
      ...yes.edges,
      ...no.edges,
      { id: `${path}>yes`, source: path, sourceHandle: 'yes', target: yes.entry, label: 'Yes', insert: { list: `${path}.then`, index: 0 } },
      { id: `${path}>no`, source: path, sourceHandle: 'no', target: no.entry, label: 'No', insert: { list: `${path}.else`, index: 0 } },
      ...yes.exits.map((exit) => ({ id: `${exit}>${join.id}`, source: exit, target: join.id, insert: { list: `${path}.then`, index: step.then.length } })),
      ...no.exits.map((exit) => ({ id: `${exit}>${join.id}`, source: exit, target: join.id, insert: { list: `${path}.else`, index: step.else.length } })),
    ];
    return { nodes: [decision, ...yes.nodes, ...no.nodes, join], edges, width: yes.width + COLUMN + no.width, height: joinY + JOIN - y, entry: path, exits: [join.id] };
  }
  if (step.type === 'each' || step.type === 'try') {
    const header = box();
    const inside = layoutList(definition, step.steps, `${path}.steps`, x + INDENT, y + H + GAP);
    const nodes: CanvasNode[] = [header, ...inside.nodes];
    const edges: CanvasEdge[] = [...inside.edges, { id: `${path}>in`, source: path, target: inside.entry, insert: { list: `${path}.steps`, index: 0 } }];
    let width = INDENT + inside.width;
    let bottom = y + H + GAP + inside.height;
    if (step.type === 'try') {
      const handlerX = x + INDENT + inside.width + COLUMN;
      const handler = layoutList(definition, step.catch, `${path}.catch`, handlerX, y + H + GAP);
      nodes.push(...handler.nodes);
      edges.push(...handler.edges, { id: `${path}>fail`, source: path, sourceHandle: 'fail', target: handler.entry, label: 'If it fails', insert: { list: `${path}.catch`, index: 0 } });
      width = handlerX - x + handler.width;
      bottom = Math.max(bottom, y + H + GAP + handler.height);
      const join: CanvasNode = { id: `${path}:join`, kind: 'join', x: W / 2 - JOIN / 2 + x, y: bottom + GAP, width: JOIN, height: JOIN };
      nodes.push(join);
      for (const exit of inside.exits) edges.push({ id: `${exit}>${join.id}`, source: exit, target: join.id, insert: { list: `${path}.steps`, index: step.steps.length } });
      for (const exit of handler.exits) edges.push({ id: `${exit}>${join.id}`, source: exit, target: join.id, insert: { list: `${path}.catch`, index: step.catch.length } });
      const frame: CanvasNode = { id: `${path}:frame`, kind: 'frame', x: x - PAD, y: y - PAD, width: INDENT + inside.width + 2 * PAD, height: bottom - y + 2 * PAD, path, step };
      return { nodes: [frame, ...nodes], edges, width, height: bottom + GAP + JOIN - y, entry: path, exits: [join.id] };
    }
    // A loop's last step goes back to its top; once every item is done, the flow goes on below.
    const next: CanvasNode = { id: `${path}:next`, kind: 'join', x: W / 2 - JOIN / 2 + x, y: bottom + GAP, width: JOIN, height: JOIN };
    nodes.push(next);
    for (const exit of inside.exits) edges.push({ id: `${exit}>${next.id}`, source: exit, target: next.id, insert: { list: `${path}.steps`, index: step.steps.length } });
    edges.push({ id: `${next.id}>back`, source: next.id, sourceHandle: 'next', target: path, back: true, label: 'Next item' });
    const frame: CanvasNode = { id: `${path}:frame`, kind: 'frame', x: x - PAD, y: y - PAD, width: width + 2 * PAD, height: bottom + GAP + JOIN - y + 2 * PAD, path, step };
    return { nodes: [frame, ...nodes], edges, width, height: bottom + GAP + JOIN - y, entry: path, exits: [next.id] };
  }
  const node = box();
  // A return ends the flow: nothing follows it.
  return { nodes: [node], edges: [], width: W, height: H, entry: path, exits: step.type === 'return' ? [] : [path] };
}
