import { auditEvents } from '@platform/db';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { orgResource } from '../access/resources.js';
import type { AppContext } from '../context.js';
import { verifyAuditLog } from './sealer.js';

export function auditRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const org = async () => orgResource(ctx.org.id);

  return async (app) => {
    app.get(
      '/v1/audit/events',
      {
        config: { access: { kind: 'permission', action: 'org.audit.read', resource: org } },
        schema: {
          tags: ['audit'],
          summary: 'Search the audit log, newest first',
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(500).default(50),
            /** Return events older than this sequence number (for paging). */
            before: z.coerce.number().int().positive().optional(),
            action: z.string().max(100).optional(),
            outcome: z.enum(['success', 'denied', 'error']).optional(),
            actorId: z.string().max(100).optional(),
            spaceId: z.uuid().optional(),
          }),
        },
      },
      async (request) => {
        const q = request.query;
        const rows = await ctx.db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.orgId, ctx.org.id),
              q.before ? lt(auditEvents.seq, q.before) : undefined,
              q.action ? eq(auditEvents.action, q.action) : undefined,
              q.outcome ? eq(auditEvents.outcome, q.outcome) : undefined,
              q.spaceId ? eq(auditEvents.spaceId, q.spaceId) : undefined,
              q.actorId ? sql`${auditEvents.actor}->>'id' = ${q.actorId}` : undefined,
            ),
          )
          .orderBy(desc(auditEvents.seq))
          .limit(q.limit);
        return {
          events: rows.map((row) => ({
            seq: row.seq,
            id: row.id,
            occurredAt: row.occurredAt.toISOString(),
            action: row.action,
            outcome: row.outcome,
            actor: row.actor,
            target: row.target,
            spaceId: row.spaceId,
            reason: row.reason,
            changes: row.changes,
            context: row.context,
            digest: row.digest,
          })),
          nextBefore: rows.length === q.limit ? rows.at(-1)!.seq : null,
        };
      },
    );

    app.get(
      '/v1/audit/verify',
      {
        config: { access: { kind: 'permission', action: 'org.audit.read', resource: org } },
        schema: { tags: ['audit'], summary: 'Verify the sealed audit log end to end' },
      },
      async () => verifyAuditLog(ctx.db, ctx.auditVerifier),
    );
  };
}
