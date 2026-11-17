import {
  conditionText,
  validateDefinition,
  type BoundaryEventElement,
  type Flow,
  type Process,
  type ProcessElement,
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
  addDeadline,
  addElement,
  arrange,
  connect,
  durationOf,
  durationParts,
  durationWords,
  issuesByPart,
  moveElement,
  newProcess,
  PALETTE,
  processEntities,
  removeElement,
  removeFlow,
  removeProcess,
  updateActions,
  updateElement,
  updateFlow,
  updateProcess,
} from '../model/processes.js';
import type { Definition } from '../types.js';

type Selection = { readonly kind: 'element' | 'flow'; readonly id: string } | null;

interface ShapeData extends Record<string, unknown> {
  readonly element: ProcessElement;
  readonly boundaries: ReadonlyArray<{ readonly id: string; readonly element: BoundaryEventElement; readonly left: number }>;
  readonly problems: number;
}
type ShapeNode = Node<ShapeData, 'bpmn'>;

const ICON_PATH: Partial<Record<ProcessElement['type'], string>> = {
  userTask: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 6a5 5 0 0 1 10 0',
  serviceTask: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5 13 13M3 13l1.5-1.5M11.5 4.5 13 3',
  manualTask: 'M4 9V4.5a1 1 0 0 1 2 0V8m0-4a1 1 0 0 1 2 0v4m0-3a1 1 0 0 1 2 0v3m0-2a1 1 0 0 1 2 0v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9',
};

function Clock({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="text-text">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** One element, drawn with BPMN 2.0's shapes: circles for events, rounded boxes for tasks, diamonds for gateways. */
function Shape({ data, selected }: NodeProps<ShapeNode>) {
  const { element, boundaries, problems } = data;
  const ring = selected ? 'ring-2 ring-focus' : '';
  const hasIn = element.type !== 'startEvent';
  const hasOut = element.type !== 'endEvent';
  const label = 'name' in element && element.name ? element.name : undefined;
  const handles = (
    <>
      {hasIn ? <Handle type="target" position={Position.Left} className="!size-2 !border-line-strong !bg-surface" /> : null}
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
        <div className={cx('grid size-9 place-items-center rounded-full bg-surface', end ? 'border-[3px] border-text' : 'border-[1.5px] border-text', ring)}>
          {element.type === 'intermediateCatchEvent' ? (
            <div className="grid size-7 place-items-center rounded-full border border-text">
              <Clock />
            </div>
          ) : null}
          {end && element.terminate ? <div className="size-4 rounded-full bg-text" /> : null}
        </div>
        {label ? <span className="absolute top-10 left-1/2 w-28 -translate-x-1/2 text-center text-[11px] leading-tight text-muted">{label}</span> : null}
        {handles}
        {problem}
      </div>
    );
  }
  if (element.type.endsWith('Gateway')) {
    return (
      <div className="relative grid size-[50px] place-items-center">
        <div className={cx('absolute size-[35px] rotate-45 border-[1.5px] border-text bg-surface', ring)} />
        <span className="relative text-lg font-semibold text-text">{element.type === 'parallelGateway' ? '+' : '×'}</span>
        {label ? <span className="absolute top-[54px] left-1/2 w-28 -translate-x-1/2 text-center text-[11px] leading-tight text-muted">{label}</span> : null}
        {handles}
        {problem}
      </div>
    );
  }
  const icon = ICON_PATH[element.type];
  return (
    <div className={cx('relative h-20 w-[100px] rounded-lg border-[1.5px] border-text bg-surface', ring)}>
      {icon ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="absolute top-1.5 left-1.5 text-muted">
          <path d={icon} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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
      {boundaries.map((boundary) => (
        <div key={boundary.id} className="absolute -bottom-[18px]" style={{ left: boundary.left }} title={`${boundary.element.name ?? 'Deadline'}: ${'duration' in boundary.element.timer ? durationWords(boundary.element.timer.duration) : `on ${boundary.element.timer.date}`}`}>
          <div className={cx('grid size-9 place-items-center rounded-full bg-surface', boundary.element.interrupting ? 'border-[1.5px] border-text' : 'border-[1.5px] border-dashed border-text')}>
            <Clock size={14} />
          </div>
          <Handle id={boundary.id} type="source" position={Position.Bottom} className="!size-2 !border-line-strong !bg-surface" />
        </div>
      ))}
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

function toNodes(process: Process, selection: Selection, problems: ReadonlyMap<string, string[]>): ShapeNode[] {
  const shapes = process.diagram?.shapes ?? {};
  return Object.entries(process.elements)
    .filter(([, element]) => element.type !== 'boundaryEvent')
    .map(([id, element], index) => {
      const shape = shapes[id] ?? { x: 80 + index * 160, y: 100, width: 100, height: 80 };
      const boundaries = Object.entries(process.elements).flatMap(([other, candidate]) =>
        candidate.type === 'boundaryEvent' && candidate.attachedTo === id
          ? [{ id: other, element: candidate, left: Math.max(0, Math.min(82, (shapes[other]?.x ?? shape.x + shape.width - 30) - shape.x)), problems: problems.get(other)?.length ?? 0 }]
          : [],
      );
      const count = (problems.get(id)?.length ?? 0) + boundaries.reduce((sum, boundary) => sum + boundary.problems, 0);
      return {
        id,
        type: 'bpmn' as const,
        position: { x: shape.x, y: shape.y },
        data: { element, boundaries, problems: count },
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

  const add = (type: (typeof PALETTE)[number]['type']) => {
    const options = selection?.kind === 'flow' ? { on: selection.id } : selection?.kind === 'element' ? { after: selection.id } : {};
    const added = addElement(definition, name, type, options);
    onChange(added.definition);
    setSelection({ kind: 'element', id: added.id });
  };
  const noRoles = !Object.keys(definition.roles).length;

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
            {PALETTE.map((item, index) => (
              <div key={item.type} className="contents">
                {item.more && !PALETTE[index - 1]?.more ? <p className="m-0 mt-2 text-xs text-muted">More BPMN</p> : null}
                <Button size="sm" className="justify-start" title={item.type === 'userTask' && noRoles ? 'Add a role first: a role does each task' : item.hint} onClick={() => add(item.type)} disabled={item.type === 'userTask' && noRoles}>
                  {item.label}
                </Button>
              </div>
            ))}
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
  const [nodes, setNodes] = useState<ShapeNode[]>(() => toNodes(process, selection, problems));
  useEffect(() => setNodes(toNodes(process, selection, problems)), [process, selection, problems]);
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
        onNodeDragStop={(_event, node) => onChange(moveElement(definition, name, node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }))}
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
  intermediateCatchEvent: 'Timer',
  boundaryEvent: 'Deadline',
};

function ElementPanel(props: {
  definition: Definition;
  name: string;
  id: string;
  element: ProcessElement;
  problems: ReadonlyMap<string, string[]>;
  onChange: (definition: Definition) => void;
  onSelect: (selection: Selection) => void;
  readOnly: boolean;
}) {
  const { definition, name, id, element, problems, onChange, onSelect, readOnly } = props;
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
  const deadlines = Object.entries(process.elements).flatMap(([other, candidate]) => (candidate.type === 'boundaryEvent' && candidate.attachedTo === id ? [[other, candidate] as const] : []));

  return (
    <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{TYPE_LABELS[element.type]}</h3>
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
      {element.type === 'startEvent' ? (
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
      ) : null}
      {element.type === 'endEvent' ? (
        <Checkbox label="End the whole process here, other paths too" checked={element.terminate} onChange={(terminate) => set((current) => ({ ...current, terminate }) as ProcessElement)} />
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
          <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
            <legend className="px-1 text-sm text-muted">Deadlines</legend>
            {deadlines.map(([deadline, timer]) => (
              <div key={deadline} className="grid gap-1.5 rounded-md bg-sunken p-2">
                <Problems messages={problems.get(deadline)} />
                {'duration' in timer.timer ? (
                  <DurationInput label="After" value={timer.timer.duration} onChange={(duration) => onChange(updateElement(definition, name, deadline, (current) => ({ ...current, timer: { duration } }) as ProcessElement))} />
                ) : (
                  <p className="m-0 text-sm">On the record's {timer.timer.date}</p>
                )}
                <Checkbox
                  label="It takes the task away"
                  checked={timer.interrupting}
                  onChange={(interrupting) => onChange(updateElement(definition, name, deadline, (current) => ({ ...current, interrupting }) as ProcessElement))}
                />
                <Remove onClick={() => onChange(removeElement(definition, name, deadline))}>Remove the deadline</Remove>
              </div>
            ))}
            <Button size="sm" onClick={() => onChange(addDeadline(definition, name, id).definition)}>
              Add a deadline
            </Button>
            <p className="m-0 text-xs text-muted">Drag from a deadline's clock to lead its path elsewhere, such as to a task for someone else.</p>
          </fieldset>
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
      {element.type === 'intermediateCatchEvent' ? (
        <>
          <Field label="Wait">
            {(inputId) => (
              <Select
                id={inputId}
                value={'duration' in element.timer ? 'duration' : 'date'}
                onChange={(event) => set((current) => ({ ...current, timer: event.target.value === 'date' && dates[0] ? { date: dates[0].name } : { duration: 'P1D' } }) as ProcessElement)}
              >
                <option value="duration">For a time</option>
                <option value="date" disabled={!dates.length}>
                  Until a date of the record
                </option>
              </Select>
            )}
          </Field>
          {'duration' in element.timer ? (
            <DurationInput label="For" value={element.timer.duration} onChange={(duration) => set((current) => ({ ...current, timer: { duration } }) as ProcessElement)} />
          ) : (
            <Field label="Until">
              {(inputId) => (
                <Select id={inputId} value={'date' in element.timer ? element.timer.date : ''} onChange={(event) => set((current) => ({ ...current, timer: { date: event.target.value } }) as ProcessElement)}>
                  {dates.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </>
      ) : null}
      {element.type === 'exclusiveGateway' ? <p className="m-0 text-sm text-muted">Select a flow out of it to set when it is taken. The first flow whose condition holds is taken, or the one marked Otherwise.</p> : null}
      {element.type === 'parallelGateway' ? <p className="m-0 text-sm text-muted">Every flow out of it is taken at once. With several flows in, it waits for a token from each.</p> : null}
      {'description' in element || element.type.endsWith('Task') || element.type === 'task' ? (
        <Field label="Description">
          {(inputId) => (
            <textarea
              id={inputId}
              rows={2}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
              value={'description' in element ? (element.description ?? '') : ''}
              onChange={(event) =>
                set((current) => {
                  if (!('description' in current) && !current.type.endsWith('Task') && current.type !== 'task') return current;
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
          Remove {TYPE_LABELS[element.type].toLowerCase()}
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
      {from?.type === 'exclusiveGateway' ? (
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
