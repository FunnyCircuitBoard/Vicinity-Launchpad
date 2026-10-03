//! `init_city`: create the `CityConfig` and its vault for one city coin.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{CITY_SEED, CITY_TAG_LEN, REGISTRY_SEED, VAULT_SEED};
use crate::errors::RewardsError;
use crate::events::CityInitialized;
use crate::math::{validate_city_tag, validate_model_bps};
use crate::state::{CityConfig, Registry, RewardModel};

#[derive(Accounts)]
pub struct InitCity<'info> {
    /// Pays the rent of the config and the vault.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must be `registry.admin`. Only Vicinity can create a city's config, so
    /// nobody can squat the `["city", mint]` PDA of a freshly created coin
    /// (there is no close instruction; a squatted config would be permanent).
    pub admin: Signer<'info>,

    /// The one registry of this program (created by `init_registry`).
    #[account(
        has_one = admin @ RewardsError::Unauthorized,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, Registry>,

    /// Becomes `config.authority`. It must sign so that nobody can create a
    /// config that names a key its owner never agreed to operate. May be the
    /// same key as `admin`.
    pub authority: Signer<'info>,

    /// CHECK: only the key is stored (`config.founder`). The founder's reward
    /// token account is derived from it later as an associated token account,
    /// so any wallet or PDA works. Must not be the zero address, the config or
    /// the vault (money sent to their token accounts could never move again).
    pub founder: UncheckedAccount<'info>,

    /// The city coin. Identity of the config; this program never moves it.
    /// `InterfaceAccount<Mint>` proves it is a real Token or Token-2022 mint.
    pub city_coin_mint: InterfaceAccount<'info, Mint>,

    /// The asset rewards are paid in. Must be owned by `token_program`.
    #[account(mint::token_program = token_program)]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + CityConfig::INIT_SPACE,
        seeds = [CITY_SEED, city_coin_mint.key().as_ref()],
        bump,
    )]
    pub config: Account<'info, CityConfig>,

    /// Ordinary SPL token account owned by the config PDA. Anyone can send
    /// `reward_mint` to it, but only `claim` can take anything out.
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Token or Token-2022; must be the program that owns `reward_mint`.
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_city(
    ctx: Context<InitCity>,
    reward_model: RewardModel,
    founder_bps: u16,
    city_tag: [u8; CITY_TAG_LEN],
) -> Result<()> {
    validate_model_bps(reward_model, founder_bps)?;
    validate_city_tag(&city_tag)?;
    require_keys_neq!(
        ctx.accounts.founder.key(),
        Pubkey::default(),
        RewardsError::InvalidFounder
    );
    require_keys_neq!(
        ctx.accounts.founder.key(),
        ctx.accounts.config.key(),
        RewardsError::FounderIsProgramAccount
    );
    require_keys_neq!(
        ctx.accounts.founder.key(),
        ctx.accounts.vault.key(),
        RewardsError::FounderIsProgramAccount
    );
    // PRODUCT DECISION (default no): rewards are not paid in the city coin.
    require_keys_neq!(
        ctx.accounts.reward_mint.key(),
        ctx.accounts.city_coin_mint.key(),
        RewardsError::RewardMintIsCityCoin
    );
    ensure_supported_reward_mint(&ctx.accounts.reward_mint.to_account_info())?;

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.pending_authority = Pubkey::default();
    config.founder = ctx.accounts.founder.key();
    config.city_coin_mint = ctx.accounts.city_coin_mint.key();
    config.reward_mint = ctx.accounts.reward_mint.key();
    config.vault = ctx.accounts.vault.key();
    config.reward_model = reward_model;
    config.founder_bps = founder_bps;
    config.locked = false;
    config.paused = false;
    config.paused_at = 0;
    config.paused_total_secs = 0;
    config.epoch_count = 0;
    config.carry_over = 0;
    config.total_funded = 0;
    config.total_to_founder = 0;
    config.total_to_holders = 0;
    config.total_claimed = 0;
    config.city_tag = city_tag;
    config.bump = ctx.bumps.config;
    config.vault_bump = ctx.bumps.vault;

    emit!(CityInitialized {
        config: config.key(),
        city_coin_mint: config.city_coin_mint,
        reward_mint: config.reward_mint,
        vault: config.vault,
        authority: config.authority,
        founder: config.founder,
        reward_model,
        founder_bps,
        city_tag,
    });
    Ok(())
}

/// The vault accounting assumes that transferring `amount` delivers exactly
/// `amount`, that transfers can never be blocked by the mint, and that the
/// mint account outlives the config. Classic SPL Token mints always satisfy
/// this. For Token-2022 mints only extensions that do not touch transfer
/// amounts, transferability or the mint's existence are allowed; everything
/// else (transfer fee, transfer hook, permanent delegate, non-transferable,
/// confidential transfers, default account state, mint close authority, and
/// any extension this program does not know) is rejected at `init_city`, the
/// only place the reward mint is chosen. A closable mint is refused because
/// its close authority could close it while the supply is 0 (before the first
/// funding) and leave the config pointing at nothing, or recreate it at the
/// same address with other extensions.
pub fn ensure_supported_reward_mint(mint: &AccountInfo) -> Result<()> {
    if *mint.owner == anchor_spl::token::ID {
        return Ok(());
    }
    require_keys_eq!(
        *mint.owner,
        anchor_spl::token_2022::ID,
        RewardsError::UnsupportedRewardMint
    );
    let data = mint.try_borrow_data()?;
    reward_mint_data_is_supported(&data)
}

/// Pure part of the check so it can be unit tested without accounts.
pub fn reward_mint_data_is_supported(data: &[u8]) -> Result<()> {
    let state = StateWithExtensions::<Token2022Mint>::unpack(data)
        .map_err(|_| error!(RewardsError::UnsupportedRewardMint))?;
    let extensions = state
        .get_extension_types()
        .map_err(|_| error!(RewardsError::UnsupportedRewardMint))?;
    for extension in extensions {
        require!(
            extension_is_harmless(extension),
            RewardsError::UnsupportedRewardMint
        );
    }
    Ok(())
}

/// Allow-list, not a deny-list: a Token-2022 extension added after this
/// program was written is rejected until someone has reviewed it.
fn extension_is_harmless(extension: ExtensionType) -> bool {
    matches!(
        extension,
        ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroup
            | ExtensionType::TokenGroupMember
            | ExtensionType::InterestBearingConfig
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token_2022::spl_token_2022::extension::metadata_pointer::MetadataPointer;
    use anchor_spl::token_2022::spl_token_2022::extension::mint_close_authority::MintCloseAuthority;
    use anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::TransferFeeConfig;
    use anchor_spl::token_2022::spl_token_2022::extension::{
        BaseStateWithExtensionsMut, StateWithExtensionsMut,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    fn mint_with(extensions: &[ExtensionType]) -> Vec<u8> {
        let len = ExtensionType::try_calculate_account_len::<Token2022Mint>(extensions).unwrap();
        let mut data = vec![0u8; len];
        {
            let mut state =
                StateWithExtensionsMut::<Token2022Mint>::unpack_uninitialized(&mut data).unwrap();
            for ext in extensions {
                match ext {
                    ExtensionType::TransferFeeConfig => {
                        state.init_extension::<TransferFeeConfig>(true).unwrap();
                    }
                    ExtensionType::MetadataPointer => {
                        state.init_extension::<MetadataPointer>(true).unwrap();
                    }
                    ExtensionType::MintCloseAuthority => {
                        state.init_extension::<MintCloseAuthority>(true).unwrap();
                    }
                    other => panic!("test helper does not know {other:?}"),
                }
            }
            state.base.decimals = 6;
            state.base.is_initialized = true;
            state.pack_base();
            state.init_account_type().unwrap();
        }
        data
    }

    #[test]
    fn classic_layout_mint_is_supported() {
        let data = mint_with(&[]);
        assert_eq!(data.len(), Token2022Mint::LEN);
        assert!(reward_mint_data_is_supported(&data).is_ok());
    }

    #[test]
    fn metadata_pointer_is_harmless() {
        let data = mint_with(&[ExtensionType::MetadataPointer]);
        assert!(reward_mint_data_is_supported(&data).is_ok());
    }

    #[test]
    fn transfer_fee_mint_is_rejected() {
        let data = mint_with(&[ExtensionType::TransferFeeConfig]);
        assert!(reward_mint_data_is_supported(&data).is_err());
        let data = mint_with(&[
            ExtensionType::MetadataPointer,
            ExtensionType::TransferFeeConfig,
        ]);
        assert!(reward_mint_data_is_supported(&data).is_err());
    }

    #[test]
    fn closable_mint_is_rejected() {
        let data = mint_with(&[ExtensionType::MintCloseAuthority]);
        assert!(reward_mint_data_is_supported(&data).is_err());
        let data = mint_with(&[
            ExtensionType::MetadataPointer,
            ExtensionType::MintCloseAuthority,
        ]);
        assert!(reward_mint_data_is_supported(&data).is_err());
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(reward_mint_data_is_supported(&[]).is_err());
        assert!(reward_mint_data_is_supported(&[0u8; 10]).is_err());
    }

    #[test]
    fn deny_list_covers_the_dangerous_extensions() {
        for ext in [
            ExtensionType::TransferFeeConfig,
            ExtensionType::TransferHook,
            ExtensionType::PermanentDelegate,
            ExtensionType::NonTransferable,
            ExtensionType::ConfidentialTransferMint,
            ExtensionType::DefaultAccountState,
            ExtensionType::MintCloseAuthority,
        ] {
            assert!(!extension_is_harmless(ext), "{ext:?}");
        }
    }
}
