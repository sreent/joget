import type { Condition } from '@platform/authz';
import { mapRefs } from './condition-refs.js';
import type { StoredDefinition } from './fields.js';
import type { AppFlow, Flow, FlowStep, Process, ProcessElement, WaitFor } from './schema.js';

/*
 * Flows that wait (design §6.11). A flow with a person's task, a wait, the first of several waits,
 * or ways that run all at once keeps its place on one record, and runs on the process engine
 * (§6.10). It compiles to the engine's graph: an element for each step that waits, or that decides
 * between ways that wait, named by the step's path; and between them, a task that runs the steps in
 * between as a flow of their own, in one transaction. The record is the flow's data: a value that a
 * flow keeps in a variable doesn't live on across a wait.
 */

type Flows = Readonly<Record<string, AppFlow>> | undefined;

/** The lists of steps that a step holds, with where each is. */
export function innerLists(step: FlowStep, at: string): Array<{ readonly steps: readonly FlowStep[]; readonly path: string }> {
  switch (step.type) {
    case 'each':
      return [{ steps: step.steps, path: `${at}.steps` }];
    case 'if':
      return [
        { steps: step.then, path: `${at}.then` },
        { steps: step.else, path: `${at}.else` },
      ];
    case 'try':
      return [
        { steps: step.steps, path: `${at}.steps` },
        { steps: step.catch, path: `${at}.catch` },
      ];
    case 'task':
      return [
        ...step.outcomes.map((outcome, index) => ({ steps: outcome.steps, path: `${at}.outcomes[${index}].steps` })),
        ...(step.deadline ? [{ steps: step.deadline.steps, path: `${at}.deadline.steps` }] : []),
      ];
    case 'first_of':
    case 'all_at_once':
      return step.ways.map((way, index) => ({ steps: way.steps, path: `${at}.ways[${index}].steps` }));
    default:
      return [];
  }
}

/** A step with each list of steps it holds put through `replace`. */
export function withLists(step: FlowStep, at: string, replace: (steps: readonly FlowStep[], path: string) => FlowStep[]): FlowStep {
  switch (step.type) {
    case 'each':
      return { ...step, steps: replace(step.steps, `${at}.steps`) };
    case 'if':
      return { ...step, then: replace(step.then, `${at}.then`), else: replace(step.else, `${at}.else`) };
    case 'try':
      return { ...step, steps: replace(step.steps, `${at}.steps`), catch: replace(step.catch, `${at}.catch`) };
    case 'task':
      return {
        ...step,
        outcomes: step.outcomes.map((outcome, index) => ({ ...outcome, steps: replace(outcome.steps, `${at}.outcomes[${index}].steps`) })),
        ...(step.deadline ? { deadline: { ...step.deadline, steps: replace(step.deadline.steps, `${at}.deadline.steps`) } } : {}),
      };
    case 'first_of':
      return { ...step, ways: step.ways.map((way, index) => ({ ...way, steps: replace(way.steps, `${at}.ways[${index}].steps`) })) };
    case 'all_at_once':
      return { ...step, ways: step.ways.map((way, index) => ({ ...way, steps: replace(way.steps, `${at}.ways[${index}].steps`) })) };
    default:
      return step;
  }
}

/** Whether a step waits, or holds or calls a step that waits. */
export function stepWaits(step: FlowStep, flows: Flows, seen: ReadonlySet<string> = new Set()): boolean {
  switch (step.type) {
    case 'task':
    case 'wait':
    case 'first_of':
    case 'all_at_once':
      return true;
    case 'call': {
      const callee = seen.has(step.flow) ? undefined : flows?.[step.flow];
      return callee ? callee.steps.some((inner) => stepWaits(inner, flows, new Set([...seen, step.flow]))) : false;
    }
    default:
      return innerLists(step, '').some(({ steps }) => steps.some((inner) => stepWaits(inner, flows, seen)));
  }
}

/** Whether a flow waits for people or for time: then it runs on one record, on the process engine. */
export function flowWaits(flow: AppFlow, flows: Flows): boolean {
  return flow.steps.some((step) => stepWaits(step, flows));
}

/** The record a flow that waits is about: its one input, which holds a record. */
export function flowSubject(flow: AppFlow): { readonly name: string; readonly entity: string } | undefined {
  const inputs = Object.entries(flow.input);
  const [only] = inputs;
  return inputs.length === 1 && only && only[1].type === 'record' ? { name: only[0], entity: only[1].entity } : undefined;
}

/**
 * Whether a step of a flow that waits is a point of the engine's graph: it waits, it ends the
 * flow, or it decides between ways that do. The steps between two such points run in one go.
 */
export function atProcessLevel(step: FlowStep, flows: Flows): boolean {
  if (step.type === 'return') return true;
  if (step.type === 'if') return [...step.then, ...step.else].some((inner) => atProcessLevel(inner, flows));
  return stepWaits(step, flows);
}

/** The ID of the engine's element for a step, from its path: `steps[1].outcomes[0].steps[2]` is `steps_1_outcomes_0_steps_2`. */
export const elementIdOf = (path: string): string => path.replace(/\[(\d+)\]/g, '_$1').replaceAll('.', '_');

/** A duration in words: P3D is "3 days", PT4H "4 hours". Anything else stays as it is written. */
export function durationWords(duration: string): string {
  const match = /^P(?:(\d+)W|(\d+)D|T(\d+)H|T(\d+)M)$/.exec(duration);
  if (!match) return duration;
  const [amount, unit] = match[1] ? [match[1], 'week'] : match[2] ? [match[2], 'day'] : match[3] ? [match[3], 'hour'] : [match[4]!, 'minute'];
  return `${amount} ${unit}${amount === '1' ? '' : 's'}`;
}

/** What a step does, in a word or two: for the name of a stretch of steps on the engine. */
const STEP_WORDS: Readonly<Record<FlowStep['type'], string>> = {
  set: 'set a value',
  find: 'find',
  create: 'create',
  change: 'change',
  delete: 'delete',
  add_line: 'add a line',
  each: 'for each',
  if: 'decide',
  check: 'check',
  call: 'run a flow',
  try: 'handle errors',
  total: 'count or total',
  return: 'end',
  task: 'a task',
  wait: 'wait',
  first_of: 'the first of',
  all_at_once: 'all at once',
};

/** Words in a list: "find, change and check". */
function listed(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** At most a label's length. */
const clip = (text: string): string => (text.length > 100 ? `${text.slice(0, 99)}…` : text);

export interface CompiledFlow {
  readonly process: Process;
  /** The flows that run the steps between two waits, by name. Their names have a dot, so no flow of the app takes one. */
  readonly parts: Readonly<Record<string, AppFlow>>;
  /** The step path of each element and sequence flow: the flow itself is "". */
  readonly at: ReadonlyMap<string, string>;
}

/** What the compiler needs of a definition: its entities' labels, its actions and its flows. */
type Lookup = Pick<StoredDefinition, 'actions' | 'flows'> & { readonly entities: Readonly<Record<string, { readonly fields: ReadonlyArray<{ readonly name: string; readonly label: string }> }>> };

/**
 * Compile a flow that waits to the engine's graph. The actions that run the flow start it on their
 * record. Gives undefined for a flow that doesn't wait, or that has no record to keep its place on.
 */
export function compileFlow(definition: Lookup, name: string, flow: AppFlow): CompiledFlow | undefined {
  const flows = definition.flows;
  const subject = flowSubject(flow);
  if (!subject || !flowWaits(flow, flows)) return undefined;
  const fields = definition.entities[subject.entity]?.fields ?? [];
  const elements: Record<string, ProcessElement> = {};
  const sequence: Record<string, Flow> = {};
  const parts: Record<string, AppFlow> = {};
  const at = new Map<string, string>();
  let count = 0;

  /** A way out of an element that leads on to the next one: with an outcome, a condition or a name. */
  interface End {
    readonly from: string;
    readonly flow?: Omit<Flow, 'from' | 'to'>;
    readonly at?: string;
  }
  /** The flow's own references to its record, as the engine reads the record: `leave.days` is `record.days`. */
  const onRecord = (condition: Condition): Condition =>
    mapRefs(condition, (ref) => (ref === subject.name ? 'record.id' : ref.startsWith(`${subject.name}.`) ? `record.${ref.slice(subject.name.length + 1)}` : ref));
  const add = (path: string, element: ProcessElement, id = elementIdOf(path)): string => {
    elements[id] = element;
    at.set(id, path);
    return id;
  };
  const connect = (ends: readonly End[], to: string): void => {
    for (const end of ends) {
      const id = `flow_${++count}`;
      sequence[id] = { from: end.from, to, ...end.flow };
      at.set(id, end.at ?? at.get(end.from) ?? '');
    }
  };
  /** Ways that meet: one goes on as it is; several meet first. */
  const meet = (ends: readonly End[], path: string): End[] => {
    if (ends.length < 2) return [...ends];
    const id = add(path, { type: 'exclusiveGateway', name: 'Where the ways meet' }, `${elementIdOf(path)}_meet`);
    connect(ends, id);
    return [{ from: id }];
  };
  const fieldLabel = (field: string) => fields.find((f) => f.name === field)?.label ?? field;
  const waitName = (wait: WaitFor): string =>
    clip(
      'duration' in wait
        ? `Waits ${durationWords(wait.duration)}`
        : 'date' in wait
          ? `Waits until ${fieldLabel(wait.date)}`
          : 'action' in wait
            ? `Waits for ${definition.actions[wait.action]?.label ?? wait.action}`
            : 'condition' in wait
              ? 'Waits until it holds'
              : `Waits for the signal ${wait.signal}`,
    );
  const waitEvent = (wait: WaitFor) =>
    'duration' in wait
      ? { timer: { duration: wait.duration } }
      : 'date' in wait
        ? { timer: { date: wait.date } }
        : 'action' in wait
          ? { message: { action: wait.action } }
          : 'condition' in wait
            ? { condition: onRecord(wait.condition) }
            : { signal: wait.signal };

  /** A stretch of steps that runs in one go: a task of the engine runs them as a flow of their own. */
  const stretch = (steps: FlowStep[], path: string, ends: readonly End[]): End[] => {
    const id = elementIdOf(path);
    const label = clip(`${flow.label}: ${listed([...new Set(steps.map((step) => STEP_WORDS[step.type]))])}`);
    parts[`${name}.${id}`] = { label, input: { [subject.name]: { type: 'record', entity: subject.entity } }, steps };
    add(path, { type: 'serviceTask', name: label, flow: { flow: `${name}.${id}`, input: { [subject.name]: { ref: 'record' } } } }, id);
    connect(ends, id);
    return [{ from: id }];
  };

  const list = (steps: readonly FlowStep[], base: string, ends: readonly End[]): End[] => {
    let current = [...ends];
    let run: { steps: FlowStep[]; path: string } | undefined;
    for (const [index, step] of steps.entries()) {
      const path = `${base}[${index}]`;
      if (!atProcessLevel(step, flows)) {
        run ??= { steps: [], path };
        run.steps.push(step);
        continue;
      }
      if (run) current = stretch(run.steps, run.path, current);
      run = undefined;
      current = point(step, path, current);
      // Nothing after the end of the flow runs.
      if (!current.length) return current;
    }
    return run ? stretch(run.steps, run.path, current) : current;
  };

  const point = (step: FlowStep, path: string, ends: readonly End[]): End[] => {
    const id = elementIdOf(path);
    switch (step.type) {
      case 'task': {
        add(path, {
          type: 'userTask',
          name: step.label,
          ...(step.description ? { description: step.description } : {}),
          role: step.role,
          ...(step.assignee ? { assignee: step.assignee } : {}),
          ...(step.department ? { department: step.department } : {}),
          ...(step.several ? { several: step.several } : {}),
          outcomes: step.outcomes.map((outcome) => ({ name: outcome.name, label: outcome.label, ...(outcome.action ? { action: outcome.action } : {}) })),
          ...(step.due ? { due: step.due } : {}),
          ...(step.card ? { card: step.card } : {}),
        });
        connect(ends, id);
        const out = step.outcomes.flatMap((outcome, index) =>
          list(outcome.steps, `${path}.outcomes[${index}].steps`, [{ from: id, flow: { outcome: outcome.name, name: outcome.label }, at: `${path}.outcomes[${index}]` }]),
        );
        if (step.deadline) {
          const late = add(`${path}.deadline`, { type: 'boundaryEvent', name: clip(`${step.label}: after ${durationWords(step.deadline.after)}`), attachedTo: id, interrupting: true, timer: { duration: step.deadline.after } });
          out.push(...list(step.deadline.steps, `${path}.deadline.steps`, [{ from: late }]));
        }
        return meet(out, path);
      }
      case 'wait':
        add(path, { type: 'intermediateCatchEvent', name: waitName(step.for), ...waitEvent(step.for) });
        connect(ends, id);
        return [{ from: id }];
      case 'first_of': {
        add(path, { type: 'eventBasedGateway', name: 'The first of' });
        connect(ends, id);
        const out = step.ways.flatMap((way, index) => {
          const wait = add(`${path}.ways[${index}]`, { type: 'intermediateCatchEvent', name: waitName(way.for), ...waitEvent(way.for) });
          connect([{ from: id }], wait);
          return list(way.steps, `${path}.ways[${index}].steps`, [{ from: wait }]);
        });
        return meet(out, path);
      }
      case 'all_at_once': {
        add(path, { type: 'parallelGateway', name: 'All at once' });
        connect(ends, id);
        const out = step.ways.map((way, index) => list(way.steps, `${path}.ways[${index}].steps`, [{ from: id }]));
        // A way that ends the flow ends all of it: the others meet only if one of them goes on.
        if (!out.some((way) => way.length)) return [];
        const join = add(path, { type: 'parallelGateway', name: 'Each way has ended' }, `${id}_join`);
        for (const way of out) connect(way, join);
        return [{ from: join }];
      }
      case 'if': {
        add(path, { type: 'exclusiveGateway', name: 'Decision' });
        connect(ends, id);
        return meet(
          [
            ...list(step.then, `${path}.then`, [{ from: id, flow: { when: onRecord(step.when), name: 'Yes' }, at: `${path}.when` }]),
            ...list(step.else, `${path}.else`, [{ from: id, flow: { default: true, name: 'No' }, at: path }]),
          ],
          path,
        );
      }
      case 'return':
        add(path, { type: 'endEvent', name: 'Ends here', terminate: true });
        connect(ends, id);
        return [];
      case 'call':
        add(path, { type: 'callActivity', name: flows?.[step.flow]?.label ?? step.flow, process: step.flow });
        connect(ends, id);
        return [{ from: id }];
      default:
        // A loop or an error handler that waits: the checks refuse it, and the engine can't run it.
        return stretch([step], path, ends);
    }
  };

  // A person whose role may run the flow starts it by hand, and a flow that waits calls it, at its
  // plain start; the actions that run it start it as they save their record.
  const actions = Object.entries(definition.actions)
    .filter(([, action]) => action.flow?.flow === name)
    .map(([action]) => action);
  // Their names read in a record's history: "Started: Ask for leave".
  let starts: End[] = [{ from: add('', { type: 'startEvent', name: clip(flow.label), actions: [] }, 'start') }];
  if (actions.length) {
    const by = listed(actions.map((action) => definition.actions[action]?.label ?? action));
    starts.push({ from: add('', { type: 'startEvent', name: clip(by), actions }, 'start_by_action') });
    add('', { type: 'exclusiveGateway', name: 'Where the starts meet' }, 'start_meet');
    connect(starts, 'start_meet');
    starts = [{ from: 'start_meet' }];
  }
  const ends = list(flow.steps, 'steps', starts);
  if (ends.length) {
    add('', { type: 'endEvent', name: clip(flow.label), terminate: false }, 'end');
    connect(ends, 'end');
  }
  return {
    process: { label: flow.label, ...(flow.description ? { description: flow.description } : {}), entity: subject.entity, elements, flows: sequence },
    parts,
    at,
  };
}

export interface CompiledFlows {
  /** Each flow that waits, as the engine runs it, under the flow's name. */
  readonly processes: Readonly<Record<string, Process>>;
  readonly parts: Readonly<Record<string, AppFlow>>;
  /** For each flow that waits, the step path of each of its elements and sequence flows. */
  readonly at: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Every flow of an app that waits, compiled. */
export function compileFlows(definition: Lookup): CompiledFlows {
  const processes: Record<string, Process> = {};
  const parts: Record<string, AppFlow> = {};
  const at = new Map<string, ReadonlyMap<string, string>>();
  for (const [name, flow] of Object.entries(definition.flows ?? {})) {
    const compiled = compileFlow(definition, name, flow);
    if (!compiled) continue;
    processes[name] = compiled.process;
    Object.assign(parts, compiled.parts);
    at.set(name, compiled.at);
  }
  return { processes, parts, at };
}

const RUNNABLE = new WeakMap<StoredDefinition, StoredDefinition>();

/**
 * The definition as the engines run it: each flow that waits as a process under its own name, and
 * the flows that its stretches run. The definition itself, as builders see it, holds neither.
 */
export function runnable(definition: StoredDefinition): StoredDefinition {
  const known = RUNNABLE.get(definition);
  if (known) return known;
  const compiled = compileFlows(definition);
  const found = Object.keys(compiled.processes).length
    ? { ...definition, processes: { ...definition.processes, ...compiled.processes }, flows: { ...definition.flows, ...compiled.parts } }
    : definition;
  RUNNABLE.set(definition, found);
  return found;
}
