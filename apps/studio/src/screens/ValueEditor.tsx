import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { Button, Select, TextInput } from '../components/ui.js';
import { type RefChoice, recordChoices } from '../model/conditions.js';
import {
  betweenOf,
  CALC_OPS,
  type CalcOp,
  calc,
  calcOf,
  chooseOf,
  describeExpression,
  type Expression,
  firstFilledOf,
  joinOf,
  type Moment,
  type Operand,
  SYSTEM_REFS,
  shift,
  shiftOf,
  startingValue,
  TEXT_FNS,
  type TextFn,
  textFn,
  textFnOf,
  valueSources,
} from '../model/expressions.js';
import type { Definition, Field as FieldDef } from '../types.js';

type Mode = 'fixed' | 'field' | 'person' | 'today' | 'now' | 'calc' | 'join' | 'shift' | 'between' | 'choose' | 'text' | 'first' | 'formula';
export type ValueMode = Mode;
/** Where a value can come from, instead of the record's fields: a flow's variables. */
export interface ValueSources {
  readonly all: ReadonlyArray<{ readonly ref: string; readonly label: string }>;
  readonly numbers: ReadonlyArray<{ readonly ref: string; readonly label: string }>;
  readonly dates: ReadonlyArray<{ readonly ref: string; readonly label: string }>;
  /** What a condition in a value can read. */
  readonly choices: readonly RefChoice[];
  /** What the builder reads for the mode that names a source. */
  readonly label: string;
}
const CALC_LABELS: Readonly<Record<CalcOp, string>> = { add: 'plus', sub: 'minus', mul: 'times', div: 'divided by' };
const MODE_LABELS: Readonly<Record<Mode, string>> = {
  fixed: 'A fixed value',
  field: 'A field of the record',
  person: 'The person running it',
  today: 'Today',
  now: 'Now',
  calc: 'A calculation',
  join: 'Text joined from parts',
  shift: 'A date some days away',
  between: 'The days between two dates',
  choose: 'One of two values, by a condition',
  text: 'Text, changed',
  first: 'The first value that is filled in',
  formula: 'A formula',
};
const TEXT_FN_LABELS: Readonly<Record<TextFn, string>> = {
  upper: 'in capitals',
  lower: 'in small letters',
  trim: 'without spaces at its ends',
  left: 'its first characters',
  text_length: 'its length',
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
  if (shiftOf(value)) return 'shift';
  if (betweenOf(value)) return 'between';
  if (chooseOf(value)) return 'choose';
  if (textFnOf(value)) return 'text';
  if (firstFilledOf(value)) return 'first';
  return 'formula';
}

/** The ways a value can be given, for a field of a type; without one, the common ones. */
function modesFor(target: FieldDef | undefined): Mode[] {
  if (!target) return ['field', 'fixed', 'person', 'today', 'now', 'join'];
  switch (target.type) {
    case 'number':
      return ['fixed', 'field', 'calc', 'between', 'text', 'choose'];
    case 'text':
    case 'email':
      return ['fixed', 'field', 'join', 'text', 'first', 'choose'];
    case 'date':
      return ['today', 'fixed', 'field', 'shift', 'choose'];
    case 'datetime':
      return ['now', 'field', 'shift', 'choose'];
    case 'user':
      return ['person', 'field', 'choose'];
    case 'reference':
      return ['field'];
    default:
      return ['fixed', 'field', 'choose'];
  }
}

function startFor(
  mode: Mode,
  target: FieldDef | undefined,
  sources: ReadonlyArray<{ ref: string }>,
  dates: ReadonlyArray<{ ref: string }> = [],
  stored = false,
): Expression {
  const first: Operand | undefined = sources[0] ? { ref: sources[0].ref } : undefined;
  const moment: Moment = dates[0] ? { ref: dates[0].ref } : target?.type === 'datetime' ? { now: true } : { today: true };
  switch (mode) {
    case 'shift':
      return target?.type === 'datetime' && !stored ? { add_hours: [moment, 1] } : { add_days: [moment, 1] };
    case 'between':
      // A stored value counts the days between two of the record's dates, not from today.
      return { days_between: [stored ? moment : { today: true }, stored && dates[1] ? { ref: dates[1].ref } : moment] };
    case 'choose': {
      const plain = startFor('fixed', target, sources, dates, stored);
      return { if: [{ exists: sources[0]?.ref ?? 'principal.id' }, plain, plain] };
    }
    case 'text':
      return target?.type === 'number' ? { text_length: [first ?? ''] } : { upper: [first ?? ''] };
    case 'first':
      return { coalesce: [first ?? '', ''] };
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

/** The ways a stored value, a formula's, can be given: none reads the person, the clock, or text functions SQL doesn't match. */
const STORED_MODES: readonly Mode[] = ['fixed', 'field', 'calc', 'join', 'shift', 'between', 'choose', 'first'];

/** A value a step works out: a fixed value, a field, the person, today, a small calculation or joined text. */
export function ValueEditor({
  definition,
  entity,
  target,
  label,
  value,
  onChange,
  from,
  only,
  stored = false,
}: {
  definition: Definition;
  entity: string;
  target?: FieldDef;
  label: string;
  value: Expression;
  onChange: (value: Expression) => void;
  /** Sources other than the record's fields, such as a flow's variables. */
  from?: ValueSources;
  /** The ways a value can be given here, instead of those that suit the target. */
  only?: readonly Mode[];
  /**
   * A value that is stored, as a formula's is: it reads only the app's own fields, not the target
   * itself, the fields the platform keeps, the person or the clock.
   */
  stored?: boolean;
}) {
  const mode = modeOf(value);
  const own = (list: ReadonlyArray<{ ref: string; label: string }>) =>
    stored ? list.filter((source) => !SYSTEM_REFS.has(source.ref) && source.ref !== `record.${target?.name}`) : list;
  const sources = from ? from.all : own(valueSources(definition, entity, target));
  const numbers = from ? from.numbers : own(valueSources(definition, entity, 'number'));
  const dates = from ? from.dates : own(valueSources(definition, entity, 'date'));
  const texts = from ? from.all : own(valueSources(definition, entity));
  // Lines' choices are their own fields only: those a stored value can read.
  const choices = from
    ? from.choices
    : stored
      ? recordChoices(definition, entity, true).filter((choice) => choice.ref !== `record.${target?.name}`)
      : recordChoices(definition, entity);
  // Shifting and counting days need a date to start from, when today isn't one.
  const modes = only
    ? [...only]
    : stored
      ? modesFor(target).filter((m) => STORED_MODES.includes(m) && ((m !== 'shift' && m !== 'between') || dates.length > 0))
      : modesFor(target);
  const shown = modes.includes(mode) ? modes : [...modes, mode];
  const calculation = mode === 'calc' ? calcOf(value) : undefined;
  const parts = mode === 'join' ? joinOf(value) : undefined;
  const shifted = mode === 'shift' ? shiftOf(value) : undefined;
  const between = mode === 'between' ? betweenOf(value) : undefined;
  const chosen = mode === 'choose' ? chooseOf(value) : undefined;
  const texted = mode === 'text' ? textFnOf(value) : undefined;
  const firsts = mode === 'first' ? firstFilledOf(value) : undefined;
  // A number's text function is its length; text's are the others.
  const fns = TEXT_FNS.filter((fn) => (target?.type === 'number' ? fn === 'text_length' : target ? fn !== 'text_length' : true));
  const inner = (part: Expression, onPart: (next: Expression) => void, name: string) => (
    <ValueEditor
      definition={definition}
      entity={entity}
      {...(target ? { target } : {})}
      label={name}
      value={part}
      onChange={onPart}
      {...(from ? { from } : {})}
      {...(only ? { only } : {})}
      stored={stored}
    />
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={`${label}: how`}
        className="w-auto"
        value={mode}
        onChange={(e) => {
          const next = shown.find((m) => m === e.target.value);
          if (next) onChange(startFor(next, target, sources, dates, stored));
        }}
      >
        {shown.map((m) => (
          <option key={m} value={m} disabled={m === 'formula'}>
            {m === 'field' && from ? from.label : MODE_LABELS[m]}
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
          <OperandInput
            label={`${label}, first`}
            sources={numbers}
            value={calculation.a}
            numeric
            onChange={(a) => onChange(calc(calculation.op, a, calculation.b))}
          />
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
          <OperandInput
            label={`${label}, second`}
            sources={numbers}
            value={calculation.b}
            numeric
            onChange={(b) => onChange(calc(calculation.op, calculation.a, b))}
          />
        </>
      ) : null}
      {parts ? (
        <>
          {parts.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              <OperandInput
                label={`${label}, part ${i + 1}`}
                sources={from ? from.all : valueSources(definition, entity)}
                value={part}
                onChange={(next) => onChange({ concat: parts.map((p, j) => (j === i ? next : p)) })}
              />
              {parts.length > 2 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${label}: remove part ${i + 1}`}
                  onClick={() => onChange({ concat: parts.filter((_, j) => j !== i) })}
                >
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
      {shifted ? (
        <>
          <MomentInput
            label={`${label}, from`}
            sources={dates}
            value={shifted.from}
            clock={!stored}
            onChange={(next) => onChange(shift(shifted.op, next, shifted.by))}
          />
          <span className="text-sm text-muted">plus</span>
          <OperandInput
            label={`${label}, how many`}
            sources={numbers}
            value={shifted.by}
            numeric
            onChange={(by) => onChange(shift(shifted.op, shifted.from, by))}
          />
          {stored && shifted.op === 'add_days' ? (
            <span className="text-sm text-muted">days</span>
          ) : (
            <Select
              aria-label={`${label}, unit`}
              className="w-auto"
              value={shifted.op}
              onChange={(e) => onChange(shift(e.target.value === 'add_hours' ? 'add_hours' : 'add_days', shifted.from, shifted.by))}
            >
              <option value="add_days">days</option>
              <option value="add_hours">hours</option>
            </Select>
          )}
        </>
      ) : null}
      {between ? (
        <>
          <span className="text-sm text-muted">from</span>
          <MomentInput
            label={`${label}, from`}
            sources={dates}
            value={between.from}
            clock={!stored}
            onChange={(next) => onChange({ days_between: [next, between.to] })}
          />
          <span className="text-sm text-muted">to</span>
          <MomentInput
            label={`${label}, to`}
            sources={dates}
            value={between.to}
            clock={!stored}
            onChange={(next) => onChange({ days_between: [between.from, next] })}
          />
        </>
      ) : null}
      {chosen ? (
        <div className="grid w-full gap-2 rounded-md border border-line p-2">
          <ConditionEditor
            label="If"
            value={chosen.when}
            choices={choices}
            compareWith={stored ? choices : [THE_PERSON, ...choices]}
            clock={!stored}
            onChange={(when) => onChange({ if: [when ?? chosen.when, chosen.then, chosen.otherwise] })}
          />
          <span className="text-sm text-muted">then</span>
          {inner(chosen.then, (then) => onChange({ if: [chosen.when, then, chosen.otherwise] }), `${label}, then`)}
          <span className="text-sm text-muted">else</span>
          {inner(chosen.otherwise, (otherwise) => onChange({ if: [chosen.when, chosen.then, otherwise] }), `${label}, else`)}
        </div>
      ) : null}
      {texted ? (
        <>
          <OperandInput label={`${label}, the text`} sources={texts} value={texted.of} onChange={(of) => onChange(textFn(texted.fn, of, texted.count))} />
          <Select
            aria-label={`${label}, how`}
            className="w-auto"
            value={texted.fn}
            onChange={(e) => onChange(textFn(fns.find((fn) => fn === e.target.value) ?? texted.fn, texted.of, texted.count))}
          >
            {(fns.includes(texted.fn) ? fns : [...fns, texted.fn]).map((fn) => (
              <option key={fn} value={fn}>
                {TEXT_FN_LABELS[fn]}
              </option>
            ))}
          </Select>
          {texted.fn === 'left' ? (
            <TextInput
              aria-label={`${label}, how many characters`}
              type="number"
              min={1}
              className="w-20"
              value={texted.count}
              onChange={(e) => onChange(textFn('left', texted.of, Math.max(1, Number(e.target.value) || 1)))}
            />
          ) : null}
        </>
      ) : null}
      {firsts ? (
        <>
          {firsts.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              {i ? <span className="text-sm text-muted">or else</span> : null}
              <OperandInput
                label={`${label}, choice ${i + 1}`}
                sources={texts}
                value={part}
                onChange={(next) => onChange({ coalesce: firsts.map((p, j) => (j === i ? next : p)) })}
              />
              {firsts.length > 2 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${label}: remove choice ${i + 1}`}
                  onClick={() => onChange({ coalesce: firsts.filter((_, j) => j !== i) })}
                >
                  ✕
                </Button>
              ) : null}
            </span>
          ))}
          {firsts.length < 10 ? (
            <Button size="sm" variant="ghost" onClick={() => onChange({ coalesce: [...firsts, ''] })}>
              Add a choice
            </Button>
          ) : null}
        </>
      ) : null}
      {mode === 'formula' ? <code className="text-sm">{describeExpression(definition, entity, value)}</code> : null}
    </div>
  );
}

/** A date or a time that a value reads: today, now, or a date or time field. */
function MomentInput({
  label,
  sources,
  value,
  onChange,
  clock = true,
}: {
  label: string;
  sources: ReadonlyArray<{ ref: string; label: string }>;
  value: Moment;
  onChange: (value: Moment) => void;
  clock?: boolean;
}) {
  const current = 'ref' in value ? value.ref : 'today' in value ? '·today' : '·now';
  return (
    <Select
      aria-label={label}
      className="w-auto"
      value={current}
      onChange={(e) => onChange(e.target.value === '·today' ? { today: true } : e.target.value === '·now' ? { now: true } : { ref: e.target.value })}
    >
      {/* Where the clock can't be read, today and now show only to be changed. */}
      {clock || current === '·today' ? <option value="·today">Today</option> : null}
      {clock || current === '·now' ? <option value="·now">Now</option> : null}
      {sources.map((source) => (
        <option key={source.ref} value={source.ref}>
          {source.label}
        </option>
      ))}
    </Select>
  );
}

/** One side of a calculation, or one part of joined text: a field, or a value typed in. */
function OperandInput({
  label,
  sources,
  value,
  numeric = false,
  onChange,
}: {
  label: string;
  sources: ReadonlyArray<{ ref: string; label: string }>;
  value: Operand;
  numeric?: boolean;
  onChange: (value: Operand) => void;
}) {
  const typed = !isRefOperand(value);
  return (
    <span className="flex items-center gap-1">
      <Select
        aria-label={`${label}: from`}
        className="w-auto"
        value={isRefOperand(value) ? value.ref : '·typed'}
        onChange={(e) => onChange(e.target.value === '·typed' ? (numeric ? 0 : '') : { ref: e.target.value })}
      >
        <option value="·typed">{numeric ? 'A number' : 'Text'}</option>
        {sources.map((source) => (
          <option key={source.ref} value={source.ref}>
            {source.label}
          </option>
        ))}
      </Select>
      {typed ? (
        numeric ? (
          <TextInput
            aria-label={label}
            type="number"
            className="w-24"
            value={typeof value === 'number' ? value : 0}
            onChange={(e) => onChange(Number(e.target.value))}
          />
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
  if (target?.type === 'number')
    return (
      <TextInput
        aria-label={label}
        type="number"
        className="w-32"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  if (target?.type === 'date')
    return (
      <TextInput aria-label={label} type="date" className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
    );
  return (
    <TextInput
      aria-label={label}
      className="w-56"
      value={typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
