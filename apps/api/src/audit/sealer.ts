import {
  type AuditEvent,
  createSeal,
  type Seal,
  type SignatureVerifier,
  type Signer,
  type StoredEvent,
  type VerificationReport,
  verifySeals,
} from '@platform/audit';
import { auditEvents, auditSeals, type Database } from '@platform/db';
import { and, asc, between, desc, gt, gte, lt, max, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

/** Advisory-lock key, so only one sealer works at a time across all pods. */
const SEALER_LOCK_KEY = 727_002;

type SealRow = typeof auditSeals.$inferSelect;
type EventRow = typeof auditEvents.$inferSelect;

function toSeal(row: SealRow): Seal {
  return {
    fromSeq: row.fromSeq,
    toSeq: row.toSeq,
    eventCount: row.eventCount,
    merkleRoot: row.merkleRoot,
    prevSealHash: row.prevSealHash,
    sealedAt: row.sealedAt,
    keyId: row.keyId,
    sealHash: row.sealHash,
    signature: row.signature,
  };
}

function toStoredEvent(row: EventRow): StoredEvent {
  const event: AuditEvent = {
    id: row.id,
    occurredAt: row.occurredAt,
    orgId: row.orgId,
    spaceId: row.spaceId,
    appId: row.appId,
    env: row.env,
    actor: row.actor as unknown as AuditEvent['actor'],
    action: row.action,
    target: row.target as unknown as AuditEvent['target'],
    outcome: row.outcome,
    reason: row.reason,
    changes: row.changes,
    context: row.context,
  };
  return { seq: row.seq, digest: row.digest, event };
}

/**
 * Seal the next batch of settled events: those recorded more than `safetyWindowSeconds` ago, so no
 * in-flight transaction can still add an event inside the sealed range. Returns null when there is
 * nothing to seal, or when another sealer holds the lock.
 */
export async function sealNextBatch(db: Database, signer: Signer, options: { safetyWindowSeconds: number; maxEvents?: number }): Promise<Seal | null> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${SEALER_LOCK_KEY}) as locked`);
    if (!lock.rows[0]?.locked) return null;

    const [last] = await tx.select().from(auditSeals).orderBy(desc(auditSeals.toSeq)).limit(1);
    const fromSeq = last ? last.toSeq + 1 : 1;
    const cutoff = sql`clock_timestamp() - make_interval(secs => ${options.safetyWindowSeconds})`;
    const [settled] = await tx
      .select({ toSeq: max(auditEvents.seq) })
      .from(auditEvents)
      .where(and(gte(auditEvents.seq, fromSeq), lt(auditEvents.recordedAt, cutoff)));
    if (!settled?.toSeq) return null;

    const rows = await tx
      .select({ seq: auditEvents.seq, digest: auditEvents.digest })
      .from(auditEvents)
      .where(between(auditEvents.seq, fromSeq, Number(settled.toSeq)))
      .orderBy(asc(auditEvents.seq))
      .limit(options.maxEvents ?? 10_000);
    const toSeq = rows.at(-1)!.seq;
    const seal = await createSeal({ fromSeq, toSeq, digests: rows.map((r) => r.digest) }, last ? toSeal(last) : null, signer);
    await tx.insert(auditSeals).values({ ...seal });
    return seal;
  });
}

/** Seal until caught up. */
export async function sealPending(db: Database, signer: Signer, options: { safetyWindowSeconds: number }): Promise<number> {
  let sealed = 0;
  while (await sealNextBatch(db, signer, options)) sealed++;
  return sealed;
}

/** Run the sealer on an interval. Returns a function that stops it. */
export function startAuditSealer(
  db: Database,
  signer: Signer,
  options: { intervalSeconds: number; safetyWindowSeconds: number; logger: FastifyBaseLogger },
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sealPending(db, signer, options)
      .then((count) => {
        if (count > 0) options.logger.info({ seals: count }, 'Sealed audit events');
      })
      .catch((error: unknown) => options.logger.error({ err: error }, 'Audit sealing failed'))
      .finally(() => {
        running = false;
      });
  }, options.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Verify every seal from the first one, and count the events not sealed yet. */
export async function verifyAuditLog(db: Database, verifier: SignatureVerifier): Promise<VerificationReport & { unsealedEvents: number }> {
  const seals = (await db.select().from(auditSeals).orderBy(asc(auditSeals.fromSeq))).map(toSeal);
  const report = await verifySeals(
    seals,
    async (seal) =>
      (
        await db
          .select()
          .from(auditEvents)
          .where(between(auditEvents.seq, seal.fromSeq, seal.toSeq))
          .orderBy(asc(auditEvents.seq))
      ).map(toStoredEvent),
    verifier,
    { fromGenesis: true },
  );
  const lastSealed = seals.at(-1)?.toSeq ?? 0;
  const unsealedEvents = await db.$count(auditEvents, gt(auditEvents.seq, lastSealed));
  return { ...report, unsealedEvents };
}
