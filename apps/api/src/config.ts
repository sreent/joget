import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const list = (fallback = '') =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

/** All configuration comes from environment variables, validated at startup. */
export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    /** The externally visible base URL, for example https://platform.example.com */
    PUBLIC_BASE_URL: z.url(),
    TRUST_PROXY: bool.default(false),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1),
    RUN_MIGRATIONS: bool.default(false),

    ORG_NAME: z.string().min(1).default('My company'),
    /** Users with these verified emails become org owners on first login (bootstrap only). */
    ORG_OWNER_EMAILS: list().transform((emails) => emails.map((email) => email.toLowerCase())),

    // Identity: any OIDC provider. Nothing here is specific to one IdP.
    OIDC_ISSUER: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid profile email'),
    /** The ID-token claim that carries group names or IDs. */
    OIDC_GROUPS_CLAIM: z.string().default('groups'),
    /**
     * The claim that identifies a person. `sub` is standard, but some IdPs make it different for
     * each application: Entra ID does, so set `oid` there, the ID that's the same everywhere in a
     * tenant. Agents' tokens then name the same person as sign-ins do. Set it before the first sign-in.
     */
    OIDC_SUBJECT_CLAIM: z.string().min(1).default('sub'),
    /**
     * Audiences accepted on a person's token in a token exchange (comma-separated): Ambit's own
     * client ID, and those of agents that exchange the tokens they were given. Defaults to Ambit's.
     */
    TOKEN_EXCHANGE_AUDIENCES: list(),
    /** How long a token for an agent acting for a person lives. Agents exchange again when it runs out. */
    DELEGATED_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    /** Allow an http:// issuer. For local development only. */
    OIDC_ALLOW_HTTP: bool.default(false),
    /**
     * How the IdP proves MFA: `amr` (RFC 8176 values in the amr claim), `acr` (an assurance level),
     * or `assume` (treat every login as MFA; development only).
     */
    MFA_EVIDENCE: z.enum(['amr', 'acr', 'assume']).default('amr'),
    MFA_AMR_VALUES: list('mfa'),
    MFA_ACR_VALUES: list(),

    SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(720),
    SESSION_COOKIE_NAME: z.string().default('platform_session'),
    COOKIE_SECURE: bool.default(true),
    /** Signs the short-lived login-state cookie. At least 32 characters. */
    COOKIE_SECRET: z.string().min(32),

    MIN_TEAM_SPACE_OWNERS: z.coerce.number().int().min(1).default(2),

    /** The longest a personal access token may live. */
    PAT_MAX_TTL_DAYS: z.coerce.number().int().min(1).max(366).default(90),
    /** Personal spaces stay small (design §3): at most this many apps, each shared with at most this many people. */
    PERSONAL_SPACE_MAX_APPS: z.coerce.number().int().min(1).default(20),
    PERSONAL_APP_MAX_SHARES: z.coerce.number().int().min(1).default(10),
    /** How long an agent's proposal waits for the person before it expires. */
    PROPOSAL_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
    /** The longest a service-account token may live. */
    SERVICE_ACCOUNT_TOKEN_MAX_TTL_DAYS: z.coerce.number().int().min(1).max(366).default(90),

    /** Ed25519 private key (PKCS#8 PEM) that signs audit seals. Required in production. */
    AUDIT_SIGNING_KEY_PEM: z.string().min(1).optional(),
    AUDIT_SIGNING_KEY_ID: z.string().min(1).default('audit-signing-key-1'),
    /** JSON object of older public keys still needed to verify past seals: {"keyId": "PEM"} */
    AUDIT_VERIFY_PUBLIC_KEYS: z
      .string()
      .default('{}')
      .transform((value, ctx) => {
        try {
          const parsed: unknown = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
        } catch {
          // reported below
        }
        ctx.addIssue({ code: 'custom', message: 'Must be a JSON object of keyId to PEM public key' });
        return z.NEVER;
      }),
    /** How often the in-process sealer runs. 0 disables it (for example, when a worker seals). */
    AUDIT_SEAL_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
    /** Only events older than this are sealed, so no in-flight transaction can land in a sealed range. */
    AUDIT_SEAL_SAFETY_WINDOW_SECONDS: z.coerce.number().int().min(0).default(60),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;
    const rules: Array<[boolean, keyof typeof config, string]> = [
      [config.MFA_EVIDENCE === 'assume', 'MFA_EVIDENCE', 'MFA_EVIDENCE=assume is not allowed in production'],
      [!config.COOKIE_SECURE, 'COOKIE_SECURE', 'COOKIE_SECURE must be true in production'],
      [config.OIDC_ALLOW_HTTP, 'OIDC_ALLOW_HTTP', 'OIDC_ALLOW_HTTP must be false in production'],
      [!config.AUDIT_SIGNING_KEY_PEM, 'AUDIT_SIGNING_KEY_PEM', 'AUDIT_SIGNING_KEY_PEM is required in production'],
      [!config.PUBLIC_BASE_URL.startsWith('https://'), 'PUBLIC_BASE_URL', 'PUBLIC_BASE_URL must use https in production'],
    ];
    for (const [broken, path, message] of rules) {
      if (broken) ctx.addIssue({ code: 'custom', message, path: [path] });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
}
