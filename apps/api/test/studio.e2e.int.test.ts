import { createRequire } from 'node:module';
import { EXPENSE_APP } from '@platform/app-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';
import { callTool, modelMessage, say, scriptedModel, type ScriptedModel } from './scripted-model.js';

/**
 * The studio in a real browser, end to end: build an app from the example, rename a field, save,
 * submit a claim through the generated form, and see a colleague's limited view. Each test makes
 * its own apps and records, so it runs alone or in any order (--sequence.shuffle).
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
  textContent(): Promise<string | null>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
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
  last(): Locator;
  filter(options: { hasText: string }): Locator;
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
}
interface Page extends Locator {
  goto(url: string): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { move(x: number, y: number, options?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
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
/** A picture of one pixel, for a file that the builder gives the chat. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe.skipIf(!enabled)('the studio, in a browser', () => {
  let t: TestApp;
  let alice: Session;
  let bob: Session;
  let carol: Session;
  let browser: Browser;
  let model: ScriptedModel;

  beforeAll(async () => {
    // The installation's model, scripted: the chat that builds apps is on.
    model = scriptedModel();
    // Each test makes its own apps, more than a personal space holds by default.
    t = await startTestApp(
      { PUBLIC_BASE_URL: BASE, AI_PROVIDER: 'anthropic', AI_MODEL: 'test-model', AI_API_KEY_FILE: '/run/secrets/unused', PERSONAL_SPACE_MAX_APPS: '100' },
      { models: model.client },
    );
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
  /** Each test makes its own app, so that it runs alone or in any order. */
  const newApp = async (session: Session, name: string, template = 'expenses'): Promise<string> => {
    const created = await t.app.inject({ method: 'POST', url: `/v1/spaces/${session.personalSpaceId}/apps/import`, cookies: session.cookies, payload: { name, template } });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().app.id;
  };
  /** A claim the person submits through the API: a receipt for each line, all on one day. */
  const submitClaim = async (session: Session, appId: string, title: string, lines: ReadonlyArray<{ merchant: string; category: string; amount: number }>): Promise<{ id: string }> => {
    const values = { title, lines: lines.map((line) => ({ date: '2026-11-02', ...line })) };
    const done = await t.app.inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, cookies: session.cookies, payload: { values } });
    expect(done.statusCode, done.body).toBe(201);
    return done.json().record;
  };
  const SINGAPORE = [
    { merchant: 'Comfort taxi', category: 'travel', amount: 32.4 },
    { merchant: 'Marina Bay Sands', category: 'hotel', amount: 270 },
  ];
  const PENANG = [{ merchant: 'Eastern & Oriental', category: 'hotel', amount: 240 }];

  it('builds an app from the example, renames a field and saves it', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await visible(page.getByRole('heading', { name: 'Your apps' }));
    await page.getByLabel('Name').fill('Expenses');
    await page.getByLabel('Start from').selectOption('expenses');
    await shot(page, '1-home');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const appId = page.url().split('/apps/')[1]!.split('/')[0]!;

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

    // The data model as a canvas: each entity a box of its fields, and an arrow to its lines.
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    const model = page.getByTestId('model-canvas');
    await visible(model.getByTestId('model-entity-expense_line'));
    await visible(model.getByText('its lines'));
    // A field chosen on the canvas opens beside it, as in the list.
    await model.getByRole('button', { name: 'Open the field Expense claim: Journey' }).click();
    await visible(panel(page, 'Field').getByLabel('Label', { exact: true }));
    expect(await panel(page, 'Field').getByLabel('Label', { exact: true }).inputValue()).toBe('Journey');
    await shot(page, '2b-data-model');
    // A field added on the canvas opens beside it, to set.
    await model.getByRole('button', { name: 'Add a field to Receipt' }).click();
    expect(await panel(page, 'Field').getByLabel('Label', { exact: true }).inputValue()).toBe('New text');
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('button', { name: 'List', exact: true }).click();

    // The renamed field kept its place on the form.
    await page.goto(`${BASE}/studio/apps/${appId}/build/forms`);
    expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('Claim an expense');
    await visible(page.getByRole('button', { name: 'Journey', exact: true }));
    await shot(page, '4-form-designer');
  });

  it('shows lines under the record they belong to, and works out the total', async () => {
    const appId = await newApp(alice, 'Expenses, lines');
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/data`);
    await page.getByRole('button', { name: /^Total \(SGD\)/ }).click();
    expect(await panel(page, 'Field').getByLabel('Value').inputValue()).toBe('sum:lines.amount');
    await page.getByRole('button', { name: /^Receipts/ }).click();
    await page.getByRole('button', { name: 'Receipt: edit the fields of each line' }).click();
    await visible(page.getByText('These are the lines of'));
    await shot(page, '2b-lines');
  });

  it('submits a claim with its receipts through the generated form, and shows its history', async () => {
    const appId = await newApp(alice, 'Expenses, a claim');
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await page.getByRole('link', { name: '+ Claim an expense' }).click();
    await page.getByLabel('Title').fill('Singapore trip');
    await page.getByLabel('Trip').fill('Singapore');
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
    const appId = await newApp(alice, 'Expenses, proposed');
    const token = await t.app.inject({ method: 'POST', url: '/v1/me/tokens', cookies: alice.cookies, payload: { name: 'agent', scopes: ['app.run', 'action.run'], expiresInDays: 1 } });
    const run = await t.app.inject({
      method: 'POST',
      url: `/v1/apps/${appId}/actions/submit_claim/run`,
      headers: { authorization: `Bearer ${token.json().token}` },
      payload: {
        values: { title: 'Penang trip', trip: 'Penang', lines: [{ date: '2026-11-09', merchant: 'Eastern & Oriental', category: 'hotel', amount: 280 }] },
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
    const appId = await newApp(alice, 'Expenses, shared');
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
    const appId = await newApp(alice, 'Expenses, ruled');
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
    const appId = await newApp(alice, 'Expenses, pages');
    await submitClaim(alice, appId, 'Singapore trip', SINGAPORE);
    await submitClaim(alice, appId, 'Penang trip', PENANG);
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/pages`);
    await visible(page.getByRole('button', { name: /^To approve/ }));
    await page.getByLabel('New page').fill('Recent claims');
    await page.getByRole('button', { name: 'Add page' }).click();
    await page.getByLabel('Title (optional)').fill('The latest ten');
    await page.getByLabel('Shows at first').fill('10');
    await page.getByLabel('Trip', { exact: true }).click();
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
    const appId = await newApp(alice, 'Expenses, dashboard');
    await submitClaim(alice, appId, 'Singapore trip', SINGAPORE);
    await submitClaim(alice, appId, 'Penang trip', PENANG);
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
    const appId = await newApp(alice, 'Expenses, query');
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

  it('designs the flow an action runs before it saves, on its canvas like any flow', async () => {
    const appId = await newApp(alice, 'Expenses, before it saves');
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/actions`);
    await page.getByRole('button', { name: /^Approve an expense claim/ }).click();
    // The example checks an approval before it saves: one flow language for all the app's logic.
    expect(await page.getByLabel('Before it saves, runs a flow', { exact: true }).inputValue()).toBe('check_approval');
    await page.getByRole('link', { name: 'Open Check the approval on its canvas' }).click();
    const canvas = page.getByTestId('flow-canvas');
    await visible(canvas.getByTestId('flow-step-steps[2]'));
    await visible(page.getByText('Approve an expense claim runs it before it saves its record', { exact: false }));
    await canvas.getByRole('button', { name: 'Add a step at steps[3]' }).click();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    const step = page.getByRole('region', { name: 'Step' });
    await step.getByLabel('Message', { exact: true }).fill('A claim needs a title');
    await step.getByLabel("When it doesn't hold", { exact: true }).selectOption('warning');
    await visible(canvas.getByText('A claim needs a title', { exact: true }));
    await shot(page, '21-before-it-saves');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.flows.check_approval.steps.at(-1)).toMatchObject({ type: 'check', message: 'A claim needs a title', severity: 'warning' });
    expect(saved.actions.approve_claim.before).toEqual({ flow: 'check_approval', input: { claim: { ref: 'record' } } });
  });

  it('designs a flow that waits on its canvas, and the manager decides in their inbox', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await visible(page.getByRole('heading', { name: 'Your apps' }));
    await page.getByLabel('Name').fill('Leave');
    await page.getByLabel('Start from').selectOption('leave');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const leaveId = page.url().split('/apps/')[1]!.split('/')[0]!;

    // The template's approval is a flow that waits: a person's task with a way on for each outcome.
    await page.getByRole('link', { name: 'Flows', exact: true }).click();
    const canvas = page.getByTestId('flow-canvas');
    await visible(canvas.getByTestId('flow-step-steps[0]').getByText('Decide on the leave'));
    await visible(canvas.getByTestId('flow-step-steps[0]').getByText('the manager'));
    await visible(canvas.getByText('Approve', { exact: true }));
    await visible(canvas.getByText('Reject', { exact: true }));
    // The flow saves where it waits, and the action that asks for leave starts it.
    await visible(canvas.getByText('saves', { exact: true }).first());
    await visible(page.getByText('Ask for leave starts it, as it saves its record.'));
    await shot(page, '14-flow-waits');

    // The manager has three days: then the task ends, and the flow goes on by the deadline's way.
    await canvas.getByTestId('flow-step-steps[0]').click();
    await visible(page.getByRole('heading', { name: "Person's task" }));
    await page.getByLabel('It has a deadline').check();
    await visible(canvas.getByTestId('flow-wait-steps[0]:deadline').getByText('After 3 days'));
    await page.getByRole('button', { name: 'Close the step' }).click();
    // Once the manager decides, the flow waits for the first day of the leave.
    await page.getByRole('button', { name: 'Add a step at steps[1]' }).click();
    await page.getByRole('button', { name: 'Wait', exact: true }).click();
    await visible(canvas.getByTestId('flow-wait-steps[1]').getByText('Waits 1 day'));
    await page.getByLabel('Wait for').selectOption('date');
    await visible(canvas.getByTestId('flow-wait-steps[1]').getByText('Waits until First day'));
    await shot(page, '15-flow-wait');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save as revision 2' }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const dark = await open(alice, 'dark');
    await dark.goto(`${BASE}/studio/apps/${leaveId}/build/flows`);
    await visible(dark.getByTestId('flow-canvas').getByText('Decide on the leave'));
    await shot(dark, '15b-flow-waits-dark');

    // Alice asks for leave, naming Bob; the decision waits in his inbox.
    await t.app.inject({ method: 'POST', url: `/v1/apps/${leaveId}/shares`, cookies: alice.cookies, payload: { email: 'bob@example.com', role: 'manager' } });
    const asked = await t.app.inject({
      method: 'POST',
      url: `/v1/apps/${leaveId}/actions/request_leave/run`,
      cookies: alice.cookies,
      payload: { values: { kind: 'annual', starts: '2026-12-28', ends: '2026-12-30', days: 3, manager: bob.userId } },
    });
    expect(asked.statusCode, asked.body).toBe(201);
    // Live, the canvas counts the cases at each step, and so does its list.
    const builder = await open(alice);
    await builder.goto(`${BASE}/studio/apps/${leaveId}/build/flows`);
    await builder.getByRole('button', { name: 'Live', exact: true }).click();
    await visible(builder.getByTestId('flow-step-steps[0]').getByText('1 waiting', { exact: false }));
    await shot(builder, '16a-flow-live');
    // The count opens its cases, each by its record.
    await builder.getByTestId('flow-step-steps[0]').getByRole('button', { name: /show the cases$/ }).click();
    const cases = builder.getByRole('region', { name: 'Cases at this step' });
    await visible(cases.getByText('Waiting for', { exact: false }));
    await visible(cases.getByRole('link'));
    await shot(builder, '16c-flow-cases');
    await builder.getByRole('button', { name: 'List', exact: true }).click();
    await visible(builder.getByTestId('flow-row-steps[0]').getByText('1 waiting', { exact: false }));
    await shot(builder, '16b-flow-list');
    const inbox = await open(bob);
    await inbox.goto(`${BASE}/studio/tasks`);
    await visible(inbox.getByRole('heading', { name: 'Decide on the leave' }));
    await shot(inbox, '16-inbox');
    await inbox.getByRole('button', { name: 'Approve', exact: true }).click();
    await visible(inbox.getByText('Nothing waits for you'));

    // The record shows its flow waiting for the first day of the leave.
    const record = await open(alice);
    await record.goto(`${BASE}/studio/apps/${leaveId}/leave_request/${asked.json().record.id}`);
    await visible(record.getByText('Leave approval', { exact: true }));
    await visible(record.getByText('Waits until First day'));
    await shot(record, '17-record-flow');
  });

  it('starts a flow that waits by itself, reminds while a task waits, repeats steps, and runs a flow on a schedule', async () => {
    // Its own app, so that it runs whatever ran before it.
    const created = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave, by itself', template: 'leave' } });
    expect(created.statusCode, created.body).toBe(201);
    const leaveId = created.json().app.id as string;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/flows`);
    const canvas = page.getByTestId('flow-canvas');
    await visible(canvas.getByText('Decide on the leave'));

    // It starts by itself two days before the first day of the leave, too.
    const starts = page.getByRole('region', { name: 'How it starts' });
    await starts.getByRole('button', { name: 'Add a way it starts by itself' }).click();
    await starts.getByLabel('Start 1', { exact: true }).selectOption('date');
    await starts.getByLabel('When', { exact: true }).selectOption('before');
    await visible(canvas.getByText('on 1 day before First day', { exact: false }));

    // A reminder hangs below the task, before its deadline, and runs its own steps.
    await canvas.getByTestId('flow-step-steps[0]').click();
    await page.getByRole('button', { name: 'Add a reminder' }).click();
    await page.getByLabel('It has a deadline').check();
    await visible(canvas.getByTestId('flow-wait-steps[0]:reminder:0').getByText('After 1 day'));
    await visible(canvas.getByTestId('flow-wait-steps[0]:deadline').getByText('After 3 days'));
    await canvas.getByTestId('flow-slot-steps[0].reminders[0].steps').getByRole('button', { name: 'Add a step here' }).click();
    await page.getByRole('button', { name: 'Set a variable', exact: true }).click();
    await page.getByRole('button', { name: 'Close the step' }).click();

    // After the decision, steps that wait repeat while the record says so.
    await page.getByRole('button', { name: 'Add a step at steps[1]' }).click();
    await page.getByRole('button', { name: 'Repeat while', exact: true }).click();
    await visible(canvas.getByTestId('flow-step-steps[1]').getByText('Repeats while', { exact: false }));
    await canvas.getByTestId('flow-slot-steps[1].steps').getByRole('button', { name: 'Add a step here' }).click();
    await page.getByRole('button', { name: 'Wait', exact: true }).click();
    await visible(canvas.getByTestId('flow-wait-steps[1].steps[0]').getByText('Waits 1 day'));
    await page.getByRole('button', { name: 'Close the step' }).click();
    await shot(page, '15c-flow-starts-reminders');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));

    // A flow that needs no input runs every weekday at seven, with the app's authority.
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/flows`);
    await page.getByLabel('New flow').fill('Tidy up');
    await page.getByRole('button', { name: 'Add flow' }).click();
    await canvas.getByRole('button', { name: 'Add a step here' }).click();
    await page.getByRole('button', { name: 'Set a variable', exact: true }).click();
    const step = page.getByRole('region', { name: 'Step' });
    // A value can be a date some days away, worked out when the flow runs.
    await step.getByLabel('Value: how', { exact: true }).selectOption('shift');
    await step.getByLabel('Value, how many', { exact: true }).fill('14');
    await visible(canvas.getByText('today + 14 days', { exact: false }));
    await shot(page, '15d-flow-value-date');
    await page.getByRole('button', { name: 'Close the step' }).click();
    const tidy = page.getByRole('region', { name: 'How it starts' });
    await tidy.getByLabel('It runs by itself, on a schedule').check();
    await tidy.getByLabel('At', { exact: true }).fill('07:00');
    await visible(tidy.getByText("Every weekday at 07:00 UTC, with the app's authority."));
    await visible(canvas.getByText('every weekday at 07:00 UTC', { exact: false }));
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    await visible(tidy.getByText('It runs next', { exact: false }));
    await shot(page, '15e-flow-schedule');
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.flows.tidy_up.schedule).toEqual({ every: 'weekday', at: '07:00' });
    expect(saved.flows.leave_approval.starts).toEqual([{ date: 'starts', before: 'P1D' }]);
    expect(saved.flows.leave_approval.steps[0].reminders).toEqual([{ after: 'P1D', steps: [{ type: 'set', var: 'value', value: 0 }] }]);
  });

  it('tells people from a flow, and each reads their notices', async () => {
    const created = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave, told', template: 'leave' } });
    expect(created.statusCode, created.body).toBe(201);
    const leaveId = created.json().app.id as string;
    await t.app.inject({ method: 'POST', url: `/v1/apps/${leaveId}/shares`, cookies: alice.cookies, payload: { email: 'bob@example.com', role: 'manager' } });
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/flows`);
    const canvas = page.getByTestId('flow-canvas');
    // Once the manager approves, the flow tells the person who asked.
    await canvas.getByTestId('flow-slot-steps[0].outcomes[0].steps').getByRole('button', { name: 'Add a step here' }).click();
    await page.getByRole('button', { name: 'Inform people', exact: true }).click();
    const step = page.getByRole('region', { name: 'Step' });
    await step.getByLabel('Tells 1', { exact: true }).selectOption('person:leave.owner');
    await step.getByLabel('Title', { exact: true }).fill('Your leave is approved');
    await visible(canvas.getByTestId('flow-step-steps[0].outcomes[0].steps[0]').getByText('Your leave is approved', { exact: false }));
    await visible(canvas.getByTestId('flow-step-steps[0].outcomes[0].steps[0]').getByText('to the owner, by email too'));
    await shot(page, '15f-flow-inform');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));

    // Alice asks; Bob hears of the task, and approves it.
    const asked = await t.app.inject({
      method: 'POST',
      url: `/v1/apps/${leaveId}/actions/request_leave/run`,
      cookies: alice.cookies,
      payload: { values: { kind: 'annual', starts: '2026-12-28', ends: '2026-12-30', days: 3, manager: bob.userId } },
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const manager = await open(bob);
    await manager.goto(`${BASE}/studio/notices`);
    await visible(manager.getByRole('link', { name: /^Notices, \d+ unread$/ }));
    const group = manager.getByTestId('notice-group').filter({ hasText: 'Leave, told' }).first();
    await visible(group.getByText('Decide on the leave'));
    await shot(manager, '16c-notices');
    await group.getByRole('button', { name: /^Mark read/ }).click();
    await hidden(group);
    const task = (await t.app.inject({ method: 'GET', url: '/v1/me/tasks?status=open', cookies: bob.cookies })).json().tasks.find((each: { recordId: string }) => each.recordId === asked.json().record.id);
    const done = await t.app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/complete`, cookies: bob.cookies, payload: { outcome: 'approve' } });
    expect(done.statusCode, done.body).toBe(200);

    // Alice reads that it's approved, linked to her request.
    const requester = await open(alice);
    await requester.goto(`${BASE}/studio/notices`);
    const told = requester.getByTestId('notice-group').filter({ hasText: 'Your leave is approved' });
    await visible(told.getByRole('link', { name: 'Leave request: Annual leave' }));
    await shot(requester, '16d-notice-told');
  });

  it('connects to a service, keeps its secret, calls it from a flow, and makes a webhook key', async () => {
    const created = await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, cookies: alice.cookies, payload: { name: 'Leave, connected', template: 'leave' } });
    expect(created.statusCode, created.body).toBe(201);
    const leaveId = created.json().app.id as string;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/connections`);
    // A service that flows call, and how it knows the app.
    await page.getByLabel('New connection', { exact: true }).fill('Payroll');
    await page.getByRole('button', { name: 'Add connection' }).click();
    const editor = page.getByRole('region', { name: 'Connection' });
    await editor.getByLabel('Address', { exact: true }).fill('https://payroll.example.com/api');
    await visible(page.getByText('Flows call it, with a bearer token'));
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    // Its secret is kept for the sandbox, and never shown again.
    const secrets = page.getByRole('region', { name: 'Secrets' });
    await visible(secrets.getByText('No secret yet', { exact: false }));
    await secrets.getByLabel('Payroll: the secret', { exact: true }).fill('tok-123');
    await secrets.getByRole('button', { name: 'Keep it' }).click();
    await visible(secrets.getByText('A secret is kept', { exact: false }));
    await shot(page, '24a-connections');

    // A flow asks payroll, and keeps what it answers.
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/flows`);
    await page.getByLabel('New flow').fill('Check the balance');
    await page.getByRole('button', { name: 'Add flow' }).click();
    const canvas = page.getByTestId('flow-canvas');
    await canvas.getByRole('button', { name: 'Add a step here' }).click();
    await page.getByRole('button', { name: 'Call a service', exact: true }).click();
    const step = page.getByRole('region', { name: 'Step' });
    await step.getByLabel('Path', { exact: true }).fill('/balances');
    await step.getByLabel('New variable', { exact: true }).fill('days_left');
    await step.getByRole('button', { name: 'Keep a value' }).click();
    await step.getByLabel('days_left: from', { exact: true }).fill('data.days');
    await step.getByLabel('days_left: kind', { exact: true }).selectOption('number');
    await visible(canvas.getByTestId('flow-step-steps[0]').getByText('GET /balances → days_left'));
    await shot(page, '24b-flow-call');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));

    // A webhook lets payroll run a flow; its key shows once.
    await page.goto(`${BASE}/studio/apps/${leaveId}/build/webhooks`);
    await page.getByLabel('New webhook', { exact: true }).fill('From payroll');
    await page.getByRole('button', { name: 'Add webhook' }).click();
    await page.getByLabel('The flow it runs', { exact: true }).selectOption('check_the_balance');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const keys = page.getByRole('region', { name: 'Secrets' });
    await keys.getByRole('button', { name: 'Make its key' }).click();
    await visible(keys.getByText('Its key, shown this once', { exact: false }));
    await shot(page, '24c-webhooks');
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${leaveId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.connections.payroll).toEqual({ kind: 'service', label: 'Payroll', url: 'https://payroll.example.com/api', auth: { type: 'bearer' }, personalData: false });
    expect(saved.webhooks.from_payroll).toMatchObject({ label: 'From payroll', flow: 'check_the_balance' });
  });

  it('designs a flow on its canvas, tries it on a claim, and an action runs it', async () => {
    const appId = await newApp(alice, 'Expenses, a flow');
    await submitClaim(alice, appId, 'Singapore trip', SINGAPORE);
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/flows`);
    await page.getByLabel('New flow').fill('Count the lines');
    await page.getByRole('button', { name: 'Add flow' }).click();
    const settings = page.getByRole('region', { name: 'Flow' });
    await settings.getByLabel('New input').fill('claim');
    await settings.getByRole('button', { name: 'Add an input' }).click();
    await settings.getByLabel('Input claim', { exact: true }).selectOption('record');
    await settings.getByLabel('Input claim: entity', { exact: true }).selectOption('expense_claim');
    await settings.getByLabel('Result', { exact: true }).selectOption('number');

    // The first step goes in the empty flow's slot, the next on the arrow below it.
    const canvas = page.getByTestId('flow-canvas');
    await canvas.getByRole('button', { name: 'Add a step here' }).click();
    await page.getByRole('button', { name: 'Count or total', exact: true }).click();
    const step = page.getByRole('region', { name: 'Step' });
    await visible(step.getByRole('heading', { name: 'Count or total' }));
    expect(await step.getByLabel('Of', { exact: true }).inputValue()).toBe('claim.lines');
    await visible(canvas.getByTestId('flow-step-steps[0]').getByText('how many → total'));
    await canvas.getByRole('button', { name: 'Add a step at steps[1]' }).click();
    await page.getByRole('button', { name: 'Return a result', exact: true }).click();
    await step.getByLabel('Result: how', { exact: true }).selectOption('field');
    await step.getByLabel('Result', { exact: true }).selectOption('total');
    await visible(canvas.getByText('returns total', { exact: true }));
    await shot(page, '24-flow-designer');

    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    let saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.flows.count_the_lines).toEqual({
      label: 'Count the lines',
      input: { claim: { type: 'record', entity: 'expense_claim' } },
      output: { type: 'number' },
      steps: [
        { type: 'total', var: 'total', of: 'claim.lines', op: 'count' },
        { type: 'return', value: { ref: 'total' } },
      ],
    });

    // Trying it runs the saved flow on a real claim, and undoes what it did.
    const claims = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/entities/expense_claim/records`, cookies: alice.cookies })).json().records;
    const trip = claims.find((claim: { values: { title?: string } }) => claim.values.title === 'Singapore trip');
    const record = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/entities/expense_claim/records/${trip.id}`, cookies: alice.cookies })).json();
    await page.getByRole('button', { name: 'Close the step' }).click();
    const trying = page.getByRole('region', { name: 'Try it' });
    await trying.getByLabel('claim (Expense claim)', { exact: true }).selectOption(trip.id);
    await trying.getByRole('button', { name: 'Try it', exact: true }).click();
    await visible(trying.getByText('It would create 0, change 0 and delete 0 record(s).'));
    await visible(trying.getByText(`Result: ${record.values.lines.length}`));
    await shot(page, '25-flow-try');

    // An action runs the flow on its record, after it saves it.
    await page.goto(`${BASE}/studio/apps/${appId}/build/actions`);
    await page.getByRole('button', { name: /^Approve an expense claim/ }).click();
    await page.getByLabel('Then runs a flow', { exact: true }).selectOption('count_the_lines');
    // Its record input is the claim itself, as it is for the flow before it saves.
    await visible(page.getByText('is the expense claim itself.', { exact: false }).last());
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.actions.approve_claim.flow).toEqual({ flow: 'count_the_lines', input: { claim: { ref: 'record' } } });
  });

  it('shows a loop, a decision and an error handler on the flow canvas', async () => {
    const appId = await newApp(alice, 'Expenses, a loop');
    const current = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json();
    current.definition.flows.check_claim = {
      label: 'Check a claim',
      input: { claim: { type: 'record', entity: 'expense_claim' } },
      steps: [
        { type: 'set', var: 'big', value: 0 },
        {
          type: 'each',
          in: 'claim.lines',
          as: 'line',
          steps: [{ type: 'if', when: { gt: [{ ref: 'line.amount' }, 100] }, then: [{ type: 'set', var: 'big', value: { add: [{ ref: 'big' }, 1] } }], else: [] }],
        },
        { type: 'try', steps: [{ type: 'change', record: 'claim', values: { title: { concat: [{ ref: 'claim.title' }, ' (checked)'] } } }], catch: [], rollback: true },
        { type: 'check', assert: { lt: [{ ref: 'big' }, 5] }, message: 'Many receipts are over 100', severity: 'warning' },
      ],
    };
    const put = await t.app.inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies, payload: { definition: current.definition, baseRevision: current.revision } });
    expect(put.statusCode, put.body).toBe(200);

    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/flows`);
    await page.getByLabel('Which flow', { exact: true }).selectOption('check_claim');
    const canvas = page.getByTestId('flow-canvas');
    await visible(canvas.getByText('For each line in claim.lines', { exact: true }));
    await shot(page, '26-flow-canvas');
    await visible(canvas.getByText('if it fails', { exact: true }));
    await visible(canvas.getByText('line.amount is more than 100', { exact: true }));
    await shot(page, '26-flow-canvas');
    // A frame folds to one box, which says how many steps it holds, and unfolds again.
    await canvas.getByRole('button', { name: 'Fold For each line in claim.lines' }).click();
    await visible(canvas.getByTestId('flow-step-steps[1]').getByText('2 steps inside'));
    await hidden(canvas.getByText('line.amount is more than 100', { exact: true }));
    await canvas.getByRole('button', { name: 'Unfold For each line in claim.lines' }).click();
    // A step opens beside the canvas, and sees the loop's item.
    await canvas.getByText('line.amount is more than 100', { exact: true }).click();
    const step = page.getByRole('region', { name: 'Step' });
    await visible(step.getByRole('heading', { name: 'Decision' }));
    await step.getByRole('button', { name: 'Remove the step' }).click();
    await visible(page.getByText('Unsaved changes.'));
    await page.getByRole('button', { name: 'Discard' }).click();
    await hidden(page.getByText('Unsaved changes.'));
  });

  it('builds a form that adapts: in steps, a field that shows and is required when a claim is large', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await page.getByLabel('Name').fill('Claims in steps');
    await page.getByLabel('Start from').selectOption('expenses');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const stepsId = page.url().split('/apps/')[1]!.split('/')[0]!;

    // The data model says when a bank account is required: every way of writing a claim checks it.
    await page.getByRole('button', { name: /^Bank account/ }).click();
    const required = page.getByRole('group', { name: 'Required when' });
    await required.getByRole('button', { name: 'Add a condition' }).click();
    await required.getByLabel('Field').selectOption('record.total');
    await required.getByLabel('Test').selectOption('gt');
    await required.getByLabel('Value').fill('1000');

    // The form asks a step at a time, and shows the bank account only for a large claim. The draft goes along.
    await page.getByRole('link', { name: 'Forms', exact: true }).click();
    await page.getByLabel('Shows', { exact: true }).selectOption('steps');
    await page.getByRole('button', { name: 'Bank account', exact: true }).click();
    const shows = page.getByRole('group', { name: 'Shows when' });
    await shows.getByRole('button', { name: 'Add a condition' }).click();
    await shows.getByLabel('Field').selectOption('record.total');
    await shows.getByLabel('Test').selectOption('gt');
    await shows.getByLabel('Value').fill('1000');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${stepsId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'iban').requiredWhen).toEqual({ gt: [{ ref: 'record.total' }, 1000] });
    expect(saved.forms.claim_form).toMatchObject({ layout: 'steps', sections: [{}, {}, { fields: [{ field: 'iban', visibleWhen: { gt: [{ ref: 'record.total' }, 1000] } }] }] });

    // The person fills it in a step at a time, and each step is checked before the next.
    await page.goto(`${BASE}/studio/apps/${stepsId}/new/claim_form`);
    const path = page.getByRole('list', { name: 'The steps of Claim an expense' });
    await visible(path.getByText('What it was', { exact: true }));
    await page.getByRole('button', { name: 'Next: Receipts' }).click();
    await visible(page.getByText('Title is required', { exact: true }));
    await page.getByLabel('Title').fill('Summit in Tokyo');
    await page.getByRole('button', { name: 'Next: Receipts' }).click();
    await page.getByLabel('Receipt 1, Date').fill('2026-11-02');
    await page.getByLabel('Receipt 1, Merchant').fill('Hotel Okura');
    await page.getByLabel('Receipt 1, Category').selectOption('hotel');
    await page.getByLabel('Receipt 1, Amount (SGD)').fill('1500');
    await page.getByRole('button', { name: 'Next: Paying you back' }).click();
    // A large claim shows the bank account, and needs it.
    await visible(page.getByLabel('Bank account'));
    await shot(page, '28-form-in-steps');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByText('Bank account is required', { exact: true }));
    await page.getByLabel('Bank account').fill('SG99 ALICE');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByRole('heading', { name: 'Summit in Tokyo' }));

    // A small claim never sees the bank account.
    await page.goto(`${BASE}/studio/apps/${stepsId}/new/claim_form`);
    await page.getByLabel('Title').fill('Taxi');
    await page.getByRole('button', { name: 'Next: Receipts' }).click();
    await page.getByLabel('Receipt 1, Date').fill('2026-11-03');
    await page.getByLabel('Receipt 1, Merchant').fill('Comfort taxi');
    await page.getByLabel('Receipt 1, Category').selectOption('travel');
    await page.getByLabel('Receipt 1, Amount (SGD)').fill('25');
    await page.getByRole('button', { name: 'Next: Paying you back' }).click();
    await hidden(page.getByLabel('Bank account'));
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByRole('heading', { name: 'Taxi' }));
  });

  it('works a field out by a formula: a form shows it as people type, and the platform stores it', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await page.getByLabel('Name').fill('Claims with tax');
    await page.getByLabel('Start from').selectOption('expenses');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const taxId = page.url().split('/apps/')[1]!.split('/')[0]!;

    // A number worked out from the claim's total: nobody fills it in, and nobody can set it.
    await page.getByLabel('Type of the new field').selectOption('number');
    await page.getByRole('button', { name: 'Add field' }).click();
    const field = panel(page, 'Field');
    await field.getByLabel('Label', { exact: true }).fill('With tax (SGD)');
    await field.getByLabel('Name', { exact: true }).fill('with_tax');
    await field.getByLabel('Name', { exact: true }).blur();
    await field.getByLabel('Decimals', { exact: true }).fill('2');
    await field.getByLabel('Value', { exact: true }).selectOption('formula');
    await field.getByLabel('Formula: how', { exact: true }).selectOption('calc');
    await field.getByLabel('Formula, first: from', { exact: true }).selectOption('record.total');
    await field.getByLabel('Formula, operation', { exact: true }).selectOption('mul');
    await field.getByLabel('Formula, second', { exact: true }).fill('1.09');
    // Nobody can be asked for it.
    await hidden(field.getByText('Required', { exact: true }));
    await shot(page, '30-formula');

    // The claim form shows it, read-only.
    await page.getByRole('link', { name: 'Forms', exact: true }).click();
    await page.getByRole('button', { name: 'Add With tax (SGD) to the form' }).click();
    await page.getByRole('button', { name: 'Review and save' }).click();
    await visible(page.getByText('Work out expense_claim.with_tax for existing records'));
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${taxId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'with_tax')).toMatchObject({ formula: { mul: [{ ref: 'record.total' }, 1.09] }, decimals: 2, required: false });
    expect(saved.forms.claim_form.sections.flatMap((s: { fields: unknown[] }) => s.fields)).toContainEqual(expect.objectContaining({ field: 'with_tax', readOnly: true }));

    // As people type, the form works it out as the platform will; the platform stores it.
    await page.goto(`${BASE}/studio/apps/${taxId}/new/claim_form`);
    await page.getByLabel('Title').fill('Summit in Tokyo');
    await page.getByLabel('Receipt 1, Date').fill('2026-11-02');
    await page.getByLabel('Receipt 1, Merchant').fill('Hotel Okura');
    await page.getByLabel('Receipt 1, Category').selectOption('hotel');
    await page.getByLabel('Receipt 1, Amount (SGD)').fill('150');
    await visible(page.locator('#field-with_tax').filter({ hasText: '163.50' }));
    await shot(page, '31-formula-on-a-form');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByRole('heading', { name: 'Summit in Tokyo' }));
    const records = (await t.app.inject({ method: 'GET', url: `/v1/apps/${taxId}/entities/expense_claim/records`, cookies: alice.cookies })).json().records;
    expect(records[0].values).toMatchObject({ total: 150, with_tax: 163.5 });
  });

  it('links a claim to several trips: the form finds them by title, and the claim links to each', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await page.getByLabel('Name').fill('Claims for trips');
    await page.getByLabel('Start from').selectOption('expenses');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const tripsId = page.url().split('/apps/')[1]!.split('/')[0]!;

    // Trips, and claims that are for several of them: many to many.
    await page.getByLabel('New entity').fill('Trip');
    await page.getByRole('button', { name: 'Add entity' }).click();
    await page.getByLabel('Plural label').fill('Trips');
    await page.getByRole('button', { name: /^Expense claim/ }).click();
    await page.getByLabel('Type of the new field').selectOption('reference');
    await page.getByRole('button', { name: 'Add field' }).click();
    const field = panel(page, 'Field');
    await field.getByLabel('Label', { exact: true }).fill('Trips');
    await field.getByLabel('Name', { exact: true }).fill('trips');
    await field.getByLabel('Name', { exact: true }).blur();
    await field.getByLabel('Links to', { exact: true }).selectOption('trip');
    await field.getByLabel('Several trips, not one').check();
    // On the claim form, which its action now takes.
    await page.getByRole('link', { name: 'Forms', exact: true }).click();
    await page.getByRole('button', { name: 'Add Trips to the form' }).click();
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${tripsId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'trips')).toMatchObject({ type: 'reference', entity: 'trip', multiple: true });
    expect(saved.actions.submit_claim.input).toContain('trips');
    for (const title of ['Tokyo summit', 'Penang retreat']) {
      await t.app.inject({ method: 'POST', url: `/v1/apps/${tripsId}/entities/trip/records`, cookies: alice.cookies, payload: { values: { title } } });
    }

    // The form finds trips by their titles, and shows those chosen.
    await page.goto(`${BASE}/studio/apps/${tripsId}/new/claim_form`);
    await page.getByLabel('Title').fill('Two trips in one');
    await page.getByLabel('Receipt 1, Date').fill('2026-11-02');
    await page.getByLabel('Receipt 1, Merchant').fill('Hotel Okura');
    await page.getByLabel('Receipt 1, Category').selectOption('hotel');
    await page.getByLabel('Receipt 1, Amount (SGD)').fill('300');
    await page.getByLabel('Trips', { exact: true }).fill('tok');
    await page.getByRole('option', { name: 'Tokyo summit' }).click();
    await page.getByLabel('Trips', { exact: true }).fill('PEN');
    await page.getByRole('option', { name: 'Penang retreat' }).click();
    const chosen = page.getByRole('list', { name: 'Trips: chosen' });
    await visible(chosen.getByText('Tokyo summit'));
    await visible(chosen.getByText('Penang retreat'));
    await shot(page, '32-pick-several-trips');
    await page.getByRole('button', { name: 'Submit an expense claim' }).click();
    await visible(page.getByRole('heading', { name: 'Two trips in one' }));
    await shot(page, '33-claim-for-two-trips');

    // The claim names each trip by its title, and opens it.
    await page.getByRole('link', { name: 'Tokyo summit' }).click();
    await visible(page.getByRole('heading', { name: 'Tokyo summit' }));
  });

  it('brings trips in from a file: checks it first, says what is wrong, then brings all of them in', async () => {
    const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
    draft.entities.trip = {
      label: 'Trip',
      pluralLabel: 'Trips',
      titleField: 'name',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'budget', label: 'Budget', type: 'number', decimals: 2, min: 0 },
        { name: 'kind', label: 'Kind', type: 'choice', options: [{ value: 'client', label: 'Client visit' }, { value: 'team', label: 'Team offsite' }] },
      ],
    };
    const tripsApp = (await t.app.inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, cookies: alice.cookies, payload: { name: 'Trips from a file', definition: draft } })).json().app.id;
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${tripsApp}/trip`);
    await page.getByRole('button', { name: 'Bring in from a file' }).click();

    // A file with a problem: nothing comes in, and the line and field say where.
    const file = (text: string) => ({ name: 'trips.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    await page.getByLabel('A CSV file').setInputFiles(file('Name,Budget,Kind,Colour\nTokyo summit,"1,200.00",Client visit,red\nPenang retreat,-5,team,'));
    await visible(page.getByText('One problem in 2 records', { exact: false }));
    await visible(page.getByRole('cell', { name: 'At least 0' }));
    await visible(page.getByText('stays out: No field has this name'));
    await shot(page, '34-import-with-a-problem');

    // Put right, the file comes in whole.
    await page.getByLabel('A CSV file').setInputFiles(file('Name,Budget,Kind\nTokyo summit,"1,200.00",Client visit\nPenang retreat,800,team'));
    await page.getByRole('button', { name: 'Bring in 2 trips' }).click();
    await visible(page.getByText('Brought in 2 trips.'));
    await visible(page.getByRole('cell', { name: 'Tokyo summit' }));
    await visible(page.getByRole('cell', { name: 'Penang retreat' }));
    await shot(page, '35-imported-trips');
  });

  it('marks a problem on its step as the builder makes it, and undoes and redoes changes', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await page.getByLabel('Name').fill('Claims to check');
    await page.getByLabel('Start from').selectOption('expenses');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const checkId = page.url().split('/apps/')[1]!.split('/')[0]!;
    await visible(page.getByText('No problems', { exact: true }));

    // A check with no message: the checks find it as the draft changes, and the step says so.
    await page.goto(`${BASE}/studio/apps/${checkId}/build/flows/check_approval`);
    await page.getByTestId('flow-step-steps[0]').click();
    await page.getByRole('region', { name: 'Step' }).getByLabel('Message', { exact: true }).fill('');
    await visible(page.getByTestId('flow-step-steps[0]').getByRole('img', { name: /^1 problem/ }));
    await page.getByRole('button', { name: '1 problem', exact: true }).click();
    await visible(page.getByRole('region', { name: 'Problems' }).getByRole('link', { name: 'Flows: Check the approval' }));
    await shot(page, '36-a-problem-on-its-step');

    // Undo takes the change back, and redo makes it again; so do the keys, outside a text box.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await visible(page.getByText('No problems', { exact: true }));
    await hidden(page.getByText('Unsaved changes.'));
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await visible(page.getByRole('button', { name: '1 problem', exact: true }));
    await page.getByRole('heading', { name: 'Claims to check' }).click();
    await page.keyboard.press('Control+z');
    await visible(page.getByText('No problems', { exact: true }));
    await page.keyboard.press('Control+Shift+z');
    await visible(page.getByRole('button', { name: '1 problem', exact: true }));
  });

  it('copies, cuts and pastes steps, and moves a step by dragging it onto an arrow', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await page.getByLabel('Name').fill('Claims to rearrange');
    await page.getByLabel('Start from').selectOption('expenses');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const arrangeId = page.url().split('/apps/')[1]!.split('/')[0]!;
    await page.goto(`${BASE}/studio/apps/${arrangeId}/build/flows/check_approval`);
    const step = (path: string) => page.getByTestId(`flow-step-${path}`);
    const words = async (path: string) => (await step(path).textContent()) ?? '';

    // The warning about large claims goes first: dragged onto the arrow before the first step.
    const from = (await step('steps[2]').boundingBox())!;
    const to = (await page.getByRole('button', { name: 'Add a step at steps[0]' }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await visible(step('steps[0]').getByText('A claim over SGD 1,000', { exact: false }));
    expect(await words('steps[1]')).toContain('stops unless');
    await shot(page, '37-a-step-moved');

    // A copy of a step goes after it, by its button or by the keys; a cut takes it out.
    await step('steps[1]').click();
    await page.getByRole('region', { name: 'Step' }).getByRole('button', { name: 'Copy', exact: true }).click();
    await page.getByRole('region', { name: 'Step' }).getByRole('button', { name: 'Paste after', exact: true }).click();
    await visible(step('steps[3]'));
    expect(await words('steps[2]')).toContain('stops unless');
    await page.getByRole('heading', { name: 'Claims to rearrange' }).click();
    await step('steps[0]').click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await visible(step('steps[4]'));
    await step('steps[4]').click();
    await page.keyboard.press('Control+x');
    await hidden(step('steps[4]'));
    // Undo puts back what the cut took out.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await visible(step('steps[4]'));
  });

  it('writes a test of what the app must do, saves it, and runs it', async () => {
    const page = await open(alice);
    await page.goto(`${BASE}/studio/`);
    await page.getByLabel('Name').fill('Claims with tests');
    await page.getByLabel('Start from').selectOption('expenses');
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.waitForURL(/\/build\/data$/);
    const testedId = page.url().split('/apps/')[1]!.split('/')[0]!;
    await page.getByRole('link', { name: 'Tests', exact: true }).click();

    // A claim with no receipts is refused, whoever submits it.
    await page.getByLabel('New test').fill('No receipts, no claim');
    await page.getByRole('button', { name: 'Add test' }).click();
    const test = page.getByRole('region', { name: 'Test', exact: true });
    await test.getByLabel('What they give: add a value').selectOption('title');
    await test.getByLabel('What they give: Title').fill('Taxi');
    await test.getByLabel('It must').selectOption('refused');
    await shot(page, '38-a-test');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${testedId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.tests.no_receipts_no_claim).toMatchObject({ when: { action: 'submit_claim', as: 'requester', values: { title: 'Taxi' } }, then: { outcome: 'refused' } });

    // It runs on the saved app, and passes.
    await page.getByRole('button', { name: 'Run the tests' }).click();
    await visible(page.getByText('All passed'));
    await visible(page.getByRole('list', { name: 'Test results' }).getByText('No receipts, no claim'));
    await shot(page, '39-tests-passed');
  });

  it('designs a page about one claim, with its fields and tabs, which a row of a list opens', async () => {
    const appId = await newApp(alice, 'Expenses, a claim page');
    await submitClaim(alice, appId, 'Singapore trip', SINGAPORE);
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/pages`);
    await page.getByLabel('New page').fill('Claim');
    await page.getByRole('button', { name: 'Add page' }).click();
    await page.getByLabel('About', { exact: true }).selectOption('expense_claim');
    await page.getByRole('button', { name: 'Add fields of the record' }).click();
    await page.getByRole('button', { name: 'Add tabs' }).click();
    await page.getByLabel('Tab 1', { exact: true }).fill('Money');
    await page.getByLabel('Tab 2', { exact: true }).fill('Notes');
    await page.getByRole('button', { name: 'Money: add number' }).click();
    // The list a new page starts with goes: this page is about one claim.
    await page.getByRole('button', { name: /^List.*block 1$/ }).click();
    await page.getByRole('button', { name: 'Remove the selected block' }).click();
    await shot(page, '29-record-page-designer');
    // A row of My claims opens the page.
    await page.getByRole('button', { name: /^My claims/ }).click();
    await page.getByRole('button', { name: /^List.*block 2$/ }).click();
    await page.getByLabel('A row opens', { exact: true }).selectOption('claim');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.pages.claim).toMatchObject({ record: { entity: 'expense_claim' }, blocks: [{ type: 'fields' }, { type: 'tabs', tabs: [{ label: 'Money', blocks: [{}, { type: 'stat' }] }, { label: 'Notes' }] }] });
    expect(saved.pages.my_claims.blocks[1].open).toBe('claim');

    // In the app, the row opens the page about that claim: its fields, and its tabs.
    await page.goto(`${BASE}/studio/apps/${appId}`);
    await page.getByRole('link', { name: 'Singapore trip' }).first().click();
    await page.waitForURL(/\/pages\/claim\//);
    await visible(page.getByRole('heading', { name: 'Singapore trip' }));
    await visible(page.getByText('Bank account', { exact: true }));
    const tabs = page.getByRole('group', { name: 'Tabs' });
    await tabs.getByRole('button', { name: 'Notes', exact: true }).click();
    await visible(page.getByText('What the second tab shows.'));
    await shot(page, '30-record-page');
  });

  it('builds by chat: the chat changes the draft, and the builder undoes it or reviews and saves it', async () => {
    const appId = await newApp(alice, 'Expenses, by chat');
    const page = await open(alice);
    await page.goto(`${BASE}/studio/apps/${appId}/build/data`);
    await page.getByRole('button', { name: 'Build by chat' }).click();
    const chat = panel(page, 'Build by chat');
    const prompt = chat.getByLabel('What should the app do?');
    await visible(chat.getByText('never its records'));

    // The provider is busy: what the builder wrote comes back, to send again.
    model.reply({ status: 429, error: { type: 'rate_limit_error', message: 'Slow down' } });
    await prompt.fill('Claims need a cost centre, as on the paper form');
    await chat.getByRole('button', { name: 'Send' }).click();
    await visible(chat.getByText('The model is busy: try again in a minute'));
    expect(await prompt.inputValue()).toBe('Claims need a cost centre, as on the paper form');

    // With a photo of the paper form, the chat adds the field to the draft, and the designers show it.
    model.requests.length = 0;
    const costCentre = { op: 'add', path: '/entities/expense_claim/fields/-', value: { name: 'cost_centre', label: 'Cost centre', type: 'text' } };
    model.reply(modelMessage([callTool('edit_definition', { edits: [costCentre] })], 'tool_use'), modelMessage([say('I added a Cost centre field to claims.')]));
    await chat.getByLabel('Add a picture or PDF').setInputFiles({ name: 'paper-form.png', mimeType: 'image/png', buffer: Buffer.from(PIXEL, 'base64') });
    await visible(chat.getByRole('button', { name: 'Remove paper-form.png' }));
    await chat.getByRole('button', { name: 'Send' }).click();
    await visible(chat.getByText('I added a Cost centre field to claims.'));
    await visible(chat.getByText('Changed the draft: 1 edit.'));
    await visible(page.getByText('Unsaved changes.'));
    await visible(page.getByRole('button', { name: /^Cost centre/ }));
    expect(model.requests[0]!.body['messages'][0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } });
    await shot(page, '16-build-by-chat');

    // Undo takes the change back. Asked again, the chat adds it again, and the builder saves it.
    await chat.getByRole('button', { name: 'Undo' }).click();
    await visible(chat.getByText('You undid this change.'));
    await hidden(page.getByText('Unsaved changes.'));
    model.reply(modelMessage([callTool('edit_definition', { edits: [costCentre] })], 'tool_use'), modelMessage([say('I added it again.')]));
    await prompt.fill('Add it after all');
    await chat.getByRole('button', { name: 'Send' }).click();
    await visible(chat.getByText('I added it again.'));
    // The chat hears what the builder undid, and which files it saw before.
    const history = JSON.stringify(model.requests.at(-2)!.body['messages']);
    expect(history).toContain('The builder undid this change.');
    expect(history).toContain('Files given here, not sent again: paper-form.png');
    await page.getByRole('button', { name: 'Review and save' }).click();
    await visible(page.getByText('Add expense_claim.cost_centre'));
    await page.getByRole('button', { name: /^Save as revision/ }).click();
    await hidden(page.getByText('Unsaved changes.'));
    const saved = (await t.app.inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, cookies: alice.cookies })).json().definition;
    expect(saved.entities.expense_claim.fields.at(-1)).toMatchObject({ name: 'cost_centre', label: 'Cost centre', type: 'text' });
  });
});
