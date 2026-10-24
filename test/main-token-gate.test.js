// MAIN_TOKEN_V5 fails closed (review of stages S02, S02A and S07, findings SWON-1 to SWON-7, SEC-1 to SEC-9 and CHECK-OUTSIDE-TRY). The switch
// counts only while every precondition holds (src/v5policy.js mainTokenV5): the deployed pages and client scripts were built for it (the
// page build writes src/pages-built.js and refuses the switch until the label migration, stage S48), BRAND is the label set they were built
// with, MAIN_TOKEN_MINT and the links are accepted, and the v5 configuration check accepts the deployment (LEGACY_SEATS=frozen included).
// Anything less is today's site exactly. While it counts, the legacy seat machinery, the snapshot, the balance history, the swap and the edge
// cache are each kept to one token. Every mint, handle and channel below is a clearly fake test fixture.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as W from "./helpers/world.js";
import { fakeCaches } from "./helpers/launchpad.js";
import { ACCEPTED, pagesAsCommitted, pagesBuiltWithSwitch } from "./helpers/mainswitch.js";
import worker, { handleApi } from "../src/index.js";
import { runJobs } from "../src/jobs.js";
import { advanceSeats } from "../src/seats.js";
import { advanceElections } from "../src/elections.js";
import { maybeSample, samplesStale, takeSample } from "../src/ledger.js";
import { computeSnapshot } from "../src/snapshot.js";
import { getBlob, putBlob } from "../src/blobs.js";
import { ensureSchema } from "../src/store.js";
import { _resetPolicyCheck, checkPolicyConfig, mainTokenRefusals, mainTokenV5, policyConfig, publicV5 } from "../src/v5policy.js";
import { _resetDeploymentCheck, checkDeploymentConfig } from "../src/maintoken.js";
import { BRANDS } from "../src/brand.js";
import { mainCacheTag, socialProfiles, SOCIAL_PROFILES } from "../src/official.js";
import { officialLinksInPage } from "../src/footer-social.js";
import { _resetSwap } from "../src/swap.js";
import { _resetLaunchpad } from "../src/launchpad.js";
import { _resetCoin } from "../src/coin.js";
import { PAGES_BUILT } from "../src/pages-built.js";
import { PAGES_BUILT_FILE, pageSocials, pagesBuiltSource } from "../scripts/pages/build.mjs";

const FAKE_MINT = "FakeMainTokenMint111111111111111111111111111";
const FAKE_X = "https://x.com/ZqFakeTestX", FAKE_TG = "https://t.me/zq_fake_test_tg";
const LEGACY = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const SOL = "So11111111111111111111111111111111111111112";
const OTHER_TOKEN = "ZqFakeSwapTokenMint111111111111111111111111"; // a clearly fake search result
const BASE = { VICINITY_MINT: LEGACY, LAUNCHPAD_V2: "on", SWAP: "on" };
const FULL = { ...BASE, ...ACCEPTED, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: FAKE_X, OFFICIAL_TELEGRAM_URL: FAKE_TG };

let errors = [];
const realError = console.error;
beforeEach(() => {
  W.useClock("2026-10-24T12:00:00Z");
  pagesAsCommitted(); _resetPolicyCheck(); _resetDeploymentCheck(); _resetSwap(); _resetLaunchpad(); _resetCoin();
  errors = []; console.error = (...a) => errors.push(a.map(String).join(" "));
});
afterEach(() => { console.error = realError; pagesAsCommitted(); W.realClock(); });

/** The test chain plus a Jupiter that quotes anything and whose token search finds the legacy token and another verified one. */
const net = () => async (url, init) => {
  const u = new URL(String(url));
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (/(^|\.)jup\.ag$/.test(u.hostname)) {
    if (u.pathname.endsWith("/swap/v1/quote")) return json({ inAmount: u.searchParams.get("amount"), outAmount: "123456789", otherAmountThreshold: "122222222", routePlan: [{ swapInfo: { label: "ZqFakeDex" } }], priceImpactPct: "0.01" });
    if (u.pathname === "/tokens/v2/search") return json([{ id: LEGACY, symbol: "VICINITY", name: "VICINITY CITY", decimals: 6, isVerified: true }, { id: OTHER_TOKEN, symbol: "ZQ", name: "Zq fake", decimals: 6, isVerified: true }]);
    return json({});
  }
  if (/^launch-(mint|history)-v1\.raydium\.io$/.test(u.host)) return json({ success: true, data: { rows: [] } });
  return W.chain()(url, init);
};
const call = async (env, path, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (init.body) { headers.set("origin", W.ORIGIN); headers.set("content-type", "application/json"); }
  const res = await handleApi(new Request(`${W.ORIGIN}${path}`, { ...init, headers }), env, init.fetchImpl || net(), { waitUntil() {} });
  return { status: res.status, headers: [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)), body: await res.text() };
};
/** Every row of every table, and the schema: what "no D1 change" is checked against. */
async function dump(db) {
  const tables = (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all()).results;
  const out = { schema: tables };
  for (const t of tables.filter((x) => x.sql && /^CREATE TABLE/i.test(x.sql))) out[t.name] = (await db.prepare(`SELECT * FROM "${t.name}"`).all()).results.map((r) => JSON.stringify(r)).sort();
  return out;
}
const holders = () => { W.setHolding("Hdr1111111111111111111111111111111111111111", 2_000_000); W.setHolding("Hdr2222222222222222222222222222222222222222", 150_000); };

/* ---------------------------------------------------------------- the gate */

test("the switch counts only with every precondition; each missing one is named, and anything odd reads as off", () => {
  assert.equal(mainTokenV5({}), false);
  assert.equal(mainTokenV5(BASE), false);
  assert.deepEqual(mainTokenRefusals(FULL), ["MAIN_TOKEN_V5_PAGES_NOT_BUILT"], "the committed pages were not built for the switch");
  assert.equal(mainTokenV5(FULL), false, "a switch set only in the dashboard, with every value accepted, does nothing (SEC-3, SWON-2, SWON-3)");
  pagesBuiltWithSwitch();
  assert.deepEqual(mainTokenRefusals(FULL), []);
  assert.equal(mainTokenV5(FULL), true);
  const cases = [
    [{ ...FULL, BRAND: "citycoin" }, ["MAIN_TOKEN_V5_BRAND_MISMATCH"]],
    [{ ...FULL, MAIN_TOKEN_MINT: undefined }, ["MAIN_TOKEN_V5_CONFIG_REFUSED", "MAIN_TOKEN_V5_POLICY_REFUSED"]],
    [{ ...FULL, MAIN_TOKEN_MINT: LEGACY }, ["MAIN_TOKEN_V5_CONFIG_REFUSED", "MAIN_TOKEN_V5_POLICY_REFUSED"]],
    [{ ...FULL, OFFICIAL_X_URL: "https://x.com/VicinityCitySOL" }, ["MAIN_TOKEN_V5_CONFIG_REFUSED", "MAIN_TOKEN_V5_POLICY_REFUSED"]],
    [{ ...FULL, DEPLOYMENT_ENV: undefined }, ["MAIN_TOKEN_V5_POLICY_REFUSED"]],
    [{ ...FULL, LEGACY_SEATS: undefined }, ["MAIN_TOKEN_V5_POLICY_REFUSED"]],
    [{ ...FULL, SITE_ORIGIN: "https://zq-fake.example" }, ["MAIN_TOKEN_V5_POLICY_REFUSED"]], // not one of SITE_ORIGINS: any v5 error keeps it off
  ];
  for (const [env, codes] of cases) {
    assert.deepEqual(mainTokenRefusals(env), codes, JSON.stringify(env));
    assert.equal(mainTokenV5(env), false);
  }
  const hostile = { ...FULL, get MAIN_TOKEN_MINT() { throw new Error("boom"); } };
  assert.equal(mainTokenV5(hostile), false);
  assert.equal(mainTokenV5({ get MAIN_TOKEN_V5() { throw new Error("boom"); } }), false);
});

test("pages not built for the switch: every value accepted, and the whole API, the footer hook and the job are today's; the reason is logged once", async () => {
  const routes = ["/api/official", "/api/token", "/api/holders", "/api/rank?address=Hdr1111111111111111111111111111111111111111", "/api/seats", "/api/policy",
    "/api/launchpad", `/api/coin?mint=${LEGACY}`, `/api/coin?mint=${FAKE_MINT}`, "/api/swap/config", "/api/swap/tokens?q=vicinity", `/api/check?q=${LEGACY}`,
    `/api/check?q=${FAKE_MINT}`, "/api/check?q=%40VicinityCitySOL", `/api/check?q=${encodeURIComponent(FAKE_X)}`, "/api/members", "/api/coins"];
  const answers = async (env) => { const out = {}; for (const r of routes) { _resetSwap(); _resetLaunchpad(); _resetCoin(); out[r] = await call(env, r); } return out; };
  const off = W.newWorld(BASE); holders();
  const today = await answers(off);
  const on = W.newWorld(FULL); holders();
  assert.deepEqual(await answers(on), today);
  const quote = { method: "POST", body: JSON.stringify({ inputMint: SOL, outputMint: LEGACY, amount: "0.1" }) };
  assert.deepEqual(await call(on, "/api/swap/quote", quote), await call(off, "/api/swap/quote", quote), "the swap is today's too");
  const html = readFileSync(new URL("../public/404.html", import.meta.url), "utf8");
  const res = new Response(html, { status: 404, headers: { "content-type": "text/html" } });
  assert.equal(await officialLinksInPage(res, FULL), res, "the footer hook hands the asset back untouched");
  assert.equal(socialProfiles(FULL), SOCIAL_PROFILES);
  const jobOff = await runJobs(W.newWorld(BASE), Date.now(), net(), () => 0);
  assert.deepEqual(await runJobs(W.newWorld(FULL), Date.now(), net(), () => 0), jobOff);
  checkPolicyConfig(FULL); checkDeploymentConfig(FULL);
  assert.deepEqual(errors.filter((e) => /refused/.test(e)), ["main token switch refused MAIN_TOKEN_V5_PAGES_NOT_BUILT"], "one line, a code, no value");
});

test("the page build writes the marker the Worker reads, and refuses the switch while the client scripts still label the main token $VICINITY", () => {
  assert.equal(readFileSync(PAGES_BUILT_FILE, "utf8"), pagesBuiltSource(), "src/pages-built.js is the build's output for wrangler.jsonc");
  assert.deepEqual({ ...PAGES_BUILT }, { mainTokenV5: false, brand: "" });
  const swapJs = readFileSync(new URL("../public/swap.js", import.meta.url), "utf8");
  assert.match(swapJs, /t\.kind === "vicinity" \? "\$VICINITY"/, "the Buy panel still names the main token $VICINITY (label migration S48)");
  for (const BRAND of [...Object.keys(BRANDS), "citycoin"]) {
    assert.throws(() => pageSocials({ ...FULL, BRAND }), /MAIN_TOKEN_V5=on in wrangler\.jsonc/, `BRAND=${JSON.stringify(BRAND)}`);
    assert.throws(() => pagesBuiltSource({ ...FULL, BRAND }), /MAIN_TOKEN_V5=on in wrangler\.jsonc/);
  }
  assert.match(pagesBuiltSource({ ...BASE, MAIN_TOKEN_V5: "off" }), /mainTokenV5: false, brand: ""/);
});

/* ---------------------------------------------------------------- SWON-1: the legacy seats under the switch */

async function stewardWhoseBalanceFell() {
  W.useClock("2026-10-01T12:00:00Z");
  const env = W.newWorld({ VICINITY_MINT: W.MINT });
  const a = await W.person(env, { home: W.IN_UTICA, holds: 2_000_000 });
  await W.passTime(env, 9 * W.DAY);
  await W.reprove(a);
  const r = await a.post("/api/seats/apply", { attestation: await W.attest(a, W.IN_UTICA, "apply"), pitch: "Utica" });
  assert.equal(r.steward, true, JSON.stringify(r));
  W.setHolding(a.w.address, 10);
  W.advance(10 * 60_000);
  await takeSample(env, Date.now(), W.chain());
  return { env, a };
}

test("SWON-1: while the switch counts, the legacy seats and elections make no new decision: no D1 change, the job skips them, writers answer 410", async () => {
  const off = await stewardWhoseBalanceFell();
  const today = await advanceSeats(off.env, Date.now(), W.chain());
  assert.equal(today.grace, 1, "switch off: the steward under the bar goes into grace, as today");

  const on = await stewardWhoseBalanceFell();
  Object.assign(on.env, ACCEPTED, { MAIN_TOKEN_MINT: FAKE_MINT });
  pagesBuiltWithSwitch();
  assert.equal(mainTokenV5(on.env), true);
  const before = await dump(on.env.DB);
  assert.deepEqual(await advanceSeats(on.env, Date.now(), W.chain()), { skipped: "legacy_seats_frozen" });
  assert.deepEqual(await advanceElections(on.env, Date.now(), W.chain()), { skipped: "legacy_seats_frozen" });
  assert.deepEqual(await dump(on.env.DB), before, "not one row or table changed");
  W.advance(8 * W.DAY);
  const job = await runJobs(on.env, Date.now(), W.chain(), () => 0);
  assert.deepEqual([job.seats, job.elections], [{ skipped: "legacy_seats_frozen" }, { skipped: "legacy_seats_frozen" }]);
  assert.deepEqual((await on.env.DB.prepare("SELECT status, grace_until FROM seats").all()).results, [{ status: "steward", grace_until: null }], "nobody demoted on the new token's balances");
  for (const path of ["/api/seats/apply", "/api/seats/withdraw", "/api/seats/endorse", "/api/seats/object", "/api/seats/resign", "/api/seats/objections/decide",
    "/api/seats/squad/create", "/api/seats/squad/join", "/api/seats/squad/leave", "/api/seats/squad/apply", "/api/elections/vote"]) {
    const r = await on.a.send(path, { method: "POST", body: {} });
    assert.equal(r.status, 410, path);
    assert.equal((await r.json()).error, "seats_frozen", path);
  }
  assert.equal((await on.a.send("/api/seats")).status, 200, "the map and the results stay readable: history");

  // the same settings with pages not built for the switch: exactly today's decision
  pagesAsCommitted();
  const held = await stewardWhoseBalanceFell();
  Object.assign(held.env, ACCEPTED, { MAIN_TOKEN_MINT: FAKE_MINT });
  assert.deepEqual(await advanceSeats(held.env, Date.now(), W.chain()), today);
  assert.equal((await held.a.send("/api/seats/withdraw", { method: "POST", body: {} })).status === 410, false);
});

/* ---------------------------------------------------------------- SWON-5 / SEC-6: no swap for the legacy token */

test("SWON-5, SEC-6: while the switch counts, the swap refuses $VICINITY both ways and the token search leaves it out; otherwise today's swap", async () => {
  const env = W.newWorld(FULL);
  const body = (inputMint, outputMint, taker) => ({ method: "POST", body: JSON.stringify({ inputMint, outputMint, amount: "0.1", ...(taker ? { taker } : {}) }) });
  const held = await call(env, "/api/swap/quote", body(SOL, LEGACY));
  assert.equal(held.status, 200, "pages not built for the switch: today's quote");
  pagesBuiltWithSwitch(); _resetSwap();
  for (const [path, b] of [["/api/swap/quote", body(SOL, LEGACY)], ["/api/swap/quote", body(LEGACY, SOL)], ["/api/swap/tx", body(SOL, LEGACY, "Hdr1111111111111111111111111111111111111111")]]) {
    const r = await call(env, path, b);
    assert.equal(r.status, 409, `${path} ${b.body}`);
    assert.equal(JSON.parse(r.body).error, "legacy_token");
  }
  assert.equal((await call(env, "/api/swap/quote", body(SOL, OTHER_TOKEN))).status, 200, "any other pair is quoted as before");
  const found = JSON.parse((await call(env, "/api/swap/tokens?q=vicinity")).body).tokens.map((t) => t.mint);
  assert.deepEqual(found, [OTHER_TOKEN], "the legacy token is not offered");
});

/* ---------------------------------------------------------------- SEC-1: the snapshot reads one token */

test("SEC-1: the Founding Supporters snapshot reads the $VICINITY series only, whatever the switch says", async () => {
  const run = async (extra) => {
    const env = W.newWorld({ VICINITY_MINT: LEGACY, ...extra });
    await ensureSchema(env.DB);
    for (let i = 1; i <= 14; i++) {
      const d = new Date(Date.parse("2026-10-24T00:00:00Z") - i * W.DAY).toISOString().slice(0, 10);
      await putBlob(env.DB, `day:${d}`, { day: d, n: 1, sums: { A: 5_000_000, B: 7_000_000 }, last: { A: 5_000_000, B: 7_000_000 }, lastAt: `${d}T01:00:00.000Z`, labels: {}, decimals: 6 });
      await putBlob(env.DB, `mday:${FAKE_MINT}:${d}`, { day: d, n: 1, sums: { A: 300 }, last: { A: 300 }, lastAt: `${d}T01:00:00.000Z`, labels: {}, decimals: 9 });
    }
    await computeSnapshot(env, "2026-10-24T00:00:00.000Z", Date.now());
    return (await getBlob(env.DB, "snapshot:1")).rows;
  };
  const today = await run({});
  assert.deepEqual(today, [["A", 5_000_000_000_000, "supporter"], ["B", 7_000_000_000_000, "supporter"]]);
  pagesBuiltWithSwitch();
  assert.equal(mainTokenV5({ VICINITY_MINT: LEGACY, ...ACCEPTED, MAIN_TOKEN_MINT: FAKE_MINT }), true);
  assert.deepEqual(await run({ ...ACCEPTED, MAIN_TOKEN_MINT: FAKE_MINT }), today, "never min(legacy balance, new-token average)");
});

/* ---------------------------------------------------------------- SEC-2 / SWON-6: the balance history of each token */

test("SEC-2, SWON-6: while the switch counts, the history's status, cadence and staleness come from the main token's series; the table stays $VICINITY's", async () => {
  const env = W.newWorld(FULL); holders();
  await ensureSchema(env.DB);
  const at = new Date(Date.now() - 60_000).toISOString();
  await env.DB.prepare("INSERT INTO balance_samples (taken_at, day, slot, holders, hash) VALUES (?, ?, 123, 4321, 'h')").bind(at, at.slice(0, 10)).run();
  const policy = async () => JSON.parse((await call(env, "/api/policy")).body);
  // pages not built for the switch: today's answer, the legacy sample, and the sampler waits as today
  assert.deepEqual((await policy()).balanceHistory, { running: true, lastSample: { taken_at: at, slot: 123, holders: 4321 }, samplesLast24h: 1 });
  assert.deepEqual(await maybeSample(env, Date.now(), net(), () => 0), { sampled: false, why: "too_soon" });
  pagesBuiltWithSwitch();
  let b = await policy();
  assert.equal(b.launched, true);
  assert.deepEqual(b.balanceHistory, { running: false, lastSample: null, samplesLast24h: 0 }, "no $VICINITY sample is shown as the main token's");
  assert.equal(await samplesStale(env, Date.now()), false);
  const s = await maybeSample(env, Date.now(), net(), () => 0);
  assert.equal(s.sampled, true, "the cadence is this token's own: a $VICINITY sample a minute ago does not hold it back");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM balance_samples").first()).n, 1, "the table gets no row of the new token");
  b = await policy();
  assert.deepEqual(b.balanceHistory, { running: true, lastSample: { taken_at: s.takenAt, slot: s.slot, holders: s.holders }, samplesLast24h: 1 });
  assert.deepEqual(await maybeSample(env, Date.now() + 60_000, net(), () => 0), { sampled: false, why: "too_soon" }, "and its own last sample sets the next");
  // a $VICINITY row hours old says nothing about the main token's history: its own fresh sample counts
  await env.DB.prepare("INSERT INTO balance_samples (taken_at, day, slot, holders, hash) VALUES (?, ?, 124, 4321, 'h2')").bind(new Date(Date.now() - 8 * W.HOUR).toISOString(), at.slice(0, 10)).run();
  assert.equal(await samplesStale(env, Date.now()), false, "staleness reads the main token's series, not the table");
  W.advance(7 * W.HOUR);
  assert.equal(await samplesStale(env, Date.now()), true, "and turns stale when that series stops");
});

/* ---------------------------------------------------------------- SEC-7: edge-cache keys */

test("SEC-7: the seats, coins, members and token-search cache keys carry the main token's mode while the switch counts, and are today's otherwise", async () => {
  const keys = async () => {
    const c = fakeCaches(); c.install();
    try {
      const env = W.newWorld(FULL);
      for (const p of ["/api/seats", "/api/coins", "/api/members", "/api/swap/tokens?q=zq"]) assert.equal((await call(env, p)).status, 200, p);
      return [...c.store.keys()].map((u) => new URL(u).pathname.slice(1)).sort();
    } finally { c.uninstall(); }
  };
  assert.deepEqual(await keys(), ["coins", "members", "seats", "swap-tokens-zq"]);
  assert.equal(mainCacheTag(FULL), "");
  pagesBuiltWithSwitch();
  assert.equal(mainCacheTag(FULL), `-v5-${FAKE_MINT}`);
  assert.deepEqual(await keys(), [`coins-v5-${FAKE_MINT}`, `members-v5-${FAKE_MINT}`, `seats-v5-${FAKE_MINT}`, `swap-tokens-zq-v5-${FAKE_MINT}`]);
  assert.match(readFileSync(new URL("../src/cointakedown.js", import.meta.url), "utf8"), /"coins" \+ mainCacheTag\(env\)/, "a takedown purges the key in use");
});

/* ---------------------------------------------------------------- SEC-9 and CHECK-OUTSIDE-TRY */

test("SEC-9: an origin src/site-config.js refuses is refused by the configuration check too, and logged once; nothing set logs nothing", () => {
  const env = { PUBLIC_V5: "on", DEPLOYMENT_ENV: "test", SITE_ORIGIN: "http://localhost", SITE_ORIGINS: "http://localhost" };
  const r = policyConfig(env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.code).sort(), ["SITE_ORIGINS_INVALID", "SITE_ORIGIN_INVALID"]);
  assert.equal(publicV5(env), false, "an accepted configuration is one the Worker really runs with");
  checkPolicyConfig(env); checkPolicyConfig(env);
  assert.deepEqual(errors.sort(), ["policy config refused SITE_ORIGINS_INVALID deployment.inputs.SITE_ORIGINS", "policy config refused SITE_ORIGIN_INVALID deployment.inputs.SITE_ORIGIN"]);
  _resetPolicyCheck(); errors = [];
  checkPolicyConfig({}); checkPolicyConfig(BASE);
  assert.deepEqual(errors, []);
});

test("CHECK-OUTSIDE-TRY: the first-request checks run inside the handler's safety net; a setting that throws never fails the request", async () => {
  const { default: fresh } = await import(`../src/index.js?isolate=${Date.now()}`); // a fresh isolate: its first request runs the checks
  let reads = 0;
  const env = { ASSETS: { fetch: async () => new Response("a{}", { headers: { "content-type": "text/css" } }) } };
  Object.defineProperty(env, "MAIN_TOKEN_V5", { enumerable: true, get() { reads++; throw new Error("boom"); } });
  const res = await fresh.fetch(new Request("https://vicinity.city/style.css"), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "a{}");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(reads > 0, "the checks did read the setting");
  assert.doesNotThrow(() => checkDeploymentConfig(env));
  assert.doesNotThrow(() => checkPolicyConfig(env));
  const health = await worker.fetch(new Request("https://vicinity.city/api/health"), env, { waitUntil() {} });
  assert.equal(health.status, 200);
  // and the checks sit inside the handler's try, in a try of their own (a future fault in one can never change an answer)
  const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const handler = index.slice(index.indexOf("async fetch(request, env, ctx) {"), index.indexOf("async scheduled("));
  assert.match(handler, /^async fetch\(request, env, ctx\) \{\s*try \{\s*if \(!configChecked\) \{\s*configChecked = true;\s*try \{ checkDeploymentConfig\(env\); checkPolicyConfig\(env\); \} catch/);
});
