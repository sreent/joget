import type { AppDefinitionInput } from './schema.js';

const owner = { ref: 'record.owner' } as const;
const me = { ref: 'principal.id' } as const;
const status = { ref: 'record.status' } as const;

/**
 * A small expense-claim app: a claim with one line per receipt, each with its file, and a total worked out from them,
 * rules on each line, two actions (one with steps, which pay the claim through a7c), two queries (one works out numbers), a review card with the lines as a table, a form,
 * two roles, three pages (one a dashboard) and a menu. It's the running example in the design doc (§6.2) and in the tests.
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
        { name: 'lines', label: 'Receipts', type: 'lines', entity: 'expense_line', required: true, max: 50 },
        { name: 'total', label: 'Total (SGD)', type: 'number', decimals: 2, rollup: { sum: 'lines.amount' } },
        { name: 'status', label: 'Status', type: 'choice', default: 'draft', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'submitted', label: 'Submitted' },
          { value: 'approved', label: 'Approved' },
        ] },
        { name: 'iban', label: 'Bank account', type: 'text', classification: 'pii' },
        { name: 'approver', label: 'Approver', type: 'user' },
      ],
    },
    expense_line: {
      label: 'Receipt',
      pluralLabel: 'Receipts',
      titleField: 'merchant',
      fields: [
        { name: 'date', label: 'Date', type: 'date', required: true },
        { name: 'merchant', label: 'Merchant', type: 'text', required: true, maxLength: 200 },
        { name: 'category', label: 'Category', type: 'choice', required: true, options: [
          { value: 'travel', label: 'Travel' },
          { value: 'hotel', label: 'Hotel' },
          { value: 'meals', label: 'Meals' },
        ] },
        { name: 'amount', label: 'Amount (SGD)', type: 'number', decimals: 2, min: 0, required: true },
        { name: 'receipt', label: 'Receipt', type: 'file', accept: ['image', 'pdf'] },
      ],
    },
  },
  rules: {
    hotel_cap: {
      entity: 'expense_line',
      when: { eq: [{ ref: 'record.category' }, 'hotel'] },
      assert: { lte: [{ ref: 'record.amount' }, 250] },
      severity: 'warning',
      message: 'Hotel is above the SGD 250 nightly cap',
      fields: ['amount'],
    },
    positive_amount: {
      entity: 'expense_line',
      assert: { gt: [{ ref: 'record.amount' }, 0] },
      message: 'The amount must be more than zero',
      fields: ['amount'],
    },
  },
  actions: {
    submit_claim: {
      label: 'Submit an expense claim',
      description: 'File an expense claim for the person you act for, with one line per receipt. Use it once they have checked the claim.',
      entity: 'expense_claim',
      operation: 'create',
      input: ['title', 'trip', 'lines', 'iban'],
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
      steps: [
        { type: 'check', assert: { ne: [owner, me] }, message: "You can't approve your own claim" },
        { type: 'set', field: 'approver', value: me },
        {
          type: 'if',
          when: { gt: [{ ref: 'record.total' }, 1000] },
          then: [{ type: 'skill', label: 'Ask finance to check a large claim', skill: 'finance/check-large-claim', input: { claim: { ref: 'record.id' }, amount: { ref: 'record.total' } } }],
        },
        {
          type: 'skill',
          label: 'Pay the claim',
          skill: 'finance/pay-expense-claim',
          input: { claim: { ref: 'record.id' }, title: { ref: 'record.title' }, amount: { ref: 'record.total' }, account: { ref: 'record.iban' } },
        },
      ],
    },
  },
  queries: {
    my_claims: {
      label: 'My expense claims',
      description: 'The expense claims of the person you act for, newest first.',
      entity: 'expense_claim',
      fields: ['title', 'total', 'status', 'created_at'],
      filter: { eq: [owner, me] },
      sort: [{ field: 'created_at', direction: 'desc' }],
    },
    my_spending: {
      label: 'My spending by category',
      description: 'How much the person you act for has claimed this year, in SGD, for each category of receipt. Use it for questions such as "how much did I spend on hotels this year?"',
      entity: 'expense_claim',
      filter: { eq: [owner, me] },
      summary: { measure: { op: 'sum', field: 'lines.amount' }, group: { field: 'lines.category' }, range: { field: 'lines.date', within: 'this_year' } },
    },
  },
  cards: {
    claim_review: {
      entity: 'expense_claim',
      title: '{{title}}: SGD {{total}}',
      show: ['trip', 'total', 'iban'],
      table: { of: 'lines', columns: ['date', 'merchant', 'category', 'amount', 'receipt'] },
    },
  },
  forms: {
    claim_form: {
      label: 'Claim an expense',
      entity: 'expense_claim',
      action: 'submit_claim',
      sections: [
        { title: 'What it was', fields: [{ field: 'title' }, { field: 'trip' }] },
        { title: 'Receipts', fields: [{ field: 'lines', help: 'One line per receipt' }, { field: 'total', width: 'half', readOnly: true }] },
        { title: 'Paying you back', fields: [{ field: 'iban', width: 'half', help: 'Where we send the money' }] },
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
      queries: ['my_claims', 'my_spending'],
    },
    approver: {
      label: 'Approver',
      description: 'Approves submitted claims. Sees bank details masked.',
      entities: {
        expense_claim: {
          read: { where: { in: [status, ['submitted', 'approved']] } },
          update: { where: { eq: [status, 'submitted'] }, fields: { include: ['status', 'approver'] } },
        },
      },
      actions: ['approve_claim'],
    },
  },
  pages: {
    my_claims: {
      label: 'My claims',
      description: 'Your expense claims, newest first.',
      blocks: [
        { type: 'buttons', buttons: [{ form: 'claim_form' }] },
        {
          type: 'list',
          entity: 'expense_claim',
          columns: ['title', 'total', 'status', 'created_at'],
          filter: { eq: [owner, me] },
          sort: [{ field: 'created_at', direction: 'desc' }],
          empty: 'You have no claims yet.',
        },
      ],
    },
    to_approve: {
      label: 'To approve',
      roles: ['approver'],
      blocks: [
        { type: 'text', style: 'note', text: 'Check the receipts of each claim before you approve it.' },
        {
          type: 'list',
          title: 'Submitted claims',
          entity: 'expense_claim',
          columns: ['title', 'total', 'owner', 'created_at'],
          filter: { eq: [status, 'submitted'] },
          sort: [{ field: 'created_at', direction: 'asc' }],
          actions: ['approve_claim'],
          empty: 'Nothing waits for approval.',
        },
      ],
    },
    spending: {
      label: 'Spending',
      description: 'Where the money goes, from the claims you may see.',
      blocks: [
        { type: 'stat', label: 'Claims waiting for approval', entity: 'expense_claim', measure: { op: 'count' }, filter: { eq: [status, 'submitted'] } },
        {
          type: 'stat',
          label: 'Approved this year (SGD)',
          entity: 'expense_claim',
          measure: { op: 'sum', field: 'total' },
          filter: { eq: [status, 'approved'] },
          range: { field: 'created_at', within: 'this_year' },
        },
        { type: 'stat', label: 'Receipts', entity: 'expense_claim', measure: { op: 'count', field: 'lines' } },
        {
          type: 'chart',
          title: 'Spending by category (SGD)',
          entity: 'expense_claim',
          measure: { op: 'sum', field: 'lines.amount' },
          group: { field: 'lines.category' },
          show: 'bar',
        },
        {
          type: 'chart',
          title: 'Spending by month (SGD)',
          entity: 'expense_claim',
          measure: { op: 'sum', field: 'lines.amount' },
          group: { field: 'lines.date', period: 'month' },
          range: { field: 'lines.date', within: 'last_12_months' },
          show: 'column',
          limit: 12,
        },
      ],
    },
  },
  navigation: {
    home: 'my_claims',
    items: [
      { page: 'my_claims' },
      { form: 'claim_form' },
      { entity: 'expense_claim', label: 'All claims' },
      { page: 'spending' },
      { heading: 'Approvals' },
      { page: 'to_approve' },
    ],
  },
} as const satisfies AppDefinitionInput;
