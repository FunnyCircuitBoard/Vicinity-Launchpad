// The batch launch approval in litesvm (VICINITY-CURVE-DESIGN.md 3.11, 3.12, 4.23 to 4.27, 8.6; L14, X66 to X76,
// C01, C02): the launch approver kept apart from every role both ways; publications refused outside 4.25's rules and
// accepted at each bound; three cities launched from one batch with their first buys; the daily sequence of 8.6 with no
// gap, a pending batch replaced and a superseded one refused; clears by each key, halts and rotation; every launch
// refusal of 4.27 (wrong founder, name, ticker, config, metadata hash, city, batch, window, clear, rotation, pending
// approval, role, pause, halt, a second launch); replay and stolen-key scenarios; the approver signing everything else
// refused; every rule of approve_launch and launch at the batch launch (the old program, the registry, a disabled
// config, city 0); inner nodes and leaves in wrong places of a proof; a publication resent or prepared twice from one
// state; compute units and the worst-case transaction size. Every transaction runs through the checker (I1 to I25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getBase64EncodedWireTransaction } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, expectFail, LAMPORTS, DAY, metaHash } from './helpers.mjs';

const H = 3_600n;
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const pause = (w, who, flags, label) => w.send([w.ix.setPause({ authority: who.address, ...flags })], [who], label);
const clear = (w, who, halt, label = `clear_launch_batch${halt ? ' (halt)' : ''}`) => w.send([w.ix.clearLaunchBatch({ authority: who.address, halt })], [who], label);
const rawPublish = (w, approver, args, label = 'publish (raw)') => w.send([w.ix.publishLaunchBatch({ approver: approver.address, ...args })], [approver], label, { feePayer: approver });

/** An active address lookup table holding `addresses` (as 04-launch builds it). */
function lookupTable(w, addresses, authority, tag) {
  const pk = (a) => Buffer.from(S.toKey(a).toBytes());
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0); meta.writeBigUInt64LE((1n << 64n) - 1n, 4); meta[21] = 1; pk(authority).copy(meta, 22);
  const addr = S.findPda([Buffer.from('batch-alt'), Buffer.from(tag)], ALT_PROGRAM)[0];
  w.setRaw(addr, Buffer.concat([meta, ...addresses.map(pk)]), ALT_PROGRAM);
  return { [addr]: addresses };
}
const statics = (w) => [S.ADDRESSES.system, S.ADDRESSES.token, S.ADDRESSES.associatedToken, S.ADDRESSES.metaplex, S.ADDRESSES.computeBudget,
  S.ADDRESSES.rentSysvar, w.P.eventAuthority(), w.programId, S.ADDRESSES.feeRecipient, w.P.launchpad(), S.CLUSTERS.mainnet.legacyLaunchpad, w.P.config(0),
  S.CLUSTERS.mainnet.rewardsRegistry, w.P.launchBatch()];

test('L14 init_launch_batch once; set_launch_approver and every separation refusal both ways (ApproverHoldsRole, FeeRecipientRole); the approver is never a founder', async () => {
  const w = await World.create();
  const stranger = await w.signer(5n);
  await expectFail(() => w.send([w.ix.initLaunchBatch({ admin: stranger.address, payer: stranger.address })], [stranger], 'init_launch_batch by a stranger'), 'Unauthorized');
  // before the account exists the batch path cannot be configured
  await expectFail(() => w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: stranger.address })], [w.admin], 'set_launch_approver without LaunchBatch'), 'AccountNotInitialized');
  const r = await w.send([w.ix.initLaunchBatch({ admin: w.admin.address, payer: w.payer.address })], [w.admin], 'init_launch_batch');
  assert.deepEqual(r.events.map((e) => e.name), ['LaunchBatchInitialized']);
  const lb0 = w.launchBatch();
  assert.deepEqual([lb0.halted, lb0.latest.seq, lb0.previous.seq], [false, 0n, 0n]);
  assert.equal(w.accountInfo(w.P.launchBatch()).data.length, 260);
  assert.equal(w.launchpad().launchApprover, S.ADDRESSES.system, 'the batch path starts off');
  await expectFail(() => w.send([w.ix.initLaunchBatch({ admin: w.admin.address, payer: w.payer.address })], [w.admin], 'init_launch_batch again'), /already in use/);
  // set_launch_approver: only the admin; never FEE_RECIPIENT, the admin, the pending admin, the guardian, the payout key or wallet
  const approver = await w.signer(5n);
  const setA = (k, label) => w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: k })], [w.admin], label);
  await expectFail(() => w.send([w.ix.setLaunchApprover({ admin: stranger.address, approver: approver.address })], [stranger], 'by a stranger'), 'Unauthorized');
  await expectFail(() => setA(S.ADDRESSES.feeRecipient, 'FEE_RECIPIENT'), 'FeeRecipientRole');
  await expectFail(() => setA(w.admin.address, 'the admin'), 'ApproverHoldsRole');
  await expectFail(() => setA(w.guardian.address, 'the guardian'), 'ApproverHoldsRole');
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  await expectFail(() => setA(payoutKey.address, 'the payout key'), 'ApproverHoldsRole');
  await expectFail(() => setA(wallet.address, 'the payout wallet'), 'ApproverHoldsRole');
  const next = await w.signer(5n);
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose_admin');
  await expectFail(() => setA(next.address, 'the pending admin'), 'ApproverHoldsRole');
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: S.ADDRESSES.system })], [w.admin], 'cancel the proposal');
  const set = await setA(approver.address, 'set_launch_approver');
  assert.deepEqual(set.events[0].data, { old: S.ADDRESSES.system, new: approver.address, latest_seq: 0n });
  assert.equal(w.launchpad().launchApprover, approver.address);
  w.approver = approver;
  // the other direction: no role may be set to the approver
  await expectFail(() => w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: approver.address })], [w.admin], 'guardian = approver'), 'ApproverHoldsRole');
  await expectFail(() => w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: approver.address, payoutDestination: wallet.address })], [w.admin], 'payout key = approver'), 'ApproverHoldsRole');
  await expectFail(() => w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: approver.address })], [w.admin], 'payout wallet = approver'), 'ApproverHoldsRole');
  await expectFail(() => w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: approver.address })], [w.admin], 'proposed admin = approver'), 'ApproverHoldsRole');
  // the founder seat: never the approver (approve_launch, launch, transfer_founder)
  await expectFail(() => w.approve({ cityId: 11n, founder: approver, symbol: 'APPR' }), 'FounderHoldsRole');
  const f = await w.signer(10n);
  await w.approve({ cityId: 12n, founder: f, symbol: 'SEATB' });
  const h = await w.launch({ cityId: 12n, founder: f });
  await expectFail(() => w.send([w.ix.transferFounder({ founder: f.address, newFounder: approver.address, coin: h.coin })], [f, approver], 'transfer_founder to the approver'), 'FounderHoldsRole');
  // a founder approved before his key became the approver cannot launch (launch checks the seat of its moment)
  const g = await w.signer(10n);
  await w.approve({ cityId: 13n, founder: g, symbol: 'LATER' });
  await setA(g.address, 'the approver rotated to an approved founder');
  w.approver = g;
  await expectFail(() => w.launch({ cityId: 13n, founder: g }), 'FounderHoldsRole');
  // zero turns the batch path off
  await setA(S.ADDRESSES.system, 'set_launch_approver(zero)');
  w.approver = null;
  await w.launch({ cityId: 13n, founder: g });
  await w.finish();
});

test('L14, X76 publish_launch_batch: refused before 12 hours, beyond 48 hours of lead or validity, with a zero root, 0 or 513 leaves, a wrong seq, by anyone but the approver, while halted; accepted at each bound', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const f = await w.signer(10n);
  const now = () => w.now();
  const root = Array(32).fill(7);
  const args = (o = {}) => ({ seq: w.launchBatch().latest.seq + 1n, root, leafCount: 3, validFrom: now() + S.BATCH_REVIEW_SECS, validUntil: now() + S.BATCH_REVIEW_SECS + H, ...o });
  await expectFail(() => rawPublish(w, approver, args({ validFrom: now() + S.BATCH_REVIEW_SECS - 1n }), 'one second short of the review window'), 'BadBatchWindow');
  await expectFail(() => rawPublish(w, approver, args({ validFrom: now() + S.BATCH_MAX_LEAD_SECS + 1n, validUntil: now() + S.BATCH_MAX_LEAD_SECS + 2n }), 'a lead beyond 48 hours'), 'BadBatchWindow');
  await expectFail(() => rawPublish(w, approver, args({ validUntil: now() + S.BATCH_REVIEW_SECS + S.BATCH_MAX_VALIDITY_SECS + 1n }), 'a validity beyond 48 hours'), 'BadBatchWindow');
  await expectFail(() => rawPublish(w, approver, args({ validUntil: now() + S.BATCH_REVIEW_SECS }), 'an empty window'), 'BadBatchWindow');
  await expectFail(() => rawPublish(w, approver, args({ validFrom: (1n << 63n) - 1n, validUntil: (1n << 63n) - 1n }), 'i64::MAX'), 'BadBatchWindow');
  await expectFail(() => rawPublish(w, approver, args({ root: Array(32).fill(0) }), 'a zero root'), 'BadBatchRoot');
  await expectFail(() => rawPublish(w, approver, args({ leafCount: 0 }), '0 leaves'), 'BadLeafCount');
  await expectFail(() => rawPublish(w, approver, args({ leafCount: 513 }), '513 leaves'), 'BadLeafCount');
  for (const seq of [0n, 2n, (1n << 64n) - 1n]) await expectFail(() => rawPublish(w, approver, args({ seq }), `seq ${seq}`), 'BatchSeqMismatch');
  for (const who of [w.admin, w.guardian, f, await w.signer(1n)]) await expectFail(() => rawPublish(w, who, args(), 'by another key'), 'Unauthorized');
  // the bounds are accepted: valid_from exactly 12 hours ahead with 48 hours of validity, 512 leaves; then exactly 48 hours ahead
  const p1 = await rawPublish(w, approver, args({ leafCount: 512, validUntil: now() + S.BATCH_REVIEW_SECS + S.BATCH_MAX_VALIDITY_SECS }), 'at the review and validity bounds');
  assert.deepEqual([p1.events[0].data.seq, p1.events[0].data.replaced_seq, p1.events[0].data.previous_seq], [1n, 0n, 0n]);
  const p2 = await rawPublish(w, approver, args({ leafCount: 1, validFrom: now() + S.BATCH_MAX_LEAD_SECS, validUntil: now() + S.BATCH_MAX_LEAD_SECS + 1n }), 'at the lead bound');
  assert.deepEqual([p2.events[0].data.seq, p2.events[0].data.replaced_seq], [2n, 1n], 'a pending batch is replaced');
  assert.equal(w.launchBatch().previous.seq, 0n, 'a replaced batch never becomes previous');
  // the same publication again (a replay) and a second one prepared from the same state: the gap-free seq refuses both
  await expectFail(() => rawPublish(w, approver, { ...args(), seq: 2n }, 'replay of seq 2'), 'BatchSeqMismatch');
  // while halted nothing is published
  await clear(w, w.guardian, true);
  await expectFail(() => rawPublish(w, approver, args(), 'while halted'), 'BatchesHalted');
  await w.finish();
});

test('L14, C01, C02 three cities launched from one batch with their first buys; each Coin holds the leaf\'s founder, config, ticker, name and metadata hash; the worst case (a 9-hash proof, a 32-byte name, a 10-byte ticker) fits one transaction with the lookup table', async () => {
  const w = await World.create();
  await w.initBatchPath();
  const cfg1 = await w.addConfig({ ...S.DEFAULT_CONFIG, launchFeeLamports: 20_000_000n });
  const fs = [await w.signer(100n), await w.signer(100n), await w.signer(100n)];
  const list = [
    { cityId: 2_643_743n, founder: fs[0], name: 'London', symbol: 'LONDON', metaHash: metaHash('london.json') },
    { cityId: 2_988_507n, founder: fs[1], name: 'Paris', symbol: 'PARIS', configId: cfg1, metaHash: metaHash('paris.json') },
    { cityId: 5_128_581n, founder: fs[2], name: 'New York City', symbol: 'NYC', metaHash: metaHash('nyc.json') },
  ];
  const b = await w.publishBatch(list);
  w.warpTo(b.validFrom);
  const tables = lookupTable(w, [...statics(w), w.P.config(cfg1)], w.admin.address, 'three');
  for (const [i, e] of list.entries()) {
    const h = w.handle(e.cityId, fs[i]);
    const fee0 = w.lamportsOf(S.ADDRESSES.feeRecipient);
    const res = await w.send([w.launchFromBatchIx({ batch: b, cityId: e.cityId, founder: fs[i] }), ...w.buyIxs(fs[i], h, LAMPORTS, 0n)], [fs[i]],
      `launch_from_batch + first buy (${e.symbol})`, { cu: 400_000, lookupTables: tables });
    const c = w.coinView(h);
    assert.deepEqual([c.founder, c.symbol, c.configId, [...c.metaHash]], [fs[i].address, e.symbol, e.configId ?? 0, e.metaHash], `${e.symbol}: the leaf's terms`);
    assert.equal(w.lamportsOf(S.ADDRESSES.feeRecipient) - fee0, (e.configId === cfg1 ? 20_000_000n : 50_000_000n), 'the config\'s launch fee');
    assert.ok(res.size <= 1232 && res.cu <= 400_000, `${e.symbol}: ${res.size} bytes, ${res.cu} CU`);
    assert.deepEqual(res.events.slice(0, 2).map((x) => x.name), ['CoinLaunched', 'LaunchedFromBatch']);
    assert.equal(w.approval(e.cityId), null, 'no approval is created or needed');
  }
  // a second launch of a launched city fails at init, by either path and from any batch
  await expectFail(() => w.launchFromBatch({ batch: b, cityId: 2_643_743n, founder: fs[0], label: 'a second batch launch' }), /already in use/);
  // C02 worst case: 512 leaves (a 9-hash proof), a 32-byte name and a 10-byte ticker, with the first buy
  const fw = await w.signer(100n);
  const big = Array.from({ length: 512 }, (_, i) => ({ cityId: 7_000_000n + BigInt(i), founder: i === 300 ? fw : web3.Keypair.generate().publicKey.toBase58(),
    name: `City ${String(i).padStart(27, '0')}`, symbol: `W${i.toString(36).toUpperCase().padStart(9, '0')}` }));
  const bb = await w.publishBatch(big);
  w.warpTo(bb.validFrom);
  const city = 7_000_300n;
  const args = S.launchBatchArgs(bb, city);
  assert.equal(args.proof.length, 9);
  assert.equal(Buffer.byteLength(args.name), 32); assert.equal(args.symbol.length, 10);
  const hw = w.handle(city, fw);
  const ixs = [w.launchFromBatchIx({ batch: bb, cityId: city, founder: fw }), ...w.buyIxs(fw, hw, LAMPORTS, 0n)];
  const plain = await w.buildTx(ixs, [fw], { cu: 400_000 });
  const plainSize = Buffer.from(getBase64EncodedWireTransaction(plain), 'base64').length;
  const res = await w.send(ixs, [fw], 'launch_from_batch (9-hash proof) + first buy, worst case', { cu: 400_000, lookupTables: lookupTable(w, statics(w), w.admin.address, 'worst') });
  assert.ok(res.size <= 1232, `C02 worst case ${res.size} bytes with the lookup table`);
  const lfbCu = res.ixCu.find((x) => x.name === 'launch_from_batch').cu;
  assert.ok(lfbCu <= 250_000, `C01 launch_from_batch ${lfbCu} CU within the 11.1 budget`);
  assert.ok(res.cu <= 400_000);
  w.measurements = { worstSize: res.size, worstSizeWithoutTable: plainSize, worstTxCu: res.cu, worstLaunchCu: lfbCu };
  console.log('C01/C02 batch launch worst case', JSON.stringify(w.measurements));
  await w.finish();
});

test('C01 the proof\'s compute units by length (0 to 9 hashes, the same city, founder and name): the marginal cost per hash, a 13-level proof\'s cost within the budget, and a proof longer than the depth refused before hashing', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const f = await w.signer(50n);
  const city = 4_000_001n;
  const rows = [];
  for (let k = 0; k <= 9; k++) {
    const n = 1 << k;
    const list = Array.from({ length: n }, (_, i) => (i === 0 ? { cityId: city, founder: f, symbol: 'PROOF', name: 'Proof City' }
      : { cityId: 4_100_000n + BigInt(i), founder: web3.Keypair.generate().publicKey.toBase58(), symbol: `P${i.toString(36).toUpperCase()}X` }));
    const b = await w.publishBatch(list, { approver });
    w.warpTo(b.validFrom);
    const args = S.launchBatchArgs(b, city);
    assert.equal(args.proof.length, k);
    const sim = await w.simulate([w.launchFromBatchIx({ batch: b, cityId: city, founder: f })], [f]);
    assert.ok(sim.ok, sim.error);
    const cu = Number(/consumed (\d+) of/.exec(sim.logs.filter((l) => l.startsWith(`Program ${w.programId} consumed`)).pop())[1]);
    rows.push({ hashes: k, cu });
  }
  const perHash = (rows[9].cu - rows[0].cu) / 9;
  const at13 = rows[0].cu + 13 * perHash;
  console.log(`C01 proof cost: ${rows.map((r) => `${r.hashes}:${r.cu}`).join(' ')}; about ${perHash.toFixed(1)} CU per hash; a 13-level proof would take about ${Math.round(at13)} CU`);
  assert.ok(perHash > 0 && perHash < 400, `about ${perHash} CU per sibling (the sol_sha256 syscall)`);
  assert.ok(at13 <= 250_000, `a 13-level proof (${Math.round(at13)} CU) stays inside the 250,000 budget`);
  // the program caps the proof at min(9, depth): 13 hashes against the 512-leaf batch are refused before any hashing
  const b = await w.publishBatch(Array.from({ length: 512 }, (_, i) => ({ cityId: i === 0 ? city : 4_200_000n + BigInt(i), founder: i === 0 ? f : web3.Keypair.generate().publicKey.toBase58(), symbol: i === 0 ? 'PROOF' : `Q${i.toString(36).toUpperCase()}X`, name: i === 0 ? 'Proof City' : 'Demo City' })), { approver });
  w.warpTo(b.validFrom);
  const args = S.launchBatchArgs(b, city);
  const long = [...args.proof, ...args.proof.slice(0, 4)];
  const e = await expectFail(() => w.send([w.launchFromBatchIx({ batch: b, cityId: city, founder: f, edit: { proof: long } })], [f], '13 hashes', { lookupTables: lookupTable(w, statics(w), w.admin.address, 'long') }), 'ProofTooLong');
  const refusedCu = Number(/consumed (\d+) of/.exec(e.logs.filter((l) => l.startsWith(`Program ${w.programId} consumed`)).pop())[1]);
  assert.ok(refusedCu < rows[9].cu, `the refusal (${refusedCu} CU) costs less than a 9-hash verification`);
  // a proof one hash longer than a small batch's depth: refused by length too
  const small = await w.publishBatch([{ cityId: 4_300_001n, founder: f, symbol: 'SMALL' }, { cityId: 4_300_002n, founder: web3.Keypair.generate().publicKey.toBase58(), symbol: 'SMALLB' }], { approver });
  w.warpTo(small.validFrom);
  const sp = S.launchBatchArgs(small, 4_300_001n).proof;
  await expectFail(() => w.launchFromBatch({ batch: small, cityId: 4_300_001n, founder: f, edit: { proof: [...sp, sp[0]] }, label: 'depth + 1' }), 'ProofTooLong');
  await w.launchFromBatch({ batch: small, cityId: 4_300_001n, founder: f });
  await w.finish();
});

test('L14 8.6\'s daily sequence: no gap between batches, a pending batch corrected without interrupting the one in force, the older batch superseded when the newer takes force', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, b, c, d] = [await w.signer(20n), await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const day1 = w.now() - (w.now() % DAY) + DAY; // midnight
  w.warpTo(day1 + 21n * H);
  const b1 = await w.publishBatch([{ cityId: 101n, founder: a, symbol: 'ADAY' }, { cityId: 102n, founder: b, symbol: 'BDAY' }, { cityId: 103n, founder: c, symbol: 'CDAY' }],
    { validFrom: day1 + DAY + 9n * H, validUntil: day1 + DAY + 45n * H });
  w.warpTo(day1 + DAY + 9n * H - 1n);
  await expectFail(() => w.launchFromBatch({ batch: b1, cityId: 101n, founder: a }), 'BatchNotYetValid');
  w.warpTo(day1 + DAY + 9n * H);
  await w.launchFromBatch({ batch: b1, cityId: 101n, founder: a, label: 'batch 1 at its valid_from' });
  // day 2, 21:00: batch 2 (from 09:00 day 3); batch 1 stays in force
  w.warpTo(day1 + DAY + 21n * H);
  const b2 = await w.publishBatch([{ cityId: 102n, founder: b, symbol: 'BDAY' }, { cityId: 104n, founder: d, symbol: 'DDAY' }],
    { validFrom: day1 + 2n * DAY + 9n * H, validUntil: day1 + 2n * DAY + 45n * H });
  assert.equal(w.launchBatch().previous.seq, 1n);
  await w.launchFromBatch({ batch: b1, cityId: 102n, founder: b, label: 'batch 1 while batch 2 is pending' });
  // day 2, 22:00: batch 3 corrects 2 (from 10:00 day 3): 2 is replaced and never takes force
  w.warpTo(day1 + DAY + 22n * H);
  const b3 = await w.publishBatch([{ cityId: 104n, founder: d, symbol: 'DDAY' }, { cityId: 103n, founder: c, symbol: 'CDAY' }],
    { validFrom: day1 + 2n * DAY + 10n * H, validUntil: day1 + 2n * DAY + 46n * H });
  assert.equal(b3.res.events[0].data.replaced_seq, 2n);
  assert.deepEqual([w.launchBatch().previous.seq, w.launchBatch().latest.seq], [1n, 3n]);
  w.warpTo(day1 + 2n * DAY + 9n * H + 1_800n);
  await expectFail(() => w.launchFromBatch({ batch: b2, cityId: 104n, founder: d, label: 'from the replaced batch 2' }), 'BatchSuperseded');
  await expectFail(() => w.launchFromBatch({ batch: b3, cityId: 104n, founder: d, label: 'batch 3 before its valid_from' }), 'BatchNotYetValid');
  // day 3, 10:00: batch 3 in force; batch 1 superseded although not expired
  w.warpTo(day1 + 2n * DAY + 10n * H);
  assert.ok(w.now() <= b1.validUntil);
  await expectFail(() => w.launchFromBatch({ batch: b1, cityId: 103n, founder: c, label: 'batch 1 after batch 3 took force' }), 'BatchSuperseded');
  await w.launchFromBatch({ batch: b3, cityId: 103n, founder: c, label: 'batch 3 in force' });
  await w.launchFromBatch({ batch: b3, cityId: 104n, founder: d });
  // past the end, inclusive: at valid_until it works, a second later it is expired
  const e = await w.signer(20n);
  const b4 = await w.publishBatch([{ cityId: 105n, founder: e, symbol: 'EDAY' }, { cityId: 106n, founder: a, symbol: 'FDAY' }], { leadSecs: S.BATCH_REVIEW_SECS, validitySecs: H });
  w.warpTo(b4.validUntil);
  await w.launchFromBatch({ batch: b4, cityId: 105n, founder: e, label: 'at valid_until' });
  w.warpSecs(1n);
  await expectFail(() => w.launchFromBatch({ batch: b4, cityId: 106n, founder: a, label: 'a second after valid_until' }), 'BatchExpired');
  await w.finish();
});

test('L14 clears by the approver, the admin and the guardian, with and without halt; rotation clears every batch and lifts the halt; nobody else clears', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, b, c] = [await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const list = [{ cityId: 201n, founder: a, symbol: 'CLA' }, { cityId: 202n, founder: b, symbol: 'CLB' }, { cityId: 203n, founder: c, symbol: 'CLC' }];
  let bt = await w.publishBatch(list);
  w.warpTo(bt.validFrom);
  // nobody but the three keys clears
  for (const who of [a, w.keeper, await w.signer(1n)]) await expectFail(() => clear(w, who, false, 'clear by another key'), 'Unauthorized');
  const r = await clear(w, approver, false);
  assert.deepEqual(r.events[0].data, { by: approver.address, latest_seq: 1n, previous_seq: 0n, halted: false });
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 201n, founder: a, label: 'after the approver\'s clear' }), 'BatchCleared');
  // a repeated clear changes nothing and still emits
  assert.equal((await clear(w, w.admin, false, 'repeated clear by the admin')).events.length, 1);
  // a new batch takes force a review window after it is published
  bt = await w.publishBatch(list);
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 201n, founder: a, label: 'the new batch in its review window' }), 'BatchNotYetValid');
  w.warpTo(bt.validFrom);
  await w.launchFromBatch({ batch: bt, cityId: 201n, founder: a });
  // the guardian halts: no launch, no publication, until the admin's set_launch_approver
  await clear(w, w.guardian, true);
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 202n, founder: b, label: 'after a halt' }), 'BatchesHalted');
  await expectFail(() => w.publishBatch(list.slice(1)), 'BatchesHalted');
  // a clear never lifts a halt
  await clear(w, w.admin, false, 'a clear without halt after a halt');
  assert.equal(w.launchBatch().halted, true);
  // the admin's set_launch_approver with the same key (a false alarm): the halt lifted, both batches stay cleared
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: approver.address })], [w.admin], 'lift the halt (same key)');
  assert.deepEqual([w.launchBatch().halted, w.launchBatch().latest.cleared], [false, true]);
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 202n, founder: b, label: 'a batch cleared by the rotation' }), 'BatchCleared');
  bt = await w.publishBatch(list.slice(1));
  w.warpTo(bt.validFrom);
  await w.launchFromBatch({ batch: bt, cityId: 202n, founder: b });
  // rotation to a new key: every batch ends; the old key can no longer publish or clear; numbers continue
  const next = await w.signer(5n);
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: next.address })], [w.admin], 'rotate the approver');
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 203n, founder: c, label: 'a former approver\'s batch (its publisher is no longer the approver: checked before the clear, 4.27)' }), 'BatchSuperseded');
  await expectFail(() => w.publishBatch(list.slice(2), { approver }), 'Unauthorized');
  await expectFail(() => clear(w, approver, true, 'the former approver clears'), 'Unauthorized');
  w.approver = next;
  bt = await w.publishBatch(list.slice(2));
  assert.equal(bt.batchSeq, 4n);
  w.warpTo(bt.validFrom);
  await w.launchFromBatch({ batch: bt, cityId: 203n, founder: c });
  await w.finish();
});

test('X66, X81 forged launches: another signer, name, ticker, config, metadata hash or city than the signed list; a proof of another entry; refused with InvalidProof and nothing moves', async () => {
  const w = await World.create();
  await w.initBatchPath();
  const cfg1 = await w.addConfig({ ...S.DEFAULT_CONFIG, launchFeeLamports: 10_000_000n });
  const [a, b, thief] = [await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const bt = await w.publishBatch([{ cityId: 301n, founder: a, symbol: 'FORGA', name: 'Forge A' }, { cityId: 302n, founder: b, symbol: 'FORGB' }, { cityId: 303n, founder: b, symbol: 'FORGC' }]);
  w.warpTo(bt.validFrom);
  const forged = (label, o) => expectFail(() => w.launchFromBatch({ batch: bt, cityId: 301n, founder: o.founder ?? a, edit: o.edit ?? {}, label }), ...(o.codes ?? ['InvalidProof']));
  await forged('another signer with the founder\'s proof', { founder: thief });
  await forged('another name', { edit: { name: 'Forge AA' } });
  await forged('another ticker', { edit: { symbol: 'FORGX' } });
  await forged('another config', { edit: { configId: cfg1 } });
  await forged('another metadata hash (the JSON at the URI)', { edit: { metaHash: metaHash('other.json') } });
  await forged('another city', { edit: { cityId: 304n } });
  await forged('another batch number', { edit: { batchSeq: 2n }, codes: ['BatchSuperseded'] });
  await forged('another entry\'s proof', { edit: { proof: S.launchBatchProof(bt, 302n) } });
  await forged('an empty proof', { edit: { proof: [] } });
  await forged('a zero metadata hash', { edit: { metaHash: Array(32).fill(0) }, codes: ['BadMetaHash'] });
  await forged('a bad name', { edit: { name: ' Forge A' }, codes: ['BadName'] });
  await forged('a bad ticker', { edit: { symbol: 'forga' }, codes: ['BadSymbol', 'ConstraintSeeds'] });
  // the metadata account (whose address fixes the URI's coin) cannot be substituted
  await expectFail(() => w.send([w.launchFromBatchIx({ batch: bt, cityId: 301n, founder: a, overrides: { metadata: S.metadataAddress(w.P.coinAccounts(302n).mint) } })], [a], 'another metadata account'), 'InvalidAddress');
  await expectFail(() => w.send([w.launchFromBatchIx({ batch: bt, cityId: 301n, founder: a, overrides: { launch_batch: w.P.launchpad() } })], [a], 'Launchpad in the LaunchBatch slot'), 'AccountDiscriminatorMismatch', 'ConstraintSeeds');
  await expectFail(() => w.send([w.launchFromBatchIx({ batch: bt, cityId: 301n, founder: a, overrides: { approval: w.P.approval(302n) } })], [a], 'another city\'s approval PDA'), 'ConstraintSeeds');
  // the real founder with the real entry
  const h = await w.launchFromBatch({ batch: bt, cityId: 301n, founder: a });
  assert.equal(w.coinView(h).founder, a.address);
  await w.finish();
});

test('X68, X83 replay: a leaf of batch N under batch N+1, after N+1 took force, and from another deployment\'s list (the program id is in every leaf)', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, b] = [await w.signer(20n), await w.signer(20n)];
  const list = [{ cityId: 401n, founder: a, symbol: 'REPA' }, { cityId: 402n, founder: b, symbol: 'REPB' }];
  const b1 = await w.publishBatch(list);
  w.warpTo(b1.validFrom);
  const b2 = await w.publishBatch(list);
  // batch 1's leaf and proof presented as batch 2's: another leaf (the number is in it)
  await expectFail(() => w.launchFromBatch({ batch: b1, cityId: 401n, founder: a, edit: { batchSeq: 2n }, label: 'batch 1\'s proof under batch 2' }), 'BatchNotYetValid');
  w.warpTo(b2.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: b1, cityId: 401n, founder: a, edit: { batchSeq: 2n }, label: 'batch 1\'s proof under batch 2 in force' }), 'InvalidProof');
  await expectFail(() => w.launchFromBatch({ batch: b1, cityId: 401n, founder: a, label: 'batch 1 after batch 2 took force' }), 'BatchSuperseded');
  // a list built for another program id (a devnet deployment, a fork) and its root published here: every proof fails
  const other = web3.Keypair.generate().publicKey.toBase58();
  const foreign = S.buildLaunchBatch(w.batchEntries(list), { programId: other, batchSeq: 3n });
  const pub = await rawPublish(w, approver, { seq: 3n, root: foreign.root, leafCount: 2, ...S.defaultPublishWindow(w.now()) }, 'another deployment\'s root');
  assert.equal(pub.events[0].data.seq, 3n);
  w.warpTo(w.launchBatch().latest.validFrom);
  await expectFail(() => w.send([w.ix.launchFromBatch({ ...S.launchBatchArgs(foreign, 401n), founder: a.address })], [a], 'another deployment\'s leaf'), 'InvalidProof');
  // the founder's own list of this program, published again, works
  const b4 = await w.publishBatch(list);
  w.warpTo(b4.validFrom);
  await w.launchFromBatch({ batch: b4, cityId: 401n, founder: a });
  await w.finish();
});

test('X70, X84 a founder removed from the next batch launches until it takes force and is refused after; [clear, publish corrected] stops him at once', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, b, c] = [await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const b1 = await w.publishBatch([{ cityId: 501n, founder: a, symbol: 'STA' }, { cityId: 502n, founder: b, symbol: 'STB' }, { cityId: 503n, founder: c, symbol: 'STC' }]);
  w.warpTo(b1.validFrom);
  // the next batch leaves out city 501's founder
  const b2 = await w.publishBatch([{ cityId: 502n, founder: b, symbol: 'STB' }, { cityId: 503n, founder: c, symbol: 'STC' }]);
  const sim = await w.simulate([w.launchFromBatchIx({ batch: b1, cityId: 501n, founder: a })], [a]);
  assert.ok(sim.ok, 'the removed founder can still launch until the next batch takes force (O33, disclosed)');
  w.warpTo(b2.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: b1, cityId: 501n, founder: a, label: 'removed founder after the next batch took force' }), 'BatchSuperseded');
  // urgent removal while a batch is in force: [clear, publish corrected] in one transaction by the owner
  const corrected = S.buildLaunchBatch(w.batchEntries([{ cityId: 503n, founder: c, symbol: 'STC' }]), { programId: w.programId, batchSeq: 3n });
  const win = S.defaultPublishWindow(w.now());
  await w.send([w.ix.clearLaunchBatch({ authority: approver.address, halt: false }),
    w.ix.publishLaunchBatch({ approver: approver.address, seq: 3n, root: corrected.root, leafCount: 1, ...win })], [approver], '[clear, publish corrected]', { feePayer: approver });
  await expectFail(() => w.launchFromBatch({ batch: b2, cityId: 502n, founder: b, label: 'city 502 right after [clear, publish]' }), 'BatchCleared', 'BatchSuperseded');
  w.warpTo(win.validFrom);
  await w.launchFromBatch({ batch: { ...corrected, ...win }, cityId: 503n, founder: c });
  await w.finish();
});

test('X71, X85 a stolen approver key: its batch cannot take force within 12 hours; the guardian\'s clear with halt stops it and every later publication; the admin\'s rotation restores the path', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, thiefFounder] = [await w.signer(20n), await w.signer(20n)];
  const good = await w.publishBatch([{ cityId: 601n, founder: a, symbol: 'GOOD' }, { cityId: 602n, founder: a, symbol: 'GOODB' }]);
  w.warpTo(good.validFrom);
  // the thief (who holds the approver's key) publishes a batch naming his own founder for a city
  const bad = await w.publishBatch([{ cityId: 666n, founder: thiefFounder, symbol: 'STOLE' }, { cityId: 667n, founder: thiefFounder, symbol: 'STOLEB' }], { validFrom: w.now() + S.BATCH_REVIEW_SECS, validUntil: w.now() + S.BATCH_REVIEW_SECS + 2n * DAY });
  await expectFail(() => w.launchFromBatch({ batch: bad, cityId: 666n, founder: thiefFounder, label: 'the thief\'s batch at once' }), 'BatchNotYetValid');
  w.warpSecs(S.BATCH_REVIEW_SECS - 60n);
  await expectFail(() => w.launchFromBatch({ batch: bad, cityId: 666n, founder: thiefFounder, label: 'the thief\'s batch a minute before its window' }), 'BatchNotYetValid');
  // meanwhile the good batch stays in force through the junk batch's review window
  await w.launchFromBatch({ batch: good, cityId: 601n, founder: a, label: 'the good batch during the thief\'s window' });
  // the guardian clears with halt: the thief's batch never takes force, he cannot publish again
  await clear(w, w.guardian, true);
  w.warpTo(bad.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: bad, cityId: 666n, founder: thiefFounder, label: 'the thief\'s batch after the halt' }), 'BatchesHalted');
  await expectFail(() => w.publishBatch([{ cityId: 668n, founder: thiefFounder, symbol: 'STOLEC' }]), 'BatchesHalted');
  // the thief cannot lift the halt or rotate the key
  await expectFail(() => w.send([w.ix.setLaunchApprover({ admin: approver.address, approver: approver.address })], [approver], 'the approver rotates itself'), 'Unauthorized');
  // the admin rotates to a new key: the path works again, the thief's key does nothing
  const fresh = await w.signer(5n);
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: fresh.address })], [w.admin], 'rotate after the theft');
  await expectFail(() => w.publishBatch([{ cityId: 668n, founder: thiefFounder, symbol: 'STOLEC' }], { approver }), 'Unauthorized');
  w.approver = fresh;
  const again = await w.publishBatch([{ cityId: 602n, founder: a, symbol: 'GOODB' }]);
  w.warpTo(again.validFrom);
  await w.launchFromBatch({ batch: again, cityId: 602n, founder: a });
  assert.equal(w.exists(w.P.coin(666n)), false, 'city 666 never launched');
  await w.finish();
});

test('X72, X86 junk publications: a zero root and 0 leaves refused; a storm of junk batches while a good batch is in force only replaces the pending record, the good batch stays in force until the last junk batch\'s valid_from, and a clear ends it', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, b] = [await w.signer(20n), await w.signer(20n)];
  const good = await w.publishBatch([{ cityId: 701n, founder: a, symbol: 'KEEPA' }, { cityId: 702n, founder: b, symbol: 'KEEPB' }]);
  w.warpTo(good.validFrom);
  const win = () => S.defaultPublishWindow(w.now());
  await expectFail(() => rawPublish(w, approver, { seq: 2n, root: Array(32).fill(0), leafCount: 1, ...win() }, 'junk: zero root'), 'BadBatchRoot');
  await expectFail(() => rawPublish(w, approver, { seq: 2n, root: Array(32).fill(1), leafCount: 0, ...win() }, 'junk: 0 leaves'), 'BadLeafCount');
  let last;
  for (let k = 0; k < 6; k++) {
    w.warpSecs(600n);
    last = win();
    const r = await rawPublish(w, approver, { seq: BigInt(2 + k), root: Array(32).fill(9 + k), leafCount: 512, ...last }, `junk batch ${2 + k}`);
    assert.equal(r.events[0].data.replaced_seq, k === 0 ? 0n : BigInt(1 + k));
    assert.equal(w.launchBatch().previous.seq, 1n, 'the good batch stays as previous');
  }
  await w.launchFromBatch({ batch: good, cityId: 701n, founder: a, label: 'the good batch during the storm' });
  w.warpTo(last.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: good, cityId: 702n, founder: b, label: 'the good batch once the last junk took force' }), 'BatchSuperseded');
  await clear(w, w.admin, false);
  assert.equal(S.batchInForce(w.launchBatch(), w.launchpad(), w.now()), null);
  await w.finish();
});

test('X73, X85, I25 the approver signing every other instruction is refused, and no instruction pays it; the guardian pauses both launch paths', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const f = await w.signer(50n);
  const u = await w.signer(50n);
  await w.approve({ cityId: 801n, founder: f, symbol: 'APC' });
  const h = await w.launchCoin({ cityId: 802n, founder: f, symbol: 'APD' });
  await w.buy(u, h, 2n * LAMPORTS);
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  await w.send([w.ix.optInPayout({ founder: f.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(1) })], [f], 'opt in');
  const A = approver.address;
  const as = (label, ix, ...codes) => expectFail(() => w.send([ix], [approver], `the approver: ${label}`, { feePayer: approver }), ...codes);
  await as('set_pause launches', w.ix.setPause({ authority: A, launches: true }), 'Unauthorized');
  await as('set_pause buys', w.ix.setPause({ authority: A, buys: true }), 'Unauthorized');
  await as('set_guardian', w.ix.setGuardian({ admin: A, guardian: A }), 'Unauthorized');
  await as('set_payout_config', w.ix.setPayoutConfig({ admin: A, payoutAuthority: A, payoutDestination: wallet.address }), 'Unauthorized');
  await as('propose_admin', w.ix.proposeAdmin({ admin: A, newAdmin: A }), 'Unauthorized');
  await as('add_launch_config', w.ix.addLaunchConfig({ admin: A, payer: A, configId: 1, params: S.DEFAULT_CONFIG }), 'Unauthorized');
  await as('set_launch_config_enabled', w.ix.setLaunchConfigEnabled({ admin: A, configId: 0, enabled: false }), 'Unauthorized');
  await as('approve_launch', w.ix.approveLaunch({ admin: A, cityId: 803n, founder: A, configId: 0, name: 'X', symbol: 'APE', metaHash: metaHash('x'), expiresAt: w.now() + DAY }), 'Unauthorized');
  await as('revoke_approval', w.ix.revokeApproval({ by: A, cityId: 801n, rentPayer: w.admin.address }), 'ApprovalNotExpired');
  await as('claim_founder_fees', w.ix.claimFounderFees({ founder: A, coin: h.coin }), 'WrongFounder');
  await expectFail(() => w.send([w.ix.transferFounder({ founder: A, newFounder: u.address, coin: h.coin })], [approver, u], 'the approver: transfer_founder'), 'WrongFounder');
  await as('payout_founder_fees', w.ix.payoutFounderFees({ payoutAuthority: A, coin: h.coin, destination: wallet.address }), 'Unauthorized');
  await as('set_launch_approver', w.ix.setLaunchApprover({ admin: A, approver: A }), 'Unauthorized');
  await as('init_launch_batch', w.ix.initLaunchBatch({ admin: A, payer: A }), 'Unauthorized', /already in use/);
  await as('launch (as a founder)', w.ix.launch({ founder: A, payer: A, cityId: 801n, configId: 0, symbol: 'APC', rentPayer: w.admin.address }), 'WrongFounder');
  // a batch naming the approver itself as a founder: refused at the launch (FounderHoldsRole)
  const bt = await w.publishBatch([{ cityId: 804n, founder: approver, symbol: 'SELF' }, { cityId: 805n, founder: u, symbol: 'SELFB' }]);
  w.warpTo(bt.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 804n, founder: approver, label: 'the approver launches from its own batch' }), 'FounderHoldsRole');
  // the guardian's pause stops both launch paths at once; buys halted too
  await pause(w, w.guardian, { launches: true }, 'guardian pauses launches');
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 805n, founder: u, label: 'batch launch while launches are paused' }), 'LaunchesPaused');
  await expectFail(() => w.launch({ cityId: 801n, founder: f }), 'LaunchesPaused');
  await pause(w, w.admin, { launches: false }, 'admin resumes launches');
  await pause(w, w.guardian, { buys: true }, 'guardian halts buys');
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 805n, founder: u, label: 'batch launch while buys are halted' }), 'BuysHalted');
  await pause(w, w.admin, { buys: false }, 'admin resumes buys');
  // a founder who became the guardian after the batch was signed cannot launch (the seat of the launch's moment)
  const g2 = u;
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: g2.address })], [w.admin], 'the guardian is now a listed founder');
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 805n, founder: u, label: 'a founder holding a role' }), 'FounderHoldsRole');
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: w.guardian.address })], [w.admin], 'guardian back');
  await w.launchFromBatch({ batch: bt, cityId: 805n, founder: u });
  // the per-city path is unchanged throughout
  await w.launch({ cityId: 801n, founder: f });
  await w.finish();
});

test('X74, X87 a founder\'s batch launch copied: another signer is another leaf; another payer pays and the founder keeps the seat; a race for his ticker from a pending per-city approval', async () => {
  const w = await World.create();
  await w.initBatchPath();
  const [a, copier, payer, b] = [await w.signer(20n), await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const bt = await w.publishBatch([{ cityId: 901n, founder: a, symbol: 'COPYA' }, { cityId: 902n, founder: b, symbol: 'RACE' }]);
  w.warpTo(bt.validFrom);
  // the copier puts his own key in the founder slot: another leaf
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 901n, founder: copier, label: 'copied with another signer' }), 'InvalidProof');
  // he cannot send the founder's instruction without the founder's signature
  const ix = w.launchFromBatchIx({ batch: bt, cityId: 901n, founder: a, payer: copier });
  await assert.rejects(() => w.send([ix], [copier], 'without the founder\'s signature'), /signer|signature|Missing/i);
  // another payer is fine: he pays, the founder holds the seat
  const a0 = w.lamportsOf(a.address);
  const h = await w.launchFromBatch({ batch: bt, cityId: 901n, founder: a, payer });
  assert.equal(w.coinView(h).founder, a.address);
  assert.equal(w.lamportsOf(a.address), a0, 'the founder paid nothing');
  // a per-city approval for another city with the batch entry's ticker, launched first: the batch launch fails at the ticker lock
  const racer = await w.signer(20n);
  await w.approve({ cityId: 903n, founder: racer, symbol: 'RACE' });
  await w.launch({ cityId: 903n, founder: racer });
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 902n, founder: b, label: 'the raced ticker' }), /already in use/);
  await w.finish();
});

test('X75, X88, X91 a city both in a batch and under a pending per-city approval (ApprovalPending: the admin\'s choice wins); a wrong list naming a city or a ticker twice (the SDK refuses; on chain the first launch wins)', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, adminsChoice, b, c] = [await w.signer(20n), await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const bt = await w.publishBatch([{ cityId: 1001n, founder: a, symbol: 'BOTH' }, { cityId: 1002n, founder: b, symbol: 'BOTHB' }]);
  await w.approve({ cityId: 1001n, founder: adminsChoice, symbol: 'BOTHX' });
  w.warpTo(bt.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 1001n, founder: a, label: 'a city with a pending approval' }), 'ApprovalPending');
  // the admin revokes: the batch entry works
  await w.send([w.ix.revokeApproval({ by: w.admin.address, cityId: 1001n, rentPayer: w.admin.address })], [w.admin], 'revoke_approval');
  await w.launchFromBatch({ batch: bt, cityId: 1001n, founder: a });
  // the SDK refuses a list naming a city or a ticker twice
  assert.throws(() => S.buildLaunchBatch(w.batchEntries([{ cityId: 1003n, founder: b, symbol: 'DUP' }, { cityId: 1003n, founder: c, symbol: 'DUPB' }]), { batchSeq: 2n }), /named twice/);
  assert.throws(() => S.buildLaunchBatch(w.batchEntries([{ cityId: 1003n, founder: b, symbol: 'DUP' }, { cityId: 1004n, founder: c, symbol: 'DUP' }]), { batchSeq: 2n }), /named twice/);
  // a wrong list built by hand with a city twice: both entries prove, the first launch wins, the second fails at init
  const entries = w.batchEntries([{ cityId: 1003n, founder: b, symbol: 'DUP' }, { cityId: 1003n, founder: c, symbol: 'DUPC' }, { cityId: 1005n, founder: c, symbol: 'DUP' }]);
  const seq = w.launchBatch().latest.seq + 1n;
  const leaves = entries.map((e) => S.launchLeaf({ programId: w.programId, batchSeq: seq, ...e }));
  const levels = S.buildLevels(leaves);
  const root = levels[levels.length - 1][0];
  const win = S.defaultPublishWindow(w.now());
  await rawPublish(w, approver, { seq, root, leafCount: 3, ...win }, 'a hand-built list with a city and a ticker twice');
  w.warpTo(win.validFrom);
  const send = (i, signer, label) => w.send([w.ix.launchFromBatch({ ...entries[i], batchSeq: seq, proof: S.proofAt(levels, i), founder: signer.address })], [signer], label);
  await send(0, b, 'the first entry of city 1003');
  await expectFail(() => send(1, c, 'the second entry of city 1003'), /already in use/);
  await expectFail(() => send(2, c, 'the ticker DUP again under city 1005'), /already in use/);
  await w.finish();
});

test('X59, X76 clock warps around a batch: one second before valid_from, at it, at valid_until and one second after; the batch path off while no approver is set', async () => {
  const w = await World.create();
  await w.initBatchPath();
  const [a, b, c] = [await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const bt = await w.publishBatch([{ cityId: 1101n, founder: a, symbol: 'CLKA' }, { cityId: 1102n, founder: b, symbol: 'CLKB' }, { cityId: 1103n, founder: c, symbol: 'CLKC' }],
    { leadSecs: S.BATCH_REVIEW_SECS, validitySecs: 2n * H });
  w.warpTo(bt.validFrom - 1n);
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 1101n, founder: a, label: 'valid_from - 1' }), 'BatchNotYetValid');
  w.warpSecs(1n);
  await w.launchFromBatch({ batch: bt, cityId: 1101n, founder: a, label: 'at valid_from' });
  w.warpTo(bt.validUntil);
  await w.launchFromBatch({ batch: bt, cityId: 1102n, founder: b, label: 'at valid_until' });
  w.warpSecs(1n);
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 1103n, founder: c, label: 'valid_until + 1' }), 'BatchExpired');
  // the approver removed: the batch path is off
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: S.ADDRESSES.system })], [w.admin], 'set_launch_approver(zero)');
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 1103n, founder: c, label: 'no approver' }), 'LaunchApproverNotSet');
  await w.finish();
});

test('L14, 4.27 every rule of approve_launch and launch at the moment of a batch launch: the old program\'s Approval, Coin, open launches and admin; the rewards registry\'s admin; a disabled config; city 0; an admin hand-over keeps the batch in force', async () => {
  const w = await World.create({ dbcProgram: true });
  await w.initBatchPath();
  const cfg1 = await w.addConfig({ ...S.DEFAULT_CONFIG });
  const fs = []; for (let i = 0; i < 6; i++) fs.push(await w.signer(20n));
  const list = [
    { cityId: 5101n, founder: fs[0], symbol: 'RLA' }, { cityId: 5102n, founder: fs[1], symbol: 'RLB' }, { cityId: 5103n, founder: fs[2], symbol: 'RLC' },
    { cityId: 5104n, founder: fs[3], symbol: 'RLD', configId: cfg1 }, { cityId: 5105n, founder: fs[4], symbol: 'RLE' },
  ];
  // city 0 cannot be listed through the SDK (entryProblems): its leaf is added by hand to show the program's own check
  const z = fs[5];
  const built = S.buildLaunchBatch(w.batchEntries(list), { programId: w.programId, batchSeq: 1n });
  const zero = { cityId: 0n, founder: String(z.address), configId: 0, metaHash: metaHash('zero'), name: 'Zero City', symbol: 'RLZ' };
  const levels = S.buildLevels([...built.leaves, S.launchLeaf({ programId: w.programId, batchSeq: 1n, ...zero })]);
  const bt = { ...built, levels, root: levels[levels.length - 1][0], leafCount: built.leafCount + 1 };
  const pub = await w.publishBatch(list, { root: bt.root, leafCount: bt.leafCount });
  w.warpTo(pub.validFrom);
  const go = (cityId, label) => w.launchFromBatch({ batch: bt, cityId, founder: fs[list.findIndex((e) => e.cityId === cityId)], label });
  await expectFail(() => w.send([w.ix.launchFromBatch({ founder: z.address, payer: z.address, batchSeq: 1n, ...zero, proof: S.proofAt(levels, built.leafCount) })], [z], 'city 0'), 'BadCityId');
  // the old program approves city 5101 after the list was signed
  const oldFounder = await w.signer(5n);
  await w.legacyApprove({ cityId: 5101n, founder: oldFounder });
  await expectFail(() => go(5101n, 'old Approval'), 'LegacyApprovalExists');
  // its launches reopened: every batch launch stops at once
  await w.legacyPause(false);
  await expectFail(() => go(5102n, 'old launches open'), 'LegacyLaunchesOpen');
  // it launches city 5101 itself, then pauses again: city 5101 is taken forever
  await w.legacyLaunch({ cityId: 5101n, founder: oldFounder });
  await w.legacyPause(true);
  await expectFail(() => go(5101n, 'old Coin'), 'LegacyCoinExists');
  // a disabled config, after the list was signed
  await w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: cfg1, enabled: false })], [w.admin], 'disable config 1');
  await expectFail(() => go(5104n, 'disabled config'), 'ConfigDisabled');
  // a transfer pending in the old program stops batch launches until it is cancelled
  const stranger = await w.signer(5n);
  await w.legacyHandOver(stranger, { accept: false });
  await expectFail(() => go(5102n, 'old admin being handed over'), 'LegacyAdminMismatch');
  await w.send([w.legacyIx('propose_admin', { new_admin: new web3.PublicKey(S.ADDRESSES.system) }, { admin: w.admin.address, launchpad: w.legacyPdas().launchpad })], [w.admin], 'legacy cancel the transfer');
  await go(5102n, 'launch_from_batch after the cancel');
  // a hand-over of this program's admin: the batch stays in force (only set_launch_approver clears), but the old
  // program's admin and the rewards registry's admin must follow before the next batch launch, as for launch
  const next = await w.signer(5n);
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose_admin');
  await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept_admin');
  const oldAdmin = w.admin; w.admin = next;
  assert.equal(S.batchRefusal(w.launchBatch(), w.launchpad(), 1n, w.now()), null, 'batch 1 still in force after the admin hand-over');
  await expectFail(() => go(5103n, 'before the old admin followed'), 'LegacyAdminMismatch');
  await w.legacyHandOver(next, { from: oldAdmin });
  await expectFail(() => go(5103n, 'before the registry admin followed'), 'RewardsRegistryAdminMismatch');
  await w.registryHandOver(next, { from: oldAdmin });
  await go(5103n, 'launch_from_batch after both followed');
  await go(5105n, 'launch_from_batch');
  await w.finish();
});

test('X67, X69 an inner node or a leaf in a wrong place of a proof is refused; a publication sent again and a second one prepared from the same state are refused (BatchSeqMismatch)', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const fs = []; for (let i = 0; i < 4; i++) fs.push(await w.signer(20n));
  const list = fs.map((f, i) => ({ cityId: 6101n + BigInt(i), founder: f, symbol: `XS${i}` }));
  // X69: two lists prepared by the SDK from the same LaunchBatch; the first lands, the second and a resend of the first do not
  const lb = w.launchBatch(); const lp = w.launchpad();
  const prep = (entries) => S.preparePublishLaunchBatch({ batch: S.buildLaunchBatch(w.batchEntries(entries), { programId: w.programId, batchSeq: lb.latest.seq + 1n }),
    launchBatch: lb, launchpad: lp, approver: approver.address, now: w.now(), programId: w.programId, ix: w.ix });
  const first = prep(list); const second = prep(list.slice(0, 2));
  await w.send([first.instruction], [approver], 'publication 1', { feePayer: approver });
  await expectFail(() => w.send([second.instruction], [approver], 'a second publication prepared from the same state', { feePayer: approver }), 'BatchSeqMismatch');
  await expectFail(() => w.send([first.instruction], [approver], 'publication 1 sent again (another fee payer)', { feePayer: w.payer }), 'BatchSeqMismatch');
  assert.equal(w.launchBatch().latest.seq, 1n);
  // X67: the tree of the four cities; city 6101's proof is [leaf 6102, node(6103, 6104)]
  const bt = S.buildLaunchBatch(w.batchEntries(list), { programId: w.programId, batchSeq: 1n });
  assert.equal(Buffer.from(bt.root).toString('hex'), Buffer.from(first.root).toString('hex'), 'the published root is the tree\'s');
  w.warpTo(first.validFrom);
  const L = bt.levels;
  const bad = (proof, label) => expectFail(() => w.launchFromBatch({ batch: bt, cityId: 6101n, founder: fs[0], edit: { proof }, label }), 'InvalidProof');
  await bad([L[1][1]], 'the inner node alone (as if the leaf were node(6101, 6102))');
  await bad([L[0][1], L[0][2]], 'a leaf in place of the inner node');
  await bad([L[1][0], L[1][1]], 'the level above in place of the leaf');
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 6101n, founder: fs[0], edit: { proof: [L[0][1], L[1][1], L[2][0]] }, label: 'the root appended: three hashes for four leaves' }), 'ProofTooLong');
  await w.launchFromBatch({ batch: bt, cityId: 6101n, founder: fs[0] });
  await w.finish();
});

test('L14 set_launch_approver clears both stored records even with the same key and no clear before it: the batch in force and the pending one stop at once; the next publication works', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, b] = [await w.signer(20n), await w.signer(20n)];
  const b1 = await w.publishBatch([{ cityId: 2101n, founder: a, symbol: 'ROTA' }]);
  w.warpTo(b1.validFrom);
  const b2 = await w.publishBatch([{ cityId: 2102n, founder: b, symbol: 'ROTB' }]);
  assert.equal(S.batchRefusal(w.launchBatch(), w.launchpad(), 1n, w.now()), null, 'batch 1 in force, batch 2 pending');
  await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: approver.address })], [w.admin], 'set_launch_approver (the same key)');
  const lb = w.launchBatch();
  assert.deepEqual([lb.previous.seq, lb.previous.cleared, lb.latest.seq, lb.latest.cleared, lb.halted], [1n, true, 2n, true, false]);
  await expectFail(() => w.launchFromBatch({ batch: b1, cityId: 2101n, founder: a, label: 'batch 1 after the re-set' }), 'BatchCleared');
  w.warpTo(b2.validFrom);
  await expectFail(() => w.launchFromBatch({ batch: b2, cityId: 2102n, founder: b, label: 'batch 2 after the re-set' }), 'BatchCleared');
  const b3 = await w.publishBatch([{ cityId: 2101n, founder: a, symbol: 'ROTA' }, { cityId: 2102n, founder: b, symbol: 'ROTB' }]);
  assert.equal(b3.batchSeq, 3n);
  w.warpTo(b3.validFrom);
  await w.launchFromBatch({ batch: b3, cityId: 2101n, founder: a });
  await w.launchFromBatch({ batch: b3, cityId: 2102n, founder: b });
  await w.finish();
});
