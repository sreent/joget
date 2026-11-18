import { type FlowStep, flowWaits, type VarKind } from '@platform/app-model';
import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { Button, Card, Checkbox, Field, Notice, Select, TextInput } from '../components/ui.js';
import { type RefChoice, recordChoices } from '../model/conditions.js';
import {
  flowEntities,
  listChoices,
  moveStep,
  recordVariables,
  removeStep,
  replaceStep,
  STEP_GROUPS,
  STEP_NAMES,
  type StepType,
  scopeAt,
  stepAt,
  variableChoices,
} from '../model/flows.js';
import type { Definition } from '../types.js';
import { InformFields, TaskFields } from './PeopleSteps.js';
import { CallServiceFields } from './ServiceStep.js';
import { ANY_VALUE, InputValue, ValuesEditor, WaitForEditor } from './StepValues.js';
import { ValueEditor, type ValueSources } from './ValueEditor.js';

/* The step someone chose, open beside the canvas, and the choice of a new step. */

export function AddStep({
  waits,
  copied,
  onAdd,
  onPaste,
  onCancel,
}: {
  waits: boolean;
  copied: string | null;
  onAdd: (type: StepType) => void;
  onPaste: () => void;
  onCancel: () => void;
}) {
  return (
    <Card className="grid gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-base font-semibold">Add a step</h3>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {copied ? (
        <Button className="justify-self-start" onClick={onPaste} aria-keyshortcuts="Control+V Meta+V">
          Paste the {copied.toLowerCase()} step you copied
        </Button>
      ) : null}
      {STEP_GROUPS.map((group) => (
        <div key={group.label} className="grid gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-faint">{group.label}</span>
          <div className="grid grid-cols-2 gap-2">
            {group.types.map((type) => (
              <Button key={type} size="sm" disabled={group.waits && !waits} onClick={() => onAdd(type)}>
                {STEP_NAMES[type]}
              </Button>
            ))}
          </div>
          {group.waits && !waits ? (
            <p className="m-0 text-xs text-muted">
              A flow waits on one record, and not inside a loop or an error handler: give the flow one input, a record, in its settings.
            </p>
          ) : null}
        </div>
      ))}
    </Card>
  );
}

/** The sources a value can come from at a place in a flow: its variables, and their fields. */
function sourcesFor(definition: Definition, scope: ReadonlyMap<string, VarKind>): ValueSources {
  const choices = variableChoices(definition, scope);
  return {
    all: choices.map((choice) => ({ ref: choice.ref, label: choice.label })),
    numbers: choices.filter((choice) => choice.kind === 'number').map((choice) => ({ ref: choice.ref, label: choice.label })),
    dates: choices.filter((choice) => choice.kind === 'date').map((choice) => ({ ref: choice.ref, label: choice.label })),
    choices,
    label: 'A variable',
  };
}

export function StepEditor(props: {
  definition: Definition;
  name: string;
  path: string;
  problems: readonly string[];
  readOnly: boolean;
  copied: boolean;
  onCopy: () => void;
  onCut: () => void;
  onPasteAfter: () => void;
  onChange: (definition: Definition) => void;
  onRemoved: () => void;
  onMoved: (path: string) => void;
  onClosed: () => void;
}) {
  const { definition, name, path, readOnly, onChange } = props;
  const flow = definition.flows![name]!;
  const step = stepAt(flow, path)!;
  const scope = scopeAt(definition, name, { path });
  const set = (next: FlowStep) => onChange(replaceStep(definition, name, path, next));
  const sources = sourcesFor(definition, scope);
  const variables = variableChoices(definition, scope);
  const index = Number(/\[(\d+)\]$/.exec(path)![1]);
  const base = path.replace(/\[\d+\]$/, '');

  return (
    <Card className="grid gap-4 p-4" aria-label="Step">
      {props.problems.length ? (
        <Notice tone="bad">
          <ul className="m-0 grid gap-1 pl-4">
            {props.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{STEP_NAMES[step.type]}</h3>
        {readOnly ? null : (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Move the step up"
              onClick={() => {
                onChange(moveStep(definition, name, path, -1));
                props.onMoved(`${base}[${Math.max(0, index - 1)}]`);
              }}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Move the step down"
              onClick={() => {
                onChange(moveStep(definition, name, path, 1));
                props.onMoved(`${base}[${index + 1}]`);
              }}
            >
              ↓
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onCopy} aria-keyshortcuts="Control+C Meta+C">
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onCut} aria-keyshortcuts="Control+X Meta+X">
              Cut
            </Button>
            {props.copied ? (
              <Button size="sm" variant="ghost" onClick={props.onPasteAfter} aria-keyshortcuts="Control+V Meta+V">
                Paste after
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="danger"
              aria-label="Remove the step"
              onClick={() => {
                onChange(removeStep(definition, name, path));
                props.onRemoved();
              }}
            >
              Remove
            </Button>
            <Button size="sm" variant="ghost" aria-label="Close the step" onClick={props.onClosed}>
              ✕
            </Button>
          </div>
        )}
      </div>
      <StepFields definition={definition} name={name} step={step} scope={scope} sources={sources} variables={variables} set={set} />
    </Card>
  );
}

function VarName({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={label} hint="Lowercase letters, digits and underscores.">
      {(id) => <TextInput id={id} className="font-mono" value={value} onChange={(e) => onChange(e.target.value.trim())} />}
    </Field>
  );
}

function StepFields(props: {
  definition: Definition;
  name: string;
  step: FlowStep;
  scope: ReadonlyMap<string, VarKind>;
  sources: ValueSources;
  variables: RefChoice[];
  set: (step: FlowStep) => void;
}) {
  const { definition, name, step, scope, sources, variables, set } = props;
  const entities = flowEntities(definition);
  const records = recordVariables(scope);
  const lists = listChoices(definition, scope);
  const entityOf = (variable: string) => {
    const kind = scope.get(variable);
    return kind?.kind === 'record' ? kind.entity : undefined;
  };
  const recordPicker = (value: string, onPick: (value: string) => void) => (
    <Field label="Record">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onPick(e.target.value)}>
          <option value="" disabled>
            Choose a variable that holds a record
          </option>
          {records.map((record) => (
            <option key={record} value={record}>
              {record} ({definition.entities[entityOf(record)!]?.label})
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const listPicker = (label: string, value: string, onPick: (value: string) => void) => (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onPick(e.target.value)}>
          <option value="" disabled>
            Choose a list
          </option>
          {lists.map((list) => (
            <option key={list.value} value={list.value}>
              {list.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  switch (step.type) {
    case 'set':
      return (
        <>
          <VarName label="Variable" value={step.var} onChange={(value) => set({ ...step, var: value })} />
          <Field label="Value">
            {() => (
              <ValueEditor
                definition={definition}
                entity=""
                label="Value"
                value={step.value}
                from={sources}
                only={ANY_VALUE}
                onChange={(value) => set({ ...step, value })}
              />
            )}
          </Field>
        </>
      );
    case 'find':
      return (
        <>
          <Field label="Entity">
            {(id) => (
              <Select id={id} value={step.entity} onChange={(e) => set({ ...step, entity: e.target.value, where: undefined, sort: undefined })}>
                {entities.map((entity) => (
                  <option key={entity} value={entity}>
                    {definition.entities[entity]!.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ConditionEditor
            label="Which records"
            value={step.where}
            choices={recordChoices(definition, step.entity)}
            compareWith={[THE_PERSON, ...variables]}
            empty="Every record"
            onChange={(where) => set({ ...step, where })}
          />
          <Checkbox label="Only the first one, or none" checked={step.first === true} onChange={(first) => set({ ...step, first: first || undefined })} />
          <VarName label="Keep them in" value={step.var} onChange={(value) => set({ ...step, var: value })} />
          {step.first ? null : (
            <Field label="At most">
              {(id) => (
                <TextInput
                  id={id}
                  type="number"
                  min={1}
                  max={1000}
                  value={step.limit}
                  onChange={(e) => set({ ...step, limit: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
                />
              )}
            </Field>
          )}
        </>
      );
    case 'create':
      return (
        <>
          <Field label="Entity">
            {(id) => (
              <Select id={id} value={step.entity} onChange={(e) => set({ ...step, entity: e.target.value, values: {} })}>
                {entities.map((entity) => (
                  <option key={entity} value={entity}>
                    {definition.entities[entity]!.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ValuesEditor definition={definition} entity={step.entity} values={step.values} sources={sources} onChange={(values) => set({ ...step, values })} />
          <VarName label="Keep it in" value={step.var ?? ''} onChange={(value) => set({ ...step, var: value || undefined })} />
        </>
      );
    case 'change':
      return (
        <>
          {recordPicker(step.record, (record) => set({ ...step, record, values: {} }))}
          {entityOf(step.record) ? (
            <ValuesEditor
              definition={definition}
              entity={entityOf(step.record)!}
              values={step.values}
              sources={sources}
              onChange={(values) => set({ ...step, values })}
            />
          ) : null}
        </>
      );
    case 'delete':
      return (
        <>
          {recordPicker(step.record, (record) => set({ ...step, record }))}
          <p className="m-0 text-xs text-faint">Deleting stays with a person: a flow that a token runs can't delete.</p>
        </>
      );
    case 'add_line': {
      const holder = entityOf(step.record);
      const linesFields = holder ? definition.entities[holder]!.fields.filter((field) => field.type === 'lines') : [];
      const lineEntity = linesFields.find((field) => field.name === step.field);
      return (
        <>
          {recordPicker(step.record, (record) => set({ ...step, record, field: '', values: {} }))}
          <Field label="Lines">
            {(id) => (
              <Select id={id} value={step.field} onChange={(e) => set({ ...step, field: e.target.value, values: {} })}>
                <option value="" disabled>
                  Choose lines
                </option>
                {linesFields.map((field) => (
                  <option key={field.name} value={field.name}>
                    {field.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {lineEntity?.type === 'lines' ? (
            <ValuesEditor
              definition={definition}
              entity={lineEntity.entity}
              line
              values={step.values}
              sources={sources}
              onChange={(values) => set({ ...step, values })}
            />
          ) : null}
        </>
      );
    }
    case 'each':
      return (
        <>
          {listPicker('For each item of', step.in, (value) => set({ ...step, in: value }))}
          <VarName label="Call the item" value={step.as} onChange={(value) => set({ ...step, as: value })} />
        </>
      );
    case 'if':
      return (
        <ConditionEditor
          label="If"
          value={step.when}
          choices={variables}
          compareWith={[THE_PERSON, ...variables]}
          onChange={(when) => set({ ...step, when: when ?? step.when })}
        />
      );
    case 'repeat':
      return (
        <>
          <ConditionEditor
            label="Repeat while"
            value={step.while}
            choices={variables}
            compareWith={[THE_PERSON, ...variables]}
            onChange={(when) => set({ ...step, while: when ?? step.while })}
          />
          <Field label="At most" hint="It stops after this many times, even if the condition still holds.">
            {(id) => (
              <TextInput
                id={id}
                type="number"
                min={1}
                max={100}
                className="w-24"
                value={step.max}
                onChange={(e) => set({ ...step, max: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })}
              />
            )}
          </Field>
          <p className="m-0 text-xs text-muted">
            It checks the condition before each time round. In a flow that waits, its steps can wait, and the condition reads the record.
          </p>
        </>
      );
    case 'check':
      return (
        <>
          <ConditionEditor
            label="It must hold that"
            value={step.assert}
            choices={variables}
            compareWith={[THE_PERSON, ...variables]}
            onChange={(assert) => set({ ...step, assert: assert ?? step.assert })}
          />
          <Field label="Message">{(id) => <TextInput id={id} value={step.message} onChange={(e) => set({ ...step, message: e.target.value })} />}</Field>
          <Field label="When it doesn't hold">
            {(id) => (
              <Select id={id} value={step.severity} onChange={(e) => set({ ...step, severity: e.target.value === 'warning' ? 'warning' : 'error' })}>
                <option value="error">Stop the flow, and undo it</option>
                <option value="warning">Note a warning, and go on</option>
              </Select>
            )}
          </Field>
        </>
      );
    case 'call': {
      const callee = definition.flows?.[step.flow];
      return (
        <>
          <Field label="Flow">
            {(id) => (
              <Select id={id} value={step.flow} onChange={(e) => set({ ...step, flow: e.target.value, input: {} })}>
                <option value="" disabled>
                  Choose a flow
                </option>
                {Object.entries(definition.flows ?? {})
                  .filter(([other]) => other !== name)
                  .map(([other, spec]) => (
                    <option key={other} value={other}>
                      {spec.label}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          {callee
            ? Object.entries(callee.input).map(([input, type]) => (
                <InputValue
                  key={input}
                  definition={definition}
                  input={input}
                  type={type}
                  value={step.input[input]}
                  scope={scope}
                  sources={sources}
                  onChange={(value) => set({ ...step, input: { ...step.input, [input]: value } })}
                />
              ))
            : null}
          {callee?.output ? (
            <VarName label="Keep its result in" value={step.var ?? ''} onChange={(value) => set({ ...step, var: value || undefined })} />
          ) : null}
        </>
      );
    }
    case 'try':
      return (
        <>
          <p className="m-0 text-sm text-muted">If a step inside fails, the steps on the "If it fails" path run instead.</p>
          <Checkbox label="Undo what the steps inside changed" checked={step.rollback !== false} onChange={(rollback) => set({ ...step, rollback })} />
          <VarName label="Keep the error's message in" value={step.error ?? ''} onChange={(value) => set({ ...step, error: value || undefined })} />
        </>
      );
    case 'total': {
      const list = lists.find((each) => each.value === step.of);
      const numberFields = list ? (definition.entities[list.entity]?.fields ?? []).filter((field) => field.type === 'number') : [];
      return (
        <>
          {listPicker('Of', step.of, (of) => set({ ...step, of, field: undefined }))}
          <Field label="Work out">
            {(id) => (
              <Select
                id={id}
                value={step.op}
                onChange={(e) =>
                  set({
                    ...step,
                    op: e.target.value as typeof step.op,
                    ...(e.target.value === 'count' ? { field: undefined } : { field: step.field ?? numberFields[0]?.name }),
                  })
                }
              >
                <option value="count">How many</option>
                <option value="sum">The total of</option>
                <option value="avg">The average of</option>
                <option value="min">The lowest</option>
                <option value="max">The highest</option>
              </Select>
            )}
          </Field>
          {step.op === 'count' ? null : (
            <Field label="Field">
              {(id) => (
                <Select id={id} value={step.field ?? ''} onChange={(e) => set({ ...step, field: e.target.value })}>
                  {numberFields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <VarName label="Keep it in" value={step.var} onChange={(value) => set({ ...step, var: value })} />
        </>
      );
    }
    case 'return': {
      const flow = definition.flows?.[name];
      const output = flow?.output;
      if (flow && flowWaits(flow, definition.flows))
        return <p className="m-0 text-sm text-muted">The flow ends here, and so does each of its ways that still runs.</p>;
      if (!output) return <p className="m-0 text-sm text-muted">The flow ends here. It gives no result: give it one in its settings.</p>;
      return (
        <InputValue
          definition={definition}
          input="Result"
          type={output}
          value={step.value}
          scope={scope}
          sources={sources}
          onChange={(value) => set({ ...step, value })}
        />
      );
    }
    case 'task':
      return <TaskFields definition={definition} name={name} step={step} set={set} />;
    case 'inform':
      return <InformFields definition={definition} name={name} step={step} scope={scope} sources={sources} variables={variables} set={set} />;
    case 'call_service':
      return <CallServiceFields definition={definition} step={step} sources={sources} set={set} />;
    case 'wait':
      return (
        <WaitForEditor
          definition={definition}
          name={name}
          label="Wait for"
          variables={variables}
          value={step.for}
          onChange={(wait) => set({ ...step, for: wait })}
        />
      );
    case 'first_of':
      return (
        <>
          <p className="m-0 text-sm text-muted">
            The flow waits for all of these at once. The first that happens takes its way, and the others no longer wait.
          </p>
          {step.ways.map((way, index) => (
            <fieldset key={index} className="m-0 grid gap-2 rounded-md border border-line p-3">
              <legend className="px-1 text-sm text-muted">Way {index + 1}</legend>
              <WaitForEditor
                definition={definition}
                name={name}
                label={`Way ${index + 1} waits for`}
                variables={variables}
                value={way.for}
                onChange={(wait) => set({ ...step, ways: step.ways.map((each, i) => (i === index ? { ...each, for: wait } : each)) })}
              />
              <Button
                size="sm"
                variant="ghost"
                className="justify-self-start"
                disabled={step.ways.length <= 2}
                onClick={() => set({ ...step, ways: step.ways.filter((_, i) => i !== index) })}
              >
                Remove way {index + 1}
              </Button>
            </fieldset>
          ))}
          <Button
            size="sm"
            className="justify-self-start"
            disabled={step.ways.length >= 10}
            onClick={() => set({ ...step, ways: [...step.ways, { for: { duration: 'P1D' }, steps: [] }] })}
          >
            Add a way
          </Button>
        </>
      );
    case 'all_at_once':
      return (
        <>
          <p className="m-0 text-sm text-muted">Each way runs at once, as people's tasks in different inboxes do. The flow goes on when every way has ended.</p>
          {step.ways.map((way, index) => (
            <div key={index} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
              <span>
                Way {index + 1}: {way.steps.length ? `${way.steps.length} step${way.steps.length > 1 ? 's' : ''}` : 'no steps yet'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={step.ways.length <= 2}
                onClick={() => set({ ...step, ways: step.ways.filter((_, i) => i !== index) })}
              >
                Remove way {index + 1}
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            className="justify-self-start"
            disabled={step.ways.length >= 10}
            onClick={() => set({ ...step, ways: [...step.ways, { steps: [] }] })}
          >
            Add a way
          </Button>
        </>
      );
  }
}

// ---- People and time: a person's task, and what a flow waits for
