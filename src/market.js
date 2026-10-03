/**
 * Market data for the Launchpad list (only while LAUNCHPAD_V2=on): price, market cap, liquidity, 24-hour volume and
 * change per coin, from DexScreener's public API, asked by the Worker (pages may only talk to this site). The caller passes
 * ONLY allow-listed mints ($VICINITY and the city coins an admin recorded): this module trusts its input and sends it on.
 * Nothing that comes back is executed or shown as HTML: every value is checked for type and shape and kept as a plain
 * number or string, and every unknown field is dropped.
 *
 * The answer shape, verified with one real GET on 3 Oct 2026 for the SOL mint (So111...112), HTTP 200:
 *   { schemaVersion: "1.0.0", pairs: [ pair, ... ] }   with AT MOST 30 pairs in the whole answer, however many mints were
 *   asked (one mint gave 30, three mints together also gave exactly 30: 12 + 14 + 4). A pair:
 *   chainId "solana" · dexId "orca" | "raydium" | ... · url "https://dexscreener.com/solana/<pair address, lower case>"
 *   · pairAddress (base58) · baseToken { address, name, symbol } · quoteToken { address, name, symbol }
 *   · priceNative (string) · priceUsd (a STRING, "119.20") · txns { m5, h1, h6, h24: { buys, sells } }
 *   · volume { h24, h6, h1, m5 } (numbers, US dollars) · priceChange { m5, h1, h6, h24 } (numbers, percent)
 *   · liquidity { usd, base, quote } (numbers) · marketCap (number) · fdv (number, MISSING on some pairs)
 *   · pairCreatedAt (ms) · labels (strings) · info { imageUrl, header, openGraph, websites, socials }
 * Mapping used here (per mint, from the pair with the most liquidity.usd, ties by volume.h24):
 *   priceUsd (string -> number) -> priceUsd · marketCap -> marketCapUsd · fdv -> fdvUsd · liquidity.usd -> liquidityUsd
 *   · volume.h24 -> volume24hUsd · priceChange.h24 -> priceChange24hPct · pairAddress -> pairAddress · dexId -> dex · url -> url
 * A pair whose baseToken is not the asked mint (the coin as the quote of another token) is ignored.
 * Rate limit documented by DexScreener: 300 requests a minute. Our use: at most one round every 30 seconds per server
 * (the Launchpad answer is remembered that long), a round being ceil(mints / 30) requests plus a top-up (see below).
 */
import { isSolanaAddress } from "./solana.js";

export const DEX_URL = "https://api.dexscreener.com/latest/dex/tokens/";
export const BATCH = 30; // mints per request (DexScreener's limit)
const PAIR_CAP = 30; // pairs per answer (observed): when hit, mints that got no pair are asked again on their own
const NEGATIVE_MS = 5_000; // after a failed round, answer "no data" from memory this long so viewers do not pile on

const num = (v) => { const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN; return Number.isFinite(n) ? n + 0 : null; }; // + 0: never -0
const positive = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
const nonNegative = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };

/** The one pair that represents a mint: on Solana, with the mint as its base token, the most liquidity (ties: most 24 h volume). */
export function pickPair(pairs, mint) {
  let best = null;
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!p || p.chainId !== "solana" || !p.baseToken || p.baseToken.address !== mint) continue;
    if (!best) { best = p; continue; }
    const [a, b] = [nonNegative(p.liquidity?.usd) || 0, nonNegative(best.liquidity?.usd) || 0];
    if (a > b || (a === b && (nonNegative(p.volume?.h24) || 0) > (nonNegative(best.volume?.h24) || 0))) best = p;
  }
  return best;
}

/** The market fields of one pair, every one of them nullable; strings only where they have a known shape. */
export function marketOf(p, mint) {
  if (!p) return null;
  const pairAddress = isSolanaAddress(p.pairAddress) ? p.pairAddress : null;
  const dex = typeof p.dexId === "string" && /^[a-z0-9-]{1,40}$/.test(p.dexId) ? p.dexId : null;
  const url = typeof p.url === "string" && /^https:\/\/dexscreener\.com\/solana\/[A-Za-z0-9]{1,64}$/.test(p.url) ? p.url : `https://dexscreener.com/solana/${mint}`;
  return {
    priceUsd: positive(p.priceUsd), marketCapUsd: positive(p.marketCap), fdvUsd: positive(p.fdv),
    liquidityUsd: nonNegative(p.liquidity?.usd), volume24hUsd: nonNegative(p.volume?.h24), priceChange24hPct: num(p.priceChange?.h24),
    pairAddress, dex, url,
  };
}

/**
 * One GET for up to 30 mints: the pairs list. Throws on an HTTP error, a bad body, or a network error after one retry.
 * `pairs: null` is DexScreener's normal answer for tokens that have no pair yet (seen for $VICINITY on 3 Oct 2026, HTTP 200
 * {"schemaVersion":"1.0.0","pairs":null}): an empty list, not an outage.
 */
async function fetchPairs(mints, fetchImpl, timeoutMs) {
  const once = () => fetchImpl(DEX_URL + mints.join(","), { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  let res;
  try { res = await once(); }
  catch { res = await once(); } // a network error or a timeout: one retry, then give up
  if (!res.ok) throw new Error(`dex_http_${res.status}`);
  const body = await res.json();
  const pairs = body && body.pairs === null ? [] : body?.pairs;
  if (!Array.isArray(pairs)) throw new Error("dex_bad_answer");
  return pairs;
}

let failedUntil = 0;
export const _resetMarket = () => { failedUntil = 0; };

/**
 * Market data for allow-listed mints: { markets: Map(mint -> market | null), ok }. ok is false when DexScreener could not be
 * asked (every mint is then null and, for the next 5 seconds, no call is made at all). Never throws.
 */
export async function marketFor(mints, fetchImpl = fetch, { now = Date.now(), timeoutMs = 4_000 } = {}) {
  const list = [...new Set(mints.filter(isSolanaAddress))];
  const markets = new Map(list.map((m) => [m, null]));
  if (!list.length) return { markets, ok: true };
  if (now < failedUntil) return { markets, ok: false };
  try {
    for (let i = 0; i < list.length; i += BATCH) {
      let batch = list.slice(i, i + BATCH);
      // when the answer is full (30 pairs) a mint may have been crowded out: ask the missing ones again, at most twice more
      for (let round = 0; batch.length && round < 3; round++) {
        const pairs = await fetchPairs(batch, fetchImpl, timeoutMs);
        const missing = [];
        for (const m of batch) {
          const p = pickPair(pairs, m);
          if (p) markets.set(m, marketOf(p, m));
          else missing.push(m);
        }
        batch = pairs.length >= PAIR_CAP && missing.length < batch.length ? missing : [];
      }
    }
    return { markets, ok: true };
  } catch (e) {
    console.error("market data unavailable", String((e && e.message) || e).slice(0, 60));
    failedUntil = now + NEGATIVE_MS;
    return { markets: new Map(list.map((m) => [m, null])), ok: false };
  }
}
