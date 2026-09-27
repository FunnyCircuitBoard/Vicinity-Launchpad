import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi, handleVerify } from "../src/index.js";
import { base58Encode, buildMessage } from "../src/solana.js";

// A fake Solana RPC so tests never touch the real network.
const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const POOL_OWNER = "PooL1111111111111111111111111111111111111111";
const WHALE = "WhaLe111111111111111111111111111111111111111";
function fakeRpc({ holdingFor = {}, failLargest = false } = {}) {
  return async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getAccountInfo")
      return ok({ value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } });
    if (method === "getTokenLargestAccounts") {
      if (failLargest) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429 } }));
      return ok({ value: [
        { address: "accPool", amount: "300000000000000", decimals: 6 },
        { address: "accWhale", amount: "50000000000000", decimals: 6 },
        { address: "accWhale2", amount: "10000000000000", decimals: 6 },
      ] });
    }
    if (method === "getMultipleAccounts") {
      const keys = params[0];
      if (keys[0] === "accPool") return ok({ value: [
        { data: { parsed: { info: { owner: POOL_OWNER } } } },
        { data: { parsed: { info: { owner: WHALE } } } },
        { data: { parsed: { info: { owner: WHALE } } } },
      ] });
      return ok({ value: keys.map((k) => ({ owner: k === POOL_OWNER ? "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" : "11111111111111111111111111111111" })) });
    }
    if (method === "getTokenAccountsByOwner") {
      const amt = holdingFor[params[0]] || 0;
      return ok({ value: amt ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: amt } } } } } }] : [] });
    }
    throw new Error("unexpected " + method);
  };
}
const req = (path, init) => new Request("https://vicinity.test" + path, init);

test("before launch: token and holders say not launched, registry is listed", async () => {
  const t = await (await handleApi(req("/api/token"), {})).json();
  assert.equal(t.launched, false);
  assert.ok(t.registry.some((r) => r.symbol === "VICINITY"));
  const h = await (await handleApi(req("/api/holders"), {})).json();
  assert.deepEqual(h, { launched: false, holders: [] });
});

test("token facts show minting and freezing disabled", async () => {
  const t = await (await handleApi(req("/api/token"), { VICINITY_MINT: MINT }, fakeRpc())).json();
  assert.equal(t.facts.mintingDisabled, true);
  assert.equal(t.facts.freezingDisabled, true);
  assert.equal(t.facts.supply, 1_000_000_000);
});

test("holders are grouped by wallet, ranked, labeled, with % of supply", async () => {
  const h = await (await handleApi(req("/api/holders"), { VICINITY_MINT: MINT }, fakeRpc())).json();
  assert.equal(h.holders.length, 2);
  assert.equal(h.holders[0].label, "PumpSwap liquidity pool");
  assert.equal(h.holders[0].percent, 30);
  assert.equal(h.holders[1].owner, WHALE);
  assert.equal(h.holders[1].amount, 60_000_000);
  assert.equal(h.holders[1].label, null);
});

test("holders endpoint fails gracefully when the RPC refuses", async () => {
  const res = await handleApi(req("/api/holders"), { VICINITY_MINT: MINT }, fakeRpc({ failLargest: true }));
  assert.equal(res.status, 503);
});

async function signedBody(host = "vicinity.test") {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const message = buildMessage({ host, address, nonce: "abcdefghijklmnop1234", issuedAt: new Date().toISOString() });
  const signature = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(message))).toString("base64");
  return { address, body: JSON.stringify({ address, message, signature }) };
}

test("verified holder is recognised as a holder (Founding Supporters come from the snapshot); nothing stored", async () => {
  const { address, body } = await signedBody();
  const res = await handleVerify(req("/api/verify", { method: "POST", body }), { VICINITY_MINT: MINT }, Date.now(), fakeRpc({ holdingFor: { [address]: 1234.5 } }));
  const d = await res.json();
  assert.equal(d.verified, true);
  assert.equal(d.holder, true);
  assert.equal(d.amount, 1234.5);
  assert.equal(d.tier, "Holder");
});

test("verified wallet with no tokens is not a holder", async () => {
  const { body } = await signedBody();
  const d = await (await handleVerify(req("/api/verify", { method: "POST", body }), { VICINITY_MINT: MINT }, Date.now(), fakeRpc())).json();
  assert.equal(d.verified, true);
  assert.equal(d.holder, false);
  assert.equal(d.tier, null);
});
