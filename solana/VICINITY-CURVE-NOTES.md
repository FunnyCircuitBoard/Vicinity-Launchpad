# `vicinity_curve`: implementation notes for the auditors

Companion to `VICINITY-CURVE-DESIGN.md`, revision 3 (entries 1 to 41 were written against
revision 2, commit ee62c31; revision 3 folds every entry in, and its Appendix C says where;
entries 42 to 48 answer review round 1 of the build, entries 49 to 51 review round 2, 52 to 56
review round 3, 57 to 66 review round 4, 67 to 74 review round 5; entry 75 records the
specification of the owner's batch launch approval, entry 76 its build and entry 77 the mutation
tests of its rules; entries 78 to 82 answer review round 6, of the batch launch approval,
entries 83 to 90 review round 7, entries 91 to 96 review round 8, entries 97 and 98 the
verification of round 8, entries 99 to 102 review round 9, entry 103 its verification and entries 104 and 105
review round 10). The
specification is authoritative. Each entry below records one place where the build had to clarify the
specification, or deviates from it, with the section, the issue and the choice taken. Where
the specification was ambiguous, the safer reading was built. Nothing here changes an
economic figure: every worked example of 5.14 and every figure of 5.9, 5.10 and 5.13 is
reproduced to the lamport and raw unit by the tests.

Stage 1 (this file's first entries): the math crate `crates/vicinity-curve-math`.

---

### 1. Property tests use `proptest` (12, 12.2)

**Spec.** "Rust unit and property tests ... deterministic xorshift generators, no extra crates."

**Choice.** The property tests P01 to P10 use `proptest` 1.12 as a dev-dependency (as the
build instructions require), with `default-features = false, features = ["std"]` and no
failure-persistence files. The differential test reads `reference/vectors.json` with
`serde_json` (also dev-only; already in `Cargo.lock` through `vicinity-rewards`). Neither is a
dependency of the crate itself: the crate is `#![no_std]`, `#![forbid(unsafe_code)]`, with no
dependency besides `core` (3.1), and no program build sees a dev-dependency. Unit tests U01 to
U10 keep small inline xorshift or splitmix generators.

CI runs 4,096 cases for P01 to P05 and P07 to P09 and 1,024 for P06, P06b, P09b and P10 (about
9 seconds in a debug build). `PROPTEST_CASES=N` overrides every count; the spec's "at least
10^6 cases each" is
`PROPTEST_CASES=1000000 cargo test --release -p vicinity-curve-math --test props`, which passes
for all twelve properties (12 x 10^6 cases, about 76 seconds on the build machine). The first
10^6-case runs found the items recorded in entries 5, 13 and 16.

### 2. `spot_price` takes the terms (5.16)

**Spec.** `spot_price(state) -> (virtual_sol, virtual_tokens)`.

**Issue.** On the curve the virtual reserves are `(x0 + curve_sol, y0 - tokens_sold)`; `x0` and
`y0` are terms, not state.

**Choice.** `spot_price(terms, state)`.

### 3. Every function returns `Result`, including `fee_split` and `quote_buyback` (5.16)

**Spec.** The 5.16 listing shows some return types without `Result` (`fee_split -> FeeSplit`,
`quote_buyback -> Option<...>`), and its last paragraph says "All functions return errors
instead of panicking".

**Choice.** `fee_split -> Result<FeeSplit, MathError>`; `quote_buyback ->
Result<Option<BuybackQuote>, MathError>`, where `Ok(None)` is the no-op of 4.0 and 7.1.

### 4. The quote functions refuse the trades the program refuses (4.11, 4.12, 5.4, 5.5, 5.7)

**Spec.** The program checks `sol_in >= MIN_TRADE_LAMPORTS` before calling `quote_buy`,
`tokens_in >= 1` before `quote_sell`, and `q.tokens_out >= 1` / `q.sol_out >= 1` after the
quote (`ZeroOutput`). The reference model raises the same errors inside its quote and trade
functions.

**Choice.** The crate returns these errors itself (`TradeTooSmall`, `ZeroAmount`,
`ZeroOutput`, `SellExceedsCurve`), in the order of the specification, so that no quote with a
zero output and no `new_state` for a trade that delivers nothing can exist. The program keeps
its own checks (defence in depth); the observable error and its position are unchanged.
Slippage (`min_tokens_out`, `min_sol_out`) stays in the program, as specified.

### 5. A buy that would make the coin's liabilities exceed `u64` is refused (5.12, 6.5, I22)

**Issue.** Found by the property tests: a pool buy of `u64::MAX` lamports keeps
`pool_sol + net` within `u64`, but the coin's liabilities (reserve plus the five buckets) then
exceed `u64`. `pay_out` computes `liabilities_after` for every debit, so in such a state every
later sell, claim, withdrawal and forward would fail with `MathOverflow`: a stuck state.

**Choice.** `quote_buy` ends with a checked `liabilities(new_state)` and returns `Overflow`
when it does not fit. A buy is the only operation that raises the liabilities. This cannot
happen with real money (all SOL in existence is about 5.9 x 10^17 lamports, a thirtieth of
`u64::MAX`), so no real trade is affected. U09 asserts it; P10 asserts that no buy up to 2^59
lamports ever overflows.

### 6. What `State` and `new_state` contain; extra helpers (4.11, 5.16, 6.2, 6.5, 7.2)

**Spec.** 4.11: "write `q.new_state` (curve: `tokens_sold`, `curve_sol`; pool: `pool_sol`,
`pool_tokens`; buckets; `liquidity_pending`; earned counters; `liquidity_added`; `fees_total`;
`buy_volume += charged`; `trade_seq += 1`)" and 4.0: "Handlers do no arithmetic of their own
except checked counter additions."

**Choice.** `State` holds every field of 3.7 that a trade or a buyback writes: the reserves,
the five buckets, `last_buyback_slot`, `trade_seq`, `buyback_count`, `tokens_burned`,
`buy_volume`, `sell_volume`, `fees_total`, the five `*_earned`, `liquidity_added` and
`buyback_spent`. The quotes return the complete new state, so the handlers write it without
arithmetic. On graduation `new_state` is already in phase Pool with `pool_sol = R` and
`pool_tokens = P` (5.6); the handler writes `graduated_at` and `graduation_slot`. The payout
counters (`platform_withdrawn`, `founder_claimed`, `founder_paid_out`, `holders_forwarded`,
`payout_seq`, `last_payout_at`) and the time fields stay with the payout handlers.

Three small public helpers were added so that the program needs no arithmetic of its own:
`liabilities(state)` (the figure `pay_out` uses, 6.5), `depth(terms, state)` and
`buyback_cap(terms, state)` (the `cap` of `BuybackBurned` and the keeper's 1%-of-depth alert,
7.2). `Terms::from_params` computes `total_fee_bps` as the sum of the five shares (4.6).

### 7. `decode_coin`: key type, program id, phase byte (3.7, 5.16, 14.1)

* The crate depends only on `core`, so a public key is `[u8; 32]`:
  `decode_coin(owner: &[u8; 32], data: &[u8])`.
* The owner it requires is the compiled `constants::PROGRAM_ID`: for localnet and devnet a
  throwaway program key generated for this build, `nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk`
  (its keypair is kept outside the repository and is never committed). The program's
  `declare_id!` must use the same key. Mainnet replaces both with the owner's key (3.1).
* Besides owner, length 693, discriminator and `layout_version == 1`, `decode_coin` also
  refuses a `phase` byte other than 0 or 1 (`InvalidPhase`): no other value is a valid coin.
* U10's round trip against the program's Borsh `CurveCoin` struct needs the program crate
  (stage 2). Stage 1 checks every offset of 3.7 with a field-by-field writer in Borsh order and
  the `CurveCoin` discriminator against Python's `hashlib` (the vector file).

### 8. Preconditions and self-checks inside the math (5.1, T14, T15)

The math refuses, with an error and without dividing by zero, any input that breaks a
precondition of 5.1:

* terms (`InvalidTerms`): `total_fee_bps` differs from the sum of the five shares or is not
  below `D`; `virtual_sol == 0`; `virtual_tokens <= curve_supply`; `curve_supply == 0`;
  `graduation_sol == 0`; `curve_value(s)` for `s > S` (5.1 defines `f` on `[0, S]`);
* curve state (`InvalidState`): `tokens_sold >= S` or `curve_sol >= R` in phase Curve.

Each quote also checks what the proofs guarantee before it returns a state: `charged - fee ==
c` (Lemma G), `1 <= c <= n`, `charged <= sol_in`, `spent <= b` (Lemma C1). A failure returns
`InvalidState` instead of writing a state; none is reachable from a config that passes V1 to
V11, and the program maps all of these to `MathOverflow`.

### 9. `validate_config` details (5.13)

* Rules are checked in table order (V1, V2, ..., V8, V9, V10, V11) and the first failing rule's
  error is returned. The reference model's `rules()` does not model V9; the vector generator
  inserts it at its table position.
* Any arithmetic overflow inside a rule fails that rule. None can occur once the earlier rules
  passed (5.12); the arithmetic is checked anyway.
* V7's tolerance is `floor((x0 + R) * P * CONTINUITY_PPB / 10^9)` (the specification's formula
  with `CONTINUITY_PPB = 1`). V11's 38 and 28 are computed as `2 * (K - 1)` from
  `BUYBACK_MIN_HORIZON_RUNS` and `BUYBACK_MIN_HORIZON_RUNS_FOUNDER`; V8's 99 is
  `MEV_MAX_PERCENT`.
* `v8_sides` and `v11_sides` are public, so the margins of 5.13 (613,813,296,968,750,000,000
  against 618,750,000,000,000,000,000; 2,400,937,500 against 2,405,000,000; 2,413,250,000
  against 2,417,850,000) are tested exactly and can be shown off chain.

### 10. V01 to V11 test edges (12.1)

**Spec.** "one test per config rule: only that rule violated gives its error; the edge passes;
the edge plus one fails".

Built exactly for V2 (both caps), V3 (dust 10^9 against 10^9 + 1, both curves derived by
5.9's search), V5 (R = 10^9 and 10^13 against one outside each, and V5b), V6, V7 (the pool one
lamport of `x0` above the curve; and below by `x0 - 40` against `x0 - 41`), V8, V9, V10, V11
and V1's upper edge. Two edges cannot be reached by a config that passes every other rule:
V1's lower edge (`t = 0` also breaks V4's `x0 * t >= C * D`) and V4's bounds (no curve that
passes V5 to V7 has `x0` or `y0` at 2^60, `x0 * t = C * D` or `R * P * t = C * D * 10^15`).
For those the tests show that the edge passes the rule (the error, if any, is a later rule's)
and the edge plus one fails it.

Two consequences of the rules, recorded for review (no change):

* V8 also bounds the total fee from below whenever `b_B > 0`: with only a platform and a
  buyback share, `b_B = 30` needs `t >= 53` (`(0, 23, 0, 0, 30)` passes, `(0, 22, 0, 0, 30)`
  fails V8), because a guaranteed 1% loss needs a fee of about 0.5% per leg.
* Default config #0 sits exactly at V5b's edge: `virtual_tokens - 1` still passes, while
  `virtual_tokens - 2` keeps `f(S) = R` but makes `f(S - 1) = R`.

### 11. `derive_curve` defined precisely (5.9, 5.16)

**Spec.** "A search over `x0` within 20,000 of `x0*` (taking for each `x0` the largest
admissible `d`) gives the minimum at design A's integers."

**Choice.** For every integer `x0` with `|x0 - x0*| <= 20,000` (`x0* = R*P/(S - P)`), take
the largest `d` with exact completion (`ceil(x0*S/R) <= d <= floor((x0*S - 1)/(R - 1))`) and
one-sided continuity (`R*d <= (x0 + R)*P`); keep it if V5b, V6, `x0, y0 <= 2^60` and V7's
tolerance hold; return the `(x0, S + d)` with the smallest continuity gap `(x0 + R)*P - R*d`,
the smallest `x0` on a tie. With no admissible `x0` it returns `InvalidTerms` (the
specification names no error). The same search is in `reference/derive.py`. It reproduces both
integer sets of 5.9: the default `(30,000,853,639, 1,073,025,598,486,615)`, gap 2.0e-12, and
O3 (c)'s `(30,000,855,424, 1,073,025,615,141,714)`, gap 7.9e-12, each a unique minimum (the
smallest absolute and the smallest relative gap agree). `derive_curve_within` takes the radius
as a parameter; the property tests use 64 to generate random valid curves quickly.

### 12. The completing buy whose net is exactly the remainder (5.4, I17)

**Spec.** `charged = (c == n) ? G : floor((c - 1) * D / (D - t)) + 1`.

**Observation.** When a buy's offered net `n` equals the remainder `rem = R - r` exactly, the
buy completes with `c = n` and is charged its full `sol_in`. Because `h(G) = G - floor(G*t/D)`
is flat at some `G`, the least charge with the same net can be one lamport less: at `t = 250`
and `rem = 97,500`, `sol_in = 100,000` is charged 100,000 (fee 2,500) while 99,999 would also
net 97,500 (fee 2,499).

**Choice.** Built as specified, and as the reference model does: the buyer pays exactly the
ordinary fee `floor(sol_in * t / D)` of the amount he offered, never more than 2.5%; the buy
is not partial (`charged == sol_in`), so I17 does not apply. U07 tests both branches.

### 13. P05, P06 and P06b as implemented (5.15, 7.3, 12.2)

* P05 checks `sol_out < charged` (I18) and `sol_out * D^2 <= charged * (D - t)(D - t + 2 b_L)
  + 6 D^2`: 5.15's pool bound (also valid on the curve and across graduation), with 6 lamports
  for the floors of the two fees and the drip remainder.
* P06 checks "never a profit" and Theorem M (canonical: one buy, one sell; the buy leg's
  injection allowance `2 b_L / D` only when the buy is priced in the pool) or the split-leg
  bound (both legs), with `4` lamports of rounding per leg plus 8, for attackers credited
  nothing, the founder share, and the founder and holders shares. V8 credits only
  `m = max(b_F, b_H)`; scanning every share split that passes V1 to V11, the bound with the
  larger credit `(b_F + b_H) / D` peaks at 0.99839 (`t = 98`, `b_L = 0`, `b_F + b_H = 86`), so
  "never a profit" holds for that class too for every valid config, with a margin of 0.16%
  instead of V8's 1%. The spec's figures for that class (canonical -1.89%, multi-leg -1.30%)
  are for the default config.
* P06b computes `(1 + B/X1)^2`, `u*` and `K*` in `f64` (the powers exceed `u128` for K up to
  30) and allows 16 lamports of rounding.
* P06 and P06b draw only configs with `b_B > 0`. A config without a buyback share never
  accrues a backlog, so no run can happen to sandwich; the 10^6-case run showed that an
  injected backlog on such a config (an unreachable state) would break the bound (`t = 1`
  with the whole fee credited back). V8 and V11 apply exactly when `b_B > 0`.

### 14. Tests that belong to the program crate (12.1)

U11 (`check_name`, `check_symbol`, `metadata_uri`) and U12 (the compiled legacy addresses)
test program code, not math, and are written with the program in stage 2, together with U10's
Borsh round trip (entry 7).

### 15. Reference model, vectors and the checks script (Appendix A, 12.5)

* `reference/model.py` and `reference/checks.py` are Appendix A copied verbatim. `python3
  checks.py` prints output byte-identical to the output recorded in the specification
  (compared with `diff`).
* `reference/generate_vectors.py` drives `model.py` (and `reference/derive.py`, entry 11)
  through 30 random coin lives on the default config and on random configs that pass V1 to
  V11 (5,200 operations: launch, buys, sells, partial fills and graduation, pool trades with
  the drip, buybacks on the curve and in the pool, bucket payouts, injected backlogs and
  set-aside liquidity, `max_quote_in`, and every refusal), plus 400 fee splits, 400 gross-ups,
  400 curve values and inverses, 1,500 `validate_config` cases hitting every rule, and 12
  `derive_curve` cases, into `reference/vectors.json`. `model.Coin.check()` runs after every
  operation. The model does not keep `trade_seq`, `buyback_count`, `buy_volume` or
  `sell_volume`; the generator counts them beside it. A gross-up whose result leaves `u64` is
  recorded as an expected `Overflow`. `python3 generate_vectors.py --check` verifies that the
  committed file is what the generator writes.
* `tests/differential.rs` replays the vectors and requires exact equality of every quote,
  every error and all 26 state figures (the 24 state fields, the liabilities and the vault
  balance) after every operation.

### 16. P09b allows the fee's rounding: at most one lamport per trade (5.1, 5.11, 7.5, T12)

**Spec.** P09b: "drip farming from random states under random configs passing V1 to V11,
attacker credited the founder, holder and buyback shares: never a gain".

**Issue.** The 10^6-case run found a gain of 1 lamport for the config `(0, 0, 85, 75, 35)` on the
default curve: no liquidity share (so the drip is always 0 and nothing can be farmed) and no
platform share, with every named share credited back to the attacker. His only cost per leg is
the liquidity rounding remainder, and the fee itself is rounded down, which 5.1 and 5.11 allow
to favour a trader by less than one lamport per trade. Over three trades (one round trip and
the final sell) that came to one lamport, against at least three signature fees of 5,000
lamports in reality (T12).

**Choice.** No change to the math (the rounding is the specification's, R2: never above 2.5%).
P09b asserts that the gain is at most one lamport per attacker trade (plus one), which is the
fee-rounding allowance; any value released by the drip (7.5's refused configs gain 0.1 to
13.7 SOL in the model) would exceed it by many orders of magnitude.

---

Stage 2: the program crate `programs/vicinity-curve` (all 21 instructions), its client IDL
and its builds. Entries 17 to 26.

### 17. Cargo features besides the three of 3.1 (3.1)

**Spec.** "features: `no-idl` (in the crate's default features ...); `devnet` ...; `halt-all`
... No other feature."

**Choice.** The three policy features are exactly as specified: `no-idl` is the only default
feature, `devnet` switches the three compiled ids of 3.2 (`REWARDS_PROGRAM_ID`,
`LEGACY_PROGRAM_ID`, `LEGACY_LAUNCHPAD`; `FEE_RECIPIENT` and every economic constant are the
same in every build), and `halt-all` adds the guard of entry 21. The crate also declares
Anchor's standard tooling features, which change no behaviour of a deployed binary: `cpi` and
`no-entrypoint` (for crates that call the program), `no-log-ix-name` and `idl-build` (used only
to generate the client IDL, entry 24), and `short-windows`, accepted and ignored because the
workspace's CI builds and lints every member with `--features short-windows` (for
`vicinity_rewards`). Unit tests assert `no-idl` is on by default; anchor-syn 0.31.2's
dispatcher then returns Anchor error 1000 `IdlInstructionStub` for the IDL tag (X65).

### 18. anchor-spl needs three more features to compile (3.1)

**Spec.** "`anchor-spl = "=0.31.2"` (`default-features = false`, features `token` and
`metadata`)".

**Issue.** With only those two features anchor-spl does not compile: its `metadata` module
names `spl_associated_token_account` (`error[E0433]`, checked), and the code Anchor generates
for the `init` of a mint (`mint::decimals`, `mint::authority`) names
`anchor_spl::token_interface` and its extension initialisers.

**Choice.** Features `token`, `token_2022`, `token_2022_extensions`, `associated_token` and
`metadata`. None of the extra code is reachable: every mint, token account and token program
in the crate is classic SPL Token (`anchor_spl::token` types, `Program<Token>`), no
instruction takes the associated token program, and the checklist test of entry 25 fails if
`Token2022`, `token_interface` or `AssociatedToken` ever appears in the crate's code. The
versions are pinned as specified: `anchor-lang` and `anchor-spl` `=0.31.2`,
`mpl-token-metadata` `=5.1.1` (what `Cargo.lock` resolves for anchor-spl's `^5`).

### 19. `lto = "fat"` has no effect on this program (3.1, 11.4)

**Spec.** Release profile `overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`,
`opt-level = 3`.

**Issue.** The workspace profile sets all four, but cargo-build-sbf 4.4.0 warns that a package
with two crate types (`cdylib` and `lib`, Anchor's default) "precludes link-time
optimizations". The two deployed programs (`vicinity_rewards`, `vicinity_launchpad`) have the
same two crate types, so they were built without LTO too.

**Choice.** Kept Anchor's default crate types, as in the two deployed programs. Measured: with
`crate-type = ["cdylib"]` alone (LTO then applies) the production binary grows from 587,440
to 635,056 bytes (both measured at commit 965597a, before entry 22 added 776 bytes; opt-level 3
inlines more across crates) and still prints no stack warning.
Whether to drop the `lib` crate type (and with it the `cpi` feature for Rust callers) is left
to the auditors and the owner; it changes no behaviour.

### 20. Binary size and stack (11.4, C03, C04)

Measured on the build machine (Agave solana-cli 4.3.0, cargo-build-sbf 4.4.0, platform-tools
v1.57, rustc 1.97.0 host, `anchor-lang` / `anchor-spl` 0.31.2, `mpl-token-metadata` 5.1.1)
with `npm run vcurve:sbf` at commits 0a6d6d9 to e278593 (the program code does not change between
them; the same three hashes each time):

| build | features | bytes | SHA-256 | stack warnings |
|---|---|---|---|---|
| production | default (`no-idl`) | 588,216 | `9fe330024bab29d4eca56a2a0c58971da590b7e4ac46c4c5f34ae148f13c0f94` | none |
| devnet | `devnet` | 588,216 | `1107b82ff6d1e0c0e7624c4f1f46cbfc3935c091ca3b5c72a4aa9b172699a734` | none |
| halt-all | `halt-all` | 586,880 | `e4d7ab8adc27e4bb8a7326cad1bb64a4e3b1e34bab64c9fb541485565c4d0c2b` | none |

These hashes are for a throwaway program id and a commit that is not frozen; the audit pack
records the hashes of the frozen commit's verifiable build (C03). All three are above 11.4's target of 450 KB. At
5,080 lamports per byte the program data account costs about 2.99 SOL of rent, and an upgrade
buffer (and the halt-all buffer kept ready, 8.3) as much again each. For information only
(opt-level 3 is specified and kept): the production build of commit 965597a with `opt-level = "z"`
for this package alone is 457,208 bytes and with `"s"` 489,584 bytes (587,440 at opt-level 3), at a compute cost not yet
measured. No build prints a cargo-build-sbf "Stack offset ... exceeded" warning, with every
typed account of `launch`, `approve_launch` and `forward_holders_fees` and the coin in every
instruction boxed (3.1). "Typed account" is read as every deserialised `Account<...>`: `Signer`,
`Program`, `UncheckedAccount` and the `Rent` `Sysvar` hold a reference or a few bytes and are not
boxed. CI now builds all three after every push, recompiling the crate so its
warnings are printed, and fails on any stack warning (`npm run vcurve:sbf`, C04).

The binaries depend on the toolchain, not only on the source: the CI runner's Agave 4.3.0
installer brings cargo-build-sbf 4.3.0 (platform-tools v1.57), and its builds of the same source
(commits 0a6d6d9 and 517e7f8, identical hashes) are 612,528 / 612,528 / 611,216 bytes, also
without any stack warning, against 588,216 / 588,216 / 586,880 with cargo-build-sbf 4.4.0 on the
build machine, whose toolchain matches `release/mainnet-2026-10-10/BUILD.md`. The script prints
the `cargo build-sbf --version` it used beside the sizes and hashes; the audit pack must record
the hash of the verifiable build with its toolchain (C03), not a CI artefact.

Compute measured by the litesvm smoke test of the production build (`tests-vcurve/00-smoke.test.mjs`,
`npm run test:vcurve`, run in CI; one coin's life on default config #0; not yet the C01 suite of
stage 3): `launch` 110,776 CU; a curve buy
26,182, a curve sell 23,503, the graduating buy 29,706, a pool buy 25,610; `buyback_burn`
19,938; `withdraw_platform_fees` 12,632; `claim_founder_fees` 13,165; `forward_holders_fees`
plus the top-level `SyncNative` 19,871; `payout_founder_fees` 18,829. Every figure is inside
its 11.1 test budget. The same run reproduced E1 to E3 to the lamport and raw unit (33,774,693.369781
coins for 1 SOL; 950,625,000 lamports back; 87,179,487,179 charged for the completing buy) and
checked I9 (`Coin` lamports equal `rent_reserve` plus the liabilities) after every outflow.

### 21. The halt-all guard runs after Anchor's account validation (4.0, 8.3, H02)

**Spec.** 4.0: with `halt-all` the eight outflow handlers "fail with `TradingHalted` before
anything else"; 8.3: "a few `#[cfg]` lines at the top of eight handlers".

**Issue.** Anchor deserialises and validates the account list (constraints, and the `init` of
`launch`'s new accounts) before any handler code runs. A guard "at the top of the handler"
therefore runs after that validation.

**Choice.** As 8.3 describes: `require_not_halted()?` is the first statement of exactly the
eight handlers (the checklist test of entry 25 asserts it, and that it appears nowhere else),
and without the feature the function is empty and compiles away. In the halt-all build a
transaction with a valid account list fails with `TradingHalted` (6043); one with an invalid
account list fails with the account error first. Either way the transaction reverts and nothing
is created, moved or written. Moving the check in front of account validation would need a
hand-written entrypoint around Anchor's dispatcher, which 8.3 does not ask for and which would
add audit surface to every build.

Checked by the litesvm smoke test of entry 20 on every push (H02 and H03 in miniature; the full
suites are stage 3): the halt-all build deployed over a live coin made `buy`, `sell`, `buyback_burn`,
`withdraw_platform_fees`, `claim_founder_fees`, `forward_holders_fees`, `payout_founder_fees`
and the `launch` of a second approved city fail with `TradingHalted`, left the `Coin`'s bytes
and lamports unchanged while settings instructions (an approval) still worked, and after the
production build was deployed back, trades and the second launch succeeded.

### 22. `pay_out` refuses a destination equal to the `Coin` (6.5)

**Spec.** The helper's code in 6.5 debits the `Coin`, then reads the destination's balance and
credits it.

**Issue.** If a caller ever passed the `Coin` itself as the destination, that code would zero
the bucket, debit and re-credit the same account, and book a payout that moved nothing. No
caller can do so today (the destinations are a signer, the compiled `FEE_RECIPIENT`, a token
account and a system-owned wallet).

**Choice.** The helper refuses `to == coin` with `InvalidAddress` (a check that can only refuse)
and computes both new balances before writing either, so a refusal leaves both untouched. The
lamport move is a private function (`custody::move_lamports`) that the unit tests run on real
`AccountInfo`s; `pay_out` reads the `Rent` sysvar and calls it, as in 6.5. Every other line of
6.5 is unchanged: floor `liabilities_after + min(rent_reserve, live rent)`, `RentFloor` below
it, `MathOverflow` on an overflowing floor or credit.

### 23. Smaller choices in the handlers (4.4, 4.6, 4.11, 4.13, 4.21)

* `set_pause` signed by the admin with all three arguments `None` succeeds, changes nothing and
  emits `PauseChanged` with the unchanged flags (4.4 lets the admin set any flag; it names no
  error for an empty call). The guardian must set at least one flag, as specified.
* `add_launch_config` requires `next_config_id < u16::MAX`, so ids run from 0 to 65,534 and at
  most 65,535 configs exist (`ConfigCount`, "65,535 configs reached").
* `Trade` of the buy that completes the curve has `phase = 0` (where it executed, 4.21), while
  its `*_after` fields describe the market after the trade, which is the new pool:
  `virtual_sol_after = pool_sol = R`, `virtual_tokens_after = pool_tokens = P`. The curve's last
  virtual reserves `(x0 + R, y0 - S)` are in `Graduated` (`last_virtual_sol`,
  `last_virtual_tokens`). A sell's `Trade` has `partial = false` and `graduated = false`.
* `BuybackBurned.supply_after` is read from the mint after the burn CPI (the handler reloads
  the mint account), as 4.21 asks (`mint.supply` after the burn).
* `transfer_founder` to the same key and `opt_in_payout` while payouts are paused are allowed
  (4.17 and 4.18 name no check for either); a paused payout key still cannot pay (4.20).
* The math crate's trade refusals keep their names (`TradeTooSmall`, `ZeroAmount`,
  `ZeroOutput`, `SellExceedsCurve`); every other math error is `MathOverflow` (entry 8). The
  handlers keep their own checks in the order of section 4 before the quote and after it, so
  the error a client sees is the one section 4 names.

### 24. The client IDL (8.4, 14.3)

The deployed binary has no IDL instructions (`no-idl`), so the IDL JSON is generated from the
source with Anchor's `idl-build` feature, the same step `anchor build` runs, and committed at
`sdk/idl/vicinity_curve.json` (21 instructions, 6 accounts, 21 events, 51 errors (53 since
entries 42 and 43), every
`#[constant]` with its compiled value). It is the default build's IDL: the mainnet ids of
`vicinity_rewards` and the old `vicinity_launchpad`; the devnet build differs only in the
values of `REWARDS_PROGRAM_ID`, `LEGACY_PROGRAM_ID` and `LEGACY_LAUNCHPAD`. Its `address` is
the throwaway localnet/devnet key (entry 7); mainnet regenerates it after the owner's key is
put in `declare_id!`. `npm run vcurve:idl` regenerates the file and `npm run vcurve:idl:check`
diffs a fresh build against it; CI diffs the IDL that `anchor build` writes against it, as for
the other two programs. The constants `REWARDS_CITY_CONFIG_DISCRIMINATOR` and
`REWARDS_MODEL_HOLDERS` of 3.2 describe `vicinity_rewards`' layout rather than policy and do
not carry `#[constant]`, so they are not in the IDL.

### 25. Review checklist tests (4.0, 4.21, 6.5, 8.3, section 4)

`src/checklist.rs` (test only) checks rules that no unit test of a single function can:

* source rules, read from the instruction files as text: the halt-all guard is the first
  statement of exactly the eight outflow handlers; `pay_out` is called once by each of the five
  debits of 6.5 and by no other instruction, after `liabilities()` of the updated state, and no
  CPI follows it except the event CPI (rule of 4.0); no module but `custody.rs` writes lamports;
  the eight money instructions emit by event CPI and the thirteen settings instructions by
  `emit!`; no `init_if_needed`, remaining accounts, token approve, revoke, close, freeze or thaw
  anywhere; `mint_to`, `set_authority` and the Metaplex CPI only in `launch`; `burn` only in
  `launch` and `buyback_burn`; `transfer_checked` only in `buy` and `sell`; system transfers
  only in `launch` and `buy`; `close =` only on the approval and the opt-in;
* who reads and writes `Launchpad`: `buys_halted` is read only by `launch`, `buy` and
  `buyback_burn`, `launches_paused` only by `launch`, `payouts_paused` only by
  `payout_founder_fees`; no exit reads any flag (`sell` takes `Launchpad` as an unchecked
  account checked by address); the flags are written only by `init_launchpad` (all false) and
  `set_pause`, the payout key and wallet only by `init_launchpad` (zero, so payouts start off)
  and `set_payout_config`, the guardian only by `init_launchpad` and `set_guardian`, the admin
  seat only by `init_launchpad`, `propose_admin` and `accept_admin`;
* the frozen fields of a `Coin` (identity, the six fee fields, the curve terms, `dust_burned`,
  `meta_hash`, `rent_reserve`, `launched_at`, `launch_slot`) are written once, in `launch`, and
  by no other instruction; the phase only through the math crate's state; the founder only in
  `transfer_founder`; the graduation fields only in `buy` (I1, I2);
* the instruction contract against the committed IDL: every instruction's accounts in the order
  and with the signer and writable flags of its table in section 4, `buy` and `sell` sharing
  one list of 10 accounts, every instruction's arguments and `ConfigParams`, the
  instruction, account (`CurveCoin`) and event discriminators, the 21 events, the 51 error
  codes (53 since entries 42 and 43) and the compiled ids of the default build.

They are text and data checks, not proofs; the litesvm suites of stage 3 exercise the same
rules on the real binary (H02, R02, R02b, L01 to L13, X01 to X65).

### 26. CI additions

`.github/workflows/solana.yml` gains, for `vicinity-curve` only: clippy (`-D warnings`) and the
unit tests with `--features devnet` and with `--features halt-all`; the diff of the committed
IDL against `anchor build`'s; the three SBF builds with the stack check of entry 20; and the
litesvm smoke test of entries 20 and 21 (`npm run test:vcurve`). The existing programs' steps,
IDLs and binaries are unchanged.

---

Stage 3: the client SDK `sdk/curve` and the litesvm lifecycle suites `tests-curve`. Entries 27
onwards.

### 27. The suites load the mainnet binaries of the two deployed programs (3.2, 12)

**Spec.** 3.2: "The localnet test suite loads `vicinity_rewards` and the old `vicinity_launchpad`
builds at their mainnet addresses (litesvm can place a program at any address), so the binary the
tests exercise is the mainnet binary".

**Issue.** litesvm can place a binary anywhere, but an Anchor program refuses to run at an address
other than its own `declare_id!` (`DeclaredProgramIdMismatch`), and its account types check that
same id as owner. The builds in `target/deploy` carry the devnet ids
(`Hm14pF...` and `Fncx4q...`), so they cannot serve at `EVwxp3V9...` and `AkMP9q...`, the ids the
production build of `vicinity_curve` compiles in.

**Choice.** `tests-curve` loads the committed mainnet release binaries,
`release/mainnet-2026-10-10/vicinity_rewards.so` and `vicinity_launchpad.so` (the bytes deployed on
mainnet, BUILD.md), at their mainnet addresses, after checking each against that directory's
`SHA256SUMS`, and `target/deploy/vicinity_curve.so` (the production build of `anchor build`;
`VCURVE_SO` overrides). So the program under test is the production binary and both programs it
talks to are the mainnet programs: `forward_holders_fees` credits a vault made by the real
`init_city`, the real `fund_epoch_from_vault` books it and a holder claims with a Merkle proof (R01),
and the old program's `Launchpad`, `Approval` and `Coin` are made by the old program itself (its
`init_launchpad`, `set_pause`, `approve_launch` and, through Meteora DBC, `launch`). The Metaplex and
DBC dumps come from `scripts/launchpad/fetch-fixtures.sh`, and the suite checks their pinned
SHA-256 again. The stage 2 smoke test (`tests-vcurve`) keeps its crafted accounts.

### 28. Where the SDK and the suites live, and how the SDK is checked (14.1, 12.5 G01)

*Superseded in part: the G01 volume and F01's differential run it leaves open are done (entries 37
and 38); the directory names stand (revision 3 of the specification uses them).*

**Spec.** 14.1 calls the SDK module `sdk/vcurve/`; G01 asks for golden vectors exported by the Rust
crate and parity "to the lamport on 10^4 random trades".

**Choice.** The SDK is `sdk/curve/` and the suites `tests-curve/`, as the build instructions name
them (`tests-vcurve/` keeps the stage 2 smoke test). Plain ESM with BigInt, no Anchor at run time:
the account lists of section 4 are written out in `instructions.mjs`, and the decoders read fixed
offsets. Three checks keep it honest. `sdk/curve/math.test.mjs` replays every operation of the
crate's golden vectors (`reference/vectors.json`, 5,200 operations over 30 coin lives, plus the fee
split, gross-up, curve, `validate_config` and `derive_curve` vectors) and requires every quote,
error and all 26 state figures to be equal; `sdk/curve/idl.test.mjs` compares every constant,
discriminator, error code, account list, flag and argument encoding with the committed IDL and
Anchor's own encoder, and the decoders with Anchor's encoding; and `tests-curve` replays every
transaction of every test through the port (entry 29), so every on-chain trade and buyback of the
suites is a parity case against the program's real results. The suites do far fewer than 10^4
trades; the remaining G01 volume and F01's 10^5-step differential run are not part of this stage.
The vector file is generated by the Python reference model, which the Rust crate replays exactly
(`tests/differential.rs`); the port is checked against the same file rather than against a second
file exported by Rust.

### 29. The invariant checker and money-flow tracer, as built (9, 12 intro, L13)

`tests-curve/invariants.mjs` runs after every successful transaction of every test (and checks that
a failed one moved nothing but the fee payer's fee and changed no `vicinity_curve` account). Its
readings of section 9, where the text needed one:

* **I13, I14 (SOL).** Every lamport change of every account in the message must be explained by
  the fee (5,000 lamports per signature), the system instructions that executed (top level and
  every CPI), native-token transfers that executed, the money events of `vicinity_curve` (each to
  its fixed destination of 6.4, with the amounts of the events) and Anchor's closes. I14 says "the
  only program-owned account whose balance fell is the Coin"; Anchor's `close` of an `Approval`
  (`launch`, `revoke_approval`) or a `PayoutOptIn` (`revoke_payout_opt_in`) also lowers a balance
  owned by the program, to zero, with the rent going to the pinned `rent_payer` or the opt-in's
  founder: the checker allows exactly these closes and nothing else. Programs the suite does not
  test (the old program, `vicinity_rewards`, Meteora DBC) may move lamports directly among the
  accounts of their own top-level instructions (their own closes); those residuals must sum to
  zero and may never touch a `vicinity_curve` account.
* **I21.** No credit to the admin, the guardian, the payout key, the upgrade authority or the keeper
  from any source but themselves, with one exception: the rent of an `Approval` returns to its
  `rent_payer`, which `approve_launch` sets to the admin (4.8, 4.9). That is the admin's own rent
  coming back, not a money path; the checker allows it and nothing else.
* **G01 parity, I12, I15, I16, I17.** For each coin the transaction's events are replayed in order
  through the SDK's math port from the state before: every quote, fee share, drip, after-figure,
  buyback amount and payout amount must equal the port's, and the replayed state (all 24 trade
  fields and the payout counters) must equal the account afterwards.
* **I2.** The frozen fields are compared byte for byte with the account as `launch` wrote it, after
  every transaction.
* **I22.** The liveness probe runs by simulation (nothing committed) after every successful
  transaction and at the end of every test, not only every 100th step of F01: a buy of
  `max_quote_in` on the curve succeeds and graduates; every holder the world knows can sell what he
  holds (unless the output would be 0, or he holds 0 lamports and the payout is below the rent-exempt
  minimum); withdraw, claim and (with a correct rewards config) forward succeed; a due buyback burns
  or the curve sits at `f(S - 1)`; anyone can revoke an expired approval. Buys and buybacks are
  skipped while buys are halted, everything while the halt-all build is loaded.

### 30. Compute units and transaction sizes, measured (11.1, 11.3, C01, C02)

Measured by `tests-curve/12-compute.test.mjs` and `04-launch.test.mjs` on the production build of
`anchor build` (`target/deploy/vicinity_curve.so`, SHA-256 `9fe33002...` of entry 20: the program
code has not changed since stage 2; litesvm 1.5.0). The figure is the
instruction's own consumption from the runtime's "consumed" log line; every one is inside its 11.1
test budget, which the test asserts.

| instruction | measured CU | 11.1 estimate | 11.1 test budget |
|---|---|---|---|
| `buy` on the curve | 26,032 to 26,075 | 31,000 to 42,000 | 48,000 |
| `sell` on the curve | 23,353 to 23,619 | 28,000 to 39,000 | 48,000 |
| `buy` that graduates (partial fill) | 29,556 | plus 3,000 to 6,000 | 55,000 |
| `buy` in the pool | 25,460 | 31,000 to 42,000 | 48,000 |
| `sell` in the pool | 23,505 | 28,000 to 39,000 | 48,000 |
| `buyback_burn` on the curve / in the pool | 20,342 / 19,788 | 26,000 to 35,000 | 48,000 |
| `withdraw_platform_fees` / `claim_founder_fees` | 12,482 / 13,015 | 12,000 to 18,000 | 25,000 |
| `payout_founder_fees` | 18,679 | 15,000 to 22,000 | 30,000 |
| `forward_holders_fees` (the top-level `SyncNative` after it: about 200 more) | 27,020 | 20,000 to 32,000 | 40,000 |
| `launch` | 110,635 to 125,867 | 125,000 to 190,000 | 230,000 |
| `launch` + idempotent token account + first `buy`, one transaction (total) | 165,470 | 175,000 to 260,000 | 400,000 suggested |
| `approve_launch` | 22,107 | 5,000 to 30,000 | 50,000 |
| `add_launch_config`, `set_launch_config_enabled`, `set_pause`, `set_guardian`, `opt_in_payout`, `transfer_founder` | 14,798, 6,054, 3,851, 3,772, 13,654, 6,552 | 5,000 to 30,000 | 50,000 |

`launch` and `forward_holders_fees` vary from city to city by a few thousand units: both derive
PDAs whose bump search depends on the city (the Metaplex metadata of the mint; the rewards config
and vault of the mint). The website should keep using 1.2 times the simulated figure, as 11.1 says.

Transaction sizes (C02): the website's buy (compute-unit limit and price, idempotent creation of
the buyer's token account, `buy`) is 555 bytes, its sell (limit, price, `sell`) 513 bytes; `launch`
alone 920 bytes (founder and payer the same key); `launch` + token account + first `buy` 1,031 bytes
without a lookup table and 786 bytes with the table of 11.3 (System, Token, associated token,
Metaplex and Compute Budget programs, the rent sysvar, the event authority, `vicinity_curve`,
`FEE_RECIPIENT`, `Launchpad`, `LEGACY_LAUNCHPAD`, config #0). The 11.3 estimates were 550 to 590,
950 to 1,050, 1,100 to 1,200 and 800 to 900 bytes; the combined launch fits the 1,232-byte limit even
without the table (201 bytes to spare with one signer), so the table is a margin, not a necessity.

### 31. X31 forced by editing the Coin rather than by a test-only build (12.4 X31, 6.5)

**Spec.** X31: "rent floor (forced by a test-only build that skips bookkeeping, proving `pay_out`
refuses)".

**Choice.** No program code was added for tests. `tests-curve/13-checker.test.mjs` edits a live
`Coin` out of band so that its liabilities exceed its lamports by one (`founder_pending + 1`), then
shows that `claim_founder_fees`, `withdraw_platform_fees` and `sell` all fail with `RentFloor` and
that nothing moves (the failed-transaction check). That is the state a bookkeeping bug would leave,
and the refusal comes from the same `pay_out` floor; a separate test-only build would only add a
binary that is not the audited one.

### 32. The first attack tests, and what they do not yet cover (12.4, 12.5 F02, 14.3)

*Superseded: the attack tests of 12.4 are entry 33, F02 in full is entry 38, and the X02 and X04
cases this entry left partial are completed in entry 48.*

`tests-curve/14-attacks.test.mjs` covers part of 12.4 with the World and its checker (every failed
transaction is checked to have moved nothing but the fee):

* **X01, X02, X04, X05, F02 in miniature.** Every slot of `buy`, `sell`, `buyback_burn`,
  `withdraw_platform_fees`, `claim_founder_fees`, `forward_holders_fees` and
  `payout_founder_fees` that is not a signer is replaced in turn by plausible wrong accounts
  (another coin, its vault and mint, the old program's `Coin` bytes under the old program's id and
  under `vicinity_rewards`' id, Token-2022, System or `vicinity_curve` in program slots, WSOL, a
  random key, the admin as fee recipient, another coin's rewards accounts and opt-in). All of them
  (more than 80) are refused. One substitution is not an attack and is skipped:
  `withdraw_platform_fees` is permissionless and its every other account derives from the coin, so
  naming another coin is that coin's own legitimate withdrawal. Signer slots are not substituted:
  another signer is another legitimate caller, whose own authority checks L01 to L12 test. F02 in
  full (random fuzz over every instruction, 10,000 runs) is still open.
* **X58 (14.3, T58).** A seller or founder holding 0 lamports: a payout below the rent-exempt
  minimum of an empty account fails with `InsufficientFundsForRent` and moves nothing; a larger one
  is paid. The I22 probe applies the same rule (a holder or founder with 0 lamports is not expected
  to receive less than that minimum), and its simulations take the fee from the world's payer when
  the signer cannot pay it, so the probe tests the instruction, not the fee.
* **X32, X33, X65** as 12.4 states them.


### 33. The attack tests of 12.4, what litesvm cannot test, and what they measured (12.4, section 10, 7.3, 7.5, T63, T76)

`tests-curve/15-attacks-accounts.test.mjs` to `20-attacks-runtime.test.mjs` add one test (or one
block of a test) per testable threat of section 10. Every refusal goes through `World.send`, so the
failed-transaction check asserts that nothing moved but the fee payer's fee and that no
`vicinity_curve` account changed; each test also compares the bytes and lamports of the accounts it
attacks, and victims never pay the fee, so their balances must be exactly unchanged.

| file | threats |
|---|---|
| 15 accounts | X03 fake mint, X06 metadata address, X29 re-init of every account, X30 close and revival, X36 (closest shape), X37 metadata edit, X38 Unicode, X39 authorities, X54 aliased accounts, X55 pre-funded PDAs, X60 (closest shape), X64 |
| 16 trading | X13 zero outputs, X14 overflow, X15 zero denominators, X16 every partial-fill edge, X17, X18, X19, X20, X21, X22, X40, X41, X42, X57 |
| 17 economics | X07, X08 donations against a twin coin, X09, X12 tiny trades on the curve, X10 in the pool, X11 round trips, X28 dust sells, X27 and X27b drip farming |
| 18 buyback | X23 bundled, X24 canonical sandwich (and founder credited), X25 multi-leg bundle and the hold through K runs (T76), X26, X61 |
| 19 admin | X34, X35, X43, X43b, X44, X45 (closest shape), X46 (closest shape), X47 with the other cluster's id, X48, X49, X50, X51, X52, X53 |
| 20 runtime | X56 (closest shape), X59, X62 (closest shape), X63 |

**Not testable in litesvm, and the closest shape tested instead.**

* T36 look-alike tokens outside the program cannot be prevented on Solana. X36 makes a perfect
  look-alike for real (a classic mint with 6 decimals and Metaplex metadata with the official name,
  symbol and even the official URI): every instruction refuses it, and only the registry (the
  `Coin` and `TickerLock` owned by the program) tells the two apart.
* T45 (a stolen admin key approving many cities) and T46 (a malicious upgrade) are process (Squads
  2 of 3, time lock, monitoring). X45 tests the on-chain limits: approvals expire within 30 days, an
  expired one cannot launch and anyone may close it, one approval per city, a `LaunchApproved` event
  for every approval. X46 shows that a stranger can neither upgrade the program (with his own buffer
  or the authority's) nor take its upgrade authority, while the authority's own redeploy works; the
  halt-all build over live state is H03.
* T56 and T60 need an attacker program deployed in the VM, which the suite does not build. X56
  shows that a forged event instruction is refused alone (not signed by the event authority) and
  sinks any transaction it rides along with, and that the SDK decoder accepts a money event only as
  the program's own event CPI. X60 shows that every money instruction calls only System, SPL Token,
  Metaplex (in `launch`) and its own event CPI, and that every program slot refuses other real
  executables (`vicinity_rewards`, the old program, Metaplex, itself) before any CPI.
* T62 (launch sniping), T52 and T53 (founder key theft or loss) and T20 (pool pre-creation) are
  design; X62, X52, X53 and X20 test the properties the design relies on. T66, T68 and T74 are
  outside the program and not tested.
* Where an attacker cannot create a state, the tests create it out of band to reach the check
  itself: an `Approval` for a launched city (X29, to meet plain `init` on the `Coin`), field edits of
  the real rewards config and vault (X47 to X49, in the style of TE10 to TE13), loader buffers (X46),
  a whale holding 1.5 million SOL (X13), a fake and an immutable ProgramData (X64).

**What the tests measured (no program bug was found).**

* X24 canonical sandwich, best result over 0.0001 to 50 SOL: curve 0.95253 (Theorem M: 0.95253),
  pool 0.95894 (0.96230); the founder credited his share 0.96550 (0.97223), credited his and the
  holders' shares 0.97540 (never a profit). X25 multi-leg bundles: curve 0.95244, pool 0.95951
  (split-leg bound 0.95253 and 0.97217).
* T76 hold-through (X25), a 0.1 SOL attacker and no other trade: on the curve with a backlog of
  0.948 SOL (3.15% of depth) a loss through K = 25 runs, the first profit at K = 26, and +1.14% when
  held until the backlog was spent (32 runs); in a pool with a backlog of 20.9% of depth the first
  profit at K = 26 and +7.15% after 60 runs. Every result is within Theorem M_K. This is the residual
  risk of O25: the keeper's runs every interval and the backlog alert of 7.2 and 14.1 are the
  mitigation.
* X27 drip farming by the founder holding the whole float, credited the founder, holders and buyback
  shares of his legs, against selling at once: -0.098 SOL (12 round trips of 1 SOL), -0.626 SOL
  (4 of 20), -0.883 SOL (2 of 60) on the default config; -0.173 SOL (8 of 5) and -0.551 SOL (3 of 50)
  on the V10 edge (50, 51, 50, 50, 30).
* X09 and X12: 60 trades of 100,039 lamports (30 buys, 30 sells packed 10 per transaction) saved 42
  lamports of fee rounding against one round trip of the same size, and cost 165,000 lamports of
  signatures; X10 in the pool saved 28. X11: the best curve round trip returned 0.95063 (the 0.0001
  SOL buy: two fees each rounded down by under a lamport), the best pool round trip 0.95741.
* X63, the Rent sysvar raised by 10% (a `Coin`'s minimum from 5,714,160 to 6,285,576 lamports): every
  exit of a coin with ordinary liabilities works, because `pay_out` floors at `min(rent_reserve, live
  rent)`. A coin with 650,000 lamports of liabilities is still exempt, but a sell paying 617,906
  lamports would leave it below the new minimum, and the runtime's rent-state rule (an exempt
  account may not become rent-paying) refuses it with `InsufficientFundsForRent`; a top-up of
  571,416 lamports by anyone lets the same sell through. So T63's "a rent increase cannot block
  exits" holds for the program's own floor, while the last exits of a nearly empty coin need a top-up,
  as X63 states; the keeper should top up coins below the live minimum after a rent change. litesvm
  1.5.0 accepts a credit (a 0.0001 SOL buy) into an untraded coin that stays below the new minimum.
* For the checker's owner: `checkFailedTransaction` charges every failed transaction its fee, but a
  transaction refused before execution (a missing or empty fee payer) pays none; X61 sends that case
  through LiteSVM directly. *Resolved by entry 47.*
* Graduation-boundary sandwiches (file 17): a victim whose own price impact is below twice the fee
  (a 0.3 SOL buy at 80 SOL raised, 0.53%) cannot be sandwiched at a profit at any front-run size; a
  victim with 5.39% impact (3 SOL) and 1% slippage can be, by at most 0.000753 SOL, within his
  tolerance (5.15); a front-run that takes the curve past graduation is refused against the victim's
  minimum and loses 0.33 SOL. A backlog the founder makes himself by wash trading (0.95 SOL on the
  curve, 2.85 SOL in the pool) and holds through every run loses 6.3 to 18.1 SOL (7.3); founder wash
  trading loses 2.00% of its volume on the curve and 1.95% in the pool (7.4).

* X44, the most hostile configs that V1 to V11 still accept, each through a whole life with the
  checker after every transaction: graduation at 10,000 SOL (x0 = 3,529.5 SOL), a pool of 999 coins
  (x0 = 0.085 SOL: a 1 SOL first buy takes about 92% of the curve, which is the config's economics,
  not a defect), a 0.01% fee to the platform only, and a 1.5% buyback with a 1% founder share. Round
  trips lose, the founder's sandwich of his own buyback loses 0.28 to 0.39 SOL, and after the whole
  float is sold back the pool keeps at least `R * P / 10^15` and a buyback cap of at least one
  lamport (T69).

**Observations for the auditors (no change made; each matches the specification as written).**

* Any sender may mark any account he names writable, so an attacker can take write locks on the
  `Launchpad` in his own transactions; every `buy` and `buyback_burn` reads it (`buys_halted`), and
  `sell` names it to keep one account list. Trades never write it (X42 checks the bytes), so this is
  only scheduler contention across all coins, the usual cost of one global halt flag.
* `user_token_account.owner != coin` (T54) excludes the token accounts of this coin's PDA only; a
  buyer may still deliver coins to a token account owned by another program's PDA (another coin's
  PDA included), from which they can never move. That harms only the sender.
* `check_payout_keys_separate` (4.5) kept the payout key and wallet apart from the admin and
  `FEE_RECIPIENT` but not from the guardian, so the admin could name the guardian (whose table row
  in 8.1 says it cannot touch money) as the payout wallet. *Resolved by entry 43 (review GOV-2):
  the rule now takes the guardian, `set_guardian` runs it, and `FEE_RECIPIENT` can hold no role.*

### 34. The checker's last gaps: I14 destinations, I21 tokens, I5 and I6 per step, I20 at run time (9, 12 intro, L13)

Entry 29 describes the checker. Four readings were added, and
`tests-curve/20-checker-gaps.test.mjs` (now `27-checker-gaps.test.mjs`, entry 48) breaks each one on
purpose and requires the checker to fail:

* **I14 destinations.** Explaining every lamport difference is not enough: an extra transfer from
  the payer inside `launch` is explained by its own system instruction. Every inner instruction of
  a `vicinity_curve` instruction must now go to System, SPL Token, Metaplex (only in `launch`, only
  CreateMetadataAccountsV3, and inside it only System) or the program's own event CPI. Every system
  instruction inside one is pinned: an account creation (or Anchor's transfer, allocate and assign
  over a pre-funded address) only to an account that very instruction creates by its table
  (`CREATES` in `invariants.mjs`: the Launchpad, a LaunchConfig, an Approval, the Coin, its mint,
  vault and TickerLock, a PayoutOptIn), from that instruction's payer and for at most the rent of
  what it creates; any other transfer only to the Coin (a `buy`'s `charged`), `FEE_RECIPIENT` (the
  launch fee) or, inside Metaplex's CPI, the metadata account it creates (its rent plus Metaplex's
  0.01 SOL fee, 3.10). The associated token program's top-level creations are pinned to the token
  account they create. Changing one destination of a real `launch` or `buy`, or adding a foreign
  CPI, fails the checker.
* **I21 tokens, enforced on the tests as worded.** I21 says no instruction *in any test* moves
  lamports or tokens to the admin, the guardian, the payout key, the upgrade authority or the
  keeper. The program cannot enforce the token half: a buy delivers to any token account of the
  mint that the `Coin` does not own (14.3), so a role key can buy coins with its own SOL like anyone
  else. The checker refuses any coin leaving a vault for a token account whose owner, delegate or
  close authority is a role key (the World's, plus whatever the Launchpad names as admin, pending
  admin, guardian or payout key before or after the transaction). No suite does this; the test does
  it on purpose (the admin's and the guardian's token accounts, a buyer's account delegated to the
  keeper). The program property behind I21, that no program path pays a role key, is the SOL
  tracer of entry 29.
* **I6 and I5 per step.** I6 is checked after every `Trade` and `BuybackBurned` event of a coin in
  its pool phase, in event order, from the events' own after-figures. A transaction with several
  instructions is therefore checked at every step, not only at its end (the test puts the
  graduating buy, two pool trades and a buyback in one transaction). I5's `vault == P` is checked
  explicitly at the end of the instruction that graduates, from the vault balance after each
  instruction.
* **I20 at run time.** The ELF of `vicinity_curve`, `vicinity_rewards` and the old program must be
  the bytes the World loaded, before and after every transaction, successful or failed. The ELF is
  the ProgramData after its 45-byte header; the header holds the upgrade authority, which X64
  edits. At every load the World also checks the compiled ids (3.2): the program id, its cluster's
  `REWARDS_PROGRAM_ID` and `LEGACY_PROGRAM_ID` and the Metaplex id appear in the binary as 32-byte
  strings, and the other cluster's `REWARDS_PROGRAM_ID`, `LEGACY_PROGRAM_ID` and `LEGACY_LAUNCHPAD`
  do not. `FEE_RECIPIENT` and the cluster's own `LEGACY_LAUNCHPAD` are compared against immediates
  in the code (the compiler splits each comparison into four 64-bit constants), so a byte search
  cannot find them; their run-time witnesses are the tracer (every launch fee and withdrawal reaches
  `FEE_RECIPIENT`) and `03-approvals` (the account at `LEGACY_LAUNCHPAD` is read at every approval
  and launch). C03 remains the static check of the build's ids.
* **CPI callers.** The checker follows calls into `vicinity_curve` from other programs (G02's
  router, entry 40), each with its own inner instructions, events and depth.
* **A harness defect found by the long F02 run** (seed 7, step 22,047; fixed in 05c145c). The
  snapshot read a coin's vault and mint only when its Coin, vault or mint was in the message, while
  the per-coin checks also covered a coin named only by its metadata account (an invalid `launch`
  variant). The check then failed on a missing vault reading. Snapshots now cover the same four
  accounts, and a regression test reproduces the case. It was a defect of the checker, not of the
  program.

### 35. I18 as tested: the clause about spot value is false for any constant-product market (9 I18, 12.2)

The first clause of I18 (a buy followed by a sell of the coins bought returns less than was
charged) is P05. The second clause says no address ends a random sequence with more SOL plus coins
valued at the final spot price than it started with. As worded it cannot hold for a
constant-product market. A position marked at the marginal price right after the buy that made it
is worth more than it cost (the convexity term `n^2 / X`), and a net seller's coins are worth less
at the price its own sell pushed down. `crates/vicinity-curve-math/tests/no_free_value.rs` keeps the
counterexample (`literal_spot_valuation_is_not_a_property`): from launch on config #0, a 1 SOL buy
gets 33,774,693,369,781 raw coins, worth 1,006,686,598 lamports at the new spot price but only
950,625,000 when sold. With several traders an early buyer also gains, legitimately, from later
buyers.

What is tested instead is free value in the two senses in which it could exist. Coins still held
are valued at what they sell for at the final state (at most their spot value less the fee):

* **P11a, one address alone.** Start from any reachable state: a random prefix of other traders'
  operations, injected set-aside liquidity included, then the buyback backlog run down so that no
  backlog of others can flow to the address. An address that arrives with SOL only then runs a
  random sequence of buys (partial fills and graduation included), sells, pool trades with drips and
  buyback runs. It never ends with more than it came with, with no allowance: the fee's rounding in
  the trader's favour (under one lamport per trade) never outweighs the shares it pays.
* **P11b, all addresses together.** From launch, four addresses (the first is the founder) buy,
  sell, run buybacks and collect payouts in random order, then each sells everything it holds.
  Together they never end with more than they came with, net of the founder fees received.

CI runs 2,048 cases of each. `PROPTEST_CASES=1000000 cargo test --release -p vicinity-curve-math
--test no_free_value` runs 10^6 of each and passed (108 s). On chain,
`tests-curve/25-no-free-value.test.mjs` runs the same two properties in litesvm with the checker
after every transaction. The lone address trades on random configs from reachable states. The
group trades from launch and also sends coins to each other and receives SOL gifts from outside,
which are subtracted. CI runs 6 and 4 sequences; `VCURVE_I18_RUNS` raises the number. The
specification should restate the second clause as P11a and P11b.

### 36. 14.3 misses a third runtime condition; the SDK pre-checks and `initRewardsForCoin` (14.3, T58, 4.15, R03, 14.1)

14.3 names two runtime conditions that make a correct transaction fail: the buyer must be a
system-owned account without data, and SOL paid to an account holding 0 lamports must be at least
`rent_min(0)`. A third one follows from the same rent-state rule: **a buyer may end with 0 lamports
or with at least `rent_min(0)`, never with anything in between.** A rent-exempt wallet may not
become rent-paying, so a buy that leaves 1 lamport in it fails with `InsufficientFundsForRent`.
Spending the whole balance, or leaving exactly the minimum, passes (`21-sdk-prechecks.test.mjs`
measures all three on the real runtime). The rule applies at the end of the transaction, so a buy
and a sell bundled together are judged by the wallet's final balance (the F01 model applies it that
way). No program change is needed; 14.3 should list the third condition.

`sdk/curve/prechecks.mjs` checks all three on account snapshots before a transaction is built and
fails with a `PrecheckError` naming the reason: `BuyerHoldsNoSol`, `BuyerNotSystemAccount`,
`BuyerCarriesData`, `BuyerCannotPay`, `BuyerLeftBelowRent` for buys (`precheckBuyer`,
`precheckBuy`), and the 0-lamport rule (`BelowRentExemptMinimum`) for a sell's `user`, a claim's
founder and a payout's wallet (`precheckSolCredit`, `precheckSell`, `precheckClaim`,
`precheckPayout`). In litesvm the SDK refuses exactly the transactions the runtime refuses, around
the boundary on both sides.

`sdk/curve/rewards.mjs` adds `initRewardsForCoin` (R03's last clause). `vicinity_rewards` writes a
config's economics only in `init_city` and cannot close one, so a wrong config makes
`forward_holders_fees` fail for that coin forever. The function therefore builds `init_city`,
simulates it, decodes the CityConfig the simulation would write and runs the program's own two rules
on it (`check_rewards_config` and the authority rule, with the admin read from the Launchpad) before
it returns anything to propose. An existing correct config needs nothing, and an existing wrong one
(or one with an authority transfer pending) is reported as unfixable (`RewardsConfigError`).
*Superseded by entry 46: a pre-funded config address is no config, and authority-only problems are
reported as fixable (`AuthorityNotAdmin`).* The
tests run it against the real `vicinity_rewards` in litesvm and over a fake chain, and the config it
proposes carries the holders' money.

### 37. G01 at full scale: vectors exported by the Rust crate, replayed by the port and by the program (12.5 G01)

This completes entry 28, which left the 10^4-trade volume of G01 open.
`crates/vicinity-curve-math/tests/g01_vectors.rs` generates `reference/g01-vectors.json` from a
fixed seed and requires the committed file to equal it byte for byte (`G01_WRITE=1` rewrites it).
The file holds 46 coin lives on config #0, on random shares and on random curves from 5.9's search:
10,145 trades (20 partial fills, 31 graduations, 5,252 pool trades with drips), 1,298 buyback runs
and the three payouts, with every error. Each operation is one line with every figure and an
FNV-1a digest of the 24 state fields after it. Every third life stays on the curve so that both
phases carry volume.

`sdk/curve/g01.test.mjs` replays every operation through the JavaScript port.
`tests-curve/22-g01-onchain.test.mjs` sends every operation to the program as the transaction it
describes: each life is launched on its config at its slot, buys and sells come from four holders,
buybacks run at the recorded slots, and withdrawals, claims and forwards go into a real
`vicinity_rewards` vault. Each event must carry the vector's numbers, each refusal the vector's
error, and the Coin must hash to the vector's digest after every operation. The checker runs after
every transaction (also comparing each event with the port), and the I22 probe runs at the end of
every life. A fresh World every 8 lives keeps the checker fast (about 16 ms per transaction), and
holders are topped up out of band, which is not a donation to any program account.
`VCURVE_G01_LIVES=n` replays only the first n lives. The three implementations agree on every
figure.

### 38. F01 and F02 at full scale: a seeded fuzz with a model side by side (12.5 F01, F02)

`tests-curve/fuzz.mjs` (driven by `23-fuzz.test.mjs`) picks a random action at every step from a
seeded generator:

* trades of every size (below the minimum, dust, the completing buy and past it, all of a balance,
  more than a balance), buybacks at random slots, the three payouts, the payout path;
* founder transfers, approvals, revocations, launches, configs (valid and invalid);
* pauses by every key, the old program's pause, guardian and payout settings, admin hand-overs;
* lamport and coin donations, holder burns and transfers, clock warps;
* bundles of several instructions in one transaction;
* invalid variants (F02): one account of a valid instruction of any of the 21 replaced by another
  plausible account (another coin's accounts, the old program's, other programs, a random key), or
  its authority replaced by another signer that does sign.

The model (F01) keeps each coin's state with the SDK's port from each action's own inputs, never
from the events. It predicts success or failure and the error, in the order the runtime and the
program check things. After every transaction the Coin's 693 bytes must equal the model's state
written over the bytes `launch` wrote. A failed transaction must have been predicted to fail. An
invalid variant must fail and move nothing, with three exceptions:

* **Slots the instruction leaves open** (`FREE_SLOTS`). A buy may deliver to any token account of
  the mint. `withdraw_platform_fees` is permissionless and every other account derives from the
  coin. A founder of two coins may claim or hand over either. The admin enables whichever config it
  names.
* **Variants the runtime cannot build** (a program id marked writable). These are counted as
  refused.
* **The Anchor `#[event_cpi]` `program` slot.** That account is read only by the event self-CPI,
  which fails if it is not the program, so an instruction that emits nothing (a crank or payout with
  nothing to do) accepts any account there and changes nothing. The checker verifies that no
  balance and no program account moved. It is a property of Anchor's macro, harmless here, and is
  noted for the auditors.

The checker runs after every transaction and the I22 probe every 50 steps. CI runs 300 steps on
seeds 1 and 2. `VCURVE_FUZZ_STEPS`, `VCURVE_FUZZ_SEEDS` and `VCURVE_FUZZ_LOG=1` (progress every
1,000 steps) set up a long run.

The first long run (seed 7) stopped at step 22,047 on the checker defect of entry 34. The second
passed that step and stopped at step 75,150 on the I22 probe, in a state that I22's wording misses
(entry 41). Neither was a program bug, and the program and the model agreed byte for byte at every
step of both. With both fixed (64beae0), the final runs passed:

| run | transactions | succeeded | failed: predicted by the model | failed: invalid variants | failed: outcome not modelled | time |
|---|---|---|---|---|---|---|
| seed 7, 100,000 steps | 95,580 | 56,190 | 22,567 | 14,774 | 2,049 | 51 min |
| seed 8, 30,000 steps | 28,691 | 17,183 | 6,286 | 4,586 | 636 | 15 min |

The model does not predict the outcome of approvals, launches, configs and settings sent by a
random key; it adopts what the chain did, and the checker still checks each one. Of the 15,046 and
4,655 invalid variants, besides those refused, 115 and 36 could not be built (a program id marked
writable), 26 and 9 replaced an open slot, and 131 and 24 replaced the `program` slot of an
instruction that emitted nothing.

Each run launched 10 coins and graduated all of them, and ran the I22 probe every 50 steps (2,000
and 600 probes). The seed 7 run included 431 pauses and reopenings of the old program's launches.
The predictions also fixed several harness assumptions on the way: the order of checks
(Anchor's account checks before the math), the rent rule at the end of the transaction (entry 36),
and wrong-signer variants that must still carry every original signature.

### 39. F03 over the whole V1 to V11 space (12.5 F03, 5.13)

`tests-curve/24-configs-f03.test.mjs` sends `add_launch_config` on chain for every golden config of
the reference model that fits the instruction's `u16` and `u64` arguments, plus a seeded set built
around valid curves from 5.9's search. The seeded set holds random shares, every field one step
either side of a valid value, and each rule broken on purpose. The program must accept exactly the
configs the model accepts, store each one byte for byte and count it in `next_config_id`. It must
refuse every other one with the error of its first failing rule in 5.13's order and create nothing.
Every rule is hit at least four times. A sample of the accepted configs is launched, traded to
graduation and traded in the pool. `VCURVE_F03_SEED` and `VCURVE_F03_N` widen the seeded set. The
program and the model agreed on every config.

### 40. G02, G03 and R02b with a mock router instead of a test-only build of the program (12.5, 4.0, 14.3)

`tests-curve/router/` is a small native program, used only by the tests and never deployed. It has
its own workspace and lock file, is built by `npm run curve:router` (a CI step before the curve
suites, or on first use by `26-router.test.mjs`) and lives at a fixed address with no key behind
it. It forwards an instruction (signed by the user, or by a router PDA through `invoke_signed`),
moves lamports and then CPIs (R02b), and stands in for a swap with a minimum output (G03).

* **G02.** `buy` and `sell` through the router for a signing user and for a router PDA. Balances
  and events are the user's or the PDA's, and the event self-CPI runs at depth 3. The partial fill's
  leftover stays with the PDA. A PDA carrying data cannot buy (the system transfer refuses it, and
  the SDK predicts it).
* **G03.** A swap that delivers SOL, followed by our buy in the same transaction.
  `sdk/curve/compose.mjs` takes `sol_in` from the quote's guaranteed output: `outAmount` for
  ExactOut, `otherAmountThreshold` for ExactIn, never the quoted `outAmount`. With that `sol_in` the
  buy never spends SOL the user already had, whatever the swap delivers above its minimum; a swap
  below its minimum fails and moves nothing. The naive `sol_in = outAmount` does spend the user's
  own SOL when the swap under-delivers.
* **R02b.** The specification asks for a test-only build of `vicinity_curve` that CPIs
  `SyncNative` after `pay_out`. The router shows the same runtime rule on the same runtime without a
  second build of the program: a direct lamport move followed by a CPI to `SyncNative` that lists
  only the credited WSOL account fails with `UnbalancedInstruction`; the same move followed by a
  CPI that lists both accounts passes; and the move followed by a top-level `SyncNative` (the
  pattern of `forward_holders_fees`, 4.15) passes. The p-token `SyncNative` rejects extra accounts,
  so "listing both" is a self-CPI no-op naming both accounts, followed by `SyncNative`.

### 41. I22's buyback clause misses dust: a bucket worth less than one raw coin waits (9 I22, 7.1, 5.11)

I22 says that once the interval has passed and `buyback_pending > 0`, `buyback_burn` either burns or
`curve_sol == f(S - 1)`. The long F01 run (seed 7, step 75,150) reached a third case. The run
spends `b = min(buyback_pending, cap)`, and in the pool it buys `floor(Y * b / (X + b))` coins
(7.1). When one raw coin costs more than `b` lamports, that is 0, and the run is the no-op of 4.0:
nothing moves, and the bucket keeps its lamports. In the run, a coin on a config with a 9 bps
buyback share had 24,244 SOL in its pool (2.28 lamports per raw coin) and 1 lamport in its bucket;
replayed to the same step with the corrected probe, the run went on. On the curve the same happens when `b` is below
the cost of the next raw coin (`tokens_for(r + b) <= s`), which the curves that V1 to V11 accept
do not reach in practice (their end price is far below one lamport per raw coin).

A raw coin costs one lamport once the pool's price reaches 10^6 lamports per coin, a fully diluted
value of about 1,000,000 SOL; on config #0 the pool then holds about 4,200 SOL. The regression
test in `20-checker-gaps.test.mjs` (now `27-checker-gaps.test.mjs`) puts 20,000 SOL in (about 22 lamports per raw coin), lets the
runs spend the bucket, and then sells 100 raw coins, which adds 6 lamports to the bucket. The run
is then a no-op. The next ordinary trade's share makes the bucket worth coins, and the following
run burns. This is the program doing exactly what 7.1 specifies; no program change. It is dust
waiting for the bucket to grow, not a stuck state, but it is not in I22's list either.

The probe now accepts this case only when the math says the run would buy 0 coins (`Y * b < X + b`
in the pool, `tokens_for(r + b) <= s` on the curve); a cap of 0, or anything else, still fails.
The specification should add to I22 "or `b` buys less than one raw coin at the current price", and
add the bucket's dust below that price to the intended permanent balances of a coin that stops
trading.

---

Review round 1 (findings GOV-1, GOV-2, CLI-1, CLI-2, CLI-3 and the leftovers of stage 3). Entries 42
onwards. The specification's revision 3 records each change in its own sections and in Appendix C.

### 42. The old program's admin must be this program's admin (8.1, 8.4, 8.5, O19, I19, T34, T67; review GOV-1)

**Spec.** 8.5 keeps R1 in the other direction by keeping the old `vicinity_launchpad` paused
(O19) and accepts that "if the old admin ever unpaused it ... a city launched here could then be
launched again". 8.1 assumes that admin is the Squads vault; 8.4's preconditions name the rewards
registry admin but not the old program's admin.

**Issue.** On mainnet the old program's admin is the owner's wallet `13qRam...`, which is also
`FEE_RECIPIENT` (`release/mainnet-2026-10-10/BUILD.md`, setup step 1), and `docs/MAINNET.md` leaves
moving it out of the launch. `approve_launch` and `launch` checked the old `Launchpad`'s owner, size,
discriminator and paused byte only. That one key, with no multisig and no time lock, could reopen
the old program (every approval and launch here then fails with `LegacyLaunchesOpen`), approve and
launch a second coin there for a city launched here (R1 broken for good, and the duplicate in the
official list, which 14.1 builds from both programs' `Coin` accounts), pause it again so that
launches here resume, or block a pending launch here with an old approval made while paused. Once
it had reopened the old program, neither the Squads vault nor the guardian could pause it again.

**Choice.** Both fixes, the safer reading. Process: 8.4's preconditions now require the old
program's admin to be the Squads vault with no transfer pending (its upgrade authority already is,
BUILD.md), and 8.5 recommends closing the old program once it is paused for good. Code, failing
closed: `approve_launch` and `launch` require the old `Launchpad`'s `admin` (bytes 8..40,
`LEGACY_ADMIN_AT`) to equal `launchpad.admin` and its `pending_admin` (bytes 40..72,
`LEGACY_PENDING_ADMIN_AT`) to be zero, else `LegacyAdminMismatch` (6051, appended). The check is the
last constraint on `legacy_launchpad`, so the errors come in the order `InvalidAddress`,
`LegacyLaunchesOpen`, `LegacyAdminMismatch`. Reopening the old program now needs the same multisig
and time lock as any admin action here; while the two programs are not under the same admin,
nothing is approved or launched here. A hand-over of this program's admin must be followed by the
old program's (its `propose_admin` by its admin, `accept_admin` by the new one): until then
approvals and launches here fail. No account list changes; the IDL gains the error and the two
offsets as constants (53 errors).

Tests. `tests-curve/28-governance.test.mjs` replays the review's scenario with the mainnet binary of
the old program and `13qRam` signing off line: approvals are refused while it is the old admin and
while a transfer to the vault is pending, work after the hand-over, and the former admin can no
longer pause or enable anything there; a transfer pending in the old program, to anyone, stops
approvals and launches here until it is cancelled; a hand-over of this program's admin stops them
until the old admin follows. `03-approvals` L04 crafts the old `Launchpad` with another admin, a
zero admin and a transfer pending to a stranger or to this admin. Unit tests `legacy_admin_checks`
and U12's offsets. The checker's I19 now also requires, at every approval and launch, the old
admin equal to this program's admin before the transaction and no transfer pending. Against the
previous build the first governance test fails at its first refusal (the approval succeeds).

### 43. `FEE_RECIPIENT` holds no role; the guardian is neither payout key nor payout wallet (4.1 to 4.5, 8.1, I20, I21; review GOV-2)

**Spec.** 8.1: `FEE_RECIPIENT` "signs nothing"; the guardian "cannot touch money". 4.1 to 4.4
stored the admin and the guardian unchecked; 4.5's separation rule did not name the guardian.

**Issue.** `init_launchpad`, `propose_admin` and `accept_admin` accepted `FEE_RECIPIENT` as admin,
and `init_launchpad` and `set_guardian` as guardian. `forward_holders_fees` binds every city's
reward authority to the admin (4.15), so a `FEE_RECIPIENT` admin would also publish every city's
holder roots, and with the guardian equal to `FEE_RECIPIENT` the permissionless
`withdraw_platform_fees` pays the guardian (the checker's I21 fails). `set_payout_config` accepted
the guardian as payout key, and as payout wallet (entry 33's third observation).

**Choice.** A new error `FeeRecipientRole` (6052): `init_launchpad` refuses `FEE_RECIPIENT` as admin
or guardian, `propose_admin` (nonzero) and `accept_admin` as admin, `set_guardian` as guardian.
`check_payout_keys_separate` takes the guardian: the payout key and the payout wallet are neither
the guardian nor, as before, the admin, each other or `FEE_RECIPIENT`; `set_payout_config`,
`propose_admin`, `accept_admin` and now `set_guardian` (with the new guardian) run it
(`PayoutKeyNotSeparate`, whose message now names the guardian). A zero guardian never equals a set
payout key or wallet. The checks only refuse and add no state. Entry 33's third observation is
resolved. The program still cannot keep every other hot wallet out of the admin seat; 4.1's "the
same Squads vault" stays a precondition of 8.4.

Tests. `28-governance` (each instruction refuses `FEE_RECIPIENT`, signed off line where it must
sign; `accept_admin` of a pending `FEE_RECIPIENT` written out of band; the guardian as payout key or
wallet refused both ways, and allowed again once payouts are off; a withdrawal after the refused
`set_guardian`); unit tests `payout_keys_separate` and `fee_recipient_has_no_role`; the checker's
I20 (payout keys separate from the guardian; `FEE_RECIPIENT` is never the admin, the pending admin
or the guardian).

### 44. The buy leg of "pay with any token" carries its own minimum (14.1, 12.5 G03; review CLI-1)

**Spec.** 14.1 says the composer takes `sol_in` from the swap's guaranteed output (G03, entry 40)
and that slippage defaults to 1% to 2%; it did not say that the buy leg needs its own minimum.

**Issue.** `sdk/curve/compose.mjs`'s `buyWithSwap` defaulted `min_tokens_out` to 0, and every call in
the repository left it out. The swap's minimum says nothing about the curve's price, so a searcher
could buy ahead of the transaction and sell after it: on a fresh coin a 5 SOL buy received 68% fewer
coins than quoted (attacker +2.13 SOL). `ix.buy` itself throws without a minimum; only the helper
dropped it. The program was right: with a minimum the victim's buy fails.

**Choice.** `buyWithSwap` builds no buy without a positive minimum (`buyLegMinimum`): either
`minTokensOut` (at least 1), or the coin's snapshot (`coinAccount`, a decoded `CurveCoin`) and
`slippageBps` (an integer from 0 to `MAX_SWAP_SLIPPAGE_BPS` = 500), from which the minimum is
`withSlippage(quoteBuy(coin, guaranteed sol_in).tokensOut, slippageBps)`. Anything else throws
`ComposeError`. It returns the minimum with the instructions. G03's calls pass the coin and 100
basis points. No program change.

Tests. `sdk/curve/prechecks.test.mjs` (no minimum, 0, both ways at once, a missing snapshot, a
slippage above 500 or not an integer, another coin's snapshot: refused; the computed minimum
encoded); `tests-curve/29-clients.test.mjs` (the review's 25.5 SOL front-run against a 5 SOL buy at
2%: the victim's buy fails with `SlippageExceeded` and nothing moves, the attacker's round trip
loses; without the front-run the buy delivers at least the minimum).

### 45. Events only from successful transactions: `decodeTransactionEvents` (4.21, 14.1, T56; review CLI-2)

**Spec.** 4.21: indexers accept event CPIs "only from an inner instruction of `vicinity_curve`
signed by its `event_authority` PDA"; 14.1: "`trade_seq` is gap-free per coin, so missed events
are detectable".

**Issue.** The runtime records the inner instructions and logs of failed transactions too (Agave
`svm/src/transaction_processor.rs`; litesvm's failed metadata). A transaction `[sell everything, a
transfer that always fails]` reverts and costs its sender only the fee, yet its metadata holds the
program's genuine `Trade` event CPI, which the stated rule and `decodeEventCpi` accept; the next
real trade carries the same `trade_seq`. An indexer that keeps the first event per
`(coin, trade_seq)` keeps the fake one. No funds move; charts, volume and rankings can be painted.

**Choice.** The rule is now complete in 4.21, 14.1 and T56: events count only from a transaction
whose `meta.err` is null (read or re-checked at `finalized`); event CPIs only from an inner
instruction (stack height 2 or more) whose enclosing call is `vicinity_curve`, with the event
authority as its only account; `emit!` events only from log lines written while `vicinity_curve`
runs, and never a money event; and indexers reconcile each coin's events with `Coin.trade_seq`
and the counters instead of deduplicating first-write-wins. The SDK adds
`decodeTransactionEvents(tx)`, which takes what `getTransaction` returns (legacy or v0, "json",
"jsonParsed" or web3.js objects), returns nothing for a failed transaction, applies the stack and
caller rule, and throws when the metadata lacks stack heights (the caller cannot be proven).
`decodeEventCpi` and `decodeEventLogs` say that they check one instruction or one log list only.
`World.send` now runs the decoder on every transaction of every suite, built into
`getTransaction`'s shape from litesvm's result (`rpcTransaction` in `helpers.mjs`): for a success
it must find exactly the checker's events, for a failure nothing. No program change.

Tests. `sdk/curve/events.test.mjs` (failed transactions, the caller rule through a router and
through another program, siblings after a deeper call, foreign accounts and missing tags, money
events in logs, the RPC shapes, missing stack heights); `29-clients` (the review's failed sell: the
genuine CPI is there, the decoder returns nothing, the coin did not move, the next real trade is
the only `trade_seq` 2); and the cross-check of every suite transaction.

### 46. `initRewardsForCoin`: a pre-funded config address is not a config; authority problems are fixable (4.15, T55, T70, R03; entry 36; review CLI-3)

**Issue.** `initRewardsForCoin` treated any account holding lamports at the city's config address
`["city", mint]` as an existing config. Mints are PDAs of the city, so anyone can compute every
city's config address before launch; a plain transfer of `rent_min(0)` (890,880 lamports) leaves a
System-owned account without data, and the SDK then reported `ExistsWrong` ("cannot change or close
it ... program upgrade (O26)") and proposed nothing, although `init_city` creates over the
pre-funded address (Anchor `init`, T55) and forwarding then works. Entry 36 also reported a config
whose only problem is its authority as unfixable, though 4.15 says the current authority can hand
it to the admin.

**Choice.** Only an account owned by `vicinity_rewards` is an existing config. A System-owned
account without data is no config: `init_city` is built, simulated and checked as usual. Anything
else at the address is `NotACityConfig`. For an existing config, problems of the authority alone
(not the admin, or a transfer pending) are `AuthorityNotAdmin` with `fixable: true` (the current
authority proposes the admin, or zero to cancel, and the admin accepts); wrong economics are
`ExistsWrong` with `fixable: false` (O26). `FIXABLE_CONFIG_PROBLEMS` lists the first kind. Entry
36's sentence "(or one with an authority transfer pending) is reported as unfixable" is superseded.

Tests. `sdk/curve/prechecks.test.mjs` (pre-funded System accounts in both snapshot shapes propose
`init_city`; authority-only problems are fixable; mixed ones are not; foreign owners and System
accounts with data are no config); `29-clients` against the real `vicinity_rewards`: the config and
vault addresses pre-funded, `init_city` proposed and creating both, the forward paid, then an admin
hand-over reported as fixable until `propose_authority` and `accept_authority`, after which the
config is correct again and forwards resume.

### 47. The failed-transaction check and transactions refused before execution (12 intro, L13; entries 29 and 33; leftover L2)

`checkFailedTransaction` charged every failed transaction its fee. A transaction the runtime refuses
before running it (its fee payer missing or unable to pay, a bad signature or blockhash, a message
that does not sanitise, an account loaded twice or locked, a bad lookup table) pays nothing, so
`World.send` could not send one and X61 went around it (entry 33). `World.send` now classifies
litesvm's error (`REFUSED_BEFORE_EXECUTION` in `helpers.mjs`, fieldless errors only) and the check
requires exactly no fee for those and exactly 5,000 lamports per signature for every other failure,
with nothing else moved either way. X61 sends its 0-lamport fee payer through `World.send`.
`27-checker-gaps` L2 shows that each rule refuses the other case.

### 48. The fuzz follows admin hand-overs; X04 and X02 completed; the test files (12.4 X02, X04, 12.5 F01, F02; entries 32 and 38; leftovers L1, L3, L5)

* **L1.** After an `accept_admin` the fuzz now has the admin's other seats follow it (`followPlans`
  in `fuzz.mjs`), at once in four cases out of five and otherwise through a later `follow_admin`
  action: the old program's admin (`propose_admin`, `accept_admin`, entry 42) and each city's
  rewards authority (`propose_authority`, `accept_authority`, or a cancel of a stale pending
  transfer, 4.2). Some steps stop after the proposal and leave a transfer pending. The old
  program's pause is signed by its current admin. So approvals, launches and forwards keep
  succeeding in long runs after admin changes. Two 5,000-step runs (seeds 3 and 4) made 205 follow
  steps (all succeeded) and 173 successful forwards; the model and the chain agreed at every step.
* **L3.** `14-attacks` completes X04 and X02. X04: a real Token-2022 mint, and Token-2022 copies of
  the coin's mint, its vault and a holder's token account, alone and together with the Token-2022
  program, in `buy` and `sell` (18 variants): each is refused with `AccountOwnedByWrongProgram`
  (3007) on the substituted account, or `InvalidProgramId` (3008) for the program alone. X02: a
  `Coin` made by the old program itself (its approval and launch through Meteora DBC) in the coin
  slot of all nine coin-level instructions: `AccountOwnedByWrongProgram`. Nothing moved, and the old
  `Coin` is untouched.
* **L5.** `20-checker-gaps.test.mjs` is now `27-checker-gaps.test.mjs` (two files had the prefix
  20); `tests-curve/README.md` lists every file; entries 28 and 32 are marked superseded.

### 49. The founder seat never goes to `FEE_RECIPIENT`, the guardian or the payout key (4.1, 4.8, 4.10, 4.17, 8.1, 8.4, I20, I21, T52, T77; reviews R2-DIFF-1, SPEC-1)

**Spec.** Revision 3's 8.1 row for `FEE_RECIPIENT` said it "cannot ... sign anything in the
program; hold any role", I21 said "since `FEE_RECIPIENT` can hold no role, platform withdrawals
never reach one", the guardian "cannot ... touch money" and the payout key cannot "touch any other
bucket". NOTES 34 calls I21 "the program property ... that no program path pays a role key".

**Issue.** Entry 43 (GOV-2) covered the admin, proposed admin, guardian, payout key and payout wallet
seats, not the founder seat. `approve_launch` checked only `founder != 0`, `launch` only that the
signer is the approved founder, and `transfer_founder` accepted any co-signing key. So
`FEE_RECIPIENT`, the guardian or the payout key could be approved (or handed the seat), sign
`launch`, `claim_founder_fees`, `opt_in_payout` and `transfer_founder`, and receive that coin's
founder share; the checker's I21 then failed at the guardian's claim. `init_launchpad` also accepted
`FEE_RECIPIENT` as the upgrade authority (the checker's I21 then failed at the first launch, whose
fee went to a role key). No third party's money was at risk: only that coin's founder share, and only
with an admin approval or the key's own co-signature.

**Choice.** The safer reading, enforced where the program can see it. `check_founder_key(founder,
guardian, payout_authority)` refuses zero (`InvalidAddress`), `FEE_RECIPIENT` (`FeeRecipientRole`,
6052) and the guardian or the payout key (`FounderHoldsRole`, 6053, appended): `approve_launch` on the
founder it names, `launch` again on the signing founder against the `Launchpad` of that moment, and
`transfer_founder` on the new founder, which now takes the `Launchpad` (read-only, seed-pinned; the
IDL and the SDK's builder follow). `init_launchpad` refuses `FEE_RECIPIENT` as the upgrade authority.
Not refused, on purpose: the admin (it chooses every founder and may choose itself, 8.1's worst case;
refusing its own key would protect nothing) and the payout wallet (it only receives, like any
founder's wallet). Not detectable on chain, so stated as 8.4's operating rule and kept by the
tests: a later loader `SetAuthority` to `FEE_RECIPIENT`, and a `set_guardian` or
`set_payout_config` naming a key that already holds a founder seat (the program cannot enumerate
coins). 8.1's `FEE_RECIPIENT` row now says what holds: it can trade like any wallet, and holds no
seat. I21 names the founder seat as the one path that pays a key the admin chose.

Tests. `28-governance` (each of the three refused by `approve_launch` and by `transfer_founder` even
with its co-signature; a founder made guardian after the approval cannot launch; an approval naming
`FEE_RECIPIENT`, written out of band, cannot be launched; a plain key still takes the seat and its
money; the payout wallet and the admin may still be approved; `init_launchpad` with `FEE_RECIPIENT` as
the upgrade authority); unit tests `founder_seat_rules` and the review checklist's
`founder_seat_checked_wherever_a_founder_is_named`; the checker's I20 (no coin's founder is
`FEE_RECIPIENT`, the guardian or the payout key, after every transaction); the fuzz model predicts
the refusals of `transfer_founder`. Against the previous build both new governance tests fail at their
first refusal (the approval of `FEE_RECIPIENT` and the initialisation succeed).

### 50. V2b: a share credited back never leaves a trader trading for free (5.13, 3.2, 5.15, 7.4, T44, X44, G01; review ECON-1)

**Spec.** 3.2: `MAX_FOUNDER_FEE_BPS` "bounds what a founder gets back from sandwiching or wash-trading
his own coin"; 7.4: "the founder ... and Vicinity ... both lose by trading against themselves";
5.15: a sandwich needs the victim's impact to exceed "about twice the fee".

**Issue.** V8 and V11, the rules that credit the founder (and a holder of the float) his own share,
run only when `buyback_bps > 0`, and V2 caps `founder_bps` at 100 but not against the total. So
(0, 0, 100, 0, 0) passed V1 to V11 in the crate, the SDK and the program: every lamport of fee went
back to the founder through `claim_founder_fees`, his 10 SOL wash round trip cost 0 lamports on the
curve, and around 0.3 SOL and 1 SOL buys made with the website's 1% to 2% slippage he took about
99 bps and 199 bps of each buy (the verifier's on-chain measurements). (0, 20, 100, 0, 0) also
passed. The exposure equals what any outsider has on X44's accepted 0.01% platform-only config,
which is why the verifier rated it low; the defect is that 3.2, 7.4 and 5.15 claimed more than the
rules enforced.

**Choice.** A rule, the safer reading, decided together with the minimum fee as the verifier
suggested: **V2b** `max(b_F, b_H) + MIN_TOTAL_FEE_BPS <= t`, part of V2 (`ConfigFeeShareCap`, whose
message now names it), so no new error code. A trader credited the founder's share, or the holders'
share as V8 and V11 credit a holder of the float, still pays at least 0.01% per leg net, with or
without a buyback share, exactly the floor every outsider pays (`MIN_TOTAL_FEE_BPS`, V1). It refuses
(0, 0, 100, 0, 0), (0, 0, 0, 100, 0) and any config where one credited share is the whole fee; it
keeps X44's platform-only (0, 1, 0, 0, 0) and the review's (0, 20, 100, 0, 0) (the founder then pays
0.2% per leg). Not taken: the review's stronger forms (V8's credited bound with a zero step, or
`t - max(b_F, b_H) >= 100`) would also refuse X44's accepted 0.01% config and contradict
`MIN_TOTAL_FEE_BPS = 1`. The platform's own wallet is not covered (its share can be the whole fee
in X44's config); 7.4 now says so. Default config #0 passes V2b with `t - m = 200`.

Built in the crate (`validate_config`), the SDK port (`validateConfig`), the reference model
(`reference/model.py` and its copy in Appendix A) and the program (through the crate, at
`add_launch_config` and again at every `launch`). The golden vectors gain nine fixed V2b cases after
the seeded ones (`generate_vectors.py`; no random draw, so every other vector is unchanged), replayed
by `differential.rs`, `sdk/curve/math.test.mjs` and on chain by F03, whose generated set also breaks
V2b on purpose. 5.15 and 7.4 now state each trader's cost per leg (`t`, `t - b_F`, at most `t - b_H`)
and what a small net fee allows.

Tests. `config_rules.rs` `v02b_credited_share_leaves_the_minimum_fee` (the review's configs refused,
the 1-bp edge passes, an exhaustive sweep of small shares); `19-attacks-admin` X44 (the founder or
the holders credited the whole fee refused on chain with `ConfigFeeShareCap`; the accepted hostile
configs, now including (0, 1, 100, 0, 0) and (0, 20, 100, 0, 0), run a whole life in which the
founder's own 10 SOL wash round trip, his shares claimed back, loses exactly his net fee and at least
0.01% of each leg; measured 10 SOL round trips: 3.95% under config #0, 0.0199% under (0, 1, 100, 0, 0),
0.3976% under (0, 20, 100, 0, 0)). Against the previous build, the crate test and X44 fail at their
first refusal (the model and the program accept (0, 0, 100, 0, 0)). The reference checks
(`checks.py`) print the same output before and after V2b.

Superseded in part by entry 52 (review round 3): V2b bounds the sum `b_F + b_H`, since a founder who
also holds the float is credited both shares.

### 51. `check_name` refuses every invisible and blank character and stray spaces (3.6, 4.8, 4.10, T38, U11, X38; review FA-1)

**Spec.** T38: "`check_name` refuses control and invisible formatting characters".

**Issue.** `is_format_char` listed the format characters (category Cf) that change direction or are
invisible, but not the rest of Unicode's default-ignorable code points, which are letters or marks
by category: the Hangul fillers U+3164, U+115F, U+1160 and U+FFA0 (Lo), the combining grapheme
joiner U+034F, the Khmer inherent vowels, the variation selectors, the Mongolian free variation
selectors and the reserved ignorables. Blank characters passed too (no-break and typographic
spaces, the line and paragraph separators, the braille blank U+2800), and so did a leading,
trailing or doubled U+0020, or a name that is a single space. `approve_launch` and `launch` accepted
"Paris" followed by a Hangul filler, and the immutable Metaplex name stored it byte for byte: a name
that looks exactly like another, or a blank name, made permanent. The server's mirror `nameProblem`
(`src/lpadmin.js`) had the same gap. On the website's own design route (`src/coins.js`, `NAME_RE`
and the trim) only the four Hangul fillers got through; the others reach the chain only through an
approval built outside the website (the verifier's correction). No funds at risk: the ticker stays
the unique identifier, the admin approval is a manual gate, and names are not unique anyway.

**Choice.** The safer reading of T38, "every character of the name is visible": `check_name` refuses
control characters, every `Default_Ignorable_Code_Point` of DerivedCoreProperties.txt plus the
other format characters already listed (`is_format_char`), the blank characters (`is_blank_char`:
spaces other than U+0020, U+2028, U+2029, U+2800, U+1D159), and a U+0020 at the start, at the end or
next to another one. U+2028 and U+2029, which U11 had kept allowed as neighbours on purpose (the
verifier's second correction), are refused as blank: a coin name has no use for a line break. The
error stays `BadName` (its message now says so). `nameProblem` mirrors the rule and the website
applies it to every approval it prepares. Not addressed, and stated in T38: look-alike letters of
other scripts and canonically equivalent spellings ("é" as one or two code points); names are not
unique and the ticker is the identifier. The old `vicinity_launchpad` (deployed, paused for good,
8.5) keeps its weaker `check_name`; its approvals now go through the stricter `nameProblem`.

Tests. U11 `u11_default_ignorables_and_blanks` (all 4,194 listed code points refused alone, first,
inside and last; the review's names; the visible neighbours of each range allowed; the space rule)
and the updated neighbour list of `u11_exhaustive_small_inputs`; `15-attacks-accounts` X38 on chain
(the new code points inside and at the end of a name, the review's names, blank names and the space
rule refused by `approve_launch`; ordinary names, now with spaces, still launch);
`test/lpadmin.test.js` for `nameProblem`. Against the previous build, U11 fails on U+034F and X38 at
its first new code point (the approval succeeds).

### 52. V2b bounds the sum of the founder's and the holders' shares (5.13, 3.2, 5.15, 7.4, I3, T44, X44, G01; reviews R3-DIFF-1, MATH3-2)

**Spec.** Entry 50 and revision 3 after review round 2: V2b `max(b_F, b_H) + MIN_TOTAL_FEE_BPS <= t`;
5.13 called `m` "the largest share an attacker can be credited back"; 7.4 said V2b keeps a
credited trader's cost at 0.01% or more "in every config"; 3.2's `MAX_FOUNDER_FEE_BPS` row said a
founder's own trades always cost him at least `MIN_TOTAL_FEE_BPS` per leg.

**Issue.** A founder who also holds the float, in wallets other than his seat (the snapshot leaves
out only the seat, and the 20-holder gate is easy to meet with his own wallets), is credited both
shares of every leg: `b_F` through `founder_pending`, whoever trades, and `b_H` back through the
rewards rounds in proportion to the float he holds. The project's own attacker model already counts
him that way (7.5's drip attacker, P06 and entry 13's `(b_F + b_H)/D` class), but V2b bounded only
the larger share. So (0, 0, 50, 50, 0), (0, 0, 100, 1, 0), (0, 0, 100, 150, 0) and (0, 0, 1, 1, 0)
passed V1 to V11 in the crate, the SDK port, the reference model and the program (V8 and V11 do not
run without a buyback share; V10 passes at `b_L = 0`). The verifier's on-chain wash trade under
(0, 0, 50, 50, 0), twenty founder wallets holding the float and a real `fund_epoch_from_vault`
round under the SDK's round rules: 119.4 SOL of legs, the founder's wallets net -12 lamports
(rounding dust); V2b's stated floor was 0.01194 SOL. Severity low (the review) and info (the math
lens): it needs a config the owner or a stolen admin key chose with `b_L = b_P = b_B = 0`, and the
sandwich harm beyond the accepted 1-bp configs is about 1 bp per leg (99.3 bps against 100.0 bps of a
1 SOL buy at 1%).

**Choice.** The review's fix: **V2b** `b_F + b_H + MIN_TOTAL_FEE_BPS <= t`, the same as
`b_L + b_P + b_B >= 1`, still part of V2 (`ConfigFeeShareCap`, whose message now says "together";
no new code). It keeps every config the spec requires to pass: config #0 (`t - b_F - b_H = 150`),
X44's (0, 1, 0, 0, 0) and (0, 0, 100, 0, 150), ECON-1's (0, 1, 100, 0, 0) and (0, 20, 100, 0, 0), and
the edges (0, 1, 100, 100, 0), (0, 1, 0, 100, 0), (0, 1, 50, 50, 0) and (1, 2, 100, 0, 0). None of the
golden vectors changes (the seeded ones, valid or refused, are byte for byte the same; nine fixed
cases are appended after ECON-1's, no random draw), the G01 vectors are unchanged, and
`checks.py` prints the same output. Not changed, and now stated in 5.13: when `b_B > 0`, V8 and V11
still credit only `m = max(b_F, b_H)` (MATH-3's accepted modelling); for a founder holding the float
their bounds are the tested heuristic of 7.3, which P06 and entry 13 check with `(b_F + b_H)/D`.
The platform's own wallet stays outside V2b, as entry 50 says.

Built in the crate (`validate_config`), the SDK port (`validateConfig`), the reference model and
its Appendix A copy, the program (through the crate, at `add_launch_config` and every `launch`),
and the checker's I3, which now asserts the sum directly as well as through `validateConfig`.
5.13 (the definition of `m`, V2b, config #0's margin), 3.2, 4.22, 5.15, 7.4, I3, T44, 12.1 and 12.4
say so.

Tests. `config_rules.rs` `v02b_credited_shares_leave_the_minimum_fee` (the review's four sum configs
and (0, 0, 100, 100, 0) refused with nothing else violated; the 1-bp edges pass; an exhaustive sweep
of small founder, holders and other shares); `v10_drip_not_farmable` now shows `b_L = 0` with
`b_P = 0` on (0, 0, 100, 0, 150), since (0, 0, 100, 100, 0) is a V2b refusal; `19-attacks-admin` X44
(the four sum configs refused on chain with `ConfigFeeShareCap`; (0, 1, 50, 50, 0) accepted and run
through a whole life; on every accepted hostile config the founder's 10 SOL wash round trip still
costs at least 0.01% of each leg after both his own and the whole holders' share; measured under
(0, 1, 50, 50, 0): 0.1015 SOL before the holders' share, 0.01% of each leg after it); F03's generated
set breaks V2b as a sum on purpose; the golden vectors (`differential.rs`, `math.test.mjs`, F03 on
chain). Against the previous build, `v02b_credited_shares_leave_the_minimum_fee` fails at
(0, 0, 50, 50, 0) and X44 at its first sum config (the program accepts it).

### 53. A separate buyback halt, set only while buys are halted (3.4, 4.4, 4.13, 4.22, 7.2, 8.3, I20, T72, T73, T76, O25, H01, L12; review LL-1)

**Spec.** 3.4 and 8.3: one flag, `buys_halted`, set by the guardian or the admin, stopped `buy`,
`buyback_burn` and `launch`; 7.2, T76 and O25 named volume bursts and keeper downtime as the causes
of a backlog, with a keeper that spends every interval as the mitigation.

**Issue.** During a guardian halt every sell still booked its 0.3% into `buyback_pending` and every
`buyback_burn` failed with `BuysHalted`, so the keeper could not run for the whole halt (under the
48-hour time lock, at least 48 hours, and the clearing proposal is public that long). The review's
on-chain run: a 970 SOL pool, 95% of the holders' coins sold during the halt, a backlog of 2.868 SOL
against a depth of 19.26 SOL (14.9%, seven times `u*`); the first buyer after the clear, 20 SOL held
through 73 runs, made +1.235 SOL, against -0.897 SOL with the keeper running. A stolen guardian key
could create the condition on every pool coin at once. The verifier rated it low: it is O25's
accepted front-run of a public backlog, it needs a pool coin far above graduation mostly sold during
the halt, and the loss is at most 0.3% of the SOL sold. The program already allowed an atomic drain
(`[set_pause(false), buyback_burn, set_pause(true)]` per transaction), but under the time lock each
of those is a Squads proposal (139 for the review's backlog).

**Choice.** The review's first fix, which is the safer one: buybacks get their own flag, and the
program forbids the state in which a backlog can build in front of open buys.
* `Launchpad.buybacks_halted` (offset 174, taken from `_reserved`, now 63 bytes; the account stays
  238 bytes and no other offset moves) blocks `buyback_burn` with `BuybacksHalted` (6054,
  appended). `buys_halted` blocks only `buy` and `launch`.
* `set_pause(launches, payouts, buys, buybacks)`: the guardian may set any of launches, buys and
  buybacks to true, never false; the payout key only stops payouts; the admin anything. Whoever
  signs, the flags after the call must satisfy `!buybacks_halted || buys_halted`
  (`BuybackHaltWithoutBuyHalt`, 6055, appended): buybacks are halted only together with or after
  buys, and buys reopen only with or after buybacks. `PauseArgs` carries the four arguments
  (`pause_allowed` would otherwise take eight); `pause_flags_consistent` is the rule.
  `PauseChanged` gains `buybacks_halted`.
* So a halt of buys alone leaves the keeper running (no backlog builds; sellers keep the support
  their 0.3% pays for), and after a halt of both the admin's recovery is two proposals: buybacks
  first, then, once the keeper has spent every coin's backlog to at most one cap and the site has
  published the figures, buys. Nobody can buy ahead of the drain. 8.3 now tells the guardian to
  halt buybacks only when they are themselves in question (a curve-math bug, a buyback MEV route).
* Not taken: leaving `buyback_burn` unhaltable (the review's alternative). It is simpler and also
  removes the stolen-guardian case, but it leaves no fast stop for a buyback-specific bug short of
  the halt-all upgrade; with the rule above a stolen guardian can only create a backlog that nobody
  can buy ahead of, and the admin drains it before reopening buys.
* Not solvable on chain: clearing both flags in one proposal while large backlogs exist. The program
  cannot see every coin's backlog; the runbook (8.3, 14.1) drains first, and clearing both at once
  stays possible for small backlogs.

Spec 3.4, 4.0, 4.4, 4.13, 4.21, 4.22, 6.4, 7.1, 7.2, 8.1, 8.3, I20, I22, T72, T73, T76, O9, O25,
12.3 (L09, L12), 12.5 (H01, LL-1), 14.1 (the keeper's drain), 14.3. The IDL, the SDK's `setPause`
builder (`buybacks`), `decodeLaunchpad` (`buybacksHalted`), the `PauseChanged` decoder and the error
list follow.

Tests. `11-halts`: L12 (the guardian may halt buybacks only while buys are halted, never resume
them; the admin cannot halt buybacks alone or reopen buys before buybacks; the events carry the new
flag), H01 (a halt of buys alone leaves `buyback_burn` running; with buybacks halted it refuses with
`BuybacksHalted`; the admin resumes buybacks, then buys), and **LL-1**: two pool coins of about
320 SOL with the same history, buys and buybacks halted, everybody sells 95% in five rounds (the
backlog ends above `u*` on both), the admin cannot reopen buys first, resumes buybacks while buys
stay refused, the keeper drains coin A in 47 runs, then buys reopen; the first buyer of each coin
buys 5 SOL and holds through every run: on A he loses 0.237 SOL, on the undrained twin B he would
make 0.094 SOL after 39 runs (the reason for the runbook). `19-attacks-admin` X43b (the guardian
cannot resume buybacks), `08-buyback` (`BuybacksHalted`), unit tests `pause_roles` (every
combination of the four arguments and the consistency rule) and the review checklist's
`pause_flags_and_launchpad_keys` (`buys_halted` read only by `buy` and `launch`,
`buybacks_halted` only by `buyback_burn`), `launchpad_offsets` (offset 174); the checker's I20
(`buybacks_halted` only with `buys_halted`; set only by the guardian or the admin, cleared only by
the admin) and its I22 probe (buybacks while `buybacks_halted` is clear); the fuzz model predicts
`BuybacksHalted` and `BuybackHaltWithoutBuyHalt`. Against the previous build, H01 fails at its
first `set_pause` (the event has no `buybacks_halted`) and the LL-1 test at its first `set_pause`
(`Unauthorized`: the old program reads only three arguments).

### 54. The buy that completes the curve offers only its charge (5.4, 14.1, 14.3, T79, G03; review R3-CLI-1)

**Spec.** 14.3: "A router can cap its input with `max_quote_in` to keep exact-in semantics, or treat
`charged < sol_in` as the amount used." `sdk/curve/compose.mjs` (entry 44): "A buy that completes the
curve charges less than sol_in (partial fill); the rest of what the swap delivered stays in the
user's wallet." The README's direct buy: `ix.buy({ solIn: 1 SOL, minTokensOut: withSlippage(q.tokensOut, 100) })`.

**Issue.** Near graduation, `buyLegMinimum` took the buy leg's minimum from a partial quote (which
prices only the remainder, about 1 SOL at 84 SOL raised) while `buyWithSwap` kept `sol_in` at
everything the swap delivered. If any other buy graduated the coin first, the same instruction ran
in the pool, was charged all of `sol_in` and still cleared the small minimum: the minimum no longer
limited the price. The verifier's on-chain cases: a 20 SOL buy at 2% paid 4.9 times the quoted
price and the searcher (graduate, then a 94.75 SOL pool buy, then sell) took 10.77 SOL; 100 SOL,
15 times and 79.6 SOL; even with no attacker, a race with an honest completing buy charged the
victim 20 SOL instead of 1.03 SOL. The program behaves as specified (M13's strict minimum assumes
clients size the completing buy with `max_quote_in`, as 14.2 says); the defect is in the SDK and in
14.3's guidance. Nothing on the website imports `sdk/curve` yet.

**Choice.** The review's client fix, built so that the SDK cannot produce the unsafe pair:
* `buyLeg({ solIn, coinAccount, slippageBps | minTokensOut, mint })` quotes `solIn` on the coin as
  read before signing; when the quote is a partial fill it caps `solIn` at the quote's charge
  (equal to `max_quote_in` at that state) and takes the minimum from that same quote. It returns
  `{ solIn, minTokensOut, quote }`. `coinAccount` is now required, also with an explicit
  `minTokensOut`, since the cap reads it.
* `buyWithSwap` uses it: the buy offers the capped `solIn`; it also returns `swapSolIn`, what the
  swap is guaranteed to deliver; the difference stays in the wallet.
* `buyLegMinimum` (kept for callers that build the buy themselves) refuses a `solIn` that `buyLeg`
  would cap, with a message that names the charge to offer.
* The README's direct buy uses `buyLeg`.
* 14.3 now requires routers to cap at `max_quote_in` and take the minimum from that quote; 5.4
  says why; T79 ("forcing a victim out of a partial fill") sits next to T17.
* Not taken: M13's price-limit option, or a `max_charge` argument. The price limit would not help
  (the minimum was computed for the smaller charge, so `tokens_out * sol_in >= min * charged` still
  holds in the pool), and a new argument changes every client's instruction for a case the client
  rule closes. With the cap, the same bundle makes the victim's buy fail with `SlippageExceeded`.

Tests. `29-clients` R3-CLI-1, against the real program with the checker on: two config #0 coins at
84 SOL raised; `buyWithSwap` for a 20 SOL ExactIn swap at 2% offers exactly the partial quote's
charge (= `max_quote_in`) with that quote's minimum, both encoded; `buyLegMinimum` refuses the
uncapped pair; the searcher's bundle (graduate, then 94.75 SOL in the pool) runs; a simulation of
the uncapped pair shows it would be charged all 20 SOL and pass; the capped buy fails with
`SlippageExceeded` and the victim pays nothing; on the twin coin an honest buyer completes the
curve first and the capped buy then pays at most its charge. `sdk/curve/prechecks.test.mjs`: the cap
in `buyLeg` (with a slippage or an explicit minimum), `buyLegMinimum`'s refusal and its acceptance
of the capped `solIn`, no cap below the remainder or in the pool, `coinAccount` required. Against
the previous SDK, the 29-clients test fails at its first assertion (`solIn` is 20 SOL).

### 55. The buy leg's slippage depends on its size (5.15, 7.4, 14.1, T80; review MATH3-1)

**Spec.** 5.15 (revision 3, written for ECON-1): "under config #0 (t = 2.5%, founder 0.5%) no
ordering profits at the website's slippage", with "the website's default slippage stays at 1% to
2% for normal sizes"; 14.1: "Default slippage 1% to 2%"; `buyLegMinimum` accepted a flat
`slippageBps` up to 500 for any size.

**Issue.** For a victim buy of `V` allowing slippage `σ`, the best ordinary sandwich (the largest
front-run that still lets the victim pass) earns about `σ * (V - (c/D) * depth)`, with `c` the
attacker's cost per leg and `depth` the market's SOL depth. Above `V* = (c/D) * depth` it profits
at any slippage and takes almost all of it; on a fresh coin (depth `x0` = 30 SOL) that is 0.75 SOL
for an outsider and 0.60 SOL for the founder, ordinary sizes. The review measured on chain (and the
math crate agrees to the lamport): 1 SOL at 1% on a fresh coin +2,035,797 lamports to an outsider,
the victim getting exactly 1.000% fewer coins; 5 SOL at 1% +46.9M (94% of the tolerance); 2 SOL at
40 SOL raised; 5 SOL in a fresh pool. The sentence was false at normal sizes and contradicted the
same paragraph's rule. The program is correct (it enforces the minimum); severity low.

**Choice.** The review's fix, enforced in the SDK so clients cannot ignore it:
* 5.15 states the threshold per attacker class and corrects the config #0 sentence; 7.4 and 14.1
  follow; T80.
* `sandwichThreshold(terms, state)` (math.mjs): `floor(depth * cheapestAttackerCostBps(terms) / D)`
  with `cheapestAttackerCostBps = t - max(b_F + b_H, b_P)`: the cheapest attacker the shares allow,
  a founder who also holds the float (entry 52) or whoever holds the platform's key (entry 56).
  Under config #0, 150 bps: 0.45 SOL at launch, 1.05 SOL at 40 SOL raised, 1.275 SOL at pool open.
  It is the first-order bound, so below every measured threshold (the safe side).
* `buyLeg` (and `buyWithSwap`, `buyLegMinimum`) allow at most `MAX_SWAP_SLIPPAGE_BPS` (5%) up to
  the threshold and `LARGE_BUY_MAX_SLIPPAGE_BPS` (0.3%) above it, judged on the capped charge, for a
  minimum given as well as one derived from `slippageBps` (the slippage a given minimum allows is
  rounded up); more is refused with a message that names the threshold and offers splitting.
  `buySlippagePolicy(coinAccount, solIn)` gives the website its default: 1%
  (`DEFAULT_BUY_SLIPPAGE_BPS`) up to the threshold, 0.3% above it.
* 0.3% rather than refusing large buys: above the threshold any slippage is taken, so the limit
  only bounds the loss (measured: the attacker keeps at most about 0.2% of the buy); a buy can be
  split into buys of at most the threshold, each in its own transaction (within one transaction a
  sandwich wraps them all). A private or protected submission path for large buys is mentioned in
  5.15, not built.
* Not changed: the program (nothing on chain can tell a sandwiched buy from an ordinary one) and
  the configs.

Tests. `29-clients` MATH3-1, on chain with the checker on: the review's sandwich of a 1 SOL buy at
1% on a fresh config #0 coin profits and takes almost the whole 1%; `buyLeg` refuses that buy at 1%
and 2%; at the SDK's 0.3% the same best sandwich costs the victim at most 0.3% and leaves every
attacker class (an outsider, the founder, the founder holding the float, the platform's key) at
most 0.3%; at the threshold with the full 5% every class loses, on the curve at launch, at 40 SOL
raised and in a fresh pool. `sdk/curve/prechecks.test.mjs`: the threshold and the cost per class,
the policy and its defaults, a given minimum judged like a derived one, the threshold as depth grows.
Against the previous SDK both MATH3-1 tests fail at their first threshold call (there was no
`sandwichThreshold`), and the CLI-1 test at its new refusal of a 5 SOL buy at 2% on a fresh coin
(`buyWithSwap` built it). The given minimum is judged with the same rounding as a derived one: at
least `withSlippage(quote, max)`. Measured in the test: the review's sandwich +2,035,790 lamports;
at 0.3% the victim loses 0.30% and the outsider makes +623,692 (0.06%); at the threshold with 5%
the best results are -1,943,804 (founder holding the float, launch), -4,535,468 (40 SOL raised) and
-4,577,093 (fresh pool), every other class lower.

### 56. The platform's key in the MEV rules; open owner decision O29 (5.13, 7.3, 8.1, 8.4, T24, T76, O1, O25, O29; review HR-1)

**Spec.** 5.13: `m = max(b_F, b_H)` is "the largest share an attacker can be credited back on his
own legs"; V8, V11 ("15 for a credited attacker"), T24, T76 and O25 state their bounds for any
credited attacker; 8.1: `FEE_RECIPIENT` may "trade ... like any wallet".

**Issue.** `withdraw_platform_fees` is permissionless and pays all of `platform_pending` to
`FEE_RECIPIENT`, so whoever holds that key (the owner's hot wallet, or a thief of it) gets `b_P` of
his own legs back, trading from any wallet. `b_P` exceeds `m` in config #0 (70 against 50) and in
O1's named alternative (120 against 50). Measured on chain by the review and its verifier: under
O1's alternative `FEE_RECIPIENT` profits from a 1.343% backlog after 14 runs (+18,083 lamports;
the founder from the same state loses 1,382,754); under config #0 with a founder seat held by the
same owner (credited 120 of 250 bps), +14,186 lamports from 1.338% after 14 runs; (0, 120, 0, 1, 1)
passes V1 to V11 and `FEE_RECIPIENT`'s canonical single-run sandwich of 5 SOL returns +0.05%, where
V8 promises at least -1%. Under config #0 alone `FEE_RECIPIENT` stays inside O25's founder envelope
(first profit at about 1.85% to 1.9% and 19 runs). The verifier rated it info: every breach needs an
owner-chosen config or the owner stacking a founder seat on `FEE_RECIPIENT`, and the actor is the
owner's own wallet, the trust class 7.4 already uses to excuse V2b. The defect is the spec's
universal claims.

**Choice.** Correct the claims and replace the missing rule with an operating rule; leave the
fee-split question to the owner.
* 5.13, V8, V11, 7.3 (a closing paragraph with the platform's measured envelope), 8.1, T24, T76,
  O25 and O1 now exclude the platform's key and give its numbers.
* 8.4's operating rules gain one: `FEE_RECIPIENT`, and every wallet of the owner who controls it,
  never holds or trades city coins and never takes a founder seat (the admin may approve itself as
  a founder; the owner does not); the keeper alerts when `FEE_RECIPIENT` holds any city coin. The
  program cannot enforce it: refusing `FEE_RECIPIENT` as a trader would protect nothing, since the
  credit reaches the platform's key whichever wallet trades.
* The clients' sandwich threshold (entry 55) counts `b_P`.
* **Open owner decision O29 (not changed here):** count `b_P` in the MEV rules, either
  `m = max(b_F, b_H, b_P)` in V8 with a platform horizon of its own in V11 (config #0 passes V8 with
  70, at 0.98608 against 0.99, but fails V11's credited inequality at `K_F = 15`,
  2,418,175,000 > 2,412,990,000, and at 14; it passes at `K_P = 13`), or keep `b_P <= m` in every
  config. Both change which fee splits are allowed (they would refuse configs such as
  (0, 120, 0, 1, 1), and O1's alternative would need the platform horizon), and they need a crate,
  model and golden-vector change before the audit. The task's rule for this round: no fee value or
  fee rule that needs an owner decision is changed; it is recorded here and as O29.

Tests. `18-attacks-buyback` HR-1, on chain with the checker on (signature checks off, as for every
test that shows what `FEE_RECIPIENT`'s holder could do): (0, 120, 0, 1, 1) is accepted by
`add_launch_config`; the clients' cheapest attacker cost under it is 2 bps (the platform's), not
121; `FEE_RECIPIENT`'s canonical single-run sandwich of 5 SOL (buy, one `buyback_burn`, sell,
`withdraw_platform_fees`) gains, while a plain trader from the same state loses more than 1%. The
test pins the corrected claim; HR-1 changes no program behaviour, so it passes against the previous
build too (the code half of the fix, the clients' threshold, is tested with entry 55).

### 57. The completing buy within 97,500 lamports of graduation offers `max_quote_in`, not the bare charge (5.4, 14.1, 14.3, T79; reviews R4-DIFF-1, SM-1, SDK4-1)

**Spec.** Entry 54 and the round-3 `buyLeg`: "when the quote is a partial fill it caps `solIn`
at the quote's charge (equal to `max_quote_in` at that state)". 5.4 defines `max_quote_in =
max(MIN_TRADE_LAMPORTS, gross_for(rem))`.

**Issue.** The two differ when `gross_for(rem) < MIN_TRADE_LAMPORTS`, that is within about
97,500 lamports of graduation. `buyLeg` re-quoted the bare charge (51,282 lamports at a
remainder of 50,000; 1 lamport at the curve buyback's end state `S - 1`, which I22 lists as
normal), and `quoteBuy` threw `MathError::TradeTooSmall` for every size: `buyLeg`,
`buyLegMinimum` and `buyWithSwap` built nothing, so no client on the SDK could buy or graduate
such a coin, while the program accepts `sol_in = 100,000`, charges 51,282 and graduates it.
Anyone could create the state for a few cents (a buy of `gross_for(R - r - 50,000)`), and the
normal end of a curve buyback creates it. The verifiers rated it low (one reported medium): no
funds move, a hand-built buy or any sell unblocks it.

**Choice.** The review's fix, with the verifier's correction for the last raw unit:
* `buyLeg` caps `sol_in` at `maxQuoteIn(terms, state)` when the quote is partial. Above
  `MIN_TRADE_LAMPORTS` this is the charge, as before (an exact fill). Below it, the capped buy
  offers `MIN_TRADE_LAMPORTS` and its quote stays partial: it takes the last `S - s` raw units
  for `gross_for(rem)`. The internal check accepts a partial quote only there.
* A derived minimum is the quote less the slippage, at least 1 (at the buyback's end state the
  quote is one raw unit, and `withSlippage(1, 100)` is 0; the verifier found the review's fix
  alone still threw there). A floor of 1 allows less slippage than asked, never more.
* The R3-CLI-1 exposure left: if someone graduates the coin first, the capped buy runs in the
  pool and is charged `MIN_TRADE_LAMPORTS`, 0.0001 SOL; it still gets at least its minimum,
  since the pool opens at the curve's last price.
* The compose.mjs header, the README, 5.4, 14.1, 14.3 and T79 say so; entry 54's sentence
  "equal to `max_quote_in` at that state" holds only above `MIN_TRADE_LAMPORTS`.

Tests. `sdk/curve/prechecks.test.mjs` R4-DIFF-1: remainders 1 (the buyback end state), 1,000,
50,000, 97,000, 97,400, 97,499, 97,500, 97,600 and 200,000, for `sol_in` of `MIN_TRADE_LAMPORTS`,
`max_quote_in`, 1 SOL and 20 SOL at 0, 1% and 5%: every leg is built, offers `max_quote_in`,
takes `S - s`, minimum at least 1; `buyLegMinimum` and `buyWithSwap` agree; the capped buy in the
pool is charged `MIN_TRADE_LAMPORTS` and passes. `29-clients` R4-DIFF-1, on chain with the
checker on: a coin left 50,000 lamports short by a buy and one left 1 lamport short by a curve
buyback; the website's call (`buyWithSwap`, 1 SOL, `buySlippagePolicy`'s default) builds a buy of
`sol_in = 100,000` that graduates each coin, charged 51,282 and 1 lamport; on a third coin someone
else graduates first and the capped buy is charged exactly `MIN_TRADE_LAMPORTS` in the pool.
Against the previous SDK both fail at the first `buyLeg` (`TradeTooSmall`).

### 58. The sandwich threshold: the pool's depth near graduation, and one buyback run (5.15, 7.4, 14.1, T80; reviews R4-DIFF-3, SDK4-2, SDK4-4)

**Spec.** Entry 55: `sandwichThreshold = floor(depth * (t - max(b_F + b_H, b_P)) / D)` with
`depth = x0 + curve_sol` on the curve; 5.15: "at the threshold every attacker class ... loses at
every slippage up to 5%, in both phases".

**Issue.** Two orderings the bound left out, both reproduced on chain:
* R4-DIFF-3, SDK4-2: near graduation the curve's depth reaches 115 SOL, but a curve-quoted buy can
  be pushed into the pool, which opens at depth `graduation_sol` (85 SOL), by whoever graduates
  the coin first. At 1.7 SOL short of graduation the threshold was 1.6995 SOL; a buy of that
  size at 5% (allowed, not completing) was straddled (graduate, buy in the pool, the victim's buy
  runs there, sell) for +9,776,268 lamports by a founder holding the float, the threshold's own
  class; at 4% too. The other classes lost.
* SDK4-4: a due `buyback_burn` is permissionless, so an attacker can place one between the
  victim's buy and his back-run. At the threshold with 5% the founder holding the float then
  made +74,456 lamports on a fresh coin (+173,729 at 40 SOL raised).

**Choice.** Both fixes the reviews proposed, which lower the threshold (the safe side):
* `sandwichDepth(terms, state)` = `min(x0 + curve_sol, graduation_sol)` on the curve,
  `pool_sol` in the pool.
* `sandwichCostBps(terms)` = `cheapestAttackerCostBps(terms) - buybackRunMarginBps(terms)`, at
  least 0, with `buybackRunMarginBps = ceil(2t / C)` for a config with a buyback share (a run
  spends up to `t/(C*D)` of the depth and moves the price about twice that), 0 without one.
* `sandwichThreshold = floor(sandwichDepth * sandwichCostBps / D)`. Config #0: 130 bps; 0.39 SOL
  at launch (390,011,097), 0.91 SOL at 40 SOL raised, 1.105 SOL from 55 SOL raised and at pool
  open (it was 0.45, 1.05 and 1.275).
* `depth` and `buybackCap` are unchanged (the program's figures). 5.15, 7.4 (whose "2% to 2.5%"
  was round 2's figure, SDK4-6), 14.1 and T80 follow.

Tests. `prechecks.test.mjs`: the threshold's parts; R4-DIFF-3's victim (1,699,512,804 lamports
at 5%) is now refused; the straddle by the model at remainders 1.5 to 3 SOL profits at the old
threshold and loses for every class at the new one, with the attacker graduating the coin or
someone else doing it; SDK4-4's sandwich with one due run profits at 150 bps and loses for every
class at the new threshold, on the curve at launch, at 40 SOL raised and in a fresh pool.
`29-clients`, on chain with the checker on: R4-DIFF-3 (the old size at 5% straddled for
+9,776,268 by the founder holding the float; the SDK's 1.105 SOL at 5%: every class loses) and
SDK4-4 (the old 450,012,804 with a run: +74,456; the SDK's 390,011,097: every class loses).
The MATH3-1 tests keep passing with the new figure. Against the previous SDK the new tests fail
(no `sandwichDepth`; the old figures).

### 59. Splitting is no defence; the sell leg (5.15, 14.1, T80; reviews R4-DIFF-2, R4-DIFF-5, SDK4-3)

**Spec.** Entry 55, 5.15 and 14.1: above the threshold the website "offers to split a larger
buy into buys of at most the threshold, each in its own transaction (within one transaction a
sandwich wraps them all)"; `buyLeg`'s refusal said "split it into buys of at most ...". 5.15
named `min_sol_out` in the defence, but the SDK had no sell rule (`ix.sell` took any minimum).

**Issue.** R4-DIFF-2: an attacker can hold his position across transactions: a front-run before
the first piece and a sell after the last wrap all of them, and each piece clears its own
minimum because only the first binds. Measured on chain: a 5 SOL buy split into threshold-size
pieces at 1% each lost 0.93% and paid an outsider +0.044 SOL, three times what the 0.3% rule
allows on the single buy. R4-DIFF-5, SDK4-3: a sell above the threshold is sandwiched the same
way by any holder (sell first, buy the same coins back): 4.4 SOL at 1% at 60 SOL raised, the
seller lost 0.99% and the outsider made +21.6M lamports and kept extra coins.

**Choice.**
* The split advice is gone from `buyLeg`'s refusal, 5.15 and 14.1, which now say that
  splitting does not help and that a protected submission path is the way for large trades.
  For a client that splits an order anyway (a schedule, a DCA), `buyLeg`, `buyWithSwap` and
  `buySlippagePolicy` take `orderSolIn`, and `sellLeg` and `sellSlippagePolicy` take
  `orderGross`: the piece is judged by the order's total, so each piece of a large order
  allows at most 0.3%.
* `sellLeg({ tokensIn, coinAccount, slippageBps | minSolOut, mint, orderGross })` and
  `sellSlippagePolicy(coinAccount, tokensIn)` mirror the buy side on the sell's gross: at most
  5% at or below the threshold (default 1%), 0.3% above it, a minimum given or derived, at least
  1 lamport, no sell without one. The rent rule stays `precheckSell`'s. 5.15, 7.4, 14.1 and T80
  name sells.

Tests. `prechecks.test.mjs`: the refusal's wording; a threshold-size piece of a 5 SOL order is
refused at 1% and built at 0.3%; the sell leg's rules, guards and policy, in both phases.
`29-clients`, on chain: R4-DIFF-2 (13 pieces at 1%: every piece passes, the victim loses 93 bps,
every class profits; judged by the order at 0.3%: 28 bps) and R4-DIFF-5 (a 6.3 SOL gross sell
at 1%, refused by `sellLeg`, sandwiched for +39M by an ordinary holder, the seller losing
95 bps; at `sellLeg`'s 0.3%, 24 bps; a threshold-size sell at 5% leaves every class at a loss).
Against the previous SDK they fail (the message, no `orderSolIn`, no `sellLeg`).

### 60. The swap's output mint; the docs follow the SDK (14.1, G03; reviews SDK4-5, SDK4-6)

**Issue.** SDK4-5: `solInFromSwapQuote` read only `swapMode`, `outAmount` and
`otherAmountThreshold`, so a quote to USDC (a wrong route from a multi-route panel) made
`buyWithSwap` read 398 USDC as 0.398 SOL and spend SOL the user already held, against G03's
unconditional claim. SDK4-6: the README's direct buy (`buyLeg` of 1 SOL at 1%) threw on any
fresh coin since round 3, and 7.4 and the 29-clients header still gave round 2's "2% to 2.5%".

**Choice.** `solInFromSwapQuote` requires `outputMint` to be the native mint and `inputMint`
another one, and throws `ComposeError` otherwise; that the swap must unwrap
(`wrapAndUnwrapSol`) cannot be read from the quote and is documented (14.1, the README). The
README's direct buy takes its slippage from `buySlippagePolicy` and shows the sell leg; 7.4 and
the header give the SDK's 1.3%.

Tests. `prechecks.test.mjs` SDK4-5 (a USDC output, no output mint, a SOL input: refused) and
SDK4-6 (the README's lines run on a fresh coin, at 40 SOL raised and near graduation; 7.4 and
the header no longer say 2% to 2.5%). `26-router` G03 and every swap quote of the suites carry
the mints.

### 61. The rewards registry's admin is checked at every approval and launch (3.2, 4.8, 4.10, 4.22, 8.2, 8.4, I19, U12, L04; review OPS-1)

**Spec.** 8.4's precondition: "`vicinity_rewards` registry admin and upgrade authority are the
Squads vault", with "the deploy checklist checks each on chain"; no checklist existed
(`scripts/vcurve/` held `idl.sh` and `sbf-builds.sh`), and nothing in `vicinity_curve` read the
registry. On mainnet today the registry admin is the owner's hot wallet `13qRam...`, which is also
`FEE_RECIPIENT` (`release/mainnet-2026-10-10/BUILD.md`).

**Issue.** `vicinity_rewards`' `init_city` needs only the registry admin's signature (it may also
sign as authority and founder), and the program has no instruction that changes or closes a
city's economics. While a hot key held the seat, it alone could create a new coin's config
(Creator, `founder_bps` 10,000) before the multisig's time-locked `init_city`; every
`forward_holders_fees` then failed with `WrongRewardsConfig`, also after the registry was handed to
the vault, and the holders' 0.5% waited in `holders_pending` until an upgrade (O26). Reproduced by
the verifier with the production build and the mainnet `vicinity_rewards`. Low: money frozen, not
stolen; it needs the precondition skipped and the hot key misused.

**Choice.** The review's fail-closed fix, as GOV-1 did for the old program's admin:
* `approve_launch` and `launch` take `rewards_registry` (read-only, after `legacy_launchpad`):
  its address must be `REWARDS_REGISTRY` (`["registry"]` under `REWARDS_PROGRAM_ID`, compiled per
  cluster, mainnet `2i9xvF...`, devnet `2rKKwG...`; U12 checks both derivations and the layout
  against the committed `vicinity_rewards` IDL) (`InvalidAddress`), and
  `rewards_registry_matches`: owner `REWARDS_PROGRAM_ID`, 73 bytes, the `Registry`
  discriminator, `admin == launchpad.admin`, `pending_admin` zero
  (`RewardsRegistryAdminMismatch`, 6056, appended). The address is compared as immediates in
  the code, like `LEGACY_LAUNCHPAD`, so the checker's compiled-ids check lists it only among the
  other cluster's ids; the checker sees it at run time instead (I19).
* So nothing is approved or launched while a key outside the multisig holds the registry, and
  once a coin exists the registry can move only by the vault's own proposal. 8.2: the registry
  admin follows every hand-over of this program's admin, as the old program's admin does (the
  suite's `adminHandOver`; the fuzz's `followPlans`). Launch compute rose by about 380 CU.
* `scripts/vcurve/preflight.mjs`, the deploy checklist 8.4 described, now exists (entry 64).
* Constants (`REWARDS_REGISTRY`, its discriminator, length and offsets), the IDL, the SDK's
  account tables (`rewards_registry` in both lists), `CLUSTERS.*.rewardsRegistry`,
  `pdas.rewardsRegistry()`, the error list and the smoke test follow.

Tests. `28-governance` OPS-1 (signature checks off, the registry administered by `13qRam...` as on
mainnet): approvals refused with `RewardsRegistryAdminMismatch`, also with the transfer to the
vault pending; after the vault accepts, a coin launches; the former admin's `init_city` for it is
refused; the vault's config and a forward work; a pending transfer to anyone (even to the admin)
refuses launch and approval until cancelled; another address in the slot is `InvalidAddress`,
and a System-owned or another program's copy, one byte more or another discriminator at the
compiled address is refused; after `adminHandOver` the registry follows and launches go on. GOV-1's
test now also hands the registry over. Unit tests `rewards_registry_checks`,
`u12_rewards_registry_derivation_and_layout`, the checklist's account tables and error count;
`sdk/curve/idl.test.mjs` (constants, derivations, account tables). Against the previous build the
OPS-1 test fails at its first approval (that build takes neither the account nor the check; with
its own account list the hot registry admin's approval is accepted, as the verifier showed).

### 62. The recovery from a stolen guardian is a proposal no flag can make fail (4.4, 8.1, 8.3, T73; reviews R4-DIFF-4, OPS-3)

**Spec.** 4.4: "the admin replaces the guardian and clears the flags in the same proposal"; 8.1 and
8.3: "the guardian can only set flags"; `set_guardian.rs` said the same.

**Issue.** The consistency rule of `set_pause` (`!buybacks_halted || buys_halted`, entry 53) runs on
the admin's call too. A recovery `[set_guardian(new), set_pause(launches = false, buys = false)]`
written with the flags of its day (buybacks `None`, the SDK's default) fails with
`BuybackHaltWithoutBuyHalt` if the thief halts buybacks late in the 48-hour time lock, and the
vault transaction reverts `set_guardian` with it: the thief keeps the seat for another time lock.
Written with `buybacks = false`, the proposal executes but reopens buys and buybacks in the same
instant after a time lock of buyback halt, the LL-1 state (a backlog of 37.7 caps in the
verifier's run). Reproduced on chain by both lenses; low and info, no funds at risk, exits never
stop, and once every flag is set the thief has nothing left to set.

**Choice.** The review's runbook and SDK fix; the program is unchanged:
* The first proposal is `[set_guardian(new), set_pause(launches, buybacks = Some(false))]` with buys
  left as they are, or `set_pause(buys = Some(true))` with buybacks untouched when buybacks must
  stay halted. Either way the rule holds after it whatever the thief set, so it cannot be made to
  fail, and the thief loses the seat in that transaction. Buys reopen in a second proposal
  (`set_pause(buys = Some(false))`) after the keeper's drain; that one fails closed while
  buybacks are halted. Both may be approved together.
* The SDK builds the first: `ix.guardianRecovery({ admin, guardian, launches, keepBuybacksHalted })`;
  `setPause`'s comment warns against pairing `buys: false` and `buybacks: null` with `set_guardian`.
* 4.4 (a recovery paragraph), 8.1 (the guardian can make an unprepared proposal fail once), 8.3,
  T73 and the `set_guardian.rs` comment say so.
* Not taken: changing `set_pause` to check only the flags a call changes (it would let the
  forbidden state be stored), or making the admin's call exempt (the LL-1 state again).

Tests. `28-governance` R4-DIFF-4: the thief halts launches and buys; both recoveries simulate;
47 hours into the lock the thief halts buybacks; the one-proposal recovery fails twice with
`BuybackHaltWithoutBuyHalt` and the thief keeps the seat; `guardianRecovery` executes (guardian
replaced, launches open, buys halted, buybacks resumed), the former guardian is refused, the keeper
runs, a buy is refused until the second proposal, then works; with `keepBuybacksHalted` after the
guardian set every flag, the recovery executes and keeps buys and buybacks halted.
`prechecks.test.mjs`: the helper's encoding and the rule after it for every flag combination.
Against the previous SDK the test fails at `guardianRecovery` (undefined).

### 63. The keeper's top-up after a rent change: liabilities plus the live minimum (6.5, T63, 14.1; review OPS-2)

**Spec.** 6.5, T63 and 14.1 (from LC-INFO-1's side point, entry 33): "the keeper tops up every coin
below the live minimum after any rent change".

**Issue.** That rule does not unblock exits. A coin above the live minimum whose remaining exits
would cross it is refused by the runtime (`InsufficientFundsForRent`), and since the runtime never
lets it fall below the minimum the rule never fires for it; a coin below the minimum topped up
exactly to it still refuses its sell and its founder's claim. Measured by the verifier after a 10%
raise (`d` = 571,416 lamports): coin A with 2,000,000 lamports of liabilities refused its holder's
full sell, coin B topped up to the minimum refused its sell and claim. The program side
(`pay_out`'s floor `min(rent_reserve, live)`) is correct. Low: at most `d` per coin, anyone can
donate, but the documented remedy fails.

**Choice.** The review's rule: after any rent change, for every `Coin`, `need = liabilities +
rent_min(693) - lamports` (live rent), transferred when positive; the trigger is `lamports <
liabilities + rent_min`. The SDK's `coinRentTopUp({ coin, coinLamports, rentExemptMinimum })`
computes it (prechecks.mjs; earlier donations count). 6.5, T63 and 14.1 restated.

Tests. `20-attacks-runtime` OPS-2: both coins after a 10% raise; the old rule does not fire for A
while its full sell and, after a half sell, its rest are refused; B topped up to the minimum still
refuses sell and claim; `coinRentTopUp` gives exactly `liabilities + live - lamports`, after it
nothing more is needed and every sell, claim and withdrawal of both coins goes through.
`prechecks.test.mjs`: the helper's arithmetic. Against the previous SDK the test fails at
`coinRentTopUp` (undefined).

### 64. The deploy checklist, and no old Approval when the old program is closed (8.4, 8.5, O19; reviews OPS-4, OPS-1)

**Spec.** 8.4: "the deploy checklist checks each on chain" (none existed); 8.5 and O19 offered closing
the old program once paused for good, and named only the frozen admin field as its cost.

**Issue.** OPS-4: `approve_launch` and `launch` refuse any account at the old program's Approval
PDA (`LegacyApprovalExists`), whether or not it expired, and an old approval closes only by the
old program's `revoke_approval` (admin only) or `launch`. After a loader `Close` of the old
program (what `solana program close` sends) the account stays for ever, owned by the closed
program; revoke fails ("Program is not deployed") and the city is refused here permanently
(verified with the real old binary, 60 days later too). Info: closing is O19's non-default
alternative and needs an approval left open before the close; mainnet has none today (the finding;
not checked here).

**Choice.**
* 8.5 and O19 gain the precondition: before a close, the old program holds no `Approval`
  (getProgramAccounts on `LEGACY_PROGRAM_ID`); each is revoked first while the program can run;
  making it immutable instead of closing it avoids the trap.
* `scripts/vcurve/preflight.mjs` is the checklist 8.4 describes, read-only: from a web3.js
  Connection (getMultipleAccountsInfo, getProgramAccounts) or a snapshot, it reports
  `{ problems, warnings }` for vicinity_curve's admin, pending admin, upgrade authority,
  guardian and config #0, the rewards registry's admin (OPS-1) and upgrade authority, the old
  program's admin, upgrade authority, pause and configs, every old `Approval` (a warning, a
  problem with `--before-legacy-close` or once the old program is closed), and coins or
  approvals whose founder holds a role (8.4's operating rule). The time lock and the published
  program metadata are confirmed by hand. CLI: `node scripts/vcurve/preflight.mjs --rpc <url>
  --vault <vault> [--cluster] [--program-id] [--before-legacy-close]`, exit 1 when not ready.

Tests. `28-governance` OPS-4: in a World whose upgrade authorities are moved to the vault, the
checklist reports nothing; an enabled old config, open old launches, an outstanding old approval
(warning, then a problem before a close), a registry transfer pending to a stranger and a founder
named as guardian (a doctored snapshot) are each reported; then the old program is closed with the
approval open: the approval survives, revoke fails, the city is refused 60 days later, and the
checklist reports it in any mode. Against the previous tree it fails at its import (no script).

### 65. Launch compute over many city ids; the first buy's token-account create (11.1, 11.3; review TL-INFO-1)

**Spec.** 11.1: "`launch` 110,600 to 125,900"; entry 30: launch varies "from city to city by a few
thousand units"; the suggested client limits did not mention the website buy's token-account
create.

**Issue.** Over 600 city ids `launch` spans about 110,000 to 152,000 CU: the bump searches of the
PDAs it derives or re-derives (coin, mint, vault, ticker, Metaplex metadata, the old program's coin
and approval) cost about 1,500 to 1,700 CU per extra iteration. City 1000 with name A and symbol C0
took 150,629 (18 extra iterations); a client that sized launch's limit from the stated range failed
there. The idempotent ATA create costs `13,424 + 1,500 x k`. Info: every asserted budget (launch
230,000) and the suggested 300,000 or 1.2 x simulation hold; no funds move.

**Choice.** 11.1 restated from a fresh measurement on this build (with the registry account):
110,382 to 152,266 over 600 city ids (median 123,882, p99 145,022); city 1000 / A / C0 151,008; ATA
create 13,424 to 25,424 over 300 owners, with the formula; first buys take their limit from a
simulation or add 30,000; every figure is re-measured once the mainnet id exists (its bumps move
every money instruction by 1,500 to 2,400 CU per iteration). 11.3: launch has 22 accounts and the
lookup table holds `REWARDS_REGISTRY`.

Tests. `12-compute` TL-INFO-1: city 1000 / A / C0 within 230,000 and within the range 11.1 states
(read from the spec; revision 3's sentence fails it), and six first buys whose ATA create matches
`13,424 + 1,500 x (255 - bump)`. `04-launch`'s lookup-table test includes the registry.

Follow-up (CI). The first CI run of a1301dd measured a base of 13,433, not 13,424: the base is the
associated token program's own cost and differs by a few CU between runtimes. The test now holds
the 1,500 per iteration exactly and the base within 13,400 to 13,460 (any wrong `k` is off by at
least 1,500); 11.1 says "about 13,430".

### 66. The checker holds every call to the flags of its moment, and approvals and opt-ins to their rules (I20, 12; review SM-2)

**Issue.** Coverage, not a program defect: the per-transaction checker never asserted that a
successful `buy`, `launch`, `buyback_burn` or `payout_founder_fees` ran under permitting flags, nor
what `approve_launch` and `opt_in_payout` wrote; the verifier replayed real contexts with doctored
flags and all five were accepted. Only the dedicated suites would have caught a dropped
`require!`.

**Choice.** `checkTransaction` now walks the calls in order with the flags of the `Launchpad` before
the transaction, applying each `set_pause`'s `Some` arguments as it passes them: `buy` and `launch`
need buys open, `launch` launches open, `buyback_burn` buybacks open (the handler checks the flag
before its no-op return), `payout_founder_fees` payouts open. A new `Approval` must hold what 4.8
allows (city id at least 1, a founder that is not `FEE_RECIPIENT`, the guardian or the payout key,
a nonzero `meta_hash`, `approved_at` the clock's and an expiry within 30 days, an enabled config,
an `A-Z0-9` symbol of 1 to 10 bytes, a name of 1 to 32 bytes without control characters or edge
spaces, the admin as rent payer); a new `PayoutOptIn` the coin's founder and the payout wallet. I19
also checks the rewards registry (entry 61). Not done: the I22 probe's pool-buy and payout probes
(optional hardening in the finding).

Tests. `27-checker-gaps` SM-2: the real contexts pass; doctored flags (buy, launch twice, buyback,
payout) are refused with SM-2's messages; a transaction that halts, resumes and buys passes, and
the same calls reordered (resume, halt, buy) are refused at the buy; seven doctored approvals and
two doctored opt-ins are refused. Against the previous checker every doctored case is accepted.

### 67. A piece of a split order is held to the order's start (5.15, 14.1, T80; review R5-DIFF-1)

**Spec.** Entry 59 and 5.15: a client that splits an order (a schedule, a DCA) judges every piece by
the order's total (`orderSolIn`, `orderGross`), "0.3% per piece, measured 0.28%"; `buyLeg`'s input is
"the coin as read before signing".

**Issue.** The 0.28% came from a test that computed every piece's minimum up front from the order's
first snapshot. A schedule reads the coin again before each piece, and each piece's 0.3% was then
measured from a price that already held a searcher's earlier buys: he bought ahead of every piece by
the most it still cleared and sold after the last. Measured on chain with the production build: a
5 SOL order in 13 pieces lost 187 bps and paid him +70,707,128 lamports; the model gives 327 bps on a
10 SOL order and 98 bps on a 6-piece sell (against 24 bps sold at once). Without `orderSolIn`, at the
old 1% per piece, the same reads lost 609 bps, so round 4 cut the loss by about 3x but did not reach
its bound. Low: client side only, no program funds.

**Choice.** The review's option 1, made the only way to build a piece:
* `buyLeg`, `buyWithSwap` and `sellLeg` take `order = { start, pieces, received }`: the decoded coin as
  read when the order began, the size of each earlier piece as sent (`sol_in` of buys, `tokens_in` of
  sells) and what they delivered (raw coins, lamports). A leg smaller than `orderSolIn` / `orderGross`
  without `order.start` is refused (`ComposeError`, naming R5-DIFF-1); so are `order` without its
  total, another coin's start and buy pieces adding up to more than `orderSolIn`.
* The piece's minimum is at least `floor(Q * (D - s) / D) - received`, where `Q` is what the earlier
  pieces and this one deliver in sequence from `start` with no other trade (the SDK's quotes, which equal
  the program, G01), and at least its own minimum on the current read. When the current quote is
  already below that floor the piece is refused: the order has used up its slippage and ends. A given
  minimum must clear the floor at the policy's largest slippage. Whatever happens between the pieces,
  the order then loses at most `s` against its quote at the start.
* Pieces signed together from one snapshot pass the snapshot advanced by the earlier pieces as the coin
  and their quoted coins as `received` (the R4-DIFF-2 test does). An order restarted from a fresh read
  starts a new budget; 5.15 and 14.1 say that a client restarting after every refusal gives the bound up.
* `buySlippagePolicy` and `sellSlippagePolicy` keep `orderSolIn` / `orderGross` (they build no minimum).
* 5.15, 14.1, T80, the compose.mjs header and the SDK README say so.

Tests. `prechecks.test.mjs` R5-DIFF-1: the refusals; the first piece read at the start keeps its own
minimum; the review's ratchet in the model, 13 pieces each from a fresh read with a greedy searcher:
round 4's minimums lose 187 bps (+70.8M to the searcher), the anchored ones 29 bps (+13.9M); a piece
after the price moved more than the order allows is refused; a given minimum below the floor is refused;
sells: 100 bps with fresh minimums, 29 anchored. `29-clients` R5-DIFF-1 on chain: the same 5 SOL order,
each piece built from `w.coinView` just before it is signed, a searcher front-running every piece by
the most it clears: the order loses 29 bps and the searcher keeps +13,924,931 lamports (0.28% of the
order). `29-clients` R4-DIFF-2 passes the order's start. Against the previous SDK both fail (a piece
without `order` was accepted, and `order` was ignored).

### 68. The slippage a trade at or below the threshold may allow depends on its size (5.15, 7.4, 14.1, T80; review MV-1)

**Spec.** 5.15: "at the threshold every attacker class ... loses at every slippage up to 5%"; T80: "at
most 5% up to the coin's sandwich threshold, where no sandwich profits"; the SDK's `policy` allowed 5%
for any trade at or below the threshold.

**Issue.** The threshold was judged one trade at a time. Two honest trades that read the same coin and
land in one block (a launch, a graduation, the first block after buys reopen) are wrapped by one
sandwich, and each one's tolerance is room for the trades ahead of it. Measured on chain: two
threshold-size buys at 5% in a fresh pool, each safe alone, paid the founder +12,722,874 lamports and an
outsider +948,502 with the due run inside (the outsider only with the run and from 3%); sells alike
(+15,196,387). The victims lost about 2.6% of their 2.21 SOL to the attack, each capped by his own
slippage. Low (reported medium): the bad cases need trades near the 5% maximum; at the website's 1%
only the founder holding the float profits (+259k to +505k lamports in the model).

**Choice.** The review's rule, on the charge for buys and the gross for sells: a trade of size `V` at
or below the threshold may allow a slippage `s` only while `V + floor(depth' * s / (2D)) <= threshold`,
taken as the largest `s = floor(2D * (threshold - V) / depth')`, clamped to `LARGE_BUY_MAX_SLIPPAGE_BPS`
(0.3%) to `MAX_SWAP_SLIPPAGE_BPS` (5%); the default is 1% or that maximum when lower. Whatever lands ahead
of the last trade must fit within its tolerance (about `depth' * s / 2`), so the trades one sandwich wraps
stay under the threshold together. Config #0: about 2.6% for the smallest trades, 1.93% at 0.1 SOL and
1% up to 0.24 SOL on a fresh coin, 1% up to 0.68 SOL at pool open; never 5%. The 0.3% floor keeps the
large-trade regime in the top 0.15% of depth below the threshold (two such trades cannot both pass even
unattacked). The refusal names MV-1. `buyLeg` and `sellLeg` also return `maxSlippageBps`. 5.15, 7.4,
14.1 (the panel and the default), 14.3 and T80 restated; the statement that the threshold holds for one
trade alone stays as the single-trade bound the rule builds on.

Tests. `prechecks.test.mjs` MV-1: the rule's figures at nine sizes, the leg at the maximum and the
refusal one bps above (derived and given), the review's two threshold buys at 5% with the run profit in
the model (+24.6M for the founder holding the float) and are refused, and one to three buys from one
snapshot at the largest sizes the rule allows for 0.5% to 2.5% (and half of them), held through every
run, lose for every class at launch, at 40 SOL raised and at pool open with one and with three caps;
the earlier tests at the threshold now build its 5% by hand (the single-trade bound) and assert that the
SDK refuses it. `29-clients` MV-1 on chain: round 4's allowance (two threshold buys at 5%) pays the
founder +10.9M; the SDK refuses it; two buys at its largest 2% size and three at a quarter of its largest
1% size, built with `buyWithSwap` from one snapshot, leave every class at a loss with the runs inside.
Against the previous SDK the refusals fail and the sizes it allowed (5% to the threshold) profit.

### 69. The sandwich threshold counts every buyback run the visible backlog pays for (5.15, 7.2, 7.3, O25, T76, T80; review KR-1)

**Spec.** Entry 58: the threshold's cost leaves room for one run (`ceil(2t/C)`); 7.3 and O25: a hold
through `K` runs profits only above 1.5% of depth and 16 runs for a founder (2.0% and 21 for anyone),
"with no other trading"; the keeper alerts above 1% of depth.

**Issue.** With an honest trade inside the hold the runs add to its price impact. Measured on chain: one
SDK buy at the threshold with 5%, a front-run held through 8 runs of a backlog of 0.84% of depth: the
founder +297,718 lamports; 10 runs: +8,400,788; an outsider through 15 runs of 1.5%: +7,901,169; at the
website's 1% the founder after 10 runs (+2,011,609). The model's least `K` with the victim inside is 13
for an outsider, 8 for the founder, 6 for the platform's key and 3 for a founder holding the float,
against 26, 21, 19 and 16 without it, at every slippage from 1% to 5%. Below the keeper's 1% alert.
Low: a visible backlog and a hold of minutes with market risk; the victim's loss is capped by his
slippage.

**Choice.** The review's first proposal: `sandwichRuns(terms, state) = max(1, ceil(buyback_pending /
cap'))`, with `cap'` a run's cap at the sandwich depth (`floor(depth' * t / (C * D))`: near graduation
the pool's 85 SOL, so more runs are counted than at the curve's depth), and
`buybackRunMarginBps(terms, state) = ceil(2t/C) * sandwichRuns` (one run without a state, as before);
`sandwichCostBps` and `sandwichThreshold` take the state. Config #0: 130 bps with at most one cap, 20
less per further cap, nothing left from 7.5 caps (every trade large, 0.3%). A buy that completes the
curve alone leaves about 3 caps, so a fresh pool's threshold is 0.595 SOL until the keeper has run.
Also: the keeper's alert moves from 1% of depth to two caps (0.2% at t = 250), below the 3-cap figure;
7.3 states M_K's figures for a hold with no other trade and gives the lower ones with a trade inside;
O25 carries them and needs the owner's sign-off again (the SDK protects its own trades; a client that
allows more slippage than the SDK does not). Not taken: treating every trade as large while
`buyback_pending > cap` (it refuses ordinary sizes after every busy minute).

Tests. `prechecks.test.mjs` KR-1: the run count, margin, cost and threshold at nine backlogs (0 to
8.37 caps), the cap at the pool's depth near graduation, no buyback share; the review's states (8.37
caps at 5%, 3 caps at 1%) profit at round 4's threshold in the model and are refused now; at backlogs of
0 to 7 caps the SDK's largest sizes for 0.5% to 2%, one or two victims, held through every run, lose
for every class. The R4-DIFF-3, SDK4-4, R4-DIFF-5 and MATH3-1 tests now name the backlog they assume.
`29-clients` KR-1 on chain: at 8.4 caps round 4's threshold at 5% pays the founder +2,483,539 after 9
runs (the founder holding the float +23.8M), at 3 caps at 1% the founder holding the float +747,711
after 4 runs; on twin coins the SDK refuses those buys, its 0.3% buy at 8.4 caps loses the victim 29 bps
at most, and its largest 1% buy at 3 caps leaves every class at a loss through every run.
`29-clients` SDK4-4 holds through every run the backlog pays for. Against the previous SDK the
refusals fail and its threshold's buys profit.

### 70. The guardian is never the admin or the proposed admin (4.1, 4.2, 4.4, 4.22, 8.1, 8.4, I20; review R5-CONS-1)

**Spec.** 8.1 and 8.4: the guardian is "a separate Squads multisig without a time lock", the fast brake
of 8.3 that halts buys at once while a hostile upgrade waits out its time lock (T46, T72); O9: without a
guardian "the only brake would take 48 hours".

**Issue.** Nothing enforced it. `init_launchpad`, `set_guardian`, `propose_admin` and `accept_admin`
compared the guardian with `FEE_RECIPIENT` and the payout keys only, and the deploy checklist checked only
`GUARDIAN_UNSET` and `GUARDIAN_PAYOUT`: with the vault as guardian (by `init_launchpad(guardian = admin)` or
`set_guardian(vault)`) it reported every precondition as holding (reproduced). A halt would then be a vault
proposal waiting 48 hours, O9's rejected alternative in disguise. Low: an operator misconfiguration; exits
are unaffected.

**Choice.** The safer fix, in the program and in the checklist:
* `check_guardian_separate(guardian, admin, pending_admin)` (helpers.rs): a nonzero guardian is neither the
  admin nor a nonzero proposed admin, else `GuardianIsAdmin` (6057, appended). `init_launchpad` checks the
  guardian against the signing admin, `set_guardian` against the admin and the pending admin,
  `propose_admin` the guardian against the proposed key, `accept_admin` against the accepting key. One
  comparison each; the existing refusals keep their order (`FeeRecipientRole`, `PayoutKeyNotSeparate` first).
* The checklist reports `GUARDIAN_IS_ADMIN` when the guardian is the admin, the vault or the pending admin
  (the vault check covers the state before the admin is handed to the vault, which the program cannot see),
  and its final line asks the operator to confirm that the guardian is a separate multisig without a time
  lock of its own, which nothing on chain shows.
* The checker's I20 asserts the same after every transaction. IDL (one error), the SDK's `ERROR_NAMES`,
  `checklist.rs` (58 codes), 4.1, 4.2, 4.4, 4.22, 8.1, 8.4 and I20 follow.

Tests. `28-governance` R5-CONS-1: `init_launchpad(guardian = admin)`, `set_guardian(admin)`,
`propose_admin(guardian)`, `set_guardian(pending admin)` and an `accept_admin` by a key that is the guardian
(a doctored Launchpad, since the program never stores it) are refused with `GuardianIsAdmin`; no guardian and
another key are accepted and the hand-over completes; the checklist reports a guardian that is the admin or
the vault. Unit test `guardian_separate_from_admin`. Against the previous build every refusal fails (each
call executed) and the checklist reported nothing.

### 71. The deploy checklist checks a proposed guardian or payout key before the proposal is signed (8.4, Appendix C OPS-1; reviews R5-DIFF-2, R5-CONS-2)

**Spec.** 8.4's operating rule (since SPEC-1, round 2): "`set_guardian` and `set_payout_config` never name
a key that already holds a coin's founder seat ... the deploy checklist compares the new key with every
`Coin.founder` before the proposal is signed"; Appendix C OPS-1: "the deploy checklist reads every 8.4
precondition".

**Issue.** Round 4's `preflight.mjs` compared founders only with the guardian and payout key already
stored, and had no input for a proposed key: `checkDeployPreconditions` silently ignored any extra option
(`proposedGuardian` included) and the CLI parsed only five flags. The program accepts `set_guardian(K)` for
a coin's founder K (it cannot list the coins), and `FOUNDER_HOLDS_ROLE` appeared only on the next run, after
K, now the guardian, could claim the founder share (reproduced: 10,000,000 lamports). SPEC-1's leftover risk
was accepted on the strength of this check. Low / info.

**Choice.**
* `checkProposedRoleKey({ role, key, lp, curveAccounts, vault })`, exported: for `guardian`,
  `payoutAuthority` or `payoutDestination`, a problem when the key is a Coin's or a pending Approval's
  founder (`PROPOSED_KEY_IS_FOUNDER`; a warning for the payout wallet, which the program does not keep from a
  seat), `FEE_RECIPIENT`, the admin, the vault or the proposed admin, or another key the program keeps the
  role apart from (the payout keys for the guardian, the guardian and the other payout setting for the payout
  keys), each with its own code; removing the guardian is a warning (O9). `foundersOf` lists the founders.
* `checkDeployPreconditions` takes `proposed = { guardian, payoutAuthority, payoutDestination }`, checks each
  against the Launchpad with the proposal's other keys applied, and refuses unknown options (`TypeError`), so
  a misspelt check is never skipped silently.
* The CLI takes `--proposed-guardian`, `--proposed-payout-authority` (alias `--proposed-payout-key`) and
  `--proposed-payout-destination`, refuses unknown options and malformed keys with exit status 2
  (`parseArgs`, exported).
* 8.4 names this mode for the operating rule; the OPS-1 row's "reads every 8.4 precondition" now says
  "every 8.4 precondition it can read from the chain", with the proposed-key mode of round 5. The config #0
  sub-point (a config #0 with other valid shares passed) was not confirmed as an inconsistency (8.4 asks
  only that it is added); a `CONFIG0_NOT_DEFAULT` warning now names the fields that differ from 5.9's
  config #0.

Tests. `28-governance` R5-DIFF-2, R5-CONS-2: with a coin's founder and a pending approval's founder, each
proposed as guardian or payout key is a problem naming its coin or approval, as payout wallet a warning;
`FEE_RECIPIENT`, the admin, the payout key as guardian, the guardian as payout key, the admin as payout key and
the payout wallet as payout key are each reported, the two payout keys swapped in one proposal are not; a fresh
key passes; `proposedGuardian` and an unknown proposed key throw; the program still simulates
`set_guardian(founder)` successfully; the CLI parses the three options and refuses an unknown one, a bad key and
a missing `--rpc`. Against the previous checklist the test fails at its first assertion (the option was
ignored).

### 72. An immutable old program meets the checklist (8.4, 8.5, O19; reviews R5-DIFF-3, R5-CONS-3)

**Spec.** 8.5, O19 and OPS-4: "making the old program immutable instead of closing it keeps its instructions
callable and avoids the trap"; 8.4's precondition and the checklist: the old program's upgrade authority is
the vault (a closed program exempt).

**Issue.** An immutable ProgramData (still there, option byte 0) made `upgradeAuthorityOf` return null, so
the checklist reported `LEGACY_UPGRADE_AUTHORITY` for ever (reproduced with a real loader `SetAuthority`
with no new authority), while launches here kept working: the recommended configuration read as not ready,
teaching operators to ignore the exit status. Info.

**Choice.** `programDataState(programData)` (exported) tells closed, immutable, upgradeable (with its
authority) and invalid apart. For the old program only, immutable passes with a `LEGACY_IMMUTABLE` warning
(its code can never change; its admin seat still moves only by its own two steps); an upgradeable one must
be the vault's; an account that is not a ProgramData is a problem. Its approvals stay warnings (the
immutable program can still revoke them). vicinity_curve and vicinity_rewards must stay upgradeable by the
vault (8.4). 8.4 says "the Squads vault, or none (immutable)".

Tests. `28-governance` R5-DIFF-3, R5-CONS-3: after the vault's real `SetAuthority` to none, the checklist is
ready with `LEGACY_IMMUTABLE` in both modes; an old approval made and revoked meanwhile is a warning; a launch
here works; an immutable vicinity_rewards is still `REWARDS_UPGRADE_AUTHORITY`. Against the previous checklist
it fails (`LEGACY_UPGRADE_AUTHORITY`).

### 73. The checker reads the seats of each approval and launch as they stood at that call (I19, 8.2, 12; review R5-REG-1)

**Spec.** I19 and SM-2 (entry 66): every approval and launch ran while the old program's admin and the
registry's admin were this program's admin with nothing pending, and an approval's rent payer is the admin;
the program reads each seat at the instruction. 8.2: the seats follow every admin hand-over.

**Issue.** The per-transaction checker read those seats from the accounts before the transaction. Wrong both
ways (the verifier; the outage itself was rejected as recorded): the program accepts
`[accept_admin, old accept_admin, registry accept_admin, approve_launch]` by the new admin in one transaction
and the checker refused it (I19, then SM-2's rent payer); a mutant build without the old-admin check approved
inside `[old propose_admin(stranger), approve_launch]` and the checker accepted it. Info.

**Choice.** The verifier's scoped fix: `seatWalk` (invariants.mjs) starts from the accounts before the
transaction and walks the calls in execution order (top-level instructions, and inside each its inner
instructions and CPIs into this program, which now carry their position), applying this program's
`propose_admin`, `accept_admin`, `set_guardian` and `set_payout_config`, the old program's and the registry's
`propose_admin` and `accept_admin`, and the old program's `set_pause`, as SM-2 applies `set_pause`. I19 and
OPS-1 use the seats of each approve_launch's and launch's moment; SM-2 checks a new approval's founder and rent
payer against the guardian, payout key and admin of its approve_launch; and the walk must end where the
accounts are after the transaction (a seat step it could not see fails loudly). 8.2 gains the no-gap
recipe the verifier described (the new admin's accept proposal approved before the old admin's proposal
executes, since the time lock counts from approval). Not built: an SDK helper for both halves (optional).

Tests. `27-checker-gaps` R5-REG-1: V1 proposes V2 for the three seats; V2's one transaction of the three
accepts and an approval is accepted by the program and by the checker (the approval's rent payer is V2), and
the city launches; a real approval replayed with an old `propose_admin`, a registry `propose_admin` or an old
`set_pause(launches = false)` placed ahead of it (and the accounts after it moved accordingly) is refused with
I19 or OPS-1; the same old `propose_admin` after the approval is accepted, and without its account change it
is refused by the walk's end check. Against the previous checker the bundled transaction is refused and the
three doctored contexts are accepted.

### 74. The text brought up to date with rounds 4 and 5 (status, 1.1, 3.2, 4.2, 6.4, 7.1, 9, I18, 11.1, 11.3, 11.4; reviews R5-CONS-4, R5-CONS-5)

**Issue.** Documentation only, each statement checked by the verifier: 7.1 listed three cases in which a
buyback run is a no-op and left out the pool's dust case that I22, entry 41 and the 27-checker-gaps test
document (R5-CONS-4: a 6-lamport bucket in an expensive pool, the run a no-op); the status block named
entries 1 to 56 and review rounds 1 to 3; 1.1's integration contract did not mention the registry read
of review OPS-1; 3.2 said "the three ids" for the four the devnet feature switches; 4.2 named only the
old program's admin among the seats that follow a hand-over; 6.4's launch-fee row omitted five
refusals; section 9's title promised per-transaction checks that I18 does not get (it is property-tested,
as its own text says); 11.1, 11.3 and 11.4 gave figures from before the registry account (R5-CONS-5).

**Choice.** Each text corrected: 7.1 states the fourth case as I22 does and that the curve cannot reach it
(Lemma C3: one lamport buys at least 2,434 raw units); the status block names entries 1 to 74 and rounds
1 to 5; 1.1 names the registry and the old program's accounts read at every approval and launch; 3.2 names
the four ids; 4.2 names the registry admin (`RewardsRegistryAdminMismatch`); 6.4's launch fee lists every
refusal of `launch`; section 9's title and I18, and the `tests-curve` README, say that I18 is
property-tested only; 11.1, 11.3 and 11.4 are re-measured on this build (after round 5's program change):
`launch` with the token account and the first buy about 165,000 to 171,000 CU (169,519 in the last run;
the founder's token-account bump varies with its random key, which is why the verifier measured 166,519),
settings instructions 3,900 to 23,200, `launch` 953 bytes, with the first buy 1,064 without and 788 with
the lookup table, the production binary 605,664 bytes. Every figure stays inside its budget.

Tests. None needed beyond the suites' own measurements (`04-launch` C01/C02, `12-compute`), which print
these figures; `prechecks.test.mjs` and `12-compute` still read the spec sections they check.

### 75. The batch launch approval, specified before it is built (1.4, 3.2, 3.3, 3.4, 3.11, 3.12, 4.2, 4.4, 4.5, 4.8, 4.10, 4.17, 4.21 to 4.27, 6.4, 8.1, 8.3, 8.4, 8.6, I19 to I25, T29, T42, T45, T77, T81 to T91, 11, 12, O30 to O33, 14.1, Appendix C; owner decision of 17 October 2026)

**Owner decision (verbatim).** "In the new custom program, I sign one batch approval (say daily) covering
every eligible founder, and their launches then go through with no per-launch step. No key ever sits on the
website. It's covered by the same outside audit."

**Issue.** Today every launch needs an admin-signed `approve_launch` per city, and the admin is the Squads
vault behind the 48-hour time lock once coins are live (O11): a daily approval signed by the vault would be two
days old when it took force. Nothing in the program let one signature approve many founders, and the website
must still hold no approving key (R10).

**Choice.** Specification only in this entry; the program, SDK, verifier, monitor and tests follow.
* **A separate launch approver**, `Launchpad.launch_approver` (offset 175, from the reserved bytes; size 238
  unchanged), set, rotated and removed only by the admin (`set_launch_approver`). It is kept apart from
  `FEE_RECIPIENT`, the admin, the pending admin, the guardian, the payout key and the payout wallet in both
  directions (`ApproverHoldsRole` at `set_launch_approver`, `propose_admin`, `accept_admin`, `set_guardian`,
  `set_payout_config`; `FeeRecipientRole`), and `check_founder_key` refuses it as a founder everywhere, so it
  never receives money. Putting the key in `Launchpad` means none of those instructions gains an account.
* **A separate account for the batches**, `LaunchBatch` (`["launch_batch"]`, 260 bytes), so the approver never
  writes `Launchpad`. It is created by a one-time admin instruction (`init_launch_batch`) instead of a change to
  `init_launchpad`, which stays as reviewed, works for a deployment already initialised and keeps plain `init`
  everywhere (T29).
* **Two batch records and supersession at the newer batch's `valid_from`**, not at its publication: with daily
  publications and a 12-hour review window, superseding at publication would close launches for 12 hours a day.
  A publication replaces a `latest` that has not begun (so a corrected batch never interrupts the one in force,
  and a thief's publication storm cannot push a good batch out before his own batch could take force) and
  otherwise moves `latest` to `previous`.
* **A gap-free `seq`** (`latest.seq + 1`): a compare-and-swap for the owner's signed transaction, no replay, and
  no exhaustion by jumping to `u64::MAX`, which a merely increasing number would allow a stolen key to do.
* **The leaf** reuses `vicinity_rewards`' prefixes and sorted-pair tree (`merkle.rs`, `sdk/merkle.mjs`), adds a
  26-byte domain tag and a version byte, binds the program id and the batch number, and carries the six launch
  fields of an `Approval` (the URI follows from the city id, `meta_hash` pins its content, `config_id` pins the
  terms because a config is immutable except `enabled`). Strings come last with one-byte lengths, so the
  encoding is injective. The worked example of 3.12 was computed with Node and Python, which agree, and its root
  with the rewards SDK's `hashNode`.
* **`launch_from_batch` runs every rule of `approve_launch` and `launch`** at the launch, rebuilds the leaf from
  its own arguments and signer, refuses a proof longer than `min(9, depth)` before hashing, refuses a city with a
  pending per-city `Approval` (the admin's choice wins), writes nothing in `LaunchBatch` and shares effects 1 to
  7 with `launch`. One use per leaf is the permanent `Coin`; the re-approval path is a later batch.
* **Values**: review window 12 hours (O30: a night plus time to act, and a working-day check by a second person;
  1 to 2 hours would need a clear-only key on a server, which the owner ruled out); validity at most 48 hours,
  SDK default 36 (O31); lead at most 48 hours; at most 512 leaves, so the batch launch with the founder's first
  buy fits one transaction (about 1,170 bytes in the worst case against 1,232; about 1,200 at 1,024 leaves) and
  one batch bounds what one stolen key can approve.
* **The per-city path is unchanged** in accounts, arguments, effects and events; its one change is the
  approver in `check_founder_key`. The alternative, leaving `check_founder_key` alone and keeping the approver
  out of founder seats only by an operating rule, was not taken: "the approver can never move money" would then
  hold only by process, which SPEC-1 rejected for the guardian.
* **Not specified as built**: an automatic sentinel, an on-chain eligibility list, a per-entry revocation (O33's
  alternative).

**Open owner decisions.** O30 (the review window), O31 (the validity), O32 (who holds the approver key: default a
dedicated hardware-wallet key of the owner, alternative a separate multisig without a time lock), O33 (stale
entries, accepted and disclosed by default).

**Tests to come** (12): U13 (leaf vectors and the shared fixture), P12, L14, X66 to X76, F01 and F02 extended,
CK1 (the checker's I23 to I25 with the batch state of each call's moment), C01 and C02 (the worst-case
transaction), H02, D01. Nothing in this entry changes a fee value or a fee-share rule, and no existing test
changes until the program does.

### 76. The batch launch approval built (1.1, 3.11, 3.12, 4.23 to 4.27, 8.4, 8.6, 9, 11.1, 11.3, 11.4, 12, 14.1; NOTES 75)

**Spec.** Entry 75 and the sections it lists: the program's five instructions, `LaunchBatch`, the leaf of 3.12,
8.6's in-force rule, I23 to I25, the SDK's batch module, and the tests U13, P12, L14, X66 to X76, F01, F02, CK1,
C01, C02 and H02.

**Choice.** Built as specified; the places where the build had to choose:
* **Program.** `batch.rs` holds the pure functions (`launch_leaf`, `node_hash`, `verify_proof`, `tree_depth`,
  `max_proof_len`, `batch_window_ok`, `batch_in_force`, `apply_publication`) so that U13 and P12 test them without a
  runtime; the five handlers call them. `launch_from_batch` and `launch` share one function for effects 1 to 7
  (`launch::launch_coin`), so a batch launch creates exactly what a per-city launch creates; its bumps struct is
  `CreatedBumps` because Anchor already generates `LaunchBumps` for the `Launch` accounts. Errors 6058 to 6071 are
  appended after 6057 (`LaunchApproverNotSet`, `ApproverHoldsRole`, `BatchSeqMismatch`, `BadBatchRoot`,
  `BadLeafCount`, `BadBatchWindow`, `BatchesHalted`, `BatchSuperseded`, `BatchCleared`, `BatchNotYetValid`,
  `BatchExpired`, `ProofTooLong`, `InvalidProof`, `ApprovalPending`); `LaunchedFromBatch` is an event CPI like the
  other money events, the four settings events are `emit!` like the other settings events. `accept_admin` checks
  `ApproverHoldsRole` again although no instruction sequence can reach it (`propose_admin` refuses the approver and
  `set_launch_approver` refuses the pending admin): kept as defence in depth, as the guardian check there is. The
  halt-all build refuses `launch_from_batch` (nine handlers now).
* **The 13-level proof.** The task asked for the compute of a 13-level proof within budget; the specification caps
  every proof at `MAX_BATCH_PROOF_LEN` = 9 (512 leaves, so the batch launch with the first buy fits one
  transaction), and the program refuses 13 hashes with `ProofTooLong` before any hashing. `30-batch` C01 therefore
  measures the proof's cost by length on one city, founder and name (154,188 CU with no hash to 156,370 with 9:
  about 242 CU per hash), extrapolates 13 levels to about 157,340 CU (inside the 250,000 budget, so the cap is about
  transaction size, not compute) and shows the 13-hash proof refused.
* **Measurements** (11.1, 11.3, 11.4): `init_launch_batch` 10,396 CU, `set_launch_approver` 7,479,
  `publish_launch_batch` 7,174, `clear_launch_batch` 6,761, `launch_from_batch` with a 9-hash proof about 127,740 (city
  801 of `12-compute`; `launch` 118,646 for city 800 in the same run); the worst batch launch with the token account
  and first buy about 178,000 to 179,300 CU (the founder's token-account bump varies) and 1,142 bytes with the lookup table (1,449 without); `publish_launch_batch` 346 bytes.
  One finding for the website: without the lookup table `launch_from_batch` alone with 9 hashes is 1,312 bytes, over
  the 1,232-byte limit (litesvm does not enforce it); without the table only about 5 hashes fit, so the website
  builds every batch launch with the table (11.3 says so). The production binary grew from 605,664 to 728,256
  bytes (devnet 728,256, halt-all 727,032; no stack warning), about 0.62 SOL more rent for the program data and
  for each buffer.
* **The shared fixture** (U13): `sdk/fixtures/launch-batch.json` holds the worked example of 3.12 in full and, for
  trees of 1 to 70 and 512 leaves, the root, the depth, a SHA-256 over every leaf and one over every proof, and the
  first, middle and last proofs in full. Both sides regenerate every leaf and proof and compare the digests: every
  proof is checked, and the file stays at 124 KB instead of several megabytes.
* **SDK.** `sdk/curve/batch.mjs` mirrors `batch.rs`; `batchRefusal` returns the program's errors in its order,
  which the checker and the fuzz model use as their reference for 8.6. `preparePublishLaunchBatch` refuses what the
  program would refuse (no approver, another signer, halted, a wrong number, another program's list, a bad window).
* **Checker** (CK1, I23 to I25): `batchWalk` walks `LaunchBatch` through the calls of each transaction in execution
  order with the seats of each call's moment (the seat walk of entry 73, which now also follows
  `set_launch_approver`), recomputes each publication's record and each batch launch's leaf with the SDK, folds the
  proof, and requires the walk to end at the account after the transaction. `31-batch-checker` doctors real
  contexts (a clear, a supersession, the window, the root, the halt, the approver, a pending approval, a founder
  holding a role, a publication by a stranger or while halted or recorded differently, a skipped number, a clear by
  a key that may not clear, a write by a buy, an approver holding a seat) and each is refused.
* **Fuzz** (F01, F02): `fuzz.mjs` adds approver rotations (including role keys and a stranger signing), publications
  valid and invalid (a stranger, a skipped or repeated number, a zero root, a leaf count out of range or not the
  list's, each bad window), clears by every key with and without halt, clock moves to the window's edges, and batch
  launches (the founder's own, another signer, a changed name, ticker, config or metadata hash, a cut or padded
  proof, another batch's number, a city with its coin or a pending approval, a locked ticker, a founder holding a
  role); role keys offered to the approver's seat and back. The model predicts each outcome and error in the
  program's order (two simultaneous account-level failures predict some failure, since Anchor's order among account
  constraints is not modelled) and `LaunchBatch`'s 260 bytes must equal its own after every transaction. Eight seeds
  of 2,500 steps agreed throughout (the last four: 247 publications, 181 accepted; 235 batch launches, 29 of
  them launched and the rest refused with the predicted error; 37 clears; 32 rotations). A longer run:
  `VCURVE_FUZZ_STEPS=100000 node --test tests-curve/23-fuzz.test.mjs`.
* **Tools.** The owner's verifier `scripts/vcurve/batch.mjs verify` (8.4 step 2: re-reads the chain, rebuilds the
  tree from the file and refuses a file whose root is not its entries', re-checks every entry, prints the day's
  changes and the unsigned `publish_launch_batch`) and `check` (the monitor's comparison of the stored record with
  the list) are built, and the deploy checklist takes `--proposed-launch-approver` (the key against every founder,
  which the program cannot see when the key is set, and every seat; a proposed guardian or payout key that is the
  approver; an approver holding a founder seat). Not built: the monitor process (paging, the site's database), the
  website's batch page and D01's batch rehearsal on devnet.

Tests. Program: U13 (the worked example, the fixture, every field changed, leaf and node preimages, proofs cut,
padded, of a neighbour), P12 (random batches, the in-force rule against a direct model), the offsets of
`LaunchBatch` and `Launchpad`, the error table, the review checklist (26 instructions, the new writers). litesvm:
`30-batch` (L14, X66 to X76, C01, C02, every rule of `approve_launch` and `launch` at a batch launch, X67 and
X69), `31-batch-checker` (CK1), `32-batch-checklist`, `33-batch-verifier`, `11-halts` H02 and H03 with
`launch_from_batch`, `12-compute` with the five instructions, `23-fuzz`. SDK: `batch.test.mjs`. Nothing here changes
a fee value or a fee-share rule.

### 77. Each batch rule shown necessary by a mutant build that a test refuses (4.23 to 4.27, 8.3, 8.6, 12; NOTES 76)

**Spec.** Every rule of the batch launch approval has a test that fails without it (the task's acceptance rule,
in the manner of the mutants of entries 34 and 73).

**Choice.** `scripts/vcurve/batch-mutants.py` builds 43 mutant programs, each with one rule removed or weakened,
and runs `30-batch` (H02 of `11-halts` for the halt-all mutant) against each, twice: with the per-transaction
checker, and with it off (`MUTANT_CHECKS_OFF=1`), so that an explicit assertion, not only the checker, refuses
each mutant. The mutants: publication by any signer, while halted, with a merely increasing number, with a zero
root, with any leaf count, without the 12-hour review, without the 48-hour lead or validity cap, always moving
`latest` to `previous`; a clear by anyone; `set_launch_approver` without the separation check, without clearing
the records, without lifting the halt; a guardian, payout key, payout wallet or proposed admin that may be the
approver, and `approve_launch` and `transfer_founder` without the approver in `check_founder_key`; a batch
launch while launches are paused, while buys are halted, without the approver check, while the path is halted;
`batch_in_force` taking `previous` after the newer batch began, ignoring the publisher, ignoring the clear,
before `valid_from`, after `valid_until`; city 0; a founder holding a role; a zero metadata hash; an invalid
name; the proof's length unbounded; the proof not verified; a pending approval ignored; a disabled config; the
old program's launches open, its admin, the registry's admin, the old `Coin`, the old `Approval`; another
metadata account; the halt-all build without `require_not_halted` in `launch_from_batch`.

The first run found two rules no explicit assertion pinned, and the tests were tightened: (1) `batch_in_force`'s
publisher check: every approver change also clears both records, so a former approver's batch was refused
anyway, with `BatchCleared` instead of the specified `BatchSuperseded` (the publisher is checked before the
clear, 4.22, 4.27), and the test accepted either; it now requires `BatchSuperseded`. (2) The records cleared by
`set_launch_approver`: with the checker on, every test refused that mutant (I24 replays the clear), but without
it no assertion did, because every rotation tested came after a clear or named another key; a new test re-sets
the same key while one batch is in force and the next is pending, and both must stop with `BatchCleared`. Before
this entry's work the rules of `approve_launch` and `launch` at a batch launch (the old program's accounts, the
registry, a disabled config, city 0) had no batch-path test either; entry 76's `30-batch` test of them was
written for these mutants. Result: all 43 mutants killed in both modes. The rules the mutants do not cover are
those of the leaf and proof functions themselves (each leaf field, the domain tag, the node prefix, the odd-node
promotion), which U13 pins byte for byte against the SDK and the shared fixture, and the layout and account
constraints Anchor generates (seeds, `init`, owners), which X66 and F02 substitute.

Tests. `scripts/vcurve/batch-mutants.py` (about 1.5 minutes per mutant); the two tightened assertions are in
`30-batch` (rotation and clears; the same-key re-set).

### 78. Every leaf field is taken exactly or refused; the list file's schema (3.12, 14.1; review MK-1)

**Spec.** 14.1: `buildLaunchBatch` "checks each entry as the program will (`check_name`, `check_symbol`, a nonzero
metadata hash, a config id, ...)"; 3.12: the list file holds "every leaf field"; 8.4 step 2: the owner's verifier
re-checks every entry and recomputes the root.

**Issue.** `normalizeEntry` filled fields in: `String(e.name)` made a missing or null name the text "undefined" or
"null", which `check_name` accepts, and `Number(e.configId ?? 0)` made a missing config id (for example a site
query that spells it `config_id`) config #0. Such an entry built a valid leaf, and the owner's verifier runs the same
normaliser, so it reported nothing and prepared the publication. Reproduced end to end: a coin launched through the
batch with the permanent name "null" on config #0 instead of the admin-approved config #1, paying config #0's
launch fee. A list file with the two fields removed also parsed to the same root. Low: it needs a bug in the site's
list query (not built yet), and the day's changes did show `"null" ... config 0`.

**Choice.** No field is ever defaulted or coerced:
* `normalizeEntry` requires every field. The name and ticker must be strings; the city id a bigint, a safe integer
  or decimal text (no boolean, no blank or spaced text, no hex, no fraction, nothing beyond u64); the config id the
  same within u16; the founder base58 text, a PublicKey (anything with `toBase58`) or exactly 32 bytes; the metadata
  hash 64 hex digits, a Uint8Array of 32 or an array of 32 integers from 0 to 255. The batch number of
  `buildLaunchBatch` and `launchLeaf` likewise. A BatchError names the field. `entryProblems` reports the same
  reason. A safe integer is accepted for the ids because it is exact; a larger number is refused, since it may
  already have lost digits.
* `checkLaunchBatchFileSchema` (exported; `parseLaunchBatchFile` runs it first): the file has exactly the fields
  `launchBatchFile` writes (`version` 1, `programId` text, `seq` decimal text, `leafCount` an integer, `root` 64
  lower-case hex digits, `entries` an array), each entry exactly `cityId` (decimal text), `founder` (text),
  `configId` (an integer), `metaHash` (64 lower-case hex digits), `name` and `symbol` (text). A missing, null,
  misspelt or extra field is `BadFile`, and so is text that is not JSON. The leaf count is compared exactly.
* The verifier's CLI parses the list file before it reads the chain, so a malformed file is reported as
  `BAD_FILE` (exit status 1) instead of failing while the addresses are derived.

Tests. `batch.test.mjs` MK-1: a name or ticker missing, undefined, null, a number or an array; a config id missing,
spelt `config_id`, null, 1.5, -1, blank, spaced, `1e2`, `01`, true or 70,000; a city id true, blank, spaced, hex,
fractional, negative, 2^53 as a number or 2^64; a founder missing, a number, 31 bytes or non-bytes; a metadata hash
missing, short, `0x`-prefixed, out of byte range or a number; a batch number true, blank or fractional: each refused.
The exact forms still give the reference root. The list file: the coerced root with the name and config id removed
(`missing configId, name`), a null name, `config_id` for `configId`, an extra field, each field of the wrong type, a
missing `leafCount`, an extra top-level field, text that is not JSON: each `BadFile`. `33-batch-verifier`: the same
lost-field file through the exported verifier and through the real CLI (`verify` and `check`) gives `BAD_FILE` and
no transaction. Against the previous SDK the SDK test fails at its first refusal and the verifier tests prepared the
publication.

### 79. The day's changes are computed only against lists the chain holds; the owner's archive (8.1, 8.4, T89, 14.1; reviews R6-DIFF-1, R6-RT-1)

**Spec.** 8.4 step 2: the owner's verifier "prints the changes", which the owner reads before he signs; 8.1 "Wrong
list" and T89 name a compromised website and rely on this verifier, the monitor (which rebuilds the list from the
site's database) and a second person (who checks the new entries the monitor sends).

**Issue.** `verifyListFile` diffed today's list against whatever `--previous` file it was given, which
`parseLaunchBatchFile` checked only against its own root. It had the decoded `LaunchBatch` at hand and used it only
for the number. A compromised website could hand the owner a self-consistent "previous" list that already held its
own city, or a founder swapped on a carried-over city, even under a number that never existed: the attacker's
entries then never appeared among the day's changes, the monitor and the second person (fed by the same site data)
agreed, and the attacker launched (reproduced against the real program, through the function and the real CLI).
Without `--previous` every entry showed as added. And after a publication nobody prepared had begun, the next verify
prepared `latest + 1` without a word. Medium.

**Choice.** The safer fix the reviewers proposed, with the archive the second one suggested:
* A stored record is *live* when it can still let a founder launch: `seq > 0`, not cleared, published by the current
  approver (a rotation clears both records anyway) and not past its `valid_until` (`recordLive`, exported).
* While `latest` is live, the changes are computed against its list, and that list must be anchored: from the
  archive, or from `--previous` with `latest`'s number, root and leaf count. A `--previous` that does not match is
  `PREVIOUS_NOT_ON_CHAIN` (also when nothing was ever published); no list at all is `NO_PREVIOUS`.
* While `latest` is pending and `previous` is in force (the case of a correction published within the review
  window, 8.6), the changes against the batch in force are shown as well (`changesInForce`): from the archive or
  `--in-force`, matched with `previous` (`IN_FORCE_NOT_ON_CHAIN`, `NO_IN_FORCE`). An `--in-force` when no other
  batch is in force is refused too, so nothing the owner passes is ever used unless the chain holds it.
* When `latest` has ended (cleared, expired, a former approver's), no stored entry can launch, so every entry of the
  new list is a new approval and is listed as added (warning `LATEST_ENDED`); a matching `--previous` adds the
  changes against the ended list for reference (`ended`).
* The archive: the CLI keeps every list it verified (when it prints a transaction) as
  `<archive>/<program id>/<seq>-<root>.json` (`--archive <dir>`, default `$VICINITY_BATCH_ARCHIVE` or
  `~/.vicinity-curve/launch-batches`; `--no-archive`). It is the owner's own copy, independent of the website, so in
  routine use no file from the website is needed for the baseline. Once the archive holds any list, a live stored
  batch it does not hold is `LATEST_NOT_ARCHIVED` (a problem: a publication nobody prepared on this computer; clear
  it, or put its list in the archive if it was prepared elsewhere); an ended one is only a warning. An empty archive
  (the first use) checks nothing.
* Any problem means no transaction, as before. The printout names the baseline of each set of changes and where its
  list came from (`changeLines`, exported; entry 80 for the entries themselves).
* `check` takes none of `verify`'s options (an error now, so a baseline option is never silently ignored).
The `--first-batch` flag the review suggested is not needed: the chain says whether anything was published, and a
`--previous` then is refused. What stays: a compromised website can still add believable new entries; the owner and
the second person read those (8.1).

Tests. `33-batch-verifier` R6-DIFF-1, R6-RT-1: before any publication a `--previous` is refused; after batch 1
takes force, the review's forged previous (the attacker's city already in it), a founder swap under number 41, and
no previous at all are each refused with no transaction; the real list of batch 1, from `--previous` or from the
archive, shows the attacker's city as added; an archive without the live batch is refused even with a matching
`--previous`; with batch 2 pending, a correction needs the list of batch 1 in force and shows both sets of changes,
and a forged or wrong `--in-force` is refused; a publication nobody prepared is refused at the next verify (with
the owner's own last list, or from the archive); after the guardian clears it, every entry is new and the cleared
list gives the reference changes. The real CLI against a JSON-RPC stub serving the World: a forged `--previous`
gives `PREVIOUS_NOT_ON_CHAIN`, exit 1 and no transaction; without a baseline `NO_PREVIOUS`; the archive keeps the
verified list and is the next day's baseline. Against the previous verifier (run on the build before review round 6)
the first test fails at the forged previous (no problem, a transaction prepared) and the CLI test at its first run
(the old CLI has no archive and prints the day's changes without a baseline).

### 80. The day's changes show every entry's metadata hash and name the fields that changed (8.4, 14.1; review R6-DIFF-2)

**Spec.** 8.4 step 2: the owner reads the day's changes before he signs; 3.12: the leaf commits to the metadata
hash, which `launch_from_batch` stores in `Coin.meta_hash` for good; T89 names "another name, ticker or metadata"
among the website's possible changes.

**Issue.** The verifier printed each entry as its city, ticker, name, founder and config, without the metadata hash.
`diffLaunchBatches` counted a change of the hash alone as a changed entry, but the owner then read a `~` line and a
`->` line with the same text and could not see what had changed; the coin launched with a hash he never saw.
Info: he could see that the city changed, not how, and only the second person's metadata check remained.

**Choice.**
* `diffLaunchBatches` returns, with each changed row, the leaf fields that differ (`fields`, in the order of
  `LEAF_FIELDS`: `founder`, `configId`, `name`, `symbol`, `metaHash`).
* The printout (`formatEntry`, `formatChanges`, exported from `scripts/vcurve/batch.mjs`) shows every entry, added,
  removed or changed, with its full metadata hash in hex, and follows each changed entry with
  `changed: <fields>`.

Tests. `batch.test.mjs` R6-DIFF-2: a change of the hash alone names `metaHash`, a change of founder and name names
both. `33-batch-verifier` (the real CLI): city 8102's metadata hash alone changes; the `~` and `->` lines differ,
end with the old and the new hash, and are followed by `changed: metaHash`. Against the previous SDK the SDK test
fails (no `fields`); the old CLI printed two identical lines.

### 81. The deploy checklist reads the guardian's Squads multisig; the approver is no member key (8.1, 8.4, 8.6, O30, O32, O34, O35, T85; review R6-RT-2)

**Spec.** 8.1: the guardian is "a separate Squads multisig without a time lock, suggested 1 of 3 of the same
members", one of the stops of the 12-hour window ("the owner, the guardian or the admin" clears); O32's default
puts the approver key in the owner's own wallet, "preferably a hardware wallet", while (b) notes the owner keeps
the admin and guardian seats; the checklist said the guardian multisig's settings were "not checkable here".

**Issue.** Nothing kept the approver key and the owner's guardian member key off the same device or seed, and in a
Squads v4 autonomous multisig (no config authority) with threshold 1 one member alone can create, approve and
execute a config transaction removing the other members. With one stolen device the thief publishes a batch for up
to 512 cities and, within minutes, removes the other guardian members: their clears and pauses then fail (Squads
`NotAMember`), the admin's are 48-hour proposals, and only the owner, restoring his approver key from the offline
backup, can still stop the batch. Reproduced against the real Squads v4 program; with a config authority set,
Squads refuses the member's config transaction (`NotSupportedForControlled`). Medium.

**Choice.** The checklist and the operating rules (no program change; the program-level option is recorded as O34):
* `decodeSquadsMultisig` reads a Squads v4 `Multisig` account (owner the Squads program, discriminator
  `sha256("account:Multisig")[..8]`, then `create_key`, `config_authority`, `threshold` u16, `time_lock` u32, the two
  transaction indexes, `rent_collector` as a Borsh option, `bump` and the members with their permission masks);
  `squadsVaultPda` derives `["multisig", multisig, "vault", index]`; `encodeSquadsMultisig` writes the same layout
  for tests. The layout and the vault derivation were checked against the Squads SDK's own decoder and PDA helper,
  and against multisigs created by the real Squads program in litesvm (the mainnet dump the reviewers used, sha256
  `dec8d3e0...`, with `@sqds/multisig` 2.1.4). Three of them are kept in `tests-curve/fixtures/squads-v4-multisigs.json`
  with the values the SDK decodes and its vault PDAs: autonomous 1 of 3; controlled by the vault, 1 of 3; controlled,
  2 of 3 with a time lock, a rent collector and mixed permissions. Squads allocates 33 bytes for `rent_collector`
  whatever its value, so an account without one ends with 32 zero bytes after its members; the decoder ignores them
  and `encodeSquadsMultisig` writes them, so the synthetic accounts of the tests are byte for byte what the program
  creates.
* `checkSquadsRoles`, run by `checkDeployPreconditions` with the proposal's keys applied: once a guardian is set,
  `--guardian-multisig` is required (`GUARDIAN_MULTISIG_UNCHECKED`); the guardian must be one of its vaults
  (`GUARDIAN_NOT_MULTISIG_VAULT`; any index from 0 to 255); it must have no time lock (`GUARDIAN_TIME_LOCK`, until now
  confirmed by hand); its config authority must be the admin vault (`GUARDIAN_MULTISIG_NOT_CONTROLLED`, whose message
  says whether it is autonomous, and that with threshold 1 one stolen member key removes the others); an account
  that is not a Squads multisig is `GUARDIAN_MULTISIG_INVALID`; the launch approver, or a proposed one, must not be a
  member key (`APPROVER_IS_GUARDIAN_MEMBER`); one member only is a warning. The optional `--vault-multisig` checks
  that the vault is one of its vaults (`VAULT_NOT_MULTISIG_VAULT`) and that the approver is no member key
  (`APPROVER_IS_VAULT_MEMBER`), and warns while it has no time lock (`VAULT_TIME_LOCK_UNSET`, O11).
* A controlled multisig whose config authority is the vault was chosen over a 2-of-3 autonomous guardian: the brake
  stays one signature (O9's reason for a guardian), and membership changes wait for the vault's time lock, as
  `set_guardian` does. Recorded as owner decision O35 with this default built into the checklist.
* The rules: the approver key sits on a hardware wallet or a seed that holds no member key of the vault's or the
  guardian's multisig (8.4, O32; the checklist sees only identical keys, not a shared seed). 8.1's worst case, 8.6's
  window and O30's reasoning say why: the team's stop must survive the theft it answers.
* O34 records the program-level alternative (a few clear-only "batch stopper" keys set by the admin), not built.

Tests. `32-batch-checklist` R6-RT-2: with the guardian set to the vault of a synthetic Squads multisig, an unnamed
multisig, an autonomous 1-of-3 and 2-of-3, a config authority other than the vault, a time lock, another multisig,
an account of another program, a missing account and an approver (or a proposed approver) among the members are
each reported; a controlled multisig whose config authority is the vault passes; one member is a warning; a
proposed guardian is checked against the multisig named; the vault's multisig: an approver member key, no time lock
(a warning) and a vault that is not one of its vaults; the CLI options; `fetchChecklistSnapshot` fetches the two
multisigs. The checklist tests that report ready (`28-governance` OPS-4 and R5-DIFF-3) now name a controlled
guardian multisig. A second test reads the three accounts of the real Squads program: each decodes to the SDK's
values, re-encodes byte for byte and has the SDK's vault PDAs, and the checklist refuses the autonomous one and the
time-locked one, accepts the one controlled by the vault, and refuses an approver among its members. Against the
previous checklist the first test fails at its first assertion (nothing was reported).

### 82. The batch settings events are event CPIs; the monitor reads the account (M20, 4.0, 4.21, 4.24 to 4.26, 8.4, 11.1, 11.3, 14.1; review R6-RT-3)

**Spec.** M20 and 4.21: settings events by `emit!`, which "indexers reconcile from state"; 4.21 says the batch
monitor "reads `LaunchBatch` itself, not only the events", but 14.1 specified it as woken "after every
`LaunchBatchPublished`".

**Issue.** A thief of the approver key controls the publication's transaction. Fifty one-byte SPL Memo instructions
ahead of `publish_launch_batch` fill the 10,000-byte log before vicinity_curve runs: neither its invoke line nor the
`Program data:` line of `LaunchBatchPublished` is logged, `decodeTransactionEvents` returns nothing, and
`LaunchBatch.latest` is written as normal. A monitor built as 14.1 described never runs for that publication. The
same hides a clear. Low: the monitor is not built, and one that polls the account is unaffected.

**Choice.** Both parts of the fix:
* `set_launch_approver`, `publish_launch_batch` and `clear_launch_batch` take `#[event_cpi]` (the event authority and
  the program as their last two accounts) and emit `LaunchApproverChanged`, `LaunchBatchPublished` and
  `LaunchBatchCleared` with `emit_cpi!`, which is recorded as an inner instruction and cannot be truncated.
  `init_launch_batch` keeps `emit!` (it runs once, by the admin). `checklist.rs` lists the three in
  `BATCH_CPI_SETTINGS` and its account tables; the IDL, the SDK's `ACCOUNT_TABLES` and builders and `CPI_EVENTS`
  (now 12; such an event is accepted only from an event CPI), the checker's log rule and 4.0, 4.21 and 4.24 to 4.26
  follow. Cost: 5,700 to 6,300 CU more each (`set_launch_approver` 13,368, `publish_launch_batch` 13,420,
  `clear_launch_batch` 12,486; budget 50,000), 34 bytes on the publication (380 bytes with the compute budget),
  and 9,808 bytes of program: production 738,064 bytes (devnet 738,064, halt-all 736,840; no stack warning; 11.4).
  The guardian's clear through a Squads vault transaction emits its event at stack height 3, within the
  runtime's limit (checked with the review's harness of the real Squads v4 program against this build).
* 8.4 step 3 and 14.1: the monitor polls `LaunchBatch` every minute or subscribes to the account and acts on every
  change of `latest`, `previous` or `halted`; it never relies on events alone.
* `batch-mutants.py` gains three mutants that put back `emit!` for each event (46 in all). Each was built and run:
  all three killed, with the checker and without it (`MUTANT_CHECKS_OFF=1`), each by the R6-RT-3 test among others
  (without the checker the SDK refuses a log of a `CPI_EVENTS` event, so the suite's own decoding fails too).

Tests. `30-batch` R6-RT-3: a publication, a clear and a change of approver, each behind 50 memos with the log
truncated before vicinity_curve's invoke line, still give their events (through the checker and
`decodeTransactionEvents`, which `World.send` compares); unpadded, the three emit no log event and carry the two
event accounts. `batch.test.mjs` and `idl.test.mjs` follow the new account lists and `CPI_EVENTS`. Against the
previous binary (built from the commit before review round 6) the test fails at the padded publication: no
`LaunchBatchPublished` is decoded.

### 83. Only lists the owner signed and confirmed are baselines; the archive keeps the window (8.1, 8.4, T89, 14.1; reviews R7-BA-1, R7-3)

**Spec.** 8.4 step 2 (round 6): the day's changes are computed against the stored batch's list "taken from the
owner's own archive of the lists he verified", and "a live stored batch the archive does not hold is reported as a
publication nobody prepared"; NOTES 79.

**Issue.** The CLI wrote a list to the archive as soon as it printed a transaction, before the owner decided, and the
baseline was any archived list with the stored number, root and leaf count. A list the owner verified and refused
(say, one the website padded with the attacker's city E) therefore became a trusted baseline: a chain view that
answered its root and leaf count at the real number (any RPC; 8.4 named none), or the refused list published with a
stolen approver key, silenced `LATEST_NOT_ARCHIVED`, and the next day's changes no longer showed E. The alarm's own
message offered `--no-archive` or copying a list file into the archive as remedies, which accept the website's list
as the baseline too. Reproduced through the exported functions and the real CLI; medium (R7-BA-1), and the same
root cause reported without the window as low (R7-3).

**Choice.** The safer fix, with both reviews' proposals:
* The archive has three folders per program: `pending/` (lists `verify` prepared a transaction for, each with the
  window of that transaction and the approver), `signed/` (lists the owner confirmed on chain) and `refused/`. Only
  `signed/` is ever a baseline, and an entry matches a stored record only with its number, root, leaf count, window
  and publisher (`sameArchived`): a thief re-publishing a refused list cannot reproduce the verifier's window unless
  he publishes within ten minutes of the owner's run and guesses the second, and even then the list is not confirmed.
  (Corrected by review R8-DIFF-2, entry 93: that held only for the verifier's own window. In the `--tx` flow the
  website chose the window, any one the program accepts, so a thief who read or ran the site could republish a refused
  list with exactly the verified window hours later, and the alarm then suggested `confirm`. Since round 8 the page's
  window must be the default one, and `confirm` compares the transaction that wrote the record with the one verified.)
* `confirm <seq> <root>` (`confirmPublication`), run within minutes of each publication the owner signed: the
  stored `latest` must be exactly a pending entry with that number and root (window and publisher included), by
  the current approver, in a window the program accepts, not cleared, the path not halted; only then is the entry
  written to `signed/`. Other pending lists for the same number (one he refused) are a problem
  (`SEVERAL_PENDING`) unless `--discard-others`, which moves them to `refused/`. The owner names the root he signed,
  so a thief's publication of a refused list cannot be confirmed by mistake.
* Every archive entry carries an HMAC-SHA-256 under `archive.key`, 32 random bytes the archive creates on first use
  (mode 0600); `readArchive` ignores, with a warning, any entry without a valid MAC, so a file copied into the archive
  (the website's list, or an entry forged in the archive's format) is never a baseline.
* `LATEST_NOT_ARCHIVED` (and `IN_FORCE_NOT_ARCHIVED` for the batch in force while `latest` is pending, which round 6
  did not check) prints the stored record with its window, publisher and time of publication, says which pending
  entry it matches (a list he verified and did not confirm: run `confirm` if he signed exactly that, else the key is
  stolen; a list he verified with another window or signer: a publication he did not sign), tells him to have a
  guardian member clear it with halt, and offers no way around the alarm.
The website's batch page is no part of this: the archive lives only on the owner's computer.

Tests. `33-batch-verifier` R7-BA-1, R7-3 (the real CLI against JSON-RPC stubs, one of them answering the refused
list's root and leaf count): day 1 verified, signed, confirmed; day 2 the refused list X_bad (with E) and the signed
X_good, whose confirmation is refused while X_bad is pending and then sets it aside; day 3 the honest view shows D
and E as added, the lying view gives `LATEST_NOT_ARCHIVED` and no transaction (and, through the function, with X_bad
still pending and the lie copying its window, the message names the list he never confirmed); X_bad published with
the stolen key is refused at the next verify (pending and in force) and `confirm` of it gives `WINDOW`; a plain list
and a forged entry copied into `signed/` are ignored. Against the previous verifier the file fails at its import
(no pending folder, no `confirm`); the review's reproductions fail at their attack step.

### 84. A file stands in for the archive only with two RPCs, and hides nothing (8.4, 14.1; review R7-4)

**Spec.** 8.4 step 2 named no RPC; `--no-archive` and an empty archive (a first use) let a `--previous` file matching
`LaunchBatch` be the baseline.

**Issue.** That anchor is only as good as the RPC: a stub that rewrote `LaunchBatch.latest`'s root and leaf count to
those of a forged previous holding E made the forged file the baseline, and E was never printed (info).

**Choice.** Every `--rpc` must be a provider the website does not operate or relay (8.4, 14.1, the scripts' README).
`--rpc` may be given twice (two different URLs); the CLI reads `Launchpad` and `LaunchBatch` from both and stops at
`RPC_DISAGREE` when they differ. (Extended by reviews R8-DIFF-1 and R8-DIFF-4, entry 92: every account, the clock and
the pending approvals are compared, `check` reads both RPCs, and the two must be different providers, not two URLs.) With an empty archive (or `--no-archive`) and anything published, the chain view
must be confirmed by two RPCs (`ONE_RPC`, a problem); with an archive, one RPC is a warning. And a file never hides
an entry any more: with no confirmed list, every entry of the new list is listed as added and the file's entries
(the live batch's) are printed in full ("not a list this computer confirmed"); the file serves to show what can
launch now and which tickers it holds (entry 86).

Tests. `33-batch-verifier` R7-4: the review's lying RPC with the forged previous and `--no-archive` gives `ONE_RPC`
and no transaction; the lying and an honest RPC give `RPC_DISAGREE`; two honest RPCs give `PREVIOUS_NOT_ON_CHAIN`.
R6-DIFF-1 (function): a first use with the real list on two RPCs prints batch 1 in full and lists every entry,
E included, as added. Against the previous verifier the review's case printed one added entry and a transaction.

### 85. The website's transaction is checked against the verified one; the owner confirms within minutes (8.4, T89, 14.1; review R7-CONF-1)

**Spec.** 8.4 step 2: "If he signs on the website's batch page instead, he first compares the root, `seq` and window
the page shows with the verifier's." Step 3: the monitor rebuilds the list from the site's database; `check`
"does the same".

**Issue.** Nothing tied the bytes the page hands the wallet to what it displays: a compromised page showed the
verified seq, root and window and had the wallet sign another root (up to 512 entries of the attacker's). Phantom
shows an unknown instruction and a Ledger only a blind-sign message hash, and the verifier printed no hash and could
not read the page's transaction. The monitor, fed by the same database, matched; only a `check` with the owner's own
file caught it, which nothing required. Medium.

**Choice.** (b) and (c) of the review; (a), a hardware-wallet transport inside the verifier, is not built (no Ledger
library in this repository, and it cannot be tested here):
* `verify <list> --tx <base64>` decodes the page's unsigned transaction (legacy or v0, `decodePageTransaction`),
  prepares the publication with the transaction's window, and refuses unless the transaction is exactly it
  (`checkPageTransaction`): one `publish_launch_batch` with the same accounts, roles and data, the approver its fee
  payer and only signer, no lookup table, nothing else but at most one compute-unit limit (at most 1,400,000) and
  one price (at most 1,000,000 micro-lamports). It then prints the message hash, base58 of the SHA-256 of the message
  bytes, which a Ledger shows when it blind-signs; the verifier's own transaction gets its hash printed too. The
  owner signs only when the two hashes are equal; a wallet that shows no hash cannot tell him which root he signs.
* `confirm` (entry 83) is the archive-backed check, a required step within minutes of each publication: a swapped
  root, window or signer fails it and the message says to page the guardian members.
* `check` accepts the owner's exported archive entry as well as a list file and then also compares the window and
  the publisher (`NOT_THE_VERIFIED_WINDOW`, `NOT_THE_VERIFIED_SIGNER`); 8.4 step 3 and 14.1 have the monitor compare
  against that entry, sent through its own channel, not only against the site's database.

Tests. `33-batch-verifier` R7-CONF-1: the page's transaction with root R2 (`TX_NOT_VERIFIED`), another payer
(`TX_SIGNERS`), an extra transfer (`TX_OTHER_INSTRUCTION`), another launchpad account (`TX_ACCOUNTS`), no
publication and bytes that are no transaction are each refused with no pending entry; the right one (v0, with a
compute-unit price) is accepted and the printed hash equals the SHA-256 of its message; when the page has the
wallet sign R2 anyway, `confirm` gives `ROOT` and `check` of the exported entry `ROOT` and `LEAF_COUNT`, while the
site's own list matches. Against the previous verifier `--tx` was an unknown option.

### 86. A ticker another city can still launch with is refused (T87, 8.4, 14.1; reviews R7-BA-2, R7-CONF-4)

**Spec.** T87: "a ticker can be raced only by another approved entry with the same ticker, which the SDK refuses
within a batch and against pending approvals".

**Issue.** The SDK and the verifier checked only the listed city's own `Approval` and an existing `TickerLock`. With
the admin's approval of city 9402 for PARIS pending, a list naming 9401 with PARIS passed, and whoever launched first
took PARIS for good (the `TickerLock` is never closed) while the other launch failed at `init`. Likewise a ticker moved
to another city while the batch in force still names it for the first (SPRING moved from 9901 to 9902 while batch 1
is in force: 9901 launches with SPRING during the review window and 9902's entry can never launch). Low; R7-CONF-4 is
the same root cause.

**Choice.** Implemented, as the review proposed for this program:
* `tickerHolders({ approvals, batches, coins, now })` maps each ticker to the other cities that can still launch with
  it: every pending per-city `Approval` not expired at `now` (`launch` refuses an expired one), and every entry of the
  stored batches that can let founders launch before the new list takes force, unless its city has a coin.
  `tickerConflicts(cityId, symbol, holders)` gives the reasons for one city and ticker; `entryProblems` (and so
  `buildLaunchBatch`) refuses with `chain.heldTickers`; 14.1 has the admin page run the same check before an
  `approve_launch` proposal, there over every stored batch that can still let founders launch, the pending one
  included (a per-city approval lives up to 30 days, so it would race the pending batch once that takes force).
* Which batches hold tickers: while `latest` is in force, its list (it stays in force until the new list's
  `valid_from`); while `latest` is pending, the batch in force (`previous`), since the new list replaces `latest`,
  which never takes force. The lists come from the archive (or, on a first use, the files of entry 84).
* The verifier reads every pending `Approval` with `getProgramAccounts` (memcmp on the account discriminator, owner
  checked by `decodeApproval`) and the `Coin` accounts of the holder cities; a run without the approvals is
  `APPROVALS_UNREAD`. The old program's approvals are not read: a launch here requires the old program's launches to
  be paused (8.5), so an old approval cannot race a ticker here.
What remains is a ticker taken after the list was verified (an approval proposed later): on chain the first launch
wins and the other fails with nothing lost; T87 now says so.

Tests. `33-batch-verifier` R7-BA-2: A6 (9402 PARIS pending, 9401 PARIS listed: `BAD_ENTRY`, and `buildLaunchBatch`
throws; after 9402 launches, "the ticker is locked"); an expired approval holds nothing; A11 (SPRING moved while
batch 1 is in force: refused); a correction of a pending batch is checked against the batch in force; a city that
launched holds nothing but its locked ticker; `tickerConflicts` for the admin's approval. `batch.test.mjs` R7-BA-2:
the holders' rules. Against the previous SDK `tickerHolders` does not exist and A6 prepared a publication.

### 87. A guardian member's stop is one transaction (8.1, 8.4 step 5, O34, O35, T85; review R7-1)

**Spec.** 8.1 (round 6): with a controlled guardian multisig "even a guardian member key stolen with it cannot remove
the other members, who can still clear and pause"; O35.

**Issue.** With a threshold of 1 any member can cancel an approved proposal (Squads `proposal_cancel_v2`). The
members' stops were vault transactions created, proposed and approved in one transaction and executed in another
(as the Squads app and the review harness do); between the two, the thief holding the approver key and the owner's
member key cancelled each one, the executes failed (`InvalidProposalStatus`) and his batch took force. Reproduced
against the real Squads v4 program; medium.

**Choice.** The tool the review proposed, `scripts/vcurve/guardian-stop.mjs`: `guardianStopInstructions` puts
`vault_transaction_create`, `proposal_create`, `proposal_approve` and `vault_transaction_execute` in one transaction
signed by one member, so no approved proposal ever waits to be executed. The inner message is
`set_pause(launches and/or buys = true)` then `clear_launch_batch(halt = true)`, as 8.4 step 5 orders them. The Squads
instructions and the vault message are encoded here (no Squads SDK dependency) and were checked byte for byte
against `@sqds/multisig` 2.1.4's builders, the message compiler and `accountsForTransactionExecute`, and the
discriminators against `sha256("global:<name>")`. One stop costs about 90,000 compute units (create 27,468, propose
12,421, approve 8,142, execute 42,284 with the pause and the clear), within one transaction's limit.
What a member key still allows: the thief can take the multisig's next transaction index just before a member's
stop lands (a vault transaction is created at `transaction_index + 1`), making it fail. The tool sends its stop for
the next few indices at once (`--variants`, default 4) and repeats (`--rounds`); a variant beyond the index the stop
lands at executes a second, harmless clear. Each index the thief takes costs him the rent of a vault transaction he
cannot close (about 0.002 SOL; the multisig's stale index moves only with a config change, which only the vault can
make), and he must win every slot of the window (a race the stop now enters with a compute-unit price, entry 95). The owner's clear with his restored approver key and the admin's
remain; O34's clear-only keys would leave nothing to race and stay the owner's decision. The CLI signs with a member
keypair file (`--keypair`, never printed) and sends, or prints the unsigned transactions and their message hashes
(`--member`). 8.1, 8.4 step 5, 8.6, O30, O34, O35 and T85 are corrected.
The checker (`invariants.mjs`) now also attributes the log events of calls into this program made by CPI from
another program (here Squads), call by call (`cpiCallLogs`), so the stop runs with the checker on.

Tests. `34-guardian-stop` R7-1 (the pinned Squads v4 mainnet dump, added to `npm run launchpad:fixtures`; its
ProgramData has no upgrade authority, so the pin never moves): with the guardian a controlled 1-of-3 multisig that
the checklist accepts, the thief publishes; members A and B each create, propose and approve in one transaction, the
thief cancels with the owner's member key, and their executes fail (`InvalidProposalStatus`); the tool's single
transaction halts the batch, pauses launches and cannot be cancelled; at `valid_from` the thief's founder cannot
launch and the thief cannot publish. The index race: the thief takes the next index, the first variant fails
(`ConstraintSeeds`), the second executes. The CLI's print-only transaction, signed by member B, executes.
Before this round the tool did not exist; the two-transaction stop is the review's reproduction.

### 88. The checklist: the guardian's stops survive one lost key; the approver is no vault of the guardian's (8.1, 8.4, O32, O35; reviews R7-2, R7-CONF-3)

**Spec.** O35: "1 of 3 of the members (built: the deploy checklist refuses anything else)". O32 (a): an approver
multisig "distinct from the guardian multisig (the program refuses the guardian)"; 4.4: "the key that stops a wrong
batch is never the key that signs it".

**Issue.** `checkSquadsRoles` read neither the threshold nor the members' permissions: a controlled 3-of-3, or a 1-of-3
whose other two members may only vote, passed with no warning, and in the latter only the owner's key can start or
execute a stop (the real Squads program refuses a vote-only member's vault transaction, `Unauthorized`). Low (R7-2).
And it compared the approver with member keys only: vault 1 of the guardian's own multisig as approver passed the
program (`check_approver_separate` compares exact keys) and the checklist, so any guardian member could publish
batches. Low (R7-CONF-3).

**Choice.** In `checkSquadsRoles`: the guardian multisig's threshold must be 1 (`GUARDIAN_THRESHOLD`) and at least two
members must hold Initiate, Vote and Execute (`GUARDIAN_TOO_FEW_ACTORS`, which replaces the `GUARDIAN_ONE_MEMBER`
warning: one member is now a problem); the approver (current or proposed) must be no vault, any index, of the
guardian's multisig (`APPROVER_IS_GUARDIAN_VAULT`) or the vault's (`APPROVER_IS_VAULT_MULTISIG_VAULT`); an approver
that is off the ed25519 curve can only sign as a program address, so `--approver-multisig` is then required
(`APPROVER_MULTISIG_UNCHECKED`), the approver must be one of its vaults (`APPROVER_NOT_MULTISIG_VAULT`), it must have
no time lock (`APPROVER_TIME_LOCK`) and share no member key with the guardian's or the vault's multisig
(`APPROVER_MULTISIG_SHARES_MEMBER`). `fetchChecklistSnapshot` fetches the approver multisig. The program is not
changed: it cannot know the multisigs, and O32 (a) keeps a multisig approver possible; O32 (a) now says the program
refuses only the guardian's exact key.

Tests. `32-batch-checklist` R7-2, R7-CONF-3: vote-only members, an executor without Initiate, two actors (passes), a
controlled 3-of-3 and 2-of-3; `set_launch_approver(vault 1 of the guardian multisig)` executes on chain and the
checklist refuses it as current and as proposed approver; a vault of the vault's multisig; an approver multisig that
passes, one sharing a member with both multisigs, one with a time lock, a guardian vault named with another approver
multisig, a wallet key with an approver multisig named; the CLI option and the fetched snapshot. The R6 tests follow
(a 2-of-3 autonomous multisig now also gives `GUARDIAN_THRESHOLD`; the real time-locked 2-of-3 fixture with mixed
permissions gives all three). `34-guardian-stop` R7-2 shows the real Squads program refusing the vote-only member.
Against the previous checklist the R7 test fails at its first refusal (nothing was reported).

### 89. The recovery from a stolen guardian also lifts a batch halt (4.4, 8.1, T72, T73; review R7-CONF-2)

**Spec.** 4.4's recovery, 8.1's worst case for a stolen guardian, T72, T73 and the SDK's `guardianRecovery` predate the
batch path; 4.26 lets the guardian clear and halt, which only `set_launch_approver` lifts.

**Issue.** After the documented recovery (`set_guardian`, `set_pause`) `LaunchBatch.halted` stayed true: every
publication and batch launch was refused until a further time-locked proposal. Liveness only; low.

**Choice.** `guardianRecovery({ ..., launchApprover })` adds `set_launch_approver(launchApprover)` right after
`set_guardian` (the current approver when `LaunchBatch.halted` is true, or a new key if that one may be stolen too). It
clears both stored records and lifts the halt; no flag the thief can set makes it fail (its checks are on keys the
admin sets). 4.4, 8.1, T72 and T73 say so.

Tests. `28-governance` R7-CONF-2: the thief guardian pauses launches, halts buys, clears and halts the batch path; the
old recovery leaves the halt (it never names `LaunchBatch`); late in the time lock the thief halts buybacks; the new
recovery (set_guardian, set_launch_approver, set_pause) executes, the approver publishes at once, buys reopen in the
second proposal, the cleared batch cannot be used and the new one launches a city. Against the previous SDK the
recovery has two instructions and the test fails there.

### 90. The text brought up to date (3.11, 6.6, I20, I21; review R7-CONF-5); a leftover of the round-6 verification

**Issue.** 3.11 and the `BatchRecord.cleared` doc said "every change of the approver", while every
`set_launch_approver` call clears, the same key included (4.24); I20's per-call rule for a new `Approval` and I21's
founder sentence did not name the launch approver, which `check_founder_key` and the checker refuse; 6.6's trust
label did not mention the launch approver, which 14.1's honest copy does. Info.

**Choice.** 3.11, the doc comment in `state.rs` and so the IDL (`sdk/idl/vicinity_curve.json`, regenerated with
`npm run vcurve:idl`; the comment keeps its two lines, so no source line moves and the binary is the round-6 build
byte for byte, sha256 `0a5beef2...`) say "every `set_launch_approver` call, the same key included"; I20 and
I21 name the approver and 4.27; 6.6's label names the approver's daily list of up to 512 launches taking force 12
hours after signing. The behaviour was already tested (`30-batch`, a same-key `set_launch_approver` clearing both
records).
The round-6 verification left a file in the default archive (`~/.vicinity-curve/launch-batches`, from a CLI run
without `--archive`); the archive layout of entry 83 ignores such files (no `pending/` or `signed/` folder, no MAC).
Every CLI run of the suites now names a scratch archive and sets `VICINITY_BATCH_ARCHIVE` to a scratch folder, and
`33-batch-verifier` asserts that nothing was written to the default archive.

### 91. The correction of a batch in force is built and checked by the verifier (8.4 step 5, 8.6, O33; review R8-OPS-1)

**Spec.** 8.4 step 5: an entry wrong or a seat lost in the batch in force: "`[clear_launch_batch(halt = false),
publish_launch_batch(corrected)]` in one transaction by the owner". Step 2: the owner signs the website's transaction
only after `verify --tx` has found it to be exactly the verified publication.

**Issue.** `verify` built only a lone publication, and `checkPageTransaction` took the first instruction of the program
for the publication: the prescribed `[clear, publish]` was refused (`TX_NOT_VERIFIED`, `TX_OTHER_INSTRUCTION`). The
owner could sign the website's correction unchecked (R7-CONF-1's gap reopened: a compromised page could put another
root in it) or sign the verifier's lone publication, which leaves the batch in force, the bad entry included, running
until the corrected list's `valid_from`, about 12 hours. Reproduced; low (the safe path, the approver's clear and then a
verified publication, worked with the tools of the time).

**Choice.** The review's fix, both parts:
* `verify --correct` builds `[clear_launch_batch(halt = false), publish_launch_batch]`, the approver its only signer
  and fee payer, prints its message hash and keeps it as pending (`clears: true`). The changes are shown as they stand
  once the clear has landed: every entry of the list is a new approval, and each live stored record the clear ends is
  printed for reference with its changes (the removed entry among them); those records hold no ticker any more, and
  `NO_PREVIOUS` / `NO_IN_FORCE` do not apply (nothing of theirs can launch after the clear). The alarms
  (`LATEST_NOT_ARCHIVED`, `IN_FORCE_NOT_ARCHIVED`) still stop it: a stored batch nobody confirmed is a stolen key,
  which needs a halt, not the approver's correction. With nothing live, `--correct` is a warning (`NOTHING_TO_CLEAR`).
* `checkPageTransaction` accepts exactly the verified instructions of the program in order: the clear, then the
  publication under `--correct`; the publication alone otherwise. A page transaction that clears without `--correct`
  is `TX_CLEAR_NOT_ASKED` (run again with `--correct`, which shows the changes after the clear); one that does not
  clear under `--correct` is `TX_NO_CLEAR`; another order, a repeated instruction, a halting clear (`TX_NOT_VERIFIED`:
  a halt would refuse the publication itself) or another authority (`TX_ACCOUNTS`) is refused.
* Without `--correct`, a list that removes or changes an entry of the batch in force (the stored `latest` in force, or
  `previous` while `latest` is pending) is warned: `STILL_IN_FORCE`, those entries can still launch as the batch lists
  them until this list's `valid_from`; run again with `--correct` to stop them now.
8.4 step 5 names `verify --correct`.

Tests. `33-batch-verifier` R8-OPS-1 (the real CLI): batch 1 (A, B, BAD) verified, signed exactly as printed and
confirmed, in force; a plain verify of L2 (A, B) warns `STILL_IN_FORCE`; the page's `[clear, publish]` is
`TX_CLEAR_NOT_ASKED` without `--correct` and accepted with it, the changes after the clear and the cleared batch 1
(`- CBAD`) printed with its hash; the clear's order, halt, repetition and authority refused; `verify --correct`'s own
transaction, signed as printed: batch 1 cleared, nothing in force, BAD's launch refused (`BatchCleared`), `confirm`
passes, A launches at L2's `valid_from` and BAD still cannot. Against the round-7 verifier the test fails at
`STILL_IN_FORCE` (and `--correct` is an unknown option).

### 92. Every account, the clock and the pending approvals from every RPC; `check` too; two RPCs are two providers (8.4, 14.1; reviews R8-DIFF-1, R8-DIFF-4)

**Spec.** 8.4 step 2 (round 7): on a first use two RPCs, "compared account for account"; NOTES 84 compared only
`Launchpad` and `LaunchBatch`.

**Issue.** The clock (`getBlockTime`), the pending approvals (`getProgramAccounts`) and every city's accounts came from
the first `--rpc` alone. A liar that answered the true `Launchpad` and `LaunchBatch` but a clock past a thief's batch
turned `LATEST_NOT_ARCHIVED` into a warning ("it is expired and can let nobody launch"), so the owner signed while the
thief's batch stayed in force; it could equally hide a pending approval holding a ticker, or a listed city's coin; on a
first use it removed `NO_PREVIOUS`. A `null` block time crashed the run. And `check` accepted a second `--rpc` and never
read it, while two URLs of one provider (a trailing slash, another key) counted as two. Reproduced; low and info.

**Choice.**
* The clock is the Clock sysvar, read in the same `getMultipleAccounts` call as the accounts it judges, from every RPC
  (`compareChainViews`): the clocks must be within 60 seconds (`RPC_CLOCK_DISAGREE`) and the earlier is used (an
  earlier time keeps records live longer and moves the default window earlier, never past what the program allows);
  every account (`Launchpad`, `LaunchBatch`, configs, each city's and each holder city's accounts) must be the same on
  every RPC (`RPC_DISAGREE`, naming the accounts); the pending approvals must be the same set on every RPC. Any
  disagreement stops the run (retry, and do not sign until they agree). `getBlockTime` is no longer used. (Narrowed
  by the verification of round 8, entry 97: each `Coin`, which every trade rewrites, is compared by existence and
  owner only.)
* `check` and `confirm` read every RPC the same way.
* Two `--rpc` must be two providers: their IP addresses, or the last two labels of their host names, differ
  (`rpcProvider`); `https://x.example` and `https://x.example/`, or `mainnet.helius-rpc.com` and
  `rpc.helius-rpc.com`, are one. A public suffix such as `co.uk` makes two providers under it look like one, which
  errs on the side of refusing. Every `--rpc` must be http or https.

Tests. `33-batch-verifier` R8-DIFF-1 (the real CLI, a liar on 127.0.0.2): a liar hiding the pending approval that
holds DTICK, or the coin of a listed city, is `RPC_DISAGREE`; the review's case (batch 1 confirmed, the thief's batch 2
in force 30 hours, the liar's clock past its end) is `RPC_CLOCK_DISAGREE` and no transaction, while two honest RPCs
give `LATEST_NOT_ARCHIVED` and a clock 30 seconds behind is accepted; `compareChainViews` (tolerance, earliest clock,
a missing account, no clock). R8-DIFF-4: `check` with the liar first is `RPC_DISAGREE` and reads the second RPC; the
same-provider pairs are refused for `verify` and `check`. Against the round-7 verifier the approvals case printed a
transaction and `check` reported "the stored batch is the list".

### 93. The page's window is the default one; `confirm` and the alarm compare the transaction that wrote a record (8.4 steps 2 and 3, T89; review R8-DIFF-2)

**Spec.** NOTES 83: "a thief re-publishing a refused list cannot reproduce the verifier's window unless he publishes
within ten minutes of the owner's run and guesses the second".

**Issue.** In the `--tx` flow (14.1's normal path) the website chose the window: any the program accepts (from 12 to
48 hours ahead, up to 48 hours long) was verified and archived as pending. A thief who reads or runs the site and
holds the approver key republished a refused list with exactly that window up to about 36 hours later; the next
`verify` took the exact-match branch and told the owner to run `confirm`, which made the thief's list a baseline, and
the next day's changes hid his entry. Reproduced; low (the owner had to confirm a list he refused).

**Choice.** Both parts of the review's fix:
* `verify --tx` accepts only the default window: `valid_from` at most 20 minutes past `now + 12 hours` (the SDK's 10
  minutes and 10 more for the page's clock and the owner's delay) and 36 hours long (`TX_WINDOW_NOT_DEFAULT`). A
  republication must then land within minutes of the owner's run.
* `confirm` reads, from every RPC, the successful transactions in the record's `published_slot` that carry exactly its
  `publish_launch_batch` (`landedPublicationHashes`: `getSignaturesForAddress(LaunchBatch)`, then `getTransaction` in
  base64, the message taken byte for byte after the signatures; since review round 9, entry 100, the block of the
  `published_slot` itself, which no flood of the account's history can hide), and keeps the list only when the pending entry's
  message hash is among them (`NOT_YOUR_TRANSACTION`, `TX_NOT_FOUND`; the RPCs must name the same transactions). A
  republication is another message (another blockhash at least), so it is never confirmed. The owner must therefore
  sign exactly the transaction whose hash he was shown (a wallet that adds a compute-unit price makes another message:
  `confirm` then refuses, as it should).
* The alarm reads the same when a live record has the window of a pending list: when the transaction that wrote it is
  another one, it says so (a republication; the key is stolen; clear with halt now) and does not suggest `confirm`;
  when it is byte for byte the verified message, it says that too (if he refused it, whoever holds the approver key
  signed that very message). The page's message hash is now taken from the wire bytes, as the landed one is.
What remains: the thief signs the very message the owner verified, within its blockhash's lifetime (about a minute):
ed25519 signatures are deterministic, so that transaction is indistinguishable from the owner's own. Only the owner
knows he refused it; the alarm names this case, and the monitor and the second person see the list.

Tests. `33-batch-verifier` R8-DIFF-2 (the real CLI, two RPCs): the review's window (now + 47 h for 48 h) is
`TX_WINDOW_NOT_DEFAULT` and nothing is kept; the default window passes; the thief republishes the refused list with
that window minutes later in his own transaction: the next verify says "the transaction that wrote it is another
one ... a republication" and suggests no `confirm`, and `confirm` is `NOT_YOUR_TRANSACTION` (before round 8 it exited
0 and wrote `signed/`); the owner's own batch 1 is confirmed by its transaction; the identical replay of a verified page
message is named as such. Every suite now signs and sends the printed transaction exactly as printed
(`World.sendWire`), and the JSON-RPC stub serves the World's blockhash, transaction history and statuses.

### 94. An approver multisig is checked for roles among its members and its config authority; a multisig approver is not ready while the verifier cannot check it (8.4, O32; reviews R8-DIFF-3, R8-DIFF-6, R8-OPS-3)

**Spec.** O32 (a) and the checklist (R7-CONF-3): a separate approver multisig, sharing no member key with the
guardian's or the vault's multisig, is accepted with `--approver-multisig`.

**Issue.** The checklist compared member keys only. A guardian vault (or the admin vault) as a member of the approver
multisig, or a guardian member key (or the guardian vault) as its config authority, passed: one stolen guardian member
key could then publish batches through it (reproduced against the real Squads program: g1 alone adds himself, lowers
the threshold to 1 and publishes). Low (R8-DIFF-3). And for such an approver the verifier printed a transaction whose
fee payer is a program address that cannot sign, while `verify --tx` refused every Squads-wrapped publication: the
members would approve a website-built proposal whose root nothing checked (info; R8-DIFF-6, and R8-OPS-3, a duplicate).

**Choice.**
* In the approver multisig: a member that is the guardian, the admin vault or any vault of the guardian's or the
  vault's multisig is refused (`APPROVER_MULTISIG_MEMBER_IS_ROLE`), and so is any other member that is not a wallet key
  (`APPROVER_MULTISIG_PROGRAM_MEMBER`: whoever controls that program would vote); its config authority must be none
  (only its own members change it) or the admin vault (`APPROVER_MULTISIG_CONFIG_AUTHORITY`); a threshold of 1 is a
  warning (`APPROVER_MULTISIG_THRESHOLD_ONE`), since O32 (a)'s benefit needs two signatures.
* The safer of the review's two options for R8-DIFF-6: the verifier refuses an approver that is not a wallet key
  (`APPROVER_NOT_WALLET_KEY`), and the checklist reports any such approver as not ready (`APPROVER_NOT_VERIFIABLE`).
  O32 (a) therefore needs a Squads mode of the verifier first (decode the `vault_transaction_create` message, check
  its one `publish_launch_batch` against the verified publication, print the hash of each member's transaction, and
  read the stored vault transaction before the executing member signs); it is not built, and O32 (a) says so. O32's
  default, a wallet key, is unaffected.

Tests. `32-batch-checklist` R8-DIFF-3, R8-DIFF-6: the review's cases (a) and (b), the guardian vault as config
authority, the admin vault and vaults of both multisigs as members, an unrelated program address, a threshold of 1,
and two correct approver multisigs (autonomous, and controlled by the admin vault) that fail only on
`APPROVER_NOT_VERIFIABLE`; the round-7 expectations gain that code wherever the approver is a program address.
`33-batch-verifier` R8-DIFF-6: `set_launch_approver(a program address)` executes and the verifier gives
`APPROVER_NOT_WALLET_KEY` and no transaction. Against the round-7 scripts both pass silently.

### 95. A guardian member's stop reads and sends through two RPCs and carries a compute-unit price (8.4 step 5, 14.1; reviews R8-OPS-2, R8-DIFF-7)

**Spec.** 8.4 step 5 and the scripts' README set no RPC rule for the stop; NOTES 87: the thief "must win every slot of
the window".

**Issue.** `guardian-stop.mjs` read the multisig, `Launchpad` and `LaunchBatch`, decided "the chain shows the stop"
and sent everything through one `--rpc`: an RPC that served a halted LaunchBatch made it print the stop and exit 0
without sending anything (reproduced; low). And its transactions carried no compute-unit limit or price, so a thief
paying priority fees for the multisig's next index was ordered ahead of the stop (info; the ordering cannot be
reproduced in litesvm).

**Choice.**
* `--rpc` twice, two providers (the rule of entry 92), neither operated or relayed by the website. Both are read every
  time; the stop counts only when both show it and one of the member's own transactions is confirmed (either RPC's
  `getSignatureStatuses`). Before sending, both showing the stop means nothing is sent. Each transaction is sent
  through both RPCs, and the variants are built with each RPC's blockhash and cover the next indices as each RPC sees
  the multisig, so one lying RPC can neither spoil every variant nor fake the result. A precondition that only one RPC
  shows unmet does not keep the member from stopping (a warning says the RPCs disagree). When both show the stop but
  none of the member's transactions is confirmed after the rounds, the tool says so (exit 1): another member's stop, or
  RPCs not to be trusted. (Completed by the verification of round 8, entry 98: each RPC within a timeout, so one that
  fails or does not answer never holds the stop; and by review round 9, entries 99 and 101: every value an RPC returns
  checked on its own, and two RPCs that disagree on the stop reported as such.)
* Each transaction starts with `SetComputeUnitLimit(150,000)` (a stop measured about 90,000 units) and
  `SetComputeUnitPrice` (`--priority-fee`, micro-lamports per unit, default 1,000,000, about 0.00015 SOL per
  transaction, doubled each round up to 50,000,000), outside the vault message, so the stop itself is unchanged.
The checker (`invariants.mjs`) charges the prioritization fee (`priorityFeeOf`) in successful and failed transactions.
8.4 step 5, 14.1 and the scripts' README carry the two-RPC rule; the monitor's paging text names the command with
both.

Tests. `34-guardian-stop` R8-OPS-2, R8-DIFF-7: the liar alone is a usage error and nothing is read (before round 8:
"the chain shows the stop", exit 0, nothing sent); two URLs of one provider are refused; the honest RPC and the liar
(which serves a halted LaunchBatch and drops every transaction) disagree, the stop goes through the honest RPC and is
reported with the member's confirmed transaction, and the real chain is halted; a second run sends nothing. Each
printed variant carries the limit and the price given, the price doubles per round, and the printed stop (pause,
halt buys, clear) executes within its limit when signed as printed. The round-7 command-line test uses two RPCs and
signs the printed transaction as printed.

### 96. The archive's MAC key lives outside any archive folder and is 32 bytes (8.4 step 2; review R8-DIFF-5)

**Spec.** NOTES 83: every archive entry carries an HMAC under `archive.key`, "a random key created there on first use".

**Issue.** The key lived inside the archive folder that `--archive` or $VICINITY_BATCH_ARCHIVE names, so a folder handed
over whole, with its own key and entries MAC'd under it, was trusted in full: a thief's batch became the baseline and
his entry vanished from the changes. An empty, odd or non-hex key decoded to 0 or 1 bytes, which anyone can MAC with.
Reproduced; info (it needs the owner talked into a foreign folder, or a corrupted key file).

**Choice.** The key is `~/.vicinity-curve/archive.key`, this computer's, independent of the archive folder (a file of
that name inside a folder is ignored); it must hold exactly 64 hex digits (`ARCHIVE_KEY`: the run stops); it is created
once, atomically (written to a temporary file, then hard-linked into place, never over an existing key). Every
`verify` and `confirm` prints the archive folder, the key file and its fingerprint (the first 16 hex digits of its
SHA-256), and warns (`ARCHIVE_MOVED`) when the folder is not the one used last (`~/.vicinity-curve/last-archive`).
The owner backs the key up with the archive; a lost key makes every archived list unreadable, which is a first use
(two RPCs, the live batch printed in full), never a silent baseline. No archive was in use (the program is not
deployed), so nothing migrates.

Tests. `33-batch-verifier` R8-DIFF-5 (the real CLI with a scratch HOME): a handed-over folder in round 7's layout,
named by `--archive` or $VICINITY_BATCH_ARCHIVE, is warned as moved, its entry ignored and the run a first use (before
round 8: the thief's list was the baseline and GEVIL vanished); `readArchive` with the folder's own key and with this
computer's; key files of 0, 14, 3 and 62 characters stop the run; a key is created once and never replaced, and its
fingerprint printed. Every CLI run of the suites names a scratch HOME.

### 97. The coins, which every trade rewrites, are compared between the RPCs by existence and owner (8.4 step 2, 14.1; verification of round 8, R8-NEW-1)

**Spec.** NOTES 92 (review R8-DIFF-1): "every account (`Launchpad`, `LaunchBatch`, configs, each city's and each
holder city's accounts) must be the same on every RPC".

**Issue.** Byte for byte included each city's `Coin` and the old program's `Coin`, whose reserves, `tokens_sold`, fee
counters and `trade_seq` change with every buy, sell, buyback and fee claim. `verify` reads the coins of the list's
cities and of the cities of the stored batches (the holder candidates of entry 86), so yesterday's cities, launched
and trading: two honest RPCs one slot apart then disagree, `verify` stops with `RPC_DISAGREE` whenever one of those
coins trades between the two reads, and on a first use, where two RPCs are required, the owner may not get a
transaction at all; `check` the same. Reproduced in litesvm: a buy landing between the two RPCs' reads of the daily
`verify` gave `RPC_DISAGREE` naming the coin and no transaction. Low.

**Choice.** The verifier uses only whether a coin exists (a city with a coin is refused, and a holder city with a
coin holds no ticker), never its content. `compareChainViews` therefore compares the accounts of
`presenceOnlyAddresses` (each read city's `Coin` and old-program `Coin`) by existence, as the verifier judges it, and
by owner, and every other account byte for byte as before: `Launchpad`, `LaunchBatch`, the configs, the per-city and
old-program `Approval`s and the `TickerLock`s change only with an admin call, a launch, a publication or a clear,
after which the owner runs it again. A hidden or invented coin, or one of another owner, is still `RPC_DISAGREE`.
Reading both RPCs at one slot was considered and not built: `minContextSlot` only sets a floor (an RPC answers at its
own, newer slot), and no RPC serves accounts as they stood at a past slot. Neither the program nor the SDK changes.

Tests. `33-batch-verifier` R8-NEW-1 (the real CLI against two stubs; the second, asked for the coin, waits until the
first has served it, lets a buy land, then answers): batch 1 confirmed, its city A launched and trading; the daily
`verify` of batch 2, a first use with `--previous`, and `check` of batch 1 each read coin A on both sides of a trade
and pass (before: `RPC_DISAGREE` naming coin A, no transaction); an RPC hiding coin A is still `RPC_DISAGREE`;
`compareChainViews` with `presenceOnly`: a coin and an old program's coin after a trade agree, a hidden coin, a hidden
old coin and a coin of another owner disagree, the `Launchpad` is still compared byte for byte, and without
`presenceOnly` a traded coin disagrees.

### 98. One failing or silent RPC never holds a guardian stop (8.4 step 5, 14.1; verification of round 8, the residual of R8-OPS-2)

**Spec.** NOTES 95 and the tool's header: "one lying or failing RPC can neither report a stop that is not on chain
nor drop the stop unseen".

**Issue.** The two RPCs were read with `Promise.all` and no timeout. One RPC answering HTTP 503 rejected the first
read, and the tool exited (status 1) before building or sending anything, in print-only mode too; a silent RPC (the
connection accepted, never answered) hung it without output, since web3.js sets no timeout; the sends went RPC after
RPC, so a silent first RPC would have held every send through the second; and the print-only mode built its variants
on the first RPC's blockhash alone, so an RPC inventing its blockhash, named first, spoiled every printed variant.
Reproduced against the round-8 tool in litesvm: through a 503 RPC, print-only and signed both exited 1 within 0.3
seconds with nothing printed or sent; through a silent RPC, no output and nothing sent until the run was killed at
45 seconds; with the inventor first, both printed variants carried the invented blockhash. Low.

**Choice.**
* Every RPC call carries a timeout (`--timeout`, seconds, default 8, 1 to 60; web3.js's retries on HTTP 429 are off,
  since the polls retry anyway), and each RPC is read on its own: one that fails or does not answer is reported
  ("failed: 503 ...", "failed: no answer within 8 s", `warning RPC_FAILED`) and the stop goes ahead through the one
  that answers; the preconditions and the next indices come from the RPCs that answered. Neither answering is a
  `PROBLEM` at once.
* Each RPC's blockhash is used as soon as it arrives: its variants are signed and sent through every RPC at once, each
  send within the timeout, so no send through an honest RPC waits for a bad one. Each round reports how many sends
  each RPC accepted, and every RPC's state (its view of the multisig's index, whether it shows the stop) is printed at
  the start and at the end. An RPC is named by its number and host only, so an API key in its URL is never printed
  (the round-8 tool printed the whole URL when a send failed).
* The print-only mode prints the variants on every blockhash the RPCs gave, each group headed by its blockhash and the
  RPCs that gave it.
* The protection against a false success holds: exit 0 only when both RPCs answer and show the stop and one of the
  member's transactions is confirmed. When the RPC that answers shows the stop with the member's transaction confirmed
  and the other failed, the tool sends no more rounds (none would make it surer) and says `PROBLEM RPC_FAILED`: one
  RPC is no proof; check `LaunchBatch` through a third provider and tell the other members (exit 1). Before sending,
  one answering RPC that already shows the stop does not hold the member back: a repeated stop changes nothing.

Tests. `34-guardian-stop` R8-OPS-2 residual (the real CLI against stubs that answer 503, never answer, or invent their
blockhash, each named first): print-only through the 503 RPC prints the honest RPC's variants and reports the 503
(before: exit 1, nothing printed); print-only with the inventor prints both blockhash groups, and the honest one's
variants are for the next indices (before: only the invented blockhash); signed through the 503 RPC, the stop lands
through the honest one (before: nothing sent), the round's report shows no send accepted by the failing RPC and every
send by the honest one, and the tool exits 1 with `RPC_FAILED`; signed through the silent RPC (a 1-second timeout),
the same within seconds (before: no output); both failing is a `PROBLEM` at once; `withTimeout`, `rpcLabel` (the host
only), `summarizeViews` (proof needs every RPC) and `blockhashGroups`. The suites' JSON-RPC stub gained `before`
(awaited before it answers) and `status` (an HTTP status, or 'silent'), and closes the connections it holds.

### 99. Every index and blockhash an RPC returns is checked on its own by the guardian stop (8.4 step 5, T85, 14.1; review R9-TOOLS-1)

**Spec.** NOTES 95 and 98 and the tool's header: "one lying or failing RPC can neither report a stop that is not on
chain nor drop the stop unseen".

**Issue.** Entry 98 covered an RPC that fails or does not answer, not one that answers with bad data. The variants
covered the union of every RPC's next indices with no bound, so a lying RPC that served the real multisig account with
`transaction_index` (offset 78) set to u64::MAX put 2^64 and above into the union, and the PDA of every variant threw
(`RangeError: The value of "value" is out of range`); a lying `getLatestBlockhash` of `0OIl` threw in `tx.sign`
("Non-base58 character") inside the shared `Promise.all`, and `main`'s rejection ran `process.exit(1)`, cutting the
honest RPC's sends still in flight; the print-only loop had no per-group `try`, so a liar named first hid the honest
group. Neither error named an RPC. Reproduced at bcb04c0 with the real CLI against the real Squads v4 program: the index
liar named first or second, print-only and signed, exit 1, no `sendTransaction` reached the honest RPC, `LaunchBatch`
not halted; the blockhash liar named first the same; named second, the honest group was printed (or partly sent)
before the exit 1. Low (the reviewer's medium lowered by the verifier: the run fails loudly, the attacker needs the
approver key and a lying provider, and the owner's and the admin's clears remain).

**Choice.** Treat every value from an RPC as untrusted, per RPC:
* `nextIndices(known, variants)`: each RPC's latest view contributes its own next `variants` indices (at most that many
  per RPC, so the union stays bounded at two RPCs times `--variants`). A view whose multisig does not decode, or whose
  index leaves no room for `variants` more below 2^64, is set aside and reported (`warning RPC_BAD_INDEX: RPC n (host)
  shows the multisig at transaction index ...: its view is not used for the indices`). A window around the lowest index
  was considered and not built: a liar reporting a low index would then push the honest RPC's index out of it.
* `validBlockhash(h)`: a string that decodes from base58 to exactly 32 bytes and re-encodes to itself. Any other
  answer is that RPC's failure (`RPC n (host) gave no blockhash: not a blockhash (32 bytes in base58)`), never echoed.
* Each RPC's work runs in its own `try`: its preconditions, its blockhash's build, signatures and sends (signed mode),
  each blockhash group (print-only). An error is reported with the RPC's name and never rejects the other RPC's work,
  and `main` returns only after every send has settled, so no exit cuts a send in flight.
A liar's other values were already harmless: its accounts are decoded in `try`, and its view counts for the stop only
together with the other RPC's (entries 95, 98).

Tests. `34-guardian-stop` R9-TOOLS-1 (the real CLI, the index liar and the blockhash liar each named first and second,
print-only with `--variants 2` and signed with `--rounds 1`): every run exits 0, the honest RPC's two variants are
printed for the next indices (the index liar's none), the liar is named (`RPC_BAD_INDEX`, "not a blockhash"), the
signed run sends through the honest RPC, both RPCs show the stop and the member's transaction is confirmed, and the
real `LaunchBatch` is halted (the admin lifts it and the thief republishes between runs). Before the change the first
run exited 1 with the `RangeError`. `validBlockhash` (the World's blockhash; `0OIl`, empty, 44 ones, one character too
many, non-strings) and `nextIndices` (two views, at most two per RPC; a view at 2^64 - 2 and a view with no multisig set
aside; the last two indices a u64 holds).

### 100. `confirm` and the alarm read the publication's own block; a transaction not found is never a theft (8.4 step 3, T89, 14.1; review R9-TOOLS-2)

**Spec.** Entry 93: `confirm` reads "the successful transactions in the record's `published_slot`"; the round-8 code
paged back through `getSignaturesForAddress(LaunchBatch)` "until that slot is passed".

**Issue.** The paging stopped after 20 pages of 1,000 signatures and returned none. Anyone, with no key, can send
20,000 cheap transactions that list `LaunchBatch` read-only (about 0.1 SOL in base fees; failed ones count too), newest
first in the history: the owner's `confirm` of his own publication then failed (`TX_NOT_FOUND`: "if it persists, page
the guardian members"), and the next `verify` took the empty list for another transaction ("a republication by someone
holding the approver key ... so the key is stolen: have a guardian member clear it with halt now"). Following the tool,
the owner and the guardian halt the honest batch, and batch launches stay off until the admin's time-locked
`set_launch_approver`. The same false verdict followed any other empty answer (an RPC with pruned history). Reproduced
through the real CLI with real flood transactions in litesvm; a flood of 200 did not trigger it. Low.

**Choice.**
* `landedPublicationHashes` reads the block of the record's `published_slot` once (`getBlock`, base64, transaction
  details `full`, version 0, `confirmed`, no rewards) and keeps the successful transactions (`meta.err` exactly null)
  that name `LaunchBatch` and carry exactly the record's `publish_launch_batch` as an instruction of this program, at
  the top level or as an inner instruction (a publication through another program, which the round-8 code missed;
  their message hash is the outer transaction's). The account's history no longer matters. A mainnet block in full is a
  few megabytes, read once per `confirm`.
* An RPC that cannot serve the block (an error, HTTP status, no block) is `TX_UNREAD`, naming the RPC by host; no
  transaction found is `TX_NOT_FOUND`. Both mean retry in a minute, or read through a third provider; `confirm` ends with
  that advice instead of paging anyone. In `verify`, the alarm for a live record with the window of a verified list
  says "the transaction that wrote it was not found on the RPCs read: retry in a minute, or read it through a third
  provider; not finding it proves nothing. If you signed exactly that transaction, confirm it once it is found ... If you
  did not sign it, the approver key is stolen", and `TX_UNREAD` or `RPC_DISAGREE` on the landed transaction is printed
  with it (the run gives no transaction either way). "The transaction that wrote it is another one ... the key is
  stolen" is kept for a transaction found with another message hash.
* `rpcCall` fails on an HTTP error status instead of parsing its body.
The alternative of paging until the slot is passed was not built: it reads the whole flood each time.

Tests. `33-batch-verifier` R9-TOOLS-2 (the real CLI, two stubs whose `getSignaturesForAddress` serves 20,000 newer
signatures first): batch 2, verified, signed as printed and landed, is confirmed (before: `TX_NOT_FOUND`, exit 1); with
both RPCs serving batch 3's block without its transaction, the next `verify` says "was not found ... proves nothing"
and never "another one" or "so the key is stolen", and `confirm` says `TX_NOT_FOUND` with the retry tail and pages no
one; an RPC answering `getBlock` with HTTP 503 is `TX_UNREAD` naming it; served again, batch 3 is confirmed by its
message hash. `landedPublicationHashes` against a crafted block: the publication as an inner instruction of another
transaction is found as that transaction's hash; a failed transaction and other data are not. The suites' JSON-RPC
stub serves `getBlock` (every transaction the World sent in that slot).

### 101. Two RPCs that disagree on the stop end the rounds once both confirm the member's transaction, and are reported (8.4 step 5, T85, 14.1; review R9-TOOLS-3)

**Spec.** Entries 95 and 98: the stop is proven only when both RPCs show it and one of the member's transactions is
confirmed; a stop shown by the RPC that answers while the other failed ends the rounds (`RPC_FAILED`).

**Issue.** When both RPCs answered but disagreed (one serving `LaunchBatch` as it stood before the stop), the loop never
ended early: every round sent a full set of variants at a doubled price, each landing as a repeated stop with its rent,
and the final verdict tested only "every RPC answered" and printed "the stop is not on chain after every round (as both
RPCs show it)", next to a line saying one RPC shows it. Reproduced (`--rounds 2`: round 2 sent four more variants, the
multisig index went from 0 to 2, exit 1 with that text, the member paid 12,974,080 lamports, the stop on chain). Info.

**Choice.**
* `confirmations(sigs)` asks each RPC on its own and returns `any` (one of the member's transactions confirmed on some
  RPC, as before) and `every` (one confirmed on every RPC). The rounds end when both RPCs answer, one shows the stop and
  `every` holds: a successful stop transaction executes the stop, so an RPC that confirms it but does not show the stop
  lies or lags, and another round would only repeat the stop. The review proposed ending on one RPC's confirmation, as
  the `RPC_FAILED` branch does; that was not built for this case, because a liar that shows the stop and calls every
  signature confirmed would then end the rounds after round 1 even when the honest RPC's sends had not landed (a thief
  taking each index), the case the rounds exist for. With `every` required, such a liar ends nothing.
* The verdict: `PROBLEM RPC_DISAGREE: RPC x (host) shows the stop and RPC y (host) does not; this member's transaction
  ... is confirmed on both RPCs` (or "on one RPC only", or "none ... is confirmed") ": one of them is lying or behind;
  check LaunchBatch (halted, both records cleared) through a third provider and tell the other members" (exit 1). "As
  both RPCs show it" is printed only when both answered and neither shows the stop.
`summarizeViews` gains `someShown`.

Tests. `34-guardian-stop` R9-TOOLS-3: the review's stale RPC, `--rounds 2`: one round, one stop executed (the multisig
index up by one), `RPC_DISAGREE` naming both RPCs with the member's transaction confirmed on both, no "as both RPCs show
it" (before: round 2 sent again and that text). Then a liar that serves a halted `LaunchBatch`, calls every signature
confirmed and drops every send, with an honest RPC that drops round 1's two sends: round 2 is sent and the stop lands
(exit 0), so one RPC's word never ends the rounds.

### 102. The buyback share against the fixed per-run cap: 8.4's operating rule; open owner decision O36 (5.13, 7.2, 8.4, T76, O1, O25, O36, 14.1; review R9-PF-1)

**Spec.** 7.2: "the cap binds above about 28 SOL of volume per minute at pool open", "a burst of about 266 SOL (curve
start) or 607 SOL (pool open)" creates the break-even backlog; O25: "mitigated by ... a keeper that spends every
interval"; O1: moving the liquidity share to buyback needs "no code change" while V8, V10 and V11 pass.

**Issue.** Those figures are config #0's (`b_B` = 30). One run spends at most `depth * t / (C*D)`, independent of
`b_B`, while the bucket accrues `b_B` of every trade, so a keeper that runs every interval keeps up only while the volume
per interval stays below `depth * t / (C * b_B)`: a third of the depth under config #0, 12.5% under O1's buyback
alternative (0, 70, 50, 50, 80) and 4% under (0, 0, 0, 0, 250), both of which V1 to V11 accept. On the production build,
with the section-9 checker after every transaction (the verifier's run): under (0, 0, 0, 0, 250) the graduating buy alone
left 2.56% of depth pending (above `u*`, 2.04%); at 8 SOL per minute with the keeper every 150 slots the backlog reached
3.64% of depth after 30 minutes, and an outsider who bought 5 SOL and held through 36 runs gained 1.8%; at 20 SOL per
minute, 6.88% and +7.7% after 65 runs. Config #0 on the same schedules: no backlog, the outsider -4.9%. No funds are
stolen or locked; the gain is a bounded dilution of the buyback lift, O25's class, under a config the owner must add.
Low.

**Choice.** No change to which fee splits the program accepts: the task's rule for this round is that no fee value or
fee-share rule changes, and a bound on `b_B` decides which fee splits a config may have (entry 56 treated HR-1, the same
kind of finding, the same way: O29). So:
* 7.2 states the general rate `depth * t / (C * b_B)` per interval and scales config #0's binding rate and burst by
  `30 / b_B` at `t = 250` (b_B = 80: about 10.5 SOL per minute and a 228 SOL burst at pool open; b_B = 250: about 3.4 SOL
  per minute and 73 SOL); 5.13 notes that V1 to V11 do not bound it; O25 is signed off for configs within config #0's
  keep-up only; O1's buyback variant needs O36.
* 8.4 gains an operating rule: the admin adds no config with `C * b_B > 3t` (`K_B` = 3, config #0's keep-up of a third of
  the depth per interval, config #0 exactly at the edge, 750 = 750). The SDK's `buybackKeepUp(params)` gives `keepUp`
  (`{ num: t, den: C * b_B }`, the fraction of the depth) and `withinRule`; the deploy checklist reads every
  `LaunchConfig` and reports an enabled one outside the rule as not ready (`CONFIG_BUYBACK_THROUGHPUT`, "disable it ...
  unless the owner has decided O36 for it") and a disabled one as a warning (coins launched under it keep its split).
* **Open owner decision O36**: a rule V12 in `validate_config`, `C * b_B <= K_B * t` with `K_B` = 3 (refuses O1's buyback
  alternative) or 8 (keeps it, 12.5% of the depth per interval, with 7.2 and O25 restated for it), with a new error
  appended, through the crate, the program, the SDK port, the Appendix A model and the golden vectors; or a per-run cap
  scaled by `b_B`, which changes the step of V8, V11 and Theorem M_K. Either changes the program binary, unchanged since
  round 6.

Tests. `18-attacks-buyback` R9-PF-1 (on chain, the checker on): (0, 0, 0, 0, 250) and (0, 70, 50, 50, 80) pass V1 to V11;
`buybackKeepUp` gives a third for config #0 (within the rule), 1/25 and 1/8 for the other two (outside), and outside
for `b_B` = 31; after a graduating 100 SOL buy the coin under (0, 0, 0, 0, 250) holds 2.56% of depth pending (25 caps)
against config #0's 0.31% (3 caps); the checklist, silent before the config is added (and before this round about any
config), reports it as not ready, and as a warning once the admin disables it. `sdk/curve/math.test.mjs`: the rule at
the edge, one basis point past it, with a smaller total fee, and without a buyback share. The long reproduction (30
minutes of trading and the outsider's hold) is the verifier's; this test pins the mechanism and the check.

### 103. The transaction that wrote a record is found by its publication's arguments, whatever bytes follow them (8.4 step 3, T85, T89, 14.1; verification of round 9, R9-CHECK-1)

**Spec.** Entry 100: `landedPublicationHashes` keeps the successful transactions that carry "exactly the record's
`publish_launch_batch`"; "the key is stolen" is kept for a transaction found with another message hash, and a
transaction not found is `TX_NOT_FOUND`, "retry ... not finding it proves nothing".

**Issue.** "Exactly" was the 68 bytes of the data (discriminator and five arguments). The program's entry point, as
Anchor 0.31 generates it, decodes the arguments with Borsh's `deserialize`, which reads what it needs and ignores what
follows, so `publish_launch_batch` with bytes appended is accepted and writes the very record of its arguments. A
thief with the approver key could therefore republish a list the owner verified, with its window, by appending one 0
byte, while the owner's own transaction never landed (a compromised website drops it): the stored record is exactly
the pending list, `landedPublicationHashes` found no transaction, `confirm` said `TX_NOT_FOUND` with round 9's retry
tail, and the next `verify` said "was not found on the RPCs read ... not finding it proves nothing", where it should
have raised the stolen-key alarm. Reproduced in litesvm against the production build through the real CLI (the
program accepted the 69-byte publication; exit 1 with `TX_NOT_FOUND` and "retry in a minute"). Low: the alarm's
other sentence ("If you did not sign it, the approver key is stolen") still stood, but the tool's verdict was the
benign one.

**Choice.** No program change (which instruction data the program accepts is not changed after round 6; the binary is
unchanged). In the tools:
* `landedPublications` (with `landedPublicationHashes` its message hashes) identifies a writer by the instruction's
  program, the `publish_launch_batch` discriminator and its decoded arguments: any successful transaction in the block
  of the record's `published_slot` that names `LaunchBatch` and carries, at the top level or as an inner instruction,
  a publication of this program whose first 68 bytes are the record's (every byte pattern of the five arguments decodes,
  so equal bytes are equal arguments), whatever its length; shorter data is no publication (the program refuses it).
  It returns each writer's message hash and the length of that data. `confirm` and the alarm then compare the whole
  message hash with the verified one, as before: bytes appended make another message, so the thief's republication is
  `NOT_YOUR_TRANSACTION` ("so the key is stolen: have a guardian member clear it with halt now", the guardian paged)
  and, in `verify`, "the transaction that wrote it is another one ... so the key is stolen". Only a block with no
  publication of the record at all is `TX_NOT_FOUND`, whose text now says so ("no publish_launch_batch of this record
  at all, with or without bytes after its arguments": that block holds the record's writer, so the RPCs served it
  incomplete or are behind), and so does the alarm's "not found".
* A writer whose data is not 68 bytes is named in `warning TX_EXTRA_DATA: the transaction with message hash ... wrote
  batch N with a publish_launch_batch of 69 bytes (1 after its arguments, which the program ignores): neither this
  verifier nor the website's batch page ever builds one, so it is not a transaction you verified`, printed by `confirm`
  and `verify` next to the verdict. The two RPCs must also agree on each writer's data length (`RPC_DISAGREE`).
* `verify --tx`: a page transaction whose single publication is not 68 bytes was already refused (no publication to
  check, `TX_NO_PUBLICATION`); it is now named `TX_PUBLISH_DATA` with its length.

Tests. `33-batch-verifier` R9-CHECK-1 (the real CLI, two RPC stubs, the production build): batch 1 confirmed; batch 2
verified, the owner's transaction never sent; the page's transaction with a 69-byte publication is `TX_PUBLISH_DATA`;
the thief's 69-byte publication of the same number, root, leaf count and window is accepted and writes exactly that
record; `confirm` exits 1 with `warning TX_EXTRA_DATA`, `NOT_YOUR_TRANSACTION` naming both hashes and the paging tail,
never `TX_NOT_FOUND`, "proves nothing" or "retry" (before: `TX_NOT_FOUND`, "retry in a minute"), and nothing becomes a
baseline; the next `verify` gives the stolen-key alarm naming the thief's hash, never "not found" or a suggested
`confirm`, and no transaction. R9-TOOLS-2's crafted block: the inner publication with one byte appended is found with
`dataLength` 69 (before: not found), data one byte short is not, nor another window.

### 104. Bytes after an instruction's arguments: the checker decodes `launch_from_batch` by prefix, as the program does; the four `#[instruction]` prefixes are pinned (4.0, 4.27, 9 I23, 12; review round 10, R10-FRESH-1)

**Spec.** 4.0 described the city-level instructions' `city_id` argument and 4.27 the arguments of `launch_from_batch`;
nothing said what happens to bytes after the arguments. NOTES 103 recorded that the program ignores them (Anchor 0.31's
Borsh `deserialize`) and made the off-chain tools match for `publish_launch_batch` only. The checker's `batchLaunchArgs`
(`tests-curve/invariants.mjs`, used by `checkLaunch` and by the walk of I23 in `checkGlobal`) asserted that the proof
ended exactly at the end of the data ("launch_from_batch data has trailing bytes").

**Issue.** The program accepts `launch_from_batch` with bytes after its proof and launches exactly the coin of its
arguments; the checker then threw in `World.send`, a false failure for a valid transaction (reproduced on the production
build, sha256 `0a5beef2...`: with one 0 byte appended the coin exists afterwards; with `VCURVE_INVARIANTS=off` it is the
coin of the same call without the byte). No on-chain impact: Anchor 0.31 decodes the handler's arguments
(`instruction::<Name>::deserialize(&mut &data[..])`, anchor-syn `codegen/program/handlers.rs`) and the account struct's
`#[instruction(..)]` arguments (`__Args::deserialize(&mut __ix_data)`, `codegen/accounts/try_accounts.rs`) as prefixes
of the same bytes after the discriminator; each of the four attributes (`approve_launch`: `city_id, founder, config_id,
name, symbol`; `launch_from_batch`: `city_id, batch_seq, config_id, name, symbol`; `launch` and `revoke_approval`:
`city_id`) lists exactly the handler's leading parameters, in order and with their types; and no handler stores, hashes
or emits raw instruction data (the batch leaf is rebuilt from the decoded arguments and the signer). But no test sent
these four instructions with bytes appended (only `buyback_burn`, X61, and `publish_launch_batch`, R9-CHECK-1), and no
test compared the attributes with the handlers, so a later reorder or retype of one attribute would have shown up only
indirectly. No SDK, tool or website code decodes `launch_from_batch` data; an indexer modelled on the checker's decoder
would have dropped a genuine launch. Info.

**Choice.** No program change (the binary and the IDL are unchanged; which instruction data the program accepts is not
changed after round 6). `batchLaunchArgs` decodes by prefix, as the program does: it stops after the proof, refuses data
shorter than the arguments (which the program refuses too) and returns the count of bytes after them as `trailing`, which
nothing judges. 4.0 now states the rule: every instruction ignores bytes after its arguments, the four city-level
instructions read their leading arguments a second time in their account structs, and an off-chain reader that
establishes what the program did (the checker, the verifier's `confirm` and alarm, an indexer) decodes by prefix;
`verify --tx`, which checks a transaction before the owner signs it, still refuses a publication that is not exactly
the one it builds (`TX_PUBLISH_DATA`, entry 103).

Tests. `30-batch` R10-FRESH-1, on the production build with the checker on: from one state each call is simulated as
built and then sent with bytes appended, and every account of the message and every event (decoded by the SDK from the
simulation, by the checker from the transaction) must be the same: `approve_launch` with 9 bytes (a u64 naming another
city's pending approval, then the byte 0x01) and with 8 bytes of 0xff; `launch` with a u64 naming the other pending city;
`revoke_approval` with the same u64 (the other city's approval untouched, its coin not created); `launch_from_batch` with
a u64 naming another city of the batch, a u64 naming batch 2 and a 0 byte (the checker's decoder reads the same arguments
and counts 17 bytes after them), and with one 0 byte (the review's case). Before the change the first padded
`launch_from_batch` failed in the checker with "launch_from_batch data has trailing bytes". A second test reads
`lib.rs` and `instructions/*.rs`: the four account structs, and only they, carry `#[instruction(..)]`, each the start of
its handler's parameters; the same check refuses `launch_from_batch`'s attribute with `city_id` and `batch_seq` swapped
and `approve_launch`'s with `config_id` retyped as `u64`.

### 105. One RPC is never silent: `confirm` and `check` warn `ONE_RPC`, and `confirm` keeps nothing on one RPC's word without `--one-rpc-ok` (8.4 step 3, T89, 14.1; review round 10, R10-RPC-1, rejected as a defect and hardened)

**Spec.** 8.4: every RPC the owner's tools read must be one the website does not operate or relay; two are required
on a first use (`verify` with `--previous` / `--in-force`, review R7-4), and whenever two are given they must be of
different providers and agree on everything read (reviews R8-DIFF-1 to R8-DIFF-4). One RPC is otherwise allowed.
`verify` warned (`warning ONE_RPC`) when it read one RPC once a batch was stored; `confirm` and `check` said nothing.

**Issue.** One RPC alone serves every account, the clock and the block `confirm` and `check` judge. A lying one can
make a refused list look confirmed: the owner verifies list X and refuses it; a thief with the approver key publishes X
with the verified window from his own transaction (another message); the RPC serves the block of the record's
`published_slot` with the owner's verified message, which he never signed, in place of the thief's. `confirm 2 <root of
X> --rpc <that RPC>` found the stored record equal to the pending list and the transaction equal to the verified one,
said "confirmed" and kept X in `signed/` as the next day's baseline, so the stolen-key alarm (R8-DIFF-2,
`NOT_YOUR_TRANSACTION`) never sounded and the attacker's entry vanished from the following days' changes. It can also
hide a bad batch from the monitor: serving the root and leaf count of the list `check` expects, `check` said "the
stored batch is the list". Reported as R10-RPC-1. **Rejected as a defect**: the design allows one RPC, the owner
chooses it, and a second RPC of another provider defeats both cases (`RPC_DISAGREE`). Info.

**Choice.** Hardened anyway, being cheap, with no program change (the binary and the IDL are unchanged), in
`scripts/vcurve/batch.mjs` only:
* `confirm` and `check` print, whenever only one `--rpc` is given, `warning ONE_RPC: only one --rpc was given: a
  single RPC can make a refused list look confirmed or hide a bad batch (it alone serves every account, the clock and
  the block this run judges); two RPCs from different providers that the website does not operate (--rpc twice) are
  required for the stolen-key alarm and the monitor to mean anything`, and for `confirm` `; on one RPC's word confirm
  keeps nothing in signed/ unless you pass --one-rpc-ok` (`oneRpcWarning`). `confirm` prints it right after the lines
  that name the archive, `check` before it reads the chain, so it is printed whatever the outcome.
* `confirm` on one RPC runs every check as before and reports every problem as before (`NOT_YOUR_TRANSACTION`, `ROOT`,
  `WINDOW` and the rest, with the same tails); but when every check passes it keeps nothing: `PROBLEM ONE_RPC: batch N
  ... matches the list you verified, written by the transaction you verified (message hash ...), on the one RPC read
  only, which alone could have served that block and that record: it is not kept in signed/ and stays in pending/`,
  then `1 problem(s): run confirm again with --rpc twice, two providers the website does not operate; or, accepting one
  RPC's word knowingly, add --one-rpc-ok`, exit 1. The pending list stays where it is and no other list is moved to
  `refused/`. A record already confirmed (`already confirmed`) is unaffected: nothing is written.
* `--one-rpc-ok` (confirm only; `verify` and `check` refuse it, and `confirm` refuses it with two RPCs, so it cannot be
  left on as a habit that does nothing until the day one RPC is given) keeps the list on one RPC's word; the
  confirmation line then ends `(on one RPC's word: --one-rpc-ok)`. The archive entry is the same as before (no new
  field).
* `check` keeps its verdicts and exit codes; a success on one RPC reads `the stored batch is the list on one RPC's word
  (see warning ONE_RPC)`.
* `verify`'s last line now suggests `confirm <seq> <root> --rpc <url> --rpc <url of another provider>`. `verify`'s own
  one-RPC rules are unchanged.

Tests. `33-batch-verifier` R10-RPC-1 (the real CLI, two honest RPC stubs of different hosts and a liar, the production
build): batch 1 verified through two RPCs and signed as printed; `confirm` through one honest RPC gives the warning and
`PROBLEM ONE_RPC`, exit 1, `signed/` empty and the list still pending (with the gate removed: "confirmed", exit 0);
through two RPCs it is confirmed with no warning. Batch 2: the owner verifies X (with the attacker's city) and refuses
it; the thief publishes X with the verified window; the liar serves the publication's block with the verified,
unsigned message: on the liar alone every check passes and `PROBLEM ONE_RPC` keeps X out of `signed/` (before:
confirmed); the liar with an honest RPC is `RPC_DISAGREE`; two honest RPCs give `NOT_YOUR_TRANSACTION` and the paging
tail; one honest RPC gives the same alarm under the warning. `check` of the expected list G: one honest RPC `ROOT` and
`LEAF_COUNT` with the warning (no `--one-rpc-ok` offered); the liar alone serving G's root and leaf count exit 0 "on one
RPC's word" with the warning; the liar with an honest RPC `RPC_DISAGREE`. `--one-rpc-ok` on the liar alone keeps X:
the residual the option accepts, knowingly. `parseArgs`: `--one-rpc-ok` with two RPCs, or for `check` or `verify`, is a
usage error (`confirm` with two RPCs and the option exits 2 through the CLI). The existing tests that confirm through one RPC (rounds 6 to 8) pass
`--one-rpc-ok`; their subjects are unchanged.
