import type { SignatureVerifier, Signer } from '@platform/audit';
import type { Principal } from '@platform/authz';
import type { Database } from '@platform/db';
import type { PolicyService } from './access/policy-service.js';
import type { OidcProvider } from './auth/oidc.js';
import type { SessionService } from './auth/sessions.js';
import type { Config } from './config.js';

/** Everything the API needs, created once at startup and passed explicitly. */
export interface AppContext {
  readonly config: Config;
  readonly db: Database;
  readonly org: { readonly id: string; readonly name: string };
  readonly oidc: OidcProvider;
  readonly policy: PolicyService;
  readonly sessions: SessionService;
  readonly auditSigner: Signer;
  readonly auditVerifier: SignatureVerifier;
  /** The clock. Injectable so tests can move time. */
  readonly now: () => Date;
}

/** The signed-in user behind a request. */
export interface AuthContext {
  readonly user: { readonly id: string; readonly email: string | null; readonly displayName: string | null };
  readonly principal: Principal;
  readonly sessionId: string;
}
