// L10 (part 1) and the rewards path (4.14 to 4.16, 6.4, 6.5, R01 to R03):
// withdraw_platform_fees pays only FEE_RECIPIENT; claim_founder_fees pays only
// the founder; forward_holders_fees credits the city's vault made by the real
// vicinity_rewards init_city, followed by a top-level SyncNative, after which
// the real fund_epoch_from_vault books it and a holder claims with a Merkle
// proof; wrong rewards configs are refused (and a wrong model forever); no-ops
// emit nothing; a keeper can batch them.
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import { World, S, expectFail, tokenAccountInfo, LAMPORTS, DAY } from './helpers.mjs';
import { buildTree, claimArgs } from '../sdk/merkle.mjs';

const { BN } = anchorPkg;
const { PublicKey } = web3;

async function tradedCoin(w, cityId, symbol, sol = 20n) {
  const h = await w.launchCoin({ cityId, symbol });
  const u = await w.signer(sol * 3n);
  const b = await w.buy(u, h, sol * LAMPORTS, { label: `${symbol} buy` });
  await w.sell(u, h, b.q.tokensOut / 2n, { label: `${symbol} sell` });
  return { h, u };
}

test('L10 withdraw_platform_fees: anyone may call, only FEE_RECIPIENT receives, the whole bucket, then a no-op', async () => {
  const w = await World.create();
  const { h } = await tradedCoin(w, 500n, 'WDRW');
  const stranger = await w.signer(1n);
  const pending = w.coinView(h).platformPending;
  assert.ok(pending > 0n);
  // the destination is the compiled constant: any other account is refused
  await expectFail(() => w.send([w.ix.withdrawPlatformFees({ coin: h.coin, overrides: { fee_recipient: stranger.address } })], [], 'to a stranger', { feePayer: stranger }), 'InvalidAddress');
  const f0 = w.lamportsOf(S.ADDRESSES.feeRecipient);
  const r = await w.withdraw(h, { feePayer: stranger, label: 'withdraw by a stranger' });
  assert.equal(w.lamportsOf(S.ADDRESSES.feeRecipient) - f0, pending);
  assert.deepEqual(r.events[0], { name: 'PlatformFeesWithdrawn', data: { city_id: 500n, amount: pending, total_withdrawn: pending } });
  const c = w.coinView(h);
  assert.deepEqual([c.platformPending, c.platformWithdrawn], [0n, pending]);
  const again = await w.withdraw(h, { label: 'withdraw again' });
  assert.equal(again.events.length, 0, 'no-op: nothing to move, no event');
  await w.finish();
});

test('L10 claim_founder_fees: only the founder, the whole bucket, a no-op when empty; a keeper batches many coins', async () => {
  const w = await World.create();
  const { h } = await tradedCoin(w, 501n, 'CLM');
  const { h: h2 } = await tradedCoin(w, 502n, 'CLM2');
  const stranger = await w.signer(1n);
  await expectFail(() => w.send([w.ix.claimFounderFees({ founder: stranger.address, coin: h.coin })], [stranger], 'claim by a stranger'), 'WrongFounder');
  const pending = w.coinView(h).founderPending;
  const f0 = w.lamportsOf(h.founder.address);
  const r = await w.claim(h);
  assert.equal(w.lamportsOf(h.founder.address) - f0, pending, 'the founder receives the whole bucket (the fee payer pays the fee)');
  assert.deepEqual(r.events[0].data, { city_id: 501n, founder: h.founder.address, amount: pending, total_claimed: pending });
  assert.equal((await w.claim(h, h.founder, { label: 'claim again' })).events.length, 0);
  // a keeper's batch over two coins: withdraws for both, no-op claims are harmless in the same transaction
  const r2 = await w.send([w.ix.withdrawPlatformFees({ coin: h.coin }), w.ix.withdrawPlatformFees({ coin: h2.coin }),
    w.ix.withdrawPlatformFees({ coin: h.coin })], [], 'keeper batch', { feePayer: w.keeper });
  assert.equal(r2.events.filter((e) => e.name === 'PlatformFeesWithdrawn').length, 2);
  await w.finish();
});

test('R01/R02 forward_holders_fees into the real vicinity_rewards vault, SyncNative, fund_epoch_from_vault, and a holder\'s claim', async () => {
  const w = await World.create();
  const { h, u } = await tradedCoin(w, 503n, 'RWD', 40n);
  // no rewards config yet: refused, the money keeps collecting
  await expectFail(() => w.forward(h, { label: 'forward without a config' }), 'WrongRewardsConfig', 'AccountNotInitialized');
  const { config, vault } = await w.initRewardsCity(h);
  const R = w.rewardsPdas();
  assert.equal(config, w.P.rewardsAccounts(h.mint).config);
  const pending = w.coinView(h).holdersPending;
  const coin0 = w.lamportsOf(h.coin);
  const vault0 = tokenAccountInfo(w.accountInfo(vault)).amount;
  const r = await w.forward(h);
  assert.equal(coin0 - w.lamportsOf(h.coin), pending, 'R02 the Coin\'s lamports drop by exactly the amount');
  assert.equal(tokenAccountInfo(w.accountInfo(vault)).amount - vault0, pending, 'R02 the vault\'s token amount grows by exactly the amount');
  assert.deepEqual(r.events[0].data, { city_id: 503n, amount: pending, rewards_vault: vault, total_forwarded: pending });
  assert.deepEqual(r.top.map((t) => t.program).slice(-2), [w.programId, S.ADDRESSES.token], 'SyncNative is a separate top-level instruction after it (4.15)');
  // more trading, then a forward without SyncNative: the lamports arrive, the amount waits for a later SyncNative
  await w.buy(u, h, 10n * LAMPORTS);
  const p2 = w.coinView(h).holdersPending;
  const a1 = tokenAccountInfo(w.accountInfo(vault)).amount;
  await w.forward(h, { sync: false, label: 'forward, no SyncNative' });
  assert.equal(tokenAccountInfo(w.accountInfo(vault)).amount, a1, 'not synced yet; nothing is lost');
  await w.send([S.syncNative({ account: vault })], [], 'SyncNative later (permissionless)');
  assert.equal(tokenAccountInfo(w.accountInfo(vault)).amount, a1 + p2);
  // the rewards authority (the admin) funds an epoch from the vault: two holders, a Merkle root
  const total = tokenAccountInfo(w.accountInfo(vault)).amount;
  const holderA = await w.signer(1n); const holderB = await w.signer(1n);
  const tree = buildTree([{ claimant: holderA.address, amount: total / 3n }, { claimant: holderB.address, amount: total - total / 3n }]);
  const epoch = R.epoch(config, 0n);
  await w.send([w.rewardsIx('fund_epoch_from_vault', {
    merkle_root: [...tree.root], num_leaves: 2, snapshot_slot: new BN(String(w.slot())), snapshot_hash: Array(32).fill(7), claim_window_secs: new BN(String(14n * DAY)),
  }, {
    authority: w.admin.address, payer: w.payer.address, config, reward_mint: S.ADDRESSES.nativeMint, vault, founder: h.founder.address,
    founder_token_account: S.associatedTokenAddress(h.founder.address, S.ADDRESSES.nativeMint), epoch,
    token_program: S.ADDRESSES.token, associated_token_program: S.ADDRESSES.associatedToken, system_program: S.ADDRESSES.system,
  })], [w.admin], 'rewards fund_epoch_from_vault');
  // holder A claims with a proof: WSOL to their associated token account
  const ca = claimArgs(tree, 0);
  const ataA = S.associatedTokenAddress(holderA.address, S.ADDRESSES.nativeMint);
  await w.send([w.rewardsIx('claim', {
    epoch_index: new BN(0), leaf_index: ca.index, amount: new BN(String(ca.amount)), proof: ca.proof.map((p) => [...p]),
  }, {
    claimant: holderA.address, config, epoch, claim_status: R.claim(epoch, holderA.address), reward_mint: S.ADDRESSES.nativeMint, vault,
    claimant_token_account: ataA, token_program: S.ADDRESSES.token, associated_token_program: S.ADDRESSES.associatedToken, system_program: S.ADDRESSES.system,
  })], [holderA], 'rewards claim (holder A)');
  assert.equal(tokenAccountInfo(w.accountInfo(ataA)).amount, total / 3n, 'R01 the holder received his share of the forwarded fees');
  assert.equal(tokenAccountInfo(w.accountInfo(vault)).amount, total - total / 3n);
  await w.finish();
});

test('R03 wrong rewards configs: a wrong model is refused forever; a stranger authority until it hands over to the admin; a pending transfer blocks', async () => {
  const w = await World.create();
  const stranger = await w.signer(5n);
  // Creator model (100% to the founder): refused, and it can never be fixed
  const { h: a } = await tradedCoin(w, 510n, 'CREA');
  await w.initRewardsCity(a, { model: 'Creator', founderBps: 10_000 });
  await expectFail(() => w.forward(a, { label: 'forward to a Creator config' }), 'WrongRewardsConfig');
  // Split model: refused too
  const { h: b } = await tradedCoin(w, 511n, 'SPLT');
  await w.initRewardsCity(b, { model: 'Split', founderBps: 5_000 });
  await expectFail(() => w.forward(b, { label: 'forward to a Split config' }), 'WrongRewardsConfig');
  // Holders, WSOL, 0%, but a stranger is the root publisher
  const { h: c } = await tradedCoin(w, 512n, 'STRG');
  const { config } = await w.initRewardsCity(c, { authority: stranger });
  await expectFail(() => w.forward(c, { label: 'forward, stranger authority' }), 'WrongRewardsConfig');
  // the stranger proposes the admin: while the transfer is pending, still refused
  await w.send([w.rewardsIx('propose_authority', { new_authority: new PublicKey(w.admin.address) }, { authority: stranger.address, config })], [stranger], 'rewards propose_authority');
  await expectFail(() => w.forward(c, { label: 'forward, authority transfer pending' }), 'WrongRewardsConfig');
  await w.send([w.rewardsIx('accept_authority', {}, { new_authority: w.admin.address, config })], [w.admin], 'rewards accept_authority');
  await w.forward(c, { label: 'forward once the admin is the authority' });
  // substitutions: another coin's vault or config, a vault that is not WSOL under the config
  const { h: d } = await tradedCoin(w, 513n, 'GOOD');
  await w.initRewardsCity(d);
  const dr = w.P.rewardsAccounts(d.mint); const cr = w.P.rewardsAccounts(c.mint);
  await expectFail(() => w.send([w.ix.forwardHoldersFees({ coin: d.coin, overrides: { rewards_vault: cr.vault } })], [], 'another city\'s vault', { feePayer: w.keeper }), 'WrongRewardsVault');
  await expectFail(() => w.send([w.ix.forwardHoldersFees({ coin: d.coin, overrides: { rewards_city_config: cr.config, rewards_vault: cr.vault } })], [], 'another city\'s config', { feePayer: w.keeper }), 'WrongRewardsConfig');
  await expectFail(() => w.send([w.ix.forwardHoldersFees({ coin: d.coin, overrides: { rewards_vault: d.vault } })], [], 'the coin vault as rewards vault', { feePayer: w.keeper }), 'WrongRewardsVault');
  await w.forward(d);
  void dr;
  await w.finish();
});

test('4.2: a new admin must also take over each city\'s rewards authority; forwards wait in holders_pending until then', async () => {
  const w = await World.create();
  const { h, u } = await tradedCoin(w, 520n, 'ADMN');
  const { config } = await w.initRewardsCity(h);
  await w.forward(h);
  const next = await w.signer(5n);
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose');
  await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept');
  const oldAdmin = w.admin;
  await w.buy(u, h, 5n * LAMPORTS);
  await expectFail(() => w.forward(h, { label: 'forward after the admin moved' }), 'WrongRewardsConfig');
  const waiting = w.coinView(h).holdersPending;
  assert.ok(waiting > 0n, 'the holders\' money waits');
  await w.send([w.rewardsIx('propose_authority', { new_authority: new PublicKey(next.address) }, { authority: oldAdmin.address, config })], [oldAdmin], 'rewards propose');
  await w.send([w.rewardsIx('accept_authority', {}, { new_authority: next.address, config })], [next], 'rewards accept');
  w.admin = next;
  const r = await w.forward(h, { label: 'forward after the rewards authority followed' });
  assert.equal(r.events[0].data.amount, waiting);
  await w.finish();
});
