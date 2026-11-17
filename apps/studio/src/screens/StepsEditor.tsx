import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { Badge, Button, Field, Select, TextInput } from '../components/ui.js';
import { recordChoices, type Condition } from '../model/conditions.js';
import {
  addStep,
  calc,
  calcOf,
  CALC_OPS,
  describeExpression,
  describeStep,
  linesFields,
  moveStep,
  removeStep,
  settableFields,
  sideOf,
  startingValue,
  STEP_NAMES,
  updateStep,
  joinOf,
  valueSources,
  type CalcOp,
  type Expression,
  type Operand,
  type SimpleStep,
  type Step,
  type StepPlace,
  type StepType,
} from '../model/steps.js';
import type { Definition, Field as FieldDef } from '../types.js';

type Props = { definition: Definition; onChange: (definition: Definition) => void };

const BADGES: Readonly<Record<StepType, { text: string; tone: 'accent' | 'warn' | 'idle' | 'outside' }>> = {
  set: { text: 'Set', tone: 'accent' },
  add_line: { text: 'Add a line', tone: 'accent' },
  check: { text: 'Check', tone: 'warn' },
  if: { text: 'If', tone: 'idle' },
  skill: { text: 'a7c skill', tone: 'outside' },
};

const keyOf = (place: StepPlace) => (place.side === undefined ? `${place.index}` : `${place.index}.${place.side}.${place.inner}`);
/** How a person names a step, as the platform's messages do: "Step 2", or "Step 3, then 1". */
const nameOf = (place: StepPlace) => (place.side === undefined ? `Step ${place.index + 1}` : `Step ${place.index + 1}, ${place.side} ${(place.inner ?? 0) + 1}`);

/**
 * An action's steps: a short list, run in order once the action has its input and its set values
 * (design §6.2). A branch holds two short lists. Work in other systems is an a7c skill, which a
 * step starts once the change is saved.
 */
export function StepsEditor({ definition, onChange, action, kinds }: Props & { action: string; /** The kinds of step it offers, where fewer fit, such as in a script task. */ kinds?: StepType[] }) {
  // a7c is left out until the installation connects it: until then, no new skill steps.
  const features = useQuery({ queryKey: ['features'], queryFn: api.features, staleTime: Infinity });
  const simple: StepType[] = kinds ?? (features.data?.a7c ? ['set', 'add_line', 'check', 'skill'] : ['set', 'add_line', 'check']);
  const current = definition.actions[action]!;
  const steps = (current.steps ?? []) as Step[];
  const [open, setOpen] = useState<string | null>(null);
  const add = (type: StepType, into?: { index: number; side: 'then' | 'else' }) => {
    const result = addStep(definition, action, type, into);
    if (!result.place) return;
    onChange(result.definition);
    setOpen(keyOf(result.place));
  };
  const can = (type: StepType) => addStep(definition, action, type).place !== undefined;

  const item = (step: Step, place: StepPlace, count: number) => {
    const key = keyOf(place);
    const name = nameOf(place);
    const position = place.side === undefined ? place.index : place.inner!;
    return (
      <li key={key} className="rounded-md border border-line bg-surface">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Badge tone={BADGES[step.type].tone}>{BADGES[step.type].text}</Badge>
          <button
            type="button"
            aria-expanded={open === key}
            aria-label={`${name}: ${describeStep(definition, current.entity, step)}`}
            className="min-w-0 flex-1 truncate text-left text-sm"
            title={describeStep(definition, current.entity, step)}
            onClick={() => setOpen(open === key ? null : key)}
          >
            {describeStep(definition, current.entity, step)}
          </button>
          <Button size="sm" variant="ghost" aria-label={`Move ${name} up`} disabled={position === 0} onClick={() => onChange(moveStep(definition, action, place, -1))}>
            ↑
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Move ${name} down`} disabled={position === count - 1} onClick={() => onChange(moveStep(definition, action, place, 1))}>
            ↓
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} onClick={() => onChange(removeStep(definition, action, place))}>
            ✕
          </Button>
        </div>
        {open === key ? (
          <div className="grid gap-3 border-t border-line p-3">
            <StepFields definition={definition} entity={current.entity} step={step} name={name} onChange={(next) => onChange(updateStep(definition, action, place, next))} />
          </div>
        ) : null}
        {step.type === 'if' ? (
          <div className="grid gap-3 border-t border-line py-3 pr-3 pl-6">
            {(['then', 'else'] as const).map((side) => (
              <div key={side} className="grid gap-1.5">
                <span className="text-xs font-semibold text-muted">{side === 'then' ? 'Then' : 'Otherwise'}</span>
                {sideOf(step, side).length ? (
                  <ol className="m-0 grid list-none grid-cols-1 gap-1.5 p-0">{sideOf(step, side).map((inner, i) => item(inner, { index: place.index, side, inner: i }, sideOf(step, side).length))}</ol>
                ) : (
                  <p className="m-0 text-xs text-faint">Nothing.</p>
                )}
                <AddButtons can={can} types={simple} prefix={`${name}, ${side === 'then' ? 'then' : 'otherwise'}: `} onAdd={(type) => add(type, { index: place.index, side })} />
              </div>
            ))}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section className="grid grid-cols-1 gap-2" aria-label="Steps">
      <div>
        <h3 className="m-0 text-sm font-semibold text-muted">Then, step by step</h3>
        <p className="m-0 text-xs text-faint">
          After it takes its input and sets its values. The review card shows what the steps did. Steps can set only what the person running the action may set.
          {features.data?.a7c ? ' a7c skills start once the change is saved.' : ''}
        </p>
      </div>
      {steps.length ? <ol className="m-0 grid list-none grid-cols-1 gap-1.5 p-0">{steps.map((step, index) => item(step, { index }, steps.length))}</ol> : <p className="m-0 text-sm text-muted">No steps: it saves what it takes and sets.</p>}
      <AddButtons can={can} types={[...simple.filter((type) => type !== 'skill'), 'if', ...simple.filter((type) => type === 'skill')]} prefix="" onAdd={(type) => add(type)} />
    </section>
  );
}

function AddButtons({ can, types, prefix, onAdd }: { can: (type: StepType) => boolean; types: StepType[]; prefix: string; onAdd: (type: StepType) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {types.map((type) => (
        <Button key={type} size="sm" disabled={!can(type)} aria-label={`${prefix}${STEP_NAMES[type]}`} onClick={() => onAdd(type)}>
          {STEP_NAMES[type]}
        </Button>
      ))}
    </div>
  );
}

/** The fields of one step, by its type. */
function StepFields({ definition, entity, step, name, onChange }: { definition: Definition; entity: string; step: Step; name: string; onChange: (step: Step) => void }) {
  const choices = recordChoices(definition, entity);
  const test = (value: Condition | undefined, fallback: Condition) => value ?? fallback;
  switch (step.type) {
    case 'set': {
      const fields = settableFields(definition, entity);
      const target = fields.find((f) => f.name === step.field);
      return (
        <>
          <Field label="Sets">
            {(id) => (
              <Select
                id={id}
                className="w-auto justify-self-start"
                value={step.field}
                onChange={(e) => {
                  const field = fields.find((f) => f.name === e.target.value);
                  if (field) onChange({ type: 'set', field: field.name, value: startingValue(field) });
                }}
              >
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {target ? <ValueEditor definition={definition} entity={entity} target={target} label={`${name}, ${target.label}`} value={step.value} onChange={(value) => onChange({ ...step, value })} /> : null}
        </>
      );
    }
    case 'add_line': {
      const lines = linesFields(definition, entity);
      const field = lines.find((f) => f.name === step.field);
      const lineFields = (definition.entities[field?.entity ?? '']?.fields ?? []).filter((f) => f.type !== 'file' && f.type !== 'lines');
      return (
        <>
          <Field label="Adds a line to">
            {(id) => (
              <Select id={id} className="w-auto justify-self-start" value={step.field} onChange={(e) => onChange({ type: 'add_line', field: e.target.value, values: {} })}>
                {lines.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid gap-2">
            {lineFields.map((lineField) => {
              const given = lineField.name in step.values;
              return (
                <div key={lineField.name} className="grid gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{lineField.label}</span>
                    {lineField.required ? <span className="text-xs text-faint">required</span> : null}
                    {given && !lineField.required ? (
                      <Button size="sm" variant="ghost" aria-label={`${name}: leave ${lineField.label} empty`} onClick={() => onChange({ ...step, values: Object.fromEntries(Object.entries(step.values).filter(([key]) => key !== lineField.name)) })}>
                        Leave empty
                      </Button>
                    ) : null}
                    {!given ? (
                      <Button size="sm" variant="ghost" aria-label={`${name}: give ${lineField.label} a value`} onClick={() => onChange({ ...step, values: { ...step.values, [lineField.name]: startingValue(lineField) } })}>
                        Give it a value
                      </Button>
                    ) : null}
                  </div>
                  {given ? (
                    <ValueEditor
                      definition={definition}
                      entity={entity}
                      target={lineField}
                      label={`${name}, ${lineField.label}`}
                      value={step.values[lineField.name]!}
                      onChange={(value) => onChange({ ...step, values: { ...step.values, [lineField.name]: value } })}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      );
    }
    case 'check':
      return (
        <>
          <ConditionEditor label="Must hold" value={step.assert} onChange={(assert) => onChange({ ...step, assert: test(assert, step.assert) })} choices={choices} compareWith={[THE_PERSON]} />
          <Field label="Message" hint="What the person reads when it doesn't hold.">
            {(id) => <TextInput id={id} value={step.message} onChange={(e) => onChange({ ...step, message: e.target.value })} />}
          </Field>
          <Field label="When it doesn't hold">
            {(id) => (
              <Select id={id} className="w-auto justify-self-start" value={step.severity ?? 'error'} onChange={(e) => onChange({ ...step, severity: e.target.value === 'warning' ? 'warning' : 'error' })}>
                <option value="error">Stop the action</option>
                <option value="warning">Warn, and let it through</option>
              </Select>
            )}
          </Field>
        </>
      );
    case 'if':
      return <ConditionEditor label="If" value={step.when} onChange={(when) => onChange({ ...step, when: test(when, step.when) })} choices={choices} compareWith={[THE_PERSON]} />;
    case 'skill':
      return <SkillFields definition={definition} entity={entity} step={step} name={name} onChange={onChange} />;
  }
}

function SkillFields({ definition, entity, step, name, onChange }: { definition: Definition; entity: string; step: Extract<SimpleStep, { type: 'skill' }>; name: string; onChange: (step: Step) => void }) {
  const [newInput, setNewInput] = useState('');
  const inputs = Object.entries(step.input ?? {});
  const valid = /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(newInput) && !(newInput in (step.input ?? {}));
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What it does" hint="The review card shows this.">
          {(id) => <TextInput id={id} value={step.label} onChange={(e) => onChange({ ...step, label: e.target.value })} />}
        </Field>
        <Field label="a7c skill" hint="As project/skill, for example finance/pay-expense-claim.">
          {(id) => <TextInput id={id} className="font-mono" value={step.skill} onChange={(e) => onChange({ ...step, skill: e.target.value.trim() })} />}
        </Field>
      </div>
      <div className="grid gap-2">
        <span className="text-sm text-muted">Its input</span>
        {inputs.length ? null : <p className="m-0 text-xs text-faint">None yet. A skill usually needs the record's ID, to come back to it.</p>}
        {inputs.map(([input, value]) => (
          <div key={input} className="grid gap-1">
            <div className="flex items-center gap-2">
              <code className="text-sm">{input}</code>
              <Button size="sm" variant="ghost" aria-label={`${name}: remove the input ${input}`} onClick={() => onChange({ ...step, input: Object.fromEntries(inputs.filter(([key]) => key !== input)) })}>
                ✕
              </Button>
            </div>
            <ValueEditor definition={definition} entity={entity} label={`${name}, input ${input}`} value={value} onChange={(next) => onChange({ ...step, input: { ...step.input, [input]: next } })} />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <TextInput aria-label={`${name}: new input`} className="w-48 font-mono" placeholder="e.g. claim" value={newInput} onChange={(e) => setNewInput(e.target.value)} />
          <Button
            size="sm"
            disabled={!valid}
            onClick={() => {
              onChange({ ...step, input: { ...step.input, [newInput]: { ref: 'record.id' } } });
              setNewInput('');
            }}
          >
            Add an input
          </Button>
        </div>
      </div>
    </>
  );
}

// Values

type Mode = 'fixed' | 'field' | 'person' | 'today' | 'now' | 'calc' | 'join' | 'formula';
const CALC_LABELS: Readonly<Record<CalcOp, string>> = { add: 'plus', sub: 'minus', mul: 'times', div: 'divided by' };
const MODE_LABELS: Readonly<Record<Mode, string>> = {
  fixed: 'A fixed value',
  field: 'A field of the record',
  person: 'The person running it',
  today: 'Today',
  now: 'Now',
  calc: 'A calculation',
  join: 'Text joined from parts',
  formula: 'A formula',
};

const isRefOperand = (value: unknown): value is { readonly ref: string } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { ref?: unknown }).ref === 'string';

function modeOf(value: Expression): Mode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'fixed';
  if (isRefOperand(value)) return value.ref === 'principal.id' ? 'person' : 'field';
  if ('today' in value) return 'today';
  if ('now' in value) return 'now';
  if (calcOf(value)) return 'calc';
  if (joinOf(value)) return 'join';
  return 'formula';
}

/** The ways a value can be given, for a field of a type; for a skill's input, which takes anything, the common ones. */
function modesFor(target: FieldDef | undefined): Mode[] {
  if (!target) return ['field', 'fixed', 'person', 'today', 'now', 'join'];
  switch (target.type) {
    case 'number':
      return ['fixed', 'field', 'calc'];
    case 'text':
    case 'email':
      return ['fixed', 'field', 'join'];
    case 'date':
      return ['today', 'fixed', 'field'];
    case 'datetime':
      return ['now', 'field'];
    case 'user':
      return ['person', 'field'];
    case 'reference':
      return ['field'];
    default:
      return ['fixed', 'field'];
  }
}

function startFor(mode: Mode, target: FieldDef | undefined, sources: ReadonlyArray<{ ref: string }>): Expression {
  const first: Operand | undefined = sources[0] ? { ref: sources[0].ref } : undefined;
  switch (mode) {
    case 'fixed': {
      const start = target ? startingValue(target) : '';
      return start !== null && typeof start === 'object' && !Array.isArray(start) ? '' : start;
    }
    case 'field':
    case 'formula':
      return first ?? null;
    case 'person':
      return { ref: 'principal.id' };
    case 'today':
      return { today: true };
    case 'now':
      return { now: true };
    case 'calc':
      return calc('mul', first ?? 0, 1);
    case 'join':
      return { concat: [first ?? '', ''] };
  }
}

/** A value a step works out: a fixed value, a field, the person, today, a small calculation or joined text. */
export function ValueEditor({ definition, entity, target, label, value, onChange }: { definition: Definition; entity: string; target?: FieldDef; label: string; value: Expression; onChange: (value: Expression) => void }) {
  const mode = modeOf(value);
  const modes = modesFor(target);
  const sources = valueSources(definition, entity, target);
  const shown = modes.includes(mode) ? modes : [...modes, mode];
  const calculation = mode === 'calc' ? calcOf(value) : undefined;
  const parts = mode === 'join' ? joinOf(value) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={`${label}: how`}
        className="w-auto"
        value={mode}
        onChange={(e) => {
          const next = shown.find((m) => m === e.target.value);
          if (next) onChange(startFor(next, target, sources));
        }}
      >
        {shown.map((m) => (
          <option key={m} value={m} disabled={m === 'formula'}>
            {MODE_LABELS[m]}
          </option>
        ))}
      </Select>
      {mode === 'fixed' ? <FixedInput target={target} label={label} value={value} onChange={onChange} /> : null}
      {mode === 'field' ? (
        <Select aria-label={label} className="w-auto" value={isRefOperand(value) ? value.ref : ''} onChange={(e) => onChange({ ref: e.target.value })}>
          {sources.map((source) => (
            <option key={source.ref} value={source.ref}>
              {source.label}
            </option>
          ))}
        </Select>
      ) : null}
      {calculation ? (
        <>
          <OperandInput label={`${label}, first`} sources={valueSources(definition, entity, 'number')} value={calculation.a} numeric onChange={(a) => onChange(calc(calculation.op, a, calculation.b))} />
          <Select
            aria-label={`${label}, operation`}
            className="w-auto"
            value={calculation.op}
            onChange={(e) => onChange(calc(CALC_OPS.find((op) => op === e.target.value) ?? calculation.op, calculation.a, calculation.b))}
          >
            {CALC_OPS.map((op) => (
              <option key={op} value={op}>
                {CALC_LABELS[op]}
              </option>
            ))}
          </Select>
          <OperandInput label={`${label}, second`} sources={valueSources(definition, entity, 'number')} value={calculation.b} numeric onChange={(b) => onChange(calc(calculation.op, calculation.a, b))} />
        </>
      ) : null}
      {parts ? (
        <>
          {parts.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              <OperandInput label={`${label}, part ${i + 1}`} sources={valueSources(definition, entity)} value={part} onChange={(next) => onChange({ concat: parts.map((p, j) => (j === i ? next : p)) })} />
              {parts.length > 2 ? (
                <Button size="sm" variant="ghost" aria-label={`${label}: remove part ${i + 1}`} onClick={() => onChange({ concat: parts.filter((_, j) => j !== i) })}>
                  ✕
                </Button>
              ) : null}
            </span>
          ))}
          {parts.length < 10 ? (
            <Button size="sm" variant="ghost" onClick={() => onChange({ concat: [...parts, ''] })}>
              Add a part
            </Button>
          ) : null}
        </>
      ) : null}
      {mode === 'formula' ? <code className="text-sm">{describeExpression(definition, entity, value)}</code> : null}
    </div>
  );
}

/** One side of a calculation, or one part of joined text: a field, or a value typed in. */
function OperandInput({ label, sources, value, numeric = false, onChange }: { label: string; sources: ReadonlyArray<{ ref: string; label: string }>; value: Operand; numeric?: boolean; onChange: (value: Operand) => void }) {
  const typed = !isRefOperand(value);
  return (
    <span className="flex items-center gap-1">
      <Select aria-label={`${label}: from`} className="w-auto" value={isRefOperand(value) ? value.ref : '·typed'} onChange={(e) => onChange(e.target.value === '·typed' ? (numeric ? 0 : '') : { ref: e.target.value })}>
        <option value="·typed">{numeric ? 'A number' : 'Text'}</option>
        {sources.map((source) => (
          <option key={source.ref} value={source.ref}>
            {source.label}
          </option>
        ))}
      </Select>
      {typed ? (
        numeric ? (
          <TextInput aria-label={label} type="number" className="w-24" value={typeof value === 'number' ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
        ) : (
          <TextInput aria-label={label} className="w-32" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
        )
      ) : null}
    </span>
  );
}

/** A fixed value, in the input its field's type needs. */
function FixedInput({ target, label, value, onChange }: { target?: FieldDef; label: string; value: Expression; onChange: (value: Expression) => void }) {
  if (target?.type === 'choice' && !target.multiple) {
    return (
      <Select aria-label={label} className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {target.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (target?.type === 'boolean') {
    return (
      <Select aria-label={label} className="w-auto" value={value === false ? 'false' : 'true'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (target?.type === 'number') return <TextInput aria-label={label} type="number" className="w-32" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(Number(e.target.value))} />;
  if (target?.type === 'date') return <TextInput aria-label={label} type="date" className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  return <TextInput aria-label={label} className="w-56" value={typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''} onChange={(e) => onChange(e.target.value)} />;
}
