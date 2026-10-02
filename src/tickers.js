/**
 * City coin tickers. public/data/tickers.json (built by scripts/cities/tickers.mjs) is the ONE list, used by the
 * map, the dashboard and this server, so a city's ticker is the same everywhere.
 */
let cache = null;

async function table(env) {
  if (cache) return cache;
  const res = await env.ASSETS.fetch(new Request("https://assets.local/data/tickers.json"));
  cache = res.ok ? await res.json() : {};
  return cache;
}
export const _resetTickers = () => { cache = null; };

/** { ticker, base, shared } for a community, or null when it isn't in the list. */
export async function tickerOf(env, cityId) {
  try {
    const v = (await table(env))[String(cityId)];
    if (!v) return null;
    return typeof v === "string" ? { ticker: v, base: v, shared: 1 } : { ticker: v[0], base: v[1], shared: v[2] };
  } catch { return null; }
}
