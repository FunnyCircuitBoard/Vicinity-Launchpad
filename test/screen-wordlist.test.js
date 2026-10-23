// The description screener's word allow-list (src/screen.js ENGINE 4, review round SEC-1-R2, SCAM-1, SEC-2-R2, FP-1, NAME-1): a founder's
// description passes by itself only when every word is one the screener knows (everyday English, the city list's place names, the
// city's own words); anything else goes to a person. The corpora: the verification's generator rebuilt (plain-letter respellings of 30
// slurs, about 1,200 strings), slurs nobody listed, slurs of other languages and hate without a slur, scams in ordinary words, about
// 1,800 spellings of links and 200 of handles: none may pass. And the honest descriptions of real registry cities: English ones pass,
// other languages and scripts are flagged with the reason that is true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { screenDescription, screenName, screenTicker } from "../src/screen.js";
import * as WORDS from "../src/screen-words.js";
import * as VOCAB from "../src/screen-vocab.js";
import { placeWords } from "../scripts/screen/build-vocab.mjs";
import { SCAM_PROBES, UNLISTED_AND_HATE, handleCorpus, linkCorpus, respell, slurCorpus } from "./helpers/screen-corpus.js";
import { HONEST_EN, HONEST_OTHER_LANGUAGE, HONEST_OWN_SCRIPT } from "./fixtures/screen-honest.js";

const UTICA = { city: { name: "Utica", region: "New York", countryName: "United States", country: "US" }, ticker: "UTICA" };
const shown = (t, r) => `${JSON.stringify(t)} → ${r.result} ${JSON.stringify(r.issues.map((x) => `${x.code}:${t.slice(x.start, x.end)}`))}`;
const codes = (r) => [...new Set(r.issues.map((x) => x.code))].sort();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const CITIES = JSON.parse(read("public/data/cities.json")), TICKERS = JSON.parse(read("public/data/tickers.json"));
/** A registry city's screening context as the routes build it (src/cities.js cityRecord, src/coindefaults.js): never a made-up record. */
function registry(name, cc) {
  const r = CITIES.byCountry[cc].find((x) => x[1] === name);
  assert.ok(r, `${name} (${cc}) is in the city list`);
  const t = TICKERS[String(r[0])];
  return { city: { id: String(r[0]), name: r[1], country: cc, region: (r[2] && CITIES.admin[`${cc}.${r[2]}`]) || null, countryName: CITIES.countries[cc] || null },
    ticker: typeof t === "string" ? t : t ? t[0] : "X" };
}
const noneMayPass = (corpus, ctx = UTICA) => {
  const passed = [], tooLong = [];
  for (const t of corpus) {
    const r = screenDescription(t, ctx);
    if (r.result === "pass" || r.result === "error") passed.push(shown(t, r));
    if (r.issues.some((x) => x.code === "length")) tooLong.push(shown(t, r)); // stopped for its length only would prove nothing
  }
  return { passed, tooLong };
};

test("the vocabulary file is the generator's output: its hash, and its place words are the city list's (rebuild it when the list changes)", () => {
  const sha = createHash("sha256").update(`${VOCAB.ENGLISH}\n${VOCAB.NAMES}\n${VOCAB.PLACES}\n${VOCAB.TLDS}`).digest("hex");
  assert.equal(VOCAB.VOCAB_SHA256, sha);
  const english = new Set(VOCAB.ENGLISH.split(" ")), names = new Set(VOCAB.NAMES.split(" "));
  const places = [...placeWords(read("public/data/cities.json"))].filter((w) => !english.has(w) && !names.has(w)).sort();
  assert.equal(VOCAB.PLACES, places.join(" "), "node scripts/screen/build-vocab.mjs rebuilds the place words from public/data/cities.json");
  assert.ok(english.size > 70_000 && names.size > 9_000 && places.length > 10_000, `${english.size} English words, ${names.size} names, ${places.length} more place words`);
  for (const t of ["sbs", "cfd", "icu", "lol", "rocks", "wtf", "army", "zone", "wiki", "one", "bio", "ink", "buzz", "ninja", "pics", "mom", "com", "io"]) assert.ok(VOCAB.TLDS.split(" ").includes(t), t);
});

test("no slur of the lists is a known word, in any plural (the English list has many: they are taken out, and a person reads them)", () => {
  for (const e of [...WORDS.SLURS, ...WORDS.FOREIGN_SLURS, ...WORDS.VOCAB_DENY]) {
    for (const form of [e, `${e}s`]) {
      const t = `Utica welcomes ${form} today`;
      assert.notEqual(screenDescription(t, UTICA).result, "pass", t);
    }
  }
  // the compounds of the English list with a profanity in them ("fuckhead", "shithead") are not known words either
  for (const w of ["fuckhead", "shithead", "motherfucker", "cocksucker", "dickhead", "bitchy"]) assert.notEqual(screenDescription(`Utica is ${w} town`, UTICA).result, "pass", w);
});

test("SEC-1-R2: the plain-letter generator (about 2,000 respellings of 30 slurs, also written as names) never passes; a listed slur respelled is refused", () => {
  const corpus = slurCorpus();
  assert.ok(corpus.length >= 1800, String(corpus.length));
  const passedWords = new Set(), tooLong = [];
  for (const [word, t] of corpus) {
    const r = screenDescription(t, UTICA);
    if (r.result === "pass" || r.result === "error") passedWords.add(word.toLowerCase());
    if (r.issues.some((x) => x.code === "length")) tooLong.push(shown(t, r));
  }
  assert.deepEqual(tooLong, []);
  // only respellings that are themselves everyday words, names or places pass: "niger" (the country), "pollack" (a fish), "spices"...
  assert.deepEqual([...passedWords].sort(), ["dag", "japes", "jp", "niger", "pak", "pollack", "spices", "woop", "wp"]);
  // the verification's own strings: refused (a listed slur, respelled), never only flagged; written as a name too
  for (const x of ["niqqers", "trannies", "nigggers", "niiggers", "phaggots", "niggerlover", "n,i,g,g,e,r", "ni\nggers", "NIQQERS", "faggotz", "Niqqers", "Trannies"]) {
    const t = `Utica coin: no ${x} here.`;
    assert.equal(screenDescription(t, UTICA).result, "block", shown(t, screenDescription(t, UTICA)));
  }
  // near ones are flagged as maybe a slur, and as words nobody knows
  for (const x of ["niggrs", "faggits", "spicks", "faggotz4life", "Niggrs", "Faggits"]) {
    const r = screenDescription(`Our lovely city welcomes everyone but the ${x} from the old mill.`, UTICA);
    assert.equal(r.result, "flag", shown(x, r));
  }
  assert.ok(respell("nigger").includes("niqqer") && respell("tranny").includes("trannies"));
});

test("SEC-1-R2: slurs nobody listed, other languages' slurs, and hate without a slur: never a pass", () => {
  const { passed, tooLong } = noneMayPass(UNLISTED_AND_HATE);
  assert.deepEqual(passed, []);
  assert.deepEqual(tooLong, []);
  const why = (t) => codes(screenDescription(t, UTICA));
  assert.ok(why("Utica: Neger und Kanaken raus").includes("slur_like"), "another language's slur is named as one");
  for (const t of ["gas the Jews of Utica", "No Jews allowed in Utica", "1488 forever in Utica", "lynch them all in Utica", "hang every Mexican in Utica",
    "gays should be stoned in Utica", "Muslims out of Utica now", "Blacks not welcome in Utica"]) assert.ok(why(t).includes("abuse"), `${t}: ${why(t)}`);
  // ...and ordinary words near a people's name or a number stay ordinary
  for (const t of ["Utica: 1,488 people came to the parade.", "Mexican food and Irish pubs, we hang out downtown.", "Jewish, Italian and Polish families built Utica.",
    "Muslims, Christians and Jews pray side by side in Utica.", "Utica welcomes immigrants and refugees from everywhere."]) {
    assert.equal(screenDescription(t, UTICA).result, "pass", shown(t, screenDescription(t, UTICA)));
  }
});

test("SCAM-1: wallet lures, returns for holding, money multiplied, regulators and famous backers: never a pass, each for its reason", () => {
  const { passed } = noneMayPass(SCAM_PROBES);
  assert.deepEqual(passed, []);
  const has = (t, code) => assert.ok(codes(screenDescription(t, UTICA)).includes(code), `${code}: ${shown(t, screenDescription(t, UTICA))}`);
  has("Connect your wallet at mvmoon.sbs to claim free Utica tokens.", "wallet_ask");
  has("Send 1 SOL to the founder and get 2 SOL back within an hour.", "wallet_ask");
  has("Send 1 SOL to the founder and get 2 SOL back within an hour.", "financial");
  has("Enter your seed phrase on the Utica page to verify your wallet.", "wallet_ask");
  has("Validate your wallet to receive the Utica bonus.", "wallet_ask");
  has("Holders earn 20% every week just for holding Utica.", "financial");
  has("Stake Utica for 300 percent yearly yield.", "financial");
  has("Utica is approved by the SEC and fully insured.", "brand");
  has("Endorsed by Elon Musk himself. Utica to one dollar.", "brand");
  has("Endorsed by Elon Musk himself. Utica to one dollar.", "financial");
  has("This coin doubles your money in a month.", "financial");
  has("Only 50 spots left in the Utica whitelist.", "financial");
  has("Utica: guaranteeed returns for all holders.", "financial");
  has("Utica: guarranteed profit every day.", "financial");
  // ...and the honest uses of the same words pass
  for (const t of ["Hold $UTICA in your wallet and show your city pride.", "Utica's 100% local pride: our bakeries, our parks, our people.",
    "Utica doubles as a film set every summer.", "Add Utica to your wallet today."]) assert.equal(screenDescription(t, UTICA).result, "pass", shown(t, screenDescription(t, UTICA)));
});

test("SEC-2-R2-links: about 1,800 spellings of a link (every web ending, a dot as a space, a comma, a dash or a word) never pass", () => {
  const corpus = linkCorpus();
  assert.ok(corpus.length >= 1700, String(corpus.length));
  const { passed, tooLong } = noneMayPass(corpus);
  assert.deepEqual(passed, []);
  assert.deepEqual(tooLong, []);
  // a real web ending after a dot is refused whatever it is (IANA's whole list); any other letters.letters is flagged
  for (const t of ["Visit mvmoon.sbs today", "Utica at mvmoon.cfd", "Utica at mvmoon.icu", "Utica at mvmoon.rocks", "Utica at mvmoon.ninja"]) {
    assert.equal(screenDescription(t, UTICA).result, "block", shown(t, screenDescription(t, UTICA)));
  }
  assert.deepEqual(codes(screenDescription("Utica at moon.notatld", UTICA)), ["link_like", "words"]);
  // abbreviations and ordinary sentences are not links
  for (const t of ["Welcome to St.Louis and Mt.Fuji, two nice places.", "Visit Utica online and in person.", "We love polka dot art in Utica.",
    "Find us at home in Utica.", "U.S.A. born and raised in Utica, e.g. downtown."]) assert.equal(screenDescription(t, UTICA).result, "pass", shown(t, screenDescription(t, UTICA)));
});

test("SEC-2-R2-handles: platforms misspelled, split or with a look-alike letter, short ones after our or the, mail and chats: never a pass", () => {
  const corpus = handleCorpus();
  assert.ok(corpus.length >= 200, String(corpus.length));
  const { passed } = noneMayPass(corpus);
  assert.deepEqual(passed, []);
  for (const t of ["Join our teIegram: mvmoon", "Utica on dlscord", "Utica on you tube", "Utica on face book", "Our IG is mvmoon", "Follow mvmoon on the gram",
    "Email mvmoon at gmail for details", "Join the Utica group chat"]) {
    assert.ok(codes(screenDescription(t, UTICA)).includes("link_like"), shown(t, screenDescription(t, UTICA)));
  }
  // "Follow uticamoonboys", "Message mvmoon": a handle nobody knows is a word nobody knows
  for (const t of ["Follow uticamoonboys for news", "Message mvmoon for a deal"]) assert.ok(codes(screenDescription(t, UTICA)).includes("words"), t);
});

test("NAME-1: names and tickers in change requests read the same way (the reviewer's card shows why)", () => {
  for (const n of ["Niqqer Town", "Utica Trannies", "Pajeet Coin", "Towel Heads"]) {
    const r = screenName(n, UTICA);
    assert.equal(r.result, "block", shown(n, r));
  }
  assert.equal(screenTicker("NIQQA", UTICA).result, "block");
  assert.deepEqual(codes(screenTicker("SPICK", UTICA)), ["abuse"]);
  assert.equal(screenTicker("KIKES", UTICA).result, "block");
  assert.equal(screenTicker("UFR", UTICA).result, "pass", "a ticker is letters: no words rule");
  // a name's words the screener does not know are shown to the reviewer; a city's own words and everyday ones pass
  assert.deepEqual(codes(screenName("Utica Falls Riggies", UTICA)), ["words"]);
  assert.equal(screenName("Big Apple Coin", UTICA).result, "pass");
});

test("a word written as a name (a landmark, a dish, a team) may pass in a sentence of everyday English, never a handle, a slur or another language", () => {
  // names: up to three, five everyday words at least, three for each name
  for (const t of ["Utica: games at Fenway on Sundays and pierogies at Primanti after the parade.", "Lisbon: custard tarts, the old Alfama streets and music at night.",
    "Mexico City: the blue house of Frida Kahlo, tacos and murals everywhere."]) {
    const r = screenDescription(t, UTICA);
    assert.equal(r.result, "pass", shown(t, r));
  }
  const flagged = (t, why = "words") => { const r = screenDescription(t, UTICA); assert.equal(r.result, "flag", shown(t, r)); assert.ok(codes(r).includes(why), shown(t, r)); };
  flagged("Utica: Fenway Primanti Alfama Kahlo."); // names alone: no sentence of everyday English around them
  flagged("Utica: games at Fenway, Primanti, Alfama and Kahlo on Sundays."); // more than three
  flagged("Utica: games at the Kop on Sundays with all our friends."); // too short to be told from a slur or a handle
  flagged("Utica: games at Fenway on Sundays and pierogies at primanti after."); // a word in small letters nobody knows
  for (const t of ["Follow Mvmoon for the latest Utica news", "Message Moonboys for a deal on Utica", "Visit Gemcats for the latest Utica news",
    "Uticamoonboys have all the news for Utica fans every day", "Mvmoon has all the news for Utica fans every day", "Solcats has all the news for our city every day"]) flagged(t);
  for (const t of ["Our lovely little town has no Gweilos at all, not one", "Our lovely little town has no Boches at all, not one"]) flagged(t, "slur_like");
  flagged("Ausländer Weg Aus Utica"); flagged("Willkommen In Utica, Herzlich Willkommen");
});

test("FP-1 and the honest corpus: real registry cities' English descriptions pass; other languages and scripts go to a person, for that reason", () => {
  const flagged = [];
  for (const [name, cc, t] of HONEST_EN) {
    const r = screenDescription(t, registry(name, cc));
    if (r.result !== "pass") flagged.push([name, codes(r), shown(t, r)]);
  }
  assert.ok(HONEST_EN.length >= 200, String(HONEST_EN.length));
  // a local word the English list does not have goes to a person: at most 3 in 100, and only for that
  assert.ok(flagged.length * 100 <= HONEST_EN.length * 3, flagged.map((x) => x[2]).join("\n"));
  for (const [, c, line] of flagged) assert.deepEqual(c, ["words"], line);
  for (const [name, cc, t] of HONEST_OTHER_LANGUAGE) {
    const r = screenDescription(t, registry(name, cc));
    assert.deepEqual([r.result, codes(r)], ["flag", ["words"]], shown(t, r));
  }
  for (const [name, cc, t] of HONEST_OWN_SCRIPT) {
    const r = screenDescription(t, registry(name, cc));
    assert.deepEqual([r.result, codes(r)], ["flag", ["language"]], shown(t, r));
  }
  // the people of a city are its own word too ("Uticans", "New Yorkers")
  assert.equal(screenDescription("Uticans and New Yorkers love the Handshake City.", UTICA).result, "pass");
});
