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
 * An ALLOW-LIST decides what passes by itself (ENGINE 3), not a race against every new spelling. A description passes only when all
 * three hold, and anything else is FLAGGED for a person (never used by itself, never counted as approved):
 *   (a) plainChars: every character is a plain one. The letters of the scripts the city's own name is written in (for a Latin-script
 *       name: A to Z and the accented letters written languages use, never small capitals, phonetic, medieval, upside-down or other
 *       "fancy text" letters), A to Z for every city, the digits 0 to 9, everyday punctuation, spaces and line breaks, and any character
 *       of the city's own name, region and country. Compatibility forms (full-width, mathematical, circled, squared, parenthesized,
 *       superscript letters: whatever NFKC would rewrite) are not plain, nor are symbols, emoji, other alphabets, zero-width or bidi
 *       characters, and combining marks other than the accents of written languages (strike-through, underline and overlay marks).
 *   (b) linkLike: nothing reads as a link, an address or a handle with the dot written as a space or left out: a word, a space and a web
 *       ending ("uticacoin com"), a link host with a space for its dot ("t me", "bit ly", "x com"), a slash between words
 *       ("x com/uticacoin"), a platform's name ("Telegram", or "on X"), "DM me", a word that glues the city's name to a handle word
 *       ("uticacoin", "visitutica") or letters to digits ("utica22").
 *   (c) the word lists of src/screen-words.js find nothing (slurs BLOCK; every other list flags), compared with a folded form of the text:
 *       Unicode compatibility forms, letter case, accents and stacked marks, look-alike letters of other scripts, leetspeak (0 o, 1 i,
 *       3 e, 4 a, 5 s, 7 t, @ a, $ s, ! i, | l; never inside a $TICKER or a plain number), separators inside a word ("s.c.a.m"), and
 *       spaces between single letters ("s c a m"). So a slur in a fancy style is still refused (BLOCK) wherever the folding reads it,
 *       and flagged by (a) wherever it does not.
 * Invisible characters (zero-width, bidi controls, tags, fillers, private use, unassigned), Latin small capitals and phonetic letters,
 * and words that mix Latin with Cyrillic or Greek letters are refused outright ("hidden_chars", BLOCK); the zero-width joiner and the
 * variation selectors are only hidden characters outside an emoji (an emoji is not plain either: it is flagged by (a)). Links, addresses
 * and contacts written plainly are refused (BLOCK). A city's own name, region, country and ticker never count against it (the
 * Scunthorpe guard), and single words match whole words only.
 */
import { BLANK_CHARS, FORMAT_CHARS, cleanText } from "./text.js";
import * as WORDS from "./screen-words.js";

export const DESCRIPTION_MIN = 10, DESCRIPTION_MAX = 200, DESCRIPTION_LINES = 3, DESCRIPTION_BYTES = 600;
export const REASON_MIN = 10, REASON_MAX = 300;
export const SEVERITY = Object.freeze({
  length: "block", hidden_chars: "block", link: "block", crypto_address: "block", contact: "block", slur: "block",
  street_address: "flag", abuse: "flag", other_city: "flag", brand: "flag", staff: "flag", financial: "flag", spam: "flag",
  characters: "flag", link_like: "flag", taken_down: "flag",
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
  brand: "Coins can't suggest that a company, team or public body is involved. Only send it for review if they really are.",
  staff: "This sounds like it comes from Vicinity or its staff. Only Vicinity speaks for Vicinity.",
  financial: "This sounds like a promise about price or profit. City coins can't promise returns.",
  spam: "Too many capitals, repeated characters or emoji.",
  characters: "Only plain letters, numbers and everyday punctuation pass by themselves. This has other characters (a fancy-text style, symbols, emoji or another alphabet), so a person checks it first.",
  link_like: "This looks like a web address, a link or a social media handle. A person checks it first.",
  taken_down: "Vicinity took this description down before. A person checks it before it can be used again.",
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
const LIST_NAMES = ["SLURS", "ABUSE", "BRANDS", "PUBLIC_BODIES", "FINANCIAL", "STREET_WORDS", "TIE_WORDS", "BODY_TIE_WORDS", "STAFF_WORDS", "STAFF_ALONE", "TLDS", "LINK_HOSTS", "OK_TICKERS",
  "SPACED_TLDS", "SPACED_HOSTS", "PLATFORMS", "PLATFORM_SHORT", "CONTACT_WORDS", "CONTACT_ME", "HANDLE_SUFFIXES", "HANDLE_PREFIXES"];
/**
 * The matching engine's own version: raised whenever the folding or a rule's code changes what is caught (2: Latin small capitals and
 * other look-alike letters, words split by separators or a space, slur stems, more ways of writing a link or a handle; 3: the
 * allow-list, plainChars and linkLike). It is part of the rules version, so a text that passed under the older engine is screened
 * again, like one that passed under older lists.
 */
const ENGINE = 3;
/** The serialized lists the rules version is the hash of (with the rule severities: changing what blocks changes the version too). */
export const listsText = (lists = WORDS) => JSON.stringify({ lists: Object.fromEntries(LIST_NAMES.map((k) => [k, lists[k]])), severity: SEVERITY, engine: ENGINE });
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
const TIGHT = /^[.\-_*·•'’‐‑‒–—]{1,3}$/u; // separators inside a word, with no space: "nig-ger", "f.u.c.k", "fuc'k"
const LOOSE = /^(?=.* )[ .\-_*·•'’‐‑‒–—]{1,3}$/u; // a space, maybe with separators: "ni gger", "fu - ck"
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
  return out.map((x) => ({ w: read(str(x.units)), s: x.s, e: x.e, spaced: x.spaced, parts: x.parts.map((q) => skel(read(q))) })).filter((x) => x.w);
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
 * A list word, or one with a plural or slang ending: up to three trailing s or z ("kikez", "niggerss"), or "es" after s, x, z, ch or sh
 * ("bitches"; never "spices": that is spice + s, not spic + es).
 */
function listWord(singles, w) {
  if (singles.has(w)) return true;
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
        ok = w === p[k] || (last && (w === `${p[k]}s` || w === `${p[k]}es`));
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
/** The city's own words (its name, region and country, as the city list writes them) and the scripts they are written in. */
function ownLetters(ctx) {
  const c = (ctx && ctx.city) || {}, chars = new Set(), scripts = new Set(["Latin"]);
  for (const v of [c.name, c.region, c.countryName]) {
    for (const ch of String(v || "").normalize("NFC")) {
      chars.add(ch);
      if (/\p{L}/u.test(ch)) { const sc = scriptOf(ch); if (sc) scripts.add(sc); }
    }
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
function plainChars(text, ctx) {
  const own = ownLetters(ctx), out = [];
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
/**
 * (b) Links and handles that are not written as links (FLAG): see the header. `own`: the city's own words (skeleton form); `ownRaw`: as
 * written; `inOwn(s, e)`: is this span inside the city's own name, region or country as written (a slash in "Biel/Bienne" is the name's).
 */
function linkLike(units, lists, own, ownRaw, inOwn = () => false) {
  const out = [];
  const add = (s, e) => out.push({ code: "link_like", start: s, end: e });
  const toks = words(units, { leet: false }), folded = str(units);
  const spaced = (a, b) => /^[ \n]+$/.test(folded.slice(a.j, b.i));
  const isOwn = (t) => own.has(skel(t.w));
  const tlds = new Set(lists.SPACED_TLDS), platforms = new Set(lists.PLATFORMS), short = new Set(lists.PLATFORM_SHORT);
  const contact = new Set(lists.CONTACT_WORDS), me = new Set(lists.CONTACT_ME);
  const hosts = [...lists.LINK_HOSTS, ...lists.SPACED_HOSTS].map((h) => h.split(".")).filter((p) => p.length === 2);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k], prev = k > 0 ? toks[k - 1] : null, next = k + 1 < toks.length ? toks[k + 1] : null;
    // a word, a space, a web ending ("uticacoin com", "x com"); never a number before it ("50 cc") or the city's own words
    if (prev && tlds.has(t.w) && spaced(prev, t) && /[a-z]/.test(prev.w) && !(isOwn(prev) && isOwn(t))) add(prev.s, t.e);
    // a link host with a space for its dot ("t me", "bit ly", "wa me", "linktr ee")
    if (prev && spaced(prev, t) && hosts.some(([a, b]) => prev.w === a && t.w === b)) add(prev.s, t.e);
    // a platform's name; a short one only right after "on", "follow", "join"... ("on X", "join tg")
    if (platforms.has(t.w) && !isOwn(t)) add(t.s, t.e);
    if (prev && short.has(t.w) && contact.has(prev.w) && !isOwn(t)) add(prev.s, t.e);
    // "DM me", "text us"
    if (next && me.has(t.w) && (next.w === "me" || next.w === "us") && spaced(t, next)) add(t.s, next.e);
    if (!isOwn(t) && handleLike(t.w, ownRaw, lists)) add(t.s, t.e);
  }
  // a slash between words or numbers: a path or a handle ("x com/uticacoin", "bit ly/utica22", "t me / utica")
  for (const m of folded.matchAll(/[a-z0-9][ \n]*[/⁄∕⧸][ \n]*[a-z0-9]/g)) {
    const sp = span(units, m.index, m.index + m[0].length);
    if (!inOwn(sp.start, sp.end)) add(sp.start, sp.end);
  }
  return out.filter((x) => !inOwn(x.start, x.end));
}

const tldSet = (lists) => new Set(lists.TLDS);
// the gTLDs a "word. com" (a dot, then a space) most likely means; only a flag (it is also how a sentence ends: "Utica. so good")
const WEB_TLDS = new Set(["com", "net", "org", "io", "xyz", "app", "gg", "co", "me", "ly", "ai", "dev", "sol", "eth", "fun", "site", "online", "shop", "store", "live",
  "club", "info", "biz", "tv", "cc", "ws", "to", "sh", "so", "vc", "fm"]);
/**
 * The folded text with every character a browser or a reader takes for a dot written as one: `full` the full stops (ideographic "。",
 * its half-width form; NFKC already made "．", "﹒" and "․" a dot), `tight` also the middle dots and bullets ("uticacoin·com"), which
 * only count between two words with no space (a bullet between spaced words is a list: "food • art • music").
 */
function dotted(units) {
  const full = str(units).replace(/[。]/g, ".");
  return { full, tight: full.replace(/[·⸱・‧∙⋅•]/g, ".") };
}
function links(units, lists, text) {
  const { full: t, tight: tt } = dotted(units), out = [];
  const add = (m, len = m[0].length, off = 0, severity) => out.push({ code: "link", ...span(units, m.index + off, m.index + off + len), ...(severity ? { severity } : {}) });
  // a scheme (also disguised: "hxxps"), "://", www.
  for (const m of t.matchAll(/https?\s*:|\bh(?:xx|tx|xt)ps?\b|:\s*\/\s*\/|www\s*\.|\bw\s+w\s+w\b/g)) add(m);
  const tlds = tldSet(lists);
  // name.tld (a real top-level domain right after the dot), or an obfuscated dot: "name dot com", "name dotcom", "name d0t com", "name[.]com",
  // "name(dot)com", "name·com", "name。com"
  for (const m of tt.matchAll(/([a-z0-9][a-z0-9-]*)(\.|\s*\[\s*\.\s*\]\s*|\s*\(\s*\.\s*\)\s*|\s*[[({]\s*d[o0]t\s*[\])}]\s*|\s+d[o0]t\s*)([a-z]{2,})(?![a-z0-9])/g)) {
    if (tlds.has(m[3]) && !/^\d+$/.test(m[1])) add(m);
  }
  // a dot with a space before it ("uticacoin . com", "uticacoin .com"): a sentence never puts one there
  for (const m of t.matchAll(/([a-z0-9][a-z0-9-]*)\s+\.\s*([a-z]{2,})(?![a-z0-9])/g)) if (tlds.has(m[2]) && !/^\d+$/.test(m[1])) add(m);
  // a dot, a space, then a web ending in small letters ("uticacoin. com"): flagged for a person (a sentence can end like that too)
  for (const m of t.matchAll(/([a-z0-9][a-z0-9-]*)\.\s+([a-z]{2,})(?![a-z0-9])/g)) {
    const at = m.index + m[0].length - m[2].length, first = units[at];
    if (WEB_TLDS.has(m[2]) && first && /^\p{Ll}/u.test(text.slice(first.s, first.e))) add(m, m[0].length, 0, "flag");
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
  // (a) the allow-list: a run of characters that are not plain, unless it is already refused as hidden characters
  if (rules.has("characters")) push(plainChars(text, ctx).filter((x) => !hidden.some((h) => h.start <= x.start && h.end >= x.end)));
  const units = fold(text);
  const tk = tickers(text, ctx, lists);
  const toks = words(units, { tickers: tk.spans }), joins = [...joined(units), ...variants(units, { tickers: tk.spans })];
  const own = ownWords(ctx);
  if (rules.has("link")) push(links(units, lists, text));
  if (rules.has("link_like")) {
    const spans = ownSpans(text, ctx);
    push(linkLike(units, lists, own, ownRawWords(ctx), (s, e) => spans.some(([a, b]) => a <= s && e <= b)));
  }
  if (rules.has("crypto_address")) push(cryptoAddresses(text));
  if (rules.has("contact")) push(contacts(units));
  if (rules.has("street_address")) push(streetAddresses(text, lists));
  const tag = (code, hits) => hits.map((h) => ({ code, start: h.start, end: h.end }));
  // a slur found only by joining words across a space ("ni gger", but also "go ok") is flagged for a person, never passed
  if (rules.has("slur")) { const hits = matchList(lists.SLURS, toks, joins, own); push(tag("slur", hits.filter((h) => !h.spaced))); push(tag("abuse", hits.filter((h) => h.spaced))); }
  if (rules.has("abuse")) push(tag("abuse", matchList(lists.ABUSE, toks, joins, own)));
  if (rules.has("other_city")) { push(tk.issues); push(otherCityCoins(toks, text, ctx, own)); }
  if (rules.has("brand")) {
    const ties = new Set(lists.TIE_WORDS.flatMap(phraseWords)), bodyTies = new Set(lists.BODY_TIE_WORDS.flatMap(phraseWords));
    push(tag("brand", matchList(lists.BRANDS, toks, [], own).filter((h) => near(toks, h, 3).some((w) => ties.has(w)))));
    push(tag("brand", matchList(lists.PUBLIC_BODIES, toks, [], own).filter((h) => near(toks, h, 3).some((w) => bodyTies.has(w)))));
  }
  if (rules.has("staff")) {
    const staff = new Set(lists.STAFF_WORDS.flatMap(phraseWords));
    const vic = [...toks, ...joins].filter((t) => skel(t.w) === skel("vicinity") || skel(t.w) === skel("vicinitys"));
    push(vic.filter((t) => near(toks, { start: t.s, end: t.e }, 3).some((w) => staff.has(w))).map((t) => ({ code: "staff", start: t.s, end: t.e })));
    push(tag("staff", matchList(lists.STAFF_ALONE, toks, [], own)));
  }
  if (rules.has("financial")) { push(tag("financial", matchList(lists.FINANCIAL, toks, joins, own))); push(financialNumbers(units)); }
  if (rules.has("spam")) push(spam(text));
  // one issue per code and span, in reading order
  const seen = new Set();
  return issues.filter((x) => { const k = `${x.code}:${x.start}:${x.end}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.code.localeCompare(b.code));
}
const ALL = ["hidden_chars", "characters", "link", "link_like", "crypto_address", "contact", "street_address", "slur", "abuse", "other_city", "brand", "staff", "financial", "spam"];
const verdict = (issues) => (issues.some((x) => x.severity === "block") ? "block" : issues.length ? "flag" : "pass");

/**
 * Screen `raw` as a `target` ("description", "name", "reason"). `ctx`: { city: { name, region, countryName, country }, ticker,
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
    } else if (target !== "name") throw new Error("unknown target");
    const rules = new Set(target === "reason" ? ["hidden_chars"] : target === "name" ? ALL.filter((r) => r !== "spam") : ALL);
    issues.push(...run(text, ctx, { rules, lists }));
    return { result: verdict(issues), issues, rulesVersion, text };
  } catch (e) {
    return { result: "error", issues: [], rulesVersion, text, error: String((e && e.message) || e).slice(0, 80) };
  }
}
export const screenDescription = (text, ctx) => screen("description", text, ctx);
export const screenName = (name, ctx) => screen("name", name, ctx);
export const screenReason = (text, ctx) => screen("reason", text, ctx);
/** The issues in the founder's words: [{ code, start, end, message }], one sentence per code. */
export const explained = (issues, cityName) => (issues || []).map((x) => ({ code: x.code, severity: x.severity, start: x.start, end: x.end, message: explain(x.code, cityName) }));
