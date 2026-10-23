// The deploy checklist and the launch approver (VICINITY-CURVE-DESIGN.md 4.24, 8.4, 8.6; NOTES 76): before a
// set_launch_approver proposal is signed, `scripts/vcurve/preflight.mjs --proposed-launch-approver` checks the key
// against every coin's and pending approval's founder (the program refuses the approver as a founder only from then on
// and cannot list the coins when the key is set) and against every seat the program keeps it apart from; a proposed
// guardian or payout key is never the approver; and the checklist reports an approver that holds a founder seat.
// Review round 6 (R6-RT-2): the checklist reads the guardian's Squads multisig and refuses one whose members can change
// it (an autonomous multisig: in a 1-of-3 one stolen member key removes the others), one with a time lock, one the
// guardian is not a vault of, and an approver that is a member key of the guardian's or the vault's multisig. The
// Squads layout it reads is checked against accounts the real Squads v4 program created (fixtures/squads-v4-multisigs.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import {
  checkDeployPreconditions, checklistAddresses, parseArgs, encodeSquadsMultisig, decodeSquadsMultisig, squadsVaultPda, squadsVaultIndexOf,
  fetchChecklistSnapshot, checkSquadsRoles, SQUADS,
} from '../scripts/vcurve/preflight.mjs';

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

test('R6-RT-2 (review round 6) the checklist reads the guardian\'s Squads multisig: an autonomous one (any member can remove the others), one with a time lock, one the guardian is not a vault of, or one that is not a multisig is not ready; a controlled multisig whose config authority is the vault is; the approver is no member key of the guardian\'s or the vault\'s multisig', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [owner, a, b] = [await w.signer(1n), await w.signer(1n), await w.signer(1n)].map((k) => String(k.address));
  const ms = (tag) => S.findPda([Buffer.from(tag)], SQUADS.programId)[0];
  const putMultisig = (addr, o) => w.setRaw(addr, encodeSquadsMultisig({ createKey: owner, members: [owner, a, b], threshold: 1, timeLock: 0, ...o }), SQUADS.programId, 10_000_000n);
  // the guardian is the vault of a 1-of-3 autonomous multisig with no time lock, as 8.1 suggested ("1 of 3 of the same members")
  const G = ms('guardian'); const gVault = squadsVaultPda(G);
  putMultisig(G, {});
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: gVault })], [w.admin], 'set_guardian(the Squads vault)');
  assert.equal(squadsVaultIndexOf(G, gVault), 0);
  const snap = (extraKeys = []) => {
    const A = checklistAddresses({ programId: w.programId, cluster: 'mainnet' });
    const keys = [...['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => A[k]), ...extraKeys];
    const list = (program) => w.svm.getProgramAccounts(address(program)).map((x) => ({ address: String(x.address), owner: String(program), lamports: BigInt(x.lamports), data: Buffer.from(x.data) }));
    return { accounts: Object.fromEntries(keys.map((k) => [k, w.accountInfo(k)])), legacyAccounts: list(S.CLUSTERS.mainnet.legacyProgram), curveAccounts: list(w.programId) };
  };
  const run = (o = {}) => checkDeployPreconditions({ ...snap([o.guardianMultisig, o.vaultMultisig].filter(Boolean)), vault: o.vault ?? w.admin.address, programId: w.programId, ...o });
  const SQ = /^(GUARDIAN_MULTISIG|GUARDIAN_NOT|GUARDIAN_TIME|GUARDIAN_ONE|APPROVER_IS|PROPOSED_APPROVER_IS|VAULT_)/;
  const sq = (r) => ({ problems: codes(r.problems).filter((c) => SQ.test(c)), warnings: codes(r.warnings).filter((c) => SQ.test(c)) });
  // the review's case: before, nothing read the multisig and the checklist was silent; now an unnamed multisig is a problem
  assert.deepEqual(sq(run()).problems, ['GUARDIAN_MULTISIG_UNCHECKED']);
  // the autonomous 1-of-3: one stolen member key can remove the other members
  let r = run({ guardianMultisig: G });
  assert.deepEqual(sq(r).problems, ['GUARDIAN_MULTISIG_NOT_CONTROLLED']);
  assert.match(r.problems.find((p) => p.code === 'GUARDIAN_MULTISIG_NOT_CONTROLLED').message, /autonomous: any 1 of its 3 members .* one stolen member key removes the other members/);
  // a 2-of-3 autonomous multisig is still not controlled; a config authority other than the vault neither
  putMultisig(G, { threshold: 2 });
  assert.deepEqual(sq(run({ guardianMultisig: G })).problems, ['GUARDIAN_MULTISIG_NOT_CONTROLLED']);
  putMultisig(G, { configAuthority: owner });
  assert.match(run({ guardianMultisig: G }).problems.find((p) => p.code === 'GUARDIAN_MULTISIG_NOT_CONTROLLED').message, new RegExp(`config authority ${owner} can change`));
  // the fix: a controlled multisig whose config authority is the vault (the time-locked admin) and no time lock
  putMultisig(G, { configAuthority: w.admin.address });
  assert.deepEqual(sq(run({ guardianMultisig: G })), { problems: [], warnings: [] });
  assert.equal(decodeSquadsMultisig(w.accountInfo(G)).configAuthority, String(w.admin.address));
  // a time lock on the guardian multisig: its stops would wait
  putMultisig(G, { configAuthority: w.admin.address, timeLock: 3_600 });
  assert.deepEqual(sq(run({ guardianMultisig: G })).problems, ['GUARDIAN_TIME_LOCK']);
  putMultisig(G, { configAuthority: w.admin.address });
  // another multisig (the guardian is not one of its vaults), an account that is not a Squads multisig, a missing one
  const other = ms('other'); putMultisig(other, { configAuthority: w.admin.address });
  assert.deepEqual(sq(run({ guardianMultisig: other })).problems, ['GUARDIAN_NOT_MULTISIG_VAULT']);
  w.setRaw(ms('fake'), encodeSquadsMultisig({ createKey: owner, configAuthority: w.admin.address, members: [owner] }), S.ADDRESSES.system, 10_000_000n);
  assert.deepEqual(sq(run({ guardianMultisig: ms('fake') })).problems, ['GUARDIAN_MULTISIG_INVALID'], 'owned by another program');
  assert.deepEqual(sq(run({ guardianMultisig: ms('missing') })).problems, ['GUARDIAN_MULTISIG_INVALID']);
  // one member: a warning
  putMultisig(G, { configAuthority: w.admin.address, members: [owner] });
  assert.deepEqual(sq(run({ guardianMultisig: G })), { problems: [], warnings: ['GUARDIAN_ONE_MEMBER'] });
  // the approver as a member key of the guardian multisig (one stolen device: both powers)
  putMultisig(G, { configAuthority: w.admin.address, members: [owner, a, String(approver.address)] });
  assert.deepEqual(sq(run({ guardianMultisig: G })).problems, ['APPROVER_IS_GUARDIAN_MEMBER']);
  putMultisig(G, { configAuthority: w.admin.address });
  assert.deepEqual(sq(run({ guardianMultisig: G, proposed: { launchApprover: a } })).problems, ['APPROVER_IS_GUARDIAN_MEMBER'], 'a proposed approver that is a member key');
  // a proposed guardian is checked against the multisig named: its vault, or not
  const G2 = ms('guardian-2'); putMultisig(G2, { configAuthority: w.admin.address });
  assert.deepEqual(sq(run({ guardianMultisig: G2, proposed: { guardian: squadsVaultPda(G2) } })), { problems: [], warnings: [] });
  assert.deepEqual(sq(run({ guardianMultisig: G, proposed: { guardian: squadsVaultPda(G2) } })).problems, ['GUARDIAN_NOT_MULTISIG_VAULT']);
  // the vault's multisig: the vault is one of its vaults, the approver no member key; no time lock is a warning (O11)
  const V = ms('vault'); const vault = squadsVaultPda(V);
  putMultisig(V, { members: [owner, a, b], threshold: 2, timeLock: 172_800 });
  const putG = () => putMultisig(G, { configAuthority: vault });
  putG();
  assert.deepEqual(sq(run({ vault, guardianMultisig: G, vaultMultisig: V })), { problems: [], warnings: [] });
  putMultisig(V, { members: [owner, a, String(approver.address)], threshold: 2, timeLock: 0 });
  assert.deepEqual(sq(run({ vault, guardianMultisig: G, vaultMultisig: V })), { problems: ['APPROVER_IS_VAULT_MEMBER'], warnings: ['VAULT_TIME_LOCK_UNSET'] });
  assert.deepEqual(sq(run({ vault: w.admin.address, guardianMultisig: G, vaultMultisig: V })).problems.sort(), ['APPROVER_IS_VAULT_MEMBER', 'GUARDIAN_MULTISIG_NOT_CONTROLLED', 'VAULT_NOT_MULTISIG_VAULT'].sort());
  // the CLI options and the fetched snapshot (a connection stub serving the World's accounts)
  const o = parseArgs(['--rpc', 'u', '--vault', vault, '--guardian-multisig', G, '--vault-multisig', V]);
  assert.deepEqual([o.guardianMultisig, o.vaultMultisig], [G, V]);
  assert.match(parseArgs(['--rpc', 'u', '--vault', 'v', '--guardian-multisig', 'not-a-key']).error, /not a public key/);
  const shape = (k) => { const x = w.accountInfo(k); return x ? { owner: new web3.PublicKey(String(x.owner)), lamports: Number(x.lamports), data: Buffer.from(x.data), executable: false } : null; };
  const connection = { getMultipleAccountsInfo: async (ks) => ks.map((k) => shape(k.toBase58())), getProgramAccounts: async (p) => w.svm.getProgramAccounts(address(p.toBase58())).map((x) => ({ pubkey: new web3.PublicKey(String(x.address)), account: shape(String(x.address)) })) };
  const fetched = await fetchChecklistSnapshot(connection, { programId: w.programId, guardianMultisig: G, vaultMultisig: V });
  assert.ok(fetched.accounts[G] && fetched.accounts[V], 'the multisigs are fetched');
  assert.deepEqual(sq(checkDeployPreconditions({ ...fetched, vault, programId: w.programId, guardianMultisig: G, vaultMultisig: V })).problems, ['APPROVER_IS_VAULT_MEMBER']);
  await w.finish();
});

test('R6-RT-2 (review round 6) the Squads v4 Multisig layout the checklist reads: accounts created by the real Squads program decode to the values the Squads SDK reads, the encoder of the synthetic accounts writes them byte for byte, the vault PDAs are the SDK\'s, and the checklist judges them as it judges the synthetic ones', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/squads-v4-multisigs.json', import.meta.url), 'utf8'));
  assert.equal(fx.squadsProgram, SQUADS.programId);
  assert.equal(fx.multisigs.length, 3);
  const asText = (d) => ({ ...d, transactionIndex: String(d.transactionIndex), staleTransactionIndex: String(d.staleTransactionIndex) });
  const acc = (m) => ({ owner: m.owner, data: Buffer.from(m.data, 'base64') });
  for (const m of fx.multisigs) {
    const d = decodeSquadsMultisig(acc(m));
    assert.deepEqual(asText(d), m.expected, m.label);
    assert.ok(Buffer.from(encodeSquadsMultisig(d)).equals(acc(m).data), `${m.label}: the encoder writes the real account byte for byte (with the 32 bytes Squads reserves for an absent rent collector)`);
    for (const v of m.vaults) {
      assert.equal(squadsVaultPda(m.address, v.index), v.address, `${m.label}: vault ${v.index}`);
      assert.equal(squadsVaultIndexOf(m.address, v.address), v.index);
    }
    // a truncated account and another owner are refused
    assert.throws(() => decodeSquadsMultisig({ owner: m.owner, data: acc(m).data.subarray(0, 120) }), /too short/);
    assert.throws(() => decodeSquadsMultisig({ owner: ZERO, data: acc(m).data }), /not the Squads program/);
  }
  const [autonomous, controlled, locked] = fx.multisigs;
  assert.equal(autonomous.expected.configAuthority, ZERO, 'the autonomous one has no config authority');
  const judge = (m, o = {}) => {
    const accounts = { [m.address]: acc(m) };
    const r = checkSquadsRoles({ guardian: m.vaults[0].address, approver: o.approver ?? null, vault: o.vault ?? controlled.expected.configAuthority, guardianMultisig: m.address, accounts });
    return { problems: codes(r.problems), warnings: codes(r.warnings) };
  };
  // the review's case: a real autonomous 1-of-3 guardian with no time lock is not ready
  assert.deepEqual(judge(autonomous), { problems: ['GUARDIAN_MULTISIG_NOT_CONTROLLED'], warnings: [] });
  // the fix (O35): a real multisig controlled by the vault, no time lock
  assert.deepEqual(judge(controlled), { problems: [], warnings: [] });
  assert.deepEqual(judge(controlled, { vault: autonomous.expected.createKey }).problems, ['GUARDIAN_MULTISIG_NOT_CONTROLLED'], 'controlled by a key other than the vault');
  // a real time lock, and an approver among the real members
  assert.deepEqual(judge(locked).problems, ['GUARDIAN_TIME_LOCK']);
  assert.deepEqual(judge(controlled, { approver: controlled.expected.members[2].key }).problems, ['APPROVER_IS_GUARDIAN_MEMBER']);
});
