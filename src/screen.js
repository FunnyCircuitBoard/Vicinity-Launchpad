/**
 * The description screener (COIN_V2_REVIEW, src/coinreview.js; DESIGN.md section 7). Pure: no I/O, no clock, no randomness, so the same
 * text and city always get the same answer, in the Worker and in the tests.
 *
 *   screenDescription(text, ctx)  a founder's own coin description
 *   screenName(name, ctx)         a coin name in a change request (every rule but length and spam: nameProblem covers the length)
 *   screenReason(text)            the founder's "why" for a reviewer (only hidden characters and length: it is never public)
 * Each returns { result: "pass" | "flag" | "block" | "error", issues: [{ code, severity, start, end }], rulesVersion, text }. `text` is the
 * cleaned text that was screened (what a pass may store); start/end are positions in it (UTF-16, for the page to highlight).
 *
 * The result starts as "error" and becomes "pass" only after EVERY rule ran without throwing and none found anything: any exception, a
 * missing list or a rules version the caller did not expect leaves "error", and an error is never a pass (the routes treat it as "nothing
 * changed, try again"). block > flag > pass.
 *
 * An ALLOW-LIST decides what passes by itself (ENGINE 4), not a race against every new spelling. A description passes only when all
 * four hold, and anything else is FLAGGED for a person (never used by itself, never counted as approved):
 *   (a) plainChars: every character is a plain one. The letters of the scripts the city's own name is written in, and those of its
 *       country (src/screen-words.js COUNTRY_SCRIPTS: Japanese for a Japanese city, Cyrillic for a Russian one; for a Latin-script
 *       name: A to Z and the accented letters written languages use, never small capitals, phonetic, medieval, upside-down or other
 *       "fancy text" letters), A to Z for every city, the digits 0 to 9, everyday punctuation, spaces and line breaks, and any character
 *       of the city's own name, region and country. Compatibility forms (full-width, mathematical, circled, squared, parenthesized,
 *       superscript letters: whatever NFKC would rewrite) are not plain, nor are symbols, emoji, other alphabets, zero-width or bidi
 *       characters, and combining marks other than the accents of written languages (strike-through, underline and overlay marks).
 *   (b) knownWords: every word is one the screener knows: everyday English (src/screen-vocab.js, from SCOWL), a name of the dictionary
 *       ("Broadway"), a word of a place name in the Vicinity city list, the city's own name, region and country (and its people:
 *       "Uticans"), a number, or one of the words of src/screen-words.js (days, peoples, faiths, food...). Another word is flagged
 *       ("words": a local name, another language, a new spelling, a slur or a handle nobody listed), and text in another script too
 *       ("language": the checks read English only). Only a few words written as names may pass unknown (allowedNames: up to three,
 *       five letters or more, in a sentence of everyday English, never after "follow" or "message", never made like a handle, never one
 *       any rule read anything in: "Fenway", "Alfama"). A word it does not know is also read against the slurs spelled another way
 *       (slurLike: q for g, doubled or dropped letters, plurals, "-lover"...: a listed slur that way is refused, a near one flagged),
 *       the insults and financial words misspelled and the platforms' names.
 *   (c) linkLike: nothing reads as a link, an address or a handle with the dot written as a space or left out: a word, a space and a web
 *       ending ("uticacoin com"), a word, a comma or a dash and one ("mvmoon,com"), one after "visit", "at", "on"... ("Visit mvmoon
 *       net"), a word for the dot ("mvmoon period net"), letters, a dot and letters ("mvmoon.sbs": any ending), a link host with a space
 *       or a dash for its dot ("t me", "t-me", "bit ly", "x com"), a slash between words ("x com/uticacoin"), a platform's name, also
 *       misspelled, split or with a look-alike letter ("Telegram", "teIegram", "you tube"), a short one after "on", "our", "follow"...
 *       ("on X", "our IG", "on the gram"), a mail provider ("at gmail"), "DM me", a word that glues the city's name to a handle word
 *       ("uticacoin", "visitutica") or letters to digits ("utica22").
 *   (d) the word lists of src/screen-words.js find nothing (slurs BLOCK; every other list flags), compared with a folded form of the text:
 *       Unicode compatibility forms, letter case, accents and stacked marks, look-alike letters of other scripts, leetspeak (0 o, 1 i,
 *       3 e, 4 a, 5 s, 7 t, @ a, $ s, ! i, | l; never inside a $TICKER or a plain number), separators inside a word ("s.c.a.m",
 *       "s,c,a,m", a line break), and spaces between single letters ("s c a m"). So a slur in a fancy style is still refused (BLOCK)
 *       wherever the folding reads it, and flagged by (a) wherever it does not. Besides the lists: hate in ordinary words (hateNear: a
 *       group of people with a violent word, or "no Jews allowed"), asks about wallets and money (walletAsk: "connect your wallet",
 *       "send 1 SOL ... back"), returns for holding (moneyPromises: "earn 20% every week"), and official or famous backers ("approved
 *       by the SEC", "endorsed by Elon Musk").
 * Invisible characters (zero-width, bidi controls, tags, fillers, private use, unassigned), Latin small capitals and phonetic letters,
 * and words that mix Latin with Cyrillic or Greek letters are refused outright ("hidden_chars", BLOCK); the zero-width joiner and the
 * variation selectors are only hidden characters outside an emoji (an emoji is not plain either: it is flagged by (a)). Links, addresses
 * and contacts written plainly are refused (BLOCK). A city's own name, region, country and ticker never count against it (the
 * Scunthorpe guard), and single words match whole words only.
 */
import { BLANK_CHARS, FORMAT_CHARS, cleanText } from "./text.js";
import * as WORDS from "./screen-words.js";
import * as VOCAB from "./screen-vocab.js";

export const DESCRIPTION_MIN = 10, DESCRIPTION_MAX = 200, DESCRIPTION_LINES = 3, DESCRIPTION_BYTES = 600;
export const REASON_MIN = 10, REASON_MAX = 300;
export const SEVERITY = Object.freeze({
  length: "block", hidden_chars: "block", link: "block", crypto_address: "block", contact: "block", slur: "block",
  street_address: "flag", abuse: "flag", other_city: "flag", brand: "flag", staff: "flag", financial: "flag", spam: "flag",
  characters: "flag", link_like: "flag", taken_down: "flag", words: "flag", language: "flag", slur_like: "flag", wallet_ask: "flag",
});
/** What the founder reads for each issue ({City}: the city's name). */
export const MESSAGES = Object.freeze({
  length: "Use 10 to 200 characters on up to 3 lines.",
  hidden_chars: "Your text has hidden or look-alike characters. Retype it with ordinary letters and spaces.",
  link: "Links and web addresses can't go in a coin description.",
  crypto_address: "Wallet and contract addresses can't go in a description: people copy them and get scammed.",
  contact: "Phone numbers, e-mail addresses and social handles can't go in a description.",
  street_address: "This looks like a street address. Descriptions shouldn't send people to a specific place or person.",
  slur: "This contains a slur. It can't be used.",
  abuse: "This may be insulting, threatening or sexual. A person will check it if you send it for review.",
  other_city: "This mentions another coin, city or ticker. Your coin can only speak for {City}.",
  brand: "Coins can't suggest that a company, a famous person, a regulator, a team or a public body is involved or vouches for them. Only send it for review if they really are.",
  staff: "This sounds like it comes from Vicinity or its staff. Only Vicinity speaks for Vicinity.",
  financial: "This sounds like a promise about price, profit or rewards. City coins can't promise returns.",
  spam: "Too many capitals, repeated characters or emoji.",
  characters: "Only plain letters, numbers and everyday punctuation pass by themselves. This has other characters (a fancy-text style, symbols, emoji or an alphabet your city doesn't use), so a person checks it first.",
  link_like: "This looks like a web address, a link or a social media handle. A person checks it first.",
  taken_down: "Vicinity took this description down before. A person checks it before it can be used again.",
  words: "This has words our automatic check doesn't know (a local name, another language or an unusual spelling), so a person checks it first.",
  language: "Our automatic check reads English only, so a person checks text in other languages and scripts first.",
  slur_like: "A word here may be an offensive word written another way, so a person checks it first.",
  wallet_ask: "This asks people to do something with their wallet, keys or money (connect a wallet, enter a phrase, send coins, claim tokens). Scams do that, so a person checks it first.",
  error: "We couldn't check your description just now. Nothing changed. Try again in a minute.",
});
/** One plain sentence for an issue, with the city's name filled in. */
export const explain = (code, cityName = "your city") => (MESSAGES[code] || MESSAGES.error).replace("{City}", cityName || "your city");

/* ---------------------------------------------------------------- the rules version (a SHA-256 of the lists, computed at load) */
/** SHA-256 of a string, as hex (synchronous: the rules version is known the moment the module loads, in the Worker and in Node). */
export function sha256Sync(str) {
  const bytes = new TextEncoder().encode(str);
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138,
    0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624,
    0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length, total = Math.ceil((len + 9) / 64) * 64, m = new Uint8Array(total);
  m.set(bytes); m[len] = 0x80;
  const bits = len * 8, dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000)); dv.setUint32(total - 4, bits >>> 0);
  const w = new Uint32Array(64), r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}
const LIST_NAMES = ["SLURS", "ABUSE", "BRANDS", "PUBLIC_BODIES", "FINANCIAL", "WALLET_ASK", "OFFICIAL_CLAIMS", "STREET_WORDS", "TIE_WORDS", "BODY_TIE_WORDS",
  "STAFF_WORDS", "STAFF_ALONE", "TLDS", "LINK_HOSTS", "OK_TICKERS", "SPACED_TLDS", "WEB_TLDS", "LINK_LEADS", "DOT_WORDS", "SPACED_HOSTS", "PLATFORMS",
  "PLATFORM_SHORT", "CONTACT_WORDS", "CONTACT_ME", "HANDLE_SUFFIXES", "HANDLE_PREFIXES", "PROPER_WORDS", "EXTRA_WORDS", "VOCAB_PAIRS", "PAIR_ONLY",
  "VOCAB_DENY", "DENY_PARTS", "DEMONYM_SUFFIXES", "NAME_GUARD_WORDS", "FOREIGN_SLURS", "GROUP_WORDS", "VIOLENCE_WORDS", "EXCLUSION_AFTER", "COUNTRY_SCRIPTS"];
/**
 * The matching engine's own version: raised whenever the folding or a rule's code changes what is caught (2: Latin small capitals and
 * other look-alike letters, words split by separators or a space, slur stems, more ways of writing a link or a handle; 3: the
 * allow-list, plainChars and linkLike; 4: the word allow-list knownWords, slurLike, hateNear, walletAsk, moneyPromises, the country's
 * scripts, every web ending and a dot between any letters). It is part of the rules version, so a text that passed under the older
 * engine is screened again, like one that passed under older lists.
 */
const ENGINE = 4;
/**
 * The serialized lists the rules version is the hash of (with the rule severities: changing what blocks changes the version too; and the
 * vocabulary's own SHA-256, src/screen-vocab.js, so a new word list or city list re-screens too).
 */
export const listsText = (lists = WORDS) => JSON.stringify({ lists: Object.fromEntries(LIST_NAMES.map((k) => [k, lists[k]])), severity: SEVERITY, engine: ENGINE, vocab: VOCAB.VOCAB_SHA256 });
/** "s1-" and the first 12 hex characters of the SHA-256 of the lists: stored with every screening; test/screen.test.js pins it. */
export const RULES_VERSION = `s1-${sha256Sync(listsText()).slice(0, 12)}`;

/* ---------------------------------------------------------------- folding, with every character mapped back to the original */
// look-alike letters of other scripts that read as Latin ones (lower and upper case), folded before and after the case fold
const CONFUSABLE = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s", "і": "i", "ї": "i",
  "ј": "j", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ь": "b", "А": "a", "В": "b", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p",
  "С": "c", "Т": "t", "У": "y", "Х": "x", "Ѕ": "s", "І": "i", "Ј": "j", "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o",
  "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o",
  "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x", "ɑ": "a", "ɡ": "g", "ı": "i", "ȷ": "j", "ʟ": "l", "ꞵ": "b", "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "đ": "d",
  "ð": "d", "ł": "l", "þ": "th",
  // Latin letters that no normalization reduces to a-z: small capitals ("ɴɪɢɢᴇʀ", "ꜰᴜᴄᴋ"), letters with a hook, stroke, tail or bar,
  // and phonetic and medieval forms (each pair: the letter, then the a-z letter it reads as; from the Unicode names)
  ...pairs("ØoøoĐdđdĦhħhıiĿlŀlŁlłlŦtŧtƀbƁbƂbƃbƇcƈcƊdƋdƌdƑfƒfƓgƗiƘkƙkƚlƝnƞnƟoƤpƥpƫtƬtƭtƮtƲvƳyƴyƵzƶzǤgǥgǾoǿoȠnȡdȤzȥzȴlȵnȶtȷjȺaȻcȼcȽlȾtȿsɀzɃbɆeɇeɈjɉjɋqɌrɍrɎyɏyɓbɕcɖdɗdɟjɠgɡgɢgɦhɨiɪiɫlɬlɭlɱmɲnɳnɴnɵoɼrɽrɾrʀrʂsʄjʈtʋvʏyʐzʑzʙbʛgʜhʝjʟlʠqᴀaᴄcᴅdᴇeᴊjᴋkᴌlᴍmᴏoᴘpᴛtᴜuᴠvᴡwᴢzᵬbᵭdᵮfᵯmᵰnᵱpᵲrᵳrᵴsᵵtᵶzᵹgᵽpᶀbᶁdᶂfᶃgᶄkᶅlᶆmᶇnᶈpᶉrᶊsᶌvᶍxᶎzᶏaᶑdᶒeᶖiᶙuẚaẜsẝsỾyỿyⱠlⱡlⱢlⱣpⱤrⱥaⱦtⱧhⱨhⱩkⱪkⱫzⱬzⱮmⱱvⱲwⱳwⱴvⱸeⱺoⱾsⱿzꜰfꜱsꝀkꝁkꝂkꝃkꝄkꝅkꝆlꝇlꝈlꝉlꝊoꝋoꝌoꝍoꝐpꝑpꝒpꝓpꝔpꝕpꝖqꝗqꝘqꝙqꝞvꝟvꝹdꝺdꝻfꝼfꝽgꞂrꞃrꞄsꞅsꞆtꞇtꞎlꞐnꞑnꞒcꞓcꞔcꞕhꞖbꞗbꞘfꞙfꞠgꞡgꞢkꞣkꞤnꞥnꞦrꞧrꞨsꞩsꞪhꞬgꞭlꞮiꞯqꞲjꞸuꞹuꟄcꟅsꟆzꟇdꟈdꟉsꟊsꬳeꬴeꬶgꬸlꬹlꬺmꬻnꭆrꭉrꭋrꭌrꭎuꭒuꭖxꭗxꭘxꭙxꭚy"),
  // a few more small capitals and phonetic letters that read as one Latin letter, and the Lisu letters (drawn as Latin capitals)
  ...pairs("ᴁeᴂeᴃbᴆdᴈeᴉiᴎnᴐoᴑoᴒoᴓoᴖoᴗoᴙrᴚrᴝuᴞuᴟmᴣzᴤsᴦrᴨnᴩpᴫnɶeʁrᵻiᵾuᵿuꟺmɐaɒaɔoəeɘeɚeɛeɜeɝeɞeɣyɩiʉuʊuǝeŋnĸkſs"),
  ...pairs("ꓐbꓑpꓒdꓓdꓔtꓖgꓗkꓙjꓚcꓜzꓝfꓟmꓠnꓡlꓢsꓣrꓦvꓧhꓪwꓫxꓬyꓮaꓰeꓲiꓳoꓴu"),
};
function pairs(s) { const a = [...s], o = {}; for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1]; return o; }
// a letter's other case reads as the same letter (a look-alike written in capitals, or in small letters)
for (const [k, v] of Object.entries(CONFUSABLE)) for (const o of [k.toLowerCase(), k.toUpperCase()]) if ([...o].length === 1 && !(o in CONFUSABLE) && !/[a-z]/i.test(o)) CONFUSABLE[o] = v;
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i", "|": "l" };
const confuse = (s) => { let o = ""; for (const ch of s) o += CONFUSABLE[ch] ?? ch; return o; };
/** Letters drawn as symbols with no decomposition: negative circled and squared capitals, regional indicators (a letter each). */
function symbolLetter(cp) {
  for (const base of [0x1f150, 0x1f170, 0x1f1e6]) if (cp >= base && cp < base + 26) return String.fromCharCode(97 + cp - base);
  return null;
}

/**
 * The text folded for matching: one unit per output character, each with the span [s, e) of the original it came from.
 * NFKC, look-alikes, lower case, accents and other marks removed.
 */
function fold(text) {
  const units = [];
  for (const m of text.matchAll(/[\s\S]/gu)) {
    const ch = m[0], s = m.index, e = s + ch.length;
    // a parenthesized letter ("⒩", NFKC "(n)") is the letter; a negative squared or circled one, or a regional indicator, too
    let n = symbolLetter(ch.codePointAt(0)) || ch.normalize("NFKC");
    if (/^\(\p{L}\)$/u.test(n)) n = n.slice(1, -1);
    let f = confuse(n);
    f = confuse(f.toLowerCase()).normalize("NFD").replace(/\p{M}/gu, "");
    if (!f) { if (units.length && /\p{M}/u.test(ch)) units[units.length - 1].e = e; continue; } // a mark belongs to its letter
    // one UTF-16 unit per unit (a character outside the BMP, an emoji, stands as U+FFFC), so a position in the joined string is a unit
    for (const c of f) units.push({ c: c.length > 1 ? "\uFFFC" : c, s, e });
  }
  return units;
}
const str = (units) => units.map((u) => u.c).join("");
const span = (units, i, j) => ({ start: units[i].s, end: units[Math.max(i, j - 1)].e });

/** Words of the folded text: { w, s, e, i, j } (i, j: unit indexes), runs of a-z, 0-9 and the leet symbols. */
function words(units, { leet = true, tickers = [] } = {}) {
  const out = [];
  let i = 0;
  const inTicker = (u) => tickers.some((t) => u.s >= t.start && u.s < t.end);
  while (i < units.length) {
    if (!/[a-z0-9@$!|]/.test(units[i].c)) { i++; continue; }
    let j = i;
    while (j < units.length && /[a-z0-9@$!|]/.test(units[j].c)) j++;
    // leet symbols count only inside a word: "moon!" is "moon", "@uticacoin" and "$UTICA" are a handle and a ticker
    while (i < j && /[@$!|]/.test(units[i].c)) i++;
    while (j > i && /[@$!|]/.test(units[j - 1].c)) j--;
    if (i >= j) { i = Math.max(i, j) + 1; continue; }
    const run = units.slice(i, j);
    const raw = str(run);
    // leetspeak only in a word that has a letter (a plain number stays a number) and is not a $TICKER
    const mapped = leet && /[a-z]/.test(raw) && !inTicker(run[0]) ? raw.replace(/[013457@$!|]/g, (c) => LEET[c]) : raw;
    const clean = mapped.replace(/[@$!|]/g, "");
    if (clean) out.push({ w: clean, s: run[0].s, e: run[run.length - 1].e, i, j });
    i = j;
  }
  return out;
}
/**
 * More readings of each word, as single words: the word with its trailing "@" or "$" read as letters ("n!gg@" is "nigga"), and without
 * the digits it starts or ends with ("niggers123", "123kikes"). Never inside a $TICKER.
 */
function variants(units, { tickers = [] } = {}) {
  const out = [];
  const inTicker = (u) => tickers.some((t) => u.s >= t.start && u.s < t.end);
  const W = /[a-z0-9@$!|]/;
  for (let i = 0; i < units.length; i++) {
    if (!W.test(units[i].c) || (i > 0 && W.test(units[i - 1].c))) continue;
    let j = i;
    while (j + 1 < units.length && W.test(units[j + 1].c)) j++;
    let a = i;
    while (a <= j && /[@$!|]/.test(units[a].c)) a++; // a handle or a ticker starts with its symbol: never a letter
    if (a <= j && !inTicker(units[i])) {
      const run = units.slice(a, j + 1), raw = str(run);
      const read = (r) => r.replace(/[013457@$!|]/g, (c) => LEET[c]).replace(/[@$!|]/g, "");
      if (/[a-z]/.test(raw)) {
        if (/[@$]$/.test(raw)) out.push({ w: read(raw), s: run[0].s, e: run[run.length - 1].e });
        for (const r of [raw.replace(/[0-9@$!|]+$/, ""), raw.replace(/^[0-9]+/, "")]) if (r && r !== raw && /[a-z]/.test(r)) out.push({ w: read(r), s: run[0].s, e: run[run.length - 1].e });
      }
    }
    i = j;
  }
  return out.filter((x) => x.w);
}

const JOIN_MAX = 24; // the longest list entry is shorter: a longer join can match nothing
// separators inside a word, with no space: "nig-ger", "f.u.c.k", "fuc'k", "n,i,g,g,e,r", "s;c;a;m", a line break ("ni⏎ggers")
const TIGHT = /^[.\-_*·•'’‐‑‒–—,;:?&%\n]{1,3}$/u;
const LOOSE = /^(?=.* )[ .\-_*·•'’‐‑‒–—,;:\n]{1,3}$/u; // a space, maybe with separators: "ni gger", "fu - ck", "fu, ck"
/**
 * The joined words, each as one more word (the parts stay words too), whatever the length of the pieces:
 *   - pieces joined by separators with no space ("s.c.a.m", "nig-ger", "fuc.k", "s_c_a_m", "sc*m"): every stretch of two or more;
 *   - single letters with spaces between them ("s c a m", "n i g g e r"): every stretch of three or more;
 *   - two to four pieces with a space between them ("ni gger", "fu ck"): `spaced`, a weaker sign (two real words can make a list
 *     word: "go ok"), so a slur found only this way is flagged for a person rather than blocked.
 * `parts`: the pieces, so a join of the city's own words never counts against it.
 */
function joined(units) {
  const out = [];
  const seps = units.map((u) => u.c), n = units.length;
  const isW = (k) => k >= 0 && k < n && /[a-z0-9@$!|]/.test(seps[k]);
  const pieces = [];
  for (let k = 0; k < n; k++) { if (!isW(k)) continue; let t = k; while (isW(t + 1)) t++; pieces.push([k, t]); k = t; }
  const gap = (p) => seps.slice(pieces[p - 1][1] + 1, pieces[p][0]).join(""); // between piece p-1 and piece p
  const len = (p) => pieces[p][1] - pieces[p][0] + 1;
  const push = (from, to, spaced) => {
    const us = [];
    for (let p = from; p <= to; p++) for (let k = pieces[p][0]; k <= pieces[p][1]; k++) us.push(units[k]);
    if (us.length > JOIN_MAX) return false;
    const parts = [];
    for (let p = from; p <= to; p++) parts.push(str(units.slice(pieces[p][0], pieces[p][1] + 1)));
    out.push({ units: us, s: units[pieces[from][0]].s, e: units[pieces[to][1]].e, spaced, parts });
    return true;
  };
  for (let a = 0; a < pieces.length; a++) {
    // separators with no space, then single letters
    for (let b = a + 1; b < pieces.length && TIGHT.test(gap(b)); b++) if (!push(a, b, false)) break;
    if (len(a) === 1) for (let b = a + 1; b < pieces.length && len(b) === 1 && (TIGHT.test(gap(b)) || LOOSE.test(gap(b))); b++) if (b - a >= 2 && !push(a, b, false)) break;
    // up to four pieces with a space between at least two of them, one of them short (a split word leaves a piece of one to three
    // letters: "ni gger", "fuc k"; two whole words seldom do: "give away"); a word joined by an apostrophe or a dash stays whole
    // ("Utica's pics" is never "s pics")
    if (a > 0 && TIGHT.test(gap(a))) continue;
    let loose = false, short = len(a) <= 3;
    for (let b = a + 1; b < pieces.length && b - a <= 3; b++) {
      const g = gap(b);
      if (LOOSE.test(g)) loose = true; else if (!TIGHT.test(g)) break;
      short = short || len(b) <= 3;
      if (!loose || !short || (b + 1 < pieces.length && TIGHT.test(gap(b + 1)))) continue;
      if (!push(a, b, true)) break;
    }
  }
  const read = (raw) => (/[a-z]/.test(raw) ? raw.replace(/[013457@$!|]/g, (c) => LEET[c]) : raw).replace(/[@$!|]/g, "");
  // a number written with a comma or a dot ("1,488 people", "3.5") is a number, never a joined word
  return out.filter((x) => /[a-z]/.test(str(x.units))).map((x) => ({ w: read(str(x.units)), s: x.s, e: x.e, spaced: x.spaced, parts: x.parts.map((q) => skel(read(q))) })).filter((x) => x.w);
}
// i and l, and their look-alikes, compare as one letter ("sIut", "kiII")
const skel = (w) => w.replace(/l/g, "i");

/* ---------------------------------------------------------------- the rules */
/** The plain words of a phrase as the lists and the own-city allowance compare them. */
const phraseWords = (s) => words(fold(String(s || "")), { leet: false }).map((x) => skel(x.w));

const compiled = new WeakMap(); // list -> { singles, multi }: each list folded once
function compile(list) {
  let c = compiled.get(list);
  if (!c) {
    c = { singles: new Set(), multi: [] };
    for (const entry of list) { const p = phraseWords(entry); if (p.length === 1) c.singles.add(p[0]); else if (p.length > 1) c.multi.push(p); }
    compiled.set(list, c);
  }
  return c;
}
/**
 * A list word, or one with a plural or slang ending: up to three trailing s or z ("kikez", "niggerss"), "es" after s, x, z, ch or sh
 * ("bitches"; never "spices": that is spice + s, not spic + es), or "ies" for a final y ("trannies").
 */
function listWord(singles, w) {
  if (singles.has(w)) return true;
  if (w.length > 4 && w.endsWith("ies") && singles.has(`${w.slice(0, -3)}y`)) return true;
  for (let k = 1; k <= 3 && k < w.length - 1; k++) {
    const base = w.slice(0, -k), tail = w.slice(-k);
    if (singles.has(base) && (/^[sz]+$/.test(tail) || (tail === "es" && /(?:[sxz]|ch|sh)$/.test(base)))) return true;
  }
  return false;
}
function matchList(list, toks, joins, own) {
  const hits = [];
  const { singles, multi } = compile(list);
  for (const t of [...toks, ...joins]) {
    const w = skel(t.w);
    if (own.has(w) || (t.parts && t.parts.every((x) => own.has(x)))) continue;
    if (listWord(singles, w)) hits.push({ start: t.s, end: t.e, word: w, spaced: Boolean(t.spaced) });
  }
  const seq = toks.map((t) => skel(t.w));
  for (const p of multi) {
    for (let i = 0; i + p.length <= seq.length; i++) {
      let ok = true;
      for (let k = 0; k < p.length && ok; k++) {
        const w = seq[i + k], last = k === p.length - 1;
        ok = w === p[k] || (last && (w === `${p[k]}s` || w === `${p[k]}es` || (/[^aeiou]y$/.test(p[k]) && w === `${p[k].slice(0, -1)}ies`)));
      }
      if (ok && !p.every((x, k) => own.has(seq[i + k]))) hits.push({ start: toks[i].s, end: toks[i + p.length - 1].e, word: p.join(" "), at: i, len: p.length });
    }
  }
  return hits;
}
/** The token indexes near a hit (within `n` words either side). */
const near = (toks, hit, n) => {
  const i = toks.findIndex((t) => t.s >= hit.start), j = toks.findIndex((t) => t.e >= hit.end);
  const from = Math.max(0, (i < 0 ? 0 : i) - n), to = Math.min(toks.length, (j < 0 ? toks.length - 1 : j) + n + 1);
  return toks.slice(from, to).filter((t) => t.s < hit.start || t.s >= hit.end).map((t) => skel(t.w));
};

function hiddenChars(text) {
  const issues = [];
  const at = (s, e) => issues.push({ code: "hidden_chars", start: s, end: e });
  const cps = [...text.matchAll(/[\s\S]/gu)];
  const pict = (k) => k >= 0 && k < cps.length && /\p{Extended_Pictographic}|\p{Emoji_Modifier}/u.test(cps[k][0]);
  for (let k = 0; k < cps.length; k++) {
    const ch = cps[k][0], c = ch.codePointAt(0), s = cps[k].index, e = s + ch.length;
    if (ch === "\n" || ch === " ") continue;
    // inside an emoji: the variation selectors after a pictograph or a keycap digit, the zero-width joiner between two pictographs
    if ((c === 0xfe0f || c === 0xfe0e) && (pict(k - 1) || (/[0-9#*]/.test(cps[k - 1] ? cps[k - 1][0] : "") && cps[k + 1] && cps[k + 1][0] === "⃣"))) continue;
    if (c === 0x200d && (pict(k - 1) || (cps[k - 1] && /[️]/.test(cps[k - 1][0]) && pict(k - 2))) && pict(k + 1)) continue;
    const listed = FORMAT_CHARS.some(([lo, hi]) => c >= lo && c <= hi) || BLANK_CHARS.some(([lo, hi]) => c >= lo && c <= hi);
    if (listed || /[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(ch) || (/\p{Cc}/u.test(ch))) at(s, e);
  }
  // three or more marks stacked on one letter (two is the most a written language needs, Vietnamese in decomposed form)
  for (const m of text.matchAll(/\p{L}\p{M}{3,}/gu)) at(m.index, m.index + m[0].length);
  // a word that mixes Latin letters with those of a script that has Latin look-alikes
  for (const m of text.matchAll(/[\p{L}\p{M}]+/gu)) {
    const wd = m[0];
    const latin = /\p{Script=Latin}/u.test(wd), other = LOOKALIKE_SCRIPTS.test(wd);
    if (latin && other) at(m.index, m.index + wd.length);
  }
  // Latin letters no written language uses, only phonetics or "fancy text" generators: small capitals ("ɴɪɢɢᴇʀ"), phonetic and
  // epigraphic letters. They read as plain letters to people but match no word list, so they are refused like other look-alikes
  for (const m of text.matchAll(LOOKALIKE_LATIN)) at(m.index, m.index + m[0].length);
  return issues;
}
const LOOKALIKE_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Lisu}\p{Script=Coptic}\p{Script=Canadian_Aboriginal}\p{Script=Tifinagh}\p{Script=Osage}\p{Script=Old_Italic}\p{Script=Runic}\p{Script=Glagolitic}\p{Script=Gothic}\p{Script=Deseret}]/u;
const LOOKALIKE_LATIN = /[\u0262\u026A\u0274\u0276\u0280\u0281\u028F\u0299\u029B\u029C\u029F\u1D00-\u1D2B\u1D6B-\u1D7F\u1D80-\u1D9A\uA730\uA731\uA7AE\uA7AF\uA7FA-\uA7FF\uAB46]+/gu;

/* ---------------------------------------------------------------- (a) the allow-list of characters */
// the scripts a city's own name can be written in (by the Unicode Script property of its letters); Latin is told apart below
const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Georgian", "Hebrew", "Arabic", "Syriac", "Thaana", "Devanagari", "Bengali", "Gurmukhi", "Gujarati",
  "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar", "Khmer", "Ethiopic", "Hangul", "Hiragana", "Katakana", "Han",
  "Mongolian"].map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")]);
const scriptOf = (ch) => { for (const [name, re] of SCRIPTS) if (re.test(ch)) return name; return null; };
/**
 * The letters written languages use in the Latin script beyond A to Z: Latin-1 and Latin Extended-A, the Vietnamese, Romanian, Pinyin,
 * Azerbaijani and Sami letters of Latin Extended-B, and Latin Extended Additional (Vietnamese, transliterations). NOT the phonetic and
 * IPA letters, small capitals, letters with hooks and strokes of Latin Extended-B to -E, or the medieval ones: those are what "fancy text"
 * generators are made of ("ɴɪɢɢᴇʀ", "ʇxǝʇ uʍop ǝpısdn", "ƝƗƓƓƐƦ", "₦ł₲₲ɆⱤ₴"). A city whose own name uses one of them may use that letter.
 */
const LATIN_LETTERS = /[À-ÖØ-öø-žƏƠơƯưǍ-ǜǞ-ǣǦ-ǭǴǵǸ-ǿȘ-țəḀ-ẛẞẠ-ỹ]/u;
/** The accents written languages put on a letter (decomposed text: at most two after a letter). Never strike-through, overlay or underline marks. */
const ACCENTS = /[̀-̛̣̌̏̑-̨̭̮̰̱]/u;
/** Everyday punctuation ($ only right before a ticker or an amount: "$UTICA", "$5"). */
const PUNCT = new Set([..."., !?'’‘\"“”«»„‚-‐–—:;()&%…¿¡"]);
/** Compatibility characters ordinary typing makes (NFKC rewrites them, but harmlessly): the ellipsis and the ordinal indicators of "1º", "2ª". */
const HARMLESS_COMPAT = new Set(["…", "º", "ª"]);
/** Punctuation of the scripts that have their own (only for a city written in them). */
const SCRIPT_PUNCT = { cjk: new Set([..."、。「」『』【】〈〉《》・ー〜，．！？：；（）"]), Arabic: new Set([..."،؛؟"]), Hebrew: new Set([..."־׳״"]), Devanagari: new Set([..."।॥"]) };
/**
 * The city's own words (its name, region and country, as the city list writes them) and the scripts they are written in, with the
 * scripts of its country (COUNTRY_SCRIPTS: the city list writes every name in Latin letters, so "Tokyo (東京)" needs Japan's).
 */
function ownLetters(ctx, lists = WORDS) {
  const c = (ctx && ctx.city) || {}, chars = new Set(), scripts = new Set(["Latin"]);
  for (const v of [c.name, c.region, c.countryName]) {
    for (const ch of String(v || "").normalize("NFC")) {
      chars.add(ch);
      if (/\p{L}/u.test(ch)) { const sc = scriptOf(ch); if (sc) scripts.add(sc); }
    }
  }
  const cc = String(c.country || "").toUpperCase();
  for (const row of lists.COUNTRY_SCRIPTS) {
    const [k, v] = row.split(":");
    if (k === cc && /^[A-Z]{2}$/.test(cc)) for (const sc of v.split(",")) if (SCRIPTS.some(([name]) => name === sc)) scripts.add(sc);
  }
  // Japanese is written with kanji and both kana, Korean with hangul and hanja: a city named in one of them may use all of its script set
  if (["Han", "Hiragana", "Katakana"].some((x) => scripts.has(x))) for (const x of ["Han", "Hiragana", "Katakana"]) scripts.add(x);
  if (scripts.has("Hangul")) scripts.add("Han");
  return { chars, scripts, cjk: ["Han", "Hiragana", "Katakana", "Hangul"].some((x) => scripts.has(x)) };
}
/** Is the character at `i` of `text` a plain one for this city (marks are judged by plainChars, with the letter before them)? */
function plainChar(ch, text, i, own) {
  if (ch === " " || ch === "\n") return true;
  if (own.cjk && SCRIPT_PUNCT.cjk.has(ch)) return true;
  for (const sc of ["Arabic", "Hebrew", "Devanagari"]) if (own.scripts.has(sc) && SCRIPT_PUNCT[sc].has(ch)) return true;
  // a compatibility form (full-width, mathematical, circled, squared, parenthesized, superscript, ligature...): not plain
  if (ch.normalize("NFKC") !== ch && !HARMLESS_COMPAT.has(ch)) return false;
  if (/[A-Za-z0-9]/.test(ch) || HARMLESS_COMPAT.has(ch) || PUNCT.has(ch)) return true;
  if (ch === "$") return /^[A-Z0-9]/.test(text.slice(i + 1, i + 2));
  if (own.chars.has(ch)) return true;
  if (!/[\p{L}\p{Nd}]/u.test(ch)) return false;
  const sc = scriptOf(ch);
  if (sc === "Latin") return /\p{L}/u.test(ch) && LATIN_LETTERS.test(ch);
  return Boolean(sc && own.scripts.has(sc));
}
/** (a) The runs of characters that are not plain for this city (see the header), one issue per run. */
function plainChars(text, ctx, lists = WORDS) {
  const own = ownLetters(ctx, lists), out = [];
  let run = null, letterOk = false, marks = 0;
  const bad = (s, e) => { if (run && run.end === s) run.end = e; else { run = { code: "characters", start: s, end: e }; out.push(run); } };
  for (const m of text.matchAll(/[\s\S]/gu)) {
    const ch = m[0], s = m.index, e = s + ch.length;
    let ok;
    if (/\p{M}/u.test(ch)) {
      // an accent of a written language right after a plain letter (two at most), or a mark of the city's own script
      const sc = /\p{Script=Inherited}/u.test(ch) ? null : scriptOf(ch);
      ok = letterOk && marks < 2 && (ACCENTS.test(ch) || (sc !== null && sc !== "Latin" && own.scripts.has(sc)) || own.chars.has(ch));
      marks++;
    } else {
      ok = plainChar(ch, text, s, own);
      letterOk = ok && /\p{L}/u.test(ch);
      marks = 0;
    }
    if (!ok) bad(s, e);
  }
  return out;
}

/* ---------------------------------------------------------------- (b) links and handles written with a space, a slash or a platform */
// "1st", "1990s", "5km", "24h", "1º"/"1ª" (folded "1o"/"1a"), "1er", "2e" (100x: the financial rule's)
const ORDINAL = /^\d+(?:st|nd|rd|th|s|k|km|m|kg|g|h|hr|hrs|am|pm|mph|min|ft|mi|ml|l|x|a|o|e|er|re|eme|ere)$/;
/** Does this word look like a handle or a domain: letters glued to digits ("utica22"), or the city's own name glued to a handle word? */
function handleLike(w, ownRaw, lists) {
  if (/[a-z]/.test(w) && /\d/.test(w)) return !ORDINAL.test(w) && !/^x\d+$/.test(w);
  for (const o of ownRaw) {
    if (o.length < 3 || w === o) continue;
    if (w.startsWith(o) && lists.HANDLE_SUFFIXES.includes(w.slice(o.length))) return true;
    if (w.endsWith(o) && lists.HANDLE_PREFIXES.includes(w.slice(0, w.length - o.length))) return true;
  }
  return false;
}
/** Where the city's own name, region or country stands in `text` as written ("Biel/Bienne", "Zanzibar Urban/West"): [start, end) spans. */
function ownSpans(text, ctx) {
  const c = (ctx && ctx.city) || {}, out = [];
  for (const v of [c.name, c.region, c.countryName]) {
    const p = String(v || "").normalize("NFC");
    if (p.length < 2) continue;
    for (const m of text.matchAll(new RegExp(p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "giu"))) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
/** The edit distance between a and b is at most 1 (one letter changed, added or left out). */
function oneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const SEP_GAP = /^[ \n]*[,\-_;:‐‑‒–—][ \n]*$/u; // a comma, a dash, a semicolon or a colon for a dot ("mvmoon,com", "t-me", "mvmoon - org")
const STOP_BEFORE_TLD = new Set(["us", "you", "me", "them", "it", "him", "her", "the", "a", "an", "our", "your", "home", "here", "there", "out", "up", "in", "on", "at", "to"]);
/**
 * (c) Links and handles that are not written as links (FLAG): see the header. `own`: the city's own words (skeleton form); `ownRaw`: as
 * written; `inOwn(s, e)`: is this span inside the city's own name, region or country as written (a slash in "Biel/Bienne" is the name's);
 * `unknown(t)`: a word the screener does not know (knownWords), which may be a domain's name or a platform's misspelled.
 */
function linkLike(units, lists, own, ownRaw, inOwn = () => false, unknown = () => false, known = new Set()) {
  const out = [];
  const add = (s, e) => out.push({ code: "link_like", start: s, end: e });
  const toks = words(units, { leet: false }), folded = str(units);
  const gap = (a, b) => folded.slice(a.j, b.i);
  const spaced = (a, b) => /^[ \n]+$/.test(gap(a, b));
  const dotLike = (a, b) => spaced(a, b) || SEP_GAP.test(gap(a, b));
  const isOwn = (t) => own.has(skel(t.w));
  const tlds = new Set(lists.SPACED_TLDS), web = new Set(lists.WEB_TLDS), iana = ianaTlds(), leads = new Set(lists.LINK_LEADS), dots = new Set(lists.DOT_WORDS);
  const platforms = new Set(lists.PLATFORMS.map(skel)), short = new Set(lists.PLATFORM_SHORT);
  const contact = new Set(lists.CONTACT_WORDS), me = new Set(lists.CONTACT_ME);
  const hosts = [...lists.LINK_HOSTS, ...lists.SPACED_HOSTS].map((h) => h.split(".")).filter((p) => p.length === 2);
  const glued = new Set(hosts.filter(([a]) => a.length >= 4).map(([a, b]) => a + b));
  // web endings that are also everyday words ("me", "to", "fun", "live") are read as one only after a lead word ("Visit mvmoon live")
  const plainWord = new Set(["me", "to", "fun", "live", "top", "club", "store", "shop", "page", "link", "so", "ai", "fi", "info", "site", "online", "app"]);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k], prev = k > 0 ? toks[k - 1] : null, prev2 = k > 1 ? toks[k - 2] : null, next = k + 1 < toks.length ? toks[k + 1] : null;
    const notOwnPair = prev && !(isOwn(prev) && isOwn(t)) && !isOwn(prev);
    // a word, a space, a web ending ("uticacoin com", "x com"); never a number before it ("50 cc") or the city's own words
    if (prev && tlds.has(t.w) && spaced(prev, t) && /[a-z]/.test(prev.w) && !(isOwn(prev) && isOwn(t))) add(prev.s, t.e);
    if (prev && /[a-z]/.test(prev.w) && notOwnPair && !STOP_BEFORE_TLD.has(prev.w)) {
      // a word, a comma, a dash or a colon, then a web ending ("mvmoon,com", "mvmoon - org", "moon-io")
      if (SEP_GAP.test(gap(prev, t)) && web.has(t.w) && !plainWord.has(t.w)) add(prev.s, t.e);
      // a word nobody knows, then any web ending ("mvmoon net", "mvmoon co", "mvmoon,app")
      if (dotLike(prev, t) && unknown(prev) && web.has(t.w)) add(prev.s, t.e);
      // "visit", "go to", "at", "on"... a word, then a web ending ("Visit mvmoon net", "at moon app")
      if (dotLike(prev, t) && web.has(t.w) && prev2 && (leads.has(prev2.w) || (prev2.w === "to" && k > 2 && toks[k - 3].w === "go"))) add(prev2.s, t.e);
    }
    // a word for the dot ("mvmoon period net", "uticacoin punto com"); two everyday words around it are a phrase ("polka dot art")
    if (prev && next && dots.has(t.w) && /[a-z]/.test(prev.w) && iana.has(next.w) && (unknown(prev) || !known.has(next.w) || !known.has(prev.w))) add(prev.s, next.e);
    // a link host with a space, a comma or a dash for its dot ("t me", "t-me", "t,me", "bit ly", "wa me", "linktr ee"), or glued ("discordgg")
    if (prev && dotLike(prev, t) && hosts.some(([a, b]) => prev.w === a && t.w === b)) add(prev.s, t.e);
    if (glued.has(t.w)) add(t.s, t.e);
    // a platform's name, with a look-alike letter ("teIegram", "dlscord") or one letter off when it is not a word ("telegrm", "twiter")
    const sk = skel(t.w);
    if (!isOwn(t) && (platforms.has(sk) || (unknown(t) && sk.length >= 5 && [...platforms].some((p) => p.length >= 5 && oneEdit(sk, p))))) add(t.s, t.e);
    // a platform's name split in two or three ("you tube", "face book", "tele gram", "tik tok", "snap chat", "whats app")
    for (let n = 2; n <= 3 && k + n <= toks.length; n++) {
      const run = toks.slice(k, k + n);
      if (!run.every((x, q) => q === 0 || dotLike(run[q - 1], x))) break;
      if (platforms.has(skel(run.map((x) => x.w).join("")))) add(run[0].s, run[n - 1].e);
    }
    // a short one only after "on", "follow", "join", "our"... (three words back at most: "on the gram", "join the Utica group chat")
    if (short.has(t.w) && !isOwn(t)) {
      const back = [prev, prev2, k > 2 ? toks[k - 3] : null].filter(Boolean).find((x) => contact.has(x.w));
      if (back) add(back.s, t.e);
    }
    // "DM me", "text us"
    if (next && me.has(t.w) && (next.w === "me" || next.w === "us") && spaced(t, next)) add(t.s, next.e);
    if (!isOwn(t) && handleLike(t.w, ownRaw, lists)) add(t.s, t.e);
  }
  // a slash between words or numbers: a path or a handle ("x com/uticacoin", "bit ly/utica22", "t me / utica")
  for (const m of folded.matchAll(/[a-z0-9][ \n]*[/⁄∕⧸][ \n]*[a-z0-9]/g)) {
    const sp = span(units, m.index, m.index + m[0].length);
    if (!inOwn(sp.start, sp.end)) add(sp.start, sp.end);
  }
  // letters, a dot and letters with no space after the dot ("mvmoon.sbs", "visit.utica"), whatever the ending: a person looks. Not an
  // abbreviation ("St.Louis", "Mt.Fuji", "Dr.Who") nor single letters ("U.S.A.", "e.g.", "a.m.")
  for (const m of dotted(units).tight.matchAll(/(?<![a-z0-9.])([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]+)/g)) {
    if (m[1].length === 1 || ABBREVIATIONS.has(m[1])) continue;
    const sp = span(units, m.index, m.index + m[0].length);
    if (!inOwn(sp.start, sp.end)) add(sp.start, sp.end);
  }
  return out.filter((x) => !inOwn(x.start, x.end));
}
/** Abbreviations written with a dot and no space before a name ("St.Louis", "Mt.Fuji", "Ft.Worth"). */
const ABBREVIATIONS = new Set(["st", "mt", "ft", "pt", "dr", "mr", "mrs", "ms", "jr", "sr", "no", "nos", "vs", "etc", "ave", "rd", "blvd", "gen", "gov", "prof", "rev",
  "sgt", "capt", "lt", "col", "co", "inc", "ltd", "corp", "dept", "univ", "approx", "est", "vol", "fig", "ph", "ste", "sta", "mte", "pte"]);

/** Endings that are a web address after "dot" even where they are also a word ("dot net", "dot com"): never "polka dot art". */
const LINK_ENDINGS = new Set(["com", "net", "org", "info", "biz", "app", "dev", "xyz", "gov", "edu", "mil", "int", "eth", "sol", "io", "co", "me", "tv", "gg", "ly"]);
/** Every top-level domain IANA lists (src/screen-vocab.js), and the hand-kept list (src/screen-words.js TLDS). */
let IANA = null;
const ianaTlds = () => IANA || (IANA = new Set(VOCAB.TLDS.split(" ")));
const tldSet = (lists) => new Set(lists.TLDS);
// the gTLDs a "word. com" (a dot, then a space) most likely means; only a flag (it is also how a sentence ends: "Utica. so good")
const DOT_SPACE_TLDS = new Set(["com", "net", "org", "io", "xyz", "app", "gg", "co", "me", "ly", "ai", "dev", "sol", "eth", "fun", "site", "online", "shop", "store", "live",
  "club", "info", "biz", "tv", "cc", "ws", "to", "sh", "so", "vc", "fm", "sbs", "cfd", "icu", "lol", "wtf", "vip", "top"]);
/**
 * The folded text with every character a browser or a reader takes for a dot written as one: `full` the full stops (ideographic "。",
 * its half-width form; NFKC already made "．", "﹒" and "․" a dot), `tight` also the middle dots and bullets ("uticacoin·com"), which
 * only count between two words with no space (a bullet between spaced words is a list: "food • art • music").
 */
function dotted(units) {
  const full = str(units).replace(/[。]/g, ".");
  return { full, tight: full.replace(/[·⸱・‧∙⋅•]/g, ".") };
}
function links(units, lists, text, known = new Set()) {
  const { full: t, tight: tt } = dotted(units), out = [];
  const add = (m, len = m[0].length, off = 0, severity) => out.push({ code: "link", ...span(units, m.index + off, m.index + off + len), ...(severity ? { severity } : {}) });
  // a scheme (also disguised: "hxxps"), "://", www.
  for (const m of t.matchAll(/https?\s*:|\bh(?:xx|tx|xt)ps?\b|:\s*\/\s*\/|www\s*\.|\bw\s+w\s+w\b/g)) add(m);
  const tlds = tldSet(lists), iana = ianaTlds();
  // name.tld: any top-level domain IANA lists right after a dot with no space ("mvmoon.sbs", "utica.io"; "St.Louis" ends in none)
  for (const m of tt.matchAll(/([a-z0-9][a-z0-9-]*)\.([a-z]{2,})(?![a-z0-9])/g)) if ((iana.has(m[2]) || tlds.has(m[2])) && !/^\d+$/.test(m[1])) add(m);
  // an obfuscated dot before a common ending (the hand-kept list): "name[.]com", "name(dot)com", "name dot com", "name dotcom",
  // "name d0t com"; a spaced "dot" only before an ending that is no everyday word ("polka dot art" is a phrase: linkLike reads the rest)
  for (const m of tt.matchAll(/([a-z0-9][a-z0-9-]*)(\s*\[\s*\.\s*\]\s*|\s*\(\s*\.\s*\)\s*|\s*[[({]\s*d[o0]t\s*[\])}]\s*|\s+d[o0]t\s*)([a-z]{2,})(?![a-z0-9])/g)) {
    if (tlds.has(m[3]) && !/^\d+$/.test(m[1]) && !(/^\s+d[o0]t\s*$/.test(m[2]) && known.has(m[3]) && m[3].length >= 3 && !LINK_ENDINGS.has(m[3]))) add(m);
  }
  // a dot with a space before it ("uticacoin . com", "uticacoin .com"): a sentence never puts one there
  for (const m of t.matchAll(/([a-z0-9][a-z0-9-]*)\s+\.\s*([a-z]{2,})(?![a-z0-9])/g)) if (tlds.has(m[2]) && !/^\d+$/.test(m[1])) add(m);
  // a dot, a space, then a web ending in small letters ("uticacoin. com"): flagged for a person (a sentence can end like that too)
  for (const m of t.matchAll(/([a-z0-9][a-z0-9-]*)\.\s+([a-z]{2,})(?![a-z0-9])/g)) {
    const at = m.index + m[0].length - m[2].length, first = units[at];
    if (DOT_SPACE_TLDS.has(m[2]) && first && /^\p{Ll}/u.test(text.slice(first.s, first.e))) add(m, m[0].length, 0, "flag");
  }
  for (const host of lists.LINK_HOSTS) {
    // a host whose first part is a real word ("discord gg", "linktr ee") is a link with a space or a "dot" for its dot too
    const [first, ...rest] = host.split(".");
    const dot = first.length >= 4 ? "(?:\\s*\\.\\s*|\\s+d[o0]t\\s+|\\s+)" : "\\s*\\.\\s*";
    const esc = [first, ...rest].join(dot);
    for (const m of tt.matchAll(new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "g"))) add(m);
  }
  return out;
}
function cryptoAddresses(text) {
  const out = [];
  const add = (m, s = m.index, e = m.index + m[0].length) => out.push({ code: "crypto_address", start: s, end: e });
  for (const m of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,}/g)) add(m); // as long as an address, or longer (an address run on with more)
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}/g)) add(m);
  for (const m of text.matchAll(/(?<![a-zA-Z0-9])bc1[a-zA-Z0-9]{25,59}(?![a-zA-Z0-9])/g)) add(m);
  for (const m of text.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[13][1-9A-HJ-NP-Za-km-z]{25,34}(?![1-9A-HJ-NP-Za-km-z])/g)) if (/[A-Za-z]/.test(m[0])) add(m);
  return out;
}
function contacts(units) {
  const t = dotted(units).tight, out = [];
  const add = (m, len = m[0].length, severity) => out.push({ code: "contact", ...span(units, m.index, m.index + len), ...(severity ? { severity } : {}) });
  // a handle after a platform's name and a colon, a slash or an @ ("Instagram: uticacoin", "discord / utica", "tg @utica")
  for (const m of t.matchAll(/\b(?:discord|telegram|tg|instagram|insta|ig|twitter|tiktok|snapchat|whatsapp|wechat|reddit|youtube|yt|facebook|fb|threads|bluesky|bsky)\s*(?::|\/|\bslash\b|@)\s*@?[a-z0-9_.]{3,}/g)) add(m);
  // "@ uticacoin": an @ and a space before a name; flagged for a person ("meet @ the park" is not a handle)
  for (const m of t.matchAll(/(?<![a-z0-9_@.])@\s+[a-z0-9_]{3,}/g)) add(m, m[0].length, "flag");
  for (const m of t.matchAll(/[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)*\s*\.\s*[a-z]{2,}/g)) add(m);
  for (const m of t.matchAll(/\+?\(?\d[\d\s().-]{6,}\d/g)) if ((m[0].match(/\d/g) || []).length >= 9) add(m);
  for (const m of t.matchAll(/(?<![a-z0-9_@.])@[a-z0-9_]{2,}/g)) add(m);
  for (const m of t.matchAll(/\b(?:dm|pm|message|text|call|contact|ping|whatsapp|telegram|signal)\s+(?:me|us)\b(?=\s*(?:[:,-]\s*)?(?:on|at|via)?\s*(?:telegram|whatsapp|discord|instagram|insta|twitter|tiktok|snapchat|signal|wechat|x\b|@|\+?\d))/g)) add(m);
  return out;
}
function streetAddresses(text, lists) {
  const out = [];
  const alt = lists.STREET_WORDS.map((w) => w.replace(/\./g, "\\.")).flatMap((w) => [w, w[0].toUpperCase() + w.slice(1), w.toUpperCase()]).join("|");
  const add = (m) => out.push({ code: "street_address", start: m.index, end: m.index + m[0].length });
  // 12 Main Street, 1600 Pennsylvania Ave, 350 5th Avenue
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,5}[A-Za-z]?,?\\s+(?:(?:\\p{Lu}[\\p{L}'’.-]*|\\d{1,3}(?:st|nd|rd|th))\\s+){1,3}(?:${alt})(?![\\p{L}\\p{N}])\\.?`, "gu"))) add(m);
  // Calle Mayor 5, Rue de Rivoli 12, Via Roma 1
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(?:Calle|Carrera|Avenida|Rua|Rue|Via|Viale|Corso|Piazza|Ulica|Utca|Caddesi|Sokak|Jalan|Jl\.?)\s+(?:[\p{L}'’.-]+\s+){1,3}\d{1,5}(?![\p{L}\p{N}])/giu)) add(m);
  // Hauptstraße 5, Kalverstraat 12
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])\p{L}+(?:straße|strasse|str\.|weg|platz|gasse|allee|laan|straat|gracht)\s+\d{1,4}[a-z]?(?![\p{L}\p{N}])/giu)) add(m);
  return out;
}
function financialNumbers(units) {
  const out = [];
  // a word with a digit in it, digits read as digits (o 0, i l 1): 100x, 1OOx, x100, 10000%
  for (const t of words(units, { leet: false })) {
    if (!/\d/.test(t.w)) continue;
    const n = t.w.replace(/o/g, "0").replace(/[il]/g, "1");
    if (/^\d+x$/.test(n) || /^x\d{2,}$/.test(n)) out.push({ code: "financial", start: t.s, end: t.e });
  }
  const s = str(units);
  for (const m of s.matchAll(/(?<![a-z0-9])\d+\s*x(?![a-z0-9])|(?<![a-z0-9])x\s*\d{2,}(?![a-z0-9])/g)) out.push({ code: "financial", ...span(units, m.index, m.index + m[0].length) });
  return out;
}
function spam(text) {
  const out = [];
  const plain = text.replace(/\$[A-Za-z][A-Za-z0-9]{0,9}/g, ""); // a ticker is written in capitals: it is not shouting
  const letters = (plain.match(/\p{L}/gu) || []).length, caps = (plain.match(/\p{Lu}/gu) || []).length;
  if (letters > 20 && caps / letters > 0.6) out.push({ code: "spam", start: 0, end: text.length });
  for (const m of text.matchAll(/(\S)\1{5,}/gu)) out.push({ code: "spam", start: m.index, end: m.index + m[0].length });
  const emoji = [...text.matchAll(/\p{Extended_Pictographic}/gu)];
  if (emoji.length > 8) out.push({ code: "spam", start: emoji[0].index, end: text.length });
  return out;
}
function tickers(text, ctx, lists) {
  const own = String((ctx && ctx.ticker) || "").toUpperCase();
  const okay = new Set([own, ...lists.OK_TICKERS]);
  const out = [], spans = [];
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{0,9})(?![A-Za-z0-9])/g)) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (!okay.has(m[1].toUpperCase())) out.push({ code: "other_city", start: m.index, end: m.index + m[0].length });
  }
  return { issues: out, spans };
}
/** "Syracuse coin", "the Albany token": another registry city's name right before coin or token (ctx.otherCity(name) says which are). */
function otherCityCoins(toks, original, ctx, own) {
  if (!ctx || typeof ctx.otherCity !== "function") return [];
  const out = [];
  for (let k = 1; k < toks.length; k++) {
    if (!/^(coin|coins|token|tokens)$/.test(toks[k].w)) continue;
    for (let n = 1; n <= 3 && k - n >= 0; n++) {
      const part = toks.slice(k - n, k);
      if (!/^\p{Lu}/u.test(original.slice(part[0].s, part[0].e))) continue; // a name is written with a capital
      if (part.every((t) => own.has(skel(t.w)))) continue;
      const name = original.slice(part[0].s, part[part.length - 1].e);
      if (ctx.otherCity(name)) { out.push({ code: "other_city", start: part[0].s, end: toks[k].e }); break; }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- (b) the words the screener knows (ENGINE 4) */
/** The plain words of a phrase, as written (no i/l skeleton): for the vocabulary. */
const rawWords = (s) => words(fold(String(s || "")), { leet: false }).map((x) => x.w);
/** A word with its plurals ("kike" "kikes" "kikez", "tranny" "trannies"). */
const formsOf = (w) => [w, `${w}s`, `${w}z`, ...(/(?:[sxz]|ch|sh)$/.test(w) ? [`${w}es`] : []), ...(/[^aeiou]y$/.test(w) ? [`${w.slice(0, -1)}ies`] : [])];
const vocabCache = new WeakMap(); // lists -> { known, everyday, pairs }: built once per list set (the first screening of a server)
/**
 * The vocabulary. `everyday`: SCOWL's English (src/screen-vocab.js ENGLISH, without any word that has a DENY_PARTS piece in it:
 * "fuckhead"), PROPER_WORDS and EXTRA_WORDS. `known`: those, and the names of the dictionary (NAMES: "Broadway", "Beatles") and the
 * place words of the city list (PLACES). Neither has any slur of SLURS or FOREIGN_SLURS in any plural, VOCAB_DENY or the PAIR_ONLY words
 * (known only in their VOCAB_PAIRS). The lists decide, so a stand-in list set has its own vocabulary.
 */
function vocabOf(lists) {
  let v = vocabCache.get(lists);
  if (v) return v;
  const parts = new RegExp(lists.DENY_PARTS.map((p) => p.replace(/[^a-z]/g, "")).filter(Boolean).join("|") || "(?!)");
  const everyday = new Set(VOCAB.ENGLISH.split(" ").filter((w) => !parts.test(w)));
  for (const e of [...lists.PROPER_WORDS, ...lists.EXTRA_WORDS]) for (const w of rawWords(e)) everyday.add(w);
  const known = new Set(everyday);
  for (const w of `${VOCAB.NAMES} ${VOCAB.PLACES}`.split(" ")) if (w && !parts.test(w)) known.add(w);
  for (const w of VOCAB.PLACES.split(" ")) if (w) known.add(w); // a place keeps its name ("Scunthorpe")
  const deny = new Set([...lists.VOCAB_DENY, ...lists.PAIR_ONLY]);
  for (const e of [...lists.SLURS, ...lists.FOREIGN_SLURS]) { const p = rawWords(e); for (const f of formsOf(p.join(""))) deny.add(f); if (p.length === 1) for (const f of formsOf(p[0])) deny.add(f); }
  for (const w of deny) { known.delete(w); everyday.delete(w); }
  v = { known, everyday, pairs: new Set(lists.VOCAB_PAIRS.map((e) => rawWords(e).join(" "))) };
  vocabCache.set(lists, v);
  return v;
}
const otherScript = (s) => [...s].some((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch));
/**
 * (b) Every word must be a known one (see the header). `skip(s, e)`: the city's own name as written, a $TICKER. Answers the issues
 * ("words", or "language" for a word in another script) and the unknown words { w, s, e } (slurLike reads them, linkLike too).
 */
function knownWords(text, units, ctx, lists, skip) {
  const { known, everyday, pairs } = vocabOf(lists);
  const ownRaw = ownRawWords(ctx), sufs = lists.DEMONYM_SUFFIXES;
  const demonym = (w) => { for (const o of ownRaw) if (o.length >= 3 && w.length > o.length && w.startsWith(o) && sufs.includes(w.slice(o.length))) return true; return false; };
  const isKnown = (w) => known.has(w) || ownRaw.has(w) || demonym(w);
  const folded = str(units), toks = [];
  for (const m of folded.matchAll(/[a-z0-9]+/g)) toks.push({ w: m[0], i: m.index, j: m.index + m[0].length, ...((sp) => ({ s: sp.start, e: sp.end }))(span(units, m.index, m.index + m[0].length)) });
  const joinedBy = (a, b, re) => a && b && re.test(folded.slice(a.j, b.i));
  // the runs of letters of another script ("Москва", "東京は"): one "language" issue each, whole (a look-alike may fold part of it to A to Z)
  const scriptRuns = [];
  for (const m of text.matchAll(/[\p{L}\p{M}]+/gu)) if (otherScript(m[0]) && !skip(m.index, m.index + m[0].length)) scriptRuns.push({ s: m.index, e: m.index + m[0].length });
  const issues = [], unknown = [], pairSpans = [];
  let everydayCount = 0;
  const contact = new Set(lists.NAME_GUARD_WORDS);
  const flag = (t, k) => {
    // a word written as a name (capital, then small letters: "Fenway", "Alfama") may be one: nameCandidate, decided in run()
    const raw = text.slice(t.s, t.e);
    t.name = k != null && /^\p{Lu}\p{Ll}{2,}$/u.test(raw) && !/[^A-Za-zÀ-ÖØ-öø-ÿ]/.test(raw) && ![k - 1, k - 2, k - 3].some((q) => q >= 0 && contact.has(toks[q].w));
    unknown.push(t);
    if (!scriptRuns.some((r) => r.s < t.e && t.s < r.e)) issues.push({ code: "words", start: t.s, end: t.e });
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (skip(t.s, t.e)) continue;
    if (everyday.has(t.w)) everydayCount++;
    if (/^\d+$/.test(t.w) || (/\d/.test(t.w) && /[a-z]/.test(t.w) && ORDINAL.test(t.w))) continue;
    if (t.w.length === 1) {
      // three or more single letters in a row ("n i g g e r", "s.c.a.m", "U.S.A."): read as one word
      let q = k;
      while (q + 1 < toks.length && toks[q + 1].w.length === 1 && /[a-z]/.test(toks[q + 1].w) && /^[^a-z0-9]{1,3}$/.test(folded.slice(toks[q].j, toks[q + 1].i))) q++;
      if (q - k >= 2 && /[a-z]/.test(t.w)) {
        const w = toks.slice(k, q + 1).map((x) => x.w).join("");
        if (!isKnown(w)) flag({ w, i: t.i, j: toks[q].j, s: t.s, e: toks[q].e });
        k = q;
      }
      continue;
    }
    if (isKnown(t.w)) continue;
    const prev = toks[k - 1], next = toks[k + 1], pairGap = /^[ \-‐‑–]{1,2}$/u;
    if (joinedBy(prev, t, pairGap) && pairs.has(`${prev.w} ${t.w}`)) { pairSpans.push([prev.s, t.e]); continue; }
    if (joinedBy(t, next, pairGap) && pairs.has(`${t.w} ${next.w}`)) { pairSpans.push([t.s, next.e]); continue; }
    flag(t, k);
  }
  // words of a script that does not fold to A to Z, or only partly (Japanese, Arabic, Thai, Cyrillic...): read by a person
  for (const r of scriptRuns) issues.push({ code: "language", start: r.s, end: r.e });
  return { issues, unknown, pairSpans, everydayCount };
}
/**
 * The names a description may carry without a person reading them first (a landmark, a dish, a team: "Fenway", "Alfama", "Primanti"):
 * only in a sentence of everyday English (five everyday words at least, three for each name), at most NAMES_MAX of them, each written
 * as a name (a capital, then small letters), never right after "follow", "message", "join"... (a handle), and never one any other rule
 * read anything in (a slur spelled another way, a platform, a link, a handle, a financial word misspelled). Anything else unknown, a
 * word in small letters among them, goes to a person.
 */
const NAMES_MAX = 3;
// what a handle or a coin's account is made of ("Mvmoon", "Moonboys", "Gemtoken", "Solcats"): never taken for a name
const HANDLE_PART = /coin|token|moon|pump|cash|money|swap|meme|crypto|official|finance|bonk|doge|pepe|inu|elon|lambo|gem|degen|chad|^(?:the|real|get|join|visit|my|go|buy|we)|(?:dao|nft|sol|dex|app|bot|dev|xyz|io|hq|tv|fm|fans|army|gang|club|labs|news|boys|bros|cats|dogs|ai)$/;
function allowedNames(kw, issues, ownRaw) {
  const ok = (t) => t.name && t.w.length >= 5 && !HANDLE_PART.test(t.w) && ![...ownRaw].some((o) => o.length >= 3 && t.w !== o && (t.w.startsWith(o) || t.w.endsWith(o)))
    && !issues.some((x) => x.code !== "words" && x.start < t.e && t.s < x.end);
  const cands = kw.unknown.filter(ok);
  if (!cands.length || cands.length !== kw.unknown.length || cands.length > NAMES_MAX || kw.everydayCount < 5 || cands.length * 3 > kw.everydayCount) return [];
  return cands;
}

/* ---------------------------------------------------------------- slurs, financial words and platforms spelled another way */
/** A slur's skeleton: q read as g ("niqqer"), ph as f ("phaggot"), doubled letters once ("nigggers", "niiggers"). */
const slurSkel = (w) => w.replace(/ph/g, "f").replace(/q/g, "g").replace(/(.)\1+/g, "$1");
const vowelSkel = (w) => w.replace(/[aeiouy]+/g, "*");
const collapse = (w) => w.replace(/(.)\1+/g, "$1");
/** The word, and the word without a plural or a slang ending ("trannies" "tranny", "niggerlover" "nigger", "spicboys" "spic"). */
function stems(w) {
  const out = new Set([w]);
  if (w.length > 4 && w.endsWith("ies")) out.add(`${w.slice(0, -3)}y`);
  for (const suf of ["lovers", "lover", "boys", "boy", "ish", "es", "s", "z"]) if (w.length > suf.length + 2 && w.endsWith(suf)) out.add(w.slice(0, -suf.length));
  for (const x of [...out]) if (x.length > 3 && /[sz]$/.test(x)) out.add(x.slice(0, -1)); // "niggerslover"
  return [...out];
}
const slurCache = new WeakMap();
function slurIndex(lists) {
  let x = slurCache.get(lists);
  if (x) return x;
  const exact = new Map(), long = [], foreign = new Set();
  for (const e of lists.SLURS) { const k = slurSkel(rawWords(e).join("")); if (k) { exact.set(k, e); if (k.length >= 5) long.push(k); } }
  for (const e of lists.FOREIGN_SLURS) { const w = rawWords(e).join(""); for (const f of formsOf(w)) foreign.add(f); }
  const fin = lists.FINANCIAL.map(rawWords).filter((p) => p.length === 1 && p[0].length >= 6).map((p) => collapse(p[0]));
  const abuse = new Set(lists.ABUSE.map(rawWords).filter((p) => p.length === 1).map((p) => slurSkel(p[0])));
  x = { exact, long, foreign, fin, abuse, singles: compile(lists.SLURS).singles };
  slurCache.set(lists, x);
  return x;
}
/**
 * Unknown words read against the slurs spelled another way: its skeleton is a listed slur's (five letters or more: "niqqers",
 * "phaggots", "trannies", "niggerlover"): REFUSED ("slur"); a near one (a slur inside it, the same letters with other vowels, one letter
 * left out: "faggits", "niggrs"), a short one, or another language's: FLAGGED ("slur_like"). Also a financial word misspelled
 * ("guaranteeed": "financial"). The word is flagged as unknown anyway; this says why.
 */
function slurLike(unknown, lists, own, rules) {
  const ix = slurIndex(lists), out = [];
  for (const t of unknown) {
    const read = /[a-z]/.test(t.w) ? t.w.replace(/[013457]/g, (c) => LEET[c]) : t.w;
    if (own.has(skel(read))) continue;
    const ks = stems(read).map(slurSkel);
    let code = null;
    // the skeleton of a listed slur of five letters or more, or a listed slur exactly once q is read as g and ph as f ("niqqa")
    if (ks.some((k) => k.length >= 5 && ix.exact.has(k)) || listWord(ix.singles, skel(read.replace(/q/g, "g").replace(/ph/g, "f")))) code = "slur";
    else if (ix.foreign.has(read) || ix.foreign.has(t.w) || ks.some((k) => ix.exact.has(k)) || ks.some((k) => ix.long.some((l) => k.includes(l)
      || (k.length >= 5 && vowelSkel(k) === vowelSkel(l)) || (k.length === l.length - 1 && oneEdit(k, l))))) code = "slur_like";
    if (code && rules.has("slur")) out.push({ code, start: t.s, end: t.e });
    // an insult of the lists spelled another way ("Retardd", "Idiott", "Gypp"): flagged as one
    else if (rules.has("abuse") && ks.some((k) => k.length >= 3 && ix.abuse.has(k))) out.push({ code: "abuse", start: t.s, end: t.e });
    const c = collapse(read);
    if (rules.has("financial") && c.length >= 6 && ix.fin.some((f) => c === f || oneEdit(c, f))) out.push({ code: "financial", start: t.s, end: t.e });
  }
  return out;
}

/* ---------------------------------------------------------------- hate, wallet asks, money promises (ENGINE 4) */
/** The sentence each word is in (a full stop, a question or exclamation mark, a semicolon or a line break ends one). */
function sentences(toks, units) {
  const folded = str(units), out = [];
  let n = 0, last = 0;
  for (const t of toks) { if (/[.!?;\n]/.test(folded.slice(last, t.i))) n++; out.push(n); last = t.j; }
  return out;
}
/**
 * Hate written in ordinary words: a group of people (GROUP_WORDS) within four words of a violent or dehumanising word (VIOLENCE_WORDS)
 * in the same sentence ("gas the Jews", "gays should be stoned"); a group, then an exclusion ("Jews out", "gays go home"); "no Jews
 * allowed"; a violent word aimed at "them", "all", "every"... ("lynch them all", "hang every Mexican"). FLAG ("abuse").
 */
function hateNear(words0, units, lists) {
  // single letters joined by separators read as one word ("J.e.w.s out", "g-a-s the Jews")
  const folded = str(units), toks = [];
  for (let k = 0; k < words0.length; k++) {
    let q = k;
    while (q + 1 < words0.length && words0[q].w.length === 1 && words0[q + 1].w.length === 1 && TIGHT.test(folded.slice(words0[q].j, words0[q + 1].i))) q++;
    toks.push(q > k ? { w: words0.slice(k, q + 1).map((x) => x.w).join(""), s: words0[k].s, e: words0[q].e, i: words0[k].i, j: words0[q].j } : words0[k]);
    k = q;
  }
  const out = [], sent = sentences(toks, units), w = (k) => (k >= 0 && k < toks.length ? toks[k].w : null);
  const group = new Set(lists.GROUP_WORDS), violent = new Set(lists.VIOLENCE_WORDS), excl = lists.EXCLUSION_AFTER.map(rawWords);
  const add = (a, b) => out.push({ code: "abuse", start: toks[Math.min(a, b)].s, end: toks[Math.max(a, b)].e });
  const harmless = (k) => ["hang", "hanging", "hanged"].includes(w(k)) && ["out", "around", "about", "on", "up"].includes(w(k + 1));
  for (let g = 0; g < toks.length; g++) {
    if (!group.has(w(g))) continue;
    for (let d = -4; d <= 4; d++) {
      const k = g + d;
      if (d && k >= 0 && k < toks.length && sent[k] === sent[g] && violent.has(w(k)) && !harmless(k)) { add(g, k); break; }
    }
    for (const p of excl) if (p.length && p.every((x, q) => w(g + 1 + q) === x && sent[g + 1 + q] === sent[g])) add(g, g + p.length);
    const no = [g - 1, g - 2].find((k) => w(k) === "no" && sent[k] === sent[g]);
    const ok = [g + 1, g + 2, g + 3].find((k) => ["allowed", "welcome", "permitted", "wanted"].includes(w(k)) && sent[k] === sent[g]);
    if (no !== undefined && ok !== undefined) add(no, ok);
    else if (w(g - 1) === "no") add(g - 1, g); // "no Jews", "no blacks": a group of people turned away
    if (w(g - 1) === "only" || w(g + 1) === "only") add(w(g - 1) === "only" ? g - 1 : g, w(g + 1) === "only" ? g + 1 : g); // "only whites", "Christians only"
  }
  for (let k = 0; k + 1 < toks.length; k++) {
    if (violent.has(w(k)) && !harmless(k) && ["them", "all", "every", "those", "these", "each"].includes(w(k + 1))) add(k, k + 1);
  }
  return out;
}
/**
 * "Send 1 SOL", "deposit some coins", "transfer your tokens"; "connect", "verify", "sync"... within four words of "wallet" ("verify
 * ownership of your wallet", "connect your Phantom wallet"). WALLET_ASK has the phrases: "seed phrase", "claim free"...
 */
function walletAsk(units) {
  const f = str(units), out = [];
  const add = (m) => out.push({ code: "wallet_ask", ...span(units, m.index, m.index + m[0].length) });
  for (const m of f.matchAll(/\b(?:send|sends|sending|transfer|transfers|deposit|deposits|pay|pays)\s+(?:(?:\d[\d.,]*|some|any|all|your|a|an|one|two|three|five|ten|us|me|him|her|them|the|founder)\s+){0,3}(?:sol|solana|usdc|usdt|eth|btc|bitcoin|crypto|coins?|tokens?|money|dollars?|bucks|cash)\b/g)) add(m);
  for (const m of f.matchAll(/\b(?:connect|connecting|link|linking|validate|validating|verify|verifying|sync|syncing|synchronize|synchronise|rectify|restore|import|unlock|authenticate|activate|register|whitelist|approve|migrate)\b(?:\W+[a-z0-9]+){0,4}?\W+wallets?\b/g)) add(m);
  return out;
}
const REWARD = /\b(?:earn|earns|earned|earning|earnings|yield|yields|stake|staked|staking|reward|rewards|payout|payouts|pay|pays|paid|interest|return|returns|profit|profits|gain|gains|apy|apr|roi|income|bonus|bonuses|dividend|dividends|cashback|holding|holders?)\b/;
const PERIOD = /\b(?:daily|weekly|monthly|yearly|annually|annual|(?:every|each|per|a)\s+(?:day|week|month|year|hour))\b/;
/**
 * Promises of money in ordinary words: a percentage or a period with a reward ("Holders earn 20% every week", "300 percent yearly
 * yield"), getting more back ("get 2 SOL back"), a price target ("Utica to $1"). FLAG ("financial").
 */
function moneyPromises(units) {
  const f = str(units), out = [];
  const add = (m) => out.push({ code: "financial", ...span(units, m.index, m.index + m[0].length) });
  if (REWARD.test(f)) {
    for (const m of f.matchAll(/\d[\d.,]*\s*(?:%|percent\b|per\s+cent\b|pct\b)/g)) add(m);
    for (const m of f.matchAll(new RegExp(PERIOD.source, "g"))) add(m);
  }
  for (const m of f.matchAll(/\b(?:get|gets|receive|receives|earn|earns)\s+(?:\d[\d.,]*|double|twice|two|three|ten|more)\b[^.!?\n]{0,30}?\bback\b/g)) add(m);
  for (const m of f.matchAll(/\b(?:to|hit|hits|reach|reaches|worth|at|be|soon)\s+(?:\$\s*\d|\d[\d.,]*\s*(?:dollars?|usd|bucks|cents?)\b)/g)) add(m);
  // an amount of money with a period ("make $1,000 weekly", "1 SOL a day")
  if (PERIOD.test(f)) for (const m of f.matchAll(/(?:\$\s*\d[\d.,]*|\b\d[\d.,]*\s*(?:dollars?|usd|usdc|bucks|sol|solana|eth|btc)\b)/g)) add(m);
  return out;
}

/* ---------------------------------------------------------------- the pipeline */
/** The city's own words (name, region, country, ticker): never counted against it. */
function ownWords(ctx) {
  const c = (ctx && ctx.city) || {};
  const set = new Set();
  for (const v of [c.name, c.region, c.countryName, c.country, ctx && ctx.ticker, ctx && ctx.name]) {
    const p = phraseWords(v);
    for (const w of p) set.add(w);
    if (p.length > 1) set.add(p.join("")); // "New York" written "NewYork"
  }
  return set;
}
/** The same words as they are written (no i/l skeleton), for the handle rule: "uticacoin" starts with "utica". */
function ownRawWords(ctx) {
  const c = (ctx && ctx.city) || {};
  const set = new Set();
  for (const v of [c.name, c.region, c.countryName, ctx && ctx.ticker, ctx && ctx.name]) {
    const p = words(fold(String(v || "")), { leet: false }).map((x) => x.w);
    for (const w of p) set.add(w);
    if (p.length > 1) set.add(p.join(""));
  }
  return set;
}
function run(text, ctx, { rules, lists }) {
  const issues = [];
  const push = (list) => { for (const x of list) issues.push({ code: x.code, severity: x.severity || SEVERITY[x.code], start: x.start, end: x.end }); };
  const hidden = rules.has("hidden_chars") ? hiddenChars(text) : [];
  push(hidden);
  // (a) the allow-list of characters: a run of characters that are not plain, unless it is already refused as hidden characters
  const chars = rules.has("characters") ? plainChars(text, ctx, lists).filter((x) => !hidden.some((h) => h.start <= x.start && h.end >= x.end)) : [];
  push(chars);
  const units = fold(text);
  const tk = tickers(text, ctx, lists);
  const toks = words(units, { tickers: tk.spans }), joins = [...joined(units), ...variants(units, { tickers: tk.spans })];
  const own = ownWords(ctx);
  const ownAt = ownSpans(text, ctx);
  const inOwn = (s, e) => ownAt.some(([a, b]) => a <= s && e <= b), inTicker = (s, e) => tk.spans.some((x) => x.start <= s && e <= x.end);
  // (b) the allow-list of words: an unknown word is flagged (a character already flagged or refused says it first); the names it may
  // carry are decided at the end, once every other rule has read them
  const kw = knownWords(text, units, ctx, lists, (s, e) => inOwn(s, e) || inTicker(s, e));
  const unknownAt = new Set(kw.unknown.map((t) => `${t.s}:${t.e}`));
  const { known } = vocabOf(lists);
  if (rules.has("link")) push(links(units, lists, text, known));
  // (c) links and handles not written as links
  if (rules.has("link_like")) push(linkLike(units, lists, own, ownRawWords(ctx), inOwn, (t) => unknownAt.has(`${t.s}:${t.e}`), known));
  if (rules.has("crypto_address")) push(cryptoAddresses(text));
  if (rules.has("contact")) push(contacts(units));
  if (rules.has("street_address")) push(streetAddresses(text, lists));
  const tag = (code, hits) => hits.map((h) => ({ code, start: h.start, end: h.end }));
  // (d) the lists. A slur found only by joining words across a space ("ni gger", but also "go ok") is flagged for a person, never passed
  if (rules.has("slur")) { const hits = matchList(lists.SLURS, toks, joins, own); push(tag("slur", hits.filter((h) => !h.spaced))); push(tag("abuse", hits.filter((h) => h.spaced))); }
  push(slurLike(kw.unknown, lists, own, rules));
  // a word of a known pair is that pair's ("honky tonk" is music, never "honky")
  const inPair = (h) => kw.pairSpans.some(([a, b]) => a <= h.start && h.end <= b);
  if (rules.has("abuse")) { push(tag("abuse", matchList(lists.ABUSE, toks, joins, own).filter((h) => !inPair(h)))); push(hateNear(toks, units, lists)); }
  if (rules.has("wallet_ask")) { push(tag("wallet_ask", matchList(lists.WALLET_ASK, toks, [], own))); push(walletAsk(units)); }
  if (rules.has("other_city")) { push(tk.issues); push(otherCityCoins(toks, text, ctx, own)); }
  if (rules.has("brand")) {
    const ties = new Set(lists.TIE_WORDS.flatMap(phraseWords)), bodyTies = new Set(lists.BODY_TIE_WORDS.flatMap(phraseWords));
    push(tag("brand", matchList(lists.BRANDS, toks, [], own).filter((h) => near(toks, h, 3).some((w) => ties.has(w)))));
    push(tag("brand", matchList(lists.PUBLIC_BODIES, toks, [], own).filter((h) => near(toks, h, 3).some((w) => bodyTies.has(w)))));
    push(tag("brand", matchList(lists.OFFICIAL_CLAIMS, toks, [], own)));
  }
  if (rules.has("staff")) {
    const staff = new Set(lists.STAFF_WORDS.flatMap(phraseWords));
    const vic = [...toks, ...joins].filter((t) => skel(t.w) === skel("vicinity") || skel(t.w) === skel("vicinitys"));
    push(vic.filter((t) => near(toks, { start: t.s, end: t.e }, 3).some((w) => staff.has(w))).map((t) => ({ code: "staff", start: t.s, end: t.e })));
    push(tag("staff", matchList(lists.STAFF_ALONE, toks, [], own)));
  }
  if (rules.has("financial")) { push(tag("financial", matchList(lists.FINANCIAL, toks, joins, own))); push(financialNumbers(units)); push(moneyPromises(units)); }
  if (rules.has("spam")) push(spam(text));
  if (rules.has("words")) {
    const names = allowedNames(kw, issues, ownRawWords(ctx));
    push(kw.issues.filter((x) => ![...hidden, ...chars].some((h) => h.start < x.end && x.start < h.end) && !names.some((t) => t.s === x.start && t.e === x.end)));
  }
  // one issue per code and span, in reading order; a flag inside a refused link, address or contact says nothing more ("utica.io": link)
  const seen = new Set();
  const refused = issues.filter((x) => ["link", "contact", "crypto_address"].includes(x.code) && x.severity === "block");
  return issues.filter((x) => !(["link_like", "words"].includes(x.code) && refused.some((r) => r.start <= x.start && x.end <= r.end)))
    .filter((x) => { const k = `${x.code}:${x.start}:${x.end}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.code.localeCompare(b.code));
}
const ALL = ["hidden_chars", "characters", "words", "link", "link_like", "crypto_address", "contact", "street_address", "slur", "abuse", "wallet_ask", "other_city", "brand",
  "staff", "financial", "spam"];
/** The rules each target runs: a ticker is no word of a language (no "words" rule), but a slur spelled another way still refuses it. */
const RULES_OF = {
  description: ALL, name: ALL.filter((r) => r !== "spam"), ticker: ALL.filter((r) => r !== "spam" && r !== "words"), reason: ["hidden_chars"],
};
const verdict = (issues) => (issues.some((x) => x.severity === "block") ? "block" : issues.length ? "flag" : "pass");

/**
 * Screen `raw` as a `target` ("description", "name", "ticker", "reason"). `ctx`: { city: { name, region, countryName, country }, ticker,
 * otherCity?(name) => bool, rulesVersion? (the version the caller expects: another one is an error), lists? (tests: a stand-in for
 * src/screen-words.js) }. Never throws.
 */
export function screen(target, raw, ctx = {}) {
  let text = null, rulesVersion = RULES_VERSION;
  try {
    const lists = ctx.lists || WORDS;
    if (ctx.lists) rulesVersion = `s1-${sha256Sync(listsText(lists)).slice(0, 12)}`;
    for (const k of LIST_NAMES) if (!Array.isArray(lists[k])) throw new Error(`list ${k} missing`);
    if (ctx.rulesVersion && ctx.rulesVersion !== rulesVersion) throw new Error("rules version mismatch");
    text = cleanText(typeof raw === "string" ? raw : "", 100_000);
    if (text == null) throw new Error("unreadable text");
    const issues = [];
    const cps = [...text].length, lines = text.split("\n").length, bytes = new TextEncoder().encode(text).length;
    if (target === "description") {
      if (cps < DESCRIPTION_MIN || cps > DESCRIPTION_MAX || lines > DESCRIPTION_LINES || bytes > DESCRIPTION_BYTES) issues.push({ code: "length", severity: "block", start: 0, end: text.length });
    } else if (target === "reason") {
      if (cps < REASON_MIN || cps > REASON_MAX) issues.push({ code: "length", severity: "block", start: 0, end: text.length });
    } else if (target !== "name" && target !== "ticker") throw new Error("unknown target");
    const rules = new Set(RULES_OF[target]);
    issues.push(...run(text, ctx, { rules, lists }));
    return { result: verdict(issues), issues, rulesVersion, text };
  } catch (e) {
    return { result: "error", issues: [], rulesVersion, text, error: String((e && e.message) || e).slice(0, 80) };
  }
}
export const screenDescription = (text, ctx) => screen("description", text, ctx);
export const screenName = (name, ctx) => screen("name", name, ctx);
/** A proposed ticker: the name's rules but the words one (a ticker is letters, not a word of a language); a slur spelled any way still refuses it. */
export const screenTicker = (symbol, ctx) => screen("ticker", symbol, ctx);
export const screenReason = (text, ctx) => screen("reason", text, ctx);
/** The issues in the founder's words: [{ code, start, end, message }], one sentence per code. */
export const explained = (issues, cityName) => (issues || []).map((x) => ({ code: x.code, severity: x.severity, start: x.start, end: x.end, message: explain(x.code, cityName) }));
