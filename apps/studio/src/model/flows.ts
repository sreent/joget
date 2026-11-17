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
 * The canvas (design §6.11), as Ocean's LogicNode draws a3t's flows and Mendix lays out a microflow:
 * left to right, a box for each step, a diamond for each decision, a frame round a loop and round
 * the steps an error handler guards, rings where a flow starts and ends. The layout is the
 * studio's own, so nobody drags a step into place, and a long flow wraps into rows, as text does.
 * Every arrow can take a new step, and an empty list shows a place for one.
 */

export type NodeKind = 'start' | 'end' | 'step' | 'decision' | 'merge' | 'frame' | 'slot' | 'port';
export type Tone = 'reads' | 'changes' | 'outside';

export interface CanvasNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** A step's path, for steps, decisions, frames, and the end a return makes. */
  readonly path?: string;
  /** For a slot: the list it adds to. */
  readonly list?: string;
  readonly step?: FlowStep;
  /** A box's kind of step, in small capitals. */
  readonly kindLabel?: string;
  /** Its words: inside a box, above a diamond, at a frame's head, under a ring. */
  readonly label?: string;
  /** A second line: under a box's words, or a ring's. */
  readonly about?: string;
  /** What the step does, for its icon's colour. */
  readonly tone?: Tone;
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
}

// Sizes at Ocean's root size (15px): a step 11rem by about 5rem, a decision 3.4rem, a ring 2.4rem.
const BOX_W = 165;
const BOX_H = 76;
const RING = 36;
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
  options: { label?: string; insert?: { list: string; index: number }; head?: boolean; near?: boolean } = {},
): Wire {
  const [x1, y1] = from.at;
  const [x2, y2] = to.at;
  let points: Pt[];
  if (from.side === 'right' && to.side === 'left') {
    if (Math.abs(y1 - y2) < 2) points = [from.at, [x2, y1]];
    else {
      const xm = options.near ? x1 + 18 : (x1 + x2) / 2;
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
    head: options.head ?? true,
    ...(options.label ? { label: { text: options.label, at: labelAt } } : {}),
    ...(options.insert && !slot ? { insert: { ...options.insert, at: insertAt } } : {}),
  };
}

/** A step in a few words, for its box: its kind, its words, a line about it, and what it does. */
export function stepWords(definition: Definition, step: FlowStep): { kind: string; words: string; about?: string; tone?: Tone } {
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
      return { kind: 'Runs a flow', words: callee?.label ?? (step.flow || 'a flow'), ...(step.var ? { about: `→ ${step.var}` } : {}), ...(writes ? { tone: 'changes' as const } : {}) };
    }
    case 'total':
      return { kind: 'Count or total', words: step.of, about: `${step.op === 'count' ? 'how many' : `${step.op} of ${step.field ?? ''}`} → ${step.var}` };
    case 'if':
      return { kind: 'Decision', words: conditionWords(definition, step.when) };
    case 'each':
      return { kind: 'For each', words: `For each ${step.as} in ${step.in}` };
    case 'try':
      return { kind: 'Handle errors', words: 'Handle errors', about: step.rollback === false ? 'keeps what it did' : 'undoes what it did' };
    case 'return':
      return { kind: 'Ends', words: 'Ends', ...(step.value !== undefined ? { about: `returns ${valueText(step.value)}` } : {}) };
  }
}

/** Every step of a list of steps, nested ones too, with its path. */
function flowSteps(steps: readonly FlowStep[], base = 'steps'): Array<{ step: FlowStep; path: string }> {
  return steps.flatMap((step, index) => {
    const path = `${base}[${index}]`;
    const inner =
      step.type === 'each' ? flowSteps(step.steps, `${path}.steps`)
      : step.type === 'if' ? [...flowSteps(step.then, `${path}.then`), ...flowSteps(step.else, `${path}.else`)]
      : step.type === 'try' ? [...flowSteps(step.steps, `${path}.steps`), ...flowSteps(step.catch, `${path}.catch`)]
      : [];
    return [{ step, path }, ...inner];
  });
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

function listPiece(definition: Definition, steps: readonly FlowStep[], list: string): Piece {
  if (!steps.length) return slotPiece(list);
  let x = 0;
  let up = 0;
  let down = 0;
  const nodes: CanvasNode[] = [];
  const all: Wire[] = [];
  let entry: Anchor | undefined;
  let exits: Anchor[] = [];
  steps.forEach((step, index) => {
    const piece = moved(stepPiece(definition, step, `${list}[${index}]`), x + (index ? GAP : 0), 0);
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

function stepPiece(definition: Definition, step: FlowStep, path: string): Piece {
  const words = stepWords(definition, step);
  if (step.type === 'if') {
    const yes = listPiece(definition, step.then, `${path}.then`);
    const no = listPiece(definition, step.else, `${path}.else`);
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
    const mx = bx + width + GAP;
    const merge: CanvasNode = { id: `${path}:merge`, kind: 'merge', x: mx, y: -MERGE / 2, width: MERGE, height: MERGE };
    for (const exit of placedYes.exits) all.push(wire(exit, { id: merge.id, at: [mx, 0], side: 'left' }, { insert: { list: `${path}.then`, index: step.then.length } }));
    for (const exit of placedNo.exits) all.push(wire(exit, { id: merge.id, at: [mx + MERGE / 2, MERGE / 2], side: 'bottom' }, { insert: { list: `${path}.else`, index: step.else.length } }));
    return {
      width: mx + MERGE,
      up: Math.max(DIAMOND / 2 + 40, yes.up),
      down: noY + no.down,
      nodes: [...nodes, merge],
      wires: all,
      entry: left,
      exits: [{ id: merge.id, at: [mx + MERGE, 0], side: 'right' }],
    };
  }
  if (step.type === 'each' || step.type === 'try') {
    const inner = moved(listPiece(definition, step.steps, `${path}.steps`), PAD_X, 0);
    const frameW = PAD_X + inner.width + PAD_X;
    const top = -(inner.up + PAD_TOP);
    const bottom = inner.down + PAD_BOTTOM;
    const frame: CanvasNode = { id: path, kind: 'frame', x: 0, y: top, width: frameW, height: bottom - top, path, step, label: words.words, ...(words.about ? { about: words.about } : {}) };
    const portIn: CanvasNode = { id: `${path}:in`, kind: 'port', x: 0, y: 0, width: 0, height: 0 };
    const portOut: CanvasNode = { id: `${path}:out`, kind: 'port', x: frameW, y: 0, width: 0, height: 0 };
    const inAnchor: Anchor = { id: portIn.id, at: [0, 0], side: 'left' };
    const outAnchor: Anchor = { id: portOut.id, at: [frameW, 0], side: 'right' };
    const all = [
      ...inner.wires,
      wire({ ...inAnchor, side: 'right' }, inner.entry, { insert: { list: `${path}.steps`, index: 0 } }),
      ...inner.exits.map((exit) => wire(exit, { ...outAnchor, side: 'left' }, { insert: { list: `${path}.steps`, index: step.steps.length }, head: false })),
    ];
    const nodes = [frame, portIn, portOut, ...inner.nodes];
    if (step.type === 'each') return { width: frameW, up: -top + 14, down: bottom, nodes, wires: all, entry: inAnchor, exits: [outAnchor] };
    // An error handler: its way if the steps fail turns down to the steps that run then, and meets the way on.
    const handler = listPiece(definition, step.catch, `${path}.catch`);
    const hx = frameW + BRANCH_GAP;
    const hy = bottom + ROW + handler.up;
    const placed = moved(handler, hx, hy);
    const mx = hx + handler.width + GAP;
    const merge: CanvasNode = { id: `${path}:merge`, kind: 'merge', x: mx, y: -MERGE / 2, width: MERGE, height: MERGE };
    all.push(
      ...placed.wires,
      wire(outAnchor, { id: merge.id, at: [mx, 0], side: 'left' }, { label: 'done' }),
      wire(outAnchor, placed.entry, { label: 'if it fails', near: true, insert: { list: `${path}.catch`, index: 0 } }),
      ...placed.exits.map((exit) => wire(exit, { id: merge.id, at: [mx + MERGE / 2, MERGE / 2], side: 'bottom' }, { insert: { list: `${path}.catch`, index: step.catch.length } })),
    );
    return { width: mx + MERGE, up: -top + 14, down: hy + handler.down, nodes: [...nodes, ...placed.nodes, merge], wires: all, entry: inAnchor, exits: [{ id: merge.id, at: [mx + MERGE, 0], side: 'right' }] };
  }
  if (step.type === 'return') {
    const ring: CanvasNode = { id: path, kind: 'end', x: 0, y: -RING / 2, width: RING, height: RING, path, step, label: words.words, ...(words.about ? { about: words.about } : {}) };
    return { width: RING, up: RING / 2 + 8, down: RING / 2 + 44, nodes: [ring], wires: [], entry: { id: path, at: [0, 0], side: 'left' }, exits: [] };
  }
  const box: CanvasNode = {
    id: path,
    kind: 'step',
    x: 0,
    y: -BOX_H / 2,
    width: BOX_W,
    height: BOX_H,
    path,
    step,
    kindLabel: words.kind,
    label: words.words,
    ...(words.about ? { about: words.about } : {}),
    ...(words.tone ? { tone: words.tone } : {}),
  };
  return { width: BOX_W, up: BOX_H / 2 + 14, down: BOX_H / 2 + 16, nodes: [box], wires: [], entry: { id: path, at: [0, 0], side: 'left' }, exits: [{ id: path, at: [BOX_W, 0], side: 'right' }] };
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

/** Lay a flow out for the canvas: left to right, and in rows where it's longer than the width given. */
export function layoutFlow(definition: Definition, flow: AppFlow, maxWidth = 980): { readonly nodes: CanvasNode[]; readonly edges: CanvasEdge[]; readonly width: number; readonly height: number } {
  wires = 0;
  const inputs = Object.keys(flow.input);
  const start: Piece = {
    width: RING,
    up: RING / 2 + 8,
    down: RING / 2 + 44,
    nodes: [{ id: 'start', kind: 'start', x: 0, y: -RING / 2, width: RING, height: RING, label: 'Starts', about: inputs.length ? `with ${inputs.join(', ')}` : 'when it runs' }],
    wires: [],
    entry: { id: 'start', at: [0, 0], side: 'left' },
    exits: [{ id: 'start', at: [RING, 0], side: 'right' }],
  };
  const pieces: Array<{ piece: Piece; index?: number }> = [{ piece: start }];
  if (!flow.steps.length) pieces.push({ piece: slotPiece('steps') });
  flow.steps.forEach((step, index) => pieces.push({ piece: stepPiece(definition, step, `steps[${index}]`), index }));
  const last = pieces[pieces.length - 1]!.piece;
  if (last.exits.length) {
    pieces.push({
      piece: {
        width: RING,
        up: RING / 2 + 8,
        down: RING / 2 + 44,
        nodes: [{ id: 'end', kind: 'end', x: 0, y: -RING / 2, width: RING, height: RING, label: 'Ends', ...(flow.output ? { about: 'with its result' } : {}) }],
        wires: [],
        entry: { id: 'end', at: [0, 0], side: 'left' },
        exits: [],
      },
    });
  }
  // Rows: pieces go on until the next would pass the width, then the flow wraps.
  const rows: Array<typeof pieces> = [[]];
  let x = MARGIN;
  for (const item of pieces) {
    const row = rows[rows.length - 1]!;
    if (row.length && x + item.piece.width > maxWidth) {
      rows.push([item]);
      x = MARGIN + 36 + item.piece.width + GAP;
    } else {
      row.push(item);
      x += item.piece.width + GAP;
    }
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
  const edges: CanvasEdge[] = all.map((w) => {
    const path = pathOf(w.points, w.head);
    return {
      id: w.id,
      source: w.source,
      target: w.target,
      d: path.d,
      ...(path.head ? { head: path.head } : {}),
      ...(w.label ? { label: { text: w.label.text, x: w.label.at[0], y: w.label.at[1] } } : {}),
      ...(w.insert ? { insert: { list: w.insert.list, index: w.insert.index, x: w.insert.at[0], y: w.insert.at[1] } } : {}),
    };
  });
  return { nodes, edges, width, height };
}
