import { uuidv7 } from '@platform/audit';
import {
  addDuration,
  appRoleId,
  automaticStarts,
  appRoleName,
  catcherOn,
  decideVotes,
  elementName,
  evaluateExpression,
  flowsOut,
  linkTarget,
  plainStartOf,
  processConditionEnv,
  processGraph,
  raisedCode,
  startEventsOf,
  startsOf,
  timerFiresAt,
  type AutomaticStart,
  type BoundaryEventElement,
  type BusinessRuleTaskElement,
  type CallActivityElement,
  type ExpressionValue,
  type Message,
  type ScriptTaskElement,
  type Process,
  type ProcessGraph,
  type RecordValues,
  type UserTaskElement,
  messageActions,
  reachable,
  votesNeeded,
} from '@platform/app-model';
import { apps, bindings, groupMembers, processEvents, processInstances, processStartTimers, processTasks, processTimers, processTokens, users, type Database } from '@platform/db';
import { evaluateCondition, type Condition } from '@platform/authz';
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
type TokenRow = typeof processTokens.$inferSelect;
type StartTimerRow = typeof processStartTimers.$inferSelect;
/** Why a task closed without an outcome. */
type CloseReason = 'timer' | 'message' | 'condition' | 'error' | 'escalation' | 'ended' | 'cancelled';
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
  /** What each element can still reach, as inclusive joins ask it. */
  readonly reach: Map<string, Set<string>>;
}

/** Where an error or an escalation is caught: an event on the boundary of an element, in an instance. */
interface Catch {
  readonly live: Live;
  readonly boundary: string;
  /** The token that waits at the element: a run of a sub-process, or a call. Null for a task's own event. */
  readonly host: TokenRow | null;
  /** The run the path out of the event goes on in. */
  readonly scope: string | null;
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
  /** Moves still to make: to an element, in a run of a sub-process (`scope`, the token that waits at it) or in the process itself (null). */
  readonly queue: Array<{ readonly instanceId: string; readonly element: string; readonly flow: string | null; readonly scope: string | null }>;
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
  /** One vote of a task that several people decide, and how many vote in all, while it is open. */
  readonly several: boolean;
  readonly voters: number | null;
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
  /** The instance whose call activity started it. */
  readonly calledBy: string | null;
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

/** An event's detail as an object, whatever was stored. */
function isDetail(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The run an event happened in, for the history and for undoing it: absent at the level of the process itself. */
const inRun = (scope: string | null): { readonly scope?: string } => (scope === null ? {} : { scope });

/** What undoes a task's change, and on which record, for the history: absent when nothing does. */
const undoOf = (undo: string | undefined, recordId: string): { readonly undo?: string; readonly recordId?: string } => (undo ? { undo, recordId } : {});

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
    const votes = open.find((task) => task.several);
    if (votes) throw forbidden('votes_pending', `${votes.name} waits for the votes of several people: vote in your inbox`);
    const department = await departmentOf(tx.db, actorId);
    if (open.some((task) => decidable(task, actorId, department))) return;
    const [task] = open;
    if (task!.assignee) throw forbidden('task_assigned', `${task!.name} waits for ${await this.#personName(tx.db, task!.assignee)}: only they can decide it`);
    throw forbidden('task_department', `${task!.name} waits for someone in ${task!.department}`);
  }

  async afterAction(
    tx: AppTransaction,
    loaded: LoadedApp,
    event: { readonly action: string; readonly recordId: string; readonly by: AuthContext['actor']; readonly writer: Writer; readonly before: RecordValues | null },
  ): Promise<void> {
    const decides = (loaded.definition.processes && Object.keys(loaded.definition.processes).length) || (await this.#hasOpenTasks(tx.db, loaded, event.recordId));
    if (!decides) return;
    const turn = this.#turn(tx, loaded, event.writer.scope, event.by.type === 'user' ? event.by.id : null);
    await this.#actionCommitted(turn, event.action, event.recordId, event.by.type === 'user' ? event.by.id : null);
    const entity = loaded.definition.actions[event.action]?.entity;
    if (entity) await this.#recordChanged(turn, entity, event.recordId, event.before);
    await this.#drain(turn);
  }

  // ---- People and operators

  /** Start a process on a record by hand, for someone whose role may start it. */
  async start(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, processName: string, recordId: string): Promise<InstanceView> {
    const process = loaded.definition.processes?.[processName];
    if (!process) throw notFound('Process');
    // The person must be able to see the record they start it on.
    await this.#runtime.get(request, auth, loaded, process.entity, recordId);
    const startAt = plainStartOf(process);
    if (!startAt) throw conflict('no_start', `${process.label} has no start event`);
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
    if (task.several) {
      // A vote is the person's own: an agent can't cast it, as there is no proposal to approve.
      if (auth.credential.kind === 'token') throw forbidden('person_only', `Several people decide ${task.name}: only the person can vote, in Ambit`);
      await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
        await this.#runtime.lockRecord(tx, loaded, task.entity, task.recordId);
        const [locked] = await tx.db.select().from(processTasks).where(eq(processTasks.id, task.id)).for('update');
        if (locked!.status !== 'open') throw conflict('task_closed', `${task.name} is already ${locked!.status}`);
        const turn = this.#turn(tx, loaded, (now) => auditScopeFor(request, this.#ctx.org.id, now), auth.actor.type === 'user' ? auth.actor.id : null);
        await this.#vote(turn, locked!, outcome.name, auth.actor.id);
        await this.#drain(turn);
      });
      return { task: (await this.#taskViews(eq(processTasks.id, task.id), 1, 'all'))[0]!, result: null };
    }
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
    if (task.several) throw conflict('vote', "A vote is the person's own: it can't be handed over");
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
        turn.queue.push({ instanceId: id, element: token.element, flow: token.arrivedBy, scope: token.scope });
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
    // Processes that a timer starts on a record.
    const starts = await this.#ctx.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(processStartTimers)
        .where(and(eq(processStartTimers.status, 'waiting'), lte(processStartTimers.nextAttemptAt, now)))
        .orderBy(asc(processStartTimers.nextAttemptAt))
        .limit(batch)
        .for('update', { skipLocked: true });
      if (!due.length) return [];
      await tx
        .update(processStartTimers)
        .set({ attempts: sql`${processStartTimers.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(inArray(processStartTimers.id, due.map((timer) => timer.id)));
      return due.map((timer) => ({ ...timer, attempts: timer.attempts + 1 }));
    });
    for (const timer of starts) {
      try {
        await this.#fireStart(timer);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        await this.#ctx.db
          .update(processStartTimers)
          .set({ lastError: message, nextAttemptAt: new Date(this.#ctx.now().getTime() + backoffSeconds(timer.attempts) * 1000) })
          .where(eq(processStartTimers.id, timer.id));
      }
    }
    return claimed.length + starts.length;
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
      if (timer.tokenId && element?.type === 'boundaryEvent') {
        // On a sub-process, a call or a receive task, an interrupting timer ends what waits there; on a task that several people decide, the vote.
        const [token] = await tx.db.select().from(processTokens).where(eq(processTokens.id, timer.tokenId)).for('update');
        if (!token) return;
        const host = live.process.elements[element.attachedTo]?.type;
        if (element.interrupting && host === 'userTask') {
          await this.#closeVotes(turn, live, timer.tokenId, 'timer');
          await tx.db.delete(processTokens).where(eq(processTokens.id, timer.tokenId));
        } else if (element.interrupting) {
          await this.#interrupt(turn, live, token, 'timer');
        }
        await this.#audit(turn, live, 'process.escalate', { timer: timer.element, interrupting: element.interrupting });
        await this.#leave(turn, live, timer.element, token.scope);
      } else if (timer.tokenId) {
        // At a timer catch event, or at an event-based gateway, whose other events then no longer wait.
        const [token] = await tx.db.select().from(processTokens).where(eq(processTokens.id, timer.tokenId)).for('update');
        if (!token) return;
        await tx.db.delete(processTokens).where(eq(processTokens.id, timer.tokenId));
        await tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, timer.tokenId), eq(processTimers.status, 'waiting')));
        await this.#leave(turn, live, timer.element, token.scope);
      } else if (timer.taskId && element?.type === 'boundaryEvent') {
        const [task] = await tx.db.select().from(processTasks).where(eq(processTasks.id, timer.taskId)).for('update');
        if (!task || task.status !== 'open') return;
        const scope = await this.#scopeOf(turn, task.tokenId);
        if (element.interrupting) await this.#closeTask(turn, live, task, 'timer');
        await this.#audit(turn, live, 'process.escalate', { task: task.id, timer: timer.element, interrupting: element.interrupting });
        await this.#leave(turn, live, timer.element, scope);
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
    const live: Live = { row, process, graph: processGraph(process), entity: row.entity, outcomes: { ...row.outcomes }, ended: row.status !== 'running', reached: null, reach: new Map() };
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
      if (task.several) continue;
      if (!(actorId ? decidable(task, actorId, department) : !task.assignee && !task.department)) continue;
      const outcome = task.outcomes.find((candidate) => candidate.action === action)!;
      await this.#completeTask(turn, task, outcome.name, actorId);
    }
    await this.#deliverMessage(turn, action, recordId);
    for (const start of startsOf(turn.loaded.definition, action)) await this.#start(turn, start.process, start.element, recordId, action);
  }

  /**
   * An action committed on a record is a message to the processes that run on it: a catch event
   * that waits for it moves on, and an event on a task's boundary interrupts the task or starts a
   * path beside it.
   */
  async #deliverMessage(turn: Turn, action: string, recordId: string): Promise<void> {
    const db = turn.tx.db;
    const running = await db
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(and(eq(processInstances.environmentId, turn.loaded.env.id), eq(processInstances.recordId, recordId), eq(processInstances.status, 'running')));
    for (const { id } of running) {
      const live = await this.#live(turn, id);
      if (live.ended || !messageActions(live.process).includes(action)) continue;
      // What waits there hears it on its boundary first, the outermost run first: interrupting it ends what runs inside it.
      await this.#boundariesHear(turn, live, (event) => event.message?.action === action, 'message', { action });
      // Then what waits for it: a catch event, a receive task, or an event-based gateway before one of them.
      const waiting = await db.select().from(processTokens).where(and(eq(processTokens.instanceId, id), eq(processTokens.state, 'waiting')));
      for (const token of waiting) {
        const element = live.process.elements[token.element];
        if (element?.type === 'eventBasedGateway') {
          const target = this.#gatewayTargets(live, token.element).find((each) => {
            const candidate = live.process.elements[each];
            return (candidate?.type === 'intermediateCatchEvent' || candidate?.type === 'receiveTask') && candidate.message?.action === action;
          });
          if (target) await this.#takeGateway(turn, live, token, target, 'message', { action });
          continue;
        }
        if ((element?.type !== 'intermediateCatchEvent' && element?.type !== 'receiveTask') || element.message?.action !== action) continue;
        await db.delete(processTokens).where(eq(processTokens.id, token.id));
        await db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, token.id), eq(processTimers.status, 'waiting')));
        await this.#event(turn, live, 'message', token.element, { action });
        await this.#leave(turn, live, token.element, token.scope);
      }
    }
  }

  /**
   * The events on boundaries that a happening matches: a message or a condition. On a sub-process,
   * a call or a receive task that waits, the outermost run first, and on the open user tasks; the
   * votes of one task share its boundary. An interrupting one ends what it sits on.
   */
  async #boundariesHear(turn: Turn, live: Live, matches: (event: BoundaryEventElement) => boolean, kind: 'message' | 'condition', detail: Record<string, unknown>): Promise<void> {
    const db = turn.tx.db;
    const all = await db.select().from(processTokens).where(and(eq(processTokens.instanceId, live.row.id), eq(processTokens.state, 'waiting')));
    const depth = (token: TokenRow): number => {
      let count = 0;
      for (let at = token.scope; at !== null && count < 50; count++) at = all.find((other) => other.id === at)?.scope ?? null;
      return count;
    };
    const holders = all.filter((token) => ['subProcess', 'callActivity', 'receiveTask'].includes(live.process.elements[token.element]?.type ?? '')).sort((a, b) => depth(a) - depth(b));
    for (const holder of holders) {
      const [still] = await db.select({ id: processTokens.id }).from(processTokens).where(eq(processTokens.id, holder.id));
      if (!still) continue;
      for (const boundary of live.graph.boundaries.get(holder.element) ?? []) {
        const event = live.process.elements[boundary];
        if (event?.type !== 'boundaryEvent' || !matches(event)) continue;
        if (event.interrupting) await this.#interrupt(turn, live, holder, kind);
        await this.#event(turn, live, kind, boundary, { ...detail, interrupting: event.interrupting });
        await this.#leave(turn, live, boundary, holder.scope);
        if (event.interrupting) break;
      }
    }
    const open = await db.select().from(processTasks).where(and(eq(processTasks.instanceId, live.row.id), eq(processTasks.status, 'open')));
    const handled = new Set<string>();
    for (const task of open) {
      const key = task.several && task.tokenId ? task.tokenId : task.id;
      if (handled.has(key)) continue;
      handled.add(key);
      const [current] = await db.select({ status: processTasks.status }).from(processTasks).where(eq(processTasks.id, task.id));
      if (current?.status !== 'open') continue;
      const scope = await this.#scopeOf(turn, task.tokenId);
      for (const boundary of live.graph.boundaries.get(task.element) ?? []) {
        const event = live.process.elements[boundary];
        if (event?.type !== 'boundaryEvent' || !matches(event)) continue;
        if (event.interrupting) {
          if (task.several && task.tokenId) {
            await this.#closeVotes(turn, live, task.tokenId, kind);
            await db.delete(processTokens).where(eq(processTokens.id, task.tokenId));
            await db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, task.tokenId), eq(processTimers.status, 'waiting')));
          } else {
            await this.#closeTask(turn, live, task, kind);
          }
        }
        await this.#event(turn, live, kind, boundary, { ...detail, task: task.id, interrupting: event.interrupting });
        await this.#leave(turn, live, boundary, scope);
        if (event.interrupting) break;
      }
    }
  }

  /** The events after an event-based gateway, in the order of its flows. */
  #gatewayTargets(live: Live, id: string): string[] {
    return (live.graph.outgoing.get(id) ?? []).map((flow) => live.process.flows[flow]!.to);
  }

  /** The first event after an event-based gateway happened: it takes the path, and the others no longer wait. */
  async #takeGateway(turn: Turn, live: Live, token: TokenRow, target: string, kind: 'message' | 'condition' | 'timer_fired', detail: Record<string, unknown> | null): Promise<void> {
    await turn.tx.db.delete(processTokens).where(eq(processTokens.id, token.id));
    await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, token.id), eq(processTimers.status, 'waiting')));
    await this.#event(turn, live, kind, target, detail);
    await this.#leave(turn, live, target, token.scope);
  }

  /**
   * A record changed, by a person's action or by the process's own work. Processes that a
   * condition starts start where the change makes it hold, and those that a timer starts plan
   * their start. Then the instances on the record hear the change: a catch event whose condition
   * holds goes on, and a condition on a boundary that the change makes hold happens.
   */
  async #recordChanged(turn: Turn, entity: string, recordId: string, before: RecordValues | null): Promise<void> {
    turn.records.delete(recordId);
    const after = await this.#runtime.recordIn(turn.tx, turn.loaded, entity, recordId);
    if (!after) return;
    turn.records.set(recordId, after);
    const holds = (condition: Condition, values: RecordValues | null, outcomes: Readonly<Record<string, string>> = {}) =>
      values !== null && evaluateCondition(condition, processConditionEnv({ record: values, outcomes }));
    for (const start of automaticStarts(turn.loaded.definition, entity)) {
      if (start.condition && holds(start.condition, after) && !holds(start.condition, before) && !(await this.#runsOn(turn, start.process, recordId))) {
        await this.#start(turn, start.process, start.element, recordId, null, undefined, 'condition');
      }
      if (start.timer) await this.#planStart(turn, start, entity, recordId, before, after);
    }
    const running = await turn.tx.db
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(and(eq(processInstances.environmentId, turn.loaded.env.id), eq(processInstances.recordId, recordId), eq(processInstances.status, 'running')));
    for (const { id } of running) {
      const live = await this.#live(turn, id);
      if (live.ended) continue;
      const waiting = await turn.tx.db.select().from(processTokens).where(and(eq(processTokens.instanceId, id), eq(processTokens.state, 'waiting')));
      for (const token of waiting) {
        const element = live.process.elements[token.element];
        if (element?.type === 'intermediateCatchEvent' && element.condition && holds(element.condition, after, live.outcomes)) {
          const [still] = await turn.tx.db.select({ id: processTokens.id }).from(processTokens).where(eq(processTokens.id, token.id));
          if (!still) continue;
          await turn.tx.db.delete(processTokens).where(eq(processTokens.id, token.id));
          await this.#event(turn, live, 'condition', token.element, null);
          await this.#leave(turn, live, token.element, token.scope);
        } else if (element?.type === 'eventBasedGateway') {
          const target = this.#gatewayTargets(live, token.element).find((each) => {
            const candidate = live.process.elements[each];
            return candidate?.type === 'intermediateCatchEvent' && candidate.condition !== undefined && holds(candidate.condition, after, live.outcomes);
          });
          if (target) await this.#takeGateway(turn, live, token, target, 'condition', null);
        }
      }
      await this.#boundariesHear(
        turn,
        live,
        (event) => event.condition !== undefined && holds(event.condition, after, live.outcomes) && !holds(event.condition, before, live.outcomes),
        'condition',
        {},
      );
    }
  }

  /** Whether a process runs on a record now. */
  async #runsOn(turn: Turn, process: string, recordId: string): Promise<boolean> {
    const [running] = await turn.tx.db
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(and(eq(processInstances.environmentId, turn.loaded.env.id), eq(processInstances.process, process), eq(processInstances.recordId, recordId), eq(processInstances.status, 'running')));
    return running !== undefined;
  }

  /**
   * Plan the start of a process that a timer starts, once for each record: on the record's date,
   * which follows the record when it changes, or a duration after the record was created.
   */
  async #planStart(turn: Turn, start: AutomaticStart, entity: string, recordId: string, before: RecordValues | null, after: RecordValues): Promise<void> {
    const timer = start.timer!;
    const db = turn.tx.db;
    const where = and(
      eq(processStartTimers.environmentId, turn.loaded.env.id),
      eq(processStartTimers.process, start.process),
      eq(processStartTimers.element, start.element),
      eq(processStartTimers.recordId, recordId),
    );
    const [planned] = await db.select().from(processStartTimers).where(where);
    if (planned?.status === 'fired') return;
    let fireAt: Date | null;
    if ('date' in timer) {
      fireAt = timerFiresAt(timer, turn.now, after);
      const was = before ? timerFiresAt(timer, turn.now, before) : null;
      if (planned && was?.getTime() === fireAt?.getTime()) return;
    } else {
      // A duration counts from when the record was created.
      if (before !== null || planned) return;
      fireAt = addDuration(turn.now, timer.duration);
    }
    if (!fireAt) {
      if (planned?.status === 'waiting') await db.update(processStartTimers).set({ status: 'cancelled' }).where(eq(processStartTimers.id, planned.id));
      return;
    }
    if (planned) {
      await db.update(processStartTimers).set({ fireAt, nextAttemptAt: fireAt, status: 'waiting', attempts: 0, lastError: null }).where(eq(processStartTimers.id, planned.id));
      return;
    }
    await db.insert(processStartTimers).values({
      id: uuidv7(turn.now.getTime()),
      orgId: this.#ctx.org.id,
      appId: turn.loaded.app.id,
      environmentId: turn.loaded.env.id,
      process: start.process,
      element: start.element,
      entity,
      recordId,
      fireAt,
      nextAttemptAt: fireAt,
      createdAt: turn.now,
    });
  }

  /** Start a process that a timer starts, on its record, when the time comes. */
  async #fireStart(timer: StartTimerRow): Promise<void> {
    const loaded = await this.#ctx.apps.load(timer.appId, { id: timer.environmentId });
    const scope = (now: Date): AuditScope => ({ orgId: this.#ctx.org.id, actor: SYSTEM_ACTOR, now, context: { startTimer: timer.id } });
    await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      const [current] = await tx.db.select().from(processStartTimers).where(eq(processStartTimers.id, timer.id)).for('update');
      if (!current || current.status !== 'waiting') return;
      const present = loaded.definition.entities[timer.entity] ? await this.#runtime.lockRecord(tx, loaded, timer.entity, timer.recordId) : false;
      const turn = this.#turn(tx, loaded, scope, null);
      await tx.db.update(processStartTimers).set({ status: present ? 'fired' : 'cancelled', firedAt: turn.now, lastError: null }).where(eq(processStartTimers.id, timer.id));
      const start = loaded.definition.processes?.[timer.process]?.elements[timer.element];
      // The record is gone, the release no longer starts the process this way, or it runs already.
      if (!present || start?.type !== 'startEvent' || !start.timer || (await this.#runsOn(turn, timer.process, timer.recordId))) return;
      await this.#start(turn, timer.process, timer.element, timer.recordId, null, undefined, 'timer');
      await this.#drain(turn);
    });
  }

  /** An inclusive gateway's join goes on once no other token of its run can still reach it. */
  async #tryJoin(turn: Turn, live: Live, id: string, scope: string | null): Promise<boolean> {
    const db = turn.tx.db;
    const tokens = (await db.select().from(processTokens).where(eq(processTokens.instanceId, live.row.id))).filter((token) => token.scope === scope);
    const here = tokens.filter((token) => token.element === id && token.state === 'waiting');
    if (!here.length) return false;
    const elsewhere = [
      ...tokens.filter((token) => token.element !== id).map((token) => token.element),
      ...turn.queue.filter((move) => move.instanceId === live.row.id && move.scope === scope).map((move) => move.element),
    ];
    for (const at of elsewhere) {
      if (at === id) return false;
      let reach = live.reach.get(at);
      if (!reach) {
        reach = reachable(live.process, live.graph, at);
        live.reach.set(at, reach);
      }
      if (reach.has(id)) return false;
    }
    await db.delete(processTokens).where(inArray(processTokens.id, here.map((token) => token.id)));
    await this.#leave(turn, live, id, scope);
    return true;
  }

  /** The run a token is in, by its ID: the scope that a task's token gives the paths that leave the task. */
  async #scopeOf(turn: Turn, tokenId: string | null): Promise<string | null> {
    if (!tokenId) return null;
    const [token] = await turn.tx.db.select({ scope: processTokens.scope }).from(processTokens).where(eq(processTokens.id, tokenId));
    return token?.scope ?? null;
  }

  async #start(
    turn: Turn,
    name: string,
    startAt: string,
    recordId: string,
    action: string | null,
    caller?: { readonly instanceId: string; readonly tokenId: string; readonly startedBy: string | null },
    automatic?: 'timer' | 'condition',
  ): Promise<Live> {
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
        startedBy: turn.by ?? caller?.startedBy ?? null,
        startedByAction: action,
        calledByInstance: caller?.instanceId ?? null,
        calledByToken: caller?.tokenId ?? null,
        startedAt: turn.now,
      })
      .returning();
    const live: Live = { row: row!, process, graph: processGraph(process), entity: process.entity, outcomes: {}, ended: false, reached: null, reach: new Map() };
    turn.live.set(row!.id, live);
    const why = action ? { action } : caller ? { calledBy: caller.instanceId } : automatic ? { [automatic]: true } : null;
    await this.#event(turn, live, 'started', startAt, why);
    await this.#audit(turn, live, 'process.start', why ?? { byHand: true });
    turn.queue.push({ instanceId: row!.id, element: startAt, flow: null, scope: null });
    return live;
  }

  /**
   * Move tokens until each waits or ends. A run of a sub-process that nothing runs inside any more
   * ends, and an instance whose last token ended completes; a called one then lets its caller go on.
   */
  async #drain(turn: Turn): Promise<void> {
    for (;;) {
      while (turn.queue.length) {
        if (++turn.moves > MAX_MOVES) throw unprocessable('process_loops', `A process moved ${MAX_MOVES} times without waiting: check its flows for a loop that waits for nothing`);
        const { instanceId, element, flow, scope } = turn.queue.shift()!;
        const live = await this.#live(turn, instanceId);
        if (!live.ended) await this.#arrive(turn, live, element, flow, scope);
      }
      // A path that ended may be what an inclusive join waited for: try the joins that wait again.
      let joined = false;
      for (const live of turn.live.values()) {
        if (live.ended) continue;
        const waiting = await turn.tx.db
          .select({ element: processTokens.element, scope: processTokens.scope })
          .from(processTokens)
          .where(and(eq(processTokens.instanceId, live.row.id), eq(processTokens.state, 'waiting')));
        const joins = new Map(waiting.filter((token) => live.process.elements[token.element]?.type === 'inclusiveGateway').map((token) => [`${token.element} ${token.scope ?? ''}`, token]));
        for (const token of joins.values()) if (await this.#tryJoin(turn, live, token.element, token.scope)) joined = true;
      }
      if (joined || (await this.#finishScopes(turn))) continue;
      for (const live of [...turn.live.values()]) {
        if (live.ended) continue;
        const [left] = await turn.tx.db.select({ count: sql<number>`count(*)::int` }).from(processTokens).where(eq(processTokens.instanceId, live.row.id));
        if (!left?.count) await this.#end(turn, live, 'completed');
      }
      if (!turn.queue.length) break;
    }
  }

  /** Queue a token's move to an element, in a run of a sub-process or in the process itself. */
  #move(turn: Turn, live: Live, element: string, flow: string | null, scope: string | null): void {
    turn.queue.push({ instanceId: live.row.id, element, flow, scope });
  }

  /** Make a token wait at an element. */
  async #wait(turn: Turn, live: Live, element: string, flow: string | null, scope: string | null, extra: { readonly voters?: string[] } = {}): Promise<string> {
    const id = uuidv7(turn.now.getTime());
    await turn.tx.db.insert(processTokens).values({ id, instanceId: live.row.id, element, scope, arrivedBy: flow, state: 'waiting', createdAt: turn.now, ...extra });
    return id;
  }

  /**
   * A sub-process starts a run of its own: a token waits at it for as long as anything runs inside
   * that run, the timers on its boundary start, and a path starts at its start event. Each arrival
   * starts another run, beside any that runs already.
   */
  async #enter(turn: Turn, live: Live, id: string, flow: string | null, scope: string | null): Promise<void> {
    const start = startEventsOf(live.process, id)[0];
    if (!start) return this.#stuck(turn, live, id, flow, `${elementName(live.process, id)} has no start event inside it`, scope);
    const run = await this.#wait(turn, live, id, flow, scope);
    await this.#boundaryTimers(turn, live, id, { tokenId: run }, (await this.#record(turn, live)) ?? {});
    await this.#event(turn, live, 'entered', id, null);
    this.#move(turn, live, start, null, run);
  }

  /** The runs of sub-processes that nothing runs inside any more end, and their paths go on. Returns whether one did. */
  async #finishScopes(turn: Turn): Promise<boolean> {
    let finished = false;
    for (const live of [...turn.live.values()]) {
      if (live.ended) continue;
      const tokens = await turn.tx.db.select().from(processTokens).where(eq(processTokens.instanceId, live.row.id));
      for (const token of tokens) {
        if (token.state !== 'waiting' || live.process.elements[token.element]?.type !== 'subProcess') continue;
        if (tokens.some((other) => other.scope === token.id)) continue;
        await turn.tx.db.delete(processTokens).where(eq(processTokens.id, token.id));
        await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, token.id), eq(processTimers.status, 'waiting')));
        await this.#event(turn, live, 'exited', token.element, { run: token.id, ...inRun(token.scope) });
        await this.#leave(turn, live, token.element, token.scope);
        finished = true;
      }
    }
    return finished;
  }

  /** End what runs inside a run of a sub-process: the paths on their way in it, and what waits in it. */
  async #clearScope(turn: Turn, live: Live, run: string, reason: CloseReason): Promise<void> {
    for (let index = turn.queue.length - 1; index >= 0; index--) {
      const move = turn.queue[index]!;
      if (move.instanceId === live.row.id && move.scope === run) turn.queue.splice(index, 1);
    }
    const tokens = await turn.tx.db.select().from(processTokens).where(and(eq(processTokens.instanceId, live.row.id), eq(processTokens.scope, run)));
    await this.#dropTokens(turn, live, tokens, reason);
  }

  /**
   * Drop tokens that wait: the tasks they hold close, their timers stop, what runs inside a run of a
   * sub-process ends, and the processes they called are cancelled.
   */
  async #dropTokens(turn: Turn, live: Live, tokens: readonly TokenRow[], reason: CloseReason): Promise<void> {
    const db = turn.tx.db;
    for (const token of tokens) {
      if (live.process.elements[token.element]?.type === 'subProcess' && token.state === 'waiting') await this.#clearScope(turn, live, token.id, reason);
      const open = await db.select().from(processTasks).where(and(eq(processTasks.tokenId, token.id), eq(processTasks.status, 'open')));
      for (const task of open) await this.#closeTask(turn, live, task, reason);
      await db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, token.id), eq(processTimers.status, 'waiting')));
      if (live.process.elements[token.element]?.type === 'callActivity') await this.#cancelCalled(turn, token.id);
    }
    if (tokens.length) await db.delete(processTokens).where(inArray(processTokens.id, tokens.map((token) => token.id)));
  }

  /** End what waits at a token, from an event on its boundary: a run of a sub-process with what runs inside it, a call with the process it called, or a task. */
  async #interrupt(turn: Turn, live: Live, token: TokenRow, reason: CloseReason): Promise<void> {
    await this.#dropTokens(turn, live, [token], reason);
  }

  /**
   * A call activity: start the process it calls, on this record or on the one a reference field of
   * it names, and wait until that instance ends.
   */
  async #call(turn: Turn, live: Live, id: string, flow: string | null, element: CallActivityElement, scope: string | null): Promise<void> {
    const db = turn.tx.db;
    const stuck = (message: string) => this.#stuck(turn, live, id, flow, `${element.name}: ${message}`, scope);
    const called = turn.loaded.definition.processes?.[element.process];
    if (!called) return stuck(`the app has no process ${element.process}`);
    const start = plainStartOf(called);
    if (!start) return stuck(`${called.label} has no start event`);
    const record = (await this.#record(turn, live)) ?? {};
    let recordId = live.row.recordId;
    if (element.record) {
      const value = record[element.record];
      if (typeof value !== 'string') return stuck(`the record has no ${element.record}`);
      recordId = value;
      // Another record: lock it, as an action on it would, before its process moves.
      if (recordId !== live.row.recordId && !(await this.#runtime.lockRecord(turn.tx, turn.loaded, called.entity, recordId))) return stuck(`the ${element.record} it names no longer exists`);
    }
    const [running] = await db
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(and(eq(processInstances.environmentId, turn.loaded.env.id), eq(processInstances.process, element.process), eq(processInstances.recordId, recordId), eq(processInstances.status, 'running')));
    if (running) return stuck(`${called.label} already runs for that record`);
    const tokenId = await this.#wait(turn, live, id, flow, scope);
    await this.#boundaryTimers(turn, live, id, { tokenId }, record);
    const child = await this.#start(turn, element.process, start, recordId, null, { instanceId: live.row.id, tokenId, startedBy: live.row.startedBy });
    await this.#event(turn, live, 'called', id, { process: element.process, instance: child.row.id, recordId });
  }

  /** Cancel the instance that a call activity's token waits for, without sending it back to the caller. */
  async #cancelCalled(turn: Turn, tokenId: string): Promise<void> {
    const called = await turn.tx.db.select().from(processInstances).where(and(eq(processInstances.calledByToken, tokenId), eq(processInstances.status, 'running')));
    for (const row of called) {
      await this.#runtime.lockRecord(turn.tx, turn.loaded, row.entity, row.recordId);
      const live = await this.#live(turn, row.id);
      if (!live.ended) await this.#end(turn, live, 'cancelled', undefined, false);
    }
  }

  /** The call that started an instance, and the instance it is in, locked: while both run and the call waits. */
  async #caller(turn: Turn, called: Live): Promise<{ readonly live: Live; readonly token: TokenRow } | null> {
    const db = turn.tx.db;
    const tokenId = called.row.calledByToken;
    if (!tokenId || !called.row.calledByInstance) return null;
    const [caller] = await db.select().from(processInstances).where(eq(processInstances.id, called.row.calledByInstance));
    if (!caller || caller.status !== 'running') return null;
    // The caller's record first, then its instance: the order an action takes them in.
    if (caller.recordId !== called.row.recordId) await this.#runtime.lockRecord(turn.tx, turn.loaded, caller.entity, caller.recordId);
    const live = await this.#live(turn, caller.id);
    const [token] = await db.select().from(processTokens).where(eq(processTokens.id, tokenId));
    if (live.ended || !token || token.state !== 'waiting') return null;
    return { live, token };
  }

  /** A called instance ended: the call activity that waits for it goes on; if it was cancelled, the call waits for an operator. */
  async #returnToCaller(turn: Turn, called: Live, status: 'completed' | 'cancelled'): Promise<void> {
    const db = turn.tx.db;
    const caller = await this.#caller(turn, called);
    if (!caller) return;
    const { live, token } = caller;
    await db.delete(processTokens).where(eq(processTokens.id, token.id));
    await db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, token.id), eq(processTimers.status, 'waiting')));
    if (status === 'completed') {
      await this.#event(turn, live, 'returned', token.element, { instance: called.row.id });
      return this.#leave(turn, live, token.element, token.scope);
    }
    await this.#stuck(turn, live, token.element, token.arrivedBy, `${called.process.label} was cancelled: try again to start it anew`, token.scope);
  }

  /** Start the timers on an element's boundary: a task's by the task, and the others' by the token that waits at the element. */
  async #boundaryTimers(turn: Turn, live: Live, id: string, holder: { readonly taskId: string } | { readonly tokenId: string }, record: RecordValues): Promise<void> {
    for (const boundary of live.graph.boundaries.get(id) ?? []) {
      const event = live.process.elements[boundary];
      if (event?.type !== 'boundaryEvent' || !event.timer) continue;
      const fireAt = timerFiresAt(event.timer, turn.now, record);
      if (!fireAt) continue;
      await turn.tx.db.insert(processTimers).values({ id: uuidv7(turn.now.getTime()), orgId: this.#ctx.org.id, instanceId: live.row.id, element: boundary, ...holder, fireAt, nextAttemptAt: fireAt, createdAt: turn.now });
    }
  }

  async #arrive(turn: Turn, live: Live, id: string, flow: string | null, scope: string | null): Promise<void> {
    const element = live.process.elements[id];
    if (!element) return this.#stuck(turn, live, id, flow, `The process has no element ${id}`, scope);
    switch (element.type) {
      case 'endEvent': {
        // An end that sends a message sends it first; if that fails, the path waits there.
        if (element.message && !(await this.#send(turn, live, id, element.message, scope))) return;
        // An error ends the path, and what the event that catches it sits on.
        if (element.error) return this.#error(turn, live, id, flow, { code: raisedCode(element.error), failure: undefined }, scope);
        // An escalation that interrupts what it came from ends this path with it; an undo that fails waits for an operator.
        if (element.escalation && !(await this.#escalate(turn, live, id, raisedCode(element.escalation), scope))) return;
        if (element.compensate && !(await this.#compensate(turn, live, id, flow, scope, scope))) return;
        if (element.cancel) return this.#cancelTransaction(turn, live, id, flow, scope);
        // Inside a sub-process, an end ends a path in its run; a terminate end ends all of the run, which then goes on.
        if (scope === null) live.reached = id;
        if (element.terminate) {
          if (scope === null) await this.#end(turn, live, 'completed', id);
          else await this.#clearScope(turn, live, scope, 'ended');
        }
        return;
      }
      case 'subProcess':
        return this.#enter(turn, live, id, flow, scope);
      case 'callActivity':
        return this.#call(turn, live, id, flow, element, scope);
      case 'userTask':
        return this.#openTask(turn, live, id, element, scope);
      case 'serviceTask':
        return this.#serve(turn, live, id, element, scope);
      case 'scriptTask':
        return this.#script(turn, live, id, element, scope);
      case 'businessRuleTask':
        return this.#checkRules(turn, live, id, element, scope);
      case 'sendTask':
        if (await this.#send(turn, live, id, element.message, scope)) await this.#leave(turn, live, id, scope);
        return;
      case 'receiveTask': {
        // A message, as a task: the token waits until the action commits on the record, and the timers on its boundary run.
        const tokenId = await this.#wait(turn, live, id, flow, scope);
        await this.#boundaryTimers(turn, live, id, { tokenId }, (await this.#record(turn, live)) ?? {});
        return;
      }
      case 'intermediateThrowEvent': {
        if (element.link !== undefined) {
          const target = linkTarget(live.process, id);
          if (!target) return this.#stuck(turn, live, id, flow, `No catch link named ${element.link} is where ${elementName(live.process, id)} is`, scope);
          this.#move(turn, live, target, null, scope);
          return;
        }
        if (element.message) {
          if (await this.#send(turn, live, id, element.message, scope)) await this.#leave(turn, live, id, scope);
          return;
        }
        if (element.escalation) {
          if (await this.#escalate(turn, live, id, raisedCode(element.escalation), scope)) await this.#leave(turn, live, id, scope);
          return;
        }
        // Undo what completed in the run the event is in, or in the process; then the path goes on.
        if (element.compensate) {
          if (await this.#compensate(turn, live, id, flow, scope, scope)) await this.#leave(turn, live, id, scope);
          return;
        }
        // A milestone: the history marks it, and the path goes on.
        await this.#event(turn, live, 'reached', id, null);
        return this.#leave(turn, live, id, scope);
      }
      case 'eventBasedGateway': {
        const record = (await this.#record(turn, live)) ?? {};
        const targets = this.#gatewayTargets(live, id);
        // A condition after it that holds already takes the path at once.
        const env = processConditionEnv({ record, outcomes: live.outcomes });
        const now = targets.find((target) => {
          const candidate = live.process.elements[target];
          return candidate?.type === 'intermediateCatchEvent' && candidate.condition !== undefined && evaluateCondition(candidate.condition, env);
        });
        if (now) {
          await this.#event(turn, live, 'condition', now, null);
          return this.#leave(turn, live, now, scope);
        }
        const tokenId = await this.#wait(turn, live, id, flow, scope);
        for (const target of targets) {
          const candidate = live.process.elements[target];
          if (candidate?.type !== 'intermediateCatchEvent' || !candidate.timer) continue;
          const fireAt = timerFiresAt(candidate.timer, turn.now, record);
          if (fireAt) await turn.tx.db.insert(processTimers).values({ id: uuidv7(turn.now.getTime()), orgId: this.#ctx.org.id, instanceId: live.row.id, element: target, tokenId, fireAt, nextAttemptAt: fireAt, createdAt: turn.now });
        }
        return;
      }
      case 'intermediateCatchEvent': {
        if (element.link !== undefined) return this.#leave(turn, live, id, scope);
        if (element.condition) {
          // A condition that holds already lets the path through; otherwise the path waits until a change makes it hold.
          const record = (await this.#record(turn, live)) ?? {};
          if (evaluateCondition(element.condition, processConditionEnv({ record, outcomes: live.outcomes }))) {
            await this.#event(turn, live, 'condition', id, null);
            return this.#leave(turn, live, id, scope);
          }
          await this.#wait(turn, live, id, flow, scope);
          return;
        }
        if (!element.timer) {
          // A message: the token waits until the action commits on the record.
          await this.#wait(turn, live, id, flow, scope);
          return;
        }
        const fireAt = timerFiresAt(element.timer, turn.now, (await this.#record(turn, live)) ?? {});
        if (!fireAt) return this.#stuck(turn, live, id, flow, `${elementName(live.process, id)}: the record has no ${'date' in element.timer ? element.timer.date : 'date'}`, scope);
        const tokenId = await this.#wait(turn, live, id, flow, scope);
        await turn.tx.db.insert(processTimers).values({ id: uuidv7(turn.now.getTime()), orgId: this.#ctx.org.id, instanceId: live.row.id, element: id, tokenId, fireAt, nextAttemptAt: fireAt, createdAt: turn.now });
        return;
      }
      case 'inclusiveGateway': {
        if ((live.graph.incoming.get(id) ?? []).length < 2) return this.#leave(turn, live, id, scope);
        await this.#wait(turn, live, id, flow, scope);
        await this.#tryJoin(turn, live, id, scope);
        return;
      }
      case 'parallelGateway': {
        const incoming = live.graph.incoming.get(id) ?? [];
        if (incoming.length > 1) {
          // A join waits for a token from each flow in, in the same run, then they go on as one.
          const waiting = await turn.tx.db
            .select()
            .from(processTokens)
            .where(and(eq(processTokens.instanceId, live.row.id), eq(processTokens.element, id), eq(processTokens.state, 'waiting')));
          const same = waiting.filter((token) => token.scope === scope);
          const others = incoming.filter((each) => each !== flow).map((each) => same.find((token) => token.arrivedBy === each));
          if (others.some((token) => !token)) {
            await this.#wait(turn, live, id, flow, scope);
            return;
          }
          await turn.tx.db.delete(processTokens).where(inArray(processTokens.id, others.map((token) => token!.id)));
        }
        return this.#leave(turn, live, id, scope);
      }
      default:
        return this.#leave(turn, live, id, scope);
    }
  }

  /** Send a token on along the flows out of an element: for a user task or a rule check, those of its outcome. */
  async #leave(turn: Turn, live: Live, id: string, scope: string | null, outcome?: string): Promise<void> {
    const type = live.process.elements[id]?.type;
    const decides = type === 'exclusiveGateway' || type === 'inclusiveGateway';
    const state = { record: decides ? ((await this.#record(turn, live)) ?? {}) : {}, outcomes: live.outcomes };
    const out = flowsOut(live.process, live.graph, id, state, outcome);
    if (!out.ok) return this.#stuck(turn, live, id, null, out.message, scope);
    for (const flow of out.flows) this.#move(turn, live, live.process.flows[flow]!.to, flow, scope);
  }

  async #stuck(turn: Turn, live: Live, element: string, flow: string | null, message: string, scope: string | null): Promise<void> {
    await turn.tx.db
      .insert(processTokens)
      .values({ id: uuidv7(turn.now.getTime()), instanceId: live.row.id, element, scope, arrivedBy: flow, state: 'stuck', error: message.slice(0, 1000), createdAt: turn.now });
    await this.#event(turn, live, 'stuck', element, { error: message });
  }

  /** An action that a task ran failed: an error without a code, which an error event on the task catches first. */
  async #failed(turn: Turn, live: Live, id: string, flow: string | null, message: string, scope: string | null): Promise<void> {
    return this.#error(turn, live, id, flow, { code: undefined, failure: message }, scope);
  }

  /**
   * Find the event that catches an error or an escalation of a code, raised at an element: on the
   * element itself, for a task that failed; on the runs of sub-processes around it, nearest first;
   * then on the call that started the instance, and around that call, up to an instance that nothing
   * called.
   */
  async #catcher(turn: Turn, live: Live, id: string, kind: 'error' | 'escalation', code: string | undefined, scope: string | null, own: boolean): Promise<Catch | null> {
    if (own) {
      const boundary = catcherOn(live.process, live.graph, id, kind, code);
      if (boundary) return { live, boundary, host: null, scope };
    }
    let current = live;
    let at = scope;
    for (;;) {
      while (at !== null) {
        const [run] = await turn.tx.db.select().from(processTokens).where(eq(processTokens.id, at));
        if (!run) return null;
        const boundary = catcherOn(current.process, current.graph, run.element, kind, code);
        if (boundary) return { live: current, boundary, host: run, scope: run.scope };
        at = run.scope;
      }
      const caller = await this.#caller(turn, current);
      if (!caller) return null;
      const boundary = catcherOn(caller.live.process, caller.live.graph, caller.token.element, kind, code);
      if (boundary) return { live: caller.live, boundary, host: caller.token, scope: caller.token.scope };
      current = caller.live;
      at = caller.token.scope;
    }
  }

  /**
   * A catch that interrupts: what its event sits on ends, with all that runs inside it. When that is
   * a call in another instance, the instance where it was raised ends first, at the element that
   * raised it, and the instances between end with the call.
   */
  async #interruptFor(turn: Turn, live: Live, id: string, caught: Catch, reason: CloseReason): Promise<void> {
    if (caught.live !== live && !live.ended) await this.#end(turn, live, 'cancelled', id, false);
    if (caught.host) await this.#interrupt(turn, caught.live, caught.host, reason);
  }

  /**
   * An error: an action that a task ran failed, or an error end event raised one with its code. The
   * nearest event that catches it ends what it sits on, with all that runs inside, and its path goes
   * on. Without one, the path waits for an operator where the error was.
   */
  async #error(turn: Turn, live: Live, id: string, flow: string | null, raised: { readonly code: string | undefined; readonly failure: string | undefined }, scope: string | null): Promise<void> {
    const caught = await this.#catcher(turn, live, id, 'error', raised.code, scope, raised.failure !== undefined);
    if (!caught) {
      const why = raised.failure ?? (raised.code ? `nothing catches the error ${raised.code}` : 'nothing catches its error');
      return this.#stuck(turn, live, id, flow, `${elementName(live.process, id)}: ${why}`, scope);
    }
    await this.#interruptFor(turn, live, id, caught, 'error');
    const detail = raised.failure !== undefined ? { task: id, error: raised.failure } : { from: id, ...(raised.code ? { code: raised.code } : {}) };
    await this.#event(turn, caught.live, 'error_caught', caught.boundary, { ...detail, ...(caught.live === live ? {} : { instance: live.row.id }) });
    return this.#leave(turn, caught.live, caught.boundary, caught.scope);
  }

  /**
   * An escalation: the nearest event that hears it, on a sub-process or a call around the element,
   * takes a path out. One that interrupts ends what it sits on, and with it the path that escalated.
   * Without one, the history says so, and the path goes on. Returns whether the path goes on.
   */
  async #escalate(turn: Turn, live: Live, id: string, code: string | undefined, scope: string | null): Promise<boolean> {
    const raised = { from: id, ...(code ? { code } : {}) };
    const caught = await this.#catcher(turn, live, id, 'escalation', code, scope, false);
    if (!caught) {
      await this.#event(turn, live, 'escalated', id, { ...raised, heard: false });
      return true;
    }
    const event = caught.live.process.elements[caught.boundary];
    const interrupting = event?.type === 'boundaryEvent' && event.interrupting;
    if (interrupting) await this.#interruptFor(turn, live, id, caught, 'escalation');
    await this.#event(turn, caught.live, 'escalated', caught.boundary, { ...raised, ...(caught.live === live ? {} : { instance: live.row.id }) });
    await this.#leave(turn, caught.live, caught.boundary, caught.scope);
    return !interrupting;
  }

  /**
   * Undo what completed in a run of a sub-process, or in the process itself (null): the undo actions
   * of its tasks, and of the runs that completed in it, newest first, with the app's authority. Each
   * undo runs once, so trying again goes on from the one that failed. Returns whether all ran; if one
   * fails, the path waits for an operator at the element.
   */
  async #compensate(turn: Turn, live: Live, id: string, flow: string | null, scope: string | null, target: string | null): Promise<boolean> {
    const events = await turn.tx.db
      .select()
      .from(processEvents)
      .where(and(eq(processEvents.instanceId, live.row.id), inArray(processEvents.kind, ['ran', 'sent', 'skill_queued', 'exited', 'compensated'])))
      .orderBy(asc(processEvents.seq));
    const detailOf = (event: (typeof events)[number]) => (isDetail(event.detail) ? event.detail : {});
    const done = new Set(events.flatMap((event) => (event.kind === 'compensated' && typeof detailOf(event)['of'] === 'string' ? [String(detailOf(event)['of'])] : [])));
    const origin: ProcessOrigin = { kind: 'process', instanceId: live.row.id, process: live.row.process, element: id, onBehalfOf: turn.by ?? live.row.startedBy };
    const name = elementName(live.process, id);
    const undo = async (run: string | null): Promise<boolean> => {
      const inside = events.filter((event) => event.kind !== 'compensated' && (detailOf(event)['scope'] ?? null) === run);
      for (const event of inside.reverse()) {
        const detail = detailOf(event);
        if (event.kind === 'exited') {
          if (typeof detail['run'] === 'string' && !(await undo(detail['run']))) return false;
          continue;
        }
        const action = detail['undo'];
        const recordId = detail['recordId'];
        if (typeof action !== 'string' || typeof recordId !== 'string' || done.has(event.id)) continue;
        const task = event.element ? elementName(live.process, event.element) : action;
        const fail = async (message: string): Promise<false> => {
          await this.#stuck(turn, live, id, flow, `${name}: undoing ${task} failed: ${message}`, scope);
          return false;
        };
        if (turn.loaded.app.movedTo) return fail('the app moved to a team space, so it changes no records here');
        const entity = turn.loaded.definition.actions[action]?.entity ?? live.entity;
        // Another record: lock it, as an action on it would.
        if (recordId !== live.row.recordId && !(await this.#runtime.lockRecord(turn.tx, turn.loaded, entity, recordId))) return fail('its record no longer exists');
        const before = recordId === live.row.recordId ? await this.#record(turn, live) : await this.#runtime.recordIn(turn.tx, turn.loaded, entity, recordId);
        const ran = await this.#runtime.runForProcess(turn.tx, turn.loaded, action, recordId, origin);
        if (!ran.ok) return fail(ran.message);
        turn.records.delete(recordId);
        done.add(event.id);
        await this.#event(turn, live, 'compensated', event.element, { of: event.id, action, recordId, from: id });
        await this.#actionCommitted(turn, action, recordId, null);
        await this.#recordChanged(turn, entity, recordId, before);
      }
      return true;
    };
    return undo(target);
  }

  /**
   * A cancel end event ends the transaction it is in: what still runs in it stops, what completed in
   * it is undone, newest first, and the path leaves by the cancel event on the transaction's boundary.
   */
  async #cancelTransaction(turn: Turn, live: Live, id: string, flow: string | null, scope: string | null): Promise<void> {
    const [run] = scope === null ? [] : await turn.tx.db.select().from(processTokens).where(eq(processTokens.id, scope));
    const transaction = run ? live.process.elements[run.element] : undefined;
    const boundary =
      run && transaction?.type === 'subProcess' && transaction.transaction
        ? (live.graph.boundaries.get(run.element) ?? []).find((each) => {
            const event = live.process.elements[each];
            return event?.type === 'boundaryEvent' && event.cancel === true;
          })
        : undefined;
    if (!run || !boundary) return this.#stuck(turn, live, id, flow, `${elementName(live.process, id)}: no cancel event on a transaction around it leads out`, scope);
    await this.#clearScope(turn, live, run.id, 'cancelled');
    if (!(await this.#compensate(turn, live, id, flow, scope, run.id))) return;
    await this.#dropTokens(turn, live, [run], 'cancelled');
    await this.#event(turn, live, 'transaction_cancelled', boundary, { transaction: run.element, from: id });
    return this.#leave(turn, live, boundary, run.scope);
  }

  /** A script task: its steps change the record, with the app's authority, through the action pipeline. */
  async #script(turn: Turn, live: Live, id: string, element: ScriptTaskElement, scope: string | null): Promise<void> {
    if (turn.loaded.app.movedTo) return this.#stuck(turn, live, id, null, `${element.name}: the app moved to a team space, so it changes no records here`, scope);
    const origin: ProcessOrigin = { kind: 'process', instanceId: live.row.id, process: live.row.process, element: id, onBehalfOf: turn.by ?? live.row.startedBy };
    const script = { name: `${live.row.process}.${id}`, label: element.name, entity: live.entity, steps: element.steps };
    const before = await this.#record(turn, live);
    const ran = await this.#runtime.runScriptForProcess(turn.tx, turn.loaded, script, live.row.recordId, origin);
    if (!ran.ok) return this.#failed(turn, live, id, null, ran.message, scope);
    turn.records.delete(live.row.recordId);
    await this.#event(turn, live, 'ran', id, { steps: element.steps.length, ...inRun(scope), ...undoOf(element.undo, live.row.recordId) });
    await this.#recordChanged(turn, live.entity, live.row.recordId, before);
    return this.#leave(turn, live, id, scope);
  }

  /** A rule check: the record against the app's rules, all or those named. What it finds is its outcome, which chooses the flow out. */
  async #checkRules(turn: Turn, live: Live, id: string, element: BusinessRuleTaskElement, scope: string | null): Promise<void> {
    const findings = await this.#runtime.checkRules(turn.tx, turn.loaded, live.entity, live.row.recordId, element.rules);
    if (!findings) return this.#stuck(turn, live, id, null, `${element.name}: the record no longer exists`, scope);
    const outcome = findings.some((finding) => finding.severity === 'error') ? 'failed' : findings.length ? 'warned' : 'passed';
    live.outcomes[id] = outcome;
    await turn.tx.db.update(processInstances).set({ outcomes: live.outcomes }).where(eq(processInstances.id, live.row.id));
    await this.#event(turn, live, 'checked', id, { outcome, rules: [...new Set(findings.map((finding) => finding.rule))] });
    return this.#leave(turn, live, id, scope, outcome);
  }

  /**
   * Send a message: run its update action, with the app's authority, on the record or on the one a
   * reference field names; the processes on that record hear it. Returns whether it was sent: if
   * the action fails, the failure goes where the task's or sub-process's error event leads.
   */
  async #send(turn: Turn, live: Live, id: string, message: Message, scope: string | null): Promise<boolean> {
    const name = elementName(live.process, id);
    if (turn.loaded.app.movedTo) {
      await this.#stuck(turn, live, id, null, `${name}: the app moved to a team space, so it changes no records here`, scope);
      return false;
    }
    let recordId = live.row.recordId;
    if (message.record) {
      const value = ((await this.#record(turn, live)) ?? {})[message.record];
      const action = turn.loaded.definition.actions[message.action];
      if (typeof value !== 'string' || !action) {
        await this.#stuck(turn, live, id, null, `${name}: the record has no ${message.record}`, scope);
        return false;
      }
      recordId = value;
      // Another record: lock it, as an action on it would.
      if (recordId !== live.row.recordId && !(await this.#runtime.lockRecord(turn.tx, turn.loaded, action.entity, recordId))) {
        await this.#stuck(turn, live, id, null, `${name}: the ${message.record} it names no longer exists`, scope);
        return false;
      }
    }
    const origin: ProcessOrigin = { kind: 'process', instanceId: live.row.id, process: live.row.process, element: id, onBehalfOf: turn.by ?? live.row.startedBy };
    const entity = turn.loaded.definition.actions[message.action]?.entity ?? live.entity;
    const before = recordId === live.row.recordId ? await this.#record(turn, live) : await this.#runtime.recordIn(turn.tx, turn.loaded, entity, recordId);
    const ran = await this.#runtime.runForProcess(turn.tx, turn.loaded, message.action, recordId, origin);
    if (!ran.ok) {
      await this.#failed(turn, live, id, null, ran.message, scope);
      return false;
    }
    turn.records.delete(recordId);
    const sender = live.process.elements[id];
    await this.#event(turn, live, 'sent', id, { action: message.action, recordId, ...inRun(scope), ...(sender?.type === 'sendTask' && sender.undo ? { undo: sender.undo } : {}) });
    await this.#actionCommitted(turn, message.action, recordId, null);
    await this.#recordChanged(turn, entity, recordId, before);
    return true;
  }

  async #openTask(turn: Turn, live: Live, id: string, element: UserTaskElement, scope: string | null): Promise<void> {
    const record = (await this.#record(turn, live)) ?? {};
    if (element.several) return this.#openVotes(turn, live, id, element, record, scope);
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
    const tokenId = await this.#wait(turn, live, id, null, scope);
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
    await this.#boundaryTimers(turn, live, id, { taskId }, record);
    const routing = { role: element.role, assignee, ...(routed && routed !== assignee ? { covering: routed } : {}), ...(element.assignee && !routed ? { routing: 'fell back to the role' } : {}), ...(departmentOfTask ? { department: departmentOfTask } : {}) };
    await this.#event(turn, live, 'task_opened', id, { task: taskId, ...routing });
    await this.#audit(turn, live, 'process.task.assign', { task: taskId, name: element.name, ...routing }, { type: 'process_task', id: taskId, name: element.name });
  }

  /** Who votes on a task that several people decide: each once, with cover for those away. */
  async #voters(turn: Turn, live: Live, element: UserTaskElement, record: RecordValues): Promise<string[]> {
    const db = turn.tx.db;
    const people = element.several!.people;
    const named = (field: string) => (typeof record[field] === 'string' ? (record[field] as string) : null);
    let found: string[] = [];
    if ('everyone' in people) {
      found = await this.#roleHolders(db, live.row.appId, live.row.environmentId, element.role, turn.now);
      const department = element.department ? await this.#departmentOfField(db, named(element.department.of)) : null;
      if (department) {
        const rows = found.length ? await db.select({ id: users.id }).from(users).where(and(inArray(users.id, found), eq(users.department, department))) : [];
        const kept = new Set(rows.map((row) => row.id));
        found = found.filter((id) => kept.has(id));
      }
    } else if ('fields' in people) {
      for (const field of people.fields) {
        const person = named(field);
        if (person && (await this.#activeUser(db, person))) found.push(person);
      }
    } else {
      const from = named(people.lineOf);
      for (let level = 1; from && level <= people.levels; level++) {
        const manager = await managerUp(db, from, level);
        if (!manager) break;
        found.push(manager);
      }
    }
    const voters: string[] = [];
    for (const person of found) {
      const cover = await coverFor(db, person, turn.now);
      if (!voters.includes(cover)) voters.push(cover);
    }
    return voters.slice(0, 50);
  }

  /** The active people who hold an app role in an environment, themselves or through a group. */
  async #roleHolders(db: Database, appId: string, environmentId: string, role: string, now: Date): Promise<string[]> {
    const held = await db
      .select({ type: bindings.principalType, id: bindings.principalId })
      .from(bindings)
      .where(
        and(
          eq(bindings.scopeType, 'env'),
          eq(bindings.scopeId, environmentId),
          eq(bindings.appRoleId, appRoleId(appId, role)),
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

  /** Open a task that several people decide: one waiting token with its voters, and a vote for each, or for the first of them. */
  async #openVotes(turn: Turn, live: Live, id: string, element: UserTaskElement, record: RecordValues, scope: string | null): Promise<void> {
    const voters = await this.#voters(turn, live, element, record);
    if (!voters.length) return this.#stuck(turn, live, id, null, `${element.name}: nobody can vote`, scope);
    const needed = votesNeeded(element.several!.decide, voters.length);
    if (needed !== null && needed > voters.length) return this.#stuck(turn, live, id, null, `${element.name} needs ${needed} votes, but only ${voters.length} people can vote`, scope);
    const tokenId = await this.#wait(turn, live, id, null, scope, { voters });
    for (const person of element.several!.sequential ? voters.slice(0, 1) : voters) await this.#openVote(turn, live, id, element, tokenId, person);
    await this.#boundaryTimers(turn, live, id, { tokenId }, record);
  }

  async #openVote(turn: Turn, live: Live, id: string, element: UserTaskElement, tokenId: string, person: string): Promise<void> {
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
      assignee: person,
      several: true,
      outcomes: element.outcomes.map((outcome) => ({ name: outcome.name, label: outcome.label, ...(outcome.action ? { action: outcome.action } : {}) })),
      card: element.card ?? null,
      dueAt: element.due ? addDuration(turn.now, element.due) : null,
      createdAt: turn.now,
    });
    await this.#event(turn, live, 'task_opened', id, { task: taskId, role: element.role, assignee: person, vote: true });
    await this.#audit(turn, live, 'process.task.assign', { task: taskId, name: element.name, role: element.role, assignee: person, vote: true }, { type: 'process_task', id: taskId, name: element.name });
  }

  /**
   * Count a person's vote. Once the votes decide, the other votes close and the outcome's action runs
   * with the app's authority; if its checks stop it, the deciding vote is refused, with why.
   */
  async #vote(turn: Turn, task: TaskRow, outcome: string, by: string): Promise<void> {
    const db = turn.tx.db;
    const live = await this.#live(turn, task.instanceId);
    const element = live.process.elements[task.element];
    if (element?.type !== 'userTask' || !element.several || !task.tokenId) throw conflict('not_a_vote', `${task.name} is not decided by votes`);
    await db.update(processTasks).set({ status: 'completed', outcome, completedBy: by, closedAt: turn.now }).where(eq(processTasks.id, task.id));
    await this.#event(turn, live, 'voted', task.element, { task: task.id, outcome }, by);
    await this.#audit(turn, live, 'process.task.vote', { task: task.id, outcome }, { type: 'process_task', id: task.id, name: task.name });
    const [token] = await db.select().from(processTokens).where(eq(processTokens.id, task.tokenId)).for('update');
    const voters = token?.voters ?? [];
    const all = await db.select().from(processTasks).where(eq(processTasks.tokenId, task.tokenId)).orderBy(asc(processTasks.createdAt), asc(processTasks.id));
    const cast = all.filter((vote) => vote.status === 'completed').sort((a, b) => a.closedAt!.getTime() - b.closedAt!.getTime() || (a.id < b.id ? -1 : 1));
    const decided = decideVotes(element.several.decide, voters.length, cast.map((vote) => vote.outcome!));
    if (!decided) {
      const next = element.several.sequential ? voters[all.length] : undefined;
      if (next) await this.#openVote(turn, live, task.element, element, task.tokenId, next);
      return;
    }
    await this.#closeVotes(turn, live, task.tokenId, 'decided');
    const chosen = element.outcomes.find((candidate) => candidate.name === decided)!;
    if (chosen.action) {
      const origin: ProcessOrigin = { kind: 'process', instanceId: live.row.id, process: live.row.process, element: task.element, onBehalfOf: by };
      const before = await this.#record(turn, live);
      const ran = await this.#runtime.runForProcess(turn.tx, turn.loaded, chosen.action, live.row.recordId, origin);
      if (!ran.ok) throw unprocessable('action_failed', `${chosen.label}: ${ran.message}`);
      turn.records.delete(live.row.recordId);
      await this.#event(turn, live, 'ran', task.element, { action: chosen.action });
      await this.#actionCommitted(turn, chosen.action, live.row.recordId, null);
      await this.#recordChanged(turn, live.entity, live.row.recordId, before);
    }
    await db.delete(processTokens).where(eq(processTokens.id, task.tokenId));
    await db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.tokenId, task.tokenId), eq(processTimers.status, 'waiting')));
    live.outcomes[task.element] = decided;
    await db.update(processInstances).set({ outcomes: live.outcomes }).where(eq(processInstances.id, live.row.id));
    await this.#event(turn, live, 'task_completed', task.element, { outcome: decided, votes: cast.length }, by);
    await this.#audit(turn, live, 'process.task.complete', { outcome: decided, votes: cast.length }, { type: 'process_task', id: task.id, name: task.name });
    if (!live.ended) await this.#leave(turn, live, task.element, token?.scope ?? null, decided);
  }

  /** Close the votes still open on a task that several people decide. */
  async #closeVotes(turn: Turn, live: Live, tokenId: string, reason: 'decided' | CloseReason): Promise<void> {
    const open = await turn.tx.db.select().from(processTasks).where(and(eq(processTasks.tokenId, tokenId), eq(processTasks.status, 'open')));
    for (const vote of open) {
      await turn.tx.db.update(processTasks).set({ status: 'cancelled', cancelReason: reason, closedAt: turn.now }).where(eq(processTasks.id, vote.id));
      await this.#event(turn, live, 'task_cancelled', vote.element, { task: vote.id, reason });
    }
  }

  async #completeTask(turn: Turn, task: TaskRow, outcome: string, by: string | null): Promise<void> {
    const live = await this.#live(turn, task.instanceId);
    const scope = await this.#scopeOf(turn, task.tokenId);
    await turn.tx.db.update(processTasks).set({ status: 'completed', outcome, completedBy: by, tokenId: null, closedAt: turn.now }).where(eq(processTasks.id, task.id));
    if (task.tokenId) await turn.tx.db.delete(processTokens).where(eq(processTokens.id, task.tokenId));
    await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.taskId, task.id), eq(processTimers.status, 'waiting')));
    live.outcomes[task.element] = outcome;
    await turn.tx.db.update(processInstances).set({ outcomes: live.outcomes }).where(eq(processInstances.id, live.row.id));
    await this.#event(turn, live, 'task_completed', task.element, { task: task.id, outcome, ...(by ? {} : { byProcess: true }) }, by);
    await this.#audit(turn, live, 'process.task.complete', { task: task.id, outcome }, { type: 'process_task', id: task.id, name: task.name });
    if (!live.ended) await this.#leave(turn, live, task.element, scope, outcome);
  }

  /** Close an open task without an outcome: an event interrupted it, or its instance ended. */
  async #closeTask(turn: Turn, live: Live, task: TaskRow, reason: CloseReason): Promise<void> {
    await turn.tx.db.update(processTasks).set({ status: 'cancelled', cancelReason: reason, tokenId: null, closedAt: turn.now }).where(eq(processTasks.id, task.id));
    if (task.tokenId) await turn.tx.db.delete(processTokens).where(eq(processTokens.id, task.tokenId));
    await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.taskId, task.id), eq(processTimers.status, 'waiting')));
    await this.#event(turn, live, 'task_cancelled', task.element, { task: task.id, reason });
  }

  /** A service task: run the app's action on the record with the app's authority, or start an a7c skill. */
  async #serve(turn: Turn, live: Live, id: string, element: Extract<Process['elements'][string], { type: 'serviceTask' }>, scope: string | null): Promise<void> {
    const origin: ProcessOrigin = { kind: 'process', instanceId: live.row.id, process: live.row.process, element: id, onBehalfOf: turn.by ?? live.row.startedBy };
    if (element.action) {
      if (turn.loaded.app.movedTo) return this.#stuck(turn, live, id, null, `${element.name}: the app moved to a team space, so it changes no records here`, scope);
      const before = await this.#record(turn, live);
      const ran = await this.#runtime.runForProcess(turn.tx, turn.loaded, element.action, live.row.recordId, origin);
      if (!ran.ok) return this.#failed(turn, live, id, null, ran.message, scope);
      turn.records.delete(live.row.recordId);
      await this.#event(turn, live, 'ran', id, { action: element.action, ...inRun(scope), ...undoOf(element.undo, live.row.recordId) });
      await this.#actionCommitted(turn, element.action, live.row.recordId, null);
      await this.#recordChanged(turn, live.entity, live.row.recordId, before);
    } else if (element.skill) {
      if (!this.#ctx.config.A7C_URL) return this.#stuck(turn, live, id, null, `${element.name}: this installation doesn't connect a7c`, scope);
      const record = (await this.#record(turn, live)) ?? {};
      const input: Record<string, ExpressionValue> = {};
      for (const [name, expression] of Object.entries(element.input ?? {})) {
        const value = evaluateExpression(expression, { record, principal: {}, now: turn.now });
        if (!value.ok) return this.#stuck(turn, live, id, null, `${element.name}: ${name}: ${value.message}`, scope);
        input[name] = value.value;
      }
      await this.#runtime.queueSkills(processWriter(this.#ctx.org.id, origin), turn.loaded, turn.tx, {
        action: `process:${live.row.process}`,
        recordId: live.row.recordId,
        calls: [{ step: id, label: element.name, skill: element.skill, input }],
        onBehalfOf: origin.onBehalfOf,
      });
      await this.#event(turn, live, 'skill_queued', id, { skill: element.skill, ...inRun(scope), ...undoOf(element.undo, live.row.recordId) });
    }
    return this.#leave(turn, live, id, scope);
  }

  /** End an instance: what still waits in it goes, with the processes it called. A called instance then goes back to its caller. */
  async #end(turn: Turn, live: Live, status: 'completed' | 'cancelled', at?: string, toCaller = true): Promise<void> {
    live.ended = true;
    await this.#dropTokens(turn, live, await turn.tx.db.select().from(processTokens).where(eq(processTokens.instanceId, live.row.id)), status === 'cancelled' ? 'cancelled' : 'ended');
    const open = await turn.tx.db.select().from(processTasks).where(and(eq(processTasks.instanceId, live.row.id), eq(processTasks.status, 'open')));
    for (const task of open) await this.#closeTask(turn, live, task, status === 'cancelled' ? 'cancelled' : 'ended');
    await turn.tx.db.update(processTimers).set({ status: 'cancelled' }).where(and(eq(processTimers.instanceId, live.row.id), eq(processTimers.status, 'waiting')));
    await turn.tx.db.delete(processTokens).where(eq(processTokens.instanceId, live.row.id));
    await turn.tx.db.update(processInstances).set({ status, endedAt: turn.now }).where(eq(processInstances.id, live.row.id));
    const where = at ?? (status === 'completed' ? live.reached : null);
    await this.#event(turn, live, status === 'completed' ? 'ended' : 'cancelled', where, null);
    await this.#audit(turn, live, status === 'completed' ? 'process.end' : 'process.cancel', where ? { at: where } : {});
    if (toCaller) await this.#returnToCaller(turn, live, status);
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
      .select({ task: processTasks, appName: apps.name, process: processInstances.process, assigneeName: users.displayName, assigneeEmail: users.email, voters: processTokens.voters })
      .from(processTasks)
      .innerJoin(apps, eq(apps.id, processTasks.appId))
      .innerJoin(processInstances, eq(processInstances.id, processTasks.instanceId))
      .leftJoin(users, eq(users.id, processTasks.assignee))
      .leftJoin(processTokens, eq(processTokens.id, processTasks.tokenId))
      .where(where)
      .orderBy(
        ...(order === 'open'
          ? [sql`${processTasks.dueAt} asc nulls last`, asc(processTasks.createdAt)]
          : order === 'closed'
            ? [desc(processTasks.closedAt)]
            : [asc(processTasks.createdAt)]),
      )
      .limit(limit);
    return rows.map(({ task, appName, process, assigneeName, assigneeEmail, voters }) => ({
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
      several: task.several,
      voters: task.several && voters ? voters.length : null,
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
      calledBy: row.calledByInstance,
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
