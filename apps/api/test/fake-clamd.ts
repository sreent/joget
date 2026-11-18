import { createServer } from 'node:net';

/** What the stand-in finds as "malware": a harmless marker, not a real virus signature. */
export const MALWARE_MARKER = 'AMBIT-TEST-MALWARE-MARKER';

/**
 * A stand-in for ClamAV's clamd: it speaks the INSTREAM protocol (length-prefixed chunks, ended by
 * a zero length) and reports the marker as found. `mode` makes it fail instead, as clamd can.
 */
export async function startFakeClamd(): Promise<{ port: number; mode: 'scan' | 'error'; scans: number; close(): Promise<void> }> {
  const state = { mode: 'scan' as 'scan' | 'error', scans: 0 };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    const chunks: Buffer[] = [];
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandRead) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        if (buffer.subarray(0, end).toString() !== 'zINSTREAM') return void socket.end('UNKNOWN COMMAND\0');
        buffer = buffer.subarray(end + 1);
        commandRead = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          state.scans += 1;
          const content = Buffer.concat(chunks).toString('latin1');
          const reply =
            state.mode === 'error'
              ? 'INSTREAM size limit exceeded. ERROR'
              : content.includes(MALWARE_MARKER)
                ? 'stream: Ambit.Test.Marker FOUND'
                : 'stream: OK';
          socket.end(`${reply}\0`);
          return;
        }
        if (buffer.length < 4 + length) return;
        chunks.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    get mode() {
      return state.mode;
    },
    set mode(value) {
      state.mode = value;
    },
    get scans() {
      return state.scans;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
