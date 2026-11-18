import { EXPENSE_APP } from '@platform/app-model';
import { describe, expect, it } from 'vitest';
import type { Definition } from '../types.js';
import { normalize } from './edit.js';
import { addItem, recordEntities, removeItem, renameItem, setRoleEntity, summarizeAccess, updateItem } from './logic.js';

const app = () => normalize(structuredClone(EXPENSE_APP) as unknown as Definition);

describe('editing rules, actions, queries, cards and roles', () => {
  it('adds items with names from their labels and defaults that pass the checks', () => {
    const { definition, name } = addItem(app(), 'actions', 'Reject a claim');
    expect(name).toBe('reject_a_claim');
    expect(definition.actions[name]).toMatchObject({ entity: 'expense_claim', operation: 'create', confirm: 'preview' });
    // Lines are records' own: only claims stand alone.
    expect(recordEntities(definition)).toEqual(['expense_claim']);
    expect(addItem(definition, 'roles', 'Auditor').definition.roles['auditor']).toEqual({ label: 'Auditor', entities: {}, actions: [], queries: [] });
  });

  it('carries renames and removals to what refers to the item', () => {
    let definition = renameItem(app(), 'actions', 'submit_claim', 'file_claim');
    expect(definition.forms['claim_form']!.action).toBe('file_claim');
    expect(definition.roles['requester']!.actions).toEqual(['file_claim']);
    definition = renameItem(definition, 'cards', 'claim_review', 'review');
    expect(definition.actions['file_claim']!.card).toBe('review');
    definition = removeItem(definition, 'queries', 'my_claims');
    expect(definition.roles['requester']!.queries).toEqual(['my_spending']);
    definition = removeItem(definition, 'actions', 'file_claim');
    expect(definition.forms['claim_form']).not.toHaveProperty('action');
    // People are shared with a role by its name: renaming it is refused.
    expect(renameItem(definition, 'roles', 'approver', 'checker')).toBe(definition);
  });

  it('edits what a role may do with records, and says it in a few words', () => {
    let definition = setRoleEntity(app(), 'approver', 'expense_claim', { read: true, update: false, export: true });
    expect(definition.roles['approver']!.entities['expense_claim']).toEqual({ read: true, export: true });
    expect(summarizeAccess(definition.roles['approver']!.entities['expense_claim'])).toBe('Reads all · Exports');
    expect(summarizeAccess(app().roles['requester']!.entities['expense_claim'])).toBe('Reads some · Creates');
    definition = setRoleEntity(definition, 'approver', 'expense_claim', { read: false });
    expect(definition.roles['approver']!.entities).toEqual({});
    expect(updateItem(app(), 'rules', 'hotel_cap', { when: undefined }).rules['hotel_cap']).not.toHaveProperty('when');
  });
});
