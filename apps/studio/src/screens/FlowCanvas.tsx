import type { AppFlow } from '@platform/app-model';
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '../components/icon.js';
import { Button, cx, Modes } from '../components/ui.js';
import { type CanvasEdge, type CanvasNode, canMoveTo, layoutFlow, liveWords, type StepType } from '../model/flows.js';
import type { Definition, FlowLive } from '../types.js';

/* A flow on its canvas (design §6.11): its steps left to right, where the layout places them, in Ocean's grammar. A
   step moves when someone drags it onto an arrow. */

export type Place = { list: string; index: number };

export type Live = FlowLive['steps'][number];

type NodeData = {
  node: CanvasNode;
  selected: boolean;
  readOnly: boolean;
  live?: Live | undefined;
  /** What the checks find wrong with the step, as the builder changes it. */
  problems?: readonly string[] | undefined;
  /** For a way with no steps: a dragged step goes into it if it's dropped now. */
  drop?: boolean;
  /** Live: open the cases that wait at the step. */
  onCases?: ((path: string) => void) | undefined;
  onInsert: (place: Place) => void;
  onSelect: (path: string) => void;
  onFold: (path: string) => void;
};

type FlowNode = Node<NodeData>;

type WireData = { edge: CanvasEdge; readOnly: boolean; onInsert: (place: Place) => void; drop?: boolean };

/** Each kind of step's icon: Ocean's, in the colour of what the step does. */
export const STEP_ICONS: Readonly<Partial<Record<StepType, IconName>>> = {
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
  inform: 'bell',
  call_service: 'plug',
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
      <LiveChip live={data.live} onOpen={data.onCases && data.node.path ? () => data.onCases!(data.node.path!) : undefined} />
      <ProblemCount problems={data.problems} />
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
    <div
      className={cx('logic-decision', node.kind === 'merge' && 'merge', selected && 'chosen')}
      data-testid={node.path ? `flow-step-${node.path}` : undefined}
    >
      <i />
      {node.kind === 'decision' ? (
        <span className="logic-caption above">
          <strong>{node.label}</strong>
        </span>
      ) : null}
      <ProblemCount problems={data.problems} />
      <Handles />
    </div>
  );
}

function RingNode({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  return (
    <div
      className={cx('logic-ring', node.kind === 'end' && 'end', selected && 'ring-2 ring-focus')}
      role="img"
      aria-label={node.about ? `${node.label}: ${node.about}` : node.label}
    >
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
    <div
      className={cx('logic-ring wait', selected && 'ring-2 ring-focus')}
      role="img"
      aria-label={node.about ? `${node.label}: ${node.about}` : node.label}
      data-testid={`flow-wait-${node.id}`}
    >
      <Icon name={node.icon ?? 'clock'} />
      <span className={cx('logic-caption', node.caption ?? 'above')}>
        <strong>{node.label}</strong>
        {node.about ? <span>{node.about}</span> : null}
      </span>
      <LiveChip live={data.live} onOpen={data.onCases && data.node.path ? () => data.onCases!(data.node.path!) : undefined} />
      <ProblemCount problems={data.problems} />
      <Handles />
    </div>
  );
}

/** In a step's corner, as Ocean's LogicNode draws it: how many problems the checks find in it, each said when pointed at. */
function ProblemCount({ problems }: { problems: readonly string[] | undefined }) {
  if (!problems?.length) return null;
  const words = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
  return (
    <span className="flow-problems" role="img" aria-label={`${words}: ${problems.join('; ')}`} title={problems.join('\n')}>
      {problems.length}
    </span>
  );
}

/** Live: how many cases wait at a step, how many are stuck there, and the longest wait; a button that opens the cases. */
function LiveChip({ live, onOpen }: { live: Live | undefined; onOpen?: (() => void) | undefined }) {
  if (!live) return null;
  const look = cx('logic-live', live.stuck > 0 && 'text-bad');
  if (!onOpen) return <span className={look}>{liveWords(live)}</span>;
  return (
    <button
      type="button"
      className={cx(look, 'nodrag cursor-pointer border-0')}
      aria-label={`${liveWords(live)}: show the cases`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {liveWords(live)}
    </button>
  );
}

export const FRAME_ICONS: Readonly<Partial<Record<StepType, IconName>>> = {
  each: 'sync',
  repeat: 'sync',
  try: 'guard',
  first_of: 'wait',
  all_at_once: 'studio',
};

function FrameNode({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  return (
    <div className={cx('logic-frame', selected && 'ring-2 ring-focus')}>
      {/* Its words stop short of the fold button, and say the rest when pointed at. */}
      <button
        type="button"
        className="logic-frame-head nodrag max-w-[calc(100%-4rem)] overflow-hidden"
        title={node.about ? `${node.label} · ${node.about}` : node.label}
        onClick={() => node.path && data.onSelect(node.path)}
        data-testid={`flow-step-${node.path}`}
      >
        <Icon name={FRAME_ICONS[node.step?.type ?? 'each'] ?? 'sync'} />
        <span className="truncate">
          {node.label}
          {node.about ? <span className="note"> · {node.about}</span> : null}
        </span>
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
      <LiveChip live={data.live} onOpen={data.onCases && data.node.path ? () => data.onCases!(data.node.path!) : undefined} />
      <ProblemCount problems={data.problems} />
    </div>
  );
}

function SlotNode({ data }: NodeProps<FlowNode>) {
  return (
    <div
      className={cx('grid h-full w-full place-items-center rounded-md border border-dashed', data.drop ? 'border-accent bg-accent-soft' : 'border-line-strong')}
      data-testid={`flow-slot-${data.node.list}`}
    >
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
  const { edge, readOnly, onInsert, drop } = data;
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
            className={cx(
              'logic-add nodrag nopan opacity-0 transition-opacity group-hover/canvas:opacity-70 hover:!opacity-100 focus-visible:!opacity-100',
              drop && 'drop',
            )}
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

const NODE_TYPES = {
  step: StepNode,
  decision: DecisionNode,
  merge: DecisionNode,
  start: RingNode,
  end: RingNode,
  frame: FrameNode,
  slot: SlotNode,
  port: PortNode,
  wait: WaitNode,
};

const EDGE_TYPES = { wire: WireEdge };

/** Canvas or List: the choice of views, at the right of the canvas's foot and at the top of the list. */
export function ShowAs({ show, onShow }: { show: 'canvas' | 'list'; onShow: (show: 'canvas' | 'list') => void }) {
  return (
    <Modes label="Show it as">
      <button type="button" aria-pressed={show === 'canvas'} onClick={() => onShow('canvas')}>
        Canvas
      </button>
      <button type="button" aria-pressed={show === 'list'} onClick={() => onShow('list')}>
        List
      </button>
    </Modes>
  );
}

export function FlowCanvas(props: {
  definition: Definition;
  flow: AppFlow;
  selected: string | null;
  readOnly: boolean;
  live: FlowLive | undefined;
  problems: ReadonlyMap<string, string[]>;
  folded: ReadonlySet<string>;
  onFold: (path: string) => void;
  onSelect: (path: string | null) => void;
  onMove: (from: string, to: Place) => void;
  onCases: (path: string) => void;
  onShow: (show: 'canvas' | 'list') => void;
  onInsert: (place: Place) => void;
}) {
  const { definition, flow, selected, readOnly, live, folded, onFold, onSelect, onInsert } = props;
  // A step being dragged: where it is now, and the place it goes to if it's dropped.
  const [drag, setDrag] = useState<{ readonly id: string; readonly x: number; readonly y: number } | null>(null);
  const [dropAt, setDropAt] = useState<Place | null>(null);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new layout fits the view again
  useEffect(() => {
    void view?.fitView({ padding: 0.08, maxZoom: 1 });
  }, [view, laid]);
  // Where a step can be dropped: each arrow's "+", and each way with no steps.
  const places = useMemo(
    () => [
      ...laid.edges.flatMap((edge) => (edge.insert ? [{ list: edge.insert.list, index: edge.insert.index, x: edge.insert.x, y: edge.insert.y }] : [])),
      ...laid.nodes.flatMap((node) =>
        node.kind === 'slot' && node.list ? [{ list: node.list, index: 0, x: node.x + node.width / 2, y: node.y + node.height / 2 }] : [],
      ),
    ],
    [laid],
  );
  const dropFor = (path: string, x: number, y: number): Place | null => {
    let best: { place: Place; distance: number } | null = null;
    for (const place of places) {
      const distance = Math.hypot(place.x - x, place.y - y);
      if (distance <= DROP_RADIUS && (!best || distance < best.distance) && canMoveTo(path, place))
        best = { place: { list: place.list, index: place.index }, distance };
    }
    return best?.place ?? null;
  };
  const movable = (node: (typeof laid.nodes)[number]) =>
    !readOnly && node.path !== undefined && node.id === node.path && (node.kind === 'step' || node.kind === 'wait' || node.kind === 'decision');
  const nodes: FlowNode[] = laid.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: drag?.id === node.id ? { x: drag.x, y: drag.y } : { x: node.x, y: node.y },
    data: {
      node,
      selected: node.path !== undefined && node.path === selected,
      readOnly,
      live: node.id === node.path ? liveAt.get(node.id) : undefined,
      problems: node.id === node.path && node.path !== undefined ? props.problems.get(node.path) : undefined,
      drop: node.kind === 'slot' && dropAt?.list === node.list,
      onCases: props.onCases,
      onInsert,
      onSelect,
      onFold,
    },
    draggable: movable(node),
    connectable: false,
    selectable: false,
    // React Flow draws an edge only between nodes with a size: a port gets a pixel.
    style: { width: Math.max(1, node.width), height: Math.max(1, node.height) },
    zIndex: node.kind === 'frame' ? -1 : 1,
  }));
  const edges: Edge<WireData>[] = laid.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'wire',
    data: { edge, readOnly, onInsert, drop: Boolean(dropAt && edge.insert && edge.insert.list === dropAt.list && edge.insert.index === dropAt.index) },
  }));
  // React Flow says where a dragged step is; the flow's own layout places every other.
  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue;
      const node = laid.nodes.find((each) => each.id === change.id);
      if (!node?.path) continue;
      setDrag({ id: change.id, x: change.position.x, y: change.position.y });
      setDropAt(dropFor(node.path, change.position.x + node.width / 2, change.position.y + node.height / 2));
    }
  };
  return (
    <div ref={setBox} className="group/canvas flow flow-canvas h-[40rem]" data-testid="flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={!readOnly}
        nodeDragThreshold={6}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_event, node) => {
          const path = node.data.node.path;
          if (path && dropAt) props.onMove(path, dropAt);
          setDrag(null);
          setDropAt(null);
        }}
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
      ></ReactFlow>
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

/** How near the "+" of an arrow a dragged step's middle must be for a drop to go there, on the canvas's scale. */
const DROP_RADIUS = 70;
