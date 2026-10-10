# Mainnet program files, 10 October 2026

The two Solana programs the owner deploys on mainnet from his own Mac (docs/MAINNET.md section 4). The site's builders never deploy and never hold the keys.

| file | program address (owner's keypair) | bytes | SHA-256 |
|---|---|---|---|
| `vicinity_launchpad.so` | `AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai` | 433,960 | `32906e19238372af42b6032275f2cceed9e998fac1a59eabad069bbeadc1621a` |
| `vicinity_rewards.so` | `EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG` | 505,864 | `8ab9b047d2c69317d7764c1dfd81bfee24bbdadea0ba605120120dc7c151219d` |

Upgrade authority after the deploy: the owner's Squads vault `AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X` (multisig `6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV`, 2 of 3).

## How they were built

* Source: `solana/` at commit `a6100db0f8afdb7d55fb8c3fd855b0d3dc71de11` (main), with exactly two lines changed:
  * `programs/vicinity-launchpad/src/lib.rs`: `declare_id!("AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai");`
  * `programs/vicinity-rewards/src/lib.rs`: `declare_id!("EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG");`
* Toolchain: Agave solana-cli 4.3.0, cargo-build-sbf 4.4.0, platform-tools v1.57, default features (no `short-windows`).
* Commands: `cargo-build-sbf --manifest-path programs/<program>/Cargo.toml --sbf-out-dir ../out -- --locked`.

## Proof that this is the code tested on devnet

The same source with the devnet addresses unchanged, built the same way in the same place, is byte for byte the program running
on devnet (`solana program dump`):

| devnet program | SHA-256 of our rebuild = SHA-256 of the devnet dump |
|---|---|
| launchpad `Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7` | `8706e3bfb1dc7b39a5790586144327267cdb5336ed34a541504723811e0e27f0` |
| rewards `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi` | `f0fbc9d53ed092210eef3f97047644d6f796d634bf11c428795ff8b0b1e509a3` |

So the mainnet files differ from the devnet-tested programs only by their own address. This is not a Docker "verifiable" build;
an auditor can reproduce it with the toolchain above, or the team can later upgrade (through the Squad) to a verifiable build.

## Rent on mainnet (10 October 2026, `solana rent`)

launchpad 2.20516704 SOL, rewards 2.57043936 SOL, plus about 0.001 SOL per program account and about 0.01 SOL of fees.
