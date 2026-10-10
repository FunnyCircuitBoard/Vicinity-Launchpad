// City coins through the Worker's one way to a Solana node (src/rpcpool.js, merged from main #52): every JSON-RPC call of the
// city-coin kit (src/lpkit.js lpRpc / readAccounts / checkGenesis / buildTx's simulation, and through them src/lpadmin.js,
// src/lplaunch.js, src/lpcoins.js, /coin-meta) goes through rpcPost with the launchpad's cluster: on mainnet the launchpad's own
// node first and SOLANA_RPC_URL_BACKUP behind it (with the breaker), on devnet the one devnet node and never a mainnet node; no
// URL in any error or log line. A city-coin transaction relayed after an unclear send (the bytes may have gone out) answers the
// wallet's own signature with unclear: true, never "nothing was spent".
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GENESIS, _resetLpKit, buildTx, checkGenesis, lpRoute, lpRpc, readAccounts } from "../src/lpkit.js";
import { _resetRpcHealth, rpcHealth } from "../src/rpcpool.js";
import { _resetRelay, handleSend } from "../src/relay.js";
import { base58Encode } from "../src/solana.js";
import { fromBase64, toBase64 } from "../src/sol/bytes.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { systemTransfer } from "../src/sol/ix.js";
import { newWorld } from "./helpers/world.js";
import { LP_ON, addr, lpChain } from "./helpers/lpchain.js";

const PRIMARY = "https://primary.rpc.example/?api-key=PRIMARYSECRET";
const BACKUP = "https://backup.rpc.example/v1/BACKUPSECRET";
const LP_URL = "https://launchpad.rpc.example/?api-key=LPSECRET";
const SECRETS = ["PRIMARYSECRET", "BACKUPSECRET", "LPSECRET", "api-key", "rpc.example", "lp-rpc.test"];
const PAYER = addr(1), K1 = addr(2), K2 = addr(3);
const MAINNET = { LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(9), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(10), SOLANA_RPC_URL: PRIMARY, SOLANA_RPC_URL_BACKUP: BACKUP };
const createAccount = (from, to) => ({ programAddress: PROGRAM_IDS.system, accounts: [{ address: from, role: 3 }, { address: to, role: 3 }], data: Uint8Array.of(0, 0, 0, 0, ...new Uint8Array(8).fill(1), ...new Uint8Array(8), ...new Uint8Array(32)) });

let logs, quiet;
beforeEach(() => {
  _resetLpKit(); _resetRpcHealth(); _resetRelay();
  logs = []; quiet = {};
  for (const k of ["log", "warn", "error"]) { quiet[k] = console[k]; console[k] = (...a) => logs.push(a.map(String).join(" ")); }
});
afterEach(() => { for (const k of Object.keys(quiet)) console[k] = quiet[k]; });
const noSecretIn = (s, what) => { for (const x of SECRETS) assert.ok(!String(s).includes(x), `${what} carries "${x}": ${s}`); };

/**
 * The launchpad chain of test/helpers/lpchain.js behind named endpoints: each URL answers through `byUrl[who]` (a function of the
 * parsed body returning a Response, or undefined to let the chain answer). Records [who, method] per call.
 */
function endpoints(chain, byUrl = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const who = url === PRIMARY ? "primary" : url === BACKUP ? "backup" : url === LP_URL ? "launchpad" : url === LP_ON.LAUNCHPAD_RPC_URL ? "devnet" : "other";
    const body = JSON.parse(init.body);
    calls.push([who, body.method]);
    const f = byUrl[who];
    const r = f ? await f(body, init) : undefined;
    return r || chain.fetchImpl(url, init);
  };
  return { fetchImpl, calls };
}
const http = (status) => () => new Response("max usage reached", { status });
const hang = (init) => new Promise((_, reject) => {
  const keep = setTimeout(() => reject(new Error("the caller never gave up")), 5_000);
  init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); });
});

test("lpRoute: the launchpad's cluster and node, as the pool's route (devnet alone; mainnet with the backup behind it)", () => {
  assert.deepEqual(lpRoute({ ...LP_ON }), { cluster: "devnet", url: LP_ON.LAUNCHPAD_RPC_URL });
  assert.deepEqual(lpRoute(MAINNET), { cluster: "mainnet", url: PRIMARY }, "mainnet without LAUNCHPAD_RPC_URL: the site's node first");
  assert.deepEqual(lpRoute({ ...MAINNET, LAUNCHPAD_RPC_URL: LP_URL }), { cluster: "mainnet", url: LP_URL });
  assert.deepEqual(lpRoute({ ...newWorld() }), { cluster: null, url: null }, "settings off: nothing to ask (no route is ever used then)");
});

test("mainnet city coins: the site's provider out of credits, the backup answers every read, the genesis check and the simulation", async () => {
  const chain = lpChain({ genesis: GENESIS.mainnet, accounts: { [PAYER]: { owner: PROGRAM_IDS.system, lamports: 2_000_000_000, data: "" } } });
  const net = endpoints(chain, { primary: http(402) });
  const env = { ...newWorld(), ...MAINNET };
  const r = await buildTx(env, { payer: PAYER, instructions: [systemTransfer(PAYER, addr(77), 1_000n)] }, net.fetchImpl);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cluster, "mainnet");
  const methods = net.calls.filter(([who]) => who === "backup").map(([, m]) => m);
  for (const m of ["getGenesisHash", "getLatestBlockhash", "getMultipleAccounts", "simulateTransaction"]) assert.ok(methods.includes(m), `${m} answered by the backup: ${methods.join(",")}`);
  assert.equal(net.calls.filter(([who]) => who === "primary").length, 1, "the first 402 benches the provider (asked last for 60 s): one call, then the backup first");
  assert.ok(rpcHealth().primary.askedLastUntil, "the breaker is open for the primary");
  assert.ok(!net.calls.some(([who]) => who === "other" || who === "devnet"), "no other node");
  for (const l of logs) noSecretIn(l, "a log line");
  noSecretIn(JSON.stringify(r), "the answer");
  // the genesis hash came from the backup, not from the launchpad's own first node: it let this build go on, but is not remembered
  const before = net.calls.filter(([, m]) => m === "getGenesisHash").length;
  assert.equal((await checkGenesis(env, net.fetchImpl)).ok, true);
  assert.equal(net.calls.filter(([, m]) => m === "getGenesisHash").length, before + 1, "asked again: the first node was never checked");
});

test("mainnet city coins: a first node of the wrong cluster is refused (wrong_cluster) and remembered as ok only once it matched", async () => {
  const devnetNode = lpChain(); // a devnet node behind LAUNCHPAD_RPC_URL with a "mainnet" label
  const env = { ...newWorld(), ...MAINNET, LAUNCHPAD_RPC_URL: LP_URL };
  const net = endpoints(devnetNode);
  const g = await checkGenesis(env, net.fetchImpl);
  assert.deepEqual([g.ok, g.error], [false, "wrong_cluster"]);
  assert.deepEqual(net.calls, [["launchpad", "getGenesisHash"]], "the launchpad's own node first; its answer is an answer, never a reason to fail over");
  const real = endpoints(lpChain({ genesis: GENESIS.mainnet }));
  assert.equal((await checkGenesis(env, real.fetchImpl)).ok, true);
  assert.equal((await checkGenesis(env, real.fetchImpl)).ok, true);
  assert.equal(real.calls.filter(([, m]) => m === "getGenesisHash").length, 1, "the first node matched: remembered");
  // reads go to the launchpad's node first, through the pool
  await lpRpc(env, "getSlot", [], endpoints(lpChain({ genesis: GENESIS.mainnet }), { launchpad: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 })) }).fetchImpl).then((v) => assert.equal(v, 7));
});

test("devnet city coins: the one devnet node only; when it fails nothing goes to a mainnet node or the backup", async () => {
  const chain = lpChain();
  const net = endpoints(chain, { devnet: http(503) });
  const env = { ...newWorld(), ...LP_ON, SOLANA_RPC_URL: PRIMARY, SOLANA_RPC_URL_BACKUP: BACKUP };
  assert.deepEqual(await checkGenesis(env, net.fetchImpl), { ok: false, error: "rpc_unavailable" });
  await assert.rejects(readAccounts(env, [PAYER], net.fetchImpl), (e) => { noSecretIn(e.message, "the error"); return /^rpc_/.test(e.message); });
  assert.ok(net.calls.every(([who]) => who === "devnet"), JSON.stringify(net.calls));
  const r = await buildTx(env, { payer: PAYER, instructions: [systemTransfer(PAYER, addr(77), 1n)] }, net.fetchImpl);
  assert.deepEqual([r.ok, r.error], [false, "rpc_unavailable"]);
  assert.ok(net.calls.every(([who]) => who === "devnet"));
  for (const l of logs) noSecretIn(l, "a log line");
});

test("relay: a city-coin transaction (3 signers) whose send is UNCLEAR answers the wallet's own signature to watch, never 'nothing was spent'", async () => {
  const chain = lpChain({ genesis: GENESIS.mainnet, accounts: { [PAYER]: { owner: PROGRAM_IDS.system, lamports: 2_000_000_000, data: "" } } });
  const env = { ...newWorld(), ...MAINNET };
  const built = await buildTx(env, { payer: PAYER, instructions: [createAccount(PAYER, K1), createAccount(PAYER, K2)], extraSigners: [K1, K2] }, chain.fetchImpl);
  assert.equal(built.ok, true, JSON.stringify(built));
  const tx = fromBase64(built.tx);
  assert.equal(tx[0], 3);
  for (let i = 0; i < 3; i++) tx.fill(i + 7, 1 + 64 * i, 65 + 64 * i); // every slot signed (the wallet's is slot 0)
  const own = base58Encode(tx.subarray(1, 65));
  _resetRpcHealth();
  // the primary takes the bytes and never answers; the lagging backup then says BlockhashNotFound
  const net = endpoints(chain, {
    primary: (b, init) => (b.method === "sendTransaction" ? hang(init) : undefined),
    backup: (b) => (b.method === "sendTransaction" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed: Blockhash not found", data: { err: "BlockhashNotFound", logs: [] } } })) : undefined),
  });
  const quick = (u, init) => net.fetchImpl(u, { ...init, signal: AbortSignal.timeout(20) });
  const res = await handleSend(new Request("https://x.test/api/swap/send", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx: toBase64(tx), ticket: built.ticket, lastValidBlockHeight: built.lastValidBlockHeight, cluster: "mainnet" }) }), env, quick);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, signature: own, solscan: `https://solscan.io/tx/${own}`, cluster: "mainnet", unclear: true });
  const sends = net.calls.filter(([, m]) => m === "sendTransaction");
  assert.deepEqual(sends.map(([who]) => who), ["primary", "backup"], "the same bytes, at most once per provider");
  for (const l of logs) noSecretIn(l, "a log line");
});
