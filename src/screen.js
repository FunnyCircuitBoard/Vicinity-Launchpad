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
 * Evasion: the rules compare a folded form of the text with the lists (src/screen-words.js): Unicode compatibility forms (full-width,
 * mathematical and circled letters), letter case, accents and stacked marks, look-alike Cyrillic and Greek letters, leetspeak (0 o, 1 i,
 * 3 e, 4 a, 5 s, 7 t, @ a, $ s, ! i, | l; never inside a $TICKER or a plain number), dots, dashes, underscores and stars inside a word
 * ("s.c.a.m"), and spaces between single letters ("s c a m"). Invisible characters (zero-width, bidi controls, tags, fillers, private
 * use, unassigned) and words that mix Latin with Cyrillic or Greek letters are refused before anything else ("hidden_chars"); the
 * zero-width joiner and the variation selectors are fine inside an emoji. A city's own name, region, country and ticker never count
 * against it (the Scunthorpe guard), and single words match whole words only.
 */
import { BLANK_CHARS, FORMAT_CHARS, cleanText } from "./text.js";
import * as WORDS from "./screen-words.js";

export const DESCRIPTION_MIN = 10, DESCRIPTION_MAX = 200, DESCRIPTION_LINES = 3, DESCRIPTION_BYTES = 600;
export const REASON_MIN = 10, REASON_MAX = 300;
export const SEVERITY = Object.freeze({
  length: "block", hidden_chars: "block", link: "block", crypto_address: "block", contact: "block", slur: "block",
  street_address: "flag", abuse: "flag", other_city: "flag", brand: "flag", staff: "flag", financial: "flag", spam: "flag",
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
const LIST_NAMES = ["SLURS", "ABUSE", "BRANDS", "PUBLIC_BODIES", "FINANCIAL", "STREET_WORDS", "TIE_WORDS", "BODY_TIE_WORDS", "STAFF_WORDS", "STAFF_ALONE", "TLDS", "LINK_HOSTS", "OK_TICKERS"];
/** The serialized lists the rules version is the hash of (with the rule severities: changing what blocks changes the version too). */
export const listsText = (lists = WORDS) => JSON.stringify({ lists: Object.fromEntries(LIST_NAMES.map((k) => [k, lists[k]])), severity: SEVERITY });
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
};
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i", "|": "l" };
const confuse = (s) => { let o = ""; for (const ch of s) o += CONFUSABLE[ch] ?? ch; return o; };

/**
 * The text folded for matching: one unit per output character, each with the span [s, e) of the original it came from.
 * NFKC, look-alikes, lower case, accents and other marks removed.
 */
function fold(text) {
  const units = [];
  for (const m of text.matchAll(/[\s\S]/gu)) {
    const ch = m[0], s = m.index, e = s + ch.length;
    let f = confuse(ch.normalize("NFKC"));
    f = confuse(f.toLowerCase()).normalize("NFD").replace(/\p{M}/gu, "");
    if (!f) { if (units.length && /\p{M}/u.test(ch)) units[units.length - 1].e = e; continue; } // a mark belongs to its letter
    for (const c of f) units.push({ c, s, e });
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
 * The joined words: a word broken by dots, dashes, underscores or stars ("s.c.a.m", "f-u-c-k", "s_c_a_m", "sc*m") and a run of three or
 * more single letters with spaces between them ("s c a m"), each as one more word (the parts stay words too).
 */
function joined(units) {
  const out = [];
  // separators inside a word
  const seps = units.map((u) => u.c);
  for (let i = 0; i < units.length; i++) {
    if (!/[a-z0-9@$!|]/.test(seps[i]) || /[a-z0-9@$!|]/.test(seps[i - 1] || " ")) continue; // from the start of a word only
    let j = i, parts = 1, hadSep = false;
    while (j + 2 <= units.length && /[.\-_*·•]/.test(seps[j + 1] || "") && /[a-z0-9@$!|]/.test(seps[j + 2] || "")) { j += 2; parts++; hadSep = true; while (j + 1 < units.length && /[a-z0-9@$!|]/.test(seps[j + 1])) j++; }
    if (!hadSep) continue;
    const run = units.slice(i, j + 1).filter((u) => /[a-z0-9@$!|]/.test(u.c));
    out.push({ units: run, s: units[i].s, e: units[j].e });
    i = j;
  }
  // spaced single letters
  const singles = [];
  for (let i = 0; i < units.length; i++) {
    const c = seps[i];
    if (/[a-z0-9@$!|]/.test(c) && !/[a-z0-9@$!|]/.test(seps[i - 1] || " ") && !/[a-z0-9@$!|]/.test(seps[i + 1] || " ")) singles.push(i);
  }
  let run = [];
  // every stretch of three or more of them is a word ("a n i g g e r": "anigger", "nigger", ...), the first 40 letters of a run at most
  const flush = () => {
    const r = run.slice(0, 40);
    for (let a = 0; a + 3 <= r.length; a++) for (let b = a + 3; b <= r.length; b++) out.push({ units: r.slice(a, b).map((k) => units[k]), s: units[r[a]].s, e: units[r[b - 1]].e });
    run = [];
  };
  for (const k of singles) {
    if (run.length) {
      const prev = run[run.length - 1];
      const between = seps.slice(prev + 1, k).join("");
      if (/^[\s.\-_*]+$/.test(between)) { run.push(k); continue; }
      flush();
    }
    run.push(k);
  }
  flush();
  return out.map((x) => {
    const raw = str(x.units);
    return { w: (/[a-z]/.test(raw) ? raw.replace(/[013457@$!|]/g, (c) => LEET[c]) : raw).replace(/[@$!|]/g, ""), s: x.s, e: x.e };
  }).filter((x) => x.w);
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
function matchList(list, toks, joins, own) {
  const hits = [];
  const { singles, multi } = compile(list);
  const one = (w) => singles.has(w) || (w.endsWith("s") && singles.has(w.slice(0, -1))) || (w.endsWith("es") && singles.has(w.slice(0, -2)));
  for (const t of [...toks, ...joins]) {
    const w = skel(t.w);
    if (own.has(w)) continue;
    if (one(w)) hits.push({ start: t.s, end: t.e, word: w });
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
  // a word that mixes Latin letters with Cyrillic or Greek ones (look-alikes)
  for (const m of text.matchAll(/[\p{L}\p{M}]+/gu)) {
    const wd = m[0];
    const latin = /\p{Script=Latin}/u.test(wd), other = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u.test(wd);
    if (latin && other) at(m.index, m.index + wd.length);
  }
  return issues;
}

const tldSet = (lists) => new Set(lists.TLDS);
function links(units, lists) {
  const t = str(units), out = [];
  const add = (m, len = m[0].length, off = 0) => out.push({ code: "link", ...span(units, m.index + off, m.index + off + len) });
  for (const m of t.matchAll(/https?\s*:|www\s*\.|\bw\s+w\s+w\b/g)) add(m);
  const tlds = tldSet(lists);
  // name.tld (a real top-level domain right after the dot), or an obfuscated dot: "name dot com", "name[.]com", "name(dot)com"
  for (const m of t.matchAll(/([a-z0-9][a-z0-9-]*)(\.|\s*\[\s*\.\s*\]\s*|\s*\(\s*\.\s*\)\s*|\s*[[({]\s*dot\s*[\])}]\s*|\s+dot\s+)([a-z]{2,})(?![a-z0-9])/g)) {
    if (tlds.has(m[3]) && !/^\d+$/.test(m[1])) add(m);
  }
  for (const host of lists.LINK_HOSTS) {
    const esc = host.replace(/\./g, "\\s*\\.\\s*");
    for (const m of t.matchAll(new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "g"))) add(m);
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
  const t = str(units), out = [];
  const add = (m, len = m[0].length) => out.push({ code: "contact", ...span(units, m.index, m.index + len) });
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
  for (const v of [c.name, c.region, c.countryName, c.country, ctx && ctx.ticker, ctx && ctx.name]) for (const w of phraseWords(v)) set.add(w);
  return set;
}
function run(text, ctx, { rules, lists }) {
  const issues = [];
  const push = (list) => { for (const x of list) issues.push({ code: x.code, severity: SEVERITY[x.code], start: x.start, end: x.end }); };
  if (rules.has("hidden_chars")) push(hiddenChars(text));
  const units = fold(text);
  const tk = tickers(text, ctx, lists);
  const toks = words(units, { tickers: tk.spans }), joins = joined(units);
  const own = ownWords(ctx);
  if (rules.has("link")) push(links(units, lists));
  if (rules.has("crypto_address")) push(cryptoAddresses(text));
  if (rules.has("contact")) push(contacts(units));
  if (rules.has("street_address")) push(streetAddresses(text, lists));
  const tag = (code, hits) => hits.map((h) => ({ code, start: h.start, end: h.end }));
  if (rules.has("slur")) push(tag("slur", matchList(lists.SLURS, toks, joins, own)));
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
const ALL = ["hidden_chars", "link", "crypto_address", "contact", "street_address", "slur", "abuse", "other_city", "brand", "staff", "financial", "spam"];
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
