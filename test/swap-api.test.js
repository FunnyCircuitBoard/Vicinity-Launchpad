// The in-app swap routes (SWAP=on): /api/swap/config, /tokens, /quote, /tx, /send, /status, /balances against a FAKE Jupiter
// (today's recorded /swap/v2/build and /swap/v1/quote answers rewritten for the asking wallet, test/helpers/jupfake.js) and a
// FAKE RPC. What is checked: the switch, the Origin, every validation code, the build cache and the per-server Jupiter budget,
// 429 / 5xx / no-route handling with the negative cache, every refusal of the build validator against hostile answers, lookup
// tables read back from the chain, simulation errors in plain codes before the wallet opens, the priority-fee cap, the
// legacy / v0 choice, the relay's refusals and mapping, statuses, balances, token search, the attempt limits, and that no
// secret and no address of a stranger ever appears in an answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/index.js";
import { _resetSwap, _swapState } from "../src/swap.js";
import { _resetRelay } from "../src/relay.js";
import { _resetMarketLive } from "../src/marketlive.js";
import { decodeHeader } from "../src/sol/message.js";
import { fromBase64, toBase64 } from "../src/sol/bytes.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { newWorld, POOL } from "./helpers/world.js";
import { ALT_KEY, REAL_VIC, SOL, USDC, USDT, fakeWorld } from "./helpers/jupfake.js";

const TAKER = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p", TAKER2 = "47ugnHuxsmgNZu8KEv1VXW7wPVVwMWti8vVrK4ADDxWa";
const ORIGIN = "https://vicinity.test";
function world(extraEnv = {}, fakes = {}) {
  _resetSwap(); _resetRelay(); _resetMarketLive();
  const W = fakeWorld({ rpc: { mints: { [REAL_VIC]: { decimals: 6 } }, lamports: { [TAKER]: 2_000_000_000 }, holdings: { [REAL_VIC]: { [TAKER]: 1234.5 } } }, ...fakes });
  const env = { ...newWorld(), SWAP: "on", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test", JUPITER_API_KEY: "secret-key-123", JUPITER_RPS: "10", ...extraEnv };
  const call = async (path, { method = "GET", body, origin = ORIGIN, ip = "1.2.3.4", fetchImpl = W.fetch } = {}) => {
    const headers = new Headers({ "cf-connecting-ip": ip });
    if (origin) headers.set("origin", origin);
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await handleApi(new Request(ORIGIN + path, { method: body !== undefined ? "POST" : method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, fetchImpl);
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, text };
  };
  return { W, env, call };
}
const quoteBody = (over = {}) => ({ inputMint: SOL, outputMint: REAL_VIC, amount: "0.25", slippageBps: 100, ...over });
/** The compiled index of the Jupiter swap instruction in an unsigned transaction. */
const swapIndex = (txB64) => { const d = decodeHeader(fromBase64(txB64)); return d.instructions.findIndex((i) => d.staticKeys[i.programIdIndex] === PROGRAM_IDS.jupiter); };
/** Fill the fee payer's signature slot (the relay only looks at the envelope). */
const signed = (txB64) => { const b = fromBase64(txB64); b.fill(7, 1, 65); return toBase64(b); };

test("swap: with SWAP off every route is 404 not_enabled; /api/official carries no swap key; with it on, swap: true", async () => {
  const off = world({ SWAP: "off" });
  for (const p of ["/api/swap/config", "/api/swap/tokens?q=usdc", "/api/swap/status?sig=1", "/api/swap/balances?owner=" + TAKER]) assert.deepEqual((await off.call(p)).data, { ok: false, error: "not_enabled" }, p);
  for (const p of ["/api/swap/quote", "/api/swap/tx", "/api/swap/send"]) assert.equal((await off.call(p, { body: {} })).status, 404, p);
  assert.equal((await off.call("/api/official")).data.swap, undefined);
  const on = world();
  assert.equal((await on.call("/api/official")).data.swap, true);
  assert.equal((await on.call("/api/swap/quote", { method: "GET" })).data.error, "method_not_allowed");
  assert.deepEqual((await on.call("/api/swap/quote", { body: quoteBody(), origin: null })).data, { ok: false, error: "bad_origin" });
  assert.deepEqual((await on.call("/api/swap/quote", { body: quoteBody(), origin: "https://evil.example" })).data, { ok: false, error: "bad_origin" });
});

test("swap: config lists the tokens and booleans only (never the key); token search answers verified tokens only", async () => {
  const { call } = world();
  const c = await call("/api/swap/config");
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.tokens.map((t) => t.mint), [SOL, USDC, USDT, REAL_VIC]);
  assert.deepEqual([c.data.swap, c.data.cluster, c.data.jupiter.keyed, c.data.jupiter.rps, c.data.maxSlippageBps, c.data.defaultSlippageBps, c.data.launchpad.enabled], [true, "mainnet", true, 10, 5000, 100, false]);
  assert.ok(!c.text.includes("secret-key"), "the key never leaves the Worker");
  assert.match(c.headers.get("Cache-Control"), /max-age=60/);
  assert.deepEqual((await call("/api/swap/tokens?q=%3Cscript%3E")).data, { ok: false, error: "bad_query" });
  const t = await call("/api/swap/tokens?q=usd");
  assert.equal(t.status, 200);
  assert.deepEqual(t.data.tokens.map((x) => x.symbol), ["USDC", "USDT"], "the unverified look-alike is left out");
  assert.equal(t.data.poweredBy, "Jupiter");
});

test("swap: validation codes before anything leaves the Worker", async () => {
  const { W, call } = world();
  const bad = async (over, code, extra = {}) => { const r = await call("/api/swap/quote", { body: quoteBody(over), ...extra }); assert.equal(r.status, code === "unknown_token" ? 400 : 400, JSON.stringify(r.data)); assert.equal(r.data.error, code); };
  await bad({ inputMint: "nope" }, "bad_mint");
  await bad({ outputMint: SOL }, "same_mint");
  await bad({ amount: "-1" }, "bad_amount");
  await bad({ amount: "1e5" }, "bad_amount");
  await bad({ amount: "0" }, "bad_amount");
  await bad({ amount: "0.0000000001" }, "amount_too_small"); // 10 decimals of a 9-decimal token
  await bad({ slippageBps: 0 }, "bad_slippage");
  await bad({ slippageBps: 5001 }, "bad_slippage");
  await bad({ slippageBps: "1.5" }, "bad_slippage");
  await bad({ taker: POOL }, "bad_wallet"); // a program account is not a wallet
  await bad({ taker: "x" }, "bad_wallet");
  W.rpc.mints.kgERWXbLfq6MHcWLd86a5dpmSvM86QhQrQjL2gGPbnD = null;
  await bad({ outputMint: "kgERWXbLfq6MHcWLd86a5dpmSvM86QhQrQjL2gGPbnD" }, "unknown_token");
  assert.equal(W.jup.log.length, 0, "no Jupiter call for a bad request");
  const r = await call("/api/swap/tx", { body: quoteBody() });
  assert.deepEqual([r.status, r.data.error], [400, "bad_wallet"], "the tx route needs a taker");
  assert.equal((await call("/api/swap/quote", { body: "not json" })).data.error, "bad_json");
});

test("swap: a quote without a taker is a keyless estimate; with a taker it is the keyed build, cached 12 s and reused by /tx", async () => {
  const { W, call } = world();
  const q1 = await call("/api/swap/quote", { body: quoteBody() });
  assert.equal(q1.status, 200);
  assert.deepEqual([q1.data.source, q1.data.estimate, q1.data.inAmount, q1.data.inUi, q1.data.decimals, q1.data.slippageBps, q1.data.poweredBy, q1.data.chain], ["jupiter_quote", true, "250000000", "0.25", { in: 9, out: 6 }, 100, "Jupiter", "solana:mainnet"]);
  assert.ok(BigInt(q1.data.minOut) < BigInt(q1.data.outAmount) && BigInt(q1.data.minOut) > 0n);
  assert.equal(q1.data.route[0], "Raydium Launchlab");
  assert.match(q1.data.routeText, /Routed by Jupiter · executed on Raydium Launchlab/);
  assert.ok(q1.data.inUsd > 37 && q1.data.inUsd < 38, "0.25 SOL at the fake price");
  assert.equal(q1.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(W.jup.log.filter((l) => l.path.startsWith("/swap")).map((l) => [l.path, l.keyed]), [["/swap/v1/quote", false]]);
  // the keyless quote is shared too: three visitors (or a 12-second refresh) asking the same pair, amount and slippage cost one lite call
  const q1b = await call("/api/swap/quote", { body: quoteBody(), ip: "9.9.9.9" });
  const q1c = await call("/api/swap/quote", { body: quoteBody() });
  assert.deepEqual([q1b.data.outAmount, q1c.data.quoteId], [q1.data.outAmount, q1.data.quoteId]);
  assert.equal(W.jup.log.filter((l) => l.path === "/swap/v1/quote").length, 1, "one keyless call for three identical previews");
  assert.equal(_swapState().quotes, 1);
  await call("/api/swap/quote", { body: quoteBody({ slippageBps: 300 }) });
  assert.equal(W.jup.log.filter((l) => l.path === "/swap/v1/quote").length, 2, "another slippage is another key");
  const q2 = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER }) });
  assert.deepEqual([q2.data.source, q2.data.estimate], ["jupiter_build", false]);
  assert.equal(q2.data.priceImpactPct, "0.0012");
  assert.ok(q2.data.fees.priorityLamportsMax <= 10_000_000);
  const builds = () => W.jup.log.filter((l) => l.path === "/swap/v2/build").length;
  assert.equal(builds(), 1);
  assert.ok(W.jup.log.find((l) => l.path === "/swap/v2/build").keyed, "the build goes to the keyed host with x-api-key");
  const q3 = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER }) });
  assert.equal(q3.data.quoteId, q2.data.quoteId);
  assert.equal(builds(), 1, "the same quote within 12 s is served from the cache");
  const tx = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, quoteId: q2.data.quoteId }) });
  assert.equal(tx.status, 200, JSON.stringify(tx.data));
  assert.equal(builds(), 1, "the Swap click reuses the build");
  assert.deepEqual([tx.data.version, tx.data.chain, tx.data.taker, tx.data.simulated, tx.data.quote.source], [0, "solana:mainnet", TAKER, true, "jupiter_build"]);
  const d = decodeHeader(fromBase64(tx.data.tx));
  assert.deepEqual([d.version, d.numSignatures, d.signaturesFilled[0], d.staticKeys[0], d.blockhash], [0, 1, false, TAKER, tx.data.blockhash], "unsigned, the taker pays, Jupiter's blockhash");
  assert.ok(tx.data.bytes <= 1232 && tx.data.bytes === fromBase64(tx.data.tx).length);
  assert.equal(d.staticKeys[d.instructions[0].programIdIndex], PROGRAM_IDS.computeBudget, "our compute budget comes first");
  assert.deepEqual([...d.instructions[0].data.subarray(0, 1)], [2], "a compute-unit limit");
  assert.equal(tx.data.fees.computeUnitLimit, 216_000, "1.2 x the simulated units");
  assert.equal(tx.data.fees.computeUnitPrice, "1220", "Jupiter's price, under the cap");
  assert.equal(d.instructions.some((i) => d.staticKeys[i.programIdIndex] === PROGRAM_IDS.jupiter), true);
  assert.equal(W.rpc.log.filter((l) => l.methods.includes("simulateTransaction")).length, 1);
  assert.deepEqual(W.others, [], "nothing else was asked of the world");
  // a different amount is a different build
  await call("/api/swap/quote", { body: quoteBody({ taker: TAKER, amount: "0.5" }) });
  assert.equal(builds(), 2);
});

test("swap: the per-server Jupiter budget: when the bucket is empty a taker's preview falls back to the keyless quote", async () => {
  const { W, call } = world({ JUPITER_RPS: "1" });
  const a = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER }) });
  const b = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER, amount: "0.3" }) });
  assert.deepEqual([a.data.source, b.data.source], ["jupiter_build", "jupiter_quote"]);
  assert.deepEqual(W.jup.log.filter((l) => l.path.startsWith("/swap")).map((l) => l.path), ["/swap/v2/build", "/swap/v1/quote"]);
  assert.ok(_swapState().bucket < 1);
});

test("swap: Jupiter 429 -> 503 jupiter_busy with Retry-After, honoured by the negative cache; 5xx and network -> jupiter_unavailable; not tradable -> 404 no_route", async () => {
  const { W, call } = world();
  W.jup.setMode("http429");
  const r = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER }) });
  assert.deepEqual([r.status, r.data.error, r.data.retryAfterS, r.headers.get("Retry-After")], [503, "jupiter_busy", 7, "7"]);
  const n = W.jup.log.length;
  const again = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER2 }) });
  assert.deepEqual([again.status, again.data.error], [503, "jupiter_busy"]);
  assert.equal(W.jup.log.filter((l) => l.path.startsWith("/swap")).length, n - W.jup.log.filter((l) => l.path === "/price/v3").length + 0 + 0, "no second Jupiter swap call inside the Retry-After window");
  _resetSwap();
  W.jup.setMode("http500");
  assert.deepEqual((await call("/api/swap/quote", { body: quoteBody() })).data.error, "jupiter_unavailable");
  _resetSwap();
  W.jup.setMode("neterr");
  assert.deepEqual((await call("/api/swap/quote", { body: quoteBody() })).data.error, "jupiter_unavailable");
  _resetSwap();
  W.jup.setMode("noroute");
  const nr = await call("/api/swap/quote", { body: quoteBody() });
  assert.deepEqual([nr.status, nr.data.error], [404, "no_route"]);
  _resetSwap();
  W.jup.setMode("ok");
  assert.equal((await call("/api/swap/quote", { body: quoteBody() })).status, 200, "back to normal after the window");
});

test("swap: every hostile build is refused with 502 jupiter_refused and nothing is compiled", async () => {
  const codes = ["foreign_signer", "swap_program", "destination_account", "authority", "source_account", "platform_fee", "positive_slippage", "swap_in_amount", "swap_min_out", "tip", "helper_program", "sol_transfer_destination", "sol_transfer_amount", "close_account", "ata_owner", "ata_mint", "unknown_swap", "swap_mode", "slippage", "compute_budget_program"];
  for (const code of codes) {
    const { W, call } = world({}, { jupiter: { hostile: code } });
    const r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) });
    assert.deepEqual([r.status, r.data.error], [502, "jupiter_refused"], code);
    assert.ok(!W.rpc.log.some((l) => l.methods.includes("simulateTransaction")), `${code}: nothing was simulated`);
    assert.ok(!JSON.stringify(r.data).includes("GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL"), "the stranger's address never leaves");
  }
});

test("swap: lookup tables are read back from the chain: a claimed prefix that matches compiles (v0), a mismatch or a missing table is refused", async () => {
  const ok = world({}, { jupiter: { alt: true } });
  const r = await ok.call("/api/swap/tx", { body: quoteBody({ taker: TAKER, inputMint: USDC, amount: "5" }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = decodeHeader(fromBase64(r.data.tx));
  assert.deepEqual(d.lookups.map((l) => l.key), [ALT_KEY]);
  assert.ok(ok.W.rpc.log.some((l) => l.methods.includes("getMultipleAccounts")), "the table was read");
  const again = await ok.call("/api/swap/tx", { body: quoteBody({ taker: TAKER, inputMint: USDC, amount: "6" }) });
  assert.equal(again.status, 200);
  assert.equal(ok.W.rpc.log.filter((l) => l.methods.includes("getMultipleAccounts")).length, 1, "the table is cached");
  for (const code of ["alt_mismatch", "alt_missing"]) {
    const bad = world({}, { jupiter: { hostile: code, alt: true } });
    const x = await bad.call("/api/swap/tx", { body: quoteBody({ taker: TAKER, inputMint: USDC, amount: "5" }) });
    assert.deepEqual([x.status, x.data.error], [502, code], code);
  }
  // a wallet without version-0 support cannot take a route that needs a table
  const leg = await ok.call("/api/swap/tx", { body: quoteBody({ taker: TAKER, inputMint: USDC, amount: "7", v: "legacy" }) });
  assert.deepEqual([leg.status, leg.data.error], [400, "needs_v0"]);
  // without a table a legacy wallet gets a legacy message
  const plain = world();
  const l2 = await plain.call("/api/swap/tx", { body: quoteBody({ taker: TAKER, v: "legacy" }) });
  assert.deepEqual([l2.status, l2.data.version, decodeHeader(fromBase64(l2.data.tx)).version], [200, "legacy", "legacy"]);
});

test("swap: the simulation turns a failure into a plain code before the wallet opens; the priority fee is capped at 0.01 SOL", async () => {
  const { W, call } = world({}, { jupiter: { cuPrice: 1_000_000_000_000n } });
  const slip = (txB64) => ({ err: { InstructionError: [swapIndex(txB64), { Custom: 6001 }] }, logs: ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771"] });
  W.rpc.sim = slip;
  let r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) });
  assert.deepEqual([r.status, r.data.error, r.data.name, r.data.stage], [409, "slippage", "SlippageToleranceExceeded", "simulation"]);
  W.rpc.sim = () => ({ err: { InstructionError: [1, { Custom: 1 }] }, logs: ["Program 11111111111111111111111111111111 failed: custom program error: 0x1", "Transfer: insufficient lamports 100, need 250000000"] });
  r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, amount: "0.26" }) });
  assert.deepEqual([r.status, r.data.error], [409, "insufficient_sol"]);
  W.rpc.sim = () => ({ err: "InsufficientFundsForFee", logs: [] });
  r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, amount: "0.27" }) });
  assert.equal(r.data.error, "insufficient_sol");
  W.rpc.sim = (txB64) => ({ err: { InstructionError: [swapIndex(txB64), { Custom: 6025 }] }, logs: [] });
  r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, amount: "0.28" }) });
  assert.deepEqual([r.data.error, r.data.program, r.data.name], ["program_error", PROGRAM_IDS.jupiter, "6025"]);
  W.rpc.sim = () => ({ err: null, logs: [], unitsConsumed: 300_000 });
  r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, amount: "0.29" }) });
  assert.equal(r.status, 200);
  assert.equal(r.data.fees.computeUnitLimit, 360_000);
  assert.ok(r.data.fees.priorityLamports <= 10_000_000 && r.data.fees.priorityLamports >= 9_999_000, `capped: ${r.data.fees.priorityLamports}`);
  assert.ok(BigInt(r.data.fees.computeUnitPrice) < 1_000_000_000_000n);
  // the RPC down: the transaction is still built, with the default limit, and says it was not simulated
  W.rpc.sim = () => { throw { code: -32005, message: "node is behind" }; };
  r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, amount: "0.31" }) });
  assert.deepEqual([r.status, r.data.simulated, r.data.fees.computeUnitLimit], [200, false, 600_000]);
});

test("swap: the relay sends only a well-formed, signed, small transaction; preflight failures come back in plain words; statuses and balances", async () => {
  const { W, call } = world();
  const tx = (await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) })).data;
  assert.deepEqual((await call("/api/swap/send", { body: { tx: tx.tx } })).data, { ok: false, error: "unsigned" });
  assert.deepEqual((await call("/api/swap/send", { body: { tx: "@@@" } })).data, { ok: false, error: "bad_tx" });
  assert.equal((await call("/api/swap/send", { body: { tx: toBase64(new Uint8Array(1300)) } })).data.error, "tx_too_large");
  assert.equal((await call("/api/swap/send", { body: { tx: toBase64(fromBase64(tx.tx).subarray(0, 100)) } })).data.error, "bad_tx");
  const sent = await call("/api/swap/send", { body: { tx: signed(tx.tx), lastValidBlockHeight: tx.lastValidBlockHeight } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.match(sent.data.signature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  assert.equal(sent.data.solscan, `https://solscan.io/tx/${sent.data.signature}`);
  assert.equal(W.rpc.sent.length, 1);
  const st = await call(`/api/swap/status?sig=${sent.data.signature}&lvbh=${tx.lastValidBlockHeight}`);
  assert.deepEqual([st.data.status, st.data.solscan, st.headers.get("Cache-Control")], ["confirmed", sent.data.solscan, "no-store"]);
  W.rpc.statuses[sent.data.signature].confirmationStatus = "finalized";
  assert.equal((await call(`/api/swap/status?sig=${sent.data.signature}`)).data.status, "finalized");
  W.rpc.statuses[sent.data.signature] = { err: { InstructionError: [3, { Custom: 6001 }] }, confirmationStatus: "confirmed", slot: 5 };
  const failed = (await call(`/api/swap/status?sig=${sent.data.signature}`)).data;
  assert.equal(failed.status, "failed");
  assert.deepEqual([failed.err, failed.name], ["program_error", "6001"], "without the transaction at hand the Worker cannot name the program: an honest generic code");
  // the page's poll says which swap program the transaction went through (via=jupiter | curve): a landed 6001 / 6002 reads as slippage, like in simulation
  const viaJup = (await call(`/api/swap/status?sig=${sent.data.signature}&via=jupiter`)).data;
  assert.deepEqual([viaJup.status, viaJup.err, viaJup.name], ["failed", "slippage", "SlippageToleranceExceeded"]);
  W.rpc.statuses[sent.data.signature] = { err: { InstructionError: [4, { Custom: 6002 }] }, confirmationStatus: "confirmed", slot: 5 };
  const viaCurve = (await call(`/api/swap/status?sig=${sent.data.signature}&via=curve`)).data;
  assert.deepEqual([viaCurve.err, viaCurve.name], ["slippage", "ExceededSlippage"]);
  W.rpc.statuses[sent.data.signature] = { err: { InstructionError: [4, { Custom: 6017 }] }, confirmationStatus: "confirmed", slot: 5 };
  assert.equal((await call(`/api/swap/status?sig=${sent.data.signature}&via=curve`)).data.err, "program_error", "other codes stay program errors");
  assert.equal((await call(`/api/swap/status?sig=${sent.data.signature}&via=evil`)).data.err, "program_error", "an unknown via is ignored");
  const unknown = "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk";
  assert.equal((await call(`/api/swap/status?sig=${unknown}&lvbh=${W.rpc.blockHeight + 10}`)).data.status, "pending");
  assert.equal((await call(`/api/swap/status?sig=${unknown}&lvbh=${W.rpc.blockHeight - 10}`)).data.status, "expired");
  assert.deepEqual((await call("/api/swap/status?sig=zzz")).data, { ok: false, error: "bad_signature" });
  // a preflight failure from the node
  W.rpc.send = () => ({ error: { InstructionError: [swapIndex(tx.tx), { Custom: 6001 }] }, message: "custom program error: 0x1771", logs: [] });
  const refused = await call("/api/swap/send", { body: { tx: signed(tx.tx) } });
  assert.deepEqual([refused.status, refused.data.error], [409, "slippage"]);
  W.rpc.send = () => ({ error: "BlockhashNotFound", message: "Blockhash not found", logs: [] });
  assert.equal((await call("/api/swap/send", { body: { tx: signed(tx.tx) } })).data.error, "blockhash_expired");
  // balances: SOL and the asked mints of one wallet, 10 s per server
  assert.deepEqual((await call("/api/swap/balances?owner=" + POOL)).data, { ok: false, error: "bad_wallet" });
  const b = await call(`/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC},${USDC}`);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.deepEqual([b.data.sol.lamports, b.data.sol.ui, b.data.tokens[REAL_VIC].ui, b.data.tokens[REAL_VIC].hasAccount, b.data.tokens[USDC].ui], [2_000_000_000, 2, 1234.5, true, 0]);
  const rpcCalls = W.rpc.log.length;
  await call(`/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC},${USDC}`);
  assert.equal(W.rpc.log.length, rpcCalls, "the second look within 10 s is answered from memory");
});

test("swap: attempt limits: the 21st /tx from one connection and the 16th from one wallet answer 429 slow_down", async () => {
  const { call } = world();
  let last;
  for (let i = 0; i < 21; i++) last = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, amount: String(1 + i / 100) }), ip: "9.9.9.9" });
  assert.deepEqual([last.status, last.data.error, last.headers.get("Retry-After")], [429, "slow_down", "60"]);
  for (let i = 0; i < 16; i++) last = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER2, amount: String(2 + i / 100) }), ip: `10.0.0.${i + 1}` });
  assert.deepEqual([last.status, last.data.error], [429, "slow_down"], "one wallet from many connections");
  for (let i = 0; i < 61; i++) last = await call("/api/swap/quote", { body: quoteBody(), ip: "8.8.8.8" });
  assert.equal(last.status, 429, "the 61st quote from one connection");
});

test("swap: with the switch on the trade links of /api/launchpad and /api/coin carry `here` (this site's own Buy), without it nothing changes", async () => {
  const { buyHereLink, tradeLinks } = await import("../src/launchpad.js");
  assert.equal(buyHereLink({ SWAP: "on", VICINITY_MINT: REAL_VIC }, REAL_VIC), "/token#buy-slot");
  assert.equal(buyHereLink({ SWAP: "on", VICINITY_MINT: REAL_VIC }, POOL), `/coin?mint=${POOL}`);
  assert.equal(buyHereLink({ SWAP: "off", VICINITY_MINT: REAL_VIC }, REAL_VIC), null);
  assert.equal(buyHereLink({ SWAP: "on" }, null), null);
  assert.deepEqual(Object.keys(tradeLinks(POOL, SOL)), ["raydium", "jupiter", "dexscreener", "solscan"], "no `here` key while the switch is off: the answer is exactly as before");
  assert.equal(tradeLinks(POOL, SOL, "/coin?mint=" + POOL).here, "/coin?mint=" + POOL);
  const on = world({ LAUNCHPAD_V2: "on" });
  const lp = await on.call("/api/launchpad");
  assert.equal(lp.status, 200, JSON.stringify(lp.data).slice(0, 200));
  assert.equal(lp.data.vicinity.links.here, "/token#buy-slot");
  assert.equal(lp.data.vicinity.links.raydium, `https://raydium.io/launchpad/token/?mint=${REAL_VIC}`, "the information links stay");
  const off = world({ LAUNCHPAD_V2: "on", SWAP: "off" });
  assert.equal((await off.call("/api/launchpad")).data.vicinity.links.here, undefined);
});
