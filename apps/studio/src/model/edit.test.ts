import { describe, expect, it } from 'vitest';
import {
  addEntity,
  addField,
  addForm,
  addSection,
  changeFieldType,
  emptyDefinition,
  moveField,
  placeField,
  removeField,
  removeSection,
  renameEntity,
  toName,
  unplaced,
  updateField,
} from './edit.js';

const start = () => {
  const { definition, name } = addEntity(emptyDefinition(), 'Expense claim');
  return { definition: addField(addField(definition, name, 'number').definition, name, 'choice').definition, entity: name };
};

describe('editing a draft', () => {
  it('makes names from labels, unique', () => {
    expect(toName('Hotel cost (SGD)')).toBe('hotel_cost_sgd');
    expect(toName('2nd line', ['field_2nd_line'])).toBe('field_2nd_line_2');
    expect(toName('Title', ['title', 'title_2'])).toBe('title_3');
  });

  it('adds entities and fields with sensible defaults, without touching the input', () => {
    const empty = emptyDefinition();
    const { definition, entity } = start();
    expect(empty.entities).toEqual({});
    expect(entity).toBe('expense_claim');
    expect(definition.entities[entity]!.fields.map((f) => [f.name, f.type])).toEqual([
      ['title', 'text'],
      ['new_number', 'number'],
      ['new_choice', 'choice'],
    ]);
  });

  it('renames fields everywhere the draft uses them, keeping their ID', () => {
    let { definition, entity } = start();
    definition.entities[entity]!.fields[1]!.id = 'abc123';
    definition = addForm(definition, entity).definition;
    definition = updateField(definition, entity, 1, { name: 'amount', label: 'Amount' });
    expect(definition.entities[entity]!.fields[1]).toMatchObject({ id: 'abc123', name: 'amount', label: 'Amount' });
    expect(definition.forms['expense_claim_form']!.sections[0]!.fields.map((f) => f.field)).toContain('amount');
    // An invalid or duplicate name is refused.
    expect(updateField(definition, entity, 1, { name: 'title' })).toBe(definition);
    expect(updateField(definition, entity, 1, { name: 'Bad Name' })).toBe(definition);
  });

  it('drops the old type\'s properties when the type changes', () => {
    const { definition, entity } = start();
    const changed = changeFieldType(definition, entity, 2, 'text');
    expect(changed.entities[entity]!.fields[2]).toEqual({ name: 'new_choice', label: 'New choice', required: false, classification: 'internal', type: 'text', maxLength: 1000, multiline: false, unique: false });
  });

  it('reorders and removes fields, and takes removed ones off forms', () => {
    let { definition, entity } = start();
    definition = addForm(definition, entity).definition;
    definition = moveField(definition, entity, 2, 0);
    expect(definition.entities[entity]!.fields.map((f) => f.name)).toEqual(['new_choice', 'title', 'new_number']);
    definition = removeField(definition, entity, 0);
    expect(definition.forms['expense_claim_form']!.sections[0]!.fields.map((f) => f.field)).toEqual(['title', 'new_number']);
  });

  it('renames entities, and the draft\'s forms and links follow', () => {
    let { definition, entity } = start();
    definition = addForm(definition, entity).definition;
    definition = renameEntity(definition, entity, 'claim');
    expect(Object.keys(definition.entities)).toEqual(['claim']);
    expect(definition.forms['expense_claim_form']!.entity).toBe('claim');
  });

  it('lays out forms: places fields across sections, and keeps at least one section', () => {
    let { definition, entity } = start();
    const { definition: withForm, name } = addForm(definition, entity);
    definition = addSection(withForm, name, 'Money');
    definition = placeField(definition, name, 'new_number', { section: 1, index: 0 });
    expect(definition.forms[name]!.sections.map((s) => s.fields.map((f) => f.field))).toEqual([['title', 'new_choice'], ['new_number']]);
    // Moving down within a section accounts for the field's own old place.
    definition = placeField(definition, name, 'title', { section: 0, index: 2 });
    expect(definition.forms[name]!.sections[0]!.fields.map((f) => f.field)).toEqual(['new_choice', 'title']);
    definition = removeSection(definition, name, 1);
    expect(unplaced(definition, name)).toEqual(['new_number']);
    expect(removeSection(definition, name, 0)).toBe(definition);
  });
});
