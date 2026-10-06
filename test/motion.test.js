// The site-wide motion layer (the owner: "make the whole website alive with motion and live animation"). One layer for every
// page: style.css ("Site-wide motion") and the "motion" part of public/site.js. What it promises, pinned here:
// * nothing on screen at the start is hidden, and nothing is hidden without the script: only blocks still below the screen are
//   lowered and faded (.mo-armed) and they rise in when they scroll into view; .reveal no longer hides anything by itself;
// * live numbers count up the first time they are on screen and ease to a new value when the page's script writes one, and what
//   is left when a count ends is the script's own text, word for word (the formats are the page's own: V.fmt, V.compact, the
//   token page's usd() and pctText()); anything else ("—", "Oct 10", "4d 18h", "<0.01%") is never touched;
// * with reduced motion nothing moves and nothing waits: no observer, no count, every animation and transition stopped;
// * only transform, opacity, filter and background-position move; no animation runs forever on a big layer; no inline styles,
//   scripts or handlers in the built pages (the security policy blocks them).
// How it looks and performs (CLS, long tasks, console and CSP errors, 390x844 and 1280x900, dark and light) is checked in
// Chromium on the real Worker; this file pins the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("public/style.css"), site = read("public/site.js"), token = read("public/token.js");

/* ---------------- the styles ---------------- */

const MARK = "Site-wide motion: one layer for every page";
const section = (() => {
  const a = css.indexOf(MARK), b = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  html {", a);
  assert.ok(a > 0 && b > a, "the motion section, then the global reduced-motion block");
  return { a, b, text: css.slice(a, b) };
})();
/** Character ranges of every `@media <...prefers-reduced-motion: no-preference...> { ... }` block of style.css. */
const noPreference = (() => {
  const out = [];
  for (const m of css.matchAll(/@media [^{]*prefers-reduced-motion: no-preference[^{]*\{/g)) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    out.push([m.index, i]);
  }
  return out;
})();
const inNoPreference = (i) => noPreference.some(([a, b]) => i > a && i < b);
const keyframes = (name) => { const at = css.indexOf(`@keyframes ${name} {`); assert.ok(at >= 0, name); return css.slice(at, css.indexOf("\n", at)); };

test("styles: one motion section, before the member-profiles block (which must stay still) and before the global reduced-motion block", () => {
  assert.equal(css.split(MARK).length - 1, 1, "one section");
  assert.ok(section.a < css.indexOf("Member profiles (PROFILES=on)"), "everything after the profiles block is pinned to 'nothing moves by itself'");
  assert.ok(section.a < css.indexOf("---- dashboard v2 ----"), "and the dashboard v2 block stays the last one");
  assert.doesNotMatch(section.text, /\.dv2\b|\.dtab|\.dpanel|\.fcard|\.today__|\.dpv/, "it never reaches the tabbed dashboard or the signed-out example (they have their own rules)");
});

test("styles: every animation and transition of the motion layer only exists when motion is welcome", () => {
  let n = 0;
  for (const m of section.text.matchAll(/\b(animation|transition|transition-duration|will-change)\s*:/g)) {
    n++;
    assert.ok(inNoPreference(section.a + m.index), `"${section.text.slice(Math.max(0, m.index - 80), m.index + 40).replace(/\s+/g, " ")}" sits inside @media (prefers-reduced-motion: no-preference)`);
  }
  assert.ok(n >= 10, `the section moves things (${n} declarations)`);
  // and the live dot's ping, which replaced a box-shadow pulse repainted every frame
  const ping = css.indexOf(".live-dot::after { animation: livePing");
  assert.ok(ping > 0 && inNoPreference(ping), "the live dot pings only when motion is welcome");
  assert.match(css, /\.live-dot \{ position: relative; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var\(--pin\); vertical-align: middle; \}/, "the dot itself never moves");
});

test("styles: the keyframes move only transform, opacity, filter or background-position (no layout, no repainted shadows)", () => {
  const names = [...section.text.matchAll(/@keyframes (\w+) \{/g)].map((m) => m[1]).concat("livePing");
  assert.deepEqual(names.slice(0, -1).sort(), ["moAccent", "moEnter", "moSheen", "moShine", "moState", "moTab", "moTabBar"]);
  for (const name of names) {
    const props = [...keyframes(name).matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
    assert.ok(props.length && props.every((p) => ["transform", "opacity", "filter", "background-position"].includes(p)), `${name}: ${props}`);
  }
  // the one background-position animation (the headline's colours) runs a few times and then rests where it started
  assert.match(section.text, /\.accent \{[^}]*animation: moAccent 6s ease-in-out 4 alternate; \}/);
  // nothing runs forever on a big layer: the glow behind each page's top section stays still (it cost every load ~40 ms on a test machine)
  for (const m of css.matchAll(/(?<=^|[{}])\s*([^{}@]*(?:page-hero|\.connect|\.dash-out|section:first-child|\.dash)::before[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(m[2], /animation|will-change/, `${m[1].trim()}: still`);
  }
  // nothing of the layer runs forever: the shine across a big button and the sheen along a bar pass twice, then rest (WCAG 2.2.2)
  const infinite = [...section.text.matchAll(/([^{};]+)\{[^}]*animation: (\w+)[^;}]*infinite/g)].map((m) => m[2]).sort();
  assert.deepEqual(infinite, []);
  assert.match(section.text, /animation: moShine 7s ease-in-out 2\.2s 2; \}/);
  assert.match(section.text, /animation: moSheen 3\.6s ease-in-out 1\.5s 2; \}/);
});

test("styles: no decoration loops forever; only what says something live or busy does, and it was already so before the motion layer", () => {
  // every endless animation in the whole style sheet, by keyframe name. The decorative ones the motion work added (the shines on the
  // big buttons and on Buy on Raydium, the sheen on bars, the contract card's light, the example dashboard's shine, sheen, ping and
  // float) play a few times and rest: a visitor cannot pause them, so they must stop by themselves (WCAG 2.2.2, review of 6 Oct 2026).
  const LIVE_OR_BUSY = { livePing: "the live dot", nextPing: "the timeline's next step (a box-shadow pulse before)", drift: "the home and Launchpad heroes' orbs (since before)", float: "the hero chips (since before)",
    march: "the official NYC boundary (since before)", ringOut: "the NYC map's rings (since before)", shimmer: "a loading row", spin: "a busy button",
    twinkle: "the stars behind a hero (since before)", passShine: "a member's own Vicinity Pass (since before)" };
  const endless = [...css.matchAll(/animation: (\w+)[^;}]*\binfinite\b/g)].map((m) => m[1]);
  assert.ok(endless.length >= 8);
  for (const name of endless) assert.ok(name in LIVE_OR_BUSY, `${name} loops forever`);
  assert.doesNotMatch(css, /\.dpv__[\w-]+(::after)? \{ animation: [^;}]*infinite/, "the example dashboard's motion ends");
  assert.doesNotMatch(css, /buyShine[^;}]*infinite|moShine[^;}]*infinite|moSheen[^;}]*infinite|contract\w*[^;}]*infinite/);
});

test("styles: a block is only ever hidden by the script's .mo-armed, only when motion is welcome; reduced motion and print show everything", () => {
  const armed = css.indexOf("  .mo-armed { opacity: 0; transform: translateY(18px); }");
  assert.ok(armed > 0 && inNoPreference(armed), "the armed state exists only when motion is welcome");
  assert.match(css, /\.mo-armed\.mo-in \{ opacity: 1; transform: none; transition: opacity \.45s ease-out, transform \.6s cubic-bezier\(\.2,\.8,\.2,1\); \}/);
  // .reveal (the old scroll reveal) never hides anything by itself any more: without the script every block shows
  for (const m of css.matchAll(/(?<=^|[{}])\s*([^{}@]*\.reveal\b[^{}]*)\{([^}]*)\}/g)) assert.doesNotMatch(m[2], /opacity:\s*0\b|transform/, m[1].trim());
  assert.doesNotMatch(css, /\.reveal\.is-in/);
  // the global reduced-motion block still stops every animation and transition, and shows an armed block
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  html \{ scroll-behavior: auto; \}\n  \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}\n  \.mo-armed \{ opacity: 1; transform: none; \}\n\}/);
  assert.match(css, /@media print \{ \.mo-armed \{ opacity: 1 !important; transform: none !important; \} \}/);
});

test("styles: hover lifts only under a mouse; the tab bar marks the page you are on; nothing makes the page wider", () => {
  assert.match(section.text, /@media \(hover: hover\) and \(pointer: fine\) and \(prefers-reduced-motion: no-preference\) \{\n[^@]*:hover[^@]*transform: translateY\(-4px\)/);
  assert.doesNotMatch(section.text.replace(/@media \(hover: hover\)[\s\S]*?\n\}\n/, ""), /:hover/, "no hover rule outside the mouse-only block");
  assert.match(section.text, /@media \(max-width: 900px\) \{\n  \.tabbar a \{ position: relative; \}\n  \.tabbar a\[aria-current="page"\]::before \{[^}]*top: -7px;[^}]*width: 22px;/);
  assert.match(section.text, /\.tabbar a:active svg \{ transform: scale\(\.8\);/, "a tapped tab gives a small bounce");
  // the glow sits inside its section (inset 0, behind the content), so it can never widen a phone screen
  assert.match(section.text, /main > \.section:first-child::before \{ content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;/);
  assert.match(section.text, /:root\[data-theme="light"\] \.page-hero::before, /, "a lighter glow in the light theme (selectors a browser can sort by class)");
  assert.doesNotMatch(section.text, /:is\([^)]*\)::before/, "no :is() at the right end of a selector (checked against every element on each style change)");
});

/* ---------------- the built pages ---------------- */

test("built pages: no inline style, script or event handler (blocked by the security policy); the motion needs no markup", () => {
  const pages = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 11);
  for (const f of pages) {
    const h = read("public/" + f);
    assert.doesNotMatch(h, /\sstyle=/i, `${f}: style attribute`);
    assert.doesNotMatch(h, /<style[\s>]/i, `${f}: <style>`);
    assert.doesNotMatch(h, /\son[a-z]+\s*=/i, `${f}: inline event handler`);
    for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc="\/[a-z/-]+\.js"/, `${f}: every script is a file of this site`);
      assert.equal(m[2].trim(), "", `${f}: no inline script`);
    }
    assert.doesNotMatch(h, /\bmo-(armed|in|off)\b/, `${f}: the motion classes come from site.js only`);
  }
});

/* ---------------- the numbers ---------------- */

const block = (() => {
  const a = site.indexOf("/* motion: start"), b = site.indexOf("/* motion: end */");
  assert.ok(a > 0 && b > a, "the motion part of site.js");
  return site.slice(a, b);
})();
const load = () => vm.runInNewContext(`${block}\n({ numParse, numText, motionLayer })`, { Intl });
const { numParse, numText } = load();
// the page's own formats
const fmt = vm.runInNewContext(/const fmt = (.*);\n/.exec(site)[1]);
const compact = vm.runInNewContext(/const compact = (.*);\n/.exec(site)[1]);
const usd = vm.runInNewContext(/const usd = (.*);\n/.exec(token)[1]);
const pctText = vm.runInNewContext(/const pctText = (.*);\n/.exec(token)[1]);

test("numbers: every format the pages write is read back exactly (numText(numParse(s)) === s)", () => {
  const ns = [0, 1, 7, 12, 99, 244, 999, 1000, 1234, 8008, 8029, 13176, 99999, 250000, 2_000_000, 1_000_000_000, 4_200_000_123];
  const samples = [
    ...ns.map(fmt), ...ns.map((n) => fmt(n / 7, 2)),
    ...[0.5, 0.125, 0.000123].map((n) => fmt(n)),
    ...[0, 999, 1200, 1250, 250_000, 2_000_000, 12_345_678, 1_000_000_000, 4.2e12].map(compact),
    ...[1, 1.5, 12.34, 1234.5, 0.5, 0.000420, 0.0123].map(usd), "$" + compact(420_000),
    ...[0.012, 0.64, 1.43, 9.99, 12.3, 55].map((p) => pctText(p) + "%"),
    ...[1, 3, 126, 4200].map((n) => "#" + fmt(n)), "73+", "7 days", "14 days", "1.0×",
  ];
  for (const s of samples) {
    const p = numParse(s);
    assert.ok(p, `"${s}" is understood`);
    assert.equal(numText(p, p.n), s, `"${s}" is written back as it was`);
  }
});

test("numbers: anything that is not one plain number is left alone", () => {
  for (const s of ["—", "…", "", "Oct 10", "4d 18h", "<0.01%", "Open", "Open now", "At launch", "05", "1.23e-7", "$1.23e-7", "-3.2%", "1,23", "12,3456", "of 4,200 holders", "Top 3% of all holders", "2026-10-01"]) {
    assert.equal(numParse(s), null, `"${s}" is never counted`);
  }
});

test("numbers: the steps of a count are written in the page's own style (grouping, decimals, unit, prefix, suffix)", () => {
  const p = (s) => numParse(s);
  assert.equal(numText(p("8,029"), 3383.4), "3,383");
  assert.equal(numText(p("2M"), 1.44, 1), "1.4M", "a compact value passes through tenths");
  assert.equal(numText(p("2M"), 2, 1), "2M", "and drops a trailing .0 like V.compact does");
  assert.equal(numText(p("1B"), 0.6, 1), "0.6B");
  assert.equal(numText(p("$0.000420"), 0.0001234), "$0.000123");
  assert.equal(numText(p("12.30%"), 5), "5.00%");
  assert.equal(numText(p("73+"), 12.6), "13+");
  assert.equal(numText(p("14 days"), 6.2), "6 days");
  assert.equal(numText(p("1000"), 999.6), "1000", "no grouping where the page wrote none");
});

/* ---------------- the layer on a pretend page ---------------- */

/** A small pretend page: elements with classes, attributes, a box and text; observers, frames and timers that the test drives. */
function page({ height = 800, hidden = false, reduce = false, noIO = false } = {}) {
  const mos = [], ios = [], frames = [], timers = [], listeners = {};
  const mq = { matches: reduce, listeners: [], addEventListener(t, f) { this.listeners.push(f); } }; // one query the test can flip
  const parseSel = (s) => s.trim().split(/\s*(>)\s*|\s+/).filter(Boolean).reduce((acc, t) => { if (t === ">") acc.push(">"); else acc.push(t); return acc; }, []);
  const compound = (el, c) => {
    for (const m of c.matchAll(/(^[a-z]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\(\[([\w-]+)="([^"]*)"\]\)|:first-child/g)) {
      if (m[1] && el.tag !== m[1]) return false;
      if (m[2] && !el.cls.has(m[2])) return false;
      if (m[3] && (m[4] === undefined ? !(m[3] in el.attrs) : el.attrs[m[3]] !== m[4])) return false;
      if (m[5] && el.attrs[m[5]] === m[6]) return false;
      if (m[0] === ":first-child" && !(el.parent && el.parent.kids[0] === el)) return false;
    }
    return true;
  };
  const matchOne = (el, parts) => {
    let i = parts.length - 1;
    if (!compound(el, parts[i])) return false;
    let cur = el;
    for (i--; i >= 0; i--) {
      if (parts[i] === ">") { i--; cur = cur.parent; if (!cur || !(cur instanceof El) || !compound(cur, parts[i])) return false; continue; }
      do cur = cur.parent; while (cur instanceof El && !compound(cur, parts[i]));
      if (!(cur instanceof El)) return false;
    }
    return true;
  };
  const matches = (el, sel) => sel.split(",").some((s) => matchOne(el, parseSel(s)));
  const notify = (target, added) => {
    for (const mo of mos) for (const [t, o] of mo.targets) {
      if (t === target || (o.subtree && t.contains(target))) { mo.queue.push({ target, addedNodes: added }); break; }
    }
  };
  class El {
    constructor(tag, cls = "", { attrs = {}, top = 0, h = 40, text = "" } = {}) {
      Object.assign(this, { tag, attrs, top, h, _text: text, kids: [], parent: null, nodeType: 1, style: {}, anims: [] });
      this.cls = new Set(cls.split(" ").filter(Boolean));
      this.classList = { contains: (c) => this.cls.has(c), add: (...c) => c.forEach((x) => this.cls.add(x)), remove: (...c) => c.forEach((x) => this.cls.delete(x)), toggle: (c, on) => (on ? this.cls.add(c) : this.cls.delete(c)) };
    }
    add(...kids) { for (const k of kids) { k.parent = this; this.kids.push(k); } return this; }
    append(...kids) { this.add(...kids); notify(this, kids); }
    get parentElement() { return this.parent instanceof El ? this.parent : null; }
    get parentNode() { return this.parent; }
    get childElementCount() { return this.kids.length; }
    get textContent() { return this.kids.length ? this.kids.map((k) => k.textContent).join("") : this._text; }
    set textContent(v) { this._text = String(v); this.kids = []; this.writes = (this.writes || 0) + 1; notify(this, [{ nodeType: 3 }]); }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc; }
    contains(n) { for (; n; n = n.parent) if (n === this) return true; return false; }
    matches(s) { return matches(this, s); }
    closest(s) { for (let n = this; n instanceof El; n = n.parent) if (matches(n, s)) return n; return null; }
    querySelectorAll(s) { const out = []; const walk = (n) => { for (const k of n.kids) { if (matches(k, s)) out.push(k); walk(k); } }; walk(this); return out; }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    getBoundingClientRect() { return { top: this.top, height: this.h, bottom: this.top + this.h }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    animate(k, o) { this.anims.push([k, o]); }
  }
  const doc = { kids: [], parent: null, hidden, documentElement: { clientHeight: height },
    querySelectorAll: (s) => El.prototype.querySelectorAll.call(doc, s), querySelector: (s) => El.prototype.querySelectorAll.call(doc, s)[0] || null,
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
  class IO { constructor(cb, opts = {}) { Object.assign(this, { cb, opts, els: new Set() }); ios.push(this); } observe(e) { this.els.add(e); } unobserve(e) { this.els.delete(e); }
    fire(...pairs) { this.cb(pairs.filter(([e]) => this.els.has(e)).map(([target, isIntersecting]) => ({ target, isIntersecting }))); } }
  class MO { constructor(cb) { Object.assign(this, { cb, targets: [], queue: [] }); mos.push(this); } observe(t, o) { this.targets.push([t, o]); } takeRecords() { const q = this.queue; this.queue = []; return q; }
    flush() { const q = this.takeRecords(); if (q.length) this.cb(q); } }
  const win = { innerHeight: height, MutationObserver: MO, IntersectionObserver: noIO ? undefined : IO,
    requestAnimationFrame: (f) => frames.push(f), setTimeout: (f, ms) => timers.push([f, ms]),
    matchMedia: () => mq };
  return {
    El, doc, win, mos, ios, frames, timers, listeners, mq,
    /** the microtask checkpoint after a page script wrote something: every observer gets its records */
    flush: () => mos.forEach((m) => m.flush()),
    /** runs every queued animation frame at time t (the frames they ask for wait for the next call) */
    frame: (t) => { const f = frames.splice(0); f.forEach((x) => x(t)); return f.length; },
    runFrames(from = 0, step = 16, max = 400) { let t = from, n = 0; while (frames.length && n < max) { this.frame(t); t += step; n++; } return n; },
    runTimers() { timers.splice(0).forEach(([f]) => f()); },
    io: (pred) => ios.find(pred),
  };
}
/** A page like the home page: a header, a hero with numbers on screen, blocks below the screen, the numbers strip, a hidden card. */
function homePage(opts) {
  const P = page(opts), { El, doc } = P;
  const main = new El("main");
  const hero = new El("section", "hero", { top: 0, h: 700 });
  const facts = new El("ul", "hero__facts", { top: 600 });
  const f1 = new El("strong", "", { top: 620, h: 30, text: "8,008" }), f2 = new El("strong", "", { top: 620, h: 30, text: "244" });
  const cd = new El("strong", "", { attrs: { "data-countdown-short": "" }, top: 620, h: 30, text: "Oct 10" });
  facts.add(new El("li").add(f1), new El("li").add(f2), new El("li").add(cd));
  const card0 = new El("article", "card", { top: 300, h: 200 }); // on screen: never armed
  hero.add(card0, facts);
  const numbers = new El("section", "numbers", { top: 820 });
  const row = new El("div", "numbers__row", { top: 820 });
  const n1 = new El("div", "", { top: 830, h: 60 }), s1 = new El("strong", "", { top: 840, h: 30, text: "…" });
  n1.add(s1); row.add(n1); numbers.add(row);
  const problem = new El("section", "section", { top: 1000, h: 900 });
  const head = new El("div", "section-head", { top: 1020, h: 120 });
  const cards = [0, 1, 2].map((i) => new El("article", "card problem reveal", { top: 1200 + i * 220, h: 200 }));
  const inner = new El("div", "card", { top: 1250, h: 40 }); cards[0].add(inner); // a card inside a card: only the outer one moves
  const hiddenCard = new El("article", "card", { top: 0, h: 0 }); // display: none (a [hidden] parent): no box
  const quiet = new El("div", "dpv", { top: 1900, h: 400 }).add(new El("div", "card", { top: 1950, h: 100 }));
  problem.add(head, ...cards, hiddenCard, quiet);
  main.add(hero, numbers, problem);
  doc.kids.push(main); main.parent = doc;
  return { ...P, main, hero, f1, f2, cd, card0, n1, s1, head, cards, inner, hiddenCard, quiet };
}
const start = (P) => load().motionLayer(P.win, P.doc, Boolean(P.reduce));

test("layer: with reduced motion (or no IntersectionObserver) nothing is watched, armed or counted, and every text stays as written", () => {
  for (const opts of [{ reduce: true }, { noIO: true }]) {
    const P = homePage(opts);
    const m = load().motionLayer(P.win, P.doc, Boolean(opts.reduce));
    assert.equal(m.on, false);
    assert.equal(P.ios.length + P.mos.length + P.frames.length + P.timers.length, 0, "no observer, no frame, no timer");
    assert.equal(P.doc.querySelectorAll(".mo-armed").length, 0, "nothing armed");
    assert.deepEqual([P.f1.textContent, P.f2.textContent, P.s1.textContent], ["8,008", "244", "…"]);
    m.arm(); assert.equal(P.doc.querySelectorAll(".mo-armed").length, 0, "a page's later reveal() call does nothing either");
  }
});

test("layer: only blocks below the screen are armed (never one on screen, a hidden one, one inside another block, or one with its own motion)", () => {
  const P = homePage(), m = start(P);
  assert.equal(m.on, true);
  const armed = P.doc.querySelectorAll(".mo-armed");
  assert.deepEqual(armed, [P.n1, P.head, ...P.cards], "the numbers strip's cell, the section head and the three cards");
  for (const e of [P.card0, P.inner, P.hiddenCard, P.quiet.kids[0]]) assert.ok(!e.cls.has("mo-armed"), "left alone");
  // they rise in as they come into view: a few at a time, then they are themselves again
  const rise = P.io((o) => o.opts.rootMargin);
  rise.fire([P.head, true], [P.cards[0], true], [P.cards[1], true], [P.cards[2], false]);
  assert.ok(P.head.cls.has("mo-in") && P.cards[1].cls.has("mo-in") && !P.cards[2].cls.has("mo-in"));
  assert.deepEqual([P.head.style.transitionDelay, P.cards[0].style.transitionDelay, P.cards[1].style.transitionDelay], [undefined, "60ms", "120ms"]);
  assert.ok(P.timers.every(([, ms]) => ms <= 1000), "cleaned up within a second");
  P.runTimers();
  for (const e of [P.head, P.cards[0], P.cards[1]]) { assert.ok(!e.cls.has("mo-armed") && !e.cls.has("mo-in")); assert.equal(e.style.transitionDelay, ""); }
  assert.ok(P.cards[2].cls.has("mo-armed"), "still waiting below the screen");
  // the visitor asks for less motion meanwhile: everything shows at once, every count ends on the page's text, nothing starts again
  P.f1.textContent = "9,999"; P.flush(); assert.notEqual(P.f1.textContent, "9,999", "a count was running");
  P.mq.matches = true; P.mq.listeners.forEach((f) => f());
  assert.equal(P.doc.querySelectorAll(".mo-armed").length, 0, "every armed block shows");
  assert.equal(P.f1.textContent, "9,999");
  P.f1.textContent = "10,500"; P.flush(); assert.equal(P.f1.textContent, "10,500", "a new value is simply written");
  const card = new P.El("li", "card", { top: 3000, h: 100 }); P.main.append(card); P.flush(); P.runFrames(0);
  assert.ok(!card.cls.has("mo-armed"), "and nothing new is armed");
});

test("layer: a block a page script adds below the screen rises in too (table rows never)", () => {
  const P = homePage(), m = start(P); void m;
  const card = new P.El("li", "card lp-card", { top: 2400, h: 200 }), onScreen = new P.El("li", "card lp-card", { top: 100, h: 200 });
  const table = new P.El("table"), tbody = new P.El("tbody"); table.add(tbody); P.main.add(table);
  P.main.append(card, onScreen);
  tbody.append(new P.El("tr", "card", { top: 3000, h: 30 }));
  P.flush(); assert.ok(!card.cls.has("mo-armed"), "armed on the next frame, not in the page's own task");
  P.frame(0);
  assert.ok(card.cls.has("mo-armed"), "below the screen: armed");
  assert.ok(!onScreen.cls.has("mo-armed"), "on screen: shown as it is");
  assert.ok(!tbody.kids[0].cls.has("mo-armed"), "a table row is never armed");
});

test("layer: a number on screen counts up from 0 and ends on the page's own text; one below the screen waits; a countdown is never touched", () => {
  const P = homePage(), m = start(P); void m;
  assert.deepEqual([P.f1.textContent, P.f2.textContent], ["0", "0"], "on screen at the start: the count starts before the first frame is drawn");
  assert.equal(P.cd.textContent, "Oct 10"); assert.equal(P.cd.writes, undefined, "the countdown is never written");
  assert.equal(P.s1.textContent, "…", "below the screen: as written");
  const seenText = [];
  P.frame(0); P.frame(400); seenText.push(P.f1.textContent); P.frame(800); seenText.push(P.f1.textContent);
  assert.ok(seenText.every((t) => /^\d{1,3}(,\d{3})*$/.test(t)) && seenText[0] !== "8,008", `steps in the page's style: ${seenText}`);
  const n = P.runFrames(816);
  assert.ok(n > 0 && n < 40, "then it ends");
  assert.deepEqual([P.f1.textContent, P.f2.textContent], ["8,008", "244"], "exactly what the page wrote");
  assert.equal(P.frames.length, 0, "no frame is asked for once every count has ended");
  const writes = P.f1.writes;
  P.flush();
  assert.equal(P.f1.writes, writes, "our own writes are never read back as the page's (no new count starts)");
  assert.equal(P.frames.length, 0);
});

test("layer: a live value the page writes while on screen eases from the old value to the new one, with a glow, and ends on the page's text", () => {
  const P = homePage(), m = start(P); void m;
  P.runFrames(0); // the first counts end
  // the numbers strip comes into view while its value is still "…", then the page writes the real number: it counts up from 0 (no glow)
  const seen = P.io((o) => o.opts.threshold === 0.5);
  seen.fire([P.s1, true]);
  P.s1.textContent = "1,234"; P.flush();
  assert.equal(P.s1.textContent, "0", "the page's new text never flashes before its count");
  assert.equal(P.s1.anims.length, 0, "a first number does not glow");
  P.runFrames(0);
  assert.equal(P.s1.textContent, "1,234");
  // then a new value while on screen: from 1,234 to 1,300 with a glow, ending on the page's text
  P.f1.textContent = "8,029"; P.flush();
  assert.equal(P.f1.textContent, "8,008", "it starts from the value on screen");
  assert.equal(P.f1.anims.length, 1, "a short glow");
  const [frames, opts] = P.f1.anims[0];
  for (const k of frames) for (const prop of Object.keys(k)) assert.ok(["transform", "filter", "offset"].includes(prop), prop);
  assert.ok(opts.duration <= 1200);
  P.frame(0); P.frame(450); const mid = P.f1.textContent;
  assert.ok(mid !== "8,008" && mid !== "8,029" && /^8,0[0-2]\d$/.test(mid), `between the two: ${mid}`);
  // the page writes again before the count ends: the count heads for the newest value from where it is
  P.f1.textContent = "8,100"; P.flush();
  assert.equal(P.f1.textContent, mid, "no jump");
  P.runFrames(500);
  assert.equal(P.f1.textContent, "8,100", "the page's latest text, word for word");
  // the same value written another way: no count, the page's text stays
  P.f2.textContent = "244"; P.flush();
  assert.equal(P.frames.length, 0); assert.equal(P.f2.textContent, "244");
});

test("layer: words written into a number stop its count and stay; a hidden tab finishes every count at once; a rank never counts up from #0", () => {
  const P = homePage(), m = start(P); void m;
  P.frame(0); P.frame(300);
  P.f2.textContent = "—"; P.flush();
  assert.equal(P.f2.textContent, "—", "words are never counted or replaced");
  P.runFrames(320);
  assert.equal(P.f2.textContent, "—", "and the count that ran does not come back");
  assert.equal(P.f1.textContent, "8,008");
  // a hidden tab: a running count ends at once on the page's text, and a new value is simply written
  P.f1.textContent = "9,000"; P.flush(); P.frame(2000);
  P.doc.hidden = true; P.listeners.visibilitychange.forEach((f) => f());
  assert.equal(P.f1.textContent, "9,000");
  P.f1.textContent = "9,500"; P.flush();
  assert.equal(P.f1.textContent, "9,500", "no count while the tab is hidden");
  // a rank: shown as written the first time
  const P2 = page(), main = new P2.El("main"), stat = new P2.El("div", "stat", { top: 100, h: 80 }), rank = new P2.El("strong", "", { top: 120, h: 30, text: "#126" });
  stat.add(rank); main.add(stat); P2.doc.kids.push(main); main.parent = P2.doc;
  load().motionLayer(P2.win, P2.doc, false);
  assert.equal(rank.textContent, "#126"); assert.equal(P2.frames.length, 0);
});

test("layer: compact values (the token page's supply, a member's holding) count in their unit and end on the page's text", () => {
  const P = page(), { El, doc } = P;
  const main = new El("main"), row = new El("div", "stat-row", { top: 100, h: 80 });
  const supply = new El("strong", "", { top: 110, h: 30, text: "1,000,000,000" }), hold = new El("strong", "", { top: 110, h: 30, text: "250K" });
  row.add(new El("div", "stat", { top: 100, h: 80 }).add(supply), new El("div", "stat", { top: 100, h: 80 }).add(hold));
  main.add(row); doc.kids.push(main); main.parent = doc;
  load().motionLayer(P.win, doc, false);
  P.frame(1); P.frame(500);
  // token.js swaps the long form for the short one while the count runs: the count carries on in billions, no jump back
  const before = Number(supply.textContent.replace(/,/g, ""));
  supply.textContent = "1B"; P.flush();
  assert.match(supply.textContent, /^0\.\dB$|^1B$/, `in the new unit at once: ${supply.textContent}`);
  assert.ok(Math.abs(Number(supply.textContent.replace("B", "")) * 1e9 - before) <= 0.05e9, "from where it was");
  P.runFrames(516);
  assert.equal(supply.textContent, "1B");
  // a member's holding grows: from 250K to 2M through tenths of a million, ending on the page's "2M"
  hold.textContent = "2M"; P.flush();
  const steps = [];
  P.frame(5000); for (let t = 5100; t < 5900; t += 100) { P.frame(t); steps.push(hold.textContent); }
  assert.ok(steps.every((s) => /^(0\.\d|1\.\d|2)M$|^2M$/.test(s)), `steps: ${steps}`);
  P.runFrames(6000);
  assert.equal(hold.textContent, "2M");
});

test("layer: inside a live region the region is busy while a number counts, so a screen reader reads the end value once", () => {
  const P = page(), { El, doc } = P;
  const main = new El("main"), row = new El("div", "city-stats", { attrs: { "aria-live": "polite" }, top: 100, h: 80 });
  const a = new El("div", "", { top: 100, h: 80 }), sa = new El("strong", "", { top: 110, h: 30, text: "8,029" });
  a.add(sa); row.add(a); main.add(row); doc.kids.push(main); main.parent = doc;
  load().motionLayer(P.win, doc, false);
  assert.equal(row.attrs["aria-busy"], "true");
  P.runFrames(0);
  assert.equal(sa.textContent, "8,029");
  assert.ok(!("aria-busy" in row.attrs), "not busy once the count has ended");
});

test("site.js: V.reveal still lets a page's blocks rise in after its script shows them (dashboard.js calls it), and the old reveal is gone", () => {
  assert.match(site, /const motion = motionLayer\(window, document, reduced\);/);
  assert.match(site, /const reveal = \(root\) => motion\.arm\(\.\.\.\(root \? \[root\] : \[\]\)\);/);
  assert.match(site, /window\.V = \{[^}]*\breveal, reduced,/);
  assert.doesNotMatch(site, /classList\.add\("is-in"\); io\.unobserve/, "the old reveal (which hid every .reveal until a script showed it) is gone");
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|cssText|setAttribute\(["']style/);
  assert.match(block, /takeRecords\(\)/, "its own writes are dropped before the page's are read");
  assert.match(block, /visibilitychange/, "a hidden tab finishes every count");
});

test("layer: the hero, the NYC map, the timeline and every live dot pause their loops while off screen (an unseen animation costs no frame)", () => {
  const P = homePage(), { El } = P;
  const nyc = new El("div", "nyc", { top: 2400, h: 500 }), timeline = new El("ol", "timeline", { top: 3200, h: 400 }), dot = new El("span", "live-dot", { top: 3300, h: 8 });
  P.main.add(new El("section", "section", { top: 2300, h: 700 }).add(nyc), new El("section", "section", { top: 3100, h: 600 }).add(timeline, dot));
  start(P);
  const away = P.io((o) => !o.opts.rootMargin && !o.opts.threshold);
  assert.ok(away, "one observer for the loops");
  for (const e of [P.hero, nyc, timeline, dot]) assert.ok(away.els.has(e), e.cls.values().next().value);
  away.fire([nyc, false], [timeline, false], [dot, false], [P.hero, true]);
  assert.ok(nyc.cls.has("mo-off") && timeline.cls.has("mo-off") && dot.cls.has("mo-off") && !P.hero.cls.has("mo-off"));
  away.fire([timeline, true]);
  assert.ok(!timeline.cls.has("mo-off"), "running again once it is back on screen");
  // what .mo-off pauses: the map's rings and boundary, the timeline's next-step ping, the dot's ping, the contract card's light
  for (const sel of [".mo-off .m-pulse", ".mo-off .m-official", ".mo-off .timeline__item::after", ".live-dot.mo-off::after", ".mo-off .contract::after"]) {
    const at = css.indexOf(sel); assert.ok(at > 0 && inNoPreference(at), sel);
  }
  assert.match(css, /\.live-dot\.mo-off::after \{ animation-play-state: paused; \}/);
});

test("styles: the timeline's next step pings with transform and opacity (no box-shadow pulse repainted every frame), still with reduced motion", () => {
  assert.doesNotMatch(css, /livePulse/, "the box-shadow pulse is gone");
  assert.match(css, /\.timeline__item\.is-next::before \{ background: var\(--pin\); border-color: var\(--pin\); \}/, "the dot itself is still");
  const ping = css.indexOf(".timeline__item.is-next::after { animation: nextPing");
  assert.ok(ping > 0 && inNoPreference(ping), "the ping exists only when motion is welcome");
  const props = [...keyframes("nextPing").matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
  assert.ok(props.length && props.every((p) => p === "transform" || p === "opacity"), `nextPing: ${props}`);
  assert.match(css, /\.timeline__item\.is-next::after \{ content: ""; position: absolute; left: -34px; top: 4px; width: 16px; height: 16px; border-radius: 50%; background: var\(--pin\); opacity: 0; pointer-events: none; \}/, "over the dot, unseen at rest");
});
