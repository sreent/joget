import { evaluateCondition, type ConditionEnv } from '@platform/authz';
import type { StoredDefinition } from './fields.js';
import { DURATION_PATTERN, type Process, type ProcessElement, type ProcessElementType, type Timer } from './schema.js';
import { conditionRecord, type RecordValues } from './values.js';

/*
 * What a process does, worked out from its definition alone (design §6.10): where a token goes
 * next, when a timer fires, and which actions start a process or complete a task. The engine
 * keeps the state; these functions keep the rules, so the engine and the checks agree.
 */

/** The flows into and out of each element, in the order the process lists them, and the boundary events on each task. */
export interface ProcessGraph {
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  readonly boundaries: ReadonlyMap<string, readonly string[]>;
}

export function processGraph(process: Process): ProcessGraph {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const boundaries = new Map<string, string[]>();
  for (const id of Object.keys(process.elements)) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const [id, flow] of Object.entries(process.flows)) {
    outgoing.get(flow.from)?.push(id);
    incoming.get(flow.to)?.push(id);
  }
  for (const [id, element] of Object.entries(process.elements)) {
    if (element.type !== 'boundaryEvent') continue;
    const list = boundaries.get(element.attachedTo) ?? [];
    list.push(id);
    boundaries.set(element.attachedTo, list);
  }
  return { incoming, outgoing, boundaries };
}

const TYPE_WORDS: Readonly<Record<ProcessElementType, string>> = {
  startEvent: 'Start event',
  endEvent: 'End event',
  userTask: 'User task',
  serviceTask: 'Service task',
  task: 'Task',
  manualTask: 'Manual task',
  exclusiveGateway: 'Exclusive gateway',
  parallelGateway: 'Parallel gateway',
  intermediateCatchEvent: 'Timer',
  boundaryEvent: 'Boundary timer',
};

/** What people call an element: its name, or what it is and its ID. */
export function elementName(process: Process, id: string): string {
  const element = process.elements[id];
  if (!element) return id;
  return element.name ?? `${TYPE_WORDS[element.type]} ${id}`;
}

/**
 * Add an ISO 8601 duration to a time, in UTC. Years and months follow the calendar, and a day
 * past the end of the month stays in it: 31 January and P1M is 28 or 29 February.
 */
export function addDuration(at: Date, duration: string): Date {
  const match = DURATION_PATTERN.exec(duration);
  if (!match) throw new Error(`Not an ISO 8601 duration: ${duration}`);
  const [years, months, weeks, days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number, number];
  const out = new Date(at.getTime());
  if (years || months) {
    const day = out.getUTCDate();
    out.setUTCDate(1);
    out.setUTCMonth(out.getUTCMonth() + years * 12 + months);
    const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
    out.setUTCDate(Math.min(day, last));
  }
  return new Date(out.getTime() + ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/**
 * When a timer that starts now fires: after its duration, or on its date field, at the start of
 * the day (UTC) for a date. Null if the record has no value there.
 */
export function timerFiresAt(timer: Timer, startedAt: Date, record: RecordValues): Date | null {
  if ('duration' in timer) return addDuration(startedAt, timer.duration);
  const value = record[timer.date];
  if (typeof value !== 'string') return null;
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** What a process's conditions read: the record as it is now, and the outcome each user task was last completed with. */
export interface ProcessState {
  readonly record: RecordValues;
  readonly outcomes: Readonly<Record<string, string>>;
}

export function processConditionEnv(state: ProcessState): ConditionEnv {
  return {
    record: conditionRecord(state.record),
    tasks: Object.fromEntries(Object.entries(state.outcomes).map(([id, outcome]) => [id, { outcome }])),
  };
}

export type FlowsOut = { readonly ok: true; readonly flows: readonly string[] } | { readonly ok: false; readonly message: string };

/**
 * The flows a token takes out of an element. An exclusive gateway takes the first flow, in the
 * process's order, whose condition holds, or else its default. A user task takes the flow of the
 * outcome chosen. A parallel gateway takes every flow; other elements have one flow out.
 */
export function flowsOut(process: Process, graph: ProcessGraph, id: string, state: ProcessState, outcome?: string): FlowsOut {
  const element = process.elements[id];
  if (!element) return { ok: false, message: `The process has no element ${id}` };
  const out = graph.outgoing.get(id) ?? [];
  if (element.type === 'exclusiveGateway') {
    if (out.length === 1 && !process.flows[out[0]!]!.when) return { ok: true, flows: out };
    const env = processConditionEnv(state);
    const taken = out.find((flowId) => {
      const flow = process.flows[flowId]!;
      return !flow.default && flow.when !== undefined && evaluateCondition(flow.when, env);
    });
    if (taken) return { ok: true, flows: [taken] };
    const fallback = out.find((flowId) => process.flows[flowId]!.default);
    return fallback ? { ok: true, flows: [fallback] } : { ok: false, message: `${elementName(process, id)}: no flow's condition holds, and it has no default flow` };
  }
  if (element.type === 'userTask') {
    const named = out.filter((flowId) => process.flows[flowId]!.outcome !== undefined);
    if (!named.length) return { ok: true, flows: out };
    const taken = named.filter((flowId) => process.flows[flowId]!.outcome === outcome);
    return taken.length ? { ok: true, flows: taken } : { ok: false, message: `${elementName(process, id)}: no flow leads on from the outcome ${outcome ?? '(none)'}` };
  }
  return { ok: true, flows: out };
}

/** A start event that an action starts when it commits on a record. */
export interface ProcessStart {
  readonly process: string;
  readonly element: string;
}

/** The start events of the app's processes that an action starts. */
export function startsOf(definition: Pick<StoredDefinition, 'processes'>, action: string): ProcessStart[] {
  return Object.entries(definition.processes ?? {}).flatMap(([process, model]) =>
    Object.entries(model.elements).flatMap(([element, el]) => (el.type === 'startEvent' && el.actions.includes(action) ? [{ process, element }] : [])),
  );
}

/** A user task's outcome that runs an action: running the action on the record completes the task. */
export interface ProcessDecision {
  readonly process: string;
  readonly element: string;
  readonly outcome: string;
}

/** The outcomes of the app's user tasks that run an action. */
export function decisionsBy(definition: Pick<StoredDefinition, 'processes'>, action: string): ProcessDecision[] {
  return Object.entries(definition.processes ?? {}).flatMap(([process, model]) =>
    Object.entries(model.elements).flatMap(([element, el]) =>
      el.type === 'userTask' ? el.outcomes.filter((outcome) => outcome.action === action).map((outcome) => ({ process, element, outcome: outcome.name })) : [],
    ),
  );
}

/** The actions a process's service tasks run by themselves, and the a7c skills they start. */
export function processWork(process: Process): { readonly actions: readonly string[]; readonly skills: readonly string[] } {
  const tasks = Object.values(process.elements).filter((element): element is Extract<ProcessElement, { type: 'serviceTask' }> => element.type === 'serviceTask');
  return {
    actions: [...new Set(tasks.flatMap((task) => (task.action ? [task.action] : [])))],
    skills: [...new Set(tasks.flatMap((task) => (task.skill ? [task.skill] : [])))],
  };
}

/** Every service task of the app's processes that starts an a7c skill, with where it is. */
export function processSkillTasks(definition: Pick<StoredDefinition, 'processes'>): Array<{ readonly path: string; readonly name: string; readonly skill: string }> {
  return Object.entries(definition.processes ?? {}).flatMap(([process, model]) =>
    Object.entries(model.elements).flatMap(([id, element]) =>
      element.type === 'serviceTask' && element.skill ? [{ path: `processes.${process}.elements.${id}`, name: element.name, skill: element.skill }] : [],
    ),
  );
}
