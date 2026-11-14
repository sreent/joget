import { groups, users, type Executor } from '@platform/db';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { BindingRow } from './policy-service.js';

export const BindingOut = z.object({
  id: z.uuid(),
  principal: z.object({
    type: z.enum(['user', 'group', 'service_account']),
    id: z.uuid(),
    name: z.string().nullable(),
  }),
  roleId: z.string().nullable(),
  permissionSetId: z.string().nullable(),
  scope: z.object({ type: z.enum(['org', 'space', 'app', 'env']), id: z.uuid() }),
  expiresAt: z.string().nullable(),
  justification: z.string().nullable(),
  grantedBy: z.uuid().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type BindingOutput = z.infer<typeof BindingOut>;

/** Bindings with human-readable principal names, for API responses. */
export async function describeBindings(db: Executor, rows: readonly BindingRow[]): Promise<BindingOutput[]> {
  const userIds = rows.filter((r) => r.principalType === 'user').map((r) => r.principalId);
  const groupIds = rows.filter((r) => r.principalType === 'group').map((r) => r.principalId);
  const names = new Map<string, string | null>();
  if (userIds.length) {
    for (const u of await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, userIds))) {
      names.set(u.id, u.displayName ?? u.email);
    }
  }
  if (groupIds.length) {
    for (const g of await db.select({ id: groups.id, name: groups.displayName }).from(groups).where(inArray(groups.id, groupIds))) {
      names.set(g.id, g.name);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    principal: { type: row.principalType, id: row.principalId, name: names.get(row.principalId) ?? null },
    roleId: row.roleId,
    permissionSetId: row.permissionSetId,
    scope: { type: row.scopeType, id: row.scopeId },
    expiresAt: row.expiresAt?.toISOString() ?? null,
    justification: row.justification,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}
