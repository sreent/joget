import type { FlowRun } from '@platform/app-model';
import { Field, Notice, Select } from '../components/ui.js';
import { startRun, typeText } from '../model/flows.js';
import type { Definition } from '../types.js';
import { ValueEditor, type ValueMode } from './ValueEditor.js';

/*
 * The flow that an action or a process task runs (design §6.2), and what it gives the flow's
 * inputs: the record itself, or values worked out from the record.
 */

const WITH_PERSON: readonly ValueMode[] = ['field', 'fixed', 'calc', 'join', 'person', 'today', 'now'];
const WITHOUT_PERSON: readonly ValueMode[] = ['field', 'fixed', 'calc', 'join', 'today', 'now'];

export function FlowRunEditor(props: {
  definition: Definition;
  /** The entity of the record that the action or the process works on. */
  entity: string;
  /** True where a person runs it: a process task runs a flow with no person. */
  person: boolean;
  label: string;
  hint?: string;
  /** What the choice of no flow reads; without it, a flow must be chosen. */
  none?: string;
  value: FlowRun | undefined;
  onChange: (value: FlowRun | undefined) => void;
}) {
  const { definition, entity, person, value, onChange } = props;
  const flows = Object.entries(definition.flows ?? {});
  const flow = value ? definition.flows?.[value.flow] : undefined;
  const record = definition.entities[entity]?.label ?? entity;
  return (
    <div className="grid gap-2">
      <Field label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
        {(id) => (
          <Select id={id} value={value?.flow ?? ''} onChange={(e) => onChange(e.target.value ? startRun(definition, e.target.value, entity) : undefined)}>
            {props.none !== undefined ? <option value="">{props.none}</option> : <option value="" disabled>Choose a flow</option>}
            {value && !flow ? (
              <option value={value.flow} disabled>
                {value.flow} (gone)
              </option>
            ) : null}
            {flows.map(([name, spec]) => (
              <option key={name} value={name}>
                {spec.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {value && flow
        ? Object.entries(flow.input).map(([input, type]) => {
            if (type.type === 'record') {
              return type.entity === entity ? (
                <p key={input} className="m-0 text-sm text-muted">
                  <code>{input}</code> is the {record.toLowerCase()} itself.
                </p>
              ) : (
                <Notice key={input} tone="warn">
                  {input} takes {typeText(definition, type)}, but this works on a {record.toLowerCase()}.
                </Notice>
              );
            }
            if (type.type === 'list') {
              return (
                <Notice key={input} tone="warn">
                  {input} takes {typeText(definition, type)}, which a record can't give.
                </Notice>
              );
            }
            return (
              <Field key={input} label={`${input} (${typeText(definition, type)})`}>
                {() => (
                  <ValueEditor
                    definition={definition}
                    entity={entity}
                    label={input}
                    value={value.input[input] ?? null}
                    only={person ? WITH_PERSON : WITHOUT_PERSON}
                    onChange={(next) => onChange({ ...value, input: { ...value.input, [input]: next } })}
                  />
                )}
              </Field>
            );
          })
        : null}
    </div>
  );
}
