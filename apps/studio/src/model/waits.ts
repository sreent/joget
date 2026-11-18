import { type FlowStep, flowSubject, type WaitFor, withLists } from '@platform/app-model';
import type { Definition } from '../types.js';

/*
 * People and time in the studio (design §6.11): durations as a builder sets them, and what a flow
 * that waits, or a process from before flows could wait, lets go of when an action, a card or a
 * field goes.
 */

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

type Gone = { readonly action?: string; readonly card?: string; readonly entity?: string; readonly field?: string };

/** Who a task waits for, and who votes, without a field that goes. */
function routingWithout<T extends { assignee?: unknown; department?: unknown; several?: unknown }>(task: T, field: string): T {
  const next: Record<string, unknown> = { ...task };
  const assignee = task.assignee as { field?: string; managerOf?: string } | undefined;
  if (assignee && (assignee.field ?? assignee.managerOf) === field) delete next['assignee'];
  if ((task.department as { of?: string } | undefined)?.of === field) delete next['department'];
  const several = task.several as { people: { lineOf?: string; fields?: string[] } } | undefined;
  const voters = several?.people;
  if (voters?.lineOf === field) delete next['several'];
  if (voters?.fields?.includes(field)) {
    const left = voters.fields.filter((each) => each !== field);
    if (left.length >= 2) next['several'] = { ...several, people: { fields: left } };
    else delete next['several'];
  }
  return next as T;
}

/** A wait that named a date field that goes waits a day instead, and the builder sees it. */
const waitWithout = (wait: WaitFor, gone: Gone): WaitFor => ('date' in wait && wait.date === gone.field ? { duration: 'P1D' } : wait);

function stepsWithout(steps: readonly FlowStep[], gone: Gone, about: string | undefined): FlowStep[] {
  return steps.map((step) => {
    let next: FlowStep = step;
    if (step.type === 'task') {
      next = {
        ...step,
        outcomes: step.outcomes.map((outcome) => (gone.action && outcome.action === gone.action ? { ...outcome, action: undefined } : outcome)),
        ...(gone.card && step.card === gone.card ? { card: undefined } : {}),
      };
      if (gone.field && gone.entity === about) next = routingWithout(next, gone.field);
    }
    if (gone.field && gone.entity === about) {
      if (next.type === 'wait') next = { ...next, for: waitWithout(next.for, gone) };
      if (next.type === 'first_of') next = { ...next, ways: next.ways.map((way) => ({ ...way, for: waitWithout(way.for, gone) })) };
    }
    return withLists(next, '', (inner) => stepsWithout(inner, gone, about));
  });
}

/**
 * Let go of an action, a card or a field that goes: the tasks and waits of flows stop naming it,
 * and so do processes from before flows could wait. A wait for an action keeps its name, and the checks show
 * where to choose another.
 */
export function forgetInWaits(definition: Definition, gone: Gone): Definition {
  const flows = definition.flows
    ? Object.fromEntries(
        Object.entries(definition.flows).map(([name, flow]) => [name, { ...flow, steps: stepsWithout(flow.steps, gone, flowSubject(flow)?.entity) }]),
      )
    : undefined;
  const processes = definition.processes
    ? Object.fromEntries(
        Object.entries(definition.processes).map(([name, process]) => {
          const about = gone.field && gone.entity === process.entity;
          const elements = Object.fromEntries(
            Object.entries(process.elements).map(([id, element]) => {
              if (element.type === 'startEvent' && gone.action)
                return [id, { ...element, actions: element.actions.filter((action) => action !== gone.action) }];
              if (element.type === 'userTask') {
                const outcomes = element.outcomes.map((outcome) =>
                  gone.action && outcome.action === gone.action ? { name: outcome.name, label: outcome.label } : outcome,
                );
                const task = { ...element, outcomes, ...(gone.card && element.card === gone.card ? { card: undefined } : {}) };
                return [id, about ? routingWithout(task, gone.field!) : task];
              }
              if (element.type === 'serviceTask' && gone.action && element.action === gone.action) return [id, { ...element, action: '' }];
              if (element.type === 'callActivity' && about && element.record === gone.field) {
                const { record: _record, ...rest } = element;
                return [id, rest];
              }
              if (
                (element.type === 'intermediateCatchEvent' || element.type === 'boundaryEvent') &&
                about &&
                element.timer &&
                'date' in element.timer &&
                element.timer.date === gone.field
              ) {
                return [id, { ...element, timer: { duration: 'P1D' } }];
              }
              return [id, element];
            }),
          );
          return [name, { ...process, elements }];
        }),
      )
    : undefined;
  return { ...definition, ...(flows ? { flows } : {}), ...(processes ? { processes } : {}) } as Definition;
}
