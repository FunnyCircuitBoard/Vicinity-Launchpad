/**
 * City coins: each community's one official coin, designed by its City Founder.
 *   Design   the ACTIVE founder of the city (wallet proven in the last 30 minutes, founder amount still held,
 *            checked live) sets the coin's display name, a short pitch, a colour, a square logo, and the token
 *            it's paired with on Raydium LaunchLab: SOL, USDC or RAY. The ticker is the city's own, fixed by
 *            the map, so nobody can copy another city's coin.
 *   Public   every design is public (GET /api/coins) and every change is in the public log (/api/audit).
 *   Launch   once the coin is live, the founder submits its contract address; an admin who isn't that founder
 *            checks it and records it. From then on the design is locked, so it always matches the blockchain.
 *   Safety   an admin can take down a logo or text that breaks the rules, with a public reason.
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { countRecent, noteEvent } from "./attest.js";
import { DAY, POLICY, iso } from "./policy.js";
import { powersOf } from "./roles.js";
import { stillFounder } from "./seats.js";
import { activeMint } from "./official.js";
import { mintInfo } from "./chain.js";
import { isSolanaAddress } from "./solana.js";
import { HAS_ADDRESS, cleanText } from "./text.js";
import { readImage } from "./social.js";
import { ensureSchema } from "./store.js";

const C = POLICY.coins;

/** What a city coin can be paired with on Raydium LaunchLab. */
export const PAIRS = {
  SOL: { mint: "So11111111111111111111111111111111111111112", name: "Solana" },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USD Coin" },
  RAY: { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", name: "Raydium" },
};

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'’&-]*$/u;
const LINKISH = /https?:|www\.|\.[a-z]{2,}(\/|\b)/i;

/** The public view of a coin (the contract waiting for a check is never shown: only that one is waiting). */
export function coinView(row) {
  if (!row) return null;
  return {
    city: row.city_id, cityName: row.city_name, country: row.country,
    name: row.name, pitch: row.pitch || "", pair: row.pair, pairMint: PAIRS[row.pair]?.mint || null, color: row.color,
    logo: row.media_id ? `/api/media/${row.media_id}` : null,
    mint: row.mint || null, launched: Boolean(row.mint), launchedAt: row.launched_at || null,
    waiting: Boolean(row.pending_mint), by: row.designer || null, updatedAt: row.updated_at,
  };
}
const SELECT = "SELECT c.*, COALESCE(u.handle, u.name) AS designer FROM city_coins c LEFT JOIN users u ON u.id = c.user_id";
export const coinOf = (db, cityId) => db.prepare(`${SELECT} WHERE c.city_id = ?`).bind(String(cityId)).first();

function log(db, a) {
  return db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
    VALUES (?, ?, ?, 'city_coin', NULL, ?, ?, ?, ?, ?, ?, 'done')`)
    .bind(a.actor, a.role, a.action, a.user ?? null, a.country, a.place, a.reason, a.note ?? null, a.at).run();
}

/** The active founder of their city, still holding (live), with a fresh wallet proof. */
async function founder(request, env, now, fetchImpl) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a;
  const pw = await powersOf(env, a.u, fetchImpl, now);
  if (!pw.founderCity) return { error: json({ ok: false, error: "not_founder" }, 403) };
  if (!(await stillFounder(env, pw.seat, now, fetchImpl))) return { error: json({ ok: false, error: "in_grace" }, 403) };
  return { u: a.u, seat: pw.seat };
}
async function admin(request, env, now, fetchImpl, { write = true, fresh = true } = {}) {
  const a = await access(request, env, now, { write, fresh });
  if (a.error) return a;
  const pw = await powersOf(env, a.u, fetchImpl, now);
  if (!pw.admin) return { error: json({ ok: false, error: "not_allowed" }, 403) };
  return { u: a.u };
}

/**
 * GET /api/coins                → every designed coin (public)
 * GET /api/coins?city=<id>      → one city's coin, or null
 * GET /api/coins?waiting=1      → admins: coins whose contract is waiting for a check (with the address)
 */
export async function handleCoins(request, env, fetchImpl = fetch, now = Date.now()) {
  const pairs = Object.fromEntries(Object.entries(PAIRS).map(([k, v]) => [k, { ...v, symbol: k }]));
  const vicinity = activeMint(env) || null; // the live $VICINITY contract (for the swap panel)
  if (!env.DB) return json({ coins: [], coin: null, pairs, vicinity });
  await ensureSchema(env.DB);
  const q = new URL(request.url).searchParams;
  if (q.get("waiting")) {
    const a = await admin(request, env, now, fetchImpl, { write: false, fresh: false }); // a page load: browsers send no Origin on GET
    if (a.error) return a.error;
    const rows = (await env.DB.prepare(`${SELECT} WHERE c.pending_mint IS NOT NULL ORDER BY c.pending_at`).all()).results;
    return json({ ok: true, waiting: rows.map((r) => ({ ...coinView(r), pendingMint: r.pending_mint, pendingAt: r.pending_at, designerId: r.user_id })) });
  }
  if (q.get("city")) return json({ coin: coinView(await coinOf(env.DB, q.get("city"))), pairs, vicinity });
  const rows = (await env.DB.prepare(`${SELECT} ORDER BY c.updated_at DESC LIMIT 20000`).all()).results;
  return json({ coins: rows.map(coinView), pairs, vicinity });
}

/** POST /api/coins/design { name, pitch, pair, color, image?, removeLogo? } — the founder designs their city's coin. */
export async function handleDesign(request, env, fetchImpl = fetch, now = Date.now()) {
  const f = await founder(request, env, now, fetchImpl);
  if (f.error) return f.error;
  const { u, seat } = f, db = env.DB;
  const body = await readJson(request, 300_000);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const old = await coinOf(db, seat.city_id);
  if (old && old.mint) return json({ ok: false, error: "coin_locked" }, 409);

  const name = cleanText(body.name, C.nameMax);
  if (!name || name.length < 2 || !NAME_RE.test(name) || LINKISH.test(name)) return json({ ok: false, error: "bad_name", max: C.nameMax }, 400);
  const pitch = cleanText(body.pitch, C.pitchMax);
  if (pitch == null) return json({ ok: false, error: "too_long", max: C.pitchMax }, 400);
  if (HAS_ADDRESS.test(pitch) || HAS_ADDRESS.test(name)) return json({ ok: false, error: "no_addresses" }, 400);
  if (LINKISH.test(pitch)) return json({ ok: false, error: "no_links" }, 400);
  if (!C.pairs.includes(body.pair)) return json({ ok: false, error: "bad_pair", pairs: C.pairs }, 400);
  if (!C.colors.includes(body.color)) return json({ ok: false, error: "bad_color" }, 400);
  let image = null;
  if (body.image != null) {
    image = readImage(body.image);
    if (!image) return json({ ok: false, error: "bad_image" }, 400);
  }
  if (await countRecent(env, u.id, "coin_design", now - DAY) >= C.editsPerDay) return json({ ok: false, error: "slow_down" }, 429);

  let mediaId = old ? old.media_id : null;
  if (image) mediaId = (await db.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (?, ?, ?, ?)").bind(u.id, image.type, image.bytes, iso(now)).run()).meta.last_row_id;
  else if (body.removeLogo) mediaId = null;

  await db.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, media_id, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(city_id) DO UPDATE SET seat_id = excluded.seat_id, user_id = excluded.user_id, name = excluded.name, pitch = excluded.pitch,
        pair = excluded.pair, color = excluded.color, media_id = excluded.media_id, updated_at = excluded.updated_at`)
    .bind(seat.city_id, seat.city_name, seat.country, seat.id, u.id, name, pitch || null, body.pair, body.color, mediaId, iso(now), iso(now)).run();
  await noteEvent(env, u.id, "coin_design", now);
  const changed = [
    !old || old.name !== name ? `name "${name}"` : null, !old || (old.pitch || "") !== pitch ? "pitch" : null,
    !old || old.pair !== body.pair ? `paired with ${body.pair}` : null, !old || old.color !== body.color ? `colour ${body.color}` : null,
    image ? "new logo" : !old || old.media_id !== mediaId ? (mediaId ? "logo" : "logo removed") : null,
  ].filter(Boolean);
  await log(db, { actor: u.id, role: "founder", action: "coin_design", user: u.id, country: seat.country, place: seat.city_id, reason: "design",
    note: `${seat.city_name}: ${changed.join(", ") || "saved"}`, at: iso(now) });
  return json({ ok: true, coin: coinView(await coinOf(db, seat.city_id)) });
}

/** POST /api/coins/mint { mint } — the founder: "our coin is live, this is its contract". An admin checks it. */
export async function handleProposeMint(request, env, fetchImpl = fetch, now = Date.now()) {
  const f = await founder(request, env, now, fetchImpl);
  if (f.error) return f.error;
  const { u, seat } = f, db = env.DB;
  const body = await readJson(request);
  const mint = body && typeof body.mint === "string" ? body.mint.trim() : "";
  if (!isSolanaAddress(mint)) return json({ ok: false, error: "bad_address" }, 400);
  if (mint === activeMint(env) || Object.values(PAIRS).some((p) => p.mint === mint)) return json({ ok: false, error: "not_a_city_coin" }, 400);
  const coin = await coinOf(db, seat.city_id);
  if (!coin) return json({ ok: false, error: "design_first" }, 409);
  if (coin.mint) return json({ ok: false, error: "coin_locked" }, 409);
  if (await db.prepare("SELECT city_id FROM city_coins WHERE mint = ? OR (pending_mint = ? AND city_id <> ?)").bind(mint, mint, seat.city_id).first()) {
    return json({ ok: false, error: "mint_taken" }, 409);
  }
  await db.prepare("UPDATE city_coins SET pending_mint = ?, pending_at = ? WHERE city_id = ?").bind(mint, iso(now), seat.city_id).run();
  await log(db, { actor: u.id, role: "founder", action: "coin_contract_submitted", user: u.id, country: seat.country, place: seat.city_id, reason: "launch",
    note: `${seat.city_name}: waiting for an admin to check the contract`, at: iso(now) });
  return json({ ok: true, coin: coinView(await coinOf(db, seat.city_id)) });
}

/**
 * POST /api/coins/mint/decide { city, mint, approve, note } — an admin (not the founder) records or rejects the contract.
 * `mint` is the address the admin actually looked at. Recording happens only if it is still the one waiting (a founder
 * who re-submits another address after the admin opened the first gets 409 mint_changed, and the row is matched on
 * it again in the UPDATE so two requests crossing cannot slip one through), and only after the blockchain says it is
 * a token mint with a supply; what the chain said is written into the public log. Rejecting needs no address (the
 * page that ships today sends none), but when one is sent it must match too.
 */
export async function handleDecideMint(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await admin(request, env, now, fetchImpl);
  if (a.error) return a.error;
  const db = env.DB, body = await readJson(request);
  const coin = body && await coinOf(db, String(body.city || ""));
  if (!coin || !coin.pending_mint) return json({ ok: false, error: "not_found" }, 404);
  if (coin.user_id === a.u.id) return json({ ok: false, error: "needs_second_person" }, 403);
  const note = cleanText(body.note, 300);
  if (note == null) return json({ ok: false, error: "too_long", max: 300 }, 400);
  const mint = typeof body.mint === "string" ? body.mint.trim() : "";
  if (mint && mint !== coin.pending_mint) return json({ ok: false, error: "mint_changed" }, 409);
  let seen = "";
  if (body.approve === true) {
    if (!mint) return json({ ok: false, error: "mint_required" }, 400);
    let facts;
    try { facts = await mintInfo(env, mint, fetchImpl); }
    catch (e) { console.error("mint check failed", String(e)); return json({ ok: false, error: "chain_unavailable" }, 503); }
    if (!facts) return json({ ok: false, error: "not_a_mint" }, 400);
    let r;
    try {
      r = await db.prepare("UPDATE city_coins SET mint = pending_mint, pending_mint = NULL, pending_at = NULL, launched_at = ?, launched_by = ? WHERE city_id = ? AND pending_mint = ?")
        .bind(iso(now), a.u.id, coin.city_id, mint).run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: "mint_taken" }, 409);
      throw e;
    }
    if (!r.meta.changes) return json({ ok: false, error: "mint_changed" }, 409);
    seen = ` · on the blockchain: ${facts.program} mint, supply ${facts.supply.toLocaleString("en-US")}, ${facts.decimals} decimals, mint authority ${facts.mintAuthority || "none"}, freeze authority ${facts.freezeAuthority || "none"}`;
  } else {
    if (!note) return json({ ok: false, error: "reason_required" }, 400);
    await db.prepare("UPDATE city_coins SET pending_mint = NULL, pending_at = NULL WHERE city_id = ?").bind(coin.city_id).run();
  }
  await log(db, { actor: a.u.id, role: "admin", action: body.approve === true ? "coin_launch_confirmed" : "coin_contract_rejected", user: coin.user_id,
    country: coin.country, place: coin.city_id, reason: "launch", note: `${coin.city_name}${note ? `: ${note}` : ""}${seen}`, at: iso(now) });
  return json({ ok: true, coin: coinView(await coinOf(db, coin.city_id)) });
}

/** POST /api/coins/takedown { city, what: "logo" | "text", reason, note } — an admin removes a logo or text that breaks the rules. */
export async function handleTakedown(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await admin(request, env, now, fetchImpl);
  if (a.error) return a.error;
  const db = env.DB, body = await readJson(request);
  const coin = body && await coinOf(db, String(body.city || ""));
  if (!coin) return json({ ok: false, error: "not_found" }, 404);
  const reason = POLICY.moderation.reasons.includes(body.reason) ? body.reason : null;
  const note = cleanText(body.note, 300);
  if (!reason || note == null || note.length < 3) return json({ ok: false, error: "reason_required" }, 400);
  if (body.what === "logo") await db.prepare("UPDATE city_coins SET media_id = NULL, updated_at = ? WHERE city_id = ?").bind(iso(now), coin.city_id).run();
  else if (body.what === "text" && !coin.mint) await db.prepare("UPDATE city_coins SET name = city_name, pitch = NULL, updated_at = ? WHERE city_id = ?").bind(iso(now), coin.city_id).run();
  else return json({ ok: false, error: body.what === "text" ? "coin_locked" : "bad_request" }, 400);
  await log(db, { actor: a.u.id, role: "admin", action: `coin_${body.what}_removed`, user: coin.user_id, country: coin.country, place: coin.city_id,
    reason, note: `${coin.city_name}: ${note}`, at: iso(now) });
  return json({ ok: true, coin: coinView(await coinOf(db, coin.city_id)) });
}

/** Prices in US dollars for the tokens the swap panel shows (only those: $VICINITY, the pairs, launched city coins). */
export async function handlePrices(request, env, fetchImpl = fetch) {
  const wanted = [...new Set(String(new URL(request.url).searchParams.get("mints") || "").split(",").filter(isSolanaAddress))].slice(0, 6);
  const allowed = new Set([activeMint(env), ...Object.values(PAIRS).map((p) => p.mint)].filter(Boolean));
  if (env.DB && wanted.some((m) => !allowed.has(m))) {
    await ensureSchema(env.DB);
    for (const m of wanted) if (!allowed.has(m) && await env.DB.prepare("SELECT 1 FROM city_coins WHERE mint = ?").bind(m).first()) allowed.add(m);
  }
  const mints = wanted.filter((m) => allowed.has(m));
  const prices = Object.fromEntries(mints.map((m) => [m, null]));
  if (mints.length) {
    try {
      const res = await fetchImpl(`https://lite-api.jup.ag/price/v3?ids=${mints.join(",")}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const d = await res.json();
        for (const m of mints) { const p = Number(d?.[m]?.usdPrice); if (Number.isFinite(p) && p > 0) prices[m] = p; }
      }
    } catch { /* prices are a nice-to-have: the swap page always shows the exact amount */ }
  }
  return json({ prices }, 200, { "Cache-Control": "public, max-age=30" });
}
