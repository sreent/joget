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
  lineOwner,
  removeEntity,
  removeField,
  removeSection,
  renameEntity,
  rollupChoices,
  setRollup,
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

  it('makes an entity for new lines, and takes it away with them', () => {
    const { definition, entity } = start();
    const { definition: withLines, index } = addField(definition, entity, 'lines');
    const lines = withLines.entities[entity]!.fields[index]!;
    expect(lines).toMatchObject({ type: 'lines', entity: 'expense_claim_line', max: 100 });
    expect(withLines.entities['expense_claim_line']!.fields.map((f) => f.name)).toEqual(['description']);
    expect(lineOwner(withLines, 'expense_claim_line')).toEqual({ parent: entity, field: lines.name });
    expect(removeField(withLines, entity, index).entities).not.toHaveProperty('expense_claim_line');
    expect(changeFieldType(withLines, entity, index, 'text').entities).not.toHaveProperty('expense_claim_line');
    // Deleting the lines' entity takes its lines field off the parent too, and deleting the parent takes the lines.
    expect(removeEntity(withLines, 'expense_claim_line').entities[entity]!.fields.map((f) => f.type)).not.toContain('lines');
    expect(Object.keys(removeEntity(withLines, entity).entities)).toEqual([]);
  });

  it('works a number out from lines, and keeps the rollup when lines are renamed', () => {
    const { definition, entity } = start();
    let { definition: d, index } = addField(definition, entity, 'lines');
    d = addField(d, 'expense_claim_line', 'number').definition;
    d = updateField(d, 'expense_claim_line', 1, { name: 'amount', label: 'Amount', decimals: 2 });
    expect(rollupChoices(d, entity).map((c) => c.key)).toEqual(['count:new_lines', 'sum:new_lines.amount', 'min:new_lines.amount', 'max:new_lines.amount']);
    d = addForm(d, entity).definition;
    d = setRollup(d, entity, 1, 'sum:new_lines.amount');
    expect(d.entities[entity]!.fields[1]).toMatchObject({ rollup: { sum: 'new_lines.amount' }, decimals: 2, required: false });
    expect(d.forms['expense_claim_form']!.sections[0]!.fields[1]).toMatchObject({ field: 'new_number', readOnly: true });
    d = updateField(d, entity, index, { name: 'receipts' });
    d = updateField(d, 'expense_claim_line', 1, { name: 'value' });
    expect(d.entities[entity]!.fields[1]).toMatchObject({ rollup: { sum: 'receipts.value' } });
    expect(setRollup(d, entity, 1, '').entities[entity]!.fields[1]).not.toHaveProperty('rollup');
  });
});
