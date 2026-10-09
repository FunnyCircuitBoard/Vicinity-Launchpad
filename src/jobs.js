/**
 * The scheduled job (every 10 minutes, see "triggers" in wrangler.jsonc). Each step is independent:
 * one failing step is logged and the others still run. Everything fails closed: without fresh
 * balance data nobody gains or loses a seat.
 */
import { ensureSchema } from "./store.js";
import { maybeSample, pruneLedger } from "./ledger.js";
import { advanceSeats } from "./seats.js";
import { advanceElections } from "./elections.js";
import { expireModeration } from "./moderation.js";
import { advanceSnapshots } from "./snapshot.js";
import { cleanupSignups } from "./signup-core.js";
import { refreshCoinStats } from "./launchpad.js";
import { recordMarket } from "./pricehistory.js";
import { pruneFeedback } from "./feedback.js";
import { v2On, profilesOn, launchpadV2On } from "./flags.js";
import { DAY, HOUR, iso } from "./policy.js";

/** How long one run may hold the lease: the cron fires every 10 minutes, a run takes seconds. A crashed run's lease simply expires. */
export const JOB_LEASE_MS = 8 * 60_000;
/** Take the lease for this run (an atomic conditional upsert: taken only when no live lease exists). True = ours. */
export async function takeJobLease(db, now) {
  const r = await db.prepare("INSERT INTO settings (key, value) VALUES ('job_lease', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value < ?").bind(iso(now + JOB_LEASE_MS), iso(now)).run();
  return Boolean(r && r.meta && r.meta.changes === 1);
}
const releaseJobLease = (db) => db.prepare("UPDATE settings SET value = '' WHERE key = 'job_lease'").run();

export async function runJobs(env, now = Date.now(), fetchImpl = fetch, rand = Math.random) {
  if (!env.DB) return { skipped: "no database" };
  await ensureSchema(env.DB);
  // two overlapping firings (a slow run, a retry, a manual run next to the cron) must not sample or advance seats twice
  if (!(await takeJobLease(env.DB, now))) return { skipped: "another run holds the lease" };
  try { return await runSteps(env, now, fetchImpl, rand); }
  finally { await releaseJobLease(env.DB).catch((e) => console.error("job lease release failed", String(e))); }
}
async function runSteps(env, now, fetchImpl, rand) {
  const out = {};
  const step = async (name, fn) => {
    try { out[name] = await fn(); }
    catch (e) { console.error("job step failed", name, String((e && e.stack) || e)); out[name] = { error: String((e && e.message) || e) }; }
  };
  await step("sample", () => maybeSample(env, now, fetchImpl, rand));
  await step("seats", () => advanceSeats(env, now, fetchImpl));
  await step("elections", () => advanceElections(env, now, fetchImpl));
  await step("moderation", () => expireModeration(env, now));
  await step("snapshot", () => advanceSnapshots(env, now));
  await step("cleanup", () => cleanup(env, now));
  // the Feedback / Support messages: contact details go 30 days after "done", the row 180 days after (nothing when the table does not exist yet)
  await step("feedback", () => pruneFeedback(env.DB, now));
  // holder counts for the Launchpad list: only while its switch is on (with it off this run is exactly as it always was)
  if (launchpadV2On(env)) await step("coinStats", () => refreshCoinStats(env, now, fetchImpl));
  // the Launchpad's price history: one sample per coin, Raydium's 15-minute candles, the 03:00 pruning (same switch)
  if (launchpadV2On(env)) await step("market", () => recordMarket(env, now, fetchImpl));
  return out;
}

async function cleanup(env, now) {
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM used_nonces WHERE expires_at < ?").bind(iso(now)),
    db.prepare("DELETE FROM rate_events WHERE at < ?").bind(iso(now - 2 * DAY)),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(iso(now)),
    db.prepare("DELETE FROM pairs WHERE expires_at < ?").bind(iso(now)),
    db.prepare("DELETE FROM handoffs WHERE expires_at < ?").bind(iso(now)),
    // sign-in codes: only rows whose code AND hourly send counters are both over (same rule as the tidy-up in handleEmailStart)
    db.prepare("DELETE FROM email_codes WHERE expires_at < ? AND (window_start IS NULL OR window_start < ?)").bind(iso(now), iso(now - HOUR)),
  ]);
  // sign-up v2 leftovers and old attempt counters (profiles share the counters table). With both switches off no new statement runs at all: those tables may not exist yet
  if (v2On(env) || profilesOn(env)) await cleanupSignups(env, now);
  if (new Date(now).getUTCHours() === 3 && new Date(now).getUTCMinutes() < 10) await pruneLedger(env, now);
  return { ok: true };
}
