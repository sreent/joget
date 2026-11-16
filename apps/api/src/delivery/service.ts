import { canonicalJson, sha256Hex, uuidv7 } from '@platform/audit';
import {
  accessChanges,
  appRoleId,
  appRoleName,
  capabilityChanges,
  diffDefinitions,
  dropEnvironment,
  environmentNames,
  ident,
  lintDefinition,
  mergeDefinitions,
  planMigration,
  provisionEnvironment,
  recomputeRollups,
  tableName,
  validateDefinition,
  type AccessChange,
  type CapabilityChange,
  type DefinitionChange,
  type EnvironmentNames,
  type MergeConflict,
  type StoredDefinition,
} from '@platform/app-model';
import {
  appEnvironments,
  appRevisions,
  apps,
  bindings,
  changeRequests,
  changeReviews,
  deploymentApprovals,
  deployments,
  releases,
  spaces,
  users,
  type Database,
} from '@platform/db';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, max, ne } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { checkPermission } from '../access/check.js';
import { spaceResource } from '../access/resources.js';
import { digestOf, insertRevision, type AppBuilder, type PlannedStep } from '../apps/builder.js';
import { isTeamApp, type AppRef, type EnvironmentRow, type LoadedApp } from '../apps/catalog.js';
import type { AppRuntime } from '../apps/runtime.js';
import { pgError } from '../apps/pg-errors.js';
import { lockEnvironment, withTransaction } from '../apps/transaction.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext, AuthContext } from '../context.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { addSampleRecords } from './samples.js';

export type ChangeRequestRow = typeof changeRequests.$inferSelect;
export type ReleaseRow = typeof releases.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
type EnvKind = 'staging' | 'prod';

/** The automatic checks of a change request's head (design §6.7). */
export interface ChangeChecks {
  readonly validation: { readonly ok: true; readonly notes: readonly string[] };
  /** The migration Prod would need, from the base: destructive steps are flagged. */
  readonly migration: { readonly destructive: boolean; readonly steps: readonly PlannedStep[] };
  /** Who gains or loses access, with how many hold each role in Staging and Prod now. */
  readonly access: ReadonlyArray<AccessChange & { readonly holders: number }>;
  readonly capabilities: readonly CapabilityChange[];
  readonly lint: readonly string[];
}

/** Where review stands: approvals on the current head, and who asked for changes. */
export interface ApprovalState {
  readonly required: number;
  readonly approvedBy: readonly string[];
  readonly changesRequestedBy: readonly string[];
  readonly ready: boolean;
}

/** What a deployment would do to an environment. */
interface DeploymentPlan {
  readonly steps: PlannedStep[];
  readonly notes: string[];
  readonly destructive: boolean;
  readonly statements: string[];
  readonly revokes: string[];
}

const envName = (kind: EnvKind) => (kind === 'prod' ? 'Prod' : 'Staging');
const stepsOf = (steps: readonly { kind: string; description: string; destructive: boolean }[]): PlannedStep[] =>
  steps.map(({ kind, description, destructive }) => ({ kind, description, destructive }));

/** What a release signs: everything that makes it what it is. */
export function releaseManifest(release: Pick<ReleaseRow, 'appId' | 'number' | 'revision' | 'digest' | 'previousReleaseId' | 'destructive' | 'contents'>) {
  return {
    kind: 'ambit.release/v1',
    appId: release.appId,
    number: release.number,
    revision: release.revision,
    digest: release.digest,
    previousReleaseId: release.previousReleaseId,
    destructive: release.destructive,
    contents: release.contents,
  };
}

/**
 * Governed delivery for team apps (design §3, §6.7 and §7.1): working copies in builders'
 * personal spaces, change requests with checks and previews, review with separation of duties,
 * immutable signed releases, deployments with approvals, and rollback.
 */
export class Delivery {
  readonly #ctx: AppContext;
  readonly #builder: AppBuilder;
  readonly #runtime: AppRuntime;

  constructor(ctx: AppContext, builder: AppBuilder, runtime: AppRuntime) {
    this.#ctx = ctx;
    this.#builder = builder;
    this.#runtime = runtime;
  }

  // ---- Working copies -------------------------------------------------------------------------

  /** The caller's working copy of a team app, made on first use with sample records (design §3). */
  async workingCopy(request: FastifyRequest, auth: AuthContext, team: AppRef): Promise<{ appId: string; created: boolean; samples: number }> {
    const ctx = this.#ctx;
    if (!isTeamApp(team)) throw unprocessable('not_a_team_app', 'Only team apps have working copies. Change a personal app directly.');
    const [existing] = await ctx.db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.workingCopyOf, team.app.id), eq(apps.ownerUserId, auth.actor.id), eq(apps.status, 'active')));
    if (existing) return { appId: existing.id, created: false, samples: 0 };
    const [personal] = await ctx.db.select().from(spaces).where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, auth.actor.id)));
    if (!personal) throw notFound('Personal space');
    await checkPermission(ctx, request, auth, 'app.create', spaceResource(ctx.org.id, personal));
    const appId = await this.#builder.createWorkingCopy(request, auth, team, personal, await ctx.apps.mainDefinition(team));
    const samples = await addSampleRecords(this.#runtime, request, auth, await ctx.apps.load(appId), ctx.now());
    return { appId, created: true, samples };
  }

  /**
   * Take the team app's newer main-line changes into a working copy: a three-way merge from the
   * revision the copy last took in. Conflicts are reported, and nothing changes.
   */
  async sync(request: FastifyRequest, auth: AuthContext, copy: LoadedApp, options: { readonly confirmDestructive: boolean }) {
    const ctx = this.#ctx;
    if (!copy.app.workingCopyOf) throw unprocessable('not_a_working_copy', 'Only a working copy takes in changes from a team app');
    const team = await ctx.apps.ref(copy.app.workingCopyOf);
    if (team.app.currentRevision === copy.app.baseRevision) return { plan: null, revision: copy.app.currentRevision };
    const [base, theirs] = await Promise.all([ctx.apps.definition(team.app.id, copy.app.baseRevision!), ctx.apps.mainDefinition(team)]);
    const merged = mergeDefinitions(base, copy.definition, theirs);
    if (!merged.ok) {
      throw conflict('merge_conflict', 'You and the team app changed the same parts. Change yours to match, or ask the author of the other change.', {
        conflicts: merged.conflicts,
      });
    }
    const plan = await this.#builder.save(request, auth, copy, merged.definition, {
      confirmDestructive: options.confirmDestructive,
      syncedTo: team.app.currentRevision,
      action: 'app.working_copy.sync',
    });
    return { plan, revision: plan.revision };
  }

  // ---- Change requests ------------------------------------------------------------------------

  /**
   * Submit a working copy's changes: open a change request in the team space, or bring the open
   * one up to date. The head becomes a revision off the main line, and a preview runs it.
   */
  async submit(request: FastifyRequest, auth: AuthContext, copy: LoadedApp, input: { readonly title?: string; readonly description?: string }): Promise<ChangeRequestRow> {
    const ctx = this.#ctx;
    if (!copy.app.workingCopyOf) throw unprocessable('not_a_working_copy', 'Submit changes from a working copy of a team app');
    if (copy.app.ownerUserId !== auth.actor.id) throw forbidden('not_your_working_copy', 'Only the builder whose working copy this is can submit it');
    const team = await ctx.apps.ref(copy.app.workingCopyOf);
    const base = await ctx.apps.definition(team.app.id, copy.app.baseRevision!);
    const validated = validateDefinition(copy.definition, base);
    if (!validated.ok) throw unprocessable('invalid_definition', 'The working copy has problems', { issues: validated.issues });
    const head = validated.definition;
    const headDigest = digestOf(head);
    if (headDigest === digestOf(base)) throw unprocessable('no_changes', 'Your working copy has no changes to submit');
    const checks = await this.#checks(team, base, head, validated.notes);
    const now = ctx.now();
    const audit = auditScopeFor(request, ctx.org.id, now);

    try {
      return await withTransaction(ctx.pool, async (client, db) => {
        await db.select({ id: apps.id }).from(apps).where(eq(apps.id, team.app.id)).for('update');
        const [open] = await db
          .select()
          .from(changeRequests)
          .where(and(eq(changeRequests.workingCopyId, copy.app.id), eq(changeRequests.status, 'open')))
          .for('update');
        if (open && open.headDigest === headDigest && open.baseRevision === copy.app.baseRevision) {
          throw unprocessable('no_new_changes', `Change request #${open.number} already holds exactly these changes`);
        }
        const revision = await this.#nextRevision(db, team.app.id);
        const id = open?.id ?? uuidv7(now.getTime());
        const number = open?.number ?? (await this.#nextNumber(db, team.app.id));
        await insertRevision(db, {
          appId: team.app.id,
          revision,
          definition: head,
          steps: checks.migration.steps,
          notes: validated.notes,
          auth,
          now,
          changeRequestId: id,
        });
        let row: ChangeRequestRow;
        if (open) {
          [row] = (await db
            .update(changeRequests)
            .set({
              ...(input.title ? { title: input.title } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              baseRevision: copy.app.baseRevision!,
              headRevision: revision,
              headDigest,
              checks: checks as unknown as Record<string, unknown>,
              updatedAt: now,
            })
            .where(eq(changeRequests.id, open.id))
            .returning()) as [ChangeRequestRow];
          await this.#updatePreview(client, db, team, row, await ctx.apps.definition(team.app.id, open.headRevision, db), head, revision);
        } else {
          [row] = (await db
            .insert(changeRequests)
            .values({
              id,
              orgId: ctx.org.id,
              spaceId: team.space.id,
              appId: team.app.id,
              number,
              workingCopyId: copy.app.id,
              title: input.title?.trim() || `Change from ${auth.actor.name ?? auth.actor.email ?? 'a builder'}`,
              description: input.description ?? null,
              baseRevision: copy.app.baseRevision!,
              headRevision: revision,
              headDigest,
              checks: checks as unknown as Record<string, unknown>,
              authorId: auth.actor.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning()) as [ChangeRequestRow];
          await this.#createPreview(client, db, team, row, head, revision, now);
        }
        await recordAudit(db, audit, {
          action: open ? 'change.update' : 'change.open',
          target: { type: 'change_request', id: row.id, name: `#${row.number} ${row.title}` },
          spaceId: team.space.id,
          appId: team.app.id,
          changes: {
            after: { number: row.number, baseRevision: row.baseRevision, headRevision: revision, headDigest, workingCopyId: copy.app.id },
            destructive: checks.migration.destructive,
          },
        });
        return row;
      });
    } catch (error) {
      if (pgError(error).constraint === 'change_requests_one_open_per_copy_uq') throw conflict('change_request_open', 'This working copy already has an open change request');
      throw error;
    }
  }

  async #checks(team: AppRef, base: StoredDefinition, head: StoredDefinition, notes: readonly string[]): Promise<ChangeChecks> {
    const migration = planMigration(base, head, environmentNames(team.app.id, 'prod'));
    const envIds = (
      await this.#ctx.db
        .select({ id: appEnvironments.id })
        .from(appEnvironments)
        .where(and(eq(appEnvironments.appId, team.app.id), eq(appEnvironments.status, 'active'), inArray(appEnvironments.kind, ['staging', 'prod'])))
    ).map((row) => row.id);
    const holders = new Map<string, number>();
    if (envIds.length) {
      const rows = await this.#ctx.db
        .select({ role: bindings.appRoleId, n: count() })
        .from(bindings)
        .where(and(eq(bindings.scopeType, 'env'), inArray(bindings.scopeId, envIds), isNull(bindings.revokedAt), isNotNull(bindings.appRoleId)))
        .groupBy(bindings.appRoleId);
      for (const row of rows) holders.set(row.role!, Number(row.n));
    }
    return {
      validation: { ok: true, notes: [...notes] },
      migration: { destructive: migration.destructive, steps: stepsOf(migration.steps) },
      access: accessChanges(base, head).map((change) => ({ ...change, holders: holders.get(appRoleId(team.app.id, change.role)) ?? 0 })),
      capabilities: capabilityChanges(base, head),
      lint: lintDefinition(head),
    };
  }

  /** A preview: a temporary environment that runs the change, for reviewers to click through (design §3). */
  async #createPreview(client: pg.PoolClient, db: Database, team: AppRef, cr: ChangeRequestRow, head: StoredDefinition, revision: number, now: Date): Promise<void> {
    const names = environmentNames(team.app.id, 'preview', cr.number);
    const envId = uuidv7(now.getTime());
    await db.insert(appEnvironments).values({
      id: envId,
      appId: team.app.id,
      kind: 'preview',
      schemaName: names.schema,
      dbRole: names.role,
      appliedRevision: revision,
      activeRevision: revision,
      changeRequestId: cr.id,
      createdAt: now,
    });
    for (const statement of [...provisionEnvironment(names), ...planMigration(undefined, head, names).statements]) await client.query(statement);
  }

  /** Bring a preview up to a new head. Its data is for trying things out, so a change that deletes some may. */
  async #updatePreview(client: pg.PoolClient, db: Database, team: AppRef, cr: ChangeRequestRow, previous: StoredDefinition, head: StoredDefinition, revision: number): Promise<void> {
    const [env] = await db.select().from(appEnvironments).where(and(eq(appEnvironments.changeRequestId, cr.id), eq(appEnvironments.status, 'active')));
    if (!env) {
      await this.#createPreview(client, db, team, cr, head, revision, this.#ctx.now());
      return;
    }
    const names = { schema: env.schemaName, role: env.dbRole };
    await lockEnvironment(client, env.id);
    await client.query('savepoint preview_migration');
    try {
      for (const statement of planMigration(previous, head, names).statements) await client.query(statement);
      await client.query('release savepoint preview_migration');
    } catch {
      // Test data that the new head can't hold, such as duplicates in a field that is now unique: start the preview afresh.
      await client.query('rollback to savepoint preview_migration');
      for (const statement of [...dropEnvironment(names), ...provisionEnvironment(names), ...planMigration(undefined, head, names).statements]) {
        await client.query(statement);
      }
    }
    await db.update(appEnvironments).set({ appliedRevision: revision, activeRevision: revision }).where(eq(appEnvironments.id, env.id));
  }

  async #dropPreview(client: pg.PoolClient, db: Database, cr: ChangeRequestRow): Promise<void> {
    const [env] = await db.select().from(appEnvironments).where(and(eq(appEnvironments.changeRequestId, cr.id), eq(appEnvironments.status, 'active')));
    if (!env) return;
    await lockEnvironment(client, env.id);
    for (const statement of dropEnvironment({ schema: env.schemaName, role: env.dbRole })) await client.query(statement);
    await db.update(appEnvironments).set({ status: 'deleted' }).where(eq(appEnvironments.id, env.id));
    await db
      .update(bindings)
      .set({ revokedAt: this.#ctx.now(), revokedByType: 'system', revokedBy: null })
      .where(and(eq(bindings.scopeType, 'env'), eq(bindings.scopeId, env.id), isNull(bindings.revokedAt)));
  }

  async changeRequest(id: string): Promise<ChangeRequestRow> {
    const [row] = await this.#ctx.db.select().from(changeRequests).where(and(eq(changeRequests.id, id), eq(changeRequests.orgId, this.#ctx.org.id)));
    if (!row) throw notFound('Change request');
    return row;
  }

  async reviewsOf(cr: ChangeRequestRow) {
    return this.#ctx.db.select().from(changeReviews).where(eq(changeReviews.changeRequestId, cr.id)).orderBy(asc(changeReviews.createdAt), asc(changeReviews.id));
  }

  /** Approvals count only for the head they reviewed; a reviewer's latest verdict on it stands. */
  approvalState(cr: ChangeRequestRow, reviews: ReadonlyArray<typeof changeReviews.$inferSelect>): ApprovalState {
    const latest = new Map<string, 'approve' | 'request_changes'>();
    for (const review of reviews) {
      if (review.headDigest !== cr.headDigest || review.verdict === 'comment') continue;
      latest.set(review.reviewerId, review.verdict);
    }
    const approvedBy = [...latest].filter(([, verdict]) => verdict === 'approve').map(([id]) => id);
    const changesRequestedBy = [...latest].filter(([, verdict]) => verdict === 'request_changes').map(([id]) => id);
    const required = this.#ctx.config.CHANGE_APPROVALS;
    return { required, approvedBy, changesRequestedBy, ready: approvedBy.length >= required && changesRequestedBy.length === 0 };
  }

  /** What a change request shows: its changes against its base, and any conflict with a newer main line. */
  async compare(cr: ChangeRequestRow): Promise<{ changes: DefinitionChange[]; conflicts: readonly MergeConflict[]; behind: boolean }> {
    const ctx = this.#ctx;
    const team = await ctx.apps.ref(cr.appId);
    const [base, head] = await Promise.all([ctx.apps.definition(cr.appId, cr.baseRevision), ctx.apps.definition(cr.appId, cr.headRevision)]);
    const changes = diffDefinitions(base, head);
    const behind = cr.status === 'open' && team.app.currentRevision !== cr.baseRevision;
    if (!behind) return { changes, conflicts: [], behind };
    const merged = mergeDefinitions(base, head, await ctx.apps.mainDefinition(team));
    return { changes, conflicts: merged.ok ? [] : merged.conflicts, behind };
  }

  async review(
    request: FastifyRequest,
    auth: AuthContext,
    cr: ChangeRequestRow,
    input: { readonly verdict: 'approve' | 'request_changes' | 'comment'; readonly comment?: string },
  ): Promise<void> {
    const ctx = this.#ctx;
    if (cr.status !== 'open') throw conflict('not_open', `Change request #${cr.number} is ${cr.status}`);
    // The guardrail has said so already; this keeps the rule even if it is disabled.
    if (input.verdict === 'approve' && cr.authorId === auth.actor.id) throw forbidden('author_cannot_approve', 'Someone other than the author must approve a change');
    if (input.verdict !== 'approve' && !input.comment?.trim()) throw unprocessable('comment_required', 'Say what should change, or what you noticed');
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      const id = uuidv7(now.getTime());
      await tx.insert(changeReviews).values({
        id,
        changeRequestId: cr.id,
        reviewerId: auth.actor.id,
        verdict: input.verdict,
        headDigest: cr.headDigest,
        comment: input.comment?.trim() || null,
        createdAt: now,
      });
      await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
        action: input.verdict === 'approve' ? 'change.approve' : 'change.review',
        target: { type: 'change_request', id: cr.id, name: `#${cr.number} ${cr.title}` },
        spaceId: cr.spaceId,
        appId: cr.appId,
        changes: { after: { verdict: input.verdict, headDigest: cr.headDigest } },
      });
    });
  }

  /**
   * Merge an approved change into the main line. If the main line moved on, merge three ways at
   * the artifact level; a conflict refuses the merge, and the author brings their copy up to date.
   */
  async merge(request: FastifyRequest, auth: AuthContext, cr: ChangeRequestRow): Promise<ChangeRequestRow> {
    const ctx = this.#ctx;
    if (cr.status !== 'open') throw conflict('not_open', `Change request #${cr.number} is ${cr.status}`);
    const state = this.approvalState(cr, await this.reviewsOf(cr));
    if (!state.ready) {
      throw conflict(
        'not_approved',
        state.changesRequestedBy.length
          ? 'A reviewer asked for changes. The author updates the change, then it is reviewed again.'
          : `The change needs ${state.required} approval(s) of its current version from someone other than its author`,
        { approvals: state },
      );
    }
    const team = await ctx.apps.ref(cr.appId);
    const now = ctx.now();
    return withTransaction(ctx.pool, async (client, db) => {
      const [locked] = await db.select().from(apps).where(eq(apps.id, team.app.id)).for('update');
      const [current] = await db.select().from(changeRequests).where(eq(changeRequests.id, cr.id)).for('update');
      if (current!.status !== 'open' || current!.headDigest !== cr.headDigest) throw conflict('changed', 'The change request changed meanwhile. Look at it again.');
      const main = await ctx.apps.definition(team.app.id, locked!.currentRevision, db);
      const head = await ctx.apps.definition(team.app.id, cr.headRevision, db);
      const fastForward = locked!.currentRevision === cr.baseRevision;
      let merged = head;
      if (!fastForward) {
        const result = mergeDefinitions(await ctx.apps.definition(team.app.id, cr.baseRevision, db), head, main);
        if (!result.ok) {
          throw conflict('merge_conflict', 'The team app changed the same parts since this change began. The author updates their working copy and submits again.', {
            conflicts: result.conflicts,
          });
        }
        const valid = validateDefinition(result.definition, main);
        if (!valid.ok) {
          throw conflict('merge_invalid', 'Together with the newer changes of the team app, this change breaks something. The author updates their working copy and submits again.', {
            issues: valid.issues,
          });
        }
        merged = valid.definition;
      }
      const revision = await this.#nextRevision(db, team.app.id);
      const plan = planMigration(main, merged, environmentNames(team.app.id, 'prod'));
      await insertRevision(db, { appId: team.app.id, revision, definition: merged, steps: plan.steps, notes: [`Change request #${cr.number}: ${cr.title}`], auth, now });
      await db.update(apps).set({ currentRevision: revision, updatedAt: now }).where(eq(apps.id, team.app.id));
      const [row] = (await db
        .update(changeRequests)
        .set({ status: 'merged', mergedRevision: revision, mergedAt: now, mergedByType: auth.actor.type, mergedBy: auth.actor.id, updatedAt: now })
        .where(eq(changeRequests.id, cr.id))
        .returning()) as [ChangeRequestRow];
      await this.#dropPreview(client, db, cr);
      // The author's copy is now in step with the main line, unless the merge took in other changes it lacks.
      if (fastForward && cr.workingCopyId) {
        await db
          .update(apps)
          .set({ baseRevision: revision })
          .where(and(eq(apps.id, cr.workingCopyId), eq(apps.status, 'active'), eq(apps.baseRevision, cr.baseRevision)));
      }
      await recordAudit(db, auditScopeFor(request, ctx.org.id, now), {
        action: 'change.merge',
        target: { type: 'change_request', id: cr.id, name: `#${cr.number} ${cr.title}` },
        spaceId: team.space.id,
        appId: team.app.id,
        changes: {
          before: { revision: locked!.currentRevision, digest: digestOf(main) },
          after: { revision, digest: digestOf(merged) },
          threeWay: !fastForward,
          approvedBy: state.approvedBy,
        },
      });
      return row;
    });
  }

  async close(request: FastifyRequest, auth: AuthContext, cr: ChangeRequestRow): Promise<ChangeRequestRow> {
    const ctx = this.#ctx;
    if (cr.status !== 'open') throw conflict('not_open', `Change request #${cr.number} is ${cr.status}`);
    const now = ctx.now();
    return withTransaction(ctx.pool, async (client, db) => {
      const [row] = (await db
        .update(changeRequests)
        .set({ status: 'closed', closedAt: now, closedByType: auth.actor.type, closedBy: auth.actor.id, updatedAt: now })
        .where(and(eq(changeRequests.id, cr.id), eq(changeRequests.status, 'open')))
        .returning()) as [ChangeRequestRow | undefined];
      if (!row) throw conflict('not_open', `Change request #${cr.number} is no longer open`);
      await this.#dropPreview(client, db, cr);
      await recordAudit(db, auditScopeFor(request, ctx.org.id, now), {
        action: 'change.close',
        target: { type: 'change_request', id: cr.id, name: `#${cr.number} ${cr.title}` },
        spaceId: cr.spaceId,
        appId: cr.appId,
      });
      return row;
    });
  }

  async #nextRevision(db: Database, appId: string): Promise<number> {
    const [row] = await db.select({ n: max(appRevisions.revision) }).from(appRevisions).where(eq(appRevisions.appId, appId));
    return (row?.n ?? 0) + 1;
  }

  async #nextNumber(db: Database, appId: string): Promise<number> {
    const [row] = await db.select({ n: max(changeRequests.number) }).from(changeRequests).where(eq(changeRequests.appId, appId));
    return (row?.n ?? 0) + 1;
  }

  // ---- Releases -------------------------------------------------------------------------------

  /**
   * Cut a release: one main-line revision, hashed and signed, which never changes. A change that
   * deletes data goes in a release of its own, because a rollback can't bring data back.
   */
  async cutRelease(request: FastifyRequest, auth: AuthContext, team: AppRef, input: { readonly revision?: number; readonly notes?: string }): Promise<ReleaseRow> {
    const ctx = this.#ctx;
    const now = ctx.now();
    const names = environmentNames(team.app.id, 'prod');
    return withTransaction(ctx.pool, async (_client, db) => {
      const [locked] = await db.select().from(apps).where(eq(apps.id, team.app.id)).for('update');
      const revision = input.revision ?? locked!.currentRevision;
      const [onMainLine] = await db
        .select({ revision: appRevisions.revision })
        .from(appRevisions)
        .where(and(eq(appRevisions.appId, team.app.id), eq(appRevisions.revision, revision), isNull(appRevisions.changeRequestId)));
      if (!onMainLine) throw unprocessable('not_on_main_line', `Revision ${revision} is not on the main line of ${team.app.name}`);
      const [previous] = await db.select().from(releases).where(eq(releases.appId, team.app.id)).orderBy(desc(releases.number)).limit(1);
      if (previous && revision <= previous.revision) {
        throw conflict('nothing_new', `Release ${previous.number} already holds revision ${previous.revision}. Merge a change first.`);
      }
      const definition = await ctx.apps.definition(team.app.id, revision, db);
      const before = previous ? await ctx.apps.definition(team.app.id, previous.revision, db) : undefined;
      const plan = planMigration(before, definition, names);
      const changes = await db
        .select({ id: changeRequests.id, number: changeRequests.number, title: changeRequests.title, authorId: changeRequests.authorId, revision: changeRequests.mergedRevision })
        .from(changeRequests)
        .where(
          and(
            eq(changeRequests.appId, team.app.id),
            eq(changeRequests.status, 'merged'),
            gt(changeRequests.mergedRevision, previous?.revision ?? 0),
            lte(changeRequests.mergedRevision, revision),
          ),
        )
        .orderBy(asc(changeRequests.mergedRevision));
      if (plan.destructive && changes.length > 1) {
        let from = before;
        const deleting: typeof changes = [];
        for (const change of changes) {
          const at = await ctx.apps.definition(team.app.id, change.revision!, db);
          if (planMigration(from, at, names).destructive) deleting.push(change);
          from = at;
        }
        const first = deleting[0] ?? changes[0]!;
        const earlier = changes.filter((change) => change.revision! < first.revision!);
        const suggestedRevision = earlier.length ? earlier.at(-1)!.revision! : first.revision!;
        throw conflict(
          'destructive_change_alone',
          `Change #${first.number} deletes data, so it goes in a release of its own: a rollback can't bring data back. ` +
            (earlier.length
              ? `Release revision ${suggestedRevision} first (${earlier.map((c) => `#${c.number}`).join(', ')}), then revision ${first.revision} on its own.`
              : `Release revision ${first.revision} (#${first.number}) on its own first.`),
          { deleting: deleting.map(({ id, number, title }) => ({ id, number, title })), suggestedRevision },
        );
      }
      const number = (previous?.number ?? 0) + 1;
      const contents = {
        steps: stepsOf(plan.steps),
        changes: changes.map(({ id, number: n, title, authorId, revision: r }) => ({ id, number: n, title, authorId, revision: r })),
      };
      const fields = { appId: team.app.id, number, revision, digest: digestOf(definition), previousReleaseId: previous?.id ?? null, destructive: plan.destructive, contents };
      const manifestDigest = sha256Hex(canonicalJson(releaseManifest(fields)));
      const signature = (await ctx.auditSigner.sign(Buffer.from(manifestDigest, 'hex'))).toString('base64');
      const [row] = (await db
        .insert(releases)
        .values({
          id: uuidv7(now.getTime()),
          orgId: ctx.org.id,
          spaceId: team.space.id,
          ...fields,
          notes: input.notes?.trim() || null,
          manifestDigest,
          keyId: ctx.auditSigner.keyId,
          signature,
          createdByType: auth.actor.type,
          createdBy: auth.actor.id,
          createdAt: now,
        })
        .returning()) as [ReleaseRow];
      await recordAudit(db, auditScopeFor(request, ctx.org.id, now), {
        action: 'release.create',
        target: { type: 'release', id: row.id, name: `${team.app.name} release ${number}` },
        spaceId: team.space.id,
        appId: team.app.id,
        changes: { after: { number, revision, digest: row.digest, manifestDigest, destructive: plan.destructive, changes: contents.changes.map((c) => c.number) } },
      });
      return row;
    });
  }

  /** True if a release is as it was signed: its manifest, its signature, and the definition it names. */
  async verify(release: ReleaseRow): Promise<boolean> {
    const digest = sha256Hex(canonicalJson(releaseManifest(release)));
    if (digest !== release.manifestDigest) return false;
    const signed = await this.#ctx.auditVerifier.verify(release.keyId, Buffer.from(digest, 'hex'), Buffer.from(release.signature, 'base64'));
    if (signed !== true) return false;
    return digestOf(await this.#ctx.apps.definition(release.appId, release.revision)) === release.digest;
  }

  async release(appId: string, id: string): Promise<ReleaseRow> {
    const [row] = await this.#ctx.db.select().from(releases).where(and(eq(releases.id, id), eq(releases.appId, appId)));
    if (!row) throw notFound('Release');
    return row;
  }

  // ---- Deployments ----------------------------------------------------------------------------

  /** What deploying a release to an environment would do, from the data model it has now. */
  async #plan(db: Database, team: AppRef, kind: EnvKind, env: EnvironmentRow | null, release: ReleaseRow): Promise<DeploymentPlan> {
    const ctx = this.#ctx;
    const next = await ctx.apps.definition(team.app.id, release.revision, db);
    const names: EnvironmentNames = env ? { schema: env.schemaName, role: env.dbRole } : environmentNames(team.app.id, kind);
    const migration = planMigration(env ? await ctx.apps.definition(team.app.id, env.appliedRevision, db) : undefined, next, names);
    const notes: string[] = [];
    const statements = [...migration.statements];
    const counts = new Map<number, number>();
    if (env && migration.impact.length) {
      const client = await ctx.pool.connect();
      try {
        for (const { step, sql } of migration.impact) counts.set(step, (await client.query<{ n: number }>(sql)).rows[0]?.n ?? 0);
      } finally {
        client.release();
      }
    }
    if (!env) notes.push(`Creates ${envName(kind)}: the app's first deployment there`);
    if (env && env.activeRevision !== env.appliedRevision) {
      statements.push(...recomputeRollups(next, names));
      notes.push('Works out stored totals again, because the environment ran an older release for a while');
    }
    let revokes: string[] = [];
    if (env) {
      const held = await db
        .select({ id: bindings.id, role: bindings.appRoleId })
        .from(bindings)
        .where(and(eq(bindings.scopeType, 'env'), eq(bindings.scopeId, env.id), isNull(bindings.revokedAt), isNotNull(bindings.appRoleId)));
      const gone = held.filter((binding) => !next.roles[appRoleName(team.app.id, binding.role!) ?? '']);
      revokes = gone.map((binding) => binding.id);
      if (gone.length) {
        const roles = [...new Set(gone.map((binding) => appRoleName(team.app.id, binding.role!)))].join(', ');
        notes.push(`Takes away ${gone.length} grant(s) of the removed role(s) ${roles}`);
      }
    }
    return {
      steps: migration.steps.map(({ kind: stepKind, description, destructive }, index) => ({
        kind: stepKind,
        description,
        destructive,
        ...(counts.has(index) ? { records: counts.get(index)! } : {}),
      })),
      notes,
      destructive: migration.destructive,
      statements,
      revokes,
    };
  }

  /** Ask to deploy a release to Staging or Prod. Prod waits for approvals; Staging is ready at once. */
  async requestDeployment(
    request: FastifyRequest,
    auth: AuthContext,
    team: AppRef,
    input: { readonly releaseId: string; readonly env: EnvKind; readonly confirmDestructive: boolean },
  ): Promise<DeploymentRow> {
    const ctx = this.#ctx;
    const release = await this.release(team.app.id, input.releaseId);
    const env = await ctx.apps.environment(team, input.env);
    const live = env?.activeReleaseId ? await this.release(team.app.id, env.activeReleaseId) : null;
    if (live && live.number >= release.number) {
      throw conflict(
        live.id === release.id ? 'already_live' : 'older_release',
        live.id === release.id ? `Release ${release.number} is already live in ${envName(input.env)}` : `${envName(input.env)} runs release ${live.number}, which is newer. To go back, roll back.`,
      );
    }
    const [skipped] = await ctx.db
      .select({ number: releases.number })
      .from(releases)
      .where(and(eq(releases.appId, team.app.id), gt(releases.number, live?.number ?? 0), lt(releases.number, release.number), eq(releases.destructive, true)))
      .orderBy(asc(releases.number))
      .limit(1);
    if (skipped) {
      throw conflict('deploy_in_order', `Release ${skipped.number} deletes data, so it goes on its own: deploy it to ${envName(input.env)} first.`);
    }
    if (!(await this.verify(release))) throw conflict('release_not_verified', `Release ${release.number} does not match its signature. Do not deploy it; tell a Security admin.`);
    const plan = await this.#plan(ctx.db, team, input.env, env, release);
    const shown = { steps: plan.steps, notes: plan.notes, destructive: plan.destructive };
    if (plan.destructive) {
      if (!input.confirmDestructive) throw conflict('destructive_change', `This deployment deletes data in ${envName(input.env)}. Check the plan, then confirm it.`, { plan: shown });
      if (auth.credential.kind !== 'session') {
        throw forbidden('session_required', 'A deployment that deletes data must be confirmed by a person in an interactive session.', { plan: shown });
      }
    }
    const approvalsRequired = input.env === 'prod' ? ctx.config.DEPLOY_PROD_APPROVALS : 0;
    const now = ctx.now();
    try {
      return await ctx.db.transaction(async (tx) => {
        const [row] = (await tx
          .insert(deployments)
          .values({
            id: uuidv7(now.getTime()),
            orgId: ctx.org.id,
            spaceId: team.space.id,
            appId: team.app.id,
            environmentKind: input.env,
            environmentId: env?.id ?? null,
            kind: 'deploy',
            releaseId: release.id,
            fromReleaseId: live?.id ?? null,
            status: approvalsRequired > 0 ? 'awaiting_approval' : 'approved',
            plan: { ...shown, appliedRevision: env?.appliedRevision ?? null } as Record<string, unknown>,
            destructive: plan.destructive,
            approvalsRequired,
            requestedByType: auth.actor.type,
            requestedBy: auth.actor.id,
            requestedAt: now,
          })
          .returning()) as [DeploymentRow];
        await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
          action: 'deploy.request',
          target: { type: 'deployment', id: row.id, name: `Release ${release.number} to ${envName(input.env)}` },
          spaceId: team.space.id,
          appId: team.app.id,
          env: input.env,
          changes: { after: { release: release.number, from: live?.number ?? null, destructive: plan.destructive, approvalsRequired, steps: plan.steps } },
        });
        return row;
      });
    } catch (error) {
      if (pgError(error).constraint === 'deployments_one_open_per_env_uq') {
        throw conflict('deployment_open', `Another deployment to ${envName(input.env)} is waiting. Finish or cancel it first.`);
      }
      throw error;
    }
  }

  async deployment(id: string): Promise<DeploymentRow> {
    const [row] = await this.#ctx.db.select().from(deployments).where(and(eq(deployments.id, id), eq(deployments.orgId, this.#ctx.org.id)));
    if (!row) throw notFound('Deployment');
    return row;
  }

  /** Whose changes a deployment carries: none of them may approve it (design §5.7). */
  async authorsOf(deployment: DeploymentRow): Promise<string[]> {
    const ctx = this.#ctx;
    const release = await this.release(deployment.appId, deployment.releaseId);
    const from = deployment.fromReleaseId ? await this.release(deployment.appId, deployment.fromReleaseId) : null;
    const rows = await ctx.db
      .selectDistinct({ authorId: changeRequests.authorId })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.appId, deployment.appId),
          eq(changeRequests.status, 'merged'),
          gt(changeRequests.mergedRevision, from?.revision ?? 0),
          lte(changeRequests.mergedRevision, release.revision),
        ),
      );
    return rows.map((row) => row.authorId);
  }

  async approvalsOf(deployment: DeploymentRow) {
    return this.#ctx.db.select().from(deploymentApprovals).where(eq(deploymentApprovals.deploymentId, deployment.id)).orderBy(asc(deploymentApprovals.createdAt));
  }

  async approveDeployment(request: FastifyRequest, auth: AuthContext, deployment: DeploymentRow): Promise<DeploymentRow> {
    const ctx = this.#ctx;
    if (deployment.status !== 'awaiting_approval') throw conflict('not_awaiting_approval', `This deployment is ${deployment.status.replace('_', ' ')}`);
    const now = ctx.now();
    try {
      return await ctx.db.transaction(async (tx) => {
        await tx.insert(deploymentApprovals).values({ deploymentId: deployment.id, approverId: auth.actor.id, createdAt: now });
        const [{ n }] = (await tx.select({ n: count() }).from(deploymentApprovals).where(eq(deploymentApprovals.deploymentId, deployment.id))) as [{ n: number }];
        const ready = Number(n) >= deployment.approvalsRequired;
        const [row] = (await tx
          .update(deployments)
          .set(ready ? { status: 'approved' } : {})
          .where(and(eq(deployments.id, deployment.id), eq(deployments.status, 'awaiting_approval')))
          .returning()) as [DeploymentRow | undefined];
        if (!row) throw conflict('not_awaiting_approval', 'This deployment no longer waits for approval');
        await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
          action: 'deploy.approve',
          target: { type: 'deployment', id: deployment.id },
          spaceId: deployment.spaceId,
          appId: deployment.appId,
          env: deployment.environmentKind,
          changes: { after: { approvals: Number(n), required: deployment.approvalsRequired, status: row.status } },
        });
        return row;
      });
    } catch (error) {
      if (pgError(error).code === '23505') throw conflict('already_approved', 'You have approved this deployment already');
      throw error;
    }
  }

  /**
   * Execute an approved deployment: apply its migration (expand), check each table answers to
   * the environment's own role, and make the release live, all in one transaction (design §7.1).
   */
  async execute(request: FastifyRequest, auth: AuthContext, deployment: DeploymentRow): Promise<DeploymentRow> {
    const ctx = this.#ctx;
    if (deployment.status === 'awaiting_approval') {
      throw conflict('not_approved', `This deployment needs ${deployment.approvalsRequired} approval(s) from people who authored none of its changes`);
    }
    if (deployment.status !== 'approved') throw conflict('not_pending', `This deployment is ${deployment.status}`);
    const team = await ctx.apps.ref(deployment.appId);
    const release = await this.release(team.app.id, deployment.releaseId);
    const kind = deployment.environmentKind;
    const started = ctx.now();
    const audit = auditScopeFor(request, ctx.org.id, started);
    try {
      return await withTransaction(ctx.pool, async (client, db) => {
        const [locked] = await db.select().from(deployments).where(eq(deployments.id, deployment.id)).for('update');
        if (locked!.status !== 'approved') throw conflict('not_pending', `This deployment is ${locked!.status}`);
        let [env] = await db
          .select()
          .from(appEnvironments)
          .where(and(eq(appEnvironments.appId, team.app.id), eq(appEnvironments.kind, kind), eq(appEnvironments.status, 'active')))
          .for('update');
        const plannedOn = (deployment.plan as { appliedRevision?: number | null }).appliedRevision ?? null;
        if ((env?.id ?? null) !== deployment.environmentId || (env?.appliedRevision ?? null) !== plannedOn || (env?.activeReleaseId ?? null) !== deployment.fromReleaseId) {
          throw conflict('environment_changed', `${envName(kind)} changed since this deployment was planned. Ask for it again.`);
        }
        if (env) await lockEnvironment(client, env.id);
        const plan = await this.#plan(db, team, kind, env ?? null, release);
        if (plan.destructive !== deployment.destructive) throw conflict('environment_changed', `${envName(kind)} changed since this deployment was planned. Ask for it again.`);
        if (!env) {
          const names = environmentNames(team.app.id, kind);
          [env] = (await db
            .insert(appEnvironments)
            .values({
              id: uuidv7(started.getTime()),
              appId: team.app.id,
              kind,
              schemaName: names.schema,
              dbRole: names.role,
              appliedRevision: release.revision,
              activeRevision: release.revision,
              activeReleaseId: release.id,
              createdAt: started,
            })
            .returning()) as [EnvironmentRow];
          for (const statement of provisionEnvironment(names)) await client.query(statement);
        }
        for (const statement of plan.statements) await client.query(statement);
        // A smoke check: every table of the release answers to the environment's own role.
        const definition = await ctx.apps.definition(team.app.id, release.revision, db);
        await client.query(`set local role ${ident(env!.dbRole)}`);
        for (const entity of Object.values(definition.entities)) {
          await client.query(`select 1 from ${ident(env!.schemaName)}.${ident(tableName(entity.id))} limit 1`);
        }
        await client.query('set local role none');
        await db
          .update(appEnvironments)
          .set({ appliedRevision: release.revision, activeRevision: release.revision, activeReleaseId: release.id })
          .where(eq(appEnvironments.id, env!.id));
        if (plan.revokes.length) {
          await db.update(bindings).set({ revokedAt: started, revokedByType: auth.actor.type, revokedBy: auth.actor.id }).where(inArray(bindings.id, plan.revokes));
        }
        const finished = ctx.now();
        const [row] = (await db
          .update(deployments)
          .set({ status: 'succeeded', environmentId: env!.id, executedByType: auth.actor.type, executedBy: auth.actor.id, startedAt: started, finishedAt: finished })
          .where(eq(deployments.id, deployment.id))
          .returning()) as [DeploymentRow];
        await recordAudit(db, audit, {
          action: 'deploy.execute',
          target: { type: 'deployment', id: deployment.id, name: `Release ${release.number} to ${envName(kind)}` },
          spaceId: team.space.id,
          appId: team.app.id,
          env: kind,
          changes: {
            before: { release: deployment.fromReleaseId, revision: plannedOn },
            after: { release: release.id, number: release.number, revision: release.revision },
            steps: plan.steps,
            revokedGrants: plan.revokes,
            durationMs: finished.getTime() - started.getTime(),
          },
        });
        return row;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = ctx.now();
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(deployments)
          .set({ status: 'failed', error: message.slice(0, 2000), executedByType: auth.actor.type, executedBy: auth.actor.id, startedAt: started, finishedAt: now })
          .where(and(eq(deployments.id, deployment.id), eq(deployments.status, 'approved')));
        await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
          action: 'deploy.execute',
          outcome: 'error',
          target: { type: 'deployment', id: deployment.id },
          spaceId: team.space.id,
          appId: team.app.id,
          env: kind,
          reason: { message: message.slice(0, 500) },
        });
      });
      throw conflict('deployment_failed', `The deployment failed and changed nothing: ${message}`, { deploymentId: deployment.id });
    }
  }

  async cancel(request: FastifyRequest, auth: AuthContext, deployment: DeploymentRow): Promise<DeploymentRow> {
    const ctx = this.#ctx;
    const now = ctx.now();
    return ctx.db.transaction(async (tx) => {
      const [row] = (await tx
        .update(deployments)
        .set({ status: 'cancelled', finishedAt: now, error: `Cancelled by ${auth.actor.name ?? auth.actor.email ?? auth.actor.id}` })
        .where(and(eq(deployments.id, deployment.id), inArray(deployments.status, ['awaiting_approval', 'approved'])))
        .returning()) as [DeploymentRow | undefined];
      if (!row) throw conflict('not_pending', `This deployment is ${deployment.status}`);
      await recordAudit(tx, auditScopeFor(request, ctx.org.id, now), {
        action: 'deploy.cancel',
        target: { type: 'deployment', id: deployment.id },
        spaceId: deployment.spaceId,
        appId: deployment.appId,
        env: deployment.environmentKind,
      });
      return row;
    });
  }

  /**
   * Roll an environment back: make the release that ran there before live again, at once (design
   * §7.1). The data model stays as it is, so the older release ignores what the newer one added.
   * Refused across a deployment that deleted data, which a rollback can't bring back.
   */
  async rollback(request: FastifyRequest, auth: AuthContext, team: AppRef, kind: EnvKind): Promise<DeploymentRow> {
    const ctx = this.#ctx;
    const started = ctx.now();
    const env = await ctx.apps.environment(team, kind);
    if (!env?.activeReleaseId) throw conflict('nothing_live', `${team.app.name} is not live in ${envName(kind)}`);
    const current = await this.release(team.app.id, env.activeReleaseId);
    const history = await ctx.db
      .select({ releaseId: deployments.releaseId, kind: deployments.kind, destructive: deployments.destructive, number: releases.number })
      .from(deployments)
      .innerJoin(releases, eq(releases.id, deployments.releaseId))
      .where(and(eq(deployments.environmentId, env.id), eq(deployments.status, 'succeeded')));
    const earlier = history.filter((row) => row.number < current.number).sort((a, b) => b.number - a.number)[0];
    if (!earlier) throw conflict('nothing_to_roll_back_to', `No earlier release has run in ${envName(kind)}`);
    const target = await this.release(team.app.id, earlier.releaseId);
    const deleting = history.find((row) => row.kind === 'deploy' && row.destructive && row.number > target.number && row.number <= current.number);
    if (deleting) {
      throw conflict(
        'cannot_roll_back',
        `Release ${deleting.number} deleted data when it was deployed, and a rollback can't bring data back. Fix it with a new change instead.`,
      );
    }
    return withTransaction(ctx.pool, async (client, db) => {
      await lockEnvironment(client, env.id);
      const [locked] = await db.select().from(appEnvironments).where(eq(appEnvironments.id, env.id)).for('update');
      if (locked!.activeReleaseId !== current.id || locked!.status !== 'active') throw conflict('environment_changed', `${envName(kind)} changed meanwhile. Look again.`);
      await db.update(appEnvironments).set({ activeRevision: target.revision, activeReleaseId: target.id }).where(eq(appEnvironments.id, env.id));
      // A deployment planned against the release that is no longer live would go wrong.
      await db
        .update(deployments)
        .set({ status: 'cancelled', finishedAt: started, error: 'Cancelled by a rollback' })
        .where(and(eq(deployments.appId, team.app.id), eq(deployments.environmentKind, kind), inArray(deployments.status, ['awaiting_approval', 'approved'])));
      const finished = ctx.now();
      const [row] = (await db
        .insert(deployments)
        .values({
          id: uuidv7(started.getTime()),
          orgId: ctx.org.id,
          spaceId: team.space.id,
          appId: team.app.id,
          environmentKind: kind,
          environmentId: env.id,
          kind: 'rollback',
          releaseId: target.id,
          fromReleaseId: current.id,
          status: 'succeeded',
          plan: {
            steps: [],
            notes: [`Release ${target.number} runs again. The data stays in the shape of release ${current.number}: release ${target.number} ignores what that added.`],
            destructive: false,
            appliedRevision: env.appliedRevision,
          },
          destructive: false,
          approvalsRequired: 0,
          requestedByType: auth.actor.type,
          requestedBy: auth.actor.id,
          requestedAt: started,
          executedByType: auth.actor.type,
          executedBy: auth.actor.id,
          startedAt: started,
          finishedAt: finished,
        })
        .returning()) as [DeploymentRow];
      await recordAudit(db, auditScopeFor(request, ctx.org.id, started), {
        action: 'deploy.rollback',
        target: { type: 'deployment', id: row.id, name: `${envName(kind)} back to release ${target.number}` },
        spaceId: team.space.id,
        appId: team.app.id,
        env: kind,
        changes: { before: { release: current.number, revision: current.revision }, after: { release: target.number, revision: target.revision }, durationMs: finished.getTime() - started.getTime() },
      });
      return row;
    });
  }

  /** People's names, for showing who did what. */
  async names(ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (!wanted.length) return new Map();
    const rows = await this.#ctx.db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, wanted));
    return new Map(rows.map((row) => [row.id, row.name?.trim() || row.email || 'Someone']));
  }

  /** The environments of a team app other than previews. */
  async environments(team: AppRef): Promise<EnvironmentRow[]> {
    return this.#ctx.db
      .select()
      .from(appEnvironments)
      .where(and(eq(appEnvironments.appId, team.app.id), eq(appEnvironments.status, 'active'), ne(appEnvironments.kind, 'preview')));
  }
}
