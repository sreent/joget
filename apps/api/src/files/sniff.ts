import type { FileKind } from '@platform/app-model';

/** What a file is, read from its first bytes: never from its name, or the type a client claims. */
export interface FileType {
  readonly contentType: string;
  readonly kind: FileKind;
  readonly extension: string;
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

/** The type of a file Ambit keeps, or null for anything else: receipts are photos and PDFs. */
export function sniff(content: Buffer): FileType | null {
  const at = (offset: number, bytes: readonly number[]) => bytes.every((byte, i) => content[offset + i] === byte);
  const text = (from: number, to: number) => content.subarray(from, to).toString('latin1');
  if (at(0, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', kind: 'image', extension: 'jpg' };
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', kind: 'image', extension: 'png' };
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return { contentType: 'image/gif', kind: 'image', extension: 'gif' };
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return { contentType: 'image/webp', kind: 'image', extension: 'webp' };
  if (text(4, 8) === 'ftyp' && HEIF_BRANDS.has(text(8, 12))) return { contentType: 'image/heic', kind: 'image', extension: 'heic' };
  if (text(0, 5) === '%PDF-') return { contentType: 'application/pdf', kind: 'pdf', extension: 'pdf' };
  return null;
}

/**
 * A file name fit to keep and show: the last part of a path, without control characters or
 * characters that break headers, at most 200 characters, and ending in the extension the content has.
 */
export function cleanName(raw: string | undefined, type: FileType): string {
  const base = (raw ?? '').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stem =
    cleaned
      .replace(/\.[^.]*$/, '')
      .slice(0, 190)
      .trim() || 'file';
  return `${stem}.${type.extension}`;
}
