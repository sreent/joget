import { describe, expect, it } from 'vitest';
import { clamdScanner, ScannerUnavailableError } from '../src/files/scan.js';
import { cleanName, sniff } from '../src/files/sniff.js';

const bytes = (...values: number[]) => Buffer.from(values);

describe('what a file is', () => {
  it('reads the type from the content, never the name', () => {
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe1, 0, 0))).toMatchObject({ contentType: 'image/jpeg', kind: 'image' });
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toMatchObject({ contentType: 'image/png' });
    expect(sniff(Buffer.from('GIF89a....'))).toMatchObject({ contentType: 'image/gif' });
    expect(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toMatchObject({ contentType: 'image/webp' });
    expect(sniff(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0'))).toMatchObject({ contentType: 'image/heic' });
    expect(sniff(Buffer.from('%PDF-1.7\n'))).toMatchObject({ contentType: 'application/pdf', kind: 'pdf' });
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniff(Buffer.from('<html><script>'))).toBeNull();
    expect(sniff(bytes(0xff))).toBeNull();
  });

  it('keeps a clean name that ends as the content does', () => {
    const jpeg = sniff(bytes(0xff, 0xd8, 0xff))!;
    expect(cleanName('C:\\Users\\bob\\Receipt  (1).PNG', jpeg)).toBe('Receipt (1).jpg');
    expect(cleanName('../../etc/passwd', jpeg)).toBe('passwd.jpg');
    expect(cleanName('a"b<c>\u0000\u001fd.jpg', jpeg)).toBe('abcd.jpg');
    expect(cleanName(undefined, jpeg)).toBe('file.jpg');
    expect(cleanName('.hidden', jpeg)).toBe('file.jpg');
    expect(cleanName(`${'x'.repeat(300)}.jpg`, jpeg)).toHaveLength(194);
  });
});

describe('the malware scanner', () => {
  it("counts no answer as no answer: uploads then fail closed", async () => {
    const scanner = clamdScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    await expect(scanner.scan(Buffer.from('%PDF-'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});
