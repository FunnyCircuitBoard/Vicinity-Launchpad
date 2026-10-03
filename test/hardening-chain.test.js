// Launch-week hardening of the blockchain reads (src/chain.js): every RPC call gives up after a while instead of
// hanging a request, and a failed holder snapshot is remembered briefly so a burst of dashboards does not
// fire one getProgramAccounts each the moment the RPC is in trouble.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { _resetSnapshots, getHoldings, getTopHolders, holderSnapshot, rpc } from "../src/chain.js";

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const WALLET = "FbvKBmz8YytrTe7SWjPjkUe19edFZumG6hsT3Mv9edg1";
const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));

const realNow = Date.now;
after(() => { Date.now = realNow; _resetSnapshots(); });

test("every RPC call carries a timeout, so a stuck RPC cannot hang a request", async () => {
  const seen = [];
  const capture = async (_url, init) => { seen.push(init); return ok(Array.isArray(JSON.parse(init.body)) ? undefined : { value: [] }); };
  await rpc({}, "getTokenAccountsByOwner", [WALLET, { mint: MINT }], capture);
  assert.ok(seen[0].signal instanceof AbortSignal, "single call: an AbortSignal is attached");
  assert.equal(seen[0].signal.aborted, false);

  // the batched balance lookup has its own fetch: same rule
  const batch = async (_url, init) => { seen.push(init); return new Response(JSON.stringify(JSON.parse(init.body).map((b) => ({ jsonrpc: "2.0", id: b.id, result: { value: [] } })))); };
  await getHoldings({}, [WALLET], MINT, batch);
  assert.ok(seen[1].signal instanceof AbortSignal, "batch call: an AbortSignal is attached");
});

test("a failed holder snapshot is remembered for 5 seconds: concurrent and following callers share the one error instead of each hitting getProgramAccounts", async () => {
  _resetSnapshots();
  let now = Date.parse("2026-10-03T12:00:00Z");
  Date.now = () => now;
  let programAccountCalls = 0;
  const failing = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === "getAccountInfo") return ok({ value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } });
    if (method === "getProgramAccounts") { programAccountCalls++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429 } })); }
    throw new Error("unexpected " + method);
  };
  const outcome = (p) => p.then(() => "ok", (e) => String(e.message || e));

  // three dashboards at the same moment
  const burst = await Promise.all([1, 2, 3].map(() => outcome(holderSnapshot({}, MINT, failing))));
  assert.deepEqual(burst, ["rpc_429", "rpc_429", "rpc_429"], "every caller still gets a clean error");
  assert.equal(programAccountCalls, 1, "one getProgramAccounts for the burst");

  // and more arriving over the next seconds, after the failure is known
  now += 2_000;
  assert.equal(await outcome(holderSnapshot({}, MINT, failing)), "rpc_429");
  now += 2_000;
  assert.equal(await outcome(holderSnapshot({}, MINT, failing)), "rpc_429");
  assert.equal(programAccountCalls, 1, "still one: the failure is remembered");

  // after 5 seconds the RPC is tried again
  now += 1_500;
  assert.equal(await outcome(holderSnapshot({}, MINT, failing)), "rpc_429");
  assert.equal(programAccountCalls, 2, "retried once the 5 seconds passed");
});

test("holders on a Raydium LaunchLab curve and in Raydium's locked LP are named, not just 'Pool or program account'", async () => {
  const CURVE = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"; // some program-controlled addresses
  const LOCK = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";
  const programOf = { [CURVE]: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", [LOCK]: "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE" };
  const fakeRpc = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getAccountInfo") return ok({ value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } });
    if (method === "getTokenLargestAccounts") return ok({ value: [{ address: "accCurve", amount: "700000000000000", decimals: 6 }, { address: "accLock", amount: "200000000000000", decimals: 6 }, { address: "accPerson", amount: "1000000000", decimals: 6 }] });
    if (method === "getMultipleAccounts") {
      if (params[0][0] === "accCurve") return ok({ value: [CURVE, LOCK, WALLET].map((owner) => ({ data: { parsed: { info: { owner } } } })) });
      return ok({ value: params[0].map((k) => ({ owner: programOf[k] || "11111111111111111111111111111111" })) });
    }
    throw new Error("unexpected " + method);
  };
  const { holders } = await getTopHolders({}, MINT, fakeRpc);
  assert.deepEqual(holders.map((h) => h.label), ["Raydium LaunchLab curve", "Raydium locked LP", null]);
});
