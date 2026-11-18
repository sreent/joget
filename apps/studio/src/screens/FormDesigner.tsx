import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { ConditionEditor } from '../components/condition.js';
import { Badge, Button, Card, Checkbox, cx, EmptyState, Field, Select, TextInput } from '../components/ui.js';
import { recordChoices } from '../model/conditions.js';
import {
  addForm,
  addSection,
  placeField,
  removeForm,
  removeFormField,
  removeSection,
  typeLabel,
  unplaced,
  updateForm,
  updateFormField,
  updateSection,
  type Slot,
} from '../model/edit.js';
import { isWorkedOut, type Definition, type FormField } from '../types.js';

type Props = { definition: Definition; onChange: (definition: Definition) => void };

const itemId = (field: string) => `form:${field}`;
const paletteId = (field: string) => `palette:${field}`;
const sectionId = (index: number) => `section:${index}`;

/** Forms: drag an entity's fields into sections, set their width, and choose the action a form submits through. */
export function FormDesigner({ definition, onChange }: Props) {
  const forms = Object.keys(definition.forms);
  const entities = Object.keys(definition.entities);
  const [selected, setSelected] = useState<string | null>(forms[0] ?? null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [entityForNew, setEntityForNew] = useState(entities[0] ?? '');
  const formName = selected && definition.forms[selected] ? selected : (forms[0] ?? null);

  return (
    <div className="grid gap-4 @min-[62rem]:grid-cols-[15rem_minmax(0,1fr)_19rem]">
      <Card className="grid content-start gap-3 p-4">
        <h2 className="m-0 text-sm font-semibold text-muted">Forms</h2>
        <ul className="m-0 grid list-none gap-1 p-0">
          {forms.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => {
                  setSelected(name);
                  setSlot(null);
                }}
                aria-current={name === formName ? 'true' : undefined}
                className={cx('w-full rounded-md px-2.5 py-1.5 text-left', name === formName ? 'bg-accent-soft' : 'hover:bg-sunken')}
              >
                <span className="block font-medium">{definition.forms[name]!.label}</span>
                <span className="text-xs text-faint">{definition.entities[definition.forms[name]!.entity]?.label ?? definition.forms[name]!.entity}</span>
              </button>
            </li>
          ))}
        </ul>
        {entities.length ? (
          <div className="grid gap-2">
            <Select aria-label="Entity for the new form" value={entityForNew} onChange={(e) => setEntityForNew(e.target.value)}>
              {entities.map((name) => (
                <option key={name} value={name}>
                  {definition.entities[name]!.label}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              onClick={() => {
                const result = addForm(definition, entityForNew || entities[0]!);
                onChange(result.definition);
                setSelected(result.name);
                setSlot(null);
              }}
            >
              New form
            </Button>
          </div>
        ) : (
          <p className="m-0 text-sm text-muted">Add an entity on the Data tab first.</p>
        )}
      </Card>

      {formName ? (
        <FormCanvas definition={definition} name={formName} slot={slot} onSlot={setSlot} onChange={onChange} onRemove={() => (onChange(removeForm(definition, formName)), setSelected(null))} />
      ) : (
        <EmptyState title="No forms yet">A form lays out an entity's fields for people who work in screens. Agents don't need one.</EmptyState>
      )}

      {formName ? <FormSide definition={definition} name={formName} slot={slot} onSlot={setSlot} onChange={onChange} /> : <div />}
    </div>
  );
}

function FormCanvas(props: { definition: Definition; name: string; slot: Slot | null; onSlot: (slot: Slot | null) => void; onChange: (d: Definition) => void; onRemove: () => void }) {
  const { definition, name, onChange } = props;
  const form = definition.forms[name]!;
  const entity = definition.entities[form.entity];
  const actions = Object.entries(definition.actions).filter(([, action]) => action.entity === form.entity);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [dragging, setDragging] = useState<string | null>(null);
  const label = (field: string) => entity?.fields.find((f) => f.name === field)?.label ?? field;

  const where = (field: string): Slot | null => {
    for (const [s, section] of form.sections.entries()) {
      const index = section.fields.findIndex((item) => item.field === field);
      if (index !== -1) return { section: s, index };
    }
    return null;
  };
  const onDragStart = ({ active }: DragStartEvent) => setDragging(String(active.id).split(':')[1] ?? null);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const field = String(active.id).split(':')[1]!;
    const [kind, target] = String(over.id).split(':') as [string, string];
    const slot = kind === 'section' ? { section: Number(target), index: form.sections[Number(target)]!.fields.length } : where(target);
    if (!slot) return;
    onChange(placeField(definition, name, field, slot));
    props.onSlot(where(field) ? slot : null);
  };

  return (
    <Card className="grid content-start gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">{(id) => <TextInput id={id} value={form.label} onChange={(e) => onChange(updateForm(definition, name, { label: e.target.value }))} />}</Field>
        <Field label="Submits through" hint="An action's rules and confirmation apply. Without one, the form creates and edits records.">
          {(id) => (
            <Select id={id} value={form.action ?? ''} onChange={(e) => onChange(updateForm(definition, name, { action: e.target.value || undefined }))}>
              <option value="">(no action: create and edit records)</option>
              {actions.map(([actionName, action]) => (
                <option key={actionName} value={actionName}>
                  {action.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Shows" hint={form.sections.length > 1 ? 'In steps, each section is a step, checked before the next.' : 'Add a section to show the form in steps.'}>
          {(id) => (
            <Select id={id} value={form.layout ?? 'page'} onChange={(e) => onChange(updateForm(definition, name, { layout: e.target.value === 'steps' ? 'steps' : 'page' }))}>
              <option value="page">All on one page</option>
              <option value="steps" disabled={form.sections.length < 2}>
                In steps, a section at a time
              </option>
            </Select>
          )}
        </Field>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="grid gap-4">
          {form.sections.map((section, s) => (
            <SectionBox
              key={s}
              index={s}
              title={section.title ?? ''}
              fields={section.fields}
              label={label}
              isLines={(field) => definition.entities[form.entity]?.fields.find((f) => f.name === field)?.type === 'lines'}
              selected={props.slot?.section === s ? props.slot.index : null}
              onSelect={(index) => props.onSlot({ section: s, index })}
              onTitle={(title) => onChange(updateSection(definition, name, s, title))}
              onRemove={form.sections.length > 1 ? () => (onChange(removeSection(definition, name, s)), props.onSlot(null)) : undefined}
            />
          ))}
        </div>
        <Palette fields={unplaced(definition, name)} label={label} onAdd={(field) => onChange(placeField(definition, name, field, { section: form.sections.length - 1, index: Number.MAX_SAFE_INTEGER }))} />
        <DragOverlay>{dragging ? <div className="rounded-md border border-accent bg-surface px-3 py-2 shadow-raised">{label(dragging)}</div> : null}</DragOverlay>
      </DndContext>
      <div className="flex gap-2 border-t border-line pt-3">
        <Button size="sm" onClick={() => onChange(addSection(definition, name))}>
          Add section
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="danger" onClick={props.onRemove}>
          Delete form
        </Button>
      </div>
    </Card>
  );
}

function SectionBox(props: {
  index: number;
  title: string;
  fields: FormField[];
  label: (field: string) => string;
  isLines: (field: string) => boolean;
  selected: number | null;
  onSelect: (index: number) => void;
  onTitle: (title: string) => void;
  onRemove: (() => void) | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: sectionId(props.index) });
  return (
    <section ref={setNodeRef} className={cx('grid gap-3 rounded-md border border-dashed p-3', isOver ? 'border-accent bg-accent-soft/40' : 'border-line-strong')}>
      <div className="flex items-center gap-2">
        <TextInput aria-label={`Section ${props.index + 1} title`} placeholder="Untitled section" value={props.title} onChange={(e) => props.onTitle(e.target.value)} className="font-semibold" />
        {props.onRemove ? (
          <Button size="sm" variant="ghost" onClick={props.onRemove} aria-label={`Remove section ${props.index + 1}`}>
            Remove
          </Button>
        ) : null}
      </div>
      <SortableContext items={props.fields.map((f) => itemId(f.field))} strategy={rectSortingStrategy}>
        <div className="grid min-h-12 grid-cols-2 gap-2">
          {props.fields.map((item, index) => (
            <FormItem key={item.field} item={item} label={item.label ?? props.label(item.field)} isLines={props.isLines(item.field)} selected={props.selected === index} onSelect={() => props.onSelect(index)} />
          ))}
          {props.fields.length === 0 ? <p className="col-span-2 m-0 self-center text-center text-sm text-faint">Drag fields here</p> : null}
        </div>
      </SortableContext>
    </section>
  );
}

function FormItem({ item, label, isLines, selected, onSelect }: { item: FormField; label: string; isLines: boolean; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: itemId(item.field) });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('flex items-center gap-2 rounded-md border bg-surface px-2 py-2', item.width === 'full' || isLines ? 'col-span-2' : 'col-span-1', selected ? 'border-accent' : 'border-line', isDragging && 'opacity-40')}
    >
      <button type="button" aria-label={`Move ${label}`} className="cursor-grab rounded px-1 text-faint hover:text-text" {...attributes} {...listeners}>
        ⠿
      </button>
      <button type="button" className="flex flex-1 items-center gap-2 text-left" onClick={onSelect}>
        <span className="font-medium">{label}</span>
        {isLines ? <Badge>table of lines</Badge> : null}
        {item.readOnly ? <Badge>read-only</Badge> : null}
      </button>
    </div>
  );
}

function Palette({ fields, label, onAdd }: { fields: string[]; label: (field: string) => string; onAdd: (field: string) => void }) {
  return (
    <div className="grid gap-2">
      <h3 className="m-0 text-sm font-semibold text-muted">Not on the form</h3>
      {fields.length === 0 ? <p className="m-0 text-sm text-faint">Every field is on the form.</p> : null}
      <div className="flex flex-wrap gap-2">
        {fields.map((field) => (
          <PaletteItem key={field} field={field} label={label(field)} onAdd={() => onAdd(field)} />
        ))}
      </div>
    </div>
  );
}

function PaletteItem({ field, label, onAdd }: { field: string; label: string; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: paletteId(field) });
  return (
    <div ref={setNodeRef} className={cx('flex items-center gap-1 rounded-full border border-line-strong bg-sunken py-0.5 pr-1 pl-3 text-sm', isDragging && 'opacity-40')}>
      <span className="cursor-grab" {...attributes} {...listeners}>
        {label}
      </span>
      <Button size="sm" variant="ghost" aria-label={`Add ${label} to the form`} onClick={onAdd}>
        +
      </Button>
    </div>
  );
}

function FormSide({ definition, name, slot, onSlot, onChange }: { definition: Definition; name: string; slot: Slot | null; onSlot: (s: Slot | null) => void; onChange: (d: Definition) => void }) {
  const form = definition.forms[name]!;
  const item = slot ? form.sections[slot.section]?.fields[slot.index] : undefined;
  if (!slot || !item) return <Card className="text-sm text-muted">Select a field on the form to change how it shows.</Card>;
  const field = definition.entities[form.entity]?.fields.find((f) => f.name === item.field);
  const set = (patch: Partial<FormField>) => onChange(updateFormField(definition, name, slot, patch));
  return (
    <Card className="grid content-start gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold text-muted">On this form</h2>
        {field ? <Badge>{typeLabel(field.type)}</Badge> : null}
      </div>
      <Field label="Label" hint={`The field's own label is "${field?.label ?? item.field}".`}>
        {(id) => <TextInput id={id} value={item.label ?? ''} placeholder={field?.label} onChange={(e) => set({ label: e.target.value || undefined })} />}
      </Field>
      <Field label="Help text">{(id) => <TextInput id={id} value={item.help ?? ''} onChange={(e) => set({ help: e.target.value || undefined })} />}</Field>
      {field?.type === 'lines' ? (
        <p className="m-0 text-sm text-muted">Lines show as a table, across the whole form.</p>
      ) : (
        <Field label="Width">
          {(id) => (
            <Select id={id} value={item.width} onChange={(e) => set({ width: e.target.value as 'full' | 'half' })}>
              <option value="full">Full width</option>
              <option value="half">Half width</option>
            </Select>
          )}
        </Field>
      )}
      {field && isWorkedOut(field) ? (
        <p className="m-0 text-sm text-muted">{field.type === 'number' && field.rollup ? 'Worked out from lines' : 'Worked out by a formula'}, so it's shown, never filled in.</p>
      ) : (
        <Checkbox label="Read-only on this form" checked={item.readOnly} onChange={(value) => set({ readOnly: value })} />
      )}
      <ConditionEditor
        label="Shows when"
        value={item.visibleWhen}
        onChange={(visibleWhen) => set({ visibleWhen })}
        choices={recordChoices(definition, form.entity).filter((choice) => choice.ref !== `record.${item.field}`)}
        empty="Always. A field it hides sends no value."
      />
      <div className="border-t border-line pt-3">
        <Button size="sm" variant="danger" onClick={() => (onChange(removeFormField(definition, name, slot)), onSlot(null))}>
          Take off the form
        </Button>
      </div>
    </Card>
  );
}
