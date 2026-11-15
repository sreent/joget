import { authorizeQuery, createPolicy, type Binding } from '@platform/authz';
import { describe, expect, it } from 'vitest';
import {
  buildCard,
  checkActionInput,
  checkInput,
  compileAppPolicy,
  environmentNames,
  evaluateRules,
  EXPENSE_APP,
  fieldAccess,
  planMigration,
  validateDefinition,
  writeGrant,
  type StoredDefinition,
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
    // The rename reaches every reference: the action's input and the review card.
    expect(result.definition.actions['submit_claim']!.input).toContain('journey');
    expect(result.definition.cards['claim_review']!.show).toContain('journey');
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
    expect(definition.roles['approver']!.entities['claim']!.update).toEqual({ where: { eq: [{ ref: 'record.state' }, 'submitted'] }, fields: { include: ['state'] } });
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
    broken.actions.submit_claim.input = ['title', 'category'];
    broken.rules.hotel_cap.assert = { lte: [{ ref: 'record.category' }, 250] };
    broken.roles.requester.entities.expense_claim.read.where = { eq: [{ ref: 'record.amount' }, 'lots'] };
    expect(issuesOf(broken)).toEqual([
      "rules.hotel_cap.assert: lte compares numbers, and category isn't one",
      'actions.submit_claim.input: amount is required, so the action must take it as input, set it, or the field needs a default',
      'roles.requester.entities.expense_claim.read.where: amount holds numbers, not strings',
    ]);
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
  const claim = () => expense().entities['expense_claim']!;

  it('returns canonical values, fills in defaults and enforces required fields', () => {
    const { values, issues } = checkInput(claim(), { title: 'Taxi', category: 'travel', amount: 32.4, trip: '' }, { mode: 'create' });
    expect(issues).toEqual([]);
    expect(values).toEqual({ title: 'Taxi', category: 'travel', amount: 32.4, trip: null, status: 'draft' });
    expect(checkInput(claim(), { title: 'Taxi' }, { mode: 'create' }).issues.map((i) => `${i.field}:${i.code}`)).toEqual([
      'category:required',
      'amount:required',
    ]);
  });

  it('checks every value against its field', () => {
    const { issues } = checkInput(
      claim(),
      { title: 'x'.repeat(201), category: 'yacht', amount: 10.005, approver: 'not-an-id', colour: 'red', created_by: 'me' },
      { mode: 'update' },
    );
    expect(issues.map((issue) => `${issue.field}:${issue.code}`)).toEqual([
      'title:too_long',
      'category:invalid_option',
      'amount:too_precise',
      'approver:invalid_uuid',
      'colour:unknown_field',
      'created_by:not_writable',
    ]);
  });

  it('refuses to empty a required field on update, and lets actions fix values', () => {
    expect(checkInput(claim(), { amount: null }, { mode: 'update' }).issues).toMatchObject([{ field: 'amount', code: 'required' }]);
    const action = checkActionInput(expense(), 'submit_claim', { title: 'Hotel', category: 'hotel', amount: 300, status: 'approved' });
    expect(action.issues).toMatchObject([{ field: 'status', code: 'not_writable' }]);
    expect(action.values).toMatchObject({ status: 'submitted' });
  });
});

describe('planMigration', () => {
  it('creates the tables, columns and indexes of a new app', () => {
    const plan = planMigration(undefined, expense(), names);
    expect(plan.steps.map((s) => s.kind)).toEqual(['create_entity']);
    expect(plan.destructive).toBe(false);
    expect(plan.statements[0]).toMatch(/^create table "app_\w+_sandbox"\."e_id0001" \(id uuid primary key/);
    expect(plan.statements).toContain(`grant select, insert, update, delete on "${names.schema}"."e_id0001" to "${names.role}"`);
    expect(plan.statements).toContain(`alter table "${names.schema}"."e_id0001" add column "f_id0005" numeric`);
    expect(plan.statements).toContain(`comment on column "${names.schema}"."e_id0001"."f_id0005" is 'amount'`);
  });

  it('renames without touching data, and flags what deletes data', () => {
    const first = expense();
    const next = clone(first) as any;
    const fields = next.entities.expense_claim.fields as Array<{ name: string; type: string; unique?: boolean }>;
    fields.find((f) => f.name === 'trip')!.name = 'journey';
    next.entities.expense_claim.fields = fields.filter((f) => f.name !== 'approver');
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
      { permission: 'record.update', resource: 'expense_claim', condition: { eq: [{ ref: 'record.status' }, 'submitted'] }, fields: { include: ['status'] } },
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
    const before = { status: 'submitted', amount: 300 };
    expect(writeGrant(decision.grants, { fields: ['status'], before, after: { ...before, status: 'approved' } })).toBeDefined();
    expect(writeGrant(decision.grants, { fields: ['amount'], before, after: { ...before, amount: 1 } })).toBeUndefined();
    expect(writeGrant(decision.grants, { fields: ['status'], before: { status: 'draft' }, after: { status: 'approved' } })).toBeUndefined();
  });
});

describe('rules and review cards', () => {
  const definition = expense();
  const values = { title: 'Marina Bay hotel', trip: 'Singapore', category: 'hotel', amount: 270, status: 'submitted', iban: 'SG12 3456', approver: null };

  it('returns errors before warnings', () => {
    expect(evaluateRules(definition, 'expense_claim', values, { principal: {} })).toEqual([
      { rule: 'hotel_cap', severity: 'warning', message: 'Hotel is above the SGD 250 nightly cap', fields: ['amount'] },
    ]);
    expect(evaluateRules(definition, 'expense_claim', { ...values, amount: 0 }, { principal: {} }).map((f) => f.rule)).toEqual(['positive_amount']);
  });

  it('builds a card from the exact values, findings first, with sources', () => {
    const card = buildCard({
      definition,
      entity: 'expense_claim',
      card: 'claim_review',
      values,
      findings: evaluateRules(definition, 'expense_claim', values, { principal: {} }),
      provenance: { amount: { source: 'document', document: 'receipt.jpg' }, trip: { source: 'agent', note: 'From the calendar' } },
    });
    expect(card.title).toBe('Marina Bay hotel: SGD 270.00');
    expect(card.findings).toHaveLength(1);
    expect(card.fields.map((f) => [f.name, f.display, f.source?.source ?? null])).toEqual([
      ['trip', 'Singapore', 'agent'],
      ['category', 'Hotel', null],
      ['amount', '270.00', 'document'],
      ['iban', 'SG12 3456', null],
    ]);
  });
});
