import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { once, requireAuth } from '../access/rules.js';
import type { LoadedApp } from '../apps/catalog.js';
import { appResource } from '../apps/resources.js';
import { envOf } from '../apps/routes.js';
import type { AppRuntime, RecordOut } from '../apps/runtime.js';
import { EnvQuery } from '../apps/schemas.js';
import { withAppTransaction } from '../apps/transaction.js';
import type { AppContext } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import type { FileRow } from './service.js';

const FileOut = z.object({
  id: z.uuid(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  scan: z.enum(['clean', 'not_scanned']),
  attached: z.boolean(),
});

/** True if a record, as the caller sees it, holds this file in one of its file fields, or its lines'. */
function holds(loaded: LoadedApp, entityName: string, record: RecordOut, fileId: string): boolean {
  const entity = loaded.definition.entities[entityName]!;
  return entity.fields.some((field) => {
    const value = record.values[field.name];
    if (field.type === 'file') return value === fileId;
    if (field.type !== 'lines' || !Array.isArray(value)) return false;
    const fileFields = loaded.definition.entities[field.entity]!.fields.filter((f) => f.type === 'file');
    return (value as Array<Record<string, unknown>>).some((line) => fileFields.some((f) => line[f.name] === fileId));
  });
}

/**
 * Files: upload one to use in a record, such as a receipt, and download those you may see. An upload
 * is yours until a record refers to it; after that, whoever can see the field that holds it can
 * download it, through that record, and nobody else. A file nobody may see is "not found".
 */
export function fileRoutes(ctx: AppContext, runtime: AppRuntime): FastifyPluginAsyncZod {
  const theApp = (request: FastifyRequest) => once(request, 'app', () => ctx.apps.load((request.params as { appId: string }).appId, envOf(request)));
  const appRule = {
    kind: 'permission' as const,
    action: 'app.run',
    resource: async (request: FastifyRequest) => appResource(ctx.org.id, await theApp(request)),
    policy: async (request: FastifyRequest) => runtime.policy(await theApp(request)),
  };
  const files = ctx.files;

  return async (app) => {
    // A file is its content, whatever its type: read it whole, within the size limit.
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: ctx.config.FILE_MAX_BYTES }, (_request, body, done) => done(null, body));

    app.post(
      '/v1/apps/:appId/files',
      {
        config: { access: appRule },
        bodyLimit: ctx.config.FILE_MAX_BYTES,
        schema: {
          tags: ['files'],
          summary: 'Upload a file, such as a receipt, to use in a record of this app: send its content as the body. Images and PDFs only',
          params: z.object({ appId: z.uuid() }),
          querystring: EnvQuery.extend({ name: z.string().max(500).optional().describe('The file name to show') }),
          response: { 201: FileOut },
        },
      },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(415, 'unsupported_file_type', 'Send the file itself as the body, with its type, such as image/jpeg');
        const file = await files.upload(request, requireAuth(request), await theApp(request), {
          content: request.body,
          ...(request.query.name ? { name: request.query.name } : {}),
        });
        return reply.status(201).send(file);
      },
    );

    app.get(
      '/v1/apps/:appId/files/:fileId',
      {
        config: { access: appRule },
        schema: {
          tags: ['files'],
          summary: 'Download a file you uploaded, or one in a record you can see',
          params: z.object({ appId: z.uuid(), fileId: z.uuid() }),
          querystring: EnvQuery,
        },
      },
      async (request, reply) => {
        const auth = requireAuth(request);
        const loaded = await theApp(request);
        const row: FileRow | null = await withAppTransaction(ctx.pool, loaded.env, 'records', (tx) => files.find(tx, loaded, request.params.fileId));
        if (!row) throw notFound('File');
        if (row.attached_at) {
          const entityName = Object.entries(loaded.definition.entities).find(([, entity]) => entity.id === row.entity_id)?.[0];
          if (!entityName || !row.record_id) throw notFound('File');
          const record = await runtime.get(request, auth, loaded, entityName, row.record_id).catch((error: unknown) => {
            if (error instanceof HttpError && (error.statusCode === 403 || error.statusCode === 404)) return null;
            throw error;
          });
          if (!record || !holds(loaded, entityName, record, row.id)) throw notFound('File');
        } else if ((row.on_behalf_of ?? row.created_by) !== auth.actor.id) {
          throw notFound('File');
        }
        const content = await withAppTransaction(ctx.pool, loaded.env, 'records', (tx) => files.content(tx, loaded, row));
        if (!content) throw notFound('File');
        // Images show in the page; anything else downloads. Either way the browser runs nothing in it.
        const disposition = row.content_type.startsWith('image/') && row.content_type !== 'image/heic' ? 'inline' : 'attachment';
        return reply
          .header('content-type', row.content_type)
          .header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.name)}`)
          .header('cache-control', 'private, no-store')
          .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
          .header('cross-origin-resource-policy', 'same-origin')
          .send(content);
      },
    );
  };
}
