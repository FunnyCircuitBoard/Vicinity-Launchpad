/**
 * City coin tickers. public/data/tickers.json (built by scripts/cities/tickers.mjs) is the ONE list, used by the
 * map, the dashboard and this server, so a city's ticker is the same everywhere.
 *
 * Once a city's coin is launched, the chain is the truth: the program copies the approved symbol into the coin's Metaplex
 * metadata, and src/lpcoins.js records it in lp_coins.symbol. displayTicker() is what every page-facing reader uses: the
 * recorded chain symbol when there is one, else the list's ticker. Nobody else makes a ticker up (not from a city name, not
 * from a request body).
 */
let cache = null;
let warned = new Set(); // "cityId:chain:registry" pairs already logged by this server
let noTable = new WeakMap(); // db -> until when lp_coins is known to be missing (the gate was never on): asked again a minute later
const NO_TABLE_MS = 60_000;

async function table(env) {
  if (cache) return cache;
  const res = await env.ASSETS.fetch(new Request("https://assets.local/data/tickers.json"));
  if (!res.ok) throw new Error("tickers_unavailable"); // a failed read is never kept: the next call asks again
  cache = await res.json();
  return cache;
}
export const _resetTickers = () => { cache = null; byTicker = null; warned = new Set(); noTable = new WeakMap(); };
/** lp_coins exists now (src/lpcoins.js just made it): forget that it was missing, so the next reader asks it at once. */
export const lpCoinsTableReady = (db) => { if (db) noTable.delete(db); };

/**
 * true when the city list can be read right now. tickerOf() answers null both for a city that is not in the list and for a list that
 * could not be read; a caller that must tell the two apart (the design gate) asks this first.
 */
export async function tickersAvailable(env) {
  try { await table(env); return true; } catch { return false; }
}

/** { ticker, base, shared } for a community, or null when it isn't in the list. */
export async function tickerOf(env, cityId) {
  try {
    const v = (await table(env))[String(cityId)];
    if (!v) return null;
    return typeof v === "string" ? { ticker: v, base: v, shared: 1 } : { ticker: v[0], base: v[1], shared: v[2] };
  } catch { return null; }
}

let byTicker = null; // ticker -> city id, built once from the same table (only by the change-request checks, src/coinreview.js)
/** The city the list gives `ticker` to (its own ticker, not a shared base), or null; null too when the list cannot be read. */
export async function cityOfTicker(env, ticker) {
  try {
    const t = await table(env);
    if (!byTicker || byTicker.table !== t) {
      const map = new Map();
      for (const [id, v] of Object.entries(t)) map.set(typeof v === "string" ? v : v[0], id);
      byTicker = { table: t, map };
    }
    return byTicker.map.get(String(ticker)) || null;
  } catch { return null; }
}

const symbolOf = (row) => (row && typeof row.symbol === "string" && row.symbol ? row.symbol : null);
const missingTable = (e) => /no such table/i.test(String((e && e.message) || e));
const tableMissing = (db) => (noTable.get(db) || 0) > Date.now();
const lookupFailed = (db, e, what) => { if (missingTable(e)) noTable.set(db, Date.now() + NO_TABLE_MS); else console.error(what, String((e && e.message) || e).slice(0, 80)); };

/**
 * The symbol the chain gave a launched city coin (lp_coins.symbol, read from its Metaplex metadata when the launch was recorded),
 * by mint, else by the city whose recorded coin it is. null when unknown, when the table does not exist, or on any error.
 */
export async function chainSymbolOf(env, { cityId = null, mint = null } = {}) {
  if (!env || !env.DB || tableMissing(env.DB)) return null;
  try {
    if (typeof mint === "string" && mint) return symbolOf(await env.DB.prepare("SELECT symbol FROM lp_coins WHERE mint = ?").bind(mint).first());
    if (cityId == null || cityId === "") return null;
    return symbolOf(await env.DB.prepare("SELECT lc.symbol FROM lp_coins lc JOIN city_coins cc ON cc.mint = lc.mint WHERE cc.city_id = ?").bind(String(cityId)).first());
  } catch (e) { lookupFailed(env.DB, e, "chain symbol lookup failed"); return null; }
}

/** The chain symbols of many mints in one query per 50: Map(mint -> symbol). Empty when the table does not exist. */
export async function chainSymbolsOf(env, mints) {
  const out = new Map();
  const list = [...new Set((mints || []).filter((m) => typeof m === "string" && m))];
  if (!env || !env.DB || tableMissing(env.DB) || !list.length) return out;
  try {
    for (let i = 0; i < list.length; i += 50) {
      const part = list.slice(i, i + 50);
      const rows = (await env.DB.prepare(`SELECT mint, symbol FROM lp_coins WHERE mint IN (${part.map(() => "?").join(", ")})`).bind(...part).all()).results;
      for (const r of rows) { const s = symbolOf(r); if (s) out.set(r.mint, s); }
    }
  } catch (e) { lookupFailed(env.DB, e, "chain symbols lookup failed"); }
  return out;
}

/**
 * The ticker a page shows for a city's coin: { ticker, source: "chain" | "registry" }, or null when the city has neither.
 *   chainSymbol   the recorded on-chain symbol when the caller has it (null: known to have none); left out, it is looked up
 *                 (by `mint` when given, else by the city's recorded coin).
 * When the chain's symbol and the list's ticker are both known and differ, the chain's is shown and one warning names the city,
 * the chain's symbol and the list's (once per server).
 */
export async function displayTicker(env, { cityId, mint = null, chainSymbol } = {}) {
  const reg = cityId == null || cityId === "" ? null : await tickerOf(env, cityId);
  const chain = chainSymbol === undefined ? await chainSymbolOf(env, { cityId, mint }) : typeof chainSymbol === "string" && chainSymbol ? chainSymbol : null;
  if (chain && reg && chain !== reg.ticker) {
    const key = `${cityId}:${chain}:${reg.ticker}`;
    if (!warned.has(key)) { warned.add(key); console.warn(`city coin ticker: city ${cityId} is ${chain} on chain and ${reg.ticker} in the list; the chain's is shown`); }
  }
  if (chain) return { ticker: chain, source: "chain" };
  return reg ? { ticker: reg.ticker, source: "registry" } : null;
}
