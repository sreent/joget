import { randomUUID } from 'node:crypto';
import { MANAGED_GUARDRAILS, MANAGED_PERMISSION_SETS, MANAGED_ROLES } from '@platform/authz';
import { asc, eq, sql } from 'drizzle-orm';
import { SCHEMA_LOCK_KEY, type Database } from './client.js';
import { guardrails, orgs, permissionSetGrants, permissionSets, rolePermissionSets, roles } from './schema.js';

/**
 * Write the platform-managed permission sets, roles and guardrails. Idempotent; run at startup.
 * An admin's choice to disable a managed guardrail survives re-seeding.
 */
export async function seedManagedPolicy(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`);
    const now = new Date();
    for (const set of MANAGED_PERMISSION_SETS) {
      await tx
        .insert(permissionSets)
        .values({ id: set.id, orgId: null, name: set.name, scopeType: set.scopeType, managed: true })
        .onConflictDoUpdate({ target: permissionSets.id, set: { name: set.name, scopeType: set.scopeType, updatedAt: now } });
      await tx.delete(permissionSetGrants).where(eq(permissionSetGrants.permissionSetId, set.id));
      if (set.grants.length > 0) {
        await tx.insert(permissionSetGrants).values(
          set.grants.map((grant) => ({
            permissionSetId: set.id,
            permission: grant.permission,
            resourceSelector: grant.resource ?? '*',
            condition: (grant.condition as Record<string, unknown> | undefined) ?? null,
          })),
        );
      }
    }
    for (const role of MANAGED_ROLES) {
      await tx
        .insert(roles)
        .values({ id: role.id, orgId: null, name: role.name, scopeType: role.scopeType, managed: true })
        .onConflictDoUpdate({ target: roles.id, set: { name: role.name, scopeType: role.scopeType, updatedAt: now } });
      await tx.delete(rolePermissionSets).where(eq(rolePermissionSets.roleId, role.id));
      await tx.insert(rolePermissionSets).values(role.permissionSetIds.map((permissionSetId) => ({ roleId: role.id, permissionSetId })));
    }
    for (const guardrail of MANAGED_GUARDRAILS) {
      const definition = {
        name: guardrail.name,
        actions: [...guardrail.actions],
        effect: guardrail.effect,
        condition: (guardrail.when as Record<string, unknown> | undefined) ?? null,
        maxMfaAgeSeconds: guardrail.maxMfaAgeSeconds ?? null,
        managed: true,
      };
      await tx
        .insert(guardrails)
        .values({ id: guardrail.id, orgId: null, ...definition })
        .onConflictDoUpdate({ target: guardrails.id, set: { ...definition, updatedAt: now } });
    }
  });
}

/** Return the deployment's organization, creating it on first start. */
export async function ensureSingleOrg(db: Database, name: string): Promise<{ id: string; name: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`);
    const existing = await tx.select({ id: orgs.id, name: orgs.name }).from(orgs).orderBy(asc(orgs.createdAt)).limit(2);
    if (existing.length > 1) throw new Error('This deployment is configured for exactly one organization, but found several');
    if (existing[0]) return existing[0];
    const [created] = await tx.insert(orgs).values({ id: randomUUID(), name }).returning({ id: orgs.id, name: orgs.name });
    return created!;
  });
}
