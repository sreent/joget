import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Resolve workspace packages to their TypeScript sources in tests, so tests never depend on a
 * prior build. Exact-match patterns keep `@platform/db/testing` apart from `@platform/db`.
 */
export const workspaceAliases = [
  { find: /^@platform\/app-model$/, replacement: `${root}packages/app-model/src/index.ts` },
  { find: /^@platform\/design$/, replacement: `${root}packages/design/src/index.ts` },
  { find: /^@platform\/authz$/, replacement: `${root}packages/authz/src/index.ts` },
  { find: /^@platform\/audit$/, replacement: `${root}packages/audit/src/index.ts` },
  { find: /^@platform\/db$/, replacement: `${root}packages/db/src/index.ts` },
  { find: /^@platform\/db\/testing$/, replacement: `${root}packages/db/src/testing.ts` },
];
