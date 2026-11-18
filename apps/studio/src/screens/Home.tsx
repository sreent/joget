import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api.js';
import { Badge, Button, Card, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { Link, navigate } from '../router.js';
import type { Me } from '../types.js';

/** Your apps, and the ones shared with you. Build an app in your personal space. */
export function Home({ me }: { me: Me }) {
  const client = useQueryClient();
  const apps = useQuery({ queryKey: ['apps'], queryFn: api.apps });
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  const teamSpaces = spaces.data?.spaces.filter((space) => space.kind === 'team' && space.status === 'active') ?? [];
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates });
  const [name, setName] = useState('');
  // Blank, a template's ID, or a file someone exported.
  const [start, setStart] = useState('blank');
  const [file, setFile] = useState<{ name: string; bundle: Record<string, unknown> } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [where, setWhere] = useState('mine');
  const inTeam = where !== 'mine';
  const template = templates.data?.templates.find((t) => t.id === start);
  const create = useMutation({
    mutationFn: async () => {
      const space = inTeam ? where : me.personalSpaceId!;
      if (start === 'blank') return { ...(await api.createApp(space, { name })), changeRequest: null };
      const named = name.trim() ? { name: name.trim() } : {};
      return api.importApp(space, start === 'file' ? { bundle: file!.bundle, ...named } : { template: start, ...named });
    },
    onSuccess: async ({ app, changeRequest }) => {
      await client.invalidateQueries({ queryKey: ['apps'] });
      // In a team space, a template or a file arrives as a change request, for the space to review.
      if (changeRequest) navigate({ name: 'change', changeRequestId: changeRequest.id });
      else navigate({ name: 'build', appId: app.id, tab: app.kind === 'team' ? 'changes' : 'data' });
    },
  });
  const ready = start === 'blank' ? Boolean(name.trim()) : start === 'file' ? Boolean(file) : Boolean(template);
  const all = apps.data?.apps ?? [];
  const mine = all.filter((app) => app.kind === 'personal' && app.access.build && !app.workingCopyOf);
  const copies = all.filter((app) => app.workingCopyOf);
  const team = all.filter((app) => app.kind === 'team' && app.access.build);
  const shared = all.filter((app) => !app.access.build);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="grid content-start gap-6">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">Your apps</h1>
          <p className="m-0 mt-1 text-muted">Apps you build live in your personal space. Share one with colleagues when it's ready.</p>
        </div>
        {apps.isLoading ? <p className="text-muted">Loading…</p> : null}
        {apps.data && mine.length === 0 ? <EmptyState title="No apps yet">Create your first one on the right.</EmptyState> : null}
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          {mine.map((app) => (
            <li key={app.id}>
              <Card className="grid gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="m-0 text-lg font-semibold">{app.name}</h2>
                    <p className="m-0 text-sm text-faint">
                      <code>{app.handle}</code> · revision {app.revision}
                    </p>
                  </div>
                  <Badge tone="accent">Yours</Badge>
                </div>
                {app.description ? <p className="m-0 text-sm text-muted">{app.description}</p> : null}
                <div className="flex gap-2">
                  <Link to={{ name: 'build', appId: app.id, tab: 'data' }} className="no-underline">
                    <Button variant="primary" tabIndex={-1}>
                      Build
                    </Button>
                  </Link>
                  <Link to={{ name: 'use', appId: app.id }} className="no-underline">
                    <Button tabIndex={-1}>Open</Button>
                  </Link>
                </div>
              </Card>
            </li>
          ))}
        </ul>
        {team.length ? (
          <div className="grid gap-3">
            <h2 className="m-0 text-lg font-semibold">Team apps</h2>
            <p className="m-0 -mt-2 text-sm text-muted">They change through reviewed change requests, and run released versions in Prod.</p>
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              {team.map((app) => {
                const prod = app.environments?.find((env) => env.kind === 'prod');
                return (
                  <li key={app.id}>
                    <Card className="grid gap-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="m-0 text-lg font-semibold">{app.name}</h3>
                          <p className="m-0 text-sm text-faint">
                            <code>{app.handle}</code> · {prod?.release ? `release ${prod.release.number} in Prod` : 'not in Prod yet'}
                          </p>
                        </div>
                        <Badge tone="accent">Team</Badge>
                      </div>
                      <div className="flex gap-2">
                        <Link to={{ name: 'build', appId: app.id, tab: 'delivery' }} className="no-underline">
                          <Button variant="primary" tabIndex={-1}>
                            Delivery
                          </Button>
                        </Link>
                        {prod ? (
                          <Link to={{ name: 'use', appId: app.id }} className="no-underline">
                            <Button tabIndex={-1}>Open</Button>
                          </Link>
                        ) : null}
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {copies.length ? (
          <div className="grid gap-3">
            <h2 className="m-0 text-lg font-semibold">Your working copies</h2>
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              {copies.map((app) => (
                <li key={app.id}>
                  <Card className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="m-0 font-semibold">{app.name}</h3>
                      <p className="m-0 text-sm text-muted">
                        Changes to {app.workingCopyOf!.name}
                        {app.workingCopyOf!.changeRequest ? ` · change request #${app.workingCopyOf!.changeRequest.number}` : ''}
                      </p>
                    </div>
                    <Link to={{ name: 'build', appId: app.id, tab: 'data' }} className="no-underline">
                      <Button tabIndex={-1}>Build</Button>
                    </Link>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {shared.length ? (
          <div className="grid gap-3">
            <h2 className="m-0 text-lg font-semibold">Shared with you</h2>
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              {shared.map((app) => (
                <li key={app.id}>
                  <Card className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="m-0 font-semibold">{app.name}</h3>
                      <div className="mt-1 flex gap-1">
                        {app.access.roles.map((role) => (
                          <Badge key={role}>{role}</Badge>
                        ))}
                      </div>
                    </div>
                    <Link to={{ name: 'use', appId: app.id }} className="no-underline">
                      <Button tabIndex={-1}>Open</Button>
                    </Link>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <Card className="grid content-start gap-4">
        <h2 className="m-0 text-lg font-semibold">New app</h2>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) create.mutate();
          }}
        >
          <Field label="Name" hint={start === 'blank' ? undefined : 'Leave it empty to keep the name it comes with.'}>
            {(id) => (
              <TextInput
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={template?.name ?? 'Expense claims'}
                required={start === 'blank'}
                maxLength={100}
              />
            )}
          </Field>
          {teamSpaces.length ? (
            <Field
              label="Where"
              hint={inTeam ? 'A team app starts empty. Build it in your working copy, then submit it for review.' : 'Your personal space: you edit it live.'}
            >
              {(id) => (
                <Select id={id} value={where} onChange={(e) => setWhere(e.target.value)}>
                  <option value="mine">My space</option>
                  {teamSpaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name} (team)
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Field
            label="Start from"
            hint={template?.description ?? (start === 'file' ? 'A definition someone downloaded from a3t. No data comes with it.' : undefined)}
          >
            {(id) => (
              <Select id={id} value={start} onChange={(e) => setStart(e.target.value)}>
                <option value="blank">A blank app</option>
                {templates.data?.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
                <option value="file">A file…</option>
              </Select>
            )}
          </Field>
          {start === 'file' ? (
            <Field label="The file" hint={file ? `${file.name}: ready` : undefined}>
              {(id) => (
                <input
                  id={id}
                  type="file"
                  accept=".json,application/json"
                  className="text-sm"
                  onChange={async (e) => {
                    const chosen = e.target.files?.[0];
                    setFile(null);
                    setFileError(null);
                    if (!chosen) return;
                    try {
                      const parsed: unknown = JSON.parse(await chosen.text());
                      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
                      setFile({ name: chosen.name, bundle: parsed as Record<string, unknown> });
                    } catch {
                      setFileError("That file isn't an app definition in JSON.");
                    }
                  }}
                />
              )}
            </Field>
          ) : null}
          {inTeam && start !== 'blank' ? (
            <p className="m-0 text-xs text-muted">In a team space, it arrives as a change request, for the space to review.</p>
          ) : null}
          {fileError ? <Notice tone="bad">{fileError}</Notice> : null}
          {create.error ? <Notice tone="bad">{create.error instanceof ApiError ? create.error.message : 'Something went wrong'}</Notice> : null}
          <Button type="submit" variant="primary" disabled={!ready || create.isPending || !me.personalSpaceId}>
            {create.isPending ? 'Creating…' : 'Create app'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
