/**
 * The owner's daily launch-approval round on the LIVE launchpad program (COIN_V2_BATCH=on with COIN_V2_READY=on, src/flags.js; DESIGN.md
 * 6.5 and 9.4; owner decisions D1 "A", D2 "every eligible founder whose coin is chosen is pre-approved", D3 "14 days, renewed when under
 * 48 hours are left"). The program (vicinity_launchpad AkMP9q…) needs the admin's signature on every approve_launch, and the admin is the
 * owner's own wallet: nothing here changes that. The Worker lists, checks and builds; the owner's wallet signs every transaction
 * (public/lp-sign.js signMany), and the Worker never signs and never holds a key. A founder whose coin was approved in a round then
 * launches with no per-launch admin step (the existing launch path, src/lplaunch.js).
 *
 *   GET  /api/admin/lp/batch?cluster=     (owner, lpSetup on) every city in four groups, each row with the city, $TICKER, coin name, the
 *                                         founder (masked, full in `founder`), the version hash and the checks:
 *     approve   the founder's chosen coin (src/coinready.js "Use this coin", or a version a reviewer approved) passes every check of the
 *               one-at-a-time card (src/lpadmin.js candidateList: the seat, the wallet, the ticker from the city list and not launched or
 *               approved for another city, a pending request, a flagged description, a waiting LaunchLab contract...) AND the founder
 *               holds the founder amount right now (read live, nothing written) AND is not banned; no approval is on chain yet
 *     renew     an approval on chain for exactly that coin and founder with under 48 hours left (or expired), or one whose wallet lost
 *               the seat to a new founder whose coin passes everything: revoke + approve in ONE transaction, a fresh 14 days
 *     revoke    an approval on chain whose wallet no longer holds the seat (no founder, another wallet, grace, not final), whose founder
 *               is banned, whose city has a change request or description waiting, whose coin no longer passes the review rules, or
 *               that expired: the program lets an approved wallet launch until it expires, so it is withdrawn (its rent comes back)
 *     blocked   everything else, with the reasons in plain words (nothing is built for it)
 *   POST /api/admin/lp/batch/tx           (owner, fresh wallet proof, same site) { cluster, rows: [{ cityId, action, founder, name, symbol,
 *                                         contentHash }] }: the rows the card showed and the owner left ticked, echoed. Every check runs
 *                                         again, fresh (Meteora's two programs read again too: never a build on an untested program), and a
 *                                         row is built ONLY when the fresh row is exactly the echoed one (same action, founder, name, ticker
 *                                         and version): anything else is dropped with the reason (`dropped`), never swapped for something
 *                                         the owner did not see. Each design is held (src/lpcoins.js holdDesign) and read again before it
 *                                         is built. Answer: UNSIGNED transactions (src/lpkit.js buildTx: simulated, the decoded list, the
 *                                         SOL change), each with up to 5 cities and within Solana's 1,232 bytes (measured, src/lpadmin.js
 *                                         fits), in the order to sign; each says what to record once it lands.
 *   POST /api/admin/lp/record             { step: "batch", signature, params: { cities: [{ cityId, action }] } } (src/lpadmin.js recordStep):
 *                                         the transaction is confirmed, paid by the owner's wallet and touched each city's approval; the
 *                                         chain must show each approval (approve, renew) or its absence (revoke); then lp_approvals_log
 *                                         (renew: a revoke line, then an approve line) and the founder's notice.
 * No new table or column: the list is worked out live, every time, from the chain and the existing tables.
 */
import { json } from "./http.js";
import { HOUR, iso } from "./policy.js";
import { lpSetup } from "./cluster.js";
import { activeBan } from "./roles.js";
import { holdsFounderAmount } from "./seats.js";
import { check, limitKey } from "./limits.js";
import { ensureLimitsSchema } from "./store.js";
import { holdDesign } from "./lpcoins.js";
import { chosenOf, ensureReadySchema, markApprovedStatement } from "./coinart-store.js";
import { pendingRequest, selectionProblem } from "./coinreview.js";
import { coinV2ReviewOn } from "./flags.js";
import { notify } from "./notify.js";
import { buildTx, lpRpc, readAccounts } from "./lpkit.js";
import { decodeLaunchpad } from "./sol/dbc.js";
import { programHashes, programRefusal } from "./programpins.js";
import { launchpad as launchpadPdas } from "./sol/pda.js";
import * as IX from "./sol/lpadmin-ix.js";
import { LAYOUT } from "./sol/layout.js";
import { candidateList, cityIdOf, decodeApproval, ensureLpAdminSchema, fits } from "./lpadmin.js";

const DAY_S = 86_400;
/** The round's rules: D3 (14 days, renewed under 48 hours), 5 cities a transaction (DESIGN 9.4), at most 40 cities in one signing. */
export const BATCH = Object.freeze({ days: 14, renewUnderHours: 48, perTx: 5, maxRows: 40 });
/** Per owner wallet, counted before the work (src/limits.js): the list reads the whole program; a build reads it again and simulates. */
export const BATCH_LIMITS = Object.freeze({ list: { max: 120, windowMs: HOUR }, tx: { max: 30, windowMs: HOUR } });
const APPROVAL_MAX_S = Number(LAYOUT.constants.APPROVAL_MAX_SECS);
const ACTIONS = ["approve", "renew", "revoke"];
const LIVE = ["active", "steward"];
const HASH_RE = /^[0-9a-f]{64}$/;
export const maskWallet = (w) => (typeof w === "string" && w.length > 12 ? `${w.slice(0, 5)}…${w.slice(-4)}` : w || null);
/** The checks every approve and renew row passed, in the owner's words (the card shows them as "Checks ✓"). */
export const CHECKS = Object.freeze([
  "The founder holds the city's seat (active), with this wallet",
  "The founder holds the founder amount (read live just now) and has no ban",
  "This exact version is the founder's chosen coin: the Vicinity design with the city list's ticker and name, or a change a reviewer approved",
  "No change request or description waits for review, and the description passes the checks",
  "The ticker is not launched or approved for another city, and the city has no coin yet",
]);
const err = (error, message, status = 409, extra = {}) => json({ ok: false, error, ...(message ? { message } : {}), ...extra }, status, { "Cache-Control": "no-store" });

/** The owner's counter for `kind` (list | tx): a 429 answer, or null. */
async function slowDown(env, kind, wallet, now) {
  const spec = BATCH_LIMITS[kind];
  await ensureLimitsSchema(env.DB);
  const r = await check(env, [{ key: await limitKey(env, `lp-batch-${kind}`, wallet), windowMs: spec.windowMs, max: spec.max }], now);
  return r.ok ? null : json({ ok: false, error: "slow_down" }, 429, { "Retry-After": String(Math.ceil(spec.windowMs / 1000)), "Cache-Control": "no-store" });
}

/* ---------------------------------------------------------------- the founder, now */
/**
 * The city's live seat with its account: { id, wallet, status, country, threshold, ..., uid, home_country, handle } or null. The same
 * seat src/lpadmin.js candidateList joins (the newest of the live ones).
 */
const liveSeat = (db, cityId) => db.prepare(`SELECT s.*, u.id AS uid, u.home_country, u.handle FROM seats s LEFT JOIN users u ON u.id = s.user_id
  WHERE s.city_id = ? AND s.status IN ('provisional', 'active', 'grace', 'steward') ORDER BY s.id DESC LIMIT 1`).bind(String(cityId)).first();
/**
 * What candidateList does not look at, for a founder about to be approved or renewed: a ban (home country, seat country, everywhere)
 * and the founder amount held RIGHT NOW (read live: holdsFounderAmount, which writes nothing; the scheduled job starts a grace period).
 * null, or { reason, transient } (transient: the balance could not be read; asked again next time, nothing is revoked for it).
 */
async function founderNow(env, seat, now, fetchImpl) {
  if (!seat || !LIVE.includes(seat.status)) return { reason: "The city has no active founder seat now.", transient: false };
  if (seat.uid && ((await activeBan(env.DB, seat.uid, seat.home_country, now)) || (await activeBan(env.DB, seat.uid, seat.country, now)))) {
    return { reason: "The founder's account is suspended (a ban), so nothing is approved for them.", transient: false, ban: true };
  }
  let holds;
  try { holds = await holdsFounderAmount(env, seat, fetchImpl); } catch { return { reason: "The founder's balance could not be read just now; it is checked again next time.", transient: true }; }
  if (!holds) return { reason: "The founder's balance is below the founder amount right now (read live), so nothing is approved until they hold it again.", transient: false };
  return null;
}
/**
 * A reason that withdraws an approval whose founder still holds the seat: a ban, a change request or a description waiting for review,
 * or a coin the review rules no longer let launch (a ticker change the city list does not carry, a description that fails the current
 * rules, content that cannot be written into a coin). A rule that could not be checked just now is not one (asked again next time).
 */
async function withdrawReason(env, seat, cityId, country, now) {
  if (seat && seat.uid && ((await activeBan(env.DB, seat.uid, seat.home_country, now)) || (await activeBan(env.DB, seat.uid, seat.country, now)))) {
    return "The founder's account is suspended (a ban). The program lets an approved wallet launch until it expires, so the approval is withdrawn.";
  }
  if (coinV2ReviewOn(env)) {
    const pend = await pendingRequest(env.DB, cityId);
    if (pend) return `The founder's ${pend.kind === "change" ? "change request" : "description"} waits for review: the launch is paused until it is decided, so the approval is withdrawn meanwhile (the next round approves the decided coin).`;
  } else {
    // switched off after use: a version the review paths made is still checked (src/coinreview.js launchHold); Vicinity's defaults are not
    const c = await chosenOf(env.DB, cityId, { fresh: true });
    if (!c || !c.current || !c.content || !c.origin || c.origin === "default") return null;
  }
  const p = await selectionProblem(env, cityId, { country, pending: false });
  if (p && ["not_reviewed", "registry_waiting", "description_recheck", "bad_content"].includes(p.code)) return `The founder's coin can't launch as it is (${p.message}), so the approval is withdrawn.`;
  return null;
}

/* ---------------------------------------------------------------- the list */
const hours = (s) => Math.max(0, Math.floor(s / 3600));
/**
 * One row of the round. An approve or renew row carries the coin's description (it goes into the metadata for ever) and whose words it
 * is: "vicinity" (the city list's sentence) or "founder" (their own, which passed the checks by itself: the card leaves it unticked
 * until the owner has read it, BATCH-1).
 */
function rowOf(action, a, { founder, name, symbol, contentHash = null, version = null, art = null, description = null, descriptionBy = null, approval = null, why = null, checks = null, warnings = [] }) {
  return {
    cityId: a.cityId, cityName: a.cityName, country: a.country || null, action, founder, founderMasked: maskWallet(founder), handle: a.handle || null,
    name, symbol, contentHash, version, art, ...(description != null ? { description, descriptionBy } : {}), why, ...(checks ? { checks } : {}), ...(approval ? { approval } : {}), warnings,
  };
}
const approvalView = (ap) => ({ founder: ap.founder, founderMasked: maskWallet(ap.founder), name: ap.name, symbol: ap.symbol, expiresAt: iso(ap.expiresAt * 1000), rentPayer: ap.rentPayer });
const blockedOf = (a, reasons, extra = {}) => ({ cityId: a.cityId, cityName: a.cityName, country: a.country || null, name: a.name || null, symbol: a.symbol || null,
  founderMasked: maskWallet(a.founder), handle: a.handle || null, reasons, ...extra });

/**
 * The round as it stands now (see the header): { groups: { approve, renew, revoke, blocked }, global, meteora, paused, admin, config,
 * settled (approvals on chain that need nothing today), rules }. Reads only (the founder amount is looked at, never acted on).
 */
export async function batchRows(env, ctx, fetchImpl, now) {
  const db = env.DB, nowS = Math.floor(now / 1000);
  const list = await candidateList(env, ctx, fetchImpl, now, { keep: true });
  const global = list.global;
  const own = (reasons) => reasons.filter((x) => !global.includes(x));
  const groups = { approve: [], renew: [], revoke: [], blocked: [] };
  let settled = 0;
  // 1. cities with no approval and no coin: approve the founder's chosen coin, or say why not
  for (const c of list.candidates) {
    const base = { cityId: c.cityId, cityName: c.cityName, country: c.country, founder: c.founder, handle: c.handle, name: c.name, symbol: c.symbol };
    let reasons = own(c.reasons);
    if (!reasons.length && !c.ready) reasons = ["The founder has not chosen the Vicinity coin yet."];
    if (!reasons.length) {
      const f = await founderNow(env, await liveSeat(db, c.cityId), now, fetchImpl);
      if (f) reasons = [f.reason];
    }
    if (reasons.length) { groups.blocked.push(blockedOf(base, reasons)); continue; }
    groups.approve.push(rowOf("approve", base, { founder: c.founder, name: c.name, symbol: c.symbol, contentHash: c.ready.contentHash, version: c.ready.version, art: c.ready.art,
      description: c.ready.description, descriptionBy: c.ready.descriptionBy,
      why: "A new founder's chosen coin: it passes every check.", checks: CHECKS, warnings: c.warnings || [] }));
  }
  // 2. every approval on chain (not only the cities whose design is among the 200 listed): renew, revoke, or nothing
  const launched = new Set(list.launched.map((x) => x.cityId));
  for (const ap of list.onChain || []) {
    const cityId = String(ap.cityId);
    if (launched.has(cityId)) continue;
    const a = list.assessed.get(cityId) || null;
    const seat = await liveSeat(db, cityId);
    const base = a ? { cityId, cityName: a.base.cityName, country: a.base.country, founder: a.base.founder, handle: a.base.handle, name: a.base.name, symbol: a.symbol }
      : { cityId, cityName: seat ? seat.city_name : `City ${cityId}`, country: seat ? seat.country : null, founder: seat ? seat.wallet : null, handle: seat ? seat.handle : null, name: ap.name, symbol: ap.symbol };
    const view = approvalView(ap);
    const left = ap.expiresAt - nowS, expired = left <= 0;
    // the coin this city could be approved for now: its founder's chosen coin, passing every check, the founder's balance and bans included
    let next = null, notNext = null;
    if (a && !own(a.reasons).length && a.readyCoin) {
      const f = await founderNow(env, seat, now, fetchImpl);
      if (!f) next = { founder: a.row.seat_wallet, name: a.row.name, symbol: a.symbol, contentHash: a.readyCoin.contentHash, version: a.readyCoin.version, art: a.readyCoin.art,
        description: a.readyCoin.description, descriptionBy: a.readyCoin.descriptionBy, approvedHash: a.chosen ? a.chosen.approved_hash : null };
      else notNext = [f.reason];
    } else notNext = a ? (own(a.reasons).length ? own(a.reasons) : ["The founder has not chosen the Vicinity coin yet."]) : ["The city has no coin design on this site."];
    const lost = !seat ? "The city has no founder now, but the approved wallet can still launch its coin on chain until the approval expires."
      : seat.wallet !== ap.founder ? "The approved wallet no longer holds the founder seat, but it can still launch the city's coin on chain until the approval expires."
        : !LIVE.includes(seat.status) ? `The founder's seat is ${seat.status === "grace" ? "in its grace period (their balance fell below the bar)" : seat.status === "provisional" ? "not final (still in its appeal window)" : seat.status}, but the approval still works on chain until it expires.` : null;
    const same = next && next.founder === ap.founder && next.name === ap.name && next.symbol === ap.symbol;
    if (same) {
      // the founder changed the coin (a new description, the defaults again) after this approval was built from an earlier version of it
      // (approved_hash: kept by the review routes, src/coinreview.js): made again for the coin as it is now, whatever time is left
      if (next.approvedHash && next.approvedHash !== next.contentHash) {
        groups.renew.push(rowOf("renew", base, { ...next, approval: view, checks: CHECKS, why: `The founder changed the coin after this approval (version ${next.version} now): it is made again for the coin as it is.` }));
        continue;
      }
      if (left >= BATCH.renewUnderHours * 3600) { settled++; continue; }
      // renewed automatically only when the approval on chain was built from this very version (approved_hash): one given by hand
      // before, for the same name and ticker, stands for another design
      if (next.approvedHash !== next.contentHash) {
        groups.blocked.push(blockedOf(base, ["This approval was given by hand before (not from the founder's chosen Vicinity coin), so it is not renewed automatically. Revoke it in the city's card if it should not launch; the next round then approves the chosen coin."], { approval: view }));
        continue;
      }
      groups.renew.push(rowOf("renew", base, { ...next, approval: view, checks: CHECKS,
        why: expired ? `It expired on ${view.expiresAt.slice(0, 16).replace("T", " ")} UTC before the founder launched.` : `It ends in ${hours(left)} hours (renewed under ${BATCH.renewUnderHours}).` }));
      continue;
    }
    if (lost) {
      if (next) groups.renew.push(rowOf("renew", base, { ...next, approval: view, checks: CHECKS, why: `${lost} The new approval names the current founder's chosen coin.` }));
      else groups.revoke.push(rowOf("revoke", base, { founder: ap.founder, name: ap.name, symbol: ap.symbol, approval: view, why: lost }));
      continue;
    }
    const withdraw = await withdrawReason(env, seat, cityId, seat.country, now);
    if (withdraw) { groups.revoke.push(rowOf("revoke", base, { founder: ap.founder, name: ap.name, symbol: ap.symbol, approval: view, why: withdraw })); continue; }
    if (expired) {
      // an expired approval launches nothing; the founder's current coin replaces it, or it is closed (its rent comes back)
      if (next) groups.renew.push(rowOf("renew", base, { ...next, approval: view, checks: CHECKS, why: `The approval for “${ap.name}” ($${ap.symbol}) expired; the new one names the founder's chosen coin.` }));
      else groups.revoke.push(rowOf("revoke", base, { founder: ap.founder, name: ap.name, symbol: ap.symbol, approval: view, why: "It expired before the founder launched. Revoking it returns its rent." }));
      continue;
    }
    if (next) {
      groups.blocked.push(blockedOf(base, [`An approval given earlier names “${ap.name}” ($${ap.symbol}), not the founder's chosen coin “${next.name}” ($${next.symbol}). It stays as it is: that is what can launch until it expires. Revoke it in the city's card to approve the chosen coin in the next round.`], { approval: view }));
      continue;
    }
    if (left < BATCH.renewUnderHours * 3600) { groups.blocked.push(blockedOf(base, [`It ends in ${hours(left)} hours and can't be renewed now: ${notNext.join(" ")}`], { approval: view })); continue; }
    settled++;
  }
  // a ticker twice in one round (the list gives each city its own; a regenerated list or an approved change could still collide): neither
  const bySymbol = new Map();
  for (const r of [...groups.approve, ...groups.renew]) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) || []), r.cityId]);
  for (const g of ["approve", "renew"]) {
    groups[g] = groups[g].filter((r) => {
      if (bySymbol.get(r.symbol).length < 2) return true;
      groups.blocked.push(blockedOf(r, [`The ticker $${r.symbol} is in this round for ${bySymbol.get(r.symbol).length} cities; none is approved until the city list tells them apart.`]));
      return false;
    });
  }
  const byName = (x, y) => String(x.cityName || "").localeCompare(String(y.cityName || "")) || (x.cityId < y.cityId ? -1 : 1);
  for (const g of Object.values(groups)) g.sort(byName);
  return { groups, global, meteora: list.meteora, paused: list.paused, admin: list.admin, config: list.config, settled, launchpad: list.launchpad,
    rules: { days: BATCH.days, renewUnderHours: BATCH.renewUnderHours, perTx: BATCH.perTx, maxRows: BATCH.maxRows } };
}

/** GET /api/admin/lp/batch (see the header). */
export async function batchList(env, ctx, fetchImpl, now) {
  const slow = await slowDown(env, "list", ctx.wallet, now);
  if (slow) return slow;
  const b = await batchRows(env, ctx, fetchImpl, now);
  const { launchpad: _lp, ...out } = b;
  return json({ ok: true, ...out }, 200, { "Cache-Control": "no-store" });
}

/* ---------------------------------------------------------------- building */
const keyOf = (r) => [r.cityId, r.action, r.founder, r.name, r.symbol, r.action === "revoke" ? "" : r.contentHash || ""].join("\u0000");
/** One echoed row, as the card sends it: { cityId, action, founder, name, symbol, contentHash } with every field the right shape, or null. */
function echoOf(x) {
  if (!x || typeof x !== "object") return null;
  const id = cityIdOf(x.cityId);
  if (!id || !ACTIONS.includes(x.action)) return null;
  if (typeof x.founder !== "string" || typeof x.name !== "string" || typeof x.symbol !== "string") return null;
  if (x.action !== "revoke" && !(typeof x.contentHash === "string" && HASH_RE.test(x.contentHash))) return null;
  return { cityId: id.toString(), action: x.action, founder: x.founder, name: x.name, symbol: x.symbol, contentHash: x.action === "revoke" ? null : x.contentHash };
}

/** POST /api/admin/lp/batch/tx (see the header). `route`: the node whose genesis hash was checked (src/lpkit.js checkedRoute). */
export async function batchTx(env, ctx, body, fetchImpl, now, route = null) {
  const s = lpSetup(env), db = env.DB;
  const raw = Array.isArray(body.rows) ? body.rows : null;
  if (!raw || !raw.length) return err("no_rows", "Tick at least one city to sign.", 400);
  if (raw.length > BATCH.maxRows) return err("too_many", `At most ${BATCH.maxRows} cities in one signing. Untick some, sign these, then the rest.`, 400);
  const echoed = raw.map(echoOf);
  if (echoed.some((x) => !x)) return err("bad_row", "A row the page sent is not one this site makes. Reload the page.", 400);
  if (new Set(echoed.map((x) => x.cityId)).size !== echoed.length) return err("duplicate_city", "A city is in this signing twice. Reload the page.", 400);
  const slow = await slowDown(env, "tx", ctx.wallet, now);
  if (slow) return slow;
  // never on a Meteora build the team has not tested (409), nor blind while that cannot be read (503); read fresh, as approveTx does
  const pr = programRefusal(await programHashes(env, fetchImpl, now, { fresh: true, route }), "Approvals");
  if (pr) return err(pr.error, pr.message, pr.status, { which: pr.which });
  const b = await batchRows(env, ctx, fetchImpl, now);
  if (!b.launchpad || b.launchpad.admin !== ctx.wallet) return err("not_admin", `Only the launchpad admin (${b.launchpad ? b.launchpad.admin : "not set"}) can sign approvals.`, 403);
  if (b.global.length) return err("not_ready", b.global.join(" "), 409, { reasons: b.global });
  // each echoed row is built only when the fresh list has exactly it; anything else is dropped with the reason, never replaced
  const fresh = new Map([...b.groups.approve, ...b.groups.renew, ...b.groups.revoke].map((r) => [r.cityId, r]));
  const blocked = new Map(b.groups.blocked.map((r) => [r.cityId, r]));
  const take = [], dropped = [];
  const drop = (x, why) => dropped.push({ cityId: x.cityId, action: x.action, name: x.name, symbol: x.symbol, why });
  for (const x of echoed) {
    const r = fresh.get(x.cityId);
    if (!r) { drop(x, blocked.has(x.cityId) ? blocked.get(x.cityId).reasons.join(" ") : "It is not in today's round any more (approved, launched or changed since the page loaded)."); continue; }
    if (keyOf(r) !== keyOf(x)) { drop(x, "It changed since the page loaded (its action, founder, name, ticker or version). Reload and check it again."); continue; }
    take.push(r);
  }
  // the hold FIRST (every write of the coin's choice checks it in the database), then the design read again: a choice that landed in
  // between is seen here and that row is dropped, so nothing is built from a version the owner did not see (as src/lpadmin.js approveTx)
  const designAt = new Map();
  for (const r of take.filter((x) => x.action !== "revoke")) await holdDesign(env, r.cityId, now);
  const build = [];
  for (const r of take) {
    if (r.action !== "revoke") {
      const row = await db.prepare("SELECT updated_at, name FROM city_coins WHERE city_id = ?").bind(r.cityId).first();
      const c = await chosenOf(db, r.cityId, { fresh: true });
      if (!row || !c || !c.current || c.content_hash !== r.contentHash || c.symbol !== r.symbol || row.name !== r.name) { drop(r, "The founder's coin changed a moment ago. Reload and check it again."); continue; }
      if (coinV2ReviewOn(env) && (await pendingRequest(db, r.cityId))) { drop(r, "The founder sent a change request a moment ago; it waits for review."); continue; }
      designAt.set(r.cityId, row.updated_at);
    }
    build.push(r);
  }
  if (!build.length) return err("batch_changed", "Nothing in this signing can be built as it was shown. Reload the list.", 409, { dropped });
  const L = launchpadPdas(s.programId), nowS = Math.floor(now / 1000);
  // the program refuses more than 30 days after ITS clock; D3 is 14
  const expiresAt = nowS + Math.min(BATCH.days * DAY_S, APPROVAL_MAX_S - 600);
  // each city's instructions (renew: revoke, then approve, in the same transaction), packed greedily: up to 5 cities, within 1,232 bytes
  const packs = [];
  for (const r of build) {
    const id = BigInt(r.cityId), ixs = [];
    if (r.action !== "approve") ixs.push(await IX.revokeApproval({ programId: s.programId, admin: ctx.wallet, cityId: id, rentPayer: r.approval.rentPayer }));
    if (r.action !== "revoke") ixs.push(await IX.approveLaunch({ programId: s.programId, admin: ctx.wallet, cityId: id, founder: r.founder, name: r.name, symbol: r.symbol, expiresAt, dbcConfig: b.config }));
    const revokes = r.action === "approve" ? [] : [r.cityId];
    const cur = packs[packs.length - 1];
    if (cur && cur.rows.length < BATCH.perTx && fits(ctx.wallet, [...cur.ixs, ...ixs])) { cur.rows.push(r); cur.ixs.push(...ixs); cur.revokes.push(...revokes); continue; }
    if (!fits(ctx.wallet, ixs)) { drop(r, "Its approval alone does not fit in one Solana transaction. Tell the team."); continue; }
    packs.push({ rows: [r], ixs: [...ixs], revokes });
  }
  const transactions = [];
  for (let i = 0; i < packs.length; i++) {
    const p = packs[i];
    const labels = {}, watch = [];
    for (const r of p.rows) {
      labels[await L.approval(BigInt(r.cityId))] = `${r.cityName}'s approval (${r.action === "approve" ? "new" : r.action === "renew" ? "withdrawn and made again" : "withdrawn"})`;
      if (r.action !== "approve" && r.approval.rentPayer !== ctx.wallet) { labels[r.approval.rentPayer] = "who paid the old approval's rent (gets it back)"; watch.push(r.approval.rentPayer); }
    }
    const t = await buildTx(env, { payer: ctx.wallet, instructions: p.ixs, labels, watch }, fetchImpl, now);
    if (!t.ok) return json({ ...t, ok: false, failedAt: i, of: packs.length, cities: p.rows.map((r) => r.cityId), dropped }, t.stage === "simulation" ? 409 : t.error === "rpc_unavailable" ? 503 : 400, { "Cache-Control": "no-store" });
    // the page checks every instruction against the rows it showed: approve_launch carries its fields (src/lpkit.js), revoke_approval
    // its city here (in the order they were put in; the summary lists the instructions in the transaction's order)
    let k = 0;
    for (const e of t.summary) if (e.ix === "revoke_approval") e.fields = { cityId: p.revokes[k++] || null };
    transactions.push({ ...t, index: i, cities: p.rows.map((r) => ({ cityId: r.cityId, cityName: r.cityName, action: r.action, founder: r.founder, name: r.name, symbol: r.symbol, contentHash: r.contentHash })),
      record: { step: "batch", params: { cities: p.rows.map((r) => ({ cityId: r.cityId, action: r.action })) } } });
  }
  // built: each approved version is marked as the one its approval stands for (as approveTx does when it builds; the launch record binds it
  // only once the chain shows the approval, src/coinart-store.js bindVersion), held above already
  const marks = transactions.flatMap((t) => t.cities).filter((c) => c.action !== "revoke");
  if (marks.length) {
    await ensureReadySchema(db);
    await db.batch(marks.map((c) => markApprovedStatement(db, { cityId: c.cityId, contentHash: c.contentHash, designAt: designAt.get(c.cityId) })));
  }
  await ensureLpAdminSchema(db);
  await db.prepare("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(ctx.wallet, "lp/batch-built", "batch", `${s.cluster}: ${transactions.length} transaction(s): ${marks.length} approve/renew, ${transactions.flatMap((t) => t.cities).length - marks.length} revoke`.slice(0, 500), iso(now)).run();
  return json({ ok: true, cluster: s.cluster, chain: s.chain, transactions, dropped, expiresAt: iso(expiresAt * 1000), days: BATCH.days }, 200, { "Cache-Control": "no-store" });
}

/* ---------------------------------------------------------------- recording what landed */
/**
 * The writes for a landed batch transaction (src/lpadmin.js recordStep, step "batch"): { writes, notices } or { error }. `tx.keys`: every
 * account the confirmed transaction touched. Each city's approval address must be one of them, and the chain must show the approval
 * (approve, renew) or its absence (revoke) now. lp_approvals_log's signature is unique, so each line is "<signature>:<city>:<action>".
 */
export async function recordBatch(env, { wallet, signature, params, tx, now, fetchImpl = fetch }) {
  const s = lpSetup(env), db = env.DB;
  const list = params && Array.isArray(params.cities) ? params.cities : null;
  if (!list || !list.length || list.length > BATCH.perTx * 2) return { error: err("bad_params", "This transaction's cities are missing. Reload the page.", 400) };
  const cities = [];
  for (const x of list) {
    const id = x && cityIdOf(x.cityId);
    if (!id || !ACTIONS.includes(x.action)) return { error: err("bad_params", "A city of this transaction is not one this site makes.", 400) };
    cities.push({ id, cityId: id.toString(), action: x.action });
  }
  if (new Set(cities.map((c) => c.cityId)).size !== cities.length) return { error: err("bad_params", "A city is in this transaction twice.", 400) };
  const L = launchpadPdas(s.programId);
  const addrs = await Promise.all(cities.map((c) => L.approval(c.id)));
  if (addrs.some((a) => !tx.keys.has(a))) return { error: err("wrong_transaction", "This transaction did not touch every city's approval.") };
  const acc = await readAccounts(env, addrs, fetchImpl);
  const writes = [], notices = [];
  const line = (c, action, ap, at) => db.prepare(`INSERT OR IGNORE INTO lp_approvals_log (cluster, program_id, city_id, action, founder, name, symbol, expires_at, signature, by_wallet, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(s.cluster, s.programId, c.cityId, action, ap ? ap.founder : null, ap ? ap.name : null, ap ? ap.symbol : null,
    ap ? iso(ap.expiresAt * 1000) : null, `${signature}:${c.cityId}:${action}`, wallet, at);
  for (let i = 0; i < cities.length; i++) {
    const c = cities[i];
    const ap = decodeApproval(acc.get(addrs[i]) || null, s.programId);
    if (c.action !== "revoke" && !ap) return { error: err("not_done", "The chain does not show every approval of this transaction yet. Wait a few seconds and record it again.") };
    if (c.action === "revoke" && ap) return { error: err("not_done", "The chain still shows an approval this transaction withdraws. Wait a few seconds and record it again.") };
    if (c.action === "renew") writes.push(line(c, "revoke", null, iso(now)));
    writes.push(line(c, c.action === "revoke" ? "revoke" : "approve", c.action === "revoke" ? null : ap, iso(now)));
    if (c.action !== "revoke") notices.push({ cityId: c.cityId, founder: ap.founder, symbol: ap.symbol, renewed: c.action === "renew" });
  }
  return { writes, notices, cities };
}
/**
 * Whether a launch would go through right now, as the launch status says it (src/lplaunch.js): "open", "paused" (the owner paused
 * launches on the launchpad), "meteora" (Meteora's programs are not the tested builds, or could not be checked), or "unknown" (the
 * launchpad could not be read).
 */
async function launchesNow(env, fetchImpl, now) {
  try {
    const s = lpSetup(env);
    const r = await lpRpc(env, "getAccountInfo", [await launchpadPdas(s.programId).launchpad(), { encoding: "base64", commitment: "confirmed" }], fetchImpl);
    const lp = decodeLaunchpad(r && r.value, s.programId);
    if (!lp) return "unknown";
    if (lp.launchesPaused) return "paused";
    return programRefusal(await programHashes(env, fetchImpl, now), "Launches") ? "meteora" : "open";
  } catch { return "unknown"; }
}
/**
 * After a recorded batch: the founder of each approved city hears it (NOTIFY on; one line each). "You can launch now" only when a launch
 * would go through now: with launches paused, or Meteora's programs waiting for a check, the line says so instead of promising it.
 */
export async function tellFounders(env, notices, now, fetchImpl = fetch) {
  if (!notices.length) return;
  const open = await launchesNow(env, fetchImpl, now);
  for (const n of notices) {
    const seat = await liveSeat(env.DB, n.cityId);
    if (!seat || seat.wallet !== n.founder || !seat.uid) continue;
    const head = n.renewed ? "Your launch approval was renewed on the blockchain." : "Your launch approval is on the blockchain.";
    const tail = open === "open" ? `You can launch $${n.symbol} now.`
      : open === "paused" ? `Launches are paused for now; you can launch $${n.symbol} once they resume.`
        : open === "meteora" ? `Launches wait for a check of Meteora's programs; you can launch $${n.symbol} once it passes.`
          : `You can launch $${n.symbol} from your Founder tab.`;
    await notify(env, { to: seat.uid, kind: "founder", ref: n.cityId, href: "/dashboard#founder", now, text: `${head} ${tail}` });
  }
}
