import { type Io, run } from '@platform/cli';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * ambit against a real API: a builder starts an app from a template and exports it; a team's
 * release manager cuts a release and deploys it, as CI would, with an API token.
 */

let t: TestApp;
let alice: Session; // builds in her personal space, and owns the Finance space
let carol: Session; // builds in Finance
let dave: Session; // reviews in Finance
let erin: Session; // releases in Finance
let spaceId: string;
let teamId: string;

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

async function token(session: Session, scopes: string[]): Promise<string> {
  return (await inject({ method: 'POST', url: '/v1/me/tokens', cookies: session.cookies, payload: { name: 'ambit', scopes, expiresInDays: 1 } }, 201)).json()
    .token;
}

/** ambit, as one person's command line: its HTTP goes to the test server, its files stay in memory. */
function ambit(apiToken: string) {
  const files = new Map<string, string>();
  const io = (out: string[], err: string[]): Io => ({
    env: { AMBIT_TOKEN: apiToken, AMBIT_URL: 'http://ambit.test' },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const response = await t.app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') },
      });
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    readFile: async (path) => files.get(path) ?? Promise.reject(new Error(`no file ${path}`)),
    writeFile: async (path, text) => void files.set(path, text),
    sleep: async () => undefined,
    now: () => Date.now(),
  });
  return {
    files,
    async run(...argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, io(out, err));
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
  };
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, carol, dave, erin] = [await t.login('alice'), await t.login('carol'), await t.login('dave'), await t.login('erin')];
  spaceId = (
    await inject({ method: 'POST', url: '/v1/spaces', cookies: alice.cookies, payload: { name: 'Finance', coOwnerUserIds: [dave.userId] } }, 201)
  ).json().id;
  for (const [session, roleId] of [
    [carol, 'space.builder'],
    [dave, 'space.reviewer'],
    [erin, 'space.release_manager'],
  ] as const) {
    await inject(
      {
        method: 'POST',
        url: '/v1/bindings',
        cookies: alice.cookies,
        payload: { principal: { type: 'user', id: session.userId }, roleId, scope: { type: 'space', id: spaceId } },
      },
      201,
    );
  }
});

afterAll(async () => {
  await t?.close();
});

describe('ambit, the command line', () => {
  it('starts an app from a template, exports it, and checks the file offline', async () => {
    const cli = ambit(await token(alice, ['app.read', 'app.create', 'app.edit', 'app.export']));
    expect((await cli.run('templates')).out).toMatch(/^ID +NAME/);
    const created = await cli.run('import', '--template', 'leave', '--space', 'mine');
    expect(created).toEqual({ code: 0, out: 'Created Leave requests (leave_requests), ready in your personal space.', err: '' });
    expect((await cli.run('apps')).out).toContain('leave_requests');
    const exported = await cli.run('export', 'leave_requests', '--out', 'leave.json');
    expect(exported.out).toBe('Saved revision 1 of Leave requests to leave.json. It holds no data.');
    expect(JSON.parse(cli.files.get('leave.json')!)).toMatchObject({ format: 'ambit.app/v1', app: { handle: 'leave_requests' } });
    expect(await cli.run('check', 'leave.json')).toEqual({ code: 0, out: 'leave.json: no problems.', err: '' });
  });

  it('brings a template into a team space as a change request, then releases and deploys it', async () => {
    const builder = ambit(await token(carol, ['space.read', 'app.read', 'app.create', 'change.open']));
    const brought = await builder.run('import', '--template', 'purchasing', '--space', 'Finance', '--json');
    expect(brought, brought.err).toMatchObject({ code: 0 });
    const { app, changeRequest } = JSON.parse(brought.out);
    teamId = app.id;
    await inject({ method: 'POST', url: `/v1/change-requests/${changeRequest.id}/reviews`, cookies: dave.cookies, payload: { verdict: 'approve' } }, 200);
    await inject({ method: 'POST', url: `/v1/change-requests/${changeRequest.id}/merge`, cookies: erin.cookies }, 200);

    const ci = ambit(await token(erin, ['app.read', 'release.create', 'deploy.read', 'deploy.request', 'deploy.execute']));
    expect((await ci.run('release', teamId, '--notes', 'First version')).out).toBe('Cut release 1, of revision 3.');
    expect((await ci.run('releases', teamId)).out).toMatch(/1 +3 +- +verified/);
    expect(await ci.run('deploy', teamId, '--release', '1', '--env', 'staging')).toEqual({ code: 0, out: 'Staging runs release 1.', err: '' });
    // Prod waits for a person's approval, in Ambit.
    expect((await ci.run('deploy', teamId, '--release', '1', '--env', 'prod')).out).toBe('Deploying release 1 to Prod waits for 1 approval(s) in Ambit.');
    const listed = JSON.parse((await ci.run('deployments', teamId, '--json')).out);
    expect(listed.map((d: { environment: string; status: string }) => [d.environment, d.status])).toEqual([
      ['prod', 'awaiting_approval'],
      ['staging', 'succeeded'],
    ]);
    // A token without the right refuses, with Ambit's reason.
    const refused = await builder.run('release', teamId);
    expect(refused.code).toBe(1);
    expect(refused.err).not.toBe('');
  });
});
