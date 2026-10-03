// Fail closed (src/jobs.js): while the balance samples are stale (the chain read has been failing for more than 6 hours), a founder
// window or a manager election that is due waits for the next fresh sample instead of deciding on old balances and on founder
// clocks nothing has checked. Reproduces the finding: a wallet that held 1,000,000 in the last good sample, then sold everything
// while the RPC was down, was seated as Seed Steward by the window that closed 20 hours later.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { MINT, chain, holdings, newWorld, realClock, setHolding, useClock, wallet } from "./helpers/world.js";
import { takeSample } from "../src/ledger.js";
import { runJobs } from "../src/jobs.js";
import { advanceElections } from "../src/elections.js";
import { ensureSchema } from "../src/store.js";

const DAY = 86400_000, HOUR = 3600_000;
const T0 = Date.parse("2026-10-20T00:30:00Z");
const rpcDown = async () => { throw new Error("rpc down"); };
beforeEach(() => useClock(new Date(T0 - 8 * DAY).toISOString()));
after(() => realClock());

async function sellerWithWindow() {
  const env = newWorld({ VICINITY_MINT: MINT });
  await ensureSchema(env.DB);
  const seller = (await wallet()).address;
  setHolding(seller, 1_000_000);
  await takeSample(env, T0 - 8 * DAY, chain());
  useClock(new Date(T0).toISOString());
  await takeSample(env, T0, chain());
  setHolding(seller, 0); // sells everything; from here on the RPC is down
  const now = T0 + 20 * HOUR;
  useClock(new Date(now).toISOString());
  const db = env.DB;
  await db.prepare("INSERT INTO users (wallet, provider, provider_id, handle, home_city, home_name, home_country, created_at) VALUES (?, 'x', 'p1', 'seller', '5142056', 'Utica', 'US', ?)")
    .bind(seller, new Date(T0 - 30 * DAY).toISOString()).run();
  const u = await db.prepare("SELECT id FROM users WHERE wallet = ?").bind(seller).first();
  await db.prepare("INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at) VALUES ('5142056', 'Utica', 'US', 5, 100000, ?, ?)")
    .bind(new Date(T0 - 3 * DAY).toISOString(), new Date(now - 10 * 60_000).toISOString()).run();
  await db.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, created_at) VALUES (1, '5142056', ?, ?, ?)").bind(u.id, seller, new Date(T0 - 2 * DAY).toISOString()).run();
  return { env, db, seller, now };
}

test("a founder window due while the samples are 20 hours old waits (no seat for a wallet that sold), and is decided on the next fresh sample", async () => {
  const { env, db, seller, now } = await sellerWithWindow();
  const out = await runJobs(env, now, rpcDown, () => 0);
  assert.ok(out.sample.error, "the sample failed: the chain is down");
  assert.equal(out.seats.postponed, 1, "the window waits");
  assert.equal(out.seats.closed, 0);
  assert.equal((await db.prepare("SELECT status FROM windows WHERE id = 1").first()).status, "open");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM seats").first("n"), 0, "nobody is seated on 20-hour-old balances");

  // the chain is back: the next run takes a sample first (the seller holds nothing), then decides the window on it
  const later = now + 10 * 60_000;
  useClock(new Date(later).toISOString());
  const back = await runJobs(env, later, chain(), () => 0);
  assert.equal(back.sample.sampled, true);
  assert.equal(back.seats.closed, 1);
  const w = await db.prepare("SELECT status, json_extract(result, '$.decision') AS decision FROM windows WHERE id = 1").first();
  assert.deepEqual([w.status, w.decision], ["empty", "no_valid_applicants"]);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM seats").first("n"), 0);
  assert.equal(holdings[seller] || 0, 0);
});

test("a manager election due while the samples are stale waits too; before the first sample nothing changes", async () => {
  const { env, db, now } = await sellerWithWindow();
  await db.prepare("INSERT INTO elections (country, policy, opened_at, closes_at) VALUES ('US', 5, ?, ?)").bind(new Date(now - 7 * DAY).toISOString(), new Date(now - HOUR).toISOString()).run();
  const out = await advanceElections(env, now, rpcDown);
  assert.equal(out.postponed, 1);
  assert.equal(out.decided, 0);
  assert.equal((await db.prepare("SELECT status FROM elections WHERE id = 1").first()).status, "open");

  // no sample ever taken (before the first one after launch): decided as before, from the chain
  const fresh = newWorld({ VICINITY_MINT: MINT });
  await ensureSchema(fresh.DB);
  await fresh.DB.prepare("INSERT INTO elections (country, policy, opened_at, closes_at) VALUES ('US', 5, ?, ?)").bind(new Date(now - 7 * DAY).toISOString(), new Date(now - HOUR).toISOString()).run();
  const first = await advanceElections(fresh, now, chain());
  assert.equal(first.decided, 1);
  assert.equal(first.postponed, undefined);
});

test("the pages explain window_closing (an expired window waiting for fresh balances) instead of showing a raw code", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["dashboard.js", "dashboard-roles.js"])
    assert.match(readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8"), /window_closing: "This city's window has ended and is being decided\. Try again in a few minutes\."/, f);
});
