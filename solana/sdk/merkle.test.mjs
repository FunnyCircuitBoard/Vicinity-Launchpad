// node --test sdk/merkle.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  encodeLeaf,
  hashLeaf,
  hashNode,
  buildTree,
  getProof,
  verifyProof,
  claimArgs,
  allocateProRata,
  toHex,
  fromHex,
  fromBase58,
  toBase58,
  compareBytes,
  sha256,
  MAX_PROOF_LEN,
  U64_MAX,
  LEAF_LEN,
} from "./merkle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rnd = (n, seed) => sha256(Buffer.from(`seed-${seed}`)).subarray(0, n);
const wallet = (i) => {
  const out = new Uint8Array(32);
  out.set(sha256(Buffer.from(`wallet-${i}`)));
  return out;
};

describe("leaf encoding", () => {
  test("is 0x00 || u32 LE || 32 bytes || u64 LE (45 bytes)", () => {
    const claimant = new Uint8Array(32).fill(0xab);
    const leaf = encodeLeaf(0x01020304, claimant, 0x1122334455667788n);
    assert.equal(leaf.length, LEAF_LEN);
    assert.equal(leaf[0], 0x00);
    assert.deepEqual([...leaf.subarray(1, 5)], [0x04, 0x03, 0x02, 0x01]);
    assert.deepEqual([...leaf.subarray(5, 37)], [...claimant]);
    assert.deepEqual([...leaf.subarray(37, 45)], [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]);
  });

  test("hashLeaf is plain sha256 of the encoding", () => {
    const claimant = wallet(1);
    const expected = createHash("sha256").update(encodeLeaf(5, claimant, 42n)).digest("hex");
    assert.equal(toHex(hashLeaf(5, claimant, 42n)), expected);
  });

  test("accepts bigint, integer, decimal string and base58 claimant", () => {
    const w = wallet(2);
    const b58 = toBase58(w);
    assert.deepEqual(fromBase58(b58), w);
    const a = hashLeaf(1, w, 1000n);
    assert.deepEqual(hashLeaf(1, w, 1000), a);
    assert.deepEqual(hashLeaf(1, w, "1000"), a);
    assert.deepEqual(hashLeaf(1, b58, "1000"), a);
  });

  test("encoder is pure (amount 0 encodes, like the Rust leaf_hash); rejects negative, non-integer, > u64", () => {
    const w = wallet(3);
    assert.equal(encodeLeaf(0, w, 0n).length, LEAF_LEN);
    assert.throws(() => buildTree([{ claimant: w, amount: 0n }]), /amount must be > 0/);
    assert.throws(() => encodeLeaf(0, w, -1n), /amount must be > 0/);
    assert.throws(() => encodeLeaf(0, w, 1.5), /integer/);
    assert.throws(() => encodeLeaf(0, w, U64_MAX + 1n), /exceeds u64/);
    assert.throws(() => encodeLeaf(0, w, "18446744073709551616"), /exceeds u64/);
    assert.doesNotThrow(() => encodeLeaf(0, w, U64_MAX));
  });

  test("rejects bad index and bad claimant length", () => {
    const w = wallet(4);
    assert.throws(() => encodeLeaf(-1, w, 1n), /index/);
    assert.throws(() => encodeLeaf(2 ** 32, w, 1n), /index/);
    assert.throws(() => encodeLeaf(1.5, w, 1n), /index/);
    assert.throws(() => encodeLeaf(0, new Uint8Array(31), 1n), /32 bytes/);
    assert.throws(() => encodeLeaf(0, "", 1n), /empty/);
    assert.doesNotThrow(() => encodeLeaf(2 ** 32 - 1, w, 1n));
  });

  test("index and amount are part of the leaf (same wallet, different leaf)", () => {
    const w = wallet(5);
    assert.notDeepEqual(hashLeaf(0, w, 1n), hashLeaf(1, w, 1n));
    assert.notDeepEqual(hashLeaf(0, w, 1n), hashLeaf(0, w, 2n));
  });
});

describe("node hashing", () => {
  test("is 0x01 || min || max and order independent", () => {
    const a = rnd(32, "a");
    const b = rnd(32, "b");
    const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
    const expected = createHash("sha256").update(Buffer.from([1])).update(lo).update(hi).digest("hex");
    assert.equal(toHex(hashNode(a, b)), expected);
    assert.equal(toHex(hashNode(b, a)), expected);
  });

  test("domain separation: a leaf hash never equals a node hash of the same bytes", () => {
    // Even if an attacker controls two 32-byte values, the prefixes differ.
    const a = rnd(32, "x");
    const b = rnd(32, "y");
    const asNode = hashNode(a, b);
    const asLeafLike = sha256(Uint8Array.of(0), compareBytes(a, b) <= 0 ? a : b, compareBytes(a, b) <= 0 ? b : a);
    assert.notDeepEqual(asNode, asLeafLike);
  });

  test("rejects non 32-byte inputs", () => {
    assert.throws(() => hashNode(new Uint8Array(31), new Uint8Array(32)), /32 bytes/);
  });
});

describe("tree", () => {
  test("1 leaf: root is the leaf hash, proof is empty", () => {
    const t = buildTree([{ claimant: wallet(10), amount: 5n }]);
    assert.equal(t.numLeaves, 1);
    assert.equal(t.depth, 0);
    assert.deepEqual(t.root, hashLeaf(0, wallet(10), 5n));
    assert.deepEqual(getProof(t, 0), []);
    assert.ok(verifyProof(t.root, t.leafHashes[0], []));
  });

  test("2 leaves: root = node(leaf0, leaf1)", () => {
    const t = buildTree([
      { claimant: wallet(11), amount: 1n },
      { claimant: wallet(12), amount: 2n },
    ]);
    assert.deepEqual(t.root, hashNode(t.leafHashes[0], t.leafHashes[1]));
    assert.deepEqual(getProof(t, 0), [t.leafHashes[1]]);
    assert.deepEqual(getProof(t, 1), [t.leafHashes[0]]);
  });

  test("3 leaves: odd layer promotes the last node unchanged", () => {
    const t = buildTree([
      { claimant: wallet(13), amount: 1n },
      { claimant: wallet(14), amount: 2n },
      { claimant: wallet(15), amount: 3n },
    ]);
    const [l0, l1, l2] = t.leafHashes;
    const n01 = hashNode(l0, l1);
    assert.deepEqual(t.layers[1], [n01, l2]); // l2 promoted, not hashed with itself
    assert.deepEqual(t.root, hashNode(n01, l2));
    assert.deepEqual(getProof(t, 2), [n01]); // one level shorter than leaf 0's proof
    assert.deepEqual(getProof(t, 0), [l1, l2]);
    for (let i = 0; i < 3; i++) assert.ok(verifyProof(t.root, t.leafHashes[i], getProof(t, i)));
  });

  for (const n of [1, 2, 4, 8, 16, 64, 1024]) {
    test(`power of two ${n}: every proof verifies and has depth log2`, () => {
      const t = buildTree(Array.from({ length: n }, (_, i) => ({ claimant: wallet(1000 + i), amount: BigInt(i + 1) })));
      assert.equal(t.depth, Math.log2(n));
      for (let i = 0; i < n; i++) {
        const p = getProof(t, i);
        assert.equal(p.length, Math.log2(n));
        assert.ok(verifyProof(t.root, t.leafHashes[i], p));
      }
    });
  }

  for (const n of [3, 5, 6, 7, 9, 100, 2000]) {
    test(`non power of two ${n}: every proof verifies, depth = ceil(log2)`, () => {
      const t = buildTree(Array.from({ length: n }, (_, i) => ({ claimant: wallet(5000 + i), amount: BigInt(i + 1) })));
      assert.equal(t.depth, Math.ceil(Math.log2(n)));
      for (let i = 0; i < n; i++) {
        const p = getProof(t, i);
        assert.ok(p.length <= t.depth);
        assert.ok(verifyProof(t.root, t.leafHashes[i], p), `leaf ${i}`);
      }
    });
  }

  test("2000 leaves has depth 11 (spec: large tree)", () => {
    const t = buildTree(Array.from({ length: 2000 }, (_, i) => ({ claimant: wallet(9000 + i), amount: 7n })));
    assert.equal(t.depth, 11);
    assert.equal(t.total, 14000n);
  });

  test("rejects duplicate claimants (bytes, base58 and mixed forms)", () => {
    const w = wallet(20);
    assert.throws(
      () => buildTree([{ claimant: w, amount: 1n }, { claimant: wallet(21), amount: 1n }, { claimant: w, amount: 2n }]),
      /duplicate claimant at index 0 and 2/
    );
    assert.throws(() => buildTree([{ claimant: w, amount: 1n }, { claimant: toBase58(w), amount: 2n }]), /duplicate/);
  });

  test("rejects empty input, amount 0 and explicit index that is not the position", () => {
    assert.throws(() => buildTree([]), /at least one leaf/);
    assert.throws(() => buildTree([{ claimant: wallet(1), amount: 0n }]), /amount must be > 0/);
    assert.throws(() => buildTree([{ index: 1, claimant: wallet(1), amount: 1n }]), /carries index 1/);
    assert.doesNotThrow(() => buildTree([{ index: 0, claimant: wallet(1), amount: 1n }]));
  });

  test("getProof rejects out of range index", () => {
    const t = buildTree([{ claimant: wallet(1), amount: 1n }]);
    assert.throws(() => getProof(t, 1), /out of range/);
  });

  test("claimArgs returns index, claimant, amount, proof", () => {
    const t = buildTree([{ claimant: wallet(1), amount: 9n }, { claimant: wallet(2), amount: 8n }]);
    const c = claimArgs(t, 1);
    assert.equal(c.index, 1);
    assert.deepEqual(c.claimant, wallet(2));
    assert.equal(c.amount, 8n);
    assert.deepEqual(c.proof, [t.leafHashes[0]]);
  });
});

describe("verifyProof negative cases (mirror of the on-chain checks)", () => {
  const n = 37;
  const leaves = Array.from({ length: n }, (_, i) => ({ claimant: wallet(300 + i), amount: BigInt(100 + i) }));
  const t = buildTree(leaves);

  test("wrong amount", () => {
    assert.ok(!verifyProof(t.root, hashLeaf(4, leaves[4].claimant, leaves[4].amount + 1n), getProof(t, 4)));
  });
  test("wrong index", () => {
    assert.ok(!verifyProof(t.root, hashLeaf(5, leaves[4].claimant, leaves[4].amount), getProof(t, 4)));
  });
  test("another wallet's leaf", () => {
    assert.ok(!verifyProof(t.root, hashLeaf(4, leaves[6].claimant, leaves[4].amount), getProof(t, 4)));
  });
  test("proof for another leaf", () => {
    assert.ok(!verifyProof(t.root, t.leafHashes[4], getProof(t, 9)));
  });
  test("truncated proof", () => {
    const p = getProof(t, 4);
    assert.ok(!verifyProof(t.root, t.leafHashes[4], p.slice(0, -1)));
    assert.ok(!verifyProof(t.root, t.leafHashes[4], []));
  });
  test("overlong proof (extra element) and proof longer than 32", () => {
    const p = getProof(t, 4);
    assert.ok(!verifyProof(t.root, t.leafHashes[4], [...p, rnd(32, "extra")]));
    const long = Array.from({ length: MAX_PROOF_LEN + 1 }, (_, i) => rnd(32, `l${i}`));
    assert.ok(!verifyProof(t.root, t.leafHashes[4], long));
  });
  test("tampered sibling", () => {
    const p = getProof(t, 4);
    p[1] = rnd(32, "tamper");
    assert.ok(!verifyProof(t.root, t.leafHashes[4], p));
  });
  test("wrong root", () => {
    assert.ok(!verifyProof(rnd(32, "root"), t.leafHashes[4], getProof(t, 4)));
  });
  test("leaf hash presented as node (second preimage) does not verify", () => {
    // Take an inner node and try to claim it as a leaf with its sibling path.
    const inner = t.layers[1][0];
    const siblingPath = getProof(t, 0).slice(1);
    assert.ok(!verifyProof(t.root, sha256(Uint8Array.of(0), inner), siblingPath));
  });
});

describe("allocateProRata", () => {
  test("floors, keeps dust, drops zero amounts", () => {
    const { leaves, dust, allocated } = allocateProRata(
      [
        { claimant: wallet(1), balance: 1n },
        { claimant: wallet(2), balance: 2n },
        { claimant: wallet(3), balance: 1_000_000n },
      ],
      1000n
    );
    // 1/1000003*1000 = 0 -> dropped ; 2/... = 0 -> dropped ; 1_000_000/1_000_003*1000 = 999
    assert.equal(leaves.length, 1);
    assert.equal(allocated, 999n);
    assert.equal(dust, 1n);
  });
  test("exact split with no dust", () => {
    const { leaves, dust } = allocateProRata([{ claimant: wallet(1), balance: 3n }, { claimant: wallet(2), balance: 1n }], 400n);
    assert.deepEqual(leaves.map((l) => l.amount), [300n, 100n]);
    assert.equal(dust, 0n);
  });
  test("rejects no balances and negative balance", () => {
    assert.throws(() => allocateProRata([{ claimant: wallet(1), balance: 0n }], 10n), /no balances/);
    assert.throws(() => allocateProRata([{ claimant: wallet(1), balance: -1n }], 10n), /negative/);
  });
});

describe("hex / base58", () => {
  test("round trips", () => {
    const b = rnd(32, "hex");
    assert.deepEqual(fromHex(toHex(b)), b);
    assert.deepEqual(fromHex("0x" + toHex(b)), b);
    assert.deepEqual(fromBase58(toBase58(b)), b);
    const zeros = new Uint8Array(32);
    assert.equal(toBase58(zeros), "1".repeat(32));
    assert.deepEqual(fromBase58("1".repeat(32)), zeros);
    // System program id as a known vector
    assert.equal(toBase58(new Uint8Array(32)), "11111111111111111111111111111111");
  });
  test("rejects bad input", () => {
    assert.throws(() => fromHex("abc"), /hex/);
    assert.throws(() => fromHex("zz"), /hex/);
    assert.throws(() => fromBase58("0OIl"), /bad character/);
  });
});

// ---------------------------------------------------------------------------
// Fixtures: two files, one shape (sdk/fixtures/README.md), one construction.
// merkle.json is written by fixtures/generate.mjs, which shares no code with
// this SDK or the program; merkle-js.json is written by gen-fixtures.mjs with
// this SDK. The Rust unit test (merkle.rs::fixtures_match_the_sdk) reads the
// same two files, so if any side drifts, one of the three disagrees.

const FIXTURE_FILES = ["merkle.json", "merkle-js.json"];

function checkFixture(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.version, 1, `${file}: version`);
  assert.ok(data.trees.length >= 20, `${file}: at least 20 trees`);
  assert.ok(data.leaf_vectors.length >= 1, `${file}: has leaf vectors`);
  for (const t of data.trees) {
    const tree = buildTree(t.leaves.map((l) => ({ index: l.index, claimant: fromBase58(l.claimant), amount: l.amount })));
    assert.equal(toHex(tree.root), t.root, `${file} ${t.name}: root`);
    assert.equal(tree.depth, t.depth, `${file} ${t.name}: depth`);
    const proofs = Object.entries(t.proofs);
    assert.ok(proofs.length > 0, `${file} ${t.name}: at least one proof`);
    for (const [i, proof] of proofs) {
      const idx = Number(i);
      assert.deepEqual(getProof(tree, idx).map(toHex), proof, `${file} ${t.name}: proof ${i}`);
      const bytes = proof.map(fromHex);
      assert.ok(verifyProof(tree.root, tree.leafHashes[idx], bytes), `${file} ${t.name}: verify ${i}`);
      // the same proof must not work for a neighbouring leaf
      if (tree.numLeaves > 1) assert.ok(!verifyProof(tree.root, tree.leafHashes[(idx + 1) % tree.numLeaves], bytes), `${file} ${t.name}: neighbour ${i}`);
    }
  }
  for (const v of data.leaf_vectors) {
    assert.equal(toHex(hashLeaf(v.index, fromBase58(v.claimant), v.amount)), v.leaf, `${file}: leaf vector ${v.index}`);
  }
  for (const nv of data.node_vectors ?? []) {
    assert.equal(toHex(hashNode(fromHex(nv.a), fromHex(nv.b))), nv.node, `${file}: node vector`);
    assert.equal(toHex(hashNode(fromHex(nv.b), fromHex(nv.a))), nv.node, `${file}: node vector (swapped)`);
  }
  return data.trees.length;
}

describe("fixtures", () => {
  for (const name of FIXTURE_FILES) {
    const file = join(here, "fixtures", name);
    test(`${name} reproduces: 20 roots, every listed proof, depths, leaf vectors`, () => {
      assert.ok(existsSync(file), `${file} is committed`);
      assert.equal(checkFixture(file), 20);
    });
  }
});
