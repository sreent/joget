import { fileURLToPath } from 'node:url';

/** Where the stylesheets and fonts live, for servers that serve them. */
export const DESIGN_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The stylesheets, in the order a page loads them: Ocean's tokens, then Ambit's styles. */
export const STYLESHEETS = ['ocean.css', 'ambit.css'] as const;

/** The bundled fonts: IBM Plex Sans and Mono, under the SIL Open Font License (fonts/OFL-*.txt). */
export const FONTS = [
  'plex-sans-400.woff2',
  'plex-sans-500.woff2',
  'plex-sans-600.woff2',
  'plex-sans-700.woff2',
  'plex-mono-400.woff2',
  'plex-mono-500.woff2',
] as const;
