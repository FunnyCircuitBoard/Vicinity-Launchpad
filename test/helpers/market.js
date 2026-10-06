// A fake outside world for the Launchpad's live market (src/marketlive.js, src/launchlab.js, src/pricehistory.js, src/coin.js):
// Jupiter (price v3, tokens v2), Raydium LaunchLab (launch-mint-v1, launch-history-v1 kline and trade), DEX Screener and the
// Solana RPC, built from REAL answers recorded on 6 Oct 2026 15:54-16:10 UTC for $VICINITY (test/fixtures/launchlab/, see the
// research notes in src/marketlive.js). Nothing ever leaves the process: every URL is logged, an unknown host is answered 599.
import { readFileSync } from "node:fs";
import { chain } from "./world.js";
import { base58Decode } from "../../src/solana.js";
import { poolAddress } from "../../src/launchlab.js";

export const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/launchlab/${name}`, import.meta.url), "utf8"));
export const REAL_MINT = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
export const REAL_POOL = "3E32cHh3aA4KrAH1ShLbHcdTsTs2EyLKLtpWQNiNySZo";
export const INCOGNITO = "BuknMeQoreSUzXXZq8Nn973EkqrWhRzKU34KAhyrPpyb";
export const SOL = "So11111111111111111111111111111111111111112";
export const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };

/**
 * The recorded LaunchLab pool account (getMultipleAccounts / getAccountInfo, base64), moved onto another mint (and pair) so a
 * test mint gets a real-looking curve: only the mintA and mintB fields change. `graduated` uses INCOGNITO's graduated pool.
 */
export function poolAccount(mint = REAL_MINT, { graduated = false, pairMint = SOL, patch = null } = {}) {
  const src = fixture(graduated ? "pool_grad.json" : "pool.json").result.value;
  const bytes = Uint8Array.from(Buffer.from(src.data[0], "base64"));
  bytes.set(base58Decode(mint), 205);
  bytes.set(base58Decode(pairMint), 237);
  if (patch) patch(bytes);
  return { ...src, data: [Buffer.from(bytes).toString("base64"), "base64"] };
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...JSON_TYPE, ...headers } });
const outage = (mode, init) => {
  if (!mode || mode === "ok") return null;
  if (mode === "http429") return json({ error: "rate limited" }, 429, { "retry-after": "20" });
  if (mode === "http403") return new Response("<html>Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } });
  if (mode === "http500") return new Response("upstream down", { status: 500 });
  if (mode === "html") return new Response("<!DOCTYPE html><title>Just a moment...</title><script>challenge()</script>", { headers: { "content-type": "text/html; charset=UTF-8" } });
  if (mode === "garbage") return json({ nonsense: true, rows: "x" });
  if (mode === "badjson") return new Response("{not json", { headers: JSON_TYPE });
  if (mode === "neterr") throw new TypeError("fetch failed");
  if (mode === "hang") return new Promise((_, reject) => {
    const keep = setTimeout(() => reject(new Error("the caller never gave up")), 20_000);
    init?.signal?.addEventListener("abort", () => { clearTimeout(keep); reject(new DOMException("timed out", "TimeoutError")); });
  });
  throw new Error("unknown mode " + mode);
};

/**
 * The world. Options (all optional):
 *   jup      { mode, prices: { mint: price v3 entry } }   default: the recorded $VICINITY entry on `mint`, SOL at $120.79
 *   tokens   { mode, items: [tokens v2 items] }           default: the recorded $VICINITY item on `mint`
 *   raydium  { mode, mint: { mint: row } | null, trades: rows | null, kline: { "15m": rows, "1m": rows }, klineMode, tradeMode, mintMode }
 *   pools    { poolAddress: account | null }            default: the recorded curve for `mint` (SOL pair)
 *   rpcMode  outage mode of the RPC for getMultipleAccounts
 *   dex      { mint: [pairs] }                          default: nothing (pairs: null, like the real API for $VICINITY)
 * Returns { fetchImpl, log, hosts(), count(host), urls(host) }.
 */
export async function marketWorld(mint = REAL_MINT, opts = {}) {
  const pool = await poolAddress(mint, SOL);
  const jupEntry = fixture("jup_price.json");
  const jup = { mode: "ok", prices: { [mint]: jupEntry[REAL_MINT], [SOL]: jupEntry[SOL] }, ...(opts.jup || {}) };
  const tok = fixture("jup_tok.json")[0];
  const tokens = { mode: "ok", items: [{ ...tok, id: mint }], ...(opts.tokens || {}) };
  const ray = fixture("raymint.json").data.rows[0];
  const raydium = {
    mode: "ok", mint: { [mint]: { ...ray, mint, poolId: pool } }, trades: fixture("trade.json").data.rows,
    kline: { "15m": fixture("kline_15m.json").data.rows, "1m": fixture("kline_1m.json").data.rows, "5m": [] }, ...(opts.raydium || {}),
  };
  const pools = opts.pools || { [pool]: poolAccount(mint) };
  const dex = opts.dex || {};
  const rpc = chain();
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    log.push({ host: u.host, path: u.pathname, url: String(url), ua: new Headers(init.headers || {}).get("user-agent"), key: new Headers(init.headers || {}).get("x-api-key") });
    if (/(^|\.)jup\.ag$/.test(u.hostname)) {
      if (u.pathname === "/price/v3") {
        const o = await outage(jup.mode, init); if (o) return o;
        const ids = (u.searchParams.get("ids") || "").split(",");
        return json(Object.fromEntries(ids.filter((m) => jup.prices[m]).map((m) => [m, jup.prices[m]])));
      }
      if (u.pathname === "/tokens/v2/search") {
        const o = await outage(tokens.mode, init); if (o) return o;
        const ids = (u.searchParams.get("query") || "").split(",");
        return json(tokens.items.filter((t) => ids.includes(t.id)));
      }
    }
    if (u.host === "launch-mint-v1.raydium.io" && u.pathname === "/get/by/mints") {
      const o = await outage(raydium.mintMode || raydium.mode, init); if (o) return o;
      const ids = (u.searchParams.get("ids") || "").split(",");
      return json({ id: "x", success: true, data: { rows: ids.map((m) => raydium.mint?.[m]).filter(Boolean) } });
    }
    if (u.host === "launch-history-v1.raydium.io") {
      const p = u.searchParams.get("poolId");
      const limit = Number(u.searchParams.get("limit"));
      if (u.pathname === "/kline") {
        const o = await outage(raydium.klineMode || raydium.mode, init); if (o) return o;
        const interval = u.searchParams.get("interval");
        if (!["1m", "5m", "15m"].includes(interval)) return json({ id: "x", success: false, msg: "interval you requested is not currently supported" }, 400);
        if (!(limit >= 1 && limit <= 500)) return json({ id: "x", success: false, msg: "limit max 100" }, 400);
        if (p !== pool) return json({ id: "x", success: true, data: { rows: [] } }); // a pool it does not know: empty, not an error
        const all = (raydium.kline[interval] || []).map((r) => ({ ...r, poolId: p })); // newest first, like the real API
        const start = Number(u.searchParams.get("nextPageKey") || 0);
        const rows = all.slice(start, start + limit);
        const data = { rows };
        if (start + limit < all.length) data.nextPageKey = String(start + limit).padStart(8, "0");
        return json({ id: "x", success: true, data });
      }
      if (u.pathname === "/trade") {
        const o = await outage(raydium.tradeMode || raydium.mode, init); if (o) return o;
        if (p !== pool) return json({ id: "x", success: true, data: { rows: [] } });
        return json({ id: "x", success: true, data: { rows: (raydium.trades || []).slice(0, limit).map((r) => ({ ...r, poolId: p })), nextPageKey: "abc" } });
      }
    }
    if (u.host === "api.dexscreener.com") {
      const mints = u.pathname.split("/").pop().split(",");
      const pairs = mints.flatMap((m) => dex[m] || []);
      return json({ schemaVersion: "1.0.0", pairs: pairs.length ? pairs : null });
    }
    if (String(url).startsWith("https://api.mainnet-beta.solana.com") || u.host.includes("rpc")) {
      const body = JSON.parse(init.body);
      const one = Array.isArray(body) ? null : body;
      if (one && one.method === "getMultipleAccounts" && one.params[1]?.encoding === "base64" && !one.params[1]?.dataSlice) {
        const o = await outage(opts.rpcMode, init); if (o) return o;
        return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 453948825 }, value: one.params[0].map((a) => pools[a] ?? null) } });
      }
      return rpc(url, init);
    }
    return new Response("blocked by the test", { status: 599 });
  };
  const hosts = () => [...new Set(log.map((x) => x.host))];
  return { fetchImpl, log, pool, jup, tokens, raydium, pools, hosts, count: (h) => log.filter((x) => x.host.includes(h)).length, urls: (h) => log.filter((x) => x.host.includes(h)).map((x) => x.url) };
}
