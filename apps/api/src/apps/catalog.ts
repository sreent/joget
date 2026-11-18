import { compileAppPolicy, type StoredDefinition, validateDefinition } from '@platform/app-model';
import { createPolicy, mergePolicies, type Policy } from '@platform/authz';
import { appEnvironments, appRevisions, apps, type Database, type Executor, spaces } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import { badRequest, HttpError, notFound } from '../errors.js';

export type AppRow = typeof apps.$inferSelect;
export type EnvironmentRow = typeof appEnvironments.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;

/** An app and its space: enough to build it, or to decide who may. */
export interface AppRef {
  readonly app: AppRow;
  readonly space: SpaceRow;
}

/** An app in one of its environments, with the definition that environment runs. */
export interface LoadedApp extends AppRef {
  readonly env: EnvironmentRow;
  /** The revision the environment runs. Behind the main line until a release reaches it. */
  readonly revision: number;
  readonly definition: StoredDefinition;
}

/**
 * Which environment of an app: its own (the sandbox of a personal app, Prod of a team app),
 * Staging, or one by its ID, such as a change request's preview.
 */
export type EnvSelector = 'default' | 'prod' | 'staging' | { readonly id: string };

/** True if an environment is loaded, not just the app. */
export const isLoaded = (view: AppRef | LoadedApp): view is LoadedApp => 'env' in view && 'definition' in view;

/** A team app changes through change requests and runs releases; a personal app is edited live. */
export const isTeamApp = (ref: AppRef): boolean => ref.space.kind === 'team';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An environment selector from an API parameter: `prod`, `staging` or an environment ID. */
export function envSelector(value: string | undefined): EnvSelector {
  if (value === undefined || value === '') return 'default';
  if (value === 'prod' || value === 'staging') return value;
  if (!UUID.test(value)) throw badRequest('invalid_env', "Name an environment as prod, staging, or a preview's environment ID");
  return { id: value };
}

const MAX_CACHED_DEFINITIONS = 500;

/**
 * Loads apps, their environments and their definitions. Definitions are immutable per revision,
 * so they are cached by revision; app and environment rows are always read fresh.
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

  /** An active app and its space. */
  async ref(appId: string, executor: Executor = this.#db): Promise<AppRef> {
    const [row] = await executor
      .select({ app: apps, space: spaces })
      .from(apps)
      .innerJoin(spaces, eq(spaces.id, apps.spaceId))
      .where(and(eq(apps.id, appId), eq(apps.orgId, this.#orgId), eq(apps.status, 'active')));
    if (!row) throw notFound('App');
    return row;
  }

  /** An app in one of its environments. Refuses an environment the app doesn't have (yet). */
  async load(appId: string, selector: EnvSelector = 'default', executor: Executor = this.#db): Promise<LoadedApp> {
    const ref = await this.ref(appId, executor);
    const env = await this.environment(ref, selector, executor);
    if (!env) {
      if (typeof selector === 'object') throw notFound('Environment');
      const kind = selector === 'default' ? (isTeamApp(ref) ? 'prod' : 'sandbox') : selector;
      if (kind === 'sandbox') throw notFound('App');
      throw new HttpError(404, 'not_live', `${ref.app.name} is not live in ${kind === 'prod' ? 'Prod' : 'Staging'} yet. Deploy a release there first.`);
    }
    return { ...ref, env, revision: env.activeRevision, definition: await this.definition(appId, env.activeRevision, executor) };
  }

  /** One of an app's active environments, or null if it has none of that kind. */
  async environment(ref: AppRef, selector: EnvSelector, executor: Executor = this.#db): Promise<EnvironmentRow | null> {
    const which =
      typeof selector === 'object'
        ? eq(appEnvironments.id, selector.id)
        : eq(appEnvironments.kind, selector === 'default' ? (isTeamApp(ref) ? 'prod' : 'sandbox') : selector);
    const [env] = await executor
      .select()
      .from(appEnvironments)
      .where(and(eq(appEnvironments.appId, ref.app.id), eq(appEnvironments.status, 'active'), which));
    return env ?? null;
  }

  /** The newest revision of the app's main line: what builders see and change. */
  async mainDefinition(ref: AppRef, executor: Executor = this.#db): Promise<StoredDefinition> {
    return this.definition(ref.app.id, ref.app.currentRevision, executor);
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
