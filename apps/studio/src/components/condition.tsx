import { useEffect, useState } from 'react';
import {
  defaultValue,
  fromModel,
  isGroup,
  newClause,
  opLabel,
  opsFor,
  toModel,
  type Clause,
  type Condition,
  type Group,
  type Literal,
  type Op,
  type RefChoice,
} from '../model/conditions.js';
import { Button, cx, Select, TextInput } from './ui.js';

/** The person a screen or an agent works for, as conditions name them. */
export const THE_PERSON: RefChoice = { ref: 'principal.id', label: 'the person using it', kind: 'person' };

interface Props {
  readonly label: string;
  readonly value: Condition | undefined;
  readonly onChange: (value: Condition | undefined) => void;
  /** What a clause can test: usually the record's fields. */
  readonly choices: readonly RefChoice[];
  /** What a clause can compare with, besides a value: the person, or a query's parameters. */
  readonly compareWith?: readonly RefChoice[];
  /** Shown when there's nothing to test, for an optional condition: "Every record", for example. */
  readonly empty?: string;
}

/**
 * Edit a condition as clauses: a field, an operator and a value, all of which must hold, or any.
 * Groups nest one level. A condition with another shape is edited as JSON, so nothing is lost.
 */
export function ConditionEditor({ label, value, onChange, choices, compareWith = [], empty }: Props) {
  const model = toModel(value);
  if (!model) return <JsonCondition label={label} value={value} onChange={onChange} />;
  const set = (group: Group) => onChange(fromModel(group));
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm text-muted">{label}</legend>
      <GroupEditor group={model} onChange={set} choices={choices} compareWith={compareWith} depth={0} empty={empty} />
    </fieldset>
  );
}

function GroupEditor(props: { group: Group; onChange: (group: Group) => void; choices: readonly RefChoice[]; compareWith: readonly RefChoice[]; depth: number; empty?: string | undefined }) {
  const { group, onChange, choices, compareWith, depth } = props;
  const setItem = (index: number, item: Clause | Group) => onChange({ ...group, items: group.items.map((existing, i) => (i === index ? item : existing)) });
  const remove = (index: number) => onChange({ ...group, items: group.items.filter((_, i) => i !== index) });
  const first = choices[0];
  return (
    <div className={cx('grid gap-2', depth > 0 && 'rounded-md bg-sunken p-2')}>
      {group.items.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          Match
          <Select className="w-auto" value={group.match} onChange={(e) => onChange({ ...group, match: e.target.value as Group['match'] })}>
            <option value="all">all of these</option>
            <option value="any">any of these</option>
          </Select>
        </label>
      ) : null}
      {group.items.length === 0 && depth === 0 ? <p className="m-0 text-sm text-muted">{props.empty ?? 'Nothing to check yet.'}</p> : null}
      {group.items.map((item, index) =>
        isGroup(item) ? (
          <div key={index} className="grid gap-1">
            <GroupEditor group={item} onChange={(next) => setItem(index, next)} choices={choices} compareWith={compareWith} depth={depth + 1} />
            <div>
              <Button size="sm" variant="ghost" onClick={() => remove(index)}>
                Remove this group
              </Button>
            </div>
          </div>
        ) : (
          <ClauseEditor key={index} clause={item} onChange={(next) => setItem(index, next)} onRemove={() => remove(index)} choices={choices} compareWith={compareWith} />
        ),
      )}
      {first ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onChange({ ...group, items: [...group.items, newClause(first)] })}>
            Add a condition
          </Button>
          {depth === 0 ? (
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...group, items: [...group.items, { match: group.match === 'all' ? 'any' : 'all', items: [newClause(first)] }] })}>
              Add a group
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ClauseEditor({ clause, onChange, onRemove, choices, compareWith }: { clause: Clause; onChange: (clause: Clause) => void; onRemove: () => void; choices: readonly RefChoice[]; compareWith: readonly RefChoice[] }) {
  const choice = choices.find((c) => c.ref === clause.ref) ?? { ref: clause.ref, label: clause.ref, kind: 'text' as const };
  const ops = opsFor(choice.kind);
  const others = compareWith.filter((c) => c.kind === choice.kind || (choice.kind === 'choice' && c.kind === 'text'));
  const needsValue = clause.op !== 'exists' && clause.op !== 'missing';
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      <Select
        aria-label="Field"
        className="w-auto max-w-56"
        value={choice.ref}
        onChange={(e) => {
          const next = choices.find((c) => c.ref === e.target.value);
          if (next) onChange(newClause(next));
        }}
      >
        {choices.some((c) => c.ref === choice.ref) ? null : <option value={choice.ref}>{choice.label}</option>}
        {choices.map((c) => (
          <option key={c.ref} value={c.ref}>
            {c.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Test"
        className="w-auto"
        value={clause.op}
        onChange={(e) => {
          const op = e.target.value as Op;
          if (op === 'exists' || op === 'missing') return onChange({ ref: clause.ref, op });
          // A date keeps what it compares with as the test changes.
          const right = choice.kind === 'date' && clause.right ? clause.right : { kind: 'value' as const, value: defaultValue(choice, op) };
          onChange({ ref: clause.ref, op, right });
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {opLabel(op, choice.kind)}
          </option>
        ))}
      </Select>
      {needsValue && choice.kind === 'date' ? <DateSide clause={clause} others={others} onChange={onChange} /> : needsValue ? <RightSide clause={clause} choice={choice} others={others} onChange={onChange} /> : null}
      <Button size="sm" variant="ghost" aria-label="Remove this condition" onClick={onRemove}>
        ✕
      </Button>
    </div>
  );
}

/** What a date or a time compares with: today or now, so many days or hours away; a date; or another date. */
function DateSide({ clause, others, onChange }: { clause: Clause; others: readonly RefChoice[]; onChange: (clause: Clause) => void }) {
  const right = clause.right ?? { kind: 'relative' as const, unit: 'today' as const, amount: 0 };
  const mode = right.kind === 'relative' ? right.unit : right.kind === 'ref' ? right.ref : 'value';
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Select
        aria-label="Compare with"
        className="w-auto"
        value={mode}
        onChange={(e) => {
          const next = e.target.value;
          onChange({ ...clause, right: next === 'today' || next === 'now' ? { kind: 'relative', unit: next, amount: 0 } : next === 'value' ? { kind: 'value', value: '' } : { kind: 'ref', ref: next } });
        }}
      >
        <option value="today">today</option>
        <option value="now">now</option>
        <option value="value">a date</option>
        {others.map((other) => (
          <option key={other.ref} value={other.ref}>
            {other.label}
          </option>
        ))}
      </Select>
      {right.kind === 'relative' ? (
        <>
          <TextInput
            aria-label={right.unit === 'today' ? 'Days from today' : 'Hours from now'}
            type="number"
            className="w-20"
            value={right.amount}
            onChange={(e) => onChange({ ...clause, right: { ...right, amount: Math.trunc(Number(e.target.value) || 0) } })}
          />
          <span className="text-xs text-muted">{right.unit === 'today' ? 'days from today; less than 0 for days ago' : 'hours from now; less than 0 for hours ago'}</span>
        </>
      ) : null}
      {right.kind === 'value' ? (
        <TextInput aria-label="Date" type="date" className="w-44" value={typeof right.value === 'string' ? right.value : ''} onChange={(e) => onChange({ ...clause, right: { kind: 'value', value: e.target.value } })} />
      ) : null}
    </span>
  );
}

function RightSide({ clause, choice, others, onChange }: { clause: Clause; choice: RefChoice; others: readonly RefChoice[]; onChange: (clause: Clause) => void }) {
  const current = clause.right && clause.right.kind !== 'relative' ? clause.right : { kind: 'value' as const, value: defaultValue(choice, clause.op) };
  const setValue = (value: Literal) => onChange({ ...clause, right: { kind: 'value', value } });
  const list = clause.op === 'in' || clause.op === 'notIn';
  // A person is compared with the person using it; a value or a parameter otherwise.
  const source = current.kind === 'ref' ? current.ref : 'value';
  const sources = list ? [] : others;
  return (
    <span className="flex flex-wrap items-start gap-1.5">
      {sources.length ? (
        <Select
          aria-label="Compare with"
          className="w-auto"
          value={source}
          onChange={(e) => onChange({ ...clause, right: e.target.value === 'value' ? { kind: 'value', value: defaultValue(choice, clause.op) } : { kind: 'ref', ref: e.target.value } })}
        >
          {choice.kind === 'person' ? null : <option value="value">a value</option>}
          {sources.map((s) => (
            <option key={s.ref} value={s.ref}>
              {s.label}
            </option>
          ))}
        </Select>
      ) : null}
      {current.kind === 'value' && choice.kind !== 'person' ? <ValueInput choice={choice} list={list} value={current.value} onChange={setValue} /> : null}
      {current.kind === 'value' && choice.kind === 'person' && !sources.length ? <span className="py-1.5 text-sm text-muted">the person using it</span> : null}
    </span>
  );
}

function ValueInput({ choice, list, value, onChange }: { choice: RefChoice; list: boolean; value: Literal; onChange: (value: Literal) => void }) {
  if (list && choice.options) {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <span className="flex flex-wrap gap-2 py-1">
        {choice.options.map((option) => (
          <label key={option.value} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={chosen.includes(option.value)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, option.value] : chosen.filter((v) => v !== option.value))}
            />
            {option.label}
          </label>
        ))}
      </span>
    );
  }
  if (list) {
    return (
      <TextInput
        aria-label="Values, separated by commas"
        className="w-56"
        value={Array.isArray(value) ? value.join(', ') : ''}
        onChange={(e) => onChange(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))}
        placeholder="a, b, c"
      />
    );
  }
  if (choice.options) {
    return (
      <Select aria-label="Value" className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {choice.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  if (choice.kind === 'boolean') {
    return (
      <Select aria-label="Value" className="w-auto" value={value === false ? 'false' : 'true'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (choice.kind === 'number') {
    return <TextInput aria-label="Value" type="number" className="w-32" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
  }
  return <TextInput aria-label="Value" className="w-48" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
}

/** A condition the clauses can't show, edited as JSON. The platform checks it when the draft is saved. */
function JsonCondition({ label, value, onChange }: { label: string; value: Condition | undefined; onChange: (value: Condition | undefined) => void }) {
  const text = value ? JSON.stringify(value, null, 2) : '';
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(text), [text]);
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm text-muted">{label}</legend>
      <p className="m-0 text-sm text-muted">This condition has a shape the editor can't show, so it's edited as JSON.</p>
      <textarea
        aria-label={`${label}, as JSON`}
        className="mono min-h-32 w-full rounded-sm border border-line-strong bg-sunken p-2 text-sm"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          try {
            onChange(draft.trim() ? (JSON.parse(draft) as Condition) : undefined);
            setError(null);
          } catch (e) {
            setError(`That isn't valid JSON: ${(e as Error).message}`);
          }
        }}
      />
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </fieldset>
  );
}
