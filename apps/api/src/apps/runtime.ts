import { canonicalJson, sha256Hex, uuidv7 } from '@platform/audit';
import { conditionRefs, evaluateCondition, partialEvaluate, type Condition, type Policy, type QueryGrant } from '@platform/authz';
import {
  buildCard,
  canonicalValue,
  checkActionInput,
  checkInput,
  completeLines,
  conditionRecord,
  cursorOf,
  deleteRecord,
  diffLines,
  diffRecords,
  entityFields,
  evaluateRules,
  excludedBy,
  fieldAccess,
  grantsFor,
  insertHistory,
  insertRecord,
  linesFieldsOf,
  linesWritten,
  parseLines,
  parseRecord,
  Provenance,
  recordValues,
  rollupValues,
  selectHistory,
  selectLines,
  selectRecords,
  updateRecord,
  writeGrant,
  writeLines,
  type CardData,
  type FieldValue,
  type Finding,
  type HistoryChange,
  type LineInput,
  type LinesChange,
  type LineValues,
  type RecordValues,
  type StoredEntity,
  type StoredLine,
  type StoredLinesField,
  type StoredRecord,
  type ValueIssue,
  type ValueKind,
} from '@platform/app-model';
import { proposals, users } from '@platform/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { checkQuery, principalEnv } from '../access/check.js';
import type { AllowedQuery } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import type { LoadedApp } from './catalog.js';
import { capabilityResource, recordResource } from './resources.js';
import { pgError } from './pg-errors.js';
import { withAppTransaction, type AppTransaction } from './transaction.js';

/** A line as the API returns it: its ID, and the values of the fields of it the caller may see. */
export type LineOut = { readonly id: string } & Readonly<Record<string, FieldValue>>;

/**
 * A record as the API returns it. Fields the caller can't see are left out; masked ones are
 * listed, fields of lines as `lines.amount`. A lines field's value is its lines, in order.
 */
export interface RecordOut {
  readonly id: string;
  readonly version: number;
  readonly owner: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly values: Record<string, FieldValue | LineOut[]>;
  readonly masked: string[];
}

/** Lines read for some records: by lines field, then by record ID. */
type LinesRead = ReadonlyMap<string, ReadonlyMap<string, readonly StoredLine[]>>;

export interface Page {
  readonly records: RecordOut[];
  readonly nextCursor: string | null;
}

/** How a record's lines changed, as the caller may see it: fields by name, masked ones listed. */
export interface LinesChangeOut {
  readonly added: Array<{ id: string; values: Record<string, FieldValue>; masked?: string[]; sources?: Record<string, unknown> }>;
  readonly removed: Array<{ id: string; values: Record<string, FieldValue>; masked?: string[] }>;
  readonly changed: Array<{ id: string; changes: Array<{ field: string; before?: FieldValue; after?: FieldValue; masked?: true; source?: unknown }> }>;
  readonly reordered: boolean;
}

/** One field's change in a record's history, as the caller may see it. */
export type HistoryChangeOut =
  | { readonly field: string; readonly before: FieldValue; readonly after: FieldValue; readonly source?: unknown }
  | { readonly field: string; readonly lines: LinesChangeOut }
  | { readonly field: string; readonly masked: true }
  | { readonly field: string; readonly removed: true };

export type ActionResult =
  | { readonly status: 'done'; readonly record: RecordOut | { readonly id: string; readonly version: number } }
  | { readonly status: 'needs_confirmation'; readonly proposal: ProposalOut; readonly card: CardData }
  | { readonly status: 'preview'; readonly needsConfirmation: boolean; readonly findings: Finding[]; readonly card: CardData };

export type ProposalRow = typeof proposals.$inferSelect;

export interface ProposalOut {
  readonly id: string;
  readonly appId: string;
  readonly action: string;
  readonly status: ProposalRow['status'];
  readonly digest: string;
  readonly recordId: string | null;
  readonly expiresAt: string;
  readonly reviewUrl: string;
  readonly card: CardData;
  readonly findings: Finding[];
  readonly resultRecordId: string | null;
  readonly revises: string | null;
}

const ProvenanceMap = z.record(z.string(), Provenance);

/** A line as callers send it and proposals keep it: its ID, if it has one, and its values. */
type LineWire = Readonly<Record<string, FieldValue>> & { readonly id?: string };

interface SealedEffect {
  /** The action's inputs as the caller gave them, canonical, lines with their IDs. Kept so a person can revise them. */
  readonly input: Record<string, FieldValue | LineWire[]>;
  /** Exactly what the action writes: every value for a create, the changed ones for an update. */
  readonly values: Record<string, FieldValue>;
  /** The lines it writes, complete, by lines field. New lines have their IDs already, so a revision can follow them. */
  readonly lines?: Record<string, StoredLine[]>;
}

const toWire = (lines: readonly LineValues[]): LineWire[] => lines.map((line) => ({ ...line.values, ...(line.id ? { id: line.id } : {}) }));

function decodeCursor(cursor: string, kinds: readonly ValueKind[]): FieldValue[] {
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid_cursor', 'The cursor is not valid');
  }
  const valid = (kind: ValueKind, value: unknown): boolean => {
    if (value === null) return true;
    switch (kind) {
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'uuid':
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
      case 'date':
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
      case 'datetime':
        return typeof value === 'string' && !Number.isNaN(Date.parse(value));
      case 'text':
        return typeof value === 'string' && !value.includes('\u0000');
      case 'text[]':
        return false;
    }
  };
  if (!Array.isArray(values) || values.length !== kinds.length || !values.every((v, i) => valid(kinds[i]!, v))) {
    throw badRequest('invalid_cursor', 'The cursor does not belong to this list');
  }
  return values as FieldValue[];
}

const encodeCursor = (values: readonly FieldValue[]) => Buffer.from(JSON.stringify(values)).toString('base64url');


/**
 * The runtime of the built-in store: records, queries, actions and proposals (design §6).
 * Every path checks the caller's permissions with the policy engine, runs the entity's rules on
 * the server, and writes the change, its history and its audit event in one transaction.
 */
export class AppRuntime {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** The platform's policy with this app's own roles. */
  async policy(loaded: LoadedApp): Promise<Policy> {
    return this.#ctx.apps.policyFor(await this.#ctx.policy.policy(), loaded.app.id, loaded.app.currentRevision, loaded.definition);
  }

  entity(loaded: LoadedApp, name: string): StoredEntity {
    const entity = loaded.definition.entities[name];
    if (!entity) throw notFound('Entity');
    return entity;
  }

  #names(loaded: LoadedApp) {
    return { schema: loaded.env.schemaName, role: loaded.env.dbRole };
  }

  #sameRevision(tx: AppTransaction, loaded: LoadedApp): void {
    if (tx.revision !== loaded.app.currentRevision) {
      throw conflict('definition_changed', 'The app changed while this request was running. Try again.');
    }
  }

  /**
   * Decide a record permission. `inside` marks a check made inside an action or a query the caller
   * was already allowed to run: a token's scopes decide which operations it may enter, and inside
   * one the person's own record permissions apply. So an agent scoped to `action.run` can submit a
   * claim through its action, but can't write records directly.
   */
  async decide(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    action: string,
    entity: string,
    options: { readonly inside?: boolean } = {},
  ): Promise<AllowedQuery> {
    const caller = options.inside ? { ...auth, principal: withoutScopes(auth) } : auth;
    return checkQuery(this.#ctx, request, caller, action, recordResource(this.#ctx.org.id, loaded, entity), { policy: await this.policy(loaded) });
  }

  /** The read grants of a decision, or none if reading isn't allowed at all. */
  async #readGrants(auth: AuthContext, loaded: LoadedApp, entity: string, inside = false): Promise<AllowedQuery | null> {
    const principal = inside ? withoutScopes(auth) : auth.principal;
    const decision = await this.#ctx.policy.query(principal, 'record.read', recordResource(this.#ctx.org.id, loaded, entity), { policy: await this.policy(loaded) });
    return decision.allowed ? (decision as AllowedQuery) : null;
  }

  /**
   * A record as the caller may see it, given the read grants that apply to it. Its lines come with
   * it if they were read, each showing only the fields of lines the grants show.
   */
  project(loaded: LoadedApp, entity: StoredEntity, record: StoredRecord, grants: readonly QueryGrant[], fields?: readonly string[], lines?: LinesRead): RecordOut {
    const values: Record<string, FieldValue | LineOut[]> = {};
    const masked: string[] = [];
    const held = grants.map((grant) => grant.grant);
    for (const field of entity.fields) {
      if (fields && !fields.includes(field.name)) continue;
      const access = fieldAccess(held, field.name);
      if (field.type === 'lines') {
        const stored = lines?.get(field.name);
        if (access === 'masked') masked.push(field.name);
        if (access !== 'full' || !stored) continue;
        const lineFields = loaded.definition.entities[field.entity]!.fields;
        const shown = lineFields.filter((f) => fieldAccess(held, `${field.name}.${f.name}`) === 'full');
        masked.push(...lineFields.filter((f) => fieldAccess(held, `${field.name}.${f.name}`) === 'masked').map((f) => `${field.name}.${f.name}`));
        values[field.name] = (stored.get(record.id) ?? []).map((line) => ({ id: line.id, ...Object.fromEntries(shown.map((f) => [f.name, line.values[f.name] ?? null])) }));
        continue;
      }
      if (access === 'full') values[field.name] = record.values[field.name] ?? null;
      else if (access === 'masked') masked.push(field.name);
    }
    const { id, version, owner, createdAt, createdBy, updatedAt, updatedBy } = record;
    return { id, version, owner, createdAt, createdBy, updatedAt, updatedBy, values, masked };
  }

  /** The lines of some records, by lines field and record, read in the transaction given. */
  async #readLines(tx: AppTransaction, loaded: LoadedApp, parentIds: readonly string[], fields: readonly StoredLinesField[]): Promise<Map<string, Map<string, StoredLine[]>>> {
    const read = new Map<string, Map<string, StoredLine[]>>();
    if (!parentIds.length) return read;
    for (const field of fields) {
      const lineEntity = loaded.definition.entities[field.entity]!;
      const query = selectLines(this.#names(loaded), lineEntity, parentIds);
      read.set(field.name, parseLines(lineEntity, (await tx.query(query.text, query.values)).rows));
    }
    return read;
  }

  /** Fields may only steer a list when every applicable grant shows them in full: otherwise their order or a filter would leak them. */
  #requireVisible(decision: AllowedQuery, names: Iterable<string>, what: string): void {
    for (const name of names) {
      if (['id', 'version', 'owner', 'created_at', 'created_by', 'updated_at', 'updated_by'].includes(name)) continue;
      if (!decision.grants.every((grant) => fieldAccess([grant.grant], name) === 'full')) {
        throw forbidden('hidden_field', `You can't ${what} ${name}, because some of these records hide it from you`);
      }
    }
  }

  async list(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    entityName: string,
    options: {
      readonly decision?: AllowedQuery;
      readonly where?: true | Condition;
      readonly fields?: readonly string[];
      readonly sort?: ReadonlyArray<{ readonly field: string; readonly direction: 'asc' | 'desc' }>;
      readonly cursor?: string;
      readonly limit: number;
      readonly id?: string;
    },
  ): Promise<Page> {
    const entity = this.entity(loaded, entityName);
    const decision = options.decision ?? (await this.decide(request, auth, loaded, 'record.read', entityName));
    const fields = entityFields(entity);
    for (const sort of options.sort ?? []) {
      const info = fields.get(sort.field);
      if (!info || info.kind === 'text[]') throw badRequest('invalid_sort', `Can't sort by ${sort.field}`);
    }
    this.#requireVisible(decision, (options.sort ?? []).map((s) => s.field), 'sort by');
    if (options.where && options.where !== true) {
      this.#requireVisible(decision, conditionRefs(options.where).map((ref) => ref.slice('record.'.length)), 'filter on');
    }
    const base = {
      names: this.#names(loaded),
      entity,
      fields: options.fields ?? entity.fields.map((f) => f.name),
      grants: decision.grants.map((grant) => grant.filter),
      exclude: decision.exclude.map((exclusion) => exclusion.when),
      where: options.where !== undefined ? [options.where] : [],
      ...(options.sort ? { sort: options.sort } : {}),
      ...(options.id ? { id: options.id } : {}),
      limit: options.limit + 1,
    };
    const shape = selectRecords(base);
    const after = options.cursor ? decodeCursor(options.cursor, shape.sortKeys.map((key) => key.info.kind)) : undefined;
    const query = after ? selectRecords({ ...base, after }) : shape;
    // Lines are read with their records, in the same snapshot, when anyone here may see them.
    const linesWanted = linesFieldsOf(entity).filter(
      (field) => (!options.fields || options.fields.includes(field.name)) && decision.grants.some((grant) => fieldAccess([grant.grant], field.name) === 'full'),
    );
    const { rows, lines } = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      const rows = (await tx.query(query.text, query.values)).rows.slice(0, options.limit + 1);
      const ids = rows.slice(0, options.limit).map((row) => row['id'] as string);
      return { rows, lines: await this.#readLines(tx, loaded, ids, linesWanted) };
    });
    const parsed = rows.slice(0, options.limit).map((row) => parseRecord(entity, row, query.flagGrants.length));
    const records = parsed.map(({ record, flags }) => {
      const applicable = decision.grants.filter((grant, index) => {
        const flag = query.flagGrants.indexOf(index);
        return flag === -1 ? grant.filter === true : flags[flag];
      });
      return this.project(loaded, entity, record, applicable, options.fields, lines);
    });
    const last = parsed.at(-1)?.record;
    return { records, nextCursor: rows.length > options.limit && last ? encodeCursor(cursorOf(last, query.sortKeys)) : null };
  }

  async get(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, entityName: string, id: string, decision?: AllowedQuery): Promise<RecordOut> {
    const page = await this.list(request, auth, loaded, entityName, { ...(decision ? { decision } : {}), id, limit: 1 });
    const record = page.records[0];
    if (!record) throw notFound('Record');
    return record;
  }

  /** Lock a record for a write, before any permission is applied. Never returned as it is. */
  async #lock(tx: AppTransaction, loaded: LoadedApp, entity: StoredEntity, id: string): Promise<StoredRecord | null> {
    const query = selectRecords({ names: this.#names(loaded), entity, fields: entity.fields.map((f) => f.name), grants: [true], id, forUpdate: true });
    const row = (await tx.query(query.text, query.values)).rows[0];
    return row ? parseRecord(entity, row).record : null;
  }

  async #checkPeople(loaded: LoadedApp, entity: StoredEntity, values: RecordValues, explicitOwner: boolean, lines: Readonly<Record<string, readonly LineValues[]>> = {}): Promise<void> {
    const ids = new Set<string>();
    for (const field of entity.fields) {
      const value = values[field.name];
      if (field.type === 'user' && typeof value === 'string') ids.add(value);
      if (field.type !== 'lines') continue;
      const people = loaded.definition.entities[field.entity]!.fields.filter((f) => f.type === 'user');
      for (const line of lines[field.name] ?? []) {
        for (const person of people) {
          const id = line.values[person.name];
          if (typeof id === 'string') ids.add(id);
        }
      }
    }
    if (explicitOwner && typeof values['owner'] === 'string') ids.add(values['owner']);
    if (ids.size === 0) return;
    const found = await this.#ctx.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, this.#ctx.org.id), eq(users.status, 'active'), inArray(users.id, [...ids])));
    const missing = [...ids].filter((id) => !found.some((row) => row.id === id));
    if (missing.length) throw unprocessable('unknown_user', 'Some people named in the record are not active users', { missing });
  }

  #blockedBy(decision: AllowedQuery, ...records: RecordValues[]): void {
    for (const values of records) {
      const exclusion = excludedBy(decision.exclude, values);
      if (!exclusion) continue;
      throw forbidden(exclusion.effect === 'step_up' ? 'step_up_required' : 'denied_by_guardrail', exclusion.name, { guardrailId: exclusion.guardrailId });
    }
  }

  #rules(loaded: LoadedApp, entityName: string, auth: AuthContext, values: RecordValues, lines: Readonly<Record<string, readonly LineValues[]>> = {}): Finding[] {
    const findings = evaluateRules(loaded.definition, entityName, values, { principal: principalEnv(auth) }, lines);
    const errors = findings.filter((finding) => finding.severity === 'error');
    if (errors.length) throw unprocessable('rule_failed', errors.map((e) => e.message).join('; '), { findings });
    return findings;
  }

  /**
   * The lines a write leaves a record with: what the caller sent, completed against the lines the
   * record has (`base`); the rollups worked out from them; the fields of lines the write changes
   * compared with `current`, for the permission check; and which lines fields change at all.
   * With `all`, every lines field is completed, as for a new record.
   */
  prepareLinesFor(
    loaded: LoadedApp,
    entityName: string,
    input: Readonly<Record<string, readonly LineInput[]>>,
    base: Readonly<Record<string, readonly LineValues[]>>,
    current: Readonly<Record<string, readonly StoredLine[]>>,
    all: boolean,
  ): { lines: Record<string, LineValues[]>; rollups: Record<string, FieldValue>; paths: string[]; changed: string[] } {
    const entity = this.entity(loaded, entityName);
    const lines: Record<string, LineValues[]> = {};
    const issues: ValueIssue[] = [];
    const paths: string[] = [];
    const changed: string[] = [];
    for (const field of linesFieldsOf(entity)) {
      if (!(field.name in input) && !all) continue;
      const lineEntity = loaded.definition.entities[field.entity]!;
      const result = completeLines(lineEntity, field, input[field.name] ?? [], base[field.name] ?? []);
      issues.push(...result.issues);
      lines[field.name] = result.lines;
      const written = linesWritten(lineEntity, field.name, current[field.name] ?? [], result.lines);
      paths.push(...written);
      if (written.length) changed.push(field.name);
    }
    if (issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues });
    const rollups = rollupValues(loaded.definition, entityName, lines);
    if (rollups.issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues: rollups.issues });
    return { lines, rollups: rollups.values, paths, changed };
  }

  /** A record's lines now, for the lines fields named, read under the record's lock. */
  async #currentLines(tx: AppTransaction, loaded: LoadedApp, entity: StoredEntity, id: string, names: readonly string[]): Promise<Record<string, StoredLine[]>> {
    const fields = linesFieldsOf(entity).filter((field) => names.includes(field.name));
    const read = await this.#readLines(tx, loaded, [id], fields);
    return Object.fromEntries(fields.map((field) => [field.name, read.get(field.name)?.get(id) ?? []]));
  }

  async #writeRecord(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    tx: AppTransaction,
    write: {
      readonly entityName: string;
      readonly operation: 'create' | 'update' | 'delete';
      readonly before: StoredRecord | null;
      readonly values: RecordValues;
      readonly owner?: string;
      readonly provenance?: Readonly<Record<string, Provenance>>;
      readonly reason?: Record<string, unknown>;
      /** The lines fields this write changes: the lines each will have, and the lines it has now. */
      readonly lines?: Readonly<Record<string, { readonly next: readonly LineValues[]; readonly current: readonly StoredLine[] }>>;
    },
  ): Promise<StoredRecord | null> {
    const ctx = this.#ctx;
    const entity = this.entity(loaded, write.entityName);
    const names = this.#names(loaded);
    const now = ctx.now();
    const at = now.toISOString();
    let after: StoredRecord | null = null;
    try {
      if (write.operation === 'create') {
        const query = insertRecord(names, entity, { id: uuidv7(now.getTime()), owner: write.owner ?? auth.actor.id, actor: auth.actor.id, at, values: write.values });
        after = parseRecord(entity, (await tx.query(query.text, query.values)).rows[0]!).record;
      } else if (write.operation === 'update') {
        const query = updateRecord(names, entity, { id: write.before!.id, actor: auth.actor.id, at, values: write.values });
        after = parseRecord(entity, (await tx.query(query.text, query.values)).rows[0]!).record;
      } else {
        const query = deleteRecord(names, entity, write.before!.id);
        await tx.query(query.text, query.values);
      }
    } catch (error) {
      const { code } = pgError(error);
      if (code === '23505') throw conflict('duplicate_value', 'Another record already has that value in a unique field');
      if (code === '23503') {
        throw write.operation === 'delete'
          ? conflict('record_referenced', 'Other records still refer to this one')
          : unprocessable('unknown_reference', 'A reference points at a record that does not exist');
      }
      throw error;
    }
    const before = write.before ? recordValues(write.before) : null;
    const changes: Record<string, HistoryChange> = diffRecords(entity, before, after ? recordValues(after) : null, write.provenance ?? {});
    const record = (after ?? write.before)!;
    for (const [name, { next, current }] of Object.entries(write.lines ?? {})) {
      const field = entity.fields.find((f): f is StoredLinesField => f.name === name && f.type === 'lines')!;
      const lineEntity = loaded.definition.entities[field.entity]!;
      // New lines get their IDs now, unless a proposal gave them theirs already.
      const lines = next.map((line) => ({ id: line.id ?? uuidv7(now.getTime()), values: line.values }));
      // A deleted record's lines went with it; its history still says which they were.
      if (write.operation !== 'delete') {
        for (const statement of writeLines(names, lineEntity, record.id, current, lines)) await tx.query(statement.text, statement.values);
      }
      const change = diffLines(lineEntity, current, lines, lineSources(write.provenance, name));
      if (change) changes[field.id] = { name, lines: change };
    }
    const event = await recordAudit(tx.db, auditScopeFor(request, ctx.org.id, now), {
      action: `record.${write.operation}`,
      target: { type: 'record', id: record.id, name: write.entityName },
      spaceId: loaded.space.id,
      appId: loaded.app.id,
      env: loaded.env.kind,
      // Values stay in the app's own history, under the app's permissions. The audit log records which fields changed.
      changes: { fields: Object.values(changes).map((change) => change.name) },
      ...(write.reason ? { reason: write.reason } : {}),
    });
    if (entity.history) {
      const history = insertHistory(names, {
        id: uuidv7(now.getTime()),
        entityId: entity.id,
        recordId: record.id,
        version: after?.version ?? write.before!.version,
        operation: write.operation,
        changes,
        actorType: auth.agent ? 'service_account' : auth.actor.type,
        actorId: auth.agent?.id ?? auth.actor.id,
        onBehalfOf: auth.agent ? auth.actor.id : null,
        via: event.actor.via ?? 'api',
        at,
        auditEventId: event.id,
      });
      await tx.query(history.text, history.values);
    }
    return after;
  }

  async #respond(auth: AuthContext, loaded: LoadedApp, entityName: string, record: StoredRecord, inside = false): Promise<RecordOut | { id: string; version: number }> {
    const read = await this.#readGrants(auth, loaded, entityName, inside);
    const grants = read ? grantsFor(read.grants, recordValues(record)) : [];
    if (!grants.length) return { id: record.id, version: record.version };
    const entity = this.entity(loaded, entityName);
    const wanted = linesFieldsOf(entity).filter((field) => fieldAccess(grants.map((g) => g.grant), field.name) === 'full');
    const lines = wanted.length ? await withAppTransaction(this.#ctx.pool, loaded.env, 'records', (tx) => this.#readLines(tx, loaded, [record.id], wanted)) : undefined;
    return this.project(loaded, entity, record, grants, undefined, lines);
  }

  async create(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    entityName: string,
    input: { readonly values: Readonly<Record<string, unknown>>; readonly provenance?: unknown },
    decision?: AllowedQuery,
  ): Promise<RecordOut | { id: string; version: number }> {
    const entity = this.entity(loaded, entityName);
    const check = checkInput(loaded.definition, entityName, input.values, { mode: 'create' });
    if (check.issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues: check.issues });
    const provenance = this.#provenance(input.provenance, Object.keys(input.values), check.lines);
    const prepared = this.prepareLinesFor(loaded, entityName, check.lines, {}, {}, true);
    const permission = decision ?? (await this.decide(request, auth, loaded, 'record.create', entityName));
    const owner = (check.values['owner'] as string | undefined) ?? auth.actor.id;
    const values = { ...check.values, ...prepared.rollups };
    const after = { ...values, owner };
    const fields = [...Object.keys(input.values).filter((name) => !(name in check.lines)), ...prepared.paths];
    if (!writeGrant(permission.grants, { fields, after })) {
      throw forbidden('not_allowed', 'You may not create this record: a field or a value is outside what your role allows');
    }
    this.#blockedBy(permission, after);
    this.#rules(loaded, entityName, auth, after, prepared.lines);
    await this.#checkPeople(loaded, entity, after, 'owner' in input.values, prepared.lines);
    const record = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      const lines = Object.fromEntries(prepared.changed.map((name) => [name, { next: prepared.lines[name]!, current: [] }]));
      return (await this.#writeRecord(request, auth, loaded, tx, { entityName, operation: 'create', before: null, values, owner, provenance, lines }))!;
    });
    return this.#respond(auth, loaded, entityName, record);
  }

  async update(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    entityName: string,
    id: string,
    input: { readonly values: Readonly<Record<string, unknown>>; readonly version?: number; readonly provenance?: unknown },
    decision?: AllowedQuery,
  ): Promise<RecordOut | { id: string; version: number }> {
    const entity = this.entity(loaded, entityName);
    const check = checkInput(loaded.definition, entityName, input.values, { mode: 'update' });
    if (check.issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues: check.issues });
    const provenance = this.#provenance(input.provenance, Object.keys(input.values), check.lines);
    const permission = decision ?? (await this.decide(request, auth, loaded, 'record.update', entityName));
    const read = await this.#readGrants(auth, loaded, entityName);
    const record = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      const before = await this.#lock(tx, loaded, entity, id);
      if (!before) throw notFound('Record');
      // Lines change only under their record's lock, so these are the lines as they are.
      const current = await this.#currentLines(tx, loaded, entity, before.id, Object.keys(check.lines));
      const prepared = this.prepareLinesFor(loaded, entityName, check.lines, current, current, false);
      const beforeValues = recordValues(before);
      const changed = Object.fromEntries(
        Object.entries({ ...check.values, ...prepared.rollups }).filter(([name, value]) => JSON.stringify(beforeValues[name] ?? null) !== JSON.stringify(value)),
      );
      const afterValues = { ...beforeValues, ...changed };
      const fields = [...Object.keys(changed).filter((name) => !(name in prepared.rollups)), ...prepared.paths];
      if (!writeGrant(permission.grants, { fields, before: beforeValues, after: afterValues })) {
        const readable = read ? grantsFor(read.grants, beforeValues).length > 0 : false;
        if (!readable) throw notFound('Record');
        throw forbidden('not_allowed', 'You may not make this change: the record, a field or a value is outside what your role allows');
      }
      if (input.version !== undefined && input.version !== before.version) {
        throw conflict('version_conflict', `The record is at version ${before.version}, not ${input.version}. Reload it and try again.`);
      }
      this.#blockedBy(permission, beforeValues, afterValues);
      this.#rules(loaded, entityName, auth, afterValues, prepared.lines);
      if (Object.keys(changed).length === 0 && prepared.changed.length === 0) return before;
      const lines = Object.fromEntries(prepared.changed.map((name) => [name, { next: prepared.lines[name]!, current: current[name] ?? [] }]));
      await this.#checkPeople(loaded, entity, changed, 'owner' in changed, Object.fromEntries(prepared.changed.map((name) => [name, prepared.lines[name]!])));
      return (await this.#writeRecord(request, auth, loaded, tx, { entityName, operation: 'update', before, values: changed, provenance, lines }))!;
    });
    return this.#respond(auth, loaded, entityName, record);
  }

  async remove(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, entityName: string, id: string, decision?: AllowedQuery): Promise<void> {
    const entity = this.entity(loaded, entityName);
    const permission = decision ?? (await this.decide(request, auth, loaded, 'record.delete', entityName));
    const read = await this.#readGrants(auth, loaded, entityName);
    await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      const before = await this.#lock(tx, loaded, entity, id);
      if (!before) throw notFound('Record');
      const values = recordValues(before);
      const record = conditionRecord(values);
      if (!permission.grants.some((grant) => grant.filter === true || evaluateCondition(grant.filter, { record }))) {
        if (!(read && grantsFor(read.grants, values).length)) throw notFound('Record');
        throw forbidden('not_allowed', 'You may not delete this record');
      }
      this.#blockedBy(permission, values);
      const current = await this.#currentLines(tx, loaded, entity, before.id, linesFieldsOf(entity).map((f) => f.name));
      const lines = Object.fromEntries(Object.entries(current).filter(([, list]) => list.length).map(([name, list]) => [name, { next: [], current: list }]));
      await this.#writeRecord(request, auth, loaded, tx, { entityName, operation: 'delete', before, values: {}, lines });
    });
  }

  async history(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, entityName: string, id: string) {
    const entity = this.entity(loaded, entityName);
    const decision = await this.decide(request, auth, loaded, 'record.read', entityName);
    await this.get(request, auth, loaded, entityName, id, decision); // 404 unless the caller can read the record
    // Which grants apply is decided on the whole record, including fields the caller can't see.
    const stored = await this.#readBack(loaded, entity, id);
    if (!stored) throw notFound('Record');
    const read = grantsFor(decision.grants, recordValues(stored)).map((g) => g.grant);
    // Field access is decided on what the caller can see now: a field hidden today stays hidden in the past too.
    const query = selectHistory(this.#names(loaded), entity, id);
    const rows = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => (await tx.query(query.text, query.values)).rows);
    // Changes come in the entity's field order, then the owner, then fields deleted since.
    const position = (fieldId: string) => {
      const index = entity.fields.findIndex((f) => f.id === fieldId);
      return index >= 0 ? index : fieldId === 'owner' ? entity.fields.length : entity.fields.length + 1;
    };
    return rows.map((row) => {
      const changes = row['changes'] as Record<string, HistoryChange>;
      return {
        version: row['version'] as number,
        operation: row['operation'] as 'create' | 'update' | 'delete',
        at: row['occurred_at'] as string,
        actor: {
          type: row['actor_type'] as string,
          id: (row['actor_id'] as string | null) ?? null,
          // When an agent made the change: the person it acted for.
          onBehalfOf: (row['on_behalf_of'] as string | null) ?? null,
        },
        via: row['via'] as string,
        changes: Object.entries(changes)
          .sort(([a], [b]) => position(a) - position(b))
          .flatMap(([fieldId, change]): HistoryChangeOut[] => {
            if (fieldId === 'owner' && 'before' in change) return [{ field: 'owner', before: change.before, after: change.after }];
            const field = entity.fields.find((f) => f.id === fieldId);
            // A field deleted since, or one whose type changed between lines and a single value.
            if (!field || ('lines' in change) !== (field.type === 'lines')) return [{ field: change.name, removed: true }];
            const access = fieldAccess(read, field.name);
            if (access === 'hidden') return [];
            if (access === 'masked') return [{ field: field.name, masked: true }];
            if ('lines' in change) return [{ field: field.name, lines: this.#linesHistory(loaded, field as StoredLinesField, change.lines, read) }];
            return [{ field: field.name, before: change.before, after: change.after, ...(change.source ? { source: change.source } : {}) }];
          }),
      };
    });
  }

  /**
   * Where the values being set came from, by field; for a line's value, by its place in the lines
   * sent, as `lines[2].amount`. Only fields being set may have one.
   */
  /** A change to lines as the caller may see it: fields by today's names, those hidden from them left out, masked ones listed. */
  #linesHistory(loaded: LoadedApp, field: StoredLinesField, change: LinesChange, read: Parameters<typeof fieldAccess>[0]): LinesChangeOut {
    const fields = new Map(
      loaded.definition.entities[field.entity]!.fields.map((f) => [f.id, { name: f.name, access: fieldAccess(read, `${field.name}.${f.name}`) }]),
    );
    const shown = (byId: Readonly<Record<string, unknown>>) => {
      const values: Record<string, FieldValue> = {};
      const masked: string[] = [];
      for (const [id, value] of Object.entries(byId)) {
        const f = fields.get(id);
        if (f?.access === 'full') values[f.name] = value as FieldValue;
        else if (f?.access === 'masked') masked.push(f.name);
      }
      return { values, ...(masked.length ? { masked } : {}) };
    };
    const sources = (byId: Readonly<Record<string, unknown>> | undefined) => {
      const named = Object.fromEntries(Object.entries(byId ?? {}).flatMap(([id, source]) => (fields.get(id)?.access === 'full' ? [[fields.get(id)!.name, source]] : [])));
      return Object.keys(named).length ? { sources: named } : {};
    };
    return {
      added: change.added.map((line) => ({ id: line.id, ...shown(line.values), ...sources(line.sources) })),
      removed: change.removed.map((line) => ({ id: line.id, ...shown(line.values) })),
      changed: change.changed
        .map((line) => ({
          id: line.id,
          changes: Object.entries(line.changes).flatMap(([id, c]): LinesChangeOut['changed'][number]['changes'] => {
            const f = fields.get(id);
            if (!f || f.access === 'hidden') return [];
            return f.access === 'masked' ? [{ field: f.name, masked: true as const }] : [{ field: f.name, before: c.before, after: c.after, ...(c.source ? { source: c.source } : {}) }];
          }),
        }))
        .filter((line) => line.changes.length),
      reordered: change.reordered,
    };
  }

  #provenance(raw: unknown, allowed: readonly string[], lines: Readonly<Record<string, readonly unknown[]>> = {}): Record<string, Provenance> {
    if (raw === undefined || raw === null) return {};
    const parsed = ProvenanceMap.safeParse(raw);
    if (!parsed.success) throw unprocessable('invalid_provenance', 'Provenance must say, for each field, where its value came from');
    const unknown = Object.keys(parsed.data).filter((field) => {
      if (allowed.includes(field)) return false;
      const match = LINE_KEY.exec(field);
      return !(match && allowed.includes(match[1]!) && Number(match[2]) < (lines[match[1]!]?.length ?? 0));
    });
    if (unknown.length) throw unprocessable('invalid_provenance', `Provenance names fields that aren't being set: ${unknown.join(', ')}`);
    return parsed.data;
  }

  async runQuery(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    name: string,
    input: { readonly parameters: Readonly<Record<string, unknown>>; readonly cursor?: string; readonly limit?: number },
  ): Promise<Page> {
    const query = loaded.definition.queries[name];
    if (!query) throw notFound('Query');
    const parameters: Record<string, unknown> = {};
    const issues: string[] = [];
    for (const [param, spec] of Object.entries(query.parameters)) {
      const value = input.parameters[param];
      if (value === undefined || value === null) {
        if (spec.required) issues.push(`${param} is required`);
        continue;
      }
      const type = spec.type === 'text' ? 'string' : spec.type;
      if (typeof value !== type || (typeof value === 'number' && !Number.isFinite(value))) issues.push(`${param} must be ${spec.type}`);
      else parameters[param] = value;
    }
    const unknown = Object.keys(input.parameters).filter((param) => !(param in query.parameters));
    if (unknown.length) issues.push(`Unknown parameters: ${unknown.join(', ')}`);
    if (issues.length) throw unprocessable('invalid_parameters', issues.join('; '));

    const decision = await this.decide(request, auth, loaded, 'record.read', query.entity, { inside: true });
    const where = query.filter ? partialEvaluate(query.filter, { principal: principalEnv(auth), input: parameters, context: {} }, ['record']) : true;
    if (where === false) return { records: [], nextCursor: null };
    const userFields = query.fields.filter((field) => this.entity(loaded, query.entity).fields.some((f) => f.name === field));
    return this.list(request, auth, loaded, query.entity, {
      decision,
      where,
      fields: userFields,
      sort: query.sort,
      limit: Math.min(input.limit ?? query.limit, query.limit),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }

  /**
   * Run an action. A person in an interactive session commits it directly. An agent or script
   * (any API token) gets a proposal for anything above `none`, which only the person can approve
   * (design §6.3). A dry run checks everything and returns the card, changing nothing.
   */
  async runAction(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    name: string,
    input: {
      readonly values: Readonly<Record<string, unknown>>;
      readonly recordId?: string;
      readonly version?: number;
      readonly provenance?: unknown;
      readonly dryRun?: boolean;
    },
    options: { readonly revises?: ProposalRow } = {},
  ): Promise<ActionResult> {
    const ctx = this.#ctx;
    const action = loaded.definition.actions[name];
    if (!action) throw notFound('Action');
    const entity = this.entity(loaded, action.entity);
    const check = checkActionInput(loaded.definition, name, input.values);
    if (check.issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues: check.issues });
    const provenance = this.#provenance(input.provenance, action.input, check.lines);
    if (action.operation === 'update' && !input.recordId) throw unprocessable('record_required', `${name} changes an existing record: give its ID`);
    const permission = await this.decide(request, auth, loaded, action.operation === 'create' ? 'record.create' : 'record.update', action.entity, { inside: true });
    // Revising a proposal is the person's own edit: it waits for their approval again, through the same review.
    const needsConfirmation = action.confirm !== 'none' && (auth.credential.kind === 'token' || options.revises !== undefined);
    const written = [...new Set([...Object.keys(input.values), ...Object.keys(action.set)])];
    const scalarWritten = written.filter((field) => !(field in check.lines));
    const commit = !input.dryRun && !needsConfirmation;
    // A revision edits the proposal's lines, which may include new lines with the IDs it gave them.
    const proposed = (options.revises?.effect as unknown as SealedEffect | undefined)?.lines ?? {};

    return withAppTransaction(ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      let before: StoredRecord | null = null;
      let values: Record<string, FieldValue>;
      let after: Record<string, FieldValue>;
      let current: Record<string, StoredLine[]> = {};
      let prepared: ReturnType<AppRuntime['prepareLinesFor']>;
      if (action.operation === 'create') {
        prepared = this.prepareLinesFor(loaded, action.entity, check.lines, proposed, {}, true);
        values = { ...check.values, ...prepared.rollups };
        after = { ...values, owner: (check.values['owner'] as string | undefined) ?? auth.actor.id };
        if (!writeGrant(permission.grants, { fields: [...scalarWritten, ...prepared.paths], after })) {
          throw forbidden('not_allowed', `You may not ${action.label.toLowerCase()}: a field or a value is outside what your role allows`);
        }
      } else {
        before = await this.#lock(tx, loaded, entity, input.recordId!);
        if (!before) throw notFound('Record');
        current = await this.#currentLines(tx, loaded, entity, before.id, Object.keys(check.lines));
        prepared = this.prepareLinesFor(loaded, action.entity, check.lines, { ...current, ...proposed }, current, false);
        const beforeValues = recordValues(before);
        values = Object.fromEntries(
          Object.entries({ ...check.values, ...prepared.rollups }).filter(([field, value]) => JSON.stringify(beforeValues[field] ?? null) !== JSON.stringify(value)),
        );
        after = { ...beforeValues, ...values };
        if (!writeGrant(permission.grants, { fields: [...scalarWritten, ...prepared.paths], before: beforeValues, after })) {
          const read = await this.#readGrants(auth, loaded, action.entity, true);
          if (!(read && grantsFor(read.grants, beforeValues).length)) throw notFound('Record');
          throw forbidden('not_allowed', `You may not ${action.label.toLowerCase()} for this record`);
        }
        if (input.version !== undefined && input.version !== before.version) {
          throw conflict('version_conflict', `The record is at version ${before.version}, not ${input.version}. Reload it and try again.`);
        }
        if (action.where) {
          const where = partialEvaluate(action.where, { principal: principalEnv(auth), context: {} }, ['record']);
          const applies = typeof where === 'boolean' ? where : evaluateCondition(where, { record: conditionRecord(beforeValues) });
          if (!applies) throw conflict('action_not_applicable', `${action.label} doesn't apply to this record as it is now`);
        }
        this.#blockedBy(permission, beforeValues);
      }
      this.#blockedBy(permission, after);
      // A proposal gives new lines their IDs now, so the person's revisions can follow each line.
      const lines: Record<string, LineValues[]> = Object.fromEntries(
        Object.entries(prepared.lines).map(([field, list]) => [field, commit || input.dryRun ? list : list.map((line) => ({ id: line.id ?? uuidv7(ctx.now().getTime()), values: line.values }))]),
      );
      const findings = this.#rules(loaded, action.entity, auth, after, lines);
      await this.#checkPeople(loaded, entity, values, 'owner' in values, lines);
      const card = buildCard({
        definition: loaded.definition,
        entity: action.entity,
        ...(action.card ? { card: action.card } : {}),
        title: action.label,
        show: written,
        values: after,
        lines,
        findings,
        provenance,
      });
      if (input.dryRun) return { status: 'preview' as const, needsConfirmation, findings, card };
      if (!commit) {
        const sealedInput: SealedEffect['input'] = Object.fromEntries(
          Object.entries({ ...check.values, ...Object.fromEntries(Object.keys(check.lines).map((field) => [field, toWire(lines[field]!)])) }).filter(([field]) => action.input.includes(field)),
        );
        const sealedLines = Object.fromEntries(prepared.changed.map((field) => [field, lines[field]!.map((line) => ({ id: line.id!, values: line.values }))]));
        const proposal = await this.#propose(request, auth, loaded, tx, {
          action: name,
          recordId: before?.id ?? null,
          baseVersion: before?.version ?? null,
          effect: { input: sealedInput, values, ...(Object.keys(sealedLines).length ? { lines: sealedLines } : {}) },
          findings,
          provenance,
          card,
          ...(options.revises ? { revises: options.revises } : {}),
        });
        return { status: 'needs_confirmation' as const, proposal, card };
      }
      const record = await this.#writeRecord(request, auth, loaded, tx, {
        entityName: action.entity,
        operation: action.operation,
        before,
        values,
        ...(action.operation === 'create' ? { owner: after['owner'] as string } : {}),
        provenance,
        reason: { action: name },
        lines: Object.fromEntries(prepared.changed.map((field) => [field, { next: lines[field]!, current: current[field] ?? [] }])),
      });
      return { status: 'done' as const, record: { id: record!.id, version: record!.version } };
    }).then(async (result) => {
      if (result.status !== 'done') return result;
      // The response shows the record as the caller may read it, decided after the write.
      const stored = await this.#readBack(loaded, entity, result.record.id);
      return { status: 'done' as const, record: stored ? await this.#respond(auth, loaded, action.entity, stored, true) : result.record };
    });
  }

  async #readBack(loaded: LoadedApp, entity: StoredEntity, id: string): Promise<StoredRecord | null> {
    const query = selectRecords({ names: this.#names(loaded), entity, fields: entity.fields.map((f) => f.name), grants: [true], id });
    return withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      const row = (await tx.query(query.text, query.values)).rows[0];
      return row ? parseRecord(entity, row).record : null;
    });
  }

  #reviewUrl(id: string): string {
    return new URL(`/review/${id}`, this.#ctx.config.PUBLIC_BASE_URL).href;
  }

  toProposalOut(row: ProposalRow): ProposalOut {
    return {
      id: row.id,
      appId: row.appId,
      action: row.action,
      status: row.status,
      digest: row.digest,
      recordId: row.recordId,
      expiresAt: row.expiresAt.toISOString(),
      reviewUrl: this.#reviewUrl(row.id),
      card: row.card as unknown as CardData,
      findings: row.findings as unknown as Finding[],
      resultRecordId: row.resultRecordId,
      revises: row.revises,
    };
  }

  async #propose(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    tx: AppTransaction,
    proposal: {
      readonly action: string;
      readonly recordId: string | null;
      readonly baseVersion: number | null;
      readonly effect: SealedEffect;
      readonly findings: readonly Finding[];
      readonly provenance: Readonly<Record<string, Provenance>>;
      readonly card: CardData;
      readonly revises?: ProposalRow;
    },
  ): Promise<ProposalOut> {
    const ctx = this.#ctx;
    const now = ctx.now();
    const id = uuidv7(now.getTime());
    const onBehalfOf = proposal.revises?.onBehalfOf ?? auth.actor.id;
    if (auth.actor.type !== 'user' && !proposal.revises) {
      throw forbidden('person_required', 'Proposals are made for a person. Service accounts act for people from phase 3.');
    }
    const digest = sha256Hex(
      canonicalJson({
        appId: loaded.app.id,
        revision: loaded.app.currentRevision,
        action: proposal.action,
        recordId: proposal.recordId,
        baseVersion: proposal.baseVersion,
        values: proposal.effect.values,
        ...(proposal.effect.lines ? { lines: proposal.effect.lines } : {}),
        onBehalfOf,
      }),
    );
    const [row] = await tx.db
      .insert(proposals)
      .values({
        id,
        orgId: ctx.org.id,
        appId: loaded.app.id,
        environmentId: loaded.env.id,
        action: proposal.action,
        revision: loaded.app.currentRevision,
        recordId: proposal.recordId,
        baseVersion: proposal.baseVersion,
        effect: proposal.effect as unknown as Record<string, unknown>,
        findings: { list: proposal.findings } as unknown as Record<string, unknown>,
        provenance: proposal.provenance as unknown as Record<string, unknown>,
        card: proposal.card as unknown as Record<string, unknown>,
        digest,
        proposedByType: auth.agent ? 'service_account' : auth.actor.type,
        proposedBy: auth.agent?.id ?? auth.actor.id,
        proposedWithToken: auth.credential.kind === 'token' ? auth.credential.tokenId : null,
        onBehalfOf,
        revises: proposal.revises?.id ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ctx.config.PROPOSAL_TTL_HOURS * 3_600_000),
      })
      .returning();
    if (proposal.revises) {
      await tx.db.update(proposals).set({ status: 'superseded', decidedAt: now, decisionNote: `Revised as ${id}` }).where(eq(proposals.id, proposal.revises.id));
    }
    await recordAudit(tx.db, auditScopeFor(request, ctx.org.id, now), {
      action: proposal.revises ? 'proposal.revise' : 'proposal.create',
      target: { type: 'proposal', id },
      spaceId: loaded.space.id,
      appId: loaded.app.id,
      env: loaded.env.kind,
      reason: { action: proposal.action, digest, onBehalfOf, ...(proposal.revises ? { revises: proposal.revises.id } : {}) },
      changes: { fields: [...Object.keys(proposal.effect.values), ...Object.keys(proposal.effect.lines ?? {})] },
    });
    return this.toProposalOut({ ...row!, findings: proposal.findings as never });
  }

  /** A proposal made for the caller, or 404. */
  async proposalFor(auth: AuthContext, id: string): Promise<ProposalRow> {
    const [row] = await this.#ctx.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, id), eq(proposals.orgId, this.#ctx.org.id), eq(proposals.onBehalfOf, auth.actor.id)));
    if (!row) throw notFound('Proposal');
    return this.#withFindings(row);
  }

  #withFindings(row: ProposalRow): ProposalRow {
    const findings = (row.findings as { list?: unknown }).list;
    return { ...row, findings: (findings ?? row.findings) as never };
  }

  async proposalsFor(auth: AuthContext): Promise<ProposalOut[]> {
    const rows = await this.#ctx.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.orgId, this.#ctx.org.id), eq(proposals.onBehalfOf, auth.actor.id), eq(proposals.status, 'pending'), gt(proposals.expiresAt, this.#ctx.now())))
      .orderBy(desc(proposals.createdAt))
      .limit(100);
    return rows.map((row) => this.toProposalOut(this.#withFindings(row)));
  }

  /**
   * Approve a proposal: commit exactly the change it sealed. Only the person it was made for can,
   * in an interactive session, naming its digest; and only while the app and the record are as
   * they were when it was made.
   */
  async approve(request: FastifyRequest, auth: AuthContext, id: string, digest: string): Promise<{ proposal: ProposalOut; record: RecordOut | { id: string; version: number } }> {
    const ctx = this.#ctx;
    const proposal = await this.proposalFor(auth, id);
    const loaded = await ctx.apps.load(proposal.appId);
    const action = loaded.definition.actions[proposal.action];
    if (!action) throw conflict('definition_changed', 'The app changed since this was proposed. Ask for a new proposal.');
    const entity = this.entity(loaded, action.entity);
    const permission = await this.decide(request, auth, loaded, action.operation === 'create' ? 'record.create' : 'record.update', action.entity);
    const effect = proposal.effect as unknown as SealedEffect;
    const sealedLines = effect.lines ?? {};
    const written = [...new Set([...Object.keys(effect.input), ...Object.keys(action.set)])].filter((field) => !(field in sealedLines));
    const now = ctx.now();

    const stored = await withAppTransaction(ctx.pool, loaded.env, 'records', async (tx) => {
      const [locked] = await tx.db.select().from(proposals).where(eq(proposals.id, id)).for('update');
      if (locked!.status !== 'pending') throw conflict('not_pending', `This proposal is already ${locked!.status}`);
      if (locked!.expiresAt.getTime() <= now.getTime()) {
        await tx.db.update(proposals).set({ status: 'expired', decidedAt: now }).where(eq(proposals.id, id));
        throw conflict('expired', 'This proposal has expired. Ask for a new one.');
      }
      if (locked!.digest !== digest) throw conflict('digest_mismatch', 'This is not the change you were shown. Review it again.');
      if (tx.revision !== locked!.revision || loaded.app.currentRevision !== locked!.revision) {
        throw conflict('definition_changed', 'The app changed since this was proposed. Ask for a new proposal.');
      }
      let before: StoredRecord | null = null;
      let after: Record<string, FieldValue>;
      let current: Record<string, StoredLine[]> = {};
      const linePaths = () =>
        Object.entries(sealedLines).flatMap(([field, lines]) => {
          const declared = entity.fields.find((f): f is StoredLinesField => f.name === field && f.type === 'lines');
          return declared ? linesWritten(loaded.definition.entities[declared.entity]!, field, current[field] ?? [], lines) : [];
        });
      if (action.operation === 'create') {
        after = { ...effect.values, owner: (effect.values['owner'] as string | undefined) ?? auth.actor.id };
        if (!writeGrant(permission.grants, { fields: [...written, ...linePaths()], after })) throw forbidden('not_allowed', 'You may no longer make this change');
      } else {
        before = await this.#lock(tx, loaded, entity, locked!.recordId!);
        if (!before) throw notFound('Record');
        if (before.version !== locked!.baseVersion) throw conflict('record_changed', 'The record changed since this was proposed. Ask for a new proposal.');
        current = await this.#currentLines(tx, loaded, entity, before.id, Object.keys(sealedLines));
        const beforeValues = recordValues(before);
        after = { ...beforeValues, ...effect.values };
        if (!writeGrant(permission.grants, { fields: [...written, ...linePaths()], before: beforeValues, after })) throw forbidden('not_allowed', 'You may no longer make this change');
        this.#blockedBy(permission, beforeValues);
      }
      this.#blockedBy(permission, after);
      this.#rules(loaded, action.entity, auth, after, sealedLines);
      const record = await this.#writeRecord(request, auth, loaded, tx, {
        entityName: action.entity,
        operation: action.operation,
        before,
        values: effect.values,
        ...(action.operation === 'create' ? { owner: after['owner'] as string } : {}),
        provenance: locked!.provenance as unknown as Record<string, Provenance>,
        reason: { action: proposal.action, proposal: id, digest, proposedBy: { type: locked!.proposedByType, id: locked!.proposedBy } },
        lines: Object.fromEntries(Object.entries(sealedLines).map(([field, lines]) => [field, { next: lines, current: current[field] ?? [] }])),
      });
      await tx.db.update(proposals).set({ status: 'approved', decidedAt: now, resultRecordId: record!.id }).where(eq(proposals.id, id));
      await recordAudit(tx.db, auditScopeFor(request, ctx.org.id, now), {
        action: 'proposal.approve',
        target: { type: 'proposal', id },
        spaceId: loaded.space.id,
        appId: loaded.app.id,
        env: loaded.env.kind,
        reason: { digest, action: proposal.action, recordId: record!.id },
      });
      return record!;
    });
    const updated = await this.proposalFor(auth, id);
    return { proposal: this.toProposalOut(updated), record: await this.#respond(auth, loaded, action.entity, stored) };
  }

  /** Reject, or withdraw, a pending proposal. The person can, and so can the agent that made it. */
  async reject(request: FastifyRequest, auth: AuthContext, id: string, note?: string): Promise<ProposalOut> {
    const ctx = this.#ctx;
    const proposal = await this.proposalFor(auth, id);
    if (proposal.status !== 'pending') throw conflict('not_pending', `This proposal is already ${proposal.status}`);
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      await tx.update(proposals).set({ status: 'rejected', decidedAt: now, decisionNote: note ?? null }).where(and(eq(proposals.id, id), eq(proposals.status, 'pending')));
      await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
        action: 'proposal.reject',
        target: { type: 'proposal', id },
        appId: proposal.appId,
        reason: { digest: proposal.digest, ...(note ? { note } : {}) },
      });
    });
    return this.toProposalOut(await this.proposalFor(auth, id));
  }

  /** The person edits a proposal's values: a new proposal, checked again, with their edits marked as theirs. */
  async revise(request: FastifyRequest, auth: AuthContext, id: string, edits: Readonly<Record<string, unknown>>): Promise<ActionResult> {
    const proposal = await this.proposalFor(auth, id);
    if (proposal.status !== 'pending') throw conflict('not_pending', `This proposal is already ${proposal.status}`);
    const loaded = await this.#ctx.apps.load(proposal.appId);
    const effect = proposal.effect as unknown as SealedEffect;
    const action = loaded.definition.actions[proposal.action];
    if (!action) throw conflict('definition_changed', 'The app changed since this was proposed. Ask for a new proposal.');
    const entity = this.entity(loaded, action.entity);
    const linesFields = new Set(linesFieldsOf(entity).map((f) => f.name));
    const changed = Object.keys(edits).filter(
      (field) => !linesFields.has(field) && JSON.stringify(effect.input[field] ?? null) !== JSON.stringify(canonical(loaded, action.entity, field, edits[field])),
    );
    const before = proposal.provenance as Record<string, Provenance>;
    const provenance: Record<string, Provenance> = Object.fromEntries(Object.entries(before).filter(([key]) => !LINE_KEY.test(key) || !(LINE_KEY.exec(key)![1]! in edits)));
    for (const field of changed) provenance[field] = { source: 'person' };
    // A line's values keep where they came from, unless the person changed them: follow each line by its ID.
    for (const linesField of linesFieldsOf(entity)) {
      const field = linesField.name;
      if (!(field in edits)) continue;
      const lineEntity = loaded.definition.entities[linesField.entity]!;
      const previous = (effect.input[field] as LineWire[] | undefined) ?? [];
      const edited = Array.isArray(edits[field]) ? (edits[field] as Array<Record<string, unknown>>) : [];
      edited.forEach((line, index) => {
        const was = typeof line['id'] === 'string' ? previous.findIndex((p) => p.id === line['id']) : -1;
        for (const declared of lineEntity.fields) {
          const key = `${field}[${index}].${declared.name}`;
          const given = declared.name in line;
          const same = was >= 0 && (!given || JSON.stringify(previous[was]![declared.name] ?? null) === JSON.stringify(canonical(loaded, linesField.entity, declared.name, line[declared.name])));
          const source = was >= 0 ? before[`${field}[${was}].${declared.name}`] : undefined;
          if (same && source) provenance[key] = source;
          else if (!same && given) provenance[key] = { source: 'person' };
        }
      });
    }
    return this.runAction(
      request,
      auth,
      loaded,
      proposal.action,
      {
        values: { ...effect.input, ...edits },
        ...(proposal.recordId ? { recordId: proposal.recordId } : {}),
        ...(proposal.baseVersion !== null ? { version: proposal.baseVersion } : {}),
        provenance,
      },
      { revises: proposal },
    );
  }

  /** The capability resource for an action or query, for permission checks. */
  capability(loaded: LoadedApp, kind: 'action' | 'query', name: string) {
    return capabilityResource(this.#ctx.org.id, loaded, kind, name);
  }
}

/** The caller's principal without its token scopes: their own grants, for checks inside an operation. */
function withoutScopes(auth: AuthContext) {
  const { tokenScopes: _scopes, ...principal } = auth.principal;
  return principal;
}

function canonical(loaded: LoadedApp, entity: string, field: string, value: unknown): FieldValue {
  const info = entityFields(loaded.definition.entities[entity]!).get(field);
  const result = info ? canonicalValue(info, value) : null;
  return result?.ok ? result.value : (value as FieldValue);
}

/** A key for a line's value in provenance: `lines[2].amount`. */
const LINE_KEY = /^([a-z][a-z0-9_]{0,62})\[(\d{1,4})\]\.([a-z][a-z0-9_]{0,62})$/;

/** The provenance of one lines field's values, by line position and field: `2.amount`. */
function lineSources(provenance: Readonly<Record<string, Provenance>> | undefined, field: string): Record<string, Provenance> {
  return Object.fromEntries(
    Object.entries(provenance ?? {}).flatMap(([key, source]) => {
      const match = LINE_KEY.exec(key);
      return match && match[1] === field ? [[`${Number(match[2])}.${match[3]}`, source]] : [];
    }),
  );
}
