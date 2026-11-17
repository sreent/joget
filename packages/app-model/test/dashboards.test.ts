import { describe, expect, it } from 'vitest';
import { EXPENSE_APP, rangeStart, validateDefinition, type StoredDefinition } from '@platform/app-model';

const ids = () => {
  let n = 0;
  return () => `id${String(++n).padStart(4, '0')}`;
};

function issuesOf(input: unknown): string[] {
  const result = validateDefinition(input, undefined, ids());
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

const example = () => structuredClone(EXPENSE_APP) as any;
const withBlocks = (blocks: unknown[]) => {
  const definition = example();
  definition.pages.spending.blocks = blocks;
  return definition;
};
const chart = (patch: Record<string, unknown>) => ({ type: 'chart', title: 'A chart', entity: 'expense_claim', measure: { op: 'count' }, group: { field: 'status' }, ...patch });

describe('numbers and charts', () => {
  it('accept the example dashboard: numbers over claims and their lines, charts by category and by month', () => {
    expect(issuesOf(EXPENSE_APP)).toEqual([]);
  });

  it('check what a number works out', () => {
    expect(
      issuesOf(
        withBlocks([
          { type: 'stat', label: 'A', entity: 'expense_claim', measure: { op: 'sum' } },
          { type: 'stat', label: 'B', entity: 'expense_claim', measure: { op: 'sum', field: 'title' } },
          { type: 'stat', label: 'C', entity: 'expense_claim', measure: { op: 'count', field: 'title' } },
          { type: 'stat', label: 'D', entity: 'expense_claim', measure: { op: 'avg', field: 'lines.nope' } },
          { type: 'stat', label: 'E', entity: 'expense_line', measure: { op: 'count' } },
          { type: 'stat', label: 'F', entity: 'expense_claim', measure: { op: 'max', field: 'total' }, range: { field: 'title', within: 'this_year' } },
        ]),
      ),
    ).toEqual([
      'pages.spending.blocks[0].measure.field: Name the number field to total',
      "pages.spending.blocks[1].measure.field: title isn't a number",
      "pages.spending.blocks[2].measure.field: Count records, or name a lines field to count lines: title isn't one",
      'pages.spending.blocks[3].measure.field: No field named lines.nope',
      'pages.spending.blocks[4].entity: expense_line is the lines of expense_claim.lines, so it has no records of its own: use expense_claim',
      "pages.spending.blocks[5].range.field: title isn't a date or a time",
    ]);
  });

  it('check what a chart groups by, and how it shows it', () => {
    expect(
      issuesOf(
        withBlocks([
          chart({ group: { field: 'created_at' } }),
          chart({ group: { field: 'status', period: 'month' } }),
          chart({ group: { field: 'total' } }),
          chart({ group: { field: 'lines' } }),
          chart({ show: 'line' }),
          chart({ group: { field: 'lines.category' }, measure: { op: 'sum', field: 'total' } }),
        ]),
      ),
    ).toEqual([
      'pages.spending.blocks[0].group.period: created_at is a date: group it by periods, such as month',
      "pages.spending.blocks[1].group.period: Only dates group by periods: status isn't one",
      "pages.spending.blocks[2].group.field: total can't group records: group by a choice, text, a yes or no, a person or a date",
      'pages.spending.blocks[3].group.field: lines holds lines: group by a field of them, such as lines.category',
      'pages.spending.blocks[4].show: A line shows change over time: group by periods of a date, or show bars',
      'pages.spending.blocks[5].measure.field: This works over lines, so total a field of them, such as lines.amount',
    ]);
  });

  it('accept a count of records grouped by a field of their lines, and people as groups', () => {
    expect(issuesOf(withBlocks([chart({ group: { field: 'lines.category' } }), chart({ group: { field: 'owner' } }), chart({ group: { field: 'approver' } })]))).toEqual([]);
  });

  it('follow renames of the fields they work over', () => {
    const before = validateDefinition(EXPENSE_APP, undefined, ids());
    if (!before.ok) throw new Error('example');
    const draft = structuredClone(before.definition) as any;
    draft.entities.expense_line.fields.find((f: { name: string }) => f.name === 'amount').name = 'cost';
    draft.entities.expense_line.fields.find((f: { name: string }) => f.name === 'date').name = 'spent_on';
    const result = validateDefinition(draft, before.definition as StoredDefinition, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.definition.pages['spending']!.blocks[4]).toMatchObject({
      measure: { op: 'sum', field: 'lines.cost' },
      group: { field: 'lines.spent_on', period: 'month' },
      range: { field: 'lines.spent_on', within: 'last_12_months' },
    });
  });
});

describe('time ranges', () => {
  const now = new Date('2026-11-17T09:30:00Z');
  it('start at the start of a month, a quarter or a year, or so many days back, in UTC', () => {
    expect(rangeStart('this_month', now)).toEqual({ date: '2026-11-01', time: '2026-11-01T00:00:00.000Z' });
    expect(rangeStart('this_quarter', now).date).toBe('2026-10-01');
    expect(rangeStart('this_year', now).date).toBe('2026-01-01');
    expect(rangeStart('last_30_days', now).date).toBe('2026-10-18');
    expect(rangeStart('last_90_days', now).date).toBe('2026-08-19');
    expect(rangeStart('last_12_months', now).date).toBe('2025-12-01');
  });
});

describe('queries that work out numbers', () => {
  const withQuery = (query: Record<string, unknown>) => {
    const definition = example();
    definition.queries.my_spending = { ...definition.queries.my_spending, ...query };
    return definition;
  };

  it('are checked as numbers and charts are, and return no fields', () => {
    expect(
      issuesOf(
        withQuery({
          fields: ['title'],
          sort: [{ field: 'created_at', direction: 'desc' }],
          summary: { measure: { op: 'sum', field: 'title' }, group: { field: 'lines.date' } },
        }),
      ),
    ).toEqual([
      'queries.my_spending.fields: A query that answers with numbers returns no fields',
      'queries.my_spending.sort: A query that answers with numbers is in its own order: largest first, or latest first',
      "queries.my_spending.summary.measure.field: title isn't a number",
      'queries.my_spending.summary.group.period: lines.date is a date: group it by periods, such as month',
      'queries.my_spending.summary.measure.field: This works over lines, so total a field of them, such as lines.amount',
    ]);
    const plain = example();
    plain.queries.my_claims.fields = [];
    expect(issuesOf(plain)).toEqual(['queries.my_claims.fields: Name at least one field each record carries, or let the query answer with numbers']);
  });

  it('carry renames into what they work out', () => {
    const first = validateDefinition(EXPENSE_APP, undefined, ids());
    if (!first.ok) throw new Error('example');
    const next = structuredClone(first.definition) as any;
    next.entities.expense_line.fields.find((f: { name: string }) => f.name === 'category').name = 'kind';
    next.entities.expense_line.fields.find((f: { name: string }) => f.name === 'date').name = 'spent_on';
    const result = validateDefinition(next, first.definition, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.definition.queries['my_spending']!.summary).toMatchObject({
      measure: { field: 'lines.amount' },
      group: { field: 'lines.kind' },
      range: { field: 'lines.spent_on' },
    });
  });
});
