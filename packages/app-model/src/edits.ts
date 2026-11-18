import { z } from 'zod';

/*
 * Small changes to an app's definition, as JSON Patch (RFC 6902) writes them. An AI client, the
 * studio's chat or an MCP client, changes a definition a few values at a time instead of writing
 * all of it again; the definition's checks then run on the result, as for any other change.
 */

/**
 * One change: add a value at a path, replace the value there, or remove it. A path is a JSON
 * pointer, such as `/entities/claim/fields/-` for a new last field of the entity claim.
 */
export const DefinitionEdit = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), path: z.string().max(500), value: z.unknown() }),
  z.strictObject({ op: z.literal('replace'), path: z.string().max(500), value: z.unknown() }),
  z.strictObject({ op: z.literal('remove'), path: z.string().max(500) }),
]);
export type DefinitionEdit = z.infer<typeof DefinitionEdit>;

/** The most edits in one go. */
export const MAX_EDITS = 200;
export const DefinitionEdits = z.array(DefinitionEdit).min(1).max(MAX_EDITS);

export type EditsResult = { readonly ok: true; readonly definition: unknown } | { readonly ok: false; readonly index: number; readonly message: string };

/** Keys that would reach an object's prototype rather than a member of it. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** A JSON pointer as its keys: '' is the whole document; '/a/b~1c' is ['a', 'b/c']. Undefined if it isn't one. */
export function pointerKeys(path: string): string[] | undefined {
  if (path === '') return [];
  if (!path.startsWith('/')) return undefined;
  return path
    .slice(1)
    .split('/')
    .map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at a JSON pointer, or undefined if the pointer leads nowhere. */
export function valueAt(document: unknown, path: string): unknown {
  const keys = pointerKeys(path);
  if (!keys) return undefined;
  let at: unknown = document;
  for (const key of keys) {
    if (Array.isArray(at)) at = /^(0|[1-9]\d*)$/.test(key) ? at[Number(key)] : undefined;
    else if (isObject(at) && Object.hasOwn(at, key)) at = at[key];
    else return undefined;
  }
  return at;
}

/**
 * Apply edits in order to a copy of a definition: all of them, or none. An edit whose path leads
 * nowhere refuses all of them, and says which and why. The result is not checked here: the
 * definition's checks run on it next.
 */
export function applyEdits(definition: unknown, edits: readonly DefinitionEdit[]): EditsResult {
  let root: unknown = structuredClone(definition);
  for (const [index, edit] of edits.entries()) {
    const fail = (message: string): EditsResult => ({ ok: false, index, message: `${edit.op} ${edit.path}: ${message}` });
    const keys = pointerKeys(edit.path);
    if (!keys) return fail('a path is a JSON pointer, which starts with /');
    if (keys.some((key) => FORBIDDEN.has(key))) return fail('a path names members of the definition only');
    if (!keys.length) {
      if (edit.op === 'remove') return fail("the whole definition can't be removed");
      root = structuredClone(edit.value);
      continue;
    }
    let parent: unknown = root;
    for (const key of keys.slice(0, -1)) {
      if (Array.isArray(parent) && /^(0|[1-9]\d*)$/.test(key) && Number(key) < parent.length) parent = parent[Number(key)];
      else if (isObject(parent) && Object.hasOwn(parent, key)) parent = parent[key];
      else return fail(`nothing is at ${key}`);
    }
    const key = keys[keys.length - 1]!;
    if (Array.isArray(parent)) {
      const end = key === '-';
      if (!end && !/^(0|[1-9]\d*)$/.test(key)) return fail(`${key} isn't a place in a list: use a number, or - for the end`);
      const at = end ? parent.length : Number(key);
      if (edit.op === 'add') {
        if (at > parent.length) return fail(`the list has ${parent.length} items`);
        parent.splice(at, 0, structuredClone(edit.value));
      } else {
        if (end || at >= parent.length) return fail(`the list has ${parent.length} items`);
        if (edit.op === 'replace') parent[at] = structuredClone(edit.value);
        else parent.splice(at, 1);
      }
    } else if (isObject(parent)) {
      if (edit.op !== 'add' && !Object.hasOwn(parent, key)) return fail(`nothing is at ${key}`);
      if (edit.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(edit.value);
    } else {
      return fail('it leads into a value that holds nothing');
    }
  }
  return { ok: true, definition: root };
}
