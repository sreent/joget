import type { AppDefinitionInput } from './schema.js';

const owner = { ref: 'record.owner' } as const;
const me = { ref: 'principal.id' } as const;
const status = { ref: 'record.status' } as const;

/**
 * A small expense-claim app: one entity, two rules, two actions, a query, a review card and two
 * roles. It's the running example in the design doc (§6.2) and in the tests.
 */
export const EXPENSE_APP = {
  entities: {
    expense_claim: {
      label: 'Expense claim',
      pluralLabel: 'Expense claims',
      titleField: 'title',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true, maxLength: 200 },
        { name: 'trip', label: 'Trip', type: 'text' },
        { name: 'category', label: 'Category', type: 'choice', required: true, options: [
          { value: 'travel', label: 'Travel' },
          { value: 'hotel', label: 'Hotel' },
          { value: 'meals', label: 'Meals' },
        ] },
        { name: 'amount', label: 'Amount (SGD)', type: 'number', decimals: 2, min: 0, required: true },
        { name: 'status', label: 'Status', type: 'choice', default: 'draft', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'submitted', label: 'Submitted' },
          { value: 'approved', label: 'Approved' },
        ] },
        { name: 'iban', label: 'Bank account', type: 'text', classification: 'pii' },
        { name: 'approver', label: 'Approver', type: 'user' },
      ],
    },
  },
  rules: {
    hotel_cap: {
      entity: 'expense_claim',
      when: { eq: [{ ref: 'record.category' }, 'hotel'] },
      assert: { lte: [{ ref: 'record.amount' }, 250] },
      severity: 'warning',
      message: 'Hotel is above the SGD 250 nightly cap',
      fields: ['amount'],
    },
    positive_amount: {
      entity: 'expense_claim',
      assert: { gt: [{ ref: 'record.amount' }, 0] },
      message: 'The amount must be more than zero',
      fields: ['amount'],
    },
  },
  actions: {
    submit_claim: {
      label: 'Submit an expense claim',
      description: 'File an expense claim for the person you act for. Use it once they have checked the claim.',
      entity: 'expense_claim',
      operation: 'create',
      input: ['title', 'trip', 'category', 'amount', 'iban'],
      set: { status: 'submitted' },
      confirm: 'review',
      card: 'claim_review',
    },
    approve_claim: {
      label: 'Approve an expense claim',
      description: 'Approve a submitted expense claim.',
      entity: 'expense_claim',
      operation: 'update',
      input: [],
      set: { status: 'approved' },
      where: { eq: [status, 'submitted'] },
      confirm: 'preview',
    },
  },
  queries: {
    my_claims: {
      label: 'My expense claims',
      description: 'The expense claims of the person you act for, newest first.',
      entity: 'expense_claim',
      fields: ['title', 'category', 'amount', 'status', 'created_at'],
      filter: { eq: [owner, me] },
      sort: [{ field: 'created_at', direction: 'desc' }],
    },
  },
  cards: {
    claim_review: { entity: 'expense_claim', title: '{{title}}: SGD {{amount}}', show: ['trip', 'category', 'amount', 'iban'] },
  },
  forms: {
    claim_form: {
      label: 'Claim an expense',
      entity: 'expense_claim',
      action: 'submit_claim',
      sections: [
        { title: 'What it was', fields: [{ field: 'title' }, { field: 'trip', width: 'half' }, { field: 'category', width: 'half' }] },
        { title: 'Paying you back', fields: [{ field: 'amount', width: 'half' }, { field: 'iban', width: 'half', help: 'Where we send the money' }] },
      ],
    },
  },
  roles: {
    requester: {
      label: 'Requester',
      description: 'Claims their own expenses.',
      entities: {
        expense_claim: {
          read: { where: { eq: [owner, me] }, unmask: ['iban'] },
          create: { check: { eq: [status, 'submitted'] } },
        },
      },
      actions: ['submit_claim'],
      queries: ['my_claims'],
    },
    approver: {
      label: 'Approver',
      description: 'Approves submitted claims. Sees bank details masked.',
      entities: {
        expense_claim: {
          read: { where: { in: [status, ['submitted', 'approved']] } },
          update: { where: { eq: [status, 'submitted'] }, fields: { include: ['status'] } },
        },
      },
      actions: ['approve_claim'],
    },
  },
} as const satisfies AppDefinitionInput;
