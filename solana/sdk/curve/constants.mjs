// Compiled constants of vicinity_curve (VICINITY-CURVE-DESIGN.md 3.2), the
// fixed layout facts of its accounts (3.4 to 3.9) and the Anchor
// discriminators of its instructions, accounts and events. Plain values, no
// network access; sdk/curve/constants.test.mjs keeps every one of them equal
// to the committed IDL (sdk/idl/vicinity_curve.json) and to the math crate.
//
// Amounts are BigInt. Addresses are base58 strings.

/**
 * The vicinity_curve program id of this build: the localnet and devnet
 * throwaway key (VICINITY-CURVE-NOTES.md entry 7). Mainnet replaces it with the
 * owner's key (the program's declare_id!, the math crate's PROGRAM_ID, Anchor.toml
 * and the IDL); every SDK function takes `programId` to follow.
 */
export const CURVE_PROGRAM_ID = 'nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk';

/** The ids each cluster build compiles in (3.2): the default build is `mainnet`, the `devnet` feature switches all four (`rewardsRegistry` is `["registry"]` under `rewardsProgram`, OPS-1). */
export const CLUSTERS = Object.freeze({
  mainnet: Object.freeze({
    rewardsProgram: 'EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG',
    legacyProgram: 'AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai',
    legacyLaunchpad: '4g9KRZ76Mpw6HCCu713yEGzm1txdCod3S1SugL7M9GwN',
    rewardsRegistry: '2i9xvFtxnnToASy7yuaV7eq2aQTstXpLTRYvJ6mUs4yG',
  }),
  devnet: Object.freeze({
    rewardsProgram: 'Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi',
    legacyProgram: 'Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7',
    legacyLaunchpad: 'ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw',
    rewardsRegistry: '2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3',
  }),
});

/** Programs and fixed addresses every build uses. */
export const ADDRESSES = Object.freeze({
  /** R9: the only destination of platform fees and launch fees. */
  feeRecipient: '13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN',
  metaplex: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  nativeMint: 'So11111111111111111111111111111111111111112',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system: '11111111111111111111111111111111',
  rentSysvar: 'SysvarRent111111111111111111111111111111111',
  upgradeableLoader: 'BPFLoaderUpgradeab1e11111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
});

/** Policy constants (3.2), as the program and the math crate compile them. */
export const COIN_SUPPLY = 1_000_000_000_000_000n;
export const COIN_DECIMALS = 6;
export const BPS = 10_000n;
export const MAX_TOTAL_FEE_BPS = 250n;
export const MIN_TOTAL_FEE_BPS = 1n;
export const MAX_PLATFORM_FEE_BPS = 120n;
export const MAX_FOUNDER_FEE_BPS = 100n;
export const MIN_TRADE_LAMPORTS = 100_000n;
export const BUYBACK_CAP_DIVISOR = 25n;
export const BUYBACK_INTERVAL_SLOTS = 150n;
export const BUYBACK_MIN_HORIZON_RUNS = 20n;
export const BUYBACK_MIN_HORIZON_RUNS_FOUNDER = 15n;
export const MEV_MAX_PERCENT = 99n;
export const MAX_DUST_RAW = 1_000_000_000n;
export const MAX_VIRTUAL = 1n << 60n;
export const MIN_GRADUATION_LAMPORTS = 1_000_000_000n;
export const MAX_GRADUATION_LAMPORTS = 10_000_000_000_000n;
export const CONTINUITY_PPB = 1n;
export const PPB = 1_000_000_000n;
export const MAX_LAUNCH_FEE_LAMPORTS = 500_000_000n;
export const APPROVAL_MAX_SECS = 2_592_000n;
export const PAYOUT_COOLDOWN_SECS = 86_400n;
export const METADATA_URI_PREFIX = 'https://vicinity.city/coin-meta/';
export const MAX_NAME_LEN = 32;
export const MAX_SYMBOL_LEN = 10;
export const DERIVE_CURVE_RADIUS = 20_000n;

/**
 * The old program's `Launchpad` (3.2): discriminator, size, the byte of `launches_paused`, and the offsets of
 * `admin` and `pending_admin` (8.5, GOV-1: approvals and launches require that admin to be this program's admin
 * with no transfer pending).
 */
export const LEGACY_LAUNCHPAD_DISCRIMINATOR = Object.freeze([247, 20, 16, 242, 203, 38, 169, 160]);
export const LEGACY_LAUNCHPAD_LEN = 171;
export const LEGACY_LAUNCHES_PAUSED_AT = 168;
export const LEGACY_ADMIN_AT = 8;
export const LEGACY_PENDING_ADMIN_AT = 40;

/**
 * vicinity_rewards' `Registry` (8.4, review OPS-1): discriminator, size and the offsets of `admin` and
 * `pending_admin` (approvals and launches require that admin to be this program's admin with no transfer pending).
 */
export const REWARDS_REGISTRY_DISCRIMINATOR = Object.freeze([47, 174, 110, 246, 184, 182, 252, 218]);
export const REWARDS_REGISTRY_LEN = 73;
export const REWARDS_REGISTRY_ADMIN_AT = 8;
export const REWARDS_REGISTRY_PENDING_ADMIN_AT = 40;

/** vicinity_rewards `CityConfig` facts the program reads (4.15). */
export const REWARDS_CITY_CONFIG_DISCRIMINATOR = Object.freeze([14, 136, 110, 28, 46, 68, 178, 115]);
export const REWARDS_MODEL_HOLDERS = 1;

/** PDA seeds (3.2). */
export const SEEDS = Object.freeze({
  launchpad: 'launchpad',
  config: 'config',
  approval: 'approval',
  coin: 'coin',
  mint: 'mint',
  coinVault: 'coin_vault',
  ticker: 'ticker',
  payoutOptIn: 'payout_opt_in',
  eventAuthority: '__event_authority',
  rewardsCity: 'city',
  rewardsVault: 'vault',
  metadata: 'metadata',
});

/** Account sizes including the 8-byte discriminator (3.3). `Approval` is the maximum. */
export const ACCOUNT_LEN = Object.freeze({
  Launchpad: 238,
  LaunchConfig: 144,
  Approval: 181,
  CurveCoin: 693,
  TickerLock: 49,
  PayoutOptIn: 145,
});

/** `sha256("account:<Name>")[..8]`. `Launchpad`, `Approval` and `PayoutOptIn` equal the old program's: decoders check the owner too (3.7). */
export const ACCOUNT_DISCRIMINATORS = Object.freeze({
  Approval: [233, 9, 153, 49, 11, 222, 59, 130],
  CurveCoin: [222, 133, 204, 32, 124, 103, 133, 230],
  LaunchConfig: [18, 161, 9, 224, 102, 145, 29, 94],
  Launchpad: [247, 20, 16, 242, 203, 38, 169, 160],
  PayoutOptIn: [81, 97, 235, 48, 126, 157, 111, 198],
  TickerLock: [239, 106, 232, 87, 93, 121, 8, 225],
});

/** `sha256("global:<name>")[..8]` of the 21 instructions (4.1 to 4.20). */
export const INSTRUCTION_DISCRIMINATORS = Object.freeze({
  init_launchpad: [114, 181, 7, 128, 0, 24, 234, 119],
  propose_admin: [121, 214, 199, 212, 87, 39, 117, 234],
  accept_admin: [112, 42, 45, 90, 116, 181, 13, 170],
  set_pause: [63, 32, 154, 2, 56, 103, 79, 45],
  set_guardian: [147, 243, 50, 121, 154, 164, 50, 30],
  set_payout_config: [155, 25, 186, 220, 197, 36, 87, 42],
  add_launch_config: [178, 122, 32, 119, 221, 205, 141, 74],
  set_launch_config_enabled: [123, 210, 135, 55, 41, 13, 19, 17],
  approve_launch: [170, 53, 90, 11, 30, 13, 94, 205],
  revoke_approval: [44, 51, 184, 108, 182, 202, 20, 53],
  launch: [153, 241, 93, 225, 22, 69, 74, 61],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  buyback_burn: [20, 254, 58, 252, 209, 32, 111, 97],
  withdraw_platform_fees: [87, 24, 138, 122, 62, 146, 186, 199],
  forward_holders_fees: [186, 118, 17, 159, 254, 15, 108, 10],
  claim_founder_fees: [12, 232, 155, 24, 29, 218, 112, 189],
  transfer_founder: [1, 134, 85, 154, 198, 242, 170, 10],
  opt_in_payout: [89, 18, 174, 106, 197, 228, 30, 139],
  revoke_payout_opt_in: [152, 168, 194, 21, 175, 36, 9, 178],
  payout_founder_fees: [149, 146, 116, 194, 121, 14, 148, 155],
});

/** Anchor's EVENT_IX_TAG (0x1d9acb512ea545e4, written little-endian): the first 8 bytes of every event CPI's data (4.21). */
export const EVENT_IX_TAG = Object.freeze([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** `sha256("event:<Name>")[..8]` of the 21 events (4.21). */
export const EVENT_DISCRIMINATORS = Object.freeze({
  AdminChanged: [232, 34, 31, 226, 62, 18, 19, 114],
  AdminProposed: [129, 249, 226, 227, 199, 82, 110, 243],
  ApprovalRevoked: [0, 143, 189, 167, 179, 12, 235, 123],
  BuybackBurned: [186, 84, 241, 202, 152, 185, 0, 115],
  CoinLaunched: [169, 65, 49, 61, 3, 18, 32, 179],
  ConfigAdded: [128, 219, 159, 75, 72, 84, 130, 225],
  ConfigEnabled: [231, 124, 194, 194, 54, 108, 82, 52],
  FounderFeesClaimed: [111, 0, 77, 153, 87, 109, 200, 226],
  FounderPaidOut: [227, 137, 76, 122, 164, 12, 73, 1],
  FounderTransferred: [209, 55, 221, 177, 58, 215, 53, 189],
  Graduated: [51, 241, 66, 50, 140, 245, 156, 192],
  GuardianChanged: [152, 239, 217, 24, 162, 189, 236, 143],
  HoldersFeesForwarded: [230, 169, 169, 68, 4, 89, 94, 109],
  LaunchApproved: [27, 164, 238, 158, 228, 136, 31, 60],
  LaunchpadInitialized: [53, 108, 116, 169, 67, 140, 109, 98],
  PauseChanged: [238, 188, 213, 78, 134, 209, 178, 218],
  PayoutConfigChanged: [58, 122, 116, 88, 134, 122, 16, 183],
  PayoutOptInRevoked: [180, 218, 130, 253, 235, 178, 103, 199],
  PayoutOptedIn: [63, 54, 202, 122, 25, 59, 114, 87],
  PlatformFeesWithdrawn: [21, 216, 172, 170, 221, 168, 147, 193],
  Trade: [24, 254, 218, 152, 253, 43, 18, 81],
});

/** `CurveError` (4.22): codes from 6000 in this order; new codes are only appended. */
export const ERROR_NAMES = Object.freeze([
  'Unauthorized', 'NotUpgradeAuthority', 'InvalidAddress', 'NoPendingAdmin', 'NotPendingAdmin', 'LaunchesPaused',
  'PayoutsPaused', 'PayoutsNotConfigured', 'PayoutKeyNotSeparate', 'ConfigDisabled', 'ConfigCount', 'ConfigFeeTotal',
  'ConfigFeeShareCap', 'ConfigSupply', 'ConfigCurveBounds', 'ConfigGraduation', 'ConfigAbsorption', 'ConfigContinuity',
  'ConfigBuybackMev', 'ConfigLaunchFee', 'BadCityId', 'BadName', 'BadSymbol', 'BadExpiry', 'ApprovalExpired',
  'ApprovalNotExpired', 'CoinAlreadyLaunched', 'TickerTaken', 'LegacyCoinExists', 'WrongFounder', 'ZeroAmount',
  'TradeTooSmall', 'ZeroOutput', 'SlippageExceeded', 'SellExceedsCurve', 'SameAccount', 'WrongTokenAccount', 'RentFloor',
  'WrongRewardsConfig', 'WrongRewardsVault', 'DestinationMismatch', 'OptInFounderMismatch', 'PayoutTooSoon',
  'TradingHalted', 'MathOverflow', 'ConfigDripFarmable', 'ConfigBuybackHorizon', 'LegacyApprovalExists',
  'LegacyLaunchesOpen', 'BuysHalted', 'BadMetaHash', 'LegacyAdminMismatch', 'FeeRecipientRole', 'FounderHoldsRole',
  'BuybacksHalted', 'BuybackHaltWithoutBuyHalt', 'RewardsRegistryAdminMismatch',
]);
export const ERROR_CODES = Object.freeze(Object.fromEntries(ERROR_NAMES.map((n, i) => [n, 6000 + i])));
/** The error name of a custom program error code, or null. */
export const errorName = (code) => ERROR_NAMES[Number(code) - 6000] ?? null;
