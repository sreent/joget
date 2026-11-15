import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as client from 'openid-client';
import type { Config } from '../config.js';

/** What the platform needs to know about a login. Built from standard OIDC claims only. */
export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly groups: readonly string[];
  /** Authentication methods (RFC 8176), for example ["pwd", "mfa"]. */
  readonly amr: readonly string[];
  readonly acr: string | null;
  readonly authTime: Date | null;
}

export interface LoginStart {
  readonly url: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

/** The port the API depends on. Any OIDC-compliant IdP can sit behind it. */
export interface OidcProvider {
  startLogin(options: { redirectUri: string; forceReauthentication?: boolean; acrValues?: readonly string[] }): Promise<LoginStart>;
  completeLogin(options: {
    callbackUrl: URL;
    redirectUri: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<OidcIdentity>;
  /**
   * Check a token the IdP issued for a person, such as the ID token an agent received when the
   * person signed in to it, and return who it names. Used for token exchange (RFC 8693).
   */
  verifyToken(token: string): Promise<OidcIdentity>;
}

const MAX_GROUPS = 500;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Map ID-token claims to an identity. `groupsClaim` is configurable because IdPs name it differently. */
export function identityFromClaims(claims: Record<string, unknown>, groupsClaim: string, subjectClaim = 'sub'): OidcIdentity {
  const { iss } = claims;
  const sub = claims[subjectClaim];
  if (typeof iss !== 'string' || typeof sub !== 'string' || !iss || !sub) {
    throw new Error(`The token has no issuer or no ${subjectClaim} claim`);
  }
  const name = [claims['name'], claims['preferred_username']].find((v): v is string => typeof v === 'string' && v.length > 0);
  return {
    issuer: iss,
    subject: sub,
    email: typeof claims['email'] === 'string' ? claims['email'].toLowerCase() : null,
    emailVerified: claims['email_verified'] === true,
    name: name ?? null,
    groups: [...new Set(stringArray(claims[groupsClaim]))].slice(0, MAX_GROUPS),
    amr: stringArray(claims['amr']),
    acr: typeof claims['acr'] === 'string' ? claims['acr'] : null,
    authTime: typeof claims['auth_time'] === 'number' ? new Date(claims['auth_time'] * 1000) : null,
  };
}

/** When the IdP last confirmed MFA for this login, or null if it did not. */
export function mfaTimestamp(identity: OidcIdentity, config: Config, now: Date): Date | null {
  const at = identity.authTime ?? now;
  switch (config.MFA_EVIDENCE) {
    case 'assume':
      return at;
    case 'amr':
      return identity.amr.some((method) => config.MFA_AMR_VALUES.includes(method)) ? at : null;
    case 'acr':
      return identity.acr !== null && config.MFA_ACR_VALUES.includes(identity.acr) ? at : null;
  }
}

/** The identity provider could not be reached (discovery failed). */
export class IdpUnavailableError extends Error {
  override readonly name = 'IdpUnavailableError';
  constructor(cause: unknown) {
    super('The identity provider cannot be reached', { cause });
  }
}

/**
 * Discover the IdP lazily, and try again on the next sign-in after a failure. An IdP outage at
 * startup therefore doesn't crash-loop the platform: health checks and API tokens keep working,
 * and sign-in answers 503 until the IdP is reachable.
 */
export function createResilientOidcProvider(
  config: Config,
  onError: (error: unknown) => void = () => {},
): OidcProvider & { warmUp(): Promise<boolean> } {
  let discovered: Promise<OidcProvider> | undefined;
  const provider = () => {
    discovered ??= createOpenIdProvider(config).catch((error: unknown) => {
      discovered = undefined;
      onError(error);
      throw new IdpUnavailableError(error);
    });
    return discovered;
  };
  return {
    warmUp: () => provider().then(() => true, () => false),
    startLogin: async (options) => (await provider()).startLogin(options),
    completeLogin: async (options) => (await provider()).completeLogin(options),
    verifyToken: async (token) => (await provider()).verifyToken(token),
  };
}

/** The token was not issued by the IdP for an audience Ambit accepts, or is no longer valid. */
export class InvalidSubjectTokenError extends Error {
  override readonly name = 'InvalidSubjectTokenError';
}

/**
 * Verify a JWT the IdP issued for a person: its signature against the IdP's published keys, its
 * issuer, one of the accepted audiences, and its expiry.
 */
export function createTokenVerifier(options: {
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly keys: JWTVerifyGetKey;
  readonly groupsClaim: string;
  readonly subjectClaim: string;
}): (token: string) => Promise<OidcIdentity> {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        issuer: options.issuer,
        audience: [...options.audiences],
        clockTolerance: 30,
        requiredClaims: ['exp'],
      });
      return identityFromClaims(payload as Record<string, unknown>, options.groupsClaim, options.subjectClaim);
    } catch (error) {
      throw new InvalidSubjectTokenError(error instanceof Error ? error.message : 'Invalid token', { cause: error });
    }
  };
}

/** The real provider: OpenID Connect discovery, authorization code flow with PKCE. */
export async function createOpenIdProvider(config: Config): Promise<OidcProvider> {
  const execute = config.OIDC_ALLOW_HTTP ? [client.allowInsecureRequests] : [];
  const configuration = await client.discovery(
    new URL(config.OIDC_ISSUER),
    config.OIDC_CLIENT_ID,
    config.OIDC_CLIENT_SECRET,
    config.OIDC_CLIENT_SECRET ? client.ClientSecretPost(config.OIDC_CLIENT_SECRET) : client.None(),
    { execute },
  );

  return {
    async startLogin({ redirectUri, forceReauthentication, acrValues }) {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const parameters: Record<string, string> = {
        redirect_uri: redirectUri,
        scope: config.OIDC_SCOPES,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      };
      // Step-up: ask the IdP for a fresh login (and a stronger method, if configured) with standard parameters.
      if (forceReauthentication) parameters['max_age'] = '0';
      if (acrValues && acrValues.length > 0) parameters['acr_values'] = acrValues.join(' ');
      return { url: client.buildAuthorizationUrl(configuration, parameters).href, state, nonce, codeVerifier };
    },

    async completeLogin({ callbackUrl, state, nonce, codeVerifier }) {
      const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('The IdP did not return an ID token');
      return identityFromClaims(claims as Record<string, unknown>, config.OIDC_GROUPS_CLAIM, config.OIDC_SUBJECT_CLAIM);
    },

    verifyToken: (() => {
      const metadata = configuration.serverMetadata();
      if (!metadata.jwks_uri) return async () => Promise.reject(new InvalidSubjectTokenError('The IdP publishes no signing keys'));
      return createTokenVerifier({
        issuer: metadata.issuer,
        audiences: config.TOKEN_EXCHANGE_AUDIENCES.length ? config.TOKEN_EXCHANGE_AUDIENCES : [config.OIDC_CLIENT_ID],
        keys: createRemoteJWKSet(new URL(metadata.jwks_uri)),
        groupsClaim: config.OIDC_GROUPS_CLAIM,
        subjectClaim: config.OIDC_SUBJECT_CLAIM,
      });
    })(),
  };
}
