import { createHash } from 'node:crypto';

/**
 * Merkle tree hashing as specified in RFC 6962 §2.1 (the scheme used by Certificate Transparency).
 * Leaf and interior nodes use distinct prefixes, which prevents second-preimage attacks.
 */
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function leafHash(data: Uint8Array): Buffer {
  return sha256(LEAF_PREFIX, data);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** The Merkle Tree Hash (MTH) of a list of leaf inputs. */
export function merkleRoot(leaves: readonly Uint8Array[]): Buffer {
  if (leaves.length === 0) return sha256();
  return treeHash(leaves.map(leafHash));
}

function treeHash(hashes: readonly Buffer[]): Buffer {
  if (hashes.length === 1) return hashes[0]!;
  let split = 1;
  while (split * 2 < hashes.length) split *= 2;
  return nodeHash(treeHash(hashes.slice(0, split)), treeHash(hashes.slice(split)));
}
