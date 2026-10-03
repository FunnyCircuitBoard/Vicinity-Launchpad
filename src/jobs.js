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
import { v2On } from "./flags.js";
import { DAY, HOUR, iso } from "./policy.js";

export async function runJobs(env, now = Date.now(), fetchImpl = fetch, rand = Math.random) {
  if (!env.DB) return { skipped: "no database" };
  await ensureSchema(env.DB);
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
  if (v2On(env)) await cleanupSignups(env, now); // sign-up v2 leftovers. With the switch off no sign-up statement runs at all: those tables may not exist yet
  if (new Date(now).getUTCHours() === 3 && new Date(now).getUTCMinutes() < 10) await pruneLedger(env, now);
  return { ok: true };
}
