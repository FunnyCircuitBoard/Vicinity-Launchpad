// TF01-TF11: the founder's vault, hand-over, and the opt-in dollar payout
// (X Money / UsePaid style): the payout key may only ever pay the one payout
// wallet fixed in the settings, which the founder agreed to, once a day.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { World, C, IDL, P, ADDRESSES, PROGRAM_IDS, LAMPORTS, DAY, expectFail, assertInvariants, eventsNamed, harvest, ata, decodeAccount } from './helpers.mjs';

const WSOL = ADDRESSES.wsol;
const ZERO = PROGRAM_IDS.system;
const REF = createHash('sha256').update('partner-customer-123|salt-9f2').digest();

async function setup() {
  const w = await World.create();
  const founder = await w.signer();
  const coin = await w.launchCoin({ cityId: 600001n, founder });
  w.payoutKey = await w.signer();
  w.payoutWallet = await w.signer();
  return { w, founder, coin };
}
async function earn(w, coin, lamports = 4n * LAMPORTS) {
  const t = await w.signer();
  await w.trade(t, coin, { side: 'buy', amount0: lamports, amount1: 1n });
  await harvest(w, coin);
}
const configurePayouts = (w) => w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: w.payoutKey.address, payoutDestination: w.payoutWallet.address })], [w.admin]);
const optIn = (w, founder, coin, dest = w.payoutWallet.address) => w.send([C.optInPayout({ founder: founder.address, cityId: coin.cityId, expectedDestination: dest, refHash: REF })], [founder], 'opt_in_payout');
const payout = (w, coin, key = w.payoutKey, dest = w.payoutWallet.address, overrides = {}) => w.send([C.payoutFounderFees({ payoutAuthority: key.address, coin, destination: dest, overrides })], [key], 'payout_founder_fees', { feePayer: key });

describe('06 founder and payout', () => {
  let w, founder, coin;
  beforeEach(async () => { ({ w, founder, coin } = await setup()); });

  it('TF01 claim_founder_fees: founder only, the whole vault, with its event', async () => {
    await earn(w, coin);
    const stranger = await w.signer();
    await expectFail(() => w.send([C.claimFounderFees({ founder: stranger.address, coin })], [stranger]), 'WrongFounder');
    w.donate(coin.founderVault, 11n);
    const res = await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder], 'claim_founder_fees');
    w.cu.claim_founder_fees = w.lastCu;
    assert.equal(eventsNamed(res, 'FounderFeesClaimed')[0].data.amount.toString(), '10000011');
    assert.equal(w.balance(ata(founder.address, WSOL)), 10_000_011n);
    assert.equal(w.balance(coin.founderVault), 0n);
    assert.equal(w.coin(coin.cityId).founderClaimed, 10_000_011n);
    assertInvariants(w);
  });

  it('TF02 a claim with an empty vault succeeds and moves nothing', async () => {
    const res = await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder]);
    assert.equal(eventsNamed(res, 'FounderFeesClaimed').length, 0);
    assert.equal(w.coin(coin.cityId).founderClaimed, 0n);
  });

  it('TF03 transfer_founder needs both signatures; then only the new founder can claim', async () => {
    await earn(w, coin);
    const next = await w.signer();
    const ix = C.transferFounder({ founder: founder.address, newFounder: next.address, cityId: coin.cityId });
    ix.accounts[1].role = 0; // new founder not signing
    await expectFail(() => w.send([ix], [founder]), 'AccountNotSigner', /missing required signature/i);
    const stranger = await w.signer();
    await expectFail(() => w.send([C.transferFounder({ founder: stranger.address, newFounder: next.address, cityId: coin.cityId })], [stranger, next]), 'WrongFounder');
    // the admin cannot reassign a founder
    await expectFail(() => w.send([C.transferFounder({ founder: w.admin.address, newFounder: next.address, cityId: coin.cityId })], [w.admin, next]), 'WrongFounder');
    const res = await w.send([C.transferFounder({ founder: founder.address, newFounder: next.address, cityId: coin.cityId })], [founder, next]);
    const ev = eventsNamed(res, 'FounderTransferred')[0].data;
    assert.equal(ev.old.toBase58(), founder.address);
    assert.equal(ev.new.toBase58(), next.address);
    await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder]), 'WrongFounder');
    await w.send([C.claimFounderFees({ founder: next.address, coin })], [next]);
    assert.equal(w.balance(ata(next.address, WSOL)), 10_000_000n);
    assertInvariants(w);
  });

  it('TF04 opt_in_payout: refused until configured, refused for another destination, stores the copy and the hash', async () => {
    await expectFail(() => optIn(w, founder, coin), 'PayoutsNotConfigured');
    await configurePayouts(w);
    await expectFail(() => optIn(w, founder, coin, w.admin.address), 'DestinationMismatch');
    const stranger = await w.signer();
    await expectFail(() => w.send([C.optInPayout({ founder: stranger.address, cityId: coin.cityId, expectedDestination: w.payoutWallet.address, refHash: REF })], [stranger]), 'WrongFounder');
    const res = await optIn(w, founder, coin);
    const ev = eventsNamed(res, 'PayoutOptedIn')[0].data;
    assert.equal(ev.destination.toBase58(), w.payoutWallet.address);
    assert.deepEqual(Buffer.from(ev.ref_hash), REF);
    const o = decodeAccount(IDL.launchpad, 'PayoutOptIn', w.account(P.payoutOptIn(coin.address)).data);
    assert.equal(o.coin.toBase58(), coin.address);
    assert.equal(o.founder.toBase58(), founder.address);
    assert.equal(o.agreed_destination.toBase58(), w.payoutWallet.address);
    assert.deepEqual(Buffer.from(o.ref_hash), REF);
    await expectFail(() => optIn(w, founder, coin), /already in use/);
  });

  it('TF05 a payout: payout key only, only to the fixed wallet, the whole vault, sequence number and event', async () => {
    await earn(w, coin);
    await configurePayouts(w);
    await optIn(w, founder, coin);
    const stranger = await w.signer();
    await expectFail(() => payout(w, coin, stranger), 'Unauthorized');
    await expectFail(() => payout(w, coin, w.admin), 'Unauthorized');
    // any other destination is refused: the stranger's, the admin's, the dev wallet's, the founder's
    for (const dest of [stranger.address, w.admin.address, ADDRESSES.feeRecipient, founder.address]) {
      await expectFail(() => payout(w, coin, w.payoutKey, dest), 'DestinationMismatch');
    }
    // the right wallet with somebody else's token account
    await expectFail(() => payout(w, coin, w.payoutKey, w.payoutWallet.address, { destination_token_account: w.emptyTokenAccount(stranger.address, WSOL) }), 'ConstraintAssociated', 'ConstraintTokenOwner', /AccountNotAssociatedTokenAccount|ConstraintAssociated/);
    const res = await payout(w, coin);
    w.cu.payout_founder_fees = w.lastCu;
    const ev = eventsNamed(res, 'FounderPaidOut')[0].data;
    assert.equal(ev.amount.toString(), '10000000');
    assert.equal(ev.seq.toString(), '1');
    assert.equal(ev.destination.toBase58(), w.payoutWallet.address);
    assert.deepEqual(Buffer.from(ev.ref_hash), REF);
    assert.equal(w.balance(ata(w.payoutWallet.address, WSOL)), 10_000_000n);
    assert.equal(w.balance(coin.founderVault), 0n);
    const c = w.coin(coin.cityId);
    assert.equal(c.founderPaidOut, 10_000_000n);
    assert.equal(c.payoutSeq, 1n);
    assert.equal(c.lastPayoutAt, w.now());
    assertInvariants(w);
  });

  it('TF06 a second payout within 24 hours is refused, also after revoking and opting in again', async () => {
    await earn(w, coin);
    await configurePayouts(w);
    await optIn(w, founder, coin);
    await payout(w, coin);
    await earn(w, coin);
    await expectFail(() => payout(w, coin), 'PayoutTooSoon');
    await w.send([C.revokePayoutOptIn({ by: founder.address, cityId: coin.cityId, optInFounder: founder.address })], [founder]);
    await optIn(w, founder, coin);
    await expectFail(() => payout(w, coin), 'PayoutTooSoon');
    w.warp(DAY - 2n);
    await expectFail(() => payout(w, coin), 'PayoutTooSoon');
    w.warp(2n);
    await payout(w, coin);
    assert.equal(w.coin(coin.cityId).payoutSeq, 2n);
    // an empty vault: nothing happens, no sequence number, no new cooldown
    w.warp(DAY);
    const seqBefore = w.coin(coin.cityId);
    const res = await payout(w, coin);
    assert.equal(eventsNamed(res, 'FounderPaidOut').length, 0);
    assert.equal(w.coin(coin.cityId).payoutSeq, seqBefore.payoutSeq);
    assert.equal(w.coin(coin.cityId).lastPayoutAt, seqBefore.lastPayoutAt);
    assertInvariants(w);
  });

  it('TF07 the admin changes the payout wallet: the old opt-in stops (never redirected) until the founder opts in again', async () => {
    await earn(w, coin);
    await configurePayouts(w);
    await optIn(w, founder, coin);
    const newWallet = await w.signer();
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: w.payoutKey.address, payoutDestination: newWallet.address })], [w.admin]);
    await expectFail(() => payout(w, coin, w.payoutKey, newWallet.address), 'DestinationMismatch');
    await expectFail(() => payout(w, coin, w.payoutKey, w.payoutWallet.address), 'DestinationMismatch');
    assert.equal(w.balance(coin.founderVault), 10_000_000n);
    await w.send([C.revokePayoutOptIn({ by: founder.address, cityId: coin.cityId, optInFounder: founder.address })], [founder]);
    await optIn(w, founder, coin, newWallet.address);
    await payout(w, coin, w.payoutKey, newWallet.address);
    assert.equal(w.balance(ata(newWallet.address, WSOL)), 10_000_000n);
    assertInvariants(w);
  });

  it('TF08 after a founder hand-over the stale opt-in is refused, and the new founder can close it', async () => {
    await earn(w, coin);
    await configurePayouts(w);
    await optIn(w, founder, coin);
    const next = await w.signer();
    await w.send([C.transferFounder({ founder: founder.address, newFounder: next.address, cityId: coin.cityId })], [founder, next]);
    await expectFail(() => payout(w, coin), 'OptInFounderMismatch');
    const stranger = await w.signer();
    await expectFail(() => w.send([C.revokePayoutOptIn({ by: stranger.address, cityId: coin.cityId, optInFounder: founder.address })], [stranger]), 'Unauthorized');
    // the rent goes back to whoever signed the opt-in, never elsewhere
    await expectFail(() => w.send([C.revokePayoutOptIn({ by: next.address, cityId: coin.cityId, optInFounder: next.address })], [next]), 'InvalidAddress');
    const before = w.lamportsOf(founder.address);
    const rent = w.lamportsOf(P.payoutOptIn(coin.address));
    const res = await w.send([C.revokePayoutOptIn({ by: next.address, cityId: coin.cityId, optInFounder: founder.address })], [next]);
    assert.equal(eventsNamed(res, 'PayoutOptInRevoked')[0].data.by.toBase58(), next.address);
    assert.equal(w.lamportsOf(founder.address), before + rent);
    assertInvariants(w);
  });

  it("TF09 while payouts are paused a payout is refused, and the founder's own claim still works", async () => {
    await earn(w, coin);
    await configurePayouts(w);
    await optIn(w, founder, coin);
    await w.send([C.setPause({ authority: w.payoutKey.address, payouts: true })], [w.payoutKey]);
    await expectFail(() => payout(w, coin), 'PayoutsPaused');
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder]);
    assert.equal(w.balance(ata(founder.address, WSOL)), 10_000_000n);
    assertInvariants(w);
  });

  it('TF10 the founder can claim directly while opted in', async () => {
    await earn(w, coin);
    await configurePayouts(w);
    await optIn(w, founder, coin);
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder]);
    assert.equal(w.balance(ata(founder.address, WSOL)), 10_000_000n);
    const res = await payout(w, coin); // nothing left: a no-op
    assert.equal(eventsNamed(res, 'FounderPaidOut').length, 0);
    assertInvariants(w);
  });

  it('TF11 revoke_payout_opt_in closes it and refunds the rent; no payout works afterwards, paused or not', async () => {
    await earn(w, coin);
    await configurePayouts(w);
    await optIn(w, founder, coin);
    await w.send([C.setPause({ authority: w.admin.address, launches: true, payouts: true })], [w.admin]);
    const before = w.lamportsOf(founder.address);
    const rent = w.lamportsOf(P.payoutOptIn(coin.address));
    await w.send([C.revokePayoutOptIn({ by: founder.address, cityId: coin.cityId, optInFounder: founder.address })], [founder], 'revoke', { feePayer: w.payer });
    assert.equal(w.lamportsOf(founder.address), before + rent);
    assert.equal(w.exists(P.payoutOptIn(coin.address)), false);
    await w.send([C.setPause({ authority: w.admin.address, launches: false, payouts: false })], [w.admin]);
    await expectFail(() => payout(w, coin), 'AccountNotInitialized');
    // lamports sent to the closed address do not revive it
    w.svm.airdrop((await import('@solana/kit')).address(P.payoutOptIn(coin.address)), (await import('@solana/kit')).lamports(5_000_000n));
    await expectFail(() => payout(w, coin), 'AccountNotInitialized', 'AccountOwnedByWrongProgram');
    assertInvariants(w);
  });
});
