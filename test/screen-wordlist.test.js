// The description screener's word allow-list (src/screen.js ENGINE 4, review round SEC-1-R2, SCAM-1, SEC-2-R2, FP-1, NAME-1) and round 5
// (ENGINE 5: SCR-NAME-1, SCR-PLAIN-1, SCR-SCAM-1, SCR-LINK-1, FP-2, FP-1-R): a founder's own description never passes by itself (a
// person reads every one: "review"); the checks refuse what can never be used and point out what the reviewer should look at: a word
// the screener does not know (everyday English, the city list's place names, the city's own words), capitalised or not, a word that
// sounds like a slur, a link, a contact or a handle in words, a scam or a money promise in ordinary words. The corpora: the
// verification's generators rebuilt (plain-letter respellings of 30 slurs, about 1,200 strings; sound substitutions of every listed
// slur written as a name, about 6,500), slurs nobody listed, slurs of other languages and hate without a slur, scams in ordinary words,
// about 1,800 spellings of links and 200 of handles: the checks find something in each. And the honest descriptions of real registry
// cities: the checks find nothing in the English ones (a person still reads them), other languages and scripts are flagged with the
// reason that is true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MESSAGES, screenDescription, screenName, screenTicker } from "../src/screen.js";
import * as WORDS from "../src/screen-words.js";
import * as VOCAB from "../src/screen-vocab.js";
import { placeWords } from "../scripts/screen/build-vocab.mjs";
import { LINK_WORD_PROBES, NAME_EXAMPLES, NAME_FRAMES, PLAIN_PROBES, SCAM_PROBES, SCAM_WORD_PROBES, UNLISTED_AND_HATE, handleCorpus, linkCorpus, respell, slurCorpus,
  soundCorpus } from "./helpers/screen-corpus.js";
import { HONEST_EN, HONEST_OTHER_LANGUAGE, HONEST_OWN_SCRIPT } from "./fixtures/screen-honest.js";

const UTICA = { city: { name: "Utica", region: "New York", countryName: "United States", country: "US" }, ticker: "UTICA" };
const shown = (t, r) => `${JSON.stringify(t)} → ${r.result} ${JSON.stringify(r.issues.map((x) => `${x.code}:${t.slice(x.start, x.end)}`))}`;
const codes = (r) => [...new Set(r.issues.map((x) => x.code))].sort();
/** "clear": the checks found nothing, so the only issue is "review" (a founder's own words are read by a person: SCR-PLAIN-1). */
const verdict = (r) => (r.result === "flag" && r.issues.length && r.issues.every((x) => x.code === "review") ? "clear" : r.result);
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
/** Nothing in the corpus may pass, and the checks must find something in each (a "clear" text says nothing to its reviewer). */
const noneMayPass = (corpus, ctx = UTICA) => {
  const passed = [], tooLong = [];
  for (const t of corpus) {
    const r = screenDescription(t, ctx);
    if (r.result === "pass" || r.result === "error" || verdict(r) === "clear") passed.push(shown(t, r));
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
      assert.notEqual(verdict(screenDescription(t, UTICA)), "clear", t);
    }
  }
  // the compounds of the English list with a profanity in them ("fuckhead", "shithead") are not known words either
  for (const w of ["fuckhead", "shithead", "motherfucker", "cocksucker", "dickhead", "bitchy"]) assert.notEqual(verdict(screenDescription(`Utica is ${w} town`, UTICA)), "clear", w);
});

test("SEC-1-R2: the plain-letter generator (about 2,000 respellings of 30 slurs, also written as names) never passes; a listed slur respelled is refused", () => {
  const corpus = slurCorpus();
  assert.ok(corpus.length >= 1800, String(corpus.length));
  const passedWords = new Set(), tooLong = [];
  for (const [word, t] of corpus) {
    const r = screenDescription(t, UTICA);
    if (r.result === "pass" || r.result === "error") assert.fail(shown(t, r));
    if (verdict(r) === "clear") passedWords.add(word.toLowerCase());
    if (r.issues.some((x) => x.code === "length")) tooLong.push(shown(t, r));
  }
  assert.deepEqual(tooLong, []);
  // the checks find nothing only in respellings that are themselves everyday words, names or places ("niger" the country, "pollack"
  // a fish, "spices"...): a person still reads them
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
    assert.equal(verdict(screenDescription(t, UTICA)), "clear", shown(t, screenDescription(t, UTICA)));
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
  // ...and in the honest uses of the same words the checks find nothing
  for (const t of ["Hold $UTICA in your wallet and show your city pride.", "Utica's 100% local pride: our bakeries, our parks, our people.",
    "Utica doubles as a film set every summer.", "Add Utica to your wallet today."]) assert.equal(verdict(screenDescription(t, UTICA)), "clear", shown(t, screenDescription(t, UTICA)));
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
  // abbreviations and ordinary sentences are not links ("polka dot art" is pointed out since round 5, SCR-LINK-1: "moon dot city" is a
  // link in words whatever the words are, so a person reads it)
  for (const t of ["Welcome to St.Louis and Mt.Fuji, two nice places.", "Visit Utica online and in person.", "At this point in time Utica is great.",
    "Find us at home in Utica.", "U.S.A. born and raised in Utica, e.g. downtown."]) assert.equal(verdict(screenDescription(t, UTICA)), "clear", shown(t, screenDescription(t, UTICA)));
  assert.deepEqual(codes(screenDescription("We love polka dot art in Utica.", UTICA)), ["link_like"]);
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
  assert.deepEqual(codes(screenTicker("SPICK", UTICA)), ["abuse", "sounds_like"]);
  assert.equal(screenTicker("KIKES", UTICA).result, "block");
  assert.equal(screenTicker("UFR", UTICA).result, "pass", "a ticker is letters: no words rule");
  // a name's words the screener does not know are shown to the reviewer; a city's own words and everyday ones pass
  assert.deepEqual(codes(screenName("Utica Falls Riggies", UTICA)), ["words"]);
  assert.equal(screenName("Big Apple Coin", UTICA).result, "pass");
});

test("SCR-NAME-1: no word passes for a name: a landmark, a dish or a team the screener does not know is pointed out to the reviewer", () => {
  // the name allowance is gone: "Fenway", "Primanti", "Alfama" are words the screener does not know, capital or not
  for (const t of ["Utica: games at Fenway on Sundays and pierogies at Primanti after the parade.", "Lisbon: custard tarts, the old Alfama streets and music at night."]) {
    const r = screenDescription(t, UTICA);
    assert.deepEqual([r.result, codes(r)], ["flag", ["words"]], shown(t, r));
  }
  // a name that sounds like a slur ("Kahlo" sounds like one of the lists) is said so in words that accuse no one; a person reads it
  const kahlo = screenDescription("Mexico City: the blue house of Frida Kahlo, tacos and murals everywhere.", UTICA);
  assert.deepEqual([kahlo.result, codes(kahlo)], ["flag", ["sounds_like", "words"]]);
  assert.ok(!/offensive|slur/i.test(MESSAGES.sounds_like) && /name/.test(MESSAGES.sounds_like));
  const flagged = (t, why = "words") => { const r = screenDescription(t, UTICA); assert.equal(r.result, "flag", shown(t, r)); assert.ok(codes(r).includes(why), shown(t, r)); };
  flagged("Utica: Fenway Primanti Alfama Kahlo.");
  flagged("Utica: games at the Kop on Sundays with all our friends.");
  for (const t of ["Follow Mvmoon for the latest Utica news", "Message Moonboys for a deal on Utica", "Visit Gemcats for the latest Utica news",
    "Uticamoonboys have all the news for Utica fans every day", "Mvmoon has all the news for Utica fans every day", "Solcats has all the news for our city every day"]) flagged(t);
  for (const t of ["Our lovely little town has no Gweilos at all, not one", "Our lovely little town has no Boches at all, not one"]) flagged(t, "slur_like");
  flagged("Ausländer Weg Aus Utica"); flagged("Willkommen In Utica, Herzlich Willkommen");
});

test("SCR-NAME-1: a slur respelled by sound and written as a name (the verification's generator, about 6,500 spellings) is never clear, and its examples sound like slurs", () => {
  const english = new Set(VOCAB.ENGLISH.split(" ")), names = new Set(VOCAB.NAMES.split(" ")), places = new Set(VOCAB.PLACES.split(" "));
  const known = (w) => english.has(w) || names.has(w) || places.has(w);
  const corpus = soundCorpus([...WORDS.SLURS, ...WORDS.FOREIGN_SLURS]);
  assert.ok(corpus.length >= 6000, String(corpus.length));
  const clearUnknown = [], unmarked = [], bad = [];
  let soundsLike = 0;
  for (const [name, t] of corpus) {
    const r = screenDescription(t, UTICA);
    if (r.result === "pass" || r.result === "error") bad.push(shown(t, r));
    const at = t.indexOf(name), own = r.issues.filter((x) => x.start <= at && x.end >= at + name.length).map((x) => x.code);
    if (own.some((c) => ["slur", "slur_like", "sounds_like"].includes(c))) soundsLike++;
    // a respelling that is itself a word of the dictionary ("Nicker", "Cook", "Parka") says nothing to the checks: still read by a person
    if (verdict(r) === "clear") { if (!known(name.toLowerCase())) clearUnknown.push(shown(t, r)); continue; }
    if (!own.length && !known(name.toLowerCase())) unmarked.push(shown(t, r));
  }
  assert.deepEqual(bad, []);
  assert.deepEqual(clearUnknown, [], "every spelling the screener does not know is pointed out");
  assert.deepEqual(unmarked, [], "on the word itself");
  assert.ok(soundsLike >= corpus.length * 0.85, `${soundsLike} of ${corpus.length} are named as a slur may be`);
  for (const x of NAME_EXAMPLES) {
    const t = NAME_FRAMES[0](x), r = screenDescription(t, UTICA);
    assert.ok(r.issues.some((i) => ["slur_like", "sounds_like"].includes(i.code) && t.slice(i.start, i.end) === x), shown(t, r));
  }
  // in small letters they were always words nobody knows; a name of another language in small letters is not called a slur by its sound
  assert.ok(codes(screenDescription("Our lovely city of Utica welcomes everyone but the nikkas from the mill.", UTICA)).includes("words"));
  assert.deepEqual(codes(screenDescription("Madrid es la capital de España, con parques, museos y tapas.", registry("Madrid", "ES"))), ["words"]);
});

test("FP-1 and the honest corpus: the checks find nothing in real registry cities' English descriptions (a person reads them); other languages and scripts are flagged for that reason", () => {
  const flagged = [];
  for (const [name, cc, t] of HONEST_EN) {
    const r = screenDescription(t, registry(name, cc));
    assert.equal(r.result, "flag", `${shown(t, r)}: a founder's own words always go to a person`);
    if (verdict(r) !== "clear") flagged.push([name, codes(r), shown(t, r)]);
  }
  assert.ok(HONEST_EN.length >= 200, String(HONEST_EN.length));
  // a local word the English list does not have is pointed out to the reviewer: at most 3 in 100, and only for that (no honest
  // sentence is called a link, a scam or a slur by the fifth round's rules)
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
  assert.equal(verdict(screenDescription("Uticans and New Yorkers love the Handshake City.", UTICA)), "clear");
});

test("SCR-PLAIN-1: hate, threats and crime in dictionary words are never used by themselves: every founder's description goes to a person", () => {
  for (const t of PLAIN_PROBES) {
    const r = screenDescription(t, UTICA);
    assert.equal(r.result, "flag", shown(t, r));
    assert.ok(r.issues.length > 0, shown(t, r));
  }
  // the only description that passes by itself is Vicinity's own sentence for the city, exactly
  const vic = { ...UTICA, vicinityText: "The city coin of Utica, New York, United States." };
  assert.equal(screenDescription("The city coin of Utica, New York, United States.", vic).result, "pass");
  for (const t of ["The city coin of Utica, New York, United States. Kill the mayor.", "Kill the mayor of Utica."]) assert.equal(screenDescription(t, vic).result, "flag", t);
});

test("SCR-SCAM-1: drainers, scams and price promises in ordinary words carry their reason for the reviewer", () => {
  for (const [t, why] of SCAM_WORD_PROBES) {
    const r = screenDescription(t, UTICA);
    assert.equal(r.result, "flag", shown(t, r));
    assert.ok(codes(r).includes(why), `${why}: ${shown(t, r)}`);
  }
  // ...and the honest sentences that share their words say nothing of the kind
  for (const t of ["Sign up for the Utica newsletter at the library.", "Give the gift of a Utica tomato pie.", "Prices at the Utica market are fair.",
    "We send our love to Utica every day.", "Utica's rich history began in 1798.", "Our neighbours never lose hope in Utica."]) {
    const r = screenDescription(t, UTICA);
    assert.ok(!codes(r).some((c) => c === "wallet_ask" || c === "financial"), shown(t, r));
  }
});

test("SCR-LINK-1: links, e-mail addresses, phone numbers and handles in words, and official claims, carry their reason for the reviewer", () => {
  for (const [t, why] of LINK_WORD_PROBES) {
    const r = screenDescription(t, UTICA);
    assert.ok(["flag", "block"].includes(r.result), shown(t, r));
    assert.ok(codes(r).includes(why), `${why}: ${shown(t, r)}`);
  }
  // every web ending IANA lists, after a word for the dot, whatever the words around it
  for (const tld of ["city", "money", "life", "love", "art", "pizza", "rocks", "coffee", "bike", "app", "me", "to", "in"]) {
    for (const dot of ["dot", "d0t"]) {
      const t = `Find us at moon ${dot} ${tld} for Utica`, r = screenDescription(t, UTICA);
      assert.ok(r.issues.some((x) => x.code === "link_like" || x.code === "link" || x.code === "contact"), shown(t, r));
    }
  }
  // "point" and "period" before a little everyday word are a sentence
  for (const t of ["At this point in time Utica is great.", "The point is that Utica is home.", "A period of growth came to Utica in 1850."]) {
    assert.equal(verdict(screenDescription(t, UTICA)), "clear", shown(t, screenDescription(t, UTICA)));
  }
});

test("FP-2 and FP-1-R: \"From Alfama to Belém\" is no web address; a Thai city's own letters (\"ำ\") are never \"characters\"", () => {
  const lisbon = registry("Lisbon", "PT");
  const r = screenDescription("From Alfama to Belém, Lisbon is sunshine and history.", lisbon);
  assert.ok(!codes(r).includes("link_like"), shown("From Alfama to Belém, Lisbon is sunshine and history.", r));
  for (const t of ["From Trastevere to Monti, every street is lovely.", "From Gangnam to Itaewon, the city never sleeps."]) {
    assert.ok(!codes(screenDescription(t, UTICA)).includes("link_like"), shown(t, screenDescription(t, UTICA)));
  }
  assert.ok(codes(screenDescription("Visit mvmoon to today", UTICA)).length > 0);
  const bangkok = registry("Bangkok", "TH");
  for (const t of ["เหรียญสำหรับคนกรุงเทพ", "น้ำใจคนกรุงเทพ ยินดีต้อนรับทุกคน", "กรุงเทพ เมืองแห่งน้ำและวัด"]) {
    const x = screenDescription(t, bangkok);
    assert.deepEqual([x.result, codes(x)], ["flag", ["language"]], shown(t, x));
  }
  // ...but a compatibility letter of another script, or a full-width Latin one, is still not plain
  assert.ok(codes(screenDescription("Utica น้ำ coin of the city", UTICA)).includes("characters"));
  assert.ok(codes(screenDescription("Ｕｔｉｃａ coin for our city", bangkok)).includes("characters"));
});
