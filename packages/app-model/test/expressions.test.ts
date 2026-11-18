import { type Expression, evaluateExpression, isExpression } from '@platform/app-model';
import { describe, expect, it } from 'vitest';

const scope = {
  record: { starts: '2026-11-18', ends: '2026-11-25', at: '2026-11-18T09:30:00.000Z', title: '  Trip to Bangkok  ', kind: 'unpaid', days: 3, note: null },
  principal: { id: 'p1' },
  now: new Date('2026-11-18T10:00:00Z'),
};
const run = (expression: Expression) => {
  const result = evaluateExpression(expression, scope);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

describe('expressions', () => {
  it('move dates and times, and count the days between them', () => {
    expect(run({ add_days: [{ ref: 'record.starts' }, 3] })).toBe('2026-11-21');
    expect(run({ add_days: [{ today: true }, -1] })).toBe('2026-11-17');
    expect(run({ add_days: [{ ref: 'record.at' }, 1] })).toBe('2026-11-19T09:30:00.000Z');
    expect(run({ add_hours: [{ now: true }, 2] })).toBe('2026-11-18T12:00:00.000Z');
    expect(run({ days_between: [{ ref: 'record.starts' }, { ref: 'record.ends' }] })).toBe(7);
    expect(run({ add_days: [{ ref: 'record.note' }, 3] })).toBeNull();
    expect(evaluateExpression({ add_days: [{ ref: 'record.title' }, 3] }, scope)).toEqual({ ok: false, message: 'add_days works on a date or a time' });
  });

  it('choose a value by a condition', () => {
    expect(run({ if: [{ eq: [{ ref: 'record.kind' }, 'unpaid'] }, 'No pay', 'Paid'] })).toBe('No pay');
    expect(run({ if: [{ lt: [{ ref: 'record.starts' }, { today: 1 }] }, 'soon', 'later'] })).toBe('soon');
  });

  it('work with text', () => {
    expect(run({ upper: [{ trim: [{ ref: 'record.title' }] }] })).toBe('TRIP TO BANGKOK');
    expect(run({ lower: ['ABC'] })).toBe('abc');
    expect(run({ text_length: [{ trim: [{ ref: 'record.title' }] }] })).toBe(15);
    expect(run({ text_length: [{ ref: 'record.note' }] })).toBe(0);
    expect(run({ left: [{ trim: [{ ref: 'record.title' }] }, 4] })).toBe('Trip');
    expect(run({ coalesce: [{ ref: 'record.note' }, '', 'none'] })).toBe('none');
  });

  it('refuse a shape they do not know', () => {
    expect(isExpression({ if: [{ eq: [1, 1] }, 'a'] })).toBe(false);
    expect(isExpression({ upper: ['a', 'b'] })).toBe(false);
    expect(isExpression({ add_days: [{ today: true }, 1] })).toBe(true);
  });
});
