import type { Definition, Entity, Field, FieldType, Form, FormField } from '../types.js';

/**
 * Pure edits of a draft definition, for the designers. Each returns a new definition and leaves
 * the input untouched. Renames keep the entity's or field's stable ID, so the server carries them
 * through every reference when the draft is saved; the draft's own forms and links follow at once.
 */

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

export const FIELD_TYPES: ReadonlyArray<{ type: FieldType; label: string; hint: string }> = [
  { type: 'text', label: 'Text', hint: 'Words: a name, a title, a note' },
  { type: 'number', label: 'Number', hint: 'An amount or a count' },
  { type: 'choice', label: 'Choice', hint: 'One of a list, or several' },
  { type: 'date', label: 'Date', hint: 'A day' },
  { type: 'datetime', label: 'Date and time', hint: 'A moment' },
  { type: 'boolean', label: 'Yes or no', hint: 'A checkbox' },
  { type: 'email', label: 'Email', hint: 'An email address' },
  { type: 'user', label: 'Person', hint: 'Someone in your organization' },
  { type: 'reference', label: 'Link', hint: 'A record of another entity' },
  { type: 'lines', label: 'Lines', hint: 'A table in each record, such as one line per receipt' },
];

/** Where a line entity belongs: the entity and lines field whose lines it holds. */
export function lineOwner(definition: Definition, entity: string): { parent: string; field: string } | null {
  for (const [parent, e] of Object.entries(definition.entities)) {
    const field = e.fields.find((f) => f.type === 'lines' && f.entity === entity);
    if (field) return { parent, field: field.name };
  }
  return null;
}

/** A number field's rollup as a path, `sum:lines.amount`, or '' if people enter it. */
export function rollupKey(field: Field): string {
  if (field.type !== 'number' || !field.rollup) return '';
  const [op, path] = Object.entries(field.rollup)[0] as [string, string];
  return `${op}:${path}`;
}

/** The rollups a number field of an entity could be: a count of each lines field, and the sum, least and most of their numbers. */
export function rollupChoices(definition: Definition, entity: string): Array<{ key: string; label: string }> {
  return definition.entities[entity]!.fields.flatMap((lines) => {
    if (lines.type !== 'lines') return [];
    const numbers = definition.entities[lines.entity]?.fields.filter((f) => f.type === 'number') ?? [];
    return [
      { key: `count:${lines.name}`, label: `How many ${lines.label}` },
      ...numbers.flatMap((n) => [
        { key: `sum:${lines.name}.${n.name}`, label: `Sum of ${lines.label}: ${n.label}` },
        { key: `min:${lines.name}.${n.name}`, label: `Smallest of ${lines.label}: ${n.label}` },
        { key: `max:${lines.name}.${n.name}`, label: `Largest of ${lines.label}: ${n.label}` },
      ]),
    ];
  });
}

export function typeLabel(type: FieldType): string {
  return FIELD_TYPES.find((t) => t.type === type)?.label ?? type;
}

/** A name from a label: `Hotel cost` → `hotel_cost`, unique among `taken`. */
export function toName(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let base = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  if (!/^[a-z]/.test(base)) base = `field_${base}`.replace(/_+$/, '');
  if (!NAME.test(base)) base = 'field';
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  return name;
}

export const isName = (value: string) => NAME.test(value);

const clone = <T>(value: T): T => structuredClone(value);

function renameKey<T>(record: Readonly<Record<string, T>>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key === from ? to : key, value]));
}

export function emptyDefinition(): Definition {
  return { formatVersion: 1, entities: {}, rules: {}, actions: {}, queries: {}, cards: {}, forms: {}, roles: {} };
}

/** A definition with every section present, as the designers expect. */
export function normalize(definition: Partial<Definition>): Definition {
  return { ...emptyDefinition(), ...clone(definition) } as Definition;
}

export function addEntity(definition: Definition, label: string): { definition: Definition; name: string } {
  const name = toName(label, Object.keys(definition.entities));
  const next = clone(definition);
  next.entities[name] = { label, history: true, fields: [{ name: 'title', label: 'Title', type: 'text', required: true, classification: 'internal', maxLength: 200, multiline: false, unique: false }], titleField: 'title' } as Entity;
  return { definition: next, name };
}

export function renameEntity(definition: Definition, from: string, to: string): Definition {
  if (from === to || !isName(to) || definition.entities[to]) return definition;
  const next = clone(definition);
  next.entities = renameKey(next.entities, from, to);
  for (const entity of Object.values(next.entities)) {
    for (const field of entity.fields) if ((field.type === 'reference' || field.type === 'lines') && field.entity === from) field.entity = to;
  }
  for (const form of Object.values(next.forms)) if (form.entity === from) form.entity = to;
  return next;
}

export function updateEntity(definition: Definition, name: string, patch: Partial<Pick<Entity, 'label' | 'pluralLabel' | 'description' | 'titleField' | 'history'>>): Definition {
  const next = clone(definition);
  const entity = next.entities[name]!;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete (entity as Record<string, unknown>)[key];
    else (entity as Record<string, unknown>)[key] = value;
  }
  return next;
}

/**
 * Remove an entity, and the forms that lay it out. Its lines go with it; if it is itself lines, so
 * does the lines field that holds them. Other references are reported when the draft is checked.
 */
export function removeEntity(definition: Definition, name: string): Definition {
  let next = clone(definition);
  const owner = lineOwner(next, name);
  if (owner) next = removeField(next, owner.parent, next.entities[owner.parent]!.fields.findIndex((f) => f.name === owner.field), false);
  for (const field of next.entities[name]?.fields ?? []) if (field.type === 'lines') delete next.entities[field.entity];
  delete next.entities[name];
  for (const [formName, form] of Object.entries(next.forms)) if (form.entity === name) delete next.forms[formName];
  return next;
}

/** A new entity for the lines of a lines field, with one field to start from. */
function addLineEntity(definition: Definition, parent: string): string {
  const name = toName(`${parent}_line`, Object.keys(definition.entities));
  const label = `${definition.entities[parent]!.label} line`;
  definition.entities[name] = {
    label,
    history: true,
    fields: [{ name: 'description', label: 'Description', type: 'text', required: true, classification: 'internal', maxLength: 200, multiline: false, unique: false }],
    titleField: 'description',
  } as Entity;
  return name;
}

function fieldOfType(base: Pick<Field, 'name' | 'label'> & Partial<Field>, type: FieldType, definition: Definition, entity: string): Field {
  const common = {
    ...(base.id ? { id: base.id } : {}),
    name: base.name,
    label: base.label,
    ...(base.description ? { description: base.description } : {}),
    required: base.required ?? false,
    classification: base.classification ?? 'internal',
  };
  switch (type) {
    case 'text':
      return { ...common, type, maxLength: 1000, multiline: false, unique: false };
    case 'email':
      return { ...common, type, unique: false };
    case 'number':
      return { ...common, type, decimals: 0, unique: false };
    case 'choice':
      return { ...common, type, multiple: false, options: [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }] };
    case 'reference': {
      const target = Object.keys(definition.entities).find((name) => name !== entity && !lineOwner(definition, name)) ?? entity;
      return { ...common, type, entity: target };
    }
    case 'lines':
      return { ...common, classification: 'internal', type, entity: base.type === 'lines' && base.entity ? base.entity : '', max: 100 };
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'user':
      return { ...common, type };
  }
}

export function addField(definition: Definition, entity: string, type: FieldType = 'text'): { definition: Definition; index: number } {
  const next = clone(definition);
  const fields = next.entities[entity]!.fields;
  const label = `New ${typeLabel(type).toLowerCase()}`;
  const name = toName(label, fields.map((f) => f.name));
  const field = fieldOfType({ name, label }, type, next, entity);
  // Lines need an entity of their own: one is made for them, to design next.
  if (field.type === 'lines') field.entity = addLineEntity(next, entity);
  fields.push(field);
  return { definition: next, index: fields.length - 1 };
}

/** Change a field's properties. A new name is a rename: the field keeps its ID, and its data. */
export function updateField(definition: Definition, entity: string, index: number, patch: Record<string, unknown>): Definition {
  const next = clone(definition);
  const fields = next.entities[entity]!.fields;
  const before = fields[index]!;
  const name = typeof patch['name'] === 'string' ? patch['name'] : before.name;
  if (name !== before.name && (!isName(name) || fields.some((f, i) => i !== index && f.name === name))) return definition;
  const updated = { ...before, ...patch } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete updated[key];
  fields[index] = updated as Field;
  if (name !== before.name) {
    for (const form of Object.values(next.forms)) {
      if (form.entity !== entity) continue;
      for (const section of form.sections) for (const item of section.fields) if (item.field === before.name) item.field = name;
    }
    const entityDef = next.entities[entity]!;
    if (entityDef.titleField === before.name) entityDef.titleField = name;
    // Rollups name lines fields, and the fields of their lines: they follow the rename too.
    const owner = lineOwner(next, entity);
    const renamePath = (path: string, lines: string) => {
      const [head, tail] = path.split('.');
      if (!owner && head === before.name) return tail ? `${name}.${tail}` : name;
      if (owner && head === lines && tail === before.name) return `${head}.${name}`;
      return path;
    };
    const parent = owner ? next.entities[owner.parent]! : entityDef;
    for (const f of parent.fields) {
      if (f.type !== 'number' || !f.rollup) continue;
      const [op, path] = Object.entries(f.rollup)[0] as [string, string];
      f.rollup = { [op]: renamePath(path, owner?.field ?? '') } as typeof f.rollup;
    }
  }
  return next;
}

/** Make a number field worked out from lines (`sum:lines.amount`), or entered by people again (''). */
export function setRollup(definition: Definition, entity: string, index: number, key: string): Definition {
  const next = clone(definition);
  const field = next.entities[entity]!.fields[index]!;
  if (field.type !== 'number') return definition;
  if (!key) delete field.rollup;
  else {
    const [op, path] = key.split(':') as [string, string];
    field.rollup = { [op]: path } as typeof field.rollup;
    field.required = false;
    field.unique = false;
    delete field.default;
    // A sum needs the decimals of what it adds up.
    const [lines, sub] = path.split('.');
    const linesField = next.entities[entity]!.fields.find((f) => f.name === lines);
    const source = linesField?.type === 'lines' ? next.entities[linesField.entity]?.fields.find((f) => f.name === sub) : undefined;
    if (source?.type === 'number' && op !== 'count') field.decimals = Math.max(field.decimals, source.decimals);
    if (op === 'count') field.decimals = 0;
  }
  // A worked-out field is shown, never filled in.
  for (const form of Object.values(next.forms)) {
    if (form.entity !== entity) continue;
    for (const section of form.sections) for (const item of section.fields) if (item.field === field.name && key) item.readOnly = true;
  }
  return next;
}

/** Change a field's type. Properties that belong to the old type are dropped, and so are the lines of a lines field. */
export function changeFieldType(definition: Definition, entity: string, index: number, type: FieldType): Definition {
  const next = clone(definition);
  const fields = next.entities[entity]!.fields;
  const before = fields[index]!;
  if (before.type === type) return definition;
  if (before.type === 'lines') delete next.entities[before.entity];
  const field = fieldOfType(before, type, next, entity);
  if (field.type === 'lines') field.entity = addLineEntity(next, entity);
  fields[index] = field;
  return next;
}

export function moveField(definition: Definition, entity: string, from: number, to: number): Definition {
  if (from === to) return definition;
  const next = clone(definition);
  const fields = next.entities[entity]!.fields;
  const [moved] = fields.splice(from, 1);
  fields.splice(Math.max(0, Math.min(to, fields.length)), 0, moved!);
  return next;
}

/** Remove a field, and take it off the entity's forms. A lines field takes its lines with it. */
export function removeField(definition: Definition, entity: string, index: number, withLines = true): Definition {
  const next = clone(definition);
  const entityDef = next.entities[entity]!;
  const [removed] = entityDef.fields.splice(index, 1);
  if (withLines && removed?.type === 'lines') delete next.entities[removed.entity];
  if (entityDef.titleField === removed!.name) delete entityDef.titleField;
  for (const form of Object.values(next.forms)) {
    if (form.entity !== entity) continue;
    for (const section of form.sections) section.fields = section.fields.filter((item) => item.field !== removed!.name);
  }
  return next;
}

// Forms

export interface Slot {
  readonly section: number;
  readonly index: number;
}

/** A form with every field a person can fill in, in one section. */
export function addForm(definition: Definition, entity: string): { definition: Definition; name: string } {
  const next = clone(definition);
  const entityDef = next.entities[entity]!;
  const name = toName(`${entity}_form`, Object.keys(next.forms));
  next.forms[name] = {
    label: entityDef.label,
    entity,
    sections: [{ fields: entityDef.fields.map((field) => ({ field: field.name, width: 'full', readOnly: Boolean(field.type === 'number' && field.rollup) })) }],
  } as Form;
  return { definition: next, name };
}

export function updateForm(definition: Definition, form: string, patch: Partial<Pick<Form, 'label' | 'action'>>): Definition {
  const next = clone(definition);
  const target = next.forms[form]! as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete target[key];
    else target[key] = value;
  }
  return next;
}

export function removeForm(definition: Definition, form: string): Definition {
  const next = clone(definition);
  delete next.forms[form];
  return next;
}

export function addSection(definition: Definition, form: string, title = 'New section'): Definition {
  const next = clone(definition);
  next.forms[form]!.sections.push({ title, fields: [] });
  return next;
}

export function updateSection(definition: Definition, form: string, section: number, title: string): Definition {
  const next = clone(definition);
  const target = next.forms[form]!.sections[section]!;
  if (title.trim()) target.title = title;
  else delete target.title;
  return next;
}

/** Remove a section. Its fields go back to the palette. A form keeps at least one section. */
export function removeSection(definition: Definition, form: string, section: number): Definition {
  const sections = definition.forms[form]!.sections;
  if (sections.length <= 1) return definition;
  const next = clone(definition);
  next.forms[form]!.sections.splice(section, 1);
  return next;
}

/** The fields of the form's entity that aren't on the form yet. */
export function unplaced(definition: Definition, form: string): string[] {
  const target = definition.forms[form]!;
  const placed = new Set(target.sections.flatMap((section) => section.fields.map((item) => item.field)));
  return definition.entities[target.entity]?.fields.map((field) => field.name).filter((name) => !placed.has(name)) ?? [];
}

/** Put a field at a slot, taking it from wherever it was. */
export function placeField(definition: Definition, form: string, field: string, at: Slot): Definition {
  const next = clone(definition);
  const sections = next.forms[form]!.sections;
  const declared = next.entities[next.forms[form]!.entity]?.fields.find((f) => f.name === field);
  let item: FormField = { field, width: 'full', readOnly: Boolean(declared?.type === 'number' && declared.rollup) };
  let target = { ...at };
  sections.forEach((section, s) => {
    const index = section.fields.findIndex((f) => f.field === field);
    if (index === -1) return;
    item = section.fields.splice(index, 1)[0]!;
    if (s === at.section && index < at.index) target = { section: s, index: at.index - 1 };
  });
  const fields = sections[target.section]!.fields;
  fields.splice(Math.max(0, Math.min(target.index, fields.length)), 0, item);
  return next;
}

export function removeFormField(definition: Definition, form: string, at: Slot): Definition {
  const next = clone(definition);
  next.forms[form]!.sections[at.section]!.fields.splice(at.index, 1);
  return next;
}

export function updateFormField(definition: Definition, form: string, at: Slot, patch: Partial<FormField>): Definition {
  const next = clone(definition);
  const fields = next.forms[form]!.sections[at.section]!.fields;
  const updated = { ...fields[at.index]!, ...patch } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (value === undefined || value === '') delete updated[key];
  fields[at.index] = updated as FormField;
  return next;
}
