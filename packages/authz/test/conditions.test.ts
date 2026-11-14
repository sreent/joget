import { describe, expect, it } from 'vitest';
import {
  evaluateCondition,
  isCondition,
  isKnownPermissionPattern,
  matchesPermission,
  patternCovers,
  type Condition,
} from '@platform/authz';

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
    for (const bad of [null, [], {}, { eq: [1] }, { all: [] }, { foo: [1, 2] }, { eq: [1, 2], ne: [1, 2] }, { exists: '' }, { eq: [{ ref: '' }, 1] }, { lt: [Number.NaN, 1] }]) {
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
