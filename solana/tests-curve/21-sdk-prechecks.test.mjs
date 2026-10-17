// The SDK's pre-checks (VICINITY-CURVE-DESIGN.md 14.3, T58) and its
// initRewardsForCoin (4.15, 12.5 R03 last clause, 14.1, T70) against the real
// programs: every prediction the SDK makes from account snapshots is what the
// chain then does.
//   * Sells and claims to a 0-lamport account around the rent-exempt minimum
//     of an empty account: the SDK refuses exactly the ones the runtime
//     refuses.
//   * Buyers: a system account with data, a key assigned to another program,
//     a buy that would leave dust below the minimum in the wallet: refused by
//     the SDK and by the chain; spending the whole balance is accepted by both.
//   * initRewardsForCoin simulates the real vicinity_rewards init_city in the
//     same VM and proposes only the config forward_holders_fees accepts; it
//     refuses a Creator, Split or WSOL-less config and a stranger authority
//     before anything is sent, reports an existing wrong config (and one with
//     an authority transfer pending) as unfixable, and the config it proposes
//     carries the holders' money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner, lamports } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, expectFail, LAMPORTS, mintData } from './helpers.mjs';

const { PublicKey } = web3;
const prediction = (fn) => { try { fn(); return 'ok'; } catch (e) { if (e instanceof S.PrecheckError) return e.code; throw e; } };

test('14.3 condition 2 in litesvm: the SDK refuses exactly the sells and claims the runtime refuses (0-lamport destinations around rent_min(0))', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_101n, symbol: 'RENT' });
  const rent0 = w.svm.minimumBalanceForRentExemption(0n);
  const whale = await w.signer(200n);
  await w.buy(whale, h, 50n * LAMPORTS);
  let agree = 0;
  // sellers holding 0 lamports, selling amounts whose output falls just below, at and above rent_min(0)
  for (const target of [rent0 - 1_000n, rent0 - 1n, rent0, rent0 + 1n, rent0 + 50_000n, 5n * rent0]) {
    const seller = await generateKeyPairSigner();
    w.signers.set(String(seller.address), seller);
    const c = w.coinView(h);
    // the smallest amount whose output reaches `target` (output grows with the amount)
    let lo = 1n; let hi = w.balanceOf(whale, h.mint);
    while (lo < hi) { const mid = (lo + hi) / 2n; let out = 0n; try { out = S.quoteSell(S.coinTerms(c), S.coinState(c), mid).solOut; } catch { out = 0n; } if (out >= target) hi = mid; else lo = mid + 1n; }
    const amount = lo;
    const ata = S.associatedTokenAddress(seller.address, h.mint);
    await w.send([S.createAssociatedTokenAccountIdempotent({ payer: whale.address, owner: seller.address, mint: h.mint }),
      { programAddress: S.ADDRESSES.token, accounts: [{ address: S.associatedTokenAddress(whale.address, h.mint), role: S.Role.W }, { address: h.mint, role: S.Role.R }, { address: ata, role: S.Role.W }, { address: whale.address, role: S.Role.RS }], data: (() => { const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(amount, 1); d[9] = 6; return new Uint8Array(d); })() }],
    [whale], 'coins to a 0-lamport seller');
    w.addHolder(h.mint, seller);
    const before = w.coinView(h);
    const said = prediction(() => S.precheckSell({ coin: before, userAccount: w.accountInfo(seller.address), tokensIn: amount, rentExemptMinimum: rent0 }));
    const out = S.quoteSell(S.coinTerms(before), S.coinState(before), amount).solOut;
    assert.equal(said, out >= rent0 ? 'ok' : 'BelowRentExemptMinimum', `the rule for ${out}`);
    const send = () => w.send([w.ix.sell({ user: seller.address, coin: h.coin, tokensIn: amount, minSolOut: 0n })], [seller], `sell to a 0-lamport seller (out ${out})`);
    if (said === 'ok') { await send(); assert.equal(w.lamportsOf(seller.address), out); } else await expectFail(send, /InsufficientFundsForRent|insufficient funds for rent/i);
    agree++;
  }
  // a founder holding 0 lamports claims founder_pending below and above the minimum
  for (const [solIn, label] of [[1_000_000_000n, 'below'], [40n * LAMPORTS, 'above']]) {
    const founder = await generateKeyPairSigner();
    w.signers.set(String(founder.address), founder);
    const city = label === 'below' ? 2_102n : 2_103n;
    await w.approve({ cityId: city, founder, symbol: `F${city}` });
    const fh = await w.launch({ cityId: city, founder, payer: w.payer });
    await w.buy(whale, fh, solIn, { label: `trade ${label}` });
    const c = w.coinView(fh);
    const said = prediction(() => S.precheckClaim({ coin: c, founderAccount: w.accountInfo(founder.address), rentExemptMinimum: rent0 }));
    assert.equal(said, c.founderPending >= rent0 ? 'ok' : 'BelowRentExemptMinimum');
    const claim = () => w.send([w.ix.claimFounderFees({ founder: founder.address, coin: fh.coin })], [founder], `claim ${label} the minimum`);
    if (said === 'ok') await claim(); else await expectFail(claim, /InsufficientFundsForRent|insufficient funds for rent/i);
    agree++;
  }
  assert.equal(agree, 8);
  await w.finish();
});

test('14.3 condition 1 in litesvm: a buyer with data, a buyer owned by another program and a buy leaving dust are refused by the SDK and by the chain; spending everything passes both', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_110n, symbol: 'BUYR' });
  const rent0 = w.svm.minimumBalanceForRentExemption(0n);
  const funder = await w.signer(100n);
  const tryBuy = async (user, solIn, label) => {
    const c = w.coinView(h);
    const ata = S.associatedTokenAddress(user.address, h.mint);
    if (!w.exists(ata)) await w.send([S.createAssociatedTokenAccountIdempotent({ payer: funder.address, owner: user.address, mint: h.mint })], [funder], `ATA for ${label}`);
    const said = prediction(() => S.precheckBuy({ coin: c, userAccount: w.accountInfo(user.address), solIn, rentExemptMinimum: rent0 }));
    let chain = 'ok';
    try { await w.send([w.ix.buy({ user: user.address, coin: h.coin, solIn, minTokensOut: 0n })], [user], label); } catch (e) { chain = e.message; }
    return { said, chain };
  };
  // a key whose account carries data (a router PDA with data cannot buy, 14.3)
  const withData = await generateKeyPairSigner();
  w.setRaw(withData.address, Buffer.alloc(8), S.ADDRESSES.system, 5n * LAMPORTS);
  let r = await tryBuy(withData, LAMPORTS, 'buyer with data');
  assert.equal(r.said, 'BuyerCarriesData');
  assert.match(r.chain, /must not carry data|custom program error: 0x3|InvalidAccountData/i);
  // a key assigned to another program
  const assigned = await generateKeyPairSigner();
  w.setRaw(assigned.address, Buffer.alloc(0), S.ADDRESSES.token, 5n * LAMPORTS);
  r = await tryBuy(assigned, LAMPORTS, 'buyer owned by SPL Token');
  assert.equal(r.said, 'BuyerNotSystemAccount');
  assert.notEqual(r.chain, 'ok');
  // a buy that leaves 1 lamport (rent-paying) in a rent-exempt wallet
  const dusty = await generateKeyPairSigner();
  w.svm.airdrop(dusty.address, lamports(2n * LAMPORTS));
  r = await tryBuy(dusty, 2n * LAMPORTS - 1n, 'buy leaving 1 lamport');
  assert.equal(r.said, 'BuyerLeftBelowRent');
  assert.match(r.chain, /InsufficientFundsForRent|insufficient funds for rent/i);
  // leaving exactly the minimum, and spending everything, both pass
  r = await tryBuy(dusty, 2n * LAMPORTS - rent0, 'buy leaving the minimum');
  assert.deepEqual([r.said, r.chain], ['ok', 'ok']);
  const all = await generateKeyPairSigner();
  w.svm.airdrop(all.address, lamports(LAMPORTS));
  r = await tryBuy(all, LAMPORTS, 'buy of the whole balance');
  assert.deepEqual([r.said, r.chain], ['ok', 'ok']);
  assert.equal(w.lamportsOf(all.address), 0n);
  w.addHolder(h.mint, dusty); w.addHolder(h.mint, all);
  await w.finish();
});

test('R03 last clause: initRewardsForCoin simulates the real init_city and proposes only the config forward_holders_fees accepts', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_120n, symbol: 'RWD' });
  const u = await w.signer(100n);
  await w.buy(u, h, 10n * LAMPORTS);
  const stranger = await w.signer(1n);
  const getAccount = async (k) => w.accountInfo(k);
  // the World's simulator, signed by the payer, the registry admin and whoever is named authority
  const simulator = (authority) => async (ixs) => {
    const r = await w.simulate(ixs, [w.payer, w.admin, authority], { feePayer: w.payer });
    return r.ok ? { ok: true, account: r.account } : { ok: false, error: r.error };
  };
  const coin = w.coinView(h);
  const base = { getAccount, simulate: simulator(w.admin), payer: w.payer.address, registryAdmin: w.admin.address, authority: w.admin.address, coin };
  const R = w.rewardsPdas();
  const config = R.city(h.mint);
  const otherMint = (await generateKeyPairSigner()).address; // a real mint that is neither WSOL nor the coin
  w.setRaw(otherMint, mintData({ decimals: 6 }), S.ADDRESSES.token);
  // every wrong config is refused before anything is proposed, and nothing exists afterwards
  for (const [o, problem] of [
    [{ rewardModel: 'Creator', founderBps: 10_000 }, 'model is not Holders'],
    [{ rewardModel: 'Split', founderBps: 5_000 }, 'model is not Holders'],
    [{ rewardMint: otherMint }, 'reward mint is not WSOL'],
    [{ authority: stranger.address, simulate: simulator(stranger) }, 'authority is not the vicinity_curve admin'],
  ]) {
    await assert.rejects(() => S.initRewardsForCoin({ ...base, ...o }), (e) => e instanceof S.RewardsConfigError && e.problems.some((p) => p.includes(problem)), problem);
    assert.equal(w.exists(config), false, 'nothing was created');
  }
  // a mint the simulation cannot use fails as a simulation
  w.setRaw(S.ADDRESSES.nativeMint, Buffer.alloc(0), S.ADDRESSES.system, 1n);
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'SimulationFailed' || e.code === 'WouldBeWrong');
  // put WSOL back as the World made it
  w.setRaw(S.ADDRESSES.nativeMint, mintData({ decimals: 9 }), S.ADDRESSES.token);
  // the right config: proposed, sent, and it carries the holders' money (forward + SyncNative)
  const r = await S.initRewardsForCoin(base);
  assert.equal(r.instructions.length, 1);
  assert.deepEqual([r.config, r.view.rewardModel, r.view.founderBps, r.view.authority], [config, S.REWARDS_MODEL_HOLDERS, 0, w.admin.address]);
  await w.send(r.instructions, [w.admin], 'init_city as initRewardsForCoin proposed it');
  const pending = w.coinView(h).holdersPending;
  assert.ok(pending > 0n);
  await w.forward(h);
  assert.equal(w.coinView(h).holdersPending, 0n);
  // asked again: nothing to do
  const again = await S.initRewardsForCoin(base);
  assert.deepEqual([again.instructions.length, again.already], [0, true]);
  // an authority transfer started on the correct config makes it refused until it is accepted or cancelled (4.15)
  await w.send([w.rewardsIx('propose_authority', { new_authority: new PublicKey(stranger.address) }, { authority: w.admin.address, config })], [w.admin], 'rewards propose_authority');
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'ExistsWrong' && e.problems.includes('an authority transfer is pending'));
  // a coin whose config was made wrong behind the SDK's back: reported as unfixable
  const h2 = await w.launchCoin({ cityId: 2_121n, symbol: 'RWD2' });
  await w.initRewardsCity(h2, { model: 'Creator', founderBps: 10_000 });
  await assert.rejects(() => S.initRewardsForCoin({ ...base, coin: w.coinView(h2) }), (e) => e.code === 'ExistsWrong' && e.problems.includes('model is not Holders'));
  await w.finish();
});

test('initRewardsForCoin reads the admin from the Launchpad: after an admin change it requires the new admin as authority', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_130n, symbol: 'ADM' });
  const next = await w.signer(1n);
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose');
  await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept');
  const sim = (authority) => async (ixs) => {
    const r = await w.simulate(ixs, [w.payer, w.admin, authority], { feePayer: w.payer });
    return r.ok ? { ok: true, account: r.account } : { ok: false, error: r.error };
  };
  const base = { getAccount: async (k) => w.accountInfo(k), payer: w.payer.address, registryAdmin: w.admin.address, coin: w.coinView(h) };
  // the rewards registry admin is still the old key; the root publisher must be the vicinity_curve admin
  await assert.rejects(() => S.initRewardsForCoin({ ...base, simulate: sim(w.admin), authority: w.admin.address }), /authority is not the vicinity_curve admin/);
  const r = await S.initRewardsForCoin({ ...base, simulate: sim(next), authority: next.address });
  assert.equal(r.view.authority, next.address);
  await w.finish();
});
