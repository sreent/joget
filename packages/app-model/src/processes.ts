import { evaluateCondition, type Condition, type ConditionEnv } from '@platform/authz';
import type { StoredDefinition } from './fields.js';
import { DURATION_PATTERN, type BoundaryEventElement, type CatchEventElement, type Process, type ProcessElement, type ProcessElementType, type Raised, type Timer, type VoteRule } from './schema.js';
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
  scriptTask: 'Script task',
  businessRuleTask: 'Business rule task',
  sendTask: 'Send task',
  receiveTask: 'Receive task',
  task: 'Task',
  manualTask: 'Manual task',
  exclusiveGateway: 'Exclusive gateway',
  parallelGateway: 'Parallel gateway',
  inclusiveGateway: 'Inclusive gateway',
  complexGateway: 'Complex gateway',
  eventBasedGateway: 'Event-based gateway',
  intermediateCatchEvent: 'Event',
  intermediateThrowEvent: 'Event',
  subProcess: 'Sub-process',
  callActivity: 'Call activity',
  boundaryEvent: 'Boundary event',
};

/** What people call an element: its name, or what it is and its ID. */
export function elementName(process: Process, id: string): string {
  const element = process.elements[id];
  if (!element) return id;
  return element.name ?? `${TYPE_WORDS[element.type]} ${id}`;
}

/** The sub-process an element is in, or undefined in the process itself. An event on a boundary is where its host is. */
export function scopeOf(process: Process, id: string): string | undefined {
  const element = process.elements[id];
  if (element?.type !== 'boundaryEvent') return element?.in;
  const host = process.elements[element.attachedTo];
  return host && host.type !== 'boundaryEvent' ? host.in : undefined;
}

/** The sub-processes an element is inside, the nearest first. Where `in` goes round in a loop, the list stops before it repeats. */
export function scopesOf(process: Process, id: string): string[] {
  const chain: string[] = [];
  for (let scope = scopeOf(process, id); scope !== undefined && !chain.includes(scope); scope = scopeOf(process, scope)) chain.push(scope);
  return chain;
}

/** The elements inside a sub-process at any depth, with the events on their boundaries. */
export function insideOf(process: Process, scope: string): Set<string> {
  return new Set(Object.keys(process.elements).filter((id) => id !== scope && scopesOf(process, id).includes(scope)));
}

/** The start events of the process itself, or of one of its sub-processes. */
export function startEventsOf(process: Process, scope?: string): string[] {
  return Object.entries(process.elements).flatMap(([id, element]) => (element.type === 'startEvent' && element.in === scope ? [id] : []));
}

/** Whether an element is an ad hoc sub-process. */
export function isAdHoc(process: Process, id: string | undefined): boolean {
  const element = id === undefined ? undefined : process.elements[id];
  return element?.type === 'subProcess' && element.adHoc === true;
}

/** What starts at once in an ad hoc sub-process: what is in it and has no flow into it, but its boundary events and catch links. */
export function adHocStarts(process: Process, graph: ProcessGraph, id: string): string[] {
  return Object.entries(process.elements).flatMap(([inner, element]) =>
    element.type !== 'boundaryEvent' &&
    element.in === id &&
    !(element.type === 'intermediateCatchEvent' && element.link !== undefined) &&
    !(element.type === 'subProcess' && element.event) &&
    !(graph.incoming.get(inner) ?? []).length
      ? [inner]
      : [],
  );
}

/** Whether an element is an event sub-process. */
export function isEventSub(process: Process, id: string | undefined): boolean {
  const element = id === undefined ? undefined : process.elements[id];
  return element?.type === 'subProcess' && element.event === true;
}

/** The event sub-processes in the process itself, or in one of its sub-processes, each with its start event. */
export function eventSubsIn(process: Process, scope: string | undefined): Array<{ readonly id: string; readonly start: string }> {
  return Object.entries(process.elements).flatMap(([id, element]) => {
    if (element.type !== 'subProcess' || !element.event || element.in !== scope) return [];
    const start = startEventsOf(process, id)[0];
    return start ? [{ id, start }] : [];
  });
}

/**
 * The event sub-process in the process itself, or in one of its sub-processes, whose start event
 * catches an error or an escalation of a code: the one for that code first, then one for all.
 */
export function eventSubCatcher(
  process: Process,
  scope: string | undefined,
  kind: 'error' | 'escalation',
  code: string | undefined,
  except?: string,
): { readonly id: string; readonly start: string } | undefined {
  // An event sub-process doesn't catch what is raised inside it: that goes on up.
  const catching = eventSubsIn(process, scope).flatMap((sub) => {
    if (sub.id === except) return [];
    const start = process.elements[sub.start];
    const raised = start?.type === 'startEvent' ? start[kind] : undefined;
    return raised !== undefined && catches(raised, code) ? [{ ...sub, all: raised === true }] : [];
  });
  const found = catching.find((each) => !each.all) ?? catching[0];
  return found ? { id: found.id, start: found.start } : undefined;
}

/**
 * Where an instance starts that no action starts: by hand, or from a call activity of another
 * process. That is the process's first start event without actions, or else its first.
 */
export function plainStartOf(process: Process): string | undefined {
  const starts = startEventsOf(process);
  return starts.find((id) => {
    const element = process.elements[id];
    return element?.type === 'startEvent' && !element.actions.length && !element.timer && !element.condition && !element.signal;
  }) ?? starts[0];
}

/** A start event of the process itself that starts on its own: on a record's date or a time after it is created, or when a condition comes to hold. */
export interface AutomaticStart {
  readonly process: string;
  readonly element: string;
  readonly timer?: Timer;
  readonly condition?: Condition;
}

/** The start events of the app's processes about an entity that start by themselves, with a timer or a condition. */
export function automaticStarts(definition: Pick<StoredDefinition, 'processes'>, entity: string): AutomaticStart[] {
  return Object.entries(definition.processes ?? {}).flatMap(([process, model]) =>
    model.entity !== entity
      ? []
      : Object.entries(model.elements).flatMap(([element, el]) =>
          el.type === 'startEvent' && !el.in && (el.timer || el.condition) ? [{ process, element, ...(el.timer ? { timer: el.timer } : {}), ...(el.condition ? { condition: el.condition } : {}) }] : [],
        ),
  );
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
 * outcome chosen, and a rule check the flow of what it found. A parallel gateway takes every
 * flow; other elements have one flow out.
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
  if (element.type === 'inclusiveGateway' || element.type === 'complexGateway') {
    // Every flow whose condition holds, or else the default.
    const env = processConditionEnv(state);
    const taken = out.filter((flowId) => {
      const flow = process.flows[flowId]!;
      return !flow.default && (flow.when === undefined ? out.length === 1 : evaluateCondition(flow.when, env));
    });
    if (taken.length) return { ok: true, flows: taken };
    const fallback = out.find((flowId) => process.flows[flowId]!.default);
    return fallback ? { ok: true, flows: [fallback] } : { ok: false, message: `${elementName(process, id)}: no flow's condition holds, and it has no default flow` };
  }
  if (element.type === 'userTask' || element.type === 'businessRuleTask') {
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

/** The catch link that a throw link goes on at: the one of the same name, in the same sub-process or in the process itself. */
export function linkTarget(process: Process, id: string): string | undefined {
  const element = process.elements[id];
  if (element?.type !== 'intermediateThrowEvent' || element.link === undefined) return undefined;
  const scope = scopeOf(process, id);
  return Object.entries(process.elements).find(([other, candidate]) => candidate.type === 'intermediateCatchEvent' && candidate.link === element.link && scopeOf(process, other) === scope)?.[0];
}

/** Every element a token at an element could still reach, through flows, links and the events on a task's boundary. */
export function reachable(process: Process, graph: ProcessGraph, from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.pop()!;
    const jump = linkTarget(process, id);
    if (jump !== undefined && !seen.has(jump)) {
      seen.add(jump);
      queue.push(jump);
    }
    for (const flowId of graph.outgoing.get(id) ?? []) {
      const to = process.flows[flowId]!.to;
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
    for (const boundary of graph.boundaries.get(id) ?? []) {
      if (!seen.has(boundary)) {
        seen.add(boundary);
        queue.push(boundary);
      }
    }
  }
  return seen;
}

/** What an event waits for: a time, an action saved on the record (a message), a condition on the record, an error, an escalation, a cancel, or a link. */
export function eventKind(event: CatchEventElement | BoundaryEventElement): 'timer' | 'message' | 'error' | 'condition' | 'link' | 'escalation' | 'cancel' | 'signal' {
  if (event.signal !== undefined) return 'signal';
  if (event.message) return 'message';
  if (event.condition) return 'condition';
  if (event.type === 'intermediateCatchEvent' && event.link !== undefined) return 'link';
  if (event.type === 'boundaryEvent' && event.escalation) return 'escalation';
  if (event.type === 'boundaryEvent' && event.cancel) return 'cancel';
  return event.type === 'boundaryEvent' && event.error ? 'error' : 'timer';
}

/** The code of an error or an escalation, if it has one. */
export const raisedCode = (raised: Raised | undefined): string | undefined => (raised === undefined || raised === true ? undefined : raised.code);

/** Whether a catch takes a throw: a catch without a code takes all; one with a code, only the throws of that code. */
export const catches = (catcher: Raised | undefined, thrown: string | undefined): boolean => catcher !== undefined && (catcher === true || catcher.code === thrown);

/** The event on a host's boundary that catches an error or an escalation of a code: the one for that code first, then one for all. */
export function catcherOn(process: Process, graph: ProcessGraph, host: string, kind: 'error' | 'escalation', code: string | undefined): string | undefined {
  const catchers = (graph.boundaries.get(host) ?? []).flatMap((boundary) => {
    const event = process.elements[boundary];
    const raised = event?.type === 'boundaryEvent' ? event[kind] : undefined;
    return raised !== undefined && catches(raised, code) ? [{ boundary, all: raised === true }] : [];
  });
  return (catchers.find((catcher) => !catcher.all) ?? catchers[0])?.boundary;
}

/** The start events of the app's processes about an entity that a signal starts. */
export function signalStarts(definition: Pick<StoredDefinition, 'processes'>, signal: string, entity: string): ProcessStart[] {
  return Object.entries(definition.processes ?? {}).flatMap(([process, model]) =>
    model.entity !== entity ? [] : Object.entries(model.elements).flatMap(([element, el]) => (el.type === 'startEvent' && !el.in && el.signal === signal ? [{ process, element }] : [])),
  );
}

/** The signals that a process waits for: at a catch event, on a boundary, or at a start event. */
export function caughtSignals(process: Process): string[] {
  return [
    ...new Set(
      Object.values(process.elements).flatMap((element) =>
        (element.type === 'intermediateCatchEvent' || element.type === 'boundaryEvent' || element.type === 'startEvent') && element.signal !== undefined ? [element.signal] : [],
      ),
    ),
  ];
}

/** The signals that a process throws: at throw events and end events. */
export function thrownSignals(process: Process): string[] {
  return [...new Set(Object.values(process.elements).flatMap((element) => ((element.type === 'intermediateThrowEvent' || element.type === 'endEvent') && element.signal !== undefined ? [element.signal] : [])))];
}

/** The actions whose commit a process waits for at a message: at a catch event, a receive task, or on a boundary. */
export function messageActions(process: Process): string[] {
  return [
    ...new Set(
      Object.values(process.elements).flatMap((element) =>
        (element.type === 'intermediateCatchEvent' || element.type === 'boundaryEvent' || element.type === 'receiveTask') && element.message
          ? [element.message.action]
          : // An action saved on the record starts an event sub-process, as a message.
            element.type === 'startEvent' && isEventSub(process, element.in)
            ? element.actions
            : [],
      ),
    ),
  ];
}

/** The messages a process sends: from send tasks, and from throw and end events. */
export function sentMessages(process: Process): Array<{ readonly element: string; readonly action: string; readonly record?: string }> {
  return Object.entries(process.elements).flatMap(([id, element]) =>
    (element.type === 'sendTask' || element.type === 'intermediateThrowEvent' || element.type === 'endEvent') && element.message
      ? [{ element: id, action: element.message.action, ...(element.message.record ? { record: element.message.record } : {}) }]
      : [],
  );
}

/** The start events of the app's processes that an action starts. */
export function startsOf(definition: Pick<StoredDefinition, 'processes'>, action: string): ProcessStart[] {
  return Object.entries(definition.processes ?? {}).flatMap(([process, model]) =>
    Object.entries(model.elements).flatMap(([element, el]) => (el.type === 'startEvent' && !el.in && el.actions.includes(action) ? [{ process, element }] : [])),
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

/**
 * What a process does by itself, which a change request names: the actions its service tasks run
 * and its messages send, the a7c skills it starts, the processes it calls, and its script tasks,
 * which change the record with steps.
 */
export function processWork(process: Process): {
  readonly actions: readonly string[];
  readonly skills: readonly string[];
  readonly calls: readonly string[];
  readonly scripts: readonly string[];
} {
  const tasks = Object.values(process.elements).filter((element): element is Extract<ProcessElement, { type: 'serviceTask' }> => element.type === 'serviceTask');
  const undoes = Object.values(process.elements).flatMap((element) => ('undo' in element && element.undo ? [element.undo] : []));
  return {
    actions: [...new Set([...tasks.flatMap((task) => (task.action ? [task.action] : [])), ...sentMessages(process).map((message) => message.action), ...undoes])],
    skills: [...new Set(tasks.flatMap((task) => (task.skill ? [task.skill] : [])))],
    calls: [...new Set(Object.values(process.elements).flatMap((element) => (element.type === 'callActivity' ? [element.process] : [])))],
    scripts: Object.values(process.elements).flatMap((element) => (element.type === 'scriptTask' ? [element.name] : [])),
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

/**
 * The outcome that votes decide, or null while it is still open. `people` is how many vote in all;
 * `votes` the outcomes chosen so far, in order.
 */
export function decideVotes(rule: VoteRule, people: number, votes: readonly string[]): string | null {
  if ('first' in rule) return votes[0] ?? null;
  const needed = rule.count === 'all' ? people : rule.count === 'majority' ? Math.floor(people / 2) + 1 : rule.count;
  const yes = votes.filter((vote) => vote === rule.outcome).length;
  if (yes >= needed) return rule.outcome;
  if (yes + (people - votes.length) < needed) return rule.otherwise;
  return null;
}

/** How many votes a rule needs for its outcome, of `people`; null for the first vote. */
export function votesNeeded(rule: VoteRule, people: number): number | null {
  if ('first' in rule) return null;
  return rule.count === 'all' ? people : rule.count === 'majority' ? Math.floor(people / 2) + 1 : rule.count;
}
