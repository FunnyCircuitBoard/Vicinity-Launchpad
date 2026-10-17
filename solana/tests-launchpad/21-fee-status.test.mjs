// TQ01-TQ07: the fee status the website shows (src/feestatus.js, GET /api/fee-status) against the REAL programs, in process. The
// Worker's reader runs unchanged over a JSON-RPC stand-in that answers from this World (genesis hash, getProgramAccounts for the
// official list, getMultipleAccounts at the VM's slot, getTokenAccountsByOwner for the position NFTs), and every number it gives is
// compared with what the program wrote, read back with the SDK's anchor decoder, and with what the next harvest really moves:
//   TQ01 a launch: an official coin, every counter 0, the founder is the record's, no payout opt-in, no rewards vault yet
//   TQ02 trades, harvest, claim, payout-free: earned / collected / ready / still in the pool equal the Coin record's counters, the
//        vault's and the pot's balances and the curve's creator fee; the founder's part still in the pool is exactly what the next
//        harvest_curve_fees books for the founder; a stranger's gift to the vault leaves with the claim and is counted as collected
//   TQ03 holder rewards set up (Holders only), forward_holders_fees: the pot moves to the rewards vault, holders.forwarded and the vault's
//        balance say so; then the founder's Collect (harvest_curve_fees + claim_founder_fees in one transaction, as src/lplaunch.js
//        founderClaimTx builds it) pays exactly the vault plus the founder's part still in the curve
//   TQ04 the curve fills after many trades: read before any harvest, the city's fees still in the curve include its share of DBC's
//        completion surplus, and the next harvest (after graduation) claims exactly that, split once; then DAMM v2 trades: the city's
//        position (DAMM v2's own update_fee, from the pool's and the position's bytes) is exactly what harvest_pool_fees then claims;
//        the dev wallet's position is never counted
//   TQ05 a position NFT given to the record lands in an account of the giver's choice (here the record's own associated account, not
//        DAMM v2's ["position_nft_account", mint] address): DAMM v2 makes position NFTs transferable and harvest_pool_fees takes any
//        account of the record holding 1, so the Worker counts it, and each harvest_pool_fees then moves exactly the Worker's figure.
//        Given while a reading is under way (between its listing of the record's accounts and its last answer), that reading withholds
//        the estimate alone (every exact figure as the program wrote it), and the next one counts it. Then the founder's Collect after
//        graduation (claim_founder_fees): the founder card's own rule (public/lp-launch.js) refuses the reading from before it against
//        the status read after it, and shows the one after it
//   TQ03 also runs that rule on the curve: the reading from before the Collect (harvest + claim) is refused, the one after it shown
//   The status's own figures there are src/lplaunch.js founderFees itself, read over this World: the vault, the curve and the Coin
//   record's counters (founder_accrued; founder_claimed + founder_paid_out) from one answer, checked against what the program wrote
//   after the claim, both Collects and the payout
//   TQ06 a payout the founder agreed to (payout_founder_fees to the one payout wallet): the fee status's paid out and collected and
//   the status's collected counter equal the record's; the reading from before it is refused by that counter even after the vault
//   filled up past it again (the balances alone could not tell), and the one after it is shown with "Collected or paid out since
//   launch" and "Of that, paid out"
// With RECORD=1 every reading's accounts are written to test/fixtures/launchpad-worker/fee-status.json, which the root suite replays
// without litesvm (test/fee-status.test.js).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { address as kitAddress } from '@solana/kit';
import { World, ADDRESSES, PROGRAM_IDS, LAMPORTS, C, P, R, IDL, Role, ata, damm, graduate, completeCurve, churn, harvest, eventsNamed, assertInvariants, decodeAccount } from './helpers.mjs';
import { d1 } from '../../test/helpers/d1.js';
import { ensureSchema } from '../../src/store.js';
import { feeStatus, splitFee, _resetFeeStatus } from '../../src/feestatus.js';
import { founderFees } from '../../src/lplaunch.js';
import { lpSetup } from '../../src/cluster.js';
import { decodeCoin } from '../../src/sol/dbc.js';
import { surplusShares } from '../sdk/launchpad/curve.mjs';
import { _resetOfficialCoins } from '../../src/officialcoins.js';
import { _resetLpKit, GENESIS } from '../../src/lpkit.js';
import { _resetLpCoins } from '../../src/lpcoins.js';
import { _resetRpcHealth } from '../../src/rpcpool.js';
import { base58Decode } from '../../src/solana.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The founder card's own helpers (public/lp-launch.js, as the dashboard runs them): feeCardView, freshAfterCollect, olderThanStatus. */
const card = (() => { const ctx = vm.createContext({ console }); vm.runInContext(readFileSync(join(here, '..', '..', 'public', 'lp-launch.js'), 'utf8'), ctx); return ctx.LPLaunch.pure; })();
/** The answer GET /api/fee-status gives for a reading: amounts as decimal strings. */
const answerOf = (s) => ({ ok: true, ...JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) });
const WSOL = ADDRESSES.wsol;
const RPC = 'https://litesvm.test/fee-status';
const asRpc = (acc) => (acc ? { owner: String(acc.programAddress), lamports: Number(acc.lamports), data: [Buffer.from(acc.data).toString('base64'), 'base64'], executable: Boolean(acc.executable), rentEpoch: 0, space: Buffer.from(acc.data).length } : null);
const big = (x) => BigInt(String(x));
const T22 = PROGRAM_IDS.token2022;
/** The Associated Token program's CreateIdempotent for a Token-2022 mint: anyone can make `owner`'s own account for `mint`. */
const createAta = (payer, owner, mint) => ({
  programAddress: PROGRAM_IDS.ata, data: new Uint8Array([1]),
  accounts: [{ address: payer, role: Role.WS }, { address: ata(owner, mint, T22), role: Role.W }, { address: owner, role: Role.R },
    { address: mint, role: Role.R }, { address: PROGRAM_IDS.system, role: Role.R }, { address: T22, role: Role.R }],
});
/** Token-2022 TransferChecked (12): `amount` of `mint` (`decimals`) from `source` to `dest`, signed by `authority`. */
function transferChecked(source, mint, dest, authority, amount, decimals) {
  const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(amount, 1); d[9] = decimals;
  return { programAddress: T22, data: new Uint8Array(d), accounts: [{ address: source, role: Role.W }, { address: mint, role: Role.R }, { address: dest, role: Role.W }, { address: authority, role: Role.RS }] };
}

/**
 * A JSON-RPC stand-in over the World, with the reads the fee status makes; every address it answers is remembered in `seen`.
 * `hooks.afterList` (once): runs on the World right after a getTokenAccountsByOwner was answered, before the reading goes on.
 */
function worldRpc(w, seen, hooks = {}) {
  const slot = () => Math.max(1, Number(w.svm.getClock().slot));
  const memcmp = (d, m) => { const want = Buffer.from(base58Decode(m.bytes)); return want.equals(d.subarray(m.offset, m.offset + want.length)); };
  return async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    let result;
    const tooEarly = (cfg) => cfg && cfg.minContextSlot != null && cfg.minContextSlot > slot();
    switch (method) {
      case 'getGenesisHash': result = GENESIS.devnet; break;
      case 'getMultipleAccounts':
        if (tooEarly(params[1])) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'Minimum context slot has not been reached' } }));
        for (const a of params[0]) seen.add(a);
        result = { context: { slot: slot() }, value: params[0].map((a) => asRpc(w.account(a))) };
        break;
      case 'getProgramAccounts': {
        const [program, cfg] = params;
        const rows = w.svm.getProgramAccounts(kitAddress(program)).filter((x) => {
          const d = Buffer.from(x.data);
          return (cfg.filters || []).every((f) => (f.dataSize != null ? d.length === f.dataSize : memcmp(d, f.memcmp)));
        }).map((x) => ({ pubkey: String(x.address), account: asRpc(x) }));
        for (const r of rows) seen.add(r.pubkey);
        result = cfg.withContext ? { context: { slot: slot() }, value: rows } : rows;
        break;
      }
      case 'getTokenAccountsByOwner': {
        const [owner, { programId }, cfg] = params;
        if (tooEarly(cfg)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'Minimum context slot has not been reached' } }));
        const want = Buffer.from(base58Decode(owner));
        const rows = w.svm.getProgramAccounts(kitAddress(programId)).filter((x) => Buffer.from(x.data).length >= 64 && want.equals(Buffer.from(x.data).subarray(32, 64)))
          .map((x) => ({ pubkey: String(x.address), account: asRpc(x) }));
        for (const r of rows) seen.add(r.pubkey);
        result = { context: { slot: slot() }, value: rows };
        if (hooks.afterList) { const f = hooks.afterList; hooks.afterList = null; await f(); }
        break;
      }
      default: throw new Error(`unexpected ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
}

describe('21 the fee status against the real programs', () => {
  let w, env, rpc, coin, founder, trader, g, cityNft, t2, t = Date.now();
  const seen = new Set(), hooks = {};
  const readings = [];
  /** A fresh reading that is not written to the fixture. */
  const peek = async () => { t += 61_000; seen.clear(); return feeStatus(env, coin.mint, rpc, t); };
  /** The chain moves on by one slot (the clock's time stays: our curves and pools count time, not slots); returns the new slot. */
  const nextSlot = () => { const c = w.svm.getClock(); c.slot += 1n; w.svm.setClock(c); return Number(c.slot); };
  /**
   * The launched status's own fee figures now: src/lplaunch.js founderFees itself, over this World (one getMultipleAccounts), checked
   * against what the program wrote: the vault, half the curve's creator fee before graduation, the Coin record's counters, the slot.
   */
  async function statusFees() {
    const c = w.coin(coin.cityId, founder), p = w.pool(c.dbcPool);
    const f = await founderFees(env, lpSetup(env), decodeCoin(asRpc(w.account(c.address)), PROGRAM_IDS.launchpad), rpc);
    const inVault = w.balance(c.founderVault), onCurve = p.isMigrated ? 0n : p.creatorQuoteFee / 2n;
    assert.deepEqual([f.inVaultLamports, f.onCurveLamports, f.totalLamports, f.slot], [String(inVault), String(onCurve), String(inVault + onCurve), Math.max(1, Number(w.svm.getClock().slot))]);
    assert.equal(f.earnedLamports, String(c.founderAccrued), 'the status\'s earned = Coin.founder_accrued');
    assert.equal(f.collectedLamports, String(c.founderClaimed + c.founderPaidOut), 'the status\'s collected = Coin.founder_claimed + Coin.founder_paid_out');
    return f;
  }
  /** The Worker's fee status now (a fresh reading: the memos are a minute, so the clock moves on by one). */
  async function status(name) {
    t += 61_000;
    seen.clear();
    const s = await feeStatus(env, coin.mint, rpc, t);
    assert.ok(s, 'an official coin');
    readings.push({ name, accounts: Object.fromEntries([...seen].sort().map((a) => [a, asRpc(w.account(a))])), status: JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) });
    return s;
  }
  /** What the program wrote, read back with the SDK's anchor decoder, against the Worker's figures. */
  function sameAsProgram(s) {
    const c = w.coin(coin.cityId, founder);
    assert.equal(s.founder.earned, c.founderAccrued, 'founder.earned = Coin.founder_accrued');
    assert.equal(s.founder.claimed, c.founderClaimed, 'founder.claimed = Coin.founder_claimed');
    assert.equal(s.founder.paidOut, c.founderPaidOut, 'founder.paidOut = Coin.founder_paid_out');
    assert.equal(s.founder.collected, c.founderClaimed + c.founderPaidOut);
    assert.equal(s.holders.earned, c.holdersAccrued, 'holders.earned = Coin.holders_accrued');
    assert.equal(s.holders.forwarded, c.holdersForwarded, 'holders.forwarded = Coin.holders_forwarded');
    assert.equal(s.city.harvested, c.founderAccrued + c.holdersAccrued);
    assert.equal(s.founder.claimable, w.balance(c.founderVault), 'founder.claimable = the founder vault');
    assert.equal(s.holders.pot, w.balance(c.holdersPot), 'holders.pot = the holders pot');
    const p = w.pool(c.dbcPool), cfg = w.decodeConfig(c.dbcConfig);
    assert.equal(s.pool.curve, p.creatorQuoteFee, 'pool.curve = VirtualPool.creator_quote_fee');
    // the city's share of the completion surplus still to take: the SDK's own split, while the curve is full and it is not taken yet
    const due = p.quoteReserve >= BigInt(cfg.migration_quote_threshold.toString()) && p.isCreatorWithdrawSurplus === 0;
    assert.equal(s.pool.surplus, due ? surplusShares(p.quoteReserve, BigInt(cfg.migration_quote_threshold.toString()), BigInt(cfg.creator_trading_fee_percentage)).creator : 0n, 'pool.surplus = the creator surplus DBC still owes');
    // the payout opt-in: none until TQ06; then the founder's own (payouts are off until then)
    const optIn = w.account(P.payoutOptIn(c.address));
    const agreed = Boolean(optIn) && decodeAccount(IDL.launchpad, 'PayoutOptIn', optIn.data).founder.toBase58() === c.founder;
    assert.equal(s.founder.payoutAgreed, agreed, 'founder.payoutAgreed = an opt-in of the record\'s founder');
    assert.equal(s.founder.wallet, `${c.founder.slice(0, 5)}*****${c.founder.slice(-3)}`, 'the record\'s founder, masked');
    assert.deepEqual([s.coin.address, s.coin.mint, s.coin.quoteMint, s.coin.dbcPool], [c.address, c.mint, c.quoteMint, c.dbcPool]);
    assert.deepEqual(s.coin.quote, { symbol: 'SOL', decimals: 9 });
    assert.equal(s.source.accounts.founderVault, c.founderVault);
    assert.equal(s.source.accounts.holdersPot, c.holdersPot);
    assert.equal(s.source.accounts.dbcConfig, c.dbcConfig);
  }

  before(async () => {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit(); _resetLpCoins(); _resetRpcHealth();
    w = await World.create();
    w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    rpc = worldRpc(w, seen, hooks);
    founder = await w.signer(50n);
    trader = await w.signer(500n);
    env = { DB: d1(), LAUNCHPAD_CLUSTER: 'devnet', LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpad, LAUNCHPAD_REWARDS_PROGRAM_ID: PROGRAM_IDS.rewards, LAUNCHPAD_RPC_URL: RPC, LAUNCHPAD_DBC_CONFIGS: w.config };
    await ensureSchema(env.DB);
  });

  it('TQ01 a launch: official, every counter 0, the founder is the record\'s, no rewards vault yet', async () => {
    coin = await w.launchCoin({ cityId: 210001n, founder, name: 'Fee City', symbol: 'FEE' });
    const s = await status('launched');
    sameAsProgram(s);
    assert.deepEqual([s.city.harvested, s.founder.earned, s.founder.collected, s.founder.claimable, s.founder.pendingInPool, s.holders.pot, s.holders.forwarded], [0n, 0n, 0n, 0n, 0n, 0n, 0n]);
    assert.equal(s.holders.vault, null, 'no rewards config for the city yet');
    assert.equal(s.coin.graduated, false);
    assert.equal(await feeStatus(env, trader.address, rpc, t + 1), null, 'an address that is no official coin');
  });

  it('TQ02 trades, harvest, claim: the Worker reads what the program wrote; the founder\'s part still in the pool is what the next harvest books', async () => {
    for (let i = 0; i < 4; i++) await w.trade(trader, coin, { side: 'buy', amount0: 3n * LAMPORTS, amount1: 1n });
    await w.trade(trader, coin, { side: 'sell', amount0: w.balance(ata(trader.address, coin.mint)) / 3n, amount1: 0n });
    let s = await status('traded');
    sameAsProgram(s);
    assert.ok(s.pool.curve > 0n, 'fees wait on the curve');
    assert.equal(s.city.pendingInPool, s.pool.curve);
    assert.equal(s.founder.pendingInPool, s.pool.curve / 2n);
    assert.equal(s.holders.pendingInPool, s.pool.curve - s.pool.curve / 2n);
    const before = s;
    const ev = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.equal(big(ev.claimed), before.city.pendingInPool, 'the harvest claimed exactly what was still in the pool');
    assert.deepEqual([big(ev.to_founder), big(ev.to_holders)], [before.founder.pendingInPool, before.holders.pendingInPool], 'and split it as the status said');
    s = await status('harvested');
    sameAsProgram(s);
    assert.equal(s.founder.earned, before.founder.pendingInPool);
    assert.equal(s.founder.claimable, before.founder.pendingInPool);
    assert.deepEqual([s.pool.curve, s.founder.pendingInPool], [0n, 0n]);
    // the founder collects; a stranger's gift to the vault leaves with the claim and is counted as collected, not as earned
    w.donate(coin.founderVault, 7_000n);
    s = await status('gift');
    assert.equal(s.founder.claimable, s.founder.earned + 7_000n);
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder], 'claim_founder_fees');
    s = await status('claimed');
    sameAsProgram(s);
    assert.equal(s.founder.claimable, 0n);
    assert.equal(s.founder.collected, s.founder.earned + 7_000n, 'collected can exceed earned by what strangers sent');
    // the launched status's counters after the claim: the record's, as the fee status has them
    const st = await statusFees();
    assert.deepEqual([st.earnedLamports, st.collectedLamports], [String(s.founder.earned), String(s.founder.collected)]);
    assertInvariants(w);
  });

  it('TQ03 holder rewards set up, the pot forwarded: holders.forwarded and the rewards vault say so', async () => {
    const r = await w.initRewardsCity(coin);
    let s = await status('rewards set up');
    sameAsProgram(s);
    assert.deepEqual(s.holders.vault, { address: r.vault, balance: 0n, holdersOnly: true });
    assert.equal(s.source.accounts.rewardsConfig, R.city(coin.mint));
    const pot = s.holders.pot;
    assert.ok(pot > 0n);
    await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    s = await status('forwarded');
    sameAsProgram(s);
    assert.deepEqual([s.holders.pot, s.holders.forwarded, s.holders.vault.balance], [0n, pot, pot]);
    // more trades: fees wait again on the curve
    for (let i = 0; i < 2; i++) await w.trade(trader, coin, { side: 'buy', amount0: 2n * LAMPORTS, amount1: 1n });
    s = await status('curve again');
    sameAsProgram(s);
    assert.ok(s.founder.pendingInPool > 0n);
    // the founder's Collect as the website builds it (src/lplaunch.js founderClaimTx: harvest_curve_fees first while the curve holds
    // the city's fees, then claim_founder_fees): it pays the vault plus the founder's part still in the curve, the card's "Ready to
    // collect now" (public/lp-launch.js feeCardView)
    assert.ok(s.pool.curve > 0n && !s.coin.graduated);
    const ready = s.founder.claimable + s.founder.pendingInPool;
    const fAta = ata(founder.address, coin.quoteMint);
    const had = w.exists(fAta) ? w.balance(fAta) : 0n;
    const landed = nextSlot(); // the Collect lands in a later slot than that reading
    await w.send([C.harvestCurveFees({ payer: founder.address, coin }), C.claimFounderFees({ founder: founder.address, coin })], [founder], 'founder collect', { feePayer: founder });
    assert.equal(w.balance(fAta) - had, ready, 'Collect paid exactly what the card calls ready to collect now');
    // the founder card's own rule (probe P2): the reading from before the Collect still shows the curve's fees; the status read after
    // it says they left, so another tab or a reload never shows that reading, and the slot rule refuses it in this tab
    const st = await statusFees(), before = answerOf(s);
    assert.deepEqual([st.inVaultLamports, st.onCurveLamports], ['0', '0']);
    // the Collect booked the founder's half (earned) and paid it with the vault (collected): both counters are past that reading's
    assert.deepEqual([big(st.earnedLamports) - s.founder.earned, big(st.collectedLamports) - s.founder.collected], [s.founder.pendingInPool, ready]);
    assert.ok(before.source.slot < landed);
    assert.equal(card.olderThanStatus(before, st), true, 'the reading from before the Collect is refused against the status');
    assert.equal(card.freshAfterCollect(before, landed), false, 'and by the Collect\'s slot');
    s = await status('collected');
    sameAsProgram(s);
    assert.deepEqual([s.founder.claimable, s.founder.pendingInPool, s.pool.curve], [0n, 0n, 0n]);
    const now = answerOf(s);
    assert.deepEqual([card.olderThanStatus(now, st), card.freshAfterCollect(now, landed)], [false, true], 'the reading after it is shown');
  });

  it('TQ04 the curve fills: the surplus is counted before any harvest; graduation, DAMM v2 trades: the city\'s position is exactly what harvest_pool_fees claims; the dev wallet\'s is never counted', async () => {
    // many trades build DBC's completion surplus (rounding in the pool's favour), then the curve fills
    await churn(w, coin, { trades: 120, seed: 7 });
    await completeCurve(w, coin);
    const full = await status('completed');
    sameAsProgram(full);
    assert.equal(full.coin.graduated, false);
    assert.ok(full.pool.surplus > 0n, 'the city\'s share of the completion surplus is due');
    assert.equal(full.city.pendingInPool, full.pool.curve + full.pool.surplus);
    assert.equal(full.founder.pendingInPool, (full.pool.curve + full.pool.surplus) / 2n, 'one split of the sum, as the harvest does it');
    g = await graduate(w, coin, await w.signer(10n));
    const moved = await status('graduated, curve not harvested');
    sameAsProgram(moved);
    assert.equal(moved.coin.graduated, true);
    assert.deepEqual([moved.pool.curve, moved.pool.surplus], [full.pool.curve, full.pool.surplus], 'graduation leaves the curve fees and the surplus as they were');
    assert.equal(moved.pool.positions.length, 1);
    // the remaining curve fees and the surplus: the next harvest claims exactly what the status said, split as it said
    const ev0 = eventsNamed(await harvest(w, coin), 'FeesHarvested')[0].data;
    assert.deepEqual([big(ev0.claimed), big(ev0.surplus), big(ev0.to_founder), big(ev0.to_holders)],
      [full.pool.curve + full.pool.surplus, full.pool.surplus, full.founder.pendingInPool, full.holders.pendingInPool], 'the harvest booked the status\'s figures, surplus included');
    const owner = (nft) => { const a = w.account(damm.positionNftAccount(nft)); return a ? Buffer.from(a.data).subarray(32, 64) : null; };
    cityNft = [g.n1, g.n2].find((n) => Buffer.from(base58Decode(coin.address)).equals(owner(n)));
    assert.ok(cityNft, 'the Coin record holds one position NFT');
    t2 = await w.signer(100n);
    w.fundToken(t2.address, WSOL, 30n * LAMPORTS);
    w.emptyTokenAccount(t2.address, coin.mint);
    for (let i = 0; i < 3; i++) {
      await w.send([C.dammSwap({ trader: t2.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: false, amountIn: 2n * LAMPORTS, minOut: 1n })], [t2], 'damm swap buy');
      await w.send([C.dammSwap({ trader: t2.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: true, amountIn: w.balance(ata(t2.address, coin.mint)) / 2n, minOut: 1n })], [t2], 'damm swap sell');
    }
    const s = await status('graduated');
    sameAsProgram(s);
    assert.equal(s.coin.graduated, true);
    assert.equal(s.pool.damm, g.pool);
    assert.deepEqual(s.pool.positions.map((p) => p.nftMint), [cityNft], 'the city\'s position only; the dev wallet\'s is not the Coin record\'s');
    const pending = s.pool.positions[0].pending;
    assert.ok(pending > 0n, 'pool fees wait in the city\'s position');
    assert.equal(s.city.pendingInPool, s.pool.curve + pending);
    assert.equal(s.founder.pendingInPool, splitFee(s.pool.curve)[1] + splitFee(pending)[1]);
    const ev = eventsNamed(await harvest(w, coin, 'pool', { dammPool: g.pool, positionNftMint: cityNft }), 'FeesHarvested')[0].data;
    assert.equal(big(ev.claimed), pending, 'harvest_pool_fees claimed exactly the status\'s figure (DAMM v2 update_fee, from the bytes)');
    assert.equal(big(ev.to_founder), splitFee(pending)[1]);
    const after = await status('pool harvested');
    sameAsProgram(after);
    assert.equal(after.pool.positions[0].pending, 0n);
    assert.equal(after.founder.earned - s.founder.earned, splitFee(pending)[1]);
  });

  it('TQ05 a position NFT given to the record in another of its token accounts counts, and each harvest_pool_fees moves exactly the Worker\'s figure', async () => {
    // the dev wallet's position (the graduation's other one) is given to the record, into the record's own associated account for
    // the NFT: a transfer like any other (DAMM v2's position mints are not NonTransferable), not DAMM v2's position_nft_account
    const devNft = [g.n1, g.n2].find((n) => n !== cityNft);
    const given = ata(coin.address, devNft, T22);
    assert.notEqual(given, damm.positionNftAccount(devNft));
    // given while a reading is under way: right after its listing of the record's accounts, before its last answer
    hooks.afterList = () => w.sendAsDevWallet([createAta(w.payer.address, coin.address, devNft), transferChecked(damm.positionNftAccount(devNft), devNft, given, ADDRESSES.feeRecipient, 1n, 0)], 'give the record a position NFT');
    const during = await peek();
    assert.equal(hooks.afterList, null, 'the gift landed during that reading');
    assert.equal(w.balance(given), 1n);
    assert.equal(w.balance(damm.positionNftAccount(devNft)), 0n);
    sameAsProgram(during);
    assert.deepEqual([during.pool.estimate, during.pool.positions, during.founder.pendingInPool, during.city.pendingInPool], ['unavailable', null, null, null],
      'that reading would have missed the given position: the estimate alone is withheld, never shown as whole without it');
    const nextOne = await peek();
    sameAsProgram(nextOne);
    assert.equal(nextOne.pool.estimate, 'whole');
    assert.deepEqual(nextOne.pool.positions.map((p) => p.nftMint).sort(), [cityNft, devNft].sort(), 'the next reading counts it');
    // more DAMM v2 trades: fees wait in both positions
    for (let i = 0; i < 3; i++) {
      await w.send([C.dammSwap({ trader: t2.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: false, amountIn: 2n * LAMPORTS, minOut: 1n })], [t2], 'damm swap buy');
      await w.send([C.dammSwap({ trader: t2.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: true, amountIn: w.balance(ata(t2.address, coin.mint)) / 2n, minOut: 1n })], [t2], 'damm swap sell');
    }
    const s = await status('position given');
    sameAsProgram(s);
    assert.equal(s.pool.estimate, 'whole', 'every position the record holds was read');
    assert.equal(s.pool.positions.length, 2);
    const gift = s.pool.positions.find((p) => p.nftMint === devNft), own = s.pool.positions.find((p) => p.nftMint === cityNft);
    assert.ok(gift && own, 'the given position counts, next to the city\'s own');
    assert.deepEqual([gift.nftAccount, gift.position, gift.pool], [given, damm.position(devNft), g.pool]);
    assert.equal(own.nftAccount, damm.positionNftAccount(cityNft));
    assert.ok(gift.pending > 0n && own.pending > 0n);
    assert.equal(s.city.pendingInPool, s.pool.curve + s.pool.surplus + gift.pending + own.pending);
    assert.equal(s.founder.pendingInPool, splitFee(s.pool.curve + s.pool.surplus)[1] + splitFee(gift.pending)[1] + splitFee(own.pending)[1]);
    assert.deepEqual(s.source.accounts.positions, [gift.position, own.position].sort());
    // harvest_pool_fees takes the given position through the record's own account for its NFT: exactly the Worker's figure
    const ev = eventsNamed(await harvest(w, coin, 'pool', { dammPool: g.pool, positionNftMint: devNft, overrides: { position_nft_account: given } }), 'FeesHarvested')[0].data;
    assert.deepEqual([big(ev.claimed), big(ev.to_founder), big(ev.to_holders)], [gift.pending, splitFee(gift.pending)[1], splitFee(gift.pending)[0]], 'the harvest moved exactly the Worker\'s figure for the given position');
    const ev2 = eventsNamed(await harvest(w, coin, 'pool', { dammPool: g.pool, positionNftMint: cityNft }), 'FeesHarvested')[0].data;
    assert.equal(big(ev2.claimed), own.pending, 'and for the city\'s own');
    assert.equal(big(ev.claimed) + big(ev2.claimed), s.city.pendingInPool - s.pool.curve - s.pool.surplus, 'the whole estimate, nothing left out');
    const after = await status('given position harvested');
    sameAsProgram(after);
    assert.deepEqual(after.pool.positions.map((p) => p.pending), [0n, 0n]);
    assert.equal(after.founder.earned - s.founder.earned, s.founder.pendingInPool - splitFee(s.pool.curve + s.pool.surplus)[1]);
    // the founder's Collect after graduation (probe P1): claim_founder_fees alone (src/lplaunch.js founderClaimTx harvests only on the
    // curve) moves the whole vault; the reading from before it is refused against the status read after it and by its slot
    assert.ok(after.founder.claimable > 0n);
    // before it the card shows the vault on its own row, with or without a Collect button on the card (the status may fail to read
    // its fees), and "Ready to collect now" is that same figure when the button is there
    const card0 = { mint: coin.mint, wallet: founder.address }, rowOf = (v, label) => v.rows.find((r) => r[0] === label);
    for (const can of [true, false]) assert.equal(rowOf(card.feeCardView(answerOf(after), card0, Date.now(), can), 'In your fee vault')[1], `${card.exactAmount(String(after.founder.claimable), 9)} SOL`);
    assert.equal(rowOf(card.feeCardView(answerOf(after), card0, Date.now(), true), 'Ready to collect now')[1], `${card.exactAmount(String(after.founder.claimable), 9)} SOL`);
    const fAta = ata(founder.address, coin.quoteMint);
    const had = w.exists(fAta) ? w.balance(fAta) : 0n;
    const landed = nextSlot();
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder], 'founder collect after graduation', { feePayer: founder });
    assert.equal(w.balance(fAta) - had, after.founder.claimable, 'Collect moved what the card called ready to collect now and in your fee vault: the vault');
    const st = await statusFees(), old = answerOf(after);
    assert.deepEqual([st.inVaultLamports, st.onCurveLamports, st.totalLamports], ['0', '0', '0']);
    assert.deepEqual([st.earnedLamports, big(st.collectedLamports) - after.founder.collected], [String(after.founder.earned), after.founder.claimable], 'the claim is in the collected counter');
    assert.deepEqual([card.olderThanStatus(old, st), card.freshAfterCollect(old, landed)], [true, false], 'the reading from before the Collect is never shown again');
    const fresh = await peek();
    sameAsProgram(fresh);
    const now = answerOf(fresh);
    assert.deepEqual([card.olderThanStatus(now, st), card.freshAfterCollect(now, landed)], [false, true]);
    const view = card.feeCardView(now, { mint: coin.mint, wallet: founder.address }, Date.now(), false);
    assert.deepEqual(JSON.parse(JSON.stringify(view.rows.find((r) => r[0] === 'Ready to collect now').slice(0, 2))), ['Ready to collect now', '0 SOL'], 'and it says 0 is ready, as the chain has it');
    assertInvariants(w);
  });

  it('TQ06 a payout the founder agreed to: paid out and collected equal the record\'s, the status\'s counter too; the reading from before it is refused by that counter, also once the vault holds more again', async () => {
    // more pool fees for the vault: DAMM v2 trades, then the city's position harvested
    for (let i = 0; i < 3; i++) {
      await w.send([C.dammSwap({ trader: t2.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: false, amountIn: 2n * LAMPORTS, minOut: 1n })], [t2], 'damm swap buy');
      await w.send([C.dammSwap({ trader: t2.address, pool: g.pool, mintA: coin.mint, mintB: WSOL, aToB: true, amountIn: w.balance(ata(t2.address, coin.mint)) / 2n, minOut: 1n })], [t2], 'damm swap sell');
    }
    await harvest(w, coin, 'pool', { dammPool: g.pool, positionNftMint: cityNft });
    // payouts set up by the admin (the one payout key and payout wallet), and the founder agrees to them
    const payoutKey = await w.signer(10n), payoutWallet = await w.signer(1n);
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: payoutWallet.address })], [w.admin], 'set_payout_config');
    await w.send([C.optInPayout({ founder: founder.address, cityId: coin.cityId, expectedDestination: payoutWallet.address, refHash: new Uint8Array(32).fill(5) })], [founder], 'opt_in_payout');
    const before = await peek();
    sameAsProgram(before);
    assert.equal(before.founder.payoutAgreed, true, 'the founder agreed to payouts');
    const inVault = before.founder.claimable;
    assert.ok(inVault > 0n);
    const st0 = await statusFees();
    const landed = nextSlot();
    await w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address })], [payoutKey], 'payout_founder_fees', { feePayer: payoutKey });
    assert.equal(w.balance(ata(payoutWallet.address, coin.quoteMint)), inVault, 'the payout moved the whole vault to the agreed wallet');
    const st = await statusFees();
    assert.deepEqual([st.earnedLamports, big(st.collectedLamports) - big(st0.collectedLamports), st.inVaultLamports], [st0.earnedLamports, inVault, '0'], 'a payout is collected, never earned');
    const old = answerOf(before);
    assert.equal(card.olderThanStatus(old, st), true, 'the reading from before the payout is refused');
    // the vault holds more again than that reading showed (here a gift: anyone can send to it): the balances alone could not tell
    // that reading is older, the record's collected counter does
    w.donate(coin.founderVault, inVault + 1n);
    const st2 = await statusFees();
    assert.ok(big(st2.inVaultLamports) > big(old.founder.claimable) && st2.slot >= landed);
    assert.equal(card.olderThanStatus({ ...old, founder: { ...old.founder, collected: st2.collectedLamports, earned: st2.earnedLamports } }, st2), false, 'with the same counters the balances alone would show it');
    assert.equal(card.olderThanStatus(old, st2), true, 'the collected counter refuses it');
    const after = await peek();
    sameAsProgram(after);
    assert.deepEqual([after.founder.paidOut, after.founder.collected - before.founder.collected, after.founder.claimable], [inVault, inVault, inVault + 1n]);
    const now = answerOf(after);
    assert.equal(card.olderThanStatus(now, st2), false, 'the reading after it is shown');
    const rows = card.feeCardView(now, { mint: coin.mint, wallet: founder.address }, Date.now(), true).rows, row = (label) => rows.find((r) => r[0] === label);
    assert.ok(row('Collected or paid out since launch')[1].startsWith(`${card.exactAmount(String(after.founder.collected), 9)} SOL`));
    assert.equal(row('Of that, paid out')[1], `${card.exactAmount(String(inVault), 9)} SOL (sent to the payout wallet the founder agreed to)`);
    assert.match(row('Goes to')[1], /\(only this wallet can collect, or a payout it agreed to\)$/);
    assertInvariants(w);
  });

  it('TQ07 fixtures for the root suite (RECORD=1)', () => {
    assert.ok(readings.length >= 14);
    if (process.env.RECORD === '1') {
      const dir = join(here, '..', '..', 'test', 'fixtures', 'launchpad-worker');
      mkdirSync(dir, { recursive: true });
      const out = {
        recordedAt: new Date().toISOString(), cluster: 'devnet', programId: PROGRAM_IDS.launchpad, rewardsProgramId: PROGRAM_IDS.rewards, dbcConfig: w.config,
        coin: { cityId: String(coin.cityId), mint: coin.mint, address: coin.address, founder: founder.address },
        readings: readings.map((r) => ({ ...r, status: { ...r.status, source: { ...r.status.source, slot: null, readAt: null } } })),
      };
      writeFileSync(join(dir, 'fee-status.json'), JSON.stringify(out, null, 1));
      console.log(`TQ07 wrote ${readings.length} readings to test/fixtures/launchpad-worker/fee-status.json`);
    }
  });
});
