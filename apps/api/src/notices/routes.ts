import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../access/rules.js';
import type { AuthContext } from '../context.js';
import { forbidden } from '../errors.js';
import type { Notices } from './service.js';

const NoticeOut = z.object({
  id: z.uuid(),
  kind: z.enum(['inform', 'task_assigned', 'task_due_soon', 'task_overdue']),
  title: z.string(),
  message: z.string().nullable(),
  app: z.object({ id: z.uuid(), name: z.string() }),
  about: z.object({ entity: z.string(), recordId: z.uuid(), label: z.string().nullable() }).nullable(),
  taskId: z.uuid().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
const Settings = z.object({ email: z.boolean(), emailAvailable: z.boolean().describe('Whether the installation sends email at all') });

/** Notices are a person's own: an agent or a service account reads none. */
function person(auth: AuthContext): string {
  if (auth.actor.type !== 'user' || auth.agent) throw forbidden('person_only', 'Only the person reads their notices');
  return auth.actor.id;
}

export function noticeRoutes(notices: Notices): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/v1/me/notices',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['notices'],
          summary: 'Your notices: what flows told you, and the tasks that came to you, are due soon or are overdue. The newest first, with how many are unread',
          querystring: z.object({ unread: z.stringbool().default(false), limit: z.coerce.number().int().min(1).max(200).default(50) }),
          response: { 200: z.object({ notices: z.array(NoticeOut), unread: z.int() }) },
        },
      },
      async (request) => notices.list(person(requireAuth(request)), request.query),
    );

    app.get(
      '/v1/me/notices/unread',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['notices'], summary: 'How many of your notices are unread', response: { 200: z.object({ unread: z.int() }) } },
      },
      async (request) => ({ unread: await notices.unread(person(requireAuth(request))) }),
    );

    app.post(
      '/v1/me/notices/read',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['notices'],
          summary: 'Mark notices read: some by their IDs, or all that came up to a time, so that what came after stays unread',
          body: z.union([z.object({ ids: z.array(z.uuid()).min(1).max(200) }), z.object({ upTo: z.iso.datetime({ offset: true }) })]),
          response: { 200: z.object({ unread: z.int() }) },
        },
      },
      async (request) => {
        const body = request.body;
        const unread = await notices.read(person(requireAuth(request)), 'ids' in body ? { ids: body.ids } : { upTo: new Date(body.upTo) });
        return { unread };
      },
    );

    app.get(
      '/v1/me/notices/settings',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['notices'], summary: 'Whether your notices reach you by email too', response: { 200: Settings } },
      },
      async (request) => notices.settings(person(requireAuth(request))),
    );

    app.put(
      '/v1/me/notices/settings',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['notices'], summary: 'Turn notices by email on or off. In the app, they always come', body: z.object({ email: z.boolean() }), response: { 200: Settings } },
      },
      async (request) => notices.setEmail(person(requireAuth(request)), request.body.email),
    );
  };
}
