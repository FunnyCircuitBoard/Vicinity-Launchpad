// The fee status of an official city coin (src/feestatus.js, GET /api/fee-status) and where the pages show it:
//   * the facts: the generated DAMM v2 and PayoutOptIn offsets, DAMM v2's own update_fee (wrapping, the cap, no liquidity), DBC's
//     creator surplus, the fee split
//   * the replay: account bytes written by the REAL programs (solana/tests-launchpad/21, RECORD=1: launch, trades, harvest, a gift to
//     the vault, claim, holder rewards set up, forward, the founder's Collect, many trades and the full curve before any harvest,
//     graduation, the curve harvest with the surplus, DAMM v2 trades, the pool harvest) read again here on the fake chain through the
//     real route: every answer equals what the Worker read next to litesvm, where it was checked against the Coin record's counters as
//     the program wrote them and against what the next harvest or Collect really moved
//   * graduated coins: empty positions anyone can make for the record, positions in a pool of another pair and a token someone sends
//     never count and never break the reading; a position in another pool of the same pair counts, and so does a position NFT the
//     record holds in any of its Token-2022 accounts (litesvm TQ05: harvest_pool_fees takes it there); a missing, broken or unheld
//     position, a pool that is not OnlyB, too many positions, more token accounts or NFTs than are read, a listing over 2 MB (never
//     read whole, never counted against the node), a malformed token row, a failed call, or a position of the pair given to the record
//     between the listing and the last answer withhold the estimate of what is still in the pool ALONE (200, every exact figure as it
//     is, never a partial figure)
//   * the route: dark without the settings, GET only, a bad mint, official coins only (404, kept a minute), one getMultipleAccounts
//     per reading on the curve on the one node whose genesis hash was checked, 503 on every unclear reading (a failure kept 15 s), the
//     minute at the edge and per server, the public limit; the payout opt-in; a rewards vault of another token is not read
//   * the founder card (public/lp-launch.js): where the fees go, earned, collected (or paid out, only when one was paid or agreed to),
//     the vault (always, before graduation and after, with or without a Collect button), what is still in the curve or the pool,
//     what Collect takes now (one set of numbers: the old line goes while the card shows), each with its account and the time; the
//     Collect button as before; nothing at all when the read fails, names another founder or cites an account that is not an
//     address; "can't be worked out right now" when the server withholds the pool estimate; "Still in the curve and the pool" after
//     graduation while the curve still holds the city's fees or its surplus; a word when collected is more than earned (a gift to
//     the vault left with a claim); nothing older than this tab's last Collect, by chain slot (the viewer's clock may be hours off),
//     kept across reloads of the tab by coin; nothing older than the status read just now: a lower Coin-record counter (earned, or
//     collected = claimed + paid out) than the status's, whatever the slot (a new tab or a reload after a Collect, also once a
//     harvest filled the vault past the old reading: the recheck's probe, graduated and on the curve), or more in the vault or the
//     curve than the status unless read at its slot or later; nothing at all, and nothing asked again, when the status's counters
//     did not read; nor the status's own line when it was read before the Collect; a Collect whose outcome the page cannot tell
//     takes the figures off as a landed one does and keeps the viewer's clock time of it in this tab for the coin page (so does one
//     that landed with no slot given), and within the coin page's 5 minutes after that moment a status that cannot tell an older
//     reading (its fee read failed) shows no reading of the coin in this tab either, after a reload or a page Back too (the recheck's
//     probes); with no Collect button nothing above 0 is called ready; a page Back brings back as the browser
//     kept it, after a Collect of the coin on a later page of the tab, takes its figures, the old line and the button off at once and
//     reads the chain again (not a page whose own Collect ended unclear); "the pools" when the city has positions in other pools of
//     the pair; the time words are drawn again when the tab is seen again (a day may have passed). (A status read before a Collect
//     that was still on its way shows what was true at that read: no page can know of a
//     Collect it was not told about.)
//   * the Worker side of that rule is in test/lplaunch.test.js (the status's counters from the same answer as its vault and curve)
//     and solana/tests-launchpad/21 (founderFees itself against the program after a claim, both Collects and a payout)
//   * the coin page's "Fees so far" (public/coin.js): moved to the city, still in the curve or the pool, the founder's part, the
//     holders' part (earned, the pot, and what was moved to the rewards vault: the record's counter, never the vault's balance, with a
//     word when it is more than was booked: a forward moves the whole pot, extra sent straight to it too), the
//     one sentence about holder reward rounds, each figure with its account and the time; hidden when the coin is not official, the
//     read fails, or for $VICINITY; never a reading older than this tab's last Collect of the coin (by chain slot), none for 5
//     minutes after a Collect in this tab whose outcome the dashboard could not tell (the viewer's clock against itself; a clock
//     moved back waits too; nothing kept from before it), nor an earlier or older answer over a newer one; Back to the page after a
//     Collect of the coin in this tab takes the reading from before it off at once (pageshow) and the next refresh asks again.
//     (Another tab knows nothing of this tab's Collect: there a reading can be up to two minutes old, and it says the time it was
//     read.)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { EDGE_SECONDS, FAIL_MS, MAX_NFTS, MAX_POSITIONS, MAX_TOKEN_BYTES, MAX_TOKEN_ROWS, READ_MS, _resetFeeStatus, creatorSurplusDue, feeStatus, maskWallet, splitFee, unclaimedFeeB } from "../src/feestatus.js";
import { _resetOfficialCoins } from "../src/officialcoins.js";
import { GENESIS, _resetLpKit } from "../src/lpkit.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _resetRpcHealth, rpcHealth, rpcPost } from "../src/rpcpool.js";
import { PUBLIC_LIMITS } from "../src/guards.js";
import { LAYOUT } from "../src/sol/layout.js";
import { decodeCoin, decodeDammPool } from "../src/sol/dbc.js";
import { PROGRAM_IDS, launchpad as launchpadPdas } from "../src/sol/pda.js";
import { damm, rewards as rewardsPdas } from "../src/sol/lpadmin-ix.js";
import { base58Decode, base58Encode } from "../src/solana.js";
import { advance, browser, newWorld, realClock, useClock } from "./helpers/world.js";
import { fakeCaches } from "./helpers/launchpad.js";
import { addr, lpChain } from "./helpers/lpchain.js";
import { dispatch, newEvent, openPage } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const FX = JSON.parse(read("test/fixtures/launchpad-worker/fee-status.json"));
const MINT = FX.coin.mint, FOUNDER = FX.coin.founder, RPC = "https://lp-rpc.test/devnet";
const reading = (name) => { const r = FX.readings.find((x) => x.name === name); assert.ok(r, name); return r; };
const errors = [];
const realError = console.error;
beforeEach(() => {
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit(); _resetLpCoins(); _resetRpcHealth();
  useClock("2026-10-20T12:00:00Z");
  errors.length = 0;
  console.error = (...a) => errors.push(a.map(String).join(" "));
});
after(() => { realClock(); console.error = realError; });

/** The settings of the litesvm World the fixture was recorded in (devnet ids of the SDK), with the fake chain's address as the RPC. */
const ON = () => ({ LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: FX.programId, LAUNCHPAD_REWARDS_PROGRAM_ID: FX.rewardsProgramId, LAUNCHPAD_DBC_CONFIGS: FX.dbcConfig, LAUNCHPAD_RPC_URL: RPC });
/** A fake chain holding exactly one reading's accounts (as the programs wrote them), behind the real API. */
function world(name = "graduated", { extra = {}, genesis = GENESIS.devnet } = {}) {
  const env = { ...newWorld(), ...ON(), ...extra };
  const chain = lpChain({ genesis });
  for (const k of Object.keys(chain.S.accounts)) delete chain.S.accounts[k]; // only this World's accounts
  for (const [k, a] of Object.entries(reading(name).accounts)) if (a) chain.S.accounts[k] = { owner: a.owner, lamports: a.lamports, data: a.data[0] };
  const b = browser(env, { ip: "203.0.113.9" });
  const get = async (path, { method = "GET", fetchImpl = chain.fetchImpl } = {}) => { const r = await b.send(path, { method, fetchImpl }); const text = await r.text(); return { status: r.status, headers: r.headers, text, data: text ? JSON.parse(text) : null }; };
  return { env, chain, S: chain.S, get, calls: (m) => chain.calls(m).length };
}
/** The answer the route should give for a reading: the status read next to litesvm, with this request's read time (and slot). */
const expected = (name, readAt = "2026-10-20T12:00:00.000Z", slot = 1) => { const s = reading(name).status; return { ok: true, ...s, source: { ...s.source, slot, readAt } }; };
/** An answer with the estimate of what is still in the pool withheld (src/feestatus.js THE ESTIMATE): every exact figure as it was. */
const withheldOf = (a) => ({
  ...a, city: { ...a.city, pendingInPool: null }, founder: { ...a.founder, pendingInPool: null }, holders: { ...a.holders, pendingInPool: null },
  pool: { ...a.pool, estimate: "unavailable", positions: null }, source: { ...a.source, accounts: { ...a.source.accounts, otherDammPools: null, positions: null } },
});
const PATH = `/api/fee-status?mint=${MINT}`;

/* ---------------------------------------------------------------- account bytes for the made-up cases */
/** A made-up address for each `i` (addr() of test/helpers/lpchain.js repeats after 256). */
const uniq = (i) => base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 255 : (j * 13 + 7) & 255)));
const b64 = (b) => Buffer.from(b).toString("base64");
const putKey = (b, at, a) => b.set(base58Decode(a), at);
const putUint = (b, at, v, bytes) => { for (let i = 0; i < bytes; i++) { b[at + i] = Number(v & 255n); v >>= 8n; } };
/** A Token-2022 account (170 bytes, initialized) of `mint` owned by `owner`. */
const tokenAcc = (mint, owner, amount = 1n) => { const b = new Uint8Array(170); putKey(b, 0, mint); putKey(b, 32, owner); putUint(b, 64, amount, 8); b[108] = 1; return b64(b); };
/** A DAMM v2 Position (408 bytes) in `pool` for `nftMint`, with `liquidity` (permanently locked), `pending` and the checkpoint. */
function positionAcc({ pool, nftMint, liquidity = 0n, pending = 0n, checkpoint = 0n }) {
  const L = LAYOUT.DammPosition, F = L.fields, b = new Uint8Array(L.size);
  b.set(L.discriminator, 0); putKey(b, F.pool.at, pool); putKey(b, F.nft_mint.at, nftMint);
  putUint(b, F.fee_b_per_token_checkpoint.at, checkpoint, 32); putUint(b, F.fee_b_pending.at, pending, 8); putUint(b, F.permanent_locked_liquidity.at, liquidity, 16);
  return { owner: PROGRAM_IDS.damm, data: b64(b) };
}
/** The coin's own DAMM v2 pool's bytes with other mints, fee mode or fee accumulator: another pool. */
function poolLike(base, { tokenA = null, tokenB = null, mode = null, feeBPerLiquidity = null } = {}) {
  const F = LAYOUT.DammPool.fields, b = Uint8Array.from(Buffer.from(base.data, "base64"));
  if (tokenA) putKey(b, F.token_a_mint.at, tokenA);
  if (tokenB) putKey(b, F.token_b_mint.at, tokenB);
  if (mode !== null) b[F.collect_fee_mode.at] = mode;
  if (feeBPerLiquidity !== null) putUint(b, F.fee_b_per_liquidity.at, feeBPerLiquidity, 32);
  return { owner: PROGRAM_IDS.damm, data: b64(b) };
}
/** Give the record a position NFT (at DAMM v2's own NFT-account address) and its Position: returns the addresses. */
async function givePosition(S, coin, nftMint, pos) {
  const [nftAccount, position] = [await damm.positionNftAccount(nftMint), await damm.position(nftMint)];
  S.accounts[nftAccount] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(nftMint, coin) };
  if (pos) S.accounts[position] = positionAcc({ nftMint, ...pos });
  return { nftAccount, position };
}

/* ---------------------------------------------------------------- the facts */

test("facts: DAMM v2's Pool and Position and our PayoutOptIn offsets come from the IDLs; update_fee as DAMM v2 does it; DBC's creator surplus; the split", () => {
  assert.deepEqual([LAYOUT.DammPool.size, LAYOUT.DammPosition.size], [1112, 408], "8 + 1104 and 8 + 400 (DAMM v2 0.2.5's const_assert_eq!)");
  assert.deepEqual(Object.fromEntries(Object.entries(LAYOUT.DammPool.fields).map(([k, f]) => [k, f.at])), { token_a_mint: 168, token_b_mint: 200, liquidity: 360, collect_fee_mode: 484, fee_a_per_liquidity: 488, fee_b_per_liquidity: 520 });
  assert.deepEqual(Object.fromEntries(Object.entries(LAYOUT.DammPosition.fields).map(([k, f]) => [k, f.at])), { pool: 8, nft_mint: 40, fee_b_per_token_checkpoint: 104, fee_b_pending: 144, unlocked_liquidity: 152, vested_liquidity: 168, permanent_locked_liquidity: 184 });
  assert.deepEqual([LAYOUT.PayoutOptIn.size, LAYOUT.PayoutOptIn.fields.coin.at, LAYOUT.PayoutOptIn.fields.founder.at], [145, 8, 40], "state.rs PayoutOptIn: 8 + 32 + 32 + 32 + 32 + 8 + 1");
  assert.equal(LAYOUT.VirtualPool.fields.is_creator_withdraw_surplus.at, 310);
  const pos = (o) => ({ feeBPending: 0n, feeBPerTokenCheckpoint: 0n, unlockedLiquidity: 0n, vestedLiquidity: 0n, permanentLockedLiquidity: 0n, ...o });
  // (fee per liquidity - checkpoint) x every liquidity >> 128, plus what was pending
  assert.equal(unclaimedFeeB({ feeBPerLiquidity: 5n << 128n }, pos({ feeBPerTokenCheckpoint: 2n << 128n, unlockedLiquidity: 1n, vestedLiquidity: 2n, permanentLockedLiquidity: 7n, feeBPending: 4n })), 34n);
  // the U256 difference wraps (the pool's accumulator went past 2^256)
  assert.equal(unclaimedFeeB({ feeBPerLiquidity: 1n << 128n }, pos({ feeBPerTokenCheckpoint: (1n << 256n) - (1n << 128n), permanentLockedLiquidity: 3n })), 6n);
  // no liquidity: only what was pending; past 2^64 - 1: capped, as DAMM v2 caps it
  assert.equal(unclaimedFeeB({ feeBPerLiquidity: 9n << 128n }, pos({ feeBPending: 11n })), 11n);
  assert.equal(unclaimedFeeB({ feeBPerLiquidity: 1n << 200n }, pos({ permanentLockedLiquidity: 1n << 100n, feeBPending: 5n })), (1n << 64n) - 1n);
  // DBC's creator surplus: floor(floor((reserve - target) x 80 / 100) x creator% / 100), once the curve is full and until it is taken
  const cfg = { migrationQuoteThreshold: 1000n, creatorTradingFeePercentage: 50n };
  assert.equal(creatorSurplusDue({ quoteReserve: 1013n, isCreatorWithdrawSurplus: 0 }, cfg), 5n, "13 -> 10 for partner and creator -> 5 for the creator");
  assert.equal(creatorSurplusDue({ quoteReserve: 2000n, isCreatorWithdrawSurplus: 0 }, cfg), 400n);
  assert.equal(creatorSurplusDue({ quoteReserve: 999n, isCreatorWithdrawSurplus: 0 }, cfg), 0n, "the curve is not full");
  assert.equal(creatorSurplusDue({ quoteReserve: 2000n, isCreatorWithdrawSurplus: 1 }, cfg), 0n, "already taken");
  assert.equal(creatorSurplusDue({ quoteReserve: 2000n, isCreatorWithdrawSurplus: 0 }, { ...cfg, creatorTradingFeePercentage: 0n }), 0n);
  // math.rs split_fee: the founder floor(c / 2), the holders the rest
  assert.deepEqual(splitFee(7n), [4n, 3n]);
  assert.deepEqual(splitFee(0n), [0n, 0n]);
  assert.equal(maskWallet(FOUNDER), `${FOUNDER.slice(0, 5)}*****${FOUNDER.slice(-3)}`);
  assert.deepEqual([READ_MS, FAIL_MS, EDGE_SECONDS, MAX_POSITIONS, MAX_TOKEN_ROWS, MAX_NFTS], [60_000, 15_000, 60, 30, 1000, 200]);
  assert.ok(8 + 1 + MAX_POSITIONS * 3 <= 100, "the last answer of a graduated coin fits one getMultipleAccounts");
  assert.deepEqual(PUBLIC_LIMITS.fee_status, { max: 60, windowMs: 60_000 });
});

/* ---------------------------------------------------------------- the replay of the real programs' bytes */

test("replay: every reading the real programs left (launch to the pool harvest) gives the same answer here as next to litesvm, and the counters are the Coin record's bytes", async () => {
  assert.ok(FX.readings.length >= 15);
  for (const r of FX.readings) {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit(); _resetLpCoins();
    const w = world(r.name);
    const got = await w.get(PATH);
    assert.equal(got.status, 200, `${r.name}: ${got.text}`);
    assert.deepEqual(got.data, expected(r.name), r.name);
    // the record's own bytes, decoded here: the counters the answer names
    const c = decodeCoin(r.accounts[r.status.coin.address], FX.programId);
    assert.deepEqual([got.data.founder.earned, got.data.founder.claimed, got.data.founder.paidOut, got.data.holders.earned, got.data.holders.forwarded],
      [c.founderAccrued, c.founderClaimed, c.founderPaidOut, c.holdersAccrued, c.holdersForwarded].map(String), r.name);
    assert.equal(got.data.city.harvested, String(c.founderAccrued + c.holdersAccrued));
    assert.equal(got.data.founder.wallet, maskWallet(FOUNDER), "the founder wallet, masked as the site's public answers mask it");
    assert.ok(!got.text.includes(FOUNDER), "never the whole founder wallet");
    assert.equal(got.data.founder.payoutAgreed, false);
    assert.equal(got.data.pool.estimate, "whole", `${r.name}: every position was read`);
    assert.equal(got.data.source.accounts.payoutOptIn, await launchpadPdas(FX.programId).payoutOptIn(got.data.coin.address), "the opt-in's address, read either way");
  }
  // what the story shows: a gift to the vault is collected but never earned; forwarded moves the pot to the rewards vault
  const claimed = expected("claimed"), fwd = expected("forwarded"), grad = expected("graduated"), done = expected("pool harvested");
  assert.equal(BigInt(claimed.founder.collected) - BigInt(claimed.founder.earned), 7000n);
  assert.deepEqual([fwd.holders.pot, fwd.holders.forwarded, fwd.holders.vault.balance, fwd.holders.vault.holdersOnly], ["0", reading("rewards set up").status.holders.pot, reading("rewards set up").status.holders.pot, true]);
  assert.equal(expected("launched").holders.vault, null, "no rewards config yet: no vault");
  // the founder's Collect (harvest + claim) took the vault and the founder's part still in the curve
  const before = expected("curve again"), after_ = expected("collected");
  assert.equal(BigInt(after_.founder.claimed) - BigInt(before.founder.claimed), BigInt(before.founder.claimable) + BigInt(before.founder.pendingInPool));
  // the full curve, before any harvest: the surplus is counted, the sum split once; the curve harvest booked exactly that
  const full = expected("completed"), moved = expected("graduated, curve not harvested");
  assert.ok(BigInt(full.pool.surplus) > 0n);
  assert.equal(full.city.pendingInPool, String(BigInt(full.pool.curve) + BigInt(full.pool.surplus)));
  assert.equal(full.founder.pendingInPool, String((BigInt(full.pool.curve) + BigInt(full.pool.surplus)) / 2n));
  assert.deepEqual([moved.pool.curve, moved.pool.surplus, moved.founder.pendingInPool], [full.pool.curve, full.pool.surplus, full.founder.pendingInPool]);
  assert.equal(BigInt(grad.founder.earned) - BigInt(moved.founder.earned), BigInt(full.founder.pendingInPool), "the curve harvest booked the founder's part the status showed, surplus included");
  assert.deepEqual([grad.coin.graduated, grad.pool.positions.length, grad.source.accounts.positions.length, grad.source.accounts.otherDammPools], [true, 1, 1, []]);
  const pending = BigInt(grad.pool.positions[0].pending);
  assert.ok(pending > 0n);
  assert.equal(BigInt(grad.founder.pendingInPool), splitFee(BigInt(grad.pool.curve) + BigInt(grad.pool.surplus))[1] + splitFee(pending)[1]);
  assert.equal(BigInt(done.founder.earned) - BigInt(grad.founder.earned), splitFee(pending)[1], "the pool harvest booked exactly the founder half of the figure");
  // a position NFT given to the record in its own associated account (not DAMM v2's NFT-account address) counts (litesvm TQ05), and
  // the two pool harvests then booked exactly the founder's part the status showed
  const given = expected("position given"), both = expected("given position harvested");
  const canonical = await Promise.all(given.pool.positions.map((p) => damm.positionNftAccount(p.nftMint)));
  assert.deepEqual(given.pool.positions.map((p, i) => p.nftAccount === canonical[i]).sort(), [false, true], "one at DAMM v2's own address, one in another account of the record");
  assert.ok(given.pool.positions.every((p) => BigInt(p.pending) > 0n));
  assert.equal(BigInt(both.founder.earned) - BigInt(given.founder.earned), BigInt(given.founder.pendingInPool));
  assert.equal(BigInt(both.city.harvested) - BigInt(given.city.harvested), BigInt(given.city.pendingInPool));
});

test("replay: one getMultipleAccounts for a coin on its curve; after graduation one getTokenAccountsByOwner, the positions, one last getMultipleAccounts, then the listing again at that answer's slot or later; every call on the one node whose genesis hash was asked for this reading", async () => {
  const w = world("traded");
  assert.equal((await w.get(PATH)).status, 200);
  // the official list (the records, then their pools), then the fee reading: the genesis hash again, one getMultipleAccounts
  assert.deepEqual(w.S.log.map((l) => l.method), ["getGenesisHash", "getProgramAccounts", "getMultipleAccounts", "getGenesisHash", "getMultipleAccounts"]);
  const fee = w.chain.calls("getMultipleAccounts")[1];
  const A = expected("traded").source.accounts, R = rewardsPdas(FX.rewardsProgramId), city = await R.city(MINT);
  assert.deepEqual(fee.params[0], [A.coin, A.founderVault, A.holdersPot, A.dbcPool, A.dbcConfig, await launchpadPdas(FX.programId).payoutOptIn(A.coin), city, await R.vault(city)],
    "the record, the founder vault, the holders pot, the curve and its config, the payout opt-in, the rewards config and its vault");
  assert.ok(w.S.log.every((l) => l.url === RPC));
  const g = world("graduated");
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  // the chain moves on by a slot at every call, so each answer has its own slot
  const ticking = async (url, init) => { const res = await g.chain.fetchImpl(url, init); g.S.slot += 1; return res; };
  assert.equal((await g.get(PATH, { fetchImpl: ticking })).status, 200);
  assert.deepEqual(g.S.log.map((l) => l.method), ["getGenesisHash", "getProgramAccounts", "getMultipleAccounts", "getGenesisHash", "getMultipleAccounts", "getTokenAccountsByOwner", "getMultipleAccounts", "getMultipleAccounts", "getTokenAccountsByOwner"]);
  const [, first, positions, last] = g.chain.calls("getMultipleAccounts");
  const [list1, list2] = g.chain.calls("getTokenAccountsByOwner");
  const slotOf = (call) => g.S.log.indexOf(call) + 1; // the slot each call was answered at (1, then one more per call)
  assert.equal(list1.params[2].minContextSlot, slotOf(first), "the listing at the first answer's slot or later");
  assert.equal(list2.params[0], expected("graduated").coin.address);
  assert.equal(list2.params[2].minContextSlot, slotOf(last), "the listing again at the last answer's slot or later: no position came in between");
  const G = expected("graduated").source.accounts;
  assert.deepEqual(positions.params[0], G.positions, "the Position of each NFT the record holds");
  assert.deepEqual(last.params[0].slice(0, 8), first.params[0], "the last answer reads everything again, then the pool, the position and its NFT account");
  assert.deepEqual(last.params[0].slice(8, 10), [G.dammPool, G.positions[0]]);
  assert.equal(last.params[0].length, 11);
  assert.equal(g.chain.calls("getTokenAccountsByOwner")[0].params[0], expected("graduated").coin.address);
});

/* ---------------------------------------------------------------- graduated coins: what counts and what fails */

test("graduated: a stranger's token, empty positions anyone can make for the record and positions in a pool of another pair never count and never break the reading", async () => {
  const coin = expected("graduated").coin.address, dammPool = expected("graduated").pool.damm;
  // a stranger's Token-2022 token (amount 1) in an ordinary account of the record: not at DAMM v2's position_nft_account address
  const w = world("graduated");
  w.S.accounts[addr(78)] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(addr(77), coin) };
  // 41 empty positions in the coin's own pool (create_position needs no signature from its owner): about 0.4 SOL of rent for nothing
  for (let i = 0; i < 41; i++) await givePosition(w.S, coin, uniq(1000 + i), { pool: dammPool });
  let r = await w.get(PATH);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data, expected("graduated"), "the same figures: empty positions can never earn");
  // 41 positions that hold liquidity, in a pool of another pair (harvest_pool_fees would refuse them: not the city's)
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  const o = world("graduated");
  const other = uniq(2000);
  o.S.accounts[other] = poolLike(o.S.accounts[dammPool], { tokenA: uniq(2001), feeBPerLiquidity: 7n << 128n });
  for (let i = 0; i < 41; i++) await givePosition(o.S, coin, uniq(1100 + i), { pool: other, liquidity: 1000n, pending: 3n });
  r = await o.get(PATH);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data, expected("graduated"), "positions in a pool of another pair are not the city's");
  assert.equal(o.chain.calls("getMultipleAccounts").at(-1).params[0].length, 11, "the last answer reads only the city's position");
});

test("graduated: a position someone gives the record in another pool of the same pair counts (harvest_pool_fees pays it to the city), with that pool's own figures", async () => {
  const G = expected("graduated"), coin = G.coin.address;
  const w = world("graduated");
  const other = uniq(3000);
  w.S.accounts[other] = poolLike(w.S.accounts[G.pool.damm], { feeBPerLiquidity: 5n << 128n });
  const { position, nftAccount } = await givePosition(w.S, coin, uniq(3001), { pool: other, liquidity: 4n, pending: 9n, checkpoint: 2n << 128n });
  const r = await w.get(PATH);
  assert.equal(r.status, 200, r.text);
  const extra = 9n + 4n * 3n; // pending + (5 - 2) x 4
  assert.equal(r.data.city.pendingInPool, String(BigInt(G.city.pendingInPool) + extra));
  assert.equal(r.data.founder.pendingInPool, String(BigInt(G.founder.pendingInPool) + splitFee(extra)[1]));
  assert.equal(r.data.holders.pendingInPool, String(BigInt(G.holders.pendingInPool) + splitFee(extra)[0]));
  assert.deepEqual(r.data.source.accounts.otherDammPools, [other]);
  assert.deepEqual(r.data.pool.positions.find((p) => p.position === position), { position, nftMint: uniq(3001), nftAccount, pool: other, pending: String(extra) });
  assert.equal(r.data.pool.positions.length, 2);
});

test("graduated: a position NFT the record holds in ANY of its Token-2022 accounts counts (position NFTs move like any token, and harvest_pool_fees takes any account of the record holding 1); a frozen account or another amount does not, as harvest_pool_fees would refuse it", async () => {
  const G = expected("graduated"), coin = G.coin.address;
  const nft = uniq(6001), acct = uniq(6002);
  const each = unclaimedFeeB(decodeDammPool(reading("graduated").accounts[G.pool.damm]), { feeBPending: 9n, feeBPerTokenCheckpoint: 0n, unlockedLiquidity: 0n, vestedLiquidity: 0n, permanentLockedLiquidity: 4n });
  const at = async (edit = null) => {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
    const w = world("graduated");
    const { position, nftAccount } = await givePosition(w.S, coin, nft, { pool: G.pool.damm, liquidity: 4n, pending: 9n });
    delete w.S.accounts[nftAccount]; // not at DAMM v2's address: in another account of the record
    const raw = Buffer.from(tokenAcc(nft, coin), "base64");
    if (edit) edit(raw);
    w.S.accounts[acct] = { owner: PROGRAM_IDS.token2022, data: raw.toString("base64") };
    const r = await w.get(PATH);
    assert.equal(r.status, 200, r.text);
    return { r, w, position };
  };
  const { r, w, position } = await at();
  assert.equal(r.data.pool.estimate, "whole");
  assert.deepEqual(r.data.pool.positions.find((p) => p.position === position), { position, nftMint: nft, nftAccount: acct, pool: G.pool.damm, pending: String(each) });
  assert.equal(r.data.city.pendingInPool, String(BigInt(G.city.pendingInPool) + each));
  assert.equal(r.data.founder.pendingInPool, String(BigInt(G.founder.pendingInPool) + splitFee(each)[1]));
  assert.deepEqual(r.data.source.accounts.positions, [...G.source.accounts.positions, position].sort());
  assert.ok(w.chain.calls("getMultipleAccounts").at(-1).params[0].includes(acct), "the last answer reads that account again (still the record's, still 1)");
  // frozen, or holding 0 or 2: harvest_pool_fees refuses such an account (math.rs read_token_account_base), so it is not counted
  for (const edit of [(b) => { b[108] = 2; }, (b) => { b[64] = 0; }, (b) => { b[64] = 2; }]) assert.deepEqual((await at(edit)).r.data, G);
});

test("graduated: whatever keeps the positions from being read completely withholds the estimate of what is still in the pool ALONE (200, pool.estimate unavailable, every exact figure as it is): never a partial figure shown as whole, and no stranger's spam switches the rest off", async () => {
  const G = expected("graduated"), A = G.source.accounts, coin = G.coin.address;
  const nftAccount = await damm.positionNftAccount(G.pool.positions[0].nftMint);
  const W = withheldOf(G);
  const withheld = async (why, mutate, { fetchWrap } = {}) => {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit(); _resetLpCoins(); _resetRpcHealth();
    errors.length = 0;
    const w = world("graduated");
    await mutate(w);
    const r = await w.get(PATH, { fetchImpl: fetchWrap ? fetchWrap(w.chain.fetchImpl) : w.chain.fetchImpl });
    assert.equal(r.status, 200, `${why}: ${r.text}`);
    assert.deepEqual(r.data, W, why);
    assert.ok(errors.some((e) => e.includes("pool estimate withheld") && (!why || e.includes(why))), `${why}: ${errors.join("\n")}`);
    return w;
  };
  await withheld("damm_position_unread", (w) => { w.S.accounts[A.positions[0]].data = Buffer.alloc(408).toString("base64"); }); // DAMM v2's, not a Position
  await withheld("damm_position_missing", (w) => { delete w.S.accounts[A.positions[0]]; }); // no Position for the NFT: none in the coin's own pool
  await withheld("damm_position_missing", (w) => { w.S.accounts[nftAccount].data = tokenAcc(G.pool.positions[0].nftMint, coin, 0n); });
  await withheld("damm_position_missing", (w) => { delete w.S.accounts[nftAccount]; }); // every graduated coin's record holds one
  await withheld("damm_fee_mode", (w) => { w.S.accounts[A.dammPool] = poolLike(w.S.accounts[A.dammPool], { mode: 0 }); });
  await withheld("damm_pool_unread", (w) => { delete w.S.accounts[A.dammPool]; });
  // a position's mint held twice (it has a supply of 1): that answer cannot be true. (A mint with no Position held twice is just
  // someone's tokens: not counted, nothing unclear.)
  await withheld("damm_position_unread", (w) => { w.S.accounts[uniq(7000)] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(G.pool.positions[0].nftMint, coin) }; });
  // more than MAX_POSITIONS positions that hold something (each one real liquidity someone gave away for good)
  await withheld("too_many_positions", async (w) => { for (let i = 0; i < MAX_POSITIONS; i++) await givePosition(w.S, coin, uniq(4000 + i), { pool: A.dammPool, liquidity: 1n }); });
  // more Token-2022 accounts of the record than MAX_TOKEN_ROWS, or more mints it holds 1 of than MAX_NFTS: anyone can send those
  await withheld("too_many_token_accounts", (w) => { for (let i = 0; i <= MAX_TOKEN_ROWS; i++) w.S.accounts[uniq(10_000 + i)] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(addr(77), coin, 0n) }; });
  await withheld("too_many_nfts", (w) => { for (let i = 0; i < MAX_NFTS; i++) w.S.accounts[uniq(20_000 + i)] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(uniq(30_000 + i), coin) }; });
  // a getTokenAccountsByOwner row that is not a whole Token-2022 account of the record is a malformed answer, never skipped
  const rows = (edit) => (inner) => async (url, init) => {
    const res = await inner(url, init);
    if (JSON.parse(init.body).method !== "getTokenAccountsByOwner") return res;
    const j = await res.json(); edit(j.result.value); return new Response(JSON.stringify(j));
  };
  const row = (data, owner = PROGRAM_IDS.token2022) => (v) => v.push({ pubkey: uniq(8000), account: { owner, lamports: 2039280, data: [data, "base64"], executable: false, rentEpoch: 0, space: Buffer.from(data, "base64").length } });
  await withheld("token_row_unread", () => {}, { fetchWrap: rows(row(tokenAcc(addr(77), coin), PROGRAM_IDS.token)) }); // another program's account
  await withheld("token_row_unread", () => {}, { fetchWrap: rows(row(Buffer.from(tokenAcc(addr(77), coin), "base64").subarray(0, 164).toString("base64"))) }); // under 165 bytes
  await withheld("token_row_unread", () => {}, { fetchWrap: rows(row(tokenAcc(addr(77), addr(79)))) }); // someone else's account
  await withheld("token_row_unread", () => {}, { fetchWrap: rows(row((() => { const b = Buffer.from(tokenAcc(addr(77), coin), "base64"); b[108] = 0; return b.toString("base64"); })())) }); // not initialized
  await withheld("rpc_bad_answer", () => {}, { fetchWrap: rows((v) => v.push({ pubkey: "x", account: null })) });
  // the node fails the positions' call: the exact figures of the first answer stand
  await withheld(null, () => {}, { fetchWrap: (inner) => async (url, init) => (JSON.parse(init.body).method === "getTokenAccountsByOwner" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32010, message: "excluded from account secondary indexes" } })) : inner(url, init)) });
  // exactly MAX_POSITIONS: read, every one counted
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  const w = world("graduated");
  for (let i = 0; i < MAX_POSITIONS - 1; i++) await givePosition(w.S, coin, uniq(5000 + i), { pool: A.dammPool, liquidity: 1n, pending: 2n });
  const r = await w.get(PATH);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.pool.estimate, "whole");
  assert.equal(r.data.pool.positions.length, MAX_POSITIONS);
  const each = unclaimedFeeB(decodeDammPool(reading("graduated").accounts[A.dammPool]), { feeBPending: 2n, feeBPerTokenCheckpoint: 0n, unlockedLiquidity: 0n, vestedLiquidity: 0n, permanentLockedLiquidity: 1n });
  assert.equal(r.data.city.pendingInPool, String(BigInt(G.city.pendingInPool) + BigInt(MAX_POSITIONS - 1) * each));
  // and exactly MAX_NFTS mints the record holds 1 of (none of them a position): read, nothing withheld
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  const n = world("graduated");
  for (let i = 0; i < MAX_NFTS - 1; i++) n.S.accounts[uniq(20_000 + i)] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(uniq(30_000 + i), coin) };
  const k = await n.get(PATH);
  assert.deepEqual([k.status, k.data], [200, G]);
});

test("graduated: a position of this pair given to the record between the listing and the last answer withholds the estimate alone (positions_changed; the next reading counts it); a stranger's token, an empty position or one in a pool of another pair given then changes nothing", async () => {
  const G = expected("graduated"), coin = G.coin.address, dammPool = G.pool.damm;
  // `give(S)` changes the chain right after the reading's first getTokenAccountsByOwner: between the listing and the last answer
  const during = async (give) => {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit(); _resetLpCoins(); _resetRpcHealth();
    errors.length = 0;
    const w = world("graduated");
    let given = false;
    const fetchImpl = async (url, init) => {
      const res = await w.chain.fetchImpl(url, init);
      if (!given && JSON.parse(init.body).method === "getTokenAccountsByOwner") { given = true; await give(w.S); }
      return res;
    };
    const r = await w.get(PATH, { fetchImpl });
    assert.equal(r.status, 200, r.text);
    return { r, w };
  };
  // a position that holds something, in the coin's own pool: the reading would have missed it
  const { r, w } = await during((S) => givePosition(S, coin, uniq(9001), { pool: dammPool, liquidity: 4n, pending: 9n }));
  assert.deepEqual(r.data, withheldOf(G), "never the figure without it, shown as whole");
  assert.ok(errors.some((e) => e.includes("pool estimate withheld") && e.includes("positions_changed")), errors.join("\n"));
  assert.equal(w.chain.calls("getTokenAccountsByOwner").length, 2);
  // the next reading counts it (positions never leave)
  const next = await feeStatus(w.env, MINT, w.chain.fetchImpl, Date.now() + READ_MS);
  assert.equal(next.pool.estimate, "whole");
  assert.equal(next.pool.positions.length, 2);
  // in another pool of the same pair: the same
  const same = await during((S) => { const other = uniq(9100); S.accounts[other] = poolLike(S.accounts[dammPool], { feeBPerLiquidity: 5n << 128n }); return givePosition(S, coin, uniq(9101), { pool: other, liquidity: 4n }); });
  assert.deepEqual(same.r.data, withheldOf(G));
  // what changes nothing: someone's token, an empty position anyone can make, a position in a pool of another pair
  for (const [why, give] of [
    ["a token", (S) => { S.accounts[uniq(9200)] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(uniq(9201), coin) }; }],
    ["an empty position", (S) => givePosition(S, coin, uniq(9300), { pool: dammPool })],
    ["another pair", (S) => { const other = uniq(9400); S.accounts[other] = poolLike(S.accounts[dammPool], { tokenA: uniq(9401), feeBPerLiquidity: 7n << 128n }); return givePosition(S, coin, uniq(9402), { pool: other, liquidity: 1000n, pending: 3n }); }],
  ]) assert.deepEqual((await during(give)).r.data, G, why);
});

test("graduated: a getTokenAccountsByOwner answer longer than MAX_TOKEN_BYTES is never read whole (its said length, or counted as it comes): the estimate alone is withheld, the node is not counted as failing and no other node is asked", async () => {
  const G = expected("graduated");
  const enc = new TextEncoder(), chunk = enc.encode(" ".repeat(65_536));
  for (const said of [true, false]) {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit(); _resetLpCoins(); _resetRpcHealth();
    errors.length = 0;
    const w = world("graduated");
    let pulled = 0;
    const fetchImpl = async (url, init) => {
      if (JSON.parse(init.body).method !== "getTokenAccountsByOwner") return w.chain.fetchImpl(url, init);
      // tens of thousands of token accounts someone made for the record: an answer of 8 MB (cut short here: it is never read whole)
      const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":[')); }, pull(c) { if (pulled >= 8_000_000) { c.close(); return; } pulled += chunk.length; c.enqueue(chunk); } });
      return new Response(body, { headers: said ? { "content-length": "60000000" } : {} });
    };
    const r = await w.get(PATH, { fetchImpl });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data, withheldOf(G), `said=${said}`);
    assert.ok(errors.some((e) => e.includes("pool estimate withheld") && e.includes("too_many_token_accounts")), errors.join("\n"));
    assert.ok(pulled <= MAX_TOKEN_BYTES + 3 * chunk.length, `read ${pulled} bytes, never the whole answer`);
    if (said) assert.ok(pulled <= 3 * chunk.length, "a said length over the limit is not read at all");
    assert.deepEqual(rpcHealth(), {}, "nothing counted against the node");
  }
  // the pool itself: an answer over the caller's limit throws rpc_too_large from the first node, with no failover; under it, read
  _resetRpcHealth();
  const env = { SOLANA_RPC_URL: "https://first.example/rpc", SOLANA_RPC_URL_BACKUP: "https://backup.example/rpc" };
  const asked = [];
  const big = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(5000) })); };
  await assert.rejects(rpcPost(env, { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }, big, { cluster: "mainnet", maxBytes: 4096 }), /rpc_too_large/);
  assert.deepEqual([asked, rpcHealth()], [["https://first.example/rpc"], {}]);
  const ok = await rpcPost(env, { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }, big, { cluster: "mainnet", maxBytes: 8192 });
  assert.equal(ok.data.result.length, 5000);
});

/* ---------------------------------------------------------------- the route */

test("route: dark without the settings (404 before anything is read); GET only; a bad mint is 400; an address that is not an official city coin is 404 not_official, kept a minute", async () => {
  const dark = browser(newWorld());
  const lp = lpChain();
  const d = await dark.send(PATH, { fetchImpl: lp.fetchImpl });
  assert.deepEqual([d.status, await d.json()], [404, { ok: false, error: "not_enabled" }]);
  assert.equal(lp.S.log.length, 0, "no chain call while dark");
  const w = world("traded");
  assert.equal((await w.get(PATH, { method: "POST" })).status, 405);
  assert.deepEqual((await w.get("/api/fee-status?mint=nope")).data, { ok: false, error: "bad_mint" });
  assert.equal((await w.get("/api/fee-status")).status, 400);
  assert.equal(w.S.log.length, 0);
  // the platform token, a pool, any address: not a city coin whose Coin record names it
  for (const other of [FX.dbcConfig, expected("traded").coin.dbcPool, addr(5)]) {
    const r = await w.get(`/api/fee-status?mint=${other}`);
    assert.deepEqual([r.status, r.data, r.headers.get("cache-control")], [404, { ok: false, error: "not_official" }, "public, max-age=60"], other);
  }
  // settings with no price curve set: no official list can be checked, so no fee status either (503, never a guess)
  _resetFeeStatus(); _resetOfficialCoins();
  const unset = world("traded", { extra: { LAUNCHPAD_DBC_CONFIGS: "" } });
  assert.deepEqual([(await unset.get(PATH)).status, (await unset.get(PATH)).data], [503, { ok: false, error: "config_not_set" }]);
});

test("route: every unclear reading of the exact figures is 503 with no figure at all (another network, the node down, a vault or a pot that is not the record's, a curve config that does not decode, a broken opt-in, a rewards config without its vault, a short or broken answer, a node behind the last reading)", async () => {
  const fail = async (name, mutate, { genesis, fetchWrap } = {}) => {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit(); _resetLpCoins(); _resetRpcHealth();
    const w = world(name, { genesis });
    await mutate(w);
    const r = await w.get(PATH, { fetchImpl: fetchWrap ? fetchWrap(w.chain.fetchImpl) : w.chain.fetchImpl });
    assert.equal(r.status, 503, `${name}: ${r.text}`);
    assert.deepEqual(Object.keys(r.data).sort(), ["error", "ok"], "no figure at all");
    assert.equal(r.data.ok, false);
    assert.deepEqual([r.headers.get("cache-control"), r.headers.get("retry-after")], ["no-store", "60"]);
    return w;
  };
  const S = (name) => reading(name).status.source.accounts;
  const optIn = await launchpadPdas(FX.programId).payoutOptIn(S("traded").coin);
  await fail("traded", () => {}, { genesis: GENESIS.mainnet });
  await fail("traded", (w) => { w.S.down = true; });
  await fail("traded", (w) => { delete w.S.accounts[S("traded").founderVault]; });
  await fail("traded", (w) => { const a = w.S.accounts[S("traded").holdersPot]; const b = Buffer.from(a.data, "base64"); b.set(base58Decode(addr(9)), 0); a.data = b.toString("base64"); }); // a pot of another token
  await fail("traded", (w) => { w.S.accounts[S("traded").founderVault].owner = PROGRAM_IDS.token2022; }); // not an SPL Token account
  await fail("completed", (w) => { w.S.accounts[S("completed").dbcConfig].data = Buffer.alloc(1048).toString("base64"); }); // the surplus could not be worked out
  await fail("traded", (w) => { w.S.accounts[optIn] = { owner: FX.programId, data: Buffer.alloc(145).toString("base64") }; }); // an opt-in that does not decode
  await fail("forwarded", (w) => { delete w.S.accounts[reading("forwarded").status.holders.vault.address]; }); // a rewards config without its vault
  await fail("forwarded", (w) => { w.S.accounts[S("forwarded").rewardsConfig].data = Buffer.alloc(300).toString("base64"); }); // not a CityConfig
  // SOL someone sent to the rewards config's or the opt-in's address: "not set up yet", never an unclear reading
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  const gift = world("harvested");
  gift.S.accounts[S("forwarded").rewardsConfig] = { owner: PROGRAM_IDS.system, lamports: 5000, data: "" };
  gift.S.accounts[optIn] = { owner: PROGRAM_IDS.system, lamports: 5000, data: "" };
  const g = await gift.get(PATH);
  assert.deepEqual([g.status, g.data.holders.vault, g.data.source.accounts.rewardsConfig, g.data.founder.payoutAgreed, g.data.source.accounts.payoutOptIn], [200, null, null, false, optIn]);
  // a short answer, and an entry that is not a whole account
  const tamper = (edit) => (inner) => async (url, init) => {
    const res = await inner(url, init);
    const body = JSON.parse(init.body);
    if (body.method !== "getMultipleAccounts" || body.params[0].length !== 8) return res;
    const j = await res.json(); edit(j.result); return new Response(JSON.stringify(j));
  };
  await fail("traded", () => {}, { fetchWrap: tamper((r) => r.value.pop()) });
  await fail("traded", () => {}, { fetchWrap: tamper((r) => { r.value[1] = { owner: PROGRAM_IDS.token }; }) });
  // a node that has not reached the slot of this server's last whole reading of the coin refuses: 503, never older counters
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  const w = world("traded");
  w.S.slot = 500;
  assert.equal((await w.get(PATH)).status, 200);
  advance(READ_MS);
  _resetOfficialCoins();
  w.S.slot = 400;
  const behind = await w.get(PATH);
  assert.equal(behind.status, 503);
  assert.ok(w.chain.calls("getMultipleAccounts").some((c) => c.params[1].minContextSlot === 500));
  // the failure is kept FAIL_MS (the node is not asked again meanwhile), then the next request reads again
  w.S.slot = 600;
  const n = w.S.log.length;
  assert.equal((await w.get(PATH)).status, 503);
  assert.equal(w.S.log.length, n, "within FAIL_MS: the failure, no chain call");
  advance(FAIL_MS);
  const back = await w.get(PATH);
  assert.equal(back.status, 200);
  assert.equal(back.data.source.slot, 600);
  assert.ok(errors.length > 0 && errors.every((e) => !e.includes(FOUNDER)), "logged with codes only");
});

test("route: the payout opt-in: absent, only this wallet can take the vault; present and signed by the record's founder, payouts it agreed to can too; signed by an earlier founder, no payout can run", async () => {
  const A = reading("harvested").status.source.accounts;
  const optIn = await launchpadPdas(FX.programId).payoutOptIn(A.coin);
  const optInAcc = (founder, coin = A.coin) => {
    const L = LAYOUT.PayoutOptIn, b = new Uint8Array(L.size);
    b.set(L.discriminator, 0); putKey(b, L.fields.coin.at, coin); putKey(b, L.fields.founder.at, founder); putKey(b, L.fields.agreed_destination.at, addr(66));
    return { owner: FX.programId, data: b64(b) };
  };
  for (const [founder, agreed] of [[FOUNDER, true], [addr(12), false]]) {
    _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
    const w = world("harvested");
    w.S.accounts[optIn] = optInAcc(founder);
    const r = await w.get(PATH);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.data.founder.payoutAgreed, r.data.source.accounts.payoutOptIn], [agreed, optIn]);
    assert.deepEqual({ ...r.data, founder: { ...r.data.founder, payoutAgreed: false } }, expected("harvested"), "every figure as before");
  }
  // an opt-in of another coin at this address cannot be: unclear
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  const bad = world("harvested");
  bad.S.accounts[optIn] = optInAcc(FOUNDER, addr(13));
  assert.equal((await bad.get(PATH)).status, 503);
});

test("route: a rewards vault of a token that is not the coin's quote token (Token-2022 too) is never read, so it never makes the reading unclear", async () => {
  const F = reading("forwarded").status;
  const w = world("forwarded");
  const cfg = w.S.accounts[F.source.accounts.rewardsConfig], b = Buffer.from(cfg.data, "base64");
  b.set(base58Decode(addr(21)), 136); // reward_mint (src/lpadmin.js decodeCityConfig)
  cfg.data = b.toString("base64");
  w.S.accounts[F.holders.vault.address] = { owner: PROGRAM_IDS.token2022, data: tokenAcc(addr(21), F.source.accounts.rewardsConfig, 5n) };
  const r = await w.get(PATH);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.data.holders.vault, r.data.source.accounts.rewardsConfig, r.data.source.accounts.rewardsVault, r.data.holders.forwarded], [null, F.source.accounts.rewardsConfig, null, F.holders.forwarded]);
});

test("route: a whole reading is kept a minute per server and at the edge (public, max-age=60); then read again; the public limit counts the misses only", async () => {
  const w = world("traded");
  const a = await w.get(PATH);
  assert.deepEqual([a.status, a.headers.get("cache-control")], [200, "public, max-age=60"]);
  const n = w.S.log.length;
  advance(30_000);
  const b = await w.get(PATH);
  assert.deepEqual([b.status, b.data], [200, a.data], "the same reading (its read time says when)");
  assert.equal(w.S.log.length, n, "per server: no chain call within the minute");
  advance(31_000);
  const c = await w.get(PATH);
  assert.equal(c.data.source.readAt, "2026-10-20T12:01:01.000Z");
  assert.ok(w.S.log.length > n);
  // the edge: a hit costs nothing, not even the limiter
  _resetFeeStatus(); _resetOfficialCoins();
  const edge = fakeCaches(); edge.install();
  try {
    const e1 = await w.get(PATH);
    const m = w.S.log.length;
    for (let i = 0; i < 70; i++) assert.equal((await w.get(PATH)).status, 200);
    assert.equal(w.S.log.length, m);
    assert.equal(e1.headers.get("cache-control"), "public, max-age=60");
    assert.ok([...edge.store.keys()].some((k) => k.includes(`fee-status-devnet-${FX.programId}-${MINT}`)));
  } finally { edge.uninstall(); }
  // without the edge: 60 misses a minute per connection, then 429
  const lim = world("traded");
  let last;
  for (let i = 0; i < 61; i++) last = await lim.get(`/api/fee-status?mint=${addr(300 + i)}`);
  assert.equal(last.status, 429);
});

test("feeStatus itself: exact BigInt amounts; null for an address that is not an official coin; a failure is kept FAIL_MS, then read again", async () => {
  const w = world("graduated");
  const s = await feeStatus(w.env, MINT, w.chain.fetchImpl, Date.now());
  assert.equal(typeof s.founder.earned, "bigint");
  assert.equal(typeof s.pool.surplus, "bigint");
  assert.equal(String(s.founder.pendingInPool), expected("graduated").founder.pendingInPool);
  assert.equal(await feeStatus(w.env, addr(4), w.chain.fetchImpl, Date.now()), null);
  _resetFeeStatus(); _resetOfficialCoins(); _resetLpKit();
  w.S.down = true;
  await assert.rejects(feeStatus(w.env, MINT, w.chain.fetchImpl, Date.now()));
  w.S.down = false;
  const n = w.S.log.length;
  await assert.rejects(feeStatus(w.env, MINT, w.chain.fetchImpl, Date.now() + FAIL_MS - 1), "still the failure");
  assert.equal(w.S.log.length, n, "the node was not asked again");
  assert.ok(await feeStatus(w.env, MINT, w.chain.fetchImpl, Date.now() + FAIL_MS), "read again after FAIL_MS");
});

/* ---------------------------------------------------------------- the founder card (dashboard) */

const LP_LAUNCH = read("public/lp-launch.js");
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** What the pages print for a read time: "14:05" today in this clock, else "14:05 on 20 Oct" (`sp` the space they use). */
const when = (iso, now = Date.now(), sp = " ") => {
  const d = new Date(Date.parse(iso)), t = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === t.toDateString() ? hm : `${hm} on${sp}${d.getDate()}${sp}${MONTHS[d.getMonth()]}`;
};
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const sol = (raw, sp = " ") => { const v = BigInt(raw); const f = (v % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/, ""); return `${(v / 10n ** 9n).toLocaleString("en-US")}${f ? `.${f}` : ""}${sp}SOL`; };
const READ_AT = "2026-10-20T14:05:00.000Z";
const answerOf = (name, readAt = READ_AT, slot = 1) => ({ ...expected(name, readAt, slot) });
const LAUNCHED = {
  ok: true, cluster: "devnet", chain: "solana:devnet", cityId: FX.coin.cityId, city: { id: FX.coin.cityId, name: "Fee City", country: "US" }, wallet: FOUNDER, ticker: "FEE", state: "launched",
  coin: { name: "Fee City", symbol: "FEE", pair: "SOL", mint: MINT }, mint: MINT, coinPage: `/coin?mint=${MINT}`, explorer: `https://solscan.io/token/${MINT}?cluster=devnet`, yours: true,
  // the status's own reading (src/lplaunch.js founderFees) at chain slot 1, with the Coin record's counters as they were then (0): the
  // fee readings below are at that slot or later, and their counters no lower
  founderFees: { inVaultLamports: "1000000", onCurveLamports: "234000", totalLamports: "1234000", sharePct: "0.25%", words: "0.001234 SOL waiting for you", slot: 1, earnedLamports: "0", collectedLamports: "0" },
};
/** The dashboard with site.js and lp-launch.js; `answers[path]` is what each API call returns (a function gets the url); `now`: the page's clock (ms). */
async function dashboard(answers, { signed = { signature: "Sig1", status: "confirmed", slot: 7 }, sign = null, session = undefined, timers = null, onChange = undefined, now = null } = {}) {
  const page = await openPage("dashboard.html", { agreed: "2026-10-01" });
  const win = page.window;
  if (now !== null) vm.runInContext(`Date.now = () => ${now}`, win); // the viewer's clock (ms), when a test sets it
  win.setTimeout = timers ? (fn, ms) => { timers.push({ fn, ms }); return timers.length; } : (fn) => { setImmediate(fn); return 0; };
  // this tab's sessionStorage (a Map's getItem/setItem), or "refused": a browser that throws on any use of it
  if (session === "refused") Object.defineProperty(win, "sessionStorage", { get() { throw new Error("SecurityError"); } });
  else if (session) win.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => { session.set(k, String(v)); }, removeItem: (k) => { session.delete(k); } };
  win.clearTimeout = () => {};
  const calls = [];
  win.fetch = async (path, init = {}) => {
    calls.push({ path: String(path), body: init.body ? JSON.parse(init.body) : null });
    const p = String(path).split("?")[0];
    let a = p === "/api/lp/launch/status" && !String(path).includes("city=") ? { ok: true, on: true, cluster: "devnet" } : answers[p];
    if (typeof a === "function") a = a(String(path));
    const status = a && a._code ? a._code : a && a.ok === false ? 503 : 200;
    return { ok: status < 400, status, json: async () => a || { ok: false, error: "not_found" } };
  };
  win.VW = { list: () => [{ name: "Phantom", canSign: true, account: { address: FOUNDER }, connect: async () => FOUNDER, signTransaction() {} }], isMobile: false, KNOWN: [] };
  const prepared = [];
  win.LP = {
    supported: async () => true, say: (code) => `said:${code}`, renderSummary: (el, res) => { el.textContent = `summary of ${res.step}`; },
    prepare: async ({ wallet, build }) => { const res = await build([]); prepared.push({ wallet: wallet.account.address, res }); return { response: res, keys: [], sign: sign || (async ({ onStatus }) => { onStatus("done"); return signed; }) }; },
  };
  win.V.toast = () => {};
  win.V.official = Promise.resolve({ ok: true, cityCoins: { cluster: "devnet" } });
  vm.runInContext(LP_LAUNCH, win, { filename: "public/lp-launch.js" });
  const card = page.$("#lp-launch");
  await win.LPLaunch.founder(card, { cityId: FX.coin.cityId, onChange });
  await tick();
  const btn = (t) => card.querySelectorAll("button").find((b) => b.textContent === t) || null;
  const oldLine = () => card.querySelectorAll("p").find((p) => p.textContent.startsWith("Your founder fees:")) || null;
  const pageNow = () => vm.runInContext("Date.now()", win);
  return { page, win, card, calls, prepared, btn, oldLine, pageNow };
}
const rowsOf = (box) => [box.querySelectorAll("dt").map((dt) => text(dt)), box.querySelectorAll("dd").map((dd) => text(dd))];
/** The browser shows the page again: from its back/forward cache (Back or Forward in this tab: `persisted`), or loaded afresh. */
const pageshow = (win, persisted = true) => dispatch(win, newEvent("pageshow", { persisted, bubbles: false }), win);

test("founder card, graduated: where the fees go, earned, collected, the fee vault, still in the pool (the curve, the pool and the city's position), ready now (the vault), each with its account and the time; the old line goes; Collect works as before", async () => {
  const A = answerOf("graduated");
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": A, "/api/lp/founder-claim/tx": { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" } });
  const box = p.card.querySelector(".lp-fees");
  assert.equal(box.hidden, false);
  const at = when(READ_AT, p.pageNow()), acc = A.source.accounts;
  const [labels, dds] = rowsOf(box);
  // no payout paid or agreed to: "collected", with no word about payouts
  assert.deepEqual([A.founder.paidOut, A.founder.payoutAgreed], ["0", false]);
  assert.deepEqual(labels, ["Goes to", "Earned by this coin's founder since launch", "Collected since launch", "In your fee vault", "Still in the pool", "Ready to collect now"]);
  assert.deepEqual(dds, [
    `${short(FOUNDER)} (only this wallet can collect) from the chain at ${at} · coin record ${short(acc.coin)}; no payout agreement for this wallet at ${short(acc.payoutOptIn)}`,
    `${sol(A.founder.earned)} from the chain at ${at} · coin record ${short(acc.coin)}`,
    `${sol(A.founder.collected)} from the chain at ${at} · coin record ${short(acc.coin)}`,
    `${sol(A.founder.claimable)} from the chain at ${at} · your fee vault ${short(acc.founderVault)}`,
    `${sol(A.founder.pendingInPool)} (it moves to your fee vault when someone runs a harvest; anyone can, and there is no set time) from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}, its pool ${short(acc.dammPool)} and position ${short(acc.positions[0])}`,
    `${sol(A.founder.claimable)} from the chain at ${at} · your fee vault ${short(acc.founderVault)}`,
  ]);
  assert.equal(text(box.querySelector(".lp-fees__title")), "This coin's founder fees, read from the chain");
  // every account the pool row rests on is named: the curve's settings with the surplus, every pool and every position
  const { feeCardView } = p.win.LPLaunch.pure;
  const C = answerOf("graduated, curve not harvested"), T = answerOf("position given");
  assert.equal(feeCardView(C, LAUNCHED, p.pageNow()).rows[4][2], `from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}, its price-curve settings ${short(acc.dbcConfig)}, its pool ${short(acc.dammPool)} and position ${short(C.source.accounts.positions[0])}`);
  // that figure holds the curve's fees and its completion surplus too, not the pool's alone: the label says so (with or without
  // the estimate), and once the curve is harvested it is the pool alone again
  assert.ok(BigInt(C.pool.curve) > 0n && BigInt(C.pool.surplus) > 0n && C.coin.graduated);
  const labelOf = (x) => feeCardView(x, LAUNCHED, p.pageNow()).rows.find((r) => r[0].startsWith("Still in"));
  assert.deepEqual(JSON.parse(JSON.stringify([labelOf(C)[0], labelOf(withheldOf(C)).slice(0, 2), labelOf(A)[0], labelOf(T)[0]])),
    ["Still in the curve and the pool", ["Still in the curve and the pool", "can't be worked out right now"], "Still in the pool", "Still in the pool"]);
  assert.deepEqual([labelOf({ ...A, pool: { ...A.pool, curve: "5" } })[0], labelOf({ ...A, pool: { ...A.pool, surplus: "1" } })[0]], ["Still in the curve and the pool", "Still in the curve and the pool"], "the curve's fees alone, or the surplus alone");
  assert.equal(labelOf(answerOf("curve again"))[0], "Still in the curve", "before graduation: the curve");
  assert.equal(feeCardView(T, LAUNCHED, p.pageNow()).rows[4][2], `from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}, its pool ${short(acc.dammPool)} and positions ${T.source.accounts.positions.map(short).join(", ")}`);
  const O = { ...A, source: { ...A.source, accounts: { ...acc, otherDammPools: [addr(41)], positions: [...acc.positions, addr(42)] } } };
  assert.equal(feeCardView(O, LAUNCHED, p.pageNow()).rows[4][2], `from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}, its pool ${short(acc.dammPool)}, pool ${short(addr(41))} and positions ${short(acc.positions[0])}, ${short(addr(42))}`);
  // positions in another pool of the pair too: the row says "the pools" (with the curve's fees or its surplus too, "the curve and the
  // pools"); with the estimate withheld no pool but the coin's own is known
  assert.deepEqual(JSON.parse(JSON.stringify([labelOf(O)[0], labelOf({ ...O, pool: { ...O.pool, curve: "5" } })[0], labelOf({ ...O, pool: { ...O.pool, surplus: "1" } })[0], labelOf(withheldOf(O))[0]])),
    ["Still in the pools", "Still in the curve and the pools", "Still in the curve and the pools", "Still in the pool"]);
  assert.equal(box.querySelector(".lp-fees__src").getAttribute("title"), `Read from the chain at ${READ_AT}`, "the exact time, with its zone, on hover");
  assert.equal(p.calls.find((c) => c.path.startsWith("/api/fee-status")).path, `/api/fee-status?mint=${MINT}`);
  // one set of numbers: the old "waiting for you" line is hidden while the card shows
  assert.equal(p.oldLine().hidden, true);
  // the Collect button is unchanged
  p.btn("Collect your fees").click();
  await tick();
  assert.deepEqual(p.calls.find((c) => c.path === "/api/lp/founder-claim/tx").body, { cityId: FX.coin.cityId, cluster: "devnet" });
  assert.equal(p.prepared[0].wallet, FOUNDER);
});

test("founder card, on the curve: in the vault, still in the curve (the Collect button takes it too) and ready now = their sum; with nothing in the curve, ready now is the vault and the curve waits for a harvest", async () => {
  const C = answerOf("curve again");
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": C });
  const box = p.card.querySelector(".lp-fees"), at = when(READ_AT, p.pageNow()), acc = C.source.accounts;
  const [labels, dds] = rowsOf(box);
  assert.deepEqual(labels, ["Goes to", "Earned by this coin's founder since launch", "Collected since launch", "In your fee vault", "Still in the curve", "Ready to collect now"]);
  // a stranger's gift to the vault left with the claim (litesvm TQ02): collected is more than earned, and the row says why
  assert.ok(BigInt(C.founder.collected) > BigInt(C.founder.earned));
  assert.equal(dds[2], `${sol(C.founder.collected)} (more than earned: it includes extra someone sent straight to the fee vault) from the chain at ${at} · coin record ${short(acc.coin)}`);
  const ready = BigInt(C.founder.claimable) + BigInt(C.founder.pendingInPool);
  assert.ok(BigInt(C.pool.curve) > 0n && BigInt(C.founder.pendingInPool) > 0n);
  assert.deepEqual(dds.slice(3), [
    `${sol(C.founder.claimable)} from the chain at ${at} · your fee vault ${short(acc.founderVault)}`,
    `${sol(C.founder.pendingInPool)} (the Collect button takes it too) from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}`,
    `${sol(ready)} from the chain at ${at} · your fee vault ${short(acc.founderVault)} and the coin's curve ${short(acc.dbcPool)}`,
  ]);
  // without a Collect button on the card the curve waits for a harvest like any other, and nothing above 0 is called ready to collect
  const { feeCardView } = p.win.LPLaunch.pure;
  const off = feeCardView(C, LAUNCHED, p.pageNow(), false).rows;
  assert.deepEqual(JSON.parse(JSON.stringify(off.slice(4))), [
    ["Still in the curve", `${sol(C.founder.pendingInPool)} (it moves to your fee vault when someone runs a harvest; anyone can, and there is no set time)`, `from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}`],
    ["Ready to collect now", "can't be collected from this page right now; reload it to try again", null],
  ]);
  // what Collect then paid (litesvm TQ03: harvest + claim in one transaction) is exactly that sum
  const after_ = expected("collected");
  assert.equal(BigInt(after_.founder.claimed) - BigInt(C.founder.claimed), ready);
  assert.equal(p.oldLine().hidden, true);
  // the full curve before any harvest: its figure includes the completion surplus, worked out from the price-curve settings too
  const F = answerOf("completed");
  assert.ok(BigInt(F.pool.surplus) > 0n && F.coin.graduated === false);
  const fv = feeCardView(F, LAUNCHED, p.pageNow());
  const curve = `the coin's curve ${short(acc.dbcPool)}`, settings = `its price-curve settings ${short(F.source.accounts.dbcConfig)}`;
  assert.deepEqual(JSON.parse(JSON.stringify(fv.rows.slice(4).map((x) => x[2]))), [`from the chain at ${at} · ${curve} and ${settings}`, `from the chain at ${at} · your fee vault ${short(acc.founderVault)}, ${curve} and ${settings}`]);
  assert.equal(fv.rows[5][1], `${sol(BigInt(F.founder.claimable) + BigInt(F.founder.pendingInPool))}`);
  // nothing in the curve: the vault alone is ready; 0 in the curve is just 0 (no word about a harvest that has nothing to move)
  const H = answerOf("harvested");
  assert.equal(H.founder.pendingInPool, "0");
  const q = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, inVaultLamports: H.founder.claimable } }, "/api/fee-status": H });
  const [, hd] = rowsOf(q.card.querySelector(".lp-fees"));
  assert.deepEqual(hd.slice(4), [
    `0 SOL from the chain at ${when(READ_AT, q.pageNow())} · the coin's curve ${short(acc.dbcPool)}`,
    `${sol(H.founder.claimable)} from the chain at ${when(READ_AT, q.pageNow())} · your fee vault ${short(acc.founderVault)}`,
  ]);
});

test("founder card: paid out shows as its own row and the payout the founder agreed to is named; the time shows the date when it is not today", async () => {
  const A = answerOf("harvested");
  const P = { ...A, founder: { ...A.founder, paidOut: "5000", collected: String(BigInt(A.founder.collected) + 5000n), payoutAgreed: true } };
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": P });
  const [labels, dds] = rowsOf(p.card.querySelector(".lp-fees"));
  assert.deepEqual(labels.slice(0, 4), ["Goes to", "Earned by this coin's founder since launch", "Collected or paid out since launch", "Of that, paid out"]);
  assert.match(dds[0], /^\S+ \(only this wallet can collect, or a payout it agreed to\) from the chain/);
  assert.ok(dds[0].endsWith(`coin record ${short(P.source.accounts.coin)} and payout agreement ${short(P.source.accounts.payoutOptIn)}`), "the sentence names the payout agreement it rests on");
  assert.match(dds[3], /^0\.000005 SOL \(sent to the payout wallet the founder agreed to\) from the chain/);
  // the label names payouts only when one was paid or the founder agreed to one (as the coin page does)
  const { feeCardView: view } = p.win.LPLaunch.pure;
  const labelOf = (x) => view(x, LAUNCHED, p.pageNow()).rows[2][0];
  assert.deepEqual([labelOf(A), labelOf({ ...A, founder: { ...A.founder, payoutAgreed: true } }), labelOf({ ...A, founder: { ...A.founder, paidOut: "1", collected: String(BigInt(A.founder.collected) + 1n) } })],
    ["Collected since launch", "Collected or paid out since launch", "Collected or paid out since launch"]);
  // the read time: the date only when it is not today in the viewer's clock
  const { whenText } = p.win.LPLaunch.pure;
  const now = Date.parse("2026-10-20T15:00:00Z");
  assert.equal(whenText(new Date(now - 60_000).toISOString(), now), when(new Date(now - 60_000).toISOString(), now));
  // two days and more before: never today in any time zone; the day and the month are this clock's (TZ=Etc/GMT+12 says 17 Oct,
  // TZ=Pacific/Kiritimati 18 Oct), worked out here the way the page does it
  const past = "2026-10-18T09:30:00.000Z", d = new Date(past);
  assert.equal(whenText(past, now), `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} on ${d.getDate()} ${MONTHS[d.getMonth()]}`);
  assert.match(whenText(past, now), /^\d\d:\d\d on (17|18) Oct$/);
  assert.equal(whenText("never", now), "");
});

test("founder card: nothing at all when the read fails (503, offline, not official), is about another coin, names another founder or a unit the page cannot write; the old line stays; never a zero that looks real", async () => {
  const A = answerOf("graduated");
  for (const bad of [{ ok: false, error: "rpc_unavailable" }, { ok: false, error: "not_official", _code: 404 }, undefined, { ...A, mint: addr(3) },
    { ...A, founder: { ...A.founder, wallet: maskWallet(addr(8)) } }, { ...A, coin: { ...A.coin, quote: null } }, { ...A, founder: { ...A.founder, earned: "-1" } },
    { ...A, source: { ...A.source, readAt: "never" } }, { ...A, pool: null }, { ...A, source: { ...A.source, accounts: { ...A.source.accounts, dammPool: null } } },
    // graduated must be a boolean, the slot a slot, the estimate whole or (after graduation) withheld with no figure
    { ...A, coin: { ...A.coin, graduated: "yes" } }, { ...A, source: { ...A.source, slot: 0 } }, { ...A, pool: { ...A.pool, estimate: undefined } },
    { ...A, founder: { ...A.founder, pendingInPool: null } }, withheldOf(answerOf("curve again")), { ...withheldOf(A), founder: { ...withheldOf(A).founder, pendingInPool: "5" } },
    // every account a figure or a sentence rests on must be an address
    ...["coin", "founderVault", "dbcPool", "dbcConfig", "payoutOptIn"].map((k) => ({ ...A, source: { ...A.source, accounts: { ...A.source.accounts, [k]: "x" } } })),
    { ...A, source: { ...A.source, accounts: { ...A.source.accounts, positions: ["x"] } } }, { ...A, source: { ...A.source, accounts: { ...A.source.accounts, positions: [] } } },
    { ...A, source: { ...A.source, accounts: { ...A.source.accounts, otherDammPools: ["x"] } } }, { ...A, source: { ...A.source, accounts: { ...A.source.accounts, otherDammPools: null } } }]) {
    const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": bad });
    const box = p.card.querySelector(".lp-fees");
    assert.deepEqual([box.hidden, box.children.length], [true, 0], JSON.stringify(bad));
    assert.ok(!/Earned by this coin's founder|0 SOL from the chain/.test(text(p.card)));
    assert.equal(p.oldLine().hidden, false, "the old line stays");
    assert.match(text(p.card), /Your founder fees: 0\.001234 SOL waiting for you \(0\.25% of every trade/);
    assert.ok(p.btn("Collect your fees"), "the Collect button stays");
  }
  // a status with no wallet: never a card (the answer's masked founder could match a missing wallet's "nothing")
  const { feeCardView } = (await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": A })).win.LPLaunch.pure;
  assert.ok(feeCardView(A, LAUNCHED));
  for (const wallet of [undefined, null, "", "x"]) assert.equal(feeCardView({ ...A, founder: { ...A.founder, wallet: null } }, { ...LAUNCHED, wallet }), null, String(wallet));
  // another wallet is the founder on chain: no card (as before), nothing asked
  const other = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, yours: false }, "/api/fee-status": A });
  assert.equal(other.card.querySelector(".lp-fees"), null);
  assert.equal(other.calls.some((c) => c.path.startsWith("/api/fee-status")), false);
});

test("founder card, graduated, the pool estimate withheld by the server: ready now is the vault (what Collect moves after graduation), still in the pool can't be worked out right now (no figure, no source); every exact figure stays, the vault's own row too", async () => {
  const A = answerOf("graduated"), U = withheldOf(A);
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": U });
  const box = p.card.querySelector(".lp-fees"), at = when(READ_AT, p.pageNow()), acc = A.source.accounts;
  assert.equal(box.hidden, false);
  const [labels, dds] = rowsOf(box);
  assert.deepEqual(labels, ["Goes to", "Earned by this coin's founder since launch", "Collected since launch", "In your fee vault", "Still in the pool", "Ready to collect now"]);
  assert.deepEqual(dds.slice(1), [
    `${sol(A.founder.earned)} from the chain at ${at} · coin record ${short(acc.coin)}`,
    `${sol(A.founder.collected)} from the chain at ${at} · coin record ${short(acc.coin)}`,
    `${sol(A.founder.claimable)} from the chain at ${at} · your fee vault ${short(acc.founderVault)}`,
    "can't be worked out right now",
    `${sol(A.founder.claimable)} from the chain at ${at} · your fee vault ${short(acc.founderVault)}`,
  ]);
  assert.equal(box.querySelectorAll(".lp-fees__src").length, 5, "a row with no figure names no source");
  assert.equal(p.oldLine().hidden, true);
});

test("founder card: after Collect, only a reading at the claim's chain slot or later is shown (slots, never clocks: the viewer's clock may be hours off the server's); the status's own line neither when read before it; a newer reading brings the card back", async () => {
  let answer = answerOf("graduated", READ_AT, 100);
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": () => answer, "/api/lp/founder-claim/tx": { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" } }, { signed: { signature: "Sig1", status: "confirmed", slot: 150 } });
  assert.equal(p.card.querySelector(".lp-fees").hidden, false);
  const timers = [];
  p.win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  // the viewer's clock is an hour behind the server's: a reading made before the claim landed (slot 149) has a read time an hour
  // AFTER the click by the viewer's clock (a clock check would show it)
  answer = answerOf("graduated", new Date(p.pageNow() + 3_600_000).toISOString(), 149);
  p.btn("Collect your fees").click();
  await tick();
  p.btn("Approve in your wallet").click();
  await tick();
  const box = p.card.querySelector(".lp-fees");
  assert.deepEqual([box.hidden, box.children.length], [true, 0], "the old figures are not shown");
  // the status asked again after the Collect read its own figures at slot 1, before the claim landed: its line is not shown either
  assert.equal(p.oldLine().hidden, true);
  assert.deepEqual(timers.map((t) => t.ms), [30000], "asked again in 30 seconds");
  // the edge still has it: hidden again, asked again
  timers.shift().fn();
  await tick();
  assert.deepEqual([box.hidden, timers.map((t) => t.ms)], [true, [30000]]);
  // a reading at the claim's own slot shows it: shown, whatever its read time says
  answer = answerOf("pool harvested", "2026-01-01T00:00:00.000Z", 150);
  timers.shift().fn();
  await tick();
  assert.equal(box.hidden, false);
  assert.equal(p.oldLine().hidden, true);
  assert.match(rowsOf(box)[1][3], new RegExp(`^${sol(answer.founder.claimable).replace(".", "\\.")} from the chain`));
  // the rule itself
  const { freshAfterCollect } = p.win.LPLaunch.pure;
  const at = (slot) => ({ ok: true, source: { slot } });
  assert.deepEqual([freshAfterCollect(at(149), 0), freshAfterCollect(at(149), 150), freshAfterCollect(at(150), 150), freshAfterCollect(at(151), 150), freshAfterCollect(at(null), 150), freshAfterCollect({ ok: false }, 150), freshAfterCollect(at(10 ** 9), Infinity)],
    [true, false, true, true, false, false, false]);
});

test("founder card: after a Collect whose landing slot the status did not give, no reading is shown again on that page (nor the status's own line, which cannot be told from one read before it) and nothing is asked again; the tab keeps the moment for the coin page, as after an unclear Collect", async () => {
  let answer = answerOf("graduated", READ_AT, 100);
  const session = new Map();
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": () => answer, "/api/lp/founder-claim/tx": { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" } }, { signed: { signature: "Sig1", status: "confirmed", slot: null }, session });
  const timers = [];
  p.win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  answer = answerOf("pool harvested", READ_AT, 10 ** 9);
  const t0 = p.pageNow();
  p.btn("Collect your fees").click();
  await tick();
  p.btn("Approve in your wallet").click();
  await tick();
  const box = p.card.querySelector(".lp-fees");
  // the status's own line cannot be told from one read before the claim either: neither is shown again on this page
  assert.deepEqual([box.hidden, box.children.length, p.oldLine().hidden, timers.length], [true, 0, true, 0]);
  // no slot to keep for the coin page: the viewer's clock time of it instead, so the coin page shows no "Fees so far" of the coin for
  // 5 minutes (public/coin.js unclearWait), never a reading from before it
  const kept = JSON.parse(session.get("lp-collected-slot"));
  assert.deepEqual([kept.slots, Object.keys(kept.unclear)], [{}, [MINT]]);
  assert.ok(kept.unclear[MINT] >= t0 && kept.unclear[MINT] <= p.pageNow());
});

test("founder card: a reading the status read just now contradicts is never shown, in this tab or any other (more in the vault: older than a claim or a payout; before graduation more in the curve: older than a harvest); the old line shows, it is asked again, and a reading at the status's slot or later is shown", async () => {
  // probe P1: graduated, the founder collected in another tab; the edge still has the reading from before (the vault full), the
  // status read just now says the vault is empty (at slot 11), and the card has no Collect button
  const P = answerOf("pool harvested"), taken = BigInt(P.founder.claimable);
  const after = { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, inVaultLamports: "0", onCurveLamports: "0", totalLamports: "0", words: "0 SOL waiting for you", slot: 11 } };
  let answer = answerOf("pool harvested", READ_AT, 1);
  const timers = [];
  const p = await dashboard({ "/api/lp/launch/status": after, "/api/fee-status": () => answer }, { timers });
  const box = p.card.querySelector(".lp-fees");
  assert.deepEqual([box.hidden, box.children.length], [true, 0], "the reading from before the Collect is not shown");
  assert.equal(p.oldLine().hidden, false);
  assert.match(text(p.card), /Your founder fees: 0 SOL waiting for you/);
  assert.equal(p.btn("Collect your fees"), null);
  assert.deepEqual(timers.map((t) => t.ms), [30000], "asked again in 30 seconds");
  // the reading after the Collect (at the status's slot): shown; 0 is ready, as the status says
  answer = { ...answerOf("pool harvested", READ_AT, 11), founder: { ...P.founder, claimable: "0", claimed: String(BigInt(P.founder.claimed) + taken), collected: String(BigInt(P.founder.collected) + taken) } };
  timers.shift().fn();
  await tick();
  assert.equal(box.hidden, false);
  assert.equal(p.oldLine().hidden, true);
  assert.equal(rowsOf(box)[1][3], `0 SOL from the chain at ${when(READ_AT, p.pageNow())} · your fee vault ${short(P.source.accounts.founderVault)}`);
  // probe P2: on the curve, the Collect (harvest + claim) took the curve's fees: a reading from before shows them still there
  const q = await dashboard({ "/api/lp/launch/status": after, "/api/fee-status": answerOf("curve again", READ_AT, 1) }, { timers: [] });
  assert.deepEqual([q.card.querySelector(".lp-fees").hidden, q.card.querySelector(".lp-fees").children.length, q.oldLine().hidden], [true, 0, false]);
  // newer than the status (the vault grew with someone's harvest since): shown, but with no Collect button on the card nothing above
  // 0 is called ready to collect
  const n = await dashboard({ "/api/lp/launch/status": after, "/api/fee-status": answerOf("pool harvested", READ_AT, 12) }, { timers: [] });
  const [labels, dds] = rowsOf(n.card.querySelector(".lp-fees"));
  assert.equal(n.btn("Collect your fees"), null);
  assert.deepEqual([labels[3], labels[5]], ["In your fee vault", "Ready to collect now"]);
  // what is in the vault is still shown, with its source: only "ready to collect" is not said
  assert.ok(BigInt(P.founder.claimable) > 0n);
  assert.equal(dds[3], `${sol(P.founder.claimable)} from the chain at ${when(READ_AT, n.pageNow())} · your fee vault ${short(P.source.accounts.founderVault)}`);
  assert.equal(dds[5], "can't be collected from this page right now; reload it to try again");
  // the rule itself (the balances; the counters equal on both sides here: see the next test for them)
  const { olderThanStatus } = p.win.LPLaunch.pure;
  const fees = (inVault, onCurve, slot = 11) => ({ inVaultLamports: inVault, onCurveLamports: onCurve, slot, earnedLamports: "7", collectedLamports: "3" });
  const at = (claimable, curve, slot, graduated = false) => ({ ok: true, coin: { graduated }, founder: { claimable, earned: "7", collected: "3" }, pool: { curve }, source: { slot } });
  assert.deepEqual([
    olderThanStatus(at("5", "0", 1), fees("0", "0")), // more in the vault, older: a claim since
    olderThanStatus(at("0", "4", 1), fees("0", "1")), // half the curve (2) over the status's 1, older: a harvest since
    olderThanStatus(at("0", "3", 1), fees("0", "1")), // half of 3 is 1: no more than the status
    olderThanStatus(at("0", "9", 1, true), fees("0", "0")), // graduated: the curve is not what Collect takes
    olderThanStatus(at("5", "0", 11), fees("0", "0")), // at the status's slot: the newer one
    olderThanStatus(at("5", "0", 12), fees("0", "0", null)), // no slot to tell: hidden
    olderThanStatus(at("0", "0", 1), fees("0", "0", null)), // nothing more: shown
    olderThanStatus(at("5", "0", 1), null), // no status figures at all: nothing to tell
    olderThanStatus(at("5", "0", 1), fees("x", "0")), // a status figure that is not one: hidden
    olderThanStatus({ ok: true }, fees("0", "0")), // a reading with no figures: hidden
  ], [true, true, false, false, false, true, false, false, true, true]);
});

test("founder card: after Collect the card's figures go at once (before the status is asked again), and the slot rule holds in this tab across reloads (sessionStorage, by coin): a reload shows no reading from before the claim, another coin's card is not touched, a browser that refuses storage keeps it for the page", async () => {
  const session = new Map();
  const claim = { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" };
  let answer = answerOf("graduated", READ_AT, 100), release = null, asked = 0;
  // the status asked again after the Collect waits until the test lets it go
  const status = () => (++asked === 1 ? LAUNCHED : new Promise((ok) => { release = () => ok(LAUNCHED); }));
  const p = await dashboard({ "/api/lp/launch/status": status, "/api/fee-status": () => answer, "/api/lp/founder-claim/tx": claim }, { signed: { signature: "Sig1", status: "confirmed", slot: 150 }, session, timers: [] });
  const box = p.card.querySelector(".lp-fees");
  assert.equal(box.hidden, false);
  answer = answerOf("graduated", READ_AT, 149);
  p.btn("Collect your fees").click();
  await tick();
  p.btn("Approve in your wallet").click();
  await tick();
  assert.ok(release, "the status is being asked again");
  assert.deepEqual([box.hidden, box.children.length, p.oldLine().hidden], [true, 0, true], "the old figures went the moment the Collect landed");
  assert.deepEqual(JSON.parse(session.get("lp-collected-slot")), { slots: { [MINT]: 150 }, unclear: {} }, "the claim's slot, by coin, in this tab");
  release();
  await tick();
  assert.equal(p.card.querySelector(".lp-fees").hidden, true, "a reading from before the claim is not shown");
  // a reload of this tab: the status does not contradict that reading, the slot rule still holds
  const timers = [];
  const r = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": () => answer }, { session, timers });
  // the status read its figures at slot 1, before the claim: its line is not shown either
  assert.deepEqual([r.card.querySelector(".lp-fees").hidden, r.oldLine().hidden, timers.map((t) => t.ms)], [true, true, [30000]]);
  // a status that read them at the claim's slot or later: its line shows while the fee reading waits
  const fresh = { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, inVaultLamports: "0", totalLamports: LAUNCHED.founderFees.onCurveLamports, slot: 150 } };
  const s2 = await dashboard({ "/api/lp/launch/status": fresh, "/api/fee-status": () => answer }, { session, timers: [] });
  assert.deepEqual([s2.card.querySelector(".lp-fees").hidden, s2.oldLine().hidden], [true, false]);
  answer = answerOf("pool harvested", READ_AT, 150);
  timers.shift().fn();
  await tick();
  assert.equal(r.card.querySelector(".lp-fees").hidden, false, "a reading at the claim's slot is shown");
  // another coin of the same founder: its card is not touched by this coin's Collect
  const OTHER = addr(61);
  const o = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, mint: OTHER, coin: { ...LAUNCHED.coin, mint: OTHER } }, "/api/fee-status": { ...answerOf("graduated", READ_AT, 2), mint: OTHER } }, { session, timers: [] });
  assert.equal(o.card.querySelector(".lp-fees").hidden, false);
  // storage refused (a private window): the rule holds for the page
  answer = answerOf("graduated", READ_AT, 100);
  const x = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": () => answer, "/api/lp/founder-claim/tx": claim }, { signed: { signature: "Sig1", status: "confirmed", slot: 150 }, session: "refused", timers: [] });
  assert.equal(x.card.querySelector(".lp-fees").hidden, false);
  answer = answerOf("graduated", READ_AT, 149);
  x.btn("Collect your fees").click();
  await tick();
  x.btn("Approve in your wallet").click();
  await tick();
  assert.equal(x.card.querySelector(".lp-fees").hidden, true);
});

test("founder card: when the status could not read the founder's fees (no Collect button), the card says what is there but calls nothing above 0 ready to collect, and what is in the curve waits for a harvest", async () => {
  // probe N1: the full curve before any harvest; the status's own fee read failed (founderFees null)
  const F = answerOf("completed");
  const p = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, founderFees: null }, "/api/fee-status": F });
  const box = p.card.querySelector(".lp-fees"), at = when(READ_AT, p.pageNow()), acc = F.source.accounts;
  assert.equal(box.hidden, false);
  assert.equal(p.btn("Collect your fees"), null);
  const [labels, dds] = rowsOf(box);
  assert.deepEqual(labels.slice(3), ["In your fee vault", "Still in the curve", "Ready to collect now"]);
  assert.deepEqual(dds.slice(4), [
    `${sol(F.founder.pendingInPool)} (it moves to your fee vault when someone runs a harvest; anyone can, and there is no set time) from the chain at ${at} · the coin's curve ${short(acc.dbcPool)} and its price-curve settings ${short(acc.dbcConfig)}`,
    "can't be collected from this page right now; reload it to try again",
  ]);
  assert.doesNotMatch(text(box), /collecting takes it too|the Collect button takes it/);
  // nothing anywhere: 0 is ready, with its source
  const z = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, founderFees: null }, "/api/fee-status": answerOf("launched") });
  assert.equal(rowsOf(z.card.querySelector(".lp-fees"))[1][5], `0 SOL from the chain at ${when(READ_AT, z.pageNow())} · your fee vault ${short(acc.founderVault)}`);
});

test("founder card, graduated, with no Collect button (the status could not read its fees): what is in the fee vault still shows with its source, also when the pool estimate is withheld; only 'ready to collect' is not said", async () => {
  // probe P1 of the last recheck: the vault read cleanly (0.635047713 SOL) and was shown nowhere
  const A = answerOf("graduated"), acc = A.source.accounts;
  assert.ok(BigInt(A.founder.claimable) > 0n);
  for (const ans of [A, withheldOf(A)]) {
    const p = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, founderFees: null }, "/api/fee-status": ans });
    const box = p.card.querySelector(".lp-fees"), at = when(READ_AT, p.pageNow());
    assert.equal(box.hidden, false);
    assert.equal(p.btn("Collect your fees"), null);
    assert.equal(p.oldLine(), null, "the status has no line of its own: the card is the only place for the vault");
    const [labels, dds] = rowsOf(box);
    assert.deepEqual(labels, ["Goes to", "Earned by this coin's founder since launch", "Collected since launch", "In your fee vault", "Still in the pool", "Ready to collect now"]);
    assert.deepEqual(dds.slice(1, 4), [
      `${sol(A.founder.earned)} from the chain at ${at} · coin record ${short(acc.coin)}`,
      `${sol(A.founder.collected)} from the chain at ${at} · coin record ${short(acc.coin)}`,
      `${sol(A.founder.claimable)} from the chain at ${at} · your fee vault ${short(acc.founderVault)}`,
    ]);
    assert.equal(dds[4], ans === A ? `${sol(A.founder.pendingInPool)} (it moves to your fee vault when someone runs a harvest; anyone can, and there is no set time) from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}, its pool ${short(acc.dammPool)} and position ${short(acc.positions[0])}` : "can't be worked out right now");
    assert.equal(dds[5], "can't be collected from this page right now; reload it to try again");
  }
});

test("founder card: a Collect whose outcome the page cannot tell (not confirmed in time, past the time the page gave it, sent with no id to follow) takes the figures from before it off at once, and the old line; nothing is shown again on that page and the button stays away; a reload reads afresh; a Collect the chain said failed or ran out of time keeps them and the button", async () => {
  const claim = { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" };
  const errorOf = (code, extra) => Object.assign(new Error(`words for ${code}`), { code }, extra);
  const sig = { signature: "Sig9", solscan: "https://solscan.io/tx/Sig9?cluster=devnet" };
  for (const [code, extra] of [["unconfirmed", sig], ["expired_unclear", sig], ["wallet_send_unclear", { unclear: true }], ["wallet_send_failed", { unclear: true }]]) {
    const session = new Map(), timers = [];
    const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": answerOf("graduated", READ_AT, 100), "/api/lp/founder-claim/tx": claim },
      { session, timers, sign: async ({ onStatus }) => { if (extra.signature) onStatus("confirming", extra.signature); throw errorOf(code, extra); } });
    const box = p.card.querySelector(".lp-fees");
    assert.deepEqual([box.hidden, p.oldLine().hidden], [false, true], code);
    assert.ok(rowsOf(box)[1][5].startsWith(`${sol(answerOf("graduated").founder.claimable)} from the chain`));
    const asked = p.calls.filter((c) => c.path.startsWith("/api/fee-status")).length;
    const t0 = p.pageNow();
    p.btn("Collect your fees").click();
    await tick();
    p.btn("Approve in your wallet").click();
    await tick();
    const t1 = p.pageNow();
    // the reviewer's probe P2: the card kept "Ready to collect now: 0.635047713 SOL" and offered Collect again
    assert.deepEqual([box.hidden, box.children.length, p.oldLine().hidden], [true, 0, true], `${code}: the figures from before it are gone`);
    assert.ok(!text(p.card).includes(sol(answerOf("graduated").founder.claimable)), code);
    assert.equal(p.btn("Collect your fees").hidden, true, `${code}: not offered again on this page`);
    assert.equal(p.btn("Approve in your wallet"), null);
    assert.match(text(p.card.querySelector(".lp-flow")), new RegExp(`words for ${code}`), "the words that say what to check stay");
    if (extra.signature) assert.equal(p.card.querySelector(".lp-flow").querySelectorAll("a").at(-1).getAttribute("href"), sig.solscan);
    // nothing is asked or shown again on this page; the tab keeps no slot (none is known), only the viewer's clock time of that
    // moment by coin, for the coin page (public/coin.js: no "Fees so far" of the coin for 5 minutes after it)
    assert.deepEqual([timers.length, p.calls.filter((c) => c.path.startsWith("/api/fee-status")).length], [0, asked]);
    const kept = JSON.parse(session.get("lp-collected-slot"));
    assert.deepEqual([Object.keys(kept).sort(), kept.slots, Object.keys(kept.unclear)], [["slots", "unclear"], {}, [MINT]], code);
    assert.ok(Number.isSafeInteger(kept.unclear[MINT]) && kept.unclear[MINT] >= t0 && kept.unclear[MINT] <= t1, `${code}: the viewer's clock at that moment`);
    // a reload reads the chain afresh: the Collect did not land (the status's counters are those of the reading): shown
    const r = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": answerOf("graduated", READ_AT, 100) }, { session, timers: [] });
    assert.equal(r.card.querySelector(".lp-fees").hidden, false, `${code}: a reload shows what the chain says`);
    // it landed (the status read after it has the record's collected counter up by the vault): the reading from before it is not shown
    const G = answerOf("graduated"), landed = { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, inVaultLamports: "0", slot: 170, earnedLamports: G.founder.earned, collectedLamports: String(BigInt(G.founder.collected) + BigInt(G.founder.claimable)) } };
    const r2 = await dashboard({ "/api/lp/launch/status": landed, "/api/fee-status": answerOf("graduated", READ_AT, 100) }, { session, timers: [] });
    assert.deepEqual([r2.card.querySelector(".lp-fees").hidden, r2.card.querySelector(".lp-fees").children.length], [true, 0], `${code}: a reload after it landed shows no reading from before it`);
  }
  // the chain said so: it failed, or ran out of time with nothing spent; the figures are still true, and Collect is offered again
  for (const code of ["failed", "expired"]) {
    const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": answerOf("graduated", READ_AT, 100), "/api/lp/founder-claim/tx": claim },
      { session: new Map(), timers: [], sign: async () => { throw errorOf(code, sig); } });
    p.btn("Collect your fees").click();
    await tick();
    p.btn("Approve in your wallet").click();
    await tick();
    assert.deepEqual([p.card.querySelector(".lp-fees").hidden, p.oldLine().hidden, p.btn("Collect your fees").hidden], [false, true, false], code);
  }
  // the rule for the status's own line (statusFresh): only a status read at the Collect's slot or later
  const { statusFresh } = p0().LPLaunch.pure;
  assert.deepEqual([statusFresh({ slot: 5 }, 0), statusFresh({ slot: 5 }, 6), statusFresh({ slot: 6 }, 6), statusFresh({ slot: 7 }, 6), statusFresh({}, 6), statusFresh({ slot: 10 ** 9 }, Infinity), statusFresh(null, 0)],
    [true, false, true, true, false, false, false]);
});
/** lp-launch.js's helpers alone (node). */
const p0 = () => { const ctx = vm.createContext({ console }); vm.runInContext(LP_LAUNCH, ctx); return ctx; };

test("founder card: after a Collect that landed, the status's own line shows only when the status read it at the Collect's slot or later (a node behind it still has the money that left); the card's reading waits for the same", async () => {
  const claim = { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" };
  let st = LAUNCHED;
  const timers = [];
  const p = await dashboard({ "/api/lp/launch/status": () => st, "/api/fee-status": answerOf("graduated", READ_AT, 100), "/api/lp/founder-claim/tx": claim }, { signed: { signature: "Sig1", status: "confirmed", slot: 150 }, session: new Map(), timers });
  // the status asked again after the Collect comes from a node at slot 149: it still says the fees wait
  st = { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, slot: 149 } };
  p.btn("Collect your fees").click();
  await tick();
  p.btn("Approve in your wallet").click();
  await tick();
  assert.equal(p.oldLine().hidden, true, "a status from before the Collect does not show its 'waiting for you'");
  // the card's wait for a newer reading does not bring that line back either
  timers.shift().fn();
  await tick();
  assert.deepEqual([p.card.querySelector(".lp-fees").hidden, p.oldLine().hidden], [true, true]);
  // a status at the Collect's slot: its line shows while the card waits
  st = { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, inVaultLamports: "0", totalLamports: "234000", words: "0.000234 SOL waiting for you", slot: 150 } };
  await p.win.LPLaunch.founder(p.card, { cityId: FX.coin.cityId });
  await tick();
  assert.equal(p.oldLine().hidden, false);
  assert.match(text(p.card), /Your founder fees: 0\.000234 SOL waiting for you/);
});

test("founder card: the Coin record's counters only grow, so a reading with a lower earned or collected than the status read just now is older (a harvest, a Collect or a payout since), whatever its slot or balances say; a status whose counters did not read hides every reading and nothing is asked again", async () => {
  const { olderThanStatus, statusTells } = p0().LPLaunch.pure;
  const st = (earned, collected, o = {}) => ({ inVaultLamports: "0", onCurveLamports: "0", slot: 170, earnedLamports: earned, collectedLamports: collected, ...o });
  const at = (earned, collected, slot = 100) => ({ ok: true, coin: { graduated: true }, founder: { claimable: "0", earned, collected }, pool: { curve: "0" }, source: { slot } });
  assert.deepEqual([
    olderThanStatus(at("10", "5"), st("10", "5")), // the same counters, nothing more in the vault or the curve: shown
    olderThanStatus(at("10", "4"), st("10", "5")), // collected lower: a Collect or a payout since
    olderThanStatus(at("9", "5"), st("10", "5")), // earned lower: a harvest since
    olderThanStatus(at("9", "4", 10 ** 9), st("10", "5")), // lower, whatever slot the reading names
    olderThanStatus(at("11", "6", 1), st("10", "5")), // higher: the newer of the two, whatever its slot
    olderThanStatus(at("10", "5"), st(null, null)), // the status's record did not read: it cannot tell, so nothing shows
    olderThanStatus(at("10", "5"), st("10", undefined)),
    olderThanStatus(at("10", "5"), st("x", "5")),
    olderThanStatus(at("10", null), st("10", "5")), // a counter of the reading that is not a figure
    olderThanStatus(at("10", "5"), null), // the status has no fee figures at all: nothing to tell
  ], [false, true, true, true, false, true, true, true, true, false]);
  assert.deepEqual([statusTells(null), statusTells(st("1", "2")), statusTells(st(null, "2")), statusTells(st("1", "2", { inVaultLamports: "-1" }))], [true, true, false, false]);
  // in the page: a status whose counters did not read shows its own line, never a fee reading, and does not ask again (it never could)
  const timers = [];
  const p = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, earnedLamports: null, collectedLamports: null } }, "/api/fee-status": answerOf("graduated", READ_AT, 100) }, { timers });
  assert.deepEqual([p.card.querySelector(".lp-fees").hidden, p.card.querySelector(".lp-fees").children.length, p.oldLine().hidden, timers.length], [true, 0, false, 0]);
});

/** The recheck's probe (a new tab after a Collect): the status read now, with the record's counters `earned`/`collected`. */
const statusNow = ({ inVault, onCurve, earned, collected, slot = 170 }) => ({ ...LAUNCHED, founderFees: { inVaultLamports: inVault, onCurveLamports: onCurve, totalLamports: String(BigInt(inVault) + BigInt(onCurve)),
  sharePct: "0.25%", words: `${sol(BigInt(inVault) + BigInt(onCurve))} waiting for you`, slot, earnedLamports: earned, collectedLamports: collected } });

test("founder card in a new tab after a Collect (nothing kept in its sessionStorage), graduated: a harvest since filled the vault past the reading from before the Collect; the record's collected counter tells that reading is older; it stays hidden until a reading has the counters", async () => {
  // the reading at slot 100 (the vault 0.635047713 SOL); the Collect at 150 moves it all (collected + 0.635047713); a pool harvest at
  // 160 books 0.7 SOL for the founder (earned + 0.7, the vault 0.7); the status read at 170 says so
  const R = answerOf("graduated", READ_AT, 100), C = BigInt(R.founder.claimable), H = 700_000_000n;
  const earned = String(BigInt(R.founder.earned) + H), collected = String(BigInt(R.founder.collected) + C);
  const st = statusNow({ inVault: String(H), onCurve: "0", earned, collected });
  // the balances alone cannot tell: the reading shows less in the vault than the status (0.635 < 0.7)
  assert.ok(C < H);
  let answer = R;
  const timers = [];
  const p = await dashboard({ "/api/lp/launch/status": st, "/api/fee-status": () => answer }, { session: new Map(), timers });
  const box = p.card.querySelector(".lp-fees");
  assert.deepEqual([box.hidden, box.children.length], [true, 0], "the reading from before the Collect is not shown");
  assert.ok(!text(p.card).includes(sol(R.founder.claimable)), "nothing from before the Collect anywhere on the card");
  // the status's own line and the Collect button (what the button moves now: the vault, 0.7)
  assert.equal(p.oldLine().hidden, false);
  assert.match(text(p.card), /Your founder fees: 0\.7 SOL waiting for you/);
  assert.ok(p.btn("Collect your fees"));
  assert.deepEqual(timers.map((t) => t.ms), [30000], "asked again in 30 seconds");
  // the edge still has it 30 seconds later: still hidden, asked again
  timers.shift().fn();
  await tick();
  assert.deepEqual([box.hidden, timers.map((t) => t.ms)], [true, [30000]]);
  // a reading after the harvest (the counters of the status, at a later slot): shown, and "Ready to collect now" is what the button moves
  answer = { ...answerOf("graduated", READ_AT, 175), founder: { ...R.founder, earned, collected, claimed: collected, claimable: String(H), pendingInPool: "0" } };
  timers.shift().fn();
  await tick();
  assert.equal(box.hidden, false);
  assert.equal(p.oldLine().hidden, true);
  const [labels, dds] = rowsOf(box);
  const at = when(READ_AT, p.pageNow()), acc = R.source.accounts;
  assert.deepEqual([labels[2], dds[2]], ["Collected since launch", `${sol(collected)} from the chain at ${at} · coin record ${short(acc.coin)}`]);
  assert.deepEqual([labels[5], dds[5]], ["Ready to collect now", `${sol(H)} from the chain at ${at} · your fee vault ${short(acc.founderVault)}`]);
});

test("founder card in a new tab after a Collect, on the curve: trades since put more in the curve than the reading from before the Collect had; the record's earned and collected counters tell that reading is older; it stays hidden until a reading has the counters", async () => {
  // the reading at slot 100 (0.02 SOL in the curve: 0.01 SOL the founder's); the Collect at 150 harvests and claims it (earned and
  // collected + 0.01: the "collected" reading's counters); trades since put 0.024 SOL in the curve (0.012 the founder's)
  const R = answerOf("curve again", READ_AT, 100), K = answerOf("collected");
  const st = statusNow({ inVault: "0", onCurve: "12000000", earned: K.founder.earned, collected: K.founder.collected });
  assert.deepEqual([BigInt(K.founder.earned) - BigInt(R.founder.earned), BigInt(K.founder.collected) - BigInt(R.founder.collected)], [BigInt(R.founder.pendingInPool), BigInt(R.founder.pendingInPool)]);
  // the balances alone cannot tell: the reading shows less in the curve (0.01 SOL the founder's) than the status (0.012)
  assert.ok(BigInt(R.pool.curve) / 2n < 12_000_000n && R.founder.claimable === "0");
  let answer = R;
  const timers = [];
  const p = await dashboard({ "/api/lp/launch/status": st, "/api/fee-status": () => answer }, { session: new Map(), timers });
  const box = p.card.querySelector(".lp-fees");
  assert.deepEqual([box.hidden, box.children.length, p.oldLine().hidden], [true, 0, false], "the reading from before the Collect is not shown; the status's line is");
  assert.match(text(p.card), /Your founder fees: 0\.012 SOL waiting for you/);
  assert.deepEqual(timers.map((t) => t.ms), [30000]);
  // a reading after it (the counters of the status, 0.024 SOL in the curve): shown
  answer = { ...answerOf("collected", READ_AT, 175), pool: { ...K.pool, curve: "24000000" }, founder: { ...K.founder, pendingInPool: "12000000" } };
  timers.shift().fn();
  await tick();
  assert.equal(box.hidden, false);
  const [labels, dds] = rowsOf(box);
  const at = when(READ_AT, p.pageNow()), acc = R.source.accounts;
  assert.deepEqual(labels.slice(4), ["Still in the curve", "Ready to collect now"]);
  assert.deepEqual(dds.slice(4), [
    `${sol("12000000")} (the Collect button takes it too) from the chain at ${at} · the coin's curve ${short(acc.dbcPool)}`,
    `${sol("12000000")} from the chain at ${at} · your fee vault ${short(acc.founderVault)} and the coin's curve ${short(acc.dbcPool)}`,
  ]);
});

test("founder card on a page Back brings back as the browser kept it, after a Collect of the coin on a later dashboard page of the same tab: the figures, the old line and the Collect button from before it go at once, and the card reads the chain again; with nothing new it reads again with its figures up; a page whose own Collect ended unclear stays as it was", async () => {
  // the reviewer's probe: dashboard, coin page, dashboard again (a new page), Collect lands there at slot 150, then Back twice to the
  // first dashboard page, which still showed "In your fee vault 0.635047713 SOL", "Ready to collect now" and the Collect button
  const R = answerOf("graduated", READ_AT, 100), taken = BigInt(R.founder.claimable);
  assert.ok(taken > 0n);
  const before = statusNow({ inVault: R.founder.claimable, onCurve: "0", earned: R.founder.earned, collected: R.founder.collected, slot: 100 });
  const collected = String(BigInt(R.founder.collected) + taken);
  const after = statusNow({ inVault: "0", onCurve: "0", earned: R.founder.earned, collected, slot: 160 });
  const session = new Map(), timers = [], changes = [];
  let st = before, answer = R;
  const p = await dashboard({ "/api/lp/launch/status": () => st, "/api/fee-status": () => answer }, { session, timers, onChange: (r) => changes.push(r) });
  const asked = (what) => p.calls.filter((c) => c.path.startsWith(what)).length;
  const box = p.card.querySelector(".lp-fees");
  assert.deepEqual([box.hidden, p.oldLine().hidden, p.btn("Collect your fees").hidden, timers.length], [false, true, false, 0]);
  assert.ok(text(box).includes(sol(R.founder.claimable)));
  // the later page's Collect (public/lp-launch.js noteCollected there) and the chain after it
  session.set("lp-collected-slot", JSON.stringify({ slots: { [MINT]: 150 }, unclear: {} }));
  st = after;
  const n0 = [asked("/api/lp/launch/status?city="), asked("/api/fee-status")];
  pageshow(p.win);
  // at once, before any answer: nothing from before the Collect is left on the card, and no button to send another
  assert.deepEqual([box.hidden, box.children.length, p.oldLine().hidden, p.btn("Collect your fees").hidden], [true, 0, true, true]);
  assert.ok(!text(p.card).includes(sol(R.founder.claimable)));
  await tick();
  // read again: the status (no-store) and the fees; the edge still has the reading from before the Collect (slot 100): not shown, asked
  // again in 30 seconds; the status read after it says nothing waits (its line, no button)
  assert.deepEqual([asked("/api/lp/launch/status?city=") - n0[0], asked("/api/fee-status") - n0[1]], [1, 1]);
  const box2 = p.card.querySelector(".lp-fees");
  assert.deepEqual([box2.hidden, box2.children.length, p.btn("Collect your fees"), p.oldLine().hidden], [true, 0, null, false]);
  assert.match(text(p.card), /Your founder fees: 0 SOL waiting for you/);
  assert.ok(!text(p.card).includes(sol(R.founder.claimable)));
  assert.deepEqual(timers.map((t) => t.ms), [30000]);
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ on: true, state: "launched" }], "the dashboard hears the card refreshed itself");
  // a reading after the Collect: shown, with what it moved counted as collected
  answer = { ...answerOf("graduated", READ_AT, 160), founder: { ...R.founder, claimable: "0", claimed: String(BigInt(R.founder.claimed) + taken), collected } };
  timers.shift().fn();
  await tick();
  assert.equal(box2.hidden, false);
  const [labels, dds] = rowsOf(box2);
  assert.deepEqual([labels[2], labels[3], labels[5]], ["Collected since launch", "In your fee vault", "Ready to collect now"]);
  assert.ok(dds[2].startsWith(`${sol(collected)} `) && dds[3].startsWith("0 SOL from the chain") && dds[5].startsWith("0 SOL from the chain"), JSON.stringify(dds));

  // nothing new in this tab (another coin's Collect only): the card keeps its figures while it reads the chain again
  const q = await dashboard({ "/api/lp/launch/status": before, "/api/fee-status": () => R }, { session: new Map([["lp-collected-slot", JSON.stringify({ slots: { [addr(61)]: 10 ** 9 }, unclear: {} })]]), timers: [] });
  const qBox = q.card.querySelector(".lp-fees"), qAsked = q.calls.length;
  pageshow(q.win, false); // a page loaded afresh: its own load reads the chain; nothing more here
  await tick();
  assert.equal(q.calls.length, qAsked);
  pageshow(q.win);
  assert.deepEqual([qBox.hidden, q.btn("Collect your fees").hidden], [false, false], "nothing known has changed: the figures stay up meanwhile");
  await tick();
  assert.deepEqual(q.calls.slice(qAsked).map((c) => c.path.split("?")[0]), ["/api/lp/launch/status", "/api/fee-status"]);
  assert.equal(q.card.querySelector(".lp-fees").hidden, false);
  assert.ok(text(q.card.querySelector(".lp-fees")).includes(sol(R.founder.claimable)));

  // this page's own Collect ended with an outcome it could not tell: Back to it keeps it as it was (its words say what to check; no
  // button until a reload), and nothing is asked again
  const claim = { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" };
  const u = await dashboard({ "/api/lp/launch/status": before, "/api/fee-status": () => R, "/api/lp/founder-claim/tx": claim },
    { session: new Map(), timers: [], sign: async () => { throw Object.assign(new Error("words for wallet_send_unclear"), { code: "wallet_send_unclear", unclear: true }); } });
  u.btn("Collect your fees").click();
  await tick();
  u.btn("Approve in your wallet").click();
  await tick();
  const uAsked = u.calls.length;
  pageshow(u.win);
  await tick();
  assert.equal(u.calls.length, uAsked);
  assert.deepEqual([u.card.querySelector(".lp-fees").hidden, u.oldLine().hidden, u.btn("Collect your fees").hidden], [true, true, true]);
  assert.match(text(u.card.querySelector(".lp-flow")), /words for wallet_send_unclear/);
});

test("founder card: in this tab, within 5 minutes of a Collect that ended unclear or landed with no slot given, a status that cannot tell an older reading (its fee read failed) shows no fee reading of the coin and asks nothing again (the edge's copy may be from before it); after the wait, a clock moved back, another coin's mark or a status with its counters: as before", async () => {
  // the recheck's probe (reload-unclear): an unclear Collect that then landed, a reload of the tab 30 s later, the status's fee read
  // failed (founderFees null) and the fee answer is the edge's copy from before it (slot 100): the card showed "In your fee vault:
  // 0.635047713 SOL" (what the Collect took), the earned and collected rows from before it and "Still in the pool", while the vault was 0
  const claim = { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" };
  const R = answerOf("graduated", READ_AT, 100), taken = sol(R.founder.claimable);
  assert.ok(BigInt(R.founder.claimable) > 0n);
  const blind = { ...LAUNCHED, founderFees: null };
  const nothing = (q, timers, what) => {
    const box = q.card.querySelector(".lp-fees");
    assert.deepEqual([box.hidden, box.children.length, q.btn("Collect your fees"), q.oldLine(), timers.length], [true, 0, null, null, 0], what);
    assert.ok(!text(q.card).includes(taken), what);
  };
  for (const how of ["unclear", "no slot"]) {
    const session = new Map();
    const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": () => R, "/api/lp/founder-claim/tx": claim },
      how === "unclear" ? { session, timers: [], sign: async () => { throw Object.assign(new Error("words"), { code: "wallet_send_unclear", unclear: true }); } }
        : { session, timers: [], signed: { signature: "Sig1", status: "confirmed", slot: null } });
    p.btn("Collect your fees").click();
    await tick();
    p.btn("Approve in your wallet").click();
    await tick();
    const kept = JSON.parse(session.get("lp-collected-slot")), mark = kept.unclear[MINT];
    assert.deepEqual([kept.slots, Number.isSafeInteger(mark)], [{}, true], `${how}: no slot, only the moment`);
    // a reload of the tab 30 s later by the viewer's clock
    const timers = [];
    const r = await dashboard({ "/api/lp/launch/status": blind, "/api/fee-status": () => R }, { session, timers, now: mark + 30000 });
    nothing(r, timers, `${how}: a reload within the wait`);
    // the status reads its counters again: they tell the reading from before the Collect, as before (and it is asked again)
    const G = answerOf("graduated"), landed = { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, inVaultLamports: "0", slot: 170, earnedLamports: G.founder.earned, collectedLamports: String(BigInt(G.founder.collected) + BigInt(G.founder.claimable)) } };
    const c = await dashboard({ "/api/lp/launch/status": landed, "/api/fee-status": () => R }, { session, timers: [], now: mark + 30000 });
    assert.deepEqual([c.card.querySelector(".lp-fees").hidden, text(c.card).includes(taken)], [true, false], `${how}: the counters tell`);
    // past the wait (the coin page's 5 minutes: any copy at the edge or a server is from after the Collect by then): shown, stamped
    const w = await dashboard({ "/api/lp/launch/status": blind, "/api/fee-status": () => R }, { session, timers: [], now: mark + 300000 });
    assert.equal(w.card.querySelector(".lp-fees").hidden, false, `${how}: after the wait`);
    // the viewer's clock moved back past that moment: it waits too
    const b = [];
    nothing(await dashboard({ "/api/lp/launch/status": blind, "/api/fee-status": () => R }, { session, timers: b, now: mark - 60000 }), b, `${how}: a clock moved back`);
  }
  // another coin's mark, or none: the status says nothing and nothing is known here, so the card shows the vault (probe P1 stays)
  for (const session of [new Map([["lp-collected-slot", JSON.stringify({ slots: {}, unclear: { [addr(61)]: Date.now() } })]]), new Map()]) {
    const q = await dashboard({ "/api/lp/launch/status": blind, "/api/fee-status": () => R }, { session, timers: [] });
    assert.equal(q.card.querySelector(".lp-fees").hidden, false);
    assert.ok(rowsOf(q.card.querySelector(".lp-fees"))[1][3].startsWith(`${taken} from the chain`));
  }
  // a status with figures but no counters hides every reading, as before, with or without a mark
  const nc = { ...LAUNCHED, founderFees: { ...LAUNCHED.founderFees, earnedLamports: null, collectedLamports: null } }, t2 = [];
  const n = await dashboard({ "/api/lp/launch/status": nc, "/api/fee-status": () => R }, { session: new Map([["lp-collected-slot", JSON.stringify({ slots: {}, unclear: { [MINT]: Date.now() } })]]), timers: t2 });
  assert.deepEqual([n.card.querySelector(".lp-fees").hidden, n.oldLine().hidden, t2.length], [true, false, 0]);
});

test("founder card on a page Back brings back as the browser kept it, after a Collect of the coin on a later page of the tab that landed with no slot given: the figures go at once, and when the status read again cannot read its fees, the edge's copy from before the Collect is not drawn again", async () => {
  // the recheck's probe (back-noslot): hush() cleared the card, then again() drew the same reading from before the Collect because
  // the new status's founderFees was null
  const R = answerOf("graduated", READ_AT, 100), taken = sol(R.founder.claimable);
  const before = statusNow({ inVault: R.founder.claimable, onCurve: "0", earned: R.founder.earned, collected: R.founder.collected, slot: 100 });
  const session = new Map(), timers = [];
  let st = before;
  // the viewer's clock is this test's (the fixture day): the page's own would be today's, and the Collect's moment below would then be
  // days before it, its wait long over (this test failed from 21 Oct on)
  const p = await dashboard({ "/api/lp/launch/status": () => st, "/api/fee-status": () => R }, { session, timers, now: Date.now() });
  assert.deepEqual([p.card.querySelector(".lp-fees").hidden, p.btn("Collect your fees").hidden], [false, false]);
  // the later page's Collect landed with no slot given: that page kept only the moment (noteUnclear); the status now cannot read its fees
  session.set("lp-collected-slot", JSON.stringify({ slots: {}, unclear: { [MINT]: Date.now() } }));
  st = { ...LAUNCHED, founderFees: null };
  pageshow(p.win);
  const box = p.card.querySelector(".lp-fees");
  assert.deepEqual([box.hidden, box.children.length, p.oldLine().hidden, p.btn("Collect your fees").hidden], [true, 0, true, true], "at once");
  await tick();
  // read again (the status and the fees), and nothing from before the Collect is drawn; nothing is asked again on this page
  const box2 = p.card.querySelector(".lp-fees");
  assert.deepEqual([box2.hidden, box2.children.length, p.btn("Collect your fees"), p.oldLine(), timers.length], [true, 0, null, null, 0]);
  assert.ok(!text(p.card).includes(taken));
  assert.equal(p.calls.filter((c) => c.path.startsWith("/api/fee-status")).length, 2);
});

test("founder card: the time words are drawn again when the tab is seen again (a day may have passed: '14:05' becomes '14:05 on 20 Oct'); nothing else changes, a hidden tab draws nothing, and a card whose figures went meanwhile stays empty", async () => {
  const A = answerOf("graduated"), t1 = Date.parse(READ_AT) + 60000, t2 = t1 + 86400000;
  const claim = { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" };
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": () => A, "/api/lp/founder-claim/tx": claim }, { now: t1, timers: [], session: new Map() });
  const box = p.card.querySelector(".lp-fees"), doc = p.page.doc;
  const seen = (state) => { doc.visibilityState = state; dispatch(doc, newEvent("visibilitychange", { bubbles: false }), p.win); };
  assert.ok(!when(READ_AT, t1).includes(" on ") && when(READ_AT, t2).includes(" on "), "today, then another day, in this clock");
  const first = rowsOf(box);
  assert.ok(first[1].every((dd) => !dd.includes(" on ")) && first[1][0].includes(`from the chain at ${when(READ_AT, t1)} · `));
  vm.runInContext(`Date.now = () => ${t2}`, p.win);
  seen("hidden");
  assert.deepEqual(rowsOf(box), first, "nothing is drawn while the tab is hidden");
  seen("visible");
  const [labels, dds] = rowsOf(box);
  assert.deepEqual(labels, first[0]);
  assert.deepEqual(dds, first[1].map((dd) => dd.split(`from the chain at ${when(READ_AT, t1)} · `).join(`from the chain at ${when(READ_AT, t2)} · `)));
  assert.ok(dds.filter((dd) => dd.includes(` on ${new Date(Date.parse(READ_AT)).getDate()} Oct`)).length >= 5, JSON.stringify(dds));
  assert.equal(box.querySelector(".lp-fees__src").getAttribute("title"), `Read from the chain at ${READ_AT}`);
  // a Collect landed: the figures went; seeing the tab again does not bring them back
  p.btn("Collect your fees").click();
  await tick();
  p.btn("Approve in your wallet").click();
  await tick();
  const now = p.card.querySelector(".lp-fees");
  assert.deepEqual([now.hidden, now.children.length], [true, 0]);
  seen("visible");
  assert.deepEqual([now.hidden, now.children.length, box.hidden], [true, 0, true]);
});

test("founder card: what this tab keeps after its Collects (sessionStorage, one key): chain slots and the viewer's clock time of a Collect whose outcome the page could not tell, by coin, at most 20 coins each, the newest kept; anything else there reads as nothing", async () => {
  const { keptOf } = p0().LPLaunch.pure;
  const K = (o) => JSON.stringify(o);
  assert.deepEqual(JSON.parse(JSON.stringify(keptOf(K({ slots: { [MINT]: 150 }, unclear: { [addr(61)]: 1_760_000_000_000 } })))), { slots: { [MINT]: 150 }, unclear: { [addr(61)]: 1_760_000_000_000 } });
  for (const bad of [null, "", "not json", "[1]", K({ slots: 5, unclear: "x" }), K({ slots: { [MINT]: "150" }, unclear: { [MINT]: -1 } }), K({ slots: { x: 150, __proto__: 1 }, unclear: { [MINT]: 1.5 } })]) {
    assert.deepEqual(JSON.parse(JSON.stringify(keptOf(bad))), { slots: {}, unclear: {} }, String(bad));
  }
  // an unclear Collect with 20 other coins kept: the oldest note goes, this coin's is the newest, the slots are left as they were
  const others = Array.from({ length: 20 }, (_, i) => uniq(1000 + i));
  const session = new Map([["lp-collected-slot", K({ slots: { [addr(61)]: 77 }, unclear: Object.fromEntries(others.map((m, i) => [m, 1_000 + i])) })]]);
  const claim = { ok: true, step: "founder-claim", cluster: "devnet", tx: "AA==" };
  const p = await dashboard({ "/api/lp/launch/status": LAUNCHED, "/api/fee-status": answerOf("graduated", READ_AT, 100), "/api/lp/founder-claim/tx": claim },
    { session, timers: [], sign: async () => { throw Object.assign(new Error("words"), { code: "wallet_send_unclear", unclear: true }); } });
  p.btn("Collect your fees").click();
  await tick();
  p.btn("Approve in your wallet").click();
  await tick();
  const kept = JSON.parse(session.get("lp-collected-slot"));
  assert.deepEqual(kept.slots, { [addr(61)]: 77 });
  assert.deepEqual(Object.keys(kept.unclear), [...others.slice(1), MINT], "at most 20 coins, the newest last");
});

/* ---------------------------------------------------------------- the coin page */

const COIN_JS = read("public/coin.js"), COIN_HTML = read("public/coin.html");
const coinAnswer = ({ kind = "city" } = {}) => ({
  ok: true, asOf: new Date().toISOString(), mint: MINT,
  coin: { kind, ticker: kind === "vicinity" ? "VICINITY" : "FEE", name: kind === "vicinity" ? "Vicinity" : "Fee City", city: kind === "vicinity" ? null : { name: "Fee City", country: "US" }, pair: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" }, color: "gold", logo: null },
  facts: null, holders: null, trades: { rows: [] }, samples: [],
  market: kind === "vicinity" ? { launchpad: null, curve: null, lpCurve: null, sources: {}, missing: {} } : { launchpad: "vicinity", curve: null, lpCurve: { stage: "curve", symbol: "SOL", raised: 21.25, target: 85, progressPct: 25, pool: MINT }, sources: {}, missing: {} },
  links: { raydium: null, jupiter: null, dexscreener: null, solscan: `https://solscan.io/token/${MINT}`, here: `/coin?mint=${MINT}` },
});
/** The built coin page with the real coin.js; `status(n)` is what /api/fee-status answers the n-th time; `now`: the page's clock (ms). */
async function coinPage({ status = () => answerOf("forwarded"), coin = coinAnswer(), session = null, now = null } = {}) {
  const page = await openPage("coin.html", { agreed: "2026-10-01" });
  const win = page.window;
  if (now !== null) setNow(win, now);
  // this tab's sessionStorage (what the dashboard's Collect wrote: public/lp-launch.js noteCollected), or "refused"
  if (session === "refused") Object.defineProperty(win, "sessionStorage", { get() { throw new Error("SecurityError"); } });
  else if (session) win.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => { session.set(k, String(v)); }, removeItem: (k) => { session.delete(k); } };
  const timers = [];
  win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  win.clearTimeout = () => {}; win.setInterval = () => 0;
  win.location = { href: `https://vicinity.city/coin?mint=${MINT}`, pathname: "/coin", search: `?mint=${MINT}` };
  win.history = { replaceState() {} };
  win.Intl = Intl;
  const calls = [];
  let n = 0;
  win.fetch = async (path) => {
    const p = String(path).split("?")[0];
    calls.push(String(path));
    const body = p === "/api/coin" ? coin : p === "/api/fee-status" ? status(n++) : p === "/api/official" ? { ok: true, swap: true } : { ok: false, error: "not_found" };
    const code = body && body._code ? body._code : body && body.ok === false ? 503 : 200;
    return { ok: code < 400, status: code, json: async () => body };
  };
  win.V.official = Promise.resolve({ ok: true, swap: true, cityCoins: { cluster: "devnet" } });
  win.VSwap = { open() {} };
  const chart = new Proxy({}, { get: () => () => undefined });
  win.VChart = { create: () => chart, pure: { INTERVALS: {} } };
  vm.runInContext(COIN_JS, win, { filename: "public/coin.js" });
  await tick(40);
  const refresh = async () => { const due = timers.splice(0); for (const fn of due) fn(); await tick(40); };
  return { page, win, calls, refresh, asked: () => n, pageNow: () => vm.runInContext("Date.now()", win) };
}
/** Set the page's clock (the viewer's: Date.now() inside the page) to `ms`. */
const setNow = (win, ms) => vm.runInContext(`Date.now = () => ${ms}`, win);
const SENTENCE = "Holder reward rounds are not on the site yet and are not a promise (see the Terms).";
const S4 = (a) => `${a.slice(0, 4)}…\u2060${a.slice(-4)}`;

test("coin page: 'Fees so far' under the Fees section: moved to the city's accounts, still in the curve, the founder's part (earned, collected), the holders' part (earned, the pot, and what was moved to the rewards vault: the record's counter), each with its account and the time; the one sentence; nothing about payouts to come", async () => {
  const A = answerOf("forwarded"), acc = A.source.accounts;
  const p = await coinPage();
  const at = when(READ_AT, p.pageNow(), "\u00a0"), from = (what) => ` from the chain at\u00a0${at} · ${what}`, solN = (raw) => sol(raw, "\u00a0");
  const box = p.page.$("#coin-sofar");
  assert.equal(box.hidden, false);
  assert.equal(text(p.page.$("#coin-sofar-title")), "Fees so far");
  assert.deepEqual(box.querySelectorAll("dt").map(text), ["Moved to the city's accounts so far", "Still in the curve", "The founder's part", "The holders' part"]);
  assert.deepEqual(box.querySelectorAll("dd").map((dd) => dd.textContent), [
    `${solN(A.city.harvested)}${from(`coin record ${S4(acc.coin)}`)}`,
    `${solN(A.city.pendingInPool)}${from(`the coin's curve ${S4(acc.dbcPool)}`)}`, // 0: no word about a harvest that has nothing to move
    // a stranger's gift to the vault left with the claim (litesvm TQ02): collected is more than earned, and the row says why
    `${solN(A.founder.earned)} earned, ${solN(A.founder.collected)} collected (more than earned: it includes extra someone sent straight to the fee vault)${from(`coin record ${S4(acc.coin)}`)}`,
    // what moved to the rewards vault is a counter since launch ("so far"), never called kept: rounds can pay out of that vault
    `${solN(A.holders.earned)} booked for holders; kept on chain: ${solN(A.holders.pot)} in the city's holder pot; ${solN(A.holders.forwarded)} moved to the city's rewards vault so far${from(`coin record ${S4(acc.coin)}, holder pot ${S4(acc.holdersPot)}`)}`,
  ]);
  // the two parts add up to what moved to the city's accounts
  assert.equal(BigInt(A.founder.earned) + BigInt(A.holders.earned), BigInt(A.city.harvested));
  assert.equal(box.querySelector(".coin-sofar__src").getAttribute("title"), `Read from the chain at ${READ_AT}`);
  assert.equal(text(p.page.$("#coin-sofar-note")), SENTENCE);
  assert.equal(p.page.$("#coin-sofar-note").querySelector("a").getAttribute("href"), "/terms#s5");
  assert.doesNotMatch(text(box), /will|payout|earn rewards|APY|yield|soon/i, "nothing about payouts to come");
  assert.equal(p.calls.find((c) => c.startsWith("/api/fee-status")), `/api/fee-status?mint=${MINT}`);
  // the place: right under the Fees card, hidden until the answer is here
  assert.match(COIN_HTML, /id="coin-fees-src"><\/p>\s*<\/section>\s*<!--[^>]*-->\s*<section class="card coin-sofar" id="coin-sofar" aria-labelledby="coin-sofar-title" hidden>/);
  // not forwarded yet: the pot alone, nothing about the rewards vault
  const h = await coinPage({ status: () => answerOf("harvested") });
  const H = answerOf("harvested");
  // nothing collected yet: no word about more than earned
  assert.ok(BigInt(H.founder.collected) <= BigInt(H.founder.earned));
  assert.equal(h.page.$("#coin-sofar").querySelectorAll("dd")[2].textContent, `${solN(H.founder.earned)} earned, ${solN(H.founder.collected)} collected${from(`coin record ${S4(acc.coin)}`)}`);
  assert.equal(h.page.$("#coin-sofar").querySelectorAll("dd")[3].textContent, `${solN(H.holders.earned)} booked for holders; kept on chain: ${solN(H.holders.pot)} in the city's holder pot${from(`coin record ${S4(acc.coin)}, holder pot ${S4(acc.holdersPot)}`)}`);
  // a forward moves the whole holder pot (forward_holders_fees.rs:83), so what someone sent straight to the pot went with it: moved
  // to the rewards vault is then more than was booked for holders, and the row says why (as the founder's part does); equal: no word
  assert.equal(A.holders.forwarded, A.holders.earned);
  const potGift = { ...A, holders: { ...A.holders, forwarded: String(BigInt(A.holders.earned) + 1000n) } };
  const pg = await coinPage({ status: () => potGift });
  assert.equal(pg.page.$("#coin-sofar").querySelectorAll("dd")[3].textContent, `${solN(A.holders.earned)} booked for holders; kept on chain: ${solN(A.holders.pot)} in the city's holder pot; ${solN(potGift.holders.forwarded)} moved to the city's rewards vault so far (more than booked: it includes extra someone sent straight to the holder pot)${from(`coin record ${S4(acc.coin)}, holder pot ${S4(acc.holdersPot)}`)}`);
  assert.doesNotMatch(box.querySelectorAll("dd")[3].textContent, /more than booked/);
  // the rewards vault's own balance is never shown as fee money (anyone can add to it; rounds take from it)
  const gift = { ...A, holders: { ...A.holders, vault: { ...A.holders.vault, balance: "987654321" } } };
  const g = await coinPage({ status: () => gift });
  assert.ok(!g.page.$("#coin-sofar").textContent.includes(sol("987654321", "\u00a0")));
  // the 30-second refresh does not ask again within the minute; a minute later it does
  await p.refresh();
  assert.equal(p.asked(), 1);
  vm.runInContext("Date.now = (() => { const t0 = Date.now(); return () => t0 + 61000; })()", p.win);
  await p.refresh();
  assert.equal(p.asked(), 2);
});

test("coin page, graduated: still in the pool names the curve, the pool and the city's position; paid out is named with collected", async () => {
  const G = answerOf("graduated"), acc = G.source.accounts;
  const p = await coinPage({ status: () => ({ ...G, founder: { ...G.founder, paidOut: "5000", collected: String(BigInt(G.founder.collected) + 5000n) } }) });
  const at = when(READ_AT, p.pageNow(), "\u00a0");
  const box = p.page.$("#coin-sofar");
  assert.deepEqual(box.querySelectorAll("dt").map(text), ["Moved to the city's accounts so far", "Still in the pool", "The founder's part", "The holders' part"]);
  const dds = box.querySelectorAll("dd").map((dd) => dd.textContent);
  assert.equal(dds[1], `${sol(G.city.pendingInPool, "\u00a0")} (it moves to the city's accounts when someone runs a harvest; anyone can) from the chain at\u00a0${at} · the coin's curve ${S4(acc.dbcPool)}, its pool ${S4(acc.dammPool)} and the city's position ${S4(acc.positions[0])}`);
  assert.match(dds[2], / collected or paid out from the chain/);
  // the curve not harvested yet: its figure includes the completion surplus, so the price-curve settings are named too; two positions
  // (one given to the record in another of its accounts) are both named
  const C = answerOf("graduated, curve not harvested");
  assert.ok(BigInt(C.pool.surplus) > 0n);
  const q = await coinPage({ status: () => C });
  // that figure holds the curve's fees and its completion surplus too: the label says so (with or without the estimate); the pool alone
  // once the curve is harvested
  const { soFarView } = q.win.VCoin.pure;
  const stillOf = (x) => soFarView(x, MINT, q.pageNow()).rows[1];
  assert.equal(q.page.$("#coin-sofar").querySelectorAll("dt")[1].textContent, "Still in the curve and the pool");
  assert.deepEqual(JSON.parse(JSON.stringify([stillOf(withheldOf(C)).slice(0, 2), stillOf(G)[0], stillOf({ ...G, pool: { ...G.pool, curve: "5" } })[0], stillOf({ ...G, pool: { ...G.pool, surplus: "1" } })[0], stillOf(answerOf("curve again"))[0]])),
    [["Still in the curve and the pool", "can't be worked out right now"], "Still in the pool", "Still in the curve and the pool", "Still in the curve and the pool", "Still in the curve"]);
  assert.equal(soFarView({ ...G, pool: { ...G.pool, curve: "x" } }, MINT, q.pageNow()), null, "the curve's figure must be one");
  assert.equal(q.page.$("#coin-sofar").querySelectorAll("dd")[1].textContent.split(" from the chain at ")[1].split(" · ")[1],
    `the coin's curve ${S4(acc.dbcPool)}, its price-curve settings ${S4(acc.dbcConfig)}, its pool ${S4(acc.dammPool)} and the city's position ${S4(C.source.accounts.positions[0])}`);
  const T = answerOf("position given");
  const t = await coinPage({ status: () => T });
  assert.ok(t.page.$("#coin-sofar").querySelectorAll("dd")[1].textContent.endsWith(`its pool ${S4(acc.dammPool)} and the city's positions ${T.source.accounts.positions.map(S4).join(", ")}`));
  // the city's positions in another pool of the pair too: the row names that pool and says "the pools"
  const O = { ...G, source: { ...G.source, accounts: { ...acc, otherDammPools: [addr(41)], positions: [...acc.positions, addr(42)] } } };
  const o = await coinPage({ status: () => O });
  assert.equal(o.page.$("#coin-sofar").querySelectorAll("dt")[1].textContent, "Still in the pools");
  assert.ok(o.page.$("#coin-sofar").querySelectorAll("dd")[1].textContent.endsWith(`its pool ${S4(acc.dammPool)}, pool ${S4(addr(41))} and the city's positions ${S4(acc.positions[0])}, ${S4(addr(42))}`));
  assert.deepEqual(JSON.parse(JSON.stringify([stillOf({ ...O, pool: { ...O.pool, curve: "5" } })[0], stillOf(withheldOf(O))[0]])), ["Still in the curve and the pools", "Still in the pool"]);
});

test("coin page, graduated, the pool estimate withheld by the server: still in the pool can't be worked out right now (no figure, no source); what moved, the founder's part and the holders' part stay", async () => {
  const G = answerOf("graduated"), acc = G.source.accounts;
  const p = await coinPage({ status: () => withheldOf(G) });
  const at = when(READ_AT, p.pageNow(), " ");
  const box = p.page.$("#coin-sofar");
  assert.equal(box.hidden, false);
  assert.deepEqual(box.querySelectorAll("dt").map(text), ["Moved to the city's accounts so far", "Still in the pool", "The founder's part", "The holders' part"]);
  const dds = box.querySelectorAll("dd").map((dd) => dd.textContent);
  assert.equal(dds[0], `${sol(G.city.harvested, " ")} from the chain at ${at} · coin record ${S4(acc.coin)}`);
  assert.equal(dds[1], "can't be worked out right now");
  assert.match(dds[3], / booked for holders; kept on chain: /);
  assert.equal(box.querySelectorAll(".coin-sofar__src").length, 3);
});

test("coin page: hidden when the coin is not official (404), the read fails (503, offline), the answer is about another coin, a figure cannot be written; for $VICINITY not even asked; a later failure hides it again", async () => {
  const F = answerOf("forwarded");
  for (const bad of [{ ok: false, error: "not_official", _code: 404 }, { ok: false, error: "rpc_unavailable" }, undefined, { ...F, mint: addr(3) },
    { ...F, city: { ...F.city, harvested: "1.5" } }, { ...F, city: { ...F.city, pendingInPool: null } }, { ...F, holders: { ...F.holders, earned: "x" } }, { ...F, coin: { ...F.coin, quote: null } },
    // graduated must be a boolean; the estimate whole, or withheld only after graduation; every account a figure rests on an address
    { ...F, coin: { ...F.coin, graduated: 1 } }, { ...F, pool: { ...F.pool, estimate: undefined } }, withheldOf(F), { ...withheldOf(answerOf("graduated")), city: { ...withheldOf(answerOf("graduated")).city, pendingInPool: "5" } },
    ...["coin", "holdersPot", "dbcPool", "dbcConfig"].map((k) => ({ ...F, source: { ...F.source, accounts: { ...F.source.accounts, [k]: "x" } } })),
    ...[{ dammPool: null }, { positions: ["x"] }, { positions: [] }, { otherDammPools: null }, { otherDammPools: ["x"] }].map((o) => ({ ...answerOf("graduated"), source: { ...answerOf("graduated").source, accounts: { ...answerOf("graduated").source.accounts, ...o } } }))]) {
    const p = await coinPage({ status: () => bad });
    assert.deepEqual([p.page.$("#coin-sofar").hidden, p.page.$("#coin-sofar-list").children.length], [true, 0], JSON.stringify(bad));
  }
  const vic = await coinPage({ coin: coinAnswer({ kind: "vicinity" }) });
  assert.equal(vic.page.$("#coin-sofar").hidden, true);
  assert.equal(vic.calls.some((c) => c.startsWith("/api/fee-status")), false, "not even asked");
  // shown, then the next reading a minute later fails: hidden again (no figure is left that was not just read)
  const p = await coinPage({ status: (n) => (n === 0 ? answerOf("forwarded") : { ok: false, error: "rpc_unavailable" }) });
  assert.equal(p.page.$("#coin-sofar").hidden, false);
  vm.runInContext("Date.now = (() => { const t0 = Date.now(); return () => t0 + 61000; })()", p.win);
  await p.refresh();
  assert.deepEqual([p.asked(), p.page.$("#coin-sofar").hidden, p.page.$("#coin-sofar-list").children.length], [2, true, 0]);
});

test("coin page: never a reading older than this tab's last Collect of the coin on the dashboard (the slot lp-launch.js keeps in sessionStorage, by coin); one at that slot or later shows; another coin's Collect, no Collect or storage refused change nothing; no slot, no block", async () => {
  const session = new Map([["lp-collected-slot", JSON.stringify({ slots: { [MINT]: 150 }, unclear: {} })]]);
  let slot = 149;
  const p = await coinPage({ status: () => answerOf("forwarded", READ_AT, slot), session });
  assert.deepEqual([p.page.$("#coin-sofar").hidden, p.page.$("#coin-sofar-list").children.length], [true, 0], "the reading from before the Collect is not shown");
  slot = 150;
  vm.runInContext("Date.now = (() => { const t0 = Date.now(); return () => t0 + 61000; })()", p.win);
  await p.refresh();
  assert.deepEqual([p.asked(), p.page.$("#coin-sofar").hidden], [2, false], "a reading at the Collect's slot is shown");
  for (const s of [new Map([["lp-collected-slot", JSON.stringify({ slots: { [addr(61)]: 10 ** 9 }, unclear: {} })]]), new Map(), new Map([["lp-collected-slot", "not json"]]), "refused"]) {
    const q = await coinPage({ status: () => answerOf("forwarded", READ_AT, 1), session: s });
    assert.equal(q.page.$("#coin-sofar").hidden, false, String(s instanceof Map ? JSON.stringify([...s]) : s));
  }
  const { soFarView } = p.win.VCoin.pure;
  const A = answerOf("forwarded", READ_AT, 7);
  assert.deepEqual([soFarView(A, MINT, Date.now(), 0) !== null, soFarView(A, MINT, Date.now(), 7) !== null, soFarView(A, MINT, Date.now(), 8), soFarView({ ...A, source: { ...A.source, slot: null } }, MINT)],
    [true, true, null, null]);
});

test("coin page: after a Collect on the dashboard in this tab whose outcome it could not tell, no 'Fees so far' of that coin for 5 minutes by the viewer's own clock (and none while that clock reads earlier than that moment); another coin's, no mark, or anything else kept there change nothing", async () => {
  const T = Date.parse("2026-10-20T15:00:00Z"), K = (o) => new Map([["lp-collected-slot", JSON.stringify(o)]]);
  const marked = () => K({ slots: {}, unclear: { [MINT]: T } });
  const shown = async (now, session) => { const p = await coinPage({ status: () => answerOf("forwarded", READ_AT, 20), session, now }); return [p.page.$("#coin-sofar").hidden, p.page.$("#coin-sofar-list").children.length]; };
  assert.deepEqual(await shown(T, marked()), [true, 0], "at that moment");
  assert.deepEqual(await shown(T + 299_999, marked()), [true, 0], "inside the 5 minutes");
  assert.deepEqual(await shown(T - 1, marked()), [true, 0], "the clock moved back before that moment");
  assert.deepEqual(await shown(T - 86_400_000, marked()), [true, 0], "a day back");
  assert.equal((await shown(T + 300_000, marked()))[0], false, "after the 5 minutes");
  // another coin's mark, no mark; and storage that is not the dashboard's shape (only lp-launch.js writes it, always in that shape)
  for (const s of [K({ slots: {}, unclear: { [addr(61)]: T } }), new Map(), K({ unclear: { [MINT]: String(T) } }), K({ unclear: { [MINT]: -T } }), K({ unclear: [T] }), K({ [MINT]: T }), new Map([["lp-collected-slot", "not json"]]), "refused"]) {
    assert.equal((await shown(T + 1, s))[0], false, String(s instanceof Map ? JSON.stringify([...s]) : s));
  }
  // the rule itself
  const { unclearWait, UNCLEAR_MS, soFarView } = (await coinPage()).win.VCoin.pure;
  assert.equal(UNCLEAR_MS, 300000);
  assert.deepEqual([unclearWait(0, T), unclearWait(T, T), unclearWait(T, T + 299_999), unclearWait(T, T + 300_000), unclearWait(T, T - 1)], [false, true, true, false, true]);
  const A = answerOf("forwarded", READ_AT, 7);
  assert.deepEqual([soFarView(A, MINT, T + 10, 0, T) === null, soFarView(A, MINT, T + 300_000, 0, T) === null, soFarView(A, MINT, T + 10, 0, 0) === null], [true, false, false]);
});

test("the dashboard card and the coin page wait the same after a Collect in the tab whose outcome was unclear or that landed with no slot given: one UNCLEAR_MS, one rule (the viewer's clock against itself; a clock moved back waits too); with the same mark and no status counters, neither shows a reading of the coin", async () => {
  const L = p0().LPLaunch.pure, c = await coinPage(), C = c.win.VCoin.pure;
  assert.equal(L.UNCLEAR_MS, C.UNCLEAR_MS);
  assert.equal(L.UNCLEAR_MS, 300000);
  const at = 1_760_000_000_000;
  for (const [mark, now] of [[0, at], [at, at], [at, at + 299999], [at, at + 300000], [at, at - 1], [at, at - 10 ** 9], [at, at + 10 ** 9]]) {
    assert.equal(L.unclearWait(mark, now), C.unclearWait(mark, now), `${mark} ${now}`);
  }
  assert.deepEqual([at + 299999, at + 300000, at - 1].map((n) => L.unclearWait(at, n)), [true, false, true]);
  // the same tab, a Collect of the coin landed on the dashboard with no slot given half a minute ago: the dashboard card whose status
  // could not read its fees and the coin page both show nothing of the coin's fees from the edge's copy
  // (the viewer's clock is this test's, half a minute after that Collect: the pages' own would be today's, days after the fixture day)
  const R = answerOf("graduated", READ_AT, 100), mark = Date.now() - 30000;
  const session = new Map([["lp-collected-slot", JSON.stringify({ slots: {}, unclear: { [MINT]: mark } })]]);
  const d = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, founderFees: null }, "/api/fee-status": () => R }, { session, timers: [], now: mark + 30000 });
  const k = await coinPage({ status: () => R, session, now: mark + 30000 });
  assert.deepEqual([d.card.querySelector(".lp-fees").hidden, k.page.$("#coin-sofar").hidden], [true, true]);
  // after the wait both show the reading (by then any copy at the edge or a server is from after that Collect)
  const d2 = await dashboard({ "/api/lp/launch/status": { ...LAUNCHED, founderFees: null }, "/api/fee-status": () => R }, { session, timers: [], now: mark + 300000 });
  const k2 = await coinPage({ status: () => R, session, now: mark + 300000 });
  assert.deepEqual([d2.card.querySelector(".lp-fees").hidden, k2.page.$("#coin-sofar").hidden], [false, false]);
});

test("coin page: a mark of an unclear Collect that appears while the page is open (the tab came back to it) hides the block at the next refresh, and the reading from before it is not kept: after the wait only a reading asked again shows", async () => {
  const T = Date.parse("2026-10-20T15:00:00Z"), session = new Map();
  let release = null;
  const answers = [() => answerOf("forwarded", READ_AT, 20), () => new Promise((ok) => { release = ok; })];
  const p = await coinPage({ status: (n) => answers[n](), session, now: T });
  const box = p.page.$("#coin-sofar");
  assert.equal(box.hidden, false);
  session.set("lp-collected-slot", JSON.stringify({ slots: {}, unclear: { [MINT]: T + 5000 } }));
  setNow(p.win, T + 10_000);
  await p.refresh();
  assert.deepEqual([p.asked(), box.hidden, p.page.$("#coin-sofar-list").children.length], [1, true, 0], "hidden at once, nothing asked");
  // past the wait: asked again; until that answer is here, nothing (the reading from before the Collect is gone)
  setNow(p.win, T + 5000 + 300_000);
  await p.refresh();
  assert.deepEqual([p.asked(), box.hidden], [2, true]);
  release(answerOf("collected", READ_AT, 30));
  await tick(40);
  assert.equal(box.hidden, false);
  assert.ok(box.querySelectorAll("dd")[2].textContent.startsWith(sol(answerOf("collected").founder.earned, "\u00a0")));
});

test("coin page brought back by Back as the browser kept it, after a Collect of the coin on the dashboard in this tab (its slot in the tab's sessionStorage): the reading from before it goes at once, and the next refresh asks again within the minute; a reading at that slot stays; an unclear Collect's mark hides it at once too; another coin's Collect or a page loaded afresh change nothing", async () => {
  // the reviewer's probe: a reading at slot 20 (0.02 SOL still in the curve, 0.042179807 SOL collected), then the dashboard in this
  // tab notes a Collect at slot 30, then Back to this page
  const T = Date.parse("2026-10-20T15:00:00Z"), session = new Map();
  const R = answerOf("curve again", READ_AT, 20), K = answerOf("collected", READ_AT, 30);
  const answers = [() => R, () => answerOf("curve again", READ_AT, 25), () => K];
  const p = await coinPage({ status: (n) => answers[n](), session, now: T });
  const box = p.page.$("#coin-sofar"), list = p.page.$("#coin-sofar-list");
  const founderRow = () => box.querySelectorAll("dd")[2].textContent;
  assert.equal(box.hidden, false);
  assert.ok(founderRow().includes(`${sol(R.founder.collected, " ")} collected`));
  // another coin's Collect, or a page loaded afresh: nothing changes
  session.set("lp-collected-slot", JSON.stringify({ slots: { [addr(61)]: 10 ** 9 }, unclear: {} }));
  pageshow(p.win);
  pageshow(p.win, false);
  assert.deepEqual([box.hidden, p.asked()], [false, 1]);
  // this coin's Collect at slot 30, then Back: the reading from slot 20 goes at once, before any refresh
  session.set("lp-collected-slot", JSON.stringify({ slots: { [MINT]: 30 }, unclear: {} }));
  pageshow(p.win);
  assert.deepEqual([box.hidden, list.children.length, p.asked()], [true, 0, 1]);
  // the next refresh, 40 seconds after the last ask: asked again (not a minute later); the edge's copy from before the Collect (slot
  // 25) is not shown either, and the next ask is a minute after this one
  setNow(p.win, T + 40_000);
  await p.refresh();
  assert.deepEqual([p.asked(), box.hidden], [2, true]);
  setNow(p.win, T + 70_000);
  await p.refresh();
  assert.deepEqual([p.asked(), box.hidden], [2, true]);
  setNow(p.win, T + 100_000);
  await p.refresh();
  assert.deepEqual([p.asked(), box.hidden], [3, false]);
  assert.ok(founderRow().includes(`${sol(K.founder.collected, " ")} collected`), "the reading after the Collect");
  // Back again with nothing new: a reading at the Collect's slot stays
  pageshow(p.win);
  assert.equal(box.hidden, false);
  // an unclear Collect of the coin since: hidden at once too (not at the next refresh)
  session.set("lp-collected-slot", JSON.stringify({ slots: { [MINT]: 30 }, unclear: { [MINT]: T + 101_000 } }));
  setNow(p.win, T + 102_000);
  pageshow(p.win);
  assert.deepEqual([box.hidden, list.children.length, p.asked()], [true, 0, 3]);

  // without Back's pageshow (the page was not kept, or that event did not come): the refresh drops it and asks again at once
  const s2 = new Map();
  const q = await coinPage({ status: (n) => (n === 0 ? R : K), session: s2, now: T });
  assert.equal(q.page.$("#coin-sofar").hidden, false);
  s2.set("lp-collected-slot", JSON.stringify({ slots: { [MINT]: 30 }, unclear: {} }));
  setNow(q.win, T + 40_000);
  await q.refresh();
  assert.deepEqual([q.asked(), q.page.$("#coin-sofar").hidden], [2, false]);
  assert.ok(q.page.$("#coin-sofar").querySelectorAll("dd")[2].textContent.includes(`${sol(K.founder.collected, " ")} collected`));
});

test("coin page: only the answer to the last ask counts (a slow earlier one never replaces it), and a newer reading of the coin is never replaced by an older one; a failure still hides it", async () => {
  let release = null;
  const answers = [
    () => new Promise((ok) => { release = ok; }), // the first ask: slow
    () => answerOf("forwarded", READ_AT, 20),
    () => answerOf("traded", READ_AT, 15), // another server's copy, from an earlier slot
    () => ({ ok: false, error: "rpc_unavailable" }),
  ];
  const p = await coinPage({ status: (n) => answers[n]() });
  const box = p.page.$("#coin-sofar");
  assert.deepEqual([p.asked(), box.hidden], [1, true]);
  let t = 0;
  const later = async () => { t += 61000; vm.runInContext(`Date.now = (() => { const t0 = ${Date.now()}; return () => t0 + ${t}; })()`, p.win); await p.refresh(); };
  await later();
  assert.deepEqual([p.asked(), box.hidden], [2, false]);
  const F = answerOf("forwarded"), H = answerOf("traded");
  const shown = () => box.querySelectorAll("dd")[0].textContent;
  assert.ok(shown().startsWith(sol(F.city.harvested, " ")));
  assert.notEqual(F.city.harvested, H.city.harvested);
  // the first, slow answer arrives now: it is not shown
  release(answerOf("traded", READ_AT, 10));
  await tick(40);
  assert.ok(shown().startsWith(sol(F.city.harvested, " ")), "a slow earlier answer does not replace the newer one");
  // the next minute's answer is from an earlier slot than the one shown: the shown one stays
  await later();
  assert.equal(p.asked(), 3);
  assert.ok(shown().startsWith(sol(F.city.harvested, " ")), "an older reading does not replace a newer one");
  // a failure hides it, as before
  await later();
  assert.deepEqual([p.asked(), box.hidden, p.page.$("#coin-sofar-list").children.length], [4, true, 0]);
});
