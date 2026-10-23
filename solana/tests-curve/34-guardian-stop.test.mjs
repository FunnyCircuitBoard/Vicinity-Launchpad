// The guardian's stop through its Squads v4 multisig, against the real Squads v4 program (the pinned mainnet dump,
// SQDS4ep65..., immutable on mainnet) and the real vicinity_curve build, in litesvm (VICINITY-CURVE-DESIGN.md 4.4, 4.26,
// 8.1, 8.4 step 5, O35; NOTES 87, 88). Review round 7:
//   * R7-1: with a threshold of 1 any member can cancel an approved proposal (proposal_cancel_v2). A thief holding the
//     approver key and one member key cancels the clear and the pause the other members approve in one transaction and
//     execute in another; their executes fail (InvalidProposalStatus) and his batch takes force. The member's stop of
//     scripts/vcurve/guardian-stop.mjs creates, proposes, approves and executes in one transaction, so nothing waits to
//     be cancelled; a race for the multisig's transaction index is met by the tool's variants for the next indices.
//   * R7-2: members who may only vote cannot start a stop: the real program refuses their vault transaction, and the
//     deploy checklist now refuses such a guardian multisig.
// The guardian multisig is written as the Squads program writes one (encodeSquadsMultisig; its address the PDA of its
// create key with that bump, its members sorted as Squads sorts them), controlled by the admin, 1 of 3, no time lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { address } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, SOL, expectFail, squadsProgramPath, rpcStub } from './helpers.mjs';
import { SQUADS, encodeSquadsMultisig, decodeSquadsMultisig, squadsVaultPda, checkSquadsRoles } from '../scripts/vcurve/preflight.mjs';
import {
  guardianStopInstructions, squadsVaultCall, squadsProposalCancel, squadsMultisigPda, stopDone, stopPreconditions, parseArgs, messageHash,
} from '../scripts/vcurve/guardian-stop.mjs';

const { PublicKey } = web3;
const sorted = (keys) => [...keys].sort((x, y) => Buffer.compare(new PublicKey(String(x)).toBuffer(), new PublicKey(String(y)).toBuffer()));

/** A World whose guardian is vault 0 of a controlled 1-of-3 Squads multisig of `owner`, `a` and `b` (O35). */
async function guardianWorld() {
  const w = await World.create();
  w.svm.addProgramFromFile(address(SQUADS.programId), squadsProgramPath());
  const approver = await w.initBatchPath();
  const [owner, a, b] = [await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const createKey = String((await w.signer(0n)).address);
  const [multisig, bump] = squadsMultisigPda(createKey);
  const put = ({ permissions = {}, threshold = 1, timeLock = 0 } = {}) => {
    const prev = w.accountInfo(multisig);
    const transactionIndex = prev ? decodeSquadsMultisig(prev).transactionIndex : 0n;
    const members = sorted([owner, a, b].map((s) => String(s.address))).map((key) => ({ key, permissions: permissions[key] ?? 7 }));
    w.setRaw(multisig, encodeSquadsMultisig({ createKey, configAuthority: w.admin.address, threshold, timeLock, transactionIndex, bump, members }), SQUADS.programId);
  };
  put();
  const vault = squadsVaultPda(multisig, 0);
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: vault })], [w.admin], 'set_guardian(vault 0 of the guardian multisig)');
  const index = () => decodeSquadsMultisig(w.accountInfo(multisig)).transactionIndex;
  return { w, approver, owner, a, b, multisig, vault, put, index };
}
const state = (w) => ({ launchpad: w.launchpad(), launchBatch: w.launchBatch() });

test('R7-1 (review round 7) a thief with the approver key and one guardian member key cancels the other members\' stops when they approve in one transaction and execute in another; the stop tool\'s single transaction cannot be cancelled and halts his batch', async () => {
  const { w, approver, owner, a, b, multisig, vault, index } = await guardianWorld();
  const mallory = await w.signer(20n);
  // the configuration the checklist accepts (O35): controlled by the vault, 1 of 3, no time lock, every member able to act
  assert.deepEqual(checkSquadsRoles({ guardian: vault, approver: approver.address, vault: w.admin.address, guardianMultisig: multisig, accounts: { [multisig]: w.accountInfo(multisig) } }), { problems: [], warnings: [] });
  // the thief (the owner's stolen device: the approver key and the owner's member key) publishes a batch for his city
  const thiefBatch = await w.publishBatch([{ cityId: 8201n, founder: mallory, symbol: 'THIEF' }], { label: 'the thief\'s publication' });
  const stop = { clear: true, pauseLaunches: true };
  const inner = (vaultKey) => [w.ix.setPause({ authority: vaultKey, launches: true }), w.ix.clearLaunchBatch({ authority: vaultKey, halt: true })];

  // the two-transaction stop each paged member makes (as the Squads app does): create, propose and approve; then execute
  for (const member of [a, b]) {
    const i = index() + 1n;
    const c = squadsVaultCall({ multisig, member: member.address, transactionIndex: i, instructions: inner(vault) });
    await w.send([c.create, c.propose, c.approve], [member], `member ${i}: create, propose and approve the stop`, { feePayer: member });
    // with a threshold of 1 one member's cancel is enough: the thief cancels with the owner's member key
    await w.send([squadsProposalCancel({ multisig, member: owner.address, transactionIndex: i })], [owner], `the thief cancels proposal ${i}`, { feePayer: owner });
    await expectFail(() => w.send([c.execute], [member], `member ${i}: execute the cancelled stop`, { feePayer: member }), 'InvalidProposalStatus');
  }
  let lb = w.launchBatch();
  assert.deepEqual([lb.halted, lb.latest.cleared, w.launchpad().launchesPaused], [false, false, false], 'neither stop took effect: the thief\'s batch would take force');

  // the tool's stop: one transaction, nothing left in between to cancel
  const i = index() + 1n;
  const ixs = guardianStopInstructions({ multisig, member: a.address, transactionIndex: i, stop, programId: w.programId });
  assert.equal(ixs.length, 4);
  await w.send(ixs, [a], 'member A: the one-transaction stop (create, propose, approve, execute)', { feePayer: a });
  lb = w.launchBatch();
  assert.deepEqual([lb.halted, lb.latest.cleared, lb.previous.cleared, w.launchpad().launchesPaused], [true, true, true, true]);
  assert.ok(stopDone(state(w), stop));
  await expectFail(() => w.send([squadsProposalCancel({ multisig, member: owner.address, transactionIndex: i })], [owner], 'the thief cancels the executed stop', { feePayer: owner }), 'InvalidProposalStatus');
  // the thief's batch never lets anyone launch, and he cannot publish again until the admin sets the approver
  w.warpTo(thiefBatch.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: thiefBatch, cityId: 8201n, founder: mallory, label: 'the thief\'s founder at valid_from' }), 'LaunchesPaused', 'BatchesHalted', 'BatchCleared');
  await expectFail(() => w.publishBatch([{ cityId: 8202n, founder: mallory, symbol: 'THIEFB' }], { label: 'the thief publishes again' }), 'BatchesHalted');
  await w.finish();
});

test('R7-1, R7-2 (review round 7) a race for the multisig\'s transaction index is met by the tool\'s variants for the next indices; members who may only vote cannot start a stop (the real program refuses, the checklist and the tool say so); the tool\'s command line', async () => {
  const { w, approver, owner, a, b, multisig, vault, put, index } = await guardianWorld();
  const mallory = await w.signer(20n);
  await w.publishBatch([{ cityId: 8301n, founder: mallory, symbol: 'RACE' }], { label: 'the thief\'s publication' });
  const stop = { clear: true };

  // R7-2 case (a): A and B may only vote. The checklist was silent before round 7; Squads refuses A's vault transaction.
  put({ permissions: { [String(a.address)]: 2, [String(b.address)]: 2 } });
  const accounts = { [multisig]: w.accountInfo(multisig) };
  assert.deepEqual(checkSquadsRoles({ guardian: vault, approver: approver.address, vault: w.admin.address, guardianMultisig: multisig, accounts }).problems.map((p) => p.code), ['GUARDIAN_TOO_FEW_ACTORS']);
  assert.match(stopPreconditions({ multisig, multisigAccount: w.accountInfo(multisig), member: a.address, launchpad: w.launchpad() }).join('\n'), /lacks a permission/);
  await expectFail(() => w.send(guardianStopInstructions({ multisig, member: a.address, transactionIndex: index() + 1n, stop, programId: w.programId }), [a], 'a vote-only member\'s stop', { feePayer: a }), 'Unauthorized');
  put({ threshold: 2 });
  assert.match(stopPreconditions({ multisig, multisigAccount: w.accountInfo(multisig), member: a.address, launchpad: w.launchpad() }).join('\n'), /threshold is 2/);
  put();
  assert.deepEqual(stopPreconditions({ multisig, multisigAccount: w.accountInfo(multisig), member: a.address, launchpad: w.launchpad() }), []);

  // the race: A prepares variants for the next three indices; the thief's own vault transaction lands first and takes the
  // next index, so A's first variant fails; the second one is at the right index and executes
  const n = index();
  const variants = [1n, 2n, 3n].map((d) => guardianStopInstructions({ multisig, member: a.address, transactionIndex: n + d, stop, programId: w.programId }));
  const junk = squadsVaultCall({ multisig, member: owner.address, transactionIndex: n + 1n, instructions: [w.ix.clearLaunchBatch({ authority: vault, halt: false })] });
  await w.send([junk.create], [owner], 'the thief takes the next transaction index', { feePayer: owner });
  await expectFail(() => w.send(variants[0], [a], 'variant at the index the thief took', { feePayer: a }), /ConstraintSeeds|seeds constraint|already in use/);
  assert.ok(!stopDone(state(w), stop));
  await w.send(variants[1], [a], 'variant at the next index', { feePayer: a });
  assert.ok(stopDone(state(w), stop), 'the stop is on chain');
  // the variant after it is now at the next index too and executes: a repeated clear changes nothing (4.26)
  const before = w.launchBatch();
  await w.send(variants[2], [a], 'the last variant: a repeated stop', { feePayer: a });
  assert.deepEqual(w.launchBatch(), before);

  // the command line: options, and the print-only mode against a JSON-RPC stub serving this World (its unsigned
  // transaction, signed by member B, executes at the next index)
  assert.match(parseArgs(['--rpc', 'u', '--multisig', multisig, '--member', String(b.address)]).error, /name the stop/);
  assert.match(parseArgs(['--rpc', 'u', '--multisig', multisig, '--clear']).error, /--keypair .* or --member/);
  assert.deepEqual((({ clear, pauseLaunches, variants: v, rounds }) => ({ clear, pauseLaunches, v, rounds }))(parseArgs(['--rpc', 'u', '--multisig', multisig, '--member', String(b.address), '--clear', '--pause-launches'])),
    { clear: true, pauseLaunches: true, v: 4, rounds: 5 });
  assert.match(parseArgs(['--rpc', 'u', '--multisig', multisig, '--member', String(b.address), '--clear', '--variants', '0']).error, /--variants must be/);
  const rpc = await rpcStub(w);
  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(SOL, 'scripts', 'vcurve', 'guardian-stop.mjs'), '--rpc', rpc.url, '--multisig', multisig, '--member', String(b.address), '--pause-launches', '--variants', '2', '--program-id', String(w.programId)], { cwd: SOL });
      let text = ''; p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
      p.on('close', (code) => resolve({ code, text }));
    });
    assert.equal(out.code, 0, out.text);
    const blocks = [...out.text.matchAll(/^index (\d+): message hash (\S+)\n(\S+)$/gm)];
    assert.deepEqual(blocks.map((m) => BigInt(m[1])), [index() + 1n, index() + 2n]);
    const tx = web3.Transaction.from(Buffer.from(blocks[0][3], 'base64'));
    assert.equal(blocks[0][2], messageHash(tx.serializeMessage()));
    const ixs = tx.instructions.map((x) => ({ programAddress: x.programId.toBase58(), accounts: x.keys.map((k) => ({ address: k.pubkey.toBase58(), role: (k.isSigner ? 2 : 0) + (k.isWritable ? 1 : 0) })), data: new Uint8Array(x.data) }));
    await w.send(ixs, [b], 'member B signs the printed stop', { feePayer: b });
    assert.equal(w.launchpad().launchesPaused, true);
  } finally { await rpc.close(); }
  await w.finish();
});
