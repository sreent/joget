import { describe, expect, it } from 'vitest';
import { cellValue, EXPENSE_APP, importColumns, parseCsv, safeCell, validateDefinition, writeCsv } from '@platform/app-model';

/** CSV, to bring records in from spreadsheets and other systems, and take them out (design §6.1). */

const definition = (() => {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.trip = { label: 'Trip', pluralLabel: 'Trips', titleField: 'name', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }] };
  draft.entities.expense_claim.fields.push(
    { name: 'trips', label: 'Trips', type: 'reference', entity: 'trip', multiple: true },
    { name: 'urgent', label: 'Urgent', type: 'boolean' },
    { name: 'tags', label: 'Tags', type: 'choice', multiple: true, options: [{ value: 'client', label: 'Client' }, { value: 'team', label: 'Team, internal' }] },
  );
  const result = validateDefinition(draft);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
})();
const claim = definition.entities['expense_claim']!;
const field = (name: string) => claim.fields.find((f) => f.name === name)!;

describe('CSV', () => {
  it('reads quoted cells with separators, quotes and line breaks, and drops blank lines and a byte order mark', () => {
    const text = '﻿Title,Amount\r\n"Hotel, Tokyo","1,234.50"\n\n"He said ""fine""","line one\nline two"\n';
    expect(parseCsv(text)).toEqual({ ok: true, rows: [['Title', 'Amount'], ['Hotel, Tokyo', '1,234.50'], ['He said "fine"', 'line one\nline two']] });
    // Some spreadsheets write semicolons.
    expect(parseCsv('Title;Amount\nTaxi;12,50')).toEqual({ ok: true, rows: [['Title', 'Amount'], ['Taxi', '12,50']] });
    expect(parseCsv('Title\n"Open')).toEqual({ ok: false, message: 'A quoted cell has no closing quote' });
  });

  it('writes what it reads back, and keeps a spreadsheet from running a cell as a formula', () => {
    const rows = [['Title', 'Note'], ['Hotel, Tokyo', 'He said "fine"'], [safeCell('=HYPERLINK("x")'), safeCell('-5 days')]];
    const text = writeCsv(rows);
    expect(text.startsWith('﻿Title,Note\r\n')).toBe(true);
    expect(parseCsv(text)).toEqual({ ok: true, rows: [['Title', 'Note'], ['Hotel, Tokyo', 'He said "fine"'], ["'=HYPERLINK(\"x\")", "'-5 days"]] });
    expect(safeCell('Taxi')).toBe('Taxi');
  });

  it('matches columns to fields by name or label, and says why a column fills none', () => {
    expect(importColumns(claim, ['TITLE', 'Trip', 'Total (SGD)', 'Receipts', 'owner', 'title', 'Colour'])).toEqual([
      { header: 'TITLE', field: 'title' },
      { header: 'Trip', field: 'trip' },
      { header: 'Total (SGD)', field: null, note: 'The platform works this field out' },
      { header: 'Receipts', field: null, note: "Lines can't be brought in from a file" },
      { header: 'owner', field: 'owner' },
      { header: 'title', field: null, note: 'Another column fills this field' },
      { header: 'Colour', field: null, note: 'No field has this name' },
    ]);
  });

  it('reads a cell as its field takes it: numbers, yes or no, options by value or label, and names to look up', () => {
    expect(cellValue(field('title'), ' Taxi ')).toEqual({ ok: true, value: ' Taxi ' });
    expect(cellValue(field('urgent'), 'Yes')).toEqual({ ok: true, value: true });
    expect(cellValue(field('urgent'), 'maybe')).toEqual({ ok: false, message: 'Expected yes or no' });
    expect(cellValue(field('status'), 'Submitted')).toEqual({ ok: true, value: 'submitted' });
    expect(cellValue(field('tags'), 'client; Team, internal')).toEqual({ ok: true, value: ['client', 'team'] });
    expect(cellValue(field('tags'), 'client; other')).toEqual({ ok: false, message: 'Not options: other' });
    expect(cellValue(field('trips'), 'Tokyo summit; Penang')).toEqual({ lookup: 'record', keys: ['Tokyo summit', 'Penang'], many: true });
    expect(cellValue(field('approver'), 'bob@example.com')).toEqual({ lookup: 'person', keys: ['bob@example.com'], many: false });
    expect(cellValue('owner', 'alice@example.com')).toEqual({ lookup: 'person', keys: ['alice@example.com'], many: false });
  });

  it('reads numbers as people write them, but not as other countries write them', () => {
    const amount = definition.entities['expense_line']!.fields.find((f) => f.name === 'amount')!;
    expect(cellValue(amount, '1,234.50')).toEqual({ ok: true, value: 1234.5 });
    expect(cellValue(amount, '-12')).toEqual({ ok: true, value: -12 });
    expect(cellValue(amount, '12,50')).toEqual({ ok: false, message: 'Expected a number, such as 1234.50' });
  });
});
