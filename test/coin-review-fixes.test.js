// City coins step 3 (COIN_V2_REVIEW), the fixes of the security, rollback and founder-words review, through the real API and real SQL with
// the launchpad's fake chain: the screener's evasions never reach a coin (and never its public preview); a change request never vouches
// for a description it did not change; an approval on chain built from the founder's own coin does not stop requests or descriptions
// (the launch pauses and the owner's round renews it); a proposed name is screened with the coin's own reviewed words and a proposed
// ticker like a word; an approved upload is cached briefly and can be taken down until a launched coin carries it; an upload is a whole
// square PNG; another city's request is never named; the launch status says the review pause, not "after the next round"; the reason
// fits the request; "Keep the default" puts the flagged card away; the request cards follow the coin; turning the switch off after use
// keeps every review-made version checked.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { advance, browser, person, realClock, reprove } from "./helpers/world.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _setArtRenderer } from "../src/coinready.js";
import { REASONS, _resetReview, _setScreener } from "../src/coinreview.js";
import { RULES_VERSION } from "../src/screen.js";
import { sha256Hex } from "../src/coinart.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { SYRACUSE, UTICA, approvalAccount, b64, fresh, meta, pngOf, seenOf, world } from "./helpers/readyworld.js";

before(async () => { const r = await nodeRenderer(); _setArtRenderer(r); });
after(() => { _setArtRenderer(null); _setScreener(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); _resetReview(); _setScreener(null); realClock(); });

async function reviewWorld({ review = "on" } = {}) {
  const w = await world();
  if (review) w.env.COIN_V2_REVIEW = review;
  w.env.NOTIFY = "on";
  const at = new Date(Date.now()).toISOString();
  w.admin = await person(w.env);
  await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, 'admin', ?, ?)").bind(w.admin.w.address, w.owner.w.address, at).run();
  w.ready = (who = w.f) => w.get(who, `/api/coins/ready?city=${UTICA}`);
  w.rv = (path, body = {}, who = w.f) => w.post(who, `/api/coins/review/${path}`, { cityId: UTICA, ...body });
  w.queue = (who = w.admin) => w.get(who, "/api/admin/coins/reviews");
  w.decide = (body, who = w.admin) => w.post(who, "/api/admin/coins/reviews/decide", body);
  w.row = (sql, ...p) => w.env.DB.prepare(sql).bind(...p).first();
  w.all = async (sql, ...p) => (await w.env.DB.prepare(sql).bind(...p).all()).results;
  w.status = (who = w.f) => w.get(who, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
  w.notices = async () => (await w.all("SELECT text FROM notices ORDER BY id")).map((n) => n.text);
  w.request = async (draft = {}) => {
    const d = await w.rv("draft", { reason: "Locals call the town by this name for years.", ...draft });
    assert.equal(d.ok, true, JSON.stringify(d));
    const s = await w.rv("submit", { draftUpdatedAt: d.review.request.draft.updatedAt });
    assert.equal(s.ok, true, JSON.stringify(s));
    return s.review.request;
  };
  /** The owner's card builds the approval from the founder's chosen coin (approved_hash), and it lands on the fake chain. */
  w.approveOnChain = async () => {
    const c = await w.card();
    assert.equal(c.ok, true, JSON.stringify(c.reasons));
    const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 });
    assert.equal(b.ok, true, JSON.stringify(b));
    advance(6 * 60_000);
    await reprove(w.f);
    w.lp.S.accounts[await w.L.approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: c.name, symbol: c.symbol, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 });
  };
  return w;
}
const chunk = (type, data) => {
  const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

test("SEC-1: a description written in small capitals (or split, or stemmed) is never used, and never reaches the public preview", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  for (const text of ["Utica welcomes everyone except ɴɪɢɢᴇʀꜱ and ꜰᴀɢɢᴏᴛꜱ.", "Utica is for nig-ger people only", "Utica is for niggerz only, ok"]) {
    const r = await w.rv("description", { text });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.screening.result, "block", text);
    assert.notEqual(r.used, true);
  }
  const ni = await w.rv("description", { text: "Utica is for ni gger people only" });
  assert.equal(ni.screening.result, "flag", "split by a space: a person looks, it is never used by itself");
  const pv = await w.get(browser(w.env), `/api/coins/ready?city=${UTICA}`);
  assert.equal(pv.preview.description, "The city coin of Utica, New York, United States.");
  assert.doesNotMatch(JSON.stringify(pv), /ɴɪɢɢ|nig-ger|niggerz|ni gger/);
  assert.equal((await w.card()).pitch, "The city coin of Utica, New York, United States.");
});

test("SEC-3: an approved CHANGE request never vouches for the description it carried; a DESCRIPTION approval does, for exactly that text", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const ok = await w.rv("description", { text: "The Handshake City on the Mohawk River, home of tomato pie." });
  assert.equal(ok.used, true, JSON.stringify(ok));
  // everyone else's preview carries a founder's own description only once a person stood behind it (here: nobody yet)
  assert.equal((await w.get(browser(w.env), `/api/coins/ready?city=${UTICA}`)).preview.description, null);
  assert.equal((await w.ready()).preview.description, "The Handshake City on the Mohawk River, home of tomato pie.", "the founder sees their own");
  // a picture-only change on top: the reviewer approves the picture (the queue shows the whole version, the description included)
  const p = await w.request({ picture: "upload", image: b64(pngOf(64)) });
  const row = (await w.queue()).reviews.find((x) => x.id === p.id);
  assert.deepEqual(row.diff.map((x) => x.field), ["picture"]);
  assert.deepEqual([row.current.description, row.proposed.description], ["The Handshake City on the Mohawk River, home of tomato pie.", "The Handshake City on the Mohawk River, home of tomato pie."]);
  assert.equal((await w.decide({ id: p.id, action: "approve", contentHash: p.contentHash })).ok, true);
  assert.equal((await w.card()).ok, true);
  // the rules change and the description is caught now: the change's approval does not exempt it
  _setScreener((text) => ({ result: "block", issues: [{ code: "slur", severity: "block", start: 0, end: 3 }], rulesVersion: "s1-newer", text }));
  const c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /Your description no longer passes the checks/);
  assert.equal((await w.ready()).review.hold.code, "description_recheck");
  _setScreener(null);
  // a description a person approved (a description request) stays approved under any rules, also under a later picture change
  const fl = await w.rv("description", { text: "Utica coin: guaranteed profit, 100x to the moon soon." });
  assert.equal(fl.screening.result, "flag");
  const sent = await w.rv("description/review", { screeningId: fl.screening.id });
  assert.equal((await w.decide({ id: sent.review.request.id, action: "approve", contentHash: sent.review.request.contentHash })).ok, true);
  const p2 = await w.request({ picture: "upload", image: b64(pngOf(64, 64, [10, 120, 200])) });
  assert.equal((await w.decide({ id: p2.id, action: "approve", contentHash: p2.contentHash })).ok, true);
  _setScreener((text) => ({ result: "flag", issues: [{ code: "abuse", severity: "flag", start: 0, end: 3 }], rulesVersion: "s1-newer", text }));
  assert.equal((await w.card()).ok, true, "the reviewer read exactly that text");
});

test("SEC-4: an approval built from the founder's coin does not stop a request or a description: the launch pauses, and changing back undoes it", async () => {
  const w = await reviewWorld();
  const coin = await w.useCoin();
  await w.approveOnChain();
  assert.equal((await w.status()).state, "ready");
  let v = await w.ready();
  assert.deepEqual([v.review.can.request, v.review.can.describe, v.review.blocked], [true, true, null], "approved on chain: the buttons stay");
  // a request: accepted; the launch pauses while it waits (the owner's next round withdraws the approval: test/lp-batch.test.js)
  const p = await w.request({ name: "Utica Falls" });
  let st = await w.status();
  assert.deepEqual([st.state, st.why], ["paused", "paused_request"]);
  const cx = await w.rv("cancel", { requestId: p.id });
  assert.equal(cx.ok, true, JSON.stringify(cx));
  assert.equal((await w.status()).state, "ready", "cancelled: the approved coin launches");
  // a description that passes: used at once; the approval stands for the coin as it was, so the launch waits for the next round
  const d = await w.rv("description", { text: "The Handshake City on the Mohawk River, home of tomato pie." });
  assert.equal(d.used, true, JSON.stringify(d));
  st = await w.status();
  assert.deepEqual([st.state, st.why], ["paused", "approval_changed"]);
  assert.match(st.message, /changed after the owner approved it on the blockchain.*at the owner's next approval round/);
  assert.doesNotMatch(st.message, /24 hours|tomorrow|within/);
  v = await w.ready();
  assert.equal(v.gate.code, "approved_changed");
  const tx = await w.post(w.f, "/api/lp/launch/tx", { cityId: UTICA, cluster: "devnet", mint: fresh() });
  assert.deepEqual([tx.status, tx.error], [409, "approval_changed"]);
  // back to the default description: exactly the approved version again, so it launches as approved
  const back = await w.rv("description/default");
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.coin.contentHash, coin.contentHash);
  assert.equal((await w.status()).state, "ready");
  // an approval given by hand (not built from the chosen coin) still fixes the coin as approved
  await w.env.DB.prepare("UPDATE coin_ready SET approved_hash = NULL WHERE city_id = ?").bind(UTICA).run();
  assert.equal((await w.rv("description", { text: "The Handshake City on the Mohawk River, home of tomato pie." })).error, "approved_on_chain");
});

test("SEC-5: a proposed name is screened with the coin's reviewed words, never the proposed ticker; a proposed ticker is screened like a word", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const submit = async (draft) => {
    const d = await w.rv("draft", { reason: "Locals call the town by this name for years.", ...draft });
    assert.equal(d.ok, true, JSON.stringify(d));
    const s = await w.rv("submit", { draftUpdatedAt: d.review.request.draft.updatedAt });
    await w.rv("cancel", { requestId: d.review.request.id });
    return s;
  };
  for (const [name, symbol] of [["Spic Town", "SPIC"], ["Utica Spics", "SPICS"]]) {
    const s = await submit({ name, symbol });
    assert.deepEqual([s.status, s.error], [409, "name_refused"], `${name} / ${symbol}: ${JSON.stringify(s)}`);
  }
  const t = await submit({ symbol: "SPICS" });
  assert.deepEqual([t.status, t.error], [409, "ticker_refused"]);
  assert.equal(t.message, "That ticker can't be used. Pick another one.");
  // a flagged ticker reaches the reviewer flagged
  const p = await w.request({ symbol: "PROFIT" });
  const row = (await w.queue()).reviews.find((x) => x.id === p.id);
  const ns = row.checks.find((x) => x.check === "name_screening");
  assert.equal(ns.text, "The checks flagged the name or the ticker.");
  assert.ok(ns.issues.some((x) => x.field === "ticker" && x.code === "financial"), JSON.stringify(ns));
});

test("SEC-6: an approved upload is cached briefly (not a year) until a launched coin carries it, and an admin can take it down", async () => {
  const w = await reviewWorld();
  const coin = await w.useCoin();
  const png = pngOf(64, 64, [1, 2, 3]);
  const p = await w.request({ picture: "upload", image: b64(png) });
  assert.equal((await w.decide({ id: p.id, action: "approve", contentHash: p.contentHash })).ok, true);
  const sha = await sha256Hex(new Uint8Array(png));
  const art = await meta(w.env, `/coin-meta/art/${sha}.png`);
  assert.equal(art.status, 200);
  assert.equal(art.headers.get("Cache-Control"), "public, max-age=300");
  // Vicinity's own picture is the coin's for ever, as before
  assert.equal((await meta(w.env, coin.art)).headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  // the takedown (src/cointakedown.js): the address answers 404, the coin that used it is Vicinity's coin again (never a broken picture,
  // nothing to reset), the founder is told; the log has it
  const td = await w.post(w.owner, "/api/coins/takedown", { city: UTICA, what: "art", sha, reason: "illegal", note: "A logo they don't own." });
  assert.equal(td.ok, true, JSON.stringify(td));
  assert.equal((await meta(w.env, `/coin-meta/art/${sha}.png`)).status, 404);
  const r = await w.ready();
  assert.deepEqual([r.review.hold, r.coin.art], [null, coin.art]);
  assert.ok((await w.notices()).some((n) => /Your coin picture was taken down/.test(n)));
  assert.ok(await w.row("SELECT 1 FROM mod_actions WHERE action = 'coin_art_removed'"));
  // nothing (more) to take down: said so, nothing changes
  const again = await w.post(w.owner, "/api/coins/takedown", { city: UTICA, what: "art", sha, reason: "illegal", note: "Again." });
  assert.deepEqual([again.status, again.error], [404, "not_found"]);
});

test("SEC-7: an upload must be a whole, square PNG of 64 to 1024 px (never a JPEG or WebP under .png, a flood, a fragment or a rectangle)", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const good = pngOf(64);
  const ihdr = (wd, ht) => { const h = Buffer.alloc(13); h.writeUInt32BE(wd, 0); h.writeUInt32BE(ht, 4); h[8] = 8; h[9] = 2; return chunk("IHDR", h); };
  const flood = Buffer.concat([good.subarray(0, 8), ihdr(30_000, 30_000), good.subarray(8 + 25)]);
  const bad = {
    rectangle: pngOf(64, 80), tiny: pngOf(16), flood, truncated: good.subarray(0, good.length - 6), patched: Buffer.concat([good.subarray(0, 40), Buffer.from([0xff]), good.subarray(41)]),
    trailing: Buffer.concat([good, Buffer.from("junk")]), jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]),
    webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(200, 3)]),
  };
  for (const [what, bytes] of Object.entries(bad)) {
    const r = await w.rv("draft", { picture: "upload", image: b64(bytes), reason: "Locals love this picture of the falls." });
    assert.deepEqual([r.status, r.error], [400, "bad_image"], what);
  }
  const ok = await w.rv("draft", { picture: "upload", image: b64(good), reason: "Locals love this picture of the falls." });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("SEC-9: a ticker another city requested is only 'not available' (never 'requested' or 'approved for another city')", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  await w.request({ symbol: "UTICANY" });
  const other = await person(w.env, { holds: 2_000_000 });
  const ou = await w.row("SELECT id, wallet FROM users WHERE wallet = ?", other.w.address);
  const at = new Date(Date.now()).toISOString();
  await w.env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Syracuse', 'US', ?, ?, 3, 1000000, 'active', ?, ?)").bind(SYRACUSE, ou.id, ou.wallet, at, at).run();
  const t = await w.get(other, `/api/coins/review/ticker-check?city=${SYRACUSE}&t=UTICANY`);
  assert.deepEqual([t.available, t.code, t.message], [false, "ticker_taken", "$UTICANY is not available. Pick another ticker."]);
});

test("UX-1: not approved yet with a request waiting (or a ticker waiting for the list): the launch says the pause, never 'after the next round'", async () => {
  const w = await reviewWorld();
  w.env.COIN_V2_BATCH = "on";
  await w.useCoin();
  let st = await w.status();
  assert.deepEqual([st.state, st.why], ["not_approved", "not_approved"]);
  assert.match(st.message, /next approval round/);
  const p = await w.request({ name: "Utica Falls" });
  st = await w.status();
  assert.deepEqual([st.state, st.why], ["paused", "paused_request"], JSON.stringify(st));
  assert.doesNotMatch(st.message, /opens after the owner's next approval round/);
  const tx = await w.post(w.f, "/api/lp/launch/tx", { cityId: UTICA, cluster: "devnet", mint: fresh() });
  assert.deepEqual([tx.status, tx.error], [409, "paused_request"]);
  // an approved ticker the city list does not carry yet: the same
  await w.rv("cancel", { requestId: p.id });
  const q = await w.request({ symbol: "UTICANY" });
  assert.equal((await w.decide({ id: q.id, action: "approve", contentHash: q.contentHash })).ok, true);
  st = await w.status();
  assert.deepEqual([st.state, st.why], ["paused", "registry_waiting"]);
});

test("UX-2: a reason must fit the request: a description review is never refused for a ticker or a picture", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const fl = await w.rv("description", { text: "Utica coin: guaranteed profit, 100x to the moon soon." });
  const sent = await w.rv("description/review", { screeningId: fl.screening.id });
  const r = sent.review.request;
  for (const code of ["ticker_taken", "image_rights", undefined]) {
    const d = await w.decide({ id: r.id, action: "changes_needed", contentHash: r.contentHash, reasonCode: code });
    assert.deepEqual([d.status, d.error], [400, "reason_required"], String(code));
  }
  const q = await w.queue();
  assert.deepEqual(q.reasons.find((x) => x.code === "financial_claim").kinds, ["description"]);
  assert.deepEqual(q.reasons.find((x) => x.code === "ticker_taken").kinds, ["change"]);
  const ok = await w.decide({ id: r.id, action: "changes_needed", contentHash: r.contentHash, reasonCode: "financial_claim" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await w.ready()).review.request.reason, REASONS.financial_claim);
});

test("UX-5 and UX-6: 'Keep the default' puts the flagged card away; a 'changes needed' description card goes once a newer description is chosen", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const fl = await w.rv("description", { text: "Utica coin: guaranteed profit, 100x to the moon soon." });
  assert.equal(fl.review.description.screening.result, "flag");
  const keep = await w.rv("description/default");
  assert.equal(keep.ok, true, JSON.stringify(keep));
  assert.equal(keep.review.description.screening, null, "kept: the flagged check is not shown again");
  assert.equal((await w.ready()).review.description.screening, null, "nor after a reload");
  // a description that needed changes: a new one that passes replaces the card
  const fl2 = await w.rv("description", { text: "Utica coin: guaranteed profit, 100x to the moon soon." });
  const sent = await w.rv("description/review", { screeningId: fl2.screening.id });
  await w.decide({ id: sent.review.request.id, action: "changes_needed", contentHash: sent.review.request.contentHash, reasonCode: "financial_claim" });
  assert.equal((await w.ready()).review.request.status, "changes_needed");
  const ok = await w.rv("description", { text: "The Handshake City on the Mohawk River, home of tomato pie." });
  assert.equal(ok.used, true);
  assert.equal(ok.review.request, null, "the old card is history");
  // ...and so does going back to the default when the coin already had it
  const fl3 = await w.rv("description", { text: "Utica coin: guaranteed profit, 100x to the moon soon." });
  const s3 = await w.rv("description/review", { screeningId: fl3.screening.id });
  await w.decide({ id: s3.review.request.id, action: "changes_needed", contentHash: s3.review.request.contentHash, reasonCode: "financial_claim" });
  await w.rv("description/default");
  assert.equal((await w.ready()).review.request, null);
});

test("UX-6 and UX-7: the approved card follows the chain; a waiting description is named as one", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const p = await w.request({ name: "Utica Falls" });
  assert.equal((await w.decide({ id: p.id, action: "approve", contentHash: p.contentHash })).ok, true);
  let v = await w.ready();
  assert.match(v.review.request.message, /It launches after the owner approves it on the blockchain, at the owner's next approval round\./);
  // NIT-1: while the owner builds the approval (the five-minute hold) the card says it is happening right now, as the coin card does
  // (GATES.held), never "at the owner's next approval round"
  const c = await w.card();
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 })).ok, true);
  v = await w.ready();
  assert.equal(v.gate.code, "held");
  assert.match(v.gate.message, /^The owner is approving your coin right now/);
  assert.equal(v.review.request.message, `Version ${p.version} was approved. It is now your coin. The owner is approving it on the blockchain right now.`);
  assert.doesNotMatch(JSON.stringify([v.review.request, v.review.hold, v.review.blocked, v.gate]), /next approval round/);
  advance(6 * 60_000);
  await reprove(w.f);
  w.lp.S.accounts[await w.L.approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: c.name, symbol: c.symbol, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 });
  v = await w.ready();
  assert.equal(v.gate.code, "approved");
  assert.equal(v.review.request.message, `Version ${p.version} was approved. It is now your coin. It is approved on the blockchain too.`);
  // a description sent for review: the card's gate says a description waits (not "a change request")
  const w2 = await reviewWorld();
  await w2.useCoin();
  const fl = await w2.rv("description", { text: "Utica coin: guaranteed profit, 100x to the moon soon." });
  const sent = await w2.rv("description/review", { screeningId: fl.screening.id });
  assert.equal(sent.gate.code, "request_pending");
  assert.match(sent.gate.message, /^Your description is waiting for review\./);
});

test("DARK-1: switched off after use, a founder's description stays their coin and is still checked (on the owner's list and the launch path)", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const d = await w.rv("description", { text: "The Handshake City on the Mohawk River, home of tomato pie." });
  assert.equal(d.used, true);
  w.env.COIN_V2_REVIEW = "off";
  let v = await w.ready();
  assert.equal("review" in v, false, "the switch is off: no review step");
  assert.deepEqual([v.coin.description, v.inUse], ["The Handshake City on the Mohawk River, home of tomato pie.", true], "the card shows the coin that launches");
  assert.equal((await w.card()).ok, true);
  // the rules change: still caught with the switch off (never launchable unchecked)
  _setScreener((text) => ({ result: "block", issues: [{ code: "slur", severity: "block", start: 0, end: 3 }], rulesVersion: "s1-newer", text }));
  const c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /no longer passes the checks/);
  _setScreener(null);
  // a request left pending when the switch went off pauses nothing any more (docs/DEPLOY.md says to cancel or decide them first)
  w.env.COIN_V2_REVIEW = "on";
  await w.request({ name: "Utica Falls" });
  assert.equal((await w.card()).ok, false);
  w.env.COIN_V2_REVIEW = "off";
  assert.equal((await w.card()).ok, true);
});
