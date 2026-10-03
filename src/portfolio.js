/**
 * The portfolio: what a wallet holds of $VICINITY and of the launched city coins, with live US-dollar values.
 * Nothing else is ever looked up or shown: a wallet can hold hundreds of other tokens, and only the allow-list
 * (mintsFor) is asked about. The blockchain is asked one mint at a time (getTokenAccountsByOwner with the {mint} filter),
 * never "everything this wallet owns".
 *
 *   portfolioOf(env, wallet)   the portfolio object below, or null when the balances cannot be read right now. Never throws.
 *   handlePortfolio(...)       GET /api/me/portfolio → { ok: true, portfolio } for the signed-in member
 *   mintsFor(env)              the allow-list: the live $VICINITY mint, then every launched city coin
 *
 * portfolio = {
 *   asOf: ISO time of the data (the older of: when the balances were read, when the oldest price was fetched),
 *   totalUsd: number | null,   sum of the priced items; 0 when nothing is held; null when something is held but nothing has a price
 *   items: [{ kind: "vicinity" | "city", mint, symbol, name, city?: { id, name, country }, amount,
 *             priceUsd: number | null, valueUsd: number | null, sharePct: number | null }],
 *   pricesComplete: boolean    every item has a price (true when there are no items)
 * }
 * Only mints with a balance above zero are items. symbol is the bare ticker ("VICINITY", "UTICA"): the page adds the $.
 * An item without a price stays in the list with its amount; its value and share are null. When some items have no price,
 * totalUsd is the sum of the priced ones (pricesComplete says it is partial) and sharePct is the share of that sum.
 * Order: priced items by value (biggest first), then items without a price by amount; a tie goes to the symbol.
 * valueUsd and totalUsd are rounded to 6 decimals, sharePct to 4.
 * EMPTY portfolio (before launch, no city coins yet, or a wallet holding none of them):
 *   { asOf, totalUsd: 0, items: [], pricesComplete: true }   (before launch and with no coins: no blockchain call at all)
 *
 * Caches (in this server only, per env, each at most 300 entries, expired ones swept out, the oldest dropped when full):
 * a wallet's portfolio 20 s, a mint's price 20 s, the allow-list 20 s. Identical requests that arrive together share ONE
 * lookup. A failure is remembered only briefly (balances 3 s, prices 5 s), so a recovering service is asked again soon but
 * a failing one is not hammered by every dashboard.
 */
import { json } from "./http.js";
import { access } from "./access.js";
import { activeMint } from "./official.js";
import { ensureSchema } from "./store.js";
import { tickerOf } from "./tickers.js";
import { PAIRS, jupiterPrices, launchedCoins } from "./coins.js";
import { getMintBalances } from "./chain.js";
import { isSolanaAddress } from "./solana.js";

export const WALLET_TTL = 20_000, PRICE_TTL = 20_000, MINTS_TTL = 20_000;
export const WALLET_FAIL_TTL = 3_000, PRICE_FAIL_TTL = 5_000;
export const MAX_ENTRIES = 300;
/** More launched city coins than this are not shown (each costs one blockchain call per wallet per 20 s). */
export const MAX_CITY_COINS = 300;
const PRICE_CHUNK = 50; // Jupiter's limit for one price call
const SWEEP_EVERY = 5_000;

/** A bounded Map of values that expire. Expired entries go when seen and are swept on writes; when full the oldest go first. */
class Cache {
  constructor(max) { this.max = max; this.map = new Map(); this.swept = 0; }
  get size() { return this.map.size; }
  get(key, now) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= now) { this.map.delete(key); return undefined; }
    return e;
  }
  set(key, value, ttl, now) {
    if (this.map.size >= this.max || (this.map.size && now - this.swept >= SWEEP_EVERY)) this.sweep(now);
    this.map.delete(key); // a rewrite counts as the newest
    while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: now + ttl, at: now });
  }
  sweep(now) {
    for (const [k, e] of this.map) if (e.exp <= now) this.map.delete(k);
    this.swept = now;
  }
}

// One set of caches per env object (like the salt key in src/limits.js): a server has one env, and tests get a clean slate with each world.
let states = new WeakMap();
const NO_ENV = {};
function stateOf(env) {
  const key = env || NO_ENV;
  let s = states.get(key);
  if (!s) {
    s = { wallets: new Cache(MAX_ENTRIES), prices: new Cache(MAX_ENTRIES), walletFlights: new Map(), priceFlights: new Map(), mints: null, mintsFlight: null, lastKey: null, sig: 0 };
    states.set(key, s);
  }
  return s;
}
export const _resetPortfolio = () => { states = new WeakMap(); };
/** For tests: how many entries the caches hold right now. */
export const _cacheSizes = (env) => { const s = stateOf(env); return { wallets: s.wallets.size, prices: s.prices.size, walletFlights: s.walletFlights.size, priceFlights: s.priceFlights.size }; };

const round = (v, digits) => { const k = 10 ** digits; return Math.round(v * k) / k; };
const emptyPortfolio = (now) => ({ asOf: new Date(now).toISOString(), totalUsd: 0, items: [], pricesComplete: true });
const copy = (p) => (p ? { ...p, items: p.items.map((i) => ({ ...i, ...(i.city ? { city: { ...i.city } } : {}) })) } : p);
const fallbackSymbol = (name) => String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "COIN";

/** The allow-list with the signature of its mint set (the wallet cache key carries it, so a newly launched coin is never hidden by an old entry). */
async function loadMints(env, now) {
  const s = stateOf(env);
  if (s.mints && s.mints.exp > now) return s.mints;
  if (s.mintsFlight) return s.mintsFlight;
  const flight = (async () => {
    const list = [];
    const seen = new Set(Object.values(PAIRS).map((p) => p.mint)); // SOL, USDC and RAY are never a city coin, whatever the table says
    const live = activeMint(env);
    if (live && isSolanaAddress(live) && !seen.has(live)) {
      seen.add(live);
      list.push({ kind: "vicinity", mint: live, symbol: "VICINITY", name: "Vicinity" });
    }
    if (env && env.DB) {
      await ensureSchema(env.DB);
      for (const c of await launchedCoins(env.DB, MAX_CITY_COINS)) {
        if (!isSolanaAddress(c.mint) || seen.has(c.mint)) continue;
        seen.add(c.mint);
        const t = await tickerOf(env, c.city_id);
        list.push({ kind: "city", mint: c.mint, symbol: (t && t.ticker) || fallbackSymbol(c.city_name), name: c.name, city: { id: c.city_id, name: c.city_name, country: c.country } });
      }
    }
    const key = list.map((m) => m.mint).join(",");
    if (key !== s.lastKey) { s.lastKey = key; s.sig++; }
    s.mints = { list, sig: s.sig, exp: now + MINTS_TTL };
    return s.mints;
  })();
  s.mintsFlight = flight;
  const done = () => { if (s.mintsFlight === flight) s.mintsFlight = null; };
  flight.then(done, done);
  return flight;
}

/**
 * The allow-list: the live $VICINITY mint (absent before launch) first, then every launched city coin, each
 * { kind, mint, symbol, name, city? }. Kept 20 s. Throws if the database fails (portfolioOf catches that).
 */
export async function mintsFor(env, { now = Date.now() } = {}) {
  return (await loadMints(env, now)).list.map((m) => ({ ...m, ...(m.city ? { city: { ...m.city } } : {}) }));
}

/**
 * Prices for these mints (all of them already on the allow-list: they come from the wallet's balances of allow-listed
 * mints). Map(mint → { price: number|null, failed: boolean, at }). Cached 20 s (a failed call 5 s), one call per 50 mints,
 * and a mint already being fetched for someone else is waited for instead of asked again.
 */
async function pricesFor(s, mints, fetchImpl, now) {
  const got = new Map();
  const waits = [];
  const need = [];
  for (const mint of mints) {
    const hit = s.prices.get(mint, now);
    if (hit) { got.set(mint, { ...hit.value, at: hit.at }); continue; }
    const flight = s.priceFlights.get(mint);
    if (flight) { waits.push(flight.then((v) => { got.set(mint, v); })); continue; }
    need.push(mint);
  }
  for (let i = 0; i < need.length; i += PRICE_CHUNK) {
    const chunk = need.slice(i, i + PRICE_CHUNK);
    const call = jupiterPrices(chunk, fetchImpl)
      .then((map) => new Map(chunk.map((m) => [m, { price: map.get(m) ?? null, failed: false, at: now }])),
        () => new Map(chunk.map((m) => [m, { price: null, failed: true, at: now }])))
      .then((r) => { // cache first, then let the waiters go: nobody can ask again in the gap
        for (const [m, v] of r) { s.prices.set(m, { price: v.price, failed: v.failed }, v.failed ? PRICE_FAIL_TTL : PRICE_TTL, now); s.priceFlights.delete(m); }
        return r;
      });
    for (const mint of chunk) {
      const p = call.then((r) => r.get(mint));
      s.priceFlights.set(mint, p);
      waits.push(p.then((v) => { got.set(mint, v); }));
    }
  }
  await Promise.all(waits);
  return got;
}

/** Read the balances, price what is held, build the object, cache it. Never rejects. */
async function lookup(env, s, key, wallet, m, fetchImpl, now) {
  let balances;
  try {
    balances = await getMintBalances(env, wallet, m.list.map((x) => x.mint), fetchImpl);
  } catch (e) {
    // what is logged is the short failure name (rpc_http_429 ...), never the wallet
    console.error("portfolio balances failed", String((e && e.message) || e).slice(0, 40));
    s.wallets.set(key, null, WALLET_FAIL_TTL, now);
    return null;
  }
  const held = m.list.filter((x) => balances.get(x.mint) > 0); // zero balances are dropped before anything is priced
  if (!held.length) {
    const empty = emptyPortfolio(now);
    s.wallets.set(key, empty, WALLET_TTL, now);
    return empty;
  }
  const prices = await pricesFor(s, held.map((x) => x.mint), fetchImpl, now);
  const rows = held.map((x) => {
    const amount = balances.get(x.mint), pr = prices.get(x.mint);
    const price = pr && pr.price != null ? pr.price : null;
    return { x, amount, price, value: price == null ? null : amount * price };
  });
  rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount || (a.x.symbol < b.x.symbol ? -1 : a.x.symbol > b.x.symbol ? 1 : 0));
  const priced = rows.filter((r) => r.value != null);
  const total = priced.reduce((t, r) => t + r.value, 0);
  const portfolio = {
    asOf: new Date(Math.min(now, ...priced.map((r) => prices.get(r.x.mint).at))).toISOString(),
    totalUsd: priced.length ? round(total, 6) : null,
    items: rows.map((r) => ({
      kind: r.x.kind, mint: r.x.mint, symbol: r.x.symbol, name: r.x.name, ...(r.x.city ? { city: { ...r.x.city } } : {}),
      amount: r.amount, priceUsd: r.price, valueUsd: r.value == null ? null : round(r.value, 6),
      sharePct: r.value == null || !(total > 0) ? null : round((r.value / total) * 100, 4),
    })),
    pricesComplete: rows.every((r) => r.price != null),
  };
  const retrySoon = held.some((x) => prices.get(x.mint)?.failed);
  s.wallets.set(key, portfolio, retrySoon ? PRICE_FAIL_TTL : WALLET_TTL, now);
  return portfolio;
}

/**
 * The portfolio of a wallet (see the top of this file), or null when the balances cannot be read right now (the RPC failed,
 * or the wallet is not an address). Never throws. Every call returns its own copy: callers may change it freely.
 *   fetchImpl, now   for tests
 */
export async function portfolioOf(env, wallet, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!isSolanaAddress(wallet)) return null;
    const m = await loadMints(env, now);
    if (!m.list.length) return emptyPortfolio(now); // before launch and no city coins: nothing to ask
    const s = stateOf(env);
    const key = `${m.sig}:${wallet}`;
    const hit = s.wallets.get(key, now);
    if (hit) return copy(hit.value);
    let flight = s.walletFlights.get(key);
    if (!flight) {
      flight = lookup(env, s, key, wallet, m, fetchImpl, now).finally(() => s.walletFlights.delete(key));
      s.walletFlights.set(key, flight);
    }
    return copy(await flight);
  } catch (e) {
    console.error("portfolio failed", String((e && e.message) || e).slice(0, 40));
    return null;
  }
}

/**
 * GET /api/me/portfolio → { ok: true, portfolio } for the signed-in member's own wallet.
 * `portfolio` is null when the balances cannot be read right now (answered 200 so the page can say "try again" without an error).
 * Not signed in: 401 { ok: false, error: "sign_in" }. The switch and the route belong to the caller (src/index.js).
 */
export async function handlePortfolio(request, env, fetchImpl = fetch, now = Date.now()) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const a = await access(request, env, now, { write: false });
  if (a.error) return a.error;
  return json({ ok: true, portfolio: await portfolioOf(env, a.u.wallet, { fetchImpl, now }) });
}
