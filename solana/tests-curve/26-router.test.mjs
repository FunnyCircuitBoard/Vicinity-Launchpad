// G02, G03 and R02b (VICINITY-CURVE-DESIGN.md 12.5, 14.3, 4.0) with a test-only
// mock router program (tests-curve/router, built by `npm run curve:router`, or
// here on first use when cargo-build-sbf is on the PATH; never deployed).
//   * G02: the router CPIs buy and sell with `user` the transaction's signer and
//     with `user` a router PDA signing by invoke_signed: balances, events (the
//     event self-CPI at depth 3) and every invariant hold; a PDA carrying data
//     as `user` of a buy is refused by the system transfer and the SDK predicts
//     it; the partial fill's leftover stays with the router PDA.
//   * G03: "pay with any token": a swap that delivers SOL, then our buy, in one
//     transaction (sdk/curve/compose.mjs). With sol_in = otherAmountThreshold
//     (ExactIn) or outAmount (ExactOut) the buy never spends SOL the user
//     already had, whatever the swap delivers above its minimum; a swap below
//     its minimum fails and moves nothing; the naive sol_in = outAmount does
//     spend the user's own SOL when the swap under-delivers.
//   * R02b: the rule of 4.0 on the same runtime: a direct lamport move followed
//     by a CPI to SyncNative that lists only the credited WSOL account fails
//     with UnbalancedInstruction; the same CPI listing both accounts passes;
//     the move alone followed by a top-level SyncNative (forward_holders_fees'
//     pattern) passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { address } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, SOL, LAMPORTS, expectFail, tokenAccountInfo } from './helpers.mjs';

const ROUTER_SO = process.env.VCURVE_ROUTER_SO || join(SOL, 'target', 'curve-router', 'deploy', 'curve_test_router.so');
/** A fixed throwaway address for the router (no key behind it). */
const ROUTER_ID = new web3.PublicKey(createHash('sha256').update('vicinity curve test router').digest()).toBase58();

function routerSo() {
  if (!existsSync(ROUTER_SO)) {
    execFileSync('cargo', ['build-sbf', '--manifest-path', join(SOL, 'tests-curve', 'router', 'Cargo.toml'), '--sbf-out-dir', join(SOL, 'target', 'curve-router', 'deploy')],
      { env: { ...process.env, CARGO_TARGET_DIR: join(SOL, 'target', 'curve-router') }, stdio: 'inherit', timeout: 900_000 });
  }
  assert.ok(existsSync(ROUTER_SO), `missing ${ROUTER_SO}: run "npm run curve:router"`);
  return ROUTER_SO;
}
async function world() {
  const w = await World.create();
  w.svm.addProgramFromFile(address(ROUTER_ID), routerSo());
  return w;
}
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const pda = (tag) => S.findPda([Buffer.from('router'), Buffer.from(tag)], ROUTER_ID);
/** The router's `forward` (0) or `forward as PDA` (1) around one vicinity_curve instruction. */
function routed(inner, as) {
  const head = as ? Buffer.concat([Buffer.from([1, as.bump]), Buffer.from(as.tag)]) : Buffer.from([0]);
  return {
    programAddress: ROUTER_ID,
    accounts: [{ address: inner.programAddress, role: S.Role.R }, ...inner.accounts.map((a) => (as && a.address === as.address ? { address: a.address, role: S.Role.W } : a))],
    data: new Uint8Array(Buffer.concat([head, Buffer.from(inner.data)])),
  };
}

test('G02: a router CPIs buy and sell for the signing user; events come from the program at depth 3; every invariant holds', async () => {
  const w = await world();
  const h = await w.launchCoin({ cityId: 2_600n, symbol: 'RTR' });
  const u = await w.signer(100n);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: u.address, owner: u.address, mint: h.mint })], [u], 'user ATA');
  const c0 = w.coinView(h);
  const q = S.quoteBuy(S.coinTerms(c0), S.coinState(c0), LAMPORTS);
  const lam0 = w.lamportsOf(u.address);
  const r = await w.send([routed(w.ix.buy({ user: u.address, coin: h.coin, userTokenAccount: w.ata(u.address, h.mint), solIn: LAMPORTS, minTokensOut: q.tokensOut }))], [u], 'router: buy for the signer');
  w.addHolder(h.mint, u);
  const ctx = w.lastCtx;
  assert.equal(ctx.tx.calls.length, 1);
  const call = ctx.tx.calls[0];
  assert.deepEqual([call.name, call.depth, call.viaCpi], ['buy', 2, true]);
  const evIx = call.inner.filter((ii) => ii.program === w.programId);
  assert.deepEqual(evIx.map((ii) => ii.stackHeight), [3], 'the event self-CPI at depth 3');
  assert.deepEqual(call.inner.filter((ii) => ii.program !== w.programId).map((ii) => ii.stackHeight), [3, 3], 'the system transfer and the token transfer at depth 3');
  const t = r.events.find((e) => e.name === 'Trade').data;
  assert.deepEqual([t.user, t.sol_amount, t.token_amount], [u.address, q.charged, q.tokensOut]);
  assert.equal(lam0 - w.lamportsOf(u.address), q.charged);
  // and a sell through the router
  const c1 = w.coinView(h); const half = w.balanceOf(u, h.mint) / 2n;
  const qs = S.quoteSell(S.coinTerms(c1), S.coinState(c1), half);
  const lam1 = w.lamportsOf(u.address);
  await w.send([routed(w.ix.sell({ user: u.address, coin: h.coin, userTokenAccount: w.ata(u.address, h.mint), tokensIn: half, minSolOut: qs.solOut }))], [u], 'router: sell for the signer');
  assert.equal(w.lamportsOf(u.address) - lam1, qs.solOut);
  await w.finish();
});

test('G02: a router PDA as user signs by invoke_signed; balances and events are the PDA\'s; the partial fill\'s leftover stays with it; a PDA carrying data cannot buy', async () => {
  const w = await world();
  const h = await w.launchCoin({ cityId: 2_601n, symbol: 'RPDA' });
  const tag = '00000001';
  const [p, bump] = pda(tag);
  const as = { address: p, bump, tag };
  w.setRaw(p, Buffer.alloc(0), S.ADDRESSES.system, 200n * LAMPORTS); // a system account without data, as a router's PDA wallet
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: w.payer.address, owner: p, mint: h.mint })], [], 'the PDA\'s token account');
  const pAta = w.ata(p, h.mint);
  // the SDK's pre-check agrees: a system account without data may buy
  const c0 = w.coinView(h);
  S.precheckBuy({ coin: c0, userAccount: w.accountInfo(p), solIn: 5n * LAMPORTS, rentExemptMinimum: w.svm.minimumBalanceForRentExemption(0n) });
  const before = w.lamportsOf(p);
  const r = await w.send([routed(w.ix.buy({ user: p, coin: h.coin, userTokenAccount: pAta, solIn: 5n * LAMPORTS, minTokensOut: 0n }), as)], [], 'router PDA buys');
  const t = r.events.find((e) => e.name === 'Trade').data;
  assert.equal(t.user, p);
  assert.equal(before - w.lamportsOf(p), t.sol_amount);
  assert.equal(tokenAccountInfo(w.accountInfo(pAta)).amount, t.token_amount);
  // the buy that completes the curve, with more than it needs: the PDA keeps the difference
  const c1 = w.coinView(h);
  const g = S.maxQuoteIn(S.coinTerms(c1), S.coinState(c1));
  const offered = g + 7n * LAMPORTS;
  const b2 = w.lamportsOf(p);
  const r2 = await w.send([routed(w.ix.buy({ user: p, coin: h.coin, userTokenAccount: pAta, solIn: offered, minTokensOut: 0n }), as)], [], 'router PDA completes the curve');
  const t2 = r2.events.find((e) => e.name === 'Trade').data;
  assert.ok(t2.partial && t2.graduated && t2.sol_amount < offered);
  assert.equal(b2 - w.lamportsOf(p), t2.sol_amount, 'only `charged` left the PDA; the rest stays with the router');
  // the PDA sells in the pool and receives native SOL
  const tokens = tokenAccountInfo(w.accountInfo(pAta)).amount / 4n;
  const c2 = w.coinView(h); const qs = S.quoteSell(S.coinTerms(c2), S.coinState(c2), tokens);
  const b3 = w.lamportsOf(p);
  await w.send([routed(w.ix.sell({ user: p, coin: h.coin, userTokenAccount: pAta, tokensIn: tokens, minSolOut: qs.solOut }), as)], [], 'router PDA sells in the pool');
  assert.equal(w.lamportsOf(p) - b3, qs.solOut);
  // a PDA that carries data cannot be the user of a buy: the SDK says so and the system transfer refuses it
  const tag2 = '00000002';
  const [p2, bump2] = pda(tag2);
  w.setRaw(p2, Buffer.alloc(16), S.ADDRESSES.system, 50n * LAMPORTS);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: w.payer.address, owner: p2, mint: h.mint })], [], 'the data PDA\'s token account');
  assert.throws(() => S.precheckBuyer({ userAccount: w.accountInfo(p2), charged: LAMPORTS }), (e) => e.code === 'BuyerCarriesData');
  await expectFail(() => w.send([routed(w.ix.buy({ user: p2, coin: h.coin, userTokenAccount: w.ata(p2, h.mint), solIn: LAMPORTS, minTokensOut: 0n }), { address: p2, bump: bump2, tag: tag2 })], [], 'a PDA with data buys'),
    /must not carry data|custom program error: 0x3/i);
  await w.finish();
});

test('G03: pay with any token: a swap delivering SOL then the buy; sol_in from the quote\'s minimum never spends SOL the user already had', async () => {
  const w = await world();
  const h = await w.launchCoin({ cityId: 2_602n, symbol: 'SWAP' });
  const pool = S.findPda([Buffer.from('pool')], ROUTER_ID)[0];
  w.setRaw(pool, Buffer.alloc(0), ROUTER_ID, 10_000n * LAMPORTS); // the mock swap's SOL, owned by the router
  const swap = (user, amount, minOut) => ({ programAddress: ROUTER_ID, accounts: [{ address: pool, role: S.Role.W }, { address: String(user), role: S.Role.W }],
    data: new Uint8Array(Buffer.concat([Buffer.from([3]), u64(amount), u64(minOut)])) });
  const ataRent = w.svm.minimumBalanceForRentExemption(165n);
  const run = async (label, { delivered, quote }) => {
    const u = await w.signer(3n); // the SOL the user already had
    const own = w.lamportsOf(u.address);
    const minOut = BigInt(quote.swapMode === 'ExactOut' ? quote.outAmount : quote.otherAmountThreshold);
    const { instructions, solIn } = S.buyWithSwap({ ix: w.ix, user: u.address, coin: h.coin, mint: h.mint, swapInstructions: [swap(u.address, delivered, minOut)], quote, coinAccount: w.coinView(h), slippageBps: S.LARGE_BUY_MAX_SLIPPAGE_BPS });
    const r = await w.send(instructions, [u], label);
    w.addHolder(h.mint, u);
    const t = r.events.find((e) => e.name === 'Trade').data;
    assert.ok(t.sol_amount <= solIn);
    const after = w.lamportsOf(u.address);
    assert.equal(after, own - ataRent + delivered - t.sol_amount);
    assert.ok(after >= own - ataRent, `${label}: the user's own SOL was not spent`);
    return { solIn, t };
  };
  const Q = 2n * LAMPORTS; const T = Q - Q / 100n; // quoted 2 SOL out, at least 1.98 SOL (1% slippage)
  const exactIn = { swapMode: 'ExactIn', outAmount: Q, otherAmountThreshold: T };
  assert.equal((await run('swap delivers as quoted', { delivered: Q, quote: exactIn })).solIn, T, 'sol_in = otherAmountThreshold');
  await run('swap delivers its minimum', { delivered: T, quote: exactIn });
  await run('ExactOut: the swap delivers exactly sol_in', { delivered: Q, quote: { swapMode: 'ExactOut', outAmount: Q, otherAmountThreshold: Q * 2n } });
  // below its minimum the swap fails and nothing moves (the buy never runs)
  const u = await w.signer(3n);
  const { instructions } = S.buyWithSwap({ ix: w.ix, user: u.address, coin: h.coin, mint: h.mint, swapInstructions: [swap(u.address, T - 1n, T)], quote: exactIn, coinAccount: w.coinView(h), slippageBps: S.LARGE_BUY_MAX_SLIPPAGE_BPS });
  await expectFail(() => w.send(instructions, [u], 'swap below its minimum'), /custom program error: 0x1\b/);
  // the hazard the rule avoids: sol_in = outAmount with a swap delivering only its minimum spends the user's own SOL
  const v = await w.signer(3n); const own = w.lamportsOf(v.address);
  const naive = [swap(v.address, T, T), S.createAssociatedTokenAccountIdempotent({ payer: v.address, owner: v.address, mint: h.mint }), w.ix.buy({ user: v.address, coin: h.coin, solIn: Q, minTokensOut: 0n })];
  await w.send(naive, [v], 'naive sol_in = outAmount');
  w.addHolder(h.mint, v);
  assert.equal(own - ataRent - w.lamportsOf(v.address), Q - T, 'the naive composition spent the difference from the user\'s own SOL');
  assert.throws(() => S.solInFromSwapQuote({ swapMode: 'ExactIn', outAmount: 1n, otherAmountThreshold: 2n }), /otherAmountThreshold above outAmount/);
  assert.throws(() => S.solInFromSwapQuote({ swapMode: 'Other' }), /unknown swapMode/);
  await w.finish();
});

test('R02b: a CPI after a direct lamport move must list every account whose lamports moved (UnbalancedInstruction otherwise); forward_holders_fees\' top-level SyncNative is the safe pattern', async () => {
  const w = await world();
  const owner = await w.signer(5n);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: owner.address, owner: owner.address, mint: S.ADDRESSES.nativeMint })], [owner], 'a WSOL token account');
  const vault = w.ata(owner.address, S.ADDRESSES.nativeMint);
  const source = S.findPda([Buffer.from('bucket')], ROUTER_ID)[0];
  w.setRaw(source, Buffer.alloc(0), ROUTER_ID, 50n * LAMPORTS); // like a Coin: owned by the program that debits it
  const move = (flag, amount) => ({ programAddress: ROUTER_ID, accounts: [{ address: source, role: S.Role.W }, { address: vault, role: S.Role.W }, { address: S.ADDRESSES.token, role: S.Role.R }, { address: ROUTER_ID, role: S.Role.R }],
    data: new Uint8Array(Buffer.concat([Buffer.from([2, flag]), u64(amount)])) });
  const amount0 = () => tokenAccountInfo(w.accountInfo(vault)).amount;
  // pay_out then SyncNative listing only the vault: refused by the runtime, nothing moves
  const e = await expectFail(() => w.send([move(0, LAMPORTS)], [], 'move, then SyncNative(vault) by CPI'), /UnbalancedInstruction|sum of account balances before and after instruction do not match/i);
  assert.ok(e);
  // a CPI that lists both accounts first (here a no-op call of the router): balanced, and the SyncNative after it passes
  const a0 = amount0();
  await w.send([move(1, LAMPORTS)], [], 'move, a CPI listing both accounts, then SyncNative(vault)');
  assert.equal(amount0() - a0, LAMPORTS);
  // forward_holders_fees' pattern: the move in one instruction, SyncNative as the next top-level instruction
  const move3 = { programAddress: ROUTER_ID, accounts: [{ address: source, role: S.Role.W }, { address: vault, role: S.Role.W }], data: new Uint8Array(Buffer.concat([Buffer.from([3]), u64(LAMPORTS), u64(0)])) };
  const a1 = amount0();
  await w.send([move3, S.syncNative({ account: vault })], [], 'move, then a top-level SyncNative');
  assert.equal(amount0() - a1, LAMPORTS);
  await w.finish();
});
