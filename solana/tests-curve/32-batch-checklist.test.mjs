// The deploy checklist and the launch approver (VICINITY-CURVE-DESIGN.md 4.24, 8.4, 8.6; NOTES 76): before a
// set_launch_approver proposal is signed, `scripts/vcurve/preflight.mjs --proposed-launch-approver` checks the key
// against every coin's and pending approval's founder (the program refuses the approver as a founder only from then on
// and cannot list the coins when the key is set) and against every seat the program keeps it apart from; a proposed
// guardian or payout key is never the approver; and the checklist reports an approver that holds a founder seat.
// Review round 6 (R6-RT-2): the checklist reads the guardian's Squads multisig and refuses one whose members can change
// it (an autonomous multisig: in a 1-of-3 one stolen member key removes the others), one with a time lock, one the
// guardian is not a vault of, and an approver that is a member key of the guardian's or the vault's multisig. The
// Squads layout it reads is checked against accounts the real Squads v4 program created (fixtures/squads-v4-multisigs.json).
// Review round 8: an approver multisig (O32 (a)) with a guardian vault, the admin vault or another program address among
// its members, or a config authority other than none or the admin vault, is refused, and a threshold of 1 is a warning
// (R8-DIFF-3); an approver that is not a wallet key is not ready at all while the batch verifier cannot check a
// publication made through Squads (R8-DIFF-6).
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
  const SQ = /^(GUARDIAN_MULTISIG|GUARDIAN_NOT|GUARDIAN_TIME|GUARDIAN_THRESHOLD|GUARDIAN_TOO_FEW|APPROVER_IS|APPROVER_MULTISIG|APPROVER_NOT|APPROVER_TIME|PROPOSED_APPROVER_IS|VAULT_)/;
  const sq = (r) => ({ problems: codes(r.problems).filter((c) => SQ.test(c)), warnings: codes(r.warnings).filter((c) => SQ.test(c)) });
  // the review's case: before, nothing read the multisig and the checklist was silent; now an unnamed multisig is a problem
  assert.deepEqual(sq(run()).problems, ['GUARDIAN_MULTISIG_UNCHECKED']);
  // the autonomous 1-of-3: one stolen member key can remove the other members
  let r = run({ guardianMultisig: G });
  assert.deepEqual(sq(r).problems, ['GUARDIAN_MULTISIG_NOT_CONTROLLED']);
  assert.match(r.problems.find((p) => p.code === 'GUARDIAN_MULTISIG_NOT_CONTROLLED').message, /autonomous: any 1 of its 3 members .* one stolen member key removes the other members/);
  // a 2-of-3 autonomous multisig is still not controlled (and its stops need two members, review R7-2); a config
  // authority other than the vault neither
  putMultisig(G, { threshold: 2 });
  assert.deepEqual(sq(run({ guardianMultisig: G })).problems, ['GUARDIAN_MULTISIG_NOT_CONTROLLED', 'GUARDIAN_THRESHOLD']);
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
  // one member: since review R7-2 a problem (the loss of that one key leaves no guardian stop)
  putMultisig(G, { configAuthority: w.admin.address, members: [owner] });
  assert.deepEqual(sq(run({ guardianMultisig: G })), { problems: ['GUARDIAN_TOO_FEW_ACTORS'], warnings: [] });
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
  // a real time lock (with a threshold of 2 and one member of three able to act alone, review R7-2), and an approver
  // among the real members
  assert.deepEqual(judge(locked).problems, ['GUARDIAN_THRESHOLD', 'GUARDIAN_TIME_LOCK', 'GUARDIAN_TOO_FEW_ACTORS']);
  assert.deepEqual(judge(controlled, { approver: controlled.expected.members[2].key }).problems, ['APPROVER_IS_GUARDIAN_MEMBER']);
});

test('R7-2, R7-CONF-3 (review round 7) the guardian\'s stops must survive the loss of any one member key (threshold 1, at least two members who can each start, approve and execute alone); the launch approver is no vault of the guardian\'s or the vault\'s multisig, and an approver that is a multisig vault is checked against its own multisig', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [owner, a, b, c] = [await w.signer(1n), await w.signer(1n), await w.signer(1n), await w.signer(1n)].map((k) => String(k.address));
  const ms = (tag) => S.findPda([Buffer.from(tag)], SQUADS.programId)[0];
  const put = (addr, o) => w.setRaw(addr, encodeSquadsMultisig({ createKey: owner, members: [owner, a, b], threshold: 1, timeLock: 0, configAuthority: w.admin.address, ...o }), SQUADS.programId, 10_000_000n);
  const G = ms('r7-guardian'); const V = ms('r7-vault');
  put(G, {});
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: squadsVaultPda(G) })], [w.admin], 'set_guardian(vault 0 of G)');
  const snapshot = (extra) => {
    const A = checklistAddresses({ programId: w.programId, cluster: 'mainnet' });
    const keys = [...['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => A[k]), ...extra];
    return { accounts: Object.fromEntries(keys.map((k) => [k, w.accountInfo(k)])), legacyAccounts: [], curveAccounts: [] };
  };
  const run = (o = {}) => checkDeployPreconditions({ ...snapshot([G, o.vaultMultisig, o.approverMultisig].filter(Boolean)), vault: o.vault ?? w.admin.address, programId: w.programId, guardianMultisig: G, ...o });
  const R7 = /^(GUARDIAN_THRESHOLD|GUARDIAN_TOO_FEW|APPROVER_IS|APPROVER_MULTISIG|APPROVER_NOT|APPROVER_TIME|VAULT_NOT)/;
  const r7 = (r) => codes(r.problems).filter((x) => R7.test(x));
  const squadsProblems = (r) => codes(r.problems).filter((x) => /^(GUARDIAN_|APPROVER_|VAULT_)/.test(x));
  assert.deepEqual(squadsProblems(run()), [], 'a controlled 1-of-3 guardian whose three members hold every permission, and a wallet-key approver');

  // R7-2 case (a): members A and B may only vote, so only the owner can start or execute a stop; before round 7 the
  // checklist was silent (and the real Squads program refuses A's vault transaction, 34-guardian-stop)
  put(G, { members: [{ key: owner, permissions: 7 }, { key: a, permissions: 2 }, { key: b, permissions: 2 }] });
  let r = run();
  assert.deepEqual(r7(r), ['GUARDIAN_TOO_FEW_ACTORS']);
  assert.match(r.problems.find((p) => p.code === 'GUARDIAN_TOO_FEW_ACTORS').message, /only 1 of the guardian multisig's 3 members can start, approve and execute a stop alone/);
  // an executor without Initiate cannot start a stop either
  put(G, { members: [{ key: owner, permissions: 7 }, { key: a, permissions: 6 }, { key: b, permissions: 5 }] });
  assert.deepEqual(r7(run()), ['GUARDIAN_TOO_FEW_ACTORS']);
  // two members who can each act alone are enough (the third may vote only)
  put(G, { members: [{ key: owner, permissions: 7 }, { key: a, permissions: 7 }, { key: b, permissions: 2 }] });
  assert.deepEqual(r7(run()), []);
  // case (b): a controlled 3-of-3 (config authority the vault, no time lock, every permission): every stop needs all three
  put(G, { threshold: 3 });
  assert.deepEqual(r7(run()), ['GUARDIAN_THRESHOLD']);
  put(G, { threshold: 2 });
  assert.deepEqual(r7(run()), ['GUARDIAN_THRESHOLD']);
  put(G, {});

  // R7-CONF-3: the approver as vault 1 of the guardian's own multisig: the program accepts it (it compares exact keys only)
  const gVault1 = squadsVaultPda(G, 1);
  assert.ok((await w.simulate([w.ix.setLaunchApprover({ admin: w.admin.address, approver: gVault1 })], [w.admin])).ok, 'set_launch_approver(vault 1 of the guardian multisig) executes');
  r = run({ proposed: { launchApprover: gVault1 } });
  // (since review round 8 an approver that is not a wallet key is also APPROVER_NOT_VERIFIABLE: the batch verifier cannot check its publications, R8-DIFF-6)
  assert.deepEqual(r7(r), ['APPROVER_IS_GUARDIAN_VAULT', 'APPROVER_MULTISIG_UNCHECKED', 'APPROVER_NOT_VERIFIABLE']);
  assert.match(r.problems.find((p) => p.code === 'APPROVER_IS_GUARDIAN_VAULT').message, /is vault 1 of the guardian multisig/);
  // the same once set (the current approver), and with the guardian multisig named as the approver multisig
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: gVault1 })], [w.admin], 'set_launch_approver(vault 1 of G)');
  assert.deepEqual(r7(run({ approverMultisig: G })), ['APPROVER_IS_GUARDIAN_VAULT', 'APPROVER_MULTISIG_SHARES_MEMBER', 'APPROVER_NOT_VERIFIABLE']);
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: approver.address })], [w.admin], 'set_launch_approver(the wallet key again)');
  // a vault of the vault's multisig (any index) as the approver
  const vault = squadsVaultPda(V);
  put(V, { members: [owner, a, b], threshold: 2, timeLock: 172_800, configAuthority: ZERO });
  put(G, { configAuthority: vault });
  assert.deepEqual(r7(run({ vault, vaultMultisig: V })), []);
  assert.deepEqual(r7(run({ vault, vaultMultisig: V, proposed: { launchApprover: squadsVaultPda(V, 7) } })), ['APPROVER_IS_VAULT_MULTISIG_VAULT', 'APPROVER_MULTISIG_UNCHECKED', 'APPROVER_NOT_VERIFIABLE']);
  // O32 (a): an approver multisig of its own: its vault passes when it has no time lock and shares no member key
  const AM = ms('r7-approver'); const amVault = squadsVaultPda(AM);
  put(AM, { members: [c, (await w.signer(1n)).address].map(String), threshold: 2, configAuthority: ZERO });
  assert.deepEqual(r7(run({ vault, vaultMultisig: V, approverMultisig: AM, proposed: { launchApprover: amVault } })), ['APPROVER_NOT_VERIFIABLE'], 'its own multisig passes; only the verifier\'s coverage is missing (R8-DIFF-6)');
  assert.deepEqual(r7(run({ vault, vaultMultisig: V, proposed: { launchApprover: amVault } })), ['APPROVER_MULTISIG_UNCHECKED', 'APPROVER_NOT_VERIFIABLE'], 'a program address as approver needs its multisig named');
  put(AM, { members: [c, a], threshold: 2, configAuthority: ZERO });
  r = run({ vault, vaultMultisig: V, approverMultisig: AM, proposed: { launchApprover: amVault } });
  assert.deepEqual(r7(r), ['APPROVER_MULTISIG_SHARES_MEMBER', 'APPROVER_MULTISIG_SHARES_MEMBER', 'APPROVER_NOT_VERIFIABLE'], 'a shares a member key with the guardian multisig and the vault multisig');
  put(AM, { members: [c, String((await w.signer(1n)).address)], threshold: 2, timeLock: 600, configAuthority: ZERO });
  assert.deepEqual(r7(run({ vault, vaultMultisig: V, approverMultisig: AM, proposed: { launchApprover: amVault } })), ['APPROVER_NOT_VERIFIABLE', 'APPROVER_TIME_LOCK']);
  assert.deepEqual(r7(run({ vault, vaultMultisig: V, approverMultisig: AM, proposed: { launchApprover: squadsVaultPda(G, 2) } })).sort(), ['APPROVER_IS_GUARDIAN_VAULT', 'APPROVER_NOT_MULTISIG_VAULT', 'APPROVER_NOT_VERIFIABLE', 'APPROVER_TIME_LOCK']);
  assert.deepEqual(r7(run({ vault, vaultMultisig: V, approverMultisig: AM })), ['APPROVER_NOT_MULTISIG_VAULT', 'APPROVER_TIME_LOCK'], 'a wallet-key approver is not a vault of the multisig named');
  // the CLI option and the fetched snapshot
  assert.equal(parseArgs(['--rpc', 'u', '--vault', vault, '--guardian-multisig', G, '--approver-multisig', AM]).approverMultisig, AM);
  const shape = (k) => { const x = w.accountInfo(k); return x ? { owner: new web3.PublicKey(String(x.owner)), lamports: Number(x.lamports), data: Buffer.from(x.data), executable: false } : null; };
  const connection = { getMultipleAccountsInfo: async (ks) => ks.map((k) => shape(k.toBase58())), getProgramAccounts: async () => [] };
  const fetched = await fetchChecklistSnapshot(connection, { programId: w.programId, guardianMultisig: G, vaultMultisig: V, approverMultisig: AM });
  assert.ok(fetched.accounts[AM], 'the approver multisig is fetched');
  await w.finish();
});

test('R8-DIFF-3, R8-DIFF-6 (review round 8) an approver multisig is refused when a guardian vault, the admin vault or another program address is one of its members, or when its config authority is anyone but none or the admin vault (one guardian member key would publish alone); a threshold of 1 is a warning; and an approver that is not a wallet key is not ready while the verifier cannot check a Squads publication', async () => {
  const w = await World.create();
  await w.initBatchPath();
  const keys = []; for (let i = 0; i < 8; i++) keys.push(String((await w.signer(1n)).address));
  const [g1, g2, g3, k1, k2, k3, v1, v2] = keys;
  const ms = (tag) => S.findPda([Buffer.from(tag)], SQUADS.programId)[0];
  const V = ms('r8-vault'); const vault = squadsVaultPda(V); // the admin vault: vault 0 of the vault's multisig
  const put = (addr, o) => w.setRaw(addr, encodeSquadsMultisig({ createKey: g1, threshold: 1, timeLock: 0, configAuthority: vault, ...o }), SQUADS.programId, 10_000_000n);
  // the guardian: a controlled 1-of-3 {g1, g2, g3}, config authority the admin vault (the configuration O35 builds)
  const G = ms('r8-guardian'); put(G, { members: [g1, g2, g3] });
  const guardianVault = squadsVaultPda(G);
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: guardianVault })], [w.admin], 'set_guardian(vault 0 of G)');
  put(V, { members: [v1, v2, k3], threshold: 2, timeLock: 172_800, configAuthority: ZERO });
  const AM = ms('r8-approver'); const amVault = squadsVaultPda(AM);
  const judge = (o) => {
    put(AM, o);
    const r = checkSquadsRoles({ guardian: guardianVault, approver: amVault, vault, guardianMultisig: G, vaultMultisig: V, approverMultisig: AM, accounts: Object.fromEntries([G, V, AM].map((k) => [k, w.accountInfo(k)])) });
    return { problems: codes(r.problems), warnings: codes(r.warnings), text: r.problems.map((p) => p.message).join('\n') };
  };
  // the review's case (a): a 1-of-2 approver multisig {guardian vault, K}: before round 8 no problem; any one guardian
  // member could create, approve and execute a publication through the guardian vault
  let r = judge({ members: [guardianVault, k1] });
  assert.deepEqual([r.problems, r.warnings], [['APPROVER_MULTISIG_MEMBER_IS_ROLE', 'APPROVER_NOT_VERIFIABLE'], ['APPROVER_MULTISIG_THRESHOLD_ONE']]);
  assert.match(r.text, new RegExp(`member ${guardianVault} of the approver multisig is the guardian`));
  // case (b): a 2-of-3 of fresh keys whose config authority is guardian member g1, who can add himself and lower the threshold alone
  r = judge({ members: [k1, k2, k3].filter((k) => k !== k3).concat([String((await w.signer(1n)).address)]), threshold: 2, configAuthority: g1 });
  assert.deepEqual(r.problems, ['APPROVER_MULTISIG_CONFIG_AUTHORITY', 'APPROVER_NOT_VERIFIABLE']);
  assert.match(r.text, new RegExp(`config authority ${g1} can add members and lower its threshold alone`));
  // the guardian vault as config authority, the admin vault as a member, a vault of the guardian's or the vault's multisig as a member
  r = judge({ members: [k1, k2], threshold: 2, configAuthority: guardianVault });
  assert.deepEqual(r.problems, ['APPROVER_MULTISIG_CONFIG_AUTHORITY', 'APPROVER_NOT_VERIFIABLE']);
  assert.match(r.text, /\(the guardian\) can add members/);
  r = judge({ members: [vault, k1], threshold: 2, configAuthority: ZERO });
  assert.match(r.text, /is the admin vault/);
  r = judge({ members: [squadsVaultPda(G, 3), k1], threshold: 2, configAuthority: ZERO });
  assert.match(r.text, /is vault 3 of the guardian multisig/);
  r = judge({ members: [squadsVaultPda(V, 2), k1], threshold: 2, configAuthority: ZERO });
  assert.match(r.text, /is vault 2 of the vault's multisig/);
  // any other program address (a vault of an unrelated multisig): whoever controls it would vote
  r = judge({ members: [squadsVaultPda(ms('r8-elsewhere')), k1], threshold: 2, configAuthority: ZERO });
  assert.deepEqual(r.problems, ['APPROVER_MULTISIG_PROGRAM_MEMBER', 'APPROVER_NOT_VERIFIABLE']);
  // what O32 (a) means: wallet-key members only, a threshold of 2 or more, autonomous or controlled by the admin vault.
  // Its own checks pass; it stays not ready only because the batch verifier cannot check its publications (R8-DIFF-6)
  for (const configAuthority of [ZERO, vault]) {
    r = judge({ members: [k1, k2, String((await w.signer(1n)).address)], threshold: 2, configAuthority });
    assert.deepEqual([r.problems, r.warnings], [['APPROVER_NOT_VERIFIABLE'], []], `config authority ${configAuthority}`);
    assert.match(r.text, /the batch verifier refuses it, since it cannot check a publication made through Squads/);
  }
  // a wallet-key approver: none of this applies
  assert.deepEqual(checkSquadsRoles({ guardian: guardianVault, approver: k1, vault, guardianMultisig: G, accounts: { [G]: w.accountInfo(G) } }), { problems: [], warnings: [] });
  await w.finish();
});

test('audit pack review (23 October 2026) FEE_RECIPIENT is no member key of the vault\'s, the guardian\'s or the approver\'s multisig (8.4), and the vault\'s multisig is read before the Launchpad exists: the mainnet state of that day (an autonomous 2-of-3 vault multisig with FEE_RECIPIENT among its members and no time lock) is not ready', async () => {
  const w = await World.create();
  const FR = S.ADDRESSES.feeRecipient;
  const [m2, m3, g1, g2] = [await w.signer(1n), await w.signer(1n), await w.signer(1n), await w.signer(1n)].map((k) => String(k.address));
  const ms = (tag) => S.findPda([Buffer.from(tag)], SQUADS.programId)[0];
  const put = (addr, o) => w.setRaw(addr, encodeSquadsMultisig({ createKey: m2, threshold: 1, timeLock: 0, ...o }), SQUADS.programId, 10_000_000n);
  const A = checklistAddresses({ programId: w.programId, cluster: 'mainnet' });
  const snapshot = (extra, { noLaunchpad = false } = {}) => {
    const keys = [...['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => A[k]), ...extra];
    const accounts = Object.fromEntries(keys.map((k) => [k, w.accountInfo(k)]));
    if (noLaunchpad) accounts[A.curveLaunchpad] = null;
    return { accounts, legacyAccounts: [], curveAccounts: [] };
  };
  const run = (o = {}, s = {}) => checkDeployPreconditions({ ...snapshot([o.guardianMultisig, o.vaultMultisig, o.approverMultisig].filter(Boolean), s), programId: w.programId, ...o });
  const fr = (r) => codes(r.problems).filter((c) => c.startsWith('FEE_RECIPIENT_IS_'));
  // the vault's multisig as it stood on mainnet on 23 October 2026 (6v8hwKYS...): autonomous, 2 of 3, no time lock, and
  // FEE_RECIPIENT one of the three members; before this check the checklist printed nothing about it
  const V = ms('pack-vault'); const vault = squadsVaultPda(V);
  put(V, { members: [FR, m2, m3], threshold: 2, configAuthority: ZERO });
  let r = run({ vault, vaultMultisig: V }, { noLaunchpad: true });
  assert.ok(codes(r.problems).includes('CURVE_LAUNCHPAD'), 'no Launchpad yet');
  assert.deepEqual(fr(r), ['FEE_RECIPIENT_IS_VAULT_MEMBER']);
  assert.ok(codes(r.warnings).includes('VAULT_TIME_LOCK_UNSET'), 'the vault multisig is read before the Launchpad exists');
  assert.match(r.problems.find((p) => p.code === 'FEE_RECIPIENT_IS_VAULT_MEMBER').message, new RegExp(`${FR} .*\\(threshold 2 of 3\\): a stolen FEE_RECIPIENT key would be one of the 2 signatures needed to act as the admin and the upgrade authority`));
  // and with the Launchpad (the same rule); a vault multisig without FEE_RECIPIENT passes it
  assert.deepEqual(fr(run({ vault, vaultMultisig: V })), ['FEE_RECIPIENT_IS_VAULT_MEMBER']);
  put(V, { members: [m2, m3, g1], threshold: 2, configAuthority: ZERO });
  assert.deepEqual(fr(run({ vault, vaultMultisig: V }, { noLaunchpad: true })), []);
  // the guardian's multisig (controlled by the vault, 1 of 3): FEE_RECIPIENT as a member would act as the guardian
  const G = ms('pack-guardian'); const gVault = squadsVaultPda(G);
  put(G, { members: [FR, g1, g2], configAuthority: vault });
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: gVault })], [w.admin], 'set_guardian(vault 0 of G)');
  r = run({ vault, vaultMultisig: V, guardianMultisig: G });
  assert.deepEqual(fr(r), ['FEE_RECIPIENT_IS_GUARDIAN_MEMBER']);
  assert.match(r.problems.find((p) => p.code === 'FEE_RECIPIENT_IS_GUARDIAN_MEMBER').message, /would act as the guardian/);
  // before the Launchpad exists, a proposed guardian is checked against its multisig too
  assert.deepEqual(fr(run({ vault, vaultMultisig: V, guardianMultisig: G, proposed: { guardian: gVault } }, { noLaunchpad: true })), ['FEE_RECIPIENT_IS_GUARDIAN_MEMBER']);
  put(G, { members: [m2, g1, g2], configAuthority: vault });
  assert.deepEqual(fr(run({ vault, vaultMultisig: V, guardianMultisig: G })), []);
  // an approver multisig (O32 (a), not ready anyway while the verifier cannot check it): FEE_RECIPIENT as a member is refused too
  const AM = ms('pack-approver'); const amVault = squadsVaultPda(AM);
  put(AM, { members: [FR, g1], threshold: 2, configAuthority: ZERO });
  r = run({ vault, vaultMultisig: V, guardianMultisig: G, approverMultisig: AM, proposed: { launchApprover: amVault } });
  assert.deepEqual(fr(r), ['FEE_RECIPIENT_IS_APPROVER_MEMBER']);
  assert.ok(codes(r.problems).includes('APPROVER_NOT_VERIFIABLE'));
  // the multisigs that no role uses are not read for it: a guardian multisig named while no guardian is set or proposed
  const r0 = checkDeployPreconditions({ accounts: Object.fromEntries(['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => [A[k], null])), legacyAccounts: [], curveAccounts: [], vault, programId: w.programId, guardianMultisig: ms('nowhere') });
  assert.deepEqual(codes(r0.problems).filter((c) => /^(GUARDIAN_|FEE_RECIPIENT_IS_)/.test(c)), [], 'no guardian, no guardian multisig read (the devnet run of D01, section 7.4)');
  await w.finish();
});
