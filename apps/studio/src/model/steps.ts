import type { Definition, Field } from '../types.js';
import { isGroup, opLabel, recordChoices, relativeWords, toModel, type Clause, type Condition, type Group } from './conditions.js';
import { lineOwner } from './edit.js';
import { writableFields } from './logic.js';

/**
 * An action's steps as builders edit them (design §6.2): set a value, add a line, check and
 * branch. Each edit returns a new definition. A step is found by its place: its
 * index, and for a step inside a branch, the side and its index there.
 */

type Action = Definition['actions'][string];
export type Step = NonNullable<Action['steps']>[number];
export type SimpleStep = Exclude<Step, { type: 'if' }>;
export type StepType = Step['type'];
export type Expression = Extract<Step, { type: 'set' }>['value'];

export interface StepPlace {
  readonly index: number;
  /** For a step inside a branch: which side, and where on it. */
  readonly side?: 'then' | 'else';
  readonly inner?: number;
}

const clone = <T>(value: T): T => structuredClone(value);
type Branch = Extract<Step, { type: 'if' }>;
/** One side of a branch. A draft not yet checked can lack its otherwise side. */
export const sideOf = (step: Branch, side: 'then' | 'else'): SimpleStep[] => (step[side] ?? []) as SimpleStep[];

export const STEP_NAMES: Readonly<Record<StepType, string>> = {
  set: 'Set a value',
  add_line: 'Add a line',
  check: 'Check',
  if: 'Branch',
};

/** Fields a step can set: written by the caller, not lines, files or worked out from lines. */
export function settableFields(definition: Definition, entity: string): Field[] {
  const writable = writableFields(definition, entity);
  return (definition.entities[entity]?.fields ?? []).filter((f) => writable.includes(f.name) && f.type !== 'lines' && f.type !== 'file');
}

/** The lines fields of an entity, which an "add a line" step can add to. */
export function linesFields(definition: Definition, entity: string): Array<Extract<Field, { type: 'lines' }>> {
  return (definition.entities[entity]?.fields ?? []).filter((f): f is Extract<Field, { type: 'lines' }> => f.type === 'lines');
}

/** A value that suits a field, to start from: today for a date, the person for a person field. */
export function startingValue(field: Field): Expression {
  switch (field.type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'choice':
      return field.multiple ? [] : (field.options[0]?.value ?? '');
    case 'date':
      return { today: true };
    case 'datetime':
      return { now: true };
    case 'user':
      return { ref: 'principal.id' };
    default:
      return '';
  }
}

const firstTest = (definition: Definition, entity: string): Condition => {
  const field = definition.entities[entity]?.titleField ?? settableFields(definition, entity)[0]?.name ?? 'owner';
  return { exists: `record.${field}` };
};

/** A new step of a type, with defaults that pass the platform's checks. Undefined when the entity has nothing to set or add to. */
export function newStep(definition: Definition, entity: string, type: StepType): Step | undefined {
  switch (type) {
    case 'set': {
      const field = settableFields(definition, entity)[0];
      return field ? { type, field: field.name, value: startingValue(field) } : undefined;
    }
    case 'add_line': {
      const lines = linesFields(definition, entity)[0];
      if (!lines) return undefined;
      const lineEntity = definition.entities[lines.entity];
      const values = Object.fromEntries(
        (lineEntity?.fields ?? []).filter((f) => f.required && f.type !== 'file' && !('default' in f && f.default !== undefined)).map((f) => [f.name, startingValue(f)]),
      );
      return { type, field: lines.name, values };
    }
    case 'check':
      return { type, assert: firstTest(definition, entity), message: 'Say what must hold, and why', severity: 'error' };
    case 'if': {
      const when = firstTest(definition, entity);
      return { type, when, then: [{ type: 'check', assert: when, message: 'Say what must hold, and why', severity: 'warning' }], else: [] };
    }
  }
}

/** Where a step is, as the list of steps it is in and its index there. */
function locate(steps: Step[], place: StepPlace): { list: Step[]; at: number } | undefined {
  if (place.side === undefined) return place.index < steps.length ? { list: steps, at: place.index } : undefined;
  const branch = steps[place.index];
  if (branch?.type !== 'if' || place.inner === undefined) return undefined;
  const list = sideOf(branch, place.side) as Step[];
  return place.inner < list.length ? { list, at: place.inner } : undefined;
}

function editSteps(definition: Definition, action: string, edit: (steps: Step[]) => void): Definition {
  const next = clone(definition);
  const target = next.actions[action]!;
  const steps = [...(target.steps ?? [])];
  edit(steps);
  if (steps.length) target.steps = steps;
  else delete target.steps;
  return next;
}

export function stepAt(definition: Definition, action: string, place: StepPlace): Step | undefined {
  const steps = definition.actions[action]?.steps ?? [];
  const found = locate(steps as Step[], place);
  return found ? found.list[found.at] : undefined;
}

/** Add a step at the end of the action, or at the end of one side of a branch. Returns where it went. */
export function addStep(definition: Definition, action: string, type: StepType, into?: { readonly index: number; readonly side: 'then' | 'else' }): { definition: Definition; place?: StepPlace } {
  const entity = definition.actions[action]!.entity;
  const step = newStep(definition, entity, type);
  if (!step || (into && step.type === 'if')) return { definition };
  let place: StepPlace | undefined;
  const next = editSteps(definition, action, (steps) => {
    if (!into) {
      steps.push(step);
      place = { index: steps.length - 1 };
      return;
    }
    const branch = steps[into.index];
    if (branch?.type !== 'if') return;
    const side = [...sideOf(branch, into.side), step as SimpleStep];
    steps[into.index] = { ...branch, [into.side]: side };
    place = { index: into.index, side: into.side, inner: side.length - 1 };
  });
  return { definition: next, ...(place ? { place } : {}) };
}

export function updateStep(definition: Definition, action: string, place: StepPlace, step: Step): Definition {
  return editSteps(definition, action, (steps) => {
    if (place.side === undefined) {
      steps[place.index] = step;
      return;
    }
    const branch = steps[place.index];
    if (branch?.type !== 'if' || place.inner === undefined || step.type === 'if') return;
    const side = [...sideOf(branch, place.side)];
    side[place.inner] = step;
    steps[place.index] = { ...branch, [place.side]: side };
  });
}

export function removeStep(definition: Definition, action: string, place: StepPlace): Definition {
  return editSteps(definition, action, (steps) => {
    if (place.side === undefined) {
      steps.splice(place.index, 1);
      return;
    }
    const branch = steps[place.index];
    if (branch?.type !== 'if' || place.inner === undefined) return;
    steps[place.index] = { ...branch, [place.side]: sideOf(branch, place.side).filter((_, i) => i !== place.inner) };
  });
}

/** Move a step up or down within its list. */
export function moveStep(definition: Definition, action: string, place: StepPlace, by: -1 | 1): Definition {
  const steps = (definition.actions[action]?.steps ?? []) as Step[];
  const found = locate(steps, place);
  if (!found) return definition;
  const to = found.at + by;
  if (to < 0 || to >= found.list.length) return definition;
  return editSteps(definition, action, (draft) => {
    const list = place.side === undefined ? draft : ([...sideOf(draft[place.index] as Branch, place.side)] as Step[]);
    const [moved] = list.splice(found.at, 1);
    list.splice(to, 0, moved!);
    if (place.side !== undefined) draft[place.index] = { ...(draft[place.index] as Branch), [place.side]: list as SimpleStep[] };
  });
}

// Words

const OPERATOR_WORDS = { add: '+', sub: '−', mul: '×', div: '÷' } as const;

function refLabel(definition: Definition, entity: string, ref: string): string {
  if (ref === 'principal.id') return 'the person running it';
  if (ref.startsWith('principal.')) return `the person's ${ref.slice('principal.'.length)}`;
  const choice = recordChoices(definition, entity).find((c) => c.ref === ref);
  if (choice) return choice.label;
  if (ref === 'record.id') return 'the record\'s ID';
  return ref.slice(ref.indexOf('.') + 1);
}

/** An expression in a few words: "the person running it", "Total (SGD) × 0.09", "today". */
const isList = (value: unknown): value is readonly string[] => Array.isArray(value);

export function describeExpression(definition: Definition, entity: string, expression: Expression): string {
  if (expression === null) return 'nothing';
  if (isList(expression)) return expression.length ? expression.join(', ') : 'none';
  if (typeof expression === 'string') return `“${expression}”`;
  if (typeof expression !== 'object') return String(expression);
  if ('ref' in expression) return refLabel(definition, entity, expression.ref);
  if ('today' in expression) return 'today';
  if ('now' in expression) return 'now';
  if ('round' in expression) return `${describeExpression(definition, entity, expression.round[0])}, rounded to ${expression.round[1]} places`;
  if ('concat' in expression) return expression.concat.map((part) => describeExpression(definition, entity, part)).join(' + ');
  for (const op of ['add', 'sub', 'mul', 'div'] as const) {
    if (op in expression) {
      const operands = (expression as Record<string, readonly Expression[]>)[op]!;
      return operands.map((part) => describeExpression(definition, entity, part)).join(` ${OPERATOR_WORDS[op]} `);
    }
  }
  const said = (part: Expression) => describeExpression(definition, entity, part);
  if ('add_days' in expression) return `${said(expression.add_days[0])} + ${said(expression.add_days[1])} days`;
  if ('add_hours' in expression) return `${said(expression.add_hours[0])} + ${said(expression.add_hours[1])} hours`;
  if ('days_between' in expression) return `the days from ${said(expression.days_between[0])} to ${said(expression.days_between[1])}`;
  if ('if' in expression) return `${said(expression.if[1])} if ${describeCondition(definition, entity, expression.if[0])}, else ${said(expression.if[2])}`;
  if ('upper' in expression) return `${said(expression.upper[0])} in capitals`;
  if ('lower' in expression) return `${said(expression.lower[0])} in small letters`;
  if ('trim' in expression) return `${said(expression.trim[0])}, without spaces at its ends`;
  if ('text_length' in expression) return `the length of ${said(expression.text_length[0])}`;
  if ('left' in expression) return `the first ${said(expression.left[1])} characters of ${said(expression.left[0])}`;
  if ('coalesce' in expression) return expression.coalesce.map(said).join(', or else ');
  return 'a formula';
}

function describeClause(definition: Definition, entity: string, clause: Clause): string {
  const left = refLabel(definition, entity, clause.ref);
  const right = clause.right
    ? clause.right.kind === 'ref'
      ? refLabel(definition, entity, clause.right.ref)
      : clause.right.kind === 'relative'
        ? relativeWords(clause.right)
        : Array.isArray(clause.right.value)
          ? clause.right.value.join(', ')
          : String(clause.right.value)
    : '';
  return `${left} ${opLabel(clause.op, clause.right?.kind === 'relative' ? 'date' : 'other')}${right ? ` ${right}` : ''}`;
}

function describeGroup(definition: Definition, entity: string, group: Group): string {
  return group.items.map((item) => (isGroup(item) ? `(${describeGroup(definition, entity, item)})` : describeClause(definition, entity, item))).join(group.match === 'all' ? ' and ' : ' or ');
}

/** A condition in words: "Total (SGD) is more than 1000". */
export function describeCondition(definition: Definition, entity: string, condition: Condition): string {
  const model = toModel(condition);
  return model ? describeGroup(definition, entity, model) : 'a condition';
}

/** A step in a line: what it does, in words. */
export function describeStep(definition: Definition, entity: string, step: Step): string {
  const fieldLabel = (name: string, of = entity) => definition.entities[of]?.fields.find((f) => f.name === name)?.label ?? name;
  switch (step.type) {
    case 'set':
      return `Set ${fieldLabel(step.field)} to ${describeExpression(definition, entity, step.value)}`;
    case 'add_line': {
      const lines = linesFields(definition, entity).find((f) => f.name === step.field);
      const values = Object.entries(step.values).map(([name, value]) => `${fieldLabel(name, lines?.entity)} ${describeExpression(definition, entity, value)}`);
      return `Add a line to ${lines?.label ?? step.field}${values.length ? `: ${values.join(', ')}` : ''}`;
    }
    case 'check':
      return `${step.severity === 'warning' ? 'Warn' : 'Stop'} unless ${describeCondition(definition, entity, step.assert)}: ${step.message}`;
    case 'if':
      return `If ${describeCondition(definition, entity, step.when)}`;
  }
}

/** A field went: steps that set it go, and so do lines' values for it. Values that use it are reported when the draft is checked. */
export function forgetStepField(definition: Definition, entity: string, field: string): void {
  const owner = lineOwner(definition, entity);
  const keep = (step: SimpleStep, actionEntity: string): boolean => {
    if (owner) {
      if (step.type === 'add_line' && actionEntity === owner.parent && step.field === owner.field) delete step.values[field];
      return true;
    }
    if (actionEntity !== entity) return true;
    return !((step.type === 'set' || step.type === 'add_line') && step.field === field);
  };
  for (const action of Object.values(definition.actions)) {
    if (!action.steps) continue;
    const steps = action.steps.flatMap((step): Step[] => {
      if (step.type !== 'if') return keep(step, action.entity) ? [step] : [];
      return [{ ...step, then: sideOf(step, 'then').filter((inner) => keep(inner, action.entity)), else: sideOf(step, 'else').filter((inner) => keep(inner, action.entity)) }];
    });
    if (steps.length) action.steps = steps;
    else delete action.steps;
  }
}

// Where a value can come from

type ValueKind = 'text' | 'multi' | 'number' | 'boolean' | 'date' | 'datetime' | 'person' | 'record' | 'file' | 'id';

function kindOfField(field: Field): ValueKind | null {
  switch (field.type) {
    case 'text':
    case 'email':
      return 'text';
    case 'choice':
      return field.multiple ? 'multi' : 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'user':
      return 'person';
    case 'reference':
      return 'record';
    case 'file':
      return 'file';
    case 'lines':
      return null;
  }
}

const SYSTEM_SOURCES: ReadonlyArray<{ ref: string; label: string; kind: ValueKind }> = [
  { ref: 'record.id', label: "The record's ID", kind: 'id' },
  { ref: 'record.owner', label: 'Owner', kind: 'person' },
  { ref: 'record.created_by', label: 'Created by', kind: 'person' },
  { ref: 'record.updated_by', label: 'Last changed by', kind: 'person' },
  { ref: 'record.created_at', label: 'Created', kind: 'datetime' },
  { ref: 'record.updated_at', label: 'Last changed', kind: 'datetime' },
];

/**
 * The record's fields a value can come from. For a field, those that hold the same kind of value;
 * a date takes a time's day. Without a target, every field but files.
 */
export function valueSources(definition: Definition, entity: string, target?: Field | 'number' | 'date'): Array<{ ref: string; label: string }> {
  const own = (definition.entities[entity]?.fields ?? []).flatMap((field) => {
    const kind = kindOfField(field);
    return kind ? [{ ref: `record.${field.name}`, label: field.label, kind, entity: field.type === 'reference' ? field.entity : undefined }] : [];
  });
  const all = [...own, ...SYSTEM_SOURCES.map((source) => ({ ...source, entity: undefined }))];
  if (!target) return all.filter((source) => source.kind !== 'file').map(({ ref, label }) => ({ ref, label }));
  const wanted = target === 'number' || target === 'date' ? target : kindOfField(target);
  return all
    .filter((source) => {
      if (target !== 'number' && target !== 'date' && target.type === 'reference') return source.kind === 'record' && source.entity === target.entity;
      return source.kind === wanted || (wanted === 'date' && source.kind === 'datetime');
    })
    .map(({ ref, label }) => ({ ref, label }));
}

// Calculations and joined text, as the value editor shows them

export const CALC_OPS = ['add', 'sub', 'mul', 'div'] as const;
export type CalcOp = (typeof CALC_OPS)[number];
/** One side of a calculation, or one part of joined text: a value typed in, or a field. */
export type Operand = number | string | { readonly ref: string };

const isOperand = (value: Expression): value is Operand =>
  typeof value === 'number' || typeof value === 'string' || (value !== null && typeof value === 'object' && !isList(value) && 'ref' in value && Object.keys(value).length === 1);

/** A calculation of two operands, if the expression is one the editor can show. */
export function calcOf(expression: Expression): { op: CalcOp; a: Operand; b: Operand } | undefined {
  if (expression === null || typeof expression !== 'object' || isList(expression)) return undefined;
  const found: [CalcOp, readonly Expression[]] | undefined =
    'add' in expression ? ['add', expression.add] : 'sub' in expression ? ['sub', expression.sub] : 'mul' in expression ? ['mul', expression.mul] : 'div' in expression ? ['div', expression.div] : undefined;
  if (!found) return undefined;
  const [op, operands] = found;
  const [a, b] = operands;
  if (operands.length !== 2 || a === undefined || b === undefined || !isOperand(a) || !isOperand(b) || typeof a === 'string' || typeof b === 'string') return undefined;
  return { op, a, b };
}

export function calc(op: CalcOp, a: Operand, b: Operand): Expression {
  switch (op) {
    case 'add':
      return { add: [a, b] };
    case 'sub':
      return { sub: [a, b] };
    case 'mul':
      return { mul: [a, b] };
    case 'div':
      return { div: [a, b] };
  }
}

/** A date or a time that a function reads: a field, or today or now. */
export type Moment = { readonly ref: string } | { readonly today: true } | { readonly now: true };
const isMoment = (value: Expression | undefined): value is Moment =>
  value !== null && typeof value === 'object' && !isList(value) && (('ref' in value && Object.keys(value).length === 1) || 'today' in value || 'now' in value);

/** A date or a time so many days or hours away, if the expression is one the editor can show. */
export function shiftOf(expression: Expression): { op: 'add_days' | 'add_hours'; from: Moment; by: Operand } | undefined {
  if (expression === null || typeof expression !== 'object' || isList(expression)) return undefined;
  const found = 'add_days' in expression ? (['add_days', expression.add_days] as const) : 'add_hours' in expression ? (['add_hours', expression.add_hours] as const) : undefined;
  if (!found) return undefined;
  const [from, by] = found[1];
  return isMoment(from) && by !== undefined && isOperand(by) && typeof by !== 'string' ? { op: found[0], from, by } : undefined;
}

export function shift(op: 'add_days' | 'add_hours', from: Moment, by: Operand): Expression {
  return op === 'add_hours' ? { add_hours: [from, by] } : { add_days: [from, by] };
}

/** The days between two dates or times, if the expression is one the editor can show. */
export function betweenOf(expression: Expression): { from: Moment; to: Moment } | undefined {
  if (expression === null || typeof expression !== 'object' || isList(expression) || !('days_between' in expression)) return undefined;
  const [from, to] = expression.days_between;
  return isMoment(from) && isMoment(to) ? { from, to } : undefined;
}

/** One of two values, by a condition, if the expression is one. */
export function chooseOf(expression: Expression): { when: Condition; then: Expression; otherwise: Expression } | undefined {
  if (expression === null || typeof expression !== 'object' || isList(expression) || !('if' in expression)) return undefined;
  const [when, then, otherwise] = expression.if;
  return { when, then, otherwise };
}

export const TEXT_FNS = ['upper', 'lower', 'trim', 'left', 'text_length'] as const;
export type TextFn = (typeof TEXT_FNS)[number];
/** Text changed by a function, or its length, if the expression is one the editor can show. */
export function textFnOf(expression: Expression): { fn: TextFn; of: Operand; count: number } | undefined {
  if (expression === null || typeof expression !== 'object' || isList(expression)) return undefined;
  for (const fn of TEXT_FNS) {
    if (!(fn in expression)) continue;
    const [of, count] = (expression as Record<string, readonly Expression[]>)[fn]!;
    if (of === undefined || !isOperand(of)) return undefined;
    return { fn, of, count: typeof count === 'number' ? count : 10 };
  }
  return undefined;
}
export function textFn(fn: TextFn, of: Operand, count: number): Expression {
  switch (fn) {
    case 'left':
      return { left: [of, count] };
    case 'upper':
      return { upper: [of] };
    case 'lower':
      return { lower: [of] };
    case 'trim':
      return { trim: [of] };
    case 'text_length':
      return { text_length: [of] };
  }
}

/** The values, the first filled in of which counts, if the expression is one the editor can show. */
export function firstFilledOf(expression: Expression): Operand[] | undefined {
  if (expression === null || typeof expression !== 'object' || isList(expression) || !('coalesce' in expression)) return undefined;
  return expression.coalesce.every(isOperand) ? [...expression.coalesce].filter(isOperand) : undefined;
}

/** The parts of joined text, if the expression is one the editor can show. */
export function joinOf(expression: Expression): Operand[] | undefined {
  if (expression === null || typeof expression !== 'object' || isList(expression) || !('concat' in expression)) return undefined;
  return expression.concat.every(isOperand) ? [...expression.concat].filter(isOperand) : undefined;
}
