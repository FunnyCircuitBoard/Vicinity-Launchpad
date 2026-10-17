//! G01 (VICINITY-CURVE-DESIGN.md 12.5): golden vectors exported by the Rust
//! crate for the JavaScript port (`sdk/curve/g01.test.mjs`) and the program
//! itself (`tests-curve/22-g01-onchain.test.mjs`, which replays every
//! operation on chain), so that all three agree to the lamport on more than
//! 10^4 random trades, graduating buys, partial fills, pool trades with drips
//! and buyback runs included.
//!
//! `reference/g01-vectors.json` is generated here from a fixed seed: coin
//! lives on default config #0, on random shares over the default curve and on
//! random curves found by 5.9's search, each launched at a fixed slot, with
//! random buys (from the minimum and below up to the completing buy and past
//! it), sells of random parts of four holders' coins (dust included), buyback
//! runs at random slots and the three payouts. Every operation is one line:
//!
//! ```text
//! B holder sol_in charged net tokens fee liq liq_floor platform founder holders buyback drip partial graduates digest
//! B holder sol_in E error
//! S holder tokens_in gross sol_out fee liq liq_floor platform founder holders buyback drip digest
//! S holder tokens_in E error
//! K slot spent coins cap digest          (a buyback run)
//! K slot N                               (the crank did nothing)
//! P which amount digest                  (0 withdraw, 1 founder claim, 2 forward)
//! ```
//!
//! where `digest` is the FNV-1a 64-bit hash (16 hex digits) of the 24 state
//! fields after the operation, in `State` order, as decimal numbers joined by
//! commas. Each life also records its final state in full.
//!
//! This test regenerates the vectors and requires them to equal the committed
//! file byte for byte; `G01_WRITE=1 cargo test -p vicinity-curve-math --test
//! g01_vectors` rewrites the file after an intended change.

mod common;

use common::*;
use serde_json::{json, Value};
use vicinity_curve_math::constants::*;
use vicinity_curve_math::*;

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/reference/g01-vectors.json");
/// Successful trades and buyback runs to generate, at least.
const TRADES: usize = 10_000;
/// The slot life `i` is launched at: `FIRST_SLOT + i * LIFE_SLOTS`.
const FIRST_SLOT: u64 = 1_000;
const LIFE_SLOTS: u64 = 10_000_000;

/// splitmix64, a fixed seed: the same vectors on every machine.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// A log-uniform amount between 10^lo and 10^hi.
    fn log(&mut self, lo: f64, hi: f64) -> u64 {
        let u = (self.next() >> 11) as f64 / (1u64 << 53) as f64;
        10f64.powf(lo + (hi - lo) * u) as u64
    }
}

/// The 24 state fields in `State` order (the JavaScript port's STATE_KEYS).
pub fn state_fields(st: &State) -> [u128; 24] {
    [
        st.phase.as_u8() as u128,
        st.tokens_sold as u128,
        st.curve_sol as u128,
        st.pool_sol as u128,
        st.pool_tokens as u128,
        st.liquidity_pending as u128,
        st.platform_pending as u128,
        st.founder_pending as u128,
        st.holders_pending as u128,
        st.buyback_pending as u128,
        st.last_buyback_slot as u128,
        st.trade_seq as u128,
        st.buyback_count as u128,
        st.tokens_burned as u128,
        st.buy_volume,
        st.sell_volume,
        st.fees_total,
        st.liquidity_earned,
        st.liquidity_added,
        st.platform_earned,
        st.founder_earned,
        st.holders_earned,
        st.buyback_earned,
        st.buyback_spent,
    ]
}

/// FNV-1a 64 of the state fields as decimal numbers joined by commas.
fn digest(st: &State) -> String {
    let text = state_fields(st)
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn err(e: MathError) -> &'static str {
    match e {
        MathError::TradeTooSmall => "TradeTooSmall",
        MathError::ZeroAmount => "ZeroAmount",
        MathError::ZeroOutput => "ZeroOutput",
        MathError::SellExceedsCurve => "SellExceedsCurve",
        other => panic!("an operation of the generator failed with {other:?}"),
    }
}

fn split(s: &FeeSplit) -> String {
    format!(
        "{} {} {} {} {} {} {}",
        s.fee, s.liquidity, s.liquidity_floor, s.platform, s.founder, s.holders, s.buyback
    )
}

/// A valid config for life `i`: config #0, random shares on its curve, or a
/// random curve found by 5.9's search with random shares.
fn config_for(i: usize, rng: &mut Rng) -> ConfigParams {
    let bps = |rng: &mut Rng| {
        [
            rng.below(121) as u16,
            rng.below(121) as u16,
            rng.below(101) as u16,
            rng.below(121) as u16,
            rng.below(61) as u16,
        ]
    };
    match i % 4 {
        0 => ConfigParams::DEFAULT,
        1 => loop {
            let c = with_bps(bps(rng));
            if validate_config(&c).is_ok() {
                break c;
            }
        },
        _ => loop {
            let dust = match rng.below(3) {
                0 => 0,
                1 => 9_100_000,
                _ => rng.below(MAX_DUST_RAW + 1),
            };
            let p = 10_000_000_000_000 + rng.below(440_000_000_000_000);
            let r = rng
                .log(9.0, 13.0)
                .clamp(MIN_GRADUATION_LAMPORTS, MAX_GRADUATION_LAMPORTS);
            if let Some(c) = derived(bps(rng), dust, p, r) {
                break c;
            }
        },
    }
}

fn generate() -> Value {
    let mut rng = Rng(0x6010_7EC7_0125_0001);
    let mut lives = Vec::new();
    let (mut trades, mut graduations, mut partials, mut runs, mut pool_trades) =
        (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut i = 0usize;
    while trades < TRADES {
        let p = config_for(i, &mut rng);
        let t = Terms::from_params(&p).unwrap();
        let launch = FIRST_SLOT + i as u64 * LIFE_SLOTS;
        let mut m = Sim::launch(t, launch);
        m.slot = launch;
        let mut held = [0u64; 4];
        let mut ops: Vec<String> = Vec::new();
        let n_ops = 150 + rng.below(250) as usize;
        // how fast this life trades: the largest ordinary buy is R / 10^pace (some lives never graduate)
        let pace = 0.8 + (rng.below(1600) as f64) / 1000.0;
        // every third life stays on the curve: its buys stop short of the completing one
        let stays = i % 3 == 2;
        for _ in 0..n_ops {
            let roll = rng.below(100);
            let op = if roll < 45 {
                // a buy: dust and below the minimum, ordinary sizes, the completing buy and past it
                let h = rng.below(4) as usize;
                let g = match rng.below(40) {
                    0 | 1 => rng.below(MIN_TRADE_LAMPORTS + 1),
                    2 if m.st.phase == Phase::Curve => {
                        let q = max_quote_in(&t, &m.st).unwrap();
                        if rng.below(2) == 0 {
                            q
                        } else {
                            q + rng.below(q / 2 + 1)
                        }
                    }
                    3 if m.st.phase == Phase::Curve => {
                        let q = max_quote_in(&t, &m.st).unwrap();
                        q.saturating_sub(rng.below(1000)).max(MIN_TRADE_LAMPORTS)
                    }
                    _ => rng.log(5.0, (t.graduation_sol as f64).log10() - pace),
                };
                let g = if stays && m.st.phase == Phase::Curve {
                    g.min(max_quote_in(&t, &m.st).unwrap() - 1)
                } else {
                    g
                };
                let phase = m.st.phase;
                match m.buy(g) {
                    Ok(q) => {
                        held[h] += q.tokens_out;
                        trades += 1;
                        graduations += q.graduates as usize;
                        partials += q.partial as usize;
                        pool_trades += (phase == Phase::Pool) as usize;
                        format!(
                            "B {h} {g} {} {} {} {} {} {} {} {}",
                            q.charged,
                            q.net,
                            q.tokens_out,
                            split(&q.split),
                            q.drip,
                            q.partial as u8,
                            q.graduates as u8,
                            digest(&m.st)
                        )
                    }
                    Err(e) => format!("B {h} {g} E {}", err(e)),
                }
            } else if roll < 80 {
                // a sell of a part of one holder's coins (dust now and then)
                let h = rng.below(4) as usize;
                if held[h] == 0 {
                    continue;
                }
                let tk = match rng.below(10) {
                    0 => 1 + rng.below(held[h].min(5_000)),
                    1 => held[h],
                    _ => ((held[h] as u128 * (1 + rng.below(1000)) as u128) / 1000).max(1) as u64,
                };
                let phase = m.st.phase;
                match m.sell(tk) {
                    Ok(q) => {
                        held[h] -= tk;
                        trades += 1;
                        pool_trades += (phase == Phase::Pool) as usize;
                        format!(
                            "S {h} {tk} {} {} {} {} {}",
                            q.gross,
                            q.sol_out,
                            split(&q.split),
                            q.drip,
                            digest(&m.st)
                        )
                    }
                    Err(e) => format!("S {h} {tk} E {}", err(e)),
                }
            } else if roll < 95 {
                // the buyback crank after a random wait (often exactly the interval)
                m.slot += match rng.below(4) {
                    0 => BUYBACK_INTERVAL_SLOTS,
                    1 => BUYBACK_INTERVAL_SLOTS - 1,
                    _ => rng.below(600),
                };
                match m.buyback().unwrap() {
                    Some(q) => {
                        trades += 1;
                        runs += 1;
                        format!(
                            "K {} {} {} {} {}",
                            m.slot,
                            q.spent,
                            q.coins,
                            q.cap,
                            digest(&m.st)
                        )
                    }
                    None => format!("K {} N", m.slot),
                }
            } else {
                let w = rng.below(3) as u8;
                let a = m.pay(w);
                format!("P {w} {a} {}", digest(&m.st))
            };
            m.check();
            ops.push(op);
        }
        lives.push(json!({
            "config": {
                "bps": [p.liquidity_bps, p.platform_bps, p.founder_bps, p.holders_bps, p.buyback_bps],
                "x0": p.virtual_sol.to_string(), "y0": p.virtual_tokens.to_string(), "S": p.curve_supply.to_string(),
                "P": p.pool_supply.to_string(), "R": p.graduation_sol.to_string(), "fee": p.launch_fee_lamports.to_string(),
            },
            "launch_slot": launch.to_string(),
            "ops": ops,
            "final": state_fields(&m.st).iter().map(|v| v.to_string()).collect::<Vec<_>>(),
        }));
        i += 1;
    }
    assert!(graduations >= 10 && partials >= 5 && runs >= 500 && pool_trades >= 1_000,
        "the vectors must cover graduations ({graduations}), partial fills ({partials}), buybacks ({runs}) and pool trades ({pool_trades})");
    json!({
        "about": "G01 golden vectors exported by crates/vicinity-curve-math/tests/g01_vectors.rs (VICINITY-CURVE-DESIGN.md 12.5); regenerate with G01_WRITE=1",
        "trades": trades,
        "graduations": graduations,
        "partial_fills": partials,
        "buyback_runs": runs,
        "pool_trades": pool_trades,
        "lives": lives,
    })
}

#[test]
fn g01_golden_vectors_are_the_committed_file() {
    let text = serde_json::to_string_pretty(&generate()).unwrap() + "\n";
    if std::env::var("G01_WRITE").is_ok() {
        std::fs::write(PATH, &text).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(PATH)
        .expect("reference/g01-vectors.json (generate it with G01_WRITE=1)");
    assert!(committed == text, "reference/g01-vectors.json differs from what the crate computes: an intended change needs G01_WRITE=1 cargo test -p vicinity-curve-math --test g01_vectors");
}
