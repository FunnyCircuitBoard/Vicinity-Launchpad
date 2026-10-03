# Merkle fixtures

`merkle.json` pins the exact Merkle construction used by the on-chain program
(`programs/vicinity-rewards/src/merkle.rs`) and by the off-chain builder
(`sdk/merkle.mjs`). Both sides have a test that reads this file and must
reproduce every root, every proof and every leaf hash byte for byte. If one of
them disagrees with the file, that side is wrong; the file is never "fixed" to
match an implementation.

## Rules

- Hash: SHA-256.
- Leaf: `sha256(0x00 || index as u32 little endian || claimant 32 bytes || amount as u64 little endian)`.
- Node: `sha256(0x01 || min(left, right) || max(left, right))`, byte-wise comparison. A proof is therefore just the list of sibling hashes, leaf level first, with no direction bits.
- Odd level: when a level has an odd number of nodes, the last node is promoted unchanged to the next level (it is not hashed with itself).
- One leaf: root == leaf, proof is empty.
- Proof length cap: 32 (enforced on chain before any hashing).
- The builder must reject duplicate claimant wallets and drop zero amounts before building; the program rejects a zero-amount claim.

## File format

```json
{
  "version": 1,
  "leaf_vectors": [ { "index": 7, "claimant": "<base58>", "amount": "<u64 decimal string>", "leaf": "<hex 32 bytes>" } ],
  "trees": [
    {
      "name": "7-leaves",
      "leaves": [ { "index": 0, "claimant": "<base58>", "amount": "<u64 decimal string>" } ],
      "root": "<hex 32 bytes>",
      "depth": 3,
      "proofs": { "0": ["<hex>", "<hex>", "<hex>"], "1": ["..."] }
    }
  ]
}
```

- `claimant` is a base58 Solana public key.
- `amount` is a decimal string because u64 values exceed JavaScript's safe integer range (the 7-leaf tree contains `1` and `18446744073709551615`).
- `leaves` are listed in index order; `index` always equals the position.
- `proofs` is keyed by the leaf index as a string. Trees with up to 64 leaves list every proof; larger trees list a sample.

## Trees

20 trees with 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 31, 32, 33, 63, 64, 65 and 129 leaves. The odd sizes exercise the promoted-node rule at several depths; 1 covers the empty proof.

Claimants and amounts are deterministic (SHA-256 of a fixed label), so the file can be regenerated bit for bit. The generator is a dependency-free Node script that shares no code with either implementation.
