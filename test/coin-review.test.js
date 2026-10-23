// City coins step 3 (COIN_V2_REVIEW=on with COIN_V2_READY=on, src/coinreview.js) through the real API and real SQL, with the launchpad's
// fake chain: switched off it is exactly as before (no route, key or table); a founder's draft is private and pauses nothing; a
// submitted request pauses the launch everywhere on the server (the owner's approval, the launch status and build, "Use this coin",
// other changes); an admin or the owner (never the city's own founder, never a moderator) approves exactly the version they saw, or
// asks for changes with a plain reason; Pending / Approved / Changes needed with the reason; cancel and edit; the proposed picture is
// private until approved; an approved ticker waits for the city list; the founder's own description is screened (pass used at once,
// flag pauses only when sent for review, block and error change nothing); every gate, counter and public log line.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { advance, browser, person, realClock, reprove, setHolding } from "./helpers/world.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _setArtRenderer } from "../src/coinready.js";
import { REASONS, REVIEW_LIMITS, _resetReview, _setScreener } from "../src/coinreview.js";
import { cityDescription } from "../src/coinart-store.js";
import { defaultDescription } from "../src/coindefaults.js";
import { RULES_VERSION } from "../src/screen.js";
import { sha256Hex } from "../src/coinart.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { PROGRAM, SYRACUSE, UTICA, approvalAccount, b64, fresh, launchOnChain, meta, seenOf, world } from "./helpers/readyworld.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a3f40000000049454e44ae426082", "hex");
const PNG_B64 = PNG.toString("base64");
let renders = 0;
before(async () => { const r = await nodeRenderer(); _setArtRenderer(async (svg) => { renders++; return r(svg); }); });
after(() => { _setArtRenderer(null); _setScreener(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); _resetReview(); realClock(); renders = 0; });

/** The ready-made coin world (src/test/helpers/readyworld.js) with the review switch on, a second admin and a moderator. */
async function reviewWorld({ review = "on", notify = true } = {}) {
  const w = await world();
  if (review) w.env.COIN_V2_REVIEW = review;
  if (notify) w.env.NOTIFY = "on";
  const at = new Date(Date.now()).toISOString();
  w.admin = await person(w.env);
  w.mod = await person(w.env);
  await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, 'admin', ?, ?), (?, 'moderator', ?, ?)")
    .bind(w.admin.w.address, w.owner.w.address, at, w.mod.w.address, w.owner.w.address, at).run();
  w.ready = (who = w.f) => w.get(who, `/api/coins/ready?city=${UTICA}`);
  w.rv = (path, body = {}, who = w.f) => w.post(who, `/api/coins/review/${path}`, { cityId: UTICA, ...body });
  w.queue = (who = w.admin) => w.get(who, "/api/admin/coins/reviews");
  w.decide = (body, who = w.admin) => w.post(who, "/api/admin/coins/reviews/decide", body);
  w.row = (sql, ...p) => w.env.DB.prepare(sql).bind(...p).first();
  w.all = async (sql, ...p) => (await w.env.DB.prepare(sql).bind(...p).all()).results;
  w.status = (who = w.f) => w.get(who, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
  w.notices = async () => (await w.all("SELECT text FROM notices ORDER BY id")).map((n) => n.text);
  /** a draft, then submitted: the pending request's view */
  w.request = async (draft = {}) => {
    const d = await w.rv("draft", { reason: "Locals call the town by this name for years.", ...draft });
    assert.equal(d.ok, true, JSON.stringify(d));
    const s = await w.rv("submit", { draftUpdatedAt: d.review.request.draft.updatedAt });
    assert.equal(s.ok, true, JSON.stringify(s));
    return s.review.request;
  };
  return w;
}
const tables = async (w) => (await w.env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name);

test("switch off (unset, off, anything but on, or COIN_V2_READY off): every new path is unknown, no key anywhere, no table is made", async () => {
  for (const [ready, review] of [["on", undefined], ["on", "off"], ["on", "yes"], ["on", "true"], ["off", "on"], [null, "on"]]) {
    const w = await world({ ready });
    if (review !== undefined) w.env.COIN_V2_REVIEW = review;
    for (const [path, method] of [["/api/coins/review/draft", "POST"], ["/api/coins/review/submit", "POST"], ["/api/coins/review/cancel", "POST"], ["/api/coins/review/description", "POST"],
      ["/api/coins/review/description/review", "POST"], ["/api/coins/review/description/default", "POST"], ["/api/coins/review/reset", "POST"], ["/api/coins/review/edit", "POST"],
      [`/api/coins/review/ticker-check?city=${UTICA}&t=ABC`, "GET"], ["/api/coins/review/draft", "GET"], ["/api/coins/review/nothing", "PUT"]]) {
      const r = await w.f.send(path, { method, body: method === "GET" ? undefined : { cityId: UTICA } });
      assert.equal(r.status, 404, `${ready}/${review} ${method} ${path}`);
      assert.deepEqual(await r.json(), { error: "not_found" }, "the very answer of an unknown path");
    }
    for (const [path, method] of [["/api/admin/coins/reviews", "GET"], ["/api/admin/coins/reviews/decide", "POST"], ["/api/admin/coins/reviews/art?id=1", "GET"]]) {
      const r = await w.owner.send(path, { method, body: method === "GET" ? undefined : { id: 1 } });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.deepEqual(await r.json(), { ok: false, error: "not_found" }, "the admin router's answer to an unknown path");
    }
    const me = await w.get(w.owner, "/api/admin/me");
    assert.equal("coinReviews" in me, false);
    assert.equal("pendingCoinReviews" in (await w.get(w.owner, "/api/admin/overview")), false);
    if (ready === "on") assert.equal("review" in (await w.get(w.f, `/api/coins/ready?city=${UTICA}`)), false);
    assert.equal((await tables(w)).some((t) => ["coin_requests", "coin_screenings"].includes(t)), false, `${ready}/${review}: no new table`);
  }
});

test("the founder's card: the ready-made coin, read-only, with Request changes and Write your own; staff see the switch", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const v = await w.ready();
  assert.equal(v.review.on, true);
  assert.deepEqual(v.review.defaults, { name: "Utica", symbol: "UTICA", description: "The city coin of Utica, New York, United States." });
  assert.deepEqual([v.review.request, v.review.hold, v.review.blocked], [null, null, null]);
  assert.deepEqual(v.review.can, { request: true, describe: true, reset: false, cancel: false, edit: false });
  assert.equal(v.review.selected.origin, "default");
  assert.equal(v.review.rulesVersion, RULES_VERSION);
  assert.match(v.review.nextRound, /at the owner's next approval round/);
  assert.doesNotMatch(JSON.stringify(v), /24 hours|within a day|tomorrow/i, "no time is ever promised");
  assert.equal((await w.get(w.owner, "/api/admin/me")).coinReviews, true);
  assert.equal((await w.get(w.owner, "/api/admin/overview")).pendingCoinReviews, 0);
  // the two shared sentence builders agree (src/coindefaults.js and src/coinart-store.js)
  for (const c of [{ name: "Utica", region: "New York", countryName: "United States" }, { name: "Singapore", region: "Singapore", countryName: "Singapore" }, { name: "Flying Fish Cove", region: null, countryName: "Christmas Island" }]) {
    assert.equal(cityDescription(c), defaultDescription(c));
  }
});

test("a draft is private and pauses nothing; submitting pauses the launch everywhere on the server until a reviewer decides", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const d = await w.rv("draft", { name: "Utica Falls", picture: "upload", image: PNG_B64, reason: "Locals call it the falls city since 1850." });
  assert.equal(d.ok, true, JSON.stringify(d));
  const r = d.review.request;
  assert.deepEqual([r.status, r.label, r.kind], ["draft", "Draft", "change"]);
  assert.match(r.message, /Your draft is private\. Your coin stays as it is until a reviewer approves the change\. Submitting pauses your launch until they decide\./);
  assert.match(r.draft.art, /^\/api\/media\/\d+$/, "the upload is a private media row");
  // the picture: only the founder can open it; nobody else, not even by its id, and it is nowhere public
  const mediaPath = r.draft.art;
  assert.equal((await w.f.send(mediaPath)).status, 200);
  for (const other of [browser(w.env), w.mod, w.admin]) assert.equal((await other.send(mediaPath)).status, 404, "a working upload is only its founder's");
  const sha = await sha256Hex(new Uint8Array(PNG));
  assert.equal((await meta(w.env, `/coin-meta/art/${sha}.png`)).status, 404, "never in the public store before approval");
  // a draft does not pause the launch: the owner can still approve the coin as it is
  assert.equal((await w.card()).ok, true);
  assert.equal((await w.queue()).pending, 0, "a draft is not in the queue");
  // submit: pending, the exact version, launch paused
  const s = await w.rv("submit", { draftUpdatedAt: r.draft.updatedAt });
  assert.equal(s.ok, true, JSON.stringify(s));
  const p = s.review.request;
  assert.deepEqual([p.status, p.label], ["pending", "Pending"]);
  assert.match(p.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(p.version, p.contentHash.slice(0, 8));
  assert.match(p.message, /a reviewer checks exactly this version\. Launch is paused until they decide\./);
  assert.deepEqual(p.diff.map((x) => x.field), ["picture", "name"]);
  assert.deepEqual(s.review.hold, { code: "paused_request", message: "Launch is paused while your change request is reviewed. Cancelling the request ends the pause." });
  assert.deepEqual([s.review.can.request, s.review.can.describe, s.review.can.cancel, s.review.can.edit], [false, false, true, true]);
  // the owner's list: blocked, with the reason; the approval refuses to build
  const c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /The founder's change request waits for review \(admin → Moderation → Coin reviews\)\. Nothing is approved until it is decided\./);
  const ap = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), contentHash: "a".repeat(64), expiryDays: 7 });
  assert.equal(ap.status, 409);
  // "Use this coin", a description, a new draft, a reset: all wait
  const u = await w.post(w.f, "/api/coins/ready/use", { cityId: UTICA, contentHash: (await w.ready()).coin.contentHash });
  assert.deepEqual([u.status, u.error], [409, "request_pending"]);
  assert.deepEqual([(await w.rv("description", { text: "The Handshake City on the Mohawk River." })).error, (await w.rv("draft", { name: "Other" })).error, (await w.rv("reset")).error],
    ["request_pending", "request_pending", "request_pending"]);
  // an approval already on chain (made before) cannot launch from this site while the request waits
  w.lp.S.accounts[await w.L.approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: "Utica", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
  const st = await w.status();
  assert.deepEqual([st.state, st.why], ["paused", "paused_request"], JSON.stringify(st));
  const tx = await w.post(w.f, "/api/lp/launch/tx", { cityId: UTICA, cluster: "devnet", mint: fresh() });
  assert.deepEqual([tx.status, tx.error], [409, "paused_request"]);
  assert.match(tx.message, /Launch is paused while your change request is reviewed\. .*Nothing was built\./);
  // the queue
  const q = await w.queue();
  assert.equal(q.pending, 1);
  const row = q.reviews[0];
  assert.deepEqual([row.kind, row.status, row.city.name, row.version, row.why], ["change", "pending", "Utica", p.version, "Locals call it the falls city since 1850."]);
  assert.match(row.founder.wallet, /^.{5}\*{5}.{3}$/, "masked");
  assert.equal(row.proposed.art, `/api/admin/coins/reviews/art?id=${p.id}`);
  assert.deepEqual(row.diff.map((x) => [x.field, x.to]), [["picture", row.proposed.art], ["name", "Utica Falls"]]);
  assert.ok(row.checks.every((x) => x.ok), JSON.stringify(row.checks));
  // the staff can see the proposed picture (hash-checked); nobody else
  const artRes = await w.mod.send(row.proposed.art);
  assert.equal(artRes.status, 200);
  assert.equal(await sha256Hex(new Uint8Array(await artRes.arrayBuffer())), sha);
  assert.equal((await w.f.send(row.proposed.art)).status, 403, "the founder is not staff");
  assert.equal((await browser(w.env).send(row.proposed.art)).status, 401);
  assert.equal((await w.get(w.owner, "/api/admin/overview")).pendingCoinReviews, 1);
});

test("deciding: moderators look but don't decide; never the city's own founder; the exact version only; approve makes it the coin and publishes nothing unapproved", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const p = await w.request({ name: "Utica Falls", picture: "upload", image: PNG_B64 });
  const base = { id: p.id, action: "approve", contentHash: p.contentHash };
  assert.deepEqual([(await w.decide(base, w.mod)).status, (await w.decide(base, w.mod)).error], [403, "forbidden"]);
  assert.equal((await w.decide(base, w.f)).status, 403, "the founder is no admin");
  // the founder made an admin still can't decide their own city's coin
  await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, 'admin', ?, 'now')").bind(w.f.w.address, w.owner.w.address).run();
  const own = await w.decide(base, w.f);
  assert.deepEqual([own.status, own.error], [403, "needs_second_person"]);
  await w.env.DB.prepare("DELETE FROM admin_roles WHERE wallet = ?").bind(w.f.w.address).run();
  // the exact version: another hash is refused, nothing written
  const wrong = await w.decide({ ...base, contentHash: "f".repeat(64) });
  assert.deepEqual([wrong.status, wrong.error], [409, "version_changed"]);
  // a stale proof is refused (a fresh wallet proof for every admin POST)
  advance(31 * 60_000);
  assert.deepEqual([(await w.decide(base)).status, (await w.decide(base)).error], [403, "reprove"]);
  await reprove(w.admin);
  const ok = await w.decide(base);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([ok.status, ok.registryPatch], ["approved", undefined]);
  // a second decision on the same request: not pending any more
  assert.deepEqual([(await w.decide(base)).status, (await w.decide(base)).error], [409, "not_pending"]);
  // it is the city's coin now: the design row and the choice, the picture public at last
  const sha = await sha256Hex(new Uint8Array(PNG));
  const cr = await w.row("SELECT r.content_hash, r.approved_hash, c.name, c.pitch FROM coin_ready r JOIN city_coins c ON c.city_id = r.city_id WHERE r.city_id = ?", UTICA);
  assert.deepEqual([cr.content_hash, cr.approved_hash, cr.name], [p.contentHash, null, "Utica Falls"], "chosen; the owner's on-chain approval is still to come");
  const pub = await meta(w.env, `/coin-meta/art/${sha}.png`);
  assert.equal(pub.status, 200, "approved: in the public store now");
  // the founder's card: Approved, it is their coin, the launch waits for the owner's next round (no time promised)
  const v = await w.ready();
  assert.deepEqual([v.coin.name, v.coin.ticker, v.inUse, v.coin.art], ["Utica Falls", "UTICA", true, `/coin-meta/art/${sha}.png`]);
  assert.deepEqual([v.review.request.status, v.review.request.label], ["approved", "Approved"]);
  assert.match(v.review.request.message, /^Version [0-9a-f]{8} was approved\. It is now your coin\. It launches after the owner approves it on the blockchain, at the owner's next approval round\.$/);
  assert.equal(v.review.hold, null);
  assert.deepEqual(v.review.can, { request: true, describe: true, reset: true, cancel: false, edit: false });
  // the public log: one line, no note; the founder's notice
  const log = await w.all("SELECT actor_role, action, reason, note FROM mod_actions WHERE action LIKE 'coin_change%'");
  assert.deepEqual(log.map((l) => [l.actor_role, l.action, l.reason]), [["admin", "coin_change_approved", "review"]]);
  assert.match(log[0].note, /^Utica: coin change approved, \$UTICA "Utica Falls", version [0-9a-f]{8}$/);
  assert.ok((await w.notices()).includes("Your coin change was approved. It is your coin now."));
  assert.ok(await w.row("SELECT id FROM admin_audit WHERE action = 'coins/approve' AND detail LIKE ?", `request ${p.id} version ${p.contentHash}%`));
  // the owner's list: approvable with that exact version; the approval binds it; the launch record publishes exactly it
  await reprove(w.owner); // the half hour above made the owner's proof stale too
  const c = await w.card();
  assert.equal(c.ok, true, JSON.stringify(c.reasons));
  assert.deepEqual([c.name, c.symbol, c.ready.contentHash], ["Utica Falls", "UTICA", p.contentHash]);
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.summary.find((x) => x.ix === "approve_launch").fields.name, "Utica Falls");
  advance(6 * 60_000);
  const mint = await launchOnChain(w, { name: "Utica Falls", symbol: "UTICA" });
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const j = JSON.parse((await w.row("SELECT meta_json FROM lp_coins WHERE mint = ?", mint)).meta_json);
  assert.deepEqual([j.name, j.symbol, j.image], ["Utica Falls", "UTICA", `https://vicinity.city/coin-meta/art/${sha}.png`]);
});

test("changes needed: a reason the founder reads in plain words (the note only for them), the coin unchanged; Revise opens a new draft; edit withdraws a pending version", async () => {
  const w = await reviewWorld();
  const coin = await w.useCoin();
  const p = await w.request({ name: "Utica Coin Official" });
  assert.deepEqual([(await w.decide({ id: p.id, action: "changes_needed", contentHash: p.contentHash })).error], ["reason_required"]);
  assert.equal((await w.decide({ id: p.id, action: "changes_needed", contentHash: p.contentHash, reasonCode: "name_misleading", note: "x" })).error, "bad_note");
  const d = await w.decide({ id: p.id, action: "changes_needed", contentHash: p.contentHash, reasonCode: "name_misleading", note: "Please drop the word Official." });
  assert.equal(d.ok, true, JSON.stringify(d));
  const v = await w.ready();
  assert.deepEqual([v.review.request.status, v.review.request.label, v.review.request.reason, v.review.request.note],
    ["changes_needed", "Changes needed", REASONS.name_misleading, "Please drop the word Official."]);
  assert.equal(v.review.request.message, `Changes needed: ${REASONS.name_misleading} Note from the reviewer: Please drop the word Official. Your coin stays as it was.`);
  assert.equal(v.coin.contentHash, coin.contentHash, "the coin stays as it was");
  assert.equal(v.review.hold, null, "nothing pauses the launch any more");
  assert.equal((await w.card()).ok, true);
  // the public log has the reason code and never the note
  const log = await w.row("SELECT action, reason, note FROM mod_actions WHERE action = 'coin_change_needs_changes'");
  assert.deepEqual([log.reason, /drop the word/.test(log.note)], ["name_misleading", false]);
  assert.ok((await w.notices()).includes(`Your coin change needs changes: ${REASONS.name_misleading}`));
  assert.doesNotMatch((await w.notices()).join(" "), /drop the word/, "the note is on the card, not in the notice");
  // Revise: a new draft prefilled from the rejected version; the old card is put away
  const e = await w.rv("edit", { requestId: p.id });
  assert.equal(e.ok, true, JSON.stringify(e));
  assert.deepEqual([e.review.request.status, e.review.request.draft.name], ["draft", "Utica Coin Official"]);
  // edit a pending version: it is withdrawn, the new draft needs its own review, the old hash can't be approved
  const s2 = await w.rv("submit", { draftUpdatedAt: e.review.request.draft.updatedAt });
  assert.equal(s2.ok, true, JSON.stringify(s2));
  const p2 = s2.review.request;
  assert.equal(p2.contentHash, p.contentHash, "the same content is the same version (one row per content hash)");
  const ed = await w.rv("edit", { requestId: p2.id });
  assert.equal(ed.ok, true, JSON.stringify(ed));
  assert.equal((await w.row("SELECT status FROM coin_requests WHERE id = ?", p2.id)).status, "withdrawn");
  assert.equal(ed.review.request.status, "draft");
  assert.equal(ed.review.hold, null, "a draft pauses nothing");
  const late = await w.decide({ id: p2.id, action: "approve", contentHash: p2.contentHash });
  assert.deepEqual([late.status, late.error], [409, "not_pending"], "a withdrawn version is never approved");
  // a further edit is a new version and a new review
  const d3 = await w.rv("draft", { name: "Utica Falls", draftUpdatedAt: ed.review.request.draft.updatedAt });
  assert.equal(d3.ok, true, JSON.stringify(d3));
  const s3 = await w.rv("submit", { draftUpdatedAt: d3.review.request.draft.updatedAt });
  assert.notEqual(s3.review.request.contentHash, p.contentHash);
  assert.equal((await w.queue()).pending, 1);
  // cancel: back to the approved coin, the launch free again
  const cx = await w.rv("cancel", { requestId: s3.review.request.id });
  assert.equal(cx.ok, true, JSON.stringify(cx));
  assert.deepEqual([cx.review.request, cx.review.hold], [null, null]);
  assert.equal(cx.coin.contentHash, coin.contentHash);
  assert.equal((await w.card()).ok, true);
});

/** The city list as it is now plus `map` (ticker changes a deploy brings): the next read sees it. */
function relist(w, map) {
  const tickers = { 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA", ...map };
  const assets = w.env.ASSETS;
  w.env.ASSETS = { fetch: async (r) => (new URL(r.url).pathname === "/data/tickers.json" ? new Response(JSON.stringify(tickers)) : assets.fetch(r)) };
  _resetTickers(); _resetCityCache();
}

test("a ticker change: free tickers only; approved, it waits for the city list (registryPatch), the launch with it; the job notices the deploy", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  // ticker-check: format, own, another city's, reserved, free
  const tc = async (t) => w.get(w.f, `/api/coins/review/ticker-check?city=${UTICA}&t=${encodeURIComponent(t)}`);
  assert.deepEqual([(await tc("bad!")).code, (await tc("UTICA")).code, (await tc("SYRACUSE")).code, (await tc("VICINITY")).code, (await tc("UTICANY")).available],
    ["bad_ticker", "same_ticker", "ticker_taken", "ticker_taken", true]);
  assert.equal((await w.get(w.mod, `/api/coins/review/ticker-check?city=${UTICA}&t=ABC`)).error, "not_founder");
  // another registry city's ticker is refused at submit too
  const d0 = await w.rv("draft", { symbol: "SYRACUSE", reason: "Because we like the sound of it a lot." });
  const s0 = await w.rv("submit", { draftUpdatedAt: d0.review.request.draft.updatedAt });
  assert.deepEqual([s0.status, s0.error], [409, "ticker_taken"]);
  assert.match(s0.message, /belongs to another city in the Vicinity city list/);
  await w.rv("cancel", { requestId: d0.review.request.id });
  // UTICANY: the picture is the Vicinity design drawn again with the new ticker (private until approved)
  const p = await w.request({ symbol: "uticany" });
  assert.deepEqual(p.diff.map((x) => [x.field, x.to]).slice(0, 2).map((x) => x[0]), ["picture", "ticker"]);
  assert.equal(p.proposed.symbol, "UTICANY");
  assert.match(p.proposed.art, /^\/api\/media\/\d+$/);
  // another city can't take the same ticker while it waits
  const other = await person(w.env, { holds: 2_000_000 });
  const ou = await w.row("SELECT id, wallet FROM users WHERE wallet = ?", other.w.address);
  const at = new Date(Date.now()).toISOString();
  await w.env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Syracuse', 'US', ?, ?, 3, 1000000, 'active', ?, ?)").bind(SYRACUSE, ou.id, ou.wallet, at, at).run();
  const t2 = await w.get(other, `/api/coins/review/ticker-check?city=${SYRACUSE}&t=UTICANY`);
  assert.deepEqual([t2.available, t2.code], [false, "ticker_taken"]);
  assert.match(t2.message, /requested by another city right now/);
  // approve: waits for the city list; the answer says which line to add
  const ok = await w.decide({ id: p.id, action: "approve", contentHash: p.contentHash });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.registryPatch, { [UTICA]: "UTICANY" });
  const q = await w.queue();
  assert.deepEqual(q.waitingRegistry.map((x) => [x.ticker, x.registryPatch]), [["UTICANY", { [UTICA]: "UTICANY" }]]);
  let v = await w.ready();
  assert.deepEqual([v.coin.ticker, v.review.request.registryState], ["UTICANY", "waiting"]);
  assert.match(v.review.request.message, /Your new ticker \$UTICANY goes into the Vicinity city list with the next site update; launch opens then\./);
  assert.deepEqual(v.review.hold, { code: "registry_waiting", message: "Your new ticker $UTICANY is approved. It goes into the Vicinity city list with the next site update; launch opens then." });
  assert.ok((await w.notices()).some((n) => /\$UTICANY goes into the city list with the next site update/.test(n)));
  const c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /The founder's new ticker \$UTICANY is approved\. .*ticker-overrides\.json, then a deploy/);
  // still another city's: no one else can request or be approved for UTICANY
  assert.equal((await w.get(other, `/api/coins/review/ticker-check?city=${SYRACUSE}&t=UTICANY`)).available, false);
  // the deploy: the list carries UTICANY; the job notices and says so once; the owner can approve it now
  relist(w, { 5142056: "UTICANY" });
  const { registryStep } = await import("../src/coinreview.js");
  assert.deepEqual(await registryStep(w.env), { live: 1 });
  assert.deepEqual(await registryStep(w.env), { live: 0 }, "once");
  assert.ok((await w.notices()).some((n) => /Your new ticker \$UTICANY is in the Vicinity city list now/.test(n)));
  v = await w.ready();
  assert.deepEqual([v.review.hold, v.review.request.registryState], [null, "live"]);
  const c2 = await w.card();
  assert.equal(c2.ok, true, JSON.stringify(c2.reasons));
  assert.equal(c2.symbol, "UTICANY");
});

test("the founder's own description: a pass is used at once; a flag pauses nothing until it is sent for review; a block can't be sent; an error changes nothing", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  // pass: the coin's description at once, screened, no reviewer needed
  const ok = await w.rv("description", { text: "The Handshake City on the Mohawk River, home of tomato pie." });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([ok.screening.result, ok.used, ok.coin.description], ["pass", true, "The Handshake City on the Mohawk River, home of tomato pie."]);
  assert.equal(ok.review.selected.origin, "description");
  assert.equal(ok.review.description.source, "founder");
  assert.equal((await w.card()).ok, true, "a passing description is launchable");
  assert.equal((await w.card()).pitch, "The Handshake City on the Mohawk River, home of tomato pie.");
  const sc = await w.row("SELECT result, rules_version, text_sha256 FROM coin_screenings ORDER BY id DESC LIMIT 1");
  assert.deepEqual([sc.result, sc.rules_version], ["pass", RULES_VERSION]);
  // flag: nothing changes, the issues are explained, the card offers revise / review / keep the default
  const fl = await w.rv("description", { text: "Utica coin: guaranteed profit, 100x to the moon soon." });
  assert.equal(fl.ok, true);
  assert.equal(fl.screening.result, "flag");
  assert.ok(fl.screening.issues.every((x) => x.message && x.code === "financial"), JSON.stringify(fl.screening.issues));
  assert.equal(fl.coin.description, "The Handshake City on the Mohawk River, home of tomato pie.", "a flag changes nothing");
  assert.equal(fl.review.hold, null, "a flag alone pauses nothing");
  assert.equal(fl.review.description.screening.result, "flag");
  // block: can't be sent for review
  const bl = await w.rv("description", { text: "Visit utica.io for the best coin around here." });
  assert.equal(bl.screening.result, "block");
  const cant = await w.rv("description/review", { screeningId: (await w.row("SELECT id FROM coin_screenings WHERE result = 'block'")).id });
  assert.deepEqual([cant.status, cant.error], [409, "cannot_review"]);
  // an error (the screener could not run): nothing changes, never a pass, can't be sent for review
  _setScreener(() => ({ result: "error", issues: [], rulesVersion: RULES_VERSION, text: null }));
  const er = await w.rv("description", { text: "Utica is a lovely old city on the Erie Canal." });
  assert.deepEqual([er.status, er.error], [503, "screening_error"]);
  assert.match(er.message, /Nothing changed: your coin keeps its current description/);
  _setScreener(null);
  assert.equal((await w.ready()).coin.description, "The Handshake City on the Mohawk River, home of tomato pie.");
  // send the flagged one for review: a description request, the launch paused, the queue shows the flagged spans
  const flagged = await w.row("SELECT id FROM coin_screenings WHERE result = 'flag' ORDER BY id DESC LIMIT 1");
  const sent = await w.rv("description/review", { screeningId: flagged.id });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual([sent.review.request.kind, sent.review.request.status], ["description", "pending"]);
  assert.equal(sent.review.hold.code, "paused_description");
  assert.equal(sent.review.hold.message, "Launch is paused while your description is reviewed. Going back to the default description ends the pause.");
  assert.equal((await w.card()).ok, false);
  const row = (await w.queue()).reviews[0];
  assert.equal(row.kind, "description");
  assert.ok(row.checks.some((x) => x.check === "description_screening" && x.issues.length), JSON.stringify(row.checks));
  // "Use the default" cancels it and launches with Vicinity's sentence
  const def = await w.rv("description/default");
  assert.equal(def.ok, true, JSON.stringify(def));
  assert.deepEqual([def.coin.description, def.review.hold, def.review.request], ["The city coin of Utica, New York, United States.", null, null]);
  assert.equal(def.review.selected.origin, "default", "back to Vicinity's own version");
  // send it again and approve it: exactly that text becomes the coin's
  const again = await w.rv("description/review", { screeningId: flagged.id });
  assert.equal(again.ok, true, JSON.stringify(again));
  const r = again.review.request;
  const ap = await w.decide({ id: r.id, action: "approve", contentHash: r.contentHash });
  assert.equal(ap.ok, true, JSON.stringify(ap));
  const v = await w.ready();
  assert.equal(v.coin.description, "Utica coin: guaranteed profit, 100x to the moon soon.");
  assert.ok((await w.notices()).includes("Your description was approved."));
  assert.equal((await w.card()).ok, true, "a reviewer's approval of exactly that text is launchable, though the screener flags it");
  // an old flag (more than a day) or one of other rules can't be sent
  advance(25 * 3600_000);
  await reprove(w.f);
  assert.equal((await w.rv("description/review", { screeningId: flagged.id })).error, "cannot_review");
});

test("launch re-check: a passing description that no longer passes under new rules blocks the launch (status and build), and the owner's list says so", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  await w.rv("description", { text: "The Handshake City on the Mohawk River." });
  const c = await w.card();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  advance(6 * 60_000);
  w.lp.S.accounts[await w.L.approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: "Utica", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 });
  let st = await w.status();
  assert.equal(st.state, "ready", JSON.stringify(st));
  // the rules change: the same words are flagged now
  _setScreener((text) => ({ result: "flag", issues: [{ code: "abuse", severity: "flag", start: 0, end: 3 }], rulesVersion: "s1-newer", text }));
  st = await w.status();
  assert.deepEqual([st.state, st.why], ["paused", "description_recheck"]);
  assert.equal(st.message, "Your description no longer passes the checks. Use the default description, or write a new one.");
  const tx = await w.post(w.f, "/api/lp/launch/tx", { cityId: UTICA, cluster: "devnet", mint: fresh() });
  assert.deepEqual([tx.status, tx.error], [409, "description_recheck"]);
  // an error in the re-check blocks too (never counted as a pass)
  _setScreener(() => ({ result: "error", issues: [], rulesVersion: RULES_VERSION, text: null }));
  assert.equal((await w.status()).why, "description_unchecked");
  _setScreener(null);
  assert.equal((await w.status()).state, "ready");
});

test("never publish unapproved content: a coin launched outside the site while a request waits gets the approved version; tampered art is refused", async () => {
  const w = await reviewWorld();
  const coin = await w.useCoin();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  advance(6 * 60_000);
  w.lp.S.accounts[await w.L.approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: "Utica", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 });
  // approved on chain: the coin is fixed; no request, no description, no reset
  for (const [path, body] of [["draft", { name: "Other Name", reason: "A reason that is long enough." }], ["description", { text: "The Handshake City on the Mohawk." }], ["reset", {}]]) {
    const r = await w.rv(path, body);
    assert.deepEqual([r.status, r.error], [409, "approved_on_chain"], path);
  }
  // a request smuggled in (straight into the table, as if the page had sent it before the approval): never published
  await w.env.DB.prepare(`INSERT INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
    VALUES (?, 'change', '{}', ?, 'Smuggled', 'UTICA', 'x', 'y', 'upload', 1, 'now')`).bind(UTICA, "e".repeat(64)).run();
  await w.env.DB.prepare(`INSERT INTO coin_requests (city_id, kind, status, seat_id, user_id, version_id, content_hash, submitted_at, created_at, updated_at)
    SELECT ?, 'change', 'pending', id, user_id, (SELECT id FROM coin_versions WHERE content_hash = ?), ?, 'now', 'now', 'now' FROM seats WHERE city_id = ?`).bind(UTICA, "e".repeat(64), "e".repeat(64), UTICA).run();
  assert.equal((await w.status()).why, "paused_request", "the site does not launch it");
  // ... but the program checks only the approval: the founder launches with another tool. The record publishes the approved version only
  const mint = await launchOnChain(w, { name: "Utica", symbol: "UTICA" });
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const j = JSON.parse((await w.row("SELECT meta_json FROM lp_coins WHERE mint = ?", mint)).meta_json);
  assert.deepEqual([j.name, j.image], ["Utica", `https://vicinity.city${coin.art}`]);
  assert.doesNotMatch(JSON.stringify(j), /Smuggled/);
});

test("the gates, on every founder route: not the founder, a stale proof, another site, wallet mismatch, grace, bans, a launched city, a waiting contract", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const routes = [["draft", { reason: "A reason that is long enough." }], ["submit", { draftUpdatedAt: "x" }], ["cancel", { requestId: 1 }], ["edit", { requestId: 1 }],
    ["reset", {}], ["description", { text: "The Handshake City on the Mohawk." }], ["description/review", { screeningId: 1 }], ["description/default", {}]];
  const each = async (who, want, opts = {}) => {
    for (const [path, body] of routes) {
      const r = await (opts.origin !== undefined ? who.send(`/api/coins/review/${path}`, { method: "POST", body: { cityId: UTICA, ...body }, origin: opts.origin }).then(async (x) => ({ status: x.status, ...(await x.json()) })) : w.rv(path, body, who));
      assert.equal(r.error, want, `${path}: ${JSON.stringify(r)}`);
    }
  };
  await each(w.mod, "not_founder");
  await each(browser(w.env), "sign_in");
  await each(w.f, "wrong_origin", { origin: "https://evil.example" });
  await each(w.f, "wrong_origin", { origin: null });
  advance(31 * 60_000);
  await each(w.f, "reprove");
  await reprove(w.f);
  // a ban: home country, the seat's country, everywhere
  for (const country of ["US", "*"]) {
    await w.env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at) VALUES (?, ?, 0, 'test', 'now')").bind((await w.row("SELECT id FROM users WHERE wallet = ?", w.f.w.address)).id, country).run();
    await each(w.f, "banned");
    await w.env.DB.prepare("DELETE FROM bans").run();
  }
  // the account's wallet is not the seat's
  await w.env.DB.prepare("UPDATE seats SET wallet = 'Other111111111111111111111111111111111111111' WHERE city_id = ?").bind(UTICA).run();
  await each(w.f, "wallet_mismatch");
  await w.env.DB.prepare("UPDATE seats SET wallet = ? WHERE city_id = ?").bind(w.f.w.address, UTICA).run();
  // below the bar: the founder action starts the grace period, as every other one does
  setHolding(w.f.w.address, 10);
  await each(w.f, "in_grace");
  setHolding(w.f.w.address, 2_000_000);
  await w.env.DB.prepare("UPDATE seats SET status = 'active', grace_until = NULL WHERE city_id = ?").bind(UTICA).run();
  // a waiting LaunchLab contract, a launched coin
  await w.env.DB.prepare("UPDATE city_coins SET pending_mint = ? WHERE city_id = ?").bind(fresh(), UTICA).run();
  await each(w.f, "legacy_contract");
  await w.env.DB.prepare("UPDATE city_coins SET pending_mint = NULL, mint = ? WHERE city_id = ?").bind(fresh(), UTICA).run();
  await each(w.f, "launched");
});

test("one open request per city, counted before the work; a former founder's request holds nothing for the next founder", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  // two drafts at once: one wins, the other is told
  const both = await Promise.all([w.rv("draft", { name: "Utica One", reason: "A reason that is long enough." }), w.rv("draft", { name: "Utica Two", reason: "A reason that is long enough." })]);
  assert.equal(both.filter((r) => r.ok).length, 1, JSON.stringify(both.map((r) => r.error)));
  assert.ok(both.some((r) => ["request_open", "draft_changed"].includes(r.error)));
  assert.equal((await w.row("SELECT COUNT(*) AS n FROM coin_requests WHERE status IN ('draft', 'pending')")).n, 1);
  // the counters: 5 submits a day
  const open = (await w.ready()).review.request;
  let last;
  for (let i = 0; i < REVIEW_LIMITS.submit.max + 1; i++) last = await w.rv("submit", { draftUpdatedAt: "stale" });
  assert.deepEqual([last.status, last.error], [429, "slow_down"]);
  assert.equal((await w.row("SELECT status FROM coin_requests WHERE id = ?", open.id)).status, "draft", "nothing was submitted");
  // the seat changes hands while a request waits: the next founder's first action withdraws it; a reviewer has nothing to decide
  await w.env.DB.prepare("UPDATE coin_requests SET status = 'pending', content_hash = ?, submitted_at = 'now' WHERE id = ?").bind("a".repeat(64), open.id).run();
  await w.env.DB.prepare("UPDATE seats SET status = 'released' WHERE city_id = ?").bind(UTICA).run();
  const nb = await person(w.env, { holds: 2_000_000 });
  const nu = await w.row("SELECT id, wallet FROM users WHERE wallet = ?", nb.w.address);
  const at = new Date(Date.now()).toISOString();
  await w.env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)").bind(UTICA, nu.id, nu.wallet, at, at).run();
  assert.equal((await w.card()).reasons.some((x) => /waits for review/.test(x)), false, "a former founder's request pauses nothing");
  const dec = await w.decide({ id: open.id, action: "approve", contentHash: "a".repeat(64) });
  assert.equal(dec.status, 409);
  const d = await w.rv("draft", { name: "New Utica", reason: "A reason that is long enough." }, nb);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal((await w.row("SELECT status FROM coin_requests WHERE id = ?", open.id)).status, "withdrawn");
});
