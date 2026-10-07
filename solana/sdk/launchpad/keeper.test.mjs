// The keeper's planning rules on hand-made states (no chain). The same code
// runs against the real programs in tests-launchpad/10-keeper.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planKeeper, MigrationProgress } from './keeper.mjs';

const T = 85_000_000_000n;
function coin(id, { quoteReserve = 0n, creatorQuoteFee = 0n, isMigrated = 0, progress = 0, leftover = 0, surplusTaken = 0, creatorSurplus = 0n, pot = 0n, rewardsProblem = null, positions = [] } = {}) {
  return {
    cityId: BigInt(id), pool: { quoteReserve, creatorQuoteFee, isMigrated, migrationProgress: progress, isWithdrawLeftover: leftover, isCreatorWithdrawSurplus: surplusTaken },
    config: { migrationQuoteThreshold: T }, complete: quoteReserve >= T, creatorSurplus, potBalance: pot, rewardsProblem, positions,
  };
}
const kinds = (plan, id) => plan.steps.filter((s) => s.coin?.cityId === BigInt(id)).map((s) => s.kind);

test('a fresh coin with nothing waiting plans nothing', () => {
  const p = planKeeper({ coins: [coin(1)] });
  assert.deepEqual(p.steps, []);
  assert.deepEqual(p.notes, []);
});

test('curve fees: harvest then forward (daily); the minute pass leaves an incomplete curve alone', () => {
  const s = { coins: [coin(1, { creatorQuoteFee: 10n, quoteReserve: T / 2n })] };
  assert.deepEqual(kinds(planKeeper(s, { daily: true }), 1), ['harvestCurve', 'forward']);
  assert.deepEqual(kinds(planKeeper(s, { daily: false }), 1), []);
});

test('complete curve: graduate, leftover, harvest (fees and surplus), forward, even in the minute pass', () => {
  const s = { coins: [coin(1, { quoteReserve: T + 40n, creatorQuoteFee: 5n, progress: MigrationProgress.LockedVesting, creatorSurplus: 16n })] };
  assert.deepEqual(kinds(planKeeper(s, { daily: false }), 1), ['migrate', 'withdrawLeftover', 'harvestCurve', 'forward']);
});

test('the surplus alone is worth one harvest; a zero share or one already taken is not', () => {
  const base = { quoteReserve: T + 40n, isMigrated: 1, progress: MigrationProgress.CreatedPool, leftover: 1 };
  assert.deepEqual(kinds(planKeeper({ coins: [coin(1, { ...base, creatorSurplus: 16n })] }, { daily: false }), 1), ['harvestCurve', 'forward']);
  assert.deepEqual(kinds(planKeeper({ coins: [coin(1, { ...base, creatorSurplus: 0n })] }, { daily: false }), 1), []);
  assert.deepEqual(kinds(planKeeper({ coins: [coin(1, { ...base, creatorSurplus: 16n, surplusTaken: 1 })] }, { daily: false }), 1), []);
});

test('graduated: the daily pass harvests every city position; the leftover only once', () => {
  const positions = [{ nftMint: 'm', nftAccount: 'a', pool: 'p', position: 'x' }];
  const s = { coins: [coin(1, { quoteReserve: T, isMigrated: 1, progress: MigrationProgress.CreatedPool, leftover: 1, surplusTaken: 1, positions })] };
  assert.deepEqual(kinds(planKeeper(s, { daily: true }), 1), ['harvestPool', 'forward']);
  assert.deepEqual(kinds(planKeeper(s, { daily: false }), 1), []);
  const s2 = { coins: [coin(1, { quoteReserve: T, isMigrated: 1, progress: MigrationProgress.CreatedPool, leftover: 0, surplusTaken: 1 })] };
  assert.deepEqual(kinds(planKeeper(s2, { daily: false }), 1), ['withdrawLeftover']);
});

test('a coin whose rewards config would make forward fail is reported and never forwarded', () => {
  const p = planKeeper({ coins: [coin(1, { creatorQuoteFee: 10n, rewardsProblem: 'no rewards config yet' }), coin(2, { pot: 7n })] }, { daily: true });
  assert.deepEqual(kinds(p, 1), ['harvestCurve']);
  assert.deepEqual(kinds(p, 2), ['forward']);
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0].note, /no rewards config/);
});

test('a complete curve stuck in another migration stage is reported, not cranked', () => {
  const p = planKeeper({ coins: [coin(1, { quoteReserve: T, progress: MigrationProgress.PostBondingCurve })] }, { daily: false });
  assert.deepEqual(kinds(p, 1), []);
  assert.match(p.notes[0].note, /migration progress is 1/);
});

test('a missing referral account of the dev wallet is recreated first, in every pass (review F1)', () => {
  const W = 'So11111111111111111111111111111111111111112';
  for (const daily of [true, false]) {
    const p = planKeeper({ coins: [coin(1)], missingReferrals: [W] }, { daily });
    assert.deepEqual(p.steps.map((s) => [s.kind, s.quoteMint]), [['referralAccount', W]]);
  }
  assert.deepEqual(planKeeper({ coins: [coin(1)], missingReferrals: [] }).steps, []);
});

test('positions outside the coin\'s own pool are reported, never harvested (review nit N5)', () => {
  const s = { coins: [{ ...coin(1, { quoteReserve: T, isMigrated: 1, progress: MigrationProgress.CreatedPool, leftover: 1, surplusTaken: 1 }), ignoredPositions: 3 }] };
  const p = planKeeper(s, { daily: true });
  assert.deepEqual(kinds(p, 1), []);
  assert.match(p.notes[0].note, /3 position NFT\(s\).*ignored/);
});
