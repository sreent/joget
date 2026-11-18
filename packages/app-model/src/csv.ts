import { isComputed, type StoredEntity, type StoredField } from './fields.js';

/*
 * CSV, to bring records in from spreadsheets and other systems, and to take them out (design §6.1).
 * An import is a write like any other: each record goes through the checks, rules and permissions
 * of a create, and the import writes all of its records or none.
 */

/** The most records one import takes. */
export const MAX_IMPORT_ROWS = 1000;

/** The separator a file uses: a comma, or a semicolon where its first line has more of them, as some spreadsheets write. */
function separatorOf(text: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c === ',') commas++;
    else if (!quoted && c === ';') semicolons++;
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * Rows of cells from CSV text, as RFC 4180 writes it: a quoted cell may hold separators, quotes
 * (doubled) and line breaks. A byte order mark is dropped, and so are blank lines.
 */
export function parseCsv(text: string): { readonly ok: true; readonly rows: string[][] } | { readonly ok: false; readonly message: string } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const separator = separatorOf(body);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false; // whether the cell has anything in it yet, quotes included
  const endCell = () => {
    row.push(cell);
    cell = '';
    started = false;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (body[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"' && !started) {
      quoted = true;
      started = true;
    } else if (c === separator) endCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      endCell();
      rows.push(row);
      row = [];
    } else {
      cell += c;
      started = true;
    }
  }
  if (quoted) return { ok: false, message: 'A quoted cell has no closing quote' };
  if (started || row.length) {
    endCell();
    rows.push(row);
  }
  return { ok: true, rows: rows.filter((cells) => cells.some((value) => value.trim() !== '')) };
}

/**
 * Text that a spreadsheet won't run: one that starts as a formula does, with = + - or @, starts with
 * an apostrophe, which spreadsheets take as "this is text".
 */
export function safeCell(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** CSV text from rows of cells, as RFC 4180 writes it, with a byte order mark so that spreadsheets read it as UTF-8. */
export function writeCsv(rows: ReadonlyArray<readonly string[]>): string {
  const quote = (cell: string) => (/[",\r\n;]|^\s|\s$/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
  return `﻿${rows.map((cells) => cells.map(quote).join(',')).join('\r\n')}\r\n`;
}

/** A column of a file, and the field it fills, or why it fills none. */
export interface ImportColumn {
  readonly header: string;
  readonly field: string | null;
  readonly note?: string;
}

/**
 * Which field each column fills: the field whose name or label the header is, in any case. The
 * owner is a column too. Fields the platform works out, lines and files take no column.
 */
export function importColumns(entity: StoredEntity, headers: readonly string[]): ImportColumn[] {
  const taken = new Set<string>();
  const key = (text: string) => text.trim().toLowerCase();
  return headers.map((header) => {
    const field = entity.fields.find((f) => key(f.name) === key(header) || key(f.label) === key(header));
    const name = field?.name ?? (key(header) === 'owner' ? 'owner' : null);
    if (!name) return { header, field: null, note: 'No field has this name' };
    if (field && isComputed(field)) return { header, field: null, note: 'The platform works this field out' };
    if (field?.type === 'lines') return { header, field: null, note: "Lines can't be brought in from a file" };
    if (field?.type === 'file') return { header, field: null, note: "Files can't be brought in from a file" };
    if (taken.has(name)) return { header, field: null, note: 'Another column fills this field' };
    taken.add(name);
    return { header, field: name };
  });
}

/** What a cell holds for its field: a value, a problem, or names to look up, such as the titles of records or people's email addresses. */
export type CellValue =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }
  | { readonly lookup: 'record' | 'person'; readonly keys: readonly string[]; readonly many: boolean };

const NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
const GROUPED = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/** The parts of a cell that holds several: separated by semicolons, or else by commas. */
const partsOf = (text: string): string[] => (text.includes(';') ? text.split(';') : text.split(',')).map((part) => part.trim()).filter(Boolean);

/**
 * A cell's text as a value for its field, or the owner. Choices take an option's value or its label;
 * records take an ID or a title, and people an ID or an email address, which the caller looks up.
 * The checks of a create still check the value that comes out.
 */
export function cellValue(field: StoredField | 'owner', text: string): CellValue {
  const trimmed = text.trim();
  if (field === 'owner') return { lookup: 'person', keys: [trimmed], many: false };
  switch (field.type) {
    case 'text':
    case 'email':
      return { ok: true, value: text };
    case 'number': {
      if (NUMBER.test(trimmed)) return { ok: true, value: Number(trimmed) };
      if (GROUPED.test(trimmed)) return { ok: true, value: Number(trimmed.replaceAll(',', '')) };
      return { ok: false, message: 'Expected a number, such as 1234.50' };
    }
    case 'boolean': {
      const word = trimmed.toLowerCase();
      if (YES.has(word)) return { ok: true, value: true };
      if (NO.has(word)) return { ok: true, value: false };
      return { ok: false, message: 'Expected yes or no' };
    }
    case 'date':
    case 'datetime':
      // The checks say what a date or a time must look like.
      return { ok: true, value: trimmed };
    case 'choice': {
      const option = (part: string) => field.options.find((o) => o.value.toLowerCase() === part.toLowerCase() || o.label.toLowerCase() === part.toLowerCase())?.value;
      if (!field.multiple) {
        const value = option(trimmed);
        return value ? { ok: true, value } : { ok: false, message: `Expected one of: ${field.options.map((o) => o.label).join(', ')}` };
      }
      const parts = partsOf(trimmed);
      const unknown = parts.filter((part) => !option(part));
      if (unknown.length) return { ok: false, message: `Not options: ${unknown.join(', ')}` };
      return { ok: true, value: parts.map((part) => option(part)!) };
    }
    case 'reference':
      return { lookup: 'record', keys: field.multiple ? partsOf(trimmed) : [trimmed], many: field.multiple === true };
    case 'user':
      return { lookup: 'person', keys: [trimmed], many: false };
    case 'file':
    case 'lines':
      return { ok: false, message: "This field can't be brought in from a file" };
  }
}
