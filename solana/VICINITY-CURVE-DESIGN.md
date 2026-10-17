# `vicinity_curve`: audit specification of the fully custom Vicinity launchpad

Status: specification for the build and for the outside audit, revision 3, 17 October 2026.
Revision 3 folds in the implementation notes of the build (`VICINITY-CURVE-NOTES.md` entries 1 to
56: every clarification and accepted deviation) and answers review rounds 1 (GOV-1, GOV-2, CLI-1,
CLI-2, CLI-3), 2 (R2-DIFF-1, SPEC-1, ECON-1, FA-1) and 3 (R3-DIFF-1, MATH3-2, LL-1, R3-CLI-1,
MATH3-1, HR-1) of the build; revision 2 answered the security, math, runtime and integration review
of revision 1. Appendix C lists every finding of each review, what changed and the parts that were
not applied, with reasons, and the notes folded in. The program, its math crate, its client SDK and
its test suites are built (branch `feat/vicinity-curve`); nothing has been deployed or signed.
Devnet uses a throwaway program key only. Mainnet needs the owner, the Squads vault `AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X`
(2 of 3) and the outside audit. The existing programs `vicinity_launchpad`
(`AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai`) and `vicinity_rewards`
(`EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG`), $VICINITY
(`2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray`) and every user, balance and token stay
untouched. `vicinity_rewards` is used exactly as deployed today.

This file merges two independent designs, `vcurve-design/A.md` (security-first minimalism)
and `vcurve-design/B.md` (economics and integration). Where they differed, the safer choice
was taken; section 0.2 lists every such decision and its reason. Every number in sections 5
and 7 was recomputed for revision 2 with exact integer arithmetic by the reference model in
Appendix A (Python big integers, every u128 bound asserted). Compute-unit and binary-size
figures in section 11 are estimates until the program is built and measured.

Contents: 0 Summary and merge decisions. 1 Scope and non-goals. 2 Requirements
traceability. 3 Accounts. 4 Instructions (with events and errors). 5 Math. 6 Fee booking and
every payout and burn path. 7 Buyback and burn. 8 Admin powers and upgrade authority.
9 Invariants. 10 Threat model. 11 Compute and size budgets. 12 Test plan. 13 Owner
decisions. 14 Website and aggregator integration. Appendix A Reference model. Appendix B
Sources. Appendix C Review responses.

---

## 0. Summary and merge decisions

### 0.1 The design on one page

1. **One new program, `vicinity_curve`, runs a city coin's whole life**: admin approval,
   launch, bonding curve, graduation, the pool after graduation, fee booking, payouts and
   buyback-and-burn. No Meteora program, no other AMM, no third party receives anything.
2. **One permanent `Coin` account per city** (`["coin", city_id u64 LE]`; Rust struct
   `CurveCoin`, 3.7) is the city's record and its market. It stores the frozen terms (fee
   split and curve, copied from the config at launch), the curve or pool reserves, the five
   fee buckets and every lifetime counter. **All of the coin's SOL is held as native
   lamports of this account.** The coin's tokens sit in one SPL token account owned by it. A
   permanent `TickerLock` per ticker enforces one coin per ticker, and the old program's
   accounts are checked at every approval and every launch, including that the old program is
   administered by the same multisig as this one (R1 across both programs, 8.5).
3. **The curve and the pool are two phases of the same account.** The curve is the pump.fun
   constant product on virtual reserves, implemented as an exact integer state function of
   the coins sold. Graduation is a field change inside the buy that takes the last curve coin:
   no CPI, no account creation, no keeper, nothing to pre-create or front-run.
4. **Fee: at most 2.5% of the SOL leg of every user buy and sell through this program, on the
   curve and after graduation, rounded down to the lamport** (so it never exceeds 2.5%),
   split 0.5% liquidity, 0.7% Vicinity platform, 0.5% city founder, 0.5% city holder
   rewards, 0.3% buyback and burn. Each named share is rounded down; the rounding remainder
   (0 to 4 lamports) stays in liquidity. All five shares are booked inside the trade
   (automatic). Moving money out of a bucket is a separate instruction with its own
   counters. The coin's own buyback pays no fee (an owner sign-off, O7).
5. **R8 economics to the raw unit**: 1,000,000,000 coins minted at 6 decimals; exactly
   793,099,990 coins sold on the curve; exactly 206,900,000.9 coins kept for the pool; the
   curve holds exactly 85 SOL when it completes; virtual reserves 30.000853639 SOL and
   1,073,025,598.486615 coins; start market cap 27.959 SOL, end 410.826 SOL; launch fee 0.05
   SOL, all to Vicinity. R8's own figures leave 9.1 coins over (today DBC sends them to the
   dev wallet); by default they are burned in the launch transaction, so the supply after
   launch is 999,999,990.9 coins. The owner chooses between this and the two alternatives
   before the audit freeze (O3).
6. **The 0.5% liquidity share** enters the pool's SOL reserve inside every trade after
   graduation (without adding coins, so it deepens the pool and raises the price; like all
   pool SOL it is paid to sellers through trades). Before graduation it is set aside
   (`liquidity_pending`) and, after graduation, each trade moves at most its own rounded-down
   liquidity share of it into the pool. The pool therefore opens at the curve's last price
   (2.0 parts in a trillion below it, never above). **If a coin never graduates, its
   set-aside share is never used and stays locked forever** (owner sign-off, O2).
7. **Buyback and burn** is a permissionless crank: at most once per 150 slots per coin, at
   most 0.1% of the market's SOL depth per run, no fee, coins burned with SPL `burn`, never
   graduates the coin. A sandwich around one run loses at least 3.77% of the attacker's money
   (canonical form), at least 2.78% under a conservative split-leg bound, and at least 1.79%
   for a founder credited his own share (section 7.3). A trader who buys and holds through
   many runs profits only if the public backlog that gets spent while he holds exceeds about
   2.0% to 2.6% of the market's depth (1.5% to 2.0% for a founder credited his share), and
   then only after 21 to 26 runs (16 to 21 for a founder; about a minute each) with no other
   trading (Theorem M_K); that residual risk is stated, tested and needs the owner's sign-off
   (O25). These bounds do not cover whoever holds the platform's key (`FEE_RECIPIENT`, credited
   the platform share of its own legs; 7.3): an operating rule keeps it and the owner's wallets
   out of city coins (8.4, O29).
8. **Admin powers are minimal and listed** (section 8). Within `vicinity_curve` the admin can
   approve or revoke launches, add or disable future configs inside compiled caps, pause new
   launches, payouts, buys and buybacks, set the payout key and wallet, set the guardian and hand over
   the admin seat in two steps; it has no path to any lamport or token and cannot change a
   live coin. **The same Squads multisig is also the upgrade authority and publishes the holder
   reward rounds in `vicinity_rewards`**, so it is the main trust in the system (8.1). A
   separate **guardian** key can only stop buys, buybacks and launches at once; nothing can
   stop sells, claims, forwards or withdrawals. Upgrades wait behind a 48-hour time lock once
   the first coin is live (O11).
9. **Integration**: `buy(sol_in, min_tokens_out)` and `sell(tokens_in, min_sol_out)` take
   the same 10 fixed accounts before and after graduation; no remaining accounts; a `no_std`
   pure integer math crate that the program itself calls and that off-chain code reuses; a
   fixed-offset `Coin` layout; an event CPI for every trade. Whether each aggregator can route
   native SOL in and out is not proven yet and must be confirmed before the audit freeze
   (O10, O23).

### 0.2 Decisions where the two designs differed (the safer choice, and why)

Rows M3, M4, M7, M8, M11, M12, M16 and M21 were revised after the review (Appendix C).

| # | topic | A said | B said | chosen | reason |
|---|---|---|---|---|---|
| M1 | SOL custody | native lamports in the `Coin` PDA | WSOL token account per coin | **native lamports** (A) | One writable account and one token CPI fewer per trade; no payout ever depends on a recipient's WSOL account existing (the previous audit's highest finding, R2/F1, was a missing dev-wallet WSOL account breaking every trade); no token-account authority, delegate or close fields to prove unused; every debit passes one audited helper that checks rent plus all remaining liabilities, and the runtime separately refuses any debit that would leave the account below rent exemption. Not proven: that every aggregator and terminal can route a native-SOL hop with a signer `user` (design B argued that DBC, DAMM v2, Raydium and PumpSwap all use WSOL). Written confirmation is required before the audit freeze; WSOL is owner decision O10 |
| M2 | curve state | `quote_reserve += net`, kept tight by a lemma | `curve_sol := f(tokens_sold)` recomputed after every curve operation | **state function** (B) | The curve invariant holds by construction instead of by proof; the curve can never take more than the net amount; any shortfall is handled by charging less (gross-up), never by drifting state. Both describe the same curve (section 5.3) |
| M3 | 9.1 leftover coins | burn at launch (R8 pool figure exact) | put in the pool (supply exactly 1,000,000,000) | **burn at launch** (A), revised | R8 binds the pool figure (206,900,000.9 coins) and no requirement forces a change; R8's figures are themselves 9.1 coins short of 10^9, so every option keeps two figures or adds a path (5.9, O3). The pool option and the dev-wallet option stay owner alternatives |
| M4 | continuity rule | one-sided: the pool never opens above the curve | two-sided: within 1e-9 | **one-sided** (A) with A's integers | A pool that opens above the curve's last price is the only shape of graduation arbitrage; forbidding it for every config is free. With R8's pool figure the integer search gives design A's integers: `virtual_sol = 30,000,853,639`, `virtual_tokens = 1,073,025,598,486,615`, 2.0e-12 below the curve (section 5.9) |
| M5 | fee split formula | `floor(fee * bps / total)` | `floor(amount * bps / 10,000)` | **share of the trade amount** (B) | Each recipient provably receives at most its advertised basis points of the trade, which is exactly what the website and R9 claim; no division by the total; the remainder from rounding goes only to liquidity |
| M6 | platform cap and the 0.5% bucket | platform at most 1.0%, bucket set by `fee_lp_bps` | `liquidity_mode` field, Vicinity at most 1.2% | **no mode field; platform at most 1.2%** | The 0.5% bucket's destination stays a config choice (R2) by moving its basis points to another bucket in a new config, with no branch in the trade path; the cap of 1.2% (0.7% + 0.5%) keeps the owner's "send it to Vicinity" alternative possible without an upgrade |
| M7 | buyback size | `depth * fee / 4` (0.625%) | `depth * fee / 5` (0.5%) | **`depth * fee / 25` (0.1%)**, revised | With the founder credited his own share (V8) a 0.5% step leaves almost no margin (0.98993 against 0.99) and a 1% step fails; a smaller step also lengthens the hold that a multi-run strategy needs (21 to 26 runs instead of 5 to 6, Theorem M_K). Cost: a backlog forms at a fifth of the volume (7.2) |
| M8 | buyback may graduate the coin | yes | no (capped at `curve_supply - 1`) | **never graduates** (B) | Graduation always happens inside a user buy, one code path. Its timing is not protected and does not need to be (V7): anyone can bundle a buyback with a 0.0001 SOL buy that completes the curve |
| M9 | buyback minimum and stale rule | none | 0.001 SOL minimum, any remainder after a day | **none** (A) | Fewer rules; the rate limit already bounds frequency; small runs are harmless and less sandwichable |
| M10 | first buyback | immediately after launch | at least 150 slots after launch | **150 slots after launch** (B) | Nothing runs in the launch block, where sniping is heaviest; at the 0.1% step the delay holds back at most one run (0.030 SOL at launch) |
| M11 | buyback MEV bound | `(1-f)^2 (1+f/4)^2`, ignoring liquidity injected after graduation | includes the injected liquidity, with a config rule | **B's analysis, strengthened**: canonical bound, split-leg bound with the founder's credited share, multi-run bound, and config rules V8 and V11 | After graduation the attacker's own liquidity share (and drip) raises the pool's SOL before his sell; A's bound missed that. A founder receives his share of his own legs; revision 1 missed that. A public backlog is spent over several runs; revision 1 analysed one run only |
| M12 | minimum trade | none | 0.0001 SOL per buy | **0.0001 SOL per buy, no minimum on sells** (B, plus a new rule) | With the fee rounded down, a buy under-pays by less than one lamport on at least 100,000 (below 0.001%); splitting buys therefore saves nothing worth a signature; sells have no minimum so no holder is ever prevented from exiting |
| M13 | slippage on the partial fill | price limit `out * in >= min * charged` | `tokens_out >= min_tokens_out` | **strict minimum** (B) | Exact-in semantics that routers expect; one comparison; the math crate exposes `max_quote_in` (A) so a client can size the completing buy exactly |
| M14 | mint address | fresh keypair (signer) | PDA `["mint", coin]` | **PDA** (B) | No keypair to generate, leak or grind; one signature fewer in the launch transaction; the mint is derivable from `city_id` |
| M15 | coin token account | ATA of the `Coin` PDA | PDA `["token_vault", coin]` | **PDA `["coin_vault", coin]`** (B) | Only this program can create it; no associated-token program in `launch` |
| M16 | R1 across both programs | not checked | `approve_launch` requires the legacy program's `Coin` PDA to be empty | **checked at approval and at launch** (B, strengthened) | Both `approve_launch` and `launch` require the old program's `Coin` and `Approval` PDAs for the city to be empty and its launches to be paused, so "one coin per city" holds at every launch, not only at approval time |
| M17 | who may revoke an approval | admin only | admin, or anyone once it has expired | **admin, or anyone after expiry** (B) | Cleanup without the multisig; rent still goes to the payer; no new power |
| M18 | lifetime counter width | u128 | u64 checked, statistics saturating | **u128** (A) | A statistic can never overflow and block a trade, so the question never arises |
| M19 | `Coin` seeds in trades | re-derived | owner and discriminator only | **re-derived** (A) | Defence in depth on the hottest path, for about 1,500 compute units |
| M20 | events | event CPI for everything | event CPI for money, logs for settings | **event CPI for every money movement, `emit!` for settings** (B) | Money events cannot be truncated; admin instructions keep short account lists |
| M21 | upgrade time lock | none while young | 48 h once coins are live | **48 h once the first mainnet coin is live, plus a guardian that can stop buys at once** (B, completed) | The upgrade key controls every coin's reserves; holders can always sell during the delay. A time lock alone left no fast brake; the guardian is that brake and can never stop exits. The lock also delays every proposal of the same multisig for the existing programs (8.4); the owner decides (O11) |
| M22 | graduation target bound | 1 to 10,000 SOL | 1 to 100,000 SOL | **1 to 10,000 SOL** (A) | Tighter bounds on every product |
| M23 | "nothing to do" in cranks | return `Ok` without effects | return an error | **`Ok`, no state change, no event** (A, today's convention) | A keeper can batch many coins in one transaction |
| M24 | instruction names | new names | today's names | **today's names** (`init_launchpad`, `add_launch_config`, ...) | Reviewers and the SDK already know them |

---

## 1. Scope and non-goals

### 1.1 In scope

* The Anchor program `vicinity_curve` (new program id), its 21 instructions, its accounts,
  events and errors.
* The pure integer math crate `vicinity-curve-math`, which the program calls for every
  number it computes, and which an SDK, an indexer or an aggregator adapter can reuse.
* The integration contract with `vicinity_rewards` as deployed (read its `CityConfig`,
  credit its WSOL vault).
* What the website and aggregators must change (section 14), the test plan (section 12) and
  the owner decisions (section 13).

### 1.2 Non-goals

* No change to `vicinity_launchpad`, `vicinity_rewards`, $VICINITY or any existing account.
* No mainnet deployment, no key generation for mainnet, no network transaction of any kind
  in this step.
* No Token-2022, no transfer fee, no transfer hook, no permanent delegate, no freeze
  authority (R3).
* No quote asset other than SOL. No coin-to-coin routing inside the program.
* No third-party liquidity provision: there is no add-liquidity or remove-liquidity
  instruction, no LP token, no position. The pool's liquidity is the coin's own and cannot be
  withdrawn as liquidity.
* No exact-out trade instruction (clients compute exact-out off chain with the math crate).
* No on-chain list of official cities (owner decision O15), no governance, no anti-sniper
  fee (O20).
* No pause of exits: no key can stop sells, founder claims, forwards or withdrawals. The
  guardian and the admin can stop buys, buybacks and launches (section 8.3).
* No on-chain IDL account (the IDL instructions are compiled out, 3.1 and 8.4).

### 1.3 Ground rules

* Devnet only with a throwaway program key. Mainnet only with the owner, the Squads vault
  and the outside audit.
* The program stores no fee recipient: Vicinity's money can go only to the compiled
  constant `FEE_RECIPIENT` `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` (R9). The other
  programs it talks to (`vicinity_rewards`, the old `vicinity_launchpad`) are compiled
  constants too (3.2).
* Stored counters, never account balances, decide prices and amounts (R12). The only place
  a balance is read is the belt-and-braces floor check in `pay_out` (section 6.5), which can
  only refuse.

### 1.4 Terms

* **lamport**: 10^-9 SOL. **raw unit**: 10^-6 coin. All amounts are unsigned integers.
* **Curve phase / Pool phase**: the two phases of a coin (`Coin.phase` 0 and 1).
* **Automatic**: booked on chain inside the trade instruction itself.
* **Separately executed**: a later instruction moves the money or burns the coins.
* **Bucket**: one of the five per-coin fee balances (`liquidity_pending`,
  `platform_pending`, `founder_pending`, `holders_pending`, `buyback_pending`).
* **Liabilities** of a coin: the reserve of its phase plus the five buckets.
* **Guardian**: a key stored in `Launchpad` whose only power is to stop buys, buybacks and
  launches (8.3).
* **Depth**: the market's SOL side used for buyback caps: `virtual_sol + curve_sol` on the
  curve, `pool_sol` in the pool.

---

## 2. Requirements traceability

| req | requirement (short) | where it is met | invariants | tests |
|---|---|---|---|---|
| R1 | one city, one coin, one community; admin approval naming founder, city, ticker, expiry; ticker lock | `Coin` PDA per `city_id`, never closed (3.7); `TickerLock` per ticker, never closed (3.8); `approve_launch`, `launch`, `revoke_approval` (4.8 to 4.10); old program's `Coin` and `Approval` empty and its launches paused, checked at approval and at launch (4.8, 4.10, 8.5) | I19 | L04, L05, X33 to X35, 28-governance |
| R2 | 2.5% on every buy and sell, curve and pool, split 0.5/0.7/0.5/0.5/0.3, nothing on top, never above 2.5%; 0.5% default "added to locked liquidity", a config field | fee rounded down and split (5.2), same code in both phases (5.4 to 5.8), cap `MAX_TOTAL_FEE_BPS = 250` (3.2, V1), liquidity bucket (5.8), labels (6.6), decisions O1, O2. **Exceptions to record**: the coin's own buyback pays no fee (7.1; owner sign-off O7); pools that third parties create for this classic SPL coin are outside the program and pay no Vicinity fee (6.6, 13, 14.5) | I3, I12 | U01, U02, P08, L06, L08 |
| R3 | no fee on wallet transfers; classic SPL; no hook, delegate, freeze; mint authority removed | mint created by the program under classic SPL Token with no freeze authority; mint authority set to `None` in `launch` (3.10, 4.10) | I11 | L05, X04, X39 |
| R4 | future splits changeable within compiled caps; live coins keep their split forever | `LaunchConfig` immutable except `enabled` (3.5); terms copied into `Coin` at launch, never written again (3.7); caps and rules V1 to V11 (5.13) | I2, I3, I20 | V01 to V11, L03, P10 |
| R5 | automatic vs separately executed, counters for everything | table 6.3; counters in `Coin` (3.7); events (4.21); labels (6.6) | I7, I8, I13, I16 | L13, F01 |
| R6 | founder claim and optional payout; holders forwarded to `vicinity_rewards`, Merkle rounds | 4.15, 4.16, 4.18 to 4.20; 6.4; the holders' path checks the rewards config's authority (4.15) | I14 | L10, R01 to R03 |
| R7 | buyback and burn: accrues per coin, buys at the curve or pool price, SPL burn, tracked, separate crank with caps and rate limit, MEV analysed | 4.13, section 7 (single run, split legs, founder credit, multi-run backlog), V8, V11 | I15 | L09, P06, P06b, X24, X25 |
| R8 | 10^9 coins at 6 decimals; ~30 SOL / ~1,073,000,000 coins virtual; 793,099,990 sold; 206,900,000.9 kept; graduation at 85 SOL; launch fee 0.05 SOL to Vicinity with a cap | default config #0 (3.5); integers and proofs (5.9); launch fee (4.10). R8's coin figures are 9,100,000 raw short of 10^15; the default burns the difference at launch (keeps the sold and pool figures exactly), O3 lists what each alternative keeps | I5, I11 | U04, U05, L05, L07 |
| R9 | platform fees only to `FEE_RECIPIENT` | constant; only `withdraw_platform_fees` and the launch fee pay it (4.10, 4.14) | I14 | X43, L10 |
| R10 | Squads as admin and upgrade authority; minimal listed admin powers; website holds no approving or money key | section 8 (one row for every role of the Squads vault, including its roles in `vicinity_rewards`; guardian; time lock) | I21 | L02, L12, X43, X43b |
| R11 | aggregator integration: fixed account lists, slippage, pure quote module, events | 4.11, 4.12, 5.16, 4.21, section 14 (integration conditions in 14.3) | I12 | G01, G02, L06 |
| R12 | security first: minimal surface, no stuck states, no rounding extraction, donation-proof, stored reserves rule, checked math, every account validated | sections 5, 6.5, 9, 10; validation in every instruction table (4); the order rule for CPIs after lamport moves (4.0); intended permanent balances named in I22 | I4 to I10, I18, I22 | sections 12.2 to 12.6 |

---

## 3. Accounts

### 3.1 Program, crates and build

| item | value |
|---|---|
| program | `vicinity_curve`, crate `programs/vicinity-curve`; one file per instruction (`handle_<name>`), as in `vicinity_launchpad` |
| math crate | `crates/vicinity-curve-math`: `#![no_std]`, `#![forbid(unsafe_code)]`, depends only on `core`; u64 in, u128 inside, `Result<_, MathError>` out. The program calls these functions for every number it computes (5.16) |
| program id | new. Localnet and devnet: a throwaway keypair. Mainnet: generated by the owner on his own machine; upgrade authority the Squads vault |
| toolchain, pinned exactly | `anchor-lang = "=0.31.2"` (feature `event-cpi`); `anchor-spl = "=0.31.2"` (`default-features = false`, features `token`, `token_2022`, `token_2022_extensions`, `associated_token` and `metadata`: the two this program uses do not compile alone, and none of the other code is reachable, which the checklist test enforces by refusing `Token2022`, `token_interface` and `AssociatedToken` in the crate; NOTES 18); `mpl-token-metadata = "=5.1.1"` (what `Cargo.lock` resolves for anchor-spl 0.31.2's `^5`); `Cargo.lock` committed. The existing programs' `Cargo.toml` says `"0.31.1"`, a caret requirement, and their `Cargo.lock` resolves 0.31.2, so 0.31.2 is what they were built with. Agave solana-cli 4.3.0, cargo-build-sbf 4.4.0, platform-tools v1.57 (as `release/mainnet-2026-10-10/BUILD.md`). All versions and the binary hash go into the audit pack (C03) |
| release profile | `overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`, `opt-level = 3`. `lto` has no effect while the crate keeps Anchor's two crate types (`cdylib` and `lib`), as both deployed programs do; dropping `lib` is left to the auditors and the owner (NOTES 19) |
| features | `no-idl` (in the crate's default features, so every build, including the verifiable build, leaves Anchor's IDL instructions out; 8.4); `devnet` (switches the compiled ids of 3.2 to the devnet deployments); `halt-all` (the pre-audited emergency build, 8.3). Besides these, only Anchor's tooling features, which change no deployed behaviour: `cpi`, `no-entrypoint`, `no-log-ix-name`, `idl-build` (the client IDL, 8.4) and `short-windows`, accepted and ignored for the workspace's CI (NOTES 17) |
| stack | every typed account in `launch`, `approve_launch` and `forward_holders_fees` is `Box<...>`, and the coin is `Box<Account<'info, CurveCoin>>` in every instruction (today's `launch.rs` boxes for the same reason: SBF stack frames are 4 KB). CI fails on any cargo-build-sbf "Stack offset ... exceeded" warning (C04) |

### 3.2 Constants (policy values carry `#[constant]` so they appear in the IDL)

| constant | value | reason |
|---|---|---|
| `FEE_RECIPIENT` | `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` | R9: only destination of platform fees and launch fees; changing it needs an upgrade |
| `REWARDS_PROGRAM_ID` | mainnet build `EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG`; `devnet` build `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi` (LAUNCHPAD-DEVNET.md) | owner of every rewards config and vault the holders' share may go to; compiled, never an argument |
| `LEGACY_PROGRAM_ID` | mainnet build `AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai`; `devnet` build `Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7` | the old program whose `Coin`, `Approval` and `Launchpad` accounts are checked for R1 |
| `LEGACY_LAUNCHPAD` | the address `find_program_address(["launchpad"], LEGACY_PROGRAM_ID)`, compiled per cluster; unit test U12 checks the derivation | the old program's global account (171 bytes: discriminator, five Pubkeys, `launches_paused` at byte 168, `payouts_paused` 169, `bump` 170) |
| `LEGACY_LAUNCHPAD_DISCRIMINATOR` / `LEGACY_LAUNCHPAD_LEN` / `LEGACY_LAUNCHES_PAUSED_AT` | `sha256("account:Launchpad")[..8]` / 171 / 168 | read-only check of the old program's pause (4.8, 4.10) |
| `LEGACY_ADMIN_AT` / `LEGACY_PENDING_ADMIN_AT` | 8 / 40 | the old program's `admin` and `pending_admin`: at every approval and launch the old admin must be this program's admin with no transfer pending (4.8, 8.5) |
| `REWARDS_REGISTRY` | the address `find_program_address(["registry"], REWARDS_PROGRAM_ID)`, compiled per cluster (mainnet `2i9xvFtxnnToASy7yuaV7eq2aQTstXpLTRYvJ6mUs4yG`, devnet `2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3`); U12 checks the derivation | `vicinity_rewards`' registry, whose admin alone signs `init_city` (review OPS-1) |
| `REWARDS_REGISTRY_DISCRIMINATOR` / `REWARDS_REGISTRY_LEN` / `REWARDS_REGISTRY_ADMIN_AT` / `REWARDS_REGISTRY_PENDING_ADMIN_AT` | `sha256("account:Registry")[..8]` / 73 / 8 / 40 | at every approval and launch the registry admin must be this program's admin with no transfer pending (4.8, 4.10, 8.4) |
| `COIN_SUPPLY` | 1,000,000,000,000,000 raw | R8 |
| `COIN_DECIMALS` | 6 | R8 |
| `BPS` (`D`) | 10,000 | denominator |
| `MAX_TOTAL_FEE_BPS` | 250 | R2, R4: a config's five shares never add up to more than 2.5% |
| `MIN_TOTAL_FEE_BPS` | 1 | keeps the buyback cap and the MEV bound meaningful; also the least a trader credited the founder's share, the holders' share or both pays per leg (V2b) |
| `MAX_PLATFORM_FEE_BPS` | 120 | Vicinity's own share never exceeds 1.2% (0.7% + the 0.5% bucket if the owner ever routes it to Vicinity, O1) |
| `MAX_FOUNDER_FEE_BPS` | 100 | a founder's share never exceeds 1.0%: bounds what a founder gets back from sandwiching or wash-trading his own coin (V2, V8); V2b keeps it, together with the holders' share, below the whole fee, so his own trades always cost him at least `MIN_TOTAL_FEE_BPS` per leg, also when he holds the float (review R3-DIFF-1) |
| `MIN_TRADE_LAMPORTS` | 100,000 (0.0001 SOL) | smallest `sol_in` of a buy (5.2, O5) |
| `BUYBACK_CAP_DIVISOR` (`C`) | 25 | a buyback spends at most `depth * total_fee_bps / (25 * D)` (0.1% of depth at 2.5%) |
| `BUYBACK_INTERVAL_SLOTS` | 150 (about 60 s) | at most one buyback per coin per interval; the first one at least 150 slots after launch |
| `BUYBACK_MIN_HORIZON_RUNS` / `BUYBACK_MIN_HORIZON_RUNS_FOUNDER` | 20 / 15 | config rule V11: a hold through fewer runs than this is provably unprofitable for any trader / for a founder credited his share (7.3) |
| `MEV_MAX_PERCENT` | 99 | config rule V8: conservative single-run bound at most 0.99 (a loss of at least 1%) |
| `MAX_DUST_RAW` | 1,000,000,000 (1,000 coins) | most a config may burn at launch (`COIN_SUPPLY - curve_supply - pool_supply`) |
| `MAX_VIRTUAL` | 2^60 | bound on `virtual_sol` and `virtual_tokens` (5.12) |
| `MIN_GRADUATION_LAMPORTS` / `MAX_GRADUATION_LAMPORTS` | 1,000,000,000 / 10,000,000,000,000 | 1 SOL to 10,000 SOL |
| `CONTINUITY_PPB` | 1 | the pool opens at most 1 part per 10^9 below the curve's last price, never above |
| `MAX_LAUNCH_FEE_LAMPORTS` | 500,000,000 (0.5 SOL) | R8 cap (same as today) |
| `APPROVAL_MAX_SECS` | 2,592,000 (30 days) | reused |
| `PAYOUT_COOLDOWN_SECS` | 86,400 | reused |
| `METADATA_URI_PREFIX` | `https://vicinity.city/coin-meta/` | URI = prefix + mint (base58) + `.json` (reused) |
| `MAX_NAME_LEN` / `MAX_SYMBOL_LEN` | 32 / 10 bytes | reused (Metaplex limits) |
| `METAPLEX_PROGRAM_ID` | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | metadata for classic SPL coins |
| `NATIVE_MINT` | `So11111111111111111111111111111111111111112` | reward mint of the city's rewards vault |
| `REWARDS_CITY_CONFIG_DISCRIMINATOR` | `[14, 136, 110, 28, 46, 68, 178, 115]` | reused `read_rewards_city_config` |
| `REWARDS_MODEL_HOLDERS` | 1 | reused |
| seeds | `launchpad`, `config`, `approval`, `coin`, `mint`, `coin_vault`, `ticker`, `payout_opt_in`; rewards program: `city`, `vault`; old program: `coin`, `approval`, `launchpad` | |

The localnet test suite loads `vicinity_rewards` and the old `vicinity_launchpad` builds at
their mainnet addresses (litesvm can place a program at any address), so the binary the tests
exercise is the mainnet binary (the committed release binaries of `release/mainnet-2026-10-10`,
SHA-256 checked: an Anchor program runs only at its own `declare_id!`, so builds with the devnet ids
cannot serve there; NOTES 27); only the `devnet` feature changes the three ids (C03 records
the ids compiled into each binary).

### 3.3 Addresses, sizes and rent

Sizes include the 8-byte Anchor discriminator. Rent is the rent-exempt minimum
`(bytes + 128) x rate`: today's mainnet rate is 5,080 lamports per byte (as in
LAUNCHPAD-DESIGN.md section 5); litesvm uses 6,960. The program never uses these figures:
it asks the `Rent` sysvar.

| account | address | bytes | rent at 5,080 | rent at 6,960 | created by | closed by |
|---|---|---|---|---|---|---|
| `Launchpad` | PDA `["launchpad"]` | 238 | 1,859,280 | 2,547,360 | `init_launchpad` (payer) | never |
| `LaunchConfig` | PDA `["config", config_id u16 LE]` | 144 | 1,381,760 | 1,893,120 | `add_launch_config` (payer) | never |
| `Approval` | PDA `["approval", city_id u64 LE]` | 181 max | 1,569,720 | 2,150,640 | `approve_launch` (admin pays) | `launch` or `revoke_approval`, rent to `rent_payer` |
| `Coin` (`CurveCoin`) | PDA `["coin", city_id u64 LE]` | 693 | 4,170,680 | 5,714,160 | `launch` (payer) | never (no close instruction) |
| `TickerLock` | PDA `["ticker", symbol bytes]` | 49 | 899,160 | 1,231,920 | `launch` (payer) | never |
| `PayoutOptIn` | PDA `["payout_opt_in", coin]` | 145 | 1,386,840 | 1,900,080 | `opt_in_payout` (founder) | `revoke_payout_opt_in`, rent to `opt_in.founder` |
| coin mint (classic SPL) | PDA `["mint", coin]` | 82 | 1,066,800 | 1,461,600 | `launch` | never (classic mints cannot close) |
| coin vault (SPL token account) | PDA `["coin_vault", coin]` | 165 | 1,488,440 | 2,039,280 | `launch` | never (no code path signs a close) |
| Metaplex metadata | Metaplex PDA `["metadata", METAPLEX_PROGRAM_ID, mint]` | 679 | 4,099,560 | 5,616,720 | `launch` (Metaplex CPI) | never (immutable) |

`city_id` is the GeoNames id the site uses (`public/data/tickers.json`), a `u64`, at least 1.

### 3.4 `Launchpad` (one per program; 238 bytes)

| offset | field | type | meaning |
|---|---|---|---|
| 0 | discriminator | [u8; 8] | |
| 8 | `admin` | Pubkey | approves launches, adds and enables configs, sets any pause flag either way, sets the payout key and wallet and the guardian. Mainnet: the Squads vault |
| 40 | `pending_admin` | Pubkey | second step of an admin transfer; zero = none |
| 72 | `payout_authority` | Pubkey | key that may run opted-in founder payouts; zero = off (default) |
| 104 | `payout_destination` | Pubkey | system-owned wallet that receives opted-in payouts; zero = off |
| 136 | `guardian` | Pubkey | may only set `launches_paused`, `buys_halted` and `buybacks_halted` to true; zero = none |
| 168 | `launches_paused` | bool | blocks `launch` |
| 169 | `payouts_paused` | bool | blocks `payout_founder_fees` |
| 170 | `buys_halted` | bool | blocks `buy` and `launch`; never sells, claims, forwards, withdrawals or payouts |
| 171 | `next_config_id` | u16 | id of the next `LaunchConfig`; ids are sequential from 0 |
| 173 | `bump` | u8 | |
| 174 | `buybacks_halted` | bool | blocks `buyback_burn`; set only while `buys_halted` is (review LL-1) |
| 175 | `_reserved` | [u8; 63] | zero |
| 238 | end | | |

There is no fee-recipient field, no program-id field (3.2) and no coin counter. `buy` and
`launch` read `buys_halted`, `buyback_burn` reads `buybacks_halted`; `sell` only checks this
account's address and never reads it, so no content of this account can stop an exit.
`buybacks_halted` came out of the reserved bytes (review LL-1), so the size and every other
offset are unchanged; `set_pause` never stores `buybacks_halted` without `buys_halted`.

### 3.5 `LaunchConfig` (one per allowed split and curve; 144 bytes; immutable except `enabled`)

| offset | field | type | meaning | default config #0 |
|---|---|---|---|---|
| 8 | `config_id` | u16 | equals the seed | 0 |
| 10 | `enabled` | bool | admin switch for new approvals and launches only | true |
| 11 | `bump` | u8 | | |
| 12 | `liquidity_bps` | u16 | the 0.5% "protocol/liquidity" bucket | 50 |
| 14 | `platform_bps` | u16 | Vicinity platform | 70 |
| 16 | `founder_bps` | u16 | city founder | 50 |
| 18 | `holders_bps` | u16 | city holder rewards | 50 |
| 20 | `buyback_bps` | u16 | buyback and burn | 30 |
| 22 | `total_fee_bps` | u16 | sum of the five (computed) | 250 |
| 24 | `virtual_sol` (`x0`) | u64 | virtual lamports at the start | 30,000,853,639 |
| 32 | `virtual_tokens` (`y0`) | u64 | virtual raw coins at the start | 1,073,025,598,486,615 |
| 40 | `curve_supply` (`S`) | u64 | raw coins sold on the curve | 793,099,990,000,000 |
| 48 | `pool_supply` (`P`) | u64 | raw coins kept for the pool | 206,900,000,900,000 |
| 56 | `graduation_sol` (`R`) | u64 | lamports the curve holds when complete; must equal `f(S)` | 85,000,000,000 |
| 64 | `launch_fee_lamports` | u64 | paid to `FEE_RECIPIENT` at launch | 50,000,000 |
| 72 | `created_at` | i64 | | |
| 80 | `_reserved` | [u8; 64] | zero | |
| 144 | end | | | |

Every field except `enabled` is written once by `add_launch_config` after `validate_config`
(5.13) and never again. A change of fees or curve for future coins is a new config (R4). The
default burns `COIN_SUPPLY - S - P = 9,100,000` raw (9.1 coins) at launch (O3).

### 3.6 `Approval` (one per city while pending; at most 181 bytes)

| offset | field | type | meaning |
|---|---|---|---|
| 8 | `city_id` | u64 | |
| 16 | `founder` | Pubkey | the only wallet that may launch this city's coin |
| 48 | `config_id` | u16 | the config the coin must use |
| 50 | `rent_payer` | Pubkey | receives the rent on close |
| 82 | `meta_hash` | [u8; 32] | SHA-256 of the exact metadata JSON the website will serve at the coin's URI (3.10); nonzero |
| 114 | `name` | String (4 + at most 32 bytes) | coin name (`check_name`: visible characters only, single spaces between them; T38) |
| .. | `symbol` | String (4 + at most 10 bytes) | city ticker, `A-Z0-9` (`check_symbol`) |
| .. | `approved_at` | i64 | |
| .. | `expires_at` | i64 | at most 30 days after `approved_at` |
| .. | `bump` | u8 | |

### 3.7 `Coin` (one per city, permanent; 693 bytes; fixed offsets)

The Rust struct is named **`CurveCoin`**, so its Anchor discriminator
`sha256("account:CurveCoin")[..8]` differs from the old program's `Coin`
(`sha256("account:Coin")[..8]`); this file calls it `Coin`. `Launchpad`, `Approval` and
`PayoutOptIn` keep the old names, so their discriminators equal the old program's: every
decoder must check the program owner as well as the discriminator (5.16, 14.1).

Borsh, no variable-length field, so every offset is fixed for `memcmp` filters and for
decoders that do not use Anchor (the math crate ships `decode_coin`). Balances backed by
real lamports or raw coins are u64; lifetime sums are u128.

| offset | field | type | written by | meaning |
|---|---|---|---|---|
| 8 | `layout_version` | u8 | launch | 1 |
| 9 | `phase` | u8 | launch, graduating buy | 0 Curve, 1 Pool; only 0 to 1, once |
| 10 | `bump` | u8 | launch | |
| 11 | `mint_bump` | u8 | launch | |
| 12 | `vault_bump` | u8 | launch | |
| 13 | `config_id` | u16 | launch | config it launched under (display; terms are copied below) |
| 15 | `city_id` | u64 | launch | |
| 23 | `mint` | Pubkey | launch | PDA `["mint", coin]` |
| 55 | `vault` | Pubkey | launch | PDA `["coin_vault", coin]` |
| 87 | `founder` | Pubkey | launch, `transfer_founder` | receives the founder share |
| 119 | `symbol` | [u8; 10] | launch | ticker, zero padded |
| 129 | `liquidity_bps` | u16 | launch | frozen copy (R4) |
| 131 | `platform_bps` | u16 | launch | frozen |
| 133 | `founder_bps` | u16 | launch | frozen |
| 135 | `holders_bps` | u16 | launch | frozen |
| 137 | `buyback_bps` | u16 | launch | frozen |
| 139 | `total_fee_bps` | u16 | launch | frozen (`t`) |
| 141 | `virtual_sol` | u64 | launch | frozen `x0` |
| 149 | `virtual_tokens` | u64 | launch | frozen `y0` |
| 157 | `curve_supply` | u64 | launch | frozen `S` |
| 165 | `pool_supply` | u64 | launch | frozen `P` |
| 173 | `graduation_sol` | u64 | launch | frozen `R` |
| 181 | `dust_burned` | u64 | launch | `COIN_SUPPLY - S - P` burned at launch (9,100,000 by default) |
| 189 | `tokens_sold` | u64 | curve buys, curve sells, curve buybacks | `s`; equals `S` after graduation |
| 197 | `curve_sol` | u64 | same | `r = f(s)` on the curve; frozen at `R` after graduation |
| 205 | `pool_sol` | u64 | graduating buy, pool trades, pool buybacks | `X`; 0 on the curve |
| 213 | `pool_tokens` | u64 | same | `Y`; 0 on the curve |
| 221 | `liquidity_pending` | u64 | curve trades (+), pool trades (-) | `L`: curve-phase liquidity share not yet in the pool |
| 229 | `platform_pending` | u64 | trades, withdraw | owed to `FEE_RECIPIENT` |
| 237 | `founder_pending` | u64 | trades, claim, payout | owed to the founder |
| 245 | `holders_pending` | u64 | trades, forward | owed to the rewards vault |
| 253 | `buyback_pending` | u64 | trades, buyback | waiting to be spent on buyback |
| 261 | `launched_at` | i64 | launch | |
| 269 | `launch_slot` | u64 | launch | |
| 277 | `graduated_at` | i64 | graduating buy | 0 on the curve |
| 285 | `graduation_slot` | u64 | graduating buy | 0 on the curve |
| 293 | `last_buyback_slot` | u64 | launch (= `launch_slot`), buyback | rate limit |
| 301 | `last_payout_at` | i64 | payout | 24-hour cooldown (on `Coin`, so re-opting cannot reset it) |
| 309 | `payout_seq` | u64 | payout | receipt number |
| 317 | `trade_seq` | u64 | buy, sell | +1 per trade; gap-free; in every `Trade` event |
| 325 | `buyback_count` | u64 | buyback | |
| 333 | `tokens_burned` | u64 | buyback | raw coins burned by buybacks |
| 341 | `buy_volume` | u128 | buys | lifetime lamports charged to buyers (fee included) |
| 357 | `sell_volume` | u128 | sells | lifetime gross lamports released to sellers (before fee) |
| 373 | `fees_total` | u128 | trades | lifetime fees |
| 389 | `liquidity_earned` | u128 | trades | lifetime liquidity share, rounding remainders included |
| 405 | `liquidity_added` | u128 | pool trades | lifetime lamports moved into `pool_sol` by liquidity shares and drips |
| 421 | `platform_earned` | u128 | trades | |
| 437 | `platform_withdrawn` | u128 | withdraw | |
| 453 | `founder_earned` | u128 | trades | |
| 469 | `founder_claimed` | u128 | claim | |
| 485 | `founder_paid_out` | u128 | payout | |
| 501 | `holders_earned` | u128 | trades | |
| 517 | `holders_forwarded` | u128 | forward | |
| 533 | `buyback_earned` | u128 | trades | |
| 549 | `buyback_spent` | u128 | buyback | lamports moved from the buyback bucket into the reserve |
| 565 | `meta_hash` | [u8; 32] | launch | copied from the approval (3.10) |
| 597 | `rent_reserve` | u64 | launch | `Rent::minimum_balance(693)` at launch: the rent part of the account's lamports, used by `pay_out` (6.5) |
| 605 | `_reserved` | [u8; 88] | - | zero |
| 693 | end | | | |

### 3.8 `TickerLock` (one per ticker, permanent; 49 bytes)

| offset | field | type |
|---|---|---|
| 8 | `city_id` | u64 |
| 16 | `mint` | Pubkey |
| 48 | `bump` | u8 |

Created by `launch` with plain `init` at `["ticker", approval.symbol bytes]`. No second coin
with the same ticker can launch through this program, even under another `city_id`.
`approve_launch` refuses a ticker whose lock exists.

### 3.9 `PayoutOptIn` (145 bytes; reused unchanged)

`coin` Pubkey (8), `founder` Pubkey (40, who signed), `agreed_destination` Pubkey (72),
`ref_hash` [u8; 32] (104, SHA-256 of the off-chain reference, never a name or account
number), `opted_in_at` i64 (136), `bump` u8 (144).

### 3.10 Mint, vault and metadata of a coin

* **Mint**: classic SPL Token (`Program<Token>`, never Token-2022), PDA `["mint", coin]`,
  6 decimals, `freeze_authority = None` from creation, `mint_authority = Coin PDA` only
  during `launch`, then `None`. Minted once: `COIN_SUPPLY`; `dust_burned` burned in the same
  instruction. Supply afterwards is `mint.supply`, which is at most
  `COIN_SUPPLY - dust_burned - tokens_burned`: any holder may also burn his own coins with
  SPL `Burn`, which no counter of this program sees (I11).
* **Vault**: SPL token account, PDA `["coin_vault", coin]`, mint = the coin's mint, owner
  (authority) = the `Coin` PDA. No delegate, close authority or freeze is ever set. Holds
  `S - s + P` raw coins on the curve and `Y` in the pool, plus any donation (never counted).
* **Metadata**: Metaplex `CreateMetadataAccountsV3` through anchor-spl's wrapper: name and
  symbol from the approval, `uri = METADATA_URI_PREFIX + mint + ".json"`,
  `seller_fee_basis_points = 0`, no creators, no collection, no uses, `is_mutable = false`,
  update authority the `Coin` PDA. Metaplex charges its own 0.01 SOL fee to the payer
  (REPORT.md 1.3; O17). The name, symbol and URI on chain are immutable; **the JSON at the URI
  is served by the website**, so the admin approves its SHA-256 (`Approval.meta_hash`), which
  `launch` copies into `Coin.meta_hash` and emits in `CoinLaunched`. The website serves that
  JSON write-once, and the JSON's `image` URL contains the image's SHA-256, served write-once
  too, so a compromised website can be detected by anyone who compares hashes (it cannot be
  prevented, T37).
* **Ordinary transfers** of the coin never touch `vicinity_curve`, carry no Vicinity fee and
  cannot be hooked, frozen or clawed back (R3).

---

## 4. Instructions (21)

### 4.0 Conventions

* "S" = signer, "W" = writable. Anchor validates account constraints in the order the
  accounts are listed; the handler then runs its checks in the order given, then its
  effects. A failure anywhere reverts the whole instruction.
* **Coin-level instructions** (`buy`, `sell`, `buyback_burn`, the payouts, the founder and
  opt-in instructions) take no `city_id` argument. They find the coin with
  `Box<Account<CurveCoin>>`, `seeds = ["coin", coin.city_id.to_le_bytes()]`,
  `bump = coin.bump` (owner, discriminator and address all checked). **City-level
  instructions** (`approve_launch`, `revoke_approval`, `launch`) take `city_id` because it
  seeds an account being created or closed.
* **Event accounts**: `#[event_cpi]` appends `event_authority` (PDA `["__event_authority"]`)
  and `program` as the last two accounts. Instructions that move money or tokens emit with
  `emit_cpi!`; settings instructions emit with `emit!`.
* **No-op rule**: `buyback_burn`, `withdraw_platform_fees`, `forward_holders_fees`,
  `claim_founder_fees` and `payout_founder_fees` return `Ok` without changing state or
  emitting when there is nothing to move (a keeper can batch many coins in one transaction).
  A halt (`BuysHalted`, `BuybacksHalted`, `TradingHalted`) is an error, not a no-op.
* **Order of effects** in every money instruction: checks, then CPIs that bring value in
  (system transfer from the buyer, token transfer from the seller), then CPIs that send
  tokens out or burn, then the in-memory state update, then direct lamport moves through
  `pay_out` (which reads the post-update liabilities, 6.5), then events. Anchor serialises
  the `Coin` at exit; Anchor's `close` of an approval or opt-in also runs at exit, after
  every CPI.
* **Rule for CPIs after a direct lamport move.** No CPI may follow a direct lamport move
  unless every account whose lamports moved is in that CPI's account list. Reason: the runtime
  copies the caller's in-memory lamports into the transaction context only for the accounts
  the CPI lists, and `TransactionContext::push` then compares the caller's lamport sum with
  its value at entry and fails with `UnbalancedInstruction` if they differ (solana-sdk 2.1
  `transaction_context.rs`, `push()`). A credit to an account in the CPI with the matching
  debit outside it fails every time. In this program the only CPI after a `pay_out` is
  `emit_cpi!`, whose single account is the event authority, so both sides of the move stay
  outside it and the sums match. `forward_holders_fees` therefore does not call SPL
  `SyncNative` itself (4.15). Review checklist item and test R02b.
* **Halts**: `buys_halted` (set by the guardian or the admin, 4.4) makes `launch` and `buy`
  fail with `BuysHalted`; `buybacks_halted`, set only together with or after it, makes
  `buyback_burn` fail with `BuybacksHalted`. The **halt-all build** (8.3): with feature
  `halt-all`, the eight handlers that move lamports or tokens out of a `Coin` or its vault
  (`launch`, `buy`, `sell`, `buyback_burn`, `withdraw_platform_fees`,
  `forward_holders_fees`, `claim_founder_fees`, `payout_founder_fees`) fail with
  `TradingHalted` at the first statement of the handler, that is after Anchor has validated the
  account list: a transaction with an invalid account list fails with the account error first,
  and either way nothing is created, moved or written (NOTES 21). Without the feature these
  checks do not exist in the binary.
* **Math**: every amount comes from the math crate (5.16). Handlers do no arithmetic of their
  own except checked counter additions.

### 4.1 `init_launchpad(guardian: Pubkey)`

One time. Reused from `vicinity_launchpad::init_launchpad`; the program ids it used to take are
now compiled constants (3.2).

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `payer` | S W | |
| 2 | `admin` | S | becomes `admin`; signs so the stored admin is a live key |
| 3 | `upgrade_authority` | S | |
| 4 | `program_data` | | owner = BPF upgradeable loader; key = PDA(`[program_id]`, loader) (`NotUpgradeAuthority`) |
| 5 | `launchpad` | W | `init`, seeds `["launchpad"]`, space 238 |
| 6 | `system_program` | | |

Checks: (1) `program_data_upgrade_authority(program_data.data) == Some(upgrade_authority)`
(reused hand parser of the 45-byte header) else `NotUpgradeAuthority`; (2) neither
`upgrade_authority`, `admin` nor `guardian` is `FEE_RECIPIENT` (`FeeRecipientRole`):
`FEE_RECIPIENT` only receives (8.1). The upgrade-authority part holds at initialisation only:
the loader's `SetAuthority` can move the upgrade authority later, outside the program, so it
also stays a deploy precondition (8.4; review R2-DIFF-1); (3) a nonzero `guardian` is not
`admin` (`GuardianIsAdmin`): the guardian's halt must not wait for the admin's time lock
(8.1, 8.3; review R5-CONS-1).
Effects: every `Launchpad` field: `admin`, zero `pending_admin`, payout keys zero,
`guardian` (zero = none), all flags false, `next_config_id = 0`, `bump`.
Event (`emit!`): `LaunchpadInitialized { admin, upgrade_authority, guardian }`. Mainnet:
admin and upgrade authority are the same Squads vault, which signs both positions; the
guardian is the separate guardian multisig (8.1).

### 4.2 `propose_admin(new_admin: Pubkey)` and 4.3 `accept_admin()`

Reused unchanged.
* `propose_admin`: `admin` S; `launchpad` W, seeds, `has_one = admin` (`Unauthorized`).
  Checks: if `new_admin != 0`, `new_admin != FEE_RECIPIENT` (`FeeRecipientRole`),
  `check_payout_keys_separate(new_admin, guardian, payout_authority, payout_destination)`
  (`PayoutKeyNotSeparate`) and `new_admin != guardian` (`GuardianIsAdmin`, review R5-CONS-1).
  Effect: `pending_admin = new_admin` (zero cancels). Event `AdminProposed { admin,
  pending_admin }`.
* `accept_admin`: `new_admin` S; `launchpad` W, seeds. Checks: `pending_admin != 0`
  (`NoPendingAdmin`); `pending_admin == new_admin` (`NotPendingAdmin`); `new_admin !=
  FEE_RECIPIENT` (`FeeRecipientRole`); the separation rule again, with the current guardian
  (`PayoutKeyNotSeparate`); `new_admin != guardian` again (`GuardianIsAdmin`). Effects: `admin =
  new_admin`, `pending_admin = 0`. Event `AdminChanged { old_admin, new_admin }`.
* Because `forward_holders_fees` requires each city's rewards authority to equal the admin
  (4.15), a new admin must also take over each city's rewards authority (`vicinity_rewards`
  `propose_authority` / `accept_authority`); holders' money waits in `holders_pending` until
  then. Likewise the old `vicinity_launchpad`'s admin and `vicinity_rewards`' registry admin
  must follow (each by its `propose_admin` from the current admin and `accept_admin` by the new
  one): until then `approve_launch` and `launch` fail with `LegacyAdminMismatch` or
  `RewardsRegistryAdminMismatch` (4.8, 8.2, 8.5; review OPS-1).

### 4.4 `set_pause(launches: Option<bool>, payouts: Option<bool>, buys: Option<bool>, buybacks: Option<bool>)` and `set_guardian(guardian: Pubkey)`

`set_pause`: `authority` S; `launchpad` W, seeds. Who may set what (else `Unauthorized`):

| signer | may set |
|---|---|
| `admin` | any flag, to true or false |
| nonzero `payout_authority` | only `(None, Some(true), None, None)`: it can stop payouts, never resume them |
| nonzero `guardian` | only `launches`, `buys` and `buybacks`, only to `Some(true)`, `payouts = None`, at least one set: it can stop launches, buys and buybacks, never resume them |

Effects: set the given flags; then, whoever signed, require `!buybacks_halted || buys_halted`
(`BuybackHaltWithoutBuyHalt`, review LL-1): buybacks are halted only while buys are, so a halt
of buybacks goes with a halt of buys, and buybacks resume before or together with buys. A
backlog therefore never builds while anyone can buy ahead of it, and after a halt of both the
keeper can spend every coin's backlog while buys are still refused (8.3). Event `PauseChanged
{ launches_paused, payouts_paused, buys_halted, buybacks_halted, by }`. An admin call with all
four arguments `None` changes nothing and emits the unchanged flags (NOTES 23). Nothing can stop
sells, claims, forwards or withdrawals.

`set_guardian`: `admin` S; `launchpad` W, seeds, `has_one = admin` (`Unauthorized`).
Checks: `guardian != FEE_RECIPIENT` (`FeeRecipientRole`); `check_payout_keys_separate(admin,
guardian, payout_authority, payout_destination)` (`PayoutKeyNotSeparate`): the guardian is never
the payout key or the payout wallet (8.1: it cannot touch money); a nonzero guardian is neither
the admin nor the pending admin (`GuardianIsAdmin`, review R5-CONS-1: an admin under the time lock
as guardian would make the fast brake wait as long as every other proposal). Effect: `guardian =
guardian` (zero = none). Event (`emit!`) `GuardianChanged { old, new }`.

**Recovering from a stolen guardian (reviews R4-DIFF-4, OPS-3).** The guardian can set flags
until the moment the admin's proposal executes, and the consistency rule applies to the admin's
call too. A one-proposal recovery `[set_guardian(new), set_pause(launches = false, buys =
false)]` with `buybacks` left `None` (the flags as they were when it was written) is therefore
a trap: the thief halts buybacks late in the time lock, the `set_pause` fails with
`BuybackHaltWithoutBuyHalt`, the whole vault transaction reverts with `set_guardian`, and the
thief keeps the seat for another time lock. Written with `buybacks = false`, it instead reopens
buys and buybacks in the same instant after a time lock of buyback halt, the LL-1 state. The
recovery is therefore two proposals, which may be approved together:
1. `[set_guardian(new), set_pause(launches, buybacks = Some(false))]`, buys left as they are
   (or `buys = Some(true)` and `buybacks = None` when buybacks must stay halted): after it,
   `!buybacks_halted || buys_halted` holds whatever the thief set, so nothing he does can make
   it fail, and he loses the seat in that transaction. The SDK builds it
   (`guardianRecovery`).
2. Once the keeper has drained every coin's backlog to at most one cap and the figures are
   published, `set_pause(buys = Some(false))`, which fails closed if buybacks are still halted.

Never put `set_guardian` in the same transaction as a `set_pause` that sets `buys = false`
with `buybacks` unset. The guardian has this much power over admin proposals: it can make one
fail once, by setting a flag the proposal did not expect; it cannot change any outcome of a
proposal written as above.

### 4.5 `set_payout_config(payout_authority: Pubkey, payout_destination: Pubkey)`

Reused. `admin` S; `launchpad` W, `has_one = admin` (`Unauthorized`). Checks: two zeros =
payouts off; otherwise both nonzero (`InvalidAddress`) and
`check_payout_keys_separate(admin, guardian, ...)` (payout key not the admin, the guardian or
`FEE_RECIPIENT`; payout wallet not the payout key, the admin, the guardian or `FEE_RECIPIENT`)
(`PayoutKeyNotSeparate`).
Effects: both fields. Existing opt-ins naming another wallet stop working; they are never
redirected. Event `PayoutConfigChanged { old_authority, new_authority, old_destination,
new_destination }`.

### 4.6 `add_launch_config(p: ConfigParams)`

`ConfigParams { liquidity_bps, platform_bps, founder_bps, holders_bps, buyback_bps: u16;
virtual_sol, virtual_tokens, curve_supply, pool_supply, graduation_sol,
launch_fee_lamports: u64 }`.

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `admin` | S | |
| 2 | `payer` | S W | |
| 3 | `launchpad` | W | seeds, `has_one = admin` (`Unauthorized`) |
| 4 | `config` | W | `init`, seeds `["config", launchpad.next_config_id u16 LE]`, space 144 |
| 5 | `system_program` | | |

Checks in order: `validate_config(p)` rules V1 to V11 (5.13), each with its own error;
`next_config_id < u16::MAX` (`ConfigCount`).
Effects: every field; `total_fee_bps = sum of the five`; `enabled = true`;
`created_at = now`; `next_config_id += 1`.
Event (`emit!`): `ConfigAdded { config_id, every field }`.

### 4.7 `set_launch_config_enabled(enabled: bool)`

`admin` S; `launchpad` seeds, `has_one = admin` (`Unauthorized`); `config` W, seeds
`["config", config.config_id LE]`, `bump = config.bump`. Effect: `enabled`. Affects only
future approvals and launches; live coins never read their config again. Event
`ConfigEnabled { config_id, enabled }`.

### 4.8 `approve_launch(city_id: u64, founder: Pubkey, config_id: u16, name: String, symbol: String, meta_hash: [u8; 32], expires_at: i64)`

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `admin` | S W | pays the approval rent (refunded on close) |
| 2 | `launchpad` | | seeds, `has_one = admin` (`Unauthorized`) |
| 3 | `config` | | seeds `["config", config_id LE]`, `bump = config.bump`; `enabled` (`ConfigDisabled`) |
| 4 | `approval` | W | `init`, seeds `["approval", city_id LE]`, space 181 |
| 5 | `coin` | | Unchecked; seeds `["coin", city_id LE]`; `data_is_empty() && owner == System` (`CoinAlreadyLaunched`) |
| 6 | `ticker_lock` | | Unchecked; seeds `["ticker", symbol.as_bytes()]`; `data_is_empty() && owner == System` (`TickerTaken`) |
| 7 | `legacy_coin` | | Unchecked; key = `find_program_address(["coin", city_id LE], LEGACY_PROGRAM_ID)` (`InvalidAddress`); `data_is_empty() && owner == System` (`LegacyCoinExists`) |
| 8 | `legacy_approval` | | Unchecked; key = `find_program_address(["approval", city_id LE], LEGACY_PROGRAM_ID)` (`InvalidAddress`); `data_is_empty() && owner == System` (`LegacyApprovalExists`) |
| 9 | `legacy_launchpad` | | Unchecked; `address = LEGACY_LAUNCHPAD` (`InvalidAddress`); `owner == LEGACY_PROGRAM_ID`, `data_len == 171`, `data[0..8] == LEGACY_LAUNCHPAD_DISCRIMINATOR` (`InvalidAddress`); `data[168] == 1`, the old program's launches paused (`LegacyLaunchesOpen`); `data[8..40] == launchpad.admin` and `data[40..72] == 0`, the old program's admin is this program's admin with no transfer pending (`LegacyAdminMismatch`) |
| 10 | `rewards_registry` | | Unchecked; `address = REWARDS_REGISTRY` (`InvalidAddress`), `["registry"]` under `REWARDS_PROGRAM_ID`; `owner == REWARDS_PROGRAM_ID`, `data_len == 73`, `data[0..8] == REWARDS_REGISTRY_DISCRIMINATOR`, `data[8..40] == launchpad.admin` and `data[40..72] == 0`: `vicinity_rewards`' registry admin, the only key that can create the coin's rewards config, is this program's admin with no transfer pending (`RewardsRegistryAdminMismatch`; review OPS-1) |
| 11 | `system_program` | | |

Checks in order: `city_id >= 1` (`BadCityId`); the founder seat, `check_founder_key(founder,
guardian, payout_authority)`: `founder != 0` (`InvalidAddress`), `founder != FEE_RECIPIENT`
(`FeeRecipientRole`), `founder` neither the guardian nor the payout key (`FounderHoldsRole`);
the founder receives the coin's founder share, so the seat never goes to a key that may not
touch money (8.1; the admin may be a founder; reviews R2-DIFF-1, SPEC-1);
`check_name(name)` (`BadName`: 1 to 32 bytes; no control character, no Unicode
default-ignorable code point or other invisible format character, no blank character (spaces
other than U+0020, line and paragraph separators, the braille blank, the musical null notehead),
and U+0020 only as a single space between two characters; review FA-1); `check_symbol(symbol)` (`BadSymbol`);
`meta_hash != [0; 32]` (`BadMetaHash`);
`now < expires_at <= now + APPROVAL_MAX_SECS` (`BadExpiry`).
Effects: `city_id, founder, config_id, rent_payer = admin, meta_hash, name, symbol,
approved_at = now, expires_at, bump`.
Event (`emit!`): `LaunchApproved { city_id, founder, config_id, name, symbol, meta_hash,
expires_at }`.
Notes: a second approval for the same city fails at `init` until the first is used or
revoked. A symbol longer than 32 bytes fails seed derivation before `check_symbol` (still
refused). Two pending approvals for different cities may name the same ticker; only the
first launch can create the ticker lock. The legacy checks run again in `launch`. The admin
check makes reopening the old program need the same multisig and time lock as every admin
action here (8.5): while the two admins differ, nothing is approved or launched here. The
registry check (review OPS-1) closes the same class of hole for the holders' share:
`init_city` needs only the registry admin's signature, and `vicinity_rewards` can never change
or close a city's config, so a registry admin outside the multisig could create a new coin's
config with wrong economics (Creator, `founder_bps` 10,000) before the multisig's time-locked
`init_city`, and every forward would then fail for good (O26). It runs again in `launch`.

### 4.9 `revoke_approval(city_id: u64)`

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `by` | S | |
| 2 | `launchpad` | | seeds |
| 3 | `approval` | W | seeds `["approval", city_id LE]`, `bump`, `has_one = rent_payer` (`InvalidAddress`), `close = rent_payer` |
| 4 | `rent_payer` | W | Unchecked (pinned by `has_one`) |

Check: if `by != launchpad.admin`, then `now > approval.expires_at` (`ApprovalNotExpired`).
Effect: the approval closes at exit; its rent goes to `rent_payer`. Event (`emit!`):
`ApprovalRevoked { city_id, by }`.

### 4.10 `launch(city_id: u64)`

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `founder` | S | checked against `approval.founder` |
| 2 | `payer` | S W | pays rent, the launch fee and Metaplex's fee (usually the founder) |
| 3 | `launchpad` | | seeds (`Box`) |
| 4 | `approval` | W | seeds `["approval", city_id LE]`, `bump`, `has_one = rent_payer` (`InvalidAddress`), `close = rent_payer` (`Box`) |
| 5 | `rent_payer` | W | Unchecked (pinned by `has_one`) |
| 6 | `config` | | seeds `["config", approval.config_id LE]`, `bump`; `enabled` (`ConfigDisabled`) (`Box`) |
| 7 | `coin` | W | `init`, seeds `["coin", city_id LE]`, space 693 (`Box<Account<CurveCoin>>`) |
| 8 | `mint` | W | `init`, seeds `["mint", coin]`, `mint::decimals = 6`, `mint::authority = coin`, no freeze authority, `mint::token_program = token_program` (`Box`) |
| 9 | `coin_vault` | W | `init`, seeds `["coin_vault", coin]`, `token::mint = mint`, `token::authority = coin`, `token::token_program = token_program` (`Box`) |
| 10 | `ticker_lock` | W | `init`, seeds `["ticker", approval.symbol.as_bytes()]`, space 49 (`Box`) |
| 11 | `metadata` | W | Unchecked; key = `find_program_address(["metadata", METAPLEX_PROGRAM_ID, mint], METAPLEX_PROGRAM_ID)` (`InvalidAddress`) |
| 12 | `fee_recipient` | W | `address = FEE_RECIPIENT` (`InvalidAddress`) |
| 13 | `legacy_coin` | | as in 4.8 (`InvalidAddress`, `LegacyCoinExists`) |
| 14 | `legacy_approval` | | as in 4.8 (`InvalidAddress`, `LegacyApprovalExists`) |
| 15 | `legacy_launchpad` | | as in 4.8 (`InvalidAddress`, `LegacyLaunchesOpen`, `LegacyAdminMismatch`) |
| 16 | `rewards_registry` | | as in 4.8 (`InvalidAddress`, `RewardsRegistryAdminMismatch`) |
| 17 | `metadata_program` | | `address = METAPLEX_PROGRAM_ID` (`InvalidAddress`) |
| 18 | `token_program` | | `Program<Token>` (classic SPL Token) |
| 19 | `system_program` | | |
| 20 | `rent` | | sysvar (required by the Metaplex CPI wrapper) |
| 21-22 | event accounts | | |

Checks in order (after the constraints): `!launchpad.launches_paused` (`LaunchesPaused`);
`!launchpad.buys_halted` (`BuysHalted`); `now <= approval.expires_at` (`ApprovalExpired`);
`founder == approval.founder` (`WrongFounder`); `check_founder_key` again against the
`Launchpad` of this moment (`FeeRecipientRole`, `FounderHoldsRole`: a founder who became the
guardian or the payout key after the approval cannot launch); `validate_config(config)` again
(defence in depth; V errors); `check_name`, `check_symbol` on the approval's strings again (`BadName`,
`BadSymbol`). The legacy accounts are checked by their constraints, so R1 across both
programs holds at the moment of every launch, not only at approval time.

Effects in order:
1. If `launch_fee_lamports > 0`: system transfer `payer -> FEE_RECIPIENT`.
2. Metaplex `create_metadata_accounts_v3`: name, symbol, `uri = METADATA_URI_PREFIX + mint +
   ".json"`, seller fee 0, creators `None`, collection `None`, uses `None`,
   `is_mutable = false`, `update_authority_is_signer = true`, collection details `None`;
   mint authority and update authority the `Coin` PDA (signs with
   `["coin", city_id LE, bump]`); `payer` pays.
3. `mint_to(coin_vault, COIN_SUPPLY)`, signed by the `Coin` PDA.
4. `dust = COIN_SUPPLY - S - P`; if `dust > 0`, `burn(coin_vault, dust)` signed by the
   `Coin` PDA (default config: `dust = 9,100,000` raw).
5. `set_authority(mint, MintTokens, None)`, signed by the `Coin` PDA.
6. Write `Coin`: `layout_version = 1`, `phase = 0`, bumps, `config_id`, `city_id`, `mint`,
   `vault`, `founder`, `symbol`; the five bps, `total_fee_bps`, `x0, y0, S, P, R` copied
   from the config (frozen forever); `dust_burned = dust`; `meta_hash` from the approval;
   `rent_reserve = Rent::get()?.minimum_balance(693)`; `launched_at = now`;
   `launch_slot = last_buyback_slot = slot`; every other field 0. (If someone pre-funded the
   `Coin` address, the extra lamports are a donation: `rent_reserve` is the rent figure, not
   the balance.)
7. Write `TickerLock { city_id, mint, bump }`.
8. The approval closes at exit (rent to `rent_payer`).

No direct lamport move happens in `launch`. Event (`emit_cpi!`): `CoinLaunched`. The founder
may append a `buy` to the same transaction (normal fee; the atomic first buy); the website
uses an address lookup table for that transaction (11.3).

### 4.11 `buy(sol_in: u64, min_tokens_out: u64)`

Fixed account list, **identical for `sell`**, before and after graduation:

| # | account | flags | constraints (error) |
|---|---|---|---|
| 0 | `user` | S W | pays `charged` lamports; must be a system-owned account without data (the system transfer requires it, 14.3) |
| 1 | `coin` | W | `Box<Account<CurveCoin>>`; seeds `["coin", coin.city_id LE]`, `bump = coin.bump` |
| 2 | `launchpad` | | `Account<Launchpad>`, seeds `["launchpad"]`, `bump = launchpad.bump`; only `buys_halted` is read |
| 3 | `mint` | | `address = coin.mint` (`InvalidAddress`) |
| 4 | `coin_vault` | W | `address = coin.vault` (`InvalidAddress`) |
| 5 | `user_token_account` | W | `Account<TokenAccount>` (classic Token owner); `token::mint = mint` (`WrongTokenAccount`); `user_token_account.owner != coin.key()` (`SameAccount`: excludes the vault and any other token account whose authority is the `Coin` PDA, from which coins could never move). Any other authority (a router may deliver to an account it controls) |
| 6 | `token_program` | | `Program<Token>` |
| 7 | `system_program` | | `Program<System>` |
| 8 | `event_authority` | | event CPI PDA |
| 9 | `program` | | this program |

Checks in order: `!launchpad.buys_halted` (`BuysHalted`); `sol_in >= MIN_TRADE_LAMPORTS`
(`TradeTooSmall`); `q = math::quote_buy(coin.terms, coin.state, sol_in)` (5.4, 5.7;
`MathOverflow`); `q.tokens_out >= 1` (`ZeroOutput`); `q.tokens_out >= min_tokens_out`
(`SlippageExceeded`).
Effects in order:
1. System transfer `user -> coin`, `q.charged` lamports (`q.charged <= sol_in`; the rest of
   `sol_in` is never taken).
2. `transfer_checked(coin_vault -> user_token_account, q.tokens_out, 6)`, signed by the
   `Coin` PDA.
3. State: write `q.new_state` (curve: `tokens_sold`, `curve_sol`; pool: `pool_sol`,
   `pool_tokens`; buckets; `liquidity_pending`; earned counters; `liquidity_added`;
   `fees_total`; `buy_volume += charged`; `trade_seq += 1`). If `q.graduates`: `phase = 1`,
   `pool_sol = R`, `pool_tokens = P`, `graduated_at = now`, `graduation_slot = slot`.
4. Events: `Trade`; and `Graduated` when this buy completed the curve.

Only the coin, its vault and the user's two accounts are written; `Launchpad` is read-only,
so trades of different coins never contend, and the only admin-controlled state a buy reads
is the halt flag.

### 4.12 `sell(tokens_in: u64, min_sol_out: u64)`

Same 10 accounts in the same order; `user_token_account` additionally
`token::authority = user` (`WrongTokenAccount`). `launchpad` is an `UncheckedAccount` whose
address is checked (`seeds = ["launchpad"], bump`) and whose data is never read, and
`system_program` is unused; both are kept so the two lists are identical.
Checks in order: `tokens_in >= 1` (`ZeroAmount`); `q = math::quote_sell(...)` (curve:
`tokens_in <= tokens_sold` else `SellExceedsCurve`; `MathOverflow`); `q.sol_out >= 1`
(`ZeroOutput`); `q.sol_out >= min_sol_out` (`SlippageExceeded`).
Effects in order:
1. `transfer_checked(user_token_account -> coin_vault, tokens_in, 6)`, signed by `user`.
2. State: `q.new_state` (curve: `tokens_sold`, `curve_sol = f(tokens_sold)`; pool: reserves;
   buckets; drip; counters; `sell_volume += gross`; `trade_seq += 1`).
3. `pay_out(coin -> user, q.sol_out)` (6.5; `RentFloor`). If `user` holds 0 lamports, the
   payout must be at least the rent-exempt minimum of an empty account or the runtime refuses
   the transaction (14.3).
4. Event `Trade`.

There is no minimum on sells and no flag that blocks them, so any holder can always exit
(O5).

### 4.13 `buyback_burn()`

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `coin` | W | seeds, bump |
| 2 | `launchpad` | | seeds, bump; only `buybacks_halted` is read |
| 3 | `mint` | W | `address = coin.mint` (`InvalidAddress`) (a burn lowers the supply) |
| 4 | `coin_vault` | W | `address = coin.vault` (`InvalidAddress`) |
| 5 | `token_program` | | `Program<Token>` |
| 6-7 | event accounts | | |

No signer besides the transaction fee payer; the caller chooses nothing and receives
nothing. No arguments.
Check: `!launchpad.buybacks_halted` (`BuybacksHalted`). Buybacks have their own flag (review
LL-1): a halt of buys alone leaves them running, so sellers keep the support their own 0.3%
pays for and no backlog builds while nobody can buy.
No-op (`Ok`) when any holds: `buyback_pending == 0`;
`slot < last_buyback_slot + BUYBACK_INTERVAL_SLOTS`; `math::quote_buyback(...)` returns
nothing (cap 0, or 0 coins, or 0 lamports spent; 7.1).
Effects: `burn(coin_vault, mint, q.coins)` signed by the `Coin` PDA; state: curve
`tokens_sold`, `curve_sol` or pool `pool_sol`, `pool_tokens`; `buyback_pending -= spent`;
`buyback_spent += spent`; `tokens_burned += coins`; `buyback_count += 1`;
`last_buyback_slot = slot`. No lamport leaves the account. Event `BuybackBurned`.

### 4.14 `withdraw_platform_fees()`

`coin` W (seeds, bump); `fee_recipient` W, `address = FEE_RECIPIENT` (`InvalidAddress`);
event accounts. Anyone may call.
Effects: `amount = platform_pending`; 0 means no-op; `platform_pending = 0`;
`platform_withdrawn += amount`; `pay_out(coin -> FEE_RECIPIENT, amount)`.
Event `PlatformFeesWithdrawn { city_id, amount, total_withdrawn }`. No other instruction pays
platform money.

### 4.15 `forward_holders_fees()`

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `launchpad` | | seeds (`Box`); `admin` is read |
| 2 | `coin` | W | seeds, bump |
| 3 | `rewards_city_config` | | Unchecked; `owner == REWARDS_PROGRAM_ID` (`WrongRewardsConfig`); key = `find_program_address(["city", coin.mint], REWARDS_PROGRAM_ID)` (`WrongRewardsConfig`) |
| 4 | `rewards_vault` | W | `Box<Account<TokenAccount>>` (classic); key = `find_program_address(["vault", rewards_city_config], REWARDS_PROGRAM_ID)` (`WrongRewardsVault`); `mint == NATIVE_MINT` and `owner == rewards_city_config` (`WrongRewardsVault`) |
| 5-6 | event accounts | | |

Anyone may call. Checks: `view = read_rewards_city_config(data)`, which now also returns
`authority` (bytes 8..40) and `pending_authority` (bytes 40..72) of the `CityConfig`;
`check_rewards_config(view, coin.mint, NATIVE_MINT, rewards_vault.key)` (model Holders,
`founder_bps == 0`, `reward_mint == NATIVE_MINT`, `vault ==` the account passed,
`city_coin_mint == coin.mint`); and **`view.authority == launchpad.admin` and
`view.pending_authority == Pubkey::default()`** (all `WrongRewardsConfig`). The authority
check binds the holders' money to a root publisher that is the same Squads vault as the
admin, never a key that the rewards registry admin chose otherwise (8.1).
Effects, in this order: `amount = holders_pending`; 0 means no-op; `holders_pending = 0`;
`holders_forwarded += amount`; `pay_out(coin -> rewards_vault, amount)` (a direct lamport
credit to the WSOL token account; any program may credit a writable account); `emit_cpi!`.
**No `SyncNative` inside the instruction** (rule of 4.0: a `SyncNative` CPI listing only the
vault would record the vault's credit but not the Coin's debit and fail with
`UnbalancedInstruction`). The SDK and the keeper append a top-level SPL Token
`SyncNative(rewards_vault)` instruction right after it in the same transaction (permissionless;
anyone can also send it later), and the rewards funding transaction puts `SyncNative` before
`fund_epoch_from_vault`, which reads `vault.amount`. Until it is synced, the vault holds more
lamports than its token amount shows; nothing is lost.
Event `HoldersFeesForwarded { city_id, amount, rewards_vault, total_forwarded }`.

If the city's rewards config is missing or wrong, the call fails and the money keeps
collecting in `holders_pending`. A wrong authority can be moved to the admin by the current
authority (`propose_authority` / `accept_authority`), but **wrong economics cannot be fixed**: `vicinity_rewards` writes
a `CityConfig`'s model, founder share, reward mint and vault only in `init_city` and has no
close instruction, so a config created with the wrong values makes this instruction fail for
that coin forever; only a program upgrade could route that money elsewhere (O26). The SDK's
`initRewardsForCoin` therefore simulates the Squads proposal and runs `check_rewards_config`
and the authority rule on the resulting account bytes before the proposal is created (R03).
Only an account owned by `vicinity_rewards` at the config address is an existing config: anyone
can send lamports to the deterministic address, before or after launch, and `init_city` creates
the config over such a System account without data (T55). For an existing config the SDK tells
the fixable problems (its authority is not the admin, or a transfer is pending:
`propose_authority` / `accept_authority`) from the unfixable ones (its economics, O26).
`init_city` cannot run before launch because it needs the mint.

### 4.16 `claim_founder_fees()`

`founder` S W; `coin` W, seeds, `has_one = founder` (`WrongFounder`); event accounts.
Effects: `amount = founder_pending`; 0 means no-op; `founder_pending = 0`;
`founder_claimed += amount`; `pay_out(coin -> founder, amount)`. Works whatever is paused and
whether or not the founder opted in. Event `FounderFeesClaimed { city_id, founder, amount,
total_claimed }`. If the founder's wallet holds 0 lamports, the claim must be at least the
rent-exempt minimum of an empty account (14.3).

### 4.17 `transfer_founder()`

Reused, with one account added. `founder` S; `new_founder` S; `launchpad` seeds (read for the
guardian and the payout key); `coin` W, seeds, `has_one = founder` (`WrongFounder`). Check:
`check_founder_key(new_founder, guardian, payout_authority)` (`FeeRecipientRole`,
`FounderHoldsRole`; 4.8). Effect: `founder = new_founder`. Money still pending goes with the seat
(the founder should claim first). An existing opt-in stops working (it names the old
founder). Event (`emit!`): `FounderTransferred { city_id, old, new }`. The admin can never
change a founder.

### 4.18 `opt_in_payout(expected_destination: Pubkey, ref_hash: [u8; 32])`

Reused. `founder` S W; `launchpad` seeds; `coin` seeds, `has_one = founder`
(`WrongFounder`); `opt_in` W, `init`, seeds `["payout_opt_in", coin]`, space 145;
`system_program`. Checks: payout key and wallet both set (`PayoutsNotConfigured`);
`expected_destination == payout_destination` (`DestinationMismatch`). Effects: `coin`,
`founder`, `agreed_destination = expected_destination`, `ref_hash`, `opted_in_at = now`,
`bump`. Event (`emit!`): `PayoutOptedIn { city_id, founder, destination, ref_hash }`.

### 4.19 `revoke_payout_opt_in()`

Reused. `by` S; `coin` seeds; `opt_in` W, seeds, `has_one = coin` (`InvalidAddress`),
`opt_in.founder == opt_in_founder` (`InvalidAddress`), `close = opt_in_founder`;
`opt_in_founder` W. Check: `by == coin.founder || by == opt_in.founder` (`Unauthorized`).
Event (`emit!`): `PayoutOptInRevoked { city_id, founder, by }`. Always works.

### 4.20 `payout_founder_fees()`

| # | account | flags | constraints (error) |
|---|---|---|---|
| 1 | `payout_authority` | S | |
| 2 | `launchpad` | | seeds |
| 3 | `coin` | W | seeds, bump |
| 4 | `opt_in` | | seeds `["payout_opt_in", coin]`, `bump`, `has_one = coin` (`InvalidAddress`) |
| 5 | `destination_wallet` | W | `address = launchpad.payout_destination` (`DestinationMismatch`); `owner == System` (`InvalidAddress`) |
| 6-7 | event accounts | | |

Checks in order: `payout_authority != 0 && signer == payout_authority` (`Unauthorized`);
`!payouts_paused` (`PayoutsPaused`); `opt_in.founder == coin.founder`
(`OptInFounderMismatch`); `opt_in.agreed_destination == payout_destination`
(`DestinationMismatch`); `now >= last_payout_at + PAYOUT_COOLDOWN_SECS` (`PayoutTooSoon`).
Effects: `amount = founder_pending`; 0 means no-op (no sequence number, no cooldown);
`founder_pending = 0`; `founder_paid_out += amount`; `payout_seq += 1`;
`last_payout_at = now`; `pay_out(coin -> destination_wallet, amount)` (native SOL, no token
account to create). Event `FounderPaidOut { city_id, founder, destination, amount, seq,
ref_hash, total_paid_out }`.

### 4.21 Events

`emit_cpi!` (cannot be truncated like logs; indexers accept them only as the acceptance rule
below says):

| event | fields |
|---|---|
| `CoinLaunched` | city_id, founder, mint, vault, config_id, name, symbol, uri, meta_hash, supply_minted, dust_burned, curve_supply, pool_supply, graduation_sol, virtual_sol, virtual_tokens, liquidity_bps, platform_bps, founder_bps, holders_bps, buyback_bps, total_fee_bps, launch_fee, slot, timestamp |
| `Trade` | city_id, mint, user, is_buy, phase (where it executed), sol_in (buy: lamports offered; sell: 0), sol_amount (buy: lamports charged; sell: gross lamports released before the fee), sol_net (buy: lamports into the curve or pool; sell: lamports paid to the user), token_amount, fee, fee_liquidity, fee_platform, fee_founder, fee_holders, fee_buyback, liquidity_dripped, partial (charged < sol_in), graduated, virtual_sol_after, virtual_tokens_after (curve: `x0 + curve_sol`, `y0 - tokens_sold`; pool: `pool_sol`, `pool_tokens`), tokens_sold, curve_sol, pool_sol, pool_tokens, liquidity_pending, trade_seq, slot, timestamp |
| `Graduated` | city_id, mint, pool_sol, pool_tokens, liquidity_pending, last_virtual_sol, last_virtual_tokens, slot, timestamp |
| `BuybackBurned` | city_id, mint, phase, sol_spent, tokens_burned, cap, buyback_pending_after, tokens_burned_total, supply_after (`mint.supply` after the burn), virtual_sol_after, virtual_tokens_after, slot, timestamp |
| `PlatformFeesWithdrawn` | city_id, amount, total_withdrawn |
| `HoldersFeesForwarded` | city_id, amount, rewards_vault, total_forwarded |
| `FounderFeesClaimed` | city_id, founder, amount, total_claimed |
| `FounderPaidOut` | city_id, founder, destination, amount, seq, ref_hash, total_paid_out |

`emit!` (settings): `LaunchpadInitialized`, `AdminProposed`, `AdminChanged`, `PauseChanged`
(with `buys_halted` and `buybacks_halted`), `GuardianChanged`, `PayoutConfigChanged`, `ConfigAdded`,
`ConfigEnabled`, `LaunchApproved`, `ApprovalRevoked`, `FounderTransferred`,
`PayoutOptedIn`, `PayoutOptInRevoked`. Every figure in every event is also a counter or field
in an account, so indexers can reconcile from state. The `Trade` of the buy that completes the
curve has `phase = 0` (where it executed) while its `*_after` fields describe the new pool; the
curve's last virtual reserves are in `Graduated` (NOTES 23).

**Acceptance rule for indexers** (T56; the SDK's `decodeTransactionEvents` applies it to what
`getTransaction` returns):

1. Only events of a transaction whose `meta.err` is null, read at `finalized` commitment or
   re-checked there. The runtime records the inner instructions and logs of failed transactions
   too, so a failed transaction carries genuine event CPIs of trades that were reverted (review
   CLI-2: a buy or sell followed by an instruction that always fails costs only the fee).
2. A money event only from an inner instruction (stack height 2 or more) of `vicinity_curve`
   whose enclosing call (the nearest instruction one level up) is `vicinity_curve` itself and
   whose only account is the event authority PDA (a router calling `vicinity_curve` puts the
   event at depth 3, which is fine).
3. A settings event only from a `Program data:` line logged while `vicinity_curve` is the
   running program; never a money event from a log.
4. Never keep the first event seen for a `(coin, trade_seq)` and drop later ones: after
   confirmation, reconcile each coin's events with `Coin.trade_seq` and the account's counters.

### 4.22 Errors (`CurveError`, codes from 6000 in this order; new codes only appended)

| code | name | when |
|---|---|---|
| 6000 | `Unauthorized` | signer lacks the role |
| 6001 | `NotUpgradeAuthority` | `init_launchpad` signer is not the upgrade authority |
| 6002 | `InvalidAddress` | a pinned address, PDA, owner, size or discriminator check failed |
| 6003 | `NoPendingAdmin` | |
| 6004 | `NotPendingAdmin` | |
| 6005 | `LaunchesPaused` | |
| 6006 | `PayoutsPaused` | |
| 6007 | `PayoutsNotConfigured` | |
| 6008 | `PayoutKeyNotSeparate` | the admin, the payout key and the payout wallet are not three different keys, or the payout key or wallet is the guardian or `FEE_RECIPIENT` |
| 6009 | `ConfigDisabled` | |
| 6010 | `ConfigCount` | 65,535 configs reached |
| 6011 | `ConfigFeeTotal` | V1 |
| 6012 | `ConfigFeeShareCap` | V2: platform above 1.2% or founder above 1.0%; V2b: the founder's and the holders' shares together leave less than `MIN_TOTAL_FEE_BPS` of the fee |
| 6013 | `ConfigSupply` | V3 |
| 6014 | `ConfigCurveBounds` | V4 |
| 6015 | `ConfigGraduation` | V5 (including V5b) |
| 6016 | `ConfigAbsorption` | V6 |
| 6017 | `ConfigContinuity` | V7 |
| 6018 | `ConfigBuybackMev` | V8 |
| 6019 | `ConfigLaunchFee` | V9 |
| 6020 | `BadCityId` | |
| 6021 | `BadName` | the name breaks `check_name` (4.8) |
| 6022 | `BadSymbol` | |
| 6023 | `BadExpiry` | |
| 6024 | `ApprovalExpired` | |
| 6025 | `ApprovalNotExpired` | non-admin revoke of a live approval |
| 6026 | `CoinAlreadyLaunched` | |
| 6027 | `TickerTaken` | |
| 6028 | `LegacyCoinExists` | city has a coin under `vicinity_launchpad` |
| 6029 | `WrongFounder` | |
| 6030 | `ZeroAmount` | `tokens_in == 0` |
| 6031 | `TradeTooSmall` | `sol_in < MIN_TRADE_LAMPORTS` |
| 6032 | `ZeroOutput` | a trade would return nothing |
| 6033 | `SlippageExceeded` | |
| 6034 | `SellExceedsCurve` | curve sell above `tokens_sold` |
| 6035 | `SameAccount` | user token account is owned by the `Coin` PDA (the vault or any other) |
| 6036 | `WrongTokenAccount` | wrong mint, or a sell from an account the user does not own |
| 6037 | `RentFloor` | a debit would breach the rent part plus liabilities (only on a bug) |
| 6038 | `WrongRewardsConfig` | config not Holders / 0% founder / WSOL / this vault / this mint, or its authority is not the admin, or an authority transfer is pending |
| 6039 | `WrongRewardsVault` | |
| 6040 | `DestinationMismatch` | |
| 6041 | `OptInFounderMismatch` | |
| 6042 | `PayoutTooSoon` | |
| 6043 | `TradingHalted` | only in the `halt-all` build |
| 6044 | `MathOverflow` | an intermediate left u128 or a result left u64 |
| 6045 | `ConfigDripFarmable` | V10 |
| 6046 | `ConfigBuybackHorizon` | V11 |
| 6047 | `LegacyApprovalExists` | city has a pending approval under `vicinity_launchpad` |
| 6048 | `LegacyLaunchesOpen` | `vicinity_launchpad` launches are not paused |
| 6049 | `BuysHalted` | `buys_halted` is set (guardian or admin) |
| 6050 | `BadMetaHash` | `meta_hash` is all zeros |
| 6051 | `LegacyAdminMismatch` | `vicinity_launchpad`'s admin is not this program's admin, or an admin transfer is pending there (4.8, 4.10) |
| 6052 | `FeeRecipientRole` | `FEE_RECIPIENT` named as admin, proposed admin, guardian or upgrade authority at init, or as a coin's founder (4.1, 4.2, 4.4, 4.8, 4.10, 4.17) |
| 6053 | `FounderHoldsRole` | a coin's founder named as the guardian or the payout key (4.8, 4.10, 4.17) |
| 6054 | `BuybacksHalted` | `buybacks_halted` is set (guardian or admin; 4.13) |
| 6055 | `BuybackHaltWithoutBuyHalt` | `set_pause` would leave `buybacks_halted` set while `buys_halted` is not (4.4, review LL-1) |
| 6056 | `RewardsRegistryAdminMismatch` | `vicinity_rewards`' registry is not at `REWARDS_REGISTRY`'s owner, size and discriminator, its admin is not this program's admin, or an admin transfer is pending there (4.8, 4.10, review OPS-1) |
| 6057 | `GuardianIsAdmin` | the guardian would be the admin or the proposed admin (`init_launchpad`, `set_guardian`, `propose_admin`, `accept_admin`; 4.1, 4.2, 4.4, review R5-CONS-1) |

Anchor's own errors (for example `ConstraintSeeds`, `AccountNotInitialized`, an `init` on an
existing account) can appear before ours for some substitutions; tests accept either and
check that no balance moved (as LAUNCHPAD-AUDIT.md 7(3) records for today's program). An IDL
instruction returns Anchor error 1000 `IdlInstructionStub` (`no-idl`, 8.4).

---

## 5. Math (exact integers)

### 5.1 Notation

* `D = 10,000`. `ceil(a/b) = (a + b - 1) / b` and `floor(a/b) = a / b` in u128 with `b > 0`.
* Frozen per coin: `t = total_fee_bps`; the five shares `b_L` (liquidity), `b_P`
  (platform), `b_F` (founder), `b_H` (holders), `b_B` (buyback), `t = b_L + b_P + b_F +
  b_H + b_B`; curve `x0 = virtual_sol`, `y0 = virtual_tokens`, `S = curve_supply`,
  `P = pool_supply`, `R = graduation_sol`; `d = y0 - S`; `C = BUYBACK_CAP_DIVISOR = 25`.
* State: `s = tokens_sold`, `r = curve_sol`, `X = pool_sol`, `Y = pool_tokens`,
  `L = liquidity_pending`.
* Virtual reserves (what a quote and the spot price use): curve `(x0 + r, y0 - s)`, pool
  `(X, Y)`. Spot price = virtual SOL / virtual tokens, in lamports per raw unit (multiply by
  1,000 for SOL per coin).
* Curve value function `f(s) = ceil(x0 * s / (y0 - s))` for `0 <= s <= S` (`y0 > S`).
* Inverse `tokens_for(q) = floor(q * y0 / (x0 + q))`.
* Every rounding favours the coin's market or a bucket that stays in it, never a trader;
  the one rounding that favours a trader is the fee itself (rounded down, so it never
  exceeds 2.5%, R2), worth less than one lamport per trade.

### 5.2 Fee and split, both directions

The trade amount `A` is the SOL the buyer is charged (buy) or the gross SOL the market
releases before the fee (sell):

```
fee       = floor(A * t / D)         // at most 2.5%, rounded DOWN
platform  = floor(A * b_P / D)       // each named share rounded DOWN
founder   = floor(A * b_F / D)
holders   = floor(A * b_H / D)
buyback   = floor(A * b_B / D)
liquidity = fee - platform - founder - holders - buyback   // the remainder
```

* Buy: the buyer pays `A = charged`; `A - fee` enters the curve or pool.
* Sell: the market releases `A = gross`; the seller receives `A - fee`; the fee stays in the
  `Coin` account, booked to the five buckets.

**Lemma F.** (a) The five shares add up to `fee` exactly. (b) `floor(A*b_L/D) <= liquidity
<= floor(A*b_L/D) + 4`. (c) `A*t/D - 1 < fee <= A*t/D`: the fee never exceeds `t/D` of the
trade. (d) Each named share is at most its advertised fraction of the trade:
`platform <= A * b_P / D`, and so on.
*Proof.* (a) by construction. (c) and (d): definition of floor. (b) Write
`A*b_i/D = q_i + e_i` with `q_i = floor(A*b_i/D)` and `0 <= e_i < 1` for the five shares.
Then `A*t/D = sum q_i + sum e_i`, so `fee = sum q_i + floor(sum e_i)` with
`floor(sum e_i)` in `{0, 1, 2, 3, 4}` because `sum e_i < 5`; and
`liquidity = fee - (q_P + q_F + q_H + q_B) = q_L + floor(sum e_i)`. QED. The bound 4 is
reached (first at `A = 560` lamports: fee 14, liquidity 6 against a rounded-down share of 2).

Consequences: rounding never favours the platform, the founder or a holder; the remainder
(0 to 4 lamports) stays in liquidity, and it is booked there even in a config with
`liquidity_bps = 0` (the labels say so, 6.6). The fee is below `t/D` of the trade by less
than one lamport, so the buckets under-collect less than 1 lamport per trade; the fee is
exactly 2.5% whenever `A` is a multiple of 40 lamports, and a trade below 40 lamports pays
none (only sells can be that small, O5). Splitting a sell into dust pieces saves at most
1 lamport per instruction, and a transaction holds roughly 25 to 40 sells (size and compute
limits) against a 5,000-lamport signature fee, so it cannot be farmed. Buys are at least
0.0001 SOL (a fee of at least 2,500 lamports). Fee rounding is therefore no longer an open
question (O4).

### 5.3 The curve as a state function

The curve is pump.fun's constant product on virtual reserves,
`(x0 + r)(y0 - s) = x0 * y0`, which gives the lamports the curve must hold after `s` raw
coins are sold: `g(s) = x0 * s / (y0 - s)`. The program uses its integer ceiling `f(s)` as a
**state function**: on the curve, `curve_sol = f(tokens_sold)` after every instruction,
because every curve operation writes `curve_sol := f(s')` for the new `s'`.

**Lemma C1 (inverse).** For integers `q >= 0` and `0 <= s' < y0`:
`f(s') <= q` if and only if `s' <= tokens_for(q)`.
*Proof.* `ceil(z) <= q` iff `z <= q` for integer `q`. `x0*s'/(y0 - s') <= q` iff
`s'(x0 + q) <= q*y0` iff `s' <= q*y0/(x0 + q)` iff `s' <= floor(q*y0/(x0 + q))`. QED.

**Lemma C2 (steps of at most one lamport).** If `x0 * y0 <= (y0 - S)^2` (config rule V6),
then for every `0 <= s < S`: `0 <= f(s+1) - f(s) <= 1`. Hence `f` takes every integer value
in `[0, R]`.
*Proof.* `g(s+1) - g(s) = x0*y0 / ((y0 - s)(y0 - s - 1)) <= x0*y0/(y0 - S)^2 <= 1`, since
`y0 - s - 1 >= y0 - S`. For `0 < delta <= 1`, `ceil(z + delta) - ceil(z) <= 1`. `f(0) = 0`,
`f(S) = R`, `f` non-decreasing with unit steps. QED.

**Lemma C3 (exact absorption).** Under V6, for `r = f(s)` and any `q` with `r <= q < R`:
`s' = tokens_for(q)` satisfies `s <= s' < S` and `f(s') = q`.
*Proof.* By C2 some `s''` has `f(s'') = q`; by C1 and maximality `s'' <= s'`, so
`q = f(s'') <= f(s') <= q`. `f(s) = r <= q` gives `s <= s'`; `f(S) = R > q` gives `s' < S`.
QED. So a buy that does not complete the curve uses every net lamport: **no dust**. On the
default curve the margin is a factor 2,434 (`(y0 - S)^2 / (x0*y0) = 2,434.1`): the marginal
price never exceeds 0.000411 lamport per raw unit, so one lamport always buys at least 2,434
raw units.

**Reachable curve states.** `tokens_for(q)` is the largest `s` with `f(s) <= q` (C1), so
every buy and buyback lands on the top of a step of `f`; a sell must release at least one
lamport (`ZeroOutput` otherwise), so it lands strictly below the step it started on. A state
with `curve_sol = f(S - 1)` and `tokens_sold < S - 1` can therefore not be reached by this
program's instructions; the math crate's functions are still specified and tested for it
(U08).

**Theorem C (path independence and solvency).** On the curve the SOL reserve is a function
of `s` alone: `curve_sol = f(s)`. Hence:
1. any sequence of curve trades that returns `s` to a previous value returns `curve_sol` to
   the same lamport; traders as a group lose exactly the fees; no rounding fraction can be
   extracted;
2. sells can never take more than `curve_sol`: selling `t <= s` pays `f(s) - f(s - t) <=
   f(s)` gross;
3. completion (`s = S`) always leaves `curve_sol = f(S) = R` exactly.

Rounding up in `f` means every buy pays at most one lamport above the real integral and
never less; sellers receive the same differences back. A sell of a few raw units inside a
flat step of `f` has `gross = 0` and is refused (`ZeroOutput`), so nobody gives coins for
nothing or farms a flat.

Equivalence with design A: A's `(base_reserve B, quote_reserve Q)` with
`Q = ceil(k / (B + x1)) - y0_A` is the same function with `s = S - B` (A's `T` is this
file's `S`), `x1 = d`, `y0_A = x0`; A's buy formula `X' = ceil(k / (Y + n))` gives the same `s'` as
`tokens_for(r + n)`. The two designs priced the same curve; this file stores it as B does.

### 5.4 Curve buy, including the partial fill of the last buy

`buy(sol_in = G, min_tokens_out)` in phase Curve:

```
require G >= MIN_TRADE_LAMPORTS
n    = G - floor(G * t / D)                // net lamports offered to the curve (>= 97,500)
rem  = R - r                               // lamports still needed (>= 1: r <= f(S-1) <= R-1, V5b)
if n >= rem:  s' = S;  c = rem;  graduates = true        // completes (maybe partially filled)
else:         s' = tokens_for(r + n);  c = f(s') - r;  graduates = false   // c == n by C3
charged = (c == n) ? G : floor((c - 1) * D / (D - t)) + 1    // gross-up: least SOL whose net is c
tokens  = s' - s
require tokens >= 1 and tokens >= min_tokens_out
split(charged)                              // 5.2; its fee equals charged - c (Lemma G)
state: s := s'; r := r + c (== f(s')); L += liquidity; buckets += shares
if graduates: 5.6
```

**Lemma G (gross-up).** Let `h(G) = G - floor(G*t/D)`, the net of a charge `G`. For every
`c >= 1`, `G' = floor((c - 1)*D/(D - t)) + 1` is the least `G` with `h(G) = c`; and `G' <= G`
whenever `c <= h(G)`.
*Proof.* `G - floor(G*t/D) = ceil(G - G*t/D) = ceil(G*(D - t)/D)`. So `h(G) >= c` iff
`G*(D - t)/D > c - 1` iff `G > (c - 1)*D/(D - t)` iff `G >= G'`. Since `0 < t/D < 1`, `h` is
non-decreasing with `h(G + 1) - h(G)` in `{0, 1}`; with `h(G' - 1) <= c - 1` and
`h(G') >= c` this gives `h(G') = c`. If `c <= h(G)` then `G >= G'` by minimality. QED. The
reference model checks it for every `c` below 200,000 at `t` in {1, 37, 249, 250} and for
every `t` in [1, 250] with `c` below 2,000.

Properties:
* The program transfers exactly `charged` from the buyer; the rest of `sol_in` never leaves
  the buyer's wallet, so there is no refund path.
* `fee(charged) = charged - c` for every buy, partial or not (Lemma G, or `c = n = h(G)`).
* The partial fill happens only on the buy that completes the curve. It delivers exactly the
  coins left (`S - s`) for exactly the lamports still needed (`R - r`) plus their fee. By V5b
  `R - r >= 1`, so the completing buy always puts at least one lamport into the curve and
  nothing is ever delivered for nothing. On the default curve `f(S - 1) = R - 1`: when the
  curve holds `R - 1`, the next buyer is charged 1 lamport (fee 0) for the last raw unit.
* `min_tokens_out` is a strict minimum (M13): a buyer who expected more coins than remain is
  refused, pays nothing and can re-quote. `max_quote_in(coin) = max(MIN_TRADE_LAMPORTS,
  floor((rem - 1) * D / (D - t)) + 1)` (math crate) is the `sol_in` that completes the curve
  exactly.
* The strict minimum limits the price only for the `sol_in` it was quoted for. A client that
  offers more than `max_quote_in` with a minimum taken from the partial quote (which prices
  only the remainder) loses its price limit if someone else graduates the coin first: the buy
  then runs in the pool, is charged all of `sol_in`, and still clears the small minimum (review
  R3-CLI-1: a 20 SOL "pay with any token" buy near graduation paid 4.9 times the quoted price,
  and a searcher took 10.77 SOL). So every client offers at most `max_quote_in` on a buy that
  completes the curve (14.1, 14.3; the SDK's `buyLeg` caps it), and the extra SOL stays in the
  wallet. The program cannot tell the two cases apart; M13's price limit would not help
  either, since the minimum was computed for the smaller charge.
* Within about 97,500 lamports of graduation (`gross_for(rem) < MIN_TRADE_LAMPORTS`; a buy can
  leave the curve there, and the curve buyback always stops at `S - 1`, 1 lamport short)
  `max_quote_in` is `MIN_TRADE_LAMPORTS`, and a buy of it is still a partial fill: it takes the
  last `S - s` raw units for `gross_for(rem)`. The SDK's `buyLeg` offers exactly
  `max_quote_in` there and takes the minimum from that quote (at least one raw unit); if
  someone graduates the coin first, the buy runs in the pool and is charged
  `MIN_TRADE_LAMPORTS`, so the exposure left is 0.0001 SOL (review R4-DIFF-1: the round-3 cap
  at the bare charge made every SDK buy fail with `TradeTooSmall` in this range).
* The buy does not continue into the new pool in the same instruction (O18): one pricing path
  per instruction; the next trade uses the pool.

### 5.5 Curve sell

```
require tokens_in >= 1 and tokens_in <= s           // SellExceedsCurve
s'    = s - tokens_in
gross = r - f(s')                                    // <= r
split(gross); out = gross - fee
require out >= 1 and out >= min_sol_out
state: s := s'; r := f(s'); L += liquidity; buckets += shares
pay out `out` lamports to the seller
```

### 5.6 Graduation rule

A coin graduates **if and only if a `buy` in phase Curve brings `tokens_sold` to `S`**. In
the same instruction, after the trade's own booking:

```
phase           = Pool
pool_sol        = R          // == curve_sol == f(S), exactly
pool_tokens     = P          // already in the vault since launch
graduated_at    = now; graduation_slot = slot
liquidity_pending unchanged  // enters the pool by the drip (5.8)
emit Graduated
```

No CPI, no account creation, no external program, no new address. It cannot fail on its
own, cannot happen twice (the curve branch is unreachable in phase Pool), cannot be
pre-created or blocked by a third party, and needs no keeper. The buyback never graduates
(7.1). The account lists of `buy` and `sell` do not change. At this instant the vault holds
exactly `P` (plus donations) because every curve coin has been sold or burned.

### 5.7 Pool phase

Constant product on the stored reserves `(X, Y)`:

```
buy(G):   require G >= MIN_TRADE_LAMPORTS
          n = G - floor(G*t/D); c = n; charged = G
          tokens = floor(Y * n / (X + n));  require tokens >= 1 and tokens >= min_tokens_out
          X := X + n;  Y := Y - tokens
sell(t):  gross = floor(X * t / (Y + t));  out = gross - fee(gross)
          require out >= 1 and out >= min_sol_out
          X := X - gross;  Y := Y + t
then, in both, after pricing (A = charged or gross):
          drip = min(L, floor(A * b_L / D))     // the trade's rounded-down share, never the remainder
          X := X + liquidity + drip;  L := L - drip;  liquidity_added += liquidity + drip
```

**Lemma P.** In phase Pool, `X * Y` never decreases, `tokens < Y`, `gross < X`, and both
reserves stay positive.
*Proof.* Buy: `tokens <= Y*n/(X + n)` gives `(X + n)(Y - tokens) >= X*Y`. Sell:
`gross <= X*t/(Y + t)` gives `(X - gross)(Y + t) >= X*Y`. The liquidity share and the drip
only add to `X`. `n/(X + n) < 1` and `t/(Y + t) < 1`. QED. Even if every coin in existence
were sold into the default pool, `X >= R*P / 10^15 = 17.5865 SOL`.

The trade's output is computed before its own liquidity share and drip are added, so no
trade benefits from its own contribution.

### 5.8 The liquidity bucket (default "added to this coin's liquidity")

```
Curve phase, every trade:  L += liquidity
Pool phase, every trade:   drip = min(L_before, floor(A * b_L / D)); X += liquidity + drip; L -= drip
Always:                    liquidity_earned += liquidity
                           liquidity_earned == liquidity_added + L
```

What "added to liquidity" means here, accurately: the SOL enters the pool's SOL reserve
**without adding coins**, so it deepens the pool and raises the price. Nobody can withdraw it
as liquidity, but like all pool SOL it is paid out to sellers through trades: on a full exit,
sellers receive `C/(Y + C)` of every injected lamport, where `C` is the coins outside the
pool (at graduation `793,099,990 / 999,999,990.9 = 79.3%`); only `Y / supply` of it (20.7% at
graduation) stays as a permanent floor, since `X_floor = X*Y / supply`.

Why this treatment (R2 default, the alternatives are owner decisions O1 and O2):

| option | effect | verdict |
|---|---|---|
| add the curve-phase liquidity to the pool **at graduation** | the pool opens with `R + L` SOL against `P` coins, a price jump of `L/R`: 0.5% with no churn, 5% at 10x churn, which pays a sniper who buys the last curve coins and sells after graduation | refused |
| compound it into the curve | the curve stops being a function of `s`; graduation would move off R8's 793,099,990 coins, or the pool would need coins that do not exist | refused |
| **hold it as `liquidity_pending`, then move at most each pool trade's rounded-down liquidity share into `X`** | no jump at graduation (5.10); the pool deepens at the pace of trading; no crank; not farmable under V10 (7.5). **If the coin never graduates, the set-aside share is never used** | **default**, with the owner's sign-off on the never-graduating case (O2) |
| spend the curve-phase share through the capped buyback path (coins counted as sold and burned) | the SOL enters `curve_sol`, which sellers cannot withdraw below `f(burned)` and which moves to the pool at graduation; nothing sits idle and there is no drip; but it is buy-and-burn, not liquidity, before graduation, it shares the buyback's backlog risk (7.3), and it changes the label | owner alternative O2(a) |
| route the 0.5% elsewhere in a future config | set `liquidity_bps = 0` and give the basis points to another bucket within the caps (platform at most 1.2%) | owner option O1 |

Honest consequence: most launchpad coins never graduate. For such a coin the set-aside
liquidity stays in the `Coin` account forever, counted in `liquidity_pending`, benefiting no
one: 0.5% of its curve volume (for example 1 SOL for a coin that dies after 200 SOL of curve
trading). I22 names it as an intended permanent balance; the website label (6.6) says it.

### 5.9 The default parameter integers, and the proof that they reproduce R8

**R8's figures.** R8 asks for 1,000,000,000 coins, 793,099,990 sold on the curve and
206,900,000.9 kept for the pool. These add up to 999,999,990.9 coins: 9,100,000 raw short of
the 10^15 minted. Today Meteora's DBC sends those 9.1 coins to the dev wallet. Each option
keeps two figures or adds a path:

| option | supply after launch | sold | pool | cost |
|---|---|---|---|---|
| **(a) burn the 9.1 coins at launch (default config #0)** | 999,999,990.9 | 793,099,990 | 206,900,000.9 | one SPL `burn` in `launch` (already in the program) |
| (b) send them to `FEE_RECIPIENT`'s token account, as today | 1,000,000,000 | 793,099,990 | 206,900,000.9 | code: an associated token account for the dev wallet created in every launch (about 0.0015 SOL of rent paid by the founder, for coins worth about 0.0000037 SOL at the graduation price) and a token path out of the vault at launch |
| (c) put them in the pool (revision 1's default) | 1,000,000,000 | 793,099,990 | 206,900,010 | none; integers `x0 = 30,000,855,424`, `y0 = 1,073,025,615,141,714`, pool 7.9e-12 below the curve |

(a) and (c) are configs of the same code; (b) needs code. The owner chooses before the audit
freeze (O3). R8 says to keep today's figures unless a requirement forces a change; no
requirement forces the pool figure to change, so the default keeps it.

**Continuous design.** With `S` coins sold on the curve, `P` kept for the pool and raise
`R`: the curve requires `x0*S/(y0 - S) = R` and continuity requires
`(x0 + R)/(y0 - S) = R/P`. Solving: `y0* = S^2/(S - P)`, `x0* = R*P/(S - P)` (the pump.fun
formula). With `S = 793,099,990,000,000`, `P = 206,900,000,900,000` and
`R = 85,000,000,000`: `x0* = 30,000,853,639.559`, `y0* = 1,073,025,598,488,534.9`.

**Integer conditions.** (1) Exact completion: `f(S) = R`, i.e.
`(R - 1) * d < x0 * S <= R * d` with `d = y0 - S`, i.e.
`ceil(x0*S/R) <= d <= floor((x0*S - 1)/(R - 1))`. (2) One-sided continuity (V7): the pool's
opening price `R/P` must not exceed the curve's last spot price `(x0 + R)/d`, i.e.
`R*d <= (x0 + R)*P`, as close to equality as possible. (3) V5b and V6. A search over `x0`
within 20,000 of `x0*` (taking for each `x0` the largest admissible `d`) gives the minimum at
design A's integers:

```
virtual_sol     x0 = 30,000,853,639              (30.000853639 SOL)
virtual_tokens  y0 = 1,073,025,598,486,615       (1,073,025,598.486615 coins)
curve_supply    S  =   793,099,990,000,000       (793,099,990 coins)       R8 exact
pool_supply     P  =   206,900,000,900,000       (206,900,000.9 coins)     R8 exact
graduation_sol  R  =        85,000,000,000       (85 SOL)                  R8 exact
dust               =             9,100,000       (9.1 coins burned at launch, O3)
d = y0 - S         =   279,925,608,486,615
k = x0 * y0        = 32,191,683,931,097,316,515,541,985   (85 bits)
```

**Proof of exact completion:**

```
(R - 1) * d = 23,793,676,721,082,349,391,513,385
x0 * S      = 23,793,676,721,082,363,610,000,000
R * d       = 23,793,676,721,362,275,000,000,000
```

so `(R - 1)d < x0*S <= R*d` and `f(S) = ceil(84,999,999,999.00005) = 85,000,000,000 = R`.
V5b: `f(S - 1) = 84,999,999,999 = R - 1`.

**What this reproduces (R8):**

| R8 value | here | how |
|---|---|---|
| 1,000,000,000 coins at 6 decimals | `COIN_SUPPLY = 10^15` minted once; 9,100,000 raw burned in the same instruction; supply after launch 999,999,990.9 coins | V3; O3 |
| 793,099,990 coins sold on the curve | exactly `S` raw units | graduation fires exactly at `tokens_sold = S` |
| graduation at 85 SOL | `curve_sol = f(S) = 85,000,000,000` exactly | Theorem C(3) |
| about 30 SOL and 1,073,000,000 coins virtual | 30.000853639 SOL and 1,073,025,598.486615 coins | |
| 206,900,000.9 coins kept for the pool | exactly `P = 206,900,000,900,000` raw | R8 exact |
| start market cap (DBC today 27.96 SOL) | 27.959 SOL (`x0/y0 * 10^15 / 10^9`) | |
| end market cap (DBC today 410.83 SOL) | 410.826 SOL (`R/P * 10^15 / 10^9`) | |
| launch fee 0.05 SOL | `launch_fee_lamports = 50,000,000`, all to `FEE_RECIPIENT`, cap 0.5 SOL | V9 |

Exact absorption (V6): `d^2 / (x0*y0) = 2,434.1 >= 1`. Filling the whole curve from the
start in one buy charges exactly `floor(84,999,999,999 * 10,000 / 9,750) + 1 =
87,179,487,179` lamports. A 1 SOL first buy gets 33,774,693.369781 coins.

The SDK ships `derive_curve(S, P, R)`, the search above, so a future config gets proven
integers the same way; `add_launch_config` re-checks V3 to V7 on chain.

### 5.10 Price continuity at graduation

* Curve's last state is exactly `(x0 + R, d)` (integer state, virtual reserves), spot price
  `(x0 + R)/d = 0.000410826484438986` lamport per raw unit.
* Pool's first state is exactly `(R, P)` (the curve-phase liquidity is not added),
  spot price `R/P = 0.000410826484438164`.
* `(x0 + R)*P - R*d = 47,593,275,100,000 >= 0`, relative gap `2.00e-12`: **the pool opens
  2.0 parts in a trillion below the curve's last price, never above.** V7 requires
  `0 <= (x0 + R)P - R*d <= floor((x0 + R)P / 10^9)` for every config (at most 1 part per
  billion, never above).
* Against the real curve's derivative `x0*y0/d^2 = 0.000410826484435414` the pool is
  6.7e-12 above (because `f(S)` rounds `84,999,999,999.00005` up). Either way the difference
  is below one lamport on a trade the size of the whole pool, and far below the two 2.5%
  fees an arbitrage would pay.
* Same fee on both sides: at most 2.5% of the SOL leg before and after; the liquidity share
  never enters curve pricing and enters the pool only after each trade is priced. So the
  all-in price of the next unit is the same just before and just after graduation.
* Arbitrage at graduation (buy the last curve coins, sell them into the new pool) returns at
  most `(1 - f)^2 = 95.06%` of the SOL put in, a loss of about 4.94%: the curve buy injects
  nothing into the pool, the sell's own liquidity share is added only after it is priced, and
  the pool opening below the curve only adds to the loss.
* Depth changes (inherent to the pump.fun shape, not a price jump): the curve behaves like a
  pool with `k = 3.219e25`, the real pool has `R*P = 1.759e25` (54.6%). A 1 SOL buy just
  after graduation gets 2,346,350.693544 coins.

### 5.11 Rounding table

| quantity | rounding | in whose favour | why it cannot be farmed |
|---|---|---|---|
| total fee | down | the trader, by less than 1 lamport | R2 (never above 2.5%); dust splitting saves at most 1 lamport per instruction against a 5,000-lamport signature (5.2) |
| platform, founder, holders, buyback shares | down | liquidity | remainder at most 4 lamports, stays in the market |
| drip | down (the share's floor; the remainder never drips) | the set-aside bucket | V10 and 7.5 |
| curve value `f(s)` | up | curve | Theorem C: reserve is a function of `s` |
| curve coins out (`tokens_for`) | down | curve | Lemma C1 and C3 |
| curve sell gross `r - f(s')` | down (via `f` up) | curve | Theorem C |
| pool coins out, pool lamports out | down | pool | Lemma P |
| partial-fill charge (gross-up) | least charge with exact net | nobody | Lemma G: net is exactly `c`, fee at most 2.5% |
| buyback cap | down | (smaller buyback) | |

### 5.12 Overflow bounds (all products in u128, all sums checked, narrowing by `try_from`)

| expression | bound | fits |
|---|---|---|
| `x0 * s` in `f` | `2^60 * 10^15 = 1.2e33` | u128 (3.4e38) |
| `q * y0` in `tokens_for`, `q < R` on trades | `10^13 * 2^60 = 1.2e31` | u128 |
| `q * y0` in the buyback's `tokens_for`, `q = curve_sol + b` with `b <= (x0 + R)*t/(C*D)` | `(R + (2^60 + R)*250/250,000) * 2^60 <= 1.35e33` (reference model: 1.341e33 at `x0 = y0 = 2^60`, `R = 10^13`) | u128 |
| `A * t` in the fee (`A <= u64::MAX`) | `1.8e19 * 250 = 4.6e21` | u128 |
| `A * b_i` in the split | same | u128 |
| `(c - 1) * D` in the gross-up | `10^13 * 10^4 = 1e17` | u128 |
| `Y * n`, `X * t_in`, `Y * b` in the pool | `< 2^64 * 2^64` | u128 |
| `depth * t` in the buyback cap | `< 2^64 * 2^8` | u128 |
| `x0 * y0`, `d^2` (V6) | `< 2^120` | u128 |
| `R * P * t` (V4) | `10^13 * 10^15 * 250 = 2.5e30` | u128 |
| `(x0 + R) * P`, `R * d` (V7) | `< 1.2e33` | u128; the 10^-9 tolerance is applied by division |
| V8: `100 * ((CD + t)^2 (D - t + 2b_L + m)(D - t + 2b_L) + m D (CD)^2)` | `< 7e20` (`2b_L + m <= 2t <= 500`) | u128 |
| V11 products | `< 3e9` | u64 |
| pending buckets, reserves | real lamports and raw units | u64, checked |
| lifetime counters | u128 | never overflow in practice; checked anyway |

`overflow-checks = true` in the release profile is a second net. P10 and U09 include
`x0 = y0 = 2^60`, `t = 250`.

### 5.13 `validate_config` (pure; run at `add_launch_config` and again at every `launch`)

`m = max(b_F, b_H)`: the share V8 and V11 credit an attacker back on his own legs (the founder's
share, or the holders' share for someone holding the float; MATH-3's modelling). A founder who
also holds the float is credited both, `b_F + b_H`, and V2b bounds that sum (review R3-DIFF-1).
When `b_B > 0`, V8 and V11 still credit only `m`: for that founder their bounds are the tested
heuristic of 7.3 (P06 credits him `(b_F + b_H)/D`), not a proof. Nor do they count the platform's
share: `withdraw_platform_fees` pays all of `platform_pending` to `FEE_RECIPIENT`, so whoever holds
that key gets `b_P` of his own legs back, and `b_P` can exceed `m` (70 against 50 in config #0).
V8, V11 and every MEV bound below therefore hold for traders other than the platform's key and
its owner; the platform's key is covered by the operating rule of 8.4 and its measured envelope
in 7.3 (review HR-1). Counting `b_P` in `m` would make config #0 fail V11's second inequality
(2,418,175,000 > 2,412,990,000); a horizon of its own for the platform is owner decision O29.

| # | rule | error |
|---|---|---|
| V1 | `1 <= t = b_L + b_P + b_F + b_H + b_B <= 250` (summed in u32) | `ConfigFeeTotal` |
| V2 | `b_P <= 120` and `b_F <= 100`, and **V2b** `b_F + b_H + MIN_TOTAL_FEE_BPS <= t`, the same as `b_L + b_P + b_B >= 1` (a trader credited the founder's share, the holders' share or both, as a founder who also holds the float is, still pays at least 0.01% per leg, with or without a buyback share; reviews ECON-1, R3-DIFF-1) | `ConfigFeeShareCap` |
| V3 | `S >= 1`, `P >= 1`, `S + P <= 10^15`, `10^15 - S - P <= MAX_DUST_RAW` | `ConfigSupply` |
| V4 | `1 <= x0 <= 2^60`, `S < y0 <= 2^60`, `x0 * t >= C * D` and `R * P * t >= C * D * 10^15` (the buyback cap is at least 1 lamport in every reachable state of either phase, 7.1) | `ConfigCurveBounds` |
| V5 | `f(S) = ceil(x0*S/(y0 - S)) == graduation_sol`, `1 SOL <= graduation_sol <= 10,000 SOL`, and **V5b** `f(S - 1) <= R - 1` (the completing buy always puts at least one lamport into the curve, 5.4) | `ConfigGraduation` |
| V6 | `x0 * y0 <= (y0 - S)^2` (Lemma C2) | `ConfigAbsorption` |
| V7 | `0 <= (x0 + R)*P - R*(y0 - S) <= floor((x0 + R)*P / 10^9)` | `ConfigContinuity` |
| V8 | if `b_B > 0`: `100 * ((C*D + t)^2 * (D - t + 2*b_L + m) * (D - t + 2*b_L) + m * D * (C*D)^2) <= 99 * (C*D)^2 * D^2` (single-run bound for an attacker credited `m` on both legs, 7.3; not the platform's key, which is credited `b_P`, review HR-1) | `ConfigBuybackMev` |
| V9 | `launch_fee_lamports <= 500,000,000` | `ConfigLaunchFee` |
| V10 | `b_L == 0` or `b_L < b_P` (the drip can never return more than the platform share costs, 7.5) | `ConfigDripFarmable` |
| V11 | if `b_B > 0`: `C*(D - t)*(D - t + 2*b_L) <= D*(C*D - 38*t)` and `C*(D - t + 2*b_L)*(D - t + m) <= (D - m)*(C*D - 28*t)` (a hold through fewer than 20 runs, or 15 for an attacker credited `m`, is unprofitable, 7.3; not the platform's key, review HR-1) | `ConfigBuybackHorizon` |

Default config #0 passes with margins: V2 70 against 120 and 50 against 100, V2b
`t - b_F - b_H = 150` against 1; V6 by a factor
of 2,434; V7 at 2.0e-12 against 1e-9; V8 at 0.98210 against 0.99 (left side
613,813,296,968,750,000,000, right side 618,750,000,000,000,000,000); V10 50 < 70; V11
2,400,937,500 <= 2,405,000,000 and 2,413,250,000 <= 2,417,850,000. V11 limits
`liquidity_bps` to about 58 at `t = 250` while a buyback share exists (more liquidity
injection shortens the hold a multi-run strategy needs).

### 5.14 Worked examples (default config, exact lamports and raw units)

Produced by Appendix A. "Coins" are raw units divided by 10^6.

**E1. Buy 1 SOL at launch (curve).** `sol_in = 1,000,000,000`.
* fee 25,000,000 = liquidity 5,000,000 (to `liquidity_pending`) + platform 7,000,000 +
  founder 5,000,000 + holders 5,000,000 + buyback 3,000,000.
* net 975,000,000 into the curve; `s' = tokens_for(975,000,000) = 33,774,693,369,781`.
* **33,774,693.369781 coins** to the buyer; `charged = 1,000,000,000`.
* After: `tokens_sold = 33,774,693,369,781`, `curve_sol = 975,000,000 = f(s')`, virtual
  reserves `(30,975,853,639, 1,039,250,905,116,834)`; `Coin` lamports = `rent_reserve` +
  1,000,000,000 = `rent_reserve` + curve_sol + 5,000,000 + 7,000,000 + 5,000,000 +
  5,000,000 + 3,000,000.

**E2. Sell those coins straight back (curve).** `tokens_in = 33,774,693,369,781`.
* gross = `975,000,000 - f(0)` = **975,000,000** (path independence).
* fee 24,375,000 = liquidity 4,875,000 + platform 6,825,000 + founder 4,875,000 + holders
  4,875,000 + buyback 2,925,000.
* **950,625,000 lamports** to the seller. The round trip costs 4.9375%.
* After: `tokens_sold = 0`, `curve_sol = 0` exactly; buckets hold the two fees:
  `liquidity_pending 9,875,000`, platform 13,825,000, founder 9,875,000, holders 9,875,000,
  buyback 5,925,000 (sum 49,375,000 = lamports above `rent_reserve`).

**E3. Fill the whole curve from launch in one buy (send 100 SOL).**
* charged **87,179,487,179** (12.82 SOL never leaves the wallet); partial fill; graduates.
* fee 2,179,487,179 = liquidity 435,897,438 + platform 610,256,410 + founder 435,897,435 +
  holders 435,897,435 + buyback 261,538,461.
* 793,099,990.000000 coins; pool opens with `pool_sol = 85,000,000,000`,
  `pool_tokens = 206,900,000,900,000`; `liquidity_pending = 435,897,438`.

**E4. Buy 1 SOL just after E3 (pool).** `sol_in = 1,000,000,000`.
* fee 25,000,000 (5,000,000 / 7,000,000 / 5,000,000 / 5,000,000 / 3,000,000); net
  975,000,000.
* tokens = `floor(206,900,000,900,000 * 975,000,000 / 85,975,000,000)` =
  **2,346,350.693544 coins**.
* Then liquidity 5,000,000 + drip 5,000,000 into the pool: `pool_sol = 85,985,000,000`,
  `pool_tokens = 204,553,650,206,456`, `liquidity_pending = 430,897,438`.

**E5. Sell the E4 coins back (pool).** `tokens_in = 2,346,350,693,544`.
* gross = `floor(85,985,000,000 * 2,346,350,693,544 / 206,900,000,900,000)` =
  **975,113,405** (above E4's 975,000,000 net because E4's liquidity and drip deepened the
  pool before this sell).
* fee 24,377,835 = liquidity 4,875,568 + platform 6,825,793 + founder 4,875,567 + holders
  4,875,567 + buyback 2,925,340 (liquidity is the rounded-down share + 1: the remainder).
* **950,735,570 lamports** to the seller; drip 4,875,567 (the rounded-down share; the
  remainder is not dripped); after: `pool_sol = 85,019,637,730`,
  `pool_tokens = 206,900,000,900,000`, `liquidity_pending = 426,021,871`. The round trip
  costs 4.9264%.

**E6. Partial fill.** The curve holds 84.5 SOL (reached by one buy of 86,666,666,666
lamports from launch, net exactly 84,500,000,000; `tokens_sold = 791,877,616,545,871`).
A buyer sends 1 SOL:
* `rem = 500,000,000 < n = 975,000,000`: completes; `c = 500,000,000`;
  `charged = floor(499,999,999 * 10,000 / 9,750) + 1 = 512,820,512`; fee 12,820,512 =
  2,564,104 / 3,589,743 / 2,564,102 / 2,564,102 / 1,538,461.
* 1,222,373.454129 coins (exactly `S - s`); graduates; 487,179,488 lamports stay in the
  buyer's wallet. `max_quote_in` at that state is 512,820,512.

**E7. Buyback right after E3** (150 slots later): `buyback_pending = 261,538,461`; cap =
`floor(85,000,000,000 * 250 / 250,000) = 85,000,000`; spends 85,000,000 (176,538,461 stays
pending for the next runs); burns 206,693.307592 coins; `pool_sol = 85,085,000,000`,
`pool_tokens = 206,693,307,592,408`; price +0.200%; supply 999,793,297.592408 coins.

**E8. Buyback on the curve after a 10 SOL buy** (263,189,306.077696 coins bought; 150 slots
later): `buyback_pending = 30,000,000`; depth `x0 + r = 39,750,853,639`; cap 39,750,853;
spends 30,000,000; burns 610,723.163277 coins (counted as sold: `tokens_sold =
263,800,029,240,973`, `curve_sol = 9,780,000,000`); price +0.151%.

**E9. Smallest buy.** 100,000 lamports: fee 2,500 = 500 / 700 / 500 / 500 / 300; 3,487.222633
coins at launch.

**E10. The last raw unit.** When the curve holds `R - 1 = 84,999,999,999` lamports
(`tokens_sold = S - 1`), a buy of any `sol_in >= 0.0001 SOL` is charged 1 lamport with a fee
of 0 and receives the last raw unit; the coin graduates.

Other figures: buyback cap per run at launch 30,000,853 lamports, at the end of the curve
115,000,853, at pool open 85,000,000; the smallest possible cap is 30,000,853 on the curve
and 17,586,500 in the pool. All fees of a curve filled in one buy: 2.179 SOL, of which 0.610
to Vicinity, 0.436 to the founder, 0.436 to holders, 0.262 to buyback and 0.436 set aside for
the pool.

### 5.15 Round trips and ordinary sandwiches

* **Curve:** by Theorem C a closed cycle returns `curve_sol` to the same value, so the actor
  loses exactly the fees paid.
* **Pool:** `X*Y` never decreases (Lemma P). A buy then a sell of the same coins returns at
  most `(1 - f)(1 - f + 2*b_L/D)` of the charge (the buy's liquidity share and drip deepen
  the pool for the sell): a loss of at least 3.96% at the default split. The reference model
  ran 20,000 random round trips (curve and pool, with and without pending liquidity): the
  smallest loss was 4.04%.
* **Sandwiching an ordinary trader** works as on any constant-product market: the victim's
  price impact must exceed about twice the attacker's own cost per leg and the victim's
  slippage must allow it. That cost is the fee `t` for an outsider and `t - b_F` for the
  coin's founder, who is credited his share of his own legs (at most `t - b_H` for someone
  holding the float, and at most `t - b_F - b_H` for a founder who also holds it); V2b keeps
  all three at `MIN_TOTAL_FEE_BPS` (0.01%) or more. On a config with a small net fee, X44's
  0.01% platform-only config for anyone, a 1% founder share with 0.01% left for its founder,
  or founder and holders shares with 0.01% left for a founder holding the float, the attacker
  can take nearly the whole slippage the victim allows (measured about 99 bps at 1% and 199
  bps at 2%, review ECON-1; 99.3 bps of a 1 SOL buy at 1% under (0, 1, 50, 50, 0), review
  R3-DIFF-1).
* **The size threshold (review MATH3-1).** For a victim buy of `V` lamports allowing a
  slippage `σ`, the attacker's best front-run (the largest that still lets the victim's buy
  pass) earns about `σ * (V - (c/D) * depth)`, where `c` is his cost per leg and `depth` the
  market's SOL depth (`x0 + curve_sol` on the curve, `pool_sol` in the pool). So below
  `V* = (c/D) * depth` no sandwich profits at any slippage, and above it any slippage the
  victim allows is taken almost entirely (94% of it for a 5 SOL buy on a fresh coin). Under
  config #0, `V*` is 2.5% of depth for an outsider (0.75 SOL on a fresh coin, whose depth is
  `x0` = 30 SOL; measured first profit 0.79 SOL), 2.0% for the coin's founder (0.60 SOL;
  measured 0.63 SOL), 1.5% for a founder who also holds the float and 1.8% for whoever holds
  the platform's key (HR-1). So config #0 does **not** make 1% to 2% safe for ordinary sizes:
  revision 3 said "no ordering profits at the website's slippage", which held only below these
  sizes (measured on chain by the review: a 1 SOL buy at 1% on a fresh coin is sandwiched for
  +0.0020 SOL, 2 SOL for +0.0123 SOL, 5 SOL for +0.0469 SOL; at 40 SOL raised from 2 SOL).
  The program is correct (it enforces the minimum); the defence is the client's slippage.
  **Defence:** `min_tokens_out` / `min_sol_out`, with a slippage that depends on size, for buys
  and sells alike (a sell is sandwiched the same way by any holder: sell first, buy the same
  coins back; review R4-DIFF-5). The SDK's `sandwichThreshold(terms, state)` is
  `floor(depth' * c' / D)`, with:
  * `c' = t - max(b_F + b_H, b_P) - K * ceil(2t/C)`, at least 0: the cheapest credited attacker's
    cost per leg, less what the buyback runs inside the sandwich are worth to him. A due
    `buyback_burn` is permissionless, so he can place one between the victim's trade and his
    back-run; it spends up to `t/(C*D)` of the depth and moves the price his way by about twice
    that (review SDK4-4: at the round-3 threshold with 5%, one run made the founder holding the
    float profit). He can also hold through every run the public backlog pays for, so `K`
    counts them (`sandwichRuns`): `K = max(1, ceil(buyback_pending / cap'))`, with `cap'` a
    run's cap at `depth'` (review KR-1: with one run allowed, a buy at the threshold held
    through 8 runs of a backlog of 0.84% of depth paid the founder +297,718 lamports on chain,
    and through 15 runs of 1.5% an outsider; the model's least `K` with such a buy inside the
    hold is 3 for a founder holding the float, 8 for the founder, 13 for an outsider). The run
    term applies only to configs with a buyback share.
  * `depth' = min(x0 + curve_sol, graduation_sol)` on the curve and `pool_sol` in the pool:
    any curve trade can be pushed into the pool, which opens at depth `graduation_sol`, by
    whoever graduates the coin first (graduate, buy in the new pool, let the victim's
    curve-quoted trade run there, sell; review R4-DIFF-3: near graduation the curve's depth
    reaches 115 SOL against the pool's 85, and a founder holding the float straddled a
    threshold-size buy at 4% to 5% for a profit).
  Under config #0 with at most one cap of backlog `c'` is 130 bps: 0.39 SOL at launch, 0.91 SOL
  at 40 SOL raised, 1.105 SOL from 55 SOL raised and at pool open (a first-order bound, below
  every measured threshold). Each further cap of backlog takes 20 bps more (the buy that
  completes the curve alone leaves about 3 caps: 70 bps, 0.595 SOL at pool open), and from 7.5
  caps (0.75% of depth) nothing is left, so every trade is judged large. A trade above the
  threshold (a buy's charge, a sell's gross) may allow at most `LARGE_BUY_MAX_SLIPPAGE_BPS` =
  0.3%. **At or below it the slippage depends on the size too (review MV-1).** Trades that read
  the same coin and land in one block (a launch, a graduation, the first block after buys
  reopen) are wrapped by one sandwich, and each one's tolerance is room for the trades ahead of
  it: measured on chain, two buys of the threshold at 5% from one snapshot, each safe alone,
  paid the founder +12,722,874 lamports and an outsider +948,502 with the due run inside, the
  victims losing about 2.6% of their 2.21 SOL to the attack. So a trade of size `V` may allow a
  slippage `s` only while `V + depth' * s / (2D)` stays at or below the threshold, that is at
  most `floor(2D * (threshold - V) / depth')`, never more than 5% and never less than 0.3%:
  whatever lands ahead of the last trade must fit within its tolerance (about `depth' * s / 2`),
  so all the trades one sandwich wraps stay under the threshold together. Under config #0: about
  2.6% for the smallest trades, 1.93% at 0.1 SOL and 1% up to 0.24 SOL on a fresh coin, 1% up to
  0.68 SOL at pool open, 0.3% in the top 0.15% of depth below the threshold, never 5% (5% would
  need 250 bps of cost left). Enforced by `buyLeg`, `buyWithSwap` and `sellLeg` for a minimum
  given or derived; `buySlippagePolicy` and `sellSlippagePolicy` give the maximum and the
  default (1%, or the maximum when it is lower).
  **Splitting is no defence** (review R4-DIFF-2): an attacker can hold his position across
  separate transactions, front-run the first piece and sell after the last, so a large trade
  split into threshold-size pieces at 1% each loses about 1% of the whole (measured on chain:
  13 pieces of a 5 SOL buy, 0.93%, the outsider +0.044 SOL). A client that splits an order
  anyway judges every piece by the order's total (`orderSolIn`, `orderGross`: 0.3% per piece)
  and anchors every piece's minimum to the order's start (`order`: the coin as read when the
  order began, the size of each earlier piece, what they delivered): the piece must deliver at
  least `floor(Q * (D - s) / D) - received`, where `Q` is what the earlier pieces and this one
  deliver in sequence from the start with no other trade, and the SDK refuses the piece (ending
  the order) once the coin's current quote is below that. The whole order then loses at most
  `s` against its quote at the start, whatever happens between its pieces (review R5-DIFF-1:
  with each piece's 0.3% re-quoted from a fresh read, as round 4 allowed, a searcher who bought
  ahead of every piece by the most it still cleared took 187 bps of a 5 SOL order and 327 bps of
  a 10 SOL one, since each tolerance was measured from a price that already held his earlier
  buys; anchored, 29 bps, measured on chain). Pieces signed together from one snapshot pass, for
  each piece, the snapshot advanced by the earlier pieces as the coin and their quoted coins as
  `received`. An order restarted from a fresh read starts a new budget, so a client that restarts
  after every refusal gives the bound up. Measured with the SDK model, which equals the program
  to the lamport (G01), and on chain: one trade alone at the threshold loses for every attacker
  class (an outsider, the founder, the founder holding the float, the platform's key) at every
  slippage up to 5%, in both phases, also when the trade is pushed from the curve into the pool
  by a graduation and with every run the backlog pays for inside the sandwich; at the sizes the
  size rule allows, one to three trades from one snapshot wrapped together lose for every class
  with every run inside (0.5% to 2.6%, at launch, at 40 SOL raised and at pool open with backlogs
  of 0 to 7 caps); above the threshold a 0.3% limit caps the victim's loss at 0.3%, and the
  attacker keeps at most about that (nearly all of it when a backlog sits inside the hold). The
  threshold is a property of everything a sandwich can wrap, not of one trade: a client outside
  the SDK that allows 5% at the threshold is safe alone and not beside another such trade. Large
  trades can also go through a private or protected submission path (not built), which is the
  advice for them. The owner chooses configs (13).

### 5.16 The math crate (`vicinity-curve-math`)

Pure functions of the `Coin` data; the program calls exactly these and writes what they
return, so an off-chain quote equals the on-chain result to the lamport.

```
fee_split(terms, amount) -> Result<FeeSplit { fee, liquidity, liquidity_floor, platform, founder, holders, buyback }>
curve_value(terms, s) -> u64                       // f(s)
tokens_for(terms, q) -> u64
gross_for(terms, net) -> u64                       // Lemma G
quote_buy(terms, state, sol_in) -> BuyQuote { charged, net, tokens_out, split, drip,
                                              partial, graduates, new_state }
quote_sell(terms, state, tokens_in) -> SellQuote { gross, sol_out, split, drip, new_state }
quote_buyback(terms, state, slot) -> Result<Option<BuybackQuote { spent, coins, cap, new_state }>>
                                                   // Ok(None) = the no-op of 4.0 and 7.1
max_quote_in(terms, state) -> u64                 // sol_in that completes the curve exactly
spot_price(terms, state) -> (virtual_sol, virtual_tokens)   // the terms hold x0 and y0
liabilities(state), depth(terms, state), buyback_cap(terms, state)   // 6.5, 7.2
validate_config(params) -> Result<(), ConfigError> // V1 to V11
derive_curve(S, P, R) -> (x0, y0)                  // off-chain helper, 5.9
decode_coin(owner: &[u8; 32], data: &[u8]) -> Result<CoinView, DecodeError>
    // owner == the vicinity_curve id, data.len() == 693, CurveCoin discriminator,
    // layout_version == 1, phase 0 or 1, then the fixed offsets of 3.7
```

All functions return `Result<_, MathError>` instead of panicking (NOTES 3). `State` holds every
field a trade or a buyback writes and the quotes return the complete new state, so the handlers
write it without arithmetic (NOTES 6). The quotes refuse the trades the program refuses
(`TradeTooSmall`, `ZeroAmount`, `ZeroOutput`, `SellExceedsCurve`, in the order of section 4) and
refuse a buy whose liabilities would leave `u64` (NOTES 4, 5); they check the proofs' guarantees
before returning a state and refuse inputs that break a precondition of 5.1 (`InvalidTerms`,
`InvalidState`, mapped to `MathOverflow` by the program; NOTES 8). `validate_config` returns the
first failing rule in table order; `v8_sides` and `v11_sides` expose its margins (NOTES 9).
`derive_curve` is the search of 5.9 made exact (NOTES 11). A JavaScript port in the SDK
(`sdk/curve/math.mjs`) is tested for parity against golden vectors generated by the Rust crate
(G01) and against the program's results after every transaction of the test suites.

---

## 6. Fee booking and every payout and burn path

### 6.1 Money map

```
EVERY USER BUY AND SELL (curve or pool), inside the trade, AUTOMATIC
 buy:  buyer is charged A lamports; fee = floor(A * 2.5%) stays in the Coin; A - fee is priced
 sell: market releases A gross lamports; fee = floor(A * 2.5%) stays in the Coin; seller gets A - fee
   |
   |  all lamports stay in the Coin PDA; the fee is booked into five buckets
   +-- 0.5% liquidity --> Pool phase: into pool_sol in this trade (no coins added)
   |                      Curve phase: liquidity_pending; after graduation each pool trade moves
   |                      at most its own rounded-down liquidity share of it into pool_sol (the drip);
   |                      a coin that never graduates keeps it forever
   +-- 0.7% platform  --> platform_pending --- withdraw_platform_fees (anyone) ---> FEE_RECIPIENT 13qRam...
   +-- 0.5% founder   --> founder_pending  --- claim_founder_fees (founder) -----> founder wallet
   |                                       `-- payout_founder_fees (payout key; opt-in; daily) -> payout wallet
   +-- 0.5% holders   --> holders_pending  --- forward_holders_fees (anyone; + SyncNative) -> city's
   |                                            vicinity_rewards WSOL vault (authority == admin) ->
   |                                            SyncNative + fund_epoch_from_vault (rewards authority,
   |                                            Merkle root) -> claim (each holder)
   +-- 0.3% buyback   --> buyback_pending  --- buyback_burn (anyone; capped; 1 per 150 slots)
                                                buys the coin at the curve or pool price, SPL burn

LAUNCH (founder signs):   0.05 SOL launch fee -> FEE_RECIPIENT in the launch transaction
                          (plus rent, and Metaplex's own 0.01 SOL metadata fee); 9.1 coins burned
GRADUATION (automatic):   inside the buy that takes the last curve coin; no lamport moves
BUYBACK (separate):       no fee; lamports move from the buyback bucket into the reserve
```

### 6.2 Booking inside a trade, and value conservation

Buy, after the checks of 4.11: system transfer of `charged` into the `Coin`; tokens out of the
vault; then `platform_pending += platform` (and `platform_earned`), the same for founder,
holders and buyback; curve: `curve_sol += c`, `liquidity_pending += liquidity`; pool:
`pool_sol += c + liquidity + drip`, `liquidity_pending -= drip`,
`liquidity_added += liquidity + drip`; always `liquidity_earned += liquidity`,
`fees_total += fee`, `buy_volume += charged`, `trade_seq += 1`.

Sell, after the checks of 4.12: tokens into the vault; curve: `curve_sol := f(s')`,
`liquidity_pending += liquidity`; pool: `pool_sol := pool_sol - gross + liquidity + drip`,
`liquidity_pending -= drip`, `liquidity_added += liquidity + drip`; buckets and counters as
for a buy with `sell_volume += gross`; then `pay_out(coin -> user, gross - fee)`.

Conservation, checked after every operation by the reference model and by I9 and I13 in the
tests:
* buy: lamports in = `charged`; liabilities grow by `c + fee = charged` (Lemma G);
* sell: lamports out = `gross - fee`; liabilities change by `-gross + fee`;
* buyback: no lamports move; `buyback_pending -= spent`, reserve `+= spent`;
* graduation: no lamports move; the reserve switches from `curve_sol` to `pool_sol = R`.

### 6.3 Automatic versus separately executed (R5)

| flow | automatic, inside every trade | separately executed (who) | on-chain counters (all in `Coin`) |
|---|---|---|---|
| fee (at most 2.5%) | computed and split into five buckets | - | `fees_total`, `trade_seq`, `buy_volume`, `sell_volume` |
| liquidity 0.5% | Pool: into `pool_sol`. Curve: into `liquidity_pending`, then the drip in later pool trades | nothing; no instruction can move it out | `liquidity_earned`, `liquidity_added`, `liquidity_pending` (all include rounding remainders) |
| platform 0.7% | `platform_pending` | `withdraw_platform_fees` (anyone) to `FEE_RECIPIENT` | `platform_earned`, `platform_withdrawn`, `platform_pending` |
| founder 0.5% | `founder_pending` | `claim_founder_fees` (founder), or `payout_founder_fees` (payout key, opted-in founders only) | `founder_earned`, `founder_claimed`, `founder_paid_out`, `founder_pending`, `payout_seq` |
| holders 0.5% | `holders_pending` | `forward_holders_fees` (anyone) to the rewards vault; then the rewards authority funds a Merkle round when at least 20 holders qualify for 0.01 SOL each; then each holder claims | `holders_earned`, `holders_forwarded`, `holders_pending`; `vicinity_rewards` counters `total_to_holders`, `total_claimed` |
| buyback 0.3% | `buyback_pending` | `buyback_burn` (anyone; Vicinity's keeper runs it; capped; once per 150 slots) | `buyback_earned`, `buyback_spent`, `buyback_pending`, `tokens_burned`, `buyback_count`, `last_buyback_slot`; the mint's supply |
| graduation | in the buy that takes the last curve coin | - | `phase`, `graduated_at`, `graduation_slot`, `Graduated` event |
| launch fee | paid to `FEE_RECIPIENT` in the launch transaction | - | `CoinLaunched.launch_fee` |
| launch burn of R8's 9.1 leftover coins | burned in the launch transaction | - | `dust_burned` |

Website figures: "earned" = `*_earned`; "waiting" = `*_pending`; "paid" = the outflow
counters; "burned by buybacks" = `tokens_burned`; "burned at launch" = `dust_burned`;
"total burned" = `COIN_SUPPLY - mint.supply` (includes coins holders burned themselves);
"supply" = `mint.supply`; "added to the pool" = `liquidity_added`; "set aside for the pool" =
`liquidity_pending`. Every one is exact on chain.

### 6.4 Each outflow path

| path | instruction | who may call | amount | destination (fixed) | blocked by |
|---|---|---|---|---|---|
| seller payout | `sell` | the seller | `gross - fee` | the signer `user` | nothing (only the `halt-all` build) |
| platform | `withdraw_platform_fees` | anyone | all of `platform_pending` | `FEE_RECIPIENT` (constant) | nothing (only `halt-all`) |
| founder claim | `claim_founder_fees` | the founder | all of `founder_pending` | `coin.founder` (signer) | nothing (only `halt-all`) |
| founder payout | `payout_founder_fees` | payout key | all of `founder_pending`, at most daily | `payout_destination`, only with a matching opt-in signed by the current founder | `payouts_paused`; payouts off; `halt-all` |
| holders | `forward_holders_fees` | anyone | all of `holders_pending` | the city's derived `vicinity_rewards` WSOL vault under a Holders-only config whose authority is the admin | a missing or wrong rewards config (money waits); `halt-all` |
| buyback | `buyback_burn` | anyone | `min(buyback_pending, cap)` | none: lamports move into the reserve, coins are burned | rate limit; `buybacks_halted`; `halt-all` |
| liquidity | none | - | - | stays in the pool, or set aside forever if the coin never graduates | - |
| launch fee | `launch` | the founder | `launch_fee_lamports` | `FEE_RECIPIENT` | `launches_paused`; `buys_halted`; the old program's launches open; `halt-all` |

There is no other instruction that moves a lamport out of a `Coin` or a token out of a vault.

### 6.5 Custody: native lamports and the single debit helper

All of a coin's SOL (curve raise or pool reserve, and the five buckets) is held as plain
lamports of its `Coin` account, owned by `vicinity_curve` (M1).

* **Credits in**: only `buy` (system transfer from the buyer). Any other lamports that arrive
  (donations) are surplus that no counter sees and no instruction can move.
* **Liabilities** = `reserve + liquidity_pending + platform_pending + founder_pending +
  holders_pending + buyback_pending`, with `reserve = curve_sol` on the curve and
  `pool_sol` in the pool.
* **Debits out**: one helper, used by `sell`, `withdraw_platform_fees`,
  `forward_holders_fees`, `claim_founder_fees`, `payout_founder_fees`:

```rust
fn pay_out(coin: &AccountInfo, rent_reserve: u64, to: &AccountInfo, amount: u64,
           liabilities_after: u64) -> Result<()> {
    let rent_live = Rent::get()?.minimum_balance(coin.data_len());
    let floor = liabilities_after
        .checked_add(rent_reserve.min(rent_live)).ok_or(CurveError::MathOverflow)?;
    require_keys_neq!(to.key(), coin.key(), CurveError::InvalidAddress);   // NOTES 22
    let left = coin.lamports().checked_sub(amount).ok_or(CurveError::RentFloor)?;
    require!(left >= floor, CurveError::RentFloor);
    **coin.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(CurveError::MathOverflow)?;
    Ok(())
}
```

  `liabilities_after` is computed from the state after the instruction's bookkeeping, so the
  rent part and every remaining obligation can never be paid out. Without donations a `Coin`
  holds exactly `rent_reserve + liabilities` (I9), so by I9 the check never fails in a
  correct program; it is the line an auditor can read in one place. The only CPI that may
  follow it is `emit_cpi!` (rule of 4.0). It refuses a destination equal to the `Coin` (a check
  that can only refuse) and computes both new balances before writing either (NOTES 22).
* **Rent changes**: the floor uses the smaller of the rent stored at launch and the live
  `Rent` sysvar. A rent increase (rent can change, LAUNCHPAD-DESIGN cites SIMD-0437; SIMD-0438
  would reset the rate to 6,960 lamports per byte) therefore never raises the floor above what
  the `Coin` holds, so the program never refuses an exit because of it. The runtime's own
  rent-state rule still applies to the account: under SIMD-0392 (active on mainnet since epoch
  1027) a transaction may not leave an account below the live rent-exempt minimum and below its
  balance before the transaction. So after an increase of `d` lamports in a `Coin`'s minimum,
  a debit that leaves its liabilities below `d` is refused by the runtime
  (`InsufficientFundsForRent`) until someone tops the `Coin` up: the last exits of a nearly empty
  coin, and every debit of a coin whose liabilities are already below `d`. Credits (buys) into
  such a coin are accepted. Anyone can top a `Coin` up (a donation). **The keeper's rule (review
  OPS-2):** after any rent change, for every `Coin`, `need = liabilities + rent_min(693) -
  lamports` (live rent; the SDK's `coinRentTopUp`), and it transfers `need` when positive. The
  trigger is `lamports < liabilities + rent_min`, not `lamports < rent_min`: a coin above the live
  minimum can still be blocked (the runtime never lets it fall below the minimum, so a rule on
  the minimum never fires for it), and a coin topped up only to the minimum stays blocked
  (measured: after a 10% raise, a coin holding 2,000,000 lamports of liabilities above its old
  rent refused its holder's full sell; a coin topped up to the minimum still refused its sell and
  its founder's claim; `need` let every exit through). Lamports donated earlier count. Test X63
  raises the `Rent` sysvar by 10%, and the OPS-2 test runs both cases.
* **Destinations must accept a credit**: the runtime refuses a credit that leaves a
  0-lamport account below the rent-exempt minimum of an empty account (128 x 5,080 = 650,240
  lamports at today's mainnet rate; 890,880 at 6,960). A seller or founder can have 0 lamports
  (a relayed or gasless signer, a router PDA signing through `invoke_signed`, a fresh multisig
  vault): then a sell or claim below that minimum fails and nothing moves (14.3; tests X58).
  `FEE_RECIPIENT` and the payout wallet are funded wallets; the rewards vault is a rent-exempt
  token account. A failed credit reverts the whole instruction; nothing is lost and it can be
  retried.
* **Crediting the WSOL rewards vault**: a direct lamport credit to a token-program-owned
  account (allowed: any program may credit a writable account). `SyncNative` runs as a
  separate top-level instruction after `forward_holders_fees`, never as a CPI inside it
  (4.0, 4.15). Test R02 runs the real instruction in litesvm.

Coins: the vault holds `S - s + P` on the curve and `Y` in the pool, plus donations.
Out-flows: `buy` (to the buyer's token account) and `buyback_burn` (SPL burn); the launch's
`mint_to` and dust burn. In-flows: `sell`. Every mint and token account is
`anchor_spl::token` typed (owner = classic SPL Token), so Token-2022 accounts cannot be
passed.

### 6.6 Accurate labels for the website

* "Trading fee: at most 2.5% of the SOL side of every buy and sell through the Vicinity
  market, before and after graduation, rounded down to the lamport. The coin's own buyback
  pays no fee. Nothing on top from Vicinity. Pools that others may create for this coin do
  not pay it. (Apps such as Axiom or FOMO may add their own fee in their own app.)"
* "Liquidity 0.5%: added to the pool's SOL reserve without adding coins, so it deepens the
  pool and raises the price. No one can withdraw it as liquidity, but like all pool SOL it is
  paid to sellers through trades. Before graduation it is set aside and enters the pool after
  graduation, at most as fast as new liquidity fees arrive. If the coin never graduates, it is
  never used: it stays locked in the coin's account forever and benefits no one. Includes
  rounding remainders of at most 4 lamports per trade, even when the liquidity share is 0."
* "Vicinity 0.7%: set aside in every trade (automatic); withdrawn separately, only to
  Vicinity's wallet 13qRam..."
* "Founder 0.5%: set aside in every trade (automatic); the city founder claims it."
* "Holders 0.5%: set aside in every trade (automatic); sent to the city's rewards vault; paid
  in rounds that Vicinity's rewards authority publishes when at least 20 holders qualify for
  0.01 SOL each; holders claim. Money can wait in the vault until a round qualifies."
* "Buyback and burn 0.3%: set aside in every trade (automatic); spent and burned separately by
  a public crank (Vicinity runs it), at most once a minute, in steps of at most 0.1% of the
  market's SOL. Waiting: N SOL. Burned by buybacks: N coins. Total burned: N coins (includes
  coins holders burned themselves)."
* "A buy followed by a sell costs about 4.9%."
* "Transfers between wallets: no Vicinity fee; only Solana's network fee, plus one-time
  account rent for a new holder."
* Buy panel: "Your first buy of this coin creates your token account: one-time rent of about
  0.002 SOL" (20 times a 0.0001 SOL minimum buy).
* Trust: "Within the program no admin can move money. The same Squads multisig (2 of 3) can
  upgrade the program after a 48-hour delay and publishes the holder reward rounds. A separate
  guardian can stop buys at once but can never stop anyone selling or claiming."

---

## 7. Buyback and burn (R7)

### 7.1 Mechanics

```
buyback_burn():                                                   // permissionless, no arguments
  require !launchpad.buybacks_halted                              // BuybacksHalted
  if buyback_pending == 0 or slot < last_buyback_slot + 150: return Ok     // no-op
  depth = Curve ? x0 + curve_sol : pool_sol                       // the market's SOL depth now
  cap   = floor(depth * t / (25 * D))                             // 0.1% of depth at t = 250
  b     = min(buyback_pending, cap)
  Curve: s' = min(tokens_for(curve_sol + b), S - 1)               // never graduates
         spent = f(s') - curve_sol;  coins = s' - s
         if spent == 0 or coins == 0: return Ok
         tokens_sold = s';  curve_sol = f(s')                     // burned coins count as sold
  Pool:  coins = floor(pool_tokens * b / (pool_sol + b));  spent = b
         if coins == 0: return Ok
         pool_sol += b;  pool_tokens -= coins
  SPL burn `coins` from the vault (authority: the Coin PDA)
  buyback_pending -= spent; buyback_spent += spent; tokens_burned += coins
  buyback_count += 1; last_buyback_slot = slot; emit BuybackBurned
```

* **Accrual** (automatic): 0.3% of every trade's SOL leg into `buyback_pending`.
* **Execution** (separate): anyone may call; Vicinity's keeper does, every interval. The SOL
  never leaves the `Coin`: it moves from the buyback bucket into the reserve, and the coins a
  buyer would get for it leave the reserve and are burned. No external swap, no account
  outside the coin, no slippage argument (an untrusted caller must not choose one).
* **No fee on the buyback** (an exception to R2's "every buy" that the owner signs off, O7).
  It is the coin's own money buying from the coin's own market; charging 2.5% again would
  pay 0.7% of burn money to the platform and 0.5% to the founder (fee on fee).
* `spent <= b <= buyback_pending` (Lemma C1 on the curve; `spent = b` in the pool).
* **Curve phase**: buys from the curve at the curve price; capped at `S - 1` coins sold, so a
  buyback can never graduate the coin. Burned coins count as sold, so graduation still happens
  at exactly `S` and 85 SOL. The SOL a buyback adds stays in the reserve (it backs coins that
  no longer exist). Graduation itself always happens inside a user buy; its timing is not
  protected (anyone can bundle a buyback that stops at `S - 1` with a 0.0001 SOL buy that
  completes the curve) and needs no protection (V7, M8).
* **No stuck bucket**: on the curve `depth >= x0`, and in the pool `depth = X >= R*P/10^15`
  (the pool's `X*Y` starts at `R*P` and never decreases, and `Y <= 10^15`); V4 requires both
  bounds to give a cap of at least 1 lamport. On the default config the smallest possible
  cap is 30,000,853 lamports on the curve and 17,586,500 lamports in the pool (depth at
  least 17.5865 SOL). A run is a no-op only when the bucket is empty, the interval has not
  passed, or the curve holds `f(S - 1)` (the next user buy graduates the coin, I22).

### 7.2 Caps, rate limit and backlog

* Per run: at most `depth * t / (25D)` = 0.1% of the market's SOL depth at 2.5%, measured at
  execution (after anything earlier in the same block). At launch 0.030 SOL; at the end of
  the curve 0.115 SOL; at pool open 0.085 SOL.
* At most one run per coin per 150 slots (about 60 s); the first at least 150 slots after the
  launch slot. A transaction or bundle can never contain two runs for one coin.
* Throughput: at pool open about 0.085 SOL per minute (about 122 SOL per day). The bucket
  accrues 0.3% of volume, so the cap binds above about 28 SOL of volume per minute at pool
  open (40,800 SOL per day) and 10 SOL per minute at the start of the curve (14,400 SOL per
  day). Above that, or while the keeper is down, a **backlog** builds. A backlog is public
  and is spent on a predictable schedule, which is what Theorem M_K prices (7.3). Examples:
  the break-even backlog of 7.3 is 0.77 SOL at the start of the curve and 1.74 SOL at pool
  open; a burst of about 266 SOL (curve start) or 607 SOL (pool open) of volume within one
  interval creates it, and so does sustained volume above the binding rate (20 SOL per minute
  at the start of the curve adds 0.03 SOL of backlog per minute).
* Operations (14.1): the keeper runs every interval for every coin with a nonzero bucket; it
  alerts when `buyback_pending` exceeds two caps (0.2% of depth at t = 250: the keeper has fallen
  two runs behind; review KR-1, where a hold with another trade inside profited from 3 caps); the
  coin page shows the backlog and the depth, so the market prices the coming buys in, and the
  clients' sandwich threshold counts every run the backlog pays for (5.15).
* A halt of buybacks (8.3) is the one time the keeper cannot run, and sells keep filling the
  bucket: a pool mostly sold during a long halt ends with a backlog many times `u*` (review
  LL-1). The program allows it only while buys are halted and never reopens buys before
  buybacks; the keeper drains every coin before the admin reopens buys.

### 7.3 MEV analysis

Notation: reserves `(X, Y)` before the attack (virtual on the curve, real in the pool); fee
fraction `f = t/D` (0.025); buyback step `s = t/(C*D)` (0.001); injected liquidity per pool
trade at most `2*l` of its SOL leg with `l = b_L/D` (0.005: the trade's own share plus at
most the same again as drip); on the curve nothing is injected; `c = m/D` with
`m = max(b_F, b_H)` the share an attacker may be credited back on each of his own legs
(0.005: a founder gets his share of his own trades). The platform's key is credited `b_P`
(0.007 under config #0) and is outside these bounds; see the end of this section (review HR-1).

**Theorem M (canonical sandwich: attacker buy, one buyback, attacker sell).** For every
attacker size `a` and every state:

```
attacker's SOL back / SOL in  <=  (1 + s)^2 (1 - f)(1 - f + 2l)      (pool)
                              <=  (1 + s)^2 (1 - f)^2                 (curve)
```

plus at most a few lamports of integer rounding.

*Proof.* (1) The attacker pays `a`; net `n <= a(1 - f)` buys `c_a <= Y n/(X + n)` coins; the
pool then gains `delta <= 2la` (zero on the curve): `X1 = X + n + delta`, `Y1 = Y - c_a`.
(2) The buyback spends `b <= s X1`, so `u = X2/X1 <= 1 + s`, and buys without fee, so
`X2 Y2 >= X1 Y1`. (3) The attacker sells `c_a`: `gross <= X2 c_a/(Y2 + c_a) <=
X2^2 c_a/(X1 Y1 + X2 c_a) <= u^2 X1 c_a/(Y1 + c_a)`, and `X1 c_a/(Y1 + c_a) =
(X + n + delta) c_a / Y <= n (1 + delta/(X + n)) <= n + delta <= a(1 - f + 2l)`. (4) The
attacker receives `(1 - f) gross`. QED.

At the default: pool `1.002001 x 0.975 x 0.985 = 0.96230` (**a loss of at least 3.77%**);
curve `1.002001 x 0.950625 = 0.95253` (**at least 4.75%**). An attacker credited `c` on both
legs gets at most `(1 + s)^2 (1 - f + 2l)(1 - f + c) + c`: `0.97223` at the default for a
founder (**at least 2.78%**).

**Split legs (conservative bound, a heuristic with a tested margin).** If the attacker splits
his buy or his sell into several trades, each leg's injected liquidity can raise the price
for his later legs. The bound assumes that each injected lamport returns at most one lamport
to him, so every leg costs him at least `f - 2l` instead of `f`; this is not proven for every
split, and P06 tests random splits against it. Replacing `(1 - f)` by `(1 - f + 2l)` on both
legs and crediting `c` on both legs:

```
attacker's result / a  <=  (1 + s)^2 (1 - f + 2l)(1 - f + 2l + c) + c
                        =  1.002001 x 0.985 x 0.990 + 0.005  =  0.98210   (founder, default)
without credit:            (1 + s)^2 (1 - f + 2l)^2  =  1.002001 x 0.970225  =  0.97217
```

**a loss of at least 2.78% for anyone, and at least 1.79% for a founder, for any split, any
size, any state.** Config rule V8 makes every future config with a buyback satisfy the
credited bound at 0.99 or less (a loss of at least 1%); V2 caps the founder share at 1.0%.
Revision 1 left the credit out, so V8 then accepted configs such as (50, 0, 170, 0, 30) in
which a founder could profit (+0.40% measured); both V2 and V8 now refuse them.

**Theorem M_K (holding through several runs).** An attacker who buys, lets `K` buyback runs
execute with no other trade, and then sells, gets at most

```
(1 + B/X1)^2 (1 - f)(1 - f + 2l)  <=  (1 + s)^(2K) (1 - f)(1 - f + 2l)
```

of his money back (curve: `l = 0`), where `B` is the total the buybacks spent between his
legs and `X1` the depth after his buy (`1 + B/X1 <= (1 + s)^K`, with equality when every run
spends its full cap); credited `c` on both legs, at most
`(1 + B/X1)^2 (1 - f + 2l)(1 - f + c) + c`.
*Proof.* As Theorem M, with step (2) repeated: run `k` spends `b_k <= s X_k` without fee, so
`X_(k+1) <= (1 + s) X_k`, the product `X*Y` does not decrease, and after `K` runs
`u = X_(K+1)/X1 <= (1 + s)^K` and `u = (X1 + B)/X1`. Step (3) holds for any `X2 >= X1` with
`X2 Y2 >= X1 Y1`. QED.

Consequences, all independent of the step size:
* **Break-even backlog.** The hold can profit only if `B/X1` exceeds
  `u* = ((1 - f)(1 - f + 2l))^(-1/2) - 1`: **2.564% of depth on the curve, 2.042% in the
  pool**; for a founder credited his share (`(1 + u)^2 (1 - f + 2l)(1 - f + c) + c = 1`),
  2.046% on the curve and 1.527% in the pool. A
  larger step spends the same backlog in fewer runs but does not change `u*`.
* **Horizon.** With the 0.1% step, profit needs at least
  `K* = ceil(ln(1/((1 - f)(1 - f + 2l))) / (2 ln(1 + s)))` runs: **26 on the curve and 21 in
  the pool** (about 21 to 26 minutes) for any trader, and 21 and 16 for a founder. V11 keeps
  `K* >= 20` (any trader) and `>= 15` (credited attacker) for every future config. With
  revision 1's 0.5% step, `K*` was 6 (5 for a founder).
* **What it takes.** A backlog of `u* x depth` (0.77 SOL at the start of the curve, 1.74 SOL
  at pool open; 7.2), a hold of `K*` minutes during which every other trade and every other
  attacker can move the price, and an exit after the backlog is spent. Positive expected value
  remains for a trader who sees a large backlog and can wait: this is a stated residual risk
  that needs the owner's sign-off (O25). Mitigations: the keeper spends every interval, alerts
  above two caps (0.2% of depth), and the coin page shows the backlog so the market prices it in
  (7.2, 14.1).
* **With another trade inside the hold (review KR-1).** The figures above assume no other
  trade between the attacker's legs. An honest trade that lands inside the hold adds its price
  impact to the runs': with one buy at the clients' round-4 threshold (one run allowed), the
  founder profited after 8 runs of a backlog of 0.84% of depth (+297,718 lamports on chain;
  +8,400,788 after 10 runs) and an outsider after 15 runs of 1.5% (+7,901,169); the model's least
  `K` with such a buy inside is 13 for an outsider, 8 for the founder, 6 for the platform's key
  and 3 for a founder holding the float (backlog about `K` caps), against 26, 21, 19 and 16 with
  no victim, at every slippage from 1% to 5%. The victim's loss stays capped by his own
  slippage. The clients now count every run the backlog pays for in the sandwich threshold
  (5.15), so an SDK trade inside such a hold leaves every class at a loss; a trade from another
  client at a large slippage does not, which is O25's residual risk with these lower figures.
* **Creating a backlog oneself** costs at least `(b_P + b_L)/b_B = 4` lamports of platform and
  liquidity fees per lamport of backlog (the platform share never comes back; the liquidity
  share only partly, through the pool), even for a founder credited his share; the
  hold-through gain is at most a few percent of the attacker's position and shrinks as his own
  buy deepens the market.

**Measured on the reference model** (Appendix A; buyback bucket unlimited so the cap always
binds; states: curve at 0, 10, 40 and 80 SOL raised, pool just after graduation and with 10 or
200 SOL pending liquidity; front-runs from 0.001 to 7,372 SOL):

| scenario | best attacker result |
|---|---|
| canonical, curve states | -4.75% (smallest sizes) |
| canonical, pool states | -3.88% (7,372 SOL front-run with 200 SOL pending liquidity) |
| 2,100 random multi-leg sandwiches (1 to 6 buy legs, 1 to 6 sell legs) | -3.30% |
| the same, attacker credited the founder share of his legs | canonical -2.88%, multi-leg -2.30% |
| the same, attacker credited the founder and holders shares | canonical -1.89%, multi-leg -1.30% |
| hold through `K` runs, unlimited backlog, no other trades (0.1 SOL and 10 SOL attackers; curve at 0 and 40 SOL, pool open) | loss up to `K = 25`; first profit at `K = 26` (0.1 SOL) to 29 (10 SOL); +0.93% at `K = 30` |
| the same, founder credited | first profit at `K = 21` |
| backlog sweep from 0.5% to 10% of depth, held until the backlog is spent | loss at a backlog of 2.5% of depth or less in all three states; first profit at 2.6% (0.1 SOL attacker, 26 runs, +0.05% to +0.06%) |

**Where single-run profit would start** (same scan, cap varied, everything else default):

| step (bps of depth) | 10 (default) | 50 (revision 1) | 100 | 150 | 200 | 250 | 260 | 300 |
|---|---|---|---|---|---|---|---|---|
| best result, curve | -4.75% | -3.98% | -3.03% | -2.06% | -1.10% | -0.12% | +0.07% | +0.85% |

The break-even step for small attackers is `f/(1 - f) = 2.56%`; the default sits 25 times
below it.

**Other MEV around the buyback.**
* Back-running: only helps holders who already hold (they sell into a price at most
  `(1 + s)^2 - 1 = 0.2%` higher per run and pay up to 2.5% to do it).
* Holding across several runs: Theorem M_K above (not dismissed as market risk).
* Calling the crank at chosen moments: the bounds hold in every state; one run per 150
  slots per coin.
* Timing griefing (calling as often as allowed so each run is small): harmless; smaller runs
  are even less sandwichable; the whole bucket is spent either way.
* An outside pool created by a third party: a run moves our price by at most about 0.2%, and
  a backlog by at most `(1 + B/X)^2 - 1`; arbitrage links the two prices only past 2.5% plus
  that pool's own fee, so buybacks and liquidity injections mostly do not carry over to such a
  pool (T74).

**The platform's key (review HR-1).** Every bound above credits an attacker at most
`m = max(b_F, b_H)`. Whoever holds `FEE_RECIPIENT` (the owner's hot wallet, compiled into the
binary, or a thief of it) is credited `b_P` of his own legs through the permissionless
`withdraw_platform_fees`, and he can trade from any wallet. Measured on chain by the review and
its verifier (real program, checker on):
* config #0, `FEE_RECIPIENT` alone (credited 70 of 250 bps): inside O25's founder envelope; it
  lost at every backlog up to 1.82% of depth and every hold up to 18 runs (positions of 0.1 to
  40 SOL), first profit at about 1.85% to 1.9% and 19 runs;
* config #0 with a founder seat held by the same owner (credited 50 + 70 = 120 bps): +14,186
  lamports from a 1.338% backlog after 14 runs, below V11's 15-run promise;
* O1's named alternative (0, 120, 50, 50, 30), `FEE_RECIPIENT` alone: +18,083 lamports from a
  1.343% backlog after 14 runs (the founder from the same state: -1,382,754);
* (0, 120, 0, 1, 1), which passes V1 to V11: `FEE_RECIPIENT`'s canonical single-run sandwich of a
  5 SOL position returns +0.05%, where V8 promises any credited attacker at least -1% (a plain
  trader: -2.34%).
The defence is the **operating rule of 8.4**: `FEE_RECIPIENT`, and every wallet of the owner who
controls it, never holds or trades city coins and never takes a founder seat; the keeper alerts
when `FEE_RECIPIENT` holds any city coin (visible on chain). The admin chooses the configs, so a
config whose `b_P` exceeds `m` (O1's alternative) is an owner decision with this envelope, and
counting `b_P` in V8 and V11 (with a platform horizon of its own) is O29. Clients count the
platform's credit in the sandwich threshold of 5.15.

### 7.4 Ordinary sandwiches and wash trading

User sandwiches are the usual AMM risk, bounded by the user's slippage limits (5.15). Above a
coin's sandwich threshold (5.15: the SDK's `sandwichThreshold`, 1.3% of the market's SOL depth under config #0,
0.39 SOL on a fresh coin) any slippage the trader allows is taken almost entirely, so
the clients allow at most 0.3% there, for buys and sells (reviews MATH3-1, R4-DIFF-5, SDK4-6);
below it they allow less as the trade nears the threshold, since trades sharing a block are
sandwiched together (review MV-1), and the threshold falls as the buyback backlog grows (KR-1). Wash
trading pays nobody it does not cost: a trader gets back at most his own shares of each leg,
so the founder's cost per leg is `t - b_F`, a holder of the float pays at least `t - b_H`, and
a founder who also holds the float (in wallets other than his seat, which the snapshot leaves
out; the 20-holder gate is easy to meet with his own wallets) pays at least `t - b_F - b_H`.
V2b keeps all three at 0.01% or more in every config (review ECON-1: without a buyback share
V8 and V11 do not run, and before V2b a config whose founder share was the whole fee, such as
(0, 0, 100, 0, 0), let the founder trade his own coin for free and sandwich buyers up to their
slippage; review R3-DIFF-1: until V2b bounded the sum, (0, 0, 50, 50, 0), (0, 0, 100, 1, 0)
and (0, 0, 100, 150, 0) let a founder holding the float wash-trade for exactly 0 net on chain,
his holders' share coming back through the rewards rounds). Under config #0 the founder pays
2.0% per leg net, 1.5% if he also holds the whole float (measured: a 10 SOL wash round trip
costs him 3.95% before the holders' share). Vicinity's own wallet pays `t - b_P` per leg, which is 0 in a config
whose whole fee goes to the platform (X44's 0.01% config): V2b does not cover the platform,
whose wallet is the owner's, like the choice of the config itself (13).

### 7.5 The liquidity drip is not farmable (V10)

**Claim.** Under V10 (`b_L == 0` or `b_L < b_P`), round trips after graduation cannot release
other traders' set-aside liquidity at a profit, even for an attacker who holds every
circulating coin and is credited back the founder, holders and buyback shares of everything he
pays.
*Argument.* Per leg of size `A`, the drip moves at most `floor(A*b_L/D)` of other traders'
`liquidity_pending` into the pool, and even a holder of the whole float recovers strictly less
than every injected lamport on exit (`C/(Y + C) < 1`, 5.8). The leg costs him at least the
platform share `floor(A*b_P/D)`, which no trader gets back, plus his own liquidity share, of
which he also recovers less than all. With `b_L < b_P` the cost of every leg exceeds what the
drip can return. The rounding remainder never drips, so a dust sell drips at most
`floor(A*b_L/D)` (nothing below 200 lamports at the default), and buys have a 0.0001 SOL
minimum. Revision 1 relied on `b_P > b_L` holding for the default only and computed the drip
from the liquidity share including its remainder (up to `floor + 4`), so a 161-lamport sell
dripped 4 lamports against a platform share of 1.

**Measured** (reference model; attacker holds the float, credited the founder, holders and
buyback shares; 0, 4 or 20 SOL extra pending liquidity; round trips of 0.1 to 50 SOL; result
compared with selling at once):

| config (L, P, F, H, B) | V10 | best result |
|---|---|---|
| (50, 70, 50, 50, 30) default | passes | -0.247 SOL |
| (50, 51, 50, 50, 30), the edge `b_P = b_L + 1` | passes | -0.133 SOL |
| (50, 50, 50, 50, 30), just past the edge | refused | -0.127 SOL (still a loss: V10 keeps a margin) |
| (100, 50, 50, 50, 0) | refused | +2.17 SOL |
| (250, 0, 0, 0, 0) | refused | +13.74 SOL |
| 25 random configs passing V1 to V11 | pass | best -0.021 SOL |

---

## 8. Admin powers and upgrade authority (R10)

### 8.1 Every key and every power

| key | can | cannot |
|---|---|---|
| **Squads vault `AB5qB1iA...`** (multisig `6v8hwKYS...`, 2 of 3), mainnet, in **all** of its roles: `vicinity_curve` admin, upgrade authority and program-metadata (IDL) authority; `vicinity_rewards` registry admin, every city's rewards authority and upgrade authority; `vicinity_launchpad` admin and upgrade authority (the old program's admin seat is enforced: approvals and launches here require it to be this program's admin, 8.5) | **As admin**: `approve_launch`, `revoke_approval`, `add_launch_config` (inside V1 to V11), `set_launch_config_enabled`, `set_pause` (any flag either way), `set_payout_config`, `set_guardian`, `propose_admin`. **As upgrade authority**: replace `vicinity_curve` (including the pre-audited `halt-all` build) after the time lock, and with a new binary take every coin's reserves and buckets. **As rewards registry admin**: choose each city's rewards authority at `init_city` (`vicinity_curve` accepts only configs whose authority is the admin, 4.15). **As each city's rewards authority**: publish the Merkle roots that decide who receives the holders' money in the rewards vault, itself included; pause claims; cancel epochs. **As `vicinity_rewards` upgrade authority**: replace that program, and with it take every forwarded lamport | Within `vicinity_curve`, without an upgrade: move any lamport or token; change a live coin's split, curve, founder or state; block sells, claims, forwards or withdrawals; redirect platform fees; change the compiled program ids; mint; freeze; create a second coin for a city or a ticker. In `vicinity_rewards`: there is no withdraw instruction; a published root is write-once |
| **guardian** (a separate Squads multisig without a time lock, suggested 1 of 3 of the same members; never on the website server or the keeper; never `FEE_RECIPIENT`, the payout key or the payout wallet, which the program refuses, 4.4, 4.5; never the admin or the proposed admin, which the program refuses, 4.1, 4.2, 4.4 (review R5-CONS-1; that the guardian multisig has no time lock of its own is confirmed by hand, 8.4); never a coin's founder, which the program refuses at every approval, launch and founder transfer, 4.8, 4.10, 4.17) | `set_pause` with `launches`, `buys` and/or `buybacks` set to true only, buybacks only while buys are halted: stops new launches and buys at once, and buybacks with them when they are in question | clear any flag; block sells, claims, forwards, withdrawals or payouts; touch money; change any setting |
| **payout key** (off by default; never on the website server; never a coin's founder, refused as for the guardian) | `payout_founder_fees` for opted-in founders, to the fixed payout wallet, once a day per coin; pause payouts | resume payouts; pay anywhere else; touch any other bucket |
| **founder** (per coin; the admin chooses it at approval and may choose itself; never `FEE_RECIPIENT`, the guardian or the payout key, 4.8, 4.10, 4.17) | claim, opt in or out of payouts, hand over the seat to a co-signing key that is none of those three | touch any other bucket or coin |
| **anyone** | trade; `buyback_burn`; `withdraw_platform_fees` (pays only `FEE_RECIPIENT`); `forward_holders_fees` (pays only the checked vault); `SyncNative` on a WSOL account; revoke an expired approval | everything else |
| **website and keeper** | build unsigned transactions; the keeper's hot key signs permissionless cranks as fee payer only | approve launches, halt, or move funds: the website holds no admin, guardian, payout or upgrade key; admins create Squads proposals from their own wallets |
| **`FEE_RECIPIENT`** | receive; trade and buy coins like any wallet (the program cannot stop a key from spending its own SOL; I21). Since it is credited `b_P` of every leg, its holder is outside the MEV bounds of 7.3: the operating rule of 8.4 keeps it, and the owner's other wallets, out of city coins and founder seats (review HR-1) | hold any seat in the program: it refuses `FEE_RECIPIENT` as admin, proposed admin, guardian, payout key or payout wallet (4.1 to 4.5), as a coin's founder (4.8, 4.10, 4.17), and as the upgrade authority at `init_launchpad` (4.1); later moves of the upgrade authority happen outside the program, so that part is a deploy precondition (8.4). Its only signatures in the program are a trader's |

Worst cases:
* **Two of the three Squads keys stolen (or two members acting together).** As admin: approve
  itself as founder of cities with no coin yet and launch them (taken forever, as today; R1),
  add a config inside the caps, pause launches, payouts or buys, set a payout key (which still
  needs each founder's opt-in), replace the guardian. As upgrade authority: **everything**: all
  reserves and buckets of every coin, but only after the 48-hour time lock, during which the
  pending upgrade is visible, holders can sell and the guardian can halt buys so newcomers do
  not buy into it. As rewards authority: **every lamport forwarded to the rewards vaults**,
  through a self-serving Merkle root, also only after the time lock (a root is a proposal of
  the same multisig) and visible before it executes. As `vicinity_rewards` upgrade authority:
  every lamport in the rewards vaults, after the time lock.
* **The old program's admin**: the same Squads vault (8.4), which the program enforces at every
  approval and launch (8.5). A different or pending old admin stops all approvals and launches
  here (fail closed); reopening the old program to launch a second coin for a city therefore
  needs the same two keys and the time lock as everything else (review GOV-1: on mainnet that
  seat was the owner's wallet, which is also `FEE_RECIPIENT`).
* **Stolen guardian**: halts buys, buybacks and launches until the admin replaces the guardian
  and clears the flags (after the time lock); sells, claims, forwards and withdrawals never
  stop. If it halted buybacks too and backlogs built up, the admin resumes buybacks first and
  buys only after the keeper has spent them (8.3; the program never lets buys reopen before
  buybacks). The guardian can also make an admin proposal fail by setting a flag it did not
  expect (a `set_pause` that reopens buys with `buybacks` unset fails once buybacks are halted);
  the recovery proposal of 4.4 (`set_guardian` with `set_pause(buybacks = false)`, buys left
  halted) cannot be made to fail, and buys reopen in a later proposal (reviews R4-DIFF-4,
  OPS-3).
* **Stolen payout key**: only opted-in founders' share, only to the agreed wallet, at most
  daily; it can pause payouts but not resume them.
* **Stolen founder key**: that coin's `founder_pending` only.

Mitigations for the reward-root path: the snapshot file and its `snapshot_hash` are published
before the root proposal is created; a second party (not the one who computed it) recomputes
the root from the published snapshot before any member signs; members sign only roots that
match. Within `vicinity_curve` the admin cannot move money; the same multisig can upgrade the
program and publishes the holder reward roots, and the website says exactly that (6.6).

### 8.2 Two-step admin

`propose_admin` then `accept_admin` signed by the new key (a Squads vault signs through a
proposal). Zero cancels. The payout key and wallet must stay separate from the admin (and the
guardian) through the hand-over, and the new admin is never `FEE_RECIPIENT`. Each city's rewards
authority, the old `vicinity_launchpad`'s admin and `vicinity_rewards`' registry admin must follow
the admin (4.2): until the rewards authority follows, forwards wait in `holders_pending`; until the
old admin follows, approvals and launches fail with `LegacyAdminMismatch`; until the registry admin
follows, with `RewardsRegistryAdminMismatch` (review OPS-1). Under the 48-hour time lock the
hand-over needs no gap (review R5-REG-1): the old vault's proposal holds the three
`propose_admin` calls, and the new vault creates and approves its proposal of the three
`accept_admin` calls (and each city's `accept_authority`) before the old one executes; the time
lock counts from approval, so both clear it together and the new vault executes its proposal
right after. The program reads each seat at the instruction, so the accepts and an
`approve_launch` may even share one transaction; approvals still queued under the old vault fail
with `Unauthorized` and are proposed again. The checker reads the seats as they stood at each
call (I19).

### 8.3 Emergency brake: the guardian halt and the halt-all build

* **Nothing can block exits.** No key can stop sells, founder claims, forwards or
  withdrawals. A key that can stop exits is a lever for theft or coercion; a stolen key of
  that kind could freeze every coin for at least the length of the time lock.
* **Guardian halt (fast, on chain).** The guardian (or the admin) sets
  `Launchpad.buys_halted`; `buy` and `launch` then fail with `BuysHalted`. It may also set
  `buybacks_halted`, only while buys are halted (`BuybackHaltWithoutBuyHalt` otherwise); then
  `buyback_burn` fails with `BuybacksHalted`. The guardian can only set flags; only the admin
  clears them. A flag set late in a time lock can make an admin `set_pause` written for the
  earlier flags fail (`BuybackHaltWithoutBuyHalt`), so recovery proposals are written as in
  4.4: the guardian's replacement with `buybacks = false` and buys left halted, then buys
  (reviews R4-DIFF-4, OPS-3). It is the brake for a bug in the buy path or the curve math, a newly found MEV
  route, or a hostile upgrade waiting out its time lock (newcomers stop buying in). The
  guardian halts buybacks only when the buybacks themselves are in question (a curve-math bug,
  a buyback MEV route); for a hostile upgrade or a buy-path bug it halts buys alone, and the
  keeper keeps spending every bucket while sellers exit.
* **Clearing a halt of buybacks: buybacks first, then buys (review LL-1).** While buybacks
  are halted, every sell still books its share into `buyback_pending` and no run can spend it.
  A coin whose pool is mostly sold during a long halt ends with a backlog many times `u*`
  (the review: 14.9% of depth after 95% of a 970 SOL pool was sold), and whoever buys first
  once buys reopen takes a large part of it as the runs execute (Theorem M_K; +1.24 SOL on
  20 SOL in the review). So `set_pause` never stores buybacks halted with buys open, and the
  admin's recovery is two proposals: the first resumes buybacks while buys stay halted; the
  keeper then runs every coin until its backlog is at most one cap (nobody can buy ahead of
  those runs), and the coin page shows each backlog and depth; the second resumes buys after
  the backlog figures are published. Measured (LL-1 test): the drained coin's first buyer
  after the clear loses 0.237 SOL on 5 SOL; its twin, left undrained, would have paid him
  0.094 SOL. Clearing both in one proposal stays possible when the backlogs are small. The
  sellers' shortfall during the halt itself (no support for their own 0.3%) is the cost of
  halting buybacks, and is why the guardian halts them only when needed. Cost: `buy`, `sell` and `buyback_burn` take the
  `Launchpad` as a fixed read-only account (10 accounts in the trade lists; `sell` checks its
  address only), and `buy` reads one bool.
* **halt-all build (slow, by upgrade).** Cargo feature `halt-all` makes every instruction
  that moves lamports or tokens out of a `Coin` or its vault fail with `TradingHalted`:
  `sell`, `withdraw_platform_fees`, `forward_holders_fees`, `claim_founder_fees`,
  `payout_founder_fees`, `buyback_burn`, `buy` and `launch`. It is the full freeze for an
  accounting bug (an over-credited bucket would otherwise be paid out by strangers through
  the permissionless outflows, out of SOL that backs the reserve). It is a few `#[cfg]` lines
  at the top of eight handlers, in the audit scope, built verifiably, with its buffer uploaded
  in advance under the Squads vault as buffer authority. Under the time lock it takes effect
  48 hours after the proposal, which is still sooner than writing, auditing and deploying a
  fix. **Its buffer is rebuilt from the same commit after every normal upgrade**; deploying an
  old buffer would roll back the fixes (H03).
* Revision 1 also had a `halt-buys` build; the guardian flag does the same immediately, so
  the build is gone.
* A mathematical exploit can still drain in the first block, before anyone signs; the audit,
  the proofs and the tests are the defence against that.

### 8.4 Upgrade policy

* **Keys**: upgrade authority and admin are the Squads vault (R10); the guardian is the
  separate guardian multisig.
* **No IDL account.** Anchor 0.31 compiles IDL instructions into every program unless the
  `no-idl` feature is set, and `IdlCreateAccount` accepts any signer and makes it the IDL
  authority (anchor-syn 0.31.2 `codegen/program/idl.rs`, `__idl_create_account`): a bot
  watching deploys could take the IDL in the first slot the program can be invoked and publish
  a misleading IDL forever. Release builds therefore set `no-idl` (3.1): the binary has no IDL
  instructions (the IDL tag returns Anchor error 1000 `IdlInstructionStub`, test X65) and
  nobody can create the legacy IDL account. The IDL JSON is generated from the source with
  Anchor's `idl-build` feature, committed at `sdk/idl/vicinity_curve.json` and diffed by CI
  against the build (NOTES 24); it is published with the verified build, in the repository, on
  the website and through the Solana Program Metadata program, whose
  canonical entry only the program's upgrade authority can write (a Squads proposal, made
  before the first coin launches so the time lock does not delay it).
* Verified builds (`solana-verify` / `anchor build --verifiable`) with the hash published
  before each deploy; the outside audit before mainnet; toolchain and crate versions and the
  compiled program ids recorded (C03).
* **Time lock** (O11): none while deploying, initialising, publishing the program metadata,
  adding config #0 and approving the first cities; a **48-hour Squads time lock from the first
  mainnet coin launch**, so holders can exit before any change takes effect. **A Squads v4 time
  lock is a property of the multisig (`6v8hwKYS...`), so it applies to every proposal of the
  vault in every role, including the existing programs**: from then on every
  `vicinity_launchpad` admin action and upgrade, every `vicinity_rewards` action the vault
  signs (`init_city` for each new coin, every `fund_epoch_from_vault` round, pauses and
  cancels, authority moves, registry admin actions) and every `vicinity_rewards` upgrade
  waits 48 hours, as do `approve_launch`, `add_launch_config`, `set_launch_config_enabled`,
  `set_pause` by the admin and `set_guardian`. The existing programs' code, state and users do
  not change; only how fast the owner can act on them. The guardian is the fast path for the
  one action that must be fast. Making the program immutable after a long quiet period is a
  later option (bugs could then no longer be fixed).
* **Preconditions before the first coin launches** (the deploy checklist,
  `scripts/vcurve/preflight.mjs`, reads each from the chain and refuses to report ready
  otherwise; reviews OPS-1, OPS-4): `vicinity_rewards` registry admin (with no transfer pending;
  `approve_launch` and `launch` also refuse otherwise, `RewardsRegistryAdminMismatch`, review
  OPS-1) and upgrade authority are the Squads vault;
  `vicinity_launchpad`'s admin is the Squads vault with no pending admin (on mainnet it is the
  owner's wallet `13qRam...`, which is also `FEE_RECIPIENT`: `propose_admin` from that wallet,
  `accept_admin` through the Squads app; `approve_launch` and `launch` refuse until then, 8.5),
  its upgrade authority is the Squads vault (it is, `release/mainnet-2026-10-10/BUILD.md`) or
  none, once the owner makes it immutable as 8.5 recommends (the checklist accepts that with a
  warning; review R5-DIFF-3), its launches are paused and its configs disabled (8.5); the
  guardian is set, is not the admin, the vault or the proposed admin (the program refuses the
  admin and the proposed admin, 4.4; review R5-CONS-1) and is neither the payout key nor the
  payout wallet, and it is a separate multisig without a time lock of its own (confirmed by hand:
  nothing on chain shows it); the program metadata (IDL) is published; config #0 is added (a
  warning names any field that differs from 5.9's); the time lock is set (unless the owner chose
  O11's alternative). **Afterwards, as an operating rule** (review
  R2-DIFF-1, SPEC-1): the upgrade authority is never moved to `FEE_RECIPIENT` (the program
  checks it only at `init_launchpad`), and `set_guardian` and `set_payout_config` never name a
  key that already holds a coin's founder seat (the program refuses the guardian and the payout
  key as founders at every approval, launch and founder transfer, but cannot enumerate the
  coins when those settings change; before the proposal is signed, the deploy checklist with
  `--proposed-guardian`, `--proposed-payout-authority` or `--proposed-payout-destination` compares
  the new key with every `Coin.founder` and every pending `Approval.founder`, and with the keys the
  program keeps the role apart from; reviews R5-DIFF-2, R5-CONS-2). **And** (review HR-1): `FEE_RECIPIENT`, and
  every wallet of the owner who controls it, never holds or trades city coins and never takes
  a founder seat (the admin may approve itself as a founder, 8.1; the owner does not). The
  platform's key is credited `b_P` of its own legs, which V8 and V11 do not count (7.3); the
  keeper alerts when `FEE_RECIPIENT` holds any city coin, and its keeper backlog alert stays at
  two caps (0.2% of depth, 7.2).
* Under Meteora, curve and pool money sat in Meteora's programs. Here it sits under
  `vicinity_curve`, so the upgrade authority is the main trust: it could take every coin's
  reserves and unpaid shares. The website says so plainly.

### 8.5 Retiring the old launch path

No city coin exists on mainnet. Before the new program accepts its first approval, the
Squads vault becomes the old program's admin (8.4), pauses launches in `vicinity_launchpad`
(`set_pause`) and disables its configs (`set_launch_config_enabled`). Both `approve_launch` and
`launch` here then check on chain that the old program has no `Coin` and no pending `Approval`
for the city, that its launches are paused, and that its admin is this program's admin with no
transfer pending (`LegacyCoinExists`, `LegacyApprovalExists`, `LegacyLaunchesOpen`,
`LegacyAdminMismatch`), so no launch here can happen while the old program could launch, and a
coin created in the old program during an approval's 30-day window blocks the launch here. The
old program cannot see the new one, so keeping it paused after a launch here is what keeps R1 in
the other direction (O19): if the old admin ever unpaused it, launches here would stop at once,
but a city launched here could then be launched again in the old program. The admin check makes
that old admin the same multisig as this program's admin (two of three keys and the 48-hour time
lock, 8.1), never a single hot wallet; the accepted risk of O19 is then the same as any admin
action here. (Review GOV-1 found the old admin on mainnet to be the owner's wallet, also
`FEE_RECIPIENT`: alone it could have reopened the old program, launched a second coin for a city
launched here and paused it again, and blocked pending launches here with old approvals.)

Closing the old program (`solana program close` by its upgrade authority) once it is paused for
good would make it unable ever to unpause: its `Launchpad` stays, owned by `LEGACY_PROGRAM_ID`
with `launches_paused = 1`. It would also freeze its admin field, so a later hand-over of this
program's admin would stop approvals and launches here until an upgrade of this program; the owner
decides (O19). **Precondition of a close (review OPS-4):** the old program holds no `Approval`
account (getProgramAccounts on `LEGACY_PROGRAM_ID`; the deploy checklist with
`--before-legacy-close` refuses otherwise). An old approval is closed only by the old program's
`revoke_approval` (admin only) or `launch`; after a close neither can run, the account stays
owned by the closed program for ever, and `approve_launch` and `launch` here refuse its city with
`LegacyApprovalExists`, also long after it expired (measured with the real old binary and the
loader's `Close`). So each one is revoked first, while the old program can still run. Making the
old program immutable instead of closing it keeps its instructions callable and avoids the trap;
the deploy checklist accepts an immutable old program (a warning, not a problem; review
R5-DIFF-3).

---

## 9. Invariants (asserted after every successful transaction of every test)

Notation as in 5.1. `rent_min` = the rent-exempt minimum of 693 bytes from the `Rent`
sysvar. "Without donations" means no lamports or coins were sent to the `Coin` or the vault
outside this program's instructions (the tests track donations and subtract them).

Per coin:

* **I1 Phase.** `phase` only goes 0 to 1, once. Curve: `s < S`, `pool_sol = pool_tokens = 0`,
  `graduated_at = graduation_slot = 0`. Pool: `s = S`, `curve_sol = R`, `graduated_at > 0`.
* **I2 Frozen terms.** `layout_version, bumps, config_id, city_id, mint, vault, symbol`, the
  six bps fields, `x0, y0, S, P, R, dust_burned, meta_hash, rent_reserve, launched_at,
  launch_slot` never change after launch (byte compare); `founder` changes only in
  `transfer_founder` with both signatures.
* **I3 Caps.** `total_fee_bps` = sum of the five, `1 <= total_fee_bps <= 250`,
  `platform_bps <= 120`, `founder_bps <= 100`, `founder_bps + holders_bps < total_fee_bps`
  (V2b), and the snapshot passes V1 to V11.
* **I4 Curve state function.** Curve: `curve_sol == f(tokens_sold)` and `curve_sol <= R - 1`.
* **I5 Graduation exactness.** In the transaction that sets `phase = 1`: the graduating buy
  ends at `s = S`, `curve_sol = R`; then `pool_sol == R`, `pool_tokens == P` before any pool
  trade, and the vault holds `P` (plus donations).
* **I6 Pool.** Pool: `pool_sol >= 1`, `pool_tokens >= 1`, and `pool_sol * pool_tokens` never
  decreases across any instruction.
* **I7 Ledgers.** `platform_pending == platform_earned - platform_withdrawn`;
  `founder_pending == founder_earned - founder_claimed - founder_paid_out`;
  `holders_pending == holders_earned - holders_forwarded`;
  `buyback_pending == buyback_earned - buyback_spent`;
  `liquidity_pending == liquidity_earned - liquidity_added`.
* **I8 Fee identity.** `fees_total == liquidity_earned + platform_earned + founder_earned +
  holders_earned + buyback_earned`.
* **I9 SOL backing.** `coin.lamports >= min(rent_reserve, rent_min) + reserve +
  liquidity_pending + platform_pending + founder_pending + holders_pending +
  buyback_pending`, and without donations `coin.lamports == rent_reserve + reserve + (the
  five buckets)` (`reserve = curve_sol` or `pool_sol` by phase).
* **I10 Coin backing.** `vault.amount >= (Curve: S - s + P; Pool: pool_tokens)`, with
  equality without donations.
* **I11 Supply and mint.** `mint.supply <= COIN_SUPPLY - dust_burned - tokens_burned`, with
  equality when no holder has burned coins with SPL `Burn` (the tests track such burns and
  assert equality after adding them back); mint authority `None`, freeze authority `None`,
  decimals 6; metadata `is_mutable == false` with the approved name and symbol and
  `uri == METADATA_URI_PREFIX + mint + ".json"`; update authority the `Coin` PDA.
* **I12 Per-trade fee.** For every `Trade` with `A = sol_amount`:
  `fee == floor(A*t/D)` (so `fee * D <= A * t`: never above 2.5%);
  `fee_platform == floor(A*b_P/D)`, likewise founder, holders, buyback;
  `fee_liquidity == fee - (others)` and `floor(A*b_L/D) <= fee_liquidity <=
  floor(A*b_L/D) + 4`; `sol_net == A - fee`; `liquidity_dripped <= min(floor(A*b_L/D),
  liquidity_pending before)`; curve trades drip 0; buys have `sol_in >= MIN_TRADE_LAMPORTS`
  and `sol_amount <= sol_in`, with `sol_amount < sol_in` only when `partial` and `graduated`.
* **I13 Value flow per transaction.** The change of `coin.lamports` equals buyer charges
  minus seller payouts, platform withdrawals, founder claims, founder payouts and holder
  forwards, exactly as the events report (plus donations); buybacks and graduation move no
  lamports.
* **I14 Destinations.** SOL is traced by the lamport difference of every account in the
  message before and after the transaction (direct lamport moves leave no inner
  instruction): the only program-owned account whose balance fell is the `Coin`, by exactly
  the sum of the amounts in the money events (besides Anchor's close of an `Approval` or a
  `PayoutOptIn`, to zero, its rent going to the pinned `rent_payer` or the opt-in's founder;
  NOTES 29); every account that gained lamports, ignoring
  the fee payer's fee and the sources of system transfers, is one of the signer of a `sell`,
  `FEE_RECIPIENT`, `coin.founder`, `launchpad.payout_destination` with an opt-in signed by the
  current founder naming it, or the checked rewards vault, with amounts equal to the events.
  Tokens are traced from the inner instructions actually executed: coins leave the vault only
  to the buyer's token account in a `buy`, or by `burn` in `buyback_burn` (and the launch's
  dust burn). No approve, close, freeze, thaw, set-authority or mint instruction touches the
  vault or the mint after launch. The launch fee goes only to `FEE_RECIPIENT` and equals the
  config's fee.
* **I15 Buyback limits.** Each `BuybackBurned`: `sol_spent >= 1`, `tokens_burned >= 1`,
  `sol_spent <= floor(depth_before * t / (25D))`, `sol_spent <= buyback_pending before`; its
  slot is at least 150 after the previous run (or after `launch_slot`); on the curve
  `tokens_sold <= S - 1` after; `tokens_burned` (counter) grows by exactly the burned amount
  and `mint.supply` falls by it.
* **I16 Monotone counters.** Every `*_earned`, outflow and lifetime counter,
  `tokens_burned`, `buyback_count` and `payout_seq` never decreases; `trade_seq` grows by
  exactly 1 per trade; `liquidity_pending` increases only in curve trades and decreases only
  in pool trades.
* **I17 Partial fill.** A buy with `charged < sol_in` graduates the coin, delivers exactly
  `S - s_before` coins, has `c = R - curve_sol_before >= 1` and
  `charged == floor((c - 1)*D/(D - t)) + 1` and `charged - fee == c`.
* **I18 No free value.** (Property tests P05, P11a, P11b and `tests-curve/25-no-free-value`.)
  A buy followed by a sell of the coins bought, from any reachable state, returns less than was
  charged (P05). Coins still held are valued at what they sell for at the final state (at most
  their spot value less the fee), and: **P11a**, one address alone, arriving with SOL only at any
  reachable state (others' operations and set-aside liquidity before it, the buyback backlog run
  down so that no backlog of others can flow to it), never ends a random sequence of buys, sells,
  pool trades and buyback runs with more than it came with; **P11b**, all addresses together,
  from launch, buying, selling, running buybacks and collecting payouts in random order and then
  selling everything, never end with more than they came with, net of the founder fees received
  and of gifts from outside. (Revision 2's second clause valued coins at the final spot price,
  which is false for any constant-product market: a position marked at the marginal price right
  after the buy that made it is worth more than it cost; NOTES 35.)

Global:

* **I19 Uniqueness.** At most one `Coin` per `city_id` and one `TickerLock` per ticker; never
  closed; `TickerLock.mint == Coin.mint` for the coin with that symbol; an `Approval` and a
  `Coin` never coexist for a city; **at every approval and at every launch**, the old program
  had no `Coin` and no `Approval` for the city, its launches were paused, and its admin was this
  program's admin with no transfer pending (8.5); so was `vicinity_rewards`' registry admin
  (review OPS-1). The seats are taken as they stood at that call (review R5-REG-1): the accounts
  before the transaction, with each earlier `propose_admin` and `accept_admin` of the same
  transaction (of this program, the old one or the registry) and each earlier old `set_pause`
  applied, as the program reads them.
* **I20 Settings.** The compiled program ids never change without an upgrade; payout key and
  wallet separate from each other, the admin, the guardian and `FEE_RECIPIENT` when set;
  `FEE_RECIPIENT` is never the admin, the pending admin or the guardian; a set guardian is never
  the admin or the pending admin (review R5-CONS-1); no coin's founder is
  `FEE_RECIPIENT`, the guardian or the payout key (the program refuses them at every approval,
  launch and founder transfer; that a later `set_guardian` or `set_payout_config` does not name
  an existing founder is a rule the tests keep and an operating rule, 8.4); `guardian` changes
  only in `set_guardian`; `buys_halted` and `buybacks_halted` become true only by the guardian
  or the admin and false only by the admin, and `buybacks_halted` is never set while
  `buys_halted` is not (review LL-1); `next_config_id` equals the number of `LaunchConfig` accounts; a
  `LaunchConfig` changes only in `enabled`; every `LaunchConfig` passes V1 to V11. **Per call
  (review SM-2):** every successful `buy` and `launch` ran with buys open, every `launch` with
  launches open, every `buyback_burn` with buybacks open and every `payout_founder_fees` with
  payouts open, the flags taken as they stood at that call (the `Launchpad` before the
  transaction, then each earlier `set_pause` of the same transaction); a new `Approval` holds
  what 4.8 allows (city id at least 1, a founder that is not `FEE_RECIPIENT`, the guardian or the
  payout key, a nonzero `meta_hash`, an expiry within 30 days of `approved_at`, an enabled
  config, a valid symbol and name, the admin as rent payer), and a new `PayoutOptIn` names the
  coin's founder and the payout wallet (4.18).
* **I21 No admin money path within `vicinity_curve`.** No instruction in any test moves
  lamports or tokens to the admin, the guardian, the payout key, the upgrade authority or the
  keeper; the one exception is an `Approval`'s rent returning to its `rent_payer`, which
  `approve_launch` sets to the admin (its own rent coming back, not a money path). The program
  cannot stop a role key from buying coins with its own SOL, so the token half is a rule for
  the tests (NOTES 29, 34). The founder seat is the one program path that pays a key the admin
  chose: the program refuses `FEE_RECIPIENT`, the guardian and the payout key as founders (4.8,
  4.10, 4.17), so founder claims and payouts never reach them while 8.4's operating rule holds;
  the admin may approve itself as a founder (8.1's worst case), and its founder claims would then
  pay it that coin's founder share, which the tests never do (the checker refuses it).
  `FEE_RECIPIENT` holds no admin, guardian, payout or founder seat and is refused as the
  upgrade authority at initialisation (4.1 to 4.5, 4.8, 4.10, 4.17), so platform withdrawals
  never reach a role key as long as 8.4's precondition on the upgrade authority holds (review
  R2-DIFF-1). This invariant does not cover `vicinity_rewards`: forwarded holders' money is
  distributed by Merkle roots that the same Squads vault publishes as each city's rewards
  authority (8.1).
* **I22 Liveness (nothing stuck).** From every reachable state reached in the tests, unless
  `buys_halted` is set (then buys and launches are refused by design, and buybacks while
  `buybacks_halted` is set, and everything else below still holds): on the curve a buy of `max_quote_in` succeeds and graduates; any
  holder can sell (unless the output would be 0); `withdraw_platform_fees` and
  `claim_founder_fees` succeed; with a correct rewards config (Holders, `founder_bps = 0`,
  WSOL, authority equal to the admin, no pending authority) `forward_holders_fees` succeeds
  (a wrong config can never be fixed, 4.15, O26); once the interval has passed and
  `buyback_pending > 0`, `buyback_burn` either burns, or `curve_sol == f(S - 1)` (the next
  buy graduates the coin, after which buybacks proceed), or `b = min(buyback_pending, cap)`
  buys less than one raw coin at the current price (in the pool `Y * b < X + b`, on the curve
  `tokens_for(r + b) <= s`: dust that burns once the next trades' shares make the bucket worth a
  coin; NOTES 41); approvals can be revoked once expired. Any holder's sell means any holder
  holding lamports, or receiving at least the rent-exempt minimum of an empty account (14.3).
  **Intended permanent balances** (not stuck states, disclosed): the `liquidity_pending` of a
  coin that never graduates (O2); in a config with `liquidity_bps = 0`, the curve-phase rounding
  remainders in `liquidity_pending`; the buyback bucket's dust below the price of one raw coin in
  a coin that stops trading; donations.

---

## 10. Threat model

| # | attack | mitigation | invariant / test |
|---|---|---|---|
| T1 | **Account substitution**: another coin's vault or mint, or another coin, passed to a trade | `coin` seeds and stored bump; `mint` and `coin_vault` pinned to the addresses stored in that `Coin`; typed accounts | I14; X01 |
| T2 | **Fake `Coin`** (same bytes, another owner) | `Account<CurveCoin>` checks owner `vicinity_curve` and the discriminator (distinct from the old `Coin`); seeds re-derived | X02 |
| T3 | **Fake or look-alike mint** in a trade | pinned to `coin.mint`; `transfer_checked` checks mint and decimals; `token::mint = mint` on the user account | X03 |
| T4 | **Token-2022** mint, account or program substituted | `Program<Token>` (classic id); `anchor_spl::token` types check the classic owner; the mint is created by this program under classic Token | X04 |
| T5 | **Program substitution** (System, Token, Metaplex) | `Program<...>` address checks; Metaplex id pinned; rewards and old-program ids compiled | X05 |
| T6 | **Metadata address substitution** at launch | Metaplex PDA re-derived and compared | X06 |
| T7 | **Lamport donation** to a `Coin` to skew prices or accounting | prices and amounts use stored state only; donations are surplus; I9 uses `>=`; `rent_reserve` is the rent figure, not the balance | I9; X07 |
| T8 | **Coin donation** to the vault | stored `tokens_sold` / `pool_tokens` rule, not the vault balance; I10 uses `>=` | I10; X08 |
| T9 | **Rounding drain on the curve** by many tiny trades | state function (Theorem C); minimum buy; flat-step sells refused; the fee rounds down by less than 1 lamport per trade | I4, I12; P01, P02 |
| T10 | **Rounding drain in the pool** | outputs rounded down; `X*Y` never decreases | I6; P04 |
| T11 | **Buy/sell round-trip extraction** | curve exactly minus fees; pool at most `(1-f)(1-f+2l)` | I18; P05 |
| T12 | **Fee dodging by splitting trades** | fee rounded down saves less than 1 lamport per trade; buys at least 0.0001 SOL; a transaction holds about 25 to 40 sells against a 5,000-lamport signature | I12; P08 |
| T13 | **Zero-output trades** (pay for nothing) | `ZeroOutput` when `tokens = 0` or `sol_out = 0`; `TradeTooSmall`; V5b: the completing buy always nets at least 1 lamport | X13 |
| T14 | **Overflow or truncation** | bounds of 5.12; u128 intermediates; checked add/sub; `try_from`; `overflow-checks = true`; math crate returns errors, never panics | U09; P10 |
| T15 | **Division by zero** | `y0 > S >= s`; `x0 + q > 0`; `X + n > 0`; `Y + t > 0`; `D - t >= 9,750`; `t >= 1` | U09 |
| T16 | **Partial-fill abuse** (be charged for coins not received, or take the last coins cheap) | only `charged = gross_for(c)` is taken; Lemma G gives net exactly `c`; tokens exactly `S - s` | I17; U07; X16 |
| T17 | **Forcing a victim into a partial fill** | strict `min_tokens_out` refuses it; the victim pays nothing | X17 |
| T80 | **Sandwiching an ordinary buy or sell above the size threshold** at the client's slippage (reviews MATH3-1, R4-DIFF-2, R4-DIFF-3, R4-DIFF-5, SDK4-4, MV-1, KR-1, R5-DIFF-1), also by pushing a curve trade into a fresh pool, with the buyback runs of a backlog inside the sandwich, across the pieces of a split trade, or by wrapping several trades of one block together | the program enforces the minimum; the clients make the slippage depend on size: at most 0.3% above the coin's sandwich threshold (`sandwichThreshold` at `min(x0 + curve_sol, graduation_sol)` on the curve, less every run the backlog pays for), and at or below it at most `floor(2D * (threshold - V) / depth')`, clamped to 0.3% to 5%, so that everything one sandwich can wrap in a block fits under the threshold, where no sandwich profits (`buyLeg`, `sellLeg`; 5.15, 14.1); a piece of a split order is judged by the order and its minimum anchored to the order's start | 29-clients; `prechecks.test.mjs` |
| T79 | **Forcing a victim out of a partial fill**: a buy signed near graduation with `sol_in` above the remainder and the partial quote's minimum is run in the pool after someone else graduates the coin, charged all of `sol_in` (review R3-CLI-1) | clients offer at most `max_quote_in` with the minimum of that quote (the SDK's `buyLeg`, `buyWithSwap`; `buyLegMinimum` refuses the uncapped pair; 5.4, 14.1, 14.3); the program then refuses the buy (`SlippageExceeded`) and the victim pays nothing; within about 97,500 lamports of graduation `max_quote_in` is `MIN_TRADE_LAMPORTS`, still a partial fill, so the exposure left is 0.0001 SOL (R4-DIFF-1) | 29-clients |
| T18 | **Selling more than the curve sold** | `tokens_in <= tokens_sold` (`SellExceedsCurve`) | X18 |
| T19 | **Graduation front-running** ("pop") | pool opens at most 1e-9 below the curve's last price, never above (V7; default 2.0e-12); the curve-phase liquidity is not dumped into the pool | I5; L07; X19 |
| T20 | **Pool pre-creation or graduation griefing** | the pool is the coin's own account; there is no address to pre-create and nothing external to fail | design; L07 |
| T21 | **Double graduation** | `phase` flag; the curve branch is unreachable in phase Pool | I1 |
| T22 | **Half-graduated state** | graduation is field writes inside the completing buy; no CPI | I5 |
| T23 | **Graduation through the buyback crank** | buyback capped at `S - 1` coins sold; graduation timing via a bundled tiny buy is harmless (V7) | I15; X23 |
| T24 | **Sandwiching the buyback** | cap `depth * t/(25D)`, one run per 150 slots, no arguments; loss at least 3.77% (Theorem M), 2.78% for a credited founder; V2 and V8 for future configs; the platform's key, credited `b_P` and outside V8 (single-run +0.05% under (0, 120, 0, 1, 1)), by the operating rule of 8.4 (review HR-1, O29) | I15; P06; X24; HR-1 |
| T25 | **Multi-leg or bundled sandwich** around a buyback | split-leg bound (loss at least 2.78%, 1.79% for a credited founder; a heuristic with a tested margin); one run per coin per 150 slots, so a bundle holds at most one | P06; X25 |
| T26 | **Buyback timing griefing** | no arguments; any timing only changes how many coins are burned; small runs are safer | X26 |
| T27 | **Farming the liquidity drip** | drip at most `floor(A*b_L/D)` of others' set-aside share; V10 `b_L < b_P` (or 0) | 7.5; P09, P09b; X27, X27b |
| T28 | **Dust trades farming the drip or the remainder** | the remainder never drips; a dust sell drips at most `floor(A*b_L/D)` (0 below 200 lamports at the default); buys have a minimum | X28 |
| T29 | **Reinitialisation** of `Launchpad`, `LaunchConfig`, `Coin`, `TickerLock`, mint, vault, opt-in | plain `init` everywhere; no `init_if_needed` anywhere in the program | X29 |
| T30 | **Closing accounts or revival** | only `Approval` and `PayoutOptIn` close, by Anchor `close` to a pinned key; no code path signs a token `close_account` | I14; X30 |
| T31 | **Rent drain of the SOL-holding PDA** | single `pay_out` refuses to go below `min(rent_reserve, rent_min) + liabilities_after`; the runtime's rent rules; every debit bounded by its bucket or by `gross <= reserve` | I9; X31 |
| T32 | **Cross-coin bleed** | each coin's lamports are its own account; `pay_out` checks that coin's liabilities | I9 per coin; X32 |
| T33 | **Approval replay** | approval closed by `launch`; `Coin` and `TickerLock` permanent | X33 |
| T34 | **Approval or launch for a city that already has a coin or approval** (here or in the old program), or while the old program can launch | `coin`, `legacy_coin` and `legacy_approval` must be empty and System-owned, the old program's launches paused and its admin this program's admin with no transfer pending, at approval and again at launch; `launch` `init` fails anyway | I19; X34; 28-governance |
| T35 | **Ticker squatting inside the program** | `TickerLock` per ticker, permanent; approve refuses a locked ticker | I19; X35 |
| T36 | **Look-alike tokens outside the program** | cannot be prevented on Solana; the on-chain `Coin` / `TickerLock` registry (filtered by program owner) is the official list; hosted metadata only for registry mints | process; 14.1 |
| T37 | **Metadata spoofing or later edit** | on-chain name, symbol and URI are created by the program from the approval and immutable (`is_mutable = false`, update authority the `Coin` PDA). The JSON at the URI is served by the website and is not immutable: its SHA-256 is approved by the admin, stored in `Coin.meta_hash` and emitted; the website serves it write-once with a content-addressed image. A compromised website can still change what it serves; anyone comparing the hash detects it | I11; L05 |
| T38 | **Unicode spoofing in names** (right-to-left override, zero-width, Hangul fillers and other blanks, stray spaces) | `check_name` refuses control characters, every default-ignorable code point and other invisible format character, every blank character, and a leading, trailing or doubled space (4.8; review FA-1), at approval and again at launch, before the name becomes immutable metadata; the server's `nameProblem` applies the same rule. Look-alike letters of other scripts and canonically equivalent spellings remain possible: names are not unique, the ticker is the identifier | U11; X38 |
| T39 | **Supply inflation or freezing** | mint authority set to `None` after the single `mint_to`; freeze authority `None` from creation | I11; X39 |
| T40 | **Re-selling burned coins** | burns are SPL `burn` from the vault; they leave the reserve and the supply together; holder burns only lower the supply | I10, I11; X40b |
| T41 | **Compute exhaustion** | every path O(1); no loops over accounts; no remaining accounts | C01 |
| T42 | **Griefing that blocks trading** | trades write only the coin's accounts and the user's; `Launchpad` is read-only in trades and written only by admin and guardian instructions; no external state; counters cannot overflow (u128); sells never read `Launchpad` | I22; X42 |
| T43 | **Admin abuse** | powers of 8.1; no money path within the program (I21); live coins frozen (I2); caps compiled in | I2, I21; X43 |
| T44 | **Hostile config from a stolen admin key** | V1 to V11 (total at most 2.5%, platform at most 1.2%, founder at most 1.0%, a credited founder, holder of the float, or founder holding the float still pays 0.01% per leg (V2b), curve, continuity, MEV with founder credit, drip, horizon); the founder signs `launch` naming the config via the approval; existing coins unaffected | V01 to V11; X44 |
| T45 | **Stolen admin key approving itself for many cities** | Squads 2 of 3; time lock; approvals expire in at most 30 days; `LaunchApproved` events monitored; O15 would add an on-chain city list | process |
| T46 | **Malicious or buggy upgrade** | Squads 2 of 3; 48-hour time lock once coins are live (O11), during which holders can sell and the guardian can halt buys; verified builds; pre-audited halt-all build rebuilt after every upgrade | process; H03 |
| T47 | **Fake rewards config or vault** | PDAs re-derived under the compiled `REWARDS_PROGRAM_ID`; owner check; config fields checked; vault mint WSOL and authority the config | X47 |
| T48 | **Holder money into a founder-paying rewards config** | model Holders and `founder_bps == 0` required | X48 |
| T49 | **Rewards config whose root publisher is a stranger**, or a self-serving root | `CityConfig.authority == launchpad.admin` and no pending authority required (4.15); roots are published by the Squads vault after the time lock, with the published snapshot and an independent recomputation (8.1) | X47b; process |
| T50 | **Payout redirection** | destination must equal the founder's agreed destination and the current setting, be System-owned, and differ from the admin, the guardian, the payout key and `FEE_RECIPIENT` | X50 |
| T51 | **Payout key abuse** | 24-hour cooldown stored on `Coin`; fixed wallet; it can pause payouts but not resume them | X51 |
| T52 | **Founder key theft** | exposure limited to `founder_pending`; the seat moves only with both signatures, never to `FEE_RECIPIENT`, the guardian or the payout key; the admin cannot reassign | design; 28-governance |
| T53 | **Lost founder key** | the share stays claimable only by that key (O22) | design |
| T54 | **Duplicate or aliased accounts** | `user_token_account.owner != coin` (excludes the vault and any token account of the `Coin` PDA); sells require the user as token owner; the `Coin` PDA can never sign from outside | X54 |
| T55 | **Pre-funding a PDA to block `init`** | Anchor `init` creates over pre-funded system accounts (transfer, allocate, assign); extra lamports are donations | X55 |
| T56 | **Event spoofing**, including the genuine event CPIs that a failed transaction's metadata carries | events by self-CPI signed by the event-authority PDA; indexers apply the acceptance rule of 4.21 (successful transactions only, event CPIs only under a `vicinity_curve` call, settings events only from its logs) and reconcile with state; the SDK's `decodeTransactionEvents` implements it | L13; X56; E01 |
| T57 | **Stale quotes** | `min_tokens_out`, `min_sol_out` | X57 |
| T58 | **Credit to an unfunded destination** (0-lamport seller, founder, router PDA) | the instruction reverts; nothing is lost; retry once funded or with a larger amount; SDK and adapter pre-check (14.3) | X58 |
| T59 | **Clock games** | buyback rate limit in slots; approval expiry and payout cooldown in Unix time (drift of seconds against windows of a day or more) | X59 |
| T60 | **Re-entrancy** | CPIs only to System, SPL Token, Metaplex and the program's own event CPI; none calls user code | review |
| T61 | **Malicious caller of a permissionless crank** | no arguments; amounts from state; destinations fixed; the caller receives nothing | X61 |
| T62 | **Launch sniping** | the founder may buy atomically in the launch transaction; flat fee; first buyback 150 slots after launch; no anti-sniper fee (O20) | design |
| T63 | **Rent increase** | `pay_out`'s floor uses `min(rent_reserve, live rent)`, so the program never refuses an exit because of a rent increase; the runtime's rent-state rule (SIMD-0392) still refuses a debit that would leave a `Coin` below the live minimum, which after an increase of `d` affects only coins whose remaining liabilities are below `d`: anyone can top a `Coin` up, and after a rent change the keeper tops up every coin by `liabilities + live minimum - lamports` when positive (`coinRentTopUp`; a coin above the live minimum can be blocked, and one topped up only to the minimum stays blocked; 6.5, 14.1, review OPS-2) | X63; OPS-2 |
| T64 | **Front-running `init_launchpad`** | only the program's upgrade authority can call it | X64 |
| T65 | **IDL account squatting** | `no-idl`: no IDL instructions in the binary; IDL published through the Program Metadata program by the upgrade authority | C03; X65 |
| T66 | **A hostile website or front end building another transaction** | fixed account lists, wallet simulation, IDL published by the upgrade authority; the website holds no key that can approve, halt or move funds | process |
| T67 | **The old program launching a city here or there** | on-chain checks at approval and launch, including that the old program's admin is this program's admin with no transfer pending (8.5), so reopening the old program needs the same multisig and time lock; keeping it paused afterwards is process (O19) | I19; X34; 28-governance |
| T68 | **Front-end fee on top** (an app adds its own fee) | outside our program; disclosed in the label (6.6) | process |
| T69 | **Stuck buyback bucket** (cap 0) | V4: `x0 * t >= 25D` and `R*P*t >= 25D * 10^15`, so the cap is at least 1 lamport in every reachable state | I22; V04 |
| T70 | **Missing or wrong rewards config** | missing: holders' money waits in `holders_pending`, forward works once a correct config exists; wrong: it can never be fixed (no update or close in `vicinity_rewards`), so the SDK simulates and checks before proposing; fallback O26 ; the SDK ignores lamports sent to the config address and reports a config whose only problem is its authority as fixable (4.15) | I22; R01, R03; 29-clients |
| T71 | **Pending liquidity of a coin that never graduates** | locked by design, counted, disclosed as never used (O2) | I7, I22 |
| T72 | **Misuse of the halts** | the guardian can only stop buys, buybacks and launches, never exits, and cannot clear its own flags; buybacks only while buys are halted, so no backlog builds in front of open buys (review LL-1); the halt-all build needs an upgrade (multisig, time lock); halt-all refuses every outflow by design | H01 to H03; X43b; LL-1 |
| T73 | **Stolen guardian**, also one that sets a flag late in the time lock to make the admin's recovery proposal fail (reviews R4-DIFF-4, OPS-3) | the same limits; the admin replaces the guardian with `set_pause(buybacks = false)` and buys left halted (a proposal no flag can make fail; the SDK's `guardianRecovery`), then reopens buys in a later proposal, buybacks before buys when backlogs built up (4.4, 8.3) | X43b; LL-1; 28-governance R4-DIFF-4 |
| T74 | **Third-party pools for the coin** | cannot be prevented for a classic SPL coin; they pay no Vicinity fee and buybacks and injections carry over to them only past 2.5% plus their fee; labelled (6.6) and listed as an owner-visible risk (13, 14.5) | process |
| T75 | **CPI after a direct lamport move** (`UnbalancedInstruction`, stuck instruction) | rule of 4.0; `forward_holders_fees` leaves `SyncNative` to a separate top-level instruction | R02, R02b |
| T76 | **Buying ahead of a public buyback backlog** (hold through several runs), including the backlog a halt of buybacks leaves and the predictable moment buys reopen (review LL-1) | Theorem M_K; 0.1% step; V11 horizon; keeper every interval, alert above two caps (0.2% of depth), backlog shown on the coin page, the clients' threshold counting every run the backlog pays for (5.15, review KR-1); buybacks halted only while buys are, resumed first, and the keeper drains every backlog before buys reopen (8.3); the platform's key, credited `b_P`, by the operating rule of 8.4 (7.3, review HR-1); residual risk signed off (O25) | P06b; X25; LL-1; HR-1 |
| T77 | **One hot key in several roles** (`FEE_RECIPIENT` as admin, guardian, upgrade authority or a coin's founder, the guardian as payout key or wallet, the guardian or the payout key as a coin's founder, the old program administered by another key) | refused by `init_launchpad`, `propose_admin`, `accept_admin`, `set_guardian` and `set_payout_config` (`FeeRecipientRole`, `PayoutKeyNotSeparate`) and, for the founder seat, by `approve_launch`, `launch` and `transfer_founder` (`FeeRecipientRole`, `FounderHoldsRole`); later moves of the upgrade authority and settings that name an existing founder are 8.4's operating rule; approvals and launches require the old program's admin to be this program's admin (`LegacyAdminMismatch`, 8.5) | I19, I20; 28-governance |
| T78 | **A client buy without a minimum** (the "pay with any token" composer), sandwiched | the program enforces `min_tokens_out`; the SDK's `buyWithSwap` refuses to build a buy without one (14.1) | 29-clients |

---

## 11. Compute and size budgets

### 11.1 Compute units (estimates; to be replaced by measurements before the audit)

| instruction | estimate | main costs | test budget (asserted) | suggested client limit |
|---|---|---|---|---|
| `buy` (curve or pool) | 31,000 to 42,000 | dispatch and logs about 2,000; `Coin` (693 bytes, boxed) deserialize and serialize about 5,000 to 7,000; `Coin` PDA check about 1,500; `Launchpad` load and PDA check about 3,000; user token account load about 1,000; event-authority check about 1,500 to 4,500; u128 math about 1,500 to 3,000; system transfer CPI about 2,500; `transfer_checked` with PDA signer about 6,000 to 7,000; event CPI about 5,000 | 48,000 | 60,000 |
| `buy` that graduates | plus 3,000 to 6,000 | second event | 55,000 | 70,000 |
| `sell` | 28,000 to 39,000 | as `buy` without the system CPI and without reading `Launchpad` (address check only); plus the `Rent` sysvar and the lamport move | 48,000 | 60,000 |
| `buyback_burn` | 26,000 to 35,000 | SPL `burn` with PDA signer instead of a transfer; `Launchpad` load | 48,000 | 60,000 |
| `withdraw_platform_fees`, `claim_founder_fees` | 12,000 to 18,000 | no CPI except the event | 25,000 | 40,000 |
| `payout_founder_fees` | 15,000 to 22,000 | opt-in load, event | 30,000 | 40,000 |
| `forward_holders_fees` | 20,000 to 32,000 | two `find_program_address` under the rewards program; no token CPI (`SyncNative` is a separate instruction, about 3,000) | 40,000 | 60,000 |
| `launch` | 125,000 to 190,000 | Metaplex CPI dominates (today's launch through DBC and Metaplex measured 154,600 to 173,704); four `init`s; `mint_to`; dust `burn`; `set_authority`; two `find_program_address` under the old program | 230,000 | 300,000 |
| `launch` + idempotent ATA create + first `buy`, one transaction | 175,000 to 260,000 | the sum of the three | asserted by C01 | 400,000, or 1.2 x the simulated figure (as the Worker already does for trades) |
| admin and settings instructions | 5,000 to 30,000 | `approve_launch` includes two `find_program_address` under the old program | 50,000 | 60,000 |

Reference: Meteora DBC `swap2` measured 29,987 to 39,598 CU (LAUNCHPAD-AUDIT.md 5.1), so a
trade here should cost about the same. If the efficient SPL Token implementation is live on
the cluster, each token CPI costs less. Boxing adds a few hundred CU of heap work; C01 is
re-measured after boxing. Optional savings deliberately not taken (they trade auditability for
compute): zero-copy `Coin`, stored event-authority bump, untyped user token account.

Measured on the production build (NOTES 30; C01 asserts every figure against its test budget):
a curve buy about 26,100 CU and a sell about 23,500; the graduating buy 29,600; pool trades about
25,500 and 23,500; `buyback_burn` about 20,000; `launch` 110,382 to 152,266 CU over 600 city ids
(median 123,882, p99 145,022; review TL-INFO-1: the spread is the bump searches of the PDAs
`launch` derives or re-derives, which depend on the city id, the mint and the ticker, about 1,500
to 1,700 CU per extra iteration; the worst known city under the localnet id, 1000 with name A and
symbol C0, takes 151,008, asserted by `12-compute`); `launch` + token account + first buy 165,500
in total for one city; settings instructions 3,800 to 22,700. Every figure is inside its test
budget. The suggested client limits are per instruction: the website's first buy adds the
idempotent token-account create, about `13,430 + 1,500 x k` CU with `k` the owner's extra bump
iterations (13,424 to 25,424 over 300 owners; the base is the associated token program's own cost
and differs by a few CU between runtimes; `12-compute` asserts the formula), so a first buy
takes its limit from a simulation (1.2 x, as for `launch`) or adds 30,000 to the buy's figure. The
figures depend on the program id (its event-authority and `Launchpad` bumps add about 1,500 to
2,400 CU per extra iteration to every money instruction) and are measured again once the mainnet
id exists.

### 11.2 Account sizes and launch cost

Sizes and rents are in 3.3. A founder's launch costs, at today's mainnet rent rate: rent
11,724,640 lamports (`Coin` 4,170,680, mint 1,066,800, vault 1,488,440, ticker lock 899,160,
metadata about 4,099,560) + launch fee 50,000,000 + Metaplex's fee 10,000,000 = about
0.0717 SOL, plus network fees (0.0761 SOL at litesvm's rate). The approval's rent (1,569,720
lamports) returns to the Squads vault.

### 11.3 Transaction sizes (estimates; measured by C02)

* `buy` / `sell`: 24 bytes of instruction data, 10 accounts. A website buy with two
  compute-budget instructions and an idempotent create of the buyer's token account is about
  550 to 590 bytes (DBC `swap2` today: 731).
* `launch`: 22 accounts (the rewards registry since review OPS-1), 1 or 2 signatures (the mint is a PDA, so no mint keypair signs):
  about 950 to 1,050 bytes. `launch` plus the founder's first buy (with an idempotent token
  account create) is about 1,100 to 1,200 bytes without a lookup table, too close to the
  1,232-byte limit, so the website uses an address lookup table holding the static accounts
  (System, Token, ATA, Metaplex and Compute Budget programs, the rent sysvar, the event
  authority, `vicinity_curve`, `FEE_RECIPIENT`, `Launchpad`, `LEGACY_LAUNCHPAD`,
  `REWARDS_REGISTRY`, the config PDAs): about 800 to 900 bytes with it.
* `approve_launch` goes through a Squads vault transaction (lookup tables supported).
* Measured (C02, NOTES 30): the website's buy 555 bytes, its sell 513, `launch` alone 920,
  `launch` + token account + first buy 1,031 bytes without and 786 with the lookup table.

### 11.4 Program binary

Target: at most 450 KB (today's `vicinity_launchpad` is 433,960 bytes with Meteora's
interfaces). The Metaplex wrapper of anchor-spl adds code; `no-idl` removes Anchor's six IDL
handlers; measure (C03). Measured: 591,296 bytes for the production build of revision 3
(cargo-build-sbf 4.4.0, platform-tools v1.57; NOTES 20), above the target, which costs rent, not
behaviour; no build prints a stack warning (C04). The program data account rent at 5,080 lamports per byte is about
2.3 SOL for 450 KB; an upgrade needs a buffer of the same size, and so does the halt-all
buffer kept ready.

---

## 12. Test plan

Structure follows today's suites: Rust unit and property tests in the math crate and the
program (`cargo test`; the property tests use `proptest` as a dev-dependency, which no program
build sees, NOTES 1), and litesvm in-process tests in JavaScript (`node:test`, built like
`tests-launchpad/helpers.mjs`, in `tests-curve/`, NOTES 28) with the Metaplex fixture
`mpl_token_metadata.so` and the committed mainnet binaries of `vicinity_rewards` and
`vicinity_launchpad`, both loaded at their mainnet addresses (NOTES 27). Every transaction of every
litesvm test is followed by the invariant checker (I1 to I22) and the money-flow tracer (I13,
I14): SOL from the pre and post lamports of every account in the message (direct lamport moves
leave no inner instruction, so a tracer built only on inner instructions would check nothing),
tokens from the inner instructions that actually executed. A failed transaction must have
moved nothing but its fee (none when the runtime refused it before execution, NOTES 47), and
every transaction is also decoded with the SDK's transaction-level event decoder, which must
find exactly the checker's events, and nothing for a failed one (E01).

### 12.1 Math crate unit tests (U)

| id | test | covers |
|---|---|---|
| U01 | fee and split examples to the lamport: 2, 41, 560, 1,961, 100,000 and 100,001 lamports, 1 SOL, 975,113,405 (E5), 87,179,487,179 (E3); `fee * D <= A * t` for each | 5.2, I12 |
| U02 | split bounds over all `A < 10^6` and 10^5 random u64 `A`: sum, remainder in `[0, 4]`, and that 4 is reached (first at 560) | Lemma F |
| U03 | `f` and `tokens_for`: Lemma C1 on random `(q, s)`; edges `s = 0`, `s = S`, `q = 0` | 5.3 |
| U04 | default config: `f(S) = R`, `f(S - 1) = R - 1`, V1 to V11 pass with the margins of 5.13, continuity numbers, absorption ratio, start/end prices | 5.9, 5.10 |
| U05 | worked examples E1 to E10 exactly | 5.14 |
| U06 | gross-up Lemma G: `gross_for(c)` is the least `G` with net `c`, for every `c < 200,000` at `t` in {1, 37, 249, 250}, every `t` in [1, 250] for `c < 2,000`, and random large `c` | 5.4 |
| U07 | partial fill: `charged <= sol_in`, tokens `S - s`, net `R - r >= 1`, including `rem = 1` (charged 1, fee 0) | I17 |
| U08 | buyback quotes: cap, `S - 1` cap, all no-op cases, `spent <= b`; a state with `curve_sol = f(S - 1)` and `s` on the last flat step below `S - 1` (2,433 raw units at the default; not reachable by instructions, 5.3) is a no-op | 7.1, I15, I22 |
| U09 | overflow and division edges at the bounds of V3 and V4, including `x0 = y0 = 2^60`, `t = 250`; `u64::MAX` inputs return `MathOverflow`, never panic | T14, T15 |
| U10 | `decode_coin` offsets equal the Borsh layout of the program's `CurveCoin` (round trip); it rejects a wrong owner, a wrong length, `layout_version != 1` and the old program's `Coin` bytes | 3.7, 5.16 |
| U11 | `check_name` (every default-ignorable code point and blank character, the space rule; review FA-1), `check_symbol`, `metadata_uri` | T38 |
| U12 | compiled constants: `LEGACY_LAUNCHPAD` and `REWARDS_REGISTRY` equal their derivations for each cluster build; the legacy discriminator, size and the offsets of `launches_paused`, `admin` and `pending_admin` match the old program's `Launchpad`; the registry's discriminator, size and `admin` / `pending_admin` offsets match `vicinity_rewards`' `Registry` | 3.2 |
| V01-V11 | one test per config rule: only that rule violated gives its error; the edge passes; the edge plus one fails (V2 for both caps and V2b at `t - b_F - b_H = 1` and 0; V5 for V5b; V10 at `b_P = b_L + 1` passes and `b_P = b_L` fails) | 5.13, T44 |

### 12.2 Property tests (P; at least 10^6 cases each)

| id | property | invariants / threats |
|---|---|---|
| P01 | random curve operation sequences keep `curve_sol == f(tokens_sold)` | I4; T9 |
| P02 | sequences returning to the same `s` give the same `curve_sol` (path independence) | I4; T9 |
| P03 | non-completing buys have `c == n` (no dust) under random valid configs | 5.3 |
| P04 | pool `X*Y` non-decreasing, reserves positive | I6; T10 |
| P05 | round trips from random states lose at least the bound | I18; T11 |
| P06 | single-run buyback sandwich: canonical and random multi-leg never profit, for attackers credited nothing, the founder share, and the founder and holders shares; each result within its Theorem M or split-leg bound | I15; T24, T25 |
| P06b | hold-through: a backlog of 0.5% to 10% of depth (and of 10 caps, and unlimited) held for 1 to 30 runs; every result within Theorem M_K; profit only when `B/X1 > u*`; never profitable below `K*` runs | T76 |
| P07 | ledger identities and liabilities conservation after every operation | I7, I8, I9 |
| P08 | `fee * D <= A * t` and `fee > A*t/D - 1` for all `A` | I12; T12 |
| P09 | `drip <= min(L, floor(A*b_L/D))`; drip only in the pool | I12, I16; T27 |
| P09b | drip farming from random states under random configs passing V1 to V11, attacker credited the founder, holder and buyback shares: never a gain beyond the fee's rounding (at most one lamport per attacker trade, which 5.1 and 5.11 allow; NOTES 16) | T27 |
| P10 | random configs that pass V1 to V11 (and `x0 = y0 = 2^60`, `t = 250`): no overflow anywhere at extreme reachable states | T14 |
| P11a | one address alone, from reachable states (others' trades and injected liquidity before it, the backlog run down), never ends a random sequence of buys, sells, pool trades and buyback runs with more than it came with, coins held valued at what they sell for | I18; T11 |
| P11b | all addresses together, from launch, trading, running buybacks and collecting payouts in random order, then selling everything, never end with more than they came with, net of the founder fees received | I18 |

### 12.3 litesvm lifecycle tests (L)

| id | scenario |
|---|---|
| L01 | `init_launchpad` only by the upgrade authority; second call refused; guardian stored |
| L02 | admin two-step; cancel; separation rule at both steps |
| L03 | `add_launch_config` for config #0 and edge configs; every V error on chain; `set_launch_config_enabled` |
| L04 | `approve_launch` (each check and error), `revoke_approval` by the admin and by anyone after expiry, refused before expiry for non-admins; coin, ticker and legacy checks (an old-program `Coin` and `Approval` created with the real old program; its launches open or paused; a wrong-owner or wrong-size account at `LEGACY_LAUNCHPAD`; an old admin other than this program's admin, or a transfer pending there; the same for the rewards registry's admin, 28-governance OPS-1) |
| L05 | `launch`: accounts created; metadata fields; `meta_hash` stored and emitted; supply after the 9.1-coin burn; authorities `None`; fee to `FEE_RECIPIENT`; rent; `rent_reserve`; the legacy checks again at launch (a legacy coin created after approval blocks the launch); the pool-option config (no burn); CU and transaction size with a first buy through the lookup table |
| L06 | curve trading: buys and sells; slippage; minimum buy; `Trade` events match state |
| L07 | graduation: exactly at `S` and `R`; partial fill; `rem = 1`; `Graduated`; the next trade uses the pool with the same account list |
| L08 | pool trading and the drip until `liquidity_pending` is 0 |
| L09 | buyback: interval (including the first after launch), cap, burn, supply; never graduates; no-op cases; refused while `buybacks_halted` |
| L10 | withdraw, claim, opt-in, payout (cooldown, pause, destination rules), forward followed by a top-level `SyncNative` |
| L11 | `transfer_founder`; an old opt-in stops working |
| L12 | pauses and the guardian: launches, payouts, buys, buybacks (only while buys are halted, resumed no later than buys); trading exits, claims, forwards and withdrawals unaffected; only the admin clears |
| L13 | invariant checker and money-flow tracer after every transaction of every test; event authority check |

### 12.4 Attack tests (X; one per testable threat, each asserting that no balance moved)

X01 account substitution in every slot of `buy`, `sell`, `buyback_burn`; X02 fake `Coin`
(including the old program's `Coin` bytes under another owner, and a `Coin` made by the old
program itself in the coin slot of every coin-level instruction); X03 fake mint; X04 Token-2022
mint, account and program (a real Token-2022 mint, and Token-2022 copies of the coin's mint,
vault and a holder's token account, alone and with the Token-2022 program, in `buy` and `sell`); X05 program substitution; X06 metadata address; X07 lamport
donation then full lifecycle; X08 coin donation; X13 zero outputs; X16 partial-fill edges
(rem 1, rem 2, last step); X17 victim forced near completion; X18 oversell; X19 graduation
arbitrage loses; X23 buyback at `S - 1`, then a bundled 0.0001 SOL buy graduates (charged 1
lamport); X24 canonical sandwich on chain; X25 bundled multi-leg sandwich, and a hold through
several runs of a seeded backlog; X26 crank called every interval; X27 drip farming; X27b the
V10 edge on chain (`b_P = b_L + 1` config: a loss; `b_P = b_L` refused at `add_launch_config`);
X28 dust sells; X29 re-`init` of every account; X30 close attempts; X31 rent floor (forced by
editing a live `Coin` out of band so that its liabilities exceed its balance, proving `pay_out`
refuses; no test-only build, NOTES 31); X32 two coins, one
drained by sells, the other untouched; X33 approval replay; X34 approval and launch for a
launched city, a legacy city, a city with a legacy approval, while legacy launches are open,
and while the old program's admin is another key or has a transfer pending; X35 ticker reuse under another city; X39 mint and freeze authority; X40b a holder burns
part of his balance, then every invariant (I11 with the burn added back) and the I22 probe
hold; X42 a trade while another coin is hammered; X43 every admin instruction cannot move
money; X43b the guardian cannot clear a flag, set payouts, block a sell, claim, forward or
withdrawal, or change a setting; X44 hostile configs (including founder-favouring splits
refused by V2 and V8, and the founder or the holders credited the whole fee, or the two shares
together the whole fee, refused by V2b; reviews ECON-1 and R3-DIFF-1), and the accepted
hostile configs through a whole life, in which the founder's own wash trade loses at least
0.01% of each leg, also after the holders' share of both legs; X47 fake rewards config and vault (reuse of TE10 to TE13 style), including a config owned by
the other cluster's rewards program id; X47b a
Holders/WSOL config whose authority is a stranger, and one with a pending authority, are
refused; X48 Creator and Split rewards configs refused; X50 payout destination games; X51
payout key cooldown and pause; X54 aliased accounts (including the Coin PDA's ATA as
`user_token_account`); X55 pre-funded PDAs and vault; X57 stale quotes; X58 unfunded
destination: a sell and a `claim_founder_fees` to a 0-lamport signer below and above the
rent-exempt minimum; X59 clock and slot warps around the buyback interval, the payout
cooldown and approval expiry; X61 hostile crank caller; X63 `Rent` sysvar raised by 10%: a
sell, a claim, a withdrawal and a forward still work, a debit below the live minimum of a
nearly empty coin is refused, and a top-up restores it; X64 `init_launchpad` by a stranger;
X65 the IDL instruction tag returns `IdlInstructionStub`.

### 12.5 Fuzz, differential, compute, halts, rewards, devnet

| id | test |
|---|---|
| F01 | 10^5-step random sequences with several users, buys, sells, buybacks, claims, forwards, withdrawals, payouts, donations, holder burns and graduation, run in litesvm with a model side by side (the SDK's math port fed by each action's own inputs, NOTES 38); `Coin` state byte-equal after every step; admin hand-overs followed by the old program's admin and each city's rewards authority (NOTES 48) |
| F02 | account fuzz: every account slot of every instruction replaced by random plausible accounts; always refused, no balance moved |
| F03 | config fuzz: random `ConfigParams`; on-chain `validate_config` agrees with the model (V1 to V11) |
| G01 | Rust math crate, TypeScript port and on-chain results equal to the lamport on 10^4 random trades, including graduating buys and buybacks (golden vectors exported by the Rust crate) |
| G02 | a mock router program CPIs `buy` and `sell`, with `user` both the transaction signer and a router PDA signing with `invoke_signed`: balances, events and CPI depth (event self-CPI at depth 3) work; a PDA with data as `user` of a `buy` is refused by the system transfer; partial-fill leftovers stay with the router |
| G03 | "pay with any token": a Jupiter swap that under-delivers SOL before `buy` never spends SOL the user already had (ExactOut or `sol_in = otherAmountThreshold`, 14.1); the buy leg carries its own `min_tokens_out`, without which the SDK builds nothing, and a sandwich front-run then makes the buy fail (CLI-1); the swap's output must be native SOL, or the SDK refuses the quote (SDK4-5) |
| E01 | the SDK's transaction-level event decoder on every transaction of every litesvm suite: exactly the checker's events for a success, nothing for a failure; a failed transaction carrying a genuine `Trade` event CPI yields nothing (CLI-2) |
| C01 | CU per instruction asserted against 11.1, including `launch` + ATA create + first `buy` in one transaction |
| C02 | transaction sizes of the website's buy, sell and launch-with-first-buy (with the lookup table) |
| C03 | binary size and hash; toolchain, `anchor-lang`, `anchor-spl` and `mpl-token-metadata` versions; the compiled program ids; the IDL tag refused |
| C04 | CI fails on any cargo-build-sbf "Stack offset ... exceeded" warning |
| H01 | guardian halt: `launch` and `buy` refuse with `BuysHalted` while `buyback_burn` keeps running; with buybacks halted too, `buyback_burn` refuses with `BuybacksHalted`; `sell`, claims, forwards, withdrawals and payouts work; only the admin clears, buybacks first |
| LL-1 | a halt of buys and buybacks over a mostly sold pool: buybacks cannot be halted alone, buys cannot reopen before buybacks, the keeper drains the backlog while buys are halted, and the first buyer after the clear loses; on a twin coin left undrained he would profit (review LL-1) |
| H02 | `halt-all` build: every outflow (`sell`, `withdraw_platform_fees`, `forward_holders_fees`, `claim_founder_fees`, `payout_founder_fees`, `buyback_burn`, `buy`, `launch`) refuses with `TradingHalted` |
| H03 | the `halt-all` build deployed over live coin state produced by the normal build, then upgraded back to the normal build: every coin's state and balances unchanged and fully working; the halt buffer is rebuilt from the deployed commit after every upgrade |
| R01 | real `vicinity_rewards` in the same VM: create a WSOL Holders config (authority the admin) for a new coin; run the real `forward_holders_fees` followed by a top-level `SyncNative`; then `SyncNative` and `fund_epoch_from_vault`; claim with a Merkle proof |
| R02 | the real `forward_holders_fees` with `amount > 0`, then `SyncNative` in the same transaction: the vault's `amount` grows by exactly `amount` and the `Coin`'s lamports drop by the same |
| R02b | documentation test: a CPI of `SyncNative(rewards_vault)` after a direct lamport move fails with `UnbalancedInstruction` (the rule of 4.0), shown with a test-only mock router on the same runtime instead of a test-only build of the program (NOTES 40) |
| R03 | a rewards config with the wrong model makes `forward_holders_fees` fail every time and nothing moves (it can never be fixed); one with a stranger authority fails until that authority hands over to the admin (`propose_authority` / `accept_authority`); the SDK's `initRewardsForCoin` refuses to propose either, reports the stranger authority as fixable and the wrong model as unfixable, and proposes `init_city` over a pre-funded config address |
| D01 | devnet rehearsal with a throwaway program key (`devnet` build): init, config #0, approve, launch, trade to graduation, buybacks, forwards, claims, withdrawals, guardian halt; addresses recorded. No mainnet |

### 12.6 Invariant and threat coverage

| invariant / threat | tests |
|---|---|
| I1, I5, I17 | L07, U07, F01 |
| I2, I3, I20 | L13 (byte compare after every transaction), V01 to V11, L03, L12, 28-governance |
| I4 | P01, P02, F01 |
| I6 | P04, L08, F01 |
| I7, I8, I16 | P07, L13, F01 |
| I9, I10, I13, I14 | L13 (tracer), X07, X08, X31, X32, X63, F01 |
| I11 | L05, L09, X39, X40b |
| I12 | U01, U02, P08, P09, L06, L08 |
| I15 | U08, L09, P06, X23 to X26 |
| I18 | P05, P06, P06b, P11a, P11b, X19, X24, X25, X27 |
| I19 | L04, L05, X33 to X35 |
| I21 | X43, X43b, L13 |
| I22 | L13 liveness probe after every 100th step of F01, L09, R01, X40b, X63 |
| T24, T25, T76 (buyback MEV) | P06, P06b, X24, X25 |
| T27, T28 (drip) | P09, P09b, X27, X27b, X28 |
| T49, T70 (rewards path) | X47b, R01, R03 |
| T58, T59, T63 (runtime) | X58, X59, X63 |
| T65 (IDL) | C03, X65 |
| T72, T73 (halts) | H01 to H03, X43b |
| T75 (CPI after lamport move) | R02, R02b |
| R11 integration | G01, G02, G03, E01, C02 |
| T56 (events) | X56, E01 |
| T77, T78, T79, T80 (roles, client minimum, the completing buy, size-dependent slippage) | 28-governance, 29-clients |

---

## 13. Owner decisions (the default is what this specification builds)

| # | question | default (built) | alternative | consequence of the alternative |
|---|---|---|---|---|
| O1 | Where does the 0.5% "protocol/liquidity" share go? | **Into the pool's SOL reserve, without adding coins** (it deepens the pool and raises the price; sellers receive it through trades like all pool SOL), config field `liquidity_bps = 50`; label in 6.6 | A future config with `liquidity_bps = 0` and the 50 bps given to another bucket (for example platform 120 bps, shown as "Vicinity 1.2%"; or holders; or buyback) | No code change; only new coins; the platform cap of 1.2% already allows it; V8, V10 and V11 must still pass (V10 needs `b_L < b_P`; V11 keeps `b_L` at about 58 or less while a buyback share exists). With platform 120 bps the platform's key would profit from a 1.34% backlog after 14 runs, below V11's 15-run promise (7.3, review HR-1): it relies on the operating rule of 8.4, or on O29 |
| O2 | The 0.5% collected before graduation | **Set aside in `liquidity_pending`, fed into the pool after graduation at most at each trade's rounded-down liquidity share** (no price jump). **For a coin that never graduates (most coins) it is never used and stays locked forever, benefiting no one: needs the owner's explicit sign-off** | (a) Spend it during the curve through the capped buyback path (buy and burn): the SOL enters `curve_sol` and moves to the pool at graduation, nothing sits idle, no drip; (b) add it all at graduation | (a) It is buy-and-burn, not liquidity, before graduation; the label changes; it adds to the buyback backlog (7.3); a code change before the audit. (b) The pool opens 0.5% to 5% above the curve's last price and graduation becomes snipeable (5.8); V7 would have to be relaxed |
| O3 | R8's 9.1 leftover coins (`10^15 - 793,099,990,000,000 - 206,900,000,900,000 = 9,100,000` raw); R8's figures cannot all hold with nothing else changing | **(a) Burned at launch**: sold and pool figures exact, supply 999,999,990.9 coins after launch, integers of 5.9 | (b) To Vicinity's wallet as today: all three figures exact; (c) into the pool (revision 1): supply exactly 1,000,000,000, pool 206,900,010 | (b) needs code (an ATA for `FEE_RECIPIENT` created in every launch, about 0.0015 SOL of rent paid by the founder, for coins worth about 0.0000037 SOL) and a token path at launch; (c) is a config change. **Decide before the audit freeze** |
| O4 | Fee rounding | **Settled by R2: the total is rounded down** (never above 2.5%), named shares rounded down, remainder (0 to 4 lamports) to liquidity | none (rounding up would break R2's "never above 2.5%" and would need an explicit waiver) | |
| O5 | Smallest trade | **Buys at least 0.0001 SOL; sells have no minimum** (any holder can always exit) | Same minimum on sells | Removes the sub-40-lamport sells that pay no fee, but holders of less than 0.0001 SOL of a coin could no longer sell it |
| O6 | Fee caps | **Total at most 2.5% (hard); platform at most 1.2%; founder at most 1.0%; launch fee at most 0.5 SOL** | Platform at most 1.0% | Tighter public commitment; O1's "send it to Vicinity" would then need an upgrade |
| O7 | Buyback parameters | **At most 0.1% of depth per run, once per 150 slots, first run 150 slots after launch, never graduates, and no fee on the buyback** (an exception to R2's "every buy": sign-off needed) | Larger steps (a backlog forms less often, but a multi-run hold profits sooner, and at 1% V8 fails for the default split once the founder is credited: 0.9998 against 0.99); slower pace (always safe); a fee on buybacks (pays platform and founder from burn money) | Step and interval are compiled constants: changing them is an upgrade |
| O8 | Buybacks during the curve phase | **Yes** | Only after graduation (the bucket waits) | Less support during the curve; one branch fewer |
| O9 | Can trading be paused? | **Buys, buybacks and launches: yes, by the guardian (at once) or the admin, buybacks only while buys are halted; exits: never.** Plus the pre-audited halt-all build by upgrade (8.3) | No guardian (halt-all build only) | Under the time lock the only brake would take 48 hours; the trade lists would drop back to 9 accounts (decide before the audit freeze, because aggregators copy the list) |
| O10 | SOL custody | **Native lamports in the `Coin` PDA** (M1); not proven that every aggregator and terminal can route it: get written confirmation from Jupiter, Axiom, GMGN and FOMO before the audit freeze | WSOL token account per coin | Routers that only handle token accounts integrate more directly; one more account and one more token CPI per trade; recipients (founder, `FEE_RECIPIENT`, payout wallet) need WSOL accounts, which the previous audit showed can break flows; a rewrite and a new audit if decided after the freeze |
| O11 | Upgrade policy | **Squads 2 of 3 as upgrade authority; verified builds; 48-hour time lock from the first mainnet coin launch; a guardian for the fast brake.** The lock applies to every proposal of the same multisig, so it also delays every `vicinity_launchpad` and `vicinity_rewards` action of the vault (new cities' `init_city`, every reward round, pauses, upgrades) and every approval here by 48 hours (8.4) | No time lock (the halt-all build then deploys in one proposal) | Without a time lock, a compromise of two Squads keys could take every coin's reserves, and every forwarded holder lamport, at once |
| O12 | Founder payout opt-in (X Money style) | **Built, off by default**, native SOL to the fixed payout wallet | Leave it out of v1 | Three instructions and one account fewer for the auditor |
| O13 | On-chain ticker lock | **Yes** (`TickerLock`) | Website lock only | A stolen admin key could reuse a big city's ticker under another `city_id` |
| O14 | One coin per city across both programs | **Yes, on chain at every approval and launch** (old `Coin` and `Approval` empty, old launches paused) | No check | R1 would rely only on pausing the old program |
| O15 | Commit the official city list on chain | **Not built** | Store a Merkle root of `tickers.json` (`city_id`, ticker) at init and require a proof in `approve_launch` | A stolen admin key could then not invent cities; adds a Merkle check and a root-update power |
| O16 | Launch fee | **0.05 SOL, all to `FEE_RECIPIENT`** | Another amount per config, up to 0.5 SOL | New config |
| O17 | Metaplex's own 0.01 SOL metadata fee | **Accepted**: a one-time launch cost paid to Metaplex, not a trading fee; without Metaplex metadata wallets show an unknown token, and Token-2022 metadata would break R3 | none recommended | |
| O18 | The last buy | **Partial fill**: the buyer pays only for what the curve still had | Continue the rest of the buy in the new pool | Exact-in for routers, but two pricing legs and a fee split across them in one instruction |
| O19 | The old `vicinity_launchpad` | **Leave it deployed; make the Squads vault its admin, pause its launches and disable its configs before the first approval here, and keep it paused under the vault** (approvals and launches here require all of it, 8.5) | Keep both open; or close the old program once paused | Keeping both open is not possible with this program (approvals and launches refuse while the old one is open or administered by another key). Closing it makes unpausing impossible, but freezes its admin field: a later hand-over of this program's admin would then stop approvals and launches here until an upgrade; and an old `Approval` still open at the close can never be revoked, so its city is refused here for ever: every one is revoked first (8.5, review OPS-4) |
| O20 | Anti-sniper launch fee | **None** (flat fee; the founder can buy atomically at launch) | A decaying first-minute fee | Breaks R2's "never above 2.5%"; needs an explicit owner exception |
| O21 | Donated lamports or coins | **Ignored forever** (not counted, not withdrawable) | A permissionless sweep of surplus into the buyback or holders bucket | Small extra surface |
| O22 | A lost founder key | **The share stays with that key** (no admin lever) | Admin reassignment | A money power for the admin |
| O23 | Aggregator and wallet visibility | **Ship the math crate, IDL, layout and this spec; ask Jupiter and the trading terminals to integrate after the audit; Jupiter adapter crate as a later step** (14.4); submit the program id, IDL and audit report to Blockaid, Blowfish and Phantom for allow-listing at mainnet launch (wallet warnings are expected until then; how long that takes is not proven) | Stay on Meteora | Keeps automatic routing but keeps Meteora's 0.5% and the other REPORT.md conflicts |
| O24 | Who runs the cranks | **Vicinity's fee-payer wallet, no tip** | A small tip from the bucket | A spam incentive and another money path |
| O25 | Residual multi-run buyback risk | **Accept and disclose**: a trader who buys while a public backlog above about 2.0% to 2.6% of depth exists (1.5% to 2.0% for a founder), and holds through at least 21 to 26 runs (16 to 21 for a founder) with no other trading, can profit (Theorem M_K). **With an honest trade inside the hold the figures are lower (review KR-1; the owner's sign-off is needed again for them):** with one buy at the clients' round-4 threshold inside, the founder profited after 8 runs of a backlog of 0.84% of depth and an outsider after 15 runs of 1.5% (on chain); the model's least hold is 13 runs for an outsider, 8 for the founder and 3 for a founder holding the float (a backlog of about that many caps). The SDK now counts every run the backlog pays for in the sandwich threshold, so its own trades inside such a hold leave every class at a loss; a trade from a client that allows more slippage than the SDK does not. Mitigated by the small step, V11, a keeper that spends every interval, an alert above two caps (0.2% of depth) and the backlog shown on the coin page; a halt of buybacks, the one time the keeper cannot run, is possible only while buys are halted, and buys reopen only after the keeper has spent the backlog (8.3, review LL-1). Not covered: the platform's key (`FEE_RECIPIENT`, credited `b_P`): alone under config #0 inside these figures (first profit at about 1.9% and 19 runs), but 1.34% and 14 runs under O1's alternative or with a founder seat held by the owner; kept out by the operating rule of 8.4 (7.3, review HR-1) | Execute buybacks inside trades (no backlog at all) | Contradicts R7's "executed separately" and R5's distinction; not offered |
| O26 | Holders' money of a coin whose rewards config was created wrong (it can never be fixed in `vicinity_rewards`) | **Waits in `holders_pending` until a program upgrade**; the SDK simulates and checks every config before proposing it | A permissionless fallback that, after a long delay (for example 90 days with no valid config), routes `holders_pending` into the buyback bucket | Changes the split for that coin; needs owner approval and audit |
| O27 | Who may be the holders' root publisher | **Only the admin** (`CityConfig.authority == launchpad.admin`) | A separate `Launchpad.rewards_authority` (for example a rewards multisig without the time lock, so rounds are not delayed), changeable only by a listed two-step admin power | Faster reward rounds under the time lock; one more key and power to list and audit |
| O28 | The metadata JSON served by the website | **Hash approved by the admin, stored and emitted; served write-once; image content-addressed** | State the residual risk only | Simpler, but the coin's displayed identity could then change silently |
| O29 | The platform's key in the MEV rules (review HR-1) | **Not counted by V8 and V11; the operating rule of 8.4 keeps `FEE_RECIPIENT` and the owner's wallets out of city coins and founder seats** (config #0 alone stays inside O25's founder envelope) | (a) Count `b_P` in V8 (`m = max(b_F, b_H, b_P)`) and give the platform a horizon of its own in V11 (config #0's analytic form allows `K_P` = 13); or (b) keep `b_P <= m` in every config (a lower platform share, or a matching founder or holders share) | (a) refuses configs such as (0, 120, 0, 1, 1) and changes which future configs pass (config #0 passes V8 with 70 but would fail V11's credited inequality at `K_F` = 15, so the platform needs its own `K_P`); a crate, model and vector change before the audit. (b) changes the fee shares. Either is an owner decision on the fee split; nothing is changed until the owner decides |

The decisions the owner should see first: **O3** (the 9.1 coins), **O11** (the time lock and
what it delays in the existing programs), **O25** (the residual multi-run buyback risk, with
the lower figures of review KR-1 when an honest trade sits inside the hold), **O2** (the never-graduating coins' liquidity), **O7** (no fee on the buyback), **O29** (the
platform's key in the MEV rules, and the operating rule that stands in for it), and **O10 /
O23** (native SOL confirmation and visibility on Jupiter and wallets: until each integrates the
new program, these coins trade only on vicinity.city and through direct program calls).

---

## 14. What changes for the website and for aggregators

### 14.1 Website

* **New SDK module** (`sdk/curve/`, JavaScript with BigInt; NOTES 28): a port of the math crate with
  golden vectors from the Rust crate (G01); account decoders for `Launchpad`,
  `LaunchConfig`, `Approval`, `CurveCoin`, `TickerLock`, `PayoutOptIn`, each checking the
  program owner as well as the discriminator; instruction builders for all 21 instructions;
  PDA helpers (`coin`, `mint`, `coin_vault`, `ticker`, `config`, `approval`, `payout_opt_in`,
  event authority, the old program's `coin`, `approval` and `launchpad`).
* **Approvals**: the admin page prepares an `approve_launch` proposal for the Squads vault,
  including the SHA-256 of the coin's metadata JSON; members approve in Squads. The site never
  holds the admin key.
* **Launch**: the founder clicks Launch: one transaction `[ComputeBudget(400,000, or 1.2 x the
  simulated figure), launch, create founder token account (idempotent), buy]` built with the
  address lookup table of 11.3 (or the buy right after). The mint is a PDA, so no keypair is
  generated on the site.
* **After launch**: a Squads proposal for `vicinity_rewards.init_city` (model Holders,
  `founder_bps = 0`, reward mint WSOL, authority the `vicinity_curve` admin, i.e. the Squads
  vault), built by the existing `initRewardsForCoin` helper, which first simulates the
  proposal and runs `check_rewards_config` and the authority rule on the resulting account
  bytes (4.15; a wrong config can never be fixed). Lamports someone sent to the config address
  do not stop it, and an existing config whose only problem is its authority is reported as
  fixable (`propose_authority` / `accept_authority`).
* **Trading on vicinity.city**: quote from the `Coin` account with the JS math port; buy
  transaction `[ComputeBudget, create the buyer's token account (idempotent), buy]` paid from
  native SOL (no wrap or unwrap needed); sell mirrors it and the SOL arrives natively. Near
  graduation, size the buy with `max_quote_in` and show "fills the curve; you pay X". Default
  slippage 1% for a buy or a sell at or below the coin's sandwich threshold (5.15; the SDK's
  `sandwichThreshold`, 1.3% of the depth of the market the trade can run in under config #0
  with at most one cap of buyback backlog, 0.39 SOL on a fresh coin, lower for each further
  cap) and 0.3% above it, where the SDK refuses more; at or below it the most a trade may allow
  shrinks as its size nears the threshold (`floor(2D * (threshold - V) / depth')`, from about
  2.6% for the smallest trades to 0.3%; review MV-1: trades sharing a block are sandwiched
  together), and the default is that maximum when it is below 1% (`buyLeg`, `sellLeg`,
  `buySlippagePolicy`, `sellSlippagePolicy`). When the trade is above the threshold or its size
  limits its slippage, the trade panel says that a larger slippage would be taken by a
  sandwich, that splitting the trade does not help (an attacker can hold his position across
  transactions, review R4-DIFF-2) and that a protected submission path is the way for large
  trades (reviews MATH3-1, R4-DIFF-5). A schedule that splits an order builds each piece with
  the order's total and its start (`orderSolIn` or `orderGross`, and `order`; review R5-DIFF-1)
  and stops when the SDK refuses a piece. The buy
  panel shows the one-time token-account rent of a first buy. Pay with any token: the
  existing Jupiter composer swaps to native SOL (`outputMint` the native mint, unwrapped with
  `wrapAndUnwrapSol`; the SDK refuses any other output, review SDK4-5) and appends our buy
  in the same transaction, which works before Jupiter integrates us; it requests an
  **ExactOut** quote for `sol_in` (or sets `sol_in` to the quote's `otherAmountThreshold`,
  its minimum output), so a swap that under-delivers can never make the buy spend SOL the
  user already had (G03). The buy leg carries its own `min_tokens_out`: the quote of that
  `sol_in` on the coin, less the slippage. The swap's minimum says nothing about the curve's
  price, and a buy without a minimum can be sandwiched (a 5 SOL buy into a fresh coin lost 68% of
  its coins in review CLI-1), so the SDK's `buyWithSwap` refuses to build one without it. A buy
  that completes the curve offers only `max_quote_in` (the quote's charge, at least
  `MIN_TRADE_LAMPORTS`), whatever the swap delivers; the rest stays in the wallet (5.4,
  reviews R3-CLI-1, R4-DIFF-1). The SDK's `buyLeg` does both for the direct buy too.
* **Crank** (server; fee-payer-only key with no authority): per coin, `buyback_burn` every
  interval while `buyback_pending > 0` (a missed interval grows the backlog, 7.3); an alert
  when `buyback_pending` exceeds two caps (0.2% of depth, 7.2, review KR-1); `forward_holders_fees` followed by a top-level
  `SyncNative(rewards_vault)` in the same transaction when `holders_pending` exceeds a
  threshold (for example 0.05 SOL); `withdraw_platform_fees` daily; after any change of the
  rent rate, a top-up of every `Coin` by `liabilities + rent_min(693) - lamports` when positive
  (the SDK's `coinRentTopUp`; 6.5, T63, review OPS-2). All no-ops
  are cheap and batchable; a halt is an error the keeper skips. A halt of buys alone does not
  stop the buybacks, and the keeper keeps running them. After a halt of buybacks (8.3, review
  LL-1), once the admin resumes them with buys still halted, the keeper runs every coin each
  interval until its backlog is at most one cap, and the site publishes each coin's backlog and
  depth before the proposal that reopens buys.
* **Reward rounds**: the funding transaction starts with `SyncNative(vault)`, then
  `fund_epoch_from_vault`; the snapshot file and its hash are published before the Squads
  proposal, and a second person recomputes the root before members sign (8.1).
* **Displays (R5)**: per coin from the counters of 3.7 (earned, waiting, paid per bucket;
  liquidity added and set aside; burned by buybacks = `tokens_burned`, burned at launch =
  `dust_burned`, total burned = `COIN_SUPPLY - mint.supply`; supply = `mint.supply`;
  graduation progress = `curve_sol / graduation_sol`; price = virtual SOL / virtual tokens;
  market cap = price x supply; the buyback backlog and the depth). Fee labels from the coin's
  own snapshot (6.6), never hard-coded (REPORT.md item 13 lists the hard-coded 1.25% places to
  replace). Global totals by summing coins.
* **Founder dashboard**: `founder_pending` with a claim button (native SOL; no unwrap step),
  lifetime earned, claimed and paid out.
* **Market backend and charts**: decode each confirmed transaction with the acceptance rule of
  4.21 (the SDK's `decodeTransactionEvents`: nothing from a failed transaction, event CPIs only
  under a `vicinity_curve` call with the event authority as their only account), at
  `finalized` or re-checked there; `trade_seq` is gap-free per coin among successful
  transactions, so missed events are detectable; reconcile each coin's events with
  `Coin.trade_seq` and the counters, never keeping the first event seen for a `trade_seq`
  (review CLI-2).
* **Official list** (`/official-coins.csv`): from accounts owned by `vicinity_curve` with the
  `CurveCoin` discriminator (filtered by program owner, never by bytes alone) and the old
  program's `Coin` accounts (none on mainnet), for the Jupiter tag and trackers.
* **Metadata JSON**: served write-once at `METADATA_URI_PREFIX + mint + ".json"`, its SHA-256
  equal to `Coin.meta_hash`, its image URL content-addressed (3.10).
* **Old launch path**: hidden once the old program's launches are paused (8.5).
* **Honest copy**: the round trip costs about 4.9%; within the program no admin can move
  money, and the same Squads multisig can upgrade the program after a 48-hour delay and
  publishes the holder reward rounds (8.1, 8.4); a guardian can stop buys but never exits;
  pools that others create do not pay Vicinity's fee; until aggregators integrate, other apps
  will not route these coins.

### 14.2 `vicinity_rewards` (unchanged)

`forward_holders_fees` credits native SOL to the city's WSOL vault `["vault", config]` under
`["city", mint]` after checking that the config pays holders only and that its authority is
the `vicinity_curve` admin with no transfer pending; a separate `SyncNative` makes the vault's
token amount include it. Then, as today: random balance samples, a time-weighted snapshot, a
Merkle root published by the rewards authority with `fund_epoch_from_vault`, holders claim;
rounds only when at least 20 holders get 0.01 SOL. The coin's vault and `Coin` account are
owned by program addresses, which the existing "no program addresses" snapshot rule already
excludes. Under the time lock (O11) each round's proposal waits 48 hours.

### 14.3 Aggregators, wallets and terminals: what the program offers

| integrator need | what `vicinity_curve` provides |
|---|---|
| one account per market to watch | the `Coin` account holds phase, reserves, fees and curve terms; no vault balance is read |
| fixed accounts | `buy` and `sell`: the same 10 accounts in the same order before and after graduation; no remaining accounts; no optional accounts |
| deterministic quotes without RPC calls | `vicinity-curve-math` (`no_std`, integer only); the program runs the very same functions |
| CPI from a router | the user is the only signer; the destination token account of a buy may be any account of the mint not owned by the `Coin` PDA; no instruction-sysvar or call-stack checks. **Conditions**: `user` must be a system-owned account without data (the system transfer of a buy requires it, so a router PDA that carries data cannot buy); SOL paid to an account holding 0 lamports must be at least the rent-exempt minimum of an empty account (650,240 lamports at today's mainnet rate), or the runtime refuses the transaction. A buyer may also end the transaction with 0 lamports or with at least that minimum, never with anything in between (the same rule: a rent-exempt wallet may not become rent-paying, judged on the balance at the end of the transaction; NOTES 36). The SDK and the adapter pre-check all three (`precheckBuyer`, `precheckBuy`, `precheckSolCredit`: `lamports(user) > 0` or `out >= rent_min(0)`) and return a clear error. Tested by G02 and `tests-curve/21-sdk-prechecks` |
| slippage | `min_tokens_out`, `min_sol_out`; a client's slippage depends on the trade's size (5.15: at most 0.3% above the coin's sandwich threshold, which counts every buyback run the backlog pays for, and below it at most `floor(2D * (threshold - V) / depth')`, since trades sharing a block are sandwiched together; buys and sells; the pieces of a split order anchored to its start) |
| trade data | `Trade` event by self-CPI with amounts, the five fee shares, drip and reserves after |
| lifecycle | `CoinLaunched`, `Graduated`, `phase`; progress = `curve_sol / graduation_sol`; `buys_halted` (and `buybacks_halted`) in `Launchpad` |
| decoding | no on-chain Anchor IDL account (`no-idl`); the IDL JSON from the verified build, the repository and the Solana Program Metadata program (written by the upgrade authority); fixed offsets in 3.7; `decode_coin(owner, data)` in the crate; discriminators `sha256("global:buy")[..8]`, `sha256("global:sell")[..8]`, account `sha256("account:CurveCoin")[..8]` |
| trust | open source, verified build, outside audit, official coin list from `Coin` accounts; Blockaid, Blowfish and Phantom allow-listing requested at mainnet launch (until then wallets may show simulation warnings on every buy and sell, including on vicinity.city) |

**Native SOL.** Buyers pay from their system account and sellers receive into it, as on
pump.fun's curve. A router that holds WSOL must unwrap before a buy and wrap after a sell, and
a router that CPIs with its own PDA as `user` must re-wrap the SOL it receives. **Not proven**:
that Jupiter and the terminals (Axiom, GMGN and FOMO build their own instructions) route such a
hop; revision 1 said "Jupiter already does this for pump.fun-style native-SOL curves" without a
source. Written confirmation is required before the audit freeze; if any of them needs WSOL,
take O10 then.

**Partial fill.** Only the buy that completes the curve can use less than `sol_in`; the quote
reports `charged`, `partial` and `graduates`. A router must cap its input at `max_quote_in`
(the quote's `charged`, at least `MIN_TRADE_LAMPORTS`: within about 97,500 lamports of
graduation a buy of `MIN_TRADE_LAMPORTS` is itself a partial fill of the last raw units, 5.4)
and take its minimum from that same quote. Offering more with the
partial quote's minimum is unsafe: if another buy graduates the coin first, the same
instruction runs in the pool, is charged all of `sol_in` and still clears the minimum, so the
minimum no longer limits the price (5.4, T79, review R3-CLI-1).

### 14.4 Jupiter adapter (a later step)

A crate `vicinity-curve-jupiter` implementing `jupiter_amm_interface::Amm` over the math crate
(check the trait's current version when building it):
* `from_keyed_account`: `decode_coin(owner, data)`; `key` = the `Coin` address;
  `program_id` = `vicinity_curve`; `label` = "Vicinity".
* `get_reserve_mints` = `[NATIVE_MINT, coin.mint]`; `get_accounts_to_update` =
  `[coin, launchpad]`; `update` re-decodes them (`buys_halted` makes buys inactive).
* `quote`: SOL in to `quote_buy`, coin in to `quote_sell`; `in_amount` = `charged` (smaller
  than requested only on the graduating buy, or an error for amounts beyond the curve if
  Jupiter prefers; one flag), `out_amount`, `fee_amount` (SOL), `fee_mint` = WSOL, `fee_pct`
  = the coin's `total_fee_bps`.
* `get_swap_and_account_metas`: the 10 metas of 4.11, mapping the router's destination token
  account onto `user_token_account`; native SOL handled by the router around the hop (to be
  confirmed with Jupiter, 14.3).
* `supports_exact_out = false`, `is_active = !buys_halted` for buys (sells are always active),
  `has_dynamic_accounts = false`.

Jupiter's listing requirements and lead time are not known here (not proven). The same
integration package (program id, IDL, layout, progress formula, `Graduated`, builders) is what
Axiom, GMGN, Photon, FOMO, DexScreener, Birdeye and Codex need. Phantom shows the coin from
its Metaplex metadata (classic SPL, no freeze, no mint authority), swaps it once Jupiter routes
it, and may show transaction-simulation warnings for a new program until Blockaid and Blowfish
allow-list it (O23).

### 14.5 What users will notice compared with Meteora (plainly)

* Coins do not appear automatically on Jupiter, FOMO, Axiom, GMGN, DexScreener, Birdeye or in
  Phantom's swap until each integrates `vicinity_curve` (O23); wallets may warn on our
  transactions until the program is allow-listed.
* No Meteora fee, no 0.2% migration fee, no Meteora share of the launch fee, no referral
  account: all of the fee stays within the five buckets.
* Graduation is instant and keeper-free; the pool is the same account; the coin's price and
  trade instruction do not change at graduation.
* Buyback and burn becomes real and on chain, with a burned-coins counter.
* **Economic risk the owner should see**: anyone can open a third-party pool for this classic
  SPL coin with a 0.01% to 0.3% fee; once it has depth, routers will prefer it. Those trades
  pay no Vicinity fee, and arbitrage links its price to ours only when they differ by more than
  2.5% plus that pool's fee, so buybacks and liquidity injections do not carry over to it. The
  founder, holder and buyback streams then shrink. The program cannot enforce R2 there.

---

## Appendix A. Reference model and checks (Python 3, exact integers)

Every number in sections 5 and 7 comes from these two files. They mirror the math crate and
are meant for auditors and for generating golden vectors. Save them as `model.py` and
`checks.py` in one directory and run `python3 checks.py` (about 5 seconds).

`model.py`:

```python
# Reference model of VICINITY-CURVE-DESIGN.md sections 5 to 7 (exact integers).
D = 10_000
SUPPLY = 10**15
MIN_TRADE = 100_000
MAX_DUST = 10**9
U64 = (1 << 64) - 1
U128 = (1 << 128) - 1
INTERVAL = 150
CAP_DIV = 25                 # BUYBACK_CAP_DIVISOR: a run spends at most depth*t/(25*D)
K_MIN, K_MIN_F = 20, 15      # V11 horizons (any trader / founder-credited)

def cdiv(a, b):
    assert a >= 0 and b > 0
    return -(-a // b)

def chk(*v):
    for x in v:
        assert 0 <= x <= U128, x

class Cfg:
    def __init__(s, x0, y0, S, P, R, bps=(50, 70, 50, 50, 30), validate=True):
        s.x0, s.y0, s.S, s.P, s.R = x0, y0, S, P, R
        s.bps = bps
        s.liq, s.plat, s.fdr, s.hld, s.bb = bps
        s.t = sum(bps)
        s.dust = SUPPLY - S - P
        if validate:
            v = rules(s)
            assert v is None, v
    def f(s, k):
        chk(s.x0 * k)
        return cdiv(s.x0 * k, s.y0 - k)
    def tokens_for(s, q):
        chk(q * s.y0)
        return (q * s.y0) // (s.x0 + q)

def rules(c):
    """validate_config V1 to V11 (V9, the launch fee cap, is not modelled). Returns the first failing rule."""
    L, Pl, F, H, B = c.bps; t = c.t; C = CAP_DIV
    if not (1 <= t <= 250): return 'V1'
    if Pl > 120 or F > 100 or t - F - H < 1: return 'V2'   # V2b: the credited shares leave 1 bp
    if not (c.S >= 1 and c.P >= 1 and c.S + c.P <= SUPPLY and SUPPLY - c.S - c.P <= MAX_DUST): return 'V3'
    if not (1 <= c.x0 <= 2**60 and c.S < c.y0 <= 2**60 and c.x0 * t >= C * D
            and c.R * c.P * t >= C * D * SUPPLY): return 'V4'
    if not (10**9 <= c.R <= 10**13 and cdiv(c.x0 * c.S, c.y0 - c.S) == c.R
            and cdiv(c.x0 * (c.S - 1), c.y0 - c.S + 1) <= c.R - 1): return 'V5'
    if c.x0 * c.y0 > (c.y0 - c.S) ** 2: return 'V6'
    g = (c.x0 + c.R) * c.P - c.R * (c.y0 - c.S)
    if not (0 <= g <= (c.x0 + c.R) * c.P // 10**9): return 'V7'
    m = max(F, H)
    if B > 0 and 100 * ((C * D + t) ** 2 * (D - t + 2 * L + m) * (D - t + 2 * L) + m * D * (C * D) ** 2) \
            > 99 * (C * D) ** 2 * D ** 2: return 'V8'
    if not (L == 0 or L < Pl): return 'V10'
    if B > 0 and not (C * (D - t) * (D - t + 2 * L) <= D * (C * D - 2 * (K_MIN - 1) * t)
                      and C * (D - t + 2 * L) * (D - t + m) <= (D - m) * (C * D - 2 * (K_MIN_F - 1) * t)): return 'V11'
    return None

def split(c, A):
    chk(A * c.t)
    fee = A * c.t // D                                    # rounded DOWN: never above t/D
    p, fo, h, b = A * c.plat // D, A * c.fdr // D, A * c.hld // D, A * c.bb // D
    l = fee - p - fo - h - b                              # liquidity = remainder
    lo = A * c.liq // D
    assert lo <= l <= lo + 4 and fee * D <= A * c.t, (A, l, lo)
    return dict(fee=fee, liq=l, liq_floor=lo, plat=p, fdr=fo, hld=h, bb=b)

def gross_for(c, net):
    """Least G with G - floor(G*t/D) == net (net >= 1): Lemma G."""
    assert net >= 1
    return ((net - 1) * D) // (D - c.t) + 1

class Coin:
    def __init__(s, c, slot=0):
        s.c = c; s.phase = 0; s.s = 0; s.r = 0; s.X = 0; s.Y = 0; s.L = 0
        s.pend = dict(plat=0, fdr=0, hld=0, bb=0)
        s.earned = dict(liq=0, plat=0, fdr=0, hld=0, bb=0)
        s.out = dict(liq_added=0, plat=0, fdr=0, hld=0, bb=0)
        s.fees_total = 0; s.burned = 0; s.lam = 0
        s.vault = c.S + c.P; s.supply = SUPPLY - c.dust; s.last_bb = slot; s.slot = slot
    def reserve(s): return s.r if s.phase == 0 else s.X
    def depth(s): return s.c.x0 + s.r if s.phase == 0 else s.X
    def virt(s): return (s.c.x0 + s.r, s.c.y0 - s.s) if s.phase == 0 else (s.X, s.Y)
    def book(s, sp):
        for k in ('plat', 'fdr', 'hld', 'bb'):
            s.pend[k] += sp[k]; s.earned[k] += sp[k]
        s.earned['liq'] += sp['liq']; s.fees_total += sp['fee']
        drip = 0
        if s.phase == 1:
            drip = min(s.L, sp['liq_floor'])               # never the rounding remainder
            s.X += sp['liq'] + drip; s.L -= drip; s.out['liq_added'] += sp['liq'] + drip
        else:
            s.L += sp['liq']
        return drip
    def max_quote_in(s):
        assert s.phase == 0
        return max(MIN_TRADE, gross_for(s.c, s.c.R - s.r))
    def quote_buy(s, G):
        c = s.c
        if G < MIN_TRADE: raise ValueError('TradeTooSmall')
        n = G - G * c.t // D
        if s.phase == 0:
            rem = c.R - s.r
            assert rem >= 1                                 # V5b: r <= f(S-1) <= R-1
            if n >= rem: s2, cc, grad = c.S, rem, True
            else:
                s2 = c.tokens_for(s.r + n); cc = c.f(s2) - s.r; grad = False
                assert cc == n                              # Lemma C3: no dust
            charged = G if cc == n else gross_for(c, cc)
            tok = s2 - s.s
        else:
            chk(s.Y * n)
            cc, charged, tok, grad, s2 = n, G, (s.Y * n) // (s.X + n), False, None
        sp = split(c, charged)
        assert charged - sp['fee'] == cc and charged <= G and cc >= 1
        return dict(charged=charged, net=cc, tokens=tok, grad=grad, s2=s2, partial=charged < G, **sp)
    def buy(s, G, minout=0):
        q = s.quote_buy(G)
        if q['tokens'] < 1: raise ValueError('ZeroOutput')
        if q['tokens'] < minout: raise ValueError('Slippage')
        c = s.c
        if s.phase == 0:
            s.s = q['s2']; s.r += q['net']; assert s.r == c.f(s.s)
        else:
            k0 = s.X * s.Y
            s.X += q['net']; s.Y -= q['tokens']; assert s.Y >= 1 and s.X * s.Y >= k0
        s.vault -= q['tokens']; s.lam += q['charged']
        q['drip'] = s.book(q)
        if q['grad']:
            assert s.s == c.S and s.r == c.R
            s.phase = 1; s.X = c.R; s.Y = c.P
            assert s.vault == c.P
        return q
    def quote_sell(s, t):
        c = s.c
        if t < 1: raise ValueError('ZeroAmount')
        if s.phase == 0:
            if t > s.s: raise ValueError('SellExceedsCurve')
            s2 = s.s - t; gross = s.r - c.f(s2)
        else:
            chk(s.X * t); s2 = None; gross = (s.X * t) // (s.Y + t)
        sp = split(c, gross); out = gross - sp['fee']
        return dict(gross=gross, out=out, s2=s2, **sp)
    def sell(s, t, minout=0):
        q = s.quote_sell(t)
        if q['out'] < 1: raise ValueError('ZeroOutput')
        if q['out'] < minout: raise ValueError('Slippage')
        c = s.c
        if s.phase == 0:
            s.s = q['s2']; s.r = c.f(s.s)
        else:
            k0 = s.X * s.Y
            s.X -= q['gross']; s.Y += t; assert s.X >= 1 and s.X * s.Y >= k0
        s.vault += t; s.lam -= q['out']
        q['drip'] = s.book(q)
        return q
    def cap(s):
        chk(s.depth() * s.c.t)
        return s.depth() * s.c.t // (CAP_DIV * D)
    def buyback(s):
        c = s.c
        if s.pend['bb'] == 0 or s.slot < s.last_bb + INTERVAL: return None
        cap = s.cap()
        b = min(s.pend['bb'], cap)
        if b == 0: return None
        if s.phase == 0:
            s2 = min(c.tokens_for(s.r + b), c.S - 1)
            spent = c.f(s2) - s.r; coins = s2 - s.s
            if coins == 0 or spent == 0: return None
            s.s = s2; s.r = c.f(s2)
        else:
            chk(s.Y * b)
            coins = (s.Y * b) // (s.X + b); spent = b
            if coins == 0: return None
            k0 = s.X * s.Y; s.X += b; s.Y -= coins; assert s.X * s.Y >= k0
        assert spent <= b <= s.pend['bb']
        s.pend['bb'] -= spent; s.out['bb'] += spent; s.burned += coins
        s.vault -= coins; s.supply -= coins; s.last_bb = s.slot
        return dict(spent=spent, coins=coins, cap=cap)
    def pay(s, k):
        a = s.pend[k]; s.pend[k] = 0; s.out[k] += a; s.lam -= a; return a
    def check(s):
        c = s.c
        assert s.lam == s.reserve() + s.L + sum(s.pend.values())
        if s.phase == 0:
            assert s.r == c.f(s.s) and 0 <= s.s < c.S and s.r <= c.R - 1 and s.X == 0 and s.Y == 0
            assert s.vault == c.S - s.s + c.P
        else:
            assert s.vault == s.Y and s.X >= 1 and s.Y >= 1 and s.s == c.S
        assert s.supply == SUPPLY - c.dust - s.burned
        for k in ('plat', 'fdr', 'hld', 'bb'):
            assert s.pend[k] == s.earned[k] - s.out[k]
        assert s.L == s.earned['liq'] - s.out['liq_added']
        assert s.fees_total == sum(s.earned.values())
        for v in (s.s, s.r, s.X, s.Y, s.L, s.lam, *s.pend.values()):
            assert 0 <= v <= U64

S = 793_099_990_000_000
P = 206_900_000_900_000                    # R8: 206,900,000.9 coins; 9.1 coins burned at launch
R = 85_000_000_000
DEFAULT = Cfg(30_000_853_639, 1_073_025_598_486_615, S, P, R)
```

`checks.py`:

```python
# Checks behind VICINITY-CURVE-DESIGN.md sections 5, 7 and 12 (run: python3 checks.py)
import copy, math, random
from fractions import Fraction as Fr
import model
from model import *

c = DEFAULT
d = c.y0 - c.S
assert rules(c) is None                                            # V1 to V11 (V9 not modelled)
assert (c.R - 1) * d < c.x0 * c.S <= c.R * d                       # f(S) = R exactly
assert c.f(c.S - 1) == c.R - 1                                     # V5b
gap = (c.x0 + c.R) * c.P - c.R * d
print("continuity gap", gap, float(Fr(gap, (c.x0 + c.R) * c.P)), "absorption", float(Fr(d * d, c.x0 * c.y0)))
t, C = c.t, CAP_DIV
m_ = max(c.fdr, c.hld); L_ = c.liq
v8l = 100 * ((C * D + t) ** 2 * (D - t + 2 * L_ + m_) * (D - t + 2 * L_) + m_ * D * (C * D) ** 2); v8r = 99 * (C * D) ** 2 * D ** 2
print("V8", v8l, v8r, "bound %.5f" % (float(Fr(v8l, v8r)) * 0.99))
print("V11", C * (D - t) * (D - t + 2 * L_), D * (C * D - 38 * t), C * (D - t + 2 * L_) * (D - t + m_), (D - m_) * (C * D - 28 * t))

# Lemma G (gross-up) and Lemma F (split) exhaustively on small values
for tt in (1, 37, 249, 250):
    for cc in range(1, 200_000):
        G = ((cc - 1) * D) // (D - tt) + 1
        assert G - G * tt // D == cc and (G - 1) - (G - 1) * tt // D == cc - 1
for tt in range(1, 251):
    for cc in range(1, 2_000):
        G = ((cc - 1) * D) // (D - tt) + 1
        assert G - G * tt // D == cc and (G - 1) - (G - 1) * tt // D == cc - 1
first4 = None
for A in range(1, 1_000_000):
    sp = split(c, A)
    if first4 is None and sp['liq'] - sp['liq_floor'] == 4: first4 = A
rng = random.Random(1)
for _ in range(100_000): split(c, rng.randrange(1 << 64))
print("split remainder bound 4 first reached at A =", first4)

def ex(label, q, keys):
    print(label, {k: q[k] for k in keys})
B = ('charged', 'net', 'tokens', 'fee', 'liq', 'plat', 'fdr', 'hld', 'bb')
Sl = ('gross', 'out', 'fee', 'liq', 'plat', 'fdr', 'hld', 'bb')
m = Coin(c); ex("E1", m.buy(10**9), B); m.check(); print("   virtual", m.virt())
ex("E2", m.sell(m.s), Sl); m.check(); assert m.s == 0 and m.r == 0; print("   L", m.L, m.pend)
m = Coin(c); ex("E3", m.buy(100 * 10**9), B + ('grad', 'partial')); m.check(); print("   pool", m.X, m.Y, m.L)
q4 = m.buy(10**9); ex("E4", q4, B + ('drip',)); m.check(); print("   pool", m.X, m.Y, m.L)
ex("E5", m.sell(q4['tokens']), Sl + ('drip',)); m.check(); print("   pool", m.X, m.Y, m.L)
m = Coin(c); m.buy(gross_for(c, 84_500_000_000)); print("E6 setup", gross_for(c, 84_500_000_000), m.s, m.r, "max_quote_in", m.max_quote_in())
ex("E6", m.buy(10**9), B + ('grad', 'partial')); m.check()
m = Coin(c, slot=0); m.buy(100 * 10**9); m.slot = 150; print("E7", m.buyback(), m.X, m.Y, m.supply, m.pend['bb']); m.check()
m = Coin(c, slot=0); q = m.buy(10 * 10**9); m.slot = 150; print("E8", q['tokens'], m.depth(), m.buyback(), m.s, m.r); m.check()
ex("E9", Coin(c).quote_buy(MIN_TRADE), B)
m = Coin(c); m.buy(gross_for(c, c.f(c.S - 1))); assert m.r == c.R - 1
q = m.quote_buy(10**10); print("rem=1 graduating buy", q['charged'], q['fee'], q['tokens'], q['grad'])
m2 = copy.deepcopy(m); m2.s = c.tokens_for(c.R - 2) + 1; m2.pend['bb'] = m2.earned['bb'] = 10**9; m2.lam += 10**9; m2.fees_total += 10**9; m2.slot = 10**6
assert m2.s < c.S - 1 and c.f(m2.s) == c.R - 1 and m2.buyback() is None    # I22: no-op when curve_sol == f(S-1)
print("last flat step below S-1:", c.S - 1 - m2.s, "raw units; buyback there is a no-op")
assert rules(Cfg(c.x0, c.y0, c.S, c.P, c.R, bps=(50, 0, 170, 0, 30), validate=False)) == 'V2'
m = Coin(c); m.buy(100 * 10**9); print("1 SOL just after graduation", m.quote_buy(10**9)['tokens'])
print("caps: launch", Coin(c).cap(), "end of curve", (c.x0 + c.R) * t // (C * D), "pool open", c.R * t // (C * D),
      "pool minimum", (c.R * c.P // SUPPLY) * t // (C * D))

# Buyback sandwiches (one run between the legs): canonical scan, random multi-leg, founder credited
def state(cfg, kind, amount, backlog=10**15):
    m = Coin(cfg, slot=0)
    if kind == 'curve':
        if amount: m.buy(gross_for(cfg, amount))
    else:
        m.buy(100 * 10**9); m.L += amount; m.lam += amount; m.earned['liq'] += amount; m.fees_total += amount
    m.pend['bb'] += backlog; m.earned['bb'] += backlog; m.lam += backlog; m.fees_total += backlog
    m.slot = 10**6
    return m
def sandwich(m0, a, legs_b, legs_s, rng, credit=()):
    m = copy.deepcopy(m0); paid = got = coins = 0; snap = dict(m.pend)
    cuts = sorted(rng.randint(MIN_TRADE, a) for _ in range(legs_b - 1))
    for p in [y - x for x, y in zip([0] + cuts, cuts + [a])]:
        if p >= MIN_TRADE:
            q = m.buy(p); paid += q['charged']; coins += q['tokens']
    if m.buyback() is None: return None
    left = coins
    for i in range(legs_s - 1):
        tk = rng.randint(1, left)
        try: q = m.sell(tk); got += q['out']; left -= tk
        except ValueError: pass
        if left == 0: break
    if left: got += m.sell(left)['out']
    m.check()
    got += sum(m.pend[k] - snap[k] for k in credit)
    return Fr(got - paid, paid)
kinds = [('curve', 0), ('curve', 10 * 10**9), ('curve', 40 * 10**9), ('curve', 80 * 10**9),
         ('pool', 0), ('pool', 10 * 10**9), ('pool', 200 * 10**9)]
def scan(cfg, credit, n_multi, seed):
    rng = random.Random(seed)
    b1 = max(sandwich(state(cfg, *k), int(10**6 * 1.5**i), 1, 1, rng, credit) for k in kinds for i in range(40))
    bm = max(r for k in kinds for _ in range(n_multi)
             for r in [sandwich(state(cfg, *k), int(10**rng.uniform(5.5, 12.3)), rng.randint(1, 6), rng.randint(1, 6), rng, credit)] if r is not None)
    return b1, bm
for credit in [(), ('fdr',), ('fdr', 'hld')]:
    b1, bm = scan(c, credit, 300, 7)
    print("sandwich credited %-14s canonical %.4f%%, multi-leg %.4f%%" % (credit, 100 * b1, 100 * bm))
    assert b1 < 0 and bm < 0

# Where single-run profit would start (step varied; curve; small to large attackers)
real_cap = Coin.cap
for bps in [10, 50, 100, 150, 200, 250, 260, 300]:
    Coin.cap = lambda s, bps=bps: s.depth() * bps // D
    rng = random.Random(3)
    best = max(sandwich(state(c, 'curve', k), int(10**6 * 1.5**i), 1, 1, rng) for k in (0, 40 * 10**9) for i in range(40))
    print("step %d bps: best canonical (curve) %+.2f%%" % (bps, 100 * best))
Coin.cap = real_cap

# Hold-through (Theorem M_K): buy, K buyback runs with no other trade, sell
f_, l_ = Fr(c.t, D), Fr(c.liq, D)
def hold(m0, a, K, credit=()):
    m = copy.deepcopy(m0); snap = dict(m.pend)
    q = m.buy(a); coins, paid = q['tokens'], q['charged']; X1 = m.depth(); spent = runs = 0
    for _ in range(K):
        r = m.buyback()
        if r is None: break
        spent += r['spent']; runs += 1; m.slot += INTERVAL
    out = m.sell(coins)['out'] + sum(m.pend[k] - snap[k] for k in credit); m.check()
    return Fr(out - paid, paid), Fr(spent, X1), runs
ustar = {'curve': 1 / math.sqrt(float((1 - f_) ** 2)) - 1, 'pool': 1 / math.sqrt(float((1 - f_) * (1 - f_ + 2 * l_))) - 1}
print("break-even backlog/depth u*: curve %.4f%%, pool %.4f%%" % (100 * ustar['curve'], 100 * ustar['pool']))
for kind, raised in [('curve', 0), ('curve', 40 * 10**9), ('pool', 0)]:
    for a in (10**8, 10**10):
        row = []; kstar = None
        for K in range(1, 31):
            res, u, runs = hold(state(c, kind, raised), a, K)
            row.append(res)
            if kstar is None and res > 0: kstar = K
        print("M_K %s %g SOL raised, attacker %g SOL: K=1 %+.2f%% K=20 %+.2f%% K=30 %+.2f%%, first profit at K=%s" %
              (kind, raised / 1e9, a / 1e9, 100 * row[0], 100 * row[19], 100 * row[29], kstar))
for kind, raised in [('curve', 0), ('pool', 0)]:
    kstar = next(K for K in range(1, 61) if hold(state(c, kind, raised), 10**8, K, ('fdr',))[0] > 0)
    print("founder-credited first profit", kind, "K =", kstar)
# backlog sweep (P06b): total buyback_pending as a fraction of depth, up to 400 runs; profit only above u*
for kind, raised in [('curve', 0), ('curve', 40 * 10**9), ('pool', 0)]:
    m0 = state(c, kind, raised, 0); depth0 = m0.depth(); have = m0.pend['bb']; first_pos = None; last_neg = None
    for ub in [5, 10, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 50, 100]:      # in 0.1% of depth
        mb = state(c, kind, raised, max(0, depth0 * ub // 1000 - have))
        for a in (10**8, 10**9, 10**10):
            res, u, runs = hold(mb, a, 400)
            lim = (1 + u) ** 2 * (1 - f_) * (1 - f_ + (2 * l_ if kind == 'pool' else 0))
            assert res <= lim - 1 + Fr(1, 10**6), (kind, ub, a)
            if res > 0:
                assert float(u) > ustar[kind]
                if first_pos is None: first_pos = (ub / 10, a / 1e9, runs, round(float(100 * res), 3))
            elif first_pos is None: last_neg = (ub / 10, a / 1e9, round(float(100 * res), 3))
    print("backlog sweep", kind, raised / 1e9, "SOL raised: last loss", last_neg, "first profit (backlog % of depth, attacker SOL, runs, result %):", first_pos)

# Drip farming (7.5): attacker holds the float, credited the founder, holder and buyback shares
def farm(cfg, Lx, w, N, keys=('fdr', 'hld', 'bb')):
    m = Coin(cfg, slot=0); held = m.buy(100 * 10**9)['tokens']
    m.L += Lx; m.lam += Lx; m.earned['liq'] += Lx; m.fees_total += Lx
    base = copy.deepcopy(m); s0 = dict(base.pend); out0 = base.sell(held)['out'] + sum(base.pend[k] - s0[k] for k in keys)
    snap = dict(m.pend); cash = 0
    for _ in range(N):
        q = m.buy(w); cash -= q['charged']; cash += m.sell(q['tokens'])['out']
        if m.L == 0: break
    cash += m.sell(held)['out'] + sum(m.pend[k] - snap[k] for k in keys); m.check()
    return Fr(cash - out0, 10**9)
def best_farm(cfg):
    return max(farm(cfg, Lx, w, 300) for Lx in (0, 4 * 10**9, 20 * 10**9) for w in (10**8, 10**9, 10**10, 5 * 10**10))
mk = lambda bps: Cfg(c.x0, c.y0, c.S, c.P, c.R, bps=bps, validate=False)
for bps in [(50, 70, 50, 50, 30), (50, 51, 50, 50, 30), (50, 50, 50, 50, 30), (100, 50, 50, 50, 0), (250, 0, 0, 0, 0)]:
    cfg = mk(bps); print("drip farming", bps, "rule", rules(cfg), "best gain %.4f SOL" % float(best_farm(cfg)))
rng = random.Random(9); tested = 0; worst = None
while tested < 25:
    L = rng.randint(0, 120); Pl = rng.randint(0, 120); F = rng.randint(0, 120); H = rng.randint(0, 120); Bb = rng.randint(0, 60)
    cfg = mk((L, Pl, F, H, Bb))
    if rules(cfg) is not None: continue
    g = best_farm(cfg); tested += 1; worst = g if worst is None else max(worst, g)
    assert g < 0, (L, Pl, F, H, Bb, float(g))
print("drip farming, 25 random configs passing V1 to V11: best gain %.4f SOL" % float(worst))

# fuzz with invariants after every step, and round trips
rng = random.Random(2026); n = dict(buy=0, sell=0, bb=0, pay=0, grad=0)
for run in range(300):
    m = Coin(c, slot=0); held = [0] * 5
    for step in range(400):
        m.slot += rng.choice([0, 1, 10, 50, 200]); op = rng.random(); u = rng.randrange(5)
        try:
            if op < 0.45:
                q = m.buy(int(10**rng.uniform(5, 11.3))); held[u] += q['tokens']; n['buy'] += 1; n['grad'] += q['grad']
                assert q['grad'] or not q['partial']
            elif op < 0.8 and held[u]:
                tk = rng.randint(1, held[u]) if rng.random() < 0.7 else held[u]; m.sell(tk); held[u] -= tk; n['sell'] += 1
            elif op < 0.9:
                n['bb'] += m.buyback() is not None
            else:
                m.pay(rng.choice(['plat', 'fdr', 'hld'])); n['pay'] += 1
        except ValueError:
            pass
        m.check()
print("fuzz", n)
worst = -1
for i in range(20000):
    m = Coin(c, slot=0)
    try: m.buy(int(10**rng.uniform(5, 11.4)))
    except ValueError: pass
    if m.phase == 1:
        L = int(10**rng.uniform(6, 11)); m.L += L; m.lam += L; m.earned['liq'] += L; m.fees_total += L
    try: q = m.buy(int(10**rng.uniform(5, 12))); q2 = m.sell(q['tokens'])
    except ValueError: continue
    worst = max(worst, Fr(q2['out'] - q['charged'], q['charged']))
print("round trip least loss %.4f%%" % (-100 * worst)); assert worst < 0

# overflow: q * y0 in the buyback's tokens_for at x0 = y0 = 2^60, t = 250, R = 10^13
x0 = y0 = 2**60; Rm = 10**13
bmax = (x0 + Rm) * 250 // (CAP_DIV * D)
print("max q*y0 %.3e (u128 max %.3e)" % ((Rm + bmax) * y0, U128))
```

Output of the run used for this file (17 October 2026):

```
continuity gap 47593275100000 2.000248875247386e-12 absorption 2434.117657663355
V8 613813296968750000000 618750000000000000000 bound 0.98210
V11 2400937500 2405000000 2413250000 2417850000
split remainder bound 4 first reached at A = 560
E1 {'charged': 1000000000, 'net': 975000000, 'tokens': 33774693369781, 'fee': 25000000, 'liq': 5000000, 'plat': 7000000, 'fdr': 5000000, 'hld': 5000000, 'bb': 3000000}
   virtual (30975853639, 1039250905116834)
E2 {'gross': 975000000, 'out': 950625000, 'fee': 24375000, 'liq': 4875000, 'plat': 6825000, 'fdr': 4875000, 'hld': 4875000, 'bb': 2925000}
   L 9875000 {'plat': 13825000, 'fdr': 9875000, 'hld': 9875000, 'bb': 5925000}
E3 {'charged': 87179487179, 'net': 85000000000, 'tokens': 793099990000000, 'fee': 2179487179, 'liq': 435897438, 'plat': 610256410, 'fdr': 435897435, 'hld': 435897435, 'bb': 261538461, 'grad': True, 'partial': True}
   pool 85000000000 206900000900000 435897438
E4 {'charged': 1000000000, 'net': 975000000, 'tokens': 2346350693544, 'fee': 25000000, 'liq': 5000000, 'plat': 7000000, 'fdr': 5000000, 'hld': 5000000, 'bb': 3000000, 'drip': 5000000}
   pool 85985000000 204553650206456 430897438
E5 {'gross': 975113405, 'out': 950735570, 'fee': 24377835, 'liq': 4875568, 'plat': 6825793, 'fdr': 4875567, 'hld': 4875567, 'bb': 2925340, 'drip': 4875567}
   pool 85019637730 206900000900000 426021871
E6 setup 86666666666 791877616545871 84500000000 max_quote_in 512820512
E6 {'charged': 512820512, 'net': 500000000, 'tokens': 1222373454129, 'fee': 12820512, 'liq': 2564104, 'plat': 3589743, 'fdr': 2564102, 'hld': 2564102, 'bb': 1538461, 'grad': True, 'partial': True}
E7 {'spent': 85000000, 'coins': 206693307592, 'cap': 85000000} 85085000000 206693307592408 999793297592408 176538461
E8 263189306077696 39750853639 {'spent': 30000000, 'coins': 610723163277, 'cap': 39750853} 263800029240973 9780000000
E9 {'charged': 100000, 'net': 97500, 'tokens': 3487222633, 'fee': 2500, 'liq': 500, 'plat': 700, 'fdr': 500, 'hld': 500, 'bb': 300}
rem=1 graduating buy 1 0 1 True
last flat step below S-1: 2433 raw units; buyback there is a no-op
1 SOL just after graduation 2346350693544
caps: launch 30000853 end of curve 115000853 pool open 85000000 pool minimum 17586500
sandwich credited ()             canonical -3.8767%, multi-leg -3.2959%
sandwich credited ('fdr',)       canonical -2.8838%, multi-leg -2.3000%
sandwich credited ('fdr', 'hld') canonical -1.8909%, multi-leg -1.3041%
step 10 bps: best canonical (curve) -4.75%
step 50 bps: best canonical (curve) -3.98%
step 100 bps: best canonical (curve) -3.03%
step 150 bps: best canonical (curve) -2.06%
step 200 bps: best canonical (curve) -1.10%
step 250 bps: best canonical (curve) -0.12%
step 260 bps: best canonical (curve) +0.07%
step 300 bps: best canonical (curve) +0.85%
break-even backlog/depth u*: curve 2.5641%, pool 2.0421%
M_K curve 0 SOL raised, attacker 0.1 SOL: K=1 -4.75% K=20 -1.07% K=30 +0.93%, first profit at K=26
M_K curve 0 SOL raised, attacker 10 SOL: K=1 -4.77% K=20 -1.55% K=30 +0.19%, first profit at K=29
M_K curve 40 SOL raised, attacker 0.1 SOL: K=1 -4.75% K=20 -1.06% K=30 +0.93%, first profit at K=26
M_K curve 40 SOL raised, attacker 10 SOL: K=1 -4.76% K=20 -1.30% K=30 +0.56%, first profit at K=28
M_K pool 0 SOL raised, attacker 0.1 SOL: K=1 -4.75% K=20 -1.06% K=30 +0.94%, first profit at K=26
M_K pool 0 SOL raised, attacker 10 SOL: K=1 -4.66% K=20 -1.16% K=30 +0.73%, first profit at K=27
founder-credited first profit curve K = 21
founder-credited first profit pool K = 21
backlog sweep curve 0.0 SOL raised: last loss (2.5, 10.0, -1.644) first profit (backlog % of depth, attacker SOL, runs, result %): (2.6, 0.1, 26, 0.047)
backlog sweep curve 40.0 SOL raised: last loss (2.5, 10.0, -0.917) first profit (backlog % of depth, attacker SOL, runs, result %): (2.6, 0.1, 26, 0.06)
backlog sweep pool 0.0 SOL raised: last loss (2.5, 10.0, -0.696) first profit (backlog % of depth, attacker SOL, runs, result %): (2.6, 0.1, 26, 0.063)
drip farming (50, 70, 50, 50, 30) rule None best gain -0.2467 SOL
drip farming (50, 51, 50, 50, 30) rule None best gain -0.1333 SOL
drip farming (50, 50, 50, 50, 30) rule V10 best gain -0.1273 SOL
drip farming (100, 50, 50, 50, 0) rule V10 best gain 2.1729 SOL
drip farming (250, 0, 0, 0, 0) rule V10 best gain 13.7352 SOL
drip farming, 25 random configs passing V1 to V11: best gain -0.0208 SOL
fuzz {'buy': 54202, 'sell': 33424, 'bb': 12488, 'pay': 11973, 'grad': 300}
round trip least loss 4.0407%
max q*y0 1.341e+33 (u128 max 3.403e+38)
```

The fuzz ran 300 sequences of 400 random operations (54,202 buys, 33,424 sells, 12,488
buybacks, 11,973 payouts, 300 graduations, never a non-completing buy with dust), with
`Coin.check()` (I4, I6, I7, I8, I9, I10, I11, ledgers, u64 bounds) after every operation.

## Appendix B. Sources read for this file

* `vcurve-design/A.md` and `vcurve-design/B.md` (the two designs merged here), and design A's
  scripts in `vcurve-design-A-work/`.
* `feecheck/REPORT.md` (Meteora's share and the 18 points where Meteora's model conflicts
  with the owner's split): items 1 to 5, 8, 9, 11, 16 and 18 disappear with Meteora (the
  2.5% fits the caps, the 0.5% is really liquidity, no referral, the 0.7/0.3 split and the
  buyback are on chain, one fee rule in both phases, no Meteora one-offs, per-trade founder
  and holder shares, no vendor rates or pinned vendor binaries); items 6, 7, 10, 12, 13 and
  17 remain as labels and website work (6.6, 14.1); item 14 becomes O23 (the new program
  needs its own integrations); item 15 is covered by 8.5.
* `vcurve/solana/programs/vicinity-launchpad/src`: `constants.rs`, `state.rs` (the 171-byte
  `Launchpad` with `launches_paused` at byte 168; `Coin` and `Approval` seeds), `errors.rs`,
  `math.rs` (`check_name`, `is_format_char`, `check_symbol`, `metadata_uri`,
  `check_payout_keys_separate`, `program_data_upgrade_authority`,
  `read_rewards_city_config`, `check_rewards_config`), `validate.rs` (`good()`: the live DBC
  values of R8), and the instructions `approve_launch`, `launch` (boxed accounts),
  `revoke_approval`, `forward_holders_fees`, `payout_founder_fees`, `opt_in_payout`,
  `revoke_payout_opt_in`, `transfer_founder`, `set_pause`, `set_payout_config`,
  `init_launchpad`.
* `vcurve/solana/programs/vicinity-rewards/src`: `state.rs` (`CityConfig` layout: `authority`
  at byte 8, `pending_authority` at 40; `Registry`), `instructions/init_city.rs` (the only
  writer of a config's economics), `propose_authority.rs`, `accept_authority.rs`,
  `instructions/fund_epoch_from_vault.rs` (surplus booking from `vault.amount`).
* `vcurve/solana/LAUNCHPAD-DESIGN.md` (section 5 rent rate; 12.1 rewards authority; the 20
  holders and 0.01 SOL round rule) and `LAUNCHPAD-AUDIT.md` (sections 5.1 compute units, 7
  limits, 10 review findings); `LAUNCHPAD-DEVNET.md` (devnet ids);
  `release/mainnet-2026-10-10/BUILD.md` (toolchain, Squads multisig and vault); the workspace
  `Cargo.lock` (anchor-lang and anchor-spl 0.31.2).
* Anchor 0.31.2 sources: `anchor-syn` `codegen/program/idl.rs` (`__idl_create_account`) and
  `codegen/program/dispatch.rs` (`no-idl`), `anchor-lang` `error.rs` (`IdlInstructionStub =
  1000`), `anchor-attribute-event` (`emit_cpi!` lists only the event authority), `anchor-spl`
  `Cargo.toml` (`mpl-token-metadata = "5"`). solana-sdk 2.1 `transaction_context.rs`
  (`TransactionContext::push`, `UnbalancedInstruction`).
* The revision 1 review: security, math, runtime and integration findings (Appendix C) and
  the math reviewer's scripts in `mathreview/` (`attack_multi.py`, `attack_founder.py`,
  `attack_drip2.py`, `extra.py`, `floorfee.py`), re-run for this revision.

## Appendix C. Review responses (revision 1 to revision 2; revision 3)

Each finding was checked against the code and the math before it was applied. "Applied" means
the fix is in this file as the reviewer proposed or in an equivalent form; where a part was not
applied, the reason is given.

| id | lens, severity | finding (short) | response |
|---|---|---|---|
| SEC-1 | security, blocker | `forward_holders_fees` credits the vault by a direct lamport move and then CPIs `SyncNative` listing only the vault: `UnbalancedInstruction` on every call, holders' money stuck | **Confirmed** (solana-sdk 2.1 `TransactionContext::push`; `emit_cpi!` lists only the event authority, so the other `pay_out` users are fine). **Applied**, option (b): no `SyncNative` inside; a separate top-level `SyncNative` after it (SDK, keeper) and before `fund_epoch_from_vault`; `token_program` dropped from the accounts; the rule of 4.0; R01 and R02 rewritten to run the real instruction, R02b documents the failure mode (4.0, 4.15, 6.5, 12.5) |
| SEC-2 | security, major | the holders' share goes wherever the rewards city authority decides; `check_rewards_config` never reads the authority; worst-case table and I21 overstate | **Confirmed** (`CityConfig.authority` at byte 8, `pending_authority` at 40 are not read). **Applied**: `read_rewards_city_config` returns both; forward requires `authority == launchpad.admin` and no pending authority; 8.1 rewritten with every role of the Squads vault (registry admin, city authority, `vicinity_rewards` upgrade authority); stolen-admin worst case and I21 corrected; 8.4 precondition; X47b. The separate `rewards_authority` field is owner alternative O27 |
| SEC-3 | security, major | 48-hour time lock contradicts the "one Squads proposal" emergency brake; no fast stop | **Confirmed**. **Applied**, model (a): a guardian (separate multisig, no time lock) that can only set `buys_halted` / `launches_paused`; `buy`, `buyback_burn`, `launch` refuse; exits never; only the admin clears; `Launchpad` added to the trade lists (10 accounts); H01, H03, X43b; T46, T72, O9, O11 made consistent (4.4, 8.3, 8.4). Model (b), no time lock, is O11's alternative |
| SEC-4 | security, major | anyone can take the Anchor IDL account permanently | **Confirmed** (anchor-syn 0.31.2 `__idl_create_account` sets the authority to any signer). **Applied**: `no-idl` in default features; IDL through the Solana Program Metadata program; C03 and X65 check the IDL tag returns error 1000 (3.1, 8.4, 14.3, T65) |
| SEC-5 | security, minor | legacy R1 check only at approval, no legacy approval check, legacy pause is process only | **Confirmed** (old `Launchpad` 171 bytes, `launches_paused` at 168). **Applied**: `legacy_coin`, `legacy_approval`, `legacy_launchpad` checked in both `approve_launch` and `launch`; new errors; lookup table for the launch transaction; I19 restated "at every launch" (4.8, 4.10, 8.5) |
| SEC-6 | security, minor | `rewards_program` and `legacy_program` accepted if merely executable, written once forever | **Applied**: compiled constants per cluster (`devnet` feature), the init arguments and `Launchpad` fields removed; tests load the real programs at the mainnet ids; C03 records the ids; U12 (3.2, 4.1, I20) |
| SEC-7 | security, minor | `halt-all` leaves withdraw, forward, claim and payout open | **Applied**: `halt-all` refuses all eight outflow instructions; H02 asserts each. The `halt-buys` build is not kept: the guardian flag of SEC-3 does the same at once, so a second build would only add audit surface (8.3) |
| SEC-8 | security, nit | new `Coin` shares the old `Coin` discriminator; `decode_coin` checks bytes only | **Applied** both ways: struct renamed `CurveCoin`; `decode_coin(owner, data)` checks owner, length 693 and `layout_version`; the official list filters by program owner (3.7, 5.16, 14.1, U10) |
| MATH-1 | math, major | rounding the fee up exceeds 2.5% (2-lamport sell pays 1; graduating buy at `rem = 1` charged 2 with fee 1) | **Confirmed**. **Applied**: fee rounded down; remainder bound 4 (first reached at 560); gross-up `floor((c-1)D/(D-t)) + 1` with a new proof of Lemma G; `max_quote_in` updated; V5b; I12, I17, U01, U02, U06, E10; every example recomputed (5.2, 5.4, 5.13, 5.14) |
| MATH-2 | math, major | Theorem M covers one run; a public backlog lets a holder profit after about 6 runs | **Confirmed** (re-ran `attack_multi.py`: K=6 +0.92% at the old step). **Applied**: Theorem M_K with backlog and horizon forms; step reduced to 0.1% (`BUYBACK_CAP_DIVISOR = 25`); V11 (`K* >= 20`, and `>= 15` for a credited attacker); P06/P06b with backlogs of 10 caps and K up to 30; 7.2 and E7/E8 updated. Measured first profit now at 26 to 29 runs, and only above a 2.6% backlog |
| MATH-3 | math, major | V8 ignores the founder's own share; future configs could let a founder profit; split-leg bound unproven | **Confirmed** (re-ran `attack_founder.py`: (50, 0, 170, 0, 30) +0.40%). **Applied** with one refinement: V8 credits `m = max(b_F, b_H)` on both legs, and the credit on the buy leg is counted on the amount paid (`+ m D (CD)^2`), which the proposed `(D - t + 2b_L + m)^2` form slightly under-counts (0.98206 against the exact 0.98210 at the default); `MAX_FOUNDER_FEE_BPS = 100` (V2); the split-leg bound is labelled a heuristic with a tested margin; P06 and X44 credit the founder (and holders) |
| MATH-4 | math, major | drip non-farmability relies on `b_P > b_L`, not enforced | **Confirmed** (re-ran `attack_drip2.py` / `extra.py`). **Applied**: V10 in the stricter form of INT-3 (`b_L == 0 or b_L < b_P`), which implies the proposed `b_L <= b_P`; drip `= min(L, floor(A*b_L/D))`; P09b, X27b; 7.5 rewritten with measurements |
| MATH-5 | math, minor | "a dust sell drips at most 1 lamport" is false (remainder) | **Confirmed** (161 lamports drip 4). **Applied**: the drip excludes the remainder; T28 and 7.5 corrected |
| MATH-6 | math, minor | "permanent liquidity, nobody can withdraw it" misleads | **Applied**: the proposed label; 5.8 explains the 79.3% / 20.7% split on a full exit; the curve-phase buyback-path option added to the 5.8 table and to O2 |
| MATH-7 | math, minor | remainder always goes to liquidity, even at `liquidity_bps = 0` | **Applied** as disclosure in the labels and counters (6.3, 6.6) and as an intended permanent balance in I22. The alternative (route the remainder to buyback when `b_L = 0`) was not taken: it adds a branch to every trade for at most 4 lamports |
| MATH-8 | math, minor | I22's buyback clause fails at `curve_sol == f(S-1)` with `s < S - 1` | **Applied** (I22 now reads "or `curve_sol == f(S - 1)`"; U08 case with the 2,433-raw-unit last step). Note: that state cannot be reached by the program's instructions (buys land on step tops, sells must release a lamport; 5.3), so revision 1's wording held in practice, but the restated clause is stronger and covers the pure function |
| MATH-9 | math, minor | "2.5% on every trade" is untrue for third-party pools | **Applied**: label "through the Vicinity market (pools that others may create do not pay it)"; risk in 13 and 14.5; T74 |
| MATH-10 | math, minor | default pool of 206,900,010 coins contradicts R8's 206,900,000.9 without a forcing requirement | **Confirmed** (O3(a) integers re-checked and confirmed optimal by the same search for this `P`). **Applied**: O3(a) integers are config #0 (9.1 coins burned at launch); every dependent number recomputed; O3 asks the owner to choose before the audit freeze. O3(b) (today's dev-wallet transfer) was not made the default because it costs each founder about 0.0015 SOL of rent to deliver coins worth about 0.0000037 SOL and adds a token path |
| MATH-11 | math, nit | overflow row for `q * y0` understated | **Confirmed**. **Applied** with the new step: bound 1.35e33 (model 1.341e33); P10 and U09 include `x0 = y0 = 2^60`, `t = 250` |
| RT-1 | runtime, blocker | same as SEC-1 | **Applied** as SEC-1 (option (b)); R02 runs the full instruction and asserts both balances |
| RT-2 | runtime, major | same as SEC-4 (IDL), plus IDL buffer and write surface | **Applied** as SEC-4; T65's "process" mitigation replaced |
| RT-3 | runtime, minor | any rent increase makes every `pay_out` fail until each `Coin` is topped up | **Confirmed**. **Applied**: `Coin.rent_reserve`; floor `liabilities_after + min(rent_reserve, live rent)`; I9 restated; X63 raises the `Rent` sysvar by 10% (3.7, 6.5) |
| RT-4 | runtime, minor | holders can burn their own coins, so I11's equality is false on mainnet | **Applied**: I11 is an inequality with equality after adding tracked holder burns; supply = `mint.supply`; website shows burned by buybacks and total burned separately; X40b (3.10, 6.3, 14.1) |
| RT-5 | runtime, minor | a money-flow tracer built on inner instructions sees no SOL | **Applied**: SOL traced by lamport differences of every account in the message (I14, 12 intro) |
| RT-6 | runtime, minor | 693-byte `Coin` and many typed accounts risk SBF stack overflow | **Applied**: `Box` everywhere required; CI fails on stack warnings (C04); CU re-measured after boxing (3.1, 4.10, 11.1) |
| RT-7 | runtime, minor | sellers, founders and router PDAs can hold 0 lamports; data-carrying PDAs cannot buy | **Applied**: both conditions in 14.3; SDK and adapter pre-checks; X58 for sell and claim; G02 for router PDAs (4.11, 4.12, 4.16, 6.5) |
| RT-8 | runtime, minor | 300,000 CU for launch plus first buy leaves under 5% margin | **Applied**: 400,000 or 1.2 x simulated; C01 asserts the combined transaction (11.1, 14.1) |
| RT-9 | runtime, minor | "Anchor 0.31.1" while `Cargo.lock` resolves 0.31.2; `mpl-token-metadata` unpinned | **Confirmed** (workspace `Cargo.lock`: 0.31.2; anchor-spl asks `^5`). **Applied**: `=0.31.2` for both, exact `mpl-token-metadata`, `Cargo.lock` committed, all in C03 (3.1) |
| RT-10 | runtime, nit | a buy can deliver to a token account of the `Coin` PDA (stuck coins) | **Applied**: `user_token_account.owner != coin.key()` (`SameAccount`); X54 (4.11) |
| INT-1 | integration, major | same as MATH-1 (fee above 2.5%; `c = 1` pays 50%) | **Applied** as MATH-1; O4 is no longer an open question |
| INT-2 | integration, major | multi-run backlog makes the buyback profitably front-runnable; daily framing hides it | **Applied in part**: the backlog-threshold theorem (`u*` 2.564% curve, 2.042% pool), P06b sweep from 0.5% to 10% of depth over 1 to 30 runs, operational rules in 14.1 (keeper every interval, alert above 1% of depth, backlog on the coin page), the statement that the single-run claims are single-run, and owner sign-off O25. **Not applied**: (1) raising the step to 1% of depth: once the founder is credited (MATH-3), V8 fails for the default split at that step (0.9998 against 0.99), and the profitable backlog fraction does not depend on the step (a larger step only spends it, and lets the holder exit, sooner); MATH-2's smaller step was taken instead, and the cost (a backlog forms at lower volume) is stated in 7.2 and O7. (2) Dropping the 150-slot first-run delay (M10): at the 0.1% step it holds back at most one run (0.030 SOL at launch), so it does not change backlog formation materially, and the launch block stays crank-free |
| INT-3 | integration, major | drip farming under configs with `b_L >= b_P`; add V10 | **Applied** (`b_L == 0 or b_L < b_P`, `ConfigDripFarmable`); P09b, X27b at the edge. The model shows the refused `b_P = b_L` config still loses (-0.127 SOL), so the rule keeps a margin; gains start only well past it ((100, 50, ...) +2.17 SOL) |
| INT-4 | integration, major | same as SEC-3, plus the time lock's effect on the existing programs and stale halt buffers | **Applied** as SEC-3; 8.4 lists every existing-program action the lock delays; halt buffers rebuilt from the same commit after every upgrade; H03 |
| INT-5 | integration, major | 8.1 lists admin and upgrade authority as separate and omits the rewards root power | **Applied**: one row for every role of the Squads vault; real worst case; rewards powers and limits; snapshot publication and independent recomputation as mitigations; 0.1 item 8 and website copy changed (8.1, 6.6, 14.1) |
| INT-6 | integration, major | curve-phase liquidity of never-graduating coins is stuck and unused | **Applied**, option (b) as default: honest label, I22 names it an intended permanent balance, owner sign-off O2; option (a) (spend it through the buyback path) is O2's alternative. (a) was not made the default because before graduation it is buy-and-burn rather than liquidity, which changes the meaning of R2's default, and it adds to the buyback backlog |
| INT-7 | integration, minor | native-SOL routing claims unproven | **Applied**: marked "not proven"; written confirmation from Jupiter, Axiom, GMGN and FOMO before the audit freeze; G02 (M1, O10, 14.3, 14.4) |
| INT-8 | integration, minor | R8 is internally inconsistent by 9.1 coins; state which figure each option keeps | **Applied** with MATH-10 (5.9 table, O3, R8 row of section 2) |
| INT-9 | integration, minor | a wrong `CityConfig` can never be fixed | **Confirmed** (only `init_city` writes the economics; no close). **Applied**: disclosure in 4.15 and I22; SDK simulation and check before proposing; R03; the fallback is owner decision O26 (not built) |
| INT-10 | integration, minor | same as SEC-6 | **Applied** as SEC-6 |
| INT-11 | integration, minor | labels incomplete (buyback pays 0%, rounds at the authority's discretion, crank run by Vicinity, first-buy rent) | **Applied**: the proposed labels; the R2 exception in section 2 and O7; token-account rent in the buy panel (6.6, 14.1) |
| INT-12 | integration, minor | test plan misses router CPI, rent and clock warps, halt round trip, new issues | **Applied**: G02, X63, X59, H03, P06b, P09b, X27b, R03 added and mapped in 12.6 |
| INT-13 | integration, minor | ExactIn swap before `buy` can spend the user's own SOL | **Applied**: ExactOut or `sol_in = otherAmountThreshold`; G03 (14.1) |
| INT-14 | integration, minor | T37 overstates metadata immutability (JSON served by the website) | **Applied**: T37 corrected; JSON hash approved, stored in `Coin.meta_hash` and emitted; JSON and image served write-once and content-addressed (3.6, 3.7, 3.10, 4.8) |
| INT-15 | integration, minor | wallets will warn on a new program; "Phantom at once" not addressed | **Applied**: allow-listing step in 14.3 and O23; 14.4 and 14.5 corrected |
| INT-16 | integration, nit | M8's rationale does not hold (a bundled tiny buy graduates the coin at will) | **Applied**: M8 rationale changed; X23 covers the state |
| INT-17 | integration, nit | `legacy_coin` not checked at launch | **Applied** with SEC-5 |

### Revision 3: review round 1 of the build (17 October 2026)

The build was reviewed through five lenses (accounts, custody, math, governance, integration)
against this file and the notes; each finding was reproduced by a verifier before it was
accepted. Severities are the verifier's.

| id | lens, severity | finding (short) | response |
|---|---|---|---|
| GOV-1 | governance, medium | the cross-program one-coin-per-city guard depends on the old program's admin, which on mainnet is a single hot wallet (`FEE_RECIPIENT`); 8.4 did not require moving it | **Confirmed** (reproduced with the old program's mainnet binary and Meteora DBC). **Applied** both ways: the 8.4 precondition (the old admin is the Squads vault with nothing pending; closing the old program is an owner option, O19) and a code check in `approve_launch` and `launch` (the old `Launchpad`'s admin equals `launchpad.admin`, its pending admin zero, else `LegacyAdminMismatch`, 6051; fails closed). 4.2, 4.8, 4.10, 4.22, 8.1, 8.2, 8.4, 8.5, I19, T34, T67, T77, O19; `tests-curve/28-governance`; NOTES 42 |
| GOV-2 | governance, low | the program accepts `FEE_RECIPIENT` as admin, pending admin or guardian, and the guardian as payout key (and wallet) | **Confirmed**. **Applied**: `FeeRecipientRole` (6052) in `init_launchpad`, `propose_admin`, `accept_admin` and `set_guardian`; `check_payout_keys_separate` takes the guardian and `set_guardian` runs it. 4.1, 4.2, 4.4, 4.5, 4.22, 8.1, I20, I21, T50, T77; `28-governance`; NOTES 43 (resolves the third observation of NOTES 33) |
| CLI-1 | integration, medium | `buyWithSwap` defaulted the buy leg's `min_tokens_out` to 0, so "pay with any token" could be sandwiched | **Confirmed** (an SDK defect; the program enforces any minimum given). **Applied**: the helper builds no buy without a positive minimum (`minTokensOut`, or the coin's snapshot and `slippageBps` up to 500). 14.1, G03, T78; `29-clients`, `sdk/curve/prechecks.test.mjs`; NOTES 44 |
| CLI-2 | integration, low | the event rule given to indexers accepts a genuine event CPI from a failed transaction (fake trades for a fee, `trade_seq` collisions) | **Confirmed**. **Applied**: the acceptance rule of 4.21 (successful transactions only, at `finalized`; event CPIs only under a `vicinity_curve` call; settings events only from its logs; reconcile, never first-write-wins); the SDK's `decodeTransactionEvents`; every suite transaction decoded with it (E01). 4.21, 14.1, T56, 12.5; `sdk/curve/events.test.mjs`, `29-clients`; NOTES 45 |
| CLI-3 | integration, low | `initRewardsForCoin` reports a pre-funded (System-owned, empty) rewards config address as an unfixable wrong config | **Confirmed** for the pre-funded case. **Applied**: only an account owned by `vicinity_rewards` is a config; authority-only problems are reported as fixable (`AuthorityNotAdmin`), wrong economics as unfixable (`ExistsWrong`, O26). 4.15, 14.1, T70, R03; `29-clients`, `prechecks.test.mjs`; NOTES 46 |
| ACPI-1 | accounts, info | `forward_holders_fees` without a config fails before its no-op check, sinking a keeper's batch | **Rejected** by the verifier: specified (4.15, T70) and tested (`09-outflows`); the keeper sends forward only above a threshold and skips errors. No change |
| LC-INFO-1 | custody, info | X63's conclusion may not hold under the deployment cluster's rent rule | **Rejected**: SIMD-0392 is active on mainnet, devnet and testnet and in litesvm's default features. Its side point, that under SIMD-0392 every debit from a coin already below the live minimum is refused until a top-up (not only the last exits), is now stated in 6.5 and T63, with the keeper's top-up in 14.1 |
| MATH-INFO-1 | math, info | a buy into an untraded coin below the live minimum would be refused on mainnet | **Rejected**: under SIMD-0392 it is accepted (Agave 4.3.0 with the mainnet feature set). No change |
| GOV-3 | governance, info | an opt-in pays again after the payout wallet moves W1 to W2 and back | **Rejected**: intended and tested (X50; the founder agreed to W1 by name, 4.5, 4.19). No change |
| GOV-4 | governance, info | the time lock is a property of the Squads multisig, not of the program | **Rejected**: process; 8.4 already makes the time lock a precondition. No change |
| GOV-5 | governance, info | an admin hand-over stops forwards until each city's rewards authority follows | **Rejected**: specified (4.2, 8.2) and tested. 8.2 now also names the old program's admin, which must follow too |

### Revision 3: review round 2 of the build (17 October 2026)

The fixes of round 1 and the whole build were reviewed again through four lenses (the round-1 fix
diff, spec conformance, an attacker's economics, a fresh audit); each finding was reproduced by a
verifier before it was accepted. Severities are the verifier's.

| id | lens, severity | finding (short) | response |
|---|---|---|---|
| R2-DIFF-1 | fix diff, info | revision 3's 8.1 said `FEE_RECIPIENT` "cannot sign anything; hold any role" and I21 relied on it, but the program accepted it as a coin's founder (approve, launch, claim, opt in, transfer) and as the upgrade authority at `init_launchpad` | **Confirmed**. **Applied**, enforcing where the program can see it: `FeeRecipientRole` for the founder in `approve_launch`, `launch` and `transfer_founder`, and for the upgrade authority in `init_launchpad`; 8.1's row says what holds (it trades like any wallet, holds no seat), and later moves of the upgrade authority are 8.4's operating rule (the loader's `SetAuthority` is outside the program, as the verifier noted). 4.1, 4.8, 4.10, 4.17, 4.22, 8.1, 8.4, I21, T77; `28-governance`; NOTES 49 |
| SPEC-1 | conformance, low | the guardian (and `FEE_RECIPIENT`) could hold a coin's founder seat and receive its founder share, against 8.1 ("cannot touch money") and I21 (the checker fails at the claim) | **Confirmed**. **Applied** with R2-DIFF-1: `check_founder_key` also refuses the guardian and the payout key (`FounderHoldsRole`, 6053) at every approval, launch and founder transfer; `transfer_founder` reads the `Launchpad` (one account added; IDL and SDK). The admin stays allowed as a founder (8.1's worst case; it chooses every founder anyway), and I21 now says so instead of claiming no program path pays a role key; a later `set_guardian` or `set_payout_config` naming an existing founder cannot be detected on chain and is 8.4's operating rule and a checker rule (I20). 4.8, 4.10, 4.17, 4.22, 8.1, 8.4, I20, I21, T52, T77; `28-governance`, checklist test; NOTES 49 |
| ECON-1 | attacker, low (reported medium) | without a buyback share V8 and V11 do not run and V2 caps only `b_F <= 100`, so (0, 0, 100, 0, 0) passed V1 to V11: the founder got his whole fee back, wash-traded for free and took about 99 to 199 bps of buys made at 1% to 2% slippage, against 3.2, 5.15 and 7.4 | **Confirmed**. **Applied** as the verifier suggested, decided with the minimum fee: **V2b** `max(b_F, b_H) + MIN_TOTAL_FEE_BPS <= t` (part of V2, `ConfigFeeShareCap`; no new code): a trader credited the founder's or the holders' share pays at least 0.01% per leg, the floor every outsider pays. **Not applied**: the review's stronger forms (V8's credited bound with a zero step, or `t - m >= 100`), which would also refuse X44's accepted 0.01% platform-only config and contradict `MIN_TOTAL_FEE_BPS = 1`; the platform's own wallet stays uncovered (7.4 says so). Crate, SDK port, reference model (Appendix A), golden vectors (nine fixed V2b cases), F03. 3.2, 4.22, 5.13, 5.15, 7.4, T44, 12.1, 12.4; `config_rules.rs`, X44; NOTES 50 |
| FA-1 | fresh audit, low | `check_name` let Unicode default-ignorable code points that are not format characters (the Hangul fillers, the combining grapheme joiner, variation selectors and others) and blank characters into the immutable Metaplex name: "Paris" plus a Hangul filler looked exactly like "Paris"; the server's `nameProblem` had the same gap | **Confirmed**, with the verifier's two corrections (only the four Hangul fillers pass the website's own design route; U+2028 and U+2029 were kept on purpose as U11 neighbours). **Applied**, the safer reading of T38: `check_name` refuses every `Default_Ignorable_Code_Point` and other format character, every blank character (spaces other than U+0020, U+2028, U+2029, U+2800, U+1D159) and a leading, trailing or doubled U+0020; `nameProblem` mirrors it. Look-alike letters and canonical equivalents remain (names are not unique; the ticker is the identifier); the retired old program keeps its weaker rule. 3.6, 4.8, 4.22, T38, U11; U11, X38, `test/lpadmin.test.js`; NOTES 51 |

### Revision 3: review round 3 of the build (17 October 2026)

The fixes of round 2 and the whole build were reviewed again through five lenses (the round-2 fix
diff, the math, the coin's lifecycle, hostile roles, the clients); each finding was reproduced by
a verifier before it was accepted. Severities are the verifier's.

| id | lens, severity | finding (short) | response |
|---|---|---|---|
| R3-DIFF-1 | fix diff, low | V2b bounded `max(b_F, b_H)`, but a founder who also holds the float is credited both shares: (0, 0, 50, 50, 0), (0, 0, 100, 1, 0), (0, 0, 100, 150, 0) and (0, 0, 1, 1, 0) passed V1 to V11, and his wash trade cost exactly 0 net on chain (ECON-1 only partly closed; 7.4's "in every config" false) | **Confirmed**. **Applied** as proposed: **V2b** `b_F + b_H + MIN_TOTAL_FEE_BPS <= t` (the same as `b_L + b_P + b_B >= 1`; `ConfigFeeShareCap`, no new code). It keeps config #0, X44's configs and every edge the spec names; no golden vector changes (nine fixed cases appended). When `b_B > 0`, V8 and V11 still credit only `m = max(b_F, b_H)` (MATH-3's modelling), now said in 5.13. Crate, SDK port, reference model (Appendix A), I3. 3.2, 4.22, 5.13, 5.15, 7.4, I3, T44, 12.1, 12.4; `config_rules.rs`, X44, F03; NOTES 52 |
| MATH3-2 | math, info | the same gap as R3-DIFF-1, seen from the math: configs whose founder and holders shares make the whole fee pass, and a founder holding the eligible float trades for exactly 0 net fee | **Confirmed**. **Applied** with R3-DIFF-1 (the sum form, which still accepts every X44 config); 3.2's `MAX_FOUNDER_FEE_BPS` row and NOTES 50 corrected. NOTES 52 |
| LL-1 | lifecycle, low (reported medium) | one flag, `buys_halted`, stopped user buys and buybacks alike, while every sell still booked its 0.3% into `buyback_pending`: during a guardian halt a mostly sold pool built a backlog many times `u*` (14.9% of depth), the keeper could not spend it, and the first buyer after the admin's publicly scheduled clear took a large share (+1.24 SOL on 20 SOL) | **Confirmed**. **Applied**, the safer of the two proposals (a separate flag rather than leaving buybacks unhaltable): `Launchpad.buybacks_halted` (offset 174, from the reserved bytes; size unchanged) blocks `buyback_burn` (`BuybacksHalted`, 6054); `buys_halted` now blocks only `buy` and `launch`; `set_pause` takes a fourth argument and refuses any result with buybacks halted and buys open (`BuybackHaltWithoutBuyHalt`, 6055), for every signer, so a buyback halt goes with a buy halt and buys never reopen before buybacks. A halt of buys alone leaves the keeper running; after a halt of both the admin resumes buybacks first, the keeper drains every backlog while buys are still refused, and buys reopen in a later proposal (8.3 runbook, 14.1). IDL, SDK builder, decoder and event. 3.4, 4.0, 4.4, 4.13, 4.21, 4.22, 6.4, 7.1, 7.2, 8.1, 8.3, I20, I22, T72, T73, T76, O9, O25, 12.3, 12.5, 14.1, 14.3; H01, L12, X43b, the LL-1 test, the fuzz model, the checker (I20); NOTES 53 |
| R3-CLI-1 | clients, medium (reported high) | on a buy that completes the curve, `buyWithSwap` (and the README's direct buy) took `min_tokens_out` from the partial quote but left `sol_in` at the full amount; once a searcher (or any buyer) graduated the coin first, the same buy ran in the pool, was charged all of `sol_in` and still cleared the small minimum (20 SOL at 4.9 times the quoted price; 10.77 SOL taken); 14.3 told routers they may "treat `charged < sol_in` as the amount used" | **Confirmed** (an SDK and guidance defect; the program behaves as specified). **Applied**: the SDK's new `buyLeg` (used by `buyWithSwap`) caps `sol_in` at the partial quote's charge (`max_quote_in`) and takes the minimum from that quote; it needs the coin snapshot; `buyLegMinimum` refuses an uncapped `sol_in`; `buyWithSwap` also returns the swap's guaranteed output (the difference stays in the wallet). The README's direct buy uses `buyLeg`. 14.3 now requires the cap; 5.4 explains why; T79 added next to T17. M13's price limit was not taken: the minimum was computed for the smaller charge, so it would not help. 5.4, 14.1, 14.3, T79; `29-clients`, `prechecks.test.mjs`; NOTES 54 |
| MATH3-1 | math, low | 5.15 said that under config #0 "no ordering profits at the website's slippage", but any buy above about 2.5% of the market's SOL depth (2.0% for the founder; about 0.75 SOL on a fresh coin) is sandwiched at a profit whatever the slippage, and the victim loses almost all of it; the SDK's `buyLegMinimum` accepted a flat slippage up to 5% for any size | **Confirmed**. **Applied**: 5.15 states the threshold `V* = (c/D) * depth` per attacker class and corrects the config #0 sentence; 7.4 and 14.1 follow. The SDK's `sandwichThreshold` (`(t - max(b_F + b_H, b_P))/D` of depth, the cheapest credited attacker) and `buySlippagePolicy`; `buyLeg` and `buyWithSwap` allow at most 5% up to the threshold and 0.3% above it, for a minimum given or derived, and refuse more with a message that offers splitting; the website's default is 1% up to the threshold, 0.3% above it. A private submission path is mentioned, not built. 5.15, 7.4, 14.1, T80; `29-clients`, `prechecks.test.mjs`; NOTES 55 |
| HR-1 | roles, info (reported low) | V8, V11 and V2b credit at most `m = max(b_F, b_H)`, but `withdraw_platform_fees` credits `FEE_RECIPIENT` (a single compiled hot wallet) `b_P` of its own legs: under O1's alternative, or with a founder seat held by the owner under config #0, it profits from a 1.34% backlog after 14 runs, and (0, 120, 0, 1, 1) passes V1 to V11 with a profitable single-run sandwich for it; 5.13, 7.3, V11, T24, T76 and O25 claimed their bounds for any credited attacker | **Confirmed** as a spec defect (the verifier: under config #0 `FEE_RECIPIENT` alone stays inside O25's founder envelope; every breach needs an owner-chosen config or the owner stacking a founder seat on `FEE_RECIPIENT`). **Applied**: 5.13, V8, V11, 7.3 (the platform's key and its measured envelope), 8.1, T24, T76, O25 and O1 now exclude it and give its numbers; the operating rule of 8.4 (`FEE_RECIPIENT` and the owner's wallets never hold or trade city coins or take a founder seat; the keeper alerts when it holds one); the clients' sandwich threshold counts `b_P` (5.15). **Not applied, open owner decision O29**: counting `b_P` in V8 and V11 (config #0 would fail V11 unless the platform gets its own horizon) or keeping `b_P <= m`, both changes to which fee splits are allowed; no fee value changed. `19-attacks-admin` (HR-1); NOTES 56 |
| HR-2 | roles, info | a thief of a founder key can move the seat with `transfer_founder` and take every later founder fee | **Rejected** by the verifier: the recorded design (4.17 and T52: the seat moves only with both signatures and the admin can never reassign it; O22). The copied key could claim every later accrual without a transfer anyway, and the legitimate founder can use the transfer first. No change |
| HR-3 | roles, info | a stolen `FEE_RECIPIENT` key takes the platform's income until an upgrade | **Rejected** by the verifier: recorded (R9, 3.2: changing `FEE_RECIPIENT` needs an upgrade; 6.4 and 8.3: platform withdrawals are not pausable by design); no holder's, founder's or third party's money is reachable. A cold wallet or a Squads vault as `FEE_RECIPIENT` before the mainnet build is an operational choice for the owner. No change |

### Revision 3: review round 4 of the build (17 October 2026)

The fixes of round 3 and the whole build were reviewed again through five lenses (the round-3
fix diff, operations, cross-program calls, a fresh audit of the state machine, the SDK and docs); each finding
was reproduced by a verifier before it was accepted. Severities are the verifier's. Findings
that several lenses reported share a row.

| id | lens, severity | finding (short) | response |
|---|---|---|---|
| R4-DIFF-1, SM-1, SDK4-1 | fix diff, state machine, SDK; low (SDK4-1 reported medium) | `buyLeg` capped a completing buy at the partial quote's bare charge, not at `max_quote_in`: within about 97,500 lamports of graduation (after a cheap buy, or at the curve buyback's end state `S - 1`) the charge is below `MIN_TRADE_LAMPORTS`, `quoteBuy` threw `TradeTooSmall`, and no SDK buy (`buyLeg`, `buyLegMinimum`, `buyWithSwap`) could be built, while the program accepts `max_quote_in` and graduates the coin | **Confirmed**. **Applied** with the verifier's correction: the cap is `maxQuoteIn` (at least `MIN_TRADE_LAMPORTS`); a quote that stays partial at `MIN_TRADE_LAMPORTS` (the last raw units) is accepted; a derived minimum is at least 1 raw unit (at `S - 1` the quote is one unit). The exposure left if someone graduates first is 0.0001 SOL charged in the pool. 5.4, 14.1, 14.3, T79; `prechecks.test.mjs`, `29-clients`; NOTES 57 |
| R4-DIFF-3, SDK4-2 | fix diff, SDK; low | `sandwichThreshold` used the curve's depth (up to 115 SOL) for a buy that can be pushed into the pool, which opens at depth `graduation_sol` (85 SOL): near graduation a threshold-size buy at 4% to 5% was straddled (graduate, pool buy, victim, sell) for a profit by a founder holding the float, against 5.15's "in both phases" | **Confirmed** (only that class profits, only at 4% to 5%). **Applied**: the threshold's depth is `min(x0 + curve_sol, graduation_sol)` on the curve (`sandwichDepth`), for buys and sells; 5.15 qualified. 5.15, 14.1, T80; `prechecks.test.mjs`, `29-clients`; NOTES 58 |
| SDK4-4 | SDK, info | a due `buyback_burn` placed inside the victim's sandwich made the founder holding the float profit (tens of thousands of lamports) at the threshold with 5% | **Confirmed**. **Applied**: the threshold's cost leaves room for one run, `c' = t - max(b_F + b_H, b_P) - ceil(2t/C)` for a config with a buyback share (`sandwichCostBps`; 130 bps under config #0: 0.39 SOL at launch, 1.105 SOL at pool open). 5.15, 7.4, 14.1, T80; `prechecks.test.mjs`, `29-clients`; NOTES 58 |
| R4-DIFF-2 | fix diff, low | the advice to split a large buy into threshold-size buys, each in its own transaction (5.15, 14.1, `buyLeg`'s refusal, NOTES 55), defeats the 0.3% cap: one sandwich holds across the transactions and wraps every piece (MATH3-1 reopened for whoever follows it) | **Confirmed**. **Applied**, both parts: the advice is gone (splitting does not help; a protected submission path is the way for large trades), and a client that splits anyway judges each piece by the order's total (`orderSolIn`, `orderGross`). 5.15, 14.1, T80; `prechecks.test.mjs`, `29-clients`; NOTES 59 |
| R4-DIFF-5, SDK4-3 | fix diff, SDK; low | the size-dependent slippage covered buys only: a sell above the threshold at 1% was sandwiched by any holder for nearly the whole tolerance | **Confirmed**. **Applied**: `sellLeg` and `sellSlippagePolicy` (the buy rule on the sell's gross; a minimum given or derived, at least 1 lamport; no sell without one). 5.15, 7.4, 14.1, T80; `prechecks.test.mjs`, `29-clients`; NOTES 59 |
| SDK4-5 | SDK, info | `solInFromSwapQuote` never checked that the swap's output is native SOL, so a quote to another token made the buy spend SOL the user already had (G03 depended on the caller) | **Confirmed**. **Applied**: `outputMint` must be the native mint and `inputMint` another one, else `ComposeError`; the unwrap (`wrapAndUnwrapSol`) is documented. 14.1, G03; `prechecks.test.mjs`, `26-router`; NOTES 60 |
| SDK4-6 | SDK, info | the README's direct-buy example threw on a fresh coin, and 7.4 and the 29-clients header gave round 2's "2% to 2.5%" threshold | **Confirmed**. **Applied**: the README takes its slippage from `buySlippagePolicy` (and shows the sell leg); 7.4 and the header give the SDK's figure. `prechecks.test.mjs` runs the README's lines and checks the texts; NOTES 60 |
| OPS-1 | operations, low | nothing on chain enforced 8.4's rule that the rewards registry admin is the Squads vault, and no deploy checklist existed: while a hot key (on mainnet the owner's `13qRam...`, also `FEE_RECIPIENT`) held that seat it could create a new coin's `CityConfig` with wrong economics before the vault's time-locked `init_city`, and the coin's holders' share could never be forwarded (O26) | **Confirmed**. **Applied**, fail-closed as GOV-1: `approve_launch` and `launch` read `vicinity_rewards`' registry at the compiled `REWARDS_REGISTRY` (owner, 73 bytes, discriminator) and require its admin to be `launchpad.admin` with no transfer pending (`RewardsRegistryAdminMismatch`, 6056); 8.2 adds the registry admin to the seats that follow an admin hand-over; the deploy checklist `scripts/vcurve/preflight.mjs` reads every 8.4 precondition it can read from the chain (round 5 added the proposed-key check of 8.4's operating rule, which this row first claimed, and the guardian-is-admin and immutable old program cases: R5-DIFF-2, R5-CONS-1 to R5-CONS-3). 3.2, 4.8, 4.10, 4.22, 8.2, 8.4, I19, U12, L04; IDL, SDK; `28-governance`; NOTES 61, 64 |
| R4-DIFF-4, OPS-3 | fix diff, operations; low / info | a stolen guardian can make the one-proposal recovery of 4.4 (`set_guardian` with `set_pause(buys = false)`, buybacks unset) fail by halting buybacks late in the time lock (`BuybackHaltWithoutBuyHalt`; `set_guardian` reverts with it); written with `buybacks = false` instead, it reopens buys and buybacks together after a time lock of buyback halt (the LL-1 state) | **Confirmed**. **Applied** (runbook and SDK; the program unchanged): the first proposal replaces the guardian with `set_pause(buybacks = false)` and buys left halted (or `buys = true` when buybacks must stay halted), which no flag can make fail; buys reopen in a second proposal after the drain. The SDK's `guardianRecovery`; 4.4, 8.1 (the guardian can make an unprepared proposal fail once), 8.3, T73 and `set_guardian.rs` say so. `28-governance`, `prechecks.test.mjs`; NOTES 62 |
| OPS-2 | operations, low | after a rent increase the keeper rule "top up every coin below the live minimum" misses coins above the minimum whose exits are blocked, and a top-up to the minimum still leaves every debit refused | **Confirmed** (the program side is correct). **Applied**: the keeper tops up `liabilities + rent_min(693) - lamports` when positive (the SDK's `coinRentTopUp`); 6.5, T63, 14.1. `20-attacks-runtime` OPS-2 (both cases), `prechecks.test.mjs`; NOTES 63 |
| OPS-4 | operations, info (reported low) | closing the old program as 8.5 and O19 allow, with an old `Approval` still open, blocks that city here for ever (`LegacyApprovalExists`; nothing can revoke it after the close) | **Confirmed**. **Applied**: the precondition in 8.5 and O19 (no old `Approval` before a close; revoke each first; making the program immutable avoids it) and in the deploy checklist (`--before-legacy-close`). `28-governance` OPS-4 (a real loader `Close`); NOTES 64 |
| TL-INFO-1 | cross-program calls, info | 11.1 stated `launch` 110,600 to 125,900 CU from one city; over 600 city ids it spans about 110,000 to 152,000 (bump searches), and the suggested buy limits left out the first buy's token-account create | **Confirmed** (no budget exceeded, no funds involved). **Applied**: 11.1 restated from a fresh measurement (110,382 to 152,266 over 600 city ids, city 1000 / A / C0 151,008; the ATA create `13,424 + 1,500 x k`; first buys from a simulation or plus 30,000; re-measured with the mainnet id); 11.3 for the registry account. `12-compute` TL-INFO-1; NOTES 65 |
| SM-2 | state machine, info | the per-transaction checker never checked that a successful call ran under permitting flags, nor what `approve_launch` and `opt_in_payout` wrote (no program defect) | **Confirmed**. **Applied**: the checker walks the calls with the flags of their moment (earlier `set_pause`s of the same transaction applied) and checks a new approval's and opt-in's contents (I20); the pool-buy and payout probes of I22 are not added (optional). `27-checker-gaps` SM-2; NOTES 66 |

### Revision 3: review round 5 of the build (17 October 2026)

The fixes of round 4 and the whole build were reviewed again through five lenses (the round-4
fix diff, the rewards registry dependency, the economics under the final SDK policy, the
consistency of the specification with the code, cross-coin arithmetic); each finding was
reproduced by a verifier before it was accepted. Severities are the verifier's. Findings that
several lenses reported share a row.

| id | lens, severity | finding (short) | response |
|---|---|---|---|
| R5-DIFF-1 | fix diff, low | R4-DIFF-2's fix (each piece of a split order judged by the order's total, 0.3%) held only for minimums computed from the order's first snapshot: a schedule that reads the coin before each piece, as `buyLeg`'s input says, measured each 0.3% from a price that already held a searcher's earlier buys; on chain a 5 SOL order in 13 pieces lost 187 bps (+70,707,128 lamports to him), 10 SOL 327 bps in the model, a 6-piece sell 98 bps; 5.15 and NOTES 59 promised about 0.3% | **Confirmed** (the verifier's correction: the unfixed SDK with fresh reads lost 609 bps, so round 4 cut the loss about 3x). **Applied**, the review's option 1 as the only way to build a piece: `buyLeg`, `buyWithSwap` and `sellLeg` take `order = { start, pieces, received }`, refuse a piece without it, and hold the piece's minimum to `floor(Q * (D - s) / D) - received` (`Q` what the order's pieces deliver in sequence from `start` with no other trade), refusing the piece once the current quote is below it; the order then loses at most `s` against its quote at the start (29 bps on chain, the searcher 0.28%). 5.15, 14.1, T80; `prechecks.test.mjs`, `29-clients`; NOTES 67 |
| MV-1 | economics, low (reported medium) | the SDK judged the sandwich threshold one trade at a time, so two SDK trades from one snapshot in one block, each at the threshold with 5% (safe alone), were wrapped together: on chain the founder +12,722,874 lamports, an outsider +948,502 (with the due run), sells alike (+15,196,387); 5.15's "at the threshold every attacker class loses at every slippage up to 5%" and T80 false for that case | **Confirmed** (the verifier: the outsider only with the run and from 3%; the victims' loss to the attack about 2.6%, not 3.8%; at 1% only the founder holding the float). **Applied**, the review's rule: at or below the threshold a trade of size `V` may allow at most `floor(2D * (threshold - V) / depth')` (clamped to 0.3% to 5%; default 1% or that maximum), so everything one sandwich can wrap fits under the threshold; config #0 about 2.6% for the smallest trades, 1% up to 0.24 SOL on a fresh coin and 0.68 SOL at pool open, never 5%. 5.15, 7.4, 14.1, 14.3, T80; `prechecks.test.mjs` (one to three victims at the rule's sizes, every run, every class loses), `29-clients` MV-1; NOTES 68 |
| KR-1 | economics, low | the threshold allowed for one buyback run, but with one SDK buy at it inside a hold through `K` runs of a public backlog the founder profited at `K` = 8 (0.84% of depth, below the keeper's 1% alert) and an outsider at 15, below Theorem M_K's and O25's figures, which assume no other trade | **Confirmed** (the verifier: also at the website's 1%; the model's least `K` is 13 for an outsider, 8 for the founder, 6 for the platform's key, 3 for a founder holding the float). **Applied**: `sandwichRuns = max(1, ceil(buyback_pending / cap'))` runs of `ceil(2t/C)` each in the threshold's cost (`cap'` at the sandwich depth; nothing left from 7.5 caps under config #0, every trade 0.3%); the keeper's alert moves to two caps (0.2% of depth); 7.3 gives the figures with a trade inside the hold; O25 carries them and needs the owner's sign-off again. Not taken: every trade large while more than one cap is pending. 5.15, 7.2, 7.3, 8.4, T76, T80, O25, 14.1; `prechecks.test.mjs`, `29-clients` KR-1 and SDK4-4; NOTES 69 |
| R5-CONS-1 | consistency, low | the deploy checklist reported ready with the admin vault as guardian (`init_launchpad(guardian = admin)` and `set_guardian(admin)` were accepted), so the fast brake of 8.3, T46 and T72 could be a 48-hour proposal, O9's rejected alternative | **Confirmed**. **Applied**, the safer fix in the program and the checklist: `GuardianIsAdmin` (6057, appended) refuses a guardian that is the admin or the proposed admin at `init_launchpad`, `set_guardian`, `propose_admin` and `accept_admin` (`check_guardian_separate`); the checklist reports `GUARDIAN_IS_ADMIN` (admin, vault or proposed admin) and asks the operator to confirm that the guardian multisig has no time lock of its own; I20 asserts it after every transaction. 4.1, 4.2, 4.4, 4.22, 8.1, 8.4, I20; IDL, SDK; `28-governance`; NOTES 70 |
| R5-DIFF-2, R5-CONS-2 | fix diff, consistency; info / low | 8.4's operating rule says the deploy checklist compares a new guardian or payout key with every `Coin.founder` before the proposal is signed, and the OPS-1 row says the checklist reads every 8.4 precondition; the checklist had no input for a proposed key (extra options were silently ignored), so `set_guardian(founder)` could be signed and executed with no warning, and the guardian then held the founder's claim | **Confirmed** (the config #0 sub-point, a non-default config #0 passing, not confirmed as an inconsistency; a warning added anyway). **Applied**: `checkProposedRoleKey` and `checkDeployPreconditions({ proposed })` check a proposed guardian, payout key or payout wallet against every coin's and pending approval's founder and the keys the program keeps the role apart from; unknown options are refused; the CLI takes `--proposed-guardian`, `--proposed-payout-authority` (`--proposed-payout-key`) and `--proposed-payout-destination` and refuses unknown options; 8.4 and the OPS-1 row corrected. `28-governance`; NOTES 71 |
| R5-DIFF-3, R5-CONS-3 | fix diff, consistency; info | making the old program immutable, which 8.5, O19 and OPS-4 recommend, made the checklist report `LEGACY_UPGRADE_AUTHORITY` for ever | **Confirmed** (reproduced with a real loader `SetAuthority` to none). **Applied**: for the old program only, an immutable ProgramData passes with a `LEGACY_IMMUTABLE` warning (`programDataState`); its approvals stay warnings; 8.4 says "the Squads vault, or none". `28-governance`; NOTES 72 |
| R5-REG-1 | registry, info | an admin hand-over under the time lock stops approvals and launches for a time lock or two; the no-gap order (the new vault's accepts and an approval in one transaction) works on chain but the suite's checker rejected it, reading the seats from before the transaction | **Confirmed for the checker only** (the outage itself is the accepted fail-closed rule, 4.2, 8.2, and O11; with both proposals approved together the gap is seconds). The verifier also found the reverse: a mutant without the old-admin check approved inside `[old propose_admin(stranger), approve_launch]` and the checker accepted it. **Applied**: the checker walks the calls with the seats of their moment (this program's, the old program's and the registry's `propose_admin` / `accept_admin`, the old `set_pause`, `set_guardian`, `set_payout_config`) for I19, OPS-1 and SM-2's approval contents, and checks that the walk ends at the accounts after the transaction; 8.2 gains the no-gap recipe. Not built: an SDK helper for the two halves (optional). I19, 8.2; `27-checker-gaps`; NOTES 73 |
| R5-REG-2 | registry, nit | a devnet-feature binary at the mainnet program id passes the deploy checklist and fails only at the first `approve_launch` (`InvalidAddress`) | **Rejected** by the verifier: it needs a deliberately wrong build (the devnet binary from the committed source carries the throwaway id and fails every instruction elsewhere with `DeclaredProgramIdMismatch`); it fails closed at the first approval, before any time lock exists (8.4's order), and is fixed by an immediate redeploy with no coins or funds involved; which binary is deployed is the verified build's job (8.4, C03), not the account checklist's. No change |
| R5-REG-3 | registry, nit | a future `vicinity_rewards` upgrade that changes the `Registry` layout, or a close of that program, stops approvals and launches here | **Rejected** by the verifier: OPS-1's accepted fail-closed check, triggered only by the owner's own actions; the coupling is enforced in CI (the committed `vicinity_rewards` IDL is diffed against the build and U12 checks the curve's layout constants against it: one added field fails it); closing `vicinity_rewards` is not a realistic owner action and its real cost is elsewhere (forwards still pay into a vault no program can pay out). No change |
| R5-CONS-6 | consistency, info | no keeper exists in the repository (nothing calls `buyback_burn` or `coinRentTopUp`), while O25's mitigations rely on it | **Rejected** by the verifier: the specification presents the keeper as website work still to do (1.1, section 14, INT-2's "operational rules in 14.1"), and the status block says only the program, crate, SDK and suites are built. Listing "the keeper and its alerts run" among the launch preconditions is an optional improvement, not a defect. No change |

### Revision 3: the leftovers of the build's third stage

| item | done |
|---|---|
| L1 | the fuzz has the admin's other seats follow every hand-over (the old program's admin, each city's rewards authority), so approvals, launches and forwards keep succeeding in long runs (12.5 F01; NOTES 48) |
| L2 | the failed-transaction check charges no fee to a transaction refused before execution and exactly the fee to every other failure (12 intro; NOTES 47) |
| L3 | X04 (a Token-2022 mint and Token-2022 token accounts of the coin's mint in `buy` and `sell`) and X02 (the old program's real `Coin` in every coin slot) completed (12.4; NOTES 48) |
| L4 | this revision: I18's second clause restated as P11a and P11b; I22's dust case; the third buyer rent rule in 14.3; T63's rent nuance and the keeper's top-up; every accepted note folded in (below) |
| L5 | `tests-curve/README.md` lists every test file; the duplicate prefix 20 renamed (`27-checker-gaps`); NOTES 28 and 32 marked superseded |

### Revision 3: implementation notes folded in

Every entry of `VICINITY-CURVE-NOTES.md` and where this revision reflects it. "No change" means the
build follows the text as written and the entry records a reading or a measurement.

| entry | subject | revision 3 |
|---|---|---|
| 1 | property tests use `proptest` (dev-dependency) | 12 intro |
| 2, 3 | `spot_price` takes the terms; every function returns `Result` | 5.16 |
| 4, 5, 6, 8 | the quotes refuse what the program refuses; a buy whose liabilities would leave `u64`; the contents of `State`; preconditions and self-checks | 5.16 |
| 7 | `decode_coin` takes a 32-byte owner and refuses a phase other than 0 or 1 | 5.16 |
| 9, 11 | `validate_config` order and margins; `derive_curve` made exact | 5.16 |
| 10, 12, 13, 14, 15 | V01 to V11 edges (two unreachable), the completing buy at exactly the remainder, P05/P06/P06b bounds, where U10 to U12 live, the reference model and vectors | no change |
| 16 | P09b allows the fee's rounding (at most one lamport per trade) | 12.2 P09b |
| 17, 18, 19 | Cargo features; anchor-spl's extra features; `lto` without effect | 3.1 |
| 20 | binary size and stack | 11.4 |
| 21 | the halt-all guard runs after Anchor's account validation | 4.0 |
| 22 | `pay_out` refuses a destination equal to the `Coin` | 6.5 |
| 23 | smaller handler choices (an empty `set_pause`, config ids, the completing buy's `Trade`) | 4.4, 4.21 |
| 24 | the committed client IDL | 8.4 |
| 25, 26 | the review checklist tests; CI additions | no change |
| 27 | the suites load the committed mainnet binaries | 3.2, 12 intro |
| 28 | `sdk/curve/` and `tests-curve/` (superseded in part by 37 and 38) | 14.1, 12 intro |
| 29 | the checker's readings of I14 and I21 (Anchor's closes; an `Approval`'s rent) | I14, I21 |
| 30 | compute units and transaction sizes measured | 11.1, 11.3 |
| 31 | X31 forced by an out-of-band edit, not a test-only build | 12.4 |
| 32 | the first attack tests (superseded by 33, 38 and 48) | none |
| 33 | the attack tests of 12.4, the rent-increase measurements and three observations | 6.5, T63, 12.4; the guardian observation by GOV-2 |
| 34 | the checker's last gaps (I14 destinations, I21 tokens, I5 and I6 per step, I20 at run time) | 12 intro, I21 |
| 35 | I18's spot-value clause is false for a constant-product market; P11a and P11b | I18, 12.2 |
| 36 | the third buyer rent rule; the SDK's pre-checks (its `initRewardsForCoin` sentence superseded by 46) | 14.3, 4.15 |
| 37, 39 | G01 and F03 at full scale | no change |
| 38 | F01 and F02 at full scale with a model side by side | 12.5 F01 |
| 40 | G02, G03 and R02b with a mock router | 12.5 R02b |
| 41 | I22's buyback dust case | I22 |
| 42 to 48 | review round 1 and the leftovers (above) | as listed above |
| 49 | review round 2: the founder seat (above) | as listed above |
| 50 | review round 2: V2b (above) | as listed above |
| 51 | review round 2: names with invisible or blank characters (above) | as listed above |
| 52 | review round 3: V2b bounds the sum of the founder's and the holders' shares (above) | as listed above |
| 53 | review round 3: a separate buyback halt, set only while buys are halted (above) | as listed above |
| 54 | review round 3: the completing buy offers only its charge (above) | as listed above |
| 55 | review round 3: the buy leg's slippage depends on its size (above) | as listed above |
| 56 | review round 3: the platform's key in the MEV rules; open owner decision O29 (above) | as listed above |
| 57 | review round 4: the completing buy offers `max_quote_in` within 97,500 lamports of graduation (above) | as listed above |
| 58 | review round 4: the sandwich threshold at the pool's depth, less one buyback run (above) | as listed above |
| 59 | review round 4: splitting is no defence; the sell leg (above) | as listed above |
| 60 | review round 4: the swap's output mint; the docs follow the SDK (above) | as listed above |
| 61 | review round 4: the rewards registry's admin at every approval and launch (above) | as listed above |
| 62 | review round 4: the recovery from a stolen guardian that no flag can make fail (above) | as listed above |
| 63 | review round 4: the keeper's top-up after a rent change (above) | as listed above |
| 64 | review round 4: the deploy checklist; no old approval when the old program is closed (above) | as listed above |
| 65 | review round 4: launch compute over many city ids; the token-account create (above) | as listed above |
| 66 | review round 4: the checker's flags per call and approval contents (above) | as listed above |
| 67 | review round 5: a piece of a split order is held to the order's start (above) | as listed above |
| 68 | review round 5: the slippage at or below the threshold depends on the size (above) | as listed above |
| 69 | review round 5: the threshold counts every buyback run the backlog pays for (above) | as listed above |
| 70 | review round 5: the guardian is never the admin or the proposed admin (above) | as listed above |
| 71 | review round 5: the checklist checks a proposed role key before the proposal is signed (above) | as listed above |
| 72 | review round 5: an immutable old program meets the checklist (above) | as listed above |
| 73 | review round 5: the checker reads the seats of each call as they stood at it (above) | as listed above |
