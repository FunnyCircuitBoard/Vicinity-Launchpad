// TK01-TK04: the rewards and founder-payout tooling of the TypeScript SDK
// against the real programs, in process:
//   TK01 "send to all holders": the unsigned batches the admin wallet signs
//        pay every holder exactly once, exactly their amount (SPL and SOL)
//   TK02 a rewards round from the SDK: snapshot (snapshot.mjs) -> buildFundRound
//        (forward + fund_epoch_from_vault) -> every holder's buildClaim, paid as SOL
//   TK03 founder payout hooks: opt-in with a refHash, the payout planner over
//        the RPC reader, the payout key's payout into the fixed wallet, the
//        cooldown, revoke; the founder's own claim keeps working throughout
//   TK04 the planner never proposes a payout the program would refuse
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { World, C, ADDRESSES, PROGRAM_IDS, LAMPORTS, DAY, R, ata, harvest, expectFail, fakeConnection, graduate, completeCurve } from './helpers.mjs';
import * as S from '../sdk/launchpad/index.mts';

const WSOL = ADDRESSES.wsol;

describe('13 rewards and payout tools (TypeScript SDK)', () => {
  let w, founder, coin, holders;
  before(async () => {
    w = await World.create();
    w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    founder = await w.signer(50n);
    coin = await w.launchCoin({ cityId: 130001n, founder, name: 'Tools City', symbol: 'TOOLS' });
    await w.send([C.initRewardsForCoin({ payer: w.payer.address, registryAdmin: w.admin.address, authority: w.admin.address, coin })], [w.admin], 'rewards init_city');
    // 24 holders buy different amounts (each pays a fee; the city's share accumulates)
    holders = [];
    for (let i = 0; i < 24; i++) {
      const h = await w.signer(20n);
      const { pool, config } = { pool: S.decodeDbcPool(w.account(coin.dbcPool).data), config: S.decodeDbcConfig(w.account(coin.dbcConfig).data) };
      const q = S.quoteBuy(pool, config, { amountIn: BigInt(1 + (i % 5)) * LAMPORTS });
      await w.send(S.buildBuy({ trader: h.address, coin, amountIn: q.amountIn, minOut: q.minOut }), [h], 'holder buy', { feePayer: h });
      holders.push(h);
    }
  });

  it('TK01 send to all holders: unsigned batches for the admin wallet pay everyone exactly once', async () => {
    // the admin holds some coins to give away (bought like anyone else)
    const admin = w.admin;
    w.svm.airdrop(admin.address, 50n * LAMPORTS);
    const m = { pool: S.decodeDbcPool(w.account(coin.dbcPool).data), config: S.decodeDbcConfig(w.account(coin.dbcConfig).data) };
    const q = S.quoteBuy(m.pool, m.config, { amountIn: 3n * LAMPORTS });
    await w.send(S.buildBuy({ trader: admin.address, coin, amountIn: q.amountIn, minOut: q.minOut }), [admin], 'admin buys coins to give away', { feePayer: admin });
    // recipients: the holders (half already hold the coin, so their accounts exist) plus fresh wallets with no account
    const fresh = [];
    for (let i = 0; i < 10; i++) fresh.push(await w.signer(0n));
    const recipients = [...holders, ...fresh].map((h, i) => ({ owner: h.address, amount: 1_000_000n * BigInt(i + 1) }));
    const plan = S.buildAirdropBatches({ sender: admin.address, mint: coin.mint, decimals: 6, recipients });
    const before = new Map(recipients.map((r) => [r.owner, w.exists(ata(r.owner, coin.mint)) ? w.balance(ata(r.owner, coin.mint)) : 0n]));
    const senderBefore = w.balance(ata(admin.address, coin.mint));
    const txs = S.airdropTransactions(plan);
    assert.equal(txs.length, plan.batches.length);
    for (const b of plan.batches) {
      assert.ok(b.bytes <= S.MAX_TX_BYTES);
      await w.send(b.instructions, [admin], `airdrop batch ${b.index}`, { feePayer: admin, cu: b.cuLimit });
    }
    for (const r of recipients) assert.equal(w.balance(ata(r.owner, coin.mint)) - before.get(r.owner), r.amount, r.owner);
    assert.equal(senderBefore - w.balance(ata(admin.address, coin.mint)), plan.total);
    console.log(`TK01 ${recipients.length} recipients (${fresh.length} without an account) in ${plan.batches.length} transactions: ${plan.batches.map((b) => `${b.recipients.length}r/${b.bytes}B`).join(', ')}`);
    // native SOL push
    const sol = S.buildAirdropBatches({ sender: admin.address, mint: 'SOL', decimals: 9, recipients: fresh.map((f) => ({ owner: f.address, amount: S.MIN_NATIVE_PUSH + 1n })) });
    const l0 = fresh.map((f) => w.lamportsOf(f.address));
    for (const b of sol.batches) await w.send(b.instructions, [admin], 'SOL push', { feePayer: admin, cu: b.cuLimit });
    fresh.forEach((f, i) => assert.equal(w.lamportsOf(f.address) - l0[i], S.MIN_NATIVE_PUSH + 1n));
  });

  it('TK02 a rewards round from the SDK: snapshot, forward + fund, every holder claims and gets SOL', async () => {
    await harvest(w, coin);
    const conn = fakeConnection(w);
    const pot = w.balance(coin.holdersPot);
    // the snapshot tool plans the round from the chain (as scripts/launchpad/snapshot.mjs does);
    // the vault is still empty (the forward happens in the same transaction as the funding), so the total is the pot
    const { prepareRound } = S.snapshot;
    const r = await prepareRound(conn, coin.mint, { total: pot, rules: { ...S.snapshot.ROUND_RULES, minPayout: 100_000n, minHolders: 5 } });
    assert.ok(r.round.fundable, r.round.reason);
    const rw = await S.fetchRewards(conn, coin);
    const ixs = S.buildFundRound({ authority: w.admin.address, payer: w.payer.address, coin, rewardsConfig: rw.config, round: { root: r.file.tree.root, numLeaves: r.round.leaves.length, slot: BigInt(r.slot), snapshotHash: r.file.hash } });
    await w.send(ixs, [w.admin], 'forward + fund_epoch_from_vault (SDK)');
    assert.equal(w.balance(coin.holdersPot), 0n);
    const after = await S.fetchRewards(conn, coin);
    assert.equal(after.config.epochCount, rw.config.epochCount + 1n);
    let paid = 0n;
    const bySigner = new Map(holders.map((h) => [h.address, h]));
    for (let i = 0; i < r.round.leaves.length; i++) {
      const leaf = r.round.leaves[i];
      const h = bySigner.get(String(leaf.claimant));
      if (!h) continue; // the admin bought coins too and is a holder in this test world
      const l0 = w.lamportsOf(h.address);
      await w.send(S.buildClaim({ claimant: h.address, coin, epochIndex: rw.config.epochCount, tree: r.file.tree, leafIndex: i }), [h], 'claim (SDK)', { feePayer: h });
      const claimStatusRent = w.lamportsOf(R.claim(R.epoch(R.city(coin.mint), rw.config.epochCount), h.address));
      assert.equal(w.lamportsOf(h.address) - l0, leaf.amount - claimStatusRent - 5_000n, 'paid as SOL (the WSOL account was closed)');
      assert.equal(w.exists(ata(h.address, WSOL)), false);
      paid += leaf.amount;
    }
    console.log(`TK02 round of ${r.round.leaves.length} leaves from a pot of ${pot} lamports; ${paid} claimed by test holders`);
    assert.ok(paid > 0n);
  });

  it('TK03 + TK04 founder payout hooks: opt-in, planner, payout into the fixed wallet only, cooldown, revoke', async () => {
    const conn = fakeConnection(w);
    const payoutKey = await w.signer(5n), payoutWallet = await w.signer(0n);
    // switched off: the planner says so and proposes nothing
    let st = await S.loadPayoutCandidates(conn);
    assert.equal(st.candidates.length, 0);
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: payoutWallet.address })], [w.admin], 'set_payout_config');
    const ref = S.refHash('partner-customer-0001', new Uint8Array(16).fill(5));
    await w.send([S.buildOptIn({ founder: founder.address, cityId: coin.cityId, expectedDestination: payoutWallet.address, ref })], [founder], 'opt_in_payout (SDK)', { feePayer: founder });
    const opt = await S.fetchPayoutOptIn(conn, coin.address);
    assert.deepEqual([opt.founder, opt.agreedDestination, Buffer.from(opt.refHash).toString('hex')], [founder.address, payoutWallet.address, Buffer.from(ref).toString('hex')]);
    // fees to pay out
    const t = await w.signer(20n);
    let m = { pool: S.decodeDbcPool(w.account(coin.dbcPool).data), config: S.decodeDbcConfig(w.account(coin.dbcConfig).data) };
    let q = S.quoteBuy(m.pool, m.config, { amountIn: 5n * LAMPORTS });
    await w.send(S.buildBuy({ trader: t.address, coin, amountIn: q.amountIn, minOut: q.minOut }), [t], 'buy', { feePayer: t });
    await harvest(w, coin);
    st = await S.loadPayoutCandidates(conn);
    let plan = S.planPayouts({ ...st, now: w.now(), payoutAuthority: payoutKey.address, minAmount: 1_000n });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].pay, true, plan[0].reason);
    const vault = w.balance(coin.founderVault);
    assert.equal(plan[0].amount, vault);
    await w.send([S.buildPayout({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address })], [payoutKey], 'payout_founder_fees (SDK)', { feePayer: payoutKey });
    assert.equal(w.balance(S.payoutReceivingAccount(payoutWallet.address, WSOL)), vault, 'only the fixed payout wallet received it');
    // cooldown: the planner says wait, and the program agrees
    await w.send(S.buildBuy({ trader: t.address, coin, amountIn: LAMPORTS, minOut: 1n }), [t], 'buy', { feePayer: t });
    await harvest(w, coin);
    plan = S.planPayouts({ ...(await S.loadPayoutCandidates(conn)), now: w.now(), payoutAuthority: payoutKey.address });
    assert.match(plan[0].reason, /cooldown/);
    await expectFail(() => w.send([S.buildPayout({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address })], [payoutKey], 'too soon', { feePayer: payoutKey }), 'PayoutTooSoon');
    // the founder can always claim directly, opted in or not
    const l0 = w.lamportsOf(founder.address);
    const owed = w.balance(coin.founderVault);
    // (fund_epoch_from_vault created the founder's WSOL account in TK02; unwrapping closes it, so its rent comes along)
    const wsolAccountLamports = w.lamportsOf(ata(founder.address, WSOL));
    await w.send(S.buildFounderClaim({ founder: founder.address, coin }), [founder], 'founder claim (SDK)', { feePayer: founder });
    assert.equal(w.lamportsOf(founder.address) - l0, owed + wsolAccountLamports - 5_000n, 'the founder got the vault as SOL');
    assert.equal(w.exists(ata(founder.address, WSOL)), false);
    // a day later the planner would pay again, but the founder revokes first
    w.warp(Number(DAY) + 1);
    await w.send([S.buildRevokeOptIn({ founder: founder.address, cityId: coin.cityId })], [founder], 'revoke (SDK)', { feePayer: founder });
    assert.equal(await S.fetchPayoutOptIn(conn, coin.address), null);
    assert.equal((await S.loadPayoutCandidates(conn)).candidates.length, 0, 'no opt-in, no candidate');
    // TK04: a changed payout wallet stops an opt-in in the planner exactly as on chain
    await w.send([S.buildOptIn({ founder: founder.address, cityId: coin.cityId, expectedDestination: payoutWallet.address, ref })], [founder], 'opt in again', { feePayer: founder });
    const other = await w.signer(0n);
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: other.address })], [w.admin], 'new payout wallet');
    await w.send(S.buildBuy({ trader: t.address, coin, amountIn: LAMPORTS, minOut: 1n }), [t], 'buy', { feePayer: t });
    await harvest(w, coin);
    plan = S.planPayouts({ ...(await S.loadPayoutCandidates(conn)), now: w.now(), payoutAuthority: payoutKey.address });
    assert.match(plan[0].reason, /payout wallet changed/);
    await expectFail(() => w.send([S.buildPayout({ payoutAuthority: payoutKey.address, coin, destination: other.address })], [payoutKey], 'redirected', { feePayer: payoutKey }), 'DestinationMismatch');
  });
});
