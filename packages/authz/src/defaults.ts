import type { SodRule } from './governance.js';
import type { Guardrail, PermissionSet, Role, ScopeType } from './model.js';
import type { PlatformPermission } from './permissions.js';

function permissionSet(id: string, name: string, scopeType: ScopeType, permissions: PlatformPermission[]): PermissionSet {
  return { id, name, scopeType, managed: true, grants: permissions.map((permission) => ({ permission })) };
}

function role(id: string, name: string, scopeType: ScopeType, permissionSetIds: string[]): Role {
  return { id, name, scopeType, permissionSetIds, managed: true };
}

/** Managed permission sets: the building blocks of the default roles (design §5.4). */
export const MANAGED_PERMISSION_SETS: readonly PermissionSet[] = [
  permissionSet('ps.org.administration', 'Organization administration', 'org', [
    'org.settings.read',
    'org.settings.manage',
    'directory.user.read',
    'directory.user.manage',
    'directory.group.manage',
    'directory.service_account.manage',
    'access.binding.read',
    'access.binding.manage',
    'access.token.read',
    'access.token.revoke',
    'space.create',
    'space.read',
    'space.settings.manage',
    'space.member.manage',
    'space.freeze',
    'space.transfer',
    'space.delete',
  ]),
  permissionSet('ps.org.security', 'Security administration', 'org', [
    'org.settings.read',
    'org.guardrail.manage',
    'directory.user.read',
    'access.binding.read',
    'access.binding.manage',
    'access.permission_set.manage',
    'access.review.run',
    'access.token.read',
    'access.token.revoke',
    'access.agent.approve',
  ]),
  permissionSet('ps.org.audit', 'Audit (read-only)', 'org', [
    'org.settings.read',
    'org.audit.read',
    'org.audit.export',
    'directory.user.read',
    'access.binding.read',
    'access.token.read',
    'space.read',
    'app.read',
    'deploy.read',
  ]),
  permissionSet('ps.org.operations', 'Platform operations', 'org', ['ops.monitor.read', 'ops.job.retry']),
  permissionSet('ps.org.space_creation', 'Create team spaces', 'org', ['space.create']),
  permissionSet('ps.space.administration', 'Space administration', 'space', [
    'space.read',
    'space.settings.manage',
    'space.member.manage',
    'space.service_account.manage',
    'access.binding.read',
    'env.config.manage',
    'env.secret.write',
    'env.binding.manage',
    'connection.manage',
  ]),
  permissionSet('ps.space.view', 'Space view', 'space', ['space.read', 'app.read', 'deploy.read', 'ops.monitor.read']),
  permissionSet('ps.space.build', 'Build apps', 'space', ['app.create', 'app.read', 'app.edit', 'change.open', 'connection.use']),
  permissionSet('ps.space.review', 'Review changes', 'space', ['change.review', 'change.approve', 'deploy.approve']),
  permissionSet('ps.space.release', 'Release management', 'space', [
    'change.merge',
    'release.create',
    'deploy.read',
    'deploy.request',
    'deploy.execute',
    'deploy.rollback',
  ]),
  permissionSet('ps.space.operations', 'Operate apps', 'space', ['ops.monitor.read', 'ops.job.retry', 'ops.task.reassign']),
  permissionSet('ps.space.personal', 'Personal space owner', 'space', [
    'space.read',
    'space.settings.manage',
    'app.create',
    'app.read',
    'app.edit',
    'app.share',
    'app.export',
    'app.delete',
    'app.run',
    'action.run',
    'query.run',
    'record.read',
    'record.create',
    'record.update',
    'record.delete',
    'record.export',
    'connection.use',
    'connection.manage',
    'deploy.read',
    'ops.monitor.read',
    'token.personal.create',
  ]),
];

/** Managed roles (design §5.4). Org admins manage spaces and people but get no app data by default. */
export const MANAGED_ROLES: readonly Role[] = [
  role('org.owner', 'Org owner', 'org', ['ps.org.administration', 'ps.org.security', 'ps.org.operations', 'ps.org.audit']),
  role('org.admin', 'Org admin', 'org', ['ps.org.administration']),
  role('org.security_admin', 'Security admin', 'org', ['ps.org.security']),
  role('org.auditor', 'Auditor', 'org', ['ps.org.audit']),
  role('org.platform_operator', 'Platform operator', 'org', ['ps.org.operations']),
  role('org.space_creator', 'Space creator', 'org', ['ps.org.space_creation']),
  role('space.owner', 'Space owner', 'space', [
    'ps.space.administration',
    'ps.space.view',
    'ps.space.build',
    'ps.space.review',
    'ps.space.release',
    'ps.space.operations',
  ]),
  role('space.admin', 'Space admin', 'space', ['ps.space.administration', 'ps.space.view']),
  role('space.builder', 'Builder', 'space', ['ps.space.build', 'ps.space.view']),
  role('space.reviewer', 'Reviewer', 'space', ['ps.space.review', 'ps.space.view']),
  role('space.release_manager', 'Release manager', 'space', ['ps.space.release', 'ps.space.view']),
  role('space.operator', 'Operator', 'space', ['ps.space.operations', 'ps.space.view']),
  role('space.viewer', 'Viewer', 'space', ['ps.space.view']),
  role('space.personal_owner', 'Personal space owner', 'space', ['ps.space.personal']),
];

/** Roles that the platform assigns itself and that cannot be granted through the API. */
export const SYSTEM_ASSIGNED_ROLES: readonly string[] = ['space.personal_owner'];

const isUser = { eq: [{ ref: 'principal.type' }, 'user'] } as const;

/** Managed guardrails (design §5.6). Guardrails are the only source of explicit denial. */
export const MANAGED_GUARDRAILS: readonly Guardrail[] = [
  {
    id: 'gr.sod.author-cannot-approve',
    name: 'Authors cannot approve their own changes or deployments',
    actions: ['change.approve', 'deploy.approve'],
    effect: 'deny',
    when: {
      any: [{ not: { exists: 'context.authorId' } }, { eq: [{ ref: 'context.authorId' }, { ref: 'principal.id' }] }],
    },
    managed: true,
  },
  {
    id: 'gr.step-up.access-administration',
    name: 'Fresh MFA for access administration and new credentials',
    actions: [
      'access.binding.manage',
      'space.member.manage',
      'access.permission_set.manage',
      'org.guardrail.manage',
      'access.breakglass.activate',
      'token.personal.create',
      'space.service_account.manage',
      'access.agent.approve',
    ],
    effect: 'step_up',
    maxMfaAgeSeconds: 900,
    when: isUser,
    managed: true,
  },
  {
    id: 'gr.step-up.production-deploy',
    name: 'Fresh MFA for production deployments',
    actions: ['deploy.approve', 'deploy.execute', 'deploy.rollback'],
    effect: 'step_up',
    maxMfaAgeSeconds: 900,
    when: { all: [isUser, { eq: [{ ref: 'resource.env' }, 'prod'] }] },
    managed: true,
  },
  {
    id: 'gr.step-up.export',
    name: 'Fresh MFA for data and audit exports',
    actions: ['record.export', 'org.audit.export'],
    effect: 'step_up',
    maxMfaAgeSeconds: 900,
    when: isUser,
    managed: true,
  },
  {
    id: 'gr.space.frozen-read-only',
    name: 'Frozen spaces are read-only',
    actions: [
      'space.settings.manage',
      'space.member.manage',
      'space.service_account.manage',
      'app.create',
      'app.edit',
      'app.share',
      'app.delete',
      'action.run',
      'record.create',
      'record.update',
      'record.delete',
      'change.*',
      'release.create',
      'deploy.request',
      'deploy.execute',
      'connection.manage',
      'env.*',
    ],
    effect: 'deny',
    when: { eq: [{ ref: 'resource.status' }, 'frozen'] },
    managed: true,
  },
  {
    id: 'gr.personal.no-production-connections',
    name: 'Personal spaces cannot use production connections',
    actions: ['connection.use'],
    effect: 'deny',
    when: {
      all: [
        { eq: [{ ref: 'resource.spaceKind' }, 'personal'] },
        { eq: [{ ref: 'resource.connectionTier' }, 'production'] },
      ],
    },
    managed: true,
  },
];

/** Managed separation-of-duties rules (design §5.7). */
export const MANAGED_SOD_RULES: readonly SodRule[] = [
  {
    id: 'sod.auditor-independence',
    name: 'Auditors cannot hold administrative roles',
    roleIds: ['org.auditor'],
    conflictsWith: ['org.owner', 'org.admin', 'org.security_admin', 'org.platform_operator'],
  },
];
