import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../vitest.shared.ts';

// Tests read workspace packages from their sources, so they never depend on a prior build.
export default defineConfig({ resolve: { alias: workspaceAliases }, test: { include: ['src/**/*.test.ts'] } });
