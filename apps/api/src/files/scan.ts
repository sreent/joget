import { connect } from 'node:net';

export type ScanResult = { readonly clean: true; readonly scanned: boolean } | { readonly clean: false; readonly threat: string };

/** Checks files for malware before anyone can use them (ISO 27001 A.8.7). */
export interface Scanner {
  readonly kind: 'none' | 'clamav';
  scan(content: Buffer): Promise<ScanResult>;
}

/** The scanner couldn't give an answer. Uploads fail closed: nothing unscanned is kept. */
export class ScannerUnavailableError extends Error {
  override readonly name = 'ScannerUnavailableError';
}

/** No scanner: files are kept, marked as not scanned. Production refuses uploads instead (see the file service). */
export const noScanner: Scanner = { kind: 'none', scan: async () => ({ clean: true, scanned: false }) };

const CHUNK = 64 * 1024;

/**
 * ClamAV's clamd, over TCP with its INSTREAM command: the file goes in length-prefixed chunks, and
 * clamd answers `stream: OK` or `stream: <threat> FOUND`. Anything else, or no answer in time,
 * counts as no answer.
 */
export function clamdScanner(options: { readonly host: string; readonly port: number; readonly timeoutMs?: number }): Scanner {
  return {
    kind: 'clamav',
    scan: (content) =>
      new Promise<ScanResult>((resolve, reject) => {
        const socket = connect({ host: options.host, port: options.port });
        const replies: Buffer[] = [];
        let settled = false;
        const finish = (result: ScanResult | Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        socket.setTimeout(options.timeoutMs ?? 30_000, () => finish(new ScannerUnavailableError('The malware scanner did not answer in time')));
        socket.on('error', (error) => finish(new ScannerUnavailableError(`The malware scanner is unreachable: ${error.message}`)));
        socket.on('data', (data) => replies.push(data));
        socket.on('end', () => {
          const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
          if (reply === 'stream: OK') return finish({ clean: true, scanned: true });
          const found = /^stream: (.+) FOUND$/.exec(reply);
          if (found) return finish({ clean: false, threat: found[1]! });
          finish(new ScannerUnavailableError(`The malware scanner could not scan the file: ${reply || 'no answer'}`));
        });
        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let offset = 0; offset < content.length; offset += CHUNK) {
            const chunk = content.subarray(offset, offset + CHUNK);
            const length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length);
            socket.write(length);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4)); // a zero length ends the stream
        });
      }),
  };
}
