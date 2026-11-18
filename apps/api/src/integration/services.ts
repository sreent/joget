import type { Connection } from '@platform/app-model';
import { uuidv7 } from '@platform/audit';
import { channelPosts, type Database } from '@platform/db';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { LoadedApp } from '../apps/catalog.js';
import { type AuditScope, recordAudit, SYSTEM_ACTOR } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import { HttpError, unprocessable } from '../errors.js';
import { OutboundError, send } from './outbound.js';
import type { Secrets } from './secrets.js';

/*
 * Calling the services an app connects to, and posting to its Teams channels (design §6.13). The
 * platform adds each connection's secret to the call itself, from the environment's secrets, so a
 * flow never sees it. Each call leaves an audit event, which stays even if the flow that made it
 * fails: what a service did can't be undone with the flow's transaction.
 */

export type ServiceConnection = Extract<Connection, { kind: 'service' }>;
export type ResultType = 'text' | 'number' | 'boolean' | 'date' | 'datetime';

/** The value at a place in JSON: names and list positions, as data.items.0.id. The whole of it for an empty place. */
export function valueAt(json: unknown, place: string): unknown {
  let at: unknown = json;
  for (const part of place ? place.split('.') : []) {
    if (Array.isArray(at) && /^\d+$/.test(part)) at = at[Number(part)];
    else if (at !== null && typeof at === 'object' && !Array.isArray(at)) at = (at as Record<string, unknown>)[part];
    else return undefined;
  }
  return at;
}

/** A value from an answer, as the kind a flow's variable holds; null when it isn't one. */
export function asKind(value: unknown, type: ResultType): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'text':
      return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': {
      const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
      return Number.isFinite(number) ? number : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null;
    case 'date': {
      if (typeof value !== 'string') return null;
      const day = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
      return day && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? day : null;
    }
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
  }
}

/** The address of a call: under the connection's own, and never above it. */
export function callUrl(connection: ServiceConnection, path: string, query: Readonly<Record<string, unknown>>): URL {
  const base = new URL(connection.url.endsWith('/') ? connection.url : `${connection.url}/`);
  const url = new URL(path.replace(/^\/+/, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
    throw unprocessable('service_failed', `${connection.label}: a call stays under ${connection.url}`);
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url;
}

export class Services {
  readonly #ctx: AppContext;
  readonly #secrets: Secrets;

  constructor(ctx: AppContext, secrets: Secrets) {
    this.#ctx = ctx;
    this.#secrets = secrets;
  }

  /** The headers that prove who the app is to a service, with the environment's secret. */
  async #proof(loaded: LoadedApp, name: string, connection: ServiceConnection): Promise<Record<string, string>> {
    if (connection.auth.type === 'none') return {};
    const secret = await this.#secrets.reveal(this.#ctx.db, loaded.env.id, 'connection', name);
    if (secret === undefined) throw unprocessable('secret_missing', `${connection.label} has no secret in this environment: its admins set it first`);
    switch (connection.auth.type) {
      case 'bearer':
        return { authorization: `Bearer ${secret}` };
      case 'basic':
        return { authorization: `Basic ${Buffer.from(`${connection.auth.user}:${secret}`).toString('base64')}` };
      case 'header':
        return { [connection.auth.header.toLowerCase()]: secret };
    }
  }

  /**
   * Call a service, and give its answer: JSON when it says it is, text otherwise. An answer that
   * isn't a success, or a call that can't be made, fails with 422, which an error handler catches.
   */
  async call(
    loaded: LoadedApp,
    name: string,
    input: {
      readonly method: string;
      readonly path: string;
      readonly query: Readonly<Record<string, unknown>>;
      readonly body?: Readonly<Record<string, unknown>> | undefined;
    },
    scope: AuditScope,
  ): Promise<unknown> {
    const connection = loaded.definition.connections?.[name];
    if (connection?.kind !== 'service') throw unprocessable('service_failed', `No service named ${name}`);
    const url = callUrl(connection, input.path, input.query);
    const started = Date.now();
    let status = 0;
    let failure: string | null = null;
    try {
      const answer = await send(this.#ctx.config, {
        method: input.method,
        url,
        headers: {
          accept: 'application/json',
          'user-agent': 'a3t',
          ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(await this.#proof(loaded, name, connection)),
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });
      status = answer.status;
      if (status < 200 || status > 299) {
        failure = `${connection.label} answered ${status}`;
        throw unprocessable('service_failed', failure, { status });
      }
      if (!/json/i.test(answer.contentType)) return answer.text;
      try {
        return answer.text ? JSON.parse(answer.text) : null;
      } catch {
        failure = `${connection.label} answered with JSON that doesn't parse`;
        throw unprocessable('service_failed', failure, { status });
      }
    } catch (error) {
      if (error instanceof OutboundError) {
        failure = `${connection.label}: ${error.message}`;
        throw unprocessable('service_failed', failure);
      }
      if (!(error instanceof HttpError)) failure = `${connection.label}: the call failed`;
      throw error;
    } finally {
      // What was called stays in the audit log, whatever becomes of the flow.
      await recordAudit(this.#ctx.db, scope, {
        action: 'service.call',
        outcome: failure ? 'error' : 'success',
        target: { type: 'connection', id: name, name: connection.label },
        spaceId: loaded.space.id,
        appId: loaded.app.id,
        env: loaded.env.kind,
        reason: { method: input.method, host: url.host, path: url.pathname, status, ms: Date.now() - started, ...(failure ? { failure } : {}) },
      });
    }
  }

  /** Post to a Teams channel, in the transaction of the flow that posts: a worker sends it after. */
  async queuePost(
    db: Database,
    loaded: LoadedApp,
    connection: string,
    post: { readonly title: string; readonly message: string | null; readonly link: string | null },
    now: Date,
  ): Promise<void> {
    await db.insert(channelPosts).values({
      id: uuidv7(now.getTime()),
      orgId: this.#ctx.org.id,
      appId: loaded.app.id,
      environmentId: loaded.env.id,
      connection,
      title: post.title.slice(0, 300),
      message: post.message ? post.message.slice(0, 2000) : null,
      link: post.link,
      nextAttemptAt: now,
      createdAt: now,
    });
  }

  /** Send the posts that wait, a batch at a time. Pods share the work through SKIP LOCKED. */
  async deliverPosts(batch = 20): Promise<number> {
    const now = this.#ctx.now();
    const claimed = await this.#ctx.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(channelPosts)
        .where(and(eq(channelPosts.status, 'waiting'), lte(channelPosts.nextAttemptAt, now)))
        .orderBy(asc(channelPosts.nextAttemptAt))
        .limit(batch)
        .for('update', { skipLocked: true });
      if (!due.length) return [];
      await tx
        .update(channelPosts)
        .set({ attempts: sql`${channelPosts.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(
          inArray(
            channelPosts.id,
            due.map((post) => post.id),
          ),
        );
      return due.map((post) => ({ ...post, attempts: post.attempts + 1 }));
    });
    for (const post of claimed) {
      try {
        const address = await this.#secrets.reveal(this.#ctx.db, post.environmentId, 'connection', post.connection);
        if (!address || !URL.canParse(address)) throw new OutboundError('The channel has no address in this environment: its admins set it first');
        const card = {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', text: post.title, weight: 'Bolder', wrap: true },
                  ...(post.message ? [{ type: 'TextBlock', text: post.message, wrap: true }] : []),
                ],
                ...(post.link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open it', url: post.link }] } : {}),
              },
            },
          ],
        };
        const answer = await send(this.#ctx.config, {
          method: 'POST',
          url: new URL(address),
          headers: { 'content-type': 'application/json', 'user-agent': 'a3t' },
          body: JSON.stringify(card),
        });
        if (answer.status < 200 || answer.status > 299) throw new OutboundError(`Teams answered ${answer.status}`);
        await this.#ctx.db.update(channelPosts).set({ status: 'sent', sentAt: this.#ctx.now(), lastError: null }).where(eq(channelPosts.id, post.id));
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        const failed = post.attempts >= 5;
        await this.#ctx.db
          .update(channelPosts)
          .set({
            lastError: message,
            ...(failed ? { status: 'failed' as const } : { nextAttemptAt: new Date(this.#ctx.now().getTime() + 30_000 * 2 ** post.attempts) }),
          })
          .where(eq(channelPosts.id, post.id));
        if (failed) {
          await recordAudit(
            this.#ctx.db,
            { orgId: this.#ctx.org.id, actor: SYSTEM_ACTOR, now: this.#ctx.now(), context: { channelPost: post.id } },
            { action: 'channel.post', outcome: 'error', target: { type: 'connection', id: post.connection }, appId: post.appId, reason: { failure: message } },
          );
        }
      }
    }
    return claimed.length;
  }
}
