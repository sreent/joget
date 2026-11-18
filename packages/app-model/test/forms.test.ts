import {
  checkActionInput,
  defaultValue,
  EXPENSE_APP,
  entityFields,
  evaluateRules,
  holdsOn,
  type StoredDefinition,
  validateDefinition,
} from '@platform/app-model';
import { describe, expect, it } from 'vitest';

/**
 * Forms that adapt (design §6.4): a field required while a condition holds, which every write
 * checks; defaults worked out as a record is created; a field a form shows only while a condition
 * holds; and a form in steps.
 */

const ids = () => {
  let n = 0;
  return () => `id${String(++n).padStart(4, '0')}`;
};

function valid(input: unknown, previous?: StoredDefinition): StoredDefinition {
  const result = validateDefinition(input, previous, ids());
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.definition;
}

function issuesOf(input: unknown): string[] {
  const result = validateDefinition(input, undefined, ids());
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

/** The example app, changed by `edit`. */
function edited(edit: (draft: Record<string, any>) => void): Record<string, any> {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  edit(draft);
  return draft;
}

const fieldOf = (draft: Record<string, any>, name: string) => draft.entities.expense_claim.fields.find((f: { name: string }) => f.name === name);
const LARGE = { gt: [{ ref: 'record.total' }, 1000] };
const ALICE = '0193a7c4-0000-7000-8000-000000000001';
const NOW = new Date('2026-11-18T08:30:00.000Z');

/** The example with a bank account required for a large claim, a day it was claimed, and who claims it. */
const adapting = () =>
  edited((d) => {
    fieldOf(d, 'iban').requiredWhen = LARGE;
    d.entities.expense_claim.fields.push(
      { name: 'claimed_on', label: 'Claimed on', type: 'date', default: { today: 0 } },
      { name: 'pay_by', label: 'Pay by', type: 'date', default: { today: 14 } },
      { name: 'noted_at', label: 'Noted at', type: 'datetime', default: { now: 0 } },
      { name: 'claimant', label: 'Claimant', type: 'user', default: { me: true } },
    );
  });

describe('a field required while a condition holds', () => {
  const definition = valid(adapting());

  it('is a rule of its own, which every write runs', () => {
    expect(evaluateRules(definition, 'expense_claim', { title: 'Conference', total: 1500, iban: null }, { principal: {} })).toEqual([
      { rule: 'fields.iban', severity: 'error', message: 'Bank account is required', fields: ['iban'] },
    ]);
    expect(evaluateRules(definition, 'expense_claim', { title: 'Conference', total: 1500, iban: 'SG12 3456' }, { principal: {} })).toEqual([]);
    expect(evaluateRules(definition, 'expense_claim', { title: 'Taxi', total: 30, iban: null }, { principal: {} })).toEqual([]);
  });

  it('says what is wrong with its condition', () => {
    const issues = issuesOf(
      edited((d) => {
        fieldOf(d, 'title').requiredWhen = LARGE;
        fieldOf(d, 'trip').requiredWhen = { exists: 'record.colour' };
        fieldOf(d, 'lines').requiredWhen = LARGE;
        fieldOf(d, 'total').requiredWhen = LARGE;
      }),
    );
    expect(issues).toEqual([
      'entities.expense_claim.fields[0].requiredWhen: Title is always required: leave out the condition, or make it not required',
      'entities.expense_claim.fields[1].requiredWhen: record.colour: no such field',
      'entities.expense_claim.fields[2].requiredWhen: A lines field is required always, or not at all',
      "entities.expense_claim.fields[3].requiredWhen: A field worked out from lines always has its value: it can't be required",
    ]);
  });

  it('follows renames into its condition', () => {
    const first = valid(adapting());
    const next = structuredClone(first) as unknown as Record<string, any>;
    fieldOf(next, 'total').name = 'sum';
    const result = validateDefinition(next, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.definition.entities['expense_claim']!.fields.find((f) => f.name === 'iban')!.requiredWhen).toEqual({ gt: [{ ref: 'record.sum' }, 1000] });
  });
});

describe('defaults worked out as a record is created', () => {
  const definition = valid(adapting());
  const fields = entityFields(definition.entities['expense_claim']!);

  it('give today, a day some days away, now, and the person who creates it', () => {
    const at = { now: NOW, person: ALICE };
    expect(defaultValue(fields.get('claimed_on')!, at)).toBe('2026-11-18');
    expect(defaultValue(fields.get('pay_by')!, at)).toBe('2026-12-02');
    expect(defaultValue(fields.get('noted_at')!, at)).toBe('2026-11-18T08:30:00.000Z');
    expect(defaultValue(fields.get('claimant')!, at)).toBe(ALICE);
    expect(defaultValue(fields.get('status')!, at)).toBe('draft');
    // With no person, as in a process, the person's default gives nothing.
    expect(defaultValue(fields.get('claimant')!, { now: NOW })).toBeUndefined();
    expect(defaultValue(fields.get('trip')!, at)).toBeUndefined();
  });

  it('fill in what a new record is not given', () => {
    const check = checkActionInput(
      definition,
      'submit_claim',
      { title: 'Taxi', lines: [{ date: '2026-11-17', merchant: 'Cab', category: 'travel', amount: 30 }] },
      { now: NOW, person: ALICE },
    );
    expect(check.issues).toEqual([]);
    expect(check.values).toMatchObject({ claimed_on: '2026-11-18', pay_by: '2026-12-02', claimant: ALICE, status: 'submitted' });
  });

  it('take a fixed date, and check its shape', () => {
    expect(issuesOf(edited((d) => d.entities.expense_claim.fields.push({ name: 'due', label: 'Due', type: 'date', default: '2026-12-31' })))).toEqual([]);
    expect(issuesOf(edited((d) => d.entities.expense_claim.fields.push({ name: 'due', label: 'Due', type: 'date', default: '31/12/2026' })))).toEqual([
      'entities.expense_claim.fields[7].default: Give a date as YYYY-MM-DD',
    ]);
  });
});

describe('a form that adapts', () => {
  it('shows a field only while its condition holds, of the values on the form', () => {
    const shown: Parameters<typeof holdsOn>[0] = { gt: [{ ref: 'record.total' }, 1000] };
    expect(holdsOn(shown, { total: 1500 })).toBe(true);
    expect(holdsOn(shown, { total: 30 })).toBe(false);
    // An empty value counts as missing, as in a rule.
    expect(holdsOn({ exists: 'record.trip' }, { trip: '' })).toBe(false);
    expect(holdsOn({ exists: 'record.trip' }, { trip: 'Penang' })).toBe(true);
  });

  it('checks its conditions, and gives a form in steps two sections or more', () => {
    const issues = issuesOf(
      edited((d) => {
        d.forms.claim_form.sections[2].fields[0].visibleWhen = { exists: 'record.colour' };
        d.forms.short_form = { label: 'Short', entity: 'expense_claim', layout: 'steps', sections: [{ fields: [{ field: 'title' }] }] };
      }),
    );
    expect(issues).toEqual([
      'forms.claim_form.sections[2].fields[0].visibleWhen: record.colour: no such field',
      'forms.short_form.layout: A form in steps has a step for each section: give it two sections or more',
    ]);
    const stepped = valid(
      edited((d) => {
        d.forms.claim_form.layout = 'steps';
        d.forms.claim_form.sections[2].fields[0].visibleWhen = { gt: [{ ref: 'record.total' }, 0] };
      }),
    );
    expect(stepped.forms['claim_form']).toMatchObject({
      layout: 'steps',
      sections: [{}, {}, { fields: [{ field: 'iban', visibleWhen: { gt: [{ ref: 'record.total' }, 0] } }] }],
    });
    expect(valid(EXPENSE_APP).forms['claim_form']!.layout).toBe('page');
  });

  it('follows renames into the condition of a field it shows', () => {
    const first = valid(edited((d) => void (d.forms.claim_form.sections[2].fields[0].visibleWhen = { exists: 'record.trip' })));
    const next = structuredClone(first) as unknown as Record<string, any>;
    fieldOf(next, 'trip').name = 'journey';
    const result = validateDefinition(next, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.definition.forms['claim_form']!.sections[2]!.fields[0]!.visibleWhen).toEqual({ exists: 'record.journey' });
  });
});
