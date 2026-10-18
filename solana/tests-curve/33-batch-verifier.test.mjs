// The owner's batch verifier and the monitor's check (scripts/vcurve/batch.mjs; VICINITY-CURVE-DESIGN.md 8.4 steps 2
// and 3, 8.6, 14.1; NOTES 76), against the real program in litesvm: a clean list gives the unsigned publication, which
// the approver signs and the program accepts, and the monitor finds the stored batch equal to the list; a list naming a
// city with a coin, a pending approval, a locked ticker, a founder holding a role, a disabled config, a stale number, a
// tampered root or another approver gives problems and no transaction; a junk publication is reported by the monitor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S } from './helpers.mjs';
import { verifyListFile, checkStoredBatch, batchAddresses, allAddresses, parseArgs } from '../scripts/vcurve/batch.mjs';

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
