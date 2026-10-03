// The balance sample's founder streaks (src/ledger.js updateStreaks) at launch-week scale: the number of database calls must not
// grow with the number of people who buy between two samples, each rung's read must use an index instead of scanning the whole
// table, and a sample whose streaks fail is not recorded (so the next run takes it again).
// Measured on production D1, 3 Oct 2026: 500 streak rows for 5 holders (100 rungs each), the per-rung read "SCAN streaks"
// (rows_read 500 for 5 matches); simulated, the old code passed the 10,000 subrequests of one run at about 5,000 new holders.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { MINT, chain, newWorld, realClock, setHolding, useClock } from "./helpers/world.js";
import { base58Encode } from "../src/solana.js";
import { takeSample, tenure } from "../src/ledger.js";
import { ensureSchema } from "../src/store.js";
import { founderLevels } from "../src/policy.js";

beforeEach(() => useClock("2026-10-04T12:00:00Z"));
after(() => realClock());

const addr = (i) => { const b = new Uint8Array(32); b[0] = 7; b[1] = i >> 16; b[2] = (i >> 8) & 255; b[3] = i & 255; return base58Encode(b); };
/** Count every call the code makes to the database (a batch is one call, as for D1 subrequests) and every statement in them. */
function counted(db) {
  const n = { calls: 0, statements: 0 };
  const wrap = (s) => ({ ...s, raw: s, bind: (...p) => wrap(s.bind(...p)),
    first: (...a) => { n.calls++; n.statements++; return s.first(...a); }, all: () => { n.calls++; n.statements++; return s.all(); }, run: () => { n.calls++; n.statements++; return s.run(); } });
  return { n, db: { ...db, prepare: (sql) => wrap(db.prepare(sql)), batch: (list) => { n.calls++; n.statements += list.length; return db.batch(list.map((x) => x.raw)); } } };
}

test("1,200 new holders in one sample: about 100 database calls (not 2,500), every streak written, the rung reads use the index", async () => {
  const env = newWorld({ VICINITY_MINT: MINT });
  await ensureSchema(env.DB);
  for (let i = 0; i < 1200; i++) setHolding(addr(i), 2_000_000); // above every rung (10K to 1M)
  const c = counted(env.DB);
  await ensureSchema(c.db); c.n.calls = 0; c.n.statements = 0; // the tables are there already: count only the sample
  const r = await takeSample({ ...env, DB: c.db }, Date.now(), chain());
  assert.equal(r.holders, 1200);
  const rungs = founderLevels().length;
  assert.equal(rungs, 100);
  assert.ok(c.n.calls <= rungs + 20, `${c.n.calls} database calls for one sample`);
  assert.ok(c.n.statements <= 2 * rungs + 20, `${c.n.statements} statements (one read and one write per rung, not one write per wallet per rung)`);
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n, COUNT(above_since) AS active FROM streaks").first();
  assert.deepEqual([rows.n, rows.active], [120_000, 120_000]);
  assert.equal((await tenure(env, addr(1199), 1_000_000, Date.now())).since, r.takenAt);

  const plan = env.DB._raw.prepare("EXPLAIN QUERY PLAN SELECT wallet FROM streaks WHERE level = ? AND above_since IS NOT NULL").all(10_000).map((p) => p.detail).join(" | ");
  assert.match(plan, /USING COVERING INDEX streaks_active/, plan);

  // an hour later 700 of them sold down to 50,000: their higher rungs stop, their lower ones keep running, in as few calls
  useClock("2026-10-04T13:00:00Z");
  for (let i = 0; i < 700; i++) setHolding(addr(i), 50_000);
  const c2 = counted(env.DB);
  await ensureSchema(c2.db); c2.n.calls = 0;
  await takeSample({ ...env, DB: c2.db }, Date.now(), chain());
  assert.ok(c2.n.calls <= rungs + 20, `${c2.n.calls} database calls`);
  const below = founderLevels().filter((l) => l <= 50_000).length;
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM streaks WHERE above_since IS NOT NULL").first("n");
  assert.equal(active, 500 * rungs + 700 * below);
  assert.equal((await tenure(env, addr(0), 1_000_000, Date.now())).since, null, "sold below the rung: the clock stopped");
  assert.equal((await tenure(env, addr(0), 50_000, Date.now())).since, r.takenAt, "still above this one: the clock keeps its start");
});

test("a sample whose streaks fail leaves no trace (no sample row, no day blob change), so the next run takes it again", async () => {
  const env = newWorld({ VICINITY_MINT: MINT });
  await ensureSchema(env.DB);
  for (let i = 0; i < 30; i++) setHolding(addr(i), 2_000_000);
  // the streak writes hit the limit; the blob and the sample row would still go through
  const broken = { ...env.DB, batch: async (list) => { if (list.some((x) => /streaks/.test(x.sql))) throw new Error("Too many subrequests."); return env.DB.batch(list); } };
  await assert.rejects(takeSample({ ...env, DB: broken }, Date.now(), chain()), /Too many subrequests/);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM balance_samples").first("n"), 0, "no sample is recorded");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM blobs WHERE key LIKE 'day:%'").first("n"), 0, "the day's sums are untouched");
  const r = await takeSample(env, Date.now(), chain());
  assert.equal(r.sampled, true);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM balance_samples").first("n"), 1);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM streaks WHERE above_since IS NOT NULL").first("n"), 30 * 100);
});
