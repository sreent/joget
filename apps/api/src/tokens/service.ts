import { randomBytes } from 'node:crypto';
import { sha256Hex, uuidv7 } from '@platform/audit';
import { apiTokens, serviceAccounts, users, type Database, type Executor } from '@platform/db';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { PolicyService } from '../access/policy-service.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AuthContext } from '../context.js';
import { unauthorized } from '../errors.js';

export type TokenRow = typeof apiTokens.$inferSelect;
export type TokenOwner = { readonly type: 'user'; readonly id: string } | { readonly type: 'service_account'; readonly id: string };

/**
 * Tokens look like `plt_pat_<32 chars>` (personal) or `plt_sat_<32 chars>` (service account): 192
 * random bits behind a fixed, recognizable prefix that secret scanners can be taught to find.
 */
const TOKEN_FORMAT = /^plt_(pat|sat)_[A-Za-z0-9_-]{32}$/;
/** Record last use at most this often, so authentication doesn't write on every request. */
const LAST_USED_RESOLUTION_MS = 5 * 60_000;

export function newToken(owner: TokenOwner): { token: string; secretHash: string; displayPrefix: string } {
  const token = `plt_${owner.type === 'user' ? 'pat' : 'sat'}_${randomBytes(24).toString('base64url')}`;
  return { token, secretHash: sha256Hex(token), displayPrefix: token.slice(0, 16) };
}

export class TokenService {
  readonly #db: Database;
  readonly #policy: PolicyService;
  readonly #orgId: string;
  readonly #now: () => Date;

  constructor(db: Database, policy: PolicyService, orgId: string, now: () => Date) {
    this.#db = db;
    this.#policy = policy;
    this.#orgId = orgId;
    this.#now = now;
  }

  /** Create a token. The plain token is returned once and never stored. */
  async issue(
    executor: Executor,
    input: { owner: TokenOwner; name: string; scopes: readonly string[]; expiresAt: Date; createdBy: string },
  ): Promise<{ token: string; row: TokenRow }> {
    const { token, secretHash, displayPrefix } = newToken(input.owner);
    const [row] = await executor
      .insert(apiTokens)
      .values({
        id: uuidv7(this.#now().getTime()),
        orgId: this.#orgId,
        ...(input.owner.type === 'user' ? { userId: input.owner.id } : { serviceAccountId: input.owner.id }),
        name: input.name,
        displayPrefix,
        secretHash,
        scopes: [...input.scopes],
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
        createdAt: this.#now(),
      })
      .returning();
    return { token, row: row! };
  }

  /**
   * Authenticate an `Authorization: Bearer` header. Returns null when there is none. A malformed,
   * unknown, expired or revoked token is an error, never a reason to fall back to the cookie.
   */
  async authenticate(request: FastifyRequest): Promise<AuthContext | null> {
    const header = request.headers.authorization;
    if (!header) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1] || !TOKEN_FORMAT.test(match[1])) throw unauthorized('Send a platform API token as "Authorization: Bearer plt_..."');

    const [row] = await this.#db
      .select({ token: apiTokens, user: users, serviceAccount: serviceAccounts })
      .from(apiTokens)
      .leftJoin(users, eq(users.id, apiTokens.userId))
      .leftJoin(serviceAccounts, eq(serviceAccounts.id, apiTokens.serviceAccountId))
      .where(eq(apiTokens.secretHash, sha256Hex(match[1])));
    if (!row || row.token.orgId !== this.#orgId) throw unauthorized('Unknown API token');

    const now = this.#now();
    const problem = row.token.revokedAt
      ? 'revoked'
      : row.token.expiresAt <= now
        ? 'expired'
        : row.user && row.user.status !== 'active'
          ? 'owner_deprovisioned'
          : row.serviceAccount && row.serviceAccount.status !== 'active'
            ? 'service_account_disabled'
            : null;
    if (problem) {
      await recordAudit(this.#db, auditScopeFor(request, this.#orgId, now), {
        action: 'auth.token.rejected',
        outcome: 'denied',
        target: { type: 'api_token', id: row.token.id, name: row.token.displayPrefix },
        reason: { problem },
      });
      throw unauthorized(`This API token is ${problem.replaceAll('_', ' ')}`);
    }

    if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await this.#db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id));
    }

    const scopes = row.token.scopes;
    const credential = { kind: 'token', tokenId: row.token.id, scopes } as const;
    if (row.user) {
      const principal = await this.#policy.userPrincipal(row.user.id);
      return {
        actor: { type: 'user', id: row.user.id, name: row.user.displayName, email: row.user.email },
        // No mfaAt: a token never satisfies a fresh-MFA guardrail, so tokens cannot do step-up actions.
        principal: { ...principal, tokenScopes: scopes },
        credential,
      };
    }
    const serviceAccount = row.serviceAccount!;
    return {
      actor: { type: 'service_account', id: serviceAccount.id, name: serviceAccount.name, email: null },
      principal: { type: 'service_account', id: serviceAccount.id, groupIds: [], tokenScopes: scopes },
      credential,
    };
  }
}
