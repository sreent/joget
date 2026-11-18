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
    /** The claims that carry a person's department and their manager's email, for routing tasks (design §6.10). Unset, the IdP gives neither. */
    OIDC_DEPARTMENT_CLAIM: z.string().min(1).optional(),
    OIDC_MANAGER_CLAIM: z.string().min(1).optional(),
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
    /** Approvals a change request needs before it can merge, from people other than its author (design §6.7). */
    CHANGE_APPROVALS: z.coerce.number().int().min(1).max(5).default(1),
    /** Approvals a Prod deployment needs, from people who authored none of its changes (design §7.1). */
    DEPLOY_PROD_APPROVALS: z.coerce.number().int().min(1).max(5).default(1),
    /** How long an agent's proposal waits for the person before it expires. */
    PROPOSAL_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(72),
    /** The longest a service-account token may live. */
    SERVICE_ACCOUNT_TOKEN_MAX_TTL_DAYS: z.coerce.number().int().min(1).max(366).default(90),

    /**
     * Where files people upload are kept: `postgres` keeps them in each app environment's own schema,
     * with its records; `s3` keeps them in any S3-compatible object store (S3, MinIO, Ceph, R2).
     */
    FILE_STORE: z.enum(['postgres', 's3']).default('postgres'),
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    /** For stores other than AWS, such as https://minio.example.com */
    S3_ENDPOINT: z.url().optional(),
    S3_FORCE_PATH_STYLE: bool.default(false),
    /** Optional: without them, the AWS SDK's own chain is used, such as a pod's workload identity. */
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** The largest file anyone may upload. */
    FILE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    /**
     * How uploads are checked for malware before anyone can use them: `clamav` asks a clamd server.
     * With `none`, files are marked as not scanned; in production, uploads are then refused.
     */
    FILE_SCANNER: z.enum(['none', 'clamav']).default('none'),
    CLAMAV_HOST: z.string().min(1).default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    /** How long an upload waits to be attached to a record. At least as long as a proposal waits. */
    FILE_UNATTACHED_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(24 * 7),
    /** How often expired uploads are removed. 0 turns it off, for example when a worker does it. */
    FILE_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(3600),

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
    /**
     * The model provider that the studio's chat builds apps with (vibe composition). Without it, the
     * chat is off. Only Anthropic for now.
     */
    AI_PROVIDER: z.enum(['anthropic']).optional(),
    /** The model the chat uses, as the provider names it. The installation chooses it: Ambit names none. */
    AI_MODEL: z.string().min(1).max(200).optional(),
    /** A file that holds the provider's API key. It is read at each request, so whatever issues the key can renew it. */
    AI_API_KEY_FILE: z.string().min(1).optional(),
    /** Another address for the provider's API, such as a gateway that the installation runs. */
    AI_BASE_URL: z.url().optional(),
    /** How much effort the model puts into each turn; off for a model that takes no effort setting. */
    AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'off']).default('high'),
    /** Whether a turn that the model declines goes on with the provider's fallback model: default, or off for a model or gateway that refuses the setting. */
    AI_FALLBACK: z.enum(['default', 'off']).default('default'),
    /** The most turns of the model in one request to the chat: each turn can read or change the definition. */
    AI_MAX_TURNS: z.coerce.number().int().min(1).max(30).default(12),
    /**
     * Where email goes out, for notices: an SMTP server, as smtp://mail.example.com:587, which must
     * then offer STARTTLS, or smtps://mail.example.com:465. Without it, notices stay in the app.
     */
    SMTP_URL: z.url().optional(),
    SMTP_USER: z.string().min(1).max(200).optional(),
    /** A file that holds the SMTP password. It is read at each sending, so whatever issues it can renew it. */
    SMTP_PASSWORD_FILE: z.string().min(1).optional(),
    /** Who email comes from, as "a3t <noreply@example.com>". */
    MAIL_FROM: z.string().min(3).max(200).default('a3t <noreply@localhost>'),
    /** How long a notice stays, read or not, before it goes. */
    NOTICE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    /** How long before a task is due its person hears that it is due soon. */
    TASK_DUE_SOON_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 14)
      .default(24),
    /**
     * A file that holds the key that seals the secrets environments keep for their connections and
     * webhooks: 32 random bytes, in base64. Required in production to keep any; elsewhere, a key
     * worked out from COOKIE_SECRET stands in.
     */
    SECRETS_KEY_FILE: z.string().min(1).optional(),
    /** The hosts that connections may call, as names or *.example.com; * for any public host. */
    OUTBOUND_HOSTS: z.string().default('*'),
    /** Hosts on a private network that connections may call all the same, such as payroll.internal. */
    OUTBOUND_PRIVATE_HOSTS: z.string().default(''),
    /** Whether connections may call plain http, without TLS: for development only. */
    OUTBOUND_ALLOW_HTTP: bool.default(false),
    /** How long a call to a service may take. */
    SERVICE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
    /** How often the timers of processes that are due fire. 0 disables it (for example, when a worker fires them). */
    PROCESS_TIMER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(5),
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
      [Boolean(config.AI_BASE_URL) && !config.AI_BASE_URL!.startsWith('https://'), 'AI_BASE_URL', 'AI_BASE_URL must use https in production'],
    ];
    for (const [broken, path, message] of rules) {
      if (broken) ctx.addIssue({ code: 'custom', message, path: [path] });
    }
  })
  .superRefine((config, ctx) => {
    if (config.FILE_STORE === 's3' && !config.S3_BUCKET) ctx.addIssue({ code: 'custom', message: 'FILE_STORE=s3 needs S3_BUCKET', path: ['S3_BUCKET'] });
    if (Boolean(config.S3_ACCESS_KEY_ID) !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither', path: ['S3_ACCESS_KEY_ID'] });
    }
    if (config.NODE_ENV === 'production' && config.OUTBOUND_ALLOW_HTTP)
      ctx.addIssue({ code: 'custom', message: 'OUTBOUND_ALLOW_HTTP must be false in production', path: ['OUTBOUND_ALLOW_HTTP'] });
    if (config.SMTP_URL && !/^smtps?:\/\//.test(config.SMTP_URL))
      ctx.addIssue({ code: 'custom', message: 'SMTP_URL must start with smtp:// or smtps://', path: ['SMTP_URL'] });
    if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD_FILE)) {
      ctx.addIssue({ code: 'custom', message: 'Set both SMTP_USER and SMTP_PASSWORD_FILE, or neither', path: ['SMTP_USER'] });
    }
    if (config.AI_PROVIDER && (!config.AI_MODEL || !config.AI_API_KEY_FILE)) {
      ctx.addIssue({ code: 'custom', message: 'AI_PROVIDER needs AI_MODEL and AI_API_KEY_FILE', path: ['AI_PROVIDER'] });
    }
    if (config.FILE_UNATTACHED_TTL_HOURS < config.PROPOSAL_TTL_HOURS) {
      ctx.addIssue({
        code: 'custom',
        message: 'FILE_UNATTACHED_TTL_HOURS must be at least PROPOSAL_TTL_HOURS, so files outlive the proposals that name them',
        path: ['FILE_UNATTACHED_TTL_HOURS'],
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
}
