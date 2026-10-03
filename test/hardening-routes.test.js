// Launch-week hardening of the public routes (src/index.js): short edge caches on the reads that scale with
// visitors, and the rate-limit guard called before any blockchain work.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MINT, browser, chain, newWorld, person, realClock, useClock } from "./helpers/world.js";

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
