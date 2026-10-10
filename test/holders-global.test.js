// The holder list is read from the chain about once a minute WORLDWIDE (10 Oct 2026: the free Helius plan ran out of credits;
// every data centre with an open token page or dashboard read its own list every minute, 12 credits each). One D1 copy is shared by
// every data centre, a 30-second lease lets one caller rebuild it, a failure is remembered in the data centre for 10 s, the display
// routes show the last list (at most 15 minutes old, with its real time) instead of an error, the job's coin count and balance
// sample reuse the same list, and the mint's facts are read once per 10 minutes. Callers that decide something never get an old list.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { MINT, ORIGIN, chain, clock, holdings, newWorld, realClock, setHolding, useClock, wallet } from "./helpers/world.js";
import { SHOW_STALE_MS, _forgetServerMemory, _resetSnapshots, getAllHolders, holderSnapshot, liveAmounts } from "../src/chain.js";
import { ensureSchema } from "../src/store.js";
import { handleApi } from "../src/index.js";
import { runJobs } from "../src/jobs.js";
import { refreshCoinStats } from "../src/launchpad.js";

/** Cloudflare's caches.open(name) for ONE data centre, backed by Maps. */
function dataCentre() {
  const named = new Map();
  return { open: async (name) => {
    if (!named.has(name)) {
      const store = new Map();
      named.set(name, { match: async (k) => { const r = store.get(String(k)); return r ? r.clone() : undefined; }, put: async (k, res) => { store.set(String(k), res.clone()); } });
    }
    return named.get(name);
  }, default: { match: async () => undefined, put: async () => {} } };
}
/** The test chain, counting calls by method, with a switch that makes getProgramAccounts fail like a provider out of credits. */
function countingChain() {
  const base = chain(), calls = [];
  const state = { down: false };
  const fetchImpl = async (url, init) => {
    if (!init || typeof init.body !== "string") return base(url, init); // not a JSON-RPC call (a market source)
    const b = JSON.parse(init.body), method = Array.isArray(b) ? b[0].method : b.method;
    calls.push(method);
    if (state.down && method === "getProgramAccounts") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "max usage reached" } }));
    return base(url, init);
  };
  return { fetchImpl, calls, state, count: (m) => calls.filter((x) => x === m).length };
}

/** Change the fake chain without telling the server (setHolding would also make every server forget its list). */
const setHoldingQuietly = (address, amount) => { holdings[address] = amount; };

let env, me;
const T0 = "2026-10-10T15:00:00Z";
beforeEach(async () => {
  useClock(T0);
  env = newWorld({ VICINITY_MINT: MINT });
  await ensureSchema(env.DB);
  me = (await wallet()).address;
  setHolding(me, 5_000);
  globalThis.caches = dataCentre();
});
afterEach(() => { delete globalThis.caches; _resetSnapshots(); });
after(() => realClock());
const otherDataCentre = () => { _forgetServerMemory(); globalThis.caches = dataCentre(); };
const holders = async (fetchImpl) => {
  const res = await handleApi(new Request(`${ORIGIN}/api/holders`), env, fetchImpl);
  return { status: res.status, data: await res.json() };
};

test("a second data centre uses the first one's list for the rest of its minute (one getProgramAccounts worldwide), then it is read again", async () => {
  const rpc = countingChain();
  const first = await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.count("getProgramAccounts"), 1);
  otherDataCentre();
  clock.now += 40_000;
  const second = await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.count("getProgramAccounts"), 1, "no second read in another data centre within the minute");
  assert.equal(second.at, first.at, "it says when the list was read");
  assert.deepEqual(second.rows, first.rows);
  otherDataCentre();
  clock.now += 21_000; // 61 s after the read: too old for everyone
  await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.count("getProgramAccounts"), 2);
  assert.equal((await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("holders_lease:" + MINT).first()).value, "", "the rebuilder gave its lease back");
});

test("one rebuild at a time: while another caller holds the lease, a list a few seconds past its minute is used; a much older one is read directly", async () => {
  const rpc = countingChain();
  await holderSnapshot(env, MINT, rpc.fetchImpl);
  const lease = (at) => env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("holders_lease:" + MINT, new Date(at).toISOString()).run();
  clock.now += 70_000;
  await lease(clock.now + 20_000); // someone else is rebuilding right now
  otherDataCentre();
  const snap = await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.count("getProgramAccounts"), 1, "no second read while the lease is held");
  assert.equal(snap.at, T0.replace("Z", ".000Z"), "the list from 70 s ago");
  clock.now += 30_000; // 100 s old, and the lease still held (a stuck rebuilder): read it ourselves, as before
  await lease(clock.now + 20_000);
  otherDataCentre();
  await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.count("getProgramAccounts"), 2);
});

test("the provider fails: the pages show the last list (with its real time) instead of an error, and stop asking; deciding callers never get an old list", async () => {
  const rpc = countingChain();
  const before = await holders(rpc.fetchImpl);
  assert.equal(before.status, 200);
  clock.now += 3 * 60_000;
  setHoldingQuietly(me, 9_000); // the wallet bought more since: only a fresh read knows
  rpc.state.down = true;
  _forgetServerMemory();
  const during = await holders(rpc.fetchImpl);
  assert.equal(during.status, 200, "no chain_unavailable while a recent list exists");
  assert.equal(during.data.updatedAt, before.data.updatedAt, "the list says when it was read");
  assert.equal(during.data.holders[0].amount, 5_000);
  // voting power and founder checks read the wallet itself (getTokenAccountsByOwner), never the old list
  const live = await liveAmounts(env, [me], rpc.fetchImpl, { mint: MINT });
  assert.equal(live.get(me), 9_000);
  // the other servers of this data centre do not each ask the failing provider again for 10 s
  const gpa = rpc.count("getProgramAccounts");
  _forgetServerMemory();
  clock.now += 5_000;
  await holderSnapshot(env, MINT, rpc.fetchImpl, 60_000, { staleMs: SHOW_STALE_MS });
  assert.equal(rpc.count("getProgramAccounts"), gpa, "remembered in the data centre");
  await assert.rejects(holderSnapshot(env, MINT, rpc.fetchImpl), /rpc_-32429/, "a caller without staleMs gets the error");
  // past 15 minutes the old list is not shown any more: the page's fallback answers, as before
  _forgetServerMemory();
  clock.now += SHOW_STALE_MS;
  const late = await holders(rpc.fetchImpl);
  assert.deepEqual([late.status, late.data], [503, { launched: true, error: "chain_unavailable" }], "the answer of before (this fake has no top-20 fallback), not a list 18 minutes old");
});

test("the job: the balance sample's read is shared, and the $VICINITY holder count reuses the list instead of its own getProgramAccounts", async () => {
  const lpEnv = { ...env, LAUNCHPAD_V2: "on" };
  // a page has read the list a moment ago: the job's count costs no chain read
  const rpc = countingChain();
  const snap = await holderSnapshot(lpEnv, MINT, rpc.fetchImpl);
  clock.now += 30_000;
  const out = await refreshCoinStats(lpEnv, clock.now, rpc.fetchImpl);
  assert.deepEqual(out, { counted: 1, failed: 0, left: 0 });
  assert.equal(rpc.count("getProgramAccounts"), 1);
  const row = await lpEnv.DB.prepare("SELECT holders, updated_at FROM coin_stats WHERE mint = ?").bind(MINT).first();
  assert.deepEqual(row, { holders: 1, updated_at: snap.at }, "the row says when the list was read");
  // a run that takes a balance sample reads the chain ONCE: the sample's list is the count's list
  _resetSnapshots();
  clock.now += 60 * 60_000;
  const run = countingChain();
  const r = await runJobs(lpEnv, clock.now, run.fetchImpl, () => 0);
  assert.equal(r.sample.sampled, true, JSON.stringify(r.sample));
  assert.equal(run.count("getProgramAccounts"), 1, "one read for the sample and the count");
  // and the next minute a page shows that list without reading the chain
  const page = countingChain();
  otherDataCentre();
  clock.now += 20_000;
  await holderSnapshot(lpEnv, MINT, page.fetchImpl);
  assert.equal(page.count("getProgramAccounts"), 0, "the sample's list is shared with every data centre");
});

test("the mint's facts are read once per 10 minutes for the holder list, not at every read", async () => {
  const rpc = countingChain();
  await getAllHolders(env, MINT, rpc.fetchImpl);
  clock.now += 5 * 60_000;
  await getAllHolders(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.count("getAccountInfo"), 1);
  assert.equal(rpc.count("getProgramAccounts"), 2, "the holders themselves are read each time");
  clock.now += 5 * 60_000;
  await getAllHolders(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.count("getAccountInfo"), 2, "after 10 minutes: read again");
});
