import { orgScopes, spaceScopes, type Resource } from '@platform/authz';
import { spaces, type Executor } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import { notFound } from '../errors.js';

export type SpaceRow = typeof spaces.$inferSelect;

export function orgResource(orgId: string): Resource {
  return { type: 'org', id: orgId, scopes: orgScopes(orgId) };
}

export function spaceResource(orgId: string, space: SpaceRow): Resource {
  return {
    type: 'space',
    id: space.id,
    scopes: spaceScopes(orgId, { id: space.id, personal: space.kind === 'personal' }),
    attributes: { spaceKind: space.kind, status: space.status },
  };
}

export async function loadSpace(db: Executor, orgId: string, spaceId: string): Promise<SpaceRow> {
  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)));
  if (!space) throw notFound('Space');
  return space;
}

/** A scope as a resource: the org itself, or a space. */
export async function scopeResource(db: Executor, orgId: string, scope: { type: string; id: string }): Promise<Resource> {
  if (scope.type === 'org') {
    if (scope.id !== orgId) throw notFound('Organization');
    return orgResource(orgId);
  }
  if (scope.type === 'space') return spaceResource(orgId, await loadSpace(db, orgId, scope.id));
  throw notFound(`Scope type ${scope.type}`);
}

/** Bindings at the org scope are managed with access.binding.manage; inside a space, with space.member.manage. */
export function bindingManageAction(scopeType: string): string {
  return scopeType === 'org' ? 'access.binding.manage' : 'space.member.manage';
}
