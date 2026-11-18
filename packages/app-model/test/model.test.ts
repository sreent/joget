import { authorizeQuery, createPolicy, type Binding } from '@platform/authz';
import { describe, expect, it } from 'vitest';
import {
  buildCard,
  checkActionInput,
  checkInput,
  compileAppPolicy,
  completeLines,
  covers,
  diffLines,
  environmentNames,
  evaluateRules,
  EXPENSE_APP,
  fieldAccess,
  planMigration,
  rollupValues,
  validateDefinition,
  writeGrant,
  writeLines,
  type StoredDefinition,
  type StoredLinesField,
} from '@platform/app-model';

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

const clone = <T>(value: T): T => structuredClone(value) as T;
const expense = () => valid(EXPENSE_APP);
const names = environmentNames('0193a7c4-0000-7000-8000-00000000abcd', 'sandbox');

describe('validateDefinition', () => {
  it('accepts the expense example and gives every entity and field a stable ID', () => {
    const definition = expense();
    const claim = definition.entities['expense_claim']!;
    expect(claim.id).toBe('id0001');
    expect(claim.fields.map((field) => field.id)).toEqual(['id0002', 'id0003', 'id0004', 'id0005', 'id0006', 'id0007', 'id0008']);
    expect(definition.entities['expense_line']!.id).toBe('id0009');
    expect(definition.actions['submit_claim']).toMatchObject({ confirm: 'review', set: { status: 'submitted' } });
  });

  it('keeps IDs across saves by name, and recognizes renames by ID', () => {
    const first = expense();
    const input = clone(first) as unknown as { entities: Record<string, { id?: string; fields: Array<{ id?: string; name: string }> }> };
    // A client that drops IDs still keeps them, matched by name...
    const resaved = valid(JSON.parse(JSON.stringify(EXPENSE_APP)), first);
    expect(resaved.entities['expense_claim']!.fields.map((f) => f.id)).toEqual(first.entities['expense_claim']!.fields.map((f) => f.id));
    // ...and a field that keeps its ID under a new name is a rename.
    const claim = input.entities['expense_claim']!;
    claim.fields.find((f) => f.name === 'trip')!.name = 'journey';
    const result = validateDefinition(input, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const journey = result.definition.entities['expense_claim']!.fields.find((f) => f.name === 'journey')!;
    expect(journey.id).toBe(first.entities['expense_claim']!.fields.find((f) => f.name === 'trip')!.id);
    // The rename reaches every reference: the action's input, the review card and the form.
    expect(result.definition.actions['submit_claim']!.input).toContain('journey');
    expect(result.definition.cards['claim_review']!.show).toContain('journey');
    expect(result.definition.forms['claim_form']!.sections[0]!.fields.map((f) => f.field)).toContain('journey');
    expect(result.notes).toEqual(['Updated references for the rename expense_claim.trip → journey']);
  });

  it('carries an entity rename into conditions, roles and references', () => {
    const first = expense();
    const input = clone(first) as any;
    input.entities.claim = input.entities.expense_claim;
    delete input.entities.expense_claim;
    input.entities.claim.fields.find((f: { name: string }) => f.name === 'status').name = 'state';
    const result = validateDefinition(input, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const { definition } = result;
    expect(definition.roles['approver']!.entities['claim']!.update).toEqual({ where: { eq: [{ ref: 'record.state' }, 'submitted'] }, fields: { include: ['state', 'approver'] } });
    expect(definition.actions['approve_claim']).toMatchObject({ entity: 'claim', set: { state: 'approved' } });
    expect(planMigration(first, definition, names).statements.every((s) => s.startsWith('comment on'))).toBe(true);
  });

  it('reports broken references with their paths', () => {
    const broken = clone(EXPENSE_APP) as any;
    broken.entities.expense_claim.fields.push({ name: 'project', label: 'Project', type: 'reference', entity: 'project' });
    broken.actions.submit_claim.input.push('nonexistent');
    broken.actions.submit_claim.card = 'missing_card';
    broken.queries.my_claims.sort = [{ field: 'nope', direction: 'asc' }];
    broken.roles.approver.entities.expense_claim.read.unmask = ['title'];
    broken.roles.requester.actions = ['submit_claim', 'reject_claim'];
    expect(issuesOf(broken)).toEqual([
      'entities.expense_claim.fields[7].entity: No entity named project',
      'actions.submit_claim.input: No field named nonexistent',
      'actions.submit_claim.card: No card named missing_card',
      'queries.my_claims.sort[0]: No field named nope',
      "roles.requester.actions: No action named reject_claim",
      "roles.approver.entities.expense_claim.read.unmask: title isn't classified as PII, so it is never masked",
    ]);
  });

  it('catches actions that could never succeed, and conditions with the wrong types', () => {
    const broken = clone(EXPENSE_APP) as any;
    broken.forms = {}; // the form would rightly complain too; this test is about the action
    broken.pages = {};
    delete broken.navigation;
    broken.actions.submit_claim.input = ['title', 'total'];
    broken.rules.hotel_cap.assert = { lte: [{ ref: 'record.category' }, 250] };
    broken.roles.requester.entities.expense_claim.read.where = { eq: [{ ref: 'record.total' }, 'lots'] };
    expect(issuesOf(broken)).toEqual([
      'rules.hotel_cap.assert: lte compares numbers, dates and times, and category is none of them',
      'actions.submit_claim.input: total is worked out from lines',
      'actions.submit_claim.input: lines needs at least one line, so the action must take it as input',
      'roles.requester.entities.expense_claim.read.where: total holds numbers, not strings',
    ]);
  });

  it('checks forms against their entity and action', () => {
    const broken = clone(EXPENSE_APP) as any;
    broken.forms.claim_form.sections[0].fields.push({ field: 'status' }, { field: 'title' }, { field: 'created_at' });
    expect(issuesOf(broken)).toEqual([
      "forms.claim_form.sections[0].fields[2]: status isn't an input of submit_claim: show it read-only, or add it to the action's inputs",
      'forms.claim_form.sections[0].fields[3]: title is on the form twice',
      'forms.claim_form.sections[0].fields[4]: created_at is set by the platform: show it read-only',
    ]);
  });

  it('keeps line entities part of their records', () => {
    const broken = clone(EXPENSE_APP) as any;
    broken.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'total').rollup = { sum: 'lines.merchant' };
    broken.entities.expense_claim.fields.push({ name: 'more_lines', label: 'More', type: 'lines', entity: 'expense_line' });
    broken.entities.expense_line.fields.push({ name: 'code', label: 'Code', type: 'text', unique: true });
    broken.entities.other = { label: 'Other', fields: [{ name: 'line', label: 'Line', type: 'reference', entity: 'expense_line' }] };
    broken.rules.cap = { entity: 'expense_claim', assert: { gt: [{ ref: 'record.lines' }, 0] }, message: 'Too many' };
    broken.queries.lines_query = { label: 'Lines', description: 'Every line', entity: 'expense_line', fields: ['amount'] };
    broken.cards.claim_review.table.columns.push('colour');
    expect(issuesOf(broken)).toEqual([
      "entities.expense_claim.fields[3].rollup: merchant isn't a number field of lines",
      'entities.expense_claim.fields[7].entity: expense_line is already the lines of expense_claim.lines',
      "entities.expense_line.fields[5].unique: Fields of lines can't be unique yet",
      'entities.other.fields[0].entity: expense_line is lines of another entity, so nothing else can refer to its lines',
      "rules.cap.assert: record.lines: conditions can't test lines one by one. Add a rollup, such as a total, and test that",
      'queries.lines_query.entity: expense_line is the lines of expense_claim.lines, so it has no records of its own: use expense_claim',
      'cards.claim_review.table.columns: lines has no field named colour',
    ]);
  });

  it('lets roles name the fields of lines, but not write a rollup', () => {
    const broken = clone(EXPENSE_APP) as any;
    broken.roles.approver.entities.expense_claim.read.fields = { include: ['title', 'total', 'lines.amount', 'lines.colour'] };
    broken.roles.approver.entities.expense_claim.update.fields = { include: ['status', 'total'] };
    expect(issuesOf(broken)).toEqual([
      'roles.approver.entities.expense_claim.read.fields: No field named lines.colour',
      'roles.approver.entities.expense_claim.update.fields: total is worked out from lines',
    ]);
  });

  it('carries renames into lines: rollups, card tables, rules and role paths', () => {
    const base = clone(EXPENSE_APP) as any;
    base.roles.approver.entities.expense_claim.read.fields = { include: ['title', 'total', 'lines.amount'] };
    const first = valid(base);
    const input = clone(first) as any;
    input.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'lines').name = 'receipts';
    input.entities.expense_line.fields.find((f: { name: string }) => f.name === 'amount').name = 'value';
    input.entities.receipt = input.entities.expense_line;
    delete input.entities.expense_line;
    const result = validateDefinition(input, first, ids());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const { definition } = result;
    const claim = definition.entities['expense_claim']!;
    expect(claim.fields.find((f) => f.name === 'receipts')).toMatchObject({ type: 'lines', entity: 'receipt' });
    expect(claim.fields.find((f) => f.name === 'total')).toMatchObject({ rollup: { sum: 'receipts.value' } });
    expect(definition.cards['claim_review']!.table).toEqual({ of: 'receipts', columns: ['date', 'merchant', 'category', 'value', 'receipt'] });
    expect(definition.rules['hotel_cap']).toMatchObject({ entity: 'receipt', assert: { lte: [{ ref: 'record.value' }, 250] } });
    expect(definition.actions['submit_claim']!.input).toContain('receipts');
    expect(definition.roles['approver']!.entities['expense_claim']!.read).toMatchObject({ fields: { include: ['title', 'total', 'receipts.value'] } });
    expect(planMigration(first, definition, names).statements.every((s) => s.startsWith('comment on'))).toBe(true);
  });

  it('rejects malformed definitions with schema errors', () => {
    expect(issuesOf({ entities: { 'Bad Name': { label: 'X', fields: [] } } })[0]).toMatch(/^entities\.Bad Name/);
    expect(issuesOf({ entities: { a: { label: 'A', fields: [{ name: 'id', label: 'ID', type: 'text' }] } } })).toEqual([
      'entities.a.fields[0].name: id is a system field',
    ]);
    expect(issuesOf({ entities: { a: { label: 'A', fields: [], colour: 'red' } } })[0]).toMatch(/colour/);
  });
});

describe('checkInput', () => {
  const taxi = { date: '2026-11-02', merchant: 'Comfort', category: 'travel', amount: 32.4 };

  it('returns canonical values, fills in defaults and enforces required fields', () => {
    const { values, lines, issues } = checkInput(expense(), 'expense_claim', { title: 'Taxi', trip: '', lines: [taxi] }, { mode: 'create' });
    expect(issues).toEqual([]);
    expect(values).toEqual({ title: 'Taxi', trip: null, status: 'draft' });
    expect(lines).toEqual({ lines: [{ values: taxi }] });
    expect(checkInput(expense(), 'expense_claim', { trip: 'Singapore' }, { mode: 'create' }).issues.map((i) => `${i.field}:${i.code}`)).toEqual(['title:required']);
  });

  it('checks every value against its field, in lines too', () => {
    const { issues } = checkInput(
      expense(),
      'expense_claim',
      {
        title: 'x'.repeat(201),
        approver: 'not-an-id',
        colour: 'red',
        created_by: 'me',
        total: 5,
        lines: [{ category: 'yacht', amount: 10.005, colour: 1 }, 'nope', { id: 'bad' }, { id: '0193A7C4-0000-7000-8000-000000000001' }, { id: '0193a7c4-0000-7000-8000-000000000001' }],
      },
      { mode: 'update' },
    );
    expect(issues.map((issue) => `${issue.field}:${issue.code}`)).toEqual([
      'title:too_long',
      'approver:invalid_uuid',
      'colour:unknown_field',
      'created_by:not_writable',
      'total:not_writable',
      'lines[0].category:invalid_option',
      'lines[0].amount:too_precise',
      'lines[0].colour:unknown_field',
      'lines[1]:invalid_type',
      'lines[2].id:invalid_uuid',
      'lines[4].id:invalid_type',
    ]);
    const tooMany = checkInput(expense(), 'expense_claim', { lines: Array.from({ length: 51 }, () => taxi) }, { mode: 'update' });
    expect(tooMany.issues).toMatchObject([{ field: 'lines', code: 'too_big' }]);
    expect(tooMany.lines['lines']).toHaveLength(50);
  });

  it('refuses to empty a required field on update, and lets actions fix values', () => {
    expect(checkInput(expense(), 'expense_claim', { title: null }, { mode: 'update' }).issues).toMatchObject([{ field: 'title', code: 'required' }]);
    const action = checkActionInput(expense(), 'submit_claim', { title: 'Hotel', lines: [taxi], status: 'approved' });
    expect(action.issues).toMatchObject([{ field: 'status', code: 'not_writable' }]);
    expect(action.values).toMatchObject({ status: 'submitted' });
  });
});

describe('lines', () => {
  const definition = expense();
  const lineEntity = definition.entities['expense_line']!;
  const field = definition.entities['expense_claim']!.fields.find((f): f is StoredLinesField => f.type === 'lines')!;
  const grab = { id: 'line-1', values: { date: '2026-11-01', merchant: 'Grab', category: 'travel', amount: 12 } };

  it('completes the lines a caller sends against the lines a record has', () => {
    const hotel = { date: '2026-11-02', merchant: 'Hilton', category: 'hotel', amount: 300 };
    expect(completeLines(lineEntity, field, [{ id: 'line-1', values: { amount: 15 } }, { values: hotel }], [grab])).toEqual({
      lines: [{ id: 'line-1', values: { ...grab.values, amount: 15, receipt: null } }, { id: null, values: { ...hotel, receipt: null } }],
      issues: [],
    });
    expect(completeLines(lineEntity, field, [{ id: 'line-9', values: {} }], [grab]).issues).toMatchObject([{ field: 'lines[0].id', code: 'invalid_uuid' }]);
    expect(completeLines(lineEntity, field, [{ values: { merchant: 'Shop' } }], []).issues.map((i) => i.field)).toEqual(['lines[0].date', 'lines[0].category', 'lines[0].amount']);
    expect(completeLines(lineEntity, field, [], [grab]).issues).toMatchObject([{ field: 'lines', code: 'required' }]);
  });

  it('works out rollups exactly', () => {
    const lines = (...amounts: Array<number | null>) => ({ lines: amounts.map((amount) => ({ id: null, values: { amount } })) });
    expect(rollupValues(definition, 'expense_claim', lines(0.1, 0.2))).toEqual({ values: { total: 0.3 }, issues: [] });
    expect(rollupValues(definition, 'expense_claim', lines(19.99, 0.01, null, 1234.56)).values).toEqual({ total: 1254.56 });
    expect(rollupValues(definition, 'expense_claim', lines()).values).toEqual({ total: 0 });
    expect(rollupValues(definition, 'expense_claim', {}).values).toEqual({});

    const counted = clone(EXPENSE_APP) as any;
    counted.entities.expense_claim.fields.push(
      { name: 'receipts', label: 'Receipts', type: 'number', rollup: { count: 'lines' } },
      { name: 'biggest', label: 'Biggest', type: 'number', decimals: 2, max: 1000, rollup: { max: 'lines.amount' } },
    );
    const other = valid(counted);
    expect(rollupValues(other, 'expense_claim', lines(5, 7.5)).values).toEqual({ total: 12.5, receipts: 2, biggest: 7.5 });
    expect(rollupValues(other, 'expense_claim', lines()).values).toEqual({ total: 0, receipts: 0, biggest: null });
    expect(rollupValues(other, 'expense_claim', lines(2000)).issues).toMatchObject([{ field: 'biggest', code: 'too_big', message: 'Biggest: At most 1000' }]);
  });

  it('records what changed between two versions of the lines', () => {
    const [date, merchant, category, amount, receipt] = lineEntity.fields.map((f) => f.id);
    const taxi = { id: 'line-2', values: { date: '2026-11-03', merchant: 'Taxi', category: 'travel', amount: 20 } };
    const meal = { id: 'line-3', values: { date: '2026-11-03', merchant: 'Lau Pa Sat', category: 'meals', amount: 18 } };
    const change = diffLines(lineEntity, [grab, taxi], [{ ...taxi, values: { ...taxi.values, amount: 22 } }, meal], { '0.amount': { source: 'person' }, '1.amount': { source: 'document' } });
    expect(change).toEqual({
      added: [{ id: 'line-3', values: { [date!]: '2026-11-03', [merchant!]: 'Lau Pa Sat', [category!]: 'meals', [amount!]: 18, [receipt!]: null }, sources: { [amount!]: { source: 'document' } } }],
      removed: [{ id: 'line-1', values: { [date!]: '2026-11-01', [merchant!]: 'Grab', [category!]: 'travel', [amount!]: 12, [receipt!]: null } }],
      changed: [{ id: 'line-2', changes: { [amount!]: { before: 20, after: 22, source: { source: 'person' } } } }],
      reordered: false,
    });
    expect(diffLines(lineEntity, [grab, taxi], [taxi, grab])).toMatchObject({ added: [], removed: [], changed: [], reordered: true });
    expect(diffLines(lineEntity, [grab], [grab])).toBeNull();
  });

  it('writes only what differs, in order', () => {
    const taxi = { id: '0193a7c4-0000-7000-8000-000000000002', values: { date: '2026-11-03', merchant: 'Taxi', category: 'travel', amount: 20 } };
    const first = { ...grab, id: '0193a7c4-0000-7000-8000-000000000001' };
    const statements = writeLines(names, lineEntity, '0193a7c4-0000-7000-8000-0000000000aa', [first, taxi], [taxi, { ...first, values: { ...first.values, amount: 13 } }]);
    expect(statements.map((s) => s.text.split(' ')[0])).toEqual(['update', 'update']);
    expect(statements[0]!.values).toEqual([0, taxi.id, '0193a7c4-0000-7000-8000-0000000000aa']);
    expect(writeLines(names, lineEntity, 'p', [first], []).map((s) => s.text.split(' ')[0])).toEqual(['delete']);
    expect(writeLines(names, lineEntity, 'p', [first], [first])).toEqual([]);
  });
});

describe('planMigration', () => {
  it('creates the tables, columns and indexes of a new app', () => {
    const plan = planMigration(undefined, expense(), names);
    expect(plan.steps.map((s) => s.description)).toEqual(['Create expense_claim', 'Create expense_line, the lines of expense_claim.lines']);
    expect(plan.destructive).toBe(false);
    // The environment's file tables come first: file columns refer to them.
    expect(plan.statements[0]).toMatch(/^create table if not exists "app_\w+_sandbox"\.files /);
    const claimTable = plan.statements.findIndex((s) => s.startsWith(`create table "${names.schema}"."e_id0001" (id uuid primary key`));
    expect(claimTable).toBeGreaterThan(0);
    expect(plan.statements).toContain(`alter table "${names.schema}"."e_id0009" add column "f_id0014" uuid references "${names.schema}".files (id) on delete restrict`);
    expect(plan.statements).toContain(`grant select, insert, update, delete on "${names.schema}"."e_id0001" to "${names.role}"`);
    expect(plan.statements).toContain(`alter table "${names.schema}"."e_id0001" add column "f_id0005" numeric`);
    expect(plan.statements).toContain(`comment on column "${names.schema}"."e_id0001"."f_id0005" is 'total'`);
    // Lines get their own table, after their record's, and go with it.
    const lineTable = plan.statements.findIndex((s) => s.startsWith(`create table "${names.schema}"."e_id0009"`));
    expect(lineTable).toBeGreaterThan(claimTable);
    expect(plan.statements[lineTable]).toBe(
      `create table "${names.schema}"."e_id0009" (id uuid primary key, parent_id uuid not null references "${names.schema}"."e_id0001" (id) on delete cascade, position integer not null)`,
    );
    expect(plan.statements).toContain(`alter table "${names.schema}"."e_id0009" add column "f_id0013" numeric`);
  });

  it('remakes an entity that becomes lines, and works out a new rollup for existing records', () => {
    const first = valid({
      entities: {
        claim: { label: 'Claim', fields: [{ name: 'title', label: 'Title', type: 'text' }] },
        line: { label: 'Line', fields: [{ name: 'amount', label: 'Amount', type: 'number', decimals: 2 }] },
      },
    });
    const next = clone(first) as any;
    next.entities.claim.fields.push(
      { name: 'lines', label: 'Lines', type: 'lines', entity: 'line' },
      { name: 'total', label: 'Total', type: 'number', decimals: 2, rollup: { sum: 'lines.amount' } },
    );
    const plan = planMigration(first, valid(next, first), names);
    expect(plan.steps.map((s) => `${s.kind}${s.destructive ? '!' : ''}`)).toEqual(['add_field', 'add_field', 'reshape_entity!', 'compute_field']);
    expect(plan.steps[2]!.description).toBe('Make line the lines of claim.lines, which deletes its records');
    expect(plan.statements[0]).toBe(`drop table "${names.schema}"."e_id0003"`);
    // The line table is new, so the total is worked out for existing claims: zero, with no lines yet.
    const withTotal = valid(next, first);
    const later = clone(withTotal) as any;
    later.entities.claim.fields.find((f: { name: string }) => f.name === 'total').rollup = { max: 'lines.amount' };
    const recompute = planMigration(withTotal, valid(later, withTotal), names);
    expect(recompute.steps.map((s) => s.kind)).toEqual(['compute_field']);
    const totalId = withTotal.entities['claim']!.fields.find((f) => f.name === 'total')!.id;
    expect(recompute.statements).toEqual([
      `update "${names.schema}"."e_id0001" as r set "f_${totalId}" = (select max(l."f_id0004") from "${names.schema}"."e_id0003" l where l.parent_id = r.id)`,
    ]);
    // Removing the lines field and its entity deletes the lines, and says so once.
    const gone = clone(withTotal) as any;
    gone.entities.claim.fields = gone.entities.claim.fields.filter((f: { name: string }) => f.name === 'title');
    delete gone.entities.line;
    const dropped = planMigration(withTotal, valid(gone, withTotal), names);
    expect(dropped.steps.map((s) => `${s.kind}${s.destructive ? '!' : ''}`)).toEqual(['drop_field', 'drop_field!', 'drop_entity!']);
  });

  it('renames without touching data, and flags what deletes data', () => {
    const first = expense();
    const next = clone(first) as any;
    const fields = next.entities.expense_claim.fields as Array<{ name: string; type: string; unique?: boolean }>;
    fields.find((f) => f.name === 'trip')!.name = 'journey';
    next.entities.expense_claim.fields = fields.filter((f) => f.name !== 'approver');
    next.actions.approve_claim.steps = next.actions.approve_claim.steps.filter((step: { field?: string }) => step.field !== 'approver');
    next.roles.approver.entities.expense_claim.update.fields = { include: ['status'] };
    const iban = fields.find((f) => f.name === 'iban')!;
    iban.unique = true;
    const title = fields.find((f) => f.name === 'title')! as any;
    Object.assign(title, { type: 'number', decimals: 0 });
    delete title.maxLength;
    delete title.multiline;
    const plan = planMigration(first, valid(next, first), names);
    expect(plan.steps.map((s) => `${s.kind}${s.destructive ? '!' : ''}`)).toEqual([
      'drop_field!',
      'retype_field!',
      'rename_field',
      'add_unique',
    ]);
    expect(plan.destructive).toBe(true);
    expect(plan.statements.some((s) => s.includes('rename'))).toBe(false);
    expect(plan.impact.map((i) => i.step)).toEqual([0, 1, 3]);
  });

  it('drops entities together, after their references', () => {
    const first = valid({
      entities: {
        project: { label: 'Project', fields: [{ name: 'name', label: 'Name', type: 'text' }] },
        task: { label: 'Task', fields: [{ name: 'project', label: 'Project', type: 'reference', entity: 'project' }] },
      },
    });
    const plan = planMigration(first, valid({ entities: {} }, first), names);
    expect(plan.steps.map((s) => s.kind)).toEqual(['drop_entity', 'drop_entity']);
    expect(plan.statements).toEqual([`drop table "${names.schema}"."e_id0001", "${names.schema}"."e_id0003"`]);
  });
});

describe('compileAppPolicy', () => {
  const appId = '0193a7c4-0000-7000-8000-00000000abcd';
  const definition = expense();
  const app = compileAppPolicy(appId, definition);
  const policy = createPolicy(app);
  const env = { type: 'env', id: 'env1' } as const;
  const bindingFor = (role: string): Binding => ({ id: `b-${role}`, principalType: 'user', principalId: 'u1', roleId: `app:${appId}:${role}`, scope: env });
  const record = (selector: string) => ({ type: 'record', selector, scopes: [env] });
  const principal = { type: 'user' as const, id: 'u1', groupIds: [] };

  it('turns roles into grants with record filters and PII masks', () => {
    const approver = app.permissionSets.find((set) => set.id === `app:${appId}:approver`)!;
    expect(approver.grants).toEqual([
      { permission: 'app.run' },
      { permission: 'action.run', resource: 'approve_claim' },
      { permission: 'record.read', resource: 'expense_claim', condition: { in: [{ ref: 'record.status' }, ['submitted', 'approved']] }, mask: ['iban'] },
      { permission: 'record.update', resource: 'expense_claim', condition: { eq: [{ ref: 'record.status' }, 'submitted'] }, fields: { include: ['status', 'approver'] } },
    ]);
  });

  it('lets the policy engine fill in the person and hand back a record filter', () => {
    const decision = authorizeQuery(policy, { principal, action: 'record.read', resource: record('expense_claim'), bindings: [bindingFor('requester')] });
    expect(decision).toMatchObject({ allowed: true, grants: [{ filter: { eq: [{ ref: 'record.owner' }, 'u1'] } }] });
    const outsider = authorizeQuery(policy, { principal, action: 'record.delete', resource: record('expense_claim'), bindings: [bindingFor('requester')] });
    expect(outsider.allowed).toBe(false);
  });

  it('decides field access and writes per grant', () => {
    const [requester, approver] = [app.permissionSets[0]!.grants, app.permissionSets[1]!.grants];
    const read = (grants: typeof requester) => grants.filter((g) => g.permission === 'record.read');
    expect(fieldAccess(read(requester), 'iban')).toBe('full');
    expect(fieldAccess(read(approver), 'iban')).toBe('masked');
    expect(fieldAccess([...read(approver), ...read(requester)], 'iban')).toBe('full');

    const decision = authorizeQuery(policy, { principal, action: 'record.update', resource: record('expense_claim'), bindings: [bindingFor('approver')] });
    if (!decision.allowed) throw new Error('expected an update grant');
    const before = { status: 'submitted', total: 300 };
    expect(writeGrant(decision.grants, { fields: ['status'], before, after: { ...before, status: 'approved' } })).toBeDefined();
    expect(writeGrant(decision.grants, { fields: ['lines', 'lines.amount'], before, after: before })).toBeUndefined();
    expect(writeGrant(decision.grants, { fields: ['status'], before: { status: 'draft' }, after: { status: 'approved' } })).toBeUndefined();
  });
});

describe('access to lines', () => {
  const grant = (fields?: { include: string[] } | { exclude: string[] }, mask?: string[]) => ({ permission: 'record.read', ...(fields ? { fields } : {}), ...(mask ? { mask } : {}) });

  it('covers a field of lines only with its lines field', () => {
    expect(covers(grant({ include: ['lines'] }), 'lines.amount')).toBe(true);
    expect(covers(grant({ include: ['lines.amount'] }), 'lines')).toBe(true);
    expect(covers(grant({ include: ['lines.amount'] }), 'lines.amount')).toBe(true);
    expect(covers(grant({ include: ['lines.amount'] }), 'lines.date')).toBe(false);
    expect(covers(grant({ include: ['title'] }), 'lines.amount')).toBe(false);
    expect(covers(grant({ exclude: ['lines'] }), 'lines.amount')).toBe(false);
    expect(covers(grant({ exclude: ['lines.amount'] }), 'lines')).toBe(true);
    expect(covers(grant({ exclude: ['lines.amount'] }), 'lines.amount')).toBe(false);
  });

  it('masks PII in lines unless a role unmasks it, and masks every field of masked lines', () => {
    const app = clone(EXPENSE_APP) as any;
    app.entities.expense_line.fields.push({ name: 'card', label: 'Card number', type: 'text', classification: 'pii' });
    app.roles.requester.entities.expense_claim.read.unmask = ['iban', 'lines.card'];
    const { permissionSets } = compileAppPolicy('0193a7c4-0000-7000-8000-00000000abcd', valid(app));
    const read = (set: number) => permissionSets[set]!.grants.filter((g) => g.permission === 'record.read');
    expect(read(1)[0]!.mask).toEqual(['lines.card', 'iban']);
    expect(read(0)[0]!.mask).toBeUndefined();
    expect(fieldAccess(read(1), 'lines.card')).toBe('masked');
    expect(fieldAccess(read(1), 'lines.amount')).toBe('full');
    expect(fieldAccess([grant(undefined, ['lines'])], 'lines.amount')).toBe('masked');
  });
});

describe('rules and review cards', () => {
  const definition = expense();
  const values = { title: 'Singapore trip', trip: 'Singapore', total: 302.4, status: 'submitted', iban: 'SG12 3456', approver: null };
  const lines = {
    lines: [
      { id: null, values: { date: '2026-11-02', merchant: 'Comfort', category: 'travel', amount: 32.4 } },
      { id: null, values: { date: '2026-11-02', merchant: 'Marina Bay', category: 'hotel', amount: 270 } },
    ],
  };

  it('checks each line, and says which line a finding is about, errors first', () => {
    expect(evaluateRules(definition, 'expense_claim', values, { principal: {} }, lines)).toEqual([
      { rule: 'hotel_cap', severity: 'warning', message: 'Hotel is above the SGD 250 nightly cap', fields: ['lines[1].amount'], line: { field: 'lines', index: 1 } },
    ]);
    const zero = { lines: [lines.lines[1]!, { id: null, values: { ...lines.lines[0]!.values, amount: 0 } }] };
    expect(evaluateRules(definition, 'expense_claim', values, { principal: {} }, zero).map((f) => `${f.rule}@${f.line?.index}`)).toEqual(['positive_amount@1', 'hotel_cap@0']);
  });

  it('builds a card from the exact values, findings first, with the lines as a table and every source', () => {
    const card = buildCard({
      definition,
      entity: 'expense_claim',
      card: 'claim_review',
      values,
      lines,
      findings: evaluateRules(definition, 'expense_claim', values, { principal: {} }, lines),
      provenance: { trip: { source: 'agent', note: 'From the calendar' }, 'lines[1].amount': { source: 'document', document: 'receipt.jpg' } },
    });
    expect(card.title).toBe('Singapore trip: SGD 302.40');
    expect(card.findings).toHaveLength(1);
    expect(card.fields.map((f) => [f.name, f.display, f.source?.source ?? null])).toEqual([
      ['trip', 'Singapore', 'agent'],
      ['total', '302.40', null],
      ['iban', 'SG12 3456', null],
    ]);
    const [table] = card.tables!;
    expect(table!.columns.map((c) => c.label)).toEqual(['Date', 'Merchant', 'Category', 'Amount (SGD)', 'Receipt']);
    expect(table!.rows.map((row) => row.cells.map((cell) => cell.display))).toEqual([
      ['2026-11-02', 'Comfort', 'Travel', '32.40', '—'],
      ['2026-11-02', 'Marina Bay', 'Hotel', '270.00', '—'],
    ]);
    expect(table!.rows[1]!.cells[3]!.source).toEqual({ source: 'document', document: 'receipt.jpg' });
  });
});
