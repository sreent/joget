import { readFile } from 'node:fs/promises';
import { skillCalls, type Database } from '@platform/db';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { recordAudit, SYSTEM_ACTOR } from '../audit/writer.js';

export type SkillTier = 'personal' | 'team' | 'production';

export interface SkillStart {
  /** The call's ID, which a7c gets as the idempotency key: a retry never starts a second run. */
  readonly id: string;
  readonly skill: string;
  readonly tier: SkillTier;
  readonly input: unknown;
}

/** a7c refused or could not take a call. `retry` says whether trying again later can help. */
export class SkillStartError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

/** Where skill calls go. The real one is a7c; tests use a fake. */
export interface SkillRunner {
  start(call: SkillStart): Promise<{ readonly runId: string | null }>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Start runs in a7c through its operation `runs.start` (a7c ADR 0022), as Ambit's service
 * identity. The token is read from a file at each call, so whatever issues short-lived tokens can
 * replace it without a restart.
 */
export function a7cRunner(options: { readonly url: string; readonly tokenFile: string; readonly timeoutMs?: number }): SkillRunner {
  return {
    async start(call) {
      const token = (await readFile(options.tokenFile, 'utf8')).trim();
      let response: Response;
      try {
        response = await fetch(new URL('/api/v1/operations/runs.start', options.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': `ambit-skill-call-${call.id}` },
          body: JSON.stringify({ skill: call.skill, tier: call.tier, input: call.input }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (error) {
        throw new SkillStartError(`a7c can't be reached: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) return { runId: isObject(body) && typeof body['run'] === 'string' ? body['run'] : null };
      const kind = isObject(body) && isObject(body['error']) && typeof body['error']['kind'] === 'string' ? body['error']['kind'] : undefined;
      // a7c is down or busy, or the token expired: later can work. Anything else is the call itself.
      const retry = response.status >= 500 || [401, 408, 429].includes(response.status);
      throw new SkillStartError(`a7c answered ${response.status}${kind ? ` (${kind})` : ''}`, retry);
    },
  };
}

/** Wait before the next try: 10 seconds, doubling, at most an hour. */
export function backoffSeconds(attempts: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempts - 1), 3600);
}

type CallRow = typeof skillCalls.$inferSelect;

/**
 * Start the skill calls that are due. Pods share the work: each claims a batch with SKIP LOCKED
 * and holds it for a lease, so a crash in the middle of a call only delays that call.
 */
export class SkillDispatcher {
  readonly #db: Database;
  readonly #runner: SkillRunner;
  readonly #now: () => Date;
  readonly #maxAttempts: number;

  constructor(db: Database, runner: SkillRunner, options: { readonly now: () => Date; readonly maxAttempts: number }) {
    this.#db = db;
    this.#runner = runner;
    this.#now = options.now;
    this.#maxAttempts = options.maxAttempts;
  }

  /** Try the calls that are due, a batch at a time. Returns how many it tried. */
  async dispatchDue(batch = 20): Promise<number> {
    const now = this.#now();
    const claimed = await this.#db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(skillCalls)
        .where(and(eq(skillCalls.status, 'pending'), lte(skillCalls.nextAttemptAt, now)))
        .orderBy(asc(skillCalls.nextAttemptAt))
        .limit(batch)
        .for('update', { skipLocked: true });
      if (!due.length) return [];
      await tx
        .update(skillCalls)
        .set({ attempts: sql`${skillCalls.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(inArray(skillCalls.id, due.map((call) => call.id)));
      return due.map((call) => ({ ...call, attempts: call.attempts + 1 }));
    });
    for (const call of claimed) await this.#try(call);
    return claimed.length;
  }

  async #try(call: CallRow): Promise<void> {
    const audit = (tx: Parameters<typeof recordAudit>[0], action: string, reason: Record<string, unknown>) =>
      recordAudit(tx, { orgId: call.orgId, actor: SYSTEM_ACTOR, now: this.#now(), context: {} }, {
        action,
        target: { type: 'skill_call', id: call.id, name: call.skill },
        appId: call.appId,
        reason: { skill: call.skill, tier: call.tier, action: call.action, recordId: call.recordId, attempts: call.attempts, ...reason },
        ...(action === 'skill_call.fail' ? { outcome: 'error' as const } : {}),
      });
    try {
      const { runId } = await this.#runner.start({ id: call.id, skill: call.skill, tier: call.tier, input: call.input });
      await this.#db.transaction(async (tx) => {
        await tx.update(skillCalls).set({ status: 'started', runId, startedAt: this.#now(), lastError: null }).where(eq(skillCalls.id, call.id));
        await audit(tx, 'skill_call.start', runId ? { runId } : {});
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const giveUp = (error instanceof SkillStartError && !error.retry) || call.attempts >= this.#maxAttempts;
      await this.#db.transaction(async (tx) => {
        if (giveUp) {
          await tx.update(skillCalls).set({ status: 'failed', lastError: message }).where(eq(skillCalls.id, call.id));
          await audit(tx, 'skill_call.fail', { error: message });
        } else {
          const next = new Date(this.#now().getTime() + backoffSeconds(call.attempts) * 1000);
          await tx.update(skillCalls).set({ lastError: message, nextAttemptAt: next }).where(eq(skillCalls.id, call.id));
        }
      });
    }
  }
}

/** Run the dispatcher on an interval. Returns a function that stops it. */
export function startSkillDispatcher(
  dispatcher: SkillDispatcher,
  options: { readonly intervalSeconds: number; readonly logger: { error(obj: object, message: string): void } },
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatcher
      .dispatchDue()
      .catch((error: unknown) => options.logger.error({ err: error }, 'Starting skill calls in a7c failed'))
      .finally(() => (running = false));
  }, options.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
