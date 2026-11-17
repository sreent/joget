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
  click(options?: { position?: { x: number; y: number } }): Promise<void>;
  check(): Promise<void>;
  isDisabled(): Promise<boolean>;
  fill(value: string): Promise<void>;
  blur(): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  inputValue(): Promise<string>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  getByLabel(text: string, options?: { exact?: boolean }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string, options?: { exact?: boolean }): Locator;
  getByTestId(testId: string): Locator;
  locator(selector: string, options?: { has?: Locator }): Locator;
  first(): Locator;
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
}
interface Page extends Locator {
  goto(url: string): Promise<unknown>;
  url(): string;
  waitForURL(url: RegExp): Promise<void>;
  getByText(text: string, options?: { exact?: boolean }): Locator;
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

  it('designs the steps of an action, without a7c until the installation connects it', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/actions`);
    await page.getByRole('button', { name: /^Approve an expense claim/ }).click();
    const steps = page.getByRole('region', { name: 'Steps' });
    await visible(steps.getByRole('button', { name: /^Step 3: Warn unless Total \(SGD\) is at most 1000/ }));
    // This installation doesn't connect a7c, so there is no skill step to add.
    expect(await steps.getByRole('button', { name: 'Start an a7c skill', exact: true }).count()).toBe(0);
    await steps.getByRole('button', { name: 'Check', exact: true }).click();
    await steps.getByLabel('Message', { exact: true }).fill('A claim needs a title');
    await steps.getByLabel("When it doesn't hold", { exact: true }).selectOption('warning');
    await steps.getByRole('button', { name: /^Step 2: Set Approver/ }).click();
    await shot(page, '21-steps-designer');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.actions.approve_claim.steps.at(-1)).toEqual({ type: 'check', assert: { exists: 'record.title' }, message: 'A claim needs a title', severity: 'warning' });
  });

  it('designs a process on a canvas, and the manager decides in their inbox', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await visible(page.getByRole('heading', { name: 'Your apps' }));
    await page.getByLabel('Name').fill('Leave');
    await page.getByLabel('Start from').selectOption('leave');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const leaveId = page.url().split('/apps/')[1]!.split('/')[0]!;

    // The template's process, drawn in BPMN 2.0: it passes the checks as it is.
    await page.getByRole('link', { name: 'Processes', exact: true }).click();
    await visible(page.getByTestId('process-canvas'));
    await visible(page.getByText('The process passes the checks.'));
    await shot(page, '14-process');
    // The manager has three days; then HR's way of doing it takes over. Here: a deadline that ends the path.
    await page.getByTestId('process-canvas').getByText('Decide on the leave', { exact: true }).click();
    await visible(page.getByRole('heading', { name: 'User task' }));
    await page.getByRole('button', { name: 'Add a deadline' }).click();
    await visible(page.getByText('Unsaved changes.'));
    // Both of the app's update actions decide the task, so neither can also interrupt it as a message.
    expect(await page.getByRole('button', { name: 'Add an action', exact: true }).isDisabled()).toBe(true);
    await shot(page, '15-process-deadline');
    // An inclusive gateway on the approved path: it takes each flow out whose condition holds.
    // The label's background takes the click: React Flow lets the text itself ignore the pointer.
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await visible(page.getByRole('heading', { name: 'Flow', exact: true }));
    await page.getByLabel('More BPMN', { exact: true }).selectOption('inclusiveGateway');
    await visible(page.getByRole('heading', { name: 'Inclusive', exact: true }));
    await shot(page, '15c-process-inclusive');
    await page.getByTestId('process-canvas').click({ position: { x: 12, y: 12 } });
    await visible(page.getByText('The process passes the checks.'));
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const dark = await open(alice, 'dark');
    await dark.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    await visible(dark.getByTestId('process-canvas'));
    await shot(dark, '15b-process-dark');

    // Alice asks for leave, naming Bob; the decision waits in his inbox.
    await t.app.inject({ method: 'POST', url: `/v1/apps/${leaveId}/shares`, cookies: alice.cookies, payload: { email: 'bob@example.com', role: 'manager' } });
    const asked = await t.app.inject({
      method: 'POST',
      url: `/v1/apps/${leaveId}/actions/request_leave/run`,
      cookies: alice.cookies,
      payload: { values: { kind: 'annual', starts: '2026-12-28', ends: '2026-12-30', days: 3, manager: bob.userId } },
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const inbox = await open(bob);
    await inbox.goto(`${BASE}/studio/tasks`);
    await visible(inbox.getByRole('heading', { name: 'Decide on the leave' }));
    await shot(inbox, '16-inbox');
    await inbox.getByRole('button', { name: 'Approve', exact: true }).click();
    await visible(inbox.getByText('Nothing waits for you'));

    // The record shows that its process is done.
    const record = await open(alice);
    await record.goto(`${BASE}/studio/apps/${leaveId}/leave_request/${asked.json().record.id}`);
    await visible(record.getByText('Leave approval'));
    await visible(record.getByText('Done', { exact: true }));
    await shot(record, '17-record-process');
  });

  it('designs a message that withdraws a request, and a system task whose failure has a path', async () => {
    // The leave template, with an action that withdraws a request and one that tells payroll.
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with withdrawal', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const current = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json();
    const update = (label: string, set: Record<string, string>) => ({ label, description: `${label}.`, entity: 'leave_request', operation: 'update', input: [], set, confirm: 'none' });
    current.definition.actions.withdraw_leave = update('Withdraw', { status: 'rejected' });
    current.definition.actions.tell_payroll = update('Tell payroll', { reason: 'Payroll knows' });
    const put = await t.app.inject({ method: 'PUT', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies, payload: { definition: current.definition, baseRevision: current.revision } });
    expect(put.statusCode, put.body).toBe(200);

    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    const canvas = page.getByTestId('process-canvas');
    await visible(canvas);
    // While the manager decides, the employee can withdraw the request: the task goes, and the path ends.
    await canvas.getByText('Decide on the leave', { exact: true }).click();
    await page.getByRole('button', { name: 'Add an action', exact: true }).click();
    await page.getByLabel('The action that is saved').selectOption('withdraw_leave');
    await visible(canvas.getByText('Stopped', { exact: true }));

    // Once approved, a system task tells payroll; if its action fails, the path leads on.
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await page.getByRole('button', { name: 'System task', exact: true }).click();
    await page.getByLabel("Runs, with the app's authority").selectOption('tell_payroll');
    await page.getByRole('button', { name: 'Catch the failure', exact: true }).click();
    await visible(page.getByText("The process leads on by the error's path."));
    await visible(canvas.getByText('Failed', { exact: true }));

    // An event that waits for an action, drawn and taken away again: the path joins up around it.
    await page.getByTestId('rf__edge-on_reject').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('messageEvent');
    await visible(page.getByLabel('Until it is saved'));
    await shot(page, '15d-process-events');
    await page.getByRole('button', { name: 'Remove message', exact: true }).click();

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 3' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['message_1']).toEqual({ type: 'boundaryEvent', name: 'Withdraw', attachedTo: 'decide', interrupting: true, message: { action: 'withdraw_leave' } });
    expect(saved.elements['system_1']).toMatchObject({ type: 'serviceTask', action: 'tell_payroll' });
    expect(saved.elements['error_1']).toEqual({ type: 'boundaryEvent', name: 'Error', attachedTo: 'system_1', interrupting: true, error: true });
    expect(saved.flows['on_reject']).toMatchObject({ from: 'decide', to: 'rejected' });
  });

  it('designs a script with a step, a rule check and a link', async () => {
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with a script', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    await visible(page.getByTestId('process-canvas'));
    // Once approved, a script notes the decision on the record.
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('scriptTask');
    await visible(page.getByRole('heading', { name: 'Script task', exact: true }));
    const steps = page.getByRole('region', { name: 'Steps' });
    await steps.getByRole('button', { name: 'Set a value', exact: true }).click();
    // On rejection, a rule check first, and a link to the end.
    await page.getByTestId('rf__edge-on_reject').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('businessRuleTask');
    await visible(page.getByRole('heading', { name: 'Rule check', exact: true }));
    await page.getByTestId('rf__node-check_1').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('link');
    await visible(page.getByRole('heading', { name: 'Link', exact: true }));
    await shot(page, '15f-process-script-check-link');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['script_1']).toMatchObject({ type: 'scriptTask', steps: [{ type: 'set' }] });
    expect(saved.elements['check_1']).toEqual({ type: 'businessRuleTask', name: 'Check the rules' });
    expect(saved.elements['link_1']).toMatchObject({ type: 'intermediateThrowEvent', link: 'link_1' });
    expect(saved.elements['land_1']).toMatchObject({ type: 'intermediateCatchEvent', link: 'link_1' });
  });

  it('designs an event-based gateway, and a process that starts when a condition comes to hold', async () => {
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with waits', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    const canvas = page.getByTestId('process-canvas');
    await visible(canvas);
    // Once approved, wait for the first of a day or the next decision.
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('eventBasedGateway');
    await visible(page.getByRole('heading', { name: 'Event-based gateway', exact: true }));
    await visible(canvas.getByText('One day', { exact: true }));
    // The process starts by itself on long leave.
    await canvas.getByText('Leave requested', { exact: true }).click();
    await page.getByLabel('Starts', { exact: true }).selectOption('condition');
    await visible(page.getByRole('group', { name: 'Starts when this comes to hold' }));
    await shot(page, '15g-process-event-gateway');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['first_1']).toEqual({ type: 'eventBasedGateway', name: 'What comes first?' });
    expect(saved.elements['requested']).toMatchObject({ type: 'startEvent', actions: [], condition: { exists: 'record.kind' } });
  });

  it('designs a sub-process with a task inside it, and a call to another process of the app', async () => {
    // The leave template, with a second process on the same requests, for the first to call.
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with a review', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const current = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json();
    current.definition.processes.second_look = {
      label: 'Second look',
      entity: 'leave_request',
      elements: { start: { type: 'startEvent', name: 'Start' }, end: { type: 'endEvent', name: 'Seen' } },
      flows: { through: { from: 'start', to: 'end' } },
    };
    const put = await t.app.inject({ method: 'PUT', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies, payload: { definition: current.definition, baseRevision: current.revision } });
    expect(put.statusCode, put.body).toBe(200);

    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    const canvas = page.getByTestId('process-canvas');
    await page.getByLabel('Process', { exact: true }).selectOption('leave_approval');
    await visible(canvas.getByText('Decide on the leave', { exact: true }));
    // A rejection calls the second look.
    await page.getByTestId('rf__edge-on_reject').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('callActivity');
    await visible(page.getByRole('heading', { name: 'Call process', exact: true }));
    await visible(page.getByRole('button', { name: 'Open Second look', exact: true }));
    // Once approved, a review runs as a sub-process, with its own start and end.
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('subProcess');
    await visible(page.getByRole('heading', { name: 'Sub-process', exact: true }));
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Review');
    // After the start event inside it, a task goes inside it too.
    await page.getByTestId('rf__node-start_1').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('manualTask');
    await visible(page.getByRole('heading', { name: 'Manual task', exact: true }));
    await shot(page, '15e-process-sub-and-call');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 3' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['sub_1']).toEqual({ type: 'subProcess', name: 'Review' });
    expect(saved.elements['manual_1']).toMatchObject({ type: 'manualTask', in: 'sub_1' });
    expect(saved.elements['call_1']).toEqual({ type: 'callActivity', name: 'Second look', process: 'second_look' });

    // The called process opens from the call.
    await page.getByTestId('process-canvas').getByText('Second look', { exact: true }).click();
    await page.getByRole('button', { name: 'Open Second look', exact: true }).click();
    await visible(page.getByTestId('process-canvas').getByText('Seen', { exact: true }));
  });

  it('designs a transaction that books a room and frees it again, with a cancel and an escalation', async () => {
    // The leave template, with an action that books a room and one that frees it.
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with a room', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const current = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json();
    const update = (label: string, set: Record<string, string>) => ({ label, description: `${label}.`, entity: 'leave_request', operation: 'update', input: [], set, confirm: 'none' });
    current.definition.actions.book_room = update('Book a room', { reason: 'Room booked' });
    current.definition.actions.free_room = update('Free the room', { reason: 'Room freed' });
    const put = await t.app.inject({ method: 'PUT', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies, payload: { definition: current.definition, baseRevision: current.revision } });
    expect(put.statusCode, put.body).toBe(200);

    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    const canvas = page.getByTestId('process-canvas');
    await visible(canvas.getByText('Decide on the leave', { exact: true }));
    // Once approved, a transaction books a room, which freeing it undoes.
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('transaction');
    await visible(page.getByRole('heading', { name: 'Transaction', exact: true }));
    await page.getByTestId('rf__node-start_1').click();
    await page.getByRole('button', { name: 'System task', exact: true }).click();
    await page.getByLabel("Runs, with the app's authority").selectOption('book_room');
    await page.getByLabel('Undone by', { exact: true }).selectOption('free_room');
    // Its end cancels it: the transaction gets a cancel event to leave by.
    await page.getByTestId('rf__node-end_1').click();
    await page.getByLabel('As it ends', { exact: true }).selectOption('cancel');
    await visible(canvas.getByText('Cancelled', { exact: true }));
    // The transaction also hears an escalation of the code "late".
    await canvas.getByText('New transaction', { exact: true }).click();
    await page.getByRole('button', { name: 'Hear an escalation', exact: true }).click();
    await page.getByLabel('Hears the escalation', { exact: true }).fill('late');
    await shot(page, '15h-process-transaction');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 3' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['transaction_1']).toEqual({ type: 'subProcess', name: 'New transaction', transaction: true });
    expect(saved.elements['system_1']).toMatchObject({ type: 'serviceTask', in: 'transaction_1', action: 'book_room', undo: 'free_room' });
    expect(saved.elements['end_1']).toEqual({ type: 'endEvent', in: 'transaction_1', terminate: false, cancel: true });
    expect(saved.elements['cancel_1']).toEqual({ type: 'boundaryEvent', name: 'Cancelled', attachedTo: 'transaction_1', interrupting: true, cancel: true });
    expect(saved.elements['escalation_1']).toEqual({ type: 'boundaryEvent', name: 'Escalation', attachedTo: 'transaction_1', interrupting: false, escalation: { code: 'late' } });
  });

  it('designs a signal that takes the task away, and one that a rejection throws', async () => {
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with signals', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    const canvas = page.getByTestId('process-canvas');
    await visible(canvas.getByText('Decide on the leave', { exact: true }));
    // A rejection tells every process of the app that waits for it.
    await page.getByTestId('rf__edge-on_reject').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('signalThrow');
    await visible(page.getByRole('heading', { name: 'Throw a signal', exact: true }));
    await page.getByLabel('Signal', { exact: true }).fill('leave_rejected');
    // When the office closes, the manager's task goes.
    await canvas.getByText('Decide on the leave', { exact: true }).click();
    await page.getByRole('button', { name: 'Hear a signal', exact: true }).click();
    await page.getByLabel('The signal', { exact: true }).fill('office_closed');
    await visible(canvas.getByText('Signalled', { exact: true }));
    await shot(page, '15i-process-signals');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['signal_1']).toEqual({ type: 'intermediateThrowEvent', name: 'Signal', signal: 'leave_rejected' });
    expect(saved.elements['signal_2']).toEqual({ type: 'boundaryEvent', name: 'Signal', attachedTo: 'decide', interrupting: true, signal: 'office_closed' });
  });

  it('designs an event sub-process that a withdrawal starts, and that ends all that runs beside it', async () => {
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with a withdrawal', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const current = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json();
    current.definition.actions.withdraw_leave = { label: 'Withdraw', description: 'Withdraw.', entity: 'leave_request', operation: 'update', input: [], set: { status: 'rejected' }, confirm: 'none' };
    const put = await t.app.inject({ method: 'PUT', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies, payload: { definition: current.definition, baseRevision: current.revision } });
    expect(put.statusCode, put.body).toBe(200);

    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    const canvas = page.getByTestId('process-canvas');
    await visible(canvas.getByText('Decide on the leave', { exact: true }));
    // An event sub-process stands apart, with a start that waits a day by default.
    await page.getByLabel('More BPMN', { exact: true }).selectOption('eventSubProcess');
    await visible(page.getByRole('heading', { name: 'Event sub-process', exact: true }));
    // A withdrawal starts it instead, and it ends all that runs beside it.
    await page.getByTestId('rf__node-start_1').click();
    await page.getByLabel('Starts', { exact: true }).selectOption('actions');
    await page.getByLabel('The action', { exact: true }).selectOption('withdraw_leave');
    await page.getByLabel('It ends all that runs beside it', { exact: true }).check();
    await shot(page, '15j-process-event-sub');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 3' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['when_1']).toEqual({ type: 'subProcess', name: 'New event sub-process', event: true });
    expect(saved.elements['start_1']).toEqual({ type: 'startEvent', in: 'when_1', actions: ['withdraw_leave'], interrupting: true });
  });

  it('designs an ad hoc sub-process, whose work starts at once and which ends on a condition', async () => {
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with checks', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    const canvas = page.getByTestId('process-canvas');
    await visible(canvas.getByText('Decide on the leave', { exact: true }));
    // Once approved, checks that people do in any order.
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('adHocSubProcess');
    await visible(page.getByRole('heading', { name: 'Ad hoc sub-process', exact: true }));
    // With it selected, a user task goes in it, with no flow.
    await page.getByRole('button', { name: 'User task', exact: true }).click();
    await visible(page.getByRole('heading', { name: 'User task', exact: true }));
    // It ends early once a condition holds.
    await canvas.getByText('New ad hoc sub-process', { exact: true }).click();
    await page.getByLabel('It ends early, once a condition holds', { exact: true }).check();
    await visible(page.getByRole('group', { name: 'It ends once this holds' }));
    await shot(page, '15k-process-ad-hoc');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['adhoc_1']).toMatchObject({ type: 'subProcess', name: 'New ad hoc sub-process', adHoc: true, completeWhen: { exists: 'record.kind' } });
    expect(saved.elements['manual_1']).toEqual({ type: 'manualTask', name: 'Some work', in: 'adhoc_1' });
    expect(saved.elements['task_1']).toMatchObject({ type: 'userTask', in: 'adhoc_1' });
    expect(Object.values(saved.flows).filter((flow: any) => flow.to === 'task_1' || flow.from === 'task_1')).toEqual([]);
  });

  it('designs a complex gateway that goes on once enough paths have arrived', async () => {
    const started = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave with a complex gateway', template: 'leave' } });
    expect(started.statusCode, started.body).toBe(201);
    const leaveId: string = started.json().app.id;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/processes`);
    await visible(page.getByTestId('process-canvas').getByText('Decide on the leave', { exact: true }));
    await page.getByTestId('rf__edge-on_approve').locator('.react-flow__edge-textbg').click();
    await page.getByLabel('More BPMN', { exact: true }).selectOption('complexGateway');
    await visible(page.getByRole('heading', { name: 'Complex gateway', exact: true }));
    expect(await page.getByLabel('Goes on once this many paths have arrived', { exact: true }).inputValue()).toBe('1');
    await shot(page, '15l-process-complex-gateway');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition.processes.leave_approval;
    expect(saved.elements['complex_1']).toEqual({ type: 'complexGateway', name: 'Enough paths', waitFor: 1 });
  });
});
