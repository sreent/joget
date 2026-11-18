import { type FlowStep, type FlowType, flowSubject, type VarKind, type WaitFor } from '@platform/app-model';
import { useState } from 'react';
import { ConditionEditor } from '../components/condition.js';
import { DateShift, DurationInput } from '../components/duration.js';
import { Button, Field, Select, TextInput } from '../components/ui.js';
import type { RefChoice } from '../model/conditions.js';
import { typeText, updateActionsOf } from '../model/flows.js';
import { type Definition, type Field as FieldDef, isWorkedOut } from '../types.js';
import { ValueEditor, type ValueMode, type ValueSources } from './ValueEditor.js';

/* What steps take: what a wait waits for, the values of a flow's inputs, and the values of a record's fields. */

export const ANY_VALUE: readonly ValueMode[] = ['fixed', 'field', 'calc', 'join', 'person', 'today', 'now', 'shift', 'between', 'choose', 'text', 'first'];

/** The ways to give words: what a notice says. */
export const TEXT_VALUE: readonly ValueMode[] = ['fixed', 'field', 'join', 'text', 'first', 'choose'];

/** What a wait waits for: a time, a date of the record, an action on it, a condition on it, or a signal. */
export function WaitForEditor(props: {
  definition: Definition;
  name: string;
  label: string;
  variables: RefChoice[];
  value: WaitFor;
  onChange: (wait: WaitFor) => void;
}) {
  const { definition, name, label, variables, value, onChange } = props;
  const entity = flowSubject(definition.flows![name]!)?.entity;
  const dates = (entity ? (definition.entities[entity]?.fields ?? []) : []).filter((field) => field.type === 'date' || field.type === 'datetime');
  const actions = updateActionsOf(definition, entity);
  const kind = 'duration' in value ? 'duration' : 'date' in value ? 'date' : 'action' in value ? 'action' : 'condition' in value ? 'condition' : 'signal';
  const fresh = (next: string): WaitFor => {
    if (next === 'date' && dates[0]) return { date: dates[0].name };
    if (next === 'action' && actions[0]) return { action: actions[0] };
    if (next === 'condition') return { condition: { exists: variables[0]?.ref ?? 'id' } };
    if (next === 'signal') return { signal: 'go' };
    return { duration: 'P1D' };
  };
  return (
    <>
      <Field label={label}>
        {(id) => (
          <Select id={id} value={kind} onChange={(e) => onChange(fresh(e.target.value))}>
            <option value="duration">A time</option>
            <option value="date" disabled={!dates.length}>
              A date of the record
            </option>
            <option value="action" disabled={!actions.length}>
              An action on the record
            </option>
            <option value="condition">A condition on the record</option>
            <option value="signal">A signal</option>
          </Select>
        )}
      </Field>
      {'duration' in value ? <DurationInput label="For" value={value.duration} onChange={(duration) => onChange({ duration })} /> : null}
      {'date' in value ? (
        <>
          <Field label="Until">
            {(id) => (
              <Select id={id} value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })}>
                {dates.map((field) => (
                  <option key={field.name} value={field.name}>
                    The record's {field.label.toLowerCase()}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <DateShift label="When" value={value} onChange={(shift) => onChange({ date: value.date, ...shift })} />
        </>
      ) : null}
      {'action' in value ? (
        <Field label="Until someone runs" hint="An update action on the record, such as withdrawing it.">
          {(id) => (
            <Select id={id} value={value.action} onChange={(e) => onChange({ action: e.target.value })}>
              {actions.map((action) => (
                <option key={action} value={action}>
                  {definition.actions[action]!.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {'condition' in value ? (
        <ConditionEditor
          label="Until it holds that"
          value={value.condition}
          choices={variables}
          compareWith={variables}
          onChange={(condition) => onChange({ condition: condition ?? value.condition })}
        />
      ) : null}
      {'signal' in value ? (
        <Field label="The signal" hint="An operator, or another flow, throws it by name.">
          {(id) => <TextInput id={id} className="font-mono" value={value.signal} onChange={(e) => onChange({ signal: e.target.value.trim() })} />}
        </Field>
      ) : null}
    </>
  );
}

/** A value for an input or a result: a value, or a variable that holds a record or a list of the type. */
export function InputValue(props: {
  definition: Definition;
  input: string;
  type: FlowType;
  value: FlowStep extends never ? never : unknown;
  scope: ReadonlyMap<string, VarKind>;
  sources: ValueSources;
  onChange: (value: never) => void;
}) {
  const { definition, input, type, scope, sources } = props;
  const onChange = props.onChange as (value: unknown) => void;
  if (type.type === 'record' || type.type === 'list') {
    const fitting = [...scope].filter(([, kind]) => kind.kind === type.type && kind.entity === type.entity).map(([variable]) => variable);
    const current = typeof props.value === 'object' && props.value !== null && 'ref' in props.value ? String((props.value as { ref: string }).ref) : '';
    return (
      <Field label={`${input} (${typeText(definition, type)})`}>
        {(id) => (
          <Select id={id} value={current} onChange={(e) => onChange({ ref: e.target.value })}>
            <option value="" disabled>
              Choose a variable
            </option>
            {fitting.map((variable) => (
              <option key={variable} value={variable}>
                {variable}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  return (
    <Field label={`${input} (${typeText(definition, type)})`}>
      {() => (
        <ValueEditor
          definition={definition}
          entity=""
          label={input}
          value={(props.value ?? null) as never}
          from={sources}
          only={ANY_VALUE}
          onChange={(value) => onChange(value)}
        />
      )}
    </Field>
  );
}

/** Values for a record's fields: the fields a flow can write, each with where its value comes from. */
export function ValuesEditor(props: {
  definition: Definition;
  entity: string;
  line?: boolean;
  values: Readonly<Record<string, unknown>>;
  sources: ValueSources;
  onChange: (values: Record<string, never>) => void;
}) {
  const { definition, entity, values, sources } = props;
  const onChange = props.onChange as (values: Record<string, unknown>) => void;
  const fields = (definition.entities[entity]?.fields ?? []).filter((field) => field.type !== 'lines' && field.type !== 'file' && !isWorkedOut(field));
  const unset = fields.filter((field) => !(field.name in values));
  const [adding, setAdding] = useState('');
  return (
    <div className="grid gap-2">
      <span className="text-sm text-muted">Values</span>
      {Object.entries(values).map(([field, value]) => {
        const target = fields.find((f) => f.name === field) as FieldDef | undefined;
        return (
          <div key={field} className="grid gap-1 rounded-md border border-line p-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{target?.label ?? field}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove the value of ${target?.label ?? field}`}
                onClick={() => onChange(Object.fromEntries(Object.entries(values).filter(([key]) => key !== field)))}
              >
                ✕
              </Button>
            </div>
            <ValueEditor
              definition={definition}
              entity=""
              {...(target ? { target } : {})}
              label={target?.label ?? field}
              value={value as never}
              from={sources}
              onChange={(next) => onChange({ ...values, [field]: next })}
            />
          </div>
        );
      })}
      {unset.length ? (
        <div className="flex gap-2">
          <Select aria-label="Field to give a value" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="" disabled>
              Give a field a value
            </option>
            {unset.map((field) => (
              <option key={field.name} value={field.name}>
                {field.label}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={!adding}
            onClick={() => {
              const target = fields.find((f) => f.name === adding)!;
              onChange({ ...values, [adding]: target.type === 'number' ? 0 : target.type === 'boolean' ? false : '' });
              setAdding('');
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---- A flow's settings, and trying it
