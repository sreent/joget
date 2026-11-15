import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * The studio in a real browser, end to end: build an app from the example, rename a field, save,
 * submit a claim through the generated form, and see a colleague's limited view.
 *
 * Opt-in, because it needs Chromium and a built studio:
 *   pnpm --filter @platform/studio build
 *   STUDIO_E2E=1 SCREENSHOT_DIR=/tmp/shots pnpm --filter @platform/api test:integration -- studio
 */

/** Playwright is installed with the environment's browser, not as a dependency: the little of it used here. */
interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  blur(): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  inputValue(): Promise<string>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  getByLabel(text: string, options?: { exact?: boolean }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
}
interface Page extends Locator {
  goto(url: string): Promise<unknown>;
  url(): string;
  waitForURL(url: RegExp): Promise<void>;
  getByText(text: string, options?: { exact?: boolean }): Locator;
  locator(selector: string, options?: { has?: Locator }): Locator;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: 'pageerror', listener: (error: Error) => void): void;
}
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: 'light' | 'dark' }): Promise<{
    addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>;
    newPage(): Promise<Page>;
  }>;
  close(): Promise<void>;
}
const visible = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 10_000 });
const hidden = (locator: Locator) => locator.waitFor({ state: 'hidden', timeout: 10_000 });

const enabled = process.env['STUDIO_E2E'] === '1';
const SHOTS = process.env['SCREENSHOT_DIR'];
const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(!enabled)('the studio, in a browser', () => {
  let t: TestApp;
  let alice: Session;
  let bob: Session;
  let browser: Browser;
  let appId: string;

  beforeAll(async () => {
    t = await startTestApp({ PUBLIC_BASE_URL: BASE });
    await t.app.listen({ host: '127.0.0.1', port: PORT });
    [alice, bob] = [await t.login('alice'), await t.login('bob')];
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Browser> } };
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await t?.close();
  });

  const open = async (session: Session, colorScheme: 'light' | 'dark' = 'light'): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme });
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
  const panel = (page: Page, heading: string): Locator => page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) });

  it('builds an app from the example, renames a field and saves it', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await visible(page.getByRole('heading', { name: 'Your apps' }));
    await page.getByLabel('Name').fill('Expenses');
    await page.getByLabel('Start from').selectOption('example');
    await shot(page, '1-home');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    appId = page.url().split('/apps/')[1]!.split('/')[0]!;

    await page.getByRole('button', { name: /^Trip/ }).click();
    const field = panel(page, 'Field');
    await field.getByLabel('Label', { exact: true }).fill('Journey');
    await field.getByLabel('Name', { exact: true }).fill('journey');
    await field.getByLabel('Name', { exact: true }).blur();
    await visible(page.getByText('Unsaved changes.'));
    await shot(page, '2-data-designer');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await visible(page.getByText('Rename expense_claim.trip to journey; no data changes'));
    await shot(page, '3-save-plan');
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await visible(page.getByText('revision 2'));
    await hidden(page.getByText('Unsaved changes.'));
  });

  it('lays out the form', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/forms`);
    expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('Claim an expense');
    // The renamed field kept its place on the form.
    await visible(page.getByRole('button', { name: 'Journey', exact: true }));
    await shot(page, '4-form-designer');
  });

  it('submits a claim through the generated form, and shows its history', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await page.getByRole('link', { name: '+ Claim an expense' }).click();
    await page.getByLabel('Title').fill('Taxi to the airport');
    await page.getByLabel('Journey').fill('Singapore');
    await page.getByLabel('Category').selectOption('travel');
    await page.getByLabel('Amount (SGD)').fill('32.40');
    await shot(page, '5-form');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByRole('heading', { name: 'Taxi to the airport' }));
    await visible(page.getByText('Submitted', { exact: true }));
    await visible(page.getByText('Created by Alice'));

    // Pick the approver by name, not by ID.
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Approver').fill('bo');
    await page.getByRole('option', { name: /Bob/ }).click();
    expect(await page.getByLabel('Approver').inputValue()).toBe('Bob');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await visible(page.getByText('Changed by Alice'));
    await visible(page.getByText('Approver: — → Bob'));
    await shot(page, '6-record');
  });

  it("shows a colleague only what their role allows, in dark mode too", async () => {
    const share = await t.app.inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, cookies: alice.cookies, payload: { email: 'bob@example.com', role: 'requester' } });
    expect(share.statusCode, share.body).toBe(201);
    const page = await open(bob, 'dark');
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await visible(page.getByText('requester'));
    await visible(page.getByText('No expense claims you can see'));
    await hidden(page.getByText('Build this app'));
    await shot(page, '7-shared-dark');

    const builder = await open(alice, 'dark');
    await builder.goto(`${BASE}/studio/apps/${appId}/build/data`);
    await builder.getByRole('button', { name: /^Bank account/ }).click();
    await shot(builder, '8-data-designer-dark');
  });
});
