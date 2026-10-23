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
// Review round 8:
//   * R8-OPS-2: the tool read, sent and judged the stop through one RPC, so one lying RPC that served a halted
//     LaunchBatch made it report the stop and send nothing. It now needs two RPCs of different providers, sends through
//     both and reports the stop only when both show it and one of the member's transactions is confirmed.
//   * R8-DIFF-7: each transaction carries a compute-unit limit and price (outside the vault message), so the stop
//     competes for the slot with a thief who pays priority fees for the multisig's next index.
// The verification of round 8 (R8-OPS-2 residual): one RPC answering HTTP 503 ended the run before anything was sent,
// a silent one hung it, and print-only used the first RPC's blockhash alone; each RPC is now asked within a timeout,
// the stop goes through the one that answers, and print-only covers every blockhash obtained.
// Review round 9: one lying RPC's data crashed the run before anything was sent (a multisig index of u64::MAX, a
// blockhash that is not base58); each RPC's index and blockhash are checked on their own and a bad one is that RPC's
// failure (R9-TOOLS-1). Two RPCs that both answer but disagree on the stop no longer make the member re-send every
// round, and the verdict names the disagreement (R9-TOOLS-3).
// The guardian multisig is written as the Squads program writes one (encodeSquadsMultisig; its address the PDA of its
// create key with that bump, its members sorted as Squads sorts them), controlled by the admin, 1 of 3, no time lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, createKeyPairSignerFromBytes, lamports } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, SOL, expectFail, squadsProgramPath, rpcStub } from './helpers.mjs';
import { SQUADS, encodeSquadsMultisig, decodeSquadsMultisig, squadsVaultPda, checkSquadsRoles } from '../scripts/vcurve/preflight.mjs';
import {
  guardianStopInstructions, squadsVaultCall, squadsProposalCancel, squadsMultisigPda, stopDone, stopPreconditions, parseArgs, messageHash,
  STOP_COMPUTE_UNITS, DEFAULT_PRIORITY_FEE, roundPriorityFee, withTimeout, rpcLabel, summarizeViews, blockhashGroups, validBlockhash, nextIndices,
} from '../scripts/vcurve/guardian-stop.mjs';

const { PublicKey } = web3;
const sorted = (keys) => [...keys].sort((x, y) => Buffer.compare(new PublicKey(String(x)).toBuffer(), new PublicKey(String(y)).toBuffer()));

/** A World whose guardian is vault 0 of a controlled 1-of-3 Squads multisig of `owner`, `a` and `b` (O35); `b`'s secret key is `bSecret` (for the CLI's keypair file). */
async function guardianWorld() {
  const w = await World.create();
  w.svm.addProgramFromFile(address(SQUADS.programId), squadsProgramPath());
  const approver = await w.initBatchPath();
  const bKey = web3.Keypair.generate();
  const b = await createKeyPairSignerFromBytes(bKey.secretKey);
  w.svm.airdrop(b.address, lamports(20_000_000_000n));
  const [owner, a] = [await w.signer(20n), await w.signer(20n)];
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
  return { w, approver, owner, a, b, bSecret: bKey.secretKey, multisig, vault, put, index };
}
const state = (w) => ({ launchpad: w.launchpad(), launchBatch: w.launchBatch() });
/** The real stop tool; returns `{ code, text }`. */
const runStop = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(SOL, 'scripts', 'vcurve', 'guardian-stop.mjs'), ...args], { cwd: SOL });
  let text = ''; p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
  p.on('close', (code) => resolve({ code, text }));
});

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

  // the command line: options, and the print-only mode against two JSON-RPC stubs serving this World (its unsigned
  // transaction, signed by member B exactly as printed, executes at the next index)
  const two = ['--rpc', 'https://a.example', '--rpc', 'https://b.example'];
  assert.match(parseArgs([...two, '--multisig', multisig, '--member', String(b.address)]).error, /name the stop/);
  assert.match(parseArgs([...two, '--multisig', multisig, '--clear']).error, /--keypair .* or --member/);
  assert.deepEqual((({ clear, pauseLaunches, variants: v, rounds, priorityFee }) => ({ clear, pauseLaunches, v, rounds, priorityFee }))(parseArgs([...two, '--multisig', multisig, '--member', String(b.address), '--clear', '--pause-launches'])),
    { clear: true, pauseLaunches: true, v: 4, rounds: 5, priorityFee: DEFAULT_PRIORITY_FEE });
  assert.match(parseArgs([...two, '--multisig', multisig, '--member', String(b.address), '--clear', '--variants', '0']).error, /--variants must be/);
  const rpc = await rpcStub(w); const rpc2 = await rpcStub(w, { host: '127.0.0.2' });
  try {
    const out = await runStop(['--rpc', rpc.url, '--rpc', rpc2.url, '--multisig', multisig, '--member', String(b.address), '--pause-launches', '--variants', '2', '--program-id', String(w.programId)]);
    assert.equal(out.code, 0, out.text);
    const blocks = [...out.text.matchAll(/^index (\d+): message hash (\S+)\n(\S+)$/gm)];
    assert.deepEqual(blocks.map((m) => BigInt(m[1])), [index() + 1n, index() + 2n]);
    const tx = web3.Transaction.from(Buffer.from(blocks[0][3], 'base64'));
    assert.equal(blocks[0][2], messageHash(tx.serializeMessage()));
    await w.sendWire(Buffer.from(blocks[0][3], 'base64'), 'member B signs the printed stop', { signers: [b] });
    assert.equal(w.launchpad().launchesPaused, true);
  } finally { await rpc.close(); await rpc2.close(); }
  await w.finish();
});


test('R8-OPS-2, R8-DIFF-7 (review round 8) one lying RPC that serves a halted LaunchBatch made the stop tool report the stop and send nothing; it now needs two RPCs of different providers, sends through both and reports the stop only when both show it and one of the member\'s transactions is confirmed; each transaction carries a compute-unit limit and price', async () => {
  const { w, b, bSecret, multisig } = await guardianWorld();
  const mallory = await w.signer(20n);
  await w.publishBatch([{ cityId: 8401n, founder: mallory, symbol: 'LIAR' }], { label: 'the thief\'s publication' });
  const dir = mkdtempSync(join(tmpdir(), 'vcurve-r8-stop-'));
  const keyFile = join(dir, 'member.json');
  writeFileSync(keyFile, JSON.stringify([...bSecret]), { mode: 0o600 });
  // the liar: LaunchBatch served halted with both records cleared, and every transaction dropped (answered, never sent)
  const lbAddr = String(w.P.launchBatch());
  const liar = await rpcStub(w, {
    host: '127.0.0.2',
    lie: (addr, a) => { if (addr !== lbAddr || !a) return a; const d = Buffer.from(a.data); d[9] = 1; d[10 + 108] = 1; d[119 + 108] = 1; return { ...a, data: d }; },
    rpc: (m) => (m.method === 'sendTransaction' ? { drop: true } : undefined),
  });
  const honest = await rpcStub(w);
  const base = ['--multisig', multisig, '--keypair', keyFile, '--clear', '--rounds', '1', '--program-id', String(w.programId)];
  try {
    // the review's case: the liar alone. Before round 8 the tool printed "the chain shows the stop", exited 0 and sent nothing
    let out = await runStop(['--rpc', liar.url, ...base]);
    assert.equal(out.code, 2, out.text);
    assert.match(out.text, /--rpc twice, two different providers/);
    assert.deepEqual(liar.calls, [], 'nothing was read through one RPC');
    // two URLs of one provider are one provider
    out = await runStop(['--rpc', honest.url, '--rpc', honest.url.replace(/\/?$/, '/'), ...base]);
    assert.equal(out.code, 2, out.text);
    assert.match(out.text, /two different providers/);
    assert.equal(w.launchBatch().halted, false, 'the real LaunchBatch is not halted');
    // the honest RPC and the liar: the views disagree, the stop goes through the honest RPC, and it counts only when both
    // show it and the member's transaction is confirmed
    out = await runStop(['--rpc', honest.url, '--rpc', liar.url, ...base]);
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /warning RPC_DISAGREE/);
    assert.match(out.text, /the stop is on chain: both RPCs show it, and this member's transaction \S+ is confirmed/);
    assert.ok(honest.calls.includes('sendTransaction') && liar.calls.includes('sendTransaction'), 'sent through both');
    const lb = w.launchBatch();
    assert.deepEqual([lb.halted, lb.latest.cleared, lb.previous.cleared], [true, true, true], 'the real chain shows the stop');
    // both RPCs now show it: nothing more is sent
    const before = w.history.length;
    out = await runStop(['--rpc', honest.url, '--rpc', liar.url, ...base]);
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /both RPCs show the stop already/);
    assert.equal(w.history.length, before);
  } finally {
    await liar.close(); await honest.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // R8-DIFF-7: every variant carries SetComputeUnitLimit and SetComputeUnitPrice before the four Squads instructions;
  // the price doubles each round; the printed stop executes within its own limit
  const w2 = await guardianWorld();
  await w2.w.publishBatch([{ cityId: 8402n, founder: await w2.w.signer(20n), symbol: 'PRIO' }], { label: 'the thief\'s publication' });
  const r1 = await rpcStub(w2.w); const r2 = await rpcStub(w2.w, { host: '127.0.0.2' });
  try {
    const out = await runStop(['--rpc', r1.url, '--rpc', r2.url, '--multisig', w2.multisig, '--member', String(w2.b.address), '--clear', '--pause-launches', '--halt-buys', '--variants', '2', '--priority-fee', '250000', '--program-id', String(w2.w.programId)]);
    assert.equal(out.code, 0, out.text);
    const blocks = [...out.text.matchAll(/^index (\d+): message hash (\S+)\n(\S+)$/gm)];
    assert.equal(blocks.length, 2);
    for (const m of blocks) {
      const tx = web3.Transaction.from(Buffer.from(m[3], 'base64'));
      const programs = tx.instructions.map((x) => x.programId.toBase58());
      assert.deepEqual(programs, ['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', ...Array(4).fill(SQUADS.programId)]);
      assert.deepEqual([tx.instructions[0].data[0], tx.instructions[0].data.readUInt32LE(1)], [2, STOP_COMPUTE_UNITS]);
      assert.deepEqual([tx.instructions[1].data[0], tx.instructions[1].data.readBigUInt64LE(1)], [3, 250_000n]);
    }
    assert.match(out.text, /compute-unit limit of 150000 at 250000 micro-lamports per unit/);
    assert.deepEqual([1, 2, 3, 12].map((r) => roundPriorityFee(1_000_000, r)), [1_000_000, 2_000_000, 4_000_000, 50_000_000]);
    const res = await w2.w.sendWire(Buffer.from(blocks[0][3], 'base64'), 'member B signs the printed stop (pause, halt buys, clear)', { signers: [w2.b] });
    assert.ok(res.cu < STOP_COMPUTE_UNITS, `the stop used ${res.cu} compute units`);
    const lp = w2.w.launchpad();
    assert.deepEqual([lp.launchesPaused, lp.buysHalted, w2.w.launchBatch().halted], [true, true, true]);
  } finally { await r1.close(); await r2.close(); }
  await w.finish();
});

test('R8-OPS-2 residual (verification of round 8) one bad RPC no longer blocks a guardian stop: an RPC answering HTTP 503 ended the run before anything was sent, a silent one hung it, and print-only built its variants on the first RPC\'s blockhash alone; now each RPC is asked within a timeout, the stop goes through the one that answers, every RPC\'s state is reported, and one RPC alone is never reported as proof', async () => {
  const { w, b, bSecret, multisig, index } = await guardianWorld();
  const mallory = await w.signer(20n);
  await w.publishBatch([{ cityId: 8501n, founder: mallory, symbol: 'BADRPC' }], { label: 'the thief\'s publication' });
  const dir = mkdtempSync(join(tmpdir(), 'vcurve-r8-stop-rpc-'));
  const keyFile = join(dir, 'member.json');
  writeFileSync(keyFile, JSON.stringify([...bSecret]), { mode: 0o600 });
  const halted = () => { const lb = w.launchBatch(); return [lb.halted, lb.latest.cleared]; };
  // a failing provider (every request answered 503), a silent one (never answers), and one whose blockhash is invented
  const failing = await rpcStub(w, { host: '127.0.0.2', status: () => 503 });
  const silent = await rpcStub(w, { host: '127.0.0.3', status: () => 'silent' });
  const fakeHash = web3.Keypair.generate().publicKey.toBase58();
  const inventor = await rpcStub(w, { host: '127.0.0.4', rpc: (m) => (m.method === 'getLatestBlockhash' ? { context: { slot: 1 }, value: { blockhash: fakeHash, lastValidBlockHeight: 10 ** 9 } } : undefined) });
  const honest = await rpcStub(w);
  const signed = ['--multisig', multisig, '--keypair', keyFile, '--clear', '--rounds', '1', '--timeout', '1', '--program-id', String(w.programId)];
  const host = (r) => r.url.replace('http://', '').replace(/[.]/g, '\\.');
  try {
    // print only, through the failing RPC (named first) and the honest one: before, the 503 ended the run with nothing printed
    let out = await runStop(['--rpc', failing.url, '--rpc', honest.url, '--multisig', multisig, '--member', String(b.address), '--clear', '--variants', '2', '--timeout', '1', '--program-id', String(w.programId)]);
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, new RegExp(`RPC 1 \\(${host(failing)}\\): failed: .*503`));
    assert.match(out.text, new RegExp(`RPC 2 \\(${host(honest)}\\): answered \\(multisig transaction index ${index()}; does not show the stop\\)`));
    assert.deepEqual([...out.text.matchAll(/^index (\d+): message hash/gm)].map((m) => BigInt(m[1])), [index() + 1n, index() + 2n]);
    assert.doesNotMatch(out.text, /api-key|\?/, 'an RPC is named by its host only');

    // print only, the RPC that invents its blockhash named first: before, every variant was built on its blockhash and
    // none could land; now each blockhash gets its variants, and the honest one's executes when signed as printed
    out = await runStop(['--rpc', inventor.url, '--rpc', honest.url, '--multisig', multisig, '--member', String(b.address), '--clear', '--variants', '2', '--timeout', '1', '--program-id', String(w.programId)]);
    assert.equal(out.code, 0, out.text);
    const groups = [...out.text.matchAll(/^blockhash (\S+) \(from ([^)]*\)[^:]*)\):$/gm)].map((m) => m[1]);
    assert.deepEqual(new Set(groups), new Set([fakeHash, String(w.svm.latestBlockhash())]));
    const blocks = [...out.text.matchAll(/^index (\d+): message hash (\S+)\n(\S+)$/gm)];
    assert.equal(blocks.length, 4);
    const onHonest = blocks.filter((m) => web3.Transaction.from(Buffer.from(m[3], 'base64')).recentBlockhash === String(w.svm.latestBlockhash()));
    assert.deepEqual(onHonest.map((m) => BigInt(m[1])), [index() + 1n, index() + 2n]);

    // signed, the failing RPC first: before, the 503 ended the run before anything was sent (exit 1, nothing on chain).
    // Now the stop goes through the honest RPC, is on chain, and the tool says one RPC is no proof (exit 1)
    assert.deepEqual(halted(), [false, false]);
    out = await runStop(['--rpc', failing.url, '--rpc', honest.url, ...signed]);
    assert.equal(out.code, 1, out.text);
    assert.match(out.text, /warning RPC_FAILED: RPC 1 .* failed or did not answer: the stop goes ahead through the RPC that answers/);
    assert.match(out.text, /round 1: sent \d+ variant\(s\) .*RPC 1 \(\S+\) accepted 0 of \d+ \(.*503.*\); RPC 2 \(\S+\) accepted (\d+) of \1/);
    assert.match(out.text, new RegExp(`PROBLEM RPC_FAILED: RPC 2 \\(${host(honest)}\\) shows the stop and this member's transaction \\S+ confirmed, and RPC 1 \\(${host(failing)}\\) failed or did not answer: one RPC is no proof`));
    assert.ok(stopDone(state(w), { clear: true }), 'the stop is on chain');
    assert.ok(honest.calls.includes('sendTransaction'));
    assert.ok(failing.calls.includes('sendTransaction:503'), 'it was sent through the failing RPC too');

    // signed, a silent RPC first, after the admin lifts the halt and a new thief's batch: before, the tool hung with no
    // output (web3.js has no timeout); now it reports the silent RPC after the timeout, the stop lands through the
    // honest one, and the run ends within seconds
    await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: w.approver.address })], [w.admin], 'the admin lifts the halt (set_launch_approver)');
    await w.publishBatch([{ cityId: 8502n, founder: mallory, symbol: 'SILENT' }], { label: 'the thief\'s next publication' });
    assert.deepEqual(halted(), [false, false]);
    const t0 = Date.now();
    out = await runStop(['--rpc', silent.url, '--rpc', honest.url, ...signed]);
    assert.ok(Date.now() - t0 < 20_000, `the run took ${Date.now() - t0} ms`);
    assert.equal(out.code, 1, out.text);
    assert.match(out.text, new RegExp(`RPC 1 \\(${host(silent)}\\): failed: no answer within 1 s`));
    assert.match(out.text, /PROBLEM RPC_FAILED: RPC 2 .* shows the stop and this member's transaction \S+ confirmed, and RPC 1 .* failed or did not answer/);
    assert.ok(stopDone(state(w), { clear: true }), 'the stop is on chain');

    // both RPCs failing: nothing can be built, said at once
    out = await runStop(['--rpc', silent.url, '--rpc', failing.url, ...signed]);
    assert.equal(out.code, 1, out.text);
    assert.match(out.text, /PROBLEM: neither RPC answered: nothing can be built/);
  } finally {
    await failing.close(); await silent.close(); await inventor.close(); await honest.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // the pieces: the timeout, the RPC's name, the summary of the views (proof needs every RPC), the blockhash groups
  await assert.rejects(withTimeout(new Promise(() => {}), 50), /no answer within 0\.05 s/);
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  assert.equal(rpcLabel('https://mainnet.helius-rpc.com/?api-key=SECRET', 0), 'RPC 1 (mainnet.helius-rpc.com)');
  assert.equal(rpcLabel('https://x.example:8899/v1/SECRET', 1), 'RPC 2 (x.example:8899)');
  const lpv = w.launchpad(); const lbv = w.launchBatch();
  const ok = { ok: true, raw: [null, null, null], launchpad: lpv, launchBatch: lbv };
  const sum = summarizeViews([ok, { ok: false, error: 'HTTP 503' }], { clear: true });
  assert.deepEqual([sum.all, sum.shown, sum.failed, sum.answered.length], [false, true, [1], 1]);
  assert.deepEqual((({ all, shown }) => ({ all, shown }))(summarizeViews([ok, ok], { clear: true })), { all: true, shown: true });
  assert.equal(summarizeViews([{ ok: false, error: 'x' }, { ok: false, error: 'y' }], { clear: true }).shown, false);
  assert.deepEqual([...blockhashGroups(['h1', { error: 'x' }, 'h1', 'h2']).entries()], [['h1', [0, 2]], ['h2', [3]]]);
  await w.finish();
});

test('R9-TOOLS-1 (review round 9) one lying RPC crashed the stop before anything was sent: a multisig transaction index of u64::MAX overflowed the variants\' PDAs, and a blockhash that is not base58 threw inside the shared sends; each RPC\'s index and blockhash are now checked on their own, a bad one is that RPC\'s failure, and the honest RPC\'s variants are printed and sent wherever the liar is named', async () => {
  const { w, b, bSecret, multisig, index } = await guardianWorld();
  const mallory = await w.signer(20n);
  await w.publishBatch([{ cityId: 8601n, founder: mallory, symbol: 'IDXLIE' }], { label: 'the thief\'s publication' });
  const dir = mkdtempSync(join(tmpdir(), 'vcurve-r9-stop-'));
  const keyFile = join(dir, 'member.json');
  writeFileSync(keyFile, JSON.stringify([...bSecret]), { mode: 0o600 });
  // the index liar: the real multisig account with transaction_index (offset 78) set to u64::MAX
  const indexLiar = await rpcStub(w, {
    host: '127.0.0.2',
    lie: (addr, a) => { if (addr !== String(multisig) || !a) return a; const d = Buffer.from(a.data); d.writeBigUInt64LE(2n ** 64n - 1n, 78); return { ...a, data: d }; },
  });
  // the blockhash liar: getLatestBlockhash answers a string that is not base58
  const hashLiar = await rpcStub(w, { host: '127.0.0.3', rpc: (m) => (m.method === 'getLatestBlockhash' ? { context: { slot: 1 }, value: { blockhash: '0OIl', lastValidBlockHeight: 10 ** 9 } } : undefined) });
  const honest = await rpcStub(w);
  const printOnly = ['--multisig', multisig, '--member', String(b.address), '--clear', '--variants', '2', '--timeout', '2', '--program-id', String(w.programId)];
  const signed = ['--multisig', multisig, '--keypair', keyFile, '--clear', '--rounds', '1', '--timeout', '2', '--program-id', String(w.programId)];
  const printed = (out) => [...out.text.matchAll(/^index (\d+): message hash (\S+)\n(\S+)$/gm)];
  const halted = () => { const lb = w.launchBatch(); return lb.halted && lb.latest.cleared; };
  let city = 8610n;
  const rearm = async () => {
    // the admin lifts the halt (set_launch_approver) and the thief publishes again
    await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: w.approver.address })], [w.admin], 'the admin lifts the halt (set_launch_approver)');
    await w.publishBatch([{ cityId: city, founder: mallory, symbol: `RE${city}` }], { label: `the thief's publication ${city}` });
    city += 1n;
    assert.equal(halted(), false);
  };
  try {
    for (const [liar, what] of [[indexLiar, 'index'], [hashLiar, 'blockhash']]) {
      for (const liarFirst of [true, false]) {
        const rpcs = liarFirst ? ['--rpc', liar.url, '--rpc', honest.url] : ['--rpc', honest.url, '--rpc', liar.url];
        const liarName = liarFirst ? 'RPC 1' : 'RPC 2';
        const at = `${what} liar ${liarFirst ? 'first' : 'second'}`;
        // print only: before round 9, exit 1 with a RangeError or "Non-base58 character" (the honest group printed only
        // when the blockhash liar was named second)
        let out = await runStop([...rpcs, ...printOnly]);
        assert.equal(out.code, 0, `${at}, print only: ${out.text}`);
        assert.doesNotMatch(out.text, /out of range|Non-base58|RangeError/, at);
        const blocks = printed(out);
        const onHonest = blocks.filter((m) => web3.Transaction.from(Buffer.from(m[3], 'base64')).recentBlockhash === String(w.svm.latestBlockhash()));
        assert.deepEqual(onHonest.map((m) => BigInt(m[1])), [index() + 1n, index() + 2n], `${at}: the honest RPC's variants are printed`);
        if (what === 'index') {
          assert.match(out.text, new RegExp(`warning RPC_BAD_INDEX: ${liarName} \\(\\S+\\) shows the multisig at transaction index 18446744073709551615`), at);
          assert.equal(blocks.length, 2, `${at}: no variant for the liar's index`);
        } else {
          assert.match(out.text, new RegExp(`${liarName} \\(\\S+\\): no blockhash: not a blockhash \\(32 bytes in base58\\)`), at);
        }
        // signed: before round 9, exit 1 with nothing sent and the batch not halted (blockhash liar named first; index
        // liar either way). Now the stop lands through the honest RPC, both RPCs show it, exit 0
        const sendsBefore = honest.calls.filter((c) => c === 'sendTransaction').length;
        out = await runStop([...rpcs, ...signed]);
        assert.equal(out.code, 0, `${at}, signed: ${out.text}`);
        assert.match(out.text, /the stop is on chain: both RPCs show it, and this member's transaction \S+ is confirmed/, at);
        assert.ok(honest.calls.filter((c) => c === 'sendTransaction').length > sendsBefore, `${at}: sent through the honest RPC`);
        if (what === 'blockhash') assert.match(out.text, new RegExp(`round 1: ${liarName} \\(\\S+\\) gave no blockhash: not a blockhash \\(32 bytes in base58\\)`), at);
        assert.ok(halted(), `${at}: the real LaunchBatch is halted`);
        await rearm();
      }
    }
  } finally {
    await indexLiar.close(); await hashLiar.close(); await honest.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // the pieces: a blockhash is 32 bytes in base58, written canonically; the indices come from each RPC's view on its own,
  // at most --variants per RPC, and a view with no room below 2^64 (or no multisig) is set aside, never thrown on
  assert.equal(validBlockhash(String(w.svm.latestBlockhash())), true);
  for (const bad of ['0OIl', '', 42, null, undefined, '1'.repeat(44), `${String(w.svm.latestBlockhash())}1`, { blockhash: 'x' }]) assert.equal(validBlockhash(bad), false, String(bad));
  const msAt = (n) => ({ multisigAccount: { owner: SQUADS.programId, data: encodeSquadsMultisig({ createKey: String(b.address), transactionIndex: n, members: [{ key: String(b.address), permissions: 7 }] }) } });
  assert.deepEqual(nextIndices([msAt(5n), msAt(9n)], 2), { indices: [6n, 7n, 10n, 11n], ignored: [] });
  const r = nextIndices([msAt(5n), msAt(2n ** 64n - 2n), null, { multisigAccount: null }], 2);
  assert.deepEqual(r.indices, [6n, 7n]);
  assert.deepEqual(r.ignored.map((x) => x.i), [1, 3]);
  assert.match(r.ignored[0].why, /transaction index 18446744073709551614, which leaves no room for 2 more below 2\^64/);
  assert.deepEqual(nextIndices([msAt(2n ** 64n - 3n)], 2).indices, [2n ** 64n - 2n, 2n ** 64n - 1n], 'the last two indices a u64 holds');
  await w.finish();
});

test('R9-TOOLS-3 (review round 9) when both RPCs answer but disagree on the stop, the tool re-sent every round and then said "not on chain (as both RPCs show it)"; it now stops sending once the stop shows on one RPC with the member\'s transaction confirmed on both, and reports RPC_DISAGREE; a liar alone that shows the stop and confirms every transaction never ends the rounds', async () => {
  const { w, bSecret, multisig, index } = await guardianWorld();
  const mallory = await w.signer(20n);
  await w.publishBatch([{ cityId: 8701n, founder: mallory, symbol: 'STALE' }], { label: 'the thief\'s publication' });
  const dir = mkdtempSync(join(tmpdir(), 'vcurve-r9-stop-disagree-'));
  const keyFile = join(dir, 'member.json');
  writeFileSync(keyFile, JSON.stringify([...bSecret]), { mode: 0o600 });
  const lbAddr = String(w.P.launchBatch());
  // the review's case: the liar serves LaunchBatch as it stood before the stop (unhalted); everything else is real
  const staleLb = w.accountInfo(lbAddr);
  const stale = await rpcStub(w, { host: '127.0.0.2', lie: (addr, a) => (addr === lbAddr ? staleLb : a) });
  const honest = await rpcStub(w);
  const signed = ['--multisig', multisig, '--keypair', keyFile, '--clear', '--rounds', '2', '--timeout', '2', '--program-id', String(w.programId)];
  try {
    const n = index();
    const out = await runStop(['--rpc', honest.url, '--rpc', stale.url, ...signed]);
    // before round 9: round 2 sent again at a doubled price (a second vault transaction executed), exit 1 with
    // "the stop is not on chain after every round (as both RPCs show it)"
    assert.equal(out.code, 1, out.text);
    assert.doesNotMatch(out.text, /^round 2:/m, 'no second round');
    assert.doesNotMatch(out.text, /as both RPCs show it/);
    assert.match(out.text, /RPC 1 \(\S+\): answered \(multisig transaction index \d+; shows the stop\)/);
    assert.match(out.text, /RPC 2 \(\S+\): answered \(multisig transaction index \d+; does not show the stop\)/);
    assert.match(out.text, /PROBLEM RPC_DISAGREE: RPC 1 \(\S+\) shows the stop and RPC 2 \(\S+\) does not; this member's transaction \S+ is confirmed on both RPCs: one of them is lying or behind; check LaunchBatch \(halted, both records cleared\) through a third provider/);
    assert.equal(index(), n + 1n, 'one stop executed');
    assert.ok(w.launchBatch().halted, 'the stop is on chain');
  } finally {
    await stale.close(); await honest.close();
  }

  // the safety half: a liar that shows the stop (a halted LaunchBatch) and calls every signature confirmed, while the
  // honest RPC drops round 1's sends. One RPC's word ends nothing: round 2 sends again and the stop lands
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: w.approver.address })], [w.admin], 'the admin lifts the halt (set_launch_approver)');
  await w.publishBatch([{ cityId: 8702n, founder: mallory, symbol: 'STALE2' }], { label: 'the thief\'s next publication' });
  const liar = await rpcStub(w, {
    host: '127.0.0.2',
    lie: (addr, a) => { if (addr !== lbAddr || !a) return a; const d = Buffer.from(a.data); d[9] = 1; d[10 + 108] = 1; d[119 + 108] = 1; return { ...a, data: d }; },
    rpc: (m) => (m.method === 'sendTransaction' ? { drop: true }
      : m.method === 'getSignatureStatuses' ? { context: { slot: 1 }, value: m.params[0].map(() => ({ slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' })) } : undefined),
  });
  // the honest RPC drops round 1's two sends (two variants on one blockhash)
  let dropped = 0;
  const dropping = await rpcStub(w, { rpc: (m) => (m.method === 'sendTransaction' && dropped++ < 2 ? { drop: true } : undefined) });
  try {
    const out = await runStop(['--rpc', dropping.url, '--rpc', liar.url, ...signed, '--variants', '2']);
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /^round 2: sent/m, 'a second round was sent');
    assert.match(out.text, /the stop is on chain: both RPCs show it, and this member's transaction \S+ is confirmed/);
    assert.ok(w.launchBatch().halted);
  } finally {
    await liar.close(); await dropping.close();
    rmSync(dir, { recursive: true, force: true });
  }
  await w.finish();
});
