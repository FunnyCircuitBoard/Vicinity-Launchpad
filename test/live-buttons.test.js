// Dark by default, and nothing that loops (design v4, 12 Oct 2026: the owner asked for the "Pause animations" button to go; WCAG 2.2.2
// then requires that nothing moving by itself lasts more than 5 s, so the live buttons of 6 Oct 2026 are gone). What is pinned here:
// * theme.js: a first visit is dark whatever the device says (no prefers-color-scheme at all), from the first paint (meta theme-color
//   and color-scheme follow the theme); a theme toggle switches to light and remembers it; a stored choice always wins; every toggle on
//   the page (the header's, the phone footer's) stays in step;
// * no Pause control anywhere: theme.js forgets the old stored choice once and never sets data-motion; no page has the button;
// * style.css, polish.css and feedback.css: no animation runs forever, except busy indicators that end with the busy state (.is-busy,
//   .is-loading, [aria-busy], a loading row) and the gradient ring while a mouse hovers it (the visitor started it); every animation
//   that starts by itself ends within 5 s;
// * site.js: the segmented controls' marker (measured, glides with transform, at once with reduced motion; the button keeps its own
//   look until the marker has measured it).
// How it looks and costs (320 to 1920 px, dark and light, document.getAnimations() after 6 s idle) is checked in Chromium on the real Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("public/style.css"), theme = read("public/theme.js"), site = read("public/site.js"), build = read("scripts/pages/build.mjs");
const SHEETS = { "style.css": css, "polish.css": read("public/polish.css"), "feedback.css": read("public/feedback.css") };

/* ---------------- theme.js on a pretend page ---------------- */

function themePage({ stored = {}, throws = false, deviceLight = true } = {}) {
  const store = new Map(Object.entries(stored)), queries = [], events = [], listeners = {};
  const localStorage = {
    getItem: (k) => { if (throws) throw new Error("blocked"); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error("blocked"); store.set(k, String(v)); },
    removeItem: (k) => { if (throws) throw new Error("blocked"); store.delete(k); },
  };
  const matchMedia = (q) => { queries.push(q); return { matches: deviceLight && /light/.test(q), addEventListener: () => queries.push(`listener ${q}`) }; };
  const metas = { 'meta[name="theme-color"]': { content: "#070E19" }, 'meta[name="color-scheme"]': { content: "dark" } };
  const button = () => ({ attrs: {}, handlers: [], setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.handlers.push(f); }, click() { this.handlers.forEach((f) => f()); } });
  const toggle = button(), footer = button();
  let parsed = false; // the buttons exist once the body is parsed (DOMContentLoaded)
  const root = { dataset: {} };
  const document = {
    documentElement: root,
    querySelector: (s) => metas[s] || null,
    querySelectorAll: (s) => (!parsed ? [] : s === "[data-theme-toggle]" ? [toggle, footer] : []),
    addEventListener: (t, f) => (listeners[t] ||= []).push(f),
  };
  class CustomEvent { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
  const window = { dispatchEvent: (e) => events.push([e.type, e.detail]), addEventListener() {} }; // (the dashboard's hold and its way out: test/layout-shift.test.js)
  vm.runInNewContext(theme, { document, window, localStorage, matchMedia, CustomEvent, setTimeout: () => 0 });
  const ready = () => { parsed = true; (listeners.DOMContentLoaded || []).forEach((f) => f()); };
  return { root, metas, store, queries, events, toggle, footer, ready };
}

test("theme.js: a first visit is dark whatever the device says, from the first paint", () => {
  for (const deviceLight of [true, false]) {
    const P = themePage({ deviceLight });
    assert.equal(P.root.dataset.theme, "dark");
    assert.equal(P.metas['meta[name="theme-color"]'].content, "#070E19");
    assert.equal(P.metas['meta[name="color-scheme"]'].content, "dark", "the browser's own canvas and controls are dark too");
    assert.deepEqual(P.queries, [], "the device setting is never even asked (and never listened to)");
  }
  assert.doesNotMatch(theme, /prefers-color-scheme|matchMedia/, "nothing follows the device setting any more");
  assert.doesNotMatch(css + build + read("README.md"), /follows the device setting|or the system setting/i, "and no comment or doc says it does");
});

test("theme.js: a stored choice always wins; anything else, or no storage at all, is dark", () => {
  const light = themePage({ stored: { "vicinity-theme": "light" } });
  assert.equal(light.root.dataset.theme, "light");
  assert.equal(light.metas['meta[name="theme-color"]'].content, "#F5F7FB");
  assert.equal(light.metas['meta[name="color-scheme"]'].content, "light");
  assert.equal(themePage({ stored: { "vicinity-theme": "dark" }, deviceLight: true }).root.dataset.theme, "dark");
  assert.equal(themePage({ stored: { "vicinity-theme": "sepia" } }).root.dataset.theme, "dark");
  assert.equal(themePage({ throws: true }).root.dataset.theme, "dark", "a private window that blocks storage: dark, no error");
});

test("theme.js: a toggle switches to light and remembers it, then back to dark; the header's and the footer's toggles stay in step", () => {
  const P = themePage();
  P.ready();
  for (const b of [P.toggle, P.footer]) assert.deepEqual(b.attrs, { "aria-pressed": "false", "aria-label": "Switch to light mode" });
  P.toggle.click();
  assert.equal(P.root.dataset.theme, "light");
  assert.equal(P.store.get("vicinity-theme"), "light");
  for (const b of [P.toggle, P.footer]) assert.deepEqual(b.attrs, { "aria-pressed": "true", "aria-label": "Switch to dark mode" });
  assert.deepEqual(P.events.at(-1), ["vicinity:theme", "light"], "the map and other canvases repaint in the new colours");
  P.footer.click();
  assert.equal(P.root.dataset.theme, "dark");
  assert.equal(P.store.get("vicinity-theme"), "dark");
  assert.deepEqual(P.toggle.attrs, { "aria-pressed": "false", "aria-label": "Switch to light mode" });
});

test("theme.js: the retired 'Pause animations' choice is forgotten once and never applied; no page has the button", () => {
  const P = themePage({ stored: { "vicinity-motion": "paused" } });
  assert.equal(P.root.dataset.motion, undefined, "a stored Pause no longer stops anything (nothing loops)");
  assert.equal(P.store.has("vicinity-motion"), false, "and the old key is cleared");
  assert.doesNotMatch(theme, /dataset\.motion|data-motion-toggle|vicinity:motion/);
  assert.doesNotMatch(build, /motion-toggle|Pause animations/);
  assert.doesNotMatch(site, /vicinity:motion/);
  for (const [name, sheet] of Object.entries(SHEETS)) assert.doesNotMatch(sheet, /data-motion|\.motion-toggle|\.footer-motion/, name);
});

test("built pages: dark meta from the first byte, and no 'Pause animations' button in the layout", () => {
  const pages = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 14);
  for (const f of pages) {
    const h = read("public/" + f);
    assert.match(h, /<meta name="theme-color" content="#070E19">\n  <meta name="color-scheme" content="dark">/, f);
    const chrome = h.slice(0, h.indexOf('<main id="main"')) + h.slice(h.indexOf("</main>"));
    assert.doesNotMatch(chrome, /data-motion-toggle|Pause animations|Play animations/, `${f}: header, footer and tab bar have no Pause control`);
  }
});

/* ---------------- nothing loops (style.css, polish.css, feedback.css) ---------------- */

/** Every rule of a sheet: { sel, body, media } (media blocks opened, their inner rules listed with the media query that holds them). */
function rulesOf(text) {
  const out = [], t = text.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  const walk = (from, to, media) => {
    let i = from;
    while (i < to) {
      const open = t.indexOf("{", i); if (open < 0 || open >= to) break;
      const sel = t.slice(i, open).trim();
      let depth = 1, j = open + 1;
      for (; j < to && depth; j++) depth += t[j] === "{" ? 1 : t[j] === "}" ? -1 : 0;
      if (sel.startsWith("@media") || sel.startsWith("@supports")) walk(open + 1, j - 1, [...media, sel]);
      else if (!sel.startsWith("@keyframes") && !sel.startsWith("@property") && !sel.startsWith("@font-face")) out.push({ sel, body: t.slice(open + 1, j - 1), media });
      i = j;
    }
  };
  walk(0, t.length, []);
  return out;
}
const BUSY = /\.is-busy|\.is-loading|\[aria-busy|\.skeleton/;

test("nothing loops: every endless animation is a busy indicator that ends with the busy state, or the ring a mouse is hovering", () => {
  let busy = 0;
  for (const [name, sheet] of Object.entries(SHEETS)) {
    for (const r of rulesOf(sheet)) {
      for (const m of r.body.matchAll(/animation\s*:\s*([^;]+)/g)) {
        if (!/\binfinite\b/.test(m[1])) continue;
        const sels = r.sel.split(",").map((x) => x.trim());
        const hovered = sels.every((x) => /:hover::after$/.test(x)) && /^ringSpin /.test(m[1]) && r.media.some((q) => /hover: hover\) and \(pointer: fine\)/.test(q));
        if (hovered) continue; // the gradient ring turns only while a mouse is on it (the visitor started it)
        for (const x of sels) assert.match(x, BUSY, `${name}: ${x} { animation: ${m[1]} } loops forever`);
        busy++;
      }
    }
  }
  assert.ok(busy >= 4, "the spinners and loading shimmers are still there");
  assert.doesNotMatch(css, /@keyframes (lbGlow|lbSweep|lbBusy|lbEdgeTop|lbEdgeBottom|lbBreath|lbTab|lbRing) /, "the live buttons' keyframes are gone");
  assert.doesNotMatch(css, /--lb-(play|glow|edge|ring|tab)|--sweep-delay|--rim-in/, "and their variables");
  assert.doesNotMatch(site, /const LIVE = |const SHINES = |--sweep-delay|mo-hidden/, "site.js no longer watches buttons on and off screen");
});

test("nothing loops: what starts by itself ends within 5 s (WCAG 2.2.2 without a Pause control)", () => {
  // duration x iterations, delay excluded: a live dot pings 3 x 1.6 s, the contract card's hairline light and the pass's gloss run once
  const sec = (v) => (/ms$/.test(v) ? Number(v.slice(0, -2)) / 1000 : Number(v.slice(0, -1)));
  let n = 0;
  for (const [name, sheet] of Object.entries(SHEETS)) {
    for (const r of rulesOf(sheet)) {
      if (r.media.some((q) => /hover: hover/.test(q)) || /:hover|:active|\.is-busy|\.is-loading|\[aria-busy|\.skeleton/.test(r.sel)) continue;
      for (const m of r.body.matchAll(/animation\s*:\s*([^;]+)/g)) {
        for (const one of m[1].split(/,(?![^(]*\))/)) {
          const parts = one.trim().split(/\s+(?![^(]*\))/);
          if (parts[0] === "none" || parts.includes("infinite")) continue;
          const times = parts.filter((x) => /^\d*\.?\d+m?s$/.test(x)), iters = parts.find((x) => /^\d+$/.test(x));
          if (!times.length) continue;
          const total = sec(times[0]) * (iters ? Number(iters) : 1);
          assert.ok(total <= 5, `${name}: ${r.sel} runs ${total.toFixed(2)} s (${one.trim()})`);
          n++;
        }
      }
    }
  }
  assert.ok(n >= 10, `checked ${n} animations`);
  assert.match(css, /\.live-dot::after \{ animation: livePing 1\.6s cubic-bezier\(0,0,\.2,1\) 3; \}/, "the live dot pings three times and rests");
  assert.match(css, /\.contract::after \{ animation: contractSweep 2\.4s ease-in-out 1\.2s 1; \}/);
  assert.match(css, /\.pass__shine \{ animation: passShine 2\.4s ease-in-out \.4s 1; \}/);
  assert.match(css, /\.citymap #city-fx\.is-resting \{ animation: fxRest 3\.6s steps\(18\) 1; \}/);
});

test("the gradient ring: hover only, under a mouse only, with motion welcome; never at rest except the one hero action's still 35 % ring", () => {
  assert.match(css, /@property --ring-a \{ syntax: "<angle>"; inherits: false; initial-value: 0deg; \}/);
  assert.match(css, /\.has-ring::after \{ content: ""; position: absolute; inset: -1px; border-radius: inherit; padding: 1px; pointer-events: none; background: var\(--grad-ring\);[^}]*opacity: 0; \}/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) and \(prefers-reduced-motion: no-preference\) \{\n  \.has-ring::after \{ transition: opacity var\(--dur-2\) var\(--ease-out\); \}\n  \.has-ring:hover::after \{ animation: ringSpin 2\.4s linear infinite; \}/);
  assert.match(css, /\.btn--cta-glow\.has-ring::after \{ opacity: \.35; \}/, "the one hero action shows it still");
  assert.match(css, /only under a mouse, never at rest and never on a card but the featured \$VICINITY/, "the exception is written down where it lives");
  assert.match(build, /<a class="btn btn--primary btn--sm hdr-signup has-ring" href="\/connect" data-signup>Sign up<\/a>/, "the header's Sign up has it");
});

/* ---------------- site.js: the segmented controls' marker ---------------- */

const segmentsSrc = (() => {
  const a = site.indexOf("  function segments(win, doc) {"), b = site.indexOf("\n  segments(window, document);", a);
  assert.ok(a > 0 && b > a, "segments() and its call");
  return site.slice(a, b);
})();

function segPage({ reduced = false, laidOut = true } = {}) {
  const ros = [], mos = [];
  const mkEl = (tag, cls = "", attrs = {}) => ({ tag, cls: new Set(cls.split(" ").filter(Boolean)), attrs: { ...attrs }, kids: [], style: {}, anims: [],
    classList: { add(...c) { c.forEach((x) => this.owner.cls.add(x)); }, remove(...c) { c.forEach((x) => this.owner.cls.delete(x)); } },
    setAttribute(k, v) { this.attrs[k] = String(v); mos.forEach((m) => m.target === this.parent && m.cb()); },
    getAttribute(k) { return this.attrs[k]; },
    append(...k) { for (const x of k) { x.parent = this; this.kids.push(x); } },
    animate(k, o) { this.anims.push([k, o]); },
    querySelector(s) { return this.querySelectorAll(s)[0] || null; },
    querySelectorAll(s) {
      if (s === "button") return this.kids.filter((k) => k.tag === "button");
      return this.kids.filter((k) => k.tag === "button" && (k.attrs["aria-selected"] === "true" || k.attrs["aria-pressed"] === "true"));
    } });
  const fix = (e) => { e.classList.owner = e; return e; };
  const seg = fix(mkEl("div", "seg"));
  const buttons = [0, 1, 2].map((i) => { const b = fix(mkEl("button", "", { "aria-selected": String(i === 0) })); Object.assign(b, { offsetLeft: 3 + i * 80, offsetTop: 3, offsetWidth: laidOut ? 78 + i * 4 : 0, offsetHeight: 36 }); return b; });
  seg.append(...buttons);
  const doc = { querySelectorAll: (s) => (s === ".seg" ? [seg] : []) };
  class RO { constructor(cb) { this.cb = cb; this.els = []; ros.push(this); } observe(e) { this.els.push(e); } }
  class MO { constructor(cb) { this.cb = cb; mos.push(this); } observe(t, o) { this.target = t; this.opts = o; } }
  const el = (tag, cls) => fix(mkEl(tag, cls));
  const segments = vm.runInNewContext(`(${segmentsSrc.trim().replace(/^function segments/, "function")})`, { el, reducedNow: () => reduced });
  segments({ ResizeObserver: RO, MutationObserver: MO }, doc);
  return { seg, buttons, ros, mos, ind: seg.kids.at(-1), resize: () => ros.forEach((r) => r.cb()) };
}

test("segments: one marker, hidden from screen readers, measured under the chosen button; it glides to a new choice with transform", () => {
  const P = segPage();
  assert.equal(P.ind.cls.has("seg__ind"), true);
  assert.equal(P.ind.attrs["aria-hidden"], "true", "not a tab, never read out");
  assert.equal(P.seg.cls.has("has-ind"), false, "until it has measured, the chosen button keeps its own look");
  P.resize(); // a ResizeObserver answers once at the start
  assert.equal(P.seg.cls.has("has-ind"), true);
  assert.deepEqual([P.ind.style.width, P.ind.style.height, P.ind.style.transform], ["78px", "36px", "translate(3px, 3px)"]);
  assert.equal(P.ind.anims.length, 0, "the first placement does not move");
  assert.equal(JSON.stringify(P.mos[0].opts), JSON.stringify({ subtree: true, attributes: true, attributeFilter: ["aria-selected", "aria-pressed"] }));
  P.buttons[0].setAttribute("aria-selected", "false"); P.buttons[2].setAttribute("aria-selected", "true");
  assert.equal(P.ind.style.transform, "translate(163px, 3px)");
  assert.equal(P.ind.style.width, "86px");
  const [frames, opts] = P.ind.anims.at(-1);
  assert.equal(JSON.stringify(frames), JSON.stringify([{ transform: `translate(3px, 3px) scaleX(${78 / 86})` }, { transform: "translate(163px, 3px)" }]), "transform only (FLIP from the old place and width)");
  assert.equal(JSON.stringify(opts), JSON.stringify({ duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" }));
  assert.ok(P.ros[0].els.includes(P.seg) && P.buttons.every((b) => P.ros[0].els.includes(b)), "a font that loads late, or a panel that opens, measures again");
});

test("segments: at once with reduced motion; a control in a hidden panel keeps the button's own look until it has a size", () => {
  const R = segPage({ reduced: true }); R.resize();
  R.buttons[0].setAttribute("aria-selected", "false"); R.buttons[1].setAttribute("aria-selected", "true");
  assert.equal(R.ind.style.transform, "translate(83px, 3px)");
  assert.equal(R.ind.anims.length, 0, "no glide");
  const H = segPage({ laidOut: false }); H.resize();
  assert.equal(H.seg.cls.has("has-ind"), false, "nothing measured, nothing hidden");
  assert.match(css, /\.seg:not\(\.has-ind\) \.seg__ind \{ display: none; \}/);
  assert.match(css, /\.seg\.has-ind button\[aria-selected="true"\], \.seg\.has-ind button\[aria-pressed="true"\] \{ background: none; box-shadow: none; \}/, "the marker takes over the chosen look only once it is there");
  assert.match(segmentsSrc, /if \(!RO \|\| !MO\) return;/, "an old browser keeps the buttons' own look");
});

