import type { Connection, ConnectionAuth, Webhook } from '@platform/app-model';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, type AppAt, api } from '../api.js';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Modes, Notice, Select, TextInput } from '../components/ui.js';
import { toName } from '../model/edit.js';
import type { Definition, IntegrationStatus } from '../types.js';

/*
 * The systems an app talks to (design §6.13), as Ocean's Webhooks draws addresses: each a card,
 * its address in mono, what it does under it, and how it stands as a badge. A builder designs
 * connections and webhooks in the draft. Whoever manages connections keeps their secrets, for each
 * environment, once they are saved: nothing shows a secret again, and a flow never sees one.
 */

type Props = { definition: Definition; onChange: (definition: Definition) => void };

const AUTH_WORDS: Readonly<Record<ConnectionAuth['type'], string>> = {
  none: 'no secret',
  bearer: 'a bearer token',
  basic: 'a user name and a password',
  header: 'a key in a header',
};
const authOf = (connection: Connection) => (connection.kind === 'service' ? AUTH_WORDS[connection.auth.type] : "the channel's address");

function withConnections(definition: Definition, connections: Record<string, Connection>): Definition {
  return { ...definition, connections };
}

/** The app's connections, in the draft: services its flows call, and Teams channels its notices post to. */
export function ConnectionsDesigner({ definition, onChange }: Props) {
  const connections = definition.connections ?? {};
  const names = Object.keys(connections);
  const [chosen, setChosen] = useState<string | null>(names[0] ?? null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<Connection['kind']>('service');
  const name = chosen && connections[chosen] ? chosen : (names[0] ?? null);
  const connection = name ? connections[name] : undefined;
  const update = (next: Connection) => name && onChange(withConnections(definition, { ...connections, [name]: next }));
  return (
    <div className="grid gap-4 @min-[62rem]:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="grid content-start gap-3">
        {names.length ? (
          <ul className="hooks" aria-label="Connections">
            {names.map((each) => {
              const spec = connections[each]!;
              return (
                <li key={each} className="card hook" aria-current={each === name ? 'true' : undefined}>
                  <div className="hook-head">
                    <div className="hook-what">
                      <button type="button" className="link text-left font-semibold" onClick={() => setChosen(each)}>
                        {spec.label}
                      </button>
                      <span className="mono hook-url">{spec.kind === 'service' ? spec.url : 'A Teams channel'}</span>
                      <span className="item-about">
                        {spec.kind === 'service' ? `Flows call it, with ${authOf(spec)}` : 'Notices post to it'}
                        {spec.kind === 'service' && spec.personalData ? ' · it takes personal data' : ''}
                      </span>
                    </div>
                    <Badge tone={spec.kind === 'service' ? 'outside' : 'idle'}>{spec.kind === 'service' ? 'Service' : 'Teams'}</Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No connections yet">Add a service that flows call, or a Teams channel that notices post to.</EmptyState>
        )}
        <div className="flex flex-wrap gap-2">
          <TextInput aria-label="New connection" className="w-56" placeholder="e.g. Payroll" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Select aria-label="New connection: kind" className="w-auto" value={kind} onChange={(e) => setKind(e.target.value === 'teams' ? 'teams' : 'service')}>
            <option value="service">A service</option>
            <option value="teams">A Teams channel</option>
          </Select>
          <Button
            size="sm"
            disabled={!label.trim()}
            onClick={() => {
              const added = toName(label, names);
              const spec: Connection =
                kind === 'service'
                  ? { kind, label: label.trim(), url: 'https://api.example.com', auth: { type: 'bearer' }, personalData: false }
                  : { kind, label: label.trim() };
              onChange(withConnections(definition, { ...connections, [added]: spec }));
              setChosen(added);
              setLabel('');
            }}
          >
            Add connection
          </Button>
        </div>
      </div>
      {connection && name ? (
        <Card className="grid content-start gap-3 p-4" aria-label="Connection">
          <h3 className="m-0 text-base font-semibold">{connection.label}</h3>
          <Field label="Label">
            {(id) => <TextInput id={id} value={connection.label} onChange={(e) => update({ ...connection, label: e.target.value })} />}
          </Field>
          {connection.kind === 'service' ? (
            <>
              <Field label="Address" hint="Every call goes under it. Keep secrets out of it: each environment keeps its own.">
                {(id) => (
                  <TextInput id={id} className="font-mono" value={connection.url} onChange={(e) => update({ ...connection, url: e.target.value.trim() })} />
                )}
              </Field>
              <Field label="How it knows the app">
                {(id) => (
                  <Select
                    id={id}
                    value={connection.auth.type}
                    onChange={(e) => {
                      const type = e.target.value;
                      const auth: ConnectionAuth =
                        type === 'none'
                          ? { type }
                          : type === 'basic'
                            ? { type, user: 'a3t' }
                            : type === 'header'
                              ? { type, header: 'X-Api-Key' }
                              : { type: 'bearer' };
                      update({ ...connection, auth });
                    }}
                  >
                    {Object.entries(AUTH_WORDS).map(([type, words]) => (
                      <option key={type} value={type}>
                        {words.charAt(0).toUpperCase() + words.slice(1)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {connection.auth.type === 'basic' ? (
                <Field label="User name">
                  {(id) => (
                    <TextInput
                      id={id}
                      value={connection.auth.type === 'basic' ? connection.auth.user : ''}
                      onChange={(e) => update({ ...connection, auth: { type: 'basic', user: e.target.value } })}
                    />
                  )}
                </Field>
              ) : null}
              {connection.auth.type === 'header' ? (
                <Field label="Header">
                  {(id) => (
                    <TextInput
                      id={id}
                      className="font-mono"
                      value={connection.auth.type === 'header' ? connection.auth.header : ''}
                      onChange={(e) => update({ ...connection, auth: { type: 'header', header: e.target.value.trim() } })}
                    />
                  )}
                </Field>
              ) : null}
              <Checkbox label="It takes personal data" checked={connection.personalData} onChange={(personalData) => update({ ...connection, personalData })} />
              <p className="m-0 text-xs text-muted">Only then may flows send it fields that hold personal data. A change request shows it.</p>
            </>
          ) : (
            <p className="m-0 text-sm text-muted">Each environment keeps the channel's incoming webhook address, as its secret. An inform step posts to it.</p>
          )}
          <Button
            variant="danger"
            className="justify-self-start"
            onClick={() => {
              const rest = Object.fromEntries(Object.entries(connections).filter(([key]) => key !== name));
              onChange(withConnections(definition, rest));
              setChosen(null);
            }}
          >
            Remove the connection
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

/** The app's webhooks, in the draft: ways in that run a flow with input from the request. */
export function WebhooksDesigner({ definition, onChange }: Props) {
  const hooks = definition.webhooks ?? {};
  const names = Object.keys(hooks);
  const [label, setLabel] = useState('');
  const flows = Object.entries(definition.flows ?? {});
  const update = (name: string, hook: Webhook) => onChange({ ...definition, webhooks: { ...hooks, [name]: hook } });
  return (
    <div className="grid gap-3">
      {names.length ? (
        <ul className="hooks" aria-label="Webhooks">
          {names.map((name) => {
            const hook = hooks[name]!;
            const flow = definition.flows?.[hook.flow];
            return (
              <li key={name} className="card hook">
                <div className="hook-head">
                  <div className="hook-what">
                    <strong>{hook.label}</strong>
                    <span className="item-about">Other systems run {flow?.label ?? 'a flow'} through it, with the app's authority</span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove the webhook ${hook.label}`}
                    onClick={() => onChange({ ...definition, webhooks: Object.fromEntries(Object.entries(hooks).filter(([key]) => key !== name)) })}
                  >
                    ✕
                  </Button>
                </div>
                <Field label="The flow it runs">
                  {(id) => (
                    <Select id={id} value={hook.flow} onChange={(e) => update(name, { ...hook, flow: e.target.value, input: {} })}>
                      <option value="" disabled>
                        Choose a flow
                      </option>
                      {flows.map(([key, each]) => (
                        <option key={key} value={key}>
                          {each.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {Object.keys(flow?.input ?? {}).map((input) => (
                  <Field key={input} label={`${input}, from the request`} hint="A place in its JSON, such as order.id. A record comes by its ID.">
                    {(id) => (
                      <TextInput
                        id={id}
                        className="font-mono"
                        value={hook.input[input] ?? ''}
                        onChange={(e) => update(name, { ...hook, input: { ...hook.input, [input]: e.target.value.trim() } })}
                      />
                    )}
                  </Field>
                ))}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No webhooks yet">A webhook lets another system run a flow, signing each request with a key that each environment keeps.</EmptyState>
      )}
      <div className="flex flex-wrap gap-2">
        <TextInput aria-label="New webhook" className="w-56" placeholder="e.g. From payroll" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button
          size="sm"
          disabled={!label.trim()}
          onClick={() => {
            const name = toName(label, names);
            onChange({ ...definition, webhooks: { ...hooks, [name]: { label: label.trim(), flow: flows[0]?.[0] ?? '', input: {} } } });
            setLabel('');
          }}
        >
          Add webhook
        </Button>
      </div>
    </div>
  );
}

/**
 * The secrets an environment keeps for what is saved: each connection's, and each webhook's key.
 * Nothing shows a secret again; a webhook's new key shows once.
 */
export function IntegrationSecrets({
  appId,
  team,
  part,
  revision,
}: {
  appId: string;
  team: boolean;
  part: 'connections' | 'webhooks' /** The saved revision: what the environment keeps secrets for changes with it. */;
  revision: number;
}) {
  const client = useQueryClient();
  const [env, setEnv] = useState<'staging' | 'prod'>('staging');
  const target: AppAt = team ? { id: appId, env } : { id: appId };
  const status = useQuery({ queryKey: ['integration', appId, team ? env : 'sandbox', revision], queryFn: () => api.integration(target), retry: false });
  const refresh = () => void client.invalidateQueries({ queryKey: ['integration', appId] });
  return (
    <Card className="grid gap-3 p-4" aria-label="Secrets">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{part === 'connections' ? 'Their secrets' : 'Their keys'}</h3>
        {team ? (
          <Modes label="Environment">
            <button type="button" aria-pressed={env === 'staging'} onClick={() => setEnv('staging')}>
              Staging
            </button>
            <button type="button" aria-pressed={env === 'prod'} onClick={() => setEnv('prod')}>
              Prod
            </button>
          </Modes>
        ) : null}
      </div>
      <p className="m-0 text-sm text-muted">
        {team ? 'Each environment keeps its own, for what it runs.' : 'Your sandbox keeps them, for what is saved.'} Nothing shows a secret again, and a flow
        never sees one.
      </p>
      {status.error ? <Notice tone="warn">{status.error instanceof ApiError ? status.error.message : 'The environment can’t be reached'}</Notice> : null}
      {status.data ? (
        part === 'connections' ? (
          <ConnectionSecrets target={target} status={status.data} onDone={refresh} />
        ) : (
          <WebhookKeys target={target} status={status.data} onDone={refresh} />
        )
      ) : null}
    </Card>
  );
}

function ConnectionSecrets({ target, status, onDone }: { target: AppAt; status: IntegrationStatus; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const keep = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) => api.setConnectionSecret(target, name, value),
    onSuccess: (_, { name }) => {
      setValues((now) => ({ ...now, [name]: '' }));
      onDone();
    },
  });
  const clear = useMutation({ mutationFn: (name: string) => api.clearConnectionSecret(target, name), onSuccess: onDone });
  if (!status.connections.length) return <p className="m-0 text-sm text-faint">Save a connection first; then keep its secret here.</p>;
  return (
    <ul className="hooks">
      {status.connections.map((connection) => (
        <li key={connection.name} className="card hook">
          <div className="hook-head">
            <div className="hook-what">
              <strong>{connection.label}</strong>
              <span className="item-about">
                {connection.needsSecret
                  ? connection.secret.set
                    ? `A secret is kept, since ${new Date(connection.secret.setAt!).toLocaleString()}`
                    : 'No secret yet: its calls fail until one is kept'
                  : 'It needs no secret'}
              </span>
            </div>
            {connection.needsSecret ? <Badge tone={connection.secret.set ? 'good' : 'warn'}>{connection.secret.set ? 'Kept' : 'Missing'}</Badge> : null}
          </div>
          {connection.needsSecret ? (
            <div className="flex flex-wrap gap-2">
              <TextInput
                type="password"
                autoComplete="off"
                aria-label={`${connection.label}: ${connection.kind === 'teams' ? "the channel's address" : 'the secret'}`}
                className="w-64"
                placeholder={connection.kind === 'teams' ? 'https://…' : 'The token, password or key'}
                value={values[connection.name] ?? ''}
                onChange={(e) => setValues((now) => ({ ...now, [connection.name]: e.target.value }))}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!values[connection.name] || keep.isPending}
                onClick={() => keep.mutate({ name: connection.name, value: values[connection.name]! })}
              >
                Keep it
              </Button>
              {connection.secret.set ? (
                <Button size="sm" variant="ghost" onClick={() => clear.mutate(connection.name)}>
                  Remove it
                </Button>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
      {keep.error ? <Notice tone="bad">{keep.error instanceof ApiError ? keep.error.message : 'Something went wrong'}</Notice> : null}
    </ul>
  );
}

function WebhookKeys({ target, status, onDone }: { target: AppAt; status: IntegrationStatus; onDone: () => void }) {
  const [made, setMade] = useState<{ name: string; key: string; url: string } | null>(null);
  const make = useMutation({
    mutationFn: (name: string) => api.makeWebhookKey(target, name),
    onSuccess: (result, name) => {
      setMade({ name, ...result });
      onDone();
    },
  });
  if (!status.webhooks.length) return <p className="m-0 text-sm text-faint">Save a webhook first; then make its key here.</p>;
  return (
    <>
      <ul className="hooks">
        {status.webhooks.map((hook) => (
          <li key={hook.name} className="card hook">
            <div className="hook-head">
              <div className="hook-what">
                <span className="mono hook-url">{hook.url}</span>
                <span className="item-about">
                  {hook.secret.set
                    ? `${hook.label} · a key is kept, since ${new Date(hook.secret.setAt!).toLocaleString()}`
                    : `${hook.label} · no key yet: it takes no request`}
                </span>
              </div>
              <Badge tone={hook.secret.set ? 'good' : 'warn'}>{hook.secret.set ? 'Takes requests' : 'No key'}</Badge>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={make.isPending} onClick={() => make.mutate(hook.name)}>
                {hook.secret.set ? 'Make a new key' : 'Make its key'}
              </Button>
            </div>
            {made?.name === hook.name ? (
              <Notice tone="good">
                Its key, shown this once: <code className="break-all">{made.key}</code>. Give it to the other system, which signs each request with it.
              </Notice>
            ) : null}
          </li>
        ))}
      </ul>
      <dl className="facts-list">
        <div className="pair">
          <dt>Signed</dt>
          <dd>
            <code>X-A3T-Timestamp</code>: the time, in seconds. <code>X-A3T-Signature</code>: <code>sha256=</code> and the HMAC-SHA256, in hex, of the time, a
            dot and the body, under the key.
          </dd>
        </div>
        <div className="pair">
          <dt>Fresh</dt>
          <dd>A request signed more than five minutes before or after it arrives is refused, so a copy can't be sent again later.</dd>
        </div>
      </dl>
    </>
  );
}
