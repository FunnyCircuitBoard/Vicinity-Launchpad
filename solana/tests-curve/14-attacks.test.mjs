// A first set of the attack tests of 12.4 that the World makes cheap, each
// asserting (through the failed-transaction check) that nothing moved: X01,
// X02, X04, X05 and F02 in miniature (every non-signer account slot of every
// money instruction replaced by plausible wrong accounts: always refused);
// X04 completed (a real Token-2022 mint, Token-2022 copies of the coin's mint,
// vault and a holder's token account, alone and with the Token-2022 program, in
// buy and sell) and X02 completed (a Coin made by the old program itself, in
// the coin slot of all nine coin-level instructions);
// X32 (one coin drained by sells, the other untouched), X33 (approval replay),
// X58 (a 0-lamport seller or founder: below the rent-exempt minimum refused,
// above it paid), X65 (the IDL instruction is a stub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { address, generateKeyPairSigner } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, expectFail, TxError, LAMPORTS, DAY } from './helpers.mjs';

const { PublicKey } = web3;

test('X01, X02, X04, X05, F02: every non-signer slot of every money instruction, substituted, is refused and moves nothing', async () => {
  const w = await World.create();
  const a = await w.launchCoin({ cityId: 1000n, symbol: 'SUBA' });
  const b = await w.launchCoin({ cityId: 1001n, symbol: 'SUBB' });
  const u = await w.signer(500n);
  await w.buy(u, a, 20n * LAMPORTS);
  await w.buy(u, b, 20n * LAMPORTS);
  for (const h of [a, b]) await w.initRewardsCity(h);
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  for (const h of [a, b]) await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(4) })], [h.founder], 'opt in');
  w.warpSlots(200n); w.warpSecs(DAY);
  // a fake Coin: coin A's exact bytes at another address, owned by the old program (X02)
  const fakeCoin = (await w.signer(0n)).address;
  const real = w.accountInfo(a.coin);
  w.setRaw(fakeCoin, real.data, S.CLUSTERS.mainnet.legacyProgram, real.lamports);
  const fakeCurveOwned = (await w.signer(0n)).address; // the same bytes owned by vicinity_curve at a non-PDA address cannot exist: Anchor would still re-derive the seeds
  w.setRaw(fakeCurveOwned, real.data, S.CLUSTERS.mainnet.rewardsProgram, real.lamports);
  const randomKey = (await w.signer(0n)).address;
  const R = w.P.rewardsAccounts(b.mint);
  const candidates = {
    coin: [b.coin, fakeCoin, fakeCurveOwned, a.vault, randomKey],
    launchpad: [w.P.config(0), a.coin, randomKey],
    mint: [b.mint, S.ADDRESSES.nativeMint, randomKey],
    coin_vault: [b.vault, S.associatedTokenAddress(u.address, a.mint), randomKey],
    user_token_account: [a.vault, S.associatedTokenAddress(u.address, b.mint), randomKey],
    token_program: [S.ADDRESSES.token2022, S.ADDRESSES.system, w.programId],
    system_program: [S.ADDRESSES.token, randomKey],
    event_authority: [randomKey, w.P.launchpad()],
    program: [S.ADDRESSES.token, S.CLUSTERS.mainnet.legacyProgram],
    fee_recipient: [w.admin.address, randomKey],
    rewards_city_config: [R.config, randomKey],
    rewards_vault: [R.vault, a.vault, randomKey],
    opt_in: [w.P.payoutOptIn(b.coin), randomKey],
    destination_wallet: [randomKey, w.admin.address],
  };
  const builders = {
    buy: () => w.ix.buy({ user: u.address, coin: a.coin, solIn: LAMPORTS, minTokensOut: 0n }),
    sell: () => w.ix.sell({ user: u.address, coin: a.coin, tokensIn: 1_000_000_000n, minSolOut: 0n }),
    buyback_burn: () => w.ix.buybackBurn({ coin: a.coin }),
    withdraw_platform_fees: () => w.ix.withdrawPlatformFees({ coin: a.coin }),
    claim_founder_fees: () => w.ix.claimFounderFees({ founder: a.founder.address, coin: a.coin }),
    forward_holders_fees: () => w.ix.forwardHoldersFees({ coin: a.coin }),
    payout_founder_fees: () => w.ix.payoutFounderFees({ payoutAuthority: payoutKey.address, coin: a.coin, destination: wallet.address }),
  };
  const signersOf = { buy: [u], sell: [u], buyback_burn: [], withdraw_platform_fees: [], claim_founder_fees: [a.founder], forward_holders_fees: [], payout_founder_fees: [payoutKey] };
  let refused = 0;
  for (const [name, build] of Object.entries(builders)) {
    const base = build();
    for (const [i, [slot, role]] of S.ACCOUNT_TABLES[name].entries()) {
      if (role & 2) continue; // signer slots: another signer is simply another (legitimate) caller
      for (const cand of candidates[slot] ?? [randomKey]) {
        if (cand === base.accounts[i].address) continue;
        // withdrawing another coin's platform fees is that coin's own (permissionless) withdrawal, not a substitution
        if (name === 'withdraw_platform_fees' && slot === 'coin' && cand === b.coin) continue;
        const ix = { ...base, accounts: base.accounts.map((m, k) => (k === i ? { address: cand, role: m.role } : m)) };
        let err;
        try { await w.send([ix], signersOf[name], `${name}: ${slot} := ${cand.slice(0, 6)}`, { noProbe: true }); } catch (e) { err = e; }
        assert.ok(err instanceof TxError, `${name}: substituting ${slot} with ${cand} was accepted`);
        refused++;
      }
    }
  }
  assert.ok(refused >= 80, `${refused} substitutions refused`);
  // and the real instructions still work
  for (const [name, build] of Object.entries(builders)) await w.send([build()], signersOf[name], `${name} (real)`);
  await w.finish();
});

test('X32 two coins: one drained by sells, the other untouched; X33 an approval cannot be replayed', async () => {
  const w = await World.create();
  const a = await w.launchCoin({ cityId: 1010n, symbol: 'DRAIN' });
  const b = await w.launchCoin({ cityId: 1011n, symbol: 'SAFE' });
  const u = await w.signer(500n); const v = await w.signer(500n);
  const ba = await w.buy(u, a, 50n * LAMPORTS);
  await w.buy(v, b, 30n * LAMPORTS);
  const bBefore = { data: w.accountInfo(b.coin).data, lamports: w.lamportsOf(b.coin) };
  for (let k = 0; k < 5; k++) await w.sell(u, a, ba.q.tokensOut / 5n, { label: `drain ${k}` });
  const c = w.coinView(a);
  assert.equal(w.lamportsOf(a.coin), c.rentReserve + S.liabilities(S.coinState(c)), 'the drained coin keeps exactly its rent and liabilities');
  assert.ok(w.accountInfo(b.coin).data.equals(bBefore.data) && w.lamportsOf(b.coin) === bBefore.lamports, 'the other coin is untouched');
  // X33: the approval closed at launch; launching again needs a new approval, which the Coin now refuses
  await expectFail(() => w.send([w.ix.launch({ founder: a.founder.address, cityId: 1010n, configId: 0, symbol: 'DRAIN', rentPayer: w.admin.address })], [a.founder], 'replay the launch'), 'AccountNotInitialized');
  await expectFail(() => w.approve({ cityId: 1010n, founder: a.founder, symbol: 'DRAIN2' }), 'CoinAlreadyLaunched');
  await w.finish();
});

test('X58 a 0-lamport seller or founder: a payout below the rent-exempt minimum of an empty account is refused, above it is paid', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1020n, symbol: 'ZERO' });
  const rentMin = w.svm.minimumBalanceForRentExemption(0n);
  const seller = await w.signer(0n);
  const funder = await w.signer(100n);
  // the seller's coins arrive by a buy delivered to his token account; he holds no lamports at all
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: funder.address, owner: seller.address, mint: h.mint })], [funder], 'seller\'s token account');
  const ta = S.associatedTokenAddress(seller.address, h.mint);
  await w.send([w.ix.buy({ user: funder.address, coin: h.coin, userTokenAccount: ta, solIn: 5n * LAMPORTS, minTokensOut: 0n })], [funder], 'buy for the seller');
  w.addHolder(h.mint, seller);
  assert.equal(w.lamportsOf(seller.address), 0n);
  // find a sell paying less than the minimum, and one paying more
  const c = w.coinView(h);
  const out = (n) => { try { return S.quoteSell(S.coinTerms(c), S.coinState(c), n).solOut; } catch { return 0n; } };
  let small = 1n; while (out(small) === 0n) small *= 2n;
  assert.ok(out(small) < rentMin);
  await expectFail(() => w.send([w.ix.sell({ user: seller.address, coin: h.coin, tokensIn: small, minSolOut: 0n })], [seller], 'sell below the minimum to a 0-lamport seller'), /InsufficientFundsForRent|insufficient funds for rent/i);
  const big = w.balanceOf(seller, h.mint) / 2n;
  assert.ok(out(big) >= rentMin);
  await w.sell(seller, h, big, { label: 'sell above the minimum to a 0-lamport seller' });
  // a founder holding 0 lamports
  const z = await w.signer(0n);
  const h2 = await w.launchCoin({ cityId: 1021n, symbol: 'ZEROF', founder: await w.signer(1n) });
  await w.send([w.ix.transferFounder({ founder: h2.founder.address, newFounder: z.address, coin: h2.coin })], [h2.founder, z], 'seat to a 0-lamport key');
  h2.founder = z;
  await w.buy(funder, h2, 10_000_000n, { label: 'small buy' });
  assert.ok(w.coinView(h2).founderPending < rentMin);
  await expectFail(() => w.claim(h2, z, { label: 'claim below the minimum' }), /InsufficientFundsForRent|insufficient funds for rent/i);
  await w.buy(funder, h2, 50n * LAMPORTS, { label: 'large buy' });
  await w.claim(h2, z, { label: 'claim above the minimum' });
  assert.ok(w.lamportsOf(z.address) >= rentMin);
  await w.finish();
});

test('X65 the IDL instruction is a stub (no-idl): error 1000 IdlInstructionStub, nothing created', async () => {
  const w = await World.create();
  const tag = Buffer.alloc(8); tag.writeBigUInt64LE(0x0a69e9a778bcf440n); // anchor_lang::idl::IDL_IX_TAG
  const data = new Uint8Array([...tag, 0]); // IdlInstruction::Create
  const e = await expectFail(() => w.send([{ programAddress: w.programId, accounts: [{ address: w.payer.address, role: S.Role.WS }], data }], [], 'IDL create'), /IdlInstructionStub|0x3e8|Custom":1000/);
  assert.ok(e);
  assert.equal(w.svm.getProgramAccounts(address(w.programId)).filter((a) => a.data.length > 0 && !S.accountType({ owner: w.programId, data: a.data })).length, 0, 'no IDL account');
  await w.finish();
});

test('X04 completed: a Token-2022 mint and Token-2022 token accounts of the coin\'s mint, alone and with the Token-2022 program, in buy and sell; X02 completed: the real old program\'s Coin in the coin slot of every coin-level instruction', async () => {
  const w = await World.create({ dbcProgram: true });
  const a = await w.launchCoin({ cityId: 1030n, symbol: 'TKN22' });
  const u = await w.signer(500n);
  await w.buy(u, a, 20n * LAMPORTS);
  await w.initRewardsCity(a);
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  await w.send([w.ix.optInPayout({ founder: a.founder.address, coin: a.coin, expectedDestination: wallet.address, refHash: Array(32).fill(5) })], [a.founder], 'opt in');
  w.warpSlots(200n); w.warpSecs(DAY);
  const T22 = S.ADDRESSES.token2022;
  const userTa = w.ata(u.address, a.mint);
  // a real Token-2022 mint (6 decimals, made by the Token-2022 program itself)
  const realT22 = await generateKeyPairSigner();
  const space = 82n;
  const create = Buffer.alloc(52); create.writeUInt32LE(0, 0); create.writeBigUInt64LE(w.svm.minimumBalanceForRentExemption(space), 4); create.writeBigUInt64LE(space, 12);
  new PublicKey(T22).toBuffer().copy(create, 20);
  const initMint = Buffer.concat([Buffer.from([20, 6]), new PublicKey(String(u.address)).toBuffer(), Buffer.from([0])]); // InitializeMint2, no freeze authority
  await w.send([
    { programAddress: S.ADDRESSES.system, accounts: [{ address: String(w.payer.address), role: S.Role.WS }, { address: String(realT22.address), role: S.Role.WS }], data: new Uint8Array(create) },
    { programAddress: T22, accounts: [{ address: String(realT22.address), role: S.Role.W }], data: new Uint8Array(initMint) },
  ], [realT22], 'a Token-2022 mint');
  assert.equal(w.accountInfo(realT22.address).owner, T22);
  // the coin's own mint, its vault and the user's token account, byte for byte, owned by Token-2022 at other addresses
  const t22Copy = async (src) => { const k = (await generateKeyPairSigner()).address; const acc = w.accountInfo(src); w.setRaw(k, acc.data, T22, acc.lamports); return String(k); };
  const t22Mint = await t22Copy(a.mint); const t22Vault = await t22Copy(a.vault); const t22UserTa = await t22Copy(userTa);
  const watch = [a.coin, a.mint, a.vault, userTa];
  const print = () => watch.map((k) => { const x = w.accountInfo(k); return `${k}:${x.lamports}:${x.data.toString('hex')}`; });
  const subst = (ix, map) => ({ ...ix, accounts: ix.accounts.map((m, i) => { const slot = S.ACCOUNT_TABLES[ix.name][i][0]; return slot in map ? { address: map[slot], role: m.role } : m; }) });
  const named = (name, ix) => ({ ...ix, name });
  const buy = () => named('buy', w.ix.buy({ user: u.address, coin: a.coin, solIn: LAMPORTS, minTokensOut: 0n }));
  const sell = () => named('sell', w.ix.sell({ user: u.address, coin: a.coin, tokensIn: 1_000_000_000n, minSolOut: 0n }));
  let refused = 0;
  const reasons = [];
  for (const base of [buy, sell]) {
    for (const map of [
      { mint: String(realT22.address) },
      { mint: t22Mint },
      { coin_vault: t22Vault },
      { user_token_account: t22UserTa },
      { token_program: T22 },
      { mint: t22Mint, token_program: T22 },
      { user_token_account: t22UserTa, token_program: T22 },
      { mint: t22Mint, coin_vault: t22Vault, user_token_account: t22UserTa, token_program: T22 },
      { mint: String(realT22.address), coin_vault: t22Vault, user_token_account: t22UserTa, token_program: T22 },
    ]) {
      const before = print();
      const ix = base();
      const e = await expectFail(() => w.send([subst(ix, map)], [u], `X04 ${ix.name}: ${Object.keys(map).join(' + ')} Token-2022`, { noProbe: true }), 'AccountOwnedByWrongProgram', 'InvalidProgramId');
      reasons.push(`${ix.name} ${Object.keys(map).join('+')}: ${(e.logs.find((l) => /Error (Code|Message)|failed:/.test(l)) ?? e.errText).slice(0, 140)}`);
      assert.deepEqual(print(), before, `${ix.name} ${Object.keys(map).join('+')}: nothing moved`);
      refused++;
    }
  }
  // X02: a Coin made by the old program itself (its launch through Meteora DBC), whose own discriminator differs
  await w.legacyPause(false);
  const oldFounder = await w.signer(50n);
  await w.legacyApprove({ cityId: 1031n, founder: oldFounder, symbol: 'OLDC' });
  await w.legacyLaunch({ cityId: 1031n, founder: oldFounder });
  await w.legacyPause(true);
  const oldCoin = w.legacyPdas().coin(1031n);
  assert.equal(w.accountInfo(oldCoin).owner, S.CLUSTERS.mainnet.legacyProgram);
  const coinLevel = {
    buy: () => named('buy', w.ix.buy({ user: u.address, coin: a.coin, solIn: LAMPORTS, minTokensOut: 0n })),
    sell: () => named('sell', w.ix.sell({ user: u.address, coin: a.coin, tokensIn: 1_000_000_000n, minSolOut: 0n })),
    buyback_burn: () => named('buyback_burn', w.ix.buybackBurn({ coin: a.coin })),
    withdraw_platform_fees: () => named('withdraw_platform_fees', w.ix.withdrawPlatformFees({ coin: a.coin })),
    claim_founder_fees: () => named('claim_founder_fees', w.ix.claimFounderFees({ founder: a.founder.address, coin: a.coin })),
    forward_holders_fees: () => named('forward_holders_fees', w.ix.forwardHoldersFees({ coin: a.coin })),
    payout_founder_fees: () => named('payout_founder_fees', w.ix.payoutFounderFees({ payoutAuthority: payoutKey.address, coin: a.coin, destination: wallet.address })),
    transfer_founder: () => named('transfer_founder', w.ix.transferFounder({ founder: a.founder.address, newFounder: u.address, coin: a.coin })),
    opt_in_payout: () => named('opt_in_payout', w.ix.optInPayout({ founder: a.founder.address, coin: a.coin, expectedDestination: wallet.address, refHash: Array(32).fill(6) })),
  };
  const signersOf = { buy: [u], sell: [u], buyback_burn: [], withdraw_platform_fees: [], claim_founder_fees: [a.founder], forward_holders_fees: [], payout_founder_fees: [payoutKey], transfer_founder: [a.founder, u], opt_in_payout: [a.founder] };
  const oldBefore = w.accountInfo(oldCoin);
  for (const [name, build] of Object.entries(coinLevel)) {
    const before = print();
    const e = await expectFail(() => w.send([subst(build(), { coin: oldCoin })], signersOf[name], `X02 ${name}: the old program's real Coin`, { noProbe: true }), /AccountOwnedByWrongProgram|AccountDiscriminatorMismatch|ConstraintSeeds|3007|3002/);
    reasons.push(`X02 ${name}: ${(e.logs.find((l) => /Error (Code|Message)|failed:/.test(l)) ?? e.errText).slice(0, 140)}`);
    assert.deepEqual(print(), before, `${name}: nothing moved`);
    refused++;
  }
  const oldAfter = w.accountInfo(oldCoin);
  assert.ok(oldAfter.data.equals(oldBefore.data) && oldAfter.lamports === oldBefore.lamports, 'the old Coin is untouched');
  assert.equal(refused, 27);
  if (process.env.VCURVE_LOG_REASONS) console.log(reasons.join('\n'));
  // the real instructions still work
  await w.buy(u, a, LAMPORTS, { label: 'buy (real)' });
  await w.sell(u, a, 1_000_000_000n, { label: 'sell (real)' });
  await w.finish();
});
