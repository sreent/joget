import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DESIGN_DIR, FONTS, STYLESHEETS } from '@platform/design';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Ambit's stylesheets and fonts, served from Ambit itself, so its pages load nothing from
 * outside. Only the listed files can be fetched. They're for signed-in pages, so they need a
 * session like those pages do.
 */
export function designRoutes(): FastifyPluginAsyncZod {
  const files = new Map<string, Promise<Buffer>>();
  const load = (path: string) => {
    let file = files.get(path);
    if (!file) {
      file = readFile(join(DESIGN_DIR, path));
      files.set(path, file);
    }
    return file;
  };
  return async (app) => {
    app.get(
      '/assets/:file',
      { config: { access: { kind: 'authenticated' } }, schema: { hide: true, params: z.object({ file: z.enum(STYLESHEETS) }) } },
      async (request, reply) =>
        reply
          .type('text/css; charset=utf-8')
          .header('cache-control', 'private, max-age=3600')
          .send(await load(request.params.file)),
    );
    app.get(
      '/assets/fonts/:file',
      { config: { access: { kind: 'authenticated' } }, schema: { hide: true, params: z.object({ file: z.enum(FONTS) }) } },
      async (request, reply) =>
        reply
          .type('font/woff2')
          .header('cache-control', 'private, max-age=86400')
          .send(await load(`fonts/${request.params.file}`)),
    );
  };
}
