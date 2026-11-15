import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Badge, Button, Card, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { normalize } from '../model/edit.js';
import type { Definition } from '../types.js';

const roleOf = (appRoleId: string | null) => appRoleId?.split(':').at(-1) ?? '';

/** Who the app is shared with. Sharing applies at once: it isn't part of the draft. */
export function SharePanel({ appId, definition }: { appId: string; definition: Definition }) {
  const client = useQueryClient();
  const shares = useQuery({ queryKey: ['shares', appId], queryFn: () => api.shares(appId) });
  const roles = Object.entries(definition.roles);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles[0]?.[0] ?? '');
  const refresh = () => client.invalidateQueries({ queryKey: ['shares', appId] });
  const share = useMutation({ mutationFn: () => api.share(appId, email.trim(), role), onSuccess: () => (setEmail(''), refresh()) });
  const unshare = useMutation({ mutationFn: (id: string) => api.unshare(appId, id), onSuccess: refresh });

  if (roles.length === 0) {
    return <EmptyState title="This app has no roles yet">A role says what the people you share with may do. Add roles on the Advanced tab, then share.</EmptyState>;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="grid content-start gap-3">
        <h2 className="m-0 text-lg font-semibold">Shared with</h2>
        {shares.data?.shares.length === 0 ? <p className="m-0 text-muted">Only you can use this app so far.</p> : null}
        <ul className="m-0 grid list-none gap-2 p-0">
          {shares.data?.shares.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
              <span className="flex-1 font-medium">{s.principal.name ?? s.principal.id}</span>
              <Badge tone="accent">{definition.roles[roleOf(s.appRoleId)]?.label ?? roleOf(s.appRoleId)}</Badge>
              <Button size="sm" variant="ghost" onClick={() => unshare.mutate(s.id)} disabled={unshare.isPending}>
                Stop sharing
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="grid content-start gap-3">
        <h2 className="m-0 text-lg font-semibold">Share with a colleague</h2>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            share.mutate();
          }}
        >
          <Field label="Their email">{(id) => <TextInput id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="As">
            {(id) => (
              <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map(([name, r]) => (
                  <option key={name} value={name}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {share.error ? <Notice tone="bad">{share.error instanceof ApiError ? share.error.message : 'Something went wrong'}</Notice> : null}
          <Button type="submit" variant="primary" disabled={share.isPending || !email.trim()}>
            Share
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** The whole definition as JSON: for what the designers don't edit yet (rules, actions, queries, cards, roles). */
export function AdvancedPanel({ definition, onChange }: { definition: Definition; onChange: (d: Definition) => void }) {
  const text = JSON.stringify(definition, null, 2);
  const [value, setValue] = useState(text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(text), [text]);
  return (
    <Card className="grid gap-3">
      <p className="m-0 text-sm text-muted">
        Rules, actions, queries, review cards and roles are edited here for now. Applying puts the JSON into your draft; saving checks it, as for any change.
      </p>
      <textarea
        aria-label="The app definition, as JSON"
        className="mono min-h-[28rem] w-full rounded-md border border-line-strong bg-sunken p-3 text-sm"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={value === text}
          onClick={() => {
            try {
              onChange(normalize(JSON.parse(value) as Definition));
              setError(null);
            } catch (e) {
              setError(`That isn't valid JSON: ${(e as Error).message}`);
            }
          }}
        >
          Apply to the draft
        </Button>
        <Button disabled={value === text} onClick={() => (setValue(text), setError(null))}>
          Reset
        </Button>
      </div>
    </Card>
  );
}

/** Every saved revision, with what each save did. */
export function HistoryPanel({ appId }: { appId: string }) {
  const revisions = useQuery({ queryKey: ['revisions', appId], queryFn: () => api.revisions(appId) });
  return (
    <Card className="grid gap-3">
      <h2 className="m-0 text-lg font-semibold">Revisions</h2>
      <ol className="m-0 grid list-none gap-3 p-0">
        {revisions.data?.revisions.map((r) => (
          <li key={r.revision} className="grid gap-1 rounded-md border border-line px-3 py-2">
            <div className="flex items-center gap-2">
              <strong>Revision {r.revision}</strong>
              <span className="text-sm text-muted">{new Date(r.createdAt).toLocaleString()}</span>
              <span className="flex-1" />
              <code className="text-xs text-faint">{r.digest.slice(0, 12)}</code>
            </div>
            <ul className="m-0 pl-5 text-sm text-muted">
              {(r.summary?.steps ?? []).map((step, i) => (
                <li key={i} className={step.destructive ? 'text-bad' : undefined}>
                  {step.description}
                </li>
              ))}
              {(r.summary?.notes ?? []).map((note, i) => (
                <li key={`n${i}`}>{note}</li>
              ))}
              {!r.summary?.steps?.length && !r.summary?.notes?.length ? <li>No change to the data model</li> : null}
            </ul>
          </li>
        ))}
      </ol>
    </Card>
  );
}
