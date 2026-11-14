import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.shared.ts';

/** Integration tests run against a real PostgreSQL (TEST_DATABASE_URL), one database per test file. */
export const integrationConfig = defineConfig({
  resolve: { alias: workspaceAliases },
  test: { include: ['test/**/*.int.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 },
});
