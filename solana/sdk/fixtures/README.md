# Merkle fixtures

Two files pin the exact Merkle construction used by the on-chain program
(`programs/vicinity-rewards/src/merkle.rs`) and by the off-chain builder
(`sdk/merkle.mjs`). Both have the same shape and the same rules; they differ in
who wrote them:

| file | written by | shares code with |
|---|---|---|
| `merkle.json` | `generate.mjs` (this directory): a dependency-free script | nobody: not the program, not the SDK |
| `merkle-js.json` | `../gen-fixtures.mjs`, using the SDK's own `buildTree`/`getProof` | the SDK |

Both files are read by the Rust unit test (`cargo test`, `merkle.rs::fixtures_match_the_sdk`)
AND by the SDK test (`npm run sdk-test`, `merkle.test.mjs`). Every root, every
listed proof, every depth and every leaf hash must reproduce byte for byte on
both sides. If one of them disagrees with a file, that side is wrong; a file is
never "fixed" to match an implementation. `npm run sdk-fixtures` regenerates both
files; the result must be identical to what is committed (`git diff` is empty).

## Rules

- Hash: SHA-256.
- Leaf: `sha256(0x00 || index as u32 little endian || claimant 32 bytes || amount as u64 little endian)`.
- Node: `sha256(0x01 || min(left, right) || max(left, right))`, byte-wise comparison. A proof is therefore just the list of sibling hashes, leaf level first, with no direction bits.
- Odd level: when a level has an odd number of nodes, the last node is promoted unchanged to the next level (it is not hashed with itself and not duplicated).
- One leaf: root == leaf, proof is empty, depth 0.
- `depth = ceil(log2(n))`; a proof is never longer than `depth`, and leaves promoted through odd levels have shorter proofs.
- Proof length cap: 32 (enforced on chain before any hashing; unreachable in practice, a legacy transaction fits at most 22 elements).
- The builder must reject duplicate claimant wallets and drop zero amounts before building; the program rejects a zero-amount claim.

## File format

```json
{
  "version": 1,
  "leaf_vectors": [ { "index": 7, "claimant": "<base58>", "amount": "<u64 decimal string>", "leaf": "<hex 32 bytes>" } ],
  "node_vectors": [ { "a": "<hex>", "b": "<hex>", "node": "<hex>" } ],
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

- `claimant` is a base58 Solana public key (the Rust side parses it with `Pubkey::from_str`).
- `amount` is a decimal string because u64 values exceed JavaScript's safe integer range (the 7-leaf tree contains `1` and `18446744073709551615`).
- `leaves` are listed in index order; `index` always equals the position.
- `proofs` is keyed by the leaf index as a string. Trees with up to 64 leaves list every proof; larger trees list a sample.
- `node_vectors` is optional (only in `merkle-js.json`); the Rust reader ignores it.
- `description`, `encoding` and `rules` are documentation for humans and are not checked.

## Trees

`merkle.json`: 20 trees with 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 31, 32, 33, 63, 64, 65 and 129 leaves.
`merkle-js.json`: 20 trees with 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 64, 100, 127, 128, 129 and 257 leaves.
The odd sizes exercise the promoted-node rule at several depths; 1 covers the empty proof.

Claimants and amounts are deterministic (SHA-256 of fixed labels), so both files can be regenerated bit for bit.
