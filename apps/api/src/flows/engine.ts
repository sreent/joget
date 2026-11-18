import { uuidv7 } from '@platform/audit';
import { CLOCK, evaluateCondition, partialEvaluate, type Condition } from '@platform/authz';
import {
  conditionRecord,
  Draft,
  evaluateExpression,
  flowWaits,
  recordLabel,
  roundTo,
  type AppFlow,
  type Expression,
  type ExpressionValue,
  type FlowRun,
  type FlowStep,
  type FlowType,
  type RecordValues,
} from '@platform/app-model';
import { roleHolders } from '../access/holders.js';
import { requirePerson } from '../access/rules.js';
import type { LoadedApp } from '../apps/catalog.js';
import type { AppRuntime, BeforeResult, FlowHooks, Writer } from '../apps/runtime.js';
import type { AppTransaction } from '../apps/transaction.js';
import { recordAudit } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { HttpError, notFound, unprocessable } from '../errors.js';
import { asKind, valueAt, type Services } from '../integration/services.js';
import type { Notices } from '../notices/service.js';

/*
 * The flow engine (design §6.2). A flow runs in the transaction of what starts it, with the app's
 * authority: its writes go through each entity's checks and rules, and leave their history and
 * audit events, in the name of whoever started the flow. A failure undoes the whole transaction,
 * unless an error handler in the flow catches it.
 */

/** How much one run may do: the steps it takes, and how deep flows call one another. */
const MAX_RUN_STEPS = 10_000;
const MAX_CALL_DEPTH = 8;

/** Who runs a flow, and why. */
export interface FlowCaller {
  /** The flow's writes are made in this writer's name. */
  readonly writer: Writer;
  /** The person the flow works for: `principal.id` in its expressions. Empty for a process. */
  readonly principal: Readonly<Record<string, unknown>>;
  /** The caller's credentials, when a person or a token started it. A token can't delete data (design §5.7). */
  readonly auth: AuthContext | null;
  /** What started it, for the audit log. */
  readonly trigger: { readonly kind: 'action' | 'process' | 'api' | 'schedule' | 'webhook'; readonly name: string };
  /** A try that is undone after: it calls no service that changes something elsewhere, which couldn't be undone. */
  readonly dryRun?: boolean | undefined;
}

export interface FlowResult {
  readonly output: unknown;
  /** The warnings of checks that let the flow go on. */
  readonly findings: ReadonlyArray<{ readonly flow: string; readonly message: string }>;
  readonly writes: { readonly created: number; readonly changed: number; readonly deleted: number };
}

/** The entity of a record that a flow holds. A symbol, so it never shows in what a flow gives back. */
const ENTITY = Symbol('entity');
/** The mark of the record an action saves, in its flow before it saves: changes to it stay in memory. */
const DRAFT = Symbol('draft');
type FlowRecord = RecordValues & { readonly [ENTITY]?: string; readonly [DRAFT]?: true };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function tag(record: RecordValues, entity: string): FlowRecord {
  return Object.defineProperty({ ...record }, ENTITY, { value: entity, enumerable: false }) as FlowRecord;
}

/** The record an action saves, as its flow before it saves holds it. */
function drafted(draft: Draft, entity: string): FlowRecord {
  return Object.defineProperty(tag(draft.record, entity), DRAFT, { value: true, enumerable: false }) as FlowRecord;
}

const isDrafted = (held: unknown): boolean => isObject(held) && (held as FlowRecord)[DRAFT] === true;

/** Variables as conditions read them: an empty value counts as missing, as it does in a rule. */
function present(vars: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(vars).flatMap(([name, value]) => (value === null || value === undefined ? [] : [[name, isObject(value) ? conditionRecord(value as RecordValues) : value]])),
  );
}

/** Errors a flow's error handler catches: a check or a write that failed. Refusals of access are not among them. */
function catchable(error: unknown): error is HttpError {
  return error instanceof HttpError && (error.statusCode === 404 || error.statusCode === 409 || error.statusCode === 422);
}

/** Errors after which PostgreSQL ends the transaction, so the flow must go back to before its error handler. */
const DATABASE_ERRORS = new Set(['duplicate_value', 'record_referenced', 'unknown_reference']);

/** The variables of one list of steps, which see those of the lists around them. */
class Frame {
  readonly #values = new Map<string, unknown>();
  constructor(readonly parent?: Frame) {}

  #owner(name: string): Frame | undefined {
    for (let frame: Frame | undefined = this; frame; frame = frame.parent) if (frame.#values.has(name)) return frame;
    return undefined;
  }
  get(name: string): unknown {
    const owner = this.#owner(name);
    return owner ? owner.#values.get(name) : undefined;
  }
  /** A variable keeps its value where it was first given one; a new one lives in this list of steps. */
  set(name: string, value: unknown): void {
    (this.#owner(name) ?? this).#values.set(name, value);
  }
  define(name: string, value: unknown): void {
    this.#values.set(name, value);
  }
  all(): Record<string, unknown> {
    const out: Record<string, unknown> = this.parent ? this.parent.all() : {};
    for (const [name, value] of this.#values) out[name] = value;
    return out;
  }
}

/** A return step, on its way out of the flow. */
class Returned {
  constructor(readonly value: unknown) {}
}

interface State {
  readonly tx: AppTransaction;
  readonly loaded: LoadedApp;
  readonly caller: FlowCaller;
  readonly now: Date;
  steps: number;
  depth: number;
  savepoints: number;
  /** The warnings of checks: where each is, and the fields of the record an action saves that it is about. */
  readonly findings: Array<{ flow: string; message: string; at?: string; fields?: readonly string[] }>;
  readonly writes: { created: number; changed: number; deleted: number };
  /** How many people the flow told, and how many it couldn't, because the app isn't shared with them. */
  readonly told: { people: number; left: number };
  /** In a flow that runs before an action saves: the record it shapes, which is all it changes. */
  readonly draft?: { readonly draft: Draft; readonly action: string; readonly entity: string } | undefined;
}

export class FlowEngine implements FlowHooks {
  readonly #ctx: AppContext;
  readonly #runtime: AppRuntime;
  readonly #notices: Notices;
  readonly #services: Services;

  constructor(ctx: AppContext, runtime: AppRuntime, notices: Notices, services: Services) {
    this.#ctx = ctx;
    this.#runtime = runtime;
    this.#notices = notices;
    this.#services = services;
    runtime.attachFlows(this);
  }

  /** An action's flow, once the action writes its record. A flow that waits is the process engine's to start. */
  async afterAction(...[tx, loaded, event]: Parameters<FlowHooks['afterAction']>): Promise<void> {
    const run = loaded.definition.actions[event.action]?.flow;
    const flow = run ? loaded.definition.flows?.[run.flow] : undefined;
    if (!run || (flow && flowWaits(flow, loaded.definition.flows))) return;
    const input = this.inputFrom(loaded, run, event.entity, event.record, event.principal);
    await this.run(tx, loaded, run.flow, input, { writer: event.writer, principal: event.principal, auth: event.auth, trigger: { kind: 'action', name: event.action } });
  }

  /**
   * An action's flow before it saves, on the record as the action shapes it (design §6.2). Its
   * changes to that record stay in memory: the action writes them, or shows them in a preview or a
   * proposal. It writes nothing else, so it leaves no audit event of its own: the action's write does.
   */
  async beforeAction(...[tx, loaded, event]: Parameters<FlowHooks['beforeAction']>): Promise<BeforeResult> {
    const action = loaded.definition.actions[event.action];
    const run = action?.before;
    if (!action || !run) throw notFound('Flow');
    const draft = new Draft(loaded.definition, event.entity, event.record, event.lines);
    const caller: FlowCaller = { writer: flowWriter(event.writer, run.flow), principal: event.principal, auth: event.auth, trigger: { kind: 'action', name: event.action } };
    const state: State = {
      tx,
      loaded,
      caller,
      now: event.now,
      steps: 0,
      depth: 0,
      savepoints: 0,
      findings: [],
      writes: { created: 0, changed: 0, deleted: 0 },
      told: { people: 0, left: 0 },
      draft: { draft, action: action.label, entity: event.entity },
    };
    await this.#flow(state, run.flow, this.inputFrom(loaded, run, event.entity, event.record, event.principal, () => drafted(draft, event.entity)));
    return {
      record: draft.record,
      lines: draft.lines,
      set: draft.set,
      linesAdded: draft.linesAdded,
      findings: state.findings.map((finding) => ({ rule: `flows.${finding.flow}${finding.at ? `.${finding.at}` : ''}`, severity: 'warning', message: finding.message, fields: [...(finding.fields ?? [])] })),
    };
  }

  /** Run a flow in the caller's transaction, with its input worked out already: values, records and lists. */
  async run(tx: AppTransaction, loaded: LoadedApp, name: string, input: Readonly<Record<string, unknown>>, caller: FlowCaller): Promise<FlowResult> {
    const named: FlowCaller = { ...caller, writer: flowWriter(caller.writer, name) };
    const state: State = { tx, loaded, caller: named, now: this.#ctx.now(), steps: 0, depth: 0, savepoints: 0, findings: [], writes: { created: 0, changed: 0, deleted: 0 }, told: { people: 0, left: 0 } };
    const output = await this.#flow(state, name, input);
    const flow = loaded.definition.flows![name]!;
    await recordAudit(tx.db, named.writer.scope(state.now), {
      action: 'flow.run',
      target: { type: 'flow', id: name, name: flow.label },
      spaceId: loaded.space.id,
      appId: loaded.app.id,
      env: loaded.env.kind,
      reason: {
        trigger: caller.trigger,
        writes: state.writes,
        ...(state.told.people || state.told.left ? { told: state.told } : {}),
        ...(state.findings.length ? { findings: state.findings.map((finding) => finding.message) } : {}),
      },
    });
    return { output, findings: state.findings, writes: state.writes };
  }

  /** The input of a flow that an action or a process task runs, worked out from its record. `holder` gives the record itself. */
  inputFrom(
    loaded: LoadedApp,
    run: FlowRun,
    entity: string,
    record: RecordValues,
    principal: Readonly<Record<string, unknown>>,
    holder: () => FlowRecord = () => tag(record, entity),
  ): Record<string, unknown> {
    const now = this.#ctx.now();
    return Object.fromEntries(
      Object.entries(run.input).map(([name, expression]) => {
        if (isObject(expression) && 'ref' in expression && expression.ref === 'record') return [name, holder()];
        const worked = evaluateExpression(expression, { record, principal, now });
        if (!worked.ok) throw unprocessable('flow_failed', `${loaded.definition.flows?.[run.flow]?.label ?? run.flow}: ${name}: ${worked.message}`);
        return [name, worked.value];
      }),
    );
  }

  /** The input of a flow run through the API: values as they are, records and lists of records by their IDs. */
  async inputFromIds(tx: AppTransaction, loaded: LoadedApp, flow: AppFlow, given: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const issues: Array<{ field: string; message: string }> = [];
    const input: Record<string, unknown> = {};
    const load = async (type: Extract<FlowType, { type: 'record' | 'list' }>, id: unknown, field: string) => {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) {
        issues.push({ field, message: 'Give the ID of a record' });
        return null;
      }
      const record = await this.#runtime.recordIn(tx, loaded, type.entity, id);
      if (!record) issues.push({ field, message: `No ${type.entity} with the ID ${id}` });
      return record ? tag(record, type.entity) : null;
    };
    for (const [name, type] of Object.entries(flow.input)) {
      const value = given[name];
      if (value === undefined || value === null) {
        issues.push({ field: name, message: `Give ${name}` });
        continue;
      }
      if (type.type === 'record') input[name] = await load(type, value, name);
      else if (type.type === 'list') {
        if (!Array.isArray(value) || value.length > 1000) issues.push({ field: name, message: 'Give a list of at most 1000 record IDs' });
        else input[name] = (await Promise.all(value.map((id, index) => load(type, id, `${name}[${index}]`)))).filter((record) => record !== null);
      } else {
        const ok =
          (type.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
          (type.type === 'boolean' && typeof value === 'boolean') ||
          (type.type === 'text' && typeof value === 'string' && value.length <= 10_000) ||
          (type.type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
          (type.type === 'datetime' && typeof value === 'string' && !Number.isNaN(Date.parse(value)));
        if (ok) input[name] = value;
        else issues.push({ field: name, message: `Give ${type.type === 'boolean' ? 'true or false' : `a ${type.type}`}` });
      }
    }
    for (const name of Object.keys(given)) if (!(name in flow.input)) issues.push({ field: name, message: `${flow.label} takes no ${name}` });
    if (issues.length) throw unprocessable('invalid_values', 'Some input is not valid', { issues });
    return input;
  }

  async #flow(state: State, name: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    const flow = state.loaded.definition.flows?.[name];
    if (!flow) throw notFound('Flow');
    const frame = new Frame();
    for (const [key, value] of Object.entries(input)) frame.define(key, value);
    try {
      await this.#block(state, name, flow.steps, frame);
      return null;
    } catch (error) {
      if (error instanceof Returned) return error.value;
      throw error;
    }
  }

  /** Run a list of steps. `base` is where the list is in the flow, so that a finding says which step it comes from. */
  async #block(state: State, flow: string, steps: readonly FlowStep[], outer: Frame, base = 'steps'): Promise<void> {
    const frame = new Frame(outer);
    for (const [index, step] of steps.entries()) await this.#step(state, flow, step, frame, `${base}[${index}]`);
  }

  async #step(state: State, flow: string, step: FlowStep, frame: Frame, at: string): Promise<void> {
    if (++state.steps > MAX_RUN_STEPS) throw unprocessable('flow_too_long', `A flow ran more than ${MAX_RUN_STEPS} steps: check its loops`);
    const { tx, loaded, caller } = state;
    const label = loaded.definition.flows![flow]!.label;
    const value = (expression: Expression): ExpressionValue => {
      const worked = evaluateExpression(expression, { record: {}, principal: caller.principal, now: state.now, vars: frame.all() });
      if (!worked.ok) throw unprocessable('flow_failed', `${label}: ${worked.message}`);
      return worked.value;
    };
    /** A value; or, for a bare variable, the record or the list it holds. */
    const item = (expression: Expression): unknown => {
      if (isObject(expression) && 'ref' in expression && typeof expression.ref === 'string' && !expression.ref.includes('.')) {
        const held = frame.get(expression.ref);
        if (Array.isArray(held) || isObject(held)) return held;
      }
      return value(expression);
    };
    const holds = (condition: Condition) => evaluateCondition(condition, { ...present(frame.all()), principal: caller.principal, [CLOCK]: state.now });
    /** What a flow before its action saves may not do: anything but change the record that the action saves. */
    const shaping = state.draft;
    const refuse = (what: string) =>
      unprocessable('flow_failed', `${label}: it runs before ${shaping?.action ?? 'its action'} saves, so it ${what}`);
    const values = (given: Readonly<Record<string, Expression>>) => Object.fromEntries(Object.entries(given).map(([field, expression]) => [field, value(expression)]));
    /** A value as words: for what a notice says, and where a call goes. */
    const words = (expression: Expression | undefined) => {
      const worked = expression === undefined ? null : value(expression);
      return worked === null || worked === undefined ? '' : Array.isArray(worked) ? worked.join(', ') : String(worked);
    };
    const record = (name: string): FlowRecord & { readonly [ENTITY]: string } => {
      const held = frame.get(name);
      if (!isObject(held) || typeof (held as FlowRecord)[ENTITY] !== 'string') throw unprocessable('flow_failed', `${label}: ${name} holds no record`);
      return held as FlowRecord & { readonly [ENTITY]: string };
    };

    switch (step.type) {
      case 'set':
        frame.set(step.var, value(step.value));
        return;
      case 'find': {
        // What the condition says of the flow's variables is known now; what it says of the records goes to the database.
        const residual = step.where ? partialEvaluate(step.where, { ...present(frame.all()), principal: caller.principal, [CLOCK]: state.now }, ['record']) : true;
        const found = residual === false ? [] : await this.#runtime.flowFind(tx, loaded, step.entity, residual === true ? undefined : residual, step.sort ?? [], step.first ? 1 : step.limit);
        const tagged = found.map((each) => tag(each, step.entity));
        frame.set(step.var, step.first ? (tagged[0] ?? null) : tagged);
        return;
      }
      case 'create': {
        if (shaping) throw refuse('creates no records');
        const created = await this.#runtime.flowCreate(tx, loaded, caller.writer, caller.principal, step.entity, values(step.values));
        state.writes.created++;
        if (step.var) frame.set(step.var, tag(created, step.entity));
        return;
      }
      case 'change': {
        const held = record(step.record);
        if (shaping) {
          // Only the flow the action runs changes its record: a flow it calls doesn't see the change.
          if (!isDrafted(held) || state.depth > 0) throw refuse('changes only the record it saves');
          const issues = shaping.draft.change(values(step.values), label);
          if (issues.length) throw unprocessable('invalid_values', 'A step works out a value that its field cannot hold', { issues });
          frame.set(step.record, drafted(shaping.draft, held[ENTITY]));
          return;
        }
        const changed = await this.#runtime.flowChange(tx, loaded, caller.writer, caller.principal, held[ENTITY], String(held['id']), values(step.values));
        state.writes.changed++;
        frame.set(step.record, tag(changed, held[ENTITY]));
        return;
      }
      case 'add_line': {
        const held = record(step.record);
        if (shaping) {
          if (!isDrafted(held) || state.depth > 0) throw refuse('changes only the record it saves');
          const issues = shaping.draft.addLine(step.field, values(step.values), label);
          if (issues.length) throw unprocessable('invalid_values', 'A step works out a value that its field cannot hold', { issues });
          frame.set(step.record, drafted(shaping.draft, held[ENTITY]));
          return;
        }
        const changed = await this.#runtime.flowChange(tx, loaded, caller.writer, caller.principal, held[ENTITY], String(held['id']), {}, { field: step.field, values: values(step.values) });
        state.writes.changed++;
        frame.set(step.record, tag(changed, held[ENTITY]));
        return;
      }
      case 'delete': {
        if (shaping) throw refuse('deletes no records');
        const held = record(step.record);
        // A person, or a process with the app's authority, deletes; a token never does (design §5.7).
        if (caller.auth) requirePerson(caller.auth, 'data.delete');
        await this.#runtime.flowDelete(tx, loaded, caller.writer, held[ENTITY], String(held['id']));
        state.writes.deleted++;
        frame.set(step.record, null);
        return;
      }
      case 'each': {
        for (const entry of await this.#list(state, flow, step.in, frame)) {
          const inner = new Frame(frame);
          inner.define(step.as, entry);
          await this.#block(state, flow, step.steps, inner, `${at}.steps`);
        }
        return;
      }
      case 'if': {
        const side = holds(step.when) ? 'then' : 'else';
        await this.#block(state, flow, step[side], frame, `${at}.${side}`);
        return;
      }
      case 'inform': {
        if (shaping) throw refuse('tells nobody: tell people in a flow that runs after it saves');
        const people = new Set<string>();
        for (const recipient of step.to) {
          if ('role' in recipient) for (const holder of await roleHolders(tx.db, loaded.app.id, loaded.env.id, recipient.role, state.now)) people.add(holder);
          else {
            const person = value(recipient.person);
            if (typeof person === 'string' && person) people.add(person);
          }
        }
        const about = step.about ? record(step.about) : undefined;
        const sent = await this.#notices.send(
          tx.db,
          {
            appId: loaded.app.id,
            environmentId: loaded.env.id,
            kind: 'inform',
            title: words(step.title),
            message: words(step.message),
            about: about ? { entity: about[ENTITY], recordId: String(about['id']), label: recordLabel(loaded.definition.entities[about[ENTITY]] ?? { label: about[ENTITY], fields: [] }, about) } : null,
            to: [...people],
            email: step.email,
          },
          state.now,
        );
        state.told.people += sent.told.length;
        state.told.left += sent.left.length;
        if (step.teams !== undefined) {
          const base = this.#ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '');
          const link = about ? `${base}/studio/apps/${loaded.app.id}/${about[ENTITY]}/${String(about['id'])}` : null;
          await this.#services.queuePost(tx.db, loaded, step.teams, { title: words(step.title) || 'A notice', message: words(step.message) || null, link }, state.now);
        }
        return;
      }
      case 'call_service': {
        const connection = loaded.definition.connections?.[step.connection];
        if (connection?.kind !== 'service') throw unprocessable('flow_failed', `${label}: no service named ${step.connection}`);
        if (shaping && step.method !== 'GET') throw refuse(`only reads from services, and a ${step.method} changes something there`);
        // What a call changes elsewhere can't be undone with a try: a try reads, and says what it didn't do.
        if (caller.dryRun && step.method !== 'GET') {
          state.findings.push({ flow, message: `Trying it didn't call ${connection.label}: a ${step.method} changes something there for real` });
          for (const name of Object.keys(step.results)) frame.set(name, null);
          return;
        }
        const answer = await this.#services.call(
          loaded,
          step.connection,
          { method: step.method, path: words(step.path), query: values(step.query), ...(step.body ? { body: values(step.body) } : {}) },
          caller.writer.scope(this.#ctx.now()),
        );
        for (const [name, result] of Object.entries(step.results)) frame.set(name, asKind(valueAt(answer, result.from), result.type));
        return;
      }
      case 'repeat':
        // Checked before each time, on the variables as the last time left them.
        for (let times = 0; times < step.max && holds(step.while); times++) await this.#block(state, flow, step.steps, frame, `${at}.steps`);
        return;
      case 'check': {
        if (holds(step.assert)) return;
        // A form marks the fields of the record its action saves that the message is about.
        const fields = (step.fields ?? []).flatMap((ref) => {
          const [root, field] = ref.split('.');
          return field && isDrafted(frame.get(root!)) ? [field] : [];
        });
        if (step.severity === 'warning') {
          state.findings.push({ flow, message: step.message, at, fields });
          return;
        }
        throw unprocessable('rule_failed', step.message, { findings: [{ rule: `flows.${flow}.${at}`, severity: 'error', message: step.message, fields }] });
      }
      case 'call': {
        const input = Object.fromEntries(Object.entries(step.input).map(([name, expression]) => [name, item(expression)]));
        if (state.depth >= MAX_CALL_DEPTH) throw unprocessable('flow_too_deep', `Flows call one another more than ${MAX_CALL_DEPTH} deep`);
        state.depth++;
        try {
          const output = await this.#flow(state, step.flow, input);
          if (step.var) frame.set(step.var, output);
        } finally {
          state.depth--;
        }
        return;
      }
      case 'try': {
        // A savepoint, so that a failure can undo the steps it covers without ending the transaction.
        const savepoint = `flow_try_${++state.savepoints}`;
        const writes = { ...state.writes };
        // The record an action saves is undone in memory, as the database undoes the rest.
        const shaped = shaping?.draft.snapshot();
        await tx.platformQuery(`savepoint ${savepoint}`);
        try {
          await this.#block(state, flow, step.steps, frame, `${at}.steps`);
          await tx.platformQuery(`release savepoint ${savepoint}`);
        } catch (error) {
          if (!catchable(error)) throw error;
          if (step.rollback || DATABASE_ERRORS.has(error.code)) {
            await tx.platformQuery(`rollback to savepoint ${savepoint}`);
            Object.assign(state.writes, writes);
            if (shaping && shaped) {
              shaping.draft.restore(shaped);
              for (const [name, held] of Object.entries(frame.all())) if (isDrafted(held)) frame.set(name, drafted(shaping.draft, shaping.entity));
            }
          }
          await tx.platformQuery(`release savepoint ${savepoint}`);
          const handler = new Frame(frame);
          if (step.error) handler.define(step.error, error.message);
          await this.#block(state, flow, step.catch, handler, `${at}.catch`);
        }
        return;
      }
      case 'total': {
        const list = await this.#list(state, flow, step.of, frame);
        if (step.op === 'count') return frame.set(step.var, list.length);
        const numbers = list.flatMap((entry) => {
          const raw = isObject(entry) ? entry[step.field!] : undefined;
          return typeof raw === 'number' && Number.isFinite(raw) ? [raw] : [];
        });
        const sum = numbers.reduce((total, n) => total + n, 0);
        const result =
          step.op === 'sum'
            ? roundTo(sum, 6)
            : !numbers.length
              ? null
              : step.op === 'avg'
                ? roundTo(sum / numbers.length, 6)
                : step.op === 'min'
                  ? Math.min(...numbers)
                  : Math.max(...numbers);
        frame.set(step.var, result);
        return;
      }
      case 'return':
        throw new Returned(step.value === undefined ? null : item(step.value));
    }
  }

  /** A list to loop over or total: a list variable, or the lines of a record that a variable holds. */
  async #list(state: State, flow: string, of: string, frame: Frame): Promise<readonly unknown[]> {
    const [root, lines] = of.split('.') as [string, string | undefined];
    const held = frame.get(root);
    if (!lines) {
      if (Array.isArray(held)) return held;
      throw unprocessable('flow_failed', `${state.loaded.definition.flows![flow]!.label}: ${root} holds no list`);
    }
    const entity = isObject(held) ? (held as FlowRecord)[ENTITY] : undefined;
    if (!isObject(held) || !entity) throw unprocessable('flow_failed', `${state.loaded.definition.flows![flow]!.label}: ${root} holds no record`);
    // The lines of the record an action saves are those it has now, with the lines added since.
    if (isDrafted(held) && state.draft) return (state.draft.draft.lines[lines] ?? []).map((line) => ({ ...line.values, id: line.id }));
    return this.#runtime.flowLines(state.tx, state.loaded, entity, String(held['id']), lines);
  }
}

/** A flow's writes, in the name of what started it, with the flow in the audit context. */
export function flowWriter(base: Writer, flow: string): Writer {
  const run = uuidv7(Date.now());
  return {
    ...base,
    scope: (now) => {
      const scope = base.scope(now);
      return { ...scope, context: { ...scope.context, flow, flowRun: run } };
    },
  };
}
