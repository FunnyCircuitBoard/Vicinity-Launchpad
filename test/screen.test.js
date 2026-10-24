// The description screener (src/screen.js, COIN_V2_REVIEW): pure, so it is tested as a function. Every rule flags or blocks with the span
// the page highlights; the evasions (case, spacing, separators, leetspeak, look-alike letters, full-width and mathematical letters,
// zero-width and bidi characters, stacked marks) are caught; the Scunthorpe cases are "clear" (the checks find nothing: still flagged
// "review", a person reads every founder's description) and every one of the 8,030 registry defaults passes as Vicinity's own sentence;
// a screening that cannot run is an error, never a pass; whatever a reviewer may approve is never refused by the metadata JSON's own
// rule (PITCH_BAD); the rules version is pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { MESSAGES, RULES_VERSION, SEVERITY, explain, explained, listsText, screen, screenDescription, screenName, screenReason, screenTicker, sha256Sync } from "../src/screen.js";
import * as WORDS from "../src/screen-words.js";
import { coinDefaults } from "../src/coindefaults.js";
import { coinMetadataJson } from "../src/coinmeta.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { createHash } from "node:crypto";

const UTICA = { city: { name: "Utica", region: "New York", countryName: "United States", country: "US" }, ticker: "UTICA" };
const codes = (r) => r.issues.map((x) => x.code);
const spans = (t, r) => r.issues.map((x) => `${x.code}:${t.slice(x.start, x.end)}`);
/** "clear": the checks found nothing, so the only issue is "review" (a founder's own words are read by a person: SCR-PLAIN-1). */
const verdict = (r) => (r.result === "flag" && r.issues.length && r.issues.every((x) => x.code === "review") ? "clear" : r.result);
const check = (text, result, want = [], ctx = UTICA) => {
  const r = screenDescription(text, ctx);
  assert.equal(verdict(r), result, `${JSON.stringify(text)} → ${r.result} ${JSON.stringify(spans(text, r))}`);
  for (const w of want) assert.ok(spans(text, r).includes(w), `${JSON.stringify(text)}: expected ${w}, got ${JSON.stringify(spans(text, r))}`);
  return r;
};

test("the rules version is the SHA-256 of the lists, pinned (a list change is a new version; old passes are screened again)", () => {
  assert.equal(RULES_VERSION, "s1-" + createHash("sha256").update(listsText()).digest("hex").slice(0, 12));
  assert.equal(RULES_VERSION, "s1-f1605f1c6184", "pinned: a change to src/screen-words.js, to the severities or to the engine must update this line and src/screen.js RULES_VERSION (and re-screens every founder description)");
});

test("PARITY-STARTUP-1: nothing of the screener runs when a server starts: no hashing at load, and only a dynamic import reaches it", () => {
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  // the rules version is written in the source (the test above recomputes it), never hashed when the module loads
  assert.match(src("screen.js"), /^export const RULES_VERSION = "s1-[0-9a-f]{12}";$/m);
  assert.doesNotMatch(src("screen.js"), /^(?:export )?const \w+ = .*sha256Sync\(/m);
  // no module of the Worker imports the screener, its lists or its vocabulary statically: src/coinreview.js loads it when it screens
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".js") && !/^screen/.test(f));
  for (const f of files) assert.doesNotMatch(src(f), /^import [^;]*from "\.\/screen(?:-words|-vocab)?\.js";/m, f);
  assert.match(src("coinreview.js"), /import\("\.\/screen\.js"\)/);
  // a dynamic import makes the bundler wrap the module it reaches, and everything that module imports, in lazy initializers: only the
  // screener and the art renderer (leaf modules) are reached that way
  const dynamic = files.flatMap((f) => [...src(f).matchAll(/import\("(\.\/[^"]+)"\)/g)].map((m) => `${f} -> ${m[1]}`));
  assert.deepEqual(dynamic.sort(), ["coinready.js -> ./coinart-wasm.js", "coinreview.js -> ./screen.js"]);
});

test("the synchronous SHA-256 is SHA-256", () => {
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "Herāt ❤️ 𝐬𝐜𝐚𝐦", JSON.stringify(WORDS.TLDS)]) {
    assert.equal(sha256Sync(s), createHash("sha256").update(s, "utf8").digest("hex"), s.slice(0, 20));
  }
});

test("every result and its plain sentence: clear (still flagged for a person), flag, block; only Vicinity's own sentence passes", () => {
  // a founder's own words never pass by themselves (SCR-PLAIN-1): the checks find nothing, and a person still reads it
  const own = screenDescription("Utica is the Handshake City, home of the half moon cookie and the tomato pie.", UTICA);
  assert.deepEqual([own.result, own.issues], ["flag", [{ code: "review", severity: "flag", start: 0, end: 0 }]]);
  assert.equal(explained(own.issues, "Utica")[0].message, MESSAGES.review);
  // Vicinity's own sentence for the city (ctx.vicinityText), exactly, is the only description that passes
  const vic = { ...UTICA, vicinityText: "The city coin of Utica, New York, United States." };
  assert.deepEqual([screenDescription("The city coin of Utica, New York, United States.", vic).result, screenDescription("The city coin of Utica, New York, United States.", vic).issues], ["pass", []]);
  assert.equal(verdict(screenDescription("The city coin of Utica, New York, United States!", vic)), "clear");
  assert.equal(verdict(screenDescription("The city coin of Utica, New York, United States.", UTICA)), "clear", "without the sentence in the context nothing passes");
  // names and tickers are never "review" flagged: every change request is read by a person anyway
  assert.equal(screenName("Utica Coin", UTICA).result, "pass");
  check("Utica is the Handshake City, home of the half moon cookie and the tomato pie.", "clear");
  // a word the screener does not know (a local dish, another language, a new spelling): a person reads it (ENGINE 4)
  check("Utica is the Handshake City, home of the half moon cookie and chicken riggies.", "flag", ["words:riggies"]);
  // length: 10 to 200 characters (code points), at most 3 lines, at most 600 bytes
  check("Too short", "block", ["length:Too short"]);
  check("Utica, NY.", "clear"); // exactly 10
  check("Utica ".repeat(40), "block");
  check("Line one is here\nLine two is here\nLine three\nLine four", "block");
  check("🏙️".repeat(100), "block"); // 200 code points of emoji: too many bytes
  check("Accents are fine in Utica, the city of cookies: café, naïve, façade.", "clear");
  check("Accents are fine in Utica, the city of 🍪 cookies: café, naïve, façade.", "flag", ["characters:🍪"]); // an emoji is not plain: a person looks
  // links
  check("Visit utica.io for news", "block", ["link:utica.io"]);
  check("Visit https://utica.example", "block");
  check("See www.utica.com now", "block");
  check("Visit utica dot com today", "block", ["link:utica dot com"]);
  check("Visit utica[.]com today", "block");
  check("Visit utica(dot)com today", "block");
  check("Join t.me/uticacoin today", "block");
  check("Join discord.gg/abc today", "block");
  check("My name is utica.sol on chain", "block");
  check("Welcome to St.Louis and Mt.Fuji, two nice places.", "clear");
  // letters, a dot and letters with no space: whatever the ending, a person looks (SEC-2-R2: "mvmoon.sbs" ends in no common one)
  check("Utica.Come and see the falls.", "flag", ["link_like:Utica.Come"]);
  // addresses and contacts
  check("Send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU today", "block", ["crypto_address:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"]);
  check("EVM 0x52908400098527886E0F7030069857D2E4169EE7 too", "block");
  check("BTC bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq ok", "block");
  check("Call +1 (315) 555-0100 any time", "block", ["contact:+1 (315) 555-0100"]);
  check("Mail bob@example.org for info", "block");
  check("Follow @uticacoin for news", "block", ["contact:@uticacoin"]);
  check("DM me on telegram for the presale", "block");
  check("Founded in 1797, population 60,000 people.", "clear");
  check("Meet us at 12 Main Street in Utica", "flag", ["street_address:12 Main Street"]);
  check("Our office is at Hauptstraße 12 in town", "flag");
  check("Founded in 1797 on the old road to Albany.", "clear");
  // words
  check("A chink in the armour of the old mill", "flag", ["abuse:chink"]);
  check("Utica is full of idiots", "flag", ["abuse:idiots"]);
  check("This coin is for niggers only", "block", ["slur:niggers"]);
  check("Buy $SYRACUSE now, not just $UTICA", "flag", ["other_city:$SYRACUSE"]);
  check("Pairs with $SOL; part of $VICINITY; $UTICA forever", "clear");
  check("The official partner of Binance in Utica", "flag", ["brand:Binance"]);
  check("Our coin is backed by Coinbase", "flag");
  check("Binance sells many things in many places", "flag", ["words:Binance"]); // a brand alone is not a claim (no "brand"), only a word the list does not know
  check("Endorsed by the Utica city council", "flag", ["brand:city council"]);
  check("The city council meets on Mondays in Utica", "clear");
  check("Vicinity team approved coin for Utica", "flag", ["staff:Vicinity"]);
  check("Ask an admin about this coin", "flag", ["staff:admin"]);
  check("Launched on Vicinity for the people of Utica", "clear");
  check("Guaranteed profit, 100x to the moon!", "flag", ["financial:Guaranteed", "financial:100x", "financial:to the moon"]);
  check("Join the presale before it is gone", "flag");
  check("This is a scam", "flag", ["financial:scam"]);
  check("UTICA IS THE GREATEST CITY IN ALL OF NEW YORK", "flag");
  check("Utica rocks!!!!!!! so good", "flag", ["spam:!!!!!!!"]);
  check("Utica 🍪🍪🍪🍪🍪🍪🍪🍪🍪 cookies", "flag");
  // the zero-width joiner and the variation selectors inside an emoji are not hidden characters (no block), but emoji are not plain (flag)
  const emoji = check("Utica ❤️ is home 👨‍👩‍👧 for families 1️⃣ first", "flag");
  assert.deepEqual([...new Set(codes(emoji))], ["characters"]);
  // block wins over flag
  const both = check("Profit guaranteed at utica.io", "block");
  assert.deepEqual([...new Set(codes(both))].sort(), ["financial", "link"]);
  for (const x of both.issues) assert.equal(x.severity, SEVERITY[x.code]);
});

test("evasion: case, spacing, separators, leetspeak, look-alikes, full-width and mathematical letters, invisible and bidi characters, stacked marks", () => {
  check("This is a s c a m coin", "flag", ["financial:s c a m"]);
  check("This is a S.C.A.M coin", "flag");
  check("This is a s-c-a-m coin", "flag");
  check("This is a s_c_a_m coin", "flag");
  check("a 5C4M for sure", "flag", ["financial:5C4M"]);
  check("Not a $c@m here", "flag", ["other_city:$c"]); // a $ starts a ticker, never leetspeak
  check("what a sh1t coin", "flag", ["abuse:sh1t"]);
  check("f.u.c.k this place", "flag", ["abuse:f.u.c.k"]);
  check("ＦＵＣＫ this place", "flag");
  check("𝐟𝐮𝐜𝐤 this place", "flag");
  check("ⓕⓤⓒⓚ this place", "flag");
  check("this is a n i g g e r test", "block", ["slur:n i g g e r"]);
  check("this is a n1gg3r test", "block");
  check("this is a NïGGÉR test", "block");
  // zero-width and bidi characters: refused outright, wherever they are
  for (const c of ["​", "‌", "‍", "⁠", "﻿", "‮", "⁦", "­", "᠎", "ㅤ", "", "\u{e0041}"]) {
    const r = check(`The s${c}cam coin of Utica`, "block");
    assert.ok(codes(r).includes("hidden_chars"), c.codePointAt(0).toString(16));
  }
  check("Utica has a non-breaking space", "block"); // blank characters other than the plain space
  // look-alike letters mixed into a Latin word
  check("The Vіcinity coin (that i is Cyrillic)", "block", ["hidden_chars:Vіcinity"]);
  check("Official Vicinitу coin", "block");
  // a whole word in another alphabet is not hidden (no block), but for Utica it is not plain either: a person looks
  check("Μοσχα is all Greek here, a person checks it", "flag", ["characters:Μοσχα"]);
  check("Москва — a whole word in Cyrillic, a person checks it", "flag", ["characters:Москва"]);
  // ...and in a city of a country that writes in that alphabet, it is plain (the city list writes "Moscow"), but the checks read English
  // only: a person reads it (FP-1: "language", never "characters")
  const moscow = check("Москва — столица России, a city of 13 million people.", "flag", ["language:Москва"], { city: { name: "Moscow", region: "Moscow", countryName: "Russia", country: "RU" }, ticker: "MOSCOW" });
  assert.deepEqual([...new Set(codes(moscow))], ["language"]);
  // a whole word of look-alikes is still read as the Latin word
  check("а ѕсам coin", "flag");
  // stacked marks (Zalgo)
  check("Utica sc̷a̴m̵ coin", "flag", ["financial:sc̷a̴m̵"]); // one mark on a letter: read through
  check("Utica s̸̡̛c̷a̴m̵ coin", "block"); // three on one letter: hidden
  check("Utica Z̷̡̛̤a̴l̵g̶o̷ text", "block");
  // Vietnamese letters are plain, and these words are words of the city list's place names (Hà Nội, Việt Nam): it passes
  check("Phở in Hà Nội, Việt Nam is great", "clear");
  check("Phở in Hà Nộ̂i is great", "clear"); // decomposed Vietnamese: two marks, fine
  // w w w, dot com, 1OOx
  check("go to w w w . utica . com now", "block");
  check("1OOx soon for Utica", "flag", ["financial:1OOx"]);
  check("Utica x100 for sure", "flag");
});

test("Scunthorpe: whole words only, and a city's own name, region, country and ticker never count against it", () => {
  // no list matches a shorter word inside a longer one; the towns the city list does not have are only words the screener does not know
  // ("Twatt", a doubled letter away from a listed insult, is read as one: a person checks it)
  assert.deepEqual([...new Set(codes(screenDescription("Scunthorpe, Essex, Sussex, Middlesex, Penistone and Clitheroe are towns.", UTICA)))], ["words"]);
  const villages = screenDescription("Shitterton and Twatt are villages; so is Cockermouth.", UTICA);
  assert.deepEqual(villages.issues.filter((x) => x.code !== "words").map((x) => `${x.code}:${villages.text.slice(x.start, x.end)}`), ["abuse:Twatt"]);
  check("Scunthorpe and Batman are towns too.", "clear");
  check("Classic assessment of the Assembly", "clear");
  check("The city coin of Fucking, Upper Austria, Austria.", "clear", [], { city: { name: "Fucking", region: "Upper Austria", countryName: "Austria", country: "AT" }, ticker: "FUCKING" });
  check("Fucking is a small village.", "flag", ["abuse:Fucking"]); // elsewhere it is still the word
  check("Coon Rapids is home.", "clear", [], { city: { name: "Coon Rapids", region: "Minnesota", countryName: "United States", country: "US" }, ticker: "COONRAPI" });
  check("Batman is a city in Turkey.", "clear");
  check("The Big Apple never sleeps.", "clear");
});

test("another city's coin: a ticker that is not the city's own, or a registry city's name before coin or token (ctx.otherCity)", () => {
  const ctx = { ...UTICA, otherCity: (name) => ["syracuse", "albany", "new york city"].includes(name.toLowerCase()) };
  check("Better than the Syracuse coin", "flag", ["other_city:Syracuse coin"], ctx);
  check("Not the New York City token", "flag", ["other_city:New York City token"], ctx);
  check("The Utica coin is ours", "clear", [], ctx);
  check("Our syracuse coin", "clear", [], ctx); // a name is written with a capital
  check("$SYRACUSE is not $UTICA", "flag", ["other_city:$SYRACUSE"], ctx);
});

test("names and reasons: the same rules on a name (no length or spam rule), only hidden characters and length on the reviewer's why", () => {
  assert.equal(screenName("Utica Coin", UTICA).result, "pass");
  assert.equal(screenName("UTICA", UTICA).result, "pass", "capitals are fine in a name");
  assert.equal(screenName("Scam City", UTICA).result, "flag");
  assert.equal(screenName("Utica.io", UTICA).result, "block");
  assert.equal(screenName("Nigger Town", UTICA).result, "block");
  assert.equal(screenName("Utica​Coin", UTICA).result, "block");
  assert.equal(screenReason("Locals call it the Handshake City, so we want that name.").result, "pass");
  assert.equal(screenReason("short").result, "block");
  assert.equal(screenReason("x".repeat(301)).result, "block");
  assert.equal(screenReason("Locals call it UticaNY at utica.io all the time").result, "pass", "the why is never public: only hidden characters and length");
  assert.equal(screenReason("Locals call it ‮UticaNY‬ all the time").result, "block");
});

test("a screening that cannot run is an error, never a pass: a list that throws, a missing list, another rules version, no text, an unknown target", () => {
  const throwing = { ...WORDS };
  Object.defineProperty(throwing, "SLURS", { get() { throw new Error("list unavailable"); }, enumerable: true });
  const e1 = screenDescription("Utica is a lovely city on the Mohawk.", { ...UTICA, lists: throwing });
  assert.deepEqual([e1.result, e1.issues], ["error", []]);
  const e2 = screenDescription("Utica is a lovely city on the Mohawk.", { ...UTICA, lists: { ...WORDS, ABUSE: undefined } });
  assert.equal(e2.result, "error");
  const e3 = screenDescription("Utica is a lovely city on the Mohawk.", { ...UTICA, rulesVersion: "s1-000000000000" });
  assert.equal(e3.result, "error");
  assert.equal(verdict(screenDescription("Utica is a lovely city on the Mohawk.", { ...UTICA, rulesVersion: RULES_VERSION })), "clear");
  assert.equal(screen("headline", "Utica is a lovely city on the Mohawk.", UTICA).result, "error");
  // stand-in lists change the version the answer names
  const other = screenDescription("Utica is a lovely city on the Mohawk.", { ...UTICA, lists: { ...WORDS, ABUSE: [...WORDS.ABUSE, "mohawk"] } });
  assert.equal(other.result, "flag");
  assert.notEqual(other.rulesVersion, RULES_VERSION);
  // the plain sentences
  assert.equal(explain("other_city", "Utica"), "This mentions another coin, city or ticker. Your coin can only speak for Utica.");
  assert.equal(explain("nonsense"), MESSAGES.error);
  assert.deepEqual(explained([{ code: "link", severity: "block", start: 1, end: 4 }], "Utica"), [{ code: "link", severity: "block", start: 1, end: 4, message: MESSAGES.link }]);
  for (const code of Object.keys(SEVERITY)) assert.ok(MESSAGES[code], code);
});

test("whatever the checks find nothing in (a reviewer may approve it) is never refused by the metadata JSON's own rule (PITCH_BAD), over a corpus and 6,000 random texts", () => {
  const corpus = ["see http://x.y", "www.utica", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "HTTPS: in caps", "w w w . a . b", "The Utica coin, plain and simple."];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  // random letters (mostly words nobody knows: flagged), and random known words with the characters links are made of (many pass)
  for (const alphabet of ["abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789 .:/w@$-_\n0OIl", "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ      .:w-\nOIl"]) {
    for (let i = 0; i < 1500; i++) { let s = ""; const n = 10 + Math.floor(rnd() * 120); for (let k = 0; k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)]; corpus.push(s); }
  }
  const pieces = ["utica", "coin", "city", "the", "www", "http", "https", "com", "io", "net", "org", "x", "me", "t", "bit", "ly", "dot", "slash", "at", "on", "home",
    "we", "love", "it", "is", "a", "and", "Utica", "WWW", "HTTP", ".", ":", "/", ",", "-", " ", " ", " ", " ", "\n", "1", "22", "100", "7xKXtg2CW87d97TXJSDpbD5jBkhe"];
  for (let i = 0; i < 3000; i++) { let s = ""; const n = 4 + Math.floor(rnd() * 30); for (let k = 0; k < n; k++) s += `${pieces[Math.floor(rnd() * pieces.length)]} `; corpus.push(s.slice(0, 190)); }
  let passed = 0;
  for (const t of corpus) {
    const r = screenDescription(t, UTICA);
    if (verdict(r) !== "clear") continue;
    passed++;
    assert.doesNotThrow(() => coinMetadataJson({ mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", name: "Utica", symbol: "UTICA", pitch: r.text, city: { id: "5142056", name: "Utica", ticker: "UTICA" } }), t);
  }
  assert.ok(passed > 100, `the checks find nothing in some random texts (${passed})`);
});

test("all 8,030 registry defaults pass (their description, as Vicinity's own sentence, and their name), with each city's own words allowed", async () => {
  _resetCityCache(); _resetTickers();
  const read = (p) => readFileSync(new URL(`../public${p}`, import.meta.url), "utf8");
  const files = { "/data/cities.json": read("/data/cities.json"), "/data/tickers.json": read("/data/tickers.json") };
  const env = { ASSETS: { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } } };
  const cities = JSON.parse(files["/data/cities.json"]), tickers = JSON.parse(files["/data/tickers.json"]);
  const ccOf = new Map();
  for (const [cc, l] of Object.entries(cities.byCountry)) for (const r of l) ccOf.set(String(r[0]), cc);
  let n = 0;
  const bad = [];
  for (const id of Object.keys(tickers)) {
    const d = await coinDefaults(env, id, ccOf.get(id));
    assert.equal(d.ok, true, id);
    n++;
    const ctx = { city: d.city, ticker: d.ticker, vicinityText: d.description };
    // the checks find nothing in it either: without the sentence in the context it is "clear" (a founder who typed it gets "review")
    for (const [what, r] of [["description", screenDescription(d.description, ctx)], ["name", screenName(d.name, ctx)]]) if (r.result !== "pass") bad.push([id, what, r.result]);
    const typed = screenDescription(d.description, { city: d.city, ticker: d.ticker });
    if (verdict(typed) !== "clear") bad.push([id, "description typed by a founder", typed.result, typed.issues.map((x) => x.code)]);
  }
  _resetCityCache(); _resetTickers();
  assert.equal(n, 8030);
  assert.deepEqual(bad, []);
});

test("small capitals and other look-alike letters, words split by separators or a space, slur stems: never a pass (the review's strings)", () => {
  // Latin small capitals ("fancy text" generators) have no decomposition and are Latin script: refused as look-alikes, and read as letters
  const sc = check("Utica welcomes everyone except ɴɪɢɢᴇʀꜱ and ꜰᴀɢɢᴏᴛꜱ.", "block", ["hidden_chars:ɴɪɢɢᴇʀꜱ", "slur:ɴɪɢɢᴇʀꜱ", "slur:ꜰᴀɢɢᴏᴛꜱ"]);
  assert.ok(sc.issues.some((x) => x.code === "hidden_chars"));
  for (const t of ["Utica says ʜᴇɪʟ ʜɪᴛʟᴇʀ to all", "Utica is a ɢᴜᴀʀᴀɴᴛᴇᴇᴅ ᴘʀᴏꜰɪᴛ", "Utica ꜰᴜᴄᴋ yeah ok", "The ᴠɪᴄɪɴɪᴛʏ team speaks here"]) check(t, "block", [], UTICA);
  assert.ok(codes(screenDescription("Utica says ʜᴇɪʟ ʜɪᴛʟᴇʀ to all", UTICA)).includes("abuse"), "read as the words they look like too");
  // letters drawn as symbols, parenthesized, or in a script made of Latin capitals (Lisu)
  for (const t of ["Utica is for 🅽🅸🅶🅶🅴🆁🆂 only", "Utica is for ⒩⒤⒢⒢⒠⒭⒮ only", "Utica is for ꓠꓲꓖꓖꓰꓣꓢ only", "Utica is for 🇳 🇮 🇬 🇬 🇪 🇷 🇸 only"]) {
    assert.notEqual(verdict(screenDescription(t, UTICA)), "clear", t);
  }
  // a word broken by a separator, whatever the length of its pieces: blocked (a slur) or flagged
  check("Utica is for nig-ger people", "block", ["slur:nig-ger"]);
  check("Utica is for nig.gers only", "block");
  check("Utica fu-ck yeah ok", "flag", ["abuse:fu-ck"]);
  check("Utica fuc.k yeah ok", "flag", ["abuse:fuc.k"]);
  check("Utica fuc'k yeah ok", "flag");
  // split by a space: two real words can make a slur too ("go ok"), so it is flagged for a person, never passed
  check("Utica is for ni gger people", "flag", ["abuse:ni gger"]);
  check("Utica is a sc am coin", "flag", ["financial:sc am"]);
  // stems: trailing s, z, digits; the leet symbols at the end of a word
  for (const t of ["Utica is for niggerz only", "Utica is for niggers123 only", "Utica is for 123kikes only", "Utica has wetbackz here", "Utica has kikez here", "Utica n!gg@ yeah ok", "Utica sp!c$ yeah ok"]) check(t, "block", [], UTICA);
  // spaced single letters: no cap on how many come first
  const pad = "a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n";
  check(`${pad} k i k e`, "block");
  check(`${pad} ${pad} k i k e`.slice(0, 200), "block");
  // and what must still pass: a plural is never a shorter slur plus "es", an apostrophe or a dash keeps a word whole, two whole words
  // stay two words, a bullet between spaced words is a list
  for (const t of ["Utica has great spices and food", "See Utica's pics online today", "We give away free cookies in Utica", "Utica: food, art, music for all",
    "Saint-Étienne and Aix-en-Provence are friends of Utica", "Utica's co-op opens at nine", "Winston-Salem, Saint-Étienne and Utica"]) check(t, "clear");
  assert.deepEqual([...new Set(codes(check("Ŋaŋ, Bakı and Gəncə are lovely", "flag")))], ["words"]); // plain letters, words the list does not write
  // a bullet between spaced words is a list, never a link (not plain either: a person looks)
  const bullets = check("Utica: food • art • music for all", "flag");
  assert.deepEqual([...new Set(codes(bullets))], ["characters"]);
});

test("links and handles written with other dots, spaces or words: blocked, or flagged when it could be a sentence (the review's strings)", () => {
  for (const t of ["Visit uticacoin。com to learn about our city", "Visit uticacoin｡com to learn about our city", "Visit uticacoin . com for the details, friends", "uticacoin dotcom is our home",
    "uticacoin d0t com is our home", "uticacoin·com is our home", "uticacoin⸱com is our home", "uticacoin・com is our home", "uticacoin‧com is our home",
    "hxxps://uticacoin com is home", "Find us at uticacoin://home now", "discord gg slash utica is home", "Join t。me/uticacoin", "Instagram: uticacoin for photos", "Find us on tg @utica_coin today"]) {
    const r = check(t, "block");
    assert.ok(codes(r).some((c) => c === "link" || c === "contact"), `${t}: ${JSON.stringify(codes(r))}`);
  }
  check("Visit uticacoin．com to learn more", "block", ["link:uticacoin．com"]);
  check("Visit uticacoin(.)com to learn more", "block");
  // could be a sentence: flagged, never passed
  check("Follow @ uticacoin on X for news", "flag", ["contact:@ uticacoin"]);
  check("Our home is uticacoin. com for news", "flag");
  // ...and plain sentences still pass
  for (const t of ["I love Utica. Me too, honestly.", "It is a city. In New York, by the canal.", "Meet us by the falls, ok? Then lunch.", "Utica. So good, so old."]) check(t, "clear");
});

test("a proposed ticker is read like a word: a slur refuses it, whatever the name says (src/coinreview.js screens it with the coin's own words)", () => {
  assert.equal(screenTicker("SPICS", UTICA).result, "block");
  assert.equal(screenTicker("NIGGAZ", UTICA).result, "block");
  assert.equal(screenTicker("UTICANY", UTICA).result, "pass", "a ticker is letters, not a word of a language");
  assert.equal(screenTicker("UFR", UTICA).result, "pass");
  // the name with the city's reviewed own words (never the proposed ticker): the slur in it counts
  assert.equal(screenName("Utica Spics", UTICA).result, "block");
  assert.equal(screenName("Spic Town", UTICA).result, "block");
});
