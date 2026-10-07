// Holder snapshot and rewards round for one city coin (LAUNCHPAD-DESIGN.md 12.1 to 12.3).
//
// The holders' share of every trade reaches the city's vicinity_rewards vault
// through the launchpad program. From there it is paid out in rounds
// ("epochs"): the city's rewards authority (a multisig) publishes a snapshot
// file, books it with fund_epoch_from_vault (Merkle root, number of leaves,
// slot, SHA-256 of the file), and each holder claims their own amount.
//
// This module is the pure part of that job: who counts as a holder, how much
// each gets, whether a round is worth funding, and the file everyone can use
// to recompute the root. scripts/launchpad/snapshot.mjs reads the chain and
// writes the files. The same leaves can also feed `solana-tokens
// distribute-spl-tokens` (CSV) for a push airdrop from the admin's own wallet.
//
// Time-weighting (design 12.3): a balance read at one slot rewards anyone who
// buys just before it and sells just after. So the round uses, per holder, the
// SMALLER of the balance at the cutoff and the average of balance samples
// taken at unannounced, random times during the epoch (sampleBalances,
// `snapshot.mjs --sample`); a holder missing from a sample counts 0 there. A
// round with fewer than `minSamples` samples is not fundable.
//
// Known limit (published with the rules): owners that are not on the ed25519
// curve are program addresses (curve and pool vaults, the coin's own PDA) and
// never count; that also leaves out coins held in a multisig vault (Squads) or
// another smart-wallet address. `includeOwners` lets the rewards authority add
// such vaults by hand, one by one.
import web3 from '@solana/web3.js';
import { allocateProRata, buildTree, sha256, toBase58, toHex } from '../merkle.mjs';
import { IDL, decodeAccount } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, rewardsPdas } from './pda.mjs';

const { PublicKey } = web3;

/** Defaults from design 12.1 and 12.3. Amounts are raw units of the reward token (lamports for SOL). */
export const ROUND_RULES = Object.freeze({
  minBalanceBps: 1n, // a holder needs at least 0.01% of the circulating supply
  minPayout: 10_000_000n, // 0.01 SOL, for SOL rewards only: other reward tokens must set their own (see minPayoutFor)
  minHolders: 20, // fund a round only when at least this many holders get the minimum
  minSamples: 6, // balance samples at random times during the epoch before a round may be funded
  maxLeaves: 1 << 22, // vicinity_rewards' limit per epoch
});
const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * The minimum payout for a round paid in `rewardMint`. 10,000,000 raw units is
 * 0.01 SOL for SOL rewards but only 10 VICINITY (a fraction of a cent) for a
 * 6-decimal token, so for any reward token other than SOL the caller must set
 * the minimum explicitly (`--min-payout`, in raw units, worth about a claim's
 * fee); otherwise this throws. An explicit `rules.minPayout` (different from the
 * SOL default) counts as set.
 */
export function minPayoutFor(rewardMint, rules = ROUND_RULES, explicit) {
  if (explicit !== undefined) return BigInt(explicit);
  if (String(rewardMint) === WSOL || rules.minPayout !== ROUND_RULES.minPayout) return rules.minPayout;
  throw new Error(`set the minimum payout for ${rewardMint} rewards explicitly (--min-payout, raw units worth about one claim fee): the 0.01 SOL default does not apply to this token`);
}

const onCurve = (owner) => PublicKey.isOnCurve(new PublicKey(owner).toBytes());

/**
 * Sum a coin's token accounts by owner and apply the snapshot rules.
 * `accounts`: [{ owner, amount }] (every token account of the coin at one slot).
 * `excludeOwners`: wallets that never count (the team wallets, which include the
 * dev wallet, and the city's founder). Owners that are not on the ed25519 curve
 * are program addresses (curve and pool vaults, the coin's own PDA) and never count.
 * Returns { eligible: [{ owner, balance }], excluded: [{ owner, balance, reason }], circulating, minBalance }.
 */
const sumByOwner = (accounts) => {
  const byOwner = new Map();
  for (const a of accounts) {
    const amt = BigInt(a.amount);
    if (amt === 0n) continue;
    byOwner.set(String(a.owner), (byOwner.get(String(a.owner)) ?? 0n) + amt);
  }
  return byOwner;
};

/**
 * The balance that counts per owner: min(balance at the cutoff, average over
 * the samples), each sample being [{ owner, amount }] (token accounts, summed
 * per owner; an owner missing from a sample holds 0 there). Without samples,
 * the cutoff balance.
 */
export function timeWeighted(accounts, samples = []) {
  const final = sumByOwner(accounts);
  if (samples.length === 0) return final;
  const sums = new Map();
  for (const sample of samples) for (const [owner, b] of sumByOwner(sample)) sums.set(owner, (sums.get(owner) ?? 0n) + b);
  const n = BigInt(samples.length);
  const out = new Map();
  for (const [owner, b] of final) {
    const avg = (sums.get(owner) ?? 0n) / n; // rounded down
    const w = b < avg ? b : avg;
    if (w > 0n) out.set(owner, w);
  }
  return out;
}

export function holderBalances(accounts, { excludeOwners = [], includeOwners = [], minBalanceBps = ROUND_RULES.minBalanceBps, isOnCurve = onCurve, samples = [] } = {}) {
  const byOwner = timeWeighted(accounts, samples);
  const skip = new Set(excludeOwners.map(String));
  const include = new Set(includeOwners.map(String));
  const excluded = [];
  const candidates = [];
  for (const [owner, balance] of byOwner) {
    if (skip.has(owner)) excluded.push({ owner, balance, reason: 'excluded wallet (team or founder)' });
    else if (!isOnCurve(owner) && !include.has(owner)) excluded.push({ owner, balance, reason: 'program address (curve or pool vault, coin PDA, or a multisig vault not on the include list)' });
    else candidates.push({ owner, balance });
  }
  const circulating = candidates.reduce((s, c) => s + c.balance, 0n);
  const minBalance = (circulating * BigInt(minBalanceBps) + 9_999n) / 10_000n; // rounded up
  const eligible = [];
  for (const c of candidates) {
    if (c.balance >= minBalance) eligible.push(c);
    else excluded.push({ ...c, reason: `below the minimum balance (${minBalance} raw)` });
  }
  // deterministic order: largest first, then by address
  eligible.sort((x, y) => (x.balance === y.balance ? (x.owner < y.owner ? -1 : 1) : x.balance > y.balance ? -1 : 1));
  return { eligible, excluded, circulating, minBalance };
}

/**
 * Split `total` (what the vault can pay this round) pro rata over `eligible`,
 * rounding down, then drop anyone below `minPayout` and split again among the
 * rest, until every leaf is at least `minPayout`. What does not divide evenly
 * stays in the vault for the next round. `fundable` is false when fewer than
 * `minHolders` would be paid: then wait instead of spending epoch rent and fees
 * to send cents.
 */
export function planRound(eligible, total, { minPayout = ROUND_RULES.minPayout, minHolders = ROUND_RULES.minHolders, maxLeaves = ROUND_RULES.maxLeaves } = {}) {
  let pool = eligible.slice(0, maxLeaves);
  let leaves = [];
  for (;;) {
    if (pool.length === 0 || total === 0n) { leaves = []; break; }
    const { leaves: l } = allocateProRata(pool.map((p) => ({ claimant: p.owner, balance: p.balance })), total);
    const paid = new Map(l.map((x) => [toBase58(x.claimant), x.amount]));
    const keep = pool.filter((p) => (paid.get(p.owner) ?? 0n) >= minPayout);
    if (keep.length === pool.length) { leaves = pool.map((p) => ({ claimant: p.owner, amount: paid.get(p.owner) })); break; }
    pool = keep;
  }
  const allocated = leaves.reduce((s, l) => s + l.amount, 0n);
  const fundable = leaves.length >= minHolders;
  return {
    leaves, allocated, dust: total - allocated, fundable,
    reason: fundable ? null : `only ${leaves.length} holder(s) would receive at least ${minPayout} raw; need ${minHolders}`,
  };
}

/**
 * The file a round publishes, and its SHA-256 (fund_epoch_from_vault's
 * `snapshot_hash`). Anyone can rebuild the Merkle root from it.
 */
export function roundFile({ mint, rewardMint, slot, leaves, rules = ROUND_RULES, excluded = [], circulating, minBalance, sampleSlots = [] }) {
  const tree = buildTree(leaves);
  const body = {
    kind: 'vicinity-holder-rewards-round', version: 1, coinMint: String(mint), rewardMint: String(rewardMint), slot: String(slot),
    rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, String(v)])),
    balanceRule: sampleSlots.length ? 'min(balance at the cutoff slot, average of the sampled balances)' : 'balance at the cutoff slot (no samples)',
    sampleSlots: sampleSlots.map(String),
    circulating: String(circulating ?? ''), minBalance: String(minBalance ?? ''),
    merkleRoot: toHex(tree.root), numLeaves: leaves.length,
    leaves: leaves.map((l, i) => ({ index: i, claimant: String(l.claimant), amount: String(l.amount) })),
    excluded: excluded.map((e) => ({ owner: e.owner, balance: String(e.balance), reason: e.reason })),
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  return { tree, text, hash: sha256(Buffer.from(text, 'utf8')) };
}

/** `recipient,amount` CSV for `solana-tokens distribute-spl-tokens` (amounts in whole tokens). */
export function solanaTokensCsv(leaves, decimals) {
  const d = BigInt(decimals);
  const fmt = (raw) => {
    const s = raw.toString().padStart(Number(d) + 1, '0');
    const whole = s.slice(0, s.length - Number(d)), frac = s.slice(s.length - Number(d)).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  };
  return `recipient,amount\n${leaves.map((l) => `${l.claimant},${fmt(BigInt(l.amount))}`).join('\n')}\n`;
}

/** Offset of `mint` in our `Coin` account: discriminator 8, city_id 8, founder 32. */
const COIN_MINT_OFFSET = 48;

/** Every classic SPL token account of `mint` at one slot, as [{ owner, amount }]. */
async function tokenHolders(connection, mint, commitment) {
  const accs = await connection.getProgramAccounts(new PublicKey(PROGRAM_IDS.token), { commitment, filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }] });
  return accs.map(({ account }) => ({ owner: new PublicKey(Buffer.from(account.data).subarray(32, 64)).toBase58(), amount: Buffer.from(account.data).readBigUInt64LE(64) }));
}

/**
 * One balance sample of a coin's holders (what `snapshot.mjs --sample` stores):
 * { kind, coinMint, slot, time, balances: [{ owner, amount }] } summed per
 * owner. Run it at random, unannounced times during the epoch.
 */
export async function sampleBalances(connection, mint, { commitment = 'confirmed' } = {}) {
  mint = new PublicKey(mint).toBase58();
  const slot = await connection.getSlot(commitment);
  const byOwner = sumByOwner(await tokenHolders(connection, mint, commitment));
  return { kind: 'vicinity-holder-balance-sample', coinMint: mint, slot, time: new Date().toISOString(), balances: [...byOwner].map(([owner, amount]) => ({ owner, amount })) };
}

/** Decimals of a mint read from chain (classic SPL or Token-2022: byte 44 of the mint account). */
export async function mintDecimals(connection, mint, commitment = 'confirmed') {
  const info = await connection.getAccountInfo(new PublicKey(mint), commitment);
  if (!info || info.data.length < 45) throw new Error(`${mint} is not a token mint`);
  return Buffer.from(info.data)[44];
}

/**
 * Read one coin's round inputs from a @solana/web3.js `Connection` (what
 * scripts/launchpad/snapshot.mjs does) and plan the round:
 *   * the coin must be in our registry (its founder and quote token come from there);
 *   * every classic SPL token account of the coin, read at one recorded slot,
 *     time-weighted with `samples` (sampleBalances results for this coin);
 *   * excluded: the dev wallet, the founder and `excludeOwners`, plus every
 *     program address except `includeOwners` (multisig vaults added by hand);
 *   * `total` defaults to what the city's rewards vault can pay now: its surplus
 *     over what open rounds still owe, plus the carry-over;
 *   * the minimum payout must be set for reward tokens other than SOL
 *     (`minPayout`, see minPayoutFor); the CSV uses the reward token's decimals
 *     as read from chain.
 * Returns everything the script prints and writes; `file` and `csv` exist when
 * at least one holder would be paid. With fewer than `rules.minSamples`
 * samples the round is planned but not fundable.
 */
export async function prepareRound(connection, mint, { excludeOwners = [], includeOwners = [], total, rules = ROUND_RULES, minPayout, samples = [], commitment = 'confirmed' } = {}) {
  mint = new PublicKey(mint).toBase58();
  const slot = await connection.getSlot(commitment);
  const coinAccs = await connection.getProgramAccounts(new PublicKey(PROGRAM_IDS.launchpad), { commitment, filters: [{ memcmp: { offset: COIN_MINT_OFFSET, bytes: mint } }] });
  if (coinAccs.length !== 1) throw new Error(`${mint} is not a Vicinity coin (no registry record)`);
  const coin = decodeAccount(IDL.launchpad, 'Coin', coinAccs[0].account.data);
  const founder = coin.founder.toBase58();
  const rewardMint = coin.quote_mint.toBase58();
  const payoutMin = minPayoutFor(rewardMint, rules, minPayout);
  const decimals = await mintDecimals(connection, rewardMint, commitment);
  for (const smp of samples) if (smp.coinMint !== undefined && smp.coinMint !== mint) throw new Error(`a balance sample of ${smp.coinMint} was given for ${mint}`);
  const accounts = await tokenHolders(connection, mint, commitment);
  const snap = holderBalances(accounts, { excludeOwners: [ADDRESSES.feeRecipient, founder, ...excludeOwners], includeOwners, minBalanceBps: rules.minBalanceBps, samples: samples.map((x) => x.balances ?? x) });
  if (total === undefined) {
    const R = rewardsPdas();
    const cfgAddr = R.city(mint);
    const [cfgInfo, vaultInfo] = await connection.getMultipleAccountsInfo([new PublicKey(cfgAddr), new PublicKey(R.vault(cfgAddr))], commitment);
    if (!cfgInfo || !vaultInfo) throw new Error('no vicinity_rewards config for this coin yet; pass a total to plan anyway');
    const cfg = decodeAccount(IDL.rewards, 'CityConfig', cfgInfo.data);
    const owed = BigInt(cfg.total_to_holders.toString()) - BigInt(cfg.total_claimed.toString());
    total = Buffer.from(vaultInfo.data).readBigUInt64LE(64) - owed + BigInt(cfg.carry_over.toString());
  }
  const roundRules = { ...rules, minPayout: payoutMin };
  const round = planRound(snap.eligible, total, roundRules);
  const minSamples = rules.minSamples ?? ROUND_RULES.minSamples;
  if (round.fundable && samples.length < minSamples) {
    round.fundable = false;
    round.reason = `only ${samples.length} balance sample(s) this epoch; need ${minSamples} taken at random times (snapshot.mjs --sample) so that a wallet holding only at the cutoff gets no share`;
  }
  const sampleSlots = samples.map((x) => x.slot).filter((x) => x !== undefined);
  const out = { mint, rewardMint, rewardDecimals: decimals, founder, slot, total, samples: samples.length, ...snap, round };
  if (round.leaves.length > 0) {
    out.file = roundFile({ mint, rewardMint, slot, leaves: round.leaves, rules: roundRules, excluded: snap.excluded, circulating: snap.circulating, minBalance: snap.minBalance, sampleSlots });
    out.csv = solanaTokensCsv(round.leaves, decimals);
  }
  return out;
}
