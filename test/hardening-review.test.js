// Launch-week hardening, after the review: the token page has words for "too many checks" (never "not launched"); a
// rank answered from the cache is not counted; the transfer proof is sized for phones that share one address and its
// polls are counted per session, with the pages backing off when told to; the link checker answers during a database
// outage; the RPC timeout can be changed from the settings; the admin console has words for every coin-recording answer.
// (The moderator's-unhide finding is covered in test/hardening-social.test.js.)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MINT, advance, browser, newWorld, realClock, useClock, wallet } from "./helpers/world.js";
import { rpc } from "../src/chain.js";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** A stand-in for Cloudflare's Cache API (caches.default), keyed by URL. */
function fakeCaches() {
  const store = new Map();
  return { store, default: {
    async match(req) { const hit = store.get(req.url); return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined; },
    async put(req, res) { store.set(req.url, { body: await res.text(), status: res.status, headers: [...res.headers] }); },
  } };
}
// a chain where the transfer never shows up
const noTransfer = () => async (_url, init) => { const b = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: b.method === "getSignaturesForAddress" ? [] : null })); };
const check = (c) => c.send("/api/auth/transfer/check", { method: "POST", body: {}, fetchImpl: noTransfer() });

let env;
beforeEach(() => { useClock("2026-10-03T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
after(() => { realClock(); delete globalThis.caches; });

/* ---------------- rank: the 429 and what the token page says ---------------- */

test("rank: the 61st check in a minute from one connection is 429 slow_down, and the token page says so instead of 'not launched'", async () => {
  const b = browser(env, { ip: "203.0.113.9" });
  const addr = (await wallet()).address;
  for (let i = 0; i < 60; i++) assert.equal((await b.get(`/api/rank?address=${addr}`)).launched, true, `check ${i + 1}`);
  const r = await b.send(`/api/rank?address=${addr}`);
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: "slow_down" });
  assert.equal((await browser(env, { ip: "203.0.113.10" }).get(`/api/rank?address=${addr}`)).launched, true, "another connection");

  const js = read("token.js");
  const lookup = js.slice(js.indexOf("async function lookup("), js.indexOf('$("#lookup").addEventListener'));
  const slow = lookup.indexOf('if (d.error === "slow_down")');
  assert.ok(slow >= 0, "a branch for slow_down");
  assert.ok(slow < lookup.indexOf("if (!d.launched)"), "before the not-launched text, which it would otherwise fall into");
  assert.match(lookup, /if \(d\.error === "slow_down"\) \{[^\n]*"Too many checks from your network\. Try again in a minute\."/);
  assert.match(lookup, /if \(!d\.launched\) \{[\s\S]*Ranks go live the moment \$VICINITY launches/, "the pre-launch text is still there for before launch");
});

test("rank: an answer from the 30-second cache is not counted, so looking at the same wallet again is free", async () => {
  globalThis.caches = fakeCaches();
  const b = browser(env, { ip: "203.0.113.9" });
  const addr = (await wallet()).address;
  for (let i = 0; i < 100; i++) assert.equal((await b.send(`/api/rank?address=${addr}`)).status, 200, `look ${i + 1}`);
  assert.deepEqual((await env.DB.prepare("SELECT n FROM auth_limits").all()).results.map((r) => r.n), [1], "one miss counted, 99 hits free");
  assert.equal((await b.send("/api/rank?address=nope")).status, 400);
  assert.equal((await b.send(`/api/rank?address=${(await wallet()).address}`)).status, 200, "a new wallet is a miss");
  assert.deepEqual((await env.DB.prepare("SELECT n FROM auth_limits").all()).results.map((r) => r.n), [2], "a bad address costs nothing and is not counted");
});

/* ---------------- the transfer proof: phones share one address ---------------- */

test("transfer proof: 30 starts per connection in 10 minutes, the 31st is 429 slow_down, another connection is fine, and the pages say why", async () => {
  for (let i = 0; i < 30; i++) assert.equal((await browser(env, { ip: "198.51.100.7" }).post("/api/auth/transfer", { address: (await wallet()).address })).ok, true, `start ${i + 1}`);
  const r = await browser(env, { ip: "198.51.100.7" }).send("/api/auth/transfer", { method: "POST", body: { address: (await wallet()).address } });
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: "slow_down" });
  assert.equal((await browser(env, { ip: "198.51.100.8" }).post("/api/auth/transfer", { address: (await wallet()).address })).ok, true);
  advance(10 * 60_000);
  assert.equal((await browser(env, { ip: "198.51.100.7" }).post("/api/auth/transfer", { address: (await wallet()).address })).ok, true, "ten minutes later");
  assert.match(read("connect.js"), /api\("\/api\/auth\/transfer", \{ address: a \}\);\s*if \(!d\.ok\) return setErr\(d\.error === "slow_down" \? "Too many tries from your network right now\. Wait a few minutes and try again\." : "Couldn't start\. Please try again\."\)/);
  assert.match(read("dashboard.js"), /reprove: true \}\);\s*if \(!r\.ok\) return proofErr\(r\.error === "slow_down" \? "Too many tries from your network right now\. Wait a few minutes and try again\." : "Couldn't start\. Try again\."\)/);
});

test("transfer check: counted per session, so two people behind one address polling every 10 seconds for the whole 10 minutes are never refused", async () => {
  const a = browser(env, { ip: "198.51.100.9" }), b = browser(env, { ip: "198.51.100.9" });
  assert.equal((await a.post("/api/auth/transfer", { address: (await wallet()).address })).ok, true);
  assert.equal((await b.post("/api/auth/transfer", { address: (await wallet()).address })).ok, true);
  for (let i = 0; i < 60; i++) {
    for (const c of [a, b]) assert.equal((await (await check(c)).json()).error, "not_found_yet", `poll ${i + 1}`);
    advance(10_000);
  }
  const rows = (await env.DB.prepare("SELECT key, n FROM auth_limits WHERE key LIKE 'pub:transfer_check:%'").all()).results;
  assert.deepEqual(rows.map((r) => r.n), [60, 60], "one counter per session");
  const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM auth_limits").all()).results);
  for (const c of [a, b]) assert.ok(!dump.includes(c.jar.get("vs").slice(0, 12)), "the session token is not in the table");
  assert.ok(!dump.includes("198.51.100"), "nor the address");
});

test("transfer check: one session gets 90 polls in 10 minutes (the page makes 60), then 429; a neighbour is not affected; without a session the connection is counted; the pages back off", async () => {
  const a = browser(env, { ip: "198.51.100.9" }), b = browser(env, { ip: "198.51.100.9" });
  assert.equal((await a.post("/api/auth/transfer", { address: (await wallet()).address })).ok, true);
  assert.equal((await b.post("/api/auth/transfer", { address: (await wallet()).address })).ok, true);
  for (let i = 0; i < 90; i++) assert.equal((await (await check(a)).json()).error, "not_found_yet", `poll ${i + 1}`);
  const r = await check(a);
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: "slow_down" });
  assert.equal((await (await check(b)).json()).error, "not_found_yet", "the neighbour");
  const anon = browser(env, { ip: "198.51.100.9" });
  for (let i = 0; i < 90; i++) assert.equal((await (await check(anon)).json()).error, "no_proof", `anonymous ${i + 1}`);
  assert.equal((await check(anon)).status, 429, "no session: the connection is counted");
  assert.equal((await (await check(b)).json()).error, "not_found_yet", "a session on that connection still has its own counter");
  assert.match(read("connect.js"), /timer = setTimeout\(poll, r\.error === "slow_down" \? 30_000 : 10_000\);/);
  assert.match(read("dashboard.js"), /proofTimer = setTimeout\(poll, c\.error === "slow_down" \? 30_000 : 10_000\);/);
});

/* ---------------- the link checker during a database outage ---------------- */

test("link checker: with the database down an unknown address is 'not official' and $VICINITY is official (never a 500); a short code is logged", async () => {
  const addr = (await wallet()).address;
  const broken = { ...env, DB: { prepare: () => { throw new Error("D1_ERROR: storage unavailable"); }, batch: async () => { throw new Error("D1_ERROR: storage unavailable"); } } };
  const logged = [], orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  let r, d;
  try {
    r = await browser(broken).send(`/api/check?q=${addr}`);
    d = await r.json();
    assert.equal((await browser(broken).get(`/api/check?q=${MINT}`)).verdict, "official");
  } finally { console.error = orig; }
  assert.equal(r.status, 200);
  assert.deepEqual([d.verdict, d.kind], ["not_official", "address"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^city coin lookup skipped D1_ERROR/);
  assert.equal((await browser(env).get(`/api/check?q=${addr}`)).verdict, "not_official", "with the database: as before");
});

/* ---------------- the RPC timeout is a setting ---------------- */

test("RPC_TIMEOUT_MS changes how long a stuck RPC is waited for; anything that is not a positive number means the 8-second default", async () => {
  const stuck = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const keep = setTimeout(() => {}, 20_000); // Node's AbortSignal.timeout does not keep the process alive on its own
  const t0 = performance.now();
  try { await assert.rejects(rpc({ RPC_TIMEOUT_MS: "50" }, "getAccountInfo", [MINT], stuck), /timeout|timed out|abort/i); }
  finally { clearTimeout(keep); }
  assert.ok(performance.now() - t0 < 5000, "well under the default");
  const seen = [];
  const capture = async (_url, init) => { seen.push(init.signal); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null })); };
  for (const v of ["nonsense", "0", "-5", "", undefined]) await rpc({ RPC_TIMEOUT_MS: v }, "getAccountInfo", [MINT], capture);
  assert.equal(seen.length, 5);
  assert.ok(seen.every((s) => s instanceof AbortSignal && !s.aborted), "a timeout is still attached");
});

/* ---------------- the admin console has words for every answer ---------------- */

test("admin console: the stricter coin recording's answers have words, and the re-proof modal stops polling once its code ran out", () => {
  const js = read("dashboard.js");
  const start = js.indexOf("const COIN_ERR = {");
  const map = js.slice(start, js.indexOf("\n  };", start));
  for (const code of ["mint_required", "mint_changed", "not_a_mint", "chain_unavailable"]) assert.match(map, new RegExp(`\\n\\s*${code}: "[^"]{10,}"`), code);
  assert.match(js, /if \(c\.error === "expired" \|\| c\.error === "no_proof"\) \{[^\n]*proofErr\("This code expired\. Get a new one\."\)/);
  assert.match(read("connect.js"), /if \(r\.error === "no_proof" \|\| r\.error === "expired"\) \{ status\.textContent = "This code expired\. Go back and get a new one\."/);
});
