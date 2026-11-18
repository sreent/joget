import { addDuration, nextRun, type Schedule, scheduleWords, timerFiresAt } from '@platform/app-model';
import { describe, expect, it } from 'vitest';

const at = (iso: string) => new Date(iso);
const next = (schedule: Partial<Schedule> & Pick<Schedule, 'every'>, after: string) => nextRun({ at: '00:00', ...schedule }, at(after)).toISOString();

describe('a schedule', () => {
  it('runs every hour, day, weekday, week or month, at a time of day', () => {
    expect(next({ every: 'hour', at: '00:15' }, '2026-11-18T10:20:00Z')).toBe('2026-11-18T11:15:00.000Z');
    expect(next({ every: 'hour', at: '00:15' }, '2026-11-18T10:05:00Z')).toBe('2026-11-18T10:15:00.000Z');
    expect(next({ every: 'day', at: '07:30' }, '2026-11-18T07:30:00Z')).toBe('2026-11-19T07:30:00.000Z');
    expect(next({ every: 'day', at: '07:30' }, '2026-11-18T07:29:00Z')).toBe('2026-11-18T07:30:00.000Z');
    // 20 November 2026 is a Friday: the next weekday after it is the Monday.
    expect(next({ every: 'weekday', at: '07:30' }, '2026-11-20T08:00:00Z')).toBe('2026-11-23T07:30:00.000Z');
    expect(next({ every: 'week', on: 'wednesday', at: '09:00' }, '2026-11-18T09:00:00Z')).toBe('2026-11-25T09:00:00.000Z');
    expect(next({ every: 'month', day: 'last', at: '18:00' }, '2027-02-10T00:00:00Z')).toBe('2027-02-28T18:00:00.000Z');
    expect(next({ every: 'month', day: 1 }, '2026-12-01T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('keeps to the wall clock of its time zone, in summer and in winter', () => {
    const london: Schedule = { every: 'day', at: '07:30', zone: 'Europe/London' };
    expect(nextRun(london, at('2026-07-01T00:00:00Z')).toISOString()).toBe('2026-07-01T06:30:00.000Z');
    expect(nextRun(london, at('2026-12-01T00:00:00Z')).toISOString()).toBe('2026-12-01T07:30:00.000Z');
    // 01:30 doesn't happen in London on 29 March 2026: the clocks go from 01:00 to 02:00.
    expect(nextRun({ every: 'day', at: '01:30', zone: 'Europe/London' }, at('2026-03-29T00:00:00Z')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(nextRun({ every: 'day', at: '09:00', zone: 'Asia/Kolkata' }, at('2026-11-18T00:00:00Z')).toISOString()).toBe('2026-11-18T03:30:00.000Z');
  });

  it('says when it runs, in words', () => {
    expect(scheduleWords({ every: 'weekday', at: '07:30', zone: 'Europe/London' })).toBe('Every weekday at 07:30, Europe/London time');
    expect(scheduleWords({ every: 'week', on: 'friday', at: '16:00' })).toBe('Every Friday at 16:00 UTC');
    expect(scheduleWords({ every: 'month', day: 2, at: '08:00' })).toBe('On the 2nd of each month at 08:00 UTC');
    expect(scheduleWords({ every: 'hour', at: '00:05' })).toBe('Every hour at 5 minutes past');
  });
});

describe('a timer on a date', () => {
  it('fires on the date, or a time before or after it', () => {
    const record = { starts: '2026-12-21' };
    const now = at('2026-11-18T10:00:00Z');
    expect(timerFiresAt({ date: 'starts' }, now, record)?.toISOString()).toBe('2026-12-21T00:00:00.000Z');
    expect(timerFiresAt({ date: 'starts', before: 'P2D' }, now, record)?.toISOString()).toBe('2026-12-19T00:00:00.000Z');
    expect(timerFiresAt({ date: 'starts', after: 'PT9H' }, now, record)?.toISOString()).toBe('2026-12-21T09:00:00.000Z');
    expect(addDuration(at('2026-03-31T00:00:00Z'), 'P1M', -1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });
});
