//! Differential test against the reference model of Appendix A: replays
//! `reference/vectors.json` (written by `reference/generate_vectors.py` from the
//! verbatim `reference/model.py`) and requires exact equality of every quote,
//! every error and every state field after every operation.

use serde_json::Value;
use vicinity_curve_math::constants::*;
use vicinity_curve_math::*;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/reference/vectors.json");
    let text = std::fs::read_to_string(path).expect("reference/vectors.json");
    serde_json::from_str(&text).expect("valid JSON")
}

fn n(v: &Value) -> u128 {
    v.as_u64()
        .map(u128::from)
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or_else(|| panic!("not an unsigned integer: {v}"))
}

fn n64(v: &Value) -> u64 {
    u64::try_from(n(v)).expect("u64")
}

fn config(c: &Value) -> ConfigParams {
    let bps: Vec<u16> = c["bps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| n(b) as u16)
        .collect();
    ConfigParams {
        liquidity_bps: bps[0],
        platform_bps: bps[1],
        founder_bps: bps[2],
        holders_bps: bps[3],
        buyback_bps: bps[4],
        virtual_sol: n64(&c["x0"]),
        virtual_tokens: n64(&c["y0"]),
        curve_supply: n64(&c["S"]),
        pool_supply: n64(&c["P"]),
        graduation_sol: n64(&c["R"]),
        launch_fee_lamports: c.get("fee").map(n64).unwrap_or(0),
    }
}

fn err_name(e: MathError) -> &'static str {
    match e {
        MathError::TradeTooSmall => "TradeTooSmall",
        MathError::ZeroAmount => "ZeroAmount",
        MathError::ZeroOutput => "ZeroOutput",
        MathError::SellExceedsCurve => "SellExceedsCurve",
        MathError::WrongPhase => "WrongPhase",
        other => panic!("the model never produces {other:?}"),
    }
}

fn rule_name(e: ConfigError) -> &'static str {
    match e {
        ConfigError::FeeTotal => "V1",
        ConfigError::FeeShareCap => "V2",
        ConfigError::Supply => "V3",
        ConfigError::CurveBounds => "V4",
        ConfigError::Graduation => "V5",
        ConfigError::Absorption => "V6",
        ConfigError::Continuity => "V7",
        ConfigError::BuybackMev => "V8",
        ConfigError::LaunchFee => "V9",
        ConfigError::DripFarmable => "V10",
        ConfigError::BuybackHorizon => "V11",
    }
}

/// The state array of the vectors, in `state_fields` order.
fn state_row(st: &State, vault: u64) -> Vec<u128> {
    vec![
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
        liabilities(st).unwrap() as u128,
        vault as u128,
    ]
}

fn split_row(s: &FeeSplit) -> Vec<u128> {
    [
        s.fee,
        s.liquidity,
        s.liquidity_floor,
        s.platform,
        s.founder,
        s.holders,
        s.buyback,
    ]
    .iter()
    .map(|&x| x as u128)
    .collect()
}

fn nums(v: &Value) -> Vec<u128> {
    v.as_array().unwrap().iter().map(n).collect()
}

#[test]
fn layout_of_the_vector_file() {
    let v = vectors();
    let fields: Vec<&str> = v["state_fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    assert_eq!(fields.len(), 26);
    assert_eq!(fields[0], "phase");
    assert_eq!(fields[23], "buyback_spent");
    assert_eq!(fields[24..], ["liabilities", "vault"]);
    let disc = nums(&v["discriminators"]["CurveCoin"]);
    assert_eq!(
        disc,
        CURVE_COIN_DISCRIMINATOR
            .iter()
            .map(|&b| b as u128)
            .collect::<Vec<_>>()
    );
}

#[test]
fn lives_replay_exactly() {
    let v = vectors();
    let mut ops = 0usize;
    let mut kinds = std::collections::BTreeMap::<String, usize>::new();
    for (li, life) in v["lives"].as_array().unwrap().iter().enumerate() {
        let p = config(&life["config"]);
        validate_config(&p).expect("every life config passes V1 to V11");
        let t = Terms::from_params(&p).unwrap();
        let mut st = State::at_launch(n64(&life["launch_slot"]));
        let mut vault = t.curve_supply + t.pool_supply;
        for (oi, op) in life["ops"].as_array().unwrap().iter().enumerate() {
            let a = op.as_array().unwrap();
            let (name, arg, res, want) = (a[0].as_str().unwrap(), &a[1], &a[2], nums(&a[3]));
            let ctx = format!("life {li} op {oi} {name} {arg}");
            let mut kind = name.to_string();
            match name {
                "buy" => match quote_buy(&t, &st, n64(arg)) {
                    Ok(q) => {
                        let got = vec![
                            q.charged as u128,
                            q.net as u128,
                            q.tokens_out as u128,
                            q.split.fee as u128,
                            q.split.liquidity as u128,
                            q.split.liquidity_floor as u128,
                            q.split.platform as u128,
                            q.split.founder as u128,
                            q.split.holders as u128,
                            q.split.buyback as u128,
                            q.drip as u128,
                            q.partial as u128,
                            q.graduates as u128,
                        ];
                        assert_eq!(got, nums(res), "{ctx}");
                        if q.graduates {
                            kind.push_str(if q.partial {
                                ":graduates:partial"
                            } else {
                                ":graduates"
                            });
                        }
                        st = q.new_state;
                        vault -= q.tokens_out;
                    }
                    Err(e) => {
                        assert_eq!(Some(err_name(e)), res.as_str(), "{ctx}");
                        kind = format!("{name}:{}", err_name(e));
                    }
                },
                "sell" => match quote_sell(&t, &st, n64(arg)) {
                    Ok(q) => {
                        let mut got = vec![q.gross as u128, q.sol_out as u128];
                        got.extend(split_row(&q.split));
                        got.push(q.drip as u128);
                        assert_eq!(got, nums(res), "{ctx}");
                        st = q.new_state;
                        vault += n64(arg);
                    }
                    Err(e) => {
                        assert_eq!(Some(err_name(e)), res.as_str(), "{ctx}");
                        kind = format!("{name}:{}", err_name(e));
                    }
                },
                "buyback" => match quote_buyback(&t, &st, n64(arg)).unwrap() {
                    Some(q) => {
                        assert_eq!(
                            vec![q.spent as u128, q.coins as u128, q.cap as u128],
                            nums(res),
                            "{ctx}"
                        );
                        st = q.new_state;
                        vault -= q.coins;
                    }
                    None => {
                        assert!(
                            res.is_null(),
                            "{ctx}: model ran a buyback, the crate did not"
                        );
                        kind.push_str(":noop");
                    }
                },
                "pay_plat" | "pay_fdr" | "pay_hld" => {
                    let bucket = match name {
                        "pay_plat" => &mut st.platform_pending,
                        "pay_fdr" => &mut st.founder_pending,
                        _ => &mut st.holders_pending,
                    };
                    assert_eq!(*bucket as u128, n(res), "{ctx}");
                    *bucket = 0;
                }
                "inject_bb" => {
                    let x = n64(arg);
                    st.buyback_pending += x;
                    st.buyback_earned += x as u128;
                    st.fees_total += x as u128;
                }
                "inject_liq" => {
                    let x = n64(arg);
                    st.liquidity_pending += x;
                    st.liquidity_earned += x as u128;
                    st.fees_total += x as u128;
                }
                "max_quote_in" => match max_quote_in(&t, &st) {
                    Ok(g) => assert_eq!(g as u128, n(res), "{ctx}"),
                    Err(e) => assert_eq!(Some(err_name(e)), res.as_str(), "{ctx}"),
                },
                other => panic!("unknown op {other}"),
            }
            assert_eq!(
                state_row(&st, vault),
                want,
                "{ctx}: state after the operation"
            );
            ops += 1;
            *kinds.entry(kind).or_default() += 1;
        }
    }
    assert!(ops >= 5_000, "at least 5,000 operations, got {ops}");
    for k in [
        "buy",
        "sell",
        "buyback",
        "buy:graduates:partial",
        "buyback:noop",
        "buy:TradeTooSmall",
        "sell:ZeroOutput",
        "sell:SellExceedsCurve",
        "sell:ZeroAmount",
        "max_quote_in",
    ] {
        assert!(
            kinds.get(k).copied().unwrap_or(0) > 0,
            "no {k} in the vectors"
        );
    }
    println!("replayed {ops} operations: {kinds:?}");
}

#[test]
fn fee_split_vectors() {
    let v = vectors();
    for e in v["fee_split"].as_array().unwrap() {
        let bps: Vec<u16> = e["bps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| n(b) as u16)
            .collect();
        let t = Terms {
            liquidity_bps: bps[0],
            platform_bps: bps[1],
            founder_bps: bps[2],
            holders_bps: bps[3],
            buyback_bps: bps[4],
            total_fee_bps: bps.iter().sum(),
            ..Terms::DEFAULT
        };
        let s = fee_split(&t, n64(&e["amount"])).unwrap();
        assert_eq!(split_row(&s), nums(&e["split"]), "{e}");
    }
}

#[test]
fn gross_for_vectors() {
    let v = vectors();
    for e in v["gross_for"].as_array().unwrap() {
        let tt = n(&e["t"]) as u16;
        let t = Terms {
            liquidity_bps: tt,
            platform_bps: 0,
            founder_bps: 0,
            holders_bps: 0,
            buyback_bps: 0,
            total_fee_bps: tt,
            ..Terms::DEFAULT
        };
        match e["gross"].is_null() {
            true => assert_eq!(
                gross_for(&t, n64(&e["net"])),
                Err(MathError::Overflow),
                "{e}"
            ),
            false => assert_eq!(
                gross_for(&t, n64(&e["net"])).unwrap() as u128,
                n(&e["gross"]),
                "{e}"
            ),
        }
    }
}

#[test]
fn curve_vectors() {
    let v = vectors();
    for e in v["curve"].as_array().unwrap() {
        let t = Terms::from_params(&config(&e["config"])).unwrap();
        assert_eq!(
            curve_value(&t, n64(&e["s"])).unwrap() as u128,
            n(&e["f"]),
            "{e}"
        );
        assert_eq!(
            tokens_for(&t, n64(&e["q"])).unwrap() as u128,
            n(&e["tokens_for"]),
            "{e}"
        );
    }
}

#[test]
fn validate_config_vectors() {
    let v = vectors();
    let mut seen = std::collections::BTreeMap::<&str, usize>::new();
    for e in v["validate"].as_array().unwrap() {
        let p = config(&e["params"]);
        let got = validate_config(&p).err().map(rule_name);
        assert_eq!(got, e["rule"].as_str(), "{e}");
        *seen.entry(got.unwrap_or("pass")).or_default() += 1;
    }
    for r in [
        "pass", "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11",
    ] {
        assert!(seen.contains_key(r), "no {r} vector");
    }
}

#[test]
fn derive_curve_vectors() {
    let v = vectors();
    for e in v["derive"].as_array().unwrap() {
        let got = derive_curve(n64(&e["S"]), n64(&e["P"]), n64(&e["R"])).ok();
        let want = e["result"].as_array().map(|r| (n64(&r[0]), n64(&r[1])));
        assert_eq!(got, want, "{e}");
    }
}
