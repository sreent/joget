import { describe, expect, it } from 'vitest';
import { EXPENSE_APP } from '@platform/app-model';
import { run, type Io } from '../src/run.js';

const APP = '0193a7c4-0000-7000-8000-0000000000a1';
const RELEASE = '0193a7c4-0000-7000-8000-0000000000b1';
const DEPLOYMENT = '0193a7c4-0000-7000-8000-0000000000c1';

/** A stand-in for Ambit: answers by method and path, and keeps every request. */
function fake(routes: Record<string, (body: unknown) => { status?: number; body: unknown; raw?: boolean }>, env: Record<string, string> = { AMBIT_TOKEN: 'a-test-token', AMBIT_URL: 'https://ambit.test' }) {
  const requests: Array<{ method: string; path: string; body: unknown; authorization: string | null }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  let clock = 0;
  const io: Io = {
    env,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method ?? 'GET', path: url.pathname, body, authorization: new Headers(init?.headers).get('authorization') });
      const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
      const answer = route ? route(body) : { status: 404, body: { error: 'not_found', message: 'Not found' } };
      if ('raw' in answer && answer.raw) return new Response(String(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/xml' } });
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeFile: async (path, text) => void files.set(path, text),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { io, requests, out, err, files };
}

const apps = { apps: [{ id: APP, handle: 'expenses', name: 'Expenses', kind: 'team', revision: 3, workingCopyOf: null }] };
const deployment = (status: string, env = 'staging') => ({
  id: DEPLOYMENT,
  environment: env,
  kind: 'deploy',
  status,
  release: { number: 2 },
  approvals: { required: env === 'prod' ? 1 : 0, by: [] },
  error: null,
  requestedAt: '2026-11-17T08:00:00.000Z',
});

describe('ambit', () => {
  it('says how to use it, and refuses to work without a token', async () => {
    const help = fake({});
    expect(await run([], help.io)).toBe(0);
    expect(help.out[0]).toContain('Usage: ambit <command>');
    const tokenless = fake({}, {});
    expect(await run(['apps'], tokenless.io)).toBe(2);
    expect(tokenless.err[0]).toMatch(/^Set AMBIT_TOKEN/);
    const unknown = fake({});
    expect(await run(['launch'], unknown.io)).toBe(2);
    expect(await run(['apps', '--colour'], unknown.io)).toBe(2);
  });

  it('lists apps with the token in the header, never in the URL', async () => {
    const world = fake({ 'GET /v1/apps': () => ({ body: apps }) });
    expect(await run(['apps'], world.io)).toBe(0);
    expect(world.requests).toEqual([{ method: 'GET', path: '/v1/apps', body: undefined, authorization: 'Bearer a-test-token' }]);
    expect(world.out[0]).toContain('expenses  Expenses  team  3');
    const json = fake({ 'GET /v1/apps': () => ({ body: apps }) });
    await run(['apps', '--json'], json.io);
    expect(JSON.parse(json.out[0]!)).toEqual(apps.apps);
  });

  it('checks a definition file offline, exported or bare', async () => {
    const world = fake({});
    world.files.set('good.json', JSON.stringify({ format: 'ambit.app/v1', definition: EXPENSE_APP }));
    expect(await run(['check', 'good.json'], world.io)).toBe(0);
    expect(world.out[0]).toBe('good.json: no problems.');
    const broken = structuredClone(EXPENSE_APP) as unknown as { roles: { approver: { actions: string[] } } };
    broken.roles.approver.actions = ['nonexistent'];
    world.files.set('broken.json', JSON.stringify(broken));
    expect(await run(['check', 'broken.json'], world.io)).toBe(1);
    expect(world.out[1]).toContain('roles.approver.actions: No action named nonexistent');
    expect(world.requests).toEqual([]);
  });

  it('exports an app by its handle, and imports a file into a space by name', async () => {
    const bundle = { format: 'ambit.app/v1', app: { name: 'Expenses', handle: 'expenses' }, revision: 3, digest: 'abc', definition: {} };
    const world = fake({
      'GET /v1/apps': () => ({ body: apps }),
      [`GET /v1/apps/${APP}/export`]: () => ({ body: bundle }),
      'GET /v1/spaces': () => ({ body: { spaces: [{ id: '0193a7c4-0000-7000-8000-0000000000d1', name: 'Finance' }] } }),
      'POST /v1/spaces/0193a7c4-0000-7000-8000-0000000000d1/apps/import': () => ({
        status: 201,
        body: { app: { name: 'Expenses', handle: 'expenses' }, plan: null, changeRequest: { id: 'x', number: 4 }, asExported: true },
      }),
    });
    expect(await run(['export', 'expenses'], world.io)).toBe(0);
    expect(JSON.parse(world.files.get('expenses.ambit.json')!)).toEqual(bundle);
    expect(await run(['import', 'expenses.ambit.json', '--space', 'finance'], world.io)).toBe(0);
    expect(world.requests.at(-1)).toMatchObject({ method: 'POST', body: { bundle } });
    expect(world.out.at(-1)).toBe('Expenses arrives in the team space as change request #4, for review.');
    expect(await run(['import', 'expenses.ambit.json', '--template', 'leave', '--space', 'finance'], world.io)).toBe(2);
  });

  it('deploys to Staging at once, and waits for Prod until people approve it', async () => {
    const releases = { releases: [{ id: RELEASE, number: 2, revision: 5, liveIn: [], verified: true, destructive: false, createdAt: '2026-11-17T07:00:00.000Z' }] };
    const staging = fake({
      'GET /v1/apps': () => ({ body: apps }),
      [`GET /v1/apps/${APP}/releases`]: () => ({ body: releases }),
      [`POST /v1/apps/${APP}/deployments`]: () => ({ status: 201, body: deployment('succeeded') }),
    });
    expect(await run(['deploy', 'expenses', '--release', '2', '--env', 'staging'], staging.io)).toBe(0);
    expect(staging.requests.at(-1)!.body).toEqual({ releaseId: RELEASE, env: 'staging', confirmDestructive: false, execute: true });
    expect(staging.out).toEqual(['Staging runs release 2.']);

    // Prod: one look finds it waiting, the next approved; then the command executes it.
    let looks = 0;
    const prod = fake({
      'GET /v1/apps': () => ({ body: apps }),
      [`GET /v1/apps/${APP}/releases`]: () => ({ body: releases }),
      [`POST /v1/apps/${APP}/deployments`]: () => ({ status: 201, body: deployment('awaiting_approval', 'prod') }),
      [`GET /v1/apps/${APP}/deployments`]: () => ({ body: { deployments: [deployment(++looks > 1 ? 'approved' : 'awaiting_approval', 'prod')] } }),
      [`POST /v1/deployments/${DEPLOYMENT}/execute`]: () => ({ body: deployment('succeeded', 'prod') }),
    });
    expect(await run(['deploy', 'expenses', '--release', '2', '--env', 'prod', '--wait'], prod.io)).toBe(0);
    expect(prod.out).toEqual(['Prod runs release 2.']);
    expect(prod.requests.filter((r) => r.path.endsWith('/execute'))).toHaveLength(1);

    const waiting = fake({
      'GET /v1/apps': () => ({ body: apps }),
      [`GET /v1/apps/${APP}/releases`]: () => ({ body: releases }),
      [`POST /v1/apps/${APP}/deployments`]: () => ({ status: 201, body: deployment('awaiting_approval', 'prod') }),
    });
    expect(await run(['deploy', 'expenses', '--release', '2', '--env', 'prod'], waiting.io)).toBe(0);
    expect(waiting.out).toEqual(['Deploying release 2 to Prod waits for 1 approval(s) in Ambit.']);
  });

  it('saves a process as a BPMN file, and adds the processes of one to an app', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<bpmn:definitions />\n';
    const world = fake({
      'GET /v1/apps': () => ({ body: apps }),
      [`GET /v1/apps/${APP}/processes/approval/bpmn`]: () => ({ body: xml, raw: true }),
      [`POST /v1/apps/${APP}/processes/import`]: () => ({ body: { plan: {}, processes: ['approval'], notes: ['Left out the lanes'] } }),
    });
    expect(await run(['bpmn', 'export', 'expenses', 'approval'], world.io)).toBe(0);
    expect(world.files.get('approval.bpmn')).toBe(xml);
    expect(world.out.at(-1)).toBe('Saved the process approval to approval.bpmn, with its diagram.');
    world.files.set('from-camunda.bpmn', '<definitions />');
    expect(await run(['bpmn', 'import', 'expenses', 'from-camunda.bpmn', '--as', 'approval'], world.io)).toBe(0);
    expect(world.requests.at(-1)).toMatchObject({ method: 'POST', body: { xml: '<definitions />', as: 'approval' } });
    expect(world.out.at(-1)).toBe('Added the process approval to expenses.\n  Left out the lanes');
    expect(await run(['bpmn', 'publish', 'expenses', 'approval'], world.io)).toBe(2);
  });

  it('passes on what Ambit says when it refuses', async () => {
    const world = fake({
      'GET /v1/apps': () => ({ body: apps }),
      [`POST /v1/apps/${APP}/releases`]: () => ({ status: 403, body: { error: 'forbidden', message: 'You may not create a release here' } }),
    });
    expect(await run(['release', 'expenses'], world.io)).toBe(1);
    expect(world.err).toEqual(['You may not create a release here']);
  });
});
