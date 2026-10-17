# `vicinity_curve`: implementation notes for the auditors

Companion to `VICINITY-CURVE-DESIGN.md` (revision 2, commit ee62c31). The specification is
authoritative. Each entry below records one place where the build had to clarify the
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
`sdk/idl/vicinity_curve.json` (21 instructions, 6 accounts, 21 events, 51 errors, every
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
  codes and the compiled ids of the default build.

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
  through LiteSVM directly.
