// Governance regressions of review round 1 (VICINITY-CURVE-DESIGN.md 8.1, 8.4, 8.5;
// VICINITY-CURVE-NOTES.md 42 and 43):
//
//   * GOV-1: R1 in the other direction rests on the old vicinity_launchpad staying
//     paused (O19), so whoever administers the old program must be the same multisig
//     as this program's admin. approve_launch and launch now require the old
//     Launchpad's admin (bytes 8..40) to equal launchpad.admin and its pending admin
//     (bytes 40..72) to be zero (LegacyAdminMismatch). On mainnet the old admin was
//     the owner's wallet 13qRam (FEE_RECIPIENT); the test runs that exact case.
//   * GOV-2: FEE_RECIPIENT only receives: it can be neither the admin, the proposed
//     admin nor the guardian (FeeRecipientRole); the guardian can be neither the
//     payout key nor the payout wallet (PayoutKeyNotSeparate).
//
// Keys for which the suite has no private key (FEE_RECIPIENT) sign with zeros in a
// World whose signature checks are off (offlineKey).
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { World, S, expectFail, offlineKey, LAMPORTS } from './helpers.mjs';

const { PublicKey } = web3;
const ZERO = S.ADDRESSES.system;
const FEE = String(S.ADDRESSES.feeRecipient);

test('GOV-1 the old program\'s admin must be the vicinity_curve admin with no transfer pending, at every approval and every launch', async () => {
  const w = await World.create({ dbcProgram: true, legacy: 'none' });
  w.svm.withSigverify(false);
  // mainnet as recorded in release/mainnet-2026-10-10/BUILD.md: the old program's admin is 13qRam, which is also FEE_RECIPIENT
  const hot = offlineKey(FEE);
  await w.legacyInit({ admin: hot });
  await w.legacyEnable(false); // 8.5 as the deploy checklist checks it: launches paused, configs disabled
  assert.deepEqual(w.legacyAdmins(), { admin: FEE, pendingAdmin: ZERO });
  const founder = await w.signer(50n);

  // while the old program has another admin, nothing here can be approved or launched
  await expectFail(() => w.approve({ cityId: 4100n, founder, symbol: 'CITYA' }), 'LegacyAdminMismatch');

  // the hand-over the 8.4 precondition asks for: old propose_admin(the Squads vault), accepted by the vault
  await w.legacyHandOver(w.admin, { accept: false });
  assert.deepEqual(w.legacyAdmins(), { admin: FEE, pendingAdmin: w.admin.address });
  await expectFail(() => w.approve({ cityId: 4100n, founder, symbol: 'CITYA' }), 'LegacyAdminMismatch'); // pending: still refused
  await w.legacyHandOver(w.admin, { from: hot });
  assert.deepEqual(w.legacyAdmins(), { admin: w.admin.address, pendingAdmin: ZERO });
  const a = await w.launchCoin({ cityId: 4100n, founder, symbol: 'CITYA' });
  await w.approve({ cityId: 4101n, founder, symbol: 'CITYB' });

  // the finding's attack, replayed: the old program's former admin (one hot key) can no longer reopen it
  await expectFail(() => w.legacyPause(false, { by: hot }), /Unauthorized|0x1770|ConstraintHasOne|has.?one/i);
  await expectFail(() => w.legacyEnable(true, { by: hot }), /Unauthorized|0x1770|ConstraintHasOne|has.?one/i);

  // a transfer pending in the old program, to anyone, stops approvals and launches here until it is cancelled
  const stranger = await w.signer(5n);
  await w.legacyHandOver(stranger, { accept: false });
  await expectFail(() => w.launch({ cityId: 4101n, founder, label: 'launch while the old admin is being handed over' }), 'LegacyAdminMismatch');
  await expectFail(() => w.approve({ cityId: 4102n, founder, symbol: 'CITYC' }), 'LegacyAdminMismatch');
  await w.send([w.legacyIx('propose_admin', { new_admin: new PublicKey(ZERO) }, { admin: w.admin.address, launchpad: w.legacyPdas().launchpad })], [w.admin], 'legacy cancel the transfer');
  const b = await w.launch({ cityId: 4101n, founder });

  // a hand-over of this program's admin: the old program's admin must follow (4.3, 8.2) before anything is approved or launched
  await w.approve({ cityId: 4102n, founder, symbol: 'CITYC' });
  const next = await w.signer(5n);
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose_admin');
  await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept_admin');
  const oldAdmin = w.admin;
  w.admin = next;
  await expectFail(() => w.approve({ cityId: 4103n, founder, symbol: 'CITYD' }), 'LegacyAdminMismatch');
  await expectFail(() => w.launch({ cityId: 4102n, founder, label: 'launch before the old admin followed' }), 'LegacyAdminMismatch');
  await w.legacyHandOver(next, { from: oldAdmin });
  await w.launch({ cityId: 4102n, founder });
  await w.launchCoin({ cityId: 4103n, founder, symbol: 'CITYD' });

  // the coins launched here are the only coins of their cities
  for (const h of [a, b]) assert.equal(w.accountInfo(w.legacyPdas().coin(h.cityId)), null);
  await w.finish();
});

test('GOV-1 with the old program\'s admin aligned, an old approval or reopening still needs that same admin (R1 in both directions, 8.5)', async () => {
  const w = await World.create({ dbcProgram: true });
  const founder = await w.signer(50n);
  await w.approve({ cityId: 4110n, founder, symbol: 'ALIGN' });
  // only the shared admin can act on the old program; whatever it does there, the checks here still hold
  await w.legacyEnable(true);
  await w.legacyApprove({ cityId: 4110n, founder, symbol: 'ALIGN' });
  await expectFail(() => w.launch({ cityId: 4110n, founder }), 'LegacyApprovalExists');
  await w.legacyRevoke(4110n);
  await w.legacyPause(false);
  await expectFail(() => w.launch({ cityId: 4110n, founder }), 'LegacyLaunchesOpen');
  await w.legacyPause(true);
  await w.launch({ cityId: 4110n, founder });
  await w.finish();
});

test('GOV-2 FEE_RECIPIENT can be neither the admin nor the guardian (init_launchpad, propose_admin, accept_admin, set_guardian)', async () => {
  const w = await World.create({ initLaunchpad: false });
  w.svm.withSigverify(false);
  const fee = offlineKey(FEE);
  await expectFail(() => w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: FEE, upgradeAuthority: w.deployer.address, guardian: w.guardian.address })], [fee, w.deployer], 'init_launchpad with admin = FEE_RECIPIENT'), 'FeeRecipientRole');
  await expectFail(() => w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: FEE })], [w.admin, w.deployer], 'init_launchpad with guardian = FEE_RECIPIENT'), 'FeeRecipientRole');
  await w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address })], [w.admin, w.deployer], 'init_launchpad');
  // propose_admin refuses it
  await expectFail(() => w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: FEE })], [w.admin], 'propose FEE_RECIPIENT'), 'FeeRecipientRole');
  // accept_admin refuses it too (a pending FEE_RECIPIENT can only be written out of band now; accept checks again)
  const lpAddr = w.P.launchpad();
  const raw = w.accountInfo(lpAddr);
  const edited = Buffer.from(raw.data); new PublicKey(FEE).toBuffer().copy(edited, 40);
  w.setRaw(lpAddr, edited, w.programId, raw.lamports);
  await expectFail(() => w.send([w.ix.acceptAdmin({ newAdmin: FEE })], [fee], 'accept_admin by FEE_RECIPIENT'), 'FeeRecipientRole');
  w.setRaw(lpAddr, raw.data, w.programId, raw.lamports);
  // set_guardian refuses it
  await expectFail(() => w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: FEE })], [w.admin], 'set_guardian(FEE_RECIPIENT)'), 'FeeRecipientRole');
  assert.equal(w.launchpad().guardian, w.guardian.address);
  await w.finish();
});

test('GOV-2 the guardian is neither the payout key nor the payout wallet (set_payout_config, set_guardian, propose_admin, accept_admin)', async () => {
  const w = await World.create();
  const pk = await w.signer(1n); const pw = await w.signer(1n);
  const set = (a, d, label) => w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: a, payoutDestination: d })], [w.admin], label);
  await expectFail(() => set(w.guardian.address, pw.address, 'payout key = guardian'), 'PayoutKeyNotSeparate');
  await expectFail(() => set(pk.address, w.guardian.address, 'payout wallet = guardian'), 'PayoutKeyNotSeparate');
  await set(pk.address, pw.address, 'set_payout_config');
  w.payoutKey = pk;
  await expectFail(() => w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: pk.address })], [w.admin], 'guardian = payout key'), 'PayoutKeyNotSeparate');
  await expectFail(() => w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: pw.address })], [w.admin], 'guardian = payout wallet'), 'PayoutKeyNotSeparate');
  const g2 = await w.signer(1n);
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: g2.address })], [w.admin], 'another guardian');
  w.guardian = g2;
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: ZERO })], [w.admin], 'no guardian');
  w.guardian = null;
  // payouts off: the guardian may be any key again
  await set(ZERO, ZERO, 'payouts off');
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: pk.address })], [w.admin], 'guardian = the former payout key, payouts off');
  w.guardian = pk; w.payoutKey = null;
  await expectFail(() => set(pk.address, pw.address, 'payout key = guardian again'), 'PayoutKeyNotSeparate');
  // the admin hand-over checks the guardian rule with the proposed admin
  const next = await w.signer(1n);
  await set(next.address, pw.address, 'payout key = the next admin');
  await expectFail(() => w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose the payout key'), 'PayoutKeyNotSeparate');
  await w.finish();
});

test('GOV-2 a withdrawal never pays the guardian: the state the finding reached (guardian = FEE_RECIPIENT) is now refused at its source', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 4200n, symbol: 'GUARD' });
  const u = await w.signer(100n);
  await w.buy(u, h, 10n * LAMPORTS);
  await expectFail(() => w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: FEE })], [w.admin], 'set_guardian(FEE_RECIPIENT)'), 'FeeRecipientRole');
  await w.withdraw(h); // I21 holds: FEE_RECIPIENT is no role key
  await w.finish();
});
