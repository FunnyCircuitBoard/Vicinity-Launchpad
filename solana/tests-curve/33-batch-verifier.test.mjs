// The owner's batch verifier, his confirmation and the monitor's check (scripts/vcurve/batch.mjs; VICINITY-CURVE-DESIGN.md
// 8.4 steps 2 and 3, 8.6, 14.1; NOTES 76, 79, 80, 83 to 86), against the real program in litesvm: a clean list gives the
// unsigned publication, which the approver signs and the program accepts, and the monitor finds the stored batch equal to
// the list; a list naming a city with a coin, a pending approval, a locked ticker, a founder holding a role, a disabled
// config, a stale number, a tampered root or another approver gives problems and no transaction; a junk publication is
// reported by the monitor.
// Review round 6: the day's changes are computed only against lists the chain holds (R6-DIFF-1, R6-RT-1), the printout
// shows the metadata hash and names the fields that changed (R6-DIFF-2), and a list file with a lost field is refused (MK-1).
// Review round 7: only lists the owner signed and confirmed are baselines, with the window of the transaction he signed
// (R7-BA-1, R7-3); a file stands in only on a first use, read from two RPCs and printed in full (R7-4); the website's
// transaction is checked against the verified publication and its message hash printed (R7-CONF-1); a ticker another
// city can still launch with is refused (R7-BA-2, R7-CONF-4). The real CLI runs against JSON-RPC stubs serving the World.
// Review round 8: the correction of a batch in force, [clear(halt = false), publish] in one transaction, is built and
// checked by the verifier (`--correct`; R8-OPS-1); every account, the clock and the pending approvals come from every
// RPC and must agree (R8-DIFF-1), `check` too and two RPCs of one provider count as one (R8-DIFF-4); the website's
// window is the default one, and `confirm` (and the alarm) compare the transaction that wrote a record with the one the
// owner verified (R8-DIFF-2); the archive's MAC key lives outside any archive folder and is 32 bytes (R8-DIFF-5); an
// approver that is not a wallet key is refused (R8-DIFF-6). The verification of round 8: the coins, which every trade
// rewrites, are compared between the RPCs by existence and owner only, so a trade between the two reads stops nothing
// (R8-NEW-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, SOL, rpcStub, expectFail } from './helpers.mjs';
import {
  verifyListFile, checkStoredBatch, batchAddresses, allAddresses, parseArgs, changeLines, recordLive, archiveEntry, confirmPublication,
  decodePageTransaction, checkPageTransaction, messageHash, holderCandidateEntries, rpcProvider, rpcUrlsProblem, writeArchiveEntry, readArchive,
  archiveKey, compareChainViews, CLOCK_SYSVAR, presenceOnlyAddresses,
} from '../scripts/vcurve/batch.mjs';

const snapshot = (w, entries) => Object.fromEntries(allAddresses(batchAddresses(entries, { programId: w.programId })).map((k) => [k, w.accountInfo(k)]));
const listFile = (w, list, seq) => S.launchBatchFile(S.buildLaunchBatch(w.batchEntries(list), { programId: w.programId, batchSeq: seq }));
const codes = (r) => r.map((x) => x.code);
/** Every pending per-city Approval of the program, decoded (what `verify` reads with getProgramAccounts). */
const approvalsOf = (w) => w.svm.getProgramAccounts(address(w.programId)).map((x) => ({ owner: String(w.programId), data: Buffer.from(x.data) }))
  .filter((a) => S.accountType(a, { programId: w.programId }) === 'Approval').map((a) => S.decodeApproval(a, { programId: w.programId }));
/** An archive entry as `confirm` writes it: `file` signed and confirmed as the stored `latest` (or `record`). */
const signedFor = (w, file, record = w.launchBatch().latest) => archiveEntry({ kind: 'signed', file, record });
const pendingFor = (file, record) => archiveEntry({ kind: 'pending', file, record });
const hex = (b) => Buffer.from(b).toString('hex');
const text = (o) => JSON.stringify(o, null, 1);

test('8.4 the batch verifier: a clean list gives the unsigned publication the program accepts; every entry the program would refuse at launch, a stale number, a tampered root or another signer gives problems and no transaction; the monitor reports a publication nobody prepared', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const coinFounder = await w.signer(20n); const pending = await w.signer(20n);
  const h = await w.launchCoin({ cityId: 8001n, founder: coinFounder, symbol: 'VFTAKEN' });
  await w.approve({ cityId: 8002n, founder: pending, symbol: 'VFPEND' });
  const cfg1 = await w.addConfig({ ...S.DEFAULT_CONFIG });
  await w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: cfg1, enabled: false })], [w.admin], 'disable config 1');
  const fs = []; for (let i = 0; i < 3; i++) fs.push(await w.signer(20n));
  const clean = [{ cityId: 8101n, founder: fs[0], symbol: 'VFA' }, { cityId: 8102n, founder: fs[1], symbol: 'VFB' }, { cityId: 8103n, founder: fs[2], symbol: 'VFC' }];
  const verify = (file, o = {}) => verifyListFile({ file, accounts: snapshot(w, JSON.parse(JSON.stringify(file)).entries), approvals: approvalsOf(w), approver: approver.address, now: w.now(), programId: w.programId, chainConfirmed: true, ...o });

  // every entry the program would refuse at launch, each reported (and no transaction)
  const badList = [
    ...clean,
    { cityId: 8001n, founder: fs[0], symbol: 'VFX1' }, // the city has its coin
    { cityId: 8002n, founder: fs[1], symbol: 'VFX2' }, // a pending per-city approval (it wins)
    { cityId: 8104n, founder: fs[2], symbol: 'VFTAKEN' }, // a locked ticker
    { cityId: 8105n, founder: w.guardian, symbol: 'VFX3' }, // a founder holding a role
    { cityId: 8106n, founder: approver, symbol: 'VFX4' }, // the approver as founder
    { cityId: 8107n, founder: fs[0], symbol: 'VFX5', configId: cfg1 }, // a disabled config
  ];
  const r1 = verify(listFile(w, badList, 1n));
  assert.equal(r1.publish, null, 'no transaction');
  const msgs = r1.problems.map((p) => p.message).join('\n');
  for (const [city, why] of [[8001n, /has a coin/], [8002n, /pending per-city approval/], [8104n, /ticker is locked/], [8105n, /founder is the guardian/], [8106n, /founder is the launch approver/], [8107n, /config 1 is disabled/]]) {
    assert.match(msgs, new RegExp(`city ${city}[^\\n]*${why.source}`), `city ${city}`);
  }
  assert.equal(r1.problems.length, 6, 'the three clean entries pass');
  // a tampered root, a stale or skipped number, another signer, another program; the approvals not read
  const f = listFile(w, clean, 1n);
  assert.deepEqual(codes(verify({ ...f, root: f.root.replace(/^../, f.root.startsWith('00') ? '11' : '00') }).problems), ['BAD_FILE']);
  assert.deepEqual(codes(verify({ ...f, entries: f.entries.map((e, i) => (i ? e : { ...e, name: 'Other City' })) }).problems), ['BAD_FILE'], 'an entry edited after the root was computed');
  assert.deepEqual(codes(verify(listFile(w, clean, 2n)).problems), ['WRONG_SEQ']);
  assert.deepEqual(codes(verify(f, { approver: fs[0].address }).problems), ['NOT_APPROVER']);
  assert.deepEqual(codes(verify(f, { approvals: undefined }).problems), ['APPROVALS_UNREAD'], 'the pending approvals must be read (T87, review R7-BA-2)');
  // the clean list: the changes against nothing, and the unsigned publication
  const r = verify(f);
  assert.deepEqual(r.problems, []);
  assert.equal(r.changes.added.length, 3);
  assert.ok(r.publish && r.publish.seq === 1n && r.publish.leafCount === 3);
  assert.ok(S.publishWindowOk(w.now(), r.publish.validFrom, r.publish.validUntil));
  await w.send([r.publish.instruction], [approver], 'the verifier\'s publication, signed by the approver', { feePayer: approver });
  assert.deepEqual(checkStoredBatch({ file: f, accounts: snapshot(w, f.entries), programId: w.programId }), { problems: [] }, 'the monitor finds the list');
  // the next day's list: one entry removed, one added, one changed; the changes printed for the owner (the list of
  // batch 1 from his archive, confirmed)
  const next = listFile(w, [clean[0], { ...clean[1], name: 'Renamed City' }, { cityId: 8108n, founder: fs[2], symbol: 'VFD' }], 2n);
  const r2 = verify(next, { archive: [signedFor(w, f)] });
  assert.deepEqual(r2.problems, []);
  assert.deepEqual([r2.changes.added.map((e) => e.cityId), r2.changes.removed.map((e) => e.cityId), r2.changes.changed.map((c) => c.after.cityId)], [[8108n], [8103n], [8102n]]);
  // a publication nobody prepared (a junk root with the approver's key): the monitor reports it against the list
  await w.publishBatch(clean, { root: new Uint8Array(32).fill(3), leafCount: 3 });
  assert.deepEqual(codes(checkStoredBatch({ file: next, accounts: snapshot(w, next.entries), programId: w.programId }).problems), ['ROOT']);
  // after a clear the monitor says so
  await w.send([w.ix.clearLaunchBatch({ authority: w.guardian.address, halt: true })], [w.guardian], 'guardian clears with halt');
  const stored = listFile(w, clean, 2n);
  assert.deepEqual(codes(checkStoredBatch({ file: stored, accounts: snapshot(w, stored.entries), programId: w.programId }).problems), ['ROOT', 'CLEARED', 'HALTED']);
  assert.ok(codes(verify(listFile(w, clean, 3n)).problems).includes('BATCHES_HALTED'), 'the verifier refuses to prepare while halted');
  // the CLI's arguments
  assert.deepEqual(parseArgs(['verify', 'list.json', '--rpc', 'https://a.example', '--approver', String(approver.address), '--previous', 'old.json']),
    { mode: 'verify', file: 'list.json', rpc: ['https://a.example'], approver: String(approver.address), previous: 'old.json' });
  assert.match(parseArgs(['verify', 'list.json', '--rpc', 'https://a.example']).error, /needs --approver/);
  assert.match(parseArgs(['publish', 'list.json', '--rpc', 'https://a.example']).error, /mode/);
  assert.match(parseArgs(['verify', 'list.json', '--rpc', 'https://a.example', '--approver', String(approver.address), '--valid-from', '1']).error, /go together/);
  assert.match(parseArgs(['check', 'list.json', '--rpc', 'https://a.example', '--valid-from', '1']).error, /check takes no validFrom/);
  void h;
  await w.finish();
});

test('R6-DIFF-1, R6-RT-1 (review round 6) the day\'s changes are computed only against lists the chain holds: a forged --previous (an entry hidden, a founder swapped, a number that never existed) is a problem and no transaction; a live stored batch needs its list (from the archive, or on a first use --previous, printed in full); a pending batch shows the changes against the batch in force too; a publication nobody prepared is reported; an ended batch lists every entry as new', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 4; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const verify = (file, o = {}) => verifyListFile({ file, accounts: snapshot(w, file.entries), approvals: approvalsOf(w), approver: approver.address, now: w.now(), programId: w.programId, chainConfirmed: true, ...o });
  const day1 = [{ cityId: 8101n, founder: fs[0], symbol: 'VFA' }, { cityId: 8102n, founder: fs[1], symbol: 'VFB' }];
  const evil = { cityId: 8199n, founder: mallory, symbol: 'EVIL' };
  const honestNew = { cityId: 8103n, founder: fs[2], symbol: 'VFC' };
  const F1 = listFile(w, day1, 1n);
  // nothing published yet: a "previous" list is not on chain
  let r = verify(F1, { previous: listFile(w, [evil], 1n) });
  assert.deepEqual([codes(r.problems), r.publish], [['PREVIOUS_NOT_ON_CHAIN'], null]);
  r = verify(F1);
  assert.deepEqual([r.problems, r.baseline, r.changes.added.map((e) => e.cityId)], [[], null, [8101n, 8102n]]);
  await w.send([r.publish.instruction], [approver], 'day 1: the owner signs batch 1', { feePayer: approver });
  const A1 = signedFor(w, F1);
  w.warpTo(r.publish.validFrom);
  assert.ok(recordLive(w.launchBatch().latest, w.launchpad(), w.now()));

  // day 2: the compromised website adds the attacker's city and hands a self-consistent "previous" that already holds it
  const F2 = listFile(w, [...day1, honestNew, evil], 2n);
  const forged = listFile(w, [...day1, evil], 1n);
  assert.doesNotThrow(() => S.parseLaunchBatchFile(forged), 'the forged file is self-consistent');
  r = verify(F2, { previous: forged, archive: [A1] });
  assert.deepEqual([codes(r.problems), r.publish], [['PREVIOUS_NOT_ON_CHAIN'], null], 'the forged previous is refused, nothing to sign');
  assert.match(r.problems[0].message, new RegExp(`stored batch 1 \\(root ${hex(w.launchBatch().latest.root)}, 2 entries\\)`));
  // the same with a founder swapped on a carried-over city and a number that never existed (R6-RT-1)
  const swapped = { ...listFile(w, [day1[0], { ...day1[1], founder: mallory }], 41n) };
  r = verify(listFile(w, [day1[0], { ...day1[1], founder: mallory }], 2n), { previous: swapped });
  assert.deepEqual([codes(r.problems), r.publish], [['PREVIOUS_NOT_ON_CHAIN'], null]);
  // no list for the live stored batch: a problem, not "every entry added"
  r = verify(F2);
  assert.deepEqual([codes(r.problems), r.changes, r.publish], [['NO_PREVIOUS'], null, null]);
  // a first use (empty archive) with the real list of batch 1 on two RPCs: every entry of batch 1 is printed in full and
  // every entry of the new list is listed as added, so the attacker's city shows whatever the website hands
  r = verify(F2, { previous: F1 });
  assert.deepEqual([r.problems, r.baseline, r.changes.added.map((e) => e.cityId), r.unconfirmed.map((u) => [u.seq, u.source, u.entries.length])],
    [[], null, [8101n, 8102n, 8103n, 8199n], [[1n, '--previous', 2]]]);
  assert.ok(changeLines(r).some((l) => /^ {2}\+ city 8199 EVIL /.test(l)));
  assert.ok(changeLines(r).some((l) => /^the stored batch 1 \(in force\) is not a list this computer confirmed/.test(l)));
  assert.deepEqual(codes(verify(F2, { previous: F1, chainConfirmed: false }).problems), ['ONE_RPC'], 'one RPC cannot anchor a file (review R7-4)');
  // the owner's archive: the list of batch 1 is found there, no file from the website is needed
  r = verify(F2, { archive: [A1] });
  assert.deepEqual([r.problems, r.baseline, r.changes.added.map((e) => e.cityId)], [[], { seq: 1n, source: 'the archive' }, [8103n, 8199n]]);
  // an archive that does not hold the live stored batch: a problem even with a --previous that matches the chain
  r = verify(F2, { archive: [signedFor(w, forged, { ...w.launchBatch().latest })], previous: F1 });
  assert.deepEqual(codes(r.problems), ['LATEST_NOT_ARCHIVED']);

  // batch 2 published (pending; batch 1 stays in force); a correction (batch 3) replaces it: the changes against batch 2
  // and against batch 1 in force are both shown, each list from the archive
  const p2 = verify(F2, { archive: [A1] }).publish;
  await w.send([p2.instruction], [approver], 'day 2: batch 2', { feePayer: approver });
  const A2 = signedFor(w, F2);
  const F3 = listFile(w, [...day1, honestNew], 3n);
  r = verify(F3, { previous: F2 });
  assert.deepEqual([codes(r.problems), r.publish], [['NO_IN_FORCE'], null], 'the batch in force needs its list too');
  r = verify(F3, { previous: F2, inForce: forged });
  assert.deepEqual(codes(r.problems), ['IN_FORCE_NOT_ON_CHAIN']);
  r = verify(F3, { previous: F2, inForce: F1 });
  assert.deepEqual([r.problems, r.unconfirmed.map((u) => [u.seq, u.state])], [[], [[2n, 'pending'], [1n, 'in force']]]);
  r = verify(F3, { archive: [A1, A2] });
  assert.deepEqual([r.problems, r.baseline.source, r.changesInForce.source], [[], 'the archive', 'the archive']);
  assert.deepEqual([r.changes.removed.map((e) => e.cityId), r.changesInForce.seq, r.changesInForce.changes.added.map((e) => e.cityId)], [[8199n], 1n, [8103n]]);
  assert.deepEqual(codes(verify(F3, { archive: [A2] }).problems), ['IN_FORCE_NOT_ARCHIVED'], 'the batch in force must be a confirmed list too');
  assert.deepEqual(codes(verify(F3, { previous: F2, inForce: F2 }).problems), ['IN_FORCE_NOT_ON_CHAIN'], 'the pending list is not the batch in force');

  // a publication nobody prepared (the approver key stolen) replaces batch 2 and begins: the owner's next verify refuses
  const thief = await w.publishBatch([evil], { leadSecs: 12n * 3_600n + 60n, label: 'a publication nobody prepared' });
  w.warpTo(thief.validFrom);
  const F4 = listFile(w, [...day1, honestNew], 4n);
  assert.deepEqual(codes(verify(F4, { previous: F2 }).problems), ['PREVIOUS_NOT_ON_CHAIN']);
  r = verify(F4, { archive: [A1, A2] });
  assert.deepEqual(codes(r.problems), ['LATEST_NOT_ARCHIVED']);
  assert.match(r.problems[0].message, /a publication nobody prepared here; have a guardian member clear it with halt now/);
  assert.doesNotMatch(r.problems[0].message, /--no-archive|put its list/, 'the alarm offers no way around itself (review R7-BA-1)');
  // the guardian clears it: nothing can launch from the stored records, every entry of the next list is a new approval
  await w.send([w.ix.clearLaunchBatch({ authority: w.guardian.address, halt: false })], [w.guardian], 'the guardian clears');
  assert.ok(!recordLive(w.launchBatch().latest, w.launchpad(), w.now()));
  r = verify(F4, { archive: [A1, A2] });
  assert.deepEqual([r.problems, codes(r.warnings).sort(), r.baseline, r.changes.added.length], [[], ['LATEST_ENDED', 'LATEST_NOT_ARCHIVED'], null, 3]);
  r = verify(F4, { previous: S.launchBatchFile(thief) });
  assert.deepEqual([r.problems, r.ended.seq, r.ended.why, r.ended.changes.removed.map((e) => e.cityId), r.changes.added.length], [[], 3n, 'cleared', [8199n], 3]);
  assert.ok(changeLines(r).some((l) => /^for reference, changes against the cleared batch 3/.test(l)));
  assert.deepEqual(codes(verify(F4, { previous: F2 }).problems), ['PREVIOUS_NOT_ON_CHAIN'], 'an ended record still anchors --previous');
  assert.deepEqual(codes(verify(F4, { inForce: F1 }).problems), ['IN_FORCE_NOT_ON_CHAIN']);
  // the CLI's options
  assert.deepEqual(parseArgs(['verify', 'l.json', '--rpc', 'https://a.example', '--rpc', 'https://b.example', '--approver', String(approver.address), '--in-force', 'f.json', '--archive', 'd']),
    { mode: 'verify', file: 'l.json', rpc: ['https://a.example', 'https://b.example'], approver: String(approver.address), inForce: 'f.json', archive: 'd' });
  assert.equal(parseArgs(['verify', 'l.json', '--rpc', 'https://a.example', '--approver', String(approver.address), '--no-archive']).noArchive, true);
  assert.match(parseArgs(['verify', 'l.json', '--rpc', 'https://a.example', '--approver', String(approver.address), '--no-archive', '--archive', 'd']).error, /exclude/);
  assert.match(parseArgs(['verify', 'l.json', '--rpc', 'https://a.example', '--rpc', 'https://a.example', '--approver', String(approver.address)]).error, /two different providers/);
  assert.match(parseArgs(['check', 'l.json', '--rpc', 'https://a.example', '--previous', 'p.json']).error, /check takes no previous/);
  assert.match(parseArgs(['confirm', '2', 'nothex', '--rpc', 'https://a.example']).error, /64-digit hex root/);
  assert.match(parseArgs(['confirm', '2', '00'.repeat(32), '--rpc', 'https://a.example', '--no-archive']).error, /confirm takes no noArchive/);
  await w.finish();
});

/**
 * The real CLI as the owner runs it, with a scratch HOME (its archive key lives in ~/.vicinity-curve, review R8-DIFF-5)
 * and its default archive pointed at a scratch folder; returns `{ code, out }`.
 */
function cli(args, env) {
  if (!env?.HOME) throw new Error('every CLI run names a scratch HOME (scratch().env)');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(SOL, 'scripts', 'vcurve', 'batch.mjs'), ...args], { cwd: SOL, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
/** A scratch folder for one test: lists, archive; removed at the end. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'vcurve-r7-'));
  const env = { HOME: join(dir, 'home'), VICINITY_BATCH_ARCHIVE: join(dir, 'default-archive') };
  return { dir, env, archive: join(dir, 'archive'), put: (name, o) => { const f = join(dir, name); writeFileSync(f, typeof o === 'string' ? o : text(o)); return f; }, done: () => rmSync(dir, { recursive: true, force: true }) };
}
/** The window `verify` printed (its default window from the chain clock it read). */
const windowOf = (out) => { const m = /valid from (\S+) until (\S+)/.exec(out); return { validFrom: BigInt(Date.parse(m[1]) / 1000), validUntil: BigInt(Date.parse(m[2]) / 1000) }; };
/** The transaction the CLI printed, signed by the approver exactly as printed (the same message, so the same message hash) and sent. */
async function signPrinted(w, approver, out, label) {
  const m = /unsigned (?:clear_launch_batch and )?publish_launch_batch for \S+ \(base64[^\n]*\n(\S+)/.exec(out);
  assert.ok(m, out);
  return w.sendWire(Buffer.from(m[1], 'base64'), label, { signers: [approver] });
}

test('R6-DIFF-1, R6-DIFF-2, MK-1 (review rounds 6 and 7) the real CLI: a forged --previous gives a problem and no transaction; a verified list waits in pending/ until confirm finds it on chain, then it is the next day\'s baseline; a change of the metadata hash alone prints both hashes and names metaHash; a list file with a lost field is refused', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 3; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const sc = scratch();
  const rpc = await rpcStub(w);
  const base = ['--rpc', rpc.url, '--approver', String(approver.address), '--program-id', String(w.programId)];
  const env = sc.env;
  try {
    const day1 = [{ cityId: 8101n, founder: fs[0], symbol: 'VFA' }, { cityId: 8102n, founder: fs[1], symbol: 'VFB' }];
    const F1 = listFile(w, day1, 1n);
    let c = await cli(['verify', sc.put('day1.json', F1), ...base, '--archive', sc.archive], env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /changes against no live batch \(every entry is a new approval\): 2 added, 0 removed, 0 changed/);
    assert.match(c.out, /unsigned publish_launch_batch/);
    assert.match(c.out, /message hash \S+: sign only on a hardware wallet that shows this message hash/);
    const pdir = join(sc.archive, String(w.programId));
    assert.deepEqual([readdirSync(pdir).sort(), readdirSync(join(pdir, 'pending')).length], [['pending'], 1], 'the verified list waits in pending/, never a baseline');
    await signPrinted(w, approver, c.out, 'batch 1, the transaction the CLI printed');
    c = await cli(['confirm', '1', F1.root, '--rpc', rpc.url, '--archive', sc.archive, '--program-id', String(w.programId)], env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /^confirmed: batch 1 /m);
    assert.deepEqual([readdirSync(join(pdir, 'signed')), readdirSync(join(pdir, 'pending'))], [[`1-${F1.root}.json`], []]);
    w.warpTo(w.launchBatch().latest.validFrom);

    // day 2: city 8102's metadata hash alone changes, the attacker's city is added; the website's forged previous already holds both
    const swappedMeta = Array(32).fill(0xab);
    const today = [day1[0], { ...day1[1], metaHash: swappedMeta }, { cityId: 8103n, founder: fs[2], symbol: 'VFC' }, { cityId: 8199n, founder: mallory, symbol: 'EVIL' }];
    const F2 = listFile(w, today, 2n);
    const forged = listFile(w, [day1[0], { ...day1[1], metaHash: swappedMeta }, today[3]], 1n);
    c = await cli(['verify', sc.put('day2.json', F2), ...base, '--previous', sc.put('forged.json', forged), '--no-archive'], env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM PREVIOUS_NOT_ON_CHAIN: --previous batch 1 \(root [0-9a-f]{64}, 3 entries\) is not the stored batch 1/);
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    assert.match(c.out, /do not sign/);
    c = await cli(['verify', sc.put('day2.json', F2), ...base, '--no-archive'], env);
    assert.equal(c.code, 1);
    assert.match(c.out, /PROBLEM NO_PREVIOUS/);
    assert.match(c.out, /PROBLEM ONE_RPC/);
    // from the archive (no file from the website): the attacker's city is listed, and the metadata change is visible
    c = await cli(['verify', sc.put('day2.json', F2), ...base, '--archive', sc.archive], env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /changes against the stored batch 1 \(its list from the archive\): 2 added, 0 removed, 1 changed/);
    assert.match(c.out, /\n {2}\+ city 8199 EVIL "Demo City" founder \S+ config 0 meta [0-9a-f]{64}\n/);
    const lines = c.out.split('\n');
    const i = lines.findIndex((l) => l.startsWith('  ~ city 8102 '));
    assert.ok(i > 0, c.out);
    assert.notEqual(lines[i].slice(4), lines[i + 1].slice(7), 'the before and after lines differ');
    assert.ok(lines[i].endsWith(`meta ${F1.entries[1].metaHash}`) && lines[i + 1].endsWith(`meta ${'ab'.repeat(32)}`), `${lines[i]}\n${lines[i + 1]}`);
    assert.equal(lines[i + 2], '    changed: metaHash');
    // a list file whose entry lost its name and config id before the root was computed (the old coercion's root): refused
    const coerced = listFile(w, [{ ...day1[0], name: 'undefined', configId: 0 }, day1[1], today[2]], 2n);
    const lost = { ...coerced, entries: coerced.entries.map((e, k) => (k ? e : Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'name' && key !== 'configId')))) };
    c = await cli(['verify', sc.put('lost.json', lost), ...base, '--archive', sc.archive], env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM BAD_FILE: BatchError::BadFile: entry 0: missing configId, name/);
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    c = await cli(['check', sc.put('lost.json', lost), '--rpc', rpc.url, '--program-id', String(w.programId)], env);
    assert.equal(c.code, 1);
    assert.match(c.out, /PROBLEM BAD_FILE/);
    // and through the exported function: no transaction
    const rv = verifyListFile({ file: lost, accounts: snapshot(w, coerced.entries), approvals: [], approver: approver.address, now: w.now(), programId: w.programId, archive: [signedFor(w, F1)] });
    assert.deepEqual([codes(rv.problems), rv.publish], [['BAD_FILE'], null]);
    assert.ok(!existsSync(env.VICINITY_BATCH_ARCHIVE), 'no run wrote to the default archive');
  } finally {
    await rpc.close();
    sc.done();
  }
  await w.finish();
});

test('R7-BA-1, R7-3 (review round 7) a list the owner verified and refused never becomes a baseline: refused, then a lying chain view; refused, then published with a stolen approver key; and the alarm\'s old remedies (a copied file, --no-archive) hide nothing', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 5; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const sc = scratch();
  const honest = await rpcStub(w);
  let lieAs = null; // when set: LaunchBatch.latest served with this root and leaf count
  const lying = await rpcStub(w, {
    host: '127.0.0.2',
    lie: (addr, a) => {
      if (!lieAs || addr !== String(w.P.launchBatch()) || !a) return a;
      const d = Buffer.from(a.data); Buffer.from(lieAs.root).copy(d, 18); d.writeUInt32LE(lieAs.leafCount, 50);
      return { ...a, data: d };
    },
  });
  const args = (rpc) => ['--rpc', rpc.url, '--approver', String(approver.address), '--program-id', String(w.programId), '--archive', sc.archive];
  const confirm = (seq, root, more = []) => cli(['confirm', String(seq), root, '--rpc', honest.url, '--archive', sc.archive, '--program-id', String(w.programId), ...more], sc.env);
  try {
    const A = { cityId: 9101n, founder: fs[0], symbol: 'RA' }; const B = { cityId: 9102n, founder: fs[1], symbol: 'RB' };
    const C = { cityId: 9103n, founder: fs[2], symbol: 'RC' }; const D = { cityId: 9104n, founder: fs[3], symbol: 'RD' };
    const E = { cityId: 9199n, founder: mallory, symbol: 'EVIL' };
    // day 1: batch 1 (A, B) verified, signed and confirmed; it takes force
    const F1 = listFile(w, [A, B], 1n);
    let c = await cli(['verify', sc.put('d1.json', F1), ...args(honest)], sc.env);
    assert.equal(c.code, 0, c.out);
    await signPrinted(w, approver, c.out, 'day 1: batch 1');
    assert.equal((await confirm(1, F1.root)).code, 0);
    w.warpTo(w.launchBatch().latest.validFrom);

    // day 2: the website hands X_bad (A, B, C, E): verify shows "+ E" and prepares a transaction; the owner refuses it
    const Xbad = listFile(w, [A, B, C, E], 2n);
    c = await cli(['verify', sc.put('xbad.json', Xbad), ...args(honest)], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /\+ city 9199 EVIL/);
    assert.match(c.out, /kept as pending \(never a baseline until you confirm it\)/);
    const badWindow = windowOf(c.out);
    // the website then hands X_good (A, B, C): verified and signed as batch 2
    const Xgood = listFile(w, [A, B, C], 2n);
    w.warpSecs(60);
    c = await cli(['verify', sc.put('xgood.json', Xgood), ...args(honest)], sc.env);
    assert.equal(c.code, 0, c.out);
    await signPrinted(w, approver, c.out, 'day 2: batch 2 (X_good)');
    // the confirmation refuses while the refused list is pending for the same number, then sets it aside
    c = await confirm(2, Xgood.root);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM SEVERAL_PENDING: you also verified other lists for number 2 \(roots [0-9a-f]{64}\)/);
    c = await confirm(2, Xgood.root, ['--discard-others']);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /moved to refused\/: batch 2 root/);
    const pdir = join(sc.archive, String(w.programId));
    assert.deepEqual([readdirSync(join(pdir, 'signed')).length, readdirSync(join(pdir, 'pending')).length, readdirSync(join(pdir, 'refused')).length], [2, 0, 1]);
    w.warpTo(w.launchBatch().latest.validFrom);

    // day 3: Y = A, B, C, E, D. The honest chain view shows both new cities.
    const Y = listFile(w, [A, B, C, E, D], 3n);
    c = await cli(['verify', sc.put('y.json', Y), ...args(honest)], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /changes against the stored batch 2 \(its list from the archive\): 2 added/);
    assert.match(c.out, /\+ city 9104 RD/); assert.match(c.out, /\+ city 9199 EVIL/);
    // path 1: a chain view that answers X_bad's root and leaf count at the real number 2: before round 7 the archived
    // X_bad was the baseline and E vanished; now it is no confirmed list: a problem and no transaction
    lieAs = { root: Buffer.from(Xbad.root, 'hex'), leafCount: Xbad.leafCount };
    c = await cli(['verify', sc.put('y.json', Y), ...args(lying)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM LATEST_NOT_ARCHIVED: the stored batch \(in force\), batch 2 \(root [0-9a-f]{64}, 4 entries\), window/);
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    assert.doesNotMatch(c.out, /--no-archive|put its list/);
    // the same through the function, with X_bad still pending (refused, not set aside) and the lie copying its window:
    // the message names the list he verified and never confirmed
    const accounts = { ...snapshot(w, Y.entries) };
    const lbAddr = String(w.P.launchBatch()); const d = Buffer.from(accounts[lbAddr].data);
    Buffer.from(Xbad.root, 'hex').copy(d, 18); d.writeUInt32LE(Xbad.leafCount, 50); d.writeBigInt64LE(badWindow.validFrom, 54); d.writeBigInt64LE(badWindow.validUntil, 62);
    accounts[lbAddr] = { ...accounts[lbAddr], data: d };
    const r = verifyListFile({ file: Y, accounts, approvals: approvalsOf(w), approver: approver.address, now: w.now(), programId: w.programId, chainConfirmed: true,
      archive: [signedFor(w, F1, { ...w.launchBatch().previous }), signedFor(w, Xgood)], pending: [pendingFor(Xbad, { ...badWindow, publisher: approver.address })] });
    assert.deepEqual([codes(r.problems), r.publish], [['LATEST_NOT_ARCHIVED'], null]);
    assert.match(r.problems[0].message, /it is a list you verified .* but never confirmed\. If you signed exactly that transaction, run: .*confirm 2 [0-9a-f]{64}\. If you did not sign it, the approver key is stolen/);
    lieAs = null;

    // path 2: the refused X_bad published with the stolen approver key (pending, then in force): the next verify refuses,
    // the owner's confirm of what he signed fails, and nothing of X_bad becomes a baseline
    const pX = listFile(w, [A, B, C, E], 3n);
    c = await cli(['verify', sc.put('xbad3.json', pX), ...args(honest)], sc.env);
    assert.equal(c.code, 0, c.out); // the owner verifies the list once more and refuses it again
    const stolen = await w.publishBatch([A, B, C, E], { leadSecs: 12n * 3_600n + 3_000n, label: 'the refused list, published with the stolen key' });
    const Z = listFile(w, [A, B, C, D], 4n);
    c = await cli(['verify', sc.put('z.json', Z), ...args(honest)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM LATEST_NOT_ARCHIVED: .*it has the root of a list you verified, but the window or the signer of another transaction/);
    c = await confirm(3, stolen.root ? hex(stolen.root) : pX.root);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM WINDOW: the stored batch 3 .* is not the transaction you verified/);
    w.warpTo(stolen.validFrom);
    c = await cli(['verify', sc.put('z.json', Z), ...args(honest)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM LATEST_NOT_ARCHIVED: the stored batch \(in force\)/);

    // path 3: the old remedies. A copy of the website's list (or a forged archive entry) in signed/ is ignored; with
    // --no-archive and the website's file as --previous, one RPC is refused, and two RPCs print every entry of the live
    // batch, EVIL included, and list every entry of the new list as added: nothing is hidden
    writeFileSync(join(pdir, 'signed', `3-${hex(stolen.root)}.json`), text(S.launchBatchFile(stolen)));
    writeFileSync(join(pdir, 'signed', `3-${hex(stolen.root)}-forged.json`), text({ ...signedFor(w, S.launchBatchFile(stolen)), mac: '00'.repeat(32) }));
    c = await cli(['verify', sc.put('z.json', Z), ...args(honest)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /warning ARCHIVE_IGNORED: signed\/3-[0-9a-f]{64}-forged\.json: not written with this computer's archive key/);
    assert.match(c.out, /warning ARCHIVE_IGNORED: signed\/3-[0-9a-f]{64}\.json: not written with this computer's archive key/);
    assert.match(c.out, /PROBLEM LATEST_NOT_ARCHIVED/);
    const web = sc.put('web.json', S.launchBatchFile(stolen));
    c = await cli(['verify', sc.put('z.json', Z), '--rpc', honest.url, '--approver', String(approver.address), '--program-id', String(w.programId), '--no-archive', '--previous', web], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM ONE_RPC/);
    c = await cli(['verify', sc.put('z.json', Z), '--rpc', honest.url, '--rpc', lying.url, '--approver', String(approver.address), '--program-id', String(w.programId), '--no-archive', '--previous', web], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /the stored batch 3 \(in force\) is not a list this computer confirmed/);
    assert.match(c.out, /\n {2}= city 9199 EVIL /, 'the live batch\'s entries are printed in full');
    assert.match(c.out, /changes against no confirmed list \(every entry is listed as a new approval\): 4 added/);
  } finally {
    await honest.close(); await lying.close();
    sc.done();
  }
  await w.finish();
});

test('R7-4 (review round 7) the chain view: two RPCs that disagree on LaunchBatch give no transaction; with no confirmed list, a forged --previous that a lying RPC anchors is refused for want of a second RPC, and two honest RPCs refuse it', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 3; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const sc = scratch();
  const day1 = [{ cityId: 8101n, founder: fs[0], symbol: 'VFA' }, { cityId: 8102n, founder: fs[1], symbol: 'VFB' }];
  await w.publishBatch(day1, { label: 'batch 1' });
  w.warpTo(w.launchBatch().latest.validFrom);
  const forgedPrev = listFile(w, [...day1, { cityId: 8199n, founder: mallory, symbol: 'EVIL' }], 1n);
  const honest = await rpcStub(w);
  const lying = await rpcStub(w, {
    host: '127.0.0.2',
    lie: (addr, a) => {
      if (addr !== String(w.P.launchBatch()) || !a) return a;
      const d = Buffer.from(a.data); Buffer.from(forgedPrev.root, 'hex').copy(d, 18); d.writeUInt32LE(forgedPrev.leafCount, 50);
      return { ...a, data: d };
    },
  });
  const F2 = listFile(w, [...day1, { cityId: 8199n, founder: mallory, symbol: 'EVIL' }, { cityId: 8103n, founder: fs[2], symbol: 'VFC' }], 2n);
  const base = ['--approver', String(approver.address), '--program-id', String(w.programId), '--no-archive', '--previous', sc.put('p.json', forgedPrev)];
  try {
    // the review's case: one lying RPC anchors the forged previous; before round 7 it was the baseline and EVIL vanished
    let c = await cli(['verify', sc.put('f2.json', F2), '--rpc', lying.url, ...base], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM ONE_RPC/);
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    c = await cli(['verify', sc.put('f2.json', F2), '--rpc', lying.url, '--rpc', honest.url, ...base], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM RPC_DISAGREE/);
    const honest2 = await rpcStub(w, { host: '127.0.0.3' });
    try {
      c = await cli(['verify', sc.put('f2.json', F2), '--rpc', honest.url, '--rpc', honest2.url, ...base], sc.env);
      assert.equal(c.code, 1, c.out);
      assert.match(c.out, /PROBLEM PREVIOUS_NOT_ON_CHAIN/);
    } finally { await honest2.close(); }
  } finally {
    await honest.close(); await lying.close();
    sc.done();
  }
  await w.finish();
});

test('R7-CONF-1 (review round 7) the website\'s batch page: verify --tx refuses a transaction whose root, accounts, signer or instructions are not the verified publication and prints the message hash of one that is; confirm and the monitor\'s check of the owner\'s exported entry catch a swapped root within minutes', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 3; i++) fs.push(await w.signer(20n));
  const attacker = await w.signer(20n);
  const sc = scratch();
  const rpc = await rpcStub(w);
  const args = ['--rpc', rpc.url, '--approver', String(approver.address), '--program-id', String(w.programId), '--archive', sc.archive];
  try {
    const L1 = listFile(w, [{ cityId: 9501n, founder: fs[0], symbol: 'PA' }, { cityId: 9502n, founder: fs[1], symbol: 'PB' }], 1n);
    const L2 = listFile(w, [{ cityId: 9590n, founder: attacker, symbol: 'PX' }, { cityId: 9591n, founder: attacker, symbol: 'PY' }, { cityId: 9592n, founder: attacker, symbol: 'PZ' }], 1n);
    const v = verifyListFile({ file: L1, accounts: snapshot(w, L1.entries), approvals: [], approver: approver.address, now: w.now(), programId: w.programId });
    const win = { validFrom: v.publish.validFrom, validUntil: v.publish.validUntil };
    const web3Ix = (ix) => new web3.TransactionInstruction({ programId: new web3.PublicKey(ix.programAddress), data: Buffer.from(ix.data),
      keys: ix.accounts.map((a) => ({ pubkey: new web3.PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
    const pageTx = (ixs, payer = approver.address) => new web3.Transaction({ feePayer: new web3.PublicKey(String(payer)), recentBlockhash: String(w.programId) }).add(...ixs.map(web3Ix))
      .serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const publishOf = (list, o = {}) => w.ix.publishLaunchBatch({ approver: approver.address, seq: 1n, root: Buffer.from(list.root, 'hex'), leafCount: list.leafCount, ...win, ...o });
    // the review's case: the page shows seq 1, root R1 and the window, and hands the wallet root R2
    let c = await cli(['verify', sc.put('l1.json', L1), ...args, '--tx', pageTx([publishOf(L2)])], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM TX_NOT_VERIFIED/);
    assert.doesNotMatch(c.out, /kept as pending|message hash/);
    // another payer, an extra instruction, other accounts: each refused
    const tests = [
      [pageTx([publishOf(L1)], fs[2].address), /PROBLEM TX_SIGNERS/],
      [pageTx([publishOf(L1), web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(String(approver.address)), toPubkey: new web3.PublicKey(String(attacker.address)), lamports: 1 })].map((x) => (x.programAddress ? x : { programAddress: x.programId.toBase58(), accounts: x.keys.map((k) => ({ address: k.pubkey.toBase58(), role: (k.isSigner ? 2 : 0) + (k.isWritable ? 1 : 0) })), data: x.data }))), /PROBLEM TX_OTHER_INSTRUCTION/],
      [pageTx([publishOf(L1, { overrides: { launchpad: { address: String(attacker.address), role: 0 } } })]), /PROBLEM TX_ACCOUNTS/],
      [pageTx([w.ix.clearLaunchBatch({ authority: approver.address })]), /PROBLEM TX_NO_PUBLICATION/],
      ['bm90IGEgdHJhbnNhY3Rpb24=', /PROBLEM BAD_TX/],
    ];
    for (const [tx, want] of tests) {
      c = await cli(['verify', sc.put('l1.json', L1), ...args, '--tx', tx], sc.env);
      assert.equal(c.code, 1, c.out); assert.match(c.out, want);
    }
    // the page's correct transaction (a v0 message with a compute-unit price): accepted, its message hash printed; the
    // hash is the SHA-256 of the message the wallet signs, which a Ledger shows when it blind-signs
    const msg = new web3.TransactionMessage({ payerKey: new web3.PublicKey(String(approver.address)), recentBlockhash: String(w.programId),
      instructions: [web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }), web3Ix(publishOf(L1))] }).compileToV0Message();
    const good = Buffer.from(new web3.VersionedTransaction(msg).serialize()).toString('base64');
    const decoded = decodePageTransaction(good, { programId: w.programId });
    assert.deepEqual(checkPageTransaction(decoded, v.publish, { approver: approver.address }), { problems: [], messageHash: messageHash(msg.serialize()) });
    c = await cli(['verify', sc.put('l1.json', L1), ...args, '--tx', good], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, new RegExp(`message hash ${messageHash(msg.serialize())}:`));
    assert.match(c.out, /the website's transaction is exactly this publication/);
    const pending = readdirSync(join(sc.archive, String(w.programId), 'pending'));
    assert.equal(pending.length, 1);
    const exported = join(sc.archive, String(w.programId), 'pending', pending[0]);
    // the page swapped the root anyway and the wallet signed R2 (a software wallet shows no hash): within minutes the
    // owner's confirm and the monitor's check of his exported entry both report it
    await w.send([publishOf(L2)], [approver], 'the page\'s other transaction, signed', { feePayer: approver });
    c = await cli(['confirm', '1', L1.root, '--rpc', rpc.url, '--archive', sc.archive, '--program-id', String(w.programId)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM ROOT: the stored batch 1 has root [0-9a-f]{64}, not [0-9a-f]{64}: a publication you did not sign/);
    assert.match(c.out, /page the guardian members/);
    c = await cli(['check', exported, '--rpc', rpc.url, '--program-id', String(w.programId)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM ROOT/); assert.match(c.out, /PROBLEM LEAF_COUNT/);
    // the site's own database list (the attacker's) matches, as in the review: only the owner's entry catches it
    assert.deepEqual(checkStoredBatch({ file: L2, accounts: snapshot(w, L2.entries), programId: w.programId }), { problems: [] });
    // the owner's entry with the right root but another window (re-signed later by a thief): the monitor reports it
    const lb = w.launchBatch().latest;
    const otherWindow = pendingFor(L2, { validFrom: lb.validFrom + 1n, validUntil: lb.validUntil, publisher: approver.address });
    assert.deepEqual(codes(checkStoredBatch({ file: otherWindow, accounts: snapshot(w, L2.entries), programId: w.programId }).problems), ['NOT_THE_VERIFIED_WINDOW']);
    // confirm through the function: the right root and window pass
    const good2 = pendingFor(L2, { validFrom: lb.validFrom, validUntil: lb.validUntil, publisher: approver.address });
    assert.deepEqual(confirmPublication({ seq: 1, root: L2.root, pending: [good2], accounts: snapshot(w, L2.entries), programId: w.programId }).problems, []);
  } finally {
    await rpc.close();
    sc.done();
  }
  await w.finish();
});

test('R7-BA-2, R7-CONF-4 (review round 7) a ticker another city can still launch with is refused: a pending per-city approval of another city (A6), and the batch in force naming it for another city (A11); an expired approval or a launched city holds nothing; the admin\'s approval is checked the same way', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 4; i++) fs.push(await w.signer(20n));
  // the snapshot also holds the Coin accounts of the cities of the stored batches that may be in force, as the CLI reads them
  const verify = (file, o = {}) => verifyListFile({
    file, accounts: snapshot(w, [...file.entries, ...holderCandidateEntries({ launchBatch: w.launchBatch(), archive: o.archive ?? [], programId: w.programId })]),
    approvals: approvalsOf(w), approver: approver.address, now: w.now(), programId: w.programId, chainConfirmed: true, ...o,
  });
  // A6: the admin's per-city approval of city 9402 with PARIS is pending; the day's list names city 9401 with PARIS
  await w.approve({ cityId: 9402n, founder: fs[3], symbol: 'PARIS', ttl: 3n * 86_400n });
  const L1 = listFile(w, [{ cityId: 9401n, founder: fs[0], symbol: 'PARIS' }, { cityId: 9901n, founder: fs[1], symbol: 'SPRING' }], 1n);
  let r = verify(L1);
  assert.deepEqual([codes(r.problems), r.publish], [['BAD_ENTRY'], null]);
  assert.match(r.problems[0].message, /city 9401, PARIS[^\n]*ticker PARIS is held by city 9402 \(a pending per-city approval/);
  // the website's builder refuses it too with the same chain view
  const holders = S.tickerHolders({ approvals: approvalsOf(w), now: w.now() });
  assert.throws(() => S.buildLaunchBatch(w.batchEntries([{ cityId: 9401n, founder: fs[0], symbol: 'PARIS' }]), { programId: w.programId, batchSeq: 1n, chain: { heldTickers: holders } }), /ticker PARIS is held by city 9402/);
  // the race it prevents, on chain: whoever launches first takes PARIS for good
  // (the per-city founder launches; the batch entry could never launch under PARIS)
  await w.launch({ cityId: 9402n, founder: fs[3], label: 'the per-city founder takes PARIS' });
  r = verify(L1);
  assert.match(r.problems[0].message, /city 9401, PARIS[^\n]*the ticker is locked/);
  // an expired approval holds nothing
  await w.approve({ cityId: 9403n, founder: fs[3], symbol: 'ROME', ttl: 3_600n });
  const rome = listFile(w, [{ cityId: 9404n, founder: fs[0], symbol: 'ROME' }], 1n);
  assert.deepEqual(codes(verify(rome).problems), ['BAD_ENTRY']);
  w.warpSecs(3_601);
  assert.deepEqual(verify(rome).problems, [], 'an expired approval can no longer launch (ApprovalExpired)');

  // A11: batch 1 (in force) names 9901 with SPRING; the next list moves SPRING to 9902 and gives 9901 SPRINGA
  const B1 = listFile(w, [{ cityId: 9901n, founder: fs[1], symbol: 'SPRING' }, { cityId: 9905n, founder: fs[2], symbol: 'SUMMER' }], 1n);
  const p1 = verify(B1).publish;
  await w.send([p1.instruction], [approver], 'batch 1', { feePayer: approver });
  const A1 = signedFor(w, B1);
  w.warpTo(p1.validFrom);
  const B2 = listFile(w, [{ cityId: 9901n, founder: fs[1], symbol: 'SPRINGA' }, { cityId: 9902n, founder: fs[2], symbol: 'SPRING' }], 2n);
  r = verify(B2, { archive: [A1] });
  assert.deepEqual([codes(r.problems), r.publish], [['BAD_ENTRY'], null]);
  assert.match(r.problems[0].message, /city 9902, SPRING[^\n]*ticker SPRING is held by city 9901 \(the stored batch 1\)/);
  // the race it prevents: during batch 2's review window 9901 launches from batch 1 with SPRING
  // the corrected list keeps SPRING with 9901: accepted, and published as batch 2 (pending; batch 1 in force)
  const B2ok = listFile(w, [{ cityId: 9901n, founder: fs[1], symbol: 'SPRING' }, { cityId: 9902n, founder: fs[2], symbol: 'AUTUMN' }], 2n);
  const p2 = verify(B2ok, { archive: [A1] }).publish;
  await w.send([p2.instruction], [approver], 'batch 2', { feePayer: approver });
  const A2 = signedFor(w, B2ok);
  // a correction of the pending batch 2 is checked against batch 1, which stays in force until it takes force
  const B3 = listFile(w, [{ cityId: 9906n, founder: fs[3], symbol: 'SUMMER' }], 3n);
  r = verify(B3, { archive: [A1, A2] });
  assert.match(r.problems[0].message, /city 9906, SUMMER[^\n]*ticker SUMMER is held by city 9905 \(the stored batch 1\)/);
  // a city of the batch in force that has launched holds nothing beyond its locked ticker
  await w.launchFromBatch({ batch: S.parseLaunchBatchFile(B1), cityId: 9905n, founder: fs[2], label: 'city 9905 launches from batch 1' });
  r = verify(B3, { archive: [A1, A2] });
  assert.match(r.problems[0].message, /city 9906, SUMMER[^\n]*the ticker is locked/);
  assert.doesNotMatch(r.problems[0].message, /held by city 9905/);
  // the admin's per-city approval is checked the same way (14.1): SPRING is held by city 9901 in batch 1
  const held = S.tickerHolders({ approvals: approvalsOf(w), batches: [{ seq: 1n, entries: S.parseLaunchBatchFile(B1).entries }], coins: new Set([9905n]), now: w.now() });
  assert.match(S.tickerConflicts(9903n, 'SPRING', held).join(), /held by city 9901 \(the stored batch 1\)/);
  assert.deepEqual(S.tickerConflicts(9901n, 'SPRING', held), [], 'its own city holds nothing against itself');
  await expectFail(() => w.launchFromBatch({ batch: S.parseLaunchBatchFile(B2ok), cityId: 9901n, founder: fs[1], label: 'batch 2 before its valid_from' }), 'BatchNotYetValid');
  await w.finish();
});

// ---------------------------------------------------------------- review round 8
/** A @solana/kit-style instruction as a web3.js one. */
const web3Ix = (ix) => new web3.TransactionInstruction({ programId: new web3.PublicKey(ix.programAddress), data: Buffer.from(ix.data),
  keys: ix.accounts.map((a) => ({ pubkey: new web3.PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
/** A page's unsigned transaction (legacy), base64, paid by `payer`, with `blockhash` (any 32 bytes when it is never sent). */
const pageTxOf = (ixs, payer, blockhash) => new web3.Transaction({ feePayer: new web3.PublicKey(String(payer)), recentBlockhash: String(blockhash) }).add(...ixs.map(web3Ix))
  .serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
/** Verify, sign exactly what was printed, send and confirm a list through the real CLI. */
async function publishConfirmed(w, approver, sc, rpcArgs, name, file) {
  let c = await cli(['verify', sc.put(name, file), ...rpcArgs, '--approver', String(approver.address), '--program-id', String(w.programId), '--archive', sc.archive], sc.env);
  assert.equal(c.code, 0, c.out);
  await signPrinted(w, approver, c.out, `${name}: the printed publication`);
  c = await cli(['confirm', file.seq, file.root, ...rpcArgs, '--archive', sc.archive, '--program-id', String(w.programId)], sc.env);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /^confirmed: /m);
  return c;
}

test('R8-OPS-1 (review round 8) the correction of a batch in force, [clear_launch_batch(halt = false), publish_launch_batch] in one transaction, is built by verify --correct, checked by verify --correct --tx, and stops the bad entry at once; without it a lone publication leaves the batch in force running, and verify says so', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 3; i++) fs.push(await w.signer(20n));
  const sc = scratch();
  const rpc = await rpcStub(w);
  const args = ['--rpc', rpc.url, '--approver', String(approver.address), '--program-id', String(w.programId), '--archive', sc.archive];
  try {
    const A = { cityId: 9601n, founder: fs[0], symbol: 'CA' }; const B = { cityId: 9602n, founder: fs[1], symbol: 'CB' };
    const BAD = { cityId: 9666n, founder: fs[2], symbol: 'CBAD' };
    // batch 1 (A, B, BAD): verified, signed, confirmed through the CLI, and in force
    const F1 = listFile(w, [A, B, BAD], 1n);
    await publishConfirmed(w, approver, sc, ['--rpc', rpc.url], 'b1.json', F1);
    w.warpTo(w.launchBatch().latest.validFrom);
    // BAD must go (a wrong entry, or a founder who lost his seat): the corrected list L2 = A, B
    const L2 = listFile(w, [A, B], 2n);
    // a plain verify prepares a lone publication and now says that batch 1, BAD included, stays in force until L2's valid_from
    let c = await cli(['verify', sc.put('l2.json', L2), ...args], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /warning STILL_IN_FORCE: batch 1 stays in force until this list's valid_from: the 1 removed and 0 changed entries above can still launch .* run verify again with --correct/);
    // the page's [clear, publish]: refused without --correct (before round 8: TX_NOT_VERIFIED and TX_OTHER_INSTRUCTION,
    // with no way to check it), accepted with it, its hash printed
    const win = S.defaultPublishWindow(w.now());
    const clearIx = w.ix.clearLaunchBatch({ authority: approver.address, halt: false });
    const publishL2 = w.ix.publishLaunchBatch({ approver: approver.address, seq: 2n, root: Buffer.from(L2.root, 'hex'), leafCount: L2.leafCount, ...win });
    const correction = pageTxOf([clearIx, publishL2], approver.address, w.programId);
    c = await cli(['verify', sc.put('l2.json', L2), ...args, '--tx', correction], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM TX_CLEAR_NOT_ASKED: it clears the stored batches before it publishes .* run verify again with --correct/);
    assert.doesNotMatch(c.out, /TX_NOT_VERIFIED/);
    c = await cli(['verify', sc.put('l2.json', L2), ...args, '--correct', '--tx', correction], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /changes once this transaction has cleared the stored batches \(every entry is a new approval\): 2 added, 0 removed, 0 changed/);
    assert.match(c.out, /for reference, changes against batch 1 \(in force; this transaction clears it first, so none of its entries can launch once it lands; its list from the archive\): 0 added, 1 removed, 0 changed\n {2}- city 9666 CBAD /);
    assert.match(c.out, new RegExp(`message hash ${messageHash(decodePageTransaction(correction, { programId: w.programId }).messageBytes)}:`));
    assert.match(c.out, /the website's transaction is exactly this publication/);
    assert.doesNotMatch(c.out, /STILL_IN_FORCE/);
    // the clear is checked as strictly as the publication: order, halt, authority; and a lone publication under --correct
    const v = verifyListFile({ file: L2, accounts: snapshot(w, L2.entries), approvals: approvalsOf(w), approver: approver.address, now: w.now(), programId: w.programId, chainConfirmed: true,
      archive: [signedFor(w, F1)], correct: true, validFrom: win.validFrom, validUntil: win.validUntil });
    assert.deepEqual([v.problems, v.cleared.map((x) => [x.seq, x.state, x.changes.removed.map((e) => e.cityId)])], [[], [[1n, 'in force', [9666n]]]]);
    const check = (ixs) => codes(checkPageTransaction(decodePageTransaction(pageTxOf(ixs, approver.address, w.programId), { programId: w.programId }), v.publish, { approver: approver.address }).problems);
    assert.deepEqual(check([clearIx, publishL2]), []);
    assert.deepEqual(check([publishL2, clearIx]), ['TX_OTHER_INSTRUCTION'], 'the clear comes first');
    assert.deepEqual(check([w.ix.clearLaunchBatch({ authority: approver.address, halt: true }), publishL2]), ['TX_NOT_VERIFIED'], 'a halt would refuse the publication itself');
    assert.deepEqual(check([publishL2]), ['TX_NO_CLEAR']);
    assert.deepEqual(check([clearIx, clearIx, publishL2]), ['TX_OTHER_INSTRUCTION']);
    assert.ok(check([w.ix.clearLaunchBatch({ authority: w.guardian.address, halt: false }), publishL2]).includes('TX_ACCOUNTS'));
    // the verifier's own correction: printed, signed exactly as printed, sent; BAD can no longer launch, nothing is in
    // force until L2 takes force, and confirm finds the transaction he verified
    c = await cli(['verify', sc.put('l2.json', L2), ...args, '--correct'], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /this transaction first clears the stored batches \(clear_launch_batch, halt = false\)/);
    assert.match(c.out, /unsigned clear_launch_batch and publish_launch_batch for /);
    await signPrinted(w, approver, c.out, 'the owner\'s correction: clear, then publish L2');
    const lb = w.launchBatch();
    assert.deepEqual([lb.halted, lb.previous.seq, lb.previous.cleared, lb.latest.seq, lb.latest.cleared], [false, 1n, true, 2n, false]);
    assert.equal(S.batchInForce(lb, w.launchpad(), w.now()), null, 'nothing is in force until L2 takes force');
    await expectFail(() => w.launchFromBatch({ batch: S.parseLaunchBatchFile(F1), cityId: BAD.cityId, founder: BAD.founder, label: 'BAD launches from batch 1 after the correction' }), 'BatchCleared', 'BatchSuperseded');
    c = await cli(['confirm', '2', L2.root, '--rpc', rpc.url, '--archive', sc.archive, '--program-id', String(w.programId)], sc.env);
    assert.equal(c.code, 0, c.out);
    w.warpTo(w.launchBatch().latest.validFrom);
    await w.launchFromBatch({ batch: S.parseLaunchBatchFile(L2), cityId: A.cityId, founder: A.founder, label: 'A launches from the corrected batch' });
    await expectFail(() => w.launchFromBatch({ batch: S.parseLaunchBatchFile(F1), cityId: BAD.cityId, founder: BAD.founder, label: 'BAD, at L2\'s valid_from' }), 'BatchCleared', 'BatchSuperseded');
    assert.ok(!existsSync(sc.env.VICINITY_BATCH_ARCHIVE), 'no run wrote to the default archive');
  } finally {
    await rpc.close();
    sc.done();
  }
  await w.finish();
});

test('R8-DIFF-1 (review round 8) two RPCs must agree on every account, the clock and the pending approvals: a liar that only moves the clock past a thief\'s batch, hides a pending approval holding a ticker, or hides a listed city\'s coin no longer passes; with two honest RPCs the alarm stands', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 5; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const sc = scratch();
  const lb = String(w.P.launchBatch());
  let fakeNow = null;
  const honest = await rpcStub(w);
  const honest2 = await rpcStub(w, { host: '127.0.0.3' });
  // the liar: the Clock sysvar (and getBlockTime) at fakeNow; everything else as the chain has it
  const liar = await rpcStub(w, {
    host: '127.0.0.2',
    lie: (addr, a) => { if (addr !== CLOCK_SYSVAR || !a || fakeNow === null) return a; const d = Buffer.from(a.data); d.writeBigInt64LE(fakeNow, 32); return { ...a, data: d }; },
    rpc: (m) => (m.method === 'getBlockTime' && fakeNow !== null ? Number(fakeNow) : undefined),
  });
  let hide = null; // a lying RPC that hides an account or the pending approvals
  const hider = await rpcStub(w, {
    host: '127.0.0.4',
    lie: (addr, a) => (hide && addr === hide ? null : a),
    rpc: (m) => (m.method === 'getProgramAccounts' && hide === 'approvals' ? [] : undefined),
  });
  const verify = (name, file, rpcs) => cli(['verify', sc.put(name, file), ...rpcs.flatMap((r) => ['--rpc', r.url]), '--approver', String(approver.address), '--program-id', String(w.programId), '--archive', sc.archive], sc.env);
  try {
    const A = { cityId: 9701n, founder: fs[0], symbol: 'DA' }; const B = { cityId: 9702n, founder: fs[1], symbol: 'DB' };
    const EVIL = { cityId: 9799n, founder: mallory, symbol: 'DEVIL' };
    // a first use: a pending per-city approval of city 9710 holds DTICK, and city 9711 has its coin. A list naming another
    // city with DTICK, or naming 9711, is refused through honest RPCs; a liar first hid either (before round 8 the
    // approvals and the city accounts came from the first --rpc alone)
    await w.approve({ cityId: 9710n, founder: fs[3], symbol: 'DTICK', ttl: 3n * 86_400n });
    await w.launchCoin({ cityId: 9711n, founder: fs[4], symbol: 'DCOIN' });
    const tick = listFile(w, [A, { cityId: 9712n, founder: fs[2], symbol: 'DTICK' }], 1n);
    let c = await verify('tick.json', tick, [honest, honest2]);
    assert.equal(c.code, 1, c.out); assert.match(c.out, /ticker DTICK is held by city 9710/);
    hide = 'approvals';
    c = await verify('tick.json', tick, [hider, honest]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM RPC_DISAGREE: the RPCs return different pending per-city approvals \(0 and 1 accounts\)/);
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    const coin = listFile(w, [A, { cityId: 9711n, founder: fs[4], symbol: 'DCOIN2' }], 1n);
    hide = String(w.P.coin(9711n));
    c = await verify('coin.json', coin, [hider, honest]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, new RegExp(`PROBLEM RPC_DISAGREE: the RPCs return different accounts \\(${hide}\\)`));
    hide = null;

    // the review's case: batch 1 verified, signed, confirmed, in force; a thief with the approver key publishes batch 2
    // (A, B, EVIL), nobody confirms it, it takes force; 30 hours into its window the owner verifies batch 3
    await publishConfirmed(w, approver, sc, ['--rpc', honest.url, '--rpc', honest2.url], 'd1.json', listFile(w, [A, B], 1n));
    w.warpTo(w.launchBatch().latest.validFrom);
    const thief = await w.publishBatch([A, B, EVIL], { label: 'the thief\'s batch 2' });
    w.warpTo(thief.validFrom + 30n * 3_600n);
    const F3 = listFile(w, [A, B, { cityId: 9703n, founder: fs[2], symbol: 'DC' }], 3n);
    c = await verify('d3.json', F3, [honest, honest2]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM LATEST_NOT_ARCHIVED: the stored batch \(in force\), batch 2 .* a publication nobody prepared here; have a guardian member clear it with halt now/);
    // the liar answers the same Launchpad and LaunchBatch but a clock past batch 2's end: before round 8 the alarm became
    // the warning "it is expired and can let nobody launch", and a transaction was printed
    fakeNow = thief.validUntil + 1n;
    c = await verify('d3.json', F3, [liar, honest2]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM RPC_CLOCK_DISAGREE: the RPCs' clocks \(the Clock sysvar\) are \d+ seconds apart/);
    assert.doesNotMatch(c.out, /LATEST_ENDED|unsigned publish_launch_batch/);
    // a clock within the tolerance is accepted, and the earlier one is used
    fakeNow = w.now() - 30n;
    c = await verify('d3.json', F3, [liar, honest2]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM LATEST_NOT_ARCHIVED/);
    // the comparison itself: accounts, and clocks within CLOCK_TOLERANCE_SECS
    const clockAt = (t) => { const a = w.accountInfo(CLOCK_SYSVAR); const d = Buffer.from(a.data); d.writeBigInt64LE(t, 32); return { ...a, data: d }; };
    const view = (t, lbAcc = w.accountInfo(lb)) => ({ [lb]: lbAcc, [CLOCK_SYSVAR]: clockAt(t) });
    assert.deepEqual(compareChainViews([view(1000n), view(1060n)], [lb]).problems, []);
    assert.equal(compareChainViews([view(1060n), view(1000n)], [lb]).now, 1000n);
    assert.deepEqual(codes(compareChainViews([view(1000n), view(1061n)], [lb]).problems), ['RPC_CLOCK_DISAGREE']);
    assert.deepEqual(codes(compareChainViews([view(1000n), view(1000n, null)], [lb]).problems), ['RPC_DISAGREE']);
    assert.deepEqual(codes(compareChainViews([{ [lb]: w.accountInfo(lb) }], [lb]).problems), ['NO_CLOCK']);
  } finally {
    await honest.close(); await honest2.close(); await liar.close(); await hider.close();
    sc.done();
  }
  await w.finish();
});

test('R8-DIFF-2 (review round 8) the website\'s transaction carries only the default window, and confirm (and the alarm) compare the transaction that wrote a record with the one the owner verified: a refused list republished by a thief with the verified window is never confirmed, and the alarm no longer tells the owner to confirm it', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 4; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const sc = scratch();
  const rpc = await rpcStub(w); const rpc2 = await rpcStub(w, { host: '127.0.0.2' });
  const rpcs = ['--rpc', rpc.url, '--rpc', rpc2.url];
  const args = [...rpcs, '--approver', String(approver.address), '--program-id', String(w.programId), '--archive', sc.archive];
  const confirm = (seq, root) => cli(['confirm', String(seq), root, ...rpcs, '--archive', sc.archive, '--program-id', String(w.programId)], sc.env);
  try {
    const A = { cityId: 9801n, founder: fs[0], symbol: 'EA' }; const B = { cityId: 9802n, founder: fs[1], symbol: 'EB' };
    const C = { cityId: 9803n, founder: fs[2], symbol: 'EC' }; const EVIL = { cityId: 9899n, founder: mallory, symbol: 'EEVIL' };
    const c1 = await publishConfirmed(w, approver, sc, rpcs, 'e1.json', listFile(w, [A, B], 1n));
    w.warpTo(w.launchBatch().latest.validFrom);
    const X = listFile(w, [A, B, C, EVIL], 2n);
    const publishX = (win) => w.ix.publishLaunchBatch({ approver: approver.address, seq: 2n, root: Buffer.from(X.root, 'hex'), leafCount: X.leafCount, ...win });
    // the review's window, chosen by the page: from now + 47 h for 48 h. Before round 8 it was accepted and kept as pending
    const far = { validFrom: w.now() + 47n * 3_600n, validUntil: w.now() + 95n * 3_600n };
    let c = await cli(['verify', sc.put('x.json', X), ...args, '--tx', pageTxOf([publishX(far)], approver.address, w.programId)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM TX_WINDOW_NOT_DEFAULT: the website's transaction takes force at \S+ for 48 hours; only the default window is accepted/);
    assert.doesNotMatch(c.out, /kept as pending/);
    // the page's default window passes; the owner sees + EEVIL and refuses (signs nothing)
    const win = S.defaultPublishWindow(w.now());
    const page = pageTxOf([publishX(win)], approver.address, w.svm.latestBlockhash());
    c = await cli(['verify', sc.put('x.json', X), ...args, '--tx', page], sc.env);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /\+ city 9899 EEVIL/);
    const verifiedHash = /message hash (\S+):/.exec(c.out)[1];
    // minutes later the thief publishes the refused list with exactly that window, in his own transaction (another blockhash)
    w.warpSecs(300);
    await w.send([publishX(win)], [approver], 'the thief republishes X with the verified window', { feePayer: approver });
    const Z = listFile(w, [A, B, C], 3n);
    c = await cli(['verify', sc.put('z.json', Z), ...args], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM LATEST_NOT_ARCHIVED: .* it has the list, window and signer of a list you verified .* but the transaction that wrote it is another one \(message hash \S+\): a republication by someone holding the approver key/);
    assert.doesNotMatch(c.out, /run: node scripts\/vcurve\/batch\.mjs confirm/, 'no confirm is suggested for a transaction he did not verify');
    // before round 8 this confirm exited 0 and made X the next baseline
    c = await confirm(2, X.root);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, new RegExp(`PROBLEM NOT_YOUR_TRANSACTION: batch 2 was written by the transaction with message hash \\S+, not the one you verified \\(${verifiedHash}\\)`));
    assert.ok(!existsSync(join(sc.archive, String(w.programId), 'signed', `2-${X.root}.json`)), 'X is no baseline');
    // the owner's own publication of batch 1 was confirmed by its transaction
    assert.match(c1.out, /^confirmed: .* written by the transaction you verified \(message hash \S+\)/m);
    // the residual: the thief signs the very message the owner verified (the same blockhash, within about a minute):
    // byte for byte the verified transaction, which only the owner can say he refused; the alarm says so
    await w.send([w.ix.clearLaunchBatch({ authority: w.guardian.address, halt: false })], [w.guardian], 'a guardian member clears X');
    const X3 = listFile(w, [A, B, C, EVIL], 3n);
    const page3 = pageTxOf([w.ix.publishLaunchBatch({ approver: approver.address, seq: 3n, root: Buffer.from(X3.root, 'hex'), leafCount: X3.leafCount, ...S.defaultPublishWindow(w.now()) })], approver.address, w.svm.latestBlockhash());
    c = await cli(['verify', sc.put('x3.json', X3), ...args, '--tx', page3], sc.env);
    assert.equal(c.code, 0, c.out);
    await w.sendWire(Buffer.from(page3, 'base64'), 'the thief signs the page\'s own message with the stolen key', { signers: [approver] });
    c = await cli(['verify', sc.put('z4.json', listFile(w, [A, B, C], 4n)), ...args], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /the transaction that wrote it is byte for byte the one you verified, .* If you refused it, whoever holds the approver key signed that same message: have a guardian member clear it with halt now/);
  } finally {
    await rpc.close(); await rpc2.close();
    sc.done();
  }
  await w.finish();
});

test('R8-DIFF-4 (review round 8) check reads every --rpc and stops when they disagree; two URLs of one provider (a trailing slash, another key or subdomain) are one provider', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 2; i++) fs.push(await w.signer(20n));
  const sc = scratch();
  const L = listFile(w, [{ cityId: 9901n, founder: fs[0], symbol: 'FA' }, { cityId: 9902n, founder: fs[1], symbol: 'FB' }], 1n);
  // the approver key publishes a junk root; the liar serves the list's root
  await w.publishBatch([{ cityId: 9901n, founder: fs[0], symbol: 'FA' }], { root: new Uint8Array(32).fill(3), leafCount: 2 });
  const lbAddr = String(w.P.launchBatch());
  const honest = await rpcStub(w);
  const liar = await rpcStub(w, { host: '127.0.0.2', lie: (addr, a) => { if (addr !== lbAddr || !a) return a; const d = Buffer.from(a.data); Buffer.from(L.root, 'hex').copy(d, 18); return { ...a, data: d }; } });
  try {
    let c = await cli(['check', sc.put('l.json', L), '--rpc', honest.url, '--program-id', String(w.programId)], sc.env);
    assert.equal(c.code, 1, c.out); assert.match(c.out, /PROBLEM ROOT/);
    // before round 8: "the stored batch is the list", exit 0, and the honest RPC received no call
    const before = honest.calls.length;
    c = await cli(['check', sc.put('l.json', L), '--rpc', liar.url, '--rpc', honest.url, '--program-id', String(w.programId)], sc.env);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM RPC_DISAGREE/);
    assert.ok(honest.calls.length > before, 'the second RPC is read');
  } finally { await honest.close(); await liar.close(); sc.done(); }
  // one provider: by IP address, or by the last two labels of the host name
  const K = String(approver.address);
  for (const [x, y] of [['https://x.example', 'https://x.example/'], ['https://x.example', 'https://X.EXAMPLE.:443/path'], ['https://mainnet.helius-rpc.com/?api-key=a', 'https://rpc.helius-rpc.com/?api-key=b'], ['http://127.0.0.1:8899', 'http://127.0.0.1:9000']]) {
    assert.match(parseArgs(['verify', 'l.json', '--rpc', x, '--rpc', y, '--approver', K]).error, /two different providers/, `${x} and ${y}`);
    assert.match(parseArgs(['check', 'l.json', '--rpc', x, '--rpc', y]).error, /two different providers/);
  }
  assert.deepEqual(parseArgs(['check', 'l.json', '--rpc', 'https://api.mainnet-beta.solana.com', '--rpc', 'https://mainnet.helius-rpc.com/?api-key=a']).rpc.length, 2);
  assert.match(parseArgs(['check', 'l.json', '--rpc', 'wss://x.example']).error, /not an http or https URL/);
  assert.deepEqual([rpcProvider('https://a.b.c.example.com/x'), rpcProvider('http://10.0.0.1:80'), rpcProvider('http://[::1]:8899')], ['example.com', '10.0.0.1', '::1']);
  assert.equal(rpcUrlsProblem(['https://a.example', 'https://b.example', 'https://c.example']), '--rpc once, or twice with two different providers');
  await w.finish();
});

test('R8-DIFF-5 (review round 8) the archive\'s MAC key lives in ~/.vicinity-curve, never in an archive folder: a folder handed over with its own key and entries proves nothing; a key that is not 32 bytes is refused; every run names the folder and the key, and warns when the folder is not the one used last', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 3; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const sc = scratch();
  const rpc = await rpcStub(w); const rpc2 = await rpcStub(w, { host: '127.0.0.2' });
  const run = (file, more = [], env = sc.env) => cli(['verify', sc.put('l.json', file), '--rpc', rpc.url, '--rpc', rpc2.url, '--approver', String(approver.address), '--program-id', String(w.programId), ...more], env);
  try {
    const A = { cityId: 9951n, founder: fs[0], symbol: 'GA' }; const B = { cityId: 9952n, founder: fs[1], symbol: 'GB' };
    const EVIL = { cityId: 9999n, founder: mallory, symbol: 'GEVIL' };
    // the thief's batch 1 (A, B, EVIL) is in force
    const thief = await w.publishBatch([A, B, EVIL], { label: 'the thief\'s batch 1' });
    w.warpTo(thief.validFrom);
    const next = listFile(w, [A, B, { cityId: 9953n, founder: fs[2], symbol: 'GC' }], 2n);
    // an archive folder handed over whole, its entries MAC'd under the key inside it (round 7's layout): before round 8
    // its entry was the baseline and EVIL vanished from the changes ("1 added")
    const handed = join(sc.dir, 'handed');
    writeArchiveEntry(handed, 'signed', `1-${hex(thief.root)}.json`, archiveEntry({ kind: 'signed', file: S.launchBatchFile(thief), record: w.launchBatch().latest }), { keyPath: join(handed, 'archive.key') });
    const own = await run(next, ['--archive', join(sc.dir, 'own')]);
    assert.equal(own.code, 1, own.out); // the owner's own (empty) archive: a first use, which needs --previous
    let c;
    for (const how of [['--archive', handed], []]) {
      mkdirSync(join(sc.env.HOME, '.vicinity-curve'), { recursive: true });
      writeFileSync(join(sc.env.HOME, '.vicinity-curve', 'last-archive'), join(sc.dir, 'own')); // the owner's own folder was used last
      c = await run(next, how, { ...sc.env, VICINITY_BATCH_ARCHIVE: handed });
      assert.equal(c.code, 1, c.out);
      assert.match(c.out, /warning ARCHIVE_MOVED: this archive folder is not the one this computer used last/);
      assert.match(c.out, /warning ARCHIVE_IGNORED: signed\/1-[0-9a-f]{64}\.json: not written with this computer's archive key/);
      assert.match(c.out, /PROBLEM NO_PREVIOUS/);
      assert.doesNotMatch(c.out, /changes against the stored batch 1 \(its list from the archive\)/);
    }
    assert.match(own.out, new RegExp(`^archive ${join(sc.dir, 'own')} \\(key ${join(sc.env.HOME, '.vicinity-curve', 'archive.key')}, not created yet`, 'm'));
    // the function: the handed folder's entries count only under its own key, never under this computer's
    assert.equal(readArchive(handed, String(w.programId), { keyPath: join(handed, 'archive.key') }).signed.length, 1);
    assert.equal(readArchive(handed, String(w.programId), { keyPath: join(sc.dir, 'mine.key') }).signed.length, 0);
    // a key file that is not 32 bytes of hex: before round 8 an empty or odd key decoded to 0 or 1 bytes, and an entry
    // MAC'd under it was a baseline. Now the run stops
    const keyFile = join(sc.env.HOME, '.vicinity-curve', 'archive.key');
    const emptyMac = (entry) => createHmac('sha256', Buffer.alloc(0)).update(JSON.stringify(entry)).digest('hex');
    const forged = archiveEntry({ kind: 'signed', file: S.launchBatchFile(thief), record: w.launchBatch().latest });
    const bad = join(sc.dir, 'bad');
    mkdirSync(join(bad, String(w.programId), 'signed'), { recursive: true });
    writeFileSync(join(bad, String(w.programId), 'signed', 'x.json'), JSON.stringify({ ...forged, mac: emptyMac(forged) }));
    for (const text of ['', 'not hex at all', 'abc', 'ab'.repeat(31)]) {
      writeFileSync(keyFile, text); writeFileSync(join(bad, 'archive.key'), text);
      c = await run(next, ['--archive', bad]);
      assert.equal(c.code, 1, c.out);
      assert.match(c.out, /PROBLEM ARCHIVE_KEY: the archive key .* is not 32 bytes of hex/);
      assert.doesNotMatch(c.out, /changes against the stored batch 1|unsigned publish_launch_batch/);
      assert.throws(() => archiveKey({ path: keyFile }), /not 32 bytes of hex/);
    }
    // a good key: created once, atomically, never replaced; its fingerprint printed
    rmSync(keyFile);
    const k1 = archiveKey({ create: true, path: keyFile });
    assert.equal(k1.length, 32);
    assert.ok(archiveKey({ create: true, path: keyFile }).equals(k1), 'an existing key is never replaced');
    assert.deepEqual(readdirSync(join(sc.env.HOME, '.vicinity-curve')).sort(), ['archive.key', 'last-archive'], 'no temporary file is left');
    c = await run(next, ['--archive', bad]);
    assert.match(c.out, /^archive \S+ \(key \S+, fingerprint [0-9a-f]{16}\)$/m);
    assert.match(c.out, /warning ARCHIVE_IGNORED: signed\/x\.json/);
  } finally {
    await rpc.close(); await rpc2.close();
    sc.done();
  }
  await w.finish();
});

test('R8-DIFF-6 (review round 8) an approver that is not a wallet key (a Squads vault, O32 (a)) is refused by the verifier, which cannot build a transaction it signs or check a publication made through Squads', async () => {
  const w = await World.create();
  await w.initBatchPath();
  const fs = []; for (let i = 0; i < 2; i++) fs.push(await w.signer(20n));
  const vaultApprover = S.findPda([Buffer.from('an approver multisig vault')], 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf')[0];
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: vaultApprover })], [w.admin], 'set_launch_approver(a program address)');
  const L = listFile(w, [{ cityId: 9961n, founder: fs[0], symbol: 'HA' }, { cityId: 9962n, founder: fs[1], symbol: 'HB' }], 1n);
  // before round 8: no problem, and a publication whose fee payer could never sign
  const r = verifyListFile({ file: L, accounts: snapshot(w, L.entries), approvals: approvalsOf(w), approver: vaultApprover, now: w.now(), programId: w.programId, chainConfirmed: true });
  assert.deepEqual([codes(r.problems), r.publish], [['APPROVER_NOT_WALLET_KEY'], null]);
  assert.match(r.problems[0].message, /cannot check a publication made through Squads/);
  await w.finish();
});

test('R8-NEW-1 (verification of round 8) a trade landing between the two RPCs\' reads rewrites a coin the verifier reads (a city of the batch in force, launched and trading): the coins are compared only in whether they exist and their owner, so the daily verify, a first use and check run while yesterday\'s coins trade; a hidden coin is still RPC_DISAGREE', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 4; i++) fs.push(await w.signer(20n));
  const trader = await w.signer(50n);
  const sc = scratch();
  const A = { cityId: 9971n, founder: fs[0], symbol: 'TA' }; const B = { cityId: 9972n, founder: fs[1], symbol: 'TB' };
  const C = { cityId: 9973n, founder: fs[2], symbol: 'TC' };
  const coinA = String(w.P.coin(A.cityId));
  // the second RPC, asked for coin A while a trade is armed, waits until the first has served coin A, lets a buy land,
  // then answers: two honest RPCs, a slot apart, around a trade
  let armed = false; let armedFirst = false; let served = null; let firstServed = () => {}; let seenFirst = null; let trades = 0; let hA = null; let hideCoin = false;
  const arm = () => { armed = true; armedFirst = true; served = new Promise((ok) => { firstServed = ok; }); };
  const first = await rpcStub(w, { lie: (addr, a) => { if (armedFirst && addr === coinA && a) { armedFirst = false; seenFirst = Buffer.from(a.data); firstServed(); } return a; } });
  const second = await rpcStub(w, {
    host: '127.0.0.2',
    lie: (addr, a) => (hideCoin && addr === coinA ? null : a),
    before: async (m) => {
      if (!armed || m.method !== 'getMultipleAccounts' || !m.params[0].includes(coinA)) return;
      armed = false;
      await served;
      await w.buy(trader, hA, 250_000_000n, { label: 'a trade between the two RPCs\' reads' });
      trades++;
    },
  });
  const rpcs = ['--rpc', first.url, '--rpc', second.url];
  const verify = (name, file, more = [], s = sc) => cli(['verify', s.put(name, file), ...rpcs, '--approver', String(approver.address), '--program-id', String(w.programId), '--archive', s.archive, ...more], s.env);
  const traded = () => { assert.equal(trades, 1, 'the trade landed between the reads'); assert.ok(!seenFirst.equals(Buffer.from(w.accountInfo(coinA).data)), 'the two RPCs served coin A with different bytes'); trades = 0; };
  const sc2 = scratch();
  try {
    // day 1: batch 1 (A, B) verified, signed, confirmed; at its valid_from A launches and trades
    const F1 = listFile(w, [A, B], 1n);
    await publishConfirmed(w, approver, sc, rpcs, 'r1.json', F1);
    w.warpTo(w.launchBatch().latest.validFrom);
    hA = await w.launchFromBatch({ batch: S.parseLaunchBatchFile(F1), cityId: A.cityId, founder: fs[0], label: 'A launches from batch 1' });
    await w.buy(trader, hA, 500_000_000n, { label: 'A trades' });
    // day 2: batch 2 (B, C). The verifier reads coin A (a city of the batch in force, which may hold a ticker); a buy
    // lands between the first RPC's read and the second's. Before the fix: RPC_DISAGREE naming coin A, no transaction
    const F2 = listFile(w, [B, C], 2n);
    arm();
    let c = await verify('r2.json', F2);
    traded();
    assert.equal(c.code, 0, c.out);
    assert.doesNotMatch(c.out, /RPC_DISAGREE/);
    assert.match(c.out, /unsigned publish_launch_batch/);
    // a first use on another computer: batch 1 from --previous, read from both RPCs, with a trade between the reads
    arm();
    c = await verify('r2.json', F2, ['--previous', sc2.put('r1.json', F1)], sc2);
    traded();
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /unsigned publish_launch_batch/);
    // the monitor's check of batch 1 reads coin A too
    arm();
    c = await cli(['check', sc.put('r1.json', F1), ...rpcs, '--program-id', String(w.programId)], sc.env);
    traded();
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /the stored batch is the list \(both RPCs agree\)/);
    // the coin's existence is still compared: an RPC hiding coin A stops the run (R8-DIFF-1)
    hideCoin = true;
    c = await verify('r2.json', F2);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, new RegExp(`PROBLEM RPC_DISAGREE: the RPCs return different accounts \\(${coinA}\\)`));
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    hideCoin = false;
    // the comparison itself: the coins (and the old program's) by existence and owner; every other account byte for byte
    const Ad = batchAddresses(F2.entries.concat(F1.entries), { programId: w.programId });
    const loose = presenceOnlyAddresses(Ad);
    assert.deepEqual(new Set(loose), new Set([A, B, C].flatMap((e) => [String(w.P.coin(e.cityId)), String(w.P.legacyCoin(e.cityId))])));
    const clock = w.accountInfo(CLOCK_SYSVAR);
    const lp = String(w.P.launchpad());
    const legacyA = String(w.P.legacyCoin(A.cityId));
    const coinNow = w.accountInfo(coinA);
    const flip = (a) => { const d = Buffer.from(a.data); d[d.length - 100] ^= 1; return { ...a, data: d }; };
    const fakeLegacy = { owner: String(S.CLUSTERS.mainnet.legacyProgram), lamports: 1n, data: Buffer.alloc(64, 1) };
    const view = (over = {}) => ({ [CLOCK_SYSVAR]: clock, [lp]: w.accountInfo(lp), [coinA]: coinNow, [legacyA]: fakeLegacy, ...over });
    const cmp = (v) => codes(compareChainViews([view(), v], [lp, coinA, legacyA], { presenceOnly: loose }).problems);
    assert.deepEqual(cmp(view({ [coinA]: flip(coinNow) })), [], 'a coin after a trade');
    assert.deepEqual(cmp(view({ [legacyA]: flip(fakeLegacy) })), [], 'an old program\'s coin after a trade');
    assert.deepEqual(cmp(view({ [coinA]: null })), ['RPC_DISAGREE'], 'a hidden coin');
    assert.deepEqual(cmp(view({ [legacyA]: null })), ['RPC_DISAGREE'], 'a hidden old coin');
    assert.deepEqual(cmp(view({ [coinA]: { ...coinNow, owner: S.ADDRESSES.token } })), ['RPC_DISAGREE'], 'a coin of another owner');
    assert.deepEqual(cmp(view({ [lp]: flip(w.accountInfo(lp)) })), ['RPC_DISAGREE'], 'the Launchpad, byte for byte');
    assert.deepEqual(codes(compareChainViews([view(), view({ [coinA]: flip(coinNow) })], [lp, coinA, legacyA]).problems), ['RPC_DISAGREE'], 'without presenceOnly every account is compared byte for byte');
  } finally {
    await first.close(); await second.close();
    sc.done(); sc2.done();
  }
  await w.finish();
});
