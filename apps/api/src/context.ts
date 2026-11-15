import type { SignatureVerifier, Signer } from '@platform/audit';
import type { Principal } from '@platform/authz';
import type { Database } from '@platform/db';
import type pg from 'pg';
import type { AppCatalog } from './apps/catalog.js';
import type { PolicyService } from './access/policy-service.js';
import type { OidcProvider } from './auth/oidc.js';
import type { SessionService } from './auth/sessions.js';
import type { Config } from './config.js';
import type { TokenService } from './tokens/service.js';

/** Everything the API needs, created once at startup and passed explicitly. */
export interface AppContext {
  readonly config: Config;
  readonly db: Database;
  /** The same database as `db`, for transactions that switch to an app's own role (design §6.8). */
  readonly pool: pg.Pool;
  readonly apps: AppCatalog;
  readonly org: { readonly id: string; readonly name: string };
  readonly oidc: OidcProvider;
  readonly policy: PolicyService;
  readonly sessions: SessionService;
  readonly tokens: TokenService;
  readonly auditSigner: Signer;
  readonly auditVerifier: SignatureVerifier;
  /** The clock. Injectable so tests can move time. */
  readonly now: () => Date;
}

/** Who is calling: a person or a service account. */
export interface Actor {
  readonly type: 'user' | 'service_account';
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
}

/** How they proved it: an interactive session (cookie) or an API token (bearer). */
export type Credential =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'token'; readonly tokenId: string; readonly scopes: readonly string[] };

/** The authenticated caller behind a request. */
export interface AuthContext {
  readonly actor: Actor;
  /** What the policy decision point sees; token scopes are already applied. */
  readonly principal: Principal;
  readonly credential: Credential;
}
