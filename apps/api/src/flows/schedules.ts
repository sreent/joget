import { uuidv7 } from '@platform/audit';
import { flowWaits, nextRun, Schedule, type StoredDefinition } from '@platform/app-model';
import { flowSchedules, type Database } from '@platform/db';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { LoadedApp } from '../apps/catalog.js';
import type { Writer } from '../apps/runtime.js';
import { withAppTransaction } from '../apps/transaction.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import type { FlowEngine } from './engine.js';

/*
 * Flows on a schedule (design §6.11). An environment plans the schedules of the definition it runs,
 * each time its active revision changes. A timer worker runs each flow once at each of its times,
 * in a transaction of its own, with the app's authority and no person. A run that the platform
 * missed, such as while it was down, runs once when it comes back, and the next time counts on
 * from then: missed times don't pile up.
 */

type ScheduleRow = typeof flowSchedules.$inferSelect;

/** How many tries a run gets before it waits for the schedule's next time. */
const MAX_ATTEMPTS = 3;

/** Wait before the next try: 30 seconds, doubling. */
const backoffSeconds = (attempts: number) => 30 * 2 ** Math.max(0, attempts - 1);

/** Whether two schedules run at the same times. Stored JSON comes back with its keys in another order. */
function sameSchedule(a: Schedule, stored: unknown): boolean {
  const b = Schedule.safeParse(stored);
  return b.success && a.every === b.data.every && a.at === b.data.at && a.on === b.data.on && a.day === b.data.day && (a.zone ?? 'UTC') === (b.data.zone ?? 'UTC');
}

/**
 * Plan the schedules of an environment from the definition it now runs, in the transaction that
 * changes its revision. A new or changed schedule runs next from now; a flow no longer on a
 * schedule stops. A preview shows a change to its reviewers, so its flows run only by hand.
 */
export async function planSchedules(db: Database, orgId: string, env: { readonly id: string; readonly appId: string; readonly kind: string }, definition: StoredDefinition, now: Date): Promise<void> {
  const flows = definition.flows ?? {};
  const wanted = new Map(
    env.kind === 'preview'
      ? []
      : Object.entries(flows).flatMap(([name, flow]) => (flow.schedule && !Object.keys(flow.input).length && !flowWaits(flow, flows) ? [[name, flow.schedule] as const] : [])),
  );
  const planned = await db.select().from(flowSchedules).where(eq(flowSchedules.environmentId, env.id));
  const stopped = planned.filter((row) => !wanted.has(row.flow));
  if (stopped.length) await db.delete(flowSchedules).where(inArray(flowSchedules.id, stopped.map((row) => row.id)));
  for (const [flow, schedule] of wanted) {
    const row = planned.find((each) => each.flow === flow);
    if (row && sameSchedule(schedule, row.schedule)) continue;
    const next = nextRun(schedule, now);
    if (row) {
      await db.update(flowSchedules).set({ schedule, nextRunAt: next, nextAttemptAt: next, attempts: 0, lastError: null }).where(eq(flowSchedules.id, row.id));
    } else {
      await db.insert(flowSchedules).values({ id: uuidv7(now.getTime()), orgId, appId: env.appId, environmentId: env.id, flow, schedule, nextRunAt: next, nextAttemptAt: next, createdAt: now });
    }
  }
}

/** When a flow on a schedule runs next in an environment, and how its last run went. */
export async function plannedRun(db: Database, environmentId: string, flow: string): Promise<{ readonly nextRunAt: string; readonly lastRunAt: string | null; readonly lastError: string | null } | undefined> {
  const [row] = await db.select().from(flowSchedules).where(and(eq(flowSchedules.environmentId, environmentId), eq(flowSchedules.flow, flow)));
  return row ? { nextRunAt: row.nextRunAt.toISOString(), lastRunAt: row.lastRunAt?.toISOString() ?? null, lastError: row.lastError } : undefined;
}

/** A scheduled run writes as its schedule, with the app's authority: the audit log and the history name it. */
function scheduleWriter(orgId: string, row: ScheduleRow): Writer {
  return {
    actorId: row.id,
    scope: (now) => ({ orgId, now, actor: { type: 'system', id: `schedule:${row.id}`, via: 'system' }, context: { schedule: row.id, flow: row.flow } }),
    history: { actorType: 'schedule', actorId: row.id, onBehalfOf: null },
  };
}

export class FlowScheduler {
  readonly #ctx: AppContext;
  readonly #flows: FlowEngine;

  constructor(ctx: AppContext, flows: FlowEngine) {
    this.#ctx = ctx;
    this.#flows = flows;
  }

  /** Run the flows whose time has come, a batch at a time. Pods share the work through SKIP LOCKED. Returns how many it tried. */
  async runDue(batch = 10): Promise<number> {
    const now = this.#ctx.now();
    const claimed = await this.#ctx.db.transaction(async (tx) => {
      const due = await tx.select().from(flowSchedules).where(lte(flowSchedules.nextAttemptAt, now)).orderBy(asc(flowSchedules.nextAttemptAt)).limit(batch).for('update', { skipLocked: true });
      if (!due.length) return [];
      // A try holds the run for a minute, so a crash only delays it.
      await tx
        .update(flowSchedules)
        .set({ attempts: sql`${flowSchedules.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(inArray(flowSchedules.id, due.map((row) => row.id)));
      return due.map((row) => ({ ...row, attempts: row.attempts + 1 }));
    });
    for (const row of claimed) {
      try {
        await this.#run(row);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        const schedule = Schedule.safeParse(row.schedule);
        const at = this.#ctx.now();
        // A run that keeps failing waits for the schedule's next time.
        const next = row.attempts >= MAX_ATTEMPTS && schedule.success ? nextRun(schedule.data, at) : null;
        await this.#ctx.db
          .update(flowSchedules)
          .set(next ? { lastError: message, nextRunAt: next, nextAttemptAt: next, attempts: 0 } : { lastError: message, nextAttemptAt: new Date(at.getTime() + backoffSeconds(row.attempts) * 1000) })
          .where(eq(flowSchedules.id, row.id));
      }
    }
    return claimed.length;
  }

  async #run(row: ScheduleRow): Promise<void> {
    const gone = () => this.#ctx.db.delete(flowSchedules).where(eq(flowSchedules.id, row.id));
    let loaded: LoadedApp;
    try {
      loaded = await this.#ctx.apps.load(row.appId, { id: row.environmentId });
    } catch (error) {
      // The environment is gone: so is its schedule.
      if (error instanceof HttpError && error.statusCode === 404) return void (await gone());
      throw error;
    }
    const schedule = Schedule.safeParse(row.schedule);
    const flow = loaded.definition.flows?.[row.flow];
    // An app that moved to a team space runs there; a flow no longer on this schedule waits to be planned again.
    if (loaded.app.movedTo || !flow?.schedule || !schedule.success) return void (await gone());
    await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      const [current] = await tx.db.select().from(flowSchedules).where(and(eq(flowSchedules.id, row.id), eq(flowSchedules.nextRunAt, row.nextRunAt))).for('update');
      // A new release planned it again meanwhile.
      if (!current) return;
      await this.#flows.run(tx, loaded, row.flow, {}, { writer: scheduleWriter(this.#ctx.org.id, row), principal: {}, auth: null, trigger: { kind: 'schedule', name: row.flow } });
      const ran = this.#ctx.now();
      const next = nextRun(schedule.data, new Date(Math.max(ran.getTime(), row.nextRunAt.getTime())));
      await tx.db.update(flowSchedules).set({ lastRunAt: ran, nextRunAt: next, nextAttemptAt: next, attempts: 0, lastError: null }).where(eq(flowSchedules.id, row.id));
    });
  }
}
