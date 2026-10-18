// The deploy checklist and the launch approver (VICINITY-CURVE-DESIGN.md 4.24, 8.4, 8.6; NOTES 76): before a
// set_launch_approver proposal is signed, `scripts/vcurve/preflight.mjs --proposed-launch-approver` checks the key
// against every coin's and pending approval's founder (the program refuses the approver as a founder only from then on
// and cannot list the coins when the key is set) and against every seat the program keeps it apart from; a proposed
// guardian or payout key is never the approver; and the checklist reports an approver that holds a founder seat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { World, S } from './helpers.mjs';
import { checkDeployPreconditions, checklistAddresses, parseArgs } from '../scripts/vcurve/preflight.mjs';

const ZERO = S.ADDRESSES.system;
function checklistSnapshot(w) {
  const A = checklistAddresses({ programId: w.programId, cluster: 'mainnet' });
  const keys = ['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => A[k]);
  const list = (program) => w.svm.getProgramAccounts(address(program)).map((a) => ({ address: String(a.address), owner: String(program), lamports: BigInt(a.lamports), data: Buffer.from(a.data) }));
  return { accounts: Object.fromEntries(keys.map((k) => [k, w.accountInfo(k)])), legacyAccounts: list(S.CLUSTERS.mainnet.legacyProgram), curveAccounts: list(w.programId) };
}
const codes = (r) => r.map((x) => x.code).sort();

test('8.4, 4.24 --proposed-launch-approver: never a founder of a coin or a pending approval, FEE_RECIPIENT, the admin, the guardian or a payout key; a proposed guardian or payout key is never the approver; an approver holding a founder seat is reported', async () => {
  const w = await World.create();
  const founder = await w.signer(5n); const pendingFounder = await w.signer(5n);
  await w.launchCoin({ cityId: 7201n, founder, symbol: 'APRK' });
  await w.approve({ cityId: 7202n, founder: pendingFounder, symbol: 'APRA' });
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  const run = (proposed) => checkDeployPreconditions({ ...checklistSnapshot(w), vault: w.admin.address, programId: w.programId, ...(proposed ? { proposed } : {}) });
  const base = codes(run().problems);
  const extra = (proposed) => { const r = run(proposed); return { problems: codes(r.problems).filter((c) => !base.includes(c)), warnings: codes(r.warnings) }; };
  // a founder (of a coin, of a pending approval) as the approver: the program cannot see it, the checklist refuses it
  for (const k of [founder.address, pendingFounder.address]) assert.deepEqual(extra({ launchApprover: k }).problems, ['PROPOSED_KEY_IS_FOUNDER'], `approver ${k}`);
  assert.match(run({ launchApprover: founder.address }).problems.find((p) => p.code === 'PROPOSED_KEY_IS_FOUNDER').message, /the coin of city 7201/);
  // every seat the program keeps it apart from
  assert.deepEqual(extra({ launchApprover: S.ADDRESSES.feeRecipient }).problems, ['PROPOSED_KEY_FEE_RECIPIENT']);
  for (const k of [w.admin.address, w.guardian.address, payoutKey.address, wallet.address]) assert.deepEqual(extra({ launchApprover: k }).problems, ['PROPOSED_APPROVER_HOLDS_ROLE'], `approver ${k}`);
  // a fresh key passes; removing the approver is a warning
  const fresh = await w.signer(5n);
  assert.deepEqual(extra({ launchApprover: fresh.address }), { problems: [], warnings: [] });
  assert.deepEqual(extra({ launchApprover: ZERO }), { problems: [], warnings: ['PROPOSED_NO_LAUNCH_APPROVER'] });
  // the program refuses the seats itself, but not a founder: set_launch_approver(founder) would execute
  await w.send([w.ix.initLaunchBatch({ admin: w.admin.address, payer: w.payer.address })], [w.admin], 'init_launch_batch');
  assert.ok(!(await w.simulate([w.ix.setLaunchApprover({ admin: w.admin.address, approver: w.guardian.address })], [w.admin])).ok, 'the guardian refused by the program');
  assert.ok((await w.simulate([w.ix.setLaunchApprover({ admin: w.admin.address, approver: founder.address })], [w.admin])).ok, 'a founder accepted by the program');
  // with the approver set: a proposed guardian or payout key that is the approver is refused (the program refuses it too)
  await w.initBatchPath({ approver: fresh });
  assert.deepEqual(extra({ guardian: fresh.address }).problems, ['PROPOSED_KEY_IS_APPROVER']);
  assert.deepEqual(extra({ payoutAuthority: fresh.address, payoutDestination: (await w.signer(1n)).address }).problems, ['PROPOSED_KEY_IS_APPROVER']);
  assert.deepEqual(extra({ payoutDestination: fresh.address }).problems, ['PROPOSED_KEY_IS_APPROVER']);
  assert.deepEqual(codes(run().problems), base, 'a fresh approver adds nothing');
  // an approver that holds a founder seat (the program would accept it, the suite's checker refuses it as I20 and I25):
  // the checklist reports it from the Launchpad's bytes, here edited in the snapshot only
  const snap = checklistSnapshot(w);
  const lpAddr = w.P.launchpad();
  const edited = Buffer.from(snap.accounts[lpAddr].data); S.toKey(founder.address).toBuffer().copy(edited, 175);
  const r = checkDeployPreconditions({ ...snap, accounts: { ...snap.accounts, [lpAddr]: { ...snap.accounts[lpAddr], data: edited } }, vault: w.admin.address, programId: w.programId });
  assert.deepEqual(codes(r.problems).filter((c) => !base.includes(c)), ['FOUNDER_HOLDS_ROLE']);
  assert.match(r.problems.find((p) => p.code === 'FOUNDER_HOLDS_ROLE').message, /the coin of city 7201 names the launch approver/);
  const edited2 = Buffer.from(snap.accounts[lpAddr].data); S.toKey(w.guardian.address).toBuffer().copy(edited2, 175);
  const r2 = checkDeployPreconditions({ ...snap, accounts: { ...snap.accounts, [lpAddr]: { ...snap.accounts[lpAddr], data: edited2 } }, vault: w.admin.address, programId: w.programId });
  assert.ok(codes(r2.problems).includes('APPROVER_HOLDS_ROLE'), 'an approver that is the guardian (impossible on chain) is reported');
  // the CLI option
  assert.deepEqual(parseArgs(['--rpc', 'u', '--vault', String(w.admin.address), '--proposed-launch-approver', String(fresh.address)]).proposed, { launchApprover: String(fresh.address) });
  assert.match(parseArgs(['--rpc', 'u', '--vault', 'v', '--proposed-launch-approver', 'not-a-key']).error, /not a public key/);
  await w.finish();
});
