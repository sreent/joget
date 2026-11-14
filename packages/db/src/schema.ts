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
    check('bindings_role_xor_permission_set', sql`(${t.roleId} is null) <> (${t.permissionSetId} is null)`),
    uniqueIndex('bindings_active_role_uq')
      .on(t.principalType, t.principalId, t.scopeType, t.scopeId, t.roleId)
      .where(sql`${t.revokedAt} is null and ${t.roleId} is not null`),
    uniqueIndex('bindings_active_permission_set_uq')
      .on(t.principalType, t.principalId, t.scopeType, t.scopeId, t.permissionSetId)
      .where(sql`${t.revokedAt} is null and ${t.permissionSetId} is not null`),
  ],
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
