import { LEAVE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { and, desc, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webhookSignature } from '../src/integration/routes.js';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Integration (design §6.13). A flow calls a service through a connection, with the secret its
 * environment keeps, and keeps what the answer says in typed variables. Another system runs a flow
 * through a webhook, signing its request with the environment's key. A notice posts to a Teams
 * channel. Calls stay off private networks, and a try calls nothing that changes something.
 */

let t: TestApp;
let alice: Session; // builds the app, and manages its connections
let bob: Session; // a manager: uses the app, and manages nothing
let service: Server;
let base: string;
/** What the service and the Teams channel were sent. */
const heard: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: { data: { days: 12 } } };

const as = (session: Session) => ({ cookies: session.cookies });
async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const json = async (options: InjectOptions, expected: number) => (await inject(options, expected)).json();
const read = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

/** The leave app with a payroll service and a Teams channel, and flows that use them. */
async function leaveApp(name: string, edit: (definition: Record<string, any>) => void = () => undefined): Promise<string> {
  const definition = structuredClone(LEAVE_APP) as unknown as Record<string, any>;
  definition['connections'] = {
    payroll: { kind: 'service', label: 'Payroll', url: `${base}/api`, auth: { type: 'bearer' } },
    team_channel: { kind: 'teams', label: 'The team channel' },
  };
  definition['flows'].balance = {
    label: 'Check the balance',
    input: { leave: { type: 'record', entity: 'leave_request' } },
    output: { type: 'number' },
    steps: [
      { type: 'call_service', connection: 'payroll', path: { concat: ['/balances/', { ref: 'leave.manager' }] }, query: { kind: { ref: 'leave.kind' } }, results: { days_left: { from: 'data.days', type: 'number' } } },
      { type: 'return', value: { ref: 'days_left' } },
    ],
  };
  edit(definition);
  const app = (await json({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name, bundle: definition } }, 201)).app.id;
  await inject({ method: 'POST', url: `/v1/apps/${app}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'manager' } }, 201);
  return app;
}
const ask = async (app: string) =>
  (
    await json(
      { method: 'POST', url: `/v1/apps/${app}/actions/request_leave/run`, ...as(alice), payload: { values: { kind: 'annual', starts: '2026-12-21', ends: '2026-12-24', days: 4, manager: bob.userId } } },
      201,
    )
  ).record.id as string;
const run = (app: string, flow: string, input: Record<string, unknown>, expected: number, dryRun = false) =>
  json({ method: 'POST', url: `/v1/apps/${app}/flows/${flow}/run`, ...as(alice), payload: { input, dryRun } }, expected);

beforeAll(async () => {
  service = createServer((request, response) => {
    void read(request).then((body) => {
      heard.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, body });
      response.writeHead(request.url?.startsWith('/teams') ? 200 : answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url?.startsWith('/teams') ? {} : answer.body));
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  t = await startTestApp({ OUTBOUND_ALLOW_HTTP: 'true', OUTBOUND_PRIVATE_HOSTS: '127.0.0.1' });
  [alice, bob] = [await t.login('alice'), await t.login('bob')];
});

afterAll(async () => {
  await t?.close();
  await new Promise((resolve) => service?.close(resolve));
});

describe('integration', () => {
  it("calls a service with the secret its environment keeps, and keeps what the answer says", async () => {
    const app = await leaveApp('Leave, with payroll');
    const id = await ask(app);
    // No secret yet: the call can't prove who the app is.
    expect(await run(app, 'balance', { leave: id }, 422)).toMatchObject({ error: 'secret_missing', message: 'Payroll has no secret in this environment: its admins set it first' });
    // Bob uses the app, and manages none of its connections.
    await inject({ method: 'PUT', url: `/v1/apps/${app}/connections/payroll/secret`, ...as(bob), payload: { value: 'tok-123' } }, 403);
    expect(await json({ method: 'PUT', url: `/v1/apps/${app}/connections/payroll/secret`, ...as(alice), payload: { value: 'tok-123' } }, 200)).toMatchObject({ set: true });
    const listed = await json({ method: 'GET', url: `/v1/apps/${app}/connections`, ...as(alice) }, 200);
    expect(listed.connections).toEqual([
      { name: 'payroll', kind: 'service', label: 'Payroll', host: base.slice('http://'.length), needsSecret: true, secret: { set: true, setAt: expect.any(String) } },
      { name: 'team_channel', kind: 'teams', label: 'The team channel', host: null, needsSecret: true, secret: { set: false, setAt: null } },
    ]);
    expect(JSON.stringify(listed)).not.toContain('tok-123');

    heard.length = 0;
    expect(await run(app, 'balance', { leave: id }, 200)).toMatchObject({ output: 12 });
    expect(heard).toEqual([{ method: 'GET', url: `/api/balances/${bob.userId}?kind=annual`, authorization: 'Bearer tok-123', body: '' }]);
    const [event] = await t.ctx.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'service.call'), eq(auditEvents.appId, app)))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    expect(event?.reason).toMatchObject({ method: 'GET', path: `/api/balances/${bob.userId}`, status: 200 });

    // An answer that isn't a success fails the step, which an error handler catches.
    answer = { status: 500, body: { error: 'down' } };
    expect(await run(app, 'balance', { leave: id }, 422)).toMatchObject({ error: 'service_failed', message: 'Payroll answered 500' });
    answer = { status: 200, body: { data: { days: 12 } } };
  });

  it('calls nothing that changes something when a flow is tried, and stays off private networks', async () => {
    const app = await leaveApp('Leave, guarded', (definition) => {
      definition['connections'].inside = { kind: 'service', label: 'Inside', url: 'http://10.0.0.1/api' };
      definition['connections'].local = { kind: 'service', label: 'Local', url: `${base.replace('127.0.0.1', 'localhost')}/api` };
      definition['flows'].book = {
        label: 'Book it with payroll',
        input: { leave: { type: 'record', entity: 'leave_request' } },
        steps: [{ type: 'call_service', connection: 'payroll', method: 'POST', path: '/bookings', body: { days: { ref: 'leave.days' } } }],
      };
      definition['flows'].inside = { label: 'Inside', steps: [{ type: 'call_service', connection: 'inside' }] };
      definition['flows'].local = { label: 'Local', steps: [{ type: 'call_service', connection: 'local' }] };
    });
    await inject({ method: 'PUT', url: `/v1/apps/${app}/connections/payroll/secret`, ...as(alice), payload: { value: 'tok-123' } }, 200);
    const id = await ask(app);
    heard.length = 0;
    expect(await run(app, 'book', { leave: id }, 200, true)).toMatchObject({ dryRun: true, findings: [{ message: "Trying it didn't call Payroll: a POST changes something there for real" }] });
    expect(heard).toEqual([]);
    await run(app, 'book', { leave: id }, 200);
    expect(heard).toEqual([expect.objectContaining({ method: 'POST', url: '/api/bookings', body: '{"days":4}' })]);
    expect(await run(app, 'inside', {}, 422)).toMatchObject({ message: 'Inside: 10.0.0.1 is on a private network' });
    expect(await run(app, 'local', {}, 422)).toMatchObject({ message: 'Local: localhost is on a private network' });
  });

  it('runs a flow from a webhook signed with the environment’s key', async () => {
    const app = await leaveApp('Leave, from payroll', (definition) => {
      definition['flows'].booked = {
        label: 'Booked in payroll',
        input: { leave: { type: 'record', entity: 'leave_request' }, note: { type: 'text' } },
        steps: [{ type: 'change', record: 'leave', values: { reason: { ref: 'note' } } }],
      };
      definition['webhooks'] = { from_payroll: { label: 'From payroll', flow: 'booked', input: { leave: 'booking.leave_id', note: 'booking.note' } } };
    });
    const id = await ask(app);
    const made = await json({ method: 'POST', url: `/v1/apps/${app}/webhooks/from_payroll/secret`, ...as(alice) }, 200);
    expect(made.url).toMatch(/\/v1\/hooks\/[0-9a-f-]+\/from_payroll$/);
    const path = new URL(made.url).pathname;
    const body = JSON.stringify({ booking: { leave_id: id, note: 'Booked by payroll' } });
    const now = String(Math.floor(Date.now() / 1000));
    const signed = (timestamp: string, signature: string) => ({ 'content-type': 'application/json', 'x-a3t-timestamp': timestamp, 'x-a3t-signature': signature });
    await inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json' }, payload: body }, 401);
    await inject({ method: 'POST', url: path, headers: signed(now, webhookSignature('a guess', now, body)), payload: body }, 401);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    await inject({ method: 'POST', url: path, headers: signed(old, webhookSignature(made.key, old, body)), payload: body }, 401);
    expect(await json({ method: 'POST', url: path, headers: signed(now, webhookSignature(made.key, now, body)), payload: body }, 200)).toEqual({ output: null, findings: [] });
    const record = await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${id}`, ...as(alice) }, 200);
    expect(record.values.reason).toBe('Booked by payroll');
    const history = await json({ method: 'GET', url: `/v1/apps/${app}/entities/leave_request/records/${id}/history`, ...as(alice) }, 200);
    expect(history.history.map((entry: { actor: { type: string } }) => entry.actor.type)).toContain('webhook');
  });

  it('posts a notice to a Teams channel', async () => {
    const app = await leaveApp('Leave, in Teams', (definition) => {
      definition['actions'].request_leave.flow = { flow: 'tell_team', input: { leave: { ref: 'record' } } };
      definition['flows'].tell_team = {
        label: 'Tell the team',
        input: { leave: { type: 'record', entity: 'leave_request' } },
        steps: [{ type: 'inform', to: [{ role: 'manager' }], title: { concat: ['Leave asked for: ', { ref: 'leave.days' }, ' days'] }, about: 'leave', email: false, teams: 'team_channel' }],
      };
    });
    await inject({ method: 'PUT', url: `/v1/apps/${app}/connections/team_channel/secret`, ...as(alice), payload: { value: 'ftp://nowhere' } }, 422);
    await inject({ method: 'PUT', url: `/v1/apps/${app}/connections/team_channel/secret`, ...as(alice), payload: { value: `${base}/teams/hook` } }, 200);
    const id = await ask(app);
    heard.length = 0;
    await t.server.services.deliverPosts();
    expect(heard).toHaveLength(1);
    const card = JSON.parse(heard[0]!.body);
    expect(heard[0]).toMatchObject({ method: 'POST', url: '/teams/hook' });
    expect(card.attachments[0].content.body[0]).toMatchObject({ type: 'TextBlock', text: 'Leave asked for: 4 days' });
    expect(card.attachments[0].content.actions[0].url).toContain(`/studio/apps/${app}/leave_request/${id}`);
  });
});
