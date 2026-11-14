import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { auditEventDigest, sha256Hex, type AuditEvent } from './event.js';
import { merkleRoot } from './merkle.js';

/**
 * A seal covers a contiguous range of the audit log. It commits to the Merkle root of the event
 * digests in that range and to the previous seal, and is signed, so any later change to an event,
 * a deletion, an insertion or a reordering is detectable.
 */
export interface Seal {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly eventCount: number;
  readonly merkleRoot: string;
  readonly prevSealHash: string | null;
  readonly sealedAt: Date;
  readonly keyId: string;
  readonly sealHash: string;
  /** Base64 signature over the seal hash. */
  readonly signature: string;
}

export type SealFields = Omit<Seal, 'sealHash' | 'signature'>;

export interface Signer {
  readonly keyId: string;
  sign(data: Buffer): Promise<Buffer>;
}

export interface SignatureVerifier {
  /** Resolves to `undefined` when the key is unknown. */
  verify(keyId: string, data: Buffer, signature: Buffer): Promise<boolean | undefined>;
}

const SEAL_VERSION = 1;

export function sealHashOf(fields: SealFields): string {
  return sha256Hex(
    canonicalJson({
      v: SEAL_VERSION,
      fromSeq: fields.fromSeq,
      toSeq: fields.toSeq,
      eventCount: fields.eventCount,
      merkleRoot: fields.merkleRoot,
      prevSealHash: fields.prevSealHash,
      sealedAt: fields.sealedAt.toISOString(),
      keyId: fields.keyId,
    }),
  );
}

export function digestsRoot(digests: readonly string[]): string {
  return merkleRoot(digests.map((digest) => Buffer.from(digest, 'hex'))).toString('hex');
}

/** Seal a range of events, given their stored digests in sequence order. */
export async function createSeal(
  range: { readonly fromSeq: number; readonly toSeq: number; readonly digests: readonly string[] },
  previous: Pick<Seal, 'sealHash' | 'toSeq'> | null,
  signer: Signer,
  sealedAt: Date = new Date(),
): Promise<Seal> {
  if (range.toSeq < range.fromSeq) throw new RangeError('A seal range cannot end before it starts');
  if (previous && range.fromSeq !== previous.toSeq + 1) {
    throw new RangeError(`A seal must start right after the previous one (expected ${previous.toSeq + 1})`);
  }
  const fields: SealFields = {
    fromSeq: range.fromSeq,
    toSeq: range.toSeq,
    eventCount: range.digests.length,
    merkleRoot: digestsRoot(range.digests),
    prevSealHash: previous?.sealHash ?? null,
    sealedAt,
    keyId: signer.keyId,
  };
  const sealHash = sealHashOf(fields);
  const signature = (await signer.sign(Buffer.from(sealHash, 'hex'))).toString('base64');
  return { ...fields, sealHash, signature };
}

export function createEd25519Signer(keyId: string, privateKeyPem: string): Signer {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('The audit signing key must be an Ed25519 key');
  return { keyId, sign: async (data) => sign(null, data, key) };
}

export function createEd25519Verifier(publicKeys: Readonly<Record<string, string | KeyObject>>): SignatureVerifier {
  const keys = new Map(
    Object.entries(publicKeys).map(([keyId, key]) => [keyId, typeof key === 'string' ? createPublicKey(key) : key]),
  );
  return {
    verify: async (keyId, data, signature) => {
      const key = keys.get(keyId);
      return key ? verify(null, data, key, signature) : undefined;
    },
  };
}

/** The public key (PEM) that matches an Ed25519 private key. */
export function publicKeyPemFor(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

export function generateEd25519KeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export interface StoredEvent {
  readonly seq: number;
  /** The digest stored alongside the event when it was written. */
  readonly digest: string;
  readonly event: AuditEvent;
}

export type VerificationProblem =
  | { readonly kind: 'broken_chain'; readonly sealIndex: number }
  | { readonly kind: 'range_gap'; readonly sealIndex: number; readonly expectedFromSeq: number }
  | { readonly kind: 'seal_hash_mismatch'; readonly sealIndex: number }
  | { readonly kind: 'unknown_key'; readonly sealIndex: number; readonly keyId: string }
  | { readonly kind: 'bad_signature'; readonly sealIndex: number }
  | { readonly kind: 'event_digest_mismatch'; readonly sealIndex: number; readonly seq: number }
  | { readonly kind: 'event_outside_range'; readonly sealIndex: number; readonly seq: number }
  | { readonly kind: 'event_count_mismatch'; readonly sealIndex: number; readonly expected: number; readonly actual: number }
  | { readonly kind: 'merkle_root_mismatch'; readonly sealIndex: number };

export interface VerificationReport {
  readonly ok: boolean;
  readonly sealsChecked: number;
  readonly eventsChecked: number;
  readonly problems: readonly VerificationProblem[];
}

/**
 * Verify a chain of seals, in order, against the events currently stored in each sealed range.
 *
 * Every event digest is recomputed from the event's fields, so editing an event is detected even
 * if the stored digest was edited too. Set `fromGenesis` when the first seal is the first one ever.
 */
export async function verifySeals(
  seals: readonly Seal[],
  eventsInRange: (seal: Seal) => Promise<readonly StoredEvent[]>,
  verifier: SignatureVerifier,
  options: { readonly fromGenesis?: boolean } = {},
): Promise<VerificationReport> {
  const problems: VerificationProblem[] = [];
  let eventsChecked = 0;
  for (const [sealIndex, seal] of seals.entries()) {
    const previous = seals[sealIndex - 1];
    if (previous) {
      if (seal.prevSealHash !== previous.sealHash) problems.push({ kind: 'broken_chain', sealIndex });
      if (seal.fromSeq !== previous.toSeq + 1) {
        problems.push({ kind: 'range_gap', sealIndex, expectedFromSeq: previous.toSeq + 1 });
      }
    } else if (options.fromGenesis && seal.prevSealHash !== null) {
      problems.push({ kind: 'broken_chain', sealIndex });
    }

    if (sealHashOf(seal) !== seal.sealHash) problems.push({ kind: 'seal_hash_mismatch', sealIndex });
    const signatureOk = await verifier.verify(seal.keyId, Buffer.from(seal.sealHash, 'hex'), Buffer.from(seal.signature, 'base64'));
    if (signatureOk === undefined) problems.push({ kind: 'unknown_key', sealIndex, keyId: seal.keyId });
    else if (!signatureOk) problems.push({ kind: 'bad_signature', sealIndex });

    const events = [...(await eventsInRange(seal))].sort((a, b) => a.seq - b.seq);
    const digests: string[] = [];
    for (const stored of events) {
      eventsChecked++;
      if (stored.seq < seal.fromSeq || stored.seq > seal.toSeq) {
        problems.push({ kind: 'event_outside_range', sealIndex, seq: stored.seq });
        continue;
      }
      const recomputed = auditEventDigest(stored.event);
      if (recomputed !== stored.digest) problems.push({ kind: 'event_digest_mismatch', sealIndex, seq: stored.seq });
      digests.push(recomputed);
    }
    if (digests.length !== seal.eventCount) {
      problems.push({ kind: 'event_count_mismatch', sealIndex, expected: seal.eventCount, actual: digests.length });
    }
    if (digestsRoot(digests) !== seal.merkleRoot) problems.push({ kind: 'merkle_root_mismatch', sealIndex });
  }
  return { ok: problems.length === 0, sealsChecked: seals.length, eventsChecked, problems };
}
