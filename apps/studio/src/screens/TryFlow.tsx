import type { AppFlow } from '@platform/app-model';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api.js';
import { Button, Card, Field, Notice, Select, TextInput } from '../components/ui.js';
import { typeText } from '../model/flows.js';
import type { Definition } from '../types.js';

/* Try it: run the saved flow on real records, and undo what it did. */

/** Run the saved flow on real records, and undo what it did: to see what it would do. */
export function TryFlow({ appId, definition, name, flow, dirty }: { appId: string; definition: Definition; name: string; flow: AppFlow; dirty: boolean }) {
  const [input, setInput] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: () => {
      const values = Object.fromEntries(
        Object.entries(flow.input).map(([key, type]) => {
          const raw = input[key] ?? '';
          if (type.type === 'number') return [key, Number(raw)];
          if (type.type === 'boolean') return [key, raw === 'true'];
          if (type.type === 'list')
            return [
              key,
              raw
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean),
            ];
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
          <RecordPick
            key={key}
            appId={appId}
            definition={definition}
            input={key}
            entity={type.entity}
            value={input[key] ?? ''}
            onChange={(value) => setInput({ ...input, [key]: value })}
          />
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
        <section className="grid gap-1 text-sm" aria-label="What it did">
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
        </section>
      ) : null}
    </Card>
  );
}

function RecordPick({
  appId,
  definition,
  input,
  entity,
  value,
  onChange,
}: {
  appId: string;
  definition: Definition;
  input: string;
  entity: string;
  value: string;
  onChange: (value: string) => void;
}) {
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
