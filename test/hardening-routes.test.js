// Launch-week hardening of the public routes (src/index.js): short edge caches on the reads that scale with
// visitors, and the rate-limit guard called before any blockchain work.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MINT, browser, chain, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { _resetSnapshots } from "../src/chain.js";
import { publicLimit } from "../src/guards.js";

/** A stand-in for Cloudflare's Cache API (caches.default), keyed by URL, so the cached() wrapper can be watched. */
function fakeCaches() {
  const store = new Map();
  return {
    store,
    default: {
      async match(req) { const hit = store.get(req.url); return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined; },
      async put(req, res) { store.set(req.url, { body: await res.text(), status: res.status, headers: [...res.headers] }); },
    },
  };
}
const keys = () => [...globalThis.caches.store.keys()].map((u) => new URL(u).pathname.slice(1)).sort();

let env;
before(() => { useClock("2026-10-20T12:00:00Z"); });
beforeEach(() => { env = newWorld({ VICINITY_MINT: MINT }); globalThis.caches = fakeCaches(); });
after(() => { delete globalThis.caches; realClock(); });

const SOL = "So11111111111111111111111111111111111111112";

test("GET /api/prices is cached for 30 seconds per set of mints, whatever their order", async () => {
  let calls = 0;
  const jup = async () => { calls++; return new Response(JSON.stringify({ [SOL]: { usdPrice: 150 }, [MINT]: { usdPrice: 0.002 } })); };
  const a = await (await browser(env).send(`/api/prices?mints=${MINT},${SOL}`, { fetchImpl: jup })).json();
  const b = await (await browser(env).send(`/api/prices?mints=${SOL},${MINT}`, { fetchImpl: jup })).json();
  assert.deepEqual(a, b);
  assert.equal(calls, 1, "the second request is answered from the cache");
  assert.deepEqual(keys(), [`prices-${[MINT, SOL].sort().join(",")}`]);
  const hit = globalThis.caches.store.get(`https://cache.vicinity.internal/prices-${[MINT, SOL].sort().join(",")}`);
  assert.equal(new Headers(hit.headers).get("cache-control"), "public, max-age=30");
});

test("GET /api/coins (the whole list) is cached for 30 seconds; one city's coin and the admin queue are not", async () => {
  const b = browser(env);
  const first = await b.get("/api/coins");
  assert.deepEqual(keys(), ["coins"]);
  assert.deepEqual(await b.get("/api/coins"), first);
  await b.get("/api/coins?city=5142056");
  await b.get("/api/coins?waiting=1");
  assert.deepEqual(keys(), ["coins"], "nothing else was put in the cache");
  const hit = globalThis.caches.store.get("https://cache.vicinity.internal/coins");
  assert.equal(new Headers(hit.headers).get("cache-control"), "public, max-age=30");
});

test("GET /api/seats (polled by the map every 30 seconds) is cached for 30 seconds", async () => {
  const b = browser(env);
  const first = await b.get("/api/seats");
  assert.deepEqual(keys(), ["seats"]);
  assert.deepEqual(await b.get("/api/claims"), first, "the old name shares the cache");
  assert.equal(new Headers(globalThis.caches.store.get("https://cache.vicinity.internal/seats").headers).get("cache-control"), "public, max-age=30");
});

test("GET /api/rank is cached for 30 seconds per token and wallet; a chain failure is not cached", async () => {
  const p = await person(env, { holds: 500 });
  const down = async () => new Response("", { status: 503 });
  const failed = await browser(env).send(`/api/rank?address=${p.w.address}`, { fetchImpl: down });
  assert.equal(failed.status, 503);
  assert.deepEqual(keys(), [], "a 503 is not kept");
  _resetSnapshots();
  const r = await browser(env).get(`/api/rank?address=${p.w.address}`);
  assert.equal(r.amount, 500);
  assert.deepEqual(keys(), [`rank-${MINT}-${p.w.address}`]);
  assert.equal((await browser(env).send(`/api/rank?address=${p.w.address}`, { fetchImpl: down })).status, 200, "answered from the cache, the chain is not asked");
  assert.equal((await browser(env).send("/api/rank?address=nope")).status, 400);
  assert.deepEqual(keys(), [`rank-${MINT}-${p.w.address}`], "a bad request is not kept either");
});

test("the rate-limit guard (src/guards.js) answers null for a first request and is called first on the public chain-touching routes", async () => {
  const req = new Request("https://vicinity.test/api/rank?address=x", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(await publicLimit(env, req, "rank"), null, "a first request is never over the limit");

  // the wiring, read from the source: the guard runs at the top of each route, before the handler that reaches the blockchain
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const block = (route) => { const i = src.indexOf(`case "${route}":`); assert.ok(i >= 0, route); return src.slice(i, src.indexOf("\n    case ", i + 1)); };
  for (const [route, kind, handler] of [
    ["/api/verify", "verify", "handleVerify("],
    ["/api/auth/transfer", "transfer", "handleTransferStart("],
    ["/api/auth/transfer/check", "transfer_check", "handleTransferCheck("],
    ["/api/pair", "pair", "handlePairStart("],
    ["/api/rank", "rank", "rankResponse("],
  ]) {
    const text = block(route);
    const guard = text.indexOf(`publicLimit(env, request, "${kind}")`);
    assert.ok(guard >= 0, `${route} calls publicLimit with kind "${kind}"`);
    assert.ok(text.indexOf(handler) > guard, `${route}: the guard comes before ${handler}`);
  }
  assert.ok(!block("/api/pair").includes('publicLimit(env, request, "pair")) || handlePairStatus'), "GET /api/pair (a phone polling its code) is not counted");
});

test("with the guard allowing a request, the guarded routes answer as before", async () => {
  const p = await person(env, { holds: 5 });
  assert.equal((await browser(env).get(`/api/rank?address=${p.w.address}`)).amount, 5);
  assert.equal((await browser(env).post("/api/verify", {})).error, "bad_address", "the handler is reached (and refuses an empty body as before)");
  const t = await browser(env).post("/api/auth/transfer", { address: p.w.address });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal((await browser(env).post("/api/pair", {})).ok, true);
});
