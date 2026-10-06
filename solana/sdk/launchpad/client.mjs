// Instruction builders for vicinity_launchpad, plus the Meteora DBC and DAMM v2
// instructions the website and keepers send directly (trading, graduation,
// platform-fee claims). Every builder returns a @solana/kit-shaped instruction
// (see idl.mjs). Addresses are base58 strings; amounts are bigint/number/string.
//
// Trading never goes through our program: buys, sells and coin-to-coin swaps
// are DBC `swap2` instructions (LAUNCHPAD-DESIGN.md 9.6).
import anchor from '@coral-xyz/anchor';
import web3 from '@solana/web3.js';
import { buildIx, IDL, Role } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, damm, dbc, pdas, programDataAddress, rewardsPdas } from './pda.mjs';
import { SwapMode } from './curve.mjs';

const { BN } = anchor;
const { PublicKey } = web3;
const bn = (x) => new BN(String(x));
const key = (x) => new PublicKey(x);
const P = pdas();
const TOKEN = PROGRAM_IDS.token;

// ---------------------------------------------------------------- admin
export function initLaunchpad({ payer, admin, upgradeAuthority, rewardsProgram = PROGRAM_IDS.rewards, programData = programDataAddress(PROGRAM_IDS.launchpad) }) {
  return buildIx(IDL.launchpad, 'init_launchpad', {}, {
    payer, admin, upgrade_authority: upgradeAuthority, program_data: programData, rewards_program: rewardsProgram, launchpad: P.launchpad(),
  });
}
export const proposeAdmin = ({ admin, newAdmin }) =>
  buildIx(IDL.launchpad, 'propose_admin', { new_admin: key(newAdmin) }, { admin, launchpad: P.launchpad() });
export const acceptAdmin = ({ newAdmin }) =>
  buildIx(IDL.launchpad, 'accept_admin', {}, { new_admin: newAdmin, launchpad: P.launchpad() });
export const setPayoutConfig = ({ admin, payoutAuthority, payoutDestination }) =>
  buildIx(IDL.launchpad, 'set_payout_config', { payout_authority: key(payoutAuthority), payout_destination: key(payoutDestination) }, { admin, launchpad: P.launchpad() });
export const setPause = ({ authority, launches = null, payouts = null }) =>
  buildIx(IDL.launchpad, 'set_pause', { launches, payouts }, { authority, launchpad: P.launchpad() });
export const addLaunchConfig = ({ admin, payer = admin, dbcConfig, quoteMint }) =>
  buildIx(IDL.launchpad, 'add_launch_config', {}, { admin, payer, launchpad: P.launchpad(), dbc_config: dbcConfig, quote_mint: quoteMint, launch_config: P.launchConfig(dbcConfig) });
export const setLaunchConfigEnabled = ({ admin, dbcConfig, enabled }) =>
  buildIx(IDL.launchpad, 'set_launch_config_enabled', { enabled }, { admin, launchpad: P.launchpad(), launch_config: P.launchConfig(dbcConfig) });

// ---------------------------------------------------------------- city gate
export const approveLaunch = ({ admin, cityId, founder, name, symbol, expiresAt, dbcConfig }) =>
  buildIx(IDL.launchpad, 'approve_launch',
    { city_id: bn(cityId), founder: key(founder), name, symbol, expires_at: bn(expiresAt) },
    { admin, launchpad: P.launchpad(), launch_config: P.launchConfig(dbcConfig), approval: P.approval(cityId), coin: P.coin(cityId) });
export const revokeApproval = ({ admin, cityId, rentPayer = admin }) =>
  buildIx(IDL.launchpad, 'revoke_approval', { city_id: bn(cityId) }, { admin, launchpad: P.launchpad(), approval: P.approval(cityId), rent_payer: rentPayer });

/** Every account `launch` needs, for a coin whose fresh mint keypair is `baseMint`. */
export function launchAccounts({ cityId, baseMint, dbcConfig, quoteMint }) {
  const coin = P.coin(cityId);
  const pool = dbc.pool(dbcConfig, baseMint, quoteMint);
  return {
    coin, pool,
    holdersPot: P.holdersPot(coin),
    founderVault: P.founderVault(coin),
    baseVault: dbc.tokenVault(baseMint, pool),
    quoteVault: dbc.tokenVault(quoteMint, pool),
    metadata: dbc.metadata(baseMint),
  };
}
export function launch({ founder, payer = founder, baseMint, cityId, dbcConfig, quoteMint, rentPayer }) {
  const a = launchAccounts({ cityId, baseMint, dbcConfig, quoteMint });
  return buildIx(IDL.launchpad, 'launch', { city_id: bn(cityId) }, {
    founder, payer, base_mint: baseMint, launchpad: P.launchpad(), approval: P.approval(cityId), rent_payer: rentPayer,
    launch_config: P.launchConfig(dbcConfig), coin: a.coin, holders_pot: a.holdersPot, founder_vault: a.founderVault,
    dbc_config: dbcConfig, dbc_pool_authority: ADDRESSES.dbcPoolAuthority, dbc_pool: a.pool, dbc_base_vault: a.baseVault,
    dbc_quote_vault: a.quoteVault, mint_metadata: a.metadata, metadata_program: PROGRAM_IDS.metaplex, quote_mint: quoteMint,
    dbc_event_authority: dbc.eventAuthority(), dbc_program: PROGRAM_IDS.dbc, token_program: TOKEN, system_program: PROGRAM_IDS.system,
  });
}

// ---------------------------------------------------------------- fees
/**
 * `coin` = { cityId, mint, quoteMint, dbcPool, dbcConfig }. Collects the city's
 * curve fees and, once the curve is complete, its share of DBC's surplus.
 */
export function harvestCurveFees({ payer, coin, overrides = {} }) {
  const c = P.coin(coin.cityId);
  return buildIx(IDL.launchpad, 'harvest_curve_fees', { city_id: bn(coin.cityId) }, {
    payer, coin: c, dbc_pool_authority: ADDRESSES.dbcPoolAuthority, dbc_pool: coin.dbcPool, dbc_config: coin.dbcConfig,
    dbc_base_vault: dbc.tokenVault(coin.mint, coin.dbcPool), dbc_quote_vault: dbc.tokenVault(coin.quoteMint, coin.dbcPool),
    base_mint: coin.mint, quote_mint: coin.quoteMint, coin_base_account: ata(c, coin.mint),
    holders_pot: P.holdersPot(c), founder_vault: P.founderVault(c), token_program: TOKEN,
    associated_token_program: PROGRAM_IDS.ata, system_program: PROGRAM_IDS.system,
    dbc_event_authority: dbc.eventAuthority(), dbc_program: PROGRAM_IDS.dbc, ...overrides,
  });
}
export function harvestPoolFees({ payer, coin, dammPool, positionNftMint, overrides = {} }) {
  const c = P.coin(coin.cityId);
  return buildIx(IDL.launchpad, 'harvest_pool_fees', { city_id: bn(coin.cityId) }, {
    payer, coin: c, damm_pool: dammPool, position: damm.position(positionNftMint),
    position_nft_account: damm.positionNftAccount(positionNftMint), damm_pool_authority: ADDRESSES.dammPoolAuthority,
    token_a_vault: damm.tokenVault(coin.mint, dammPool), token_b_vault: damm.tokenVault(coin.quoteMint, dammPool),
    token_a_mint: coin.mint, token_b_mint: coin.quoteMint, coin_base_account: ata(c, coin.mint),
    holders_pot: P.holdersPot(c), founder_vault: P.founderVault(c), token_program: TOKEN,
    associated_token_program: PROGRAM_IDS.ata, system_program: PROGRAM_IDS.system,
    damm_event_authority: damm.eventAuthority(), damm_program: PROGRAM_IDS.damm, ...overrides,
  });
}
export function forwardHoldersFees({ coin, rewardsProgram = PROGRAM_IDS.rewards, overrides = {} }) {
  const c = P.coin(coin.cityId);
  const R = rewardsPdas(rewardsProgram);
  const cfg = R.city(coin.mint);
  return buildIx(IDL.launchpad, 'forward_holders_fees', { city_id: bn(coin.cityId) }, {
    launchpad: P.launchpad(), coin: c, holders_pot: P.holdersPot(c), quote_mint: coin.quoteMint,
    rewards_city_config: cfg, rewards_vault: R.vault(cfg), token_program: TOKEN, ...overrides,
  });
}

// ---------------------------------------------------------------- founder
export function claimFounderFees({ founder, coin, overrides = {} }) {
  const c = P.coin(coin.cityId);
  return buildIx(IDL.launchpad, 'claim_founder_fees', { city_id: bn(coin.cityId) }, {
    founder, coin: c, founder_vault: P.founderVault(c), quote_mint: coin.quoteMint,
    founder_token_account: ata(founder, coin.quoteMint), token_program: TOKEN,
    associated_token_program: PROGRAM_IDS.ata, system_program: PROGRAM_IDS.system, ...overrides,
  });
}
export const transferFounder = ({ founder, newFounder, cityId }) =>
  buildIx(IDL.launchpad, 'transfer_founder', { city_id: bn(cityId) }, { founder, new_founder: newFounder, coin: P.coin(cityId) });
export function optInPayout({ founder, cityId, expectedDestination, refHash }) {
  const c = P.coin(cityId);
  return buildIx(IDL.launchpad, 'opt_in_payout',
    { city_id: bn(cityId), expected_destination: key(expectedDestination), ref_hash: Array.from(refHash) },
    { founder, launchpad: P.launchpad(), coin: c, opt_in: P.payoutOptIn(c) });
}
export function revokePayoutOptIn({ by, cityId, optInFounder }) {
  const c = P.coin(cityId);
  return buildIx(IDL.launchpad, 'revoke_payout_opt_in', { city_id: bn(cityId) }, { by, coin: c, opt_in: P.payoutOptIn(c), opt_in_founder: optInFounder });
}
export function payoutFounderFees({ payoutAuthority, coin, destination, overrides = {} }) {
  const c = P.coin(coin.cityId);
  return buildIx(IDL.launchpad, 'payout_founder_fees', { city_id: bn(coin.cityId) }, {
    payout_authority: payoutAuthority, launchpad: P.launchpad(), coin: c, opt_in: P.payoutOptIn(c),
    founder_vault: P.founderVault(c), quote_mint: coin.quoteMint, destination_wallet: destination,
    destination_token_account: ata(destination, coin.quoteMint), token_program: TOKEN,
    associated_token_program: PROGRAM_IDS.ata, system_program: PROGRAM_IDS.system, ...overrides,
  });
}

// ---------------------------------------------------------------- trading (DBC swap2)
/**
 * One DBC swap2. side 'buy' pays quote for coins, 'sell' pays coins for quote.
 * mode: SwapMode.ExactIn (amount0 = in, amount1 = min out), PartialFill (same,
 * fills up to the graduation price), ExactOut (amount0 = out, amount1 = max in).
 * `referral` (optional) = the dev wallet's quote-token account on site trades.
 */
export function swap({ trader, pool, config, baseMint, quoteMint, side, mode = SwapMode.ExactIn, amount0, amount1, referral, inputAccount, outputAccount }) {
  const buy = side === 'buy';
  const input = inputAccount ?? ata(trader, buy ? quoteMint : baseMint);
  const output = outputAccount ?? ata(trader, buy ? baseMint : quoteMint);
  return buildIx(IDL.dbc, 'swap2', { params: { amount_0: bn(amount0), amount_1: bn(amount1), swap_mode: mode } }, {
    config, pool, input_token_account: input, output_token_account: output,
    base_vault: dbc.tokenVault(baseMint, pool), quote_vault: dbc.tokenVault(quoteMint, pool),
    base_mint: baseMint, quote_mint: quoteMint, payer: trader, token_base_program: TOKEN, token_quote_program: TOKEN,
    referral_token_account: referral, event_authority: dbc.eventAuthority(), program: PROGRAM_IDS.dbc,
  });
}

/**
 * Coin to coin on two curves priced in the same quote token, in one
 * transaction: sell A exact in for at least `quoteMin`, then buy B exact in
 * with exactly `quoteMin` for at least `minOut`. Anything above `quoteMin`
 * stays in the trader's quote account. If B's minimum is missed the whole
 * transaction fails and A is untouched.
 */
export function coinToCoin({ trader, from, to, amountIn, quoteMin, minOut, referral }) {
  if (from.quoteMint !== to.quoteMint) throw new Error('coinToCoin: both coins must use the same quote token (otherwise use two transactions with a Jupiter leg)');
  return [
    swap({ trader, pool: from.dbcPool, config: from.dbcConfig, baseMint: from.mint, quoteMint: from.quoteMint, side: 'sell', amount0: amountIn, amount1: quoteMin, referral }),
    swap({ trader, pool: to.dbcPool, config: to.dbcConfig, baseMint: to.mint, quoteMint: to.quoteMint, side: 'buy', amount0: quoteMin, amount1: minOut, referral }),
  ];
}

// ---------------------------------------------------------------- graduation and platform fees (DBC / DAMM v2)
export function migrationAccounts({ coinMint, quoteMint, dammConfig = ADDRESSES.dammCustomizableConfig, firstNftMint, secondNftMint }) {
  const pool = damm.pool(dammConfig, coinMint, quoteMint);
  return {
    pool,
    firstPosition: damm.position(firstNftMint), firstNftAccount: damm.positionNftAccount(firstNftMint),
    secondPosition: damm.position(secondNftMint), secondNftAccount: damm.positionNftAccount(secondNftMint),
    tokenAVault: damm.tokenVault(coinMint, pool), tokenBVault: damm.tokenVault(quoteMint, pool),
  };
}
/** Permissionless DBC graduation into the DAMM v2 pool (needs ~400k CU). `remaining` = the DAMM v2 config. */
export function migrateToDammV2({ payer, dbcPool, dbcConfig, coinMint, quoteMint, firstNftMint, secondNftMint, dammConfig = ADDRESSES.dammCustomizableConfig }) {
  const m = migrationAccounts({ coinMint, quoteMint, dammConfig, firstNftMint, secondNftMint });
  const ix = buildIx(IDL.dbc, 'migration_damm_v2', {}, {
    virtual_pool: dbcPool, migration_metadata: PROGRAM_IDS.dbc, config: dbcConfig, pool_authority: ADDRESSES.dbcPoolAuthority,
    pool: m.pool, first_position_nft_mint: firstNftMint, first_position_nft_account: m.firstNftAccount, first_position: m.firstPosition,
    second_position_nft_mint: secondNftMint, second_position_nft_account: m.secondNftAccount, second_position: m.secondPosition,
    damm_pool_authority: ADDRESSES.dammPoolAuthority, amm_program: PROGRAM_IDS.damm, base_mint: coinMint, quote_mint: quoteMint,
    token_a_vault: m.tokenAVault, token_b_vault: m.tokenBVault, base_vault: dbc.tokenVault(coinMint, dbcPool),
    quote_vault: dbc.tokenVault(quoteMint, dbcPool), payer, token_base_program: TOKEN, token_quote_program: TOKEN,
    token_2022_program: PROGRAM_IDS.token2022, damm_event_authority: damm.eventAuthority(), system_program: PROGRAM_IDS.system,
  });
  ix.accounts.push({ address: dammConfig, role: Role.R });
  return ix;
}
export function withdrawLeftover({ dbcPool, dbcConfig, coinMint, receiverAccount, leftoverReceiver = ADDRESSES.feeRecipient }) {
  return buildIx(IDL.dbc, 'withdraw_leftover', {}, {
    config: dbcConfig, virtual_pool: dbcPool, token_base_account: receiverAccount, base_vault: dbc.tokenVault(coinMint, dbcPool),
    base_mint: coinMint, leftover_receiver: leftoverReceiver, token_base_program: TOKEN, event_authority: dbc.eventAuthority(), program: PROGRAM_IDS.dbc,
  });
}
/**
 * The dev wallet's share of DBC's completion surplus (once per pool, after the
 * curve completes). Only the config's fee_claimer (the dev wallet) can sign.
 */
export function partnerWithdrawSurplus({ feeClaimer = ADDRESSES.feeRecipient, dbcPool, dbcConfig, quoteMint, quoteAccount }) {
  return buildIx(IDL.dbc, 'partner_withdraw_surplus', {}, {
    config: dbcConfig, virtual_pool: dbcPool, token_quote_account: quoteAccount, quote_vault: dbc.tokenVault(quoteMint, dbcPool),
    quote_mint: quoteMint, fee_claimer: feeClaimer, token_quote_program: TOKEN, event_authority: dbc.eventAuthority(), program: PROGRAM_IDS.dbc,
  });
}
/** DBC's own creator surplus instruction (our program calls it inside harvest_curve_fees; only the Coin PDA can sign it). */
export function creatorWithdrawSurplus({ creator, dbcPool, dbcConfig, quoteMint, quoteAccount }) {
  return buildIx(IDL.dbc, 'creator_withdraw_surplus', {}, {
    config: dbcConfig, virtual_pool: dbcPool, token_quote_account: quoteAccount, quote_vault: dbc.tokenVault(quoteMint, dbcPool),
    quote_mint: quoteMint, creator, token_quote_program: TOKEN, event_authority: dbc.eventAuthority(), program: PROGRAM_IDS.dbc,
  });
}
/** Associated Token program "create idempotent": makes `owner`'s ATA for `mint` if missing, else does nothing. */
export function createAtaIdempotent({ payer, owner, mint, tokenProgram = TOKEN }) {
  return {
    programAddress: PROGRAM_IDS.ata,
    accounts: [
      { address: String(payer), role: Role.WS }, { address: ata(owner, mint, tokenProgram), role: Role.W },
      { address: String(owner), role: Role.R }, { address: String(mint), role: Role.R },
      { address: PROGRAM_IDS.system, role: Role.R }, { address: tokenProgram, role: Role.R },
    ],
    data: new Uint8Array([1]),
  };
}
/** The dev wallet claims its (partner) trading fees from one DBC pool. */
export function claimPartnerTradingFee({ feeClaimer = ADDRESSES.feeRecipient, dbcPool, dbcConfig, coinMint, quoteMint, baseAccount, quoteAccount }) {
  return buildIx(IDL.dbc, 'claim_trading_fee', { max_amount_a: bn((1n << 64n) - 1n), max_amount_b: bn((1n << 64n) - 1n) }, {
    config: dbcConfig, pool: dbcPool, token_a_account: baseAccount, token_b_account: quoteAccount,
    base_vault: dbc.tokenVault(coinMint, dbcPool), quote_vault: dbc.tokenVault(quoteMint, dbcPool), base_mint: coinMint, quote_mint: quoteMint,
    fee_claimer: feeClaimer, token_base_program: TOKEN, token_quote_program: TOKEN, event_authority: dbc.eventAuthority(), program: PROGRAM_IDS.dbc,
  });
}
export function claimPartnerPoolCreationFee({ feeClaimer = ADDRESSES.feeRecipient, dbcPool, dbcConfig, feeReceiver = feeClaimer }) {
  return buildIx(IDL.dbc, 'claim_partner_pool_creation_fee', {}, {
    config: dbcConfig, pool: dbcPool, fee_claimer: feeClaimer, fee_receiver: feeReceiver, event_authority: dbc.eventAuthority(), program: PROGRAM_IDS.dbc,
  });
}
export function dammSwap({ trader, pool, mintA, mintB, aToB, amountIn, minOut }) {
  return buildIx(IDL.damm, 'swap', { _params: { amount_in: bn(amountIn), minimum_amount_out: bn(minOut) } }, {
    pool, input_token_account: ata(trader, aToB ? mintA : mintB), output_token_account: ata(trader, aToB ? mintB : mintA),
    token_a_vault: damm.tokenVault(mintA, pool), token_b_vault: damm.tokenVault(mintB, pool), token_a_mint: mintA, token_b_mint: mintB,
    payer: trader, token_a_program: TOKEN, token_b_program: TOKEN, event_authority: damm.eventAuthority(), program: PROGRAM_IDS.damm,
  });
}
export function dammClaimPositionFee({ owner, pool, nftMint, mintA, mintB, accountA, accountB }) {
  return buildIx(IDL.damm, 'claim_position_fee', {}, {
    pool, position: damm.position(nftMint), token_a_account: accountA, token_b_account: accountB,
    token_a_vault: damm.tokenVault(mintA, pool), token_b_vault: damm.tokenVault(mintB, pool), token_a_mint: mintA, token_b_mint: mintB,
    position_nft_account: damm.positionNftAccount(nftMint), signer: owner, token_a_program: TOKEN, token_b_program: TOKEN,
    event_authority: damm.eventAuthority(), program: PROGRAM_IDS.damm,
  });
}

/** List only real Vicinity coins: decoded `Coin` accounts (the registry is the source of truth). */
export function isVicinityCoin(decodedCoins, dbcPool) {
  return decodedCoins.some((c) => c.dbc_pool.toBase58() === String(dbcPool));
}
