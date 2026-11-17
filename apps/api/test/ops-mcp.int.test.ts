import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * The operators' MCP server (`/mcp/ops`): an AI client watches an app's processes, tries stuck
 * work again, cancels an instance, throws a signal and moves a task, with the same checks as the
 * API's operator routes.
 */

let t: TestApp;
let alice: Session; // owns the app, so operates it
let bob: Session; // a manager who decides leave, and operates nothing
let carol: Session; // another manager
let appId: string;
let operator: string; // Alice's token for her AI client
let instanceId: string;
let taskId: string;

type Json = Record<string, any>;
const as = (session: Session) => ({ cookies: session.cookies });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function inject(options: InjectOptions, expected: number): Promise<Json> {
  const response = await t.app.inject(options);
  expect(response.statusCode, response.body).toBe(expected);
  return response.json();
}

/** Call a tool of `/mcp/ops`: its structured result, or its error. */
async function call(token: string, name: string, args: Json = {}): Promise<{ isError: boolean; result: Json }> {
  const { result } = await inject({ method: 'POST', url: '/mcp/ops', ...bearer(token), payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, 200);
  return { isError: result.isError === true, result: result.structuredContent };
}
const ok = async (token: string, name: string, args: Json = {}) => {
  const done = await call(token, name, args);
  expect(done.isError, JSON.stringify(done.result)).toBe(false);
  return done.result;
};

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
  appId = (await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name: 'Leave', template: 'leave' } }, 201)).app.id;
  for (const person of ['bob', 'carol']) {
    await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: `${person}@example.com`, role: 'manager' } }, 201);
  }
  const asked = await inject(
    { method: 'POST', url: `/v1/apps/${appId}/actions/request_leave/run`, ...as(alice), payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: bob.userId } } },
    201,
  );
  instanceId = (await inject({ method: 'GET', url: `/v1/apps/${appId}/entities/leave_request/records/${asked.record.id}/processes`, ...as(alice) }, 200)).instances[0].id;
  const scopes = ['app.read', 'app.edit', 'ops.monitor.read', 'ops.job.retry', 'process.admin', 'ops.task.reassign'];
  operator = (await inject({ method: 'POST', url: '/v1/me/tokens', ...as(alice), payload: { name: 'ops client', scopes } }, 201)).token;
});

afterAll(async () => {
  await t?.close();
});

describe('the operators\' MCP server', () => {
  it('offers the operators\' tools, and marks the one that cannot be undone', async () => {
    const { result } = await inject({ method: 'POST', url: '/mcp/ops', ...bearer(operator), payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, 200);
    const tools = result.tools as Array<{ name: string; inputSchema: Json; annotations: Json }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_apps',
      'list_instances',
      'get_instance',
      'retry_instance',
      'cancel_instance',
      'throw_signal',
      'reassign_task',
      'find_people',
    ]);
    const cancel = tools.find((tool) => tool.name === 'cancel_instance')!;
    expect(cancel.annotations).toMatchObject({ destructiveHint: true });
    expect(cancel.inputSchema).toMatchObject({ type: 'object', required: ['app_id', 'instance_id'], additionalProperties: false });
    expect(cancel.inputSchema['$schema']).toBeUndefined();
  });

  it('lists the apps the caller operates, and where each instance waits', async () => {
    expect((await ok(operator, 'list_apps')).apps).toEqual([{ id: appId, name: 'Leave', kind: 'personal', environments: ['sandbox'] }]);
    const { instances } = await ok(operator, 'list_instances', { app_id: appId, status: 'running' });
    expect(instances).toMatchObject([{ id: instanceId, process: 'leave_approval', stuck: [], waiting: [{ element: 'steps_0', name: 'Decide on the leave' }] }]);
    const instance = await ok(operator, 'get_instance', { app_id: appId, instance_id: instanceId });
    expect(instance.tasks).toMatchObject([{ name: 'Decide on the leave', status: 'open', assignee: { id: bob.userId } }]);
    taskId = instance.tasks[0].id;
  });

  it('moves a task to someone else who holds its role, while its assignee is away', async () => {
    const [found] = (await ok(operator, 'find_people', { search: 'carol' })).people;
    expect(found).toMatchObject({ id: carol.userId });
    expect(await ok(operator, 'reassign_task', { task_id: taskId, user_id: carol.userId })).toMatchObject({ assignee: { id: carol.userId } });
  });

  it('throws a signal, refuses to retry what is not stuck, and cancels an instance', async () => {
    expect(await ok(operator, 'throw_signal', { app_id: appId, name: 'policy_changed' })).toMatchObject({ name: 'policy_changed' });
    const retried = await call(operator, 'retry_instance', { app_id: appId, instance_id: instanceId });
    expect(retried.isError).toBe(true);
    expect(await ok(operator, 'cancel_instance', { app_id: appId, instance_id: instanceId })).toMatchObject({ id: instanceId, status: 'cancelled' });
  });

  it('checks the arguments, and is for operators only', async () => {
    expect((await call(operator, 'list_instances', {})).result).toMatchObject({ error: 'invalid_arguments' });
    expect((await call(operator, 'throw_signal', { app_id: appId, name: 'policy_changed', entity: 'leave_request' })).result).toMatchObject({ error: 'record_incomplete' });

    // Bob decides leave in the app, and operates nothing.
    const bobs = (await inject({ method: 'POST', url: '/v1/me/tokens', ...as(bob), payload: { name: 'ops client', scopes: ['app.read', 'app.run', 'ops.monitor.read'] } }, 201)).token;
    expect((await ok(bobs, 'list_apps')).apps).toEqual([]);
    expect((await call(bobs, 'list_instances', { app_id: appId })).result).toMatchObject({ error: 'forbidden' });
  });
});
