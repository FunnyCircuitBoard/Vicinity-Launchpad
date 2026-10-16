// City coin pictures are checked by a person before anyone sees them (src/logos.js; city identity protections, step 2):
//   - the lazy schema (src/store.js ensureLogoSchema) adds its columns once, is safe to repeat, drops nothing, and a picture uploaded
//     before this change waits for a check like a new one
//   - a new picture waits: the founder and the staff see the working picture, every public surface shows nothing (the badge),
//     strangers get "not found" on its /api/media URL
//   - approve: the picture becomes public with the sha256 of its bytes; the served bytes are checked against it (tampered → 404);
//     an hour in caches, not a year; a replaced picture waits again while the approved one keeps showing
//   - reject: reason and note reach the founder alone; nothing public; replacing it waits again
//   - takedown: an approved picture is rejected and hidden at once; a newer picture that waits for its check keeps waiting; a coin
//     without a picture has nothing to take down (404)
//   - approve looks at the media row's type too: a row that is not a picture is never approved
//   - roles: a moderator looks but cannot decide, an admin can, the owner can, a stale wallet proof is refused
//   - every decision is one public mod-log line (city, action, reason: never the note); the admin Overview counts what waits
//   - /coin-meta/<mint>.png serves the approved picture (hash-checked) once the launch is recorded, else the badge
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_NYC, IN_UTICA, MINT, advance, browser, newWorld, person, realClock, reprove, useClock } from "./helpers/world.js";
import { LP, dexMock, seedCoin } from "./helpers/launchpad.js";
import { DEMOV, DEMOV_CITY, LP_ON, METAPLEX, lpChain, metaplexData } from "./helpers/lpchain.js";
import { d1 } from "./helpers/d1.js";
import { LOGO_MIGRATION, ensureLogoSchema, ensureSchema } from "../src/store.js";
import { hashOf } from "../src/logos.js";
import { handleCoinMeta, metadataUriFor } from "../src/coinmeta.js";
import { allowListed } from "../src/coin.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _resetLpKit } from "../src/lpkit.js";

let env;
beforeEach(() => { useClock("2026-10-20T12:00:00Z"); _resetLpCoins(); _resetLpKit(); env = newWorld({ VICINITY_MINT: MINT, LAUNCHPAD_V2: "on" }); });
after(() => realClock());

// two 1×1 PNGs that differ in their last bytes (both pass readImage's magic-byte check)
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a3f40000000049454e44ae426082", "hex");
const PNG2 = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a3f40000000049454e44ae426083", "hex");
const UTICA = "5142056";
const design = (over = {}) => ({ name: "Utica Coin", pitch: "The Handshake City, on the map.", pair: "SOL", color: "emerald", ...over });

/** A person who holds and is the active City Founder of Utica (the seat made directly, like test/coins.test.js). */
async function founder() {
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(UTICA, u.id, u.wallet, at, at).run();
  f.userId = u.id;
  return f;
}
/** A signed-in person with a staff role from the admin_roles table (the owner comes from ADMIN_WALLETS). */
async function staff(role) {
  const p = await person(env);
  await env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, ?, 'test', ?)").bind(p.w.address, role, new Date(Date.now()).toISOString()).run();
  return p;
}
const status = async (who, url) => (await who.send(url)).status;
const audit = async (action) => (await browser(env).get("/api/audit?country=US")).actions.filter((a) => a.action === action);
const mediaRow = (id) => env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(Number(String(id).split("/").pop())).first();

test("schema: the lazy migration adds the columns once, is safe to repeat (columns already there), drops nothing, and a picture uploaded before it waits for a check", async () => {
  // a database as production has it before this change: city_coins without the new columns, two designs, one with a picture
  const db = d1();
  await ensureSchema(db);
  const cols = async () => (await db.prepare("PRAGMA table_info(city_coins)").all()).results.map((c) => c.name);
  assert.ok(!(await cols()).includes("logo_status"), "ensureSchema alone never adds them (MIGRATIONS is frozen)");
  const row = (city, media) => db.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, media_id, updated_at, created_at) VALUES (?, ?, 'US', 1, 1, ?, 'SOL', 'gold', ?, 't', 't')")
    .bind(city, `City ${city}`, `Coin ${city}`, media).run();
  await row("1", 7); await row("2", null);
  await ensureLogoSchema(db);
  for (const c of ["logo_status", "logo_reason", "logo_note", "logo_reviewed_at", "logo_reviewed_by", "logo_hash", "approved_media_id"]) assert.ok((await cols()).includes(c), c);
  const rows = (await db.prepare("SELECT city_id, media_id, logo_status, approved_media_id, logo_hash FROM city_coins ORDER BY city_id").all()).results;
  assert.deepEqual(rows, [{ city_id: "1", media_id: 7, logo_status: "pending", approved_media_id: null, logo_hash: null }, { city_id: "2", media_id: null, logo_status: null, approved_media_id: null, logo_hash: null }],
    "the old picture waits for a check (a design preview: no coin has launched), nothing else changes");
  assert.ok(await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(LOGO_MIGRATION.id).first(), "recorded once");
  // a second server whose columns are already there (the ALTERs say "duplicate column"): nothing breaks, nothing is rewritten
  const db2 = d1();
  await ensureSchema(db2);
  for (const s of LOGO_MIGRATION.columns) await db2.prepare(s).run();
  await db2.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, media_id, logo_status, approved_media_id, logo_hash, updated_at, created_at) VALUES ('3', 'C', 'US', 1, 1, 'N', 'SOL', 'gold', 9, 'approved', 9, 'abc', 't', 't')").run();
  await ensureLogoSchema(db2);
  const kept = await db2.prepare("SELECT logo_status, approved_media_id, logo_hash FROM city_coins WHERE city_id = '3'").first();
  assert.deepEqual(kept, { logo_status: "approved", approved_media_id: 9, logo_hash: "abc" }, "an approved row is untouched by the backfill");
  assert.ok(await db2.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(LOGO_MIGRATION.id).first());
  assert.equal(await ensureLogoSchema(db2), undefined, "repeat: a no-op");
});

test("a new picture waits: the founder and the staff see it, every public surface shows nothing (the badge), strangers get 404 on its URL", async () => {
  const f = await founder();
  const local = await person(env, { home: IN_UTICA, holds: 10 });
  const away = await person(env, { home: IN_NYC });
  const mod = await staff("moderator"), adm = await staff("admin");
  const r = await f.post("/api/coins/design", design({ image: PNG.toString("base64") }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.coin.logoDraft, /^\/api\/media\/\d+$/);
  assert.deepEqual([r.coin.logoStatus, r.coin.logo, r.coin.logoHash, r.coin.logoReason, r.coin.logoNote], ["pending", null, null, null, null]);
  const draft = r.coin.logoDraft;
  assert.deepEqual([await status(f, draft), await status(mod, draft), await status(adm, draft)], [200, 200, 200], "the founder and the staff");
  assert.deepEqual([await status(local, draft), await status(away, draft), await status(browser(env), draft)], [404, 404, 404], "nobody else, and never 'forbidden'");
  assert.match((await f.send(draft)).headers.get("cache-control"), /^private/, "a working picture never sits in a shared cache");
  // public surfaces: one city's coin, the whole list, the launchpad card
  const one = await browser(env).get(`/api/coins?city=${UTICA}`);
  assert.deepEqual([one.coin.logo, one.coin.logoHash, "logoStatus" in one.coin, "logoDraft" in one.coin], [null, null, false, false]);
  assert.equal((await local.get(`/api/coins?city=${UTICA}`)).coin.logo, null, "a signed-in neighbour: the same public answer");
  assert.equal("logoDraft" in (await local.get(`/api/coins?city=${UTICA}`)).coin, false);
  assert.equal((await browser(env).get("/api/coins")).coins[0].logo, null);
  const lp = await (await browser(env).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json();
  assert.equal(lp.coins.find((c) => c.city.id === UTICA).logo, null, "the card shows the badge");
  assert.ok(!JSON.stringify(lp).includes(draft), "the working picture's URL is nowhere in a public answer");
  // the founder's own answer carries the state; so does the staff's
  const mine = await f.get(`/api/coins?city=${UTICA}`);
  assert.deepEqual([mine.coin.logoStatus, mine.coin.logoDraft], ["pending", draft]);
  assert.deepEqual([(await mod.get(`/api/coins?city=${UTICA}`)).coin.logoStatus, (await adm.get(`/api/coins?city=${UTICA}`)).coin.logoDraft], ["pending", draft]);
  // the admin list and the Overview count
  const list = await mod.get("/api/admin/logos");
  assert.equal(list.waiting, 1);
  const p = list.logos[0];
  assert.deepEqual([p.city, p.coin, p.launched, p.preview, p.type, p.size, p.status, p.founder.wallet], [{ id: UTICA, name: "Utica", country: "US" }, "Utica Coin", false, draft, "image/png", PNG.length, "pending", `${f.w.address.slice(0, 5)}*****${f.w.address.slice(-3)}`]);
  assert.ok(p.uploadedAt && p.mediaId === Number(draft.split("/").pop()));
  assert.ok(!JSON.stringify(list).includes(f.w.address), "no whole wallet in the list");
  assert.equal((await mod.get("/api/admin/overview")).pendingLogos, 1);
  assert.equal((await local.get("/api/admin/logos")).error, "forbidden", "staff only");
});

test("approve: the picture becomes public with the hash of its bytes; tampered bytes are 'not found'; an hour in caches; a replacement waits while the approved one keeps showing; one public log line", async () => {
  const f = await founder();
  const adm = await staff("admin");
  const r = await f.post("/api/coins/design", design({ image: PNG.toString("base64") }));
  const first = r.coin.logoDraft, firstId = Number(first.split("/").pop());
  assert.deepEqual((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "approve", mediaId: firstId + 1 })).error, "picture_changed", "the admin decides on the picture they looked at");
  const ok = await adm.post("/api/admin/logos/decide", { city: UTICA, mediaId: firstId, action: "approve" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const hash = await hashOf(PNG);
  assert.deepEqual([ok.action, ok.hash], ["approve", hash]);
  // public: the URL and the hash; the bytes; the cache header
  const pub = await browser(env).get(`/api/coins?city=${UTICA}`);
  assert.deepEqual([pub.coin.logo, pub.coin.logoHash], [first, hash]);
  const got = await browser(env).send(first);
  assert.deepEqual([got.status, got.headers.get("content-type"), got.headers.get("cache-control")], [200, "image/png", "public, max-age=3600"]);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), new Uint8Array(PNG));
  assert.equal((await browser(env).get("/api/coins")).coins[0].logo, first);
  assert.equal((await (await browser(env).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json()).coins.find((c) => c.city.id === UTICA).logo, first);
  const mine = await f.get(`/api/coins?city=${UTICA}`);
  assert.deepEqual([mine.coin.logoStatus, mine.coin.logo, mine.coin.logoDraft], ["approved", first, first]);
  // the bytes swapped under the approved row: not what the admin approved, so nobody gets them (the founder included)
  await env.DB.prepare("UPDATE media SET bytes = ? WHERE id = ?").bind(PNG2, firstId).run();
  assert.deepEqual([await status(browser(env), first), await status(f, first), await status(adm, first)], [404, 404, 404]);
  await env.DB.prepare("UPDATE media SET bytes = ? WHERE id = ?").bind(PNG, firstId).run();
  assert.equal(await status(browser(env), first), 200);
  // the public log: the city, the action and the reason; the admin audit; neither carries anything else
  const log = await audit("coin_logo_approved");
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].reason, log[0].note, log[0].target, log[0].country], ["review", "Utica", "city_coin", "US"]);
  // the founder sends another picture: it waits; the approved one keeps showing until the new one is decided
  const r2 = await f.post("/api/coins/design", design({ image: PNG2.toString("base64") }));
  const second = r2.coin.logoDraft;
  assert.notEqual(second, first);
  assert.deepEqual([r2.coin.logoStatus, r2.coin.logo, r2.coin.logoHash, r2.coin.logoDraft], ["pending", first, hash, second]);
  assert.equal((await browser(env).get(`/api/coins?city=${UTICA}`)).coin.logo, first);
  assert.deepEqual([await status(f, second), await status(browser(env), second)], [200, 404]);
  const list = await adm.get("/api/admin/logos");
  assert.deepEqual([list.waiting, list.logos[0].status, list.logos[0].preview, list.logos[0].approved, list.logos[0].current], [1, "pending", second, true, false]);
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, mediaId: firstId, action: "approve" })).error, "picture_changed", "the old picture is not the working one any more");
  const ok2 = await adm.post("/api/admin/logos/decide", { city: UTICA, action: "approve" });
  assert.deepEqual([ok2.ok, ok2.hash], [true, await hashOf(PNG2)]);
  assert.deepEqual([(await browser(env).get(`/api/coins?city=${UTICA}`)).coin.logo, (await browser(env).get(`/api/coins?city=${UTICA}`)).coin.logoHash], [second, await hashOf(PNG2)]);
  assert.deepEqual([await status(browser(env), second), await status(browser(env), first), await status(f, first)], [200, 404, 200], "the old picture is nobody's but its uploader's now");
  assert.equal((await adm.get("/api/admin/logos")).waiting, 0);
  assert.equal((await adm.get("/api/admin/overview")).pendingLogos, 0);
  // removing the picture clears everything
  const r3 = await f.post("/api/coins/design", design({ removeLogo: true }));
  assert.deepEqual([r3.coin.logo, r3.coin.logoHash, r3.coin.logoDraft, r3.coin.logoStatus], [null, null, null, null]);
  assert.equal(await status(browser(env), second), 404);
});

test("reject: the reason and the note reach the founder alone; nothing is public; replacing the picture waits again; a moderator cannot decide; a stale proof is refused", async () => {
  const f = await founder();
  const mod = await staff("moderator"), adm = await staff("admin");
  const r = await f.post("/api/coins/design", design({ image: PNG.toString("base64") }));
  const draft = r.coin.logoDraft;
  assert.deepEqual((await mod.post("/api/admin/logos/decide", { city: UTICA, action: "reject", reason: "scam", note: "Copies the city seal" })).error, "forbidden", "a moderator looks, admins decide");
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "reject", reason: "scam" })).error, "reason_required", "a note for the founder is needed");
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "reject", reason: "ugly", note: "Copies the city seal" })).error, "reason_required", "a reason from the rules");
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "reject", reason: "scam", note: "no" })).error, "reason_required", "3 to 300 characters");
  assert.equal((await adm.post("/api/admin/logos/decide", { city: "5128581", action: "reject", reason: "scam", note: "Copies the city seal" })).error, "not_found", "a city without a picture");
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "burn" })).error, "bad_request");
  const ok = await adm.post("/api/admin/logos/decide", { city: UTICA, action: "reject", reason: "scam", note: "Copies the city seal" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // the founder: the reason and the note, and still their working picture to look at
  const mine = await f.get(`/api/coins?city=${UTICA}`);
  assert.deepEqual([mine.coin.logoStatus, mine.coin.logoReason, mine.coin.logoNote, mine.coin.logoDraft, mine.coin.logo], ["rejected", "scam", "Copies the city seal", draft, null]);
  assert.equal(await status(f, draft), 200);
  // the public: nothing, and not a word of the note anywhere
  const pub = await browser(env).send(`/api/coins?city=${UTICA}`);
  const text = await pub.text();
  assert.equal(JSON.parse(text).coin.logo, null);
  assert.ok(!text.includes("seal") && !text.includes("rejected"), "no note, no state");
  assert.equal(await status(browser(env), draft), 404);
  const log = await audit("coin_logo_rejected");
  assert.deepEqual([log.length, log[0].reason, log[0].note], [1, "scam", "Utica"], "the public line: city, action, reason; never the note");
  assert.ok(!JSON.stringify(await browser(env).get("/api/audit?country=US")).includes("seal"));
  // decided pictures stay in the admin list a while; nothing waits
  const list = await adm.get("/api/admin/logos");
  assert.deepEqual([list.waiting, list.logos[0].status, list.logos[0].reason, list.logos[0].note], [0, "rejected", "scam", "Copies the city seal"]);
  // the founder sends another: it waits again, the old reason and note are gone
  const r2 = await f.post("/api/coins/design", design({ image: PNG2.toString("base64") }));
  assert.deepEqual([r2.coin.logoStatus, r2.coin.logoReason, r2.coin.logoNote, r2.coin.logo], ["pending", null, null, null]);
  assert.notEqual(r2.coin.logoDraft, draft);
  // a stale wallet proof: refused like every admin change; proven again it works; the owner (ADMIN_WALLETS) may decide too
  advance(31 * 60_000);
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "approve" })).error, "reprove");
  await reprove(adm);
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  assert.equal((await owner.post("/api/admin/logos/decide", { city: UTICA, action: "approve" })).ok, true);
  assert.equal((await browser(env).get(`/api/coins?city=${UTICA}`)).coin.logo, r2.coin.logoDraft);
});

test("takedown: an approved picture is rejected and hidden at once; the founder sees the reason and can send another; a coin without a picture is 404", async () => {
  const f = await founder();
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const r = await f.post("/api/coins/design", design({ image: PNG.toString("base64") }));
  const pic = r.coin.logoDraft;
  assert.equal((await owner.post("/api/admin/logos/decide", { city: UTICA, action: "approve" })).ok, true);
  assert.equal(await status(browser(env), pic), 200);
  const t = await owner.post("/api/coins/takedown", { city: UTICA, what: "logo", reason: "abuse", note: "Offensive picture" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.deepEqual([t.coin.logo, t.coin.logoHash, t.coin.logoStatus, t.coin.logoReason, t.coin.logoNote], [null, null, "rejected", "abuse", "Offensive picture"]);
  assert.equal((await browser(env).get(`/api/coins?city=${UTICA}`)).coin.logo, null);
  assert.deepEqual([await status(browser(env), pic), await status(f, pic)], [404, 200], "hidden from everyone but its founder (and the staff)");
  const row = await env.DB.prepare("SELECT approved_media_id, logo_hash, logo_status FROM city_coins WHERE city_id = ?").bind(UTICA).first();
  assert.deepEqual(row, { approved_media_id: null, logo_hash: null, logo_status: "rejected" });
  assert.equal((await audit("coin_logo_removed")).length, 1, "the takedown's own public line, as before");
  const r2 = await f.post("/api/coins/design", design({ image: PNG2.toString("base64") }));
  assert.deepEqual([r2.coin.logoStatus, r2.coin.logoReason], ["pending", null]);
  // nothing to take down: the founder removes the picture, a logo takedown answers 404 and writes no state (the card has nothing to say)
  await f.post("/api/coins/design", design({ removeLogo: true }));
  const none = await owner.send("/api/coins/takedown", { method: "POST", body: { city: UTICA, what: "logo", reason: "abuse", note: "Offensive picture" } });
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error, "not_found");
  assert.deepEqual(await env.DB.prepare("SELECT logo_status, logo_reason, approved_media_id FROM city_coins WHERE city_id = ?").bind(UTICA).first(), { logo_status: null, logo_reason: null, approved_media_id: null });
  assert.equal((await f.get(`/api/coins?city=${UTICA}`)).coin.logoStatus, null);
  assert.equal((await audit("coin_logo_removed")).length, 1, "no second log line");
});

test("takedown while a newer picture waits: the public picture goes, the waiting picture keeps waiting with no reason of its own, and stays in the admin's queue", async () => {
  const f = await founder();
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const first = (await f.post("/api/coins/design", design({ image: PNG.toString("base64") }))).coin.logoDraft;
  assert.equal((await owner.post("/api/admin/logos/decide", { city: UTICA, action: "approve" })).ok, true);
  const r2 = await f.post("/api/coins/design", design({ image: PNG2.toString("base64") }));
  const second = r2.coin.logoDraft;
  assert.deepEqual([r2.coin.logoStatus, r2.coin.logo], ["pending", first]);
  const t = await owner.post("/api/coins/takedown", { city: UTICA, what: "logo", reason: "abuse", note: "Offensive picture" });
  assert.equal(t.ok, true, JSON.stringify(t));
  // the approved picture is gone for everyone; the second was never looked at, so it is neither refused nor blamed
  assert.deepEqual([t.coin.logo, t.coin.logoHash, t.coin.logoStatus, t.coin.logoReason, t.coin.logoNote, t.coin.logoDraft], [null, null, "pending", null, null, second]);
  assert.deepEqual([await status(browser(env), first), await status(browser(env), second), await status(f, second)], [404, 404, 200]);
  const row = await env.DB.prepare("SELECT approved_media_id, logo_hash, logo_status, logo_reason, logo_note, logo_reviewed_at FROM city_coins WHERE city_id = ?").bind(UTICA).first();
  assert.deepEqual(row, { approved_media_id: null, logo_hash: null, logo_status: "pending", logo_reason: null, logo_note: null, logo_reviewed_at: null });
  const list = await owner.get("/api/admin/logos");
  assert.deepEqual([list.waiting, list.logos[0].status, list.logos[0].preview, list.logos[0].approved], [1, "pending", second, false]);
  assert.equal((await owner.get("/api/admin/overview")).pendingLogos, 1);
  // a takedown while the working picture was already refused on its own: its reason stays its own
  const ok = await owner.post("/api/admin/logos/decide", { city: UTICA, action: "approve" });
  assert.equal(ok.ok, true);
  const third = (await f.post("/api/coins/design", design({ image: PNG.toString("base64") }))).coin.logoDraft;
  assert.equal((await owner.post("/api/admin/logos/decide", { city: UTICA, action: "reject", reason: "scam", note: "Copies the city seal" })).ok, true);
  assert.equal((await browser(env).get(`/api/coins?city=${UTICA}`)).coin.logo, second, "the approved one keeps showing");
  const t2 = await owner.post("/api/coins/takedown", { city: UTICA, what: "logo", reason: "abuse", note: "Offensive picture" });
  assert.deepEqual([t2.coin.logo, t2.coin.logoStatus, t2.coin.logoReason, t2.coin.logoNote, t2.coin.logoDraft], [null, "rejected", "scam", "Copies the city seal", third]);
});

test("approve looks at the media row's type: a row that is not a picture is never approved (a second check behind readImage)", async () => {
  const f = await founder();
  const adm = await staff("admin");
  const r = await f.post("/api/coins/design", design({ image: PNG.toString("base64") }));
  const id = Number(r.coin.logoDraft.split("/").pop());
  await env.DB.prepare("UPDATE media SET type = 'text/html' WHERE id = ?").bind(id).run();
  const no = await adm.send("/api/admin/logos/decide", { method: "POST", body: { city: UTICA, action: "approve" } });
  assert.deepEqual([no.status, (await no.json()).error], [404, "not_found"]);
  assert.deepEqual(await env.DB.prepare("SELECT logo_status, approved_media_id, logo_hash FROM city_coins WHERE city_id = ?").bind(UTICA).first(), { logo_status: "pending", approved_media_id: null, logo_hash: null });
  assert.equal((await browser(env).get(`/api/coins?city=${UTICA}`)).coin.logo, null);
});

test("/coin-meta/<mint>.png: the approved picture (hash-checked, an hour in caches) once the launch is recorded; the badge while it waits or after a takedown; the coin page's data carries the hash", async () => {
  const lp = { ...LP(), ...LP_ON };
  const chain = lpChain({ accounts: { [await metadataAddress(DEMOV)]: { owner: METAPLEX, lamports: 5_616_720, data: metaplexData({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", uri: metadataUriFor(DEMOV) }) } } });
  const get = (path) => handleCoinMeta(new Request(`https://vicinity.city${path}`, { headers: { "cf-connecting-ip": "198.51.100.7" } }), lp, chain.fetchImpl, Date.now());
  await ensureSchema(lp.DB);
  const m = await lp.DB.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (1, 'image/png', ?, ?)").bind(PNG, new Date(Date.now()).toISOString()).run();
  // waiting for a check: the launch is recorded from the chain all the same, and the badge shows
  await seedCoin(lp.DB, { city: DEMOV_CITY, name: "Demo City", coin: "Demo Coin", media: m.meta.last_row_id, user: 1, seat: 1 });
  const waiting = await get(`/coin-meta/${DEMOV}.png`);
  assert.deepEqual([waiting.status, waiting.headers.get("location")], [302, "/brand/vicinity-512.png"]);
  assert.equal((await lp.DB.prepare("SELECT mint FROM city_coins WHERE city_id = ?").bind(DEMOV_CITY).first()).mint, DEMOV, "recorded: the launch did not wait for the picture");
  const listed = await allowListed(lp, DEMOV);
  assert.deepEqual([listed.logo, listed.logoHash], [null, null]);
  // approved (what POST /api/admin/logos/decide writes): the picture, with the hash
  const hash = await hashOf(PNG);
  await lp.DB.prepare("UPDATE city_coins SET approved_media_id = media_id, logo_hash = ?, logo_status = 'approved' WHERE city_id = ?").bind(hash, DEMOV_CITY).run();
  const png = await get(`/coin-meta/${DEMOV}.png`);
  assert.deepEqual([png.status, png.headers.get("content-type"), png.headers.get("cache-control"), png.headers.get("access-control-allow-origin")], [200, "image/png", "public, max-age=3600", "*"]);
  assert.deepEqual(new Uint8Array(await png.arrayBuffer()), new Uint8Array(PNG));
  const again = await allowListed(lp, DEMOV);
  assert.deepEqual([again.logo, again.logoHash], [`/api/media/${m.meta.last_row_id}`, hash]);
  // the JSON's image URL is this very address: a takedown changes what it serves, never the URI
  const meta = await (await get(`/coin-meta/${DEMOV}.json`)).json();
  assert.equal(meta.image, `https://vicinity.city/coin-meta/${DEMOV}.png`);
  // swapped bytes: the badge
  await lp.DB.prepare("UPDATE media SET bytes = ? WHERE id = ?").bind(PNG2, m.meta.last_row_id).run();
  assert.equal((await get(`/coin-meta/${DEMOV}.png`)).status, 302);
});
