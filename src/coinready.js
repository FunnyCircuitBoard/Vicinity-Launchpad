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
 *                                        stillFounder, and a low balance is said as that, below_amount; no table is made; no
 *                                        picture is drawn). Everyone, the founder too: `preview`, labelled "Preview, not launched",
 *                                        only for a city that has a founder and whose coin this IS (previewOf: none for a launched
 *                                        coin, a waiting Raydium LaunchLab contract, or a design row that is not the chosen ready-made
 *                                        version, such as an earlier studio design or one approved before the switch), with the
 *                                        chosen version's own ticker, name and picture, or the defaults' (the picture only when one was
 *                                        already made). Counted per connection (coin_ready, 60 a minute).
 *   POST /api/coins/ready/art {cityId}   the founder's page asks for its picture the first time: drawn ONCE per version (SVG SHA-256
 *                                        + template version) and stored (coin_art). Never drawn on a GET or for anyone else.
 *                                        20 an hour per account (atomic counter, counted before the work).
 *   POST /api/coins/ready/use {cityId, contentHash}   "Use this coin" (a wallet proof in the last 30 minutes). The page sends the
 *                                        hash of the version it showed; anything changed since (the list, the template) is 409
 *                                        coin_changed and nothing is written. Every write of it is conditional, in the database
 *                                        itself, on the design row being untouched, not launched, with no LaunchLab contract waiting
 *                                        and no live hold of the owner's approval (src/lpcoins.js holdDesign): an approval being
 *                                        built meanwhile wins, and nothing of the choice is written (409 held). A new founder of the
 *                                        city chooses again (the choice names its seat). 10 a day per account (atomic counter).
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
import { designFrozen, unknownSymbols } from "./lpcoins.js";
import { decodeApproval } from "./lpadmin.js";
import { lpSetup } from "./cluster.js";
import { lpRpc } from "./lpkit.js";
import { launchpad as launchpadPdas } from "./sol/pda.js";
import { tickerOf, tickersAvailable } from "./tickers.js";
import { DEFAULT_PAIR, SOURCE, coinDefaults } from "./coindefaults.js";
import { TEMPLATE_VERSION, coinSvg, sha256Hex } from "./coinart.js";
import { approvedBasis, approvedRequest, artBySvg, artPath, chosenOf, ensureReadySchema, storeArtStatement } from "./coinart-store.js";
import { coinV2BatchOn, coinV2ReadyOn, coinV2ReviewOn } from "./flags.js";
import { pendingRequest, reviewState } from "./coinreview.js";

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
  below_amount: "Your balance is below the founder amount. Hold it again to choose your coin; if it stays below, your seat enters its grace period.",
  banned: "You can't choose or launch a coin while your account is suspended. The Home tab shows until when, and how to appeal.",
  launched: "This city's coin has launched. Its design is fixed for good.",
  legacy_contract: "A contract for this city is waiting for a check. Nothing can launch until that's settled.",
  symbol_taken: "This ticker is already launched, approved or chosen for another city. Tell us and we'll sort it out before anything launches.",
  ticker_unchecked: "We couldn't confirm that this ticker isn't already launched for another city. Nothing changed. Try again in a minute.",
  approved: "Your coin is approved on the blockchain with its current design. It launches exactly as approved.",
  // an approval on chain for a wallet that is not this founder's (a seat that changed hands before the owner revoked it): it cannot be
  // launched by them, and nothing else can be approved for the city while it stands
  approved_other: "This city's coin is approved on the blockchain for another wallet than yours (the founder's wallet when it was approved). Vicinity's owner must revoke that approval before you can choose and launch your coin.",
  held: "The owner is approving your coin right now, so its design is fixed for a few minutes. Try again in 5 minutes.",
  rpc_unavailable: "We couldn't check the blockchain just now. Nothing changed. Try again in a minute.",
  // COIN_V2_REVIEW: a change request (or a description) the founder sent waits for a reviewer: launch and other changes wait
  request_pending: "Your change request is waiting for review. Launch and other changes wait until a reviewer decides; you can cancel the request.",
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
export async function renderPng(svg) {
  const render = rendererOverride || (await import("./coinart-wasm.js")).render;
  const t0 = Date.now();
  const png = await render(svg);
  console.log("coin art drawn", `${png.length} bytes`, `${Date.now() - t0} ms`);
  return png;
}
// the city line is the coin's name (the registry name, or its shortened form: src/coindefaults.js NAME_OVERRIDES), never a name the
// coin itself does not carry
export const svgOf = (d, templateVersion = TEMPLATE_VERSION) => coinSvg({ ticker: d.ticker, city: d.name, templateVersion });
/** The stored picture of a coin's defaults: { sha256 } or null. Reads only. */
export async function storedArt(env, d) {
  const svg = svgOf(d);
  const row = await artBySvg(env.DB, await sha256Hex(svg), TEMPLATE_VERSION);
  return row ? { sha256: row.sha256 } : null;
}
/** The picture of a coin's defaults, drawn and stored now if it never was (only from a POST of the switch; every read fresh). */
export async function ensureArt(env, d, now) {
  const svg = svgOf(d), svgSha = await sha256Hex(svg);
  const known = await artBySvg(env.DB, svgSha, TEMPLATE_VERSION, { fresh: true });
  if (known) return { sha256: known.sha256 };
  const png = await renderPng(svg);
  const sha = await sha256Hex(png);
  await storeArtStatement(env.DB, { sha256: sha, svgSha256: svgSha, templateVersion: TEMPLATE_VERSION, bytes: png, now }).run();
  // two servers drawing at once both write the same bytes under the same name; the (svg, version) row that won is the one served
  const row = await artBySvg(env.DB, svgSha, TEMPLATE_VERSION, { fresh: true });
  return { sha256: row ? row.sha256 : sha };
}

/* ---------------------------------------------------------------- checks */
const cityIdOk = (v) => typeof v === "string" && /^\d{1,19}$/.test(v) && BigInt(v) > 0n && BigInt(v) < (1n << 64n) - 1n;
const optional = async (run) => { try { return await run(); } catch (e) { if (/no such table/i.test(String((e && e.message) || e))) return null; throw e; } };
/** The city's coin as the site knows it: { mint, pending } (a launched coin, or a Raydium LaunchLab contract waiting for a check). */
export async function coinState(env, cityId) {
  const row = await env.DB.prepare("SELECT mint, pending_mint FROM city_coins WHERE city_id = ?").bind(cityId).first();
  const lp = await optional(() => env.DB.prepare("SELECT mint FROM lp_coins WHERE city_id = ? LIMIT 1").bind(cityId).first());
  return { launched: Boolean((row && row.mint) || lp), pending: Boolean(row && row.pending_mint) };
}
/**
 * Is `symbol` already another city's: launched (lp_coins), approved on chain by the owner and not revoked since (lp_approvals_log), or
 * chosen with "Use this coin" (coin_ready)? The registry gives every city its own ticker, but a regenerated list could move one
 * (scripts/cities/tickers.mjs pins every launched one), so this is checked again before anything is recorded. Launched and approved
 * coins count on this site's own launchpad only (lpSetup's cluster and program: a row of another network can never launch here).
 * `chain`: a recorded coin whose symbol was never read is read from the chain now (the POSTs and the owner's list); without it (a GET,
 * a preview) only what is stored is looked at, and the write that follows checks it all again.
 */
export async function symbolTaken(env, cityId, symbol, fetchImpl = fetch, { chain = true } = {}) {
  const db = env.DB, c = String(cityId), s = lpSetup(env);
  // a recorded coin whose symbol was never read (lp_coins.symbol NULL) is read from the chain now; one still unknown may be this ticker
  if (chain && (await unknownSymbols(env, c, fetchImpl)).length) return "unknown";
  if (await optional(() => db.prepare("SELECT city_id FROM lp_coins WHERE symbol = ? AND city_id <> ? AND cluster = ? AND program_id = ? LIMIT 1")
    .bind(symbol, c, String(s.cluster || ""), String(s.programId || "")).first())) return "launched";
  if (await optional(() => db.prepare(`SELECT a.city_id FROM lp_approvals_log a WHERE a.action = 'approve' AND a.symbol = ? AND a.city_id <> ? AND a.cluster = ? AND a.program_id = ?
      AND NOT EXISTS (SELECT 1 FROM lp_approvals_log b WHERE b.city_id = a.city_id AND b.cluster = a.cluster AND b.program_id = a.program_id
        AND b.action = 'revoke' AND b.id > a.id) LIMIT 1`).bind(symbol, c, String(s.cluster || ""), String(s.programId || "")).first())) return "approved";
  // (a coin_ready made before approved_hash existed is read as "not approved": a GET never alters a table, src/coinart-store.js)
  const sql = (approved) => `SELECT city_id, mint, content_hash, ${approved} AS approved_hash FROM coin_ready WHERE symbol = ? AND city_id <> ?`;
  const chosen = await optional(async () => {
    try { return await db.prepare(sql("approved_hash")).bind(symbol, c).all(); }
    catch (e) { if (/no such column/i.test(String((e && e.message) || e))) return db.prepare(sql("NULL")).bind(symbol, c).all(); throw e; }
  });
  for (const r of (chosen && chosen.results) || []) if (!(await staleChoice(env, r, symbol))) return "chosen";
  return null;
}
/**
 * Another city's choice (a coin_ready row) that no longer holds its ticker: not launched with it (no mint), no approval built from it
 * (approved_hash), and the city list has given that city another ticker since (pins keep only launched ones). Such a row can neither be
 * approved nor launched ("no longer matches the city list", src/lpadmin.js), so it never keeps the ticker from the city that has it now.
 * A list that cannot be read keeps every row (never assumed stale).
 */
async function staleChoice(env, r, symbol) {
  if (r.mint || (r.approved_hash && r.approved_hash === r.content_hash)) return false;
  // a ticker change a reviewer approved (COIN_V2_REVIEW): that city keeps it while the city list catches up (D8), whatever any switch says
  if (await approvedRequest(env.DB, r.city_id, r.content_hash)) return false;
  const t = await tickerOf(env, r.city_id);
  if (!t) return tickersAvailable(env); // not in the list any more: stale; the list unreadable: kept
  return t.ticker !== symbol;
}
/** A released choice's symbol: "~" and the city id. Never a ticker (A-Z0-9 only), one per city, so coin_ready's UNIQUE holds. */
export const releasedSymbol = (cityId) => `~${cityId}`;
const gate = (code) => ({ code, message: GATES[code] });
/**
 * Why the founder cannot use the coin now, or null. `live`: the founder-amount check already made (true / false / "error").
 * Reads only (the GET's and the POSTs' common part).
 */
async function coinGate(env, { u, seat, d, live, cityId, fetchImpl, now, chain = true }) {
  if (!u.wallet) return gate("no_wallet");
  if (u.wallet !== seat.wallet) return gate("wallet_mismatch");
  // the grace period is named only when the seat is in it; a balance that is merely low (seen by a route that starts nothing) is said as that
  if (seat.status === "grace") return gate("in_grace");
  if (!LIVE.includes(seat.status)) return gate("not_founder");
  if (live === "error") return gate("rpc_unavailable");
  if (!live) return gate(stewardInGrace(seat, now) ? "in_grace" : "below_amount");
  if ((await activeBan(env.DB, u.id, u.home_country, now)) || (await activeBan(env.DB, u.id, seat.country, now))) return gate("banned");
  if (!d.ok) return { code: d.code, message: d.message };
  if (coinV2ReviewOn(env) && (await pendingRequest(env.DB, cityId))) return gate("request_pending");
  const st = await coinState(env, cityId);
  if (st.launched) return gate("launched");
  if (st.pending) return gate("legacy_contract");
  const taken = await symbolTaken(env, cityId, d.ticker, fetchImpl, { chain });
  if (taken) return gate(taken === "unknown" ? "ticker_unchecked" : "symbol_taken");
  let frozen;
  try { frozen = await designFrozen(env, cityId, fetchImpl, now); } catch { return gate("rpc_unavailable"); }
  if (frozen === "launched") return gate("launched");
  if (frozen === "held") return gate("held"); // the owner is building an approval from the chosen version (src/lpadmin.js approveTx)
  if (frozen) return approvedGate(env, { seat, cityId, fetchImpl });
  return null;
}
/**
 * The city's Approval is on chain: what it means for THIS founder. "approved" only when it is theirs (their wallet) and was built from
 * the version they chose, which is still the design (exactly what src/coinart-store.js bindVersion publishes at the launch); for another
 * wallet, approved_other; built from anything else (a studio design approved before the switch, or one approved with the switch off),
 * approved_earlier, naming what is approved: that is what launches, not the coin on the card.
 */
async function approvedGate(env, { seat, cityId, fetchImpl }) {
  const s = lpSetup(env);
  let ap;
  try {
    const r = await lpRpc(env, "getAccountInfo", [await launchpadPdas(s.programId).approval(BigInt(cityId)), { encoding: "base64", commitment: "confirmed" }], fetchImpl);
    ap = decodeApproval(r && r.value, s.programId);
  } catch { return gate("rpc_unavailable"); }
  if (!ap) return gate("rpc_unavailable"); // seen a moment ago, unreadable now (used or revoked meanwhile): the next look says
  if (ap.founder !== seat.wallet) return gate("approved_other");
  const c = await chosenOf(env.DB, cityId, { fresh: true });
  if (c && c.current && c.approved_hash === c.content_hash && c.name === ap.name && c.symbol === ap.symbol) return gate("approved");
  return { code: "approved_earlier",
    message: `Your city's coin is approved on the blockchain as “${ap.name}” ($${ap.symbol}), but not with the Vicinity coin shown here. It launches as approved, with the design it was approved with.` };
}
const liveCheck = async (env, seat, fetchImpl) => { try { return await holdsFounderAmount(env, seat, fetchImpl); } catch { return "error"; } };
/** A steward's seat in its grace period (stewards stay stewards in grace, with a deadline ahead: src/seats.js enterGrace). */
const stewardInGrace = (seat, now) => seat.status === "steward" && Boolean(seat.grace_until) && Date.parse(seat.grace_until) > now;

/* ---------------------------------------------------------------- the answers */
// user_id: the account that saved the row last (a studio save or "Use this coin" writes its own), so a page can tell the founder's own
// earlier design from a former founder's
const designRowOf = (env, cityId) => env.DB.prepare("SELECT updated_at, user_id FROM city_coins WHERE city_id = ?").bind(String(cityId)).first();
/**
 * The preview of the coin this city WILL launch, or null (the one rule for the founder's page and everyone else's; reads only, no
 * chain read). Only for a city that has a founder; never for a launched coin (shown as itself), a city with a Raydium LaunchLab
 * contract waiting (it may have that coin already), or a city whose design row is not the chosen ready-made version (an earlier studio
 * design, one approved on chain before the switch, or one changed since the choice: the approval path takes that row, not this
 * coin). The chosen version counts only while the city list still gives the city its ticker and name (the rule the owner's list
 * applies: src/lpadmin.js candidateList; a version the list moved away from can never be approved) and no approval the owner gave the
 * city stands for something else (lp_approvals_log: an approval built with the switch off, or before the choice). It is shown with its
 * own ticker, name and picture; with no design row yet, the defaults.
 */
async function previewOf(env, cityId, { seat, d, c, design }) {
  if (!seat || !["active", "steward", "grace"].includes(seat.status)) return null;
  const st = await coinState(env, cityId);
  if (st.launched || st.pending) return null;
  const chosenNow = Boolean(c && c.current && c.content && d && d.ok && c.symbol === d.ticker && (c.name === d.name || (await reviewedName(env, cityId, c))));
  if (design && !chosenNow) return null;
  if (chosenNow && c.approved_hash !== c.content_hash && (await approvalLogged(env, cityId))) return null;
  // a ticker another city launched, holds an approval for or chose cannot launch here: no preview of it
  const ticker = chosenNow ? c.symbol : d && d.ok ? d.ticker : null;
  if (ticker && (await symbolTaken(env, cityId, ticker, fetch, { chain: false }))) return null;
  if (chosenNow) {
    const city = c.content.city || {};
    return { label: PREVIEW_LABEL, ticker: c.symbol, name: c.name, description: c.description, chosen: true, version: versionLabel(c.content_hash),
      city: { name: city.name || null, region: city.region || null, countryName: city.countryName || null }, art: artPath(c.art_sha256) };
  }
  if (!d || !d.ok) return null;
  const art = await storedArt(env, d);
  return { label: PREVIEW_LABEL, ticker: d.ticker, name: d.name, description: d.description, chosen: false,
    city: { name: d.city.name, region: d.city.region, countryName: d.city.countryName }, art: art ? artPath(art.sha256) : null };
}
/**
 * An approval the owner gave this city on this launchpad and did not revoke since (lp_approvals_log), or none. `of`: { symbol, name }
 * only one naming exactly these. Reads only.
 */
async function approvalLogged(env, cityId, of = null) {
  const s = lpSetup(env);
  if (!s.on) return false;
  const named = of ? " AND a.symbol = ? AND a.name = ?" : "";
  return Boolean(await optional(() => env.DB.prepare(`SELECT a.id FROM lp_approvals_log a WHERE a.action = 'approve' AND a.city_id = ? AND a.cluster = ? AND a.program_id = ?${named}
      AND NOT EXISTS (SELECT 1 FROM lp_approvals_log b WHERE b.city_id = a.city_id AND b.cluster = a.cluster AND b.program_id = a.program_id
        AND b.action = 'revoke' AND b.id > a.id) LIMIT 1`).bind(String(cityId), s.cluster, s.programId, ...(of ? [of.symbol, of.name] : [])).first()));
}
/**
 * Does a city's choice that is not launched and is still its design row (src/coinart-store.js madeByOf) still hold, so a page may call
 * the coin chosen? The rule of previewOf and the owner's list (src/lpadmin.js candidateList): its ticker and its version's name are the
 * city list's now (src/coindefaults.js; `country`: the design row's). One the list moved away from can never be approved ("no longer
 * matches the city list"): the founder's card offers the new version, and no page says the coin is chosen. An approval the owner gave
 * on chain from this very version (approved_hash, recorded in lp_approvals_log with its ticker and name, not revoked since) holds
 * whatever the list says now: that is what launches. A list that cannot be read keeps the choice (never assumed stale, as staleChoice).
 * `choice`: chosenOf's or readyChoices' row. Reads only.
 */
export async function choiceHolds(env, { cityId, country }, choice) {
  if (!choice) return false;
  if (choice.approved_hash && choice.approved_hash === choice.content_hash && (await approvalLogged(env, cityId, { symbol: choice.symbol, name: choice.name }))) return true;
  const d = await coinDefaults(env, cityId, country);
  if (!d.ok) return d.code === "list_unavailable";
  return choice.symbol === d.ticker && (choice.name === d.name || (await reviewedName(env, cityId, choice)));
}
/**
 * COIN_V2_REVIEW on: a chosen version whose name a reviewer approved (an approved change with exactly its name, ticker and picture) holds
 * like the defaults do, once the city list carries its ticker. Off: never (only Vicinity's defaults hold, as in stage 1).
 */
async function reviewedName(env, cityId, c) {
  if (!coinV2ReviewOn(env) || !c || !c.art_sha256) return false;
  return Boolean(await approvedBasis(env.DB, cityId, { name: c.name, symbol: c.symbol, art: c.art_sha256 }));
}
/**
 * The card's coin for a chosen version (its own content, as it was chosen): what an approval built from it fixes and what its launch
 * publishes. The current defaults may have moved since (a renamed region, a new description), but neither changes an approved or
 * launched coin.
 */
function versionCoin(c, d) {
  const city = (c.content && c.content.city) || {};
  return {
    city: { id: String(city.id || c.city_id), name: city.name || null, region: city.region || null, regionCode: d && d.ok && d.city.id === String(city.id) ? d.city.regionCode || null : null,
      country: city.country || null, countryName: city.countryName || null },
    coin: { ticker: c.symbol, name: c.name, description: c.description, pair: (c.content && c.content.pair) || DEFAULT_PAIR, templateVersion: c.template_version, source: SOURCE,
      art: artPath(c.art_sha256), contentHash: c.content_hash, version: versionLabel(c.content_hash) },
  };
}
async function founderView(env, { u, seat, cityId, fetchImpl, now, live, chain = true }) {
  const d = await coinDefaults(env, cityId, seat.country);
  const g = await coinGate(env, { u, seat, d, live, cityId, fetchImpl, now, chain });
  const c = await chosenOf(env.DB, cityId, { fresh: true });
  const design = await designRowOf(env, cityId);
  const preview = await previewOf(env, cityId, { seat, d, c, design });
  // chosen: the city's choice, with its own words; mine: chosen with THIS founder's seat (a former founder's choice is not theirs)
  const chosen = c ? { contentHash: c.content_hash, version: versionLabel(c.content_hash), at: c.chosen_at, current: c.current, art: artPath(c.art_sha256), launched: Boolean(c.mint),
    ticker: c.symbol, name: c.name, mine: c.seat_id === seat.id } : null;
  // the city's design row is not the chosen ready-made coin (a studio design made before; it is kept, but it is not launched): earlier
  // when this founder's own account saved it, earlierOther when another did (a former founder of the city: never "your earlier design")
  const aside = Boolean(design && !(c && c.current));
  const earlier = aside && String(design.user_id) === String(u.id), earlierOther = aside && !earlier;
  // approved from the chosen version (or being approved right now), or launched with it: the card shows THAT version, which is what
  // launches or launched, never the defaults as they read today
  // COIN_V2_REVIEW: this founder's own chosen version that is not Vicinity's defaults (an approved change, their screened description) is
  // their coin: shown as it is, in use
  const reviewed = coinV2ReviewOn(env) && c && c.content && c.current && c.seat_id === seat.id && c.origin && c.origin !== "default";
  if (c && c.content && ((c.current && g && ["approved", "held"].includes(g.code)) || c.mint || reviewed)) {
    const v = versionCoin(c, d);
    return { ok: true, mode: "founder", city: v.city, coin: v.coin, chosen, inUse: Boolean(chosen.current && chosen.mine), earlier, earlierOther, gate: g, preview };
  }
  if (!d.ok) return { ok: true, mode: "founder", city: { id: cityId, name: seat.city_name, country: seat.country }, coin: null, chosen, inUse: false, earlier, earlierOther, gate: g, preview };
  const art = await storedArt(env, d);
  const contentHash = art ? await sha256Hex(canonicalContent({ city: d.city, name: d.name, symbol: d.ticker, description: d.description, artSha256: art.sha256, templateVersion: TEMPLATE_VERSION })) : null;
  return {
    ok: true, mode: "founder",
    city: { id: d.city.id, name: d.city.name, region: d.city.region, regionCode: d.city.regionCode, country: d.city.country, countryName: d.city.countryName },
    coin: { ticker: d.ticker, name: d.name, description: d.description, pair: d.pair, templateVersion: TEMPLATE_VERSION, source: SOURCE,
      art: art ? artPath(art.sha256) : null, contentHash, version: versionLabel(contentHash) },
    chosen, inUse: Boolean(chosen && chosen.current && chosen.mine && contentHash && chosen.contentHash === contentHash), earlier, earlierOther, gate: g, preview,
  };
}
/** The founder's answer: their view, and with COIN_V2_REVIEW on the review state (src/coinreview.js reviewState: requests, description, holds). */
export async function founderAnswer(env, { u, seat, cityId, fetchImpl = fetch, now = Date.now(), live = true, chain = true }) {
  const view = await founderView(env, { u, seat, cityId, fetchImpl, now, live, chain });
  // COIN_V2_BATCH: approvals come in the owner's rounds (src/lpbatch.js); the card says the launch opens after the next one (no time)
  const round = coinV2BatchOn(env) ? { approvalRound: true } : null;
  if (!coinV2ReviewOn(env)) return round ? { ...view, ...round } : view;
  return { ...view, review: await reviewState(env, { u, seat, cityId, view, now }), ...(round || {}) };
}
async function previewView(env, cityId) {
  const seat = await liveSeatOfCity(env.DB, cityId);
  if (!seat) return { ok: true, mode: "preview", preview: null };
  const d = await coinDefaults(env, cityId, seat.country);
  const c = await chosenOf(env.DB, cityId);
  return { ok: true, mode: "preview", preview: await previewOf(env, cityId, { seat, d, c, design: await designRowOf(env, cityId) }) };
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
    // a GET reads no unknown symbol from the chain (nor writes one): the POSTs and the owner's list do, and refuse while one is unknown
    return json(await founderAnswer(env, { u: a.u, seat, cityId, fetchImpl, now, live, chain: false }), 200, headers);
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
  if (!live) return fail("below_amount", 403); // looked at only: no grace period starts here
  const d = await coinDefaults(env, w.cityId, seat.country);
  if (!d.ok) return json({ ok: false, error: d.code, message: d.message }, d.code === "list_unavailable" ? 503 : 409);
  await ensureReadySchema(env.DB);
  await ensureArt(env, d, now);
  return json(await founderAnswer(env, { u: w.u, seat, cityId: w.cityId, fetchImpl, now, live }), 200, { "Cache-Control": "no-store" });
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
  const view = () => founderAnswer(env, { u, seat, cityId, fetchImpl, now, live: true });
  // the founder confirms exactly what their page showed: a list or template change since then is a new version, shown first
  if (echo !== hash) return json({ ...(await view()), ok: false, error: "coin_changed", message: "Your coin changed since this page loaded. Check it again, then use it." }, 409);
  const before = await chosenOf(env.DB, cityId, { fresh: true });
  // already this founder's choice and still the design: nothing to write. A choice made with another seat (a former founder's) is made
  // again, so the design row names this founder's seat (the owner approves only a design of the current founder: src/lpadmin.js)
  if (before && before.current && before.content_hash === hash && before.seat_id === seat.id) return json({ ...(await view()), already: true });

  const db = env.DB;
  const { stmts } = await choiceStatements(env, { cityId, seat, userId: u.id, before, now,
    v: { content, hash, name: d.name, symbol: d.ticker, description: d.description, artSha: art.sha256, templateVersion: TEMPLATE_VERSION, origin: "default" },
    log: { actorId: u.id, role: "founder", action: "coin_design", reason: "design", note: `${seat.city_name}: the Vicinity coin $${d.ticker} "${d.name}", version ${versionLabel(hash)}` } });
  try { await db.batch(stmts); }
  catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || e))) return fail("symbol_taken", 409);
    throw e;
  }
  const after = await chosenOf(db, cityId, { fresh: true });
  if (!after || !after.current || after.content_hash !== hash || after.seat_id !== seat.id) {
    // nothing of ours stands: say why, as the gate would have
    const why = await notWritten(env, cityId, now);
    return why === "coin_changed" ? json({ ...(await view()), ok: false, error: "coin_changed", message: "Your coin changed since this page loaded. Check it again, then use it." }, 409) : fail(why, 409);
  }
  return json({ ...(await view()), used: true });
}
/**
 * The statements that make version `v` the city's choice (one db.batch, every write conditional in the database itself): the version
 * row (kept once per content hash), the founder's earlier studio design copied aside, the design row (city_coins: name, description,
 * pair, no picture of its own), another city's stale choice of this ticker released, the city's choice (coin_ready, not approved by the
 * owner yet), and one public log line. Each write after the design row's own is conditional on the design row having been written now
 * (its updated_at is `at`), and the design row is replaced only while it is still the one read here, not launched, with no LaunchLab
 * contract waiting and no live hold of the owner's approval (src/lpcoins.js holdDesign). "Use this coin" and the reviewed paths of
 * src/coinreview.js (a passing description, an approved request, reset to the defaults) all write through here.
 *   v     { content, hash, name, symbol, description, artSha, templateVersion (the column: "t1", or "upload"), origin }
 *   log   { actorId, role, action, reason, note }: the public mod_actions line (note: the city, the coin and its version, never free text)
 * Returns { stmts, at }: the caller runs them (with its own guards) and reads the choice back.
 */
export async function choiceStatements(env, { cityId, seat, userId, v, log, now, before = undefined }) {
  const db = env.DB, at = iso(now), hold = holdKey(cityId);
  if (before === undefined) before = await chosenOf(db, cityId, { fresh: true });
  const content = v.content, hash = v.hash;
  const old = await db.prepare("SELECT * FROM city_coins WHERE city_id = ?").bind(cityId).first();
  const stmts = [
    db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(cityId, v.origin || "default", content, hash, v.name, v.symbol, v.description, v.artSha, v.templateVersion, userId, at),
  ];
  // the owner's approval being built right now (src/lpcoins.js holdDesign, written BEFORE src/lpadmin.js approveTx reads the design
  // again and builds) wins over this choice: checked again inside every write, not only by the gate above, so a choice and an
  // approval that cross never leave the approval naming one version while another is written
  const noHold = "NOT EXISTS (SELECT 1 FROM settings WHERE key = ? AND value > ?)";
  // the design row is replaced only while it is still the one read above (`old`, by its updated_at; none at all when there was none),
  // not launched, with no LaunchLab contract waiting and no hold: whatever changed it in between wins, and nothing of the choice is written
  const asRead = `city_coins.updated_at IS ? AND city_coins.mint IS NULL AND city_coins.pending_mint IS NULL AND ${noHold}`;
  const asReadArgs = [old ? old.updated_at : null, hold, at];
  // every write after the design row's own is conditional on it having been written now (its updated_at is this request's)
  const ours = `EXISTS (SELECT 1 FROM city_coins WHERE city_id = ? AND updated_at = ? AND mint IS NULL AND pending_mint IS NULL) AND ${noHold}`;
  const oursArgs = [cityId, at, hold, at];
  // the founder's earlier studio design is kept, whole, before the row becomes the ready-made coin (never on a mere visit): copied
  // under the same condition as the replacement right after it, in the same batch, so it is kept exactly when the row is replaced
  const legacy = old && !(before && before.current);
  if (legacy) {
    stmts.push(db.prepare(`INSERT INTO coin_legacy_designs (city_id, design_json, copied_at, copied_by)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM city_coins WHERE city_id = ? AND ${asRead})`)
      .bind(cityId, JSON.stringify(old), at, userId, cityId, ...asReadArgs));
  }
  stmts.push(db.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, media_id, updated_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'ink', NULL, ?, ? WHERE ${noHold}
      ON CONFLICT(city_id) DO UPDATE SET seat_id = excluded.seat_id, user_id = excluded.user_id, name = excluded.name, pitch = excluded.pitch, pair = excluded.pair,
        color = excluded.color, media_id = NULL, approved_media_id = NULL, logo_hash = NULL, logo_status = NULL, logo_reason = NULL, logo_note = NULL,
        logo_reviewed_at = NULL, logo_reviewed_by = NULL, updated_at = excluded.updated_at
      WHERE ${asRead}`)
    .bind(cityId, seat.city_name, seat.country, seat.id, userId, v.name, v.description, DEFAULT_PAIR, at, at, hold, at, ...asReadArgs));
  // another city's choice that still names this ticker although the city list gave that city another one since (not launched, not
  // approved: staleChoice) lets it go, so coin_ready's UNIQUE(symbol) never keeps a ticker from the city that has it now. That city's
  // founder sees their coin changed and chooses again (its row keeps its version; only the symbol is released)
  const holder = await db.prepare("SELECT city_id, mint, content_hash, approved_hash FROM coin_ready WHERE symbol = ? AND city_id <> ?").bind(v.symbol, cityId).first();
  if (holder && (await staleChoice(env, holder, v.symbol))) {
    stmts.push(db.prepare(`UPDATE coin_ready SET symbol = ? WHERE city_id = ? AND symbol = ? AND mint IS NULL AND (approved_hash IS NULL OR approved_hash <> content_hash) AND ${ours}`)
      .bind(releasedSymbol(holder.city_id), String(holder.city_id), v.symbol, ...oursArgs));
  }
  // a new choice is not approved by anyone yet: approved_hash is set only by the owner's approval built from it (src/lpadmin.js)
  stmts.push(db.prepare(`INSERT INTO coin_ready (city_id, version_id, content_hash, symbol, design_at, seat_id, user_id, chosen_at, approved_hash)
      SELECT ?, (SELECT id FROM coin_versions WHERE city_id = ? AND content_hash = ?), ?, ?, ?, ?, ?, ?, NULL WHERE ${ours}
      ON CONFLICT(city_id) DO UPDATE SET version_id = excluded.version_id, content_hash = excluded.content_hash, symbol = excluded.symbol,
        design_at = excluded.design_at, seat_id = excluded.seat_id, user_id = excluded.user_id, chosen_at = excluded.chosen_at, approved_hash = NULL
      WHERE coin_ready.mint IS NULL`).bind(cityId, cityId, hash, hash, v.symbol, at, seat.id, userId, at, ...oursArgs));
  // the public line says the earlier design is kept aside only when it was (the copy above is in this same batch)
  stmts.push(db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
      SELECT ?, ?, ?, 'city_coin', NULL, ?, ?, ?, ?,
        ? || CASE WHEN EXISTS (SELECT 1 FROM coin_legacy_designs WHERE city_id = ? AND copied_at = ? AND copied_by = ?) THEN ' (the earlier design is kept aside)' ELSE '' END,
        ?, 'done' WHERE ${ours}`)
    .bind(log.actorId, log.role, log.action, userId, seat.country, cityId, log.reason, log.note, cityId, at, userId, at, ...oursArgs));
  return { stmts, at };
}
/** The settings key of the owner's approval hold for a city (src/lpcoins.js holdDesign writes it; designFrozen reads it). */
const holdKey = (cityId) => `lp_design_hold:${String(cityId)}`;
/** Why "Use this coin" wrote nothing although its checks passed: the owner started approving, the coin launched or got a contract. */
async function notWritten(env, cityId, now) {
  const h = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(holdKey(cityId)).first();
  if (h && Date.parse(h.value) > now) return "held";
  const st = await coinState(env, cityId);
  if (st.launched) return "launched";
  if (st.pending) return "legacy_contract";
  return "coin_changed";
}
