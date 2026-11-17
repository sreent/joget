import { describe, expect, it } from 'vitest';
import { EXPENSE_APP, LEAVE_APP } from '@platform/app-model';
import type { Definition } from '../types.js';
import { BOX_W, fieldNote, fieldTag, layoutModel, rowY } from './datamodel.js';
import { normalize } from './edit.js';

const app = (input: unknown): Definition => normalize(structuredClone(input) as Definition);

describe('the data model canvas', () => {
  it('draws each entity as a box, and its lines to the right, with an arrow from the field', () => {
    const definition = app(EXPENSE_APP);
    const { boxes, arrows } = layoutModel(definition);
    const at = (entity: string) => boxes.find((box) => box.entity === entity)!;
    expect(at('expense_line').x).toBeGreaterThan(at('expense_claim').x + BOX_W);
    expect(arrows).toEqual([expect.objectContaining({ from: { entity: 'expense_claim', field: 'lines' }, to: 'expense_line', kind: 'lines', label: expect.objectContaining({ text: 'its lines' }) })]);
    // The arrow leaves from the row of its field.
    const lines = definition.entities['expense_claim']!.fields.findIndex((field) => field.name === 'lines');
    expect(arrows[0]!.d.startsWith(`M${at('expense_claim').x + BOX_W} ${rowY(at('expense_claim'), lines)}`)).toBe(true);
  });

  it('says what each field is, briefly', () => {
    const fields = app(EXPENSE_APP).entities['expense_claim']!.fields;
    const named = (name: string) => fields.find((field) => field.name === name)!;
    expect(fieldTag(named('title'))).toEqual({ text: 'Aa' });
    expect(fieldTag(named('lines'))).toEqual({ icon: 'list' });
    expect(fieldNote(app(EXPENSE_APP), named('total'))).toBe('worked out');
    const leave = app(LEAVE_APP);
    expect(fieldNote(leave, leave.entities['leave_request']!.fields.find((field) => field.name === 'kind')!)).toBe('3 choices');
    // An entity on its own stands in the first column.
    expect(layoutModel(leave).boxes).toEqual([expect.objectContaining({ entity: 'leave_request', x: 24, y: 24 })]);
  });
});
