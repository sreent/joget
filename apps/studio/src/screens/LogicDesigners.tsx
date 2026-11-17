import { useState, type ReactNode } from 'react';
import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { GroupFields, MeasureFields, RangeFields } from '../components/summary.js';
import { Badge, Button, Card, Checkbox, cx, EmptyState, Field, Select, TextInput } from '../components/ui.js';
import { recordChoices, type RefChoice } from '../model/conditions.js';
import { isName, lineOwner } from '../model/edit.js';
import { groupPaths } from '../model/pages.js';
import { addItem, recordEntities, removeItem, renameItem, updateItem, writableFields, type Section } from '../model/logic.js';
import type { Definition, Field as FieldDef } from '../types.js';
import { FlowRunEditor } from './FlowRunEditor.js';
import { StepsEditor } from './StepsEditor.js';

type Props = { definition: Definition; onChange: (definition: Definition) => void };

const ADD_LABEL: Record<Exclude<Section, 'roles'>, { noun: string; example: string; empty: string }> = {
  rules: { noun: 'rule', example: 'e.g. Hotel cap', empty: 'A rule is a check the platform runs on every change, whoever makes it: a form, an agent or the API.' },
  actions: { noun: 'action', example: 'e.g. Approve a claim', empty: 'An action changes records: people use it in forms, and agents as a tool.' },
  queries: { noun: 'query', example: 'e.g. My open claims', empty: 'A query is a named question about records, which agents can ask too.' },
  cards: { noun: 'review card', example: 'e.g. Claim review', empty: 'A review card is what a person checks before they confirm what an agent prepared.' },
};

/** A list of a section's items on the left, the selected one's panel on the right. */
function ItemsLayout(props: Props & { section: Exclude<Section, 'roles'>; describe: (name: string) => ReactNode; panel: (name: string) => ReactNode }) {
  const { definition, onChange, section } = props;
  const names = Object.keys(definition[section]);
  const [selected, setSelected] = useState<string | null>(names[0] ?? null);
  const [label, setLabel] = useState('');
  const current = selected && selected in definition[section] ? selected : (names[0] ?? null);
  const words = ADD_LABEL[section];
  return (
    <div className="grid gap-4 @min-[62rem]:grid-cols-[16rem_minmax(0,1fr)]">
      <Card className="grid content-start gap-3 p-4">
        <ul className="m-0 grid list-none gap-1 p-0">
          {names.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => setSelected(name)}
                aria-current={name === current ? 'true' : undefined}
                className={cx('w-full rounded-md px-2.5 py-1.5 text-left', name === current ? 'bg-accent-soft text-text' : 'hover:bg-sunken')}
              >
                {props.describe(name)}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!label.trim() || !Object.keys(definition.entities).length) return;
            const added = addItem(definition, section, label.trim());
            onChange(added.definition);
            setSelected(added.name);
            setLabel('');
          }}
        >
          <TextInput aria-label={`New ${words.noun}`} placeholder={`New ${words.noun}, ${words.example}`} value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" size="sm" disabled={!label.trim() || !Object.keys(definition.entities).length}>
            Add {words.noun}
          </Button>
        </form>
      </Card>
      {current ? (
        <Card key={current} className="grid content-start gap-4">
          <NameEditor
            name={current}
            taken={names}
            onRename={(to) => {
              onChange(renameItem(definition, section, current, to));
              setSelected(to);
            }}
          />
          {props.panel(current)}
          <div className="border-t border-line pt-3">
            <Button variant="danger" size="sm" onClick={() => (onChange(removeItem(definition, section, current)), setSelected(null))}>
              Delete this {words.noun}
            </Button>
          </div>
        </Card>
      ) : (
        <EmptyState title={`No ${words.noun === 'query' ? 'queries' : `${words.noun}s`} yet`}>{words.empty}</EmptyState>
      )}
    </div>
  );
}

function NameEditor({ name, taken, onRename }: { name: string; taken: readonly string[]; onRename: (to: string) => void }) {
  const [value, setValue] = useState(name);
  const valid = isName(value) && (value === name || !taken.includes(value));
  return (
    <Field label="Name" hint={valid ? 'Agents and the API use this name. Renaming carries through to what uses it.' : 'Lowercase letters, digits and underscores, not used by another'}>
      {(id) => <TextInput id={id} className="mono" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => (valid && value !== name ? onRename(value) : setValue(name))} />}
    </Field>
  );
}

/** Checkboxes for a set of names, kept in the options' order. */
export function Checklist({ label, options, selected, onChange, hint }: { label: string; options: ReadonlyArray<{ value: string; label: string }>; selected: readonly string[]; onChange: (next: string[]) => void; hint?: ReactNode }) {
  return (
    <fieldset className="m-0 grid gap-1.5 border-0 p-0">
      <legend className="mb-1 text-sm text-muted">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            checked={selected.includes(option.value)}
            onChange={(on) => onChange(options.map((o) => o.value).filter((value) => (value === option.value ? on : selected.includes(value))))}
          />
        ))}
      </div>
      {hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </fieldset>
  );
}

/** Radio buttons, as a choice of a few. */
export function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string; hint?: string }>; onChange: (value: T) => void }) {
  return (
    <fieldset className="m-0 grid gap-1.5 border-0 p-0">
      <legend className="mb-1 text-sm text-muted">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="flex items-start gap-2">
          <input type="radio" className="mt-1 size-4 accent-[var(--accent)]" checked={value === option.value} onChange={() => onChange(option.value)} />
          <span>
            {option.label}
            {option.hint ? <span className="block text-xs text-faint">{option.hint}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Every entity, lines marked as the lines of their record. */
function entityOptions(definition: Definition, withLines: boolean) {
  return Object.entries(definition.entities).flatMap(([name, entity]) => {
    const owner = lineOwner(definition, name);
    if (owner && !withLines) return [];
    return [{ value: name, label: owner ? `${entity.label} (lines of ${definition.entities[owner.parent]!.label})` : entity.label }];
  });
}

const fieldsOf = (definition: Definition, entity: string): FieldDef[] => definition.entities[entity]?.fields ?? [];

// Rules

export function RulesDesigner({ definition, onChange }: Props) {
  return (
    <ItemsLayout
      definition={definition}
      onChange={onChange}
      section="rules"
      describe={(name) => {
        const rule = definition.rules[name]!;
        return (
          <>
            <span className="flex items-center gap-2 font-medium">
              {name} <Badge tone={rule.severity === 'warning' ? 'warn' : 'bad'}>{rule.severity === 'warning' ? 'warns' : 'blocks'}</Badge>
            </span>
            <span className="text-xs text-faint">{definition.entities[rule.entity]?.label ?? rule.entity}</span>
          </>
        );
      }}
      panel={(name) => <RulePanel definition={definition} onChange={onChange} name={name} />}
    />
  );
}

function RulePanel({ definition, onChange, name }: Props & { name: string }) {
  const rule = definition.rules[name]!;
  const line = Boolean(lineOwner(definition, rule.entity));
  const choices = recordChoices(definition, rule.entity, line);
  const set = (patch: Partial<typeof rule>) => onChange(updateItem(definition, 'rules', name, patch));
  return (
    <>
      <Field label="Checks" hint={line ? 'A rule on lines checks every line, and says which line a problem is on.' : undefined}>
        {(id) => (
          <Select
            id={id}
            value={rule.entity}
            onChange={(e) => {
              const first = recordChoices(definition, e.target.value, Boolean(lineOwner(definition, e.target.value)))[0];
              set({ entity: e.target.value, when: undefined, fields: undefined, assert: { exists: first?.ref ?? 'record.id' } });
            }}
          >
            {entityOptions(definition, true).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <ConditionEditor label="Only when" value={rule.when} onChange={(when) => set({ when })} choices={choices} compareWith={[THE_PERSON]} empty="Always: the rule checks every record." />
      <ConditionEditor label="Must hold" value={rule.assert} onChange={(assert) => (assert ? set({ assert }) : undefined)} choices={choices} compareWith={[THE_PERSON]} />
      <Choice
        label="When it doesn't hold"
        value={rule.severity ?? 'error'}
        onChange={(severity) => set({ severity })}
        options={[
          { value: 'error', label: 'Block the change', hint: 'Nobody can save it: a form shows the message, and an agent gets it back.' },
          { value: 'warning', label: 'Warn whoever approves', hint: 'The change can go ahead. The warning travels with it, first on its review card.' },
        ]}
      />
      <Field label="Message">{(id) => <TextInput id={id} value={rule.message} onChange={(e) => set({ message: e.target.value })} />}</Field>
      <Checklist
        label="Points at"
        options={fieldsOf(definition, rule.entity).filter((f) => f.type !== 'lines').map((f) => ({ value: f.name, label: f.label }))}
        selected={rule.fields ?? []}
        onChange={(fields) => set({ fields: fields.length ? fields : undefined })}
        hint="Screens highlight these fields when the rule doesn't hold."
      />
    </>
  );
}

// Actions

const CONFIRM_OPTIONS = [
  { value: 'none' as const, label: 'None: it runs straight away', hint: 'For changes that are easy to undo.' },
  { value: 'preview' as const, label: 'Preview: one tap to confirm', hint: 'An agent shows the review card, and the person confirms it.' },
  { value: 'review' as const, label: 'Review: a full review, findings first', hint: 'For anything out of policy, or hard to undo.' },
];

export function ActionsDesigner({ definition, onChange }: Props) {
  return (
    <ItemsLayout
      definition={definition}
      onChange={onChange}
      section="actions"
      describe={(name) => {
        const action = definition.actions[name]!;
        return (
          <>
            <span className="block font-medium">{action.label}</span>
            <span className="text-xs text-faint">
              {action.operation === 'create' ? 'Creates' : 'Changes'} {definition.entities[action.entity]?.label.toLowerCase() ?? action.entity} · confirm: {action.confirm ?? 'preview'}
            </span>
          </>
        );
      }}
      panel={(name) => <ActionPanel definition={definition} onChange={onChange} name={name} />}
    />
  );
}

function ActionPanel({ definition, onChange, name }: Props & { name: string }) {
  const action = definition.actions[name]!;
  const set = (patch: Partial<typeof action>) => onChange(updateItem(definition, 'actions', name, patch));
  const fields = fieldsOf(definition, action.entity);
  const writable = writableFields(definition, action.entity);
  const inputs = action.input ?? [];
  const setValues = action.set ?? {};
  const settable = fields.filter((f) => writable.includes(f.name) && f.type !== 'lines' && f.type !== 'file' && !inputs.includes(f.name));
  const cards = Object.entries(definition.cards).filter(([, card]) => card.entity === action.entity);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">{(id) => <TextInput id={id} value={action.label} onChange={(e) => set({ label: e.target.value })} />}</Field>
        <Field label="Works on">
          {(id) => (
            <Select id={id} value={action.entity} onChange={(e) => set({ entity: e.target.value, input: writableFields(definition, e.target.value), set: {}, where: undefined, card: undefined, steps: undefined, flow: undefined })}>
              {entityOptions(definition, false).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="Description" hint="Agents read this to choose the action: say what it does, and when to use it.">
        {(id) => <textarea id={id} className="min-h-20 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5" value={action.description} onChange={(e) => set({ description: e.target.value })} />}
      </Field>
      <Choice
        label="It"
        value={action.operation}
        onChange={(operation) => set({ operation, where: undefined })}
        options={[
          { value: 'create', label: 'Creates a record' },
          { value: 'update', label: 'Changes a record' },
        ]}
      />
      <Checklist
        label="Takes as input"
        options={[...fields.filter((f) => writable.includes(f.name)).map((f) => ({ value: f.name, label: f.label })), { value: 'owner', label: "Owner (who it's for)" }]}
        selected={inputs}
        onChange={(input) => set({ input, set: Object.fromEntries(Object.entries(setValues).filter(([field]) => !input.includes(field))) })}
        hint="What a person fills in, or an agent provides. Required fields must be inputs, set here, or have a default."
      />
      <div className="grid gap-2">
        <span className="text-sm text-muted">Sets, whatever the input</span>
        {Object.entries(setValues).map(([field, value]) => {
          const declared = fields.find((f) => f.name === field);
          return (
            <div key={field} className="flex flex-wrap items-center gap-2">
              <span className="min-w-28 font-medium">{declared?.label ?? field}</span>
              <span className="text-muted">to</span>
              {declared ? <LiteralInput field={declared} value={value} onChange={(next) => set({ set: { ...setValues, [field]: next } })} /> : null}
              <Button size="sm" variant="ghost" aria-label={`Stop setting ${declared?.label ?? field}`} onClick={() => set({ set: Object.fromEntries(Object.entries(setValues).filter(([f]) => f !== field)) })}>
                ✕
              </Button>
            </div>
          );
        })}
        {settable.filter((f) => !(f.name in setValues)).length ? (
          <Select
            aria-label="Set a field"
            className="w-auto justify-self-start"
            value=""
            onChange={(e) => {
              const field = fields.find((f) => f.name === e.target.value);
              if (field) set({ set: { ...setValues, [field.name]: initialLiteral(field) } });
            }}
          >
            <option value="">Set a field…</option>
            {settable
              .filter((f) => !(f.name in setValues))
              .map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
          </Select>
        ) : null}
      </div>
      {action.operation === 'update' ? (
        <ConditionEditor
          label="Applies to records where"
          value={action.where}
          onChange={(where) => set({ where })}
          choices={recordChoices(definition, action.entity)}
          compareWith={[THE_PERSON]}
          empty="Every record the person may change."
        />
      ) : null}
      <StepsEditor definition={definition} onChange={onChange} action={name} />
      {Object.keys(definition.flows ?? {}).length || action.flow ? (
        <FlowRunEditor
          definition={definition}
          entity={action.entity}
          person
          label="Then runs a flow"
          hint="In the same transaction, after the record is saved: if the flow fails, nothing is saved."
          none="No flow"
          value={action.flow}
          onChange={(flow) => set({ flow })}
        />
      ) : null}
      <Choice label="Before it commits, when an agent runs it" value={action.confirm ?? 'preview'} onChange={(confirm) => set({ confirm })} options={CONFIRM_OPTIONS} />
      <Field label="Review card" hint="What the person checks before they confirm.">
        {(id) => (
          <Select id={id} value={action.card ?? ''} onChange={(e) => set({ card: e.target.value || undefined })}>
            <option value="">A card of what it writes</option>
            {cards.map(([card]) => (
              <option key={card} value={card}>
                {card}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

type SetValue = Definition['actions'][string]['set'][string];

function initialLiteral(field: FieldDef): SetValue {
  switch (field.type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'choice':
      return field.multiple ? [] : (field.options[0]?.value ?? '');
    default:
      return '';
  }
}

/** A value an action sets, in the input its field's type needs. */
function LiteralInput({ field, value, onChange }: { field: FieldDef; value: SetValue; onChange: (value: SetValue) => void }) {
  const label = `Value of ${field.label}`;
  if (field.type === 'choice' && !field.multiple) {
    return (
      <Select aria-label={label} className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <Select aria-label={label} className="w-auto" value={value === false ? 'false' : 'true'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (field.type === 'number') return <TextInput aria-label={label} type="number" className="w-32" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(Number(e.target.value))} />;
  if (field.type === 'date') return <TextInput aria-label={label} type="date" className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  return <TextInput aria-label={label} className="w-56" value={typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : ''} onChange={(e) => onChange(e.target.value)} />;
}

// Queries

export function QueriesDesigner({ definition, onChange }: Props) {
  return (
    <ItemsLayout
      definition={definition}
      onChange={onChange}
      section="queries"
      describe={(name) => (
        <>
          <span className="block font-medium">{definition.queries[name]!.label}</span>
          <span className="text-xs text-faint">
            {definition.entities[definition.queries[name]!.entity]?.pluralLabel ?? definition.queries[name]!.entity}
            {definition.queries[name]!.summary ? ' · numbers' : ''}
          </span>
        </>
      )}
      panel={(name) => <QueryPanel definition={definition} onChange={onChange} name={name} />}
    />
  );
}

const SYSTEM_RESULTS = [
  { value: 'created_at', label: 'Created' },
  { value: 'updated_at', label: 'Last changed' },
  { value: 'owner', label: 'Owner' },
];

function QueryPanel({ definition, onChange, name }: Props & { name: string }) {
  const query = definition.queries[name]!;
  const summary = query.summary;
  const set = (patch: Partial<typeof query>) => onChange(updateItem(definition, 'queries', name, patch));
  const fields = fieldsOf(definition, query.entity);
  const parameters = Object.entries(query.parameters ?? {});
  const params: RefChoice[] = parameters.map(([param, spec]) => ({ ref: `input.${param}`, label: `the input ${param}`, kind: spec.type === 'text' ? 'text' : spec.type }));
  const sortable = [...fields.filter((f) => f.type !== 'lines' && !(f.type === 'choice' && f.multiple)).map((f) => ({ value: f.name, label: f.label })), ...SYSTEM_RESULTS];
  const sort = query.sort ?? [];
  const [newParam, setNewParam] = useState('');
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">{(id) => <TextInput id={id} value={query.label} onChange={(e) => set({ label: e.target.value })} />}</Field>
        <Field label="Asks about">
          {(id) => (
            <Select id={id} value={query.entity} onChange={(e) => set({ entity: e.target.value, fields: ['created_at'], filter: undefined, sort: [], summary: undefined })}>
              {entityOptions(definition, false).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="Description" hint="Agents read this to choose the query: say what it answers.">
        {(id) => <textarea id={id} className="min-h-16 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5" value={query.description} onChange={(e) => set({ description: e.target.value })} />}
      </Field>
      <Choice
        label="It answers with"
        value={summary ? (summary.group ? 'groups' : 'number') : 'records'}
        options={[
          { value: 'records', label: 'Records', hint: 'A list, with the fields you choose.' },
          { value: 'number', label: 'A number', hint: 'How many, or a total, such as how much was claimed this year.' },
          { value: 'groups', label: 'A number for each group', hint: 'Such as the total for each category, or for each month.' },
        ]}
        onChange={(kind) => set(answerWith(definition, query, kind))}
      />
      {summary ? (
        <>
          <MeasureFields definition={definition} entity={query.entity} measure={summary.measure} onChange={(measure) => set({ summary: { ...summary, measure } })} />
          {summary.group ? (
            <>
              <GroupFields definition={definition} entity={query.entity} group={summary.group} onChange={(group) => set({ summary: { ...summary, group } })} />
              <Field label={summary.group.period ? 'Latest periods' : 'Largest groups'} hint={summary.group.period ? undefined : 'The rest come back as one number, where they add up.'}>
                {(id) => (
                  <TextInput id={id} type="number" className="w-32" min={2} max={24} value={summary.limit ?? 8} onChange={(e) => set({ summary: { ...summary, limit: Math.min(24, Math.max(2, Number(e.target.value) || 2)) } })} />
                )}
              </Field>
            </>
          ) : null}
          <RangeFields
            definition={definition}
            entity={query.entity}
            range={summary.range}
            onChange={(range) => set({ summary: range ? { ...summary, range } : Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'range')) as typeof summary })}
          />
        </>
      ) : (
        <Checklist
          label="Each result shows"
          options={[...fields.map((f) => ({ value: f.name, label: f.label })), ...SYSTEM_RESULTS]}
          selected={query.fields}
          onChange={(next) => (next.length ? set({ fields: next }) : undefined)}
        />
      )}
      <div className="grid gap-2">
        <span className="text-sm text-muted">Inputs the person or agent gives</span>
        {parameters.map(([param, spec]) => (
          <div key={param} className="flex flex-wrap items-center gap-2">
            <code className="min-w-24">{param}</code>
            <Select aria-label={`Type of ${param}`} className="w-auto" value={spec.type} onChange={(e) => set({ parameters: { ...query.parameters, [param]: { ...spec, type: e.target.value as typeof spec.type } } })}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Yes or no</option>
            </Select>
            <TextInput aria-label={`What ${param} is`} className="min-w-48 flex-1" value={spec.description} onChange={(e) => set({ parameters: { ...query.parameters, [param]: { ...spec, description: e.target.value } } })} />
            <Checkbox label="Required" checked={spec.required ?? false} onChange={(required) => set({ parameters: { ...query.parameters, [param]: { ...spec, required } } })} />
            <Button size="sm" variant="ghost" aria-label={`Remove ${param}`} onClick={() => set({ parameters: Object.fromEntries(parameters.filter(([p]) => p !== param)) })}>
              ✕
            </Button>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isName(newParam) || newParam in (query.parameters ?? {})) return;
            set({ parameters: { ...query.parameters, [newParam]: { type: 'text', description: `The ${newParam.replaceAll('_', ' ')}`, required: false } } });
            setNewParam('');
          }}
        >
          <TextInput aria-label="New input" className="mono w-48" placeholder="new_input" value={newParam} onChange={(e) => setNewParam(e.target.value)} />
          <Button type="submit" size="sm" disabled={!isName(newParam) || newParam in (query.parameters ?? {})}>
            Add input
          </Button>
        </form>
      </div>
      <ConditionEditor
        label="Only records where"
        value={query.filter}
        onChange={(filter) => set({ filter })}
        choices={recordChoices(definition, query.entity)}
        compareWith={[THE_PERSON, ...params]}
        empty="Every record the person may see."
      />
      {summary ? null : (
      <>
      <div className="grid gap-2">
        <span className="text-sm text-muted">Sorted by</span>
        {sort.map((key, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Select aria-label={`Sort ${index + 1}`} className="w-auto" value={key.field} onChange={(e) => set({ sort: sort.map((k, i) => (i === index ? { ...k, field: e.target.value } : k)) })}>
              {sortable.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select aria-label={`Direction ${index + 1}`} className="w-auto" value={key.direction ?? 'asc'} onChange={(e) => set({ sort: sort.map((k, i) => (i === index ? { ...k, direction: e.target.value as 'asc' | 'desc' } : k)) })}>
              <option value="asc">lowest or oldest first</option>
              <option value="desc">highest or newest first</option>
            </Select>
            <Button size="sm" variant="ghost" aria-label={`Remove sort ${index + 1}`} onClick={() => set({ sort: sort.filter((_, i) => i !== index) })}>
              ✕
            </Button>
          </div>
        ))}
        {sort.length < 3 && sortable[0] ? (
          <div>
            <Button size="sm" onClick={() => set({ sort: [...sort, { field: sortable[0]!.value, direction: 'asc' }] })}>
              Add a sort
            </Button>
          </div>
        ) : null}
      </div>
      <Field label="At most this many results at a time">
        {(id) => <TextInput id={id} type="number" className="w-32" min={1} max={200} value={query.limit ?? 50} onChange={(e) => set({ limit: Math.min(200, Math.max(1, Number(e.target.value) || 1)) })} />}
      </Field>
      </>
      )}
    </>
  );
}

type Query = Definition['queries'][string];

/** Switch what a query answers with: records, a number, or a number for each group. What it worked out so far stays. */
function answerWith(definition: Definition, query: Query, kind: 'records' | 'number' | 'groups'): Partial<Query> {
  if (kind === 'records') return { summary: undefined, fields: query.fields.length ? query.fields : ['created_at'] };
  const measure = query.summary?.measure ?? { op: 'count' as const };
  const range = query.summary?.range ? { range: query.summary.range } : {};
  if (kind === 'number') return { summary: { measure, ...range, limit: query.summary?.limit ?? 8 }, fields: [], sort: [] };
  const groups = groupPaths(definition, query.entity);
  const first = query.summary?.group ? undefined : (groups.find((g) => !g.dated) ?? groups[0]);
  const group = query.summary?.group ?? (first ? (first.dated ? { field: first.value, period: 'month' as const } : { field: first.value }) : { field: 'created_at', period: 'month' as const });
  return { summary: { measure, group, ...range, limit: query.summary?.limit ?? 8 }, fields: [], sort: [] };
}

// Review cards

export function CardsDesigner({ definition, onChange }: Props) {
  return (
    <ItemsLayout
      definition={definition}
      onChange={onChange}
      section="cards"
      describe={(name) => (
        <>
          <span className="block font-medium">{name}</span>
          <span className="text-xs text-faint">{definition.entities[definition.cards[name]!.entity]?.label ?? definition.cards[name]!.entity}</span>
        </>
      )}
      panel={(name) => <CardPanel definition={definition} onChange={onChange} name={name} />}
    />
  );
}

function CardPanel({ definition, onChange, name }: Props & { name: string }) {
  const card = definition.cards[name]!;
  const set = (patch: Partial<typeof card>) => onChange(updateItem(definition, 'cards', name, patch));
  const fields = fieldsOf(definition, card.entity);
  const single = fields.filter((f) => f.type !== 'lines');
  const linesFields = fields.filter((f) => f.type === 'lines');
  const tableOf = card.table ? linesFields.find((f) => f.name === card.table!.of) : undefined;
  const lineFields = tableOf?.type === 'lines' ? fieldsOf(definition, tableOf.entity) : [];
  const label = (field: string) => single.find((f) => f.name === field)?.label ?? field;
  return (
    <div className="grid gap-4 @min-[78rem]:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="grid content-start gap-4">
        <Field label="Shows">
          {(id) => (
            <Select id={id} value={card.entity} onChange={(e) => set({ entity: e.target.value, title: `{{${fieldsOf(definition, e.target.value)[0]?.name ?? 'id'}}}`, show: [], table: undefined })}>
              {entityOptions(definition, false).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Title" hint="Put a field's value in it as {{name}}.">
          {(id) => (
            <div className="flex flex-wrap gap-2">
              <TextInput id={id} className="min-w-48 flex-1" value={card.title} onChange={(e) => set({ title: e.target.value })} />
              <Select aria-label="Insert a field" className="w-auto" value="" onChange={(e) => e.target.value && set({ title: `${card.title} {{${e.target.value}}}`.trim() })}>
                <option value="">Insert a field…</option>
                {single.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </Field>
        <Checklist label="Fields it shows, after any rule findings" options={single.map((f) => ({ value: f.name, label: f.label }))} selected={card.show} onChange={(show) => (show.length ? set({ show }) : undefined)} />
        {linesFields.length ? (
          <>
            <Field label="Lines, as a table">
              {(id) => (
                <Select
                  id={id}
                  value={card.table?.of ?? ''}
                  onChange={(e) => {
                    const lines = linesFields.find((f) => f.name === e.target.value);
                    set({ table: lines?.type === 'lines' ? { of: lines.name, columns: fieldsOf(definition, lines.entity).map((f) => f.name) } : undefined });
                  }}
                >
                  <option value="">No table</option>
                  {linesFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {card.table ? (
              <Checklist
                label="Columns"
                options={lineFields.map((f) => ({ value: f.name, label: f.label }))}
                selected={card.table.columns}
                onChange={(columns) => (columns.length ? set({ table: { ...card.table!, columns } }) : undefined)}
              />
            ) : null}
          </>
        ) : null}
      </div>
      <div className="grid content-start gap-2" aria-label="Preview">
        <span className="text-sm text-muted">Preview</span>
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          <div className="h-1 bg-[var(--changes)]" />
          <div className="grid gap-2 p-3 text-sm">
            <p className="m-0 font-semibold">{card.title.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, field: string) => `[${label(field)}]`)}</p>
            <p className="m-0 rounded-sm bg-warn-bg px-2 py-1 text-warn">Rule findings come first</p>
            <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
              {card.show.map((field) => (
                <div key={field} className="contents">
                  <dt className="text-muted">{label(field)}</dt>
                  <dd className="m-0 text-faint">…</dd>
                </div>
              ))}
            </dl>
            {card.table ? (
              <p className="m-0 text-faint">
                {tableOf?.label}: {card.table.columns.map((c) => lineFields.find((f) => f.name === c)?.label ?? c).join(' · ')}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
