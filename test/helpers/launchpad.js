// Helpers for the Launchpad v2 tests (LAUNCHPAD_V2=on): a world with the switch on, coins seeded straight into city_coins in
// each of the three states, founder seats, a DexScreener stand-in that remembers every URL it was asked, a chain that fails
// for one mint, and a stand-in for the edge cache. Everything else (people, browsers, the clock) is test/helpers/world.js.
import { chain, clock, newWorld } from "./world.js";
import { base58Encode } from "../../src/solana.js";
import { ensureSchema } from "../../src/store.js";

export const LP = (extra = {}) => newWorld({ LAUNCHPAD_V2: "on", ...extra });

export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const RAY = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
export const CITY_COIN = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const PENDING = "PendMint1111111111111111111111111111111111111";

/** A different, valid-looking mint address for each number (32 bytes, base58). */
export const mintNo = (i) => base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j * 13 + 1) & 255));

const at = () => new Date(clock.now).toISOString();

/**
 * A coin row as the founder's design and the admin's decision would leave it: `mint` = launched, `pending` = waiting for the
 * admin's check, neither = designed. `user` is the designer's user id (0 = nobody in particular).
 */
export async function seedCoin(db, { city, name, country = "US", coin = name, pitch = "", pair = "SOL", color = "gold", media = null,
  mint = null, pending = null, launchedAt = null, updatedAt = at(), user = 0, seat = 0 }) {
  await ensureSchema(db);
  await db.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, media_id, mint, pending_mint, pending_at,
      launched_at, launched_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(String(city), name, country, seat, user, coin, pitch || null, pair, color, media, mint, pending, pending ? updatedAt : null,
      mint ? launchedAt || updatedAt : null, mint ? 1 : null, updatedAt, updatedAt).run();
}

/** A live founder seat for a person (made directly: the Launchpad only reads seats). Returns the seat id. */
export async function seedSeat(env, p, { city, name, country = "US", status = "active", handle = null } = {}) {
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(p.w.address).first();
  if (handle) await env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(handle, u.id).run();
  const r = await env.DB.prepare(`INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at)
      VALUES (?, ?, ?, ?, ?, 5, 180000, ?, ?, ?)`).bind(String(city), name, country, u.id, u.wallet, status, at(), status === "active" ? at() : null).run();
  return r.meta.last_row_id;
}

/** One DexScreener pair as the real API shapes it (see the comment in src/market.js), with overrides. */
export function pairFor(mint, over = {}) {
  return {
    chainId: "solana", dexId: "raydium", url: `https://dexscreener.com/solana/${mint.toLowerCase()}`, pairAddress: mintNo(999),
    baseToken: { address: mint, name: "A coin", symbol: "COIN" }, quoteToken: { address: SOL, name: "Wrapped SOL", symbol: "SOL" },
    priceNative: "0.00001", priceUsd: "0.0012", txns: { h24: { buys: 10, sells: 4 } }, volume: { h24: 12345.6, h6: 1, h1: 0, m5: 0 },
    priceChange: { h24: 12.5, h6: 1, h1: 0, m5: 0 }, liquidity: { usd: 45000, base: 1, quote: 2 }, marketCap: 1200000, fdv: 1200000,
    pairCreatedAt: 1760000000000, info: { imageUrl: "https://x.example/a.png" }, labels: [],
    ...over,
  };
}

/**
 * A DexScreener stand-in. `table` maps a mint to its pairs (a mint not in it has none). The answer holds at most 30 pairs like
 * the real API. `status` answers an HTTP error; `fail` makes the call throw (a network error); `hang` never answers until the
 * caller's signal aborts. Everything else (the RPC) goes to the test chain. `seen` is every DexScreener URL asked, in order.
 */
export function dexMock(table = {}, { status = 200, fail = false, hang = false, cap = 30 } = {}) {
  const seen = [], rpc = chain();
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.dexscreener.com/latest/dex/tokens/")) return rpc(url, init);
    seen.push(u);
    if (fail) throw new TypeError("fetch failed");
    if (hang) return new Promise((_, reject) => { // answers only when the caller gives up (a timer keeps the test process alive until then)
      const keep = setTimeout(() => reject(new Error("the caller never gave up")), 20_000);
      init.signal?.addEventListener("abort", () => { clearTimeout(keep); reject(new DOMException("timed out", "TimeoutError")); });
    });
    if (status !== 200) return new Response("oops", { status });
    const mints = u.slice("https://api.dexscreener.com/latest/dex/tokens/".length).split(",");
    const pairs = mints.flatMap((m) => table[m] || []).slice(0, cap);
    return new Response(JSON.stringify({ schemaVersion: "1.0.0", pairs }), { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, seen, mints: () => seen.map((u) => u.slice("https://api.dexscreener.com/latest/dex/tokens/".length).split(",")) };
}

/** The test chain, but the mint account of `badMint` cannot be read (HTTP 500), like a flaky RPC for one coin. Counts every call. */
export function chainFailingFor(badMint) {
  const rpc = chain(), calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const first = Array.isArray(body) ? body[0] : body;
    calls.push(first.method);
    if (first.method === "getAccountInfo" && first.params[0] === badMint) return new Response("busy", { status: 500 });
    return rpc(url, init);
  };
  return { fetchImpl, calls };
}

/**
 * A stand-in for Cloudflare's edge cache (caches.default), keyed by URL, honouring the stored max-age against the test clock.
 * install() sets the global; uninstall() removes it. `store` is what was put.
 */
export function fakeCaches() {
  const store = new Map();
  const cache = {
    async match(req) {
      const hit = store.get(req.url);
      if (!hit) return undefined;
      if (clock.now >= hit.until) { store.delete(req.url); return undefined; }
      return hit.res.clone();
    },
    async put(req, res) {
      const age = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1] || 0);
      store.set(req.url, { res, until: clock.now + age * 1000, maxAge: age });
    },
  };
  return {
    store,
    install: () => { globalThis.caches = { default: cache }; },
    uninstall: () => { delete globalThis.caches; },
  };
}
