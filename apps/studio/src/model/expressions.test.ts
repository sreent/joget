import { EXPENSE_APP } from '@platform/app-model';
import { describe, expect, it } from 'vitest';
import type { Definition } from '../types.js';
import { normalize } from './edit.js';
import { betweenOf, calc, calcOf, chooseOf, describeExpression, firstFilledOf, joinOf, shift, shiftOf, textFn, textFnOf, valueSources } from './expressions.js';

const app = () => normalize(structuredClone(EXPENSE_APP) as unknown as Definition);

describe('values that logic works out', () => {
  it('offers the fields that hold the same kind of value', () => {
    const definition = app();
    const fields = definition.entities['expense_claim']!.fields;
    const of = (name: string) =>
      valueSources(
        definition,
        'expense_claim',
        fields.find((f) => f.name === name),
      ).map((source) => source.ref);
    expect(of('approver')).toEqual(['record.approver', 'record.owner', 'record.created_by', 'record.updated_by']);
    expect(of('trip')).toEqual(['record.title', 'record.trip', 'record.status', 'record.iban']);
    expect(valueSources(definition, 'expense_claim', 'number').map((source) => source.ref)).toEqual(['record.total']);
    expect(valueSources(definition, 'expense_claim').map((source) => source.ref)).toContain('record.id');
  });

  it('reads calculations and joined text the editor can show, and nothing deeper', () => {
    expect(calcOf(calc('mul', { ref: 'record.total' }, 0.09))).toEqual({ op: 'mul', a: { ref: 'record.total' }, b: 0.09 });
    expect(calcOf({ add: [1, 2, 3] })).toBeUndefined();
    expect(calcOf({ round: [{ ref: 'record.total' }, 2] })).toBeUndefined();
    expect(joinOf({ concat: ['Per diem: ', { ref: 'record.trip' }] })).toEqual(['Per diem: ', { ref: 'record.trip' }]);
    expect(joinOf({ concat: ['x', { today: true }] })).toBeUndefined();
  });
  it('shows date maths, a choice by a condition and text functions in its own inputs, and in words', () => {
    const definition = app();
    const due = shift('add_days', { ref: 'record.date' }, 14);
    expect(shiftOf(due)).toEqual({ op: 'add_days', from: { ref: 'record.date' }, by: 14 });
    expect(describeExpression(definition, 'expense_line', due)).toBe('Date + 14 days');
    expect(betweenOf({ days_between: [{ today: true }, { ref: 'record.date' }] })).toEqual({ from: { today: true }, to: { ref: 'record.date' } });
    const choice = { if: [{ gt: [{ ref: 'record.total' }, 1000] }, 'big', 'small'] } as const;
    expect(chooseOf(choice)).toEqual({ when: { gt: [{ ref: 'record.total' }, 1000] }, then: 'big', otherwise: 'small' });
    expect(describeExpression(definition, 'expense_claim', choice)).toBe('“big” if Total (SGD) is more than 1000, else “small”');
    expect(textFnOf(textFn('left', { ref: 'record.title' }, 3))).toEqual({ fn: 'left', of: { ref: 'record.title' }, count: 3 });
    expect(textFnOf({ upper: [{ ref: 'record.title' }] })).toMatchObject({ fn: 'upper' });
    expect(firstFilledOf({ coalesce: [{ ref: 'record.title' }, 'Untitled'] })).toEqual([{ ref: 'record.title' }, 'Untitled']);
    // A shape the inputs can't show stays a formula.
    expect(shiftOf({ add_days: [{ add: [1, 2] }, 1] })).toBeUndefined();
    expect(valueSources(definition, 'expense_line', 'date').map((source) => source.ref)).toContain('record.date');
  });
});
