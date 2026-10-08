// The token page: the order of its sections (the owner, 8 Oct 2026: the hero, then "Holders · live", and "How to get $VICINITY" moved
// into a FAQ at the bottom), the holder list as a box that scrolls on its own (of fixed height once the live list is in it), and
// public/token.js run in node (no browser): every holder is fetched page by page and drawn 250 rows per animation frame, the find box
// covers every row, a Refresh during a load wins, a refresh keeps the reader's place and is skipped when the server hands back the
// snapshot already on screen, the looked-up wallet's row is found when it lands, and the old link /token#buy still lands.
// The server side of the paging (/api/holders?offset=N) is in test/holders-pages.test.js.
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

test("token page: hero, holders (live), verify a holder, no rug pull, official tokens, FAQ: in that order; no How to get section", () => {
  for (const h of [html, src]) {
    const at = (needle) => { const i = h.indexOf(needle); assert.ok(i >= 0, needle); return i; };
    const order = [at('<section class="page-hero" id="token">'), at('<section id="holders" class="section">'), at('id="verify"'), at('<p class="kicker">No rug pull</p>'), at('<section class="section section--panel" id="check">'), at('<section class="section" id="faq">')];
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "sections top to bottom: token, holders, verify, no rug pull, check, faq");
    const kicker = h.indexOf('<p class="kicker kicker--live"><span class="live-dot" aria-hidden="true"></span>Holders · live</p>');
    assert.ok(kicker > h.indexOf('id="holders"') && kicker < h.indexOf('id="verify"'), "the live kicker is the holders section's own");
    assert.ok(h.indexOf("Every real Vicinity token, on every network.") > h.indexOf("No rug pull"), "what followed the proof still follows it");
    // gone from the page body: the How to get section (its id lives on in the FAQ: see the deep-link test)
    assert.doesNotMatch(h, /<section[^>]*id="buy"/);
    assert.doesNotMatch(h, /How to get \$VICINITY<\/p>|class="buy-steps"/);
    for (const id of ["token", "contract", "buy", "verify", "lookup", "rank-card", "rank-show", "holders", "holders-status", "holders-find", "holders-refresh", "holders-scroll", "holders-table", "holders-body", "team-count", "check", "checker", "faq"]) assert.equal(h.split(`id="${id}"`).length - 1, 1, id);
    assert.ok(h.includes('<span id="holders-status" role="status" aria-live="polite">'), "the status line is the live region: a screen reader hears the progress, not every 250-row chunk");
    assert.doesNotMatch(h, /<div class="holders card"[^>]*aria-live/, "the card around the table is not a live region");
  }
  // the section looks alternate as before: no two identical panels next to each other
  const classes = [...html.matchAll(/<section class="([^"]+)"|<section id="holders" class="([^"]+)"/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(classes, ["page-hero", "section", "section section--glow", "section section--tight", "section section--panel", "section"]);
  // the holder list is above the verify card, so its button points up
  assert.match(html, /<button class="link-btn" type="button" id="rank-show">Show it in the holder list ↑<\/button>/);
  assert.doesNotMatch(html, /holder list ↓/);
});

test("token page: the hero is word for word what it was (Live from the Solana blockchain, $VICINITY, the contract card, the buttons, the stats)", () => {
  // origin/main 07fe1d5's hero, from <section class="page-hero" id="token"> to its </section>, hashed: any change to it fails here
  for (const h of [html, src]) {
    const a = h.indexOf('<section class="page-hero" id="token">'), b = h.indexOf("</section>", a) + "</section>".length;
    assert.equal(createHash("sha256").update(h.slice(a, b)).digest("hex"), HERO_SHA256);
  }
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
    assert.deepEqual(questions, ["How do I get $VICINITY?", "Is this the only official $VICINITY?", "What is the founder amount?"]);
    assert.ok(faq.indexOf("</section>") === faq.lastIndexOf("</section>"), "the FAQ is the last section");
  }
  assert.match(css, /\.faq \.scam-note strong \{ color: var\(--bad-text\); \}/, "the warning keeps its red, inside an answer too");
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

function page({ answer, token = { launched: false, registry: [] }, hash = "", search = "" }) {
  const nodes = new Map(), frames = [], calls = [], focused = [], scrolled = [], win = {};
  function node(tag = "div", sel = "") {
    const n = { tagName: tag.toUpperCase(), sel, children: [], dataset: {}, style: { setProperty(k, v) { n.style[k] = v; } }, attrs: {}, hidden: false, value: "", scrollTop: 0, _text: "", handlers: {}, classes: new Set(),
      get textContent() { return n._text; }, set textContent(t) { n._text = String(t); n.children = []; },
      append(...k) { n.children.push(...k); }, replaceChildren(...k) { n.children = k; }, scrollTo() { scrolled.push(`${n.sel} to a row`); }, offsetTop: 0, clientHeight: 400,
      scrollIntoView(o) { scrolled.push(n.sel); }, focus() { focused.push(n.sel); }, setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return n.attrs[k] ?? null; },
      addEventListener(t, f, o) { (n.handlers[t] ||= []).push(f); }, fire(t, ev = {}) { const e = { preventDefault() { e.defaultPrevented = true; }, target: null, ...ev }; return Promise.all((n.handlers[t] || []).map((f) => f(e))).then(() => e); },
      classList: { add: (c) => n.classes.add(c), remove: (...c) => c.forEach((x) => n.classes.delete(x)), toggle: (c, on) => (on ? n.classes.add(c) : n.classes.delete(c)), contains: (c) => n.classes.has(c) } };
    return n;
  }
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node(sel === "#holders-find" ? "input" : sel === "#rank-pop" ? "dialog" : "div", sel)); return nodes.get(sel); };
  $("#termsgate").hidden = true; // agreed already (the gate is site.js's)
  // the pop-up: a <dialog> as far as token.js uses one (showModal/close fire as the browser's do; "close" is an event of its own)
  const pop = $("#rank-pop"); pop.open = false; pop.shown = 0;
  pop.showModal = () => { pop.open = true; pop.shown++; }; pop.close = () => { if (!pop.open) return; pop.open = false; pop.fire("close"); };
  const $$ = (sel) => (sel === "#holders-body tr" ? $("#holders-body").children.filter((c) => c.tagName === "TR") : []);
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.classes.add(cls); if (text != null) n.textContent = text; return n; };
  const V = { $, $$, el, toast() {}, copy() {}, fmt: (x) => Number(x).toLocaleString("en-US"), compact: (x) => String(x), mask: MASK, isAddr: (a) => typeof a === "string" && a.length >= 32 && a.length <= 44, official: null, reduced: true, // the fake owners are 44 characters
    api: async (path) => { calls.push(path); await null; return path === "/api/token" ? token : answer(path); } };
  const statuses = []; const status = $("#holders-status"); Object.defineProperty(status, "textContent", { get: () => statuses[statuses.length - 1] || "", set: (t) => statuses.push(String(t)) });
  // the box: rows 46px tall, 400px of them in view; scrollTop clamps to the rows there are, as a browser's does, and stays clamped once rows go
  const ROW = 46, box = $("#holders-scroll"); let top = 0;
  const maxTop = () => Math.max(0, $("#holders-body").children.length * ROW - box.clientHeight);
  Object.defineProperty(box, "scrollHeight", { get: () => $("#holders-body").children.length * ROW });
  Object.defineProperty(box, "scrollTop", { get: () => (top = Math.min(top, maxTop())), set: (v) => { top = Math.min(Math.max(0, Number(v)), maxTop()); } });
  Object.assign(win, { V, scrollX: 0, scrollY: 0, scrollTo() {}, addEventListener(t, f) { (win[`on${t}`] ||= []).push(f); } });
  vm.runInNewContext(js, { window: win, document: { hidden: false, documentElement: { clientWidth: 1280 } }, location: { search, hash }, URLSearchParams, Intl, Date, setInterval: () => 0, setTimeout: (f) => f(), clearTimeout() {}, requestAnimationFrame: (f) => frames.push(f) });
  const settle = () => new Promise((r) => setImmediate(r));
  const frame = () => { const f = frames.shift(); if (f) f(); return Boolean(f); };
  const flush = () => { let n = 0; while (frame()) n++; return n; };
  const rows = () => $$("#holders-body tr"), visible = () => rows().filter((r) => !r.hidden);
  return { $, box, rows, visible, settle, frame, flush, frames, calls, statuses, pop, focused, scrolled, win };
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
  p.$("#lookup-input").value = me; await p.$("#lookup").fire("submit"); await p.settle();
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
  const look = async (a) => { p.$("#lookup-input").value = a; await p.$("#lookup").fire("submit"); await p.settle(); p.flush(); };
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
});

test("token.js: the old link /token#buy opens How do I get $VICINITY? in the FAQ (again once what loads above has moved it)", async () => {
  const all = fakeHolders(300);
  const buy = page({ hash: "#buy", answer: () => pageOf(all, 0) });
  assert.equal(buy.$("#buy").open, true, "the answer is open");
  assert.deepEqual(buy.scrolled, ["#buy"], "and in view");
  await buy.settle(); buy.flush();
  assert.ok(buy.scrolled.filter((s) => s === "#buy").length >= 2, "the live list (fixed height) moved the FAQ: the reader is put back on it");
  const n = buy.scrolled.length;
  buy.win.onwheel.forEach((f) => f()); // the reader scrolls: from then on the page is theirs
  await buy.$("#holders-refresh").fire("click"); await buy.settle(); buy.flush(); buy.win.onload.forEach((f) => f()); buy.flush();
  assert.equal(buy.scrolled.filter((s) => s === "#buy").length, buy.scrolled.slice(0, n).filter((s) => s === "#buy").length, "never moved again");

  const plain = page({ answer: () => pageOf(all, 0) });
  await plain.settle(); plain.flush();
  assert.deepEqual([plain.scrolled, plain.focused], [[], []], "no hash: nothing moves, nothing is focused");
  plain.win.onhashchange.forEach((f) => f());
  assert.deepEqual(plain.scrolled, [], "a hash the page doesn't know: nothing");
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
