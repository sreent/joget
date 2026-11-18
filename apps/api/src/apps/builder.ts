import {
  appRoleId,
  appRoleName,
  dropEnvironment,
  environmentNames,
  type MigrationPlan,
  NAME_PATTERN,
  planMigration,
  provisionEnvironment,
  type StoredDefinition,
  validateDefinition,
} from '@platform/app-model';
import { canonicalJson, sha256Hex, uuidv7 } from '@platform/audit';
import { appEnvironments, appRevisions, apps, bindings, type Database, groups, proposals, users } from '@platform/db';
import { and, count, eq, isNotNull, isNull, like } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { requirePerson } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { conflict, HttpError, notFound, unprocessable } from '../errors.js';
import { planSchedules } from '../flows/schedules.js';
import { type AppRef, isTeamApp, type LoadedApp, type SpaceRow } from './catalog.js';
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

export const digestOf = (definition: StoredDefinition): string => sha256Hex(canonicalJson(definition));

/** Team apps change only through change requests, from working copies (design §3). */
export function changeRequestRequired(ref: AppRef): HttpError {
  return conflict(
    'change_request_required',
    `${ref.app.name} is a team app: it changes through change requests. Choose Edit in my space, change your working copy, then submit the change.`,
  );
}

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

  /**
   * Create an app. In a personal space it gets a sandbox, and its first definition applies at once.
   * A team app starts empty and has no environment yet: its content arrives through change
   * requests, and its first deployment creates Prod (design §3).
   */
  async create(
    request: FastifyRequest,
    auth: AuthContext,
    space: SpaceRow,
    input: { readonly name: string; readonly handle?: string; readonly description?: string; readonly definition?: unknown },
  ): Promise<{ appId: string; plan: SavePlan }> {
    const ctx = this.#ctx;
    const handle = input.handle ?? handleFrom(input.name);
    if (!NAME_PATTERN.test(handle)) throw unprocessable('invalid_handle', 'A handle uses lowercase letters, digits and underscores, starting with a letter');
    if (space.kind === 'team') {
      const result = validateDefinition(input.definition ?? {});
      if (!result.ok) throw invalid(result.issues);
      if (Object.keys(result.definition.entities).length || Object.keys(result.definition.roles).length) {
        throw unprocessable('team_app_starts_empty', 'A team app starts empty. Build it in your working copy, then submit the change for review.');
      }
      return { appId: await this.#createTeamApp(request, auth, space, { ...input, handle }), plan: { revision: 1, destructive: false, steps: [], notes: [] } };
    }
    const [{ n }] = (await ctx.db
      .select({ n: count() })
      .from(apps)
      .where(and(eq(apps.spaceId, space.id), eq(apps.status, 'active'), isNull(apps.workingCopyOf)))) as [{ n: number }];
    if (n >= ctx.config.PERSONAL_SPACE_MAX_APPS) {
      throw unprocessable(
        'too_many_apps',
        `A personal space holds at most ${ctx.config.PERSONAL_SPACE_MAX_APPS} apps. Delete one, or move it to a team space.`,
      );
    }
    const result = validateDefinition(input.definition ?? {});
    if (!result.ok) throw invalid(result.issues);
    const { appId, plan } = await this.#createSandboxApp(request, auth, space, {
      name: input.name,
      handle,
      description: input.description ?? null,
      definition: result.definition,
      notes: result.notes,
      action: 'app.create',
    });
    return {
      appId,
      plan: {
        revision: 1,
        destructive: false,
        steps: plan.steps.map(({ kind, description, destructive }) => ({ kind, description, destructive })),
        notes: [...result.notes],
      },
    };
  }

  /**
   * A working copy of a team app in the builder's personal space (design §3): the team app's
   * main line, with the same stable IDs, in a sandbox of its own. It never holds Prod data.
   */
  async createWorkingCopy(request: FastifyRequest, auth: AuthContext, team: AppRef, personal: SpaceRow, definition: StoredDefinition): Promise<string> {
    const taken = new Set(
      (
        await this.#ctx.db
          .select({ handle: apps.handle })
          .from(apps)
          .where(and(eq(apps.spaceId, personal.id), eq(apps.status, 'active'), like(apps.handle, `${team.app.handle}%`)))
      ).map((row) => row.handle),
    );
    let handle = team.app.handle;
    for (let n = 1; taken.has(handle); n++) handle = `${team.app.handle.slice(0, 50)}_copy${n > 1 ? n : ''}`;
    const { appId } = await this.#createSandboxApp(request, auth, personal, {
      name: team.app.name,
      handle,
      description: team.app.description,
      definition,
      notes: [],
      action: 'app.working_copy.create',
      workingCopyOf: { appId: team.app.id, revision: team.app.currentRevision },
    });
    return appId;
  }

  async #createSandboxApp(
    request: FastifyRequest,
    auth: AuthContext,
    space: SpaceRow,
    input: {
      readonly name: string;
      readonly handle: string;
      readonly description: string | null;
      readonly definition: StoredDefinition;
      readonly notes: readonly string[];
      readonly action: string;
      readonly workingCopyOf?: { readonly appId: string; readonly revision: number };
    },
  ): Promise<{ appId: string; plan: MigrationPlan }> {
    const ctx = this.#ctx;
    const now = ctx.now();
    const appId = uuidv7(now.getTime());
    const envId = uuidv7(now.getTime());
    const names = environmentNames(appId, 'sandbox');
    const plan = planMigration(undefined, input.definition, names);
    const audit = auditScopeFor(request, ctx.org.id, now);
    try {
      await withTransaction(ctx.pool, async (client, db) => {
        await db.insert(apps).values({
          id: appId,
          orgId: ctx.org.id,
          spaceId: space.id,
          handle: input.handle,
          name: input.name,
          description: input.description,
          ownerUserId: space.ownerUserId!,
          currentRevision: 1,
          workingCopyOf: input.workingCopyOf?.appId ?? null,
          baseRevision: input.workingCopyOf?.revision ?? null,
          createdBy: auth.actor.id,
          createdAt: now,
          updatedAt: now,
        });
        await this.#insertRevision(db, appId, 1, input.definition, plan, input.notes, auth, now);
        await db.insert(appEnvironments).values({
          id: envId,
          appId,
          kind: 'sandbox',
          schemaName: names.schema,
          dbRole: names.role,
          appliedRevision: 1,
          activeRevision: 1,
          createdAt: now,
        });
        for (const statement of [...provisionEnvironment(names), ...plan.statements]) await client.query(statement);
        await planSchedules(db, ctx.org.id, { id: envId, appId, kind: 'sandbox' }, input.definition, now);
        await recordAudit(db, audit, {
          action: input.action,
          target: { type: 'app', id: appId, name: input.name },
          spaceId: space.id,
          appId,
          env: 'sandbox',
          changes: {
            after: {
              name: input.name,
              handle: input.handle,
              revision: 1,
              digest: digestOf(input.definition),
              ...(input.workingCopyOf ? { workingCopyOf: input.workingCopyOf.appId, baseRevision: input.workingCopyOf.revision } : {}),
            },
          },
        });
      });
    } catch (error) {
      const { constraint } = pgCode(error);
      if (constraint === 'apps_space_handle_uq') throw conflict('handle_taken', `Another app in this space is already called ${input.handle}`);
      if (constraint === 'apps_one_working_copy_uq') throw conflict('working_copy_exists', 'You already have a working copy of this app');
      throw error;
    }
    return { appId, plan };
  }

  /** An empty team app, whose content arrives through a change request: for promotion and import (design §3). */
  async createEmptyTeamApp(
    request: FastifyRequest,
    auth: AuthContext,
    space: SpaceRow,
    input: { readonly name: string; readonly description?: string; readonly promotedFrom?: string },
  ): Promise<string> {
    const handle = handleFrom(input.name);
    if (!NAME_PATTERN.test(handle)) throw unprocessable('invalid_handle', 'Give the app a name that starts with a letter');
    return this.#createTeamApp(request, auth, space, { ...input, handle });
  }

  async #createTeamApp(
    request: FastifyRequest,
    auth: AuthContext,
    space: SpaceRow,
    input: { readonly name: string; readonly handle: string; readonly description?: string; readonly promotedFrom?: string },
  ): Promise<string> {
    const ctx = this.#ctx;
    const now = ctx.now();
    const appId = uuidv7(now.getTime());
    const definition = validateDefinition({});
    if (!definition.ok) throw new Error('The empty definition is invalid');
    try {
      await ctx.db.transaction(async (db) => {
        await db.insert(apps).values({
          id: appId,
          orgId: ctx.org.id,
          spaceId: space.id,
          handle: input.handle,
          name: input.name,
          description: input.description ?? null,
          ownerUserId: auth.actor.id,
          currentRevision: 1,
          promotedFrom: input.promotedFrom ?? null,
          createdBy: auth.actor.id,
          createdAt: now,
          updatedAt: now,
        });
        await this.#insertRevision(
          db,
          appId,
          1,
          definition.definition,
          planMigration(undefined, definition.definition, environmentNames(appId, 'prod')),
          [],
          auth,
          now,
        );
        await recordAudit(db, auditScopeFor(request, ctx.org.id, now), {
          action: 'app.create',
          target: { type: 'app', id: appId, name: input.name },
          spaceId: space.id,
          appId,
          changes: {
            after: {
              name: input.name,
              handle: input.handle,
              revision: 1,
              digest: digestOf(definition.definition),
              team: true,
              ...(input.promotedFrom ? { promotedFrom: input.promotedFrom } : {}),
            },
          },
        });
      });
    } catch (error) {
      const { constraint } = pgCode(error);
      if (constraint === 'apps_space_handle_uq') throw conflict('handle_taken', `Another app in this space is already called ${input.handle}`);
      if (constraint === 'apps_one_promotion_uq') throw conflict('promotion_open', 'This app is moving to a team space already');
      throw error;
    }
    return appId;
  }

  /**
   * Validate a new definition and work out what saving it would do, without saving: the migration
   * steps, how many records each destructive step touches, and the shares a removed role revokes.
   */
  async plan(loaded: LoadedApp, input: unknown): Promise<{ definition: StoredDefinition; migration: MigrationPlan; plan: SavePlan; revokes: string[] }> {
    if (isTeamApp(loaded)) throw changeRequestRequired(loaded);
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
    options: {
      readonly baseRevision?: number;
      readonly confirmDestructive: boolean;
      /** For a working copy that takes in its team app's main line: the main-line revision it is now in step with. */
      readonly syncedTo?: number;
      readonly action?: string;
    },
  ): Promise<SavePlan> {
    const ctx = this.#ctx;
    if (isTeamApp(loaded)) throw changeRequestRequired(loaded);
    if (options.baseRevision !== undefined && options.baseRevision !== loaded.app.currentRevision) {
      throw new HttpError(
        412,
        'revision_mismatch',
        `The app is at revision ${loaded.app.currentRevision}, not ${options.baseRevision}. Reload it and try again.`,
      );
    }
    const { definition, migration, plan, revokes } = await this.plan(loaded, input);
    if (migration.destructive) {
      if (!options.confirmDestructive) {
        throw conflict('destructive_change', 'This change deletes data. Check the plan, then confirm it.', { plan });
      }
      // Agents and scripts may prepare such a change, but only the builder, signed in, can confirm it.
      requirePerson(auth, 'data.delete', { plan });
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
        await tx.db
          .update(apps)
          .set({ currentRevision: plan.revision, updatedAt: now, ...(options.syncedTo !== undefined ? { baseRevision: options.syncedTo } : {}) })
          .where(eq(apps.id, loaded.app.id));
        await tx.db.update(appEnvironments).set({ appliedRevision: plan.revision, activeRevision: plan.revision }).where(eq(appEnvironments.id, loaded.env.id));
        await planSchedules(tx.db, ctx.org.id, { id: loaded.env.id, appId: loaded.app.id, kind: loaded.env.kind }, definition, now);
        for (const bindingId of revokes) {
          await tx.db.update(bindings).set({ revokedAt: now, revokedByType: auth.actor.type, revokedBy: auth.actor.id }).where(eq(bindings.id, bindingId));
        }
        await recordAudit(tx.db, audit, {
          action: options.action ?? 'app.definition.update',
          target: { type: 'app', id: loaded.app.id, name: loaded.app.name },
          spaceId: loaded.space.id,
          appId: loaded.app.id,
          env: loaded.env.kind,
          changes: {
            before: { revision: loaded.app.currentRevision, digest: digestOf(loaded.definition) },
            after: { revision: plan.revision, digest: digestOf(definition), ...(options.syncedTo !== undefined ? { baseRevision: options.syncedTo } : {}) },
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
    requirePerson(auth, 'data.delete');
    if (isTeamApp(loaded)) throw unprocessable('team_app_delete', 'Team apps cannot be deleted yet. A space owner can freeze the space instead.');
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

  /**
   * Give a colleague one of the app's roles in an environment. For a personal app this is sharing
   * it (design §3). For a team app, its environments' access: people or groups per environment,
   * for example QA testers in Staging and approvers in Prod (design §5.5).
   */
  async share(
    request: FastifyRequest,
    auth: AuthContext,
    loaded: LoadedApp,
    input: { readonly email?: string; readonly userId?: string; readonly groupId?: string; readonly role: string; readonly expiresAt?: Date },
  ): Promise<string> {
    const ctx = this.#ctx;
    const team = isTeamApp(loaded);
    if (!loaded.definition.roles[input.role]) throw unprocessable('unknown_role', `The app has no role named ${input.role} in ${loaded.env.kind}`);
    let principal: { type: 'user' | 'group'; id: string };
    if (input.groupId) {
      if (!team) throw unprocessable('groups_in_team_apps', 'Personal apps are shared with named people. Give groups access in a team app.');
      const [group] = await ctx.db
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.orgId, ctx.org.id), eq(groups.id, input.groupId)));
      if (!group) throw unprocessable('unknown_group', 'No group has that ID');
      principal = { type: 'group', id: group.id };
    } else {
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
      if (!team && person.id === loaded.app.ownerUserId) throw unprocessable('owner', 'You own this app already');
      principal = { type: 'user', id: person.id };
    }
    if (!team) {
      const current = await ctx.db
        .select({ principalId: bindings.principalId })
        .from(bindings)
        .where(and(eq(bindings.scopeType, 'env'), eq(bindings.scopeId, loaded.env.id), isNull(bindings.revokedAt), isNotNull(bindings.appRoleId)));
      const people = new Set(current.map((row) => row.principalId));
      if (!people.has(principal.id) && people.size >= ctx.config.PERSONAL_APP_MAX_SHARES) {
        throw unprocessable(
          'too_many_shares',
          `A personal app can be shared with at most ${ctx.config.PERSONAL_APP_MAX_SHARES} people. Consider moving it to a team space.`,
        );
      }
    }
    const now = ctx.now();
    const bindingId = uuidv7(now.getTime());
    try {
      await ctx.db.transaction(async (tx) => {
        await tx.insert(bindings).values({
          id: bindingId,
          orgId: ctx.org.id,
          principalType: principal.type,
          principalId: principal.id,
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
          changes: {
            after: { [principal.type === 'user' ? 'userId' : 'groupId']: principal.id, role: input.role, expiresAt: input.expiresAt?.toISOString() ?? null },
          },
        });
      });
    } catch (error) {
      if (pgCode(error).constraint === 'bindings_active_app_role_uq') throw conflict('already_shared', `They already have the ${input.role} role here`);
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
        .where(
          and(
            eq(bindings.id, bindingId),
            eq(bindings.scopeType, 'env'),
            eq(bindings.scopeId, loaded.env.id),
            isNull(bindings.revokedAt),
            isNotNull(bindings.appRoleId),
          ),
        )
        .returning();
      if (!revoked) throw notFound('Share');
      await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
        action: 'app.unshare',
        target: { type: 'binding', id: bindingId },
        spaceId: loaded.space.id,
        appId: loaded.app.id,
        env: loaded.env.kind,
        changes: {
          before: { [revoked.principalType === 'group' ? 'groupId' : 'userId']: revoked.principalId, role: appRoleName(loaded.app.id, revoked.appRoleId!) },
        },
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
    await insertRevision(db, { appId, revision, definition, steps: plan.steps, notes, auth, now });
  }
}

/** Store a revision of an app's definition: on its main line, or the head of a change request. */
export async function insertRevision(
  db: Database,
  input: {
    readonly appId: string;
    readonly revision: number;
    readonly definition: StoredDefinition;
    readonly steps: ReadonlyArray<{ readonly kind: string; readonly description: string; readonly destructive: boolean }>;
    readonly notes: readonly string[];
    readonly auth: AuthContext;
    readonly now: Date;
    readonly changeRequestId?: string;
  },
): Promise<void> {
  await db.insert(appRevisions).values({
    appId: input.appId,
    revision: input.revision,
    definition: input.definition as unknown as Record<string, unknown>,
    digest: digestOf(input.definition),
    summary: { steps: input.steps.map(({ kind, description, destructive }) => ({ kind, description, destructive })), notes: [...input.notes] },
    changeRequestId: input.changeRequestId ?? null,
    createdByType: input.auth.actor.type,
    createdBy: input.auth.actor.id,
    createdAt: input.now,
  });
}
