import {
  authorize,
  authorizeQuery,
  type Binding,
  type Condition,
  conditionRefs,
  createPolicy,
  evaluateCondition,
  isCondition,
  mergePolicies,
  type Operand,
  PolicyError,
  type Principal,
  partialEvaluate,
  type Resource,
} from '@platform/authz';
import { describe, expect, it } from 'vitest';

const env = {
  principal: { id: 'u1', department: 'finance', level: 3, groupIds: ['g1', 'g2'] },
  resource: { status: 'active' },
  context: {},
};

describe('partialEvaluate', () => {
  it('fills in the principal and leaves the record', () => {
    expect(partialEvaluate({ eq: [{ ref: 'record.owner' }, { ref: 'principal.id' }] }, env, ['record'])).toEqual({
      eq: [{ ref: 'record.owner' }, 'u1'],
    });
  });

  it('folds whatever does not depend on the record', () => {
    const condition: Condition = {
      all: [{ eq: [{ ref: 'resource.status' }, 'active'] }, { in: [{ ref: 'record.team' }, { ref: 'principal.groupIds' }] }],
    };
    expect(partialEvaluate(condition, env, ['record'])).toEqual({ in: [{ ref: 'record.team' }, ['g1', 'g2']] });
    expect(partialEvaluate({ any: [{ eq: [{ ref: 'principal.level' }, 3] }, { exists: 'record.x' }] }, env, ['record'])).toBe(true);
    expect(partialEvaluate({ not: { exists: 'record.x' } }, env, ['record'])).toEqual({ not: { exists: 'record.x' } });
  });

  it('fails closed on missing principal attributes, exactly like full evaluation', () => {
    const condition: Condition = { eq: [{ ref: 'record.region' }, { ref: 'principal.region' }] };
    expect(partialEvaluate(condition, env, ['record'])).toBe(false);
    expect(partialEvaluate({ not: condition }, env, ['record'])).toBe(true);
    expect(partialEvaluate({ lt: [{ ref: 'record.amount' }, { ref: 'principal.department' }] }, env, ['record'])).toBe(false);
  });

  it('decides `in` early when a known item already matches', () => {
    expect(partialEvaluate({ in: ['u1', [{ ref: 'record.a' }, { ref: 'principal.id' }]] }, env, ['record'])).toBe(true);
    expect(partialEvaluate({ in: ['zz', [{ ref: 'record.a' }, { ref: 'principal.id' }]] }, env, ['record'])).toEqual({
      in: ['zz', [{ ref: 'record.a' }]],
    });
  });

  it('returns constants when nothing is pending', () => {
    expect(partialEvaluate({ eq: [{ ref: 'principal.id' }, 'u1'] }, env, [])).toBe(true);
    expect(partialEvaluate({ eq: [{ ref: 'record.owner' }, 'u1'] }, env, [])).toBe(false);
  });

  it('lists the references a condition makes', () => {
    expect(
      conditionRefs({
        all: [{ in: [{ ref: 'record.a' }, [{ ref: 'principal.id' }, 'x']] }, { not: { exists: 'record.b' } }, { eq: [{ ref: 'record.a' }, 1] }],
      }),
    ).toEqual(['record.a', 'principal.id', 'record.b']);
  });
});

/** A small deterministic PRNG (mulberry32), so a failing case can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, pick };
}

const REFS = [
  'principal.id',
  'principal.department',
  'principal.level',
  'principal.groupIds',
  'principal.missing',
  'context.flag',
  'record.status',
  'record.amount',
  'record.tags',
  'record.owner',
  'record.missing',
];
const LITERALS: Operand[] = ['u1', 'u2', 'finance', 'open', 'g1', 0, 1, 3, 120, true, false, null];
const VALUES: unknown[] = ['u1', 'u2', 'finance', 'open', 'closed', 'g1', 0, 1, 3, 120, true, false, null, undefined, ['g1', 'open'], [], Number.NaN];

function generate(seed: number) {
  const { next, pick } = random(seed);
  const operand = (): Operand => (next() < 0.6 ? { ref: pick(REFS) } : pick(LITERALS));
  const condition = (depth: number): Condition => {
    const roll = next();
    if (depth > 0 && roll < 0.3) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 3) }, () => condition(depth - 1));
      return next() < 0.5 ? { all: parts } : { any: parts };
    }
    if (depth > 0 && roll < 0.4) return { not: condition(depth - 1) };
    const leaf = pick(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in-list', 'in-ref', 'exists'] as const);
    if (leaf === 'exists') return { exists: pick(REFS) };
    if (leaf === 'in-list') return { in: [operand(), Array.from({ length: Math.floor(next() * 4) }, operand)] };
    if (leaf === 'in-ref') return { in: [operand(), { ref: pick(REFS) }] };
    return { [leaf]: [operand(), operand()] } as unknown as Condition;
  };
  const values = (keys: readonly string[]) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (next() < 0.85) out[key] = pick(VALUES);
    return out;
  };
  const principal = { ...values(['department', 'level', 'groupIds']), id: pick(['u1', 'u2']) };
  const known = { principal, context: values(['flag']) };
  const records = Array.from({ length: 8 }, () => values(['status', 'amount', 'tags', 'owner']));
  return { condition: condition(3), known, records };
}

describe('partialEvaluate agrees with full evaluation', () => {
  it('on thousands of random conditions, environments and records', () => {
    for (let seed = 1; seed <= 4000; seed++) {
      const { condition, known, records } = generate(seed);
      const residual = partialEvaluate(condition, known, ['record']);
      if (typeof residual !== 'boolean') {
        expect(isCondition(residual), `seed ${seed}: residual is not a valid condition`).toBe(true);
        expect(
          conditionRefs(residual).every((ref) => ref.startsWith('record.')),
          `seed ${seed}: residual refers to known values`,
        ).toBe(true);
      }
      for (const values of records) {
        const expected = evaluateCondition(condition, { ...known, record: values });
        const actual = typeof residual === 'boolean' ? residual : evaluateCondition(residual, { record: values });
        expect(actual, `seed ${seed}: ${JSON.stringify({ condition, known, values, residual })}`).toBe(expected);
      }
    }
  });
});

describe('authorizeQuery', () => {
  const policy = createPolicy({
    permissionSets: [
      {
        id: 'ps.claims',
        name: 'Claims',
        scopeType: 'env',
        grants: [
          { permission: 'record.read', resource: 'claim', condition: { eq: [{ ref: 'record.owner' }, { ref: 'principal.id' }] }, mask: ['iban'] },
          { permission: 'record.read', resource: 'claim', condition: { eq: [{ ref: 'principal.department' }, 'audit'] } },
          {
            permission: 'record.update',
            resource: 'claim',
            condition: { eq: [{ ref: 'record.status' }, 'draft'] },
            check: { ne: [{ ref: 'record.status' }, 'paid'] },
            fields: { include: ['status'] },
          },
        ],
      },
    ],
    roles: [{ id: 'claims', name: 'Claims', scopeType: 'env', permissionSetIds: ['ps.claims'] }],
    guardrails: [
      { id: 'gr.locked', name: 'Locked records are read-only', actions: ['record.update'], effect: 'deny', when: { eq: [{ ref: 'record.locked' }, true] } },
      {
        id: 'gr.big',
        name: 'Fresh MFA for big claims',
        actions: ['record.read'],
        effect: 'step_up',
        maxMfaAgeSeconds: 60,
        when: { gt: [{ ref: 'record.amount' }, 1000] },
      },
    ],
  });
  const now = new Date('2026-11-15T12:00:00Z');
  const binding: Binding = { id: 'b1', principalType: 'user', principalId: 'u1', roleId: 'claims', scope: { type: 'env', id: 'env1' } };
  const resource: Resource = { type: 'record', selector: 'claim', scopes: [{ type: 'env', id: 'env1' }] };
  const principal: Principal = { type: 'user', id: 'u1', groupIds: [], attributes: { department: 'sales' }, mfaAt: now };

  it('returns record filters with the principal filled in, and drops grants that can never apply', () => {
    const decision = authorizeQuery(policy, { principal, action: 'record.read', resource, bindings: [binding], now });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.grants).toHaveLength(1);
    expect(decision.grants[0]).toMatchObject({ filter: { eq: [{ ref: 'record.owner' }, 'u1'] }, check: true, grant: { mask: ['iban'] } });
    expect(decision.exclude).toEqual([]);
  });

  it('turns record-dependent guardrails into exclusions', () => {
    const update = authorizeQuery(policy, { principal, action: 'record.update', resource, bindings: [binding], now });
    expect(update).toMatchObject({
      allowed: true,
      grants: [{ filter: { eq: [{ ref: 'record.status' }, 'draft'] }, check: { ne: [{ ref: 'record.status' }, 'paid'] } }],
      exclude: [{ guardrailId: 'gr.locked', effect: 'deny', when: { eq: [{ ref: 'record.locked' }, true] } }],
    });
    const stale = { ...principal, mfaAt: new Date(now.getTime() - 3_600_000) };
    const read = authorizeQuery(policy, { principal: stale, action: 'record.read', resource, bindings: [binding], now });
    expect(read).toMatchObject({ allowed: true, exclude: [{ guardrailId: 'gr.big', effect: 'step_up' }] });
  });

  it('evaluates record conditions fully when authorize is given the record', () => {
    const request = { principal, action: 'record.read', resource, bindings: [binding], now };
    expect(authorize(policy, { ...request, record: { owner: 'u1' } }).allowed).toBe(true);
    expect(authorize(policy, { ...request, record: { owner: 'u2' } })).toMatchObject({ allowed: false, reasons: [{ kind: 'condition_not_met' }] });
    expect(authorize(policy, request).allowed).toBe(false);
  });

  it('denies outright when no grant can apply', () => {
    const decision = authorizeQuery(policy, { principal, action: 'record.delete', resource, bindings: [binding], now });
    expect(decision).toMatchObject({ allowed: false, reasons: [{ kind: 'no_matching_grant' }] });
  });
});

describe('mergePolicies', () => {
  const base = createPolicy({
    permissionSets: [{ id: 'ps.base', name: 'Base', scopeType: 'org', grants: [{ permission: 'space.read' }] }],
    roles: [{ id: 'base', name: 'Base', scopeType: 'org', permissionSetIds: ['ps.base'] }],
  });

  it('adds definitions', () => {
    const extra = createPolicy({
      permissionSets: [{ id: 'app:1:viewer', name: 'Viewer', scopeType: 'env', grants: [{ permission: 'record.read' }] }],
      roles: [{ id: 'app:1:viewer', name: 'Viewer', scopeType: 'env', permissionSetIds: ['app:1:viewer'] }],
    });
    const merged = mergePolicies(base, extra);
    expect([...merged.roles.keys()]).toEqual(['base', 'app:1:viewer']);
    expect(base.roles.size).toBe(1);
  });

  it('refuses to redefine anything', () => {
    expect(() => mergePolicies(base, base)).toThrow(PolicyError);
  });

  it('validates field rules and checks', () => {
    expect(() =>
      createPolicy({
        permissionSets: [{ id: 'x', name: 'X', scopeType: 'env', grants: [{ permission: 'record.update', check: { eq: [1] } as never }] }],
        roles: [],
      }),
    ).toThrow(/invalid check/);
    expect(() =>
      createPolicy({ permissionSets: [{ id: 'x', name: 'X', scopeType: 'env', grants: [{ permission: 'record.read', mask: [''] }] }], roles: [] }),
    ).toThrow(/invalid field names/);
  });
});
