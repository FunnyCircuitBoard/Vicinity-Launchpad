// TG01-TG08: graduation into Meteora DAMM v2 (permissionless crank), the
// locked liquidity, the leftover, fees after graduation, and griefing.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { generateKeyPairSigner } from '@solana/kit';
import { World, C, IDL, P, ADDRESSES, PROGRAM_IDS, LAMPORTS, SUPPLY, expectFail, assertInvariants, eventsNamed, harvest, buildIx, ata, damm, dbc, readU64, readKey, decodeAccount } from './helpers.mjs';
import { quoteSwap, SwapMode, Direction } from '../sdk/launchpad/curve.mjs';

const WSOL = ADDRESSES.wsol;
const { BN } = anchor;
const big = (x) => BigInt(x.toString());

async function migrate(w, coin, cranker) {
  const n1 = await generateKeyPairSigner(), n2 = await generateKeyPairSigner();
  const ix = C.migrateToDammV2({ payer: cranker.address, dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, quoteMint: WSOL, firstNftMint: n1.address, secondNftMint: n2.address });
  const res = await w.send([ix], [cranker, n1, n2], 'migration_damm_v2', { feePayer: cranker, cu: 400_000 });
  return { res, n1: n1.address, n2: n2.address, pool: damm.pool(ADDRESSES.dammCustomizableConfig, coin.mint, WSOL) };
}
function nftHolder(w, nftMint) { return readKey(w.account(damm.positionNftAccount(nftMint)).data, 32); }

describe('07 graduation', () => {
  let w, coin, g, founder, cranker;
  before(async () => {
    w = await World.create();
    founder = await w.signer();
    coin = await w.launchCoin({ cityId: 700001n, founder });
    await w.initRewardsCity(coin);
    cranker = await w.signer(10n);
  });

  it('TG07 migrating before the curve is complete is refused', async () => {
    const t = await w.signer();
    await w.trade(t, coin, { side: 'buy', amount0: 5n * LAMPORTS, amount1: 1n });
    // DBC refuses (NotPermitToDoThisAction in 0.2.1)
    await expectFail(() => migrate(w, coin, cranker), 'NotPermitToDoThisAction', 'PoolIsIncompleted');
  });

  it('TG06a nobody but DBC can create the pool under the DBC-only DAMM v2 config', async () => {
    const stranger = await w.signer();
    const nft = await generateKeyPairSigner();
    const pool = damm.pool(ADDRESSES.dammCustomizableConfig, coin.mint, WSOL);
    await w.trade(stranger, coin, { side: 'buy', amount0: LAMPORTS, amount1: 1n }); // it holds both tokens
    w.fundToken(stranger.address, WSOL, LAMPORTS);
    const ix = buildIx(IDL.damm, 'initialize_pool_with_dynamic_config', {
      params: {
        pool_fees: { base_fee: { data: Array(27).fill(0) }, compounding_fee_bps: 0, padding: 0, dynamic_fee: null },
        sqrt_min_price: new BN('4295048016'), sqrt_max_price: new BN('79226673521066979257578248091'), has_alpha_vault: false,
        liquidity: new BN('1000000000000'), sqrt_price: new BN('373894382314756693'), activation_type: 1, collect_fee_mode: 1, activation_point: null,
      },
    }, {
      creator: stranger.address, position_nft_mint: nft.address, position_nft_account: damm.positionNftAccount(nft.address), payer: stranger.address,
      pool_creator_authority: stranger.address, config: ADDRESSES.dammCustomizableConfig, pool, position: damm.position(nft.address),
      token_a_mint: coin.mint, token_b_mint: WSOL, token_a_vault: damm.tokenVault(coin.mint, pool), token_b_vault: damm.tokenVault(WSOL, pool),
      payer_token_a: ata(stranger.address, coin.mint), payer_token_b: ata(stranger.address, WSOL), token_a_program: PROGRAM_IDS.token,
      token_b_program: PROGRAM_IDS.token, event_authority: damm.eventAuthority(), program: PROGRAM_IDS.damm,
    });
    // DAMM v2 checks the config's pool_creator_authority (DBC's pool authority)
    const e = await expectFail(() => w.send([ix], [stranger, nft], 'stranger pool under A8gMrE', { cu: 400_000 }), 'ConstraintHasOne');
    console.log(`TG06a refused with: ${e.logs.filter((l) => /Error|failed/.test(l)).slice(0, 2).join(' | ')}`);
    assert.equal(w.exists(pool), false);
  });

  it('TG06b a stranger\'s own pool for the same pair does not stop or skew our graduation', async () => {
    // the stranger buys a few coins and opens a permissionless DAMM v2 pool for (coin, SOL) at a silly price
    const stranger = await w.signer();
    await w.trade(stranger, coin, { side: 'buy', amount0: LAMPORTS, amount1: 1n });
    w.fundToken(stranger.address, WSOL, LAMPORTS);
    const nft = await generateKeyPairSigner();
    const [hi, lo] = Buffer.compare(new web3.PublicKey(coin.mint).toBuffer(), new web3.PublicKey(WSOL).toBuffer()) > 0 ? [coin.mint, WSOL] : [WSOL, coin.mint];
    const pool = web3.PublicKey.findProgramAddressSync([Buffer.from('cpool'), new web3.PublicKey(hi).toBuffer(), new web3.PublicKey(lo).toBuffer()], new web3.PublicKey(PROGRAM_IDS.damm))[0].toBase58();
    const feeData = Buffer.alloc(27); feeData.writeBigUInt64LE(2_500_000n, 0); // 0.25% flat
    const ix = buildIx(IDL.damm, 'initialize_customizable_pool', {
      params: {
        pool_fees: { base_fee: { data: Array.from(feeData) }, compounding_fee_bps: 0, padding: 0, dynamic_fee: null },
        sqrt_min_price: new BN('4295048016'), sqrt_max_price: new BN('79226673521066979257578248091'), has_alpha_vault: false,
        liquidity: new BN('100000000000000000000000'), sqrt_price: new BN(String(1n << 64n)), activation_type: 1, collect_fee_mode: 0, activation_point: null,
      },
    }, {
      creator: stranger.address, position_nft_mint: nft.address, position_nft_account: damm.positionNftAccount(nft.address), payer: stranger.address,
      pool, position: damm.position(nft.address), token_a_mint: coin.mint, token_b_mint: WSOL,
      token_a_vault: damm.tokenVault(coin.mint, pool), token_b_vault: damm.tokenVault(WSOL, pool),
      payer_token_a: ata(stranger.address, coin.mint), payer_token_b: ata(stranger.address, WSOL), token_a_program: PROGRAM_IDS.token,
      token_b_program: PROGRAM_IDS.token, event_authority: damm.eventAuthority(), program: PROGRAM_IDS.damm,
    });
    try {
      await w.send([ix], [stranger, nft], 'stranger customizable pool', { cu: 400_000 });
      w.strangerPool = pool;
    } catch (e) {
      // if DAMM refuses these parameters the point still holds (no pool exists to interfere)
      console.log(`TG06b stranger pool not created: ${e.logs.filter((l) => /Error|failed/.test(l)).slice(0, 2).join(' | ')}`);
    }
    assert.notEqual(pool, damm.pool(ADDRESSES.dammCustomizableConfig, coin.mint, WSOL), 'a different address from the canonical pool');
  });

  it('TG01 + TG08 the crank graduates permissionlessly into a DAMM v2 pool at the curve end price, 1.25%, fees in SOL only', async () => {
    const cfg = w.curveConfig();
    const filler = await w.signer(200n);
    await w.trade(filler, coin, { side: 'buy', mode: SwapMode.PartialFill, amount0: 100n * LAMPORTS, amount1: 1n });
    assert.ok(w.pool(coin.dbcPool).quoteReserve >= cfg.migrationQuoteThreshold);
    const before = w.lamportsOf(cranker.address);
    g = await migrate(w, coin, cranker);
    const spent = before - w.lamportsOf(cranker.address);
    console.log(`TG08 migration_damm_v2 CU=${g.res.cu} cranker_spent_lamports=${spent} tx_bytes=${w.lastTxBytes}`);
    w.gradCu = g.res.cu; w.gradSpent = spent;
    assert.ok(g.res.cu < 400_000);
    const pool = decodeAccount(IDL.damm, 'Pool', w.account(g.pool).data);
    assert.equal(pool.token_a_mint.toBase58(), coin.mint);
    assert.equal(pool.token_b_mint.toBase58(), WSOL);
    assert.equal(pool.collect_fee_mode, 1, 'DAMM v2 OnlyB: fees in the quote token only');
    const feeInfo = Buffer.from(pool.pool_fees.base_fee.base_fee_info.data);
    assert.equal(feeInfo.readBigUInt64LE(0), 12_500_000n, '1.25% (DAMM fee denominator 1e9)');
    assert.equal(pool.pool_fees.dynamic_fee.initialized, 0, 'no dynamic fee');
    assert.equal(pool.pool_fees.compounding_fee_bps, 0);
    // opens at the curve's last price (within rounding)
    const s = big(pool.sqrt_price), m = cfg.migrationSqrtPrice;
    const diff = s > m ? s - m : m - s;
    assert.ok(diff * 1_000_000n <= m, `pool price ${s} vs curve end ${m}`);
    console.log(`TG01 damm_sqrt_price=${s} curve_end=${m} protocol_fee_percent=${pool.pool_fees.protocol_fee_percent} token_a=${big(pool.token_a_amount)} token_b=${big(pool.token_b_amount)} liquidity=${big(pool.liquidity)}`);
    w.dammPool = pool;
    // DBC marks the curve migrated
    assert.equal(w.pool(coin.dbcPool).isMigrated, 1);
  });

  it('TG02 one position for the dev wallet and one for the Coin PDA, both fully and permanently locked; nobody can remove liquidity', async () => {
    const holders = [nftHolder(w, g.n1), nftHolder(w, g.n2)];
    assert.deepEqual(holders.slice().sort(), [ADDRESSES.feeRecipient, coin.address].sort());
    const liq = {};
    for (const n of [g.n1, g.n2]) {
      const pos = decodeAccount(IDL.damm, 'Position', w.account(damm.position(n)).data);
      console.log(`TG02 position ${nftHolder(w, n)} unlocked=${big(pos.unlocked_liquidity)} vested=${big(pos.vested_liquidity)} permanent=${big(pos.permanent_locked_liquidity)}`);
      // DBC locks floor(liquidity); at most 1 unit of rounding dust stays unlocked
      // (about 1e-32 of the pool; our program has no way to remove liquidity at all)
      assert.ok(big(pos.unlocked_liquidity) <= 1n);
      assert.equal(big(pos.vested_liquidity), 0n);
      assert.ok(big(pos.permanent_locked_liquidity) > 10n ** 30n);
      liq[nftHolder(w, n)] = { locked: big(pos.permanent_locked_liquidity), unlocked: big(pos.unlocked_liquidity) };
    }
    console.log(`TG02 coin_pda_locked=${liq[coin.address].locked} unlocked=${liq[coin.address].unlocked} dev_wallet_locked=${liq[ADDRESSES.feeRecipient].locked} unlocked=${liq[ADDRESSES.feeRecipient].unlocked}`);
    w.liq = liq;
    // the dev wallet itself cannot pull its liquidity
    const devNft = nftHolder(w, g.n1) === ADDRESSES.feeRecipient ? g.n1 : g.n2;
    const devA = w.emptyTokenAccount(ADDRESSES.feeRecipient, coin.mint), devB = w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    const tooMuch = new BN(String(liq[ADDRESSES.feeRecipient].unlocked + 1n));
    const rm = buildIx(IDL.damm, 'remove_liquidity', { params: { liquidity_delta: tooMuch, token_a_amount_threshold: new BN(0), token_b_amount_threshold: new BN(0) } }, {
      pool: g.pool, position: damm.position(devNft), token_a_account: devA, token_b_account: devB,
      token_a_vault: damm.tokenVault(coin.mint, g.pool), token_b_vault: damm.tokenVault(WSOL, g.pool), token_a_mint: coin.mint, token_b_mint: WSOL,
      position_nft_account: damm.positionNftAccount(devNft), signer: ADDRESSES.feeRecipient, token_a_program: PROGRAM_IDS.token,
      token_b_program: PROGRAM_IDS.token, event_authority: damm.eventAuthority(), program: PROGRAM_IDS.damm,
    });
    await expectFail(() => w.sendAsDevWallet([rm], 'dev wallet remove_liquidity'));
    // and nobody else can act for the Coin PDA's position
    const coinNft = devNft === g.n1 ? g.n2 : g.n1;
    const stranger = await w.signer();
    const rm2 = buildIx(IDL.damm, 'remove_liquidity', { params: { liquidity_delta: new BN(1), token_a_amount_threshold: new BN(0), token_b_amount_threshold: new BN(0) } }, {
      pool: g.pool, position: damm.position(coinNft), token_a_account: w.emptyTokenAccount(stranger.address, coin.mint), token_b_account: w.emptyTokenAccount(stranger.address, WSOL),
      token_a_vault: damm.tokenVault(coin.mint, g.pool), token_b_vault: damm.tokenVault(WSOL, g.pool), token_a_mint: coin.mint, token_b_mint: WSOL,
      position_nft_account: damm.positionNftAccount(coinNft), signer: stranger.address, token_a_program: PROGRAM_IDS.token,
      token_b_program: PROGRAM_IDS.token, event_authority: damm.eventAuthority(), program: PROGRAM_IDS.damm,
    });
    await expectFail(() => w.send([rm2], [stranger]));
    w.coinNft = coinNft; w.devNft = devNft;
  });

  it('TG03 supply is still exactly 10^15; withdraw_leftover sends the dust to the dev wallet', async () => {
    const m = Buffer.from(w.account(coin.mint).data);
    assert.equal(readU64(m, 36), SUPPLY);
    const dest = w.emptyTokenAccount(ADDRESSES.feeRecipient, coin.mint);
    const before = w.balance(dest);
    const vaultBefore = w.balance(dbc.tokenVault(coin.mint, coin.dbcPool));
    const stranger = await w.signer();
    // permissionless, but it can only pay the leftover receiver (the dev wallet)
    await expectFail(() => w.send([C.withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, receiverAccount: w.emptyTokenAccount(stranger.address, coin.mint), leftoverReceiver: stranger.address })], [stranger]));
    await w.send([C.withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, receiverAccount: dest })], [], 'withdraw_leftover');
    const dust = w.balance(dest) - before;
    console.log(`TG03 leftover_to_dev_wallet=${dust} raw (${Number(dust) / 1e6} coins), dbc_base_vault_before=${vaultBefore}`);
    assert.ok(dust > 0n && dust < 100_000_000n, 'a few coins at most');
    assert.equal(readU64(Buffer.from(w.account(coin.mint).data), 36), SUPPLY);
  });

  it('TG05 harvest_curve_fees after graduation still collects the remaining curve fees', async () => {
    const creatorFee = w.pool(coin.dbcPool).creatorQuoteFee;
    assert.ok(creatorFee > 400_000_000n, `about 0.43 SOL of city fees from the whole curve (${creatorFee})`);
    const ev = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.equal(big(ev.claimed), creatorFee);
    assert.equal(w.pool(coin.dbcPool).creatorQuoteFee, 0n);
    assertInvariants(w);
  });

  it('TG04 harvest_pool_fees splits the pool fees (SOL only); the dev wallet claims its own position', async () => {
    const t = await w.signer();
    w.fundToken(t.address, WSOL, 20n * LAMPORTS);
    w.emptyTokenAccount(t.address, coin.mint);
    for (let i = 0; i < 3; i++) {
      await w.send([C.dammSwap({ trader: t.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: false, amountIn: 2n * LAMPORTS, minOut: 1n })], [t], 'damm swap buy');
      const coins = w.balance(ata(t.address, coin.mint));
      await w.send([C.dammSwap({ trader: t.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: true, amountIn: coins / 2n, minOut: 1n })], [t], 'damm swap sell');
    }
    const potBefore = w.balance(coin.holdersPot), vaultBefore = w.balance(coin.founderVault);
    const res = await harvest(w, coin, 'pool', { dammPool: g.pool, positionNftMint: w.coinNft });
    w.cu.harvest_pool_fees = w.lastCu;
    const ev = eventsNamed(res, 'FeesHarvested')[0].data;
    assert.equal(ev.source, 1);
    const claimed = big(ev.claimed);
    assert.ok(claimed > 0n);
    assert.equal(w.balance(coin.holdersPot) - potBefore, claimed - claimed / 2n);
    assert.equal(w.balance(coin.founderVault) - vaultBefore, claimed / 2n);
    assert.equal(w.balance(ata(coin.address, coin.mint)), 0n, 'no base fees');
    // the dev wallet's own position: quote fees only
    const devA = w.emptyTokenAccount(ADDRESSES.feeRecipient, coin.mint), devB = w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    const a0 = w.balance(devA), b0 = w.balance(devB);
    await w.sendAsDevWallet([C.dammClaimPositionFee({ owner: ADDRESSES.feeRecipient, pool: g.pool, nftMint: w.devNft, mintA: coin.mint, mintB: WSOL, accountA: devA, accountB: devB })], 'dev wallet claim_position_fee');
    const devClaim = w.balance(devB) - b0;
    assert.equal(w.balance(devA) - a0, 0n);
    console.log(`TG04 coin_pda_position_fees=${claimed} dev_wallet_position_fees=${devClaim}`);
    assert.ok(devClaim > 0n && claimed >= devClaim, 'the city position (with the dead liquidity) earns at least as much');
    // a position the Coin PDA does not hold is refused
    await expectFail(() => w.send([C.harvestPoolFees({ payer: w.payer.address, coin, dammPool: g.pool, positionNftMint: w.devNft })]), 'WrongPosition');
    // a pool of another pair is refused
    if (w.strangerPool) await expectFail(() => w.send([C.harvestPoolFees({ payer: w.payer.address, coin, dammPool: w.strangerPool, positionNftMint: w.coinNft })]), 'WrongPosition', 'WrongPool');
    // nothing left: a no-op
    const res2 = await harvest(w, coin, 'pool', { dammPool: g.pool, positionNftMint: w.coinNft });
    assert.equal(eventsNamed(res2, 'FeesHarvested').length, 0);
    // the holders' share goes on to the rewards vault as before
    await w.send([C.forwardHoldersFees({ coin })]);
    assert.equal(w.balance(coin.holdersPot), 0n);
  });
});
