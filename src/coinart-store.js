/**
 * Where city-coin pictures and coin versions are kept (COIN_V2_READY, src/coinready.js), and the readers that must keep working
 * WHATEVER ANY SWITCH SAYS: a coin's metadata points at its picture for ever, so once a picture or a version is recorded, it is served
 * from here even with COIN_V2_READY off and the launchpad settings gone (src/coinmeta.js). The tables are made only by a route of the
 * switch (ensureReadySchema); every reader here treats a missing table as "nothing recorded" and never creates one, so with the
 * switch never turned on the database is exactly as it was.
 *
 *   coin_art             every picture made: the PNG bytes, named by their SHA-256, made once per (SVG SHA-256, template version)
 *   coin_versions        immutable coin versions: the canonical content (src/coinready.js canonicalContent) and its SHA-256
 *   coin_ready           the version a city's founder chose with "Use this coin": what the admin approves and what launches.
 *                        design_at is city_coins.updated_at written in the same batch, so any later change of the design row makes
 *                        the choice stale; mint is set once the coin launched with it (then nothing can unbind it)
 *   coin_legacy_designs  a founder's earlier studio design, copied here (the whole row) before "Use this coin" replaced it
 */
import { iso } from "./policy.js";
import { ensureSchema } from "./store.js";
import { sha256Hex } from "./coinart.js";

export const READY_MIGRATION = {
  id: "2026-10-18-coin-ready",
  tables: [
    `CREATE TABLE IF NOT EXISTS coin_art (
  sha256           TEXT PRIMARY KEY,
  svg_sha256       TEXT NOT NULL,
  template_version TEXT NOT NULL,
  type             TEXT NOT NULL,
  bytes            BLOB NOT NULL,
  created_at       TEXT NOT NULL
)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS coin_art_svg ON coin_art (svg_sha256, template_version)",
    `CREATE TABLE IF NOT EXISTS coin_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id          TEXT NOT NULL,
  origin           TEXT NOT NULL,
  content_json     TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  name             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  description      TEXT NOT NULL,
  art_sha256       TEXT NOT NULL,
  template_version TEXT NOT NULL,
  created_by       INTEGER,
  created_at       TEXT NOT NULL,
  UNIQUE (city_id, content_hash)
)`,
    `CREATE TABLE IF NOT EXISTS coin_ready (
  city_id      TEXT PRIMARY KEY,
  version_id   INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  symbol       TEXT NOT NULL UNIQUE,
  design_at    TEXT NOT NULL,
  seat_id      INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  chosen_at    TEXT NOT NULL,
  mint         TEXT UNIQUE,
  bound_at     TEXT
)`,
    `CREATE TABLE IF NOT EXISTS coin_legacy_designs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id     TEXT NOT NULL,
  design_json TEXT NOT NULL,
  copied_at   TEXT NOT NULL,
  copied_by   INTEGER
)`,
  ],
};
const ready = new WeakMap();
/** Make the four tables (only from a COIN_V2_READY route). Additive, safe to repeat and to run from two servers; a failure is forgotten. */
export function ensureReadySchema(db) {
  if (!ready.has(db)) {
    ready.set(db, (async () => {
      await ensureSchema(db); // schema_migrations and city_coins exist (the normal migrations)
      if (await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(READY_MIGRATION.id).first()) return;
      await db.batch(READY_MIGRATION.tables.map((t) => db.prepare(t)));
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(READY_MIGRATION.id, new Date().toISOString()).run();
      missing.delete(db);
    })().catch((e) => { ready.delete(db); throw e; }));
  }
  return ready.get(db);
}

// A database where the tables were missing (the switch was never on): asked again a minute later, so a request for a picture that
// cannot exist costs no database work in between.
const missing = new WeakMap();
const MISSING_MS = 60_000;
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
/** Run a read; a missing table is null (remembered a minute per database), any other failure throws. */
async function read(db, run, now = Date.now()) {
  if (!db) return null;
  const until = missing.get(db);
  if (until && until > now) return null;
  try { return await run(); } catch (e) { if (noTable(e)) { missing.set(db, now + MISSING_MS); return null; } throw e; }
}

/** The art row named by its PNG SHA-256 (with the bytes), or null. */
export const artBySha = (db, sha) => read(db, () => db.prepare("SELECT sha256, svg_sha256, template_version, type, bytes, created_at FROM coin_art WHERE sha256 = ?").bind(sha).first());
/** The art row made from this SVG under this template version (without the bytes), or null. */
export const artBySvg = (db, svgSha, templateVersion) => read(db, () => db.prepare("SELECT sha256, svg_sha256, template_version, type, created_at FROM coin_art WHERE svg_sha256 = ? AND template_version = ?").bind(svgSha, templateVersion).first());
/** Store a rendered picture once (a second identical render changes nothing). */
export const storeArtStatement = (db, { sha256, svgSha256, templateVersion, bytes, now }) =>
  db.prepare("INSERT OR IGNORE INTO coin_art (sha256, svg_sha256, template_version, type, bytes, created_at) VALUES (?, ?, ?, 'image/png', ?, ?)").bind(sha256, svgSha256, templateVersion, bytes, iso(now));

/** The permanent picture URL a coin's metadata names. */
export const artPath = (sha) => `/coin-meta/art/${sha}.png`;
export const artUrl = (sha) => `https://vicinity.city${artPath(sha)}`;

const toBytes = (b) => (b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : Array.isArray(b) ? Uint8Array.from(b) : new Uint8Array(b || []));
/** The PNG bytes of a stored picture, only when they still hash to its name; else null. */
export async function artBytes(db, sha) {
  if (!/^[0-9a-f]{64}$/.test(String(sha || ""))) return null;
  const row = await artBySha(db, sha);
  if (!row) return null;
  const bytes = toBytes(row.bytes);
  return (await sha256Hex(bytes)) === sha ? { type: row.type, bytes } : null;
}

/** A city's chosen version with its content (parsed), or null. */
export async function chosenOf(db, cityId) {
  const row = await read(db, () => db.prepare(`SELECT r.city_id, r.version_id, r.content_hash, r.symbol, r.design_at, r.seat_id, r.user_id, r.chosen_at, r.mint, r.bound_at,
      v.content_json, v.name, v.description, v.art_sha256, v.template_version, c.updated_at AS design_now, c.mint AS city_mint
    FROM coin_ready r JOIN coin_versions v ON v.id = r.version_id LEFT JOIN city_coins c ON c.city_id = r.city_id WHERE r.city_id = ?`).bind(String(cityId)).first());
  if (!row) return null;
  let content = null;
  try { content = JSON.parse(row.content_json); } catch { content = null; }
  return { ...row, content, current: !row.mint && row.design_at === row.design_now };
}

/**
 * The version a launched coin's metadata is built from (src/coinmeta.js metaJsonFor), or null for the legacy JSON:
 *   - the version bound to this mint (set when the launch was recorded: it never changes afterwards), or
 *   - the city's chosen version while it is still the design (nothing changed the design row since "Use this coin");
 * and only when the chain's name and symbol are the version's and its picture is still there, hashing to its name.
 */
export async function versionForCoin(env, { cityId, mint, name, symbol }) {
  const c = await chosenOf(env.DB, cityId);
  if (!c || !c.content) return null;
  if (!(c.mint === mint || c.current)) return null;
  if (c.name !== name || c.symbol !== symbol) return null;
  if (!(await artBytes(env.DB, c.art_sha256))) return null;
  return c;
}
/** Bind the chosen version to the launched mint (once; from the launch record, src/lpcoins.js). true when bound now or before. */
export async function bindVersion(env, { cityId, mint, name, symbol }, now = Date.now()) {
  const v = await versionForCoin(env, { cityId, mint, name, symbol });
  if (!v) return false;
  if (v.mint === mint) return true;
  const r = await env.DB.prepare(`UPDATE coin_ready SET mint = ?, bound_at = ? WHERE city_id = ? AND mint IS NULL AND version_id = ?
      AND design_at = (SELECT updated_at FROM city_coins WHERE city_id = ?)`).bind(mint, iso(now), String(cityId), v.version_id, String(cityId)).run();
  return Boolean(r.meta && r.meta.changes);
}
/** The picture of a launched coin bound to `mint` (its art SHA-256), or null. */
export async function boundArtOf(db, mint) {
  const row = await read(db, () => db.prepare("SELECT v.art_sha256 FROM coin_ready r JOIN coin_versions v ON v.id = r.version_id WHERE r.mint = ?").bind(mint).first());
  return row ? row.art_sha256 : null;
}
