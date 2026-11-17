import type { Resource, ScopeRef } from '@platform/authz';
import { isLoaded, type AppRef, type EnvironmentRow, type LoadedApp } from './catalog.js';

type EnvKind = EnvironmentRow['kind'];

/** The scope chain of an app, or of one of its environments: env → app → space → org. */
export function appScopes(orgId: string, ref: AppRef, env?: Pick<EnvironmentRow, 'id'>): ScopeRef[] {
  return [
    ...(env ? [{ type: 'env' as const, id: env.id }] : []),
    { type: 'app', id: ref.app.id },
    { type: 'space', id: ref.space.id, personal: ref.space.kind === 'personal' },
    { type: 'org', id: orgId },
  ];
}

function attributes(ref: AppRef, env?: EnvKind): Record<string, unknown> {
  // `status` is the space's: guardrails make frozen spaces read-only through it. `moved` makes an app that moved to a team space read-only.
  return { spaceKind: ref.space.kind, status: ref.space.status, appId: ref.app.id, ...(ref.app.movedTo ? { moved: true } : {}), ...(env ? { env } : {}) };
}

/** An app, in its environment when one is loaded: what building, sharing and using it are checked against. */
export const appResource = (orgId: string, ref: AppRef | LoadedApp): Resource => {
  const env = isLoaded(ref) ? ref.env : undefined;
  return { type: 'app', id: ref.app.id, scopes: appScopes(orgId, ref, env), attributes: attributes(ref, env?.kind) };
};

/**
 * An environment of a team app, for deploying to it and rolling it back. It need not exist yet:
 * the first deployment creates it, and guardrails see its kind either way (Prod needs fresh MFA).
 */
export const environmentResource = (orgId: string, ref: AppRef, kind: EnvKind, env?: Pick<EnvironmentRow, 'id'> | null): Resource => ({
  type: 'env',
  id: env?.id ?? `${ref.app.id}:${kind}`,
  scopes: appScopes(orgId, ref, env ?? undefined),
  attributes: attributes(ref, kind),
});

/** The records of one entity. The entity name is the selector that grants narrow to. */
export const recordResource = (orgId: string, loaded: LoadedApp, entity: string): Resource => ({
  type: 'record',
  selector: entity,
  scopes: appScopes(orgId, loaded, loaded.env),
  attributes: attributes(loaded, loaded.env.kind),
});

export const capabilityResource = (orgId: string, loaded: LoadedApp, kind: 'action' | 'query', name: string): Resource => ({
  type: kind,
  selector: name,
  scopes: appScopes(orgId, loaded, loaded.env),
  attributes: attributes(loaded, loaded.env.kind),
});

/** A process of the app, for starting it by hand: roles name the processes their holders may start. */
export const processResource = (orgId: string, loaded: LoadedApp, name: string): Resource => ({
  type: 'process',
  selector: name,
  scopes: appScopes(orgId, loaded, loaded.env),
  attributes: attributes(loaded, loaded.env.kind),
});

/** A flow of the app, for running it through the API: roles name the flows their holders may run. */
export const flowResource = (orgId: string, loaded: LoadedApp, name: string): Resource => ({
  type: 'flow',
  selector: name,
  scopes: appScopes(orgId, loaded, loaded.env),
  attributes: attributes(loaded, loaded.env.kind),
});
