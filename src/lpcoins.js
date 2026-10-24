/**
 * City coins launched on our own launchpad, recorded from the CHAIN (only while lpSetup(env).on, src/cluster.js). The chain is the
 * truth and the second check: a coin exists when our program's Coin record (["coin", city id]) exists, so no admin types a mint
 * and needs_second_person does not apply here (the Raydium LaunchLab path in src/coins.js is unchanged for older coins).
 *
 *   recordLaunchedCoin(env, { cityId | mint | coin })   reads the Coin record (and the coin's Metaplex metadata), then, once:
 *       an lp_coins row; city_coins.mint for the city ONLY if it is empty (which locks the design; a different mint already there
 *       is logged as a conflict and nothing changes); a public log line (mod_actions, by the founder's account, "recorded from the
 *       blockchain"); and the /coin-meta JSON (src/coinmeta.js) cached in lp_coins.meta_json. Idempotent.
 *   POST /api/lp/record { cityId }   no login: it reads only the chain (right after a launch confirms, the founder's page calls it)
 *   GET  /api/lp/coin?mint=          { stage: curve|full|graduated, progress toward the target, launchedAt, ... } from the DBC pool
 *   sweepLaunchedCoins (src/jobs.js) every 30 minutes under the job lease: every Coin record of the program, anything new recorded
 *   curveOf(env, row)                the stage and progress of a recorded coin (src/launchpad.js, src/coin.js use it too)
 *
 * lp_coins is created lazily (like coin_stats in src/store.js), only by a call made while the gate is on.
 */
import { json, readJson, sameSite } from "./http.js";
import { base58Encode, isSolanaAddress } from "./solana.js";
import { codeOf } from "./sources.js";
import { lpSetup } from "./cluster.js";
import { lpRpc, wholeAccount } from "./lpkit.js";
import { ensureSchema } from "./store.js";
import { lpCoinsTableReady } from "./tickers.js";
import { publicLimit } from "./guards.js";
import { iso } from "./policy.js";
import { launchpad as launchpadPdas } from "./sol/pda.js";
import { decodeCoin, decodeConfig, decodePool } from "./sol/dbc.js";
import { priceInQuote } from "./sol/quote.js";
import { LAYOUT } from "./sol/layout.js";
import { decodeMetadata, metadataAddress } from "./sol/metaplex.js";
import { metaJsonFor, metadataUriFor } from "./coinmeta.js";
import { bindVersion } from "./coinart-store.js";

export const COIN_SIZE = LAYOUT.Coin.size; // 243
export const COIN_MINT_OFFSET = LAYOUT.Coin.fields.mint.at; // 48
// the Coin discriminator (d7c335eed9c4d533) at byte 0, as getProgramAccounts' memcmp wants it: anyone can make a 243-byte account
// of zeros owned by our program (CreateAccount with our program as the owner); the node then leaves those out of the answer
const COIN_DISCRIMINATOR = base58Encode(Uint8Array.from(LAYOUT.Coin.discriminator));
const QUOTE_DECIMALS = { So11111111111111111111111111111111111111112: 9, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6 };
const QUOTE_SYMBOL = { So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };
export const SWEEP_EVERY_MS = 30 * 60_000;
const SWEEP_MAX = 25;
const NEGATIVE_MS = 5 * 60_000;
const CURVE_MS = 10_000;

/* ---------------------------------------------------------------- the table */
const TABLE = `CREATE TABLE IF NOT EXISTS lp_coins (
  cluster     TEXT NOT NULL,
  program_id  TEXT NOT NULL,
  city_id     TEXT NOT NULL,
  mint        TEXT NOT NULL UNIQUE,
  coin        TEXT NOT NULL,
  founder     TEXT NOT NULL,
  name        TEXT,
  symbol      TEXT,
  quote_mint  TEXT NOT NULL,
  dbc_config  TEXT NOT NULL,
  dbc_pool    TEXT NOT NULL,
  launch_sig  TEXT,
  launched_at TEXT,
  recorded_at TEXT NOT NULL,
  meta_json   TEXT,
  meta_at     TEXT,
  PRIMARY KEY (cluster, program_id, city_id)
)`;
const MIGRATION_ID = "2026-10-10-lp-coins";
const ready = new WeakMap();
/** Create lp_coins the first time it is needed (safe to repeat and to run from two servers); forgets a failure so the next call retries. */
export function ensureLpCoinsSchema(db) {
  if (!ready.has(db)) {
    ready.set(db, (async () => {
      await ensureSchema(db);
      if (await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(MIGRATION_ID).first()) return;
      await db.prepare(TABLE).run();
      lpCoinsTableReady(db);
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(MIGRATION_ID, new Date().toISOString()).run();
    })().catch((e) => { ready.delete(db); throw e; }));
  }
  return ready.get(db);
}
const noTable = new WeakSet(); // databases where lp_coins was missing while the gate was off (per server; a deploy that turns it on starts fresh)
/**
 * The recorded row of a mint, or null. With `create` false (the gate is off) the table is never made: a missing table is "none",
 * and it is remembered for the life of the server, so a /coin-meta request costs no database work at all while the city-coin
 * settings are absent and no coin was ever recorded (lp_coins is only ever created by a call made with the gate on).
 */
export async function recordedByMint(env, mint, { create = true } = {}) {
  if (!env.DB || !isSolanaAddress(mint)) return null;
  if (!create && noTable.has(env.DB)) return null;
  try {
    if (create) await ensureLpCoinsSchema(env.DB);
    return await env.DB.prepare("SELECT * FROM lp_coins WHERE mint = ?").bind(mint).first();
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) { if (!create) noTable.add(env.DB); return null; }
    throw e;
  }
}
/** Recorded rows of the current cluster and program, Map(mint -> row) (the Launchpad list and the coin page). Empty while the gate is off. */
export async function recordedCoins(env) {
  const s = lpSetup(env);
  if (!s.on || !env.DB) return new Map();
  await ensureLpCoinsSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT * FROM lp_coins WHERE cluster = ? AND program_id = ?").bind(s.cluster, s.programId).all()).results;
  return new Map(rows.map((r) => [r.mint, r]));
}

/* ---------------------------------------------------------------- reading the chain */
/** The Coin record of a city: decoded (with its address) or null. */
async function coinOfCity(env, s, cityId, fetchImpl) {
  const address = await launchpadPdas(s.programId).coin(BigInt(cityId));
  const r = await lpRpc(env, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  const c = decodeCoin(r && r.value, s.programId);
  return c ? { ...c, address } : null;
}
/**
 * Every Coin record (with `mint` filtering to one): getProgramAccounts(dataSize 243, memcmp the Coin discriminator at 0[, memcmp mint
 * at 48]); only canonical records (the account at ["coin", its own city id], owned by the program, with the Coin discriminator).
 * Throws on a broken answer.
 */
export async function coinRecords(env, s, fetchImpl, mint = null) {
  return (await readCoinRecords(env, s, fetchImpl, { mint })).records;
}
/**
 * Every Coin record with the slot the node read them at: { slot, records }. The source of the official city-coin list
 * (src/officialcoins.js), which reads the records' pools at that slot or later. `route`: the node to ask (the one whose genesis
 * hash was checked, src/lpkit.js checkGenesis). `minContextSlot`: the slot of an earlier whole reading; a node that has not reached
 * it refuses (Solana's -32016), and an answer older than it fails the reading, so a node that lags behind never drops a coin that
 * was already on the list.
 *
 * STRICT, unlike coinRecords: every row the node returns has already passed dataSize 243 and the Coin discriminator at byte 0, and
 * only our program can write that discriminator into an account it owns, and only at ["coin", that city id] (Anchor's init with
 * those seeds). So a row that is not a whole account of our program, does not decode as a Coin, sits anywhere else, or comes twice
 * can only come from a broken answer: the whole reading fails (rpc_bad_answer), it never quietly loses a coin. (coinRecords' callers,
 * coinByMint and the sweep, still skip such a row: they look coins up one at a time and publish no list.)
 */
export async function coinRecordsAt(env, s, fetchImpl, { route = null, minContextSlot = null } = {}) {
  const min = Number.isSafeInteger(minContextSlot) && minContextSlot > 0 ? minContextSlot : null;
  const r = await readCoinRecords(env, s, fetchImpl, { route, withContext: true, strict: true, minContextSlot: min });
  if (!Number.isSafeInteger(r.slot) || r.slot <= 0 || (min && r.slot < min)) throw new Error("rpc_bad_answer");
  return r;
}
async function readCoinRecords(env, s, fetchImpl, { mint = null, route = null, withContext = false, strict = false, minContextSlot = null } = {}) {
  const filters = [{ dataSize: COIN_SIZE }, { memcmp: { offset: 0, bytes: COIN_DISCRIMINATOR } }, ...(mint ? [{ memcmp: { offset: COIN_MINT_OFFSET, bytes: mint } }] : [])];
  const config = { encoding: "base64", commitment: "confirmed", filters, ...(withContext ? { withContext: true } : {}), ...(minContextSlot ? { minContextSlot } : {}) };
  const list = await lpRpc(env, "getProgramAccounts", [s.programId, config], fetchImpl, route);
  const rows = Array.isArray(list) ? list : list && Array.isArray(list.value) ? list.value : null;
  if (!rows) throw new Error("rpc_bad_answer");
  const slot = !Array.isArray(list) && list.context && Number.isSafeInteger(list.context.slot) ? list.context.slot : null;
  const P = launchpadPdas(s.programId), out = [], seen = new Set();
  // strict: a row that cannot be one of our Coin records fails the reading; otherwise it is skipped
  const skip = () => { if (strict) throw new Error("rpc_bad_answer"); };
  for (const r of rows) {
    if (strict && !(r && typeof r === "object" && isSolanaAddress(r.pubkey) && wholeAccount(r.account) && r.account.owner === s.programId)) skip();
    const c = decodeCoin(r && r.account ? { ...r.account, owner: r.account.owner || s.programId } : null, s.programId);
    if (!c || (mint && c.mint !== mint)) { skip(); continue; }
    if ((await P.coin(c.cityId)) !== r.pubkey) { skip(); continue; } // the canonical ["coin", city id] record, nothing else of that size
    if (seen.has(r.pubkey)) skip();
    seen.add(r.pubkey);
    out.push({ ...c, address: r.pubkey });
  }
  return { slot, records: out };
}
/**
 * The Coin record of a mint from the chain (null when our program has none). A getProgramAccounts is the most expensive call at
 * RPC providers, so a mint is looked up that way only after its Metaplex metadata (one getAccountInfo) points at our own
 * /coin-meta URL, which our program writes for every coin it launches; and a miss is remembered for 5 minutes per server.
 */
export async function coinByMint(env, mint, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on || !isSolanaAddress(mint)) return null;
  if (knownMissing(mint, now)) return null;
  const md = await chainMetadata(env, mint, fetchImpl);
  if (!md || md.uri !== metadataUriFor(mint)) { rememberMissing(mint, now); return null; }
  const c = (await coinRecords(env, s, fetchImpl, mint))[0] || null;
  if (!c) rememberMissing(mint, now);
  return c;
}
/** The coin's Metaplex metadata from the chain: { name, symbol, uri, ... } or null. */
export async function chainMetadata(env, mint, fetchImpl = fetch) {
  const r = await lpRpc(env, "getAccountInfo", [await metadataAddress(mint), { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  const md = decodeMetadata(r && r.value);
  return md && md.mint === mint ? md : null;
}
/**
 * Recorded coins of OTHER cities whose symbol this site does not know (lp_coins.symbol is NULL when the chain's metadata could not be
 * read at record time), on THIS site's launchpad (lpSetup's cluster and program: a row of another network can neither be read through
 * this one's RPC nor launch here): up to 20 are read from the chain now and stored. Returns the city ids still unknown afterwards, ALL
 * of them (read now or not), which the "ticker already launched" checks treat as a possible clash (src/coinready.js, src/lpadmin.js,
 * src/lplaunch.js: COIN_V2_READY) rather than as free.
 */
export async function unknownSymbols(env, exceptCityId, fetchImpl = fetch) {
  const s = lpSetup(env);
  if (!s.on || !env.DB) return [];
  const where = "FROM lp_coins WHERE symbol IS NULL AND city_id <> ? AND cluster = ? AND program_id = ?";
  const args = [String(exceptCityId), s.cluster, s.programId];
  let rows;
  try { rows = (await env.DB.prepare(`SELECT city_id, mint ${where} LIMIT 20`).bind(...args).all()).results; }
  catch (e) { if (/no such table/i.test(String((e && e.message) || e))) return []; throw e; }
  if (!rows.length) return [];
  for (const r of rows) {
    let md = null;
    try { md = await chainMetadata(env, r.mint, fetchImpl); } catch (e) { console.error("lp symbol read failed", codeOf(e)); }
    if (md && md.symbol) await env.DB.prepare("UPDATE lp_coins SET name = COALESCE(name, ?), symbol = COALESCE(symbol, ?) WHERE mint = ?").bind(md.name, md.symbol, r.mint).run();
  }
  // whatever is still unknown, beyond the 20 read now too: never assumed free
  return (await env.DB.prepare(`SELECT city_id ${where}`).bind(...args).all()).results.map((r) => String(r.city_id));
}
/**
 * The launch transaction: the oldest signature of the coin's Metaplex metadata account, which the launch creates and nothing
 * touches afterwards (immutable metadata; not the Coin record: approve_launch already reads that address), when its whole
 * history fits in one page (else null).
 */
async function launchSignature(env, address, fetchImpl) {
  try {
    const list = await lpRpc(env, "getSignaturesForAddress", [address, { limit: 20, commitment: "confirmed" }], fetchImpl);
    if (!Array.isArray(list) || !list.length || list.length >= 20) return null;
    const first = list[list.length - 1];
    return first && typeof first.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(first.signature) ? first.signature : null;
  } catch { return null; }
}

/* ---------------------------------------------------------------- recording */
/**
 * Record one launched coin from the chain. { ok: true, recorded: true|false (already known), row, locked } or
 * { ok: false, error: not_enabled | not_launched | bad_city | rpc_unavailable }.
 */
export async function recordLaunchedCoin(env, { cityId = null, mint = null, coin = null } = {}, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on) return { ok: false, error: "not_enabled" };
  if (!env.DB) return { ok: false, error: "unavailable" };
  let c = coin;
  try {
    if (!c && cityId != null) {
      if (!/^\d{1,20}$/.test(String(cityId)) || BigInt(cityId) >= 1n << 64n) return { ok: false, error: "bad_city" };
      c = await coinOfCity(env, s, cityId, fetchImpl);
    } else if (!c && mint) c = await coinByMint(env, mint, fetchImpl);
  } catch (e) { console.error("lp record read failed", codeOf(e)); return { ok: false, error: "rpc_unavailable" }; }
  if (!c) return { ok: false, error: "not_launched" };
  const db = env.DB;
  await ensureLpCoinsSchema(db);
  const city = String(c.cityId);
  const known = await db.prepare("SELECT * FROM lp_coins WHERE cluster = ? AND program_id = ? AND city_id = ?").bind(s.cluster, s.programId, city).first();
  if (known && known.meta_json) return { ok: true, recorded: false, row: known, locked: null };

  let md = null;
  try { md = await chainMetadata(env, c.mint, fetchImpl); } catch (e) { console.error("lp record metadata read failed", codeOf(e)); }
  let row = known;
  if (!row) {
    const launchedAt = c.launchedAt > 0n ? iso(Number(c.launchedAt) * 1000) : null;
    const sig = await launchSignature(env, await metadataAddress(c.mint), fetchImpl);
    try {
      await db.prepare(`INSERT OR IGNORE INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, launch_sig,
          launched_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(s.cluster, s.programId, city, c.mint, c.address, c.founder, md ? md.name : null, md ? md.symbol : null, c.quoteMint, c.dbcConfig, c.dbcPool, sig, launchedAt, iso(now)).run();
    } catch (e) {
      // UNIQUE(mint): the same mint under another program or cluster (a copied database): logged, nothing overwritten
      console.error("lp record skipped", codeOf(e));
      return { ok: false, error: "conflict" };
    }
    row = await db.prepare("SELECT * FROM lp_coins WHERE cluster = ? AND program_id = ? AND city_id = ?").bind(s.cluster, s.programId, city).first();
    if (!row || row.mint !== c.mint) return { ok: false, error: "conflict" };
  }
  // idempotent: the mint only where it is empty, the log line only when it was set; the design's name and pair become the chain's
  const locked = await lockDesign(env, row, { name: md ? md.name : row.name, quoteMint: c.quoteMint }, now);
  // the metadata JSON is built once, from the chain's name and symbol, and served from here for ever (src/coinmeta.js)
  if (md && md.uri === metadataUriFor(c.mint)) {
    // a coin launched with a ready-made version (src/coinready.js): that version is bound to this mint now, once, so its picture and
    // words stay the coin's for ever (src/coinart-store.js); the JSON below is built from it. A bind that FAILED (a database error, not
    // a "no") decides nothing: no JSON is stored, so the next record (the page, the sweep) or the first /coin-meta read tries again;
    // a JSON stored now would be served for ever without the version's picture
    let decided = true;
    try { await bindVersion(env, { cityId: city, mint: c.mint, name: md.name, symbol: md.symbol }, now); } catch (e) { decided = false; console.error("lp record: version not bound", codeOf(e)); }
    if (decided) {
      try {
        const meta = await metaJsonFor(env, row, md);
        await db.prepare("UPDATE lp_coins SET meta_json = ?, meta_at = ?, name = COALESCE(name, ?), symbol = COALESCE(symbol, ?) WHERE mint = ?").bind(JSON.stringify(meta), iso(now), md.name, md.symbol, c.mint).run();
        row = { ...row, meta_json: JSON.stringify(meta), meta_at: iso(now) };
      } catch (e) { console.error("lp record: metadata JSON not built", codeOf(e)); }
    }
  }
  return { ok: true, recorded: !known, row, locked };
}
/** The design's pair (src/coins.js PAIRS) of a quote mint, or null for a quote the design form does not know. */
const pairOfQuote = (quoteMint) => QUOTE_SYMBOL[quoteMint] ?? null;
/**
 * city_coins.mint for the city, only when it is empty (the design is locked from then on, src/coins.js), and a public log line.
 * The design row's name and pair are set to what the chain says (`chain`: { name: the coin's Metaplex name, quoteMint }), so the
 * site never shows a name or a pair nobody approved (the approval fixes the name on chain; the price curve fixes the pair).
 * true: set now · false: already this mint · "conflict": another mint is recorded there (nothing changes) · null: no design row.
 */
async function lockDesign(env, row, chain, now) {
  const db = env.DB;
  const name = chain && typeof chain.name === "string" && chain.name ? chain.name : null;
  const pair = chain ? pairOfQuote(chain.quoteMint) : null;
  const usable = pair && ["SOL", "USDC"].includes(pair) ? pair : null; // RAY/USDT are not quote mints the design form can name truthfully here
  // a contract still waiting from the old Raydium LaunchLab path is dropped by this update (one city, one coin): the public log line
  // says so WITHOUT its address (nobody ever checked it: it could be a look-alike named after the city, and the site never shows it);
  // the address is kept for the staff only, in admin_audit
  const was = await db.prepare("SELECT pending_mint FROM city_coins WHERE city_id = ? AND mint IS NULL").bind(String(row.city_id)).first().catch(() => null);
  const dropped = was && was.pending_mint ? " A Raydium LaunchLab contract that was still waiting for this city was dropped: one city has one coin." : "";
  let r;
  try {
    r = await db.prepare(`UPDATE city_coins SET mint = ?, pending_mint = NULL, pending_at = NULL, launched_at = ?, launched_by = NULL,
        name = COALESCE(?, name), pair = COALESCE(?, pair) WHERE city_id = ? AND mint IS NULL`)
      .bind(row.mint, row.launched_at || iso(now), name, usable, String(row.city_id)).run();
  } catch (e) { console.error("lp record: city coin not updated", codeOf(e)); return "conflict"; }
  const design = await db.prepare("SELECT city_name, country, user_id, mint FROM city_coins WHERE city_id = ?").bind(String(row.city_id)).first();
  if (!design) { console.error("lp record: no design row for a launched city coin"); return null; }
  if (!r.meta.changes) {
    if (design.mint === row.mint) {
      // recorded before (perhaps before the chain's name could be read): the name and pair follow the chain again
      if (name || usable) await db.prepare("UPDATE city_coins SET name = COALESCE(?, name), pair = COALESCE(?, pair) WHERE city_id = ? AND mint = ?").bind(name, usable, String(row.city_id), row.mint).run();
      return false;
    }
    console.error("lp record conflict: the city already has another mint recorded; nothing changed");
    return "conflict";
  }
  await db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
      VALUES (?, 'founder', 'coin_launched', 'city_coin', NULL, ?, ?, ?, 'launch', ?, ?, 'done')`)
    .bind(design.user_id, design.user_id, design.country, String(row.city_id),
      `${design.city_name}: launched on the Vicinity launchpad (Solana ${row.cluster}), contract ${row.mint}. Recorded from the blockchain; the coin design is locked.${dropped}`, iso(now)).run();
  if (dropped) {
    await db.prepare("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('site', 'coin_contract_dropped', ?, ?, ?)")
      .bind(String(row.city_id), `the waiting Raydium LaunchLab contract ${was.pending_mint} was dropped when ${row.mint} was recorded from the blockchain`, iso(now)).run()
      .catch((e) => console.error("lp record: dropped contract not kept in admin_audit", codeOf(e)));
  }
  return true;
}

/* ---------------------------------------------------------------- the design is frozen from the approval on */
/** How long an approval built by the owner keeps the founder from editing the design (its blockhash is long dead by then). */
export const DESIGN_HOLD_MS = 5 * 60_000;
const holdKey = (cityId) => `lp_design_hold:${String(cityId)}`;
/** The owner just built an approval for this city (src/lpadmin.js approveTx): the design may not change until it lands or dies. */
export async function holdDesign(env, cityId, now = Date.now()) {
  await ensureSchema(env.DB);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(holdKey(cityId), iso(now + DESIGN_HOLD_MS)).run();
}
/**
 * Why a city's coin design may not change now (only while the gate is on): "approved" (the city's Approval record is on chain: its
 * name and ticker are fixed there, and the owner approved the design he saw), "launched" (its Coin record is on chain, perhaps
 * not recorded here yet), "held" (the owner is approving it right now), or null. Throws when the chain cannot be read, so the
 * caller refuses rather than lets an approved design change.
 */
export async function designFrozen(env, cityId, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on || !/^\d{1,19}$/.test(String(cityId)) || BigInt(cityId) <= 0n || BigInt(cityId) >= (1n << 64n) - 1n) return null;
  await ensureSchema(env.DB);
  const h = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(holdKey(cityId)).first();
  if (h && Date.parse(h.value) > now) return "held";
  const P = launchpadPdas(s.programId);
  const [approval, coin] = await Promise.all([P.approval(BigInt(cityId)), P.coin(BigInt(cityId))]);
  const r = await lpRpc(env, "getMultipleAccounts", [[approval, coin], { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }], fetchImpl);
  const v = r && Array.isArray(r.value) && r.value.length === 2 ? r.value : null;
  if (!v) throw new Error("rpc_bad_answer");
  if (v[1] && v[1].owner === s.programId) return "launched";
  if (v[0] && v[0].owner === s.programId) return "approved";
  return null;
}
/**
 * Moderation after a launch (src/coins.js handleTakedown "text"): the founder's description is dropped from the coin's /coin-meta
 * JSON, which is rebuilt from the chain's name and symbol with the default text. The name stays: it is on chain for ever.
 * true when a recorded coin's JSON was rebuilt, false when the mint is not a coin of this launchpad.
 */
export async function rebuildMetaJson(env, mint, now = Date.now()) {
  const row = await recordedByMint(env, mint, { create: false });
  if (!row || !row.name || !row.symbol) return false;
  const meta = await metaJsonFor(env, row, { name: row.name, symbol: row.symbol });
  await env.DB.prepare("UPDATE lp_coins SET meta_json = ?, meta_at = ? WHERE mint = ?").bind(JSON.stringify(meta), iso(now), mint).run();
  return true;
}

/* ---------------------------------------------------------------- the curve */
const curves = new Map(); // dbc pool -> { at, promise of the curve or null }
const negative = new Map(); // mint -> until: a mint our program does not know, asked again after 5 minutes
export const _resetLpCoins = () => { curves.clear(); negative.clear(); };
export const knownMissing = (mint, now = Date.now()) => { const t = negative.get(mint); if (t && t > now) return true; if (t) negative.delete(mint); return false; };
export const rememberMissing = (mint, now = Date.now()) => { negative.set(mint, now + NEGATIVE_MS); if (negative.size > 5000) negative.delete(negative.keys().next().value); };

/**
 * Where recorded coins stand, from their DBC pools and configs (one getMultipleAccounts for up to 50 coins, 10 s per server):
 * Map(mint -> { stage: curve|full|graduated, raised, target, progressPct, priceNative, symbol, quoteMint, pool, config } | null)
 * (raised/target in whole quote tokens, priceNative in the quote token per whole coin; null: the pool is not ours to read).
 * Rows of another cluster or program are not read. Throws on a transport failure.
 */
export async function curvesFor(env, rows, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  const out = new Map();
  const mine = (rows || []).filter((r) => r && s.on && r.cluster === s.cluster && r.program_id === s.programId);
  for (const r of rows || []) if (r && !mine.includes(r)) out.set(r.mint, null);
  const due = mine.filter((r) => { const m = curves.get(r.dbc_pool); return !m || now - m.at > CURVE_MS || now < m.at; });
  for (let i = 0; i < due.length; i += 50) {
    const chunk = due.slice(i, i + 50);
    const p = (async () => {
      const keys = chunk.flatMap((r) => [r.dbc_pool, r.dbc_config]);
      const res = await lpRpc(env, "getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
      const v = res && Array.isArray(res.value) && res.value.length === keys.length ? res.value : null;
      if (!v) throw new Error("rpc_bad_answer");
      return new Map(chunk.map((r, j) => [r.mint, readCurve(r, v[2 * j], v[2 * j + 1])]));
    })();
    for (const r of chunk) {
      const m = { at: now, promise: p.then((map) => map.get(r.mint)) };
      m.promise.catch(() => { if (curves.get(r.dbc_pool) === m) curves.delete(r.dbc_pool); });
      curves.set(r.dbc_pool, m);
    }
    while (curves.size > 2000) curves.delete(curves.keys().next().value);
  }
  for (const r of mine) out.set(r.mint, await curves.get(r.dbc_pool).promise);
  return out;
}
function readCurve(row, poolAcc, configAcc) {
  const pool = decodePool(poolAcc), config = decodeConfig(configAcc);
  if (!pool || !config || pool.baseMint !== row.mint || pool.config !== row.dbc_config) return null;
  const target = config.migrationQuoteThreshold;
  const stage = pool.isMigrated ? "graduated" : pool.quoteReserve >= target || pool.migrationProgress >= 1 ? "full" : "curve";
  const dec = QUOTE_DECIMALS[row.quote_mint];
  const whole = (raw) => (dec == null ? null : Number(raw) / 10 ** dec);
  const pct = target > 0n ? Math.min(100, Number((pool.quoteReserve * 10000n) / target) / 100) : null;
  return {
    stage, raised: whole(pool.quoteReserve), target: whole(target), progressPct: stage === "curve" ? pct : 100,
    priceNative: dec == null ? null : priceInQuote(pool.sqrtPrice, dec), symbol: QUOTE_SYMBOL[row.quote_mint] || null,
    quoteMint: row.quote_mint, pool: row.dbc_pool, config: row.dbc_config,
  };
}
/** One recorded coin's curve (curvesFor of one row): the object, or null. */
export const curveOf = async (env, row, fetchImpl = fetch, now = Date.now()) => (row ? (await curvesFor(env, [row], fetchImpl, now)).get(row.mint) ?? null : null);

/* ---------------------------------------------------------------- the coin lists (src/launchpad.js, src/coin.js) */
export const LP_VENUE = "Vicinity launchpad (Meteora bonding curve)";
export const NO_CHART = "No chart yet for coins on the Vicinity curve";
export const NO_TRADES = "No trade list yet for coins on the Vicinity curve";
const COIN_SUPPLY = Number(LAYOUT.constants.COIN_SUPPLY_RAW) / 10 ** Number(LAYOUT.constants.COIN_DECIMALS);
/**
 * Where a coin trades, for a coin of our launchpad: its own page on this site, Solscan, and only after graduation the open
 * market's pages. Never raydium.io (the coin never was on Raydium LaunchLab).
 */
export function lpLinks(mint, stage) {
  const open = stage === "graduated";
  return { raydium: null, jupiter: open ? `https://jup.ag/tokens/${mint}` : null, dexscreener: open ? `https://dexscreener.com/solana/${mint}` : null,
    solscan: `https://solscan.io/token/${mint}`, here: `/coin?mint=${mint}` };
}
/**
 * Put the truth of our launchpad on a market object of src/marketlive.js (in place): no LaunchLab venue, the stage and the
 * progress toward the target from the DBC pool (market.lpCurve), and on the curve the price, market cap and "in the curve"
 * from the chain × the pair's price (Jupiter) where Jupiter has no price of its own. `curve` null: the pool could not be read.
 */
export function applyLpMarket(m, curve, pairUsd) {
  if (!m) return m;
  m.launchpad = "vicinity";
  m.curve = null; // market.curve is the Raydium LaunchLab curve on every page; ours has its own key
  if (m.url && /raydium\.io/.test(m.url)) m.url = null;
  const say = (v) => (typeof v === "string" ? v.replace(/no LaunchLab curve on the chain/g, "a coin on the Vicinity curve") : v);
  for (const k of Object.keys(m.missing || {})) m.missing[k] = say(m.missing[k]);
  if (!curve) { m.lpCurve = null; m.missing.curve = "The Vicinity curve could not be read just now"; return m; }
  m.stage = curve.stage;
  m.lpCurve = { venue: LP_VENUE, stage: curve.stage, symbol: curve.symbol, raised: curve.raised, target: curve.target, progressPct: curve.progressPct,
    pool: curve.pool, graduatesTo: "a Meteora DAMM v2 pool", source: "Solana blockchain, read by vicinity.city" };
  m.sources.curve = "Solana blockchain, read by vicinity.city";
  if (curve.stage === "curve") {
    m.liquidityKind = "bonding_curve";
    if (curve.priceNative != null) { m.priceNative = curve.priceNative; m.nativeSymbol = curve.symbol; }
    const sym = curve.symbol || "pair";
    if (m.priceUsd == null && pairUsd != null && curve.priceNative != null) {
      m.priceUsd = curve.priceNative * pairUsd; m.sources.price = `On-chain curve × ${sym} price (Jupiter)`; delete m.missing.price;
    }
    if (m.marketCapUsd == null && m.priceUsd != null) { m.marketCapUsd = m.priceUsd * COIN_SUPPLY; m.sources.marketCap = "Price × on-chain supply"; delete m.missing.marketCap; }
    if (pairUsd != null && curve.raised != null) {
      m.liquidityUsd = curve.raised * pairUsd; m.sources.liquidity = `${sym} in the bonding curve (on-chain) × ${sym} price (Jupiter)`; delete m.missing.liquidity;
    }
  }
  return m;
}

/* ---------------------------------------------------------------- the routes (src/index.js has checked the gate) */
const mask = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);
/** The recorded row of a mint, from the database or (once per 5 minutes per unknown mint) the chain, which also records it. */
export async function findCoin(request, env, mint, fetchImpl = fetch, now = Date.now(), limitKind = "lp_coin") {
  const row = await recordedByMint(env, mint, { create: lpSetup(env).on });
  if (row) return { row };
  if (!lpSetup(env).on || knownMissing(mint, now)) return { row: null };
  const slow = await publicLimit(env, request, limitKind);
  if (slow) return { response: slow };
  let c;
  try { c = await coinByMint(env, mint, fetchImpl, now); } catch (e) { console.error("lp coin lookup failed", codeOf(e)); return { error: "rpc_unavailable" }; }
  if (!c) return { row: null };
  const rec = await recordLaunchedCoin(env, { coin: c }, fetchImpl, now);
  return rec.ok ? { row: rec.row } : { error: rec.error };
}

/** GET /api/lp/coin?mint= */
export async function handleLpCoin(request, env, fetchImpl = fetch, now = Date.now()) {
  const mint = new URL(request.url).searchParams.get("mint") || "";
  if (!isSolanaAddress(mint)) return json({ ok: false, error: "bad_mint" }, 400);
  if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
  const f = await findCoin(request, env, mint, fetchImpl, now);
  if (f.response) return f.response;
  if (f.error) return json({ ok: false, error: f.error === "rpc_unavailable" ? "rpc_unavailable" : "unavailable" }, 503);
  if (!f.row) return json({ ok: false, error: "not_found" }, 404, { "Cache-Control": "public, max-age=60" });
  const row = f.row;
  let curve = null, missing = null;
  try { curve = await curveOf(env, row, fetchImpl, now); if (!curve) missing = "The coin's curve could not be read as a Vicinity curve"; }
  catch (e) { console.error("lp coin curve failed", codeOf(e)); missing = "The blockchain could not be read just now"; }
  return json({
    ok: true, mint: row.mint, cityId: String(row.city_id), cluster: row.cluster, coin: row.coin, founder: mask(row.founder), name: row.name, symbol: row.symbol,
    quoteMint: row.quote_mint, pool: row.dbc_pool, config: row.dbc_config, launchedAt: row.launched_at, recordedAt: row.recorded_at, launchSig: row.launch_sig || null,
    stage: curve ? curve.stage : null, progress: curve ? { raised: curve.raised, target: curve.target, pct: curve.progressPct, symbol: curve.symbol } : null,
    ...(missing ? { missing } : {}), asOf: iso(now),
  }, 200, { "Cache-Control": `public, max-age=${curve ? 10 : 5}` });
}

/** POST /api/lp/record { cityId } (no login; it reads only the chain; idempotent). */
export async function handleLpRecord(request, env, fetchImpl = fetch, now = Date.now()) {
  if (!sameSite(request)) return json({ ok: false, error: "bad_origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
  const slow = await publicLimit(env, request, "lp_record");
  if (slow) return slow;
  const body = await readJson(request, 512);
  const cityId = body && (typeof body.cityId === "string" || typeof body.cityId === "number") ? String(body.cityId) : "";
  if (!/^\d{1,20}$/.test(cityId)) return json({ ok: false, error: "bad_city" }, 400);
  const r = await recordLaunchedCoin(env, { cityId }, fetchImpl, now);
  if (!r.ok) return json({ ok: false, error: r.error }, r.error === "not_launched" ? 404 : r.error === "bad_city" ? 400 : r.error === "conflict" ? 409 : 503);
  return json({ ok: true, recorded: r.recorded, cityId: String(r.row.city_id), mint: r.row.mint, cluster: r.row.cluster, launchedAt: r.row.launched_at, coinPage: `/coin?mint=${r.row.mint}` });
}

/**
 * The job's step (src/jobs.js, only while the gate is on): every 30 minutes, every Coin record of the program; the ones not in
 * lp_coins are recorded (at most 25 a run). { found, recorded, left } or { skipped }.
 */
export async function sweepLaunchedCoins(env, now = Date.now(), fetchImpl = fetch) {
  const s = lpSetup(env);
  if (!s.on || !env.DB) return { skipped: "off" };
  const db = env.DB;
  await ensureLpCoinsSchema(db);
  const last = await db.prepare("SELECT value FROM settings WHERE key = 'lp_sweep_at'").first();
  if (last && last.value && now - Date.parse(last.value) < SWEEP_EVERY_MS && Date.parse(last.value) <= now) return { skipped: "not due" };
  await db.prepare("INSERT INTO settings (key, value) VALUES ('lp_sweep_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(iso(now)).run();
  const all = await coinRecords(env, s, fetchImpl);
  const known = new Set((await db.prepare("SELECT city_id FROM lp_coins WHERE cluster = ? AND program_id = ? AND meta_json IS NOT NULL").bind(s.cluster, s.programId).all()).results.map((r) => String(r.city_id)));
  const todo = all.filter((c) => !known.has(String(c.cityId)));
  let recorded = 0, failed = 0;
  for (const c of todo.slice(0, SWEEP_MAX)) {
    const r = await recordLaunchedCoin(env, { coin: c }, fetchImpl, now);
    if (r.ok && r.recorded) recorded++;
    else if (!r.ok) failed++;
  }
  return { found: all.length, recorded, failed, left: Math.max(0, todo.length - SWEEP_MAX) };
}
