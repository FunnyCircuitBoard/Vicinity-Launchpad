// The batch launch approval in the SDK (VICINITY-CURVE-DESIGN.md 3.12, 4.25, 4.27, 8.6, 14.1; U13, P12): the worked
// example of 3.12 byte for byte, the shared fixture (sdk/fixtures/launch-batch.json, which the program's unit test U13
// reproduces), the ports of check_name and check_symbol, buildLaunchBatch's refusals and ordering, proofs and their
// verification with the depth bound, the list file and the day's changes, the in-force rule of 8.6 over its table, and
// the owner's unsigned publish_launch_batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import web3 from '@solana/web3.js';
import * as S from './index.mjs';
import { hashNode, toHex, fromHex } from '../merkle.mjs';
import { launchBatchFixture, fixtureEntry } from './gen-launch-batch-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (s) => Uint8Array.from(createHash('sha256').update(s).digest());
const key = () => web3.Keypair.generate().publicKey.toBase58();
const ZERO = S.ADDRESSES.system;

const worked = () => [
  { cityId: 2_643_743n, name: 'London', symbol: 'LONDON', founder: new Uint8Array(32).fill(0x11) },
  { cityId: 2_988_507n, name: 'Paris', symbol: 'PARIS', founder: new Uint8Array(32).fill(0x22) },
  { cityId: 5_128_581n, name: 'New York City', symbol: 'NYC', founder: new Uint8Array(32).fill(0x33) },
].map((e) => ({ ...e, configId: 0, metaHash: sha(`{"name":"${e.name}","symbol":"${e.symbol}"}`) }));

test('U13 the worked example of 3.12: preimages, leaves, root, proofs, the depth bound; the rewards SDK\'s node hash', () => {
  const b = S.buildLaunchBatch(worked(), { batchSeq: 7n });
  assert.equal(S.CURVE_PROGRAM_ID, 'nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk');
  assert.deepEqual(b.leaves.map(toHex), [
    '539ae27079e009d0b140bea745a90b939c5f5eaf299312a252f9ec0e10cc71e0',
    'a606901235eb24b9a37c1fdc60354539b91f5cd1dcc4d553580d46cdcbc0f44e',
    '0c5ac2c3a5e2fdccf0a2a12d1e9f6696d7c49934e330e3939978835a22f84a5c',
  ]);
  assert.equal(toHex(b.root), '678ab4f7709c306d03b4a47bbc0bd93272acd8cf6fd38c2d6d7629a88f4b5d45');
  assert.equal(toHex(hashNode(b.leaves[0], b.leaves[1])), '6565f42ef55b9b2dea2aaad63bdb674e5827004781161dfcefa49ab88085c4b3');
  assert.deepEqual(worked().map((e) => S.launchLeafPreimage({ batchSeq: 7n, ...e }).length), [156, 154, 160]);
  assert.equal(toHex(S.launchLeafPreimage({ batchSeq: 7n, ...worked()[0] })), [
    '00', '766963696e6974795f63757276652f6c61756e63685f6c656166', '01', '0bb520f977287355b716c92bda75a1efcf5dafc69a57e01481083ae4df2e1c49',
    '0700000000000000', '1f57280000000000', '11'.repeat(32), '0000', 'c252ce452838061b9ee03879063abccd3482e5fa49174b1ab87b5196e4a44d58',
    '064c6f6e646f6e', '064c4f4e444f4e'].join(''));
  assert.deepEqual(S.launchBatchProof(b, 2_643_743n).map(toHex), [toHex(b.leaves[1]), toHex(b.leaves[2])]);
  assert.deepEqual(S.launchBatchProof(b, 2_988_507n).map(toHex), [toHex(b.leaves[0]), toHex(b.leaves[2])]);
  assert.deepEqual(S.launchBatchProof(b, 5_128_581n).map(toHex), ['6565f42ef55b9b2dea2aaad63bdb674e5827004781161dfcefa49ab88085c4b3']);
  assert.equal(b.depth, 2); assert.equal(S.maxProofLen(3), 2);
  // Paris as "Parisx", another config, ticker, metadata hash, signer, batch or program: another leaf, InvalidProof
  const p = S.launchBatchProof(b, 2_988_507n);
  const paris = worked()[1];
  assert.ok(S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ batchSeq: 7n, ...paris }), proof: p, leafCount: 3 }));
  for (const bad of [{ name: 'Parisx' }, { configId: 1 }, { symbol: 'PARIX' }, { metaHash: worked()[0].metaHash }, { founder: new Uint8Array(32).fill(0x44) }]) {
    assert.ok(!S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ batchSeq: 7n, ...paris, ...bad }), proof: p, leafCount: 3 }), JSON.stringify(Object.keys(bad)));
  }
  assert.ok(!S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ batchSeq: 8n, ...paris }), proof: p, leafCount: 3 }));
  assert.ok(!S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ programId: key(), batchSeq: 7n, ...paris }), proof: p, leafCount: 3 }));
  // a proof longer than the depth is refused before folding, even with the right leaf first
  assert.ok(!S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ batchSeq: 7n, ...paris }), proof: [...p, p[0]], leafCount: 3 }));
});

test('U13 the shared fixture: the generator reproduces sdk/fixtures/launch-batch.json, and every tree\'s proofs verify', () => {
  const committed = readFileSync(join(here, '..', 'fixtures', 'launch-batch.json'), 'utf8');
  assert.equal(`${JSON.stringify(launchBatchFixture(), null, 1)}\n`, committed, 'run node sdk/curve/gen-launch-batch-fixture.mjs');
  const fx = JSON.parse(committed);
  assert.equal(fx.trees.length, 71);
  assert.equal(fx.workedExample.root, '678ab4f7709c306d03b4a47bbc0bd93272acd8cf6fd38c2d6d7629a88f4b5d45');
  for (const t of fx.trees) {
    for (const s of t.samples) {
      assert.ok(S.verifyLaunchProof({ root: fromHex(t.root), leaf: fromHex(s.leaf), proof: s.proof.map(fromHex), leafCount: t.leaves }), `tree ${t.leaves} sample ${s.index}`);
      assert.ok(s.proof.length <= S.maxProofLen(t.leaves));
    }
    assert.equal(t.depth, S.treeDepth(t.leaves));
  }
  // the fixture's entries pass buildLaunchBatch, sorted by city: its 512-leaf root
  const entries = Array.from({ length: 512 }, (_, i) => fixtureEntry(i));
  const b = S.buildLaunchBatch(entries, { batchSeq: 3n });
  assert.equal(toHex(b.root), fx.trees[70].root);
  assert.equal(b.depth, 9);
});

test('check_name and check_symbol ports: the program\'s rules (review FA-1)', () => {
  for (const ok of ['A', 'New York', 'São Paulo', 'x'.repeat(32), 'Zürich 2', '東京']) assert.equal(S.checkName(ok), null, ok);
  for (const bad of ['', 'x'.repeat(33), ' London', 'London ', 'New  York', 'Lon\u0000don', 'Lon\u007fdon', 'Lon\u0085don', 'Lon​don', 'Lon‮don',
    'Lon don', 'Lon　don', 'Lon⠀don', 'Lon\u{e0041}don', 'Lon­don', 'ééééééééééééééééé']) assert.notEqual(S.checkName(bad), null, JSON.stringify(bad));
  for (const ok of ['A', 'NYC', 'ABCDEFGHIJ', 'C0', '1']) assert.equal(S.checkSymbol(ok), null, ok);
  for (const bad of ['', 'nyc', 'ABCDEFGHIJK', 'NY C', 'NYÇ', 'N-Y']) assert.notEqual(S.checkSymbol(bad), null, JSON.stringify(bad));
});

test('buildLaunchBatch: every entry checked as the program will, duplicates refused, 1 to 512 entries, sorted by city id, order-independent', () => {
  const lp = { guardian: key(), payoutAuthority: key(), launchApprover: key() };
  const good = worked();
  const a = S.buildLaunchBatch(good, { batchSeq: 1n, launchpad: lp });
  const shuffled = S.buildLaunchBatch([good[2], good[0], good[1]], { batchSeq: 1n, launchpad: lp });
  assert.equal(toHex(a.root), toHex(shuffled.root), 'the same data gives the same root');
  assert.deepEqual(a.entries.map((e) => e.cityId), [2_643_743n, 2_988_507n, 5_128_581n]);
  const refuse = (entries, re, o = {}) => assert.throws(() => S.buildLaunchBatch(entries, { batchSeq: 1n, launchpad: lp, ...o }), re);
  refuse([], /Empty/);
  refuse([...good, { ...good[0], symbol: 'LDN' }], /city 2643743 named twice/);
  refuse([...good, { ...good[0], cityId: 9n }], /ticker LONDON named twice/);
  refuse(Array.from({ length: 513 }, (_, i) => fixtureEntry(i)), /TooMany/);
  for (const [why, bad] of [
    [/founder is the guardian/, { founder: lp.guardian }], [/founder is the payout key/, { founder: lp.payoutAuthority }],
    [/founder is the launch approver/, { founder: lp.launchApprover }], [/founder is FEE_RECIPIENT/, { founder: S.ADDRESSES.feeRecipient }],
    [/founder is zero/, { founder: ZERO }], [/name:/, { name: 'Lon​don' }], [/symbol:/, { symbol: 'lon' }], [/meta_hash is all zeros/, { metaHash: new Uint8Array(32) }],
    [/city id 0/, { cityId: 0n }], [/config id/, { configId: 70_000 }],
  ]) refuse([{ ...good[0], ...bad }], why);
  refuse(good, /batch 0 is no batch/, { batchSeq: 0n });
  // chain state: a coin here or in the old program, a pending approval, a locked ticker, a disabled or missing config
  const chain = (over) => ({ coins: new Set(), legacyCoins: new Set(), legacyApprovals: new Set(), approvals: new Set(), tickers: new Set(), configs: new Map([[0, { enabled: true }]]), ...over });
  assert.doesNotThrow(() => S.buildLaunchBatch(good, { batchSeq: 1n, launchpad: lp, chain: chain({}) }));
  refuse(good, /has a coin$/m, { chain: chain({ coins: new Set([2_643_743n]) }) });
  refuse(good, /coin in the old program/, { chain: chain({ legacyCoins: new Set(['2988507']) }) });
  refuse(good, /approval in the old program/, { chain: chain({ legacyApprovals: new Set([5_128_581n]) }) });
  refuse(good, /pending per-city approval/, { chain: chain({ approvals: new Set([5_128_581n]) }) });
  refuse(good, /ticker is locked/, { chain: chain({ tickers: new Set(['PARIS']) }) });
  refuse(good, /config 0 is disabled/, { chain: chain({ configs: new Map([[0, { enabled: false }]]) }) });
  refuse([{ ...good[0], configId: 4 }], /config 4 does not exist/, { chain: chain({}) });
});

test('P12 (SDK) random batches: every proof verifies within the depth; each mutated field, batch number, program id or another entry\'s proof fails', () => {
  let x = 0x2545F491n;
  const rnd = (n) => { x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number((x >> 33n) % BigInt(n)); };
  for (let round = 0; round < 12; round++) {
    const n = round === 0 ? 512 : 1 + rnd(512);
    const entries = Array.from({ length: n }, (_, i) => ({ ...fixtureEntry(i + 1000 * round), cityId: BigInt(1 + i * 5 + rnd(5)), symbol: `S${round}X${i.toString(36).toUpperCase()}` }));
    const b = S.buildLaunchBatch(entries, { batchSeq: BigInt(1 + rnd(99)) });
    for (let k = 0; k < 10; k++) {
      const e = b.entries[rnd(n)];
      const args = S.launchBatchArgs(b, e.cityId);
      const leaf = S.launchLeaf({ batchSeq: b.batchSeq, ...e });
      assert.ok(args.proof.length <= S.maxProofLen(n));
      assert.ok(S.verifyLaunchProof({ root: b.root, leaf, proof: args.proof, leafCount: n }));
      const mutate = [{ cityId: e.cityId + 1n }, { founder: key() }, { configId: e.configId ^ 1 }, { metaHash: sha(`m${k}`) }, { name: `${e.name}x` }, { symbol: `${e.symbol.slice(0, 9)}Q` }];
      for (const m of mutate) assert.ok(!S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ batchSeq: b.batchSeq, ...e, ...m }), proof: args.proof, leafCount: n }));
      assert.ok(!S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ batchSeq: b.batchSeq + 1n, ...e }), proof: args.proof, leafCount: n }));
      assert.ok(!S.verifyLaunchProof({ root: b.root, leaf: S.launchLeaf({ programId: key(), batchSeq: b.batchSeq, ...e }), proof: args.proof, leafCount: n }));
      if (n > 1) {
        const other = b.entries.find((o) => o.cityId !== e.cityId);
        assert.ok(!S.verifyLaunchProof({ root: b.root, leaf, proof: S.launchBatchProof(b, other.cityId), leafCount: n }));
      }
    }
  }
});

test('the list file round trip and the day\'s changes (8.4)', () => {
  const b = S.buildLaunchBatch(worked(), { batchSeq: 4n });
  const file = S.launchBatchFile(b);
  assert.equal(file.root, toHex(b.root)); assert.equal(file.seq, '4');
  const back = S.parseLaunchBatchFile(JSON.stringify(file));
  assert.equal(toHex(back.root), toHex(b.root));
  assert.throws(() => S.parseLaunchBatchFile({ ...file, root: '00'.repeat(32) }), /BadFile/);
  assert.throws(() => S.parseLaunchBatchFile({ ...file, entries: [{ ...file.entries[0], name: 'Londres' }, ...file.entries.slice(1)] }), /BadFile/);
  const next = S.buildLaunchBatch([{ ...worked()[0], name: 'Londres' }, worked()[2], { ...fixtureEntry(1), cityId: 9n }], { batchSeq: 5n });
  const d = S.diffLaunchBatches(file, next);
  assert.deepEqual(d.added.map((e) => e.cityId), [9n]);
  assert.deepEqual(d.removed.map((e) => e.cityId), [2_988_507n]);
  assert.deepEqual(d.changed.map((c) => [c.before.name, c.after.name]), [['London', 'Londres']]);
  assert.deepEqual(S.diffLaunchBatches(null, b).added.length, 3);
});

test('8.6 which batch is in force: daily batches without a gap, a pending batch replaced, supersession at the newer valid_from, clears, rotation', () => {
  const approver = key();
  const lp = { launchApprover: approver };
  const h = 3_600n; const day = 24n * h; const d1 = 1_800_000_000n;
  const rec = (seq, from, until, publisher = approver) => ({ seq, root: new Uint8Array(32).fill(1), leafCount: 3, validFrom: from, validUntil: until, publishedAt: from - S.BATCH_REVIEW_SECS, publishedSlot: 1n, publisher, cleared: false });
  const empty = rec(0n, 0n, 0n, ZERO);
  let lb = { bump: 1, halted: false, latest: empty, previous: empty };
  assert.equal(S.batchInForce(lb, lp, d1), null);
  assert.equal(S.batchRefusal(lb, lp, 0n, d1), 'BatchSuperseded');
  assert.equal(S.batchRefusal(lb, { launchApprover: ZERO }, 1n, d1), 'LaunchApproverNotSet');
  lb = { ...lb, latest: rec(1n, d1 + day + 9n * h, d1 + day + 45n * h) };
  assert.equal(S.batchRefusal(lb, lp, 1n, d1 + 21n * h), 'BatchNotYetValid');
  assert.equal(S.batchInForce(lb, lp, d1 + day + 9n * h).seq, 1n);
  lb = { ...lb, previous: lb.latest, latest: rec(3n, d1 + 2n * day + 10n * h, d1 + 2n * day + 46n * h) };
  assert.equal(S.batchInForce(lb, lp, d1 + 2n * day + 9n * h).seq, 1n, 'the older batch until the newer takes force');
  assert.equal(S.batchInForce(lb, lp, d1 + 2n * day + 10n * h).seq, 3n);
  assert.equal(S.batchRefusal(lb, lp, 1n, d1 + 2n * day + 10n * h), 'BatchSuperseded');
  assert.equal(S.batchRefusal(lb, lp, 2n, d1 + 2n * day + 9n * h), 'BatchSuperseded', 'a replaced number is unknown');
  assert.equal(S.batchRefusal({ ...lb, latest: { ...lb.latest, cleared: true } }, lp, 3n, d1 + 2n * day + 10n * h), 'BatchCleared');
  assert.equal(S.batchRefusal(lb, lp, 3n, lb.latest.validUntil + 1n), 'BatchExpired');
  assert.equal(S.batchRefusal(lb, lp, 3n, lb.latest.validUntil), null, 'inclusive end');
  assert.equal(S.batchRefusal({ ...lb, halted: true }, lp, 3n, d1 + 2n * day + 10n * h), 'BatchesHalted');
  assert.equal(S.batchRefusal(lb, { launchApprover: key() }, 3n, d1 + 2n * day + 10n * h), 'BatchSuperseded', 'a former approver\'s batch');
});

test('the owner\'s unsigned publish_launch_batch: seq from the account, the default window, every refusal of 4.25 before signing', () => {
  const approver = key(); const now = 1_800_000_000n;
  const lp = { launchApprover: approver };
  const lbAcc = { halted: false, latest: { seq: 6n, validFrom: 0n }, previous: { seq: 5n } };
  const b = S.buildLaunchBatch(worked(), { batchSeq: 7n });
  const p = S.preparePublishLaunchBatch({ batch: b, launchBatch: lbAcc, launchpad: lp, approver, now });
  assert.equal(p.seq, 7n);
  assert.equal(p.validFrom, now + S.BATCH_REVIEW_SECS + 600n, '12 hours and 10 minutes');
  assert.equal(p.validUntil, p.validFrom + 36n * 3_600n, '36 hours (O31)');
  assert.ok(S.publishWindowOk(now, p.validFrom, p.validUntil));
  assert.deepEqual(p.instruction, S.ix.publishLaunchBatch({ approver, seq: 7n, root: b.root, leafCount: 3, validFrom: p.validFrom, validUntil: p.validUntil }));
  // the approver, the Launchpad, LaunchBatch, and the two event accounts (an event CPI since review R6-RT-3)
  assert.deepEqual(p.instruction.accounts.map((a) => a.role), [S.Role.RS, S.Role.R, S.Role.W, S.Role.R, S.Role.R]);
  assert.deepEqual(p.instruction.accounts.slice(3).map((a) => a.address), [S.curvePdas().eventAuthority(), S.CURVE_PROGRAM_ID]);
  assert.throws(() => S.preparePublishLaunchBatch({ batch: b, launchBatch: { ...lbAcc, latest: { seq: 7n } }, launchpad: lp, approver, now }), /WrongSeq/);
  assert.throws(() => S.preparePublishLaunchBatch({ batch: b, launchBatch: lbAcc, launchpad: lp, approver: key(), now }), /NotApprover/);
  assert.throws(() => S.preparePublishLaunchBatch({ batch: b, launchBatch: lbAcc, launchpad: { launchApprover: ZERO }, approver, now }), /NoApprover/);
  assert.throws(() => S.preparePublishLaunchBatch({ batch: b, launchBatch: { ...lbAcc, halted: true }, launchpad: lp, approver, now }), /Halted/);
  for (const [f, u] of [[now + S.BATCH_REVIEW_SECS - 1n, now + S.BATCH_REVIEW_SECS + 10n], [now + S.BATCH_MAX_LEAD_SECS + 1n, now + S.BATCH_MAX_LEAD_SECS + 2n],
    [now + S.BATCH_REVIEW_SECS, now + S.BATCH_REVIEW_SECS + S.BATCH_MAX_VALIDITY_SECS + 1n], [now + S.BATCH_REVIEW_SECS, now + S.BATCH_REVIEW_SECS]]) {
    assert.throws(() => S.preparePublishLaunchBatch({ batch: b, launchBatch: lbAcc, launchpad: lp, approver, now, validFrom: f, validUntil: u }), /BadWindow/);
  }
  // the bounds themselves are accepted
  assert.doesNotThrow(() => S.preparePublishLaunchBatch({ batch: b, launchBatch: lbAcc, launchpad: lp, approver, now, validFrom: now + S.BATCH_REVIEW_SECS, validUntil: now + S.BATCH_REVIEW_SECS + S.BATCH_MAX_VALIDITY_SECS }));
  // a batch built for another program id is refused
  const other = S.buildLaunchBatch(worked(), { batchSeq: 7n, programId: key() });
  assert.throws(() => S.preparePublishLaunchBatch({ batch: other, launchBatch: lbAcc, launchpad: lp, approver, now }), /WrongProgram/);
  // the founder's launch: launchBatchArgs feeds ix.launchFromBatch
  const args = S.launchBatchArgs(b, 2_988_507n);
  const ix = S.ix.launchFromBatch({ ...args, founder: new web3.PublicKey(args.founder) });
  assert.equal(ix.accounts[0].address, args.founder);
  assert.equal(ix.accounts.length, 22);
  assert.throws(() => S.launchBatchArgs(b, 1n), /NotInBatch/);
});

test('MK-1 (review round 6) every leaf field is taken exactly or refused: a missing, null or misspelt name or config id is never coerced into "undefined" or config #0, and the list file has exactly the leaf fields', () => {
  const good = worked()[0];
  const drop = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const refuse = (e, re, o = {}) => assert.throws(() => S.buildLaunchBatch([e], { batchSeq: 1n, ...o }), re, JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  // the name: missing, undefined, null, a number, an array
  refuse(drop(good, 'name'), /name must be a string, not undefined/);
  for (const bad of [undefined, null, 42, ['London']]) refuse({ ...good, name: bad }, /name must be a string/);
  // the ticker likewise
  refuse(drop(good, 'symbol'), /symbol must be a string/);
  for (const bad of [null, 7]) refuse({ ...good, symbol: bad }, /symbol must be a string/);
  // the config id: missing, misspelt (the site's config_id column), null, a fraction, negative, blank, spaced, a boolean, too large
  refuse(drop(good, 'configId'), /config id must be an integer/);
  refuse({ ...drop(good, 'configId'), config_id: 3 }, /config id must be an integer/);
  for (const bad of [undefined, null, 1.5, -1, '', ' 1', '1e2', '01', true, 70_000]) refuse({ ...good, configId: bad }, /config id/);
  // the city id: a boolean, blank or spaced text, hex text, a fraction, negative, beyond 2^53 as a number, beyond u64
  for (const bad of [undefined, null, true, '', ' 12', '12 ', '0x10', 1.5, -3, 2 ** 53, 1n << 64n]) refuse({ ...good, cityId: bad }, /city id/);
  // the founder: missing, a number, 31 bytes, an array with a non-byte
  for (const bad of [undefined, null, 12345, new Uint8Array(31), Array(32).fill(256)]) refuse({ ...good, founder: bad }, /founder/);
  // the metadata hash: missing, short hex, 0x-prefixed, bytes out of range, a number
  for (const bad of [undefined, '00'.repeat(31), `0x${'11'.repeat(32)}`, Array(32).fill(-1), Array(32).fill('a'), 5]) refuse({ ...good, metaHash: bad }, /meta_hash must be 32 bytes/);
  // the batch number likewise
  for (const bad of [true, '', ' 1', 1.5, null]) assert.throws(() => S.buildLaunchBatch([good], { batchSeq: bad }), /batch_seq/);
  // the exact forms still accepted: a bigint, a safe integer or decimal text for the ids, base58 or 32 bytes for the founder, hex or bytes for the hash
  const ref = toHex(S.buildLaunchBatch([good], { batchSeq: 1n }).root);
  const forms = { ...good, cityId: '2643743', configId: '0', founder: new web3.PublicKey(good.founder).toBase58(), metaHash: toHex(good.metaHash) };
  assert.equal(toHex(S.buildLaunchBatch([forms], { batchSeq: '1' }).root), ref);
  assert.equal(toHex(S.buildLaunchBatch([{ ...good, cityId: 2_643_743, configId: 0n, founder: [...good.founder] }], { batchSeq: 1 }).root), ref);
  // entryProblems reports what buildLaunchBatch refuses
  assert.match(S.entryProblems({ ...good, name: null }).join(), /name must be a string/);

  // the list file: a field lost before the root was computed (the root recomputed by the old coercion: name "undefined",
  // config 0) is refused, as is a misspelt or extra field, and each field of the wrong type
  const file = S.launchBatchFile(S.buildLaunchBatch(worked(), { batchSeq: 4n }));
  const coerced = S.launchBatchFile(S.buildLaunchBatch(worked().map((e, i) => (i ? e : { ...e, name: 'undefined', configId: 0 })), { batchSeq: 4n }));
  const editEntry = (f, fn) => ({ ...f, entries: f.entries.map((e, i) => (i ? e : fn(e))) });
  assert.throws(() => S.parseLaunchBatchFile(editEntry(coerced, (e) => drop(e, 'name', 'configId'))), /BadFile: entry 0: missing configId, name/);
  assert.throws(() => S.parseLaunchBatchFile(editEntry(coerced, (e) => ({ ...e, name: null }))), /BadFile: entry 0: name must be text, not null/);
  assert.throws(() => S.parseLaunchBatchFile(editEntry(file, (e) => ({ ...drop(e, 'configId'), config_id: 0 }))), /missing configId; unexpected config_id/);
  assert.throws(() => S.parseLaunchBatchFile(editEntry(file, (e) => ({ ...e, extra: 1 }))), /unexpected extra/);
  for (const [k, v, re] of [['cityId', 2_643_743, /cityId must be decimal text/], ['configId', '0', /configId must be an integer/], ['metaHash', file.entries[0].metaHash.toUpperCase(), /metaHash must be 64 lower-case/],
    ['founder', [1, 2], /founder must be base58 text/], ['symbol', 1, /symbol must be text/]]) {
    assert.throws(() => S.parseLaunchBatchFile(editEntry(file, (e) => ({ ...e, [k]: v }))), re, k);
  }
  for (const [edit, re] of [[{ seq: 4 }, /seq must be decimal text/], [{ leafCount: '3' }, /leafCount must be an integer/], [{ version: '1' }, /version/],
    [{ root: file.root.toUpperCase() }, /root must be 64 lower-case/], [{ about: 'x' }, /unexpected about/], [{ entries: {} }, /entries must be an array/]]) {
    assert.throws(() => S.parseLaunchBatchFile({ ...file, ...edit }), re, JSON.stringify(edit));
  }
  assert.throws(() => S.parseLaunchBatchFile(drop(file, 'leafCount')), /missing leafCount/);
  assert.throws(() => S.parseLaunchBatchFile('{not json'), /BadFile: not JSON/);
  // the canonical file still reads back, from text or object
  assert.equal(toHex(S.parseLaunchBatchFile(JSON.stringify(file)).root), file.root);
  assert.equal(toHex(S.parseLaunchBatchFile(coerced).root), coerced.root, 'a deliberate "undefined" name is the site\'s choice, written in full');
});

test('R6-DIFF-2 (review round 6) the day\'s changes name the fields that differ: a change of the metadata hash alone is a changed entry naming metaHash', () => {
  const b1 = S.buildLaunchBatch(worked(), { batchSeq: 1n });
  const b2 = S.buildLaunchBatch(worked().map((e, i) => (i === 1 ? { ...e, metaHash: new Uint8Array(32).fill(0xab) } : i === 2 ? { ...e, founder: new Uint8Array(32).fill(0x44), name: 'NYC' } : e)), { batchSeq: 2n });
  const d = S.diffLaunchBatches(S.launchBatchFile(b1), b2);
  assert.deepEqual(d.changed.map((c) => [c.after.cityId, c.fields]), [[2_988_507n, ['metaHash']], [5_128_581n, ['founder', 'name']]]);
  assert.deepEqual(S.LEAF_FIELDS, ['founder', 'configId', 'name', 'symbol', 'metaHash']);
});
