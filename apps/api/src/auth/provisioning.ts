import { uuidv7 } from '@platform/audit';
import { bindings, groupMembers, groups, spaces, users, type Transaction } from '@platform/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { recordAudit, SYSTEM_ACTOR, type AuditScope } from '../audit/writer.js';
import type { Config } from '../config.js';
import { forbidden } from '../errors.js';
import type { OidcIdentity } from './oidc.js';

export interface ProvisionedUser {
  readonly userId: string;
  readonly personalSpaceId: string;
  readonly created: boolean;
}

/**
 * Just-in-time provisioning at login (design §4): create or update the user, sync their IdP groups,
 * make sure they have a personal space, and apply the bootstrap-owner rule. Runs in the login
 * transaction; every change is audited.
 */
export async function provisionUser(
  tx: Transaction,
  input: {
    orgId: string;
    config: Config;
    identity: OidcIdentity;
    audit: AuditScope;
    /**
     * `login` (the default) refreshes the profile and the IdP groups. `exchange` is for a token an
     * agent presents: it may carry fewer claims than a sign-in, so it changes nothing for someone
     * Ambit already knows, and provisions a newcomer as a first sign-in would.
     */
    mode?: 'login' | 'exchange';
  },
): Promise<ProvisionedUser> {
  const { orgId, config, identity, audit } = input;
  const now = audit.now;
  const system: AuditScope = { ...audit, actor: SYSTEM_ACTOR };

  const [existing] = await tx
    .select()
    .from(users)
    .where(and(eq(users.issuer, identity.issuer), eq(users.subject, identity.subject)));
  if (existing && existing.status !== 'active') {
    throw forbidden('account_deprovisioned', 'This account has been deprovisioned');
  }
  if (existing && input.mode === 'exchange') {
    const [personal] = await tx.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, existing.id)));
    return { userId: existing.id, personalSpaceId: personal!.id, created: false };
  }

  const profile = {
    email: identity.email,
    emailVerified: identity.emailVerified,
    displayName: identity.name,
    lastLoginAt: now,
  };
  let userId: string;
  if (existing) {
    userId = existing.id;
    await tx.update(users).set(profile).where(eq(users.id, userId));
  } else {
    userId = uuidv7(now.getTime());
    await tx.insert(users).values({ id: userId, orgId, issuer: identity.issuer, subject: identity.subject, ...profile, createdAt: now });
    await recordAudit(tx, system, {
      action: 'user.provision',
      target: { type: 'user', id: userId, ...(identity.email ? { name: identity.email } : {}) },
      changes: { after: { issuer: identity.issuer, subject: identity.subject, email: identity.email } },
    });
  }

  await syncIdpGroups(tx, { orgId, userId, groupNames: identity.groups, audit: system });
  const personalSpaceId = await ensurePersonalSpace(tx, { orgId, userId, name: identity.name ?? identity.email, audit: system });

  const ownerEmail = identity.email && identity.emailVerified && config.ORG_OWNER_EMAILS.includes(identity.email);
  if (ownerEmail) {
    const [owner] = await tx
      .select({ id: bindings.id })
      .from(bindings)
      .where(
        and(
          eq(bindings.principalType, 'user'),
          eq(bindings.principalId, userId),
          eq(bindings.roleId, 'org.owner'),
          eq(bindings.scopeType, 'org'),
          isNull(bindings.revokedAt),
        ),
      );
    if (!owner) {
      const bindingId = uuidv7(now.getTime());
      const justification = 'Bootstrap owner listed in ORG_OWNER_EMAILS';
      await tx.insert(bindings).values({
        id: bindingId,
        orgId,
        principalType: 'user',
        principalId: userId,
        roleId: 'org.owner',
        scopeType: 'org',
        scopeId: orgId,
        justification,
        createdAt: now,
      });
      await recordAudit(tx, system, {
        action: 'binding.create',
        target: { type: 'binding', id: bindingId },
        reason: { justification },
        changes: { after: { principalType: 'user', principalId: userId, roleId: 'org.owner', scope: { type: 'org', id: orgId } } },
      });
    }
  }

  return { userId, personalSpaceId, created: !existing };
}

async function syncIdpGroups(
  tx: Transaction,
  input: { orgId: string; userId: string; groupNames: readonly string[]; audit: AuditScope },
): Promise<void> {
  const { orgId, userId, groupNames, audit } = input;
  const wanted = new Map<string, string>();
  for (const name of groupNames) {
    const [row] = await tx
      .insert(groups)
      .values({ id: uuidv7(audit.now.getTime()), orgId, source: 'idp', externalId: name, displayName: name, createdAt: audit.now })
      .onConflictDoUpdate({ target: [groups.orgId, groups.source, groups.externalId], set: { displayName: name } })
      .returning({ id: groups.id });
    wanted.set(row!.id, name);
  }

  const current = await tx
    .select({ groupId: groupMembers.groupId, name: groups.externalId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), eq(groups.source, 'idp')));
  const removed = current.filter((membership) => !wanted.has(membership.groupId));
  const added = [...wanted].filter(([groupId]) => !current.some((membership) => membership.groupId === groupId));

  if (removed.length > 0) {
    await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, removed.map((m) => m.groupId))));
  }
  if (added.length > 0) {
    await tx.insert(groupMembers).values(added.map(([groupId]) => ({ groupId, userId, createdAt: audit.now })));
  }
  if (added.length > 0 || removed.length > 0) {
    await recordAudit(tx, audit, {
      action: 'directory.membership.sync',
      target: { type: 'user', id: userId },
      reason: { source: 'idp' },
      changes: { added: added.map(([, name]) => name), removed: removed.map((m) => m.name) },
    });
  }
}

async function ensurePersonalSpace(
  tx: Transaction,
  input: { orgId: string; userId: string; name: string | null; audit: AuditScope },
): Promise<string> {
  const { orgId, userId, audit } = input;
  const [existing] = await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, userId)));
  if (existing) return existing.id;

  const spaceId = uuidv7(audit.now.getTime());
  const name = input.name ? `${input.name}'s space` : 'Personal space';
  await tx.insert(spaces).values({ id: spaceId, orgId, kind: 'personal', name, ownerUserId: userId, createdBy: userId, createdAt: audit.now });
  const bindingId = uuidv7(audit.now.getTime());
  await tx.insert(bindings).values({
    id: bindingId,
    orgId,
    principalType: 'user',
    principalId: userId,
    roleId: 'space.personal_owner',
    scopeType: 'space',
    scopeId: spaceId,
    createdAt: audit.now,
  });
  await recordAudit(tx, audit, {
    action: 'space.create',
    target: { type: 'space', id: spaceId, name },
    spaceId,
    changes: { after: { kind: 'personal', ownerUserId: userId } },
  });
  await recordAudit(tx, audit, {
    action: 'binding.create',
    target: { type: 'binding', id: bindingId },
    spaceId,
    changes: { after: { principalType: 'user', principalId: userId, roleId: 'space.personal_owner', scope: { type: 'space', id: spaceId } } },
  });
  return spaceId;
}
