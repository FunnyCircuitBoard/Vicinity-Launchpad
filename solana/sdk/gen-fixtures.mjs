// Writes sdk/fixtures/merkle-js.json: the SDK's own deterministic vectors (hex
// claimants, leaf hashes for small trees, node vectors, 20 trees up to 257
// leaves). The canonical cross-implementation file is sdk/fixtures/merkle.json
// (see sdk/fixtures/README.md); it is generated on the program side and read
// by both `cargo test` and `npm run sdk-test`. With `--rust-shape` this script
// also prints the same data in that file's shape, for comparison only.
// Run: npm run sdk-fixtures
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256, hashLeaf, hashNode, buildTree, serializeTree, toHex, toBase58 } from "./merkle.mjs";

// Deterministic pseudo-random bytes: sha256("vicinity-fixtures" || counter)
function prng(seed) {
  let counter = 0;
  return (n) => {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const block = sha256(Buffer.from(seed), Buffer.from(String(counter++)));
      const take = Math.min(32, n - off);
      out.set(block.subarray(0, take), off);
      off += take;
    }
    return out;
  };
}

const rand = prng("vicinity-fixtures");
const randU64 = () => {
  const b = rand(8);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v === 0n ? 1n : v;
};

// 20 trees: powers of two, odd sizes (promotion rule) and a few larger ones.
const sizes = [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 64, 100, 127, 128, 129, 257];

const trees = sizes.map((n) => {
  const leaves = [];
  for (let i = 0; i < n; i++) {
    // mix small and huge amounts so u64 LE encoding is exercised end to end
    const amount = i % 3 === 0 ? randU64() : BigInt(1 + (i * 7919) % 1000003);
    leaves.push({ claimant: rand(32), amount });
  }
  const tree = buildTree(leaves);
  const proofIdx = [...new Set([0, n - 1, Math.floor(n / 2), Math.floor(n / 3)])].filter((i) => i < n);
  const ser = serializeTree(tree, proofIdx);
  if (n > 33) delete ser.leafHashes; // keep the file small; roots and proofs still pin every leaf
  return { name: `tree-${n}`, ...ser };
});

const leafVectors = [
  { index: 0, claimant: toHex(new Uint8Array(32)), amount: "1" },
  { index: 1, claimant: toHex(new Uint8Array(32).fill(0xff)), amount: "18446744073709551615" },
  { index: 4294967295, claimant: toHex(rand(32)), amount: "1000000" },
  { index: 7, claimant: toHex(rand(32)), amount: "4294967296" },
  { index: 123456, claimant: toHex(rand(32)), amount: "9007199254740993" },
].map((v) => ({ ...v, leafHash: toHex(hashLeaf(v.index, Buffer.from(v.claimant, "hex"), v.amount)) }));

const nodeVectors = [];
for (let i = 0; i < 5; i++) {
  const a = rand(32);
  const b = rand(32);
  nodeVectors.push({ a: toHex(a), b: toHex(b), node: toHex(hashNode(a, b)), nodeSwapped: toHex(hashNode(b, a)) });
}

const out = {
  description:
    "Vicinity Rewards Merkle fixtures (JS reference). leaf = sha256(0x00 || u32 LE index || claimant || u64 LE amount); node = sha256(0x01 || min || max); odd layer promotes last node unchanged. All bytes hex, amounts decimal strings.",
  hash: "sha256",
  leafPrefix: "00",
  nodePrefix: "01",
  oddLayerRule: "promote-last-unchanged",
  leafVectors,
  nodeVectors,
  trees,
};

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "fixtures", "merkle-js.json");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${target}: ${trees.length} trees, ${leafVectors.length} leaf vectors, ${nodeVectors.length} node vectors`);

// Optional: the same data in the shape of fixtures/merkle.json, printed to stdout
// (never written over the canonical file).
if (process.argv.includes("--rust-shape")) {
  const rust = {
    version: 1,
    trees: trees.map((t) => ({
      name: t.name,
      leaves: t.leaves.map((l) => ({ index: l.index, claimant: toBase58(Buffer.from(l.claimant, "hex")), amount: l.amount })),
      root: t.root,
      depth: t.depth,
      proofs: Object.fromEntries(t.proofs.map((p) => [String(p.index), p.proof])),
    })),
    leaf_vectors: leafVectors.map((v) => ({
      index: v.index,
      claimant: toBase58(Buffer.from(v.claimant, "hex")),
      amount: v.amount,
      leaf: v.leafHash,
    })),
  };
  process.stdout.write(JSON.stringify(rust, null, 1) + "\n");
}
