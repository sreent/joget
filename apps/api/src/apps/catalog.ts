import { createPolicy, mergePolicies, type Policy } from '@platform/authz';
import { compileAppPolicy, validateDefinition, type StoredDefinition } from '@platform/app-model';
import { appEnvironments, appRevisions, apps, spaces, type Database, type Executor } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import { notFound } from '../errors.js';

export type AppRow = typeof apps.$inferSelect;
export type EnvironmentRow = typeof appEnvironments.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;

/** An app with its space, its sandbox environment and its current definition. */
export interface LoadedApp {
  readonly app: AppRow;
  readonly space: SpaceRow;
  readonly env: EnvironmentRow;
  readonly definition: StoredDefinition;
}

const MAX_CACHED_DEFINITIONS = 500;

/**
 * Loads apps and their definitions. Definitions are immutable per revision, so they are cached by
 * revision; the app row (and so the current revision) is always read fresh.
 */
export class AppCatalog {
  readonly #db: Database;
  readonly #orgId: string;
  readonly #definitions = new Map<string, StoredDefinition>();
  readonly #policies = new WeakMap<Policy, Map<string, Policy>>();

  constructor(db: Database, orgId: string) {
    this.#db = db;
    this.#orgId = orgId;
  }

  async load(appId: string, executor: Executor = this.#db): Promise<LoadedApp> {
    const [row] = await executor
      .select({ app: apps, space: spaces, env: appEnvironments })
      .from(apps)
      .innerJoin(spaces, eq(spaces.id, apps.spaceId))
      .innerJoin(appEnvironments, and(eq(appEnvironments.appId, apps.id), eq(appEnvironments.kind, 'sandbox'), eq(appEnvironments.status, 'active')))
      .where(and(eq(apps.id, appId), eq(apps.orgId, this.#orgId), eq(apps.status, 'active')));
    if (!row) throw notFound('App');
    return { ...row, definition: await this.definition(appId, row.app.currentRevision, executor) };
  }

  async definition(appId: string, revision: number, executor: Executor = this.#db): Promise<StoredDefinition> {
    const key = `${appId}:${revision}`;
    const cached = this.#definitions.get(key);
    if (cached) return cached;
    const [row] = await executor
      .select({ definition: appRevisions.definition })
      .from(appRevisions)
      .where(and(eq(appRevisions.appId, appId), eq(appRevisions.revision, revision)));
    if (!row) throw new Error(`App ${appId} has no revision ${revision}`);
    // Stored definitions carry their IDs; validating again guards against a damaged row.
    const result = validateDefinition(row.definition, row.definition as unknown as StoredDefinition);
    if (!result.ok) throw new Error(`The stored definition of app ${appId}, revision ${revision}, is invalid`);
    if (this.#definitions.size >= MAX_CACHED_DEFINITIONS) this.#definitions.delete(this.#definitions.keys().next().value!);
    this.#definitions.set(key, result.definition);
    return result.definition;
  }

  /** The platform policy plus the app's own roles, cached per revision of the app. */
  policyFor(base: Policy, appId: string, revision: number, definition: StoredDefinition): Policy {
    let byApp = this.#policies.get(base);
    if (!byApp) {
      byApp = new Map();
      this.#policies.set(base, byApp);
    }
    const key = `${appId}:${revision}`;
    let policy = byApp.get(key);
    if (!policy) {
      policy = mergePolicies(base, createPolicy(compileAppPolicy(appId, definition)));
      byApp.set(key, policy);
    }
    return policy;
  }
}
