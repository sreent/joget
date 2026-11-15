import { serviceAccounts, users } from '@platform/db';
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../access/rules.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';

export const MAX_LOOKUP_IDS = 100;
export const MAX_SEARCH_RESULTS = 10;

const PersonOut = z.object({
  id: z.uuid(),
  /** A person, or an agent (a service account) that changed a record. */
  kind: z.enum(['person', 'agent']),
  name: z.string(),
  /** Search results only: tells two people with the same name apart. */
  email: z.string().nullable().optional(),
  /** False for someone who has left, or an agent that's disabled. Records and history still name them. */
  active: z.boolean(),
});
export type PersonOut = z.infer<typeof PersonOut>;

const Query = z.object({
  ids: z.string().max(8000).optional().describe(`Comma-separated IDs, at most ${MAX_LOOKUP_IDS}`),
  search: z.string().trim().min(2).max(100).optional().describe('Part of a name or email'),
});

/** Escape LIKE's wildcards, so a search for "a_b" finds "a_b" and nothing else. */
const literal = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The org's directory, as far as building and using apps needs it: who a record or its history
 * names, and finding a colleague to put in a person field. People and agents acting for them may
 * look; a service account acting as itself may not.
 */
export function peopleRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/v1/people',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['people'],
          summary: 'Look people up: by ID, to show who records and history name; or by part of a name or email, to pick someone',
          querystring: Query,
          response: { 200: z.object({ people: z.array(PersonOut) }) },
        },
      },
      async (request) => {
        requireUser(request);
        const { ids, search } = request.query;
        if ((ids === undefined) === (search === undefined)) throw badRequest('invalid_query', 'Give either ids or search');

        if (search !== undefined) {
          const pattern = `%${literal(search)}%`;
          const rows = await ctx.db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(and(eq(users.orgId, ctx.org.id), eq(users.status, 'active'), or(ilike(users.displayName, pattern), ilike(users.email, pattern))))
            .orderBy(asc(users.displayName), asc(users.email), asc(users.id))
            .limit(MAX_SEARCH_RESULTS);
          return { people: rows.map((row) => ({ id: row.id, kind: 'person' as const, name: nameOf(row), email: row.email, active: true })) };
        }

        const wanted = [...new Set(ids!.split(',').map((id) => id.trim()).filter(Boolean))];
        if (wanted.length > MAX_LOOKUP_IDS) throw badRequest('too_many_ids', `Look up at most ${MAX_LOOKUP_IDS} IDs at a time`);
        const invalid = wanted.filter((id) => !z.uuid().safeParse(id).success);
        if (invalid.length) throw badRequest('invalid_ids', 'IDs must be UUIDs', { invalid: invalid.slice(0, 10) });
        if (!wanted.length) return { people: [] };

        const [people, agents] = await Promise.all([
          ctx.db
            .select({ id: users.id, displayName: users.displayName, email: users.email, status: users.status })
            .from(users)
            .where(and(eq(users.orgId, ctx.org.id), inArray(users.id, wanted))),
          ctx.db
            .select({ id: serviceAccounts.id, name: serviceAccounts.name, status: serviceAccounts.status })
            .from(serviceAccounts)
            .where(and(eq(serviceAccounts.orgId, ctx.org.id), inArray(serviceAccounts.id, wanted))),
        ]);
        return {
          people: [
            ...people.map((row) => ({ id: row.id, kind: 'person' as const, name: nameOf(row), active: row.status === 'active' })),
            ...agents.map((row) => ({ id: row.id, kind: 'agent' as const, name: row.name, active: row.status === 'active' })),
          ],
        };
      },
    );
  };
}

function nameOf(row: { displayName: string | null; email: string | null }): string {
  return row.displayName?.trim() || row.email || 'Someone';
}
