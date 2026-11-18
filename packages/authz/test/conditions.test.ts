import {
  type Condition,
  conditionRefs,
  evaluateCondition,
  isCondition,
  isKnownPermissionPattern,
  matchesPermission,
  partialEvaluate,
  patternCovers,
  relativeValue,
} from '@platform/authz';
import { describe, expect, it } from 'vitest';

const env = {
  principal: { id: 'alice', department: 'finance', level: 3 },
  resource: { ownerId: 'alice', status: 'submitted', amount: 120, tags: ['urgent', 'travel'] },
  context: {},
};

describe('evaluateCondition', () => {
  const cases: Array<[string, Condition, boolean]> = [
    ['eq on refs', { eq: [{ ref: 'resource.ownerId' }, { ref: 'principal.id' }] }, true],
    ['eq on literal', { eq: [{ ref: 'resource.status' }, 'approved'] }, false],
    ['ne', { ne: [{ ref: 'resource.status' }, 'approved'] }, true],
    ['in literal list', { in: [{ ref: 'resource.status' }, ['submitted', 'approved']] }, true],
    ['in referenced list', { in: ['travel', { ref: 'resource.tags' }] }, true],
    ['lt', { lt: [{ ref: 'resource.amount' }, 500] }, true],
    ['gte', { gte: [{ ref: 'principal.level' }, 4] }, false],
    ['all', { all: [{ exists: 'principal.department' }, { eq: [{ ref: 'principal.department' }, 'finance'] }] }, true],
    ['any', { any: [{ eq: [{ ref: 'resource.status' }, 'draft'] }, { eq: [{ ref: 'resource.amount' }, 120] }] }, true],
    ['not', { not: { exists: 'context.authorId' } }, true],
  ];
  it.each(cases)('%s', (_name, condition, expected) => {
    expect(evaluateCondition(condition, env)).toBe(expected);
  });

  it('never matches a missing value, even against another missing value', () => {
    expect(evaluateCondition({ eq: [{ ref: 'context.a' }, { ref: 'context.b' }] }, env)).toBe(false);
    expect(evaluateCondition({ ne: [{ ref: 'context.a' }, 'x'] }, env)).toBe(false);
    expect(evaluateCondition({ in: [{ ref: 'context.a' }, ['x']] }, env)).toBe(false);
    expect(evaluateCondition({ lt: [{ ref: 'context.a' }, 1] }, env)).toBe(false);
  });

  it('does not walk the prototype chain', () => {
    expect(evaluateCondition({ exists: 'principal.toString' }, env)).toBe(false);
    expect(evaluateCondition({ exists: 'principal.__proto__' }, env)).toBe(false);
  });

  it('only compares numbers', () => {
    expect(evaluateCondition({ lt: [{ ref: 'resource.status' }, 'zzz'] }, env)).toBe(false);
  });
});

describe('isCondition', () => {
  it('accepts well-formed conditions', () => {
    expect(isCondition({ all: [{ eq: [{ ref: 'a.b' }, 1] }, { not: { exists: 'c' } }] })).toBe(true);
    expect(isCondition({ in: [{ ref: 'a' }, ['x', 2, null]] })).toBe(true);
  });

  it('rejects malformed or unbounded input', () => {
    for (const bad of [
      null,
      [],
      {},
      { eq: [1] },
      { all: [] },
      { foo: [1, 2] },
      { eq: [1, 2], ne: [1, 2] },
      { exists: '' },
      { eq: [{ ref: '' }, 1] },
      { lt: [Number.NaN, 1] },
    ]) {
      expect(isCondition(bad)).toBe(false);
    }
    let deep: unknown = { exists: 'x' };
    for (let i = 0; i < 40; i++) deep = { not: deep };
    expect(isCondition(deep)).toBe(false);
  });
});

describe('permission patterns', () => {
  it('matches exact, prefix and global patterns', () => {
    expect(matchesPermission('app.edit', 'app.edit')).toBe(true);
    expect(matchesPermission('app.*', 'app.edit')).toBe(true);
    expect(matchesPermission('app.*', 'apps.edit')).toBe(false);
    expect(matchesPermission('app.*', 'app')).toBe(false);
    expect(matchesPermission('*', 'anything.at.all')).toBe(true);
  });

  it('knows when one pattern covers another', () => {
    expect(patternCovers('app.*', 'app.edit')).toBe(true);
    expect(patternCovers('app.*', 'app.x.*')).toBe(true);
    expect(patternCovers('app.edit', 'app.*')).toBe(false);
    expect(patternCovers('app.*', '*')).toBe(false);
    expect(patternCovers('*', '*')).toBe(true);
  });

  it('recognizes catalog permissions', () => {
    expect(isKnownPermissionPattern('record.*')).toBe(true);
    expect(isKnownPermissionPattern('space.read')).toBe(true);
    expect(isKnownPermissionPattern('rocket.launch')).toBe(false);
  });
});

describe('dates and times', () => {
  const env = { $now: '2026-11-18T09:30:00Z', record: { starts: '2026-11-20', ends: '2026-11-15', at: '2026-11-18T08:00:00Z' } };

  it('compare as the moments they name, and a date is the start of its day', () => {
    expect(evaluateCondition({ gt: [{ ref: 'record.starts' }, { ref: 'record.ends' }] }, env)).toBe(true);
    expect(evaluateCondition({ lt: [{ ref: 'record.at' }, '2026-11-18T09:00:00+00:00'] }, env)).toBe(true);
    expect(evaluateCondition({ gte: [{ ref: 'record.at' }, '2026-11-18'] }, env)).toBe(true);
    // Text that names no moment never compares.
    expect(evaluateCondition({ lt: ['soon', { ref: 'record.starts' }] }, env)).toBe(false);
    expect(evaluateCondition({ lt: [1, { ref: 'record.starts' }] }, env)).toBe(false);
  });

  it('take today and now from the clock the environment carries, with offsets', () => {
    expect(relativeValue({ today: 2 }, new Date('2026-11-18T23:59:00Z'))).toBe('2026-11-20');
    expect(relativeValue({ now: -2 }, new Date('2026-11-18T09:30:00Z'))).toBe('2026-11-18T07:30:00.000Z');
    expect(evaluateCondition({ gte: [{ ref: 'record.starts' }, { today: 2 }] }, env)).toBe(true);
    expect(evaluateCondition({ gte: [{ ref: 'record.starts' }, { today: 3 }] }, env)).toBe(false);
    expect(evaluateCondition({ eq: [{ ref: 'record.ends' }, { today: -3 }] }, env)).toBe(true);
    expect(evaluateCondition({ lt: [{ ref: 'record.at' }, { now: -1 }] }, env)).toBe(true);
    expect(isCondition({ lt: [{ ref: 'record.at' }, { now: -1 }] })).toBe(true);
    expect(isCondition({ lt: [{ ref: 'record.at' }, { now: 1.5 }] })).toBe(false);
    expect(conditionRefs({ lt: [{ ref: 'record.at' }, { today: 0 }] })).toEqual(['record.at']);
  });

  it('fill today in when they leave the record for the database', () => {
    expect(partialEvaluate({ lt: [{ ref: 'record.starts' }, { today: 0 }] }, { $now: '2026-11-18T09:30:00Z' }, ['record'])).toEqual({
      lt: [{ ref: 'record.starts' }, '2026-11-18'],
    });
  });
});
