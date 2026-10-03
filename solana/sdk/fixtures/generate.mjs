// Writes sdk/fixtures/merkle.json (canonical): deterministic Merkle trees that the
// Rust program (merkle.rs unit test) and the JS SDK must both reproduce.
// Independent implementation on purpose: it shares no code with either side.
// Usage: node sdk/fixtures/generate.mjs [output path]   (default: merkle.json next to this file)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const sha256 = (buf) => createHash("sha256").update(buf).digest();

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

function leafHash(index, claimant, amount) {
  const buf = Buffer.alloc(1 + 4 + 32 + 8);
  buf[0] = 0x00;
  buf.writeUInt32LE(index, 1);
  claimant.copy(buf, 5);
  buf.writeBigUInt64LE(amount, 37);
  return sha256(buf);
}

function nodeHash(a, b) {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.concat([Buffer.from([0x01]), lo, hi]));
}

function buildLevels(leaves) {
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1);
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 < cur.length) next.push(nodeHash(cur[i], cur[i + 1]));
      else next.push(cur[i]); // odd node promoted unchanged
    }
    levels.push(next);
  }
  return levels;
}

function proofFor(levels, index) {
  const out = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sib = idx ^ 1;
    if (sib < level.length) out.push(level[sib]);
    idx >>= 1;
  }
  return out;
}

// Deterministic pseudo random claimants and amounts derived from the tree name.
function claimantFor(name, i) {
  return sha256(Buffer.from(`vicinity-merkle-fixture:claimant:${name}:${i}`));
}
function amountFor(name, i) {
  const h = sha256(Buffer.from(`vicinity-merkle-fixture:amount:${name}:${i}`));
  // Mostly realistic base-unit amounts (up to ~1e12), never zero.
  return (h.readBigUInt64LE(0) % 1_000_000_000_000n) + 1n;
}

const hex = (b) => Buffer.from(b).toString("hex");

const sizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 31, 32, 33, 63, 64, 65, 129];
const trees = [];
for (const n of sizes) {
  const name = `${n}-leaves`;
  const leaves = [];
  for (let i = 0; i < n; i++) {
    let amount = amountFor(name, i);
    // Edge amounts in the 7-leaf tree: 1 base unit and the u64 maximum, so the
    // SDK is forced to use BigInt and the Rust side to use u64 end to end.
    if (n === 7 && i === 2) amount = 1n;
    if (n === 7 && i === 5) amount = 18446744073709551615n;
    leaves.push({ index: i, claimant: claimantFor(name, i), amount });
  }
  const hashes = leaves.map((l) => leafHash(l.index, l.claimant, l.amount));
  const levels = buildLevels(hashes);
  const root = levels.at(-1)[0];
  // All proofs for small trees, a sample for the larger ones.
  const want =
    n <= 64
      ? [...Array(n).keys()]
      : [...new Set([0, 1, 2, 63, 64, 65, n - 2, n - 1].filter((i) => i < n))].sort((a, b) => a - b);
  const proofs = {};
  for (const i of want) proofs[String(i)] = proofFor(levels, i).map(hex);
  // Sanity: every proof verifies with an independent fold.
  for (const [i, p] of Object.entries(proofs)) {
    let node = hashes[Number(i)];
    for (const s of p) node = nodeHash(node, Buffer.from(s, "hex"));
    if (!node.equals(root)) throw new Error(`self-check failed ${name} ${i}`);
  }
  trees.push({
    name,
    leaves: leaves.map((l) => ({ index: l.index, claimant: base58(l.claimant), amount: l.amount.toString() })),
    root: hex(root),
    depth: levels.length - 1,
    proofs,
  });
}

const leafVectors = [
  { index: 0, claimant: Buffer.alloc(32, 0), amount: 0n },
  { index: 0, claimant: Buffer.alloc(32, 1), amount: 1n },
  { index: 7, claimant: claimantFor("vector", 7), amount: 123456789n },
  { index: 4294967295, claimant: claimantFor("vector", 8), amount: 18446744073709551615n },
  { index: 1, claimant: claimantFor("vector", 9), amount: 1000000000n },
].map((v) => ({
  index: v.index,
  claimant: base58(v.claimant),
  amount: v.amount.toString(),
  leaf: hex(leafHash(v.index, v.claimant, v.amount)),
}));

const out = {
  version: 1,
  description:
    "Merkle fixtures shared by programs/vicinity-rewards/src/merkle.rs and sdk/merkle.mjs. Both must reproduce every root, every proof and every leaf hash exactly.",
  encoding: {
    claimant: "base58 Solana public key (32 bytes)",
    amount: "u64 as a decimal string (may exceed 2^53)",
    root: "hex, 32 bytes",
    proofs: "map from leaf index (string) to the list of sibling hashes (hex), leaf level first",
    leaf: "hex, 32 bytes",
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
  trees,
};

const target = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "merkle.json");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${target}: ${trees.length} trees, ${leafVectors.length} leaf vectors`);
