import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { STUDIO_DIR } from '@platform/studio';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notFound } from '../errors.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * Ambit Studio, served at /studio on the API's own origin, so it shares the sign-in and needs no
 * cross-origin access. Files are only ever read from inside the built studio.
 */
export function studioRoutes(): FastifyPluginAsyncZod {
  const root = normalize(STUDIO_DIR) + sep;
  const index = join(root, 'index.html');
  return async (app) => {
    const serve = async (path: string) => {
      if (!existsSync(index)) {
        throw Object.assign(notFound('The studio'), { message: 'The studio is not built. Run `pnpm --filter @platform/studio build`, or its dev server.' });
      }
      const target = normalize(join(root, path));
      const isAsset = target.startsWith(root) && path.startsWith('assets/') && /^[\w./-]+$/.test(path) && existsSync(target);
      return { file: isAsset ? target : index, asset: isAsset };
    };
    app.get('/studio', { config: { access: { kind: 'authenticated' } }, schema: { hide: true } }, async (_request, reply) => reply.redirect('/studio/'));
    app.get('/studio/*', { config: { access: { kind: 'authenticated' } }, schema: { hide: true } }, async (request, reply) => {
      const { file, asset } = await serve((request.params as { '*': string })['*'] ?? '');
      reply.type(TYPES[extname(file)] ?? 'application/octet-stream');
      // Built assets carry a content hash in their names, so they never change; the page itself always might.
      reply.header('cache-control', asset ? 'private, max-age=31536000, immutable' : 'no-cache');
      return reply.send(await readFile(file));
    });
  };
}
