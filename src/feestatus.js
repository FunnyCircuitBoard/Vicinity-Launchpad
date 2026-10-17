/**
 * The fees of one official city coin so far, read from the chain (only while lpSetup(env).on, src/cluster.js). Read-only: nothing
 * here builds, signs or sends anything.
 *
 *   feeStatus(env, mint)        { cluster, mint, coin, city, founder, holders, pool, source } with exact integer amounts (BigInt, raw
 *                               units of the coin's quote token: lamports for SOL), or null when the mint is not an official city
 *                               coin; throws when the exact figures could not be read clearly (the route answers 503). After
 *                               graduation the estimate of what is still in the pool alone can be withheld (pool.estimate
 *                               "unavailable", its figures null: see THE ESTIMATE below); everything else is then still there
 *   GET /api/fee-status?mint=   the same as JSON (amounts as decimal strings); public, counted by the public limiter on an edge-cache
 *                               miss (src/index.js), 200 kept 60 s at the edge and per server; 404 not_official; 503 on any unclear
 *                               reading of the exact figures (never zeros that look real)
 *
 * WHICH COIN: official coins only, by the official list's own rule (src/officialcoins.js officialCoins: our program's Coin record
 * ["coin", city id] names the mint and its pool, and that pool's creator is the record). The record the list names is read again
 * here and must still name the same mint, pool and price-curve config.
 *
 * WHERE EVERY NUMBER COMES FROM (the counters and balances that exist on chain today; file:line in this repository, Meteora's
 * sources at the pinned releases: DBC 0.2.2 = github.com/MeteoraAg/dynamic-bonding-curve 91e696e, DAMM v2 0.2.5 =
 * github.com/MeteoraAg/damm-v2 5398b5c):
 *   Coin record, ["coin", city id LE] (solana/programs/vicinity-launchpad/src/state.rs:83-112; offsets in src/sol/layout.js "Coin",
 *   decoded by src/sol/dbc.js decodeCoin). Its counters are the coin's, for its whole life: after transfer_founder they include what
 *   earlier founders earned and collected.
 *     founder            state.rs:86     the only wallet claim_founder_fees pays (claim_founder_fees.rs:26 has_one founder); changes
 *                                        only by transfer_founder                                        -> founder.wallet (masked)
 *     founder_accrued    state.rs:99     += the founder half at every harvest (instructions/mod.rs:119-122 book_harvest; the half is
 *                                        math.rs:14-19 split_fee: founder floor(c/2), holders the rest) -> founder.earned
 *     founder_claimed    state.rs:101    += the whole founder vault at every claim_founder_fees (claim_founder_fees.rs:58, 71-74)
 *                                                                                                        -> founder.claimed
 *     founder_paid_out   state.rs:103    += the whole founder vault at every opted-in payout (payout_founder_fees.rs:102, 116-118),
 *                                        sent to the one payout wallet of the launchpad settings (payout_founder_fees.rs:59-69), not
 *                                        to the founder; off while launchpad.payout_authority is zero        -> founder.paidOut
 *     holders_accrued    state.rs:95     += the holders half at every harvest (mod.rs:115-118)             -> holders.earned
 *     holders_forwarded  state.rs:97     += the whole pot at every forward_holders_fees (forward_holders_fees.rs:83, 96-99), which
 *                                        only runs for a Holders-only rewards config (math.rs:184-199)    -> holders.forwarded
 *     founder_accrued + holders_accrued  = everything the harvests booked for the city                    -> city.harvested
 *   Payout opt-in, ["payout_opt_in", coin] (constants.rs:89; state.rs:115-130 PayoutOptIn; opt_in_payout.rs needs the payout key and
 *   wallet set, so none can exist while payouts are off): a payout needs it AND its founder to be the record's founder
 *   (payout_founder_fees.rs:84-88). Absent = only the founder wallet can take the vault                -> founder.payoutAgreed
 *   (its address is named in source.accounts.payoutOptIn whether or not an account is there: the answer rests on it either way)
 *   Founder vault, ["founder_vault", coin] (constants.rs:87; created by launch.rs:89-96, token::authority = the Coin record), an SPL
 *   token account of the quote token: its amount is exactly what the next claim_founder_fees moves (claim_founder_fees.rs:58)
 *                                                                                                        -> founder.claimable
 *   Holders pot, ["holders_pot", coin] (constants.rs:85; launch.rs:79-86): its amount is what the next forward moves
 *   (forward_holders_fees.rs:83)                                                                         -> holders.pot
 *   (Tokens a stranger sends into the vault or the pot change no accrued counter (harvest_curve_fees.rs:11-13) but leave with the
 *   next claim or forward and are counted there: so "collected" can exceed "earned". Both are shown as the chain has them, and the
 *   pages then say that collected is more than earned and why.)
 *   DBC VirtualPool (the record's dbc_pool) and its PoolConfig (the record's dbc_config): what the next harvest_curve_fees claims
 *   into the pot, in one call, and splits ONCE (harvest_curve_fees.rs:107-187):
 *     creator_quote_fee (DBC state/virtual_pool.rs:146), the city's curve fees not yet harvested; claim_creator_trading_fee takes all
 *     of it (harvest_curve_fees.rs:113-135; DBC virtual_pool.rs:1103-1113, no graduation check)                     -> pool.curve
 *     the city's share of DBC's completion surplus, due once while quote_reserve >= migration_quote_threshold and
 *     is_creator_withdraw_surplus == 0 (harvest_curve_fees.rs:143-168, the same test as DBC's own: virtual_pool.rs:108, 134,
 *     1122-1124): floor(floor((quote_reserve - threshold) x 80 / 100) x creator_trading_fee_percentage / 100) (DBC
 *     virtual_pool.rs:1130-1159, config.rs:1184-1198, constants.rs:47 PARTNER_AND_CREATOR_SURPLUS_SHARE = 80)   -> pool.surplus
 *   (Not counted: creator_base_fee, the coin side, which our configs never charge (rule 7.2(4)) and which would land in the record's
 *   own coin account, never in the vault or the pot.)
 *   DAMM v2 positions after graduation (harvest_pool_fees.rs:105-179 claims one position into the pot and splits it): every
 *   position whose NFT the record holds, in a pool of this coin's pair (token A the coin, token B its quote token: the only pool check
 *   harvest_pool_fees.rs:107-112 makes, so a position someone gives the record in another pool of the pair pays the same city).
 *   "Holds" is exactly what harvest_pool_fees checks (harvest_pool_fees.rs:113-122 with math.rs:136-144 read_token_account_base;
 *   DAMM v2's claim_position_fee asks no more): ANY initialized Token-2022 account of the record holding exactly 1 of the position's
 *   NFT mint. A position NFT moves like any token (DAMM v2 ix_create_position.rs makes its mint without NonTransferable), so one given to
 *   the record lands in whatever account the giver picked, not only at DAMM v2's ["position_nft_account", mint] address. So every
 *   initialized Token-2022 account of the record holding exactly 1 of a mint is a candidate, and it is a position when DAMM v2's
 *   ["position", mint] account is a Position naming that mint (only DAMM v2's create_position writes there, and it makes the mint
 *   with a supply of 1). What the record holds never leaves and never changes: moving the NFT, adding or removing liquidity and
 *   naming a delegate all need the holder's signature (DAMM v2 state/position.rs:544-612 assert_authority), and the record never
 *   gives one. So a position with no liquidity and nothing pending (create_position needs no signature from its owner: anyone can
 *   make empty ones for the record) can never earn anything and is left out. Each position's figure is DAMM v2's own
 *   Position::update_fee (state/position.rs:245-270, 651-666; instructions/ix_claim_position_fee.rs:95): fee_b_pending +
 *   (pool.fee_b_per_liquidity - fee_b_per_token_checkpoint) x (unlocked + vested + permanently locked liquidity) >> 128, the
 *   difference wrapping in 256 bits, the result capped at 2^64-1 (unclaimedFeeB below, fed the Pool and Position bytes:
 *   src/sol/layout.js "DammPool", "DammPosition"). Only token B (the quote token) counts: a token-A fee lands in the record's own
 *   coin account, never in the vault or the pot. The coin's own pool (src/sol/lpadmin-ix.js canonicalPool, made by the graduation
 *   with the city's position: 50% of the liquidity, locked for good, solana/sdk/launchpad/config.mjs) must take its fees in token B
 *   only (collect_fee_mode 1, OnlyB), as our configs set it.                                       -> pool.positions
 *   Every harvest instruction splits what it claimed by itself, so the founder's part still in the pool is
 *   floor((curve + surplus) / 2) plus floor(x / 2) for each position, and the holders' part is the rest     -> *.pendingInPool
 *   The city's vicinity_rewards config, ["city", mint] under LAUNCHPAD_REWARDS_PROGRAM_ID, and its vault ["vault", config]
 *   (solana/programs/vicinity-rewards/src/state.rs:47-101; the vault field state.rs:61; decoded by src/lpadmin.js decodeCityConfig):
 *   absent until an admin sets holder rewards up for the city (then holders.vault is null; so is an address that only holds SOL
 *   someone sent it, which init_city takes over later). When present and its reward token is the coin's quote token, the vault's
 *   balance (an SPL token account of that token) -> holders.vault. That balance is not fee money alone: any funder can add to it and
 *   reward rounds take from it. What the fees put there is holders.forwarded (the record's counter).
 *   Holder reward rounds (fund_epoch_from_vault, claim) are not on the website and are not a promise (Terms, section 5): nothing here
 *   says anything about them.
 *
 * HOW IT IS READ: the official list first (kept 1 minute per server by src/officialcoins.js); then the node's genesis hash must be
 * the cluster's, asked for this reading (src/lpkit.js checkGenesis with `pin`), and every later call goes to the node that answered,
 * and to it alone (never a failover to a node nobody checked). Every number comes from ONE getMultipleAccounts answer, at one slot:
 * the Coin record, the founder vault, the holders pot, the DBC pool and its config, the payout opt-in, the rewards config and its
 * vault. A graduated coin also needs its positions: one getTokenAccountsByOwner on the Coin record (Token-2022; an answer over
 * MAX_TOKEN_BYTES is never read), the ["position", mint] account of every mint the record holds exactly 1 of (100 per
 * getMultipleAccounts), the pools of the ones that hold something outside the coin's own pool; then a last getMultipleAccounts reads
 * everything again with the pools, the positions and the record's accounts that hold their NFTs, and every number comes from that
 * last answer alone; then one more getTokenAccountsByOwner at that answer's slot or later says no position of this pair came to the
 * record between the listing and the last answer (when a new mint is there, its Position and pool are read to know). Each answer is at
 * the slot of the one before it or later, and at the slot of this server's last whole reading of the coin or later (minContextSlot),
 * so a node that lags behind never shows lower counters than were shown already.
 * THE EXACT FIGURES (the record's counters, the vault, the pot, the curve's figures, the rewards vault) fail the whole reading when
 * anything they rest on is unclear (503, never zeros, never a partial answer): a node of another network, an answer short or not
 * whole or older than asked, a Coin record that is absent or no longer names the mint and pool, a vault or pot that is not the
 * record's SPL token account of its quote token, a pool that is not DBC's pool of that mint and creator or a config that does not
 * decode, an opt-in that does not decode, a rewards config that is not the city's. None of these is anything a stranger can change.
 * THE ESTIMATE OF WHAT IS STILL IN THE POOL after graduation is the one figure that is withheld alone (pool.estimate "unavailable";
 * city, founder and holders pendingInPool, pool.positions and source.accounts positions and otherDammPools null; every exact figure
 * stays) when the positions cannot be read completely in bounded calls: more than MAX_TOKEN_ROWS Token-2022 accounts of the record,
 * a listing longer than MAX_TOKEN_BYTES or more than MAX_NFTS mints it holds exactly 1 of (anyone can send it tokens), a
 * getTokenAccountsByOwner row that is not a whole Token-2022 account of the record, a ["position", mint] account that is there but is
 * not a Position of that mint, two accounts of the record holding 1 of a position's mint, a pool that does not decode, no position in
 * the coin's own pool, the coin's own pool not OnlyB, more than MAX_POSITIONS positions that hold something, a position of this pair
 * given to the record between the listing and the last answer (positions_changed: the next reading counts it), or any of those calls
 * failing. So a stranger's spam can withhold that one estimate, never the rest. Before graduation the estimate is the curve's own
 * figures: exact, read with the rest. (A DAMM v2 position someone gives the record before graduation, in a pool of the pair made by
 * hand, could already be harvested; it is not counted then, and the pages call that row "still in the curve", which it is.)
 * A whole reading is kept 60 seconds per server, a failed one 15 seconds (so a reading that stays unclear costs the node little);
 * src/index.js keeps a 200 at the edge 60 seconds.
 */
import { json } from "./http.js";
import { base58Encode, isSolanaAddress } from "./solana.js";
import { codeOf } from "./sources.js";
import { lpSetup } from "./cluster.js";
import { checkGenesis, lpRoute, lpRpc, wholeAccount } from "./lpkit.js";
import { officialCoins } from "./officialcoins.js";
import { rpcTargets } from "./rpcpool.js";
import { decodeCityConfig } from "./lpadmin.js";
import { iso } from "./policy.js";
import { ADDRESSES, PROGRAM_IDS, launchpad as launchpadPdas } from "./sol/pda.js";
import { canonicalPool, damm, rewards as rewardsPdas } from "./sol/lpadmin-ix.js";
import { accountBytes, decodeCoin, decodeConfig, decodeDammPool, decodeDammPosition, decodePayoutOptIn, decodePool } from "./sol/dbc.js";
import { readU64 } from "./sol/bytes.js";

/** A whole reading is kept this long per server; the route's edge copy as long (src/index.js). */
export const READ_MS = 60_000;
/** A failed reading is kept this long per server (every request in that time answers 503 without asking the node again). */
export const FAIL_MS = 15_000;
export const EDGE_SECONDS = 60;
/**
 * At most this many positions that hold something are counted (the graduation makes one; more withhold the estimate). With the 8
 * accounts of every reading, the pools (at most one per position) and each position's NFT account, the last answer stays within 100
 * accounts.
 */
export const MAX_POSITIONS = 30;
/** At most this many Token-2022 accounts of the Coin record are looked at (more withhold the estimate). */
export const MAX_TOKEN_ROWS = 1000;
/**
 * A getTokenAccountsByOwner answer longer than this is never read (src/rpcpool.js maxBytes): it withholds the estimate. MAX_TOKEN_ROWS
 * rows are about 0.5 MB (an account a stranger can make for the record holds no more than its mint's extensions), so 2 MB is never
 * the limit for an answer that could be read, and a node answer of tens of MB (100 000 accounts anyone pays rent for) is never held in
 * the Worker's memory.
 */
export const MAX_TOKEN_BYTES = 2_000_000;
/** At most this many mints the record holds exactly 1 of are looked up as positions (two getMultipleAccounts; more withhold the estimate). */
export const MAX_NFTS = 200;
/** DBC constants.rs:47: the partner's and the creator's share of the completion surplus, in percent. */
const SURPLUS_SHARE = 80n;
/** DAMM v2 CollectFeeMode::OnlyB: every pool fee is taken in token B, the quote token. */
const ONLY_B = 1;
/** The quote tokens whose units the pages can name (others: amounts still exact, no unit, and the pages show nothing). */
const QUOTES = { [ADDRESSES.wsol]: { symbol: "SOL", decimals: 9 }, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 } };
const U64_MAX = (1n << 64n) - 1n, U256 = 1n << 256n;
const TOKEN_ACCOUNT_SIZE = 165;

let memo = new Map(); // "<cluster>|<program>|<mint>" -> { at, failed, promise }
const floors = new Map(); // the same key -> the slot of this server's last whole reading of that coin (never shown)
export const _resetFeeStatus = () => { memo = new Map(); floors.clear(); };

/** The reading cannot be a true picture of the chain: it fails as a whole (503). */
const broken = (why) => Object.assign(new Error(why), { code: why });
/** The founder wallet as the site's public answers show one (src/lpcoins.js /api/lp/coin): the first 5 and the last 3 characters. */
export const maskWallet = (w) => (typeof w === "string" && w.length > 8 ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);

/* ---------------------------------------------------------------- the math the programs do */
/** math.rs:14-19 split_fee: the founder gets floor(c / 2), the holders the rest. [toHolders, toFounder]. */
export const splitFee = (c) => [c - c / 2n, c / 2n];
/**
 * The city's share of DBC's completion surplus that the next harvest_curve_fees takes (0 until the curve is complete, and once
 * taken): `pool` from decodePool, `config` from decodeConfig. DBC 0.2.2 virtual_pool.rs:1122-1159 and config.rs:1184-1198.
 */
export function creatorSurplusDue(pool, config) {
  if (pool.quoteReserve < config.migrationQuoteThreshold || pool.isCreatorWithdrawSurplus !== 0) return 0n;
  const partnerAndCreator = ((pool.quoteReserve - config.migrationQuoteThreshold) * SURPLUS_SHARE) / 100n;
  return (partnerAndCreator * config.creatorTradingFeePercentage) / 100n;
}
/**
 * What DAMM v2's claim_position_fee would pay in token B for `position` in `pool` right now: Position::update_fee (DAMM v2 0.2.5
 * state/position.rs:245-270 and calculate_position_fee_or_reward at 651-666), then fee_b_pending.
 */
export function unclaimedFeeB(pool, position) {
  const liquidity = position.unlockedLiquidity + position.vestedLiquidity + position.permanentLockedLiquidity;
  let pending = position.feeBPending;
  if (liquidity > 0n) {
    const delta = (((pool.feeBPerLiquidity - position.feeBPerTokenCheckpoint) % U256) + U256) % U256; // U256 wrapping_sub
    let add = (liquidity * delta) >> 128n; // LIQUIDITY_SCALE
    if (add > U64_MAX) add = U64_MAX;
    pending = pending + add > U64_MAX ? U64_MAX : pending + add; // saturating_add
  }
  return pending;
}
/** A position with no liquidity and nothing pending in token B: it can never earn (see the top of this file). */
const empty = (pos) => pos.unlockedLiquidity + pos.vestedLiquidity + pos.permanentLockedLiquidity === 0n && pos.feeBPending === 0n;

/* ---------------------------------------------------------------- reading */
/**
 * The amount of a whole, initialized SPL token account of `program` for `mint` whose owner is `owner`, or null when the account is
 * anything else. A Token-2022 account may be longer (its extensions); its first 165 bytes are the same.
 */
function tokenAmount(acc, { program = PROGRAM_IDS.token, mint = null, owner }) {
  const a = acc && acc.owner === program ? accountBytes(acc) : null;
  if (!a || a.bytes.length < TOKEN_ACCOUNT_SIZE || (program === PROGRAM_IDS.token && a.bytes.length !== TOKEN_ACCOUNT_SIZE)) return null;
  const b = a.bytes;
  if (b[108] !== 1) return null; // AccountState::Initialized
  if ((mint && base58Encode(b.subarray(0, 32)) !== mint) || base58Encode(b.subarray(32, 64)) !== owner) return null;
  return readU64(b, 64);
}
/**
 * One getMultipleAccounts on the checked node: { slot, accounts: Map(address -> account | null) }. Every entry must be null or a
 * whole account, the answer as long as the question and at `min` or later; anything else is rpc_bad_answer.
 */
async function oneRead(env, addresses, route, min, fetchImpl) {
  const list = [...new Set(addresses)];
  if (list.length > 100) throw broken("too_many_accounts");
  const config = { encoding: "base64", commitment: "confirmed", ...(min ? { minContextSlot: min } : {}) };
  const r = await lpRpc(env, "getMultipleAccounts", [list, config], fetchImpl, route);
  const v = r && Array.isArray(r.value) ? r.value : null;
  const slot = r && r.context && r.context.slot;
  if (!v || v.length !== list.length || !Number.isSafeInteger(slot) || slot <= 0 || (min && slot < min)) throw broken("rpc_bad_answer");
  if (v.some((a) => a !== null && !wholeAccount(a))) throw broken("rpc_bad_answer");
  return { slot, accounts: new Map(list.map((k, i) => [k, v[i]])) };
}
/** oneRead over any number of addresses, 100 at a time, each answer at the slot of the one before or later: { slot, accounts }. */
async function readMany(env, addresses, route, min, fetchImpl) {
  const accounts = new Map();
  let slot = min;
  for (let i = 0; i < addresses.length; i += 100) {
    const r = await oneRead(env, addresses.slice(i, i + 100), route, slot, fetchImpl);
    slot = r.slot;
    for (const [k, a] of r.accounts) accounts.set(k, a);
  }
  return { slot, accounts };
}

/**
 * The record's Token-2022 accounts at `min` or later (one getTokenAccountsByOwner, its answer at most MAX_TOKEN_BYTES): { held:
 * Map(mint -> the record's initialized accounts holding exactly 1 of it), at: the answer's slot }. Throws (a code) when that answer is
 * too long or not whole.
 */
async function heldByRecord(env, coinAddr, route, min, fetchImpl) {
  let r;
  try {
    r = await lpRpc(env, "getTokenAccountsByOwner", [coinAddr, { programId: PROGRAM_IDS.token2022 }, { encoding: "base64", commitment: "confirmed", minContextSlot: min }], fetchImpl, { ...route, maxBytes: MAX_TOKEN_BYTES });
  } catch (e) { throw codeOf(e) === "rpc_too_large" ? broken("too_many_token_accounts") : e; }
  const rows = r && Array.isArray(r.value) ? r.value : null;
  const at = r && r.context && r.context.slot;
  if (!rows || !Number.isSafeInteger(at) || at < min) throw broken("rpc_bad_answer");
  if (rows.length > MAX_TOKEN_ROWS) throw broken("too_many_token_accounts");
  const held = new Map(); // nft mint -> the record's accounts holding exactly 1 of it
  for (const row of rows) {
    if (!row || !isSolanaAddress(row.pubkey) || !wholeAccount(row.account)) throw broken("rpc_bad_answer");
    // every row must be a whole Token-2022 account of the record: anything else is a malformed answer, never skipped
    const b = accountBytes(row.account).bytes;
    if (row.account.owner !== PROGRAM_IDS.token2022 || b.length < TOKEN_ACCOUNT_SIZE || base58Encode(b.subarray(32, 64)) !== coinAddr) throw broken("token_row_unread");
    if (b[108] !== 1 && b[108] !== 2) throw broken("token_row_unread"); // AccountState: 1 initialized, 2 frozen
    // only an initialized account holding exactly 1 passes harvest_pool_fees (math.rs:136-144 read_token_account_base)
    if (b[108] !== 1 || readU64(b, 64) !== 1n) continue;
    const nftMint = base58Encode(b.subarray(0, 32));
    if (!held.has(nftMint)) held.set(nftMint, []);
    held.get(nftMint).push(row.pubkey);
  }
  if (held.size > MAX_NFTS) throw broken("too_many_nfts");
  return { held, at };
}

/**
 * The city's DAMM v2 positions of a graduated coin, at `min` or later: [{ nftMint, nftAccount, position, pool }] (sorted by position),
 * the slot the last answer was at, and `held` (heldByRecord). Every initialized Token-2022 account of the record holding exactly 1 of
 * a mint is a candidate (harvest_pool_fees takes any such account: see the top of this file); the candidate is a position when DAMM
 * v2's ["position", mint] account is a Position naming that mint. Positions that hold nothing are left out (they never can), and so
 * are those in a pool of another pair (not the city's to harvest). At least one must be in the coin's own pool (the graduation's), at
 * most MAX_POSITIONS in all. Throws (a code) whenever that cannot be known completely; the caller then withholds the estimate alone.
 */
async function cityPositions(env, coinAddr, coin, dammPool, route, min, fetchImpl) {
  const { held, at } = await heldByRecord(env, coinAddr, route, min, fetchImpl);
  const nfts = await Promise.all([...held.keys()].map(async (nftMint) => ({ nftMint, accounts: held.get(nftMint), position: await damm.position(nftMint) })));
  const read = await readMany(env, nfts.map((n) => n.position), route, at, fetchImpl);
  const kept = [];
  for (const n of nfts) {
    const acc = read.accounts.get(n.position);
    if (notThere(acc)) continue; // no position was ever made with this mint: someone's token, not a position NFT
    const pos = decodeDammPosition(acc);
    // only DAMM v2's create_position writes at this address, with a Position of this mint (whose supply is 1)
    if (!pos || pos.nftMint !== n.nftMint || n.accounts.length !== 1) throw broken("damm_position_unread");
    if (!empty(pos)) kept.push({ nftMint: n.nftMint, nftAccount: n.accounts[0], position: n.position, pool: pos.pool });
  }
  // a position outside the coin's own pool is the city's when its pool is this coin's pair (a pool's mints never change)
  const others = [...new Set(kept.map((k) => k.pool).filter((p) => p !== dammPool))];
  const pools = await readMany(env, others, route, read.slot, fetchImpl);
  const ours = new Set([dammPool]);
  for (const p of others) {
    const dp = decodeDammPool(pools.accounts.get(p));
    if (!dp) throw broken("damm_pool_unread");
    if (dp.tokenAMint === coin.mint && dp.tokenBMint === coin.quoteMint) ours.add(p);
  }
  const city = kept.filter((k) => ours.has(k.pool)).sort((x, y) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0));
  if (city.length > MAX_POSITIONS) throw broken("too_many_positions");
  if (!city.some((k) => k.pool === dammPool)) throw broken("damm_position_missing");
  return { positions: city, slot: pools.slot, held };
}

/**
 * The positions were listed at one slot and their figures read at a later one (the last answer, at `min`): a position given to the
 * record in between would be missing from a figure marked whole. So the record's accounts are listed again at `min` or later; a mint
 * that was not there before and is a Position that holds something in a pool of this pair (the coin's own pool, or one whose token A
 * is the coin and token B its quote token) throws positions_changed, and the caller withholds the estimate (the next reading counts
 * it: positions never leave). Anything else that arrived (someone's token, an empty position, one in a pool of another pair) changes
 * nothing. Throws (a code) when that cannot be known.
 */
async function noPositionSince(env, coinAddr, coin, dammPool, before, route, min, fetchImpl) {
  const now = await heldByRecord(env, coinAddr, route, min, fetchImpl);
  const fresh = [...now.held.keys()].filter((m) => !before.has(m));
  if (!fresh.length) return;
  const at = await Promise.all(fresh.map((m) => damm.position(m)));
  const read = await readMany(env, at, route, now.at, fetchImpl);
  const pools = new Set();
  fresh.forEach((m, i) => {
    const acc = read.accounts.get(at[i]);
    if (notThere(acc)) return;
    const pos = decodeDammPosition(acc);
    if (!pos || pos.nftMint !== m) throw broken("damm_position_unread");
    if (!empty(pos)) pools.add(pos.pool);
  });
  if (pools.has(dammPool)) throw broken("positions_changed");
  const others = await readMany(env, [...pools], route, read.slot, fetchImpl);
  for (const p of pools) {
    const dp = decodeDammPool(others.accounts.get(p));
    if (!dp) throw broken("damm_pool_unread");
    if (dp.tokenAMint === coin.mint && dp.tokenBMint === coin.quoteMint) throw broken("positions_changed");
  }
}

/**
 * The figures of the city's positions in the last answer `accounts`: [{ position, nftMint, nftAccount, pool, pending }]. Every pool
 * must still be this pair (the coin's own OnlyB), every NFT still in the record's account and every Position still the one the first
 * answers named. Throws (a code) when not; the caller then withholds the estimate alone.
 */
function positionFigures(found, pools, dammPool, coin, coinAddr, accounts) {
  const poolOf = new Map();
  for (const p of pools) {
    const dp = decodeDammPool(accounts.get(p));
    if (!dp || dp.tokenAMint !== coin.mint || dp.tokenBMint !== coin.quoteMint) throw broken("damm_pool_unread");
    if (p === dammPool && dp.collectFeeMode !== ONLY_B) throw broken("damm_fee_mode");
    poolOf.set(p, dp);
  }
  return found.positions.map((n) => {
    // still the record's at this slot (it cannot leave), and still the position the first answers named
    if (tokenAmount(accounts.get(n.nftAccount), { program: PROGRAM_IDS.token2022, mint: n.nftMint, owner: coinAddr }) !== 1n) throw broken("damm_position_unread");
    const pos = decodeDammPosition(accounts.get(n.position));
    if (!pos || pos.nftMint !== n.nftMint || pos.pool !== n.pool) throw broken("damm_position_unread");
    return { position: n.position, nftMint: n.nftMint, nftAccount: n.nftAccount, pool: n.pool, pending: unclaimedFeeB(poolOf.get(n.pool), pos) };
  });
}

/**
 * The rewards config account, or null while holder rewards are not set up. Anyone can send SOL to the config's address before
 * init_city (a System-owned account with no data, which init_city then takes over): that is "not set up yet", not an unclear reading.
 * The payout opt-in's address the same way (a PDA only our program can create).
 */
const notThere = (acc) => !acc || (acc.owner === PROGRAM_IDS.system && (accountBytes(acc)?.bytes.length ?? 0) === 0);
/** Everything of one answer except the graduated pools: the record, the vault, the pot, the curve and its config, the opt-in, the rewards vault. */
function readBase(s, entry, A, accounts) {
  const coin = decodeCoin(accounts.get(A.coin), s.programId);
  if (!coin || accounts.get(A.coin).owner !== s.programId) throw broken("coin_record_unread");
  if (coin.mint !== entry.mint || coin.dbcPool !== entry.pool || coin.dbcConfig !== A.dbcConfig) throw broken("coin_record_mismatch");
  const claimable = tokenAmount(accounts.get(A.founderVault), { mint: coin.quoteMint, owner: A.coin });
  const pot = tokenAmount(accounts.get(A.holdersPot), { mint: coin.quoteMint, owner: A.coin });
  if (claimable === null) throw broken("founder_vault_unread");
  if (pot === null) throw broken("holders_pot_unread");
  const pool = decodePool(accounts.get(A.dbcPool));
  if (!pool || pool.creator !== A.coin || pool.baseMint !== coin.mint || pool.config !== coin.dbcConfig) throw broken("dbc_pool_unread");
  const cfgAcc = accounts.get(A.dbcConfig);
  const config = cfgAcc && cfgAcc.owner === PROGRAM_IDS.dbc ? decodeConfig(cfgAcc) : null;
  if (!config || config.quoteMint !== coin.quoteMint) throw broken("dbc_config_unread");
  // the payout opt-in: absent, or our program's PayoutOptIn of this record
  let payoutAgreed = false;
  const optAcc = accounts.get(A.payoutOptIn);
  if (!notThere(optAcc)) {
    const o = optAcc.owner === s.programId ? decodePayoutOptIn(optAcc, s.programId) : null;
    if (!o || o.coin !== A.coin) throw broken("payout_opt_in_unread");
    payoutAgreed = o.founder === coin.founder; // a payout needs the opt-in's founder to be the record's (payout_founder_fees.rs:84-88)
  }
  let vault = null, rewardsSetUp = false;
  const cfgRewards = notThere(accounts.get(A.rewardsConfig)) ? null : accounts.get(A.rewardsConfig);
  if (cfgRewards) {
    const cfg = cfgRewards.owner === s.rewardsProgramId ? decodeCityConfig(cfgRewards, s.rewardsProgramId) : null;
    if (!cfg || cfg.mint !== coin.mint || cfg.vault !== A.rewardsVault) throw broken("rewards_config_unread");
    rewardsSetUp = true;
    // the vault is read only when its token is the coin's quote token (the unit of every other figure); a vault of any other token
    // (init_city takes Token-2022 too) is never shown, so it never makes the reading unclear
    if (cfg.rewardMint === coin.quoteMint) {
      const balance = tokenAmount(accounts.get(A.rewardsVault), { mint: cfg.rewardMint, owner: A.rewardsConfig });
      if (balance === null) throw broken("rewards_vault_unread");
      vault = { address: A.rewardsVault, balance, holdersOnly: cfg.rewardModel === 1 && cfg.founderBps === 0 };
    }
  }
  return { coin, claimable, pot, pool, surplus: creatorSurplusDue(pool, config), payoutAgreed, vault, rewardsSetUp };
}

async function readFeeStatus(env, s, mint, fetchImpl, now) {
  const list = await officialCoins(env, fetchImpl, now);
  const entry = list.coins.find((c) => c.mint === mint);
  if (!entry) return null;
  // the node must be the cluster the settings name, asked for this reading; every later call on that node alone
  const g = await checkGenesis(env, fetchImpl, { pin: true });
  if (!g.ok) throw broken(g.error);
  const route = { ...lpRoute(env), only: g.only };
  if (!g.only || !rpcTargets(env, route).some((t) => t.role === g.only)) throw broken("rpc_unpinned");
  const L = launchpadPdas(s.programId), R = rewardsPdas(s.rewardsProgramId);
  const A = { coin: entry.coinAccount, dbcPool: entry.pool, dbcConfig: entry.config };
  [A.founderVault, A.holdersPot, A.payoutOptIn, A.rewardsConfig] = await Promise.all([L.founderVault(A.coin), L.holdersPot(A.coin), L.payoutOptIn(A.coin), R.city(mint)]);
  A.rewardsVault = await R.vault(A.rewardsConfig);
  const key = `${s.cluster}|${s.programId}|${mint}`;
  const base = [A.coin, A.founderVault, A.holdersPot, A.dbcPool, A.dbcConfig, A.payoutOptIn, A.rewardsConfig, A.rewardsVault];
  let read = await oneRead(env, base, route, floors.get(key) || null, fetchImpl);
  let b = readBase(s, entry, A, read.accounts);
  // the estimate of what is still in the pool: before graduation the curve's own figures (exact, in this answer); after it also the
  // city's positions, which alone may be withheld (see THE ESTIMATE at the top of this file)
  let positions = [], dammPool = null, pools = [], withheld = null;
  if (b.pool.isMigrated) {
    // graduated: the record's positions, then everything again in one answer with their pools, the positions and their NFT accounts
    dammPool = await canonicalPool(b.coin.mint, b.coin.quoteMint);
    let found = null, last = null;
    try {
      found = await cityPositions(env, A.coin, b.coin, dammPool, route, read.slot, fetchImpl);
      pools = [dammPool, ...new Set(found.positions.map((p) => p.pool).filter((p) => p !== dammPool))];
      last = await oneRead(env, [...base, ...pools, ...found.positions.flatMap((n) => [n.position, n.nftAccount])], route, found.slot, fetchImpl);
    } catch (e) { withheld = codeOf(e); }
    if (last) {
      // the exact figures of the last answer must read as cleanly as the first (a node that answers both cannot change them)
      b = readBase(s, entry, A, last.accounts);
      if (!b.pool.isMigrated) throw broken("rpc_bad_answer"); // graduation is for ever
      read = last;
      try {
        positions = positionFigures(found, pools, dammPool, b.coin, A.coin, last.accounts);
        // and no position of this pair came to the record between the listing and the last answer
        await noPositionSince(env, A.coin, b.coin, dammPool, found.held, route, last.slot, fetchImpl);
      } catch (e) { withheld = codeOf(e); }
    }
    if (withheld) { positions = null; pools = []; console.error("fee status: pool estimate withheld", withheld); }
  }

  const c = b.coin;
  const curve = b.pool.creatorQuoteFee, surplus = b.surplus;
  // one harvest_curve_fees takes the curve's fees and the surplus together and splits the sum once; each position is split by itself
  const pendingTotal = positions ? positions.reduce((t, p) => t + p.pending, curve + surplus) : null;
  const founderPending = positions ? positions.reduce((t, p) => t + splitFee(p.pending)[1], splitFee(curve + surplus)[1]) : null;
  // a whole reading: the next one of this coin on this server must be at least as new
  if (!floors.has(key) || read.slot > floors.get(key)) floors.set(key, read.slot);
  if (floors.size > 2000) floors.delete(floors.keys().next().value);
  return {
    cluster: s.cluster, mint,
    coin: { address: A.coin, cityId: String(c.cityId), mint: c.mint, quoteMint: c.quoteMint, dbcPool: c.dbcPool, graduated: Boolean(b.pool.isMigrated), quote: QUOTES[c.quoteMint] || null },
    city: { harvested: c.founderAccrued + c.holdersAccrued, pendingInPool: pendingTotal },
    founder: {
      wallet: maskWallet(c.founder), payoutAgreed: b.payoutAgreed, earned: c.founderAccrued, claimed: c.founderClaimed, paidOut: c.founderPaidOut,
      collected: c.founderClaimed + c.founderPaidOut, claimable: b.claimable, pendingInPool: founderPending,
    },
    holders: { earned: c.holdersAccrued, pot: b.pot, forwarded: c.holdersForwarded, pendingInPool: positions ? pendingTotal - founderPending : null, vault: b.vault },
    pool: { curve, surplus, damm: dammPool, estimate: positions ? "whole" : "unavailable", positions },
    source: {
      accounts: {
        coin: A.coin, founderVault: A.founderVault, holdersPot: A.holdersPot, dbcPool: A.dbcPool, dbcConfig: A.dbcConfig,
        payoutOptIn: A.payoutOptIn, // read either way: absent (or a stranger's SOL) is what "only this wallet can collect" rests on
        rewardsConfig: b.rewardsSetUp ? A.rewardsConfig : null, rewardsVault: b.vault ? A.rewardsVault : null,
        dammPool, otherDammPools: positions ? pools.filter((p) => p !== dammPool) : null, positions: positions ? positions.map((p) => p.position) : null,
      },
      slot: read.slot, readAt: iso(now),
    },
  };
}

/**
 * The fee status of `mint` (see the top of this file), or null when it is not an official city coin. The last whole reading of this
 * server when it is under a minute old; the last failure when it is under FAIL_MS old. Throws when it could not be read clearly.
 */
export function feeStatus(env, mint, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on || !s.configsSet) return Promise.reject(broken(s.on ? "config_not_set" : "not_enabled"));
  if (!isSolanaAddress(mint)) return Promise.reject(broken("bad_mint"));
  const key = `${s.cluster}|${s.programId}|${mint}`;
  const m = memo.get(key);
  if (m && now >= m.at && now - m.at < (m.failed ? FAIL_MS : READ_MS)) return m.promise;
  const fresh = { at: now, failed: false, promise: readFeeStatus(env, s, mint, fetchImpl, now) };
  fresh.promise.catch(() => { fresh.failed = true; });
  memo.set(key, fresh);
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return fresh.promise;
}

/** The answer as JSON: every BigInt as its exact decimal string. */
const plain = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

/** GET /api/fee-status?mint= (src/index.js has checked the gate and the method, and counts the public limit on an edge-cache miss). */
export async function handleFeeStatus(request, env, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on) return json({ ok: false, error: "not_enabled" }, 404);
  const mint = new URL(request.url).searchParams.get("mint");
  if (!isSolanaAddress(mint)) return json({ ok: false, error: "bad_mint" }, 400);
  let r;
  try { r = await feeStatus(env, mint, fetchImpl, now); } catch (e) {
    console.error("fee status: not read", codeOf(e));
    return json({ ok: false, error: codeOf(e) === "config_not_set" ? "config_not_set" : "rpc_unavailable" }, 503, { "Cache-Control": "no-store", "Retry-After": "60" });
  }
  if (!r) return json({ ok: false, error: "not_official" }, 404, { "Cache-Control": `public, max-age=${EDGE_SECONDS}` });
  return json({ ok: true, ...plain(r) }, 200, { "Cache-Control": `public, max-age=${EDGE_SECONDS}` });
}
