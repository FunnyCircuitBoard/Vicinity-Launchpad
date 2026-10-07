// The snapshot rules on hand-made balances (no chain). The in-process test
// tests-launchpad/11-holders-pot.test.mjs runs them against real holders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { holderBalances, planRound, roundFile, solanaTokensCsv, timeWeighted, minPayoutFor, ROUND_RULES } from './snapshot.mjs';
import { buildTree, toHex } from '../merkle.mjs';

const wallet = () => web3.Keypair.generate().publicKey.toBase58();
const pda = () => web3.PublicKey.findProgramAddressSync([Buffer.from(String(Math.random()))], web3.SystemProgram.programId)[0].toBase58();

test('sums by owner; program addresses, team wallets and the founder never count; tiny holders are dropped', () => {
  const [a, b, c, dev, founder, vault] = [wallet(), wallet(), wallet(), wallet(), wallet(), pda()];
  const accounts = [
    { owner: a, amount: 600n }, { owner: a, amount: 400n }, // two accounts of one wallet
    { owner: b, amount: 500n }, { owner: c, amount: 0n },
    { owner: dev, amount: 10_000n }, { owner: founder, amount: 9_000n }, { owner: vault, amount: 1_000_000n },
    { owner: wallet(), amount: 1n }, // dust holder
  ];
  const r = holderBalances(accounts, { excludeOwners: [dev, founder], minBalanceBps: 100n }); // 1% for the test
  assert.deepEqual(r.eligible, [{ owner: a, balance: 1000n }, { owner: b, balance: 500n }]);
  assert.equal(r.circulating, 1501n);
  assert.equal(r.minBalance, 16n); // ceil(1% of 1501)
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.owner, e.reason]));
  assert.match(reasons[dev], /team or founder/);
  assert.match(reasons[founder], /team or founder/);
  assert.match(reasons[vault], /program address/);
  assert.equal(r.excluded.length, 4);
});

test('pro rata, rounded down; everyone paid at least the minimum, the rest carries over', () => {
  const eligible = [{ owner: wallet(), balance: 700n }, { owner: wallet(), balance: 290n }, { owner: wallet(), balance: 10n }];
  const r = planRound(eligible, 1_000_000_000n, { minPayout: 20_000_000n, minHolders: 2 });
  // the 1% holder would get 0.01 SOL < 0.02: dropped, then the rest is split again
  assert.equal(r.leaves.length, 2);
  for (const l of r.leaves) assert.ok(l.amount >= 20_000_000n);
  assert.equal(r.allocated + r.dust, 1_000_000_000n);
  assert.ok(r.dust < 2n);
  assert.equal(r.fundable, true);
  // the default gate: 20 holders at 0.01 SOL, so 0.2 SOL is the least worth a round
  const twenty = Array.from({ length: 20 }, () => ({ owner: wallet(), balance: 1n }));
  assert.equal(planRound(twenty, 199_999_999n).fundable, false);
  assert.equal(planRound(twenty, 200_000_000n).fundable, true);
  assert.equal(planRound(twenty, 200_000_000n).leaves.length, ROUND_RULES.minHolders);
  assert.equal(planRound([], 10n).fundable, false);
});

test('the round file rebuilds the same Merkle root, and its hash changes with any byte', () => {
  const leaves = [{ claimant: wallet(), amount: 30n }, { claimant: wallet(), amount: 20n }];
  const f = roundFile({ mint: wallet(), rewardMint: wallet(), slot: 7, leaves, circulating: 100n, minBalance: 1n });
  const parsed = JSON.parse(f.text);
  assert.equal(parsed.merkleRoot, toHex(buildTree(parsed.leaves.map((l) => ({ claimant: l.claimant, amount: BigInt(l.amount) }))).root));
  const g = roundFile({ mint: parsed.coinMint, rewardMint: parsed.rewardMint, slot: 8, leaves, circulating: 100n, minBalance: 1n });
  assert.notEqual(toHex(f.hash), toHex(g.hash));
});

test('CSV for solana-tokens is in whole tokens', () => {
  const a = wallet();
  assert.equal(solanaTokensCsv([{ claimant: a, amount: 1_500_000_000n }, { claimant: a, amount: 7n }], 9), `recipient,amount\n${a},1.5\n${a},0.000000007\n`);
});

test('time-weighting: min(balance at the cutoff, average of the samples); a cutoff-only holder gets nothing (review R3)', () => {
  const [a, b, flash] = [wallet(), wallet(), wallet()];
  const steady = [{ owner: a, amount: 100n }, { owner: b, amount: 100n }];
  const samples = [steady, steady, [{ owner: a, amount: 100n }, { owner: b, amount: 40n }], [{ owner: a, amount: 50n }, { owner: a, amount: 50n }]];
  const final = [{ owner: a, amount: 300n }, { owner: b, amount: 40n }, { owner: flash, amount: 10_000n }];
  const w = timeWeighted(final, samples);
  assert.equal(w.get(a), 100n, 'bought more at the end: counts with its average');
  assert.equal(w.get(b), 40n, 'sold: counts with what it holds now');
  assert.equal(w.has(flash), false, 'held only at the cutoff');
  const r = holderBalances(final, { samples, minBalanceBps: 1n });
  assert.deepEqual(r.eligible.map((e) => e.owner), [a, b]);
  // without samples the old single-slot rule applies (and prepareRound refuses to fund it)
  assert.equal(holderBalances(final).eligible[0].owner, flash);
});

test('multisig vaults (program addresses) are left out unless put on the include list (review N4, N7)', () => {
  const vault = pda();
  const accounts = [{ owner: vault, amount: 500n }, { owner: wallet(), amount: 500n }];
  assert.equal(holderBalances(accounts).eligible.length, 1);
  assert.equal(holderBalances(accounts, { includeOwners: [vault] }).eligible.length, 2);
});

test('the minimum payout: 0.01 SOL for SOL rewards; any other reward token must set its own (review N2, N4)', () => {
  assert.equal(minPayoutFor('So11111111111111111111111111111111111111112'), 10_000_000n);
  assert.throws(() => minPayoutFor(wallet()), /minimum payout/);
  assert.equal(minPayoutFor(wallet(), ROUND_RULES, 5n), 5n);
  assert.equal(minPayoutFor(wallet(), { ...ROUND_RULES, minPayout: 7n }), 7n);
});
