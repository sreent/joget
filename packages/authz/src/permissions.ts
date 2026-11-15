/**
 * The platform's permission catalog: every action the policy decision point can authorize.
 *
 * Permissions are dot-separated `resource.verb` strings. In permission sets, a pattern may end in
 * `.*` (every permission under that prefix) or be exactly `*` (everything).
 */
export const PLATFORM_PERMISSIONS = {
  'org.settings.read': 'Read organization settings',
  'org.settings.manage': 'Change organization settings',
  'org.guardrail.manage': 'Create, change and disable guardrails',
  'org.audit.read': 'Search and read the audit log',
  'org.audit.export': 'Export audit events',

  'directory.user.read': 'Read users and their group memberships',
  'directory.user.manage': 'Change and deprovision users',
  'directory.group.manage': 'Create and change platform-managed groups',
  'directory.service_account.manage': 'Create service accounts and their credentials',

  'access.binding.read': 'Read bindings and explain access decisions',
  'access.binding.manage': 'Grant and revoke org-level roles and permission sets',
  'access.permission_set.manage': 'Create and change custom permission sets and roles',
  'access.review.run': 'Run access-review campaigns',
  'access.breakglass.activate': 'Activate break-glass access',
  'access.token.read': 'See every API token in the organization (never the secrets)',
  'access.token.revoke': 'Revoke any API token in the organization',
  'token.personal.create': 'Create personal access tokens for yourself',

  'space.create': 'Create team spaces',
  'space.read': 'See a space and its members',
  'space.settings.manage': "Change a space's settings",
  'space.member.manage': 'Grant and revoke roles inside a space',
  'space.freeze': 'Freeze a space, making it read-only',
  'space.transfer': 'Transfer a personal space to another owner',
  'space.delete': 'Delete an archived space',
  'space.service_account.manage': "Create and disable a space's service accounts, and issue and revoke their tokens",

  'app.create': 'Create apps',
  'app.read': 'Read app definitions',
  'app.edit': 'Edit app definitions in a working copy',
  'app.share': 'Share a personal app with named users',
  'app.export': 'Export app definitions',
  'app.delete': 'Delete apps',
  'app.run': "Use an app's capabilities, screens and review pages",
  'action.run': "Run an app's action, under your record permissions",
  'query.run': "Run an app's query, under your record permissions",

  'change.open': 'Open change requests',
  'change.review': 'Review change requests',
  'change.approve': 'Approve change requests',
  'change.merge': 'Merge approved change requests',

  'release.create': 'Cut releases',
  'deploy.read': 'See deployments and their history',
  'deploy.request': 'Request deployments',
  'deploy.approve': 'Approve deployments',
  'deploy.execute': 'Execute approved deployments',
  'deploy.rollback': 'Roll back deployments',

  'env.config.manage': 'Change environment configuration',
  'env.secret.write': 'Write environment secrets (values are never readable)',
  'env.binding.manage': 'Map app roles to groups in an environment',

  'connection.use': 'Use a data connection in an app',
  'connection.manage': 'Create and change data connections',

  'code.author': 'Write custom code in sandboxed scripts',
  'plugin.install': 'Install approved plugins',
  'plugin.approve': 'Approve plugins for the organization',

  'ops.monitor.read': 'See monitoring for apps and the platform',
  'ops.job.retry': 'Retry failed automations and jobs',
  'ops.task.reassign': 'Reassign workflow tasks',

  'record.read': 'Read records of an entity',
  'record.create': 'Create records of an entity',
  'record.update': 'Update records of an entity',
  'record.delete': 'Delete records of an entity',
  'record.export': 'Export records of an entity',

  'process.start': 'Start a process',
  'process.admin': 'Administer running process instances',
  'task.claim': 'Claim a workflow task',
  'task.complete': 'Complete a workflow task',
  'task.reassign': 'Reassign a workflow task',
} as const satisfies Record<string, string>;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;

const PATTERN = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;

/** True if `pattern` is syntactically valid: `*`, `a.b.c`, or `a.b.*`. */
export function isValidPermissionPattern(pattern: string): boolean {
  return PATTERN.test(pattern);
}

/** True if a pattern matches at least one permission in the platform catalog. */
export function isKnownPermissionPattern(pattern: string): boolean {
  return (
    isValidPermissionPattern(pattern) &&
    Object.keys(PLATFORM_PERMISSIONS).some((permission) => matchesPermission(pattern, permission))
  );
}

/** True if `pattern` grants `permission`. */
export function matchesPermission(pattern: string, permission: string): boolean {
  if (pattern === '*' || pattern === permission) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return permission.length > prefix.length && permission.startsWith(prefix);
  }
  return false;
}

/** True if every permission matched by `inner` is also matched by `outer`. */
export function patternCovers(outer: string, inner: string): boolean {
  if (outer === '*' || outer === inner) return true;
  if (inner === '*') return false;
  return matchesPermission(outer, inner);
}

/** Resource selectors narrow a grant to, for example, one entity. `*` matches any resource. */
export function matchesSelector(grantSelector: string | undefined, resourceSelector: string | undefined): boolean {
  const selector = grantSelector ?? '*';
  return selector === '*' || selector === resourceSelector;
}

/** True if every resource matched by `inner` is also matched by `outer`. */
export function selectorCovers(outer: string | undefined, inner: string | undefined): boolean {
  const o = outer ?? '*';
  return o === '*' || o === (inner ?? '*');
}
