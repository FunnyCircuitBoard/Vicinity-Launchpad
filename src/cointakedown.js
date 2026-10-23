/**
 * An admin's takedown of a ready-made coin's founder-written content (POST /api/coins/takedown, src/coins.js handleTakedown, which hands
 * every { what: "text" | "art" } here first): a founder's own description, a coin name a reviewer approved for the founder, or the founder's
 * own uploaded picture (COIN_V2_REVIEW content), on a coin that is launched or not. null: not such a coin; the older paths decide, as before.
 *
 *   Which coins   A city whose chosen version is still its design row (not launched), or whose launched coin carries its bound version
 *                 (src/coinart-store.js), while COIN_V2_REVIEW is on or when the version was made by the review paths (origin other than
 *                 "default": switched off after use, founder content can still be taken down). With the switch off, Vicinity's own
 *                 ready-made coin is left to the older paths, exactly as before.
 *   "text"        Not launched: the founder's description becomes Vicinity's own sentence for the city (the name, ticker and picture
 *                 stay); when the name is the founder's too, the coin goes back to Vicinity's coin for the city (name, ticker, picture
 *                 and description were reviewed together). Launched: the name and ticker are on the blockchain for good; the founder's
 *                 description becomes Vicinity's sentence in the coin's bound version, on its design row (every page reads that), and in
 *                 its /coin-meta JSON (what wallets read), in the same batch.
 *   "art"         The founder's approved upload (`sha`: one, or every one of the city). Not launched: its public address stops answering,
 *                 and a coin that uses it goes back to Vicinity's coin for the city. Launched: the bound version gets the Vicinity design
 *                 of the coin's own ticker and name (drawn now if it never was), the JSON and /coin-meta/<mint>.png point there, and the
 *                 upload's address stops answering.
 * Each takedown is ONE database batch (all or nothing): the new version and the city's choice (src/coinready.js choiceStatements: never over
 * the owner's approval being built) or the launched coin's binding, the design row, the takedown marks (src/coinart-store.js TAKEDOWN: a
 * taken-down description never passes by itself again, and no earlier pass or approval vouches for it), the founder's pending requests
 * that carry the taken-down text (withdrawn), one public log line in fixed neutral words (the city, what went, the rule's reason; never the
 * founder's text, never the admin's note) and the staff audit line (with the note). Then this data centre's page caches are purged, the
 * founder gets a fixed sentence (src/notify.js), and the admin gets every change in plain words (`changed`, `message`).
 */
import { iso } from "./policy.js";
import { activeMint } from "./official.js";
import { coinV2ReviewOn } from "./flags.js";
import { notify, pictureReason } from "./notify.js";
import { coinDefaults } from "./coindefaults.js";
import { TEMPLATE_VERSION, coinSvg, sha256Hex } from "./coinart.js";
import { artBySvg, artBytes, artPath, chosenOf, cityDescription, storeArtStatement, takedownStatement, unboundUploads, versionForCoin } from "./coinart-store.js";
import { canonicalContent, choiceStatements, ensureArt, renderPng, versionLabel } from "./coinready.js";
import { ensureReviewSchema } from "./coinreview.js";
import { versionJson } from "./coinmeta.js";
import { rebuildMetaJson } from "./lpcoins.js";

/** The words the older path gave for a launched ready-made coin whose description is Vicinity's own (kept word for word). */
export const SYSTEM_TEXT_LAUNCHED = "This coin's description is Vicinity's own sentence from the city list (it launched with the Vicinity design), not the founder's text, so there is nothing to take down. Nothing was changed.";
const SYSTEM_TEXT = "This coin's name and description are Vicinity's own, from the city list, not the founder's, so there is nothing to take down. Nothing was changed.";
const NO_ART = "This coin has no picture of the founder's own to take down (its picture is the Vicinity design). Nothing was changed.";
const SPREAD = "The site's pages show the change at once here and everywhere within 30 seconds.";
const NOT_WRITTEN = {
  held: "The owner is approving this coin on the blockchain right now, so it can't change for a few minutes. Nothing was changed: take it down again in 5 minutes.",
  launched: "The coin launched meanwhile. Nothing was changed: reload, then take it down again (from the launched coin).",
  legacy_contract: "A LaunchLab contract for this city is waiting for a check. Nothing was changed: settle it first.",
  coin_changed: "The coin changed while this was being done. Nothing was changed: reload, check the coin again, then take it down.",
};
const done = (changed, extra = {}) => ({ status: 200, body: { ok: true, changed, message: changed.join(" "), ...extra } });
const refuse = (status, error, message) => ({ status, body: { ok: false, error, message } });
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
// a statement that FAILS (a CHECK constraint: the whole batch rolls back) unless `cond` holds (the same guard as src/coinreview.js)
const guard = (db, cond, args) => db.prepare(`INSERT INTO coin_requests (city_id, kind, status, seat_id, user_id, created_at, updated_at)
  SELECT 'guard', 'change', 'not_written', 0, 0, '', '' WHERE NOT (${cond})`).bind(...args);
const guardFailed = (e) => /CHECK constraint/i.test(String((e && e.message) || e));

/** Takedown of a ready-made coin's founder content: { status, body } (src/coins.js adds the coin's view to an ok body), or null. */
export async function v2Takedown(env, { coin, what, sha = null, reason, note, actor, now = Date.now() }) {
  if (what !== "text" && what !== "art") return null;
  const db = env.DB, cityId = String(coin.city_id);
  const c = await chosenOf(db, cityId, { fresh: true });
  if (!c || !c.content) return null;
  const launched = Boolean(coin.mint);
  if (launched ? c.mint !== coin.mint : !c.current) return null; // a studio design, or a coin launched with the older JSON
  const on = coinV2ReviewOn(env);
  if (!on && (c.origin || "default") === "default") return null; // stage 1's coin with the switch off: as before
  if (on) await ensureReviewSchema(db);
  const t = { env, db, cityId, coin, c, reason, note, actor, now, at: iso(now), city: c.content.city || {}, sentence: cityDescription(c.content.city) };
  if (what === "text") return launched ? textLaunched(t) : textChosen(t);
  return launched ? artLaunched(t, sha) : artChosen(t, sha);
}

/* ---------------------------------------------------------------- shared pieces */
/** Is `name` one of Vicinity's own names for this city (the city list's now, or one of its default versions)? */
async function vicinityName(t, d) {
  if (d.ok && t.c.name === d.name) return true;
  return Boolean(await t.db.prepare("SELECT 1 AS one FROM coin_versions WHERE city_id = ? AND origin = 'default' AND name = ? LIMIT 1").bind(t.cityId, t.c.name).first());
}
/** Vicinity's coin for the city as the list gives it now (the picture drawn if it never was). */
async function defaultsVersion(t, d) {
  const art = await ensureArt(t.env, d, t.now);
  const content = canonicalContent({ city: d.city, name: d.name, symbol: d.ticker, description: d.description, artSha256: art.sha256, templateVersion: TEMPLATE_VERSION });
  return { content, hash: await sha256Hex(content), name: d.name, symbol: d.ticker, description: d.description, artSha: art.sha256, templateVersion: TEMPLATE_VERSION, origin: "default" };
}
const modLog = (t, action, words) => t.db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
    VALUES (?, 'admin', ?, 'city_coin', NULL, ?, ?, ?, ?, ?, ?, 'done')`).bind(t.actor.id, action, t.coin.user_id ?? null, t.coin.country, t.cityId, t.reason, `${t.coin.city_name}: ${words}`, t.at);
const audit = (t, action, detail) => t.db.prepare("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
  .bind(t.actor.wallet || `user:${t.actor.id}`, action, `city_coin:${t.cityId}`, `${detail} · ${t.reason} · note: ${t.note}`, t.at);
/** The founder's pending requests whose version carries this text (approving one would bring the text back): how many, and the statement. */
async function carrying(t, text) {
  const n = await t.db.prepare(`SELECT COUNT(*) AS n FROM coin_requests r JOIN coin_versions v ON v.id = r.version_id WHERE r.city_id = ? AND r.status = 'pending' AND v.description = ?`)
    .bind(t.cityId, text).first();
  return { n: (n && n.n) || 0, stmt: t.db.prepare(`UPDATE coin_requests SET status = 'withdrawn', closed_at = ?, updated_at = ? WHERE city_id = ? AND status = 'pending'
      AND version_id IN (SELECT id FROM coin_versions WHERE city_id = ? AND description = ?)`).bind(t.at, t.at, t.cityId, t.cityId, text) };
}
/** The public log lines of this city that name its founder's coin name and ticker (written before the log stopped naming them). */
async function namedInLog(t, c) {
  const words = ` $${c.symbol} "${c.name}",`;
  const n = await t.db.prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE target_type = 'city_coin' AND place = ? AND instr(note, ?) > 0").bind(t.cityId, words).first();
  return { n: (n && n.n) || 0, stmt: t.db.prepare("UPDATE mod_actions SET note = replace(note, ?, '') WHERE target_type = 'city_coin' AND place = ? AND instr(note, ?) > 0").bind(words, t.cityId, words) };
}
/** This data centre's cached copies of the pages that show a coin's words (src/index.js cached: the same keys), and this server's list. */
async function purgePages(env, mint = null, arts = []) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const keys = ["coins", `launchpad-${activeMint(env) || "pre"}`, ...(mint ? [`coin-${mint}`, `lp-coin-${mint}`] : []), ...arts.map((x) => `coin-meta/art/${x}.png`)];
  if (cache) for (const k of keys) { try { await cache.delete(new Request(`https://cache.vicinity.internal/${k}`)); } catch { /* the cache is a convenience */ } }
  try { (await import("./launchpad.js")).forgetLaunchpadList(env); } catch { /* the list is rebuilt within 30 seconds anyway */ }
}
// `card`: the founder's coin card says it too (a description or a name taken down from a coin not launched yet: src/coinreview.js)
const told = (n, card = false) => (n ? "The founder was told in their notifications."
  : card ? "The founder sees it on their coin card (their in-app notifications are off)." : "The founder was not notified: their in-app notifications are off.");
/** Write a new choice for a coin that is not launched (src/coinready.js choiceStatements), all or nothing. null, or the refusal. */
async function writeChoice(t, v, { log, before = [], after = [] }) {
  const seat = { id: t.c.seat_id, city_name: t.coin.city_name, country: t.coin.country };
  // keepApproved: an approval the owner built from the earlier version stays recorded as that (never equal to this version's hash), so
  // the launch waits for the owner's next round to approve the coin as it is now (src/coinreview.js launchHold)
  const { stmts, at } = await choiceStatements(t.env, { cityId: t.cityId, seat, userId: t.c.user_id, v, log, now: t.now, before: t.c, keepApproved: true });
  try {
    await t.db.batch([...before, ...stmts, ...after, guard(t.db, "EXISTS (SELECT 1 FROM coin_ready WHERE city_id = ? AND content_hash = ? AND chosen_at = ?)", [t.cityId, v.hash, at])]);
  } catch (e) {
    if (!guardFailed(e)) throw e;
    const h = await t.db.prepare("SELECT value FROM settings WHERE key = ?").bind(`lp_design_hold:${t.cityId}`).first();
    const row = await t.db.prepare("SELECT mint, pending_mint FROM city_coins WHERE city_id = ?").bind(t.cityId).first();
    const why = h && Date.parse(h.value) > t.now ? "held" : row && row.mint ? "launched" : row && row.pending_mint ? "legacy_contract" : "coin_changed";
    return refuse(409, why, NOT_WRITTEN[why]);
  }
  return null;
}
const approvalWords = (t) => (t.c.approved_hash
  ? "The owner's approval was built from the earlier version, so the launch waits until the owner approves the coin as it is now, at the next approval round."
  : "Nothing of it is on the blockchain yet.");

/* ---------------------------------------------------------------- "text" */
async function textChosen(t) {
  const { env, db, cityId, coin, c } = t;
  const d = await coinDefaults(env, cityId, coin.country);
  if (!d.ok) return refuse(d.code === "list_unavailable" ? 503 : 409, d.code, `${d.message} Nothing was changed.`);
  const ownText = c.description !== t.sentence, ownName = !(await vicinityName(t, d));
  if (!ownText && !ownName) return refuse(409, "system_text", SYSTEM_TEXT);
  let v;
  if (ownName) v = await defaultsVersion(t, d);
  else {
    const content = canonicalContent({ city: t.city, name: c.name, symbol: c.symbol, description: t.sentence, artSha256: c.art_sha256,
      templateVersion: c.content.image ? c.content.image.template : null, ...(c.content.pair ? { pair: c.content.pair } : {}) });
    const onDefaults = await db.prepare("SELECT 1 AS one FROM coin_versions WHERE city_id = ? AND origin = 'default' AND name = ? AND symbol = ? AND art_sha256 = ? LIMIT 1")
      .bind(cityId, c.name, c.symbol, c.art_sha256).first();
    v = { content, hash: await sha256Hex(content), name: c.name, symbol: c.symbol, description: t.sentence, artSha: c.art_sha256, templateVersion: c.template_version, origin: onDefaults ? "default" : "description" };
  }
  const what = ownName ? (ownText ? "coin name and description were" : "coin name was") : "description was";
  const marks = [], withdraw = ownText ? await carrying(t, c.description) : { n: 0, stmt: null };
  // the public log never names a founder's words (src/coinreview.js decideReview); a line written before that rule named the approved
  // name and ticker: they leave it now, in the same batch (the staff audit keeps them)
  const redacted = ownName ? await namedInLog(t, c) : { n: 0, stmt: null };
  if (ownText) marks.push(await takedownStatement(db, { cityId, adminId: t.actor.id, text: c.description, reason: t.reason, at: t.at }));
  if (ownName) marks.push(await takedownStatement(db, { cityId, adminId: t.actor.id, text: c.name, reason: t.reason, at: t.at, target: "name" }));
  const refused = await writeChoice(t, v, {
    before: [...marks, ...(withdraw.n ? [withdraw.stmt] : []), ...(redacted.n ? [redacted.stmt] : [])],
    log: { actorId: t.actor.id, role: "admin", action: "coin_text_removed", reason: t.reason,
      note: `${coin.city_name}: the founder's ${what} taken down (${pictureReason(t.reason)}); the coin uses Vicinity's ${ownName ? "coin for the city" : "own description"}, version ${versionLabel(v.hash)}` },
    after: [audit(t, "coins/takedown_text", `version ${c.content_hash} → ${v.hash}`)],
  });
  if (refused) return refused;
  await purgePages(env);
  const n = await notify(env, { to: c.user_id, kind: "founder", ref: cityId, href: "/dashboard#founder", now: t.now,
    text: ownName ? `Vicinity took down your coin's ${ownText ? "name and description" : "name"}: ${pictureReason(t.reason)}. Your coin is Vicinity's coin for ${d.city.name} again.`
      : `Vicinity took down your coin's description: ${pictureReason(t.reason)}. Your coin uses Vicinity's own description now.` });
  const changed = ownName
    ? [`Taken down: the founder's coin name${ownText ? " and their description" : ""}.`,
      `The coin is Vicinity's coin for ${d.city.name} again: $${v.symbol} “${v.name}”, the Vicinity design and Vicinity's own description (“${v.description}”), because the name, the ticker and the picture were reviewed together.`]
    : [`Taken down: the founder's description of $${c.symbol}.`, `The coin uses Vicinity's own sentence now (“${t.sentence}”); its name, ticker and picture stay.`];
  if (withdraw.n) changed.push(`The founder's request that carried the description was withdrawn (${withdraw.n}).`);
  if (redacted.n) changed.push(`The public log no longer names the taken-down coin name (${redacted.n} line${redacted.n === 1 ? "" : "s"}).`);
  changed.push(approvalWords(t), SPREAD, told(n, true), "If the founder sends the same words again, a person reviews them first.");
  return done(changed, { version: versionLabel(v.hash) });
}

async function textLaunched(t) {
  const { env, db, cityId, coin, c } = t;
  const lp = await lpRow(db, coin.mint);
  if (c.description === t.sentence) {
    // nothing of the founder's: but a JSON that still carries another description (a rebuild that failed after an earlier takedown) is rebuilt
    if (lp && lp.meta_json && !String(JSON.parse(lp.meta_json).description || "").startsWith(t.sentence)) {
      if (!(await rebuildMetaJson(env, coin.mint, t.now))) return refuse(503, "unavailable", "The coin's metadata couldn't be rebuilt just now. Nothing was changed. Try again in a minute.");
      await purgePages(env, coin.mint);
      return done([`The coin's metadata (/coin-meta/${coin.mint}.json) carried another description than the coin; it was rebuilt with Vicinity's own sentence (“${t.sentence}”).`]);
    }
    return refuse(409, "system_text", SYSTEM_TEXT_LAUNCHED);
  }
  if (!lp || !lp.name || !lp.symbol) return refuse(503, "unavailable", "The launched coin's record couldn't be read just now. Nothing was changed. Try again in a minute.");
  const md = { name: lp.name, symbol: lp.symbol };
  const published = await versionForCoin(env, { cityId, mint: coin.mint, name: md.name, symbol: md.symbol }); // the JSON is the version's
  const content = canonicalContent({ city: t.city, name: c.name, symbol: c.symbol, description: t.sentence, artSha256: c.art_sha256,
    templateVersion: c.content.image ? c.content.image.template : null, ...(c.content.pair ? { pair: c.content.pair } : {}) });
  const hash = await sha256Hex(content);
  const meta = published ? JSON.stringify(versionJson(lp, md, { ...c, description: t.sentence, content: JSON.parse(content) })) : null;
  const withdraw = await carrying(t, c.description);
  try {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
        VALUES (?, 'takedown', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(cityId, content, hash, c.name, c.symbol, t.sentence, c.art_sha256, c.template_version, t.actor.id, t.at),
      db.prepare("UPDATE coin_ready SET version_id = (SELECT id FROM coin_versions WHERE city_id = ? AND content_hash = ?), content_hash = ? WHERE city_id = ? AND mint = ? AND version_id = ?")
        .bind(cityId, hash, hash, cityId, coin.mint, c.version_id),
      // every page reads the design row (src/coins.js coinView, src/launchpad.js); the JSON the batch's version builds
      db.prepare("UPDATE city_coins SET pitch = ?, updated_at = ? WHERE city_id = ? AND mint = ?").bind(t.sentence, t.at, cityId, coin.mint),
      ...(meta ? [db.prepare("UPDATE lp_coins SET meta_json = ?, meta_at = ? WHERE mint = ?").bind(meta, t.at, coin.mint)] : []),
      await takedownStatement(db, { cityId, adminId: t.actor.id, text: c.description, reason: t.reason, at: t.at }),
      ...(withdraw.n ? [withdraw.stmt] : []),
      modLog(t, "coin_text_removed", `the founder's description was taken down (${pictureReason(t.reason)}); the launched coin and its metadata use Vicinity's own description`),
      audit(t, "coins/takedown_text", `launched ${coin.mint} · version ${c.content_hash} → ${hash}`),
      guard(db, "EXISTS (SELECT 1 FROM coin_ready WHERE city_id = ? AND mint = ? AND content_hash = ?)", [cityId, coin.mint, hash]),
    ]);
  } catch (e) { if (guardFailed(e)) return refuse(409, "coin_changed", NOT_WRITTEN.coin_changed); throw e; }
  // the older JSON (a coin whose version was not what it published): rebuilt from the design row now (src/lpcoins.js)
  if (!meta && !(await rebuildMetaJson(env, coin.mint, t.now))) {
    await purgePages(env, coin.mint);
    return refuse(503, "unavailable", `The founder's description is gone from the site's pages, but the coin's metadata (/coin-meta/${coin.mint}.json) couldn't be rebuilt just now. Take it down again in a minute to finish.`);
  }
  await purgePages(env, coin.mint);
  const n = await notify(env, { to: c.user_id, kind: "founder", ref: cityId, href: "/dashboard#founder", now: t.now,
    text: `Vicinity took down your coin's description: ${pictureReason(t.reason)}. Your coin and its metadata use Vicinity's own description now.` });
  return done([
    `Taken down: the founder's description of $${c.symbol}.`,
    `The coin's page, the Launchpad and its metadata (/coin-meta/${coin.mint}.json, what wallets and Jupiter read) show Vicinity's own sentence now: “${t.sentence}”`,
    `The coin's name “${c.name}” and ticker $${c.symbol} stay: they are on the blockchain for good.`,
    "Wallets and apps that read the metadata in the last hour may show the old description until they read it again.", SPREAD, told(n),
  ], { version: versionLabel(hash) });
}
async function lpRow(db, mint) {
  try { return await db.prepare("SELECT * FROM lp_coins WHERE mint = ?").bind(mint).first(); } catch (e) { if (noTable(e)) return null; throw e; }
}

/* ---------------------------------------------------------------- "art" */
const artDelete = (db, sha) => db.prepare(`DELETE FROM coin_art WHERE sha256 = ? AND template_version = 'upload'
    AND NOT EXISTS (SELECT 1 FROM coin_ready r JOIN coin_versions v ON v.id = r.version_id WHERE r.mint IS NOT NULL AND v.art_sha256 = ?)`).bind(sha, sha);

async function artChosen(t, sha) {
  const { env, db, cityId, coin, c } = t;
  const all = await unboundUploads(db, cityId);
  const gone = sha == null ? all : all.filter((x) => x === sha);
  if (!gone.length) return refuse(404, "not_found", NO_ART);
  const inUse = gone.includes(c.art_sha256);
  const deletes = gone.map((x) => artDelete(db, x));
  let d = null, v = null;
  if (inUse) {
    d = await coinDefaults(env, cityId, coin.country);
    if (!d.ok) return refuse(d.code === "list_unavailable" ? 503 : 409, d.code, `${d.message} Nothing was changed.`);
    v = await defaultsVersion(t, d);
    const refused = await writeChoice(t, v, { before: deletes,
      log: { actorId: t.actor.id, role: "admin", action: "coin_art_removed", reason: t.reason,
        note: `${coin.city_name}: the founder's own picture was taken down (${pictureReason(t.reason)}); the coin uses Vicinity's coin for the city, version ${versionLabel(v.hash)}` },
      after: [audit(t, "coins/takedown_art", `${gone.join(", ")} · version ${c.content_hash} → ${v.hash}`)] });
    if (refused) return refused;
  } else {
    await db.batch([...deletes, modLog(t, "coin_art_removed", `a picture of the founder's own was taken down (${pictureReason(t.reason)}); the coin does not use it`),
      audit(t, "coins/takedown_art", gone.join(", "))]);
  }
  await purgePages(env, null, gone);
  const n = await notify(env, { to: c.user_id, kind: "picture", ref: cityId, href: "/dashboard#founder", now: t.now,
    text: `Your coin picture was taken down: ${pictureReason(t.reason)}.${inUse ? ` Your coin is Vicinity's coin for ${d.city.name} again.` : ""}` });
  const changed = [`Taken down: ${gone.length === 1 ? "the founder's own picture" : `${gone.length} pictures of the founder's own`} (${gone.map(artPath).join(", ")}). ${gone.length === 1 ? "Its address answers" : "Their addresses answer"} “not found” now; browsers keep a copy at most 5 minutes.`];
  if (inUse) changed.push(`The coin used it, so it is Vicinity's coin for ${d.city.name} again: $${v.symbol} “${v.name}”, the Vicinity design and Vicinity's own description, because the name, the ticker and the picture were reviewed together.`, approvalWords(t));
  else changed.push("The coin does not use it: nothing else changed.");
  changed.push(SPREAD, told(n));
  return done(changed, inUse ? { version: versionLabel(v.hash) } : {});
}

async function artLaunched(t, sha) {
  const { env, db, cityId, coin, c } = t;
  const bound = await artBytes(db, c.art_sha256);
  const takeBound = Boolean(bound && bound.upload) && (sha == null || sha === c.art_sha256);
  const others = (await unboundUploads(db, cityId)).filter((x) => sha == null || x === sha);
  if (!takeBound && !others.length) return refuse(404, "not_found", NO_ART);
  const stmts = others.map((x) => artDelete(db, x));
  let newArt = null, hash = null, meta = null;
  if (takeBound) {
    const lp = await lpRow(db, coin.mint);
    if (!lp || !lp.name || !lp.symbol) return refuse(503, "unavailable", "The launched coin's record couldn't be read just now. Nothing was changed. Try again in a minute.");
    const md = { name: lp.name, symbol: lp.symbol };
    const published = await versionForCoin(env, { cityId, mint: coin.mint, name: md.name, symbol: md.symbol });
    // the Vicinity design of the coin's own ticker and name (what its launch would have shown without the upload), drawn once
    const svg = coinSvg({ ticker: c.symbol, city: c.name, templateVersion: TEMPLATE_VERSION }), svgSha = await sha256Hex(svg);
    const known = await artBySvg(db, svgSha, TEMPLATE_VERSION, { fresh: true });
    if (known) newArt = known.sha256;
    else {
      const png = await renderPng(svg);
      newArt = await sha256Hex(png);
      stmts.push(storeArtStatement(db, { sha256: newArt, svgSha256: svgSha, templateVersion: TEMPLATE_VERSION, bytes: png, now: t.now }));
    }
    const content = canonicalContent({ city: t.city, name: c.name, symbol: c.symbol, description: c.description, artSha256: newArt, templateVersion: TEMPLATE_VERSION,
      ...(c.content.pair ? { pair: c.content.pair } : {}) });
    hash = await sha256Hex(content);
    if (published) meta = JSON.stringify(versionJson(lp, md, { ...c, art_sha256: newArt, content: JSON.parse(content) }));
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_by, created_at)
        VALUES (?, 'takedown', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(cityId, content, hash, c.name, c.symbol, c.description, newArt, TEMPLATE_VERSION, t.actor.id, t.at),
      db.prepare("UPDATE coin_ready SET version_id = (SELECT id FROM coin_versions WHERE city_id = ? AND content_hash = ?), content_hash = ? WHERE city_id = ? AND mint = ? AND version_id = ?")
        .bind(cityId, hash, hash, cityId, coin.mint, c.version_id),
      ...(meta ? [db.prepare("UPDATE lp_coins SET meta_json = ?, meta_at = ? WHERE mint = ?").bind(meta, t.at, coin.mint)] : []),
      artDelete(db, c.art_sha256), // no launched coin carries it any more (the binding moved above, in this batch)
      guard(db, "EXISTS (SELECT 1 FROM coin_ready WHERE city_id = ? AND mint = ? AND content_hash = ?)", [cityId, coin.mint, hash]),
    );
  }
  const gone = [...(takeBound ? [c.art_sha256] : []), ...others];
  stmts.push(modLog(t, "coin_art_removed", takeBound ? `the founder's own picture was taken down (${pictureReason(t.reason)}); the launched coin and its metadata use the Vicinity design`
    : `a picture of the founder's own was taken down (${pictureReason(t.reason)}); the coin does not use it`), audit(t, "coins/takedown_art", `launched ${coin.mint} · ${gone.join(", ")}${hash ? ` · version ${c.content_hash} → ${hash}` : ""}`));
  try { await db.batch(stmts); } catch (e) { if (guardFailed(e)) return refuse(409, "coin_changed", NOT_WRITTEN.coin_changed); throw e; }
  if (takeBound && !meta) await rebuildMetaJson(env, coin.mint, t.now).catch(() => false);
  await purgePages(env, coin.mint, gone);
  const n = await notify(env, { to: c.user_id, kind: "picture", ref: cityId, href: "/dashboard#founder", now: t.now,
    text: `Your coin picture was taken down: ${pictureReason(t.reason)}.${takeBound ? " Your coin and its metadata show the Vicinity design now." : ""}` });
  const changed = takeBound
    ? [`Taken down: the founder's own picture of $${c.symbol} (${artPath(c.art_sha256)}): its address answers “not found” now.`,
      `The coin's metadata (/coin-meta/${coin.mint}.json) and /coin-meta/${coin.mint}.png show the Vicinity design of $${c.symbol} “${c.name}” instead (${artPath(newArt)}).`,
      "Wallets, explorers and browsers that copied the old picture may keep showing it until they refresh: once the coin launched it was served as permanent.",
      "The coin's name, ticker and description stay."]
    : [`Taken down: ${others.length === 1 ? "a picture" : `${others.length} pictures`} of the founder's own the coin does not use (${others.map(artPath).join(", ")}): “not found” now.`];
  if (takeBound && others.length) changed.push(`Also taken down: ${others.map(artPath).join(", ")}, which the coin does not use.`);
  changed.push(SPREAD, told(n));
  return done(changed, hash ? { version: versionLabel(hash) } : {});
}
