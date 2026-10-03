// Found by the independent review of sign-up v2 (fails without the fix): with the switch off, the 10-minute job still sent two
// DELETEs against the sign-up tables, which do not exist yet in production. D1 answered "no such table" every tick (silenced in code,
// but visible as failed queries). With the switch off no sign-up statement may run at all.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, browser, clock, newWorld, realClock, tick, useClock } from "./helpers/world.js";
import { startSignup, doTerms, one } from "./helpers/signup.js";

beforeEach(() => useClock("2026-10-01T12:00:00Z"));
after(() => realClock());

function spy(env, log) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const db = env.DB;
  return { ...env, DB: { ...db, prepare: (sql) => { log.push(norm(sql)); return db.prepare(sql); }, batch: (list) => { log.push("BATCH " + list.map((s) => norm(s.sql)).join(" ; ")); return db.batch(list); } } };
}
const signupSql = (log) => log.filter((s) => /signups|auth_limits/.test(s));

test("switch off: the scheduled job runs no sign-up statement", async () => {
  const env = newWorld();
  await browser(env).get("/api/members"); // the normal tables exist, the sign-up ones do not
  const log = [];
  await tick(spy(env, log));
  assert.ok(log.length > 5, "the job ran");
  assert.deepEqual(signupSql(log), []);
  assert.equal((await tick(env)).cleanup.ok, true);
});

test("switch on: the job still removes expired sign-ups", async () => {
  const env = V2();
  const b = browser(env);
  await startSignup(b); await doTerms(b);
  const log = [];
  await tick(spy(env, log));
  // one statement at a time (member profiles share the counters table, so a missing sign-up table must not stop the other delete)
  assert.ok(signupSql(log).some((s) => /DELETE FROM signups/.test(s)) && signupSql(log).some((s) => /DELETE FROM auth_limits/.test(s)), "the two DELETEs ran");
  assert.equal((await one(env.DB, "SELECT COUNT(*) AS n FROM signups")).n, 1, "a live sign-up stays");
  clock.now += 4 * 3600_000; // past the three-hour cap
  await tick(env);
  assert.equal((await one(env.DB, "SELECT COUNT(*) AS n FROM signups")).n, 0, "an expired one goes");
});
