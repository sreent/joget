import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@platform/db/testing';
import { MANAGED_GUARDRAILS, MANAGED_PERMISSION_SETS, MANAGED_ROLES } from '@platform/authz';
import {
  auditEvents,
  auditSeals,
  createDatabase,
  ensureSingleOrg,
  guardrails,
  migrateDatabase,
  permissionSets,
  roles,
  seedManagedPolicy,
  type DatabaseHandle,
} from '@platform/db';
import { eq, sql } from 'drizzle-orm';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let handle: DatabaseHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDatabase(testDb.url);
  // Two concurrent runs must not conflict: they serialize on an advisory lock.
  await Promise.all([migrateDatabase(handle.pool), migrateDatabase(handle.pool)]);
});

afterAll(async () => {
  await handle?.close();
  await testDb?.drop();
});

describe('migrations and seeding', () => {
  it('seeds the managed policy idempotently, keeping a disabled guardrail disabled', async () => {
    await seedManagedPolicy(handle.db);
    await handle.db.update(guardrails).set({ enabled: false }).where(eq(guardrails.id, 'gr.step-up.export'));
    await Promise.all([seedManagedPolicy(handle.db), seedManagedPolicy(handle.db)]);

    expect(await handle.db.$count(permissionSets)).toBe(MANAGED_PERMISSION_SETS.length);
    expect(await handle.db.$count(roles)).toBe(MANAGED_ROLES.length);
    expect(await handle.db.$count(guardrails)).toBe(MANAGED_GUARDRAILS.length);
    const [exportGuardrail] = await handle.db.select().from(guardrails).where(eq(guardrails.id, 'gr.step-up.export'));
    expect(exportGuardrail?.enabled).toBe(false);
  });

  it('creates exactly one organization, even when asked twice at once', async () => {
    const [a, b] = await Promise.all([ensureSingleOrg(handle.db, 'Acme'), ensureSingleOrg(handle.db, 'Acme')]);
    expect(a.id).toBe(b.id);
  });
});

describe('the audit log is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on audit events and seals', async () => {
    const org = await ensureSingleOrg(handle.db, 'Acme');
    await handle.db.insert(auditEvents).values({
      id: '0190a0b0-0000-7000-8000-000000000001',
      occurredAt: new Date(),
      orgId: org.id,
      actor: { type: 'system', id: 'test' },
      action: 'test.event',
      outcome: 'success',
      digest: 'x',
    });
    await handle.db.insert(auditSeals).values({
      fromSeq: 1,
      toSeq: 1,
      eventCount: 1,
      merkleRoot: 'r',
      sealedAt: new Date(),
      keyId: 'k',
      sealHash: 'h',
      signature: 's',
    });

    const attempts = [
      handle.db.update(auditEvents).set({ action: 'edited' }),
      handle.db.delete(auditEvents),
      handle.db.execute(sql`truncate audit_events`),
      handle.db.update(auditSeals).set({ keyId: 'edited' }),
      handle.db.delete(auditSeals),
      handle.db.execute(sql`truncate audit_seals`),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    }
    expect(await handle.db.$count(auditEvents)).toBe(1);
  });
});
