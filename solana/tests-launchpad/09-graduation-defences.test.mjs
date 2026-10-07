// TG09-TG14: graduation can neither be blocked nor left half done, and nothing
// owed to the city or the dev wallet stays behind in Meteora's programs.
//
//   TG09 the city's share of DBC's completion surplus reaches the holders pot
//        (harvest before graduation, and harvest after graduation)
//   TG10 lamports sent in advance to every address graduation will create do
//        not block it (pre-creation griefing)
//   TG11 graduation is one atomic instruction: a failed attempt leaves no
//        partial state, and a retry succeeds
//   TG12 nothing can be done twice: a second graduation, a second leftover
//        withdrawal, a second surplus collection; strangers cannot take the
//        city's surplus
//   TG13 after every claim, what remains in DBC belongs to Meteora alone
//   TG14 the dev wallet's own surplus share and leftover reach it
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { World, C, IDL, ADDRESSES, LAMPORTS, SUPPLY, expectFail, assertInvariants, eventsNamed, harvest, ata, damm, dbc, readU64, decodeAccount, graduate, churn, completeCurve } from './helpers.mjs';
import { surplusShares } from '../sdk/launchpad/curve.mjs';

const WSOL = ADDRESSES.wsol;
const big = (x) => BigInt(x.toString());

/** The surplus split DBC will apply to `coin` right now. */
function shares(w, coin) {
  const p = w.pool(coin.dbcPool);
  const cfg = w.curveConfig(coin.dbcConfig);
  return surplusShares(p.quoteReserve, cfg.migrationQuoteThreshold, cfg.creatorTradingFeePercentage);
}

describe('09 graduation defences', () => {
  let w, cranker;
  before(async () => {
    w = await World.create();
    cranker = await w.signer(10n);
  });

  it('TG09a the city collects its share of the completion surplus with the first harvest after completion (before graduation)', async () => {
    const coin = await w.launchCoin({ cityId: 900001n });
    await w.initRewardsCity(coin);
    await churn(w, coin, { trades: 240, seed: 11 });
    // before completion there is no surplus and harvest only takes trading fees
    const r0 = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.equal(big(r0.surplus), 0n);
    await completeCurve(w, coin);
    const sh = shares(w, coin);
    console.log(`TG09 surplus after churn: total=${sh.total} creator=${sh.creator} partner=${sh.partner} protocol=${sh.protocol} lamports`);
    assert.ok(sh.creator > 0n, 'trading rounds in the pool\'s favour, so a busy curve ends above its target');
    const fees = w.pool(coin.dbcPool).creatorQuoteFee;
    const pot0 = w.balance(coin.holdersPot), vault0 = w.balance(coin.founderVault);
    const ev = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.equal(big(ev.surplus), sh.creator, 'exactly DBC\'s creator surplus');
    assert.equal(big(ev.claimed), fees + sh.creator, 'fees plus surplus');
    assert.equal(w.balance(coin.holdersPot) - pot0 + (w.balance(coin.founderVault) - vault0), fees + sh.creator, 'all of it reached the pot and the vault');
    assert.equal(w.pool(coin.dbcPool).isCreatorWithdrawSurplus, 1);
    // a second harvest finds nothing: the surplus is paid once
    const r2 = await harvest(w, coin);
    assert.equal(eventsNamed(r2, 'FeesHarvested').length, 0);
    // graduation still works with the city's surplus already out of DBC's vault
    const g = await graduate(w, coin, cranker);
    assert.equal(w.pool(coin.dbcPool).isMigrated, 1);
    assert.ok(w.exists(g.pool));
    w.tg09a = { coin, g };
  });

  it('TG09b ... or with the first harvest after graduation', async () => {
    const coin = await w.launchCoin({ cityId: 900002n });
    await churn(w, coin, { trades: 240, seed: 12 });
    await completeCurve(w, coin);
    const sh = shares(w, coin);
    const fees = w.pool(coin.dbcPool).creatorQuoteFee;
    await graduate(w, coin, cranker);
    const ev = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.equal(big(ev.surplus), sh.creator);
    assert.equal(big(ev.claimed), fees + sh.creator);
    assert.equal(w.pool(coin.dbcPool).creatorQuoteFee, 0n);
    w.tg09b = { coin };
  });

  it('TG09c a curve that ends exactly on its target has no surplus; the one-time collection is harmless', async () => {
    const coin = await w.launchCoin({ cityId: 900003n });
    await completeCurve(w, coin); // one partial fill from the start lands exactly on the target
    assert.equal(shares(w, coin).total, 0n);
    const ev = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.equal(big(ev.surplus), 0n);
    assert.equal(w.pool(coin.dbcPool).isCreatorWithdrawSurplus, 1, 'flag set by the zero payment, so it is never tried again');
    assert.equal(eventsNamed(await harvest(w, coin), 'FeesHarvested').length, 0);
  });

  it('TG10 lamports sent in advance to the pool and vault addresses do not block or skew graduation', async () => {
    const coin = await w.launchCoin({ cityId: 900010n });
    const pool = damm.pool(ADDRESSES.dammCustomizableConfig, coin.mint, WSOL);
    const targets = [pool, damm.tokenVault(coin.mint, pool), damm.tokenVault(WSOL, pool)];
    // a griefer funds each address it can predict: the smallest amount Solana lets an
    // empty account hold (rent-exempt for 0 bytes), half a SOL, and a token account's rent
    const amounts = [w.svm.minimumBalanceForRentExemption(0n), LAMPORTS / 2n, w.svm.minimumBalanceForRentExemption(165n)];
    targets.forEach((a, i) => w.svm.airdrop(a, amounts[i]));
    targets.forEach((a, i) => {
      assert.equal(w.lamportsOf(a), amounts[i]);
      assert.equal(String(w.account(a).programAddress), '11111111111111111111111111111111');
    });
    await completeCurve(w, coin);
    const g = await graduate(w, coin, cranker);
    const p = decodeAccount(IDL.damm, 'Pool', w.account(g.pool).data);
    assert.equal(p.token_a_mint.toBase58(), coin.mint);
    assert.equal(big(p.sqrt_price), w.curveConfig().migrationSqrtPrice, 'same opening price as without the donations');
    assert.equal(String(w.account(g.pool).programAddress), IDL.damm.address);
    // the vaults hold exactly what DBC deposited (the donated lamports became rent, not tokens)
    assert.equal(w.balance(damm.tokenVault(WSOL, g.pool)), big(p.token_b_amount));
    assert.equal(w.balance(damm.tokenVault(coin.mint, g.pool)), big(p.token_a_amount));
    w.tg10 = { a: big(p.token_a_amount), b: big(p.token_b_amount), liquidity: big(p.liquidity) };
    console.log(`TG10 graduation with pre-funded pool and vault addresses: CU=${g.res.cu}`);
  });

  it('TG11 graduation is atomic: a failed attempt leaves no pool and no state change; a retry succeeds', async () => {
    const coin = await w.launchCoin({ cityId: 900011n });
    await completeCurve(w, coin);
    const before = w.pool(coin.dbcPool);
    assert.equal(before.migrationProgress, 2, 'complete, and ready: no locked-vesting step (rule 7.2(11))');
    const pool = damm.pool(ADDRESSES.dammCustomizableConfig, coin.mint, WSOL);
    const quoteVaultBefore = w.balance(dbc.tokenVault(WSOL, coin.dbcPool));
    const baseVaultBefore = w.balance(dbc.tokenVault(coin.mint, coin.dbcPool));
    // (a) out of compute half way through
    await expectFail(() => graduate(w, coin, cranker, { cu: 120_000 }), /Computational budget exceeded|exceeded CUs meter|ComputationalBudgetExceeded/i);
    // (b) a cranker that cannot repay DBC's flash rent
    const poor = await w.signer(0n);
    w.svm.airdrop(poor.address, 20_000_000n); // 0.02 SOL: enough for fees, not for the pool's rent (about 0.03 SOL)
    const e = await expectFail(() => graduate(w, coin, poor));
    console.log(`TG11 poor cranker refused with: ${e.logs.filter((l) => /insufficient|Error|failed/i.test(l)).slice(0, 2).join(' | ')}`);
    const after = w.pool(coin.dbcPool);
    assert.equal(w.exists(pool), false, 'no DAMM v2 pool was left behind');
    assert.deepEqual([after.isMigrated, after.migrationProgress, after.quoteReserve, after.baseReserve], [before.isMigrated, before.migrationProgress, before.quoteReserve, before.baseReserve]);
    assert.equal(w.balance(dbc.tokenVault(WSOL, coin.dbcPool)), quoteVaultBefore);
    assert.equal(w.balance(dbc.tokenVault(coin.mint, coin.dbcPool)), baseVaultBefore);
    // (c) anyone else retries and it works, with the same pool as an undisturbed graduation
    const g = await graduate(w, coin, cranker);
    assert.equal(w.pool(coin.dbcPool).migrationProgress, 3);
    assert.ok(w.exists(g.pool));
    const p = decodeAccount(IDL.damm, 'Pool', w.account(g.pool).data);
    assert.deepEqual([big(p.token_a_amount), big(p.token_b_amount), big(p.liquidity)], [w.tg10.a, w.tg10.b, w.tg10.liquidity], 'TG10 (pre-funded) and TG11 pools are identical');
    w.tg11 = { coin, g };
  });

  it('TG12 nothing twice: second graduation, second leftover, second surplus; strangers cannot take the city\'s surplus', async () => {
    const { coin } = w.tg11;
    await expectFail(() => graduate(w, coin, cranker), 'NotPermitToDoThisAction');
    const dest = w.emptyTokenAccount(ADDRESSES.feeRecipient, coin.mint);
    await w.send([C.withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, receiverAccount: dest })], [], 'withdraw_leftover');
    await expectFail(() => w.send([C.withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, receiverAccount: dest })]), 'LeftoverHasBeenWithdraw');
    // a stranger posing as the creator cannot pull the city's surplus (only the Coin PDA can sign)
    const { coin: c2 } = w.tg09b; // its surplus was collected already; use a fresh complete coin
    const coin3 = await w.launchCoin({ cityId: 900012n });
    await churn(w, coin3, { trades: 120, seed: 13 });
    await completeCurve(w, coin3);
    const stranger = await w.signer();
    const to = w.emptyTokenAccount(stranger.address, WSOL);
    await expectFail(() => w.send([C.creatorWithdrawSurplus({ creator: stranger.address, dbcPool: coin3.dbcPool, dbcConfig: coin3.dbcConfig, quoteMint: WSOL, quoteAccount: to })], [stranger]), 'Unauthorized');
    assert.equal(w.pool(coin3.dbcPool).isCreatorWithdrawSurplus, 0);
    // and the harvest cannot be pointed elsewhere for the surplus (the pot is pinned by seeds)
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin: coin3, overrides: { holders_pot: to } })]), 'ConstraintSeeds');
    // another coin's config cannot be passed in to fake completion
    const otherConfig = await w.createDbcConfig();
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin: { ...coin3, dbcConfig: otherConfig } })]), 'LaunchConfigMismatch');
    const ev = eventsNamed(await harvest(w, coin3), 'FeesHarvested')[0].data;
    assert.ok(big(ev.surplus) > 0n);
    assert.equal(eventsNamed(await harvest(w, coin3), 'FeesHarvested').length, 0);
    assert.equal(eventsNamed(await harvest(w, c2), 'FeesHarvested').length, 0);
  });

  it('TG13 + TG14 after every claim, what is left in DBC belongs to Meteora alone; the dev wallet gets its surplus and leftover', async () => {
    const { coin } = w.tg09a; // churned, surplus collected for the city, graduated
    // the dev wallet's claims: trading fee, pool-creation fee, its surplus share, the leftover
    const sh = shares(w, coin);
    const devQuote = w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL), devBase = w.emptyTokenAccount(ADDRESSES.feeRecipient, coin.mint);
    const q0 = w.balance(devQuote);
    const partnerFee = w.pool(coin.dbcPool).partnerQuoteFee;
    await w.sendAsDevWallet([C.claimPartnerTradingFee({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, quoteMint: WSOL, baseAccount: devBase, quoteAccount: devQuote })], 'dev wallet claim_trading_fee');
    await w.sendAsDevWallet([C.partnerWithdrawSurplus({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, quoteMint: WSOL, quoteAccount: devQuote })], 'dev wallet partner_withdraw_surplus');
    assert.equal(w.balance(devQuote) - q0, partnerFee + sh.partner);
    await w.sendAsDevWallet([C.claimPartnerPoolCreationFee({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig })], 'dev wallet claim_partner_pool_creation_fee');
    const b0 = w.balance(devBase);
    await w.send([C.withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, receiverAccount: devBase })], [], 'withdraw_leftover');
    const leftover = w.balance(devBase) - b0;
    // the city: fees and surplus harvested, holders' half forwarded, founder's half claimed
    await harvest(w, coin);
    await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    await w.send([C.claimFounderFees({ founder: coin.founder, coin })], [coin.founderSigner], 'claim_founder_fees');
    // what is left in DBC's vaults: Meteora's protocol fees, its surplus share and its migration fee, nothing else
    const p = w.pool(coin.dbcPool);
    assert.equal(p.creatorQuoteFee + p.partnerQuoteFee + p.creatorBaseFee + p.partnerBaseFee, 0n);
    assert.equal(p.isCreatorWithdrawSurplus + p.isPartnerWithdrawSurplus + p.isWithdrawLeftover, 3);
    const quoteLeft = w.balance(dbc.tokenVault(WSOL, coin.dbcPool));
    const meteora = p.protocolQuoteFee + (p.isProtocolWithdrawSurplus ? 0n : sh.protocol) + p.protocolMigrationQuoteFee;
    assert.equal(quoteLeft, meteora, `DBC quote vault ${quoteLeft} = Meteora's ${meteora}`);
    const baseLeft = w.balance(dbc.tokenVault(coin.mint, coin.dbcPool));
    assert.equal(baseLeft, p.protocolBaseFee + p.protocolMigrationBaseFee);
    // the city's own accounts are empty, and no coin sits with the Coin PDA
    assert.equal(w.balance(coin.holdersPot), 0n);
    assert.equal(w.balance(coin.founderVault), 0n);
    assert.equal(w.balance(ata(coin.address, coin.mint)), 0n);
    // and every coin of the supply is accounted for: holders, the DAMM v2 pool, the dev wallet's leftover, Meteora's migration fee
    const m = Buffer.from(w.account(coin.mint).data);
    assert.equal(readU64(m, 36), SUPPLY);
    console.log(`TG13 left in DBC (Meteora's): quote=${quoteLeft} base=${baseLeft}; TG14 dev wallet surplus=${sh.partner} leftover=${leftover} raw coins`);
    assertInvariants(w);
  });
});
