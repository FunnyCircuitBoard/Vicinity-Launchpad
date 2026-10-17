//! I18 "no free value" (VICINITY-CURVE-DESIGN.md 9, 12.2), second clause:
//! "no address ends a random sequence with more SOL plus coins valued at the
//! final spot price than it started with, net of donations it received".
//!
//! The clause cannot hold as worded for any constant-product market: a
//! position marked at the marginal price right after the trade that bought it
//! is worth more than was paid for it (the convexity term `n^2 / X`), and a
//! net seller's coins are worth less at the price its own sell pushed down.
//! `literal_spot_valuation_is_not_a_property` keeps the counterexample. With
//! several traders an early buyer also gains, legitimately, from later buyers.
//! What is tested instead (VICINITY-CURVE-NOTES.md, the entry on I18) is free
//! value in the two senses in which it can exist, with the coins an address
//! still holds valued at what they sell for at the final state (which is at
//! most their spot value less the fee):
//!
//! * P11a, one address alone: from any reachable state (a random prefix of
//!   other traders' operations, injected set-aside liquidity included, then the
//!   buyback backlog run down so that no backlog of others can flow to it), an
//!   address that comes with SOL only runs a random sequence of buys (partial
//!   fills and graduation included), sells, pool trades with drips and buyback
//!   runs; it never ends with more than it came with. No allowance: the fee's
//!   rounding in the trader's favour (under one lamport per trade) never
//!   outweighs the shares it pays and cannot recover.
//! * P11b, all addresses together: from launch, four addresses (the first is
//!   the founder) buy, sell, run buybacks and collect payouts in random order;
//!   then each sells everything it holds. Together they never end with more
//!   than they came with, net of the founder fees the founder received.
//!
//! CI runs 2,048 cases each; `PROPTEST_CASES=1000000 cargo test --release -p
//! vicinity-curve-math --test no_free_value` is the spec's 10^6.

mod common;

use common::*;
use proptest::prelude::*;
use vicinity_curve_math::constants::*;
use vicinity_curve_math::*;

/// An operation of the other traders in the prefix.
#[derive(Clone, Debug)]
enum Other {
    Buy(u64),
    Sell(u16),
    Buyback(u64),
    Pay(u8),
    InjectLiquidity(u64),
}

fn amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        1 => 100_000u64..1_000_000,
        8 => (500u32..1250).prop_map(|e| 10f64.powf(e as f64 / 100.0) as u64),
    ]
}

fn other() -> impl Strategy<Value = Other> {
    prop_oneof![
        6 => amount().prop_map(Other::Buy),
        4 => (1u16..=1000).prop_map(Other::Sell),
        2 => prop_oneof![Just(150u64), 0u64..400].prop_map(Other::Buyback),
        1 => (0u8..3).prop_map(Other::Pay),
        1 => (1_000_000u64..300_000_000_000).prop_map(Other::InjectLiquidity),
    ]
}

/// A reachable state: a random prefix of other traders' operations, then the
/// buyback backlog spent (one run per interval) until it is empty or the crank
/// is a no-op. Returns the state and whether buyback runs are allowed in the
/// address's sequence (only when no backlog of others is left to flow to it).
fn prefix(t: Terms, ops: &[Other]) -> (Sim, bool) {
    let mut m = Sim::launch(t, 0);
    let mut held = 0u64;
    for o in ops {
        match *o {
            Other::Buy(g) => {
                if let Ok(q) = m.buy(g) {
                    held += q.tokens_out;
                }
            }
            Other::Sell(f) => {
                let tk = (held as u128 * f as u128 / 1000) as u64;
                if tk > 0 && m.sell(tk).is_ok() {
                    held -= tk;
                }
            }
            Other::Buyback(dt) => {
                m.slot += dt;
                m.buyback().unwrap();
            }
            Other::Pay(w) => {
                m.pay(w);
            }
            Other::InjectLiquidity(x) => m.inject_liquidity(x),
        }
        m.check();
    }
    for _ in 0..5_000 {
        if m.st.buyback_pending == 0 {
            break;
        }
        m.slot += BUYBACK_INTERVAL_SLOTS;
        if m.buyback().unwrap().is_none() {
            break;
        }
    }
    let drained = m.st.buyback_pending == 0;
    (m, drained)
}

/// An operation of the address under test.
#[derive(Clone, Debug)]
enum Mine {
    Buy(u64),
    /// `max_quote_in` on the curve: the buy that completes it.
    BuyToGraduation,
    /// Sell a fraction (per mille) of its coins.
    Sell(u16),
    /// Sell a few raw units.
    SellDust(u64),
    /// Advance the slot by the interval and run the buyback crank.
    Buyback,
}

fn mine() -> impl Strategy<Value = Mine> {
    prop_oneof![
        6 => amount().prop_map(Mine::Buy),
        1 => Just(Mine::BuyToGraduation),
        5 => (1u16..=1000).prop_map(Mine::Sell),
        1 => (1u64..5_000).prop_map(Mine::SellDust),
        2 => Just(Mine::Buyback),
    ]
}

/// What `coins` sell for at the current state (0 when the sell would deliver
/// nothing): the value of a position at the final state.
fn liquidation(m: &Sim, coins: u64) -> u128 {
    if coins == 0 {
        return 0;
    }
    match quote_sell(&m.t, &m.st, coins) {
        Ok(q) => q.sol_out as u128,
        Err(MathError::ZeroOutput) => 0,
        Err(e) => panic!("liquidation of {coins}: {e:?}"),
    }
}

/// Runs the address's sequence alone from `m0`; returns `(paid, received,
/// liquidation, trades)`.
fn lone(m0: &Sim, ops: &[Mine], buybacks: bool) -> (u128, u128, u128, u32) {
    let mut m = m0.clone();
    let (mut paid, mut got, mut coins, mut trades) = (0u128, 0u128, 0u64, 0u32);
    for o in ops {
        match *o {
            Mine::Buy(g) => match m.buy(g) {
                Ok(q) => {
                    paid += q.charged as u128;
                    coins += q.tokens_out;
                    trades += 1;
                }
                Err(e) => assert!(
                    matches!(e, MathError::ZeroOutput | MathError::TradeTooSmall),
                    "buy {g}: {e:?}"
                ),
            },
            Mine::BuyToGraduation => {
                if m.st.phase == Phase::Curve {
                    let g = max_quote_in(&m.t, &m.st).unwrap();
                    let q = m.buy(g).unwrap();
                    assert!(q.graduates);
                    paid += q.charged as u128;
                    coins += q.tokens_out;
                    trades += 1;
                }
            }
            Mine::Sell(f) => {
                let tk = (coins as u128 * f as u128 / 1000) as u64;
                if tk > 0 {
                    match m.sell(tk) {
                        Ok(q) => {
                            got += q.sol_out as u128;
                            coins -= tk;
                            trades += 1;
                        }
                        Err(e) => assert_eq!(e, MathError::ZeroOutput),
                    }
                }
            }
            Mine::SellDust(tk) => {
                if tk <= coins {
                    match m.sell(tk) {
                        Ok(q) => {
                            got += q.sol_out as u128;
                            coins -= tk;
                            trades += 1;
                        }
                        Err(e) => assert_eq!(e, MathError::ZeroOutput),
                    }
                }
            }
            Mine::Buyback => {
                if buybacks {
                    m.slot += BUYBACK_INTERVAL_SLOTS;
                    m.buyback().unwrap();
                }
            }
        }
        m.check();
    }
    let end = liquidation(&m, coins);
    (paid, got, end, trades)
}

/// An operation of P11b: `(address, op)`, or a payout.
#[derive(Clone, Debug)]
enum Group {
    Buy(u8, u64),
    Sell(u8, u16),
    Buyback(u64),
    /// 0 withdraw (to FEE_RECIPIENT), 1 founder claim (to address 0), 2 forward (to the rewards vault).
    Pay(u8),
}

fn group() -> impl Strategy<Value = Group> {
    prop_oneof![
        6 => (0u8..4, amount()).prop_map(|(u, g)| Group::Buy(u, g)),
        5 => (0u8..4, 1u16..=1000).prop_map(|(u, f)| Group::Sell(u, f)),
        2 => prop_oneof![Just(150u64), 0u64..400].prop_map(Group::Buyback),
        1 => (0u8..3).prop_map(Group::Pay),
    ]
}

proptest! {
    #![proptest_config(config(2048))]

    /// P11a (I18): one address alone, from any reachable state, with SOL only:
    /// paid >= received + what its coins sell for at the end.
    #[test]
    fn p11a_lone_address_gains_nothing(
        p in valid_config(),
        others in prop::collection::vec(other(), 0..14),
        ops in prop::collection::vec(mine(), 1..40),
    ) {
        let (m0, drained) = prefix(terms(&p), &others);
        let (paid, got, end, trades) = lone(&m0, &ops, drained);
        prop_assert!(got + end <= paid,
            "free value: paid {} got {} + {} at the end in {} trades ({:?} -> {:?})", paid, got, end, trades, m0.st.phase, ops);
    }

    /// P11b (I18): all addresses together from launch, every coin sold back at
    /// the end: they never end with more than they came with, net of the
    /// founder fees the founder received.
    #[test]
    fn p11b_all_addresses_gain_nothing(p in valid_config(), ops in prop::collection::vec(group(), 1..80)) {
        let t = terms(&p);
        let mut m = Sim::launch(t, 0);
        let mut coins = [0u64; 4];
        let (mut paid, mut got, mut founder_received) = (0u128, 0u128, 0u128);
        for o in &ops {
            match *o {
                Group::Buy(u, g) => {
                    if let Ok(q) = m.buy(g) {
                        paid += q.charged as u128;
                        coins[u as usize] += q.tokens_out;
                    }
                }
                Group::Sell(u, f) => {
                    let tk = (coins[u as usize] as u128 * f as u128 / 1000) as u64;
                    if tk > 0 {
                        if let Ok(q) = m.sell(tk) {
                            got += q.sol_out as u128;
                            coins[u as usize] -= tk;
                        }
                    }
                }
                Group::Buyback(dt) => {
                    m.slot += dt;
                    m.buyback().unwrap();
                }
                Group::Pay(w) => {
                    let a = m.pay(w);
                    if w == 1 { founder_received += a as u128; }
                }
            }
            m.check();
        }
        for c in coins.iter_mut() {
            if *c > 0 {
                if let Ok(q) = m.sell(*c) { got += q.sol_out as u128; *c = 0; }
            }
        }
        m.check();
        prop_assert!(got <= paid + founder_received, "together: paid {} got {} (founder received {})", paid, got, founder_received);
        // and with the founder's fees counted as his: still no more than all paid
        prop_assert!(got - founder_received.min(got) <= paid);
    }
}

/// The literal reading of I18's second clause is false for any constant
/// product market, so it is not asserted: on default config #0 a single 1 SOL
/// buy from launch is worth more than 1 SOL at the spot price it leaves
/// behind (E1's 33,774,693.369781 coins at `(x0 + r) / (y0 - s)`), while
/// selling them returns 950,625,000 lamports (E2).
#[test]
fn literal_spot_valuation_is_not_a_property() {
    let t = Terms::DEFAULT;
    let st = State::at_launch(0);
    let q = quote_buy(&t, &st, 1_000_000_000).unwrap();
    assert_eq!(q.tokens_out, 33_774_693_369_781);
    let (vs, vt) = spot_price(&t, &q.new_state).unwrap();
    let marked = q.tokens_out as u128 * vs as u128 / vt as u128;
    assert!(marked > q.charged as u128, "marked {marked}");
    assert_eq!(
        marked, 1_006_686_598,
        "1.0067 SOL at the final spot price for 1 SOL paid"
    );
    let back = quote_sell(&t, &q.new_state, q.tokens_out).unwrap();
    assert_eq!(back.sol_out, 950_625_000);
    // a net seller is valued below what it received at the price its own sell leaves
    let (vs2, vt2) = spot_price(&t, &back.new_state).unwrap();
    let start_marked = q.tokens_out as u128 * vs2 as u128 / vt2 as u128;
    assert!((back.sol_out as u128) > start_marked);
}
