/**
 * The in-app swap (only while SWAP=on, src/cluster.js): any pair Jupiter can route (SOL, USDC, USDT, $VICINITY, graduated city
 * coins, any verified token), built server-side from Jupiter's Swap V2 and signed by the person's wallet. The page's security
 * policy allows only this site, so every Jupiter and chain call goes through here; the Worker holds no key and sends nothing on
 * its own (src/relay.js forwards what a wallet signed).
 *   GET  /api/swap/config                tokens, limits, switches (public, edge-cached 60 s)
 *   GET  /api/swap/tokens?q=             verified tokens matching a search (Jupiter tokens v2, edge-cached 300 s per query)
 *   POST /api/swap/quote { inputMint, outputMint, amount, slippageBps?, taker? }
 *   POST /api/swap/tx    { inputMint, outputMint, amount, slippageBps?, taker, quoteId?, v?: "legacy" }
 * Jupiter: with a taker, GET {JUPITER_API_BASE}/swap/v2/build (the keyed host; one build serves the preview and, within 12 s,
 * the Swap click); without a taker, or when this server's share of the plan's rate (JUPITER_RPS) is spent, the keyless
 * lite /swap/v1/quote gives the numbers (marked estimate). /tx takes from the same budget when its build is not cached (never an
 * unmetered build). 429 -> 503 jupiter_busy with Retry-After (honoured, up to 60 s, PER HOST: a paused keyed host turns previews
 * into estimates from the lite host instead of refusing everyone); timeout / 5xx -> 503 jupiter_unavailable; "not tradable" ->
 * 404 no_route. Every build is checked (src/jupswap.js), its lookup tables are read back from the chain (and must be active), it
 * is simulated first (plain codes before the wallet opens: insufficient_sol, slippage, program_error), and compiled by the Worker's
 * own compiler (src/sol/message.js) with our compute budget (priority fee <= 0.01 SOL). The /tx answer carries the quote of the
 * very build being signed (the page shows THAT, never its preview) and a relay ticket (src/relay.js).
 * A city coin still on its Meteora curve answers source "curve": the page then uses /api/launchpad/trade/* (src/lptrade.js).
 * Without a key, builds use Jupiter's anonymous allowance, which may stop without notice: the key is required for a launch.
 */
import { json, readJson } from "./http.js";
import { mintInfo, rpc } from "./chain.js";
import { isSolanaAddress } from "./solana.js";
import { Source, codeOf, retryAfterMs } from "./sources.js";
import { activeMint } from "./official.js";
import { PAIRS, launchedCoins } from "./coins.js";
import { jupiterPriceFor } from "./marketlive.js";
import { ensureSchema } from "./store.js";
import { publicLimit, walletLimit } from "./guards.js";
import { jupiterConfig, launchpadCluster, launchpadTradingOn, swapCluster, swapOn } from "./cluster.js";
import { ADDRESSES } from "./sol/pda.js";
import { decodeLookupTable } from "./sol/dbc.js";
import { formatAmount, parseAmount, readSwapInput } from "./sol/input.js";
import { MAX_TX_BYTES, compileLegacy, compileV0, decodeHeader, wrapUnsigned } from "./sol/message.js";
import { toBase64 } from "./sol/bytes.js";
import { priorityFeeLamports } from "./sol/ix.js";
import { checkJupiterBuild, claimedLookupTables, composeJupiter, jupiterBlockhash, jupiterCuPrice } from "./jupswap.js";
import { issueTicket, simulate, simulationError } from "./relay.js";
import { stageOf } from "./lptrade.js";
import { tickerOf } from "./tickers.js";

export const USDC = PAIRS.USDC.mint, USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", SOL = ADDRESSES.wsol;
export const MAX_SLIPPAGE_BPS = 5000, DEFAULT_SLIPPAGE_BPS = 100;
const BUILD_TTL_MS = 12_000, BUILD_MAX = 500, JUP_TIMEOUT_MS = 6_000, NEGATIVE_MS = 5_000;
export const NETWORK_FEE_LAMPORTS = 5000, RENT_ATA_LAMPORTS = 2_039_280, DEFAULT_CU = 600_000, MAX_CU = 1_400_000, MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;
const KNOWN = { [SOL]: { symbol: "SOL", name: "Solana", decimals: 9, kind: "sol" }, [USDC]: { symbol: "USDC", name: "USD Coin", decimals: 6, kind: "stable" }, [USDT]: { symbol: "USDT", name: "Tether USD", decimals: 6, kind: "stable" } };
const noStore = { "Cache-Control": "no-store" };

/* ---------------------------------------------------------------- Jupiter: the budget, the caches, the calls */
const budget = { tokens: 0, at: 0, rps: 0 }; // per server: a token bucket of the plan's rate, so a burst of previews never takes the plan over its limit
function takeToken(rps, now) {
  if (budget.rps !== rps) { budget.rps = rps; budget.tokens = Math.max(1, rps); budget.at = now; }
  budget.tokens = Math.min(Math.max(1, rps * 2), budget.tokens + ((now - budget.at) / 1000) * rps);
  budget.at = now;
  if (budget.tokens < 1) return false;
  budget.tokens -= 1;
  return true;
}
const builds = new Map(); // key -> { at, promise }: /swap/v2/build per (taker, pair, amount, slippage)
const quotes = new Map(); // key -> { at, promise }: keyless /swap/v1/quote per (pair, amount, slippage)
// the negative cache after a 429 / 5xx / timeout, PER HOST: a 429 on the keyed build host (which one visitor's builds can provoke)
// pauses builds only; the lite quotes keep serving estimates, and the other way round
const failed = { keyed: { until: 0, code: null }, lite: { until: 0, code: null } };
const paused = (keyed, now) => now < (keyed ? failed.keyed : failed.lite).until;
const decimalsOf = new Map(); // mint -> { at, promise }
const alts = new Source("jupiter_alt", { ttlMs: 10 * 60_000, staleMs: 10 * 60_000 });
export const _resetSwap = () => { builds.clear(); quotes.clear(); failed.keyed = { until: 0, code: null }; failed.lite = { until: 0, code: null }; decimalsOf.clear(); alts.reset(); budget.tokens = 0; budget.at = 0; budget.rps = 0; };
export const _swapState = () => ({ builds: builds.size, quotes: quotes.size, failedUntil: Math.max(failed.keyed.until, failed.lite.until), failed: { keyed: failed.keyed.until, lite: failed.lite.until }, bucket: budget.tokens });

class JupiterError extends Error { constructor(code, status, retryAfterS) { super(code); this.code = code; this.status = status; this.retryAfterS = retryAfterS; } }
const NO_ROUTE = /not tradable|no route|could not find any route|TOKEN_NOT_TRADABLE|NO_ROUTES?_FOUND|ROUTE_PLAN_DOES_NOT_CONSUME/i;
/** One Jupiter GET with the host's negative cache, a 6 s timeout and plain codes. */
async function jupiterGet(env, url, fetchImpl, now, { keyed = true } = {}) {
  const f = keyed ? failed.keyed : failed.lite;
  if (now < f.until) throw new JupiterError(f.code || "jupiter_busy", 503, Math.ceil((f.until - now) / 1000));
  const jc = jupiterConfig(env);
  let res;
  try { res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "vicinity.city/1.0 (+https://vicinity.city)", ...(keyed ? jc.headers : {}) }, signal: AbortSignal.timeout(JUP_TIMEOUT_MS) }); }
  catch (e) { f.until = now + NEGATIVE_MS; f.code = "jupiter_unavailable"; throw new JupiterError("jupiter_unavailable", 503, 5); }
  if (res.status === 429) { const ra = Math.min(60_000, Math.max(NEGATIVE_MS, retryAfterMs(res.headers.get("retry-after"), now))); f.until = now + ra; f.code = "jupiter_busy"; throw new JupiterError("jupiter_busy", 503, Math.ceil(ra / 1000)); }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    const msg = body && typeof body === "object" ? `${body.error || ""} ${body.errorCode || ""} ${body.message || ""}` : "";
    if (NO_ROUTE.test(msg)) throw new JupiterError("no_route", 404);
    if (/amount|too small|Insufficient/i.test(msg)) throw new JupiterError("amount_too_small", 400);
    throw new JupiterError("jupiter_refused", 502);
  }
  if (!res.ok || !body || typeof body !== "object") { f.until = now + NEGATIVE_MS; f.code = "jupiter_unavailable"; throw new JupiterError("jupiter_unavailable", 503, 5); }
  return body;
}
const buildKey = (p) => `${p.taker}|${p.inputMint}|${p.outputMint}|${p.amountRaw}|${p.slippageBps}`;
/** /swap/v2/build, one in-flight call per key, kept 12 s. */
function jupiterBuild(env, p, fetchImpl, now) {
  const key = buildKey(p);
  let hit = builds.get(key);
  if (!hit || now - hit.at >= BUILD_TTL_MS) {
    const jc = jupiterConfig(env);
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: String(p.amountRaw), taker: p.taker, slippageBps: String(p.slippageBps), maxAccounts: "64", wrapAndUnwrapSol: "true" });
    if (jc.platformFeeBps && jc.feeAccount) { q.set("platformFeeBps", String(jc.platformFeeBps)); q.set("feeAccount", jc.feeAccount); }
    hit = { at: now, key, promise: jupiterGet(env, `${jc.base}/swap/v2/build?${q}`, fetchImpl, now) };
    hit.promise.catch(() => { if (builds.get(key) === hit) builds.delete(key); });
    builds.delete(key); builds.set(key, hit);
    while (builds.size > BUILD_MAX) builds.delete(builds.keys().next().value);
  }
  return hit;
}
/**
 * lite /swap/v1/quote: numbers only, keyless, and kept 12 s per (pair, amount, slippage) with one in-flight call per key: the
 * keyless allowance is small (about one call every two seconds), and every visitor typing the same round amount, every
 * 12-second refresh of an open page and every preview during a rush must share one call instead of each costing one.
 */
function jupiterQuote(env, p, fetchImpl, now) {
  const key = `${p.inputMint}|${p.outputMint}|${p.amountRaw}|${p.slippageBps}`;
  let hit = quotes.get(key);
  if (!hit || now - hit.at >= BUILD_TTL_MS) {
    const jc = jupiterConfig(env);
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: String(p.amountRaw), slippageBps: String(p.slippageBps), swapMode: "ExactIn" });
    hit = { at: now, promise: jupiterGet(env, `${jc.lite}/swap/v1/quote?${q}`, fetchImpl, now, { keyed: false }) };
    hit.promise.catch(() => { if (quotes.get(key) === hit) quotes.delete(key); }); // a failure is never kept (the negative cache covers it)
    quotes.delete(key); quotes.set(key, hit);
    while (quotes.size > BUILD_MAX) quotes.delete(quotes.keys().next().value);
  }
  return hit.promise;
}
const sha22 = async (s) => { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); return btoa(String.fromCharCode(...d)).replace(/[+/=]/g, "").slice(0, 22); };

/** Decimals of a mint: known tokens at once, anything else from the chain (jsonParsed mint), 1 hour per server; null = not a mint. */
async function mintDecimals(env, mint, fetchImpl, now) {
  if (KNOWN[mint]) return KNOWN[mint].decimals;
  let hit = decimalsOf.get(mint);
  if (!hit || now - hit.at > 60 * 60_000) {
    hit = { at: now, promise: mintInfo(env, mint, fetchImpl).then((i) => (i ? i.decimals : null)) };
    hit.promise.catch(() => { if (decimalsOf.get(mint) === hit) decimalsOf.delete(mint); });
    decimalsOf.set(mint, hit);
    if (decimalsOf.size > 2000) decimalsOf.delete(decimalsOf.keys().next().value);
  }
  return hit.promise;
}

/* ---------------------------------------------------------------- the answers */
const labelsOf = (plan) => [...new Set((plan || []).map((r) => r && r.swapInfo && String(r.swapInfo.label || "").slice(0, 40)).filter(Boolean))];
/** The common quote shape from a /build or /quote answer (BigInt-free: strings). `jc` is this request's Jupiter config (the platform fee it really charges). */
function quoteFrom(src, body, { inputMint, outputMint, inDec, outDec, slippageBps, prices, now, id, jc }) {
  const inRaw = String(body.inAmount), outRaw = String(body.outAmount), minRaw = String(body.otherAmountThreshold);
  const route = labelsOf(body.routePlan);
  const inUsd = prices.get(inputMint)?.usdPrice ?? null, outUsd = prices.get(outputMint)?.usdPrice ?? null;
  const inUi = formatAmount(BigInt(inRaw), inDec), outUi = formatAmount(BigInt(outRaw), outDec);
  const cuPrice = src === "jupiter_build" ? jupiterCuPrice(body) : 0n;
  const impactRaw = String(body.priceImpactPct ?? ""), impact = /^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(impactRaw) ? Number(impactRaw) : NaN; // Jupiter writes plain decimals; an exponent form is a number too
  return {
    quoteId: id, source: src, estimate: src !== "jupiter_build", inputMint, outputMint, decimals: { in: inDec, out: outDec },
    inAmount: inRaw, outAmount: outRaw, minOut: minRaw, inUi, outUi, minOutUi: formatAmount(BigInt(minRaw), outDec), slippageBps,
    priceImpactPct: Number.isFinite(impact) ? Number(impact.toFixed(4)).toString() : null,
    route, routeText: route.length ? `Routed by Jupiter · executed on ${route.join(" → ")}` : "Routed by Jupiter",
    inUsd: inUsd != null ? Number(inUi) * inUsd : null, outUsd: outUsd != null ? Number(outUi) * outUsd : null,
    fees: { networkLamports: NETWORK_FEE_LAMPORTS, priorityLamportsMax: Number(priorityFeeLamports(cuPrice < 1n ? 0n : (cuPrice * BigInt(MAX_CU) > MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n ? (MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) / BigInt(MAX_CU) : cuPrice), MAX_CU)), platformFeeBps: jc ? jc.platformFeeBps : 0, rentLamports: RENT_ATA_LAMPORTS },
    expiresAt: new Date(now + BUILD_TTL_MS).toISOString(), poweredBy: "Jupiter", chain: "solana:mainnet", cluster: "mainnet",
  };
}
const fail = (e) => {
  if (e instanceof JupiterError) return json({ ok: false, error: e.code, ...(e.retryAfterS ? { retryAfterS: e.retryAfterS } : {}) }, e.status, { ...noStore, ...(e.retryAfterS ? { "Retry-After": String(e.retryAfterS) } : {}) });
  if (e && e.refused) { console.error("jupiter build refused", e.code); return json({ ok: false, error: "jupiter_refused" }, 502, noStore); }
  console.error("swap failed", codeOf(e));
  return json({ ok: false, error: /^rpc_/.test(codeOf(e)) ? "rpc_unavailable" : "swap_unavailable" }, 503, noStore);
};

/** Everything /quote and /tx share: the input, the decimals, the raw amount, the curve check. { error } or the prepared trade. */
async function prepare(request, env, fetchImpl, now, { takerRequired }) {
  const body = await readJson(request, 4096);
  const input = readSwapInput(body, { takerRequired });
  if (input.error) return { error: json({ ok: false, error: input.error }, input.status, noStore) };
  let inDec, outDec;
  try { [inDec, outDec] = await Promise.all([mintDecimals(env, input.inputMint, fetchImpl, now), mintDecimals(env, input.outputMint, fetchImpl, now)]); }
  catch (e) { console.error("mint decimals failed", codeOf(e)); return { error: json({ ok: false, error: "rpc_unavailable" }, 503, noStore) }; }
  if (inDec == null || outDec == null) return { error: json({ ok: false, error: "unknown_token", mint: inDec == null ? input.inputMint : input.outputMint }, 400, noStore) };
  const parsed = parseAmount(input.amount, inDec);
  if (!parsed) return { error: json({ ok: false, error: "bad_amount" }, 400, noStore) };
  if (parsed.tooPrecise) return { error: json({ ok: false, error: "amount_too_small" }, 400, noStore) };
  // a city coin on its Meteora curve: the launchpad routes build that trade (Jupiter cannot route it yet)
  if (launchpadTradingOn(env)) {
    for (const [mint, side] of [[input.outputMint, "buy"], [input.inputMint, "sell"]]) {
      let st = null;
      try { st = await stageOf(env, mint, fetchImpl, now); } catch (e) { console.error("curve stage failed", codeOf(e)); }
      if (st && (st.stage === "curve" || st.stage === "full")) {
        const other = side === "buy" ? input.inputMint : input.outputMint;
        if (other !== st.coin.quoteMint) return { error: json({ ok: false, error: "curve_quote_only", quoteMint: st.coin.quoteMint, mint, side, message: "This coin is still on its bonding curve: it trades against its own pair token only." }, 409, noStore) };
        return { curve: { mint, side, stage: st.stage, chain: st.cluster.chain, cluster: st.cluster.cluster, quoteMint: st.coin.quoteMint } };
      }
    }
  }
  return { input, inDec, outDec, amountRaw: parsed.raw, body };
}
const curveAnswer = (c) => json({ ok: true, source: "curve", ...c, useRoute: "/api/launchpad/trade", poweredBy: "Meteora DBC" }, 200, noStore);

/** POST /api/swap/quote (the route has checked the switch, the method and the Origin). */
export async function handleSwapQuote(request, env, fetchImpl = fetch, now = Date.now()) {
  const slow = await publicLimit(env, request, "swap_quote");
  if (slow) return slow;
  const p = await prepare(request, env, fetchImpl, now, { takerRequired: false });
  if (p.error) return p.error;
  if (p.curve) return curveAnswer(p.curve);
  const { input, inDec, outDec, amountRaw } = p;
  const params = { inputMint: input.inputMint, outputMint: input.outputMint, amountRaw, slippageBps: input.slippageBps, taker: input.taker };
  const jc = jupiterConfig(env);
  const pricesP = jupiterPriceFor(env, [input.inputMint, input.outputMint], fetchImpl, now).then((r) => r.values).catch(() => new Map());
  try {
    let body, src;
    const cached = input.taker ? builds.get(buildKey(params)) : null;
    if (cached && now - cached.at < BUILD_TTL_MS) { body = await cached.promise; src = "jupiter_build"; }
    else if (input.taker && !paused(true, now) && takeToken(jc.rps, now)) {
      // the keyed host busy or down right now: the estimate from the lite host stands in (the build is asked for again at the Swap click)
      try { body = await jupiterBuild(env, params, fetchImpl, now).promise; src = "jupiter_build"; }
      catch (e) { if (!(e instanceof JupiterError && e.status === 503)) throw e; body = await jupiterQuote(env, params, fetchImpl, now); src = "jupiter_quote"; }
    } else { body = await jupiterQuote(env, params, fetchImpl, now); src = "jupiter_quote"; }
    if (!body || !/^\d+$/.test(String(body.outAmount)) || BigInt(body.outAmount) <= 0n) return json({ ok: false, error: "amount_too_small" }, 400, noStore);
    if (src === "jupiter_build") await checkJupiterBuild(body, { taker: input.taker, inputMint: input.inputMint, outputMint: input.outputMint, inAmount: amountRaw, platformFeeBps: jc.platformFeeBps, feeAccount: jc.feeAccount });
    const id = await sha22(buildKey({ ...params, taker: input.taker || "-" }));
    return json({ ok: true, ...quoteFrom(src, body, { ...input, inDec, outDec, prices: await pricesP, now, id, jc }) }, 200, noStore);
  } catch (e) { return fail(e); }
}

/** The lookup tables Jupiter claims, read back from the chain: the on-chain list must start with the claimed addresses. */
async function verifiedTables(env, build, fetchImpl, now) {
  const claimed = claimedLookupTables(build);
  if (!claimed.length) return [];
  const r = await alts.get(claimed.map((t) => t.key), now, async (want) => {
    const res = await rpc(env, "getMultipleAccounts", [want, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
    const list = res && Array.isArray(res.value) ? res.value : null;
    if (!list || list.length !== want.length) throw new Error("rpc_bad_answer");
    return new Map(want.map((k, i) => [k, decodeLookupTable(list[i])]));
  });
  const out = [];
  for (const t of claimed) {
    const chain = r.values.get(t.key);
    if (chain === undefined) throw new Error(r.error || "rpc_unavailable");
    if (!chain) { const e = new Error("alt_missing"); e.alt = true; throw e; }
    // a table whose deactivation has begun stops resolving within minutes: a transaction built on it would fail at the node
    if (chain.deactivationSlot !== 0xFFFFFFFFFFFFFFFFn) { const e = new Error("alt_deactivated"); e.alt = true; throw e; }
    const ok = t.addresses.length <= chain.addresses.length && t.addresses.every((a, i) => chain.addresses[i] === a);
    if (!ok) { const e = new Error("alt_mismatch"); e.alt = true; throw e; }
    out.push({ key: t.key, addresses: chain.addresses });
  }
  return out;
}

/** POST /api/swap/tx: the unsigned Jupiter transaction for `taker`, checked, simulated, with our compute budget. */
export async function handleSwapTx(request, env, fetchImpl = fetch, now = Date.now()) {
  const slow = await publicLimit(env, request, "swap_tx");
  if (slow) return slow;
  const p = await prepare(request, env, fetchImpl, now, { takerRequired: true });
  if (p.error) return p.error;
  if (p.curve) return curveAnswer(p.curve);
  const { input, inDec, outDec, amountRaw } = p;
  const slowWallet = await walletLimit(env, "swap_tx", input.taker, now);
  if (slowWallet) return slowWallet;
  const params = { inputMint: input.inputMint, outputMint: input.outputMint, amountRaw, slippageBps: input.slippageBps, taker: input.taker };
  const jc = jupiterConfig(env);
  try {
    const hit = builds.get(buildKey(params));
    let build;
    if (hit && now - hit.at < BUILD_TTL_MS) build = await hit.promise; // the preview's build, within its 12 s: no second call
    else if (takeToken(jc.rps, now)) build = await jupiterBuild(env, params, fetchImpl, now).promise;
    else throw new JupiterError("jupiter_busy", 503, 2); // this server's share of the plan is spent this second: never an unmetered build
    if (!build || !/^\d+$/.test(String(build.outAmount)) || BigInt(build.outAmount) <= 0n) return json({ ok: false, error: "amount_too_small" }, 400, noStore);
    await checkJupiterBuild(build, { taker: input.taker, inputMint: input.inputMint, outputMint: input.outputMint, inAmount: amountRaw, platformFeeBps: jc.platformFeeBps, feeAccount: jc.feeAccount });
    let tables;
    try { tables = await verifiedTables(env, build, fetchImpl, now); }
    catch (e) { if (e.alt) { console.error("lookup table refused", e.message); return json({ ok: false, error: e.message }, 502, noStore); } throw e; }
    const { blockhash, lastValidBlockHeight } = jupiterBlockhash(build);
    const useV0 = tables.length > 0 || !input.legacy;
    if (input.legacy && tables.length) return json({ ok: false, error: "needs_v0", message: "This route needs a version-0 transaction, which this wallet cannot sign." }, 400, noStore);
    const compile = (cuLimit) => {
      const { instructions, cuPrice } = composeJupiter(build, { cuLimit });
      const message = useV0 ? compileV0({ payer: input.taker, instructions, blockhash, lookupTables: tables }) : compileLegacy({ payer: input.taker, instructions, blockhash });
      return { tx: wrapUnsigned(message), cuPrice };
    };
    // simulate once with a generous limit, then set 1.2 x what it used
    let cuLimit = DEFAULT_CU, first = compile(cuLimit);
    if (first.tx.length > MAX_TX_BYTES) return json({ ok: false, error: "tx_too_large", bytes: first.tx.length }, 400, noStore);
    let simulated = false;
    try {
      const sim = await simulate(env, first.tx, fetchImpl);
      simulated = true;
      if (!sim.ok) {
        const m = simulationError(sim.err, sim.logs, decodeHeader(first.tx)) || { error: "program_error" };
        console.error("swap would fail", m.error, m.name || "");
        return json({ ok: false, ...m, program: m.program || undefined, stage: "simulation" }, 409, noStore);
      }
      if (sim.unitsConsumed) cuLimit = Math.min(MAX_CU, Math.max(50_000, Math.ceil(sim.unitsConsumed * 1.2)));
    } catch (e) { console.error("swap simulation unavailable", codeOf(e)); }
    const { tx, cuPrice } = cuLimit === DEFAULT_CU ? first : compile(cuLimit);
    if (tx.length > MAX_TX_BYTES) return json({ ok: false, error: "tx_too_large", bytes: tx.length }, 400, noStore);
    const prices = await jupiterPriceFor(env, [input.inputMint, input.outputMint], fetchImpl, now).then((r) => r.values).catch(() => new Map());
    const id = await sha22(buildKey(params));
    return json({
      ok: true, quoteId: id, tx: toBase64(tx), version: useV0 ? 0 : "legacy", bytes: tx.length, blockhash, lastValidBlockHeight, chain: "solana:mainnet", cluster: "mainnet", taker: input.taker, simulated,
      ticket: await issueTicket(env, tx, now), // for /api/swap/send: proof that this Worker built these bytes
      // the quote of THIS build: what the wallet is about to sign (the page compares it with its preview before opening the wallet)
      quote: quoteFrom("jupiter_build", build, { ...input, inDec, outDec, prices, now, id, jc }),
      fees: { computeUnitLimit: cuLimit, computeUnitPrice: cuPrice.toString(), priorityLamports: Number(priorityFeeLamports(cuPrice, cuLimit)), networkLamports: NETWORK_FEE_LAMPORTS, rentLamports: RENT_ATA_LAMPORTS, rentNote: "about 0.002 SOL once, for a token account of yours that does not exist yet; it is returned when you close that account", platformFeeBps: jc.platformFeeBps },
    }, 200, noStore);
  } catch (e) { return fail(e); }
}

/* ---------------------------------------------------------------- config and token search */
/** GET /api/swap/config (public; edge-cached 60 s by the route). Booleans only about secrets. */
export async function handleSwapConfig(env, fetchImpl = fetch, now = Date.now()) {
  const jc = jupiterConfig(env), lp = launchpadCluster(env), vic = activeMint(env);
  const tokens = [{ mint: SOL, ...KNOWN[SOL] }, { mint: USDC, ...KNOWN[USDC] }, { mint: USDT, ...KNOWN[USDT] }];
  if (vic) tokens.push({ mint: vic, symbol: "VICINITY", name: "Vicinity", decimals: 6, kind: "vicinity", stage: "jupiter" });
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const coins = await launchedCoins(env.DB, 300);
      // the stage of each coin (the pool read, 5 s per server), ten coins at a time rather than one after the other
      const stages = new Array(coins.length).fill("jupiter");
      if (launchpadTradingOn(env)) {
        for (let i = 0; i < coins.length; i += 10) {
          await Promise.all(coins.slice(i, i + 10).map((c, j) => stageOf(env, c.mint, fetchImpl, now).then((st) => { if (st) stages[i + j] = st.stage; }).catch(() => { stages[i + j] = "unknown"; })));
        }
      }
      for (const [i, c] of coins.entries()) {
        // the same ticker the cards, the coin page and the checker use ($UTICA), never a symbol made up from the name
        const ticker = (await tickerOf(env, c.city_id))?.ticker || null;
        tokens.push({ mint: c.mint, symbol: ticker, name: c.name, decimals: 6, kind: "city", city: { id: String(c.city_id), name: c.city_name, country: c.country }, stage: stages[i] });
      }
    } catch (e) { console.error("swap config coins skipped", codeOf(e)); }
  }
  return json({
    ok: true, swap: swapOn(env), ...swapCluster(), jupiter: { keyed: jc.keyed, host: new URL(jc.base).host, rps: jc.rps }, maxSlippageBps: MAX_SLIPPAGE_BPS, defaultSlippageBps: DEFAULT_SLIPPAGE_BPS,
    platformFeeBps: jc.platformFeeBps, tokens, poweredBy: { jupiter: { text: "Powered by Jupiter", url: "https://jup.ag" }, meteora: { text: "Curve trades are executed by Meteora DBC", url: "https://www.meteora.ag" } },
    launchpad: { enabled: launchpadTradingOn(env), cluster: lp.cluster, chain: lp.chain, programId: lp.programId, dbcConfigs: lp.dbcConfigs, lookupTable: lp.lookupTable, feeRecipient: lp.feeRecipient, missing: lp.missing },
  }, 200, { "Cache-Control": "public, max-age=60" });
}

const tokenSearch = new Source("jupiter_token_search", { ttlMs: 5 * 60_000 });
/** GET /api/swap/tokens?q= (edge-cached 300 s per query by the route): verified tokens only, at most 20. */
export async function handleSwapTokens(request, env, fetchImpl = fetch, now = Date.now()) {
  const q = String(new URL(request.url).searchParams.get("q") || "").trim();
  if (!/^[A-Za-z0-9 ._-]{1,44}$/.test(q)) return json({ ok: false, error: "bad_query" }, 400);
  const slow = await publicLimit(env, request, "swap_tokens");
  if (slow) return slow;
  const jc = jupiterConfig(env);
  const r = await tokenSearch.get([q.toLowerCase()], now, async ([key]) => {
    const d = await jupiterGet(env, `${jc.lite}/tokens/v2/search?query=${encodeURIComponent(q)}`, fetchImpl, now, { keyed: false });
    if (!Array.isArray(d)) throw new Error("bad_answer");
    const rows = d.filter((t) => t && isSolanaAddress(t.id) && t.isVerified === true && Number.isInteger(t.decimals)).slice(0, 20)
      .map((t) => ({ mint: t.id, symbol: String(t.symbol || "").slice(0, 16), name: String(t.name || "").slice(0, 48), decimals: t.decimals, verified: true }));
    return new Map([[key, rows]]);
  });
  const rows = r.values.get(q.toLowerCase());
  if (rows === undefined) return json({ ok: false, error: r.error === "jupiter_busy" ? "jupiter_busy" : "jupiter_unavailable" }, 503);
  return json({ ok: true, q, tokens: rows, poweredBy: "Jupiter" }, 200, { "Cache-Control": "public, max-age=300" });
}
