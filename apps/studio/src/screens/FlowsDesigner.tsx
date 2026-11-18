import { type AppFlow, type FlowStep, flowSubject, flowWaits } from '@platform/app-model';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useProblems } from '../components/problems.js';
import { Button, Card, EmptyState, Modes, TextInput } from '../components/ui.js';
import {
  addFlow,
  canWait,
  insertStep,
  moveStepTo,
  newStep,
  problemsByStep,
  removeFlow,
  removeStep,
  STEP_NAMES,
  scopeAt,
  splitPath,
  stepAt,
  stepWords,
} from '../model/flows.js';
import type { Definition } from '../types.js';
import { FlowCanvas, type Place } from './FlowCanvas.js';
import { FlowCases } from './FlowCases.js';
import { FlowListing } from './FlowListing.js';
import { EarlierProcesses, FlowSettings } from './FlowSettings.js';
import { HowItStarts } from './FlowStarts.js';
import { AddStep, StepEditor } from './StepEditor.js';
import { TryFlow } from './TryFlow.js';

/*
 * The flow designer (design §6.2, §6.11). A flow's steps go left to right across the canvas, as a
 * Mendix microflow's do; each arrow takes a new step, and each step opens on the right. A flow
 * that waits is built the same way, with people's tasks, waits, and ways at once. "Try it" runs a
 * saved flow that runs in one go on real records, and undoes what it did.
 */

type Props = {
  appId: string;
  definition: Definition;
  onChange: (definition: Definition) => void;
  readOnly?: boolean;
  dirty?: boolean;
  /** The flow to show first, as a link names it. */
  open?: string;
};

export function FlowsDesigner({ appId, definition, onChange, readOnly = false, dirty = false, open }: Props) {
  const flows = definition.flows ?? {};
  const names = Object.keys(flows);
  const [chosen, setChosen] = useState<string | null>(open ?? names[0] ?? null);
  useEffect(() => {
    if (open) setChosen(open);
  }, [open]);
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
  // The draft's problems in this flow, by the step each is about.
  const problems = useProblems();
  const byStep = useMemo(() => (flow && name ? problemsByStep(flow, name, problems) : new Map<string, string[]>()), [flow, name, problems]);
  const select = (path: string | null) => {
    setSelected(path);
    setAdding(null);
  };
  // The step whose cases are open, from its live count.
  const [cases, setCases] = useState<string | null>(null);
  // A step copied or cut, to paste after a step, or where a new step would go.
  const [copied, setCopied] = useState<FlowStep | null>(null);
  const copy = () => {
    const step = flow && selected ? stepAt(flow, selected) : undefined;
    if (step) setCopied(structuredClone(step));
  };
  const cut = () => {
    if (!name || !selected) return;
    copy();
    onChange(removeStep(definition, name, selected));
    select(null);
  };
  const paste = (place: Place) => {
    if (!name || !copied) return;
    onChange(insertStep(definition, name, place.list, place.index, structuredClone(copied)));
    setAdding(null);
    setSelected(`${place.list}[${place.index}]`);
  };
  const pasteAfter = () => {
    if (!selected) return;
    const { list, index } = splitPath(selected);
    paste({ list, index: index + 1 });
  };
  const move = (from: string, to: Place) => {
    const moved = name ? moveStepTo(definition, name, from, to) : null;
    if (!moved) return;
    onChange(moved.definition);
    select(moved.path);
  };
  // Ctrl or Cmd with C, X or V copies, cuts and pastes the chosen step, when no text is chosen instead.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (window.getSelection()?.toString()) return;
      const key = event.key.toLowerCase();
      if (key === 'c' && selected) copy();
      else if (key === 'x' && selected) cut();
      else if (key === 'v' && copied && adding) paste(adding);
      else if (key === 'v' && copied && selected) pasteAfter();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
            <Modes label="Show">
              <button type="button" aria-pressed={!liveOn} onClick={() => setLiveOn(false)}>
                Design
              </button>
              <button type="button" aria-pressed={liveOn} onClick={() => setLiveOn(true)}>
                Live
              </button>
            </Modes>
          ) : null}
          {liveNow ? (
            <span className="text-xs text-muted">
              {liveNow.running} running{dirty ? ' · as saved' : ''}
            </span>
          ) : null}
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
              <TextInput
                aria-label="New flow"
                className="w-56"
                placeholder="New flow, e.g. Record the spend"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
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
            problems={byStep}
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
            problems={byStep}
            folded={folded}
            onFold={fold}
            onSelect={select}
            onMove={move}
            onCases={setCases}
            onShow={setShow}
            onInsert={(place) => {
              setSelected(null);
              setAdding(place);
            }}
          />
        ) : (
          <div className="flow grid h-[40rem] place-items-center p-6">
            <EmptyState title="Add a flow to design it">
              A flow is what happens in an app: it finds, creates and changes records, decides and loops, as a Mendix microflow does. It can wait for people and
              for time too. Actions run flows, and so can roles, through the API.
            </EmptyState>
          </div>
        )}
      </Card>
      {flow && name ? (
        <div className="grid content-start gap-4">
          {cases && liveNow && flowSubject(flow) ? (
            <FlowCases
              appId={appId}
              definition={definition}
              flow={name}
              entity={flowSubject(flow)!.entity}
              path={cases}
              step={stepAt(flow, cases) ? stepWords(definition, stepAt(flow, cases)!, flowSubject(flow)!.entity).words : cases}
              onClose={() => setCases(null)}
            />
          ) : null}
          {adding && !readOnly ? (
            <AddStep
              waits={canWait(flow) && !insideLoop(flow, adding.list)}
              copied={copied ? STEP_NAMES[copied.type] : null}
              onPaste={() => paste(adding)}
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
              problems={byStep.get(selected) ?? []}
              readOnly={readOnly}
              copied={Boolean(copied)}
              onCopy={copy}
              onCut={cut}
              onPasteAfter={pasteAfter}
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
              <HowItStarts appId={appId} definition={definition} name={name} readOnly={readOnly} dirty={dirty} onChange={onChange} />
              {flowWaits(flow, definition.flows) ? null : <TryFlow appId={appId} definition={definition} name={name} flow={flow} dirty={dirty} />}
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

/** Whether a list of steps is inside a loop over a list, an error handler or a reminder, where a flow can't wait. */
function insideLoop(flow: AppFlow, list: string): boolean {
  if (list.includes('.reminders[')) return true;
  const holders = [...list.matchAll(/\]/g)].map((match) => list.slice(0, match.index + 1));
  return holders.some((holder) => {
    const type = /\]$/.test(holder) && /^steps(\[\d+\]\.[a-z_]+)*\[\d+\]$/.test(holder) ? stepAt(flow, holder)?.type : undefined;
    return type === 'each' || type === 'try';
  });
}

// ---- The canvas: a3t's flows as Ocean's LogicNode draws them (sreent/ocean, components/LogicNode)
