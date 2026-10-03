// The holder snapshot (src/chain.js holderSnapshot) is read from the chain at most once a minute per data centre: the servers of one
// location share it through a private cache (caches.open). Measured live 3 Oct 2026: every busy server rebuilt it every minute on its
// own (getAccountInfo + getProgramAccounts + getMultipleAccounts), from /api/holders, /api/rank, /api/me, profiles and founder checks.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { MINT, chain, newWorld, realClock, setHolding, useClock, wallet } from "./helpers/world.js";
import { _resetSnapshots, holderSnapshot } from "../src/chain.js";

/** Cloudflare's caches.open(name), backed by a Map: what one data centre's servers share. */
function sharedCaches() {
  const named = new Map();
  const open = async (name) => {
    if (!named.has(name)) {
      const store = new Map();
      named.set(name, { store, match: async (k) => { const r = store.get(String(k)); return r ? r.clone() : undefined; }, put: async (k, res) => { store.set(String(k), res.clone()); } });
    }
    return named.get(name);
  };
  return { open, named, default: { match: async () => undefined, put: async () => {} } };
}
function countingChain() {
  const base = chain(), calls = [];
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); calls.push(Array.isArray(b) ? b[0].method : b.method); return base(url, init); };
  return { fetchImpl, gpa: () => calls.filter((m) => m === "getProgramAccounts").length, calls };
}

let env;
beforeEach(async () => { useClock("2026-10-04T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); setHolding((await wallet()).address, 5_000); globalThis.caches = sharedCaches(); });
afterEach(() => { delete globalThis.caches; _resetSnapshots(); });
after(() => realClock());

test("a second server in the same data centre uses the first one's read for the rest of its minute, then the list is read again", async () => {
  const rpc = countingChain();
  const first = await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.gpa(), 1);
  assert.equal(first.people, 1);

  _resetSnapshots(); // another server (its own memory is empty)
  useClock("2026-10-04T12:00:50Z");
  const second = await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.gpa(), 1, "no second getProgramAccounts in the same minute");
  assert.equal(rpc.calls.length, 3, "and no other chain call either");
  assert.equal(second.at, first.at, "the list says when it was read");
  assert.deepEqual(second.rows, first.rows);

  useClock("2026-10-04T12:01:01Z"); // that server picked the copy up at 50 s: it keeps it only until the copy is a minute old
  await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.gpa(), 2, "a minute after the first read: read again");
  _resetSnapshots();
  await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.gpa(), 2, "and that fresh read is shared again");
});

test("without a shared cache (or when it fails) each server reads the chain as before", async () => {
  const rpc = countingChain();
  delete globalThis.caches;
  await holderSnapshot(env, MINT, rpc.fetchImpl);
  _resetSnapshots();
  await holderSnapshot(env, MINT, rpc.fetchImpl);
  assert.equal(rpc.gpa(), 2);
  globalThis.caches = { open: async () => { throw new Error("cache down"); } };
  _resetSnapshots();
  assert.equal((await holderSnapshot(env, MINT, rpc.fetchImpl)).people, 1, "a cache failure is not an error");
  assert.equal(rpc.gpa(), 3);
});
