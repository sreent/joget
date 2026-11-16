import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

type Json = Record<string, unknown>;

const tz = { withTimezone: true } as const;
const createdAt = () => timestamp('created_at', tz).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', tz).notNull().defaultNow();
const scopeTypes = ['org', 'space', 'app', 'env'] as const;
/** Who did something: a person, a service account, or the platform itself. */
const actorTypes = ['system', 'user', 'service_account'] as const;

/** The top-level boundary. A one-company deployment has exactly one row. */
export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

/** People, provisioned just in time from the IdP (or by SCIM). Identified by issuer + subject. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    displayName: text('display_name'),
    status: text('status', { enum: ['active', 'deprovisioned'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    lastLoginAt: timestamp('last_login_at', tz),
  },
  (t) => [uniqueIndex('users_issuer_subject_uq').on(t.issuer, t.subject), index('users_org_email_idx').on(t.orgId, t.email)],
);

/** Groups from the IdP's group claim, or managed on the platform. */
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    source: text('source', { enum: ['idp', 'platform'] }).notNull(),
    /** The IdP's group value (name or ID), or a slug for platform groups. */
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('groups_org_source_external_uq').on(t.orgId, t.source, t.externalId)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user_idx').on(t.userId)],
);

/** Personal spaces (exactly one per user) and team spaces. */
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    kind: text('kind', { enum: ['personal', 'team'] }).notNull(),
    name: text('name').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    status: text('status', { enum: ['active', 'frozen', 'archived'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('spaces_one_personal_per_user_uq').on(t.ownerUserId).where(sql`${t.kind} = 'personal'`),
    check('spaces_personal_has_owner', sql`(${t.kind} = 'personal') = (${t.ownerUserId} is not null)`),
  ],
);

/** Non-human principals for integrations and CI. Each belongs to a team space. */
export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    disabledAt: timestamp('disabled_at', tz),
    /**
     * Set when a Security admin has approved the account to act for people as an agent: the most
     * an agent's token may ever do, whoever it acts for. Null for a plain service account.
     */
    agentScopes: text('agent_scopes').array(),
    agentApprovedAt: timestamp('agent_approved_at', tz),
    agentApprovedBy: uuid('agent_approved_by'),
  },
  (t) => [uniqueIndex('service_accounts_space_name_uq').on(t.spaceId, t.name)],
);

/**
 * API tokens: personal access tokens (owned by a user) and service-account tokens. Only a SHA-256
 * hash is stored. Effective permissions are the owner's grants intersected with the token's scopes.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    serviceAccountId: uuid('service_account_id').references(() => serviceAccounts.id, { onDelete: 'cascade' }),
    /** For a delegated token: the agent that acts, for the person in user_id (RFC 8693 token exchange). */
    actorServiceAccountId: uuid('actor_service_account_id').references(() => serviceAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The start of the token, so people can recognize it. Never enough to use it. */
    displayPrefix: text('display_prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    /** Tokens are only ever created by a person in an interactive session. */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', tz),
    revokedAt: timestamp('revoked_at', tz),
    revokedByType: text('revoked_by_type', { enum: actorTypes }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    uniqueIndex('api_tokens_secret_hash_uq').on(t.secretHash),
    index('api_tokens_user_idx').on(t.userId),
    index('api_tokens_service_account_idx').on(t.serviceAccountId),
    index('api_tokens_actor_idx').on(t.actorServiceAccountId),
    check('api_tokens_delegated_to_people', sql`${t.actorServiceAccountId} is null or ${t.userId} is not null`),
    check('api_tokens_one_owner', sql`(${t.userId} is null) <> (${t.serviceAccountId} is null)`),
  ],
);

/** Reusable permission bundles. Platform-managed sets have no org. */
export const permissionSets = pgTable('permission_sets', {
  id: text('id').primaryKey(),
  orgId: uuid('org_id').references(() => orgs.id),
  name: text('name').notNull(),
  description: text('description'),
  scopeType: text('scope_type', { enum: scopeTypes }).notNull(),
  version: integer('version').notNull().default(1),
  managed: boolean('managed').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const permissionSetGrants = pgTable(
  'permission_set_grants',
  {
    permissionSetId: text('permission_set_id')
      .notNull()
      .references(() => permissionSets.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    resourceSelector: text('resource_selector').notNull().default('*'),
    condition: jsonb('condition').$type<Json>(),
  },
  (t) => [primaryKey({ columns: [t.permissionSetId, t.permission, t.resourceSelector] })],
);

/** Job functions made of permission sets. Platform-managed roles have no org. */
export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  orgId: uuid('org_id').references(() => orgs.id),
  name: text('name').notNull(),
  description: text('description'),
  scopeType: text('scope_type', { enum: scopeTypes }).notNull(),
  managed: boolean('managed').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rolePermissionSets = pgTable(
  'role_permission_sets',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionSetId: text('permission_set_id')
      .notNull()
      .references(() => permissionSets.id),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionSetId] })],
);

/**
 * Who has what, where, until when. Revoked bindings are kept (revoked_at), so access history stays
 * queryable for access reviews and audits.
 */
export const bindings = pgTable(
  'bindings',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    principalType: text('principal_type', { enum: ['user', 'group', 'service_account'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    roleId: text('role_id').references(() => roles.id),
    permissionSetId: text('permission_set_id').references(() => permissionSets.id),
    /** A role an app defines for itself (`app:<appId>:<role>`), bound at environment scope, for example to share an app. */
    appRoleId: text('app_role_id'),
    scopeType: text('scope_type', { enum: scopeTypes }).notNull(),
    scopeId: uuid('scope_id').notNull(),
    expiresAt: timestamp('expires_at', tz),
    justification: text('justification'),
    /** Who granted it. `system` (with no ID) when the platform did, for example for a personal space owner. */
    grantedByType: text('granted_by_type', { enum: actorTypes }).notNull().default('system'),
    grantedBy: uuid('granted_by'),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', tz),
    revokedByType: text('revoked_by_type', { enum: actorTypes }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    index('bindings_principal_idx').on(t.principalType, t.principalId),
    index('bindings_scope_idx').on(t.scopeType, t.scopeId),
    check('bindings_grants_one_thing', sql`num_nonnulls(${t.roleId}, ${t.permissionSetId}, ${t.appRoleId}) = 1`),
    check('bindings_app_roles_inside_apps', sql`${t.appRoleId} is null or ${t.scopeType} in ('app', 'env')`),
    uniqueIndex('bindings_active_role_uq')
      .on(t.principalType, t.principalId, t.scopeType, t.scopeId, t.roleId)
      .where(sql`${t.revokedAt} is null and ${t.roleId} is not null`),
    uniqueIndex('bindings_active_permission_set_uq')
      .on(t.principalType, t.principalId, t.scopeType, t.scopeId, t.permissionSetId)
      .where(sql`${t.revokedAt} is null and ${t.permissionSetId} is not null`),
    uniqueIndex('bindings_active_app_role_uq')
      .on(t.principalType, t.principalId, t.scopeType, t.scopeId, t.appRoleId)
      .where(sql`${t.revokedAt} is null and ${t.appRoleId} is not null`),
  ],
);

/**
 * Apps: the packages that capabilities ship in (design §6). The definition itself lives in
 * app_revisions; `current_revision` points at the one in use.
 */
export const apps = pgTable(
  'apps',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    /** A short identifier, unique in its space. Tool names for agents start with it. */
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: ['active', 'deleted'] })
      .notNull()
      .default('active'),
    /** The newest revision of the main line. A team app's environments run releases of it. */
    currentRevision: integer('current_revision').notNull(),
    /**
     * Set on a working copy: a personal app in which one builder changes a team app (design §3).
     * Changes go back to the team app through change requests.
     */
    workingCopyOf: uuid('working_copy_of').references((): AnyPgColumn => apps.id),
    /** For a working copy: the team app's main-line revision that the copy last took in. */
    baseRevision: integer('base_revision'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', tz),
  },
  (t) => [
    index('apps_space_idx').on(t.spaceId),
    uniqueIndex('apps_space_handle_uq').on(t.spaceId, t.handle).where(sql`${t.status} = 'active'`),
    uniqueIndex('apps_one_working_copy_uq')
      .on(t.workingCopyOf, t.ownerUserId)
      .where(sql`${t.status} = 'active' and ${t.workingCopyOf} is not null`),
    check('apps_working_copy_has_base', sql`(${t.workingCopyOf} is null) = (${t.baseRevision} is null)`),
  ],
);

/** Every saved version of an app's definition. Kept for history, diffs and audit. */
export const appRevisions = pgTable(
  'app_revisions',
  {
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    revision: integer('revision').notNull(),
    definition: jsonb('definition').$type<Json>().notNull(),
    /** SHA-256 of the definition's canonical JSON. */
    digest: text('digest').notNull(),
    /** The migration steps and notes of the save that made this revision. */
    summary: jsonb('summary').$type<Json>(),
    /**
     * Set on the head of a change request: a revision off the main line, which the request's
     * preview runs. Main-line revisions have none.
     */
    changeRequestId: uuid('change_request_id'),
    createdByType: text('created_by_type', { enum: actorTypes }).notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.revision] })],
);

/**
 * Where an app runs. Each environment has its own database schema and NOLOGIN role (design §6.8).
 * A personal app has one: its sandbox. A team app has Prod, optionally Staging, and a preview for
 * each open change request.
 */
export const appEnvironments = pgTable(
  'app_environments',
  {
    id: uuid('id').primaryKey(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    kind: text('kind', { enum: ['sandbox', 'preview', 'staging', 'prod'] }).notNull(),
    schemaName: text('schema_name').notNull(),
    dbRole: text('db_role').notNull(),
    /** The definition revision whose data model the schema has. */
    appliedRevision: integer('applied_revision').notNull(),
    /**
     * The revision whose definition the environment runs. After a rollback it is behind
     * applied_revision: the schema keeps the newer tables and columns, which the older
     * definition ignores (expand and contract, design §7.1).
     */
    activeRevision: integer('active_revision').notNull(),
    /** Staging and Prod: the release that is live. */
    activeReleaseId: uuid('active_release_id').references((): AnyPgColumn => releases.id),
    /** A preview: the change request it shows. */
    changeRequestId: uuid('change_request_id').references((): AnyPgColumn => changeRequests.id),
    status: text('status', { enum: ['active', 'deleted'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('app_environments_schema_uq').on(t.schemaName),
    uniqueIndex('app_environments_app_kind_uq')
      .on(t.appId, t.kind)
      .where(sql`${t.status} = 'active' and ${t.kind} <> 'preview'`),
    uniqueIndex('app_environments_preview_uq').on(t.changeRequestId).where(sql`${t.status} = 'active'`),
    check('app_environments_previews_show_changes', sql`(${t.kind} = 'preview') = (${t.changeRequestId} is not null)`),
  ],
);

/**
 * A change to a team app, from a builder's working copy (design §6.7). The head is a revision off
 * the main line; merging makes it (or its merge with newer main-line changes) the next main-line
 * revision.
 */
export const changeRequests = pgTable(
  'change_requests',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    /** Numbered per app: change request #3. */
    number: integer('number').notNull(),
    workingCopyId: uuid('working_copy_id').references(() => apps.id),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: ['open', 'merged', 'closed'] })
      .notNull()
      .default('open'),
    /** The main-line revision the change starts from. */
    baseRevision: integer('base_revision').notNull(),
    headRevision: integer('head_revision').notNull(),
    /** SHA-256 of the head definition. Reviews name it, so an approval covers exactly what was seen. */
    headDigest: text('head_digest').notNull(),
    /** The automatic checks of the head: validation, migration plan, permission and capability diffs, lint. */
    checks: jsonb('checks').$type<Json>().notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    mergedRevision: integer('merged_revision'),
    mergedAt: timestamp('merged_at', tz),
    mergedByType: text('merged_by_type', { enum: actorTypes }),
    mergedBy: uuid('merged_by'),
    closedAt: timestamp('closed_at', tz),
    closedByType: text('closed_by_type', { enum: actorTypes }),
    closedBy: uuid('closed_by'),
  },
  (t) => [
    uniqueIndex('change_requests_app_number_uq').on(t.appId, t.number),
    uniqueIndex('change_requests_one_open_per_copy_uq').on(t.workingCopyId).where(sql`${t.status} = 'open'`),
    index('change_requests_space_idx').on(t.spaceId, t.status),
  ],
);

/** Reviews of a change request. Each names the head it reviewed, so a new head needs new approvals. */
export const changeReviews = pgTable(
  'change_reviews',
  {
    id: uuid('id').primaryKey(),
    changeRequestId: uuid('change_request_id')
      .notNull()
      .references(() => changeRequests.id),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id),
    verdict: text('verdict', { enum: ['approve', 'request_changes', 'comment'] }).notNull(),
    headDigest: text('head_digest').notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [index('change_reviews_request_idx').on(t.changeRequestId, t.createdAt)],
);

/**
 * Releases of a team app: one main-line revision, hashed and signed. Immutable: a trigger rejects
 * UPDATE and DELETE. Rolling back re-activates an earlier release (design §7.1).
 */
export const releases = pgTable(
  'releases',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    /** Numbered per app: release 4. */
    number: integer('number').notNull(),
    revision: integer('revision').notNull(),
    /** SHA-256 of the definition. */
    digest: text('digest').notNull(),
    previousReleaseId: uuid('previous_release_id').references((): AnyPgColumn => releases.id),
    /** True if the step from the previous release deletes data. Such a release holds one change only. */
    destructive: boolean('destructive').notNull(),
    /** The migration steps from the previous release, and the change requests the release holds. */
    contents: jsonb('contents').$type<Json>().notNull(),
    notes: text('notes'),
    /** SHA-256 of the release's canonical manifest, and the platform's signature over it. */
    manifestDigest: text('manifest_digest').notNull(),
    keyId: text('key_id').notNull(),
    signature: text('signature').notNull(),
    createdByType: text('created_by_type', { enum: actorTypes }).notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('releases_app_number_uq').on(t.appId, t.number), uniqueIndex('releases_app_revision_uq').on(t.appId, t.revision)],
);

/**
 * Deploying a release to Staging or Prod, or rolling back to an earlier one: planned, approved as
 * the environment requires, then executed (design §7.1).
 */
export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    environmentKind: text('environment_kind', { enum: ['staging', 'prod'] }).notNull(),
    /** Set once the environment exists: the first deployment to it creates it. */
    environmentId: uuid('environment_id').references(() => appEnvironments.id),
    kind: text('kind', { enum: ['deploy', 'rollback'] }).notNull(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id),
    /** The release that was live when the deployment was planned. None for the first one. */
    fromReleaseId: uuid('from_release_id').references(() => releases.id),
    status: text('status', { enum: ['awaiting_approval', 'approved', 'succeeded', 'failed', 'cancelled'] }).notNull(),
    /** The migration steps, and what the plan was made against: it is checked again before executing. */
    plan: jsonb('plan').$type<Json>().notNull(),
    destructive: boolean('destructive').notNull(),
    approvalsRequired: integer('approvals_required').notNull(),
    requestedByType: text('requested_by_type', { enum: actorTypes }).notNull(),
    requestedBy: uuid('requested_by'),
    requestedAt: timestamp('requested_at', tz).notNull(),
    executedByType: text('executed_by_type', { enum: actorTypes }),
    executedBy: uuid('executed_by'),
    startedAt: timestamp('started_at', tz),
    finishedAt: timestamp('finished_at', tz),
    error: text('error'),
  },
  (t) => [
    index('deployments_app_idx').on(t.appId, t.requestedAt),
    uniqueIndex('deployments_one_open_per_env_uq')
      .on(t.appId, t.environmentKind)
      .where(sql`${t.status} in ('awaiting_approval', 'approved')`),
  ],
);

/** People who approved a deployment. Someone who authored a change in it cannot (design §5.7). */
export const deploymentApprovals = pgTable(
  'deployment_approvals',
  {
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    approverId: uuid('approver_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.approverId] })],
);

/**
 * Actions an agent prepared that wait for the person they act for (design §6.3). The effect is
 * exactly what will be written, and the digest seals it: approving names the digest.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => appEnvironments.id),
    action: text('action').notNull(),
    /** The definition revision the proposal was checked against. */
    revision: integer('revision').notNull(),
    /** For updates: the record, and the version it had when the proposal was made. */
    recordId: uuid('record_id'),
    baseVersion: integer('base_version'),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'superseded', 'expired'] })
      .notNull()
      .default('pending'),
    /** The values the action writes, after its own fixed values and defaults. */
    effect: jsonb('effect').$type<Json>().notNull(),
    findings: jsonb('findings').$type<Json>().notNull(),
    provenance: jsonb('provenance').$type<Json>().notNull(),
    card: jsonb('card').$type<Json>().notNull(),
    digest: text('digest').notNull(),
    proposedByType: text('proposed_by_type', { enum: actorTypes }).notNull(),
    proposedBy: uuid('proposed_by'),
    /** The token the proposal came through, if any. */
    proposedWithToken: uuid('proposed_with_token'),
    /** The person the action is for. Only they can approve it. */
    onBehalfOf: uuid('on_behalf_of')
      .notNull()
      .references(() => users.id),
    /** The proposal this one revises, when the person edited it. */
    revises: uuid('revises'),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    decidedAt: timestamp('decided_at', tz),
    decisionNote: text('decision_note'),
    resultRecordId: uuid('result_record_id'),
  },
  (t) => [index('proposals_person_idx').on(t.onBehalfOf, t.status), index('proposals_app_idx').on(t.appId)],
);

/** Org-level rules that deny, or demand fresh MFA, regardless of grants. */
export const guardrails = pgTable('guardrails', {
  id: text('id').primaryKey(),
  orgId: uuid('org_id').references(() => orgs.id),
  name: text('name').notNull(),
  description: text('description'),
  actions: text('actions').array().notNull(),
  effect: text('effect', { enum: ['deny', 'step_up'] }).notNull(),
  condition: jsonb('condition').$type<Json>(),
  maxMfaAgeSeconds: integer('max_mfa_age_seconds'),
  enabled: boolean('enabled').notNull().default(true),
  managed: boolean('managed').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Server-side sessions. Only a SHA-256 hash of the session token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    revokedAt: timestamp('revoked_at', tz),
    /** When the IdP last confirmed MFA for this login, if it did. */
    mfaAt: timestamp('mfa_at', tz),
    authTime: timestamp('auth_time', tz),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/**
 * The audit log (design §9.2). Append-only: a trigger rejects UPDATE, DELETE and TRUNCATE.
 * `digest` is the SHA-256 of the event's canonical form; seals commit to digests in seq order.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid('id').notNull(),
    occurredAt: timestamp('occurred_at', tz).notNull(),
    /**
     * Database wall-clock time of the insert (clock_timestamp(), not the transaction start), so it
     * follows insertion order. Used by the sealer's safety window; not part of the digest.
     */
    recordedAt: timestamp('recorded_at', tz)
      .notNull()
      .default(sql`clock_timestamp()`),
    orgId: uuid('org_id').notNull(),
    spaceId: uuid('space_id'),
    appId: uuid('app_id'),
    env: text('env'),
    actor: jsonb('actor').$type<Json>().notNull(),
    action: text('action').notNull(),
    target: jsonb('target').$type<Json>(),
    outcome: text('outcome', { enum: ['success', 'denied', 'error'] }).notNull(),
    reason: jsonb('reason').$type<Json>(),
    changes: jsonb('changes').$type<Json>(),
    context: jsonb('context').$type<Json>(),
    digest: text('digest').notNull(),
  },
  (t) => [
    uniqueIndex('audit_events_id_uq').on(t.id),
    index('audit_events_org_time_idx').on(t.orgId, t.occurredAt),
    index('audit_events_action_idx').on(t.action),
    index('audit_events_space_idx').on(t.spaceId),
    index('audit_events_recorded_idx').on(t.recordedAt),
  ],
);

/** Signed, chained seals over contiguous ranges of the audit log. Append-only. */
export const auditSeals = pgTable(
  'audit_seals',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    fromSeq: bigint('from_seq', { mode: 'number' }).notNull(),
    toSeq: bigint('to_seq', { mode: 'number' }).notNull(),
    eventCount: integer('event_count').notNull(),
    merkleRoot: text('merkle_root').notNull(),
    prevSealHash: text('prev_seal_hash'),
    sealedAt: timestamp('sealed_at', tz).notNull(),
    keyId: text('key_id').notNull(),
    sealHash: text('seal_hash').notNull(),
    signature: text('signature').notNull(),
  },
  (t) => [uniqueIndex('audit_seals_from_seq_uq').on(t.fromSeq), check('audit_seals_range', sql`${t.toSeq} >= ${t.fromSeq}`)],
);
