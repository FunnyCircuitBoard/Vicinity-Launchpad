// The backup RPC (10 Oct 2026: the free Helius key ran out and every chain read of the site failed at once). Every Solana JSON-RPC
// request of the Worker goes through src/rpcpool.js: with SOLANA_RPC_URL_BACKUP set, a PROVIDER failure (HTTP 401/402/403/429/5xx,
// fetch error, timeout, -32429 / -32005 / "max usage reached") is asked again of the backup, never an answer every node would give
// (bad params, a preflight failure, a missing account); an endpoint that failed is asked last for 60 s; a devnet call never reaches a
// mainnet node; a signed transaction goes to the backup at most once, as the same bytes; and no error or log line ever carries a URL.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getHoldings, getMintBalances, getTokenFacts, rpc, rpcAnswer } from "../src/chain.js";
import { BREAKER_MS, MAINNET_GENESIS, _resetRpcHealth, providerRefusal, rpcHealth, rpcPost, rpcTargets } from "../src/rpcpool.js";
import { _resetRelay, handleBalances, handleSend, handleStatus, rpcRaw } from "../src/relay.js";
import { compileLegacy, wrapUnsigned } from "../src/sol/message.js";
import { toBase64 } from "../src/sol/bytes.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { base58Encode } from "../src/solana.js";
import { clock, realClock, useClock } from "./helpers/world.js";

const PRIMARY = "https://primary.rpc.example/?api-key=PRIMARYSECRET";
const BACKUP = "https://backup.rpc.example/v1/BACKUPSECRET";
const DEVNET_URL = "https://devnet.rpc.example/?api-key=DEVNETSECRET";
const LP_URL = "https://launchpad.rpc.example/?api-key=LPSECRET";
const SECRETS = ["PRIMARYSECRET", "BACKUPSECRET", "DEVNETSECRET", "LPSECRET", "api-key", "rpc.example"];
const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const OWNER = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p", OTHER = "47ugnHuxsmgNZu8KEv1VXW7wPVVwMWti8vVrK4ADDxWa";
const ENV = { SOLANA_RPC_URL: PRIMARY, SOLANA_RPC_URL_BACKUP: BACKUP };

/** A healthy node's answer to each method the Worker asks. */
function answer({ method, params }) {
  if (method === "getAccountInfo") return { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000", mintAuthority: null, freezeAuthority: null } } } } };
  if (method === "getBalance") return { context: { slot: 1 }, value: 2_000_000_000 };
  if (method === "getTokenAccountsByOwner") return { value: [{ account: { data: { parsed: { info: { mint: params[1].mint, tokenAmount: { amount: "5000000", decimals: 6, uiAmount: 5 } } } } } }] };
  if (method === "getSignatureStatuses") return { context: { slot: 1 }, value: [null] };
  if (method === "getBlockHeight") return 1000;
  if (method === "sendTransaction") return base58Encode(new Uint8Array(64).fill(7));
  if (method === "getGenesisHash") return MAINNET_GENESIS;
  return null;
}
const ok = (body) => new Response(JSON.stringify(Array.isArray(body) ? body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: answer(b) })) : { jsonrpc: "2.0", id: 1, result: answer(body) }));
const rpcErr = (code, message, data) => (body) => new Response(JSON.stringify(Array.isArray(body) ? body.map((b) => ({ jsonrpc: "2.0", id: b.id, error: { code, message, data } })) : { jsonrpc: "2.0", id: 1, error: { code, message, data } }));
const http = (status, text = "busy") => () => new Response(text, { status });
// how Helius answers a key whose monthly credits are used up (an account-wide refusal, not "too fast right now")
const outOfCredits = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32429, message: "max usage reached" } }), { status: 429 });
/** A provider that never answers but honours the caller's AbortSignal (a ref'd timer keeps the test alive: AbortSignal.timeout's is not). */
const hang = (init) => new Promise((_, reject) => {
  const keep = setTimeout(() => reject(new Error("the caller never gave up")), 5_000);
  init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); });
});

/**
 * Two (or more) fake providers: each URL answers with its own behaviour; every call is recorded as [who, method, body]. The
 * backup's one-time genesis check (src/rpcpool.js) is answered as mainnet and recorded apart (`genesis`), so `calls` is the traffic.
 */
function network(byUrl, { genesis = MAINNET_GENESIS } = {}) {
  const calls = [], checks = [];
  const fetchImpl = async (url, init) => {
    const who = url === PRIMARY ? "primary" : url === BACKUP ? "backup" : url === DEVNET_URL ? "devnet" : url === LP_URL ? "launchpad" : "other:" + new URL(url).host;
    const body = JSON.parse(init.body);
    if (!Array.isArray(body) && body.method === "getGenesisHash") { checks.push(who); return typeof genesis === "function" ? genesis(init) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: genesis })); }
    calls.push([who, Array.isArray(body) ? body[0].method : body.method, init.body]);
    const b = byUrl[who] || ok;
    return b(body, init, url);
  };
  return { fetchImpl, calls, checks, who: () => calls.map((c) => c[0]) };
}

let logs;
const quiet = {};
beforeEach(() => {
  _resetRpcHealth(); _resetRelay(); useClock("2026-10-10T14:20:00Z");
  logs = [];
  for (const k of ["log", "warn", "error"]) { quiet[k] = console[k]; console[k] = (...a) => logs.push(a.map(String).join(" ")); }
});
afterEach(() => { for (const k of ["log", "warn", "error"]) console[k] = quiet[k]; realClock(); });
const noSecretIn = (text, what) => { for (const s of SECRETS) assert.ok(!String(text).includes(s), `${what} carries "${s}": ${text}`); };

test("no backup set: one node, exactly as before (same request, same error), and no failover line", async () => {
  const net = network({ primary: http(429) });
  await assert.rejects(rpc({ SOLANA_RPC_URL: PRIMARY }, "getAccountInfo", [MINT, { encoding: "jsonParsed" }], net.fetchImpl), (e) => e.message === "rpc_http_429" && e.code === undefined);
  assert.deepEqual(net.who(), ["primary"]);
  assert.deepEqual(rpcTargets({ SOLANA_RPC_URL: PRIMARY }).map((t) => t.role), ["primary"]);
  assert.deepEqual(rpcTargets({}).map((t) => t.url), ["https://api.mainnet-beta.solana.com"], "no URL at all: the public endpoint, as before");
  assert.deepEqual(rpcTargets({ SOLANA_RPC_URL: PRIMARY, SOLANA_RPC_URL_BACKUP: ` ${PRIMARY} ` }).length, 1, "a backup equal to the primary is no backup");
  assert.ok(!logs.some((l) => /failover/.test(l)));
  // and a good answer is a good answer
  const good = network({});
  assert.equal((await getTokenFacts({ SOLANA_RPC_URL: PRIMARY }, MINT, good.fetchImpl)).decimals, 6);
  assert.deepEqual(good.who(), ["primary"]);
});

test("every provider failure is served by the backup: HTTP 401/402/403/429/5xx, -32429 'max usage reached', -32005, a network error, a timeout, a body that is not JSON", async () => {
  const failures = {
    http_401: http(401), http_402: http(402), http_403: http(403), http_429: http(429), http_500: http(500), http_503: http(503),
    "rpc_-32429": rpcErr(-32429, "max usage reached"), "rpc_-32005": rpcErr(-32005, "Too many requests for a specific RPC call"),
    "rpc_-32601": rpcErr(-32601, "Method not found"), "rpc_-32000": rpcErr(-32000, "Your API key has exceeded its credits"),
    network: () => { throw new TypeError(`Fetch API cannot load: ${PRIMARY}`); },
    timeout: (body, init) => hang(init),
    bad_json: () => new Response("<html>502 Bad Gateway</html>", { status: 200 }),
  };
  for (const [reason, behaviour] of Object.entries(failures)) {
    _resetRpcHealth(); logs.length = 0;
    const net = network({ primary: behaviour });
    const facts = await getTokenFacts({ ...ENV, RPC_TIMEOUT_MS: "40" }, MINT, net.fetchImpl);
    assert.equal(facts.supply, 1_000_000, reason);
    assert.deepEqual(net.who(), ["primary", "backup"], reason);
    assert.equal(net.calls[0][2], net.calls[1][2], "the very same request");
    assert.ok(logs.some((l) => l === `rpc failover primary -> backup reason=${reason}`), `${reason}: ${logs.join(" | ")}`);
    for (const l of logs) noSecretIn(l, "a log line");
  }
});

test("an answer every node would give is NOT asked again: bad params, a node's verdict on a transaction, a missing account", async () => {
  const net = network({ primary: rpcErr(-32602, "Invalid param: WrongSize") });
  await assert.rejects(rpc(ENV, "getAccountInfo", ["x"], net.fetchImpl), /rpc_-32602/);
  assert.deepEqual(net.who(), ["primary"]);
  const missing = network({ primary: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } })) });
  assert.deepEqual(await rpc(ENV, "getAccountInfo", [MINT], missing.fetchImpl), { context: { slot: 1 }, value: null }, "null is an answer");
  assert.deepEqual(missing.who(), ["primary"]);
  // a preflight failure (data.err + logs), a bad signature, a blockhash the node does not know: the transaction's own fault
  for (const err of [{ code: -32002, message: "Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1771", data: { err: { InstructionError: [2, { Custom: 6001 }] }, logs: ["Program log: rate limit"] } },
    { code: -32003, message: "Transaction signature verification failure" },
    { code: -32002, message: "Transaction simulation failed: Blockhash not found", data: { err: "BlockhashNotFound", logs: [] } },
    { code: -32603, message: "Internal error" }]) {
    const n = network({ primary: rpcErr(err.code, err.message, err.data) });
    const d = await rpcRaw(ENV, "sendTransaction", ["AA==", { encoding: "base64" }], n.fetchImpl);
    assert.equal(d.error.code, err.code);
    assert.deepEqual(n.who(), ["primary"], err.message);
  }
  assert.equal(providerRefusal({ code: -32603, message: "Internal error" }), "rpc_-32603", "a read is asked again elsewhere after an internal error");
  assert.equal(providerRefusal({ code: -32603, message: "Internal error" }, { send: true }), null, "a transaction is not");
  assert.equal(providerRefusal({ code: -32002, message: "max usage", data: { err: "x" } }), null, "a verdict stays a verdict whatever its words");
  assert.equal(providerRefusal({ code: -32000, message: "Program failed to complete" }), null);
  assert.equal(providerRefusal(null), null);
});

test("breaker: after the provider as a whole failed (credits used up) the backup is asked FIRST for 60 s (the primary not at all), then one request probes the primary", async () => {
  let primaryDown = true;
  const net = network({ primary: (b) => (primaryDown ? outOfCredits() : ok(b)) });
  await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
  assert.deepEqual(net.who(), ["primary", "backup"]);
  net.calls.length = 0;
  clock.now += 30_000;
  for (let i = 0; i < 3; i++) await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
  assert.deepEqual(net.who(), ["backup", "backup", "backup"], "no request waits on the dead provider");
  const h = rpcHealth(clock.now);
  assert.equal(h.primary.lastReason, "http_429");
  assert.equal(h.primary.askedLastUntil, new Date(Date.parse("2026-10-10T14:20:00Z") + BREAKER_MS).toISOString());
  assert.equal(h.primary.probingUntil, null);
  noSecretIn(JSON.stringify(h), "the health view");
  // the backup failing too while the primary is still benched: the primary is still asked (last), so one failure is not an outage
  net.calls.length = 0;
  const both = network({ primary: ok, backup: http(503) });
  assert.equal(await rpc(ENV, "getBlockHeight", [], both.fetchImpl), 1000);
  assert.deepEqual(both.who(), ["backup", "primary"]);
  // 60 s after the last failure of the primary: probed again; still down -> benched again; back up -> first again
  _resetRpcHealth();
  await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
  net.calls.length = 0;
  clock.now += BREAKER_MS + 1;
  await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
  assert.deepEqual(net.who(), ["primary", "backup"], "the probe");
  net.calls.length = 0;
  primaryDown = false;
  clock.now += BREAKER_MS + 1;
  await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
  await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
  assert.deepEqual(net.who(), ["primary", "primary"], "a good probe closes the breaker");
  assert.equal(rpcHealth(clock.now).primary.askedLastUntil, null);
});

test("both providers down: the error is a short code (never a URL), the last one's", async () => {
  const net = network({ primary: () => { throw new TypeError(`Fetch API cannot load: ${PRIMARY}`); }, backup: http(429) });
  let caught;
  try { await rpc(ENV, "getAccountInfo", [MINT], net.fetchImpl); } catch (e) { caught = e; }
  assert.equal(caught.message, "rpc_http_429");
  const net2 = network({ primary: http(429), backup: () => { throw new TypeError(`Fetch API cannot load: ${BACKUP}`); } });
  _resetRpcHealth();
  try { await rpc(ENV, "getAccountInfo", [MINT], net2.fetchImpl); } catch (e) { caught = e; }
  assert.equal(caught.message, "rpc_network");
  noSecretIn(caught.message + caught.stack, "the error");
  // a refusal answer from both: the caller reads the node's error as before
  const net3 = network({ primary: rpcErr(-32429, "max usage reached"), backup: rpcErr(-32429, "max usage reached") });
  _resetRpcHealth();
  await assert.rejects(rpc(ENV, "getAccountInfo", [MINT], net3.fetchImpl), /^Error: rpc_-32429$/);
  for (const l of logs) noSecretIn(l, "a log line");
});

test("a devnet call never reaches a mainnet node (and the backup is mainnet only); the launchpad on mainnet puts its own URL first", async () => {
  assert.deepEqual(rpcTargets(ENV, { cluster: "devnet", url: DEVNET_URL }).map((t) => t.role), ["devnet"]);
  const net = network({ devnet: http(503) });
  await assert.rejects(rpc(ENV, "getBlockHeight", [], net.fetchImpl, { cluster: "devnet", url: DEVNET_URL }), /rpc_http_503/);
  assert.deepEqual(net.who(), ["devnet"], "no failover to a mainnet node");
  // the relay's devnet routes (LAUNCHPAD_TRADING on, devnet): status and balances stay on devnet even when it fails
  const lpEnv = { ...ENV, LAUNCHPAD_TRADING: "on", LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_RPC_URL: DEVNET_URL };
  const sig = base58Encode(new Uint8Array(64).fill(9));
  const st = await handleStatus(new Request(`https://x.test/api/swap/status?sig=${sig}&lvbh=5&cluster=devnet`), lpEnv, net.fetchImpl);
  assert.equal(st.status, 503);
  const bal = await handleBalances(new Request(`https://x.test/api/swap/balances?owner=${OWNER}&mints=${MINT}&cluster=devnet`), lpEnv, net.fetchImpl);
  assert.equal(bal.status, 503);
  assert.ok(net.who().every((w) => w === "devnet"), net.who().join());
  // mainnet launchpad: LAUNCHPAD_RPC_URL first, then the site's backup; LAUNCHPAD_RPC_URL unset = the site's own pair
  assert.deepEqual(rpcTargets(ENV, { cluster: "mainnet", url: LP_URL }).map((t) => [t.role, t.url]), [["launchpad", LP_URL], ["backup", BACKUP]]);
  assert.deepEqual(rpcTargets(ENV, { cluster: "mainnet", url: PRIMARY }).map((t) => t.role), ["primary", "backup"]);
  const lp = network({ launchpad: http(429) });
  assert.equal(await rpc(ENV, "getBlockHeight", [], lp.fetchImpl, { cluster: "mainnet", url: LP_URL }), 1000);
  assert.deepEqual(lp.who(), ["launchpad", "backup"]);
});

test("the batched reads fail over as a whole: getHoldings (snapshot fallback) and getMintBalances (swap panel, portfolio)", async () => {
  // one item of the batch refused (Helius answers per item): the whole batch goes to the backup
  const itemRefused = (body) => new Response(JSON.stringify(body.map((b, i) => (i === 1 ? { jsonrpc: "2.0", id: b.id, error: { code: -32429, message: "max usage reached" } } : { jsonrpc: "2.0", id: b.id, result: answer(b) }))));
  const net = network({ primary: itemRefused });
  const h = await getHoldings(ENV, [OWNER, OTHER], MINT, net.fetchImpl);
  assert.deepEqual([...h.entries()], [[OWNER, 5], [OTHER, 5]]);
  assert.deepEqual(net.who(), ["primary", "backup"]);
  _resetRpcHealth();
  const net2 = network({ primary: http(402) });
  const m = await getMintBalances(ENV, OWNER, [MINT], net2.fetchImpl);
  assert.equal(m.get(MINT), 5);
  assert.deepEqual(net2.who(), ["primary", "backup"]);
  // a whole-batch refusal object (not a list) from the only node is an error, never "everybody holds 0"
  _resetRpcHealth();
  const one = network({ primary: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32429, message: "max usage reached" } })) });
  await assert.rejects(getHoldings({ SOLANA_RPC_URL: PRIMARY }, [OWNER], MINT, one.fetchImpl), /rpc_-32429/);
});

/* ---------------------------------------------------------------- sendTransaction */
function signedTx() {
  const transfer = { programAddress: PROGRAM_IDS.system, accounts: [{ address: OWNER, role: 3 }, { address: OTHER, role: 1 }], data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0) };
  const tx = wrapUnsigned(compileLegacy({ payer: OWNER, instructions: [transfer], blockhash: "11111111111111111111111111111111" }));
  tx.fill(7, 1, 65); // the wallet's signature
  return toBase64(tx);
}
const send = (env, fetchImpl, tx = signedTx()) => handleSend(new Request("https://x.test/api/swap/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, ticket: "none-without-a-database" }) }), env, fetchImpl);
const SIG = base58Encode(new Uint8Array(64).fill(7));

test("sendTransaction: a provider failure sends the SAME signed bytes to the backup once; a node's verdict is never re-sent", async () => {
  const tx = signedTx();
  const net = network({ primary: http(503) });
  const r = await (await send(ENV, net.fetchImpl, tx)).json();
  assert.deepEqual(r, { ok: true, signature: SIG, solscan: `https://solscan.io/tx/${SIG}`, cluster: "mainnet" });
  assert.deepEqual(net.calls.map((c) => [c[0], c[1]]), [["primary", "sendTransaction"], ["backup", "sendTransaction"]]);
  assert.equal(net.calls[0][2], net.calls[1][2], "byte for byte the same request: nothing rebuilt, nothing re-signed");
  assert.equal(JSON.parse(net.calls[1][2]).params[0], tx);
  // both refuse with 429: one retry only, and the page's answer is the same as before (rpc_busy)
  _resetRpcHealth();
  const busy = network({ primary: http(429), backup: http(429) });
  const b = await send(ENV, busy.fetchImpl);
  assert.equal(b.status, 503);
  assert.deepEqual(await b.json(), { ok: false, error: "rpc_busy" });
  assert.equal(busy.calls.length, 2);
  // the node says the trade would fail: the answer, not a reason to ask another provider
  _resetRpcHealth();
  const verdict = network({ primary: rpcErr(-32002, "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.", { err: "AccountNotFound", logs: [] }) });
  const v = await send(ENV, verdict.fetchImpl);
  assert.equal(v.status, 409);
  assert.equal((await v.json()).error, "insufficient_sol");
  assert.deepEqual(verdict.who(), ["primary"]);
});

test("sendTransaction: the primary timed out after sending, the backup says 'already processed': that is the trade landing, with the wallet's signature", async () => {
  const net = network({
    primary: (body, init) => hang(init),
    backup: rpcErr(-32002, "Transaction simulation failed: This transaction has already been processed", { err: "AlreadyProcessed", logs: [] }),
  });
  const r = await send({ ...ENV }, (u, init) => net.fetchImpl(u, u === PRIMARY ? { ...init, signal: AbortSignal.timeout(20) } : init));
  assert.deepEqual(await r.json(), { ok: true, signature: SIG, solscan: `https://solscan.io/tx/${SIG}`, cluster: "mainnet" });
  // without a failover the same answer stays what it was (the node's verdict)
  _resetRpcHealth();
  const alone = network({ primary: rpcErr(-32002, "Transaction simulation failed: This transaction has already been processed", { err: "AlreadyProcessed", logs: [] }) });
  const a = await send({ SOLANA_RPC_URL: PRIMARY }, alone.fetchImpl);
  assert.equal(a.status, 409);
});

test("status: the block height comes from the node that answered the signature status (a lagging backup never calls a landed trade expired)", async () => {
  const net = network({ primary: http(429) });
  const r = await handleStatus(new Request(`https://x.test/api/swap/status?sig=${SIG}&lvbh=500`), ENV, net.fetchImpl);
  assert.equal((await r.json()).status, "expired");
  assert.deepEqual(net.calls.map((c) => [c[0], c[1]]), [["primary", "getSignatureStatuses"], ["backup", "getSignatureStatuses"], ["backup", "getBlockHeight"]]);
  // the primary answers the status: its own height, even though the backup is there
  _resetRpcHealth();
  const fine = network({});
  await handleStatus(new Request(`https://x.test/api/swap/status?sig=${SIG}&lvbh=5000`), ENV, fine.fetchImpl);
  assert.deepEqual(fine.calls.map((c) => [c[0], c[1]]), [["primary", "getSignatureStatuses"], ["primary", "getBlockHeight"]]);
  // the routes keep their error shape when everything is down
  _resetRpcHealth();
  const down = network({ primary: http(500), backup: http(500) });
  const d = await handleStatus(new Request(`https://x.test/api/swap/status?sig=${SIG}&lvbh=5000`), ENV, down.fetchImpl);
  assert.deepEqual([d.status, await d.json()], [503, { ok: false, error: "rpc_unavailable" }]);
  const bal = await handleBalances(new Request(`https://x.test/api/swap/balances?owner=${OWNER}&mints=${MINT}`), ENV, down.fetchImpl);
  assert.deepEqual([bal.status, await bal.json()], [503, { ok: false, error: "rpc_unavailable" }]);
  for (const l of logs) noSecretIn(l, "a log line");
});

test("rpcAnswer says which role answered, never which URL", async () => {
  const net = network({ primary: http(429) });
  const a = await rpcAnswer(ENV, "getBlockHeight", [], net.fetchImpl);
  assert.deepEqual(a, { result: 1000, role: "backup" });
  noSecretIn(JSON.stringify(rpcHealth()), "the health view");
});

test("no path asks a provider by itself: only src/rpcpool.js fetches an RPC URL", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const code = (f) => readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const c = code(f);
    if (f !== "rpcpool.js" && f !== "cluster.js" && f !== "admin.js") assert.ok(!/SOLANA_RPC_URL/.test(c), `${f} reads SOLANA_RPC_URL itself`);
    if (f !== "rpcpool.js" && f !== "cluster.js") assert.ok(!/mainnet-beta\.solana\.com/.test(c), `${f} names the public RPC itself`);
  }
  assert.match(code("admin.js"), /SOLANA_RPC_URL_BACKUP: Boolean\(env\.SOLANA_RPC_URL_BACKUP\)/, "the admin view: presence only");
});

/* ---------------------------------------------------------------- review fixes (10 Oct 2026) */
test("breaker: a passing hiccup of ONE request moves only that request (plain 429, -32010, a send's 429); three within 10 s, or a refused account, bench the provider", async () => {
  const order = async (net, n = 3) => { net.calls.length = 0; for (let i = 0; i < n; i++) await rpc(ENV, "getBlockHeight", [], net.fetchImpl); return net.who(); };
  // one plain rate limit (the body says nothing about the account): served by the backup, and the next calls go to the primary again
  let fail = 1;
  const plain = network({ primary: (b) => (fail-- > 0 ? http(429, '{"jsonrpc":"2.0","error":{"code":-32429,"message":"rate limited"}}')() : ok(b)) });
  await rpc(ENV, "getBlockHeight", [], plain.fetchImpl);
  assert.deepEqual(plain.who(), ["primary", "backup"]);
  assert.deepEqual(await order(plain), ["primary", "primary", "primary"], "one 429 does not move every read to the backup");
  // a method this provider does not index (-32010) for one call: the same
  _resetRpcHealth(); fail = 1;
  const idx = network({ primary: (b) => (fail-- > 0 ? rpcErr(-32010, "excluded from account secondary indexes; this RPC method unavailable for key")(b) : ok(b)) });
  await rpc(ENV, "getProgramAccounts", [], idx.fetchImpl);
  assert.deepEqual(await order(idx), ["primary", "primary", "primary"]);
  // a sendTransaction refused by the per-method send limit (Helius: 1 or 5 a second): the reads stay on the primary
  _resetRpcHealth();
  const sends = network({ primary: (b) => (b.method === "sendTransaction" ? http(429)() : ok(b)) });
  const r = await send(ENV, sends.fetchImpl);
  assert.equal(r.status, 200, "the backup sent it");
  assert.deepEqual(await order(sends), ["primary", "primary", "primary"], "a send limit never benches the reads");
  // three plain failures within 10 s: now the provider is benched; a good answer in between starts the count again
  _resetRpcHealth(); fail = 2;
  const flaky = network({ primary: (b) => (fail-- > 0 ? http(429)() : ok(b)) });
  await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl); await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl);
  await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl); // the primary answers: the count starts again
  fail = 2;
  await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl); await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl);
  assert.deepEqual(await order(flaky, 1), ["primary"], "two since the last good answer: not benched");
  _resetRpcHealth(); fail = 3;
  for (let i = 0; i < 3; i++) { clock.now += 2_000; await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl); }
  assert.deepEqual(await order(flaky, 1), ["backup"], "three within 10 s: benched");
  // the account itself refused (credits used up, the key refused): benched at once
  for (const down of [outOfCredits, http(402), http(401), rpcErr(-32429, "max usage reached")]) {
    _resetRpcHealth();
    const net = network({ primary: down });
    await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
    assert.deepEqual(await order(net, 1), ["backup"]);
  }
});

test("breaker: a probe whose request is abandoned (the visitor left mid-probe) does not keep the primary asked last for good", async () => {
  const net = network({ primary: outOfCredits });
  await rpc(ENV, "getBlockHeight", [], net.fetchImpl);
  clock.now += BREAKER_MS + 1_000;
  // the probe: its fetch never settles and ignores its signal, so its `finally` never runs
  const abandoned = rpc(ENV, "getBlockHeight", [], () => new Promise(() => {}));
  abandoned.catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.ok(rpcHealth(clock.now).primary.probingUntil, "a probe in flight is shown with its deadline");
  const during = network({});
  await rpc(ENV, "getBlockHeight", [], during.fetchImpl);
  assert.deepEqual(during.who(), ["backup"], "while the probe is under way the others go to the backup");
  clock.now += 3_600_000;
  const later = network({});
  await rpc(ENV, "getBlockHeight", [], later.fetchImpl);
  await rpc(ENV, "getBlockHeight", [], later.fetchImpl);
  assert.deepEqual(later.who(), ["primary", "primary"], "an hour later the healthy primary is probed and first again");
  const h = rpcHealth(clock.now).primary;
  assert.deepEqual([h.askedLastUntil, h.probingUntil], [null, null]);
});

test("sendTransaction after an UNCLEAR failure (the bytes may have gone out): the page gets the wallet's signature to watch, never 'nothing was spent'", async () => {
  const quick = (net) => (u, init) => net.fetchImpl(u, { ...init, signal: AbortSignal.timeout(20) });
  const blockhashNotFound = rpcErr(-32002, "Transaction simulation failed: Blockhash not found", { err: "BlockhashNotFound", logs: [] });
  const slippage = rpcErr(-32002, "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771", { err: { InstructionError: [0, { Custom: 6001 }] }, logs: [] });
  const cases = {
    "primary timed out, a lagging backup says BlockhashNotFound": { primary: (b, init) => hang(init), backup: blockhashNotFound },
    "primary timed out, the backup refuses inside a 200 (-32429)": { primary: (b, init) => hang(init), backup: rpcErr(-32429, "max usage reached") },
    "both timed out after both got the bytes": { primary: (b, init) => hang(init), backup: (b, init) => hang(init) },
    "primary 502 (a gateway may have forwarded it), the backup's preflight says slippage": { primary: http(502), backup: slippage },
    "primary 503, the backup says too many requests": { primary: http(503), backup: rpcErr(-32005, "Too many requests for a specific RPC call") },
    "primary network error after sending, the backup 429": { primary: () => { throw new TypeError(`Network connection lost: ${PRIMARY}`); }, backup: http(429) },
  };
  for (const [name, behaviour] of Object.entries(cases)) {
    _resetRpcHealth(); _resetRelay(); logs.length = 0;
    const net = network(behaviour);
    const r = await send(ENV, quick(net));
    const body = await r.json();
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(body)}`);
    assert.deepEqual(body, { ok: true, signature: SIG, solscan: `https://solscan.io/tx/${SIG}`, cluster: "mainnet", unclear: true }, name);
    assert.ok(net.calls.length <= 2 && net.calls.every((c) => c[2] === net.calls[0][2]), `${name}: the same bytes, at most once per provider`);
    for (const l of logs) noSecretIn(l, "a log line");
  }
  // a single provider that timed out (no backup): the same, the chain decides
  _resetRpcHealth();
  const alone = network({ primary: (b, init) => hang(init) });
  const a = await send({ SOLANA_RPC_URL: PRIMARY }, quick(alone));
  assert.deepEqual([a.status, (await a.json()).unclear], [200, true]);
});

test("sendTransaction: a provider REFUSAL (nothing went out) is 'busy', never 'the network refused this', and never the provider's words; a clean refusal then a verdict stays the verdict", async () => {
  // the only provider is out of credits and says so inside a 200: before, 409 rejected_by_network "...Nothing was spent" with "max usage reached" in `name`
  const one = network({ primary: rpcErr(-32429, "max usage reached") });
  const r = await send({ SOLANA_RPC_URL: PRIMARY }, one.fetchImpl);
  const body = await r.json();
  assert.deepEqual([r.status, body], [503, { ok: false, error: "rpc_busy" }]);
  assert.ok(!JSON.stringify(body).includes("usage"));
  // both refuse before taking it
  _resetRpcHealth();
  const both = network({ primary: http(402), backup: rpcErr(-32005, "Too many requests") });
  assert.deepEqual([(await send(ENV, both.fetchImpl)).status], [503]);
  // the primary refused cleanly (a 429 is answered before anything is sent), then the backup's verdict is the real one
  _resetRpcHealth();
  const verdict = network({ primary: http(429), backup: rpcErr(-32002, "Transaction simulation failed: Blockhash not found", { err: "BlockhashNotFound", logs: [] }) });
  const v = await send(ENV, verdict.fetchImpl);
  assert.deepEqual([v.status, (await v.json()).error], [409, "blockhash_expired"]);
});

test("a backup that is not a mainnet node (a devnet URL pasted by mistake) is never used: no plausible 'holds 0', one log line without its URL", async () => {
  const devnetGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  // the devnet node would answer "no token accounts" for every wallet: getHoldings must fail, not say everyone holds 0
  const net = network({ primary: http(429), backup: (body) => new Response(JSON.stringify(body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: { value: [] } })))) }, { genesis: devnetGenesis });
  await assert.rejects(getHoldings(ENV, [OWNER], MINT, net.fetchImpl), /rpc_http_429/);
  await assert.rejects(getHoldings(ENV, [OWNER], MINT, net.fetchImpl), /rpc_http_429/);
  assert.deepEqual(net.who(), ["primary", "primary"], "the devnet node was never asked a mainnet question");
  assert.deepEqual(net.checks, ["backup"], "checked once per server");
  assert.equal(logs.filter((l) => /not a mainnet node/.test(l)).length, 1);
  assert.equal(rpcHealth().backup.lastReason, "not_mainnet");
  for (const l of logs) noSecretIn(l, "a log line");
  // the check itself gets no answer: the backup is used anyway (better a backup than none), and checked again 30 s later
  _resetRpcHealth();
  const flaky = network({ primary: http(429) }, { genesis: () => new Response("down", { status: 503 }) });
  assert.equal(await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl), 1000);
  assert.equal(await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl), 1000);
  assert.deepEqual(flaky.checks, ["backup"]);
  clock.now += 31_000;
  await rpc(ENV, "getBlockHeight", [], flaky.fetchImpl);
  assert.deepEqual(flaky.checks, ["backup", "backup"]);
  // a direct rpcPost names no URL either way
  _resetRpcHealth();
  const a = await rpcPost(ENV, { jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }, network({ primary: http(500) }).fetchImpl);
  assert.deepEqual([a.role, a.failedOver, a.ambiguous], ["backup", true, true]);
});

test("status: the block height is shared for 2 s per server (half the cost of a flood of invented signatures); a failure is not kept", async () => {
  const net = network({});
  const poll = (n) => handleStatus(new Request(`https://x.test/api/swap/status?sig=${base58Encode(new Uint8Array(64).fill(n))}&lvbh=5000`), ENV, net.fetchImpl);
  for (let i = 1; i <= 4; i++) assert.equal((await (await poll(i)).json()).status, "pending");
  const heights = () => net.calls.filter((c) => c[1] === "getBlockHeight").length;
  assert.equal(heights(), 1);
  clock.now += 2_000;
  await poll(5);
  assert.equal(heights(), 2, "read again after 2 s");
  // a height read from the backup is the backup's own (never another node's)
  _resetRelay(); _resetRpcHealth();
  const split = network({ primary: outOfCredits });
  const p2 = (n) => handleStatus(new Request(`https://x.test/api/swap/status?sig=${base58Encode(new Uint8Array(64).fill(n))}&lvbh=5000`), ENV, split.fetchImpl);
  await p2(7);
  assert.deepEqual(split.calls.map((c) => [c[0], c[1]]), [["primary", "getSignatureStatuses"], ["backup", "getSignatureStatuses"], ["backup", "getBlockHeight"]]);
  // a failed read is not remembered
  _resetRelay(); _resetRpcHealth();
  let down = true;
  const once = network({ primary: (b) => (b.method === "getBlockHeight" && down ? http(500)() : ok(b)) });
  const p3 = (n) => handleStatus(new Request(`https://x.test/api/swap/status?sig=${base58Encode(new Uint8Array(64).fill(n))}&lvbh=5000`), { SOLANA_RPC_URL: PRIMARY }, once.fetchImpl);
  assert.equal((await p3(8)).status, 503);
  down = false;
  assert.equal((await (await p3(9)).json()).status, "pending");
});
