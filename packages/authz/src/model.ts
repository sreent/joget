import type { Condition } from './conditions.js';

/** Scopes nest: org → space → app → env. Bindings apply to their scope and everything below it. */
export type ScopeType = 'org' | 'space' | 'app' | 'env';

export interface ScopeRef {
  readonly type: ScopeType;
  readonly id: string;
  /** Set on personal spaces. Org-level grants do not reach inside them (see PERSONAL_SPACE_ORG_PERMISSIONS). */
  readonly personal?: boolean;
}

export type PrincipalType = 'user' | 'group' | 'service_account';

/** Who is asking. Groups are resolved by the caller (from the IdP or the directory). */
export interface Principal {
  readonly type: 'user' | 'service_account';
  readonly id: string;
  readonly groupIds: readonly string[];
  /** Permission patterns carried by an access token. Effective permissions = grants ∩ token scopes. */
  readonly tokenScopes?: readonly string[];
  /** When the principal last completed MFA, as reported by the IdP. */
  readonly mfaAt?: Date;
  /** Extra attributes available to conditions as `principal.<name>`, for example a department. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /**
   * Bindings the server gives the principal itself, instead of those stored: the role of the
   * person an app's test acts as. Never taken from a request.
   */
  readonly bindings?: readonly Binding[];
}

/** Which fields of a record a grant covers. Absent means every field. */
export type FieldSelection = { readonly include: readonly string[] } | { readonly exclude: readonly string[] };

/** One entry in a permission set. */
export interface PermissionGrant {
  /** A permission or pattern, for example `app.edit` or `record.*`. */
  readonly permission: string;
  /** Narrows the grant to one resource, for example an entity name. Defaults to `*`. */
  readonly resource?: string;
  /**
   * The grant applies only when this condition holds. For record permissions it may refer to the
   * record (`record.<field>`): see authorizeQuery, which turns that part into a filter.
   */
  readonly condition?: Condition;
  /** For record permissions: the fields this grant lets you read, or write. */
  readonly fields?: FieldSelection;
  /** For record reads: fields that are shown masked rather than in full. */
  readonly mask?: readonly string[];
  /** For record writes: a condition the record must satisfy after the change. */
  readonly check?: Condition;
}

/** A reusable, named bundle of permissions. Permission sets only ever add permissions. */
export interface PermissionSet {
  readonly id: string;
  readonly name: string;
  readonly scopeType: ScopeType;
  readonly grants: readonly PermissionGrant[];
  readonly managed?: boolean;
}

/** A job function made of one or more permission sets, intended for one scope type. */
export interface Role {
  readonly id: string;
  readonly name: string;
  readonly scopeType: ScopeType;
  readonly permissionSetIds: readonly string[];
  readonly managed?: boolean;
}

/** Grants a role or a permission set to a principal at a scope, optionally until a time. */
export interface Binding {
  readonly id: string;
  readonly principalType: PrincipalType;
  readonly principalId: string;
  readonly roleId?: string;
  readonly permissionSetId?: string;
  readonly scope: Pick<ScopeRef, 'type' | 'id'>;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
}

/** An org-level rule that can deny an action, or demand fresh MFA, regardless of grants. */
export interface Guardrail {
  readonly id: string;
  readonly name: string;
  /** Permission patterns this guardrail applies to. */
  readonly actions: readonly string[];
  readonly effect: 'deny' | 'step_up';
  /** The guardrail applies only when this condition holds. */
  readonly when?: Condition;
  /** For `step_up`: the maximum age of the principal's last MFA. */
  readonly maxMfaAgeSeconds?: number;
  readonly enabled?: boolean;
  readonly managed?: boolean;
}

/** What is being acted on. */
export interface Resource {
  readonly type: string;
  readonly id?: string;
  /** Matched against grant resource selectors, for example an entity name. */
  readonly selector?: string;
  /** The scope chain, most specific first: for example [env, app, space, org]. */
  readonly scopes: readonly ScopeRef[];
  /** Available to conditions as `resource.<name>`. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly action: string;
  readonly resource: Resource;
  /** Available to conditions as `context.<name>`, for example the author of a change. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** The record acted on, if any, available to conditions as `record.<field>`. */
  readonly record?: Readonly<Record<string, unknown>>;
  /** Candidate bindings of the principal and its groups. Others are ignored. */
  readonly bindings: readonly Binding[];
  readonly now?: Date;
}

export type Reason =
  | {
      readonly kind: 'granted';
      readonly bindingId: string;
      readonly roleId?: string;
      readonly permissionSetId: string;
      readonly permission: string;
      readonly scope: Pick<ScopeRef, 'type' | 'id'>;
    }
  | { readonly kind: 'no_matching_grant' }
  | { readonly kind: 'outside_token_scope' }
  | { readonly kind: 'personal_space_boundary'; readonly bindingIds: readonly string[] }
  | { readonly kind: 'condition_not_met'; readonly bindingIds: readonly string[] }
  | { readonly kind: 'denied_by_guardrail'; readonly guardrailId: string; readonly name: string }
  | {
      readonly kind: 'step_up_required';
      readonly guardrailId: string;
      readonly name: string;
      readonly maxMfaAgeSeconds: number;
    };

export interface Decision {
  readonly allowed: boolean;
  readonly action: string;
  readonly reasons: readonly Reason[];
}
