// CK1 (VICINITY-CURVE-DESIGN.md 12.5, I23 to I25): the per-transaction checker of the batch launch approval, tested
// against the checker itself, as 27-checker-gaps does for the other rules. Real transactions (a batch launch, a
// publication, a clear, a buy) are replayed through checkTransaction with one fact doctored: a launch after a clear,
// under a superseded root, before or after its window, with a proof against another root, while the path is halted,
// while no approver is set, while the city's Approval exists, by a founder holding a role; a publication by a stranger,
// while halted, or recorded differently than it was sent; a clear by a key that may not clear; a LaunchBatch written by
// an instruction that may not write it; an approver that holds another seat. Each must be refused; the real ones pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, LAMPORTS } from './helpers.mjs';
import { checkTransaction } from './invariants.mjs';

const ZERO = S.ADDRESSES.system;
const run = (w, ctx) => { try { checkTransaction(w, ctx); return 'accepted'; } catch (e) { return `refused: ${e.message.split('\n')[0]}`; } };
const rec = (r, edit) => ({ ...r, root: Uint8Array.from(r.root), ...edit });
/** `ctx` with the LaunchBatch before and after the transaction edited the same way (a launch never writes it). */
const withBatch = (ctx, edit) => {
  const e = (lb) => (lb ? { ...lb, latest: rec(lb.latest, edit.latest), previous: rec(lb.previous, edit.previous), ...(edit.halted !== undefined ? { halted: edit.halted } : {}) } : lb);
  return { ...ctx, pre: { ...ctx.pre, launchBatch: e(ctx.pre.launchBatch) }, post: { ...ctx.post, launchBatch: e(ctx.post.launchBatch) } };
};
const withLaunchpad = (ctx, edit, { post = true } = {}) => ({ ...ctx, pre: { ...ctx.pre, launchpad: { ...ctx.pre.launchpad, ...edit } }, post: post ? { ...ctx.post, launchpad: { ...ctx.post.launchpad, ...edit } } : ctx.post });

test('CK1 the checker holds every batch launch to the batch of its moment (I23): a doctored clear, supersession, window, root, halt, approver, pending approval or founder role is refused', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const [a, b, c] = [await w.signer(20n), await w.signer(20n), await w.signer(20n)];
  const bt = await w.publishBatch([{ cityId: 3001n, founder: a, symbol: 'CKA' }, { cityId: 3002n, founder: b, symbol: 'CKB' }, { cityId: 3003n, founder: c, symbol: 'CKC' }]);
  w.warpTo(bt.validFrom);
  await w.launchFromBatch({ batch: bt, cityId: 3001n, founder: a });
  const L = w.lastCtx;
  assert.equal(run(w, L), 'accepted', 'control: the real batch launch');
  const now = L.post.ts;
  const latest = L.pre.launchBatch.latest;
  for (const [what, ctx, re] of [
    ['a launch after a clear', withBatch(L, { latest: { cleared: true }, previous: { cleared: true } }), /I23 .*not in force \(BatchCleared\)/],
    ['a launch under a superseded root', { ...withBatch(L, {}), pre: { ...L.pre, launchBatch: { ...L.pre.launchBatch, previous: rec(latest), latest: rec(latest, { seq: latest.seq + 1n, root: new Uint8Array(32).fill(5), validFrom: now - 1n, publishedAt: now - 1n - S.BATCH_REVIEW_SECS }) } },
      post: { ...L.post, launchBatch: { ...L.post.launchBatch, previous: rec(latest), latest: rec(latest, { seq: latest.seq + 1n, root: new Uint8Array(32).fill(5), validFrom: now - 1n, publishedAt: now - 1n - S.BATCH_REVIEW_SECS }) } } }, /I23 .*not in force \(BatchSuperseded\)/],
    ['a launch before its window', withBatch(L, { latest: { validFrom: now + 1n, validUntil: now + 100n, publishedAt: now + 1n - S.BATCH_REVIEW_SECS } }), /I23 .*not in force \(BatchNotYetValid\)/],
    ['a launch after its window', withBatch(L, { latest: { validUntil: now - 1n, validFrom: now - 100n, publishedAt: now - 100n - S.BATCH_REVIEW_SECS } }), /I23 .*not in force \(BatchExpired\)/],
    ['a proof against another root', withBatch(L, { latest: { root: new Uint8Array(32).fill(9) } }), /I23 the leaf of city 3001 does not fold/],
    ['a launch while the path is halted', withBatch(L, { halted: true }), /I23 .*not in force \(BatchesHalted\)/],
    ['a launch from a former approver\'s batch', withBatch(L, { latest: { publisher: String(b.address) } }), /I23 .*not in force \(BatchSuperseded\)/],
    ['a launch while no approver was set', withLaunchpad(L, { launchApprover: ZERO }), /I23 a batch launch while no launch approver was set/],
    ['a launch while the city\'s Approval existed', { ...L, pre: { ...L.pre, approvals: new Map([...L.pre.approvals, [w.P.approval(3001n), { cityId: 3001n, founder: String(b.address), rentPayer: w.admin.address }]]) } }, /I23 a batch launch of city 3001 while its Approval existed/],
    ['a launch by a founder who is the guardian of that moment', withLaunchpad(L, { guardian: String(a.address) }), /I2[03] .*guardian/],
    ['a launch by a founder who is the approver of that moment', withLaunchpad(L, { launchApprover: String(a.address) }), /I2[035] .*(approver|not in force)/],
  ]) assert.match(run(w, ctx), re, what);
  // the leaf's proof length bound: the batch recorded with fewer leaves than the proof needs
  assert.match(run(w, withBatch(L, { latest: { leafCount: 1 } })), /I23 a proof of 2 hashes for 1 leaves/);
  // the new Coin must hold the leaf's terms: the founder seat edited after the fact
  const coin = [...L.post.coins.values()].find((x) => x.cityId === 3001n);
  assert.match(run(w, { ...L, post: { ...L.post, coins: new Map([...L.post.coins, [coin.address, { ...coin, founder: String(b.address) }]]) } }), /^refused/);
  await w.finish();
});

test('CK1 the checker walks LaunchBatch through every call (I24, I25): a publication by a stranger or while halted, a clear by a key that may not clear, a write by another instruction, an approver holding a seat, are refused', async () => {
  const w = await World.create();
  const approver = await w.initBatchPath();
  const f = await w.signer(20n); const u = await w.signer(20n);
  const bt = await w.publishBatch([{ cityId: 3101n, founder: f, symbol: 'CKD' }, { cityId: 3102n, founder: u, symbol: 'CKE' }]);
  const P = w.lastCtx;
  assert.equal(run(w, P), 'accepted', 'control: the real publication');
  const stranger = String((await w.signer(1n)).address);
  // a publication signed by someone the walk does not see as the approver of its moment
  assert.match(run(w, withLaunchpad(P, { launchApprover: stranger })), /I24 a publication not signed by the approver/);
  // a publication while the path was halted (the account before it halted)
  assert.match(run(w, { ...P, pre: { ...P.pre, launchBatch: { ...P.pre.launchBatch, halted: true } }, post: { ...P.post, launchBatch: { ...P.post.launchBatch, halted: true } } }), /I24 a publication while the batch path was halted/);
  // the stored record differs from what was sent
  assert.match(run(w, { ...P, post: { ...P.post, launchBatch: { ...P.post.launchBatch, latest: rec(P.post.launchBatch.latest, { leafCount: 3 }) } } }), /I24 the walk's latest record/);
  assert.match(run(w, { ...P, post: { ...P.post, launchBatch: { ...P.post.launchBatch, latest: rec(P.post.launchBatch.latest, { validFrom: P.post.ts }) } } }), /I24 the walk's latest record/);
  // a publication that skipped a number (the account before it one lower)
  assert.match(run(w, { ...P, pre: { ...P.pre, launchBatch: { ...P.pre.launchBatch, latest: rec(P.pre.launchBatch.latest, { seq: 5n }) } } }), /I24 latest.seq grows by exactly 1/);
  // a clear by a key that is not the admin, the approver or the guardian of its moment
  w.warpTo(bt.validFrom);
  await w.send([w.ix.clearLaunchBatch({ authority: w.guardian.address, halt: false })], [w.guardian], 'clear by the guardian');
  const C = w.lastCtx;
  assert.equal(run(w, C), 'accepted', 'control: the real clear');
  assert.match(run(w, withLaunchpad(C, { guardian: stranger })), /I24 a clear by/);
  // a clear recorded without its effect
  assert.match(run(w, { ...C, post: { ...C.post, launchBatch: { ...C.post.launchBatch, latest: rec(C.post.launchBatch.latest, { cleared: false }) } } }), /I24 the walk's latest record/);
  // LaunchBatch written by an instruction that may not write it: a buy that "un-clears" a record
  const h = await w.launchCoin({ cityId: 3103n, founder: await w.signer(20n), symbol: 'CKF' });
  await w.buy(u, h, LAMPORTS);
  const B = w.lastCtx;
  assert.equal(run(w, B), 'accepted', 'control: a buy');
  assert.match(run(w, { ...B, post: { ...B.post, launchBatch: { ...B.post.launchBatch, latest: rec(B.post.launchBatch.latest, { cleared: false }) } } }), /I24 the walk's latest record/);
  assert.match(run(w, { ...B, post: { ...B.post, launchBatch: { ...B.post.launchBatch, halted: true } } }), /I24 the walk's halted/);
  // I25: an approver that holds another seat after any transaction
  for (const seat of ['guardian', 'payoutAuthority', 'payoutDestination', 'pendingAdmin', 'admin']) {
    const lp = { ...B.post.launchpad, [seat]: approver.address };
    assert.match(run(w, { ...B, pre: { ...B.pre, launchpad: { ...B.pre.launchpad, [seat]: approver.address } }, post: { ...B.post, launchpad: lp } }), /^refused/, seat);
  }
  // the launch approver changed outside set_launch_approver
  assert.match(run(w, { ...B, post: { ...B.post, launchpad: { ...B.post.launchpad, launchApprover: stranger } } }), /^refused/);
  await w.finish();
});
