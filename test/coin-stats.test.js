// The job's holder-count step (LAUNCHPAD_V2=on): one coin_stats row per launched coin and for $VICINITY, counted with the same
// getProgramAccounts read the holder list uses, at most 40 coins a run, the ones counted longest ago first, a failing coin
// skipped and logged without its address. With the switch off: not one statement.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, POOL, chain, clock, newWorld, person, realClock, setHolding, tick, useClock, wallet } from "./helpers/world.js";
import { CITY_COIN, LP, PENDING, chainFailingFor, mintNo, seedCoin } from "./helpers/launchpad.js";
import { spyDb, schemaOf } from "./helpers/profiles.js";
import { peopleOf, refreshCoinStats } from "../src/launchpad.js";
import { getAllHolders } from "../src/chain.js";
import { OFFICIAL } from "../src/official.js";
import { runJobs } from "../src/jobs.js";

beforeEach(() => useClock("2026-10-12T12:00:00Z"));
after(() => realClock());

const rows = async (db) => (await db.prepare("SELECT mint, holders, updated_at FROM coin_stats ORDER BY mint").all()).results;

test("flag off: the job runs no statement that names coin_stats and the answer has no new step", async () => {
  const env = newWorld({ VICINITY_MINT: MINT });
  env.DB = spyDb(env.DB);
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  const out = await tick(env);
  assert.deepEqual(Object.keys(out), ["sample", "seats", "elections", "moderation", "snapshot", "cleanup", "feedback"]); // "feedback" is the Feedback / Support retention step: no switch, runs on every site (src/feedback.js pruneFeedback)
  assert.ok(!env.DB.log.some((x) => /coin_stats/i.test(x.sql)));
  assert.ok(!(await schemaOf(env.DB)).tables.includes("coin_stats"));
});

test("flag on, nothing launched and no token: the step costs nothing (no RPC call), makes the table and writes no row", async () => {
  const env = LP();
  const net = chainFailingFor("none"), out = await runJobs(env, clock.now, net.fetchImpl, () => 0.99);
  assert.deepEqual(out.coinStats, { counted: 0, failed: 0, left: 0 });
  assert.ok((await schemaOf(env.DB)).tables.includes("coin_stats"));
  assert.deepEqual(await rows(env.DB), []);
  assert.deepEqual(net.calls, [], "the chain was not asked at all");
  // a designed coin and a contract still waiting for the admin are not counted either: the pending address never leaves the database
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", pending: PENDING });
  await seedCoin(env.DB, { city: 5106834, name: "Albany" });
  assert.deepEqual((await runJobs(env, clock.now, net.fetchImpl, () => 0.99)).coinStats, { counted: 0, failed: 0, left: 0 });
  assert.deepEqual(net.calls, []);
});

test("flag on: $VICINITY and every launched coin get a row; the count is people only (pools and team wallets excluded), like the token page", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const a = await person(env, { home: IN_UTICA, holds: 500 }), b = await person(env, { home: IN_UTICA, holds: 20 });
  setHolding((await wallet()).address, 7);
  setHolding(POOL, 1_000_000); // a liquidity pool holds a lot: shown, never counted as a holder
  setHolding(OFFICIAL.teamWallets[0], 2_000_000); // the published team wallet: shown and labelled, never counted as a person (8 Oct 2026)
  setHolding(b.w.address, 0); // sold everything: not a holder
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN, launchedAt: "2026-10-11T10:00:00.000Z" });
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", mint: mintNo(2), launchedAt: "2026-10-11T11:00:00.000Z" });
  await seedCoin(env.DB, { city: 5106834, name: "Albany", pending: PENDING });
  const out = await tick(env, { sample: false });
  assert.deepEqual(out.coinStats, { counted: 3, failed: 0, left: 0 });
  const r = await rows(env.DB);
  assert.deepEqual(r.map((x) => x.mint).sort(), [MINT, CITY_COIN, mintNo(2)].sort());
  const expected = peopleOf(await getAllHolders(env, MINT, chain()));
  assert.equal(expected, 2, "the two wallets that hold something (a and the stranger), not the pool, not the team wallet, not the seller");
  for (const x of r) { assert.equal(x.holders, expected); assert.equal(x.updated_at, new Date(clock.now).toISOString()); }
  assert.ok(a.w.address, "sanity");
  assert.ok(!JSON.stringify(r).includes(PENDING), "a waiting contract is never counted");
});

test("at most 40 coins a run, the ones counted longest ago first; the next run takes the rest", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  setHolding((await wallet()).address, 5);
  for (let i = 1; i <= 45; i++) await seedCoin(env.DB, { city: 900000 + i, name: "City " + i, mint: mintNo(i), launchedAt: new Date(clock.now - i * 60_000).toISOString() });
  const first = await runJobs(env, clock.now, chain(), () => 0.99);
  assert.deepEqual(first.coinStats, { counted: 40, failed: 0, left: 6 });
  const t1 = new Date(clock.now).toISOString();
  let r = await rows(env.DB);
  assert.equal(r.length, 40);
  const uncounted = [MINT, ...Array.from({ length: 45 }, (_, i) => mintNo(i + 1))].filter((m) => !r.some((x) => x.mint === m));
  assert.equal(uncounted.length, 6);

  clock.now += 10 * 60_000;
  const second = await runJobs(env, clock.now, chain(), () => 0.99);
  assert.deepEqual(second.coinStats, { counted: 40, failed: 0, left: 6 });
  const t2 = new Date(clock.now).toISOString();
  r = await rows(env.DB);
  assert.equal(r.length, 46, "every coin and the token now have a row");
  for (const m of uncounted) assert.equal(r.find((x) => x.mint === m).updated_at, t2, "the six never counted came first");
  assert.equal(r.filter((x) => x.updated_at === t1).length, 6, "six of the first run's rows wait for the next run");
  assert.equal(r.filter((x) => x.updated_at === t2).length, 40);

  // a smaller cap for the unit itself
  clock.now += 10 * 60_000;
  assert.deepEqual(await refreshCoinStats(env, clock.now, chain(), { max: 3 }), { counted: 3, failed: 0, left: 43 });
  assert.equal((await rows(env.DB)).filter((x) => x.updated_at === t1).length, 3, "the three oldest were refreshed");
});

test("a coin whose mint account cannot be read is skipped and logged as a short code, never an address; the others are counted", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  setHolding((await wallet()).address, 5);
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", mint: mintNo(2) });
  const net = chainFailingFor(CITY_COIN);
  const noisy = console.error; const logged = [];
  console.error = (...a) => { logged.push(a.join(" ")); };
  let out;
  try { out = await runJobs(env, clock.now, net.fetchImpl, () => 0.99); } finally { console.error = noisy; }
  assert.deepEqual(out.coinStats, { counted: 2, failed: 1, left: 0 });
  const r = await rows(env.DB);
  assert.deepEqual(r.map((x) => x.mint).sort(), [MINT, mintNo(2)].sort());
  assert.ok(logged.some((l) => /coin stats skipped one coin/.test(l)), logged.join("\n"));
  assert.ok(logged.every((l) => !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(l)), "no address in the log: " + logged.join(" | "));
  assert.ok(logged.some((l) => /rpc_http_500/.test(l)), "the short code says what happened");
  // the failed coin keeps its old row when it had one, and is first in line next time
  clock.now += 60_000;
  assert.deepEqual((await runJobs(env, clock.now, chain(), () => 0.99)).coinStats, { counted: 3, failed: 0, left: 0 });
  assert.equal((await rows(env.DB)).find((x) => x.mint === CITY_COIN).holders, 1);
});

test("the holder count follows getAllHolders exactly (one wallet with two token accounts is one holder; zero balances are not holders)", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = (await wallet()).address;
  setHolding(w, 1);
  setHolding((await wallet()).address, 2);
  setHolding((await wallet()).address, 0);
  const all = await getAllHolders(env, MINT, chain());
  assert.equal(all.list.length, 2);
  assert.equal(peopleOf(all), 2);
  assert.equal(peopleOf({ list: [["a", 1], [POOL, 9], ["t", 1]], labels: new Map([[POOL, "Raydium liquidity pool"], ["t", "Team wallet (public)"]]) }), 1, "one definition of people, the token page's: neither a pool nor a team wallet counts");
  assert.deepEqual((await runJobs(env, clock.now, chain(), () => 0.99)).coinStats, { counted: 1, failed: 0, left: 0 });
  assert.equal((await rows(env.DB))[0].holders, 2);
});
