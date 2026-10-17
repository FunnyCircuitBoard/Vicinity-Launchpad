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
//   * OPS-1 (review round 4): vicinity_rewards' registry admin alone signs init_city, and
//     a city's config can never be changed, so while a hot key held that seat it could
//     create a new coin's config with wrong economics before the multisig's and freeze
//     the holders' share for good. approve_launch and launch now also require the
//     registry's admin to be launchpad.admin with no transfer pending
//     (RewardsRegistryAdminMismatch).
//   * R4-DIFF-4, OPS-3 (review round 4): a stolen guardian could make the one-proposal
//     recovery fail by halting buybacks late in the time lock; the SDK's
//     guardianRecovery builds a recovery no flag can make fail.
//   * OPS-4 (review round 4): the deploy checklist of 8.4 (scripts/vcurve/preflight.mjs)
//     reads every precondition from the chain; an old Approval left when the old
//     program is closed blocks its city here forever, so it is a problem before a close.
//   * Review round 5: the guardian is never the admin or the proposed admin
//     (GuardianIsAdmin, R5-CONS-1); the checklist checks a proposed guardian or payout key
//     against every founder before the proposal is signed (R5-DIFF-2, R5-CONS-2) and
//     accepts an immutable old program (R5-DIFF-3, R5-CONS-3).
//
// Keys for which the suite has no private key (FEE_RECIPIENT) sign with zeros in a
// World whose signature checks are off (offlineKey).
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { address } from '@solana/kit';
import { World, S, expectFail, offlineKey, LAMPORTS, DAY } from './helpers.mjs';
import { checkDeployPreconditions, checklistAddresses, parseArgs, programDataState } from '../scripts/vcurve/preflight.mjs';

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
  // and so must vicinity_rewards' registry admin (8.2, OPS-1)
  await expectFail(() => w.launch({ cityId: 4102n, founder, label: 'launch before the registry admin followed' }), 'RewardsRegistryAdminMismatch');
  await w.registryHandOver(next, { from: oldAdmin });
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

// ---------------------------------------------------------------- review round 2: the founder seat (R2-DIFF-1, SPEC-1; NOTES 49)
// A coin's founder receives that coin's founder share (4.16, 4.20), so the seat never goes to a key that may not touch
// money: FEE_RECIPIENT (only receives, FeeRecipientRole), the guardian (only brakes) or the payout key (only pays opted-in
// founders to the payout wallet), FounderHoldsRole for the last two. approve_launch checks the founder it names, launch
// checks the signing founder again against the settings of that moment, and transfer_founder checks the new founder
// (it now reads the Launchpad). The admin may still be a founder: it chooses every founder anyway (8.1).
test('R2-DIFF-1, SPEC-1 the founder seat never goes to FEE_RECIPIENT, the guardian or the payout key (approve_launch, launch, transfer_founder); the admin may still be approved (8.1)', async () => {
  const w = await World.create();
  w.svm.withSigverify(false);
  const fee = offlineKey(FEE);
  const pk = await w.signer(1n); const pw = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: pw.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  // approve_launch refuses each of the three as the founder it names
  await expectFail(() => w.approve({ cityId: 4300n, founder: FEE, symbol: 'SEATA' }), 'FeeRecipientRole');
  await expectFail(() => w.approve({ cityId: 4300n, founder: w.guardian, symbol: 'SEATA' }), 'FounderHoldsRole');
  await expectFail(() => w.approve({ cityId: 4300n, founder: pk, symbol: 'SEATA' }), 'FounderHoldsRole');

  // launch checks again, against the settings at launch: a founder who became the guardian after the approval cannot launch
  const f = await w.signer(50n);
  await w.approve({ cityId: 4300n, founder: f, symbol: 'SEATA' });
  const g0 = w.guardian;
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: f.address })], [w.admin], 'set_guardian(the approved founder)');
  w.guardian = f;
  await expectFail(() => w.launch({ cityId: 4300n, founder: f, label: 'launch by the guardian' }), 'FounderHoldsRole');
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: g0.address })], [w.admin], 'set_guardian back');
  w.guardian = g0;
  const h = await w.launch({ cityId: 4300n, founder: f });
  // and an approval naming FEE_RECIPIENT (only possible out of band now) cannot be launched
  await w.approve({ cityId: 4301n, founder: f, symbol: 'SEATB' });
  const apAddr = w.P.approval(4301n); const raw = w.accountInfo(apAddr);
  const edited = Buffer.from(raw.data); new PublicKey(FEE).toBuffer().copy(edited, 16);
  w.setRaw(apAddr, edited, w.programId, raw.lamports);
  assert.equal(w.approval(4301n).founder, FEE);
  await expectFail(() => w.launch({ cityId: 4301n, founder: fee, payer: w.payer, label: 'launch by FEE_RECIPIENT' }), 'FeeRecipientRole');
  w.setRaw(apAddr, raw.data, w.programId, raw.lamports);
  await w.send([w.ix.revokeApproval({ by: w.admin.address, cityId: 4301n, rentPayer: w.admin.address })], [w.admin], 'revoke');

  // transfer_founder refuses each of the three as the new founder, even with its co-signature; nothing moves
  const u = await w.signer(100n);
  await w.buy(u, h, 10n * LAMPORTS);
  const pending = w.coinView(h).founderPending;
  assert.ok(pending > 0n);
  for (const [to, code] of [[fee, 'FeeRecipientRole'], [w.guardian, 'FounderHoldsRole'], [pk, 'FounderHoldsRole']]) {
    await expectFail(() => w.send([w.ix.transferFounder({ founder: f.address, newFounder: to.address, coin: h.coin })], [f, to], `transfer_founder to ${to.address}`), code);
  }
  assert.equal(w.coinView(h).founder, f.address);
  // a plain key still takes the seat, and the seat's money with it
  const next = await w.signer(5n);
  await w.send([w.ix.transferFounder({ founder: f.address, newFounder: next.address, coin: h.coin })], [f, next], 'transfer_founder');
  const n0 = w.lamportsOf(next.address);
  await w.claim(h, next);
  assert.equal(w.lamportsOf(next.address) - n0, pending);
  // the payout wallet only receives, like any founder's wallet: it may hold a seat
  await w.approve({ cityId: 4302n, founder: pw, symbol: 'SEATC' });
  // the admin chooses every founder and may approve itself (8.1's worst case); refusing its own key would protect nothing
  await w.approve({ cityId: 4303n, founder: w.admin, symbol: 'SEATD' });
  await w.finish();
});

test('R2-DIFF-1 init_launchpad refuses FEE_RECIPIENT as the upgrade authority (later changes of the upgrade authority are a deploy precondition, 8.4)', async () => {
  const w = await World.create({ initLaunchpad: false });
  w.svm.withSigverify(false);
  const fee = offlineKey(FEE);
  w.loadUpgradeable(w.programId, w.curveSo, FEE); // the program's upgrade authority is FEE_RECIPIENT
  await expectFail(() => w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: FEE, guardian: w.guardian.address })],
    [w.admin, fee], 'init_launchpad with upgrade authority = FEE_RECIPIENT'), 'FeeRecipientRole');
  w.loadUpgradeable(w.programId, w.curveSo, w.deployer.address);
  await w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address })],
    [w.admin, w.deployer], 'init_launchpad');
  await w.finish();
});

// ---------------------------------------------------------------- review round 4
const pkb = (a) => new PublicKey(String(a)).toBuffer();

test('OPS-1 the rewards registry\'s admin must be the vicinity_curve admin with no transfer pending, at every approval and every launch; a hot registry admin can no longer squat a coin\'s rewards config', async () => {
  const w = await World.create({ rewards: false });
  w.svm.withSigverify(false);
  // mainnet as recorded in release/mainnet-2026-10-10/BUILD.md: the registry admin is 13qRam, which is also FEE_RECIPIENT
  const hot = offlineKey(FEE);
  const R = w.rewardsPdas();
  const rid = S.CLUSTERS.mainnet.rewardsProgram;
  await w.send([w.rewardsIx('init_registry', {}, {
    payer: w.payer.address, upgrade_authority: w.deployer.address, admin: hot.address, program: rid,
    program_data: S.findPda([pkb(rid)], S.ADDRESSES.upgradeableLoader)[0], registry: R.registry,
  })], [w.deployer, hot], 'init_registry with the hot admin');
  assert.equal(R.registry, S.CLUSTERS.mainnet.rewardsRegistry);
  assert.deepEqual(w.registryAdmins(), { admin: FEE, pendingAdmin: ZERO });
  const founder = await w.signer(50n);
  // while the registry has another admin, nothing here can be approved or launched
  await expectFail(() => w.approve({ cityId: 4200n, founder, symbol: 'REGA' }), 'RewardsRegistryAdminMismatch');
  // the hand-over 8.4 asks for: registry propose_admin(the vault) by the hot key, accepted by the vault
  await w.registryHandOver(w.admin, { from: hot, accept: false });
  await expectFail(() => w.approve({ cityId: 4200n, founder, symbol: 'REGA' }), 'RewardsRegistryAdminMismatch'); // pending: still refused
  await w.send([w.rewardsIx('accept_admin', {}, { new_admin: w.admin.address, registry: R.registry })], [w.admin], 'registry accept_admin by the vault');
  assert.deepEqual(w.registryAdmins(), { admin: w.admin.address, pendingAdmin: ZERO });
  const h = await w.launchCoin({ cityId: 4200n, founder, symbol: 'REGA' });
  await w.approve({ cityId: 4201n, founder, symbol: 'REGB' });
  // the finding's attack, replayed: the former registry admin can no longer create the coin's config
  await expectFail(() => w.send([w.rewardsIx('init_city', { reward_model: { Creator: {} }, founder_bps: 10_000, city_tag: Array(32).fill(0) }, {
    payer: hot.address, admin: hot.address, registry: R.registry, authority: hot.address, founder: hot.address, city_coin_mint: h.mint,
    reward_mint: S.ADDRESSES.nativeMint, config: R.city(h.mint), vault: R.vault(R.city(h.mint)), token_program: S.ADDRESSES.token, system_program: S.ADDRESSES.system,
  })], [hot], 'the hot key\'s init_city (Creator, founder_bps 10000)'), /Unauthorized|0x1770|ConstraintHasOne|has.?one|2001/i);
  // the vault's own config, and the holders' share is forwarded
  const u = await w.signer(30n);
  await w.buy(u, h, 10n * LAMPORTS);
  await w.initRewardsCity(h);
  const r = await w.forward(h);
  assert.ok(r.events[0].data.amount > 0n);
  // a transfer pending in the registry, to anyone (even to this admin), stops approvals and launches until it is cancelled
  const stranger = await w.signer(5n);
  for (const to of [stranger, w.admin]) {
    await w.send([w.rewardsIx('propose_admin', { new_admin: new PublicKey(String(to.address)) }, { admin: w.admin.address, registry: R.registry })], [w.admin], 'registry propose_admin');
    await expectFail(() => w.launch({ cityId: 4201n, founder, label: 'launch while the registry admin is being handed over' }), 'RewardsRegistryAdminMismatch');
    await expectFail(() => w.approve({ cityId: 4202n, founder, symbol: 'REGC' }), 'RewardsRegistryAdminMismatch');
  }
  await w.send([w.rewardsIx('propose_admin', { new_admin: new PublicKey(ZERO) }, { admin: w.admin.address, registry: R.registry })], [w.admin], 'registry cancel the transfer');
  await w.launch({ cityId: 4201n, founder });
  // the account in the registry slot: only the real registry at the compiled address (owner, size, discriminator)
  const good = w.accountInfo(R.registry);
  await expectFail(() => w.send([w.ix.approveLaunch({ admin: w.admin.address, cityId: 4203n, founder: founder.address, configId: 0, name: 'Demo City', symbol: 'REGD',
    metaHash: Array(32).fill(7), expiresAt: w.now() + DAY, overrides: { rewards_registry: S.CLUSTERS.devnet.rewardsRegistry } })], [w.admin], 'another registry address'), 'InvalidAddress');
  for (const [what, owner, data] of [
    ['a System-owned copy', S.ADDRESSES.system, good.data],
    ['another program\'s copy', S.ADDRESSES.metaplex, good.data],
    ['one byte longer', S.CLUSTERS.mainnet.rewardsProgram, Buffer.concat([good.data, Buffer.alloc(1)])],
    ['another discriminator', S.CLUSTERS.mainnet.rewardsProgram, Buffer.concat([Buffer.from(S.REWARDS_CITY_CONFIG_DISCRIMINATOR), good.data.subarray(8)])],
  ]) {
    w.setRaw(R.registry, data, owner);
    await expectFail(() => w.approve({ cityId: 4203n, founder, symbol: 'REGD' }), 'RewardsRegistryAdminMismatch');
    void what;
  }
  w.setRaw(R.registry, good.data, S.CLUSTERS.mainnet.rewardsProgram, good.lamports);
  // a hand-over of this program's admin: the registry admin follows with the old program's admin (8.2)
  const next = await w.signer(5n);
  await w.adminHandOver(next);
  assert.deepEqual(w.registryAdmins(), { admin: next.address, pendingAdmin: ZERO });
  await w.launchCoin({ cityId: 4203n, founder, symbol: 'REGD' });
  await w.finish();
});

test('R4-DIFF-4, OPS-3 a stolen guardian traps the one-proposal recovery with a late buyback halt; the SDK\'s guardianRecovery cannot be trapped, and buys reopen in a later proposal', async () => {
  const w = await World.create();
  const thief = w.guardian;
  const h = await w.launchCoin({ cityId: 4210n, symbol: 'TRAP' });
  const u = await w.signer(50n);
  await w.buy(u, h, 5n * LAMPORTS);
  await w.send([w.ix.setPause({ authority: thief.address, launches: true, buys: true })], [thief], 'the thief halts launches and buys');
  const newGuardian = await w.signer(1n);
  // the recovery as revision 3's 4.4 described it, with the SDK's defaults (buybacks null): valid when it is written
  const oneProposal = () => [w.ix.setGuardian({ admin: w.admin.address, guardian: newGuardian.address }), w.ix.setPause({ authority: w.admin.address, launches: false, buys: false })];
  assert.equal((await w.simulate(oneProposal(), [w.admin])).ok, true);
  const recovery = () => w.ix.guardianRecovery({ admin: w.admin.address, guardian: newGuardian.address, launches: false });
  assert.equal((await w.simulate(recovery(), [w.admin])).ok, true);
  // late in the 48-hour time lock the thief halts buybacks (allowed while buys are halted)
  w.warpSecs(47 * 3600);
  await w.send([w.ix.setPause({ authority: thief.address, buybacks: true })], [thief], 'the thief halts buybacks late in the time lock');
  // the one-proposal recovery now fails, set_guardian reverts with it, and retrying changes nothing
  for (const label of ['the one-proposal recovery', 'the same proposal again']) {
    await expectFail(() => w.send(oneProposal(), [w.admin], label), 'BuybackHaltWithoutBuyHalt');
    assert.equal(w.launchpad().guardian, String(thief.address), `${label}: the thief keeps the seat`);
  }
  // the SDK's recovery executes whatever the thief set: the guardian is replaced, buybacks resume, buys stay halted
  await w.send(recovery(), [w.admin], 'guardianRecovery');
  let lp = w.launchpad();
  assert.deepEqual([lp.guardian, lp.launchesPaused, lp.buysHalted, lp.buybacksHalted], [String(newGuardian.address), false, true, false]);
  await expectFail(() => w.send([w.ix.setPause({ authority: thief.address, buybacks: true })], [thief], 'the former guardian'), 'Unauthorized');
  // the keeper drains the backlog while buys are still refused, then the second proposal reopens buys
  const back = await w.sell(u, h, w.balanceOf(u, h.mint) / 2n, { label: 'a sell during the halt' });
  void back;
  w.warpSlots(Number(S.BUYBACK_INTERVAL_SLOTS));
  await w.buyback(h, { label: 'the keeper drains' });
  await expectFail(() => w.buy(u, h, LAMPORTS, { label: 'a buy before the second proposal' }), 'BuysHalted');
  await w.send([w.ix.setPause({ authority: w.admin.address, buys: false })], [w.admin], 'the second proposal: buys reopen');
  await w.buy(u, h, LAMPORTS, { label: 'a buy after the recovery' });
  // with keepBuybacksHalted (buybacks themselves in question) the recovery cannot be trapped either
  await w.send([w.ix.setPause({ authority: newGuardian.address, buys: true })], [newGuardian], 'the new guardian halts buys');
  const third = await w.signer(1n);
  const keep = w.ix.guardianRecovery({ admin: w.admin.address, guardian: third.address, keepBuybacksHalted: true });
  await w.send([w.ix.setPause({ authority: newGuardian.address, buybacks: true, launches: true })], [newGuardian], 'every flag the guardian can set');
  await w.send(keep, [w.admin], 'guardianRecovery, buybacks kept halted');
  lp = w.launchpad();
  assert.deepEqual([lp.guardian, lp.launchesPaused, lp.buysHalted, lp.buybacksHalted], [String(third.address), true, true, true]);
  await w.finish();
});

/** The checklist's snapshot from a World: every address it reads, and the programs' accounts. */
function checklistSnapshot(w, edit = (a) => a) {
  const A = checklistAddresses({ programId: w.programId, cluster: 'mainnet' });
  const keys = ['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => A[k]);
  const list = (program) => w.svm.getProgramAccounts(address(program)).map((a) => ({ address: String(a.address), owner: String(program), lamports: BigInt(a.lamports), data: Buffer.from(a.data) }));
  return { accounts: edit(Object.fromEntries(keys.map((k) => [k, w.accountInfo(k)]))), legacyAccounts: list(S.CLUSTERS.mainnet.legacyProgram), curveAccounts: list(w.programId) };
}
const codes = (r) => r.map((x) => x.code).sort();

test('OPS-4, OPS-1 the deploy checklist (scripts/vcurve/preflight.mjs) reads 8.4\'s preconditions from the chain; an old Approval is a problem before closing the old program, which would block its city here forever', async () => {
  const w = await World.create({ dbcProgram: true });
  const run = (o = {}) => checkDeployPreconditions({ ...checklistSnapshot(w, o.edit), vault: w.admin.address, programId: w.programId, beforeLegacyClose: o.close });
  // the World's upgrade authority is its deployer: every program's is reported until it is the vault
  assert.deepEqual(codes(run().problems), ['CURVE_UPGRADE_AUTHORITY', 'LEGACY_UPGRADE_AUTHORITY', 'REWARDS_UPGRADE_AUTHORITY']);
  for (const id of [w.programId, S.CLUSTERS.mainnet.rewardsProgram, S.CLUSTERS.mainnet.legacyProgram]) {
    const pd = S.findPda([pkb(id)], S.ADDRESSES.upgradeableLoader)[0];
    const a = w.accountInfo(pd); const d = Buffer.from(a.data); pkb(w.admin.address).copy(d, 13);
    w.setRaw(pd, d, S.ADDRESSES.upgradeableLoader, a.lamports);
  }
  assert.deepEqual(run(), { problems: [], warnings: [] }, 'every precondition holds');
  // the old program's config enabled, its launches open, an old approval outstanding
  await w.legacyEnable(true);
  assert.deepEqual(codes(run().problems), ['LEGACY_CONFIG_ENABLED']);
  await w.legacyPause(false);
  await w.legacyApprove({ cityId: 7001n, founder: await w.signer(1n), symbol: 'OLDX' });
  assert.deepEqual(codes(run().problems), ['LEGACY_CONFIG_ENABLED', 'LEGACY_LAUNCHES_OPEN']);
  await w.legacyPause(true);
  await w.legacyEnable(false);
  let r = run();
  assert.deepEqual([codes(r.problems), codes(r.warnings)], [[], ['LEGACY_APPROVAL']], 'an outstanding old approval: a warning');
  r = run({ close: true });
  assert.deepEqual(codes(r.problems), ['LEGACY_APPROVAL'], 'before closing the old program: a problem');
  assert.match(r.problems[0].message, /revoke_approval/);
  const newFounder = await w.signer(1n);
  await expectFail(() => w.approve({ cityId: 7001n, founder: newFounder, symbol: 'NEWX' }), 'LegacyApprovalExists');
  // the registry's admin handed elsewhere (OPS-1), a founder holding a role (doctored snapshot)
  const stranger = await w.signer(5n);
  await w.registryHandOver(stranger, { accept: false });
  assert.deepEqual(codes(run().problems), ['REWARDS_REGISTRY_ADMIN']);
  await w.send([w.rewardsIx('propose_admin', { new_admin: new PublicKey(ZERO) }, { admin: w.admin.address, registry: w.rewardsPdas().registry })], [w.admin], 'registry cancel');
  const founder = await w.signer(5n);
  await w.launchCoin({ cityId: 7010n, founder, symbol: 'ROLE' });
  const lpKey = w.P.launchpad();
  // the snapshot doctored as if set_guardian had named that founder (Launchpad.guardian at byte 136, 3.4)
  const asGuardian = (a) => { const d = Buffer.from(a[lpKey].data); pkb(founder.address).copy(d, 136); return { ...a, [lpKey]: { ...a[lpKey], data: d } }; };
  assert.ok(codes(run({ edit: asGuardian }).problems).includes('FOUNDER_HOLDS_ROLE'));
  // OPS-4's trap: the old program closed with the approval outstanding (loader Close, what `solana program close` sends)
  w.checks = false; w.probeEach = false; // the checker pins the old program's bytes (I20); closing it is the point here
  const LEG = S.CLUSTERS.mainnet.legacyProgram;
  const pd = S.findPda([pkb(LEG)], S.ADDRESSES.upgradeableLoader)[0];
  w.warpSlots(10);
  await w.send([{ programAddress: S.ADDRESSES.upgradeableLoader, accounts: [{ address: pd, role: S.Role.W }, { address: String(w.admin.address), role: S.Role.W },
    { address: String(w.admin.address), role: S.Role.WS }, { address: LEG, role: S.Role.W }], data: new Uint8Array([5, 0, 0, 0]) }], [w.admin], 'loader Close of the old program');
  w.warpSlots(10);
  assert.ok(w.accountInfo(w.P.legacyApproval(7001n)), 'the old approval survives the close');
  await expectFail(() => w.legacyRevoke(7001n));
  w.warpSecs(Number(60n * DAY));
  await expectFail(() => w.approve({ cityId: 7001n, founder, symbol: 'NEWX' }), 'LegacyApprovalExists');
  r = run();
  assert.ok(codes(r.problems).includes('LEGACY_APPROVAL') && !codes(r.problems).includes('LEGACY_UPGRADE_AUTHORITY'), 'after a close the approval is a problem in any mode');
});

// ---------------------------------------------------------------- review round 5
test('R5-CONS-1 the guardian is never the admin or the proposed admin: the program refuses it at init_launchpad, set_guardian, propose_admin and accept_admin (GuardianIsAdmin), and the checklist reports a guardian that is the admin, the vault or the proposed admin', async () => {
  const w = await World.create({ initLaunchpad: false });
  const init = (guardian) => [w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian })];
  await expectFail(() => w.send(init(w.admin.address), [w.admin, w.deployer], 'init_launchpad with guardian = admin'), 'GuardianIsAdmin');
  await w.send(init(w.guardian.address), [w.admin, w.deployer], 'init_launchpad');
  await w.addConfig(S.DEFAULT_CONFIG);
  const setG = (g, label) => w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: g })], [w.admin], label);
  await expectFail(() => setG(w.admin.address, 'set_guardian(the admin)'), 'GuardianIsAdmin');
  const next = await w.signer(5n);
  await expectFail(() => w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: w.guardian.address })], [w.admin], 'propose the guardian as admin'), 'GuardianIsAdmin');
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose another key');
  await expectFail(() => setG(next.address, 'set_guardian(the proposed admin)'), 'GuardianIsAdmin');
  // accept_admin checks again: a Launchpad whose guardian is the proposed key (doctored: the program never stores it) refuses the accept
  const lpKey = w.P.launchpad();
  const before = w.accountInfo(lpKey);
  const doctored = Buffer.from(before.data); pkb(next.address).copy(doctored, 136);
  w.setRaw(lpKey, doctored, before.owner, before.lamports);
  await expectFail(() => w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept_admin while the guardian is the proposed key'), 'GuardianIsAdmin');
  w.setRaw(lpKey, Buffer.from(before.data), before.owner, before.lamports);
  // no guardian (zero) and any other key are fine; the hand-over completes
  await setG(ZERO, 'no guardian');
  const g2 = await w.signer(1n);
  await setG(g2.address, 'another guardian');
  await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept_admin');
  w.admin = next;
  assert.deepEqual([w.launchpad().admin, w.launchpad().guardian], [String(next.address), String(g2.address)]);
  // the checklist (the guardian is read from the chain; snapshots doctored where the program would refuse)
  const run = (edit, vault = next.address) => checkDeployPreconditions({ ...checklistSnapshot(w, edit), vault, programId: w.programId });
  const asGuardian = (k) => (a) => { const d = Buffer.from(a[lpKey].data); pkb(k).copy(d, 136); return { ...a, [lpKey]: { ...a[lpKey], data: d } }; };
  assert.ok(!codes(run().problems).includes('GUARDIAN_IS_ADMIN'));
  for (const [label, edit, vault] of [['the admin', asGuardian(next.address)], ['the vault, before the admin is handed to it', undefined, g2.address]]) {
    const r = run(edit, vault);
    assert.ok(codes(r.problems).includes('GUARDIAN_IS_ADMIN'), `${label}: ${JSON.stringify(codes(r.problems))}`);
    assert.match(r.problems.find((p) => p.code === 'GUARDIAN_IS_ADMIN').message, /time lock/);
  }
  await w.finish();
});

test('R5-DIFF-2, R5-CONS-2 the checklist checks a proposed guardian or payout key against every coin\'s and pending approval\'s founder (and the other role keys) before the proposal is signed; unknown options are refused', async () => {
  const w = await World.create();
  const founder = await w.signer(5n); const pendingFounder = await w.signer(5n);
  await w.launchCoin({ cityId: 7101n, founder, symbol: 'PROPK' });
  await w.approve({ cityId: 7102n, founder: pendingFounder, symbol: 'PROPA' });
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  const run = (proposed) => checkDeployPreconditions({ ...checklistSnapshot(w), vault: w.admin.address, programId: w.programId, ...(proposed ? { proposed } : {}) });
  const base = codes(run().problems);
  const extra = (proposed) => { const r = run(proposed); return { problems: codes(r.problems).filter((c) => !base.includes(c)), warnings: codes(r.warnings) }; };
  // what the review found: before set_guardian(founder) nothing was reported, with any option passed
  assert.throws(() => checkDeployPreconditions({ ...checklistSnapshot(w), vault: w.admin.address, programId: w.programId, proposedGuardian: founder.address }), /unknown option proposedGuardian/);
  assert.throws(() => run({ guardians: founder.address }), /unknown proposed key guardians/);
  // a founder (of a coin, of a pending approval) as guardian or payout key
  for (const k of [founder.address, pendingFounder.address]) {
    assert.deepEqual(extra({ guardian: k }).problems, ['PROPOSED_KEY_IS_FOUNDER'], `guardian ${k}`);
    assert.deepEqual(extra({ payoutAuthority: k }).problems, ['PROPOSED_KEY_IS_FOUNDER'], `payout key ${k}`);
  }
  assert.match(run({ guardian: founder.address }).problems.find((p) => p.code === 'PROPOSED_KEY_IS_FOUNDER').message, /the coin of city 7101/);
  assert.match(run({ guardian: pendingFounder.address }).problems.find((p) => p.code === 'PROPOSED_KEY_IS_FOUNDER').message, /the approval of city 7102/);
  // a founder as payout wallet: a warning (the program does not keep the wallet from a seat)
  assert.deepEqual(extra({ payoutDestination: founder.address }), { problems: [], warnings: ['PROPOSED_KEY_IS_FOUNDER'] });
  // the keys the program keeps a role apart from: FEE_RECIPIENT, the admin (or the vault), the payout keys, the guardian
  assert.deepEqual(extra({ guardian: S.ADDRESSES.feeRecipient }).problems, ['PROPOSED_KEY_FEE_RECIPIENT']);
  assert.deepEqual(extra({ guardian: w.admin.address }).problems, ['PROPOSED_GUARDIAN_IS_ADMIN']);
  assert.deepEqual(extra({ guardian: payoutKey.address }).problems, ['PROPOSED_GUARDIAN_PAYOUT']);
  assert.deepEqual(extra({ payoutAuthority: w.guardian.address }).problems, ['PROPOSED_PAYOUT_IS_GUARDIAN']);
  assert.deepEqual(extra({ payoutAuthority: w.admin.address, payoutDestination: wallet.address }).problems, ['PROPOSED_PAYOUT_IS_ADMIN']);
  assert.deepEqual(extra({ payoutAuthority: wallet.address }).problems, ['PROPOSED_PAYOUT_SAME'], 'the payout key = the current payout wallet');
  assert.deepEqual(extra({ payoutAuthority: wallet.address, payoutDestination: payoutKey.address }).problems, [], 'the two swapped in one proposal');
  // a fresh key passes; removing the guardian is a warning (O9)
  const fresh = await w.signer(1n);
  assert.deepEqual(extra({ guardian: fresh.address, payoutAuthority: (await w.signer(1n)).address }), { problems: [], warnings: [] });
  assert.deepEqual(extra({ guardian: ZERO }), { problems: [], warnings: ['PROPOSED_NO_GUARDIAN'] });
  // the program still accepts set_guardian(founder) (it cannot list the coins): the check before signing is the guard
  const sim = await w.simulate([w.ix.setGuardian({ admin: w.admin.address, guardian: founder.address })], [w.admin]);
  assert.ok(sim.ok, 'set_guardian(a founder) would execute');
  // the CLI: the three options, an unknown option and a bad key refused (exit status 2)
  assert.deepEqual(parseArgs(['--rpc', 'u', '--vault', String(w.admin.address), '--proposed-guardian', String(founder.address), '--proposed-payout-key', String(fresh.address), '--proposed-payout-destination', String(wallet.address)]).proposed,
    { guardian: String(founder.address), payoutAuthority: String(fresh.address), payoutDestination: String(wallet.address) });
  assert.match(parseArgs(['--rpc', 'u', '--vault', 'v', '--proposedGuardian', 'x']).error, /unknown option --proposedGuardian/);
  assert.match(parseArgs(['--rpc', 'u', '--vault', 'v', '--proposed-guardian', 'not-a-key']).error, /not a public key/);
  assert.match(parseArgs(['--vault', 'v']).error, /required/);
  await w.finish();
});

test('R5-DIFF-3, R5-CONS-3 an immutable old program meets the checklist (a warning, not a problem), as 8.5 and O19 recommend instead of a close; its approvals stay revocable warnings', async () => {
  const w = await World.create({ dbcProgram: true });
  const run = (o = {}) => checkDeployPreconditions({ ...checklistSnapshot(w), vault: w.admin.address, programId: w.programId, beforeLegacyClose: o.close });
  for (const id of [w.programId, S.CLUSTERS.mainnet.rewardsProgram, S.CLUSTERS.mainnet.legacyProgram]) {
    const pd = S.findPda([pkb(id)], S.ADDRESSES.upgradeableLoader)[0];
    const a = w.accountInfo(pd); const d = Buffer.from(a.data); pkb(w.admin.address).copy(d, 13);
    w.setRaw(pd, d, S.ADDRESSES.upgradeableLoader, a.lamports);
  }
  assert.deepEqual(run(), { problems: [], warnings: [] });
  // the vault makes the old program immutable: the loader's SetAuthority with no new authority
  const LEG = S.CLUSTERS.mainnet.legacyProgram;
  const pd = S.findPda([pkb(LEG)], S.ADDRESSES.upgradeableLoader)[0];
  w.warpSlots(10);
  await w.send([{ programAddress: S.ADDRESSES.upgradeableLoader, accounts: [{ address: pd, role: S.Role.W }, { address: String(w.admin.address), role: S.Role.RS }], data: new Uint8Array([4, 0, 0, 0]) }], [w.admin], 'the old program made immutable');
  const after = w.accountInfo(pd);
  assert.ok(after.data.length >= 45 && after.data[12] === 0, 'the ProgramData stays, with no upgrade authority');
  assert.deepEqual(programDataState(after), { state: 'immutable' });
  for (const close of [false, true]) {
    const r = run({ close });
    assert.deepEqual([codes(r.problems), codes(r.warnings)], [[], ['LEGACY_IMMUTABLE']], `beforeLegacyClose ${close}: ready, with a warning (review R5-DIFF-3: it was LEGACY_UPGRADE_AUTHORITY for ever)`);
  }
  // an old approval: its program still runs, so it is revocable: a warning, a problem only before a close
  await w.legacyPause(false); await w.legacyEnable(true);
  await w.legacyApprove({ cityId: 7201n, founder: await w.signer(1n), symbol: 'IMMX' });
  await w.legacyPause(true); await w.legacyEnable(false);
  assert.deepEqual([codes(run().problems), codes(run().warnings)], [[], ['LEGACY_APPROVAL', 'LEGACY_IMMUTABLE']]);
  await w.legacyRevoke(7201n);
  // launches here go on
  await w.launchCoin({ cityId: 7202n, symbol: 'IMMY' });
  // the other two programs must stay upgradeable by the vault (8.4): immutable there is still reported
  const rewardsPd = S.findPda([pkb(S.CLUSTERS.mainnet.rewardsProgram)], S.ADDRESSES.upgradeableLoader)[0];
  const ra = w.accountInfo(rewardsPd); const rd = Buffer.from(ra.data); rd[12] = 0;
  const r = checkDeployPreconditions({ ...checklistSnapshot(w, (a) => ({ ...a, [rewardsPd]: { ...a[rewardsPd], data: rd } })), vault: w.admin.address, programId: w.programId });
  assert.deepEqual(codes(r.problems), ['REWARDS_UPGRADE_AUTHORITY']);
  await w.finish();
});
