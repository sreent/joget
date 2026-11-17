import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_DIR, FONTS } from '../src/index.js';

/**
 * Ported from a5s's tests/test_design.py: every colour that carries text reads against what it
 * sits on at WCAG AA (4.5 to 1), and focus rings and agents' marks at 3 to 1, in light and dark.
 */

const OCEAN = readFileSync(join(DESIGN_DIR, 'ocean.css'), 'utf8');
const AMBIT = readFileSync(join(DESIGN_DIR, 'ambit.css'), 'utf8');
const DARK = '@media (prefers-color-scheme: dark)';

const tokens = (text: string) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

function themes(): Record<'light' | 'dark', Record<string, string>> {
  const primitives = tokens(OCEAN.slice(OCEAN.indexOf('/* Primitives'), OCEAN.indexOf('/* Meanings')));
  const light = { ...primitives, ...tokens(OCEAN.slice(OCEAN.indexOf('/* Meanings'), OCEAN.indexOf(DARK))) };
  const dark = OCEAN.indexOf(DARK);
  return { light, dark: { ...light, ...tokens(OCEAN.slice(dark, OCEAN.indexOf('\n}\n', dark))) } };
}

function colour(theme: Record<string, string>, name: string): string {
  let value = theme[name];
  for (let found = value?.match(/^var\(--([\w-]+)\)$/); found; found = value?.match(/^var\(--([\w-]+)\)$/)) value = theme[found[1]!];
  if (!value || !/^#[0-9a-f]{6}$/.test(value)) throw new Error(`--${name} is ${value}, not a colour`);
  return value;
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const TEXT: Array<[string, string]> = [
  ...['page', 'surface', 'sunken'].map((on): [string, string] => ['text', on]),
  ...['page', 'surface', 'sunken'].map((on): [string, string] => ['muted', on]),
  ['faint', 'surface'],
  ['accent', 'surface'],
  ['accent-text', 'accent'],
  ['accent-text', 'accent-strong'],
  // What Ambit's review card draws on its sunken panel and its surface.
  ['outside', 'sunken'],
  ['agent-tone', 'sunken'],
  ['agent-tone', 'surface'],
  ['good', 'surface'],
  ...['good', 'warn', 'bad', 'idle'].map((tone): [string, string] => [tone, `${tone}-bg`]),
];
const MARKS: Array<[string, string]> = [['focus', 'surface'], ['agent-tone', 'surface']];

describe('Ocean, as Ambit uses it', () => {
  it('keeps every colour that carries text readable, in light and dark', () => {
    const short: string[] = [];
    for (const [name, theme] of Object.entries(themes())) {
      for (const [pairs, least] of [[TEXT, 4.5], [MARKS, 3]] as const) {
        for (const [fg, on] of pairs) {
          const ratio = contrast(colour(theme, fg), colour(theme, on));
          if (ratio < least) short.push(`${name}: ${fg} on ${on} is ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(short).toEqual([]);
  });

  it('names only Ocean meanings in its own styles, so a brand changes ocean.css alone', () => {
    expect(AMBIT.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    const meanings = new Set(Object.keys(tokens(OCEAN)));
    const used = [...AMBIT.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]!);
    expect(used.filter((name) => !meanings.has(name))).toEqual([]);
  });

  it('bundles the fonts it declares, with their licences', () => {
    const declared = [...OCEAN.matchAll(/url\(fonts\/([\w.-]+)\)/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...FONTS].sort());
    for (const file of [...FONTS, 'OFL-plex-sans.txt', 'OFL-plex-sans-thai.txt', 'OFL-plex-mono.txt']) expect(() => readFileSync(join(DESIGN_DIR, 'fonts', file))).not.toThrow();
  });
});
