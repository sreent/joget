import { describe, expect, it } from 'vitest';
import { EXPENSE_APP } from '@platform/app-model';
import type { Definition } from '../types.js';
import { normalize, removeField } from './edit.js';
import { addStep, calc, calcOf, describeStep, joinOf, moveStep, newStep, removeStep, stepAt, updateStep, valueSources, type Step } from './steps.js';

const app = () => normalize(structuredClone(EXPENSE_APP) as unknown as Definition);
const steps = (definition: Definition, action = 'approve_claim') => (definition.actions[action]!.steps ?? []) as Step[];

describe('editing steps', () => {
  it('describes each step of the example in words', () => {
    const definition = app();
    expect(steps(definition).map((step) => describeStep(definition, 'expense_claim', step))).toEqual([
      "Stop unless Owner is not the person running it: You can't approve your own claim",
      'Set Approver to the person running it',
      'Warn unless Total (SGD) is at most 1000: A claim over SGD 1,000: check that a director agreed to it',
    ]);
    // A step that starts an a7c skill, where an installation connects a7c.
    expect(describeStep(definition, 'expense_claim', { type: 'skill', label: 'Pay the claim', skill: 'finance/pay-expense-claim', input: {} })).toBe('Pay the claim (a7c: finance/pay-expense-claim)');
  });

  it('adds steps with defaults that pass the checks, at the end or inside a branch', () => {
    let { definition, place } = addStep(app(), 'submit_claim', 'add_line');
    expect(place).toEqual({ index: 0 });
    expect(steps(definition, 'submit_claim')[0]).toEqual({
      type: 'add_line',
      field: 'lines',
      values: { date: { today: true }, merchant: '', category: 'travel', amount: 0 },
    });
    ({ definition, place } = addStep(definition, 'approve_claim', 'if'));
    expect(place).toEqual({ index: 3 });
    expect(stepAt(definition, 'approve_claim', place!)).toMatchObject({ type: 'if', then: [{ type: 'check', severity: 'warning' }], else: [] });
    ({ definition, place } = addStep(definition, 'approve_claim', 'set', { index: 3, side: 'else' }));
    expect(place).toEqual({ index: 3, side: 'else', inner: 0 });
    expect(stepAt(definition, 'approve_claim', place!)).toEqual({ type: 'set', field: 'title', value: '' });
    // A branch holds simple steps only: no branch inside a branch.
    expect(addStep(definition, 'approve_claim', 'if', { index: 3, side: 'then' }).place).toBeUndefined();
    expect(newStep(definition, 'expense_line', 'add_line')).toBeUndefined();
  });

  it('changes, moves and removes steps, in a branch too, and drops the list when it empties', () => {
    let definition = addStep(app(), 'approve_claim', 'if').definition;
    definition = updateStep(definition, 'approve_claim', { index: 3, side: 'then', inner: 0 }, { type: 'set', field: 'trip', value: 'Checked' });
    expect(steps(definition)[3]).toMatchObject({ type: 'if', then: [{ type: 'set', field: 'trip' }] });
    definition = moveStep(definition, 'approve_claim', { index: 3 }, -1);
    expect(steps(definition).map((step) => step.type)).toEqual(['check', 'set', 'if', 'check']);
    expect(moveStep(definition, 'approve_claim', { index: 0 }, -1)).toBe(definition);
    definition = removeStep(definition, 'approve_claim', { index: 2, side: 'then', inner: 0 });
    expect(steps(definition)[2]).toMatchObject({ type: 'if', then: [] });
    for (let i = 0; i < 4; i++) definition = removeStep(definition, 'approve_claim', { index: 0 });
    expect(definition.actions['approve_claim']).not.toHaveProperty('steps');
  });

  it('lets go of a field that goes: steps that set it go with it', () => {
    const definition = removeField(app(), 'expense_claim', app().entities['expense_claim']!.fields.findIndex((f) => f.name === 'approver'));
    expect(steps(definition).map((step) => step.type)).toEqual(['check', 'check']);
    const withLine = addStep(app(), 'submit_claim', 'add_line').definition;
    const lineFields = withLine.entities['expense_line']!.fields;
    const without = removeField(withLine, 'expense_line', lineFields.findIndex((f) => f.name === 'merchant'));
    expect(steps(without, 'submit_claim')[0]).toMatchObject({ values: { date: { today: true }, category: 'travel', amount: 0 } });
    expect(steps(without, 'submit_claim')[0]).not.toHaveProperty('values.merchant');
  });
});

describe('values of steps', () => {
  it('offers the fields that hold the same kind of value', () => {
    const definition = app();
    const fields = definition.entities['expense_claim']!.fields;
    const of = (name: string) => valueSources(definition, 'expense_claim', fields.find((f) => f.name === name)).map((source) => source.ref);
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
});
