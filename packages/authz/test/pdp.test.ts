import {
  authorize,
  type Binding,
  createPolicy,
  effectiveGrants,
  findEscalation,
  findSodConflicts,
  MANAGED_GUARDRAILS,
  MANAGED_PERMISSION_SETS,
  MANAGED_ROLES,
  MANAGED_SOD_RULES,
  mergePolicies,
  orgScopes,
  PolicyError,
  type Principal,
  type Resource,
  spaceScopes,
} from '@platform/authz';
import { describe, expect, it } from 'vitest';

const ORG = 'org-1';
const TEAM = 'space-team';
const PERSONAL = 'space-personal-bob';
const now = new Date('2026-11-14T12:00:00Z');
const policy = createPolicy({
  permissionSets: MANAGED_PERMISSION_SETS,
  roles: MANAGED_ROLES,
  guardrails: MANAGED_GUARDRAILS,
});

const alice: Principal = { type: 'user', id: 'alice', groupIds: ['g-finance'], mfaAt: new Date(now.getTime() - 60_000) };
const bob: Principal = { type: 'user', id: 'bob', groupIds: [] };

const teamSpace: Resource = { type: 'space', id: TEAM, scopes: spaceScopes(ORG, { id: TEAM, personal: false }) };
const bobsSpace: Resource = { type: 'space', id: PERSONAL, scopes: spaceScopes(ORG, { id: PERSONAL, personal: true }) };
const org: Resource = { type: 'org', id: ORG, scopes: orgScopes(ORG) };

function binding(partial: Partial<Binding> & Pick<Binding, 'principalId' | 'scope'>): Binding {
  return { id: `b-${Math.random().toString(36).slice(2)}`, principalType: 'user', ...partial };
}

describe('authorize', () => {
  it('allows through a role bound directly at the space, and explains why', () => {
    const b = binding({ principalId: 'alice', roleId: 'space.builder', scope: { type: 'space', id: TEAM } });
    const decision = authorize(policy, { principal: alice, action: 'app.edit', resource: teamSpace, bindings: [b], now });
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toContainEqual({
      kind: 'granted',
      bindingId: b.id,
      roleId: 'space.builder',
      permissionSetId: 'ps.space.build',
      permission: 'app.edit',
      scope: { type: 'space', id: TEAM },
    });
  });

  it('denies by default when nothing grants the action', () => {
    const decision = authorize(policy, { principal: bob, action: 'app.edit', resource: teamSpace, bindings: [], now });
    expect(decision).toEqual({ allowed: false, action: 'app.edit', reasons: [{ kind: 'no_matching_grant' }] });
  });

  it('applies bindings held by the principal’s groups', () => {
    const b = binding({ principalType: 'group', principalId: 'g-finance', roleId: 'space.viewer', scope: { type: 'space', id: TEAM } });
    expect(authorize(policy, { principal: alice, action: 'space.read', resource: teamSpace, bindings: [b], now }).allowed).toBe(true);
    expect(authorize(policy, { principal: bob, action: 'space.read', resource: teamSpace, bindings: [b], now }).allowed).toBe(false);
  });

  it('inherits org-level bindings into team spaces', () => {
    const b = binding({ principalId: 'alice', roleId: 'org.admin', scope: { type: 'org', id: ORG } });
    expect(authorize(policy, { principal: alice, action: 'space.read', resource: teamSpace, bindings: [b], now }).allowed).toBe(true);
  });

  it('stops org-level bindings at the personal-space boundary, except for freeze and transfer', () => {
    const b = binding({ principalId: 'alice', roleId: 'org.owner', scope: { type: 'org', id: ORG } });
    const read = authorize(policy, { principal: alice, action: 'space.read', resource: bobsSpace, bindings: [b], now });
    expect(read.allowed).toBe(false);
    expect(read.reasons).toEqual([{ kind: 'personal_space_boundary', bindingIds: [b.id] }]);
    const freeze = authorize(policy, { principal: alice, action: 'space.freeze', resource: bobsSpace, bindings: [b], now });
    expect(freeze.allowed).toBe(true);
  });

  it('ignores expired and revoked bindings', () => {
    const expired = binding({ principalId: 'alice', roleId: 'space.viewer', scope: { type: 'space', id: TEAM }, expiresAt: new Date(now.getTime() - 1) });
    const revoked = binding({ principalId: 'alice', roleId: 'space.viewer', scope: { type: 'space', id: TEAM }, revokedAt: new Date(now.getTime() - 1) });
    expect(authorize(policy, { principal: alice, action: 'space.read', resource: teamSpace, bindings: [expired, revoked], now }).allowed).toBe(false);
  });

  it('ignores bindings for other scopes and other principals', () => {
    const otherSpace = binding({ principalId: 'alice', roleId: 'space.owner', scope: { type: 'space', id: 'elsewhere' } });
    const otherUser = binding({ principalId: 'bob', roleId: 'space.owner', scope: { type: 'space', id: TEAM } });
    const serviceAccountWithSameId = binding({
      principalType: 'service_account',
      principalId: 'alice',
      roleId: 'space.owner',
      scope: { type: 'space', id: TEAM },
    });
    const decision = authorize(policy, {
      principal: alice,
      action: 'space.read',
      resource: teamSpace,
      bindings: [otherSpace, otherUser, serviceAccountWithSameId],
      now,
    });
    expect(decision.allowed).toBe(false);
  });

  it('limits a token to its scopes even when the user holds more', () => {
    const b = binding({ principalId: 'alice', roleId: 'space.owner', scope: { type: 'space', id: TEAM } });
    const token: Principal = { ...alice, tokenScopes: ['space.read', 'app.*'] };
    expect(authorize(policy, { principal: token, action: 'app.edit', resource: teamSpace, bindings: [b], now }).allowed).toBe(true);
    expect(authorize(policy, { principal: token, action: 'deploy.execute', resource: teamSpace, bindings: [b], now })).toEqual({
      allowed: false,
      action: 'deploy.execute',
      reasons: [{ kind: 'outside_token_scope' }],
    });
  });

  it('matches resource selectors and conditions on grants', () => {
    const custom = createPolicy({
      permissionSets: [
        {
          id: 'ps.expense.requester',
          name: 'Requester',
          scopeType: 'space',
          grants: [
            { permission: 'record.create', resource: 'expense_claim' },
            { permission: 'record.read', resource: 'expense_claim', condition: { eq: [{ ref: 'resource.ownerId' }, { ref: 'principal.id' }] } },
          ],
        },
      ],
      roles: [],
    });
    const b = binding({ principalId: 'bob', permissionSetId: 'ps.expense.requester', scope: { type: 'space', id: TEAM } });
    const claim = (ownerId: string): Resource => ({ type: 'record', selector: 'expense_claim', scopes: teamSpace.scopes, attributes: { ownerId } });
    const otherEntity: Resource = { type: 'record', selector: 'salary', scopes: teamSpace.scopes };

    expect(authorize(custom, { principal: bob, action: 'record.create', resource: claim('bob'), bindings: [b], now }).allowed).toBe(true);
    expect(authorize(custom, { principal: bob, action: 'record.create', resource: otherEntity, bindings: [b], now }).allowed).toBe(false);
    expect(authorize(custom, { principal: bob, action: 'record.read', resource: claim('bob'), bindings: [b], now }).allowed).toBe(true);
    expect(authorize(custom, { principal: bob, action: 'record.read', resource: claim('carol'), bindings: [b], now }).reasons).toEqual([
      { kind: 'condition_not_met', bindingIds: [b.id] },
    ]);
  });
});

describe('guardrails', () => {
  const owner = binding({ principalId: 'alice', roleId: 'space.owner', scope: { type: 'space', id: TEAM } });

  it('stops authors from approving their own change, and fails closed when the author is unknown', () => {
    const own = authorize(policy, { principal: alice, action: 'change.approve', resource: teamSpace, context: { authorId: 'alice' }, bindings: [owner], now });
    expect(own.allowed).toBe(false);
    expect(own.reasons[0]).toMatchObject({ kind: 'denied_by_guardrail', guardrailId: 'gr.sod.author-cannot-approve' });

    const unknown = authorize(policy, { principal: alice, action: 'change.approve', resource: teamSpace, bindings: [owner], now });
    expect(unknown.allowed).toBe(false);

    const someoneElses = authorize(policy, {
      principal: alice,
      action: 'change.approve',
      resource: teamSpace,
      context: { authorId: 'bob' },
      bindings: [owner],
      now,
    });
    expect(someoneElses.allowed).toBe(true);
  });

  it('demands fresh MFA for access administration, but not from service accounts', () => {
    const admin = binding({ principalId: 'alice', roleId: 'org.admin', scope: { type: 'org', id: ORG } });
    const stale: Principal = { ...alice, mfaAt: new Date(now.getTime() - 3_600_000) };
    const noMfa: Principal = { ...alice, mfaAt: undefined };

    expect(authorize(policy, { principal: alice, action: 'access.binding.manage', resource: org, bindings: [admin], now }).allowed).toBe(true);
    for (const principal of [stale, noMfa]) {
      const decision = authorize(policy, { principal, action: 'access.binding.manage', resource: org, bindings: [admin], now });
      expect(decision.allowed).toBe(false);
      expect(decision.reasons[0]).toMatchObject({ kind: 'step_up_required', maxMfaAgeSeconds: 900 });
    }

    const robot: Principal = { type: 'service_account', id: 'sa-ci', groupIds: [] };
    const robotAdmin = binding({ principalType: 'service_account', principalId: 'sa-ci', roleId: 'org.admin', scope: { type: 'org', id: ORG } });
    expect(authorize(policy, { principal: robot, action: 'access.binding.manage', resource: org, bindings: [robotAdmin], now }).allowed).toBe(true);
  });

  it('can be disabled', () => {
    const relaxed = createPolicy({
      permissionSets: MANAGED_PERMISSION_SETS,
      roles: MANAGED_ROLES,
      guardrails: MANAGED_GUARDRAILS.map((g) => ({ ...g, enabled: false })),
    });
    expect(
      authorize(relaxed, { principal: alice, action: 'change.approve', resource: teamSpace, context: { authorId: 'alice' }, bindings: [owner], now }).allowed,
    ).toBe(true);
  });
});

describe('createPolicy', () => {
  it('rejects roles that reference unknown or mismatched permission sets', () => {
    expect(() => createPolicy({ permissionSets: [], roles: [{ id: 'r', name: 'R', scopeType: 'space', permissionSetIds: ['nope'] }] })).toThrow(PolicyError);
    expect(() =>
      createPolicy({
        permissionSets: [{ id: 'ps', name: 'PS', scopeType: 'org', grants: [] }],
        roles: [{ id: 'r', name: 'R', scopeType: 'space', permissionSetIds: ['ps'] }],
      }),
    ).toThrow(/is for org/);
  });

  it('rejects invalid permission patterns and conditions', () => {
    expect(() => createPolicy({ permissionSets: [{ id: 'ps', name: 'PS', scopeType: 'org', grants: [{ permission: 'App.Edit' }] }], roles: [] })).toThrow(
      PolicyError,
    );
    expect(() =>
      createPolicy({
        permissionSets: [{ id: 'ps', name: 'PS', scopeType: 'org', grants: [{ permission: 'app.edit', condition: { eq: [1] } as never }] }],
        roles: [],
      }),
    ).toThrow(PolicyError);
  });
});

describe('effectiveGrants', () => {
  it('lists what a principal can do at a scope', () => {
    const b = binding({ principalId: 'bob', roleId: 'space.viewer', scope: { type: 'space', id: TEAM } });
    const permissions = effectiveGrants(policy, bob, teamSpace.scopes, [b], now).map((g) => g.grant.permission);
    expect(permissions.sort()).toEqual(['app.read', 'deploy.read', 'ops.monitor.read', 'space.read']);
  });
});

describe('separation of duties', () => {
  it('flags an auditor who would also become an admin, in either order', () => {
    const auditor = binding({ principalId: 'carol', roleId: 'org.auditor', scope: { type: 'org', id: ORG } });
    const admin = binding({ principalId: 'carol', roleId: 'org.admin', scope: { type: 'org', id: ORG } });
    expect(findSodConflicts('org.admin', [auditor], MANAGED_SOD_RULES, now)).toEqual([
      expect.objectContaining({ ruleId: 'sod.auditor-independence', conflictingRoleId: 'org.auditor', conflictingBindingId: auditor.id }),
    ]);
    expect(findSodConflicts('org.auditor', [admin], MANAGED_SOD_RULES, now)).toHaveLength(1);
    expect(findSodConflicts('space.builder', [auditor], MANAGED_SOD_RULES, now)).toEqual([]);
  });

  it('ignores expired bindings', () => {
    const old = binding({ principalId: 'carol', roleId: 'org.auditor', scope: { type: 'org', id: ORG }, expiresAt: new Date(now.getTime() - 1) });
    expect(findSodConflicts('org.admin', [old], MANAGED_SOD_RULES, now)).toEqual([]);
  });
});

describe('privilege escalation', () => {
  it('lets owners grant any org role but stops admins from granting security powers', () => {
    const owner = binding({ principalId: 'alice', roleId: 'org.owner', scope: { type: 'org', id: ORG } });
    const admin = binding({ principalId: 'dave', roleId: 'org.admin', scope: { type: 'org', id: ORG } });
    const dave: Principal = { type: 'user', id: 'dave', groupIds: [] };

    expect(findEscalation(policy, alice, org.scopes, [owner], { roleId: 'org.security_admin' }, now)).toEqual([]);
    expect(findEscalation(policy, dave, org.scopes, [admin], { roleId: 'org.admin' }, now)).toEqual([]);
    expect(findEscalation(policy, dave, org.scopes, [admin], { roleId: 'org.owner' }, now)).toEqual(
      expect.arrayContaining(['org.guardrail.manage', 'access.permission_set.manage', 'org.audit.read']),
    );
  });

  it('treats space owners as able to grant any space role in their space', () => {
    const owner = binding({ principalId: 'alice', roleId: 'space.owner', scope: { type: 'space', id: TEAM } });
    for (const role of ['space.admin', 'space.builder', 'space.reviewer', 'space.release_manager', 'space.operator', 'space.viewer']) {
      expect(findEscalation(policy, alice, teamSpace.scopes, [owner], { roleId: role }, now)).toEqual([]);
    }
  });

  it('lets a grant that holds only in previews cover the same grant, and nothing wider', () => {
    // A builder may try changes in previews: they can pass that on, but not record access everywhere.
    const builder = binding({ principalId: 'alice', roleId: 'space.builder', scope: { type: 'space', id: TEAM } });
    expect(findEscalation(policy, alice, teamSpace.scopes, [builder], { permissionSetId: 'ps.space.preview' }, now)).toEqual([]);
    const wider = createPolicy({
      permissionSets: [{ id: 'ps.records', name: 'Records', scopeType: 'space', grants: [{ permission: 'record.read' }] }],
      roles: [],
    });
    expect(findEscalation(mergePolicies(policy, wider), alice, teamSpace.scopes, [builder], { permissionSetId: 'ps.records' }, now)).toEqual(['record.read']);
  });
});
