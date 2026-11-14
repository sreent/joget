import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@platform/audit';
import { sessions, users, type Database, type Executor } from '@platform/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PolicyService } from '../access/policy-service.js';
import type { Config } from '../config.js';
import type { AuthContext } from '../context.js';

/** Server-side sessions, so they can be revoked. The cookie holds a random token; only its hash is stored. */
export class SessionService {
  readonly #db: Database;
  readonly #config: Config;
  readonly #policy: PolicyService;
  readonly #now: () => Date;

  constructor(db: Database, config: Config, policy: PolicyService, now: () => Date) {
    this.#db = db;
    this.#config = config;
    this.#policy = policy;
    this.#now = now;
  }

  async create(
    executor: Executor,
    input: { userId: string; mfaAt: Date | null; authTime: Date | null; ip: string; userAgent: string | null },
  ): Promise<{ token: string; id: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const id = sha256Hex(token);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#config.SESSION_TTL_MINUTES * 60_000);
    await executor.insert(sessions).values({
      id,
      userId: input.userId,
      createdAt: now,
      expiresAt,
      mfaAt: input.mfaAt,
      authTime: input.authTime,
      ip: input.ip,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
    });
    return { token, id, expiresAt };
  }

  async authenticate(request: FastifyRequest): Promise<AuthContext | null> {
    const token = request.cookies[this.#config.SESSION_COOKIE_NAME];
    if (!token) return null;
    const id = sha256Hex(token);
    const [row] = await this.#db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt), gt(sessions.expiresAt, this.#now()), eq(users.status, 'active')));
    if (!row) return null;
    const principal = await this.#policy.userPrincipal(row.user.id, row.session.mfaAt ? { mfaAt: row.session.mfaAt } : {});
    return {
      user: { id: row.user.id, email: row.user.email, displayName: row.user.displayName },
      principal,
      sessionId: id,
    };
  }

  async revoke(executor: Executor, sessionId: string): Promise<void> {
    await executor.update(sessions).set({ revokedAt: this.#now() }).where(eq(sessions.id, sessionId));
  }

  setCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
    reply.setCookie(this.#config.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.#config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.#config.SESSION_COOKIE_NAME, { path: '/' });
  }
}
