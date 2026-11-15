import { fileURLToPath } from 'node:url';

/** Where the built studio lives (`pnpm --filter @platform/studio build`), for the API to serve. */
export const STUDIO_DIR = fileURLToPath(new URL('./dist', import.meta.url));
