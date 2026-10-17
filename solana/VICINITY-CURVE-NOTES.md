# `vicinity_curve`: implementation notes for the auditors

Companion to `VICINITY-CURVE-DESIGN.md`, revision 3 (entries 1 to 41 were written against
revision 2, commit ee62c31; revision 3 folds every entry in, and its Appendix C says where;
entries 42 to 48 answer review round 1 of the build, entry 49 onwards review round 2). The
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
