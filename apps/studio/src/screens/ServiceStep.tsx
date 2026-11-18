import type { Expression, FlowStep } from '@platform/app-model';
import { useState } from 'react';
import { Button, Field, Select, TextInput } from '../components/ui.js';
import type { Definition } from '../types.js';
import { ValueEditor, type ValueMode, type ValueSources } from './ValueEditor.js';

/*
 * The step that calls a service (design §6.13): which connection, how and where, what it sends,
 * and the variables its answer gives, each from a place in the answer's JSON, of a kind.
 */

type CallStep = Extract<FlowStep, { type: 'call_service' }>;
type ResultType = CallStep['results'][string]['type'];

const METHODS: readonly CallStep['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const TYPES: ReadonlyArray<{ readonly value: ResultType; readonly label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'A number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'date', label: 'A date' },
  { value: 'datetime', label: 'A time' },
];
const TEXT: readonly ValueMode[] = ['fixed', 'field', 'join', 'text', 'first', 'choose'];
const ANY: readonly ValueMode[] = ['fixed', 'field', 'calc', 'join', 'today', 'now', 'shift', 'between', 'choose', 'text', 'first'];
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Values by name: what a call sends as its query or its body. */
function NamedValues(props: { definition: Definition; label: string; values: Readonly<Record<string, Expression>>; sources: ValueSources; onChange: (values: Record<string, Expression>) => void }) {
  const { definition, label, values, sources, onChange } = props;
  const [name, setName] = useState('');
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm text-muted">{label}</legend>
      {Object.entries(values).map(([key, value]) => (
        <div key={key} className="grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <code className="text-sm">{key}</code>
            <Button size="sm" variant="ghost" aria-label={`${label}: remove ${key}`} onClick={() => onChange(Object.fromEntries(Object.entries(values).filter(([k]) => k !== key)))}>
              ✕
            </Button>
          </div>
          <ValueEditor definition={definition} entity="" label={`${label}: ${key}`} value={value} from={sources} only={ANY} onChange={(next) => onChange({ ...values, [key]: next })} />
        </div>
      ))}
      <div className="flex gap-2">
        <TextInput aria-label={`${label}: new name`} className="w-40 font-mono" placeholder="e.g. customer" value={name} onChange={(e) => setName(e.target.value.trim())} />
        <Button
          size="sm"
          disabled={!/^[A-Za-z0-9_]{1,63}$/.test(name) || name in values}
          onClick={() => {
            onChange({ ...values, [name]: '' });
            setName('');
          }}
        >
          Add
        </Button>
      </div>
    </fieldset>
  );
}

export function CallServiceFields(props: { definition: Definition; step: CallStep; sources: ValueSources; set: (step: FlowStep) => void }) {
  const { definition, step, sources, set } = props;
  const services = Object.entries(definition.connections ?? {}).filter(([, connection]) => connection.kind === 'service');
  const connection = definition.connections?.[step.connection];
  const [result, setResult] = useState('');
  const sends = step.method !== 'GET';
  return (
    <>
      <Field label="The service" hint={connection?.kind === 'service' ? `It calls ${connection.url}, which its connection names.` : 'Add a connection under Flows, Connections, first.'}>
        {(id) => (
          <Select id={id} value={step.connection} onChange={(e) => set({ ...step, connection: e.target.value })}>
            <option value="" disabled>
              Choose a connection
            </option>
            {services.map(([name, each]) => (
              <option key={name} value={name}>
                {each.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="How">
        {(id) => (
          <Select
            id={id}
            className="w-auto"
            value={step.method}
            onChange={(e) => {
              const method = METHODS.find((each) => each === e.target.value) ?? 'GET';
              // A GET sends nothing in its body.
              const { body: _body, ...rest } = step;
              set(method === 'GET' ? { ...rest, method } : { ...step, method, body: step.body ?? {} });
            }}
          >
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Where" hint="Under the connection's address, such as /customers/42.">
        {() => <ValueEditor definition={definition} entity="" label="Path" value={step.path} from={sources} only={TEXT} onChange={(path) => set({ ...step, path })} />}
      </Field>
      <NamedValues definition={definition} label="The query" values={step.query} sources={sources} onChange={(query) => set({ ...step, query })} />
      {sends ? <NamedValues definition={definition} label="What it sends" values={step.body ?? {}} sources={sources} onChange={(body) => set({ ...step, body })} /> : null}
      <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm text-muted">What its answer gives</legend>
        {Object.entries(step.results).map(([name, each]) => (
          <div key={name} className="grid gap-1 rounded-md border border-line p-2">
            <div className="flex items-center justify-between gap-2">
              <code className="text-sm">{name}</code>
              <Button size="sm" variant="ghost" aria-label={`Remove the variable ${name}`} onClick={() => set({ ...step, results: Object.fromEntries(Object.entries(step.results).filter(([k]) => k !== name)) })}>
                ✕
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <TextInput
                aria-label={`${name}: from`}
                className="w-48 font-mono"
                placeholder="data.id"
                value={each.from}
                onChange={(e) => set({ ...step, results: { ...step.results, [name]: { ...each, from: e.target.value.trim() } } })}
              />
              <Select aria-label={`${name}: kind`} className="w-auto" value={each.type} onChange={(e) => set({ ...step, results: { ...step.results, [name]: { ...each, type: TYPES.find((type) => type.value === e.target.value)?.value ?? 'text' } } })}>
                {TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <TextInput aria-label="New variable" className="w-40 font-mono" placeholder="e.g. customer_id" value={result} onChange={(e) => setResult(e.target.value.trim())} />
          <Button
            size="sm"
            disabled={!NAME.test(result) || result in step.results}
            onClick={() => {
              set({ ...step, results: { ...step.results, [result]: { from: '', type: 'text' } } });
              setResult('');
            }}
          >
            Keep a value
          </Button>
        </div>
        <p className="m-0 text-xs text-muted">Each is a place in the answer's JSON, such as data.items.0.id. An answer that isn't a success stops the flow, unless an error handler catches it.</p>
      </fieldset>
      {sends ? <p className="m-0 text-xs text-muted">Trying the flow doesn't make this call: a {step.method} changes something there for real.</p> : null}
    </>
  );
}
