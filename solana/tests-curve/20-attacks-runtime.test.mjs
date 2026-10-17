// Attacks through the runtime (section 10, T56, T59, T62, T63): X56 event
// spoofing (a forged event can neither stand alone nor ride along a real
// trade); X59 clock and slot warps around the buyback interval, the payout
// cooldown and approval expiry, including a clock that runs backwards; X62
// launch sniping (closest shape: the founder's atomic first buy, a sniper in the
// same slot pays the curve and the flat fee, the first buyback waits 150 slots);
// X63 the Rent sysvar raised by 10%: a sell, a claim, a withdrawal and a forward
// still work, a debit below the live minimum of a nearly empty coin is refused,
// and a top-up restores it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Rent } from 'litesvm';
import { World, S, expectFail, TxError, LAMPORTS, DAY } from './helpers.mjs';

const T = S.DEFAULT_TERMS;
const view = (w, h) => w.coinView(h);
const st = (w, h) => S.coinState(w.coinView(h));
const fingerprint = (w, addrs) => addrs.map((a) => { const x = w.accountInfo(a); return x ? `${a}:${x.lamports}:${x.data.toString('hex')}` : `${a}:none`; });
async function refuse(w, watch, fn, ...codes) {
  const before = fingerprint(w, watch);
  const e = await expectFail(fn, ...codes);
  assert.deepEqual(fingerprint(w, watch), before, 'an attacked account changed');
  return e;
}
/** Move only the unix time, or only the slot (World.warpSecs and warpSlots move both). */
const setTime = (w, ts) => { const c = w.svm.getClock(); c.unixTimestamp = BigInt(ts); w.svm.setClock(c); };
const setSlot = (w, slot) => { const c = w.svm.getClock(); c.slot = BigInt(slot); w.svm.setClock(c); };
const sysTransfer = (from, to, n) => ({ programAddress: S.ADDRESSES.system, accounts: [{ address: String(from), role: S.Role.WS }, { address: String(to), role: S.Role.W }],
  data: new Uint8Array([2, 0, 0, 0, ...Buffer.from(new BigUint64Array([BigInt(n)]).buffer)]) });

// ---------------------------------------------------------------- X56
test('X56 event spoofing: a forged money event is refused alone and sinks a real trade it rides along with; indexers accept money events only from the program\'s own event CPI', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2000n, symbol: 'SPOOF' });
  const u = await w.signer(50n);
  await w.buy(u, h, LAMPORTS);
  const ea = w.P.eventAuthority();
  // a Trade event claiming a huge sell to the attacker, as raw event-CPI data
  const body = new Uint8Array(400);
  const fake = new Uint8Array([...S.EVENT_IX_TAG, ...S.EVENT_DISCRIMINATORS.Trade, ...body]);
  const forged = (accounts) => ({ programAddress: w.programId, accounts, data: fake });
  const watch = [h.coin, h.vault, u.address];
  await refuse(w, watch, () => w.send([forged([{ address: ea, role: S.Role.R }])], [], 'forged Trade, event authority not signing'), /ConstraintSigner|signer|MissingRequiredSignature|PrivilegeEscalation/i);
  await refuse(w, watch, () => w.send([forged([{ address: u.address, role: S.Role.RS }])], [u], 'forged Trade signed by the attacker'), /ConstraintSeeds|seeds|event/i);
  // riding along a real buy: the whole transaction reverts, the real buy included
  await refuse(w, watch, () => w.send([w.ix.buy({ user: u.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n }), forged([{ address: ea, role: S.Role.R }])], [u], 'real buy + forged event'),
    /ConstraintSigner|signer|MissingRequiredSignature|PrivilegeEscalation/i);
  // the SDK's decoder (what indexers run) accepts a money event only from vicinity_curve with the event authority as its one account
  assert.equal(S.decodeEventCpi({ programId: w.programId, accounts: [u.address], data: fake }, { programId: w.programId }), null, 'not with another account');
  assert.equal(S.decodeEventCpi({ programId: S.CLUSTERS.mainnet.rewardsProgram, accounts: [ea], data: fake }, { programId: w.programId }), null, 'not from another program');
  const real = (await w.buy(u, h, LAMPORTS)).res.top.find((t) => t.name === 'buy').inner.find((i) => i.program === w.programId);
  assert.equal(S.decodeEventCpi({ programId: real.program, accounts: real.accounts, data: real.data }, { programId: w.programId }).name, 'Trade');
  await w.finish();
});

// ---------------------------------------------------------------- X59
test('X59 clock and slot warps: the buyback interval counts slots only, the payout cooldown and approval expiry count seconds only, at their exact edges; a clock running backwards unlocks nothing', async () => {
  const w = await World.create();
  const founder = await w.signer(10n);
  const h = await w.launchCoin({ cityId: 2010n, founder, symbol: 'CLOCK' });
  const u = await w.signer(500n);
  await w.buy(u, h, 20n * LAMPORTS);
  const launchSlot = view(w, h).launchSlot;
  // the first run: unix time pushed 10 days ahead but only 149 slots after launch: a no-op
  setTime(w, w.now() + 10n * DAY);
  setSlot(w, launchSlot + 149n);
  assert.equal((await w.buyback(h, { label: 'buyback +149 slots, +10 days' })).events.length, 0);
  setSlot(w, launchSlot + 150n);
  assert.equal((await w.buyback(h, { label: 'buyback +150 slots' })).events.length, 1);
  const L = view(w, h).lastBuybackSlot;
  await w.buy(u, h, 10n * LAMPORTS);
  // slots alone (no time) unlock the next run; time alone does not
  setTime(w, w.now() + 365n * DAY);
  assert.equal((await w.buyback(h, { label: 'buyback after a year, same slot' })).events.length, 0);
  setSlot(w, L + 150n);
  assert.equal((await w.buyback(h, { label: 'buyback +150 slots, no time' })).events.length, 1);
  // the slot runs backwards: below the last run (and below the launch slot) nothing can run, nothing underflows
  await w.buy(u, h, 10n * LAMPORTS);
  const L2 = view(w, h).lastBuybackSlot;
  for (const slot of [L2 - 1n, launchSlot - 500n, 0n]) {
    setSlot(w, slot);
    assert.equal((await w.buyback(h, { label: `buyback at slot ${slot}` })).events.length, 0);
  }
  setSlot(w, L2 + 150n);
  assert.equal((await w.buyback(h, { label: 'buyback once the slot is back' })).events.length, 1);
  // the payout cooldown: seconds only, exactly 86,400
  const pk = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  await w.send([w.ix.optInPayout({ founder: founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(1) })], [founder], 'opt in');
  await w.payout(h, { destination: wallet.address });
  const P0 = view(w, h).lastPayoutAt;
  await w.buy(u, h, 5n * LAMPORTS);
  const watch = [h.coin, wallet.address];
  setSlot(w, w.slot() + 1_000_000n);
  await refuse(w, watch, () => w.payout(h, { destination: wallet.address, label: 'payout a million slots later, same second' }), 'PayoutTooSoon');
  setTime(w, P0 + DAY - 1n);
  await refuse(w, watch, () => w.payout(h, { destination: wallet.address, label: 'payout at +86,399 s' }), 'PayoutTooSoon');
  // the clock runs backwards before the last payout: still too soon, no underflow
  setTime(w, P0 - 1_000n);
  await refuse(w, watch, () => w.payout(h, { destination: wallet.address, label: 'payout with the clock before the last payout' }), 'PayoutTooSoon');
  setTime(w, P0 + DAY);
  await w.payout(h, { destination: wallet.address, label: 'payout at exactly +86,400 s' });
  // approval expiry: seconds only
  const f2 = await w.signer(10n); const f3 = await w.signer(10n); const anyone = await w.signer(1n);
  await w.approve({ cityId: 2011n, founder: f2, symbol: 'EXPA', ttl: DAY });
  await w.approve({ cityId: 2012n, founder: f3, symbol: 'EXPB', ttl: DAY });
  const exp = w.approval(2011n).expiresAt;
  setSlot(w, w.slot() + 10_000_000n);
  await refuse(w, [w.P.approval(2011n)], () => w.send([w.ix.revokeApproval({ by: anyone.address, cityId: 2011n, rentPayer: w.admin.address })], [anyone], 'anyone revokes after 10 million slots, before expiry'), 'ApprovalNotExpired');
  setTime(w, exp);
  await w.launch({ cityId: 2011n, founder: f2, label: 'launch at exactly expires_at' });
  setTime(w, exp + 1n);
  await refuse(w, Object.values(w.P.coinAccounts(2012n)), () => w.launch({ cityId: 2012n, founder: f3, label: 'launch one second after expiry' }), 'ApprovalExpired');
  // the clock runs backwards: an expired approval is not revived for revocation by others either way, and the admin can always close it
  setTime(w, exp - 10n);
  await refuse(w, [w.P.approval(2012n)], () => w.send([w.ix.revokeApproval({ by: anyone.address, cityId: 2012n, rentPayer: w.admin.address })], [anyone], 'anyone revokes, clock before expiry'), 'ApprovalNotExpired');
  setTime(w, exp + 1n);
  await w.send([w.ix.revokeApproval({ by: anyone.address, cityId: 2012n, rentPayer: w.admin.address })], [anyone], 'anyone revokes after expiry');
  await w.finish();
});

// ---------------------------------------------------------------- X62
test('X62 launch sniping (closest shape): the founder buys atomically in the launch transaction; a sniper in the same slot pays the curve price and the flat fee; nothing can trade before the launch; the first buyback waits 150 slots', async () => {
  const w = await World.create();
  const founder = await w.signer(100n); const sniper = await w.signer(100n);
  await w.approve({ cityId: 2020n, founder, symbol: 'SNIPE' });
  const h = w.handle(2020n, founder);
  // before the launch nothing exists to buy
  await expectFail(() => w.send([w.ix.buy({ user: sniper.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n })], [sniper], 'buy before the launch'), 'AccountNotInitialized');
  // the founder's launch with his first buy in one transaction (C01): exactly E1
  await w.send([w.launchIx({ cityId: 2020n, founder }), ...w.buyIxs(founder, h, LAMPORTS, 0n)], [founder], 'launch + the founder\'s first buy', { cu: 400_000 });
  w.addHolder(h.mint, founder);
  assert.equal(w.balanceOf(founder, h.mint), 33_774_693_369_781n, 'E1 at the launch price');
  // the sniper, same slot: the curve price after the founder's buy and the same 2.5% fee, nothing more and nothing less
  const q = S.quoteBuy(T, st(w, h), LAMPORTS);
  const r = await w.buy(sniper, h, LAMPORTS, { label: 'sniper in the launch slot' });
  assert.equal(r.q.tokensOut, q.tokensOut);
  assert.equal(r.q.split.fee, 25_000_000n, 'the flat fee (O20: no anti-sniper fee)');
  assert.ok(r.q.tokensOut < 33_774_693_369_781n, 'the sniper pays more per coin than the founder\'s atomic buy');
  // the first buyback: not before launch_slot + 150
  const ls = view(w, h).launchSlot;
  setSlot(w, ls + 149n);
  assert.equal((await w.buyback(h, { label: 'buyback at launch + 149' })).events.length, 0);
  setSlot(w, ls + 150n);
  assert.equal((await w.buyback(h, { label: 'buyback at launch + 150' })).events.length, 1);
  await w.finish();
});

// ---------------------------------------------------------------- X63
test('X63 the Rent sysvar raised by 10%: a sell, a claim, a withdrawal and a forward still work; a debit below the live minimum of a nearly empty coin is refused by the runtime; a top-up restores it', async () => {
  const w = await World.create();
  const big = await w.launchCoin({ cityId: 2030n, symbol: 'RICH' });
  const thin = await w.launchCoin({ cityId: 2031n, symbol: 'THIN' });
  const bare = await w.launchCoin({ cityId: 2032n, symbol: 'BARE' });
  const u = await w.signer(200n); const v = await w.signer(10n); const donor = await w.signer(10n);
  const b = await w.buy(u, big, 20n * LAMPORTS);
  await w.initRewardsCity(big);
  // a nearly empty coin: liabilities of 650,000 lamports above its rent
  const tb = await w.buy(v, thin, 650_000n, { label: 'a small buy into the thin coin' });
  const rent0 = w.svm.getRent();
  const old = w.svm.minimumBalanceForRentExemption(693n);
  assert.equal(view(w, thin).rentReserve, old);
  // the cluster raises rent by 10%
  w.svm.setRent(new Rent((rent0.lamportsPerByteYear * 11n) / 10n, rent0.exemptionThreshold, rent0.burnPercent));
  const live = w.svm.minimumBalanceForRentExemption(693n);
  assert.ok(live > old && live <= (old * 11n) / 10n + 1n, `rent ${old} -> ${live}`);
  const probe = w.probeEach; w.probeEach = false; // the liveness probe assumes the rent the coins were launched under
  // the rich coin: every exit works (pay_out floors at min(rent_reserve, live rent); the Coin stays above the live minimum)
  await w.sell(u, big, b.q.tokensOut / 3n, { label: 'sell under the raised rent' });
  await w.claim(big, big.founder, { label: 'claim under the raised rent' });
  await w.withdraw(big, { label: 'withdraw under the raised rent' });
  await w.forward(big, { label: 'forward under the raised rent' });
  // the thin coin holds rent_reserve + 650,000 >= the live minimum; a sell taking it below is refused by the runtime's rent rule
  assert.ok(w.lamportsOf(thin.coin) >= live, 'exempt under the new rent before the sell');
  const q = S.quoteSell(T, st(w, thin), tb.q.tokensOut);
  assert.ok(w.lamportsOf(thin.coin) - q.solOut < live, 'the sell would leave it below the live minimum');
  const watch = [thin.coin, thin.vault, v.address];
  await refuse(w, watch, () => w.send([w.ix.sell({ user: v.address, coin: thin.coin, tokensIn: tb.q.tokensOut, minSolOut: 0n })], [v], 'sell below the live minimum'),
    /InsufficientFundsForRent|insufficient funds for rent/i);
  // a claim that keeps it above the live minimum still works
  await w.claim(thin, thin.founder, { label: 'small claim from the thin coin' });
  // anyone tops the Coin up (an uncounted donation): the same sell now goes through
  const topUp = live - old;
  await w.send([sysTransfer(donor.address, thin.coin, topUp)], [donor], 'top-up of the thin coin', { lamportDonation: { coin: thin.coin, amount: topUp } });
  await w.sell(v, thin, tb.q.tokensOut, { label: 'the sell after the top-up' });
  assert.equal(w.lamportsOf(thin.coin), view(w, thin).rentReserve + S.liabilities(st(w, thin)) + topUp);
  // a coin launched before the raise with no trades sits below the live minimum: a small buy credits it; whether the runtime
  // accepts a credit that leaves an account below the minimum is the runtime's rule, recorded here; a top-up always works
  assert.ok(w.lamportsOf(bare.coin) < live);
  let smallRefused = false;
  try {
    await w.send([...w.buyIxs(u, bare, S.MIN_TRADE_LAMPORTS, 0n)], [u], 'small buy into a coin below the live minimum');
    w.addHolder(bare.mint, u);
  } catch (e) {
    if (!(e instanceof TxError)) throw e;
    smallRefused = true;
    assert.match(`${e.logs.join('\n')}\n${e.errText}`, /InsufficientFundsForRent|insufficient funds for rent/i);
  }
  const top2 = live > w.lamportsOf(bare.coin) ? live - w.lamportsOf(bare.coin) : 0n;
  if (top2 > 0n) await w.send([sysTransfer(donor.address, bare.coin, top2)], [donor], 'top-up of the bare coin', { lamportDonation: { coin: bare.coin, amount: top2 } });
  await w.buy(u, bare, S.MIN_TRADE_LAMPORTS, { label: 'a small buy after the top-up' });
  console.log(`X63: rent ${old} -> ${live} for a Coin; a small buy into an untraded coin below the live minimum was ${smallRefused ? 'refused by the runtime (InsufficientFundsForRent) until a top-up' : 'accepted by the runtime (a credit may leave an account below the minimum)'}`);
  // the old rent back, the probe on again
  w.svm.setRent(rent0);
  w.probeEach = probe;
  await w.finish();
});
