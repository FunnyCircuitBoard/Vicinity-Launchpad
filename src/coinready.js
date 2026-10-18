/**
 * The ready-made city coin, stage 1 of the new coin flow (COIN_V2_READY=on, src/flags.js; DESIGN.md sections 2-4). The founder gets a
 * coin that is already made: the Vicinity template drawn with the city's registry ticker and name (src/coinart.js), the coin name,
 * city, region, country and a default description from the Vicinity city list (src/coindefaults.js). All of it is read-only; the one
 * action, "Use this coin", records that exact version (its content hash) as the city's design for the EXISTING admin approval and
 * launch path: the city_coins row becomes the defaults (the earlier studio design is copied aside first, src/coinart-store.js), the
 * owner approves it on chain as today (src/lpadmin.js), the founder launches it as today (src/lplaunch.js), and the launch record
 * publishes the template picture and the server-built metadata (src/coinmeta.js, src/lpcoins.js).
 *
 *   GET  /api/coins/ready?city=<id>      the city's founder: the coin, its version and why it can or cannot be used now (`gate`). It
 *                                        changes nothing (no grace period starts here: src/seats.js holdsFounderAmount, not
 *                                        stillFounder; no table is made; no picture is drawn). Anyone else: a preview, only for a
 *                                        city that has a founder and no launched coin, labelled "Preview, not launched", with the
 *                                        picture only when one was already made. Counted per connection (coin_ready, 60 a minute).
 *   POST /api/coins/ready/art {cityId}   the founder's page asks for its picture the first time: drawn ONCE per version (SVG SHA-256
 *                                        + template version) and stored (coin_art). Never drawn on a GET or for anyone else.
 *                                        20 an hour per account (atomic counter, counted before the work).
 *   POST /api/coins/ready/use {cityId, contentHash}   "Use this coin" (a wallet proof in the last 30 minutes). The page sends the
 *                                        hash of the version it showed; anything changed since (the list, the template) is 409
 *                                        coin_changed and nothing is written. 10 a day per account (atomic counter).
 *
 * Every route checks it all again on the server: the switch (404 otherwise, like an unknown path), the caller is the city's active
 * founder (seat active or steward, account wallet = seat wallet, founder amount held live, no ban), the city id and the ticker come
 * from the registry, the city has no coin (no mint, no launchpad record, no Raydium LaunchLab contract waiting), its symbol is not
 * launched, approved or chosen for another city, and the design is not frozen by an on-chain approval or launch.
 */
import { json, readJson, sameSite } from "./http.js";
import { access } from "./access.js";
import { DAY, HOUR, iso } from "./policy.js";
import { activeBan, liveSeatOfCity, liveSeatOfUser, powersOf } from "./roles.js";
import { holdsFounderAmount, stillFounder } from "./seats.js";
import { check, limitKey } from "./limits.js";
import { ensureLimitsSchema, ensureLogoSchema, ensureSchema } from "./store.js";
import { publicLimit } from "./guards.js";
import { designFrozen } from "./lpcoins.js";
import { DEFAULT_PAIR, SOURCE, coinDefaults } from "./coindefaults.js";
import { TEMPLATE_VERSION, coinSvg, sha256Hex } from "./coinart.js";
import { artBySvg, artPath, chosenOf, ensureReadySchema, storeArtStatement } from "./coinart-store.js";
import { coinV2ReadyOn } from "./flags.js";

export const PREVIEW_LABEL = "Preview, not launched";
/** Per account, counted atomically BEFORE the work (src/limits.js): a flood cannot all pass. */
export const READY_LIMITS = Object.freeze({ art: { max: 20, windowMs: HOUR }, use: { max: 10, windowMs: DAY } });
const LIVE = ["active", "steward"];

/** The words for every reason "Use this coin" cannot be done now (the page shows them as they are). */
export const GATES = Object.freeze({
  not_founder: "Only the city's founder can choose its coin.",
  no_wallet: "Link a wallet first: your coin is launched and paid from it.",
  wallet_mismatch: "Your founder seat is held by another wallet. Sign in with that wallet to choose the coin.",
  in_grace: "Your balance is below the founder amount, so your seat is in its grace period. Hold the founder amount again to continue.",
  banned: "You can't choose or launch a coin while your account is suspended. The Home tab shows until when, and how to appeal.",
  launched: "This city's coin has launched. Its design is fixed for good.",
  legacy_contract: "A contract for this city is waiting for a check. Nothing can launch until that's settled.",
  symbol_taken: "This ticker is already launched, approved or chosen for another city. Tell us and we'll sort it out before anything launches.",
  approved: "Your coin is approved on the blockchain with its current design, so it launches as approved. To change it, the owner withdraws the approval first.",
  held: "The owner is approving your coin right now, so its design is fixed for a few minutes. Try again in 5 minutes.",
  rpc_unavailable: "We couldn't check the blockchain just now. Nothing changed. Try again in a minute.",
});

/* ---------------------------------------------------------------- versions */
const nfc = (s) => (s == null ? null : String(s).normalize("NFC"));
/**
 * The canonical content of a coin version: NFC strings, this exact key order, no spaces. Its SHA-256 is the version's content hash:
 * what the founder confirms, what the admin's approval stands for, and what the launch publishes. No mint in it, so it is fixed
 * before the launch.
 */
export function canonicalContent({ city, name, symbol, description, artSha256, templateVersion, pair = DEFAULT_PAIR }) {
  return JSON.stringify({
    v: 1,
    city: { id: String(city.id), name: nfc(city.name), region: nfc(city.region), country: city.country, countryName: nfc(city.countryName) },
    name: nfc(name), symbol, description: nfc(description),
    image: { sha256: artSha256, template: templateVersion },
    pair,
  });
}
export const versionLabel = (hash) => (hash ? hash.slice(0, 8) : null);

/* ---------------------------------------------------------------- the picture */
let rendererOverride = null;
/** Tests (and the Node tools) hand in the Node renderer (scripts/coin-art/render.mjs); the Worker loads its own on first use. */
export const _setArtRenderer = (fn) => { rendererOverride = fn; };
async function renderPng(svg) {
  const render = rendererOverride || (await import("./coinart-wasm.js")).render;
  const t0 = Date.now();
  const png = await render(svg);
  console.log("coin art drawn", `${png.length} bytes`, `${Date.now() - t0} ms`);
  return png;
}
const svgOf = (d, templateVersion = TEMPLATE_VERSION) => coinSvg({ ticker: d.ticker, city: d.city.name, templateVersion });
/** The stored picture of a coin's defaults: { sha256 } or null. Reads only. */
async function storedArt(env, d) {
  const svg = svgOf(d);
  const row = await artBySvg(env.DB, await sha256Hex(svg), TEMPLATE_VERSION);
  return row ? { sha256: row.sha256 } : null;
}
/** The picture of a coin's defaults, drawn and stored now if it never was (only from a POST of the switch). */
async function ensureArt(env, d, now) {
  const svg = svgOf(d), svgSha = await sha256Hex(svg);
  const known = await artBySvg(env.DB, svgSha, TEMPLATE_VERSION);
  if (known) return { sha256: known.sha256 };
  const png = await renderPng(svg);
  const sha = await sha256Hex(png);
  await storeArtStatement(env.DB, { sha256: sha, svgSha256: svgSha, templateVersion: TEMPLATE_VERSION, bytes: png, now }).run();
  // two servers drawing at once both write the same bytes under the same name; the (svg, version) row that won is the one served
  const row = await artBySvg(env.DB, svgSha, TEMPLATE_VERSION);
  return { sha256: row ? row.sha256 : sha };
}

/* ---------------------------------------------------------------- checks */
const cityIdOk = (v) => typeof v === "string" && /^\d{1,19}$/.test(v) && BigInt(v) > 0n && BigInt(v) < (1n << 64n) - 1n;
const optional = async (run) => { try { return await run(); } catch (e) { if (/no such table/i.test(String((e && e.message) || e))) return null; throw e; } };
/** The city's coin as the site knows it: { mint, pending } (a launched coin, or a Raydium LaunchLab contract waiting for a check). */
async function coinState(env, cityId) {
  const row = await env.DB.prepare("SELECT mint, pending_mint FROM city_coins WHERE city_id = ?").bind(cityId).first();
  const lp = await optional(() => env.DB.prepare("SELECT mint FROM lp_coins WHERE city_id = ? LIMIT 1").bind(cityId).first());
  return { launched: Boolean((row && row.mint) || lp), pending: Boolean(row && row.pending_mint) };
}
/**
 * Is `symbol` already another city's: launched (lp_coins), approved on chain by the owner and not revoked since (lp_approvals_log), or
 * chosen with "Use this coin" (coin_ready)? The registry gives every city its own ticker, but a regenerated list could move one
 * (scripts/cities/tickers.mjs pins every launched one), so this is checked again before anything is recorded.
 */
export async function symbolTaken(env, cityId, symbol) {
  const db = env.DB, c = String(cityId);
  if (await optional(() => db.prepare("SELECT city_id FROM lp_coins WHERE symbol = ? AND city_id <> ? LIMIT 1").bind(symbol, c).first())) return "launched";
  if (await optional(() => db.prepare(`SELECT a.city_id FROM lp_approvals_log a WHERE a.action = 'approve' AND a.symbol = ? AND a.city_id <> ?
      AND NOT EXISTS (SELECT 1 FROM lp_approvals_log b WHERE b.city_id = a.city_id AND b.cluster = a.cluster AND b.program_id = a.program_id
        AND b.action = 'revoke' AND b.id > a.id) LIMIT 1`).bind(symbol, c).first())) return "approved";
  if (await optional(() => db.prepare("SELECT city_id FROM coin_ready WHERE symbol = ? AND city_id <> ? LIMIT 1").bind(symbol, c).first())) return "chosen";
  return null;
}
const gate = (code) => ({ code, message: GATES[code] });
/**
 * Why the founder cannot use the coin now, or null. `live`: the founder-amount check already made (true / false / "error").
 * Reads only (the GET's and the POSTs' common part).
 */
async function coinGate(env, { u, seat, d, live, cityId, fetchImpl, now }) {
  if (!u.wallet) return gate("no_wallet");
  if (u.wallet !== seat.wallet) return gate("wallet_mismatch");
  if (live === "error") return gate("rpc_unavailable");
  if (!live || !LIVE.includes(seat.status)) return gate("in_grace");
  if ((await activeBan(env.DB, u.id, u.home_country, now)) || (await activeBan(env.DB, u.id, seat.country, now))) return gate("banned");
  if (!d.ok) return { code: d.code, message: d.message };
  const st = await coinState(env, cityId);
  if (st.launched) return gate("launched");
  if (st.pending) return gate("legacy_contract");
  if (await symbolTaken(env, cityId, d.ticker)) return gate("symbol_taken");
  let frozen;
  try { frozen = await designFrozen(env, cityId, fetchImpl, now); } catch { return gate("rpc_unavailable"); }
  if (frozen === "launched") return gate("launched");
  if (frozen) return gate(frozen === "held" ? "held" : "approved");
  return null;
}
const liveCheck = async (env, seat, fetchImpl) => { try { return await holdsFounderAmount(env, seat, fetchImpl); } catch { return "error"; } };

/* ---------------------------------------------------------------- the answers */
async function founderView(env, { u, seat, cityId, fetchImpl, now, live }) {
  const d = await coinDefaults(env, cityId, seat.country);
  const g = await coinGate(env, { u, seat, d, live, cityId, fetchImpl, now });
  if (!d.ok) return { ok: true, mode: "founder", city: { id: cityId, name: seat.city_name, country: seat.country }, coin: null, chosen: null, gate: g };
  const art = await storedArt(env, d);
  const contentHash = art ? await sha256Hex(canonicalContent({ city: d.city, name: d.name, symbol: d.ticker, description: d.description, artSha256: art.sha256, templateVersion: TEMPLATE_VERSION })) : null;
  const c = await chosenOf(env.DB, cityId);
  const chosen = c ? { contentHash: c.content_hash, version: versionLabel(c.content_hash), at: c.chosen_at, current: c.current, art: artPath(c.art_sha256), launched: Boolean(c.mint) } : null;
  return {
    ok: true, mode: "founder",
    city: { id: d.city.id, name: d.city.name, region: d.city.region, regionCode: d.city.regionCode, country: d.city.country, countryName: d.city.countryName },
    coin: { ticker: d.ticker, name: d.name, description: d.description, pair: d.pair, templateVersion: TEMPLATE_VERSION, source: SOURCE,
      art: art ? artPath(art.sha256) : null, contentHash, version: versionLabel(contentHash) },
    chosen, inUse: Boolean(chosen && chosen.current && contentHash && chosen.contentHash === contentHash), gate: g,
  };
}
async function previewView(env, cityId) {
  const none = { ok: true, mode: "preview", preview: null };
  const seat = await liveSeatOfCity(env.DB, cityId);
  if (!seat || !["active", "steward", "grace"].includes(seat.status)) return none; // previews only for a city that has a founder
  if ((await coinState(env, cityId)).launched) return none; // a launched coin is shown as itself, never as a preview
  const d = await coinDefaults(env, cityId, seat.country);
  if (!d.ok) return none;
  const c = await chosenOf(env.DB, cityId);
  const art = c && c.current ? { sha256: c.art_sha256 } : await storedArt(env, d);
  return { ok: true, mode: "preview", preview: { label: PREVIEW_LABEL, ticker: d.ticker, name: d.name, description: d.description,
    city: { name: d.city.name, region: d.city.region, countryName: d.city.countryName }, art: art ? artPath(art.sha256) : null } };
}

const fail = (error, status, extra = {}) => json({ ok: false, error, ...(GATES[error] ? { message: GATES[error] } : {}), ...extra }, status);
async function accountLimit(env, kind, userId, now) {
  const spec = READY_LIMITS[kind];
  await ensureLimitsSchema(env.DB);
  const r = await check(env, [{ key: await limitKey(env, `coin-ready-${kind}`, String(userId)), windowMs: spec.windowMs, max: spec.max }], now);
  return r.ok ? null : json({ ok: false, error: "slow_down" }, 429, { "Retry-After": String(Math.ceil(spec.windowMs / 1000)) });
}

/** GET /api/coins/ready?city=<id> (see the header). */
export async function handleReady(request, env, fetchImpl = fetch, now = Date.now()) {
  if (!coinV2ReadyOn(env)) return json({ error: "not_found" }, 404);
  const cityId = new URL(request.url).searchParams.get("city") || "";
  if (!cityIdOk(cityId)) return fail("bad_city", 400);
  if (!env.DB) return fail("unavailable", 503);
  const slow = await publicLimit(env, request, "coin_ready", now);
  if (slow) return slow;
  await ensureSchema(env.DB);
  const a = await access(request, env, now, { write: false });
  const seat = a.u ? await liveSeatOfUser(env.DB, a.u.id) : null;
  const headers = { "Cache-Control": "no-store" };
  if (seat && seat.city_id === cityId && [...LIVE, "grace"].includes(seat.status)) {
    const live = seat.status === "grace" ? false : await liveCheck(env, seat, fetchImpl);
    return json(await founderView(env, { u: a.u, seat, cityId, fetchImpl, now, live }), 200, headers);
  }
  return json(await previewView(env, cityId), 200, headers);
}

/** The founder of `cityId` for a write: { u, seat } or { error }. `fresh`: a wallet proof in the last 30 minutes. */
async function writer(request, env, now, { fresh }) {
  if (!sameSite(request)) return { error: fail("wrong_origin", 403) };
  const a = await access(request, env, now, { write: true, fresh });
  if (a.error) return a;
  const body = await readJson(request, 1024);
  const cityId = body && (typeof body.cityId === "string" || typeof body.cityId === "number") ? String(body.cityId) : "";
  if (!cityIdOk(cityId)) return { error: fail("bad_city", 400) };
  return { u: a.u, body, cityId };
}

/** POST /api/coins/ready/art {cityId}: the founder's picture, drawn once and stored. Changes nothing else. */
export async function handleReadyArt(request, env, fetchImpl = fetch, now = Date.now()) {
  if (!coinV2ReadyOn(env)) return json({ error: "not_found" }, 404);
  if (!env.DB) return fail("unavailable", 503);
  const w = await writer(request, env, now, { fresh: false });
  if (w.error) return w.error;
  const seat = await liveSeatOfUser(env.DB, w.u.id);
  if (!seat || seat.city_id !== w.cityId || !LIVE.includes(seat.status)) return fail("not_founder", 403);
  if (w.u.wallet !== seat.wallet) return fail("wallet_mismatch", 403);
  const slow = await accountLimit(env, "art", w.u.id, now);
  if (slow) return slow;
  const live = await liveCheck(env, seat, fetchImpl);
  if (live === "error") return fail("rpc_unavailable", 503);
  if (!live) return fail("in_grace", 403);
  const d = await coinDefaults(env, w.cityId, seat.country);
  if (!d.ok) return json({ ok: false, error: d.code, message: d.message }, d.code === "list_unavailable" ? 503 : 409);
  await ensureReadySchema(env.DB);
  await ensureArt(env, d, now);
  return json(await founderView(env, { u: w.u, seat, cityId: w.cityId, fetchImpl, now, live }), 200, { "Cache-Control": "no-store" });
}

/** POST /api/coins/ready/use {cityId, contentHash}: "Use this coin" (see the header). */
export async function handleReadyUse(request, env, fetchImpl = fetch, now = Date.now()) {
  if (!coinV2ReadyOn(env)) return json({ error: "not_found" }, 404);
  if (!env.DB) return fail("unavailable", 503);
  const w = await writer(request, env, now, { fresh: true });
  if (w.error) return w.error;
  const { u, cityId } = w;
  const echo = typeof w.body.contentHash === "string" ? w.body.contentHash : "";
  if (!/^[0-9a-f]{64}$/.test(echo)) return fail("bad_request", 400);
  const slow = await accountLimit(env, "use", u.id, now);
  if (slow) return slow;
  const pw = await powersOf(env, u, fetchImpl, now);
  if (pw.founderCity !== cityId) return fail("not_founder", 403);
  const seat = pw.seat;
  if (!u.wallet || u.wallet !== seat.wallet) return fail(u.wallet ? "wallet_mismatch" : "no_wallet", 403);
  if ((await activeBan(env.DB, u.id, u.home_country, now)) || (await activeBan(env.DB, u.id, seat.country, now))) return fail("banned", 403);
  // a real founder action: as for every other one (src/coins.js), the live balance is checked and a seat below it enters its grace period
  let still;
  try { still = await stillFounder(env, seat, now, fetchImpl); } catch { return fail("rpc_unavailable", 503); }
  if (!still) return fail("in_grace", 403);
  const d = await coinDefaults(env, cityId, seat.country);
  if (!d.ok) return json({ ok: false, error: d.code, message: d.message }, d.code === "list_unavailable" ? 503 : 409);
  const g = await coinGate(env, { u, seat, d, live: true, cityId, fetchImpl, now });
  if (g) return fail(g.code, g.code === "rpc_unavailable" ? 503 : 409);

  await ensureLogoSchema(env.DB);
  await ensureReadySchema(env.DB);
  const art = await ensureArt(env, d, now);
  const content = canonicalContent({ city: d.city, name: d.name, symbol: d.ticker, description: d.description, artSha256: art.sha256, templateVersion: TEMPLATE_VERSION });
  const hash = await sha256Hex(content);
  const view = () => founderView(env, { u, seat, cityId, fetchImpl, now, live: true });
  // the founder confirms exactly what their page showed: a list or template change since then is a new version, shown first
  if (echo !== hash) return json({ ...(await view()), ok: false, error: "coin_changed", message: "Your coin changed since this page loaded. Check it again, then use it." }, 409);
  const before = await chosenOf(env.DB, cityId);
  if (before && before.current && before.content_hash === hash) return json({ ...(await view()), already: true });

  const db = env.DB, at = iso(now);
  const old = await db.prepare("SELECT * FROM city_coins WHERE city_id = ?").bind(cityId).first();
  const stmts = [
    db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(cityId, content, hash, d.name, d.ticker, d.description, art.sha256, TEMPLATE_VERSION, u.id, at),
  ];
  // every write after the design row's own is conditional on it: if that row launched or got a LaunchLab contract in the meantime
  // (its update is skipped), nothing else is written either
  const ours = "EXISTS (SELECT 1 FROM city_coins WHERE city_id = ? AND updated_at = ? AND mint IS NULL AND pending_mint IS NULL)";
  // the founder's earlier studio design is kept, whole, before the row becomes the ready-made coin (never on a mere visit)
  const legacy = old && !(before && before.current);
  if (legacy) {
    stmts.push(db.prepare(`INSERT INTO coin_legacy_designs (city_id, design_json, copied_at, copied_by) SELECT ?, ?, ?, ? WHERE ${ours}`)
      .bind(cityId, JSON.stringify(old), at, u.id, cityId, old.updated_at));
  }
  stmts.push(db.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, media_id, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ink', NULL, ?, ?)
      ON CONFLICT(city_id) DO UPDATE SET seat_id = excluded.seat_id, user_id = excluded.user_id, name = excluded.name, pitch = excluded.pitch, pair = excluded.pair,
        color = excluded.color, media_id = NULL, approved_media_id = NULL, logo_hash = NULL, logo_status = NULL, logo_reason = NULL, logo_note = NULL,
        logo_reviewed_at = NULL, logo_reviewed_by = NULL, updated_at = excluded.updated_at
      WHERE city_coins.mint IS NULL AND city_coins.pending_mint IS NULL`)
    .bind(cityId, seat.city_name, seat.country, seat.id, u.id, d.name, d.description, d.pair, at, at));
  stmts.push(db.prepare(`INSERT INTO coin_ready (city_id, version_id, content_hash, symbol, design_at, seat_id, user_id, chosen_at)
      SELECT ?, (SELECT id FROM coin_versions WHERE city_id = ? AND content_hash = ?), ?, ?, ?, ?, ?, ? WHERE ${ours}
      ON CONFLICT(city_id) DO UPDATE SET version_id = excluded.version_id, content_hash = excluded.content_hash, symbol = excluded.symbol,
        design_at = excluded.design_at, seat_id = excluded.seat_id, user_id = excluded.user_id, chosen_at = excluded.chosen_at
      WHERE coin_ready.mint IS NULL`).bind(cityId, cityId, hash, hash, d.ticker, at, seat.id, u.id, at, cityId, at));
  stmts.push(db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
      SELECT ?, 'founder', 'coin_design', 'city_coin', NULL, ?, ?, ?, 'design', ?, ?, 'done' WHERE ${ours}`)
    .bind(u.id, u.id, seat.country, cityId, `${seat.city_name}: the Vicinity coin $${d.ticker} "${d.name}", version ${versionLabel(hash)}${legacy ? " (the earlier design is kept aside)" : ""}`, at, cityId, at));
  try { await db.batch(stmts); }
  catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || e))) return fail("symbol_taken", 409);
    throw e;
  }
  const after = await chosenOf(db, cityId);
  if (!after || !after.current || after.content_hash !== hash) return fail("launched", 409); // the row was launched or claimed meanwhile: nothing of ours stands
  return json({ ...(await view()), used: true });
}
