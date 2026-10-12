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

## Deployed on mainnet (10 October 2026, by the owner from his Mac)

Checked from the chain afterwards (`solana program dump` + SHA-256, and the programdata account's authority field):

| program | on-chain bytes | upgrade authority |
|---|---|---|
| `AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai` (launchpad) | SHA-256 `32906e19…c1621a` = the file above | `AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X` (Squads vault, 2 of 3) |
| `EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG` (rewards) | SHA-256 `8ab9b047…51219d` = the file above | `AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X` (Squads vault, 2 of 3) |

No leftover deploy buffers.

## Setup and trading switched on (12 October 2026)

The owner ran the one-time setup from the City coins tab of vicinity.city/admin with his admin wallet
`13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` (signatures as recorded by the site):

| step | result | signature |
|---|---|---|
| 1 rewards registry + `init_launchpad` | launchpad admin and registry admin = `13qRam…MsRiN` | `21psyK6rGNk1yD5DpYe1DH6kxe7Qofrqs37BYE7i3oTPB9EpAd2jf1KtPkDw1fUsSmKEiQ4K6HkQF4qDcNRgqB9U` |
| 2 both upgrade authorities back to the Squads vault | moved from `13qRam…MsRiN` to `AB5qB1…LFGs7X` (on 11 Oct the owner had moved them to his wallet through the Squads, because step 1 needs the upgrade authority's signature) | `3MLvnhmk9wVq4Gm4Y5ndpNjCD4GJCYik48ZCwARweDqGiGz5cLyaVaaEb9cACD9zgWjcSe8rEjtmm1ytsS1EpQ2n` |
| 3 Meteora DBC config | `EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP` (quote SOL, 85 SOL graduation, 1.25 % fee, 0.05 SOL launch fee) | `5ddd6HNfttFksTcBB1JLsFwtZ1YsiWzMfrNdyYtyV5uckVQniEAomXKLUM5K3uQ5q7djsgQ7ofypAUNFSogEeNmi` |
| 4 allow-list entry | `6voKQ4uGtc5YShMJ1a3Xf9ahb1MRf5VTWqKfdidAiY75` | `3bQQxNSbCoQ48qDn38u5gjfX78oaQMvjueqUFeQD1oWDMArcD79YQVw5fE1N3QqqXsp6TqgcCFtzxDybGkFNAD3k` |
| 5 referral (fee) accounts | SOL `FGdoiYmovw4J7sAy8a657kWH2QUSBLxup59kkfUeMHa`, $VICINITY `8f4RxfWmkSV2YkcZK6z3WETpqJU5ukuxHkeAAmWTnJGo` | (already existed) |
| 6 lookup table | `u2V4Y3KagE2nBZ1656sL4XsV3K7iAZ5C7cQV475DEZ5` (21 addresses) | `2jE1BZCxPUhtht2mdKUm4v4fUVSX4fBEnNdqGmKH9MpioNQYQVYACFFPHxmi7gLiTAazyDjpvWHHRihM3tMn1KeJ` |
| 7 Meteora partner metadata ("Vicinity") | `2be9mDcnk6rK2XVnNiTBH4JmeWWwFzmUXMSrXMS8si11` | `2anxpP4fGnN9WthdviFfofLRNTA6Ux5Z3EDenCTVi7AAmTmYSeMhuXyq63ES6WDxD7cxi84qbk8itqfnsQRsNEv3` |

Both upgrade authorities = the Squads vault again (checked on chain after step 2). The read-only preflight
(`npm run mainnet:preflight`) against that summary passed with 0 failures, and PR #59 then set
`LAUNCHPAD_DBC_CONFIGS`, `LAUNCHPAD_LOOKUP_TABLE` and `LAUNCHPAD_TRADING=on` on the live site.
