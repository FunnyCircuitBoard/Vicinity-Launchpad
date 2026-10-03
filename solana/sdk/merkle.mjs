// Vicinity Rewards: Merkle tree for holder reward snapshots.
//
// This file is the off-chain twin of programs/vicinity-rewards/src/merkle.rs.
// Both MUST produce identical roots for sdk/fixtures/*.json. Byte layout
// (PROGRAM-SPEC.md section 3):
//
//   leaf = sha256(0x00 || index: u32 LE || claimant: 32 bytes || amount: u64 LE)
//   node = sha256(0x01 || min(left, right) || max(left, right))      (sorted pair)
//
// Odd layers: the last node is promoted to the next layer UNCHANGED (it is not
// hashed with itself and not duplicated). A proof therefore has one element per
// layer in which the node had a sibling; the verifier simply folds the proof
// into the leaf hash, so it never needs direction bits or the tree shape.
//
// Only node:crypto is imported so a Cloudflare Worker (nodejs_compat) can use it.

import { createHash } from "node:crypto";

export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;
export const LEAF_LEN = 1 + 4 + 32 + 8;
export const MAX_PROOF_LEN = 32;
export const U32_MAX = 0xffffffff;
export const U64_MAX = (1n << 64n) - 1n;
export const ZERO_ROOT = new Uint8Array(32);

// ---------------------------------------------------------------------------
// bytes helpers

export function sha256(...parts) {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("fromHex: not a hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Lexicographic (unsigned byte) comparison; this is what "min/max" means for nodes.
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// Minimal base58 (Bitcoin alphabet) so claimants can be given as wallet strings
// without pulling @solana/web3.js into the Worker.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

export function fromBase58(str) {
  if (typeof str !== "string" || str.length === 0) throw new Error("fromBase58: empty");
  let n = 0n;
  for (const c of str) {
    const v = B58_MAP.get(c);
    if (v === undefined) throw new Error("fromBase58: bad character");
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  bytes.reverse();
  let leading = 0;
  for (const c of str) {
    if (c !== "1") break;
    leading++;
  }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes, leading);
  return out;
}

export function toBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// input normalisation

export function toClaimantBytes(claimant) {
  let bytes;
  if (typeof claimant === "string") {
    bytes = fromBase58(claimant);
  } else if (claimant && typeof claimant.toBytes === "function") {
    bytes = new Uint8Array(claimant.toBytes()); // web3.js PublicKey duck-typing
  } else if (claimant instanceof Uint8Array) {
    bytes = claimant;
  } else if (Array.isArray(claimant)) {
    bytes = Uint8Array.from(claimant);
  } else {
    throw new Error("claimant must be 32 bytes, a base58 string or a PublicKey");
  }
  if (bytes.length !== 32) throw new Error(`claimant must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

// Amounts are u64 base units. Accept bigint, safe integer or decimal string; reject 0.
export function toAmount(amount) {
  let v;
  if (typeof amount === "bigint") v = amount;
  else if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount)) throw new Error("amount must be an integer (use BigInt above 2^53)");
    v = BigInt(amount);
  } else if (typeof amount === "string") {
    if (!/^[0-9]+$/.test(amount)) throw new Error("amount string must be decimal digits");
    v = BigInt(amount);
  } else if (amount && typeof amount.toString === "function" && amount.constructor && amount.constructor.name === "BN") {
    v = BigInt(amount.toString()); // bn.js from Anchor
  } else {
    throw new Error("amount must be bigint, integer or decimal string");
  }
  if (v <= 0n) throw new Error("amount must be > 0");
  if (v > U64_MAX) throw new Error("amount exceeds u64");
  return v;
}

export function toIndex(index) {
  if (typeof index === "bigint") index = Number(index);
  if (!Number.isInteger(index) || index < 0 || index > U32_MAX) {
    throw new Error("index must be an integer in [0, 2^32-1]");
  }
  return index;
}

// ---------------------------------------------------------------------------
// leaf / node hashing

// 0x00 || u32 LE index || 32 bytes claimant || u64 LE amount  (45 bytes)
export function encodeLeaf(index, claimant, amount) {
  const i = toIndex(index);
  const c = toClaimantBytes(claimant);
  const a = toAmount(amount);
  const out = new Uint8Array(LEAF_LEN);
  const view = new DataView(out.buffer);
  out[0] = LEAF_PREFIX;
  view.setUint32(1, i, true);
  out.set(c, 5);
  view.setBigUint64(37, a, true);
  return out;
}

export function hashLeaf(index, claimant, amount) {
  return sha256(encodeLeaf(index, claimant, amount));
}

export function hashNode(a, b) {
  if (a.length !== 32 || b.length !== 32) throw new Error("hashNode: nodes must be 32 bytes");
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Uint8Array.of(NODE_PREFIX), lo, hi);
}

// ---------------------------------------------------------------------------
// tree

// leaves: [{ claimant, amount, index? }] in leaf-index order. If `index` is given
// it must equal the array position (the on-chain leaf index IS the position).
// Rejects duplicate claimants, amount 0, amount > u64, more than 2^32 leaves.
export function buildTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error("buildTree: need at least one leaf");
  if (leaves.length > U32_MAX + 1) throw new Error("buildTree: too many leaves");
  const seen = new Map();
  const normalized = [];
  const leafHashes = [];
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i];
    if (l.index !== undefined && toIndex(l.index) !== i) {
      throw new Error(`buildTree: leaf at position ${i} carries index ${l.index}`);
    }
    const claimant = toClaimantBytes(l.claimant);
    const amount = toAmount(l.amount);
    const key = toHex(claimant);
    if (seen.has(key)) {
      throw new Error(`buildTree: duplicate claimant at index ${seen.get(key)} and ${i}`);
    }
    seen.set(key, i);
    normalized.push({ index: i, claimant, amount });
    leafHashes.push(hashLeaf(i, claimant, amount));
  }
  const layers = [leafHashes];
  let layer = leafHashes;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) next.push(hashNode(layer[i], layer[i + 1]));
      else next.push(layer[i]); // odd layer: promote the last node unchanged
    }
    layers.push(next);
    layer = next;
  }
  return {
    root: layer[0],
    layers,
    leafHashes,
    leaves: normalized,
    depth: layers.length - 1,
    numLeaves: normalized.length,
    total: normalized.reduce((s, l) => s + l.amount, 0n),
  };
}

export function getProof(tree, index) {
  const i = toIndex(index);
  if (i >= tree.numLeaves) throw new Error("getProof: index out of range");
  const proof = [];
  let idx = i;
  for (let d = 0; d < tree.layers.length - 1; d++) {
    const layer = tree.layers[d];
    const sibling = idx ^ 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    idx >>= 1;
  }
  return proof;
}

// Pure fold; mirrors the on-chain verifier. `leaf` is the 32-byte leaf hash.
export function verifyProof(root, leaf, proof) {
  if (proof.length > MAX_PROOF_LEN) return false;
  let node = leaf;
  for (const p of proof) node = hashNode(node, p);
  return bytesEqual(node, root);
}

// Convenience for a claim: everything the claim instruction needs for one leaf.
export function claimArgs(tree, index) {
  const leaf = tree.leaves[toIndex(index)];
  if (!leaf) throw new Error("claimArgs: index out of range");
  return { index: leaf.index, claimant: leaf.claimant, amount: leaf.amount, proof: getProof(tree, index) };
}

// ---------------------------------------------------------------------------
// off-chain allocation (spec section 6): pro-rata by balance, floor, dust stays
// in the vault as carry-over. Holders rounding to 0 get no leaf.
// balances: [{ claimant, balance: bigint }], total: bigint -> { leaves, dust }
export function allocateProRata(balances, total) {
  const t = toAmount(total);
  let sum = 0n;
  for (const b of balances) {
    const v = BigInt(b.balance);
    if (v < 0n) throw new Error("allocateProRata: negative balance");
    sum += v;
  }
  if (sum === 0n) throw new Error("allocateProRata: no balances");
  const leaves = [];
  let allocated = 0n;
  for (const b of balances) {
    const amount = (BigInt(b.balance) * t) / sum;
    if (amount > 0n) {
      leaves.push({ claimant: toClaimantBytes(b.claimant), amount });
      allocated += amount;
    }
  }
  return { leaves, dust: t - allocated, allocated };
}

// JSON-friendly tree export (hex), used by fixtures and by the snapshot file.
export function serializeTree(tree, proofIndices = []) {
  return {
    numLeaves: tree.numLeaves,
    depth: tree.depth,
    root: toHex(tree.root),
    leaves: tree.leaves.map((l) => ({ index: l.index, claimant: toHex(l.claimant), amount: l.amount.toString() })),
    leafHashes: tree.leafHashes.map(toHex),
    proofs: proofIndices.map((i) => ({ index: i, proof: getProof(tree, i).map(toHex) })),
  };
}
