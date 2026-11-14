import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: { include: ['test/**/*.test.ts'], exclude: ['test/**/*.int.test.ts'] },
});
