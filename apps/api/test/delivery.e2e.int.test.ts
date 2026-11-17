import { EXPENSE_APP } from '@platform/app-model';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Governed delivery in a real browser: a builder makes a working copy of a team app and submits a
 * change; a reviewer tries it in the preview and approves it; a release manager merges it, cuts a
 * release and asks for Prod; the reviewer approves (again with fresh MFA); it goes live; and a
 * rollback makes the previous release live again.
 *
 * Opt-in, like the studio's own browser test:
 *   pnpm --filter @platform/studio build
 *   STUDIO_E2E=1 SCREENSHOT_DIR=/tmp/shots pnpm --filter @platform/api test:integration -- delivery.e2e
 */

interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  getByLabel(text: string, options?: { exact?: boolean }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  first(): Locator;
}
interface Page extends Locator {
  goto(url: string): Promise<unknown>;
  url(): string;
  waitForURL(url: RegExp): Promise<void>;
  locator(selector: string, options?: { has?: Locator }): Locator;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: 'pageerror', listener: (error: Error) => void): void;
}
interface Browser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<{
    addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>;
    newPage(): Promise<Page>;
  }>;
  close(): Promise<void>;
}
const visible = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 10_000 });

const enabled = process.env['STUDIO_E2E'] === '1';
const SHOTS = process.env['SCREENSHOT_DIR'];
const PORT = 3918;
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(!enabled)('governed delivery, in a browser', () => {
  let t: TestApp;
  let alice: Session; // org owner and space owner
  let carol: Session; // builder
  let dave: Session; // reviewer
  let erin: Session; // release manager
  let browser: Browser;
  let spaceId: string;
  let teamId: string;
  let changeUrl: string;

  beforeAll(async () => {
    t = await startTestApp({ PUBLIC_BASE_URL: BASE });
    await t.app.listen({ host: '127.0.0.1', port: PORT });
    [alice, carol, dave, erin] = [await t.login('alice'), await t.login('carol'), await t.login('dave'), await t.login('erin')];
    const olivia = await t.login('olivia');
    spaceId = (await t.app.inject({ method: 'POST', url: '/v1/spaces', cookies: alice.cookies, payload: { name: 'Finance', coOwnerUserIds: [olivia.userId] } })).json().id;
    for (const [session, roleId] of [
      [carol, 'space.builder'],
      [dave, 'space.reviewer'],
      [erin, 'space.release_manager'],
    ] as const) {
      const granted = await t.app.inject({
        method: 'POST',
        url: '/v1/bindings',
        cookies: alice.cookies,
        payload: { principal: { type: 'user', id: session.userId }, roleId, scope: { type: 'space', id: spaceId } },
      });
      expect(granted.statusCode, granted.body).toBe(201);
    }
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Browser> } };
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await t?.close();
  });

  const open = async (session: Session): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await context.addCookies([{ name: 'platform_session', value: session.cookies['platform_session']!, url: BASE }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => {
      throw error;
    });
    return page;
  };
  const shot = async (page: Page, name: string) => {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  };

  it('creates a team app, and makes the builder a working copy with sample data', async () => {
    const page = await open(carol);
    await page.goto(`${BASE}/studio/`);
    await page.getByLabel('Name').fill('Expenses');
    await page.getByLabel('Where').selectOption(spaceId);
    await visible(page.getByText('A team app starts empty.'));
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/changes$/);
    teamId = page.url().split('/apps/')[1]!.split('/')[0]!;
    await visible(page.getByText('No change requests yet'));

    await page.getByRole('button', { name: 'Edit in my space' }).click();
    await page.waitForURL(/\/build\/data$/);
    await visible(page.getByText('Your working copy'));
    const copyId = page.url().split('/apps/')[1]!.split('/')[0]!;
    // The builder drafts the app in their copy (here through the API, as their AI client would).
    const current = (await t.app.inject({ method: 'GET', url: `/v1/apps/${copyId}/definition`, cookies: carol.cookies })).json();
    const saved = await t.app.inject({ method: 'PUT', url: `/v1/apps/${copyId}/definition`, cookies: carol.cookies, payload: { definition: EXPENSE_APP, baseRevision: current.revision } });
    expect(saved.statusCode, saved.body).toBe(200);
    await page.goto(`${BASE}/studio/apps/${copyId}/build/data`);
    await visible(page.getByRole('button', { name: /^Expense claim/ }).first());
    await shot(page, 'd1-working-copy');
  });

  it('submits the change, with its checks', async () => {
    const page = await open(carol);
    await page.goto(`${BASE}/studio/`);
    await page.getByRole('link', { name: 'Build' }).first().click();
    await page.getByRole('button', { name: 'Submit change' }).click();
    await page.getByLabel('What it does').fill('Expense claims, first version');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await page.waitForURL(/\/studio\/changes\//);
    changeUrl = page.url();
    await visible(page.getByRole('heading', { name: '#1 Expense claims, first version' }));
    await visible(page.getByText('Requester is a new role'));
    await visible(page.getByText(/New tool submit_claim/));
    await visible(page.getByText('Someone other than you approves your change.'));
    await shot(page, 'd2-change-request');
  });

  it('lets a reviewer try the preview, then approve', async () => {
    const page = await open(dave);
    await page.goto(changeUrl);
    await page.getByRole('button', { name: 'Try it in the preview' }).click();
    await visible(page.getByText('Preview of change #1'));
    await page.getByRole('link', { name: '+ Claim an expense' }).click();
    await page.getByLabel('Title').fill('Preview claim');
    await page.getByLabel('Receipt 1, Date').fill('2026-11-10');
    await page.getByLabel('Receipt 1, Merchant').fill('Cafe');
    await page.getByLabel('Receipt 1, Category').selectOption('meals');
    await page.getByLabel('Receipt 1, Amount (SGD)').fill('12');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByText('Preview claim').first());
    await shot(page, 'd3-preview');

    await page.goto(changeUrl);
    await page.getByRole('button', { name: 'Approve' }).click();
    await visible(page.getByText('1 of 1 approval'));
  });

  it('merges, cuts a signed release, and asks to deploy to Prod', async () => {
    const page = await open(erin);
    await page.goto(changeUrl);
    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    await visible(page.getByText(/^Merged as revision/));
    await page.goto(`${BASE}/studio/apps/${teamId}/build/delivery`);
    await page.getByRole('button', { name: 'Cut a release' }).click();
    await page.getByRole('button', { name: /^Release revision/ }).click();
    await visible(page.getByText('Signed'));
    await page.getByRole('button', { name: 'Ask to deploy to Prod' }).click();
    await visible(page.getByText('Waiting for approval'));
    await shot(page, 'd4-waiting');
  });

  it('needs the reviewer to sign in again with MFA, then approve; then it goes live', async () => {
    const page = await open(dave);
    t.clock.offsetMs = 20 * 60_000;
    try {
      await page.goto(`${BASE}/studio/apps/${teamId}/build/delivery`);
      await page.getByRole('button', { name: 'Approve' }).click();
      await visible(page.getByText('This needs a fresh sign-in with MFA, because it changes Prod.'));
      await visible(page.getByRole('button', { name: 'Sign in again' }));
      await shot(page, 'd5-step-up');
    } finally {
      t.clock.offsetMs = 0;
    }
    await page.goto(`${BASE}/studio/apps/${teamId}/build/delivery`);
    await page.getByRole('button', { name: 'Approve' }).click();
    await visible(page.getByText('Approved', { exact: true }));

    const releaser = await open(erin);
    await releaser.goto(`${BASE}/studio/apps/${teamId}/build/delivery`);
    await releaser.getByRole('button', { name: 'Deploy now' }).click();
    await visible(releaser.getByText('Release 1 live'));
    await shot(releaser, 'd6-live');
  });

  it('rolls Prod back to the previous release', async () => {
    // A second release, through the API: a new field, reviewed, merged, released and deployed.
    const api = async (session: Session, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
      const response = await t.app.inject({ method, url, cookies: session.cookies, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return response.json();
    };
    const copyId = (await api(carol, 'GET', `/v1/apps/${teamId}`)).myWorkingCopyId;
    const current = await api(carol, 'GET', `/v1/apps/${copyId}/definition`);
    current.definition.entities.expense_claim.fields.push({ name: 'vendor', label: 'Vendor', type: 'text' });
    await api(carol, 'PUT', `/v1/apps/${copyId}/definition`, { definition: current.definition, baseRevision: current.revision });
    const cr = await api(carol, 'POST', `/v1/apps/${copyId}/submit`, { title: 'Record the vendor' });
    await api(dave, 'POST', `/v1/change-requests/${cr.id}/reviews`, { verdict: 'approve' });
    await api(erin, 'POST', `/v1/change-requests/${cr.id}/merge`);
    const release = await api(erin, 'POST', `/v1/apps/${teamId}/releases`, {});
    const deployment = await api(erin, 'POST', `/v1/apps/${teamId}/deployments`, { releaseId: release.id, env: 'prod' });
    await api(dave, 'POST', `/v1/deployments/${deployment.id}/approve`);
    await api(erin, 'POST', `/v1/deployments/${deployment.id}/execute`);

    const page = await open(erin);
    await page.goto(`${BASE}/studio/apps/${teamId}/build/delivery`);
    await visible(page.getByText('Release 2 live'));
    await page.getByRole('button', { name: 'Roll back' }).first().click();
    await page.getByRole('button', { name: 'Roll back now' }).click();
    await visible(page.getByText('Release 1 live'));
    await visible(page.getByText('Rolled back', { exact: true }));
    await shot(page, 'd7-rolled-back');
  });

  it('moves a personal app to the team space through a change request', async () => {
    const created = await t.app.inject({ method: 'POST', url: `/v1/spaces/${carol.personalSpaceId}/apps`, cookies: carol.cookies, payload: { name: 'Travel', definition: EXPENSE_APP } });
    const personalId = created.json().app.id as string;
    const page = await open(carol);
    await page.goto(`${BASE}/studio/apps/${personalId}/build/share`);
    await visible(page.getByRole('heading', { name: 'Move to a team space' }));
    await page.getByLabel('Team space').selectOption(spaceId);
    await page.getByLabel('Name there').fill('Team travel');
    await shot(page, 'd8-move-to-team');
    await page.getByRole('button', { name: 'Ask to move it' }).click();
    await page.waitForURL(/\/changes\//);
    await visible(page.getByText('Bring in Travel from a personal space'));
    await shot(page, 'd9-move-change-request');
    await page.goto(`${BASE}/studio/apps/${personalId}/build/share`);
    await visible(page.getByRole('heading', { name: 'On its way to a team space' }));
  });
});
