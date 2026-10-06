// TE01-TE09: harvesting the city's fee share, the 50/50 split, forwarding to
// the checked vicinity_rewards vault (and a holder's claim), and the dev
// wallet's own claims at Meteora.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { World, C, IDL, P, R, ADDRESSES, PROGRAM_IDS, LAMPORTS, DAY, expectFail, assertInvariants, eventsNamed, harvest, buildIx, ata, tokenAccountData } from './helpers.mjs';
import { feeOnAmount, splitPartnerCreator } from '../sdk/launchpad/curve.mjs';
import { buildTree, claimArgs } from '../sdk/merkle.mjs';

const WSOL = ADDRESSES.wsol;
const rnd = () => web3.Keypair.generate().publicKey.toBase58();

/** Smallest buy (in lamports) whose city (creator) fee is exactly `target`. */
function buyForCreatorFee(target) {
  for (let a = 1n; a < 10n ** 9n; a++) {
    const f = feeOnAmount(12_500_000n, a, false);
    if (splitPartnerCreator(f.trading, 50n).creator === target) return a;
  }
  throw new Error('not found');
}

async function buy(w, coin, lamports) {
  const t = await w.signer();
  await w.trade(t, coin, { side: 'buy', amount0: lamports, amount1: 1n });
  return t;
}

describe('05 fees and rewards', () => {
  let w;
  before(async () => { w = await World.create(); });

  it('TE01 harvest_curve_fees is permissionless; split, counters and event match', async () => {
    const coin = await w.launchCoin({ cityId: 501n });
    await buy(w, coin, 4n * LAMPORTS);
    const creatorFee = w.pool(coin.dbcPool).creatorQuoteFee;
    assert.equal(creatorFee, 20_000_000n); // 0.5% of 4 SOL
    const stranger = await w.signer();
    const res = await w.send([C.harvestCurveFees({ payer: stranger.address, coin })], [stranger], 'harvest_curve_fees', { feePayer: stranger });
    w.harvests.set(coin.address, 1);
    const ev = eventsNamed(res, 'FeesHarvested')[0].data;
    assert.deepEqual([ev.source, ev.claimed.toString(), ev.to_holders.toString(), ev.to_founder.toString()], [0, '20000000', '10000000', '10000000']);
    const c = w.coin(coin.cityId);
    assert.equal(c.holdersAccrued, 10_000_000n);
    assert.equal(c.founderAccrued, 10_000_000n);
    assert.equal(w.balance(coin.holdersPot), 10_000_000n);
    assert.equal(w.balance(coin.founderVault), 10_000_000n);
    assert.equal(w.pool(coin.dbcPool).creatorQuoteFee, 0n);
    assert.ok(w.lastCu < 120_000, `harvest CU ${w.lastCu}`);
    w.cu.harvest_curve_fees = w.lastCu;
    assertInvariants(w);
  });

  it('TE02 a harvest with nothing to claim succeeds and changes nothing (no event)', async () => {
    const coin = await w.launchCoin({ cityId: 502n });
    const res = await harvest(w, coin);
    assert.equal(eventsNamed(res, 'FeesHarvested').length, 0);
    const c = w.coin(coin.cityId);
    assert.equal(c.holdersAccrued + c.founderAccrued, 0n);
    // two coins harvested in one keeper transaction, one of them empty
    const busy = await w.launchCoin({ cityId: 503n });
    await buy(w, busy, LAMPORTS);
    const res2 = await w.send([C.harvestCurveFees({ payer: w.payer.address, coin }), C.harvestCurveFees({ payer: w.payer.address, coin: busy })], [], 'batch harvest');
    assert.equal(eventsNamed(res2, 'FeesHarvested').length, 1);
    w.harvests.set(busy.address, 1);
    assertInvariants(w);
  });

  it('TE03 an odd claim of 1,001 units gives the founder 500 and the holders 501', async () => {
    const coin = await w.launchCoin({ cityId: 504n });
    const a = buyForCreatorFee(1001n);
    await buy(w, coin, a);
    assert.equal(w.pool(coin.dbcPool).creatorQuoteFee, 1001n);
    const ev = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.deepEqual([ev.claimed.toString(), ev.to_holders.toString(), ev.to_founder.toString()], ['1001', '501', '500']);
    assertInvariants(w);
  });

  it('TE04 donations to the pot or the vault leave the counters alone; forward and claim move the full balance', async () => {
    const coin = await w.launchCoin({ cityId: 505n });
    await buy(w, coin, LAMPORTS);
    w.donate(coin.holdersPot, 777n);
    w.donate(coin.founderVault, 333n);
    await harvest(w, coin);
    const c = w.coin(coin.cityId);
    assert.equal(c.holdersAccrued, 2_500_000n);
    assert.equal(c.founderAccrued, 2_500_000n);
    assert.equal(w.balance(coin.holdersPot), 2_500_777n);
    assert.equal(w.balance(coin.founderVault), 2_500_333n);
    assertInvariants(w);
    const { vault } = await w.initRewardsCity(coin);
    const res = await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    assert.equal(eventsNamed(res, 'HoldersFeesForwarded')[0].data.amount.toString(), '2500777');
    assert.equal(w.balance(vault), 2_500_777n);
    assert.equal(w.balance(coin.holdersPot), 0n);
    assert.equal(w.coin(coin.cityId).holdersForwarded, 2_500_777n);
    w.cu.forward_holders_fees = w.lastCu;
    const res2 = await w.send([C.claimFounderFees({ founder: coin.founder, coin })], [coin.founderSigner], 'claim_founder_fees');
    assert.equal(eventsNamed(res2, 'FounderFeesClaimed')[0].data.amount.toString(), '2500333');
    assert.equal(w.balance(ata(coin.founder, WSOL)), 2_500_333n);
    assert.equal(w.coin(coin.cityId).founderClaimed, 2_500_333n);
    assertInvariants(w);
  });

  it('TE05 forward, then fund_epoch_from_vault books it, then a holder claims it (Holders model)', async () => {
    const founder = await w.signer();
    const coin = await w.launchCoin({ cityId: 506n, founder });
    await buy(w, coin, 10n * LAMPORTS);
    await harvest(w, coin);
    const { config, vault } = await w.initRewardsCity(coin);
    await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    const pot = w.balance(vault);
    assert.equal(pot, 25_000_000n); // 0.25% of 10 SOL
    // a two-leaf snapshot of two holders
    const h1 = await w.signer(1n), h2 = await w.signer(1n);
    const tree = buildTree([{ claimant: h1.address, amount: 15_000_000n }, { claimant: h2.address, amount: 10_000_000n }]);
    const epoch = R.epoch(config, 0);
    await w.send([buildIx(IDL.rewards, 'fund_epoch_from_vault', {
      merkle_root: Array.from(tree.root), num_leaves: 2, snapshot_slot: new (await import('@coral-xyz/anchor')).default.BN(1),
      snapshot_hash: Array(32).fill(7), claim_window_secs: new (await import('@coral-xyz/anchor')).default.BN(String(30n * DAY)),
    }, {
      authority: w.admin.address, payer: w.payer.address, config, reward_mint: WSOL, vault, founder: founder.address,
      founder_token_account: ata(founder.address, WSOL), epoch, token_program: PROGRAM_IDS.token,
    })], [w.admin], 'rewards fund_epoch_from_vault');
    const { default: anchor } = await import('@coral-xyz/anchor');
    const args = claimArgs(tree, 0);
    await w.send([buildIx(IDL.rewards, 'claim', {
      epoch_index: new anchor.BN(0), leaf_index: 0, amount: new anchor.BN(String(args.amount)), proof: args.proof.map((p) => Array.from(p)),
    }, {
      claimant: h1.address, config, epoch, claim_status: R.claim(epoch, h1.address), reward_mint: WSOL, vault,
      claimant_token_account: ata(h1.address, WSOL), token_program: PROGRAM_IDS.token,
    })], [h1], 'rewards claim', { feePayer: h1 });
    assert.equal(w.balance(ata(h1.address, WSOL)), 15_000_000n);
    assert.equal(w.balance(vault), 10_000_000n);
    // the founder got nothing from the holders' share (Holders model, 0%)
    assert.equal(w.balance(ata(founder.address, WSOL)), 0n);
    assertInvariants(w);
  });

  it('TE06 forward refuses: another city, a fake vault, wrong mint or authority, Split or Creator model, another reward token', async () => {
    const a = await w.launchCoin({ cityId: 507n });
    const b = await w.launchCoin({ cityId: 508n });
    await buy(w, a, LAMPORTS);
    await harvest(w, a);
    const ra = await w.initRewardsCity(a);
    const rb = await w.initRewardsCity(b);
    const fwd = (overrides) => w.send([C.forwardHoldersFees({ coin: a, overrides })], [], 'forward');
    // no rewards config at all for a coin
    const c = await w.launchCoin({ cityId: 509n });
    // (its derived vault does not exist either, which Anchor reports first)
    await expectFail(() => w.send([C.forwardHoldersFees({ coin: c })]), 'WrongRewardsConfig', 'AccountNotInitialized');
    // another city's config and vault
    await expectFail(() => fwd({ rewards_city_config: rb.config, rewards_vault: rb.vault }), 'WrongRewardsConfig');
    // a's config with b's vault
    await expectFail(() => fwd({ rewards_vault: rb.vault }), 'WrongRewardsVault');
    // a look-alike token account (right mint, right authority) at a non-derived address
    const fake = rnd();
    w.setRaw(fake, tokenAccountData({ mint: WSOL, owner: ra.config, amount: 0n, native: w.svm.minimumBalanceForRentExemption(165n) }), PROGRAM_IDS.token);
    await expectFail(() => fwd({ rewards_vault: fake }), 'WrongRewardsVault');
    // the pot itself, or the dev wallet's account, as the destination
    await expectFail(() => fwd({ rewards_vault: a.holdersPot }), 'WrongRewardsVault');
    await expectFail(() => fwd({ rewards_vault: w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL) }), 'WrongRewardsVault');
    // a config account forged at the right address but owned by another program
    const d = await w.launchCoin({ cityId: 510n });
    const forged = R.city(d.mint);
    const cfgBytes = Buffer.from(w.account(ra.config).data);
    Buffer.from(new web3.PublicKey(d.mint).toBytes()).copy(cfgBytes, 104); // its own coin mint
    w.setRaw(forged, cfgBytes, PROGRAM_IDS.token);
    w.setRaw(R.vault(forged), tokenAccountData({ mint: WSOL, owner: forged, amount: 0n, native: w.svm.minimumBalanceForRentExemption(165n) }), PROGRAM_IDS.token);
    await expectFail(() => w.send([C.forwardHoldersFees({ coin: d })]), 'WrongRewardsConfig');
    // the same bytes owned by the rewards program but with another discriminator
    cfgBytes[0] ^= 0xff;
    w.setRaw(forged, cfgBytes, PROGRAM_IDS.rewards);
    await expectFail(() => w.send([C.forwardHoldersFees({ coin: d })]), 'WrongRewardsConfig');
    // Split and Creator models: the rewards authority could route the holders' money to a founder
    for (const [i, model, bps] of [[511n, { Split: {} }, 2500], [512n, { Creator: {} }, 10000]]) {
      const coin = await w.launchCoin({ cityId: i });
      await buy(w, coin, LAMPORTS);
      await harvest(w, coin);
      await w.initRewardsCity(coin, { model, founderBps: bps });
      await expectFail(() => w.send([C.forwardHoldersFees({ coin })]), 'WrongRewardsConfig');
      assert.equal(w.balance(coin.holdersPot), 2_500_000n, 'the pot keeps collecting');
    }
    // a rewards config paying in another token
    const e = await w.launchCoin({ cityId: 513n });
    await buy(w, e, LAMPORTS);
    await harvest(w, e);
    const otherMint = rnd();
    w.setRaw(otherMint, (await import('./helpers.mjs')).mintData({ decimals: 6 }), PROGRAM_IDS.token);
    await w.initRewardsCity(e, { rewardMint: otherMint });
    await expectFail(() => w.send([C.forwardHoldersFees({ coin: e })]), 'ConstraintTokenMint', 'WrongRewardsConfig');
    // the right one still works
    await fwd({});
    assertInvariants(w);
  });

  it('TE07 harvest, forward and founder claim all work while launches and payouts are paused', async () => {
    const founder = await w.signer();
    const coin = await w.launchCoin({ cityId: 514n, founder });
    await w.initRewardsCity(coin);
    await buy(w, coin, LAMPORTS);
    await w.send([C.setPause({ authority: w.admin.address, launches: true, payouts: true })], [w.admin]);
    await harvest(w, coin);
    await w.send([C.forwardHoldersFees({ coin })]);
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder]);
    assert.equal(w.balance(ata(founder.address, WSOL)), 2_500_000n);
    await w.send([C.setPause({ authority: w.admin.address, launches: false, payouts: false })], [w.admin]);
    assertInvariants(w);
  });

  it("TE08 coin A cannot claim coin B's DBC fees, and B's pot cannot be passed to A", async () => {
    const a = await w.launchCoin({ cityId: 515n });
    const b = await w.launchCoin({ cityId: 516n });
    await buy(w, b, LAMPORTS);
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin: { ...a, dbcPool: b.dbcPool } })]), 'PoolCreatorMismatch');
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin: a, overrides: { holders_pot: b.holdersPot } })]), 'ConstraintSeeds');
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin: a, overrides: { founder_vault: b.founderVault } })]), 'ConstraintSeeds');
    // B's creator fee is still there for B
    assert.equal(w.pool(b.dbcPool).creatorQuoteFee, 5_000_000n);
    await harvest(w, b);
    assertInvariants(w);
  });

  it('TE09 only the dev wallet claims the partner trading fee and 90% of the launch fee', async () => {
    const coin = await w.launchCoin({ cityId: 517n });
    await buy(w, coin, 2n * LAMPORTS);
    const partnerFee = w.pool(coin.dbcPool).partnerQuoteFee;
    assert.equal(partnerFee, 10_000_000n);
    const stranger = await w.signer();
    const sa = w.emptyTokenAccount(stranger.address, WSOL), sb = w.emptyTokenAccount(stranger.address, coin.mint);
    await expectFail(() => w.send([C.claimPartnerTradingFee({ feeClaimer: stranger.address, dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, quoteMint: WSOL, baseAccount: sb, quoteAccount: sa })], [stranger]), 'Unauthorized', /0x17a5/);
    await expectFail(() => w.send([C.claimPartnerPoolCreationFee({ feeClaimer: stranger.address, dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig })], [stranger]), 'Unauthorized', /0x17a5/);
    const devQuote = w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    const devBase = w.emptyTokenAccount(ADDRESSES.feeRecipient, coin.mint);
    const before = w.balance(devQuote);
    await w.sendAsDevWallet([C.claimPartnerTradingFee({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, quoteMint: WSOL, baseAccount: devBase, quoteAccount: devQuote })], 'dev wallet claim_trading_fee');
    assert.equal(w.balance(devQuote) - before, 10_000_000n);
    const lamBefore = w.lamportsOf(ADDRESSES.feeRecipient);
    await w.sendAsDevWallet([C.claimPartnerPoolCreationFee({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig })], 'dev wallet claim_partner_pool_creation_fee');
    assert.equal(w.lamportsOf(ADDRESSES.feeRecipient) - lamBefore, 45_000_000n); // 90% of 0.05 SOL
    assertInvariants(w);
  });
});

