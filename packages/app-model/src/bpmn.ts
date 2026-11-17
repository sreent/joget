import { isRef } from '@platform/authz';
import { conditionText, parseConditionText } from './condition-text.js';
import { isExpression, type Expression } from './expressions.js';
import { entityFields, lineOwners, type StoredDefinition } from './fields.js';
import { processGraph } from './processes.js';
import { DURATION_PATTERN, ELEMENT_ID_PATTERN, NAME_PATTERN, type Diagram, type Flow, type Process, type ProcessElement } from './schema.js';
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

/**
 * Lay a process out from left to right: each element one column after what leads to it, from the
 * start events; flows as lines with right angles. For a process drawn without a diagram.
 */
export function layoutProcess(process: Process): Diagram {
  const graph = processGraph(process);
  const column = new Map<string, number>();
  const order: string[] = [];
  const queue = Object.entries(process.elements).flatMap(([id, element]) => (element.type === 'startEvent' ? [id] : []));
  for (const id of queue) column.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    const next = [...(graph.outgoing.get(id) ?? []).map((flow) => process.flows[flow]!.to), ...(graph.boundaries.get(id) ?? []).flatMap((boundary) => (graph.outgoing.get(boundary) ?? []).map((flow) => process.flows[flow]!.to))];
    for (const target of next) {
      if (column.has(target)) continue;
      column.set(target, column.get(id)! + 1);
      queue.push(target);
    }
  }
  for (const id of Object.keys(process.elements)) {
    if (!column.has(id) && process.elements[id]!.type !== 'boundaryEvent') {
      column.set(id, 0);
      order.push(id);
    }
  }
  const rows = new Map<number, number>();
  const shapes: Record<string, Diagram['shapes'][string]> = {};
  for (const id of order) {
    const element = process.elements[id]!;
    if (element.type === 'boundaryEvent') continue;
    const col = column.get(id)!;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const size = sizeOf(element);
    const centerX = 120 + col * 170;
    const centerY = 120 + row * 140;
    shapes[id] = { x: centerX - size.width / 2, y: centerY - size.height / 2, ...size };
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
    if (!from || !to) continue;
    const boundary = process.elements[flow.from]?.type === 'boundaryEvent';
    const start = boundary ? { x: from.x + from.width / 2, y: from.y + from.height } : { x: from.x + from.width, y: from.y + from.height / 2 };
    const end = { x: to.x, y: to.y + to.height / 2 };
    if (boundary) edges[id] = { points: [start, { x: start.x, y: end.y }, end] };
    else if (start.y === end.y) edges[id] = { points: [start, end] };
    else {
      const middle = Math.round((start.x + end.x) / 2);
      edges[id] = { points: [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end] };
    }
  }
  return { shapes, edges };
}

const TAGS: Readonly<Record<ProcessElement['type'], string>> = {
  startEvent: 'bpmn:startEvent',
  endEvent: 'bpmn:endEvent',
  userTask: 'bpmn:userTask',
  serviceTask: 'bpmn:serviceTask',
  task: 'bpmn:task',
  manualTask: 'bpmn:manualTask',
  exclusiveGateway: 'bpmn:exclusiveGateway',
  parallelGateway: 'bpmn:parallelGateway',
  intermediateCatchEvent: 'bpmn:intermediateCatchEvent',
  boundaryEvent: 'bpmn:boundaryEvent',
};

const formal = (name: string, language: string, text: string): XmlOut => ({ name, attributes: { 'xsi:type': 'bpmn:tFormalExpression', language }, text });

/** Write one of an app's processes as a BPMN 2.0 file, with its diagram, laid out if it has none. */
export function processToBpmn(definition: StoredDefinition, name: string): string {
  const process = definition.processes?.[name];
  if (!process) throw new Error(`No process named ${name}`);
  const graph = processGraph(process);
  const diagram = process.diagram && Object.keys(process.diagram.shapes).length ? process.diagram : layoutProcess(process);
  const defaults = new Map(Object.entries(process.flows).flatMap(([id, flow]) => (flow.default ? [[flow.from, id] as const] : [])));
  const timer = (id: string, definitionOf: Extract<ProcessElement, { timer: unknown }>['timer']): XmlOut => ({
    name: 'bpmn:timerEventDefinition',
    attributes: { id: `${id}_timer` },
    children: ['duration' in definitionOf ? formal('bpmn:timeDuration', LANGUAGES.duration, definitionOf.duration) : formal('bpmn:timeDate', LANGUAGES.field, definitionOf.date)],
  });

  const elements: XmlOut[] = Object.entries(process.elements).map(([id, element]) => {
    const children: XmlOut[] = [];
    if ('description' in element && element.description) children.push({ name: 'bpmn:documentation', text: element.description });
    const attributes: Record<string, string | undefined> = { id, name: element.name };
    switch (element.type) {
      case 'startEvent':
        if (element.actions.length) attributes['ambit:actions'] = element.actions.join(' ');
        break;
      case 'endEvent':
        break;
      case 'userTask':
        attributes['ambit:role'] = element.role;
        attributes['ambit:assignee'] = element.assignee?.field;
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
        attributes['default'] = defaults.get(id);
        break;
      case 'boundaryEvent':
        attributes['attachedToRef'] = element.attachedTo;
        attributes['cancelActivity'] = element.interrupting ? 'true' : 'false';
        break;
      default:
        break;
    }
    for (const flow of graph.incoming.get(id) ?? []) children.push({ name: 'bpmn:incoming', text: flow });
    for (const flow of graph.outgoing.get(id) ?? []) children.push({ name: 'bpmn:outgoing', text: flow });
    if (element.type === 'endEvent' && element.terminate) children.push({ name: 'bpmn:terminateEventDefinition', attributes: { id: `${id}_terminate` } });
    if (element.type === 'intermediateCatchEvent' || element.type === 'boundaryEvent') children.push(timer(id, element.timer));
    return { name: TAGS[element.type], attributes, children };
  });
  const flows: XmlOut[] = Object.entries(process.flows).map(([id, flow]) => {
    const children: XmlOut[] = [];
    if (flow.when) children.push(formal('bpmn:conditionExpression', LANGUAGES.condition, conditionText(flow.when)));
    if (flow.outcome !== undefined) children.push(formal('bpmn:conditionExpression', LANGUAGES.outcome, flow.outcome));
    return { name: 'bpmn:sequenceFlow', attributes: { id, name: flow.name, sourceRef: flow.from, targetRef: flow.to }, children };
  });

  const bounds = (b: { x: number; y: number; width: number; height: number }): XmlOut => ({ name: 'dc:Bounds', attributes: { x: b.x, y: b.y, width: b.width, height: b.height } });
  const shapes: XmlOut[] = Object.entries(diagram.shapes).map(([id, shape]) => ({
    name: 'bpmndi:BPMNShape',
    attributes: { id: `${id}_di`, bpmnElement: id, ...(process.elements[id]?.type === 'exclusiveGateway' ? { isMarkerVisible: 'true' } : {}) },
    children: [bounds(shape), ...(shape.label ? [{ name: 'bpmndi:BPMNLabel', children: [bounds(shape.label)] }] : [])],
  }));
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
      {
        name: 'bpmn:process',
        attributes: { id: name, name: process.label, isExecutable: 'true', 'ambit:entity': process.entity },
        children: [...(process.description ? [{ name: 'bpmn:documentation', text: process.description }] : []), ...elements, ...flows],
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
/** The elements Ambit doesn't run yet, as a sentence names them. */
const KINDS: Readonly<Record<string, string>> = {
  scriptTask: 'a script task',
  businessRuleTask: 'a business rule task',
  sendTask: 'a send task',
  receiveTask: 'a receive task',
  callActivity: 'a call activity',
  subProcess: 'a sub-process',
  adHocSubProcess: 'an ad hoc sub-process',
  transaction: 'a transaction',
  eventBasedGateway: 'an event-based gateway',
  inclusiveGateway: 'an inclusive gateway',
  complexGateway: 'a complex gateway',
  intermediateThrowEvent: 'a throw event',
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

  const found = bpmn(root, 'process').filter((process) => childElements(process).some((child) => child.ns === BPMN_MODEL && !DOCUMENTING.has(child.local)));
  if (!found.length) return { ok: false, issues: [{ element: null, message: 'The file has no process with anything in it' }] };

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
    for (const node of childElements(source)) {
      if (node.ns !== BPMN_MODEL) continue;
      if (DOCUMENTING.has(node.local)) {
        if (!['documentation', 'extensionElements', 'laneSet'].includes(node.local)) notes.add(`Left out what only documents the model, such as ${node.local}`);
        continue;
      }
      if (node.local === 'sequenceFlow') continue;
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
      if (bpmn(node, 'multiInstanceLoopCharacteristics').length || bpmn(node, 'standardLoopCharacteristics').length) {
        refuse("Ambit doesn't run a task that repeats or runs for several people yet");
        continue;
      }
      const timerOf = (): Extract<ProcessElement, { timer: unknown }>['timer'] | undefined => {
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
      switch (node.local) {
        case 'startEvent':
          if (kinds.length) refuse(`Ambit doesn't start a process on a ${kinds.join(' or ')} event yet`);
          else elements[id] = { type: 'startEvent', ...(name ? { name } : {}), actions: (ambit(node, 'actions') ?? '').split(/\s+/).filter(Boolean) };
          break;
        case 'endEvent':
          if (kinds.some((kind) => kind !== 'terminate')) refuse(`Ambit doesn't end a process with a ${kinds.join(' or ')} event yet`);
          else elements[id] = { type: 'endEvent', ...(name ? { name } : {}), terminate: kinds.includes('terminate') };
          break;
        case 'userTask': {
          const role = ambit(node, 'role') ?? roleByLane.get(attribute(node, 'id') ?? '');
          if (!role) {
            refuse('Say which role does the task: ambit:role, or a lane named after the role');
            break;
          }
          const outcomes = bpmn(node, 'extensionElements')
            .flatMap((extension) => childElements(extension, AMBIT_BPMN, 'outcome'))
            .map((outcome) => ({ name: attribute(outcome, 'name') ?? '', label: attribute(outcome, 'label') ?? attribute(outcome, 'name') ?? '', ...(attribute(outcome, 'action') ? { action: attribute(outcome, 'action')! } : {}) }));
          const assignee = ambit(node, 'assignee');
          const due = ambit(node, 'due');
          const card = ambit(node, 'card');
          elements[id] = {
            type: 'userTask',
            name: name ?? id,
            ...(documentation ? { description: documentation } : {}),
            role,
            ...(assignee ? { assignee: { field: assignee } } : {}),
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
        case 'exclusiveGateway':
        case 'parallelGateway':
          elements[id] = { type: node.local === 'exclusiveGateway' ? 'exclusiveGateway' : 'parallelGateway', ...(name ? { name } : {}) };
          if (node.local === 'exclusiveGateway' && attribute(node, 'default')) defaults.add(attribute(node, 'default')!);
          break;
        case 'intermediateCatchEvent': {
          if (kinds.length !== 1 || kinds[0] !== 'timer') {
            refuse(`Ambit doesn't wait for a ${kinds.join(' or ') || 'plain'} event yet`);
            break;
          }
          const timer = timerOf();
          if (timer) elements[id] = { type: 'intermediateCatchEvent', ...(name ? { name } : {}), timer };
          break;
        }
        case 'boundaryEvent': {
          if (kinds.length !== 1 || kinds[0] !== 'timer') {
            refuse(`Ambit doesn't catch a ${kinds.join(' or ') || 'plain'} event on a task yet`);
            break;
          }
          const timer = timerOf();
          const attachedTo = idOf(attribute(node, 'attachedToRef'), node);
          if (timer && attachedTo) elements[id] = { type: 'boundaryEvent', ...(name ? { name } : {}), attachedTo, interrupting: attribute(node, 'cancelActivity') !== 'false', timer };
          break;
        }
        default:
          refuse(`Ambit doesn't know the element ${node.local}`);
      }
    }
    for (const node of bpmn(source, 'sequenceFlow')) {
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

    const processName = nameFrom(processId, taken);
    taken.add(processName);
    const description = bpmn(source, 'documentation').map(textOf).join('\n').trim();
    processes[processName] = {
      label: label(source) ?? processName,
      ...(description ? { description } : {}),
      entity,
      elements,
      flows,
      ...(Object.keys(diagram.shapes).length ? { diagram } : {}),
    };
  }
  return issues.length ? { ok: false, issues } : { ok: true, processes, notes: [...notes] };
}
