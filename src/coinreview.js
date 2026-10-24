/**
 * The city-coin flow, stage 2 (COIN_V2_REVIEW=on and COIN_V2_READY=on, src/flags.js; DESIGN.md sections 4, 5.5-5.9, 6.1-6.4, 7, 8):
 * "Request changes" before launch, the review status, the founder's own description with screening, and the admin queue.
 *
 *   The selection    The city's choice (coin_ready, src/coinart-store.js) is what the owner approves on chain and what launches. Only
 *                    four things change it: "Use this coin" / Reset (Vicinity's defaults, src/coinready.js), a description that PASSED
 *                    the screening (src/screen.js: only Vicinity's own sentence; a founder's own words are always FLAGGED "review", so
 *                    they go through a person), "Use the default description", and a reviewer's approval of a request. All of
 *                    them write through src/coinready.js choiceStatements (conditional in the database: never over an approval being
 *                    built, a launch or a waiting LaunchLab contract), and none while the coin is approved on chain (it is fixed there).
 *   Requests         A founder's draft (another picture, ticker or name, and a "why" for the reviewer) is private until it is
 *                    submitted. Submitting freezes it as one immutable version (coin_versions, content hash) and PAUSES the launch:
 *                    the owner's approval (src/lpadmin.js), the launch status and build (src/lplaunch.js) and "Use this coin" refuse
 *                    while it is pending, and the launch record never publishes it (src/coinart-store.js versionApproved). An admin
 *                    or the owner (never the city's own founder: needs_second_person) approves EXACTLY that version (its hash is
 *                    echoed) or asks for changes with a reason; any edit afterwards is a new version and a new review. Cancel goes
 *                    back to the approved coin. A flagged description the founder sends for review is a request too.
 *   Pictures         A proposed picture is the founder's own upload (shrunk in the browser, src/social.js readImage) or the Vicinity
 *                    design drawn with the proposed ticker and name; until it is approved it is a private media row only the founder
 *                    (/api/media) and the staff (GET /api/admin/coins/reviews/art) can see. Approval copies it to coin_art, the public
 *                    content-addressed store (/coin-meta/art/<sha256>.png).
 *   Tickers          A ticker change approved becomes a line for scripts/cities/ticker-overrides.json (registry_state "waiting", the
 *                    answer's registryPatch): the launch waits until the city list carries it (DESIGN D8), and the job notices when
 *                    it does (registryStep).
 *
 *   GET  /api/coins/ready?city=                    (src/coinready.js) adds `review` for the founder: the request, the description and
 *                                                  what holds the launch, with the words to show
 *   POST /api/coins/review/draft                   { cityId, name?, symbol?, picture: keep|vicinity|upload, image?, reason?, draftUpdatedAt? }
 *   POST /api/coins/review/submit                  { cityId, draftUpdatedAt }
 *   POST /api/coins/review/cancel                  { cityId, requestId }   a draft or a pending request is cancelled; a decided one dismissed
 *   POST /api/coins/review/edit                    { cityId, requestId }   a pending one is withdrawn (or a "changes needed" one revised) into a new draft
 *   POST /api/coins/review/reset                   { cityId }              back to Vicinity's defaults
 *   POST /api/coins/review/description             { cityId, text }        screened: a founder's words are flagged, at best "review"
 *   POST /api/coins/review/description/review      { cityId, screeningId } a flagged one sent to the reviewers
 *   POST /api/coins/review/description/default     { cityId }              the default description (cancels a pending description request)
 *   GET  /api/coins/review/ticker-check?city=&t=   is this ticker free to request?
 *   GET  /api/admin/coins/reviews                  (src/admin.js, moderator or higher) the queue
 *   POST /api/admin/coins/reviews/decide           (admin or owner, fresh proof) { id, action: approve|changes_needed, contentHash, reasonCode?, note? }
 *   GET  /api/admin/coins/reviews/art?id=          (moderator or higher) a proposed picture, hash-checked
 * Every founder route checks, on the server and in this order: the switch (404 otherwise, like an unknown path), same site, sign-in (a
 * fresh wallet proof for POSTs), the city's live founder (active or steward, account wallet = seat wallet), no ban, the counter (atomic,
 * before the work), the live founder amount (a POST starts the grace period, as every founder action does), the city list (registry
 * ticker and record), and no coin yet (no mint, no launchpad record, no LaunchLab contract waiting); then each route its own.
 */
import { json, readJson, sameSite } from "./http.js";
import { access } from "./access.js";
import { DAY, HOUR, iso } from "./policy.js";
import { activeBan, liveSeatOfCity, liveSeatOfUser } from "./roles.js";
import { stillFounder } from "./seats.js";
import { check, limitKey } from "./limits.js";
import { ensureLimitsSchema, ensureLogoSchema, ensureSchema } from "./store.js";
import { designFrozen } from "./lpcoins.js";
import { cityOfTicker, tickerOf } from "./tickers.js";
import { coinDefaults } from "./coindefaults.js";
import { TEMPLATE_VERSION, coinSvg, sha256Hex } from "./coinart.js";
import { TAKEDOWN, approvedBasis, approvedDescription, approvedRequest, artBySvg, artBytes, artPath, chosenOf, cityDescription, ensureReadySchema, takenDownAt } from "./coinart-store.js";
import { canonicalContent, choiceStatements, coinState, ensureArt, founderAnswer, renderPng, svgOf, symbolTaken, versionLabel } from "./coinready.js";
import { nameProblem } from "./lpadmin.js";
import { checkName, checkSymbol } from "./coinmeta.js";
import { HAS_ADDRESS, cleanText } from "./text.js";
import { readImage } from "./social.js";
import { IMAGE_TYPES } from "./logos.js";
import { toBytes } from "./blobs.js";
import { notify, pictureReason } from "./notify.js";
import { coinV2ReviewOn } from "./flags.js";

/* ---------------------------------------------------------------- the words */
/** Per account, counted atomically BEFORE the work (src/limits.js). */
export const REVIEW_LIMITS = Object.freeze({
  draft: { max: 20, windowMs: DAY }, submit: { max: 5, windowMs: DAY }, cancel: { max: 10, windowMs: DAY }, edit: { max: 10, windowMs: DAY },
  reset: { max: 10, windowMs: DAY }, description: { max: 30, windowMs: HOUR }, describe_review: { max: 5, windowMs: DAY },
  describe_default: { max: 20, windowMs: DAY }, ticker: { max: 60, windowMs: 60_000 },
});
/** The reasons a reviewer can give, and the plain sentence the founder reads for each (DESIGN 6.3). */
export const REASONS = Object.freeze({
  ticker_taken: "That ticker already belongs to another city or is reserved.",
  ticker_unclear: "The proposed ticker doesn't clearly stand for your city.",
  name_misleading: "The name could be mistaken for another city, a company, a public body or Vicinity.",
  image_unclear: "The picture doesn't work as a small round coin (too busy, blurry or mostly text).",
  image_rights: "The picture seems to use a logo, photo or artwork you may not have the rights to.",
  offensive: "It contains hateful, sexual, violent or abusive content.",
  financial_claim: "It promises returns or price moves. City coins can't promise money.",
  contact_or_link: "It includes a link, an address or contact details.",
  not_about_city: "It isn't about your city.",
  other: "It doesn't meet the coin rules. See the reviewer's note.",
});
/** Which reasons fit which kind of request (a description review is never refused for its ticker or picture). */
export const REASON_KINDS = Object.freeze({
  ticker_taken: ["change"], ticker_unclear: ["change"], name_misleading: ["change"], image_unclear: ["change"], image_rights: ["change"],
  offensive: ["change", "description"], financial_claim: ["description"], contact_or_link: ["change", "description"], not_about_city: ["description"], other: ["change", "description"],
});
export const STATUS_LABEL = Object.freeze({ draft: "Draft", pending: "Pending", approved: "Approved", changes_needed: "Changes needed" });
/** The next approval round, in the only words the site may use for it (the owner signs every approval; no time is promised). */
export const NEXT_ROUND = "at the owner's next approval round";
/** An approved ticker change, until the city list carries it (DESIGN D8: an admin adds it in a pull request; nothing is automatic). */
const registryWords = (symbol) => `Your new ticker $${symbol} is approved. It goes into the Vicinity city list once an admin adds it in a site update; then your coin goes into the owner's next approval round.`;
/** The launch pause after the coin changed under an approval on chain (src/coinready.js GATES.approved_changed says the same). */
export const APPROVAL_CHANGED = `Your coin changed after the owner approved it on the blockchain, so it can't launch until the owner approves it as it is now, ${NEXT_ROUND}.`;
const ERRORS = Object.freeze({
  not_founder: "Only the city's founder can change its coin.",
  no_wallet: "Link a wallet first: your coin is launched and paid from it.",
  wallet_mismatch: "Your founder seat is held by another wallet. Sign in with that wallet to change the coin.",
  in_grace: "Your balance is below the founder amount, so your seat is in its grace period. Hold the founder amount again to continue.",
  banned: "You can't change or launch a coin while your account is suspended. The Home tab shows until when, and how to appeal.",
  launched: "This city's coin has launched. Its design is fixed for good.",
  legacy_contract: "A contract for this city is waiting for a check. Nothing can launch until that's settled.",
  held: "The owner is approving your coin right now, so it can't change for a few minutes. Try again in 5 minutes.",
  approved_on_chain: "Your coin is approved on the blockchain as it is now, so it can't change before launch. If you need a change, ask Vicinity (Feedback) to withdraw that approval first.",
  rpc_unavailable: "We couldn't check the blockchain just now. Nothing changed. Try again in a minute.",
  request_pending: "Your change request is waiting for review. Cancel it first, or wait for the decision.",
  request_open: "You already have a change request open. Edit or cancel it first.",
  draft_changed: "Your draft changed since this page loaded (in another tab?). Reload it, check it, then submit.",
  nothing_changed: "Your draft changes nothing yet. Pick another picture, ticker or name first.",
  no_draft: "There is no draft to submit. Start one with Request changes.",
  not_found: "That request isn't yours or doesn't exist any more.",
  bad_name: "A coin name is 1 to 32 bytes (accents count 2), letters and numbers with single spaces, no links.",
  bad_ticker: "A ticker is 1 to 10 capital letters A to Z or digits 0 to 9.",
  bad_image: "That picture couldn't be read. Use a square PNG under 200 KB (64 to 1024 pixels a side).",
  bad_reason: "Tell the reviewer why in 10 to 300 characters.",
  reason_refused: "Your note for the reviewer has hidden or look-alike characters. Retype it with ordinary letters and spaces.",
  name_refused: "That name can't be used. Pick another one.",
  ticker_refused: "That ticker can't be used. Pick another one.",
  slow_down: "Too many tries. Wait a little, then try again.",
  screening_error: "We couldn't check your description just now. Nothing changed: your coin keeps its current description. Try again in a minute.",
  cannot_review: "Only a description the checks flagged in the last 24 hours, under the current rules, can be sent for review. Check it again first.",
  list_unavailable: "The city list couldn't be read just now. Try again in a minute.",
  wrong_origin: "This request didn't come from the Vicinity site.",
});
const fail = (error, status, extra = {}) => json({ ok: false, error, ...(ERRORS[error] ? { message: ERRORS[error] } : {}), ...extra }, status, { "Cache-Control": "no-store" });
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'’&-]*$/u; // src/coins.js, the founder name rule
const LINKISH = /https?:|www\.|\.[a-z]{2,}(\/|\b)/i;
const PITCH_BAD = /https?:|www\.|[1-9A-HJ-NP-Za-km-z]{32,44}/; // src/coinmeta.js: the JSON builder's own refusal
const RESERVED_TICKERS = new Set(["VICINITY", "SOL", "USDC", "USDT", "WSOL", "BTC", "ETH"]);
const cityIdOk = (v) => typeof v === "string" && /^\d{1,19}$/.test(v) && BigInt(v) > 0n && BigInt(v) < (1n << 64n) - 1n;
const LIVE = ["active", "steward"];

/* ---------------------------------------------------------------- the tables (lazy, additive, only from a route of the switch) */
export const REVIEW_MIGRATION = {
  id: "2026-10-23-coin-review",
  tables: [
    `CREATE TABLE IF NOT EXISTS coin_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id          TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('change','description')),
  status           TEXT NOT NULL CHECK (status IN ('draft','pending','approved','changes_needed','cancelled','withdrawn')),
  seat_id          INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  base_hash        TEXT,
  draft_name       TEXT,
  draft_symbol     TEXT,
  draft_picture    TEXT,
  draft_media_id   INTEGER,
  draft_art_sha256 TEXT,
  draft_reason     TEXT,
  draft_updated_at TEXT,
  version_id       INTEGER,
  content_hash     TEXT,
  screening_id     INTEGER,
  name_screening   TEXT,
  reason_code      TEXT,
  note             TEXT,
  decided_hash     TEXT,
  registry_state   TEXT,
  submitted_at     TEXT,
  decided_at       TEXT,
  decided_by       INTEGER,
  closed_at        TEXT,
  dismissed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS coin_requests_open ON coin_requests (city_id) WHERE status IN ('draft','pending')",
    "CREATE INDEX IF NOT EXISTS coin_requests_queue ON coin_requests (status, submitted_at)",
    `CREATE TABLE IF NOT EXISTS coin_screenings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id       TEXT NOT NULL,
  user_id       INTEGER NOT NULL,
  target        TEXT NOT NULL CHECK (target IN ('description','name','reason')),
  text          TEXT NOT NULL,
  text_sha256   TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('pass','flag','block','error')),
  issues_json   TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  created_at    TEXT NOT NULL
)`,
    "CREATE INDEX IF NOT EXISTS coin_screenings_city ON coin_screenings (city_id, user_id, created_at)",
  ],
};
const ready = new WeakMap();
/** Make the two tables (only from a route of COIN_V2_REVIEW). Additive, safe to repeat and to run from two servers; a failure is forgotten. */
export function ensureReviewSchema(db) {
  if (!ready.has(db)) {
    ready.set(db, (async () => {
      await ensureSchema(db);
      await ensureLogoSchema(db);
      await ensureReadySchema(db);
      if (await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(REVIEW_MIGRATION.id).first()) return;
      await db.batch(REVIEW_MIGRATION.tables.map((t) => db.prepare(t)));
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(REVIEW_MIGRATION.id, new Date().toISOString()).run();
    })().catch((e) => { ready.delete(db); throw e; }));
  }
  return ready.get(db);
}
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
/** A read of the review tables: a missing table is "nothing" (the switch was never on), anything else throws. */
async function rd(run) { try { return await run(); } catch (e) { if (noTable(e)) return null; throw e; } }

/* ---------------------------------------------------------------- reading the state */
// the city's live seat, as src/roles.js liveSeatOfCity (a request of a former founder's seat holds nothing for the next one)
const LIVE_SEAT = "(SELECT id FROM seats WHERE city_id = ? AND status IN ('provisional', 'active', 'grace', 'steward') ORDER BY id DESC LIMIT 1)";
/** The city's PENDING request of its live founder (it pauses the launch), or null. */
export const pendingRequest = (db, cityId) => rd(() => db.prepare(`SELECT * FROM coin_requests WHERE city_id = ? AND status = 'pending' AND seat_id = ${LIVE_SEAT} LIMIT 1`)
  .bind(String(cityId), String(cityId)).first());
/** The open request (a draft or a pending one) of this seat, or null. */
const openRequest = (db, cityId, seatId) => rd(() => db.prepare("SELECT * FROM coin_requests WHERE city_id = ? AND seat_id = ? AND status IN ('draft', 'pending') LIMIT 1").bind(String(cityId), seatId).first());
const requestById = (db, id) => rd(() => db.prepare("SELECT * FROM coin_requests WHERE id = ?").bind(id).first());
const versionByHash = (db, cityId, hash) => (hash ? rd(() => db.prepare("SELECT * FROM coin_versions WHERE city_id = ? AND content_hash = ?").bind(String(cityId), hash).first()) : null);
const versionById = (db, id) => (id ? rd(() => db.prepare("SELECT * FROM coin_versions WHERE id = ?").bind(id).first()) : null);
/** How many requests wait for a reviewer (the admin Overview). */
export async function pendingReviews(db) {
  const r = await rd(() => db.prepare("SELECT COUNT(*) AS n FROM coin_requests WHERE status = 'pending'").first());
  return r ? r.n : 0;
}

/**
 * The screening context of a city's coin: its own words, the registry's other cities (by name, for "the Syracuse coin") and Vicinity's
 * own sentence for it (the only description that passes by itself: a founder's own words always go to a person, src/screen.js).
 */
async function screenCtx(env, d, sel = null) {
  const names = await cityNames(env);
  const own = new Set([d.city && d.city.name, sel && sel.name, d.name].filter(Boolean).map(normName));
  return { city: d.city, ticker: sel ? sel.symbol : d.ticker, name: sel ? sel.name : d.name, vicinityText: d.description || null,
    otherCity: (n) => !own.has(normName(n)) && names.has(normName(n)) };
}
const normName = (s) => String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
let namesCache = null; // every registry city's name (normalized), once per server
async function cityNames(env) {
  if (namesCache) return namesCache;
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/data/cities.json"));
    if (!res.ok) return new Set();
    const list = await res.json(), out = new Set();
    for (const rows of Object.values(list.byCountry || {})) for (const r of rows) if (String(r[1] || "").length >= 3) out.add(normName(r[1]));
    namesCache = out;
    return out;
  } catch { return new Set(); }
}
export const _resetReview = () => { namesCache = null; screener = null; screenLoader = loadScreen; screenModule = null; };
let screener = null;
/** Tests hand in a stand-in screener (a list that fails, rules that changed); the routes and the launch checks use it. */
export const _setScreener = (fn) => { screener = fn; };
/**
 * src/screen.js, with its word lists and its vocabulary (about 1.2 MB of source), is loaded the first time a screening is needed or
 * shown, never at startup: an isolate that serves the site with COIN_V2_REVIEW off never evaluates it (PARITY-STARTUP-1). A module
 * that cannot load is a screening that cannot run: an error, never a pass.
 */
let screenModule = null;
const loadScreen = () => import("./screen.js");
let screenLoader = loadScreen;
/** Tests hand in a loader that fails (src/screen.js cannot load); null puts the real one back. */
export const _setScreenLoader = (fn) => { screenLoader = fn || loadScreen; screenModule = null; };
const screening = () => (screenModule ||= screenLoader().catch((e) => { screenModule = null; throw e; }));
const unscreened = (text) => ({ result: "error", issues: [], rulesVersion: null, text: typeof text === "string" ? text : null });
/** One screening by `fn` (screenDescription, screenName, screenTicker, screenReason) of src/screen.js; "error" if it cannot load. */
async function screenBy(fn, text, ctx) {
  try { return (await screening())[fn](text, ctx); } catch { return unscreened(text); }
}
const screenText = async (text, ctx) => (screener ? screener(text, ctx) : screenBy("screenDescription", text, ctx));
/** What an issue says while src/screen.js cannot load: its code and place stay, its sentence is this one. */
const UNEXPLAINED = "We couldn't explain this check just now. Nothing changed. Try again in a minute.";
/**
 * The issues in the founder's words (src/screen.js explained), and the rules version screenings are stored with. A screener that
 * cannot load never breaks the founder's card or the queue (LAZY-ERR-1): the issues keep their codes with a plain sentence, and the
 * rules version is null, which no stored screening has (rules_version is NOT NULL), so nothing is ever current or sendable.
 */
async function explained(issues, cityName) {
  try { return (await screening()).explained(issues, cityName); } catch {
    return (issues || []).map((x) => ({ code: x.code, severity: x.severity, start: x.start, end: x.end, message: UNEXPLAINED }));
  }
}
async function rulesVersion() {
  try { return (await screening()).RULES_VERSION; } catch { return null; }
}

/** The template picture of a coin with this ticker and name, if it was ever drawn: its sha256, or null. */
async function templateArt(env, symbol, name) {
  const svg = coinSvg({ ticker: symbol, city: name, templateVersion: TEMPLATE_VERSION });
  const row = await artBySvg(env.DB, await sha256Hex(svg), TEMPLATE_VERSION, { fresh: true });
  return { svg, svgSha: await sha256Hex(svg), sha: row ? row.sha256 : null };
}

/**
 * The basis a request or a description starts from: the founder's current choice (theirs, still the design) or else Vicinity's defaults.
 * { name, symbol, description, art, template (the content's: "t1" or null), templateColumn, hash, content, isDefaults, version }.
 * `draw`: the defaults' picture is drawn now if it never was (only from a POST); without it, no picture means art null.
 */
async function basisOf(env, { cityId, seat, d, now, draw = false }) {
  const c = await chosenOf(env.DB, cityId, { fresh: true });
  if (c && c.current && c.seat_id === seat.id && c.content) {
    return { name: c.name, symbol: c.symbol, description: c.description, art: c.art_sha256, template: c.content.image ? c.content.image.template : null,
      templateColumn: c.template_version, hash: c.content_hash, content: c.content_json, isDefaults: c.origin === "default", version: c, choice: c };
  }
  const art = draw ? await ensureArt(env, d, now) : await storedArtOf(env, d);
  if (!art) return { name: d.name, symbol: d.ticker, description: d.description, art: null, template: TEMPLATE_VERSION, templateColumn: TEMPLATE_VERSION, hash: null, content: null, isDefaults: true, choice: null };
  const content = canonicalContent({ city: d.city, name: d.name, symbol: d.ticker, description: d.description, artSha256: art.sha256, templateVersion: TEMPLATE_VERSION });
  return { name: d.name, symbol: d.ticker, description: d.description, art: art.sha256, template: TEMPLATE_VERSION, templateColumn: TEMPLATE_VERSION,
    hash: await sha256Hex(content), content, isDefaults: true, choice: null };
}
async function storedArtOf(env, d) {
  const row = await artBySvg(env.DB, await sha256Hex(svgOf(d)), TEMPLATE_VERSION);
  return row ? { sha256: row.sha256 } : null;
}

/**
 * Why the city's selection cannot be approved on chain or launched now (review rules), or null. `c`: chosenOf's row (current), or null.
 * Checked again on the server every time (the owner's approval, the launch status and build): a pending request; a version whose
 * name, ticker and picture no reviewer approved; an approved ticker change the city list does not carry yet (D8); a founder description
 * that no longer passes the screening (under the current rules) and that no reviewer approved; a picture that no longer hashes to its
 * name; content the metadata JSON would refuse.
 */
export async function selectionProblem(env, cityId, { c = undefined, d = null, country = null, pending = true } = {}) {
  const db = env.DB;
  const pend = pending ? await pendingRequest(db, cityId) : null;
  if (pend) return pend.kind === "change"
    ? { code: "paused_request", message: "Launch is paused while your change request is reviewed. Cancelling the request ends the pause." }
    : { code: "paused_description", message: "Launch is paused while your description is reviewed. Cancelling the review ends the pause; your coin keeps the description it has now." };
  if (c === undefined) c = await chosenOf(db, cityId, { fresh: true });
  if (!c || !c.current || !c.content) return null;
  if (!d) d = await coinDefaults(env, cityId, country || (c.content.city && c.content.city.country));
  const key = { name: c.name, symbol: c.symbol, art: c.art_sha256 };
  let reviewed = false, basis = null;
  if (d.ok && c.name === d.name && c.symbol === d.ticker && c.template_version === TEMPLATE_VERSION) {
    const t = await storedArtOf(env, d);
    reviewed = Boolean(t && t.sha256 === c.art_sha256);
  }
  if (!reviewed) {
    basis = (await approvedBasis(db, cityId, key)) || null;
    const exact = await approvedRequest(db, cityId, c.content_hash);
    if (!basis && !(exact && exact.kind === "change")) {
      return { code: "not_reviewed", message: "Your coin has a picture, ticker or name that no reviewer approved. Reset it to the Vicinity defaults, or request the change." };
    }
    if (!d.ok || c.symbol !== d.ticker) {
      return { code: "registry_waiting", message: registryWords(c.symbol) };
    }
  }
  // the founder's own description is screened again under the current rules, unless a person approved exactly that text as this city's
  // description (a description request). An approved CHANGE request does not vouch for it: its reviewer was asked about the picture,
  // ticker and name (DESIGN 4.4: a pass under older rules is not enough)
  if (c.description !== cityDescription(c.content.city) && !(await approvedDescription(db, cityId, c.description))) {
    // an admin took this text down (src/cointakedown.js): only a person's review decided since brings it back (approvedDescription above)
    if (await takenDownAt(db, cityId, c.description)) return { code: "description_recheck", message: "Your description was taken down by Vicinity. Use the default description, or write a new one." };
    const r = await screenText(c.description, d.ok ? await screenCtx(env, d, c) : { city: c.content.city, ticker: c.symbol, name: c.name });
    if (r.result === "error") return { code: "description_unchecked", message: "We couldn't re-check your description just now. Try again in a minute, or use the default description." };
    // a founder's own words pass only through a person's review now (src/screen.js "review"): one chosen before that is reviewed too
    if (r.result !== "pass") return { code: "description_recheck", message: "A person reads every description a founder writes before it can launch, and yours wasn't reviewed. Check it again and send it for review, or use the default description." };
  }
  if (nameProblem(c.name) || checkName(c.name) || checkSymbol(c.symbol) || PITCH_BAD.test(c.description || "")) {
    return { code: "bad_content", message: "Your coin's name, ticker or description can't be written into a coin as it is. Reset it to the Vicinity defaults." };
  }
  if (!(await artBytes(db, c.art_sha256))) return { code: "art_missing", message: "Your coin's picture couldn't be read. Reset it to the Vicinity defaults, or try again in a minute." };
  return null;
}

/**
 * Is `symbol` free for this city to REQUEST (or for a reviewer to approve)? null, or { code, message }. A ticker belongs to one city: not
 * another registry city's, not launched, approved on chain or chosen for another city (src/coinready.js symbolTaken), not another
 * city's approved change still waiting for the city list, not requested by another city right now, not a pair or Vicinity's own.
 */
export async function tickerProblem(env, cityId, symbol, fetchImpl = fetch, { chain = true, exceptRequest = null } = {}) {
  const taken = (why) => ({ code: "ticker_taken", message: why });
  if (typeof symbol !== "string" || checkSymbol(symbol)) return { code: "bad_ticker", message: ERRORS.bad_ticker };
  if (RESERVED_TICKERS.has(symbol)) return taken(`$${symbol} is reserved. Pick another ticker.`);
  const own = await tickerOf(env, cityId);
  if (own && own.ticker === symbol) return { code: "same_ticker", message: `$${symbol} is already your city's ticker.` };
  const other = await cityOfTicker(env, symbol);
  if (other && other !== String(cityId)) return taken(`$${symbol} belongs to another city in the Vicinity city list.`);
  const t = await symbolTaken(env, cityId, symbol, fetchImpl, { chain });
  if (t === "unknown") return { code: "ticker_unchecked", message: "We couldn't confirm that this ticker isn't already launched for another city. Try again in a minute." };
  if (t) return taken(`$${symbol} is already launched, approved or chosen for another city.`);
  const req = await rd(() => env.DB.prepare(`SELECT r.id, r.status FROM coin_requests r JOIN coin_versions v ON v.id = r.version_id
      WHERE v.symbol = ? AND r.city_id <> ? AND r.status IN ('pending', 'approved') AND r.id IS NOT ? LIMIT 1`).bind(symbol, String(cityId), exceptRequest).first());
  // (another city's request is private to its founder and the staff: only "not available", never whether it waits or was approved)
  if (req) return taken(`$${symbol} is not available. Pick another ticker.`);
  return null;
}

/** The founder's words for an admin's takedown that made the coin what it is now (the newest rows first), or null. */
function takenDownWords(rows) {
  if (!rows.length) return null;
  const name = rows.some((x) => x.target === "name"), text = rows.some((x) => x.target === "description");
  let why = "other";
  try { why = (JSON.parse(rows[0].issues_json || "[]")[0] || {}).reason || "other"; } catch { /* the rule's words for "other" */ }
  const what = name && text ? "coin name and description" : name ? "coin name" : "description";
  return { at: rows[0].created_at, message: `Vicinity took down your ${what} (${pictureReason(why)}). Your coin uses Vicinity's ${name ? "coin for your city" : "own description"} now. If you send the same words again, a person reviews them first.` };
}
/** The founder's card: the request, the description and what holds the launch (only with COIN_V2_REVIEW on: src/coinready.js founderAnswer). */
export async function reviewState(env, { seat, cityId, view }) {
  const db = env.DB;
  const d = await coinDefaults(env, cityId, seat.country);
  const c = await chosenOf(db, cityId, { fresh: true });
  const sel = c && c.current && c.seat_id === seat.id && c.content ? c : null;
  const req = await cardRequest(db, cityId, seat.id, sel);
  const problem = sel || req ? await selectionProblem(env, cityId, { c: sel, d }) : null;
  // an approval on chain built from this founder's coin does not stop a request or a description (src/coinreview.js notFrozen)
  const gate = view && view.gate && !["request_pending", "approved", "approved_changed"].includes(view.gate.code) ? view.gate : null;
  const pending = req && req.status === "pending";
  const open = req && ["draft", "pending"].includes(req.status);
  const descSource = sel ? (sel.description === cityDescription(sel.content.city) ? "default" : "founder") : "default";
  const last = await rd(() => db.prepare("SELECT id, text, result, issues_json, rules_version, created_at FROM coin_screenings WHERE city_id = ? AND user_id = ? AND target = 'description' ORDER BY id DESC LIMIT 1")
    .bind(String(cityId), seat.user_id).first());
  // the last check is shown only while it is the newest thing that happened (a flag or a block the founder may revise or send)
  const lastShown = last && last.result !== "pass" && (!sel || last.created_at >= sel.chosen_at) && !(req && req.kind === "description" && req.screening_id === last.id && req.status !== "draft");
  // an admin's takedown that made the coin what it is now (src/cointakedown.js): said on the card until the founder changes the coin again
  const down = sel ? await rd(() => db.prepare(`SELECT target, issues_json, created_at FROM coin_screenings WHERE city_id = ? AND rules_version = '${TAKEDOWN}' AND created_at >= ?
      ORDER BY id DESC`).bind(String(cityId), sel.chosen_at).all()) : null;
  const downRows = (down && down.results) || [];
  return {
    on: true, rulesVersion: await rulesVersion(), nextRound: NEXT_ROUND,
    defaults: d.ok ? { name: d.name, symbol: d.ticker, description: d.description } : null,
    selected: sel ? { origin: sel.origin || "default", contentHash: sel.content_hash, version: versionLabel(sel.content_hash), name: sel.name, symbol: sel.symbol,
      description: sel.description, art: artPath(sel.art_sha256), descriptionSource: descSource, upload: sel.template_version === "upload" } : null,
    request: req ? await requestView(env, req, { d, sel, gate: view && view.gate }) : null,
    description: {
      source: descSource, text: sel ? sel.description : d.ok ? d.description : null, takenDown: takenDownWords(downRows),
      screening: lastShown ? { id: last.id, result: last.result, text: last.text, at: last.created_at, current: last.rules_version === (await rulesVersion()),
        issues: await explained(JSON.parse(last.issues_json || "[]"), d.ok ? d.city.name : seat.city_name) } : null,
    },
    hold: problem,
    can: {
      request: !gate && !open && d.ok, describe: !gate && !pending && d.ok, reset: !gate && !pending && Boolean(sel && sel.origin !== "default"),
      cancel: Boolean(open), edit: Boolean(req && ["pending", "changes_needed"].includes(req.status)) && !gate,
    },
    blocked: gate ? gate.message : null,
  };
}
/** The request the founder's card shows: the open one, else the last decided one while it still matters (dismissed ones never). */
async function cardRequest(db, cityId, seatId, sel) {
  const rows = await rd(() => db.prepare(`SELECT * FROM coin_requests WHERE city_id = ? AND seat_id = ? AND status IN ('draft', 'pending', 'approved', 'changes_needed')
      AND dismissed_at IS NULL ORDER BY id DESC LIMIT 1`).bind(String(cityId), seatId).first());
  if (!rows) return null;
  // a description that needed changes is history once the coin's description was chosen again since (a new one that passed, the default)
  if (rows.status === "changes_needed" && rows.kind === "description" && sel && sel.chosen_at > (rows.decided_at || "")) return null;
  // an approved request is shown while its version is (the basis of) the coin; after a reset to the defaults it is history
  if (rows.status === "approved") {
    if (!sel) return null;
    const v = await versionById(db, rows.version_id);
    if (!v || (sel.content_hash !== rows.content_hash && !(v.name === sel.name && v.symbol === sel.symbol && v.art_sha256 === sel.art_sha256 && rows.kind === "change"))) return null;
  }
  return rows;
}
/** A request as the founder sees it: its status in words, the version, what it changes, the reviewer's reason and note. */
async function requestView(env, r, { d, sel, gate = null }) {
  const db = env.DB;
  const v = await versionById(db, r.version_id);
  const base = (await versionByHash(db, r.city_id, r.base_hash)) || (sel ? { name: sel.name, symbol: sel.symbol, art_sha256: sel.art_sha256, description: sel.description } : d.ok ? { name: d.name, symbol: d.ticker, art_sha256: null, description: d.description } : null);
  const proposed = v ? { name: v.name, symbol: v.symbol, description: v.description, art: await artUrl(env, r, v.art_sha256) }
    : { name: r.draft_name || (base && base.name) || null, symbol: r.draft_symbol || (base && base.symbol) || null, description: base ? base.description : null,
      art: r.draft_art_sha256 ? await artUrl(env, r, r.draft_art_sha256) : base && base.art_sha256 ? artPath(base.art_sha256) : null };
  const diff = [];
  if (base) {
    if (proposed.art && base.art_sha256 && !String(proposed.art).includes(base.art_sha256)) diff.push({ field: "picture", from: artPath(base.art_sha256), to: proposed.art });
    if (proposed.symbol !== base.symbol) diff.push({ field: "ticker", from: `$${base.symbol}`, to: `$${proposed.symbol}` });
    if (proposed.name !== base.name) diff.push({ field: "name", from: base.name, to: proposed.name });
    if (r.kind === "description" || proposed.description !== base.description) diff.push({ field: "description", from: base.description, to: proposed.description });
  }
  const registry = r.status === "approved" && v && d.ok && v.symbol !== d.ticker ? "waiting" : r.status === "approved" && r.registry_state ? "live" : null;
  // the approved card follows the coin's state: once the owner's approval is on the blockchain (or the coin launched) the round is behind it,
  // and while the owner builds that approval (the five-minute hold) it is happening right now, as the coin card says (GATES.held)
  const onChain = Boolean(gate && ["approved", "launched"].includes(gate.code));
  const beingApproved = Boolean(gate && gate.code === "held");
  const words = {
    draft: "Your draft is private. Your coin stays as it is until a reviewer approves the change. Submitting pauses your launch until they decide.",
    pending: `Version ${versionLabel(r.content_hash)} · a reviewer checks exactly this version. Launch is paused until they decide.`,
    approved: r.kind === "change"
      ? `Version ${versionLabel(r.content_hash)} was approved. It is now your coin.${registry === "waiting" ? ` ${registryWords(v.symbol)}` : onChain ? " It is approved on the blockchain too."
        : beingApproved ? " The owner is approving it on the blockchain right now." : ` It launches after the owner approves it on the blockchain, ${NEXT_ROUND}.`}`
      : `Your description (version ${versionLabel(r.content_hash)}) was approved. It is now your coin's description.`,
    changes_needed: `Changes needed: ${REASONS[r.reason_code] || REASONS.other}${r.note ? ` Note from the reviewer: ${r.note}` : ""} Your coin stays as it was.`,
  };
  return {
    id: r.id, kind: r.kind, status: r.status, label: STATUS_LABEL[r.status] || r.status, message: words[r.status] || "",
    version: versionLabel(r.content_hash), contentHash: r.content_hash || null, submittedAt: r.submitted_at, decidedAt: r.decided_at,
    reasonCode: r.status === "changes_needed" ? r.reason_code : null, reason: r.status === "changes_needed" ? REASONS[r.reason_code] || REASONS.other : null,
    note: r.status === "changes_needed" ? r.note || null : null, diff, proposed, registryState: registry,
    draft: r.status === "draft" ? { name: r.draft_name, symbol: r.draft_symbol, picture: r.draft_picture || "keep", art: proposed.art, reason: r.draft_reason || "", updatedAt: r.draft_updated_at } : null,
    nameIssues: r.name_screening ? JSON.parse(r.name_screening) : [],
  };
}
/** Where the founder sees a picture: the public address once it is approved (coin_art), else the private media row only they can open. */
async function artUrl(env, r, sha) {
  if (!sha) return null;
  const stored = await artBytes(env.DB, sha);
  if (stored) return artPath(sha);
  return r.draft_media_id ? `/api/media/${r.draft_media_id}` : null;
}

/* ---------------------------------------------------------------- the founder's routes */
async function counted(env, kind, userId, now) {
  const spec = REVIEW_LIMITS[kind];
  await ensureLimitsSchema(env.DB);
  const r = await check(env, [{ key: await limitKey(env, `coin-review-${kind}`, String(userId)), windowMs: spec.windowMs, max: spec.max }], now);
  return r.ok ? null : json({ ok: false, error: "slow_down", message: ERRORS.slow_down }, 429, { "Retry-After": String(Math.ceil(spec.windowMs / 1000)) });
}
/**
 * The city's live founder for a POST (the checks of the header, in that order): { u, seat, cityId, body, d } or { error: Response }.
 * A request still open from a FORMER founder's seat is withdrawn here (it holds nothing for the next founder).
 */
async function founderPost(request, env, now, fetchImpl, kind, { max = 2048 } = {}) {
  if (!env.DB) return { error: fail("unavailable", 503) };
  if (!sameSite(request, env)) return { error: fail("wrong_origin", 403) };
  const a = await access(request, env, now, { write: true, fresh: true });
  if (a.error) return a;
  const body = await readJson(request, max);
  if (!body) return { error: fail("bad_request", 400) };
  const cityId = typeof body.cityId === "string" || typeof body.cityId === "number" ? String(body.cityId) : "";
  if (!cityIdOk(cityId)) return { error: fail("bad_city", 400) };
  const u = a.u, seat = await liveSeatOfUser(env.DB, u.id);
  if (!seat || String(seat.city_id) !== cityId || !LIVE.includes(seat.status)) return { error: fail(seat && seat.status === "grace" && String(seat.city_id) === cityId ? "in_grace" : "not_founder", 403) };
  if (!u.wallet || u.wallet !== seat.wallet) return { error: fail(u.wallet ? "wallet_mismatch" : "no_wallet", 403) };
  if ((await activeBan(env.DB, u.id, u.home_country, now)) || (await activeBan(env.DB, u.id, seat.country, now))) return { error: fail("banned", 403) };
  const slow = await counted(env, kind, u.id, now);
  if (slow) return { error: slow };
  let still;
  try { still = await stillFounder(env, seat, now, fetchImpl); } catch { return { error: fail("rpc_unavailable", 503) }; }
  if (!still) return { error: fail("in_grace", 403) };
  const d = await coinDefaults(env, cityId, seat.country);
  if (!d.ok) return { error: json({ ok: false, error: d.code, message: d.message }, d.code === "list_unavailable" ? 503 : 409) };
  const st = await coinState(env, cityId);
  if (st.launched) return { error: fail("launched", 409) };
  if (st.pending) return { error: fail("legacy_contract", 409) };
  await ensureReviewSchema(env.DB);
  await env.DB.prepare("UPDATE coin_requests SET status = 'withdrawn', closed_at = ?, updated_at = ? WHERE city_id = ? AND status IN ('draft', 'pending') AND seat_id <> ?")
    .bind(iso(now), iso(now), cityId, seat.id).run();
  return { u, seat, cityId, body, d };
}
/**
 * The coin may change only while nothing on chain fixes it: { error } (launched, held, chain unreadable) or null. An approval on chain
 * built from this founder's ready-made coin (approved_hash: the owner's round or card built it from their chosen version) does not stop
 * a request or a description: the launch pauses while a request waits or while the coin differs from what was approved (launchHold),
 * and the owner's next round withdraws or renews that approval (src/lpbatch.js). Any other approval (one given by hand for an earlier
 * studio design, or for another founder) still fixes the coin as it was approved.
 */
async function notFrozen(env, w, fetchImpl, now) {
  let f;
  try { f = await designFrozen(env, w.cityId, fetchImpl, now); } catch { return fail("rpc_unavailable", 503); }
  if (f === "launched") return fail("launched", 409);
  if (f === "held") return fail("held", 409);
  if (f === "approved") {
    const c = await chosenOf(env.DB, w.cityId, { fresh: true });
    if (!(c && c.current && c.approved_hash && c.seat_id === w.seat.id)) return fail("approved_on_chain", 409);
  }
  return null;
}
const answer = async (env, w, fetchImpl, now, extra = {}, status = 200) =>
  json({ ok: status < 400, ...(await founderAnswer(env, { u: w.u, seat: w.seat, cityId: w.cityId, fetchImpl, now, live: true })), ...extra }, status, { "Cache-Control": "no-store" });
// a statement that FAILS (a CHECK constraint, so the whole batch rolls back) unless `cond` holds: every guarded write is all or nothing
const guard = (db, cond, args) => db.prepare(`INSERT INTO coin_requests (city_id, kind, status, seat_id, user_id, created_at, updated_at)
  SELECT 'guard', 'change', 'not_written', 0, 0, '', '' WHERE NOT (${cond})`).bind(...args);
const guardFailed = (e) => /CHECK constraint/i.test(String((e && e.message) || e));
const holdKey = (cityId) => `lp_design_hold:${String(cityId)}`;
const NO_HOLD = "NOT EXISTS (SELECT 1 FROM settings WHERE key = ? AND value > ?)";
const NO_PENDING = `NOT EXISTS (SELECT 1 FROM coin_requests WHERE city_id = ? AND status = 'pending' AND seat_id = ${LIVE_SEAT})`;
/** Why a guarded write did not happen: the owner's hold, a launch or a contract, a request that landed meanwhile, or the coin changed. */
async function whyNot(env, cityId, now) {
  const h = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(holdKey(cityId)).first();
  if (h && Date.parse(h.value) > now) return "held";
  const st = await coinState(env, cityId);
  if (st.launched) return "launched";
  if (st.pending) return "legacy_contract";
  if (await pendingRequest(env.DB, cityId)) return "request_pending";
  return "draft_changed";
}

/* ---------------------------------------------------------------- an uploaded picture */
/** The largest side an uploaded coin picture may have (the page sends 512 px at most), and the smallest. */
export const UPLOAD_SIDE = Object.freeze({ min: 64, max: 1024 });
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b, from, to) => { let c = 0xffffffff; for (let i = from; i < to; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/**
 * Is `bytes` a whole, square PNG of a sensible size? { side } or null. Every chunk is walked and its CRC checked (a truncated or
 * patched file is refused), the header comes first with a valid colour type and bit depth, there is image data, and the file ends with
 * IEND and nothing after it. The size is read from the header, never trusted from the page: a 30,000 px "pixel flood" or a picture
 * that is not square is refused before any person's browser draws it. Coin pictures are PNG only, so the bytes are what the
 * /coin-meta/art/<sha>.png address says they are.
 */
export function squarePng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : null;
  if (!b || b.length < 8 + 25 + 12 + 12) return null;
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (SIG.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 8, first = true, idat = false, end = false, side = 0;
  while (at + 12 <= b.length) {
    const len = dv.getUint32(at), type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    if (len > b.length || at + 12 + len > b.length || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (crc32(b, at + 4, at + 8 + len) !== dv.getUint32(at + 8 + len)) return null;
    if (first) {
      if (type !== "IHDR" || len !== 13) return null;
      const w = dv.getUint32(at + 8), h = dv.getUint32(at + 12), depth = b[at + 16], color = b[at + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color];
      if (w !== h || w < UPLOAD_SIDE.min || w > UPLOAD_SIDE.max || !depths || !depths.includes(depth) || b[at + 18] !== 0 || b[at + 19] !== 0 || b[at + 20] > 1) return null;
      side = w; first = false;
    } else if (type === "IHDR") return null;
    if (type === "IDAT") idat = true;
    at += 12 + len;
    if (type === "IEND") { end = true; break; }
  }
  return end && idat && at === b.length ? { side } : null;
}

/** The proposed picture of a draft: { picture, mediaId, sha } or { error }. */
async function draftArt(env, { w, req, base, name, symbol, picture, image, now }) {
  const db = env.DB;
  if (picture === "upload") {
    if (image != null) {
      const img = readImage(image);
      if (!img || img.type !== "image/png" || !squarePng(img.bytes)) return { error: fail("bad_image", 400) };
      const r = await db.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (?, ?, ?, ?)").bind(w.u.id, img.type, img.bytes, iso(now)).run();
      return { picture, mediaId: r.meta.last_row_id, sha: await sha256Hex(img.bytes) };
    }
    if (req && req.draft_picture === "upload" && req.draft_media_id) return { picture, mediaId: req.draft_media_id, sha: req.draft_art_sha256 };
    return { error: fail("bad_image", 400) };
  }
  if (picture === "keep" && base.art && base.templateColumn === "upload") return { picture, mediaId: null, sha: base.art };
  // the Vicinity design, drawn with the proposed ticker and name (once per ticker and name: the same drawing is found again)
  if (base.art && base.templateColumn === TEMPLATE_VERSION && name === base.name && symbol === base.symbol) return { picture: "vicinity", mediaId: null, sha: base.art };
  const t = await templateArt(env, symbol, name);
  if (t.sha) return { picture: "vicinity", mediaId: null, sha: t.sha };
  // drawn for this draft before, with this very ticker and name: kept (submitting draws it again and compares)
  if (req && req.draft_picture === "vicinity" && req.draft_media_id && req.draft_art_sha256 && (req.draft_name || base.name) === name && (req.draft_symbol || base.symbol) === symbol) {
    return { picture: "vicinity", mediaId: req.draft_media_id, sha: req.draft_art_sha256 };
  }
  const png = await renderPng(t.svg);
  const r = await db.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (?, 'image/png', ?, ?)").bind(w.u.id, png, iso(now)).run();
  return { picture: "vicinity", mediaId: r.meta.last_row_id, sha: await sha256Hex(png) };
}

/** POST /api/coins/review/draft: save the founder's private draft (a new one, or the open draft again). */
async function draftRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "draft", { max: 300_000 });
  if (w.error) return w.error;
  const db = env.DB, b = w.body;
  const open = await openRequest(db, w.cityId, w.seat.id);
  if (open && open.status === "pending") return fail("request_pending", 409);
  if (open && b.draftUpdatedAt != null && b.draftUpdatedAt !== open.draft_updated_at) return fail("draft_changed", 409);
  const frozen = await notFrozen(env, w, fetchImpl, now);
  if (frozen) return frozen;
  const base = await basisOf(env, { cityId: w.cityId, seat: w.seat, d: w.d, now, draw: true });
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().normalize("NFC") : base.name;
  const symbol = typeof b.symbol === "string" && b.symbol.trim() ? b.symbol.trim().toUpperCase() : base.symbol;
  if (name !== base.name && (nameProblem(name) || checkName(name) || !NAME_RE.test(name) || LINKISH.test(name) || HAS_ADDRESS.test(name))) return fail("bad_name", 400);
  if (symbol !== base.symbol && checkSymbol(symbol)) return fail("bad_ticker", 400);
  const reason = b.reason == null ? (open ? open.draft_reason || "" : "") : cleanText(b.reason, 300);
  if (reason == null) return fail("bad_reason", 400);
  const picture = b.image != null ? "upload" : ["keep", "vicinity", "upload"].includes(b.picture) ? b.picture : open ? open.draft_picture || "vicinity" : "vicinity";
  const art = await draftArt(env, { w, req: open, base, name, symbol, picture, image: b.image, now });
  if (art.error) return art.error;
  const at = iso(now);
  const fields = [name === base.name ? null : name, symbol === base.symbol ? null : symbol, art.picture, art.mediaId, art.sha, reason, at];
  try {
    if (open) {
      const r = await db.prepare(`UPDATE coin_requests SET draft_name = ?, draft_symbol = ?, draft_picture = ?, draft_media_id = ?, draft_art_sha256 = ?, draft_reason = ?,
          draft_updated_at = ?, base_hash = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND draft_updated_at IS ?`)
        .bind(...fields, base.hash, at, open.id, open.draft_updated_at).run();
      if (!r.meta.changes) return fail("draft_changed", 409);
    } else {
      await db.prepare(`INSERT INTO coin_requests (city_id, kind, status, seat_id, user_id, base_hash, draft_name, draft_symbol, draft_picture, draft_media_id, draft_art_sha256,
          draft_reason, draft_updated_at, created_at, updated_at) VALUES (?, 'change', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(w.cityId, w.seat.id, w.u.id, base.hash, ...fields, at, at).run();
    }
  } catch (e) { if (/UNIQUE/i.test(String((e && e.message) || e))) return fail("request_open", 409); throw e; }
  return answer(env, w, fetchImpl, now, { saved: true });
}

/** POST /api/coins/review/submit { cityId, draftUpdatedAt }: the draft becomes one immutable version, pending a reviewer. */
async function submitRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "submit");
  if (w.error) return w.error;
  const db = env.DB;
  const req = await openRequest(db, w.cityId, w.seat.id);
  if (!req) return fail("no_draft", 409);
  if (req.status === "pending") return fail("request_pending", 409);
  if (w.body.draftUpdatedAt !== req.draft_updated_at) return fail("draft_changed", 409);
  const frozen = await notFrozen(env, w, fetchImpl, now);
  if (frozen) return frozen;
  const base = await basisOf(env, { cityId: w.cityId, seat: w.seat, d: w.d, now, draw: true });
  if (req.base_hash !== base.hash) return fail("draft_changed", 409, { message: "Your coin changed since you started this draft. Check the draft again, then submit." });
  const name = req.draft_name || base.name, symbol = req.draft_symbol || base.symbol;
  // the reviewer's why: 10 to 300 characters, nothing hidden (it is never public)
  const why = await screenBy("screenReason", req.draft_reason || "");
  if (why.result === "error") return fail("screening_error", 503);
  if (why.issues.some((x) => x.code === "length")) return fail("bad_reason", 400);
  if (why.result === "block") return fail("reason_refused", 400);
  // the picture: exactly the bytes the draft names (the founder's upload, or the drawing kept for it), or the coin's own
  let art = req.draft_art_sha256, template = TEMPLATE_VERSION, column = TEMPLATE_VERSION;
  if (req.draft_picture === "upload") {
    const m = await db.prepare("SELECT type, bytes FROM media WHERE id = ? AND user_id = ?").bind(req.draft_media_id, w.u.id).first();
    if (!m || m.type !== "image/png" || !squarePng(toBytes(m.bytes)) || (await sha256Hex(toBytes(m.bytes))) !== art) return fail("bad_image", 400);
    template = null; column = "upload";
  } else if (req.draft_picture === "keep" && base.templateColumn === "upload") {
    art = base.art; template = null; column = "upload";
  } else {
    const t = await templateArt(env, symbol, name);
    if (t.sha) art = t.sha; // drawn before and public already (Vicinity's own design of this ticker and name)
    else {
      // the Vicinity design of exactly this ticker and name, drawn again now: a stored copy is never trusted for what is reviewed
      const png = await renderPng(t.svg);
      art = await sha256Hex(png);
      const m = req.draft_media_id ? await db.prepare("SELECT bytes FROM media WHERE id = ? AND user_id = ?").bind(req.draft_media_id, w.u.id).first() : null;
      if (!m || (await sha256Hex(toBytes(m.bytes))) !== art) {
        const r = await db.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (?, 'image/png', ?, ?)").bind(w.u.id, png, iso(now)).run();
        req.draft_media_id = r.meta.last_row_id;
      }
    }
  }
  if (name === base.name && symbol === base.symbol && art === base.art) return fail("nothing_changed", 409);
  let nameIssues = [];
  // the coin's own words are those a person already reviewed (the city list's, or an approved change's: the basis), never the proposed
  // ticker or name themselves ("Spic Town" with $SPIC is not "the city's own word")
  const own = await screenCtx(env, w.d, { name: base.name, symbol: base.symbol });
  if (name !== base.name) {
    if (nameProblem(name) || checkName(name) || !NAME_RE.test(name) || LINKISH.test(name) || HAS_ADDRESS.test(name)) return fail("bad_name", 400);
    const s = await screenBy("screenName", name, own);
    if (s.result === "error") return fail("screening_error", 503);
    if (s.result === "block") return fail("name_refused", 409, { issues: await explained(s.issues, w.d.city.name) });
    nameIssues = await explained(s.issues, w.d.city.name);
  }
  if (symbol !== base.symbol) {
    // a ticker is read like a word too: a slur (spelled any way) refuses it, anything else the lists find is shown to the reviewer
    const s = await screenBy("screenTicker", symbol, own);
    if (s.result === "error") return fail("screening_error", 503);
    if (s.result === "block") return fail("ticker_refused", 409, { issues: await explained(s.issues, w.d.city.name) });
    nameIssues = [...nameIssues, ...(await explained(s.issues, w.d.city.name)).map((x) => ({ ...x, field: "ticker" }))];
  }
  if (symbol !== base.symbol && symbol !== w.d.ticker) {
    const t = await tickerProblem(env, w.cityId, symbol, fetchImpl);
    if (t) return fail(t.code === "ticker_unchecked" ? "rpc_unavailable" : "ticker_taken", t.code === "ticker_unchecked" ? 503 : 409, { message: t.message });
  }
  const content = canonicalContent({ city: w.d.city, name, symbol, description: base.description, artSha256: art, templateVersion: template });
  const hash = await sha256Hex(content);
  const at = iso(now);
  const stmts = [];
  // the version the founder started from is kept too, so the reviewer sees "now" and "proposed" side by side
  if (base.content && !base.choice) {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(w.cityId, base.content, base.hash, base.name, base.symbol, base.description, base.art, TEMPLATE_VERSION, w.u.id, at));
  }
  stmts.push(db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
      VALUES (?, 'change', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(w.cityId, content, hash, name, symbol, base.description, art, column, w.u.id, at));
  stmts.push(db.prepare(`UPDATE coin_requests SET status = 'pending', version_id = (SELECT id FROM coin_versions WHERE city_id = ? AND content_hash = ?), content_hash = ?,
      draft_media_id = ?, draft_art_sha256 = ?, name_screening = ?, submitted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'draft' AND draft_updated_at = ? AND ${NO_HOLD}
        AND NOT EXISTS (SELECT 1 FROM city_coins WHERE city_id = ? AND (mint IS NOT NULL OR pending_mint IS NOT NULL))`)
    .bind(w.cityId, hash, hash, req.draft_media_id || null, art, nameIssues.length ? JSON.stringify(nameIssues) : null, at, at, req.id, req.draft_updated_at, holdKey(w.cityId), at, w.cityId));
  stmts.push(guard(db, "EXISTS (SELECT 1 FROM coin_requests WHERE id = ? AND status = 'pending' AND submitted_at = ?)", [req.id, at]));
  try { await db.batch(stmts); }
  catch (e) { if (guardFailed(e)) return fail(await whyNot(env, w.cityId, now), 409); throw e; }
  return answer(env, w, fetchImpl, now, { submitted: true });
}

/** POST /api/coins/review/cancel { cityId, requestId }: a draft or a pending request is cancelled (back to the approved coin); a decided one is put away. */
async function cancelRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "cancel");
  if (w.error) return w.error;
  const id = Number(w.body.requestId);
  const req = Number.isSafeInteger(id) ? await requestById(env.DB, id) : null;
  if (!req || req.city_id !== w.cityId || req.seat_id !== w.seat.id) return fail("not_found", 404);
  const at = iso(now);
  let r;
  if (["draft", "pending"].includes(req.status)) r = await env.DB.prepare("UPDATE coin_requests SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ? AND status = ?").bind(at, at, id, req.status).run();
  else if (["approved", "changes_needed"].includes(req.status)) r = await env.DB.prepare("UPDATE coin_requests SET dismissed_at = ?, updated_at = ? WHERE id = ? AND dismissed_at IS NULL").bind(at, at, id).run();
  else return fail("not_found", 404);
  if (!r.meta.changes) return fail("draft_changed", 409);
  return answer(env, w, fetchImpl, now, { cancelled: true });
}

/** POST /api/coins/review/edit { cityId, requestId }: a pending version is withdrawn (or a "changes needed" one put away) and a new draft opens, prefilled. */
async function editRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "edit");
  if (w.error) return w.error;
  const db = env.DB, id = Number(w.body.requestId);
  const req = Number.isSafeInteger(id) ? await requestById(db, id) : null;
  if (!req || req.city_id !== w.cityId || req.seat_id !== w.seat.id || req.kind !== "change" || !["pending", "changes_needed"].includes(req.status)) return fail("not_found", 404);
  const frozen = await notFrozen(env, w, fetchImpl, now);
  if (frozen) return frozen;
  const base = await basisOf(env, { cityId: w.cityId, seat: w.seat, d: w.d, now, draw: true });
  const v = await versionById(db, req.version_id);
  const at = iso(now);
  const close = req.status === "pending"
    ? db.prepare("UPDATE coin_requests SET status = 'withdrawn', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(at, at, id)
    : db.prepare("UPDATE coin_requests SET dismissed_at = COALESCE(dismissed_at, ?), updated_at = ? WHERE id = ? AND status = 'changes_needed'").bind(at, at, id);
  const name = v && v.name !== base.name ? v.name : null, symbol = v && v.symbol !== base.symbol ? v.symbol : null;
  const picture = req.draft_picture || "vicinity";
  try {
    await db.batch([close,
      db.prepare(`INSERT INTO coin_requests (city_id, kind, status, seat_id, user_id, base_hash, draft_name, draft_symbol, draft_picture, draft_media_id, draft_art_sha256,
          draft_reason, draft_updated_at, created_at, updated_at) VALUES (?, 'change', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(w.cityId, w.seat.id, w.u.id, base.hash, name, symbol, picture, picture === "upload" ? req.draft_media_id : null, picture === "upload" ? req.draft_art_sha256 : null,
          req.draft_reason, at, at, at)]);
  } catch (e) { if (/UNIQUE/i.test(String((e && e.message) || e))) return fail("request_open", 409); throw e; }
  return answer(env, w, fetchImpl, now, { editing: true });
}

/**
 * Write version `v` as the city's choice, all or nothing: the choice statements of src/coinready.js, `before` statements first (a
 * screening row, a request's approval), and a guard that rolls everything back unless the choice was written now and, with `noPending`,
 * no request is pending. { ok: true } or { error: Response }.
 */
async function select(env, { w, v, log, now, before = [], noPending = true, after = [] }) {
  const db = env.DB;
  // keepApproved: the hash an approval on chain was built from stays on the row (never equal to a new version's), so the launch pauses
  // and the owner's next round renews the approval for the coin as it is now (src/lpbatch.js)
  const { stmts, at } = await choiceStatements(env, { cityId: w.cityId, seat: w.seat, userId: w.userId || w.u.id, v, log, now, keepApproved: true });
  const cond = `EXISTS (SELECT 1 FROM coin_ready WHERE city_id = ? AND content_hash = ? AND chosen_at = ?)${noPending ? ` AND ${NO_PENDING}` : ""}`;
  const args = [w.cityId, v.hash, at, ...(noPending ? [w.cityId, w.cityId] : [])];
  try { await db.batch([...before, ...stmts, ...after, guard(db, cond, args)]); }
  catch (e) {
    if (guardFailed(e)) { const why = await whyNot(env, w.cityId, now); return { error: fail(why === "draft_changed" ? "coin_changed" : why, 409, why === "draft_changed" ? { message: "Your coin changed since this page loaded. Check it again, then try again." } : {}) }; }
    if (/UNIQUE/i.test(String((e && e.message) || e))) return { error: fail("ticker_taken", 409, { message: "That ticker is already chosen for another city." }) };
    throw e;
  }
  return { ok: true };
}
/** A version built from the founder's basis with another description. */
async function withDescription(env, w, base, text) {
  const content = canonicalContent({ city: w.d.city, name: base.name, symbol: base.symbol, description: text, artSha256: base.art, templateVersion: base.template });
  return { content, hash: await sha256Hex(content), name: base.name, symbol: base.symbol, description: text, artSha: base.art, templateVersion: base.templateColumn };
}
const defaultsStmt = (db, w, base, at) => db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
  VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(w.cityId, base.content, base.hash, base.name, base.symbol, base.description, base.art, TEMPLATE_VERSION, w.u.id, at);

/** POST /api/coins/review/reset { cityId }: back to Vicinity's defaults (the ready-made coin as the city list gives it now). */
async function resetRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "reset");
  if (w.error) return w.error;
  if (await pendingRequest(env.DB, w.cityId)) return fail("request_pending", 409);
  const frozen = await notFrozen(env, w, fetchImpl, now);
  if (frozen) return frozen;
  const art = await ensureArt(env, w.d, now);
  const content = canonicalContent({ city: w.d.city, name: w.d.name, symbol: w.d.ticker, description: w.d.description, artSha256: art.sha256, templateVersion: TEMPLATE_VERSION });
  const hash = await sha256Hex(content);
  const c = await chosenOf(env.DB, w.cityId, { fresh: true });
  if (c && c.current && c.content_hash === hash && c.seat_id === w.seat.id) return answer(env, w, fetchImpl, now, { already: true });
  const s = await select(env, { w, now, v: { content, hash, name: w.d.name, symbol: w.d.ticker, description: w.d.description, artSha: art.sha256, templateVersion: TEMPLATE_VERSION, origin: "default" },
    log: { actorId: w.u.id, role: "founder", action: "coin_design", reason: "design", note: `${w.seat.city_name}: back to the Vicinity coin $${w.d.ticker} "${w.d.name}", version ${versionLabel(hash)}` } });
  if (s.error) return s.error;
  return answer(env, w, fetchImpl, now, { reset: true });
}

/**
 * A screening row (every result, error included: what the reviewer and the audit see). An error from a screener that could not load
 * has no rules version: its row says "unloaded" (never a version, so never current or sendable: LAZY-ERR-1), not a failed INSERT.
 */
const screeningStmt = async (db, { cityId, userId, target, r, at }) => db.prepare(`INSERT INTO coin_screenings (city_id, user_id, target, text, text_sha256, result, issues_json, rules_version, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(cityId, userId, target, r.text || "", await sha256Hex(r.text || ""), r.result, JSON.stringify(r.issues || []),
  r.rulesVersion ?? (r.result === "error" ? "unloaded" : null), at);

/** A description "changes needed" card of this founder is put away (they wrote a new description, or went back to the default). */
const dismissDescriptionCards = (db, w, at) => db.prepare(`UPDATE coin_requests SET dismissed_at = ?, updated_at = ? WHERE city_id = ? AND seat_id = ? AND kind = 'description'
  AND status = 'changes_needed' AND dismissed_at IS NULL`).bind(at, at, w.cityId, w.seat.id);
/** POST /api/coins/review/description { cityId, text }: screened; a pass is the coin's description at once; a flag or a block changes nothing. */
async function descriptionRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "description", { max: 4096 });
  if (w.error) return w.error;
  const db = env.DB;
  if (await pendingRequest(db, w.cityId)) return fail("request_pending", 409);
  const frozen = await notFrozen(env, w, fetchImpl, now);
  if (frozen) return frozen;
  const base = await basisOf(env, { cityId: w.cityId, seat: w.seat, d: w.d, now, draw: true });
  let r = await screenText(typeof w.body.text === "string" ? w.body.text : "", await screenCtx(env, w.d, base));
  // words an admin took down as this city's description (src/cointakedown.js) are never used by themselves again: a person reviews them
  if ((r.result === "pass" || r.result === "flag") && r.text && (await takenDownAt(db, w.cityId, r.text))) {
    r = { ...r, result: "flag", issues: [...(r.issues || []), { code: "taken_down", severity: "flag", start: 0, end: r.text.length }] };
  }
  const at = iso(now);
  const row = await screeningStmt(db, { cityId: w.cityId, userId: w.u.id, target: "description", r: { ...r, text: r.text || "" }, at });
  if (r.result !== "pass") {
    if (r.result === "error") { await row.run(); return fail("screening_error", 503); }
    await db.batch([row, dismissDescriptionCards(db, w, at)]); // a new text replaces the one that needed changes
    const id = (await db.prepare("SELECT id FROM coin_screenings WHERE city_id = ? AND user_id = ? AND created_at = ? ORDER BY id DESC LIMIT 1").bind(w.cityId, w.u.id, at).first()).id;
    return answer(env, w, fetchImpl, now, { screening: { id, result: r.result, text: r.text, issues: await explained(r.issues, w.d.city.name) } });
  }
  if (r.text === base.description) { await db.batch([row, dismissDescriptionCards(db, w, at)]); return answer(env, w, fetchImpl, now, { screening: { result: "pass", text: r.text, issues: [] }, already: true }); }
  const v = await withDescription(env, w, base, r.text);
  const s = await select(env, { w, now, v: { ...v, origin: base.isDefaults && r.text === w.d.description ? "default" : "description" },
    before: [row, dismissDescriptionCards(db, w, at), ...(base.isDefaults && base.content && !base.choice ? [defaultsStmt(db, w, base, at)] : [])],
    log: { actorId: w.u.id, role: "founder", action: "coin_description", reason: "screened", note: `${w.seat.city_name}: ${r.text === w.d.description ? "Vicinity's own description again" : "a description that passed the checks"}, version ${versionLabel(v.hash)}` } });
  if (s.error) return s.error;
  return answer(env, w, fetchImpl, now, { screening: { result: "pass", text: r.text, issues: [] }, used: true });
}

/** POST /api/coins/review/description/review { cityId, screeningId }: a flagged description goes to the reviewers; the launch waits. */
async function describeReviewRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "describe_review");
  if (w.error) return w.error;
  const db = env.DB, id = Number(w.body.screeningId);
  const sc = Number.isSafeInteger(id) ? await db.prepare("SELECT * FROM coin_screenings WHERE id = ?").bind(id).first() : null;
  if (!sc || sc.city_id !== w.cityId || sc.user_id !== w.u.id || sc.target !== "description" || sc.result !== "flag" || sc.rules_version !== (await rulesVersion()) || Date.parse(sc.created_at) < now - DAY) {
    return fail("cannot_review", 409);
  }
  const frozen = await notFrozen(env, w, fetchImpl, now);
  if (frozen) return frozen;
  if (await openRequest(db, w.cityId, w.seat.id)) return fail("request_open", 409);
  const base = await basisOf(env, { cityId: w.cityId, seat: w.seat, d: w.d, now, draw: true });
  const v = await withDescription(env, w, base, sc.text);
  const at = iso(now);
  try {
    await db.batch([
      ...(base.isDefaults && base.content && !base.choice ? [defaultsStmt(db, w, base, at)] : []),
      db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
        VALUES (?, 'description', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(w.cityId, v.content, v.hash, v.name, v.symbol, v.description, v.artSha, v.templateVersion, w.u.id, at),
      db.prepare(`INSERT INTO coin_requests (city_id, kind, status, seat_id, user_id, base_hash, version_id, content_hash, screening_id, submitted_at, created_at, updated_at)
        SELECT ?, 'description', 'pending', ?, ?, ?, (SELECT id FROM coin_versions WHERE city_id = ? AND content_hash = ?), ?, ?, ?, ?, ? WHERE ${NO_HOLD}`)
        .bind(w.cityId, w.seat.id, w.u.id, base.hash, w.cityId, v.hash, v.hash, sc.id, at, at, at, holdKey(w.cityId), at),
      guard(db, "EXISTS (SELECT 1 FROM coin_requests WHERE city_id = ? AND status = 'pending' AND submitted_at = ? AND screening_id = ?)", [w.cityId, at, sc.id]),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || e))) return fail("request_open", 409);
    if (guardFailed(e)) return fail(await whyNot(env, w.cityId, now), 409);
    throw e;
  }
  return answer(env, w, fetchImpl, now, { submitted: true });
}

/** POST /api/coins/review/description/default { cityId }: the default description again (a pending description request is cancelled first). */
async function describeDefaultRoute(request, env, fetchImpl, now) {
  const w = await founderPost(request, env, now, fetchImpl, "describe_default");
  if (w.error) return w.error;
  const db = env.DB, at = iso(now);
  const pend = await pendingRequest(db, w.cityId);
  if (pend && pend.kind === "change") return fail("request_pending", 409);
  const frozen = await notFrozen(env, w, fetchImpl, now);
  if (frozen) return frozen;
  const before = pend ? [db.prepare("UPDATE coin_requests SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(at, at, pend.id)] : [];
  // keeping the default puts the last flagged check and a "changes needed" description card away: the default is checked now (it is
  // the newest check, so the flagged one is no longer shown) and that card is dismissed, whether or not the coin had the default already
  const kept = await screenText(w.d.description, await screenCtx(env, w.d));
  if (kept.result === "pass") before.push(await screeningStmt(db, { cityId: w.cityId, userId: w.u.id, target: "description", r: { ...kept, text: w.d.description }, at }));
  before.push(dismissDescriptionCards(db, w, at));
  const base = await basisOf(env, { cityId: w.cityId, seat: w.seat, d: w.d, now, draw: true });
  if (base.description === w.d.description && base.choice) {
    await db.batch(before);
    return answer(env, w, fetchImpl, now, { already: true });
  }
  const v = await withDescription(env, w, base, w.d.description);
  const onDefaults = base.name === w.d.name && base.symbol === w.d.ticker && base.templateColumn === TEMPLATE_VERSION && (await storedArtOf(env, w.d) || {}).sha256 === base.art;
  const s = await select(env, { w, now, before, v: { ...v, origin: onDefaults ? "default" : "description" },
    log: { actorId: w.u.id, role: "founder", action: "coin_description", reason: "default", note: `${w.seat.city_name}: back to the default description, version ${versionLabel(v.hash)}` } });
  if (s.error) return s.error;
  return answer(env, w, fetchImpl, now, { used: true });
}

/** GET /api/coins/review/ticker-check?city=&t=: may this founder request this ticker? */
async function tickerCheckRoute(request, env, fetchImpl, now) {
  if (!env.DB) return fail("unavailable", 503);
  const a = await access(request, env, now, { write: false });
  if (a.error) return a.error;
  const q = new URL(request.url).searchParams, cityId = q.get("city") || "", t = String(q.get("t") || "").trim().toUpperCase();
  if (!cityIdOk(cityId)) return fail("bad_city", 400);
  const seat = await liveSeatOfUser(env.DB, a.u.id);
  if (!seat || String(seat.city_id) !== cityId || !LIVE.includes(seat.status)) return fail("not_founder", 403);
  const slow = await counted(env, "ticker", a.u.id, now);
  if (slow) return slow;
  const p = await tickerProblem(env, cityId, t, fetchImpl, { chain: false });
  return json({ ok: true, ticker: t, available: !p, code: p ? p.code : null, message: p ? p.message : `$${t} looks free. A reviewer checks it again before approving it.` }, 200, { "Cache-Control": "no-store" });
}

const ROUTES = { draft: draftRoute, submit: submitRoute, cancel: cancelRoute, edit: editRoute, reset: resetRoute, description: descriptionRoute,
  "description/review": describeReviewRoute, "description/default": describeDefaultRoute };
/** /api/coins/review/<sub> (src/index.js sends every such path here; with the switch off each is an unknown path). */
export async function handleReview(request, env, sub, fetchImpl = fetch, now = Date.now()) {
  if (!coinV2ReviewOn(env)) return json({ error: "not_found" }, 404);
  if (sub === "ticker-check") return request.method === "GET" ? tickerCheckRoute(request, env, fetchImpl, now) : json({ ok: false, error: "method_not_allowed" }, 405);
  const route = ROUTES[sub];
  if (!route) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  return route(request, env, fetchImpl, now);
}

/* ---------------------------------------------------------------- the admin queue (src/admin.js wires the routes and the roles) */
const maskWallet = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);
const RECENT_DAYS = 30;
/** GET /api/admin/coins/reviews: what waits (oldest first), then what was decided in the last 30 days; the approved tickers waiting for the list. */
export async function listReviews(env, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  await ensureReviewSchema(db);
  const rows = (await db.prepare(`SELECT r.*, u.handle, s.wallet AS seat_wallet, s.city_name, s.country, s.status AS seat_status
      FROM coin_requests r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN seats s ON s.id = r.seat_id
      WHERE r.status = 'pending' OR (r.status IN ('approved', 'changes_needed') AND r.decided_at >= ?)
      ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, CASE WHEN r.status = 'pending' THEN r.submitted_at END ASC, r.decided_at DESC LIMIT 200`)
    .bind(iso(now - RECENT_DAYS * DAY)).all()).results;
  const reviews = [];
  for (const r of rows) reviews.push(await reviewRow(env, r, now, fetchImpl));
  const waiting = reviews.filter((x) => x.status === "approved" && x.registryState === "waiting").map((x) => ({ id: x.id, city: x.city, ticker: x.proposed.symbol, registryPatch: x.registryPatch }));
  return { ok: true, reviews, pending: reviews.filter((x) => x.status === "pending").length, waitingRegistry: waiting, inUse: await founderContent(db),
    reasons: Object.entries(REASONS).map(([code, text]) => ({ code, text, kinds: REASON_KINDS[code] })) };
}
/**
 * What of the founders' own is public on a coin now, launched or not (the newest first, at most 200): a description that passed the
 * screening by itself never comes through the queue, so the staff see every one here, with the takedown (src/cointakedown.js) at hand.
 * A coin counts while the version is its design (not launched) or is bound to it (launched); a founder's description, a name no default
 * version of the city has, or an uploaded picture.
 */
async function founderContent(db) {
  const rows = await rd(() => db.prepare(`SELECT r.city_id, r.mint, r.chosen_at, r.design_at, r.content_hash, v.name, v.symbol, v.description, v.art_sha256, v.template_version,
      v.content_json, c.updated_at AS design_now, c.city_name, c.country,
      NOT EXISTS (SELECT 1 FROM coin_versions d WHERE d.city_id = r.city_id AND d.origin = 'default' AND d.name = v.name) AS own_name
    FROM coin_ready r JOIN coin_versions v ON v.id = r.version_id LEFT JOIN city_coins c ON c.city_id = r.city_id
    WHERE v.origin <> 'default' ORDER BY r.chosen_at DESC LIMIT 200`).all());
  const out = [];
  for (const r of (rows && rows.results) || []) {
    if (!r.mint && r.design_at !== r.design_now) continue; // not the coin any more (a studio design replaced it)
    let content = null;
    try { content = JSON.parse(r.content_json); } catch { continue; }
    const ownDescription = r.description !== cityDescription(content.city), upload = r.template_version === "upload", ownName = Boolean(r.own_name);
    if (!ownDescription && !upload && !ownName) continue;
    out.push({ city: { id: String(r.city_id), name: (content.city && content.city.name) || r.city_name, country: r.country }, launched: Boolean(r.mint), mint: r.mint || null,
      name: r.name, symbol: r.symbol, description: r.description, ownDescription, ownName, upload, art: artPath(r.art_sha256), version: versionLabel(r.content_hash), chosenAt: r.chosen_at });
  }
  return out;
}
async function reviewRow(env, r, now, fetchImpl) {
  const db = env.DB;
  const v = await versionById(db, r.version_id);
  const base = await versionByHash(db, r.city_id, r.base_hash);
  const content = v ? JSON.parse(v.content_json) : null;
  const city = content ? content.city : { id: r.city_id, name: r.city_name, country: r.country };
  const proposedArt = v ? ((await artBytes(db, v.art_sha256)) ? artPath(v.art_sha256) : `/api/admin/coins/reviews/art?id=${r.id}`) : null;
  const diff = [];
  if (v && base) {
    if (v.art_sha256 !== base.art_sha256) diff.push({ field: "picture", from: artPath(base.art_sha256), to: proposedArt });
    if (v.symbol !== base.symbol) diff.push({ field: "ticker", from: `$${base.symbol}`, to: `$${v.symbol}` });
    if (v.name !== base.name) diff.push({ field: "name", from: base.name, to: v.name });
    if (v.description !== base.description) diff.push({ field: "description", from: base.description, to: v.description });
  }
  const checks = [];
  const live = await liveSeatOfCity(db, r.city_id);
  const d = live ? await coinDefaults(env, r.city_id, live.country) : { ok: false };
  if (r.status === "pending" && v) {
    const sameSeat = Boolean(live && live.id === r.seat_id && LIVE.includes(live.status));
    checks.push({ check: "founder", ok: sameSeat, text: sameSeat ? "The founder still holds the seat." : "The founder who sent this no longer holds the seat: nothing to decide." });
    const ban = live ? (await activeBan(db, live.user_id, live.country, now)) : null;
    checks.push({ check: "ban", ok: !ban, text: ban ? "The founder is suspended." : "No ban." });
    const st = await coinState(env, r.city_id);
    checks.push({ check: "launched", ok: !st.launched && !st.pending, text: st.launched ? "The city's coin has launched." : st.pending ? "A LaunchLab contract waits for this city." : "No coin launched yet." });
    const np = nameProblem(v.name) || checkName(v.name);
    checks.push({ check: "name", ok: !np, text: np || "The name can be written on the blockchain." });
    if (d.ok && v.symbol !== d.ticker) {
      const t = await tickerProblem(env, r.city_id, v.symbol, fetchImpl, { chain: false, exceptRequest: r.id });
      checks.push({ check: "ticker", ok: !t, text: t ? t.message : `$${v.symbol} is free (not in the city list, not launched, approved or chosen elsewhere). If approved, it goes into scripts/cities/ticker-overrides.json and the launch waits for that update.` });
    }
    if (r.name_screening) {
      const issues = JSON.parse(r.name_screening);
      checks.push({ check: "name_screening", ok: false, text: issues.some((x) => x.field === "ticker") ? "The checks flagged the name or the ticker." : "The checks flagged the name.", issues });
    }
    if (r.kind === "description" && r.screening_id) {
      const sc = await db.prepare("SELECT issues_json, text FROM coin_screenings WHERE id = ?").bind(r.screening_id).first();
      if (sc) {
        const issues = await explained(JSON.parse(sc.issues_json || "[]"), city && city.name);
        // "review" alone: the checks found nothing, which proves nothing about ordinary words (src/screen.js): read it all. One
        // sentence says so; the "review" issue's own sentence (written for the founder) would only say "found nothing" again (COPY-2)
        const plain = issues.every((x) => x.code === "review");
        const text = plain ? "The automatic checks found nothing to point out. Read every word: no check can tell an honest sentence from a threat, a scam or hate written in ordinary words."
          : "The checks flagged the description.";
        checks.push({ check: "description_screening", ok: false, text, issues: plain ? [] : issues });
      }
    }
    // words an admin took down from this city's coin before (src/cointakedown.js): approving them puts them back
    const downs = await rd(() => db.prepare(`SELECT target, text, created_at FROM coin_screenings WHERE city_id = ? AND rules_version = '${TAKEDOWN}' ORDER BY id DESC LIMIT 50`).bind(String(r.city_id)).all());
    for (const x of (downs && downs.results) || []) {
      const hit = x.target === "name" ? x.text === v.name : x.text === v.description;
      if (hit && !checks.some((k) => k.check === `taken_down_${x.target}`)) {
        checks.push({ check: `taken_down_${x.target}`, ok: false, text: `Vicinity took this ${x.target === "name" ? "coin name" : "description"} down on ${String(x.created_at).slice(0, 10)}. Approving it puts it back on the coin.` });
      }
    }
  }
  const registry = r.status === "approved" && v && d.ok ? (v.symbol !== d.ticker ? "waiting" : r.registry_state ? "live" : null) : r.registry_state || null;
  return {
    id: r.id, kind: r.kind, status: r.status, label: STATUS_LABEL[r.status] || r.status,
    city: { id: String(r.city_id), name: city && city.name, region: (city && city.region) || null, country: city && city.country, countryName: (city && city.countryName) || null },
    founder: { handle: r.handle || null, wallet: maskWallet(r.seat_wallet) },
    submittedAt: r.submitted_at, decidedAt: r.decided_at, version: versionLabel(r.content_hash), contentHash: r.content_hash,
    current: base ? { name: base.name, symbol: base.symbol, description: base.description, art: artPath(base.art_sha256) } : null,
    proposed: v ? { name: v.name, symbol: v.symbol, description: v.description, art: proposedArt, upload: v.template_version === "upload" } : null,
    diff, checks, why: r.draft_reason || null,
    decision: r.status === "pending" ? null : { reasonCode: r.reason_code || null, reason: r.reason_code ? REASONS[r.reason_code] || REASONS.other : null, note: r.note || null },
    registryState: registry, registryPatch: registry === "waiting" && v ? { [String(r.city_id)]: v.symbol } : null,
  };
}

/** GET /api/admin/coins/reviews/art?id=: a request's proposed picture for the staff, only while its bytes are the version's own. */
export async function reviewArt(env, url) {
  const id = Number(new URL(url).searchParams.get("id"));
  const notFound = () => json({ ok: false, error: "not_found" }, 404);
  if (!Number.isSafeInteger(id) || id <= 0) return notFound();
  const r = await requestById(env.DB, id);
  const v = r ? await versionById(env.DB, r.version_id) : null;
  if (!v) return notFound();
  let pic = await artBytes(env.DB, v.art_sha256);
  if (!pic && r.draft_media_id) {
    const m = await env.DB.prepare("SELECT type, bytes FROM media WHERE id = ? AND user_id = ?").bind(r.draft_media_id, r.user_id).first();
    const bytes = m ? toBytes(m.bytes) : null;
    if (m && IMAGE_TYPES.has(m.type) && (await sha256Hex(bytes)) === v.art_sha256) pic = { type: m.type, bytes };
  }
  if (!pic) return notFound();
  return new Response(pic.bytes, { headers: { "Content-Type": pic.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline", "Cache-Control": "private, max-age=600" } });
}

/**
 * POST /api/admin/coins/reviews/decide { id, action: "approve" | "changes_needed", contentHash, reasonCode?, note? } (src/admin.js: an
 * admin or the owner with a fresh proof). Approves EXACTLY the version the reviewer saw (its hash echoed and recomputed), or asks for
 * changes with a reason the founder reads in plain words and an optional note only they see. Never the city's own founder. `ctx`: the
 * admin guard's { user, wallet, role, db, now, env }.
 */
export async function decideReview(env, ctx, body, fetchImpl = fetch) {
  const db = env.DB, now = ctx.now;
  await ensureReviewSchema(db);
  if (!body || typeof body !== "object") return { status: 400, error: "bad_request" };
  const id = Number(body.id), action = body.action;
  if (!Number.isSafeInteger(id) || !["approve", "changes_needed"].includes(action) || !/^[0-9a-f]{64}$/.test(String(body.contentHash || ""))) return { status: 400, error: "bad_request" };
  const r = await requestById(db, id);
  if (!r) return { status: 404, error: "not_found" };
  if (r.status !== "pending") return { status: 409, error: "not_pending", message: "This request was decided, cancelled or withdrawn meanwhile. Reload." };
  const v = await versionById(db, r.version_id);
  if (!v || v.content_hash !== r.content_hash || body.contentHash !== r.content_hash || (await sha256Hex(v.content_json)) !== v.content_hash) {
    return { status: 409, error: "version_changed", message: "The founder changed this request since you opened it. Reload." };
  }
  const seatRow = await db.prepare("SELECT * FROM seats WHERE id = ?").bind(r.seat_id).first();
  const live = await liveSeatOfCity(db, r.city_id);
  // the second person: never the founder who asked, nor whoever holds the city's seat (by account or by wallet)
  if (ctx.user.id === r.user_id || (seatRow && ctx.wallet === seatRow.wallet) || (live && (live.user_id === ctx.user.id || live.wallet === ctx.wallet))) {
    return { status: 403, error: "needs_second_person", message: "A city's own founder can't decide their own coin. Another admin or the owner decides." };
  }
  if (!live || live.id !== r.seat_id || !LIVE.includes(live.status)) return { status: 409, error: "founder_changed", message: "The founder who sent this no longer holds the city's seat. Nothing to decide." };
  const st = await coinState(env, r.city_id);
  if (st.launched) return { status: 409, error: "launched", message: ERRORS.launched };
  if (st.pending) return { status: 409, error: "legacy_contract", message: ERRORS.legacy_contract };
  const at = iso(now), label = versionLabel(r.content_hash);
  const content = JSON.parse(v.content_json);
  const cityName = (content.city && content.city.name) || live.city_name;
  const audit = (what, detail) => db.prepare("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)").bind(ctx.wallet, what, `city_coin:${r.city_id}`, detail, at);
  const what = r.kind === "change" ? "coin change" : "description";

  if (action === "changes_needed") {
    const code = body.reasonCode;
    if (!REASONS[code] || !REASON_KINDS[code].includes(r.kind)) return { status: 400, error: "reason_required", message: "Pick a reason the founder will read (one that fits this kind of request)." };
    const note = body.note == null || body.note === "" ? null : cleanText(body.note, 300);
    if (body.note != null && body.note !== "" && (note == null || note.length < 3)) return { status: 400, error: "bad_note", message: "The note is 3 to 300 characters (or none)." };
    const res = await db.batch([
      db.prepare(`UPDATE coin_requests SET status = 'changes_needed', reason_code = ?, note = ?, decided_at = ?, decided_by = ?, closed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND content_hash = ?`).bind(code, note, at, ctx.user.id, at, at, id, r.content_hash),
      db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
          SELECT ?, ?, ?, 'city_coin', NULL, ?, ?, ?, ?, ?, ?, 'done' WHERE EXISTS (SELECT 1 FROM coin_requests WHERE id = ? AND status = 'changes_needed' AND decided_at = ?)`)
        .bind(ctx.user.id, ctx.role === "owner" ? "owner" : "admin", r.kind === "change" ? "coin_change_needs_changes" : "coin_description_needs_changes", r.user_id, live.country, String(r.city_id), code,
          `${cityName}: ${what} version ${label} needs changes`, at, id, at),
      audit(r.kind === "change" ? "coins/changes_needed" : "coins/description_changes_needed", `request ${id} version ${r.content_hash} · ${code}`),
    ]);
    if (!res[0].meta.changes) return { status: 409, error: "not_pending", message: "This request was decided, cancelled or withdrawn meanwhile. Reload." };
    await notify(env, { to: r.user_id, kind: "founder", ref: r.city_id, href: "/dashboard#founder", now,
      text: `Your ${what} needs changes: ${REASONS[code]}` });
    return { ok: true, id, status: "changes_needed" };
  }

  // approve: nothing on chain may fix the coin meanwhile, and the content is checked again as it would launch
  let frozen;
  try { frozen = await designFrozen(env, r.city_id, fetchImpl, now); } catch { return { status: 503, error: "rpc_unavailable", message: ERRORS.rpc_unavailable }; }
  if (frozen === "launched") return { status: 409, error: "launched", message: ERRORS.launched };
  if (frozen === "held") return { status: 409, error: "held", message: "The owner is approving this city on the blockchain right now. Try again in 5 minutes." };
  if (frozen === "approved") return { status: 409, error: "approved_on_chain", message: "The city's coin is approved on the blockchain as it was. Revoke that approval in City coins first, then approve this change." };
  if (nameProblem(v.name) || checkName(v.name) || checkSymbol(v.symbol) || PITCH_BAD.test(v.description || "")) return { status: 409, error: "bad_content", message: "This version's name, ticker or description can't be written into a coin." };
  const d = await coinDefaults(env, r.city_id, live.country);
  if (!d.ok) return { status: d.code === "list_unavailable" ? 503 : 409, error: d.code, message: d.message };
  if (v.symbol !== d.ticker) {
    const t = await tickerProblem(env, r.city_id, v.symbol, fetchImpl, { exceptRequest: id });
    if (t && t.code !== "same_ticker") return { status: t.code === "ticker_unchecked" ? 503 : 409, error: t.code === "ticker_unchecked" ? "rpc_unavailable" : "ticker_taken", message: t.message };
  }
  // the picture becomes public only now: copied from the founder's private media row into the content-addressed store, bytes checked
  const before = [];
  if (!(await artBytes(db, v.art_sha256))) {
    const m = r.draft_media_id ? await db.prepare("SELECT type, bytes FROM media WHERE id = ? AND user_id = ?").bind(r.draft_media_id, r.user_id).first() : null;
    const bytes = m ? toBytes(m.bytes) : null;
    const upload = v.template_version === "upload";
    if (!m || !IMAGE_TYPES.has(m.type) || (await sha256Hex(bytes)) !== v.art_sha256 || (upload && (m.type !== "image/png" || !squarePng(bytes)))) {
      return { status: 409, error: "art_changed", message: "The proposed picture can't be read as it was sent. Ask the founder to send it again." };
    }
    const svgSha = upload ? `upload:${v.art_sha256}` : await sha256Hex(coinSvg({ ticker: v.symbol, city: v.name, templateVersion: TEMPLATE_VERSION }));
    before.push(db.prepare("INSERT OR IGNORE INTO coin_art (sha256, svg_sha256, template_version, type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(v.art_sha256, svgSha, upload ? "upload" : TEMPLATE_VERSION, m.type, bytes, at));
  }
  const registry = v.symbol !== d.ticker ? "waiting" : null;
  before.push(db.prepare(`UPDATE coin_requests SET status = 'approved', decided_hash = content_hash, decided_at = ?, decided_by = ?, registry_state = ?, closed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND content_hash = ?`).bind(at, ctx.user.id, registry, at, at, id, r.content_hash));
  const w = { cityId: String(r.city_id), seat: live, userId: r.user_id, u: { id: r.user_id } };
  const s = await select(env, { w, now, noPending: false, before,
    v: { content: v.content_json, hash: v.content_hash, name: v.name, symbol: v.symbol, description: v.description, artSha: v.art_sha256, templateVersion: v.template_version, origin: v.origin },
    // the public log names the version, never the founder's words (a name or ticker taken down later must not stay public: NEW-1-R);
    // the staff audit below keeps the request and its hash
    log: { actorId: ctx.user.id, role: ctx.role === "owner" ? "owner" : "admin", action: r.kind === "change" ? "coin_change_approved" : "coin_description_approved", reason: "review",
      note: `${cityName}: ${what} approved, version ${label}` },
    after: [audit(r.kind === "change" ? "coins/approve" : "coins/description_approve", `request ${id} version ${r.content_hash}${registry ? ` · ticker ${v.symbol} waits for the city list` : ""}`),
      guard(db, "EXISTS (SELECT 1 FROM coin_requests WHERE id = ? AND status = 'approved' AND decided_at = ?)", [id, at])] });
  if (s.error) {
    const e = await s.error.json();
    return { status: s.error.status, error: e.error === "coin_changed" ? "version_changed" : e.error, message: e.error === "request_pending" ? ERRORS.request_pending : e.message || "The coin changed meanwhile. Reload." };
  }
  await notify(env, { to: r.user_id, kind: "founder", ref: r.city_id, href: "/dashboard#founder", now,
    text: r.kind === "change"
      ? (registry ? `Your coin change was approved. $${v.symbol} goes into the Vicinity city list once an admin adds it; then your coin goes into the owner's next approval round.` : "Your coin change was approved. It is your coin now.")
      : "Your description was approved." });
  return { ok: true, id, status: "approved", ...(registry ? { registryPatch: { [String(r.city_id)]: v.symbol } } : {}) };
}

/* ---------------------------------------------------------------- the launch path and the owner's list (src/lplaunch.js, src/lpadmin.js) */
/**
 * What the review rules say about launching this city now, for the launch status and build: null, or { state: "paused", error, message }.
 * A pending request pauses it (COIN_V2_REVIEW on); a chosen version the on-chain approval was built from must still be launchable (its
 * description screened again, its picture intact, its approved ticker in the city list); an approval that names another name or ticker
 * than the founder's reviewed coin, or that was built from an earlier version of it, is for their earlier coin.
 * With the switch off (turned off after use, docs/DEPLOY.md) a pending request pauses nothing any more, but a version the review paths
 * made (a founder's description, an approved change) is still checked exactly so: switching off never makes one launchable unchecked.
 * Vicinity's defaults, the only versions there are without the switch, are not looked at then (stage 1's launch, unchanged).
 */
export async function launchHold(env, cityId, approval) {
  const on = coinV2ReviewOn(env), db = env.DB;
  if (on) {
    const pend = await pendingRequest(db, cityId);
    if (pend) {
      const p = await selectionProblem(env, cityId);
      return { state: "paused", error: p.code, message: p.message };
    }
  }
  const c = await chosenOf(db, cityId, { fresh: true });
  if (!c || !c.current || !c.content) return null;
  if (!on && !reviewMade(c)) return null;
  if (approval && (approval.name !== c.name || approval.symbol !== c.symbol)) {
    if (c.origin && c.origin !== "default") {
      return { state: "paused", error: "approval_mismatch", message: `Your launch approval on the blockchain is for your earlier coin, not the one you have now. The owner approves your current coin ${NEXT_ROUND}.` };
    }
    return null;
  }
  // the approval was built from an earlier version of this coin (a description or the defaults chosen since): what launches now would
  // not be what the owner approved, so it waits for the owner's next round to approve the coin as it is
  if (approval && c.approved_hash && c.approved_hash !== c.content_hash) return { state: "paused", error: "approval_changed", message: APPROVAL_CHANGED };
  if (c.approved_hash === c.content_hash) {
    const p = await selectionProblem(env, cityId, { c, pending: on });
    if (p) return { state: "paused", error: p.code, message: p.message };
  }
  return null;
}
/** A chosen version that only the review paths make: a founder's description, an approved change, or a hash kept from an earlier approval. */
const reviewMade = (c) => Boolean((c.origin && c.origin !== "default") || (c.approved_hash && c.approved_hash !== c.content_hash));
/**
 * Why the founder's launch, not approved on chain yet (or expired), will not be approved at the next round either: a request or a
 * description waiting for review, an approved ticker the city list does not carry yet, a description that no longer passes... (the
 * owner's list blocks it for the same reason: candidateProblem). null, or { state: "paused", error, message }. The launch status says
 * this instead of "your launch opens after the owner's next approval round", which would not be true.
 */
export async function reviewPause(env, cityId) {
  const on = coinV2ReviewOn(env);
  if (!on) {
    const c = await chosenOf(env.DB, cityId, { fresh: true });
    if (!c || !c.current || !c.content || !reviewMade(c)) return null;
  }
  const p = await selectionProblem(env, cityId, { pending: on });
  return p ? { state: "paused", error: p.code, message: p.message } : null;
}
/**
 * Why the owner's list may not approve this city's choice now, in the owner's words; or null. With COIN_V2_REVIEW off only a version the
 * review paths made is looked at (checked as with it on, but no request pauses anything any more): see launchHold.
 */
export async function candidateProblem(env, cityId, country) {
  const on = coinV2ReviewOn(env);
  if (on) {
    const pend = await pendingRequest(env.DB, cityId);
    if (pend) return `The founder's ${pend.kind === "change" ? "change request" : "description"} waits for review (admin → Moderation → Coin reviews). Nothing is approved until it is decided.`;
  } else {
    const c = await chosenOf(env.DB, cityId, { fresh: true });
    if (!c || !c.current || !c.content || !reviewMade(c)) return null;
  }
  const p = await selectionProblem(env, cityId, { country, pending: false });
  if (!p) return null;
  if (p.code === "registry_waiting") return `The founder's new ticker $${(await chosenOf(env.DB, cityId, { fresh: true }) || {}).symbol || ""} is approved and waits for the Vicinity city list (scripts/cities/ticker-overrides.json in a pull request, then a deploy); nothing is approved until the list carries it.`;
  return `The founder's coin can't be approved as it is: ${p.message}`;
}

/* ---------------------------------------------------------------- the job (src/jobs.js, every 10 minutes while the switch is on) */
/** Approved ticker changes the city list now carries: registry_state "live", and the founder is told (once). */
export async function registryStep(env, now = Date.now()) {
  if (!coinV2ReviewOn(env) || !env.DB) return { skipped: "off" };
  const rows = await rd(() => env.DB.prepare(`SELECT r.id, r.city_id, r.user_id, v.symbol FROM coin_requests r JOIN coin_versions v ON v.id = r.version_id
      WHERE r.status = 'approved' AND r.registry_state = 'waiting' LIMIT 50`).all());
  let live = 0;
  for (const r of (rows && rows.results) || []) {
    const t = await tickerOf(env, r.city_id);
    if (!t || t.ticker !== r.symbol) continue;
    const res = await env.DB.prepare("UPDATE coin_requests SET registry_state = 'live', updated_at = ? WHERE id = ? AND registry_state = 'waiting'").bind(iso(now), r.id).run();
    if (!res.meta.changes) continue;
    live++;
    await notify(env, { to: r.user_id, kind: "founder", ref: r.city_id, href: "/dashboard#founder", now, text: `Your new ticker $${r.symbol} is in the Vicinity city list now. Your coin launches after the owner's approval on the blockchain.` });
  }
  return { live };
}
