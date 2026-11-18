import {
  type AuditEvent,
  auditEventDigest,
  canonicalJson,
  createEd25519Signer,
  createEd25519Verifier,
  createSeal,
  generateEd25519KeyPair,
  merkleRoot,
  publicKeyPemFor,
  type Seal,
  type StoredEvent,
  uuidv7,
  verifySeals,
} from '@platform/audit';
import { describe, expect, it } from 'vitest';

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x', null], c: true }, z: undefined })).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('writes dates as ISO strings and undefined array items as null', () => {
    expect(canonicalJson([new Date('2026-01-02T03:04:05.678Z'), undefined])).toBe('["2026-01-02T03:04:05.678Z",null]');
  });

  it('rejects values that have no canonical form', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, new Map(), new Set(), () => 1, 10n, Symbol('x')]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
  });
});

describe('uuidv7', () => {
  it('sets the version and variant bits and orders by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(a.replaceAll('-', '').slice(0, 12)).toBe((1_700_000_000_000).toString(16).padStart(12, '0'));
  });
});

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: uuidv7(),
    occurredAt: new Date('2026-11-14T12:00:00.000Z'),
    orgId: 'org-1',
    actor: { type: 'user', id: 'alice', via: 'api' },
    action: 'binding.create',
    target: { type: 'binding', id: 'b-1' },
    outcome: 'success',
    changes: { after: { roleId: 'space.builder', principalId: 'bob' } },
    ...overrides,
  };
}

describe('auditEventDigest', () => {
  it('is stable across key order and between absent and null fields', () => {
    const e = event({ spaceId: null });
    const reordered = { ...e, changes: { after: { principalId: 'bob', roleId: 'space.builder' } }, spaceId: undefined };
    expect(auditEventDigest(reordered)).toBe(auditEventDigest(e));
  });

  it('changes when any field changes', () => {
    const e = event();
    expect(auditEventDigest({ ...e, outcome: 'denied' })).not.toBe(auditEventDigest(e));
    expect(auditEventDigest({ ...e, occurredAt: new Date(e.occurredAt.getTime() + 1) })).not.toBe(auditEventDigest(e));
  });
});

describe('merkleRoot (RFC 6962 test vectors)', () => {
  const inputs = [
    Buffer.alloc(0),
    Buffer.from([0x00]),
    Buffer.from([0x10]),
    Buffer.from([0x20, 0x21]),
    Buffer.from([0x30, 0x31]),
    Buffer.from([0x40, 0x41, 0x42, 0x43]),
    Buffer.from([0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57]),
    Buffer.from([...Array(16).keys()].map((i) => 0x60 + i)),
  ];
  const roots = [
    '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
    'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
    'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
    'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
    '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
    'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
    '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
  ];
  it.each(roots.map((root, i) => [i + 1, root] as const))('root of the first %i leaves', (n, root) => {
    expect(merkleRoot(inputs.slice(0, n)).toString('hex')).toBe(root);
  });

  it('hashes the empty tree as SHA-256 of nothing', () => {
    expect(merkleRoot([]).toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('seal chains', () => {
  const keys = generateEd25519KeyPair();
  const signer = createEd25519Signer('k1', keys.privateKeyPem);
  const verifier = createEd25519Verifier({ k1: publicKeyPemFor(keys.privateKeyPem) });

  async function buildLog() {
    const stored: StoredEvent[] = Array.from({ length: 7 }, (_, i) => {
      const e = event({ action: `test.action.${i}` });
      return { seq: i + 1, digest: auditEventDigest(e), event: e };
    });
    const ranges = [
      [1, 3],
      [4, 6],
      [7, 7],
    ] as const;
    const seals: Seal[] = [];
    for (const [from, to] of ranges) {
      const digests = stored.filter((s) => s.seq >= from && s.seq <= to).map((s) => s.digest);
      seals.push(await createSeal({ fromSeq: from, toSeq: to, digests }, seals.at(-1) ?? null, signer));
    }
    const lookup = (log: StoredEvent[]) => async (seal: Seal) => log.filter((s) => s.seq >= seal.fromSeq && s.seq <= seal.toSeq);
    return { stored, seals, lookup };
  }

  it('verifies an untouched log', async () => {
    const { stored, seals, lookup } = await buildLog();
    const report = await verifySeals(seals, lookup(stored), verifier, { fromGenesis: true });
    expect(report).toEqual({ ok: true, sealsChecked: 3, eventsChecked: 7, problems: [] });
  });

  it('detects an edited event even when its stored digest was edited too', async () => {
    const { stored, seals, lookup } = await buildLog();
    const tampered = stored.map((s) => {
      if (s.seq !== 5) return s;
      const edited = { ...s.event, outcome: 'denied' as const };
      return { ...s, event: edited, digest: auditEventDigest(edited) };
    });
    const report = await verifySeals(seals, lookup(tampered), verifier, { fromGenesis: true });
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({ kind: 'merkle_root_mismatch', sealIndex: 1 });
  });

  it('detects an edited event whose stored digest was left alone', async () => {
    const { stored, seals, lookup } = await buildLog();
    const tampered = stored.map((s) => (s.seq === 2 ? { ...s, event: { ...s.event, actor: { type: 'system' as const, id: 'x' } } } : s));
    const report = await verifySeals(seals, lookup(tampered), verifier);
    expect(report.problems).toContainEqual({ kind: 'event_digest_mismatch', sealIndex: 0, seq: 2 });
  });

  it('detects deleted and inserted events', async () => {
    const { stored, seals, lookup } = await buildLog();
    const deleted = await verifySeals(seals, lookup(stored.filter((s) => s.seq !== 4)), verifier);
    expect(deleted.problems).toContainEqual({ kind: 'event_count_mismatch', sealIndex: 1, expected: 3, actual: 2 });

    const extra = event({ action: 'sneaky' });
    const inserted = await verifySeals(seals, lookup([...stored, { seq: 6, digest: auditEventDigest(extra), event: extra }]), verifier);
    expect(inserted.problems).toContainEqual(expect.objectContaining({ kind: 'merkle_root_mismatch', sealIndex: 1 }));
  });

  it('detects a removed seal, a forged seal and an unknown key', async () => {
    const { stored, seals, lookup } = await buildLog();
    const gap = await verifySeals([seals[0]!, seals[2]!], lookup(stored), verifier);
    expect(gap.problems).toEqual(
      expect.arrayContaining([
        { kind: 'broken_chain', sealIndex: 1 },
        { kind: 'range_gap', sealIndex: 1, expectedFromSeq: 4 },
      ]),
    );

    const forged = await verifySeals([{ ...seals[0]!, eventCount: 2 }], lookup(stored), verifier);
    expect(forged.problems).toContainEqual({ kind: 'seal_hash_mismatch', sealIndex: 0 });

    const other = generateEd25519KeyPair();
    const otherVerifier = createEd25519Verifier({ k1: other.publicKeyPem });
    const badSignature = await verifySeals(seals, lookup(stored), otherVerifier);
    expect(badSignature.problems).toContainEqual({ kind: 'bad_signature', sealIndex: 0 });

    const noKeys = await verifySeals(seals, lookup(stored), createEd25519Verifier({}));
    expect(noKeys.problems).toContainEqual({ kind: 'unknown_key', sealIndex: 0, keyId: 'k1' });
  });

  it('refuses to start a seal anywhere but right after the previous one', async () => {
    const first = await createSeal({ fromSeq: 1, toSeq: 2, digests: [] }, null, signer);
    await expect(createSeal({ fromSeq: 4, toSeq: 5, digests: [] }, first, signer)).rejects.toThrow(RangeError);
  });

  it('rejects signing keys that are not Ed25519', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => createEd25519Signer('k', rsa)).toThrow(TypeError);
  });
});
