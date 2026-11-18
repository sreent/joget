import { applyEdits, DefinitionEdits, pointerKeys, valueAt } from '@platform/app-model';
import { describe, expect, it } from 'vitest';

/** Small checked changes to a definition, as JSON Patch writes them. */
describe('edits to a definition', () => {
  const definition = { entities: { claim: { label: 'Claim', fields: [{ name: 'amount' }, { name: 'date' }] } }, 'a/b': { '~c': 1 } };

  it('add, replace and remove values in objects and lists, in order, on a copy', () => {
    const result = applyEdits(definition, [
      { op: 'add', path: '/entities/claim/fields/-', value: { name: 'reason' } },
      { op: 'add', path: '/entities/claim/fields/0', value: { name: 'id' } },
      { op: 'replace', path: '/entities/claim/label', value: 'Expense claim' },
      { op: 'remove', path: '/entities/claim/fields/2' },
      { op: 'add', path: '/entities/trip', value: { label: 'Trip', fields: [] } },
      { op: 'replace', path: '/a~1b/~0c', value: 2 },
    ]);
    expect(result).toEqual({
      ok: true,
      definition: {
        entities: {
          claim: { label: 'Expense claim', fields: [{ name: 'id' }, { name: 'amount' }, { name: 'reason' }] },
          trip: { label: 'Trip', fields: [] },
        },
        'a/b': { '~c': 2 },
      },
    });
    // The definition itself is untouched.
    expect(definition.entities.claim.fields).toHaveLength(2);
  });

  it('refuse all of them when one leads nowhere, and say which', () => {
    expect(
      applyEdits(definition, [
        { op: 'replace', path: '/entities/claim/label', value: 'x' },
        { op: 'remove', path: '/entities/claim/fields/5' },
      ]),
    ).toEqual({
      ok: false,
      index: 1,
      message: 'remove /entities/claim/fields/5: the list has 2 items',
    });
    expect(applyEdits(definition, [{ op: 'replace', path: '/entities/trip/label', value: 'x' }])).toMatchObject({
      ok: false,
      message: 'replace /entities/trip/label: nothing is at trip',
    });
    expect(applyEdits(definition, [{ op: 'add', path: 'entities', value: 1 }])).toMatchObject({
      ok: false,
      message: 'add entities: a path is a JSON pointer, which starts with /',
    });
    expect(applyEdits(definition, [{ op: 'add', path: '/__proto__/polluted', value: true }])).toMatchObject({
      ok: false,
      message: 'add /__proto__/polluted: a path names members of the definition only',
    });
    expect(applyEdits(definition, [{ op: 'remove', path: '' }])).toMatchObject({ ok: false });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('read a value by its JSON pointer, and check the shape of edits', () => {
    expect(pointerKeys('/a~1b/~0c')).toEqual(['a/b', '~c']);
    expect(valueAt(definition, '/entities/claim/fields/1/name')).toBe('date');
    expect(valueAt(definition, '/entities/claim/fields/9')).toBeUndefined();
    expect(DefinitionEdits.safeParse([{ op: 'move', from: '/a', path: '/b' }]).success).toBe(false);
    expect(DefinitionEdits.safeParse([]).success).toBe(false);
  });
});
