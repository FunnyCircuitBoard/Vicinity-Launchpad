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
