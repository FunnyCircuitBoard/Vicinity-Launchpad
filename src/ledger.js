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
import { activeMint } from "./official.js";
import { getAllHolders, publishHolders } from "./chain.js";
import { getBlob, putBlob, sha256hex } from "./blobs.js";
import { ensureSchema } from "./store.js";

export const dayOf = (ms) => iso(ms).slice(0, 10);
const daysBack = (endDay, n) => Array.from({ length: n }, (_, i) => dayOf(Date.parse(endDay + "T00:00:00Z") - i * DAY));

/** Called by the scheduled job: take a sample now, or not (unpredictably, about once an hour). */
export async function maybeSample(env, now, fetchImpl = fetch, rand = Math.random) {
  if (!env.DB || !activeMint(env)) return { sampled: false, why: "not_launched" };
  await ensureSchema(env.DB);
  const last = await env.DB.prepare("SELECT taken_at FROM balance_samples ORDER BY id DESC LIMIT 1").first();
  const gap = last ? now - Date.parse(last.taken_at) : Infinity;
  const s = POLICY.sampling;
  if (gap < s.minGapMinutes * 60_000) return { sampled: false, why: "too_soon" };
  if (gap < s.maxGapMinutes * 60_000 && rand() >= s.cronMinutes / s.meanMinutes) return { sampled: false, why: "not_this_time" };
  return takeSample(env, now, fetchImpl);
}

/** Record every holder's balance right now. */
export async function takeSample(env, now, fetchImpl = fetch) {
  const db = env.DB;
  await ensureSchema(db);
  const read = await getAllHolders(env, activeMint(env), fetchImpl);
  const { facts, list, labels, slot } = read;
  // the sample read every holder anyway: the holder list, the dashboards and the coin stats of this run use it instead of
  // reading the chain again (a shared copy only; a failure to share is not a failure of the sample)
  await publishHolders(env, activeMint(env), read).catch(() => {});
  const takenAt = iso(now), day = dayOf(now);
  const acc = (await getBlob(db, `day:${day}`)) || { day, n: 0, sums: {}, last: {}, lastAt: null, lastSlot: null, labels: {} };
  acc.n += 1;
  const last = {};
  for (const [owner, amount] of list) { acc.sums[owner] = (acc.sums[owner] || 0) + amount; last[owner] = amount; }
  acc.last = last; acc.lastAt = takenAt; acc.lastSlot = slot; acc.decimals = facts.decimals;
  for (const [owner, label] of labels) acc.labels[owner] = label;
  // the streaks first, the sample's own records last: if the streaks fail (a database hiccup, a limit) nothing says this sample
  // happened, so the next run takes it again instead of waiting an hour with half the founder clocks never started
  await updateStreaks(db, list, takenAt);
  await putBlob(db, `day:${day}`, acc);
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

/** How long has this wallet held `level` tokens in every sample? { since, days, needed, qualified } */
export async function tenure(env, wallet, level, now) {
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
    const acc = await getBlob(env.DB, `day:${d}`);
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
    const acc = await getBlob(env.DB, `day:${d}`);
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
  ]);
}
