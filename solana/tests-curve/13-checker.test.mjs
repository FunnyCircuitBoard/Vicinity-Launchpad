// L13 (12 intro, I9 to I11, I13, I14, T7, T8, T56, X40b): the invariant checker
// and money-flow tracer themselves. Declared donations of lamports and coins
// and a holder's own burn keep every invariant (with I9, I10 and I11 counting
// them); the same movements undeclared, or a Coin edited behind the program's
// back, make the checker fail; an event instruction not signed by the event
// authority is refused by the program.
import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { World, S, expectFail, mintInfo, LAMPORTS } from './helpers.mjs';

const systemTransfer = (from, to, lamports) => {
  const d = Buffer.alloc(12); d.writeUInt32LE(2, 0); d.writeBigUInt64LE(BigInt(lamports), 4);
  return { programAddress: S.ADDRESSES.system, accounts: [{ address: String(from), role: S.Role.WS }, { address: String(to), role: S.Role.W }], data: new Uint8Array(d) };
};
const tokenTransfer = (src, mint, dst, owner, amount) => {
  const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(BigInt(amount), 1); d[9] = 6;
  return { programAddress: S.ADDRESSES.token, accounts: [{ address: src, role: S.Role.W }, { address: mint, role: S.Role.R }, { address: dst, role: S.Role.W }, { address: String(owner), role: S.Role.RS }], data: new Uint8Array(d) };
};
const tokenBurn = (acc, mint, owner, amount) => {
  const d = Buffer.alloc(9); d[0] = 8; d.writeBigUInt64LE(BigInt(amount), 1);
  return { programAddress: S.ADDRESSES.token, accounts: [{ address: acc, role: S.Role.W }, { address: mint, role: S.Role.W }, { address: String(owner), role: S.Role.RS }], data: new Uint8Array(d) };
};

test('L13 T7, T8, X40b: declared lamport and coin donations and a holder burn keep every invariant; prices ignore donations', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 900n, symbol: 'DON' });
  const u = await w.signer(100n);
  const b = await w.buy(u, h, 5n * LAMPORTS);
  const before = w.coinView(h);
  // T7: lamports donated to the Coin are surplus: no counter sees them, prices do not move
  await w.send([systemTransfer(u.address, h.coin, 777_777n)], [u], 'lamport donation', { lamportDonation: { coin: h.coin, amount: 777_777n } });
  assert.deepEqual(S.coinState(w.coinView(h)), S.coinState(before), 'no counter moved');
  // T8: coins donated to the vault are surplus too
  const ata = S.associatedTokenAddress(u.address, h.mint);
  await w.send([tokenTransfer(ata, h.mint, h.vault, u.address, 123_456_789n)], [u], 'coin donation', { tokenDonation: true });
  assert.deepEqual(S.coinState(w.coinView(h)), S.coinState(before));
  // X40b: a holder burns part of his own coins; the supply falls, no counter of the program sees it
  const s0 = mintInfo(w.accountInfo(h.mint)).supply;
  await w.send([tokenBurn(ata, h.mint, u.address, 1_000_000_000n)], [u], 'holder burn', { holderBurn: true });
  assert.equal(mintInfo(w.accountInfo(h.mint)).supply, s0 - 1_000_000_000n);
  // trading, buybacks and exits go on with every invariant counting the donations and the burn
  const q = S.quoteSell(S.coinTerms(w.coinView(h)), S.coinState(w.coinView(h)), b.q.tokensOut / 2n);
  await w.sell(u, h, b.q.tokensOut / 2n);
  assert.ok(q.solOut > 0n);
  w.warpSlots(200n);
  await w.buyback(h);
  await w.withdraw(h); await w.claim(h);
  await w.buy(u, h, 100n * LAMPORTS, { label: 'graduating buy with donations around' });
  assert.equal(w.coinView(h).phase, 1);
  assert.equal(w.lamportsOf(h.coin), w.coinView(h).rentReserve + S.liabilities(S.coinState(w.coinView(h))) + 777_777n, 'I9: the donation stays, uncounted');
  await w.finish();
});

test('L13 the checker fails on an undeclared donation, an undeclared vault transfer, an undeclared burn, and a Coin edited out of band', async () => {
  const mk = async () => {
    const w = await World.create();
    const h = await w.launchCoin({ cityId: 901n, symbol: 'CHK' });
    const u = await w.signer(100n);
    await w.buy(u, h, 5n * LAMPORTS);
    return { w, h, u, ata: S.associatedTokenAddress(u.address, h.mint) };
  };
  let { w, h, u, ata } = await mk();
  await assert.rejects(() => w.send([systemTransfer(u.address, h.coin, 1_000n)], [u], 'undeclared lamport donation'), (e) => e instanceof assert.AssertionError && /I9|I13/.test(e.message));
  ({ w, h, u, ata } = await mk());
  await assert.rejects(() => w.send([tokenTransfer(ata, h.mint, h.vault, u.address, 5n)], [u], 'undeclared coin donation'), (e) => e instanceof assert.AssertionError && /donation/.test(e.message));
  ({ w, h, u, ata } = await mk());
  await assert.rejects(() => w.send([tokenBurn(ata, h.mint, u.address, 5n)], [u], 'undeclared holder burn'), (e) => e instanceof assert.AssertionError && /holder burn/.test(e.message));
  // a Coin edited behind the program's back: the next transaction's ledgers catch it
  ({ w, h, u, ata } = await mk());
  const edit = (offset, delta) => {
    const acc = w.svm.getAccount(address(h.coin));
    const data = Buffer.from(acc.data);
    data.writeBigUInt64LE(data.readBigUInt64LE(offset) + delta, offset);
    w.svm.setAccount({ ...acc, address: address(h.coin), data: new Uint8Array(data) });
  };
  edit(S.COIN_OFFSETS.platformEarned, 1n);
  await assert.rejects(() => w.withdraw(h, { label: 'after an out-of-band edit of a counter' }), (e) => e instanceof assert.AssertionError && /I7/.test(e.message));
  // X31 (forced by an out-of-band edit instead of a test-only build): one lamport of liabilities more than the
  // Coin holds, and pay_out refuses every debit with RentFloor; nothing moves
  ({ w, h, u, ata } = await mk());
  edit(S.COIN_OFFSETS.founderPending, 1n);
  await expectFail(() => w.claim(h, h.founder, { label: 'claim with liabilities above the balance' }), 'RentFloor');
  await expectFail(() => w.withdraw(h, { label: 'withdraw with liabilities above the balance' }), 'RentFloor');
  await expectFail(() => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: w.balanceOf(u, h.mint), minSolOut: 0n })], [u], 'sell with liabilities above the balance'), 'RentFloor');
});

test('T56: an event instruction not signed by the event authority is refused; events are accepted only as CPIs of the program', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 902n, symbol: 'EVT' });
  const ea = w.P.eventAuthority();
  const fake = new Uint8Array([...S.EVENT_IX_TAG, ...S.EVENT_DISCRIMINATORS.PlatformFeesWithdrawn, ...new Uint8Array(8 + 8 + 16)]);
  await expectFail(() => w.send([{ programAddress: w.programId, accounts: [{ address: ea, role: S.Role.R }], data: fake }], [], 'forged event, authority not signing'), /ConstraintSigner|signer|MissingRequiredSignature|PrivilegeEscalation/i);
  const other = await w.signer(1n);
  await expectFail(() => w.send([{ programAddress: w.programId, accounts: [{ address: other.address, role: S.Role.RS }], data: fake }], [other], 'forged event, another signer'), /ConstraintSeeds|seeds|event/i);
  // the real events of a trade come from inner instructions of the program with the event authority
  const u = await w.signer(10n);
  const r = await w.buy(u, h, LAMPORTS);
  const inner = r.res.top.find((t) => t.name === 'buy').inner.filter((i) => i.program === w.programId);
  assert.equal(inner.length, 1);
  assert.deepEqual(inner[0].accounts, [ea]);
  assert.ok(inner[0].stackHeight >= 2);
  await w.finish();
});
