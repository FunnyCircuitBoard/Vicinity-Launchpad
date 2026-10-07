// rewards.mts, payout.mts and lookup-table.mts on their own (no chain). The
// same builders run against the real programs in
// tests-launchpad/13-rewards-payout-tools.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import web3 from '@solana/web3.js';
import { buildAirdropBatches, airdropTransactions, airdropPlanJson, recipientsFromLeaves, buildFundRound, buildClaim, MIN_NATIVE_PUSH, TOKEN_ACCOUNT_RENT } from './rewards.mts';
import { planPayouts, refHash, buildOptIn, PAYOUT_COOLDOWN_SECS } from './payout.mts';
import { launchpadLookupTableAddresses, buildCreateLookupTable, recentSlotForLookupTable, EXTEND_CHUNK } from './lookup-table.mts';
import { MAX_TX_BYTES, toV0Transaction, txBytes } from './trade.mts';
import { ADDRESSES, PROGRAM_IDS, pdas, ata } from './pda.mjs';
import { buildTree } from '../merkle.mjs';
import type { CoinAccount, LaunchpadAccount, RewardsCityConfig } from './accounts.mts';

const P = pdas();
// deterministic distinct on-curve-or-not addresses are fine for planning: use PDAs as stand-ins
const addr = (i: number) => P.coin(1_000_000 + i);
const SENDER = '9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa';
const MINT = P.coin(42);

test('airdrop: every recipient exactly once, in order, in batches under 1,232 bytes; unsigned', () => {
  const recipients = Array.from({ length: 57 }, (_, i) => ({ owner: addr(i), amount: BigInt(1_000 + i) }));
  const plan = buildAirdropBatches({ sender: SENDER, mint: MINT, decimals: 6, recipients });
  assert.equal(plan.recipients, 57);
  assert.equal(plan.total, recipients.reduce((s, r) => s + r.amount, 0n));
  assert.deepEqual(plan.batches.flatMap((b) => b.recipients), recipients);
  for (const b of plan.batches) {
    assert.ok(b.bytes <= MAX_TX_BYTES, `batch ${b.index}: ${b.bytes}`);
    assert.equal(b.total, b.recipients.reduce((s, r) => s + r.amount, 0n));
    assert.equal(b.instructions.length, 2 * b.recipients.length, 'create-if-missing + transferChecked per recipient');
  }
  assert.equal(plan.maxAccountRentLamports, TOKEN_ACCOUNT_RENT * 57n);
  const txs = airdropTransactions(plan, '11111111111111111111111111111111');
  assert.equal(txs.length, plan.batches.length);
  for (const tx of txs) {
    assert.equal(tx.message.header.numRequiredSignatures, 1, 'only the sender signs');
    assert.ok(tx.signatures.every((s) => s.every((x) => x === 0)), 'unsigned');
  }
  const j = JSON.parse(airdropPlanJson(plan));
  assert.equal(j.batches.length, plan.batches.length);
  assert.equal(j.batches[0].recipients[0].amount, '1000');
  const decoded = web3.VersionedTransaction.deserialize(Buffer.from(j.batches[0].unsignedTransaction, 'base64'));
  assert.equal(decoded.message.staticAccountKeys[0].toBase58(), SENDER);
  console.log(`airdrop of 57 holders: ${plan.batches.length} transactions (${plan.batches.map((b) => b.recipients.length).join(', ')} recipients)`);
});

test('airdrop: native SOL, Token-2022, and every refusal', () => {
  const sol = buildAirdropBatches({ sender: SENDER, mint: 'SOL', decimals: 9, recipients: Array.from({ length: 30 }, (_, i) => ({ owner: addr(i), amount: MIN_NATIVE_PUSH })) });
  assert.ok(sol.batches.every((b) => b.instructions.every((i) => i.programAddress === PROGRAM_IDS.system)));
  assert.equal(sol.maxAccountRentLamports, 0n);
  const t22 = buildAirdropBatches({ sender: SENDER, mint: MINT, decimals: 6, recipients: [{ owner: addr(1), amount: 5n }], tokenProgram: PROGRAM_IDS.token2022 });
  assert.equal(t22.batches[0].instructions[1].programAddress, PROGRAM_IDS.token2022);
  assert.equal(t22.batches[0].instructions[1].accounts[2].address, ata(addr(1), MINT, PROGRAM_IDS.token2022));
  const r = (owner: string, amount: bigint) => ({ owner, amount });
  assert.throws(() => buildAirdropBatches({ sender: SENDER, mint: MINT, decimals: 6, recipients: [r(addr(1), 1n), r(addr(1), 2n)] }), /twice/);
  assert.throws(() => buildAirdropBatches({ sender: SENDER, mint: MINT, decimals: 6, recipients: [r(SENDER, 1n)] }), /sender/);
  assert.throws(() => buildAirdropBatches({ sender: SENDER, mint: MINT, decimals: 6, recipients: [r(addr(1), 0n)] }), /positive/);
  assert.throws(() => buildAirdropBatches({ sender: SENDER, mint: MINT, decimals: 6, recipients: [r('not-an-address', 1n)] }), /not an address/);
  assert.throws(() => buildAirdropBatches({ sender: SENDER, mint: 'SOL', decimals: 9, recipients: [r(addr(1), 1_000n)] }), /rent/);
  assert.deepEqual(recipientsFromLeaves([{ claimant: addr(3), amount: 7n }]), [{ owner: addr(3), amount: 7n }]);
});

const coin = { cityId: 5n, mint: MINT, quoteMint: ADDRESSES.wsol } as unknown as CoinAccount;
const rewardsConfig = (over: Partial<RewardsCityConfig> = {}): RewardsCityConfig => ({
  authority: SENDER, founder: addr(99), cityCoinMint: MINT, rewardMint: ADDRESSES.wsol, vault: addr(98), rewardModel: 'Holders', founderBps: 0,
  paused: false, epochCount: 3n, carryOver: 0n, totalFunded: 0n, totalToFounder: 0n, totalToHolders: 0n, totalClaimed: 0n, ...over,
});

test('funding a round: forward first, then fund_epoch_from_vault at the next epoch; only Holders-only configs', () => {
  const root = new Uint8Array(32).fill(1), snapshotHash = new Uint8Array(32).fill(2);
  const ixs = buildFundRound({ authority: SENDER, coin, rewardsConfig: rewardsConfig(), round: { root, numLeaves: 25, slot: 123n, snapshotHash } });
  assert.deepEqual(ixs.map((i) => i.programAddress), [PROGRAM_IDS.launchpad, PROGRAM_IDS.rewards]);
  assert.ok(ixs[1].accounts.some((a) => a.role & 2 && a.address === SENDER));
  for (const bad of [{ rewardModel: 'Split' as const }, { founderBps: 2_500 }, { authority: addr(5) }, { rewardMint: MINT }]) {
    assert.throws(() => buildFundRound({ authority: SENDER, coin, rewardsConfig: rewardsConfig(bad), round: { root, numLeaves: 25, slot: 1n, snapshotHash } }), JSON.stringify(bad));
  }
  assert.throws(() => buildFundRound({ authority: SENDER, coin, rewardsConfig: rewardsConfig(), round: { root, numLeaves: 0, slot: 1n, snapshotHash } }), /at least one leaf/);
  const tree = buildTree([{ claimant: addr(10), amount: 11n }, { claimant: addr(11), amount: 12n }]);
  assert.equal(buildClaim({ claimant: addr(11), coin, epochIndex: 3n, tree, leafIndex: 1 }).length, 2, 'claim, then unwrap SOL');
  assert.throws(() => buildClaim({ claimant: addr(10), coin, epochIndex: 3n, tree, leafIndex: 1 }), /belongs to/);
});

test('payout planning mirrors every check of payout_founder_fees', () => {
  const lp: LaunchpadAccount = { admin: addr(1), pendingAdmin: PROGRAM_IDS.system, payoutAuthority: addr(2), payoutDestination: addr(3), rewardsProgram: PROGRAM_IDS.rewards, launchesPaused: false, payoutsPaused: false, payoutsConfigured: true, bump: 255 };
  const c = (i: number, over: Partial<CoinAccount> = {}) => ({ address: addr(200 + i), cityId: BigInt(i), founder: addr(300 + i), mint: addr(400 + i), lastPayoutAt: 0n, ...over }) as CoinAccount;
  const opt = (coinAcc: CoinAccount, over = {}) => ({ coin: coinAcc.address, founder: coinAcc.founder, agreedDestination: addr(3), refHash: new Uint8Array(32), optedInAt: 1n, bump: 1, ...over });
  const now = 10_000_000n;
  const c1 = c(1), c2 = c(2), c3 = c(3), c4 = c(4, { lastPayoutAt: now - 100n }), c5 = c(5), c6 = c(6), c7 = c(7);
  const cands = [
    { coin: c1, optIn: opt(c1), vaultBalance: 50n }, // pays
    { coin: c2, optIn: null, vaultBalance: 50n },
    { coin: c3, optIn: opt(c3, { founder: addr(9) }), vaultBalance: 50n },
    { coin: c4, optIn: opt(c4), vaultBalance: 50n },
    { coin: c5, optIn: opt(c5, { agreedDestination: addr(8) }), vaultBalance: 50n },
    { coin: c6, optIn: opt(c6), vaultBalance: 0n },
    { coin: c7, optIn: opt(c7), vaultBalance: 5n },
  ];
  const d = planPayouts({ launchpad: lp, candidates: cands, now, minAmount: 10n, payoutAuthority: addr(2) });
  assert.deepEqual(d.map((x) => x.pay), [true, false, false, false, false, false, false]);
  assert.match(d[1].reason, /not opted in/);
  assert.match(d[2].reason, /founder seat changed/);
  assert.match(d[3].reason, /cooldown/);
  assert.match(d[4].reason, /payout wallet changed/);
  assert.match(d[5].reason, /nothing/);
  assert.match(d[6].reason, /minimum/);
  assert.match(planPayouts({ launchpad: { ...lp, payoutsPaused: true }, candidates: cands, now, payoutAuthority: addr(2) })[0].reason, /paused/);
  assert.match(planPayouts({ launchpad: { ...lp, payoutsConfigured: false }, candidates: cands, now, payoutAuthority: addr(2) })[0].reason, /switched off/);
  assert.match(planPayouts({ launchpad: lp, candidates: cands, now, payoutAuthority: addr(7) })[0].reason, /not the payout authority/);
  assert.equal(planPayouts({ launchpad: lp, candidates: [{ coin: c4, optIn: opt(c4), vaultBalance: 50n }], now: now - 100n + PAYOUT_COOLDOWN_SECS, payoutAuthority: addr(2) })[0].pay, true, 'exactly 24 hours later');
});

test('refHash: SHA-256 of the partner id and a salt; never the id itself', () => {
  const salt = new Uint8Array(16).fill(7);
  const h = refHash('cust_123', salt);
  assert.equal(Buffer.from(h).toString('hex'), createHash('sha256').update('cust_123').update(Buffer.from(salt)).digest('hex'));
  assert.notDeepEqual(refHash('cust_123', new Uint8Array(16).fill(8)), h);
  assert.throws(() => refHash('cust_123', new Uint8Array(8)), /16/);
  assert.throws(() => buildOptIn({ founder: addr(1), cityId: 1n, expectedDestination: addr(2), ref: new Uint8Array(31) }), /32 bytes/);
});

test('the Vicinity lookup table: the shared static accounts, filled in extend transactions that fit', () => {
  const cfgs = [addr(500), addr(501)];
  const list = launchpadLookupTableAddresses({ dbcConfigs: cfgs, quoteMints: [ADDRESSES.wsol, MINT] });
  assert.equal(new Set(list).size, list.length);
  for (const must of [PROGRAM_IDS.dbc, ADDRESSES.dbcPoolAuthority, P.launchpad(), ADDRESSES.feeRecipient, ata(ADDRESSES.feeRecipient, ADDRESSES.wsol), P.launchConfig(cfgs[1])]) assert.ok(list.includes(must), must);
  const t = buildCreateLookupTable({ authority: SENDER, recentSlot: 1_000n, addresses: list });
  assert.equal(t.extends.length, Math.ceil(list.length / EXTEND_CHUNK));
  for (const e of t.extends) assert.ok(txBytes(toV0Transaction({ payer: SENDER, instructions: [e] })) <= MAX_TX_BYTES);
  assert.equal(t.create.programAddress, 'AddressLookupTab1e1111111111111111111111111');
});

test('the lookup table slot: a produced slot behind the tip, never the tip itself (devnet finding)', async () => {
  const produced = new Set([900, 950, 991, 992, 995]); // 993, 994 and 996-1000 were skipped
  const rpc = {
    async getSlot() { return 1_000; },
    async getBlocks(start: number, end?: number) { return [...produced].filter((s) => s >= start && s <= (end ?? start)).sort((a, b) => a - b); },
  };
  assert.equal(await recentSlotForLookupTable(rpc), 992); // newest produced slot <= 1000 - 8
  assert.equal(await recentSlotForLookupTable(rpc, 4), 995);
  await assert.rejects(recentSlotForLookupTable({ async getSlot() { return 1_000; }, async getBlocks() { return []; } }), /no produced slot/);
});
