import { type AppFlow, type FlowStep, flowSubject } from '@platform/app-model';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icon.js';
import { Button, cx } from '../components/ui.js';
import { labelledLists, liveWords, startsWords, stepWords } from '../model/flows.js';
import type { Definition, FlowLive } from '../types.js';
import { FRAME_ICONS, type Place, ShowAs, STEP_ICONS } from './FlowCanvas.js';

/* A flow as a list: a line for each step, set in as the canvas nests it. */

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
export function FlowListing(props: {
  definition: Definition;
  flow: AppFlow;
  selected: string | null;
  readOnly: boolean;
  live: FlowLive | undefined;
  problems: ReadonlyMap<string, string[]>;
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
            <button
              type="button"
              className={cx('flow-row', words.tone)}
              aria-expanded={selected === path}
              onClick={() => onSelect(path)}
              data-testid={`flow-row-${path}`}
            >
              <Icon name={iconOf(step)} />
              <span className="flow-row-text">
                <span className="flow-row-name">{words.words}</span>
                <span className="flow-row-about">
                  {words.kind}
                  {words.about ? ` · ${words.about}` : ''}
                </span>
              </span>
              {now ? <span className="flow-row-end">{liveWords(now)}</span> : null}
              {props.problems.get(path)?.length ? (
                <span className="flow-row-end text-bad">
                  {props.problems.get(path)!.length === 1 ? '1 problem' : `${props.problems.get(path)!.length} problems`}
                </span>
              ) : null}
            </button>
            {labelledLists(definition, step, path, entity).map((inner) => (
              <div key={inner.path} className="ms-6 grid gap-1">
                <span className="text-xs font-semibold text-muted">{inner.label}</span>
                {inner.steps.length ? rows(inner.steps, inner.path) : null}
                {readOnly ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="justify-self-start"
                    aria-label={`Add a step at ${inner.path}[${inner.steps.length}]`}
                    onClick={() => onInsert({ list: inner.path, index: inner.steps.length })}
                  >
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
    <section className="flow-listing h-[40rem] overflow-auto pt-16" aria-label={`${flow.label}, as a list`}>
      <ShowAs show="list" onShow={props.onShow} />
      <section>
        <h2>What starts it</h2>
        <p className="m-0 text-sm text-muted">
          {starts.length
            ? `${starts.map((action) => action.label).join(', ')}, as it saves its record`
            : `An action, a role or another flow that runs it${Object.keys(flow.input).length ? `, with ${Object.keys(flow.input).join(', ')}` : ''}`}
        </p>
        {flow.schedule || flow.starts?.length ? <p className="m-0 text-sm text-muted">It also starts by itself: {startsWords(definition, flow)}.</p> : null}
      </section>
      <section>
        <h2>Its steps, in order</h2>
        {flow.steps.length ? rows(flow.steps, 'steps') : <p className="m-0 text-sm text-faint">No steps yet.</p>}
        {readOnly ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            aria-label={`Add a step at steps[${flow.steps.length}]`}
            onClick={() => onInsert({ list: 'steps', index: flow.steps.length })}
          >
            + Add a step
          </Button>
        )}
      </section>
    </section>
  );
}

// ---- Adding and editing steps
