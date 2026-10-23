// The owner's batch verifier and the monitor's check (scripts/vcurve/batch.mjs; VICINITY-CURVE-DESIGN.md 8.4 steps 2
// and 3, 8.6, 14.1; NOTES 76), against the real program in litesvm: a clean list gives the unsigned publication, which
// the approver signs and the program accepts, and the monitor finds the stored batch equal to the list; a list naming a
// city with a coin, a pending approval, a locked ticker, a founder holding a role, a disabled config, a stale number, a
// tampered root or another approver gives problems and no transaction; a junk publication is reported by the monitor.
// Review round 6: the day's changes are computed only against lists the chain holds (R6-DIFF-1, R6-RT-1: a forged
// --previous or --in-force is a problem, a live stored batch needs its list, the owner's archive), the printout shows the
// metadata hash and names the fields that changed (R6-DIFF-2), and a list file with a lost field is refused (MK-1); the
// real CLI is run against a JSON-RPC stub serving the World's accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, S, SOL } from './helpers.mjs';
import { verifyListFile, checkStoredBatch, batchAddresses, allAddresses, parseArgs, changeLines, recordLive } from '../scripts/vcurve/batch.mjs';

const snapshot = (w, entries) => Object.fromEntries(allAddresses(batchAddresses(entries, { programId: w.programId })).map((k) => [k, w.accountInfo(k)]));
const listFile = (w, list, seq) => S.launchBatchFile(S.buildLaunchBatch(w.batchEntries(list), { programId: w.programId, batchSeq: seq }));
const codes = (r) => r.map((x) => x.code);

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
  const verify = (file, o = {}) => verifyListFile({ file, accounts: snapshot(w, JSON.parse(JSON.stringify(file)).entries), approver: approver.address, now: w.now(), programId: w.programId, ...o });

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
  // a tampered root, a stale or skipped number, another signer, another program
  const f = listFile(w, clean, 1n);
  assert.deepEqual(codes(verify({ ...f, root: f.root.replace(/^../, f.root.startsWith('00') ? '11' : '00') }).problems), ['BAD_FILE']);
  assert.deepEqual(codes(verify({ ...f, entries: f.entries.map((e, i) => (i ? e : { ...e, name: 'Other City' })) }).problems), ['BAD_FILE'], 'an entry edited after the root was computed');
  assert.deepEqual(codes(verify(listFile(w, clean, 2n)).problems), ['WRONG_SEQ']);
  assert.deepEqual(codes(verify(f, { approver: fs[0].address }).problems), ['NOT_APPROVER']);
  // the clean list: the changes against nothing, and the unsigned publication
  const r = verify(f);
  assert.deepEqual(r.problems, []);
  assert.equal(r.changes.added.length, 3);
  assert.ok(r.publish && r.publish.seq === 1n && r.publish.leafCount === 3);
  assert.ok(S.publishWindowOk(w.now(), r.publish.validFrom, r.publish.validUntil));
  await w.send([r.publish.instruction], [approver], 'the verifier\'s publication, signed by the approver', { feePayer: approver });
  assert.deepEqual(checkStoredBatch({ file: f, accounts: snapshot(w, f.entries), programId: w.programId }), { problems: [] }, 'the monitor finds the list');
  // the next day's list: one entry removed, one added, one changed; the changes printed for the owner
  const next = listFile(w, [clean[0], { ...clean[1], name: 'Renamed City' }, { cityId: 8108n, founder: fs[2], symbol: 'VFD' }], 2n);
  const r2 = verify(next, { previous: f });
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
  assert.deepEqual(parseArgs(['verify', 'list.json', '--rpc', 'u', '--approver', String(approver.address), '--previous', 'old.json']),
    { mode: 'verify', file: 'list.json', rpc: 'u', approver: String(approver.address), previous: 'old.json' });
  assert.match(parseArgs(['verify', 'list.json', '--rpc', 'u']).error, /needs --approver/);
  assert.match(parseArgs(['publish', 'list.json', '--rpc', 'u']).error, /mode/);
  assert.match(parseArgs(['check', 'list.json', '--rpc', 'u', '--valid-from', '1']).error, /go together/);
  void h;
  await w.finish();
});

const hex = (b) => Buffer.from(b).toString('hex');
const text = (o) => JSON.stringify(o, null, 1);

test('R6-DIFF-1, R6-RT-1 (review round 6) the day\'s changes are computed only against lists the chain holds: a forged --previous (an entry hidden, a founder swapped, a number that never existed) is a problem and no transaction; a live stored batch needs its list (from --previous or the archive); a pending batch shows the changes against the batch in force too; a publication nobody prepared is reported; an ended batch lists every entry as new', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 4; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const verify = (file, o = {}) => verifyListFile({ file, accounts: snapshot(w, file.entries), approver: approver.address, now: w.now(), programId: w.programId, ...o });
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
  w.warpTo(r.publish.validFrom);
  assert.ok(recordLive(w.launchBatch().latest, w.launchpad(), w.now()));

  // day 2: the compromised website adds the attacker's city and hands a self-consistent "previous" that already holds it
  const F2 = listFile(w, [...day1, honestNew, evil], 2n);
  const forged = listFile(w, [...day1, evil], 1n);
  assert.doesNotThrow(() => S.parseLaunchBatchFile(forged), 'the forged file is self-consistent');
  r = verify(F2, { previous: forged });
  assert.deepEqual([codes(r.problems), r.publish], [['PREVIOUS_NOT_ON_CHAIN'], null], 'the forged previous is refused, nothing to sign');
  assert.match(r.problems[0].message, new RegExp(`stored batch 1 \\(root ${hex(w.launchBatch().latest.root)}, 2 entries\\)`));
  // the same with a founder swapped on a carried-over city and a number that never existed (R6-RT-1)
  const swapped = { ...listFile(w, [day1[0], { ...day1[1], founder: mallory }], 41n) };
  r = verify(listFile(w, [day1[0], { ...day1[1], founder: mallory }], 2n), { previous: swapped });
  assert.deepEqual([codes(r.problems), r.publish], [['PREVIOUS_NOT_ON_CHAIN'], null]);
  // no list for the live stored batch: a problem, not "every entry added"
  r = verify(F2);
  assert.deepEqual([codes(r.problems), r.changes, r.publish], [['NO_PREVIOUS'], null, null]);
  // the real list of batch 1: the attacker's city shows as added
  r = verify(F2, { previous: F1 });
  assert.deepEqual([r.problems, r.baseline, r.changes.added.map((e) => e.cityId)], [[], { seq: 1n, source: '--previous' }, [8103n, 8199n]]);
  assert.ok(changeLines(r).some((l) => /^ {2}\+ city 8199 EVIL /.test(l)));
  // the owner's archive: the list of batch 1 is found there, no file from the website is needed
  r = verify(F2, { archive: [F1] });
  assert.deepEqual([r.problems, r.baseline, r.changes.added.map((e) => e.cityId)], [[], { seq: 1n, source: 'the archive' }, [8103n, 8199n]]);
  // an archive that does not hold the live stored batch: a problem even with a --previous that matches the chain
  r = verify(F2, { archive: [forged], previous: F1 });
  assert.deepEqual(codes(r.problems), ['LATEST_NOT_ARCHIVED']);

  // batch 2 published (pending; batch 1 stays in force); a correction (batch 3) replaces it: the changes against batch 2
  // and against batch 1 in force are both shown, each list anchored to its record
  const p2 = verify(F2, { previous: F1 }).publish;
  await w.send([p2.instruction], [approver], 'day 2: batch 2', { feePayer: approver });
  const F3 = listFile(w, [...day1, honestNew], 3n);
  r = verify(F3, { previous: F2 });
  assert.deepEqual([codes(r.problems), r.publish], [['NO_IN_FORCE'], null], 'the batch in force needs its list too');
  r = verify(F3, { previous: F2, inForce: forged });
  assert.deepEqual(codes(r.problems), ['IN_FORCE_NOT_ON_CHAIN']);
  r = verify(F3, { previous: F2, inForce: F1 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual([r.changes.removed.map((e) => e.cityId), r.changesInForce.seq, r.changesInForce.changes.added.map((e) => e.cityId)], [[8199n], 1n, [8103n]]);
  r = verify(F3, { archive: [F1, F2] });
  assert.deepEqual([r.problems, r.baseline.source, r.changesInForce.source], [[], 'the archive', 'the archive']);
  assert.deepEqual(codes(verify(F3, { previous: F2, inForce: F2 }).problems), ['IN_FORCE_NOT_ON_CHAIN'], 'the pending list is not the batch in force');

  // a publication nobody prepared (the approver key stolen) replaces batch 2 and begins: the owner's next verify refuses,
  // whether he passes his own last list or relies on the archive
  const thief = await w.publishBatch([evil], { leadSecs: 12n * 3_600n + 60n, label: 'a publication nobody prepared' });
  w.warpTo(thief.validFrom);
  const F4 = listFile(w, [...day1, honestNew], 4n);
  assert.deepEqual(codes(verify(F4, { previous: F2 }).problems), ['PREVIOUS_NOT_ON_CHAIN']);
  assert.deepEqual(codes(verify(F4, { archive: [F1, F2] }).problems).sort(), ['LATEST_NOT_ARCHIVED', 'NO_PREVIOUS']);
  // the guardian clears it: nothing can launch from the stored records, every entry of the next list is a new approval
  await w.send([w.ix.clearLaunchBatch({ authority: w.guardian.address, halt: false })], [w.guardian], 'the guardian clears');
  assert.ok(!recordLive(w.launchBatch().latest, w.launchpad(), w.now()));
  r = verify(F4, { archive: [F1, F2] });
  assert.deepEqual([r.problems, codes(r.warnings).sort(), r.baseline, r.changes.added.length], [[], ['LATEST_ENDED', 'LATEST_NOT_ARCHIVED'], null, 3]);
  r = verify(F4, { previous: S.launchBatchFile(thief) });
  assert.deepEqual([r.problems, r.ended.seq, r.ended.why, r.ended.changes.removed.map((e) => e.cityId), r.changes.added.length], [[], 3n, 'cleared', [8199n], 3]);
  assert.ok(changeLines(r).some((l) => /^for reference, changes against the cleared batch 3/.test(l)));
  assert.deepEqual(codes(verify(F4, { previous: F2 }).problems), ['PREVIOUS_NOT_ON_CHAIN'], 'an ended record still anchors --previous');
  assert.deepEqual(codes(verify(F4, { inForce: F1 }).problems), ['IN_FORCE_NOT_ON_CHAIN']);
  // the CLI's new options
  assert.deepEqual(parseArgs(['verify', 'l.json', '--rpc', 'u', '--approver', String(approver.address), '--in-force', 'f.json', '--archive', 'd']),
    { mode: 'verify', file: 'l.json', rpc: 'u', approver: String(approver.address), inForce: 'f.json', archive: 'd' });
  assert.equal(parseArgs(['verify', 'l.json', '--rpc', 'u', '--approver', String(approver.address), '--no-archive']).noArchive, true);
  assert.match(parseArgs(['verify', 'l.json', '--rpc', 'u', '--approver', String(approver.address), '--no-archive', '--archive', 'd']).error, /exclude/);
  assert.match(parseArgs(['check', 'l.json', '--rpc', 'u', '--previous', 'p.json']).error, /check takes no previous/);
  await w.finish();
});

/** A JSON-RPC stub serving the World's accounts and clock: the four methods the CLI calls. */
async function rpcStub(w) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const one = (m) => {
        const slot = Number(w.svm.getClock().slot);
        let result;
        if (m.method === 'getMultipleAccounts') {
          result = { context: { slot }, value: m.params[0].map((k) => {
            const a = w.accountInfo(k);
            return a ? { data: [Buffer.from(a.data).toString('base64'), 'base64'], executable: false, lamports: Number(a.lamports), owner: String(a.owner), rentEpoch: 0, space: a.data.length } : null;
          }) };
        } else if (m.method === 'getSlot') result = slot;
        else if (m.method === 'getBlockTime') result = Number(w.now());
        else if (m.method === 'getLatestBlockhash') result = { context: { slot }, value: { blockhash: String(w.programId), lastValidBlockHeight: slot + 150 } };
        else return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `stub: ${m.method}` } };
        return { jsonrpc: '2.0', id: m.id, result };
      };
      const m = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m)));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}
/** The real CLI as the owner runs it; returns `{ code, out }`. */
function cli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(SOL, 'scripts', 'vcurve', 'batch.mjs'), ...args], { cwd: SOL });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('R6-DIFF-1, R6-DIFF-2, MK-1 (review round 6) the real CLI: a forged --previous gives a problem and no transaction; the archive keeps each verified list and is the baseline next day; a change of the metadata hash alone prints both hashes and names metaHash; a list file with a lost field is refused', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 3; i++) fs.push(await w.signer(20n));
  const mallory = await w.signer(20n);
  const dir = mkdtempSync(join(tmpdir(), 'vcurve-r6-'));
  const archive = join(dir, 'archive');
  const put = (name, o) => { const f = join(dir, name); writeFileSync(f, typeof o === 'string' ? o : text(o)); return f; };
  const rpc = await rpcStub(w);
  const base = ['--rpc', rpc.url, '--approver', String(approver.address), '--program-id', String(w.programId)];
  try {
    const day1 = [{ cityId: 8101n, founder: fs[0], symbol: 'VFA' }, { cityId: 8102n, founder: fs[1], symbol: 'VFB' }];
    const F1 = listFile(w, day1, 1n);
    let c = await cli(['verify', put('day1.json', F1), ...base, '--archive', archive]);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /changes against no live batch \(every entry is a new approval\): 2 added, 0 removed, 0 changed/);
    assert.match(c.out, /unsigned publish_launch_batch/);
    assert.deepEqual(readdirSync(join(archive, String(w.programId))), [`1-${F1.root}.json`], 'the verified list is kept in the archive');
    const p1 = verifyListFile({ file: F1, accounts: snapshot(w, F1.entries), approver: approver.address, now: w.now(), programId: w.programId }).publish;
    await w.send([p1.instruction], [approver], 'batch 1', { feePayer: approver });
    w.warpTo(p1.validFrom);

    // day 2: city 8102's metadata hash alone changes, the attacker's city is added; the website's forged previous already holds both
    const swappedMeta = Array(32).fill(0xab);
    const today = [day1[0], { ...day1[1], metaHash: swappedMeta }, { cityId: 8103n, founder: fs[2], symbol: 'VFC' }, { cityId: 8199n, founder: mallory, symbol: 'EVIL' }];
    const F2 = listFile(w, today, 2n);
    const forged = listFile(w, [day1[0], { ...day1[1], metaHash: swappedMeta }, today[3]], 1n);
    c = await cli(['verify', put('day2.json', F2), ...base, '--previous', put('forged.json', forged), '--no-archive']);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM PREVIOUS_NOT_ON_CHAIN: --previous batch 1 \(root [0-9a-f]{64}, 3 entries\) is not the stored batch 1/);
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    assert.match(c.out, /do not sign/);
    c = await cli(['verify', put('day2.json', F2), ...base, '--no-archive']);
    assert.equal(c.code, 1);
    assert.match(c.out, /PROBLEM NO_PREVIOUS/);
    // from the archive (no file from the website): the attacker's city is listed, and the metadata change is visible
    c = await cli(['verify', put('day2.json', F2), ...base, '--archive', archive]);
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
    c = await cli(['verify', put('lost.json', lost), ...base, '--archive', archive]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /PROBLEM BAD_FILE: BatchError::BadFile: entry 0: missing configId, name/);
    assert.doesNotMatch(c.out, /unsigned publish_launch_batch/);
    c = await cli(['check', put('lost.json', lost), '--rpc', rpc.url, '--program-id', String(w.programId)]);
    assert.equal(c.code, 1);
    assert.match(c.out, /PROBLEM BAD_FILE/);
    // and through the exported function: no transaction
    const rv = verifyListFile({ file: lost, accounts: snapshot(w, coerced.entries), approver: approver.address, now: w.now(), programId: w.programId, archive: [F1] });
    assert.deepEqual([codes(rv.problems), rv.publish], [['BAD_FILE'], null]);
  } finally {
    await rpc.close();
    rmSync(dir, { recursive: true, force: true });
  }
  await w.finish();
});
