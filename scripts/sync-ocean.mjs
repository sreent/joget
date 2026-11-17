// Takes Ocean, the family's design system, from a checkout of sreent/ocean at the commit it is on:
// its tokens, its pieces and its fonts, copied as they are. Only the fonts' path changes, because
// Ambit serves the fonts beside the stylesheets (fonts/, not ../fonts/). Change Ocean in its own
// repository, never here: a piece that a3t needs is drawn there first.
//
//   node scripts/sync-ocean.mjs ../ocean
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [from] = process.argv.slice(2);
if (!from) {
  console.error('Give the path of a checkout of sreent/ocean.');
  process.exit(2);
}
const git = (...args) => execFileSync('git', ['-C', from, ...args], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) {
  console.error('The checkout has changes that are not committed: commit them in Ocean first.');
  process.exit(1);
}
const commit = git('rev-parse', 'HEAD');
const design = fileURLToPath(new URL('../packages/design/', import.meta.url));
const header = (file) => `/* Ocean's ${file}, from sreent/ocean at ${commit}, taken by scripts/sync-ocean.mjs.\n   Change it in Ocean, not here. */\n`;

const tokens = readFileSync(join(from, 'css/tokens.css'), 'utf8').replaceAll('url(../fonts/', 'url(fonts/');
writeFileSync(join(design, 'ocean.css'), header('css/tokens.css') + tokens);
writeFileSync(join(design, 'ocean-pieces.css'), header('css/components.css') + readFileSync(join(from, 'css/components.css'), 'utf8'));

rmSync(join(design, 'fonts'), { recursive: true, force: true });
mkdirSync(join(design, 'fonts'));
const fonts = readdirSync(join(from, 'fonts')).sort();
for (const file of fonts) copyFileSync(join(from, 'fonts', file), join(design, 'fonts', file));

// The icons, as the markup inside each <svg>, for pages that draw them inline.
const icons = readdirSync(join(from, 'icons')).filter((file) => file.endsWith('.svg')).sort();
const inner = (file) => readFileSync(join(from, 'icons', file), 'utf8').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
writeFileSync(
  join(design, 'src/icons.ts'),
  `// Ocean's icons, from sreent/ocean at ${commit}, taken by scripts/sync-ocean.mjs: the markup inside\n` +
    `// each icon's <svg>, which draws in currentColor on a 24-unit square. Change them in Ocean.\n` +
    `export const ICONS = {\n${icons.map((file) => `  ${JSON.stringify(file.slice(0, -4))}: ${JSON.stringify(inner(file))},`).join('\n')}\n} as const;\n\n` +
    `export type IconName = keyof typeof ICONS;\n`,
);

writeFileSync(
  join(design, 'ocean.json'),
  `${JSON.stringify({ repository: 'sreent/ocean', commit, files: ['css/tokens.css', 'css/components.css', ...fonts.map((file) => `fonts/${file}`), ...icons.map((file) => `icons/${file}`)] }, null, 2)}\n`,
);
console.log(`Took Ocean at ${commit}: its tokens, its pieces, ${fonts.length} font files and ${icons.length} icons.`);
