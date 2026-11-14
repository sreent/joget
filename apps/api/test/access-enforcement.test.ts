import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireAccessRules } from '../src/access/enforce.js';

describe('requireAccessRules', () => {
  it('refuses to start when any route lacks an access rule', async () => {
    const app = Fastify();
    requireAccessRules(app);
    const registration = app.register(async (instance) => {
      instance.get('/forgotten', async () => 'oops');
    });
    await expect(registration).rejects.toThrow(/GET \/forgotten has no access rule/);
  });

  it('records the declared rule of every route for review', async () => {
    const app = Fastify({ exposeHeadRoutes: false });
    const routes = requireAccessRules(app);
    app.get('/a', { config: { access: { kind: 'public' } } }, async () => 'a');
    app.post('/b', { config: { access: { kind: 'authenticated' } } }, async () => 'b');
    app.get(
      '/c',
      { config: { access: { kind: 'permission', action: 'space.read', resource: async () => ({ type: 'org', scopes: [] }) } } },
      async () => 'c',
    );
    await app.ready();
    expect(routes).toEqual([
      { method: 'GET', url: '/a', kind: 'public' },
      { method: 'POST', url: '/b', kind: 'authenticated' },
      { method: 'GET', url: '/c', kind: 'permission', action: 'space.read' },
    ]);
  });
});
