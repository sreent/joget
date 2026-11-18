import { EXPENSE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Session, startTestApp, type TestApp } from './helpers.js';

/**
 * Forms that adapt, end to end (design §6.4): a field required while a condition holds, which
 * every write checks, not only forms; defaults worked out for the person as a record is created;
 * and what screens learn of both, with a form in steps whose fields show while their conditions hold.
 */

let t: TestApp;
let alice: Session; // builds the app
let bob: Session; // requester
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
const run = (action: string) => `/v1/apps/${appId}/actions/${action}/run`;
const records = () => `/v1/apps/${appId}/entities/expense_claim/records`;
const receipt = (amount: number) => ({ date: '2026-11-02', merchant: 'Shop', category: 'travel', amount });

async function inject(options: InjectOptions, expected?: number) {
  const response = await t.app.inject(options);
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return response;
}

/** The example: a bank account required for a large claim, the day it was claimed, and who claims it; its form in steps. */
function adapting() {
  const definition = structuredClone(EXPENSE_APP) as unknown as Record<string, any>;
  const claim = definition.entities.expense_claim;
  claim.fields.find((f: { name: string }) => f.name === 'iban').requiredWhen = { gt: [{ ref: 'record.total' }, 1000] };
  claim.fields.push(
    { name: 'claimed_on', label: 'Claimed on', type: 'date', default: { today: 0 } },
    { name: 'claimant', label: 'Claimant', type: 'user', default: { me: true } },
  );
  definition.forms.claim_form.layout = 'steps';
  definition.forms.claim_form.sections[2].fields[0].visibleWhen = { gt: [{ ref: 'record.total' }, 1000] };
  // The requester may change the claims they own, as a draft is changed.
  definition.roles.requester.entities.expense_claim.update = { fields: { include: ['iban', 'trip'] } };
  return definition;
}

beforeAll(async () => {
  t = await startTestApp();
  [alice, bob] = [await t.login('alice'), await t.login('bob')];
  const created = await inject(
    { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: adapting() } },
    201,
  );
  appId = created.json().app.id;
  await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
});

afterAll(async () => {
  await t?.close();
});

describe('forms that adapt', () => {
  it('give a new record its defaults, worked out for the person who creates it', async () => {
    const done = (
      await inject({ method: 'POST', url: run('submit_claim'), ...as(bob), payload: { values: { title: 'Taxi', lines: [receipt(30)] } } }, 201)
    ).json();
    expect(done.record.values).toMatchObject({ claimant: bob.userId, status: 'submitted' });
    expect(done.record.values.claimed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuse a large claim without a bank account, on every way of writing it', async () => {
    const refused = await inject(
      { method: 'POST', url: run('submit_claim'), ...as(bob), payload: { values: { title: 'Conference', lines: [receipt(900), receipt(600)] } } },
      422,
    );
    expect(refused.json()).toMatchObject({
      error: 'rule_failed',
      details: { findings: [{ rule: 'fields.iban', message: 'Bank account is required', fields: ['iban'] }] },
    });

    const small = (
      await inject(
        { method: 'POST', url: run('submit_claim'), ...as(bob), payload: { values: { title: 'Lunch', lines: [receipt(40)], iban: 'SG11 BOB' } } },
        201,
      )
    ).json().record;
    // Emptying it is fine while the claim is small; the rule holds once the claim is large.
    await inject({ method: 'PATCH', url: `${records()}/${small.id}`, ...as(bob), payload: { values: { iban: null }, version: small.version } }, 200);
    const large = (
      await inject(
        { method: 'POST', url: run('submit_claim'), ...as(bob), payload: { values: { title: 'Summit', lines: [receipt(1200)], iban: 'SG11 BOB' } } },
        201,
      )
    ).json().record;
    const emptied = await inject(
      { method: 'PATCH', url: `${records()}/${large.id}`, ...as(bob), payload: { values: { iban: null }, version: large.version } },
      422,
    );
    expect(emptied.json()).toMatchObject({ error: 'rule_failed', details: { findings: [{ rule: 'fields.iban' }] } });
  });

  it('tell screens what is required when, the defaults, and the form in steps', async () => {
    const ui = (await inject({ method: 'GET', url: `/v1/apps/${appId}/ui`, ...as(bob) }, 200)).json();
    const fields = ui.entities.expense_claim.fields as Array<{ name: string; requiredWhen?: unknown; default?: unknown }>;
    expect(fields.find((f) => f.name === 'iban')).toMatchObject({ required: false, requiredWhen: { gt: [{ ref: 'record.total' }, 1000] } });
    expect(fields.find((f) => f.name === 'claimant')).toMatchObject({ default: bob.userId });
    expect(fields.find((f) => f.name === 'claimed_on')!.default).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fields.find((f) => f.name === 'status')).toMatchObject({ default: 'draft' });
    expect(ui.forms.claim_form).toMatchObject({
      layout: 'steps',
      sections: [{}, {}, { fields: [{ field: 'iban', visibleWhen: { gt: [{ ref: 'record.total' }, 1000] } }] }],
    });
  });
});
