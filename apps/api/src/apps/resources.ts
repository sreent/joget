import type { Resource, ScopeRef } from '@platform/authz';
import type { LoadedApp } from './catalog.js';

/** The scope chain of everything in an app's environment: env → app → space → org. */
export function appScopes(orgId: string, loaded: LoadedApp): ScopeRef[] {
  return [
    { type: 'env', id: loaded.env.id },
    { type: 'app', id: loaded.app.id },
    { type: 'space', id: loaded.space.id, personal: loaded.space.kind === 'personal' },
    { type: 'org', id: orgId },
  ];
}

function attributes(loaded: LoadedApp): Record<string, unknown> {
  // `status` is the space's: guardrails make frozen spaces read-only through it.
  return { spaceKind: loaded.space.kind, status: loaded.space.status, env: loaded.env.kind, appId: loaded.app.id };
}

export const appResource = (orgId: string, loaded: LoadedApp): Resource => ({
  type: 'app',
  id: loaded.app.id,
  scopes: appScopes(orgId, loaded),
  attributes: attributes(loaded),
});

/** The records of one entity. The entity name is the selector that grants narrow to. */
export const recordResource = (orgId: string, loaded: LoadedApp, entity: string): Resource => ({
  type: 'record',
  selector: entity,
  scopes: appScopes(orgId, loaded),
  attributes: attributes(loaded),
});

export const capabilityResource = (orgId: string, loaded: LoadedApp, kind: 'action' | 'query', name: string): Resource => ({
  type: kind,
  selector: name,
  scopes: appScopes(orgId, loaded),
  attributes: attributes(loaded),
});
