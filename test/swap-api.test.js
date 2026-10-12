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
import { _resetSwap, _swapState, handleSwapQuote, handleSwapTx } from "../src/swap.js";
import { _resetRelay } from "../src/relay.js";
import { _resetMarketLive } from "../src/marketlive.js";
import { compileLegacy, decodeHeader, wrapUnsigned } from "../src/sol/message.js";
import { fromBase64, toBase64 } from "../src/sol/bytes.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { PUBLIC_LIMITS, STATUS_LIMIT } from "../src/guards.js";
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
  // only what this Worker built is relayed: the ticket of the /tx answer must come along (an HMAC over the message bytes, 10 minutes)
  assert.match(tx.ticket, /^\d{13}\.[A-Za-z0-9_-]{22}$/);
  assert.deepEqual((await call("/api/swap/send", { body: { tx: signed(tx.tx), lastValidBlockHeight: tx.lastValidBlockHeight } })).data.error, "bad_ticket", "no ticket");
  assert.deepEqual((await call("/api/swap/send", { body: { tx: signed(tx.tx), ticket: tx.ticket.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } })).data.error, "bad_ticket", "a forged ticket");
  assert.deepEqual((await call("/api/swap/send", { body: { tx: signed(tx.tx), ticket: `${Date.now() - 1000}.${tx.ticket.split(".")[1]}` } })).data.error, "bad_ticket", "an expired ticket");
  assert.equal(W.rpc.sent.length, 0, "nothing reached the node without a valid ticket");
  const sent = await call("/api/swap/send", { body: { tx: signed(tx.tx), ticket: tx.ticket, lastValidBlockHeight: tx.lastValidBlockHeight } });
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
  const refused = await call("/api/swap/send", { body: { tx: signed(tx.tx), ticket: tx.ticket } });
  assert.deepEqual([refused.status, refused.data.error], [409, "slippage"]);
  W.rpc.send = () => ({ error: "BlockhashNotFound", message: "Blockhash not found", logs: [] });
  assert.equal((await call("/api/swap/send", { body: { tx: signed(tx.tx), ticket: tx.ticket } })).data.error, "blockhash_expired");
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
  for (let i = 0; i < PUBLIC_LIMITS.swap_quote.max + 1; i++) last = await call("/api/swap/quote", { body: quoteBody(), ip: "8.8.8.8" });
  assert.equal(last.status, 429, `the ${PUBLIC_LIMITS.swap_quote.max + 1}st quote from one connection`);
  assert.equal(PUBLIC_LIMITS.swap_quote.max, 180, "a dozen phones behind one carrier address, each re-quoting every 12 s, fit in a minute");
});

test("swap: the panel's own builds before the tap (?auto=1) are counted apart: a crowd's automatic builds never use up a Buy tap's 20 a minute per connection or a wallet's 15; the 61st automatic one from one connection and the 16th of one wallet answer 429", async () => {
  const { call } = world();
  const crowd = [TAKER2, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "E1JXiiJ9zHpn4LP5rs3hqEbeT9fznKtGUEvs2fpxEvke"];
  let last;
  // five neighbours behind one address (iCloud Private Relay), 12 automatic builds each: 60, all answered
  for (let i = 0; i < 60; i++) { last = await call("/api/swap/tx?auto=1", { body: quoteBody({ taker: crowd[i % 5], amount: String(1 + i / 100) }), ip: "172.224.226.5" }); assert.notEqual(last.status, 429, `automatic build ${i + 1}`); }
  last = await call("/api/swap/tx?auto=1", { body: quoteBody({ taker: crowd[0], amount: "3" }), ip: "172.224.226.5" });
  assert.deepEqual([last.status, last.data.error, last.headers.get("Retry-After")], [429, "slow_down", "60"], "the 61st automatic build from one connection");
  // the same people (and the buyer) behind that address tap: the taps' own 20 are untouched, and so is each wallet's own 15
  for (let i = 0; i < 20; i++) { last = await call("/api/swap/tx", { body: quoteBody({ taker: i % 2 ? TAKER : crowd[i % 5], amount: String(4 + i / 100) }), ip: "172.224.226.5" }); assert.notEqual(last.status, 429, `tap ${i + 1} after the crowd's automatic builds`); }
  last = await call("/api/swap/tx", { body: quoteBody({ taker: crowd[1], amount: "5" }), ip: "172.224.226.5" });
  assert.equal(last.status, 429, "taps keep their own limit: the 21st tap from one connection");
  // one wallet: 15 automatic builds a minute (two tabs, two devices) never touch its 15 taps; the 16th automatic one is refused
  const W2 = "GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL"; // a wallet with no builds yet this minute
  for (let i = 0; i < 15; i++) { last = await call("/api/swap/tx?auto=1", { body: quoteBody({ taker: W2, amount: String(6 + i / 100) }), ip: `10.2.0.${i + 1}` }); assert.notEqual(last.status, 429); }
  last = await call("/api/swap/tx?auto=1", { body: quoteBody({ taker: W2, amount: "7" }), ip: "10.2.1.1" });
  assert.deepEqual([last.status, last.data.error], [429, "slow_down"], "the 16th automatic build of one wallet");
  last = await call("/api/swap/tx", { body: quoteBody({ taker: W2, amount: "7.5" }), ip: "10.2.1.2" });
  assert.notEqual(last.status, 429, "that wallet's tap still builds");
  // ?auto=anything else is a tap (counted as one, never as free)
  for (let i = 0; i < 20; i++) await call("/api/swap/tx?auto=yes", { body: quoteBody({ taker: crowd[2], amount: String(8 + i / 100) }), ip: "10.3.0.1" });
  last = await call("/api/swap/tx", { body: quoteBody({ taker: crowd[3], amount: "9" }), ip: "10.3.0.1" });
  assert.equal(last.status, 429);
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
  assert.equal(lp.data.vicinity.links.jupiter, `https://jup.ag/tokens/${REAL_VIC}`, "with the swap on, the Jupiter link is the token's information page, never its swap page");
  assert.equal(tradeLinks(POOL, SOL, "/coin?mint=" + POOL).jupiter, `https://jup.ag/tokens/${POOL}`);
  const off = world({ LAUNCHPAD_V2: "on", SWAP: "off" });
  assert.equal((await off.call("/api/launchpad")).data.vicinity.links.here, undefined);
});

test("swap: the platform fee is reported as configured (not a fixed 0), and with a fee on the build must pay it to SWAP_FEE_ACCOUNT and nobody else", async () => {
  const FEE_ACCT = "GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL";
  const off = world();
  assert.equal((await off.call("/api/swap/quote", { body: quoteBody() })).data.fees.platformFeeBps, 0);
  // the fee set but no account: no fee is charged (jupiterConfig says 50 bps but feeAccount null): the Worker asks for no fee and reports what it charges
  const on = world({ SWAP_PLATFORM_FEE_BPS: "50", SWAP_FEE_ACCOUNT: FEE_ACCT });
  assert.equal((await on.call("/api/swap/config")).data.platformFeeBps, 50);
  const q = await on.call("/api/swap/quote", { body: quoteBody() });
  assert.equal(q.data.fees.platformFeeBps, 50, "a keyless estimate reports the fee the transaction will charge");
  const b = await on.call("/api/swap/quote", { body: quoteBody({ taker: TAKER }) });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.fees.platformFeeBps, 50);
  const ask = on.W.jup.log.find((l) => l.path === "/swap/v2/build");
  assert.deepEqual([ask.q.platformFeeBps, ask.q.feeAccount], ["50", FEE_ACCT], "Jupiter is asked for the fee to our account");
  const tx = await on.call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) });
  assert.equal(tx.status, 200, JSON.stringify(tx.data));
  assert.deepEqual([tx.data.fees.platformFeeBps, tx.data.quote.fees.platformFeeBps], [50, 50]);
  // the build pays the fee to a stranger: refused before anything is compiled or simulated
  const bad = world({ SWAP_PLATFORM_FEE_BPS: "50", SWAP_FEE_ACCOUNT: FEE_ACCT }, { jupiter: { platformFeeBps: 50, feeAccount: "47ugnHuxsmgNZu8KEv1VXW7wPVVwMWti8vVrK4ADDxWa" } });
  const r = await bad.call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) });
  assert.deepEqual([r.status, r.data.error], [502, "jupiter_refused"]);
  assert.ok(!bad.W.rpc.log.some((l) => l.methods.includes("simulateTransaction")));
  // the build charges a fee although none is configured: refused (the swap's bps must equal the setting)
  const sneaky = world({}, { jupiter: { platformFeeBps: 50, feeAccount: FEE_ACCT } });
  assert.deepEqual((await sneaky.call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) })).data.error, "jupiter_refused");
});

test("swap: /tx takes from the same per-server Jupiter budget as the previews (never an unmetered build); a quote reuses its build without a token", async () => {
  const { W, call } = world({ JUPITER_RPS: "1" });
  const a = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const b = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, amount: "0.3" }) });
  assert.deepEqual([b.status, b.data.error, b.data.retryAfterS, b.headers.get("Retry-After")], [503, "jupiter_busy", 2, "2"], "the bucket is empty: no build, try again in a moment");
  assert.equal(W.jup.log.filter((l) => l.path === "/swap/v2/build").length, 1, "one build for the first call, none for the refused one");
  const again = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) });
  assert.equal(again.status, 200, "the first build is still cached: no token needed");
  assert.equal(W.jup.log.filter((l) => l.path === "/swap/v2/build").length, 1);
  assert.equal(_swapState().bucket < 1, true);
});

test("swap: a 429 on the keyed build host pauses builds only: previews fall back to the lite estimate, and a lite 429 does not stop cached builds", async () => {
  const { W, call } = world();
  // the lite host keeps answering while the keyed one says 429: the fake answers per host
  const keyedOnly429 = (url, init) => (/api\.jup\.ag/.test(String(url)) && /swap\/v2\/build/.test(String(url)) ? new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "20" } }) : W.fetch(url, init));
  const q = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER }), fetchImpl: keyedOnly429 });
  assert.deepEqual([q.status, q.data.source, q.data.estimate], [200, "jupiter_quote", true], "a taker's preview becomes an estimate instead of a 503 while the keyed host is paused");
  assert.deepEqual(W.jup.log.filter((l) => l.path.startsWith("/swap")).map((l) => l.path), ["/swap/v1/quote"], "the lite host was asked once (the keyed 429 is not in the fake's log: it never reached it)");
  const st = _swapState();
  assert.ok(st.failed.keyed > Date.now() + 15_000 && st.failed.lite === 0, "only the keyed host is paused, for its Retry-After");
  const q2 = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER2 }) });
  assert.deepEqual([q2.status, q2.data.source], [200, "jupiter_quote"], "the next visitor gets an estimate too, without touching the paused host");
  assert.equal(W.jup.log.filter((l) => l.path === "/swap/v2/build").length, 0);
  const tx = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) });
  assert.deepEqual([tx.status, tx.data.error], [503, "jupiter_busy"], "a build is still refused while the keyed host is paused (the page says 'busy, try again in a few seconds')");
  _resetSwap();
  // the other way round: a cached build keeps serving /tx while the lite host is paused
  const b = await call("/api/swap/quote", { body: quoteBody({ taker: TAKER }) });
  assert.equal(b.data.source, "jupiter_build");
  const liteOnly429 = (url, init) => (/lite-api\.jup\.ag/.test(String(url)) ? new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "20" } }) : W.fetch(url, init));
  assert.deepEqual((await call("/api/swap/quote", { body: quoteBody(), fetchImpl: liteOnly429 })).data.error, "jupiter_busy", "a keyless preview is refused: the build just took from the bucket, so it is not full and the keyed host does not stand in");
  const tx2 = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }), fetchImpl: liteOnly429 });
  assert.equal(tx2.status, 200, "the taker's build still goes through");
  assert.deepEqual([_swapState().failed.lite > 0, _swapState().failed.keyed], [true, 0]);
});

/** A swap route's handler called straight, at a chosen moment (the keyed stand-in's 10 s and the bucket are about time). */
async function at(handler, env, fetchImpl, now, path, body, ip = "1.2.3.4") {
  const res = await handler(new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip }, body: JSON.stringify(body) }), env, fetchImpl, now);
  return { status: res.status, data: await res.json(), headers: res.headers };
}
const LITE_Q = ["lite-api.jup.ag", "/swap/v1/quote", false], KEYED_Q = ["api.jup.ag", "/swap/v1/quote", true], KEYED_BUILD = ["api.jup.ag", "/swap/v2/build", true];
const swapCalls = (W) => W.jup.log.filter((l) => l.path.startsWith("/swap")).map((l) => [l.host, l.path, l.keyed]);
/** A server (JUPITER_RPS=1: a bucket of two) whose bucket is FULL at `s`: a connected buyer's preview 5 s earlier took a token, and it has filled up since. The fake's log starts empty. */
async function fullAt(extraEnv = {}) {
  const w = world({ JUPITER_RPS: "1", ...extraEnv });
  const s = Date.now();
  const b = await at(handleSwapQuote, w.env, w.W.fetch, s - 5000, "/api/swap/quote", quoteBody({ taker: TAKER, amount: "9" }));
  assert.equal(b.data.source, "jupiter_build");
  w.W.jup.log.length = 0;
  return { ...w, s };
}

test("swap: on the Free plan's rate (JUPITER_RPS=0.5, a bucket of ONE token) the keyed host never stands in for the lite one, on any number of servers: a lite hiccup is the lite host's own error (the panel's quiet retries absorb it) and every server's Buy tap still builds", async () => {
  const { W, env } = world({ JUPITER_RPS: "0.5" });
  const other = await import("../src/swap.js?server=2"); // a second server (Worker isolate): its own bucket, caches and pauses
  other._resetSwap();
  W.jup.setMode("http500", "lite-api.jup.ag");
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    const handler = i % 2 ? other.handleSwapQuote : handleSwapQuote;
    const r = await at(handler, env, W.fetch, t0 + i * 2500, "/api/swap/quote", quoteBody({ amount: String(1 + i) }), `10.0.0.${i + 1}`);
    assert.deepEqual([r.status, r.data.error], [503, "jupiter_unavailable"], `visitor ${i}`);
  }
  assert.equal(swapCalls(W).filter(([host]) => host === "api.jup.ag").length, 0, "not one keyed call for a visitor without a wallet, on either server");
  assert.ok(swapCalls(W).length >= 4, "the lite host was asked (each server, after each 5 s pause)");
  for (const [name, tx, state, amount] of [["this server", handleSwapTx, _swapState, "0.3"], ["the other server", other.handleSwapTx, other._swapState, "0.4"]]) {
    const tap = await at(tx, env, W.fetch, t0 + 31_000, "/api/swap/tx", quoteBody({ taker: TAKER, amount }));
    assert.equal(tap.status, 200, `${name}: ${JSON.stringify(tap.data)}`);
    assert.equal(state().failed.keyed, 0, name);
  }
  assert.deepEqual(swapCalls(W).filter(([host]) => host === "api.jup.ag"), [KEYED_BUILD, KEYED_BUILD]);
  other._resetSwap();
});

test("swap: on a plan with room to spare (JUPITER_RPS >= 1, a bucket of two) a passing lite failure on an estimate is asked ONCE of the keyed host's /swap/v1/quote (still an estimate, shared 12 s): only from a FULL bucket, so a Buy tap always finds the token it leaves, and at most once per 10 s per server", async () => {
  const { W, env } = world({ JUPITER_RPS: "1" });
  const quote = (now, over, ip) => at(handleSwapQuote, env, W.fetch, now, "/api/swap/quote", quoteBody(over), ip);
  W.jup.setMode("http500", "lite-api.jup.ag");
  const t0 = Date.now();
  // a fresh server holds one token of its two: not full, no stand-in yet
  const a0 = await quote(t0, { amount: "1" });
  assert.deepEqual([a0.status, a0.data.error, swapCalls(W)], [503, "jupiter_unavailable", [LITE_Q]]);
  // 1.5 s later the bucket is full (the lite host is still paused: a passing failure too): the keyed host stands in, once, with the key
  const a = await quote(t0 + 1500, { amount: "1" });
  assert.deepEqual([a.status, a.data.source, a.data.estimate, a.data.inAmount, a.data.inUi], [200, "jupiter_quote", true, "1000000000", "1"], "the visitor gets the estimate, not an error");
  assert.deepEqual(swapCalls(W), [LITE_Q, KEYED_Q], "the lite host first, then the keyed host once, with the key");
  assert.equal(W.jup.log.find((l) => l.host === "api.jup.ag" && l.path === "/swap/v1/quote").q.amount, "1000000000", "the same request");
  assert.ok(_swapState().bucket >= 1 && _swapState().standInAt >= t0 + 1500 && _swapState().standInAt < t0 + 2500, "the stand-in left a token in the bucket");
  // a Buy tap right after it: the token the stand-in left is the tap's
  const tap = await at(handleSwapTx, env, W.fetch, t0 + 1600, "/api/swap/tx", quoteBody({ taker: TAKER, amount: "0.3" }));
  assert.equal(tap.status, 200, JSON.stringify(tap.data));
  assert.deepEqual(swapCalls(W).slice(2), [KEYED_BUILD]);
  // shared like any estimate: the same trade within 12 s costs no call at all
  const a2 = await quote(t0 + 2000, { amount: "1" }, "9.9.9.9");
  assert.deepEqual([a2.status, a2.data.outAmount, swapCalls(W).length], [200, a.data.outAmount, 3]);
  // 10.5 s after the last stand-in, a full bucket: the keyed host stands in again; 6 s after that, a full bucket but not yet
  const b = await quote(t0 + 12_000, { amount: "3" });
  assert.deepEqual([b.status, b.data.source], [200, "jupiter_quote"]);
  assert.deepEqual(swapCalls(W).slice(3), [LITE_Q, KEYED_Q]);
  const c = await quote(t0 + 18_000, { amount: "4" });
  assert.deepEqual([c.status, c.data.error], [503, "jupiter_unavailable"]);
  assert.deepEqual(swapCalls(W).slice(5), [LITE_Q], "its 10 s are not over");
  // a connected buyer's preview took a token: the bucket still HAS one, but it is not full, so an estimate does not take it
  const e = await quote(t0 + 30_000, { taker: TAKER, amount: "5" });
  assert.equal(e.data.source, "jupiter_build");
  const f = await quote(t0 + 30_500, { amount: "6" });
  assert.deepEqual([f.status, f.data.error], [503, "jupiter_unavailable"]);
  assert.ok(_swapState().bucket >= 1, "a token was there, kept for a build");
  assert.deepEqual(swapCalls(W).slice(6), [KEYED_BUILD, LITE_Q], "no keyed quote: the bucket was not full");
  // the lite host back: no keyed call at all
  W.jup.setMode(null, "lite-api.jup.ag");
  const g = await quote(t0 + 60_000, { amount: "7" });
  assert.deepEqual([g.status, g.data.source], [200, "jupiter_quote"]);
  assert.deepEqual(swapCalls(W).slice(8), [LITE_Q]);
  // the network or a 429 are passing failures too (asked once the lite host's pause is over, on a full bucket)
  for (const [mode, after] of [["neterr", 6000], ["http429", 8000]]) {
    const w2 = world({ JUPITER_RPS: "1" });
    w2.W.jup.setMode(mode, "lite-api.jup.ag");
    const s = Date.now();
    await at(handleSwapQuote, w2.env, w2.W.fetch, s, "/api/swap/quote", quoteBody());
    const r = await at(handleSwapQuote, w2.env, w2.W.fetch, s + after, "/api/swap/quote", quoteBody({ amount: "0.5" }));
    assert.deepEqual([r.status, r.data.estimate, swapCalls(w2.W)], [200, true, [LITE_Q, LITE_Q, KEYED_Q]], mode);
  }
});

test("swap: the stand-in's own failure pauses only the stand-in (its Retry-After honoured), never the builds; its pause and its 10 s, like the lite host's pause, start when the lite call FAILED (a timeout: 6 s after it started)", async () => {
  const { W, env, s } = await fullAt();
  const stood = [];
  let keyed429 = true;
  const fetchImpl = (url, init) => {
    if (/^https:\/\/api\.jup\.ag\/swap\/v1\/quote/.test(String(url))) { stood.push(String(url)); if (keyed429) return Promise.resolve(new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } })); }
    return W.fetch(url, init);
  };
  W.jup.setMode("http500", "lite-api.jup.ag");
  const r = await at(handleSwapQuote, env, fetchImpl, s, "/api/swap/quote", quoteBody({ amount: "2" }));
  assert.deepEqual([r.status, r.data.error, stood.length], [503, "jupiter_unavailable", 1], "the keyed host said 429 to the stand-in: the lite host's own error");
  assert.ok(_swapState().standInUntil >= s + 30_000, "the stand-in pauses for the Retry-After it was given");
  assert.equal(_swapState().failed.keyed, 0, "the builds are not paused");
  keyed429 = false;
  const tap = await at(handleSwapTx, env, fetchImpl, s + 1000, "/api/swap/tx", quoteBody({ taker: TAKER, amount: "0.3" }));
  assert.equal(tap.status, 200, `a Buy tap a second later builds: ${JSON.stringify(tap.data)}`);
  const preview = await at(handleSwapQuote, env, fetchImpl, s + 3000, "/api/swap/quote", quoteBody({ taker: TAKER, amount: "0.4" }));
  assert.deepEqual([preview.status, preview.data.source], [200, "jupiter_build"], "and so does a connected buyer's preview");
  // 12 s after it (its 10 s over, the bucket full, the lite host asked and failing) its own pause still holds; after it, it stands in
  const later1 = await at(handleSwapQuote, env, fetchImpl, s + 12_000, "/api/swap/quote", quoteBody({ amount: "3" }));
  assert.deepEqual([later1.status, stood.length, _swapState().standInAt < s + 1000], [503, 1, true], "not asked, and no token taken, while it is paused");
  const later2 = await at(handleSwapQuote, env, fetchImpl, s + 31_000, "/api/swap/quote", quoteBody({ amount: "4" }));
  assert.deepEqual([later2.status, later2.data.source, stood.length], [200, "jupiter_quote", 2]);

  // a lite TIMEOUT, on a clock that moves 6 s while the call waits
  const t = await fullAt();
  const realNow = Date.now;
  let skew = 0, liteCalls = 0;
  const slowLite = (url, init) => {
    if (!/^https:\/\/lite-api\.jup\.ag\/swap/.test(String(url))) return t.W.fetch(url, init);
    liteCalls++;
    skew += 6000;
    return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  };
  Date.now = () => realNow() + skew;
  try {
    const first = await at(handleSwapQuote, t.env, slowLite, t.s, "/api/swap/quote", quoteBody({ amount: "1" }));
    assert.deepEqual([first.status, first.data.estimate, swapCalls(t.W)], [200, true, [KEYED_Q]], "the stand-in answered once the lite call timed out");
    const st = _swapState();
    assert.ok(st.failed.lite >= t.s + 11_000, `the lite host pauses 5 s from its timeout (6 s in), not from the start: ${st.failed.lite - t.s}`);
    assert.ok(st.standInAt >= t.s + 6000, `the stand-in is dated when it was asked: ${st.standInAt - t.s}`);
    // a visitor 10 s after the first started (4 s after the stand-in): the lite host is still paused and the stand-in's 10 s are not over
    const next = await at(handleSwapQuote, t.env, slowLite, t.s + 10_000, "/api/swap/quote", quoteBody({ amount: "2" }));
    assert.deepEqual([next.status, next.data.error, liteCalls, swapCalls(t.W).length], [503, "jupiter_unavailable", 1, 1], "nothing reached Jupiter");
  } finally { Date.now = realNow; }
});

test("swap: the keyed host never stands in for a real answer (no route, too small, refused), without a key, or while it is paused itself; both hosts down: the lite host's error; a real answer from the keyed host is the answer", async () => {
  const lite = (W, status, body) => (url, init) => (/lite-api\.jup\.ag\/swap/.test(String(url)) ? (W.jup.log.push({ path: new URL(String(url)).pathname, host: "lite-api.jup.ag", keyed: false }), new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) : W.fetch(url, init));
  for (const [name, make, status, code] of [
    ["no route", (W) => (W.jup.setMode("noroute", "lite-api.jup.ag"), W.fetch), 404, "no_route"],
    ["too small", (W) => (W.jup.setMode("small", "lite-api.jup.ag"), W.fetch), 400, "amount_too_small"],
    ["refused", (W) => lite(W, 422, { error: "something else entirely" }), 502, "jupiter_refused"],
  ]) {
    const { W, env, s } = await fullAt();
    const r = await at(handleSwapQuote, env, make(W), s, "/api/swap/quote", quoteBody());
    assert.deepEqual([r.status, r.data.error], [status, code], name);
    assert.deepEqual(swapCalls(W), [LITE_Q], `${name}: an answer, never asked twice (on a full bucket)`);
  }
  // no key: nothing to stand in with
  const nokey = world({ JUPITER_API_KEY: "", JUPITER_RPS: "1" });
  nokey.W.jup.setMode("http500", "lite-api.jup.ag");
  const n0 = Date.now();
  await at(handleSwapQuote, nokey.env, nokey.W.fetch, n0, "/api/swap/quote", quoteBody());
  const n = await at(handleSwapQuote, nokey.env, nokey.W.fetch, n0 + 6000, "/api/swap/quote", quoteBody({ amount: "0.5" }));
  assert.deepEqual([n.status, n.data.error, swapCalls(nokey.W)], [503, "jupiter_unavailable", [LITE_Q, LITE_Q]]);
  // the keyed host paused by a 429 on a build (7 s): with a full bucket 3 s later it still does not stand in
  const p = world({ JUPITER_RPS: "1" });
  const t0 = Date.now();
  p.W.jup.setMode("http429", "api.jup.ag");
  const built = await at(handleSwapQuote, p.env, p.W.fetch, t0, "/api/swap/quote", quoteBody({ taker: TAKER }));
  assert.deepEqual([built.status, built.data.source], [200, "jupiter_quote"], "the build's 429: the lite estimate, as before");
  p.W.jup.setMode(null, "api.jup.ag"); p.W.jup.setMode("http500", "lite-api.jup.ag");
  const paused = await at(handleSwapQuote, p.env, p.W.fetch, t0 + 3000, "/api/swap/quote", quoteBody({ amount: "0.4" }));
  assert.deepEqual([paused.status, paused.data.error], [503, "jupiter_unavailable"]);
  assert.deepEqual(swapCalls(p.W), [KEYED_BUILD, LITE_Q, LITE_Q], "after the build's 429 the keyed host was not asked again while paused");
  // a taker whose keyed build fails falls back to the lite estimate as before; with the lite host down too, nothing more is asked
  const tk = world({ JUPITER_RPS: "1" });
  tk.W.jup.setMode("http500");
  const both = await at(handleSwapQuote, tk.env, tk.W.fetch, Date.now(), "/api/swap/quote", quoteBody({ taker: TAKER }));
  assert.deepEqual([both.status, both.data.error, swapCalls(tk.W)], [503, "jupiter_unavailable", [KEYED_BUILD, LITE_Q]]);
  // both hosts down for an estimate: the keyed host is asked once, the lite host's error is the answer; only the stand-in pauses
  const dn = await fullAt();
  dn.W.jup.setMode("http500");
  const down = await at(handleSwapQuote, dn.env, dn.W.fetch, dn.s, "/api/swap/quote", quoteBody());
  assert.deepEqual([down.status, down.data.error, swapCalls(dn.W)], [503, "jupiter_unavailable", [LITE_Q, KEYED_Q]]);
  assert.deepEqual([_swapState().failed.keyed, _swapState().standInUntil > dn.s], [0, true], "the stand-in's own pause; the builds are not paused");
  const busy = await fullAt();
  busy.W.jup.setMode("http500", "lite-api.jup.ag"); busy.W.jup.setMode("http429", "api.jup.ag");
  const b = await at(handleSwapQuote, busy.env, busy.W.fetch, busy.s, "/api/swap/quote", quoteBody());
  assert.deepEqual([b.status, b.data.error, _swapState().failed.keyed], [503, "jupiter_unavailable", 0], "the keyed host's 429 on the stand-in: still the lite host's answer, the builds not paused");
  // the keyed host's real answer (no route) is the answer
  const nr = await fullAt();
  nr.W.jup.setMode("http500", "lite-api.jup.ag"); nr.W.jup.setMode("noroute", "api.jup.ag");
  const r = await at(handleSwapQuote, nr.env, nr.W.fetch, nr.s, "/api/swap/quote", quoteBody());
  assert.deepEqual([r.status, r.data.error, swapCalls(nr.W)], [404, "no_route", [LITE_Q, KEYED_Q]]);
});

test("swap: the status poll is counted per SIGNATURE (60 a minute) so one trade's polling never uses up another's; a bad signature costs nothing; the connection's own brake is 120", async () => {
  const { call } = world();
  const sigA = "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk";
  const sigB = "4ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk";
  assert.equal(STATUS_LIMIT.max, 60);
  let last;
  for (let i = 0; i < STATUS_LIMIT.max + 1; i++) last = await call(`/api/swap/status?sig=${sigA}`, { ip: "7.7.7.7" });
  assert.deepEqual([last.status, last.data.error, last.headers.get("Retry-After")], [429, "slow_down", "60"], "the 61st poll of one signature");
  const other = await call(`/api/swap/status?sig=${sigB}`, { ip: "7.7.7.7" });
  assert.equal(other.status, 200, "another person's trade behind the same address still polls");
  for (let i = 0; i < 20; i++) assert.equal((await call("/api/swap/status?sig=zzz", { ip: "7.7.7.8" })).data.error, "bad_signature");
  assert.equal((await call(`/api/swap/status?sig=${sigB}`, { ip: "7.7.7.8" })).status, 200, "bad signatures were not counted against the connection");
  assert.equal(PUBLIC_LIMITS.swap_status.max, 120);
});

test("swap: balances: a send through the relay forgets the payer's memo, and fresh=1 reads the chain again (counted like a miss)", async () => {
  const { W, call } = world();
  const b1 = await call(`/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC}`);
  assert.equal(b1.data.sol.lamports, 2_000_000_000);
  W.rpc.lamports[TAKER] = 1_500_000_000;
  assert.equal((await call(`/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC}`)).data.sol.lamports, 2_000_000_000, "within 10 s the memo answers");
  assert.equal((await call(`/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC}&fresh=1`)).data.sol.lamports, 1_500_000_000, "fresh=1 reads the chain");
  W.rpc.lamports[TAKER] = 1_000_000_000;
  const tx = (await call("/api/swap/tx", { body: quoteBody({ taker: TAKER }) })).data;
  const sent = await call("/api/swap/send", { body: { tx: signed(tx.tx), ticket: tx.ticket } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal((await call(`/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC}`)).data.sol.lamports, 1_000_000_000, "the payer's memo was forgotten by the send");
  // hasAccount is a real answer now: an empty token account counts as existing, a missing one as missing
  const b = await call(`/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC},${USDC}&fresh=1`);
  assert.deepEqual([b.data.tokens[REAL_VIC].hasAccount, b.data.tokens[USDC].hasAccount], [true, false]);
});

test("swap: a two-signer transaction this Worker did not build is refused by its ticket, and a lookup table whose deactivation began is refused", async () => {
  const { W, call } = world({}, { jupiter: { alt: true } });
  const tx = (await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, inputMint: USDC, amount: "5" }) })).data;
  assert.equal(tx.version, 0);
  // a transaction with two signers (a well-formed one, both slots filled; the relay takes 1 to 4 since the city-coin pages,
  // test/relay-multisig.test.js): carrying the ticket of ANOTHER message, it is refused by the ticket
  const transfer = { programAddress: PROGRAM_IDS.system, accounts: [{ address: TAKER, role: 3 }, { address: TAKER2, role: 3 }], data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0) };
  const two = wrapUnsigned(compileLegacy({ payer: TAKER, instructions: [transfer], blockhash: tx.blockhash })); two.fill(7, 1, 129);
  assert.equal(decodeHeader(two).numSignatures, 2);
  assert.equal((await call("/api/swap/send", { body: { tx: toBase64(two), ticket: tx.ticket } })).data.error, "bad_ticket");
  // two slots glued in front of a one-signer message: refused as malformed before anything else
  assert.equal((await call("/api/swap/send", { body: { tx: toBase64(new Uint8Array([2, ...new Uint8Array(128).fill(7), ...fromBase64(tx.tx).subarray(65)])), ticket: tx.ticket } })).data.error, "bad_tx");
  // the table's deactivation slot set: the next build with it is refused as alt_deactivated
  _resetSwap();
  const raw = fromBase64(W.rpc.accounts[ALT_KEY].data[0]); raw.set([1, 0, 0, 0, 0, 0, 0, 0], 4);
  W.rpc.accounts[ALT_KEY] = { ...W.rpc.accounts[ALT_KEY], data: [toBase64(raw), "base64"] };
  const r = await call("/api/swap/tx", { body: quoteBody({ taker: TAKER, inputMint: USDC, amount: "6" }) });
  assert.deepEqual([r.status, r.data.error], [502, "alt_deactivated"]);
});

test("swap: cluster=devnet on the relay routes is honoured only while the launchpad's curve trades are on; the config names city coins by their ticker", async () => {
  const { W, call } = world();
  await call(`/api/swap/status?sig=5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk&cluster=devnet`);
  assert.ok(!W.rpc.log.some((l) => /devnet/.test(l.url)), "LAUNCHPAD_TRADING off: no devnet node is ever asked");
  const st = await call(`/api/swap/status?sig=5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk&cluster=devnet`);
  assert.equal(st.data.cluster, "mainnet");
  assert.equal((await call(`/api/swap/balances?owner=${TAKER}&cluster=devnet`)).data.cluster, "mainnet");
  // a launched city coin in the config carries the ticker the cards use
  const { seedCoin } = await import("./helpers/launchpad.js");
  const on = world({ LAUNCHPAD_V2: "on" });
  await seedCoin(on.env.DB, { city: 5142056, name: "Utica", coin: "Utica Coin", pair: "SOL", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", user: 0 });
  const c = (await on.call("/api/swap/config")).data.tokens.find((t) => t.kind === "city");
  assert.deepEqual([c.symbol, c.name, c.city.name], ["UTICA", "Utica Coin", "Utica"], "symbol = the ticker, the long name stays the name");
  const coin = await on.call("/api/coin?mint=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  assert.equal(coin.data.coin.ticker, c.symbol, "the same ticker as /api/coin");
});
