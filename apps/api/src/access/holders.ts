import { appRoleId } from '@platform/app-model';
import { apps, bindings, groupMembers, users, type Database } from '@platform/db';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

/*
 * Who holds an app's roles in one of its environments: directly, or through a group, by a binding
 * that is neither revoked nor expired. A task goes to them, and a notice only to them.
 */

/** The active people a binding in the environment gives a role, or any role, of the app. */
async function holders(db: Database, environmentId: string, now: Date, roles: readonly string[] | null): Promise<string[]> {
  const held = await db
    .select({ type: bindings.principalType, id: bindings.principalId })
    .from(bindings)
    .where(
      and(
        eq(bindings.scopeType, 'env'),
        eq(bindings.scopeId, environmentId),
        roles ? inArray(bindings.appRoleId, [...roles]) : sql`${bindings.appRoleId} is not null`,
        isNull(bindings.revokedAt),
        or(isNull(bindings.expiresAt), sql`${bindings.expiresAt} > ${now}`),
      ),
    );
  const direct = held.filter((binding) => binding.type === 'user').map((binding) => binding.id);
  const groupIds = held.filter((binding) => binding.type === 'group').map((binding) => binding.id);
  const viaGroups = groupIds.length ? (await db.select({ id: groupMembers.userId }).from(groupMembers).where(inArray(groupMembers.groupId, groupIds))).map((row) => row.id) : [];
  const candidates = [...new Set([...direct, ...viaGroups])];
  if (!candidates.length) return [];
  const active = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, candidates), eq(users.status, 'active'))).orderBy(asc(users.displayName), asc(users.id));
  return active.map((row) => row.id);
}

/** Who holds a role of an app in an environment, by name order. */
export function roleHolders(db: Database, appId: string, environmentId: string, role: string, now: Date): Promise<string[]> {
  return holders(db, environmentId, now, [appRoleId(appId, role)]);
}

/**
 * Of some people, those who may hear about an app's records in an environment: its owner, for a
 * personal app, and whoever holds one of its roles there.
 */
export async function inAudience(db: Database, appId: string, environmentId: string, people: readonly string[], now: Date): Promise<string[]> {
  if (!people.length) return [];
  const [app] = await db.select({ owner: apps.ownerUserId }).from(apps).where(eq(apps.id, appId));
  const allowed = new Set(await holders(db, environmentId, now, null));
  if (app?.owner) {
    const [owner] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, app.owner), eq(users.status, 'active')));
    if (owner) allowed.add(owner.id);
  }
  return [...new Set(people)].filter((person) => allowed.has(person));
}
