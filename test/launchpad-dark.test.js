// The switch: with LAUNCHPAD_V2 unset (or anything but "on") the Launchpad list is simply not there and the site behaves exactly
// as it always has. These tests are the "dark launch" guarantee: /api/launchpad answers 404 not_enabled whatever the method or
// the caller, /api/official is byte for byte what it was, and a full run of the scheduled job runs no new statement and makes
// no new table. With the switch on, the list is live at once and off again at once.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, ORIGIN, browser, newWorld, person, realClock, tick, useClock } from "./helpers/world.js";
import { CITY_COIN, LP, PENDING, seedCoin } from "./helpers/launchpad.js";
import { spyDb, schemaOf } from "./helpers/profiles.js";
import { LAUNCHPAD_MIGRATION, MIGRATIONS } from "../src/store.js";
import { launchpadV2On } from "../src/flags.js";
import { withMint } from "../src/official.js";
import { _resetLaunchpad } from "../src/launchpad.js";
import { _resetMarket } from "../src/market.js";

beforeEach(() => { useClock("2026-10-12T12:00:00Z"); _resetLaunchpad(); _resetMarket(); });
after(() => realClock());

const OFF = [undefined, "", "off", "ON?", "true", "1", "yes", "onn", "o n", "v2"];
const OFFICIAL_KEYS = ["updated", "websites", "github", "socials", "tokenContract", "teamWallets", "launchpadOpensAt", "tokens", "siteMode"];

test("launchpadV2On: exactly 'on', trimmed, any letter case", () => {
  for (const v of ["on", " on ", "ON", "On", "\ton\n"]) assert.equal(launchpadV2On({ LAUNCHPAD_V2: v }), true, JSON.stringify(v));
  for (const v of OFF) assert.equal(launchpadV2On(v === undefined ? {} : { LAUNCHPAD_V2: v }), false, JSON.stringify(v));
  assert.equal(launchpadV2On(undefined), false);
  assert.equal(launchpadV2On({ LAUNCHPAD_V2: true }), false, "a boolean is not the word on");
});

test("flag off (unset, empty, typos): /api/launchpad answers 404 not_enabled, whoever asks, with any method, from any site", async () => {
  for (const flag of OFF) {
    const env = newWorld(flag === undefined ? {} : { LAUNCHPAD_V2: flag });
    const out = browser(env);
    const member = await person(env, { home: IN_UTICA });
    for (const who of [out, member]) {
      for (const m of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
        const r = await who.send("/api/launchpad", { method: m, body: m === "POST" || m === "PUT" ? {} : undefined });
        assert.equal(r.status, 404, `${flag} ${m}`);
        assert.deepEqual(await r.json(), { ok: false, error: "not_enabled" }, `${flag} ${m}`);
      }
      const r = await who.send("/api/launchpad?tab=live", { method: "POST", body: {}, origin: "https://evil.example" });
      assert.equal(r.status, 404);
    }
    // and no database, or a database with nothing in it, makes no difference
    const r = await browser({}).send("/api/launchpad");
    assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: "not_enabled" }]);
  }
});

test("flag off: /api/official is byte for byte what it was, before and after the token, live and in preview", async () => {
  for (const extra of [{}, { VICINITY_MINT: MINT }, { SITE_MODE: "preview" }, { VICINITY_MINT: MINT, SITE_MODE: "preview", LAUNCHPAD_V2: "off" }]) {
    const env = newWorld(extra);
    const res = await browser(env).send("/api/official");
    const text = await res.text();
    const base = withMint(env);
    const expected = extra.SITE_MODE === "preview"
      ? { ...base, siteMode: "preview", announcedOpensAt: base.launchpadOpensAt, launchpadOpensAt: new Date(Date.now() - 86400000).toISOString() }
      : { ...base, siteMode: "live" };
    assert.equal(text, JSON.stringify(expected), JSON.stringify(extra));
    assert.ok(!text.includes("launchpadV2"));
    assert.deepEqual(Object.keys(JSON.parse(text)).filter((k) => k !== "announcedOpensAt"), OFFICIAL_KEYS);
  }
});

test("flag off: a full run of the job, with launched coins and the token live, runs no new SQL and makes no coin_stats table", async () => {
  const env = newWorld({ VICINITY_MINT: MINT });
  env.DB = spyDb(env.DB);
  await person(env, { home: IN_UTICA, holds: 500 });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", pending: PENDING });
  await seedCoin(env.DB, { city: 5106834, name: "Albany" });
  const out = await tick(env);
  await tick(env, { sample: false });
  assert.deepEqual(Object.keys(out), ["sample", "seats", "elections", "moderation", "snapshot", "cleanup"], "the job's answer has no new step");
  assert.ok(env.DB.log.length > 20, "the spy really saw the run");
  assert.ok(!env.DB.log.some((x) => /coin_stats/i.test(x.sql)), "no statement names coin_stats");
  const all = await schemaOf(env.DB);
  assert.ok(!all.tables.includes("coin_stats"), "no coin_stats table");
  assert.ok(!(await env.DB.prepare("SELECT id FROM schema_migrations").all()).results.some((r) => /launchpad/.test(r.id)));
  assert.ok(!MIGRATIONS.some((m) => m.id === LAUNCHPAD_MIGRATION.id), "never part of the migrations every request runs");
  // the 404s above made nothing either
  await browser(env).send("/api/launchpad");
  assert.ok(!(await schemaOf(env.DB)).tables.includes("coin_stats"));
});

test("flag off: the coin, seat, member and price routes answer exactly as before (nothing new rides along)", async () => {
  const env = newWorld({ VICINITY_MINT: MINT });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  const b = browser(env);
  const coins = await b.get("/api/coins");
  assert.deepEqual(Object.keys(coins), ["coins", "pairs", "vicinity"]);
  assert.deepEqual(Object.keys(coins.coins[0]), ["city", "cityName", "country", "name", "pitch", "pair", "pairMint", "color", "logo", "mint", "launched", "launchedAt", "waiting", "by", "updatedAt"]);
  assert.deepEqual(Object.keys(await b.get("/api/seats")), ["launched", "seats", "windows", "founderAmount"]);
  assert.deepEqual(Object.keys(await b.get("/api/members")), ["members", "communities"]);
  assert.deepEqual(Object.keys(await b.get("/api/policy")), ["policy", "snapshotCutoff", "launched", "balanceHistory"]);
});

test("the switch is read on every request: on makes the list live, off makes it dark again at once (the data stays)", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  await person(env, { home: IN_UTICA, holds: 500 });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  await tick(env); // counts holders into coin_stats
  const b = browser(env);
  const on = await b.get("/api/launchpad");
  assert.equal(on.ok, true);
  assert.equal(on.coins[0].holders.count, 1);
  assert.equal((await b.get("/api/official")).launchpadV2, true);

  env.LAUNCHPAD_V2 = "off"; // flipped in the dashboard
  const r = await b.send("/api/launchpad");
  assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: "not_enabled" }]);
  assert.ok(!("launchpadV2" in await b.get("/api/official")), "dark again, in the very next answer");
  const out = await tick(env);
  assert.ok(!("coinStats" in out), "the job's new step is gone too");

  env.LAUNCHPAD_V2 = "on";
  _resetLaunchpad();
  const again = await b.get("/api/launchpad");
  assert.equal(again.coins[0].holders.count, 1, "what was counted is still there");
  assert.equal((await b.get("/api/official")).launchpadV2, true);
  assert.equal(JSON.stringify(await b.get("/api/official")).endsWith(',"siteMode":"live","launchpadV2":true}'), true, "the new key is last, everything before it unchanged");
});

test("switch on: the first list request creates exactly one new table, once, and nothing else changes", async () => {
  const env = LP();
  const before = await schemaOf(env.DB);
  await person(env, { home: IN_UTICA });
  const mid = await schemaOf(env.DB);
  assert.ok(!mid.tables.includes("coin_stats"), "still nothing before the first list request");
  assert.equal((await browser(env).get("/api/launchpad")).ok, true);
  const after1 = await schemaOf(env.DB);
  assert.deepEqual(after1.tables.filter((t) => !mid.tables.includes(t)), ["coin_stats"]);
  assert.deepEqual(after1.columns, mid.columns, "users gained no column");
  assert.ok(before.tables.length <= mid.tables.length);
  const ids = (await env.DB.prepare("SELECT id FROM schema_migrations").all()).results.map((r) => r.id);
  assert.equal(ids.filter((id) => id === LAUNCHPAD_MIGRATION.id).length, 1);
  assert.ok(!after1.tables.includes("signups") && !after1.tables.includes("follows"), "nothing of the other switches comes with it");
});

test("switch on: wrong method 405, a POST from another site is just a wrong method, no database 503 unavailable", async () => {
  const env = LP();
  const b = browser(env);
  for (const m of ["POST", "PUT", "DELETE"]) {
    const r = await b.send("/api/launchpad", { method: m, body: {} });
    assert.equal(r.status, 405, m);
    assert.deepEqual(await r.json(), { error: "method_not_allowed" });
  }
  assert.equal((await b.send("/api/launchpad", { method: "POST", body: {}, origin: "https://evil.example" })).status, 405);
  assert.equal((await b.send("/api/launchpad", { origin: null })).status, 200, "a GET needs no Origin");
  const r = await browser({ LAUNCHPAD_V2: "on" }).send("/api/launchpad");
  assert.deepEqual([r.status, await r.json()], [503, { ok: false, error: "unavailable" }]);
  assert.equal((await browser({ LAUNCHPAD_V2: "on" }).send("/api/launchpad", { origin: ORIGIN })).status, 503);
});
