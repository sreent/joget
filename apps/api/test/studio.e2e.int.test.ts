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
  count(): Promise<number>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  blur(): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  inputValue(): Promise<string>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  getByLabel(text: string, options?: { exact?: boolean }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string, options?: { exact?: boolean }): Locator;
  first(): Locator;
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
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
  let carol: Session;
  let browser: Browser;
  let appId: string;

  beforeAll(async () => {
    t = await startTestApp({ PUBLIC_BASE_URL: BASE });
    await t.app.listen({ host: '127.0.0.1', port: PORT });
    [alice, bob, carol] = [await t.login('alice'), await t.login('bob'), await t.login('carol')];
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
    await page.getByLabel('Start from').selectOption('expenses');
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

  it('shows lines under the record they belong to, and works out the total', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/data`);
    await page.getByRole('button', { name: /^Total \(SGD\)/ }).click();
    expect(await panel(page, 'Field').getByLabel('Value').inputValue()).toBe('sum:lines.amount');
    await page.getByRole('button', { name: /^Receipts/ }).click();
    await page.getByRole('button', { name: 'Receipt: edit the fields of each line' }).click();
    await visible(page.getByText('These are the lines of'));
    await shot(page, '2b-lines');
  });

  it('lays out the form', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/forms`);
    expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('Claim an expense');
    // The renamed field kept its place on the form.
    await visible(page.getByRole('button', { name: 'Journey', exact: true }));
    await shot(page, '4-form-designer');
  });

  it('submits a claim with its receipts through the generated form, and shows its history', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await page.getByRole('link', { name: '+ Claim an expense' }).click();
    await page.getByLabel('Title').fill('Singapore trip');
    await page.getByLabel('Journey').fill('Singapore');
    await page.getByLabel('Receipt 1, Date').fill('2026-11-02');
    await page.getByLabel('Receipt 1, Merchant').fill('Comfort taxi');
    await page.getByLabel('Receipt 1, Category').selectOption('travel');
    await page.getByLabel('Receipt 1, Amount (SGD)').fill('32.40');
    // The receipt uploads as soon as it's picked, and shows as a link to it.
    await page.getByLabel('Receipt 1, Receipt').setInputFiles({ name: 'taxi.jpg', mimeType: 'image/jpeg', buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 9)]) });
    await visible(page.getByRole('link', { name: /taxi\.jpg/ }));
    await page.getByRole('button', { name: 'Add a line' }).click();
    await page.getByLabel('Receipt 2, Date').fill('2026-11-03');
    await page.getByLabel('Receipt 2, Merchant').fill('Marina Bay Sands');
    await page.getByLabel('Receipt 2, Category').selectOption('hotel');
    await page.getByLabel('Receipt 2, Amount (SGD)').fill('270');
    // The total is worked out as people type, the way the platform will work it out.
    await visible(page.getByText('302.40'));
    await shot(page, '5-form');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByRole('heading', { name: 'Singapore trip' }));
    await visible(page.getByText('Submitted', { exact: true }));
    await visible(page.getByRole('cell', { name: 'Marina Bay Sands' }));
    await visible(page.getByRole('link', { name: /taxi\.jpg/ }));
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

  it('lets the person correct a line an agent proposed, on the review page, and approve it', async () => {
    const token = await t.app.inject({ method: 'POST', url: '/v1/me/tokens', cookies: alice.cookies, payload: { name: 'agent', scopes: ['app.run', 'action.run'], expiresInDays: 1 } });
    const run = await t.app.inject({
      method: 'POST',
      url: `/v1/apps/${appId}/actions/submit_claim/run`,
      headers: { authorization: `Bearer ${token.json().token}` },
      payload: {
        values: { title: 'Penang trip', journey: 'Penang', lines: [{ date: '2026-11-09', merchant: 'Eastern & Oriental', category: 'hotel', amount: 280 }] },
        provenance: { 'lines[0].amount': { source: 'document', document: 'receipt.jpg' } },
      },
    });
    expect(run.statusCode, run.body).toBe(202);
    const page = await open(alice);
    await page.goto(run.json().proposal.reviewUrl);
    await visible(page.getByText('Line 1: Hotel is above the SGD 250 nightly cap'));
    await page.getByText('Edit the values').click();
    await page.getByLabel('Amount (SGD)').first().fill('240');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await visible(page.getByText('Edited by you'));
    await hidden(page.getByText('nightly cap'));
    await page.getByRole('button', { name: 'Approve and submit' }).click();
    await visible(page.getByText('Approved and submitted'));
    await shot(page, '9-review-approved');
  });

  it("shows a colleague only what their role allows, in dark mode too", async () => {
    const share = await t.app.inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, cookies: alice.cookies, payload: { email: 'bob@example.com', role: 'requester' } });
    expect(share.statusCode, share.body).toBe(201);
    const page = await open(bob, 'dark');
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await visible(page.getByText('requester'));
    // The app opens on its home page, "My claims", which is empty for Bob so far.
    await visible(page.getByRole('heading', { name: 'My claims' }));
    await visible(page.getByText('You have no claims yet.'));
    await hidden(page.getByRole('link', { name: 'To approve' }));
    await hidden(page.getByText('Build this app'));
    await shot(page, '7-shared-dark');

    const builder = await open(alice, 'dark');
    await builder.goto(`${BASE}/studio/apps/${appId}/build/data`);
    await builder.getByRole('button', { name: /^Bank account/ }).click();
    await shot(builder, '8-data-designer-dark');
  });

  it('builds a rule and a role without JSON, and the app follows them', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/rules`);
    await page.getByLabel('New rule').fill('Total cap');
    await page.getByRole('button', { name: 'Add rule' }).click();
    // The new rule checks claims: make it "Total is at most 1000", and block the change otherwise.
    await page.getByLabel('Field').selectOption('record.total');
    await page.getByLabel('Test').selectOption('lte');
    await page.getByLabel('Value').fill('1000');
    await page.getByLabel('Message', { exact: true }).fill('Claims over SGD 1,000 need a director');
    await shot(page, '11-rule-designer');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));

    await page.goto(`${BASE}/studio/apps/${appId}/build/roles`);
    await page.getByRole('button', { name: 'Approver', exact: true }).click();
    await page.getByLabel('Exports records').click();
    await shot(page, '12-roles');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.rules.total_cap).toMatchObject({ entity: 'expense_claim', assert: { lte: [{ ref: 'record.total' }, 1000] }, severity: 'error' });
    expect(saved.roles.approver.entities.expense_claim.export).toBe(true);

    // The app now refuses a claim over the cap, with the rule's message.
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await page.getByRole('link', { name: '+ Claim an expense' }).click();
    await page.getByLabel('Title').fill('Conference');
    await page.getByLabel('Receipt 1, Date').fill('2026-11-10');
    await page.getByLabel('Receipt 1, Merchant').fill('Expo');
    await page.getByLabel('Receipt 1, Category').selectOption('travel');
    await page.getByLabel('Receipt 1, Amount (SGD)').fill('1200');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByText('Claims over SGD 1,000 need a director'));
  });

  it('designs a page and the menu, and each role sees its own pages', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/pages`);
    await visible(page.getByRole('button', { name: /^To approve/ }));
    await page.getByLabel('New page').fill('Recent claims');
    await page.getByRole('button', { name: 'Add page' }).click();
    await page.getByLabel('Title (optional)').fill('The latest ten');
    await page.getByLabel('Shows at first').fill('10');
    await page.getByLabel('Journey', { exact: true }).click();
    await page.getByRole('button', { name: 'Add text' }).click();
    await page.getByLabel('A note that stands out').click();
    await page.getByLabel('Text', { exact: true }).fill('Newest first. Open one to see its receipts.');
    await shot(page, '14-page-designer');

    await page.getByRole('link', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: 'Add a page' }).click();
    // The new item opens the page that the menu does not have yet.
    expect(await page.getByLabel('Item 7 opens').inputValue()).toBe('recent_claims');
    await shot(page, '15-menu-designer');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.pages.recent_claims.blocks).toEqual([
      expect.objectContaining({ type: 'list', title: 'The latest ten', limit: 10, columns: ['title', 'total', 'created_at'] }),
      { type: 'text', style: 'note', text: 'Newest first. Open one to see its receipts.' },
    ]);
    expect(saved.navigation.items.at(-1)).toEqual({ page: 'recent_claims' });

    await page.goto(`${BASE}/studio/apps/${appId}`);
    await page.getByRole('link', { name: 'Recent claims' }).click();
    await visible(page.getByRole('heading', { name: 'The latest ten' }));
    await visible(page.getByText('Newest first. Open one to see its receipts.'));
    await shot(page, '16-page');

    // An approver gets the page for approvers, and approves from its list in one click.
    const share = await t.app.inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, cookies: alice.cookies, payload: { email: 'carol@example.com', role: 'approver' } });
    expect(share.statusCode, share.body).toBe(201);
    const approver = await open(carol);
    await approver.goto(`${BASE}/studio/apps/${appId}`);
    await approver.getByRole('link', { name: 'To approve' }).click();
    await visible(approver.getByText('Check the receipts of each claim before you approve it.'));
    const rows = approver.locator('tbody tr');
    await visible(rows.first());
    const before = await rows.count();
    await shot(approver, '17-to-approve');
    await approver.getByRole('button', { name: 'Approve an expense claim' }).first().click();
    await expect.poll(() => rows.count()).toBe(before - 1);
    // No claiming for an approver: no form in the menu, and no button for it on My claims.
    await hidden(approver.getByRole('link', { name: '+ Claim an expense' }));
  });

  it('shows a dashboard of numbers and charts, and builds one more chart in the page designer', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await page.getByRole('link', { name: 'Spending' }).click();
    await visible(page.getByRole('heading', { name: 'Claims waiting for approval' }));
    await visible(page.getByRole('heading', { name: 'Spending by category (SGD)' }));
    await visible(page.getByRole('heading', { name: 'Spending by month (SGD)' }));
    await visible(page.locator('ul[aria-label="Spending by category (SGD)"] li').first());
    await shot(page, '18-dashboard');
    // Every chart has a table view, the twin of what it draws.
    await page.getByRole('button', { name: 'Table' }).first().click();
    await visible(page.getByRole('columnheader', { name: 'Category' }));
    await page.getByRole('button', { name: 'Chart' }).first().click();

    const dark = await open(alice, 'dark');
    await dark.goto(`${BASE}/studio/apps/${appId}/pages/spending`);
    await visible(dark.locator('ul[aria-label="Spending by category (SGD)"] li').first());
    await shot(dark, '19-dashboard-dark');

    await page.goto(`${BASE}/studio/apps/${appId}/build/pages`);
    await page.getByRole('button', { name: /^Spending/ }).click();
    await page.getByRole('button', { name: 'Add chart' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Claims by status');
    await page.getByLabel('Width').selectOption('full');
    await shot(page, '20-chart-designer');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    await page.goto(`${BASE}/studio/apps/${appId}/pages/spending`);
    await visible(page.getByRole('heading', { name: 'Claims by status' }));
    await visible(page.locator('ul[aria-label="Claims by status"] li').first());
  });

  it('designs a query that answers with numbers, for agents to ask', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/queries`);
    await page.getByRole('button', { name: /^My spending by category/ }).click();
    await visible(page.getByLabel('A number for each group'));
    expect(await page.getByLabel('For each', { exact: true }).inputValue()).toBe('lines.category');
    await page.getByLabel('Largest groups').fill('5');
    await shot(page, '23-query-numbers');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.queries.my_spending.summary).toMatchObject({ measure: { op: 'sum', field: 'lines.amount' }, group: { field: 'lines.category' }, limit: 5 });
  });

  it('designs the steps of an action, and shows the work in other systems that they start', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/actions`);
    await page.getByRole('button', { name: /^Approve an expense claim/ }).click();
    const steps = page.getByRole('region', { name: 'Steps' });
    await visible(steps.getByRole('button', { name: 'Step 4: Pay the claim (a7c: finance/pay-expense-claim)' }));
    await steps.getByRole('button', { name: 'Start an a7c skill', exact: true }).click();
    await steps.getByLabel('What it does', { exact: true }).fill('Tell the requester');
    await steps.getByLabel('a7c skill', { exact: true }).fill('people/notify-requester');
    await steps.getByLabel('Step 5: new input').fill('claim');
    await steps.getByRole('button', { name: 'Add an input' }).click();
    await steps.getByRole('button', { name: /^Step 2: Set Approver/ }).click();
    await shot(page, '21-steps-designer');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.actions.approve_claim.steps.at(-1)).toEqual({ type: 'skill', label: 'Tell the requester', skill: 'people/notify-requester', input: { claim: { ref: 'record.id' } } });

    // The claim Carol approved shows the payment its approval started, through a7c.
    const listed = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/entities/expense_claim/records`, cookies: alice.cookies })).json();
    const approved = listed.records.find((record: { values: { status: string } }) => record.values.status === 'approved');
    const approver = await open(carol);
    await approver.goto(`${BASE}/studio/apps/${appId}/expense_claim/${approved.id}`);
    const elsewhere = approver.getByRole('list', { name: 'In other systems' });
    await visible(elsewhere.getByText('Pay the claim'));
    await visible(elsewhere.getByText('Waiting'));
    await shot(approver, '22-record-in-other-systems');
  });
});
