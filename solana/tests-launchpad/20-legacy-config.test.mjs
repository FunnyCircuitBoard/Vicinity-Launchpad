// TV01-TV02: the live mainnet price curve EZVHCg… on the pinned Meteora build. It was made on 12 Oct 2026 with DBC 0.2.1, so its
// PoolConfig.version is 0, and every mainnet coin launches and graduates on it. Since DBC 0.2.2 a version-0 config is "legacy"
// (PoolConfig::is_legacy_config): at launch its quote mint is checked against the older badge rule, and at graduation it always takes
// the original process_migrate_damm_v2 path. A config made now is version 1. This file runs the exact live bytes
// (test/fixtures/launchpad-worker/mainnet-pool-config.json, read from mainnet) through a coin's whole life, side by side with a
// version-1 config the same build creates for the same defaults, and every figure must be equal to the unit. Run it again at every
// Meteora re-pin (scripts/launchpad/fetch-fixtures.sh): it is the only test that executes a legacy config on the pinned build.
//   TV01 the live bytes differ from what this build's create_config writes for Vicinity's defaults only in PoolConfig.version (0
//        against 1), and both pass the Worker's config check (src/lpadmin.js configDiff)
//   TV02 one coin on each: allow-list, approve and launch (the launch fee), buys and sells (exact in, exact out, with and without the
//        dev wallet's referral), refusals, a harvest before completion with holder rewards and the founder's claim, the partial fill
//        to 85 SOL, the keeper's minute pass (migration_damm_v2, the leftover, the harvest with the completion surplus, the forward),
//        the dev wallet's claims on DBC (trading fee, surplus, launch fee), DAMM v2 trades, the keeper's daily pass, the dev
//        wallet's own position fees and the founder's second claim; every amount, every refusal and the masked account states
//        equal between the two; the live config still version 0 and byte for byte unchanged at the end
// Throwaway keypairs only, all inside litesvm; nothing here touches the network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateKeyPairSigner, address } from '@solana/kit';
import { World, C, IDL, ADDRESSES, PROGRAM_IDS, LAMPORTS, P, R, ata, damm, decodeAccount, svmReader, harvest, readKey, assertInvariants, TxError } from './helpers.mjs';
import { runKeeper } from '../sdk/launchpad/keeper.mjs';
import { SwapMode } from '../sdk/launchpad/curve.mjs';
import { configDiff } from '../../src/lpadmin.js';
import { LAYOUT } from '../../src/sol/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const LIVE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'launchpad-worker', 'mainnet-pool-config.json'), 'utf8')).accounts;
const [LIVE_ADDRESS, LIVE_ACC] = Object.entries(LIVE)[0];
const LIVE_BYTES = Buffer.from(LIVE_ACC.data, 'base64');
const VERSION_AT = LAYOUT.PoolConfig.fields.version.at;
const WSOL = ADDRESSES.wsol, DEV = ADDRESSES.feeRecipient;
const asRpc = (acc) => ({ owner: String(acc.programAddress), lamports: Number(acc.lamports), data: [Buffer.from(acc.data).toString('base64'), 'base64'] });

// account states with the random addresses (K), the PDA bumps of random addresses (B) and the clock-derived fields (T) masked, so
// two worlds can be compared
const FIXED = new Set([...Object.values(ADDRESSES), ...Object.values(PROGRAM_IDS)].map(String));
const TIME = (k) => /(timestamp|_point$|_time$|_at$|^last_|slot|epoch|expires)/i.test(k) && !/duration|frequency|period/i.test(k);
const masked = (k, v) => (/bump/i.test(k) ? 'B' : TIME(k) ? 'T' : v);
function mask(v, k = '') {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object' && typeof v.toBase58 === 'function') { const s = v.toBase58(); return FIXED.has(s) ? s : 'K'; }
  if (typeof v === 'object' && v.constructor && v.constructor.name === 'BN') return masked(k, v.toString());
  if (typeof v === 'number' || typeof v === 'bigint') return masked(k, String(v));
  if (Array.isArray(v)) return v.map((x) => mask(x, k));
  if (typeof v === 'object') { const o = {}; for (const [a, b] of Object.entries(v)) o[a] = mask(b, a); return o; }
  return v;
}
const big = (x) => (Array.isArray(x) || x instanceof Uint8Array ? [...x].reverse().reduce((a, b) => (a << 8n) | BigInt(b), 0n) : BigInt(x.toString()));
/** The program's error code (or the runtime's reason) of a refused transaction. */
function reasonOf(e) {
  if (!(e instanceof TxError)) throw e;
  const code = e.logs.map((l) => /Error Code: (\w+)\. Error Number: (\d+)/.exec(l)).filter(Boolean).pop();
  const custom = e.logs.map((l) => /\S+ failed: (.+)$/.exec(l)).filter(Boolean).pop();
  return code ? `${code[1]} (${code[2]})` : custom ? custom[1] : e.errText;
}

/** One coin's whole life on a config: `legacy` = the live mainnet bytes (version 0), else a version-1 config made now. */
async function lifeOn(legacy) {
  const out = { figures: {}, refusals: {}, states: {} };
  const fig = (k, v) => { out.figures[k] = typeof v === 'bigint' ? v.toString() : String(v); };
  const refused = async (k, fn) => {
    try { await fn(); out.refusals[k] = 'not refused'; } catch (e) { out.refusals[k] = reasonOf(e); }
  };
  const w = await World.create({ addConfig: false });
  const state = (k, idl, name, addr) => { const a = w.account(addr); out.states[k] = a ? { lamports: String(a.lamports), len: a.data.length, data: mask(decodeAccount(idl, name, a.data)) } : null; };
  let cfg;
  if (legacy) { w.setRaw(LIVE_ADDRESS, LIVE_BYTES, LIVE_ACC.owner, BigInt(LIVE_ACC.lamports)); cfg = LIVE_ADDRESS; } else cfg = await w.createDbcConfig();
  const cfgBytes = () => Buffer.from(w.account(cfg).data);
  const installed = cfgBytes();
  out.version = installed[VERSION_AT];
  await w.send([C.addLaunchConfig({ admin: w.admin.address, dbcConfig: cfg, quoteMint: WSOL })], [w.admin], 'add_launch_config');
  w.config = cfg;
  state('LaunchConfig', IDL.launchpad, 'LaunchConfig', P.launchConfig(cfg));
  const devWsol = w.emptyTokenAccount(DEV, WSOL);

  // launch through our program
  const cityId = 424242n, founder = await w.signer(100n);
  await w.approve({ cityId, founder, name: 'Live Config City', symbol: 'LIVE', dbcConfig: cfg });
  const f0 = w.lamportsOf(founder.address), a0 = w.lamportsOf(w.admin.address);
  const coin = await w.launchCoin({ cityId, founder, name: 'Live Config City', symbol: 'LIVE', dbcConfig: cfg, approved: true });
  fig('launch.founder_spent', f0 - w.lamportsOf(founder.address));
  fig('launch.admin_rent_payer_delta', w.lamportsOf(w.admin.address) - a0);
  fig('launch.dbc_pool_lamports', w.lamportsOf(coin.dbcPool));
  fig('launch.base_vault_tokens', w.balance(w.pool(coin.dbcPool).baseVault));
  state('launch.VirtualPool', IDL.dbc, 'VirtualPool', coin.dbcPool);

  // trades on the curve
  const pool = () => w.pool(coin.dbcPool);
  async function trade(k, trader, opts) {
    const p0 = pool(), q = ata(trader.address, WSOL), b = ata(trader.address, coin.mint);
    const b0 = w.exists(b) ? w.balance(b) : 0n, r0 = w.balance(devWsol);
    if (opts.side === 'buy') w.fundToken(trader.address, WSOL, opts.mode === SwapMode.ExactOut ? opts.amount1 : opts.amount0);
    const qf = w.balance(q);
    await w.trade(trader, coin, { ...opts, fund: false, referral: opts.referral ? devWsol : undefined, label: k });
    const p1 = pool();
    fig(`${k}.trader_quote`, w.balance(q) - qf);
    fig(`${k}.trader_base`, w.balance(b) - b0);
    fig(`${k}.referral`, w.balance(devWsol) - r0);
    fig(`${k}.fees_protocol_partner_creator`, `${p1.protocolQuoteFee - p0.protocolQuoteFee}/${p1.partnerQuoteFee - p0.partnerQuoteFee}/${p1.creatorQuoteFee - p0.creatorQuoteFee}`);
    fig(`${k}.base_fees`, `${p1.protocolBaseFee - p0.protocolBaseFee}/${p1.partnerBaseFee - p0.partnerBaseFee}/${p1.creatorBaseFee - p0.creatorBaseFee}`);
    fig(`${k}.reserves_price`, `${p1.quoteReserve}/${p1.baseReserve}/${p1.sqrtPrice}`);
  }
  const tA = await w.signer(500n), tB = await w.signer(500n);
  await trade('buy_in_1sol', tA, { side: 'buy', mode: SwapMode.ExactIn, amount0: 1n * LAMPORTS, amount1: 1n });
  await trade('buy_in_1sol_ref', tB, { side: 'buy', mode: SwapMode.ExactIn, amount0: 1n * LAMPORTS, amount1: 1n, referral: true });
  await trade('buy_out_5e12', tA, { side: 'buy', mode: SwapMode.ExactOut, amount0: 5_000_000_000_000n, amount1: 10n * LAMPORTS });
  await trade('buy_out_5e12_ref', tB, { side: 'buy', mode: SwapMode.ExactOut, amount0: 5_000_000_000_000n, amount1: 10n * LAMPORTS, referral: true });
  await trade('sell_in_2e12', tA, { side: 'sell', mode: SwapMode.ExactIn, amount0: 2_000_000_000_000n, amount1: 1n });
  await trade('sell_in_2e12_ref', tB, { side: 'sell', mode: SwapMode.ExactIn, amount0: 2_000_000_000_000n, amount1: 1n, referral: true });
  await trade('sell_out_0.1sol', tA, { side: 'sell', mode: SwapMode.ExactOut, amount0: LAMPORTS / 10n, amount1: 10n ** 15n });
  await trade('sell_out_0.1sol_ref', tB, { side: 'sell', mode: SwapMode.ExactOut, amount0: LAMPORTS / 10n, amount1: 10n ** 15n, referral: true });
  await trade('buy_in_30sol_ref', tB, { side: 'buy', mode: SwapMode.ExactIn, amount0: 30n * LAMPORTS, amount1: 1n, referral: true });
  await refused('buy_min_out_too_high', () => w.trade(tA, coin, { side: 'buy', amount0: LAMPORTS, amount1: 10n ** 15n, label: 'min out' }));
  await refused('sell_out_max_in_too_low', () => w.trade(tA, coin, { side: 'sell', mode: SwapMode.ExactOut, amount0: LAMPORTS, amount1: 1n, label: 'max in' }));
  await refused('buy_zero', () => w.trade(tA, coin, { side: 'buy', amount0: 0n, amount1: 0n, label: 'zero' }));
  await refused('buy_in_beyond_threshold', () => w.trade(tA, coin, { side: 'buy', mode: SwapMode.ExactIn, amount0: 200n * LAMPORTS, amount1: 1n, label: 'overfill' }));

  // a harvest before completion, holder rewards, the founder's claim
  await w.initRewardsCity(coin);
  const rv = R.vault(R.city(coin.mint));
  {
    const p0 = pool(), pot0 = w.balance(coin.holdersPot), v0 = w.balance(coin.founderVault);
    await harvest(w, coin);
    fig('harvest.claimed', p0.creatorQuoteFee - pool().creatorQuoteFee);
    fig('harvest.holders_pot', w.balance(coin.holdersPot) - pot0);
    fig('harvest.founder_vault', w.balance(coin.founderVault) - v0);
    const rv0 = w.balance(rv);
    await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    fig('harvest.forwarded', w.balance(rv) - rv0);
    const fq = ata(founder.address, WSOL), fq0 = w.exists(fq) ? w.balance(fq) : 0n;
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder], 'claim_founder_fees');
    fig('harvest.founder_claimed', w.balance(fq) - fq0);
  }
  const migrate = async (label) => {
    const n1 = await generateKeyPairSigner(), n2 = await generateKeyPairSigner(), k = await w.signer(5n);
    await w.send([C.migrateToDammV2({ payer: k.address, dbcPool: coin.dbcPool, dbcConfig: cfg, coinMint: coin.mint, quoteMint: WSOL, firstNftMint: n1.address, secondNftMint: n2.address })], [k, n1, n2], label, { feePayer: k, cu: 400_000 });
  };
  await refused('migration_before_completion', () => migrate('early migration'));
  await refused('pool_creation_fee_not_fee_claimer', async () => { const s = await w.signer(1n); await w.send([C.claimPartnerPoolCreationFee({ feeClaimer: s.address, dbcPool: coin.dbcPool, dbcConfig: cfg })], [s], 'wrong claimer'); });

  // the partial fill to the 85 SOL threshold
  {
    const filler = await w.signer(500n), p0 = pool();
    const fq = w.fundToken(filler.address, WSOL, 200n * LAMPORTS), before = w.balance(fq);
    await w.trade(filler, coin, { side: 'buy', mode: SwapMode.PartialFill, amount0: 200n * LAMPORTS, amount1: 1n, referral: devWsol, fund: false, label: 'partial fill to graduation' });
    const p1 = pool();
    fig('fill.quote_spent', before - w.balance(fq));
    fig('fill.base_received', w.balance(ata(filler.address, coin.mint)));
    fig('fill.fees_protocol_partner_creator', `${p1.protocolQuoteFee - p0.protocolQuoteFee}/${p1.partnerQuoteFee - p0.partnerQuoteFee}/${p1.creatorQuoteFee - p0.creatorQuoteFee}`);
    fig('fill.reserves_price', `${p1.quoteReserve}/${p1.baseReserve}/${p1.sqrtPrice}`);
    fig('fill.migration_progress', p1.migrationProgress);
    fig('fill.vaults', `${w.balance(p1.quoteVault)}/${w.balance(p1.baseVault)}`);
    fig('fill.referral_total', w.balance(devWsol));
    state('fill.VirtualPool', IDL.dbc, 'VirtualPool', coin.dbcPool);
  }
  await refused('buy_after_completion', () => w.trade(tA, coin, { side: 'buy', amount0: LAMPORTS, amount1: 1n, label: 'buy after completion' }));
  await refused('sell_after_completion', () => w.trade(tA, coin, { side: 'sell', amount0: 1_000_000n, amount1: 0n, label: 'sell after completion' }));

  // the keeper's passes, as on mainnet (scripts/launchpad/crank.mjs)
  const keeper = await w.signer(20n);
  const pass = async (k, daily) => {
    const k0 = w.lamportsOf(keeper.address);
    const report = await runKeeper({ reader: svmReader(w), payer: keeper.address, daily, newSigner: generateKeyPairSigner,
      send: async (ixs, signers, { cu, label }) => w.send(ixs, signers, label, { feePayer: keeper, cu }) });
    fig(`${k}.steps`, report.steps.map((s) => s.kind).sort().join(','));
    fig(`${k}.failed`, report.results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`).join(' | '));
    fig(`${k}.keeper_spent`, k0 - w.lamportsOf(keeper.address));
  };
  // the minute pass: graduation, the leftover, the harvest with the completion surplus, the forward
  const dammPool = damm.pool(ADDRESSES.dammCustomizableConfig, coin.mint, WSOL);
  {
    const p0 = pool(), devCoin = ata(DEV, coin.mint), dc0 = w.exists(devCoin) ? w.balance(devCoin) : 0n;
    const pot0 = w.balance(coin.holdersPot), v0 = w.balance(coin.founderVault), rv0 = w.balance(rv);
    const qv0 = w.balance(p0.quoteVault), bv0 = w.balance(p0.baseVault);
    await pass('minute_pass', false);
    const p1 = pool();
    fig('graduation.flags', `${p1.isMigrated}/${p1.migrationProgress}/${p1.isWithdrawLeftover}/${p1.isCreatorWithdrawSurplus}`);
    fig('graduation.protocol_migration_fees', `${p1.protocolMigrationBaseFee}/${p1.protocolMigrationQuoteFee}`);
    fig('graduation.fees_left_protocol_partner_creator', `${p1.protocolQuoteFee}/${p1.partnerQuoteFee}/${p1.creatorQuoteFee}`);
    fig('graduation.dbc_vault_deltas', `${w.balance(p1.quoteVault) - qv0}/${w.balance(p1.baseVault) - bv0}`);
    fig('graduation.dbc_vaults_after', `${w.balance(p1.quoteVault)}/${w.balance(p1.baseVault)}`);
    fig('graduation.leftover_to_dev_wallet', w.balance(devCoin) - dc0);
    fig('graduation.holders_pot', w.balance(coin.holdersPot) - pot0);
    fig('graduation.founder_vault', w.balance(coin.founderVault) - v0);
    fig('graduation.rewards_vault', w.balance(rv) - rv0);
    const dp = decodeAccount(IDL.damm, 'Pool', w.account(dammPool).data);
    fig('graduation.damm', `${big(dp.sqrt_price)}/${big(dp.liquidity)}/${big(dp.permanent_lock_liquidity)}/${big(dp.token_a_amount)}/${big(dp.token_b_amount)}`);
    fig('graduation.damm_vaults', `${w.balance(damm.tokenVault(coin.mint, dammPool))}/${w.balance(damm.tokenVault(WSOL, dammPool))}`);
    fig('graduation.mint_supply', Buffer.from(w.account(coin.mint).data).readBigUInt64LE(36));
    state('graduation.DammPool', IDL.damm, 'Pool', dammPool);
    state('graduation.VirtualPool', IDL.dbc, 'VirtualPool', coin.dbcPool);
  }
  // the two locked positions: our city's (the coin PDA) and the dev wallet's
  const posDisc = Buffer.from(IDL.damm.accounts.find((a) => a.name === 'Position').discriminator);
  const positions = w.svm.getProgramAccounts(address(PROGRAM_IDS.damm))
    .filter((a) => Buffer.from(a.data).subarray(0, 8).equals(posDisc))
    .map((a) => decodeAccount(IDL.damm, 'Position', a.data))
    .filter((d) => d.pool.toBase58() === dammPool)
    .map((d) => {
      const nft = d.nft_mint.toBase58(), holder = readKey(w.account(damm.positionNftAccount(nft)).data, 32);
      return { nft, owner: holder === coin.address ? 'city' : holder === DEV ? 'dev_wallet' : holder, d };
    })
    .sort((a, b) => (a.owner < b.owner ? -1 : 1));
  fig('positions', positions.map((p) => `${p.owner}:${big(p.d.permanent_locked_liquidity)}/${big(p.d.unlocked_liquidity)}/${big(p.d.vested_liquidity)}`).join(','));
  await refused('second_migration', () => migrate('second migration'));
  await refused('second_withdraw_leftover', () => w.send([C.withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: cfg, coinMint: coin.mint, receiverAccount: ata(DEV, coin.mint) })], [], 'withdraw_leftover again'));

  // the dev wallet (Meteora's fee claimer on this config) claims on DBC
  {
    const devCoin = w.emptyTokenAccount(DEV, coin.mint), b0 = w.balance(devCoin), q0 = w.balance(devWsol), p0 = pool();
    await w.sendAsDevWallet([C.claimPartnerTradingFee({ dbcPool: coin.dbcPool, dbcConfig: cfg, coinMint: coin.mint, quoteMint: WSOL, baseAccount: devCoin, quoteAccount: devWsol })], 'claim_trading_fee');
    fig('dev.claim_trading_fee', `${w.balance(devWsol) - q0}/${w.balance(devCoin) - b0}/${p0.partnerQuoteFee}/${pool().partnerQuoteFee}`);
    const q1 = w.balance(devWsol);
    await w.sendAsDevWallet([C.partnerWithdrawSurplus({ dbcPool: coin.dbcPool, dbcConfig: cfg, quoteMint: WSOL, quoteAccount: devWsol })], 'partner_withdraw_surplus');
    fig('dev.partner_withdraw_surplus', w.balance(devWsol) - q1);
    const l0 = w.lamportsOf(DEV), pl0 = w.lamportsOf(coin.dbcPool);
    await w.sendAsDevWallet([C.claimPartnerPoolCreationFee({ dbcPool: coin.dbcPool, dbcConfig: cfg })], 'claim_partner_pool_creation_fee');
    fig('dev.launch_fee_share', `${w.lamportsOf(DEV) - l0}/${w.lamportsOf(coin.dbcPool) - pl0}/${w.lamportsOf(coin.dbcPool)}`);
    state('dev.VirtualPool', IDL.dbc, 'VirtualPool', coin.dbcPool);
  }
  await refused('second_partner_withdraw_surplus', () => w.sendAsDevWallet([C.partnerWithdrawSurplus({ dbcPool: coin.dbcPool, dbcConfig: cfg, quoteMint: WSOL, quoteAccount: devWsol })], 'surplus again'));
  await refused('second_claim_partner_pool_creation_fee', () => w.sendAsDevWallet([C.claimPartnerPoolCreationFee({ dbcPool: coin.dbcPool, dbcConfig: cfg })], 'launch fee again'));
  await refused('creator_withdraw_surplus_by_founder', () => w.send([C.creatorWithdrawSurplus({ creator: founder.address, dbcPool: coin.dbcPool, dbcConfig: cfg, quoteMint: WSOL, quoteAccount: ata(founder.address, WSOL) })], [founder], 'creator surplus by founder'));

  // DAMM v2 trades, the keeper's daily pass, the dev wallet's own position fees, the founder's second claim
  {
    const t = await w.signer(100n);
    w.fundToken(t.address, WSOL, 20n * LAMPORTS);
    w.emptyTokenAccount(t.address, coin.mint);
    for (let i = 0; i < 3; i++) {
      const c0 = w.balance(ata(t.address, coin.mint));
      await w.send([C.dammSwap({ trader: t.address, pool: dammPool, mintA: coin.mint, mintB: WSOL, aToB: false, amountIn: 2n * LAMPORTS, minOut: 1n })], [t], 'damm swap buy');
      const coins = w.balance(ata(t.address, coin.mint)), q1 = w.balance(ata(t.address, WSOL));
      await w.send([C.dammSwap({ trader: t.address, pool: dammPool, mintA: coin.mint, mintB: WSOL, aToB: true, amountIn: coins / 2n, minOut: 1n })], [t], 'damm swap sell');
      fig(`damm.trade_${i}`, `${coins - c0}/${w.balance(ata(t.address, WSOL)) - q1}`);
    }
    const dp = decodeAccount(IDL.damm, 'Pool', w.account(dammPool).data);
    fig('damm.fees', `${big(dp.protocol_a_fee)}/${big(dp.protocol_b_fee)}/${big(dp.fee_a_per_liquidity)}/${big(dp.fee_b_per_liquidity)}`);
    const pot0 = w.balance(coin.holdersPot), v0 = w.balance(coin.founderVault), rv0 = w.balance(rv);
    await pass('daily_pass', true);
    fig('daily.city_position_fees', `${w.balance(coin.founderVault) - v0}/${w.balance(rv) - rv0}/${w.balance(coin.holdersPot) - pot0}`);
    const devPos = positions.find((p) => p.owner === 'dev_wallet'), cityPos = positions.find((p) => p.owner === 'city');
    const devA = w.emptyTokenAccount(DEV, coin.mint), a0 = w.balance(devA), b0 = w.balance(devWsol);
    await w.sendAsDevWallet([C.dammClaimPositionFee({ owner: DEV, pool: dammPool, nftMint: devPos.nft, mintA: coin.mint, mintB: WSOL, accountA: devA, accountB: devWsol })], 'dev wallet claim_position_fee');
    fig('daily.dev_position_fees', `${w.balance(devWsol) - b0}/${w.balance(devA) - a0}`);
    await refused('dev_wallet_claims_city_position', () => w.sendAsDevWallet([C.dammClaimPositionFee({ owner: DEV, pool: dammPool, nftMint: cityPos.nft, mintA: coin.mint, mintB: WSOL, accountA: devA, accountB: devWsol })], 'dev claims the city position'));
    await refused('harvest_pool_fees_on_dev_position', () => w.send([C.harvestPoolFees({ payer: w.payer.address, coin, dammPool, positionNftMint: devPos.nft })], [], 'harvest the dev position'));
    const fq = ata(founder.address, WSOL), fq0 = w.balance(fq);
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder], 'claim_founder_fees 2');
    fig('daily.founder_claimed', w.balance(fq) - fq0);
    state('end.DammPool', IDL.damm, 'Pool', dammPool);
    for (const p of positions) state(`end.Position.${p.owner}`, IDL.damm, 'Position', damm.position(p.nft));
    state('end.Coin', IDL.launchpad, 'Coin', coin.address);
    state('end.VirtualPool', IDL.dbc, 'VirtualPool', coin.dbcPool);
  }
  fig('end.dev_wallet_totals', `${w.balance(devWsol)}/${w.balance(ata(DEV, coin.mint))}`);
  fig('end.coins_checked_by_invariants', assertInvariants(w));
  out.configUnchanged = cfgBytes().equals(installed);
  out.versionAtEnd = cfgBytes()[VERSION_AT];
  out.configDiff = configDiff(asRpc(w.account(cfg)));
  return out;
}

describe('20 the live mainnet price curve (PoolConfig.version 0) on the pinned Meteora build', () => {
  it('TV01 the live bytes differ from what this build writes for the defaults only in PoolConfig.version, and both pass the check', async () => {
    const w = await World.create({ initLaunchpad: false, addConfig: false, initRewards: false });
    const made = Buffer.from(w.account(await w.createDbcConfig()).data);
    assert.equal(LIVE_ADDRESS, 'EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP');
    assert.equal(LIVE_ACC.owner, PROGRAM_IDS.dbc);
    assert.deepEqual([VERSION_AT, LIVE_BYTES[VERSION_AT], made[VERSION_AT]], [236, 0, 1]);
    assert.deepEqual([...made.keys()].filter((i) => made[i] !== LIVE_BYTES[i]), [VERSION_AT]);
    // the four transfer-fee fields of DBC 0.2.2 (the old padding_0, bytes 216-229) are zero in both: no transfer fee
    const F = LAYOUT.PoolConfig.fields;
    for (const b of [LIVE_BYTES, made]) assert.deepEqual([...b.subarray(F.transfer_fee_basis_points.at, F.padding_0.at + F.padding_0.size * (F.padding_0.count || 1))].filter(Boolean), []);
    assert.deepEqual(configDiff({ owner: PROGRAM_IDS.dbc, data: [LIVE_ACC.data, 'base64'] }), []);
    assert.deepEqual(configDiff({ owner: PROGRAM_IDS.dbc, data: [made.toString('base64'), 'base64'] }), []);
  });

  it('TV02 a coin\'s whole life on the live version-0 curve equals the same life on a version-1 curve, to the unit', async () => {
    const legacy = await lifeOn(true);
    const current = await lifeOn(false);
    assert.deepEqual([legacy.version, current.version], [0, 1]);
    // the live curve: still version 0 and byte for byte as installed after a whole life; it still passes the Worker's check
    assert.deepEqual([legacy.configUnchanged, legacy.versionAtEnd, legacy.configDiff], [true, 0, []]);
    assert.deepEqual([current.configUnchanged, current.versionAtEnd, current.configDiff], [true, 1, []]);
    // both graduated, nothing failed in the keeper's passes, the coin was checked by every invariant
    for (const r of [legacy, current]) {
      // migrated, migration progress 3 (CreatedPool), the leftover withdrawn, the city's share of the surplus taken
      assert.equal(r.figures['graduation.flags'], '1/3/1/1');
      assert.deepEqual([r.figures['minute_pass.failed'], r.figures['daily_pass.failed']], ['', '']);
      assert.equal(r.figures['end.coins_checked_by_invariants'], '1');
      for (const [k, v] of Object.entries(r.refusals)) assert.notEqual(v, 'not refused', k);
    }
    assert.deepEqual(legacy.refusals, current.refusals, 'the same refusals, with the same codes');
    assert.deepEqual(legacy.figures, current.figures, 'every amount equal');
    assert.deepEqual(legacy.states, current.states, 'the same account states (random addresses and times masked)');
  });
});
