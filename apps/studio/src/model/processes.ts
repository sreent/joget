import {
  insideOf,
  layoutProcess,
  processGraph,
  routeFlow,
  scopeOf,
  scopesOf,
  type BoundaryEventElement,
  type Diagram,
  type Flow,
  type Process,
  type ProcessElement,
  type UserTaskElement,
} from '@platform/app-model';
import type { Definition } from '../types.js';
import { toName } from './edit.js';

/*
 * Editing processes in the studio (design §6.10): each function takes a definition and returns
 * a new one. They keep a process drawable: what is added gets a shape, what is removed loses its
 * shape and flows, and flows follow the shapes they join.
 */

export type ProcessElementType = ProcessElement['type'];
type Shape = Diagram['shapes'][string];

/** What the palette adds: an element of a type, or a catch event that waits for an action instead of a time. */
export type ElementKind = Exclude<ProcessElementType, 'startEvent' | 'boundaryEvent'> | 'messageEvent';

/** What the palette offers: first what most processes need, as Mendix does; then the rest of what Ambit runs. */
export const PALETTE: ReadonlyArray<{ readonly kind: ElementKind; readonly label: string; readonly hint: string; readonly more?: true }> = [
  { kind: 'userTask', label: 'User task', hint: 'A person decides, in their inbox' },
  { kind: 'exclusiveGateway', label: 'Decision', hint: 'One path, chosen by the record' },
  { kind: 'parallelGateway', label: 'Parallel', hint: 'Paths at once, then wait for them all' },
  { kind: 'intermediateCatchEvent', label: 'Timer', hint: 'Wait for a time' },
  { kind: 'serviceTask', label: 'System task', hint: 'Run an action by itself' },
  { kind: 'endEvent', label: 'End', hint: 'The path ends here' },
  { kind: 'inclusiveGateway', label: 'Inclusive', hint: 'Each path whose condition holds, then wait for them', more: true },
  { kind: 'messageEvent', label: 'Message', hint: 'Wait until an action is saved on the record', more: true },
  { kind: 'subProcess', label: 'Sub-process', hint: 'A part with its own start and end, and deadlines for all of it', more: true },
  { kind: 'callActivity', label: 'Call process', hint: 'Run another process of the app, and wait until it ends', more: true },
  { kind: 'task', label: 'Task', hint: 'Work that is only drawn', more: true },
  { kind: 'manualTask', label: 'Manual task', hint: 'Work away from any system', more: true },
];

const PREFIX: Readonly<Record<ElementKind, string>> = {
  endEvent: 'end',
  userTask: 'task',
  serviceTask: 'system',
  task: 'task',
  manualTask: 'manual',
  exclusiveGateway: 'decision',
  parallelGateway: 'parallel',
  inclusiveGateway: 'inclusive',
  intermediateCatchEvent: 'wait',
  messageEvent: 'wait',
  subProcess: 'sub',
  callActivity: 'call',
};

const SIZE = { event: { width: 36, height: 36 }, task: { width: 100, height: 80 }, gateway: { width: 50, height: 50 }, sub: { width: 340, height: 180 } } as const;
export const sizeOf = (type: ProcessElementType | ElementKind) =>
  type === 'subProcess' ? SIZE.sub : type.endsWith('Event') ? SIZE.event : type.endsWith('Gateway') ? SIZE.gateway : SIZE.task;

const clone = <T>(value: T): T => structuredClone(value);

/** Two shapes overlap, or come closer than a margin that keeps room for the label under an event. */
const overlaps = (a: Shape, b: Shape, margin = 20) => a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;

/** Where a new shape can stand: where it is meant to, or lower down until it overlaps no other shape but the sub-processes it is in. */
function clear(process: Process, diagram: Diagram, id: string, shape: Shape): Shape {
  const around = new Set([id, ...scopesOf(process, id)]);
  const others = Object.entries(diagram.shapes).flatMap(([other, each]) => (around.has(other) ? [] : [each]));
  let at = shape;
  for (let tries = 0; tries < 30 && others.some((other) => overlaps(at, other)); tries++) at = { ...at, y: at.y + 60 };
  return at;
}

/**
 * Grow the sub-processes an element is in, the nearest first, so each holds all that is inside it.
 * The events on a sub-process's boundary keep their place on its bottom edge.
 */
function fit(process: Process, id: string): void {
  const shapes = process.diagram!.shapes;
  for (const scope of scopesOf(process, id)) {
    const box = shapes[scope];
    const inner = [...insideOf(process, scope)].flatMap((other) => (shapes[other] ? [shapes[other]] : []));
    if (!box || !inner.length) continue;
    const left = Math.min(box.x, ...inner.map((shape) => shape.x - 30));
    const top = Math.min(box.y, ...inner.map((shape) => shape.y - 40));
    const right = Math.max(box.x + box.width, ...inner.map((shape) => shape.x + shape.width + 30));
    const bottom = Math.max(box.y + box.height, ...inner.map((shape) => shape.y + shape.height + 40));
    for (const [other, element] of Object.entries(process.elements)) {
      const event = shapes[other];
      if (element.type !== 'boundaryEvent' || element.attachedTo !== scope || !event) continue;
      shapes[other] = { ...event, x: right - (box.x + box.width - event.x), y: bottom - 18 };
    }
    shapes[scope] = { ...box, x: left, y: top, width: right - left, height: bottom - top };
  }
}

/** The processes a call activity can run: another about the same entity, on the same record, or one about an entity that a reference field refers to, on that record. */
export function callChoices(definition: Definition, name: string): Array<{ readonly process: string; readonly record?: string; readonly label: string }> {
  const self = definition.processes?.[name];
  if (!self) return [];
  const fields = definition.entities[self.entity]?.fields ?? [];
  return Object.entries(definition.processes ?? {}).flatMap(([other, process]) => {
    if (other === name) return [];
    if (process.entity === self.entity) return [{ process: other, label: process.label }];
    return fields.flatMap((field) =>
      field.type === 'reference' && field.entity === process.entity ? [{ process: other, record: field.name, label: `${process.label}, on the record's ${field.label.toLowerCase()}` }] : [],
    );
  });
}

/** An ID that no element or flow of the process has yet: `task_2`, `flow_7`. */
export function freeId(process: Process, prefix: string): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}_${n}`;
    if (!(id in process.elements) && !(id in process.flows)) return id;
  }
}

/** The update actions that can work on the process's records: what outcomes and system tasks run. */
export function updateActions(definition: Definition, entity: string): string[] {
  return Object.entries(definition.actions).flatMap(([name, action]) => (action.entity === entity && action.operation === 'update' ? [name] : []));
}

/** The record entities, which a process can be about. */
export function processEntities(definition: Definition): string[] {
  const lines = new Set(Object.values(definition.entities).flatMap((entity) => entity.fields.flatMap((field) => (field.type === 'lines' ? [field.entity] : []))));
  return Object.keys(definition.entities).filter((name) => !lines.has(name));
}

function withProcess(definition: Definition, name: string, change: (process: Process) => void): Definition {
  const next = clone(definition);
  const process = next.processes?.[name];
  if (!process) return definition;
  process.diagram ??= { shapes: {}, edges: {} };
  change(process);
  return next;
}

/** Route every flow that touches one of these elements again, from the shapes they join. */
function reroute(process: Process, touched: ReadonlySet<string>): void {
  const diagram = (process.diagram ??= { shapes: {}, edges: {} });
  for (const [id, flow] of Object.entries(process.flows)) {
    if (!touched.has(flow.from) && !touched.has(flow.to)) continue;
    const from = diagram.shapes[flow.from];
    const to = diagram.shapes[flow.to];
    if (from && to) diagram.edges[id] = { points: routeFlow(from, to, process.elements[flow.from]?.type === 'boundaryEvent') };
  }
}

/** A new process: a start event that leads to an end event, about the records of an entity. */
export function newProcess(definition: Definition, label: string, entity: string): { definition: Definition; name: string } {
  const next = clone(definition);
  const name = toName(label, Object.keys(next.processes ?? {}));
  const process: Process = {
    label,
    entity,
    elements: { start: { type: 'startEvent', name: 'Start', actions: [] }, end: { type: 'endEvent', name: 'End', terminate: false } },
    flows: { flow_1: { from: 'start', to: 'end' } },
  };
  process.diagram = layoutProcess(process);
  next.processes = { ...(next.processes ?? {}), [name]: process };
  return { definition: next, name };
}

export function removeProcess(definition: Definition, name: string): Definition {
  const next = clone(definition);
  if (!next.processes) return definition;
  delete next.processes[name];
  if (!Object.keys(next.processes).length) delete next.processes;
  for (const role of Object.values(next.roles)) {
    if (!role.processes) continue;
    role.processes = role.processes.filter((process) => process !== name);
    if (!role.processes.length) delete role.processes;
  }
  return next;
}

export function updateProcess(definition: Definition, name: string, patch: Partial<Pick<Process, 'label' | 'description'>>): Definition {
  return withProcess(definition, name, (process) => {
    if (patch.label !== undefined) process.label = patch.label;
    if (patch.description !== undefined) {
      if (patch.description) process.description = patch.description;
      else delete process.description;
    }
  });
}

/** A new element of a kind, with values that pass the checks where the app allows it. `self` is the process's name. */
export function newElement(definition: Definition, process: Process, type: ElementKind, self = ''): ProcessElement {
  switch (type) {
    case 'subProcess':
      return { type, name: 'New sub-process' };
    case 'callActivity': {
      const choice = callChoices(definition, self)[0];
      return {
        type,
        name: choice ? definition.processes![choice.process]!.label : 'Call a process',
        process: choice?.process ?? 'process',
        ...(choice?.record ? { record: choice.record } : {}),
      };
    }
    case 'userTask':
      return { type, name: 'New task', role: Object.keys(definition.roles)[0] ?? 'role', outcomes: [{ name: 'done', label: 'Done' }] };
    case 'serviceTask': {
      const action = updateActions(definition, process.entity)[0];
      return { type, name: 'New system task', ...(action ? { action } : {}) };
    }
    case 'exclusiveGateway':
      return { type, name: 'Decision' };
    case 'parallelGateway':
    case 'inclusiveGateway':
      return { type };
    case 'intermediateCatchEvent':
      return { type, name: 'Wait', timer: { duration: 'P1D' } };
    case 'messageEvent': {
      const action = updateActions(definition, process.entity)[0] ?? 'action';
      return { type: 'intermediateCatchEvent', name: definition.actions[action]?.label ?? action, message: { action } };
    }
    case 'endEvent':
      return { type, name: 'End', terminate: false };
    case 'task':
      return { type, name: 'New task' };
    case 'manualTask':
      return { type, name: 'New manual task' };
  }
}

/**
 * Add an element on a flow, so the path runs through it; or after an element, on its one way out,
 * or joined to it if it leads nowhere yet. Without either, the element stands on its own.
 */
export function addElement(
  definition: Definition,
  name: string,
  type: ElementKind,
  options: { readonly after?: string; readonly on?: string; readonly at?: { x: number; y: number } } = {},
): { definition: Definition; id: string } {
  let id = '';
  const next = withProcess(definition, name, (process) => {
    id = freeId(process, PREFIX[type]);
    // The element stands where the flow it goes on, or the element it follows, is: in a sub-process, it goes in there.
    const scope = options.on && process.flows[options.on] ? scopeOf(process, process.flows[options.on]!.from) : options.after ? scopeOf(process, options.after) : undefined;
    const made = newElement(definition, process, type, name);
    process.elements[id] = made.type !== 'boundaryEvent' && scope !== undefined ? { ...made, in: scope } : made;
    const diagram = process.diagram!;
    const size = sizeOf(type);
    const on = options.on ? process.flows[options.on] : undefined;
    if (on) {
      // On a flow: between the shapes it joins, and the path runs through the new element.
      const from = diagram.shapes[on.from];
      const to = diagram.shapes[on.to];
      if (from && to && to.x > from.x) {
        // Make room: what stands from the target on moves right, with the events on its boundary.
        const room = size.width + 100 - (to.x - (from.x + from.width));
        if (room > 0) {
          const moved = new Set(Object.entries(diagram.shapes).flatMap(([other, shape]) => (other !== id && process.elements[other]?.type !== 'boundaryEvent' && shape.x >= to.x - 1 ? [other] : [])));
          for (const [other, element] of Object.entries(process.elements)) if (element.type === 'boundaryEvent' && moved.has(element.attachedTo)) moved.add(other);
          for (const other of moved) if (diagram.shapes[other]) diagram.shapes[other].x += room;
        }
      }
      // Halfway along the gap between the shapes, and halfway between their middles.
      const center = from && to ? { x: (from.x + from.width + to.x) / 2, y: (from.y + from.height / 2 + to.y + to.height / 2) / 2 } : { x: 100, y: 100 };
      diagram.shapes[id] = clear(process, diagram, id, { x: center.x - size.width / 2, y: center.y - size.height / 2, ...size });
      if (type !== 'endEvent') process.flows[freeId(process, 'flow')] = { from: id, to: on.to };
      on.to = id;
      finish(process, id);
      return;
    }
    const after = options.after ? diagram.shapes[options.after] : undefined;
    const shapes = Object.values(diagram.shapes);
    const at =
      options.at ??
      (after
        ? { x: after.x + after.width + 70, y: after.y + after.height / 2 - size.height / 2 }
        : { x: (shapes.length ? Math.max(...shapes.map((shape) => shape.x + shape.width)) : 0) + 70, y: 100 });
    const from = options.after ? process.elements[options.after] : undefined;
    if (options.after && from && from.type !== 'endEvent') {
      const out = processGraph(process).outgoing.get(options.after) ?? [];
      if (out.length === 1 && type !== 'endEvent') {
        // Run the path through the new element.
        const flow = process.flows[out[0]!]!;
        const target = flow.to;
        flow.to = id;
        process.flows[freeId(process, 'flow')] = { from: id, to: target };
        // Make room: what came after moves right.
        for (const [other, shape] of Object.entries(diagram.shapes)) {
          if (other !== id && after && shape.x > after.x + after.width - 1) shape.x += size.width + 70;
        }
      } else {
        process.flows[freeId(process, 'flow')] = withOutcome(process, options.after, { from: options.after, to: id });
      }
    }
    diagram.shapes[id] = clear(process, diagram, id, { ...at, ...size });
    finish(process, id);
  });
  return { definition: next, id };
}

/** What adding an element ends with: a sub-process gets its own start and end, the sub-processes it is in grow to hold it, and the flows follow. */
function finish(process: Process, id: string): void {
  const shapes = process.diagram!.shapes;
  const box = shapes[id];
  if (process.elements[id]?.type === 'subProcess' && box) {
    const start = freeId(process, 'start');
    process.elements[start] = { type: 'startEvent', in: id, actions: [] };
    const end = freeId(process, 'end');
    process.elements[end] = { type: 'endEvent', in: id, terminate: false };
    process.flows[freeId(process, 'flow')] = { from: start, to: end };
    const middle = box.y + box.height / 2 - 18;
    shapes[start] = { x: box.x + 40, y: middle, width: 36, height: 36 };
    shapes[end] = { x: box.x + box.width - 76, y: middle, width: 36, height: 36 };
  }
  fit(process, id);
  reroute(process, new Set(Object.keys(process.elements)));
}

/** A flow out of a user task follows an outcome: the first one without a flow yet. Out of a decision or an inclusive gateway, a second flow is the default. */
function withOutcome(process: Process, from: string, flow: Flow): Flow {
  const source = process.elements[from];
  const out = Object.values(process.flows).filter((existing) => existing.from === from);
  if (source?.type === 'userTask' && (source.outcomes.length > 1 || out.length)) {
    for (const existing of out) if (existing.outcome === undefined) existing.outcome = source.outcomes.find((outcome) => !out.some((o) => o.outcome === outcome.name))?.name;
    const free = source.outcomes.find((outcome) => !out.some((existing) => existing.outcome === outcome.name));
    return free ? { ...flow, outcome: free.name } : flow;
  }
  if ((source?.type === 'exclusiveGateway' || source?.type === 'inclusiveGateway') && out.length && !out.some((existing) => existing.default)) return { ...flow, default: true };
  return flow;
}

/** Join two elements with a flow, where BPMN allows it. Returns null where it doesn't. */
export function connect(definition: Definition, name: string, from: string, to: string): { definition: Definition; id: string } | null {
  const process = definition.processes?.[name];
  const source = process?.elements[from];
  const target = process?.elements[to];
  if (!process || !source || !target || from === to) return null;
  if (source.type === 'endEvent' || target.type === 'startEvent' || target.type === 'boundaryEvent') return null;
  // A flow stays inside one sub-process, or outside all of them.
  if (scopeOf(process, from) !== scopeOf(process, to)) return null;
  if (Object.values(process.flows).some((flow) => flow.from === from && flow.to === to)) return null;
  let id = '';
  const next = withProcess(definition, name, (draft) => {
    id = freeId(draft, 'flow');
    draft.flows[id] = withOutcome(draft, from, { from, to });
    reroute(draft, new Set([from, to]));
  });
  return { definition: next, id };
}

/**
 * Remove an element, with its flows and the events on its boundary; a sub-process, with all it
 * holds. Where one path ran through it, the path joins up again around it.
 */
export function removeElement(definition: Definition, name: string, id: string): Definition {
  return withProcess(definition, name, (process) => {
    const gone = new Set([id, ...(process.elements[id]?.type === 'subProcess' ? insideOf(process, id) : [])]);
    for (const [other, element] of Object.entries(process.elements)) if (element.type === 'boundaryEvent' && gone.has(element.attachedTo)) gone.add(other);
    const into = Object.entries(process.flows).filter(([, flow]) => flow.to === id);
    const out = Object.entries(process.flows).filter(([, flow]) => flow.from === id);
    const heal = into.length === 1 && out.length === 1 && process.elements[into[0]![1].from]?.type !== 'boundaryEvent';
    for (const [flowId, flow] of Object.entries(process.flows)) {
      if (gone.has(flow.from) || gone.has(flow.to)) {
        delete process.flows[flowId];
        delete process.diagram!.edges[flowId];
      }
    }
    if (heal) {
      const [flowId, flow] = into[0]!;
      process.flows[flowId] = { ...flow, to: out[0]![1].to };
    }
    for (const element of gone) {
      delete process.elements[element];
      delete process.diagram!.shapes[element];
    }
    reroute(process, new Set(Object.keys(process.elements)));
  });
}

export function removeFlow(definition: Definition, name: string, id: string): Definition {
  return withProcess(definition, name, (process) => {
    delete process.flows[id];
    delete process.diagram!.edges[id];
  });
}

/** Change an element. The change can't change its type. */
export function updateElement(definition: Definition, name: string, id: string, change: (element: ProcessElement) => ProcessElement): Definition {
  return withProcess(definition, name, (process) => {
    const element = process.elements[id];
    if (!element) return;
    const changed = change(clone(element));
    if (changed.type !== element.type) return;
    process.elements[id] = changed;
    if (element.type === 'userTask' && changed.type === 'userTask') {
      // A flow that followed an outcome that is gone follows none.
      for (const flow of Object.values(process.flows)) {
        if (flow.from === id && flow.outcome !== undefined && !changed.outcomes.some((outcome) => outcome.name === flow.outcome)) delete flow.outcome;
      }
    }
  });
}

export function updateFlow(definition: Definition, name: string, id: string, change: (flow: Flow) => Flow): Definition {
  return withProcess(definition, name, (process) => {
    const flow = process.flows[id];
    if (!flow) return;
    const changed = change(clone(flow));
    // One default at most out of a gateway.
    if (changed.default) for (const [other, sibling] of Object.entries(process.flows)) if (other !== id && sibling.from === changed.from) delete sibling.default;
    process.flows[id] = changed;
  });
}

/**
 * Move an element on the canvas. The events on its boundary move with it, and so does all that a
 * sub-process holds; its flows follow, and the sub-processes it is in grow to hold it.
 */
export function moveElement(definition: Definition, name: string, id: string, at: { x: number; y: number }): Definition {
  return withProcess(definition, name, (process) => {
    const shapes = process.diagram!.shapes;
    const shape = shapes[id] ?? { ...sizeOf(process.elements[id]?.type ?? 'task'), x: 0, y: 0 };
    const dx = at.x - shape.x;
    const dy = at.y - shape.y;
    shapes[id] = { ...shape, x: at.x, y: at.y };
    const moved = new Set([id]);
    const along = new Set(process.elements[id]?.type === 'subProcess' ? insideOf(process, id) : []);
    for (const [other, element] of Object.entries(process.elements)) if (element.type === 'boundaryEvent' && element.attachedTo === id) along.add(other);
    for (const other of along) {
      if (!shapes[other]) continue;
      shapes[other] = { ...shapes[other]!, x: shapes[other]!.x + dx, y: shapes[other]!.y + dy };
      moved.add(other);
    }
    fit(process, id);
    reroute(process, new Set([...moved, ...scopesOf(process, id)]));
  });
}

/** Lay the whole process out again, from left to right. */
export function arrange(definition: Definition, name: string): Definition {
  return withProcess(definition, name, (process) => {
    process.diagram = layoutProcess(process);
  });
}

/**
 * What a boundary can wait for: a deadline or an action saved on the record, on a user task, a
 * sub-process or a call; the failure of an action, on a system task or a sub-process.
 */
export type BoundaryKind = 'timer' | 'message' | 'error';

/** The elements whose boundary takes an event of a kind. */
export const BOUNDARY_HOSTS: Readonly<Record<BoundaryKind, readonly ProcessElementType[]>> = {
  timer: ['userTask', 'subProcess', 'callActivity'],
  message: ['userTask', 'subProcess', 'callActivity'],
  error: ['serviceTask', 'subProcess'],
};

const BOUNDARY: Readonly<Record<BoundaryKind, { readonly prefix: string; readonly end: string; readonly endPrefix: string }>> = {
  timer: { prefix: 'deadline', end: 'Too late', endPrefix: 'too_late' },
  message: { prefix: 'message', end: 'Stopped', endPrefix: 'stopped' },
  error: { prefix: 'error', end: 'Failed', endPrefix: 'failed' },
};

/**
 * The update actions that can interrupt a user task, a sub-process or a call as a message: not an
 * outcome of a task it is or holds, which decides that task, and not one that another event on it
 * waits for already.
 */
export function messageChoices(definition: Definition, process: Process, task: string): string[] {
  const host = process.elements[task];
  if (!host || !BOUNDARY_HOSTS.message.includes(host.type)) return [];
  const deciding = host.type === 'userTask' ? [host] : host.type === 'subProcess' ? [...insideOf(process, task)].map((id) => process.elements[id]).filter((element): element is UserTaskElement => element?.type === 'userTask') : [];
  const taken = new Set([
    ...deciding.flatMap((each) => each.outcomes.flatMap((outcome) => (outcome.action ? [outcome.action] : []))),
    ...Object.values(process.elements).flatMap((element) => (element.type === 'boundaryEvent' && element.attachedTo === task && element.message ? [element.message.action] : [])),
  ]);
  return updateActions(definition, process.entity).filter((action) => !taken.has(action));
}

/**
 * Put an event on a boundary, and a path for when it happens, to an end that says so. The builder
 * can lead the path elsewhere. A deadline or a message waits on a user task, a sub-process or a
 * call; an error catches the failure of an action in a system task or a sub-process.
 */
export function addBoundary(definition: Definition, name: string, task: string, kind: BoundaryKind): { definition: Definition; id: string } {
  let id = '';
  const next = withProcess(definition, name, (process) => {
    const host = process.elements[task];
    if (!host || !BOUNDARY_HOSTS[kind].includes(host.type)) return;
    let event: BoundaryEventElement;
    if (kind === 'timer') event = { type: 'boundaryEvent', name: 'Deadline', attachedTo: task, interrupting: true, timer: { duration: 'P3D' } };
    else if (kind === 'error') event = { type: 'boundaryEvent', name: 'Error', attachedTo: task, interrupting: true, error: true };
    else {
      const action = messageChoices(definition, process, task)[0];
      if (!action) return;
      event = { type: 'boundaryEvent', name: definition.actions[action]?.label ?? action, attachedTo: task, interrupting: true, message: { action } };
    }
    id = freeId(process, BOUNDARY[kind].prefix);
    const end = freeId(process, BOUNDARY[kind].endPrefix);
    process.elements[id] = event;
    // The path leads on where the host stands: inside its sub-process, if it is in one.
    const scope = scopeOf(process, task);
    process.elements[end] = { type: 'endEvent', name: BOUNDARY[kind].end, terminate: false, ...(scope !== undefined ? { in: scope } : {}) };
    process.flows[freeId(process, 'flow')] = { from: id, to: end };
    const shape = process.diagram!.shapes[task];
    if (shape) {
      const taken = Object.values(process.elements).filter((element) => element.type === 'boundaryEvent' && element.attachedTo === task).length - 1;
      process.diagram!.shapes[id] = { x: shape.x + shape.width - 30 - taken * 40, y: shape.y + shape.height - 18, width: 36, height: 36 };
      process.diagram!.shapes[end] = clear(process, process.diagram!, end, { x: shape.x + shape.width + 60, y: shape.y + shape.height + 60, width: 36, height: 36 });
      fit(process, end);
    }
    reroute(process, new Set([id, end, ...scopesOf(process, end)]));
  });
  return { definition: next, id };
}

/** The issues of the checks that concern one process, by element or flow. */
export function issuesByPart(issues: ReadonlyArray<{ path: string; message: string }>, name: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const prefix = `processes.${name}.`;
  for (const issue of issues) {
    if (!issue.path.startsWith(prefix)) continue;
    const [section, part] = issue.path.slice(prefix.length).split('.');
    const key = (section === 'elements' || section === 'flows') && part ? part.replace(/\[.*$/, '') : '';
    found.set(key, [...(found.get(key) ?? []), issue.message]);
  }
  return found;
}

/** A duration a builder sets with a number and a unit: hours, days or weeks. Anything else stays as its ISO 8601 text. */
export function durationParts(duration: string): { amount: number; unit: 'hours' | 'days' | 'weeks' } | null {
  const match = /^P(?:(\d+)W|(\d+)D|T(\d+)H)$/.exec(duration);
  if (!match) return null;
  if (match[1]) return { amount: Number(match[1]), unit: 'weeks' };
  if (match[2]) return { amount: Number(match[2]), unit: 'days' };
  return { amount: Number(match[3]), unit: 'hours' };
}

export function durationOf(amount: number, unit: 'hours' | 'days' | 'weeks'): string {
  const whole = Math.max(1, Math.min(9999, Math.round(amount)));
  return unit === 'hours' ? `PT${whole}H` : unit === 'weeks' ? `P${whole}W` : `P${whole}D`;
}

/** A duration in words: P3D is "3 days". */
export function durationWords(duration: string): string {
  const parts = durationParts(duration);
  if (!parts) return duration;
  const unit = parts.amount === 1 ? parts.unit.slice(0, -1) : parts.unit;
  return `${parts.amount} ${unit}`;
}

/**
 * Let go of an action, a role or a field that goes: processes stop naming it. An event that waits
 * for an action keeps its name, and the checks show where to choose another.
 */
export function forgetInProcesses(definition: Definition, gone: { readonly action?: string; readonly role?: string; readonly entity?: string; readonly field?: string }): Definition {
  if (!definition.processes) return definition;
  const next = clone(definition);
  for (const process of Object.values(next.processes ?? {})) {
    for (const element of Object.values(process.elements)) {
      if (element.type === 'startEvent' && gone.action) element.actions = element.actions.filter((action) => action !== gone.action);
      if (element.type === 'userTask') {
        if (gone.action) for (const outcome of element.outcomes) if (outcome.action === gone.action) delete outcome.action;
        if (gone.field && gone.entity === process.entity) {
          const named = element.assignee && ('field' in element.assignee ? element.assignee.field : element.assignee.managerOf);
          if (named === gone.field) delete element.assignee;
          if (element.department?.of === gone.field) delete element.department;
          const voters = element.several?.people;
          if (voters && 'lineOf' in voters && voters.lineOf === gone.field) delete element.several;
          if (voters && 'fields' in voters && voters.fields.includes(gone.field)) {
            const left = voters.fields.filter((field) => field !== gone.field);
            if (left.length >= 2) element.several = { ...element.several!, people: { fields: left } };
            else delete element.several;
          }
        }
      }
      if (element.type === 'serviceTask' && gone.action && element.action === gone.action) delete element.action;
      if (element.type === 'callActivity' && gone.field && gone.entity === process.entity && element.record === gone.field) delete element.record;
      if ((element.type === 'intermediateCatchEvent' || element.type === 'boundaryEvent') && gone.field && gone.entity === process.entity && element.timer && 'date' in element.timer && element.timer.date === gone.field) {
        element.timer = { duration: 'P1D' };
      }
    }
  }
  return next;
}
