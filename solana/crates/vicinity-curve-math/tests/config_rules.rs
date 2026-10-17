//! V01 to V11 of 12.1: one test per rule of `validate_config` (5.13). For each
//! rule a config that violates only that rule gets that rule's error, the edge
//! passes, and the edge plus one fails. Where a rule's edge cannot be reached
//! by a config that passes every other rule (V1's lower edge, V4's bounds), the
//! edge is shown to pass that rule: the error, if any, is a later rule's.
//! The integers come from the reference model (reference/model.py, derive.py).

mod common;

use common::*;
use vicinity_curve_math::constants::*;
use vicinity_curve_math::*;

const DEF: ConfigParams = ConfigParams::DEFAULT;

/// Every rule's verdict in table order, evaluating each rule on its own by
/// calling `validate_config` on configs that differ only in that rule's inputs
/// is not possible, so "only that rule" is checked as: `validate_config` gives
/// the rule's error, and every later bps rule passes on its own sides.
fn err(p: &ConfigParams) -> Option<ConfigError> {
    validate_config(p).err()
}

fn later_bps_rules_pass(p: &ConfigParams) {
    if p.buyback_bps > 0 {
        let (l, r) = v8_sides(p).unwrap();
        assert!(l <= r, "V8 also fails");
        let ((l1, r1), (l2, r2)) = v11_sides(p).unwrap();
        assert!(l1 <= r1 && l2 <= r2, "V11 also fails");
    }
    assert!(
        p.launch_fee_lamports <= MAX_LAUNCH_FEE_LAMPORTS,
        "V9 also fails"
    );
    assert!(
        p.liquidity_bps == 0 || p.liquidity_bps < p.platform_bps,
        "V10 also fails"
    );
}

#[test]
fn v01_total_fee() {
    // upper edge: t = 250 passes (the default), 251 fails, nothing else violated
    assert_eq!(err(&DEF), None);
    let p = with_bps([50, 71, 50, 50, 30]);
    assert_eq!(err(&p), Some(ConfigError::FeeTotal));
    // lower edge: t = 1 passes; t = 0 fails V1 (it also breaks V4's x0 * t >= C*D)
    assert_eq!(err(&with_bps([0, 1, 0, 0, 0])), None);
    assert_eq!(err(&with_bps([0, 0, 0, 0, 0])), Some(ConfigError::FeeTotal));
    // shares summed in u32: five u16::MAX do not wrap
    assert_eq!(err(&with_bps([u16::MAX; 5])), Some(ConfigError::FeeTotal));
    assert_eq!(
        err(&with_bps([0, 0, 0, 0, 251])),
        Some(ConfigError::FeeTotal)
    );
}

#[test]
fn v02_share_caps() {
    let edge = with_bps([50, 120, 50, 0, 29]);
    assert_eq!(err(&edge), None, "platform 120 passes");
    let over = with_bps([50, 121, 50, 0, 29]);
    assert_eq!(
        err(&over),
        Some(ConfigError::FeeShareCap),
        "platform 121 fails"
    );
    later_bps_rules_pass(&ConfigParams {
        platform_bps: 121,
        ..over
    });
    let edge = with_bps([50, 70, 100, 0, 0]);
    assert_eq!(err(&edge), None, "founder 100 passes");
    assert_eq!(
        err(&with_bps([50, 70, 101, 0, 0])),
        Some(ConfigError::FeeShareCap),
        "founder 101 fails"
    );
    // revision 1's founder-favouring split (50, 0, 170, 0, 30) is refused (V2, MATH-3)
    assert_eq!(
        err(&with_bps([50, 0, 170, 0, 30])),
        Some(ConfigError::FeeShareCap)
    );
}

/// V2b (reviews ECON-1 and R3-DIFF-1): a trader credited the founder's share,
/// the holders' share or both (a founder who also holds the float) still pays
/// at least `MIN_TOTAL_FEE_BPS` per leg, also in a config without a buyback
/// share (where V8 and V11 do not run): `t - b_F - b_H >= 1`, the same as
/// `b_L + b_P + b_B >= 1`.
#[test]
fn v02b_credited_shares_leave_the_minimum_fee() {
    // ECON-1's configs: the founder (or the holders) take the whole fee
    // R3-DIFF-1's: the founder's and the holders' shares together are the whole
    // fee, so a founder holding the float trades for free (MATH3-2's too)
    for bps in [
        [0, 0, 100, 0, 0],
        [0, 0, 0, 100, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 0, 250, 0],
        [0, 0, 50, 50, 0],
        [0, 0, 100, 1, 0],
        [0, 0, 100, 150, 0],
        [0, 0, 1, 1, 0],
        [0, 0, 100, 100, 0],
    ] {
        assert_eq!(
            err(&with_bps(bps)),
            Some(ConfigError::FeeShareCap),
            "{bps:?}"
        );
        later_bps_rules_pass(&with_bps(bps));
    }
    // the edge: one basis point left besides the founder's and the holders' shares passes
    for bps in [
        [0, 1, 100, 0, 0],
        [0, 1, 0, 100, 0],
        [0, 1, 100, 100, 0],
        [0, 1, 50, 50, 0],
        [1, 2, 100, 0, 0],
    ] {
        assert_eq!(err(&with_bps(bps)), None, "{bps:?}");
    }
    // the review's smaller platform share passes (the founder's net fee is 0.2% per leg)
    assert_eq!(err(&with_bps([0, 20, 100, 0, 0])), None);
    // X44b's platform-only 0.01% config is untouched: nobody is credited
    assert_eq!(err(&with_bps([0, 1, 0, 0, 0])), None);
    // a buyback share counts as the basis point left: X44's 1.5% buyback with a 1% founder share
    assert_eq!(err(&with_bps([0, 0, 100, 0, 150])), None);
    // config #0: t - b_F - b_H = 150
    assert_eq!(err(&DEF), None);
    // with a buyback share V8 already bounded the founder's credited round trip
    assert_eq!(
        err(&with_bps([0, 0, 100, 0, 1])),
        Some(ConfigError::BuybackMev)
    );
    // exhaustive over small shares on the default curve: V2 fails exactly when a cap or V2b fails
    for f in 0..=101u16 {
        for h in [0u16, 1, 2, 50, 99, 100, 101, 149, 150] {
            for rest in [0u16, 1, 2, 70] {
                let p = with_bps([0, rest, f, h, 0]);
                let t = rest as u32 + f as u32 + h as u32;
                if t == 0 || t > 250 {
                    continue;
                }
                let v2 = f > 100 || f as u32 + h as u32 + 1 > t;
                assert_eq!(
                    err(&p) == Some(ConfigError::FeeShareCap),
                    v2,
                    "{:?}",
                    [0, rest, f, h, 0]
                );
            }
        }
    }
}

#[test]
fn v03_supply() {
    // dust = MAX_DUST_RAW passes and dust + 1 fails; both curves derived by 5.9's search
    let edge = params(
        [50, 70, 50, 50, 30],
        30_000_904_351,
        1_073_024_731_019_445,
        793_098_999_100_000,
        DEF.pool_supply,
        DEF.graduation_sol,
    );
    assert_eq!(
        COIN_SUPPLY - edge.curve_supply - edge.pool_supply,
        MAX_DUST_RAW
    );
    assert_eq!(err(&edge), None);
    let over = params(
        [50, 70, 50, 50, 30],
        30_000_904_351,
        1_073_024_731_019_444,
        793_098_999_099_999,
        DEF.pool_supply,
        DEF.graduation_sol,
    );
    assert_eq!(
        COIN_SUPPLY - over.curve_supply - over.pool_supply,
        MAX_DUST_RAW + 1
    );
    assert_eq!(err(&over), Some(ConfigError::Supply));
    // only V3 is violated: the same curve with the supply fixed passes V4 to V11
    // (S + P above 10^15 by one fails too; S = 0 and P = 0 fail)
    assert_eq!(
        err(&ConfigParams {
            pool_supply: COIN_SUPPLY - DEF.curve_supply + 1,
            ..DEF
        }),
        Some(ConfigError::Supply)
    );
    assert_eq!(
        err(&ConfigParams {
            curve_supply: 0,
            ..DEF
        }),
        Some(ConfigError::Supply)
    );
    assert_eq!(
        err(&ConfigParams {
            pool_supply: 0,
            ..DEF
        }),
        Some(ConfigError::Supply)
    );
    assert_eq!(
        err(&ConfigParams {
            curve_supply: u64::MAX,
            pool_supply: u64::MAX,
            ..DEF
        }),
        Some(ConfigError::Supply)
    );
}

#[test]
fn v04_curve_bounds() {
    let v4 = Some(ConfigError::CurveBounds);
    let passes_v4 = |p: &ConfigParams| assert_ne!(err(p), v4, "{p:?} must pass V4");
    // x0 <= 2^60 and y0 <= 2^60
    passes_v4(&ConfigParams {
        virtual_sol: MAX_VIRTUAL,
        ..DEF
    });
    assert_eq!(
        err(&ConfigParams {
            virtual_sol: MAX_VIRTUAL + 1,
            ..DEF
        }),
        v4
    );
    passes_v4(&ConfigParams {
        virtual_tokens: MAX_VIRTUAL,
        ..DEF
    });
    assert_eq!(
        err(&ConfigParams {
            virtual_tokens: MAX_VIRTUAL + 1,
            ..DEF
        }),
        v4
    );
    // x0 >= 1 and y0 > S
    assert_eq!(
        err(&ConfigParams {
            virtual_sol: 0,
            ..DEF
        }),
        v4
    );
    passes_v4(&ConfigParams {
        virtual_tokens: DEF.curve_supply + 1,
        ..DEF
    });
    assert_eq!(
        err(&ConfigParams {
            virtual_tokens: DEF.curve_supply,
            ..DEF
        }),
        v4
    );
    // x0 * t >= C * D: at t = 250, x0 = 1,000 passes and 999 fails
    passes_v4(&ConfigParams {
        virtual_sol: 1_000,
        ..DEF
    });
    assert_eq!(
        err(&ConfigParams {
            virtual_sol: 999,
            ..DEF
        }),
        v4
    );
    // R * P * t >= C * D * 10^15: R = 10^9 and P = 10^9 at t = 250 is exactly the edge
    let edge = ConfigParams {
        curve_supply: COIN_SUPPLY - 2_000_000_000,
        pool_supply: 1_000_000_000,
        graduation_sol: 1_000_000_000,
        ..DEF
    };
    passes_v4(&edge);
    assert_eq!(
        err(&ConfigParams {
            pool_supply: 999_999_999,
            curve_supply: COIN_SUPPLY - 1_999_999_999,
            ..edge
        }),
        v4
    );
}

#[test]
fn v05_graduation() {
    let v5 = Some(ConfigError::Graduation);
    // R range: 10^13 passes, 10^13 + 1 fails (both derived, so only V5 is violated)
    let hi = params(
        [50, 70, 50, 50, 30],
        3_529_512_192_888,
        1_073_025_598_488_463,
        DEF.curve_supply,
        DEF.pool_supply,
        MAX_GRADUATION_LAMPORTS,
    );
    assert_eq!(err(&hi), None);
    let over = params(
        [50, 70, 50, 50, 30],
        3_529_512_192_889,
        1_073_025_598_488_514,
        DEF.curve_supply,
        DEF.pool_supply,
        MAX_GRADUATION_LAMPORTS + 1,
    );
    assert_eq!(err(&over), v5);
    // R = 10^9 passes, 10^9 - 1 fails (S = 7 x 10^14, P = 3 x 10^14)
    let lo = params(
        [50, 70, 50, 50, 30],
        749_999_998,
        1_224_999_999_124_999,
        700_000_000_000_000,
        300_000_000_000_000,
        MIN_GRADUATION_LAMPORTS,
    );
    assert_eq!(err(&lo), None);
    let under = params(
        [50, 70, 50, 50, 30],
        749_999_997,
        1_224_999_998_949_999,
        700_000_000_000_000,
        300_000_000_000_000,
        MIN_GRADUATION_LAMPORTS - 1,
    );
    assert_eq!(err(&under), v5);
    // f(S) == R: R one off either way fails
    assert_eq!(
        err(&ConfigParams {
            graduation_sol: DEF.graduation_sol + 1,
            ..DEF
        }),
        v5
    );
    assert_eq!(
        err(&ConfigParams {
            graduation_sol: DEF.graduation_sol - 1,
            ..DEF
        }),
        v5
    );
    // V5b: the default sits at f(S - 1) = R - 1; y0 - 1 still passes; y0 - 2 keeps
    // f(S) = R but makes f(S - 1) = R (a last step that puts nothing in), refused
    let t = |p: &ConfigParams| Terms::from_params(p).unwrap();
    let edge = ConfigParams {
        virtual_tokens: DEF.virtual_tokens - 1,
        ..DEF
    };
    assert_eq!(err(&edge), None);
    let flat = ConfigParams {
        virtual_tokens: DEF.virtual_tokens - 2,
        ..DEF
    };
    assert_eq!(
        curve_value(&t(&flat), flat.curve_supply).unwrap(),
        flat.graduation_sol
    );
    assert_eq!(
        curve_value(&t(&flat), flat.curve_supply - 1).unwrap(),
        flat.graduation_sol
    );
    assert_eq!(err(&flat), v5);
}

#[test]
fn v06_absorption() {
    // P/R just above 1 passes; P = R makes x0 * y0 > d^2 (everything else passes)
    let s = COIN_SUPPLY - 5_000_000_000_000;
    let pass = params(
        [50, 70, 50, 50, 30],
        25_247_474_747,
        1_000_025_252_525_159,
        s,
        5_000_000_000_000,
        4_999_000_000_000,
    );
    assert_eq!(err(&pass), None);
    let fail = params(
        [50, 70, 50, 50, 30],
        25_252_525_252,
        1_000_025_252_525_149,
        s,
        5_000_000_000_000,
        5_000_000_000_000,
    );
    assert_eq!(err(&fail), Some(ConfigError::Absorption));
    let d = (fail.virtual_tokens - fail.curve_supply) as u128;
    assert!((fail.virtual_sol as u128) * (fail.virtual_tokens as u128) > d * d);
    let d = (pass.virtual_tokens - pass.curve_supply) as u128;
    assert!((pass.virtual_sol as u128) * (pass.virtual_tokens as u128) <= d * d);
}

#[test]
fn v07_continuity() {
    let v7 = Some(ConfigError::Continuity);
    // the pool may not open above the curve's last price: x0 + 1 with exact completion
    let above = ConfigParams {
        virtual_sol: DEF.virtual_sol + 1,
        virtual_tokens: 1_073_025_598_495_945,
        ..DEF
    };
    assert_eq!(err(&above), v7);
    let opening =
        (above.virtual_sol as u128 + above.graduation_sol as u128) * above.pool_supply as u128;
    assert!(
        above.graduation_sol as u128 * (above.virtual_tokens - above.curve_supply) as u128
            > opening
    );
    // below by at most 1 part per 10^9: x0 - 40 passes, x0 - 41 fails (largest d each)
    let edge = ConfigParams {
        virtual_sol: DEF.virtual_sol - 40,
        virtual_tokens: 1_073_025_598_113_391,
        ..DEF
    };
    assert_eq!(err(&edge), None);
    let below = ConfigParams {
        virtual_sol: DEF.virtual_sol - 41,
        virtual_tokens: 1_073_025_598_104_061,
        ..DEF
    };
    assert_eq!(err(&below), v7);
}

#[test]
fn v08_buyback_mev() {
    // a buyback share needs a total fee large enough for a 1% loss: platform 23 passes, 22 fails
    let edge = with_bps([0, 23, 0, 0, 30]);
    assert_eq!(err(&edge), None);
    let fail = with_bps([0, 22, 0, 0, 30]);
    assert_eq!(err(&fail), Some(ConfigError::BuybackMev));
    let ((l1, r1), (l2, r2)) = v11_sides(&fail).unwrap();
    assert!(l1 <= r1 && l2 <= r2, "only V8 is violated");
    // without a buyback share V8 does not apply
    assert_eq!(err(&with_bps([0, 22, 0, 0, 0])), None);
    // the default's margin: 0.98210 against 0.99
    let (l, r) = v8_sides(&DEF).unwrap();
    assert!(l <= r);
    // a founder share of 100 with the default liquidity fails V8 (credited founder)
    assert_eq!(
        err(&with_bps([50, 70, 100, 0, 30])),
        Some(ConfigError::BuybackMev)
    );
}

#[test]
fn v09_launch_fee() {
    assert_eq!(
        err(&ConfigParams {
            launch_fee_lamports: MAX_LAUNCH_FEE_LAMPORTS,
            ..DEF
        }),
        None
    );
    assert_eq!(
        err(&ConfigParams {
            launch_fee_lamports: MAX_LAUNCH_FEE_LAMPORTS + 1,
            ..DEF
        }),
        Some(ConfigError::LaunchFee)
    );
    assert_eq!(
        err(&ConfigParams {
            launch_fee_lamports: 0,
            ..DEF
        }),
        None
    );
}

#[test]
fn v10_drip_not_farmable() {
    // b_P = b_L + 1 passes, b_P = b_L fails (7.5's table)
    assert_eq!(err(&with_bps([50, 51, 50, 50, 30])), None);
    let fail = with_bps([50, 50, 50, 50, 30]);
    assert_eq!(err(&fail), Some(ConfigError::DripFarmable));
    let ((l1, r1), (l2, r2)) = v11_sides(&fail).unwrap();
    assert!(l1 <= r1 && l2 <= r2, "only V10 is violated");
    // b_L = 0 always passes V10, even with b_P = 0 (here with a buyback share, which V2b needs)
    assert_eq!(err(&with_bps([0, 0, 100, 0, 150])), None);
    assert_eq!(
        err(&with_bps([100, 50, 50, 50, 0])),
        Some(ConfigError::DripFarmable)
    );
    assert_eq!(
        err(&with_bps([250, 0, 0, 0, 0])),
        Some(ConfigError::DripFarmable)
    );
}

#[test]
fn v11_buyback_horizon() {
    // liquidity 46 passes, 47 fails with (b_P, b_F, b_H, b_B) = (120, 0, 0, 30)
    assert_eq!(err(&with_bps([46, 120, 0, 0, 30])), None);
    let fail = with_bps([47, 120, 0, 0, 30]);
    assert_eq!(err(&fail), Some(ConfigError::BuybackHorizon));
    let (l, r) = v8_sides(&fail).unwrap();
    assert!(l <= r, "only V11 is violated");
    // "V11 limits liquidity_bps to about 58 at t = 250": the default line
    for lb in [50u16, 54, 56] {
        let p = with_bps([lb, 120 - (lb - 50), 50, 0, 30]);
        assert_eq!(p.total_fee_bps(), 250);
        assert!(
            err(&p).is_none() || err(&p) == Some(ConfigError::BuybackMev),
            "{lb}"
        );
    }
    let ((l1, r1), _) = v11_sides(&with_bps([59, 61, 50, 50, 30])).unwrap();
    assert!(
        l1 > r1,
        "liquidity 59 at t = 250 breaks the first inequality"
    );
    let ((l1, r1), _) = v11_sides(&with_bps([58, 62, 50, 50, 30])).unwrap();
    assert!(l1 <= r1, "liquidity 58 at t = 250 keeps it");
}

#[test]
fn rules_are_checked_in_table_order() {
    // a config breaking V1, V3 and V9 reports V1; with V1 fixed, V3; and so on
    let p = ConfigParams {
        liquidity_bps: 51,
        curve_supply: 0,
        launch_fee_lamports: u64::MAX,
        ..DEF
    };
    assert_eq!(err(&p), Some(ConfigError::FeeTotal));
    let p = ConfigParams {
        liquidity_bps: 50,
        ..p
    };
    assert_eq!(err(&p), Some(ConfigError::Supply));
    let p = ConfigParams {
        curve_supply: DEF.curve_supply,
        ..p
    };
    assert_eq!(err(&p), Some(ConfigError::LaunchFee));
}

#[test]
fn derive_curve_search() {
    // 5.9: design A's integers; O3 (c)'s integers; and every derived curve passes V3 to V7
    assert_eq!(
        derive_curve(DEF.curve_supply, DEF.pool_supply, DEF.graduation_sol),
        Ok((DEF.virtual_sol, DEF.virtual_tokens))
    );
    assert_eq!(
        derive_curve(DEF.curve_supply, 206_900_010_000_000, DEF.graduation_sol),
        Ok((30_000_855_424, 1_073_025_615_141_714))
    );
    // the narrow window used by the property tests finds the same minimum
    assert_eq!(
        derive_curve_within(DEF.curve_supply, DEF.pool_supply, DEF.graduation_sol, 64),
        Ok((DEF.virtual_sol, DEF.virtual_tokens))
    );
    let mut x = 7u64;
    let mut found = 0;
    for _ in 0..40 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let p = 10_000_000_000_000 + x % 440_000_000_000_000;
        let r = 1_000_000_000 + (x >> 20) % 9_999_000_000_000;
        let dust = (x >> 7) % (MAX_DUST_RAW + 1);
        let s = COIN_SUPPLY - dust - p;
        if let Ok((x0, y0)) = derive_curve_within(s, p, r, 64) {
            found += 1;
            let c = params([50, 70, 50, 50, 30], x0, y0, s, p, r);
            assert_eq!(err(&c), None, "{c:?}");
        }
    }
    assert!(found >= 30, "found {found}");
}
