import { blockAt, diffDefinitions, EXPENSE_APP, mergeDefinitions, pageBlocks, type StoredDefinition, validateDefinition } from '@platform/app-model';
import { describe, expect, it } from 'vitest';

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

const example = () => structuredClone(EXPENSE_APP) as any;

describe('pages and the menu', () => {
  it('accept the example: a page of my records, a page for approvers, and a menu', () => {
    const definition = valid(EXPENSE_APP);
    expect(Object.keys(definition.pages)).toEqual(['my_claims', 'to_approve', 'spending']);
    expect(definition.pages['to_approve']!.blocks[1]).toMatchObject({ type: 'list', limit: 20, actions: ['approve_claim'] });
    expect(definition.navigation?.home).toBe('my_claims');
  });

  it('need no pages or menu: an app without them lists its forms and records', () => {
    const definition = valid({ entities: EXPENSE_APP.entities });
    expect(definition.pages).toEqual({});
    expect(definition.navigation).toBeUndefined();
  });

  it('check what a list shows, which records, in what order, and what runs on a row', () => {
    const broken = example();
    broken.pages.to_approve.blocks[1] = {
      type: 'list',
      entity: 'expense_claim',
      columns: ['title', 'lines', 'nope', 'title', 'version'],
      filter: { eq: [{ ref: 'record.total' }, 'lots'] },
      sort: [{ field: 'lines' }],
      actions: ['submit_claim', 'approve_claim'],
    };
    broken.pages.lines_page = { label: 'Lines', blocks: [{ type: 'list', entity: 'expense_line', columns: ['merchant'] }] };
    expect(issuesOf(broken)).toEqual([
      'pages.to_approve.blocks[1].columns: lines holds lines: show a rollup, such as a total, instead',
      'pages.to_approve.blocks[1].columns: No field named nope',
      'pages.to_approve.blocks[1].columns: title is a column twice',
      'pages.to_approve.blocks[1].columns: No field named version',
      'pages.to_approve.blocks[1].filter: total holds numbers, not strings',
      "pages.to_approve.blocks[1].sort[0]: lines holds lines, which can't be sorted by",
      "pages.to_approve.blocks[1].actions: submit_claim doesn't change a expense_claim record, so it can't run on a row",
      'pages.lines_page.blocks[0].entity: expense_line is the lines of expense_claim.lines, so it has no records of its own: use expense_claim',
    ]);
  });

  it("refuse an action that takes input as a row action, as it can't run in one click", () => {
    const broken = example();
    broken.actions.approve_claim.input = ['status'];
    delete broken.actions.approve_claim.set.status;
    expect(issuesOf(broken)).toEqual([
      "pages.to_approve.blocks[1].actions: approve_claim takes input, so it can't run in one click: open it from a form instead",
    ]);
  });

  it('check that buttons, menu items and page roles name what exists', () => {
    const broken = example();
    broken.pages.my_claims.blocks[0].buttons.push({ form: 'gone' }, { page: 'nowhere' });
    broken.pages.my_claims.roles = ['auditor'];
    broken.navigation = { home: 'start', items: [{ page: 'start' }, { form: 'gone' }, { entity: 'expense_line' }, { entity: 'invoice' }, { heading: 'More' }] };
    expect(issuesOf(broken)).toEqual([
      'pages.my_claims.roles: No role named auditor',
      'pages.my_claims.blocks[0].buttons[1]: No form named gone',
      'pages.my_claims.blocks[0].buttons[2]: No page named nowhere',
      'navigation.home: No page named start',
      'navigation.items[0]: No page named start',
      'navigation.items[1]: No form named gone',
      'navigation.items[2]: expense_line is the lines of expense_claim.lines, so it has no records of its own: use expense_claim',
      'navigation.items[3]: No entity named invoice',
    ]);
  });

  it('follow renames of entities and fields, by their IDs', () => {
    const before = valid(EXPENSE_APP);
    const draft = structuredClone(before) as any;
    draft.entities.claim = draft.entities.expense_claim;
    delete draft.entities.expense_claim;
    draft.entities.claim.fields.find((f: { name: string }) => f.name === 'status').name = 'state';
    const result = validateDefinition(draft, before, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const list = result.definition.pages['to_approve']!.blocks[1]!;
    expect(list).toMatchObject({ entity: 'claim', filter: { eq: [{ ref: 'record.state' }, 'submitted'] } });
    expect(result.definition.navigation!.items[2]).toEqual({ entity: 'claim', label: 'All claims' });
  });

  it('show in a change request, and merge three ways', () => {
    const base = valid(EXPENSE_APP);
    const ours = structuredClone(base) as any;
    ours.pages.to_approve.label = 'Waiting for me';
    ours.navigation.items.push({ heading: 'Help' });
    const head = valid(ours, base);
    expect(diffDefinitions(base, head)).toEqual([
      { section: 'pages', name: 'to_approve', change: 'changed', details: [] },
      { section: 'navigation', name: 'menu', change: 'changed', details: [] },
    ]);

    const theirs = structuredClone(base) as any;
    theirs.pages.my_claims.description = 'Claims you made';
    const merged = mergeDefinitions(base, head, valid(theirs, base));
    expect(merged.ok).toBe(true);
    const result = valid(merged.ok ? merged.definition : {}, base);
    expect(result.pages['to_approve']!.label).toBe('Waiting for me');
    expect(result.pages['my_claims']!.description).toBe('Claims you made');
    expect(result.navigation!.items.at(-1)).toEqual({ heading: 'Help' });

    const rival = structuredClone(base) as any;
    rival.navigation.home = 'to_approve';
    expect(mergeDefinitions(base, head, valid(rival, base))).toEqual({
      ok: false,
      conflicts: [{ section: 'navigation', name: 'menu', ours: 'changed', theirs: 'changed' }],
    });
  });
});

/** The example with trips: each claim may refer to a trip, and a page about one trip shows its claims. */
function withTrips() {
  const draft = example();
  draft.entities.trip = {
    label: 'Trip',
    pluralLabel: 'Trips',
    titleField: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'starts', label: 'Starts', type: 'date' },
    ],
  };
  draft.entities.expense_claim.fields.push({ name: 'for_trip', label: 'For trip', type: 'reference', entity: 'trip' });
  draft.pages.trip_page = {
    label: 'Trip',
    record: { entity: 'trip' },
    blocks: [
      { type: 'fields', fields: ['name', 'starts'] },
      {
        type: 'tabs',
        tabs: [
          { label: 'Claims', blocks: [{ type: 'list', entity: 'expense_claim', columns: ['title', 'total'], of: 'for_trip', open: 'claim_page' }] },
          { label: 'Spent', blocks: [{ type: 'stat', label: 'Spent on it', entity: 'expense_claim', measure: { op: 'sum', field: 'total' }, of: 'for_trip' }] },
        ],
      },
    ],
  };
  draft.pages.claim_page = {
    label: 'Claim',
    record: { entity: 'expense_claim' },
    blocks: [{ type: 'fields', fields: ['title', 'trip', 'lines', 'total', 'status'], actions: ['approve_claim'] }],
  };
  draft.pages.my_claims.blocks[1].open = 'claim_page';
  return draft;
}

describe('pages about one record', () => {
  it('show its fields, the records that refer to it, in tabs, and open from a row', () => {
    const definition = valid(withTrips());
    expect(definition.pages['trip_page']).toMatchObject({
      record: { entity: 'trip' },
      blocks: [{ type: 'fields' }, { type: 'tabs', tabs: [{ label: 'Claims' }, { label: 'Spent' }] }],
    });
    expect(pageBlocks(definition.pages['trip_page']!).map((each) => `${each.path} ${each.block.type}`)).toEqual(['0 fields', '1.0.0 list', '1.1.0 stat']);
    expect(blockAt(definition.pages['trip_page']!, '1.0.0')).toMatchObject({ type: 'list', of: 'for_trip' });
    expect(blockAt(definition.pages['trip_page']!, '1')).toMatchObject({ type: 'tabs' });
    expect(blockAt(definition.pages['trip_page']!, '1.2.0')).toBeUndefined();
    expect(blockAt(definition.pages['trip_page']!, 'x')).toBeUndefined();
  });

  it('say what is wrong with each, on the block it is about', () => {
    const draft = withTrips();
    draft.pages.trip_page.blocks[0].fields.push('colour');
    draft.pages.trip_page.blocks[1].tabs[0].blocks[0].of = 'trip';
    draft.pages.trip_page.blocks[1].tabs[0].blocks[0].open = 'my_claims';
    draft.pages.my_claims.blocks.push({ type: 'fields', fields: ['title'] }, { type: 'list', entity: 'expense_claim', columns: ['title'], of: 'for_trip' });
    draft.pages.claim_page.blocks[0].actions = ['submit_claim'];
    draft.pages.my_claims.blocks[0].buttons.push({ page: 'claim_page' });
    draft.navigation.items.push({ page: 'trip_page' });
    expect(issuesOf(draft)).toEqual([
      "pages.my_claims.blocks[0].buttons[1]: claim_page is about one record, so a list's row opens it, not a button",
      'pages.my_claims.blocks[2]: Only a page about one record shows its fields: say which entity the page is about',
      'pages.my_claims.blocks[3].of: Only a page about one record shows the records that refer to it',
      'pages.trip_page.blocks[0].fields: No field named colour',
      "pages.trip_page.blocks[1].tabs[0].blocks[0].of: trip isn't a field of expense_claim that refers to a trip",
      "pages.trip_page.blocks[1].tabs[0].blocks[0].open: my_claims isn't a page about one expense_claim, so a row can't open it",
      "pages.claim_page.blocks[0].actions: submit_claim doesn't change a expense_claim record, so it can't run on this record",
      "navigation.items[6]: trip_page is about one record, so a list's row opens it, not the menu",
    ]);
  });

  it('follow renames into its fields and the field that refers to it', () => {
    const first = valid(withTrips());
    const next = structuredClone(first) as any;
    next.entities.trip.fields[0].name = 'title';
    next.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'for_trip').name = 'trip_of';
    const definition = valid(next, first);
    expect(definition.pages['trip_page']!.blocks[0]).toMatchObject({ fields: ['title', 'starts'] });
    expect(definition.pages['trip_page']!.blocks[1]).toMatchObject({ tabs: [{ blocks: [{ of: 'trip_of' }] }, { blocks: [{ of: 'trip_of' }] }] });
  });
});
