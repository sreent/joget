import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api.js';
import { Badge, Button, Card, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { Link, navigate } from '../router.js';
import type { Me } from '../types.js';

/** Your apps, and the ones shared with you. Build an app in your personal space. */
export function Home({ me }: { me: Me }) {
  const client = useQueryClient();
  const apps = useQuery({ queryKey: ['apps'], queryFn: api.apps });
  const [name, setName] = useState('');
  const [start, setStart] = useState<'blank' | 'example'>('blank');
  const create = useMutation({
    mutationFn: async () => {
      const definition = start === 'example' ? (await api.example()).example : undefined;
      return api.createApp(me.personalSpaceId!, { name, ...(definition ? { definition } : {}) });
    },
    onSuccess: async ({ app }) => {
      await client.invalidateQueries({ queryKey: ['apps'] });
      navigate({ name: 'build', appId: app.id, tab: 'data' });
    },
  });
  const mine = apps.data?.apps.filter((app) => app.access.build) ?? [];
  const shared = apps.data?.apps.filter((app) => !app.access.build) ?? [];

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
                    <Button variant="primary" tabIndex={-1}>Build</Button>
                  </Link>
                  <Link to={{ name: 'use', appId: app.id }} className="no-underline">
                    <Button tabIndex={-1}>Open</Button>
                  </Link>
                </div>
              </Card>
            </li>
          ))}
        </ul>
        {shared.length ? (
          <div className="grid gap-3">
            <h2 className="m-0 text-lg font-semibold">Shared with you</h2>
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              {shared.map((app) => (
                <li key={app.id}>
                  <Card className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="m-0 font-semibold">{app.name}</h3>
                      <div className="mt-1 flex gap-1">{app.access.roles.map((role) => <Badge key={role}>{role}</Badge>)}</div>
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
            if (name.trim()) create.mutate();
          }}
        >
          <Field label="Name">{(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Expense claims" required maxLength={100} />}</Field>
          <Field label="Start from">
            {(id) => (
              <Select id={id} value={start} onChange={(e) => setStart(e.target.value as 'blank' | 'example')}>
                <option value="blank">A blank app</option>
                <option value="example">The expense-claim example</option>
              </Select>
            )}
          </Field>
          {create.error ? <Notice tone="bad">{create.error instanceof ApiError ? create.error.message : 'Something went wrong'}</Notice> : null}
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending || !me.personalSpaceId}>
            {create.isPending ? 'Creating…' : 'Create app'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
