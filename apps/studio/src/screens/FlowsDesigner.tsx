import { flowSubject, flowWaits, type AppFlow, type FlowStep, type FlowType, type Several, type VarKind, type WaitFor } from '@platform/app-model';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BaseEdge, EdgeLabelRenderer, Handle, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.js';
import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { Icon, type IconName } from '../components/icon.js';
import { Button, Card, Checkbox, cx, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { recordChoices, type RefChoice } from '../model/conditions.js';
import {
  addFlow,
  canWait,
  flowEntities,
  insertStep,
  labelledLists,
  layoutFlow,
  listChoices,
  liveWords,
  moveStep,
  newStep,
  recordVariables,
  removeFlow,
  removeStep,
  replaceStep,
  scopeAt,
  STEP_GROUPS,
  STEP_NAMES,
  stepAt,
  stepWords,
  typeText,
  updateActionsOf,
  updateFlow,
  variableChoices,
  type CanvasEdge,
  type CanvasNode,
  type StepType,
} from '../model/flows.js';
import { durationOf, durationParts } from '../model/waits.js';
import type { Definition, Field as FieldDef, FlowLive } from '../types.js';
import { ValueEditor, type ValueMode, type ValueSources } from './StepsEditor.js';

/*
 * The flow designer (design §6.2, §6.11). A flow's steps go left to right across the canvas, as a
 * Mendix microflow's do; each arrow takes a new step, and each step opens on the right. A flow
 * that waits is built the same way, with people's tasks, waits, and ways at once. "Try it" runs a
 * saved flow that runs in one go on real records, and undoes what it did.
 */

type Props = { appId: string; definition: Definition; onChange: (definition: Definition) => void; readOnly?: boolean; dirty?: boolean };

export function FlowsDesigner({ appId, definition, onChange, readOnly = false, dirty = false }: Props) {
  const flows = definition.flows ?? {};
  const names = Object.keys(flows);
  const [chosen, setChosen] = useState<string | null>(names[0] ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ list: string; index: number } | null>(null);
  const [label, setLabel] = useState('');
  // How the flow shows: as its canvas or as a list; and, for a flow that waits, as designed or live.
  const [show, setShow] = useState<'canvas' | 'list'>('canvas');
  const [liveOn, setLiveOn] = useState(false);
  // The frames folded to one box, on the flow on show.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const fold = (path: string) =>
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const name = chosen && flows[chosen] ? chosen : (names[0] ?? null);
  const flow = name ? flows[name] : undefined;
  const waits = Boolean(flow && flowWaits(flow, definition.flows));
  const live = useQuery({
    queryKey: ['flow-live', appId, name],
    queryFn: () => api.flowLive(appId, name!),
    enabled: Boolean(name && waits && liveOn),
    refetchInterval: 10_000,
  });
  const liveNow = waits && liveOn ? live.data : undefined;
  const select = (path: string | null) => {
    setSelected(path);
    setAdding(null);
  };

  return (
    // As Ocean's FlowDesigner lays it out: the canvas is the whole middle, with which flow at its top
    // left, and the chosen step, or the flow's settings, on the right.
    <div className="grid gap-4 @min-[62rem]:grid-cols-[minmax(0,1fr)_24rem]">
      <Card className="relative min-w-0 self-start overflow-hidden p-0">
        <div className="logic-view">
          {names.length ? (
            <select
              aria-label="Which flow"
              value={name ?? ''}
              onChange={(event) => {
                setChosen(event.target.value);
                setFolded(new Set());
                select(null);
              }}
            >
              {names.map((each) => (
                <option key={each} value={each}>
                  {flows[each]!.label}
                  {flowWaits(flows[each]!, definition.flows) ? ' · waits for people' : ''}
                </option>
              ))}
            </select>
          ) : null}
          {waits ? (
            // Live, each step says how many cases wait there now, and the longest wait.
            <div className="modes" role="group" aria-label="Show">
              <button type="button" aria-pressed={!liveOn} onClick={() => setLiveOn(false)}>
                Design
              </button>
              <button type="button" aria-pressed={liveOn} onClick={() => setLiveOn(true)}>
                Live
              </button>
            </div>
          ) : null}
          {liveNow ? <span className="text-xs text-muted">{liveNow.running} running{dirty ? ' · as saved' : ''}</span> : null}
          {readOnly ? null : (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!label.trim()) return;
                const added = addFlow(definition, label.trim());
                onChange(added.definition);
                setChosen(added.name);
                select(null);
                setLabel('');
              }}
            >
              <TextInput aria-label="New flow" className="w-56" placeholder="New flow, e.g. Record the spend" value={label} onChange={(e) => setLabel(e.target.value)} />
              <Button type="submit" disabled={!label.trim()}>
                Add flow
              </Button>
            </form>
          )}
        </div>
        {flow && name && show === 'list' ? (
          <FlowListing
            definition={definition}
            flow={flow}
            selected={selected}
            readOnly={readOnly}
            live={liveNow}
            onSelect={select}
            onShow={setShow}
            onInsert={(place) => {
              setSelected(null);
              setAdding(place);
            }}
          />
        ) : flow && name ? (
          <FlowCanvas
            key={name}
            definition={definition}
            flow={flow}
            selected={selected}
            readOnly={readOnly}
            live={liveNow}
            folded={folded}
            onFold={fold}
            onSelect={select}
            onShow={setShow}
            onInsert={(place) => {
              setSelected(null);
              setAdding(place);
            }}
          />
        ) : (
          <div className="flow grid h-[40rem] place-items-center p-6">
            <EmptyState title="Add a flow to design it">
              A flow is what happens in an app: it finds, creates and changes records, decides and loops, as a Mendix microflow does. It can wait for people and for time too. Actions run flows, and so can roles, through the API.
            </EmptyState>
          </div>
        )}
      </Card>
      {flow && name ? (
        <div className="grid content-start gap-4">
          {adding && !readOnly ? (
            <AddStep
              waits={canWait(flow) && !insideLoop(flow, adding.list)}
              onCancel={() => setAdding(null)}
              onAdd={(type) => {
                const scope = scopeAt(definition, name, adding);
                onChange(insertStep(definition, name, adding.list, adding.index, newStep(definition, name, scope, type)));
                setAdding(null);
                setSelected(`${adding.list}[${adding.index}]`);
              }}
            />
          ) : selected && stepAt(flow, selected) ? (
            <StepEditor
              definition={definition}
              name={name}
              path={selected}
              readOnly={readOnly}
              onChange={onChange}
              onRemoved={() => select(null)}
              onMoved={(path) => setSelected(path)}
              onClosed={() => select(null)}
            />
          ) : (
            <>
              <FlowSettings
                definition={definition}
                name={name}
                readOnly={readOnly}
                onChange={onChange}
                onRemove={() => {
                  onChange(removeFlow(definition, name));
                  setChosen(null);
                  select(null);
                }}
              />
              {flowWaits(flow, definition.flows) ? <HowItStarts definition={definition} name={name} /> : <TryFlow appId={appId} definition={definition} name={name} flow={flow} dirty={dirty} />}
              <EarlierProcesses definition={definition} readOnly={readOnly} onChange={onChange} />
            </>
          )}
        </div>
      ) : (
        <EarlierProcesses definition={definition} readOnly={readOnly} onChange={onChange} />
      )}
    </div>
  );
}

/** Whether a list of steps is inside a loop or an error handler, where a flow can't wait yet. */
function insideLoop(flow: AppFlow, list: string): boolean {
  const holders = [...list.matchAll(/\]/g)].map((match) => list.slice(0, match.index + 1));
  return holders.some((holder) => {
    const type = /\]$/.test(holder) && /^steps(\[\d+\]\.[a-z_]+)*\[\d+\]$/.test(holder) ? stepAt(flow, holder)?.type : undefined;
    return type === 'each' || type === 'try';
  });
}

// ---- The canvas: a3t's flows as Ocean's LogicNode draws them (sreent/ocean, components/LogicNode)

type Place = { list: string; index: number };
type Live = FlowLive['steps'][number];
type NodeData = {
  node: CanvasNode;
  selected: boolean;
  readOnly: boolean;
  live?: Live | undefined;
  onInsert: (place: Place) => void;
  onSelect: (path: string) => void;
  onFold: (path: string) => void;
};
type FlowNode = Node<NodeData>;
type WireData = { edge: CanvasEdge; readOnly: boolean; onInsert: (place: Place) => void };

/** Each kind of step's icon: Ocean's, in the colour of what the step does. */
const STEP_ICONS: Readonly<Partial<Record<StepType, IconName>>> = {
  set: 'settings',
  find: 'find',
  create: 'tool',
  change: 'tool',
  delete: 'tool',
  add_line: 'tool',
  check: 'shield',
  call: 'studio',
  total: 'total',
  task: 'people',
};

/** React Flow needs a handle at each end of an edge; the arrows are the layout's own, so these stay hidden. */
const Handles = () => (
  <>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
  </>
);

function StepNode({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  const type = node.step!.type;
  return (
    <div className={cx('logic-step', node.tone, selected && 'chosen')} data-testid={`flow-step-${node.path}`}>
      <Icon name={STEP_ICONS[type] ?? FRAME_ICONS[type] ?? 'settings'} />
      <span className="logic-kind">{node.kindLabel}</span>
      <span className="logic-words" title={node.label}>
        {node.label}
      </span>
      {node.about ? (
        <span className="logic-about" title={node.about}>
          {node.about}
        </span>
      ) : null}
      {/* Who acts: a person with the task's role, or the app's own authority for what a flow writes. */}
      {node.who ? (
        <span className="logic-who">
          {node.who.kind === 'own' ? (
            <b className="own">
              <Icon name="audit" />
            </b>
          ) : (
            <b>{node.who.initial}</b>
          )}
          {node.who.words}
        </span>
      ) : null}
      <LiveChip live={data.live} />
      {node.folded ? (
        <button
          type="button"
          className="nodrag absolute top-1 right-1 rounded-sm border-0 bg-transparent px-1 text-xs text-muted hover:text-text"
          aria-label={`Unfold ${node.label}`}
          title="Unfold"
          onClick={(event) => {
            event.stopPropagation();
            data.onFold(node.path!);
          }}
        >
          ⤢
        </button>
      ) : null}
      <Handles />
    </div>
  );
}

function DecisionNode({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  return (
    <div className={cx('logic-decision', node.kind === 'merge' && 'merge', selected && 'chosen')} data-testid={node.path ? `flow-step-${node.path}` : undefined}>
      <i />
      {node.kind === 'decision' ? (
        <span className="logic-caption above">
          <strong>{node.label}</strong>
        </span>
      ) : null}
      <Handles />
    </div>
  );
}

function RingNode({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  return (
    <div className={cx('logic-ring', node.kind === 'end' && 'end', selected && 'ring-2 ring-focus')} role="img" aria-label={node.about ? `${node.label}: ${node.about}` : node.label}>
      <span className="logic-caption below">
        <strong>{node.label}</strong>
        {node.about ? <span>{node.about}</span> : null}
      </span>
      <Handles />
    </div>
  );
}

/** A wait's ring: a clock for time, a message for an action, a tick for a condition, a bell for a signal. */
function WaitNode({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  return (
    <div className={cx('logic-ring wait', selected && 'ring-2 ring-focus')} role="img" aria-label={node.about ? `${node.label}: ${node.about}` : node.label} data-testid={`flow-wait-${node.id}`}>
      <Icon name={node.icon ?? 'clock'} />
      <span className={cx('logic-caption', node.caption ?? 'above')}>
        <strong>{node.label}</strong>
        {node.about ? <span>{node.about}</span> : null}
      </span>
      <LiveChip live={data.live} />
      <Handles />
    </div>
  );
}

/** Live: how many cases wait at a step, how many are stuck there, and the longest wait. */
function LiveChip({ live }: { live: Live | undefined }) {
  return live ? <span className={cx('logic-live', live.stuck > 0 && 'text-bad')}>{liveWords(live)}</span> : null;
}

const FRAME_ICONS: Readonly<Partial<Record<StepType, IconName>>> = { each: 'sync', try: 'guard', first_of: 'wait', all_at_once: 'studio' };

function FrameNode({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  return (
    <div className={cx('logic-frame', selected && 'ring-2 ring-focus')}>
      <button type="button" className="logic-frame-head nodrag" onClick={() => node.path && data.onSelect(node.path)} data-testid={`flow-step-${node.path}`}>
        <Icon name={FRAME_ICONS[node.step?.type ?? 'each'] ?? 'sync'} />
        {node.label}
        {node.about ? <span className="note"> · {node.about}</span> : null}
      </button>
      <button
        type="button"
        className="nodrag absolute -top-3 right-3 rounded-sm border border-line bg-surface px-1.5 text-xs leading-5 text-muted hover:text-text"
        aria-label={`Fold ${node.label}`}
        title="Fold to one box"
        onClick={() => data.onFold(node.path!)}
      >
        ⤡
      </button>
      <LiveChip live={data.live} />
    </div>
  );
}

function SlotNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className="grid h-full w-full place-items-center rounded-md border border-dashed border-line-strong" data-testid={`flow-slot-${data.node.list}`}>
      <Handles />
      {data.readOnly ? (
        <span className="text-xs text-faint">No steps</span>
      ) : (
        <Button size="sm" variant="ghost" className="nodrag" onClick={() => data.onInsert({ list: data.node.list!, index: 0 })}>
          Add a step here
        </Button>
      )}
    </div>
  );
}

const PortNode = () => (
  <div className="h-px w-px">
    <Handles />
  </div>
);

/** An arrow as the layout drew it: at right angles, with its head, its word, and a "+" for a new step. */
function WireEdge({ data }: EdgeProps<Edge<WireData>>) {
  if (!data) return null;
  const { edge, readOnly, onInsert } = data;
  const head = edge.head;
  const triangle = head
    ? {
        right: `M${head.x - 9} ${head.y - 4.6} L${head.x} ${head.y} L${head.x - 9} ${head.y + 4.6} Z`,
        left: `M${head.x + 9} ${head.y - 4.6} L${head.x} ${head.y} L${head.x + 9} ${head.y + 4.6} Z`,
        down: `M${head.x - 4.6} ${head.y - 9} L${head.x} ${head.y} L${head.x + 4.6} ${head.y - 9} Z`,
        up: `M${head.x - 4.6} ${head.y + 9} L${head.x} ${head.y} L${head.x + 4.6} ${head.y + 9} Z`,
      }[head.dir]
    : null;
  return (
    <>
      {/* A deadline hangs below its task by a dashed line, as Ocean's logic edges draw one. */}
      <BaseEdge path={edge.d} {...(edge.dashed ? { style: { strokeDasharray: '4 4' } } : {})} />
      {triangle ? <path d={triangle} style={{ fill: 'var(--faint)' }} /> : null}
      <EdgeLabelRenderer>
        {edge.save ? (
          // Where the flow waits, it saves: what came before commits, and a failure after can't undo it.
          <span className="logic-save" style={{ left: edge.save.x, top: edge.save.y }} title="The flow saves here, before it waits">
            <span>saves</span>
          </span>
        ) : null}
        {edge.label ? (
          <span className="flow-label" style={{ left: edge.label.x, top: edge.label.y }}>
            {edge.label.text}
          </span>
        ) : null}
        {edge.insert && !readOnly ? (
          <button
            type="button"
            // Each arrow's "+" shows while the pointer is over the canvas, so the flow reads calmly otherwise.
            className="logic-add nodrag nopan opacity-0 transition-opacity group-hover/canvas:opacity-70 hover:!opacity-100 focus-visible:!opacity-100"
            style={{ left: edge.insert.x, top: edge.insert.y, pointerEvents: 'all' }}
            aria-label={`Add a step at ${edge.insert.list}[${edge.insert.index}]`}
            title="Add a step here"
            onClick={() => onInsert({ list: edge.insert!.list, index: edge.insert!.index })}
          >
            +
          </button>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

const NODE_TYPES = { step: StepNode, decision: DecisionNode, merge: DecisionNode, start: RingNode, end: RingNode, frame: FrameNode, slot: SlotNode, port: PortNode, wait: WaitNode };
const EDGE_TYPES = { wire: WireEdge };

/** Canvas or List: the choice of views, at the right of the canvas's foot and at the top of the list. */
function ShowAs({ show, onShow }: { show: 'canvas' | 'list'; onShow: (show: 'canvas' | 'list') => void }) {
  return (
    <div className="modes" role="group" aria-label="Show it as">
      <button type="button" aria-pressed={show === 'canvas'} onClick={() => onShow('canvas')}>
        Canvas
      </button>
      <button type="button" aria-pressed={show === 'list'} onClick={() => onShow('list')}>
        List
      </button>
    </div>
  );
}

function FlowCanvas(props: {
  definition: Definition;
  flow: AppFlow;
  selected: string | null;
  readOnly: boolean;
  live: FlowLive | undefined;
  folded: ReadonlySet<string>;
  onFold: (path: string) => void;
  onSelect: (path: string | null) => void;
  onShow: (show: 'canvas' | 'list') => void;
  onInsert: (place: Place) => void;
}) {
  const { definition, flow, selected, readOnly, live, folded, onFold, onSelect, onInsert } = props;
  const liveAt = useMemo(() => new Map((live?.steps ?? []).map((step) => [step.path, step])), [live]);
  // The flow wraps at the canvas's own width, so its rows fit at full size.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(980);
  useEffect(() => {
    if (!box) return;
    // Below the width of a laptop's canvas it zooms out rather than wraps, so short flows stay on one row.
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(980, Math.round(entry.contentRect.width))));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  const laid = useMemo(() => layoutFlow(definition, flow, width, folded), [definition, flow, width, folded]);
  // As steps come and go, the view fits the flow again: a new step is never out of sight.
  const [view, setView] = useState<ReactFlowInstance<FlowNode, Edge<WireData>> | null>(null);
  useEffect(() => {
    void view?.fitView({ padding: 0.08, maxZoom: 1 });
  }, [view, laid]);
  const nodes: FlowNode[] = laid.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: { x: node.x, y: node.y },
    data: { node, selected: node.path !== undefined && node.path === selected, readOnly, live: node.id === node.path ? liveAt.get(node.id) : undefined, onInsert, onSelect, onFold },
    draggable: false,
    connectable: false,
    selectable: false,
    // React Flow draws an edge only between nodes with a size: a port gets a pixel.
    style: { width: Math.max(1, node.width), height: Math.max(1, node.height) },
    zIndex: node.kind === 'frame' ? -1 : 1,
  }));
  const edges: Edge<WireData>[] = laid.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: 'wire', data: { edge, readOnly, onInsert } }));
  return (
    <div ref={setBox} className="group/canvas flow flow-canvas h-[40rem]" data-testid="flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        onInit={setView}
        minZoom={0.3}
        onNodeClick={(_event, node) => {
          const path = node.data.node.path;
          if (path && node.data.node.kind !== 'frame') onSelect(path);
        }}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
      >
      </ReactFlow>
      <div className="flow-tools">
        <button type="button" aria-label="Zoom in" onClick={() => void view?.zoomIn()}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => void view?.zoomOut()}>
          −
        </button>
        <button type="button" onClick={() => void view?.fitView({ padding: 0.08, maxZoom: 1 })}>
          Show all of it
        </button>
      </div>
      <div className="flow-views">
        <ShowAs show="canvas" onShow={props.onShow} />
      </div>
    </div>
  );
}

/** Each kind of step's icon in the list: the canvas's own. */
function iconOf(step: FlowStep): IconName {
  if (step.type === 'wait') return 'clock';
  if (step.type === 'if') return 'decide';
  if (step.type === 'return') return 'check';
  return STEP_ICONS[step.type] ?? FRAME_ICONS[step.type] ?? 'settings';
}

/**
 * A flow as its list (Ocean's FlowList): what starts it, then each step in order, with the steps a
 * step holds under it by the name of their way. For the keyboard, and for a narrow screen.
 */
function FlowListing(props: {
  definition: Definition;
  flow: AppFlow;
  selected: string | null;
  readOnly: boolean;
  live: FlowLive | undefined;
  onSelect: (path: string | null) => void;
  onShow: (show: 'canvas' | 'list') => void;
  onInsert: (place: Place) => void;
}) {
  const { definition, flow, selected, readOnly, live, onSelect, onInsert } = props;
  const entity = flowSubject(flow)?.entity;
  const liveAt = new Map((live?.steps ?? []).map((step) => [step.path, step]));
  const name = Object.entries(definition.flows ?? {}).find(([, each]) => each === flow)?.[0];
  const starts = Object.values(definition.actions).filter((action) => name && action.flow?.flow === name);
  const rows = (steps: readonly FlowStep[], list: string): ReactNode => (
    <ol>
      {steps.map((step, index) => {
        const path = `${list}[${index}]`;
        const words = stepWords(definition, step, entity);
        const now = liveAt.get(path);
        return (
          <li key={path} className="grid gap-1">
            <button type="button" className={cx('flow-row', words.tone)} aria-expanded={selected === path} onClick={() => onSelect(path)} data-testid={`flow-row-${path}`}>
              <Icon name={iconOf(step)} />
              <span className="flow-row-text">
                <span className="flow-row-name">{words.words}</span>
                <span className="flow-row-about">
                  {words.kind}
                  {words.about ? ` · ${words.about}` : ''}
                </span>
              </span>
              {now ? <span className="flow-row-end">{liveWords(now)}</span> : null}
            </button>
            {labelledLists(definition, step, path, entity).map((inner) => (
              <div key={inner.path} className="ms-6 grid gap-1">
                <span className="text-xs font-semibold text-muted">{inner.label}</span>
                {inner.steps.length ? rows(inner.steps, inner.path) : null}
                {readOnly ? null : (
                  <Button size="sm" variant="ghost" className="justify-self-start" aria-label={`Add a step at ${inner.path}[${inner.steps.length}]`} onClick={() => onInsert({ list: inner.path, index: inner.steps.length })}>
                    + Add a step
                  </Button>
                )}
              </div>
            ))}
          </li>
        );
      })}
    </ol>
  );
  return (
    <div className="flow-listing h-[40rem] overflow-auto pt-16" aria-label={`${flow.label}, as a list`}>
      <ShowAs show="list" onShow={props.onShow} />
      <section>
        <h2>What starts it</h2>
        <p className="m-0 text-sm text-muted">
          {starts.length
            ? `${starts.map((action) => action.label).join(', ')}, as it saves its record`
            : `An action, a role or another flow that runs it${Object.keys(flow.input).length ? `, with ${Object.keys(flow.input).join(', ')}` : ''}`}
        </p>
      </section>
      <section>
        <h2>Its steps, in order</h2>
        {flow.steps.length ? rows(flow.steps, 'steps') : <p className="m-0 text-sm text-faint">No steps yet.</p>}
        {readOnly ? null : (
          <Button size="sm" variant="ghost" className="justify-self-start" aria-label={`Add a step at steps[${flow.steps.length}]`} onClick={() => onInsert({ list: 'steps', index: flow.steps.length })}>
            + Add a step
          </Button>
        )}
      </section>
    </div>
  );
}

// ---- Adding and editing steps

function AddStep({ waits, onAdd, onCancel }: { waits: boolean; onAdd: (type: StepType) => void; onCancel: () => void }) {
  return (
    <Card className="grid gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-base font-semibold">Add a step</h3>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {STEP_GROUPS.map((group) => (
        <div key={group.label} className="grid gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-faint">{group.label}</span>
          <div className="grid grid-cols-2 gap-2">
            {group.types.map((type) => (
              <Button key={type} size="sm" disabled={group.waits && !waits} onClick={() => onAdd(type)}>
                {STEP_NAMES[type]}
              </Button>
            ))}
          </div>
          {group.waits && !waits ? (
            <p className="m-0 text-xs text-muted">A flow waits on one record, and not inside a loop or an error handler: give the flow one input, a record, in its settings.</p>
          ) : null}
        </div>
      ))}
    </Card>
  );
}

/** The sources a value can come from at a place in a flow: its variables, and their fields. */
function sourcesFor(definition: Definition, scope: ReadonlyMap<string, VarKind>): ValueSources {
  const choices = variableChoices(definition, scope);
  return {
    all: choices.map((choice) => ({ ref: choice.ref, label: choice.label })),
    numbers: choices.filter((choice) => choice.kind === 'number').map((choice) => ({ ref: choice.ref, label: choice.label })),
    label: 'A variable',
  };
}

const ANY_VALUE: readonly ValueMode[] = ['fixed', 'field', 'calc', 'join', 'person', 'today', 'now'];

function StepEditor(props: { definition: Definition; name: string; path: string; readOnly: boolean; onChange: (definition: Definition) => void; onRemoved: () => void; onMoved: (path: string) => void; onClosed: () => void }) {
  const { definition, name, path, readOnly, onChange } = props;
  const flow = definition.flows![name]!;
  const step = stepAt(flow, path)!;
  const scope = scopeAt(definition, name, { path });
  const set = (next: FlowStep) => onChange(replaceStep(definition, name, path, next));
  const sources = sourcesFor(definition, scope);
  const variables = variableChoices(definition, scope);
  const index = Number(/\[(\d+)\]$/.exec(path)![1]);
  const base = path.replace(/\[\d+\]$/, '');

  return (
    <Card className="grid gap-4 p-4" aria-label="Step">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{STEP_NAMES[step.type]}</h3>
        {readOnly ? null : (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" aria-label="Move the step up" onClick={() => (onChange(moveStep(definition, name, path, -1)), props.onMoved(`${base}[${Math.max(0, index - 1)}]`))}>
              ↑
            </Button>
            <Button size="sm" variant="ghost" aria-label="Move the step down" onClick={() => (onChange(moveStep(definition, name, path, 1)), props.onMoved(`${base}[${index + 1}]`))}>
              ↓
            </Button>
            <Button size="sm" variant="danger" aria-label="Remove the step" onClick={() => (onChange(removeStep(definition, name, path)), props.onRemoved())}>
              Remove
            </Button>
            <Button size="sm" variant="ghost" aria-label="Close the step" onClick={props.onClosed}>
              ✕
            </Button>
          </div>
        )}
      </div>
      <StepFields definition={definition} name={name} step={step} scope={scope} sources={sources} variables={variables} set={set} />
    </Card>
  );
}

function VarName({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={label} hint="Lowercase letters, digits and underscores.">
      {(id) => <TextInput id={id} className="font-mono" value={value} onChange={(e) => onChange(e.target.value.trim())} />}
    </Field>
  );
}

function StepFields(props: {
  definition: Definition;
  name: string;
  step: FlowStep;
  scope: ReadonlyMap<string, VarKind>;
  sources: ValueSources;
  variables: RefChoice[];
  set: (step: FlowStep) => void;
}) {
  const { definition, name, step, scope, sources, variables, set } = props;
  const entities = flowEntities(definition);
  const records = recordVariables(scope);
  const lists = listChoices(definition, scope);
  const entityOf = (variable: string) => {
    const kind = scope.get(variable);
    return kind?.kind === 'record' ? kind.entity : undefined;
  };
  const recordPicker = (value: string, onPick: (value: string) => void) => (
    <Field label="Record">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onPick(e.target.value)}>
          <option value="" disabled>
            Choose a variable that holds a record
          </option>
          {records.map((record) => (
            <option key={record} value={record}>
              {record} ({definition.entities[entityOf(record)!]?.label})
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const listPicker = (label: string, value: string, onPick: (value: string) => void) => (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onPick(e.target.value)}>
          <option value="" disabled>
            Choose a list
          </option>
          {lists.map((list) => (
            <option key={list.value} value={list.value}>
              {list.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  switch (step.type) {
    case 'set':
      return (
        <>
          <VarName label="Variable" value={step.var} onChange={(value) => set({ ...step, var: value })} />
          <Field label="Value">{() => <ValueEditor definition={definition} entity="" label="Value" value={step.value} from={sources} only={ANY_VALUE} onChange={(value) => set({ ...step, value })} />}</Field>
        </>
      );
    case 'find':
      return (
        <>
          <Field label="Entity">
            {(id) => (
              <Select id={id} value={step.entity} onChange={(e) => set({ ...step, entity: e.target.value, where: undefined, sort: undefined })}>
                {entities.map((entity) => (
                  <option key={entity} value={entity}>
                    {definition.entities[entity]!.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ConditionEditor
            label="Which records"
            value={step.where}
            choices={recordChoices(definition, step.entity)}
            compareWith={[THE_PERSON, ...variables]}
            empty="Every record"
            onChange={(where) => set({ ...step, where })}
          />
          <Checkbox label="Only the first one, or none" checked={step.first === true} onChange={(first) => set({ ...step, first: first || undefined })} />
          <VarName label="Keep them in" value={step.var} onChange={(value) => set({ ...step, var: value })} />
          {step.first ? null : (
            <Field label="At most">
              {(id) => <TextInput id={id} type="number" min={1} max={1000} value={step.limit} onChange={(e) => set({ ...step, limit: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />}
            </Field>
          )}
        </>
      );
    case 'create':
      return (
        <>
          <Field label="Entity">
            {(id) => (
              <Select id={id} value={step.entity} onChange={(e) => set({ ...step, entity: e.target.value, values: {} })}>
                {entities.map((entity) => (
                  <option key={entity} value={entity}>
                    {definition.entities[entity]!.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ValuesEditor definition={definition} entity={step.entity} values={step.values} sources={sources} onChange={(values) => set({ ...step, values })} />
          <VarName label="Keep it in" value={step.var ?? ''} onChange={(value) => set({ ...step, var: value || undefined })} />
        </>
      );
    case 'change':
      return (
        <>
          {recordPicker(step.record, (record) => set({ ...step, record, values: {} }))}
          {entityOf(step.record) ? <ValuesEditor definition={definition} entity={entityOf(step.record)!} values={step.values} sources={sources} onChange={(values) => set({ ...step, values })} /> : null}
        </>
      );
    case 'delete':
      return (
        <>
          {recordPicker(step.record, (record) => set({ ...step, record }))}
          <p className="m-0 text-xs text-faint">Deleting stays with a person: a flow that a token runs can't delete.</p>
        </>
      );
    case 'add_line': {
      const holder = entityOf(step.record);
      const linesFields = holder ? definition.entities[holder]!.fields.filter((field) => field.type === 'lines') : [];
      const lineEntity = linesFields.find((field) => field.name === step.field);
      return (
        <>
          {recordPicker(step.record, (record) => set({ ...step, record, field: '', values: {} }))}
          <Field label="Lines">
            {(id) => (
              <Select id={id} value={step.field} onChange={(e) => set({ ...step, field: e.target.value, values: {} })}>
                <option value="" disabled>
                  Choose lines
                </option>
                {linesFields.map((field) => (
                  <option key={field.name} value={field.name}>
                    {field.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {lineEntity?.type === 'lines' ? <ValuesEditor definition={definition} entity={lineEntity.entity} line values={step.values} sources={sources} onChange={(values) => set({ ...step, values })} /> : null}
        </>
      );
    }
    case 'each':
      return (
        <>
          {listPicker('For each item of', step.in, (value) => set({ ...step, in: value }))}
          <VarName label="Call the item" value={step.as} onChange={(value) => set({ ...step, as: value })} />
        </>
      );
    case 'if':
      return <ConditionEditor label="If" value={step.when} choices={variables} compareWith={[THE_PERSON, ...variables]} onChange={(when) => set({ ...step, when: when ?? step.when })} />;
    case 'check':
      return (
        <>
          <ConditionEditor label="It must hold that" value={step.assert} choices={variables} compareWith={[THE_PERSON, ...variables]} onChange={(assert) => set({ ...step, assert: assert ?? step.assert })} />
          <Field label="Message">{(id) => <TextInput id={id} value={step.message} onChange={(e) => set({ ...step, message: e.target.value })} />}</Field>
          <Field label="When it doesn't hold">
            {(id) => (
              <Select id={id} value={step.severity} onChange={(e) => set({ ...step, severity: e.target.value === 'warning' ? 'warning' : 'error' })}>
                <option value="error">Stop the flow, and undo it</option>
                <option value="warning">Note a warning, and go on</option>
              </Select>
            )}
          </Field>
        </>
      );
    case 'call': {
      const callee = definition.flows?.[step.flow];
      return (
        <>
          <Field label="Flow">
            {(id) => (
              <Select id={id} value={step.flow} onChange={(e) => set({ ...step, flow: e.target.value, input: {} })}>
                <option value="" disabled>
                  Choose a flow
                </option>
                {Object.entries(definition.flows ?? {})
                  .filter(([other]) => other !== name)
                  .map(([other, spec]) => (
                    <option key={other} value={other}>
                      {spec.label}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          {callee
            ? Object.entries(callee.input).map(([input, type]) => (
                <InputValue key={input} definition={definition} input={input} type={type} value={step.input[input]} scope={scope} sources={sources} onChange={(value) => set({ ...step, input: { ...step.input, [input]: value } })} />
              ))
            : null}
          {callee?.output ? <VarName label="Keep its result in" value={step.var ?? ''} onChange={(value) => set({ ...step, var: value || undefined })} /> : null}
        </>
      );
    }
    case 'try':
      return (
        <>
          <p className="m-0 text-sm text-muted">If a step inside fails, the steps on the "If it fails" path run instead.</p>
          <Checkbox label="Undo what the steps inside changed" checked={step.rollback !== false} onChange={(rollback) => set({ ...step, rollback })} />
          <VarName label="Keep the error's message in" value={step.error ?? ''} onChange={(value) => set({ ...step, error: value || undefined })} />
        </>
      );
    case 'total': {
      const list = lists.find((each) => each.value === step.of);
      const numberFields = list ? (definition.entities[list.entity]?.fields ?? []).filter((field) => field.type === 'number') : [];
      return (
        <>
          {listPicker('Of', step.of, (of) => set({ ...step, of, field: undefined }))}
          <Field label="Work out">
            {(id) => (
              <Select id={id} value={step.op} onChange={(e) => set({ ...step, op: e.target.value as typeof step.op, ...(e.target.value === 'count' ? { field: undefined } : { field: step.field ?? numberFields[0]?.name }) })}>
                <option value="count">How many</option>
                <option value="sum">The total of</option>
                <option value="avg">The average of</option>
                <option value="min">The lowest</option>
                <option value="max">The highest</option>
              </Select>
            )}
          </Field>
          {step.op === 'count' ? null : (
            <Field label="Field">
              {(id) => (
                <Select id={id} value={step.field ?? ''} onChange={(e) => set({ ...step, field: e.target.value })}>
                  {numberFields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <VarName label="Keep it in" value={step.var} onChange={(value) => set({ ...step, var: value })} />
        </>
      );
    }
    case 'return': {
      const flow = definition.flows?.[name];
      const output = flow?.output;
      if (flow && flowWaits(flow, definition.flows)) return <p className="m-0 text-sm text-muted">The flow ends here, and so does each of its ways that still runs.</p>;
      if (!output) return <p className="m-0 text-sm text-muted">The flow ends here. It gives no result: give it one in its settings.</p>;
      return <InputValue definition={definition} input="Result" type={output} value={step.value} scope={scope} sources={sources} onChange={(value) => set({ ...step, value })} />;
    }
    case 'task':
      return <TaskFields definition={definition} name={name} step={step} set={set} />;
    case 'wait':
      return <WaitForEditor definition={definition} name={name} label="Wait for" variables={variables} value={step.for} onChange={(wait) => set({ ...step, for: wait })} />;
    case 'first_of':
      return (
        <>
          <p className="m-0 text-sm text-muted">The flow waits for all of these at once. The first that happens takes its way, and the others no longer wait.</p>
          {step.ways.map((way, index) => (
            <fieldset key={index} className="m-0 grid gap-2 rounded-md border border-line p-3">
              <legend className="px-1 text-sm text-muted">Way {index + 1}</legend>
              <WaitForEditor definition={definition} name={name} label={`Way ${index + 1} waits for`} variables={variables} value={way.for} onChange={(wait) => set({ ...step, ways: step.ways.map((each, i) => (i === index ? { ...each, for: wait } : each)) })} />
              <Button size="sm" variant="ghost" className="justify-self-start" disabled={step.ways.length <= 2} onClick={() => set({ ...step, ways: step.ways.filter((_, i) => i !== index) })}>
                Remove way {index + 1}
              </Button>
            </fieldset>
          ))}
          <Button size="sm" className="justify-self-start" disabled={step.ways.length >= 10} onClick={() => set({ ...step, ways: [...step.ways, { for: { duration: 'P1D' }, steps: [] }] })}>
            Add a way
          </Button>
        </>
      );
    case 'all_at_once':
      return (
        <>
          <p className="m-0 text-sm text-muted">Each way runs at once, as people's tasks in different inboxes do. The flow goes on when every way has ended.</p>
          {step.ways.map((way, index) => (
            <div key={index} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
              <span>
                Way {index + 1}: {way.steps.length ? `${way.steps.length} step${way.steps.length > 1 ? 's' : ''}` : 'no steps yet'}
              </span>
              <Button size="sm" variant="ghost" disabled={step.ways.length <= 2} onClick={() => set({ ...step, ways: step.ways.filter((_, i) => i !== index) })}>
                Remove way {index + 1}
              </Button>
            </div>
          ))}
          <Button size="sm" className="justify-self-start" disabled={step.ways.length >= 10} onClick={() => set({ ...step, ways: [...step.ways, { steps: [] }] })}>
            Add a way
          </Button>
        </>
      );
  }
}

// ---- People and time: a person's task, and what a flow waits for

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
          <Select aria-label={`${label}: unit`} className="w-auto" value={parts.unit} onChange={(event) => onChange(durationOf(parts.amount, event.target.value === 'hours' ? 'hours' : event.target.value === 'weeks' ? 'weeks' : 'days'))}>
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="weeks">weeks</option>
          </Select>
        </div>
      )}
    </Field>
  );
}

/** The user fields of the record a flow that waits is about: whom its tasks can go to. */
function peopleOf(definition: Definition, entity: string | undefined): Array<{ name: string; label: string }> {
  return (entity ? (definition.entities[entity]?.fields ?? []) : []).filter((field) => field.type === 'user').map((field) => ({ name: field.name, label: field.label }));
}

type TaskStep = Extract<FlowStep, { type: 'task' }>;

/** A step without one of its parts. */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _gone, ...rest } = value;
  return rest;
}

function TaskFields({ definition, name, step, set }: { definition: Definition; name: string; step: TaskStep; set: (step: FlowStep) => void }) {
  const entity = flowSubject(definition.flows![name]!)?.entity;
  const people = peopleOf(definition, entity);
  const actions = updateActionsOf(definition, entity);
  const cards = Object.entries(definition.cards).filter(([, card]) => card.entity === entity);
  const assignee = !step.assignee ? '' : 'field' in step.assignee ? `field:${step.assignee.field}` : `manager:${step.assignee.managerOf}:${step.assignee.levels}`;
  const outcome = (index: number, change: (outcome: TaskStep['outcomes'][number]) => TaskStep['outcomes'][number]) => set({ ...step, outcomes: step.outcomes.map((each, i) => (i === index ? change(each) : each)) });
  return (
    <>
      <Field label="What the inbox calls it">{(id) => <TextInput id={id} value={step.label} onChange={(e) => set({ ...step, label: e.target.value })} />}</Field>
      <Field label="Done by people with the role" hint="A role grants; whom the task goes to only narrows it.">
        {(id) => (
          <Select id={id} value={step.role} onChange={(e) => set({ ...step, role: e.target.value })}>
            <option value="" disabled>
              Choose a role
            </option>
            {Object.entries(definition.roles).map(([role, spec]) => (
              <option key={role} value={role}>
                {spec.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <SeveralEditor several={step.several} outcomes={step.outcomes} people={people} onChange={(several) => set(several ? { ...without(step, 'assignee'), several } : without(step, 'several'))} />
      {step.several ? null : (
        <Field label="Goes to">
          {(id) => (
            <Select
              id={id}
              value={assignee}
              onChange={(e) => {
                const [kind, field, levels] = e.target.value.split(':');
                const rest = without(step, 'assignee');
                if (kind === 'field' && field) set({ ...without(rest, 'department'), assignee: { field } });
                else if (kind === 'manager' && field) set({ ...without(rest, 'department'), assignee: { managerOf: field, levels: Number(levels) || 1 } });
                else set(rest);
              }}
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
      {step.assignee || step.several ? null : (
        <Field label="In the department of" hint="Only people with the role in that department see and decide the task.">
          {(id) => (
            <Select id={id} value={step.department?.of ?? ''} onChange={(e) => set(e.target.value ? { ...step, department: { of: e.target.value } } : without(step, 'department'))}>
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
      <Checkbox label="It has a due date" checked={step.due !== undefined} onChange={(on) => set(on ? { ...step, due: 'P3D' } : without(step, 'due'))} />
      {step.due ? <DurationInput label="Due within" value={step.due} onChange={(due) => set({ ...step, due })} /> : null}
      <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm text-muted">Outcomes: a way on for each</legend>
        {step.outcomes.map((each, index) => (
          <div key={each.name} className="grid gap-1.5 rounded-md bg-sunken p-2">
            <div className="flex gap-2">
              <TextInput aria-label={`Outcome ${index + 1}`} value={each.label} onChange={(e) => outcome(index, (current) => ({ ...current, label: e.target.value }))} />
              <Button size="sm" variant="ghost" disabled={step.outcomes.length === 1} onClick={() => set({ ...step, outcomes: step.outcomes.filter((_, i) => i !== index) })}>
                Remove
              </Button>
            </div>
            <Select aria-label={`What ${each.label} runs`} value={each.action ?? ''} onChange={(e) => outcome(index, (current) => (e.target.value ? { ...current, action: e.target.value } : without(current, 'action')))}>
              <option value="">Runs no action</option>
              {actions.map((action) => (
                <option key={action} value={action}>
                  Runs {definition.actions[action]!.label}, as the person who decides
                </option>
              ))}
            </Select>
          </div>
        ))}
        <Button
          size="sm"
          className="justify-self-start"
          disabled={step.outcomes.length >= 10}
          onClick={() => {
            let n = step.outcomes.length + 1;
            while (step.outcomes.some((each) => each.name === `outcome_${n}`)) n++;
            set({ ...step, outcomes: [...step.outcomes, { name: `outcome_${n}`, label: `Outcome ${n}`, steps: [] }] });
          }}
        >
          Add an outcome
        </Button>
      </fieldset>
      <Checkbox label="It has a deadline" checked={Boolean(step.deadline)} onChange={(on) => set(on ? { ...step, deadline: { after: 'P3D', steps: [] } } : without(step, 'deadline'))} />
      {step.deadline ? (
        <>
          <DurationInput label="The task ends after" value={step.deadline.after} onChange={(after) => set({ ...step, deadline: { ...step.deadline!, after } })} />
          <p className="m-0 text-xs text-muted">Once that time passes, the task leaves the inbox, and the flow goes on by the deadline's way, below the task.</p>
        </>
      ) : null}
      <Field label="Review card">
        {(id) => (
          <Select id={id} value={step.card ?? ''} onChange={(e) => set(e.target.value ? { ...step, card: e.target.value } : without(step, 'card'))}>
            <option value="">None</option>
            {cards.map(([card, spec]) => (
              <option key={card} value={card}>
                {spec.title}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

/** Several people decide a task, each with a vote: who votes, in turn or at once, and what decides it. */
function SeveralEditor({ several, outcomes, people, onChange }: { several: Several | undefined; outcomes: TaskStep['outcomes']; people: ReadonlyArray<{ name: string; label: string }>; onChange: (several: Several | undefined) => void }) {
  const voters = several?.people;
  const decide = several?.decide;
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm text-muted">Several people</legend>
      <Checkbox
        label="Several people decide, each with a vote"
        checked={Boolean(several)}
        onChange={(on) =>
          onChange(on ? { people: { everyone: true }, sequential: false, decide: outcomes.length > 1 ? { count: 'all', outcome: outcomes[0]!.name, otherwise: outcomes[1]!.name } : { first: true } } : undefined)
        }
      />
      {several && voters && decide ? (
        <>
          <Field label="Who votes">
            {(id) => (
              <Select
                id={id}
                value={'everyone' in voters ? 'everyone' : 'fields' in voters ? 'fields' : `line:${voters.lineOf}`}
                onChange={(e) => {
                  const value = e.target.value;
                  const next: Several['people'] = value === 'everyone' ? { everyone: true } : value === 'fields' ? { fields: people.slice(0, 2).map((person) => person.name) } : { lineOf: value.slice('line:'.length), levels: 2 };
                  onChange({ ...several, people: next });
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
          {'fields' in voters
            ? people.map((person) => (
                <Checkbox
                  key={person.name}
                  label={`The record's ${person.label.toLowerCase()}`}
                  checked={voters.fields.includes(person.name)}
                  onChange={(on) => onChange({ ...several, people: { fields: on ? [...voters.fields, person.name] : voters.fields.filter((field) => field !== person.name) } })}
                />
              ))
            : null}
          <Checkbox label="One after another, in order" checked={several.sequential} onChange={(sequential) => onChange({ ...several, sequential })} />
          <Field label="Decided by">
            {(id) => (
              <Select
                id={id}
                value={'first' in decide ? 'first' : String(decide.count)}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === 'first') return onChange({ ...several, decide: { first: true } });
                  const count = value === 'all' || value === 'majority' ? value : Number(value);
                  const base = 'first' in decide ? { outcome: outcomes[0]!.name, otherwise: (outcomes[1] ?? outcomes[0])!.name } : decide;
                  onChange({ ...several, decide: { count, outcome: base.outcome, otherwise: base.otherwise } });
                }}
              >
                <option value="first">The first vote</option>
                <option value="all" disabled={outcomes.length < 2}>
                  Everyone's votes for one outcome
                </option>
                <option value="majority" disabled={outcomes.length < 2}>
                  A majority's votes for one outcome
                </option>
              </Select>
            )}
          </Field>
          <p className="m-0 text-xs text-muted">Once the votes decide, the outcome's action runs with the app's authority: no one person made the decision.</p>
        </>
      ) : null}
    </fieldset>
  );
}

/** What a wait waits for: a time, a date of the record, an action on it, a condition on it, or a signal. */
function WaitForEditor(props: { definition: Definition; name: string; label: string; variables: RefChoice[]; value: WaitFor; onChange: (wait: WaitFor) => void }) {
  const { definition, name, label, variables, value, onChange } = props;
  const entity = flowSubject(definition.flows![name]!)?.entity;
  const dates = (entity ? (definition.entities[entity]?.fields ?? []) : []).filter((field) => field.type === 'date' || field.type === 'datetime');
  const actions = updateActionsOf(definition, entity);
  const kind = 'duration' in value ? 'duration' : 'date' in value ? 'date' : 'action' in value ? 'action' : 'condition' in value ? 'condition' : 'signal';
  const fresh = (next: string): WaitFor => {
    if (next === 'date' && dates[0]) return { date: dates[0].name };
    if (next === 'action' && actions[0]) return { action: actions[0] };
    if (next === 'condition') return { condition: { exists: variables[0]?.ref ?? 'id' } };
    if (next === 'signal') return { signal: 'go' };
    return { duration: 'P1D' };
  };
  return (
    <>
      <Field label={label}>
        {(id) => (
          <Select id={id} value={kind} onChange={(e) => onChange(fresh(e.target.value))}>
            <option value="duration">A time</option>
            <option value="date" disabled={!dates.length}>
              A date of the record
            </option>
            <option value="action" disabled={!actions.length}>
              An action on the record
            </option>
            <option value="condition">A condition on the record</option>
            <option value="signal">A signal</option>
          </Select>
        )}
      </Field>
      {'duration' in value ? <DurationInput label="For" value={value.duration} onChange={(duration) => onChange({ duration })} /> : null}
      {'date' in value ? (
        <Field label="Until">
          {(id) => (
            <Select id={id} value={value.date} onChange={(e) => onChange({ date: e.target.value })}>
              {dates.map((field) => (
                <option key={field.name} value={field.name}>
                  The record's {field.label.toLowerCase()}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {'action' in value ? (
        <Field label="Until someone runs" hint="An update action on the record, such as withdrawing it.">
          {(id) => (
            <Select id={id} value={value.action} onChange={(e) => onChange({ action: e.target.value })}>
              {actions.map((action) => (
                <option key={action} value={action}>
                  {definition.actions[action]!.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {'condition' in value ? <ConditionEditor label="Until it holds that" value={value.condition} choices={variables} compareWith={variables} onChange={(condition) => onChange({ condition: condition ?? value.condition })} /> : null}
      {'signal' in value ? (
        <Field label="The signal" hint="An operator, or another flow, throws it by name.">
          {(id) => <TextInput id={id} className="font-mono" value={value.signal} onChange={(e) => onChange({ signal: e.target.value.trim() })} />}
        </Field>
      ) : null}
    </>
  );
}

/** A value for an input or a result: a value, or a variable that holds a record or a list of the type. */
function InputValue(props: { definition: Definition; input: string; type: FlowType; value: FlowStep extends never ? never : unknown; scope: ReadonlyMap<string, VarKind>; sources: ValueSources; onChange: (value: never) => void }) {
  const { definition, input, type, scope, sources } = props;
  const onChange = props.onChange as (value: unknown) => void;
  if (type.type === 'record' || type.type === 'list') {
    const fitting = [...scope].filter(([, kind]) => kind.kind === type.type && kind.entity === type.entity).map(([variable]) => variable);
    const current = typeof props.value === 'object' && props.value !== null && 'ref' in props.value ? String((props.value as { ref: string }).ref) : '';
    return (
      <Field label={`${input} (${typeText(definition, type)})`}>
        {(id) => (
          <Select id={id} value={current} onChange={(e) => onChange({ ref: e.target.value })}>
            <option value="" disabled>
              Choose a variable
            </option>
            {fitting.map((variable) => (
              <option key={variable} value={variable}>
                {variable}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  return (
    <Field label={`${input} (${typeText(definition, type)})`}>
      {() => <ValueEditor definition={definition} entity="" label={input} value={(props.value ?? null) as never} from={sources} only={ANY_VALUE} onChange={(value) => onChange(value)} />}
    </Field>
  );
}

/** Values for a record's fields: the fields a flow can write, each with where its value comes from. */
function ValuesEditor(props: { definition: Definition; entity: string; line?: boolean; values: Readonly<Record<string, unknown>>; sources: ValueSources; onChange: (values: Record<string, never>) => void }) {
  const { definition, entity, values, sources } = props;
  const onChange = props.onChange as (values: Record<string, unknown>) => void;
  const fields = (definition.entities[entity]?.fields ?? []).filter((field) => field.type !== 'lines' && field.type !== 'file' && !(field.type === 'number' && field.rollup));
  const unset = fields.filter((field) => !(field.name in values));
  const [adding, setAdding] = useState('');
  return (
    <div className="grid gap-2">
      <span className="text-sm text-muted">Values</span>
      {Object.entries(values).map(([field, value]) => {
        const target = fields.find((f) => f.name === field) as FieldDef | undefined;
        return (
          <div key={field} className="grid gap-1 rounded-md border border-line p-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{target?.label ?? field}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove the value of ${target?.label ?? field}`}
                onClick={() => onChange(Object.fromEntries(Object.entries(values).filter(([key]) => key !== field)))}
              >
                ✕
              </Button>
            </div>
            <ValueEditor definition={definition} entity="" {...(target ? { target } : {})} label={target?.label ?? field} value={value as never} from={sources} onChange={(next) => onChange({ ...values, [field]: next })} />
          </div>
        );
      })}
      {unset.length ? (
        <div className="flex gap-2">
          <Select aria-label="Field to give a value" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="" disabled>
              Give a field a value
            </option>
            {unset.map((field) => (
              <option key={field.name} value={field.name}>
                {field.label}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={!adding}
            onClick={() => {
              const target = fields.find((f) => f.name === adding)!;
              onChange({ ...values, [adding]: target.type === 'number' ? 0 : target.type === 'boolean' ? false : '' });
              setAdding('');
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---- A flow's settings, and trying it

const TYPES: ReadonlyArray<{ value: FlowType['type']; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'A number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'date', label: 'A date' },
  { value: 'datetime', label: 'A time' },
  { value: 'record', label: 'A record' },
  { value: 'list', label: 'A list of records' },
];

function typeOf(value: string, entity: string): FlowType {
  if (value === 'record' || value === 'list') return { type: value, entity };
  return { type: value as Exclude<FlowType['type'], 'record' | 'list'> };
}

function TypePicker({ definition, label, value, onChange, none }: { definition: Definition; label: string; value: FlowType | undefined; onChange: (value: FlowType | undefined) => void; none?: string }) {
  const entities = flowEntities(definition);
  const entity = value && (value.type === 'record' || value.type === 'list') ? value.entity : (entities[0] ?? '');
  return (
    <div className="flex flex-wrap gap-2">
      <Select aria-label={label} className="w-auto" value={value?.type ?? ''} onChange={(e) => onChange(e.target.value ? typeOf(e.target.value, entity) : undefined)}>
        {none ? <option value="">{none}</option> : null}
        {TYPES.map((type) => (
          <option key={type.value} value={type.value}>
            {type.label}
          </option>
        ))}
      </Select>
      {value && (value.type === 'record' || value.type === 'list') ? (
        <Select aria-label={`${label}: entity`} className="w-auto" value={value.entity} onChange={(e) => onChange(typeOf(value.type, e.target.value))}>
          {entities.map((each) => (
            <option key={each} value={each}>
              {definition.entities[each]!.label}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

function FlowSettings({ definition, name, readOnly, onChange, onRemove }: { definition: Definition; name: string; readOnly: boolean; onChange: (definition: Definition) => void; onRemove: () => void }) {
  const flow = definition.flows![name]!;
  const [input, setInput] = useState('');
  return (
    <Card className="grid gap-3 p-4" aria-label="Flow">
      <h3 className="m-0 text-base font-semibold">Flow</h3>
      <Field label="Label">{(id) => <TextInput id={id} value={flow.label} onChange={(e) => onChange(updateFlow(definition, name, { label: e.target.value }))} />}</Field>
      <Field label="What it does" hint="For builders and reviewers.">
        {(id) => (
          <textarea
            id={id}
            className="min-h-16 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5"
            value={flow.description ?? ''}
            onChange={(e) => onChange(updateFlow(definition, name, { description: e.target.value }))}
          />
        )}
      </Field>
      <div className="grid gap-2">
        <span className="text-sm text-muted">Input</span>
        {Object.entries(flow.input).map(([key, type]) => (
          <div key={key} className="grid gap-1.5 rounded-md border border-line p-2">
            <div className="flex items-center justify-between gap-2">
              <code className="text-sm">{key}</code>
              {readOnly ? null : (
                <Button size="sm" variant="ghost" aria-label={`Remove the input ${key}`} onClick={() => onChange(updateFlow(definition, name, { input: Object.fromEntries(Object.entries(flow.input).filter(([k]) => k !== key)) }))}>
                  ✕
                </Button>
              )}
            </div>
            <TypePicker definition={definition} label={`Input ${key}`} value={type} onChange={(next) => next && onChange(updateFlow(definition, name, { input: { ...flow.input, [key]: next } }))} />
          </div>
        ))}
        {readOnly ? null : (
          <div className="flex gap-2">
            <TextInput aria-label="New input" className="w-40 font-mono" placeholder="e.g. claim" value={input} onChange={(e) => setInput(e.target.value.trim())} />
            <Button
              size="sm"
              disabled={!/^[a-z][a-z0-9_]{0,62}$/.test(input) || input in flow.input}
              onClick={() => {
                onChange(updateFlow(definition, name, { input: { ...flow.input, [input]: { type: 'text' } } }));
                setInput('');
              }}
            >
              Add an input
            </Button>
          </div>
        )}
      </div>
      {flowWaits(flow, definition.flows) ? null : (
        <Field label="Result">{() => <TypePicker definition={definition} label="Result" value={flow.output} none="No result" onChange={(output) => onChange(updateFlow(definition, name, { output }))} />}</Field>
      )}
      {readOnly ? null : (
        <Button variant="danger" className="justify-self-start" onClick={onRemove}>
          Delete the flow
        </Button>
      )}
    </Card>
  );
}

/** How a flow that waits starts on a record: the actions that run it, and the roles that may start it by hand. */
function HowItStarts({ definition, name }: { definition: Definition; name: string }) {
  const flow = definition.flows![name]!;
  const subject = flowSubject(flow);
  const actions = Object.values(definition.actions).filter((action) => action.flow?.flow === name);
  const roles = Object.values(definition.roles).filter((role) => role.flows?.includes(name));
  return (
    <Card className="grid gap-2 p-4" aria-label="How it starts">
      <h3 className="m-0 text-base font-semibold">How it starts</h3>
      <p className="m-0 text-sm text-muted">
        This flow waits for people and for time, so it keeps its place on one {subject ? (definition.entities[subject.entity]?.label.toLowerCase() ?? subject.entity) : 'record'}. A bar on the canvas marks each place where it saves before it waits.
      </p>
      {actions.length ? (
        <p className="m-0 text-sm">
          {actions.map((action) => action.label).join(', ')} start{actions.length === 1 ? 's' : ''} it, as {actions.length === 1 ? 'it saves its' : 'they save their'} record.
        </p>
      ) : null}
      {roles.length ? <p className="m-0 text-sm">{roles.map((role) => role.label).join(', ')} may start it on a record by hand.</p> : null}
      {!actions.length && !roles.length ? <Notice tone="warn">Nothing starts it yet: have an action run it, or let a role run it.</Notice> : null}
    </Card>
  );
}

/** Processes from before flows could wait: they still run, and a builder rebuilds each as a flow that waits. */
function EarlierProcesses({ definition, readOnly, onChange }: { definition: Definition; readOnly: boolean; onChange: (definition: Definition) => void }) {
  const processes = Object.entries(definition.processes ?? {});
  if (!processes.length) return null;
  return (
    <Card className="grid gap-2 p-4" aria-label="Processes from before">
      <h3 className="m-0 text-base font-semibold">Processes from before</h3>
      <p className="m-0 text-sm text-muted">This app has processes from before flows could wait. They still run, but a3t no longer draws them: rebuild each as a flow that waits, then remove it.</p>
      {processes.map(([name, process]) => (
        <div key={name} className="flex items-center justify-between gap-2 text-sm">
          <span>{process.label}</span>
          {readOnly ? null : (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const rest = Object.fromEntries(Object.entries(definition.processes ?? {}).filter(([other]) => other !== name));
                const roles = Object.fromEntries(Object.entries(definition.roles).map(([role, spec]) => [role, spec.processes ? { ...spec, processes: spec.processes.filter((each) => each !== name) } : spec]));
                onChange({ ...definition, processes: rest, roles });
              }}
            >
              Remove {process.label}
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}

/** Run the saved flow on real records, and undo what it did: to see what it would do. */
function TryFlow({ appId, definition, name, flow, dirty }: { appId: string; definition: Definition; name: string; flow: AppFlow; dirty: boolean }) {
  const [input, setInput] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: () => {
      const values = Object.fromEntries(
        Object.entries(flow.input).map(([key, type]) => {
          const raw = input[key] ?? '';
          if (type.type === 'number') return [key, Number(raw)];
          if (type.type === 'boolean') return [key, raw === 'true'];
          if (type.type === 'list') return [key, raw.split(',').map((id) => id.trim()).filter(Boolean)];
          return [key, raw];
        }),
      );
      return api.runFlow(appId, name, { input: values, dryRun: true });
    },
  });
  return (
    <Card className="grid gap-3 p-4" aria-label="Try it">
      <h3 className="m-0 text-base font-semibold">Try it</h3>
      <p className="m-0 text-sm text-muted">Runs the saved flow on your sandbox's records, shows what it did, and undoes it.</p>
      {dirty ? <Notice tone="warn">Save your changes first: trying runs the saved flow.</Notice> : null}
      {Object.entries(flow.input).map(([key, type]) =>
        type.type === 'record' ? (
          <RecordPick key={key} appId={appId} definition={definition} input={key} entity={type.entity} value={input[key] ?? ''} onChange={(value) => setInput({ ...input, [key]: value })} />
        ) : (
          <Field key={key} label={`${key} (${typeText(definition, type)})`} hint={type.type === 'list' ? 'Record IDs, separated by commas.' : undefined}>
            {(id) => <TextInput id={id} value={input[key] ?? ''} onChange={(e) => setInput({ ...input, [key]: e.target.value })} />}
          </Field>
        ),
      )}
      <Button variant="primary" className="justify-self-start" disabled={run.isPending || dirty} onClick={() => run.mutate()}>
        {run.isPending ? 'Running…' : 'Try it'}
      </Button>
      {run.error ? <Notice tone="bad">{run.error instanceof ApiError ? run.error.message : 'The flow could not run'}</Notice> : null}
      {run.data ? (
        <div className="grid gap-1 text-sm" aria-label="What it did">
          <p className="m-0">
            It would create {run.data.writes.created}, change {run.data.writes.changed} and delete {run.data.writes.deleted} record(s).
          </p>
          {flow.output ? (
            <p className="m-0">
              Result: <code>{JSON.stringify(run.data.output)}</code>
            </p>
          ) : null}
          {run.data.findings.map((finding, i) => (
            <p key={i} className="m-0 text-warn">
              {finding.message}
            </p>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function RecordPick({ appId, definition, input, entity, value, onChange }: { appId: string; definition: Definition; input: string; entity: string; value: string; onChange: (value: string) => void }) {
  const records = useQuery({ queryKey: ['records', appId, entity, 'pick'], queryFn: () => api.records(appId, entity) });
  const titleField = definition.entities[entity]?.titleField;
  return (
    <Field label={`${input} (${definition.entities[entity]?.label ?? entity})`}>
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Choose a record
          </option>
          {(records.data?.records ?? []).map((record) => (
            <option key={record.id} value={record.id}>
              {titleField && typeof record.values?.[titleField] === 'string' ? String(record.values[titleField]) : record.id}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
