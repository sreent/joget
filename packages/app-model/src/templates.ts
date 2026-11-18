import { EXPENSE_APP } from './examples.js';
import type { AppDefinitionInput } from './schema.js';

const owner = { ref: 'record.owner' } as const;
const me = { ref: 'principal.id' } as const;
const status = { ref: 'record.status' } as const;

/**
 * Leave requests: an employee asks for days off, and their manager approves or rejects them. The
 * request runs a flow that waits for the manager's decision, in their inbox. The decision records
 * the day it was made; an overview counts the days taken.
 */
export const LEAVE_APP = {
  entities: {
    leave_request: {
      label: 'Leave request',
      pluralLabel: 'Leave requests',
      titleField: 'kind',
      fields: [
        {
          name: 'kind',
          label: 'Kind of leave',
          type: 'choice',
          required: true,
          default: 'annual',
          options: [
            { value: 'annual', label: 'Annual leave' },
            { value: 'sick', label: 'Sick leave' },
            { value: 'unpaid', label: 'Unpaid leave' },
          ],
        },
        { name: 'starts', label: 'First day', type: 'date', required: true },
        { name: 'ends', label: 'Last day', type: 'date', required: true },
        { name: 'days', label: 'Working days', type: 'number', decimals: 1, min: 0.5, max: 60, required: true },
        { name: 'reason', label: 'Reason', type: 'text', maxLength: 500 },
        { name: 'manager', label: 'Manager', type: 'user', required: true },
        {
          name: 'status',
          label: 'Status',
          type: 'choice',
          default: 'submitted',
          options: [
            { value: 'submitted', label: 'Waiting for a decision' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
          ],
        },
        { name: 'decided_on', label: 'Decided on', type: 'date' },
      ],
    },
  },
  rules: {
    long_leave: {
      entity: 'leave_request',
      assert: { lte: [{ ref: 'record.days' }, 10] },
      severity: 'warning',
      message: 'More than 10 working days: check the team can cover them',
      fields: ['days'],
    },
  },
  actions: {
    request_leave: {
      label: 'Ask for leave',
      description: 'Ask for days off for the person you act for, naming the manager who decides. Use it once they have agreed the dates.',
      entity: 'leave_request',
      operation: 'create',
      input: ['kind', 'starts', 'ends', 'days', 'reason', 'manager'],
      set: { status: 'submitted' },
      confirm: 'review',
      card: 'leave_review',
      flow: { flow: 'leave_approval', input: { leave: { ref: 'record' } } },
    },
    approve_leave: {
      label: 'Approve the leave',
      description: 'Approve a leave request that waits for a decision.',
      entity: 'leave_request',
      operation: 'update',
      input: [],
      set: { status: 'approved' },
      where: { eq: [status, 'submitted'] },
      confirm: 'preview',
      before: { flow: 'note_the_decision', input: { leave: { ref: 'record' } } },
    },
    reject_leave: {
      label: 'Reject the leave',
      description: 'Reject a leave request that waits for a decision.',
      entity: 'leave_request',
      operation: 'update',
      input: [],
      set: { status: 'rejected' },
      where: { eq: [status, 'submitted'] },
      confirm: 'preview',
      before: { flow: 'note_the_decision', input: { leave: { ref: 'record' } } },
    },
  },
  queries: {
    my_leave: {
      label: 'My leave',
      description: 'The leave requests of the person you act for, the latest first.',
      entity: 'leave_request',
      fields: ['kind', 'starts', 'ends', 'days', 'status'],
      filter: { eq: [owner, me] },
      sort: [{ field: 'starts', direction: 'desc' }],
    },
    my_days_off: {
      label: 'My days off this year',
      description: 'How many working days of approved leave the person you act for has this year, for each kind of leave.',
      entity: 'leave_request',
      filter: { all: [{ eq: [owner, me] }, { eq: [status, 'approved'] }] },
      summary: { measure: { op: 'sum', field: 'days' }, group: { field: 'kind' }, range: { field: 'starts', within: 'this_year' } },
    },
  },
  cards: {
    leave_review: {
      entity: 'leave_request',
      title: '{{kind}}: {{days}} day(s)',
      show: ['starts', 'ends', 'days', 'reason', 'manager'],
    },
  },
  forms: {
    leave_form: {
      label: 'Ask for leave',
      entity: 'leave_request',
      action: 'request_leave',
      sections: [
        {
          title: 'When',
          fields: [
            { field: 'kind' },
            { field: 'starts', width: 'half' },
            { field: 'ends', width: 'half' },
            { field: 'days', width: 'half', help: 'Leave out weekends and public holidays' },
          ],
        },
        { title: 'Why, and who decides', fields: [{ field: 'reason' }, { field: 'manager', width: 'half' }] },
      ],
    },
  },
  roles: {
    employee: {
      label: 'Employee',
      description: 'Asks for leave, and sees their own requests.',
      entities: {
        leave_request: {
          read: { where: { eq: [owner, me] } },
          create: { check: { eq: [status, 'submitted'] } },
        },
      },
      actions: ['request_leave'],
      queries: ['my_leave', 'my_days_off'],
    },
    manager: {
      label: 'Manager',
      description: 'Decides on the leave requests that name them.',
      entities: {
        leave_request: {
          read: { where: { eq: [{ ref: 'record.manager' }, me] } },
          update: { where: { all: [{ eq: [status, 'submitted'] }, { eq: [{ ref: 'record.manager' }, me] }] }, fields: { include: ['status', 'decided_on'] } },
        },
      },
      actions: ['approve_leave', 'reject_leave'],
    },
  },
  pages: {
    my_leave: {
      label: 'My leave',
      blocks: [
        { type: 'buttons', buttons: [{ form: 'leave_form' }] },
        {
          type: 'list',
          entity: 'leave_request',
          columns: ['kind', 'starts', 'ends', 'days', 'status'],
          filter: { eq: [owner, me] },
          sort: [{ field: 'starts', direction: 'desc' }],
          empty: 'You have asked for no leave yet.',
        },
      ],
    },
    to_decide: {
      label: 'To decide',
      roles: ['manager'],
      blocks: [
        {
          type: 'list',
          title: 'Waiting for your decision',
          entity: 'leave_request',
          columns: ['owner', 'kind', 'starts', 'days'],
          filter: { eq: [status, 'submitted'] },
          sort: [{ field: 'starts', direction: 'asc' }],
          actions: ['approve_leave', 'reject_leave'],
          empty: 'Nothing waits for your decision.',
        },
      ],
    },
    overview: {
      label: 'Overview',
      description: 'Leave over the year, from the requests you may see.',
      blocks: [
        { type: 'stat', label: 'Waiting for a decision', entity: 'leave_request', measure: { op: 'count' }, filter: { eq: [status, 'submitted'] } },
        {
          type: 'stat',
          label: 'Days approved this year',
          entity: 'leave_request',
          measure: { op: 'sum', field: 'days' },
          filter: { eq: [status, 'approved'] },
          range: { field: 'starts', within: 'this_year' },
        },
        {
          type: 'chart',
          title: 'Days by kind of leave',
          entity: 'leave_request',
          measure: { op: 'sum', field: 'days' },
          group: { field: 'kind' },
          show: 'bar',
        },
        {
          type: 'chart',
          title: 'Days by month',
          entity: 'leave_request',
          measure: { op: 'sum', field: 'days' },
          group: { field: 'starts', period: 'month' },
          range: { field: 'starts', within: 'last_12_months' },
          show: 'column',
          limit: 12,
        },
      ],
    },
  },
  navigation: {
    home: 'my_leave',
    items: [{ page: 'my_leave' }, { form: 'leave_form' }, { heading: 'Managers' }, { page: 'to_decide' }, { page: 'overview' }],
  },
  flows: {
    leave_approval: {
      label: 'Leave approval',
      description: 'The manager the employee names decides on the leave, within three days.',
      input: { leave: { type: 'record', entity: 'leave_request' } },
      steps: [
        {
          type: 'task',
          label: 'Decide on the leave',
          role: 'manager',
          assignee: { field: 'manager' },
          outcomes: [
            { name: 'approve', label: 'Approve', action: 'approve_leave' },
            { name: 'reject', label: 'Reject', action: 'reject_leave' },
          ],
          due: 'P3D',
          card: 'leave_review',
        },
      ],
    },
    note_the_decision: {
      label: 'Note the decision',
      description: 'Before a decision on a leave saves: nobody decides on their own leave, and the day of the decision is noted.',
      input: { leave: { type: 'record', entity: 'leave_request' } },
      steps: [
        { type: 'check', assert: { ne: [{ ref: 'leave.owner' }, me] }, message: "You can't decide on your own leave" },
        { type: 'change', record: 'leave', values: { decided_on: { today: true } } },
      ],
    },
  },
} as const satisfies AppDefinitionInput;

/**
 * The leave app with its approval written out as a process for the engine (design §6.10), as an
 * app built before flows could wait has it. The engine's tests build on it. The leave template
 * builds the same approval as a flow that waits, which compiles to a process like this one.
 */
export const LEAVE_PROCESS_APP = {
  ...without(LEAVE_APP, 'flows'),
  actions: { ...LEAVE_APP.actions, request_leave: without(LEAVE_APP.actions.request_leave, 'flow') },
  flows: { note_the_decision: LEAVE_APP.flows.note_the_decision },
  processes: {
    leave_approval: {
      label: 'Leave approval',
      description: 'The manager the employee names decides on the leave, within three days.',
      entity: 'leave_request',
      elements: {
        requested: { type: 'startEvent', name: 'Leave requested', actions: ['request_leave'] },
        decide: {
          type: 'userTask',
          name: 'Decide on the leave',
          role: 'manager',
          assignee: { field: 'manager' },
          outcomes: [
            { name: 'approve', label: 'Approve', action: 'approve_leave' },
            { name: 'reject', label: 'Reject', action: 'reject_leave' },
          ],
          due: 'P3D',
          card: 'leave_review',
        },
        approved: { type: 'endEvent', name: 'Leave approved' },
        rejected: { type: 'endEvent', name: 'Leave rejected' },
      },
      flows: {
        to_decide: { from: 'requested', to: 'decide' },
        on_approve: { from: 'decide', to: 'approved', name: 'Approved', outcome: 'approve' },
        on_reject: { from: 'decide', to: 'rejected', name: 'Rejected', outcome: 'reject' },
      },
      diagram: {
        shapes: {
          requested: { x: 152, y: 102, width: 36, height: 36, label: { x: 128, y: 145, width: 84, height: 14 } },
          decide: { x: 250, y: 80, width: 100, height: 80 },
          approved: { x: 432, y: 42, width: 36, height: 36, label: { x: 408, y: 85, width: 84, height: 14 } },
          rejected: { x: 432, y: 162, width: 36, height: 36, label: { x: 408, y: 205, width: 84, height: 14 } },
        },
        edges: {
          to_decide: {
            points: [
              { x: 188, y: 120 },
              { x: 250, y: 120 },
            ],
          },
          on_approve: {
            points: [
              { x: 350, y: 105 },
              { x: 390, y: 105 },
              { x: 390, y: 60 },
              { x: 432, y: 60 },
            ],
          },
          on_reject: {
            points: [
              { x: 350, y: 135 },
              { x: 390, y: 135 },
              { x: 390, y: 180 },
              { x: 432, y: 180 },
            ],
          },
        },
      },
    },
  },
} as const satisfies AppDefinitionInput;

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Omit<T, K>;
}

/**
 * Purchase requests: a requester asks to buy something, an approver approves it, and procurement
 * orders it.
 */
export const PURCHASE_APP = {
  entities: {
    purchase_request: {
      label: 'Purchase request',
      pluralLabel: 'Purchase requests',
      titleField: 'title',
      fields: [
        { name: 'title', label: 'What for', type: 'text', required: true, maxLength: 200 },
        { name: 'supplier', label: 'Supplier', type: 'text', maxLength: 200 },
        { name: 'items', label: 'Items', type: 'lines', entity: 'purchase_item', required: true, max: 50 },
        { name: 'total', label: 'Total (SGD)', type: 'number', decimals: 2, rollup: { sum: 'items.amount' } },
        { name: 'needed_by', label: 'Needed by', type: 'date' },
        {
          name: 'status',
          label: 'Status',
          type: 'choice',
          default: 'submitted',
          options: [
            { value: 'submitted', label: 'Waiting for approval' },
            { value: 'approved', label: 'Approved' },
            { value: 'ordered', label: 'Ordered' },
          ],
        },
        { name: 'approver', label: 'Approver', type: 'user' },
        { name: 'ordered_on', label: 'Ordered on', type: 'date' },
      ],
    },
    purchase_item: {
      label: 'Item',
      pluralLabel: 'Items',
      titleField: 'description',
      fields: [
        { name: 'description', label: 'Description', type: 'text', required: true, maxLength: 200 },
        {
          name: 'category',
          label: 'Category',
          type: 'choice',
          required: true,
          options: [
            { value: 'goods', label: 'Goods' },
            { value: 'services', label: 'Services' },
            { value: 'software', label: 'Software' },
          ],
        },
        { name: 'amount', label: 'Amount (SGD)', type: 'number', decimals: 2, min: 0, required: true },
      ],
    },
  },
  rules: {
    quotes_needed: {
      entity: 'purchase_request',
      assert: { lte: [{ ref: 'record.total' }, 5000] },
      severity: 'warning',
      message: 'Purchases over SGD 5,000 need three quotes',
      fields: ['total'],
    },
    positive_item: {
      entity: 'purchase_item',
      assert: { gt: [{ ref: 'record.amount' }, 0] },
      message: 'Each item costs more than zero',
      fields: ['amount'],
    },
  },
  actions: {
    request_purchase: {
      label: 'Ask to buy something',
      description: 'Ask to buy goods, services or software for the person you act for, one line per item. Use it once they have chosen what to buy.',
      entity: 'purchase_request',
      operation: 'create',
      input: ['title', 'supplier', 'items', 'needed_by'],
      set: { status: 'submitted' },
      confirm: 'review',
      card: 'purchase_review',
    },
    approve_purchase: {
      label: 'Approve the purchase',
      description: 'Approve a purchase request that waits for approval. Procurement then orders it.',
      entity: 'purchase_request',
      operation: 'update',
      input: [],
      set: { status: 'approved' },
      where: { eq: [status, 'submitted'] },
      confirm: 'preview',
      before: { flow: 'note_approver', input: { purchase: { ref: 'record' } } },
    },
    mark_ordered: {
      label: 'Mark as ordered',
      description: 'Record that procurement ordered an approved purchase.',
      entity: 'purchase_request',
      operation: 'update',
      input: [],
      set: { status: 'ordered' },
      where: { eq: [status, 'approved'] },
      confirm: 'preview',
      before: { flow: 'note_order', input: { purchase: { ref: 'record' } } },
    },
  },
  queries: {
    my_requests: {
      label: 'My purchase requests',
      description: 'The purchase requests of the person you act for, the newest first.',
      entity: 'purchase_request',
      fields: ['title', 'total', 'status', 'created_at'],
      filter: { eq: [owner, me] },
      sort: [{ field: 'created_at', direction: 'desc' }],
    },
    spend_by_category: {
      label: 'Spending by category this year',
      description: 'How much the purchases you may see came to this year, in SGD, for each category of item.',
      entity: 'purchase_request',
      summary: { measure: { op: 'sum', field: 'items.amount' }, group: { field: 'items.category' }, range: { field: 'created_at', within: 'this_year' } },
    },
  },
  cards: {
    purchase_review: {
      entity: 'purchase_request',
      title: '{{title}}: SGD {{total}}',
      show: ['supplier', 'needed_by', 'total'],
      table: { of: 'items', columns: ['description', 'category', 'amount'] },
    },
  },
  forms: {
    purchase_form: {
      label: 'Ask to buy something',
      entity: 'purchase_request',
      action: 'request_purchase',
      sections: [
        { title: 'What', fields: [{ field: 'title' }, { field: 'supplier', width: 'half' }, { field: 'needed_by', width: 'half' }] },
        {
          title: 'Items',
          fields: [
            { field: 'items', help: 'One line per item' },
            { field: 'total', width: 'half', readOnly: true },
          ],
        },
      ],
    },
  },
  roles: {
    requester: {
      label: 'Requester',
      description: 'Asks to buy things, and sees their own requests.',
      entities: {
        purchase_request: {
          read: { where: { eq: [owner, me] } },
          create: { check: { eq: [status, 'submitted'] } },
        },
      },
      actions: ['request_purchase'],
      queries: ['my_requests'],
    },
    approver: {
      label: 'Approver',
      description: 'Approves purchase requests.',
      entities: {
        purchase_request: {
          read: { where: { in: [status, ['submitted', 'approved', 'ordered']] } },
          update: { where: { eq: [status, 'submitted'] }, fields: { include: ['status', 'approver'] } },
        },
      },
      actions: ['approve_purchase'],
      queries: ['spend_by_category'],
    },
    procurement: {
      label: 'Procurement',
      description: 'Orders approved purchases.',
      entities: {
        purchase_request: {
          read: { where: { in: [status, ['approved', 'ordered']] } },
          update: { where: { eq: [status, 'approved'] }, fields: { include: ['status', 'ordered_on'] } },
        },
      },
      actions: ['mark_ordered'],
      queries: ['spend_by_category'],
    },
  },
  flows: {
    note_approver: {
      label: 'Note the approver',
      description: 'Before an approval saves: nobody approves their own purchase, and the approver is noted.',
      input: { purchase: { type: 'record', entity: 'purchase_request' } },
      steps: [
        { type: 'check', assert: { ne: [{ ref: 'purchase.owner' }, me] }, message: "You can't approve your own purchase" },
        { type: 'change', record: 'purchase', values: { approver: me } },
      ],
    },
    note_order: {
      label: 'Note the day of the order',
      description: 'Before an order saves, the day of the order is noted.',
      input: { purchase: { type: 'record', entity: 'purchase_request' } },
      steps: [{ type: 'change', record: 'purchase', values: { ordered_on: { today: true } } }],
    },
  },
  pages: {
    my_requests: {
      label: 'My requests',
      blocks: [
        { type: 'buttons', buttons: [{ form: 'purchase_form' }] },
        {
          type: 'list',
          entity: 'purchase_request',
          columns: ['title', 'total', 'status', 'created_at'],
          filter: { eq: [owner, me] },
          sort: [{ field: 'created_at', direction: 'desc' }],
          empty: 'You have asked to buy nothing yet.',
        },
      ],
    },
    to_approve: {
      label: 'To approve',
      roles: ['approver'],
      blocks: [
        {
          type: 'list',
          title: 'Waiting for approval',
          entity: 'purchase_request',
          columns: ['title', 'total', 'owner', 'needed_by'],
          filter: { eq: [status, 'submitted'] },
          sort: [{ field: 'created_at', direction: 'asc' }],
          actions: ['approve_purchase'],
          empty: 'Nothing waits for approval.',
        },
      ],
    },
    to_order: {
      label: 'To order',
      roles: ['procurement'],
      blocks: [
        {
          type: 'list',
          title: 'Approved, not yet ordered',
          entity: 'purchase_request',
          columns: ['title', 'supplier', 'total', 'needed_by'],
          filter: { eq: [status, 'approved'] },
          sort: [{ field: 'needed_by', direction: 'asc' }],
          actions: ['mark_ordered'],
          empty: 'Nothing waits to be ordered.',
        },
      ],
    },
    spending: {
      label: 'Spending',
      description: 'Where the money goes, from the requests you may see.',
      blocks: [
        { type: 'stat', label: 'Waiting for approval', entity: 'purchase_request', measure: { op: 'count' }, filter: { eq: [status, 'submitted'] } },
        {
          type: 'stat',
          label: 'Approved this year (SGD)',
          entity: 'purchase_request',
          measure: { op: 'sum', field: 'total' },
          filter: { in: [status, ['approved', 'ordered']] },
          range: { field: 'created_at', within: 'this_year' },
        },
        {
          type: 'chart',
          title: 'Spending by category (SGD)',
          entity: 'purchase_request',
          measure: { op: 'sum', field: 'items.amount' },
          group: { field: 'items.category' },
          show: 'bar',
        },
        {
          type: 'chart',
          title: 'Requests by month',
          entity: 'purchase_request',
          measure: { op: 'count' },
          group: { field: 'created_at', period: 'month' },
          range: { field: 'created_at', within: 'last_12_months' },
          show: 'column',
          limit: 12,
        },
      ],
    },
  },
  navigation: {
    home: 'my_requests',
    items: [{ page: 'my_requests' }, { form: 'purchase_form' }, { heading: 'Approvals' }, { page: 'to_approve' }, { page: 'to_order' }, { page: 'spending' }],
  },
} as const satisfies AppDefinitionInput;

export interface AppTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly definition: AppDefinitionInput;
}

/** The apps a builder can start from, besides a blank one. Each passes the same checks as any definition. */
export const TEMPLATES: readonly AppTemplate[] = [
  {
    id: 'expenses',
    name: 'Expense claims',
    description:
      'Claims with one line per receipt and its file, a total worked out from them, approval by someone other than the claimant, and a spending dashboard.',
    definition: EXPENSE_APP,
  },
  {
    id: 'leave',
    name: 'Leave requests',
    description: 'Employees ask for days off, and the manager they name approves or rejects them. An overview counts the days taken.',
    definition: LEAVE_APP,
  },
  {
    id: 'purchasing',
    name: 'Purchase requests',
    description: 'Requests with one line per item, approval by someone other than the requester, and procurement marking what was ordered.',
    definition: PURCHASE_APP,
  },
];
