import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api, ApiError, type AppAt } from '../api.js';
import type { ImportResult, UiEntity } from '../types.js';
import { Button, Card, Notice } from './ui.js';

/** The most problems listed at once: the rest are counted. */
const SHOWN = 50;

/**
 * Bring records in from a CSV file, as a spreadsheet or another system writes it (design §6.1).
 * The file is checked first, and nothing is written: which field each column fills, and each
 * line's problems. Then all of its records come in, or none.
 */
export function ImportPanel({ at, entityName, entity, onDone }: { at: AppAt; entityName: string; entity: UiEntity; onDone: (created: number) => void }) {
  const fileId = useId();
  const client = useQueryClient();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const check = useMutation({ mutationFn: (chosen: { name: string; csv: string }) => api.importRecords(at, entityName, { ...chosen, dryRun: true }) });
  const bring = useMutation({
    mutationFn: () => api.importRecords(at, entityName, { ...file!, dryRun: false }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['records', at.id] });
      onDone(result.created);
    },
  });
  const result: ImportResult | undefined = check.data;
  const fieldLabel = (name: string) => (name === 'owner' ? 'Owner' : (entity.fields.find((field) => field.name === name)?.label ?? name));
  const error = check.error ?? bring.error;

  return (
    <Card className="grid gap-3">
      <h3 className="m-0 text-base font-semibold">Bring {entity.pluralLabel.toLowerCase()} in from a file</h3>
      <label htmlFor={fileId} className="grid gap-1 text-sm">
        <span className="text-muted">A CSV file: a line of headers, each the name or the label of a field, then a line for each record</span>
        <input
          id={fileId}
          type="file"
          accept=".csv,text/csv"
          onChange={async (event) => {
            const chosen = event.target.files?.[0];
            if (!chosen) return;
            const next = { name: chosen.name, csv: await chosen.text() };
            setFile(next);
            bring.reset();
            check.mutate(next);
          }}
        />
      </label>
      {check.isPending ? <p className="m-0 text-sm text-muted">Checking the file…</p> : null}
      {error ? <Notice tone="bad">{error instanceof ApiError ? error.message : "The file can't be brought in."}</Notice> : null}
      {result ? (
        <>
          <ul aria-label="Columns" className="m-0 grid list-none gap-1 p-0 text-sm">
            {result.columns.map((column, i) => (
              <li key={i}>
                <span className="font-medium">{column.header}</span>
                {column.field ? <span className="text-muted"> fills {fieldLabel(column.field)}</span> : <span className="text-faint"> stays out: {column.note}</span>}
              </li>
            ))}
          </ul>
          {result.issues.length ? (
            <div className="grid gap-2">
              <Notice tone="bad">
                {result.issues.length === 1 ? 'One problem' : `${result.issues.length} problems`} in {result.rows} {result.rows === 1 ? 'record' : 'records'}. Put the file right, and choose it again. Nothing has been brought in.
              </Notice>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th scope="col" className="py-1.5 pr-3 font-medium">Line</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">Field</th>
                    <th scope="col" className="py-1.5 font-medium">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {result.issues.slice(0, SHOWN).map((issue, i) => (
                    <tr key={i} className="border-b border-line">
                      <td className="py-1.5 pr-3 tabular-nums">{issue.row}</td>
                      <td className="py-1.5 pr-3">{issue.field ? fieldLabel(issue.field) : '—'}</td>
                      <td className="py-1.5">{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.issues.length > SHOWN ? <p className="m-0 text-sm text-muted">And {result.issues.length - SHOWN} more.</p> : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Notice tone="good">
                {result.rows === 1 ? 'The record is' : `All ${result.rows} records are`} ready: each passed the checks, rules and permissions of a new record.
              </Notice>
              <Button variant="primary" disabled={bring.isPending} onClick={() => bring.mutate()}>
                Bring in {result.rows} {result.rows === 1 ? entity.label.toLowerCase() : entity.pluralLabel.toLowerCase()}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </Card>
  );
}
