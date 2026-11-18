import { capabilityChanges, LEAVE_APP, type StoredDefinition, validateDefinition } from '@platform/app-model';
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

/** The leave template with a payroll service, a Teams channel, and a flow that asks payroll for a balance. */
function leave(edit: (definition: Record<string, any>) => void = () => undefined): Record<string, any> {
  const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
  definition.connections = {
    payroll: { kind: 'service', label: 'Payroll', url: 'https://payroll.example.com/api', auth: { type: 'bearer' } },
    team_channel: { kind: 'teams', label: 'The team channel' },
  };
  definition.flows.balance = {
    label: 'Check the balance',
    input: { leave: { type: 'record', entity: 'leave_request' } },
    output: { type: 'number' },
    steps: [
      {
        type: 'call_service',
        connection: 'payroll',
        path: { concat: ['/balances/', { ref: 'leave.manager' }] },
        query: { kind: { ref: 'leave.kind' } },
        results: { days_left: { from: 'data.days', type: 'number' } },
      },
      { type: 'return', value: { ref: 'days_left' } },
    ],
  };
  edit(definition);
  return definition;
}

describe('integration', () => {
  it('calls a service through a connection, and keeps what its answer says in typed variables', () => {
    const definition = valid(leave());
    expect(definition.flows!['balance']!.steps[0]).toEqual({
      type: 'call_service',
      connection: 'payroll',
      method: 'GET',
      path: { concat: ['/balances/', { ref: 'leave.manager' }] },
      query: { kind: { ref: 'leave.kind' } },
      results: { days_left: { from: 'data.days', type: 'number' } },
    });
    expect(
      issuesOf(
        leave((d) => {
          d.entities.leave_request.fields.find((f: { name: string }) => f.name === 'reason').classification = 'pii';
          d.flows.balance.steps = [
            { type: 'call_service', connection: 'team_channel' },
            { type: 'call_service', connection: 'payroll', body: { why: { ref: 'leave.reason' } } },
            {
              type: 'call_service',
              connection: 'payroll',
              method: 'POST',
              body: { why: { ref: 'leave.reason' } },
              results: { answer: { from: 'id', type: 'text' } },
            },
            { type: 'return', value: { ref: 'answer' } },
          ];
        }),
      ),
    ).toEqual([
      'flows.balance.steps[0].connection: The team channel is a Teams channel: a notice posts to it, with an inform step',
      'flows.balance.steps[1].body: A GET sends nothing: send values with POST, PUT or PATCH, or as the query',
      "flows.balance.steps[1].body.why: leave.reason is personal data, and Payroll doesn't take it. Leave it out, or say on the connection that it takes personal data",
      "flows.balance.steps[2].body.why: leave.reason is personal data, and Payroll doesn't take it. Leave it out, or say on the connection that it takes personal data",
      'flows.balance.steps[3].value: This gives text, not a number',
    ]);
    // A connection that says it takes personal data may get it, and a reviewer sees that it does.
    expect(
      issuesOf(
        leave((d) => {
          d.entities.leave_request.fields.find((f: { name: string }) => f.name === 'reason').classification = 'pii';
          d.connections.payroll.personalData = true;
          d.flows.balance.steps.unshift({ type: 'call_service', connection: 'payroll', method: 'POST', body: { why: { ref: 'leave.reason' } } });
        }),
      ),
    ).toEqual([]);
  });

  it('keeps secrets out of a connection, and runs a flow in one go from a webhook', () => {
    expect(
      issuesOf(
        leave((d) => {
          d.connections.payroll.url = 'https://user:secret@payroll.example.com/api';
          d.connections.legacy = { kind: 'service', label: 'Legacy', url: 'https://legacy.example.com/?token=1' };
          d.webhooks = {
            from_payroll: { label: 'From payroll', flow: 'balance', input: {} },
            to_approval: { label: 'To approval', flow: 'leave_approval', input: { leave: 'id' } },
            nowhere: { label: 'Nowhere', flow: 'nothing' },
            badly: { label: 'Badly', flow: 'balance', input: { leave: 'data..id', other: 'x' } },
          };
        }),
      ),
    ).toEqual([
      "connections.payroll.url: Keep secrets out of the address: each environment keeps the connection's secret",
      'connections.legacy.url: End the address before any query: each step adds its own',
      'webhooks.from_payroll.input: Check the balance needs leave: say where in the request it is',
      'webhooks.to_approval.flow: Leave approval waits for people or for time: a webhook runs a flow that runs in one go',
      'webhooks.nowhere.flow: No flow named nothing',
      'webhooks.badly.input.leave: Name a place in the request, such as order.id',
      'webhooks.badly.input.other: Check the balance takes no other',
    ]);
  });

  it('tells reviewers where data can go, and who can run flows from outside', () => {
    const before = valid(structuredClone(LEAVE_APP));
    const after = valid(
      leave((d) => {
        d.connections.payroll.personalData = true;
        d.webhooks = { from_payroll: { label: 'From payroll', flow: 'balance', input: { leave: 'leave_id' } } };
        d.flows.leave_approval.steps[0].outcomes[0].steps = [
          { type: 'inform', to: [{ role: 'manager' }], title: 'Approved', teams: 'team_channel', email: false },
        ];
      }),
    );
    const texts = capabilityChanges(before, after).map((change) => change.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'New connection Payroll: flows can call payroll.example.com, with a bearer token. It takes personal data',
        'New Teams channel The team channel: notices can post to it',
        "New webhook From payroll: other systems can run Check the balance, with the app's authority",
        'Leave approval now calls The team channel',
      ]),
    );
    expect(texts.find((text) => text.startsWith('New flow Check the balance'))).toContain('calls Payroll');
  });

  it('carries renames into what a call sends', () => {
    const first = valid(leave());
    const next = structuredClone(first) as unknown as Record<string, any>;
    next.entities.leave_request.fields.find((f: { name: string }) => f.name === 'manager').name = 'approver';
    expect(valid(next, first).flows!['balance']!.steps[0]).toMatchObject({ path: { concat: ['/balances/', { ref: 'leave.approver' }] } });
  });
});
