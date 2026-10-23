// The description screener (src/screen.js, COIN_V2_REVIEW): pure, so it is tested as a function. Every rule passes, flags or blocks with
// the span the page highlights; the evasions (case, spacing, separators, leetspeak, look-alike letters, full-width and mathematical
// letters, zero-width and bidi characters, stacked marks) are caught; the Scunthorpe cases and every one of the 8,030 registry defaults
// pass; a screening that cannot run is an error, never a pass; whatever passes is never refused by the metadata JSON's own rule
// (PITCH_BAD); the rules version is pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MESSAGES, RULES_VERSION, SEVERITY, explain, explained, listsText, screen, screenDescription, screenName, screenReason, sha256Sync } from "../src/screen.js";
import * as WORDS from "../src/screen-words.js";
import { coinDefaults } from "../src/coindefaults.js";
import { coinMetadataJson } from "../src/coinmeta.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { createHash } from "node:crypto";

const UTICA = { city: { name: "Utica", region: "New York", countryName: "United States", country: "US" }, ticker: "UTICA" };
const codes = (r) => r.issues.map((x) => x.code);
const spans = (t, r) => r.issues.map((x) => `${x.code}:${t.slice(x.start, x.end)}`);
const check = (text, result, want = [], ctx = UTICA) => {
  const r = screenDescription(text, ctx);
  assert.equal(r.result, result, `${JSON.stringify(text)} → ${r.result} ${JSON.stringify(spans(text, r))}`);
  for (const w of want) assert.ok(spans(text, r).includes(w), `${JSON.stringify(text)}: expected ${w}, got ${JSON.stringify(spans(text, r))}`);
  return r;
};

test("the rules version is the SHA-256 of the lists, pinned (a list change is a new version; old passes are screened again)", () => {
  assert.equal(RULES_VERSION, "s1-" + createHash("sha256").update(listsText()).digest("hex").slice(0, 12));
  assert.equal(RULES_VERSION, "s1-19762cd10667", "pinned: a change to src/screen-words.js or to the severities must update this line (and re-screens every founder description)");
});

test("the synchronous SHA-256 is SHA-256", () => {
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "Herāt ❤️ 𝐬𝐜𝐚𝐦", JSON.stringify(WORDS.TLDS)]) {
    assert.equal(sha256Sync(s), createHash("sha256").update(s, "utf8").digest("hex"), s.slice(0, 20));
  }
});

test("every result and its plain sentence: pass, flag, block", () => {
  check("Utica is the Handshake City, home of the half moon cookie and chicken riggies.", "pass");
  // length: 10 to 200 characters (code points), at most 3 lines, at most 600 bytes
  check("Too short", "block", ["length:Too short"]);
  check("Utica, NY.", "pass"); // exactly 10
  check("Utica ".repeat(40), "block");
  check("Line one is here\nLine two is here\nLine three\nLine four", "block");
  check("🏙️".repeat(100), "block"); // 200 code points of emoji: too many bytes
  check("Ünïcödé çhàrs are fine in Utica, the city of 🍪 cookies.", "pass");
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
  check("Welcome to St.Louis and Mt.Fuji, two nice places.", "pass");
  check("Utica.Come and see the falls.", "pass");
  // addresses and contacts
  check("Send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU today", "block", ["crypto_address:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"]);
  check("EVM 0x52908400098527886E0F7030069857D2E4169EE7 too", "block");
  check("BTC bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq ok", "block");
  check("Call +1 (315) 555-0100 any time", "block", ["contact:+1 (315) 555-0100"]);
  check("Mail bob@example.org for info", "block");
  check("Follow @uticacoin for news", "block", ["contact:@uticacoin"]);
  check("DM me on telegram for the presale", "block");
  check("Founded in 1797, population 60,000 people.", "pass");
  check("Meet us at 12 Main Street in Utica", "flag", ["street_address:12 Main Street"]);
  check("Our office is at Hauptstraße 12 in town", "flag");
  check("Founded in 1797 on the old road to Albany.", "pass");
  // words
  check("A chink in the armour of the old mill", "flag", ["abuse:chink"]);
  check("Utica is full of idiots", "flag", ["abuse:idiots"]);
  check("This coin is for niggers only", "block", ["slur:niggers"]);
  check("Buy $SYRACUSE now, not just $UTICA", "flag", ["other_city:$SYRACUSE"]);
  check("Pairs with $SOL; part of $VICINITY; $UTICA forever", "pass");
  check("The official partner of Binance in Utica", "flag", ["brand:Binance"]);
  check("Our coin is backed by Coinbase", "flag");
  check("Binance sells many things in many places", "pass", [], UTICA); // a brand alone is not a claim
  check("Endorsed by the Utica city council", "flag", ["brand:city council"]);
  check("The city council meets on Mondays in Utica", "pass");
  check("Vicinity team approved coin for Utica", "flag", ["staff:Vicinity"]);
  check("Ask an admin about this coin", "flag", ["staff:admin"]);
  check("Launched on Vicinity for the people of Utica", "pass");
  check("Guaranteed profit, 100x to the moon!", "flag", ["financial:Guaranteed", "financial:100x", "financial:to the moon"]);
  check("Join the presale before it is gone", "flag");
  check("This is a scam", "flag", ["financial:scam"]);
  check("UTICA IS THE GREATEST CITY IN ALL OF NEW YORK", "flag");
  check("Utica rocks!!!!!!! so good", "flag", ["spam:!!!!!!!"]);
  check("Utica 🍪🍪🍪🍪🍪🍪🍪🍪🍪 cookies", "flag");
  check("Utica ❤️ is home 👨‍👩‍👧 for families 1️⃣ first", "pass");
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
  check("Μοσχα is all Greek here and fine", "pass");
  check("Москва — a whole word in Cyrillic is fine", "pass");
  // a whole word of look-alikes is still read as the Latin word
  check("а ѕсам coin", "flag");
  // stacked marks (Zalgo)
  check("Utica sc̷a̴m̵ coin", "flag", ["financial:sc̷a̴m̵"]); // one mark on a letter: read through
  check("Utica s̸̡̛c̷a̴m̵ coin", "block"); // three on one letter: hidden
  check("Utica Z̷̡̛̤a̴l̵g̶o̷ text", "block");
  check("Phở in Hà Nội, Việt Nam is great", "pass");
  check("Phở in Hà Nộ̂i is great", "pass"); // decomposed Vietnamese: two marks, fine
  // w w w, dot com, 1OOx
  check("go to w w w . utica . com now", "block");
  check("1OOx soon for Utica", "flag", ["financial:1OOx"]);
  check("Utica x100 for sure", "flag");
});

test("Scunthorpe: whole words only, and a city's own name, region, country and ticker never count against it", () => {
  check("Scunthorpe, Essex, Sussex, Middlesex, Penistone and Clitheroe are towns.", "pass");
  check("Shitterton and Twatt are villages; so is Cockermouth.", "pass");
  check("Classic assessment of the Assembly", "pass");
  check("The city coin of Fucking, Upper Austria, Austria.", "pass", [], { city: { name: "Fucking", region: "Upper Austria", countryName: "Austria", country: "AT" }, ticker: "FUCKING" });
  check("Fucking is a small village.", "flag", ["abuse:Fucking"]); // elsewhere it is still the word
  check("Coon Rapids is home.", "pass", [], { city: { name: "Coon Rapids", region: "Minnesota", countryName: "United States", country: "US" }, ticker: "COONRAPI" });
  check("Batman is a city in Turkey.", "pass");
  check("The Big Apple never sleeps.", "pass");
});

test("another city's coin: a ticker that is not the city's own, or a registry city's name before coin or token (ctx.otherCity)", () => {
  const ctx = { ...UTICA, otherCity: (name) => ["syracuse", "albany", "new york city"].includes(name.toLowerCase()) };
  check("Better than the Syracuse coin", "flag", ["other_city:Syracuse coin"], ctx);
  check("Not the New York City token", "flag", ["other_city:New York City token"], ctx);
  check("The Utica coin is ours", "pass", [], ctx);
  check("Our syracuse coin", "pass", [], ctx); // a name is written with a capital
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
  assert.equal(screenDescription("Utica is a lovely city on the Mohawk.", { ...UTICA, rulesVersion: RULES_VERSION }).result, "pass");
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

test("whatever passes is never refused by the metadata JSON's own rule (PITCH_BAD), over a corpus and 3,000 random texts", () => {
  const corpus = ["see http://x.y", "www.utica", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "HTTPS: in caps", "w w w . a . b", "The Utica coin, plain and simple."];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789 .:/w@$-_\n0OIl";
  for (let i = 0; i < 3000; i++) { let s = ""; const n = 10 + Math.floor(rnd() * 120); for (let k = 0; k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)]; corpus.push(s); }
  let passed = 0;
  for (const t of corpus) {
    const r = screenDescription(t, UTICA);
    if (r.result !== "pass") continue;
    passed++;
    assert.doesNotThrow(() => coinMetadataJson({ mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", name: "Utica", symbol: "UTICA", pitch: r.text, city: { id: "5142056", name: "Utica", ticker: "UTICA" } }), t);
  }
  assert.ok(passed > 100, `some random texts pass (${passed})`);
});

test("all 8,030 registry defaults pass (their description and their name), with each city's own words allowed", async () => {
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
    const ctx = { city: d.city, ticker: d.ticker };
    for (const [what, r] of [["description", screenDescription(d.description, ctx)], ["name", screenName(d.name, ctx)]]) if (r.result !== "pass") bad.push([id, what, r.result]);
  }
  _resetCityCache(); _resetTickers();
  assert.equal(n, 8030);
  assert.deepEqual(bad, []);
});
