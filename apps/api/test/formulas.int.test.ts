import { EXPENSE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * Formulas, end to end (design §6.1): the platform works them out whenever a record is written,
 * through an action, the records API or a flow, and stores what they give. Nobody can set them.
 */

let t: TestApp;
let alice: Session;
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
const ref = (field: string) => ({ ref: `record.${field}` });
const records = () => `/v1/apps/${appId}/entities/expense_claim/records`;
const receipt = (amount: number) => ({ date: '2026-11-02', merchant: 'Shop', category: 'travel', amount });

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

function withFormulas() {
  const draft = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  draft.entities.expense_line.fields.push({ name: 'tax', label: 'Tax (SGD)', type: 'number', decimals: 2, formula: { mul: [ref('amount'), 0.09] } });
  draft.entities.expense_claim.fields.push(
    { name: 'with_tax', label: 'With tax (SGD)', type: 'number', decimals: 2, max: 5000, formula: { round: [{ mul: [ref('total'), 1.09] }, 2] } },
    { name: 'heading', label: 'Heading', type: 'text', formula: { concat: [ref('title'), ': ', { coalesce: [ref('trip'), 'no trip'] }] } },
  );
  return draft;
}

beforeAll(async () => {
  t = await startTestApp();
  alice = await t.login('alice');
  appId = (await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: withFormulas() } }, 201)).json().app.id;
});

afterAll(async () => {
  await t?.close();
});

describe('formulas', () => {
  it('are worked out as a record is written, for its lines too, and again as it changes', async () => {
    const done = (await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(alice), payload: { values: { title: 'Tokyo', lines: [receipt(16.5), receipt(100)] } } }, 201)).json();
    expect(done.record.values).toMatchObject({ total: 116.5, with_tax: 126.99, heading: 'Tokyo: no trip' });
    expect(done.record.values.lines.map((line: { tax: number }) => line.tax)).toEqual([1.49, 9]);

    const changed = (await inject({ method: 'PATCH', url: `${records()}/${done.record.id}`, ...as(alice), payload: { values: { trip: 'Summit' }, version: done.record.version } }, 200)).json();
    expect(changed.values).toMatchObject({ heading: 'Tokyo: Summit', with_tax: 126.99 });
  });

  it('refuse a value of their own, and a value their field can not hold', async () => {
    const own = await inject({ method: 'POST', url: records(), ...as(alice), payload: { values: { title: 'Mine', lines: [receipt(5)], with_tax: 1 } } }, 422);
    expect(own.json()).toMatchObject({ error: 'invalid_values', details: { issues: [{ field: 'with_tax', code: 'not_writable' }] } });
    const large = await inject({ method: 'POST', url: `/v1/apps/${appId}/actions/submit_claim/run`, ...as(alice), payload: { values: { title: 'Huge', lines: [receipt(4900)] } } }, 422);
    expect(large.json()).toMatchObject({ error: 'invalid_values', details: { issues: [{ field: 'with_tax', message: 'With tax (SGD): At most 5000' }] } });
  });

  it('show on screens as worked out, with the formula, so a form can show it as people type', async () => {
    const ui = (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(alice) }, 200)).json();
    expect(ui.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'with_tax')).toMatchObject({ computed: true, create: false, update: false, formula: { round: [{ mul: [ref('total'), 1.09] }, 2] } });
  });
});
