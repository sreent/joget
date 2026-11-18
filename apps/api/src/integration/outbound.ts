import { lookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Config } from '../config.js';

/*
 * Calls to other systems (design §6.13), guarded. A call goes over https, to a host the
 * installation allows, and never to an address on a private network unless the installation names
 * the host: the address is checked as the connection opens, so a name that resolves elsewhere
 * later can't slip past. A call doesn't follow redirects, waits a while at most, and reads a
 * megabyte at most.
 */

export interface OutboundRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
}

export interface OutboundAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
}

/** Why a call didn't happen, or didn't finish: its words are safe to show a builder. */
export class OutboundError extends Error {}

const MAX_ANSWER_BYTES = 1024 * 1024;

/** Private, local and special addresses: loopback, private networks, link-local (cloud metadata), and the like. */
const PRIVATE = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv6');
}

function isPrivate(address: string, family: number): boolean {
  // An IPv4 address written as IPv6, ::ffff:10.0.0.1, is the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
  return PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

const names = (list: string) =>
  list
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

/** Whether the installation allows calls to a host: by name, or by *.domain. */
export function hostAllowed(config: Pick<Config, 'OUTBOUND_HOSTS'>, host: string): boolean {
  const allowed = names(config.OUTBOUND_HOSTS);
  const name = host.toLowerCase();
  return allowed.some((entry) => entry === '*' || entry === name || (entry.startsWith('*.') && name.endsWith(entry.slice(1))));
}

/** Make a guarded call. Rejects with an OutboundError when the call can't be made, or doesn't finish. */
export function send(config: Pick<Config, 'OUTBOUND_HOSTS' | 'OUTBOUND_PRIVATE_HOSTS' | 'OUTBOUND_ALLOW_HTTP' | 'SERVICE_TIMEOUT_SECONDS'>, call: OutboundRequest): Promise<OutboundAnswer> {
  const { url } = call;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.OUTBOUND_ALLOW_HTTP)) return Promise.reject(new OutboundError('A service is called over https'));
  if (!hostAllowed(config, host)) return Promise.reject(new OutboundError(`This installation doesn't allow calls to ${host}`));
  const privateAllowed = names(config.OUTBOUND_PRIVATE_HOSTS).includes(host);
  const family = isIP(host);
  if (family && !privateAllowed && isPrivate(host, family)) return Promise.reject(new OutboundError(`${host} is on a private network`));
  // The address the connection opens to, checked as it opens.
  const guarded = (hostname: string, options: object, done: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return done(new OutboundError(`${hostname} can't be found`), []);
      const allowed = privateAllowed ? addresses : addresses.filter((each) => !isPrivate(each.address, each.family));
      if (!allowed.length) return done(new OutboundError(`${hostname} is on a private network`), []);
      if ((options as { all?: boolean }).all) return done(null, allowed);
      return done(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = call.body === undefined ? undefined : Buffer.from(call.body, 'utf8');
    const outgoing = send(
      url,
      {
        method: call.method,
        headers: { ...call.headers, ...(body ? { 'content-length': String(body.length) } : {}) },
        lookup: guarded,
        timeout: config.SERVICE_TIMEOUT_SECONDS * 1000,
      },
      (answer: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) {
            outgoing.destroy(new OutboundError('The answer is larger than a megabyte'));
            return;
          }
          chunks.push(chunk);
        });
        answer.on('end', () => resolve({ status: answer.statusCode ?? 0, contentType: String(answer.headers['content-type'] ?? ''), text: Buffer.concat(chunks).toString('utf8') }));
        answer.on('error', (error) => reject(error instanceof OutboundError ? error : new OutboundError('The answer broke off')));
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new OutboundError(`No answer within ${config.SERVICE_TIMEOUT_SECONDS} seconds`)));
    outgoing.on('error', (error) => reject(error instanceof OutboundError ? error : new OutboundError(`The call failed: ${error.message}`)));
    if (body) outgoing.write(body);
    outgoing.end();
  });
}
