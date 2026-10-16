/**
 * The official list of city coins, read from the chain (only while lpSetup(env).on, src/cluster.js). Made for Jupiter's token tags
 * and for the trackers (mainnet only); the "Official addresses" page (/official) shows it.
 *
 *   GET /official-coins.csv   one mint per line and nothing else (mainnet only: the file cannot say which network it is about)
 *   GET /api/official-coins   { ok, cluster, readAt, program, configs, coins: [{ city, cityId, ticker, mint, pool, config, coinAccount,
 *                             stage }], rule }
 *
 * Who is on it: our launchpad program creates each city coin through Meteora's bonding curve (DBC) with the coin's own Coin record
 * (["coin", city id], owned by our program) as the pool's creator, and checks the pool's creator, config and mint when it launches.
 * A pool's creator alone proves nothing: anyone can open a look-alike pool on our public price-curve setting and then hand its
 * creator role to one of our real Coin records (Meteora's transfer_pool_creator does not ask the new creator to sign), and anyone can
 * make an empty account of their own show our program as its owner. So the list starts from our program's own Coin records, never
 * from pools, reads only the pool each record names, and lists a coin only when ALL of these hold:
 *   * its Coin record is an account of our program at ["coin", its own city id], with the Coin discriminator (src/lpcoins.js
 *     coinRecordsAt: getProgramAccounts, so the program owns it);
 *   * the pool that record names is a Meteora DBC VirtualPool (owned by DBC, its discriminator and size), and that pool's
 *       creator   (byte 104) is that very Coin record,
 *       config    (byte 72)  is the config the record names (its byte 112) and one of LAUNCHPAD_DBC_CONFIGS,
 *       base_mint (byte 136) is the record's mint (its byte 48).
 * On chain only "one of LAUNCHPAD_DBC_CONFIGS" can ever fail. Our launch (solana/programs/vicinity-launchpad/src/instructions/
 * launch.rs:193-201) creates the pool by CPI and refuses unless its creator is the Coin record, its config the record's and its
 * base_mint the record's mint, in the same instruction that writes the record (which is never closed); DBC never closes a pool or
 * changes its config or base_mint; and the Coin record (a PDA of our program) signs only the pool's creation, fee claims,
 * creator_withdraw_surplus and token transfers, never transfer_pool_creator, so its pool's creator stays the record. So a coin is
 * left out (and logged: the reason, its city id and its Coin record, public addresses only) for that one reason alone: its pool's
 * config is not in LAUNCHPAD_DBC_CONFIGS (an operator's change to the settings). Anything else cannot be the chain's answer, and it
 * fails the whole reading (503, nothing kept); it never leaves a coin out:
 *   * a getProgramAccounts row that is not one of our canonical Coin records, or comes twice (the node was asked for our
 *     discriminator, which only our program writes, and only at ["coin", city id]);
 *   * an account entry that is neither null nor a whole account, an answer older than the records' slot or with fewer entries than
 *     asked;
 *   * a pool the node calls absent, owned by another program than DBC, that does not decode as a VirtualPool (whatever its first
 *     bytes: a broken answer, or a new DBC layout, must stop the list and never empty it), or whose creator, config or mint is not
 *     the record's; two records with one mint;
 *   * records older than this server's last whole reading, or without a coin this site has recorded from the chain (lp_coins, for
 *     this cluster and program): a node that lags behind must not drop a coin that was already on the list. (A database that
 *     cannot be read for that check fails the reading too.)
 * The ticker is the coin's own Metaplex symbol on chain and the city name the site's label for that city id; neither decides
 * anything.
 * Nobody types this list: there is no admin route that adds to it.
 *
 * Before anything is read, the node's genesis hash must be the cluster's (src/lpkit.js checkGenesis with `pin`: asked on every
 * reading, nothing remembered is trusted): a devnet node behind a "mainnet" label answers "no Coin record" without an error, and
 * that empty list would look like the truth. Every read of the reading then goes to the node that answered that check, and to it
 * alone (`only`: never a failover to SOLANA_RPC_URL_BACKUP or any other node nobody checked; a refusal is 503). The records are read
 * at the slot of this server's last whole reading or later, and the pools at the records' slot or later (minContextSlot): a node
 * behind refuses, so a coin is never left out only because it was read on an older node.
 *
 * One reading serves both paths: kept 1 minute per server (so the CSV and the JSON asked together share it; a failed reading is never
 * kept), and src/index.js keeps each answer 10 minutes at the edge (under officialCacheKey, which names the configs: a config added
 * to LAUNCHPAD_DBC_CONFIGS is a new list at once) and tells browsers 5. A failed chain read answers 503 and no list at all: never an
 * empty or partial list that would look like the truth.
 */
import { json, SECURITY_HEADERS } from "./http.js";
import { codeOf } from "./sources.js";
import { lpSetup } from "./cluster.js";
import { checkGenesis, lpRoute, readAccounts } from "./lpkit.js";
import { coinRecordsAt, recordedCoins } from "./lpcoins.js";
import { rpcTargets } from "./rpcpool.js";
import { decodeConfig, decodePool } from "./sol/dbc.js";
import { PROGRAM_IDS } from "./sol/pda.js";
import { decodeMetadata, metadataAddress } from "./sol/metaplex.js";
import { iso } from "./policy.js";

export const OFFICIAL_CSV_PATH = "/official-coins.csv";
/** A reading is kept this long per server: only so the CSV and the JSON asked together share one; the edge keeps the answers. */
export const READ_MS = 60_000;
/** The edge keeps an answer this long (seconds); browsers are told BROWSER_SECONDS. */
export const EDGE_SECONDS = 600, BROWSER_SECONDS = 300;
// public facts with nothing personal in them: any site or tool may read them from a browser too (like /coin-meta)
const OPEN = { "Access-Control-Allow-Origin": "*" };

let memo = null; // { key, at, promise }: the last reading, per server
let floor = null; // { key: "<cluster>|<program>", slot }: the records' slot of this server's last whole reading (never shown)
export const _resetOfficialCoins = () => { memo = null; floor = null; };

/** FNV-1a (32 bits) as 8 hex digits: a short, stable name for a list of addresses in a cache key (not a secret, not a check). */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
/**
 * The edge-cache key of one answer (src/index.js cached): the format, the cluster, the program and the configs of
 * LAUNCHPAD_DBC_CONFIGS (hashed), so a config added or removed is a new key at once, never the old list for 10 minutes.
 */
export const officialCacheKey = (s, csv) => `official-coins-${csv ? "csv" : "json"}-${s.cluster}-${s.programId}-${shortHash(s.dbcConfigs.join(","))}`;

/**
 * The one plain sentence on how a coin gets on the list (in the JSON answer, so the rule travels with the list). It starts from the
 * coin record, never from a pool's creator: that alone is what a look-alike can copy.
 */
export const ruleOf = (programId) => `A city coin is listed only if its coin record for that city is owned by the Vicinity launchpad program (${programId}), the record names the coin's mint and its Meteora pool, and that pool's creator is the record, its price-curve setting is one of those listed in configs, and it holds that mint.`;

/** The reading cannot be a true picture of the chain: it fails as a whole (503, nothing kept), it never leaves a coin out. */
const broken = (why) => Object.assign(new Error(why), { code: why });
/**
 * Why a Coin record's pool does not make it official, or null when it does. The ONE reason a coin is left out is "config_not_allowed":
 * its pool's config is not in LAUNCHPAD_DBC_CONFIGS (an operator's change to the settings). The account is null (the node says there
 * is none) or a whole account (src/lpkit.js readAccounts strict). Every other mismatch throws, failing the whole reading, because the
 * chain cannot show it: our launch (solana/programs/vicinity-launchpad/src/instructions/launch.rs:193-201) creates the pool by CPI to
 * DBC and requires creator == the Coin record, config == the record's config and base_mint == the record's mint in the same
 * instruction that writes the record; DBC has no instruction that closes a pool or changes its config or base_mint; and the Coin
 * record never signs transfer_pool_creator. So:
 *   pool_absent              the node says there is no pool;
 *   pool_not_meteora         the account is not DBC's;
 *   pool_undecodable         an account of DBC's that does not decode as a VirtualPool (its discriminator and its one fixed size),
 *                            whatever its first bytes: a broken answer, or a new DBC layout, which must stop the list, never empty it;
 *   creator_not_coin_record, config_mismatch, mint_mismatch   the pool is not the one the record was launched with.
 */
function leftOut(coin, account, allowed) {
  if (account === null) throw broken("pool_absent");
  if (account.owner !== PROGRAM_IDS.dbc) throw broken("pool_not_meteora");
  const pool = decodePool(account);
  if (!pool) throw broken("pool_undecodable");
  if (pool.creator !== coin.address) throw broken("creator_not_coin_record");
  if (pool.config !== coin.dbcConfig) throw broken("config_mismatch");
  if (pool.baseMint !== coin.mint) throw broken("mint_mismatch");
  if (!allowed.has(pool.config)) return "config_not_allowed";
  return null;
}
/**
 * Every coin this site recorded from the chain for this cluster and program (lp_coins, src/lpcoins.js recordLaunchedCoin) must be
 * among the records, with the same Coin record and mint: a Coin record is never closed, so a reading without one comes from a node
 * that lags behind (or a broken answer), and it fails (503) instead of dropping a coin that was listed before. A database that cannot
 * be read fails the reading too: the check could not be made.
 */
async function recordedAreRead(env, records) {
  let recorded;
  try { recorded = await recordedCoins(env); } catch (e) { console.error("official coins: recorded coins not read", codeOf(e)); throw broken("recorded_unreadable"); }
  const byCity = new Map(records.map((c) => [String(c.cityId), c]));
  for (const row of recorded.values()) {
    const c = byCity.get(String(row.city_id));
    if (!c || c.mint !== row.mint || c.address !== row.coin) {
      console.error("official coins: a recorded coin is not in the reading", `city ${row.city_id}`, `coin record ${row.coin}`);
      throw broken("recorded_coin_missing");
    }
  }
}
/** Where the coin stands on its curve: curve | full | graduated (null when its price-curve setting could not be read). */
function stageOf(pool, config) {
  if (pool.isMigrated) return "graduated";
  if (!config) return null;
  return pool.quoteReserve >= config.migrationQuoteThreshold || pool.migrationProgress >= 1 ? "full" : "curve";
}
/** The site's name of each city id (city_coins), for labels only; a database hiccup leaves the names out, never the coins. */
async function cityNames(env, ids) {
  const out = new Map();
  if (!env.DB || !ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const r = await env.DB.prepare(`SELECT city_id, city_name FROM city_coins WHERE city_id IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk).all();
      for (const row of r.results || []) if (typeof row.city_name === "string" && row.city_name) out.set(String(row.city_id), row.city_name);
    }
  } catch (e) { console.error("official coins: city names skipped", codeOf(e)); }
  return out;
}

async function readOfficialCoins(env, s, fetchImpl, now) {
  // the node must be the cluster the settings name (wrong_cluster or rpc_unavailable: 503, nothing kept), asked on every reading
  const g = await checkGenesis(env, fetchImpl, { pin: true });
  if (!g.ok) throw Object.assign(new Error(g.error), { code: g.error });
  // every read on the node whose genesis hash was just checked, and on it alone: no failover to a node nobody checked (a backup
  // whose own genesis probe got no answer is let through by src/rpcpool.js for other reads); a refusal is 503. rpcPost would ask
  // every node for a role it does not know, so the role must be one of this route's
  const route = { ...lpRoute(env), only: g.only };
  if (!g.only || !rpcTargets(env, route).some((t) => t.role === g.only)) throw broken("rpc_unpinned");
  // the records at the slot of this server's last whole reading or later: a node behind it refuses (-32016) or fails the reading
  const recordsKey = `${s.cluster}|${s.programId}`;
  const { slot, records } = await coinRecordsAt(env, s, fetchImpl, { route, minContextSlot: floor && floor.key === recordsKey ? floor.slot : null });
  // two records with one mint: impossible on chain (DBC creates each pool's mint with the pool, and the launch requires the pool's
  // mint to be the record's), so a broken answer, whatever their configs
  if (new Set(records.map((c) => c.mint)).size !== records.length) throw broken("duplicate_mint");
  await recordedAreRead(env, records);
  const allowed = new Set(s.dbcConfigs);
  const metas = await Promise.all(records.map((c) => metadataAddress(c.mint)));
  // strict: every entry is null or a whole account and the answer is at the records' slot or later, else the reading fails
  const accounts = records.length ? await readAccounts(env, [...records.map((c) => c.dbcPool), ...metas, ...s.dbcConfigs], fetchImpl, { route, minContextSlot: slot, strict: true }) : new Map();
  const names = await cityNames(env, [...new Set(records.map((c) => String(c.cityId)))]);
  const coins = [];
  records.forEach((c, i) => {
    if (!accounts.has(c.dbcPool)) throw broken("rpc_bad_answer");
    const acc = accounts.get(c.dbcPool);
    const why = leftOut(c, acc, allowed);
    if (why) { console.error("official coins: left out", why, `city ${c.cityId}`, `coin record ${c.address}`); return; }
    const pool = decodePool(acc), md = decodeMetadata(accounts.get(metas[i]) || null);
    coins.push({
      city: names.get(String(c.cityId)) || null, cityId: String(c.cityId), ticker: md && md.mint === c.mint && md.symbol ? md.symbol : null,
      mint: c.mint, pool: c.dbcPool, config: pool.config, coinAccount: c.address, stage: stageOf(pool, decodeConfig(accounts.get(pool.config) || null)),
    });
  });
  coins.sort((a, b) => (BigInt(a.cityId) < BigInt(b.cityId) ? -1 : BigInt(a.cityId) > BigInt(b.cityId) ? 1 : 0));
  // a whole reading: the next one on this server must be at least as new
  if (!floor || floor.key !== recordsKey || slot > floor.slot) floor = { key: recordsKey, slot };
  return { cluster: s.cluster, readAt: iso(now), program: s.programId, configs: [...s.dbcConfigs], coins, rule: ruleOf(s.programId) };
}

/**
 * The official city coins as the chain says right now (the last reading of this server when it is under a minute old):
 * { cluster, readAt, program, configs, coins, rule }. Throws when the chain could not be read (nothing partial is ever returned).
 */
export function officialCoins(env, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on || !s.configsSet) return Promise.reject(new Error(s.on ? "config_not_set" : "not_enabled"));
  const key = `${s.cluster}|${s.programId}|${s.dbcConfigs.join(",")}`;
  if (!memo || memo.key !== key || now - memo.at >= READ_MS || now < memo.at) {
    const m = { key, at: now, promise: null };
    m.promise = readOfficialCoins(env, s, fetchImpl, now);
    m.promise.catch(() => { if (memo === m) memo = null; });
    memo = m;
  }
  return memo.promise;
}

const failed = (e, csv) => {
  const error = codeOf(e) === "config_not_set" ? "config_not_set" : "rpc_unavailable";
  console.error("official coins: not read", codeOf(e));
  const headers = { ...OPEN, "Cache-Control": "no-store", "Retry-After": "60" };
  // the CSV's failure is plain text, never text/csv: a reader that ignores the status still cannot take it for a (empty) list
  if (csv) return new Response(`${error}: the list could not be read from the chain just now; try again later\n`, { status: 503, headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers } });
  return json({ ok: false, error }, 503, headers);
};

/** GET /api/official-coins (src/index.js has checked the gate, the method and the limit). */
export async function officialCoinsJson(env, fetchImpl = fetch, now = Date.now()) {
  let r;
  try { r = await officialCoins(env, fetchImpl, now); } catch (e) { return failed(e, false); }
  return json({ ok: true, cluster: r.cluster, readAt: r.readAt, program: r.program, configs: r.configs, coins: r.coins, rule: r.rule }, 200, { ...OPEN, "Cache-Control": `public, max-age=${BROWSER_SECONDS}` });
}

/**
 * GET /official-coins.csv: what Jupiter's Token Tag Standard asks for, "a public CSV endpoint with mint addresses (one per row)"
 * (https://developers.jup.ag/docs/tokens, "Token Tags", read 16 Oct 2026; hub.jup.ag/docs/token-api/token-tag-standard redirects
 * there). The page names no header row, no other column and no line ending, so the file is exactly that: one mint per line, each line
 * ending in "\n", no header; an empty body when there is no official coin yet.
 */
export async function officialCoinsCsv(env, fetchImpl = fetch, now = Date.now()) {
  let r;
  try { r = await officialCoins(env, fetchImpl, now); } catch (e) { return failed(e, true); }
  return new Response(r.coins.map((c) => `${c.mint}\n`).join(""), {
    status: 200,
    headers: { ...SECURITY_HEADERS, ...OPEN, "Content-Type": "text/csv; charset=utf-8", "Cache-Control": `public, max-age=${BROWSER_SECONDS}` },
  });
}
