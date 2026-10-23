// NEW-1: an admin's takedown of a ready-made coin's founder content (src/cointakedown.js through POST /api/coins/takedown), launched or
// not, through the real API and real SQL with the launchpad's fake chain. The founder's description (or name, or uploaded picture) really
// leaves the coin's version, its design row, every page that shows it (/api/coins, /api/launchpad, the founder's card, the preview) and the
// /coin-meta JSON wallets read, falling back to Vicinity's own; the caches are purged; the founder is told; the public log says it in fixed
// neutral words; the admin's answer says exactly what changed. The taken-down words never pass by themselves again and no earlier pass or
// approval vouches for them. With COIN_V2_REVIEW off, Vicinity's own ready-made coin takes the older path exactly as before.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { advance, browser, person, realClock, reprove } from "./helpers/world.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _resetLaunchpad, handleLaunchpad } from "../src/launchpad.js";
import { _setArtRenderer } from "../src/coinready.js";
import { _resetReview, _setScreener } from "../src/coinreview.js";
import { SYSTEM_TEXT_LAUNCHED } from "../src/cointakedown.js";
import { sha256Hex } from "../src/coinart.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { UTICA, approvalAccount, b64, launchOnChain, meta, pngOf, seenOf, world } from "./helpers/readyworld.js";

before(async () => { const r = await nodeRenderer(); _setArtRenderer(r); });
after(() => { _setArtRenderer(null); _setScreener(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); _resetReview(); _resetLaunchpad(); _setScreener(null); realClock(); });

const DEFAULT = "The city coin of Utica, New York, United States.";
const OWN = "Utica is the Handshake City, home of the half moon cookie and chicken riggies.";
const NOTE = "Copied from a rival coin's page, word for word.";

async function takedownWorld({ review = "on" } = {}) {
  const w = await world();
  if (review) w.env.COIN_V2_REVIEW = review;
  w.env.NOTIFY = "on";
  w.admin = await person(w.env);
  await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, 'admin', ?, ?)").bind(w.admin.w.address, w.owner.w.address, new Date(Date.now()).toISOString()).run();
  w.ready = (who = w.f) => w.get(who, `/api/coins/ready?city=${UTICA}`);
  w.rv = (path, body = {}, who = w.f) => w.post(who, `/api/coins/review/${path}`, { cityId: UTICA, ...body });
  w.queue = (who = w.admin) => w.get(who, "/api/admin/coins/reviews");
  w.decide = (body, who = w.admin) => w.post(who, "/api/admin/coins/reviews/decide", body);
  w.takedown = (body, who = w.owner) => w.post(who, "/api/coins/takedown", { city: UTICA, reason: "abuse", note: NOTE, ...body });
  w.row = (sql, ...p) => w.env.DB.prepare(sql).bind(...p).first();
  w.all = async (sql, ...p) => (await w.env.DB.prepare(sql).bind(...p).all()).results;
  w.status = (who = w.f) => w.get(who, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
  w.notices = async () => (await w.all("SELECT text FROM notices ORDER BY id")).map((n) => n.text);
  /** what each page shows of Utica's coin: the founder's dashboard card, the public coin list, the Launchpad card, the preview, the founder's card */
  w.pages = async () => {
    _resetLaunchpad();
    const lp = await (await handleLaunchpad({ ...w.env, LAUNCHPAD_V2: "on" }, w.both)).json();
    const ready = await w.ready();
    return {
      coin: (await w.get(browser(w.env), `/api/coins?city=${UTICA}`)).coin.pitch,
      list: (await w.get(browser(w.env), "/api/coins")).coins.find((c) => c.city === UTICA).pitch,
      launchpad: lp.coins.find((c) => c.city.id === UTICA).pitch,
      founder: ready.coin.description,
      preview: (await w.get(browser(w.env), `/api/coins?city=${UTICA}`)).coin && (await w.get(browser(w.env), `/api/coins/ready?city=${UTICA}`)).preview,
    };
  };
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
    return c;
  };
  w.launch = async (md = { name: "Utica", symbol: "UTICA" }) => {
    const mint = await launchOnChain(w, md);
    advance(10 * 60_000);
    const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    await reprove(w.f); await reprove(w.admin); await reprove(w.owner);
    return mint;
  };
  w.json = async (mint) => JSON.parse((await w.row("SELECT meta_json FROM lp_coins WHERE mint = ?", mint)).meta_json);
  return w;
}
const neutral = async (w, action, reason = "abuse") => {
  const rows = await w.all("SELECT note, reason, target_user FROM mod_actions WHERE action = ?", action);
  assert.equal(rows.length, 1, action);
  assert.doesNotMatch(rows[0].note, /Handshake|rival|word for word|Utica Falls/, "the public line never carries the founder's words nor the admin's note");
  assert.equal(rows[0].reason, reason);
  return rows[0];
};

test("not launched: the founder's own description (it passed by itself) goes from every page, the same words never pass again, the admin is told exactly", async () => {
  const w = await takedownWorld();
  await w.useCoin();
  const used = await w.rv("description", { text: OWN });
  assert.equal(used.used, true, JSON.stringify(used));
  await w.approveOnChain(); // the owner's approval was built from the coin with the founder's description
  const was = await w.pages();
  assert.deepEqual([was.coin, was.list, was.launchpad, was.founder, was.preview.description], [OWN, OWN, OWN, OWN, OWN]);
  // it never came through the queue (it passed by itself), but the staff see it among the founders' own words in use
  const inUse = (await w.queue()).inUse;
  assert.deepEqual(inUse.map((x) => [x.city.id, x.description, x.ownDescription, x.ownName, x.upload, x.launched]), [[UTICA, OWN, true, false, false, false]]);

  const t = await w.takedown({ what: "text" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.match(t.changed[0], /^Taken down: the founder's description of \$UTICA\.$/);
  assert.match(t.message, new RegExp(`uses Vicinity's own sentence now \\(“${DEFAULT.replace(/\./g, "\\.")}”\\); its name, ticker and picture stay\\.`));
  assert.match(t.message, /the launch waits until the owner approves the coin as it is now, at the next approval round/);
  assert.match(t.message, /The founder was told in their notifications\./);
  assert.equal(t.coin.pitch, DEFAULT);
  // every page falls back to Vicinity's own sentence (never NULL, never the founder's words)
  const now = await w.pages();
  assert.deepEqual([now.coin, now.list, now.launchpad, now.founder, now.preview.description], [DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT]);
  assert.deepEqual((await w.queue()).inUse, [], "nothing of the founder's is public any more");
  const card = await w.ready();
  assert.equal(card.review.description.source, "default");
  assert.match(card.review.description.takenDown.message, /^Vicinity took down your description \(abuse or hate\)\. Your coin uses Vicinity's own description now\./);
  assert.equal(card.inUse, true, "the coin is still the founder's choice: only the description changed");
  assert.equal((await w.status()).why || (await w.status()).error, "approval_changed", "the approval was built from the earlier version: the launch waits for the round");
  // the public line is neutral; the staff line keeps the note; the founder is told
  await neutral(w, "coin_text_removed");
  assert.match((await w.row("SELECT detail FROM admin_audit WHERE action = 'coins/takedown_text'")).detail, /note: Copied from a rival/);
  assert.ok((await w.notices()).includes("Vicinity took down your coin's description: abuse or hate. Your coin uses Vicinity's own description now."));
  // the same words never pass by themselves again (no earlier pass vouches): flagged, with the reason the founder reads
  const again = await w.rv("description", { text: OWN });
  assert.equal(again.screening.result, "flag");
  assert.ok(again.screening.issues.some((x) => x.code === "taken_down" && /took this description down before/.test(x.message)));
  assert.notEqual(again.used, true);
  assert.equal((await w.pages()).coin, DEFAULT);
});

test("not launched: an approved description request no longer vouches once its words are taken down; a pending request carrying them is withdrawn", async () => {
  const w = await takedownWorld();
  await w.useCoin();
  const flagged = await w.rv("description", { text: "Utica: to the moon with the best cookies in New York." });
  assert.equal(flagged.screening.result, "flag");
  await w.rv("description/review", { screeningId: flagged.screening.id });
  const q = (await w.queue()).reviews.find((x) => x.status === "pending");
  assert.equal((await w.decide({ id: q.id, action: "approve", contentHash: q.contentHash })).ok, true);
  const text = "Utica: to the moon with the best cookies in New York.";
  assert.equal((await w.ready()).coin.description, text);
  // a change request is pending: its version carries the description
  await w.request({ name: "Utica Falls" });
  assert.equal((await w.ready()).review.request.status, "pending");
  const t = await w.takedown({ what: "text" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.match(t.message, /The founder's request that carried the description was withdrawn \(1\)\./);
  assert.equal((await w.row("SELECT status FROM coin_requests WHERE kind = 'change' ORDER BY id DESC LIMIT 1")).status, "withdrawn");
  assert.equal((await w.ready()).review.hold, null, "nothing pauses the launch any more");
  // the earlier approval of exactly these words does not vouch for them now: the words are flagged, never used by themselves
  const again = await w.rv("description", { text });
  assert.equal(again.screening.result, "flag");
  assert.ok(again.screening.issues.some((x) => x.code === "taken_down"));
  assert.notEqual(again.used, true);
  assert.equal((await w.ready()).coin.description, DEFAULT);
  // ...a person may still bring them back: sent for review, the reviewer sees that they were taken down, and decides
  const sent = await w.rv("description/review", { screeningId: again.screening.id });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const q2 = (await w.queue()).reviews.find((x) => x.status === "pending");
  assert.ok(q2.checks.some((c) => c.check === "taken_down_description" && /Approving it puts it back on the coin/.test(c.text)), JSON.stringify(q2.checks));
  const d2 = await w.decide({ id: q2.id, action: "approve", contentHash: q2.contentHash });
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.equal((await w.ready()).coin.description, text, "a person's review decided after the takedown vouches for the words");
  assert.equal((await w.ready()).review.hold, null);
});

test("not launched: a founder's own name (a reviewer approved it) and description: the coin goes back to Vicinity's coin for the city", async () => {
  const w = await takedownWorld();
  const coin = await w.useCoin();
  const p = await w.request({ name: "Utica Falls" });
  assert.equal((await w.decide({ id: p.id, action: "approve", contentHash: p.contentHash })).ok, true);
  assert.equal((await w.rv("description", { text: OWN })).used, true);
  const c = await w.ready();
  assert.deepEqual([c.coin.name, c.coin.description], ["Utica Falls", OWN]);
  const t = await w.takedown({ what: "text" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.changed[0], "Taken down: the founder's coin name and their description.");
  assert.match(t.message, /The coin is Vicinity's coin for Utica again: \$UTICA “Utica”, the Vicinity design and Vicinity's own description/);
  assert.match(t.message, /Nothing of it is on the blockchain yet\./);
  const after = await w.ready();
  assert.deepEqual([after.coin.name, after.coin.ticker, after.coin.description, after.coin.art], ["Utica", "UTICA", DEFAULT, coin.art]);
  assert.match(after.review.description.takenDown.message, /^Vicinity took down your coin name and description \(abuse or hate\)\. Your coin uses Vicinity's coin for your city now\./);
  assert.equal((await w.get(browser(w.env), `/api/coins?city=${UTICA}`)).coin.name, "Utica");
  const line = await neutral(w, "coin_text_removed");
  assert.match(line.note, /^Utica: the founder's coin name and description were taken down \(abuse or hate\); the coin uses Vicinity's coin for the city, version [0-9a-f]{8}$/);
  // nothing more of the founder's: said so, and nothing changes
  const none = await w.takedown({ what: "text" });
  assert.deepEqual([none.status, none.error], [409, "system_text"]);
  assert.match(none.message, /name and description are Vicinity's own.*Nothing was changed\./);
});

test("launched: the founder's description leaves the coin's /coin-meta JSON and every page; the name stays on chain; a second takedown says there is nothing left", async () => {
  const w = await takedownWorld();
  await w.useCoin();
  assert.equal((await w.rv("description", { text: OWN })).used, true);
  await w.approveOnChain();
  const mint = await w.launch();
  assert.ok((await w.json(mint)).description.startsWith(OWN), "the founder's words were published");
  const was = await w.pages();
  assert.deepEqual([was.coin, was.launchpad], [OWN, OWN]);

  // this data centre's cached copies of the pages are purged (src/index.js cached keys), and so is the server's Launchpad list
  const purged = [], had = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async (r) => { purged.push(new URL(r.url).pathname); return true; } } };
  let t;
  try { t = await w.takedown({ what: "text" }); } finally { if (had === undefined) delete globalThis.caches; else globalThis.caches = had; }
  assert.deepEqual(purged.sort(), ["/coin-" + mint, "/coins", `/launchpad-${w.env.VICINITY_MINT}`, "/lp-coin-" + mint].sort());
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.deepEqual(t.changed.slice(0, 3), [
    "Taken down: the founder's description of $UTICA.",
    `The coin's page, the Launchpad and its metadata (/coin-meta/${mint}.json, what wallets and Jupiter read) show Vicinity's own sentence now: “${DEFAULT}”`,
    "The coin's name “Utica” and ticker $UTICA stay: they are on the blockchain for good.",
  ]);
  assert.match(t.message, /Wallets and apps that read the metadata in the last hour may show the old description until they read it again\./);
  // the JSON wallets read: stored and served, with the version's own picture and Vicinity's sentence
  const j = await w.json(mint);
  assert.equal(j.description, `${DEFAULT} Launched on Vicinity (https://vicinity.city) on Solana.`);
  const served = await (await meta(w.env, `/coin-meta/${mint}.json`)).json();
  assert.equal(served.description, j.description);
  assert.doesNotMatch(JSON.stringify(served), /Handshake/);
  const now = await w.pages();
  assert.deepEqual([now.coin, now.list, now.launchpad], [DEFAULT, DEFAULT, DEFAULT]);
  assert.equal((await w.ready()).coin.description, DEFAULT, "the founder's card shows the launched coin as it is now");
  // still the coin's own binding (the mint, its picture): only the description changed
  // (its content is exactly Vicinity's coin for Utica, so it is that very version again)
  const bound = await w.row("SELECT r.mint, v.origin, v.description FROM coin_ready r JOIN coin_versions v ON v.id = r.version_id WHERE r.city_id = ?", UTICA);
  assert.deepEqual([bound.mint, bound.origin, bound.description], [mint, "default", DEFAULT]);
  assert.equal((await meta(w.env, `/coin-meta/${mint}.png`)).status, 302);
  await neutral(w, "coin_text_removed");
  assert.ok((await w.notices()).includes("Vicinity took down your coin's description: abuse or hate. Your coin and its metadata use Vicinity's own description now."));
  // nothing of the founder's is left: the older path's words, word for word, and nothing changes
  const again = await w.takedown({ what: "text" });
  assert.deepEqual([again.status, again.error, again.message], [409, "system_text", SYSTEM_TEXT_LAUNCHED]);
  assert.equal((await w.all("SELECT 1 FROM mod_actions WHERE action = 'coin_text_removed'")).length, 1);
  // switched off after use: the JSON keeps being served as it is now
  delete w.env.COIN_V2_REVIEW; delete w.env.COIN_V2_READY;
  assert.equal((await (await meta(w.env, `/coin-meta/${mint}.json`)).json()).description, j.description);
});

test("launched: the founder's own picture goes from the JSON and /coin-meta/<mint>.png, which show the Vicinity design of the coin; its address answers 404", async () => {
  const w = await takedownWorld();
  const coin = await w.useCoin();
  const png = pngOf(64, 64, [9, 99, 199]);
  const p = await w.request({ picture: "upload", image: b64(png) });
  assert.equal((await w.decide({ id: p.id, action: "approve", contentHash: p.contentHash })).ok, true);
  const up = await sha256Hex(new Uint8Array(png));
  await w.approveOnChain();
  const mint = await w.launch();
  assert.equal((await w.json(mint)).image, `https://vicinity.city/coin-meta/art/${up}.png`);
  const t = await w.takedown({ what: "art", reason: "illegal" });
  assert.equal(t.ok, true, JSON.stringify(t));
  const tpl = coin.art.slice(15, 79); // the Vicinity design of $UTICA "Utica"
  assert.equal(t.changed[0], `Taken down: the founder's own picture of $UTICA (/coin-meta/art/${up}.png): its address answers “not found” now.`);
  assert.equal(t.changed[1], `The coin's metadata (/coin-meta/${mint}.json) and /coin-meta/${mint}.png show the Vicinity design of $UTICA “Utica” instead (/coin-meta/art/${tpl}.png).`);
  assert.match(t.message, /once the coin launched it was served as permanent/);
  assert.equal((await w.json(mint)).image, `https://vicinity.city/coin-meta/art/${tpl}.png`);
  assert.equal((await meta(w.env, `/coin-meta/${mint}.png`)).headers.get("location"), `/coin-meta/art/${tpl}.png`);
  assert.equal((await meta(w.env, `/coin-meta/art/${up}.png`)).status, 404);
  assert.equal((await meta(w.env, `/coin-meta/art/${tpl}.png`)).status, 200);
  await neutral(w, "coin_art_removed", "illegal");
  assert.ok((await w.notices()).some((n) => n === "Your coin picture was taken down: illegal. Your coin and its metadata show the Vicinity design now."));
  const again = await w.takedown({ what: "art" });
  assert.deepEqual([again.status, again.error], [404, "not_found"]);
  assert.match(again.message, /no picture of the founder's own to take down.*Nothing was changed\./);
});

test("not launched: the founder's picture in use goes, and the coin is Vicinity's coin for the city again (never a broken picture)", async () => {
  const w = await takedownWorld();
  const coin = await w.useCoin();
  const png = pngOf(64, 64, [1, 2, 3]);
  const p = await w.request({ picture: "upload", image: b64(png) });
  assert.equal((await w.decide({ id: p.id, action: "approve", contentHash: p.contentHash })).ok, true);
  const sha = await sha256Hex(new Uint8Array(png));
  assert.equal((await w.ready()).review.selected.art, `/coin-meta/art/${sha}.png`);
  const t = await w.takedown({ what: "art", sha, reason: "illegal" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.match(t.message, /^Taken down: the founder's own picture \(\/coin-meta\/art\/[0-9a-f]{64}\.png\)\. Its address answers “not found” now/);
  assert.match(t.message, /The coin used it, so it is Vicinity's coin for Utica again: \$UTICA “Utica”/);
  assert.equal((await meta(w.env, `/coin-meta/art/${sha}.png`)).status, 404);
  const r = await w.ready();
  assert.deepEqual([r.coin.art, r.review.hold, r.inUse], [coin.art, null, true]);
  const again = await w.takedown({ what: "art", sha });
  assert.deepEqual([again.status, again.error], [404, "not_found"]);
});

test("the owner's approval being built right now (the 5-minute hold) wins: nothing changes, and the admin is told to try again", async () => {
  const w = await takedownWorld();
  await w.useCoin();
  assert.equal((await w.rv("description", { text: OWN })).used, true);
  const c = await w.card();
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 })).ok, true);
  const t = await w.takedown({ what: "text" });
  assert.deepEqual([t.status, t.error], [409, "held"]);
  assert.match(t.message, /Nothing was changed: take it down again in 5 minutes\./);
  assert.equal((await w.pages()).coin, OWN);
  assert.equal((await w.all("SELECT 1 FROM mod_actions WHERE action = 'coin_text_removed'")).length, 0);
  assert.equal((await w.all("SELECT 1 FROM coin_screenings WHERE rules_version = 'takedown'")).length, 0, "all or nothing");
});

test("switch off: Vicinity's own ready-made coin takes the older path exactly as before; founder content made while it was on can still be taken down", async () => {
  const w = await takedownWorld({ review: null });
  await w.useCoin();
  const t = await w.takedown({ what: "text" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal("changed" in t, false, "the older answer: { ok, coin }");
  const row = await w.row("SELECT name, pitch FROM city_coins WHERE city_id = ?", UTICA);
  assert.deepEqual([row.name, row.pitch], ["Utica", null]);
  assert.equal((await w.row("SELECT note FROM mod_actions WHERE action = 'coin_text_removed'")).note, `Utica: ${NOTE}`);
  assert.deepEqual([(await w.takedown({ what: "art" })).status, (await w.takedown({ what: "art" })).error], [400, "bad_request"]);
  // switched off AFTER use: the founder's description stays their coin, and the takedown still takes it down
  const w2 = await takedownWorld();
  await w2.useCoin();
  assert.equal((await w2.rv("description", { text: OWN })).used, true);
  delete w2.env.COIN_V2_REVIEW;
  const t2 = await w2.takedown({ what: "text" });
  assert.equal(t2.ok, true, JSON.stringify(t2));
  assert.equal((await w2.get(browser(w2.env), `/api/coins?city=${UTICA}`)).coin.pitch, DEFAULT);
});
