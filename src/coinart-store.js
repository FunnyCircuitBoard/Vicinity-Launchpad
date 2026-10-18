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
 *                        the choice stale; approved_hash is the version the owner's approval was built from (src/lpadmin.js
 *                        approveTx, only while the switch is on; a new choice clears it); mint is set once the coin launched with
 *                        it (then nothing can unbind it)
 *   coin_legacy_designs  a founder's earlier studio design, copied here (the whole row) before "Use this coin" replaced it
 */
import { iso } from "./policy.js";
import { ensureSchema } from "./store.js";
import { sha256Hex } from "./coinart.js";
import { coinV2ReadyOn } from "./flags.js";

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
  bound_at     TEXT,
  approved_hash TEXT
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
/**
 * coin_ready.approved_hash for a database whose coin_ready was made before the column existed (a test or preview database that had
 * the switch on): added once, additively. A database made by READY_MIGRATION above has it already.
 */
export const APPROVED_MIGRATION = { id: "2026-10-18-coin-ready-approved", column: "ALTER TABLE coin_ready ADD COLUMN approved_hash TEXT" };
const ready = new WeakMap();
/** Make the four tables (only from a COIN_V2_READY route). Additive, safe to repeat and to run from two servers; a failure is forgotten. */
export function ensureReadySchema(db) {
  if (!ready.has(db)) {
    ready.set(db, (async () => {
      await ensureSchema(db); // schema_migrations and city_coins exist (the normal migrations)
      const done = async (id) => Boolean(await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(id).first());
      const mark = (id) => db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(id, new Date().toISOString()).run();
      if (!(await done(READY_MIGRATION.id))) {
        await db.batch(READY_MIGRATION.tables.map((t) => db.prepare(t)));
        await mark(READY_MIGRATION.id);
        await mark(APPROVED_MIGRATION.id); // made with the column
      } else if (!(await done(APPROVED_MIGRATION.id))) {
        try { await db.prepare(APPROVED_MIGRATION.column).run(); } catch (e) { if (!/duplicate column/i.test(String((e && e.message) || e))) throw e; }
        await mark(APPROVED_MIGRATION.id);
      }
    })().catch((e) => { ready.delete(db); throw e; }).finally(() => {
      // the tables exist now (made here, or by another server earlier): a "missing" remembered by a read before is wrong from here on,
      // whichever way this went (src/coinready.js would otherwise draw a picture again, or answer "launched" after recording a choice)
      missing.delete(db);
    }));
  }
  return ready.get(db).then(() => { missing.delete(db); });
}

// A database where the tables were missing (the switch was never on): asked again a minute later, so a request for a picture that
// cannot exist costs no database work in between.
const missing = new WeakMap();
const MISSING_MS = 60_000;
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
// coin_ready made before approved_hash existed (a database that had the switch on earlier): read as "not approved" until a route of
// the switch adds the column (ensureReadySchema); a GET never alters a table
const noColumn = (e) => /no such column/i.test(String((e && e.message) || e));
/**
 * Run a read; a missing table is null (remembered a minute per database), any other failure throws. `fresh`: the database is asked
 * whatever was remembered (every read on a write path: a stale "missing" there would draw a picture twice or misread a choice).
 */
async function read(db, run, { fresh = false } = {}, now = Date.now()) {
  if (!db) return null;
  const until = missing.get(db);
  if (!fresh && until && until > now) return null;
  try { return await run(); } catch (e) { if (noTable(e)) { missing.set(db, now + MISSING_MS); return null; } throw e; }
}

/** The art row named by its PNG SHA-256 (with the bytes), or null. */
export const artBySha = (db, sha) => read(db, () => db.prepare("SELECT sha256, svg_sha256, template_version, type, bytes, created_at FROM coin_art WHERE sha256 = ?").bind(sha).first());
/** The art row made from this SVG under this template version (without the bytes), or null. `opts.fresh`: see read. */
export const artBySvg = (db, svgSha, templateVersion, opts = {}) => read(db, () => db.prepare("SELECT sha256, svg_sha256, template_version, type, created_at FROM coin_art WHERE svg_sha256 = ? AND template_version = ?").bind(svgSha, templateVersion).first(), opts);
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

/** A city's chosen version with its content (parsed), or null. `opts.fresh`: see read (every write path asks fresh). */
export async function chosenOf(db, cityId, opts = {}) {
  const sql = (approved) => `SELECT r.city_id, r.version_id, r.content_hash, r.symbol, r.design_at, r.seat_id, r.user_id, r.chosen_at, r.mint, r.bound_at,
      ${approved} AS approved_hash, v.content_json, v.name, v.description, v.art_sha256, v.template_version, c.updated_at AS design_now, c.mint AS city_mint
    FROM coin_ready r JOIN coin_versions v ON v.id = r.version_id LEFT JOIN city_coins c ON c.city_id = r.city_id WHERE r.city_id = ?`;
  const row = await read(db, async () => {
    try { return await db.prepare(sql("r.approved_hash")).bind(String(cityId)).first(); }
    catch (e) { if (noColumn(e)) return db.prepare(sql("NULL")).bind(String(cityId)).first(); throw e; }
  }, opts);
  if (!row) return null;
  let content = null;
  try { content = JSON.parse(row.content_json); } catch { content = null; }
  return { ...row, content, current: !row.mint && row.design_at === row.design_now };
}

/**
 * The version BOUND to this launched coin (set once, when its launch was recorded with the switch on: src/lpcoins.js), with its
 * picture still there and hashing to its name, or null for the legacy JSON. What src/coinmeta.js builds a coin's metadata from,
 * WHATEVER ANY SWITCH SAYS NOW: a bound version is the coin's for ever, and nothing unbound is ever published.
 */
export async function versionForCoin(env, { cityId, mint, name, symbol }) {
  const c = await chosenOf(env.DB, cityId, { fresh: true });
  if (!c || !c.content || c.mint !== mint) return null;
  if (c.name !== name || c.symbol !== symbol) return null;
  if (!(await artBytes(env.DB, c.art_sha256))) return null;
  return c;
}
/**
 * Bind the chosen version to the launched mint (once; from the launch record, src/lpcoins.js, and the first build of its JSON,
 * src/coinmeta.js). true when bound now or before. A version not bound yet is bound only when ALL of these hold:
 *   - COIN_V2_READY is on now (turned off, e.g. because the owner rejected the template's look, nothing new is published with it);
 *   - it is still the city's design (nothing changed the design row since "Use this coin");
 *   - the owner's approval was built from it (approved_hash: src/lpadmin.js approveTx with the switch on, from the card that showed
 *     this picture and version);
 *   - the chain's name and symbol are the version's, and its picture is stored and hashes to its name.
 */
export async function bindVersion(env, { cityId, mint, name, symbol }, now = Date.now()) {
  const c = await chosenOf(env.DB, cityId, { fresh: true });
  if (!c || !c.content) return false;
  if (c.mint === mint) return true;
  if (!coinV2ReadyOn(env) || !c.current || c.approved_hash !== c.content_hash) return false;
  if (c.name !== name || c.symbol !== symbol) return false;
  if (!(await artBytes(env.DB, c.art_sha256))) return false;
  const r = await env.DB.prepare(`UPDATE coin_ready SET mint = ?, bound_at = ? WHERE city_id = ? AND mint IS NULL AND version_id = ? AND approved_hash = content_hash
      AND design_at = (SELECT updated_at FROM city_coins WHERE city_id = ?)`).bind(mint, iso(now), String(cityId), c.version_id, String(cityId)).run();
  return Boolean(r.meta && r.meta.changes);
}
/**
 * The owner's approval is being built from this exact chosen version (src/lpadmin.js approveTx, switch on): only while it is still
 * the city's choice and design. A later "Use this coin" clears it (src/coinready.js), so a launch binds only what the owner saw.
 */
export const markApprovedStatement = (db, { cityId, contentHash, designAt }) =>
  db.prepare("UPDATE coin_ready SET approved_hash = content_hash WHERE city_id = ? AND content_hash = ? AND design_at = ? AND mint IS NULL").bind(String(cityId), contentHash, designAt);
/** An approval built with the switch off is not one built from a ready-made version: any earlier mark is cleared (no table: nothing). */
export async function clearApproved(db, cityId) {
  try { await db.prepare("UPDATE coin_ready SET approved_hash = NULL WHERE city_id = ? AND mint IS NULL").bind(String(cityId)).run(); }
  catch (e) { if (!noTable(e) && !noColumn(e)) throw e; } // no table or no column yet: nothing was ever marked
}
/** The picture of a launched coin bound to `mint` (its art SHA-256), or null. */
export async function boundArtOf(db, mint) {
  const row = await read(db, () => db.prepare("SELECT v.art_sha256 FROM coin_ready r JOIN coin_versions v ON v.id = r.version_id WHERE r.mint = ?").bind(mint).first());
  return row ? row.art_sha256 : null;
}
