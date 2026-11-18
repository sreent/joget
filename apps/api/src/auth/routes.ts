import { groupMembers, groups, spaces } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireSession } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import { badRequest, HttpError, unauthorized } from '../errors.js';
import { IdpUnavailableError, mfaTimestamp, type OidcIdentity } from './oidc.js';
import { provisionUser } from './provisioning.js';

const LOGIN_COOKIE = 'platform_login';
const idpUnavailable = () => new HttpError(503, 'idp_unavailable', 'The identity provider cannot be reached right now. Try again shortly.');
const LoginState = z.object({ state: z.string(), nonce: z.string(), codeVerifier: z.string(), returnTo: z.string().nullable() });

/** Only same-site relative paths, so the login flow cannot be used as an open redirect. */
function safeReturnTo(value: string | undefined): string | null {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return value;
}

export function authRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const redirectUri = new URL('/auth/callback', ctx.config.PUBLIC_BASE_URL).href;

  return async (app) => {
    app.get(
      '/auth/login',
      {
        config: { access: { kind: 'public' } },
        schema: {
          tags: ['auth'],
          summary: 'Start signing in with the identity provider',
          querystring: z.object({
            returnTo: z.string().max(2048).optional(),
            /** Ask the IdP for a fresh login, for example before a sensitive action (step-up MFA). */
            stepUp: z.enum(['true', 'false']).optional(),
          }),
        },
      },
      async (request, reply) => {
        const stepUp = request.query.stepUp === 'true';
        const start = await ctx.oidc
          .startLogin({ redirectUri, ...(stepUp ? { forceReauthentication: true, acrValues: ctx.config.MFA_ACR_VALUES } : {}) })
          .catch((error: unknown) => {
            if (error instanceof IdpUnavailableError) throw idpUnavailable();
            throw error;
          });
        const state: z.infer<typeof LoginState> = {
          state: start.state,
          nonce: start.nonce,
          codeVerifier: start.codeVerifier,
          returnTo: safeReturnTo(request.query.returnTo),
        };
        reply.setCookie(LOGIN_COOKIE, JSON.stringify(state), {
          signed: true,
          httpOnly: true,
          secure: ctx.config.COOKIE_SECURE,
          sameSite: 'lax',
          path: '/auth',
          maxAge: 600,
        });
        return reply.redirect(start.url);
      },
    );

    app.get(
      '/auth/callback',
      {
        config: { access: { kind: 'public' } },
        schema: { tags: ['auth'], summary: 'Finish signing in (the IdP redirects here)' },
      },
      async (request, reply) => {
        const audit = auditScopeFor(request, ctx.org.id, ctx.now());
        const raw = request.cookies[LOGIN_COOKIE];
        reply.clearCookie(LOGIN_COOKIE, { path: '/auth' });
        const unsigned = raw ? request.unsignCookie(raw) : null;
        const parsed = unsigned?.valid && unsigned.value ? LoginState.safeParse(safeJson(unsigned.value)) : null;
        if (!parsed?.success) {
          await recordAudit(ctx.db, audit, { action: 'auth.login', outcome: 'error', reason: { error: 'missing_or_invalid_login_state' } });
          throw badRequest('invalid_login_state', 'The sign-in attempt expired or was tampered with. Start again.');
        }

        let identity: OidcIdentity;
        try {
          identity = await ctx.oidc.completeLogin({
            callbackUrl: new URL(request.url, ctx.config.PUBLIC_BASE_URL),
            redirectUri,
            state: parsed.data.state,
            nonce: parsed.data.nonce,
            codeVerifier: parsed.data.codeVerifier,
          });
        } catch (error) {
          await recordAudit(ctx.db, audit, {
            action: 'auth.login',
            outcome: 'error',
            reason: { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
          });
          if (error instanceof IdpUnavailableError) throw idpUnavailable();
          throw unauthorized('Sign-in failed at the identity provider');
        }

        const now = ctx.now();
        let result: { readonly session: { readonly token: string; readonly expiresAt: Date } };
        try {
          result = await ctx.db.transaction(async (tx) => {
            const user = await provisionUser(tx, { orgId: ctx.org.id, config: ctx.config, identity, audit });
            const session = await ctx.sessions.create(tx, {
              userId: user.userId,
              mfaAt: mfaTimestamp(identity, ctx.config, now),
              authTime: identity.authTime,
              ip: request.ip,
              userAgent: request.headers['user-agent'] ?? null,
            });
            await recordAudit(
              tx,
              { ...audit, actor: { type: 'user', id: user.userId, via: 'api', sessionId: session.id } },
              {
                action: 'auth.login',
                target: { type: 'user', id: user.userId },
                reason: { issuer: identity.issuer, amr: identity.amr, acr: identity.acr, mfa: mfaTimestamp(identity, ctx.config, now) !== null },
              },
            );
            return { user, session };
          });
        } catch (error) {
          if (error instanceof HttpError && error.code === 'account_deprovisioned') {
            await recordAudit(ctx.db, audit, {
              action: 'auth.login',
              outcome: 'denied',
              reason: { error: error.code, issuer: identity.issuer, subject: identity.subject },
            });
          }
          throw error;
        }

        ctx.sessions.setCookie(reply, result.session.token, result.session.expiresAt);
        return reply.redirect(parsed.data.returnTo ?? '/v1/me');
      },
    );

    app.post(
      '/auth/logout',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['auth'], summary: 'Sign out and revoke the session' },
      },
      async (request, reply) => {
        const auth = requireSession(request);
        await ctx.db.transaction(async (tx) => {
          await ctx.sessions.revoke(tx, auth.credential.sessionId);
          await recordAudit(tx, auditScopeFor(request, ctx.org.id, ctx.now()), {
            action: 'auth.logout',
            target: { type: 'session', id: auth.credential.sessionId },
          });
        });
        ctx.sessions.clearCookie(reply);
        return reply.status(204).send();
      },
    );

    app.get(
      '/v1/me',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['auth'],
          summary: 'Who you are: a person or a service account, how you signed in, your groups and your personal space',
          response: {
            200: z.object({
              type: z.enum(['user', 'service_account']),
              id: z.uuid(),
              email: z.string().nullable(),
              displayName: z.string().nullable(),
              mfaVerifiedAt: z.string().nullable(),
              personalSpaceId: z.uuid().nullable(),
              groups: z.array(z.object({ id: z.uuid(), name: z.string(), source: z.enum(['idp', 'platform']) })),
              credential: z.object({
                kind: z.enum(['session', 'token']),
                tokenId: z.uuid().nullable(),
                scopes: z.array(z.string()).nullable(),
              }),
              /** Set when an agent acts for this person, through a token from a token exchange. */
              agent: z.object({ id: z.uuid(), name: z.string() }).nullable(),
            }),
          },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        const credential =
          auth.credential.kind === 'token'
            ? { kind: 'token' as const, tokenId: auth.credential.tokenId, scopes: [...auth.credential.scopes] }
            : { kind: 'session' as const, tokenId: null, scopes: null };
        if (auth.actor.type === 'service_account') {
          return {
            type: 'service_account' as const,
            id: auth.actor.id,
            email: null,
            displayName: auth.actor.name,
            mfaVerifiedAt: null,
            personalSpaceId: null,
            groups: [],
            credential,
            agent: null,
          };
        }
        const memberships = await ctx.db
          .select({ id: groups.id, name: groups.displayName, source: groups.source })
          .from(groupMembers)
          .innerJoin(groups, eq(groups.id, groupMembers.groupId))
          .where(eq(groupMembers.userId, auth.actor.id));
        const [personal] = await ctx.db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, auth.actor.id)));
        return {
          type: 'user' as const,
          id: auth.actor.id,
          email: auth.actor.email,
          displayName: auth.actor.name,
          mfaVerifiedAt: auth.principal.mfaAt?.toISOString() ?? null,
          personalSpaceId: personal?.id ?? null,
          groups: memberships,
          credential,
          agent: auth.agent ?? null,
        };
      },
    );
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
