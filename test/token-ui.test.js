// The token page: the order of its sections, the holder list as a box of fixed height that scrolls on its own, and
// public/token.js's holder table run in node (no browser): every holder is fetched page by page and drawn 250 rows
// per animation frame, the find box covers every row, a Refresh during a load wins. The server side of the paging
// (/api/holders?offset=N) is in test/holders-pages.test.js.
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
  }
  // the section looks alternate as before: no two identical panels next to each other
  const classes = [...html.matchAll(/<section class="([^"]+)"|<section id="holders" class="([^"]+)"/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(classes, ["page-hero", "section section--tight", "section", "section section--glow", "section section--tight", "section section--panel"]);
  // the holder list is above the verify card now, so its button points up
  assert.match(html, /<button class="link-btn" type="button" id="rank-show">Show it in the holder list ↑<\/button>/);
  assert.doesNotMatch(html, /holder list ↓/);
});

test("token page: the holder list is a box of fixed height that scrolls inside, header pinned, status line and find box outside it", () => {
  assert.match(css, /\.table-scroll \{ height: clamp\(320px, 60vh, 640px\); overflow: auto;[^}]*overscroll-behavior: contain; \}/);
  assert.doesNotMatch(css, /\.table-scroll \{ max-height/, "a max-height would let the page grow with the holder count");
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
/** The server's pages of 1,000 (the shape of src/index.js holdersResponse). */
const pageOf = (all, offset) => ({ launched: true, mint: MINT, supply: 1e9, total: all.filter((h) => h.rank).length, count: all.length, full: true, holders: all.slice(offset, offset + 1000), more: offset + 1000 < all.length, updatedAt: "2026-10-03T12:00:00Z" });

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
  vm.runInNewContext(js, { window: { V }, document: { hidden: false }, location: { search: "" }, URLSearchParams, Intl, Date, setInterval: () => 0, setTimeout: (f) => f(), requestAnimationFrame: (f) => frames.push(f) });
  const settle = () => new Promise((r) => setImmediate(r));
  const frame = () => { const f = frames.shift(); if (f) f(); return Boolean(f); };
  const flush = () => { let n = 0; while (frame()) n++; return n; };
  const rows = () => $$("#holders-body tr"), visible = () => rows().filter((r) => !r.hidden);
  return { $, rows, visible, settle, frame, flush, frames, calls, statuses };
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
