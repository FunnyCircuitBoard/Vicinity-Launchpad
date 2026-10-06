// The official contract card at the top of /token, redesigned for phones: a header (label, network, an "Official" mark once
// the address is known), the address in one block with a full-width copy button under it, Buy on Raydium across the card,
// Jupiter / DEX Screener / Solscan as three equal tiles, then the "only official" note set apart. Every id token.js relies on
// is kept; the pre-launch state and the chain-busy (503) fallback behave as before. The motion (the buy button's breathing glow and
// the light along its top edge, shared with every main button: style.css "Live buttons"; a light along the card's hairline; a tick
// that pops in when copied) is CSS only and switches off with prefers-reduced-motion or the footer's "Pause animations".
// How it looks is checked in Chromium (320, 390, 1280 px, dark and light); this pins the markup, the rules and the script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MINT } from "./helpers/world.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("public/style.css"), js = read("public/token.js"), site = read("public/site.js");
const both = [["public", read("public/token.html")], ["src", read("scripts/pages/src/token.html")]];
/** The contract card's markup, from its opening tag to the stat row after it. */
const cardOf = (h) => { const a = h.indexOf('<div class="contract card is-pending" id="contract">'), b = h.indexOf('<div class="stat-row"', a); assert.ok(a >= 0 && b > a, "the card is there"); return h.slice(a, b); };
/** The declarations of the first rule whose selector is exactly `sel` (outside or inside a media block). */
const rule = (sel) => { const i = css.indexOf(`${sel} {`); assert.ok(i >= 0, `rule ${sel}`); return css.slice(i + sel.length + 2, css.indexOf("}", i)); };
/** The body of the first `@media <query> {` block that holds `needle` (balanced braces). */
const media = (query, needle) => {
  let from = 0;
  for (;;) {
    const at = css.indexOf(`@media ${query} {`, from); if (at < 0) return null;
    let depth = 1, i = at + query.length + 9;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    const body = css.slice(at + query.length + 9, i - 1);
    if (body.includes(needle)) return body;
    from = i;
  }
};

/* ---------------- the markup ---------------- */

test("contract card: header, address + copy, buy button, three tiles, note: in that order, every id token.js uses kept", () => {
  for (const [where, h] of both) {
    const c = cardOf(h);
    const at = (needle) => { const i = c.indexOf(needle); assert.ok(i >= 0, `${where}: ${needle}`); return i; };
    const order = [at('class="contract__head"'), at('id="ca-badge"'), at('class="contract__addr"'), at('<code id="ca-text">Loading…</code>'), at('id="ca-copy"'),
      at('id="ca-links"'), at('id="lnk-raydium"'), at('id="lnk-jup"'), at('id="lnk-dex"'), at('id="lnk-solscan"'), at('class="contract__foot"'), at('id="ca-note"')];
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${where}: top to bottom`);
    assert.match(c, /<div class="contract__label">Contract address<\/div>/, `${where}: one short label that fits one line at 320 px`);
    assert.match(c, /<span class="contract__net">Solana<\/span>/);
    // before token.js knows the contract nothing claims anything: the mark is hidden, and the copy button and the links hold their room
    // unseen (the card is .is-pending: visibility hidden, so no Tab stop and nothing read out) until /api/token answers
    assert.match(c, /<span class="contract__badge" id="ca-badge" hidden><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>Official<\/span>/, `${where}: the mark is hidden until the address is known`);
    assert.match(c, /<button class="contract__copy" type="button" id="ca-copy">/, `${where}: a real button (unseen while the card is pending)`);
    assert.match(c, /<span id="ca-copy-label">Copy address<\/span><\/button>/, `${where}: the copy button says what it copies`);
    assert.match(c, /<div class="contract__links" id="ca-links">/);
    // each link opens another site in a new tab, and says so: the Buy button's arrow and the tiles' corner arrow to the eye, hidden text to a screen reader
    const NEWTAB = '<span class="sr-only"> \\(opens in a new tab\\)</span>';
    assert.match(c, new RegExp(`<a class="contract__buy" id="lnk-raydium" href="#" rel="noopener" target="_blank"><span>Buy on Raydium</span><svg[^>]*aria-hidden="true"[^>]*><path d="M7 17 17 7M9 7h8v8"/></svg>${NEWTAB}</a>`), `${where}: the main button`);
    for (const [id, name] of [["lnk-jup", "Jupiter"], ["lnk-dex", "DEX Screener"], ["lnk-solscan", "Solscan"]])
      assert.match(c, new RegExp(`<a class="contract__ext" id="${id}" href="#" rel="noopener" target="_blank"><svg[^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</svg><span>${name}</span><span class="contract__out" aria-hidden="true">↗</span>${NEWTAB}</a>`), `${where}: ${name} tile`);
    assert.equal((c.match(/target="_blank"/g) || []).length, (c.match(/\(opens in a new tab\)/g) || []).length, `${where}: every new-tab link says so`);
    // the note keeps its no-script wording (token.js replaces it) and stays a paragraph with the id the script fills
    assert.match(c, /<p id="ca-note">Only the address shown here is the official \$VICINITY\. Anything else using the name is fake\. <a href="#check">Check a link or address<\/a>\.<\/p>/);
    assert.doesNotMatch(c, /chip-link|contract__row|btn--sm/, `${where}: the old pills are gone`);
    // every icon is decoration: screen readers hear the words
    const loose = c.replace(/<span class="(contract__icon|contract__copy-icons)" aria-hidden="true">[\s\S]*?<\/span>/g, "");
    assert.equal((c.match(/<svg/g) || []).length - (loose.match(/<svg/g) || []).length, 3, `${where}: the shield and both copy icons sit in hidden wrappers`);
    for (const svg of loose.match(/<svg[^>]*>/g)) assert.match(svg, /aria-hidden="true"/, `${where}: ${svg}`);
  }
});

/* ---------------- the look: phone first ---------------- */

test("contract card on a phone: the address wraps into two even lines, copy is full width, Buy across the card, three equal tiles; all at least 44 px", () => {
  const addr = rule(".contract__addr code");
  assert.match(addr, /max-width: calc\(22 \* \(1ch \+ \.03em\) \+ 2px\)/, "22 characters a line: a 44-character address is two even lines of 22");
  assert.match(addr, /letter-spacing: \.03em/, "the width above counts this letter spacing");
  assert.match(addr, /word-break: break-all/);
  assert.match(addr, /user-select: all/, "one tap selects the whole address for copying by hand");
  assert.match(addr, /text-align: center/);
  assert.match(addr, /font: 500 clamp\(15px, 4\.3vw, 18px\)\/1\.55 var\(--mono\)/);
  const copy = rule(".contract__copy");
  assert.match(copy, /flex: 1 1 100%/, "full width under the address");
  assert.match(copy, /min-height: 48px/);
  const links = rule(".contract__links");
  assert.match(links, /display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, "three equal columns, never a ragged wrap");
  const buy = rule(".contract__buy");
  assert.match(buy, /grid-column: 1 \/ -1/, "Buy on Raydium spans the card");
  assert.match(buy, /min-height: 52px/);
  assert.match(buy, /color: #fff/);
  const ext = rule(".contract__ext");
  assert.match(ext, /min-height: 66px/, "the tiles are equal and tall enough to tap");
  assert.match(ext, /flex-direction: column/, "icon over the name on a phone");
  assert.match(rule(".contract__foot"), /border-top: 1px dashed var\(--line-2\)/, "the note is set apart under a hairline");
  // the light theme has its own card colours
  assert.match(css, /:root\[data-theme="light"\] \.contract \{ background: [^}]*var\(--card\); border-color: rgba\(232,67,31,\.22\); \}/);
  // the old pill styles that only this card used are gone; .chip-link stays for connect.js
  assert.doesNotMatch(css, /\.chip-link--buy|\.contract__row/);
  assert.match(css, /\.chip-link \{/);
  assert.match(read("public/connect.js"), /"chip-link"/);
});

test("contract card on a computer: the address on one line with Copy beside it, then a row of buttons; on wide screens the buttons take a column of their own", () => {
  const tablet = media("(min-width: 640px)", ".contract__addr code");
  assert.ok(tablet, "a 640 px block");
  assert.match(tablet, /\.contract__addr code \{ flex: 1 1 auto; max-width: none; margin: 0; text-align: left;/);
  assert.match(tablet, /\.contract__copy \{ flex: none; min-height: 44px;/);
  assert.match(tablet, /\.contract__links \{ grid-template-columns: minmax\(0, 1\.5fr\) repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(tablet, /\.contract__buy \{ grid-column: auto; \}/);
  assert.match(tablet, /\.contract__ext \{ flex-direction: row;[^}]*min-height: 52px;/);
  const wide = media("(min-width: 1180px)", ".contract:has(");
  assert.ok(wide, "a 1180 px block");
  // two columns only while the links are shown: before the launch (links hidden) the card stays one column
  assert.match(wide, /\.contract:has\(> \.contract__links:not\(\[hidden\]\)\) \{ grid-template-columns: minmax\(0, 1\.4fr\) minmax\(0, 1fr\);/);
  assert.match(wide, /> \.contract__links \{ grid-column: 2; grid-row: 1 \/ span 3;/);
});

test("contract card motion: only transform and opacity move, the card's own motion ends, and nothing moves with reduced motion", () => {
  for (const name of ["checkPop", "lbGlow", "lbSweep", "lbBusy", "contractIn", "contractSweep"]) {
    const i = css.indexOf(`@keyframes ${name} {`); assert.ok(i >= 0, name);
    let depth = 0, j = i;
    for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; }
    const props = [...css.slice(i, j).matchAll(/([a-z-]+):/g)].map((m) => m[1]);
    assert.ok(props.length, `${name} animates something`);
    for (const p of props) assert.ok(["transform", "opacity"].includes(p), `${name} animates ${p}`);
  }
  // Buy on Raydium is a main button like the others (the owner, 6 Oct 2026: "each button should have live animation"): its glow breathes
  // and a light glides along its top edge every 7 s. Endless, so a visitor can stop it: "Pause animations" (WCAG 2.2.2), reduced motion,
  // and it pauses off screen and in a hidden tab (--lb-play). It never sits under the words, and the button no longer clips (the glow is outside).
  assert.doesNotMatch(css, /buyShine/, "the old two-pass shine is gone");
  assert.doesNotMatch(rule(".contract__buy"), /overflow: hidden/, "nothing clips the glow around it");
  assert.match(css, /\.contract__buy::before, \.map-open::before \{ content: ""; position: absolute; inset: -1px; z-index: -1;[^}]*opacity: \.5; \}/, "a still glow at rest");
  assert.match(css, /\.contract__buy::after, \.map-open::after \{ content: ""; position: absolute; top: 1px; left: var\(--rim-in, 24px\);[^}]*height: 7px;[^}]*opacity: 0;/, "the light rests unseen, above the words");
  const live = media("(prefers-reduced-motion: no-preference)", ".contract__buy::after, .map-open::after { animation: lbSweep");
  assert.ok(live, "the light is opt-in");
  assert.match(live, /\.contract__buy::after, \.map-open::after \{ animation: lbSweep 7s ease-in-out var\(--sweep-delay, 1\.2s\) infinite var\(--lb-play, running\); \}/);
  assert.match(live, /\.contract__buy::before, \.map-open::before \{ animation: lbGlow 3\.6s steps\(18\) infinite alternate var\(--lb-play, running\); \}/);
  assert.doesNotMatch(rule(".contract__links"), /animation/, "nothing plays while the links wait unseen");
  assert.ok(media("(prefers-reduced-motion: no-preference)", ".contract:not(.is-pending) > .contract__links, .contract:not(.is-pending) .contract__copy { animation: contractIn .5s cubic-bezier(.2,.8,.2,1) backwards; }"),
    "the buttons slide in when token.js reveals them (backwards fill: afterwards the button's own :active and hover transforms work)");
  assert.match(css, /@keyframes contractIn \{ from \{ opacity: 0; transform: translateY\(6px\); \} \}/, "from hidden to the element's own look: with no animation it simply shows");
  assert.match(css, /\.contract__copy\.is-copied \.contract__copy-check \{ opacity: 1; transform: none; animation: checkPop/, "the tick's resting state is visible; the pop is extra");
  // the hairline itself is still; a short light runs along it twice (transform and opacity: the compositor moves it, the main thread idles).
  // On 6 Oct 2026 the old endless background-position glow kept /token restyling 60 times a second for as long as it was open.
  assert.doesNotMatch(css, /contractGlow/, "the endless moving gradient is gone");
  assert.doesNotMatch(rule(".contract::before"), /animation|background-size|\/ 200%/, "the hairline does not move");
  assert.ok(media("(prefers-reduced-motion: no-preference)", ".contract::after { animation: contractSweep 6s ease-in-out 1.5s 2; }"), "the light along it is opt-in and runs twice");
  assert.match(rule(".contract::after"), /left: 22px; width: 30%;[^}]*opacity: 0;/, "it starts at the hairline's left end and rests unseen");
  assert.match(css, /@keyframes contractSweep \{[^\n]*60%, 100% \{ transform: translateX\(calc\(233\.33% - 44px\)\); opacity: 0; \} \}/, "and ends at its right end (30% of the card, minus both 22 px insets), faded out");
  assert.match(css, /\.mo-off \.contract::after, [^{]*\{ animation-play-state: paused; \}/, "the hairline's light pauses while the top of the page is off screen");
  assert.match(css, /:root\.mo-hidden, \.mo-off \{ --lb-play: paused; \}/, "and the buy button's loops too (off screen, or a hidden tab)");
  // the shine and the slide-in are switched off for people who asked for less motion
  const reduce = media("(prefers-reduced-motion: reduce)", ".contract__copy-check");
  assert.ok(reduce, "a reduced-motion block for the card");
  assert.match(reduce, /\.contract__copy-check \{ animation: none; \}/);
  // and the site-wide rule still stops every animation and transition
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  html \{ scroll-behavior: auto; \}\n  \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
});

/* ---------------- token.js in node ---------------- */

function page({ token, copyWorks = true, official = null }) {
  const nodes = new Map(), timers = [], copies = [];
  function node(sel) {
    const n = { sel, hidden: false, _text: "", classes: new Set(), style: {}, dataset: {}, handlers: {}, children: [], value: "", offsetWidth: 0,
      get textContent() { return n._text; }, set textContent(t) { n._text = String(t); },
      append(...k) { n.children.push(...k); }, replaceChildren(...k) { n.children = k; }, addEventListener(t, f) { (n.handlers[t] ||= []).push(f); },
      attrs: {}, setAttribute(k, v) { n.attrs[k] = String(v); }, removeAttribute(k) { delete n.attrs[k]; },
      // the tiles' spans: their name (no class), the corner arrow and the new-tab words
      querySelectorAll(q) { return n.children.filter((k) => q === "span" || q.split(", ").some((c) => c === "." + k.className)); },
      classList: { add: (c) => n.classes.add(c), remove: (c) => n.classes.delete(c), toggle: (c, on) => (on ? n.classes.add(c) : n.classes.delete(c)), contains: (c) => n.classes.has(c) } };
    return n;
  }
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node(sel)); return nodes.get(sel); };
  $("#ca-badge").hidden = true; $("#contract").classes.add("is-pending"); // as in the markup
  $("#ca-text").textContent = "Loading…"; $("#ca-copy-label").textContent = "Copy address";
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.classes.add(cls); if (text != null) n.textContent = text; return n; };
  const span = (cls, text) => { const k = node("span"); k.className = cls; k.textContent = text; k.remove = () => { const p = $("#lnk-dex"); p.children = p.children.filter((x) => x !== k); }; return k; };
  $("#lnk-dex").children.push(span("", "DEX Screener"), span("contract__out", "↗"), span("sr-only", " (opens in a new tab)")); // as in the markup
  $("#lnk-dex").attrs = { target: "_blank", rel: "noopener" };
  const V = { $, $$: () => [], el, toast() {}, fmt: String, compact: String, mask: (a) => a, isAddr: (a) => typeof a === "string" && a.length >= 32, official, reduced: false,
    copy: async (text, label) => { copies.push([text, label]); return copyWorks; },
    api: async (path) => (path === "/api/token" ? token : { launched: false, holders: [] }) };
  vm.runInNewContext(js, { window: { V }, document: { hidden: false }, location: { search: "" }, URLSearchParams, Intl, Date,
    setInterval: () => 0, setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimeout: () => {}, requestAnimationFrame: () => 0 });
  const settle = () => new Promise((r) => setImmediate(r));
  return { $, timers, copies, settle };
}
const LIVE = { launched: true, registry: [], facts: { mint: MINT, supply: 1e9, mintingDisabled: true, freezingDisabled: true }, price: null };

test("token.js: once the contract is known the 'Official' mark shows (chain busy or not); before the launch it stays hidden", async () => {
  const live = page({ token: LIVE }); await live.settle();
  assert.equal(live.$("#ca-text").textContent, MINT);
  assert.equal(live.$("#ca-badge").hidden, false);
  assert.equal(live.$("#ca-copy").hidden, false);
  assert.equal(live.$("#ca-links").hidden, false);
  assert.ok(!live.$("#contract").classes.has("is-pending"), "the room it held is filled: the buttons show");

  const busy = page({ token: { launched: true, error: "chain_unavailable", mint: MINT, registry: [], _status: 503 } }); await busy.settle();
  assert.equal(busy.$("#ca-text").textContent, MINT, "the 503 fallback still shows the contract");
  assert.equal(busy.$("#ca-badge").hidden, false, "it is the official address from the site's own settings");
  assert.equal(busy.$("#lnk-raydium").href, `https://raydium.io/launchpad/token/?mint=${MINT}`);

  const before = page({ token: { launched: false, registry: [] } }); await before.settle();
  assert.equal(before.$("#ca-text").textContent, "Not published yet");
  assert.equal(before.$("#ca-badge").hidden, true, "nothing is called official before there is a contract");
  assert.equal(before.$("#ca-copy").hidden, true);
  assert.equal(before.$("#ca-links").hidden, true);
  assert.ok(!before.$("#contract").classes.has("is-pending"), "and the room they held is given back");
  assert.equal(before.$("#ca-copy").onclick, undefined, "nothing to copy");
});

test("token.js: with the coin pages on (LAUNCHPAD_V2), the third tile is our own chart, in this tab; with them off it stays as it was", async () => {
  // DEX Screener lists no pool while $VICINITY is on its bonding curve: its tile led to an empty page (review of 6 Oct 2026)
  const on = page({ token: LIVE, official: Promise.resolve({ launchpadV2: true }) }); await on.settle(); await on.settle();
  const a = on.$("#lnk-dex");
  assert.equal(a.href, `/coin?mint=${MINT}`);
  assert.deepEqual(a.children.map((k) => k.textContent), ["Chart"], "the name says Chart; no new-tab arrow, no new-tab words");
  assert.ok(!("target" in a.attrs) && !("rel" in a.attrs), "opens in this tab");
  assert.equal(a.attrs["aria-label"], "Chart and live market of $VICINITY");
  const off = page({ token: LIVE, official: Promise.resolve({ siteMode: "live" }) }); await off.settle(); await off.settle();
  assert.equal(off.$("#lnk-dex").href, `https://dexscreener.com/solana/${MINT}`, "the switch off: today's tile, untouched");
  assert.deepEqual(off.$("#lnk-dex").children.map((k) => k.textContent), ["DEX Screener", "↗", " (opens in a new tab)"]);
});

test("token.js: Copy puts the address on the clipboard, the button says 'Copied' with a tick, then goes back; no clipboard, no 'Copied'", async () => {
  const p = page({ token: LIVE }); await p.settle();
  const b = p.$("#ca-copy"), label = p.$("#ca-copy-label");
  await b.onclick();
  assert.deepEqual(p.copies, [[MINT, "Contract address copied"]], "the toast still says so too");
  assert.equal(label.textContent, "Copied");
  assert.ok(b.classes.has("is-copied"));
  const [revert, ms] = p.timers.at(-1);
  assert.equal(ms, 1800);
  revert();
  assert.equal(label.textContent, "Copy address");
  assert.ok(!b.classes.has("is-copied"));

  const off = page({ token: LIVE, copyWorks: false }); await off.settle();
  await off.$("#ca-copy").onclick();
  assert.equal(off.$("#ca-copy-label").textContent, "Copy address", "the toast shows the address to copy by hand instead");
  assert.ok(!off.$("#ca-copy").classes.has("is-copied"));
});

test("site.js copy answers whether the text reached the clipboard", () => {
  assert.match(site, /const copy = async \(text, label = "Copied"\) => \{ try \{ await navigator\.clipboard\.writeText\(text\); toast\(label\); return true; \} catch \{ toast\(text\); return false; \} \};/);
  assert.match(js, /if \(!\(await copy\(m, "Contract address copied"\)\)\) return;/);
});

test("contract card: until /api/token answers it holds its final room unseen, so nothing jumps and /token#holders lands where it aims", () => {
  // 390x844, 6 Oct 2026: the card grew 214 px when the answer came; #holders, #verify and #check landed 79 px lower than intended
  assert.match(css, /\.contract\.is-pending \.contract__copy, \.contract\.is-pending > \.contract__links \{ visibility: hidden; \}/, "unseen, but in the layout");
  assert.match(css, /@media \(max-width: 639px\) \{ \.contract\.is-pending \.contract__addr code \{ min-height: 3\.1em; \} \}/, "the address's two lines on a phone (line height 1.55)");
  // the wide layout (buttons in a column on the right) already applies while pending: the links are not [hidden]
  assert.match(css, /\.contract:has\(> \.contract__links:not\(\[hidden\]\)\)/);
  assert.match(js, /\$\("#contract"\)\.classList\.remove\("is-pending"\);\n\s+if \(!d\.launched\) \{[^\n]*\n\s+hideContract\(\);/, "removed on the answer, before anything else is decided");
  assert.match(js, /if \(isAddr\(m\)\) showContract\(m\); else hideContract\(\);/, "no address: no links to '#'");
  assert.match(js, /function hideContract\(\) \{ \$\("#ca-copy"\)\.hidden = true; \$\("#ca-links"\)\.hidden = true; \}/);
});

test("contract card tiles: the three icons share one line even when 'DEX Screener' takes two (320 px), and each tile shows its new-tab arrow", () => {
  const ext = rule(".contract__ext");
  assert.match(ext, /flex-direction: column; align-items: center; justify-content: flex-start;[^}]*padding: 12px 2px 10px;/, "top-aligned on a phone");
  assert.match(rule(".contract__ext .contract__out"), /position: absolute; top: 5px; right: 7px;/, "the arrow sits in the corner, out of the label's way");
  const tablet = media("(min-width: 640px)", ".contract__ext");
  assert.match(tablet, /\.contract__ext \{ flex-direction: row; justify-content: center;[^}]*padding: 0 14px;/, "one row of icon and name on a computer, room for the arrow");
  const wide = media("(min-width: 1180px)", ".contract__ext");
  assert.match(wide, /\.contract__ext \{ flex-direction: column; justify-content: flex-start;/, "top-aligned again in the wide column");
});
