// The invariant checker's newer rules, tested against the checker itself
// (VICINITY-CURVE-DESIGN.md 9: I5, I6, I14, I20, I21). Each rule runs after
// every transaction of every suite; here each one is shown to refuse what it
// must: a real transaction's decoded instructions replayed with one
// destination or one CPI changed (I14), a buy that the program allows but no
// test may make, delivering coins to a role key (I21), program code edited
// without an upgrade and binaries of the wrong cluster (I20). I5 and I6 are
// exercised in multi-instruction transactions: a graduation followed by pool
// trades and a buyback in the same transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import web3 from '@solana/web3.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { World, S, LAMPORTS, PATHS, SOL } from './helpers.mjs';
import { checkDestinations, compiledIdsProblems, PROGRAM_DATA_HEADER } from './invariants.mjs';

/** A deep copy of a decoded transaction whose `top[i].inner[j]` is replaced by `edit(copy)`. */
function edited(tx, i, j, edit) {
  const top = tx.top.map((t) => ({ ...t, accounts: [...t.accounts], inner: t.inner.map((ii) => ({ ...ii, accounts: [...ii.accounts], data: Buffer.from(ii.data) })) }));
  if (j === null) top[i].inner.push(edit(null)); else top[i].inner[j] = edit(top[i].inner[j]);
  return { ...tx, top };
}
const findInner = (tx, name, pred) => {
  const i = tx.top.findIndex((t) => t.name === name);
  const j = tx.top[i].inner.findIndex(pred);
  assert.ok(i >= 0 && j >= 0, `no such inner instruction in ${name}`);
  return [i, j];
};
const web3Key = web3.PublicKey;
const isSys = (tag) => (ii) => ii.program === S.ADDRESSES.system && ii.data.readUInt32LE(0) === tag;

test('I14 destinations: every system transfer and creation inside launch and buy is pinned; one changed destination or one foreign CPI fails the checker', async () => {
  const w = await World.create();
  const founder = await w.signer(100n);
  await w.approve({ cityId: 2_001n, founder, symbol: 'DST' });
  const h = await w.launch({ cityId: 2_001n, founder });
  const ctx = w.lastCtx;
  const run = (tx) => checkDestinations(w, { ...ctx, tx });
  run(ctx.tx); // the real launch passes
  const stranger = (await w.signer(0n)).address;
  // the launch fee to someone else than FEE_RECIPIENT
  let [i, j] = findInner(ctx.tx, 'launch', (ii) => isSys(2)(ii) && ii.accounts[1] === S.ADDRESSES.feeRecipient);
  assert.throws(() => run(edited(ctx.tx, i, j, (ii) => ({ ...ii, accounts: [ii.accounts[0], w.admin.address] }))), /I14 launch's transfer to .* which it does not create/);
  // an account creation for an address the instruction does not create
  [i, j] = findInner(ctx.tx, 'launch', isSys(0));
  assert.throws(() => run(edited(ctx.tx, i, j, (ii) => ({ ...ii, accounts: [ii.accounts[0], stranger] }))), /I14 launch's create_account to/);
  // a creation paid by someone else than the instruction's payer
  assert.throws(() => run(edited(ctx.tx, i, j, (ii) => ({ ...ii, accounts: [w.admin.address, ii.accounts[1]] }))), /not its payer/);
  // a creation assigned to another owner
  assert.throws(() => run(edited(ctx.tx, i, j, (ii) => { const d = Buffer.from(ii.data); new web3Key(S.ADDRESSES.token2022).toBuffer().copy(d, 20); return { ...ii, data: d }; })), /assigned to/);
  // Metaplex's own transfer to another account than the metadata it creates
  [i, j] = findInner(ctx.tx, 'launch', (ii) => isSys(2)(ii) && ii.stackHeight === 3);
  assert.throws(() => run(edited(ctx.tx, i, j, (ii) => ({ ...ii, accounts: [ii.accounts[0], stranger] }))), /Metaplex's transfer to .* not the metadata account/);
  // more than rent plus Metaplex's 0.01 SOL into the metadata account
  assert.throws(() => run(edited(ctx.tx, i, j, (ii) => { const d = Buffer.from(ii.data); d.writeBigUInt64LE(ii.data.readBigUInt64LE(4) + 1n, 4); return { ...ii, data: d }; })), /rent plus 0.01 SOL at most/);
  // a CPI to a program other than System, SPL Token, Metaplex and the event CPI
  assert.throws(() => run(edited(ctx.tx, i, null, () => ({ program: S.ADDRESSES.token2022, accounts: [h.coin], data: Buffer.from([3]), stackHeight: 2 }))), /I14 launch called Tokenz/);
  // a system instruction other than transfer, create, allocate and assign
  assert.throws(() => run(edited(ctx.tx, i, null, () => ({ program: S.ADDRESSES.system, accounts: [founder.address, h.coin], data: Buffer.from([11, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), stackHeight: 2 }))), /which it does not create|system instruction 11/);

  // buy: the one transfer goes from the buyer to the Coin and nowhere else
  const u = await w.signer(10n);
  await w.buy(u, h, LAMPORTS);
  const b = w.lastCtx;
  checkDestinations(w, b);
  [i, j] = findInner(b.tx, 'buy', isSys(2));
  assert.throws(() => checkDestinations(w, { ...b, tx: edited(b.tx, i, j, (ii) => ({ ...ii, accounts: [ii.accounts[0], S.ADDRESSES.feeRecipient] })) }), /I14 buy's transfer to .* not the Coin/);
  assert.throws(() => checkDestinations(w, { ...b, tx: edited(b.tx, i, null, () => ({ program: S.ADDRESSES.system, accounts: [u.address, stranger], data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), stackHeight: 2 })) }), /not the Coin/);
  // the associated token program's creation goes to the token account it creates
  const ata = b.tx.top.findIndex((t) => t.program === S.ADDRESSES.associatedToken);
  const k = b.tx.top[ata].inner.findIndex(isSys(0));
  assert.throws(() => checkDestinations(w, { ...b, tx: edited(b.tx, ata, k, (ii) => ({ ...ii, accounts: [ii.accounts[0], stranger] })) }), /associated token program's create_account to/);

  // a withdrawal makes no system instruction at all
  await w.withdraw(h);
  const wd = w.lastCtx;
  const wi = wd.tx.top.findIndex((t) => t.name === 'withdraw_platform_fees');
  assert.throws(() => checkDestinations(w, { ...wd, tx: edited(wd.tx, wi, null, () => ({ program: S.ADDRESSES.system, accounts: [h.coin, w.admin.address], data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), stackHeight: 2 })) }), /withdraw_platform_fees's transfer/);
  await w.finish();
});
test('I21 tokens: a buy that delivers coins to a token account owned by a role key fails the checker (the program allows it: a router may name any account of the mint, 14.3)', async () => {
  for (const role of ['admin', 'guardian', 'keeper', 'deployer']) {
    const w = await World.create();
    const h = await w.launchCoin({ cityId: 2_010n, symbol: 'ROLE' });
    const u = await w.signer(10n);
    const key = w[role];
    await w.send([S.createAssociatedTokenAccountIdempotent({ payer: u.address, owner: key.address, mint: h.mint })], [u], `ATA of the ${role}`);
    const roleAta = S.associatedTokenAddress(key.address, h.mint);
    await assert.rejects(() => w.send([w.ix.buy({ user: u.address, coin: h.coin, userTokenAccount: roleAta, solIn: LAMPORTS, minTokensOut: 0n })], [u], `buy for the ${role}`),
      new RegExp(`I21 coins delivered to a token account whose owner is the role key ${key.address}`));
    // the program did deliver (the transaction is committed); the checker is what refuses it in every test
    assert.ok(w.tokenBalance(roleAta) > 0n);
  }
  // a stranger's account delegated to the admin is refused too
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_011n, symbol: 'DLG' });
  const u = await w.signer(10n); const v = await w.signer(10n);
  await w.buy(v, h, LAMPORTS);
  const vAta = S.associatedTokenAddress(v.address, h.mint);
  const approve = Buffer.alloc(9); approve[0] = 4; approve.writeBigUInt64LE(1n, 1);
  await w.send([{ programAddress: S.ADDRESSES.token, accounts: [{ address: vAta, role: S.Role.W }, { address: w.admin.address, role: S.Role.R }, { address: v.address, role: S.Role.RS }], data: new Uint8Array(approve) }], [v], 'v approves the admin as delegate');
  await assert.rejects(() => w.send([w.ix.buy({ user: u.address, coin: h.coin, userTokenAccount: vAta, solIn: LAMPORTS, minTokensOut: 0n })], [u], 'buy into an account the admin may spend'), /I21 coins delivered to a token account whose delegate is the role key/);
});

test('I20 at run time: program code edited without an upgrade fails the checker; each binary carries the ids of its own cluster only', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_020n, symbol: 'IDS' });
  const pd = w.P.programData();
  const acc = w.svm.getAccount(address(pd));
  const data = Buffer.from(acc.data);
  // the upgrade authority field may change (set_authority is not an upgrade): the checker accepts it
  const header = Buffer.from(data); header[12] = 0;
  w.svm.setAccount({ ...acc, address: address(pd), data: new Uint8Array(header) });
  await w.withdraw(h).catch(() => {}); // nothing pending is fine; no I20 complaint either way
  w.svm.setAccount({ ...acc, address: address(pd), data: new Uint8Array(data) });
  // one byte of code changed behind the loader's back: the next transaction (successful or not) fails I20
  const code = Buffer.from(data);
  // flip the case of one letter of set_guardian's log line, so every other instruction still runs
  const elf = data.subarray(PROGRAM_DATA_HEADER);
  const s = elf.indexOf(Buffer.from('Instruction: SetGuardian'));
  assert.ok(s > 0, 'the log line is in the binary');
  code[PROGRAM_DATA_HEADER + s + 13] ^= 0x20;
  w.svm.setAccount({ ...acc, address: address(pd), data: new Uint8Array(code) });
  const u = await w.signer(10n);
  await assert.rejects(() => w.buy(u, h, LAMPORTS), /I20 the code of nhgCm\w+ changed without an upgrade/);
  // an upgrade through the World (loadCurve) is recorded and accepted
  w.loadCurve(PATHS.curve);
  await w.buy(u, h, LAMPORTS, { label: 'after the upgrade' });
  // the static part of the rule, on the three builds
  const prod = readFileSync(PATHS.curve);
  assert.deepEqual(compiledIdsProblems(prod, { programId: w.programId, cluster: 'mainnet' }), []);
  assert.ok(compiledIdsProblems(prod, { programId: w.programId, cluster: 'devnet' }).length >= 2);
  const devnet = join(SOL, 'target', 'vcurve-builds', 'devnet', 'vicinity_curve.so');
  if (existsSync(devnet)) {
    assert.deepEqual(compiledIdsProblems(readFileSync(devnet), { programId: w.programId, cluster: 'devnet' }), []);
    assert.ok(compiledIdsProblems(readFileSync(devnet), { programId: w.programId, cluster: 'mainnet' }).length >= 2, 'the devnet build is refused as a mainnet build');
  }
  if (existsSync(PATHS.curveHaltAll)) assert.deepEqual(compiledIdsProblems(readFileSync(PATHS.curveHaltAll), { programId: w.programId, cluster: 'mainnet' }), []);
  await w.finish();
});

test('I5 and I6 inside one transaction: the graduating buy, two pool trades and a pool buyback in one transaction; each event keeps X * Y, the vault holds P at graduation', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_030n, symbol: 'MULTI' });
  const u = await w.signer(500n); const v = await w.signer(500n);
  await w.buy(u, h, 10n * LAMPORTS);
  w.warpSlots(200n);
  const c = w.coinView(h);
  const g = S.maxQuoteIn(S.coinTerms(c), S.coinState(c));
  const vAta = S.associatedTokenAddress(v.address, h.mint);
  const ixs = [
    S.createAssociatedTokenAccountIdempotent({ payer: v.address, owner: v.address, mint: h.mint }),
    w.ix.buy({ user: v.address, coin: h.coin, solIn: g, minTokensOut: 0n }),
    w.ix.buy({ user: v.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n }),
    w.ix.sell({ user: u.address, coin: h.coin, tokensIn: w.balanceOf(u, h.mint) / 2n, minSolOut: 0n }),
    w.ix.buybackBurn({ coin: h.coin }),
  ];
  const r = await w.send(ixs, [u, v], 'graduate, trade in the pool and buy back, in one transaction');
  w.addHolder(h.mint, v);
  const names = r.events.map((e) => e.name);
  assert.deepEqual(names, ['Trade', 'Graduated', 'Trade', 'Trade', 'BuybackBurned']);
  const after = w.coinView(h);
  assert.equal(after.phase, 1);
  assert.ok(w.tokenBalance(vAta) > 0n);
  await w.finish();
});

test('the checker reads every coin a transaction can touch: a coin loaded only through its metadata account (found by the long F02 run at step 22,047)', async () => {
  const w = await World.create();
  const a = await w.launchCoin({ cityId: 2_040n, symbol: 'META' });
  const b = await w.launchCoin({ cityId: 2_041n, symbol: 'METB' });
  const u = await w.signer(10n);
  // a buy of A that also lists B's metadata account (an extra account the program ignores)
  const ixs = w.buyIxs(u, a, LAMPORTS, 0n);
  const buy = ixs[ixs.length - 1];
  ixs[ixs.length - 1] = { ...buy, accounts: [...buy.accounts, { address: S.metadataAddress(b.mint), role: S.Role.R }] };
  await w.send(ixs, [u], 'buy of A listing the metadata of B');
  w.addHolder(a.mint, u);
  await w.finish();
});
