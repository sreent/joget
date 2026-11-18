import { EXPENSE_APP } from '@platform/app-model';
import { describe, expect, it } from 'vitest';
import type { Definition } from '../types.js';
import { type Condition, fromModel, opsFor, recordChoices, toModel } from './conditions.js';

const owner = { ref: 'record.owner' };
const roundTrip = (condition: Condition) => fromModel(toModel(condition)!);

describe('conditions as builders edit them', () => {
  it('turns the conditions apps use into clauses, and back unchanged', () => {
    const cases: Condition[] = [
      { eq: [owner, { ref: 'principal.id' }] },
      { lte: [{ ref: 'record.amount' }, 250] },
      { in: [{ ref: 'record.status' }, ['submitted', 'approved']] },
      { not: { in: [{ ref: 'record.status' }, ['draft']] } },
      { in: ['travel', { ref: 'record.tags' }] },
      { exists: 'record.iban' },
      { not: { exists: 'record.iban' } },
      { all: [{ eq: [{ ref: 'record.category' }, 'hotel'] }, { gt: [{ ref: 'record.amount' }, 0] }] },
      { any: [{ eq: [{ ref: 'record.status' }, { ref: 'input.status' }] }, { all: [{ exists: 'record.trip' }, { ne: [{ ref: 'record.total' }, 0] }] }] },
    ];
    for (const condition of cases) expect(roundTrip(condition)).toEqual(condition);
  });

  it('keeps what it cannot show as JSON, and drops what is empty', () => {
    expect(toModel({ all: [{ any: [{ all: [{ exists: 'record.a' }, { exists: 'record.b' }] }, { exists: 'record.c' }] }, { exists: 'record.d' }] })).toBeNull();
    expect(toModel({ eq: ['submitted', { ref: 'record.status' }] })).toBeNull();
    expect(toModel({ not: { all: [{ exists: 'record.a' }] } })).toBeNull();
    expect(fromModel({ match: 'all', items: [] })).toBeUndefined();
    expect(fromModel({ match: 'any', items: [{ ref: 'record.a', op: 'exists' }] })).toEqual({ exists: 'record.a' });
    expect(toModel(undefined)).toEqual({ match: 'all', items: [] });
  });

  it('offers the fields of the record, or of a line, with the operators that suit them', () => {
    const definition = structuredClone(EXPENSE_APP) as unknown as Definition;
    const claim = recordChoices(definition, 'expense_claim');
    expect(claim.map((c) => `${c.ref}:${c.kind}`)).toEqual([
      'record.title:text',
      'record.trip:text',
      'record.total:number',
      'record.status:choice',
      'record.iban:text',
      'record.approver:person',
      'record.owner:person',
      'record.created_by:person',
      'record.updated_by:person',
      'record.created_at:date',
      'record.updated_at:date',
    ]);
    expect(recordChoices(definition, 'expense_line', true).map((c) => c.ref)).toEqual([
      'record.date',
      'record.merchant',
      'record.category',
      'record.amount',
      'record.receipt',
    ]);
    expect(opsFor('date')).toEqual(['lt', 'lte', 'gt', 'gte', 'eq', 'ne', 'exists', 'missing']);
    // A date compares with today or now, so many days or hours away, and comes back as it went.
    const soon: Condition = { lt: [{ ref: 'record.starts' }, { today: 3 }] } as Condition;
    expect(toModel(soon)).toEqual({ match: 'all', items: [{ ref: 'record.starts', op: 'lt', right: { kind: 'relative', unit: 'today', amount: 3 } }] });
    expect(fromModel(toModel(soon)!)).toEqual(soon);
  });
});
