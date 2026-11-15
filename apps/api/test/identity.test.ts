import { describe, expect, it } from 'vitest';
import { createResilientOidcProvider, IdpUnavailableError, identityFromClaims, mfaTimestamp } from '../src/auth/oidc.js';
import { loadConfig } from '../src/config.js';

const base = {
  PUBLIC_BASE_URL: 'https://platform.example.com',
  DATABASE_URL: 'postgres://localhost/platform',
  OIDC_ISSUER: 'https://idp.example.com',
  OIDC_CLIENT_ID: 'platform',
  COOKIE_SECRET: 'x'.repeat(32),
};

describe('identityFromClaims works with any OIDC provider', () => {
  it('maps Entra ID–style claims', () => {
    const identity = identityFromClaims(
      {
        iss: 'https://login.microsoftonline.com/tenant/v2.0',
        sub: 'AAAAbbbb',
        email: 'Alice@Example.com',
        name: 'Alice',
        groups: ['3f2a-finance', '9c1d-engineering', 42],
        amr: ['pwd', 'mfa'],
        auth_time: 1_763_100_000,
      },
      'groups',
    );
    expect(identity).toEqual({
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      subject: 'AAAAbbbb',
      email: 'alice@example.com',
      emailVerified: false,
      name: 'Alice',
      groups: ['3f2a-finance', '9c1d-engineering'],
      amr: ['pwd', 'mfa'],
      acr: null,
      authTime: new Date(1_763_100_000_000),
    });
  });

  it('reads groups from whatever claim the IdP uses', () => {
    const identity = identityFromClaims({ iss: 'https://acme.okta.com', sub: '00u1', okta_groups: ['Builders', 'Builders'] }, 'okta_groups');
    expect(identity.groups).toEqual(['Builders']);
  });

  it('falls back to preferred_username for the display name', () => {
    const identity = identityFromClaims(
      { iss: 'http://localhost:8080/realms/platform', sub: 'f1', preferred_username: 'carol', email: 'carol@example.com', email_verified: true },
      'groups',
    );
    expect(identity).toMatchObject({ name: 'carol', emailVerified: true, groups: [], amr: [] });
  });

  it('rejects tokens without an issuer or subject', () => {
    expect(() => identityFromClaims({ iss: 'https://idp', sub: '' }, 'groups')).toThrow();
    expect(() => identityFromClaims({ sub: 'x' }, 'groups')).toThrow();
  });
});

describe('mfaTimestamp reads MFA evidence the way it is configured', () => {
  const identity = identityFromClaims({ iss: 'https://idp', sub: 's', amr: ['pwd', 'otp'], acr: 'urn:acme:loa:2', auth_time: 1000 }, 'groups');
  const now = new Date(5_000_000);

  it('uses RFC 8176 amr values', () => {
    expect(mfaTimestamp(identity, loadConfig({ ...base, MFA_AMR_VALUES: 'mfa,otp' }), now)).toEqual(new Date(1_000_000));
    expect(mfaTimestamp(identity, loadConfig(base), now)).toBeNull();
  });

  it('uses acr assurance levels', () => {
    expect(mfaTimestamp(identity, loadConfig({ ...base, MFA_EVIDENCE: 'acr', MFA_ACR_VALUES: 'urn:acme:loa:2' }), now)).toEqual(new Date(1_000_000));
    expect(mfaTimestamp(identity, loadConfig({ ...base, MFA_EVIDENCE: 'acr', MFA_ACR_VALUES: 'urn:acme:loa:3' }), now)).toBeNull();
  });
});

describe('createResilientOidcProvider', () => {
  it('reports an unreachable IdP instead of failing at startup, and keeps retrying', async () => {
    const errors: unknown[] = [];
    // Nothing listens on port 9 here, so discovery fails fast.
    const provider = createResilientOidcProvider(loadConfig({ ...base, OIDC_ISSUER: 'http://127.0.0.1:9', OIDC_ALLOW_HTTP: 'true' }), (e) => errors.push(e));
    expect(await provider.warmUp()).toBe(false);
    await expect(provider.startLogin({ redirectUri: 'https://platform.example.com/auth/callback' })).rejects.toBeInstanceOf(IdpUnavailableError);
    expect(errors).toHaveLength(2);
  });
});

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ MFA_EVIDENCE: 'amr', MFA_AMR_VALUES: ['mfa'], COOKIE_SECURE: true, MIN_TEAM_SPACE_OWNERS: 2 });
  });

  it('refuses unsafe settings in production', () => {
    const unsafe = { ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://platform.example.com', MFA_EVIDENCE: 'assume', COOKIE_SECURE: 'false', OIDC_ALLOW_HTTP: 'true' };
    for (const setting of ['MFA_EVIDENCE=assume', 'COOKIE_SECURE', 'OIDC_ALLOW_HTTP', 'AUDIT_SIGNING_KEY_PEM', 'https']) {
      expect(() => loadConfig(unsafe)).toThrow(new RegExp(setting));
    }
  });
});
