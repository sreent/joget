import { describe, expect, it } from 'vitest';
import { EXPENSE_APP } from '@platform/app-model';
import type { Definition } from '../types.js';
import { normalize, removeEntity, removeField, removeForm } from './edit.js';
import { removeItem, renameItem } from './logic.js';
import {
  addBlock,
  addPage,
  changeListEntity,
  defaultMenu,
  describeBlock,
  groupPaths,
  moveBlock,
  moveNavItem,
  numberPaths,
  removeBlock,
  removePage,
  renamePage,
  rowActions,
  setCustomMenu,
  setHome,
  updatePage,
} from './pages.js';

const app = () => normalize(structuredClone(EXPENSE_APP) as unknown as Definition);

describe('editing pages', () => {
  it('adds a page that lists the first entity, newest first', () => {
    const { definition, name } = addPage(app(), 'Recent claims');
    expect(name).toBe('recent_claims');
    expect(definition.pages[name]).toEqual({
      label: 'Recent claims',
      blocks: [{ type: 'list', entity: 'expense_claim', columns: ['title', 'trip', 'total', 'created_at'], sort: [{ field: 'created_at', direction: 'desc' }], limit: 20, actions: [] }],
    });
    expect(describeBlock(definition, definition.pages[name]!.blocks[0]!)).toBe('Expense claims: Title, Trip, Total (SGD), Created');
  });

  it('adds, moves and removes blocks, and keeps at least one', () => {
    let { definition } = addBlock(app(), 'to_approve', 'buttons');
    expect(definition.pages['to_approve']!.blocks.map((b) => b.type)).toEqual(['text', 'list', 'buttons']);
    definition = moveBlock(definition, 'to_approve', 2, 0);
    expect(definition.pages['to_approve']!.blocks.map((b) => b.type)).toEqual(['buttons', 'text', 'list']);
    definition = removeBlock(removeBlock(definition, 'to_approve', 0), 'to_approve', 0);
    expect(definition.pages['to_approve']!.blocks.map((b) => b.type)).toEqual(['list']);
    expect(removeBlock(definition, 'to_approve', 0)).toBe(definition);
  });

  it('starts a list afresh when it shows another entity, and offers only one-click update actions on rows', () => {
    const definition = changeListEntity(app(), 'to_approve', 1, 'expense_claim');
    expect(definition.pages['to_approve']!.blocks[1]).toMatchObject({ entity: 'expense_claim', title: 'Submitted claims', actions: [] });
    expect(definition.pages['to_approve']!.blocks[1]).not.toHaveProperty('filter');
    expect(rowActions(app(), 'expense_claim')).toEqual(['approve_claim']);
  });

  it('renames and removes pages, with the buttons and menu items that open them', () => {
    let definition = renamePage(app(), 'my_claims', 'claims');
    expect(definition.navigation).toMatchObject({
      home: 'claims',
      items: [{ page: 'claims' }, { form: 'claim_form' }, { entity: 'expense_claim', label: 'All claims' }, { page: 'spending' }, { heading: 'Approvals' }, { page: 'to_approve' }],
    });
    definition = removePage(definition, 'to_approve');
    expect(definition.navigation!.items.map((item) => ('page' in item ? item.page : 'heading' in item ? item.heading : 'x'))).toEqual(['claims', 'x', 'x', 'spending', 'Approvals']);
    definition = updatePage(definition, 'claims', { description: '', roles: [] });
    expect(definition.pages['claims']).not.toHaveProperty('description');
  });

  it('tidies pages and the menu when what they name goes away', () => {
    let definition = removeField(app(), 'expense_claim', app().entities['expense_claim']!.fields.findIndex((f) => f.name === 'total'));
    expect((definition.pages['my_claims']!.blocks[1] as { columns: string[] }).columns).toEqual(['title', 'status', 'created_at']);
    definition = removeForm(definition, 'claim_form');
    expect(definition.pages['my_claims']!.blocks.map((b) => b.type)).toEqual(['list']);
    expect(definition.navigation!.items.some((item) => 'form' in item)).toBe(false);
    definition = renameItem(definition, 'actions', 'approve_claim', 'approve');
    expect((definition.pages['to_approve']!.blocks[1] as { actions: string[] }).actions).toEqual(['approve']);
    definition = removeItem(definition, 'actions', 'approve');
    expect((definition.pages['to_approve']!.blocks[1] as { actions: string[] }).actions).toEqual([]);
    definition = removeItem(definition, 'roles', 'approver');
    expect(definition.pages['to_approve']).not.toHaveProperty('roles');
    definition = removeEntity(definition, 'expense_claim');
    expect(definition.pages['my_claims']!.blocks).toEqual([{ type: 'text', style: 'paragraph', text: 'This page is empty.' }]);
    expect(definition.navigation!.items).toEqual([{ page: 'my_claims' }, { page: 'spending' }, { heading: 'Approvals' }, { page: 'to_approve' }]);
    expect(definition.pages['spending']!.blocks).toEqual([{ type: 'text', style: 'paragraph', text: 'This page is empty.' }]);
    expect(describeBlock(definition, definition.pages['to_approve']!.blocks[0]!)).toBe('Check the receipts of each claim before you approve it.');
  });
});

describe('numbers and charts', () => {
  it('start from sensible defaults: a count, and a chart by the first choice', () => {
    let { definition, index } = addBlock(app(), 'spending', 'stat');
    expect(definition.pages['spending']!.blocks[index]).toEqual({ type: 'stat', label: 'How many expense claims', entity: 'expense_claim', measure: { op: 'count' } });
    ({ definition, index } = addBlock(definition, 'spending', 'chart'));
    expect(definition.pages['spending']!.blocks[index]).toMatchObject({ type: 'chart', title: 'Expense claims by status', group: { field: 'status' }, show: 'bar', width: 'half' });
    expect(describeBlock(definition, definition.pages['spending']!.blocks[4]!)).toBe('Spending by month (SGD): Sum of Receipts › Amount (SGD), by month of Receipts › Date');
    expect(describeBlock(definition, definition.pages['spending']!.blocks[2]!)).toBe('Receipts: Count of Receipts');
  });

  it('offer the fields they can total and group by, of the records and their lines', () => {
    expect(numberPaths(app(), 'expense_claim')).toEqual([
      { value: 'lines.amount', label: 'Receipts › Amount (SGD)' },
      { value: 'total', label: 'Total (SGD)' },
    ]);
    expect(groupPaths(app(), 'expense_claim').map((g) => g.value)).toEqual(['title', 'trip', 'lines.date', 'lines.merchant', 'lines.category', 'status', 'iban', 'approver', 'owner', 'created_at', 'updated_at']);
  });

  it('let go of a field that goes: a total counts instead, a chart by it goes, and so does a range on it', () => {
    const lineFields = app().entities['expense_line']!.fields;
    let definition = removeField(app(), 'expense_line', lineFields.findIndex((f) => f.name === 'amount'));
    expect(definition.pages['spending']!.blocks.filter((b) => b.type === 'chart').map((b) => (b as { measure: unknown }).measure)).toEqual([{ op: 'count' }, { op: 'count' }]);
    definition = removeField(definition, 'expense_line', definition.entities['expense_line']!.fields.findIndex((f) => f.name === 'date'));
    expect(definition.pages['spending']!.blocks.map((b) => b.type)).toEqual(['stat', 'stat', 'stat', 'chart']);
    definition = removeField(definition, 'expense_claim', definition.entities['expense_claim']!.fields.findIndex((f) => f.name === 'total'));
    expect(definition.pages['spending']!.blocks[1]).toMatchObject({ measure: { op: 'count' }, range: { field: 'created_at' } });
  });
});

describe('editing the menu', () => {
  it('starts a custom menu from every page, form and list, and goes back to the default', () => {
    const plain = normalize({ ...structuredClone(EXPENSE_APP), navigation: undefined } as unknown as Definition);
    expect(defaultMenu(plain)).toEqual({
      home: 'my_claims',
      items: [{ page: 'my_claims' }, { page: 'to_approve' }, { page: 'spending' }, { form: 'claim_form' }, { entity: 'expense_claim' }],
    });
    const custom = setCustomMenu(plain, true);
    expect(custom.navigation!.items).toHaveLength(5);
    expect(setCustomMenu(custom, false)).not.toHaveProperty('navigation');
  });

  it('moves items and sets the home page', () => {
    let definition = moveNavItem(app(), 2, 0);
    expect(definition.navigation!.items[0]).toEqual({ entity: 'expense_claim', label: 'All claims' });
    definition = setHome(definition, undefined);
    expect(definition.navigation).not.toHaveProperty('home');
    expect(setHome(definition, 'to_approve').navigation!.home).toBe('to_approve');
  });
});
