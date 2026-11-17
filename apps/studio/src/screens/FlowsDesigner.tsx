import type { AppFlow, FlowStep, FlowType, VarKind } from '@platform/app-model';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.js';
import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { Button, Card, Checkbox, cx, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { recordChoices, type RefChoice } from '../model/conditions.js';
import {
  addFlow,
  flowEntities,
  insertStep,
  layoutFlow,
  listChoices,
  moveStep,
  newStep,
  recordVariables,
  removeFlow,
  removeStep,
  replaceStep,
  scopeAt,
  STEP_NAMES,
  STEP_TYPES,
  stepAt,
  typeText,
  updateFlow,
  variableChoices,
  type CanvasEdge,
  type CanvasNode,
  type StepType,
} from '../model/flows.js';
import type { Definition, Field as FieldDef } from '../types.js';
import { ValueEditor, type ValueMode, type ValueSources } from './StepsEditor.js';

/*
 * The flow designer (design §6.2). A flow's steps go down the canvas, as a Mendix microflow's do;
 * each arrow takes a new step, and each step opens on the right. "Try it" runs the saved flow on
 * real records, and undoes what it did.
 */

type Props = { appId: string; definition: Definition; onChange: (definition: Definition) => void; readOnly?: boolean; dirty?: boolean };

/** The edge colour of a step's box: green for new records, blue for others, red for deletes, amber for checks. */
const STEP_EDGES: Readonly<Record<StepType, string>> = {
  set: 'border-l-line-strong',
  find: 'border-l-accent',
  create: 'border-l-good',
  change: 'border-l-accent',
  delete: 'border-l-bad',
  add_line: 'border-l-accent',
  each: 'border-l-line-strong',
  if: 'border-l-warn',
  check: 'border-l-warn',
  call: 'border-l-line-strong',
  try: 'border-l-line-strong',
  total: 'border-l-line-strong',
  return: 'border-l-line-strong',
};

export function FlowsDesigner({ appId, definition, onChange, readOnly = false, dirty = false }: Props) {
  const flows = definition.flows ?? {};
  const names = Object.keys(flows);
  const [chosen, setChosen] = useState<string | null>(names[0] ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ list: string; index: number } | null>(null);
  const [label, setLabel] = useState('');
  const name = chosen && flows[chosen] ? chosen : (names[0] ?? null);
  const flow = name ? flows[name] : undefined;
  const select = (path: string | null) => {
    setSelected(path);
    setAdding(null);
  };

  return (
    <div className="grid gap-4 @min-[62rem]:grid-cols-[14rem_minmax(0,1fr)_22rem]">
      <Card className="grid content-start gap-3 self-start p-4">
        <h2 className="m-0 text-sm font-semibold text-muted">Flows</h2>
        {names.length ? (
          <ul className="m-0 grid list-none gap-1 p-0">
            {names.map((each) => (
              <li key={each}>
                <button
                  type="button"
                  aria-current={each === name ? 'true' : undefined}
                  className={cx('w-full rounded-md px-3 py-2 text-left', each === name ? 'bg-accent-soft' : 'hover:bg-sunken')}
                  onClick={() => {
                    setChosen(each);
                    select(null);
                  }}
                >
                  <span className="block font-medium">{flows[each]!.label}</span>
                  <span className="block font-mono text-xs text-muted">{each}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted">No flows yet. A flow is the app's logic: it finds, creates and changes records, loops and decides, in one go.</p>
        )}
        {readOnly ? null : (
          <form
            className="grid gap-2"
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
            <TextInput aria-label="New flow" placeholder="New flow, e.g. Record the spend" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Button type="submit" disabled={!label.trim()}>
              Add flow
            </Button>
          </form>
        )}
      </Card>

      {flow && name ? (
        <>
          <Card className="min-w-0 self-start p-2">
            <FlowCanvas
              key={name}
              definition={definition}
              flow={flow}
              selected={selected}
              readOnly={readOnly}
              onSelect={select}
              onInsert={(place) => {
                setSelected(null);
                setAdding(place);
              }}
            />
          </Card>
          <div className="grid content-start gap-4">
            {adding && !readOnly ? (
              <AddStep
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
                <TryFlow appId={appId} definition={definition} name={name} flow={flow} dirty={dirty} />
              </>
            )}
          </div>
        </>
      ) : (
        <div className="@min-[62rem]:col-span-2">
          <EmptyState title="Add a flow to design it">Flows hold the app's logic, as Mendix microflows do. Actions and process tasks run them, and so can roles, through the API.</EmptyState>
        </div>
      )}
    </div>
  );
}

// ---- The canvas

type StepNodeData = { node: CanvasNode; selected: boolean; readOnly: boolean; onInsert: (place: { list: string; index: number }) => void };
type CanvasFlowNode = Node<StepNodeData>;
type EdgeData = { edge: CanvasEdge; readOnly: boolean; onInsert: (place: { list: string; index: number }) => void };

const handle = '!size-2 !border-line-strong !bg-surface';

function StepNode({ data }: NodeProps<CanvasFlowNode>) {
  const { node, selected } = data;
  const step = node.step!;
  return (
    <div
      className={cx(
        'flex h-full w-full flex-col justify-center rounded-md border border-l-4 bg-surface px-3 shadow-sm',
        step.type === 'try' || step.type === 'each' ? 'border-line-strong' : 'border-line',
        STEP_EDGES[step.type],
        selected && 'ring-2 ring-focus',
      )}
      data-testid={`flow-step-${node.path}`}
    >
      <Handle type="target" position={Position.Top} className={handle} />
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{STEP_NAMES[step.type]}</span>
      <span className="truncate text-sm" title={node.label}>
        {node.label}
      </span>
      <Handle type="source" position={Position.Bottom} className={handle} />
      {step.type === 'try' ? <Handle id="fail" type="source" position={Position.Right} className={handle} /> : null}
    </div>
  );
}

function DecisionNode({ data }: NodeProps<CanvasFlowNode>) {
  const { node, selected } = data;
  return (
    <div className="relative flex h-full w-full items-center gap-3" data-testid={`flow-step-${node.path}`}>
      <Handle type="target" position={Position.Top} className={handle} />
      <div className={cx('size-10 shrink-0 rotate-45 rounded-[3px] border-[1.5px] border-text bg-surface', selected && 'ring-2 ring-focus')} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm" title={node.label}>
        {node.label}
      </span>
      <Handle id="yes" type="source" position={Position.Bottom} className={handle} />
      <Handle id="no" type="source" position={Position.Right} className={handle} />
    </div>
  );
}

function EventNode({ data }: NodeProps<CanvasFlowNode>) {
  const end = data.node.kind === 'end';
  return (
    <div className={cx('size-9 rounded-full bg-surface', end ? 'border-[3px] border-text' : 'border-[1.5px] border-text')} aria-label={end ? 'End' : 'Start'}>
      {end ? <Handle type="target" position={Position.Top} className={handle} /> : <Handle type="source" position={Position.Bottom} className={handle} />}
    </div>
  );
}

function JoinNode() {
  return (
    <div className="size-3 rounded-full bg-line-strong">
      <Handle type="target" position={Position.Top} className="!size-1 !opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!size-1 !opacity-0" />
      <Handle id="next" type="source" position={Position.Left} className="!size-1 !opacity-0" />
    </div>
  );
}

function SlotNode({ data }: NodeProps<CanvasFlowNode>) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-md border border-dashed border-line-strong">
      <Handle type="target" position={Position.Top} className="!size-1 !opacity-0" />
      {data.readOnly ? (
        <span className="text-xs text-faint">No steps</span>
      ) : (
        <Button size="sm" variant="ghost" className="nodrag" onClick={() => data.onInsert({ list: data.node.list!, index: 0 })}>
          Add a step here
        </Button>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-1 !opacity-0" />
    </div>
  );
}

function FrameNode({ data }: NodeProps<CanvasFlowNode>) {
  const step = data.node.step!;
  return <div className={cx('h-full w-full rounded-lg border bg-sunken/40', step.type === 'try' ? 'border-dashed border-line-strong' : 'border-line')} aria-hidden />;
}

function StepEdge(props: EdgeProps<Edge<EdgeData>>) {
  const { data } = props;
  const [path, labelX, labelY] = getSmoothStepPath({ ...props, borderRadius: 6 });
  const edge = data?.edge;
  return (
    <>
      <BaseEdge path={path} {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})} style={edge?.back ? { strokeDasharray: '4 4' } : undefined} />
      <EdgeLabelRenderer>
        <div className="nodrag nopan absolute flex items-center gap-1" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}>
          {edge?.label ? <span className="rounded-sm bg-surface px-1 text-[11px] text-muted">{edge.label}</span> : null}
          {edge?.insert && !data?.readOnly ? (
            <button
              type="button"
              className="grid size-5 place-items-center rounded-full border border-line-strong bg-surface text-xs leading-none text-muted hover:border-accent hover:text-accent"
              aria-label={`Add a step at ${edge.insert.list}[${edge.insert.index}]`}
              title="Add a step here"
              onClick={() => data?.onInsert(edge.insert!)}
            >
              +
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const NODE_TYPES = { step: StepNode, decision: DecisionNode, start: EventNode, end: EventNode, join: JoinNode, slot: SlotNode, frame: FrameNode };
const EDGE_TYPES = { step: StepEdge };

function FlowCanvas(props: {
  definition: Definition;
  flow: AppFlow;
  selected: string | null;
  readOnly: boolean;
  onSelect: (path: string | null) => void;
  onInsert: (place: { list: string; index: number }) => void;
}) {
  const { definition, flow, selected, readOnly, onSelect, onInsert } = props;
  const laid = useMemo(() => layoutFlow(definition, flow), [definition, flow]);
  // As steps come and go, the view fits the flow again: a new step is never out of sight.
  const [view, setView] = useState<ReactFlowInstance<CanvasFlowNode, Edge<EdgeData>> | null>(null);
  const count = laid.nodes.length;
  useEffect(() => {
    void view?.fitView({ padding: 0.15, maxZoom: 1 });
  }, [view, count]);
  const nodes: CanvasFlowNode[] = laid.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: { x: node.x, y: node.y },
    data: { node, selected: node.path !== undefined && node.path === selected && node.kind !== 'frame', readOnly, onInsert },
    draggable: false,
    connectable: false,
    selectable: false,
    style: { width: node.width, height: node.height },
    zIndex: node.kind === 'frame' ? -1 : 1,
  }));
  const edges: Edge<EdgeData>[] = laid.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    type: 'step',
    data: { edge, readOnly, onInsert },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  }));
  return (
    <div className="h-[34rem]" data-testid="flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        onInit={setView}
        minZoom={0.3}
        onNodeClick={(_event, node) => {
          const path = node.data.node.path;
          if (path && node.data.node.kind !== 'frame') onSelect(path);
        }}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// ---- Adding and editing steps

function AddStep({ onAdd, onCancel }: { onAdd: (type: StepType) => void; onCancel: () => void }) {
  return (
    <Card className="grid gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-base font-semibold">Add a step</h3>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {STEP_TYPES.map((type) => (
          <Button key={type} size="sm" onClick={() => onAdd(type)}>
            {STEP_NAMES[type]}
          </Button>
        ))}
      </div>
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

function StepEditor(props: { definition: Definition; name: string; path: string; readOnly: boolean; onChange: (definition: Definition) => void; onRemoved: () => void; onMoved: (path: string) => void }) {
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
      const output = definition.flows?.[name]?.output;
      if (!output) return <p className="m-0 text-sm text-muted">The flow ends here. It gives no result: give it one in its settings.</p>;
      return <InputValue definition={definition} input="Result" type={output} value={step.value} scope={scope} sources={sources} onChange={(value) => set({ ...step, value })} />;
    }
  }
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
      <Field label="Result">{() => <TypePicker definition={definition} label="Result" value={flow.output} none="No result" onChange={(output) => onChange(updateFlow(definition, name, { output }))} />}</Field>
      {readOnly ? null : (
        <Button variant="danger" className="justify-self-start" onClick={onRemove}>
          Delete the flow
        </Button>
      )}
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
