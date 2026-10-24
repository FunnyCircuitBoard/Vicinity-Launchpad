# `vicinity_curve`: rehearsal D01 (the `devnet` build)

The record of test D01 of VICINITY-CURVE-DESIGN.md 12.5: the `devnet` build of `vicinity_curve`
deployed at its throwaway program id and taken through its whole life with throwaway keys, the
owner's tools run against it, and every measured figure compared with the specification.
Nothing here is mainnet: no mainnet key, RPC or account was used. No fee value or fee-share
rule changed and the program binary did not change (the production build is still sha256
`0a5beef2...`, as since review round 6). Run on 23 October 2026, from 09:20 to 21:45 UTC; corrected
on 24 October 2026 after a review of this record and of the audit pack (`VICINITY-CURVE-AUDIT.md`
section 8 lists its items).

**What this record is.** Every signature, slot and account below belongs to a local validator, not
to devnet: none can be looked up on any public cluster, and that validator's ledger, pruned during
the run, was not kept. What is kept is in `rehearsals/vicinity-curve-d01/` (section 12): the
driver as run, every transaction's record as read soon after it landed and every output of the
owner's tools. Read the figures as a record of what the run measured, not as evidence a third
party can check on a chain; section 10 says what running D01 on devnet itself needs.

## In one minute (for the owner)

* **Where it ran: not on devnet itself.** A program account for this binary costs 3.750 SOL of
  rent on devnet (738,109 bytes at devnet's 5,080 lamports per byte). The throwaway keys made for
  D01 hold nothing, the public devnet faucet answered every request of this run with "airdrop
  limit reached today", and every proof-of-work faucet was empty (section 1). The only devnet SOL
  at hand (2.30 SOL) belongs to the throwaway deployer of the old devnet programs; and on devnet
  the `devnet` build can approve and launch only after that same key pauses the old devnet
  program's launches and hands its admin and the rewards registry's admin to the new admin
  (8.5). Using that key on devnet changes the deployments LAUNCHPAD-DEVNET.md records, and this
  run's permission policy refused it as a change to shared resources. Both need the owner
  (section 10 says what to do).
* **So D01 ran on the closest setup that needs neither:** a local validator (Agave 4.3.0) that
  copied from devnet, at the start of the run, devnet's feature set and every program and account
  the `devnet` build reads: the old `vicinity_launchpad` with its `Launchpad` and both its configs,
  `vicinity_rewards` with its registry, Metaplex, and Squads v4 with its program config. The binary
  is the `devnet` build of this commit (sha256 `d052b8fc...`, read back from that validator byte
  for byte) at the throwaway id `nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk`. Every step went through
  the real programs with real signatures, fees and compute meters, and the 12-hour review window
  was waited out in real time. The deploy checklist and the batch monitor's check were also run,
  read-only, against devnet itself through two providers (section 7.4).
* **Rehearsed, all with the throwaway keys of `solana-keys/devnet-d01/`:** every item of 12.5's
  D01 on a local copy of devnet (the table below), except devnet itself, the site's list and the
  monitor process: the per-city and the batch paths, a graduation, buybacks on the curve and
  in the pool, every outflow, a guardian stop and a guardian clear through a real Squads v4 vault
  by `guardian-stop.mjs`, the admin's recovery and rotation of the launch approver, two launches
  from a published batch after the real 12-hour window, and the owner's tools (`preflight.mjs`,
  `batch.mjs verify`, `confirm` and `check`) on two RPC addresses.
* **No program defect and no tool defect was found**, so nothing needed a fix. One documentation point:
  a guardian stop can execute more than once on a quiet chain (four times here, not twice as NOTES
  87 said; up to `--variants` per RPC view), at about 0.0041 SOL of Squads rent for each extra
  execution at mainnet's and devnet's 5,080 lamports per byte (0.0056 SOL at this validator's 6,960;
  section 8, item 5). Every measured
  compute figure is inside its 11.1 budget and within a few hundred units of the litesvm
  measurement of the same gate run wherever the inputs are the same; the differences have known
  causes (section 8): devnet's Metaplex is another binary than mainnet's (its metadata account is
  607 bytes, not 679), and so is devnet's Squads v4 (section 1), the `devnet` build derives other addresses (other bump searches), and this
  validator charges litesvm's 6,960 lamports of rent per byte, not devnet's 5,080.
* **Not reached** (section 9): devnet itself; the website's batch page and the monitor process
  (both not built yet, 14.1), hence neither "the site's list" itself nor `verify --tx`; two RPCs
  that are two providers serving two nodes (here two addresses of one node).

## What D01 asks for, and where it is

| 12.5 D01 | done | section |
|---|---|---|
| a throwaway program key, the `devnet` build | `nhgCm...` (the localnet and devnet throwaway key of 3.1), the `devnet` build of `npm run vcurve:sbf`, deployed with `solana program deploy` and read back byte for byte | 3 |
| init, config #0 | `init_launchpad` with the guardian; config #0 with 5.9's integers; a demonstration config #1 with config #0's five shares and launch fee and a graduation of 1 SOL | 6.2 |
| approve, launch | `approve_launch` by the admin after 8.5's hand-over; `launch` with the founder's token account and first buy in one transaction | 6.1, 6.4 |
| trade to graduation | curve buys and sells; the completing buy capped by the SDK and partially filled; pool trades and the drip | 6.4, 6.6 |
| buybacks, forwards, claims, withdrawals | buybacks on the curve and in the pool (one during a buy halt), forwards to the city's `vicinity_rewards` WSOL vault (created by `init_city`), claims, withdrawals, a payout opt-in, a payout and its 24-hour cooldown | 6.5 to 6.7 |
| guardian halt | `guardian-stop.mjs --halt-buys --pause-launches` through the guardian's Squads vault; buys refused, sells, claims, withdrawals and buybacks working; the guardian unable to resume; the buyback halt's order; the admin's recovery | 6.8 |
| addresses recorded | sections 2, 4 and 11 | 2, 4, 11 |
| the batch approval: a throwaway approver key | set after the checklist's `--proposed-launch-approver` | 6.2 |
| one batch through the site's list, the verifier and the monitor | the list built with the SDK the site will use (`buildLaunchBatch`, `launchBatchFile`; the batch page itself is not built); `batch.mjs verify` through two RPC addresses, the approver signing the verifier's own transaction, `confirm`, `check` (the monitor's comparison; the monitor process is not built) | 6.3 |
| a launch from it after the window | refused before `valid_from`; after it, one launch, and one refused while a per-city approval was pending and launched once the admin revoked it | 6.9 |
| a clear | the guardian's clear with halt (`guardian-stop.mjs --clear`), a publication then refused, the admin's rotation of the approver, a new publication | 6.10 |

## 1. Why devnet itself was not reached

| what | finding |
|---|---|
| the program account on devnet | `solana rent 738109 -u devnet`: 3.75024396 SOL (5,080 lamports per byte); the deploy also pays about 740 buffer-write transactions |
| the D01 keys | made for this run under `solana-keys/devnet-d01/` (never printed, never committed); every balance 0 |
| the public faucet | `requestAirdrop` of 1, 0.5 and 0.1 SOL through `api.devnet.solana.com`, to four of the keys: each answered `429 You've either reached your airdrop limit today or the airdrop faucet has run dry`. A background loop then asked once per round for the admin key, 15 minutes apart and doubling to an hour, for the rest of the run: every answer was the same (section 9) |
| other providers | `solana-devnet.gateway.tatum.io` and `solana-devnet.api.onfinality.io/public` serve devnet (genesis `EtWTRABZ...`) but refuse `requestAirdrop`; Ankr, dRPC and Helius need an account; `faucet.solana.com` asks AI agents not to use its web faucet and names the CLI, the proof-of-work faucet or a local validator instead |
| the proof-of-work faucet | `devnet-pow get-all-faucets`: 23 faucets, all at 0 SOL but one that holds 0.9998 SOL and pays 0.0000001 SOL a proof |
| devnet SOL already in the scratchpad | 2.30 SOL in the throwaway deployer of the old devnet programs (`9pYCvdmi...`, LAUNCHPAD-DEVNET.md): less than the program account, and moving it, or signing the hand-over below with that key on devnet, was refused by this run's permission policy as a change to shared devnet deployments |
| the `devnet` build's own precondition | its compiled ids (3.2) make `approve_launch` and `launch` read the old devnet program's `Launchpad` (`ppX3a7oU...`: admin `9pYCvdmi...`, launches open, both configs enabled) and the devnet rewards registry (`2rKKwGGc...`: admin `9pYCvdmi...`). Until that key pauses the old launches and hands both admin seats to this program's admin (8.5), every approval and launch on devnet fails (`LegacyLaunchesOpen`, `LegacyAdminMismatch`, `RewardsRegistryAdminMismatch`), whatever SOL there is. The deploy checklist, run read-only against devnet, lists exactly these (section 7.4) |

The setup used instead: `solana-test-validator` of Agave 4.3.0 with `--clone-feature-set`
from devnet and these copies, taken from devnet at 09:25 UTC on 23 October:

| copied from devnet | address |
|---|---|
| the old `vicinity_launchpad` (program and ProgramData; upgrade authority `9pYCvdmi...`) | `Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7` |
| its `Launchpad` (171 bytes; admin `9pYCvdmi...`, launches open) | `ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw` |
| its two `LaunchConfig`s (both enabled) | `8pfgRZNLfftPAYF652GGPQVrjj2KgQf44AtZxfvpQ1Wa`, `GCZJQJXSaNppSVEwj88V9gHatPf28mqLhL2ttbuHT1K8` |
| `vicinity_rewards` (program and ProgramData; upgrade authority `9SzJe6zm...`) | `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi` |
| its `Registry` (admin `9pYCvdmi...`) | `2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3` |
| Metaplex Token Metadata (devnet's binary: sha256 `bb0842f6...`, 1,295,344 bytes; mainnet's pinned dump is `31f0a627...`, 793,991 bytes) | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| Squads v4 (devnet's binary: sha256 `97fb2a5c08e5df5e862d8354ac5b97d3587117f98c4457754ca12e30bef0664d`, 1,774,800 bytes, dumped from devnet on 23 October 2026 after the run; mainnet's pinned dump, which the litesvm suites and the fixes of reviews R7-1, R8 and R9 were tested against, is `dec8d3e0...`, 1,470,416 bytes) and its program config (multisig creation fee 0) | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, `BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr` |

How it differs from devnet: the guardian stops ran against devnet's Squads v4 binary, which
differs from the mainnet binary the suites pin (above); rent is 6,960 lamports per byte (the validator's default and
litesvm's), so every rent below compares with the 6,960 column of 3.3, not devnet's 5,080; the
old devnet deployer's key signed the hand-over on this copy only; the owner's tools were given
two addresses of the same validator (`127.0.0.1` and `127.0.0.2`), which their two-provider rule
accepts (two IP addresses) but which cannot disagree; one validator, not a cluster. Slots and the
Clock follow wall time, so `BUYBACK_INTERVAL_SLOTS` (150) and the 12-hour review window were
waited out as on devnet. The validator was restarted 31 times on the same ledger to bound its disk
use (`--limit-ledger-size`, and a watchdog that restarted it whenever the ledger passed 1.5 GB, never
during the batch steps); state and clock carried on, but old slots were pruned, so every
transaction's figures were read soon after it landed and kept (section 11).

## 2. Keys and roles (public keys only; throwaway, devnet-only)

| role | public key |
|---|---|
| admin, upgrade authority, deploy payer and rewards authority (stands in for the Squads vault) | `F7V1hNXCdPZMKhXJpDg3UCAiqDDzjKNJh3wEPc8A87tt` |
| guardian multisig members (1 of 2, every permission) | `H7Y5GMjA6T6MKJDPous3G1Hqz8yeeoYYKJ1i14463bmW` (member 1), `8TNyViAiqKi56vGcVoBbW2JS8FK7vmV7fymcp4VL2kqk` (member 2) |
| the multisig's create key | `HYBkFrMWZSjoaTQx9WLR3aL6XseTYtb8gD3ckregbUK7` |
| launch approver; its successor after the rotation | `FTLBdYDg92UGFkejbe7j2nM79pGytBpFzBpCcEedahmk`; `CpesEZiVVfSyRRZbQ2jMiB73csrpyFSEbtuYugeCoQXc` |
| founder A (per-city), founders B and C (the batch) | `Awhjhxa3banFpT9JkaJcsVhwTkbuTGuPXReFyqyYqhA2`; `6FnXFQY3N5EcrAoAWqPLsy6JNLoeoQ5b9GK31tuzDxME`, `FXDRMihpZsNKebVaAzaH49Ve3MoRPioxw8t15t75NgYS` |
| traders 1 and 2; the keeper (cranks) | `HKkwyfwxRZYzUCpZaPJLnjKMuNjG4goqcLCTiUX2eUDL`, `Fn5JuWpttDx4W8R1BALB2nHoiqjjqxJ7JQtFGCdfLtic`; `7hi11KrRiyadwsnhVSCdWkUJyZbe5tMurDqTpLmRE4R9` |
| payout key; payout wallet | `3NX9gfc2GNUgCtCpxfToU1K4GA9ssr4o7Lmp3onm4V2S`; `2gx1MgS7ZanZQpECNu9HkztspQ4Hwh3RXm5ezvdPyvgU` |
| the program id (the localnet and devnet throwaway key of 3.1 and 3.12) | `nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk` |
| `FEE_RECIPIENT` (compiled; receives launch fees and platform withdrawals) | `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` |

The old devnet programs' throwaway deployer `9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa`
signed only the five hand-over transactions of 6.1, on the local copy. The keys stay in the
scratchpad (`solana-keys/devnet-d01/`); none is printed here or committed.

## 3. Build and deploy

| item | value |
|---|---|
| commit | `31a460a1a46ee26e89623917db0fbfddbd3743e4` (branch `feat/vicinity-curve`), the report added on top |
| toolchain | cargo-build-sbf 4.4.0, platform-tools v1.57, rustc 1.95.0; solana-cli 4.3.0; anchor-cli 0.31.1 (`npm run vcurve:sbf`; no stack warning) |
| production build | 738,064 bytes, sha256 `0a5beef231cfcc1327d9e497bb631f7c8edc99468338daed932ddce90bba3b5b` (unchanged since review round 6) |
| `devnet` build (deployed) | 738,064 bytes, sha256 `d052b8fccf5ed0fc9bbb0ee56e4a77ae5a3ec99c6fa6c906119f51db71c18fa3` |
| `halt-all` build | 736,840 bytes, sha256 `4d631647c38230690ad57a28e49d021e0ad956a7edbc454dc107558849a0d868` |
| deploy | `solana program deploy` with the program keypair, upgrade authority the admin: signature `416huoDtv3KedS7dqnppKAZ3cpDQN9VCUchqAdRFAB85sPYKzLZXbZFgjba9dWGFQFZSwJgEm3sQwepoQsuu61oF`, slot 713, 5 seconds on the local validator (the signature exists only there, as every signature of this file) |
| read back | `solana program dump` of `nhgCm...` from the local validator (not devnet, where `nhgCm...` does not exist): the first 738,064 bytes equal the `devnet` build (sha256 `d052b8fc...`), the rest zero; ProgramData `FtcYmShKCGsKWHqXuWtBkCtn1b23BSTavCYunsm2w6we`, 738,109 bytes, 5,138,129,520 lamports (3.750 SOL on devnet's rate) |
| compiled ids of the `devnet` build | the old program `Fncx4qBh...`, its `Launchpad` `ppX3a7oU...`, `vicinity_rewards` `Hm14pFPA...`, its registry `2rKKwGGc...` (3.2); every approval, launch and forward below read these accounts |

## 4. Accounts

| account | address | bytes | lamports | owner |
|---|---|---|---|---|
| vicinity_curve program (devnet build) | `nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk` | 36 | 1,141,440 | upgradeable loader |
| its ProgramData | `FtcYmShKCGsKWHqXuWtBkCtn1b23BSTavCYunsm2w6we` | 738,109 | 5,138,129,520 | upgradeable loader |
| Launchpad | `6PRJktVEFMaLXtxhpoX9TWpCADJqjz12qdzEmX4yd3EQ` | 238 | 2,547,360 | vicinity_curve |
| LaunchConfig #0 | `BpQCBxQh6pem3X3NvvYXWkvrPfUskZezMPDHdY8senf4` | 144 | 1,893,120 | vicinity_curve |
| LaunchConfig #1 | `38fMscgwvg6dvJCKAHbrs36XWjonYGeQiUe11Hv9amsb` | 144 | 1,893,120 | vicinity_curve |
| LaunchBatch | `pEpPMQyK3c2Kh9CTVDcd2xeAFHi2BmKycsLd74ZuoZt` | 260 | 2,700,480 | vicinity_curve |
| guardian Squads multisig | `BXDJioxLKY46h4yv4LMp5PdQwuP6vkWAdkWAAhFU27iw` | 198 | 2,268,960 | Squads v4 |
| guardian (vault 0) | `EEEyKiw7LygjZCFF6NE3cCTrEqf2Zt27DSY73GQfUvc8` | | 0 | no account |
| event authority | `2TjmF9XGLFpVSg6hhERfCTXbfq73ZwyzBA5GcweAD4Yq` | | 0 | no account |
| the lookup table (11.3) | `4Br5NxK4jmZq7yEFEaDaHRrAzGNAWrB2wYKkV7UpEU3S` | 536 | 4,621,440 | Address Lookup Table |
| D01A (990000001): Coin | `Ft6oprTizn4BvZrZrk9ibVZcwhyVuX1MdQhvTDrWCJyb` | 693 | 490,205,547 | vicinity_curve |
| D01A: mint | `J25KL9E5K7Hp5cxRH75EqzAbtNZVdMWX8frJCtRaKTbr` | 82 | 1,461,600 | Token |
| D01A: coin vault | `6pgU9CVGBgw1DuDbuYeSqKsqzS3jexkWK7XbxFfUXqyf` | 165 | 2,039,280 | Token |
| D01A: TickerLock D01A | `HBQtnmepen9bVwfx1E71JjoeotU8o5tsh6bYmmuf7A2F` | 49 | 1,231,920 | vicinity_curve |
| D01A: Metaplex metadata | `FHB9eTg3USTG4EoMTThP1SAFE4REXWxvuyr4cgQDcbw6` | 607 | 15,115,600 | Metaplex |
| D01A: PayoutOptIn | `DxztEAHicbogeXuC2iV7ctpeg7gzbqZmg5YfX4agGQs4` | 145 | 1,900,080 | vicinity_curve |
| D01A: Approval (closed at launch) | `An4waGzrkVk12ddmT9XfefDs4Br3ht6ghFLECu56W9b7` | | 0 | no account |
| D01A: vicinity_rewards CityConfig | `E28PhM4h8snKkxPs6r65t21knbUJmEX9X9BY1HrqVjmQ` | 303 | 2,999,760 | vicinity_rewards |
| D01A: vicinity_rewards WSOL vault | `Cw9bHEguXkhooBiCggZBFVc98jwUcHLhwMV9gfbXmace` | 165 | 12,347,668 | Token |
| D01A: liability check (I9) | | | | lamports 490,205,547 = liabilities 484,491,387 + `rent_reserve` 5,714,160 |
| D01B (990000002): Coin | `7vXAwbwXmCUQGXRq5Jk4AaBViQ2RhawmWY1VRhQ7yHKA` | 693 | 30,651,660 | vicinity_curve |
| D01B: mint | `CKfKNaYYiD5YqTfAHsmtytyEiKCRB2EyHFVY6miKQgX` | 82 | 1,461,600 | Token |
| D01B: coin vault | `6EpnAwR72ZhWc7QPdusguk3FySsbpo7WKEpQJw85HeZG` | 165 | 2,039,280 | Token |
| D01B: TickerLock D01B | `5T9w2mXJdUiJRooyxwd4GBdRDGFkkhMxvDf6md1hbScH` | 49 | 1,231,920 | vicinity_curve |
| D01B: Metaplex metadata | `AQKBzWgtAzfao3mh3aQ18HGhNzpex99p1GyuxLPQvQKi` | 607 | 15,115,600 | Metaplex |
| D01B: PayoutOptIn | `5v1stsSLaUNiNtdihjZed4AncXiM5t4XQuyVc2Ntw3Q2` | | 0 | no account |
| D01B: Approval (closed at launch) | `9ui56YpNA7xLQeuTiXVBkXUBdCdbNESQygHYcndTtLRP` | | 0 | no account |
| D01B: vicinity_rewards CityConfig | `7xmtqc7auugTfPUDqRxLtD68XxVowzijmmcuGXVsuKm2` | | 0 | no account |
| D01B: vicinity_rewards WSOL vault | `4DdYVSgfGCG7ixa9aUDhc3YjDXwfybdyvFBCXqoooBaC` | | 0 | no account |
| D01B: liability check (I9) | | | | lamports 30,651,660 = liabilities 24,937,500 + `rent_reserve` 5,714,160 |
| D01C (990000003): Coin | `DUNEvJr7boJZimJwTXcb2AWDmWnRcCWbVMQms2aDDhGR` | 693 | 25,714,160 | vicinity_curve |
| D01C: mint | `9eeBrKjZD5rGHKcNVxzuBZuJj2Sm1RmFhSad1N8kJGBg` | 82 | 1,461,600 | Token |
| D01C: coin vault | `9cJzQfDHpDhakqJGDWMbUvJsGaAFBGkCJx6rHgvxWvfF` | 165 | 2,039,280 | Token |
| D01C: TickerLock D01C | `8cx8oPzZBurBfEWPHerWsoqEuahuGJUBFY4hS5phN9W` | 49 | 1,231,920 | vicinity_curve |
| D01C: Metaplex metadata | `FDVYKjbPPrcBMeo4EbnrNSn6fnuir3E5tydmd5WX9hpT` | 607 | 15,115,600 | Metaplex |
| D01C: PayoutOptIn | `FzhFMwip7jso81aPjZHb12vdpGD7bKKhNvTzdhn2QSwH` | | 0 | no account |
| D01C: Approval (closed at launch) | `DvWFrq2LQWjRGJHRBc81avD6yppfqgTHLdTqdYpwUCVJ` | | 0 | no account |
| D01C: vicinity_rewards CityConfig | `ET2NztEdS4CcuvyHDTqpSss4BzJ6vg9HAj8WgKMnM2K8` | | 0 | no account |
| D01C: vicinity_rewards WSOL vault | `G47tibvTnqqvBcnRyuAYGk6voeez3GaETRaz5g5oag9U` | | 0 | no account |
| D01C: liability check (I9) | | | | lamports 25,714,160 = liabilities 20,000,000 + `rent_reserve` 5,714,160 |

The guardian multisig's vault transactions and proposals (Squads v4). The first stop's two refused
variants created nothing, so the clear's variants took indices 3 to 6:

| index | vault transaction | bytes / lamports | proposal | bytes / lamports | what |
|---|---|---|---|---|---|
| 1 | `E7VDfDWqTWhhgkzLt5mnyc1bZnwt6HboSAQmhopKnGRn` | 223 / 2,442,960 | `o4pcnzF32JqNWZZ9DWdpBjwpA6tvngEr4RctrxpLBMr` | 262 / 2,714,400 | the stop (member 1), executed |
| 2 | `7ZsULZvdpghexj8rnXtNAaZuWKzmJCYFqg7cLhGejW8z` | 223 / 2,442,960 | `6KpfZ3AMgU9fYBDktUPQETGAvduHN4GLF1mV6V6eUsGn` | 262 / 2,714,400 | the stop's second variant, executed |
| 3 | `9j1JTpbmt9MECxbpFNY9YKXkGJgnqQXp5PwPPgiFKtJU` | 285 / 2,874,480 | `EKB2XUfzQv86MLRdsubaCaNGVfAdM5RSDZsx9joKKaBQ` | 262 / 2,714,400 | the clear (member 2), executed |
| 4 | `93dq3pZMCgaahxACPa7GFbFUDCdDPYEkkEavBGGM6DEh` | 285 / 2,874,480 | `4FvnSppyuP6MXBPntBAR4YRx1nkZGkHsvbCYt6FBsBTB` | 262 / 2,714,400 | the clear's second variant, executed |
| 5 | `4gmTw858thKm4HkSR3Br2mTq111dDfBS9EGn6qXE43bW` | 285 / 2,874,480 | `8QChDu7YXUVKL3kDFRCHPK7G4xmsy3sVK4nT7fq3HLno` | 262 / 2,714,400 | the clear's third variant, executed |
| 6 | `DSxeYx12w66Hua9yn5JrTLKTUUcuqjKJuehr2kByKHfu` | 285 / 2,874,480 | `9MYEJae7ywXBjysAekBSXrE9sKGio79LtcrAzy8ax7Kn` | 262 / 2,714,400 | the clear's fourth variant, executed |

The guardian's attempt to resume buys through its vault (6.8) failed as a whole, so it created
nothing. The guardian vault itself (`EEEyKiw7...`) never holds lamports: Squads signs for it.
The rent-exempt minimum of an empty account on this validator is 890,880 lamports.

## 5. The owner's tools, as run

Every run's full output is kept in the scratchpad (`d01-tools/tool-*.txt`); the lines that matter:

| tool and arguments | result |
|---|---|
| `preflight.mjs --rpc <validator> --vault <admin> --guardian-multisig BXDJioxL... --cluster devnet --proposed-launch-approver FTLBdYDg...` (before `set_launch_approver`) | exit 1 with exactly two problems, both expected of this setup: `REWARDS_UPGRADE_AUTHORITY` (`vicinity_rewards`' upgrade authority is the earlier rehearsal's Squads vault `9SzJe6zm...`) and `LEGACY_UPGRADE_AUTHORITY` (the old program's is `9pYCvdmi...`); the approver passed every check (no founder, no role, not a member or vault of the guardian multisig); the guardian multisig passed (controlled by the admin, no time lock, threshold 1, two members with every permission); config #1 passed the keep-up rule (`C * b_B = 750 <= 3t`) |
| `preflight.mjs` again after the batch path was set up, and at the end | the same two problems and nothing else (section 6.10) |
| `batch.mjs verify lists-local/batch-1.json --rpc http://127.0.0.1:8899 --rpc http://127.0.0.2:8899 --approver FTLBdYDg... --archive <owner's archive> --cluster devnet` | exit 0: "changes against no live batch (every entry is a new approval): 5 added", each entry with its metadata hash; batch 1, root `16ef5f45...`, window 21:41:12 on 23 October to 09:41:12 on 25 October (12 hours 10 minutes ahead, 36 hours long); message hash `EjeR8QmDzHJ5FCRkEmHZses4yEHW4dmN3yAafmjwX8Pc`; the list kept in `pending/` |
| the approver signs the verifier's own transaction (base64 from its output; no compute-budget instruction added) | `publish_launch_batch` landed, signature `3Hnz6BR3...` (section 11) |
| `batch.mjs confirm 1 16ef5f45... --rpc ... --rpc ...` | exit 0: "is the list you verified, written by the transaction you verified (message hash EjeR8Qm...); kept as the next baseline" (moved to `signed/`) |
| `batch.mjs check <signed entry> --rpc ... --rpc ...` (the monitor's comparison) | exit 0: "the stored batch is the list (both RPCs agree)" |
| `batch.mjs check <signed entry> --rpc <one>` | exit 0 with `warning ONE_RPC` and "on one RPC's word" (review R10-RPC-1's hardening, as designed) |
| `batch.mjs verify` of the same five entries as batch 2, once the admin had approved city 990000003 per city | exit 1, no transaction: `PROBLEM BAD_ENTRY: entry 1 (city 990000003, D01C, ...): the city has a pending per-city approval (it wins, ApprovalPending)`; changes against the stored batch 1 taken from the archive (0 added, 0 removed, 0 changed) |
| `guardian-stop.mjs --rpc ... --rpc ... --multisig BXDJioxL... --keypair <member 1> --halt-buys --pause-launches --cluster devnet --priority-fee 1000 --rounds 3` | exit 0 in one round: four variants for indices 1 to 4, each accepted by both RPCs; "the stop is on chain: both RPCs show it, and this member's transaction 2JCAGCiy... is confirmed". Indices 1 and 2 executed (the second is the "harmless second stop" of NOTES 87), 3 and 4 failed `ConstraintSeeds` |
| `guardian-stop.mjs ... --clear` (member 2), after the batch launches | exit 0 in one round: four variants for indices 3 to 6, each accepted by both RPCs; "the stop is on chain: both RPCs show it, and this member's transaction 5aLC3mZ3... is confirmed". All four executed, in one slot (section 8, item 5) |
| `batch.mjs check <signed batch 1> --rpc ... --rpc ...` right after the clear | exit 1: `PROBLEM CLEARED: the stored batch is cleared`, `PROBLEM HALTED: the batch path is halted` (the monitor's alarm) |
| `batch.mjs verify lists-local/batch-2.json --rpc ... --rpc ... --approver CpesEZiV... --archive ...`, after the rotation | exit 0: `warning LATEST_ENDED` (batch 1 is cleared: every entry is a new approval), 3 added; for reference against the cleared batch 1, 3 added and 5 removed; batch 2, root `1a4413d6...`, window 09:52:40 on 24 October to 21:52:40 on 25 October; message hash `FD1Kh983iwP6uS8a4zH7YquYxRvJ16UgB2x6guSjzkYk` |
| `batch.mjs confirm 2 1a4413d6... --rpc ... --rpc ...`, then `check` | exit 0 ("is the list you verified, written by the transaction you verified"), then exit 0 ("the stored batch is the list (both RPCs agree)") |

## 6. The rehearsal, step by step

Signatures, compute units, fees and sizes of every transaction are in section 11, in order.

### 6.1 8.5's hand-over (on the copy of devnet)

The old program's admin paused its launches (`set_pause(launches = true)`), disabled both its
configs and proposed the D01 admin, who accepted; the rewards registry's admin did the same.
After it, the old `Launchpad` holds `launches_paused = 1` and admin `F7V1hNXC...` with nothing
pending, and the registry admin is `F7V1hNXC...`: the four conditions `approve_launch` and
`launch` check (4.8).

### 6.2 Guardian, deploy, init, configs, payout keys, the batch path

* The guardian: a Squads v4 multisig made with the real program's `multisig_create_v2`
  (`BXDJioxLKY46h4yv4LMp5PdQwuP6vkWAdkWAAhFU27iw`): config authority the admin, threshold 1, time
  lock 0, members 1 and 2 with every permission. The guardian is its vault 0,
  `EEEyKiw7LygjZCFF6NE3cCTrEqf2Zt27DSY73GQfUvc8` (O35's shape; three members on mainnet, two here).
* `init_launchpad(guardian)` signed by the admin as payer, admin and upgrade authority.
* Config #0: 5.9's integers (shares 50/70/50/50/30, `x0` 30,000,853,639, `y0`
  1,073,025,598,486,615, `S` 793,099,990,000,000, `P` 206,900,000,900,000, `R` 85 SOL, launch fee
  0.05 SOL). Config #1, for a graduation on devnet: the same shares, supplies and launch fee, `R`
  = 1,000,000,001 lamports with `x0` 352,951,219 and `y0` 1,073,025,598,259,387 from the SDK's
  `deriveCurve` (V1 to V11 pass; the 8.4 keep-up rule passes). `deriveCurve` finds no integers
  for exactly 1 SOL at these supplies within its radius, hence the extra lamport.
* `set_payout_config(payout key, payout wallet)`; `init_launch_batch`; then, after the
  checklist's `--proposed-launch-approver`, `set_launch_approver(FTLBdYDg...)`.

### 6.3 The launch batch (published at 09:31:12 UTC)

Five entries built with the SDK (`buildLaunchBatch`, then `launchBatchFile`, the canonical list
file of 3.12): city 990000002 "D01 Batch One" / `D01B` for founder B on config #0, city 990000003
"D01 Batch Two" / `D01C` for founder C on config #1, and three entries for cities 990000011 to
990000013 whose founders are hashes nobody holds (so that the proofs have two or three hashes).
Each metadata hash is the SHA-256 of a small JSON with the name and ticker. Root
`16ef5f45c1dc639cefe4565c23c6beed0e4a03449e34295e1877cab1359f790e`, five leaves. Then `verify`,
the approver's signature on the verifier's transaction, `confirm` and `check` as in section 5. The
stored record: number 1, `valid_from` 1,792,791,672 (21:41:12), `valid_until` 1,792,921,272,
published at 1,792,747,872, slot 814, publisher `FTLBdYDg...`. A `launch_from_batch` for city
990000002 sent at 09:46, inside the review window, was refused with `BatchNotYetValid`.

### 6.4 The per-city path and the curve

`approve_launch(990000001, founder A, config #1, "D01 Approved", D01A, metadata hash, 7 days)`,
then founder A's one transaction `[compute limit 400,000, launch, create his token account, buy
0.05 SOL]` (events `CoinLaunched`, `Trade`). The coin: `Ft6oprTizn4BvZrZrk9ibVZcwhyVuX1MdQhvTDrWCJyb`,
mint `J25KL9E5K7Hp5cxRH75EqzAbtNZVdMWX8frJCtRaKTbr`, vault
`6pgU9CVGBgw1DuDbuYeSqKsqzS3jexkWK7XbxFfUXqyf`; mint and freeze authority none, metadata immutable,
9,100,000 raw units burned at launch (O3 (a)); the metadata names the coin's PDA as update
authority, no creators, seller fee 0 and the `vicinity.city/coin-meta/<mint>.json` URI. Founder A
paid 127,606,840 lamports in all: the coin's rent 5,714,160 and the 0.05 SOL buy (together 55,714,160 into the coin), mint 1,461,600,
vault 2,039,280, ticker lock 1,231,920, Metaplex's account 15,115,600 (rent 5,115,600 for 607 bytes
plus Metaplex's own 0.01 SOL fee), the 0.05 SOL launch fee to `FEE_RECIPIENT`, his token account
2,039,280 and the 5,000 fee; the admin got the approval's 2,150,640 back. Then curve buys by
traders 1 and 2 (0.2, 0.1, 0.03, 0.05 and 0.02 SOL), a sell of half of trader 1's coins. Every
buy took its minimum from the SDK (`buyLeg` with `buySlippagePolicy`'s default), every sell from
`sellLeg`.

### 6.5 Buybacks

Five `buyback_burn` calls by the keeper, each at least 150 slots after the last: one on the curve
(spent 570,589 lamports and burned 663,081.493421 coins: the cap, 0.1% of the depth `x0 +
curve_sol`, at a 2.5% fee) and four in the pool (477,791, 478,268, 466,758 while buys were halted
and 477,074 after the buyback halt was lifted, each the cap `pool_sol / 1000` of 7.1). In all
2,470,480 lamports spent and 2,424,552.120653 coins burned; the mint's supply is exactly
1,000,000,000 coins less the 9.1 burned at launch less these (997,575,438.779347). One call during
the buyback halt was refused (`BuybacksHalted`).

### 6.6 Graduation, the pool and the drip

Trader 2 asked the SDK's `buyLeg` for a buy of 2,000,000,002 lamports (twice the graduation
amount); `buyLeg` capped `sol_in` at the curve's `max_quote_in`, 731,837,307 lamports, so the
transaction offered 731,837,307 (section 11, row 36), and the buy completed the curve (events `Trade`,
`Graduated`): `tokens_sold` = `S` = 793,099,990,000,000, `curve_sol` = `R` = 1,000,000,001, the
pool opened at `pool_sol` 1,000,000,001 and `pool_tokens` 206,900,000,900,000, with 6,673,501
lamports in `liquidity_pending` (the 0.5% bucket of the curve phase, O2). Pool trades (a buy of
0.1 SOL, two sells) then fed the drip: `liquidity_added` rose to 7,490,892 and `liquidity_pending`
fell to 2,928,058 by the end of section 6.8. The same account list served the curve and the pool.

### 6.7 Outflows, the rewards link and payouts

* `withdraw_platform_fees` three times (keeper; to `FEE_RECIPIENT`), `claim_founder_fees` three
  times (founder A).
* `init_city` of `vicinity_rewards` for D01A (Holders, founder share 0, WSOL; signed by the admin
  as registry admin and authority): config `E28PhM4h8snKkxPs6r65t21knbUJmEX9X9BY1HrqVjmQ`, WSOL vault
  `Cw9bHEguXkhooBiCggZBFVc98jwUcHLhwMV9gfbXmace`. Then `forward_holders_fees` with the top-level
  `SyncNative` twice (the SDK's `forwardHoldersFeesWithSync`): 10,308,388 lamports forwarded, and
  the vault's token amount is exactly that (its lamports less its rent of 2,039,280).
* `opt_in_payout` (founder A, the payout wallet), then the payout wallet funded with 0.001 SOL
  (1,000,000 lamports, above its rent-exempt minimum of 890,880 on this validator: a 0-lamport
  destination must receive at least the rent-exempt minimum, 14.3; section 11, row 29), then
  `payout_founder_fees` twice while `founder_pending` was 0 (the claim just before had taken it):
  both no-ops, as 4.20 says (no event, no sequence number, no cooldown started). After a trade,
  `payout_founder_fees` paid 250,000 lamports (`FounderPaidOut`, `payout_seq` 1), and the next one,
  after another trade, was refused with `PayoutTooSoon` (24 hours).

### 6.8 The guardian stop, what still works, and the recovery

* `guardian-stop.mjs --halt-buys --pause-launches` by member 1 (section 5). The `Launchpad` then
  showed launches paused and buys halted, buybacks and payouts untouched.
* While halted: a buy refused (`BuysHalted`, twice); a sell, a claim, a withdrawal and a buyback
  all worked.
* The admin's recovery `set_pause(launches = false, buys = false)`, buybacks left alone, then a
  buy worked again.
* Member 2 created, proposed, approved and executed in one transaction a vault transaction whose
  inner call was `set_pause(buys = false)` signed by the guardian vault: refused (`Unauthorized`,
  4.4; the guardian can only stop).
* The buyback halt's order (review LL-1), by the admin: `set_pause(buybacks = true)` alone refused
  (`BuybackHaltWithoutBuyHalt`); `buys = true, buybacks = true` together accepted; a buyback refused
  (`BuybacksHalted`); `buys = false` while buybacks stayed halted refused
  (`BuybackHaltWithoutBuyHalt`); `buybacks = false` first, a buyback with buys still halted (the
  keeper drains the backlog), then `buys = false`.

### 6.9 Launches from the batch, after the window

`valid_from` of batch 1 was 21:41:12 UTC; the validator's clock passed it in real time, twelve hours
and ten minutes after the publication.

* At 21:41:35 founder B sent the same transaction that had been refused at 09:46 with
  `BatchNotYetValid`: `[compute limit 400,000, launch_from_batch(990000002, batch 1, a 3-hash proof),
  create his token account, buy 0.02 SOL]`, a v0 message with the lookup table, 829 bytes. It landed
  (events `CoinLaunched`, `LaunchedFromBatch`, `Trade`), 178,788 units in all (`launch_from_batch`
  139,129, the token account 13,414, the buy 26,095). The coin
  `7vXAwbwXmCUQGXRq5Jk4AaBViQ2RhawmWY1VRhQ7yHKA` on config #0, mint
  `CKfKNaYYiD5YqTfAHsmtytyEiKCRB2EyHFVY6miKQgX`, the leaf's name, ticker, founder, config and metadata
  hash in the `Coin`. Founder B paid 97,606,840 lamports, exactly the sum of the coin's rent 5,714,160,
  the mint 1,461,600, the vault 2,039,280, the ticker lock 1,231,920, Metaplex's 15,115,600, the
  launch fee 50,000,000, his token account 2,039,280, the 0.02 SOL buy and the 5,000 fee (no
  `Approval` exists on this path, so there is no rent to give back).
* Founder C's same transaction for city 990000003, which the admin had also approved per city during
  the review window (section 5; a pending approval wins, X75), was refused with `ApprovalPending`
  (45,732 units). The admin's `revoke_approval(990000003)` (`ApprovalRevoked`, 6,229 units; the
  approval's rent back to the admin), then the same transaction landed at 21:41:43: coin
  `DUNEvJr7boJZimJwTXcb2AWDmWnRcCWbVMQms2aDDhGR` on config #1, 173,970 units (133,041 + 14,914 +
  25,865).
* Trader 2 bought 0.1 SOL of D01B, creating his token account in the same transaction (42,662 units;
  the buy 26,095, as litesvm's), and sold it back.
* Each of the two coins holds exactly its liabilities plus its `rent_reserve` (section 4).

### 6.10 The clear, the halt and the rotation

* `guardian-stop.mjs --clear` by member 2 (section 5), at about 21:42: the vault's
  `clear_launch_batch(halt = true)` (event `LaunchBatchCleared`). Its four variants all executed, in
  one slot (section 8, item 5). After it both stored records are cleared and `halted` is set.
* `batch.mjs check` (the monitor's comparison) then failed with `PROBLEM CLEARED` and
  `PROBLEM HALTED`, and the approver's `publish_launch_batch` was refused with `BatchesHalted`.
* The admin's `set_launch_approver(CpesEZiV...)` (`LaunchApproverChanged`): the halt lifted, both
  records cleared (they already were).
* A new list for the next day (cities 990000021 to 990000023, founders that are hashes nobody holds)
  as batch 2: `verify` (exit 0, `warning LATEST_ENDED`, every entry new), the new approver's signature
  on the verifier's transaction (`LaunchBatchPublished`, 21:42:40), `confirm` and `check` (exit 0).
  The stored record: number 2, root `1a4413d6898615d416f0e2145bd6122e7c5cd1f58cfc0bdc073c350050459f4c`,
  three leaves, `valid_from` 1,792,835,560 (09:52:40 on 24 October), `valid_until` 1,792,965,160,
  publisher `CpesEZiV...`; the previous record is batch 1, cleared. No launch from batch 2 was
  attempted: its window opens after this run.
* The deploy checklist at the end: the same two problems of this setup, nothing else.

## 7. Measured against the specification

### 7.1 Compute units

"D01" is the program's own consumption, read from the log of each transaction (the transaction
total, with the compute-budget instruction and any token-account create, is in section 11).
"litesvm" is C01 of the same gate run on the production build (`tests-curve/12-compute`), so the
two differ only by the cluster ids, the program binaries around them and the inputs.

| instruction | D01 | litesvm C01 (this commit) | 11.1 estimate; test budget | note |
|---|---|---|---|---|
| `init_launchpad` | 9,589 | n/a | 5,000 to 30,000; 50,000 | |
| `add_launch_config` | 14,809 (#0), 14,672 (#1) | 14,956 | 5,000 to 30,000; 50,000 | the config PDA's bump differs |
| `set_payout_config` | 4,127 | n/a | 5,000 to 30,000; 50,000 | |
| `set_pause` | 4,031 to 4,047 (refused 5,072) | 4,037 | same | |
| `init_launch_batch` | 10,249 | 10,396 | 4,000 to 15,000; 50,000 | |
| `set_launch_approver` | 13,367; 13,365 (the rotation) | 13,368 | same | |
| `publish_launch_batch` | 13,420 (batch 1), 13,449 (batch 2); refused while halted 9,625 | 13,420 | same | |
| `approve_launch` | 27,824 (city 990000001), 29,500 (990000003) | 23,254 | 5,000 to 30,000; 50,000 | above litesvm by 4,600 to 6,200: other cities, a 12- and a 13-byte name (`check_name` walks every character), and the `devnet` build's own PDAs; inside the budget |
| `launch` | 118,369 | 118,646 (city 800); 110,382 to 152,266 over 600 cities | 125,000 to 190,000; 230,000 | devnet's Metaplex binary; inside the measured range |
| `launch` + token account + first buy, one transaction | 159,298 (launch 118,369, create 14,914, buy 25,865) | about 165,000 to 171,000 | asserted by C01; client 400,000 | the create matches `13,430 + 1,500 k` with one extra bump (14,914) |
| `buy` on the curve | 25,865 | 26,138 | 31,000 to 42,000; 48,000 | |
| `buy` on the curve creating the buyer's token account in the same transaction | 26,095 (transaction 42,662) | 26,095 (transaction 42,669 in that run; the token-account create's share varies with the random keys' bump searches, 44,169 in another run of `12-compute`) | as `buy`; 48,000 | the program's part identical |
| `sell` on the curve | 23,572 | 23,622 | 28,000 to 39,000; 48,000 | |
| `buy` that graduates (partial fill) | 29,434 | 29,622 | plus 3,000 to 6,000; 55,000 | |
| `buy` in the pool | 25,292 | 25,523 | as `buy`; 48,000 | |
| `sell` in the pool | 23,508 | 23,508 | as `sell`; 48,000 | identical |
| `buyback_burn` on the curve | 20,137 | 20,403 | 26,000 to 35,000; 48,000 | |
| `buyback_burn` in the pool | 19,625 to 19,626 (refused while halted: 10,931) | 19,849 | same | |
| `withdraw_platform_fees` | 12,485 to 12,486 | 12,486 | 12,000 to 18,000; 25,000 | |
| `claim_founder_fees` | 13,020 to 13,021 | 13,021 | same | |
| `forward_holders_fees` (+ `SyncNative` 201) | 21,084 to 21,085 | 27,085 | 20,000 to 32,000; 40,000 | the `devnet` build derives the city's config and vault under the devnet rewards id: fewer bump iterations for this mint |
| `opt_in_payout` | 15,212 | 13,712 | settings; 50,000 | one more bump iteration of the opt-in PDA |
| `payout_founder_fees` | 18,740 (paid); 13,262 (no-op); 12,435 (refused, cooldown) | 18,742 | 15,000 to 22,000; 30,000 | |
| `launch_from_batch` + token account + first buy, one transaction (3-hash proofs, the lookup table) | 178,788 and 173,970 (`launch_from_batch` 139,129 and 133,041); refused before `valid_from` 64,924, with a pending approval 45,582 | 177,763 to 179,279 (9 hashes, a 32-byte name; `launch_from_batch` 127,738 for city 801) | `launch` plus 8,000 to 20,000; 250,000 | the program's part 5,300 and 11,400 above city 801's with six hashes fewer: other cities, tickers and founders, so other bump searches (`launch` alone spans 110,382 to 152,266 over 600 cities, 11.1); inside the budget |
| `revoke_approval` | 6,229 | n/a | 5,000 to 30,000; 50,000 | |
| `clear_launch_batch` (by the guardian vault, inside Squads' execute) | 12,484 to 12,485 | 12,486 | 4,000 to 15,000; 50,000 | |
| guardian stop (Squads create, propose, approve, execute) | 23,387 + 12,769 + 8,490 + 24,210 = 69,156 with the pause only; 23,503 + 12,829 to 15,829 + 8,550 + 35,449 = 80,631 to 83,632 with the clear only | NOTES 87: 27,468 + 12,421 + 8,142 + 42,284, about 90,000, with the pause and the clear | 150,000 limit (the tool's) | devnet's Squads binary; smaller inner message |

### 7.2 Transaction sizes

| transaction | D01 bytes | 11.3 / C02 | why they differ |
|---|---|---|---|
| a buy that creates the buyer's token account (one compute-budget instruction) | 543 | 555 (website buy: two compute-budget instructions) | one compute-budget instruction fewer (12 bytes) |
| a sell | 501 | 513 | the same |
| `launch` + token account + first buy, no lookup table, the founder paying | 968 | 1,064 | C02's transactions have a separate fee payer (one more signature and key, 96 bytes) |
| `launch_from_batch` + token account + first buy with the lookup table (3-hash proof, 13-byte name, 4-byte ticker) | 829 (the refused ones and the two that landed alike) | 1,142 in the worst case (9 hashes, 32-byte name, 10-byte ticker) | 6 hashes and 23 bytes of strings fewer |
| `publish_launch_batch`, the verifier's legacy transaction | 338 | 380 | C02's v0 message with a compute-budget instruction (42 bytes) |
| `approve_launch` | 616 to 617 | 750 | separate fee payer and compute-budget instruction in C02 |
| a guardian member's clear (`guardian-stop.mjs`: two compute-budget instructions, then create, propose, approve and execute) | 774 | not in 11.3 | one transaction, as NOTES 87 requires |
| the lookup table (11.3) | 15 static addresses: the System, Token, ATA, Metaplex and Compute Budget programs, the rent sysvar, the event authority, `vicinity_curve`, `FEE_RECIPIENT`, `Launchpad`, `LaunchBatch`, the old `Launchpad`, the rewards registry and configs #0 and #1 | as 11.3 | `LaunchBatch` added, as 11.3 says |

### 7.3 Rent and the cost of a launch

Every account's size and rent equals 3.3's 6,960 column (section 4): `Launchpad` 238 / 2,547,360,
`LaunchConfig` 144 / 1,893,120, `LaunchBatch` 260 / 2,700,480, `Approval` 181 / 2,150,640, `Coin`
693 / 5,714,160 (its `rent_reserve`), `TickerLock` 49 / 1,231,920, `PayoutOptIn` 145 / 1,900,080,
mint 82 / 1,461,600, vault 165 / 2,039,280. The one exception is Metaplex's metadata account:
**607 bytes on devnet's Metaplex**, 5,115,600 lamports of rent (3.3 says 679 bytes and 5,616,720
at this rate, which mainnet's pinned Metaplex dump allocates), so a founder's launch cost here
0.07557 SOL against 11.2's 0.0761 at litesvm's rate: rent 15,562,560, the launch fee 50,000,000,
Metaplex's fee 10,000,000 and 5,000 of transaction fee. At devnet's 5,080 lamports per byte the
same accounts would cost 0.0714 SOL (11.2: 0.0717 with the 679-byte metadata).

The coin's money after the whole of section 6 (city 990000001): lamports 490,205,547 =
liabilities 484,491,387 + `rent_reserve` 5,714,160 exactly (I9, no donation). Fees 52,094,702
lamports = 2.5% of 2,083,788,156 of volume, split 10,418,950 / 14,586,515 / 10,418,938 /
10,418,938 / 6,251,361 (liquidity, platform, founder, holders, buyback: 50/70/50/50/30 bps, the
remainder of 12 to liquidity), with platform 14,516,515 withdrawn, founder 10,118,938 claimed and
250,000 paid out, holders 10,308,388 forwarded, buyback 2,470,480 spent; the pending figures are
the rest of each.

### 7.4 The tools against devnet itself (read-only)

`preflight.mjs --rpc https://api.devnet.solana.com --vault F7V1hNXC... --guardian-multisig
BXDJioxL... --cluster devnet` (exit 1) lists what devnet lacks for D01, ten problems: no
`Launchpad`, the program's upgrade authority "null" (the program is not deployed), no config #0,
the registry admin `9pYCvdmi...`, the rewards upgrade authority `9SzJe6zm...`, the old program's
admin `9pYCvdmi...`, its launches open, its upgrade authority `9pYCvdmi...`, and both its configs
enabled. `batch.mjs check <list> --rpc https://api.devnet.solana.com --rpc
https://solana-devnet.gateway.tatum.io --cluster devnet`, and the same with
`solana-devnet.api.onfinality.io/public` as the second, both accepted the two providers and read
devnet through both (`PROBLEM NO_ACCOUNTS: Launchpad or LaunchBatch missing`, as expected).

## 8. Differences from the specification, and things worth knowing

No program defect and no tool defect was found. What differed, and why:

1. **Metaplex on devnet is another binary** (sha256 `bb0842f6...`, 1,295,344 bytes; mainnet's
   pinned dump `31f0a627...`, 793,991 bytes). Its metadata accounts are 607 bytes, not 679, so
   3.3's metadata rent and 11.2's launch cost are mainnet's figures; on devnet a launch costs
   about 0.0005 SOL less. `launch` used 118,369 compute units, inside the range measured with the
   mainnet dump.
2. **The `devnet` build derives other addresses** (the old program's coin and approval, the
   rewards config and vault under the devnet ids), so its bump searches differ: `forward_holders_fees`
   used 6,000 fewer units than litesvm's measurement, `approve_launch` 4,600 to 6,200 more (with
   other cities and names), `opt_in_payout` 1,500 more, `launch_from_batch` 5,300 to 11,400 more than
   city 801's in litesvm. Every figure is inside its 11.1 budget, as
   11.1 says the figures move with the program id and are measured again once the mainnet id exists.
3. **Rent**: this validator charges 6,960 lamports per byte, devnet 5,080; every account matched
   3.3's 6,960 column.
4. **Sizes**: the 11.3 figures were measured in litesvm with a separate fee payer and a
   compute-budget instruction; without them each transaction is 42 to 134 bytes smaller (7.2).
5. **A guardian stop can execute up to four times on a quiet chain, not twice.** NOTES 87 says "a
   variant beyond the index the stop lands at executes a second, harmless clear". In D01 the first
   stop's variants for indices 1 to 4 gave two executions (1 and 2; 3 and 4 failed
   `ConstraintSeeds`), but the clear's variants for indices 3 to 6 all executed, in one slot, each
   finding the index the one before had just moved to. Every extra execution is harmless to the
   program (the same flags set again, cleared records cleared again) but costs the member the rent
   of one more vault transaction and proposal: 5,157,360 lamports with the pause (223 + 262 bytes),
   5,588,880 with the clear (285 + 262 bytes) at this validator's 6,960 lamports per byte. At
   mainnet's and devnet's 5,080 (`getMinimumBalanceForRentExemption(738109)` = 3,750,243,960 on both,
   read on 23 October 2026) that is 3,764,280 and 4,079,240 lamports: about 0.0041 SOL for each extra
   clear, about 0.016 SOL for four. "Four" is this run's default `--variants 4` with both RPC
   addresses showing the same index: `nextIndices` takes up to `--variants` indices (at most 16) per
   RPC view, so two RPCs that show different indices give up to 8 executions in one round with the
   default. The monitor sees as many `LaunchBatchCleared` events. A member key should hold enough for
   that; NOTES 87 now says so. The tool behaves as designed; not changed.
6. **`payout_founder_fees` with nothing pending is a quiet success**: no event, no sequence
   number, no cooldown (4.20). A payout hook that reads only the transaction's success would
   record a payout that did not happen; it must read the `FounderPaidOut` event (the SDK's
   decoder) or the coin's `founder_paid_out`.
7. **After graduation the backlog limits the slippage the SDK allows.** Right after this small
   coin graduated, `buyback_pending` (5.6 million lamports, accumulated on the curve) was about ten
   runs of the pool's cap, so `sandwichThreshold` was 0 and `sellLeg` refused 100 bps on a sell,
   allowing at most 30 (5.15, review KR-1). This is the SDK's rule working as designed; the
   website should show the 0.3% limit, not fail, when a coin is in that state.
8. **`deriveCurve` finds no integers for a 1 SOL graduation** at config #0's supplies (radius
   20,000); 1 SOL and 1 lamport works. Only the demonstration config is affected; config #0's 85 SOL
   is 5.9's.
9. **The checklist on a cluster where the program is not deployed** reports the upgrade authority
   as "null" next to "not initialised (no Launchpad)": correct and fail-closed, but "not deployed"
   would read better. Not changed (cosmetic).
10. **`batch.mjs check` after a clear with halt** prints the advice for a live wrong batch ("page the
   guardian members; have one clear the batch with halt ... if it is not the one you signed") although
   the batch is already cleared and halted. Fail-closed and correct as an alarm; wording only. Not
   changed.

## 9. Not reached, and why

* **Devnet itself.** No devnet SOL for the 3.750 SOL program account (the faucet refused every
  request: 14 requests of 0.5 or 1 SOL for the admin key between 09:24 and 21:10 UTC, each answered with
  the rate limit), and the 8.5 hand-over on devnet needs the old devnet deployer's key,
  which this run may not use on devnet (section 1). Every step was rehearsed on the copy instead.
* **"The site's list" and `verify --tx`.** The website's batch page and the monitor process are
  not built (14.1, Appendix C); the list was built with the SDK functions the page will use, and
  `batch.mjs check` (the monitor's comparison) was run by hand.
* **Two independent RPCs.** The two RPC addresses were one validator; the two-RPC comparisons
  passed trivially. Against devnet, two real providers were used read-only (7.4).
* **A three-member guardian.** O35 asks for three members; two were used (the checklist's minimum).
* **A launch from batch 2.** Its window opens at 09:52:40 on 24 October, after this run; batch 1 covered
  the launch path, and batch 2 the publication after a rotation.
* **The halt-all build over live state (H03)** is not part of D01 and was not deployed here; the
  `halt-all` build exists for mainnet ids only (it is covered in litesvm, `11-halts`, `test:vcurve`).

## 10. To run D01 on devnet itself

1. Fund the D01 admin `F7V1hNXCdPZMKhXJpDg3UCAiqDDzjKNJh3wEPc8A87tt` with about 4.3 SOL of devnet
   SOL (3.76 for the program account and its writes, about 0.5 for the rest; 1.1 more to repeat the
   1 SOL graduation; most of it comes back by selling).
2. With the old devnet programs' deployer `9pYCvdmi...` (the owner's throwaway devnet key), sign
   the five hand-over transactions of 6.1 on devnet: pause the old launches, disable its two configs,
   `propose_admin(F7V1hNXC...)` on the old program and on the rewards registry; the D01 admin then
   accepts both. This changes the devnet deployments LAUNCHPAD-DEVNET.md records (their admin and
   their launches); it can be handed back the same way afterwards.
3. Run the same sequence with the RPCs `https://api.devnet.solana.com` and
   `https://solana-devnet.gateway.tatum.io` (both serve devnet and pass the tools' provider rule).
   The rehearsal driver used here (`rehearsals/vicinity-curve-d01/driver/d01.mjs`, `D01_TARGET=devnet`;
   its paths point at the session's scratchpad and must be set first) checks the devnet genesis hash
   before every send. The batch launch then needs the same 12 hours and 10 minutes. Signatures on
   devnet itself are what would let anyone check this record's figures.

## 12. The record kept in the repository

`rehearsals/vicinity-curve-d01/`, committed on 24 October 2026 (after a review found that nothing
of the run was in the repository). Public data only: no key (the keys stay in the scratchpad's
`solana-keys/devnet-d01/`), no buffer seed, no archive MAC key, no `.so` file, no ledger.

| path | what it is |
|---|---|
| `driver/d01.mjs`, `driver/lib.mjs` | the rehearsal driver as run (phase by phase; `D01_TARGET=local` here) and its helpers (connections checked by genesis hash, sending, the record) |
| `driver/collect.mjs`, `driver/accounts.mjs` | what built section 11's table and section 4's account table from the chain |
| `driver/babysit.sh` | the watchdog that restarted the validator on the same ledger to bound its disk use (`record/babysit.log.txt`: its 28 restarts and the manual one before the batch steps; with two earlier ones by hand, the 31 of section 1) |
| `record/d01-log-local.jsonl` | every transaction as recorded right after it landed: time, phase, label, signature, slot, compute in total and per program, fee, size, events, result |
| `record/table-local.json` | section 11's rows, with the figures cached before old slots were pruned |
| `record/d01-state-local.json`, `record/show-local-*.json`, `record/accounts-local.md` | the state the driver kept (deploy, read-back hash, batch records) and the accounts it read |
| `record/lists/batch-1.json`, `batch-2-dry.json`, `batch-2.json` | the canonical batch list files (3.12) given to `batch.mjs verify` |
| `record/tool-local-*.txt`, `record/tool-devnet-*.txt` | every run of the owner's tools (section 5) and the two read-only runs against devnet (7.4), each with its command line (keypair paths replaced) and exit code |
| `record/airdrop.log.txt` | the devnet faucet's answers (section 1) |

Kept in the scratchpad only, and not committed: the keys, the deploy's output (it prints the
recovery seed of an intermediate buffer), the verifier's archive and its MAC key, the program
dumps (`.so`) and the validator's logs (about 30 MB).

## 11. Every transaction

In slot order, 81 transactions, all on the local validator: none of these signatures exists on
devnet or any other public cluster, and the validator's ledger was not kept (the rows are as the
driver recorded them, `rehearsals/vicinity-curve-d01/record/`). "CU (total)" is the transaction's, compute-budget instructions
included; the per-program figures are each top-level instruction's own, read from its log (a
compute-budget instruction logs none). Fees in lamports. Bytes is the serialized transaction (blank
where a tool sent it and the slot was pruned before its size was read: the deploy, whose 740 buffer
writes are not listed, and the first stop's four variants, the same shape as the clear's). The
owner's tools' output is in the scratchpad (`d01-tools/tool-*.txt`).

| # | phase | step | signature | slot | CU (total) | CU per top-level program | fee | bytes | events | result |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | handover | old vicinity_launchpad: set_pause(launches = true) | `5DHguU3xBzhYQJNUHoZFcttb3pDJaU76P1wp2UdQjzSu6RnnE2YJdKUV95ZK62P8piLq96vZxQb7554cREBPSkn7` | 651 | 5,376 | old launchpad 5376 | 5,000 | 216 |  | ok |
| 2 | handover | old vicinity_launchpad: set_launch_config_enabled(false) 8pfgRZNLfftPAYF652GGPQVrjj2KgQf44AtZxfvpQ1Wa | `2B9HmqK315Ek4Y2gXq1y7CQJSW9P5XwP2FSvcsaRxrJ1VxLQ5EsJ6ccZnbXXLcNzZsgKm7cVRPnx4ieVkXU77CdX` | 653 | 8,141 | old launchpad 8141 | 5,000 | 247 |  | ok |
| 3 | handover | old vicinity_launchpad: set_launch_config_enabled(false) GCZJQJXSaNppSVEwj88V9gHatPf28mqLhL2ttbuHT1K8 | `3hTDsQHuHCW2j5SGzTgRU8j8cKkdjCpfm3sNGQRnzQCgvJ96JVhn8rRqYub4YASaZzaGfjUxS9Vu8ZYvrew1wLGA` | 656 | 8,141 | old launchpad 8141 | 5,000 | 247 |  | ok |
| 4 | handover | old vicinity_launchpad: propose_admin(D01 admin) | `3AjM4xmvU8D1hdJY1KKPTerQWRsGKwHyjLqTfaKYDpairUaVUiAAvJuh7zZmMRa2ydLbsvNkap6cb6BStuYfk1h4` | 659 | 5,301 | old launchpad 5301 | 5,000 | 245 |  | ok |
| 5 | handover | old vicinity_launchpad: accept_admin (D01 admin) | `56VfbP91W2EkN5sGjN9eqcWZZA7SbDtgWfzcYEnSVe4ZbWHYz85gDbSdxbvV3zNERduXSEzsQCVecYrYQ97cWn4D` | 661 | 5,165 | old launchpad 5165 | 5,000 | 213 |  | ok |
| 6 | handover | vicinity_rewards registry: propose_admin(D01 admin) | `82jiMnmgJgy1TKiPPvsYW6SmNm1rpCzypbqr4ngZ4RfFJvaYHbpxe3Qhp2hsM3nfBYePPbidAhZAyp23mgwrPVi` | 664 | 3,253 | vicinity_rewards 3253 | 5,000 | 245 |  | ok |
| 7 | handover | vicinity_rewards registry: accept_admin (D01 admin) | `XoabaJYryFCx8eiUVoRTmDf5r6sgzjCncGW2txFWVBjyYf3ouY4WRppG9pGNQ3Tn9zuLvV4X65m1BaZk7fq6zx9` | 666 | 3,237 | vicinity_rewards 3237 | 5,000 | 213 |  | ok |
| 8 | guardian | Squads v4 multisig_create_v2: guardian multisig (controlled by the admin, 1 of 2, no time lock) (creation fee 0) | `2mpP6TtmgeN3ehnqKbNVjmW8S11UskeHn4PqwumaXQxEdbk3gkH7RbTD1Ks6bWb2AmkTrDRb4YSc6GXf7SpCJtSv` | 697 | 19,294 | Squads v4 19294 | 10,000 | 520 |  | ok |
| 9 | deploy | solana program deploy (devnet build) | `416huoDtv3KedS7dqnppKAZ3cpDQN9VCUchqAdRFAB85sPYKzLZXbZFgjba9dWGFQFZSwJgEm3sQwepoQsuu61oF` | 713 | 2,670 |  | 10,000 |  |  | ok |
| 10 | init | init_launchpad(guardian = vault 0 of the guardian multisig) | `39mBFymFcgB1ybz3ExvtpAwegP8DmvHosh65hgb9ha3gSU8a5eUN8xv6oLJqTvRZndt2bJ7pS1zxUQPV2uHN1CHJ` | 726 | 9,589 | vicinity_curve 9589 | 5,000 | 313 | LaunchpadInitialized | ok |
| 11 | init | add_launch_config #0 (5.9 defaults: 85 SOL) | `3HX8KVmT54rJPcofuCsHc8eHGec64RcnH6C5EymyWGa4Gmt4kVS7JrA3hMdj53jCeW9YRQZcos8J6WS5KQ8CvfRp` | 728 | 14,809 | vicinity_curve 14809 | 5,000 | 338 | ConfigAdded | ok |
| 12 | init | add_launch_config #1 (config #0 shares and fee; graduation 1.000000001 SOL) | `5CvG8zZsciwBNar8LABkU8754UZVXyetY5rv2AsCkPQQg4hVsihy8gPPzNpyMQkwAdiLubrcYhA1EbufxFbAtCSF` | 731 | 14,672 | vicinity_curve 14672 | 5,000 | 338 | ConfigAdded | ok |
| 13 | init | set_payout_config(payout key, payout wallet) | `3nE4jWHnAWeVetQZTzq9gwxtJP2jMQxBXoC5vGstivW1HcPWDKBcWs8f5JvfGN1h7xJxRNDnLZXFn3ueXtmCcW3J` | 734 | 4,127 | vicinity_curve 4127 | 5,000 | 277 | PayoutConfigChanged | ok |
| 14 | init | init_launch_batch | `3szNXsZdt6fXkvD7WRSoS3MNP4qWf4MvqLT5mn9EytuMYmcb7B11niRiRRfHm8GWHrV6PjJZgQFZfGXdhhRDJTXp` | 736 | 10,249 | vicinity_curve 10249 | 5,000 | 280 | LaunchBatchInitialized | ok |
| 15 | init | set_launch_approver(approver) | `3Edhzx3NYh2T18NYK164qLR1MzhQZ14rtfyw36shC3joYYk6DAd13PdP5ZrNQKxTtcCc3FM1LPqNMHxtpQZYgEgG` | 767 | 13,367 | vicinity_curve 13367 | 5,000 | 312 | LaunchApproverChanged | ok |
| 16 | batch | publish_launch_batch (the verifier's transaction, signed by the approver) (message hash EjeR8QmDzHJ5FCRkEmHZses4yEHW4dmN3yAafmjwX8Pc) | `3Hnz6BR37gZXPWac1pCzoXXyHC5FzX2H9aGMqoEBqaScQRyTifDViiGxLxJFsogVcdbXuse38784WJqtfkKDUCa4` | 814 | 13,420 | vicinity_curve 13420 | 5,000 | 338 | LaunchBatchPublished | ok |
| 17 | per-city | approve_launch(990000001, D01A, config #1) | `3BjyPJkXm6D9PWNZ3YtP2ox1kZK5VfPEBEaLVJzfUuwss2rjdVBySjqpU4eEe7KSNDxkoSSm81BDEPtoMFvScdQN` | 978 | 27,824 | vicinity_curve 27824 | 5,000 | 616 | LaunchApproved | ok |
| 18 | per-city | launch(990000001) + founder token account + first buy 0.05 SOL | `4j9co6AbLtyPqqWhpAy3dhmD475UZ4zUFdvxQxtQYj9SNZXfryegR3n4VrLSukU1xRq6UBZckxfRuBKo9Xb66ob6` | 981 | 159,298 | vicinity_curve 118369, ATA 14914, vicinity_curve 25865 | 5,000 | 968 | CoinLaunched Trade | ok |
| 19 | trade | buy trader-1 0.2 SOL (curve) | `3LAHgGj8rEooqhHzfsd5koay4pchW6y6DeZWBn6wvmFpxome1WnUFUXEBwacF8SfUVpRFNXTwJNyMGk7adteMhCU` | 1056 | 39,432 | ATA 13417, vicinity_curve 25865 | 5,000 | 543 | Trade | ok |
| 20 | trade | buy trader-2 0.1 SOL (curve) | `SsL67vK2TWUtVHzATEcSh4nLf6z5cUmJWRvxdua21MwgrMUuPZZs5dgKo5q5mcH6NfVDkmJVNVuKEFuuBPQdWRm` | 1059 | 40,932 | ATA 14917, vicinity_curve 25865 | 5,000 | 543 | Trade | ok |
| 21 | trade | sell trader-1 154052698396787 raw (curve) | `zrNLviHJFFYdeDwFnjM9UzKvZKoECtXhGR7DqKc3xhjZPw9TEL2EoxVZrh8M3A8dDvAwn3Apb11qBdGb3Kyx9Tk` | 1063 | 23,722 | vicinity_curve 23572 | 5,000 | 501 | Trade | ok |
| 22 | trade | buy trader-1 0.03 SOL (curve) | `4fjaSa8EvFxcpdFP5cgFR7KSuNUu8tKxxFiCSiZqkfaywGFNxqprp9udSzxUKfPZtY4h5dqoXEmJBRKXPvwccWKv` | 1067 | 30,353 | ATA 4338, vicinity_curve 25865 | 5,000 | 543 | Trade | ok |
| 23 | buyback | buyback_burn 990000001 (curve; pending 1598585) | `3tYVqZAmYyjGexZNZtxW97YbmQhX3FDPtrRtKKgYmmMVEHSQtVGjMWNkWea8KQKbo8aAzXjYB2kdSw1E5VYJrwnY` | 1134 | 20,287 | vicinity_curve 20137 | 5,000 | 418 | BuybackBurned | ok |
| 24 | outflows | withdraw_platform_fees 990000001 | `3n4kRHkVby4txB38wPwYfn3JtUZb7TW38kuTtdnqbjivPtM1hKhYRGNyCVGLQDMezhSoswMyHhfMy6EW5djwdqEP` | 1138 | 12,635 | vicinity_curve 12485 | 5,000 | 319 | PlatformFeesWithdrawn | ok |
| 25 | outflows | claim_founder_fees 990000001 | `T8Hh66LVj884j7pqLG8Dv2yHUvYuUTBRtyfZbt8QVaxnnZzdcjUGpnoTRMGds4iQoMg4W9mbxsTBa858DXh7RXd` | 1140 | 13,170 | vicinity_curve 13020 | 5,000 | 287 | FounderFeesClaimed | ok |
| 26 | rewards | vicinity_rewards init_city (Holders, 0, WSOL) for D01A | `3b6sbehnPbTPJ7Ufixpws3SCQ5aqLJ4uNsnoLzRGpETmKGXLtaLXQFpDkv4wVeLKPoxAUUw9EdEoXBKo7vV8oMJ3` | 1144 | 21,255 | vicinity_rewards 21255 | 5,000 | 481 |  | ok |
| 27 | rewards | forward_holders_fees 990000001 + SyncNative | `oKdLnCDApv3kdd1U4zirMg8TUyQBVcnVH3FPE435srzZynA5K2KL9S2cbAZGvT5VuaYp6vMRUAAcrp6VyE7fNxg` | 1147 | 21,435 | vicinity_curve 21084, Token 201 | 5,000 | 422 | HoldersFeesForwarded | ok |
| 28 | payout | opt_in_payout (founder A, the payout wallet) | `4UBvEMycgKY5VHbqPEqbJzbdHd8UMdXHdSCZNGpaUwcbcSEEba82jh97NBLqcsLKSvqcRwghtZFjkdFJDZyiFEGM` | 1151 | 15,212 | vicinity_curve 15212 | 5,000 | 376 | PayoutOptedIn | ok |
| 29 | payout | fund the payout wallet with 0.001 SOL, above its rent-exempt minimum of 890,880 lamports (14.3) | `4R8iVp4qkmzhHDQHjp37m6wCh1uj5UHxwiRkUVSYJd2YSM9PSRna5U5MrHN4mtez1SPMv8NgYC5fms9USwkvouBH` | 1154 | 150 |  | 5,000 | 217 |  | ok |
| 30 | payout | payout_founder_fees with founder_pending 0 (the claim just before took it): a no-op, no event, no cooldown started | `4wDWYDrh6CH8Ze9RejbCkXCuygRsEB2hRY8AsRX59ieo33M5KP512HE1S2g8qPTHeUhbiJmWC9kLQFRKkETfdDs2` | 1157 | 13,412 | vicinity_curve 13262 | 5,000 | 386 |  | ok |
| 31 | payout | payout_founder_fees again, founder_pending still 0: a no-op again (the cooldown starts only with a payment) | `4znYQ1tjQ6G4DBDVZHqziYi3qCCQW6uFK53aLAyBdgsUY9J1BLboDYKLxJ8dVCmajVGj2MWEnrMqj7ZV9WnD3WoU` | 1160 | 13,412 | vicinity_curve 13262 | 5,000 | 386 |  | ok |
| 32 | trade | buy trader-2 0.05 SOL (curve) | `3PXw2LeMgUeYoBAbSM5XJmjZ2GqSa6G1dyCtadQJWeuL9Ung2cBCLwfEHVw4jWGeXnPMRdU6JSF8gpiHLji8BA63` | 1202 | 31,853 | ATA 5838, vicinity_curve 25865 | 5,000 | 543 | Trade | ok |
| 33 | payout | payout_founder_fees (payout key -> payout wallet) | `3rdiM28E3SVfzh42CxwTSfj4UUrJoCjck6bBXnG4CbDy3sy5XCyfVkyKjWHTbesWt4cXpA1UZjaNb2gnCdr3S2Mn` | 1206 | 18,890 | vicinity_curve 18740 | 5,000 | 386 | FounderPaidOut | ok |
| 34 | trade | buy trader-1 0.02 SOL (curve) | `5g2cY3xjhJBfbYSJfEk2214k3DR9nCZpTggyu6pijVZTyenLqokma1K4sZCRQUrF6Yqsgu2m8jais48pJHbG2sUG` | 1210 | 30,353 | ATA 4338, vicinity_curve 25865 | 5,000 | 543 | Trade | ok |
| 35 | payout | payout_founder_fees again inside the 24 h cooldown (refused) | `5tRutE5HDk9idurK6Mo5VzfEvdc8urusnk1foJDXvdFe3wqpuPWyPRBVqvXLgPrJLds6FGVLfBPWUN858mmtVxyJ` | 1214 | 12,585 | vicinity_curve 12435 | 5,000 | 386 |  | refused: PayoutTooSoon |
| 36 | graduate | buy that graduates (trader-2 asked the SDK for 2.000000002 SOL; it capped the offer at 0.731837307 SOL) | `66Kz3KVPsfKR6VrM5x9qYNjyjqKwjaBq8MUe3YTUBX8sPys3DqmcsUzE1PG3VN6c8rLPoA1XYNnzmHL2UZSsXW15` | 1237 | 35,422 | ATA 5838, vicinity_curve 29434 | 5,000 | 543 | Trade Graduated | ok |
| 37 | trade | buy trader-1 0.1 SOL (pool) | `4z21fRS6TJwSMPxyDj1nyPU7w52TVjrSfQMmzC7JAziS2tfEs3csEfyE4NUM3i1wtvUbbw1gEkMYxQJHT9eWrhkN` | 1240 | 29,780 | ATA 4338, vicinity_curve 25292 | 5,000 | 543 | Trade | ok |
| 38 | trade | sell trader-2 136100247352425 raw (pool) | `3MhFtZW7s78YUctmnsPUjG65UvGWnVBrqC1CGj65HEXumTAY1xzLAhR7AgVyTWR3kJeBX4b8DTYt44gPHygR1p3W` | 1244 | 23,658 | vicinity_curve 23508 | 5,000 | 501 | Trade | ok |
| 39 | trade | sell trader-1 113464448595468 raw (pool) | `4JSE9ec73Va3yEaEdoLF7vPumCAts8czkRNiu5RQvadWezvu6y1pBxL1PF7nHHCrSzsY9XgfmfkVGQFb2WNiMSby` | 1247 | 23,658 | vicinity_curve 23508 | 5,000 | 501 | Trade | ok |
| 40 | buyback | buyback_burn 990000001 (pool; pending 5614442) | `ai5Mtqp4Cjhx3nScnoaeYyAh4U5tXNF4PZvZfqx5oWW64j9xmAdbUv45b3H83gFmjJebdG2BEwdYVDCAeuDkjG3` | 1285 | 19,776 | vicinity_curve 19626 | 5,000 | 418 | BuybackBurned | ok |
| 41 | rewards | forward_holders_fees 990000001 + SyncNative | `keWcJ48B8Jh7AZAzL5PYZiK5FtYtwiQ31cLxCYk5kdZf9GhN6ptfGH8yMDh6VsvkzenoonyLJqwB5bXnmBhCTQk` | 1289 | 21,436 | vicinity_curve 21085, Token 201 | 5,000 | 422 | HoldersFeesForwarded | ok |
| 42 | outflows | withdraw_platform_fees 990000001 | `3tgGtQQhUTXxeEsJ893ovK6qUZFsRzw4Z2Vsz77k5ryUuTVYC6nQfUU38FZticiJZmoHUNYntZwREpKiy45ZcE7S` | 1293 | 12,636 | vicinity_curve 12486 | 5,000 | 319 | PlatformFeesWithdrawn | ok |
| 43 | outflows | claim_founder_fees 990000001 | `2Xyy4K4rNAoaxLymEz1NXZmiRdDUvxek7K4BrnMV5xYDjY9zkME2DFqTyi3cjXf61aR3nojNgAx2kpCHh3d5DeyB` | 1296 | 13,171 | vicinity_curve 13021 | 5,000 | 287 | FounderFeesClaimed | ok |
| 44 | buyback | buyback_burn 990000001 (pool; pending 5136651) | `3fbocj7Yc2gxrUqDWL2abzi7kztsFipdhXPR13sv7bL2F5wnwKchZnp5khAYcHioJLpCepHMm57q9dyTCUNBJc2w` | 1437 | 19,776 | vicinity_curve 19626 | 5,000 | 418 | BuybackBurned | ok |
| 45 | guardian-stop | guardian-stop.mjs --halt-buys --pause-launches (member 1): variant executed | `2JCAGCiy9VfSCN6S4dJuFjJW7gFDzmd6oseoP5MVL7EU4gvhksfNKzWe9k1jgMu76mtJ6sqREmsPueqyUHVSeovv` | 1457 | 69,156 | Squads v4 23387, Squads v4 12769, Squads v4 8490, Squads v4 24210 | 5,150 |  | PauseChanged | ok |
| 46 | guardian-stop | guardian-stop.mjs --halt-buys --pause-launches (member 1): variant refused | `5vyxXhwZNY75ULkWpXUuzNenYuD4Y3W2GzwRfSQcGU7qU6mqkHmi8pXB9wzb3dsLTZKVQ2qFqNbULdEEHS93gxbb` | 1457 | 10,053 | Squads v4 9753 | 5,150 |  |  | refused: ConstraintSeeds |
| 47 | guardian-stop | guardian-stop.mjs --halt-buys --pause-launches (member 1): variant executed | `5b13bKsdAnPUfLAnL8dnnqateUTiJYtFzwuYvuNGjiK6So3nq8uQi1Y6v6w6TdSssmYfL4MQcj7AvsfkgK1jKhP3` | 1457 | 69,155 | Squads v4 23387, Squads v4 12769, Squads v4 8490, Squads v4 24209 | 5,150 |  | PauseChanged | ok |
| 48 | guardian-stop | guardian-stop.mjs --halt-buys --pause-launches (member 1): variant refused | `4AsvfQgi2parZFtzKXKQ3TBJaQ3tE2QJdFA3gXnDJRtikr8oeGMJHhM6HZEKmwRybTbsuW8cUx1LYMJpkdhmzPN1` | 1457 | 8,553 | Squads v4 8253 | 5,150 |  |  | refused: ConstraintSeeds |
| 49 | halt | buy while buys are halted (refused; first attempt of the halt checks) | `5zWJKcNM4wP3jyaGvJbPJkXyXUVWJiYjzzqjfyePHxJRJ5QaMSdTvRAtDGkZTnA3PQDR4fTAqsiMrCcHmgctxaEF` | 1510 | 12,308 | vicinity_curve 12158 | 5,000 | 501 |  | refused: BuysHalted |
| 50 | halt | buy while buys are halted (refused) | `4V6DogyMQAJgQwVP6mUb6LDmcgHdxmYuXb81q2CAVZMd5T6cjGJEBz5Ms64Yb6ftUUVpA5sPgcmThNMTeS5yYy7u` | 1550 | 12,308 | vicinity_curve 12158 | 5,000 | 501 |  | refused: BuysHalted |
| 51 | halt | sell while buys are halted (works) | `4DazpyPuCaduMsm9i7yHYat8M5ZJ92ri48ipLcsiAH7FpGEoNk51sxNLA1U233Xi68uTyrXFpAMQHG5YVA98wprz` | 1553 | 23,658 | vicinity_curve 23508 | 5,000 | 501 | Trade | ok |
| 52 | halt | claim_founder_fees while halted (works) | `8FSs15RDDxPmdNREoYySWJiaC3meYizdBzSMZwuGi14EgWfTY8kadKc8Vaj3m16oXifqnr69y3ryRnWWYP6FcGs` | 1555 | 13,171 | vicinity_curve 13021 | 5,000 | 287 | FounderFeesClaimed | ok |
| 53 | halt | withdraw_platform_fees while halted (works) | `46mYaZdPFPZqafwa2Mypn2Rcsh6JsWDZw3mxDRJkdkXKqs1rvkeQAnC1wTk4p6QaUJ81fWAa84yEZ6a9hMdBz8mB` | 1558 | 12,636 | vicinity_curve 12486 | 5,000 | 319 | PlatformFeesWithdrawn | ok |
| 54 | buyback | buyback_burn 990000001 (pool; pending 4694713) | `5FWiRc3Scrx6hh7vPehTD5GU98h75L67DiGxFGBNKMWdX6j16VaHqU9b5SJQ1Kje46u7NyU2jXZYyJxg6b5hrEjG` | 1589 | 19,775 | vicinity_curve 19625 | 5,000 | 418 | BuybackBurned | ok |
| 55 | recover | admin set_pause({"launches":false,"buybacks":null,"buys":false}): the recovery | `47BcpKEEcRUPhaeAZ9TWJ7uC88ryZqf7nM6Sn84ivkpchtWTqRwYYBCY7wTz7y4qECjUmSWmGHGf9b4ikzRa9YH4` | 1593 | 4,045 | vicinity_curve 4045 | 5,000 | 219 | PauseChanged | ok |
| 56 | trade | buy trader-1 0.01 SOL (pool) | `2dPA3SF1JkZQ7KBrdPm9JePrAz3GKH2QmByxYoj2yvFzrXaDSVxQMHQmnrESzEFv8DAxsGkJg9RtfBPSCsvA4qcr` | 1597 | 29,780 | ATA 4338, vicinity_curve 25292 | 5,000 | 543 | Trade | ok |
| 57 | halt | guardian vault: set_pause(buys = false) through Squads (refused: the guardian can only stop) | `4FU1imVLmzLjbhYr6tnqXt6TMTSgkBpAioSEjzZuGUXy1AjftvLKhLAhgUmHfsd2hBB1Mhn3xQFnwqZAPnQf1NK6` | 1657 | 70,394 | Squads v4 21921, Squads v4 15829, Squads v4 8550, Squads v4 23944 | 5,000 | 635 |  | refused: Unauthorized |
| 58 | halt | admin set_pause(buybacks = true) alone (refused: buybacks halt only with buys, LL-1) | `X3RDbEER2odoyXbMuixrTzVNx8VoA9g4eB2s51mvaPyCHv4JUQn5xS1jR9C9WjfXadUC5wcwCVXL7LfKUiVXxGW` | 1661 | 5,073 | vicinity_curve 5073 | 5,000 | 218 |  | refused: BuybackHaltWithoutBuyHalt |
| 59 | halt | admin set_pause(buys = true, buybacks = true) | `2LwT8BaoiuzbuzQMeHnx9Q8uYx6gsXiw33urTbL9ze7PU5ui9uWS6rdG1QvVGDQt87zD7LZGCNyjBBMQe6q3G65x` | 1664 | 4,047 | vicinity_curve 4047 | 5,000 | 219 | PauseChanged | ok |
| 60 | halt | buyback_burn while buybacks are halted (refused) | `5hj4kiR4v2zCguk4nEPQctFrPsF3vCR778JNDa2u4BXVuJWqBbJkhzEeQLobq73Vs9vv3yFX57eUb3XjtxRrDcbx` | 1741 | 11,081 | vicinity_curve 10931 | 5,000 | 418 |  | refused: BuybacksHalted |
| 61 | halt | admin set_pause(buys = false) while buybacks stay halted (refused: buys never reopen before buybacks) | `2McHdo5JSSKmA8SpgKPSKd51duMYZSzbE57MCYi4S2gtwQRB5Map7VV24i1TSVrCiVi9yRzfshpLpLQudB6o4WcE` | 1743 | 5,072 | vicinity_curve 5072 | 5,000 | 218 |  | refused: BuybackHaltWithoutBuyHalt |
| 62 | recover | admin set_pause(buybacks = false): buybacks first | `22uds1XctAVoyHjk7NSw2XgnGn4tX7UJdtJ6m4dJLUrXtHsVAWTGAwZE1wUdd822BD7pd2pqZ2tzSi2V9Ncu1V48` | 1746 | 4,031 | vicinity_curve 4031 | 5,000 | 218 | PauseChanged | ok |
| 63 | recover | buyback_burn with buys still halted (the keeper drains the backlog) | `4fzZZRW3dRVqMMjrWtFLoRuVwQ8R9mUZNUM7iNwgFJRmBhai9mRVziWfpsoXvoawcqbTQpskBJRiGdbhCD363XVV` | 1749 | 19,775 | vicinity_curve 19625 | 5,000 | 418 | BuybackBurned | ok |
| 64 | recover | admin set_pause(buys = false): then buys | `2ZyT5m8cdX1XyqfKsKvyrQSKwvQuqH4u4oyzevhiLwJCi1shLbXCRV1i1Zsf24UQc9ELbSceQe4XYLCKMBQcp9ix` | 1752 | 4,034 | vicinity_curve 4034 | 5,000 | 218 | PauseChanged | ok |
| 65 | per-city | approve_launch(990000003, D01C) for a city that is also in batch 1 | `2cpYYZgM9QvpQjXeVpNWxRd35azVpViK6Hv1nS2W3rsTSfmzr5LJdh2ujZoVHJNQDSd3dR38EpK4E8SXg8YKGLFX` | 1923 | 29,500 | vicinity_curve 29500 | 5,000 | 617 | LaunchApproved | ok |
| 66 | alt | create the lookup table (11.3) | `67nqKmvR8rL6YXBjqRqjnzvV4TJk47c1aF6UahNeQBChSAdhsBJUT7A2zJwZA6fjzhXiLgR6cp17DcxHPGZsdFaU` | 2505 | 10,499 | ALT 10499 | 5,000 | 252 |  | ok |
| 67 | alt | extend the lookup table with 15 static addresses | `2XpTdghRRfn4pBT6ck334uDHcHGnSvJ4vbt9xKUfqCgTTqNkgGSGuohMZGv6Cfscv4pNMA4wRcuoEgBvUEj59keK` | 2508 | 10,187 | ALT 10187 | 5,000 | 732 |  | ok |
| 68 | batch-launch | launch_from_batch(990000002, batch 1, proof 3) + token account + first buy 0.02 SOL (refused) (with the lookup table) | `1QoRhgvup5kdLs44sNPQky4wzP3VzfVWGABDDpAnvd2jYD9ZFrfQ1BPkFC5X7bR8K4pbPmPBTPx2bjpfz244jRb` | 3214 | 65,074 | vicinity_curve 64924 | 5,000 | 829 |  | refused: BatchNotYetValid |
| 69 | batch-launch | launch_from_batch(990000002, batch 1, proof 3) + token account + first buy 0.02 SOL (with the lookup table) | `2vfp3B58echh5gpK9MK4jbkvJWisgLMFBZZKeeFLqku9TXTBmPb195EiE36G7iD3pv9rX5CmaWd15MbWaK8CawAt` | 113217 | 178,788 | vicinity_curve 139129, ATA 13414, vicinity_curve 26095 | 5,000 | 829 | CoinLaunched LaunchedFromBatch Trade | ok |
| 70 | batch-launch | launch_from_batch(990000003, batch 1, proof 3) + token account + first buy 0.02 SOL (refused) (with the lookup table) | `2wJWXBb5VqUwQ9SSqBgDsQgozZNbNbbVRYmr8cJ32SjsaVk4A4ugDEBS6smPoxqFkUX93rbJyy5kCBKE46SJGTtB` | 113229 | 45,732 | vicinity_curve 45582 | 5,000 | 829 |  | refused: ApprovalPending |
| 71 | per-city | revoke_approval(990000003) by the admin | `2L4i9jAMivYiCKzpSHHL3Ze1VhpHENiUg5RGyi3UtU1f2EjmEo7R75ASb33vrFpiTM4ranA3iAuRPrbovomCY6nX` | 113232 | 6,229 | vicinity_curve 6229 | 5,000 | 255 | ApprovalRevoked | ok |
| 72 | batch-launch | launch_from_batch(990000003, batch 1, proof 3) + token account + first buy 0.02 SOL (with the lookup table) | `m6PiKf8FmM7met7YmuqUHzvSFoiY16XcVZwYZLbprCTqBEEd3t87hruyehXA6XHtFDebSKZhhpCgtJ1b2B7TLG1` | 113236 | 173,970 | vicinity_curve 133041, ATA 14914, vicinity_curve 25865 | 5,000 | 829 | CoinLaunched LaunchedFromBatch Trade | ok |
| 73 | trade | buy trader-2 0.1 SOL of D01B (curve), creating the token account | `TNUyQHrzDwwN3uTmrpaqPh57bAiHSuL9YTjBvNjttCYHRTfc1BKMJQHBVgRByLJNo8QrtHkMgcYpcseYKZK3181` | 113262 | 42,662 | ATA 16417, vicinity_curve 26095 | 5,000 | 543 | Trade | ok |
| 74 | trade | sell trader-2 3471430607705 raw of D01B (curve) | `3tpdSRkRVVpYua8gnyN4PrHu33qCQRH9MKcWvnLGfbvQuFmLGtgv5yPxq92m3FJ5eTXUmzXTWpZCSmN2rRsP4uva` | 113266 | 23,731 | vicinity_curve 23581 | 5,000 | 501 | Trade | ok |
| 75 | guardian-stop | guardian-stop.mjs --clear (member 2): variant executed | `5aLC3mZ3V645barptisrqghFAcYUx1seRK3SHnsGHbXkcSnrkuy3iwSbR9iWaqASDCuWRxHCLHLmhLzD6g34P9bR` | 113280 | 83,632 | Squads v4 23503, Squads v4 15829, Squads v4 8550, Squads v4 35450 | 5,150 | 774 | LaunchBatchCleared | ok |
| 76 | guardian-stop | guardian-stop.mjs --clear (member 2): variant executed | `35GSUcfXQMijs5y7g1XgziYUksfgKP8EYa3iEELcEWcYF5wDyenxtkQogVPKkxYK1icjJA8MyjbuWCNJFP32H3Zi` | 113280 | 80,631 | Squads v4 23503, Squads v4 12829, Squads v4 8550, Squads v4 35449 | 5,150 | 774 | LaunchBatchCleared | ok |
| 77 | guardian-stop | guardian-stop.mjs --clear (member 2): variant executed | `5Q8CYHHNUES94eHzFeuag2V6t6chqxDzgg2Dr5oEdgMRHHhiMqA5AiWDrjTUrPRyqXrQf2i12Zhy5voTTJXJFMXj` | 113280 | 82,131 | Squads v4 23503, Squads v4 14329, Squads v4 8550, Squads v4 35449 | 5,150 | 774 | LaunchBatchCleared | ok |
| 78 | guardian-stop | guardian-stop.mjs --clear (member 2): variant executed | `3kDxv8toF9srizjviJYd3JCQdRq8jLHQp6LeQoSrgDL3xHV8yc1gfqRoLR16FXxfkimNqcDnToY9iU7UQPToxu11` | 113280 | 80,631 | Squads v4 23503, Squads v4 12829, Squads v4 8550, Squads v4 35449 | 5,150 | 774 | LaunchBatchCleared | ok |
| 79 | clear | publish_launch_batch by the approver while the batch path is halted (refused) | `47KxaBdwQ8mHCVmN8TVpJHv8FJCx8shpXBpb5q2EymC3dVtSrkSS8HyZRaH4yGtw7KC76kcZRjvKFRuSWchjsGdE` | 113362 | 9,625 | vicinity_curve 9625 | 5,000 | 340 |  | refused: BatchesHalted |
| 80 | recover | set_launch_approver(approver2): lifts the halt, clears both records | `5yhamgrVPaLmSUtKhw8tnnb6WHwt84sKxM3GghKkzwFVdShnUtYCMoqph6qA6tXGimRa88rkBH1QUVpTFesNRHFJ` | 113379 | 13,365 | vicinity_curve 13365 | 5,000 | 312 | LaunchApproverChanged | ok |
| 81 | clear | publish_launch_batch (the verifier's transaction, signed by the new approver) (message hash FD1Kh983iwP6uS8a4zH7YquYxRvJ16UgB2x6guSjzkYk) | `2B5JZKT8AyQ8Rkhzu5mJXQbE4PPsL8VM1WYhB42gc1W4mgmkohw5d4V3wz8rjwnH1zJKyBtYw7uJ5yzMNy1vABZi` | 113384 | 13,449 | vicinity_curve 13449 | 5,000 | 338 | LaunchBatchPublished | ok |
