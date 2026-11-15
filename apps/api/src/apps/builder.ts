import { canonicalJson, sha256Hex, uuidv7 } from '@platform/audit';
import {
  appRoleId,
  appRoleName,
  dropEnvironment,
  environmentNames,
  NAME_PATTERN,
  planMigration,
  provisionEnvironment,
  validateDefinition,
  type MigrationPlan,
  type StoredDefinition,
} from '@platform/app-model';
import { appEnvironments, appRevisions, apps, bindings, proposals, users, type Database } from '@platform/db';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { conflict, forbidden, HttpError, notFound, unprocessable } from '../errors.js';
import type { LoadedApp, SpaceRow } from './catalog.js';
import { pgError as pgCode } from './pg-errors.js';
import { withAppTransaction, withTransaction } from './transaction.js';

export interface PlannedStep {
  readonly kind: string;
  readonly description: string;
  readonly destructive: boolean;
  /** How many records the step touches, where that's worth knowing first. */
  readonly records?: number;
}

export interface SavePlan {
  readonly revision: number;
  readonly destructive: boolean;
  readonly steps: PlannedStep[];
  readonly notes: string[];
}

const digestOf = (definition: StoredDefinition) => sha256Hex(canonicalJson(definition));

/** A handle from an app's name: `Expense claims` → `expense_claims`. */
export function handleFrom(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const handle = /^[a-z]/.test(slug) ? slug : `app_${slug}`.replace(/_+$/, '');
  return NAME_PATTERN.test(handle) ? handle : 'app';
}

function invalid(issues: readonly { path: string; message: string }[]): HttpError {
  return unprocessable('invalid_definition', 'The definition has problems', { issues });
}


/** Creating apps, changing their definitions, sharing and deleting them (design §6). */
export class AppBuilder {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async create(
    request: FastifyRequest,
    auth: AuthContext,
    space: SpaceRow,
    input: { readonly name: string; readonly handle?: string; readonly description?: string; readonly definition?: unknown },
  ): Promise<{ appId: string; plan: SavePlan }> {
    const ctx = this.#ctx;
    if (space.kind !== 'personal') {
      throw unprocessable('team_space_apps_later', 'Apps in team spaces arrive with change requests (phase 2). Build in your personal space for now.');
    }
    const [{ n }] = (await ctx.db.select({ n: count() }).from(apps).where(and(eq(apps.spaceId, space.id), eq(apps.status, 'active')))) as [{ n: number }];
    if (n >= ctx.config.PERSONAL_SPACE_MAX_APPS) {
      throw unprocessable('too_many_apps', `A personal space holds at most ${ctx.config.PERSONAL_SPACE_MAX_APPS} apps. Delete one, or move it to a team space.`);
    }
    const handle = input.handle ?? handleFrom(input.name);
    if (!NAME_PATTERN.test(handle)) throw unprocessable('invalid_handle', 'A handle uses lowercase letters, digits and underscores, starting with a letter');
    const result = validateDefinition(input.definition ?? {});
    if (!result.ok) throw invalid(result.issues);

    const now = ctx.now();
    const appId = uuidv7(now.getTime());
    const envId = uuidv7(now.getTime());
    const names = environmentNames(appId, 'sandbox');
    const plan = planMigration(undefined, result.definition, names);
    const audit = auditScopeFor(request, ctx.org.id, now);
    try {
      await withTransaction(ctx.pool, async (client, db) => {
        await db.insert(apps).values({
          id: appId,
          orgId: ctx.org.id,
          spaceId: space.id,
          handle,
          name: input.name,
          description: input.description ?? null,
          ownerUserId: space.ownerUserId!,
          currentRevision: 1,
          createdBy: auth.actor.id,
          createdAt: now,
          updatedAt: now,
        });
        await this.#insertRevision(db, appId, 1, result.definition, plan, result.notes, auth, now);
        await db.insert(appEnvironments).values({
          id: envId,
          appId,
          kind: 'sandbox',
          schemaName: names.schema,
          dbRole: names.role,
          appliedRevision: 1,
          createdAt: now,
        });
        for (const statement of [...provisionEnvironment(names), ...plan.statements]) await client.query(statement);
        await recordAudit(db, audit, {
          action: 'app.create',
          target: { type: 'app', id: appId, name: input.name },
          spaceId: space.id,
          appId,
          env: 'sandbox',
          changes: { after: { name: input.name, handle, revision: 1, digest: digestOf(result.definition) } },
        });
      });
    } catch (error) {
      if (pgCode(error).constraint === 'apps_space_handle_uq') throw conflict('handle_taken', `Another app in this space is already called ${handle}`);
      throw error;
    }
    return { appId, plan: { revision: 1, destructive: false, steps: plan.steps.map(({ kind, description, destructive }) => ({ kind, description, destructive })), notes: [...result.notes] } };
  }

  /**
   * Validate a new definition and work out what saving it would do, without saving: the migration
   * steps, how many records each destructive step touches, and the shares a removed role revokes.
   */
  async plan(loaded: LoadedApp, input: unknown): Promise<{ definition: StoredDefinition; migration: MigrationPlan; plan: SavePlan; revokes: string[] }> {
    const result = validateDefinition(input, loaded.definition);
    if (!result.ok) throw invalid(result.issues);
    const names = { schema: loaded.env.schemaName, role: loaded.env.dbRole };
    const migration = planMigration(loaded.definition, result.definition, names);
    const counts = new Map<number, number>();
    if (migration.impact.length) {
      const client = await this.#ctx.pool.connect();
      try {
        for (const { step, sql } of migration.impact) counts.set(step, (await client.query<{ n: number }>(sql)).rows[0]?.n ?? 0);
      } finally {
        client.release();
      }
    }
    const removedRoles = Object.keys(loaded.definition.roles).filter((role) => !result.definition.roles[role]);
    const revokes = removedRoles.length ? await this.#sharesOf(loaded, removedRoles) : [];
    const notes = [...result.notes];
    if (revokes.length) notes.push(`Revokes ${revokes.length} share(s) of the removed role(s) ${removedRoles.join(', ')}`);
    return {
      definition: result.definition,
      migration,
      revokes,
      plan: {
        revision: loaded.app.currentRevision + 1,
        destructive: migration.destructive,
        steps: migration.steps.map(({ kind, description, destructive }, index) => ({
          kind,
          description,
          destructive,
          ...(counts.has(index) ? { records: counts.get(index)! } : {}),
        })),
        notes,
      },
    };
  }

  /** Save a definition. In a personal sandbox the change applies at once (design §3). */
  async save(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    input: unknown,
    options: { readonly baseRevision?: number; readonly confirmDestructive: boolean },
  ): Promise<SavePlan> {
    const ctx = this.#ctx;
    if (options.baseRevision !== undefined && options.baseRevision !== loaded.app.currentRevision) {
      throw new HttpError(412, 'revision_mismatch', `The app is at revision ${loaded.app.currentRevision}, not ${options.baseRevision}. Reload it and try again.`);
    }
    const { definition, migration, plan, revokes } = await this.plan(loaded, input);
    if (migration.destructive) {
      if (!options.confirmDestructive) {
        throw conflict('destructive_change', 'This change deletes data. Check the plan, then confirm it.', { plan });
      }
      // Agents and scripts may prepare such a change, but only the builder, signed in, can confirm it.
      if (auth.credential.kind !== 'session') {
        throw forbidden('session_required', 'A change that deletes data must be confirmed by the builder in an interactive session.', { plan });
      }
    }
    const now = ctx.now();
    const audit = auditScopeFor(request, ctx.org.id, now);
    try {
      await withAppTransaction(ctx.pool, loaded.env, 'schema', async (tx) => {
        if (tx.revision !== loaded.app.currentRevision) {
          throw conflict('revision_conflict', 'The definition changed while you were saving. Reload it and try again.');
        }
        for (const statement of migration.statements) await tx.platformQuery(statement);
        await this.#insertRevision(tx.db, loaded.app.id, plan.revision, definition, migration, plan.notes, auth, now);
        await tx.db.update(apps).set({ currentRevision: plan.revision, updatedAt: now }).where(eq(apps.id, loaded.app.id));
        await tx.db.update(appEnvironments).set({ appliedRevision: plan.revision }).where(eq(appEnvironments.id, loaded.env.id));
        for (const bindingId of revokes) {
          await tx.db.update(bindings).set({ revokedAt: now, revokedByType: auth.actor.type, revokedBy: auth.actor.id }).where(eq(bindings.id, bindingId));
        }
        await recordAudit(tx.db, audit, {
          action: 'app.definition.update',
          target: { type: 'app', id: loaded.app.id, name: loaded.app.name },
          spaceId: loaded.space.id,
          appId: loaded.app.id,
          env: loaded.env.kind,
          changes: {
            before: { revision: loaded.app.currentRevision, digest: digestOf(loaded.definition) },
            after: { revision: plan.revision, digest: digestOf(definition) },
            steps: plan.steps,
            revokedShares: revokes,
          },
        });
      });
    } catch (error) {
      const { code } = pgCode(error);
      if (code === '23505') throw conflict('duplicate_values', 'A field can only become unique once its records stop sharing values', { plan });
      if (code === '23503') throw conflict('records_still_referenced', 'Records of an entity you are removing are still referenced by other records', { plan });
      throw error;
    }
    return plan;
  }

  async remove(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp): Promise<void> {
    const ctx = this.#ctx;
    const now = ctx.now();
    const audit = auditScopeFor(request, ctx.org.id, now);
    await withAppTransaction(ctx.pool, loaded.env, 'schema', async (tx) => {
      for (const statement of dropEnvironment({ schema: loaded.env.schemaName, role: loaded.env.dbRole })) await tx.platformQuery(statement);
      await tx.db.update(appEnvironments).set({ status: 'deleted' }).where(eq(appEnvironments.id, loaded.env.id));
      await tx.db.update(apps).set({ status: 'deleted', deletedAt: now, updatedAt: now }).where(eq(apps.id, loaded.app.id));
      await tx.db
        .update(bindings)
        .set({ revokedAt: now, revokedByType: auth.actor.type, revokedBy: auth.actor.id })
        .where(and(eq(bindings.scopeType, 'env'), eq(bindings.scopeId, loaded.env.id), isNull(bindings.revokedAt)));
      await tx.db
        .update(proposals)
        .set({ status: 'expired', decidedAt: now, decisionNote: 'The app was deleted' })
        .where(and(eq(proposals.appId, loaded.app.id), eq(proposals.status, 'pending')));
      await recordAudit(tx.db, audit, {
        action: 'app.delete',
        target: { type: 'app', id: loaded.app.id, name: loaded.app.name },
        spaceId: loaded.space.id,
        appId: loaded.app.id,
        env: loaded.env.kind,
        changes: { before: { revision: loaded.app.currentRevision, digest: digestOf(loaded.definition) } },
      });
    });
  }

  /** Active shares of an app: bindings of its roles to named people, at its environment. */
  async #sharesOf(loaded: LoadedApp, roles?: readonly string[]): Promise<string[]> {
    const rows = await this.#ctx.db
      .select({ id: bindings.id, appRoleId: bindings.appRoleId })
      .from(bindings)
      .where(and(eq(bindings.scopeType, 'env'), eq(bindings.scopeId, loaded.env.id), isNull(bindings.revokedAt), isNotNull(bindings.appRoleId)));
    return rows.filter((row) => !roles || roles.includes(appRoleName(loaded.app.id, row.appRoleId!) ?? '')).map((row) => row.id);
  }

  /** Share an app with a named colleague, in one of its roles (design §3). */
  async share(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    input: { readonly email?: string; readonly userId?: string; readonly role: string; readonly expiresAt?: Date },
  ): Promise<string> {
    const ctx = this.#ctx;
    if (!loaded.definition.roles[input.role]) throw unprocessable('unknown_role', `The app has no role named ${input.role}`);
    const [person] = await ctx.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          eq(users.orgId, ctx.org.id),
          eq(users.status, 'active'),
          input.userId ? eq(users.id, input.userId) : eq(users.email, (input.email ?? '').toLowerCase()),
        ),
      );
    if (!person) throw unprocessable('unknown_user', 'No active colleague has that email address or ID');
    if (person.id === loaded.app.ownerUserId) throw unprocessable('owner', 'You own this app already');
    const current = await ctx.db
      .select({ principalId: bindings.principalId })
      .from(bindings)
      .where(and(eq(bindings.scopeType, 'env'), eq(bindings.scopeId, loaded.env.id), isNull(bindings.revokedAt), isNotNull(bindings.appRoleId)));
    const people = new Set(current.map((row) => row.principalId));
    if (!people.has(person.id) && people.size >= ctx.config.PERSONAL_APP_MAX_SHARES) {
      throw unprocessable('too_many_shares', `A personal app can be shared with at most ${ctx.config.PERSONAL_APP_MAX_SHARES} people. Consider moving it to a team space.`);
    }
    const now = ctx.now();
    const bindingId = uuidv7(now.getTime());
    try {
      await ctx.db.transaction(async (tx) => {
        await tx.insert(bindings).values({
          id: bindingId,
          orgId: ctx.org.id,
          principalType: 'user',
          principalId: person.id,
          appRoleId: appRoleId(loaded.app.id, input.role),
          scopeType: 'env',
          scopeId: loaded.env.id,
          expiresAt: input.expiresAt ?? null,
          grantedByType: auth.actor.type,
          grantedBy: auth.actor.id,
          createdAt: now,
        });
        await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
          action: 'app.share',
          target: { type: 'binding', id: bindingId },
          spaceId: loaded.space.id,
          appId: loaded.app.id,
          env: loaded.env.kind,
          changes: { after: { userId: person.id, role: input.role, expiresAt: input.expiresAt?.toISOString() ?? null } },
        });
      });
    } catch (error) {
      if (pgCode(error).constraint === 'bindings_active_app_role_uq') throw conflict('already_shared', `They already have the ${input.role} role`);
      throw error;
    }
    return bindingId;
  }

  async unshare(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, bindingId: string): Promise<void> {
    const ctx = this.#ctx;
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(bindings)
        .set({ revokedAt: now, revokedByType: auth.actor.type, revokedBy: auth.actor.id })
        .where(and(eq(bindings.id, bindingId), eq(bindings.scopeType, 'env'), eq(bindings.scopeId, loaded.env.id), isNull(bindings.revokedAt), isNotNull(bindings.appRoleId)))
        .returning();
      if (!revoked) throw notFound('Share');
      await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
        action: 'app.unshare',
        target: { type: 'binding', id: bindingId },
        spaceId: loaded.space.id,
        appId: loaded.app.id,
        env: loaded.env.kind,
        changes: { before: { userId: revoked.principalId, role: appRoleName(loaded.app.id, revoked.appRoleId!) } },
      });
    });
  }

  async #insertRevision(
    db: Database,
    appId: string,
    revision: number,
    definition: StoredDefinition,
    plan: MigrationPlan,
    notes: readonly string[],
    auth: AuthContext,
    now: Date,
  ): Promise<void> {
    await db.insert(appRevisions).values({
      appId,
      revision,
      definition: definition as unknown as Record<string, unknown>,
      digest: digestOf(definition),
      summary: { steps: plan.steps.map(({ kind, description, destructive }) => ({ kind, description, destructive })), notes: [...notes] },
      createdByType: auth.actor.type,
      createdBy: auth.actor.id,
      createdAt: now,
    });
  }
}

