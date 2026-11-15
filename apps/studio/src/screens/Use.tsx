import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api.js';
import { FilesProvider } from '../components/files.js';
import { filledLines, LinesChangeView, LinesEditor, LinesTable, rollupValue } from '../components/lines.js';
import { PersonName } from '../components/people.js';
import { Badge, Button, Card, cx, EmptyState, Notice } from '../components/ui.js';
import { asLines, display, ValueInput, ValueView } from '../components/values.js';
import { Link, navigate } from '../router.js';
import type { HistoryEntry, Line, RecordOut, RecordValue, UiEntity, UiField, UiForm, UiManifest, Value } from '../types.js';

/** An app's screens, generated from what the signed-in person may use: their entities, fields, forms and actions. */
export function Use({ appId, page, recordId }: { appId: string; page?: string; recordId?: string }) {
  const ui = useQuery({ queryKey: ['ui', appId], queryFn: () => api.ui(appId) });
  if (ui.isError) return <Notice tone="bad">{ui.error instanceof ApiError && ui.error.status === 403 ? "This app isn't shared with you." : "This app can't be opened."}</Notice>;
  if (!ui.data) return <p className="text-muted">Loading…</p>;
  const manifest = ui.data;
  const entities = Object.entries(manifest.entities).filter(([, e]) => e.can.read);
  const forms = Object.entries(manifest.forms);
  const current = page ?? entities[0]?.[0];

  return (
    <FilesProvider appId={appId}>
    <div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label={manifest.app.name} className="grid content-start gap-4">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight">{manifest.app.name}</h1>
          {manifest.app.access.build ? (
            <Link to={{ name: 'build', appId, tab: 'data' }} className="text-sm">
              Build this app
            </Link>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1">{manifest.app.access.roles.map((role) => <Badge key={role}>{role}</Badge>)}</div>
          )}
        </div>
        {forms.length ? (
          <ul className="m-0 grid list-none gap-1 p-0">
            {forms.map(([name, form]) => (
              <li key={name}>
                <Link to={{ name: 'use', appId, page: 'new', recordId: name }} className={cx('block rounded-md px-2.5 py-1.5 font-medium no-underline', page === 'new' && recordId === name ? 'bg-accent text-accent-text' : 'bg-accent-soft text-accent')}>
                  + {form.label}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="m-0 grid list-none gap-1 p-0">
          {entities.map(([name, entity]) => (
            <li key={name}>
              <Link to={{ name: 'use', appId, page: name }} aria-current={current === name && page !== 'new' ? 'page' : undefined} className={cx('block rounded-md px-2.5 py-1.5 no-underline', current === name && page !== 'new' ? 'bg-sunken text-text' : 'text-muted hover:text-text')}>
                {entity.pluralLabel}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0">
        {page === 'new' && recordId && manifest.forms[recordId] ? (
          <FormRunner appId={appId} manifest={manifest} name={recordId} form={manifest.forms[recordId]} />
        ) : current && manifest.entities[current] ? (
          recordId ? (
            <RecordView appId={appId} manifest={manifest} entityName={current} recordId={recordId} />
          ) : (
            <RecordList appId={appId} manifest={manifest} entityName={current} />
          )
        ) : (
          <EmptyState title="Nothing to see here yet">This app has nothing you can read.</EmptyState>
        )}
      </div>
    </div>
    </FilesProvider>
  );
}

function Cell({ field, record }: { field: UiField; record: RecordOut }) {
  if (record.masked?.includes(field.name)) return <span className="text-faint" title="Masked for your role">••••</span>;
  return <ValueView field={field} value={record.values?.[field.name]} />;
}

/** Every record has an owner, though it isn't one of the entity's fields. */
const OWNER: UiField = { name: 'owner', label: 'Owner', type: 'user', required: true, read: 'full', create: false, update: false };

function RecordList({ appId, manifest, entityName }: { appId: string; manifest: UiManifest; entityName: string }) {
  const entity = manifest.entities[entityName]!;
  const records = useQuery({ queryKey: ['records', appId, entityName], queryFn: () => api.records(appId, entityName) });
  const columns = entity.fields.filter((f) => f.read && f.type !== 'lines').slice(0, 6);
  const form = Object.entries(manifest.forms).find(([, f]) => f.entity === entityName);
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-2xl font-semibold tracking-tight">{entity.pluralLabel}</h2>
        {form ? (
          <Link to={{ name: 'use', appId, page: 'new', recordId: form[0] }} className="no-underline">
            <Button variant="primary" tabIndex={-1}>
              {form[1].label}
            </Button>
          </Link>
        ) : null}
      </div>
      {records.data?.records.length === 0 ? <EmptyState title={`No ${entity.pluralLabel.toLowerCase()} you can see`} /> : null}
      {records.data?.records.length ? (
        <FilesProvider appId={appId} known={Object.assign({}, ...records.data.records.map((r) => r.files ?? {}))}>
        <Card className="overflow-x-auto p-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                {columns.map((f) => (
                  <th key={f.name} scope="col" className="px-4 py-2.5 font-medium">
                    {f.label}
                  </th>
                ))}
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {records.data.records.map((record) => (
                <tr key={record.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-sunken" onClick={() => navigate({ name: 'use', appId, page: entityName, recordId: record.id })}>
                  {columns.map((f, i) => (
                    <td key={f.name} className="px-4 py-2.5">
                      {i === 0 ? (
                        <Link to={{ name: 'use', appId, page: entityName, recordId: record.id }} className="font-medium" onClick={(e) => e.stopPropagation()}>
                          <Cell field={f} record={record} />
                        </Link>
                      ) : (
                        <Cell field={f} record={record} />
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-muted">{record.updatedAt ? new Date(record.updatedAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        </FilesProvider>
      ) : null}
    </div>
  );
}

/** A control for one field's value, by type. */
function problemsOf(error: unknown): { fields: Record<string, string>; message: string | null } {
  if (!(error instanceof ApiError)) return { fields: {}, message: error ? 'Something went wrong' : null };
  const details = error.details as { issues?: Array<{ field: string; message: string }>; findings?: Array<{ message: string }> } | undefined;
  const fields = Object.fromEntries((details?.issues ?? []).map((issue) => [issue.field, issue.message]));
  return { fields, message: details?.issues?.length ? 'Some values need fixing.' : error.message };
}

function FormRunner({ appId, manifest, name, form }: { appId: string; manifest: UiManifest; name: string; form: UiForm }) {
  const client = useQueryClient();
  const entity = manifest.entities[form.entity]!;
  // Each lines field on the form starts with one empty line to fill in.
  const [values, setValues] = useState<Record<string, RecordValue>>(() =>
    Object.fromEntries(form.sections.flatMap((s) => s.fields).flatMap((item) => (entity.fields.find((f) => f.name === item.field)?.type === 'lines' && !item.readOnly ? [[item.field, [{}]]] : []))),
  );
  const submit = useMutation({
    mutationFn: async () => {
      const editable = Object.fromEntries(
        Object.entries(values)
          .filter(([field]) => form.sections.some((s) => s.fields.some((f) => f.field === field && !f.readOnly)))
          .map(([field, value]) => [field, Array.isArray(value) && entity.fields.find((f) => f.name === field)?.type === 'lines' ? filledLines(asLines(value)) : value]),
      );
      if (form.action) return api.runAction(appId, form.action, { values: editable });
      return { status: 'done' as const, record: await api.createRecord(appId, form.entity, editable) };
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['records', appId] });
      if (result.status === 'done' && result.record.values) navigate({ name: 'use', appId, page: form.entity, recordId: result.record.id });
      else if (result.status === 'done') navigate({ name: 'use', appId, page: form.entity });
      else window.location.assign(result.proposal.reviewUrl);
    },
  });
  const problems = problemsOf(submit.error);
  return (
    <Card className="grid max-w-3xl gap-5">
      <h2 className="m-0 text-2xl font-semibold tracking-tight">{form.label}</h2>
      <form
        className="grid gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
        aria-describedby={problems.message ? 'form-problem' : undefined}
      >
        {form.sections.map((section, s) => (
          <fieldset key={s} className="m-0 grid gap-3 border-0 p-0">
            {section.title ? <legend className="mb-2 font-semibold">{section.title}</legend> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {section.fields.map((item) => {
                const field = entity.fields.find((f) => f.name === item.field);
                if (!field) return null;
                const id = `field-${item.field}`;
                const lines = field.type === 'lines';
                return (
                  <div key={item.field} className={cx('grid content-start gap-1', (item.width === 'full' || lines) && 'sm:col-span-2')}>
                    {field.type !== 'boolean' ? (
                      <label htmlFor={id} className="text-sm text-muted">
                        {item.label ?? field.label}
                        {field.required && !field.computed ? <span className="text-bad"> *</span> : null}
                      </label>
                    ) : null}
                    {field.computed ? (
                      <p className="m-0 tabular-nums" id={id}>
                        <ValueView field={field} value={rollupValue(field, values)} />
                      </p>
                    ) : lines && !item.readOnly ? (
                      <LinesEditor id={id} field={field} value={asLines(values[field.name])} onChange={(next) => setValues({ ...values, [field.name]: next })} mode="create" problems={problems.fields} />
                    ) : item.readOnly ? (
                      <p className="m-0">
                        <ValueView field={field} value={values[field.name]} />
                      </p>
                    ) : (
                      <ValueInput id={id} field={field} value={values[field.name] as Value | undefined} onChange={(value) => setValues({ ...values, [field.name]: value })} />
                    )}
                    {item.help ? <p className="m-0 text-xs text-faint">{item.help}</p> : null}
                    {problems.fields[field.name] ? <p className="m-0 text-xs text-bad">{problems.fields[field.name]}</p> : null}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        {problems.message ? (
          <div id="form-problem">
            <Notice tone="bad">{problems.message}</Notice>
          </div>
        ) : null}
        <div>
          <Button type="submit" variant="primary" disabled={submit.isPending}>
            {submit.isPending ? 'Submitting…' : form.action ? (manifest.actions[form.action]?.label ?? 'Submit') : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function RecordView({ appId, manifest, entityName, recordId }: { appId: string; manifest: UiManifest; entityName: string; recordId: string }) {
  const client = useQueryClient();
  const entity: UiEntity = manifest.entities[entityName]!;
  const record = useQuery({ queryKey: ['record', appId, entityName, recordId], queryFn: () => api.record(appId, entityName, recordId) });
  const history = useQuery({ queryKey: ['history', appId, entityName, recordId], queryFn: () => api.history(appId, entityName, recordId) });
  const [edits, setEdits] = useState<Record<string, RecordValue> | null>(null);
  const refresh = () => Promise.all(['record', 'records', 'history'].map((key) => client.invalidateQueries({ queryKey: [key, appId] })));
  // Lines are sent whole, with their IDs, so the platform knows which changed; empty new rows are dropped.
  const changes = () => Object.fromEntries(Object.entries(edits ?? {}).map(([field, value]) => [field, entity.fields.find((f) => f.name === field)?.type === 'lines' ? filledLines(asLines(value)) : value]));
  const save = useMutation({ mutationFn: () => api.updateRecord(appId, entityName, recordId, changes(), record.data!.version), onSuccess: async () => (setEdits(null), await refresh()) });
  const run = useMutation({ mutationFn: (action: string) => api.runAction(appId, action, { values: {}, recordId, version: record.data!.version }), onSuccess: refresh });
  const actions = Object.entries(manifest.actions).filter(([, a]) => a.entity === entityName && a.operation === 'update' && a.input.length === 0);
  const editable = entity.fields.filter((f) => f.update && !f.computed && !record.data?.masked?.includes(f.name));

  if (record.isError) return <Notice tone="bad">This record doesn't exist, or you can't see it.</Notice>;
  if (!record.data) return <p className="text-muted">Loading…</p>;
  const title = entity.titleField ? display(entity.fields.find((f) => f.name === entity.titleField), record.data.values?.[entity.titleField]) : record.data.id;
  const problems = problemsOf(save.error ?? run.error);

  return (
    <FilesProvider appId={appId} known={record.data.files ?? {}}>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="grid content-start gap-4">
        <div>
          <p className="m-0 text-sm text-muted">
            <Link to={{ name: 'use', appId, page: entityName }}>{entity.pluralLabel}</Link>
          </p>
          <h2 className="m-0 text-2xl font-semibold tracking-tight">{title}</h2>
        </div>
        <dl className="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
          {entity.fields
            .filter((f) => f.read)
            .map((field) => {
              const editing = edits !== null && editable.includes(field);
              const current = edits && field.name in edits ? edits[field.name] : (record.data.values?.[field.name] ?? null);
              const lines = field.type === 'lines';
              return (
              <div key={field.name} className="contents">
                <dt className={cx('text-muted', lines && 'sm:col-span-2')}>{editing ? <label htmlFor={`edit-${field.name}`}>{field.label}</label> : field.label}</dt>
                <dd className={cx('m-0', lines && 'sm:col-span-2')}>
                  {editing && lines ? (
                    <LinesEditor id={`edit-${field.name}`} field={field} value={asLines(current)} onChange={(next) => setEdits({ ...edits, [field.name]: next })} mode="update" problems={problems.fields} />
                  ) : editing ? (
                    <ValueInput id={`edit-${field.name}`} field={field} value={current as Value} onChange={(value) => setEdits({ ...edits, [field.name]: value })} />
                  ) : lines ? (
                    <LinesTable field={field} value={record.data.values?.[field.name]} masked={record.data.masked ?? []} />
                  ) : field.computed && edits ? (
                    <span className="tabular-nums">
                      <ValueView field={field} value={rollupValue(field, { ...record.data.values, ...edits })} />
                    </span>
                  ) : (
                    <Cell field={field} record={record.data} />
                  )}
                  {problems.fields[field.name] && !lines ? <span className="block text-xs text-bad">{problems.fields[field.name]}</span> : null}
                </dd>
              </div>
              );
            })}
          {record.data.owner ? (
            <>
              <dt className="text-muted">{OWNER.label}</dt>
              <dd className="m-0">
                <PersonName id={record.data.owner} />
              </dd>
            </>
          ) : null}
        </dl>
        {problems.message ? <Notice tone="bad">{problems.message}</Notice> : null}
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {edits ? (
            <>
              <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
                Save
              </Button>
              <Button onClick={() => setEdits(null)}>Cancel</Button>
            </>
          ) : (
            <>
              {editable.length ? <Button onClick={() => setEdits({})}>Edit</Button> : null}
              {actions.map(([name, action]) => (
                <Button key={name} variant="primary" onClick={() => run.mutate(name)} disabled={run.isPending}>
                  {action.label}
                </Button>
              ))}
            </>
          )}
        </div>
      </Card>
      <Card className="grid content-start gap-3">
        <h3 className="m-0 text-sm font-semibold text-muted">History</h3>
        <ol className="m-0 grid list-none gap-3 p-0">
          {history.data?.history
            .slice()
            .reverse()
            .map((entry) => (
              <HistoryItem key={`${entry.version}-${entry.at}`} entry={entry} entity={entity} record={record.data!} />
            ))}
        </ol>
      </Card>
    </div>
    </FilesProvider>
  );
}

function HistoryItem({ entry, entity, record }: { entry: HistoryEntry; entity: UiEntity; record: RecordOut }) {
  const verb = { create: 'Created', update: 'Changed', delete: 'Deleted' }[entry.operation];
  const { actor } = entry;
  return (
    <li className="grid gap-1 border-l-2 border-line pl-3">
      <p className="m-0 text-sm">
        <strong>{verb}</strong>
        {actor.id ? (
          <>
            {' by '}
            <span className={cx(actor.type === 'service_account' && 'text-agent')}>
              <PersonName id={actor.id} />
              {actor.type === 'service_account' ? ' (agent)' : null}
            </span>
            {actor.onBehalfOf ? (
              <>
                {' for '}
                <PersonName id={actor.onBehalfOf} />
              </>
            ) : null}
          </>
        ) : null}
        <span className="block text-muted">{new Date(entry.at).toLocaleString()}</span>
      </p>
      <ul className="m-0 grid list-none gap-0.5 p-0 text-sm">
        {entry.changes.map((change, i) => {
          const field = change.field === 'owner' ? OWNER : entity.fields.find((f) => f.name === change.field);
          const label = field?.label ?? change.field;
          if (change.masked) return <li key={i} className="text-muted">{label}: changed (masked)</li>;
          if (change.removed) return <li key={i} className="text-faint">{label}: a field that no longer exists</li>;
          if (change.lines && field) {
            return (
              <li key={i}>
                <span className="text-muted">{label}:</span>
                <LinesChangeView field={field} change={change.lines} current={asLines(record.values?.[field.name]) as Line[]} />
              </li>
            );
          }
          return (
            <li key={i}>
              <span className="text-muted">{label}:</span>{' '}
              {entry.operation === 'update' ? (
                <>
                  <ValueView field={field} value={change.before ?? null} link={false} />
                  {' → '}
                </>
              ) : null}
              <ValueView field={field} value={change.after ?? null} link={false} />
              {change.source?.source === 'document' ? <span className="ml-1 text-outside">from {String(change.source['document'] ?? 'a document')}</span> : null}
              {change.source?.source === 'agent' ? <span className="ml-1 text-agent">inferred by the agent</span> : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}
