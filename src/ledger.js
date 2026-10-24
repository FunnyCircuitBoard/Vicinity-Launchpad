/**
 * Balance history: the basis for fair, hard-to-game eligibility.
 *
 * Every 10 minutes the scheduled job MAY record every holder's balance ("a sample"): on average
 * once an hour, at moments nobody can predict (at least every 3 hours). So borrowing tokens for a
 * few minutes doesn't help anyone: to look like a long-term holder you have to actually hold.
 *
 * From the samples:
 *   streaks  → since when a wallet has held a founder amount in EVERY sample (founder qualifying time)
 *   day:<d>  → per UTC day: how many samples, each wallet's summed balance, and the day's last balances
 *              (the 14-day average balance = summed balances ÷ number of samples)
 * Each sample's blockchain slot and a hash of its data are kept, so the numbers can be checked.
 */
import { DAY, POLICY, founderLevels, iso } from "./policy.js";
import { tokenMint } from "./official.js";
import { mainTokenV5On } from "./flags.js";
import { getAllHolders, publishHolders } from "./chain.js";
import { getBlob, putBlob, sha256hex } from "./blobs.js";
import { ensureSchema } from "./store.js";

export const dayOf = (ms) => iso(ms).slice(0, 10);
const daysBack = (endDay, n) => Array.from({ length: n }, (_, i) => dayOf(Date.parse(endDay + "T00:00:00Z") - i * DAY));

/**
 * The blob key of one UTC day of the balance history. MAIN_TOKEN_V5 off: `day:<d>`, the one series as before (it is $VICINITY's). On:
 * `mday:<mint>:<d>`, a series of the configured main token's own (owner amendment 01, section 5.3), so two tokens are never summed
 * into one day and the $VICINITY days stay as they were, history; null while no main token is configured (nothing is read or written).
 * The `mday:` prefix keeps these keys out of the `day:%` pruning below and out of the Founding Supporters snapshot (src/snapshot.js),
 * which reads the $VICINITY days only.
 */
export function dayKey(env, day) {
  if (!mainTokenV5On(env)) return `day:${day}`;
  const mint = tokenMint(env);
  return mint ? `mday:${mint}:${day}` : null;
}

/** Called by the scheduled job: take a sample now, or not (unpredictably, about once an hour). */
export async function maybeSample(env, now, fetchImpl = fetch, rand = Math.random) {
  if (!env.DB || !tokenMint(env)) return { sampled: false, why: "not_launched" };
  await ensureSchema(env.DB);
  const last = await env.DB.prepare("SELECT taken_at FROM balance_samples ORDER BY id DESC LIMIT 1").first();
  const gap = last ? now - Date.parse(last.taken_at) : Infinity;
  const s = POLICY.sampling;
  if (gap < s.minGapMinutes * 60_000) return { sampled: false, why: "too_soon" };
  if (gap < s.maxGapMinutes * 60_000 && rand() >= s.cronMinutes / s.meanMinutes) return { sampled: false, why: "not_this_time" };
  return takeSample(env, now, fetchImpl);
}

/**
 * A list with fewer than half the holders of a sample taken in the last 6 hours (when that one had at least 20) is not taken:
 * holders do not halve in a few hours, a provider's cut-short answer does (a backup on another plan, a truncated
 * getProgramAccounts), and a sample of it would end the streak of every founder missing from it (above_since = NULL cannot be
 * undone) and lower everyone's 14-day average. After 6 hours without a sample the guard steps aside, so a real drop is recorded.
 */
const SHRINK_MIN = 20, SHRINK_WITHIN_MS = 6 * 3_600_000;
async function shrankTooMuch(env, list, now) {
  const db = env.DB;
  // under MAIN_TOKEN_V5 the last sample OF THIS TOKEN's series (the table's last row may be a $VICINITY sample, whose holder count says
  // nothing about the new token's); with the switch off the table's last row, as before
  const prev = mainTokenV5On(env) ? await lastOfSeries(env, now) : await db.prepare("SELECT taken_at, holders FROM balance_samples ORDER BY id DESC LIMIT 1").first();
  return Boolean(prev && prev.holders >= SHRINK_MIN && list.length * 2 < prev.holders && now - Date.parse(prev.taken_at) < SHRINK_WITHIN_MS);
}

/** Record every holder's balance right now. */
export async function takeSample(env, now, fetchImpl = fetch) {
  const db = env.DB;
  await ensureSchema(db);
  const mint = tokenMint(env);
  const read = await getAllHolders(env, mint, fetchImpl);
  const { facts, list, labels, slot } = read;
  if (await shrankTooMuch(env, list, now)) {
    console.error("balance sample skipped: the holder list shrank by more than half", list.length);
    return { sampled: false, why: "list_shrank", holders: list.length };
  }
  // the sample read every holder anyway: the holder list, the dashboards and the coin stats of this run use it instead of
  // reading the chain again (a shared copy only; a failure to share is not a failure of the sample)
  await publishHolders(env, mint, read).catch(() => {});
  const takenAt = iso(now), day = dayOf(now), key = dayKey(env, day);
  const acc = (await getBlob(db, key)) || { day, n: 0, sums: {}, last: {}, lastAt: null, lastSlot: null, labels: {} };
  acc.n += 1;
  const last = {};
  for (const [owner, amount] of list) { acc.sums[owner] = (acc.sums[owner] || 0) + amount; last[owner] = amount; }
  acc.last = last; acc.lastAt = takenAt; acc.lastSlot = slot; acc.decimals = facts.decimals;
  for (const [owner, label] of labels) acc.labels[owner] = label;
  // the streaks first, the sample's own records last: if the streaks fail (a database hiccup, a limit) nothing says this sample
  // happened, so the next run takes it again instead of waiting an hour with half the founder clocks never started
  // the founder hold streaks are $VICINITY's history (frozen with the legacy seats): under MAIN_TOKEN_V5 a sample of the new token never
  // starts, continues or ends one (tenure below answers "not qualified" then)
  if (!mainTokenV5On(env)) await updateStreaks(db, list, takenAt);
  await putBlob(db, key, acc);
  await db.prepare("INSERT INTO balance_samples (taken_at, day, slot, holders, hash) VALUES (?, ?, ?, ?, ?)")
    .bind(takenAt, day, slot, list.length, await sha256hex(JSON.stringify(list))).run();
  return { sampled: true, takenAt, slot, holders: list.length };
}

const STREAK_CHUNK = 2_000; // wallets per statement, sent as one JSON list (about 90 KB; D1 takes up to 2 MB in one value)
const STREAK_BATCH = 20; // statements per database call

/**
 * Streaks only change when a wallet crosses a founder amount. Per rung: one read of the wallets above it (an index keeps that to
 * those rows: before, each of the 100 reads scanned the whole table), then the changes, as one statement per 2,000 wallets.
 * About 100 database calls per sample however many people buy or sell between two samples (it was 100 plus one per 50
 * changed wallets per rung, which passed the 10,000 subrequests of one run at about 5,000 new holders).
 */
async function updateStreaks(db, list, takenAt) {
  const stmts = [];
  for (const level of founderLevels()) {
    const above = new Set(list.filter(([, a]) => a >= level).map(([o]) => o));
    const had = new Set((await db.prepare("SELECT wallet FROM streaks WHERE level = ? AND above_since IS NOT NULL").bind(level).all()).results.map((r) => r.wallet));
    const start = [...above].filter((w) => !had.has(w)), stop = [...had].filter((w) => !above.has(w));
    for (let i = 0; i < start.length; i += STREAK_CHUNK)
      stmts.push(db.prepare("INSERT INTO streaks (wallet, level, above_since) SELECT value, ?, ? FROM json_each(?) WHERE true ON CONFLICT (wallet, level) DO UPDATE SET above_since = excluded.above_since")
        .bind(level, takenAt, JSON.stringify(start.slice(i, i + STREAK_CHUNK))));
    for (let i = 0; i < stop.length; i += STREAK_CHUNK)
      stmts.push(db.prepare("UPDATE streaks SET above_since = NULL WHERE level = ? AND wallet IN (SELECT value FROM json_each(?))")
        .bind(level, JSON.stringify(stop.slice(i, i + STREAK_CHUNK))));
  }
  for (let i = 0; i < stmts.length; i += STREAK_BATCH) await db.batch(stmts.slice(i, i + STREAK_BATCH));
}

/** The newest sample of the configured main token's own series in the last two days: { taken_at, holders }, or null. */
async function lastOfSeries(env, now) {
  for (const d of daysBack(dayOf(now), 2)) {
    const key = dayKey(env, d), acc = key ? await getBlob(env.DB, key) : null;
    if (acc && acc.lastAt) return { taken_at: acc.lastAt, holders: Object.keys(acc.last || {}).length };
  }
  return null;
}

/**
 * How long has this wallet held `level` tokens in every sample? { since, days, needed, qualified }. Under MAIN_TOKEN_V5 a hold streak
 * is $VICINITY's history and never counts for the new main token: the answer is "no streak" (fail closed: no legacy seat is won on it).
 */
export async function tenure(env, wallet, level, now) {
  if (mainTokenV5On(env)) return { since: null, days: 0, needed: POLICY.founder.qualifyingDays, qualified: false };
  const r = await env.DB.prepare("SELECT above_since FROM streaks WHERE wallet = ? AND level = ?").bind(wallet, level).first();
  const since = r && r.above_since ? Date.parse(r.above_since) : null;
  const days = since ? Math.max(0, (now - since) / DAY) : 0;
  const needed = POLICY.founder.qualifyingDays;
  return { since: r?.above_since || null, days, needed, qualified: since != null && days >= needed };
}

/**
 * Average balance over the `days` UTC days ending with `endDay` (inclusive), for some wallets
 * (or every wallet seen, if `wallets` is null). Returns { averages: Map, samples, days: [...] }.
 */
export async function averages(env, endDay, days, wallets = null) {
  const want = wallets ? new Set(wallets) : null;
  const totals = new Map();
  let samples = 0;
  const used = [];
  for (const d of daysBack(endDay, days)) {
    const key = dayKey(env, d), acc = key ? await getBlob(env.DB, key) : null;
    if (!acc) continue;
    used.push({ day: d, samples: acc.n });
    samples += acc.n;
    if (want) { for (const w of want) if (acc.sums[w]) totals.set(w, (totals.get(w) || 0) + acc.sums[w]); }
    else for (const [w, s] of Object.entries(acc.sums)) totals.set(w, (totals.get(w) || 0) + s);
  }
  const out = new Map();
  for (const [w, t] of totals) out.set(w, samples ? t / samples : 0);
  if (want) for (const w of want) if (!out.has(w)) out.set(w, 0);
  return { averages: out, samples, days: used };
}

/** The most recent sample's balances (today's, else the latest day with data in the last `lookback` days). */
export async function latestBalances(env, now, lookback = 2) {
  for (const d of daysBack(dayOf(now), lookback + 1)) {
    const key = dayKey(env, d), acc = key ? await getBlob(env.DB, key) : null;
    if (acc && acc.lastAt) return { at: acc.lastAt, slot: acc.lastSlot, balances: acc.last, labels: acc.labels || {}, decimals: acc.decimals ?? 6, day: d };
  }
  return null;
}

/**
 * True when samples exist but the newest is older than twice the longest gap between samples (6 hours): the chain read has
 * been failing. Founder windows and manager elections then wait instead of deciding on old balances and on founder clocks
 * that nothing has checked meanwhile (fail closed, src/jobs.js). Before the very first sample this is false: those decisions
 * then read the chain directly, as they always did.
 */
export async function samplesStale(env, now) {
  const last = await env.DB.prepare("SELECT taken_at FROM balance_samples ORDER BY id DESC LIMIT 1").first();
  return Boolean(last) && now - Date.parse(last.taken_at) > POLICY.sampling.maxGapMinutes * 60_000 * 2;
}

/** Health of the balance history (shown on /rules so anyone can see it's running). */
export async function ledgerStatus(env, now) {
  if (!env.DB) return { running: false };
  await ensureSchema(env.DB);
  const last = await env.DB.prepare("SELECT taken_at, slot, holders FROM balance_samples ORDER BY id DESC LIMIT 1").first();
  const day = await env.DB.prepare("SELECT COUNT(*) AS n FROM balance_samples WHERE taken_at >= ?").bind(iso(now - DAY)).first();
  return { running: Boolean(last), lastSample: last || null, samplesLast24h: day?.n || 0 };
}

/** Forget balance history older than 45 days. */
export async function pruneLedger(env, now) {
  const cutoff = dayOf(now - 45 * DAY);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM blobs WHERE key LIKE 'day:%' AND key < ?").bind(`day:${cutoff}`),
    env.DB.prepare("DELETE FROM balance_samples WHERE day < ?").bind(cutoff),
    // the main token's own series (MAIN_TOKEN_V5 on only: with it off the batch is exactly as before); its keys end with the day
    ...(mainTokenV5On(env) ? [env.DB.prepare("DELETE FROM blobs WHERE key LIKE 'mday:%' AND substr(key, -10) < ?").bind(cutoff)] : []),
  ]);
}
