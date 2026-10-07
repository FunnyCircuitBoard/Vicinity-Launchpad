# Vicinity Rewards SDK

(The launchpad's SDK lives in `launchpad/`: start at `launchpad/index.mts`,
and see `../LAUNCHPAD.md`. This file is about the rewards program's SDK.)

Small, dependency-light helpers shared by the Anchor tests, the demo script and
(later) the Cloudflare Worker that serves claim proofs.

| file | runtime deps | purpose |
|---|---|---|
| `merkle.mjs` | `node:crypto` only | leaf encoding, sorted-pair node hashing, tree build, proofs, verification, pro-rata allocation |
| `merkle.test.mjs` | node:test | vectors, edge cases, cross-check of both fixture files (`npm run sdk-test`) |
| `gen-fixtures.mjs` | - | writes `fixtures/merkle-js.json` with this SDK (`npm run sdk-fixtures`, which also runs `fixtures/generate.mjs`) |
| `fixtures/generate.mjs` | `node:crypto` only | writes the canonical `fixtures/merkle.json`; shares no code with the SDK or the program |
| `pda.mjs` | `@solana/web3.js` | PDA derivation with the exact seeds of the spec (registry, config, vault, epoch, claim status, and the program's ProgramData address) |
| `client.ts` | `@coral-xyz/anchor` | instruction builders with every account resolved (one place for tests, demo and Worker); `policy()` reads the enforced constants from the IDL; `effectiveDeadline()` mirrors the program's pause-extended deadline; `upgradeAuthorityOf()` reads a ProgramData account; `founderWarnings()` / `founderAccountWarnings()` say why a founder address may never be able to spend its share (the Worker shows them before `init_city` and `set_founder`) |
| `idl/vicinity_rewards.json` | - | the program IDL, copied here by `anchor build` (see the workspace README) |

The Worker imports `merkle.mjs` (and may import `pda.mjs`). `merkle.mjs` needs the
`nodejs_compat` compatibility flag in `wrangler.jsonc` because it uses
`node:crypto`'s `createHash` (synchronous SHA-256).

## Hashing (byte exact, PROGRAM-SPEC.md section 3)

```
leaf = sha256( 0x00 || index: u32 LE || claimant: 32 bytes || amount: u64 LE )   (45 bytes hashed)
node = sha256( 0x01 || min(left, right) || max(left, right) )                      (sorted pair)
```

* `index` is the leaf's position in the snapshot (0-based). The on-chain
  `leaf_index` is this number. `buildTree` assigns it from array position and
  rejects an explicit `index` that disagrees.
* `min/max` is the lexicographic comparison of the two 32-byte hashes as
  unsigned bytes (`compareBytes`). Because pairs are sorted, a proof carries no
  direction bits: the verifier folds `node = hashNode(node, proof[i])`.
* The 0x00 / 0x01 prefixes separate leaves from inner nodes (second-preimage
  protection). `merkle.test.mjs` has a test that an inner node presented as a
  leaf does not verify.
* Proofs longer than 32 elements are rejected (`MAX_PROOF_LEN`); the program has
  the same cap.

### Odd layers: promote the last node unchanged

When a layer has an odd number of nodes, the last node is carried up to the next
layer **as is** (it is not hashed with a copy of itself, and nothing is
duplicated). Consequences, which the Rust `merkle.rs` MUST share:

* Tree of 3 leaves `L0 L1 L2`: layer 1 is `[node(L0,L1), L2]`, root is
  `node(node(L0,L1), L2)`.
* Proof lengths differ between leaves of the same tree: `L2` has a 1-element
  proof, `L0` has 2. The verifier does not care; it only folds.
* A 1-leaf tree has root == leaf hash and an empty proof.
* `depth = ceil(log2(n))`; 2,000 leaves -> depth 11; a proof is never longer
  than `depth`.

The Rust reference builder in `programs/vicinity-rewards/src/merkle.rs`
(`reference::build_levels`, test-only; the program itself only verifies) uses the
same rule, and two fixture files of one shape (`fixtures/README.md`) pin it:

* `fixtures/merkle.json`: written by `fixtures/generate.mjs`, a dependency-free
  script that shares no code with this SDK or the program. 20 trees of 1 to 129
  leaves plus leaf vectors.
* `fixtures/merkle-js.json`: written by `gen-fixtures.mjs` with this SDK's own
  `buildTree`/`getProof`. 20 trees of sizes 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17,
  31, 32, 33, 64, 100, 127, 128, 129, 257, 5 leaf vectors and 5 node vectors.

BOTH files are read by `cargo test` (`merkle.rs::fixtures_match_the_sdk`) AND by
`npm run sdk-test` (`merkle.test.mjs`): every root, every listed proof, every
depth and every leaf hash must reproduce on both sides, so the program, the SDK
and the independent generator are pinned to one construction. `npm run
sdk-fixtures` regenerates both files; the result must equal what is committed
(CI checks `git diff` after regenerating). One deliberate difference in
validation only: `hashLeaf`/`encodeLeaf` are pure like the Rust `leaf_hash`
(they encode an amount of 0; the canonical fixture has such a vector), while
`buildTree` refuses amount 0, duplicates and bad indices.

## API (`merkle.mjs`)

```js
import { buildTree, getProof, verifyProof, hashLeaf, claimArgs, allocateProRata, ZERO_ROOT } from "./merkle.mjs";

const tree = buildTree([{ claimant: "<base58 or 32 bytes>", amount: 123n }, ...]);
tree.root        // Uint8Array(32)  -> fund_epoch(merkle_root)
tree.numLeaves   // -> fund_epoch(num_leaves)
tree.total       // BigInt, sum of amounts; must be <= holders_amount of the epoch
const { index, amount, proof } = claimArgs(tree, i);   // -> claim(epoch_index, index, amount, proof)
verifyProof(tree.root, hashLeaf(index, claimant, amount), proof) // true
```

Amounts are `BigInt` base units (also accepted: safe integers, decimal strings,
Anchor `BN`). Claimants are 32 bytes, a base58 string or a web3.js `PublicKey`.
Rejected with a thrown `Error`: duplicate claimants, amount 0 or > u64, bad index,
empty trees.

`allocateProRata(balances, total)` implements the off-chain rule of spec section 6:
`floor(balance * total / sum)`, dust stays in the vault (becomes carry-over),
holders that round to 0 get no leaf. Eligibility filtering (minimum balance,
exclusions) happens BEFORE calling it and is a PRODUCT DECISION.

## PDAs (`pda.mjs`)

```js
import { setProgramId, deriveConfig, deriveVault, deriveEpoch, deriveClaim, deriveCity } from "./pda.mjs";
setProgramId(idl.address);
const { config, vault } = deriveCity(cityCoinMint);
const epoch = deriveEpoch(config, 0).address;          // ["epoch", config, u64 LE]
const claim = deriveClaim(epoch, claimant).address;    // ["claim", epoch, claimant]
```

Seeds: `["city", city_coin_mint]`, `["vault", config]`, `["epoch", config, index u64 LE]`,
`["claim", epoch, claimant]`.
