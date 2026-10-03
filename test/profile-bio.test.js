// The bio: 100 characters on the Vicinity pass. The rules (src/profile-core.js cleanBio), the route (POST /api/me/bio) with its
// daily limit, and what happens to a bio that people report (report, moderator's queue, clearing it, the public audit).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { HOUR, IN_NYC, IN_UTICA, MINT, advance, browser, clock, loginBody, realClock, reprove, setHolding, useClock, wallet } from "./helpers/world.js";
import { PF, crowd, expectStatus, one, pfPerson, rows } from "./helpers/profiles.js";
import { slowDb } from "./helpers/slowdb.js";
import { MAX_BIO, cleanBio } from "../src/profile-core.js";

beforeEach(() => useClock("2026-10-01T12:00:00Z"));
after(() => realClock());

// Characters that must not be typed into this file as they are: built from their numbers.
const ch = (...codes) => String.fromCodePoint(...codes);
const fullwidth = (s) => [...s].map((c) => (c >= "!" && c <= "~" ? ch(c.codePointAt(0) + 0xfee0) : c)).join("");
const ADDRESS = MINT; // a real-looking 44-character Solana address
/** Plain words of exactly n characters (a run of letters is never longer than five, so it cannot pass for an address). */
const words = (n) => Array.from({ length: n }, (_, i) => (i % 6 === 5 ? " " : "a")).join("");

/* ---------------- the rules ---------------- */

test("a good bio comes back as typed (trimmed), and it may be empty", () => {
  for (const good of [
    "Utica born, Syracuse raised", "Hodling since 2021", "Top 10 holder", "10M bag, no sell", "Coffee, bikes and local memes!",
    "I love this city (and its bagels)", "v1.2 of me", "e.g. a fan", "Dr. Who fan", "wow...really?", "A1", "x", "Ünïcödé fine", "Rock 'n' roll, 100%", "$VICINITY to the moon",
    "Call me maybe 1 2 3", "est. 2019", "No.1 fan", "Born in the 90s", "2 + 2 = 4",
  ]) assert.deepEqual(cleanBio(good), { ok: true, bio: good }, good);
  assert.deepEqual(cleanBio("  padded  "), { ok: true, bio: "padded" });
  assert.deepEqual(cleanBio(""), { ok: true, bio: "" });
  assert.deepEqual(cleanBio("   \n\t  "), { ok: true, bio: "" }, "only blanks clears it");
});

test("100 characters are counted as Unicode code points: an emoji is one, 100 fit and 101 do not", () => {
  assert.equal(MAX_BIO, 100);
  const smile = ch(0x1f600);
  assert.equal(words(100).length, 100);
  assert.equal(cleanBio(words(100)).ok, true);
  assert.equal(cleanBio(words(101)).error, "bio_too_long");
  assert.equal(cleanBio(smile.repeat(100)).ok, true, "100 emoji (200 UTF-16 units) are 100 characters");
  assert.equal(cleanBio(smile.repeat(101)).error, "bio_too_long");
  assert.equal(cleanBio(words(99) + smile).ok, true);
  assert.equal(cleanBio(words(100) + smile).error, "bio_too_long");
  // é typed as e + a combining accent is the same one character as the single é
  const decomposed = "e" + ch(0x301);
  assert.equal(cleanBio(decomposed.repeat(100)).ok, true);
  assert.equal(cleanBio(decomposed.repeat(100)).bio, ch(0xe9).repeat(100), "stored in normal form");
  assert.equal(cleanBio("a".repeat(5000)).error, "bio_too_long", "an enormous text is refused cheaply");
  // too long wins over everything else (it is the easiest thing to fix first)
  assert.equal(cleanBio("https://x.com " + words(100)).error, "bio_too_long");
});

test("one line: line breaks and tabs become one space, runs of spaces become one, control and invisible characters are gone", () => {
  assert.equal(cleanBio("line one\nline two\r\nline three\ttabbed").bio, "line one line two line three tabbed");
  assert.equal(cleanBio("a\n\n\n\nb").bio, "a b");
  assert.equal(cleanBio("a      b").bio, "a b");
  assert.equal(cleanBio("a" + ch(0, 7, 27, 127) + "b").bio, "ab", "control characters");
  assert.equal(cleanBio("a" + ch(0x2028, 0x2029, 0x85) + "b").bio, "a b", "other line separators");
  assert.equal(cleanBio("a" + ch(0x200b, 0x200c, 0x2060, 0xfeff, 0xad, 0x180e) + "b").bio, "ab", "zero-width characters");
  assert.equal(cleanBio(ch(0x200b) + ch(0x200b)).bio, "", "nothing but invisible characters is empty");
  // a family emoji is joined with zero-width JOINERS: those stay, it is still one picture
  const family = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  assert.equal(cleanBio(family).bio, family);
});

test("no links, in any of the usual disguises", () => {
  for (const link of [
    "see https://example.com", "http://a.b", "HTTPS://EXAMPLE.COM", "ftp://files.test", "wss://x.y", "www.example", "WWW . example", "go to //evil", "vicinity.city", "t.me/abc", "bit.ly/x",
    "linktr.ee/me", "my site: example.com/me", "mail: foo.io", "see EXAMPLE.ORG now", "sub.domain.example.net", "vicinity [dot] city", "vicinity (dot) city", "vicinity dot city", "find me on discord.gg/x",
    fullwidth("www.example.com"), "example" + ch(0x3002) + "com", "example" + ch(0xff0e) + "com", "example" + ch(0x2024) + "com", "https" + ch(0xff1a) + ch(0xff0f) + ch(0xff0f) + "x.y",
  ]) assert.deepEqual(cleanBio(link), { ok: false, error: "bio_not_allowed" }, link);
});

test("no e-mail addresses, in any of the usual disguises", () => {
  for (const mail of ["me@example.com", "write to me@x", "ME@EXAMPLE.COM", "me (at) example.com", "me [at] example dot com", "me at example dot com", "a.b+c@d.e", fullwidth("me@example.com"), "me" + ch(0xff20) + "example"])
    assert.deepEqual(cleanBio(mail), { ok: false, error: "bio_not_allowed" }, mail);
  assert.equal(cleanBio("hello @vicinity fan").ok, true, "a mention is not an e-mail address");
  assert.equal(cleanBio("@alice").ok, true);
});

test("no phone numbers: seven or more digits, with or without separators, any digit script", () => {
  for (const phone of ["+1 555 123 4567", "555-123-4567", "(555) 123.4567", "15551234567", "+44 20 7946 0958", "5551234", "call 555 1234 now", fullwidth("5551234567"),
    ch(0x660, 0x665, 0x665, 0x665, 0x661, 0x662, 0x663, 0x664, 0x665, 0x666, 0x667)])
    assert.deepEqual(cleanBio(phone), { ok: false, error: "bio_not_allowed" }, phone);
  for (const fine of ["Born in 1990", "2021 and 2022", "123456", "12 34 5", "Since 2020, 5 years", "420.69", "Top 100 of 1,000"]) assert.equal(cleanBio(fine).ok, true, fine);
});

test("no wallet addresses of any chain, alone or inside a sentence", () => {
  const eth = "0x" + "ab12".repeat(10);
  for (const address of [ADDRESS, "send to " + ADDRESS + " now", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA8", eth, "gm " + eth, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "A".repeat(26), fullwidth(ADDRESS)])
    assert.deepEqual(cleanBio(address), { ok: false, error: "bio_not_allowed" }, address);
  assert.equal(cleanBio("Supercalifragilistic is 20").ok, true, "a long word is not an address");
});

test("text that reads backwards, piles of stacked accents and broken characters are refused", () => {
  assert.equal(cleanBio("safe " + ch(0x202e) + "txet").error, "bio_not_allowed", "right-to-left override");
  for (const bidi of [0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x61c]) assert.equal(cleanBio("a" + ch(bidi) + "b").error, "bio_not_allowed", bidi.toString(16));
  assert.equal(cleanBio("z" + ch(0x300, 0x301, 0x302, 0x303, 0x304)).error, "bio_not_allowed", "five accents stacked");
  assert.equal(cleanBio("z" + ch(0x300, 0x301, 0x302)).ok, true, "a few are normal (and the real accents of many scripts)");
  assert.equal(cleanBio("ab" + String.fromCharCode(0xd800) + "cd").error, "bio_not_allowed", "a lone half of an emoji");
  assert.equal(cleanBio(String.fromCharCode(0xdc00) + "x").error, "bio_not_allowed");
});

test("anything that is not text is a bad request", () => {
  for (const v of [undefined, null, 5, true, {}, [], ["a"]]) assert.deepEqual(cleanBio(v), { ok: false, error: "bad_request" }, JSON.stringify(v));
});

/* ---------------- the route ---------------- */

test("set it, see it on your pass and on your profile, change it, clear it", async () => {
  const env = PF();
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA }), b = await pfPerson(env, "BobBrave", { home: IN_UTICA });
  assert.equal((await a.get("/api/me?lite=1")).user.bio, "", "no bio yet: an empty text");
  let r = await a.post("/api/me/bio", { bio: "  Utica born, Syracuse raised \n " });
  assert.deepEqual(r, { ok: true, bio: "Utica born, Syracuse raised" });
  assert.equal((await a.get("/api/me")).user.bio, "Utica born, Syracuse raised");
  assert.equal((await a.get("/api/me?lite=1")).user.bio, "Utica born, Syracuse raised");
  assert.equal((await b.get("/api/profile?u=alice77")).profile.bio, "Utica born, Syracuse raised");
  assert.equal((await a.get("/api/profile")).profile.bio, "Utica born, Syracuse raised", "your own profile too");
  assert.equal((await one(env.DB, "SELECT bio FROM users WHERE handle = 'Alice77'")).bio, "Utica born, Syracuse raised");

  assert.equal((await a.post("/api/me/bio", { bio: "Now with emoji " + ch(0x1f3d9) })).bio, "Now with emoji " + ch(0x1f3d9));
  r = await a.post("/api/me/bio", { bio: "" });
  assert.deepEqual(r, { ok: true, bio: "" });
  assert.equal((await one(env.DB, "SELECT bio FROM users WHERE handle = 'Alice77'")).bio, null, "cleared means nothing is stored");
  assert.equal((await b.get("/api/profile?u=Alice77")).profile.bio, "");
  assert.equal((await a.get("/api/me")).user.bio, "");
});

test("refusals: signed out, from another site, not JSON, not text, too long, not allowed (each with its own plain code)", async () => {
  const env = PF();
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA });
  const out = browser(env);
  await expectStatus(await out.send("/api/me/bio", { method: "POST", body: { bio: "hi" } }), 401, "sign_in");
  await expectStatus(await a.send("/api/me/bio", { method: "POST", body: { bio: "hi" }, origin: "https://evil.example" }), 403, "wrong_origin");
  await expectStatus(await a.send("/api/me/bio", { method: "POST" }), 400, "bad_request");
  for (const bio of [undefined, null, 5, {}, []]) await expectStatus(await a.send("/api/me/bio", { method: "POST", body: { bio } }), 400, "bad_request");
  await expectStatus(await a.send("/api/me/bio", { method: "POST", body: { bio: "x".repeat(101) } }), 400, "bio_too_long");
  for (const bio of ["https://x.com", ADDRESS, "me@x.com", "555 123 4567"]) await expectStatus(await a.send("/api/me/bio", { method: "POST", body: { bio } }), 400, "bio_not_allowed");
  assert.equal((await one(env.DB, "SELECT bio FROM users WHERE handle = 'Alice77'")).bio, null, "nothing was saved");
  // a wallet that is proven but has no account yet is not a member
  const pending = browser(env);
  await pending.post("/api/auth/wallet", await loginBody(await wallet()));
  await expectStatus(await pending.send("/api/me/bio", { method: "POST", body: { bio: "hi" } }), 401, "sign_in");
});

test("a test-lab row is not a member: it gets the same answer as a signed-out visitor", async () => {
  const env = PF();
  const lab = await pfPerson(env, "Labby", { home: IN_UTICA });
  await env.DB.prepare("UPDATE users SET provider = 'testlab' WHERE handle = 'Labby'").run();
  await expectStatus(await lab.send("/api/me/bio", { method: "POST", body: { bio: "hi" } }), 401, "sign_in");
  await expectStatus(await lab.send("/api/profile?u=Labby"), 401, "sign_in");
});

test("10 changes a day: the 11th is slow_down, the window opens again after 24 hours, and everyone has their own count", async () => {
  const env = PF();
  const [a, b] = await crowd(env, ["Alice77", "BobBrave"]);
  for (let i = 1; i <= 10; i++) assert.equal((await a.post("/api/me/bio", { bio: "version " + i })).ok, true, "change " + i);
  await expectStatus(await a.send("/api/me/bio", { method: "POST", body: { bio: "version 11" } }), 429, "slow_down");
  assert.equal((await a.get("/api/me")).user.bio, "version 10", "the refused one changed nothing");
  assert.equal((await b.post("/api/me/bio", { bio: "mine" })).ok, true, "somebody else is not held back");
  advance(23 * HOUR);
  await expectStatus(await a.send("/api/me/bio", { method: "POST", body: { bio: "still no" } }), 429, "slow_down");
  advance(HOUR + 1000);
  assert.equal((await a.post("/api/me/bio", { bio: "a new day" })).ok, true);
});

test("saving the same bio again changes nothing and does not use up one of the 10; a refused bio does not either", async () => {
  const env = PF();
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA });
  assert.equal((await a.post("/api/me/bio", { bio: "same" })).ok, true);
  for (let i = 0; i < 30; i++) assert.deepEqual(await a.post("/api/me/bio", { bio: "  same\n" }), { ok: true, bio: "same" });
  for (let i = 0; i < 30; i++) assert.equal((await a.send("/api/me/bio", { method: "POST", body: { bio: "https://spam.example" } })).status, 400);
  for (let i = 2; i <= 10; i++) assert.equal((await a.post("/api/me/bio", { bio: "version " + i })).ok, true, "all nine remaining changes are still there: " + i);
  assert.equal((await a.send("/api/me/bio", { method: "POST", body: { bio: "version 11" } })).status, 429);
});

test("parallel changes: exactly 10 get through, and what is stored is one of those texts", async () => {
  const env = PF();
  env.DB = slowDb(env.DB); // answers a little later than the code runs, like the real one, so the requests really overlap
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA });
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => a.send("/api/me/bio", { method: "POST", body: { bio: "text " + i } }).then((r) => r.status)));
  assert.equal(rs.filter((s) => s === 200).length, 10);
  assert.equal(rs.filter((s) => s === 429).length, 6);
  assert.match((await one(env.DB, "SELECT bio FROM users WHERE handle = 'Alice77'")).bio, /^text \d+$/);
});

test("a bio is public text: markup is kept as plain text (the pages show it as text) and never executed or changed", async () => {
  const env = PF();
  const [a, b] = await crowd(env, ["Alice77", "BobBrave"]);
  const html = "<b>bold</b> & <script>x</script> \"q\" 'q'";
  assert.equal((await a.post("/api/me/bio", { bio: html })).bio, html);
  const res = await b.send("/api/profile?u=Alice77");
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await res.json()).profile.bio, html);
});

/* ---------------- reports and moderation ---------------- */

/** A member with an ACTIVE founder seat in Utica who holds enough to keep it (so the live check passes). */
async function founderOfUtica(env, handle) {
  const p = await pfPerson(env, handle, { home: IN_UTICA });
  const uid = (await one(env.DB, "SELECT id FROM users WHERE handle = ?", handle)).id;
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES ('5142056', 'Utica', 'US', ?, ?, 5, 1, 'active', ?, ?)")
    .bind(uid, p.w.address, new Date(clock.now).toISOString(), new Date(clock.now).toISOString()).run();
  setHolding(p.w.address, 10);
  return p;
}
const launched = (extra = {}) => PF({ VICINITY_MINT: MINT, ...extra });

test("report a bio: one report per member, not your own, not one that is empty, not a member who is not there; 30 a day", async () => {
  const env = PF();
  const [a, b, c] = await crowd(env, ["Alice77", "BobBrave", "CarolCalm"]);
  await expectStatus(await b.send("/api/profile/report", { method: "POST", body: { handle: "Alice77", reason: "spam" } }), 409, "no_bio");
  await a.post("/api/me/bio", { bio: "Buy my course" });
  await expectStatus(await a.send("/api/profile/report", { method: "POST", body: { handle: "alice77" } }), 400, "self");
  await expectStatus(await b.send("/api/profile/report", { method: "POST", body: { handle: "Nobody" } }), 404, "not_found");
  await expectStatus(await b.send("/api/profile/report", { method: "POST", body: {} }), 400, "bad_request");
  await expectStatus(await b.send("/api/profile/report", { method: "POST", body: { handle: "alice77", reason: "spam" } }), 200);
  await expectStatus(await b.send("/api/profile/report", { method: "POST", body: { handle: "ALICE77", reason: "again" } }), 200);
  await c.post("/api/profile/report", { handle: "Alice77" });
  const reports = await rows(env.DB, "SELECT reason FROM profile_reports ORDER BY reporter_id");
  assert.equal(reports.length, 2, "b reported twice and counts once");
  assert.equal(reports[0].reason, "spam", "the first reason stays");
  // 30 a day (counted before the work, so refused ones count as well)
  for (let i = 0; i < 28; i++) await b.post("/api/profile/report", { handle: "Alice77" });
  await expectStatus(await b.send("/api/profile/report", { method: "POST", body: { handle: "Alice77" } }), 429, "slow_down");
  assert.equal((await a.get("/api/profile")).profile.bio, "Buy my course", "reports alone never remove a bio");
});

test("reports are about a text: when the member writes a new bio the reports are gone, and the same text typed again keeps them", async () => {
  const env = PF();
  const [a, b, c] = await crowd(env, ["Alice77", "BobBrave", "CarolCalm"]);
  await a.post("/api/me/bio", { bio: "Buy my course" });
  await b.post("/api/profile/report", { handle: "Alice77" }); await c.post("/api/profile/report", { handle: "Alice77" });
  assert.equal((await rows(env.DB, "SELECT * FROM profile_reports")).length, 2);
  await a.post("/api/me/bio", { bio: " Buy my course " }); // the same text: nothing changed
  assert.equal((await rows(env.DB, "SELECT * FROM profile_reports")).length, 2);
  await a.post("/api/me/bio", { bio: "Coffee and bikes" });
  assert.equal((await rows(env.DB, "SELECT * FROM profile_reports")).length, 0, "a new text, a clean slate");
  assert.equal((await b.post("/api/profile/report", { handle: "Alice77" })).ok, true, "and it can be reported again");
});

test("the moderator's queue lists reported bios in the moderator's own area only (admin everywhere, manager their country, founder their city)", async () => {
  const env = launched();
  const [near, far, reporter1, reporter2] = await Promise.all([pfPerson(env, "NearNed", { home: IN_UTICA }), pfPerson(env, "FarFiona", { home: IN_NYC }), pfPerson(env, "R1", { home: IN_UTICA }), pfPerson(env, "R2", { home: IN_NYC })]);
  const founder = await founderOfUtica(env, "FounderFay");
  const admin = await pfPerson(env, "AdminAl", { home: IN_NYC });
  env.ADMIN_WALLETS = admin.w.address;
  await near.post("/api/me/bio", { bio: "near bio" }); await far.post("/api/me/bio", { bio: "far bio" });
  for (const r of [reporter1, reporter2]) { await r.post("/api/profile/report", { handle: "NearNed" }); await r.post("/api/profile/report", { handle: "FarFiona", reason: "scam" }); }
  await reporter1.post("/api/profile/report", { handle: "FarFiona" });

  await reprove(founder); await reprove(admin);
  const f = await founder.get("/api/mod");
  assert.equal(f.moderator, true);
  assert.deepEqual(f.bios.map((x) => [x.handle, x.bio, x.reports]), [["NearNed", "near bio", 2]], "the founder of Utica sees Utica only");
  const a = await admin.get("/api/mod");
  assert.deepEqual(a.bios.map((x) => [x.handle, x.reports]).sort(), [["FarFiona", 2], ["NearNed", 2]]);
  assert.deepEqual(Object.keys(a.bios[0]).sort(), ["bio", "handle", "lastAt", "reports"], "no id, wallet or reporter");
  assert.equal((await near.get("/api/mod")).moderator, false);
});

test("clearing a bio: needs a moderator in scope, a fresh proof and a reason; it is logged in the open and the reports are cleared", async () => {
  const env = launched();
  const [near, far, outsider] = await Promise.all([pfPerson(env, "NearNed", { home: IN_UTICA }), pfPerson(env, "FarFiona", { home: IN_NYC }), pfPerson(env, "Outsider", { home: IN_UTICA })]);
  const founder = await founderOfUtica(env, "FounderFay");
  const admin = await pfPerson(env, "AdminAl", { home: IN_NYC });
  env.ADMIN_WALLETS = admin.w.address;
  await near.post("/api/me/bio", { bio: "secret sauce here" }); await far.post("/api/me/bio", { bio: "far bio" });
  await outsider.post("/api/profile/report", { handle: "NearNed", reason: "abuse" });
  const call = (who, body) => who.send("/api/mod/bio/clear", { method: "POST", body });

  await expectStatus(await call(browser(env), { handle: "NearNed", reason: "spam" }), 401, "sign_in");
  advance(40 * 60_000); // the wallet proofs of the sign-ins are older than 30 minutes now
  await expectStatus(await call(outsider, { handle: "NearNed", reason: "spam" }), 403, "reprove");
  await reprove(outsider);
  await expectStatus(await call(outsider, { handle: "NearNed", reason: "spam" }), 403, "not_allowed");
  await reprove(founder);
  await expectStatus(await call(founder, { handle: "FarFiona", reason: "spam" }), 403, "not_allowed");
  await expectStatus(await call(founder, { handle: "Nobody", reason: "spam" }), 404, "not_found");
  await expectStatus(await call(founder, {}), 400, "bad_request");
  await expectStatus(await call(founder, { handle: "NearNed" }), 400, "reason_required");
  await expectStatus(await call(founder, { handle: "NearNed", reason: "because" }), 400, "reason_required");
  await expectStatus(await call(founder, { handle: "Outsider", reason: "spam" }), 409, "no_bio");
  await expectStatus(await call(founder, { handle: "FounderFay", reason: "spam" }), 400, "own_profile");
  assert.equal((await one(env.DB, "SELECT bio FROM users WHERE handle = 'NearNed'")).bio, "secret sauce here", "nothing happened so far");

  const done = await expectStatus(await call(founder, { handle: "nearned", reason: "scam", note: "sells a course" }), 200);
  assert.deepEqual(done, { ok: true, cleared: true });
  assert.equal((await one(env.DB, "SELECT bio FROM users WHERE handle = 'NearNed'")).bio, null);
  assert.equal((await outsider.get("/api/profile?u=NearNed")).profile.bio, "");
  assert.equal((await rows(env.DB, "SELECT * FROM profile_reports")).length, 0, "its reports are cleared with it");
  await expectStatus(await call(founder, { handle: "NearNed", reason: "scam" }), 409, "no_bio");
  assert.deepEqual((await founder.get("/api/mod")).bios, [], "gone from the queue");

  // the admin may clear a bio anywhere, and a member can write a new one
  await reprove(admin);
  await expectStatus(await call(admin, { handle: "FarFiona", reason: "off_topic" }), 200);
  assert.equal((await near.post("/api/me/bio", { bio: "a clean bio" })).ok, true);

  // the public audit says that bios were cleared, by whom (role), and why: never whose bio it was or what it said
  const audit = await (await browser(env).send("/api/audit")).json();
  const entries = audit.actions.filter((x) => x.action === "clear_bio");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((x) => [x.target, x.reason, x.country, x.state]).sort(), [["bio", "off_topic", "US", "done"], ["bio", "scam", "US", "done"]]);
  assert.ok(entries.some((x) => x.note === "sells a course"));
  const text = JSON.stringify(audit);
  for (const secret of ["secret sauce", "far bio", "NearNed", "FarFiona", "nearned"]) assert.ok(!text.includes(secret), "the audit never names " + secret);
  const mine = (await rows(env.DB, "SELECT actor_role, target_type, target_id, target_user FROM mod_actions WHERE action = 'clear_bio' ORDER BY id")).map((x) => [x.actor_role, x.target_type, x.target_id, x.target_user !== null]);
  assert.deepEqual(mine, [["founder", "bio", null, true], ["admin", "bio", null, true]]);
});

test("a moderator clearing their own bio is refused like hiding their own post", async () => {
  const env = launched();
  const admin = await pfPerson(env, "AdminAl", { home: IN_NYC });
  env.ADMIN_WALLETS = admin.w.address;
  await admin.post("/api/me/bio", { bio: "I am the admin" });
  await reprove(admin);
  await expectStatus(await admin.send("/api/mod/bio/clear", { method: "POST", body: { handle: "AdminAl", reason: "spam" } }), 400, "own_profile");
});

test("a moderator whose founder seat is in grace cannot clear (checked live, like every moderation act)", async () => {
  const env = launched();
  const near = await pfPerson(env, "NearNed", { home: IN_UTICA });
  const founder = await founderOfUtica(env, "FounderFay");
  await near.post("/api/me/bio", { bio: "some bio" });
  setHolding(founder.w.address, 0); // sold
  await reprove(founder);
  await expectStatus(await founder.send("/api/mod/bio/clear", { method: "POST", body: { handle: "NearNed", reason: "spam" } }), 403, "in_grace");
  assert.equal((await one(env.DB, "SELECT bio FROM users WHERE handle = 'NearNed'")).bio, "some bio");
});
