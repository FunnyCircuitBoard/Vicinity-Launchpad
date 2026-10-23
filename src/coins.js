/**
 * City coins: each community's one official coin, designed by its City Founder.
 *   Design   the ACTIVE founder of the city (wallet proven in the last 30 minutes, founder amount still held,
 *            checked live) sets the coin's display name, a short pitch, a colour, a square logo, and the token
 *            it's paired with on Raydium LaunchLab: SOL, USDC or RAY. The ticker is never part of the design: it is
 *            the city's own, from the one list (src/tickers.js), so nobody can pick, change or copy another city's
 *            coin; a city the list does not know gets no design until it is added.
 *   Public   every design is public (GET /api/coins; the picture once approved) and every change is in the public log (/api/audit).
 *   Launch   once the coin is live, the founder submits its contract address; an admin who isn't that founder
 *            checks it and records it. From then on the design is locked, so it always matches the blockchain.
 *            That old Raydium LaunchLab path is closed while the Vicinity launchpad is set up (lpSetup, src/cluster.js), so no city
 *            can get a second coin through it: a founder can't send a contract (409 launchpad_only, nothing read or written), and an
 *            admin can't record one; a contract that was sent before can only be REJECTED, which settles the city (approvals skip
 *            it and launches wait while it waits: src/lpadmin.js, src/lplaunch.js). Such a rejection only clears what waits, so any
 *            admin may make it (the coin's own designer too: no city is left stuck when the one admin who can decide designed it),
 *            from the dashboard's queue or from the owner's City coins tab (which needs no home community), and it is logged and
 *            told to the founder in fixed, neutral words (settleLegacyContract, LEGACY_REJECTED: the contract is not judged). Every
 *            GET /api/coins answer says so while the path is closed (launchLabClosed: true), so a page never shows its words from a guess.
 *            On the Vicinity launchpad (src/lpcoins.js, only while its settings are there) the design locks earlier: from the
 *            moment the owner builds the on-chain approval, because the approval fixes the name and ticker on chain and the
 *            owner approved the design he saw (the description goes into the coin's /coin-meta JSON for ever).
 *   Pictures a founder's picture is checked by an admin before anyone sees it (src/logos.js): until it is approved, every public
 *            surface shows no picture (the site the city's initials, /coin-meta/<mint>.png the Vicinity badge for wallets); the
 *            founder and the staff see the working picture and its state.
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
import { ensureLogoSchema, ensureSchema } from "./store.js";
import { displayTicker, tickerOf, tickersAvailable } from "./tickers.js";
import { designFrozen, rebuildMetaJson } from "./lpcoins.js";
import { lpSetup } from "./cluster.js";
import { adminRoleOf } from "./admin.js";
import { clearedStatement, pendingStatement, publicLogo, rejectLogo, reviewView } from "./logos.js";
import { notify, pictureReason } from "./notify.js";

const C = POLICY.coins;

/** What a city coin can be paired with on Raydium LaunchLab. */
export const PAIRS = {
  SOL: { mint: "So11111111111111111111111111111111111111112", name: "Solana" },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USD Coin" },
  RAY: { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", name: "Raydium" },
};

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'’&-]*$/u;
const LINKISH = /https?:|www\.|\.[a-z]{2,}(\/|\b)/i;

/**
 * The public view of a coin (the contract waiting for a check is never shown: only that one is waiting). The picture is the approved
 * one or nothing, with the hash of its bytes (src/logos.js). `mine`: the founder or the staff also get the working picture and where
 * its check stands (logoStatus, logoDraft, logoReason, logoNote); nobody else ever sees a pending or rejected picture.
 */
export function coinView(row, { mine = false } = {}) {
  if (!row) return null;
  return {
    city: row.city_id, cityName: row.city_name, country: row.country,
    name: row.name, pitch: row.pitch || "", pair: row.pair, pairMint: PAIRS[row.pair]?.mint || null, color: row.color,
    ...publicLogo(row),
    mint: row.mint || null, launched: Boolean(row.mint), launchedAt: row.launched_at || null,
    waiting: Boolean(row.pending_mint), by: row.designer || null, updatedAt: row.updated_at,
    ...(mine ? reviewView(row) : {}),
  };
}
const SELECT = "SELECT c.*, COALESCE(u.handle, u.name) AS designer FROM city_coins c LEFT JOIN users u ON u.id = c.user_id";
export async function coinOf(db, cityId) {
  await ensureLogoSchema(db);
  return db.prepare(`${SELECT} WHERE c.city_id = ?`).bind(String(cityId)).first();
}
/** Is this signed-in person the coin's founder, or on the staff (owner, admin, moderator)? They see the working picture and its state. */
async function seesReview(env, u, row) {
  if (!u || !row) return false;
  return u.id === row.user_id || Boolean(await adminRoleOf(env, u.wallet));
}

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
  // the old Raydium LaunchLab path is closed here (lpSetup on): every answer says so (launchLabClosed: true), so the dashboard's words
  // about a coin come from the same answer as the coin, never from a second request that may fail. With the launchpad's settings off
  // the key does not exist and every answer is exactly as it always was (the path is open then).
  const closed = lpSetup(env).on ? { launchLabClosed: true } : {};
  if (!env.DB) return json({ coins: [], coin: null, pairs, vicinity, ...closed });
  await ensureSchema(env.DB);
  await ensureLogoSchema(env.DB);
  const q = new URL(request.url).searchParams;
  if (q.get("waiting")) {
    const a = await admin(request, env, now, fetchImpl, { write: false, fresh: false }); // a page load: browsers send no Origin on GET
    if (a.error) return a.error;
    const rows = (await env.DB.prepare(`${SELECT} WHERE c.pending_mint IS NOT NULL ORDER BY c.pending_at`).all()).results;
    return json({ ok: true, ...closed, waiting: rows.map((r) => ({ ...coinView(r, { mine: true }), pendingMint: r.pending_mint, pendingAt: r.pending_at, designerId: r.user_id })) });
  }
  if (q.get("city")) {
    // one city's coin is answered live (never cached): its founder and the staff also get the working picture and its state
    const row = await coinOf(env.DB, q.get("city"));
    let mine = false;
    if (row) { const a = await access(request, env, now, { write: false }); mine = !a.error && await seesReview(env, a.u, row); }
    return json({ coin: coinView(row, { mine }), pairs, vicinity, ...closed });
  }
  const rows = (await env.DB.prepare(`${SELECT} ORDER BY c.updated_at DESC LIMIT 20000`).all()).results;
  return json({ coins: rows.map((r) => coinView(r)), pairs, vicinity, ...closed });
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
  let frozen = null;
  try { frozen = await designFrozen(env, seat.city_id, fetchImpl, now); }
  catch (e) { console.error("coin design: approval check failed", String((e && e.message) || e).slice(0, 80)); return json({ ok: false, error: "chain_unavailable" }, 503); }
  if (frozen === "launched") return json({ ok: false, error: "coin_locked" }, 409);
  if (frozen) return json({ ok: false, error: frozen === "held" ? "coin_being_approved" : "coin_approved" }, 409);
  // the ticker is never part of the design: it is the city's own, from the one list (src/tickers.js), and the approval copies it on
  // chain. A city the list does not know gets no design (nothing here invents a ticker), only a plain answer; a list that cannot be
  // read right now is said as that (never "no ticker" about a city that has one).
  if (!(await tickersAvailable(env))) return json({ ok: false, error: "list_unavailable", message: "The city list could not be read just now. Try again in a minute." }, 503);
  if (!(await tickerOf(env, seat.city_id))) return json({ ok: false, error: "no_ticker", message: "This city has no ticker yet. Tell us and we will add it." }, 409);

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

  // the picture's review state (src/logos.js): a new picture waits for an admin's check (an earlier approved one keeps showing meanwhile);
  // removing the picture clears everything; otherwise the state stays as it is. One batch: the design and its state change together.
  const stmts = [db.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, media_id, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(city_id) DO UPDATE SET seat_id = excluded.seat_id, user_id = excluded.user_id, name = excluded.name, pitch = excluded.pitch,
        pair = excluded.pair, color = excluded.color, media_id = excluded.media_id, updated_at = excluded.updated_at`)
    .bind(seat.city_id, seat.city_name, seat.country, seat.id, u.id, name, pitch || null, body.pair, body.color, mediaId, iso(now), iso(now))];
  if (image) stmts.push(pendingStatement(db, seat.city_id));
  else if (body.removeLogo) stmts.push(clearedStatement(db, seat.city_id));
  await db.batch(stmts);
  await noteEvent(env, u.id, "coin_design", now);
  const changed = [
    !old || old.name !== name ? `name "${name}"` : null, !old || (old.pitch || "") !== pitch ? "pitch" : null,
    !old || old.pair !== body.pair ? `paired with ${body.pair}` : null, !old || old.color !== body.color ? `colour ${body.color}` : null,
    image ? "new logo (waiting for a check)" : !old || old.media_id !== mediaId ? (mediaId ? "logo" : "logo removed") : null,
  ].filter(Boolean);
  await log(db, { actor: u.id, role: "founder", action: "coin_design", user: u.id, country: seat.country, place: seat.city_id, reason: "design",
    note: `${seat.city_name}: ${changed.join(", ") || "saved"}`, at: iso(now) });
  return json({ ok: true, coin: coinView(await coinOf(db, seat.city_id), { mine: true }) });
}

/**
 * The old Raydium LaunchLab path (a founder submits a contract, an admin records it) while the Vicinity launchpad is set up
 * (lpSetup, the same gate that hides that path on the dashboard): 409 launchpad_only. A founder's submission is refused before
 * anything else, so nothing is read or written (not even the founder check, which can start a grace period); an admin's decision
 * is refused only when it would RECORD the contract (a rejection settles the city and goes through). With the launchpad's settings
 * off: null, and the path works exactly as before.
 */
function launchLabClosed(env, what) {
  if (!lpSetup(env).on) return null;
  return json({ ok: false, error: "launchpad_only", message: `City coins launch on the Vicinity launchpad now, so ${what}. Nothing was changed.` }, 409);
}
/**
 * The public log's words (after the city's name) for a waiting Raydium LaunchLab contract rejected while the launchpad is set up. Fixed
 * and neutral: such a contract may be a real coin sent in good faith before the launchpad existed, so it is never called spam or a scam;
 * it is only not recorded. The founder is told the same (a notice, src/notify.js). The address is never in either.
 */
export const LEGACY_REJECTED = "City coins launch on the Vicinity launchpad now; a contract from the old Raydium LaunchLab path is not recorded.";
/**
 * Settle a city whose Raydium LaunchLab contract still waits, while the launchpad is set up: the contract is cleared, never recorded;
 * the public log and the founder's notice say LEGACY_REJECTED; the address is in neither. One rule for both places an admin does it:
 * the dashboard's queue (POST /api/coins/mint/decide with approve false) and the owner's City coins tab (POST /api/admin/lp/legacy/reject,
 * src/lpadmin.js). The caller has checked who may (an admin). `mint`, when given, must still be the one waiting.
 * → { ok: true, coin } or { ok: false, error, status }.
 */
export async function settleLegacyContract(env, { cityId, mint = "", actorId, now = Date.now() }) {
  const db = env.DB;
  if (!lpSetup(env).on) return { ok: false, error: "not_enabled", status: 404 };
  const coin = await coinOf(db, String(cityId || ""));
  if (!coin || !coin.pending_mint) return { ok: false, error: "not_found", status: 404 };
  if (mint && mint !== coin.pending_mint) return { ok: false, error: "mint_changed", status: 409 };
  // matched on the address read just now: a founder can no longer send another one (src/coins.js handleProposeMint), but two
  // admins crossing clear it once and log it once
  const r = await db.prepare("UPDATE city_coins SET pending_mint = NULL, pending_at = NULL WHERE city_id = ? AND pending_mint = ?").bind(coin.city_id, coin.pending_mint).run();
  if (!r.meta.changes) return { ok: false, error: "not_found", status: 404 };
  await log(db, { actor: actorId, role: "admin", action: "coin_contract_rejected", user: coin.user_id, country: coin.country, place: coin.city_id, reason: "launch",
    note: `${coin.city_name}: ${LEGACY_REJECTED}`, at: iso(now) });
  // in-app notice (NOTIFY=on) to the founder who sent it: their card simply stops saying it waits, so they are told why, in the same words
  await notify(env, { to: coin.user_id, kind: "founder", ref: coin.city_id, href: "/dashboard#founder", now, text: `${coin.city_name}: ${LEGACY_REJECTED}` });
  return { ok: true, coin: coinView(await coinOf(db, coin.city_id), { mine: true }) };
}

/** POST /api/coins/mint { mint } — the founder: "our coin is live, this is its contract". An admin checks it. */
export async function handleProposeMint(request, env, fetchImpl = fetch, now = Date.now()) {
  const closed = launchLabClosed(env, "a Raydium LaunchLab contract can't be added here");
  if (closed) return closed;
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
  return json({ ok: true, coin: coinView(await coinOf(db, seat.city_id), { mine: true }) });
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
  // while the launchpad is set up a rejection only clears what waits (nothing can be recorded then), so the coin's designer may make
  // it too when they are an admin: otherwise a city whose designer is the one admin who can decide would stay stuck for good. It is
  // logged in fixed, neutral words, whatever note or reason was sent (settleLegacyContract)
  if (body.approve !== true && lpSetup(env).on) {
    const st = await settleLegacyContract(env, { cityId: coin.city_id, mint: typeof body.mint === "string" ? body.mint.trim() : "", actorId: a.u.id, now });
    return st.ok ? json({ ok: true, coin: st.coin }) : json({ ok: false, error: st.error }, st.status);
  }
  if (coin.user_id === a.u.id) return json({ ok: false, error: "needs_second_person" }, 403);
  // while the launchpad is set up a waiting contract is never recorded as the city's coin (one city, one coin); rejecting it (above)
  // settles the city, so its coin can be approved and launched on the Vicinity launchpad
  if (body.approve === true) { const closed = launchLabClosed(env, "a waiting Raydium LaunchLab contract can only be rejected, not recorded"); if (closed) return closed; }
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
  return json({ ok: true, coin: coinView(await coinOf(db, coin.city_id), { mine: true }) });
}

/**
 * POST /api/coins/takedown { city, what: "logo" | "text", reason, note } — an admin removes a logo or text that breaks the rules.
 * A logo takedown is a rejection (src/logos.js): the public picture goes at once (caches keep it at most an hour), the founder sees
 * the reason and the note on their dashboard and can replace the picture, which then waits for a check like any other. A newer
 * working picture that waits for its check is left waiting (nobody has looked at it). A coin without any picture has nothing to take
 * down: 404. The note here is PUBLIC (it goes into the mod log with the city's name, as it always did), unlike a Pictures-queue note,
 * which only the founder sees.
 */
export async function handleTakedown(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await admin(request, env, now, fetchImpl);
  if (a.error) return a.error;
  const db = env.DB, body = await readJson(request);
  const coin = body && await coinOf(db, String(body.city || ""));
  if (!coin) return json({ ok: false, error: "not_found" }, 404);
  const reason = POLICY.moderation.reasons.includes(body.reason) ? body.reason : null;
  const note = cleanText(body.note, 300);
  if (!reason || note == null || note.length < 3) return json({ ok: false, error: "reason_required" }, 400);
  if (body.what === "logo") {
    if (!coin.media_id && !coin.approved_media_id) return json({ ok: false, error: "not_found" }, 404);
    await rejectLogo(db, coin.city_id, { reason, note, by: a.u.id, at: now, takedown: true });
    await db.prepare("UPDATE city_coins SET updated_at = ? WHERE city_id = ?").bind(iso(now), coin.city_id).run();
    // in-app notice (NOTIFY=on) to the founder, with the public reason (the note is on their coin card and in the public log)
    await notify(env, { to: coin.user_id, kind: "picture", ref: coin.city_id, href: "/dashboard#founder", now, text: `Your coin picture was taken down: ${pictureReason(reason)}.` });
  }
  else if (body.what === "text" && !coin.mint) await db.prepare("UPDATE city_coins SET name = city_name, pitch = NULL, updated_at = ? WHERE city_id = ?").bind(iso(now), coin.city_id).run();
  else if (body.what === "text" && coin.pitch && (await recordedOnLaunchpad(env, coin.mint))) {
    // a coin launched on the Vicinity launchpad: its name is on chain for ever, but its description lives in the /coin-meta JSON
    // this site serves, so the description is removed there too (rebuilt with the default text; caches keep the old one an hour)
    await db.prepare("UPDATE city_coins SET pitch = NULL, updated_at = ? WHERE city_id = ?").bind(iso(now), coin.city_id).run();
    if (!(await rebuildMetaJson(env, coin.mint, now))) return json({ ok: false, error: "unavailable" }, 503);
  }
  else return json({ ok: false, error: body.what === "text" ? "coin_locked" : "bad_request" }, 400);
  await log(db, { actor: a.u.id, role: "admin", action: `coin_${body.what}_removed`, user: coin.user_id, country: coin.country, place: coin.city_id,
    reason, note: `${coin.city_name}: ${note}`, at: iso(now) });
  return json({ ok: true, coin: coinView(await coinOf(db, coin.city_id), { mine: true }) });
}

/** Is this mint a coin recorded from the Vicinity launchpad (lp_coins), whatever the settings say now? */
async function recordedOnLaunchpad(env, mint) {
  try { return Boolean(await env.DB.prepare("SELECT 1 FROM lp_coins WHERE mint = ?").bind(mint).first()); }
  catch (e) { if (/no such table/i.test(String(e && e.message))) return false; throw e; }
}

/**
 * For the link checker: the recorded city coin at this address, as an "official" answer with its city and ticker,
 * or null when it is not one. A contract still waiting for an admin's check is not official yet.
 */
export async function officialCityCoin(env, address) {
  if (!env.DB || !isSolanaAddress(address)) return null;
  let row, ticker = null;
  try {
    await ensureSchema(env.DB);
    row = await env.DB.prepare("SELECT city_id, city_name, country, name FROM city_coins WHERE mint = ?").bind(address).first();
  } catch (e) {
    // The checker is the one safety feature a scam target reaches for, so a database problem must not make it fail:
    // the list's own verdict (not official) stands. A short code only, never the address.
    console.error("city coin lookup skipped", String((e && e.message) || e).slice(0, 80));
    return null;
  }
  if (!row) return null;
  try { ticker = (await displayTicker(env, { cityId: row.city_id, mint: address }))?.ticker || null; } catch { ticker = null; } // the coin is official with or without its ticker
  const where = `${row.city_name}${row.country ? `, ${row.country}` : ""}`;
  return {
    verdict: "official", kind: "city_coin", city: row.city_id, cityName: row.city_name, country: row.country, ticker, name: row.name,
    message: ticker
      ? `This is the official $${ticker}: the city coin of ${where}, recorded by Vicinity.`
      : `This is the official city coin of ${where}, recorded by Vicinity.`,
  };
}

// Jupiter's price API. The address and key come from the settings JUPITER_API_BASE and JUPITER_API_KEY (the
// keyless lite address is being retired); the last price seen per token is kept for 5 minutes so a rate limit
// or an outage does not blank every estimate on the swap panel.
const JUPITER_BASE = "https://lite-api.jup.ag";
const PRICE_TIMEOUT_MS = 3000, LAST_GOOD_MS = 5 * 60_000, LAST_GOOD_MAX = 500;
const lastGood = new Map(); // mint → { price, at }, oldest first
export const _resetPrices = () => lastGood.clear();

/** The tokens a /api/prices request asks about: unique, in the order asked, at most 6. */
export const wantedMints = (request) => [...new Set(String(new URL(request.url).searchParams.get("mints") || "").split(",").filter(isSolanaAddress))].slice(0, 6);

/**
 * US-dollar prices for some tokens: { prices: { mint → number | null }, stale }. Never throws. When Jupiter answers
 * with an error, times out or is unreachable, the last price it gave for each token (at most 5 minutes old) is
 * answered instead and stale is true.
 */
export async function jupiterPrices(env, mints, fetchImpl = fetch, now = Date.now()) {
  const prices = Object.fromEntries(mints.map((m) => [m, null]));
  if (!mints.length) return { prices, stale: false, failed: false };
  const base = String((env && env.JUPITER_API_BASE) || JUPITER_BASE).replace(/\/+$/, "");
  const headers = env && env.JUPITER_API_KEY ? { "x-api-key": String(env.JUPITER_API_KEY) } : {};
  try {
    const res = await fetchImpl(`${base}/price/v3?ids=${mints.join(",")}`, { headers, signal: AbortSignal.timeout(PRICE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`jupiter_http_${res.status}`);
    const d = await res.json();
    for (const m of mints) {
      const p = Number(d?.[m]?.usdPrice);
      if (!Number.isFinite(p) || p <= 0) continue;
      prices[m] = p;
      lastGood.delete(m); lastGood.set(m, { price: p, at: now });
    }
    while (lastGood.size > LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value);
    return { prices, stale: false, failed: false };
  } catch { /* prices are a nice-to-have: the swap page always shows the exact amount */ }
  let stale = false;
  for (const m of mints) {
    const g = lastGood.get(m);
    if (g && now - g.at < LAST_GOOD_MS) { prices[m] = g.price; stale = true; }
  }
  return { prices, stale, failed: true }; // failed: the call itself did not succeed (callers may cache this answer only briefly)
}

/** The launched city coins (an admin recorded the contract): with the live $VICINITY mint, the only mints a portfolio may ask about. */
export async function launchedCoins(db, limit = 300) {
  return (await db.prepare("SELECT city_id, city_name, country, name, mint FROM city_coins WHERE mint IS NOT NULL ORDER BY launched_at, city_id LIMIT ?").bind(limit).all()).results;
}

/** Prices in US dollars for the tokens the swap panel shows (only those: $VICINITY, the pairs, launched city coins). */
export async function handlePrices(request, env, fetchImpl = fetch) {
  const wanted = wantedMints(request);
  const allowed = new Set([activeMint(env), ...Object.values(PAIRS).map((p) => p.mint)].filter(Boolean));
  if (env.DB && wanted.some((m) => !allowed.has(m))) {
    await ensureSchema(env.DB);
    for (const m of wanted) if (!allowed.has(m) && await env.DB.prepare("SELECT 1 FROM city_coins WHERE mint = ?").bind(m).first()) allowed.add(m);
  }
  const mints = wanted.filter((m) => allowed.has(m));
  const { prices, stale } = await jupiterPrices(env, mints, fetchImpl);
  return json(stale ? { prices, stale: true } : { prices }, 200, { "Cache-Control": "public, max-age=30" });
}
