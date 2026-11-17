import { uuidv7 } from '@platform/audit';
import {
  addDuration,
  appRoleName,
  elementName,
  evaluateExpression,
  flowsOut,
  processGraph,
  startsOf,
  timerFiresAt,
  type ExpressionValue,
  type Process,
  type ProcessGraph,
  type RecordValues,
  type UserTaskElement,
} from '@platform/app-model';
import { apps, processEvents, processInstances, processTasks, processTimers, processTokens, users, type Database } from '@platform/db';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { auditScopeFor, recordAudit, SYSTEM_ACTOR, type AuditScope } from '../audit/writer.js';
import type { LoadedApp } from '../apps/catalog.js';
import { processWriter, type AppRuntime, type ProcessHooks, type ProcessOrigin, type Writer } from '../apps/runtime.js';
import { withAppTransaction, type AppTransaction } from '../apps/transaction.js';
import type { AppContext, AuthContext } from '../context.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { coverFor, departmentOf, managerUp } from '../people/directory.js';
import { backoffSeconds } from '../skills/dispatcher.js';

/*
 * The process engine (design §6.10). Instances, tokens, tasks and timers are rows in PostgreSQL,
 * and a process moves in the transaction of the change that moves it: the action that starts it,
 * the outcome that completes a task, or a timer. So a record and its process never disagree.
 *
 * Tokens are kept only while they wait: at a user task, at a timer, at a parallel gateway for the
 * other paths, or where they got stuck. Everything else happens within one transaction.
 */

type InstanceRow = typeof processInstances.$inferSelect;
type TaskRow = typeof processTasks.$inferSelect;
type TimerRow = typeof processTimers.$inferSelect;
type EventKind = (typeof processEvents.$inferInsert)['kind'];

/** The most moves a process makes in one transaction: a path that loops without waiting stops here. */
const MAX_MOVES = 500;

/** An instance that this transaction works on, locked. */
interface Live {
  readonly row: InstanceRow;
  readonly process: Process;
  readonly graph: ProcessGraph;
  /** The entity of its record. */
  readonly entity: string;
  readonly outcomes: Record<string, string>;
  ended: boolean;
  /** The end event a path last reached, which the instance ends at when no path is left. */
  reached: string | null;
}

/** One transaction's worth of process work: tokens arrive at elements until each waits or ends. */
interface Turn {
  readonly tx: AppTransaction;
  /** The environment as it runs now: service tasks run its actions. */
  readonly loaded: LoadedApp;
  /** Who moves the processes, for the audit log: a person's request, or the platform. */
  readonly scope: (now: Date) => AuditScope;
  /** The person behind the move, if there is one. */
  readonly by: string | null;
  readonly now: Date;
  readonly live: Map<string, Live>;
  readonly queue: Array<{ readonly instanceId: string; readonly element: string; readonly flow: string | null }>;
  readonly records: Map<string, RecordValues | null>;
  moves: number;
}

export interface TaskView {
  readonly id: string;
  readonly name: string;
  readonly status: TaskRow['status'];
  readonly app: { readonly id: string; readonly name: string };
  readonly environment: { readonly id: string };
  readonly process: string;
  readonly instanceId: string;
  readonly element: string;
  readonly entity: string;
  readonly recordId: string;
  readonly role: string;
  readonly assignee: { readonly id: string; readonly name: string | null } | null;
  readonly outcomes: TaskRow['outcomes'];
  readonly card: string | null;
  readonly due: string | null;
  readonly overdue: boolean;
  readonly outcome: string | null;
  readonly completedBy: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface InstanceView {
  readonly id: string;
  readonly process: string;
  readonly label: string;
  readonly revision: number;
  readonly entity: string;
  readonly recordId: string;
  readonly status: InstanceRow['status'];
  /** Where it waits for an operator, and why. */
  readonly stuck: Array<{ readonly element: string; readonly name: string; readonly error: string }>;
  /** Where it waits: tasks, timers and gateways. */
  readonly waiting: Array<{ readonly element: string; readonly name: string }>;
  readonly startedBy: string | null;
  readonly startedByAction: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface InstanceDetail extends InstanceView {
  readonly tasks: TaskView[];
  readonly events: Array<{ readonly at: string; readonly kind: EventKind; readonly element: string | null; readonly name: string | null; readonly by: string | null; readonly detail: unknown }>;
}

/** Whether a person may decide a task: the one it waits for, or, for nobody in particular, anyone with its role in its department. */
function decidable(task: Pick<TaskRow, 'assignee' | 'department'>, actorId: string, department: string | null): boolean {
  if (task.assignee) return task.assignee === actorId;
  return !task.department || task.department === department;
}

export class ProcessEngine implements ProcessHooks {
  readonly #ctx: AppContext;
  readonly #runtime: AppRuntime;

  constructor(ctx: AppContext, runtime: AppRuntime) {
    this.#ctx = ctx;
    this.#runtime = runtime;
    runtime.attachProcesses(this);
  }

  // ---- What the runtime asks of the engine around an action

  async checkDecider(tx: AppTransaction, loaded: LoadedApp, recordId: string, action: string, actorId: string): Promise<void> {
    const open = await this.#tasksDecidedBy(tx.db, loaded, recordId, action, false);
    if (!open.length) return;
    const department = await departmentOf(tx.db, actorId);
    if (open.some((task) => decidable(task, actorId, department))) return;
    const [task] = open;
    if (task!.assignee) throw forbidden('task_assigned', `${task!.name} waits for ${await this.#personName(tx.db, task!.assignee)}: only they can decide it`);
    throw forbidden('task_department', `${task!.name} waits for someone in ${task!.department}`);
  }

  async afterAction(
    tx: AppTransaction,
    loaded: LoadedApp,
    event: { readonly action: string; readonly recordId: string; readonly by: AuthContext['actor']; readonly writer: Writer },
  ): Promise<void> {
    const decides = (loaded.definition.processes && Object.keys(loaded.definition.processes).length) || (await this.#hasOpenTasks(tx.db, loaded, event.recordId));
    if (!decides) return;
    const turn = this.#turn(tx, loaded, event.writer.scope, event.by.type === 'user' ? event.by.id : null);
    await this.#actionCommitted(turn, event.action, event.recordId, event.by.type === 'user' ? event.by.id : null);
    await this.#drain(turn);
  }

  // ---- People and operators

  /** Start a process on a record by hand, for someone whose role may start it. */
  async start(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, processName: string, recordId: string): Promise<InstanceView> {
    const process = loaded.definition.processes?.[processName];
    if (!process) throw notFound('Process');
    // The person must be able to see the record they start it on.
    await this.#runtime.get(request, auth, loaded, process.entity, recordId);
    const startAt =
      Object.entries(process.elements).find(([, element]) => element.type === 'startEvent' && !element.actions.length)?.[0] ??
      Object.entries(process.elements).find(([, element]) => element.type === 'startEvent')![0];
    const id = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      if (!(await this.#runtime.lockRecord(tx, loaded, process.entity, recordId))) throw notFound('Record');
      const turn = this.#turn(tx, loaded, (now) => auditScopeFor(request, this.#ctx.org.id, now), auth.actor.type === 'user' ? auth.actor.id : null);
      const live = await this.#start(turn, processName, startAt, recordId, null);
      await this.#drain(turn);
      return live.row.id;
    });
    return this.#view((await this.#instanceRow(id))!);
  }

  /**
   * Complete a task with an outcome, as the person it waits for or someone with its role. An
   * outcome that runs an action runs it as that person, under their permissions: the action's
   * commit completes the task. From an agent, that action may become a proposal to approve first.
   */
  async complete(
    request: FastifyRequest,
    auth: AuthContext,
    taskId: string,
    input: { readonly outcome: string; readonly values?: Readonly<Record<string, unknown>>; readonly provenance?: unknown },
  ): Promise<{ readonly task: TaskView; readonly result: Awaited<ReturnType<AppRuntime['runAction']>> | null }> {
    const task = await this.#taskRow(taskId);
    if (!task) throw notFound('Task');
    const loaded = await this.#ctx.apps.load(task.appId, { id: task.environmentId });
    await this.#mayDo(auth, task);
    if (task.status !== 'open') throw conflict('task_closed', `${task.name} is already ${task.status}`);
    const outcome = task.outcomes.find((candidate) => candidate.name === input.outcome);
    if (!outcome) throw unprocessable('unknown_outcome', `${task.name} has no outcome ${input.outcome}: choose ${task.outcomes.map((o) => o.name).join(' or ')}`);
    // An agent's choice becomes a proposal through the outcome's action; without one, there is nothing to approve.
    if (!outcome.action && auth.credential.kind === 'token') {
      throw forbidden('person_only', `${outcome.label} runs no action, so only the person can choose it, in Ambit`);
    }
    let result: Awaited<ReturnType<AppRuntime['runAction']>> | null = null;
    if (outcome.action) {
      await this.#runtime.checkCapability(request, auth, loaded, 'action', outcome.action);
      result = await this.#runtime.runAction(request, auth, loaded, outcome.action, {
        values: input.values ?? {},
        recordId: task.recordId,
        ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      });
    } else {
      await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
        await this.#runtime.lockRecord(tx, loaded, task.entity, task.recordId);
        const [locked] = await tx.db.select().from(processTasks).where(eq(processTasks.id, task.id)).for('update');
        if (locked!.status !== 'open') throw conflict('task_closed', `${task.name} is already ${locked!.status}`);
        const turn = this.#turn(tx, loaded, (now) => auditScopeFor(request, this.#ctx.org.id, now), auth.actor.type === 'user' ? auth.actor.id : null);
        await this.#completeTask(turn, locked!, outcome.name, auth.actor.type === 'user' ? auth.actor.id : null);
        await this.#drain(turn);
      });
    }
    return { task: (await this.#taskViews(eq(processTasks.id, task.id), 1))[0]!, result };
  }

  /**
   * Give a task to someone else: its assignee hands it to a colleague, an operator moves it, or
   * someone with its role takes one that waits for nobody in particular. The new assignee must
   * hold the task's role: routing never grants.
   */
  async reassign(request: FastifyRequest, auth: AuthContext, taskId: string, to: string, options: { readonly operator: boolean }): Promise<TaskView> {
    const task = await this.#taskRow(taskId);
    if (!task) throw notFound('Task');
    if (task.status !== 'open') throw conflict('task_closed', `${task.name} is already ${task.status}`);
    const me = auth.actor.id;
    if (!options.operator) {
      if (task.assignee && task.assignee !== me) throw forbidden('task_assigned', `${task.name} waits for ${await this.#personName(this.#ctx.db, task.assignee)}`);
      if (!task.assignee) await this.#mayDo(auth, task);
    }
    const [person] = await this.#ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, to), eq(users.orgId, this.#ctx.org.id), eq(users.status, 'active')));
    if (!person) throw unprocessable('unknown_person', 'Give someone active in the directory');
    const held = await this.#ctx.policy.bindingsFor(await this.#ctx.policy.userPrincipal(to));
    if (!held.some((binding) => binding.scope.type === 'env' && binding.scope.id === task.environmentId && binding.roleId && appRoleName(task.appId, binding.roleId) === task.role)) {
      throw unprocessable('not_in_role', `They don't hold the role ${task.role} here, so they couldn't decide the task`);
    }
    const loaded = await this.#ctx.apps.load(task.appId, { id: task.environmentId });
    await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      await this.#runtime.lockRecord(tx, loaded, task.entity, task.recordId);
      const [locked] = await tx.db.select().from(processTasks).where(eq(processTasks.id, task.id)).for('update');
      if (locked!.status !== 'open') throw conflict('task_closed', `${task.name} is already ${locked!.status}`);
      await tx.db.update(processTasks).set({ assignee: to }).where(eq(processTasks.id, task.id));
      const turn = this.#turn(tx, loaded, (now) => auditScopeFor(request, this.#ctx.org.id, now), auth.actor.type === 'user' ? me : null);
      const live = await this.#live(turn, task.instanceId);
      await this.#event(turn, live, 'reassigned', task.element, { task: task.id, from: locked!.assignee, to });
      await this.#audit(turn, live, 'process.task.reassign', { task: task.id, from: locked!.assignee, to, byOperator: options.operator }, { type: 'process_task', id: task.id, name: task.name });
    });
    return (await this.#taskViews(eq(processTasks.id, task.id), 1, 'all'))[0]!;
  }

  /** The app and environment a task belongs to, for checking who may operate it. */
  async taskPlace(taskId: string): Promise<{ readonly appId: string; readonly environmentId: string } | null> {
    const task = await this.#taskRow(taskId);
    return task ? { appId: task.appId, environmentId: task.environmentId } : null;
  }

  /** Tasks a person may do: theirs, and those of their roles that wait for nobody in particular. Soonest due first. */
  async inbox(auth: AuthContext, options: { readonly status: 'open' | 'closed'; readonly limit: number }): Promise<TaskView[]> {
    const me = auth.actor.id;
    const roles = (await this.#ctx.policy.bindingsFor(auth.principal)).flatMap((binding) => {
      if (binding.scope.type !== 'env' || !binding.roleId?.startsWith('app:')) return [];
      const appId = binding.roleId.split(':')[1]!;
      const role = appRoleName(appId, binding.roleId);
      return role ? [and(eq(processTasks.environmentId, binding.scope.id), eq(processTasks.role, role))!] : [];
    });
    const department = await departmentOf(this.#ctx.db, me);
    const inDepartment = department ? or(isNull(processTasks.department), eq(processTasks.department, department)) : isNull(processTasks.department);
    const mine = or(eq(processTasks.assignee, me), ...(roles.length ? [and(isNull(processTasks.assignee), or(...roles), inDepartment)] : []))!;
    if (options.status === 'open') return this.#taskViews(and(eq(processTasks.status, 'open'), mine)!, options.limit);
    return this.#taskViews(and(sql`${processTasks.status} <> 'open'`, or(eq(processTasks.completedBy, me), mine))!, options.limit, 'closed');
  }

  /** The instances of an app in an environment, newest first: for its owner or its operators. */
  async instances(loaded: LoadedApp, filter: { readonly status?: InstanceRow['status']; readonly recordId?: string; readonly stuck?: boolean; readonly limit: number }): Promise<InstanceView[]> {
    const conditions = [eq(processInstances.environmentId, loaded.env.id)];
    if (filter.status) conditions.push(eq(processInstances.status, filter.status));
    if (filter.recordId) conditions.push(eq(processInstances.recordId, filter.recordId));
    if (filter.stuck) conditions.push(sql`exists (select 1 from ${processTokens} where ${processTokens.instanceId} = ${processInstances.id} and ${processTokens.state} = 'stuck')`);
    const rows = await this.#ctx.db.select().from(processInstances).where(and(...conditions)).orderBy(desc(processInstances.startedAt)).limit(filter.limit);
    return Promise.all(rows.map((row) => this.#view(row)));
  }

  /** One instance, with its tasks and its history. */
  async instance(loaded: LoadedApp, id: string): Promise<InstanceDetail> {
    const row = await this.#instanceRow(id);
    if (!row || row.environmentId !== loaded.env.id) throw notFound('Process instance');
    const view = await this.#view(row);
    const process = await this.#processOf(row);
    const events = await this.#ctx.db.select().from(processEvents).where(eq(processEvents.instanceId, id)).orderBy(asc(processEvents.seq));
    return {
      ...view,
      tasks: await this.#taskViews(eq(processTasks.instanceId, id), 200, 'all'),
      events: events.map((event) => ({
        at: event.at.toISOString(),
        kind: event.kind,
        element: event.element,
        name: event.element && process ? elementName(process, event.element) : null,
        by: event.by,
        detail: event.detail,
      })),
    };
  }

  /** Try a stuck instance again from where it stopped, for example once the record is fixed. */
  async retry(request: FastifyRequest, loaded: LoadedApp, id: string): Promise<InstanceView> {
    await this.#withInstance(request, loaded, id, async (turn, live) => {
      const stuck = await turn.tx.db.select().from(processTokens).where(and(eq(processTokens.instanceId, id), eq(processTokens.state, 'stuck')));
      if (!stuck.length) throw conflict('not_stuck', 'The instance is not stuck');
      await turn.tx.db.delete(processTokens).where(inArray(processTokens.id, stuck.map((token) => token.id)));
      for (const token of stuck) {
        await this.#event(turn, live, 'retried', token.element, { error: token.error });
        turn.queue.push({ instanceId: id, element: token.element, flow: token.arrivedBy });
      }
      await this.#audit(turn, live, 'process.retry', { elements: stuck.map((token) => token.element) });
    });
    return this.#view((await this.#instanceRow(id))!);
  }

  /** End an instance where it is: its open tasks and timers go with it. */
  async cancel(request: FastifyRequest, loaded: LoadedApp, id: string): Promise<InstanceView> {
    await this.#withInstance(request, loaded, id, async (turn, live) => this.#end(turn, live, 'cancelled'));
    return this.#view((await this.#instanceRow(id))!);
  }

  // ---- Timers

  /** Fire the timers that are due, a batch at a time. Pods share the work through SKIP LOCKED. Returns how many it tried. */
  async fireDue(batch = 20): Promise<number> {
    const now = this.#ctx.now();
    const claimed = await this.#ctx.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(processTimers)
        .where(and(eq(processTimers.status, 'waiting'), lte(processTimers.nextAttemptAt, now)))
        .orderBy(asc(processTimers.nextAttemptAt))
        .limit(batch)
        .for('update', { skipLocked: true });
      if (!due.length) return [];
      // A try holds the timer for a minute, so a crash only delays it.
      await tx
        .update(processTimers)
        .set({ attempts: sql`${processTimers.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(inArray(processTimers.id, due.map((timer) => timer.id)));
      return due.map((timer) => ({ ...timer, attempts: timer.attempts + 1 }));
    });
    for (const timer of claimed) {
      try {
        await this.#fire(timer);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        await this.#ctx.db
          .update(processTimers)
          .set({ lastError: message, nextAttemptAt: new Date(this.#ctx.now().getTime() + backoffSeconds(timer.attempts) * 1000) })
          .where(eq(processTimers.id, timer.id));
      }
    }
    return claimed.length;
  }

  async #fire(timer: TimerRow): Promise<void> {
    const row = await this.#instanceRow(timer.instanceId);
    if (!row || row.status !== 'running') {
      await this.#ctx.db.update(processTimers).set({ status: 'cancelled' }).where(eq(processTimers.id, timer.id));
      return;
    }
    const loaded = await this.#ctx.apps.load(row.appId, { id: row.environmentId });
    const scope = (now: Date): AuditScope => ({ orgId: this.#ctx.org.id, actor: SYSTEM_ACTOR, now, context: { timer: timer.id } });
    await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      // The record first, then the instance: the order an action takes them in.
      await this.#runtime.lockRecord(tx, loaded, row.entity, row.recordId);
      const [current] = await tx.db.select().from(processTimers).where(eq(processTimers.id, timer.id)).for('update');
      if (!current || current.status !== 'waiting') return;
      const turn = this.#turn(tx, loaded, scope, null);
      const live = await this.#live(turn, row.id);
      if (live.row.status !== 'running') {
        await tx.db.update(processTimers).set({ status: 'cancelled' }).where(eq(processTimers.id, timer.id));
        return;
      }
      await tx.db.update(processTimers).set({ status: 'fired', firedAt: turn.now, lastError: null }).where(eq(processTimers.id, timer.id));
      const element = live.process.elements[timer.element];
      await this.#event(turn, live, 'timer_fired', timer.element, null);
      if (timer.tokenId) {
        await tx.db.delete(processTokens).where(eq(processTokens.id, timer.tokenId));
        await this.#leave(turn, live, timer.element);
      } else if (timer.taskId && element?.type === 'boundaryEvent') {
        const [task] = await tx.db.select().from(processTasks).where(eq(processTasks.id, timer.taskId)).for('update');
        if (!task || task.status !== 'open') return;
        if (element.interrupting) await this.#closeTask(turn, live, task, 'timer');
        await this.#audit(turn, live, 'process.escalate', { task: task.id, timer: timer.element, interrupting: element.interrupting });
        await this.#leave(turn, live, timer.element);
      }
      await this.#drain(turn);
    });
  }

  // ---- The engine

  #turn(tx: AppTransaction, loaded: LoadedApp, scope: (now: Date) => AuditScope, by: string | null): Turn {
    return { tx, loaded, scope, by, now: this.#ctx.now(), live: new Map(), queue: [], records: new Map(), moves: 0 };
  }

  async #withInstance(request: FastifyRequest, loaded: LoadedApp, id: string, work: (turn: Turn, live: Live) => Promise<void>): Promise<void> {
    const row = await this.#instanceRow(id);
    if (!row || row.environmentId !== loaded.env.id) throw notFound('Process instance');
    const auth = request.auth;
    await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      await this.#runtime.lockRecord(tx, loaded, row.entity, row.recordId);
      const turn = this.#turn(tx, loaded, (now) => auditScopeFor(request, this.#ctx.org.id, now), auth?.actor.type === 'user' ? auth.actor.id : null);
      const live = await this.#live(turn, id);
      if (live.row.status !== 'running') throw conflict('not_running', `The instance is already ${live.row.status}`);
      await work(turn, live);
      await this.#drain(turn);
    });
  }

  /** An instance, locked for the rest of the transaction, with the process of the revision it runs on. */
  async #live(turn: Turn, id: string): Promise<Live> {
    const known = turn.live.get(id);
    if (known) return known;
    const [row] = await turn.tx.db.select().from(processInstances).where(eq(processInstances.id, id)).for('update');
    if (!row) throw notFound('Process instance');
    const process = await this.#processOf(row, turn.tx.db);
    if (!process) throw conflict('process_missing', `Revision ${row.revision} has no process ${row.process}`);
    const live: Live = { row, process, graph: processGraph(process), entity: row.entity, outcomes: { ...row.outcomes }, ended: row.status !== 'running', reached: null };
    turn.live.set(id, live);
    return live;
  }

  async #processOf(row: InstanceRow, executor: Database = this.#ctx.db): Promise<Process | undefined> {
    return (await this.#ctx.apps.definition(row.appId, row.revision, executor)).processes?.[row.process];
  }

  async #record(turn: Turn, live: Live): Promise<RecordValues | null> {
    if (!turn.records.has(live.row.recordId)) turn.records.set(live.row.recordId, await this.#runtime.recordIn(turn.tx, turn.loaded, live.entity, live.row.recordId));
    return turn.records.get(live.row.recordId)!;
  }

  /** What an action's commit does to processes: it completes the tasks it decides, then starts the processes it starts. */
  async #actionCommitted(turn: Turn, action: string, recordId: string, actorId: string | null): Promise<void> {
    const department = actorId ? await departmentOf(turn.tx.db, actorId) : null;
    for (const task of await this.#tasksDecidedBy(turn.tx.db, turn.loaded, recordId, action, true)) {
      if (!(actorId ? decidable(task, actorId, department) : !task.assignee && !task.department)) continue;
      const outcome = task.outcomes.find((candidate) => candidate.action === action)!;
      await this.#completeTask(turn, task, outcome.name, actorId);
    }
    for (const start of startsOf(turn.loaded.definition, action)) await this.#start(turn, start.process, start.element, recordId, action);
  }

  async #start(turn: Turn, name: string, startAt: string, recordId: string, action: string | null): Promise<Live> {
    const process = turn.loaded.definition.processes?.[name];
    if (!process) throw notFound('Process');
    const [running] = await turn.tx.db
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(and(eq(processInstances.environmentId, turn.loaded.env.id), eq(processInstances.process, name), eq(processInstances.recordId, recordId), eq(processInstances.status, 'running')));
    if (running) throw conflict('process_running', `${process.label} already runs for this record`);
    const [row] = await turn.tx.db
      .insert(processInstances)
      .values({
        id: uuidv7(turn.now.getTime()),
        orgId: this.#ctx.org.id,
        appId: turn.loaded.app.id,
        environmentId: turn.loaded.env.id,
        process: name,
        revision: turn.loaded.revision,
        entity: process.entity,
        recordId,
        startedBy: turn.by,
        startedByAction: action,
        startedAt: turn.now,
      })
      .returning();
    const live: Live = { row: row!, process, graph: processGraph(process), entity: process.entity, outcomes: {}, ended: false, reached: null };
    turn.live.set(row!.id, live);
    await this.#event(turn, live, 'started', startAt, action ? { action } : null);
    await this.#audit(turn, live, 'process.start', action ? { action } : { byHand: true });
    turn.queue.push({ instanceId: row!.id, element: startAt, flow: null });
    return live;
  }

  /** Move tokens until each waits or ends. An instance whose last token ended completes. */
  async #drain(turn: Turn): Promise<void> {
    while (turn.queue.length) {
      if (++turn.moves > MAX_MOVES) throw unprocessable('process_loops', `A process moved ${MAX_MOVES} times without waiting: check its flows for a loop that waits for nothing`);
      const { instanceId, element, flow } = turn.queue.shift()!;
      const live = await this.#live(turn, instanceId);
      if (!live.ended) await this.#arrive(turn, live, element, flow);
    }
    for (const live of turn.live.values()) {
      if (live.ended) continue;
      const [left] = await turn.tx.db.select({ count: sql<number>`count(*)::int` }).from(processTokens).where(eq(processTokens.instanceId, live.row.id));
      if (!left?.count) await this.#end(turn, live, 'completed');
    }
  }

  async #arrive(turn: Turn, live: Live, id: string, flow: string | null): Promise<void> {
    const element = live.process.elements[id];
    if (!element) return this.#stuck(turn, live, id, flow, `The process has no element ${id}`);
    switch (element.type) {
      case 'endEvent':
        live.reached = id;
        if (element.terminate) await this.#end(turn, live, 'completed', id);
        return;
      case 'userTask':
        return this.#openTask(turn, live, id, element);
      case 'serviceTask':
        return this.#serve(turn, live, id, element);
      case 'intermediateCatchEvent': {
        const fireAt = timerFiresAt(element.timer, turn.now, (await this.#record(turn, live)) ?? {});
        if (!fireAt) return this.#stuck(turn, live, id, flow, `${elementName(live.process, id)}: the record has no ${'date' in element.timer ? element.timer.date : 'date'}`);
        const tokenId = uuidv7(turn.now.getTime());
        await turn.tx.db.insert(processTokens).values({ id: tokenId, instanceId: live.row.id, element: id, arrivedBy: flow, state: 'waiting', createdAt: turn.now });
        await turn.tx.db.insert(processTimers).values({ id: uuidv7(turn.now.getTime()), orgId: this.#ctx.org.id, instanceId: live.row.id, element: id, tokenId, fireAt, nextAttemptAt: fireAt, createdAt: turn.now });
        return;
      }
      case 'parallelGateway': {
        const incoming = live.graph.incoming.get(id) ?? [];
        if (incoming.length > 1) {
          // A join waits for a token from each flow in, then they go on as one.
          const waiting = await turn.tx.db
            .select()
            .from(processTokens)
            .where(and(eq(processTokens.instanceId, live.row.id), eq(processTokens.element, id), eq(processTokens.state, 'waiting')));
          const others = incoming.filter((each) => each !== flow).map((each) => waiting.find((token) => token.arrivedBy === each));
          if (others.some((token) => !token)) {
            await turn.tx.db.insert(processTokens).values({ id: uuidv7(turn.now.getTime()), instanceId: live.row.id, element: id, arrivedBy: flow, state: 'waiting', createdAt: turn.now });
            return;
          }
          await turn.tx.db.delete(processTokens).where(inArray(processTokens.id, others.map((token) => token!.id)));
        }
        return this.#leave(turn, live, id);
      }
      default:
        return this.#leave(turn, live, id);
    }
  }

  /** Send a token on along the flows out of an element: for a user task, those of its outcome. */
  async #leave(turn: Turn, live: Live, id: string, outcome?: string): Promise<void> {
    const decides = live.process.elements[id]?.type === 'exclusiveGateway';
    const state = { record: decides ? ((await this.#record(turn, live)) ?? {}) : {}, outcomes: live.outcomes };
    const out = flowsOut(live.process, live.graph, id, state, outcome);
    if (!out.ok) return this.#stuck(turn, live, id, null, out.message);
    for (const flow of out.flows) turn.queue.push({ instanceId: live.row.id, element: live.process.flows[flow]!.to, flow });
  }

  async #stuck(turn: Turn, live: Live, element: string, flow: string | null, message: string): Promise<void> {
    await turn.tx.db.insert(processTokens).values({ id: uuidv7(turn.now.getTime()), instanceId: live.row.id, element, arrivedBy: flow, state: 'stuck', error: message.slice(0, 1000), createdAt: turn.now });
    await this.#event(turn, live, 'stuck', element, { error: message });
  }

  async #openTask(turn: Turn, live: Live, id: string, element: UserTaskElement): Promise<void> {
    const record = (await this.#record(turn, live)) ?? {};
    const db = turn.tx.db;
    const person = (field: string): string | null => {
      const value = record[field];
      return typeof value === 'string' ? value : null;
    };
    // Routing narrows the role to one person: by the record, or by the directory's reporting line.
    let routed: string | null = null;
    if (element.assignee && 'field' in element.assignee) {
      const named = person(element.assignee.field);
      if (named && (await this.#activeUser(db, named))) routed = named;
    } else if (element.assignee) {
      const from = person(element.assignee.managerOf);
      if (from) routed = await managerUp(db, from, element.assignee.levels);
    }
    // Someone who left, or a line that ends, sends the task to the role; someone away sends it to their cover.
    const assignee = routed ? await coverFor(db, routed, turn.now) : null;
    const departmentOfTask = !assignee && element.department ? await this.#departmentOfField(db, person(element.department.of)) : null;
    const tokenId = uuidv7(turn.now.getTime());
    await turn.tx.db.insert(processTokens).values({ id: tokenId, instanceId: live.row.id, element: id, state: 'waiting', createdAt: turn.now });
    const taskId = uuidv7(turn.now.getTime());
    await turn.tx.db.insert(processTasks).values({
      id: taskId,
      orgId: this.#ctx.org.id,
      appId: live.row.appId,
      environmentId: live.row.environmentId,
      instanceId: live.row.id,
      element: id,
      tokenId,
      name: element.name,
      entity: live.row.entity,
      recordId: live.row.recordId,
      role: element.role,
      assignee,
      department: departmentOfTask,
      outcomes: element.outcomes.map((outcome) => ({ name: outcome.name, label: outcome.label, ...(outcome.action ? { action: outcome.action } : {}) })),
      card: element.card ?? null,
      dueAt: element.due ? addDuration(turn.now, element.due) : null,
      createdAt: turn.now,
    });
    for (const boundary of live.graph.boundaries.get(id) ?? []) {
      const timer = live.process.elements[boundary];
      if (timer?.type !== 'boundaryEvent') continue;
      const fireAt = timerFiresAt(timer.timer, turn.now, record);
      if (!fireAt) continue;
      await turn.tx.db.insert(processTimers).values({ id: uuidv7(turn.now.getTime()), orgId: this.#ctx.org.id, instanceId: live.row.id, element: boundary, taskId, fireAt, nextAttemptAt: fireAt, createdAt: turn.now });
    }
    const routing = { role: element.role, assignee, ...(routed && routed !== assignee ? { covering: routed } : {}), ...(element.assignee && !routed ? { routing: 'fell back to the role' } : {}), ...(departmentOfTask ? { department: departmentOfTask } : {}) };
    await this.#event(turn, live, 'task_opened', id, { task: taskId, ...routing });
    await this.#audit(turn, live, 'process.task.assign', { task: taskId, name: element.name, ...routing }, { type: 'process_task', id: taskId, name: element.name });
  }

  async #completeTask(turn: Turn, task: TaskRow, outcome: string, by: string | null): Promise<void> {
    const live = await this.#live(turn, task.instanceId);
    await turn.tx.db.update(processTasks).set({ status: 'completed', outcome, completedBy: by, tokenId: null, closedAt: turn.now }).where(eq(processTasks.id, task.id));
    if (task.tokenId) await turn.tx.db.delete(processTokens).where(eq(processTokens.id, task.tokenId));
    await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.taskId, task.id), eq(processTimers.status, 'waiting')));
    live.outcomes[task.element] = outcome;
    await turn.tx.db.update(processInstances).set({ outcomes: live.outcomes }).where(eq(processInstances.id, live.row.id));
    await this.#event(turn, live, 'task_completed', task.element, { task: task.id, outcome, ...(by ? {} : { byProcess: true }) }, by);
    await this.#audit(turn, live, 'process.task.complete', { task: task.id, outcome }, { type: 'process_task', id: task.id, name: task.name });
    if (!live.ended) await this.#leave(turn, live, task.element, outcome);
  }

  /** Close an open task without an outcome: a timer interrupted it, or its instance ended. */
  async #closeTask(turn: Turn, live: Live, task: TaskRow, reason: 'timer' | 'ended' | 'cancelled'): Promise<void> {
    await turn.tx.db.update(processTasks).set({ status: 'cancelled', cancelReason: reason, tokenId: null, closedAt: turn.now }).where(eq(processTasks.id, task.id));
    if (task.tokenId) await turn.tx.db.delete(processTokens).where(eq(processTokens.id, task.tokenId));
    await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.taskId, task.id), eq(processTimers.status, 'waiting')));
    await this.#event(turn, live, 'task_cancelled', task.element, { task: task.id, reason });
  }

  /** A service task: run the app's action on the record with the app's authority, or start an a7c skill. */
  async #serve(turn: Turn, live: Live, id: string, element: Extract<Process['elements'][string], { type: 'serviceTask' }>): Promise<void> {
    const origin: ProcessOrigin = { kind: 'process', instanceId: live.row.id, process: live.row.process, element: id, onBehalfOf: turn.by ?? live.row.startedBy };
    if (element.action) {
      if (turn.loaded.app.movedTo) return this.#stuck(turn, live, id, null, `${element.name}: the app moved to a team space, so it changes no records here`);
      const ran = await this.#runtime.runForProcess(turn.tx, turn.loaded, element.action, live.row.recordId, origin);
      if (!ran.ok) return this.#stuck(turn, live, id, null, `${element.name}: ${ran.message}`);
      turn.records.delete(live.row.recordId);
      await this.#event(turn, live, 'ran', id, { action: element.action });
      await this.#actionCommitted(turn, element.action, live.row.recordId, null);
    } else if (element.skill) {
      if (!this.#ctx.config.A7C_URL) return this.#stuck(turn, live, id, null, `${element.name}: this installation doesn't connect a7c`);
      const record = (await this.#record(turn, live)) ?? {};
      const input: Record<string, ExpressionValue> = {};
      for (const [name, expression] of Object.entries(element.input ?? {})) {
        const value = evaluateExpression(expression, { record, principal: {}, now: turn.now });
        if (!value.ok) return this.#stuck(turn, live, id, null, `${element.name}: ${name}: ${value.message}`);
        input[name] = value.value;
      }
      await this.#runtime.queueSkills(processWriter(this.#ctx.org.id, origin), turn.loaded, turn.tx, {
        action: `process:${live.row.process}`,
        recordId: live.row.recordId,
        calls: [{ step: id, label: element.name, skill: element.skill, input }],
        onBehalfOf: origin.onBehalfOf,
      });
      await this.#event(turn, live, 'skill_queued', id, { skill: element.skill });
    }
    return this.#leave(turn, live, id);
  }

  /** End an instance: what still waits in it goes. */
  async #end(turn: Turn, live: Live, status: 'completed' | 'cancelled', at?: string): Promise<void> {
    live.ended = true;
    const open = await turn.tx.db.select().from(processTasks).where(and(eq(processTasks.instanceId, live.row.id), eq(processTasks.status, 'open')));
    for (const task of open) await this.#closeTask(turn, live, task, status === 'cancelled' ? 'cancelled' : 'ended');
    await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.instanceId, live.row.id), eq(processTimers.status, 'waiting')));
    await turn.tx.db.delete(processTokens).where(eq(processTokens.instanceId, live.row.id));
    await turn.tx.db.update(processInstances).set({ status, endedAt: turn.now }).where(eq(processInstances.id, live.row.id));
    const where = at ?? (status === 'completed' ? live.reached : null);
    await this.#event(turn, live, status === 'completed' ? 'ended' : 'cancelled', where, null);
    await this.#audit(turn, live, status === 'completed' ? 'process.end' : 'process.cancel', where ? { at: where } : {});
  }

  async #event(turn: Turn, live: Live, kind: EventKind, element: string | null, detail: Record<string, unknown> | null, by: string | null = turn.by): Promise<void> {
    await turn.tx.db.insert(processEvents).values({ id: uuidv7(turn.now.getTime()), instanceId: live.row.id, at: turn.now, kind, element, by, detail });
  }

  async #audit(turn: Turn, live: Live, action: string, reason: Record<string, unknown>, target?: { type: string; id: string; name: string }): Promise<void> {
    await recordAudit(turn.tx.db, turn.scope(turn.now), {
      action,
      target: target ?? { type: 'process_instance', id: live.row.id, name: live.row.process },
      spaceId: turn.loaded.space.id,
      appId: live.row.appId,
      env: turn.loaded.env.kind,
      reason: { process: live.row.process, instance: live.row.id, recordId: live.row.recordId, ...reason },
    });
  }

  // ---- Reading

  async #instanceRow(id: string): Promise<InstanceRow | undefined> {
    return (await this.#ctx.db.select().from(processInstances).where(eq(processInstances.id, id)))[0];
  }

  async #taskRow(id: string): Promise<TaskRow | undefined> {
    return (await this.#ctx.db.select().from(processTasks).where(eq(processTasks.id, id)))[0];
  }

  /** Open tasks on a record whose outcomes run an action. */
  async #tasksDecidedBy(db: Database, loaded: LoadedApp, recordId: string, action: string, lock: boolean): Promise<TaskRow[]> {
    const query = db
      .select()
      .from(processTasks)
      .where(
        and(
          eq(processTasks.environmentId, loaded.env.id),
          eq(processTasks.recordId, recordId),
          eq(processTasks.status, 'open'),
          sql`${processTasks.outcomes} @> ${JSON.stringify([{ action }])}::jsonb`,
        ),
      )
      .orderBy(asc(processTasks.createdAt));
    return lock ? query.for('update') : query;
  }

  async #hasOpenTasks(db: Database, loaded: LoadedApp, recordId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: processTasks.id })
      .from(processTasks)
      .where(and(eq(processTasks.environmentId, loaded.env.id), eq(processTasks.recordId, recordId), eq(processTasks.status, 'open')))
      .limit(1);
    return Boolean(row);
  }

  /** Only the person a task waits for, or someone with its role when it waits for nobody in particular, may do it. */
  async #mayDo(auth: AuthContext, task: TaskRow): Promise<void> {
    if (task.assignee) {
      if (task.assignee === auth.actor.id) return;
      throw forbidden('task_assigned', `${task.name} waits for ${await this.#personName(this.#ctx.db, task.assignee)}`);
    }
    const held = await this.#ctx.policy.bindingsFor(auth.principal);
    const holds = held.some((binding) => binding.scope.type === 'env' && binding.scope.id === task.environmentId && binding.roleId && appRoleName(task.appId, binding.roleId) === task.role);
    if (!holds) throw forbidden('not_your_task', `${task.name} is for the role ${task.role}, which you don't hold here`);
    if (task.department && task.department !== (await departmentOf(this.#ctx.db, auth.actor.id))) throw forbidden('task_department', `${task.name} waits for someone in ${task.department}`);
  }

  /** The department of the person a record's field names. A task for a department nobody names is for the whole role. */
  async #departmentOfField(db: Database, person: string | null): Promise<string | null> {
    return person ? departmentOf(db, person) : null;
  }

  async #activeUser(db: Database, id: string): Promise<boolean> {
    const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.status, 'active')));
    return Boolean(row);
  }

  async #personName(db: Database, id: string): Promise<string> {
    const [row] = await db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, id));
    return row?.name ?? row?.email ?? 'someone else';
  }

  async #taskViews(where: SQL, limit: number, order: 'open' | 'closed' | 'all' = 'open'): Promise<TaskView[]> {
    const now = this.#ctx.now();
    const rows = await this.#ctx.db
      .select({ task: processTasks, appName: apps.name, process: processInstances.process, assigneeName: users.displayName, assigneeEmail: users.email })
      .from(processTasks)
      .innerJoin(apps, eq(apps.id, processTasks.appId))
      .innerJoin(processInstances, eq(processInstances.id, processTasks.instanceId))
      .leftJoin(users, eq(users.id, processTasks.assignee))
      .where(where)
      .orderBy(
        ...(order === 'open'
          ? [sql`${processTasks.dueAt} asc nulls last`, asc(processTasks.createdAt)]
          : order === 'closed'
            ? [desc(processTasks.closedAt)]
            : [asc(processTasks.createdAt)]),
      )
      .limit(limit);
    return rows.map(({ task, appName, process, assigneeName, assigneeEmail }) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      app: { id: task.appId, name: appName },
      environment: { id: task.environmentId },
      process,
      instanceId: task.instanceId,
      element: task.element,
      entity: task.entity,
      recordId: task.recordId,
      role: task.role,
      assignee: task.assignee ? { id: task.assignee, name: assigneeName ?? assigneeEmail } : null,
      outcomes: task.outcomes,
      card: task.card,
      due: task.dueAt?.toISOString() ?? null,
      overdue: task.status === 'open' && task.dueAt !== null && task.dueAt.getTime() < now.getTime(),
      outcome: task.outcome,
      completedBy: task.completedBy,
      createdAt: task.createdAt.toISOString(),
      closedAt: task.closedAt?.toISOString() ?? null,
    }));
  }

  async #view(row: InstanceRow): Promise<InstanceView> {
    const process = await this.#processOf(row);
    const tokens = await this.#ctx.db.select().from(processTokens).where(eq(processTokens.instanceId, row.id)).orderBy(asc(processTokens.createdAt));
    const name = (element: string) => (process ? elementName(process, element) : element);
    return {
      id: row.id,
      process: row.process,
      label: process?.label ?? row.process,
      revision: row.revision,
      entity: row.entity,
      recordId: row.recordId,
      status: row.status,
      stuck: tokens.filter((token) => token.state === 'stuck').map((token) => ({ element: token.element, name: name(token.element), error: token.error ?? '' })),
      waiting: tokens.filter((token) => token.state === 'waiting').map((token) => ({ element: token.element, name: name(token.element) })),
      startedBy: row.startedBy,
      startedByAction: row.startedByAction,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
    };
  }
}

/** Fire due timers on an interval. Returns a function that stops it. */
export function startProcessTimers(engine: ProcessEngine, options: { readonly intervalSeconds: number; readonly logger: { error(obj: object, message: string): void } }): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    engine
      .fireDue()
      .catch((error: unknown) => options.logger.error({ err: error }, 'Firing process timers failed'))
      .finally(() => (running = false));
  }, options.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
