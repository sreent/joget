import { type FlowType, flowWaits } from '@platform/app-model';
import { useState } from 'react';
import { Button, Card, Field, Select, TextInput } from '../components/ui.js';
import { flowEntities, updateFlow } from '../model/flows.js';
import type { Definition } from '../types.js';

/* A flow's own settings: its label, its inputs and its result; and the processes from before flows could wait. */

const TYPES: ReadonlyArray<{ value: FlowType['type']; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'A number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'date', label: 'A date' },
  { value: 'datetime', label: 'A time' },
  { value: 'record', label: 'A record' },
  { value: 'list', label: 'A list of records' },
];

function typeOf(value: string, entity: string): FlowType {
  if (value === 'record' || value === 'list') return { type: value, entity };
  return { type: value as Exclude<FlowType['type'], 'record' | 'list'> };
}

function TypePicker({
  definition,
  label,
  value,
  onChange,
  none,
}: {
  definition: Definition;
  label: string;
  value: FlowType | undefined;
  onChange: (value: FlowType | undefined) => void;
  none?: string;
}) {
  const entities = flowEntities(definition);
  const entity = value && (value.type === 'record' || value.type === 'list') ? value.entity : (entities[0] ?? '');
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        aria-label={label}
        className="w-auto"
        value={value?.type ?? ''}
        onChange={(e) => onChange(e.target.value ? typeOf(e.target.value, entity) : undefined)}
      >
        {none ? <option value="">{none}</option> : null}
        {TYPES.map((type) => (
          <option key={type.value} value={type.value}>
            {type.label}
          </option>
        ))}
      </Select>
      {value && (value.type === 'record' || value.type === 'list') ? (
        <Select aria-label={`${label}: entity`} className="w-auto" value={value.entity} onChange={(e) => onChange(typeOf(value.type, e.target.value))}>
          {entities.map((each) => (
            <option key={each} value={each}>
              {definition.entities[each]!.label}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

export function FlowSettings({
  definition,
  name,
  readOnly,
  onChange,
  onRemove,
}: {
  definition: Definition;
  name: string;
  readOnly: boolean;
  onChange: (definition: Definition) => void;
  onRemove: () => void;
}) {
  const flow = definition.flows![name]!;
  const [input, setInput] = useState('');
  return (
    <Card className="grid gap-3 p-4" aria-label="Flow">
      <h3 className="m-0 text-base font-semibold">Flow</h3>
      <Field label="Label">
        {(id) => <TextInput id={id} value={flow.label} onChange={(e) => onChange(updateFlow(definition, name, { label: e.target.value }))} />}
      </Field>
      <Field label="What it does" hint="For builders and reviewers.">
        {(id) => (
          <textarea
            id={id}
            className="min-h-16 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5"
            value={flow.description ?? ''}
            onChange={(e) => onChange(updateFlow(definition, name, { description: e.target.value }))}
          />
        )}
      </Field>
      <div className="grid gap-2">
        <span className="text-sm text-muted">Input</span>
        {Object.entries(flow.input).map(([key, type]) => (
          <div key={key} className="grid gap-1.5 rounded-md border border-line p-2">
            <div className="flex items-center justify-between gap-2">
              <code className="text-sm">{key}</code>
              {readOnly ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove the input ${key}`}
                  onClick={() => onChange(updateFlow(definition, name, { input: Object.fromEntries(Object.entries(flow.input).filter(([k]) => k !== key)) }))}
                >
                  ✕
                </Button>
              )}
            </div>
            <TypePicker
              definition={definition}
              label={`Input ${key}`}
              value={type}
              onChange={(next) => next && onChange(updateFlow(definition, name, { input: { ...flow.input, [key]: next } }))}
            />
          </div>
        ))}
        {readOnly ? null : (
          <div className="flex gap-2">
            <TextInput
              aria-label="New input"
              className="w-40 font-mono"
              placeholder="e.g. claim"
              value={input}
              onChange={(e) => setInput(e.target.value.trim())}
            />
            <Button
              size="sm"
              disabled={!/^[a-z][a-z0-9_]{0,62}$/.test(input) || input in flow.input}
              onClick={() => {
                onChange(updateFlow(definition, name, { input: { ...flow.input, [input]: { type: 'text' } } }));
                setInput('');
              }}
            >
              Add an input
            </Button>
          </div>
        )}
      </div>
      {flowWaits(flow, definition.flows) ? null : (
        <Field label="Result">
          {() => (
            <TypePicker
              definition={definition}
              label="Result"
              value={flow.output}
              none="No result"
              onChange={(output) => onChange(updateFlow(definition, name, { output }))}
            />
          )}
        </Field>
      )}
      {readOnly ? null : (
        <Button variant="danger" className="justify-self-start" onClick={onRemove}>
          Delete the flow
        </Button>
      )}
    </Card>
  );
}

/** Processes from before flows could wait: they still run, and a builder rebuilds each as a flow that waits. */
export function EarlierProcesses({
  definition,
  readOnly,
  onChange,
}: {
  definition: Definition;
  readOnly: boolean;
  onChange: (definition: Definition) => void;
}) {
  const processes = Object.entries(definition.processes ?? {});
  if (!processes.length) return null;
  return (
    <Card className="grid gap-2 p-4" aria-label="Processes from before">
      <h3 className="m-0 text-base font-semibold">Processes from before</h3>
      <p className="m-0 text-sm text-muted">
        This app has processes from before flows could wait. They still run, but a3t no longer draws them: rebuild each as a flow that waits, then remove it.
      </p>
      {processes.map(([name, process]) => (
        <div key={name} className="flex items-center justify-between gap-2 text-sm">
          <span>{process.label}</span>
          {readOnly ? null : (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const rest = Object.fromEntries(Object.entries(definition.processes ?? {}).filter(([other]) => other !== name));
                const roles = Object.fromEntries(
                  Object.entries(definition.roles).map(([role, spec]) => [
                    role,
                    spec.processes ? { ...spec, processes: spec.processes.filter((each) => each !== name) } : spec,
                  ]),
                );
                onChange({ ...definition, processes: rest, roles });
              }}
            >
              Remove {process.label}
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}
