import {
  canRepeat,
  conditionText,
  eventKind,
  RULE_OUTCOMES,
  scopeOf,
  scopesOf,
  validateDefinition,
  type BoundaryEventElement,
  type Flow,
  type Process,
  type ProcessElement,
  type Raised,
  type Repeat,
} from '@platform/app-model';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { applyNodeChanges, Background, Controls, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.js';
import { ConditionEditor } from '../components/condition.js';
import { Badge, Button, Card, Checkbox, cx, Dialog, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { recordChoices, type RefChoice } from '../model/conditions.js';
import {
  addBoundary,
  addElement,
  arrange,
  isAdHocElement,
  boundaryKinds,
  callChoices,
  connect,
  sendChoices,
  startingCondition,
  durationOf,
  durationParts,
  durationWords,
  issuesByPart,
  messageChoices,
  moveElement,
  newProcess,
  PALETTE,
  processEntities,
  removeElement,
  removeFlow,
  removeProcess,
  signalChoices,
  undoChoices,
  updateActions,
  updateElement,
  updateFlow,
  updateProcess,
  type ElementKind,
} from '../model/processes.js';
import type { Definition } from '../types.js';
import type { Message } from '@platform/app-model';
import { StepsEditor } from './StepsEditor.js';

type Selection = { readonly kind: 'element' | 'flow'; readonly id: string } | null;

interface ShapeData extends Record<string, unknown> {
  readonly element: ProcessElement;
  readonly boundaries: ReadonlyArray<{ readonly id: string; readonly element: BoundaryEventElement; readonly left: number; readonly title: string }>;
  readonly problems: number;
  /** A start event that starts an event sub-process, which shows its trigger. */
  readonly triggers?: boolean;
  /** A sub-process's size, which what it holds sets. */
  readonly size?: { readonly width: number; readonly height: number };
}
type ShapeNode = Node<ShapeData, 'bpmn'>;

const ICON_PATH: Partial<Record<ProcessElement['type'], string>> = {
  userTask: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 6a5 5 0 0 1 10 0',
  serviceTask: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5 13 13M3 13l1.5-1.5M11.5 4.5 13 3',
  manualTask: 'M4 9V4.5a1 1 0 0 1 2 0V8m0-4a1 1 0 0 1 2 0v4m0-3a1 1 0 0 1 2 0v3m0-2a1 1 0 0 1 2 0v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9',
  scriptTask: 'M4.5 2h7.5l-1.5 3 1.5 3-1.5 3 1.5 3H4.5L6 11 4.5 8 6 5ZM7 5h3M7.5 8h3M7 11h3',
  businessRuleTask: 'M2 3h12v10H2ZM2 6h12M2 9.5h12M5.5 6v7',
  receiveTask: 'M2 4h12v8.5H2ZM2.5 4.5 8 9l5.5-4.5',
};
/** Markers BPMN fills: a send task's envelope. */
const FILLED_PATH: Partial<Record<ProcessElement['type'], string>> = {
  sendTask: 'M2 4h12v8.5H2Z',
};

/**
 * BPMN's markers for what an event waits for or throws: a clock for a time, an envelope for a
 * message, a lightning bolt for an error, an arrow for a link, an arrowhead for an escalation, two
 * triangles that point back for an undo, a cross for a cancel, and a triangle for a signal. A throw
 * event's marker is filled.
 */
function EventIcon({
  kind,
  size = 16,
  filled = false,
}: {
  kind: 'timer' | 'message' | 'error' | 'link' | 'condition' | 'escalation' | 'compensation' | 'cancel' | 'signal';
  size?: number;
  filled?: boolean;
}) {
  const fill = filled ? 'currentColor' : 'none';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="text-text">
      {kind === 'message' ? (
        <>
          <rect x="2" y="4" width="12" height="8.5" rx="1" fill={fill} stroke="currentColor" strokeWidth="1.3" />
          <path d="m2.5 4.5 5.5 4.5 5.5-4.5" fill="none" stroke={filled ? 'var(--surface)' : 'currentColor'} strokeWidth="1.3" strokeLinejoin="round" />
        </>
      ) : kind === 'condition' ? (
        <path d="M4 2.5h8v11H4ZM6 5.5h4M6 8h4M6 10.5h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      ) : kind === 'link' ? (
        <path d="M2.5 6h6.5V3.5L13.5 8 9 12.5V10H2.5Z" fill={fill} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      ) : kind === 'error' ? (
        <path d="M3 13.5 6 6l3.5 3.5L13 2.5 10 10 6.5 6.5Z" fill={fill} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      ) : kind === 'escalation' ? (
        <path d="M8 2.5 12 13 8 9.5 4 13Z" fill={fill} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      ) : kind === 'compensation' ? (
        <path d="M8 4.5v7L3 8Zm5.5 0v7L8.5 8Z" fill={fill} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      ) : kind === 'signal' ? (
        <path d="M8 2.5 13.5 12.5H2.5Z" fill={fill} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      ) : kind === 'cancel' ? (
        <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth={filled ? 2.6 : 1.6} strokeLinecap="round" />
      ) : (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** One element, drawn with BPMN 2.0's shapes: circles for events, rounded boxes for tasks, diamonds for gateways. */
function Shape({ data, selected }: NodeProps<ShapeNode>) {
  const { element, boundaries, problems, triggers } = data;
  const ring = selected ? 'ring-2 ring-focus' : '';
  // An event sub-process starts on its trigger: no flow joins it.
  const apart = element.type === 'subProcess' && element.event === true;
  const hasIn = element.type !== 'startEvent' && !apart;
  const hasOut = element.type !== 'endEvent' && !(element.type === 'intermediateThrowEvent' && element.link !== undefined) && !apart;
  const hasInHandle = !(element.type === 'intermediateCatchEvent' && element.link !== undefined);
  const label = 'name' in element && element.name ? element.name : undefined;
  const handles = (
    <>
      {hasIn && hasInHandle ? <Handle type="target" position={Position.Left} className="!size-2 !border-line-strong !bg-surface" /> : null}
      {hasOut ? <Handle type="source" position={Position.Right} className="!size-2 !border-line-strong !bg-surface" /> : null}
    </>
  );
  const problem = problems ? (
    <span className="absolute -top-2 -right-2 grid size-5 place-items-center rounded-full bg-bad text-[11px] font-semibold text-white" title={`${problems} problem(s)`}>
      {problems}
    </span>
  ) : null;
  if (element.type.endsWith('Event')) {
    const end = element.type === 'endEvent';
    return (
      <div className="relative size-9">
        <div
          className={cx(
            'grid size-9 place-items-center rounded-full bg-surface',
            end ? 'border-[3px] border-text' : 'border-[1.5px] border-text',
            element.type === 'startEvent' && element.interrupting === false ? 'border-dashed' : '',
            ring,
          )}
        >
          {element.type === 'intermediateCatchEvent' ? (
            <div className="grid size-7 place-items-center rounded-full border border-text">
              <EventIcon kind={element.link !== undefined ? 'link' : eventKind(element)} />
            </div>
          ) : null}
          {element.type === 'startEvent' && startTrigger(element, triggers === true) ? <EventIcon kind={startTrigger(element, triggers === true)!} size={18} /> : null}
          {element.type === 'intermediateThrowEvent' ? (
            <div className="grid size-7 place-items-center rounded-full border border-text">
              {element.message ? (
                <EventIcon kind="message" filled />
              ) : element.link !== undefined ? (
                <EventIcon kind="link" filled />
              ) : element.signal !== undefined ? (
                <EventIcon kind="signal" filled />
              ) : element.escalation ? (
                <EventIcon kind="escalation" filled />
              ) : element.compensate ? (
                <EventIcon kind="compensation" filled />
              ) : null}
            </div>
          ) : null}
          {end && element.message ? <EventIcon kind="message" size={14} filled /> : null}
          {end && element.error ? <EventIcon kind="error" size={16} filled /> : null}
          {end && element.escalation ? <EventIcon kind="escalation" size={16} filled /> : null}
          {end && element.compensate ? <EventIcon kind="compensation" size={16} filled /> : null}
          {end && element.cancel ? <EventIcon kind="cancel" size={16} filled /> : null}
          {end && element.signal !== undefined ? <EventIcon kind="signal" size={16} filled /> : null}
          {end && element.terminate ? <div className="size-4 rounded-full bg-text" /> : null}
        </div>
        {label ? <span className="absolute top-10 left-1/2 w-28 -translate-x-1/2 text-center text-[11px] leading-tight text-muted">{label}</span> : null}
        {handles}
        {problem}
      </div>
    );
  }
  const markers = boundaries.map((boundary) => (
    <div key={boundary.id} className="absolute -bottom-[18px]" style={{ left: boundary.left }} title={boundary.title}>
      <div className={cx('grid size-9 place-items-center rounded-full bg-surface', boundary.element.interrupting ? 'border-[1.5px] border-text' : 'border-[1.5px] border-dashed border-text')}>
        <EventIcon kind={eventKind(boundary.element)} size={14} />
      </div>
      <Handle id={boundary.id} type="source" position={Position.Bottom} className="!size-2 !border-line-strong !bg-surface" />
    </div>
  ));
  if (element.type === 'subProcess') {
    // Drawn open, with what it holds inside it: its name at the top.
    return (
      <div
        className={cx('relative rounded-xl border-text bg-surface/50', element.transaction ? 'border-[5px] border-double' : element.event ? 'border-2 border-dotted' : 'border-[1.5px]', ring)}
        style={{ width: data.size?.width ?? 340, height: data.size?.height ?? 180 }}
      >
        <span className="absolute top-2 left-3 text-xs font-semibold text-text">{label}</span>
        {element.repeat ? <LoopMarker className="bottom-1 left-[calc(50%+10px)]" /> : null}
        {element.adHoc ? (
          // BPMN's marker for an ad hoc sub-process: a tilde.
          <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-base leading-none font-semibold text-text" aria-label="Ad hoc">
            ~
          </span>
        ) : null}
        {markers}
        {handles}
        {problem}
      </div>
    );
  }
  if (element.type.endsWith('Gateway')) {
    return (
      <div className="relative grid size-[50px] place-items-center">
        <div className={cx('absolute size-[35px] rotate-45 border-[1.5px] border-text bg-surface', ring)} />
        {element.type === 'inclusiveGateway' ? (
          <span className="relative size-4 rounded-full border-[2.5px] border-text" aria-hidden />
        ) : element.type === 'complexGateway' ? (
          // BPMN's marker for a complex gateway: an asterisk.
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="relative text-text">
            <path d="M10 3v14M3 10h14M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        ) : element.type === 'eventBasedGateway' ? (
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="relative text-text">
            <circle cx="11" cy="11" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="11" cy="11" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M11 6.5 15.3 9.6 13.6 14.5H8.4L6.7 9.6Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="relative text-lg font-semibold text-text">{element.type === 'parallelGateway' ? '+' : '×'}</span>
        )}
        {label ? <span className="absolute top-[54px] left-1/2 w-28 -translate-x-1/2 text-center text-[11px] leading-tight text-muted">{label}</span> : null}
        {handles}
        {problem}
      </div>
    );
  }
  const icon = ICON_PATH[element.type];
  const filled = FILLED_PATH[element.type];
  return (
    <div className={cx('relative h-20 w-[100px] rounded-lg border-text bg-surface', element.type === 'callActivity' ? 'border-[3px]' : 'border-[1.5px]', ring)}>
      {icon ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="absolute top-1.5 left-1.5 text-muted">
          <path d={icon} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      {filled ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="absolute top-1.5 left-1.5 text-muted">
          <path d={filled} fill="currentColor" />
          <path d="M2.5 4.5 8 9l5.5-4.5" fill="none" stroke="var(--surface)" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      ) : null}
      <span className="grid h-full place-items-center px-2 pt-2 text-center text-xs leading-tight">{label}</span>
      {element.type === 'userTask' && element.several ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-label={element.several.sequential ? 'Several people, one after another' : 'Several people, at once'} className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-text">
          {element.several.sequential
            ? [2, 6, 10].map((y) => <line key={y} x1="1" x2="11" y1={y} y2={y} stroke="currentColor" strokeWidth="1.5" />)
            : [2, 6, 10].map((x) => <line key={x} y1="1" y2="11" x1={x} x2={x} stroke="currentColor" strokeWidth="1.5" />)}
        </svg>
      ) : null}
      {'undo' in element && element.undo ? (
        <span className="absolute right-1.5 bottom-1" title={`Undone by ${element.undo}`}>
          <EventIcon kind="compensation" size={12} />
        </span>
      ) : null}
      {canRepeat(element) && element.repeat ? <LoopMarker className={element.type === 'callActivity' ? 'bottom-1 left-[calc(50%-18px)]' : 'bottom-1 left-1/2 -translate-x-1/2'} /> : null}
      {element.type === 'callActivity' ? (
        // BPMN's marker for a call: a small square with a plus.
        <span className="absolute bottom-1 left-1/2 grid size-3.5 -translate-x-1/2 place-items-center border border-text text-[10px] leading-none text-text" aria-hidden>
          +
        </span>
      ) : null}
      {markers}
      {handles}
      {problem}
    </div>
  );
}

const NODE_TYPES = { bpmn: Shape };

/** What the arrow of a flow says: its name, its outcome, its condition, or that it is the default. */
function flowLabel(process: Process, flow: Flow): string | undefined {
  if (flow.name) return flow.name;
  const from = process.elements[flow.from];
  if (flow.outcome && from?.type === 'userTask') return from.outcomes.find((outcome) => outcome.name === flow.outcome)?.label ?? flow.outcome;
  if (flow.default) return 'Otherwise';
  if (flow.when) {
    const text = conditionText(flow.when).replace(/record\./g, '');
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  }
  return undefined;
}

/** What an event on a task's boundary waits for, in words: the tooltip of its marker. */
function boundaryTitle(definition: Definition, event: BoundaryEventElement): string {
  const stays = event.interrupting ? '' : ' (the task stays open)';
  if (event.message) return `${event.name ?? 'Message'}: when ${definition.actions[event.message.action]?.label ?? event.message.action} is saved${stays}`;
  if (event.error) return `${event.name ?? 'Error'}: when the action fails`;
  if (event.timer) return `${event.name ?? 'Deadline'}: ${'duration' in event.timer ? `after ${durationWords(event.timer.duration)}` : `on ${event.timer.date}`}${stays}`;
  return event.name ?? 'Event';
}

function toNodes(definition: Definition, process: Process, selection: Selection, problems: ReadonlyMap<string, string[]>): ShapeNode[] {
  const shapes = process.diagram?.shapes ?? {};
  // A parent comes before what it holds, as React Flow needs.
  const depth = (id: string) => scopesOf(process, id).length;
  return Object.entries(process.elements)
    .filter(([, element]) => element.type !== 'boundaryEvent')
    .sort(([a], [b]) => depth(a) - depth(b))
    .map(([id, element], index) => {
      const shape = shapes[id] ?? { x: 80 + index * 160, y: 100, width: 100, height: 80 };
      const container = scopeOf(process, id);
      const parent = container !== undefined ? shapes[container] : undefined;
      const boundaries = Object.entries(process.elements).flatMap(([other, candidate]) =>
        candidate.type === 'boundaryEvent' && candidate.attachedTo === id
          ? [
              {
                id: other,
                element: candidate,
                left: Math.max(0, Math.min(shape.width - 18, (shapes[other]?.x ?? shape.x + shape.width - 30) - shape.x)),
                title: boundaryTitle(definition, candidate),
                problems: problems.get(other)?.length ?? 0,
              },
            ]
          : [],
      );
      const count = (problems.get(id)?.length ?? 0) + boundaries.reduce((sum, boundary) => sum + boundary.problems, 0);
      return {
        id,
        type: 'bpmn' as const,
        position: parent ? { x: shape.x - parent.x, y: shape.y - parent.y } : { x: shape.x, y: shape.y },
        ...(parent ? { parentId: container } : {}),
        data: {
          element,
          boundaries,
          problems: count,
          ...(element.type === 'subProcess' ? { size: { width: shape.width, height: shape.height } } : {}),
          ...(element.type === 'startEvent' && element.in !== undefined && isEventSubElement(process.elements[element.in]) ? { triggers: true } : {}),
        },
        selected: selection?.kind === 'element' && selection.id === id,
      };
    });
}

function toEdges(process: Process, selection: Selection, problems: ReadonlyMap<string, string[]>): Edge[] {
  return Object.entries(process.flows).flatMap(([id, flow]) => {
    const from = process.elements[flow.from];
    if (!from || !process.elements[flow.to]) return [];
    const boundary = from.type === 'boundaryEvent';
    const label = flowLabel(process, flow);
    const bad = (problems.get(id)?.length ?? 0) > 0;
    return [
      {
        id,
        source: boundary ? from.attachedTo : flow.from,
        ...(boundary ? { sourceHandle: flow.from } : {}),
        target: flow.to,
        type: 'smoothstep',
        ...(label ? { label } : {}),
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        selected: selection?.kind === 'flow' && selection.id === id,
        style: { strokeWidth: 1.5, ...(bad ? { stroke: 'var(--bad)' } : {}), ...(flow.default ? { strokeDasharray: '0' } : {}) },
        labelStyle: { fontSize: 11, fill: 'var(--text)' },
        labelBgStyle: { fill: 'var(--surface)' },
      },
    ];
  });
}

/**
 * The process designer (design §6.10): BPMN 2.0 on a canvas. The palette offers first what most
 * processes need, as Mendix does, and the rest of what Ambit runs after. The panel beside the
 * canvas edits what is selected, and the checks run as the builder works.
 */
export function ProcessDesigner({
  appId,
  definition,
  onChange,
  readOnly,
  dirty,
  saved,
}: {
  appId: string;
  definition: Definition;
  onChange: (definition: Definition) => void;
  readOnly: boolean;
  /** Unsaved changes: an import saves, so it waits for them. */
  dirty: boolean;
  /** The processes of the saved definition, which can be downloaded. */
  saved: readonly string[];
}) {
  const names = Object.keys(definition.processes ?? {});
  const [current, setCurrent] = useState<string | null>(names[0] ?? null);
  const [selection, setSelection] = useState<Selection>(null);
  const [creating, setCreating] = useState(false);
  // A new view of the canvas, fitted to the shapes: after arranging them, for example.
  const [view, setView] = useState(0);
  const name = current && definition.processes?.[current] ? current : (names[0] ?? null);
  const process = name ? definition.processes![name]! : null;
  useEffect(() => setSelection(null), [name]);

  // The checks of any definition, as the builder works: problems show on the shapes.
  const issues = useMemo(() => {
    const result = validateDefinition(definition);
    return result.ok ? [] : [...result.issues];
  }, [definition]);
  const problems = useMemo(() => (name ? issuesByPart(issues, name) : new Map<string, string[]>()), [issues, name]);

  if (!process || !name) {
    return (
      <div className="grid gap-4">
        <EmptyState title="No processes yet">
          A process puts work in front of people, step by step, in BPMN 2.0: who decides, what happens next, and by when.
        </EmptyState>
        {readOnly ? null : (
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => setCreating(true)} disabled={!processEntities(definition).length}>
              New process
            </Button>
            <ImportBpmn appId={appId} dirty={dirty} onImported={(imported) => setCurrent(imported[0] ?? null)} />
          </div>
        )}
        <NewProcessDialog open={creating} definition={definition} onClose={() => setCreating(false)} onCreate={(next, created) => (onChange(next), setCurrent(created), setCreating(false))} />
      </div>
    );
  }

  const add = (kind: ElementKind) => {
    const options = selection?.kind === 'flow' ? { on: selection.id } : selection?.kind === 'element' ? { after: selection.id } : {};
    const added = addElement(definition, name, kind, options);
    onChange(added.definition);
    setSelection({ kind: 'element', id: added.id });
    // A sub-process is large: fit the canvas to the shapes again, so all of it shows.
    if (kind === 'subProcess' || kind === 'transaction' || kind === 'eventSubProcess' || kind === 'adHocSubProcess') setView((n) => n + 1);
  };
  // What a palette entry needs first: a role does each task, and a message is an update action saved on the record.
  const missing = (kind: ElementKind): string | null => {
    if (kind === 'userTask' && !Object.keys(definition.roles).length) return 'Add a role first: a role does each task';
    if (kind === 'messageEvent' && !updateActions(definition, process.entity).length) return 'Add an action that changes the record first: the process waits until it is saved';
    if (kind === 'callActivity' && !callChoices(definition, name).length) return "Add another process first: a call runs one of the app's processes";
    if ((kind === 'sendTask' || kind === 'messageThrow') && !sendChoices(definition, name).length) return 'Add an action that changes a record first: the process runs it as a message';
    if (kind === 'receiveTask' && !updateActions(definition, process.entity).length) return 'Add an action that changes the record first: the process waits until it is saved';
    if (kind === 'businessRuleTask' && !Object.values(definition.rules).some((rule) => rule.entity === process.entity)) return 'Add a rule for these records first: a rule check checks them';
    return null;
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {names.length > 1 ? (
          <Select aria-label="Process" className="w-auto" value={name} onChange={(event) => setCurrent(event.target.value)}>
            {names.map((each) => (
              <option key={each} value={each}>
                {definition.processes![each]!.label}
              </option>
            ))}
          </Select>
        ) : (
          <h2 className="m-0 text-lg font-semibold">{process.label}</h2>
        )}
        <Badge>BPMN 2.0</Badge>
        <span className="flex-1" />
        {readOnly ? null : (
          <>
            <Button size="sm" onClick={() => setCreating(true)}>
              New process
            </Button>
            <ImportBpmn appId={appId} dirty={dirty} onImported={(imported) => setCurrent(imported[0] ?? name)} />
          </>
        )}
        <DownloadBpmn appId={appId} process={name} available={saved.includes(name) && !dirty} />
      </div>
      <div className={cx('grid gap-3', readOnly ? 'lg:grid-cols-[1fr_20rem]' : 'lg:grid-cols-[9rem_1fr_20rem]')}>
        {readOnly ? null : (
          <Card className="grid content-start gap-1.5 p-2">
            <p className="m-0 text-xs text-muted">{selection?.kind === 'flow' ? 'Add on the flow' : selection ? 'Add after it' : 'Add'}</p>
            {PALETTE.filter((item) => !item.group).map((item) => (
              <Button key={item.kind} size="sm" className="justify-start" title={missing(item.kind) ?? item.hint} onClick={() => add(item.kind)} disabled={missing(item.kind) !== null}>
                {item.label}
              </Button>
            ))}
            <Field label="More BPMN">
              {(inputId) => (
                <Select
                  id={inputId}
                  value=""
                  onChange={(event) => {
                    const chosen = PALETTE.find((item) => item.kind === event.target.value);
                    if (chosen) add(chosen.kind);
                  }}
                >
                  <option value="">Add…</option>
                  {(['Tasks', 'Gateways', 'Events', 'Parts'] as const).map((group) => (
                    <optgroup key={group} label={group}>
                      {PALETTE.filter((item) => item.group === group).map((item) => (
                        <option key={item.kind} value={item.kind} disabled={missing(item.kind) !== null} title={missing(item.kind) ?? item.hint}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              )}
            </Field>
          </Card>
        )}
        <Canvas
          key={`${name}:${view}`}
          definition={definition}
          name={name}
          process={process}
          selection={selection}
          problems={problems}
          readOnly={readOnly}
          onSelect={setSelection}
          onChange={onChange}
        />
        <Card className="grid content-start gap-3">
          {selection?.kind === 'element' && process.elements[selection.id] ? (
            <ElementPanel
              key={selection.id}
              definition={definition}
              name={name}
              id={selection.id}
              element={process.elements[selection.id]!}
              problems={problems}
              onChange={onChange}
              onSelect={setSelection}
              onOpen={setCurrent}
              readOnly={readOnly}
            />
          ) : selection?.kind === 'flow' && process.flows[selection.id] ? (
            <FlowPanel key={selection.id} definition={definition} name={name} id={selection.id} flow={process.flows[selection.id]!} problems={problems} onChange={onChange} onSelect={setSelection} readOnly={readOnly} />
          ) : (
            <ProcessPanel definition={definition} name={name} problems={problems} onChange={onChange} onRemoved={() => setCurrent(null)} onArranged={() => setView((n) => n + 1)} readOnly={readOnly} />
          )}
        </Card>
      </div>
      <NewProcessDialog open={creating} definition={definition} onClose={() => setCreating(false)} onCreate={(next, created) => (onChange(next), setCurrent(created), setCreating(false))} />
    </div>
  );
}

function Canvas(props: {
  definition: Definition;
  name: string;
  process: Process;
  selection: Selection;
  problems: ReadonlyMap<string, string[]>;
  readOnly: boolean;
  onSelect: (selection: Selection) => void;
  onChange: (definition: Definition) => void;
}) {
  const { definition, name, process, selection, problems, readOnly, onSelect, onChange } = props;
  const [nodes, setNodes] = useState<ShapeNode[]>(() => toNodes(definition, process, selection, problems));
  useEffect(() => setNodes(toNodes(definition, process, selection, problems)), [definition, process, selection, problems]);
  const edges = useMemo(() => toEdges(process, selection, problems), [process, selection, problems]);
  const starts = Object.values(process.elements).filter((element) => element.type === 'startEvent').length;

  const onConnect = (connection: Connection) => {
    const boundary = connection.sourceHandle && process.elements[connection.sourceHandle]?.type === 'boundaryEvent' ? connection.sourceHandle : null;
    const joined = connect(definition, name, boundary ?? connection.source, connection.target);
    if (!joined) return;
    onChange(joined.definition);
    onSelect({ kind: 'flow', id: joined.id });
  };
  return (
    <div className="h-[560px] overflow-hidden rounded-lg border border-line bg-sunken" data-testid="process-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={(changes: NodeChange<ShapeNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), current))}
        onNodeDragStop={(_event, node) => {
          // What a sub-process holds is placed from its corner on the canvas, and from the diagram's corner in the definition.
          const parent = node.parentId ? process.diagram?.shapes[node.parentId] : undefined;
          onChange(moveElement(definition, name, node.id, { x: Math.round(node.position.x + (parent?.x ?? 0)), y: Math.round(node.position.y + (parent?.y ?? 0)) }));
        }}
        onConnect={readOnly ? undefined : onConnect}
        onNodeClick={(_event, node) => onSelect({ kind: 'element', id: node.id })}
        onEdgeClick={(_event, edge) => onSelect({ kind: 'flow', id: edge.id })}
        onPaneClick={() => onSelect(null)}
        onNodesDelete={(deleted) => {
          let next = definition;
          for (const node of deleted) if (!(process.elements[node.id]?.type === 'startEvent' && starts === 1)) next = removeElement(next, name, node.id);
          onChange(next);
          onSelect(null);
        }}
        onEdgesDelete={(deleted) => {
          let next = definition;
          for (const edge of deleted) next = removeFlow(next, name, edge.id);
          onChange(next);
          onSelect(null);
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
        fitView
        minZoom={0.25}
        fitViewOptions={{ padding: 0.15, maxZoom: 1, minZoom: 0.25 }}
        colorMode="system"
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function Problems({ messages }: { messages: readonly string[] | undefined }) {
  if (!messages?.length) return null;
  return (
    <Notice tone="bad">
      <ul className="m-0 grid gap-1 pl-4">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </Notice>
  );
}

function Remove({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Button size="sm" variant="danger" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

/** Several people deciding a task: who votes, in what order, and what decides. */
function SeveralEditor({
  element,
  people,
  onChange,
}: {
  element: Extract<ProcessElement, { type: 'userTask' }>;
  people: ReadonlyArray<{ name: string; label: string }>;
  onChange: (change: (element: ProcessElement) => ProcessElement) => void;
}) {
  const several = element.several;
  const set = (next: NonNullable<typeof several> | undefined) =>
    onChange((current) => {
      if (current.type !== 'userTask') return current;
      const { several: _several, assignee: _assignee, ...rest } = current;
      return next ? { ...rest, several: next } : current.assignee && !next ? { ...rest, assignee: current.assignee } : rest;
    });
  const outcomes = element.outcomes;
  const voters = several?.people;
  const decide = several?.decide;
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm text-muted">Several people</legend>
      <Checkbox
        label="Several people decide, each with a vote"
        checked={Boolean(several)}
        onChange={(on) =>
          set(
            on
              ? {
                  people: { everyone: true },
                  sequential: false,
                  decide: outcomes.length > 1 ? { count: 'all', outcome: outcomes[0]!.name, otherwise: outcomes[1]!.name } : { first: true },
                }
              : undefined,
          )
        }
      />
      {several && voters && decide ? (
        <>
          <Field label="Who votes">
            {(id) => (
              <Select
                id={id}
                value={'everyone' in voters ? 'everyone' : 'fields' in voters ? 'fields' : `line:${voters.lineOf}`}
                onChange={(event) => {
                  const value = event.target.value;
                  const next =
                    value === 'everyone'
                      ? { everyone: true as const }
                      : value === 'fields'
                        ? { fields: people.slice(0, 2).map((person) => person.name) }
                        : { lineOf: value.slice('line:'.length), levels: 2 };
                  set({ ...several, people: next });
                }}
              >
                <option value="everyone">Everyone with the role</option>
                <option value="fields" disabled={people.length < 2}>
                  The people some fields of the record name
                </option>
                {people.map((person) => (
                  <option key={person.name} value={`line:${person.name}`}>
                    Up the reporting line from the record's {person.label.toLowerCase()}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {'fields' in voters ? (
            <div className="grid gap-1">
              {people.map((person) => (
                <Checkbox
                  key={person.name}
                  label={`The record's ${person.label.toLowerCase()}`}
                  checked={voters.fields.includes(person.name)}
                  onChange={(on) => set({ ...several, people: { fields: on ? [...voters.fields, person.name] : voters.fields.filter((field) => field !== person.name) } })}
                />
              ))}
            </div>
          ) : null}
          {'lineOf' in voters ? (
            <Field label="Levels up the line">
              {(id) => (
                <Select id={id} value={voters.levels} onChange={(event) => set({ ...several, people: { ...voters, levels: Number(event.target.value) } })}>
                  {[2, 3, 4, 5].map((levels) => (
                    <option key={levels} value={levels}>
                      {levels}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Checkbox label="One after another, in order" checked={several.sequential} onChange={(sequential) => set({ ...several, sequential })} />
          <Field label="Decided by">
            {(id) => (
              <Select
                id={id}
                value={'first' in decide ? 'first' : String(decide.count)}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'first') return set({ ...several, decide: { first: true } });
                  const count = value === 'all' || value === 'majority' ? value : Number(value);
                  const base = 'first' in decide ? { outcome: outcomes[0]!.name, otherwise: (outcomes[1] ?? outcomes[0])!.name } : decide;
                  set({ ...several, decide: { count, outcome: base.outcome, otherwise: base.otherwise } });
                }}
              >
                <option value="first">The first vote</option>
                <option value="all" disabled={outcomes.length < 2}>
                  Everyone's votes for one outcome
                </option>
                <option value="majority" disabled={outcomes.length < 2}>
                  A majority's votes for one outcome
                </option>
                {[1, 2, 3, 4, 5].map((count) => (
                  <option key={count} value={count} disabled={outcomes.length < 2}>
                    {count} vote{count > 1 ? 's' : ''} for one outcome
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {'first' in decide ? null : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="For">
                {(id) => (
                  <Select id={id} value={decide.outcome} onChange={(event) => set({ ...several, decide: { ...decide, outcome: event.target.value } })}>
                    {outcomes.map((outcome) => (
                      <option key={outcome.name} value={outcome.name}>
                        {outcome.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Otherwise">
                {(id) => (
                  <Select id={id} value={decide.otherwise} onChange={(event) => set({ ...several, decide: { ...decide, otherwise: event.target.value } })}>
                    {outcomes.map((outcome) => (
                      <option key={outcome.name} value={outcome.name}>
                        {outcome.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
          <p className="m-0 text-xs text-muted">Once the votes decide, the outcome's action runs with the app's authority: no one person made the decision.</p>
        </>
      ) : null}
    </fieldset>
  );
}

/** A duration set with a number and a unit, or its ISO 8601 text when it has another shape. */
function DurationInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const parts = durationParts(value);
  if (!parts) {
    return <Field label={label} hint="ISO 8601, such as P3D">{(id) => <TextInput id={id} value={value} onChange={(event) => onChange(event.target.value)} />}</Field>;
  }
  return (
    <Field label={label}>
      {(id) => (
        <div className="flex gap-2">
          <TextInput id={id} type="number" min={1} className="w-20" value={parts.amount} onChange={(event) => onChange(durationOf(Number(event.target.value) || 1, parts.unit))} />
          <Select aria-label={`${label}: unit`} className="w-auto" value={parts.unit} onChange={(event) => onChange(durationOf(parts.amount, event.target.value as 'hours' | 'days' | 'weeks'))}>
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="weeks">weeks</option>
          </Select>
        </div>
      )}
    </Field>
  );
}

const TYPE_LABELS: Readonly<Record<ProcessElement['type'], string>> = {
  startEvent: 'Start',
  endEvent: 'End',
  userTask: 'User task',
  serviceTask: 'System task',
  task: 'Task',
  manualTask: 'Manual task',
  exclusiveGateway: 'Decision',
  parallelGateway: 'Parallel',
  inclusiveGateway: 'Inclusive',
  complexGateway: 'Complex gateway',
  eventBasedGateway: 'Event-based gateway',
  intermediateCatchEvent: 'Timer',
  intermediateThrowEvent: 'Milestone',
  subProcess: 'Sub-process',
  callActivity: 'Call process',
  scriptTask: 'Script task',
  businessRuleTask: 'Rule check',
  sendTask: 'Send task',
  receiveTask: 'Receive task',
  boundaryEvent: 'Deadline',
};

/** What the panel calls an element: an event by what it waits for. */
function typeLabel(element: ProcessElement): string {
  if ((element.type === 'intermediateCatchEvent' || element.type === 'intermediateThrowEvent') && element.link !== undefined) return 'Link';
  if (element.type === 'intermediateThrowEvent' && element.message) return 'Send a message';
  if (element.type === 'intermediateThrowEvent' && element.escalation) return 'Escalate';
  if (element.type === 'intermediateThrowEvent' && element.signal !== undefined) return 'Throw a signal';
  if (element.type === 'intermediateThrowEvent' && element.compensate) return 'Undo';
  if (element.type === 'subProcess' && element.transaction) return 'Transaction';
  if (element.type === 'subProcess' && element.event) return 'Event sub-process';
  if (element.type === 'subProcess' && element.adHoc) return 'Ad hoc sub-process';
  if (element.type === 'intermediateCatchEvent' || element.type === 'boundaryEvent') {
    const kind = eventKind(element);
    if (kind === 'message') return 'Message';
    if (kind === 'error') return 'Error';
    if (kind === 'condition') return 'Condition';
    if (kind === 'escalation') return 'Escalation';
    if (kind === 'signal') return 'Signal';
    if (kind === 'cancel') return 'Cancel';
  }
  return TYPE_LABELS[element.type];
}

/** BPMN's marker for an activity that repeats: an arrow that comes round. */
function LoopMarker({ className }: { className: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-label="Repeats" className={cx('absolute text-text', className)}>
      <path d="M4.2 11.2A4.6 4.6 0 1 1 9.8 11.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9.8 8.4v2.8H7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Whether an activity runs again while a condition holds, and how many times at most. */
function RepeatEditor({
  repeat,
  starting,
  choices,
  outcomes,
  onChange,
}: {
  repeat: Repeat | undefined;
  starting: Repeat['while'];
  choices: readonly RefChoice[];
  /** Its flows follow its outcomes: it checks after it runs. */
  outcomes: boolean;
  onChange: (repeat: Repeat | undefined) => void;
}) {
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm text-muted">Repeats</legend>
      <Checkbox label="It runs again while a condition holds" checked={repeat !== undefined} onChange={(on) => onChange(on ? { while: starting, max: 3 } : undefined)} />
      {repeat ? (
        <>
          <ConditionEditor label="Again while this holds" value={repeat.while} onChange={(condition) => onChange({ ...repeat, while: condition ?? repeat.while })} choices={choices} />
          <Field label="At most this many times">
            {(inputId) => (
              <TextInput
                id={inputId}
                type="number"
                min={1}
                max={100}
                value={repeat.max}
                onChange={(event) => onChange({ ...repeat, max: Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))) })}
              />
            )}
          </Field>
          <Checkbox
            label="Check before each time, so it may not run at all"
            checked={repeat.before === true}
            disabled={outcomes}
            onChange={(before) => onChange(before ? { ...repeat, before: true } : { while: repeat.while, max: repeat.max })}
          />
          {outcomes ? <p className="m-0 text-xs text-muted">Its flows follow its outcomes, so it checks after it runs.</p> : null}
        </>
      ) : null}
    </fieldset>
  );
}

/** Whether an element is an event sub-process. */
const isEventSubElement = (element: ProcessElement | undefined): boolean => element?.type === 'subProcess' && element.event === true;

/** What a start event waits for, as its marker shows it: in an event sub-process, an action saved on the record is a message. */
function startTrigger(element: Extract<ProcessElement, { type: 'startEvent' }>, inEventSub: boolean): 'timer' | 'condition' | 'signal' | 'error' | 'escalation' | 'message' | undefined {
  if (element.timer) return 'timer';
  if (element.condition) return 'condition';
  if (element.signal !== undefined) return 'signal';
  if (element.error) return 'error';
  if (element.escalation) return 'escalation';
  return inEventSub && element.actions.length ? 'message' : undefined;
}

/** How an event sub-process starts, as its start event's panel names it. */
type Trigger = 'actions' | 'after' | 'date' | 'condition' | 'signal' | 'error' | 'escalation';
const TRIGGER_WORDS: Readonly<Record<Trigger, string>> = {
  actions: 'When an action is saved',
  after: 'A time after its scope starts',
  date: 'On a date of the record',
  condition: 'When a condition comes to hold',
  signal: 'When a signal is thrown',
  error: 'When an error is raised beside it',
  escalation: 'When something beside it escalates',
};
function triggerOf(element: Extract<ProcessElement, { type: 'startEvent' }>): Trigger {
  if (element.timer) return 'date' in element.timer ? 'date' : 'after';
  if (element.condition) return 'condition';
  if (element.signal !== undefined) return 'signal';
  if (element.error) return 'error';
  if (element.escalation) return 'escalation';
  return 'actions';
}

/** The code of an error or an escalation. A catch for that code, or one for all, takes it; without a code, only a catch for all does. */
function CodeInput({ label, hint, value, onChange }: { label: string; hint: string; value: Raised; onChange: (value: Raised) => void }) {
  return (
    <Field label={label} hint={hint}>
      {(inputId) => (
        <TextInput
          id={inputId}
          value={value === true ? '' : value.code}
          placeholder="Any"
          onChange={(event) => {
            const code = event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
            onChange(code ? { code } : true);
          }}
        />
      )}
    </Field>
  );
}

/** A signal's name: one that the app's processes use already, or a new one. */
function SignalInput({ definition, label, hint, value, onChange }: { definition: Definition; label: string; hint: string; value: string; onChange: (signal: string) => void }) {
  return (
    <Field label={label} hint={hint}>
      {(inputId) => (
        <>
          <TextInput id={inputId} list={`${inputId}-signals`} value={value} onChange={(event) => onChange(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
          <datalist id={`${inputId}-signals`}>
            {signalChoices(definition).map((signal) => (
              <option key={signal} value={signal} />
            ))}
          </datalist>
        </>
      )}
    </Field>
  );
}

/** What undoes a task's change: an update action that an undo event, or a cancelled transaction, runs. */
function UndoPicker({ definition, name, id, onChange }: { definition: Definition; name: string; id: string; onChange: (definition: Definition) => void }) {
  const process = definition.processes![name]!;
  const element = process.elements[id];
  if (element?.type !== 'serviceTask' && element?.type !== 'scriptTask' && element?.type !== 'sendTask') return null;
  const choices = undoChoices(definition, process, id);
  return (
    <Field label="Undone by" hint="An action that changes the record back, if an undo event or a cancelled transaction asks for it. It runs once, newest first.">
      {(inputId) => (
        <Select
          id={inputId}
          value={element.undo ?? ''}
          onChange={(event) =>
            onChange(
              updateElement(definition, name, id, (current) => {
                if (current.type !== 'serviceTask' && current.type !== 'scriptTask' && current.type !== 'sendTask') return current;
                const { undo: _undo, ...rest } = current;
                return event.target.value ? { ...rest, undo: event.target.value } : rest;
              }),
            )
          }
        >
          <option value="">Nothing</option>
          {element.undo && !choices.includes(element.undo) ? (
            <option value={element.undo} disabled>
              {element.undo}
            </option>
          ) : null}
          {choices.map((action) => (
            <option key={action} value={action}>
              {definition.actions[action]!.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** How an end event ends its path, as the select of its panel names it. */
type EndWay = 'none' | 'terminate' | 'message' | 'error' | 'escalation' | 'compensate' | 'cancel' | 'signal';
function endWay(element: Extract<ProcessElement, { type: 'endEvent' }>): EndWay {
  if (element.terminate) return 'terminate';
  if (element.message) return 'message';
  if (element.error) return 'error';
  if (element.escalation) return 'escalation';
  if (element.compensate) return 'compensate';
  if (element.signal !== undefined) return 'signal';
  return element.cancel ? 'cancel' : 'none';
}

/** The message an element sends: an action that the process runs on its record, or on the one a reference field names. */
function SendPicker({ definition, name, value, onChange }: { definition: Definition; name: string; value: Message; onChange: (message: Message) => void }) {
  const choices = sendChoices(definition, name);
  const key = `${value.action}|${value.record ?? ''}`;
  return (
    <Field label="Runs, as a message" hint="With the app's authority. The processes on that record hear it, as when a person saves it.">
      {(inputId) => (
        <Select
          id={inputId}
          value={key}
          onChange={(event) => {
            const [action = '', record] = event.target.value.split('|');
            onChange({ action, ...(record ? { record } : {}) });
          }}
        >
          {choices.some((choice) => `${choice.action}|${choice.record ?? ''}` === key) ? null : (
            <option value={key} disabled>
              Choose an action
            </option>
          )}
          {choices.map((choice) => (
            <option key={`${choice.action}|${choice.record ?? ''}`} value={`${choice.action}|${choice.record ?? ''}`}>
              {choice.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** A script task's steps, in the steps editor of actions: the editor works on an action, so the steps travel as one that only the panel has. */
function ScriptSteps({ definition, name, id, onChange }: { definition: Definition; name: string; id: string; onChange: (definition: Definition) => void }) {
  const process = definition.processes![name]!;
  const element = process.elements[id];
  if (element?.type !== 'scriptTask') return null;
  const key = `__script_${id}`;
  const action: Definition['actions'][string] = { label: element.name, description: element.name, entity: process.entity, operation: 'update', input: [], set: {}, confirm: 'none', steps: element.steps };
  const shown: Definition = { ...definition, actions: { ...definition.actions, [key]: action } };
  return (
    <section aria-label="Steps" className="grid gap-2">
      <p className="m-0 text-sm text-muted">The steps change the record by themselves, with the app's authority. The record's rules still apply, and a check that fails stops the task.</p>
      <StepsEditor
        definition={shown}
        action={key}
        kinds={['set', 'add_line', 'check']}
        onChange={(next) => {
          const steps = next.actions[key]?.steps ?? [];
          onChange(updateElement(definition, name, id, (current) => (current.type === 'scriptTask' ? { ...current, steps } : current)));
        }}
      />
    </section>
  );
}

/** What the panel says of an event on a host's boundary, by the host. */
const ENDS: Readonly<Record<string, { readonly interrupts: string; readonly open: string }>> = {
  userTask: { interrupts: 'It takes the task away', open: 'while the task is open' },
  receiveTask: { interrupts: 'It stops the wait', open: 'while the task waits' },
  subProcess: { interrupts: 'It ends all of the sub-process', open: 'while the sub-process runs' },
  callActivity: { interrupts: 'It cancels the process it called', open: 'while the called process runs' },
};

/** The events on an element's boundary: deadlines, actions saved on the record, and the failure of an action. */
function BoundaryEvents(props: {
  definition: Definition;
  name: string;
  id: string;
  problems: ReadonlyMap<string, string[]>;
  onChange: (definition: Definition) => void;
}) {
  const { definition, name, id, problems, onChange } = props;
  const process = definition.processes![name]!;
  const host = process.elements[id];
  if (!host || (host.type === 'serviceTask' && host.skill)) return null;
  const kinds = boundaryKinds(host);
  const words = ENDS[host.type] ?? ENDS['userTask']!;
  const actions = updateActions(definition, process.entity);
  const events = Object.entries(process.elements).flatMap(([other, candidate]) => (candidate.type === 'boundaryEvent' && candidate.attachedTo === id ? [{ id: other, event: candidate }] : []));
  const deadlines = events.flatMap(({ id: other, event }) => (event.timer ? [{ id: other, event, timer: event.timer }] : []));
  const messages = events.flatMap(({ id: other, event }) => (event.message ? [{ id: other, event, action: event.message.action }] : []));
  const conditions = events.flatMap(({ id: other, event }) => (event.condition ? [{ id: other, event, condition: event.condition }] : []));
  const signals = events.flatMap(({ id: other, event }) => (event.signal !== undefined ? [{ id: other, event, signal: event.signal }] : []));
  const errors = events.flatMap(({ id: other, event }) => (event.error ? [{ id: other, error: event.error }] : []));
  const escalations = events.flatMap(({ id: other, event }) => (event.escalation ? [{ id: other, event, escalation: event.escalation }] : []));
  const cancel = events.find(({ event }) => event.cancel);
  // An error with a code comes from an error end event, inside a sub-process or a called process; a task's failure has none.
  const coded = host.type === 'subProcess' || host.type === 'callActivity';
  const free = messageChoices(definition, process, id);
  return (
    <>
      {kinds.includes('timer') ? (
        <>
          <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
            <legend className="px-1 text-sm text-muted">Deadlines</legend>
            {deadlines.map(({ id: deadline, event, timer }) => (
              <div key={deadline} className="grid gap-1.5 rounded-md bg-sunken p-2">
                <Problems messages={problems.get(deadline)} />
                {'duration' in timer ? (
                  <DurationInput label="After" value={timer.duration} onChange={(duration) => onChange(updateElement(definition, name, deadline, (current) => ({ ...current, timer: { duration } }) as ProcessElement))} />
                ) : (
                  <p className="m-0 text-sm">On the record's {timer.date}</p>
                )}
                <Checkbox
                  label={words.interrupts}
                  checked={event.interrupting}
                  onChange={(interrupting) => onChange(updateElement(definition, name, deadline, (current) => ({ ...current, interrupting }) as ProcessElement))}
                />
                <Remove onClick={() => onChange(removeElement(definition, name, deadline))}>Remove the deadline</Remove>
              </div>
            ))}
            <Button size="sm" onClick={() => onChange(addBoundary(definition, name, id, 'timer').definition)}>
              Add a deadline
            </Button>
          </fieldset>
        </>
      ) : null}
      {kinds.includes('message') ? (
        <>
          <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
            <legend className="px-1 text-sm text-muted">When an action is saved</legend>
            {messages.map(({ id: message, event, action }) => (
              <div key={message} className="grid gap-1.5 rounded-md bg-sunken p-2">
                <Problems messages={problems.get(message)} />
                <Select
                  aria-label="The action that is saved"
                  value={action}
                  onChange={(change) =>
                    onChange(
                      updateElement(definition, name, message, (current) => {
                        if (current.type !== 'boundaryEvent') return current;
                        const chosen = change.target.value;
                        // A name that only repeated the action's label follows the action.
                        const named = current.name !== undefined && current.name !== (definition.actions[action]?.label ?? action);
                        return { ...current, ...(named ? {} : { name: definition.actions[chosen]?.label ?? chosen }), message: { action: chosen } };
                      }),
                    )
                  }
                >
                  {actions.includes(action) ? null : (
                    <option value={action} disabled>
                      Choose an action
                    </option>
                  )}
                  {actions
                    .filter((each) => each === action || free.includes(each))
                    .map((each) => (
                      <option key={each} value={each}>
                        {definition.actions[each]!.label}
                      </option>
                    ))}
                </Select>
                <Checkbox
                  label={words.interrupts}
                  checked={event.interrupting}
                  onChange={(interrupting) => onChange(updateElement(definition, name, message, (current) => ({ ...current, interrupting }) as ProcessElement))}
                />
                <Remove onClick={() => onChange(removeElement(definition, name, message))}>Remove the message</Remove>
              </div>
            ))}
            <Button
              size="sm"
              disabled={!free.length}
              title={free.length ? undefined : "No action is free: an outcome that decides a task here can't also interrupt it"}
              onClick={() => onChange(addBoundary(definition, name, id, 'message').definition)}
            >
              Add an action
            </Button>
            <p className="m-0 text-xs text-muted">Someone saves the action on the record {words.open}: to withdraw a request, for example.</p>
          </fieldset>
        </>
      ) : null}
      {kinds.includes('condition') ? (
        <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
          <legend className="px-1 text-sm text-muted">When a condition comes to hold</legend>
          {conditions.map(({ id: holder, event, condition }) => (
            <div key={holder} className="grid gap-1.5 rounded-md bg-sunken p-2">
              <Problems messages={problems.get(holder)} />
              <ConditionEditor
                label="When this comes to hold"
                value={condition}
                onChange={(next) => onChange(updateElement(definition, name, holder, (current) => (current.type === 'boundaryEvent' ? { ...current, condition: next ?? condition } : current)))}
                choices={recordChoices(definition, process.entity)}
              />
              <Checkbox
                label={words.interrupts}
                checked={event.interrupting}
                onChange={(interrupting) => onChange(updateElement(definition, name, holder, (current) => ({ ...current, interrupting }) as ProcessElement))}
              />
              <Remove onClick={() => onChange(removeElement(definition, name, holder))}>Remove the condition</Remove>
            </div>
          ))}
          <Button size="sm" onClick={() => onChange(addBoundary(definition, name, id, 'condition').definition)}>
            Add a condition
          </Button>
          <p className="m-0 text-xs text-muted">It happens when a change to the record makes the condition hold, {words.open}.</p>
        </fieldset>
      ) : null}
      {kinds.includes('signal') ? (
        <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
          <legend className="px-1 text-sm text-muted">When a signal is thrown</legend>
          {signals.map(({ id: heard, event, signal }) => (
            <div key={heard} className="grid gap-1.5 rounded-md bg-sunken p-2">
              <Problems messages={problems.get(heard)} />
              <SignalInput
                definition={definition}
                label="The signal"
                hint="A process of the app, or an operator, throws it."
                value={signal}
                onChange={(next) => onChange(updateElement(definition, name, heard, (current) => (current.type === 'boundaryEvent' ? { ...current, signal: next } : current)))}
              />
              <Checkbox
                label={words.interrupts}
                checked={event.interrupting}
                onChange={(interrupting) => onChange(updateElement(definition, name, heard, (current) => ({ ...current, interrupting }) as ProcessElement))}
              />
              <Remove onClick={() => onChange(removeElement(definition, name, heard))}>Remove the signal event</Remove>
            </div>
          ))}
          <Button size="sm" onClick={() => onChange(addBoundary(definition, name, id, 'signal').definition)}>
            Hear a signal
          </Button>
        </fieldset>
      ) : null}
      {kinds.includes('error') ? (
        <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
          <legend className="px-1 text-sm text-muted">{host.type === 'subProcess' ? 'If something inside it fails' : host.type === 'callActivity' ? 'If the called process fails' : 'If the action fails'}</legend>
          {errors.map(({ id: caught, error }) => (
            <div key={caught} className="grid gap-1.5 rounded-md bg-sunken p-2">
              <Problems messages={problems.get(caught)} />
              {coded ? (
                <CodeInput
                  label="Catches the error"
                  hint="An error end event with this code. Empty: any error, and an action that fails."
                  value={error}
                  onChange={(next) => onChange(updateElement(definition, name, caught, (current) => (current.type === 'boundaryEvent' ? { ...current, error: next } : current)))}
                />
              ) : null}
              <p className="m-0 text-sm">
                The process leads on by the error's path{coded ? ', and what still runs inside ends' : ''}. Drag from the lightning bolt to lead it elsewhere.
              </p>
              <Remove onClick={() => onChange(removeElement(definition, name, caught))}>Remove the error event</Remove>
            </div>
          ))}
          {errors.length ? null : <p className="m-0 text-sm text-muted">The process stops at the action until an admin retries it.</p>}
          {!errors.length || coded ? (
            <Button size="sm" onClick={() => onChange(addBoundary(definition, name, id, 'error').definition)}>
              {errors.length ? 'Catch another error' : 'Catch the failure'}
            </Button>
          ) : null}
        </fieldset>
      ) : null}
      {kinds.includes('escalation') ? (
        <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
          <legend className="px-1 text-sm text-muted">{host.type === 'callActivity' ? 'When the called process escalates' : 'When something inside escalates'}</legend>
          {escalations.map(({ id: heard, event, escalation }) => (
            <div key={heard} className="grid gap-1.5 rounded-md bg-sunken p-2">
              <Problems messages={problems.get(heard)} />
              <CodeInput
                label="Hears the escalation"
                hint="An escalation with this code. Empty: any escalation."
                value={escalation}
                onChange={(next) => onChange(updateElement(definition, name, heard, (current) => (current.type === 'boundaryEvent' ? { ...current, escalation: next } : current)))}
              />
              <Checkbox
                label={words.interrupts}
                checked={event.interrupting}
                onChange={(interrupting) => onChange(updateElement(definition, name, heard, (current) => ({ ...current, interrupting }) as ProcessElement))}
              />
              <Remove onClick={() => onChange(removeElement(definition, name, heard))}>Remove the escalation event</Remove>
            </div>
          ))}
          <Button size="sm" onClick={() => onChange(addBoundary(definition, name, id, 'escalation').definition)}>
            Hear an escalation
          </Button>
        </fieldset>
      ) : null}
      {kinds.includes('cancel') ? (
        <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
          <legend className="px-1 text-sm text-muted">When the transaction is cancelled</legend>
          {cancel ? (
            <>
              <Problems messages={problems.get(cancel.id)} />
              <p className="m-0 text-sm">A cancel end inside undoes what completed in the transaction, newest first. Then the process leads on by this path.</p>
              <Remove onClick={() => onChange(removeElement(definition, name, cancel.id))}>Remove the cancel event</Remove>
            </>
          ) : (
            <Button size="sm" onClick={() => onChange(addBoundary(definition, name, id, 'cancel').definition)}>
              Add a cancel event
            </Button>
          )}
        </fieldset>
      ) : null}
      {kinds.includes('timer') ? <p className="m-0 text-xs text-muted">Drag from a marker on the edge to lead its path elsewhere, such as to a task for someone else.</p> : null}
    </>
  );
}

function ElementPanel(props: {
  definition: Definition;
  name: string;
  id: string;
  element: ProcessElement;
  problems: ReadonlyMap<string, string[]>;
  onChange: (definition: Definition) => void;
  onSelect: (selection: Selection) => void;
  /** Open another process in the designer, such as the one a call runs. */
  onOpen: (process: string) => void;
  readOnly: boolean;
}) {
  const { definition, name, id, element, problems, onChange, onSelect, onOpen, readOnly } = props;
  const process = definition.processes![name]!;
  const entity = definition.entities[process.entity];
  const set = (change: (element: ProcessElement) => ProcessElement) => onChange(updateElement(definition, name, id, change));
  const starts = Object.values(process.elements).filter((each) => each.type === 'startEvent').length;
  const people = [
    ...(entity?.fields ?? []).filter((field) => field.type === 'user').map((field) => ({ name: field.name, label: field.label })),
    { name: 'owner', label: 'Owner' },
    { name: 'created_by', label: 'Created by' },
  ];
  const actions = updateActions(definition, process.entity);
  const dates = (entity?.fields ?? []).filter((field) => field.type === 'date' || field.type === 'datetime');
  const calls = callChoices(definition, name);
  const conditionChoices = [
    ...recordChoices(definition, process.entity),
    ...Object.entries(process.elements).flatMap(([task, candidate]) =>
      candidate.type === 'userTask'
        ? [{ ref: `tasks.${task}.outcome`, label: `${candidate.name}: outcome`, kind: 'choice' as const, options: candidate.outcomes.map((outcome) => ({ value: outcome.name, label: outcome.label })) }]
        : [],
    ),
  ];
  const links = Object.values(process.elements).flatMap((candidate) => (candidate.type === 'intermediateCatchEvent' && candidate.link !== undefined ? [candidate.link] : []));
  const around = 'in' in element && element.in !== undefined ? process.elements[element.in] : undefined;
  const inTransaction = around?.type === 'subProcess' && around.transaction === true;
  // The action a catch event waits for, kept apart: the narrowing of the element doesn't reach a field's render function.
  const awaited = element.type === 'intermediateCatchEvent' ? element.message?.action : undefined;

  return (
    <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{typeLabel(element)}</h3>
        <code className="text-xs text-muted">{id}</code>
      </div>
      <Problems messages={problems.get(id)} />
      {'name' in element || element.type !== 'parallelGateway' ? (
        <Field label="Name">
          {(inputId) => (
            <TextInput
              id={inputId}
              value={element.name ?? ''}
              onChange={(event) => set((current) => ({ ...current, name: event.target.value }) as ProcessElement)}
            />
          )}
        </Field>
      ) : null}
      {element.type === 'startEvent' && element.in === undefined ? (
        <>
          <Field label="Starts">
            {(inputId) => (
              <Select
                id={inputId}
                value={element.condition ? 'condition' : element.signal !== undefined ? 'signal' : element.timer ? ('date' in element.timer ? 'date' : 'after') : 'actions'}
                onChange={(event) =>
                  set((current) => {
                    if (current.type !== 'startEvent') return current;
                    const { timer: _timer, condition: _condition, signal: _signal, ...rest } = current;
                    const plain = { ...rest, actions: [] };
                    if (event.target.value === 'signal') return { ...plain, signal: signalChoices(definition)[0] ?? 'signal' };
                    if (event.target.value === 'date' && dates[0]) return { ...plain, timer: { date: dates[0].name } };
                    if (event.target.value === 'after') return { ...plain, timer: { duration: 'P1D' } };
                    if (event.target.value === 'condition') return { ...plain, condition: startingCondition(definition, process.entity) };
                    return rest;
                  })
                }
              >
                <option value="actions">When an action is saved, or by hand</option>
                <option value="date" disabled={!dates.length}>
                  On a date of each record
                </option>
                <option value="after">A time after each record is created</option>
                <option value="condition">When a condition comes to hold on a record</option>
                <option value="signal">When a signal is thrown for a record</option>
              </Select>
            )}
          </Field>
          {element.signal !== undefined ? (
            <SignalInput
              definition={definition}
              label="Starts on the signal"
              hint="A process of the app throws it on a record, or an operator throws it for a record: this process starts on that record."
              value={element.signal}
              onChange={(signal) => set((current) => ({ ...current, signal }) as ProcessElement)}
            />
          ) : element.condition ? (
            <ConditionEditor
              label="Starts when this comes to hold"
              value={element.condition}
              onChange={(condition) => set((current) => (current.type === 'startEvent' ? { ...current, condition: condition ?? startingCondition(definition, process.entity) } : current))}
              choices={recordChoices(definition, process.entity)}
            />
          ) : element.timer && 'date' in element.timer ? (
            <Field label="On the record's" hint="At the start of that day. A change to the date moves the start.">
              {(inputId) => (
                <Select id={inputId} value={element.timer && 'date' in element.timer ? element.timer.date : ''} onChange={(event) => set((current) => ({ ...current, timer: { date: event.target.value } }) as ProcessElement)}>
                  {dates.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : element.timer ? (
            <DurationInput label="After the record is created" value={'duration' in element.timer ? element.timer.duration : 'P1D'} onChange={(duration) => set((current) => ({ ...current, timer: { duration } }) as ProcessElement)} />
          ) : (
            <fieldset className="m-0 grid gap-1 rounded-md border border-line p-3">
              <legend className="px-1 text-sm text-muted">Starts when this action is saved</legend>
              {Object.entries(definition.actions)
                .filter(([, action]) => action.entity === process.entity)
                .map(([action, spec]) => (
                  <Checkbox
                    key={action}
                    label={spec.label}
                    checked={element.actions.includes(action)}
                    onChange={(on) => set((current) => (current.type === 'startEvent' ? { ...current, actions: on ? [...current.actions, action] : current.actions.filter((a) => a !== action) } : current))}
                  />
                ))}
              <p className="m-0 text-xs text-muted">Without one, people whose role may start the process start it on a record.</p>
            </fieldset>
          )}
        </>
      ) : null}
      {element.type === 'startEvent' && element.in !== undefined && isEventSubElement(process.elements[element.in]) ? (
        <>
          <Field label="Starts">
            {(inputId) => (
              <Select
                id={inputId}
                value={triggerOf(element)}
                onChange={(event) =>
                  set((current) => {
                    if (current.type !== 'startEvent') return current;
                    const { timer: _timer, condition: _condition, signal: _signal, error: _error, escalation: _escalation, ...rest } = current;
                    const plain = { ...rest, actions: [] };
                    const trigger = event.target.value;
                    if (trigger === 'actions' && actions[0]) return { ...plain, actions: [actions[0]] };
                    if (trigger === 'date' && dates[0]) return { ...plain, timer: { date: dates[0].name } };
                    if (trigger === 'condition') return { ...plain, condition: startingCondition(definition, process.entity) };
                    if (trigger === 'signal') return { ...plain, signal: signalChoices(definition)[0] ?? 'signal' };
                    // An error always ends what runs beside it.
                    if (trigger === 'error') return { ...plain, error: true, interrupting: true };
                    if (trigger === 'escalation') return { ...plain, escalation: true };
                    return { ...plain, timer: { duration: 'P1D' } };
                  })
                }
              >
                {(Object.keys(TRIGGER_WORDS) as Trigger[]).map((trigger) => (
                  <option key={trigger} value={trigger} disabled={(trigger === 'actions' && !actions.length) || (trigger === 'date' && !dates.length)}>
                    {TRIGGER_WORDS[trigger]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {triggerOf(element) === 'actions' ? (
            <Field label="The action">
              {(inputId) => (
                <Select id={inputId} value={element.actions[0] ?? ''} onChange={(event) => set((current) => (current.type === 'startEvent' ? { ...current, actions: [event.target.value] } : current))}>
                  {actions.map((action) => (
                    <option key={action} value={action}>
                      {definition.actions[action]!.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {element.timer && 'duration' in element.timer ? (
            <DurationInput label="After its scope starts" value={element.timer.duration} onChange={(duration) => set((current) => ({ ...current, timer: { duration } }) as ProcessElement)} />
          ) : null}
          {element.timer && 'date' in element.timer ? (
            <Field label="On the record's">
              {(inputId) => (
                <Select id={inputId} value={element.timer && 'date' in element.timer ? element.timer.date : ''} onChange={(event) => set((current) => ({ ...current, timer: { date: event.target.value } }) as ProcessElement)}>
                  {dates.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {element.condition ? (
            <ConditionEditor
              label="Starts when this comes to hold"
              value={element.condition}
              onChange={(condition) => set((current) => (current.type === 'startEvent' ? { ...current, condition: condition ?? startingCondition(definition, process.entity) } : current))}
              choices={conditionChoices}
            />
          ) : null}
          {element.signal !== undefined ? (
            <SignalInput definition={definition} label="The signal" hint="A process of the app, or an operator, throws it." value={element.signal} onChange={(signal) => set((current) => ({ ...current, signal }) as ProcessElement)} />
          ) : null}
          {element.error ? (
            <CodeInput label="Catches the error" hint="An error end event with this code, beside it. Empty: any error, and an action that fails." value={element.error} onChange={(error) => set((current) => ({ ...current, error }) as ProcessElement)} />
          ) : null}
          {element.escalation ? (
            <CodeInput label="Hears the escalation" hint="An escalation with this code, beside it. Empty: any escalation." value={element.escalation} onChange={(escalation) => set((current) => ({ ...current, escalation }) as ProcessElement)} />
          ) : null}
          <Checkbox
            label="It ends all that runs beside it"
            checked={element.interrupting !== false}
            disabled={element.error !== undefined}
            onChange={(interrupting) => set((current) => (current.type === 'startEvent' ? { ...current, interrupting } : current))}
          />
        </>
      ) : null}
      {element.type === 'endEvent' ? (
        <>
          <Field label="As it ends">
            {(inputId) => (
              <Select
                id={inputId}
                value={endWay(element)}
                onChange={(event) => {
                  const way = event.target.value;
                  let next = updateElement(definition, name, id, (current) => {
                    if (current.type !== 'endEvent') return current;
                    const { message: _message, error: _error, escalation: _escalation, compensate: _compensate, cancel: _cancel, signal: _signal, ...rest } = current;
                    const plain = { ...rest, terminate: way === 'terminate' };
                    const first = sendChoices(definition, name)[0];
                    if (way === 'message' && first) return { ...plain, message: { action: first.action, ...(first.record ? { record: first.record } : {}) } };
                    if (way === 'error') return { ...plain, error: true };
                    if (way === 'escalation') return { ...plain, escalation: true };
                    if (way === 'compensate') return { ...plain, compensate: true };
                    if (way === 'cancel') return { ...plain, cancel: true };
                    if (way === 'signal') return { ...plain, signal: signalChoices(definition)[0] ?? 'signal' };
                    return plain;
                  });
                  // A cancel leaves the transaction by its cancel event: add one if it has none.
                  const around = element.in;
                  const leaves = Object.values(process.elements).some((other) => other.type === 'boundaryEvent' && other.attachedTo === around && other.cancel);
                  if (way === 'cancel' && around !== undefined && !leaves) next = addBoundary(next, name, around, 'cancel').definition;
                  onChange(next);
                }}
              >
                <option value="none">Nothing more happens</option>
                <option value="terminate">{element.in === undefined ? 'All other paths end too' : 'All other paths in the sub-process end too'}</option>
                <option value="message" disabled={!sendChoices(definition, name).length}>
                  It sends a message
                </option>
                <option value="error">It raises an error</option>
                <option value="escalation">It escalates</option>
                <option value="compensate">It undoes what completed here</option>
                <option value="signal">It throws a signal</option>
                {inTransaction ? <option value="cancel">It cancels the transaction</option> : null}
              </Select>
            )}
          </Field>
          {element.message ? <SendPicker definition={definition} name={name} value={element.message} onChange={(message) => set((current) => ({ ...current, message }) as ProcessElement)} /> : null}
          {element.error ? (
            <CodeInput
              label="Error code"
              hint="The error event on a sub-process or call around it with this code, or one for any error, catches it, and ends what it sits on."
              value={element.error}
              onChange={(error) => set((current) => ({ ...current, error }) as ProcessElement)}
            />
          ) : null}
          {element.escalation ? (
            <CodeInput
              label="Escalation code"
              hint="The escalation event on a sub-process or call around it with this code, or one for any escalation, hears it."
              value={element.escalation}
              onChange={(escalation) => set((current) => ({ ...current, escalation }) as ProcessElement)}
            />
          ) : null}
          {element.compensate ? (
            <p className="m-0 text-sm text-muted">Each task that completed {element.in === undefined ? 'in the process' : 'in the sub-process'} and has an undo action runs it once, newest first.</p>
          ) : null}
          {element.cancel ? <p className="m-0 text-sm text-muted">What completed in the transaction is undone, newest first, and the path leaves by its cancel event.</p> : null}
          {element.signal !== undefined ? (
            <SignalInput
              definition={definition}
              label="Signal"
              hint="Every process of the app that waits for this signal hears it, and the processes it starts start on this record."
              value={element.signal}
              onChange={(signal) => set((current) => ({ ...current, signal }) as ProcessElement)}
            />
          ) : null}
        </>
      ) : null}
      {element.type === 'scriptTask' ? <ScriptSteps definition={definition} name={name} id={id} onChange={onChange} /> : null}
      {element.type === 'scriptTask' ? <UndoPicker definition={definition} name={name} id={id} onChange={onChange} /> : null}
      {element.type === 'scriptTask' || element.type === 'sendTask' ? <BoundaryEvents definition={definition} name={name} id={id} problems={problems} onChange={onChange} /> : null}
      {element.type === 'sendTask' || (element.type === 'intermediateThrowEvent' && element.message) ? (
        <SendPicker definition={definition} name={name} value={element.message!} onChange={(message) => set((current) => ({ ...current, message }) as ProcessElement)} />
      ) : null}
      {element.type === 'sendTask' ? <UndoPicker definition={definition} name={name} id={id} onChange={onChange} /> : null}
      {element.type === 'intermediateThrowEvent' && element.escalation ? (
        <CodeInput
          label="Escalation code"
          hint="The escalation event on a sub-process or call around it with this code, or one for any escalation, hears it. The path goes on, unless that event ends what it came from."
          value={element.escalation}
          onChange={(escalation) => set((current) => ({ ...current, escalation }) as ProcessElement)}
        />
      ) : null}
      {element.type === 'intermediateThrowEvent' && element.signal !== undefined ? (
        <SignalInput
          definition={definition}
          label="Signal"
          hint="Every process of the app that waits for this signal hears it, and the path goes on."
          value={element.signal}
          onChange={(signal) => set((current) => ({ ...current, signal }) as ProcessElement)}
        />
      ) : null}
      {element.type === 'intermediateThrowEvent' && element.compensate ? (
        <p className="m-0 text-sm text-muted">
          Each task that completed {element.in === undefined ? 'in the process' : 'in the sub-process'} and has an undo action runs it once, newest first. Then the path goes on.
        </p>
      ) : null}
      {element.type === 'businessRuleTask' ? (
        <fieldset className="m-0 grid gap-1 rounded-md border border-line p-3">
          <legend className="px-1 text-sm text-muted">Checks the rules</legend>
          <Checkbox
            label="All the rules of these records"
            checked={!element.rules}
            onChange={(all) =>
              set((current) => {
                if (current.type !== 'businessRuleTask') return current;
                const { rules: _rules, ...rest } = current;
                return all ? rest : { ...rest, rules: Object.keys(definition.rules).filter((rule) => definition.rules[rule]!.entity === process.entity).slice(0, 1) };
              })
            }
          />
          {element.rules
            ? Object.entries(definition.rules)
                .filter(([, rule]) => rule.entity === process.entity)
                .map(([rule, spec]) => (
                  <Checkbox
                    key={rule}
                    label={spec.message}
                    checked={element.rules!.includes(rule)}
                    onChange={(on) =>
                      set((current) =>
                        current.type === 'businessRuleTask' ? { ...current, rules: on ? [...(current.rules ?? []), rule] : (current.rules ?? []).filter((each) => each !== rule) } : current,
                      )
                    }
                  />
                ))
            : null}
          <p className="m-0 text-xs text-muted">What it finds is its outcome: passed, warned or failed. Select a flow out of it to say which outcome it follows.</p>
        </fieldset>
      ) : null}
      {element.type === 'receiveTask' ? (
        <>
          <Field label="Waits until it is saved" hint="Someone saves the action on the record, and the process goes on.">
            {(inputId) => (
              <Select id={inputId} value={element.message.action} onChange={(event) => set((current) => ({ ...current, message: { action: event.target.value } }) as ProcessElement)}>
                {actions.includes(element.message.action) ? null : (
                  <option value={element.message.action} disabled>
                    Choose an action
                  </option>
                )}
                {actions.map((action) => (
                  <option key={action} value={action}>
                    {definition.actions[action]!.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <BoundaryEvents definition={definition} name={name} id={id} problems={problems} onChange={onChange} />
        </>
      ) : null}
      {element.type === 'intermediateThrowEvent' && element.link !== undefined ? (
        <Field label="Goes on at" hint="The catch link of the same name, where the path goes on.">
          {(inputId) => (
            <Select id={inputId} value={element.link} onChange={(event) => set((current) => ({ ...current, link: event.target.value }) as ProcessElement)}>
              {[...new Set([element.link!, ...links])].map((link) => (
                <option key={link} value={link}>
                  {link}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {element.type === 'intermediateCatchEvent' && element.link !== undefined ? (
        <Field label="Link name" hint="Throw links of this name go on here.">
          {(inputId) => (
            <TextInput
              id={inputId}
              value={element.link}
              onChange={(event) => {
                // The throw links of the old name follow the new one.
                const was = element.link;
                const named = event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
                let next = updateElement(definition, name, id, (current) => ({ ...current, link: named }) as ProcessElement);
                for (const [other, candidate] of Object.entries(process.elements)) {
                  if (candidate.type === 'intermediateThrowEvent' && candidate.link === was) next = updateElement(next, name, other, (current) => ({ ...current, link: named }) as ProcessElement);
                }
                onChange(next);
              }}
            />
          )}
        </Field>
      ) : null}
      {element.type === 'intermediateThrowEvent' && element.link === undefined && !element.message && !element.escalation && !element.compensate && element.signal === undefined ? (
        <p className="m-0 text-sm text-muted">A milestone: the instance's history marks when a path passes it.</p>
      ) : null}
      {element.type === 'userTask' ? (
        <>
          <Field label="Done by people with the role">
            {(inputId) => (
              <Select id={inputId} value={element.role} onChange={(event) => set((current) => ({ ...current, role: event.target.value }) as ProcessElement)}>
                {Object.entries(definition.roles).map(([role, spec]) => (
                  <option key={role} value={role}>
                    {spec.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <SeveralEditor element={element} people={people} onChange={set} />
          {element.several ? null : (
          <Field label="Assigned to" hint="Routing narrows the task to one person; the role still decides what they may do.">
            {(inputId) => (
              <Select
                id={inputId}
                value={!element.assignee ? '' : 'field' in element.assignee ? `field:${element.assignee.field}` : `manager:${element.assignee.managerOf}:${element.assignee.levels}`}
                onChange={(event) =>
                  set((current) => {
                    if (current.type !== 'userTask') return current;
                    const { assignee: _assignee, ...rest } = current;
                    const [kind, field, levels] = event.target.value.split(':');
                    if (kind === 'field' && field) return { ...rest, assignee: { field } };
                    if (kind === 'manager' && field) return { ...rest, assignee: { managerOf: field, levels: Number(levels) || 1 } };
                    return rest;
                  })
                }
              >
                <option value="">Anyone with the role</option>
                {people.map((person) => (
                  <option key={`field:${person.name}`} value={`field:${person.name}`}>
                    The record's {person.label.toLowerCase()}
                  </option>
                ))}
                {people.map((person) => (
                  <option key={`manager:${person.name}`} value={`manager:${person.name}:1`}>
                    The manager of the record's {person.label.toLowerCase()}
                  </option>
                ))}
                {people.map((person) => (
                  <option key={`manager2:${person.name}`} value={`manager:${person.name}:2`}>
                    The manager's manager of the record's {person.label.toLowerCase()}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          )}
          {element.assignee ? null : (
            <Field label="In the department of" hint="Only people with the role in that department see and decide the task.">
              {(inputId) => (
                <Select
                  id={inputId}
                  value={element.department?.of ?? ''}
                  onChange={(event) =>
                    set((current) => {
                      if (current.type !== 'userTask') return current;
                      const { department: _department, ...rest } = current;
                      return event.target.value ? { ...rest, department: { of: event.target.value } } : rest;
                    })
                  }
                >
                  <option value="">Any department</option>
                  {people.map((person) => (
                    <option key={person.name} value={person.name}>
                      The record's {person.label.toLowerCase()}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Checkbox
            label="It has a due date"
            checked={element.due !== undefined}
            onChange={(on) =>
              set((current) => {
                if (current.type !== 'userTask') return current;
                const { due: _due, ...rest } = current;
                return on ? { ...rest, due: 'P3D' } : rest;
              })
            }
          />
          {element.due ? <DurationInput label="Due within" value={element.due} onChange={(due) => set((current) => ({ ...current, due }) as ProcessElement)} /> : null}
          <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
            <legend className="px-1 text-sm text-muted">Outcomes</legend>
            {element.outcomes.map((outcome, index) => (
              <div key={outcome.name} className="grid gap-1.5 rounded-md bg-sunken p-2">
                <div className="flex gap-2">
                  <TextInput
                    aria-label={`Outcome ${index + 1}`}
                    value={outcome.label}
                    onChange={(event) =>
                      set((current) => (current.type === 'userTask' ? { ...current, outcomes: current.outcomes.map((o, i) => (i === index ? { ...o, label: event.target.value } : o)) } : current))
                    }
                  />
                  <Remove
                    disabled={element.outcomes.length === 1}
                    onClick={() => set((current) => (current.type === 'userTask' ? { ...current, outcomes: current.outcomes.filter((_, i) => i !== index) } : current))}
                  >
                    Remove
                  </Remove>
                </div>
                <Select
                  aria-label={`What ${outcome.label} runs`}
                  value={outcome.action ?? ''}
                  onChange={(event) =>
                    set((current) =>
                      current.type === 'userTask'
                        ? {
                            ...current,
                            outcomes: current.outcomes.map((o, i) => {
                              if (i !== index) return o;
                              const { action: _action, ...rest } = o;
                              return event.target.value ? { ...rest, action: event.target.value } : rest;
                            }),
                          }
                        : current,
                    )
                  }
                >
                  <option value="">Runs no action</option>
                  {actions.map((action) => (
                    <option key={action} value={action}>
                      Runs {definition.actions[action]!.label}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
            <Button
              size="sm"
              onClick={() =>
                set((current) => {
                  if (current.type !== 'userTask') return current;
                  let n = current.outcomes.length + 1;
                  while (current.outcomes.some((outcome) => outcome.name === `outcome_${n}`)) n++;
                  return { ...current, outcomes: [...current.outcomes, { name: `outcome_${n}`, label: `Outcome ${n}` }] };
                })
              }
            >
              Add an outcome
            </Button>
          </fieldset>
          <BoundaryEvents definition={definition} name={name} id={id} problems={problems} onChange={onChange} />
          <Field label="Review card">
            {(inputId) => (
              <Select
                id={inputId}
                value={element.card ?? ''}
                onChange={(event) =>
                  set((current) => {
                    if (current.type !== 'userTask') return current;
                    const { card: _card, ...rest } = current;
                    return event.target.value ? { ...rest, card: event.target.value } : rest;
                  })
                }
              >
                <option value="">None</option>
                {Object.entries(definition.cards)
                  .filter(([, card]) => card.entity === process.entity)
                  .map(([card, spec]) => (
                    <option key={card} value={card}>
                      {spec.title}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </>
      ) : null}
      {element.type === 'serviceTask' ? (
        element.skill ? (
          <p className="m-0 text-sm">
            Starts the a7c skill <code>{element.skill}</code>.
          </p>
        ) : (
          <Field label="Runs, with the app's authority" hint="An action that doesn't read the person running it: a process runs it with no person.">
            {(inputId) => (
              <Select id={inputId} value={element.action ?? ''} onChange={(event) => set((current) => ({ ...current, action: event.target.value }) as ProcessElement)}>
                <option value="" disabled>
                  Choose an action
                </option>
                {actions.map((action) => (
                  <option key={action} value={action}>
                    {definition.actions[action]!.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )
      ) : null}
      {element.type === 'serviceTask' && element.action ? <UndoPicker definition={definition} name={name} id={id} onChange={onChange} /> : null}
      {element.type === 'serviceTask' ? <BoundaryEvents definition={definition} name={name} id={id} problems={problems} onChange={onChange} /> : null}
      {element.type === 'subProcess' && element.event ? (
        <p className="m-0 text-sm text-muted">
          An event sub-process starts when its start event's trigger happens, while {element.in === undefined ? 'the process' : 'the sub-process it is in'} runs. No flow leads into it or out of it.
          Select its start event to choose the trigger, and whether it ends all that runs beside it.
        </p>
      ) : null}
      {element.type === 'subProcess' && element.adHoc ? (
        <>
          <p className="m-0 text-sm text-muted">
            All that no flow leads to inside it starts at once, so people do its tasks in any order, and a path inside it ends where no flow leads on. Select it to add more work inside it.
          </p>
          <Checkbox
            label="It ends early, once a condition holds"
            checked={element.completeWhen !== undefined}
            onChange={(on) =>
              set((current) => {
                if (current.type !== 'subProcess') return current;
                const { completeWhen: _completeWhen, ...rest } = current;
                return on ? { ...rest, completeWhen: startingCondition(definition, process.entity) } : rest;
              })
            }
          />
          {element.completeWhen ? (
            <ConditionEditor
              label="It ends once this holds"
              value={element.completeWhen}
              onChange={(condition) => set((current) => (current.type === 'subProcess' ? { ...current, completeWhen: condition ?? startingCondition(definition, process.entity) } : current))}
              choices={conditionChoices}
            />
          ) : null}
          <BoundaryEvents definition={definition} name={name} id={id} problems={problems} onChange={onChange} />
        </>
      ) : null}
      {element.type === 'subProcess' && !element.event && !element.adHoc ? (
        <>
          <Checkbox
            label="A transaction: a cancel end inside undoes what completed in it"
            checked={element.transaction === true}
            onChange={(on) =>
              set((current) => {
                if (current.type !== 'subProcess') return current;
                const { transaction: _transaction, ...rest } = current;
                return on ? { ...rest, transaction: true } : rest;
              })
            }
          />
          <p className="m-0 text-sm text-muted">
            It ends when no path is left inside it. Select a flow inside it to add there. An event on its edge acts on all of it: a deadline for the whole part, or an action inside it that fails.
          </p>
          <BoundaryEvents definition={definition} name={name} id={id} problems={problems} onChange={onChange} />
        </>
      ) : null}
      {element.type === 'callActivity' ? (
        <>
          <Field label="Runs the process" hint="It starts at its start event without actions, and this process waits until it ends.">
            {(inputId) => (
              <Select
                id={inputId}
                value={`${element.process}|${element.record ?? ''}`}
                onChange={(event) =>
                  set((current) => {
                    if (current.type !== 'callActivity') return current;
                    const [called = '', record] = event.target.value.split('|');
                    const { record: _record, ...rest } = current;
                    // A name that only repeated the called process's label follows it.
                    const named = current.name !== (definition.processes?.[current.process]?.label ?? current.process);
                    return { ...rest, ...(named ? {} : { name: definition.processes?.[called]?.label ?? called }), process: called, ...(record ? { record } : {}) };
                  })
                }
              >
                {calls.some((call) => call.process === element.process && (call.record ?? '') === (element.record ?? '')) ? null : (
                  <option value={`${element.process}|${element.record ?? ''}`} disabled>
                    Choose a process
                  </option>
                )}
                {calls.map((call) => (
                  <option key={`${call.process}|${call.record ?? ''}`} value={`${call.process}|${call.record ?? ''}`}>
                    {call.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {definition.processes?.[element.process] ? (
            <Button size="sm" onClick={() => onOpen(element.process)}>
              Open {definition.processes[element.process]!.label}
            </Button>
          ) : null}
          <BoundaryEvents definition={definition} name={name} id={id} problems={problems} onChange={onChange} />
        </>
      ) : null}
      {element.type === 'intermediateCatchEvent' && element.link === undefined ? (
        <>
          <Field label="Wait">
            {(inputId) => (
              <Select
                id={inputId}
                value={element.message ? 'message' : element.condition ? 'condition' : element.signal !== undefined ? 'signal' : element.timer && 'date' in element.timer ? 'date' : 'duration'}
                onChange={(event) =>
                  set((current) => {
                    if (current.type !== 'intermediateCatchEvent') return current;
                    const { timer: _timer, message: _message, condition: _condition, signal: _signal, ...rest } = current;
                    if (event.target.value === 'message' && actions[0]) return { ...rest, message: { action: actions[0] } };
                    if (event.target.value === 'signal') return { ...rest, signal: signalChoices(definition)[0] ?? 'signal' };
                    if (event.target.value === 'condition') return { ...rest, condition: startingCondition(definition, process.entity) };
                    if (event.target.value === 'date' && dates[0]) return { ...rest, timer: { date: dates[0].name } };
                    return { ...rest, timer: { duration: 'P1D' } };
                  })
                }
              >
                <option value="duration">For a time</option>
                <option value="date" disabled={!dates.length}>
                  Until a date of the record
                </option>
                <option value="message" disabled={!actions.length}>
                  Until an action is saved
                </option>
                <option value="condition">Until a condition holds</option>
                <option value="signal">Until a signal is thrown</option>
              </Select>
            )}
          </Field>
          {element.signal !== undefined ? (
            <SignalInput
              definition={definition}
              label="Until the signal"
              hint="A process of the app, or an operator, throws it. Only a path that waits when it is thrown hears it."
              value={element.signal}
              onChange={(signal) => set((current) => ({ ...current, signal }) as ProcessElement)}
            />
          ) : element.condition ? (
            <ConditionEditor
              label="Until this holds"
              value={element.condition}
              onChange={(condition) => set((current) => (current.type === 'intermediateCatchEvent' ? { ...current, condition: condition ?? startingCondition(definition, process.entity) } : current))}
              choices={conditionChoices}
            />
          ) : awaited !== undefined ? (
            <Field label="Until it is saved" hint="Someone saves the action on the record, and the process goes on.">
              {(inputId) => (
                <Select id={inputId} value={awaited} onChange={(event) => set((current) => ({ ...current, message: { action: event.target.value } }) as ProcessElement)}>
                  {actions.includes(awaited) ? null : (
                    <option value={awaited} disabled>
                      Choose an action
                    </option>
                  )}
                  {actions.map((action) => (
                    <option key={action} value={action}>
                      {definition.actions[action]!.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : element.timer && 'date' in element.timer ? (
            <Field label="Until">
              {(inputId) => (
                <Select id={inputId} value={element.timer && 'date' in element.timer ? element.timer.date : ''} onChange={(event) => set((current) => ({ ...current, timer: { date: event.target.value } }) as ProcessElement)}>
                  {dates.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <DurationInput
              label="For"
              value={element.timer && 'duration' in element.timer ? element.timer.duration : 'P1D'}
              onChange={(duration) => set((current) => ({ ...current, timer: { duration } }) as ProcessElement)}
            />
          )}
        </>
      ) : null}
      {element.type === 'exclusiveGateway' ? <p className="m-0 text-sm text-muted">Select a flow out of it to set when it is taken. The first flow whose condition holds is taken, or the one marked Otherwise.</p> : null}
      {element.type === 'parallelGateway' ? <p className="m-0 text-sm text-muted">Every flow out of it is taken at once. With several flows in, it waits for a token from each.</p> : null}
      {element.type === 'eventBasedGateway' ? (
        <p className="m-0 text-sm text-muted">
          It waits for the first of the events after it: a time, an action saved on the record, a condition, or a receive task. The first that happens takes the path, and the others no longer wait.
        </p>
      ) : null}
      {element.type === 'complexGateway' ? (
        <>
          <Field label="Goes on once this many paths have arrived" hint="A path that arrives after that ends here, until no path can still arrive. Then it waits again.">
            {(inputId) => (
              <TextInput
                id={inputId}
                type="number"
                min={1}
                max={20}
                value={element.waitFor}
                onChange={(event) => set((current) => (current.type === 'complexGateway' ? { ...current, waitFor: Math.max(1, Math.min(20, Math.round(Number(event.target.value) || 1))) } : current))}
              />
            )}
          </Field>
          <p className="m-0 text-sm text-muted">Select a flow out of it to set when it is taken: every flow whose condition holds, or else the one marked Otherwise.</p>
        </>
      ) : null}
      {element.type === 'inclusiveGateway' ? (
        <p className="m-0 text-sm text-muted">
          Select a flow out of it to set when it is taken. Every flow whose condition holds is taken, or else the one marked Otherwise. With several flows in, it waits for each path that can still arrive.
        </p>
      ) : null}
      {canRepeat(element) && !(element.type === 'userTask' && element.several) && !(element.type === 'subProcess' && element.event) ? (
        <RepeatEditor
          repeat={element.repeat}
          starting={startingCondition(definition, process.entity)}
          choices={conditionChoices}
          outcomes={(element.type === 'userTask' || element.type === 'businessRuleTask') && Object.values(process.flows).some((flow) => flow.from === id && flow.outcome !== undefined)}
          onChange={(repeat) =>
            set((current) => {
              if (!canRepeat(current)) return current;
              const { repeat: _repeat, ...rest } = current;
              return repeat ? { ...current, repeat } : rest;
            })
          }
        />
      ) : null}
      {'description' in element || element.type.endsWith('Task') || element.type === 'task' || element.type === 'subProcess' || element.type === 'callActivity' ? (
        <Field label="Description">
          {(inputId) => (
            <textarea
              id={inputId}
              rows={2}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
              value={'description' in element ? (element.description ?? '') : ''}
              onChange={(event) =>
                set((current) => {
                  if (!('description' in current) && !current.type.endsWith('Task') && current.type !== 'task' && current.type !== 'subProcess' && current.type !== 'callActivity') return current;
                  const { description: _description, ...rest } = current as ProcessElement & { description?: string };
                  return (event.target.value ? { ...rest, description: event.target.value } : rest) as ProcessElement;
                })
              }
            />
          )}
        </Field>
      ) : null}
      {readOnly ? null : (
        <Remove
          disabled={element.type === 'startEvent' && starts === 1}
          onClick={() => {
            onChange(removeElement(definition, name, id));
            onSelect(null);
          }}
        >
          Remove {typeLabel(element).toLowerCase()}
        </Remove>
      )}
    </fieldset>
  );
}

function FlowPanel(props: {
  definition: Definition;
  name: string;
  id: string;
  flow: Flow;
  problems: ReadonlyMap<string, string[]>;
  onChange: (definition: Definition) => void;
  onSelect: (selection: Selection) => void;
  readOnly: boolean;
}) {
  const { definition, name, id, flow, problems, onChange, onSelect, readOnly } = props;
  const process = definition.processes![name]!;
  const from = process.elements[flow.from];
  const set = (change: (flow: Flow) => Flow) => onChange(updateFlow(definition, name, id, change));
  const outcomes: RefChoice[] = Object.entries(process.elements).flatMap(([task, element]) =>
    element.type === 'userTask' ? [{ ref: `tasks.${task}.outcome`, label: `${element.name}: outcome`, kind: 'choice' as const, options: element.outcomes.map((outcome) => ({ value: outcome.name, label: outcome.label })) }] : [],
  );
  const choices = [...recordChoices(definition, process.entity), ...outcomes];
  return (
    <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">Flow</h3>
        <code className="text-xs text-muted">{id}</code>
      </div>
      <p className="m-0 text-sm text-muted">
        From {from && 'name' in from && from.name ? from.name : flow.from} to{' '}
        {(() => {
          const to = process.elements[flow.to];
          return to && 'name' in to && to.name ? to.name : flow.to;
        })()}
      </p>
      <Problems messages={problems.get(id)} />
      <Field label="Label">
        {(inputId) => (
          <TextInput
            id={inputId}
            value={flow.name ?? ''}
            onChange={(event) =>
              set((current) => {
                const { name: _name, ...rest } = current;
                return event.target.value ? { ...rest, name: event.target.value } : rest;
              })
            }
          />
        )}
      </Field>
      {from?.type === 'businessRuleTask' ? (
        <Field label="Follows what the check finds">
          {(inputId) => (
            <Select
              id={inputId}
              value={flow.outcome ?? ''}
              onChange={(event) =>
                set((current) => {
                  const { outcome: _outcome, ...rest } = current;
                  return event.target.value ? { ...rest, outcome: event.target.value } : rest;
                })
              }
            >
              <option value="">Any outcome</option>
              {RULE_OUTCOMES.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {outcome === 'passed' ? 'Every rule holds' : outcome === 'warned' ? 'Only warnings' : 'An error'}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {from?.type === 'userTask' ? (
        <Field label="Follows the outcome">
          {(inputId) => (
            <Select
              id={inputId}
              value={flow.outcome ?? ''}
              onChange={(event) =>
                set((current) => {
                  const { outcome: _outcome, ...rest } = current;
                  return event.target.value ? { ...rest, outcome: event.target.value } : rest;
                })
              }
            >
              <option value="">Any outcome</option>
              {from.outcomes.map((outcome) => (
                <option key={outcome.name} value={outcome.name}>
                  {outcome.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {from?.type === 'exclusiveGateway' || from?.type === 'inclusiveGateway' || from?.type === 'complexGateway' ? (
        <>
          <Checkbox
            label="Otherwise: taken when no other flow's condition holds"
            checked={Boolean(flow.default)}
            onChange={(on) =>
              set((current) => {
                const { default: _default, when: _when, ...rest } = current;
                return on ? { ...rest, default: true } : rest;
              })
            }
          />
          {flow.default ? null : (
            <ConditionEditor
              label="Taken when"
              value={flow.when}
              onChange={(when) =>
                set((current) => {
                  const { when: _when, ...rest } = current;
                  return when ? { ...rest, when } : rest;
                })
              }
              choices={choices}
            />
          )}
        </>
      ) : null}
      {readOnly ? null : (
        <Remove
          onClick={() => {
            onChange(removeFlow(definition, name, id));
            onSelect(null);
          }}
        >
          Remove the flow
        </Remove>
      )}
    </fieldset>
  );
}

function ProcessPanel(props: {
  definition: Definition;
  name: string;
  problems: ReadonlyMap<string, string[]>;
  onChange: (definition: Definition) => void;
  onRemoved: () => void;
  onArranged: () => void;
  readOnly: boolean;
}) {
  const { definition, name, problems, onChange, onRemoved, onArranged, readOnly } = props;
  const process = definition.processes![name]!;
  const entity = definition.entities[process.entity];
  const general = problems.get('');
  const total = [...problems.values()].reduce((sum, list) => sum + list.length, 0);
  const setStarter = (role: string, on: boolean) => {
    const next = structuredClone(definition);
    const spec = next.roles[role]!;
    const list = (spec.processes ?? []).filter((each) => each !== name);
    if (on) list.push(name);
    if (list.length) spec.processes = list;
    else delete spec.processes;
    onChange(next);
  };
  return (
    <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <h3 className="m-0 text-base font-semibold">Process</h3>
      <p className="m-0 text-sm text-muted">
        Each instance is about one {entity?.label.toLowerCase() ?? process.entity}. Select a shape or a flow to change it, drag between shapes to join them, and press Delete to remove what is selected.
      </p>
      {total ? <Notice tone="warn">{total} problem(s) to fix before the app saves. The shapes with a red number say what.</Notice> : <Notice tone="good">The process passes the checks.</Notice>}
      <Problems messages={general} />
      <Field label="Name">{(id) => <TextInput id={id} value={process.label} onChange={(event) => onChange(updateProcess(definition, name, { label: event.target.value }))} />}</Field>
      <Field label="Description">
        {(id) => (
          <textarea
            id={id}
            rows={2}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            value={process.description ?? ''}
            onChange={(event) => onChange(updateProcess(definition, name, { description: event.target.value }))}
          />
        )}
      </Field>
      <fieldset className="m-0 grid gap-1 rounded-md border border-line p-3">
        <legend className="px-1 text-sm text-muted">Who may start it by hand</legend>
        {Object.entries(definition.roles).map(([role, spec]) => (
          <Checkbox key={role} label={spec.label} checked={spec.processes?.includes(name) ?? false} onChange={(on) => setStarter(role, on)} />
        ))}
      </fieldset>
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              onChange(arrange(definition, name));
              onArranged();
            }}
          >
            Arrange the shapes
          </Button>
          <Remove
            onClick={() => {
              onChange(removeProcess(definition, name));
              onRemoved();
            }}
          >
            Remove the process
          </Remove>
        </div>
      )}
    </fieldset>
  );
}

function NewProcessDialog({ open, definition, onClose, onCreate }: { open: boolean; definition: Definition; onClose: () => void; onCreate: (definition: Definition, name: string) => void }) {
  const entities = processEntities(definition);
  const [label, setLabel] = useState('');
  const [entity, setEntity] = useState(entities[0] ?? '');
  useEffect(() => {
    if (open) {
      setLabel('');
      setEntity(entities[0] ?? '');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog
      open={open}
      title="New process"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!label.trim() || !entity}
            onClick={() => {
              const created = newProcess(definition, label.trim(), entity);
              onCreate(created.definition, created.name);
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Name">{(id) => <TextInput id={id} value={label} placeholder="Leave approval" onChange={(event) => setLabel(event.target.value)} />}</Field>
        <Field label="About each" hint="Each instance of the process is about one of these records, which is its data.">
          {(id) => (
            <Select id={id} value={entity} onChange={(event) => setEntity(event.target.value)}>
              {entities.map((each) => (
                <option key={each} value={each}>
                  {definition.entities[each]!.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function DownloadBpmn({ appId, process, available }: { appId: string; process: string; available: boolean }) {
  const download = useMutation({ mutationFn: () => api.downloadBpmn(appId, process) });
  return (
    <Button size="sm" onClick={() => download.mutate()} disabled={!available || download.isPending} title={available ? 'A BPMN 2.0 file, with its diagram' : 'Save the process first'}>
      Download BPMN
    </Button>
  );
}

/** Bring in the processes of a BPMN 2.0 file, from Camunda Modeler, Signavio or Ambit itself. It saves at once, so unsaved changes come first. */
function ImportBpmn({ appId, dirty, onImported }: { appId: string; dirty: boolean; onImported: (processes: string[]) => void }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const bring = useMutation({
    mutationFn: async (file: File) => api.importBpmn(appId, await file.text()),
    onSuccess: async (result) => {
      setNotes(result.notes);
      await Promise.all(['definition', 'app'].map((key) => client.invalidateQueries({ queryKey: [key] })));
      onImported(result.processes);
    },
  });
  const issues = bring.error instanceof ApiError ? ((bring.error.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues ?? []) : [];
  return (
    <>
      <Button size="sm" onClick={() => input.current?.click()} disabled={dirty || bring.isPending} title={dirty ? 'Save your changes first: an import saves' : 'A .bpmn file'}>
        Import BPMN
      </Button>
      <input
        ref={input}
        type="file"
        accept=".bpmn,.xml,application/xml,text/xml"
        className="hidden"
        aria-label="A BPMN file to import"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) bring.mutate(file);
          event.target.value = '';
        }}
      />
      {bring.error ? (
        <div className="basis-full">
          <Notice tone="bad">
            {bring.error instanceof ApiError ? bring.error.message : "The file can't be imported"}
            {issues.length ? (
              <ul className="m-0 mt-1 grid gap-1 pl-4">
                {issues.map((issue) => (
                  <li key={`${issue.path} ${issue.message}`}>{issue.message}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        </div>
      ) : null}
      {notes?.length ? (
        <div className="basis-full">
          <Notice tone="good">
            Imported.
            <ul className="m-0 mt-1 grid gap-1 pl-4">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}
    </>
  );
}
