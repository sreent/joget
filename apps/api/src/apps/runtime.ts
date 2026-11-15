import { canonicalJson, sha256Hex, uuidv7 } from '@platform/audit';
import { conditionRefs, evaluateCondition, partialEvaluate, type Condition, type Policy, type QueryGrant } from '@platform/authz';
import {
  buildCard,
  canonicalValue,
  checkActionInput,
  checkInput,
  conditionRecord,
  cursorOf,
  deleteRecord,
  diffRecords,
  entityFields,
  evaluateRules,
  excludedBy,
  fieldAccess,
  grantsFor,
  insertHistory,
  insertRecord,
  parseRecord,
  Provenance,
  recordValues,
  selectHistory,
  selectRecords,
  updateRecord,
  writeGrant,
  type CardData,
  type FieldValue,
  type Finding,
  type RecordValues,
  type StoredEntity,
  type StoredRecord,
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

/** A record as the API returns it. Fields the caller can't see are left out; masked ones are listed. */
export interface RecordOut {
  readonly id: string;
  readonly version: number;
  readonly owner: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly values: Record<string, FieldValue>;
  readonly masked: string[];
}

export interface Page {
  readonly records: RecordOut[];
  readonly nextCursor: string | null;
}

/** One field's change in a record's history, as the caller may see it. */
export type HistoryChangeOut =
  | { readonly field: string; readonly before: FieldValue; readonly after: FieldValue; readonly source?: unknown }
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

interface SealedEffect {
  /** The action's inputs as the caller gave them, canonical. Kept so a person can revise them. */
  readonly input: Record<string, FieldValue>;
  /** Exactly what the action writes: every value for a create, the changed ones for an update. */
  readonly values: Record<string, FieldValue>;
}

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

  async decide(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, action: string, entity: string): Promise<AllowedQuery> {
    return checkQuery(this.#ctx, request, auth, action, recordResource(this.#ctx.org.id, loaded, entity), { policy: await this.policy(loaded) });
  }

  /** The read grants of a decision, or none if reading isn't allowed at all. */
  async #readGrants(auth: AuthContext, loaded: LoadedApp, entity: string): Promise<AllowedQuery | null> {
    const decision = await this.#ctx.policy.query(auth.principal, 'record.read', recordResource(this.#ctx.org.id, loaded, entity), { policy: await this.policy(loaded) });
    return decision.allowed ? (decision as AllowedQuery) : null;
  }

  /** A record as the caller may see it, given the read grants that apply to it. */
  project(entity: StoredEntity, record: StoredRecord, grants: readonly QueryGrant[], fields?: readonly string[]): RecordOut {
    const values: Record<string, FieldValue> = {};
    const masked: string[] = [];
    const held = grants.map((grant) => grant.grant);
    for (const field of entity.fields) {
      if (fields && !fields.includes(field.name)) continue;
      const access = fieldAccess(held, field.name);
      if (access === 'full') values[field.name] = record.values[field.name] ?? null;
      else if (access === 'masked') masked.push(field.name);
    }
    const { id, version, owner, createdAt, createdBy, updatedAt, updatedBy } = record;
    return { id, version, owner, createdAt, createdBy, updatedAt, updatedBy, values, masked };
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
    const rows = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      return (await tx.query(query.text, query.values)).rows;
    });
    const parsed = rows.slice(0, options.limit).map((row) => parseRecord(entity, row, query.flagGrants.length));
    const records = parsed.map(({ record, flags }) => {
      const applicable = decision.grants.filter((grant, index) => {
        const flag = query.flagGrants.indexOf(index);
        return flag === -1 ? grant.filter === true : flags[flag];
      });
      return this.project(entity, record, applicable, options.fields);
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

  async #checkPeople(entity: StoredEntity, values: RecordValues, explicitOwner: boolean): Promise<void> {
    const ids = new Set<string>();
    for (const field of entity.fields) {
      const value = values[field.name];
      if (field.type === 'user' && typeof value === 'string') ids.add(value);
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

  #rules(loaded: LoadedApp, entityName: string, auth: AuthContext, values: RecordValues): Finding[] {
    const findings = evaluateRules(loaded.definition, entityName, values, { principal: principalEnv(auth) });
    const errors = findings.filter((finding) => finding.severity === 'error');
    if (errors.length) throw unprocessable('rule_failed', errors.map((e) => e.message).join('; '), { findings });
    return findings;
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
    const changes = diffRecords(entity, before, after ? recordValues(after) : null, write.provenance ?? {});
    const record = (after ?? write.before)!;
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
        actorType: auth.actor.type,
        actorId: auth.actor.id,
        onBehalfOf: null,
        via: event.actor.via ?? 'api',
        at,
        auditEventId: event.id,
      });
      await tx.query(history.text, history.values);
    }
    return after;
  }

  async #respond(auth: AuthContext, loaded: LoadedApp, entityName: string, record: StoredRecord): Promise<RecordOut | { id: string; version: number }> {
    const read = await this.#readGrants(auth, loaded, entityName);
    const grants = read ? grantsFor(read.grants, recordValues(record)) : [];
    return grants.length ? this.project(this.entity(loaded, entityName), record, grants) : { id: record.id, version: record.version };
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
    const provenance = this.#provenance(input.provenance, Object.keys(input.values));
    const check = checkInput(entity, input.values, { mode: 'create' });
    if (check.issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues: check.issues });
    const permission = decision ?? (await this.decide(request, auth, loaded, 'record.create', entityName));
    const owner = (check.values['owner'] as string | undefined) ?? auth.actor.id;
    const after = { ...check.values, owner };
    if (!writeGrant(permission.grants, { fields: Object.keys(input.values), after })) {
      throw forbidden('not_allowed', 'You may not create this record: a field or a value is outside what your role allows');
    }
    this.#blockedBy(permission, after);
    this.#rules(loaded, entityName, auth, after);
    await this.#checkPeople(entity, after, 'owner' in input.values);
    const record = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      return (await this.#writeRecord(request, auth, loaded, tx, { entityName, operation: 'create', before: null, values: check.values, owner, provenance }))!;
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
    const provenance = this.#provenance(input.provenance, Object.keys(input.values));
    const check = checkInput(entity, input.values, { mode: 'update' });
    if (check.issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues: check.issues });
    const permission = decision ?? (await this.decide(request, auth, loaded, 'record.update', entityName));
    const read = await this.#readGrants(auth, loaded, entityName);
    const record = await withAppTransaction(this.#ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      const before = await this.#lock(tx, loaded, entity, id);
      if (!before) throw notFound('Record');
      const beforeValues = recordValues(before);
      const changed = Object.fromEntries(Object.entries(check.values).filter(([name, value]) => JSON.stringify(beforeValues[name] ?? null) !== JSON.stringify(value)));
      const afterValues = { ...beforeValues, ...changed };
      if (!writeGrant(permission.grants, { fields: Object.keys(changed), before: beforeValues, after: afterValues })) {
        const readable = read ? grantsFor(read.grants, beforeValues).length > 0 : false;
        if (!readable) throw notFound('Record');
        throw forbidden('not_allowed', 'You may not make this change: the record, a field or a value is outside what your role allows');
      }
      if (input.version !== undefined && input.version !== before.version) {
        throw conflict('version_conflict', `The record is at version ${before.version}, not ${input.version}. Reload it and try again.`);
      }
      this.#blockedBy(permission, beforeValues, afterValues);
      this.#rules(loaded, entityName, auth, afterValues);
      if (Object.keys(changed).length === 0) return before;
      await this.#checkPeople(entity, changed, 'owner' in changed);
      return (await this.#writeRecord(request, auth, loaded, tx, { entityName, operation: 'update', before, values: changed, provenance }))!;
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
      await this.#writeRecord(request, auth, loaded, tx, { entityName, operation: 'delete', before, values: {} });
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
    return rows.map((row) => {
      const changes = row['changes'] as Record<string, { name: string; before: FieldValue; after: FieldValue; source?: unknown }>;
      return {
        version: row['version'] as number,
        operation: row['operation'] as 'create' | 'update' | 'delete',
        at: row['occurred_at'] as string,
        actor: { type: row['actor_type'] as string, id: (row['actor_id'] as string | null) ?? null },
        via: row['via'] as string,
        changes: Object.entries(changes).flatMap(([fieldId, change]): HistoryChangeOut[] => {
          if (fieldId === 'owner') return [{ field: 'owner', before: change.before, after: change.after }];
          const field = entity.fields.find((f) => f.id === fieldId);
          if (!field) return [{ field: change.name, removed: true }];
          const access = fieldAccess(read, field.name);
          if (access === 'hidden') return [];
          if (access === 'masked') return [{ field: field.name, masked: true }];
          return [{ field: field.name, before: change.before, after: change.after, ...(change.source ? { source: change.source } : {}) }];
        }),
      };
    });
  }

  #provenance(raw: unknown, allowed: readonly string[]): Record<string, Provenance> {
    if (raw === undefined || raw === null) return {};
    const parsed = ProvenanceMap.safeParse(raw);
    if (!parsed.success) throw unprocessable('invalid_provenance', 'Provenance must say, for each field, where its value came from');
    const unknown = Object.keys(parsed.data).filter((field) => !allowed.includes(field));
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

    const decision = await this.decide(request, auth, loaded, 'record.read', query.entity);
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
    const provenance = this.#provenance(input.provenance, action.input);
    const check = checkActionInput(loaded.definition, name, input.values);
    if (check.issues.length) throw unprocessable('invalid_values', 'Some values are not valid', { issues: check.issues });
    if (action.operation === 'update' && !input.recordId) throw unprocessable('record_required', `${name} changes an existing record: give its ID`);
    const permission = await this.decide(request, auth, loaded, action.operation === 'create' ? 'record.create' : 'record.update', action.entity);
    // Revising a proposal is the person's own edit: it waits for their approval again, through the same review.
    const needsConfirmation = action.confirm !== 'none' && (auth.credential.kind === 'token' || options.revises !== undefined);
    const written = [...new Set([...Object.keys(input.values), ...Object.keys(action.set)])];
    const sealedInput = Object.fromEntries(Object.entries(check.values).filter(([field]) => action.input.includes(field)));
    const commit = !input.dryRun && !needsConfirmation;

    return withAppTransaction(ctx.pool, loaded.env, 'records', async (tx) => {
      this.#sameRevision(tx, loaded);
      let before: StoredRecord | null = null;
      let values: Record<string, FieldValue>;
      let after: Record<string, FieldValue>;
      if (action.operation === 'create') {
        values = check.values;
        after = { ...check.values, owner: (check.values['owner'] as string | undefined) ?? auth.actor.id };
        if (!writeGrant(permission.grants, { fields: written, after })) {
          throw forbidden('not_allowed', `You may not ${action.label.toLowerCase()}: a field or a value is outside what your role allows`);
        }
      } else {
        before = await this.#lock(tx, loaded, entity, input.recordId!);
        if (!before) throw notFound('Record');
        const beforeValues = recordValues(before);
        values = Object.fromEntries(Object.entries(check.values).filter(([field, value]) => JSON.stringify(beforeValues[field] ?? null) !== JSON.stringify(value)));
        after = { ...beforeValues, ...values };
        if (!writeGrant(permission.grants, { fields: written, before: beforeValues, after })) {
          const read = await this.#readGrants(auth, loaded, action.entity);
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
      const findings = this.#rules(loaded, action.entity, auth, after);
      await this.#checkPeople(entity, values, 'owner' in values);
      const card = buildCard({
        definition: loaded.definition,
        entity: action.entity,
        ...(action.card ? { card: action.card } : {}),
        title: action.label,
        show: written,
        values: after,
        findings,
        provenance,
      });
      if (input.dryRun) return { status: 'preview' as const, needsConfirmation, findings, card };
      if (!commit) {
        const proposal = await this.#propose(request, auth, loaded, tx, {
          action: name,
          recordId: before?.id ?? null,
          baseVersion: before?.version ?? null,
          effect: { input: sealedInput, values },
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
      });
      return { status: 'done' as const, record: { id: record!.id, version: record!.version } };
    }).then(async (result) => {
      if (result.status !== 'done') return result;
      // The response shows the record as the caller may read it, decided after the write.
      const stored = await this.#readBack(loaded, entity, result.record.id);
      return { status: 'done' as const, record: stored ? await this.#respond(auth, loaded, action.entity, stored) : result.record };
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
      canonicalJson({ appId: loaded.app.id, revision: loaded.app.currentRevision, action: proposal.action, recordId: proposal.recordId, baseVersion: proposal.baseVersion, values: proposal.effect.values, onBehalfOf }),
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
        proposedByType: auth.actor.type,
        proposedBy: auth.actor.id,
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
      changes: { fields: Object.keys(proposal.effect.values) },
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
    const written = [...new Set([...Object.keys(effect.input), ...Object.keys(action.set)])];
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
      if (action.operation === 'create') {
        after = { ...effect.values, owner: (effect.values['owner'] as string | undefined) ?? auth.actor.id };
        if (!writeGrant(permission.grants, { fields: written, after })) throw forbidden('not_allowed', 'You may no longer make this change');
      } else {
        before = await this.#lock(tx, loaded, entity, locked!.recordId!);
        if (!before) throw notFound('Record');
        if (before.version !== locked!.baseVersion) throw conflict('record_changed', 'The record changed since this was proposed. Ask for a new proposal.');
        const beforeValues = recordValues(before);
        after = { ...beforeValues, ...effect.values };
        if (!writeGrant(permission.grants, { fields: written, before: beforeValues, after })) throw forbidden('not_allowed', 'You may no longer make this change');
        this.#blockedBy(permission, beforeValues);
      }
      this.#blockedBy(permission, after);
      this.#rules(loaded, action.entity, auth, after);
      const record = await this.#writeRecord(request, auth, loaded, tx, {
        entityName: action.entity,
        operation: action.operation,
        before,
        values: effect.values,
        ...(action.operation === 'create' ? { owner: after['owner'] as string } : {}),
        provenance: locked!.provenance as unknown as Record<string, Provenance>,
        reason: { action: proposal.action, proposal: id, digest, proposedBy: { type: locked!.proposedByType, id: locked!.proposedBy } },
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
    const changed = Object.keys(edits).filter((field) => JSON.stringify(effect.input[field] ?? null) !== JSON.stringify(canonical(loaded, action.entity, field, edits[field])));
    const provenance = { ...(proposal.provenance as Record<string, Provenance>) };
    for (const field of changed) provenance[field] = { source: 'person' };
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

function canonical(loaded: LoadedApp, entity: string, field: string, value: unknown): FieldValue {
  const info = entityFields(loaded.definition.entities[entity]!).get(field);
  const result = info ? canonicalValue(info, value) : null;
  return result?.ok ? result.value : (value as FieldValue);
}

