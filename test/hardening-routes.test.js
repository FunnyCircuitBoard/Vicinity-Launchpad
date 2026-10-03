// Launch-week hardening of the public routes (src/index.js): short edge caches on the reads that scale with
// visitors, and the rate-limit guard called before any blockchain work.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOST, MINT, browser, chain, newWorld, person, realClock, useClock, wallet } from "./helpers/world.js";
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

test("an edge-cache hit tells the visitor the same short max-age as the miss, even when Cloudflare rewrote the stored copy's header to 4 hours", async () => {
  // measured live 3 Oct 2026: a miss went out `no-store` (or max-age=5/30), the next request (cf-cache-status: HIT) went out
  // `public, max-age=14400`: the zone's Browser Cache TTL rewrites what cache.match() returns, so browsers kept it 4 hours
  const rewriting = fakeCaches();
  const match = rewriting.default.match;
  rewriting.default.match = async (req) => {
    const hit = await match(req);
    if (!hit) return hit;
    const out = new Response(hit.body, hit);
    out.headers.set("Cache-Control", "public, max-age=14400");
    return out;
  };
  globalThis.caches = rewriting;
  const b = browser(env);
  for (const [path, maxAge] of [["/api/seats", 30], ["/api/coins", 30], ["/api/members", 60]]) {
    const miss = await b.send(path);
    assert.equal(miss.status, 200, path);
    assert.equal(miss.headers.get("cache-control"), `public, max-age=${maxAge}`, `${path}: the miss`);
    const hit = await b.send(path);
    assert.equal(hit.headers.get("cache-control"), `public, max-age=${maxAge}`, `${path}: the hit`);
    assert.equal(hit.headers.get("x-vicinity-max-age"), null, "the internal header never reaches the visitor");
    assert.equal(await hit.text(), await (await b.send(path)).text());
  }

  // an answer that asks for less (the Launchpad list after a failed market call, max-age=5) keeps its 5 seconds on the hit
  const { _cached: cachedForTest } = await import("../src/index.js");
  const five = () => new Response("{}", { headers: { "Cache-Control": "public, max-age=5", "content-type": "application/json" } });
  const m = await cachedForTest("short-test", 30, five);
  assert.equal(m.headers.get("cache-control"), "public, max-age=5");
  const h = await cachedForTest("short-test", 30, () => { throw new Error("must come from the cache"); });
  assert.equal(h.headers.get("cache-control"), "public, max-age=5");
  assert.equal(h.headers.get("x-vicinity-max-age"), null);
});

test("GET /api/token while the chain is down still names the official contract and the official list (from the settings), and is not cached", async () => {
  const down = async () => new Response("", { status: 503 });
  const res = await browser(env).send("/api/token", { fetchImpl: down });
  assert.equal(res.status, 503);
  const d = await res.json();
  assert.deepEqual([d.launched, d.error, d.mint], [true, "chain_unavailable", MINT]);
  assert.deepEqual([d.registry[0].contract, d.registry[0].status], [MINT, "Live"]);
  assert.deepEqual(keys(), [], "a 503 is not kept");
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

test("/api/verify: the same signed message a second time is 409 replayed; a fresh signature works", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  const w = await wallet();
  const { base58Encode, buildMessage, statementFor } = await import("../src/solana.js");
  const body = async () => {
    const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
    const message = buildMessage({ host: HOST, address: w.address, nonce, issuedAt: new Date(Date.now()).toISOString(), statement: statementFor("verify") });
    return { address: w.address, message, signature: await w.sign(message) };
  };
  const first = await body();
  assert.equal((await browser(env).post("/api/verify", first)).verified, true);
  const again = await browser(env).send("/api/verify", { method: "POST", body: first });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { verified: false, error: "replayed" });
  assert.equal((await browser(env).post("/api/verify", await body())).verified, true, "a fresh signature is fine");
  realClock();
});
