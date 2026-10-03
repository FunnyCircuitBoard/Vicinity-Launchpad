/**
 * The Launchpad list (only while LAUNCHPAD_V2=on, see src/flags.js): one public answer, GET /api/launchpad, with a card for
 * $VICINITY and one for every city coin a founder designed, so the Launchpad page can show Live | New | Upcoming | Trending,
 * search, sort and filter entirely in the browser from this one answer.
 *   Sources   the coin designs (src/coins.js: coinView), the live founder seats (src/seats.js), member and holder counts per
 *             community (counted here for exactly the coins' communities, by the rule of /api/members: communityCounts below),
 *             tickers (src/tickers.js), market data from DexScreener (src/market.js) and holder counts the scheduled job wrote
 *             to coin_stats (refreshCoinStats below).
 *   Privacy   a founder appears as their username (or nothing) and a MASKED wallet, with the same mask as the dashboard; a
 *             contract still waiting for an admin's check is never in the answer (only status "waiting").
 *   Cost      one upstream round at most every 30 seconds per server (an in-memory copy of the answer), and the edge cache
 *             in src/index.js on top, so every viewer in a region shares one round. When DexScreener fails the copy is kept
 *             only 5 seconds and the answer says max-age=5, so the next viewer retries soon.
 *   Honesty   rewardModel is always null: no reward model exists in the data yet (a product decision is pending). The page
 *             shows nothing for it.
 */
import { json } from "./http.js";
import { activeMint, officialFor } from "./official.js";
import { PAIRS, handleCoins, launchedCoins } from "./coins.js";
import { handleSeats } from "./seats.js";
import { latestBalances } from "./ledger.js";
import { tickerOf } from "./tickers.js";
import { ensureLaunchpadSchema } from "./store.js";
import { marketFor } from "./market.js";
import { getAllHolders } from "./chain.js";
import { DAY, iso } from "./policy.js";

const SOL = PAIRS.SOL.mint;
const NEW_DAYS = 7; // "New" = live for less than this (a default, see the product decisions in the report)
const MEMO_MS = 30_000, DEGRADED_MS = 5_000;
let memo = new WeakMap(); // env.DB -> { at, ttl, promise }: one upstream round per server per 30 seconds (5 when something failed)

/** The same mask as the dashboard (public/site.js) and /api/me: the first 5 and the last 3 characters. */
const mask = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);
const shortErr = (e) => String((e && e.message) || e).replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "<address>").slice(0, 80);

/** Where to trade a live coin: the same addresses the dashboard's Buy & swap card and the token page build. */
export function tradeLinks(mint, pairMint) {
  if (!mint) return null;
  const from = !pairMint || pairMint === SOL ? "SOL" : pairMint; // Jupiter writes SOL by name, every other token by its mint
  return {
    raydium: `https://raydium.io/launchpad/token/?mint=${mint}`,
    jupiter: `https://jup.ag/swap/${from}-${mint}`,
    dexscreener: `https://dexscreener.com/solana/${mint}`,
    solscan: `https://solscan.io/token/${mint}`,
  };
}

/** How many wallets hold a coin, by the rule of the token page: every owner except pools and program accounts. */
export const peopleOf = ({ list, labels }) => list.filter(([owner]) => { const l = labels.get(owner); return !l || l.startsWith("Team"); }).length;

/** Country names from the city list (the same file the map uses), read once per server. */
let countryNames = null;
async function countryName(env, cc) {
  if (!countryNames) {
    try {
      const text = await (await env.ASSETS.fetch(new Request("https://assets.local/data/cities.json"))).text();
      const at = text.indexOf('"countries":{');
      const end = at < 0 ? -1 : text.indexOf("}", at);
      countryNames = at >= 0 && end > at ? JSON.parse(text.slice(at + 12, end + 1)) : {};
    } catch { countryNames = {}; }
  }
  return typeof countryNames[cc] === "string" ? countryNames[cc] : cc;
}
export const _resetLaunchpad = () => { countryNames = null; memo = new WeakMap(); };

/** Holder counts the job wrote: Map(mint -> { count, asOf }). Empty, and a note in the log, when the table cannot be made. */
async function holderCounts(env) {
  const out = new Map();
  try {
    await ensureLaunchpadSchema(env.DB);
    for (const r of (await env.DB.prepare("SELECT mint, holders, updated_at FROM coin_stats").all()).results) {
      out.set(r.mint, { count: r.holders == null ? null : Number(r.holders), asOf: r.updated_at });
    }
    return { counts: out, ok: true };
  } catch (e) {
    console.error("coin stats unavailable", shortErr(e));
    return { counts: out, ok: false };
  }
}

/**
 * Member and $VICINITY-holder counts for exactly the coins' communities, by the rule of /api/members (src/me.js: handleMembers):
 * a member is a person who calls the community home (test-lab accounts are not people), a holder is a member whose wallet holds
 * more than 0 in the latest balance sample (0 holders while there is no sample). Counted here rather than read from /api/members,
 * whose list stops at the 300 largest communities: a coin's community can be smaller than that and must still show its count.
 * Map(city id -> { members, holders }); a community nobody calls home has no entry.
 */
async function communityCounts(env, cityIds, now) {
  const out = new Map();
  if (!cityIds.size) return out;
  const placed = (await env.DB.prepare("SELECT wallet, home_city FROM users WHERE home_city IS NOT NULL AND provider != 'testlab'").all()).results;
  let balances = null;
  try { balances = (await latestBalances(env, now))?.balances || null; } catch { balances = null; }
  for (const u of placed) {
    const id = String(u.home_city);
    if (!cityIds.has(id)) continue;
    const c = out.get(id) || { members: 0, holders: 0 };
    c.members++;
    if (balances && (balances[u.wallet] || 0) > 0) c.holders++;
    out.set(id, c);
  }
  return out;
}

/** The whole answer, built from the sources. { body, degraded } (degraded: some source failed, keep it only briefly). */
async function build(env, fetchImpl, now) {
  const official = officialFor(env);
  const vicMint = activeMint(env) || null;
  // one source after the other: some of them run a batch, and batches must not overlap on one database
  const coinsRes = await (await handleCoins(new Request("https://launchpad.internal/api/coins"), env, fetchImpl, now)).json();
  const seatsRes = await (await handleSeats(env, now)).json();
  const stats = await holderCounts(env);
  const seats = new Map(seatsRes.seats.map((s) => [String(s.cityId), s]));
  // the founder's USERNAME only (users.handle): /api/seats falls back to a display name, which would read like a username here
  const handles = new Map();
  try {
    const rows = await env.DB.prepare(`SELECT s.city_id, u.handle FROM seats s JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('provisional', 'active', 'grace', 'steward')`).all();
    for (const r of rows.results) handles.set(String(r.city_id), r.handle || null);
  } catch (e) { console.error("founder handles unavailable", shortErr(e)); }
  const coins = coinsRes.coins || [];
  const members = await communityCounts(env, new Set(coins.map((c) => String(c.city))), now);

  // market data for allow-listed mints only: $VICINITY and the city coins an admin recorded
  const live = coins.filter((c) => c.mint).map((c) => c.mint);
  const market = await marketFor([vicMint, ...live].filter(Boolean), fetchImpl, { now });

  const cards = [];
  for (const c of coins) {
    const seat = seats.get(String(c.city)) || null;
    const founder = seat ? {
      handle: handles.get(String(c.city)) || null, // the username or nothing: never a display name, never a wallet
      wallet: mask(seat.wallet), status: seat.status,
    } : null;
    cards.push({
      kind: "city", status: c.mint ? "live" : c.waiting ? "waiting" : "designed",
      city: { id: String(c.city), name: c.cityName, country: c.country },
      ticker: (await tickerOf(env, c.city))?.ticker || null, name: c.name, pitch: c.pitch || "", color: c.color, logo: c.logo,
      pair: { symbol: c.pair, mint: c.pairMint }, mint: c.mint, launchedAt: c.launchedAt, designedAt: c.updatedAt,
      founder, members: members.get(String(c.city)) || null,
      market: c.mint ? market.markets.get(c.mint) || null : null,
      holders: c.mint ? stats.counts.get(c.mint) || null : null,
      links: tradeLinks(c.mint, c.pairMint), rewardModel: null,
    });
  }
  const vicinity = {
    kind: "vicinity", status: vicMint ? "live" : "upcoming", city: null, ticker: "VICINITY", name: "Vicinity",
    pitch: "One city. One coin. One community.", color: "gold", logo: null, pair: { symbol: "SOL", mint: SOL },
    mint: vicMint, launchedAt: null, designedAt: null, founder: null, members: null,
    market: vicMint ? market.markets.get(vicMint) || null : null, holders: vicMint ? stats.counts.get(vicMint) || null : null,
    links: tradeLinks(vicMint, SOL), rewardModel: null, opensAt: official.launchpadOpensAt,
  };

  const all = [vicinity, ...cards];
  const isNew = (k) => k.status === "live" && k.launchedAt && now - Date.parse(k.launchedAt) < NEW_DAYS * DAY;
  const byCountry = new Map();
  for (const k of cards) byCountry.set(k.city.country, (byCountry.get(k.city.country) || 0) + 1);
  const countries = [];
  for (const [code, count] of [...byCountry].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) countries.push({ code, name: await countryName(env, code), count });

  const body = {
    ok: true, asOf: iso(now), opensAt: official.launchpadOpensAt, open: now >= Date.parse(official.launchpadOpensAt),
    vicinity, coins: cards, countries,
    stats: { live: all.filter((k) => k.status === "live").length, new: all.filter(isNew).length, upcoming: all.filter((k) => k.status !== "live").length },
  };
  return { body, degraded: !market.ok || !stats.ok };
}

/** GET /api/launchpad (public). The route in src/index.js has already checked the switch, the method and the database. */
export async function handleLaunchpad(env, fetchImpl = fetch, now = Date.now()) {
  let m = memo.get(env.DB);
  if (!m || now - m.at >= m.ttl) {
    m = { at: now, ttl: MEMO_MS, promise: null };
    m.promise = build(env, fetchImpl, now).then((r) => { if (r.degraded) m.ttl = DEGRADED_MS; return r; });
    m.promise.catch(() => { if (memo.get(env.DB) === m) memo.delete(env.DB); });
    memo.set(env.DB, m);
  }
  try {
    const { body, degraded } = await m.promise;
    return json(body, 200, { "Cache-Control": `public, max-age=${degraded ? DEGRADED_MS / 1000 : MEMO_MS / 1000}` });
  } catch (e) {
    console.error("launchpad list failed", shortErr(e));
    return json({ ok: false, error: "launchpad_unavailable" }, 503);
  }
}

/**
 * The job's step (only while LAUNCHPAD_V2=on): count the holders of $VICINITY and of every launched city coin, at most `max`
 * coins per run, the ones counted longest ago first, with the same getProgramAccounts read the holder list uses. Each
 * count is one row in coin_stats. A failing coin is skipped and logged as a short code (never an address); the others
 * still run. Zero cost while nothing is launched.
 */
export async function refreshCoinStats(env, now = Date.now(), fetchImpl = fetch, { max = 40 } = {}) {
  const db = env.DB;
  await ensureLaunchpadSchema(db);
  const mints = [...new Set([activeMint(env), ...(await launchedCoins(db, 10_000)).map((c) => c.mint)].filter(Boolean))];
  if (!mints.length) return { counted: 0, failed: 0, left: 0 };
  const last = new Map((await db.prepare("SELECT mint, updated_at FROM coin_stats").all()).results.map((r) => [r.mint, r.updated_at]));
  const due = mints.sort((a, b) => (last.get(a) || "").localeCompare(last.get(b) || "")).slice(0, max);
  let counted = 0, failed = 0;
  for (const mint of due) {
    try {
      const holders = peopleOf(await getAllHolders(env, mint, fetchImpl));
      await db.prepare("INSERT INTO coin_stats (mint, holders, updated_at) VALUES (?, ?, ?) ON CONFLICT(mint) DO UPDATE SET holders = excluded.holders, updated_at = excluded.updated_at")
        .bind(mint, holders, iso(now)).run();
      counted++;
    } catch (e) {
      failed++;
      console.error("coin stats skipped one coin", shortErr(e));
    }
  }
  return { counted, failed, left: mints.length - due.length };
}
