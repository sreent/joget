import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { Button, Card, Notice } from '../components/ui.js';
import { since } from '../model/flows.js';
import { Link } from '../router.js';
import type { Definition } from '../types.js';

/** The most cases the panel names by their records' titles. */
const NAMED = 50;

/**
 * The cases that wait at one step of a flow now, which its live count opens, the longest waiting
 * first: each by its record's title, as the person may read it, and since when it has waited. A
 * stuck case says why, for an operator to put right and try again.
 */
export function FlowCases({
  appId,
  definition,
  flow,
  entity,
  path,
  step,
  onClose,
}: {
  appId: string;
  definition: Definition;
  flow: string;
  entity: string;
  path: string;
  step: string;
  onClose: () => void;
}) {
  const cases = useQuery({ queryKey: ['flow-cases', appId, flow, path], queryFn: () => api.flowCases(appId, flow, path), refetchInterval: 10_000 });
  const list = cases.data?.cases ?? [];
  const records = useQueries({
    queries: list.slice(0, NAMED).map((each) => ({
      queryKey: ['record', appId, undefined, entity, each.recordId],
      queryFn: () => api.record(appId, entity, each.recordId),
      retry: false,
    })),
  });
  const about = definition.entities[entity];
  const titleField = about?.fields.find((field) => field.name === about.titleField);
  // A record's title as people read it: a choice's label, not its value.
  const titleOf = (index: number): string => {
    const value = titleField ? records[index]?.data?.values?.[titleField.name] : undefined;
    const text =
      typeof value === 'string'
        ? titleField?.type === 'choice'
          ? (titleField.options.find((option) => option.value === value)?.label ?? value)
          : value
        : typeof value === 'number'
          ? String(value)
          : '';
    return text || `A ${about?.label.toLowerCase() ?? 'record'}`;
  };

  return (
    <Card aria-label="Cases at this step" className="grid gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">Cases at {step}</h3>
        <Button size="sm" variant="ghost" aria-label="Close the cases" onClick={onClose}>
          ✕
        </Button>
      </div>
      {cases.isError ? <Notice tone="bad">The cases can't be shown.</Notice> : null}
      {cases.isPending ? <p className="m-0 text-sm text-muted">Loading…</p> : null}
      {cases.data && !list.length ? <p className="m-0 text-sm text-muted">No case waits here now.</p> : null}
      {list.length ? (
        <ul className="m-0 grid list-none gap-2.5 p-0">
          {list.map((each, index) => (
            <li key={each.instanceId} className="grid gap-0.5">
              <Link to={{ name: 'use', appId, page: entity, recordId: each.recordId }}>{index < NAMED ? titleOf(index) : each.recordId}</Link>
              <span className={each.stuck ? 'text-xs text-bad' : 'text-xs text-muted'}>
                {each.stuck ? 'Stuck' : 'Waiting'} for {since(each.since)}
              </span>
              {each.error ? <span className="text-xs text-bad">{each.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
