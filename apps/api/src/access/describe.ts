import { type Executor, groups, serviceAccounts, users } from '@platform/db';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { BindingRow } from './policy-service.js';

/** Who did something: a person, a service account, or the platform itself (no ID). */
const ActorRef = z.object({ type: z.enum(['system', 'user', 'service_account']), id: z.uuid().nullable() });

export const BindingOut = z.object({
  id: z.uuid(),
  principal: z.object({
    type: z.enum(['user', 'group', 'service_account']),
    id: z.uuid(),
    name: z.string().nullable(),
  }),
  roleId: z.string().nullable(),
  permissionSetId: z.string().nullable(),
  /** A role an app defines for itself, for example when an app is shared. */
  appRoleId: z.string().nullable(),
  scope: z.object({ type: z.enum(['org', 'space', 'app', 'env']), id: z.uuid() }),
  expiresAt: z.string().nullable(),
  justification: z.string().nullable(),
  grantedBy: ActorRef,
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: ActorRef.nullable(),
});
export type BindingOutput = z.infer<typeof BindingOut>;

/** Bindings with human-readable principal names, for API responses. */
export async function describeBindings(db: Executor, rows: readonly BindingRow[]): Promise<BindingOutput[]> {
  const idsOf = (type: BindingRow['principalType']) => rows.filter((r) => r.principalType === type).map((r) => r.principalId);
  const names = new Map<string, string | null>();
  const userIds = idsOf('user');
  if (userIds.length) {
    for (const u of await db.select({ id: users.id, email: users.email, name: users.displayName }).from(users).where(inArray(users.id, userIds))) {
      names.set(u.id, u.name ?? u.email);
    }
  }
  const groupIds = idsOf('group');
  if (groupIds.length) {
    for (const g of await db.select({ id: groups.id, name: groups.displayName }).from(groups).where(inArray(groups.id, groupIds))) {
      names.set(g.id, g.name);
    }
  }
  const accountIds = idsOf('service_account');
  if (accountIds.length) {
    for (const s of await db
      .select({ id: serviceAccounts.id, name: serviceAccounts.name })
      .from(serviceAccounts)
      .where(inArray(serviceAccounts.id, accountIds))) {
      names.set(s.id, s.name);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    principal: { type: row.principalType, id: row.principalId, name: names.get(row.principalId) ?? null },
    roleId: row.roleId,
    permissionSetId: row.permissionSetId,
    appRoleId: row.appRoleId,
    scope: { type: row.scopeType, id: row.scopeId },
    expiresAt: row.expiresAt?.toISOString() ?? null,
    justification: row.justification,
    grantedBy: { type: row.grantedByType, id: row.grantedBy },
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedByType ? { type: row.revokedByType, id: row.revokedBy } : null,
  }));
}
