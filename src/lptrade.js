/**
 * Curve trades of city coins on our own launchpad (only while LAUNCHPAD_TRADING=on and the cluster settings are complete,
 * src/cluster.js): while a coin is on its Meteora bonding curve and Jupiter cannot route it, Buy and Sell are built HERE,
 * exactly as the SDK's buildBuy/buildSell would (solana/sdk/launchpad/trade.mts), from the Worker's own dependency-free
 * modules (src/sol/*), and the person signs the unsigned transaction in their wallet. The Worker holds no key and sends nothing
 * on its own; the relay (src/relay.js) forwards what a wallet signed.
 *   POST /api/launchpad/trade/quote { mint, side: buy|sell, amount, slippageBps?, taker? }
 *   POST /api/launchpad/trade/tx    { mint, side, amount, slippageBps?, taker, v?: "legacy" }
 * Which coins: the launched city coins of city_coins (an admin recorded the contract) whose Coin record exists under our program
 * on the launchpad cluster with that very mint (the registry, 10 minutes per server; a coin without a Coin record is never traded
 * here). Stage: pool.isMigrated -> graduated (the swap panel takes over through Jupiter), quoteReserve at the target -> full
 * (waiting for graduation), else curve. Prices: the exact DBC maths (src/sol/quote.js over the SDK's curve.mjs).
 * Every buy is DBC's partial fill (the last buy of a curve takes what the curve can still sell and refunds the rest instead of
 * failing); every trade first (re)creates the dev wallet's referral account idempotently (Meteora refuses a trade whose referral
 * account is missing, and the dev wallet closes it whenever it unwraps SOL). SOL is wrapped before a buy and unwrapped after.
 */
import { json, readJson } from "./http.js";
import { rpc } from "./chain.js";
import { isSolanaAddress } from "./solana.js";
import { Source, codeOf } from "./sources.js";
import { launchpadCluster, solscanTx } from "./cluster.js";
import { ADDRESSES, PROGRAM_IDS, ata, launchpad as launchpadPdas } from "./sol/pda.js";
import { PROGRAM_CONSTANTS, decodeCoin, decodeConfig, decodeLookupTable, decodePool } from "./sol/dbc.js";
import { CurveError, MAX_SLIPPAGE_BPS, feeBpsOf, priceInQuote, quoteBuy, quoteSell } from "./sol/quote.js";
import { CU, SwapMode, createAtaIdempotent, maxCuPrice, priorityFeeLamports, setComputeUnitLimit, setComputeUnitPrice, swap2, unwrapSol, wrapSol } from "./sol/ix.js";
import { MAX_TX_BYTES, compileLegacy, compileV0, wrapUnsigned, decodeHeader } from "./sol/message.js";
import { toBase64 } from "./sol/bytes.js";
import { bad, checkSlippage, checkTaker, formatAmount, parseAmount } from "./sol/input.js";
import { simulate, simulationError } from "./relay.js";
import { launchedCoins } from "./coins.js";
import { ensureSchema } from "./store.js";
import { publicLimit } from "./guards.js";
import { OFFICIAL } from "./official.js";

// the dev wallet the trades pay their referral to must be the program's constant AND the first published team wallet
if (PROGRAM_CONSTANTS.FEE_RECIPIENT !== ADDRESSES.feeRecipient || OFFICIAL.teamWallets[0] !== ADDRESSES.feeRecipient) throw new Error("fee recipient mismatch between the program, src/sol/pda.js and src/official.js");

export const COIN_DECIMALS = 6;
export const RENT_ATA_LAMPORTS = 2_039_280n;
export const NETWORK_FEE_LAMPORTS = 5_000n;
const QUOTE_TTL_MS = 12_000;
const KNOWN_DECIMALS = { So11111111111111111111111111111111111111112: 9, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6 };

/* ---------------------------------------------------------------- the registry and the stage */
let registryMemo = null; // { key, at, promise }: launched city coins with their Coin records, 10 minutes per server
const REGISTRY_MS = 10 * 60_000, REGISTRY_RETRY_MS = 60_000;
const pools = new Source("lp_pool", { ttlMs: 5_000, staleMs: 0, negativeMs: 3_000 });
const configs = new Source("lp_config", { ttlMs: 60 * 60_000, staleMs: 60 * 60_000 });
const tables = new Source("lp_lookup", { ttlMs: 10 * 60_000, staleMs: 10 * 60_000 });
const decimalsSrc = new Source("lp_decimals", { ttlMs: 60 * 60_000, staleMs: 60 * 60_000 });
export const _resetLpTrade = () => { registryMemo = null; for (const s of [pools, configs, tables, decimalsSrc]) s.reset(); };

const lpRpc = (env, cl, method, params, fetchImpl) => rpc(env, method, params, fetchImpl, { url: cl.rpc });

/** Map(mint -> { cityId, coin, row }) of launched city coins that have a Coin record under our program on the launchpad cluster. */
export async function registry(env, fetchImpl = fetch, { now = Date.now(), wantMint = null } = {}) {
  const cl = launchpadCluster(env);
  if (!cl.ready || !env.DB) return new Map();
  const fresh = registryMemo && registryMemo.key === cl.programId && now - registryMemo.at < REGISTRY_MS;
  // a coin launched a moment ago is not in the copy: look again after a minute when a mint is asked that the copy does not know
  const stale = registryMemo && registryMemo.key === cl.programId && wantMint && registryMemo.known && !registryMemo.known.has(wantMint) && now - registryMemo.at > REGISTRY_RETRY_MS;
  if (!fresh || stale) {
    const m = { key: cl.programId, at: now, promise: null, known: null };
    m.promise = buildRegistry(env, cl, fetchImpl).then((map) => { m.known = new Set(map.keys()); return map; });
    m.promise.catch(() => { if (registryMemo === m) registryMemo = null; });
    registryMemo = m;
  }
  return registryMemo.promise;
}
async function buildRegistry(env, cl, fetchImpl) {
  await ensureSchema(env.DB);
  const rows = (await launchedCoins(env.DB, 1000)).filter((r) => isSolanaAddress(r.mint) && /^\d{1,18}$/.test(String(r.city_id)));
  const out = new Map();
  if (!rows.length) return out;
  const P = launchpadPdas(cl.programId);
  const pdas = await Promise.all(rows.map((r) => P.coin(BigInt(r.city_id))));
  for (let i = 0; i < pdas.length; i += 100) {
    const chunk = pdas.slice(i, i + 100);
    const res = await lpRpc(env, cl, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
    const list = res && Array.isArray(res.value) ? res.value : null;
    if (!list || list.length !== chunk.length) throw new Error("rpc_bad_answer");
    list.forEach((acc, j) => {
      const row = rows[i + j], coin = decodeCoin(acc, cl.programId);
      if (coin && coin.mint === row.mint) out.set(row.mint, { cityId: coin.cityId, coin, row: { cityId: String(row.city_id), cityName: row.city_name, country: row.country, name: row.name } });
    });
  }
  return out;
}
/** Where a launched coin stands: { stage: curve|full|graduated, coin, pool, config, entry } or null when it is not a launchpad coin. */
export async function stageOf(env, mint, fetchImpl = fetch, now = Date.now()) {
  const cl = launchpadCluster(env);
  if (!cl.ready) return null;
  const entry = (await registry(env, fetchImpl, { now, wantMint: mint })).get(mint);
  if (!entry) return null;
  const { coin } = entry;
  const [p, c] = await Promise.all([
    pools.get([coin.dbcPool], now, async ([k]) => new Map([[k, decodePool((await lpRpc(env, cl, "getAccountInfo", [k, { encoding: "base64", commitment: "confirmed" }], fetchImpl))?.value)]])),
    configs.get([coin.dbcConfig], now, async ([k]) => new Map([[k, decodeConfig((await lpRpc(env, cl, "getAccountInfo", [k, { encoding: "base64", commitment: "confirmed" }], fetchImpl))?.value)]])),
  ]);
  const pool = p.values.get(coin.dbcPool), config = c.values.get(coin.dbcConfig);
  if (pool === undefined || config === undefined) throw new Error(p.error || c.error || "rpc_unavailable");
  if (!pool || !config) return { stage: "unknown", coin, pool: null, config: null, entry };
  if (pool.config !== coin.dbcConfig || pool.baseMint !== coin.mint) return { stage: "unknown", coin, pool, config, entry };
  const stage = pool.isMigrated ? "graduated" : pool.quoteReserve >= config.migrationQuoteThreshold || pool.migrationProgress >= 1 ? "full" : "curve";
  return { stage, coin, pool, config, entry, cluster: cl };
}
async function quoteDecimals(env, cl, mint, fetchImpl, now) {
  if (KNOWN_DECIMALS[mint] != null) return KNOWN_DECIMALS[mint];
  const r = await decimalsSrc.get([mint], now, async ([k]) => {
    const info = await lpRpc(env, cl, "getAccountInfo", [k, { encoding: "jsonParsed" }], fetchImpl);
    const d = Number(info?.value?.data?.parsed?.info?.decimals);
    return new Map([[k, Number.isInteger(d) ? d : null]]);
  });
  const d = r.values.get(mint);
  if (d === undefined) throw new Error("rpc_unavailable");
  return d;
}

/* ---------------------------------------------------------------- quotes */
/** The quote of a curve trade (pure, no network): the shape every trade answer shares. */
export function curveQuote({ side, pool, config, amountRaw, slippageBps, quoteDecimals: qd, coin, chain }) {
  const q = side === "buy" ? quoteBuy(pool, config, { amountIn: amountRaw, slippageBps }) : quoteSell(pool, config, { amountIn: amountRaw, slippageBps });
  const [inMint, outMint, inDec, outDec] = side === "buy" ? [coin.quoteMint, coin.mint, qd, COIN_DECIMALS] : [coin.mint, coin.quoteMint, COIN_DECIMALS, qd];
  const spot = priceInQuote(pool.sqrtPrice, qd);
  return {
    source: "curve", side, mode: q.mode, inputMint: inMint, outputMint: outMint, decimals: { in: inDec, out: outDec },
    inAmount: q.amountIn.toString(), outAmount: q.amountOut.toString(), minOut: q.minOut.toString(), inUi: formatAmount(q.amountIn, inDec), outUi: formatAmount(q.amountOut, outDec), minOutUi: formatAmount(q.minOut, outDec),
    slippageBps, priceImpactPct: (q.priceImpactBps / 100).toFixed(2), refund: q.refund.toString(), completesCurve: q.completesCurve, partialFill: q.mode === SwapMode.PartialFill,
    spotPrice: spot, route: ["Meteora bonding curve"], executedOn: "Meteora DBC",
    fees: {
      curveFeeBps: feeBpsOf(config), feeRaw: q.fees.total.toString(), feeToken: coin.quoteMint,
      split: { meteora: q.fees.meteora.toString(), referral: q.fees.referral.toString(), devWallet: q.fees.devWallet.toString(), city: q.fees.city.toString(), holders: q.fees.holders.toString(), founder: q.fees.founder.toString() },
      networkLamports: Number(NETWORK_FEE_LAMPORTS), platformFeeBps: 0,
    },
    chain, poweredBy: "Meteora DBC",
  };
}

/* ---------------------------------------------------------------- building */
/**
 * The SDK's instruction list for a curve trade: referral account (idempotent) first; buy: wrap SOL (when the quote is SOL), the
 * coin account, swap2 partial fill, unwrap; sell: the quote account, swap2 exact in, unwrap. Then the compute budget in front.
 */
export async function tradeInstructions({ side, taker, coin, amountRaw, minOut, cuLimit = CU.swap, cuPrice = 0n }) {
  const sol = coin.quoteMint === ADDRESSES.wsol;
  const referral = await ata(ADDRESSES.feeRecipient, coin.quoteMint);
  const ixs = [setComputeUnitLimit(cuLimit)];
  if (cuPrice > 0n) ixs.push(setComputeUnitPrice(cuPrice));
  ixs.push(await createAtaIdempotent({ payer: taker, owner: ADDRESSES.feeRecipient, mint: coin.quoteMint }));
  const common = { trader: taker, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: coin.quoteMint, referral };
  if (side === "buy") {
    if (sol) ixs.push(...(await wrapSol(taker, amountRaw)));
    ixs.push(await createAtaIdempotent({ payer: taker, owner: taker, mint: coin.mint }));
    ixs.push(await swap2({ ...common, side: "buy", mode: SwapMode.PartialFill, amount0: amountRaw, amount1: minOut }));
  } else {
    ixs.push(await createAtaIdempotent({ payer: taker, owner: taker, mint: coin.quoteMint }));
    ixs.push(await swap2({ ...common, side: "sell", mode: SwapMode.ExactIn, amount0: amountRaw, amount1: minOut }));
  }
  if (sol) ixs.push(await unwrapSol(taker));
  return ixs;
}
async function lookupTableOf(env, cl, fetchImpl, now) {
  if (!cl.lookupTable) return null;
  const r = await tables.get([cl.lookupTable], now, async ([k]) => new Map([[k, decodeLookupTable((await lpRpc(env, cl, "getAccountInfo", [k, { encoding: "base64", commitment: "confirmed" }], fetchImpl))?.value)]]));
  const t = r.values.get(cl.lookupTable);
  return t ? { key: cl.lookupTable, addresses: t.addresses } : null;
}

/* ---------------------------------------------------------------- the routes */
function readTradeInput(body, { takerRequired }) {
  if (!body || typeof body !== "object") return bad("bad_json");
  if (!isSolanaAddress(body.mint)) return bad("bad_mint");
  if (body.side !== "buy" && body.side !== "sell") return bad("bad_side");
  if (!(typeof body.amount === "string" || typeof body.amount === "number")) return bad("bad_amount");
  const slippageBps = checkSlippage(body.slippageBps);
  if (slippageBps == null) return bad("bad_slippage", { max: MAX_SLIPPAGE_BPS });
  let taker = null;
  if (body.taker != null && body.taker !== "") { taker = checkTaker(body.taker); if (!taker) return bad("bad_wallet"); }
  if (takerRequired && !taker) return bad("bad_wallet");
  return { mint: body.mint, side: body.side, amount: body.amount, slippageBps, taker, legacy: body.v === "legacy" };
}
const unavailable = (e, what) => { console.error(what, codeOf(e)); return json({ ok: false, error: "rpc_unavailable" }, 503, { "Cache-Control": "no-store" }); };

/** Everything both routes share: the input, the stage, the decimals, the quote. { error: Response } or { ...quote, st, in, amountRaw, cl }. */
async function prepare(request, env, fetchImpl, { takerRequired, now }) {
  const body = await readJson(request, 4096);
  const input = readTradeInput(body, { takerRequired });
  if (input.error) return { error: json({ ok: false, error: input.error, ...(input.max ? { max: input.max } : {}) }, input.status) };
  let st;
  try { st = await stageOf(env, input.mint, fetchImpl, now); } catch (e) { return { error: unavailable(e, "curve stage failed") }; }
  if (!st) return { error: json({ ok: false, error: "curve_not_found" }, 404) };
  if (st.stage === "graduated") return { error: json({ ok: false, error: "stage_graduated", message: "This coin has graduated: it trades on a pool now, through the swap panel." }, 409) };
  if (st.stage === "full") return { error: json({ ok: false, error: "curve_full", message: "The curve is full and waiting for graduation. Trading resumes on the pool." }, 409) };
  if (st.stage !== "curve") return { error: json({ ok: false, error: "curve_not_found" }, 404) };
  let qd;
  try { qd = await quoteDecimals(env, st.cluster, st.coin.quoteMint, fetchImpl, now); } catch (e) { return { error: unavailable(e, "quote decimals failed") }; }
  if (qd == null) return { error: json({ ok: false, error: "unknown_token" }, 400) };
  const parsed = parseAmount(input.amount, input.side === "buy" ? qd : COIN_DECIMALS);
  if (!parsed) return { error: json({ ok: false, error: "bad_amount" }, 400) };
  if (parsed.tooPrecise) return { error: json({ ok: false, error: "amount_too_small" }, 400) };
  let quote;
  try { quote = curveQuote({ side: input.side, pool: st.pool, config: st.config, amountRaw: parsed.raw, slippageBps: input.slippageBps, quoteDecimals: qd, coin: st.coin, chain: st.cluster.chain }); }
  catch (e) {
    if (e instanceof CurveError) {
      const code = e.code === "AmountIsZero" ? "amount_too_small" : e.code === "PoolIsCompleted" ? "curve_full" : e.code === "InsufficientLiquidity" ? "amount_too_large" : "curve_error";
      return { error: json({ ok: false, error: code, detail: e.code }, code === "curve_full" ? 409 : 400) };
    }
    throw e;
  }
  return { quote, st, input, amountRaw: parsed.raw, qd };
}
const quoteId = async (parts) => { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")))); return btoa(String.fromCharCode(...d)).replace(/[+/=]/g, "").slice(0, 22); };
const coinInfo = (st) => ({ mint: st.coin.mint, quoteMint: st.coin.quoteMint, cityId: String(st.coin.cityId), city: st.entry.row, pool: st.coin.dbcPool, config: st.coin.dbcConfig, curve: { raised: st.pool.quoteReserve.toString(), target: st.config.migrationQuoteThreshold.toString(), progressPct: Number((st.pool.quoteReserve * 10000n) / st.config.migrationQuoteThreshold) / 100 } });

/** POST /api/launchpad/trade/quote (the route has checked the switch, the method and the Origin). */
export async function handleTradeQuote(request, env, fetchImpl = fetch, now = Date.now()) {
  const slow = await publicLimit(env, request, "lp_quote");
  if (slow) return slow;
  const p = await prepare(request, env, fetchImpl, { takerRequired: false, now });
  if (p.error) return p.error;
  const id = await quoteId(["curve", p.input.mint, p.input.side, p.amountRaw.toString(), p.input.slippageBps, p.st.pool.sqrtPrice.toString()]);
  return json({ ok: true, quoteId: id, ...p.quote, coin: coinInfo(p.st), cluster: p.st.cluster.cluster, expiresAt: new Date(now + QUOTE_TTL_MS).toISOString() }, 200, { "Cache-Control": "no-store" });
}

/** POST /api/launchpad/trade/tx: the unsigned transaction of a curve trade for `taker`, simulated first. */
export async function handleTradeTx(request, env, fetchImpl = fetch, now = Date.now()) {
  const slow = await publicLimit(env, request, "lp_tx");
  if (slow) return slow;
  const p = await prepare(request, env, fetchImpl, { takerRequired: true, now });
  if (p.error) return p.error;
  const { quote, st, input, amountRaw } = p;
  const cl = st.cluster, taker = input.taker;
  const cuPriceSetting = BigInt(/^\d{1,12}$/.test(String(env.LAUNCHPAD_CU_PRICE || "")) ? env.LAUNCHPAD_CU_PRICE : 0);
  let ixs, blockhash, table = null;
  try {
    ixs = await tradeInstructions({ side: input.side, taker, coin: st.coin, amountRaw, minOut: BigInt(quote.minOut), cuLimit: CU.swap, cuPrice: cuPriceSetting > 0n ? (cuPriceSetting < maxCuPrice(CU.swap) ? cuPriceSetting : maxCuPrice(CU.swap)) : 0n });
    const [bh, t] = await Promise.all([lpRpc(env, cl, "getLatestBlockhash", [{ commitment: "confirmed" }], fetchImpl), input.legacy ? null : lookupTableOf(env, cl, fetchImpl, now)]);
    blockhash = bh && bh.value;
    table = t;
    if (!blockhash || !isSolanaAddress(blockhash.blockhash)) throw new Error("rpc_bad_answer");
  } catch (e) { return unavailable(e, "curve build failed"); }
  const useV0 = Boolean(table) && !input.legacy;
  let message = useV0 ? compileV0({ payer: taker, instructions: ixs, blockhash: blockhash.blockhash, lookupTables: [table] }) : compileLegacy({ payer: taker, instructions: ixs, blockhash: blockhash.blockhash });
  let tx = wrapUnsigned(message);
  if (tx.length > MAX_TX_BYTES && !useV0 && table) { message = compileV0({ payer: taker, instructions: ixs, blockhash: blockhash.blockhash, lookupTables: [table] }); tx = wrapUnsigned(message); }
  if (tx.length > MAX_TX_BYTES) return json({ ok: false, error: "tx_too_large" }, 400);
  // the simulation: a plain code before the wallet opens, and the units it really needs
  let cuLimit = CU.swap;
  try {
    const sim = await simulate(env, tx, fetchImpl, { url: cl.rpc });
    if (!sim.ok) {
      const m = simulationError(sim.err, sim.logs, decodeHeader(tx), { launchpadProgramId: cl.programId }) || { error: "program_error" };
      console.error("curve trade would fail", m.error, m.name || "");
      return json({ ok: false, ...m, program: m.program ? m.program : undefined, stage: "simulation" }, 409, { "Cache-Control": "no-store" });
    }
    if (sim.unitsConsumed) cuLimit = Math.min(1_400_000, Math.max(50_000, Math.ceil(sim.unitsConsumed * 1.2)));
  } catch (e) { return unavailable(e, "curve simulation failed"); }
  if (cuLimit !== CU.swap) {
    ixs[0] = setComputeUnitLimit(cuLimit);
    message = useV0 ? compileV0({ payer: taker, instructions: ixs, blockhash: blockhash.blockhash, lookupTables: [table] }) : compileLegacy({ payer: taker, instructions: ixs, blockhash: blockhash.blockhash });
    tx = wrapUnsigned(message);
  }
  const cuPrice = cuPriceSetting > 0n ? (cuPriceSetting < maxCuPrice(cuLimit) ? cuPriceSetting : maxCuPrice(cuLimit)) : 0n;
  const id = await quoteId(["curve", input.mint, input.side, amountRaw.toString(), input.slippageBps, st.pool.sqrtPrice.toString()]);
  // this trade is about to move the curve: the next quote of this pool reads the chain again instead of the copy of the last
  // 5 seconds, so the person who just traded (and sells or buys again at once) sees the true numbers, not those from before
  pools.forget([st.coin.dbcPool]);
  return json({
    ok: true, quoteId: id, tx: toBase64(tx), version: useV0 ? 0 : "legacy", bytes: tx.length, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight,
    chain: cl.chain, cluster: cl.cluster, taker, quote: { ...quote, coin: coinInfo(st), expiresAt: new Date(now + QUOTE_TTL_MS).toISOString() },
    fees: { computeUnitLimit: cuLimit, computeUnitPrice: cuPrice.toString(), priorityLamports: Number(priorityFeeLamports(cuPrice, cuLimit)), networkLamports: Number(NETWORK_FEE_LAMPORTS), rentLamports: Number(RENT_ATA_LAMPORTS), rentNote: "about 0.002 SOL once for a token account that does not exist yet; it stays yours" },
    solscanBase: solscanTx("", cl.cluster).replace(/\/$/, ""),
  }, 200, { "Cache-Control": "no-store" });
}
