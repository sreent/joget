import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { ConditionEditor } from '../components/condition.js';
import { Badge, Button, Card, Checkbox, cx, EmptyState, Field, Select, TextInput } from '../components/ui.js';
import { recordChoices } from '../model/conditions.js';
import {
  addEntity,
  addField,
  changeFieldType,
  FIELD_TYPES,
  isName,
  lineOwner,
  moveField,
  removeEntity,
  removeField,
  renameEntity,
  rollupChoices,
  rollupKey,
  setFormula,
  setRollup,
  typeLabel,
  updateEntity,
  updateField,
} from '../model/edit.js';
import { SYSTEM_REFS, valueSources } from '../model/expressions.js';
import { type Definition, type Field as FieldDef, type FieldType, isWorkedOut } from '../types.js';
import { ModelCanvas } from './ModelCanvas.js';
import { ValueEditor } from './ValueEditor.js';

type Props = { definition: Definition; onChange: (definition: Definition) => void };

/** The data model: entities, and their fields. Renaming keeps a field's data; changing its type doesn't. */
export function DataDesigner({ definition, onChange }: Props) {
  const names = Object.keys(definition.entities);
  // Line entities are listed under the entity whose lines they are.
  const owners = new Map(names.flatMap((name) => (lineOwner(definition, name) ? [[name, lineOwner(definition, name)!] as const] : [])));
  const ordered = names.filter((name) => !owners.has(name)).flatMap((name) => [name, ...names.filter((n) => owners.get(n)?.parent === name)]);
  const [selected, setSelected] = useState<string | null>(ordered[0] ?? null);
  const [field, setField] = useState<number | null>(null);
  const [newEntity, setNewEntity] = useState('');
  // The model as a canvas of all its entities, or the chosen entity's fields as a list.
  const [show, setShow] = useState<'canvas' | 'list'>('list');
  const entityName = selected && definition.entities[selected] ? selected : (ordered[0] ?? null);
  const entity = entityName ? definition.entities[entityName] : undefined;

  return (
    <div className="grid gap-4 @min-[62rem]:grid-cols-[15rem_minmax(0,1fr)_21rem]">
      <Card className="grid content-start gap-3 p-4">
        <h2 className="m-0 text-sm font-semibold text-muted">Entities</h2>
        <ul className="m-0 grid list-none gap-1 p-0">
          {ordered.map((name) => (
            <li key={name} className={cx(owners.has(name) && 'ml-3 border-l border-line pl-2')}>
              <button
                type="button"
                onClick={() => {
                  setSelected(name);
                  setField(null);
                }}
                aria-current={name === entityName ? 'true' : undefined}
                className={cx('w-full rounded-md px-2.5 py-1.5 text-left', name === entityName ? 'bg-accent-soft text-text' : 'hover:bg-sunken')}
              >
                <span className="block font-medium">{definition.entities[name]!.label}</span>
                <code className="text-xs text-faint">{owners.has(name) ? `lines of ${owners.get(name)!.parent}` : name}</code>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newEntity.trim()) return;
            const result = addEntity(definition, newEntity.trim());
            onChange(result.definition);
            setSelected(result.name);
            setField(0);
            setNewEntity('');
          }}
        >
          <TextInput aria-label="New entity" placeholder="New entity, e.g. Purchase request" value={newEntity} onChange={(e) => setNewEntity(e.target.value)} />
          <Button type="submit" size="sm" disabled={!newEntity.trim()}>
            Add entity
          </Button>
        </form>
      </Card>

      <div className="grid min-w-0 content-start gap-3">
        <div className="modes justify-self-end" role="group" aria-label="Show the data as">
          <button type="button" aria-pressed={show === 'canvas'} onClick={() => setShow('canvas')}>
            Canvas
          </button>
          <button type="button" aria-pressed={show === 'list'} onClick={() => setShow('list')}>
            List
          </button>
        </div>
        {show === 'canvas' && entityName ? (
          <ModelCanvas
            definition={definition}
            entity={entityName}
            field={field}
            onPick={(name, index) => {
              setSelected(name);
              setField(index ?? null);
            }}
            onAddField={(name) => {
              const result = addField(definition, name);
              onChange(result.definition);
              setSelected(name);
              setField(result.index);
            }}
          />
        ) : entity && entityName ? (
          <EntityPanel
            key={entityName}
            definition={definition}
            name={entityName}
            selectedField={field}
            onSelectField={setField}
            onChange={onChange}
            onRename={(to) => {
              onChange(renameEntity(definition, entityName, to));
              setSelected(to);
            }}
            onRemove={() => {
              onChange(removeEntity(definition, entityName));
              setSelected(null);
              setField(null);
            }}
          />
        ) : (
          <EmptyState title="No entities yet">An entity is a kind of record, such as an expense claim. Add one on the left.</EmptyState>
        )}
      </div>

      {entity && entityName && field !== null && entity.fields[field] ? (
        <FieldPanel
          key={`${entityName}:${field}`}
          definition={definition}
          entity={entityName}
          index={field}
          onChange={onChange}
          onOpenEntity={(name) => {
            setSelected(name);
            setField(null);
          }}
          onRemove={() => {
            onChange(removeField(definition, entityName, field));
            setField(null);
          }}
          onMove={(to) => {
            onChange(moveField(definition, entityName, field, to));
            setField(to);
          }}
        />
      ) : (
        <Card className="text-sm text-muted">Select a field to change it.</Card>
      )}
    </div>
  );
}

function EntityPanel(props: {
  definition: Definition;
  name: string;
  selectedField: number | null;
  onSelectField: (index: number) => void;
  onChange: (definition: Definition) => void;
  onRename: (to: string) => void;
  onRemove: () => void;
}) {
  const { definition, name, onChange } = props;
  const entity = definition.entities[name]!;
  const owner = lineOwner(definition, name);
  const [rename, setRename] = useState(name);
  const [newType, setNewType] = useState<FieldType>('text');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = entity.fields.map((f) => f.name);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    onChange(moveField(definition, name, from, to));
    props.onSelectField(to);
  };

  return (
    <Card className="grid content-start gap-4">
      {owner ? (
        <p className="m-0 rounded-md bg-sunken px-3 py-2 text-sm text-muted">
          These are the lines of <strong className="text-text">{definition.entities[owner.parent]!.label}</strong>, in its{' '}
          <strong className="text-text">{definition.entities[owner.parent]!.fields.find((f) => f.name === owner.field)?.label ?? owner.field}</strong> field.
          Each line belongs to its record: it is read, changed and kept in history with it, under the same permissions.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          {(id) => <TextInput id={id} value={entity.label} onChange={(e) => onChange(updateEntity(definition, name, { label: e.target.value }))} />}
        </Field>
        <Field label="Plural label">
          {(id) => (
            <TextInput
              id={id}
              value={entity.pluralLabel ?? ''}
              placeholder={entity.label}
              onChange={(e) => onChange(updateEntity(definition, name, { pluralLabel: e.target.value }))}
            />
          )}
        </Field>
        <Field
          label="Name"
          hint={
            isName(rename)
              ? 'Renaming keeps every record. References follow when you save.'
              : 'Lowercase letters, digits and underscores, starting with a letter'
          }
        >
          {(id) => (
            <TextInput
              id={id}
              className="mono"
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              onBlur={() => (isName(rename) && rename !== name ? props.onRename(rename) : setRename(name))}
            />
          )}
        </Field>
        <Field label={owner ? 'Lines are named by' : 'Records are named by'}>
          {(id) => (
            <Select id={id} value={entity.titleField ?? ''} onChange={(e) => onChange(updateEntity(definition, name, { titleField: e.target.value }))}>
              <option value="">(their ID)</option>
              {entity.fields
                .filter((f) => f.type !== 'lines')
                .map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      </div>
      {owner ? null : (
        <Checkbox
          label="Keep a history of every change to these records"
          checked={entity.history !== false}
          onChange={(value) => onChange(updateEntity(definition, name, { history: value }))}
        />
      )}

      <div className="grid gap-2">
        <h3 className="m-0 text-sm font-semibold text-muted">Fields</h3>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {entity.fields.map((f, index) => (
                <FieldRow key={f.name} field={f} selected={props.selectedField === index} onSelect={() => props.onSelectField(index)} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <div className="flex gap-2">
          <Select aria-label="Type of the new field" value={newType} onChange={(e) => setNewType(e.target.value as FieldType)} className="w-auto">
            {/* Lines go one level deep: lines can't have lines of their own. */}
            {FIELD_TYPES.filter((t) => !(owner && t.type === 'lines')).map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </Select>
          <Button
            onClick={() => {
              const result = addField(definition, name, newType);
              onChange(result.definition);
              props.onSelectField(result.index);
            }}
          >
            Add field
          </Button>
        </div>
      </div>
      <div className="border-t border-line pt-3">
        <Button variant="danger" size="sm" onClick={props.onRemove}>
          Delete {entity.label}
        </Button>
      </div>
    </Card>
  );
}

function FieldRow({ field, selected, onSelect }: { field: FieldDef; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.name });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(
        'flex items-center gap-2 rounded-md border bg-surface px-2 py-1.5',
        selected ? 'border-accent' : 'border-line',
        isDragging && 'opacity-60 shadow-raised',
      )}
    >
      <button type="button" aria-label={`Move ${field.label}`} className="cursor-grab rounded px-1 text-faint hover:text-text" {...attributes} {...listeners}>
        ⠿
      </button>
      <button type="button" onClick={onSelect} className="flex flex-1 items-center gap-2 text-left">
        <span className="font-medium">{field.label}</span>
        <code className="text-xs text-faint">{field.name}</code>
        <span className="flex-1" />
        {field.required ? <Badge tone="warn">required</Badge> : null}
        {field.classification === 'pii' ? (
          <Badge tone="bad">PII</Badge>
        ) : field.classification === 'confidential' ? (
          <Badge tone="warn">confidential</Badge>
        ) : null}
        {isWorkedOut(field) ? <Badge tone="good">worked out</Badge> : null}
        <Badge>{typeLabel(field.type)}</Badge>
      </button>
    </li>
  );
}

function FieldPanel(props: {
  definition: Definition;
  entity: string;
  index: number;
  onChange: (d: Definition) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
  onOpenEntity: (name: string) => void;
}) {
  const { definition, entity, index, onChange } = props;
  const fields = definition.entities[entity]!.fields;
  const field = fields[index]!;
  const set = (patch: Record<string, unknown>) => onChange(updateField(definition, entity, index, patch));
  const [rename, setRename] = useState(field.name);
  const num = (value: string) => (value === '' ? undefined : Number(value));
  // What the platform works out: a total of lines, or a formula.
  const rollup = field.type === 'number' ? field.rollup : undefined;
  const formula = 'formula' in field ? field.formula : undefined;

  return (
    <Card className="grid content-start gap-3">
      <h2 className="m-0 text-sm font-semibold text-muted">Field</h2>
      <Field label="Label">{(id) => <TextInput id={id} value={field.label} onChange={(e) => set({ label: e.target.value })} />}</Field>
      <Field label="Name" hint={isName(rename) ? 'Renaming keeps the data.' : 'Lowercase letters, digits and underscores'}>
        {(id) => (
          <TextInput
            id={id}
            className="mono"
            value={rename}
            onChange={(e) => setRename(e.target.value)}
            onBlur={() => (isName(rename) && rename !== field.name ? set({ name: rename }) : setRename(field.name))}
          />
        )}
      </Field>
      <Field label="Type" hint={field.id ? "Changing the type deletes this field's values when you save." : undefined}>
        {(id) => (
          <Select id={id} value={field.type} onChange={(e) => onChange(changeFieldType(definition, entity, index, e.target.value as FieldType))}>
            {FIELD_TYPES.filter((t) => t.type === field.type || !(lineOwner(definition, entity) && t.type === 'lines')).map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}: {t.hint}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Description">
        {(id) => <TextInput id={id} value={field.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />}
      </Field>
      {FORMULA_TYPES.includes(field.type) ? (
        <Field
          label="Value"
          hint={rollup || formula !== undefined ? "Worked out whenever a record is saved, and stored. People and agents can't set it." : undefined}
        >
          {(id) => (
            <Select
              id={id}
              value={formula !== undefined ? 'formula' : rollupKey(field)}
              onChange={(e) => {
                const choice = e.target.value;
                if (choice === 'formula') onChange(setFormula(definition, entity, index, startingFormula(definition, entity, field)));
                else onChange(setRollup(setFormula(definition, entity, index, undefined), entity, index, choice));
              }}
            >
              <option value="">Entered by people</option>
              {field.type === 'number'
                ? rollupChoices(definition, entity).map((choice) => (
                    <option key={choice.key} value={choice.key}>
                      {choice.label}
                    </option>
                  ))
                : null}
              <option value="formula">Worked out by a formula</option>
            </Select>
          )}
        </Field>
      ) : null}
      {formula !== undefined ? (
        <div className="grid gap-1">
          <ValueEditor
            definition={definition}
            entity={entity}
            target={field}
            label="Formula"
            value={formula}
            stored
            onChange={(next) => set({ formula: next })}
          />
          <span className="text-xs text-faint">It reads only this record's fields, not the person or today, so the stored value stays true.</span>
        </div>
      ) : null}
      {rollup || formula !== undefined ? null : (
        <Checkbox
          label={field.type === 'lines' ? 'Needs at least one line' : 'Required'}
          checked={field.required}
          onChange={(value) => set({ required: value, ...(value ? { requiredWhen: undefined } : {}) })}
        />
      )}
      {field.type === 'lines' || rollup || formula !== undefined || field.required ? null : (
        <ConditionEditor
          label="Required when"
          value={field.requiredWhen}
          onChange={(requiredWhen) => set({ requiredWhen })}
          choices={recordChoices(definition, entity).filter((choice) => choice.ref !== `record.${field.name}`)}
          empty="Never: it may stay empty. Every way of writing a record checks it, not only forms."
        />
      )}
      {field.type === 'date' && formula === undefined ? <DateDefault value={field.default} onChange={(value) => set({ default: value })} /> : null}
      {field.type === 'datetime' && formula === undefined ? (
        <Checkbox
          label="Starts as the moment the record is created"
          checked={field.default !== undefined}
          onChange={(on) => set({ default: on ? { now: 0 } : undefined })}
        />
      ) : null}
      {field.type === 'user' ? (
        <Checkbox
          label="Starts as the person who creates the record"
          checked={field.default !== undefined}
          onChange={(on) => set({ default: on ? { me: true } : undefined })}
        />
      ) : null}
      {field.type === 'lines' ? (
        <>
          <div className="grid gap-1">
            <span className="text-sm text-muted">Each line is a</span>
            <Button size="sm" className="justify-start" onClick={() => props.onOpenEntity(field.entity)}>
              {definition.entities[field.entity]?.label ?? field.entity}: edit the fields of each line
            </Button>
          </div>
          <Field label="Most lines">
            {(id) => <TextInput id={id} type="number" min={1} max={500} value={field.max} onChange={(e) => set({ max: num(e.target.value) ?? 100 })} />}
          </Field>
        </>
      ) : (
        <Field label="Classification" hint="PII is masked for app roles unless a role unmasks it.">
          {(id) => (
            <Select id={id} value={field.classification} onChange={(e) => set({ classification: e.target.value })}>
              <option value="internal">Internal</option>
              <option value="confidential">Confidential</option>
              <option value="pii">Personal data (PII)</option>
            </Select>
          )}
        </Field>
      )}

      {field.type === 'text' ? (
        <>
          <Field label="Longest text">
            {(id) => (
              <TextInput id={id} type="number" min={1} max={10000} value={field.maxLength} onChange={(e) => set({ maxLength: num(e.target.value) ?? 1000 })} />
            )}
          </Field>
          <Checkbox label="Several lines" checked={field.multiline} onChange={(value) => set({ multiline: value })} />
        </>
      ) : null}
      {field.type === 'number' ? (
        <div className="grid grid-cols-3 gap-2">
          <Field label="Decimals">
            {(id) => <TextInput id={id} type="number" min={0} max={6} value={field.decimals} onChange={(e) => set({ decimals: num(e.target.value) ?? 0 })} />}
          </Field>
          <Field label="Least">{(id) => <TextInput id={id} type="number" value={field.min ?? ''} onChange={(e) => set({ min: num(e.target.value) })} />}</Field>
          <Field label="Most">{(id) => <TextInput id={id} type="number" value={field.max ?? ''} onChange={(e) => set({ max: num(e.target.value) })} />}</Field>
        </div>
      ) : null}
      {(field.type === 'text' || field.type === 'email' || (field.type === 'number' && !field.rollup)) && !lineOwner(definition, entity) ? (
        <Checkbox label="No two records may share a value" checked={field.unique} onChange={(value) => set({ unique: value })} />
      ) : null}
      {field.type === 'choice' ? <ChoiceOptions options={field.options} multiple={field.multiple} onChange={set} /> : null}
      {field.type === 'file' ? (
        <div className="grid gap-1.5">
          <span className="text-sm text-muted">Takes</span>
          {(['image', 'pdf'] as const).map((kind) => (
            <Checkbox
              key={kind}
              label={kind === 'image' ? 'Images: photos and scans' : 'PDFs'}
              checked={field.accept.includes(kind)}
              disabled={field.accept.length === 1 && field.accept.includes(kind)}
              onChange={(on) => set({ accept: on ? [...field.accept, kind] : field.accept.filter((k) => k !== kind) })}
            />
          ))}
          <span className="text-xs text-faint">Every upload is checked for what it really is, and for malware.</span>
        </div>
      ) : null}
      {field.type === 'reference' ? (
        <>
          <Field label="Links to">
            {(id) => (
              <Select id={id} value={field.entity} onChange={(e) => set({ entity: e.target.value })}>
                {Object.entries(definition.entities)
                  .filter(([name]) => !lineOwner(definition, name))
                  .map(([name, e]) => (
                    <option key={name} value={name}>
                      {e.label}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Checkbox
            label={`Several ${definition.entities[field.entity]?.pluralLabel?.toLowerCase() ?? 'records'}, not one`}
            checked={field.multiple === true}
            onChange={(on) => set({ multiple: on || undefined })}
          />
          {field.multiple ? <span className="text-xs text-faint">Many to many: a page about one of them can list the records that hold it.</span> : null}
        </>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button size="sm" disabled={index === 0} onClick={() => props.onMove(index - 1)}>
          Move up
        </Button>
        <Button size="sm" disabled={index === fields.length - 1} onClick={() => props.onMove(index + 1)}>
          Move down
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="danger" onClick={props.onRemove}>
          Delete field
        </Button>
      </div>
    </Card>
  );
}

function ChoiceOptions({
  options,
  multiple,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  multiple: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const update = (next: Array<{ value: string; label: string }>) => onChange({ options: next });
  return (
    <div className="grid gap-2">
      <span className="text-sm text-muted">Options</span>
      {options.map((option, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <TextInput
            aria-label={`Option ${i + 1} label`}
            value={option.label}
            onChange={(e) => update(options.map((o, j) => (j === i ? { ...o, label: e.target.value } : o)))}
          />
          <TextInput
            aria-label={`Option ${i + 1} value`}
            className="mono"
            value={option.value}
            onChange={(e) => update(options.map((o, j) => (j === i ? { ...o, value: e.target.value } : o)))}
          />
          <Button size="sm" aria-label={`Remove option ${i + 1}`} disabled={options.length <= 1} onClick={() => update(options.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => update([...options, { value: `option_${options.length + 1}`, label: `Option ${options.length + 1}` }])}>
        Add option
      </Button>
      <Checkbox label="Several can be chosen" checked={multiple} onChange={(value) => onChange({ multiple: value })} />
    </div>
  );
}

type DateDefaultValue = Extract<FieldDef, { type: 'date' }>['default'];

/** What a date field starts as on a new record: nothing, the day it is created or some days from it, or a fixed date. */
function DateDefault({ value, onChange }: { value: DateDefaultValue; onChange: (value: DateDefaultValue) => void }) {
  const mode = value === undefined ? 'none' : typeof value === 'string' ? 'fixed' : value.today === 0 ? 'today' : 'days';
  return (
    <div className="grid gap-2">
      <Field label="Starts as">
        {(id) => (
          <Select
            id={id}
            value={mode}
            onChange={(e) => {
              const next = e.target.value;
              onChange(next === 'today' ? { today: 0 } : next === 'days' ? { today: 7 } : next === 'fixed' ? new Date().toISOString().slice(0, 10) : undefined);
            }}
          >
            <option value="none">Empty</option>
            <option value="today">The day the record is created</option>
            <option value="days">Some days from the day it is created</option>
            <option value="fixed">A fixed date</option>
          </Select>
        )}
      </Field>
      {value !== undefined && typeof value !== 'string' && mode === 'days' ? (
        <Field label="Days from then" hint="Before it, give a number below 0.">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              className="w-28"
              value={value.today}
              onChange={(e) => onChange({ today: Math.trunc(Number(e.target.value) || 0) })}
            />
          )}
        </Field>
      ) : null}
      {typeof value === 'string' ? (
        <Field label="The date">
          {(id) => <TextInput id={id} type="date" className="w-auto" value={value} onChange={(e) => onChange(e.target.value || undefined)} />}
        </Field>
      ) : null}
    </div>
  );
}

/** The kinds of field a formula can work out. */
const FORMULA_TYPES: readonly FieldType[] = ['text', 'number', 'boolean', 'date', 'datetime'];

/** A formula to start from: another of the app's fields of the same kind, else a fixed value. */
function startingFormula(definition: Definition, entity: string, field: FieldDef): unknown {
  const other = valueSources(definition, entity, field).find((source) => source.ref !== `record.${field.name}` && !SYSTEM_REFS.has(source.ref));
  if (other) return { ref: other.ref };
  return field.type === 'number' ? 0 : field.type === 'boolean' ? false : field.type === 'text' ? '' : null;
}
