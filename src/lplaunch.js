/**
 * The founder's launch of their city coin and the move to the open market, on our own launchpad (src/index.js routes
 * /api/lp/launch/*, /api/lp/graduate/* and /api/lp/founder-claim/* here only while lpSetup(env).on). Nothing here holds a key or
 * sends anything: the Worker reads the chain, checks the step can run, builds the transaction UNSIGNED with the SESSION wallet as
 * the fee payer (never a wallet from the request), simulates it and answers the decoded instruction list and the exact SOL change
 * (src/lpkit.js buildTx). The page (public/lp-launch.js, public/coin.js) shows that; public/lp-sign.js has the one-time key(s) made
 * in the browser (the coin's mint, the two position-NFT mints) sign first, then the wallet signs and sends (or the relay sends).
 *
 *   GET  /api/lp/launch/status   (no city) the pages' probe: { on: true, cluster, configsSet, speedTable }, no sign-in, nothing read
 *   GET  /api/lp/launch/status?city=&cluster=[&buy=<lamports>&slippageBps=]   the signed-in founder of that city: the Approval on
 *        chain (founder, name, symbol, expiry, price curve, who paid its rent), launches paused, the price curve allowed and on;
 *        the session wallet must be the approval's founder and the seat must still be held (stillFounder). state:
 *        not_approved | ready | expired | paused | launched (+ mint, the founder's fees waiting). With buy=: the exact first-buy quote.
 *   POST /api/lp/launch/tx { cityId, cluster, mint, firstBuyLamports, slippageBps }   payer = founder = the session wallet; `mint`
 *        is the one-time key made in the founder's browser. launch (+ the first buy, at most 10 SOL, in the same v0 transaction
 *        through LAUNCHPAD_LOOKUP_TABLE; without the table, or when it does not fit in 1232 bytes, the buy is refused in plain words)
 *   GET  /api/lp/graduate/status?mint=   what "Move to the open market" can do now (public: it only reads the chain)
 *   POST /api/lp/graduate/tx { mint, cluster, step: migrate|leftover, nft1, nft2 }   any signed-in wallet pays: migrate only at
 *        stage full (DBC migration_damm_v2, 400k compute, two one-time position-NFT keys), then leftover (the dev wallet's coin
 *        account, idempotent, and withdraw_leftover)
 *   POST /api/lp/founder-claim/tx { cityId, cluster }   the coin's founder on chain only: the city's share still on the curve is
 *        collected first (harvest_curve_fees, anyone may), then claim_founder_fees, then the SOL is unwrapped
 * Every POST echoes the cluster the page shows (body.cluster) and is refused on a mismatch (a GET may leave it out: the page learns the
 * cluster from that answer, and a GET that names another cluster is refused too); the RPC's genesis hash is checked before any read. Approving, launching and graduating also need the price-curve settings set explicitly (lpSetup().configsSet).
 * A launch is also refused (409 program_changed; 503 program_check_unavailable when it cannot be read) while a Meteora program on the
 * cluster is not the build the team tested (src/programpins.js, read fresh for the build): a launch on an untested build is as bad as
 * an approval on one. The founder is told in plain words (no fingerprints) that their approval stays. This holds launches from this
 * site only: the program checks just the approval, so the owner's lever for other tools is Pause launches.
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { isSolanaAddress } from "./solana.js";
import { codeOf } from "./sources.js";
import { lpSetup } from "./cluster.js";
import { buildTx, checkCluster, checkGenesis, checkedRoute, readAccounts, respond } from "./lpkit.js";
import { liveSeatOfUser } from "./roles.js";
import { stillFounder } from "./seats.js";
import { iso } from "./policy.js";
import { keyLimit, publicLimit, walletLimit } from "./guards.js";
import { displayTicker } from "./tickers.js";
import { decodeApproval } from "./lpadmin.js";
import { coinByMint, recordedByMint } from "./lpcoins.js";
import { programHashes, programRefusal } from "./programpins.js";
import { ADDRESSES, PROGRAM_IDS, ata, launchpad as launchpadPdas } from "./sol/pda.js";
import { accountBytes, decodeCoin, decodeConfig, decodeLaunchConfig, decodeLaunchpad, decodePool, decodeTokenAccount } from "./sol/dbc.js";
import { CurveError, quoteBuy } from "./sol/quote.js";
import { feeSchedule, halvesWords, meteoraWords, poolSplitWords } from "./fees.js";
import { closeTokenAccount } from "./sol/ix.js";
import { formatAmount } from "./sol/input.js";
import { LAYOUT } from "./sol/layout.js";
import { harvestCurveFees } from "./sol/lpadmin-ix.js";
import * as IX from "./sol/lplaunch-ix.js";

const WSOL = ADDRESSES.wsol;
/** The most SOL a founder's first buy may spend (raw lamports): 10 SOL. */
export const MAX_FIRST_BUY_LAMPORTS = 10_000_000_000n;
/** The first buy runs in the launch's own transaction: nobody can trade in between, so its slippage only covers rounding. */
export const FIRST_BUY_SLIPPAGE_BPS = 50, MAX_FIRST_BUY_SLIPPAGE_BPS = 500;
/**
 * What the page says before anything is built (the exact figure comes from the simulation): the price curve's launch fee (read from
 * the config, src/fees.js) plus the rent and network fees of the coin's accounts (0.0312 SOL: the launch cost 0.0812 SOL with the
 * defaults, measured in solana/tests-launchpad/18); graduation's rent (0.0325 SOL measured there).
 */
export const LAUNCH_RENT_LAMPORTS = 31_200_000n, GRADUATE_COST_LAMPORTS = 33_000_000;
/** An approval needs this much time left when the launch is built (the wallet, the relay and the network take a moment). */
const EXPIRY_SLACK_S = 60;
/** DBC's migration_progress once the curve is complete (Vicinity configs have no locked vesting): ready to move. */
const LOCKED_VESTING = 2;
const QUOTE_LIMIT = { max: 60, windowMs: 60_000 }; // live first-buy quotes while the founder types (one wallet, many keystrokes)
const COIN_DECIMALS = Number(LAYOUT.constants.COIN_DECIMALS);
const SOL_DECIMALS = 9;

const err = (error, message, status = 409, extra = {}) => json({ ok: false, error, message, ...extra }, status, { "Cache-Control": "no-store" });
const sol = (lamports) => `${formatAmount(BigInt(lamports), SOL_DECIMALS)} SOL`;
const cityIdOf = IX.cityIdOf;

/* ---------------------------------------------------------------- who is asking */
/**
 * The signed-in person and their wallet (the only fee payer this file ever uses), or { error: Response }.
 * write: a POST (must come from this site's own pages).
 */
async function caller(request, env, now, { write }) {
  if (!env.DB) return { error: json({ ok: false, error: "unavailable" }, 503) };
  const a = await access(request, env, now, { write, fresh: false });
  if (a.error) return a;
  if (!a.u.wallet) return { error: err("no_wallet", "Link a wallet to your account first: the coin is launched and paid from it.", 403) };
  return { u: a.u, wallet: a.u.wallet };
}
/**
 * The signed-in founder of `cityId`: their live seat (active or steward) is in that city and they still hold the founder amount
 * (stillFounder, a live check: a seat below the bar goes into grace and the launch is refused). { seat } or { error }.
 */
async function founderOf(env, u, cityId, now, fetchImpl) {
  const seat = await liveSeatOfUser(env.DB, u.id);
  if (!seat || String(seat.city_id) !== String(cityId)) return { error: err("not_founder", "Only this city's founder can launch its coin.", 403) };
  if (seat.status !== "active" && seat.status !== "steward") {
    return { error: err("not_founder", seat.status === "grace" ? "Your founder seat is in its grace period: hold the founder amount again, then launch." : "Your founder seat is not final yet.", 403) };
  }
  let ok;
  try { ok = await stillFounder(env, seat, now, fetchImpl); } catch (e) { console.error("founder check failed", codeOf(e)); return { error: err("rpc_unavailable", "Your balance could not be checked just now. Try again in a minute.", 503) }; }
  if (!ok) return { error: err("in_grace", "Your balance is below the founder amount, so your seat went into its grace period. Hold the founder amount again, then launch.", 403) };
  return { seat };
}
/** The cluster echo (?cluster= or body.cluster): first, before anything is read. null when it is this site's, else the answer. */
const echo = (env, value) => { const c = checkCluster(env, value); return c ? respond(c) : null; };
/** The RPC's genesis hash must be the cluster's (src/lpkit.js; remembered once it matched): after the sign-in and the counters. */
async function genesis(env, fetchImpl) { const g = await checkGenesis(env, fetchImpl); return g.ok ? null : respond(g); }
/**
 * Meteora's programs against the builds the team tested (src/programpins.js), in a founder's words: null when both are as tested,
 * else { status, error, which, message } (409 program_changed, 503 program_check_unavailable). The founder sees no fingerprints;
 * their approval stays either way. `opts` as programHashes takes them (the launch build reads fresh).
 */
async function meteoraHold(env, fetchImpl, now, opts) {
  const pr = programRefusal(await programHashes(env, fetchImpl, now, opts), "Launches");
  if (!pr) return null;
  const message = pr.error === "program_changed"
    ? "Meteora has updated its programs since the team tested them. Launches wait until the team re-tests them; your approval stays."
    : "Meteora's programs could not be checked just now. Launches wait until the check works again; your approval stays. Try again in a minute.";
  return { ...pr, message };
}

/* ---------------------------------------------------------------- the chain */
const poolFlag = (acc, field) => { const a = accountBytes(acc); const f = LAYOUT.VirtualPool.fields[field]; return a && f && a.bytes.length > f.at ? a.bytes[f.at] : null; };
/**
 * Everything a launch depends on, in one read: the Approval, the global Launchpad, the city's Coin record, the price curve's
 * allow-list entry and the DBC config (once the approval names it). Throws on a transport failure.
 */
async function launchState(env, s, cityId, fetchImpl) {
  const L = launchpadPdas(s.programId);
  const [approvalAddr, launchpadAddr, coinAddr] = await Promise.all([L.approval(cityId), L.launchpad(), L.coin(cityId)]);
  const m = await readAccounts(env, [approvalAddr, launchpadAddr, coinAddr], fetchImpl);
  const approval = decodeApproval(m.get(approvalAddr) || null, s.programId);
  const lp = decodeLaunchpad(m.get(launchpadAddr) || null, s.programId);
  const coin = decodeCoin(m.get(coinAddr) || null, s.programId);
  let lc = null, config = null;
  if (approval) {
    const lcAddr = await L.launchConfig(approval.dbcConfig);
    const m2 = await readAccounts(env, [lcAddr, approval.dbcConfig], fetchImpl);
    lc = decodeLaunchConfig(m2.get(lcAddr) || null, s.programId);
    config = decodeConfig(m2.get(approval.dbcConfig) || null);
  }
  return { approval, lp, coin, lc, config, addresses: { approval: approvalAddr, coin: coinAddr } };
}
/**
 * The fee split of a config in plain numbers (percent of every trade), from the schedule src/fees.js reads out of the config: Meteora's
 * protocol fee, Vicinity's share, the city's share halved between holders and founder; the pool fee after graduation. null without a
 * config: no figure is ever said that was not read from the chain.
 */
export function feeSplit(config) {
  const S = feeSchedule(config);
  if (!S) return null;
  const c = S.curve, t = c.text, pct = (bps) => bps / 100;
  return {
    totalPct: pct(c.totalBps), meteoraPct: pct(c.meteoraBps), vicinityPct: pct(c.vicinityBps), holdersPct: pct(c.holdersBps), founderPct: pct(c.founderBps), poolPct: pct(S.pool.totalBps),
    totalText: t.total, // the schedule's own text ("about …" where the config's fee is not a whole tenth of a basis point): what the launch card names
    // the same clauses as the Fees sections (src/fees.js): the Meteora protocol fee with its source, the pool's split with the
    // later-liquidity note; `halves` says the founder / holder-pot halving is our program's rule (the card writes it after its source)
    words: `Every buy and sell on the price curve pays ${t.total}: ${meteoraWords(S)}, Vicinity ${t.vicinity}, the city's holder pot ${t.holders}, and you, the founder, ${t.founder}. After your coin graduates, its pool fee is ${S.pool.text.total}, ${poolSplitWords(S, "you, the founder,")}.`,
    halves: halvesWords("you"),
  };
}
/** What a launch costs the founder, before the simulation says it exactly: the curve's launch fee (when known) and the rent. */
function launchCost(config) {
  if (!config) {
    return { approxLamports: null, launchFeeLamports: null, rentLamports: Number(LAUNCH_RENT_LAMPORTS), words: `The price curve's launch fee and about ${sol(LAUNCH_RENT_LAMPORTS)} of rent for the coin's accounts come from your wallet. The exact amount is shown before your wallet opens.` };
  }
  const fee = config.poolCreationFee, approx = fee + LAUNCH_RENT_LAMPORTS;
  return {
    approxLamports: Number(approx), launchFeeLamports: fee.toString(), rentLamports: Number(LAUNCH_RENT_LAMPORTS),
    words: `About ${sol(approx)} from your wallet: ${fee > 0n ? `the ${sol(fee)} launch fee` : "no launch fee on this price curve"} and about ${sol(LAUNCH_RENT_LAMPORTS)} of rent for the coin's accounts. The exact amount is shown before your wallet opens.`,
  };
}
/** The curve's start (no pool exists before the launch): the config's start price, nothing in it yet. */
const startPool = (config) => ({ sqrtPrice: config.sqrtStartPrice, quoteReserve: 0n, baseReserve: 0n });
/** The exact first-buy quote at the curve's start. { quote } or { error, message }. */
function firstBuyQuote(config, amountIn, slippageBps) {
  try {
    const q = quoteBuy(startPool(config), config, { amountIn, slippageBps });
    if (q.minOut <= 0n) return { error: "first_buy_too_small", message: "That first buy is too small to get a whole coin unit. Buy a little more, or launch without one." };
    return {
      quote: {
        amountInLamports: q.amountIn.toString(), amountInSol: formatAmount(q.amountIn, SOL_DECIMALS), coinsOut: q.amountOut.toString(), coinsOutUi: formatAmount(q.amountOut, COIN_DECIMALS),
        minOut: q.minOut.toString(), minOutUi: formatAmount(q.minOut, COIN_DECIMALS), feeLamports: q.fees.total.toString(), refundLamports: q.refund.toString(),
        partialFill: q.mode === 1, completesCurve: q.completesCurve, priceImpactPct: (q.priceImpactBps / 100).toFixed(2), slippageBps,
      },
      minOut: q.minOut,
    };
  } catch (e) {
    if (e instanceof CurveError || e instanceof RangeError) return { error: "bad_first_buy", message: "That first buy cannot be quoted on this price curve. Try another amount, or launch without one." };
    throw e;
  }
}
/** A lamport amount from the request: a non-negative integer (string or number), at most `max`. null when it is not one. */
function lamportsOf(v, max) {
  if (v === undefined || v === null || v === "" || v === 0 || v === "0") return 0n;
  const t = typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,20}$/.test(t)) return null;
  const n = BigInt(t);
  return n > max ? { tooLarge: true } : n;
}
function slippageOf(v) {
  if (v === undefined || v === null || v === "") return FIRST_BUY_SLIPPAGE_BPS;
  const n = typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n <= MAX_FIRST_BUY_SLIPPAGE_BPS ? n : null;
}
/** Why a launch cannot be built right now, in plain words (null: it can). `nowS` = seconds. */
function launchProblem(st, s, wallet, nowS, { slack = 0 } = {}) {
  if (st.coin) return { state: "launched", error: "already_launched", message: "Your city's coin is launched already." };
  if (!st.approval) return { state: "not_approved", error: "not_approved", message: "An admin approves your coin on chain first; your pair must be SOL." };
  if (st.approval.founder !== wallet) return { state: "not_approved", error: "founder_mismatch", status: 403, message: `This approval is for the wallet ${st.approval.founder}; you are signed in with ${wallet}. Sign in with that wallet, or ask an admin to approve your current one.` };
  if (st.approval.expiresAt <= nowS + slack) return { state: "expired", error: "approval_expired", message: `Your approval ${st.approval.expiresAt <= nowS ? "expired" : "ends in under a minute"} (${iso(st.approval.expiresAt * 1000)}). Ask an admin to approve your coin again.` };
  if (!st.lp) return { state: "paused", error: "not_started", message: "The launchpad is not started on this network yet." };
  if (st.lp.launchesPaused) return { state: "paused", error: "launches_paused", message: "Launches are paused for now. Your approval stays; try again later." };
  if (!st.lc || !st.lc.enabled) return { state: "paused", error: "config_disabled", message: "Launches on this price curve are switched off for now. Your approval stays; try again later." };
  if (!st.config) return { state: "paused", error: "config_missing", message: "The price curve of your approval could not be read." };
  if (st.lc.quoteMint !== WSOL || st.config.quoteMint !== WSOL) return { state: "paused", error: "not_sol", message: "Your approval's price curve is not priced in SOL; only SOL pairs launch here for now." };
  if (!s.configsSet || !s.dbcConfigs.includes(st.approval.dbcConfig)) return { state: "paused", error: "config_not_set", message: "Launching is not switched on on this site yet (the team sets the price curve after the setup). Your approval stays." };
  return null;
}

/* ---------------------------------------------------------------- GET /api/lp/launch/status */
async function launchStatus(request, env, fetchImpl, now) {
  const s = lpSetup(env), q = new URL(request.url).searchParams;
  // the pages' probe (no city): the launch is switched on here, on this cluster. No sign-in, no chain read (the route answers 404
  // not_enabled while the gate is off, so this says nothing a coin page does not say already)
  if (!q.has("city")) return json({ ok: true, on: true, cluster: s.cluster, chain: s.chain, configsSet: s.configsSet, speedTable: Boolean(s.lookupTable) }, 200, { "Cache-Control": "no-store" });
  const blocked = q.get("cluster") === null ? null : echo(env, q.get("cluster")); // a read: the page learns the cluster from the answer
  if (blocked) return blocked;
  const who = await caller(request, env, now, { write: false });
  if (who.error) return who.error;
  const cityId = cityIdOf(q.get("city"));
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const buy = lamportsOf(q.get("buy"), MAX_FIRST_BUY_LAMPORTS);
  if (buy === null) return err("bad_first_buy", "The first buy must be an amount of SOL.", 400);
  if (buy && buy.tooLarge) return err("first_buy_too_large", `The first buy is at most ${sol(MAX_FIRST_BUY_LAMPORTS)}.`, 400);
  const slip = slippageOf(q.get("slippageBps"));
  if (slip === null) return err("bad_slippage", `Slippage is 0 to ${MAX_FIRST_BUY_SLIPPAGE_BPS / 100}%.`, 400);
  const slow = await keyLimit(env, buy ? "lp_launch_quote" : "lp_launch_status", who.wallet, QUOTE_LIMIT, now);
  if (slow) return slow;
  const g = await genesis(env, fetchImpl);
  if (g) return g;
  const f = await founderOf(env, who.u, cityId, now, fetchImpl);
  if (f.error) return f.error;

  let st;
  try { st = await launchState(env, s, cityId, fetchImpl); } catch (e) { console.error("launch status read failed", codeOf(e)); return err("rpc_unavailable", "The blockchain could not be reached just now. Try again in a minute.", 503); }
  // the ticker the card shows: once launched and recorded, the chain's symbol; before that the city list's (src/tickers.js)
  const t = await displayTicker(env, { cityId: String(cityId), mint: st.coin ? st.coin.mint : null, chainSymbol: st.coin ? undefined : null });
  const nowS = Math.floor(now / 1000);
  const out = {
    ok: true, cluster: s.cluster, chain: s.chain, cityId: String(cityId), city: { id: String(cityId), name: f.seat.city_name, country: f.seat.country },
    wallet: who.wallet, ticker: t ? t.ticker : null, fees: feeSplit(st.config),
    cost: launchCost(st.config),
    firstBuy: { maxLamports: MAX_FIRST_BUY_LAMPORTS.toString(), allowed: Boolean(s.lookupTable), reason: s.lookupTable ? null : "A first buy in the same transaction needs the site's speed table, which is not set yet. Launch first, then buy on your coin's page." },
  };
  if (st.approval) {
    out.coin = { name: st.approval.name, symbol: st.approval.symbol, pair: "SOL" };
    out.approval = { founder: st.approval.founder, expiresAt: iso(st.approval.expiresAt * 1000), secondsLeft: Math.max(0, st.approval.expiresAt - nowS), dbcConfig: st.approval.dbcConfig };
  }
  if (st.coin) {
    out.state = "launched";
    out.mint = st.coin.mint;
    out.coin = { ...(out.coin || {}), mint: st.coin.mint, launchedAt: st.coin.launchedAt > 0n ? iso(Number(st.coin.launchedAt) * 1000) : null };
    out.coinPage = `/coin?mint=${st.coin.mint}`;
    out.explorer = `https://solscan.io/token/${st.coin.mint}${s.cluster === "mainnet" ? "" : `?cluster=${s.cluster}`}`;
    out.founderFees = await founderFees(env, s, st.coin, fetchImpl).catch(() => null);
    out.yours = st.coin.founder === who.wallet;
    return json(out, 200, { "Cache-Control": "no-store" });
  }
  let p = launchProblem(st, s, who.wallet, nowS);
  if (p && p.error === "founder_mismatch") return err(p.error, p.message, 403, { state: p.state, approval: out.approval });
  // otherwise ready: Meteora's programs must still be the tested builds (the card says why launches wait, before the founder presses)
  if (!p) { const h = await meteoraHold(env, fetchImpl, now); if (h) p = { state: "paused", error: h.error, message: h.message }; }
  out.state = p ? p.state : "ready";
  if (p) { out.why = p.error; out.message = p.message; }
  if (buy && st.config && !p) {
    const fq = firstBuyQuote(st.config, buy, slip);
    if (fq.error) out.quoteError = fq.message; else out.quote = fq.quote;
  }
  return json(out, 200, { "Cache-Control": "no-store" });
}

/* ---------------------------------------------------------------- POST /api/lp/launch/tx */
async function launchTx(request, env, fetchImpl, now) {
  const s = lpSetup(env);
  const who = await caller(request, env, now, { write: true });
  if (who.error) return who.error;
  const body = await readJson(request, 2048);
  if (!body || typeof body !== "object") return err("bad_json", "Bad request.", 400);
  const blocked = echo(env, body.cluster);
  if (blocked) return blocked;
  const cityId = cityIdOf(body.cityId);
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const mint = typeof body.mint === "string" ? body.mint : Array.isArray(body.ephemeral) ? body.ephemeral[0] : null;
  if (!isSolanaAddress(mint) || mint === who.wallet || Object.values(PROGRAM_IDS).includes(mint)) return err("bad_mint", "The coin's address (a one-time key made in your browser) is missing. Start again.", 400);
  const buy = lamportsOf(body.firstBuyLamports, MAX_FIRST_BUY_LAMPORTS);
  if (buy === null) return err("bad_first_buy", "The first buy must be an amount of SOL.", 400);
  if (buy && buy.tooLarge) return err("first_buy_too_large", `The first buy is at most ${sol(MAX_FIRST_BUY_LAMPORTS)}.`, 400);
  const slip = slippageOf(body.slippageBps);
  if (slip === null) return err("bad_slippage", `Slippage is 0 to ${MAX_FIRST_BUY_SLIPPAGE_BPS / 100}%.`, 400);
  const slow = await walletLimit(env, "lp_launch_tx", who.wallet, now);
  if (slow) return slow;
  const g = await checkGenesis(env, fetchImpl);
  if (!g.ok) return respond(g);
  const f = await founderOf(env, who.u, cityId, now, fetchImpl);
  if (f.error) return f.error;

  let st;
  try { st = await launchState(env, s, cityId, fetchImpl); } catch (e) { console.error("launch read failed", codeOf(e)); return err("rpc_unavailable", "The blockchain could not be reached just now. Nothing was built. Try again in a minute.", 503); }
  const p = launchProblem(st, s, who.wallet, Math.floor(now / 1000), { slack: EXPIRY_SLACK_S });
  if (p) return err(p.error, p.message, p.status || 409, { state: p.state, ...(st.coin ? { mint: st.coin.mint } : {}) });
  // never a launch on a Meteora build the team has not tested (409), nor one blind while that cannot be read (503); read fresh (the
  // deploy slots again, on the node whose genesis hash was checked), so an upgrade a minute ago is seen now
  const pr = await meteoraHold(env, fetchImpl, now, { fresh: true, route: checkedRoute(env, g) });
  if (pr) return err(pr.error, pr.message, pr.status, { state: "paused", which: pr.which });
  if (buy > 0n && !s.lookupTable) return err("first_buy_needs_table", "A first buy in the same transaction needs the site's speed table, which is not set yet. Launch first, then buy on your coin's page.");

  const ap = st.approval;
  const launchIx = await IX.launch({ programId: s.programId, founder: who.wallet, baseMint: mint, cityId, dbcConfig: ap.dbcConfig, quoteMint: WSOL, rentPayer: ap.rentPayer });
  const accts = await IX.launchAccounts({ programId: s.programId, cityId, baseMint: mint, dbcConfig: ap.dbcConfig, quoteMint: WSOL });
  const instructions = [launchIx];
  let quote = null;
  if (buy > 0n) {
    const fq = firstBuyQuote(st.config, buy, slip);
    if (fq.error) return err(fq.error, fq.message, 400);
    quote = fq.quote;
    instructions.push(...(await IX.firstBuy({ founder: who.wallet, mint, pool: accts.pool, dbcConfig: ap.dbcConfig, amountIn: buy, minOut: fq.minOut })));
  }
  const labels = {
    [mint]: `${ap.symbol}'s address (new: a one-time key made in your browser)`, [accts.coin]: `${f.seat.city_name}'s coin record (new)`, [accts.approval]: "your approval (closed: its rent goes back to the admin who paid it)",
    [ap.rentPayer]: ap.rentPayer === who.wallet ? "your wallet (gets the approval's rent back)" : "the admin who paid the approval's rent (gets it back)",
    [accts.pool]: "the coin's price curve on Meteora (new)", [accts.holdersPot]: "the holders' pot (new)", [accts.founderVault]: "your founder fee vault (new)", [accts.metadata]: "the coin's name and symbol (Metaplex, new)",
    [ap.dbcConfig]: "the Vicinity price curve settings", [ADDRESSES.feeRecipient]: "Vicinity dev wallet",
    [accts.launchpad]: "the Vicinity launchpad's settings", [accts.launchConfig]: "the price curve's place on the launchpad's allow-list",
  };
  const r = await buildTx(env, { payer: who.wallet, instructions, extraSigners: [mint], lookupTable: s.lookupTable || null, watch: [who.wallet], labels }, fetchImpl, now);
  if (!r.ok && r.error === "tx_too_large" && buy > 0n) {
    return err("first_buy_too_large", "Your launch and your first buy do not fit in one Solana transaction. Launch first, then buy on your coin's page.", 400, { bytes: r.bytes || null });
  }
  if (r.ok) {
    Object.assign(r, {
      step: "launch", cityId: String(cityId), mint, pool: accts.pool, coin: { name: ap.name, symbol: ap.symbol, pair: "SOL" }, quote,
      record: { cityId: String(cityId) }, coinPage: `/coin?mint=${mint}`, explorer: `https://solscan.io/token/${mint}${s.cluster === "mainnet" ? "" : `?cluster=${s.cluster}`}`,
    });
  }
  return respond(r);
}

/* ---------------------------------------------------------------- the open market */
/** A launched coin of this program by its mint: the Coin record from the chain (through lp_coins when it is recorded). */
async function coinOfMint(env, s, mint, fetchImpl) {
  const row = await recordedByMint(env, mint).catch(() => null);
  if (row && row.cluster === s.cluster && row.program_id === s.programId && /^\d{1,20}$/.test(String(row.city_id))) {
    const addr = await launchpadPdas(s.programId).coin(BigInt(row.city_id));
    const c = decodeCoin((await readAccounts(env, [addr], fetchImpl)).get(addr) || null, s.programId);
    if (c && c.mint === mint) return c;
  }
  return coinByMint(env, mint, fetchImpl);
}
/** Where a coin stands for graduation: { coin, pool, config, stage, canMigrate, leftoverDue } (null pool: not a Vicinity curve). */
async function gradState(env, s, mint, fetchImpl) {
  const coin = await coinOfMint(env, s, mint, fetchImpl);
  if (!coin) return null;
  const m = await readAccounts(env, [coin.dbcPool, coin.dbcConfig], fetchImpl);
  const poolAcc = m.get(coin.dbcPool) || null;
  const pool = decodePool(poolAcc), config = decodeConfig(m.get(coin.dbcConfig) || null);
  if (!pool || !config || pool.baseMint !== coin.mint || pool.config !== coin.dbcConfig) return { coin, pool: null, config: null, stage: "unknown", canMigrate: false, leftoverDue: false };
  const complete = pool.quoteReserve >= config.migrationQuoteThreshold;
  const stage = pool.isMigrated ? "graduated" : complete || pool.migrationProgress >= 1 ? "full" : "curve";
  const canMigrate = !pool.isMigrated && complete && pool.migrationProgress === LOCKED_VESTING;
  const leftoverDue = (pool.isMigrated || (complete && pool.migrationProgress === LOCKED_VESTING)) && poolFlag(poolAcc, "is_withdraw_leftover") === 0;
  const pct = config.migrationQuoteThreshold > 0n ? Math.min(100, Number((pool.quoteReserve * 10000n) / config.migrationQuoteThreshold) / 100) : null;
  return { coin, pool, config, stage, canMigrate, leftoverDue, progress: { raised: formatAmount(pool.quoteReserve, SOL_DECIMALS), target: formatAmount(config.migrationQuoteThreshold, SOL_DECIMALS), pct: stage === "curve" ? pct : 100 } };
}
const gradWords = (g) => (g.canMigrate ? "The curve is full. Anyone can move the coin to the open market now: a Meteora pool where it trades like any other token."
  : g.leftoverDue ? "One step left: return the coins the curve never sold to Vicinity's dev wallet (the curve's settings name it). Anyone can do it for the network fee."
    : g.stage === "graduated" ? "This coin is on the open market already. Nothing left to do."
      : g.stage === "curve" ? "The curve is not full yet: the coin moves to the open market once its target is raised."
        : g.stage === "full" ? "The curve is full and Meteora is finishing the move. Check again in a minute."
          : "This coin's curve could not be read as a Vicinity curve.");

/** GET /api/lp/graduate/status?mint=&cluster= (public: it only reads the chain; counted per connection). */
async function graduateStatus(request, env, fetchImpl, now) {
  const s = lpSetup(env), q = new URL(request.url).searchParams;
  const mint = q.get("mint");
  if (!isSolanaAddress(mint)) return err("bad_mint", "Unknown coin.", 400);
  const blocked = q.get("cluster") === null ? null : echo(env, q.get("cluster"));
  if (blocked) return blocked;
  const slow = await publicLimit(env, request, "lp_coin", now);
  if (slow) return slow;
  const gen = await genesis(env, fetchImpl);
  if (gen) return gen;
  let g;
  try { g = await gradState(env, s, mint, fetchImpl); } catch (e) { console.error("graduate status failed", codeOf(e)); return err("rpc_unavailable", "The blockchain could not be reached just now.", 503); }
  if (!g) return err("not_found", "This coin is not on the Vicinity launchpad.", 404);
  return json({ ok: true, cluster: s.cluster, mint, stage: g.stage, canMigrate: g.canMigrate, leftoverDue: g.leftoverDue, progress: g.progress || null, message: gradWords(g),
    cost: { approxLamports: GRADUATE_COST_LAMPORTS, words: `About ${sol(GRADUATE_COST_LAMPORTS)} of rent, paid by the wallet that does it (you, if you press the button).` } }, 200, { "Cache-Control": "no-store" });
}

/** POST /api/lp/graduate/tx { mint, cluster, step, nft1, nft2 } */
async function graduateTx(request, env, fetchImpl, now) {
  const s = lpSetup(env);
  const who = await caller(request, env, now, { write: true });
  if (who.error) return who.error;
  const body = await readJson(request, 2048);
  if (!body || typeof body !== "object") return err("bad_json", "Bad request.", 400);
  const blocked = echo(env, body.cluster);
  if (blocked) return blocked;
  if (!isSolanaAddress(body.mint)) return err("bad_mint", "Unknown coin.", 400);
  const step = body.step === undefined ? "migrate" : body.step;
  if (step !== "migrate" && step !== "leftover") return err("bad_step", "Unknown step.", 400);
  const keys = Array.isArray(body.ephemeral) && body.ephemeral.length === 2 ? body.ephemeral : [body.nft1, body.nft2];
  if (step === "migrate") {
    const [a, b] = keys;
    if (!isSolanaAddress(a) || !isSolanaAddress(b) || a === b || a === who.wallet || b === who.wallet) return err("bad_keys", "The two one-time keys this step needs are missing. Start again.", 400);
  }
  if (!s.configsSet) return err("config_not_set", "Moving coins to the open market is not switched on on this site yet.");
  const slow = await walletLimit(env, "lp_grad_tx", who.wallet, now);
  if (slow) return slow;
  const gen = await genesis(env, fetchImpl);
  if (gen) return gen;
  let g;
  try { g = await gradState(env, s, body.mint, fetchImpl); } catch (e) { console.error("graduate read failed", codeOf(e)); return err("rpc_unavailable", "The blockchain could not be reached just now. Nothing was built.", 503); }
  if (!g) return err("not_found", "This coin is not on the Vicinity launchpad.", 404);
  if (!g.pool) return err("not_a_curve", gradWords(g));
  const c = g.coin;
  if (step === "migrate") {
    if (!g.canMigrate) return err(g.stage === "graduated" ? "already_graduated" : "not_full", gradWords(g), 409, { stage: g.stage, leftoverDue: g.leftoverDue });
    const [nft1, nft2] = keys;
    const ix = await IX.migrateToDammV2({ payer: who.wallet, dbcPool: c.dbcPool, dbcConfig: c.dbcConfig, coinMint: c.mint, quoteMint: c.quoteMint, firstNftMint: nft1, secondNftMint: nft2 });
    const ma = await IX.migrationAccounts({ coinMint: c.mint, quoteMint: c.quoteMint, firstNftMint: nft1, secondNftMint: nft2 });
    const labels = { [nft1]: "position NFT 1 (new: a one-time key made in your browser)", [nft2]: "position NFT 2 (new: a one-time key made in your browser)",
      [ma.pool]: "the coin's open-market pool (Meteora DAMM v2, new)", [c.dbcPool]: "the coin's price curve (emptied into the pool)", [c.mint]: "the coin" };
    const r = await buildTx(env, { payer: who.wallet, instructions: [ix], extraSigners: [nft1, nft2], lookupTable: s.lookupTable || null, cuLimit: IX.CU.graduate, watch: [who.wallet], labels }, fetchImpl, now);
    if (r.ok) Object.assign(r, { step: "migrate", mint: c.mint, cityId: String(c.cityId), pool: ma.pool, next: "leftover" });
    return respond(r);
  }
  if (!g.leftoverDue) return err(g.stage === "graduated" ? "nothing_left" : "not_full", gradWords(g), 409, { stage: g.stage });
  const ixs = await IX.leftoverInstructions({ payer: who.wallet, coin: c });
  const r = await buildTx(env, { payer: who.wallet, instructions: ixs, lookupTable: s.lookupTable || null, watch: [who.wallet],
    labels: { [await ata(ADDRESSES.feeRecipient, c.mint)]: "Vicinity dev wallet's account for this coin (made if missing)", [c.dbcPool]: "the coin's price curve" } }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "leftover", mint: c.mint, cityId: String(c.cityId) });
  return respond(r);
}

/* ---------------------------------------------------------------- the founder's fees */
/** What is waiting for the coin's founder: in the founder vault, and the city's share still on the curve (half of it is the founder's). */
async function founderFees(env, s, coin, fetchImpl) {
  const L = launchpadPdas(s.programId);
  const vault = await L.founderVault(await L.coin(coin.cityId));
  const m = await readAccounts(env, [vault, coin.dbcPool, coin.dbcConfig], fetchImpl);
  const v = decodeTokenAccount(m.get(vault) || null), pool = decodePool(m.get(coin.dbcPool) || null);
  const inVault = v ? v.amount : 0n;
  const onCurve = pool && !pool.isMigrated ? pool.creatorQuoteFee / 2n : 0n;
  // the founder's part of every trade, from the config the coin launched under (src/fees.js): the curve's figure, the pool's once it
  // has graduated; null when the config could not be read (the card then names no figure). In the pool it is a ceiling (shareUpTo):
  // anyone who adds liquidity later takes part of the fee the locked positions earn
  const S = feeSchedule(decodeConfig(m.get(coin.dbcConfig) || null));
  const graduated = Boolean(pool && pool.isMigrated);
  const sharePct = S ? (graduated ? S.pool.text.founder : S.curve.text.founder) : null;
  return { inVaultLamports: inVault.toString(), onCurveLamports: onCurve.toString(), totalLamports: (inVault + onCurve).toString(), sharePct, shareUpTo: Boolean(sharePct) && graduated, words: `${sol(inVault + onCurve)} waiting for you` };
}
/** POST /api/lp/founder-claim/tx { cityId, cluster } */
async function founderClaimTx(request, env, fetchImpl, now) {
  const s = lpSetup(env);
  const who = await caller(request, env, now, { write: true });
  if (who.error) return who.error;
  const body = await readJson(request, 1024);
  if (!body || typeof body !== "object") return err("bad_json", "Bad request.", 400);
  const blocked = echo(env, body.cluster);
  if (blocked) return blocked;
  const cityId = cityIdOf(body.cityId);
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const slow = await walletLimit(env, "lp_claim_tx", who.wallet, now);
  if (slow) return slow;
  const gen = await genesis(env, fetchImpl);
  if (gen) return gen;
  const L = launchpadPdas(s.programId);
  let coin, fees, pool;
  try {
    const addr = await L.coin(cityId);
    coin = decodeCoin((await readAccounts(env, [addr], fetchImpl)).get(addr) || null, s.programId);
    if (coin) {
      fees = await founderFees(env, s, coin, fetchImpl);
      pool = decodePool((await readAccounts(env, [coin.dbcPool], fetchImpl)).get(coin.dbcPool) || null);
    }
  } catch (e) { console.error("founder claim read failed", codeOf(e)); return err("rpc_unavailable", "The blockchain could not be reached just now. Nothing was built.", 503); }
  if (!coin) return err("not_launched", "This city's coin is not launched.", 404);
  if (coin.founder !== who.wallet) return err("founder_mismatch", `Only the coin's founder on chain (${coin.founder}) can collect the founder's fees; you are signed in with ${who.wallet}.`, 403);
  const harvest = pool && !pool.isMigrated && pool.creatorQuoteFee > 0n;
  if (!harvest && BigInt(fees.inVaultLamports) === 0n) return err("nothing_to_claim", "Nothing is waiting for you right now. Fees build up as people trade your coin.");
  const ixs = [];
  if (harvest) ixs.push(await harvestCurveFees({ programId: s.programId, payer: who.wallet, coin }));
  ixs.push(await IX.claimFounderFees({ programId: s.programId, founder: who.wallet, coin }));
  if (coin.quoteMint === WSOL) ixs.push(closeTokenAccount(await ata(who.wallet, WSOL), who.wallet, who.wallet)); // the fees arrive as SOL
  const r = await buildTx(env, { payer: who.wallet, instructions: ixs, lookupTable: s.lookupTable || null, watch: [who.wallet],
    labels: { [await L.founderVault(await L.coin(cityId))]: "your founder fee vault", [await ata(who.wallet, WSOL)]: "your wrapped-SOL account (closed: everything in it comes back as SOL)" } }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "founder-claim", cityId: String(cityId), mint: coin.mint, fees });
  return respond(r);
}

/* ---------------------------------------------------------------- the router */
/** src/index.js has checked lpSetup(env).on; everything here also refuses on its own when the gate is off. */
export async function handleLaunchApi(request, env, fetchImpl = fetch, now = Date.now()) {
  if (!lpSetup(env).on) return json({ ok: false, error: "not_enabled" }, 404);
  const path = new URL(request.url).pathname, method = request.method;
  const routes = {
    "/api/lp/launch/status": ["GET", launchStatus], "/api/lp/launch/tx": ["POST", launchTx],
    "/api/lp/graduate/status": ["GET", graduateStatus], "/api/lp/graduate/tx": ["POST", graduateTx],
    "/api/lp/founder-claim/tx": ["POST", founderClaimTx],
  };
  const r = routes[path];
  if (!r) return json({ error: "not_found" }, 404);
  if (method !== r[0]) return json({ error: "method_not_allowed" }, 405);
  try { return await r[1](request, env, fetchImpl, now); }
  catch (e) { console.error("lp launch route failed", path, codeOf(e)); return err("unavailable", "Something went wrong on the site. Nothing was built. Try again in a minute.", 503); }
}
