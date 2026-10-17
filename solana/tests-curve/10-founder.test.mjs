// L10 (part 2) and L11 (4.17 to 4.20, 8.1, T50, T51): the opt-in payout path
// (configured off by default, opt in to the exact wallet, the payout key pays
// the whole founder bucket to that wallet at most once a day, pause, a changed
// wallet stops old opt-ins, revoke), and transfer_founder with both
// signatures (the money goes with the seat, an old opt-in stops working).
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail, LAMPORTS, DAY } from './helpers.mjs';

const ref = (s) => Array.from({ length: 32 }, (_, i) => (i + s.length * 7) & 0xff);

async function coinWithFees(w, cityId, symbol) {
  const h = await w.launchCoin({ cityId, symbol });
  const u = await w.signer(100n);
  await w.buy(u, h, 20n * LAMPORTS, { label: `${symbol} buy` });
  return { h, u };
}

test('L10 the opt-in payout path: off by default, the exact wallet, daily, pausable by the payout key, never redirected', async () => {
  const w = await World.create();
  const { h, u } = await coinWithFees(w, 600n, 'PAY');
  const payoutKey = await w.signer(5n); const wallet = await w.signer(1n); const other = await w.signer(1n);
  const optIn = (o = {}) => w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: ref('x'), ...o })], [o.signer ?? h.founder], o.label ?? 'opt_in_payout');
  // payouts off: no opt-in possible
  await expectFail(() => optIn({ label: 'opt in while payouts are off' }), 'PayoutsNotConfigured');
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  await expectFail(() => optIn({ expectedDestination: other.address, label: 'opt in to another wallet' }), 'DestinationMismatch');
  await expectFail(() => w.send([w.ix.optInPayout({ founder: other.address, coin: h.coin, expectedDestination: wallet.address, refHash: ref('x') })], [other], 'opt in by a stranger'), 'WrongFounder');
  let r = await optIn();
  assert.deepEqual(r.events[0], { name: 'PayoutOptedIn', data: { city_id: 600n, founder: h.founder.address, destination: wallet.address, ref_hash: Uint8Array.from(ref('x')) } });
  const oi = S.decodePayoutOptIn(w.accountInfo(w.P.payoutOptIn(h.coin)), { programId: w.programId });
  assert.deepEqual([oi.coin, oi.founder, oi.agreedDestination, oi.optedInAt], [h.coin, h.founder.address, wallet.address, w.now()]);
  await expectFail(() => optIn({ label: 'opt in twice' }), /already in use/);
  // only the payout key; only to the configured wallet
  await expectFail(() => w.payout(h, { payoutKey: other, destination: wallet.address, label: 'payout by a stranger' }), 'Unauthorized');
  await expectFail(() => w.payout(h, { destination: other.address, label: 'payout to another wallet' }), 'DestinationMismatch');
  const pending = w.coinView(h).founderPending;
  const w0 = w.lamportsOf(wallet.address);
  r = await w.payout(h, { destination: wallet.address });
  assert.equal(w.lamportsOf(wallet.address) - w0, pending, 'the whole founder bucket, native SOL');
  assert.deepEqual(r.events[0].data, { city_id: 600n, founder: h.founder.address, destination: wallet.address, amount: pending, seq: 1n, ref_hash: Uint8Array.from(ref('x')), total_paid_out: pending });
  let c = w.coinView(h);
  assert.deepEqual([c.founderPending, c.founderPaidOut, c.payoutSeq, c.lastPayoutAt], [0n, pending, 1n, w.now()]);
  // at most daily (the cooldown lives on the Coin)
  await w.buy(u, h, 5n * LAMPORTS);
  await expectFail(() => w.payout(h, { destination: wallet.address, label: 'payout too soon' }), 'PayoutTooSoon');
  w.warpSecs(DAY - 2n);
  await expectFail(() => w.payout(h, { destination: wallet.address, label: 'payout a second too soon' }), 'PayoutTooSoon');
  w.warpSecs(2n);
  r = await w.payout(h, { destination: wallet.address, label: 'payout after 24 hours' });
  assert.equal(r.events[0].data.seq, 2n);
  // nothing pending: a no-op (no sequence number, no cooldown)
  w.warpSecs(DAY);
  const seqBefore = w.coinView(h).payoutSeq; const lastBefore = w.coinView(h).lastPayoutAt;
  r = await w.payout(h, { destination: wallet.address, label: 'payout with nothing pending' });
  assert.equal(r.events.length, 0);
  assert.deepEqual([w.coinView(h).payoutSeq, w.coinView(h).lastPayoutAt], [seqBefore, lastBefore]);
  // the payout key pauses payouts and cannot resume them; claims still work; the admin resumes
  await w.buy(u, h, 5n * LAMPORTS);
  await w.send([w.ix.setPause({ authority: payoutKey.address, payouts: true })], [payoutKey], 'payout key pauses payouts');
  await expectFail(() => w.payout(h, { destination: wallet.address, label: 'payout while paused' }), 'PayoutsPaused');
  await expectFail(() => w.send([w.ix.setPause({ authority: payoutKey.address, payouts: false })], [payoutKey], 'payout key resumes'), 'Unauthorized');
  await w.claim(h, h.founder, { label: 'claim while payouts are paused' });
  await w.buy(u, h, 5n * LAMPORTS);
  await w.send([w.ix.setPause({ authority: w.admin.address, payouts: false })], [w.admin], 'admin resumes payouts');
  await w.payout(h, { destination: wallet.address, label: 'payout after resume' });
  // a new payout wallet: the old opt-in stops working; it is never redirected
  const wallet2 = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet2.address })], [w.admin], 'new payout wallet');
  await w.buy(u, h, 5n * LAMPORTS);
  w.warpSecs(DAY);
  await expectFail(() => w.payout(h, { destination: wallet2.address, label: 'payout under the old opt-in' }), 'DestinationMismatch');
  await expectFail(() => w.payout(h, { destination: wallet.address, label: 'payout to the old wallet' }), 'DestinationMismatch');
  // revoke: by the founder; the rent returns to the founder who signed the opt-in
  const optInRent = w.lamportsOf(w.P.payoutOptIn(h.coin));
  const f0 = w.lamportsOf(h.founder.address);
  await expectFail(() => w.send([w.ix.revokePayoutOptIn({ by: other.address, coin: h.coin, optInFounder: h.founder.address })], [other], 'revoke by a stranger'), 'Unauthorized');
  await expectFail(() => w.send([w.ix.revokePayoutOptIn({ by: h.founder.address, coin: h.coin, optInFounder: other.address })], [h.founder], 'rent to a stranger'), 'InvalidAddress');
  r = await w.send([w.ix.revokePayoutOptIn({ by: h.founder.address, coin: h.coin, optInFounder: h.founder.address })], [h.founder], 'revoke_payout_opt_in');
  assert.deepEqual(r.events[0].data, { city_id: 600n, founder: h.founder.address, by: h.founder.address });
  assert.equal(w.lamportsOf(h.founder.address) - f0, optInRent);
  assert.equal(w.exists(w.P.payoutOptIn(h.coin)), false);
  // re-opt-in to the new wallet; the cooldown on the Coin is not reset by re-opting
  await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: wallet2.address, refHash: ref('y') })], [h.founder], 'opt in to the new wallet');
  await w.payout(h, { destination: wallet2.address, label: 'payout to the new wallet' });
  c = w.coinView(h);
  assert.equal(c.founderPaidOut + c.founderClaimed + c.founderPending, c.founderEarned);
  await w.finish();
});

test('L11 transfer_founder: both signatures; the seat and its pending money move; the old founder loses everything; an old opt-in stops working', async () => {
  const w = await World.create();
  const { h, u } = await coinWithFees(w, 610n, 'SEAT');
  const next = await w.signer(1n); const stranger = await w.signer(1n);
  const payoutKey = await w.signer(5n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: ref('seat') })], [h.founder], 'opt in');
  // both must sign; only the current founder can hand over; the admin cannot
  const noSig = w.ix.transferFounder({ founder: h.founder.address, newFounder: next.address, coin: h.coin, overrides: { new_founder: { address: next.address, role: S.Role.R } } });
  await expectFail(() => w.send([noSig], [h.founder], 'without the new founder\'s signature'), /MissingRequiredSignature|signer|AccountNotSigner/i);
  await expectFail(() => w.send([w.ix.transferFounder({ founder: stranger.address, newFounder: next.address, coin: h.coin })], [stranger, next], 'by a stranger'), 'WrongFounder');
  await expectFail(() => w.send([w.ix.transferFounder({ founder: w.admin.address, newFounder: next.address, coin: h.coin })], [w.admin, next], 'by the admin'), 'WrongFounder');
  const pending = w.coinView(h).founderPending;
  const r = await w.send([w.ix.transferFounder({ founder: h.founder.address, newFounder: next.address, coin: h.coin })], [h.founder, next], 'transfer_founder');
  assert.deepEqual(r.events[0], { name: 'FounderTransferred', data: { city_id: 610n, old: h.founder.address, new: next.address } });
  assert.equal(w.coinView(h).founder, next.address);
  // the old founder can no longer claim; the money went with the seat
  const oldFounder = h.founder;
  await expectFail(() => w.claim(h, oldFounder, { label: 'old founder claims' }), 'WrongFounder');
  const n0 = w.lamportsOf(next.address);
  await w.claim(h, next, { label: 'new founder claims' });
  assert.equal(w.lamportsOf(next.address) - n0, pending);
  // the old opt-in names the old founder: payouts stop
  await w.buy(u, h, 5n * LAMPORTS);
  await expectFail(() => w.payout(h, { destination: wallet.address, label: 'payout under the old founder\'s opt-in' }), 'OptInFounderMismatch');
  // the new founder may revoke it (by == coin.founder); the rent goes to the old founder who paid it
  const o0 = w.lamportsOf(oldFounder.address);
  const rent = w.lamportsOf(w.P.payoutOptIn(h.coin));
  await w.send([w.ix.revokePayoutOptIn({ by: next.address, coin: h.coin, optInFounder: oldFounder.address })], [next], 'new founder revokes the old opt-in');
  assert.equal(w.lamportsOf(oldFounder.address) - o0, rent);
  // the new founder opts in and is paid
  await w.send([w.ix.optInPayout({ founder: next.address, coin: h.coin, expectedDestination: wallet.address, refHash: ref('next') })], [next], 'new founder opts in');
  await w.payout(h, { destination: wallet.address, label: 'payout for the new founder' });
  // handing the seat to the same key is allowed (4.17 names no check)
  await w.send([w.ix.transferFounder({ founder: next.address, newFounder: next.address, coin: h.coin })], [next], 'transfer to itself');
  await w.finish();
});
