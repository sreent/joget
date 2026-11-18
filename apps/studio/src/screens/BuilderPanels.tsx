import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, type AppAt, api } from '../api.js';
import { Badge, Button, Card, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { normalize } from '../model/edit.js';
import { Link, navigate } from '../router.js';
import type { AppSummary, Definition } from '../types.js';

const roleOf = (appRoleId: string | null) => appRoleId?.split(':').at(-1) ?? '';

/**
 * Who holds the app's roles. For a personal app, who it is shared with; for a team app, who may
 * use one of its environments. Either applies at once: it isn't part of the draft.
 */
export function SharePanel({ at, definition, team = false }: { at: AppAt; definition: Definition; team?: boolean }) {
  const client = useQueryClient();
  const shares = useQuery({ queryKey: ['shares', at.id, at.env], queryFn: () => api.envShares(at) });
  const roles = Object.entries(definition.roles);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles[0]?.[0] ?? '');
  const refresh = () => client.invalidateQueries({ queryKey: ['shares', at.id] });
  const share = useMutation({
    mutationFn: () => api.envShare(at, email.trim(), role),
    onSuccess: () => {
      setEmail('');
      refresh();
    },
  });
  const unshare = useMutation({ mutationFn: (id: string) => api.envUnshare(at, id), onSuccess: refresh });

  if (roles.length === 0) {
    return (
      <EmptyState title="This app has no roles yet">A role says what the people you share with may do. Add roles on the Roles tab, then share.</EmptyState>
    );
  }
  return (
    <div className="grid gap-4 @min-[62rem]:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="grid content-start gap-3">
        <h2 className="m-0 text-lg font-semibold">{team ? 'Who may use it here' : 'Shared with'}</h2>
        {shares.data?.shares.length === 0 ? (
          <p className="m-0 text-muted">{team ? 'Nobody holds a role here yet.' : 'Only you can use this app so far.'}</p>
        ) : null}
        <ul className="m-0 grid list-none gap-2 p-0">
          {shares.data?.shares.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
              <span className="flex-1 font-medium">{s.principal.name ?? s.principal.id}</span>
              <Badge tone="accent">{definition.roles[roleOf(s.appRoleId)]?.label ?? roleOf(s.appRoleId)}</Badge>
              <Button size="sm" variant="ghost" onClick={() => unshare.mutate(s.id)} disabled={unshare.isPending}>
                {team ? 'Take it away' : 'Stop sharing'}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="grid content-start gap-3">
        <h2 className="m-0 text-lg font-semibold">{team ? 'Give a colleague a role' : 'Share with a colleague'}</h2>
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
            {team ? 'Give the role' : 'Share'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** On an app that moved to a team space: where it lives on. It is read-only here. */
export function MovedNotice({ movedTo }: { movedTo: { appId: string; name: string } }) {
  return (
    <Notice tone="warn">
      This app moved to a team space, as <Link to={{ name: 'use', appId: movedTo.appId }}>{movedTo.name}</Link>. It is read-only here: what was done here stays,
      and work goes on there.
    </Notice>
  );
}

/**
 * Move a personal app to a team space (design §3): a change request there brings in its
 * definition, for the space's reviewers. The app keeps working here until it runs in Prod there.
 */
export function MovePanel({ app }: { app: AppSummary }) {
  const client = useQueryClient();
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.spaces() });
  const teams = (spaces.data?.spaces ?? []).filter((space) => space.kind === 'team' && space.status === 'active');
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState(app.name);
  const target = spaceId || teams[0]?.id || '';
  const move = useMutation({
    mutationFn: () => api.promote(app.id, { spaceId: target, ...(name.trim() && name.trim() !== app.name ? { name: name.trim() } : {}) }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['app', app.id] });
      navigate({ name: 'change', changeRequestId: result.changeRequest.id });
    },
  });

  if (app.movedTo) {
    return (
      <Card className="grid content-start gap-2">
        <h2 className="m-0 text-lg font-semibold">Moved to a team space</h2>
        <p className="m-0 text-sm text-muted">
          It lives on as <Link to={{ name: 'use', appId: app.movedTo.appId }}>{app.movedTo.name}</Link>. Here it is read-only.
        </p>
      </Card>
    );
  }
  if (app.promotion) {
    const cr = app.promotion.changeRequest;
    return (
      <Card className="grid content-start gap-2">
        <h2 className="m-0 text-lg font-semibold">On its way to a team space</h2>
        <p className="m-0 text-sm text-muted">
          As {app.promotion.name}
          {cr ? (
            <>
              {', in '}
              <Link to={{ name: 'change', changeRequestId: cr.id }}>change request #{cr.number}</Link> ({cr.status})
            </>
          ) : null}
          . It keeps working here until it runs in Prod there; then it is read-only here.
        </p>
      </Card>
    );
  }
  return (
    <Card className="grid content-start gap-3">
      <h2 className="m-0 text-lg font-semibold">Move to a team space</h2>
      <p className="m-0 text-sm text-muted">
        When an app outgrows you and a few colleagues, a team space gives it owners, reviews, Prod and rollback. The space's reviewers check it like any change.
        Its records stay here.
      </p>
      {teams.length === 0 ? (
        <p className="m-0 text-sm text-faint">You are in no team space where you build apps yet.</p>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            move.mutate();
          }}
        >
          <Field label="Team space">
            {(id) => (
              <Select id={id} value={target} onChange={(e) => setSpaceId(e.target.value)}>
                {teams.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name there">{(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          {move.error ? <Notice tone="bad">{move.error instanceof ApiError ? move.error.message : 'Something went wrong'}</Notice> : null}
          <Button type="submit" disabled={move.isPending || !target}>
            Ask to move it
          </Button>
        </form>
      )}
    </Card>
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
        The whole definition, as JSON: for what the designers don't show yet, or to paste a definition in. Applying puts it into your draft; saving checks it,
        as for any change.
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
        <Button
          disabled={value === text}
          onClick={() => {
            setValue(text);
            setError(null);
          }}
        >
          Reset
        </Button>
      </div>
    </Card>
  );
}

/** Every saved revision, with what each save did. */
export function HistoryPanel({ appId }: { appId: string }) {
  const revisions = useQuery({ queryKey: ['revisions', appId], queryFn: () => api.revisions(appId) });
  // The definition as a file, to import again here or elsewhere: it never carries data.
  const download = useMutation({
    mutationFn: () => api.exportApp(appId),
    onSuccess: (bundle) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${bundle.app.handle}.ambit.json`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
  return (
    <Card className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">Revisions</h2>
        <Button size="sm" onClick={() => download.mutate()} disabled={download.isPending}>
          Download the definition
        </Button>
      </div>
      {download.error ? <Notice tone="bad">{download.error instanceof ApiError ? download.error.message : 'Something went wrong'}</Notice> : null}
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

/** Who may use a team app, environment by environment: space admins grant its roles to people (design §5.5). */
export function AccessPanel({ app, definition }: { app: AppSummary; definition: Definition }) {
  const live = (app.environments ?? []).filter((env) => env.kind === 'prod' || env.kind === 'staging');
  const [kind, setKind] = useState<string>(live[0]?.kind ?? 'prod');
  if (!live.length) return <EmptyState title="Not deployed yet">Once a release runs in Prod or Staging, give people its roles there.</EmptyState>;
  if (!app.access.share) return <Notice tone="warn">Space admins decide who may use the app in each environment.</Notice>;
  return (
    <div className="grid gap-4">
      <Field label="Environment">
        {(id) => (
          <Select id={id} className="w-56" value={kind} onChange={(e) => setKind(e.target.value)}>
            {live.map((env) => (
              <option key={env.kind} value={env.kind}>
                {env.kind === 'prod' ? 'Prod' : 'Staging'} (release {env.release?.number})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <SharePanel key={kind} at={{ id: app.id, env: kind }} definition={definition} team />
    </div>
  );
}
