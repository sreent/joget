import {
  accessChanges,
  capabilityChanges,
  diffDefinitions,
  EXPENSE_APP,
  lintDefinition,
  mergeDefinitions,
  type StoredDefinition,
  validateDefinition,
} from '@platform/app-model';
import { describe, expect, it } from 'vitest';

const ids = () => {
  let n = 0;
  return () => `id${String(++n).padStart(4, '0')}`;
};

function valid(input: unknown, previous?: StoredDefinition): StoredDefinition {
  const result = validateDefinition(input, previous, ids());
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.definition;
}

/** The example app, changed by `edit`, keeping the stable IDs of what stays. */
function changed(base: StoredDefinition, edit: (draft: Record<string, any>) => void): StoredDefinition {
  const draft = structuredClone(base) as unknown as Record<string, any>;
  edit(draft);
  return valid(draft, base);
}

const base = valid(EXPENSE_APP);

describe('the diff of a change', () => {
  it('lists changes artifact by artifact, and follows a renamed entity by its ID', () => {
    const head = changed(base, (d) => {
      d.entities.expense_claim.fields.push({ name: 'vendor', type: 'text', label: 'Vendor' });
      d.actions.submit_claim.confirm = 'none';
      delete d.queries.my_claims;
      d.roles.requester.queries = [];
    });
    const changes = diffDefinitions(base, head);
    const claim = changes.find((c) => c.section === 'entities' && c.name === 'expense_claim')!;
    expect(claim.change).toBe('changed');
    expect(claim.details).toContain('Added field vendor (text)');
    expect(changes).toContainEqual(expect.objectContaining({ section: 'actions', name: 'submit_claim', change: 'changed' }));
    expect(changes).toContainEqual(expect.objectContaining({ section: 'queries', name: 'my_claims', change: 'removed' }));

    const renamed = changed(base, (d) => {
      d.entities.claim = d.entities.expense_claim;
      delete d.entities.expense_claim;
    });
    const rename = diffDefinitions(base, renamed).filter((c) => c.section === 'entities');
    expect(rename).toEqual([expect.objectContaining({ name: 'claim', change: 'changed', from: 'expense_claim', details: ['Renamed from expense_claim'] })]);
  });

  it('is empty when nothing changed', () => {
    expect(
      diffDefinitions(
        base,
        changed(base, () => undefined),
      ),
    ).toEqual([]);
  });
});

describe('who gains or loses access', () => {
  it('says what a role can now do, and what it can no longer do', () => {
    const head = changed(base, (d) => {
      d.roles.approver.entities.expense_claim.export = true;
      d.roles.approver.entities.expense_claim.update = {
        where: d.roles.approver.entities.expense_claim.update.where,
        fields: { include: ['status', 'approver', 'trip'] },
      };
      d.roles.approver.actions = [];
      d.roles.requester.entities.expense_claim.read = { unmask: ['iban'] };
    });
    const texts = accessChanges(base, head).map((c) => `${c.kind}: ${c.text}`);
    expect(texts).toContain('gains: Approver can now export Expense claim');
    expect(texts).toContain('gains: Approver can now set Expense claim.trip when it updates');
    expect(texts).toContain('loses: Approver can no longer run Approve an expense claim');
    expect(texts).toContain('gains: Requester can now read every Expense claim record');
  });

  it('reports masking: a role that now sees PII in full gains, one that sees it masked loses', () => {
    const unmasked = changed(base, (d) => {
      d.roles.approver.entities.expense_claim.read.unmask = ['iban'];
    });
    expect(accessChanges(base, unmasked).map((c) => c.text)).toContain('Approver now sees Expense claim.iban in full');
    const masked = changed(base, (d) => {
      d.roles.requester.entities.expense_claim.read.unmask = [];
    });
    expect(accessChanges(base, masked)).toContainEqual({ role: 'requester', kind: 'loses', text: 'Requester now sees Expense claim.iban masked' });
  });

  it('covers new and removed roles, and new fields a role can see', () => {
    const head = changed(base, (d) => {
      d.roles.auditor = { label: 'Auditor', entities: { expense_claim: { read: true } } };
      delete d.roles.approver;
      delete d.pages.to_approve.roles;
      d.entities.expense_claim.fields.push({ name: 'vendor', type: 'text', label: 'Vendor' });
    });
    const texts = accessChanges(base, head).map((c) => `${c.kind}: ${c.text}`);
    expect(texts).toContain('gains: Auditor is a new role');
    expect(texts).toContain('gains: Auditor can now read Expense claim');
    expect(texts).toContain('loses: Approver is removed: whoever holds it loses its access');
    expect(texts).toContain('gains: Requester can now see Expense claim.vendor');
  });

  it('is empty for a change that leaves access alone, such as a rename', () => {
    const head = changed(base, (d) => {
      d.entities.expense_claim.label = 'Claim';
      d.entities.expense_claim.fields.find((f: { name: string }) => f.name === 'trip').name = 'journey';
    });
    expect(accessChanges(base, head)).toEqual([]);
  });
});

describe('which agent tools change', () => {
  it('names new and removed tools, and a confirmation level that drops', () => {
    const head = changed(base, (d) => {
      d.actions.submit_claim.confirm = 'none';
      d.actions.submit_claim.input.push('approver');
      delete d.queries.my_claims;
      d.roles.requester.queries = [];
    });
    const texts = capabilityChanges(base, head).map((c) => c.text);
    expect(texts).toContain('submit_claim now needs less confirmation: it runs without asking the person');
    expect(texts).toContain('submit_claim now takes approver');
    expect(texts).toContain('Agents can no longer call my_claims');
    const fresh = capabilityChanges(valid({}), base).map((c) => c.text);
    expect(fresh).toContain('New tool submit_claim: creates Expense claim, and asks the person to review it in full');
  });
});

describe('lint', () => {
  it('flags what no role can reach', () => {
    const head = changed(base, (d) => {
      d.roles.requester.actions = [];
      delete d.roles.approver;
      delete d.pages.to_approve.roles;
    });
    expect(lintDefinition(head)).toEqual(['No role can run the action Submit an expense claim', 'No role can run the action Approve an expense claim']);
    expect(lintDefinition(base)).toEqual([]);
  });
});

describe('the three-way merge', () => {
  it('takes each side where only it changed something', () => {
    const ours = changed(base, (d) => {
      d.actions.submit_claim.confirm = 'none';
    });
    const theirs = changed(base, (d) => {
      d.queries.my_claims.limit = 20;
    });
    const result = mergeDefinitions(base, ours, theirs);
    expect(result.ok).toBe(true);
    const merged = valid(result.ok ? result.definition : {}, theirs);
    expect(merged.actions['submit_claim']!.confirm).toBe('none');
    expect(merged.queries['my_claims']!.limit).toBe(20);
    expect(merged.entities['expense_claim']!.id).toBe(base.entities['expense_claim']!.id);
  });

  it('reports a conflict where both sides changed the same artifact differently', () => {
    const ours = changed(base, (d) => {
      d.actions.submit_claim.confirm = 'none';
    });
    const theirs = changed(base, (d) => {
      delete d.actions.submit_claim;
      d.roles.requester.actions = [];
      delete d.forms.claim_form.action;
    });
    const result = mergeDefinitions(base, ours, theirs);
    expect(result).toEqual({ ok: false, conflicts: [{ section: 'actions', name: 'submit_claim', ours: 'changed', theirs: 'removed' }] });
  });

  it("keeps a change's connections, webhooks and tests while the main line moved on", () => {
    const ours = changed(base, (d) => {
      d.connections = { erp: { kind: 'service', label: 'ERP', url: 'https://erp.example.com', auth: { type: 'none' } } };
      d.tests = {
        submits: { label: 'A requester submits', when: { action: 'submit_claim', as: 'requester', values: { title: 'Taxi' } }, then: { outcome: 'refused' } },
      };
    });
    const theirs = changed(base, (d) => {
      d.queries.my_claims.limit = 20;
    });
    const result = mergeDefinitions(base, ours, theirs);
    expect(result.ok).toBe(true);
    const merged = valid(result.ok ? result.definition : {}, theirs);
    expect(Object.keys(merged.connections ?? {})).toEqual(['erp']);
    expect(Object.keys(merged.tests ?? {})).toEqual(['submits']);
    expect(merged.queries['my_claims']!.limit).toBe(20);
    // A definition without them still leaves them out.
    const plain = mergeDefinitions(base, theirs, theirs);
    expect(plain.ok && ['connections', 'webhooks', 'tests'].some((section) => section in plain.definition)).toBe(false);
  });

  it('accepts the same change made on both sides', () => {
    const edit = (d: Record<string, any>) => {
      d.queries.my_claims.limit = 20;
    };
    const result = mergeDefinitions(base, changed(base, edit), changed(base, edit));
    expect(result.ok).toBe(true);
  });
});
