// The token page: the order of its sections, the holder list as a box that scrolls on its own (of fixed height once the live
// list is in it), and public/token.js's holder table run in node (no browser): every holder is fetched page by page and drawn
// 250 rows per animation frame, the find box covers every row, a Refresh during a load wins, a refresh keeps the reader's place
// and is skipped when the server hands back the snapshot already on screen, the looked-up wallet's row is found when it lands.
// The server side of the paging (/api/holders?offset=N) is in test/holders-pages.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MINT } from "./helpers/world.js";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("token.html"), src = readFileSync(new URL("../scripts/pages/src/token.html", import.meta.url), "utf8"), css = read("style.css"), js = read("token.js");

/* ---------------- the page ---------------- */

test("token page: hero, how to get, holders (live), verify a holder, no rug pull, official tokens: in that order, deep links kept", () => {
  for (const h of [html, src]) {
    const at = (needle) => { const i = h.indexOf(needle); assert.ok(i >= 0, needle); return i; };
    const order = [at('<section class="page-hero" id="token">'), at('id="buy"'), at('id="holders"'), at('id="verify"'), at('<p class="kicker">No rug pull</p>'), at('id="check"')];
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "sections top to bottom: token, buy, holders, verify, no rug pull, check");
    const kicker = h.indexOf('<p class="kicker kicker--live"><span class="live-dot" aria-hidden="true"></span>Holders · live</p>');
    assert.ok(kicker > h.indexOf('id="holders"') && kicker < h.indexOf('id="verify"'), "the live kicker is the holders section's own");
    assert.ok(h.indexOf("Verify a holder") > h.indexOf("Holders · live") && h.indexOf("Verify a holder") < h.indexOf("No rug pull"), "verify sits between the holders and the proof");
    assert.ok(h.indexOf("Every real Vicinity token, on every network.") > h.indexOf("No rug pull"), "what followed the proof still follows it");
    for (const id of ["token", "contract", "buy", "verify", "lookup", "rank-card", "rank-show", "holders", "holders-status", "holders-find", "holders-refresh", "holders-scroll", "holders-table", "holders-body", "team-count", "check", "checker"]) assert.ok(h.includes(`id="${id}"`), id);
    assert.ok(h.includes('<span id="holders-status" role="status" aria-live="polite">'), "the status line is the live region: a screen reader hears the progress, not every 250-row chunk");
    assert.doesNotMatch(h, /<div class="holders card"[^>]*aria-live/, "the card around the table is not a live region");
  }
  // the section looks alternate as before: no two identical panels next to each other
  const classes = [...html.matchAll(/<section class="([^"]+)"|<section id="holders" class="([^"]+)"/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(classes, ["page-hero", "section section--tight", "section", "section section--glow", "section section--tight", "section section--panel"]);
  // the holder list is above the verify card now, so its button points up
  assert.match(html, /<button class="link-btn" type="button" id="rank-show">Show it in the holder list ↑<\/button>/);
  assert.doesNotMatch(html, /holder list ↓/);
});

test("token page: the holder list is a box that scrolls inside, of fixed height once the live list is in it, header pinned, status line and find box outside it", () => {
  assert.match(css, /\.table-scroll \{ max-height: clamp\(320px, 60vh, 640px\); overflow: auto;[^}]*overscroll-behavior: contain; \}/, "before launch the box is only as tall as its few placeholder rows");
  assert.match(css, /\.holders--live \.table-scroll \{ height: clamp\(320px, 60vh, 640px\); \}/, "once live, a fixed height: the page never grows with the holder count");
  assert.doesNotMatch(css, /\.is-live[^{]*\.table-scroll/, ".is-live is the proof section's green text (!important colour); the box must not borrow it");
  assert.match(css, /\.holders__table thead th \{ position: sticky; top: 0;/);
  assert.match(html, /<div class="table-scroll" id="holders-scroll" tabindex="0" aria-label="Holder list \(scrolls\)">/, "keyboard focusable, named for screen readers");
  const head = html.indexOf('<div class="holders__head">'), box = html.indexOf('id="holders-scroll"');
  assert.ok(head >= 0 && html.indexOf('id="holders-status"') > head && html.indexOf('id="holders-find"') > head && html.indexOf('id="holders-refresh"') > head, "status, find box and Refresh share the head");
  assert.ok(html.indexOf('id="holders-refresh"') < box, "the head comes before the box, so none of it scrolls away");
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

function page({ answer }) {
  const nodes = new Map(), frames = [], calls = [];
  function node(tag = "div") {
    const n = { tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, hidden: false, value: "", scrollTop: 0, _text: "", handlers: {}, classes: new Set(),
      get textContent() { return n._text; }, set textContent(t) { n._text = String(t); n.children = []; },
      append(...k) { n.children.push(...k); }, replaceChildren(...k) { n.children = k; }, scrollTo() {}, offsetTop: 0, clientHeight: 400,
      addEventListener(t, f) { (n.handlers[t] ||= []).push(f); }, fire(t) { return Promise.all((n.handlers[t] || []).map((f) => f({ preventDefault() {} }))); },
      classList: { add: (c) => n.classes.add(c), remove: (c) => n.classes.delete(c), toggle: (c, on) => (on ? n.classes.add(c) : n.classes.delete(c)), contains: (c) => n.classes.has(c) } };
    return n;
  }
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node(sel === "#holders-find" ? "input" : "div")); return nodes.get(sel); };
  const $$ = (sel) => (sel === "#holders-body tr" ? $("#holders-body").children.filter((c) => c.tagName === "TR") : []);
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.classes.add(cls); if (text != null) n.textContent = text; return n; };
  const V = { $, $$, el, toast() {}, copy() {}, fmt: (x) => Number(x).toLocaleString("en-US"), compact: (x) => String(x), mask: MASK, isAddr: () => true, official: null, reduced: true,
    api: async (path) => { calls.push(path); await null; return path === "/api/token" ? { launched: false, registry: [] } : answer(path); } };
  const statuses = []; const status = $("#holders-status"); Object.defineProperty(status, "textContent", { get: () => statuses[statuses.length - 1] || "", set: (t) => statuses.push(String(t)) });
  // the box: rows 46px tall, 400px of them in view; scrollTop clamps to the rows there are, as a browser's does, and stays clamped once rows go
  const ROW = 46, box = $("#holders-scroll"); let top = 0;
  const maxTop = () => Math.max(0, $("#holders-body").children.length * ROW - box.clientHeight);
  Object.defineProperty(box, "scrollHeight", { get: () => $("#holders-body").children.length * ROW });
  Object.defineProperty(box, "scrollTop", { get: () => (top = Math.min(top, maxTop())), set: (v) => { top = Math.min(Math.max(0, Number(v)), maxTop()); } });
  vm.runInNewContext(js, { window: { V }, document: { hidden: false }, location: { search: "" }, URLSearchParams, Intl, Date, setInterval: () => 0, setTimeout: (f) => f(), requestAnimationFrame: (f) => frames.push(f) });
  const settle = () => new Promise((r) => setImmediate(r));
  const frame = () => { const f = frames.shift(); if (f) f(); return Boolean(f); };
  const flush = () => { let n = 0; while (frame()) n++; return n; };
  const rows = () => $$("#holders-body tr"), visible = () => rows().filter((r) => !r.hidden);
  return { $, box, rows, visible, settle, frame, flush, frames, calls, statuses };
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
  assert.deepEqual(p.statuses, []);
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
