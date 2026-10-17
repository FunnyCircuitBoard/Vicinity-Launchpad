// L01, L02 and the settings instructions (VICINITY-CURVE-DESIGN.md 4.1 to 4.5,
// 8.2): init_launchpad only by the upgrade authority, once; the two-step admin
// with the payout-key separation rule at both steps; set_guardian;
// set_payout_config. The invariant checker runs after every transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail } from './helpers.mjs';

const ZERO = S.ADDRESSES.system;

test('L01 init_launchpad: only the upgrade authority, once; every field; the guardian stored', async () => {
  const w = await World.create({ initLaunchpad: false });
  const stranger = await w.signer();
  // a stranger in the upgrade-authority seat
  await expectFail(() => w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: stranger.address, guardian: w.guardian.address })],
    [w.admin, stranger], 'init by a stranger'), 'NotUpgradeAuthority');
  // another program's ProgramData (vicinity_rewards', same upgrade authority) is refused too
  const otherPd = S.findPda([new (await import('@solana/web3.js')).default.PublicKey(S.CLUSTERS.mainnet.rewardsProgram).toBuffer()], S.ADDRESSES.upgradeableLoader)[0];
  await expectFail(() => w.send([w.ix.initLaunchpad({
    payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address, overrides: { program_data: otherPd },
  })], [w.admin, w.deployer], 'init with another ProgramData'), 'NotUpgradeAuthority', 'ConstraintSeeds', 'InvalidAddress');
  // the admin must sign (its seat is a signer)
  const unsigned = w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address, overrides: { admin: { address: w.admin.address, role: S.Role.R } } });
  await expectFail(() => w.send([unsigned], [w.deployer], 'init without the admin signature'), /MissingRequiredSignature|signer/i);
  // the upgrade authority
  const res = await w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address })],
    [w.admin, w.deployer], 'init_launchpad');
  const lp = w.launchpad();
  assert.deepEqual(lp, {
    admin: w.admin.address, pendingAdmin: ZERO, payoutAuthority: ZERO, payoutDestination: ZERO, guardian: w.guardian.address,
    launchesPaused: false, payoutsPaused: false, buysHalted: false, buybacksHalted: false, nextConfigId: 0, bump: S.findPda([Buffer.from('launchpad')], w.programId)[1],
  });
  assert.equal(w.accountInfo(w.P.launchpad()).data.length, S.ACCOUNT_LEN.Launchpad);
  const ev = res.events.find((e) => e.name === 'LaunchpadInitialized');
  assert.deepEqual(ev.data, { admin: w.admin.address, upgrade_authority: w.deployer.address, guardian: w.guardian.address });
  // never twice (plain init)
  await expectFail(() => w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: stranger.address, upgradeAuthority: w.deployer.address, guardian: ZERO })],
    [stranger, w.deployer], 'second init_launchpad'), /already in use/);
  assert.equal(w.launchpad().admin, w.admin.address);
  await w.finish();
});

test('L02 two-step admin: propose, cancel, accept; the separation rule at both steps', async () => {
  const w = await World.create();
  const next = await w.signer(); const other = await w.signer();
  const payoutKey = await w.signer(); const payoutWallet = await w.signer();
  // only the admin proposes
  await expectFail(() => w.send([w.ix.proposeAdmin({ admin: other.address, newAdmin: next.address })], [other], 'propose by a stranger'), 'Unauthorized');
  // nothing pending: accept refuses
  await expectFail(() => w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept with nothing pending'), 'NoPendingAdmin');
  let r = await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose_admin');
  assert.deepEqual(r.events[0], { name: 'AdminProposed', data: { admin: w.admin.address, pending_admin: next.address } });
  assert.equal(w.launchpad().pendingAdmin, next.address);
  await expectFail(() => w.send([w.ix.acceptAdmin({ newAdmin: other.address })], [other], 'accept by the wrong key'), 'NotPendingAdmin');
  // zero cancels
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: ZERO })], [w.admin], 'cancel');
  assert.equal(w.launchpad().pendingAdmin, ZERO);
  await expectFail(() => w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept after cancel'), 'NoPendingAdmin');
  // separation at the first step: the payout key or wallet can never be proposed as admin
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: payoutWallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  await expectFail(() => w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: payoutKey.address })], [w.admin], 'propose the payout key'), 'PayoutKeyNotSeparate');
  await expectFail(() => w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: payoutWallet.address })], [w.admin], 'propose the payout wallet'), 'PayoutKeyNotSeparate');
  // separation at the second step: a proposed admin that became the payout key in between cannot accept
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose');
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: next.address, payoutDestination: payoutWallet.address })], [w.admin], 'payout key = the proposed admin');
  w.payoutKey = next;
  await expectFail(() => w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept while the payout key'), 'PayoutKeyNotSeparate');
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: payoutWallet.address })], [w.admin], 'payout key back');
  w.payoutKey = payoutKey;
  r = await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept_admin');
  assert.deepEqual(r.events[0], { name: 'AdminChanged', data: { old_admin: w.admin.address, new_admin: next.address } });
  assert.deepEqual([w.launchpad().admin, w.launchpad().pendingAdmin], [next.address, ZERO]);
  // the old admin has no power left; the new one has
  const oldAdmin = w.admin;
  w.admin = next;
  await expectFail(() => w.send([w.ix.setGuardian({ admin: oldAdmin.address, guardian: other.address })], [oldAdmin], 'old admin'), 'Unauthorized');
  await w.send([w.ix.setGuardian({ admin: next.address, guardian: other.address })], [next], 'new admin sets the guardian');
  w.guardian = other;
  assert.equal(w.launchpad().guardian, other.address);
  await w.finish();
});

test('set_guardian and set_payout_config: who may, and the separation rules of 4.5', async () => {
  const w = await World.create();
  const g2 = await w.signer(); const pk = await w.signer(); const pw = await w.signer(); const stranger = await w.signer();
  await expectFail(() => w.send([w.ix.setGuardian({ admin: stranger.address, guardian: g2.address })], [stranger], 'stranger'), 'Unauthorized');
  await expectFail(() => w.send([w.ix.setGuardian({ admin: w.guardian.address, guardian: g2.address })], [w.guardian], 'the guardian itself'), 'Unauthorized');
  let r = await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: g2.address })], [w.admin], 'set_guardian');
  assert.deepEqual(r.events[0], { name: 'GuardianChanged', data: { old: w.guardian.address, new: g2.address } });
  w.guardian = g2;
  r = await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: ZERO })], [w.admin], 'no guardian');
  assert.equal(w.launchpad().guardian, ZERO);
  w.guardian = null;
  // payout config: both zero = off, both nonzero and separate otherwise
  const set = (a, d, label) => w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: a, payoutDestination: d })], [w.admin], label);
  await expectFail(() => w.send([w.ix.setPayoutConfig({ admin: stranger.address, payoutAuthority: pk.address, payoutDestination: pw.address })], [stranger], 'stranger'), 'Unauthorized');
  await expectFail(() => set(pk.address, ZERO, 'wallet zero'), 'InvalidAddress');
  await expectFail(() => set(ZERO, pw.address, 'key zero'), 'InvalidAddress');
  await expectFail(() => set(w.admin.address, pw.address, 'key = admin'), 'PayoutKeyNotSeparate');
  await expectFail(() => set(S.ADDRESSES.feeRecipient, pw.address, 'key = FEE_RECIPIENT'), 'PayoutKeyNotSeparate');
  await expectFail(() => set(pk.address, pk.address, 'wallet = key'), 'PayoutKeyNotSeparate');
  await expectFail(() => set(pk.address, w.admin.address, 'wallet = admin'), 'PayoutKeyNotSeparate');
  await expectFail(() => set(pk.address, S.ADDRESSES.feeRecipient, 'wallet = FEE_RECIPIENT'), 'PayoutKeyNotSeparate');
  r = await set(pk.address, pw.address, 'set_payout_config');
  w.payoutKey = pk;
  assert.deepEqual(r.events[0], { name: 'PayoutConfigChanged', data: { old_authority: ZERO, new_authority: pk.address, old_destination: ZERO, new_destination: pw.address } });
  r = await set(ZERO, ZERO, 'payouts off');
  assert.deepEqual([w.launchpad().payoutAuthority, w.launchpad().payoutDestination], [ZERO, ZERO]);
  await w.finish();
});
