// The Feedback / Support widget's server side (POST /api/feedback, src/feedback.js) and the admin console's Inbox
// (/api/admin/feedback, src/admin.js): what is accepted and refused, what is stored and what never is, the counters per
// connection, per member and for the whole site, the honeypot, and who may read and change what.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HOUR, DAY, ORIGIN, advance, browser, newWorld, person, realClock, tick, useClock, wallet, loginBody } from "./helpers/world.js";
import { handleApi } from "../src/index.js";
import { LIMITS, MESSAGE_MAX, PAGE_KEYS, RETENTION, cleanPage, coarseUa, pruneFeedback, siteMax } from "../src/feedback.js";
import { FEEDBACK_MIGRATION, MIGRATIONS } from "../src/store.js";

const PHANTOM_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Phantom/ios";
const CHROME_DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const MARKER = "ZEBRA-7741";
let env;
before(() => useClock("2026-10-09T12:00:00Z"));
after(() => realClock());
beforeEach(() => { useClock("2026-10-09T12:00:00Z"); env = newWorld(); });

/** POST /api/feedback like the widget does, from one connection (ip), optionally with a browser's User-Agent. */
async function send(b, body, { ip = "203.0.113.9", ua = CHROME_DESKTOP, origin = ORIGIN, method = "POST" } = {}) {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (ip) headers.set("cf-connecting-ip", ip);
  if (ua) headers.set("user-agent", ua);
  if (b && b.jar.size) headers.set("cookie", [...b.jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const req = new Request(ORIGIN + "/api/feedback", { method, headers, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  const res = await handleApi(req, env);
  return { status: res.status, headers: res.headers, data: await res.json() };
}
const rows = () => env.DB.prepare("SELECT * FROM feedback ORDER BY id").all().then((r) => r.results);
const tableExists = async () => Boolean(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback'").first());
const question = (message = "Where do I find my city's founder?") => ({ kind: "question", message, page: "/cities?city=5128581", website: "" });

test("the table is made on the first message, never by the migrations that run on every request", async () => {
  assert.ok(!MIGRATIONS.some((m) => m.id === FEEDBACK_MIGRATION.id), "not in MIGRATIONS (test/helpers/prod-schema.js freezes those)");
  await handleApi(new Request(ORIGIN + "/api/health"), env);
  assert.equal(await tableExists(), false, "a plain request makes no feedback table");
  const r = await send(null, question());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { ok: true }, "no row number in the answer: it would say how many messages there are, and tell a bot it was stored");
  assert.equal(await tableExists(), true);
  assert.ok(await env.DB.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(FEEDBACK_MIGRATION.id).first());
});

test("only a same-site POST: GET is 405, no Origin or a foreign one is 403, and nothing is stored", async () => {
  assert.equal((await send(null, question(), { method: "GET" })).status, 405);
  let r = await send(null, question(), { origin: null });
  assert.equal(r.status, 403); assert.equal(r.data.error, "wrong_origin");
  r = await send(null, question(), { origin: "https://evil.test" });
  assert.equal(r.status, 403); assert.equal(r.data.error, "wrong_origin");
  assert.equal(await tableExists(), false);
});

test("what is refused: broken JSON, an unknown kind, a message too short or too long, a bad e-mail, a city request without city and country", async () => {
  const bad = async (body, error) => { const r = await send(null, body); assert.equal(r.status, 400, error); assert.equal(r.data.error, error); };
  await bad('"just a string"', "bad_json");
  await bad({ ...question(), kind: "spam" }, "bad_kind");
  await bad({ ...question(), kind: undefined }, "bad_kind");
  await bad(question("hi"), "bad_message");
  await bad(question("x".repeat(MESSAGE_MAX + 1)), "bad_message");
  await bad({ ...question(), email: "not-an-address" }, "bad_email");
  await bad({ ...question(), email: "a@b.c<script>" }, "bad_email");
  await bad({ kind: "city", city: "Utica", website: "" }, "bad_city");
  await bad({ kind: "city", city: "U", country: "United States", website: "" }, "bad_city");
  await bad({ kind: "city", country: "United States", website: "" }, "bad_city");
  await bad({ kind: "city", city: "c".repeat(81), country: "United States", website: "" }, "bad_city");
  await bad({ kind: "city", city: "Utica", country: "u".repeat(61), website: "" }, "bad_city");
  // not text at all: an object or a list is refused, never stored as "[object Object]" or "one,two,three"
  await bad({ kind: "question", message: { a: 1 }, website: "" }, "bad_message");
  await bad({ kind: "question", message: ["one", "two", "three"], website: "" }, "bad_message");
  await bad({ kind: "question", message: 1234567, website: "" }, "bad_message");
  await bad({ kind: "city", city: ["Utica"], country: "United States", website: "" }, "bad_city");
  await bad({ ...question(), email: ["a@b.co"] }, "bad_email");
  assert.equal(await tableExists(), false, "nothing of that was stored (the table was not even made)");
  // the longest allowed message is fine
  const r = await send(null, question("y".repeat(MESSAGE_MAX)));
  assert.equal(r.status, 200);
  assert.equal((await rows())[0].message.length, MESSAGE_MAX);
});

test("the honeypot: a filled 'website' field is answered ok, counted nowhere and stored nowhere", async () => {
  const r = await send(null, { ...question(), website: "https://spam.example" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true }, "no id: nothing was made");
  assert.equal(await tableExists(), false);
  assert.equal(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_limits'").first(), null, "not even a counter was touched");
});

test("what is stored: the kind, message, page path and a coarse browser; the reply e-mail lower-cased; never the raw User-Agent, never another site's address", async () => {
  let r = await send(null, { ...question("The map is empty on my phone after I zoom in"), email: "  Jo.Example@Mail.COM " }, { ua: PHANTOM_IOS });
  assert.equal(r.status, 200);
  r = await send(null, { kind: "city", city: "  Little   Falls ", country: "United States", message: "", page: "https://evil.test/steal", website: "" }, { ua: CHROME_DESKTOP });
  assert.equal(r.status, 200);
  r = await send(null, { kind: "bug", message: "Buy button does nothing", page: "//evil.test", website: "" }, { ua: "" });
  assert.equal(r.status, 200);
  const all = await rows();
  assert.equal(all.length, 3);
  const [a, b, c] = all;
  assert.equal(a.kind, "question"); assert.equal(a.message, "The map is empty on my phone after I zoom in");
  assert.equal(a.email, "jo.example@mail.com"); assert.equal(a.page, "/cities?city=5128581"); assert.equal(a.user_id, null);
  assert.equal(a.status, "new"); assert.equal(a.admin_note, null); assert.equal(a.created_at, "2026-10-09T12:00:00.000Z"); assert.equal(a.updated_at, a.created_at);
  assert.equal(a.ua, "iPhone · in-app browser · Phantom app");
  assert.ok(!a.ua.includes("AppleWebKit") && a.ua.length <= 60, "coarse, never the raw header");
  assert.equal(b.kind, "city"); assert.equal(b.city, "Little Falls"); assert.equal(b.country, "United States"); assert.equal(b.message, "");
  assert.equal(b.page, null, "another site's address is dropped"); assert.equal(b.ua, "Linux · Chrome"); assert.equal(b.email, null);
  assert.equal(c.page, null); assert.equal(c.ua, null); assert.equal(c.city, null); assert.equal(c.country, null);
});

test("the page path keeps only the pathname and the keys that name a public thing: a one-time sign-in code or a looked-up wallet never reaches the table", async () => {
  const cases = [
    ["/connect?carry=K7Q2M9ZP", "/connect"], ["/locate?code=ab12cd34ef", "/locate"], ["/connect?pair=X9Y8&error=login_failed", "/connect"],
    ["/token?address=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "/token"], ["/cities?city=5128581", "/cities?city=5128581"],
    ["/coin?mint=DmsT8fDJx5KuToivsKUwFErpSWosdWHRBfNyRTugYKiw&tf=24h", "/coin?mint=DmsT8fDJx5KuToivsKUwFErpSWosdWHRBfNyRTugYKiw&tf=24h"],
  ];
  let i = 0;
  for (const [sent] of cases) assert.equal((await send(null, { ...question(), page: sent }, { ip: `203.0.113.${40 + i++}` })).status, 200);
  assert.deepEqual((await rows()).map((r) => r.page), cases.map((c) => c[1]));
  assert.ok((await rows()).every((r) => !/carry|code=|pair|address|error/.test(r.page)));
});

test("a message that reads backwards: explicit bidi controls are taken out of the message, city and country", async () => {
  assert.equal((await send(null, { kind: "bug", message: "Price shows \u202e000,1 instead of 1,000", website: "" })).status, 200);
  assert.equal((await send(null, { kind: "city", city: "\u202eacitU", country: "United\u2066 States", message: "", website: "" }, { ip: "203.0.113.5" })).status, 200);
  const [a, b] = await rows();
  assert.equal(a.message, "Price shows 000,1 instead of 1,000");
  assert.equal(b.city, "acitU"); assert.equal(b.country, "United States");
});

test("coarse browser descriptions and page paths (the helpers themselves)", () => {
  assert.equal(coarseUa(PHANTOM_IOS), "iPhone · in-app browser · Phantom app");
  assert.equal(coarseUa("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Solflare"), "Android · in-app browser · Solflare app");
  assert.equal(coarseUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
  assert.equal(coarseUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0"), "Windows · Firefox");
  assert.equal(coarseUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0"), "Mac · Edge");
  assert.equal(coarseUa(""), null); assert.equal(coarseUa(null), null);
  assert.equal(coarseUa("x".repeat(500)), "Other · Other");
  assert.equal(cleanPage("/token#buy"), "/token", "no hash: the widget never sends one");
  assert.equal(cleanPage("/coin?mint=abc"), "/coin?mint=abc");
  assert.equal(cleanPage("/connect?carry=K7Q2M9ZP"), "/connect");
  assert.equal(cleanPage("/locate?code=ab12cd34ef"), "/locate");
  assert.equal(cleanPage("/connect?pair=K7Q2&mode=login"), "/connect");
  assert.equal(cleanPage("/token?address=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), "/token");
  assert.equal(cleanPage("/launchpad?x=1&tab=upcoming&city=&u=jo#top"), "/launchpad?tab=upcoming&u=jo", "only the allowed keys, with a value, in order");
  assert.equal(cleanPage("/?"), "/");
  assert.deepEqual(PAGE_KEYS, ["city", "mint", "tf", "u", "tab", "step", "welcome"], "a public thing's name each; never address, code, carry, pair, error, claim");
  assert.equal(cleanPage("https://vicinity.city/token"), null);
  assert.equal(cleanPage("//evil.test/x"), null);
  assert.equal(cleanPage("/a b"), null);
  assert.equal(cleanPage("/x\u0000y"), null);
  assert.equal(cleanPage('/x"><script>'), null);
  assert.equal(cleanPage("/" + "p".repeat(400)).length, 200);
  assert.equal(cleanPage(42), null); assert.equal(cleanPage(undefined), null);
});

test("a signed-in member's message carries their user id (read from the session, never from the body)", async () => {
  const p = await person(env);
  const r = await send(p, { ...question("Can I move my home city?"), user_id: 999, userId: 999 });
  assert.equal(r.status, 200);
  const me = await p.get("/api/me?lite=1");
  const [row] = await rows();
  assert.equal(row.user_id, me.user.id);
  assert.notEqual(row.user_id, 999);
});

test("the message never reaches a log, whether it is stored or the database fails", async () => {
  const seen = [];
  const orig = {};
  for (const k of ["log", "error", "warn", "info", "debug"]) { orig[k] = console[k]; console[k] = (...a) => seen.push(a.map(String).join(" ")); }
  try {
    assert.equal((await send(null, question(`Secret note ${MARKER} inside`))).status, 200);
    // the same database object (the modules remember it), with one statement broken at a time
    const realPrepare = env.DB.prepare;
    const breakOn = (re) => { env.DB.prepare = (sql) => { if (re.test(sql)) throw new Error("db down, must not matter"); return realPrepare(sql); }; };
    try {
      breakOn(/INSERT INTO feedback/);
      const r = await send(null, question(`Another ${MARKER} message`), { ip: "203.0.113.10" });
      assert.equal(r.status, 503); assert.equal(r.data.error, "unavailable");
      breakOn(/INSERT INTO auth_limits/);
      const r2 = await send(null, question(`Third ${MARKER} message`), { ip: "203.0.113.11" });
      assert.equal(r2.status, 503, "a failed count refuses, it never lets everything through");
      assert.equal(r2.data.error, "unavailable");
    } finally { env.DB.prepare = realPrepare; }
  } finally { for (const k of Object.keys(orig)) console[k] = orig[k]; }
  assert.ok(seen.some((l) => /feedback count failed/.test(l)), "the count failure is logged with a short code");
  assert.ok(seen.some((l) => /feedback store failed/.test(l)), "the failure is logged with a short code");
  assert.ok(seen.every((l) => !l.includes(MARKER)), "never the message: " + seen.join(" | "));
  assert.equal((await rows()).length, 1);
});

test("counters: 5 an hour and 20 a day per connection, Retry-After says how long, another connection is unaffected", async () => {
  const ip = "198.51.100.4";
  for (let i = 0; i < LIMITS.connection.hour; i++) assert.equal((await send(null, question(), { ip })).status, 200, "message " + (i + 1));
  let r = await send(null, question(), { ip });
  assert.equal(r.status, 429); assert.equal(r.data.error, "slow_down"); assert.equal(r.headers.get("Retry-After"), String(HOUR / 1000));
  assert.equal(r.data.retryAfter, HOUR / 1000, "the wait is in the body too (the page cannot read the header through site.js api())");
  assert.equal((await send(null, question(), { ip: "198.51.100.5" })).status, 200, "a neighbour is not slowed down");
  assert.equal((await rows()).length, LIMITS.connection.hour + 1, "the refused one was not stored");
  // the day: every try counts, the refused sixth included (like the sign-up counters: no refund for a refusal), so 14 more
  // go through over the next hours and the 21st try of the day waits a day
  let tries = LIMITS.connection.hour + 1;
  for (let h = 1; tries < LIMITS.connection.day; h++) {
    advance(HOUR);
    for (let i = 0; i < LIMITS.connection.hour && tries < LIMITS.connection.day; i++, tries++) assert.equal((await send(null, question(), { ip })).status, 200, `hour ${h} message ${i + 1}`);
  }
  r = await send(null, question(), { ip });
  assert.equal(r.status, 429); assert.equal(r.headers.get("Retry-After"), String(DAY / 1000)); assert.equal(r.data.retryAfter, DAY / 1000);
  assert.equal((await rows()).length, (LIMITS.connection.day - 1) + 1, "19 stored from this connection (20 tries, one refused) plus the neighbour's one");
});

test("counters: a signed-in member gets 5 an hour whatever connection they use; visitors who are not signed in share a site-wide hourly ceiling (FEEDBACK_MAX_PER_HOUR, default 1000) that a member passes", async () => {
  const p = await person(env);
  for (let i = 0; i < LIMITS.user.hour; i++) assert.equal((await send(p, question(), { ip: `192.0.2.${10 + i}` })).status, 200, "message " + (i + 1));
  const r = await send(p, question(), { ip: "192.0.2.99" });
  assert.equal(r.status, 429, "a sixth from yet another address is refused: the member is counted too");
  // the site's ceiling: the default and the setting that raises or lowers it without a deploy
  assert.equal(LIMITS.site.hour, 1000);
  assert.equal(siteMax({}), 1000); assert.equal(siteMax({ FEEDBACK_MAX_PER_HOUR: "30" }), 30); assert.equal(siteMax({ FEEDBACK_MAX_PER_HOUR: "0" }), 1000); assert.equal(siteMax({ FEEDBACK_MAX_PER_HOUR: "x" }), 1000);
  const fresh = newWorld({ FEEDBACK_MAX_PER_HOUR: "30" }); const saved = env; env = fresh;
  try {
    let ok = 0;
    for (let i = 0; i < 30; i++) ok += (await send(null, question(), { ip: `10.0.${Math.floor(i / 5)}.${i % 5}` })).status === 200 ? 1 : 0;
    assert.equal(ok, 30);
    const over = await send(null, question(), { ip: "10.9.9.9" });
    assert.equal(over.status, 429, "the 31st of the hour from a visitor"); assert.equal(over.data.retryAfter, HOUR / 1000);
    assert.equal((await rows()).length, 30);
    // a signed-in member has their own counters and is not refused by the site's ceiling
    const member = await person(env);
    assert.equal((await send(member, question("A member's question while the site is busy"), { ip: "10.9.9.10" })).status, 200);
    assert.equal((await rows()).length, 31);
    assert.equal((await env.DB.prepare("SELECT n FROM auth_limits WHERE key = 'fb:site'").first()).n, 31, "the member's message was not counted on the site (the refused visitor's try was)");
    advance(HOUR);
    assert.equal((await send(null, question(), { ip: "10.9.9.9" })).status, 200, "the next hour");
  } finally { env = saved; }
});

test("refused tries never use up the site's allowance: 300 tries from one connection over its limit leave the next connection's first message at 200 and the site counter at 5", async () => {
  const site = async () => { const r = await env.DB.prepare("SELECT n FROM auth_limits WHERE key = 'fb:site'").first(); return r ? Number(r.n) : 0; };
  let ok = 0, refused = 0;
  for (let i = 0; i < 305; i++) { const r = await send(null, question(), { ip: "198.51.100.66" }); if (r.status === 200) ok++; else if (r.status === 429) refused++; }
  assert.equal(ok, LIMITS.connection.hour); assert.equal(refused, 300);
  assert.equal(await site(), LIMITS.connection.hour, "only the five that got through count on the site");
  const victim = await send(null, question("Honest question from someone else"), { ip: "192.0.2.77" });
  assert.equal(victim.status, 200);
  assert.equal(await site(), LIMITS.connection.hour + 1);
  // a signed-in member over their own limit, from 20 different addresses: nothing of it reaches the site counter
  const p = await person(env);
  for (let i = 0; i < 40; i++) await send(p, question(), { ip: `192.0.2.${100 + (i % 20)}` });
  assert.equal(await site(), LIMITS.connection.hour + 1, "a member's tries, allowed or refused, are not site tries");
  // and the other way round: a connection refused by the site's ceiling has still used one of its own tries (like the sign-up)
  const small = newWorld({ FEEDBACK_MAX_PER_HOUR: "2" }); const saved = env; env = small;
  try {
    for (let i = 0; i < 2; i++) assert.equal((await send(null, question(), { ip: `10.0.0.${i}` })).status, 200);
    assert.equal((await send(null, question(), { ip: "10.0.0.9" })).status, 429);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_limits WHERE key LIKE 'fbi:h:%'").first()).n, 3, "each connection has its own counter row");
  } finally { env = saved; }
});

test("retention: 30 days after an admin marked a message done its e-mail, page and browser are blanked, 180 days after the row goes; open messages and the note are kept; no table, nothing made", async () => {
  assert.deepEqual(RETENTION, { scrubDays: 30, deleteDays: 180 });
  assert.deepEqual(await pruneFeedback(env.DB, Date.now()), { skipped: "no table" });
  assert.equal(await tableExists(), false, "the job never makes the table");
  const { owner } = await staff();
  assert.equal((await send(null, { ...question("Please delete my data afterwards"), email: "keepme@example.com" }, { ip: "203.0.113.71" })).status, 200);
  assert.equal((await send(null, { ...question("Still open, keep this"), email: "open@example.com" }, { ip: "203.0.113.72" })).status, 200);
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 1, status: "done", note: "answered by mail" })).ok, true);
  advance(29 * DAY);
  let out = await tick(env);
  assert.deepEqual(out.feedback, { scrubbed: 0, deleted: 0 });
  assert.equal((await rows())[0].email, "keepme@example.com", "day 29: untouched");
  advance(2 * DAY);
  out = await tick(env);
  assert.deepEqual(out.feedback, { scrubbed: 1, deleted: 0 });
  let [a, b] = await rows();
  assert.equal(a.email, null); assert.equal(a.page, null); assert.equal(a.ua, null);
  assert.equal(a.message, "Please delete my data afterwards"); assert.equal(a.admin_note, "answered by mail"); assert.equal(a.status, "done");
  assert.equal(b.email, "open@example.com"); assert.equal(b.page, "/cities?city=5128581", "an open message keeps everything");
  assert.deepEqual((await tick(env)).feedback, { scrubbed: 0, deleted: 0 }, "nothing to do twice");
  advance(150 * DAY);
  out = await tick(env);
  assert.deepEqual(out.feedback, { scrubbed: 0, deleted: 1 });
  const left = await rows();
  assert.equal(left.length, 1); assert.equal(left[0].id, 2); assert.equal(left[0].email, "open@example.com");
});

/* ---------------- the admin Inbox ---------------- */

/** The owner (a signed-in person whose wallet is ADMIN_WALLETS), a moderator they grant, and a plain member. */
async function staff() {
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const mod = await person(env);
  const granted = await owner.post("/api/admin/roles/grant", { wallet: mod.w.address, role: "moderator" });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  const member = await person(env);
  return { owner, mod, member };
}
async function threeMessages() {
  assert.equal((await send(null, { ...question("How do founders get chosen?"), email: "ann@example.com" }, { ip: "203.0.113.1" })).status, 200);
  assert.equal((await send(null, { kind: "bug", message: "The holder table never loads on Firefox", page: "/token", website: "" }, { ip: "203.0.113.2", ua: "Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0" })).status, 200);
  assert.equal((await send(null, { kind: "city", city: "Little Falls", country: "United States", message: "", website: "" }, { ip: "203.0.113.3" })).status, 200);
}

test("the Inbox: newest first with counts, filters by status and kind, pages; the owner sees e-mails, a moderator does not; others are kept out", async () => {
  const { owner, mod, member } = await staff();
  await threeMessages();
  const d = await owner.get("/api/admin/feedback");
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.items.map((i) => [i.id, i.kind, i.status]), [[3, "city", "new"], [2, "bug", "new"], [1, "question", "new"]]);
  assert.deepEqual(d.counts, { new: 3, seen: 0, done: 0 });
  assert.equal(d.more, false);
  assert.equal(d.items[2].email, "ann@example.com");
  assert.equal(d.items[2].handle, null); assert.equal(d.items[2].user_id, null);
  assert.equal(d.items[1].ua, "Windows · Firefox"); assert.equal(d.items[1].page, "/token");
  assert.equal(d.items[0].city, "Little Falls");
  assert.deepEqual((await owner.get("/api/admin/feedback?kind=bug")).items.map((i) => i.id), [2]);
  assert.deepEqual((await owner.get("/api/admin/feedback?status=done")).items, []);
  assert.deepEqual((await owner.get("/api/admin/feedback?status=all&limit=2")).items.map((i) => i.id), [3, 2]);
  assert.equal((await owner.get("/api/admin/feedback?status=all&limit=2")).more, true);
  assert.deepEqual((await owner.get("/api/admin/feedback?status=all&limit=2&before=2")).items.map((i) => i.id), [1]);
  assert.equal((await owner.send("/api/admin/feedback?status=bogus")).status, 400);
  assert.equal((await owner.send("/api/admin/feedback?status=verylongbogusvalue")).status, 400, "an over-long value is not quietly the default");
  assert.equal((await owner.send("/api/admin/feedback?kind=bogus")).status, 400);
  assert.equal((await owner.send("/api/admin/feedback?kind=verylongbogusvalue")).status, 400);
  assert.deepEqual((await owner.get("/api/admin/feedback?status=all&before=Infinity")).items.map((i) => i.id), [3, 2, 1], "an odd 'before' reads as none");
  assert.deepEqual(await owner.get("/api/admin/feedback/count"), { ok: true, new: 3, counts: { new: 3, seen: 0, done: 0 } });
  // the moderator reads everything but the reply e-mail
  const m = await mod.get("/api/admin/feedback");
  assert.equal(m.ok, true);
  assert.equal(m.items[2].email, "(hidden)"); assert.equal(m.items[0].email, null);
  assert.equal(m.items[2].message, "How do founders get chosen?");
  // a member and a stranger
  assert.equal((await member.send("/api/admin/feedback")).status, 403);
  assert.equal((await member.send("/api/admin/feedback/count")).status, 403);
  assert.equal((await browser(env).send("/api/admin/feedback")).status, 401);
});

test("the Inbox: status and note changes need a fresh wallet proof and a same-site origin, are recorded in admin_audit without the texts, and are validated", async () => {
  const { owner, mod, member } = await staff();
  await threeMessages();
  // a signed-in member's message, so the row carries a handle
  const r0 = await send(member, question(`Please ${MARKER} call me`), { ip: "203.0.113.4" });
  assert.equal(r0.status, 200);
  let r = await owner.post("/api/admin/feedback/update", { id: 4, status: "seen" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.item.status, "seen"); assert.equal(r.item.id, 4);
  assert.equal(r.item.handle, (await member.get("/api/me?lite=1")).user.handle);
  assert.equal(r.item.updated_at, "2026-10-09T12:00:00.000Z");
  r = await owner.post("/api/admin/feedback/update", { id: 4, note: `Phoned back ${MARKER}, all fine` });
  assert.equal(r.ok, true); assert.equal(r.item.admin_note, `Phoned back ${MARKER}, all fine`); assert.equal(r.item.status, "seen", "a note alone keeps the status");
  r = await owner.post("/api/admin/feedback/update", { id: 4, status: "done", note: "" });
  assert.equal(r.ok, true); assert.equal(r.item.status, "done"); assert.equal(r.item.admin_note, null, "an empty note clears it");
  assert.deepEqual((await owner.get("/api/admin/feedback/count")).counts, { new: 3, seen: 0, done: 1 });
  assert.deepEqual((await owner.get("/api/admin/feedback")).items.map((i) => i.id), [3, 2, 1], "done ones leave the open list");
  // the moderator may change status and note too (without seeing the e-mail)
  r = await mod.post("/api/admin/feedback/update", { id: 1, status: "seen" });
  assert.equal(r.ok, true); assert.equal(r.item.email, "(hidden)");
  // validation
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 4, status: "bogus" })).error, "bad_status");
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 4 })).error, "bad_request");
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 4, note: "n".repeat(501) })).error, "bad_note");
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 999, status: "seen" })).error, "not_found");
  assert.equal((await owner.post("/api/admin/feedback/update", { status: "seen" })).error, "not_found");
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 1e400, status: "seen" })).error, "not_found");
  assert.equal((await owner.post("/api/admin/feedback/update", { id: "1; DROP TABLE feedback", status: "seen" })).error, "not_found");
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 1.5, status: "seen" })).error, "not_found");
  // who may not
  assert.equal((await member.send("/api/admin/feedback/update", { method: "POST", body: { id: 1, status: "done" } })).status, 403);
  assert.equal((await owner.send("/api/admin/feedback/update", { method: "POST", body: { id: 1, status: "done" }, origin: "https://evil.test" })).status, 403);
  advance(31 * 60_000);
  r = await owner.post("/api/admin/feedback/update", { id: 1, status: "done" });
  assert.equal(r.error, "reprove", "a wallet proof older than 30 minutes is not enough for a change");
  r = await owner.post("/api/auth/reprove", await loginBody(owner.w));
  assert.equal(r.ok, true);
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 1, status: "done" })).ok, true);
  // the audit trail: who changed what, never the message or the note
  const audit = (await owner.get("/api/admin/audit")).audit.filter((a) => a.action === "feedback/update");
  assert.deepEqual(audit.map((a) => [a.target, a.detail]).reverse(), [
    ["feedback:4", "new → seen"], ["feedback:4", "note updated"], ["feedback:4", "seen → done; note cleared"], ["feedback:1", "new → seen"], ["feedback:1", "seen → done"],
  ]);
  assert.equal(audit[0].actor, owner.w.address);
  assert.ok(audit.every((a) => !String(a.detail).includes(MARKER)));
});

test("deleting a message: an admin or the owner removes it for good with an audit row (kind and status, never the texts); a moderator may not; the texts never reach the log", async () => {
  const { owner, mod, member } = await staff();
  const admin = await person(env);
  assert.equal((await owner.post("/api/admin/roles/grant", { wallet: admin.w.address, role: "admin" })).ok, true);
  await threeMessages();
  assert.equal((await owner.post("/api/admin/feedback/update", { id: 1, status: "done" })).ok, true);
  assert.equal((await mod.send("/api/admin/feedback/delete", { method: "POST", body: { id: 1 } })).status, 403, "a moderator cannot erase");
  assert.equal((await member.send("/api/admin/feedback/delete", { method: "POST", body: { id: 1 } })).status, 403);
  assert.equal((await browser(env).send("/api/admin/feedback/delete", { method: "POST", body: { id: 1 } })).status, 401);
  assert.equal((await owner.send("/api/admin/feedback/delete")).status, 405);
  assert.deepEqual(await admin.post("/api/admin/feedback/delete", { id: 1 }), { ok: true, deleted: 1 });
  assert.deepEqual(await owner.post("/api/admin/feedback/delete", { id: 3 }), { ok: true, deleted: 3 });
  assert.equal((await owner.post("/api/admin/feedback/delete", { id: 3 })).error, "not_found", "gone");
  assert.equal((await owner.post("/api/admin/feedback/delete", { id: "x" })).error, "not_found");
  assert.equal((await owner.post("/api/admin/feedback/delete", {})).error, "not_found");
  assert.deepEqual((await rows()).map((r) => r.id), [2]);
  assert.deepEqual((await owner.get("/api/admin/feedback/count")).counts, { new: 1, seen: 0, done: 0 });
  const audit = (await owner.get("/api/admin/audit")).audit.filter((a) => a.action === "feedback/delete");
  assert.deepEqual(audit.map((a) => [a.actor, a.target, a.detail]).reverse(), [[admin.w.address, "feedback:1", "question, was done"], [owner.w.address, "feedback:3", "city, was new"]]);
  assert.ok(audit.every((a) => !/founders|Little Falls|ann@example/.test(String(a.detail))));
});
