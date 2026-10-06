// TJ01-TJ09: the TypeScript client SDK (sdk/launchpad/*.mts) against the real
// programs, in process:
//   TJ01 account decoders and fetchers read exactly what the chain holds
//   TJ02 launch (with the founder's first buy in the same transaction) from the builder
//   TJ03 quote parity: many random trades quoted by quote.mts and sent with the
//        trade.mts builders match DBC to the raw unit (amounts, price, every fee
//        share, the referral), and the slippage bounds the SDK sets are tight
//   TJ04 the harvest split the SDK predicts is what our program books
//   TJ05 SOL in and out: wrap before a buy, partial-fill refund and leftovers
//        come back as SOL, exact out, sells unwrap; no WSOL account is left behind
//   TJ06 coin to coin from quoteCoinToCoin + buildCoinToCoin; a missed minimum reverts both legs
//   TJ07 pay with anything, composed exactly as for Jupiter, with a real swap
//        standing in for Jupiter's (a DBC sell into the buyer's WSOL account):
//        the buy spends exactly the guaranteed minimum, the rest comes back as
//        SOL; the two-transaction fallback gives the same result
//   TJ08 sell into anything, the other direction
//   TJ09 graduation and leftover builders, then trading on the DAMM v2 pool
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import { World, C, ADDRESSES, PROGRAM_IDS, LAMPORTS, P, R, ata, damm, expectFail, harvest, fakeConnection } from './helpers.mjs';
import * as S from '../sdk/launchpad/index.mts';

const WSOL = ADDRESSES.wsol;
const STEPS = Number(process.env.CLIENT_PARITY_STEPS ?? 240);
const SEED = BigInt(process.env.CLIENT_PARITY_SEED ?? '424242');

function rng(seed) {
  let x = seed || 88172645463325252n;
  return () => { x ^= x << 13n; x &= (1n << 64n) - 1n; x ^= x >> 7n; x ^= x << 17n; x &= (1n << 64n) - 1n; return x; };
}
const market = (w, coin) => ({ pool: S.decodeDbcPool(w.account(coin.dbcPool).data), config: S.decodeDbcConfig(w.account(coin.dbcConfig).data) });
const toApi = (ix) => ({ programId: ix.programAddress, accounts: ix.accounts.map((a) => ({ pubkey: a.address, isSigner: (a.role & 2) !== 0, isWritable: (a.role & 1) !== 0 })), data: Buffer.from(ix.data).toString('base64') });
const rent165 = (w) => w.svm.minimumBalanceForRentExemption(165n);
const FEE = 5_000n; // one signature

describe('12 client SDK (TypeScript) against the real programs', () => {
  let w, founder, coin, referral;
  before(async () => {
    w = await World.create();
    referral = w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL); // the dev wallet's referral account
    founder = await w.signer(500n);
  });

  it('TJ01 + TJ02 launch with a first buy from the builder; every decoder and fetcher reads the chain exactly', async () => {
    const cityId = 120001n;
    await w.approve({ cityId, founder, name: 'Client City', symbol: 'CLIENT' });
    const conn = fakeConnection(w);
    const approval = await S.fetchApproval(conn, cityId);
    assert.deepEqual([approval.cityId, approval.founder, approval.name, approval.symbol, approval.dbcConfig, approval.rentPayer], [cityId, founder.address, 'Client City', 'CLIENT', w.config, w.admin.address]);
    assert.equal(S.accountKind(w.account(P.approval(cityId)).data), 'Approval');

    const mint = await generateKeyPairSigner();
    const cfg0 = S.decodeDbcConfig(w.account(w.config).data);
    // first buy quoted from the curve's start (no pool exists yet): the start state is the config's
    const startPool = { sqrtPrice: cfg0.sqrtStartPrice, quoteReserve: 0n, baseReserve: 0n };
    const firstBuy = S.quoteBuy(startPool, cfg0, { amountIn: 2n * LAMPORTS, slippageBps: 50 });
    const params = { founder: founder.address, baseMint: mint.address, cityId, dbcConfig: w.config, quoteMint: WSOL, rentPayer: w.admin.address, firstBuy: { amountIn: 2n * LAMPORTS, minOut: firstBuy.minOut } };
    const lut = S.lookupTableFrom('7UbiauZFTRXXy8zGMNYsZDPGu1NsDJTNVp7xX7sBQd6c', S.launchpadLookupTableAddresses({ dbcConfigs: [w.config] }));
    const withLut = S.planLaunch(params, [lut]);
    const noLut = S.planLaunch(params);
    console.log(`TJ02 launch + first buy: ${withLut.length} transaction(s) with the Vicinity lookup table (${withLut.map((t) => t.bytes).join(' + ')} bytes); without it ${noLut.length} (${noLut.map((t) => t.bytes).join(' + ')} bytes)`);
    assert.equal(withLut.length, 1, 'launch and first buy fit one transaction with the lookup table');
    assert.ok(withLut[0].bytes <= S.MAX_TX_BYTES);
    assert.deepEqual(new Set(withLut[0].signers), new Set([founder.address, mint.address]));
    // litesvm has no lookup tables: send the planned instructions as they are
    for (const t of noLut) await w.send(t.instructions, [founder, mint], `client ${t.label}`, { feePayer: founder, cu: t.cuLimit });
    coin = w.coin(cityId, founder);
    assert.equal(w.balance(ata(founder.address, coin.mint)), firstBuy.amountOut, 'the first buy got exactly the quoted coins');
    assert.equal(w.exists(ata(founder.address, WSOL)), false, 'no WSOL account left behind');
    assert.equal(coin.dbcPool, S.launchPoolAddress(params));

    // decoders = the harness's own reads
    const c = S.decodeCoin(w.account(coin.address).data);
    for (const k of ['address', 'cityId', 'founder', 'mint', 'quoteMint', 'dbcConfig', 'dbcPool', 'holdersPot', 'founderVault', 'launchedAt']) assert.equal(c[k], coin[k], k);
    assert.equal(S.accountKind(w.account(coin.address).data), 'Coin');
    assert.throws(() => S.decodeLaunchpad(w.account(coin.address).data), /not a Launchpad/);
    const lp = S.decodeLaunchpad(w.account(P.launchpad()).data);
    assert.deepEqual([lp.admin, lp.rewardsProgram, lp.payoutsConfigured, lp.launchesPaused], [w.admin.address, PROGRAM_IDS.rewards, false, false]);
    const lc = await S.fetchLaunchConfig(conn, w.config);
    assert.equal(lc.enabled, true);
    assert.equal(lc.migrationQuoteThreshold, 85n * LAMPORTS);
    const { pool, config } = market(w, coin);
    const hp = w.pool(coin.dbcPool);
    for (const k of ['creator', 'baseMint', 'quoteReserve', 'sqrtPrice', 'partnerQuoteFee', 'creatorQuoteFee', 'protocolQuoteFee', 'isMigrated']) assert.equal(pool[k], hp[k], k);
    const hc = w.curveConfig(coin.dbcConfig);
    for (const k of ['sqrtStartPrice', 'migrationSqrtPrice', 'migrationQuoteThreshold', 'feeNumerator', 'creatorTradingFeePercentage', 'swapBaseAmount', 'migrationBaseThreshold']) assert.equal(config[k], hc[k], k);
    assert.equal(config.feeClaimer, S.FEE_RECIPIENT);
    assert.equal(S.feeBpsOf(config), 125);
    const m = S.decodeMint(w.account(coin.mint).data);
    assert.deepEqual([m.supply, m.decimals, m.mintAuthority, m.freezeAuthority], [10n ** 15n, 6, null, null]);
    const md = S.decodeMetaplexMetadata(w.account(C.launchAccounts({ cityId, baseMint: coin.mint, dbcConfig: w.config, quoteMint: WSOL }).metadata).data);
    assert.deepEqual([md.name, md.symbol, md.uri, md.isMutable, md.updateAuthority], ['Client City', 'CLIENT', S.coinMetadataUri(coin.mint), false, PROGRAM_IDS.system]);
    assert.deepEqual(S.checkMetadataAgainstChain(S.coinMetadataJson({ mint: coin.mint, name: md.name, symbol: md.symbol, city: { id: cityId, name: 'Client City', ticker: 'CLIENT' } }), { mint: coin.mint, ...md }), []);
    const pot = S.decodeTokenAccount(w.account(coin.holdersPot).data);
    assert.deepEqual([pot.mint, pot.owner, pot.amount], [WSOL, coin.address, 0n]);
    // fetchers over the same RPC calls the website makes
    assert.equal((await S.fetchCoin(conn, cityId)).mint, coin.mint);
    assert.equal((await S.fetchCoinByMint(conn, coin.mint)).cityId, cityId);
    assert.equal(await S.fetchCoinByMint(conn, WSOL), null, 'a mint that is not a Vicinity coin');
    assert.deepEqual((await S.listCoins(conn)).map((x) => x.cityId), [cityId]);
    const mk = await S.fetchCoinMarket(conn, c);
    assert.deepEqual([mk.complete, mk.graduated, mk.pool.sqrtPrice], [false, false, hp.sqrtPrice]);
    assert.equal(await S.fetchRewards(conn, coin), null, 'no rewards config yet');
    await w.send([C.initRewardsForCoin({ payer: w.payer.address, registryAdmin: w.admin.address, authority: w.admin.address, coin })], [w.admin], 'rewards init_city');
    const rw = await S.fetchRewards(conn, coin);
    assert.deepEqual([rw.config.rewardModel, rw.config.founderBps, rw.config.rewardMint, rw.vault, rw.vaultBalance], ['Holders', 0, WSOL, R.vault(R.city(coin.mint)), 0n]);
    assert.ok(S.priceInQuote(pool.sqrtPrice, 9) > 2.79e-8);
    assert.ok(S.curveProgressBps(pool, config) > 0 && S.curveProgressBps(pool, config) < 10_000);
  });

  it(`TJ03 + TJ04 quote parity over ${STEPS} random trades, every fee share and the harvest split`, async () => {
    const next = rng(SEED);
    const pick = (n) => Number(next() % BigInt(n));
    const traders = [];
    for (let i = 0; i < 3; i++) { const t = await w.signer(); w.fundToken(t.address, WSOL, 400n * LAMPORTS); traders.push(t); }
    const counts = { buy: 0, partial: 0, buyExactOut: 0, sell: 0, sellExactOut: 0, tightChecks: 0, refusedBySdk: 0, curvesFilled: 0, harvests: 0 };
    let cur = coin; // the first coin (TJ02), then a fresh one each time a curve fills
    let creatorSinceHarvest = w.pool(cur.dbcPool).creatorQuoteFee; // the first buy's city share is waiting too
    let nextCity = 120100n;
    const harvestAndCheck = async () => {
      const st = w.pool(cur.dbcPool), cf = market(w, cur).config;
      const complete = st.quoteReserve >= cf.migrationQuoteThreshold;
      const surplus = complete && !st.isCreatorWithdrawSurplus ? S.curve.surplusShares(st.quoteReserve, cf.migrationQuoteThreshold, cf.creatorTradingFeePercentage).creator : 0n;
      assert.equal(st.creatorQuoteFee, creatorSinceHarvest, 'the city share the SDK summed is what DBC holds for the city');
      const expect = S.splitHarvest(creatorSinceHarvest + surplus);
      const pot0 = w.balance(cur.holdersPot), v0 = w.balance(cur.founderVault);
      await harvest(w, cur);
      assert.equal(w.balance(cur.holdersPot) - pot0, expect.toHolders, 'holders half');
      assert.equal(w.balance(cur.founderVault) - v0, expect.toFounder, 'founder half');
      creatorSinceHarvest = 0n;
      counts.harvests++;
    };
    let done = 0;
    while (done < STEPS) {
      const { pool, config } = market(w, cur);
      if (pool.quoteReserve >= config.migrationQuoteThreshold) {
        await harvestAndCheck(); // collects the city's surplus share too
        counts.curvesFilled++;
        cur = await w.launchCoin({ cityId: nextCity++, name: 'Parity', symbol: 'PARITY' });
        creatorSinceHarvest = 0n;
        continue;
      }
      const t = traders[pick(traders.length)];
      const coinBal = w.exists(ata(t.address, cur.mint)) ? w.balance(ata(t.address, cur.mint)) : 0n;
      const hasRef = pick(3) !== 0;
      const slippageBps = pick(4) === 0 ? 0 : pick(300);
      const common = { trader: t.address, coin: cur, referral: hasRef ? referral : null, handleSol: false };
      let q, ixs, tight, kind;
      const r = pick(100);
      try {
        if (r < 40 || coinBal < 1_000n) {
          // now and then a buy big enough to finish the curve (partial fill)
          const amountIn = pick(70) === 0 ? 100n * LAMPORTS : 1n + next() % (3n * LAMPORTS);
          q = S.quoteBuy(pool, config, { amountIn, slippageBps, referral: hasRef });
          kind = q.mode === 1 ? 'partial' : 'buy';
          ixs = S.buildBuy({ ...common, amountIn, minOut: q.amount1, mode: q.mode });
          tight = () => S.buildBuy({ ...common, amountIn, minOut: q.amount1 + 1n, mode: q.mode });
        } else if (r < 55) {
          const amountOut = 1n + next() % 20_000_000_000_000n;
          q = S.quoteBuyExactOut(pool, config, { amountOut, slippageBps, referral: hasRef });
          kind = 'buyExactOut';
          ixs = S.buildBuyExactOut({ ...common, amountOut, maxIn: q.amount1 });
          tight = () => S.buildBuyExactOut({ ...common, amountOut, maxIn: q.amount1 - 1n });
        } else if (r < 85) {
          const amountIn = 1n + next() % coinBal;
          q = S.quoteSell(pool, config, { amountIn, slippageBps, referral: hasRef });
          kind = 'sell';
          ixs = S.buildSell({ ...common, amountIn, minOut: q.amount1 });
          tight = () => S.buildSell({ ...common, amountIn, minOut: q.amount1 + 1n });
        } else {
          const amountOut = 1n + next() % (pool.quoteReserve / 10n + 1n);
          q = S.quoteSellExactOut(pool, config, { amountOut, slippageBps, referral: hasRef });
          if (q.amount1 > coinBal) { counts.refusedBySdk++; continue; }
          kind = 'sellExactOut';
          ixs = S.buildSell({ ...common, amountOut, maxIn: q.amount1, mode: 2 });
          tight = () => S.buildSell({ ...common, amountOut, maxIn: q.amount1 - 1n, mode: 2 });
        }
      } catch (e) {
        if (e instanceof S.CurveError) { counts.refusedBySdk++; continue; } // e.g. an exact out past the graduation price: the SDK refuses before the chain would
        throw e;
      }
      // at 0 slippage the bound the SDK computes is exactly tight: one unit tighter and DBC refuses
      if (slippageBps === 0 && q.amountOut > 1n) {
        await expectFail(() => w.send(tight(), [t], 'one unit too tight', { feePayer: t }), 'ExceededSlippage');
        counts.tightChecks++;
      }
      const b = { coin: w.exists(ata(t.address, cur.mint)) ? w.balance(ata(t.address, cur.mint)) : 0n, wsol: w.balance(ata(t.address, WSOL)), ref: w.balance(referral), pool: w.pool(cur.dbcPool) };
      await w.send(ixs, [t], `client ${kind}`, { feePayer: t });
      const a = { coin: w.balance(ata(t.address, cur.mint)), wsol: w.balance(ata(t.address, WSOL)), ref: w.balance(referral), pool: w.pool(cur.dbcPool) };
      const buy = q.side === 'buy';
      assert.equal(a.coin - b.coin, buy ? q.amountOut : -q.amountIn, `${kind} coins (trade ${done})`);
      assert.equal(a.wsol - b.wsol, buy ? -q.amountIn : q.amountOut, `${kind} quote (trade ${done})`);
      assert.equal(a.pool.sqrtPrice, q.sqrtPriceAfter, `${kind} price`);
      assert.equal(a.pool.quoteReserve, q.poolAfter.quoteReserve, `${kind} quote reserve`);
      assert.equal(a.pool.partnerQuoteFee - b.pool.partnerQuoteFee, q.fees.devWallet, `${kind} dev wallet share`);
      assert.equal(a.pool.creatorQuoteFee - b.pool.creatorQuoteFee, q.fees.city, `${kind} city share`);
      assert.equal(a.pool.protocolQuoteFee - b.pool.protocolQuoteFee, q.fees.meteora, `${kind} Meteora share`);
      assert.equal(a.ref - b.ref, q.fees.referral, `${kind} referral`);
      assert.equal(q.fees.total, q.fees.meteora + q.fees.referral + q.fees.devWallet + q.fees.city);
      assert.equal(q.completesCurve, a.pool.quoteReserve >= market(w, cur).config.migrationQuoteThreshold);
      counts[kind]++;
      done++;
      creatorSinceHarvest += q.fees.city;
      // TJ04: now and then, harvest; the pot and vault move by exactly splitHarvest
      if (pick(12) === 0) await harvestAndCheck();
    }
    console.log(`TJ03 ${JSON.stringify(counts)}`);
    assert.ok(counts.buy > 20 && counts.sell > 20 && counts.buyExactOut > 5 && counts.sellExactOut > 5 && counts.partial >= 1 && counts.tightChecks > 10, 'every kind of trade was exercised');
  });

  it('TJ05 SOL in and out: wrap, refund, exact out, unwrap; no WSOL account left behind', async () => {
    const b = await w.launchCoin({ cityId: 120002n, name: 'Wrap Town', symbol: 'WRAP' });
    const t = await w.signer(300n);
    const lam = () => w.lamportsOf(t.address);
    // buy 1.5 SOL from native SOL
    let { pool, config } = market(w, b);
    let q = S.quoteBuy(pool, config, { amountIn: 1_500_000_000n, slippageBps: 100 });
    let l0 = lam();
    await w.send(S.buildBuy({ trader: t.address, coin: b, amountIn: q.amountIn, minOut: q.minOut }), [t], 'buy with SOL', { feePayer: t });
    assert.equal(w.balance(ata(t.address, b.mint)), q.amountOut);
    assert.equal(w.exists(ata(t.address, WSOL)), false);
    assert.equal(l0 - lam(), q.amountIn + rent165(w) + FEE, 'paid exactly the quote plus the coin account rent and the fee');
    // exact out: wrap the maximum, unwrap what was not needed
    ({ pool, config } = market(w, b));
    q = S.quoteBuyExactOut(pool, config, { amountOut: 5_000_000_000_000n, slippageBps: 200 });
    l0 = lam();
    await w.send(S.buildBuyExactOut({ trader: t.address, coin: b, amountOut: 5_000_000_000_000n, maxIn: q.maxIn }), [t], 'exact out with SOL', { feePayer: t });
    assert.equal(l0 - lam(), q.amountIn + FEE, 'only the real cost left the wallet; the rest of the maximum came back');
    // sell everything back to SOL
    const coins = w.balance(ata(t.address, b.mint));
    ({ pool, config } = market(w, b));
    q = S.quoteSell(pool, config, { amountIn: coins, slippageBps: 100 });
    l0 = lam();
    await w.send(S.buildSell({ trader: t.address, coin: b, amountIn: coins, minOut: q.minOut }), [t], 'sell to SOL', { feePayer: t });
    assert.equal(lam() - l0, q.amountOut - FEE);
    assert.equal(w.exists(ata(t.address, WSOL)), false);
    // a buy far larger than the curve needs: partial fill, the refund comes back as SOL
    ({ pool, config } = market(w, b));
    q = S.quoteBuy(pool, config, { amountIn: 150n * LAMPORTS, slippageBps: 100 });
    assert.equal(q.mode, 1);
    assert.ok(q.refund > 60n * LAMPORTS);
    l0 = lam();
    await w.send(S.buildBuy({ trader: t.address, coin: b, amountIn: q.amount0, minOut: q.minOut, mode: q.mode }), [t], 'partial fill with SOL', { feePayer: t });
    assert.equal(l0 - lam(), q.amountIn + FEE, `only ${q.amountIn} spent; ${q.refund} refunded as SOL`);
    const after = market(w, b);
    assert.equal(after.pool.quoteReserve >= after.config.migrationQuoteThreshold, true, 'the curve is full');
    assert.equal(S.curveProgressBps(after.pool, after.config), 10_000);
    await expectFail(() => w.send(S.buildBuy({ trader: t.address, coin: b, amountIn: LAMPORTS, minOut: 1n }), [t], 'buy after completion', { feePayer: t }), 'PoolIsCompleted');
    assert.throws(() => S.quoteBuy(after.pool, after.config, { amountIn: LAMPORTS }), /PoolIsCompleted/);
  });

  it('TJ06 coin to coin in one transaction; a missed minimum reverts both legs', async () => {
    const a = await w.launchCoin({ cityId: 120003n, name: 'Alpha', symbol: 'ALPHA' });
    const b = await w.launchCoin({ cityId: 120004n, name: 'Beta', symbol: 'BETA' });
    const t = await w.signer(100n);
    let m = market(w, a);
    const qa = S.quoteBuy(m.pool, m.config, { amountIn: 3n * LAMPORTS });
    await w.send(S.buildBuy({ trader: t.address, coin: a, amountIn: 3n * LAMPORTS, minOut: qa.minOut }), [t], 'buy A', { feePayer: t });
    const held = w.balance(ata(t.address, a.mint));
    const q = S.quoteCoinToCoin(market(w, a), market(w, b), { amountIn: held / 2n, slippageBps: 100 });
    assert.ok(q.quoteMin < q.sell.amountOut);
    // B's minimum missed: everything reverts
    await expectFail(() => w.send(S.buildCoinToCoin({ trader: t.address, from: a, to: b, amountIn: held / 2n, quoteMin: q.quoteMin, minOut: q.buy.amountOut + 1n }), [t], 'coin to coin, too tight', { feePayer: t }), 'ExceededSlippage');
    assert.equal(w.balance(ata(t.address, a.mint)), held);
    const l0 = w.lamportsOf(t.address);
    const ixs = S.buildCoinToCoin({ trader: t.address, from: a, to: b, amountIn: held / 2n, quoteMin: q.quoteMin, minOut: q.minOut });
    console.log(`TJ06 coin to coin: ${S.measure(t.address, ixs)} bytes without a lookup table (limit ${S.MAX_TX_BYTES})`);
    assert.ok(S.measure(t.address, ixs) <= S.MAX_TX_BYTES);
    await w.send(ixs, [t], 'coin to coin', { feePayer: t });
    assert.equal(w.balance(ata(t.address, a.mint)), held - held / 2n);
    assert.equal(w.balance(ata(t.address, b.mint)), q.buy.amountOut, 'B bought with exactly quoteMin');
    assert.equal(w.exists(ata(t.address, WSOL)), false);
    assert.equal(w.lamportsOf(t.address) - l0, q.sell.amountOut - q.quoteMin - rent165(w) - FEE, 'the sell surplus above quoteMin came back as SOL');
    assert.throws(() => S.buildCoinToCoin({ trader: t.address, from: a, to: { ...b, quoteMint: ADDRESSES.feeRecipient }, amountIn: 1n, quoteMin: 1n, minOut: 1n }), /same quote token/);
  });

  it('TJ07 pay with anything: Jupiter-style composition, buy with exactly the guaranteed minimum; two-transaction fallback', async () => {
    // "pay with coin X": the stand-in swap is a real DBC sell of X into the buyer's WSOL account,
    // signed only by the buyer, exactly the shape of a Jupiter swap into SOL
    const x = await w.launchCoin({ cityId: 120005n, name: 'Paycoin', symbol: 'PAY' });
    const target = await w.launchCoin({ cityId: 120006n, name: 'Target', symbol: 'TARGET' });
    const run = async (maxBytes = S.MAX_TX_BYTES) => {
      const t = await w.signer(100n);
      let m = market(w, x);
      const qx = S.quoteBuy(m.pool, m.config, { amountIn: 4n * LAMPORTS });
      await w.send(S.buildBuy({ trader: t.address, coin: x, amountIn: 4n * LAMPORTS, minOut: qx.minOut }), [t], 'get X', { feePayer: t });
      const payWith = w.balance(ata(t.address, x.mint));
      m = market(w, x);
      const sq = S.quoteSell(m.pool, m.config, { amountIn: payWith, slippageBps: 100, referral: false });
      const build = {
        inputMint: x.mint, outputMint: WSOL, inAmount: String(payWith), outAmount: String(sq.amountOut), otherAmountThreshold: String(sq.minOut),
        swapMode: 'ExactIn', slippageBps: 100, routePlan: [{ swapInfo: { ammKey: x.dbcPool, label: 'stand-in (DBC sell)', inputMint: x.mint, outputMint: WSOL, inAmount: String(payWith), outAmount: String(sq.amountOut) } }],
        computeBudgetInstructions: [],
        setupInstructions: [toApi(S.createAta(t.address, t.address, WSOL))],
        swapInstruction: toApi(C.swap({ trader: t.address, pool: x.dbcPool, config: x.dbcConfig, baseMint: x.mint, quoteMint: WSOL, side: 'sell', amount0: payWith, amount1: sq.minOut })),
        cleanupInstruction: toApi(S.unwrapSol(t.address)), otherInstructions: [], tipInstruction: null,
        addressesByLookupTableAddress: {}, blockhashWithMetadata: { blockhash: Array(32).fill(7), lastValidBlockHeight: 1 },
      };
      const mt = market(w, target);
      const expected = S.quoteBuy(mt.pool, mt.config, { amountIn: sq.minOut, slippageBps: 100 });
      const plan = S.composePayWithAnything({ build, trader: t.address, coin: target, minCoinsOut: expected.minOut, jupiterProgram: PROGRAM_IDS.dbc, maxBytes });
      assert.equal(plan.buyAmountIn, sq.minOut);
      assert.equal(plan.expectedSurplus, sq.amountOut - sq.minOut);
      assert.equal(plan.surplusKept, 'SOL');
      const l0 = w.lamportsOf(t.address);
      for (const tx of plan.transactions) {
        assert.ok(tx.bytes <= Math.min(maxBytes, S.MAX_TX_BYTES) || plan.mode === 'two-transactions', `${tx.label} ${tx.bytes} bytes`);
        assert.ok(tx.bytes <= S.MAX_TX_BYTES, `${tx.label} ${tx.bytes} bytes`);
        await w.send(tx.instructions, [t], `pay with anything: ${tx.label}`, { feePayer: t, cu: tx.cuLimit });
      }
      assert.equal(w.balance(ata(t.address, target.mint)), expected.amountOut, 'coins bought with exactly the guaranteed minimum');
      assert.equal(w.balance(ata(t.address, x.mint)), 0n);
      assert.equal(w.exists(ata(t.address, WSOL)), false);
      // the swap's surplus above the minimum came back as SOL: besides it, only the new coin account's rent and the fees moved
      assert.equal(w.lamportsOf(t.address) - l0, plan.expectedSurplus - rent165(w) - FEE * BigInt(plan.transactions.length));
      return plan;
    };
    const one = await run();
    assert.equal(one.mode, 'one-transaction');
    const two = await run(one.transactions[0].bytes - 1); // force the fallback
    assert.equal(two.mode, 'two-transactions');
    assert.match(two.notes[0], /two transactions/);
    console.log(`TJ07 pay with anything: one transaction ${one.transactions[0].bytes} bytes; forced fallback ${two.transactions.map((t) => t.bytes).join(' + ')} bytes`);
  });

  it('TJ08 sell into anything: sell, then a swap of exactly the guaranteed quote into another asset', async () => {
    const a = await w.launchCoin({ cityId: 120007n, name: 'Seller', symbol: 'SELL' });
    const other = await w.launchCoin({ cityId: 120008n, name: 'Other', symbol: 'OTHER' });
    const t = await w.signer(100n);
    let m = market(w, a);
    const qa = S.quoteBuy(m.pool, m.config, { amountIn: 2n * LAMPORTS });
    await w.send(S.buildBuy({ trader: t.address, coin: a, amountIn: 2n * LAMPORTS, minOut: qa.minOut }), [t], 'buy A', { feePayer: t });
    const held = w.balance(ata(t.address, a.mint));
    m = market(w, a);
    const sq = S.quoteSell(m.pool, m.config, { amountIn: held, slippageBps: 100 });
    const mo = market(w, other);
    const bq = S.quoteBuy(mo.pool, mo.config, { amountIn: sq.minOut, slippageBps: 100, referral: false });
    const build = {
      inputMint: WSOL, outputMint: other.mint, inAmount: String(sq.minOut), outAmount: String(bq.amountOut), otherAmountThreshold: String(bq.minOut),
      swapMode: 'ExactIn', slippageBps: 100, routePlan: [{ swapInfo: { ammKey: other.dbcPool, label: 'stand-in (DBC buy)', inputMint: WSOL, outputMint: other.mint, inAmount: String(sq.minOut), outAmount: String(bq.amountOut) } }],
      computeBudgetInstructions: [], setupInstructions: [toApi(S.createAta(t.address, t.address, other.mint))],
      swapInstruction: toApi(C.swap({ trader: t.address, pool: other.dbcPool, config: other.dbcConfig, baseMint: other.mint, quoteMint: WSOL, side: 'buy', amount0: sq.minOut, amount1: bq.minOut })),
      cleanupInstruction: null, otherInstructions: [], tipInstruction: null, addressesByLookupTableAddress: {}, blockhashWithMetadata: { blockhash: Array(32).fill(3), lastValidBlockHeight: 1 },
    };
    const plan = S.composeSellIntoAnything({ build, trader: t.address, coin: a, coinAmountIn: held, minQuoteOut: sq.minOut, jupiterProgram: PROGRAM_IDS.dbc });
    assert.equal(plan.mode, 'one-transaction');
    const l0 = w.lamportsOf(t.address);
    await w.send(plan.transactions[0].instructions, [t], 'sell into anything', { feePayer: t });
    assert.equal(w.balance(ata(t.address, a.mint)), 0n);
    assert.equal(w.balance(ata(t.address, other.mint)), bq.amountOut);
    assert.equal(w.exists(ata(t.address, WSOL)), false);
    assert.equal(w.lamportsOf(t.address) - l0, sq.amountOut - sq.minOut - FEE - rent165(w), 'the sell surplus above the minimum came back as SOL (less the new coin account and the fee)');
    // a Jupiter response for another amount than the sell guarantees is refused
    assert.throws(() => S.composeSellIntoAnything({ build: { ...build, inAmount: String(sq.minOut + 1n) }, trader: t.address, coin: a, coinAmountIn: held, minQuoteOut: sq.minOut, jupiterProgram: PROGRAM_IDS.dbc }), /in amount/);
  });

  it('TJ09 graduation and leftover from the builders, then buy and sell on the DAMM v2 pool', async () => {
    const g = await w.launchCoin({ cityId: 120009n, name: 'Grad', symbol: 'GRAD' });
    const t = await w.signer(300n);
    let m = market(w, g);
    const fill = S.quoteFillCurve(m.pool, m.config, { referral: true });
    await w.send(S.buildBuy({ trader: t.address, coin: g, amountIn: fill.amount0, minOut: fill.minOut, mode: fill.mode }), [t], 'fill', { feePayer: t });
    m = market(w, g);
    assert.equal(S.curveProgressBps(m.pool, m.config), 10_000);
    const cranker = await w.signer(5n);
    const n1 = await generateKeyPairSigner(), n2 = await generateKeyPairSigner();
    await w.send(S.buildGraduate({ payer: cranker.address, coin: g, firstNftMint: n1.address, secondNftMint: n2.address }), [cranker, n1, n2], 'graduate (builder)', { feePayer: cranker, cu: S.CU.graduate });
    await w.send(S.buildWithdrawLeftover({ payer: cranker.address, coin: g }), [cranker], 'leftover (builder)', { feePayer: cranker });
    assert.ok(w.balance(ata(ADDRESSES.feeRecipient, g.mint)) > 0n, 'the unsold dust went to the dev wallet');
    m = market(w, g);
    assert.equal(m.pool.isMigrated, 1);
    const dammPool = damm.pool(ADDRESSES.dammCustomizableConfig, g.mint, WSOL);
    const b = await w.signer(10n);
    await w.send(S.buildPoolSwap({ trader: b.address, coin: g, dammPool, side: 'buy', amountIn: LAMPORTS, minOut: 1n }), [b], 'DAMM buy (builder)', { feePayer: b });
    const got = w.balance(ata(b.address, g.mint));
    assert.ok(got > 0n);
    assert.equal(w.exists(ata(b.address, WSOL)), false);
    await w.send(S.buildPoolSwap({ trader: b.address, coin: g, dammPool, side: 'sell', amountIn: got, minOut: 1n }), [b], 'DAMM sell (builder)', { feePayer: b });
    assert.equal(w.balance(ata(b.address, g.mint)), 0n);
    assert.equal(w.exists(ata(b.address, WSOL)), false);
  });
});
