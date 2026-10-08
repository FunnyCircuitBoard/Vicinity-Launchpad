// The token page: the order of its sections (the owner, 8 Oct 2026: hero, then "Holders · live" with the rank check merged into its
// "Find a wallet" box, the answer in a little pop-up instead of a card on the page, and "How to get $VICINITY" moved into a FAQ at the
// bottom), the holder list as a box that scrolls on its own (of fixed height once the live list is in it), and public/token.js run in
// node (no browser): every holder is fetched page by page and drawn 250 rows per animation frame, the find box covers every row, a
// Refresh during a load wins, a refresh keeps the reader's place and is skipped when the server hands back the snapshot already on
// screen, the looked-up wallet's row is found when it lands, Check rank opens the pop-up and its three ways out give the keyboard back
// to the box, and the old links /token#buy and /token#verify still land. The server side of the paging is in test/holders-pages.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { MINT } from "./helpers/world.js";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HERO_SHA256 = "858cdd5e151c26e1cdcaa2998526166216b8fa58abefdc48f941b0db3fd67d3a";
const html = read("token.html"), src = readFileSync(new URL("../scripts/pages/src/token.html", import.meta.url), "utf8"), css = read("style.css"), js = read("token.js");

/* ---------------- the page ---------------- */

test("token page: hero, holders (live, with the rank check), no rug pull, official tokens, FAQ: in that order; no How to get or Verify section", () => {
  for (const h of [html, src]) {
    const at = (needle) => { const i = h.indexOf(needle); assert.ok(i >= 0, needle); return i; };
    const order = [at('<section class="page-hero" id="token">'), at('<section id="holders" class="section">'), at('<p class="kicker">No rug pull</p>'), at('<section class="section section--panel" id="check">'), at('<section class="section" id="faq">')];
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "sections top to bottom: token, holders, no rug pull, check, faq");
    assert.ok(h.indexOf('id="holders"') < h.indexOf('<p class="kicker kicker--live"><span class="live-dot" aria-hidden="true"></span>Holders · live</p>'), "the live kicker is the holders section's own");
    assert.ok(h.indexOf("Every real Vicinity token, on every network.") > h.indexOf("No rug pull"), "what followed the proof still follows it");
    // gone from the page body: the How to get section and the Verify a holder section (their ids live on: see the deep-link tests)
    assert.doesNotMatch(h, /<section[^>]*id="(buy|verify)"/);
    assert.doesNotMatch(h, /How to get \$VICINITY<\/p>|Verify a holder|Where do you stand\?|class="buy-steps"|verify-grid|rank-card|rank-empty|lookup-input/);
    assert.equal((h.match(/<section\b/g) || []).length, 5, "five sections");
    for (const id of ["token", "contract", "buy", "verify", "lookup", "rank-pop", "rank-show", "holders", "holders-status", "holders-find", "holders-refresh", "holders-scroll", "holders-table", "holders-body", "team-count", "check", "checker", "faq"]) assert.equal(h.split(`id="${id}"`).length - 1, 1, id);
    assert.ok(h.includes('<span id="holders-status" role="status" aria-live="polite">'), "the status line is the live region: a screen reader hears the progress, not every 250-row chunk");
    assert.doesNotMatch(h, /<div class="holders card"[^>]*aria-live/, "the card around the table is not a live region");
  }
  // the section looks alternate as before: no two identical panels next to each other
  const classes = [...html.matchAll(/<section class="([^"]+)"|<section id="holders" class="([^"]+)"/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(classes, ["page-hero", "section", "section section--tight", "section section--panel", "section"]);
  // the pop-up's button scrolls the list (below the box): no arrow pointing anywhere
  assert.match(html, /<button class="link-btn" type="button" id="rank-show">Show it in the holder list<\/button>/);
});

test("token page: the hero is word for word what it was (Live from the Solana blockchain, $VICINITY, the contract card, the buttons, the stats)", () => {
  // origin/main 07fe1d5's hero, from <section class="page-hero" id="token"> to its </section>, hashed: any change to it fails here
  for (const h of [html, src]) {
    const a = h.indexOf('<section class="page-hero" id="token">'), b = h.indexOf("</section>", a) + "</section>".length;
    assert.equal(createHash("sha256").update(h.slice(a, b)).digest("hex"), HERO_SHA256);
  }
});

test("token page: one box in the holders section finds a wallet and checks its rank (Check rank inside it), the old #verify lands on it", () => {
  for (const h of [html, src]) {
    const sec = h.slice(h.indexOf('<section id="holders"'), h.indexOf("</section>", h.indexOf('<section id="holders"')));
    const head = sec.slice(sec.indexOf('<div class="holders__head">'), sec.indexOf('id="holders-scroll"'));
    assert.ok(head.length > 0, "the head of the holder card");
    // one input and its button, in one form, in the head: the button sits in the box (the same row as the field)
    assert.equal((sec.match(/<input\b/g) || []).length, 1, "one input in the holders section");
    assert.match(head, /<div class="holders__find" id="verify" tabindex="-1">\s*<form class="find-box" id="lookup" role="search" novalidate>\s*<label class="sr-only" for="holders-find">[^<]+<\/label>\s*<input id="holders-find" type="search" placeholder="Find a wallet" autocomplete="off" spellcheck="false" maxlength="60" aria-describedby="holders-hint">\s*<button class="btn btn--primary find-box__go" type="submit">Check rank<\/button>\s*<\/form>/);
    assert.match(head, /<p class="holders__hint" id="holders-hint">Paste any Solana wallet address to see its rank\. We compare it with every holder, live\. Nothing is saved\.<\/p>/, "the helper sentence, short, under the box");
    assert.match(head, /<div class="holders__meta">\s*<span id="holders-status"[^>]*>[^<]*<\/span>\s*<button class="link-btn" type="button" id="holders-refresh" hidden>Refresh<\/button>/, "status and Refresh above it");
    assert.match(sec, /Want your own dashboard, badges and city\? <a href="\/connect">Connect your wallet<\/a>: signing is free and isn't a transaction\./);
    // the answer is a pop-up in the same section, not a card on the page: a <dialog> (role dialog), named by its title, described by the rank
    assert.match(sec, /<dialog class="rank-pop" id="rank-pop" aria-labelledby="rank-pop-title" aria-describedby="rank-big rank-pct">/);
    assert.match(sec, /<h3 class="rank-pop__title" id="rank-pop-title">Where this wallet stands<\/h3>/);
    assert.match(sec, /<button class="rank-pop__close" type="button" id="rank-close" aria-label="Close">/);
    for (const id of ["rank-addr", "rank-big", "rank-num", "rank-of", "rank-bar", "rank-meter", "rank-pct", "rank-facts", "rank-amount", "rank-share", "rank-next", "rank-founder", "rank-show"]) assert.ok(sec.includes(`id="${id}"`), id);
    // the four facts; the founder amount's long name (100K to 1M by city size, held 7 days) is the FAQ's answer, not a 2-line label
    assert.deepEqual([...sec.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ["Holds", "Share of supply", "To pass the next wallet", "Founder amount"]);
  }
  assert.doesNotMatch(css, /\.holders__tools|\.lookup\b|\.rank-card|\.gauge\b|#rank-result/, "the old box, form and rank card styles are gone");
  assert.match(css, /\.find-box \.find-box__go \{ flex: none; min-height: 44px;/, "Check rank is a 44 px tap target, as the old button was 48");
});

test("token page: the FAQ at the bottom, How do I get $VICINITY? first (id buy): the four steps in order, the raydium.io warning; at most three more questions", () => {
  for (const h of [html, src]) {
    const faq = h.slice(h.indexOf('<section class="section" id="faq">'));
    assert.match(faq, /<div class="faq">\s*<div class="section-head"><p class="kicker">FAQ<\/p><h2>Frequently asked questions<\/h2><\/div>\s*<details id="buy"><summary>How do I get \$VICINITY\?<\/summary>/, "the first question");
    const buy = faq.slice(faq.indexOf('<details id="buy">'), faq.indexOf("</details>") + "</details>".length);
    assert.match(buy, /<p>Four steps, about five minutes\.<\/p>\s*<ol class="faq__steps">/);
    const steps = [...buy.matchAll(/<li><strong>([^<]+)<\/strong> (.*?)<\/li>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(steps, [
      ["Get a Solana wallet.", "Phantom, Solflare or Backpack, on your phone or in your browser. Write the recovery phrase down on paper and never share it."],
      ["Add SOL.", "Buy SOL in the wallet app or on an exchange and send it to your wallet. Keep a little extra for network fees."],
      ["Buy on Raydium.", "Use the <strong>Buy on Raydium</strong> button at the top of this page. It opens the official $VICINITY on Raydium LaunchLab (raydium.io); the contract address there must match the one here."],
      ["Claim your spot.", '<a href="/connect">Connect here</a> and set your home city. That starts your 7-day clock towards founding it, and your rank and badges go live.'],
    ], "today's four steps, word for word");
    // word for word, except where the checker is: it is above the FAQ now
    assert.match(buy, /<p class="scam-note"><strong>The only real Raydium is raydium\.io\.<\/strong> Look-alike addresses copy it to empty wallets\. Never type your recovery phrase into any website, and check any link with the <a href="#check">checker above<\/a> first\.<\/p>\s*<\/details>/);
    const questions = [...faq.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(questions, ["How do I get $VICINITY?", "Is this the only official $VICINITY?", "How is my rank worked out?", "What is the founder amount?"]);
    assert.ok(faq.indexOf("</section>") === faq.lastIndexOf("</section>"), "the FAQ is the last section");
  }
  assert.match(css, /\.faq \.scam-note strong \{ color: var\(--bad-text\); \}/, "the warning keeps its red, inside an answer too");
  assert.match(src, /<summary>What is the founder amount\?<\/summary><p>How much \$VICINITY you need to hold to found your city: 100K to 1M by city size, held for 7 days\./);
  // small orange text on the light theme: --pin-2 measured 3.91:1 (step numbers) and 3.78:1 (the pop-up's title); --bad-text is 5.5:1
  assert.match(css, /:root\[data-theme="light"\] \.faq__steps li::marker \{ color: var\(--bad-text\); \}/);
  assert.match(css, /:root\[data-theme="light"\] \.rank-pop__title \{ color: var\(--bad-text\); \}/);
});

test("token page: the pop-up is a little sheet on a phone and hangs from the box on a computer; it scales and fades in only when motion is welcome", () => {
  const rule = (sel) => { const i = css.indexOf(`${sel} {`); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf("}", i)); };
  assert.match(rule(".rank-pop"), /position: absolute; inset: auto; top: var\(--pop-y, 20vh\); left: var\(--pop-x, 16px\);/, "absolute in the top layer: it scrolls with the page, by the box");
  // a sheet at the bottom of a phone's screen, and of a short one (a phone on its side: 844x390 got the 462 px pop-up, cut off); token.js asks the same
  assert.match(css, /@media \(max-width: 600px\), \(max-height: 500px\) \{\n  \.rank-pop \{ position: fixed; top: auto; left: 0; right: 0; bottom: 0; width: auto; max-width: 600px; margin: 0 auto; \}/);
  assert.ok(js.includes('window.matchMedia("(max-width: 600px), (max-height: 500px)")'), "the script's sheet is the style's sheet");
  const sheet = css.slice(css.indexOf("@media (max-width: 600px), (max-height: 500px) {"), css.indexOf("\n}\n", css.indexOf("@media (max-width: 600px), (max-height: 500px) {")));
  assert.match(sheet, /max-height: calc\(100dvh - 16px\)/, "the visible height on iOS (100vh is the tall one)");
  assert.match(sheet, /\.rank-pop \.rank-facts \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/, "the facts two by two: a little sheet (499 of 640 px at 320 before)");
  assert.match(sheet, /\.rank-pop__head \{ margin-right: 0; \}/, "the close button's focus ring is not clipped at the sheet's edge");
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) and \(max-width: 600px\), \(prefers-reduced-motion: no-preference\) and \(max-height: 500px\) \{\n  \.rank-pop\[open\] \.rank-pop__card \{ animation-name: rankSheetIn; \}/);
  assert.match(css, /:root\[data-motion="paused"\] \.rank-pop::backdrop \{ animation: none !important; \}/, "Pause animations stills the backdrop's fade too");
  assert.match(css, /@media \(max-width: 600px\) \{ \.find-box input \{ font-size: 16px; \}/, "16 px: iOS never zooms the page in when the box takes the keyboard");
  const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference) {\n  .rank-pop[open] .rank-pop__card"));
  assert.match(motion, /^@media \(prefers-reduced-motion: no-preference\) \{\n  \.rank-pop\[open\] \.rank-pop__card \{ animation: rankPopIn \.22s cubic-bezier\(\.2,\.8,\.2,1\) both; \}/, "220 ms, only when motion is welcome");
  assert.match(motion, /\.rank-pop\.is-closing \.rank-pop__card \{ animation: rankPopOut \.14s ease-in both; \}/);
  assert.doesNotMatch(css.slice(css.indexOf(".rank-pop {"), css.indexOf("@media (prefers-reduced-motion: no-preference) {\n  .rank-pop[open]")), /animation|transition/, "no motion outside the no-preference block");
  for (const name of ["rankPopIn", "rankPopOut", "rankSheetIn", "rankSheetOut", "rankFade"]) {
    const kf = css.slice(css.indexOf(`@keyframes ${name} {`), css.indexOf("\n", css.indexOf(`@keyframes ${name} {`)));
    const props = [...kf.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.length && props.every((p) => p === "transform" || p === "opacity"), `${name}: compositor only (${props})`);
  }
});

test("token page: the holder list is a box that scrolls inside, of fixed height once the live list is in it, header pinned, status line and find box outside it", () => {
  assert.match(css, /\.table-scroll \{ max-height: clamp\(320px, 60vh, 640px\); overflow: auto;[^}]*overscroll-behavior: contain; \}/, "before launch the box is only as tall as its few placeholder rows");
  assert.match(css, /\.holders--live \.table-scroll \{ height: clamp\(320px, 60vh, 640px\); \}/, "once live, a fixed height: the page never grows with the holder count");
  assert.doesNotMatch(css, /\.is-live[^{]*\.table-scroll/, ".is-live is the proof section's green text (!important colour); the box must not borrow it");
  assert.match(css, /\.holders__table thead th \{ position: sticky; top: 0;/);
  assert.match(html, /<div class="table-scroll" id="holders-scroll" tabindex="0" aria-label="Holder list \(scrolls\)">/, "keyboard focusable, named for screen readers");
  const head = html.indexOf('<div class="holders__head">'), box = html.indexOf('id="holders-scroll"');
  assert.ok(head >= 0 && html.indexOf('id="holders-status"') > head && html.indexOf('id="holders-find"') > head && html.indexOf('id="holders-refresh"') > head, "status, find box and Refresh share the head");
  assert.ok(html.indexOf('id="holders-refresh"') < box && html.indexOf('id="holders-find"') < box, "the head comes before the box, so none of it scrolls away");
  assert.ok(html.indexOf('id="holders-table"') > box && html.indexOf('id="holders-body"') > box, "the table is what scrolls");
  assert.equal((html.match(/table-scroll/g) || []).length, 1, "the box is the holder list's own");
});

/* ---------------- token.js in node: a just-enough page ---------------- */

const MASK = (a) => (a && a.length > 10 ? `${a.slice(0, 5)}*****${a.slice(-3)}` : a || "");
const owner = (i) => `H${String(i).padStart(5, "0")}`.padEnd(44, "x"); // 44 characters like a Solana address; H01230..H01239 share "H0123"
const fakeHolders = (n) => Array.from({ length: n }, (_, i) => ({ owner: owner(i), amount: (n - i) * 10, percent: ((n - i) * 10) / 1e7 * 100, rank: i + 1, label: null }));
/** The server's pages of 1,000 (the shape of src/index.js holdersResponse); `tick()` moves the snapshot on a minute, as the server does. */
let minute = 0; const tick = () => ++minute;
const pageOf = (all, offset) => ({ launched: true, mint: MINT, supply: 1e9, total: all.filter((h) => h.rank).length, count: all.length, full: true, holders: all.slice(offset, offset + 1000), more: offset + 1000 < all.length, updatedAt: `2026-10-03T12:${String(minute).padStart(2, "0")}:00Z` });

/** `desktop` ({ vw, vh, boxY, scrollY }): a computer's window, the box at page y boxY, the page scrolled to scrollY; the pop-up hangs
 *  from the box there. showModal() then does what Chromium's does: its first focus scrolls the page towards the dialog (here, to the top). */
function page({ answer, token = { launched: false, registry: [] }, hash = "", search = "", desktop = null, isAddr = (a) => typeof a === "string" && a.length >= 32 && a.length <= 44 }) {
  const nodes = new Map(), frames = [], calls = [], focused = [], scrolled = [], win = {}, docEl = { clientWidth: 1280, style: {} };
  function node(tag = "div", sel = "") {
    const n = { tagName: tag.toUpperCase(), sel, children: [], dataset: {}, style: { setProperty(k, v) { n.style[k] = v; } }, attrs: {}, hidden: false, value: "", scrollTop: 0, _text: "", handlers: {}, classes: new Set(),
      get textContent() { return n._text; }, set textContent(t) { n._text = String(t); n.children = []; },
      append(...k) { n.children.push(...k); }, replaceChildren(...k) { n.children = k; }, scrollTo() { scrolled.push(`${n.sel} to a row`); }, offsetTop: 0, clientHeight: 400,
      scrollIntoView(o) { scrolled.push(n.sel); }, focus() { focused.push(n.sel); }, contains(o) { return o === n; }, setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return n.attrs[k] ?? null; },
      addEventListener(t, f, o) { (n.handlers[t] ||= []).push(f); }, fire(t, ev = {}) { const e = { preventDefault() { e.defaultPrevented = true; }, target: null, ...ev }; return Promise.all((n.handlers[t] || []).map((f) => f(e))).then(() => e); },
      classList: { add: (c) => n.classes.add(c), remove: (...c) => c.forEach((x) => n.classes.delete(x)), toggle: (c, on) => (on ? n.classes.add(c) : n.classes.delete(c)), contains: (c) => n.classes.has(c) } };
    return n;
  }
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node(sel === "#holders-find" ? "input" : sel === "#rank-pop" ? "dialog" : "div", sel)); return nodes.get(sel); };
  $("#termsgate").hidden = true; // agreed already (the gate is site.js's)
  // the pop-up: a <dialog> as far as token.js uses one (showModal/close fire as the browser's do; "close" is an event of its own)
  const pop = $("#rank-pop"); pop.open = false; pop.shown = 0;
  pop.showModal = () => { pop.open = true; pop.shown++; pop.atShow = { scrollBehavior: docEl.style.scrollBehavior, popY: pop.style["--pop-y"] }; if (desktop) win.scrollY = 0; };
  pop.close = () => { if (!pop.open) return; pop.open = false; pop.fire("close"); };
  const $$ = (sel) => (sel === "#holders-body tr" ? $("#holders-body").children.filter((c) => c.tagName === "TR") : []);
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.classes.add(cls); if (text != null) n.textContent = text; return n; };
  const V = { $, $$, el, toast() {}, copy() {}, fmt: (x) => Number(x).toLocaleString("en-US"), compact: (x) => String(x), mask: MASK, isAddr, official: null, reduced: true, // by default any 32 to 44 characters: the fake owners are 44 characters with 0s
    api: async (path) => { calls.push(path); await null; return path === "/api/token" ? token : answer(path); } };
  const statuses = []; const status = $("#holders-status"); Object.defineProperty(status, "textContent", { get: () => statuses[statuses.length - 1] || "", set: (t) => statuses.push(String(t)) });
  // the box: rows 46px tall, 400px of them in view; scrollTop clamps to the rows there are, as a browser's does, and stays clamped once rows go
  const ROW = 46, box = $("#holders-scroll"); let top = 0;
  const maxTop = () => Math.max(0, $("#holders-body").children.length * ROW - box.clientHeight);
  Object.defineProperty(box, "scrollHeight", { get: () => $("#holders-body").children.length * ROW });
  Object.defineProperty(box, "scrollTop", { get: () => (top = Math.min(top, maxTop())), set: (v) => { top = Math.min(Math.max(0, Number(v)), maxTop()); } });
  Object.assign(win, { V, scrollX: 0, scrollY: 0, scrollTo() {}, addEventListener(t, f) { (win[`on${t}`] ||= []).push(f); } });
  if (desktop) { // the box is 52 px tall and ends 64 px from the right; the header's bottom is at 67 px; the pop-up is 420 x 444 once open
    Object.assign(win, { innerHeight: desktop.vh, scrollY: desktop.scrollY, matchMedia: () => ({ matches: false }), scrollTo(o) { scrolled.push(`page to ${o.top}`); win.scrollY = o.top; } });
    docEl.clientWidth = desktop.vw;
    Object.assign($("#lookup"), { offsetTop: desktop.boxY, offsetLeft: desktop.vw - 64 - 460, offsetWidth: 460, offsetHeight: 52, offsetParent: null, clientTop: 0, clientLeft: 0 }); // as laid out
    $(".site-header").getBoundingClientRect = () => ({ bottom: 67 });
    $("#verify").scrollIntoView = (o) => { scrolled.push(`#verify ${o && o.behavior}`); win.scrollY = desktop.boxY - 84; }; // html's scroll-padding-top
    Object.defineProperty(pop, "offsetWidth", { get: () => (pop.open ? 420 : 0) }); Object.defineProperty(pop, "offsetHeight", { get: () => (pop.open ? 444 : 0) });
  }
  vm.runInNewContext(js, { window: win, document: { hidden: false, documentElement: docEl }, location: { search, hash }, URLSearchParams, Intl, Date, setInterval: () => 0, setTimeout: (f) => f(), clearTimeout() {}, requestAnimationFrame: (f) => frames.push(f) });
  const settle = () => new Promise((r) => setImmediate(r));
  const frame = () => { const f = frames.shift(); if (f) f(); return Boolean(f); };
  const flush = () => { let n = 0; while (frame()) n++; return n; };
  const rows = () => $$("#holders-body tr"), visible = () => rows().filter((r) => !r.hidden);
  return { $, box, rows, visible, settle, frame, flush, frames, calls, statuses, pop, focused, scrolled, win, docEl };
}

test("token.js: 5,000 holders arrive in pages of 1,000 with progress in the status line, go into the table 250 per frame, every one of them, masked as before", async () => {
  const all = fakeHolders(5000);
  const p = page({ answer: (path) => pageOf(all, Number(new URL(path, "https://x").searchParams.get("offset")) || 0) });
  await p.settle();
  assert.deepEqual(p.calls.filter((c) => c.startsWith("/api/holders")), ["/api/holders", "/api/holders?offset=1000", "/api/holders?offset=2000", "/api/holders?offset=3000", "/api/holders?offset=4000"]);
  assert.deepEqual(p.statuses.filter((s) => s.includes("loaded")), ["1,000 of 5,000 loaded…", "2,000 of 5,000 loaded…", "3,000 of 5,000 loaded…", "4,000 of 5,000 loaded…"]);
  assert.match(p.statuses.at(-1), /^5,000 holders · updated /, "no 'showing the top N' once every holder is here");
  assert.equal(p.rows().length, 0, "nothing is drawn before the first animation frame");
  assert.ok(p.frame()); assert.equal(p.rows().length, 250, "one frame draws 250 rows");
  assert.equal(p.flush(), 19, "the rest takes 19 more frames");
  assert.equal(p.rows().length, 5000, "every holder is in the table");
  assert.equal(p.rows()[0].children[0].textContent, "1"); assert.equal(p.rows()[4999].children[0].textContent, "5000");
  const link = p.rows()[1234].children[1].children[0];
  assert.equal(link.textContent, MASK(owner(1234)), "the wallet is shown masked, as before");
  assert.equal(link.title, owner(1234)); assert.equal(p.rows()[1234].dataset.owner, owner(1234));
  assert.equal(p.$("#st-holders").textContent, "5,000");
  assert.equal(p.$("#holders-refresh").hidden, false);
  assert.ok(p.$(".holders").classes.has("holders--live"), "the box takes its fixed height once the live list is in it");
});

test("token.js: before launch nothing is drawn and the card keeps its own height (no live class)", async () => {
  const p = page({ answer: () => ({ launched: false, holders: [] }) });
  await p.settle();
  assert.equal(p.flush(), 0);
  assert.deepEqual(p.statuses, ["The live holder list opens the moment $VICINITY launches."], "the page's own text says loading: the script says why nothing comes");
  assert.ok(!p.$(".holders").classes.has("holders--live"));
});

test("token.js: the find box filters every row: those already drawn and those still on their way", async () => {
  const all = fakeHolders(5000);
  const p = page({ answer: (path) => pageOf(all, Number(new URL(path, "https://x").searchParams.get("offset")) || 0) });
  await p.settle(); p.frame();
  assert.equal(p.visible().length, 250);
  p.$("#holders-find").value = "H0123"; await p.$("#holders-find").fire("input");
  assert.equal(p.visible().length, 0, "the drawn rows (ranks 1 to 250) are hidden at once");
  p.flush();
  assert.equal(p.rows().length, 5000);
  assert.deepEqual(p.visible().map((r) => r.dataset.owner), Array.from({ length: 10 }, (_, i) => owner(1230 + i)), "the ten matches among all 5,000, drawn later, are the ones showing");
  p.$("#holders-find").value = ""; await p.$("#holders-find").fire("input");
  assert.equal(p.visible().length, 5000, "clearing the box shows everyone again");
});

test("token.js: a Refresh while pages are still coming replaces the list once, never twice; a server hiccup mid-way says 'showing the top N'", async () => {
  const all = fakeHolders(2500);
  let hold = null, firstLoad = true;
  const p = page({ answer: (path) => {
    const offset = Number(new URL(path, "https://x").searchParams.get("offset")) || 0;
    if (firstLoad && offset === 1000) { firstLoad = false; return new Promise((r) => (hold = () => r(pageOf(all, offset)))); } // the first load's second page hangs
    return pageOf(all, offset);
  } });
  await p.settle();
  assert.ok(hold, "the first load is waiting for page two");
  await p.$("#holders-refresh").fire("click"); await p.settle();
  hold(); await p.settle();
  p.flush();
  assert.equal(p.rows().length, 2500, "the second load's 2,500 rows, nothing from the first");
  assert.equal(p.calls.filter((c) => c === "/api/holders?offset=2000").length, 1, "the first load stopped after its page came back");

  const q = page({ answer: (path) => { const o = Number(new URL(path, "https://x").searchParams.get("offset")) || 0; return o ? { launched: true, error: "chain_unavailable", _status: 503 } : pageOf(all, 0); } });
  await q.settle(); q.flush();
  assert.equal(q.rows().length, 1000);
  assert.match(q.statuses.at(-1), /^2,500 holders · showing the top 1,000 · updated /);
});

test("token.js: a Refresh keeps the reader's place past the first page, never leaves the table empty for a frame; a shorter list ends at its end", async () => {
  let all = fakeHolders(5000), hold = null, slow = false;
  const p = page({ answer: (path) => {
    const offset = Number(new URL(path, "https://x").searchParams.get("offset")) || 0;
    if (slow && offset === 1000) { slow = false; return new Promise((r) => (hold = () => r(pageOf(all, offset)))); } // the refresh's second page takes its time
    return pageOf(all, offset);
  } });
  await p.settle(); p.flush();
  assert.equal(p.rows().length, 5000);
  p.box.scrollTop = 60000; // row 1,304 of 5,000 at the top of the box
  tick(); slow = true;
  p.$("#holders-refresh").fire("click"); await p.settle(); // not awaited: this load waits for its second page
  assert.ok(hold, "the refresh is waiting for its second page");
  assert.equal(p.rows().length, 5000, "the rows on screen stay until the new ones are drawn");
  const seen = []; while (p.frame()) seen.push(p.rows().length);
  assert.deepEqual(seen, [250, 500, 750, 1000], "the first chunk replaces the old rows, the next ones add to it: never an empty table");
  assert.equal(p.box.scrollTop, 1000 * 46 - 400, "the box can't reach the reader's row yet, so it sits at its end for now");
  hold(); await p.settle(); p.flush();
  assert.equal(p.rows().length, 5000);
  assert.equal(p.box.scrollTop, 60000, "once the rows reach that far, the reader is back where they were");
  // the list comes back shorter than where the reader was: the box ends at its end, and that old place is not kept for the next refresh
  all = fakeHolders(1000); tick();
  await p.$("#holders-refresh").fire("click"); await p.settle(); p.flush();
  assert.equal(p.rows().length, 1000);
  assert.equal(p.box.scrollTop, 1000 * 46 - 400);
  p.box.scrollTop = 1000; all = fakeHolders(5000); tick();
  await p.$("#holders-refresh").fire("click"); await p.settle(); p.flush();
  assert.equal(p.rows().length, 5000);
  assert.equal(p.box.scrollTop, 1000, "the place the reader chose after that, not the one from two refreshes ago");
});

test("token.js: a refresh that gets the snapshot already on screen asks for no further pages and redraws nothing; a newer snapshot is drawn afresh", async () => {
  const all = fakeHolders(2500);
  const p = page({ answer: (path) => pageOf(all, Number(new URL(path, "https://x").searchParams.get("offset")) || 0) });
  await p.settle(); p.flush();
  const before = p.rows(), calls = p.calls.length, status = p.statuses.at(-1);
  assert.equal(before.length, 2500);
  await p.$("#holders-refresh").fire("click"); await p.settle();
  assert.deepEqual(p.calls.slice(calls), ["/api/holders"], "one request to learn nothing changed, no page two or three");
  assert.equal(p.flush(), 0, "nothing queued for the table");
  assert.ok(p.rows().length === 2500 && p.rows().every((tr, i) => tr === before[i]), "the very same rows stay (with their filter and highlight)");
  assert.equal(p.statuses.at(-1), status);
  tick();
  await p.$("#holders-refresh").fire("click"); await p.settle();
  assert.deepEqual(p.calls.slice(calls + 1), ["/api/holders", "/api/holders?offset=1000", "/api/holders?offset=2000"]);
  assert.equal(p.flush(), 10);
  assert.ok(p.rows().length === 2500 && p.rows()[0] !== before[0], "a newer snapshot is drawn afresh");
  assert.match(p.statuses.at(-1), /^2,500 holders · updated /);
});

test("token.js: 'Show it in the holder list' appears when the looked-up wallet's row lands after the lookup", async () => {
  const all = fakeHolders(5000), me = owner(4798);
  let hold = null;
  const p = page({ answer: (path) => {
    if (path.startsWith("/api/rank")) return { launched: true, full: true, address: me, amount: all[4798].amount, rank: 4799, total: 5000, percent: all[4798].percent, percentile: 95.98, next: { rank: 4798, gap: 10 }, founderMin: 100_000 };
    const offset = Number(new URL(path, "https://x").searchParams.get("offset")) || 0;
    if (offset === 1000 && !hold) return new Promise((r) => (hold = () => r(pageOf(all, offset)))); // the second page is slow
    return pageOf(all, offset);
  } });
  await p.settle(); p.flush();
  assert.equal(p.rows().length, 1000, "the first page is drawn, the second is on its way");
  p.$("#holders-find").value = me; await p.$("#lookup").fire("submit"); await p.settle();
  assert.equal(p.$("#rank-num").textContent, "#4,799");
  assert.equal(p.$("#rank-show").hidden, true, "the row isn't in the table yet");
  hold(); await p.settle(); p.flush();
  assert.equal(p.rows().length, 5000);
  assert.deepEqual(p.rows().filter((tr) => tr.classes.has("is-me")).map((tr) => tr.dataset.owner), [me], "the row is highlighted when it lands");
  assert.equal(p.$("#rank-show").hidden, false, "and the button that scrolls to it is showing");
});

test("token.js: a lookup never keeps the last wallet's values (a pool after a ranked wallet), and a wallet with nothing is told any amount enters", async () => {
  // measured live 3 Oct 2026: after a ranked wallet, the pool showed the wallet's "128,768,512 to pass #1" and its half-full
  // meter under "not ranked"; a wallet holding nothing was told "6,573,219 to enter at #5" when any amount enters at #5
  const POOL = owner(9001), RANKED = owner(2), NOBODY = owner(9002), BUSY = owner(9003);
  const answers = {
    [RANKED]: { launched: true, full: true, amount: 48_497_309, rank: 2, total: 4, label: null, percent: 4.85, percentile: 50, next: { rank: 1, amount: 177_265_821, gap: 128_768_512 }, founderMin: 100_000 },
    [POOL]: { launched: true, full: true, amount: 732_489_439, rank: null, total: 4, label: "Pool or program account", percent: 73.2, percentile: null, next: { rank: 4, amount: 6_573_218, gap: 6_573_218 }, founderMin: 100_000 },
    [NOBODY]: { launched: true, full: true, amount: 0, rank: null, total: 4, label: null, percent: 0, percentile: null, next: { rank: 4, amount: 6_573_218.776691, gap: 6_573_218.776691 }, founderMin: 100_000 },
    [BUSY]: { error: "chain_unavailable" },
  };
  const p = page({ answer: (path) => (path.startsWith("/api/rank") ? answers[new URL(path, "https://x").searchParams.get("address")] : { launched: false, holders: [] }) });
  await p.settle();
  const look = async (a) => { p.$("#holders-find").value = a; await p.$("#lookup").fire("submit"); await p.settle(); p.flush(); };
  const card = () => ["#rank-num", "#rank-of", "#rank-amount", "#rank-share", "#rank-next", "#rank-founder"].map((id) => p.$(id).textContent);

  await look(RANKED);
  assert.equal(p.$("#rank-next").textContent, "128,768,512 to pass #1");
  assert.equal(p.$("#rank-meter").style.width, "50%");

  await look(POOL);
  assert.deepEqual(card(), ["Pool", "Pool or program account", "732,489,439 $VICINITY", "73.2%", "—", "—"], "no rank, nothing to pass, not a founder");
  assert.equal(p.$("#rank-meter").style.width, "0%", "the meter is empty for a pool");

  await look(NOBODY);
  assert.equal(p.$("#rank-next").textContent, "Any amount enters at #5; 6,573,219 to pass #4");

  await look(RANKED); await look(BUSY);
  assert.deepEqual(card(), ["—", "", "—", "—", "—", "—"], "the blockchain is busy: nothing of the wallet before is shown under the new address");
  assert.equal(p.$("#rank-meter").style.width, "0%");
  assert.equal(p.$("#rank-pct").textContent, "The blockchain is busy. Try again in a minute.");
  assert.ok(p.$("#rank-facts").hidden && p.$("#rank-bar").hidden && p.$("#rank-big").hidden, "a message alone in the pop-up: no blank facts, no 'Rank —'");
  await look(RANKED);
  assert.ok(!p.$("#rank-facts").hidden && !p.$("#rank-bar").hidden && !p.$("#rank-big").hidden, "and they are back for the next wallet");
});

test("token.js: Check rank (or Enter) in the find box opens the pop-up with the rank; a partial address opens it with what a check needs, asking nothing", async () => {
  const all = fakeHolders(300), me = owner(57);
  const p = page({ answer: (path) => path.startsWith("/api/rank")
    ? { launched: true, full: true, address: me, amount: all[57].amount, rank: 58, total: 300, label: null, percent: all[57].percent, percentile: 19.33, next: { rank: 57, amount: all[56].amount, gap: 10 }, founderMin: 100_000 }
    : pageOf(all, 0) });
  await p.settle(); p.flush();
  // typing filters the list as before; nothing is asked of /api/rank
  p.$("#holders-find").value = me.slice(0, 5); await p.$("#holders-find").fire("input");
  assert.deepEqual(p.visible().map((r) => r.dataset.owner), Array.from({ length: 10 }, (_, i) => owner(50 + i)), "part of an address filters the list, as before");
  assert.ok(!p.calls.some((c) => c.startsWith("/api/rank")));
  // a partial address + Check rank: the pop-up says what is needed; the list stays filtered; no request
  await p.$("#lookup").fire("submit"); await p.settle();
  assert.equal(p.pop.open, true, "the pop-up opened");
  assert.equal(p.$("#rank-pct").textContent, "Paste a full wallet address to check its rank.");
  assert.ok(p.$("#rank-big").hidden && p.$("#rank-facts").hidden && p.$("#rank-bar").hidden && p.$("#rank-show").hidden, "a message alone");
  assert.equal(p.$("#rank-addr").textContent, "");
  assert.equal(p.pop.getAttribute("aria-describedby"), "rank-pct", "it is described by the message alone");
  assert.equal(p.focused.at(-1), "#rank-close", "the keyboard moved into it");
  assert.ok(!p.calls.some((c) => c.startsWith("/api/rank")), "nothing was asked of the server");
  // Escape: the browser's cancel, handled as a close (with the quick fade), and the keyboard goes back to the box's button
  const esc = await p.pop.fire("cancel");
  assert.ok(esc.defaultPrevented, "the page closes it itself");
  assert.equal(p.pop.open, false, "closed");
  assert.equal(p.focused.at(-1), "#lookup button", "the keyboard is back on the box");
  // the full address + Check rank: one request, then the pop-up with the rank of how many, the meter and the facts
  p.$("#holders-find").value = me; await p.$("#holders-find").fire("input");
  await p.$("#lookup").fire("submit"); await p.settle(); p.flush();
  assert.deepEqual(p.calls.filter((c) => c.startsWith("/api/rank")), [`/api/rank?address=${me}`]);
  assert.equal(p.pop.open, true); assert.equal(p.pop.shown, 2);
  assert.deepEqual(["#rank-addr", "#rank-num", "#rank-of", "#rank-pct", "#rank-amount", "#rank-next", "#rank-founder"].map((id) => p.$(id).textContent),
    [me, "#58", "of 300 holders", "Top 19.3% of all holders", `${all[57].amount.toLocaleString("en-US")} $VICINITY`, "10 to pass #57", "97,570 to reach the smallest"]);
  assert.equal(p.$("#rank-meter").style.width, "80.67%");
  assert.ok(!p.$("#rank-big").hidden && !p.$("#rank-facts").hidden && !p.$("#rank-show").hidden, "rank, facts, and the row is in the list");
  assert.equal(p.pop.getAttribute("aria-describedby"), "rank-big rank-pct", "announced with its rank and the line under it");
  assert.equal(p.$("#lookup button").textContent, "Check rank"); assert.equal(p.$("#lookup button").disabled, false);
  // a tap outside it (on the dialog itself, around its card) closes it; a tap inside does not
  await p.pop.fire("pointerdown", { target: p.$("#rank-big") }); await p.pop.fire("click", { target: p.$("#rank-big") });
  assert.equal(p.pop.open, true, "a tap on the card keeps it");
  // selecting the address with the mouse and letting go outside the card: the click lands on the dialog, but it began on the card
  await p.pop.fire("pointerdown", { target: p.$("#rank-addr") }); await p.pop.fire("click", { target: p.pop });
  assert.equal(p.pop.open, true, "a drag that ends outside keeps it");
  await p.pop.fire("pointerdown", { target: p.pop }); await p.pop.fire("click", { target: p.pop });
  assert.equal(p.pop.open, false, "a tap outside closes it");
  // the close button
  await p.$("#lookup").fire("submit"); await p.settle();
  assert.equal(p.pop.open, true);
  await p.$("#rank-close").fire("click");
  assert.equal(p.pop.open, false);
  assert.equal(p.focused.at(-1), "#lookup button");
});

test("token.js: 'Show it in the holder list' closes the pop-up, brings the table into view and scrolls it to the wallet's row, highlighted among every row", async () => {
  const all = fakeHolders(300), me = owner(120);
  const p = page({ answer: (path) => path.startsWith("/api/rank")
    ? { launched: true, full: true, address: me, amount: all[120].amount, rank: 121, total: 300, label: null, percent: all[120].percent, percentile: 40.33, next: { rank: 120, gap: 10 }, founderMin: 100_000 }
    : pageOf(all, 0) });
  await p.settle(); p.flush();
  p.$("#holders-find").value = me; await p.$("#holders-find").fire("input"); await p.$("#lookup").fire("submit"); await p.settle(); p.flush();
  assert.deepEqual(p.rows().filter((tr) => tr.classes.has("is-me")).map((tr) => tr.dataset.owner), [me], "the looked-up row is highlighted");
  assert.deepEqual(p.visible().map((tr) => tr.dataset.owner), [me], "the box filters the list down to it meanwhile");
  p.scrolled.length = 0;
  await p.$("#rank-show").fire("click");
  assert.equal(p.pop.open, false, "the pop-up is closed");
  assert.equal(p.$("#holders-find").value, "", "the box is cleared...");
  assert.equal(p.visible().length, 300, "...so the row shows among every holder");
  assert.deepEqual(p.scrolled, ["#holders-scroll", "#holders-scroll to a row"], "the table into view, then the table itself to the row");
  assert.deepEqual(p.rows().filter((tr) => tr.classes.has("is-me")).map((tr) => tr.dataset.owner), [me]);
});

test("token.js: the old links land: /token#buy opens How do I get $VICINITY? in the FAQ, /token#verify focuses the box (again once what loads above has moved them)", async () => {
  const all = fakeHolders(300);
  const buy = page({ hash: "#buy", answer: () => pageOf(all, 0) });
  assert.equal(buy.$("#buy").open, true, "the answer is open");
  assert.deepEqual(buy.scrolled, ["#buy"], "and in view");
  await buy.settle(); buy.flush();
  assert.ok(buy.scrolled.filter((s) => s === "#buy").length >= 2, "the live list (fixed height) moved the FAQ: the reader is put back on it");
  const n = buy.scrolled.length;
  buy.win.onwheel.forEach((f) => f()); // the reader scrolls: from then on the page is theirs
  await buy.$("#holders-refresh").fire("click"); await buy.settle(); buy.flush();
  assert.equal(buy.scrolled.filter((s) => s === "#buy").length, buy.scrolled.slice(0, n).filter((s) => s === "#buy").length, "never moved again");

  const verify = page({ hash: "#verify", answer: () => pageOf(all, 0) });
  assert.deepEqual(verify.scrolled, ["#verify"], "the box, in the holders section");
  assert.deepEqual(verify.focused, ["#holders-find"], "and the keyboard in it");
  // the browser focuses the link's target itself (on load, or a #verify link clicked while the hash is #verify already): on into the field
  await verify.$("#verify").fire("focus");
  assert.deepEqual(verify.focused, ["#holders-find", "#holders-find"]);
  // the contract card's answer and the live list move what is below them: put back on the box (and the field) until the reader moves
  await verify.settle(); verify.flush(); verify.win.onload.forEach((f) => f()); verify.flush();
  assert.ok(verify.scrolled.filter((s) => s === "#verify").length >= 3, "landed again after the token facts, the live list and the page's load");
  assert.ok(verify.focused.every((f) => f === "#holders-find"));
  assert.notEqual(verify.$("#buy").open, true, "the FAQ answer stays closed");

  const plain = page({ answer: () => pageOf(all, 0) });
  assert.deepEqual([plain.scrolled, plain.focused], [[], []], "no hash: nothing moves, nothing is focused");
  // a link inside the page (the FAQ's "box above the holder list") lands the same way
  plain.win.onhashchange.forEach((f) => f());
  assert.deepEqual(plain.scrolled, [], "a hash the page doesn't know: nothing");
});

test("token.js: /token?address=... fills the box, filters the list and opens the answer; on a first visit it waits for the terms", async () => {
  const all = fakeHolders(300), me = owner(9);
  const p = page({ search: `?address=${me}`, answer: (path) => path.startsWith("/api/rank") ? { launched: true, full: true, address: me, amount: all[9].amount, rank: 10, total: 300, percentile: 3.33, next: { rank: 9, gap: 10 }, founderMin: 100_000 } : pageOf(all, 0) });
  await p.settle(); p.flush();
  assert.equal(p.$("#holders-find").value, me);
  assert.deepEqual(p.visible().map((r) => r.dataset.owner), [me], "the list shows that wallet");
  assert.equal(p.pop.open, true); assert.equal(p.$("#rank-num").textContent, "#10");
  // the gate is open: nothing opens over it until the visitor agrees
  const q = page({ search: `?address=${me}`, answer: (path) => path.startsWith("/api/rank") ? { launched: true, full: true, amount: 0, rank: null, total: 300, next: { rank: 299, gap: 3 }, founderMin: 100_000 } : pageOf(all, 0) });
  q.$("#termsgate").hidden = false; // a first visit: the terms gate is up when the answer comes back
  await q.settle();
  assert.equal(q.pop.open, false, "not over the terms gate");
  q.$("#termsgate").hidden = true; await q.$("#termsgate-agree").fire("click");
  assert.equal(q.pop.open, true, "it opens once the terms are agreed");
  assert.equal(q.$("#rank-of").textContent, "not holding yet");
});

test("token.js: one check at a time: Check rank or Enter again while the first check is on its way sends nothing", async () => {
  const all = fakeHolders(300), me = owner(57);
  let release = null;
  const p = page({ answer: (path) => path.startsWith("/api/rank")
    ? new Promise((r) => (release = () => r({ launched: true, full: true, address: me, amount: all[57].amount, rank: 58, total: 300, percent: all[57].percent, percentile: 19.33, next: { rank: 57, gap: 10 }, founderMin: 100_000 })))
    : pageOf(all, 0) });
  await p.settle(); p.flush();
  p.$("#holders-find").value = me;
  p.$("#lookup").fire("submit"); await p.settle();
  assert.equal(p.$("#lookup button").disabled, true); assert.equal(p.$("#lookup button").textContent, "Checking…");
  p.$("#lookup").fire("submit"); p.$("#lookup").fire("submit"); await p.settle();
  assert.equal(p.calls.filter((c) => c.startsWith("/api/rank")).length, 1, "the second and third press asked nothing");
  assert.equal(p.pop.open, false, "nothing opens before the answer");
  release(); await p.settle();
  assert.equal(p.pop.open, true); assert.equal(p.$("#rank-num").textContent, "#58");
  assert.equal(p.$("#lookup button").disabled, false); assert.equal(p.$("#lookup button").textContent, "Check rank");
});

test("token.js: a mistyped address, no connection, a server error or too many checks: each its own message in the pop-up, never 'Ranks go live' on a live token", async () => {
  // measured on the branch before this fix: all three of a 43-character typo (the server's 400 bad_address), a 500 and a dropped
  // connection said "Ranks go live the moment $VICINITY launches" with every fact "At launch"
  const B58 = (c) => c.padEnd(44, "y"); // 44 base58 characters: the page's own check passes them, as site.js's would
  const answers = { [B58("T")]: { error: "bad_address", ok: false, _status: 400 }, [B58("W")]: { ok: false, error: "offline", _status: 0 },
    [B58("F")]: { ok: false, _status: 500 }, [B58("S")]: { error: "slow_down", ok: false, _status: 429 }, [B58("N")]: { launched: false, address: B58("N"), founderMin: 100_000 } };
  const p = page({ isAddr: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a), answer: (path) => (path.startsWith("/api/rank") ? answers[new URL(path, "https://x").searchParams.get("address")] : { launched: false, holders: [] }) });
  await p.settle();
  const check = async (a) => { p.$("#holders-find").value = a; await p.$("#lookup").fire("submit"); await p.settle();
    const out = { text: p.$("#rank-pct").textContent, alone: p.$("#rank-facts").hidden && p.$("#rank-bar").hidden && p.$("#rank-big").hidden && p.$("#rank-show").hidden, open: p.pop.open };
    await p.pop.fire("cancel"); return out; };
  const alone = (text) => ({ text, alone: true, open: true });
  assert.deepEqual(await check(B58("T")), alone("That doesn't look like a Solana wallet address."), "the server's 400 bad_address");
  assert.deepEqual(await check(B58("W")), alone("Couldn't check right now. Try again in a minute."), "no connection");
  assert.deepEqual(await check(B58("F")), alone("Couldn't check right now. Try again in a minute."), "a server error (no JSON)");
  assert.deepEqual(await check(B58("S")), alone("Too many checks from your network. Try again in a minute."));
  const calls = p.calls.filter((c) => c.startsWith("/api/rank")).length;
  // the page's own check: a whole address that isn't Solana's (an Ethereum one), part of one, nothing at all; no request for any
  assert.deepEqual(await check("0x52908400098527886E0F7030069857D2E4169EE7"), alone("That doesn't look like a Solana wallet address."));
  assert.deepEqual(await check("B58yy"), alone("Paste a full wallet address to check its rank."));
  assert.deepEqual(await check(""), alone("Paste a full wallet address to check its rank."));
  assert.equal(p.calls.filter((c) => c.startsWith("/api/rank")).length, calls, "the page's own check asked the server nothing");
  // before the launch (the server says launched: false), and only then: the facts say when
  await check(B58("N"));
  assert.equal(p.$("#rank-pct").textContent, "Ranks go live the moment $VICINITY launches. Save this page and check back.");
  assert.equal(p.$("#rank-amount").textContent, "At launch");
});

test("token.js: after the minute refresh, a pop-up that shows a message keeps 'Show it in the holder list' hidden (it would point at the wallet checked before)", async () => {
  const all = fakeHolders(300), me = owner(57);
  let busy = false;
  const p = page({ answer: (path) => path.startsWith("/api/rank")
    ? (busy ? { launched: true, error: "chain_unavailable", _status: 503 } : { launched: true, full: true, address: me, amount: all[57].amount, rank: 58, total: 300, percent: all[57].percent, percentile: 19.33, next: { rank: 57, gap: 10 }, founderMin: 100_000 })
    : pageOf(all, 0) });
  await p.settle(); p.flush();
  const check = async (a) => { p.$("#holders-find").value = a; await p.$("#holders-find").fire("input"); await p.$("#lookup").fire("submit"); await p.settle(); p.flush(); };
  const refresh = async () => { tick(); await p.$("#holders-refresh").fire("click"); await p.settle(); p.flush(); };
  await check(me);
  assert.equal(p.$("#rank-show").hidden, false, "a holder: the button");
  await p.$("#rank-close").fire("click");
  await check("abc"); // part of an address
  assert.equal(p.$("#rank-pct").textContent, "Paste a full wallet address to check its rank.");
  await refresh();
  assert.equal(p.pop.open, true);
  assert.equal(p.$("#rank-show").hidden, true, "still hidden after the refresh");
  await p.$("#rank-close").fire("click");
  busy = true; await check(me); // the same holder, the chain busy: a message, and the wallet's row is in the list
  assert.equal(p.$("#rank-pct").textContent, "The blockchain is busy. Try again in a minute.");
  await refresh();
  assert.equal(p.$("#rank-show").hidden, true, "a message about a listed wallet: still no button");
  await p.$("#rank-close").fire("click");
  busy = false; await check(me);
  assert.equal(p.$("#rank-show").hidden, false, "its facts again: the button again");
  await refresh();
  assert.equal(p.$("#rank-show").hidden, false);
});

test("token.js: on a computer the first pop-up of a visit opens under the box, where the reader is: placed before it opens, its own focus scroll undone at once", async () => {
  // measured on the branch before this fix (1920x1080 and 8 other sizes): the first Check rank of a visit scrolled the page smoothly to
  // the top (showModal's focus scroll towards the dialog's unplaced spot, too late to undo) and the pop-up opened off screen
  const all = fakeHolders(300), me = owner(57);
  const rank = { launched: true, full: true, address: me, amount: all[57].amount, rank: 58, total: 300, percent: all[57].percent, percentile: 19.33, next: { rank: 57, gap: 10 }, founderMin: 100_000 };
  const p = page({ desktop: { vw: 1920, vh: 1080, boxY: 1100, scrollY: 700 }, answer: (path) => (path.startsWith("/api/rank") ? rank : pageOf(all, 0)) });
  await p.settle(); p.flush();
  p.$("#holders-find").value = me; await p.$("#lookup").fire("submit"); await p.settle();
  assert.equal(p.pop.open, true);
  assert.deepEqual(p.pop.atShow, { scrollBehavior: "auto", popY: "1160px" }, "already by the box (8 px under it), and its focus scroll instant");
  assert.equal(p.win.scrollY, 700, "the page is back where the reader was");
  assert.ok(p.scrolled.includes("page to 700"), "the jump was undone");
  assert.ok(!p.docEl.style.scrollBehavior, "the page's own smooth scrolling is back");
  assert.equal(p.pop.style["--pop-y"], "1160px", "placed from where the page is (not from the top it jumped to)");
  assert.ok(!p.pop.classes.has("is-above"), "under the box: there is room");
  assert.ok(!p.scrolled.some((s) => s.startsWith("#verify")), "the box was in view: nothing else moved");
  // a box near the bottom of the window: the pop-up goes above it, measured at its real size once open
  const q = page({ desktop: { vw: 1280, vh: 900, boxY: 1400, scrollY: 700 }, answer: (path) => (path.startsWith("/api/rank") ? rank : pageOf(all, 0)) });
  await q.settle(); q.flush();
  q.$("#holders-find").value = me; await q.$("#lookup").fire("submit"); await q.settle();
  assert.equal(q.win.scrollY, 700);
  assert.ok(q.pop.classes.has("is-above"));
  assert.equal(q.pop.style["--pop-y"], `${1400 - 8 - 444}px`, "its bottom 8 px over the box");
});

test("token.js: /token?address=... on a computer brings the box into view first and opens the pop-up under it, never over the hero", async () => {
  const all = fakeHolders(300), me = owner(9);
  const p = page({ search: `?address=${me}`, desktop: { vw: 1280, vh: 900, boxY: 1057, scrollY: 0 },
    answer: (path) => path.startsWith("/api/rank") ? { launched: true, full: true, address: me, amount: all[9].amount, rank: 10, total: 300, percentile: 3.33, next: { rank: 9, gap: 10 }, founderMin: 100_000 } : pageOf(all, 0) });
  await p.settle(); p.flush();
  assert.equal(p.pop.open, true);
  assert.ok(p.scrolled.includes("#verify instant"), "the box below the fold came into view, at once");
  assert.deepEqual(p.focused, ["#holders-find", "#rank-close"], "the field first (the card shows at once, not rising in), then the pop-up");
  assert.equal(p.win.scrollY, 1057 - 84);
  assert.equal(p.pop.style["--pop-y"], `${1057 + 52 + 8}px`, "under the box");
  assert.ok(!p.pop.classes.has("is-above"));
});

test("token.js: /token#verify and /token#buy land while the page loads, then never again: the minute refresh moves neither the page nor the keyboard", async () => {
  // measured on the branch before this fix: with no wheel, touch, key or pointer (a screen reader's reading cursor), every refresh with a
  // new snapshot scrolled the page back to #verify (and the keyboard into the box) or to #buy, for as long as the page was open
  for (const hash of ["#verify", "#buy"]) {
    const all = fakeHolders(300);
    const p = page({ hash, answer: (path) => pageOf(all, Number(new URL(path, "https://x").searchParams.get("offset")) || 0) });
    await p.settle(); p.flush(); p.win.onload.forEach((f) => f()); p.flush();
    assert.ok(p.scrolled.filter((s) => s === hash).length >= 3, `${hash}: landed, and again after the token facts, the live list and the load`);
    const scrolled = p.scrolled.length, focused = p.focused.length;
    for (let i = 0; i < 3; i++) { tick(); await p.$("#holders-refresh").fire("click"); await p.settle(); p.flush(); }
    assert.equal(p.rows().length, 300, "three new snapshots were drawn");
    assert.equal(p.scrolled.length, scrolled, `${hash}: the page stayed where the reader took it`);
    assert.equal(p.focused.length, focused, `${hash}: the keyboard too`);
  }
});

test("token.js: a click or tap on the line under the box leaves the keyboard out of the field; a #verify link sends it in", async () => {
  const p = page({ answer: () => ({ launched: false, holders: [] }) });
  await p.settle();
  const verify = p.$("#verify"), hint = p.$("#holders-hint");
  verify.contains = (t) => t === verify || t === hint; // the hint is inside #verify (tabindex -1: a click on it focuses #verify)
  p.win.onpointerdown.forEach((f) => f({ target: hint })); await verify.fire("focus");
  assert.deepEqual(p.focused, [], "a tap on the text: no keyboard on a phone, the text can be selected");
  p.win.onpointerdown.forEach((f) => f({ target: p.$("#faq") })); await verify.fire("focus");
  assert.deepEqual(p.focused, ["#holders-find"], "a click on a link to #verify (in the FAQ): on into the field");
  p.win.onpointerdown.forEach((f) => f({ target: hint })); p.win.onkeydown.forEach((f) => f({})); await verify.fire("focus");
  assert.deepEqual(p.focused, ["#holders-find", "#holders-find"], "Enter on such a link: the same");
});

test("token page after launch: no 'the moment it launches' copy, and nothing in the page before its script runs names a date instead of the contract", () => {
  // live 3 Oct 2026 after the launch: the lead said numbers are read live "the moment the token is live", step 3 said the Buy
  // button "appears the moment $VICINITY launches", and before token.js ran (or when the chain was busy) the contract box read
  // "October 3, 2026 — Raydium LaunchLab" with "Until it's published here, any $VICINITY you see is fake"
  for (const h of [html, src]) {
    assert.doesNotMatch(h, /the moment the token is live|it appears the moment \$VICINITY launches|opens the moment \$VICINITY launches/);
    assert.doesNotMatch(h, /October 3, 2026/, "no date where the contract goes");
    assert.doesNotMatch(h, /Until it's published here/);
    assert.doesNotMatch(h, />At launch</);
    assert.doesNotMatch(h, /Checked live at launch/);
  }
  assert.match(html, /<p class="lead">The key to the Vicinity map\. Every number on this page is read live from the blockchain\. Don't trust us, check the chain\.<\/p>/);
  assert.match(html, /<code id="ca-text">Loading…<\/code>/);
});

test("token.js: while the chain is busy (/api/token 503) the official contract, its links and the official list still show; before launch it says not published", async () => {
  const busy = page({ token: { launched: true, error: "chain_unavailable", mint: MINT, registry: [{ network: "Solana", name: "Vicinity", symbol: "VICINITY", contract: MINT, status: "Live" }], _status: 503 },
    answer: () => ({ launched: true, error: "chain_unavailable" }) });
  await busy.settle();
  assert.equal(busy.$("#ca-text").textContent, MINT);
  assert.equal(busy.$("#ca-links").hidden, false);
  assert.equal(busy.$("#lnk-raydium").href, `https://raydium.io/launchpad/token/?mint=${MINT}`);
  assert.equal(busy.$("#ca-note").textContent, "This is the only official $VICINITY. Anything else using the name is fake.");
  assert.equal(busy.$("#registry-body").children.length, 1, "the official list is drawn from the settings");

  const before = page({ answer: () => ({ launched: false, holders: [] }) });
  await before.settle();
  assert.equal(before.$("#ca-text").textContent, "Not published yet");
  assert.match(before.$("#ca-note").textContent, /Until it's published here/);
  assert.equal(before.$("#lnk-raydium").href, undefined, "no trade link before there is a contract");
  assert.equal(before.statuses.at(-1), "The live holder list opens the moment $VICINITY launches.");
});

test("token page on phones: the holder list and the official list are re-laid out to fit (no column outside the card), the holder header stays pinned", () => {
  // measured 3 Oct 2026 at 320-414px: official list scrollWidth 398 in a 286-380px card (Status and the Live tag outside it), holder
  // list 356 in 252-346 (% of supply cut). Checked in Chromium after this change: scrollWidth = clientWidth at 320, 360, 390 and 414.
  const block = (() => { const i = css.indexOf("@media (max-width: 480px) {\n  .holders {"); assert.ok(i >= 0, "the phone block exists"); return css.slice(i, css.indexOf("\n}\n", i)); })();
  assert.match(block, /\.holders__table tr \{ display: grid; grid-template-columns: 2\.8em minmax\(0, 1fr\) auto;/);
  assert.match(block, /\.holders__table thead \{ position: sticky; top: 0;/, "the header row stays put while the rows scroll");
  assert.match(block, /\.holders__table :is\(th, td\):nth-child\(4\) \{ grid-column: 3; grid-row: 2;/, "% of supply under the amount");
  assert.match(block, /\.registry__table tr \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(block, /\.registry__table td:nth-child\(4\) \{ grid-column: 2;/, "the status (Live) at the right of the row");
  assert.match(block, /\.registry__table td:nth-child\(3\) \{ grid-column: 1 \/ -1;/, "the contract on a line of its own");
  assert.match(block, /\.registry__table thead \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\);/, "column names stay for screen readers");
});
