// Writes sdk/fixtures/merkle-js.json: the SDK's own deterministic vectors, built
// with sdk/merkle.mjs, in the SAME shape as the canonical sdk/fixtures/merkle.json
// (written by sdk/fixtures/generate.mjs, which shares no code with the SDK or
// the program). Both files are read by `cargo test` (merkle.rs) and by
// `npm run sdk-test`, so the program, the SDK and the independent generator
// are all pinned to one construction. Shape: sdk/fixtures/README.md. The only
// extra key here is `node_vectors`, which the Rust reader ignores.
// Run: npm run sdk-fixtures
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256, hashLeaf, hashNode, buildTree, getProof, toHex, toBase58 } from "./merkle.mjs";

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
// Sizes differ from merkle.json on purpose so the two files pin different trees.
const sizes = [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 64, 100, 127, 128, 129, 257];

const trees = sizes.map((n) => {
  const leaves = [];
  for (let i = 0; i < n; i++) {
    // mix small and huge amounts so u64 LE encoding is exercised end to end
    const amount = i % 3 === 0 ? randU64() : BigInt(1 + ((i * 7919) % 1000003));
    leaves.push({ claimant: rand(32), amount });
  }
  const tree = buildTree(leaves);
  // every proof for small trees, a sample (first, last, middle, third) for the rest
  const proofIdx = n <= 64 ? [...Array(n).keys()] : [...new Set([0, n - 1, Math.floor(n / 2), Math.floor(n / 3)])].sort((a, b) => a - b);
  const proofs = {};
  for (const i of proofIdx) proofs[String(i)] = getProof(tree, i).map(toHex);
  return {
    name: `js-${n}-leaves`,
    leaves: tree.leaves.map((l) => ({ index: l.index, claimant: toBase58(l.claimant), amount: l.amount.toString() })),
    root: toHex(tree.root),
    depth: tree.depth,
    proofs,
  };
});

const leafVectors = [
  { index: 0, claimant: new Uint8Array(32), amount: "1" },
  { index: 1, claimant: new Uint8Array(32).fill(0xff), amount: "18446744073709551615" },
  { index: 4294967295, claimant: rand(32), amount: "1000000" },
  { index: 7, claimant: rand(32), amount: "4294967296" },
  { index: 123456, claimant: rand(32), amount: "9007199254740993" },
].map((v) => ({ index: v.index, claimant: toBase58(v.claimant), amount: v.amount, leaf: toHex(hashLeaf(v.index, v.claimant, v.amount)) }));

const nodeVectors = [];
for (let i = 0; i < 5; i++) {
  const a = rand(32);
  const b = rand(32);
  const node = toHex(hashNode(a, b));
  if (toHex(hashNode(b, a)) !== node) throw new Error("node hash must be order independent");
  nodeVectors.push({ a: toHex(a), b: toHex(b), node });
}

const out = {
  version: 1,
  description:
    "Merkle fixtures written by sdk/gen-fixtures.mjs with the SDK's own builder (sdk/merkle.mjs). Same shape and rules as merkle.json; both files are read by programs/vicinity-rewards/src/merkle.rs and sdk/merkle.test.mjs.",
  encoding: {
    claimant: "base58 Solana public key (32 bytes)",
    amount: "u64 as a decimal string (may exceed 2^53)",
    root: "hex, 32 bytes",
    proofs: "map from leaf index (string) to the list of sibling hashes (hex), leaf level first",
    leaf: "hex, 32 bytes",
    node_vectors: "a, b and node = sha256(0x01 || min(a, b) || max(a, b)), all hex",
  },
  rules: {
    hash: "SHA-256",
    leaf: "sha256(0x00 || index as u32 little endian || claimant 32 bytes || amount as u64 little endian)",
    node: "sha256(0x01 || min(left, right) || max(left, right))  (byte-wise comparison, so proofs carry no direction bits)",
    odd_node: "when a level has an odd number of nodes, the last node is promoted unchanged to the next level",
    single_leaf: "a tree with one leaf has root == leaf and an empty proof",
    max_proof_len: 32,
  },
  leaf_vectors: leafVectors,
  node_vectors: nodeVectors,
  trees,
};

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? join(here, "fixtures", "merkle-js.json");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${target}: ${trees.length} trees, ${leafVectors.length} leaf vectors, ${nodeVectors.length} node vectors`);
