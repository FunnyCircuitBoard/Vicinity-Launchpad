//! Pure arithmetic and validation helpers. No accounts, no side effects, so
//! they can be unit tested exhaustively on the host.

use anchor_lang::prelude::*;

use crate::constants::{
    ALLOWED_SPLIT_BPS, BPS_DENOMINATOR, CITY_TAG_LEN, CREATOR_BPS, HOLDERS_BPS,
};
use crate::errors::RewardsError;
use crate::state::RewardModel;

/// Splits `amount` into `(founder_amount, holders_amount)`.
///
/// The founder share is floored; the remainder (at most 1 base unit) goes to
/// the holders side, so the two parts always add up to `amount` exactly and no
/// dust is created. The multiplication is done in u128 so `u64::MAX * 10000`
/// cannot overflow.
pub fn split_amount(amount: u64, founder_bps: u16) -> Result<(u64, u64)> {
    require!(
        u64::from(founder_bps) <= BPS_DENOMINATOR,
        RewardsError::InvalidFounderBps
    );
    let founder = u128::from(amount)
        .checked_mul(u128::from(founder_bps))
        .ok_or(RewardsError::MathOverflow)?
        .checked_div(u128::from(BPS_DENOMINATOR))
        .ok_or(RewardsError::MathOverflow)?;
    // founder <= amount <= u64::MAX, so this conversion cannot fail; the error
    // path is kept instead of an unwrap on principle.
    let founder = u64::try_from(founder).map_err(|_| RewardsError::MathOverflow)?;
    let holders = amount
        .checked_sub(founder)
        .ok_or(RewardsError::MathOverflow)?;
    Ok((founder, holders))
}

/// The bps must be exactly what the model says, so the UI cannot show one
/// thing and the chain do another.
pub fn validate_model_bps(model: RewardModel, founder_bps: u16) -> Result<()> {
    match model {
        RewardModel::Creator => {
            require!(founder_bps == CREATOR_BPS, RewardsError::FounderBpsMismatch)
        }
        RewardModel::Holders => {
            require!(founder_bps == HOLDERS_BPS, RewardsError::FounderBpsMismatch)
        }
        RewardModel::Split => require!(
            ALLOWED_SPLIT_BPS.contains(&founder_bps),
            RewardsError::SplitBpsNotAllowed
        ),
    }
    Ok(())
}

/// `city_tag` is informational, but it is stored forever, so it must be clean:
/// printable ASCII (0x20..=0x7e), then zero padding, nothing after the padding.
pub fn validate_city_tag(tag: &[u8; CITY_TAG_LEN]) -> Result<()> {
    let mut padding = false;
    for &b in tag.iter() {
        if b == 0 {
            padding = true;
        } else {
            require!(!padding, RewardsError::InvalidCityTag);
            require!((0x20..=0x7e).contains(&b), RewardsError::InvalidCityTag);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creator_takes_everything() {
        assert_eq!(split_amount(1_000, 10_000).unwrap(), (1_000, 0));
        assert_eq!(split_amount(u64::MAX, 10_000).unwrap(), (u64::MAX, 0));
        assert_eq!(split_amount(0, 10_000).unwrap(), (0, 0));
    }

    #[test]
    fn holders_take_everything() {
        assert_eq!(split_amount(1_000, 0).unwrap(), (0, 1_000));
        assert_eq!(split_amount(u64::MAX, 0).unwrap(), (0, u64::MAX));
    }

    #[test]
    fn allowed_splits_floor_the_founder_and_give_the_remainder_to_holders() {
        // 25/75
        assert_eq!(split_amount(1_000, 2_500).unwrap(), (250, 750));
        assert_eq!(split_amount(1_001, 2_500).unwrap(), (250, 751));
        assert_eq!(split_amount(3, 2_500).unwrap(), (0, 3));
        // 50/50
        assert_eq!(split_amount(1_000, 5_000).unwrap(), (500, 500));
        assert_eq!(split_amount(1_001, 5_000).unwrap(), (500, 501));
        assert_eq!(split_amount(1, 5_000).unwrap(), (0, 1));
        // 75/25
        assert_eq!(split_amount(1_000, 7_500).unwrap(), (750, 250));
        assert_eq!(split_amount(1_001, 7_500).unwrap(), (750, 251));
        assert_eq!(split_amount(1, 7_500).unwrap(), (0, 1));
        assert_eq!(split_amount(4, 7_500).unwrap(), (3, 1));
    }

    #[test]
    fn max_u64_does_not_overflow_for_any_bps() {
        for bps in 0..=10_000u16 {
            let (f, h) = split_amount(u64::MAX, bps).unwrap();
            assert_eq!(f.checked_add(h), Some(u64::MAX), "bps {bps}");
            // floor(u64::MAX * bps / 10000)
            let expect = (u128::from(u64::MAX) * u128::from(bps) / 10_000) as u64;
            assert_eq!(f, expect, "bps {bps}");
        }
    }

    #[test]
    fn parts_always_add_up() {
        let samples = [
            0u64,
            1,
            2,
            3,
            7,
            9_999,
            10_000,
            10_001,
            123_456_789,
            1_000_000_000_000,
            u64::MAX - 1,
            u64::MAX,
        ];
        for amount in samples {
            for bps in ALLOWED_SPLIT_BPS {
                let (f, h) = split_amount(amount, bps).unwrap();
                assert_eq!(f as u128 + h as u128, amount as u128);
                // Founder is floored: founder <= exact share < founder + 1.
                let exact_times_10000 = u128::from(amount) * u128::from(bps);
                assert!(u128::from(f) * 10_000 <= exact_times_10000);
                assert!((u128::from(f) + 1) * 10_000 > exact_times_10000);
            }
        }
    }

    #[test]
    fn bps_above_100_percent_is_rejected() {
        assert!(split_amount(1_000, 10_001).is_err());
        assert!(split_amount(1_000, u16::MAX).is_err());
    }

    #[test]
    fn model_and_bps_must_agree() {
        assert!(validate_model_bps(RewardModel::Creator, 10_000).is_ok());
        assert!(validate_model_bps(RewardModel::Creator, 0).is_err());
        assert!(validate_model_bps(RewardModel::Creator, 5_000).is_err());
        assert!(validate_model_bps(RewardModel::Holders, 0).is_ok());
        assert!(validate_model_bps(RewardModel::Holders, 10_000).is_err());
        assert!(validate_model_bps(RewardModel::Holders, 2_500).is_err());
        for bps in ALLOWED_SPLIT_BPS {
            assert!(validate_model_bps(RewardModel::Split, bps).is_ok());
        }
        assert!(validate_model_bps(RewardModel::Split, 0).is_err());
        assert!(validate_model_bps(RewardModel::Split, 10_000).is_err());
        assert!(validate_model_bps(RewardModel::Split, 5_001).is_err());
        assert!(validate_model_bps(RewardModel::Split, 1).is_err());
    }

    fn tag(s: &str) -> [u8; CITY_TAG_LEN] {
        let mut t = [0u8; CITY_TAG_LEN];
        t[..s.len()].copy_from_slice(s.as_bytes());
        t
    }

    #[test]
    fn city_tag_rules() {
        assert!(validate_city_tag(&tag("us-ny-utica")).is_ok());
        assert!(validate_city_tag(&tag("")).is_ok());
        assert!(validate_city_tag(&tag("a".repeat(32).as_str())).is_ok());
        // zero inside the text
        let mut t = tag("us-ny");
        t[2] = 0;
        assert!(validate_city_tag(&t).is_err());
        // control character and non-ASCII
        let mut t = tag("us");
        t[0] = 0x07;
        assert!(validate_city_tag(&t).is_err());
        let mut t = tag("us");
        t[1] = 0xc3;
        assert!(validate_city_tag(&t).is_err());
    }
}
