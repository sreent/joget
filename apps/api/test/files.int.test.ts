import { EXPENSE_APP } from '@platform/app-model';
import { auditEvents } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MALWARE_MARKER, startFakeClamd } from './fake-clamd.js';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Receipts: uploaded, checked for what they are and for malware, attached to the line that names
 * them, and downloadable by whoever can see that line, and nobody else.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from('%PDF-1.4\n% a receipt\n');

let t: TestApp;
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
let alice: Session; // builds the app
let bob: Session; // requester
let carol: Session; // approver
let erin: Session; // another requester
let dave: Session; // not in the app
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
const records = () => `/v1/apps/${appId}/entities/expense_claim/records`;
const files = () => `/v1/apps/${appId}/files`;

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}
const upload = (session: Session, content: Buffer, type: string, name = 'receipt.jpg', expected = 201) =>
  inject({ method: 'POST', url: `${files()}?name=${encodeURIComponent(name)}`, ...as(session), headers: { 'content-type': type }, payload: content }, expected);
const claim = (session: Session, receipt: string | null, expected = 201) =>
  inject(
    {
      method: 'POST',
      url: `/v1/apps/${appId}/actions/submit_claim/run`,
      ...as(session),
      payload: { values: { title: 'Taxi', lines: [{ date: '2026-11-02', merchant: 'Comfort', category: 'travel', amount: 32.4, receipt }] } },
    },
    expected,
  );

beforeAll(async () => {
  clamd = await startFakeClamd();
  t = await startTestApp({ FILE_SCANNER: 'clamav', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port), FILE_MAX_BYTES: '65536', PROPOSAL_TTL_HOURS: '1', FILE_UNATTACHED_TTL_HOURS: '1' });
  [alice, bob, carol, erin, dave] = [await t.login('alice'), await t.login('bob'), await t.login('carol'), await t.login('erin'), await t.login('dave')];
  appId = (await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: EXPENSE_APP } }, 201)).json().app.id;
  for (const [email, role] of [['bob@example.com', 'requester'], ['carol@example.com', 'approver'], ['erin@example.com', 'requester']] as const) {
    await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email, role } }, 201);
  }
});

afterAll(async () => {
  await t?.close();
  await clamd?.close();
});

describe('uploading', () => {
  it('reads what a file is from its content, cleans its name, and scans it', async () => {
    const file = (await upload(bob, JPEG, 'application/octet-stream', '../../etc/my receipt.png')).json();
    expect(file).toEqual({ id: expect.any(String), name: 'my receipt.jpg', contentType: 'image/jpeg', size: JPEG.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), scan: 'clean', attached: false });
    expect(clamd.scans).toBeGreaterThan(0);
  });

  it('refuses other kinds of file, files too big, and malware, which it records', async () => {
    expect((await upload(bob, Buffer.from('just text'), 'text/plain', 'notes.txt', 415)).json().error).toBe('unsupported_file_type');
    await upload(bob, Buffer.concat([JPEG, Buffer.alloc(70_000)]), 'image/jpeg', 'big.jpg', 413);
    const infected = await upload(bob, Buffer.concat([PDF, Buffer.from(MALWARE_MARKER)]), 'application/pdf', 'invoice.pdf', 422);
    expect(infected.json()).toMatchObject({ error: 'file_rejected', message: expect.stringContaining('Ambit.Test.Marker') });
    const [event] = await t.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'file.upload'), eq(auditEvents.outcome, 'denied')));
    expect(event!.reason).toMatchObject({ threat: 'Ambit.Test.Marker' });
  });

  it("fails closed when the scanner can't answer", async () => {
    clamd.mode = 'error';
    expect((await upload(bob, JPEG, 'image/jpeg', 'receipt.jpg', 503)).json().error).toBe('scanning_unavailable');
    clamd.mode = 'scan';
  });

  it('is for people who use the app', async () => {
    await upload(dave, JPEG, 'image/jpeg', 'receipt.jpg', 403);
  });
});

describe('attaching and downloading', () => {
  let receipt: string;
  let claimId: string;

  it('attaches a receipt to its line when the claim is saved, and names it', async () => {
    receipt = (await upload(bob, JPEG, 'image/jpeg', 'taxi.jpg')).json().id;
    const record = (await claim(bob, receipt)).json().record;
    claimId = record.id;
    expect(record.values.lines[0].receipt).toBe(receipt);
    expect(record.files).toEqual({ [receipt]: { name: 'taxi.jpg', contentType: 'image/jpeg', size: JPEG.length } });
  });

  it('lets whoever can see the line download it, safely, and nobody else', async () => {
    const own = await inject({ method: 'GET', url: `${files()}/${receipt}`, ...as(bob) }, 200);
    expect(own.rawPayload.equals(JPEG)).toBe(true);
    expect(own.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'content-disposition': "inline; filename*=UTF-8''taxi.jpg",
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(own.headers['content-security-policy']).toContain('sandbox');
    await inject({ method: 'GET', url: `${files()}/${receipt}`, ...as(carol) }, 200); // the approver sees submitted claims
    await inject({ method: 'GET', url: `${files()}/${receipt}`, ...as(erin) }, 404); // another requester doesn't
    await inject({ method: 'GET', url: `${files()}/${receipt}`, ...as(dave) }, 403); // not in the app at all
  });

  it('only lets people use their own uploads, and each upload once', async () => {
    const bobs = (await upload(bob, JPEG, 'image/jpeg')).json().id;
    const taken = await claim(erin, bobs, 422);
    expect(taken.json().details.issues).toEqual([expect.objectContaining({ field: 'lines[0].receipt', message: 'You can only use files you uploaded' })]);
    await inject({ method: 'GET', url: `${files()}/${bobs}`, ...as(erin) }, 404);
    const again = await claim(bob, receipt, 422);
    expect(again.json().details.issues).toEqual([expect.objectContaining({ message: 'This file belongs to another record' })]);
  });

  it('keeps an upload an agent proposes waiting until the person approves it', async () => {
    const token = (await inject({ method: 'POST', url: '/v1/me/tokens', ...as(bob), payload: { name: 'agent', scopes: ['app.run', 'action.run'], expiresInDays: 1 } }, 201)).json().token;
    const bearer = { headers: { authorization: `Bearer ${token}` } };
    const pdf = (await inject({ method: 'POST', url: `${files()}?name=hotel.pdf`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' }, payload: PDF }, 201)).json();
    const proposed = await inject(
      {
        method: 'POST',
        url: `/v1/apps/${appId}/actions/submit_claim/run`,
        ...bearer,
        payload: { values: { title: 'Hotel', lines: [{ date: '2026-11-03', merchant: 'Hilton', category: 'hotel', amount: 240, receipt: pdf.id }] } },
      },
      202,
    );
    const { proposal } = proposed.json();
    expect(proposal.card.tables[0].rows[0].cells.find((cell: { name: string }) => cell.name === 'receipt').display).toBe('hotel.pdf');
    // Waiting: still the person's own upload, which they can open from the review page.
    await inject({ method: 'GET', url: `${files()}/${pdf.id}`, ...as(bob) }, 200);
    await inject({ method: 'GET', url: `${files()}/${pdf.id}`, ...as(carol) }, 404);
    const review = await inject({ method: 'GET', url: `/review/${proposal.id}`, ...as(bob) }, 200);
    expect(review.body).toContain(`href="/v1/apps/${appId}/files/${pdf.id}"`);
    await inject({ method: 'POST', url: `/v1/proposals/${proposal.id}/approve`, ...as(bob), payload: { digest: proposal.digest } }, 200);
    const pdfDownload = await inject({ method: 'GET', url: `${files()}/${pdf.id}`, ...as(carol) }, 200);
    expect(pdfDownload.headers['content-disposition']).toBe("attachment; filename*=UTF-8''hotel.pdf");
  });

  it('takes only the kinds of file a field accepts', async () => {
    const current = (await inject({ method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200)).json();
    const definition = structuredClone(current.definition);
    definition.entities.expense_line.fields.find((f: { name: string }) => f.name === 'receipt').accept = ['image'];
    await inject({ method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), payload: { definition, baseRevision: current.revision } }, 200);
    const pdf = (await upload(bob, PDF, 'application/pdf', 'scan.pdf')).json().id;
    const refused = await claim(bob, pdf, 422);
    expect(refused.json().details.issues).toEqual([expect.objectContaining({ message: 'Receipt takes images' })]);
  });

  it('removes uploads nobody attached once they expire, and keeps attached ones', async () => {
    const late = (await upload(bob, JPEG, 'image/jpeg')).json().id;
    t.clock.offsetMs += 2 * 3_600_000;
    const expired = await claim(bob, late, 422);
    expect(expired.json().details.issues).toEqual([expect.objectContaining({ message: 'This upload has expired: upload it again' })]);
    expect(await t.ctx.files.sweep()).toBeGreaterThanOrEqual(1);
    await inject({ method: 'GET', url: `${files()}/${late}`, ...as(bob) }, 404);
    await inject({ method: 'GET', url: `${files()}/${receipt}`, ...as(bob) }, 200);
    const record = (await inject({ method: 'GET', url: `${records()}/${claimId}`, ...as(bob) }, 200)).json();
    expect(record.values.lines[0].receipt).toBe(receipt);
  });
});
