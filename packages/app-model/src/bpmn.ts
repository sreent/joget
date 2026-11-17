import { isRef, type Condition } from '@platform/authz';
import { conditionText, parseConditionText } from './condition-text.js';
import { isExpression, type Expression } from './expressions.js';
import { entityFields, lineOwners, type StoredDefinition } from './fields.js';
import { caughtSignals, isEventSub, messageActions, processGraph, raisedCode, scopeOf, scopesOf, sentMessages, thrownSignals } from './processes.js';
import { DURATION_PATTERN, ELEMENT_ID_PATTERN, NAME_PATTERN, type Diagram, type Flow, type Message, type Process, type ProcessElement, type Raised, type Several, type Step, type Timer } from './schema.js';
import { mapRefs } from './validate.js';
import { attribute, childElements, parseXml, textOf, writeXml, XmlError, type XmlElement, type XmlOut } from './xml.js';

/*
 * BPMN 2.0 XML, with its diagram (design §6.10): a process goes out to other BPMN tools and comes
 * back as it went. Ambit's own settings, such as the role that does a task, travel in Ambit's
 * namespace; conditions travel as text. An import refuses, by name and ID, anything Ambit can't run.
 */

export const BPMN_MODEL = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
export const BPMN_DI = 'http://www.omg.org/spec/BPMN/20100524/DI';
export const DC = 'http://www.omg.org/spec/DD/20100524/DC';
export const DI = 'http://www.omg.org/spec/DD/20100524/DI';
export const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
/** Ambit's namespace for its own settings in a BPMN file. */
export const AMBIT_BPMN = 'urn:ambit:bpmn:1';
/** The expression languages of what Ambit writes in BPMN's formal expressions. */
export const LANGUAGES = { condition: 'urn:ambit:condition', outcome: 'urn:ambit:outcome', field: 'urn:ambit:field', duration: 'urn:ambit:duration' } as const;

const SIZES: Readonly<Record<string, { readonly width: number; readonly height: number }>> = {
  event: { width: 36, height: 36 },
  task: { width: 100, height: 80 },
  gateway: { width: 50, height: 50 },
};
const sizeOf = (element: ProcessElement) =>
  element.type.endsWith('Event') ? SIZES['event']! : element.type.endsWith('Gateway') ? SIZES['gateway']! : SIZES['task']!;

type Size = { readonly width: number; readonly height: number };
type Shape = Diagram['shapes'][string];

/** The room inside a sub-process around what it holds: its name sits at the top. */
const INSIDE = { x: 30, top: 40, bottom: 40 } as const;

/**
 * Lay a process out from left to right, for a process drawn without a diagram: each element one
 * column after everything that leads to it; the longest way to an end on one straight row; the
 * other ways out of an element, and the paths from a task's boundary, in the rows below; flows as
 * lines with right angles. A sub-process is laid out inside first, and then stands as one large
 * shape among the others.
 */
export function layoutProcess(process: Process): Diagram {
  const graph = processGraph(process);
  const depth = (id: string) => scopesOf(process, id).length;
  const subs = Object.keys(process.elements).filter((id) => process.elements[id]!.type === 'subProcess');
  // What each sub-process holds, laid out from its own corner, the innermost first so that each size is known where it stands.
  const sizes = new Map<string, Size>();
  const contents = new Map<string, Record<string, Shape>>();
  for (const sub of [...subs].sort((a, b) => depth(b) - depth(a))) {
    const content = layoutScope(process, graph, sub, sizes);
    const boxes = Object.values(content);
    const [minX, minY] = boxes.length ? [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))] : [0, 0];
    const [maxX, maxY] = boxes.length ? [Math.max(...boxes.map((b) => b.x + b.width)), Math.max(...boxes.map((b) => b.y + b.height))] : [200, 80];
    const moved = Object.fromEntries(Object.entries(content).map(([id, box]) => [id, { ...box, x: box.x - minX + INSIDE.x, y: box.y - minY + INSIDE.top }]));
    contents.set(sub, moved);
    sizes.set(sub, { width: Math.max(200, maxX - minX + 2 * INSIDE.x), height: Math.max(140, maxY - minY + INSIDE.top + INSIDE.bottom) });
  }
  const shapes: Record<string, Shape> = layoutScope(process, graph, undefined, sizes);
  // What a sub-process holds stands where the sub-process does: the outermost first.
  for (const sub of [...subs].sort((a, b) => depth(a) - depth(b))) {
    const at = shapes[sub];
    if (!at) continue;
    for (const [id, box] of Object.entries(contents.get(sub) ?? {})) shapes[id] = { ...box, x: at.x + box.x, y: at.y + box.y };
  }
  const onTask = new Map<string, number>();
  for (const [id, element] of Object.entries(process.elements)) {
    if (element.type !== 'boundaryEvent') continue;
    const host = shapes[element.attachedTo];
    if (!host) continue;
    const index = onTask.get(element.attachedTo) ?? 0;
    onTask.set(element.attachedTo, index + 1);
    shapes[id] = { x: host.x + host.width - 30 - index * 40, y: host.y + host.height - 18, width: 36, height: 36 };
  }
  const edges: Record<string, Diagram['edges'][string]> = {};
  for (const [id, flow] of Object.entries(process.flows)) {
    const from = shapes[flow.from];
    const to = shapes[flow.to];
    if (from && to) edges[id] = { points: routeFlow(from, to, process.elements[flow.from]?.type === 'boundaryEvent') };
  }
  return { shapes, edges };
}

/** Lay out what stands in the process itself, or in one sub-process: the columns and rows of its elements, without the events on boundaries. */
function layoutScope(process: Process, graph: ReturnType<typeof processGraph>, scope: string | undefined, sizes: ReadonlyMap<string, Size>): Record<string, Shape> {
  const ids = Object.keys(process.elements);
  const placed = ids.filter((id) => process.elements[id]!.type !== 'boundaryEvent' && scopeOf(process, id) === scope);
  const sized = (id: string): Size => sizes.get(id) ?? sizeOf(process.elements[id]!);
  // Where a token goes next from an element: its own flows, then those of the timers on its boundary, which lead below it.
  const next = (id: string): Array<{ to: string; boundary: boolean }> => [
    ...(graph.outgoing.get(id) ?? []).map((flow) => ({ to: process.flows[flow]!.to, boundary: false })),
    ...(graph.boundaries.get(id) ?? []).flatMap((boundary) => (graph.outgoing.get(boundary) ?? []).map((flow) => ({ to: process.flows[flow]!.to, boundary: true }))),
  ];

  // Flows that loop back to an element already on the way are left out of the columns.
  const back = new Set<string>();
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const { to } of next(id)) {
      if (state.get(to) === 'open') back.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 'done');
  };
  const starts = placed.filter((id) => process.elements[id]!.type === 'startEvent');
  for (const id of [...starts, ...placed]) if (!state.has(id)) visit(id);
  const forward = (id: string) => next(id).filter(({ to }) => !back.has(`${id}>${to}`) && process.elements[to]?.type !== 'boundaryEvent');

  // Columns: the longest way from a start. Depth: the longest way on to an end, which picks the main row.
  const column = new Map<string, number>();
  const columnOf = (id: string, seen = new Set<string>()): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const before = placed.flatMap((other) => (forward(other).some(({ to }) => to === id) ? [other] : []));
    const value = before.length ? Math.max(...before.map((other) => columnOf(other, seen) + 1)) : 0;
    column.set(id, value);
    return value;
  };
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const after = forward(id);
    const value = after.length ? Math.max(...after.map(({ to }) => depthOf(to, seen) + 1)) : 0;
    depth.set(id, value);
    return value;
  };
  for (const id of placed) {
    columnOf(id);
    depthOf(id);
  }

  // Rows: an element sits where the flows into it point. The way out with the longest way on keeps its row;
  // the others, and the paths from a boundary, go below.
  // Where the flows into an element point: the main ways in, which keep the main row, count first.
  const wanted = new Map<string, Array<{ row: number; main: boolean }>>();
  const row = new Map<string, number>();
  const columns = [...new Set(placed.map((id) => column.get(id)!))].sort((a, b) => a - b);
  let nextStart = 0;
  for (const col of columns) {
    const here = placed.filter((id) => column.get(id) === col);
    const desire = (id: string) => {
      const list = wanted.get(id) ?? [];
      const main = list.filter((each) => each.main);
      const rows = (main.length ? main : list).map((each) => each.row);
      return rows.length ? Math.min(...rows) : Number.POSITIVE_INFINITY;
    };
    here.sort((a, b) => desire(a) - desire(b) || depthOf(b) - depthOf(a));
    const taken = new Set<number>();
    for (const id of here) {
      let target = desire(id);
      if (!Number.isFinite(target)) target = nextStart++;
      const base = Math.round(target);
      let chosen = base;
      for (let step = 0; taken.has(chosen); step++) chosen = step % 2 === 0 ? base + 1 + step / 2 : base - 1 - (step - 1) / 2;
      taken.add(chosen);
      row.set(id, chosen);
    }
    for (const id of here) {
      const out = forward(id);
      const main = out.filter(({ boundary }) => !boundary).sort((a, b) => depthOf(b.to) - depthOf(a.to))[0];
      let below = 1;
      for (const flow of out) {
        const offset = flow === main ? 0 : below++;
        const list = wanted.get(flow.to) ?? [];
        list.push({ row: row.get(id)! + offset, main: offset === 0 });
        wanted.set(flow.to, list);
      }
    }
  }
  const top = Math.min(0, ...row.values());

  // A column is as wide as its widest shape, and a row as tall as its tallest: a task's size at least, with room between them.
  const widths = new Map<number, number>();
  const heights = new Map<number, number>();
  for (const id of placed) {
    const size = sized(id);
    const [col, line] = [column.get(id)!, row.get(id)! - top];
    widths.set(col, Math.max(widths.get(col) ?? SIZES['task']!.width, size.width));
    heights.set(line, Math.max(heights.get(line) ?? SIZES['task']!.height, size.height));
  }
  const offsets = (spans: ReadonlyMap<number, number>, start: number, gap: number, fallback: number) => {
    const last = Math.max(0, ...spans.keys());
    const centers: number[] = [];
    let at = start;
    for (let index = 0; index <= last; index++) {
      const span = spans.get(index) ?? fallback;
      centers.push(at + span / 2);
      at += span + gap;
    }
    return centers;
  };
  const xs = offsets(widths, 70, 80, SIZES['task']!.width);
  const ys = offsets(heights, 80, 50, SIZES['task']!.height);
  const shapes: Record<string, Shape> = {};
  for (const id of placed) {
    const size = sized(id);
    // In a column that a sub-process widens, a smaller shape stands at its left, as in a task's column: a flow to it then bends before the sub-process, not across it.
    const col = column.get(id)!;
    const span = widths.get(col) ?? SIZES['task']!.width;
    const center = size.width < span ? xs[col]! - span / 2 + Math.max(size.width, SIZES['task']!.width) / 2 : xs[col]!;
    shapes[id] = { x: center - size.width / 2, y: ys[row.get(id)! - top]! - size.height / 2, width: size.width, height: size.height };
  }
  return shapes;
}

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** The waypoints of a flow between two shapes, with right angles: out of a boundary event downwards, otherwise to the right. */
export function routeFlow(from: Box, to: Box, fromBoundary = false): Array<{ x: number; y: number }> {
  const start = fromBoundary ? { x: from.x + from.width / 2, y: from.y + from.height } : { x: from.x + from.width, y: from.y + from.height / 2 };
  const end = { x: to.x, y: to.y + to.height / 2 };
  if (fromBoundary) return [start, { x: start.x, y: end.y }, end];
  if (start.y === end.y) return [start, end];
  const middle = Math.round((start.x + end.x) / 2);
  return [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
}

const TAGS: Readonly<Record<ProcessElement['type'], string>> = {
  startEvent: 'bpmn:startEvent',
  endEvent: 'bpmn:endEvent',
  userTask: 'bpmn:userTask',
  serviceTask: 'bpmn:serviceTask',
  scriptTask: 'bpmn:scriptTask',
  businessRuleTask: 'bpmn:businessRuleTask',
  sendTask: 'bpmn:sendTask',
  receiveTask: 'bpmn:receiveTask',
  task: 'bpmn:task',
  manualTask: 'bpmn:manualTask',
  exclusiveGateway: 'bpmn:exclusiveGateway',
  parallelGateway: 'bpmn:parallelGateway',
  inclusiveGateway: 'bpmn:inclusiveGateway',
  eventBasedGateway: 'bpmn:eventBasedGateway',
  intermediateCatchEvent: 'bpmn:intermediateCatchEvent',
  intermediateThrowEvent: 'bpmn:intermediateThrowEvent',
  subProcess: 'bpmn:subProcess',
  callActivity: 'bpmn:callActivity',
  boundaryEvent: 'bpmn:boundaryEvent',
};

/** The ID of the BPMN message that stands for an action committing on the record. */
const messageId = (action: string) => `Message_${action}`;
/** The ID of the BPMN signal of a name. */
const signalId = (signal: string) => `Signal_${signal}`;
/** The ID of the BPMN error or escalation of a code. */
const raisedId = (kind: 'error' | 'escalation', code: string) => `${kind === 'error' ? 'Error' : 'Escalation'}_${code}`;
/** The language of a script task's script: Ambit's steps, as JSON. Ambit runs no other script. */
export const STEPS_FORMAT = 'urn:ambit:steps';
/** The implementation of a business rule task that checks the app's rules. */
export const RULES_IMPLEMENTATION = 'urn:ambit:rules';

const formal = (name: string, language: string, text: string): XmlOut => ({ name, attributes: { 'xsi:type': 'bpmn:tFormalExpression', language }, text });

/** Write one of an app's processes as a BPMN 2.0 file, with its diagram, laid out if it has none. */
export function processToBpmn(definition: StoredDefinition, name: string): string {
  const process = definition.processes?.[name];
  if (!process) throw new Error(`No process named ${name}`);
  const graph = processGraph(process);
  const diagram = process.diagram && Object.keys(process.diagram.shapes).length ? process.diagram : layoutProcess(process);
  const defaults = new Map(Object.entries(process.flows).flatMap(([id, flow]) => (flow.default ? [[flow.from, id] as const] : [])));
  const timer = (id: string, definitionOf: Timer): XmlOut => ({
    name: 'bpmn:timerEventDefinition',
    attributes: { id: `${id}_timer` },
    children: ['duration' in definitionOf ? formal('bpmn:timeDuration', LANGUAGES.duration, definitionOf.duration) : formal('bpmn:timeDate', LANGUAGES.field, definitionOf.date)],
  });

  const messageDefinition = (id: string, message: Message): XmlOut => ({
    name: 'bpmn:messageEventDefinition',
    attributes: { id: `${id}_message`, messageRef: messageId(message.action), 'ambit:record': message.record },
  });
  const elementXml = (id: string, element: ProcessElement): XmlOut => {
    const children: XmlOut[] = [];
    if ('description' in element && element.description) children.push({ name: 'bpmn:documentation', text: element.description });
    const attributes: Record<string, string | undefined> = { id, name: element.name };
    switch (element.type) {
      case 'startEvent':
        if (element.actions.length) attributes['ambit:actions'] = element.actions.join(' ');
        if (element.interrupting === false) attributes['isInterrupting'] = 'false';
        break;
      case 'endEvent':
        break;
      case 'userTask':
        attributes['ambit:role'] = element.role;
        if (element.assignee && 'field' in element.assignee) attributes['ambit:assignee'] = element.assignee.field;
        if (element.assignee && 'managerOf' in element.assignee) {
          attributes['ambit:managerOf'] = element.assignee.managerOf;
          attributes['ambit:levels'] = String(element.assignee.levels);
        }
        attributes['ambit:department'] = element.department?.of;
        attributes['ambit:due'] = element.due;
        attributes['ambit:card'] = element.card;
        children.push({
          name: 'bpmn:extensionElements',
          children: element.outcomes.map((outcome) => ({ name: 'ambit:outcome', attributes: { name: outcome.name, label: outcome.label, action: outcome.action } })),
        });
        break;
      case 'serviceTask':
        attributes['implementation'] = element.action ? 'urn:ambit:action' : 'urn:ambit:skill';
        attributes['ambit:action'] = element.action;
        attributes['ambit:skill'] = element.skill;
        if (element.input && Object.keys(element.input).length) {
          children.push({
            name: 'bpmn:extensionElements',
            children: Object.entries(element.input).map(([input, expression]) => ({ name: 'ambit:input', attributes: { name: input }, text: JSON.stringify(expression) })),
          });
        }
        break;
      case 'exclusiveGateway':
      case 'inclusiveGateway':
        attributes['default'] = defaults.get(id);
        break;
      case 'boundaryEvent':
        attributes['attachedToRef'] = element.attachedTo;
        attributes['cancelActivity'] = element.interrupting ? 'true' : 'false';
        break;
      case 'callActivity':
        attributes['calledElement'] = element.process;
        attributes['ambit:record'] = element.record;
        break;
      case 'scriptTask':
        attributes['scriptFormat'] = STEPS_FORMAT;
        break;
      case 'businessRuleTask':
        attributes['implementation'] = RULES_IMPLEMENTATION;
        attributes['ambit:rules'] = element.rules?.join(' ');
        break;
      case 'sendTask':
      case 'receiveTask':
        attributes['messageRef'] = messageId(element.message.action);
        attributes['ambit:record'] = element.message.record;
        break;
      default:
        break;
    }
    for (const flow of graph.incoming.get(id) ?? []) children.push({ name: 'bpmn:incoming', text: flow });
    for (const flow of graph.outgoing.get(id) ?? []) children.push({ name: 'bpmn:outgoing', text: flow });
    // A sub-process holds its own elements and flows.
    if (element.type === 'subProcess') children.push(...contentOf(id));
    if (element.type === 'userTask' && element.several) {
      const { people, sequential, decide } = element.several;
      children.push({
        name: 'bpmn:multiInstanceLoopCharacteristics',
        attributes: {
          isSequential: sequential ? 'true' : 'false',
          ...('everyone' in people ? { 'ambit:everyone': 'true' } : 'fields' in people ? { 'ambit:fields': people.fields.join(' ') } : { 'ambit:lineOf': people.lineOf, 'ambit:levels': String(people.levels) }),
          ...('first' in decide ? { 'ambit:decide': 'first' } : { 'ambit:count': String(decide.count), 'ambit:outcome': decide.outcome, 'ambit:otherwise': decide.otherwise }),
        },
      });
    }
    // A script task's script comes after what every activity has.
    if (element.type === 'scriptTask') children.push({ name: 'bpmn:script', text: JSON.stringify(element.steps) });
    if (element.type === 'endEvent' && element.terminate) children.push({ name: 'bpmn:terminateEventDefinition', attributes: { id: `${id}_terminate` } });
    if (
      element.type === 'startEvent' ||
      element.type === 'intermediateCatchEvent' ||
      element.type === 'boundaryEvent' ||
      element.type === 'intermediateThrowEvent' ||
      element.type === 'endEvent'
    ) {
      if ('timer' in element && element.timer) children.push(timer(id, element.timer));
      if ('condition' in element && element.condition) {
        children.push({ name: 'bpmn:conditionalEventDefinition', attributes: { id: `${id}_condition` }, children: [formal('bpmn:condition', LANGUAGES.condition, conditionText(element.condition))] });
      }
      if ('message' in element && element.message) children.push(messageDefinition(id, element.message));
      // In an event sub-process, the action that starts it is a message.
      if (element.type === 'startEvent' && isEventSub(process!, element.in) && element.actions.length === 1) children.push(messageDefinition(id, { action: element.actions[0]! }));
      if ('error' in element && element.error) children.push(raisedDefinition(id, 'error', element.error));
      if ('escalation' in element && element.escalation) children.push(raisedDefinition(id, 'escalation', element.escalation));
      if ('signal' in element && element.signal !== undefined) children.push({ name: 'bpmn:signalEventDefinition', attributes: { id: `${id}_signal`, signalRef: signalId(element.signal) } });
      if ('compensate' in element && element.compensate) children.push({ name: 'bpmn:compensateEventDefinition', attributes: { id: `${id}_compensate` } });
      if ('cancel' in element && element.cancel) children.push({ name: 'bpmn:cancelEventDefinition', attributes: { id: `${id}_cancel` } });
      if ('link' in element && element.link !== undefined) children.push({ name: 'bpmn:linkEventDefinition', attributes: { id: `${id}_link`, name: element.link } });
    }
    // A transaction is BPMN's own element; an event sub-process is a sub-process that an event triggers.
    if (element.type === 'subProcess' && element.event) attributes['triggeredByEvent'] = 'true';
    return { name: element.type === 'subProcess' && element.transaction ? 'bpmn:transaction' : TAGS[element.type], attributes, children };
  };
  /** An error or an escalation, by its code: BPMN keeps each code in a root element that events refer to. */
  const raisedDefinition = (id: string, kind: 'error' | 'escalation', raised: Raised): XmlOut => {
    const code = raisedCode(raised);
    return { name: `bpmn:${kind}EventDefinition`, attributes: { id: `${id}_${kind}`, [`${kind}Ref`]: code ? raisedId(kind, code) : undefined } };
  };
  /**
   * What undoes a task, as BPMN draws it: a compensation event on the task's boundary, joined by an
   * association to a handler task for compensation, which runs the undo action.
   */
  const undoXml = (id: string, element: ProcessElement): XmlOut[] => {
    if (!('undo' in element) || !element.undo) return [];
    return [
      { name: 'bpmn:boundaryEvent', attributes: { id: `${id}_undo`, attachedToRef: id }, children: [{ name: 'bpmn:compensateEventDefinition', attributes: { id: `${id}_undo_def` } }] },
      { name: 'bpmn:serviceTask', attributes: { id: `${id}_undo_task`, name: `Undo: ${element.name}`, isForCompensation: 'true', implementation: 'urn:ambit:action', 'ambit:action': element.undo } },
      { name: 'bpmn:association', attributes: { id: `${id}_undo_link`, associationDirection: 'One', sourceRef: `${id}_undo`, targetRef: `${id}_undo_task` } },
    ];
  };
  const flowXml = (id: string, flow: Flow): XmlOut => {
    const children: XmlOut[] = [];
    if (flow.when) children.push(formal('bpmn:conditionExpression', LANGUAGES.condition, conditionText(flow.when)));
    if (flow.outcome !== undefined) children.push(formal('bpmn:conditionExpression', LANGUAGES.outcome, flow.outcome));
    return { name: 'bpmn:sequenceFlow', attributes: { id, name: flow.name, sourceRef: flow.from, targetRef: flow.to }, children };
  };
  /** The elements and flows of the process itself, or of one of its sub-processes. */
  function contentOf(scope: string | undefined): XmlOut[] {
    return [
      ...Object.entries(process!.elements).flatMap(([id, element]) => (scopeOf(process!, id) === scope ? [elementXml(id, element), ...undoXml(id, element)] : [])),
      ...Object.entries(process!.flows).flatMap(([id, flow]) => (scopeOf(process!, flow.from) === scope ? [flowXml(id, flow)] : [])),
    ];
  }

  const bounds = (b: { x: number; y: number; width: number; height: number }): XmlOut => ({ name: 'dc:Bounds', attributes: { x: b.x, y: b.y, width: b.width, height: b.height } });
  const shapes: XmlOut[] = Object.entries(diagram.shapes).map(([id, shape]) => ({
    name: 'bpmndi:BPMNShape',
    attributes: {
      id: `${id}_di`,
      bpmnElement: id,
      ...(process.elements[id]?.type === 'exclusiveGateway' ? { isMarkerVisible: 'true' } : {}),
      ...(process.elements[id]?.type === 'subProcess' ? { isExpanded: 'true' } : {}),
    },
    children: [bounds(shape), ...(shape.label ? [{ name: 'bpmndi:BPMNLabel', children: [bounds(shape.label)] }] : [])],
  }));
  // The compensation that stands for an undo: its event at the task's bottom left, its handler below the task.
  for (const [id, element] of Object.entries(process.elements)) {
    const shape = diagram.shapes[id];
    if (!('undo' in element) || !element.undo || !shape) continue;
    shapes.push(
      { name: 'bpmndi:BPMNShape', attributes: { id: `${id}_undo_di`, bpmnElement: `${id}_undo` }, children: [bounds({ x: shape.x + 2, y: shape.y + shape.height - 18, width: 36, height: 36 })] },
      { name: 'bpmndi:BPMNShape', attributes: { id: `${id}_undo_task_di`, bpmnElement: `${id}_undo_task` }, children: [bounds({ x: shape.x, y: shape.y + shape.height + 60, width: 100, height: 80 })] },
    );
  }
  const edges: XmlOut[] = Object.entries(diagram.edges).map(([id, edge]) => ({
    name: 'bpmndi:BPMNEdge',
    attributes: { id: `${id}_di`, bpmnElement: id },
    children: [...edge.points.map((point) => ({ name: 'di:waypoint', attributes: { x: point.x, y: point.y } })), ...(edge.label ? [{ name: 'bpmndi:BPMNLabel', children: [bounds(edge.label)] }] : [])],
  }));

  return writeXml({
    name: 'bpmn:definitions',
    attributes: {
      'xmlns:bpmn': BPMN_MODEL,
      'xmlns:bpmndi': BPMN_DI,
      'xmlns:dc': DC,
      'xmlns:di': DI,
      'xmlns:xsi': XSI,
      'xmlns:ambit': AMBIT_BPMN,
      id: `${name}_definitions`,
      targetNamespace: AMBIT_BPMN,
      exporter: 'Ambit',
      exporterVersion: '1',
    },
    children: [
      // A message is an action of the app committing on the record: each one the process waits for.
      ...[...new Set([...messageActions(process), ...sentMessages(process).map((message) => message.action)])].map((action) => ({
        name: 'bpmn:message',
        attributes: { id: messageId(action), name: action, 'ambit:action': action },
      })),
      // Each code of an error or an escalation that the process throws or catches.
      ...(['error', 'escalation'] as const).flatMap((kind) =>
        [
          ...new Set(
            Object.values(process.elements).flatMap((element) => {
              const code = kind in element ? raisedCode((element as Record<string, unknown>)[kind] as Raised | undefined) : undefined;
              return code ? [code] : [];
            }),
          ),
        ].map((code) => ({ name: `bpmn:${kind}`, attributes: { id: raisedId(kind, code), name: code, [`${kind}Code`]: code } })),
      ),
      // Each signal that the process throws or waits for.
      ...[...new Set([...caughtSignals(process), ...thrownSignals(process)])].map((signal) => ({ name: 'bpmn:signal', attributes: { id: signalId(signal), name: signal } })),
      {
        name: 'bpmn:process',
        attributes: { id: name, name: process.label, isExecutable: 'true', 'ambit:entity': process.entity },
        children: [...(process.description ? [{ name: 'bpmn:documentation', text: process.description }] : []), ...contentOf(undefined)],
      },
      {
        name: 'bpmndi:BPMNDiagram',
        attributes: { id: `${name}_diagram` },
        children: [{ name: 'bpmndi:BPMNPlane', attributes: { id: `${name}_plane`, bpmnElement: name }, children: [...shapes, ...edges] }],
      },
    ],
  });
}

export interface BpmnIssue {
  /** The element of the file, by its ID, or the file as a whole. */
  readonly element: string | null;
  readonly message: string;
}

export type BpmnImport =
  | { readonly ok: true; readonly processes: Record<string, Process>; readonly notes: readonly string[] }
  | { readonly ok: false; readonly issues: readonly BpmnIssue[] };

/** Elements that only document a model: an import leaves them out, and says so. */
const DOCUMENTING = new Set(['textAnnotation', 'association', 'group', 'dataObject', 'dataObjectReference', 'dataStoreReference', 'dataStore', 'category', 'laneSet', 'documentation', 'extensionElements', 'ioSpecification', 'property', 'dataInputAssociation', 'dataOutputAssociation']);
/** What a sub-process has as a node of its own, not as something it holds. */
const NODE_PARTS = new Set(['incoming', 'outgoing', 'multiInstanceLoopCharacteristics', 'standardLoopCharacteristics']);
/** The elements Ambit doesn't run yet, as a sentence names them. */
const KINDS: Readonly<Record<string, string>> = {
  adHocSubProcess: 'an ad hoc sub-process',
  complexGateway: 'a complex gateway',
};
const EVENT_KINDS: Readonly<Record<string, string>> = {
  messageEventDefinition: 'message',
  signalEventDefinition: 'signal',
  errorEventDefinition: 'error',
  escalationEventDefinition: 'escalation',
  compensateEventDefinition: 'compensation',
  conditionalEventDefinition: 'conditional',
  linkEventDefinition: 'link',
  cancelEventDefinition: 'cancel',
  timerEventDefinition: 'timer',
  terminateEventDefinition: 'terminate',
};

/** Ambit's settings for a task that several people decide, from a multi-instance loop: who votes, and what decides. */
function several(loop: XmlElement): Several | undefined {
  const own = (local: string) => attribute(loop, local, AMBIT_BPMN);
  const people: Several['people'] | undefined =
    own('everyone') === 'true'
      ? { everyone: true }
      : own('fields')
        ? { fields: own('fields')!.split(/\s+/).filter(Boolean) }
        : own('lineOf')
          ? { lineOf: own('lineOf')!, levels: Number(own('levels') ?? '2') }
          : undefined;
  const count = own('count');
  const decide: Several['decide'] | undefined =
    own('decide') === 'first'
      ? { first: true }
      : count && own('outcome') && own('otherwise')
        ? { count: count === 'all' || count === 'majority' ? count : Number(count), outcome: own('outcome')!, otherwise: own('otherwise')! }
        : undefined;
  return people && decide ? { people, sequential: attribute(loop, 'isSequential') === 'true', decide } : undefined;
}

/** An Ambit name from a BPMN ID, such as `Process_Leave-1` → `process_leave_1`. */
function nameFrom(id: string, taken: ReadonlySet<string>): string {
  let base = id.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `process_${base}`;
  base = base.slice(0, 55);
  let name = base;
  for (let n = 2; taken.has(name) || !NAME_PATTERN.test(name); n++) name = `${base}_${n}`;
  return name;
}

/**
 * Read the processes of a BPMN 2.0 file, for an app. Each process is about records of `entity`,
 * which the file can name (`ambit:entity`), or the import names, or the app's only entity is.
 * Conditions written in Ambit's language are read as they are; a simple condition in another
 * language, such as `${days > 10}`, is read with its names as fields of the record.
 */
export function bpmnToProcesses(xml: string, definition: StoredDefinition, options: { readonly entity?: string } = {}): BpmnImport {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (error) {
    return { ok: false, issues: [{ element: null, message: error instanceof XmlError ? `Not a readable XML file: ${error.message}` : 'Not a readable XML file' }] };
  }
  if (root.ns !== BPMN_MODEL || root.local !== 'definitions') return { ok: false, issues: [{ element: null, message: 'Not a BPMN 2.0 file: its root is not bpmn:definitions' }] };

  const issues: BpmnIssue[] = [];
  const notes = new Set<string>();
  const processes: Record<string, Process> = {};
  const taken = new Set(Object.keys(definition.processes ?? {}));
  const owners = lineOwners(definition);
  const recordEntities = Object.keys(definition.entities).filter((name) => !owners.has(name));
  const bpmn = (element: XmlElement, local: string) => childElements(element, BPMN_MODEL, local);
  const ambit = (element: XmlElement, local: string) => attribute(element, local, AMBIT_BPMN);
  const label = (element: XmlElement) => attribute(element, 'name')?.trim() || undefined;
  const describe = (element: XmlElement) => `${label(element) ? `"${label(element)}" ` : ''}(${attribute(element, 'id') ?? 'no ID'})`;

  for (const collaboration of bpmn(root, 'collaboration')) {
    for (const participant of bpmn(collaboration, 'participant')) {
      if (!attribute(participant, 'processRef')) notes.add(`Left out the pool ${describe(participant)}: it has no process of its own`);
    }
    if (bpmn(collaboration, 'messageFlow').length) notes.add('Left out the message flows between pools: messages between participants are not run yet');
  }
  const plans = childElements(root, BPMN_DI, 'BPMNDiagram').flatMap((diagram) => childElements(diagram, BPMN_DI, 'BPMNPlane'));
  const shapesOf = new Map<string, XmlElement>();
  const edgesOf = new Map<string, XmlElement>();
  for (const plane of plans) {
    for (const shape of childElements(plane, BPMN_DI, 'BPMNShape')) shapesOf.set(attribute(shape, 'bpmnElement') ?? '', shape);
    for (const edge of childElements(plane, BPMN_DI, 'BPMNEdge')) edgesOf.set(attribute(edge, 'bpmnElement') ?? '', edge);
  }

  /** The codes of the errors and escalations of the file, by ID. */
  const codes = new Map(
    (['error', 'escalation'] as const).flatMap((kind) => bpmn(root, kind).map((item) => [attribute(item, 'id') ?? '', attribute(item, `${kind}Code`) ?? attribute(item, 'name')] as const)),
  );
  /** The names of the file's signals, by ID, as names Ambit takes. */
  const signals = new Map(bpmn(root, 'signal').map((signal) => [attribute(signal, 'id') ?? '', (attribute(signal, 'name') ?? '').trim()] as const));
  const messages = new Map(
    bpmn(root, 'message').map((message) => [attribute(message, 'id') ?? '', { name: attribute(message, 'name'), action: attribute(message, 'action', AMBIT_BPMN) }] as const),
  );
  const found = bpmn(root, 'process').filter((process) => childElements(process).some((child) => child.ns === BPMN_MODEL && !DOCUMENTING.has(child.local)));
  if (!found.length) return { ok: false, issues: [{ element: null, message: 'The file has no process with anything in it' }] };
  // Each process's name in the app, before any is read: a call activity names the process it calls by its ID in the file.
  const processNames = new Map<string, string>();
  for (const source of found) {
    const processName = nameFrom(attribute(source, 'id') ?? 'process', taken);
    taken.add(processName);
    processNames.set(attribute(source, 'id') ?? 'process', processName);
  }

  for (const source of found) {
    const processId = attribute(source, 'id') ?? 'process';
    const entity = ambit(source, 'entity') ?? options.entity ?? (recordEntities.length === 1 ? recordEntities[0] : undefined);
    if (!entity || !definition.entities[entity]) {
      issues.push({ element: processId, message: entity ? `The app has no entity ${entity}` : 'Name the entity whose records the process is about' });
      continue;
    }
    const fields = entityFields(definition.entities[entity]!);
    // In a condition from another tool, a bare name is a field of the record.
    const foreignName = (name: string) =>
      name.startsWith('record.') || name.startsWith('tasks.') || name === 'outcome' ? name : fields.has(name) ? `record.${name}` : undefined;
    const ids = new Map<string, string>();
    const idOf = (raw: string | undefined, where: XmlElement): string | undefined => {
      if (!raw) {
        issues.push({ element: processId, message: `${where.local} without an ID` });
        return undefined;
      }
      const known = ids.get(raw);
      if (known) return known;
      let id = raw.replace(/[^A-Za-z0-9_-]/g, '_');
      if (!/^[A-Za-z_]/.test(id)) id = `_${id}`;
      id = id.slice(0, 100);
      if (!ELEMENT_ID_PATTERN.test(id) || [...ids.values()].includes(id)) {
        issues.push({ element: raw, message: `The ID ${raw} can't be kept` });
        return undefined;
      }
      if (id !== raw) notes.add(`Changed the ID ${raw} to ${id}`);
      ids.set(raw, id);
      return id;
    };

    // Lanes name who does the tasks in them: a lane named after a role gives its tasks that role.
    const roleByLane = new Map<string, string>();
    for (const lane of bpmn(source, 'laneSet').flatMap((set) => bpmn(set, 'lane'))) {
      const name = label(lane)?.toLowerCase();
      const role = Object.entries(definition.roles).find(([key, value]) => key === name || value.label.toLowerCase() === name)?.[0];
      for (const ref of bpmn(lane, 'flowNodeRef')) if (role) roleByLane.set(textOf(ref).trim(), role);
    }
    if (bpmn(source, 'laneSet').length) notes.add('Left out the lanes; a lane named after a role gave its tasks that role');

    const elements: Record<string, ProcessElement> = {};
    const flows: Record<string, Flow> = {};
    const defaults = new Set<string>();
    const collapsed: string[] = [];
    const undos: Array<{ readonly boundary: string; readonly host: string | undefined }> = [];
    /** Read what stands in the process itself, or in one of its sub-processes. */
    const read = (container: XmlElement, scope: string | undefined): void => {
      for (const node of childElements(container)) {
        if (node.ns !== BPMN_MODEL) continue;
        if (DOCUMENTING.has(node.local)) {
          if (!['documentation', 'extensionElements', 'laneSet'].includes(node.local)) notes.add(`Left out what only documents the model, such as ${node.local}`);
          continue;
        }
        if (node.local === 'sequenceFlow' || NODE_PARTS.has(node.local)) continue;
        // A handler for compensation is a task's undo action: it comes in as part of the task it undoes.
        if (attribute(node, 'isForCompensation') === 'true') continue;
        const id = idOf(attribute(node, 'id'), node);
        if (!id) continue;
        const name = label(node);
        const documentation = bpmn(node, 'documentation').map(textOf).join('\n').trim() || undefined;
        const definitions = childElements(node).filter((child) => child.ns === BPMN_MODEL && child.local.endsWith('EventDefinition'));
        const kinds = definitions.map((child) => EVENT_KINDS[child.local] ?? child.local);
        const refuse = (message: string) => issues.push({ element: attribute(node, 'id') ?? id, message: `${message}: ${describe(node)}` });
        if (KINDS[node.local]) {
          refuse(`Ambit doesn't run ${KINDS[node.local]!} yet`);
          continue;
        }
        const loop = bpmn(node, 'multiInstanceLoopCharacteristics')[0];
        if (bpmn(node, 'standardLoopCharacteristics').length || (loop && (node.local !== 'userTask' || !several(loop)))) {
          refuse(loop && node.local === 'userTask' ? 'Say who votes and what decides, with Ambit\'s settings for a task that several people decide' : "Ambit doesn't run a task that repeats yet");
          continue;
        }
        const timerOf = (): Timer | undefined => {
          const timer = bpmn(node, 'timerEventDefinition')[0]!;
          const duration = bpmn(timer, 'timeDuration')[0];
          const date = bpmn(timer, 'timeDate')[0];
          if (duration && DURATION_PATTERN.test(textOf(duration).trim())) return { duration: textOf(duration).trim() };
          if (date) {
            const field = textOf(date).trim().replace(/^record\./, '');
            if (fields.has(field)) return { date: field };
          }
          refuse('A timer runs after an ISO 8601 duration, such as P3D, or on a date field of the record');
          return undefined;
        };
        /**
         * The message of an event or a task: the action of the message it names, from the message's
         * own setting, or a message named after one of the app's actions; and, for one it sends,
         * the reference field of the record it goes to.
         */
        const messageFrom = (holder: XmlElement): Message | undefined => {
          const action = messageOf(attribute(holder, 'messageRef'));
          const record = attribute(holder, 'record', AMBIT_BPMN) ?? attribute(node, 'record', AMBIT_BPMN);
          return action ? { action, ...(record ? { record } : {}) } : undefined;
        };
        const messageOf = (ref = attribute(bpmn(node, 'messageEventDefinition')[0]!, 'messageRef')): string | undefined => {
          const message = ref ? messages.get(ref) : undefined;
          const action = message?.action ?? (message?.name && definition.actions[message.name] ? message.name : undefined);
          if (!action || !definition.actions[action]) {
            refuse(`A message is one of the app's actions committing on the record: name the action, with ambit:action on the message${ref ? ` ${ref}` : ''}`);
            return undefined;
          }
          return action;
        };
        const linkName = () => attribute(bpmn(node, 'linkEventDefinition')[0]!, 'name')?.trim() || undefined;
        /** The signal an event throws or waits for, by its name, made one Ambit takes. */
        const signalOf = (): string | undefined => {
          const ref = attribute(bpmn(node, 'signalEventDefinition')[0]!, 'signalRef');
          const named = ref ? signals.get(ref) : undefined;
          const signal = named ? named.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') : '';
          if (!NAME_PATTERN.test(signal)) {
            refuse('A signal needs a name: name the bpmn:signal its event refers to with signalRef');
            return undefined;
          }
          if (signal !== named) notes.add(`Read the signal "${named}" of ${describe(node)} as ${signal}`);
          return signal;
        };
        /** An error or an escalation that an event throws or catches: by its code, or any. */
        const raisedOf = (kind: 'error' | 'escalation'): Raised => {
          const ref = attribute(bpmn(node, `${kind}EventDefinition`)[0]!, `${kind}Ref`);
          const code = ref ? codes.get(ref) : undefined;
          return code && NAME_PATTERN.test(code) ? { code } : true;
        };
        /** The condition of a conditional event: Ambit's text as it is, another tool's with its names as the record's fields. */
        const conditionOf = (): Condition | undefined => {
          const expression = bpmn(bpmn(node, 'conditionalEventDefinition')[0]!, 'condition')[0];
          const text = expression ? textOf(expression).trim() : '';
          const language = expression ? (attribute(expression, 'language') ?? attribute(source, 'expressionLanguage') ?? attribute(root, 'expressionLanguage')) : undefined;
          const parsed = text ? parseConditionText(text, language === LANGUAGES.condition ? (ref) => ref : foreignName) : undefined;
          if (!parsed?.ok) {
            refuse(`Ambit can't read the condition "${text}"${parsed && !parsed.ok ? `: ${parsed.message}` : ''}. Write it as a condition on the record's fields`);
            return undefined;
          }
          if (language !== LANGUAGES.condition) notes.add(`Read the condition "${text}" of ${describe(node)} as ${conditionText(parsed.condition)}`);
          return parsed.condition;
        };
        switch (node.local) {
          case 'startEvent': {
            const actions = (ambit(node, 'actions') ?? '').split(/\s+/).filter(Boolean);
            if (kinds.length === 1 && kinds[0] === 'message') {
              // A message starts a process when its action commits on a record: the start event names the action.
              const action = messageOf();
              if (action) elements[id] = { type: 'startEvent', ...(name ? { name } : {}), actions: [...new Set([...actions, action])] };
            } else if (kinds.length === 1 && kinds[0] === 'timer') {
              const timer = timerOf();
              if (timer) elements[id] = { type: 'startEvent', ...(name ? { name } : {}), actions: [], timer };
            } else if (kinds.length === 1 && kinds[0] === 'conditional') {
              const condition = conditionOf();
              if (condition) elements[id] = { type: 'startEvent', ...(name ? { name } : {}), actions: [], condition };
            } else if (kinds.length === 1 && kinds[0] === 'signal') {
              const signal = signalOf();
              if (signal) elements[id] = { type: 'startEvent', ...(name ? { name } : {}), actions: [], signal };
            } else if (kinds.length === 1 && (kinds[0] === 'error' || kinds[0] === 'escalation')) {
              // An event sub-process's start: the checks refuse it anywhere else.
              elements[id] = { type: 'startEvent', ...(name ? { name } : {}), actions: [], [kinds[0]]: raisedOf(kinds[0]) };
            } else if (kinds.length) refuse(`Ambit doesn't start a process on a ${kinds.join(' or ')} event yet`);
            else elements[id] = { type: 'startEvent', ...(name ? { name } : {}), actions };
            // An event sub-process's start that lets the rest go on.
            const made = elements[id];
            if (made?.type === 'startEvent' && attribute(node, 'isInterrupting') === 'false') elements[id] = { ...made, interrupting: false };
            break;
          }
          case 'endEvent': {
            const plain = { type: 'endEvent' as const, ...(name ? { name } : {}), terminate: false };
            if (kinds.length > 1 || kinds.some((kind) => !['terminate', 'message', 'error', 'escalation', 'compensation', 'cancel', 'signal'].includes(kind))) {
              refuse(`Ambit doesn't end a process with a ${kinds.join(' or ')} event yet`);
            } else if (kinds[0] === 'message') {
              const message = messageFrom(bpmn(node, 'messageEventDefinition')[0]!);
              if (message) elements[id] = { ...plain, message };
            } else if (kinds[0] === 'error') elements[id] = { ...plain, error: raisedOf('error') };
            else if (kinds[0] === 'escalation') elements[id] = { ...plain, escalation: raisedOf('escalation') };
            else if (kinds[0] === 'compensation') elements[id] = { ...plain, compensate: true };
            else if (kinds[0] === 'cancel') elements[id] = { ...plain, cancel: true };
            else if (kinds[0] === 'signal') {
              const signal = signalOf();
              if (signal) elements[id] = { ...plain, signal };
            } else elements[id] = { ...plain, terminate: kinds.includes('terminate') };
            break;
          }
          case 'scriptTask': {
            const format = attribute(node, 'scriptFormat');
            const script = bpmn(node, 'script')[0];
            let steps: unknown;
            try {
              steps = format === STEPS_FORMAT && script ? JSON.parse(textOf(script)) : undefined;
            } catch {
              steps = undefined;
            }
            if (!Array.isArray(steps)) {
              refuse(
                format === STEPS_FORMAT
                  ? "The script isn't a list of Ambit's steps"
                  : `Ambit runs no code${format ? ` in ${format}` : ''}: write the script as Ambit's steps (scriptFormat ${STEPS_FORMAT}), or run one of the app's actions with a service task`,
              );
              break;
            }
            // The definition's checks read the steps when the process is saved.
            elements[id] = { type: 'scriptTask', name: name ?? id, ...(documentation ? { description: documentation } : {}), steps: steps as Step[] };
            break;
          }
          case 'businessRuleTask': {
            const rules = (ambit(node, 'rules') ?? '').split(/\s+/).filter(Boolean);
            if (attribute(node, 'implementation') !== RULES_IMPLEMENTATION) notes.add(`Read ${describe(node)} as a check of the record against all the app's rules: Ambit has no DMN decisions`);
            elements[id] = { type: 'businessRuleTask', name: name ?? id, ...(documentation ? { description: documentation } : {}), ...(rules.length ? { rules } : {}) };
            break;
          }
          case 'sendTask':
          case 'receiveTask': {
            const message = messageFrom(node);
            if (message) elements[id] = { type: node.local, name: name ?? id, ...(documentation ? { description: documentation } : {}), message };
            break;
          }
          case 'intermediateThrowEvent': {
            if (kinds.length > 1 || (kinds.length === 1 && !['message', 'link', 'escalation', 'compensation', 'signal'].includes(kinds[0]!))) {
              refuse(`Ambit doesn't throw a ${kinds.join(' or ')} event yet`);
              break;
            }
            if (kinds[0] === 'escalation') elements[id] = { type: 'intermediateThrowEvent', ...(name ? { name } : {}), escalation: raisedOf('escalation') };
            else if (kinds[0] === 'compensation') elements[id] = { type: 'intermediateThrowEvent', ...(name ? { name } : {}), compensate: true };
            else if (kinds[0] === 'signal') {
              const signal = signalOf();
              if (signal) elements[id] = { type: 'intermediateThrowEvent', ...(name ? { name } : {}), signal };
            }
            else if (kinds[0] === 'message') {
              const message = messageFrom(bpmn(node, 'messageEventDefinition')[0]!);
              if (message) elements[id] = { type: 'intermediateThrowEvent', ...(name ? { name } : {}), message };
            } else if (kinds[0] === 'link') {
              const link = linkName();
              if (link && NAME_PATTERN.test(link)) elements[id] = { type: 'intermediateThrowEvent', ...(name ? { name } : {}), link };
              else refuse('Name a link with lowercase letters, digits and underscores');
            } else elements[id] = { type: 'intermediateThrowEvent', ...(name ? { name } : {}) };
            break;
          }
          case 'userTask': {
            const role = ambit(node, 'role') ?? roleByLane.get(attribute(node, 'id') ?? '');
            if (!role) {
              refuse('Say which role does the task: ambit:role, or a lane named after the role');
              break;
            }
            const outcomes = bpmn(node, 'extensionElements')
              .flatMap((extension) => childElements(extension, AMBIT_BPMN, 'outcome'))
              .map((outcome) => ({ name: attribute(outcome, 'name') ?? '', label: attribute(outcome, 'label') ?? attribute(outcome, 'name') ?? '', ...(attribute(outcome, 'action') ? { action: attribute(outcome, 'action')! } : {}) }));
            const votes = loop ? several(loop) : undefined;
            const assignee = ambit(node, 'assignee');
            const managerOf = ambit(node, 'managerOf');
            const levels = Number(ambit(node, 'levels') ?? '1');
            const department = ambit(node, 'department');
            const due = ambit(node, 'due');
            const card = ambit(node, 'card');
            elements[id] = {
              type: 'userTask',
              name: name ?? id,
              ...(documentation ? { description: documentation } : {}),
              role,
              ...(assignee ? { assignee: { field: assignee } } : managerOf ? { assignee: { managerOf, levels: Number.isInteger(levels) ? levels : 1 } } : {}),
              ...(department ? { department: { of: department } } : {}),
              ...(votes ? { several: votes } : {}),
              outcomes: outcomes.length ? outcomes : [{ name: 'done', label: 'Done' }],
              ...(due ? { due } : {}),
              ...(card ? { card } : {}),
            };
            if (!outcomes.length) notes.add(`${name ?? id} gets one outcome, Done: give a task its outcomes in Ambit`);
            break;
          }
          case 'serviceTask': {
            const action = ambit(node, 'action');
            const skill = ambit(node, 'skill');
            if (!action && !skill) {
              refuse('Say what the service task runs: one of the app\'s actions (ambit:action), or an a7c skill (ambit:skill)');
              break;
            }
            const input: Record<string, Expression> = {};
            for (const item of bpmn(node, 'extensionElements').flatMap((extension) => childElements(extension, AMBIT_BPMN, 'input'))) {
              let expression: unknown;
              try {
                expression = JSON.parse(textOf(item));
              } catch {
                expression = undefined;
              }
              if (isExpression(expression)) input[attribute(item, 'name') ?? ''] = expression;
              else refuse(`The input ${attribute(item, 'name') ?? ''} is not an Ambit expression`);
            }
            elements[id] = {
              type: 'serviceTask',
              name: name ?? id,
              ...(documentation ? { description: documentation } : {}),
              ...(action ? { action } : {}),
              ...(skill ? { skill, ...(Object.keys(input).length ? { input } : {}) } : {}),
            };
            break;
          }
          case 'task':
          case 'manualTask':
            elements[id] = { type: node.local === 'task' ? 'task' : 'manualTask', name: name ?? id, ...(documentation ? { description: documentation } : {}) };
            break;
          case 'eventBasedGateway':
            // An event-based gateway that starts a process has no record to start on.
            if (attribute(node, 'instantiate') === 'true') refuse("Ambit doesn't start a process at an event-based gateway: a process starts on a record");
            else elements[id] = { type: 'eventBasedGateway', ...(name ? { name } : {}) };
            break;
          case 'exclusiveGateway':
          case 'parallelGateway':
          case 'inclusiveGateway':
            elements[id] = { type: node.local === 'exclusiveGateway' ? 'exclusiveGateway' : node.local === 'inclusiveGateway' ? 'inclusiveGateway' : 'parallelGateway', ...(name ? { name } : {}) };
            if (node.local !== 'parallelGateway' && attribute(node, 'default')) defaults.add(attribute(node, 'default')!);
            break;
          case 'intermediateCatchEvent': {
            if (kinds.length !== 1 || !['timer', 'message', 'link', 'conditional', 'signal'].includes(kinds[0]!)) {
              refuse(`Ambit doesn't wait for a ${kinds.join(' or ') || 'plain'} event yet`);
              break;
            }
            if (kinds[0] === 'conditional') {
              const condition = conditionOf();
              if (condition) elements[id] = { type: 'intermediateCatchEvent', ...(name ? { name } : {}), condition };
            } else if (kinds[0] === 'signal') {
              const signal = signalOf();
              if (signal) elements[id] = { type: 'intermediateCatchEvent', ...(name ? { name } : {}), signal };
            } else if (kinds[0] === 'timer') {
              const timer = timerOf();
              if (timer) elements[id] = { type: 'intermediateCatchEvent', ...(name ? { name } : {}), timer };
            } else if (kinds[0] === 'link') {
              const link = linkName();
              if (link && NAME_PATTERN.test(link)) elements[id] = { type: 'intermediateCatchEvent', ...(name ? { name } : {}), link };
              else refuse('Name a link with lowercase letters, digits and underscores');
            } else {
              const action = messageOf();
              if (action) elements[id] = { type: 'intermediateCatchEvent', ...(name ? { name } : {}), message: { action } };
            }
            break;
          }
          case 'subProcess':
          case 'transaction': {
            elements[id] = {
              type: 'subProcess',
              name: name ?? id,
              ...(documentation ? { description: documentation } : {}),
              ...(node.local === 'transaction' ? { transaction: true as const } : {}),
              ...(attribute(node, 'triggeredByEvent') === 'true' ? { event: true as const } : {}),
            };
            if (attribute(shapesOf.get(attribute(node, 'id') ?? '') ?? node, 'isExpanded') !== 'true') collapsed.push(id);
            read(node, id);
            break;
          }
          case 'callActivity': {
            const called = attribute(node, 'calledElement');
            const process = called ? (processNames.get(called) ?? (definition.processes?.[called] ? called : undefined)) : undefined;
            if (!process) {
              refuse(called ? `It calls ${called}, which neither the file nor the app has` : 'Say which process the call activity runs: calledElement');
              break;
            }
            const record = ambit(node, 'record');
            elements[id] = { type: 'callActivity', name: name ?? id, ...(documentation ? { description: documentation } : {}), process, ...(record ? { record } : {}) };
            break;
          }
          case 'boundaryEvent': {
            if (kinds.length === 1 && kinds[0] === 'compensation') {
              // An undo: the task's compensation handler, read with the associations of the container.
              undos.push({ boundary: id, host: idOf(attribute(node, 'attachedToRef'), node) });
              break;
            }
            if (kinds.length !== 1 || !['timer', 'message', 'error', 'conditional', 'escalation', 'cancel', 'signal'].includes(kinds[0]!)) {
              refuse(`Ambit doesn't catch a ${kinds.join(' or ') || 'plain'} event on a task yet`);
              break;
            }
            const attachedTo = idOf(attribute(node, 'attachedToRef'), node);
            const interrupting = attribute(node, 'cancelActivity') !== 'false';
            const base = { type: 'boundaryEvent' as const, ...(name ? { name } : {}), attachedTo: attachedTo ?? '', interrupting };
            if (!attachedTo) break;
            if (kinds[0] === 'timer') {
              const timer = timerOf();
              if (timer) elements[id] = { ...base, timer };
            } else if (kinds[0] === 'conditional') {
              const condition = conditionOf();
              if (condition) elements[id] = { ...base, condition };
            } else if (kinds[0] === 'message') {
              const action = messageOf();
              if (action) elements[id] = { ...base, message: { action } };
            } else if (kinds[0] === 'escalation') {
              elements[id] = { ...base, escalation: raisedOf('escalation') };
            } else if (kinds[0] === 'signal') {
              const signal = signalOf();
              if (signal) elements[id] = { ...base, signal };
            } else if (kinds[0] === 'cancel') {
              elements[id] = { ...base, interrupting: true, cancel: true };
            } else {
              elements[id] = { ...base, interrupting: true, error: raisedOf('error') };
            }
            break;
          }
          default:
            refuse(`Ambit doesn't know the element ${node.local}`);
        }
        // What a sub-process holds names it.
        const made = elements[id];
        if (made && scope !== undefined && made.type !== 'boundaryEvent') elements[id] = { ...made, in: scope };
      }
    };
    read(source, undefined);
    const sequenceFlows = (container: XmlElement): XmlElement[] => [
      ...bpmn(container, 'sequenceFlow'),
      ...[...bpmn(container, 'subProcess'), ...bpmn(container, 'transaction')].flatMap(sequenceFlows),
    ];
    // Undos: each compensation event leads, by an association, to a handler that runs the undo action.
    const containers = (container: XmlElement): XmlElement[] => [container, ...[...bpmn(container, 'subProcess'), ...bpmn(container, 'transaction')].flatMap(containers)];
    const associations = containers(source).flatMap((container) => bpmn(container, 'association'));
    const handlers = new Map(
      containers(source).flatMap((container) => childElements(container).filter((child) => attribute(child, 'isForCompensation') === 'true').map((child) => [attribute(child, 'id') ?? '', child] as const)),
    );
    for (const { boundary, host } of undos) {
      const link = associations.find((association) => idOf(attribute(association, 'sourceRef'), association) === boundary);
      const handler = link ? handlers.get(attribute(link, 'targetRef') ?? '') : undefined;
      const action = handler ? attribute(handler, 'action', AMBIT_BPMN) : undefined;
      const task = host ? elements[host] : undefined;
      if (!action || !task || !('undo' in task || task.type === 'serviceTask' || task.type === 'scriptTask' || task.type === 'sendTask')) {
        issues.push({ element: boundary, message: `Ambit undoes a task with one of the app's actions: give the compensation handler of ${boundary} an ambit:action` });
        continue;
      }
      if (task.type === 'serviceTask' || task.type === 'scriptTask' || task.type === 'sendTask') elements[host!] = { ...task, undo: action };
    }
    for (const node of sequenceFlows(source)) {
      const id = idOf(attribute(node, 'id'), node);
      const from = idOf(attribute(node, 'sourceRef'), node);
      const to = idOf(attribute(node, 'targetRef'), node);
      if (!id || !from || !to) continue;
      const name = label(node);
      const flow: { -readonly [K in keyof Flow]: Flow[K] } = { from, to, ...(name ? { name } : {}) };
      if (defaults.has(attribute(node, 'id')!)) flow.default = true;
      const condition = bpmn(node, 'conditionExpression')[0];
      if (condition) {
        const language = attribute(condition, 'language') ?? attribute(source, 'expressionLanguage') ?? attribute(root, 'expressionLanguage');
        const text = textOf(condition).trim();
        if (language === LANGUAGES.outcome) flow.outcome = text;
        else {
          const parsed = parseConditionText(text, language === LANGUAGES.condition ? (ref) => ref : foreignName);
          if (parsed.ok) {
            flow.when = parsed.condition;
            if (language !== LANGUAGES.condition) notes.add(`Read the condition "${text}" of ${describe(node)} as ${conditionText(parsed.condition)}`);
          } else {
            issues.push({ element: attribute(node, 'id')!, message: `Ambit can't read the condition "${text}" of ${describe(node)}: ${parsed.message}. Write it as a condition on the record's fields` });
          }
        }
      }
      flows[id] = flow;
    }
    // Another tool's `outcome`: a flow straight out of a user task follows that outcome, and one out
    // of a gateway after a task reads the task's.
    for (const flow of Object.values(flows)) {
      const from = elements[flow.from];
      const when = flow.when;
      if (!when) continue;
      if (from?.type === 'userTask' && 'eq' in when) {
        const [left, right] = when.eq;
        if (isRef(left) && left.ref === 'outcome' && typeof right === 'string') {
          delete flow.when;
          flow.outcome = right;
          continue;
        }
      }
      const before = new Set(Object.values(flows).filter((other) => other.to === flow.from).map((other) => other.from));
      const [task] = before;
      if (from?.type === 'exclusiveGateway' && before.size === 1 && task && elements[task]?.type === 'userTask') {
        flow.when = mapRefs(when, (ref) => (ref === 'outcome' ? `tasks.${task}.outcome` : ref));
      }
    }

    // The diagram: shapes and edges of what was kept.
    const boundsOf = (element: XmlElement | undefined) => {
      const box = element ? childElements(element, DC, 'Bounds')[0] : undefined;
      if (!box) return undefined;
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => Number(attribute(box, key)));
      return [x, y, width, height].every((value) => Number.isFinite(value)) && width! > 0 && height! > 0 ? { x: x!, y: y!, width: width!, height: height! } : undefined;
    };
    const diagram: { shapes: Diagram['shapes']; edges: Diagram['edges'] } = { shapes: {}, edges: {} };
    for (const [raw, id] of ids) {
      const shape = shapesOf.get(raw);
      const box = boundsOf(shape);
      if (box && elements[id]) {
        const labelBox = boundsOf(shape ? childElements(shape, BPMN_DI, 'BPMNLabel')[0] : undefined);
        diagram.shapes[id] = { ...box, ...(labelBox ? { label: labelBox } : {}) };
      }
      const edge = edgesOf.get(raw);
      if (edge && flows[id]) {
        const points = childElements(edge, DI, 'waypoint')
          .map((point) => ({ x: Number(attribute(point, 'x')), y: Number(attribute(point, 'y')) }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        const labelBox = boundsOf(childElements(edge, BPMN_DI, 'BPMNLabel')[0]);
        if (points.length >= 2) diagram.edges[id] = { points: points.slice(0, 50), ...(labelBox ? { label: labelBox } : {}) };
      }
    }

    const processName = processNames.get(processId)!;
    const description = bpmn(source, 'documentation').map(textOf).join('\n').trim();
    const imported: Process = {
      label: label(source) ?? processName,
      ...(description ? { description } : {}),
      entity,
      elements,
      flows,
    };
    if (Object.keys(diagram.shapes).length) {
      // Ambit draws a sub-process open, with what it holds: one drawn closed is laid out again.
      if (collapsed.length) notes.add(`Laid out ${imported.label} again: Ambit draws a sub-process open, with what it holds`);
      imported.diagram = collapsed.length ? layoutProcess(imported) : diagram;
    }
    processes[processName] = imported;
  }
  return issues.length ? { ok: false, issues } : { ok: true, processes, notes: [...notes] };
}
