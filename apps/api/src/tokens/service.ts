import { randomBytes } from 'node:crypto';
import { sha256Hex, uuidv7 } from '@platform/audit';
import { apiTokens, type Database, type Executor, serviceAccounts, users } from '@platform/db';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import type { PolicyService } from '../access/policy-service.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AuthContext } from '../context.js';
import { unauthorized } from '../errors.js';

export type TokenRow = typeof apiTokens.$inferSelect;
export type TokenOwner = { readonly type: 'user'; readonly id: string } | { readonly type: 'service_account'; readonly id: string };

/**
 * Tokens look like `plt_pat_<32 chars>` (personal), `plt_sat_<32 chars>` (service account) or
 * `plt_dlg_<32 chars>` (an agent acting for a person): 192 random bits behind a fixed,
 * recognizable prefix that secret scanners can be taught to find.
 */
const TOKEN_FORMAT = /^plt_(pat|sat|dlg)_[A-Za-z0-9_-]{32}$/;
const agents = alias(serviceAccounts, 'agents');
/** Record last use at most this often, so authentication doesn't write on every request. */
const LAST_USED_RESOLUTION_MS = 5 * 60_000;

export function newToken(owner: TokenOwner, delegated = false): { token: string; secretHash: string; displayPrefix: string } {
  const kind = delegated ? 'dlg' : owner.type === 'user' ? 'pat' : 'sat';
  const token = `plt_${kind}_${randomBytes(24).toString('base64url')}`;
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
   * Issue a token for an agent acting for a person (RFC 8693 token exchange). It lives briefly,
   * carries at most the agent's approved scopes, and dies with the agent's approval.
   */
  async issueDelegated(
    executor: Executor,
    input: { userId: string; agentId: string; agentName: string; scopes: readonly string[]; expiresAt: Date },
  ): Promise<{ token: string; row: TokenRow }> {
    const { token, secretHash, displayPrefix } = newToken({ type: 'user', id: input.userId }, true);
    const [row] = await executor
      .insert(apiTokens)
      .values({
        id: uuidv7(this.#now().getTime()),
        orgId: this.#orgId,
        userId: input.userId,
        actorServiceAccountId: input.agentId,
        name: `${input.agentName}, acting for this person`,
        displayPrefix,
        secretHash,
        scopes: [...input.scopes],
        expiresAt: input.expiresAt,
        // Issued for the person, by the exchange: no one created it in a session.
        createdBy: input.userId,
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
      .select({ token: apiTokens, user: users, serviceAccount: serviceAccounts, agent: agents })
      .from(apiTokens)
      .leftJoin(users, eq(users.id, apiTokens.userId))
      .leftJoin(serviceAccounts, eq(serviceAccounts.id, apiTokens.serviceAccountId))
      .leftJoin(agents, eq(agents.id, apiTokens.actorServiceAccountId))
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
            : row.token.actorServiceAccountId && (row.agent?.status !== 'active' || !row.agent.agentScopes)
              ? 'agent_not_approved'
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

    // A delegated token never does more than the agent is approved for now, even if that shrank.
    const scopes = row.agent ? row.token.scopes.filter((scope) => row.agent!.agentScopes!.includes(scope)) : row.token.scopes;
    const credential = { kind: 'token', tokenId: row.token.id, scopes } as const;
    if (row.user && row.agent) {
      const principal = await this.#policy.userPrincipal(row.user.id);
      return {
        actor: { type: 'user', id: row.user.id, name: row.user.displayName, email: row.user.email },
        agent: { id: row.agent.id, name: row.agent.name },
        principal: { ...principal, tokenScopes: scopes },
        credential,
      };
    }
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
