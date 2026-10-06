// Dark by default, and live buttons (the owner, 6 Oct 2026: "the website is going to load as dark theme by default" and "each button
// should have live animation"). What is pinned here:
// * theme.js: a first visit is dark whatever the device says (no prefers-color-scheme at all), from the first paint (meta theme-color
//   and color-scheme follow the theme); the header toggle switches to light and remembers it; a stored choice always wins;
// * "Pause animations" (footer, every page): stops every loop of the site, remembered on this device (WCAG 2.2.2: a visitor can stop
//   anything that moves by itself), and site.js treats it like a reduced-motion setting;
// * style.css "Live buttons": only transform and opacity move, every loop exists only when motion is welcome, pauses off screen and in
//   a hidden tab (--lb-play), steps a few times a second instead of 60, never sits under a main button's words, and changes no size;
// * site.js: the segmented controls' marker (measured, glides with transform, at once with reduced motion; the button keeps its own
//   look until the marker has measured it).
// How it looks and costs (390x844, 320x640, 1280x900, dark and light; idle main-thread work; frames drawn) is checked in Chromium on
// the real Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("public/style.css"), theme = read("public/theme.js"), site = read("public/site.js"), build = read("scripts/pages/build.mjs");

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
  const button = (text = "") => ({ attrs: {}, textContent: text, handlers: [], setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.handlers.push(f); }, click() { this.handlers.forEach((f) => f()); } });
  const toggle = button(), pause = button("Pause animations");
  let parsed = false; // the buttons exist once the body is parsed (DOMContentLoaded)
  const root = { dataset: {} };
  const document = {
    documentElement: root,
    querySelector: (s) => metas[s] || null,
    querySelectorAll: (s) => (!parsed ? [] : s === "[data-theme-toggle]" ? [toggle] : s === "[data-motion-toggle]" ? [pause] : []),
    addEventListener: (t, f) => (listeners[t] ||= []).push(f),
  };
  class CustomEvent { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
  const window = { dispatchEvent: (e) => events.push([e.type, e.detail]) };
  vm.runInNewContext(theme, { document, window, localStorage, matchMedia, CustomEvent });
  const ready = () => { parsed = true; (listeners.DOMContentLoaded || []).forEach((f) => f()); };
  return { root, metas, store, queries, events, toggle, pause, ready };
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

test("theme.js: the header toggle switches to light and remembers it, then back to dark", () => {
  const P = themePage();
  P.ready();
  assert.deepEqual(P.toggle.attrs, { "aria-pressed": "false", "aria-label": "Switch to light mode" });
  P.toggle.click();
  assert.equal(P.root.dataset.theme, "light");
  assert.equal(P.store.get("vicinity-theme"), "light");
  assert.deepEqual(P.toggle.attrs, { "aria-pressed": "true", "aria-label": "Switch to dark mode" });
  assert.deepEqual(P.events.at(-1), ["vicinity:theme", "light"], "the map and other canvases repaint in the new colours");
  P.toggle.click();
  assert.equal(P.root.dataset.theme, "dark");
  assert.equal(P.store.get("vicinity-theme"), "dark");
});

test("theme.js: 'Pause animations' is applied before the first paint, remembered, and said on the button", () => {
  const P = themePage({ stored: { "vicinity-motion": "paused" } });
  assert.equal(P.root.dataset.motion, "paused", "a paused page never starts moving");
  P.ready();
  assert.equal(P.pause.textContent, "Play animations");
  P.pause.click();
  assert.equal(P.root.dataset.motion, undefined);
  assert.equal(P.store.has("vicinity-motion"), false);
  assert.equal(P.pause.textContent, "Pause animations");
  assert.deepEqual(P.events.at(-1), ["vicinity:motion", "on"]);
  P.pause.click();
  assert.equal(P.root.dataset.motion, "paused");
  assert.equal(P.store.get("vicinity-motion"), "paused");
  assert.deepEqual(P.events.at(-1), ["vicinity:motion", "paused"], "site.js stops its counts and rise-ins at once");
  assert.equal(themePage().root.dataset.motion, undefined, "moving by default");
});

test("built pages: dark meta from the first byte, and the 'Pause animations' button in every footer", () => {
  const pages = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 12);
  for (const f of pages) {
    const h = read("public/" + f);
    assert.match(h, /<meta name="theme-color" content="#070E19">\n  <meta name="color-scheme" content="dark">/, f);
    assert.match(h, /<p class="muted small footer-motion"><button class="link-btn motion-toggle" type="button" data-motion-toggle>Pause animations<\/button><\/p>/, f);
  }
  assert.match(css, /\.motion-toggle \{ min-height: 44px;/, "a 44 px touch target");
});

/* ---------------- style.css "Live buttons" ---------------- */

const MARK = "Live buttons (the owner, 6 Oct 2026";
const section = (() => {
  const a = css.indexOf(MARK), b = css.indexOf("/* ---------- fair launch", a);
  assert.ok(a > 0 && b > a, "the section");
  assert.ok(a > css.indexOf("@media (prefers-reduced-motion: reduce) {\n  html {"), "after the site-wide motion layer and its reduced-motion block");
  assert.ok(b < css.indexOf("Member profiles (PROFILES=on)"), "before the blocks that must not move by themselves");
  return css.slice(a, b);
})();
const sectionAt = css.indexOf(MARK);
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
const LB = ["lbGlow", "lbSweep", "lbBusy", "lbEdgeTop", "lbEdgeBottom", "lbBreath", "lbTab"];
/** Every rule of the section: { sel, body, at } (media blocks opened, their inner rules listed). */
const rules = (() => {
  const out = [], text = section.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  const walk = (from, to) => {
    let i = from;
    while (i < to) {
      const open = text.indexOf("{", i); if (open < 0 || open >= to) break;
      const sel = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      for (; j < to && depth; j++) depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
      if (sel.startsWith("@media")) walk(open + 1, j - 1);
      else if (!sel.startsWith("@keyframes")) out.push({ sel, body: text.slice(open + 1, j - 1), at: sectionAt + open });
      i = j;
    }
  };
  walk(0, text.length);
  return out;
})();

test("live buttons: only transform and opacity move, and the slow loops step a few times a second instead of 60", () => {
  const names = [...section.matchAll(/@keyframes (\w+) \{/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), [...LB].sort());
  for (const name of LB) {
    const line = section.slice(section.indexOf(`@keyframes ${name} {`)).split("\n")[0];
    const props = [...line.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
    assert.ok(props.length && props.every((p) => p === "transform" || p === "opacity"), `${name}: ${props}`);
  }
  assert.match(section, /animation: lbGlow 3\.6s steps\(18\) infinite alternate/);
  assert.match(section, /animation: lbBreath 4s steps\(16\) infinite alternate/);
  assert.match(section, /animation: lbTab 4s steps\(16\) infinite alternate/);
  // the moving lights travel only during a short part of their cycle, then rest unseen (nothing to redraw)
  assert.match(section, /@keyframes lbSweep \{ 0% \{ transform: translateX\(0\); opacity: 0; \} 3%, 15% \{ opacity: 1; \} 18%, 100% \{ transform: translateX\(127%\); opacity: 0; \} \}/);
  assert.match(section, /@keyframes lbEdgeBottom \{ 0%, 15% \{[^}]*\} 17%, 28% \{ opacity: 1; \} 30%, 100% \{ transform: translateX\(0\); opacity: 0; \} \}/);
});

test("live buttons: every loop exists only when motion is welcome, pauses off screen and in a hidden tab, and stops on Pause", () => {
  const anims = rules.filter((r) => /\banimation\s*:/.test(r.body) && !/animation: none/.test(r.body)); // (the Pause rule stops them)
  assert.ok(anims.length >= 7);
  for (const r of anims) {
    assert.ok(inNoPreference(r.at), `${r.sel}: inside @media (prefers-reduced-motion: no-preference)`);
    const m = /animation: (\w+) ([^;]*);/.exec(r.body);
    assert.ok(LB.includes(m[1]), `${r.sel}: ${m[1]}`);
    assert.match(m[2], /var\(--lb-play, running\)$/, `${r.sel}: pauses through --lb-play`);
  }
  for (const r of rules.filter((x) => /\btransition(-[a-z]+)?\s*:/.test(x.body))) assert.ok(inNoPreference(r.at), `${r.sel}: its transition only when motion is welcome`);
  assert.match(section, /\n:root\.mo-hidden, \.mo-off \{ --lb-play: paused; \}/, "off screen (site.js .mo-off) or a hidden tab (.mo-hidden on <html>)");
  assert.match(section, /\n:root\[data-motion="paused"\] \*, :root\[data-motion="paused"\] \*::before, :root\[data-motion="paused"\] \*::after \{ animation: none !important; \}/);
  assert.match(section, /\n:root\[data-motion="paused"\] \.mo-armed \{ opacity: 1; transform: none; \}/, "nothing waits hidden");
  assert.match(section, /\n:root\[data-motion="paused"\] \{ scroll-behavior: auto; \}/);
  // with reduced motion or Pause the main buttons keep a still glow (the rest state lives outside every media block)
  const glow = rules.find((r) => r.sel.startsWith(".btn--primary:not(.is-in)::before"));
  assert.ok(glow && !inNoPreference(glow.at));
  assert.match(glow.body, /box-shadow: 0 0 24px 2px var\(--lb-glow\); opacity: \.5;/);
  // the site-wide reduced-motion rule still stops all of it
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  html \{ scroll-behavior: auto; \}\n  \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
});

test("live buttons: the main buttons' light stays above their words (white on orange keeps 4.5:1), and nothing clips their glow", () => {
  // the light: 1 px border + top 1 px + 7 px = 9 px from the button's top edge at most. The words start lower on every main button:
  // measured in Chromium on 84 buttons (320, 390 and 1280 px): 3.0 px of room at the closest (a 40 px "Log in"), 13+ px on most
  const light = rules.find((r) => r.sel.startsWith(".btn--primary:not(.is-in)::after"));
  assert.match(light.body, /top: 1px; left: var\(--rim-in, 24px\); z-index: -1;/);
  assert.match(light.body, /width: calc\(\(100% - 2 \* var\(--rim-in, 24px\)\) \* \.44\); height: 7px;/);
  assert.match(light.body, /background: radial-gradient\(closest-side, rgba\(255,255,255,\.72\), rgba\(255,255,255,0\)\);/, "an ellipse that fades out before its box ends");
  // it starts after the rounded end and stops before the other one (127% of 44% of the straight part = the rest of it)
  assert.ok(Math.abs(0.44 * 2.27 - 1) < 0.002, "translateX(127%) ends the light at the straight part's right end");
  assert.match(section, /\.btn--sm \{ --rim-in: 20px; \} \.btn--lg \{ --rim-in: 28px; \} \.contract__buy, \.map-open \{ --rim-in: 16px; \}/, "each size's rounded end");
  assert.doesNotMatch(css.slice(css.indexOf(".contract__buy {"), css.indexOf("}", css.indexOf(".contract__buy {"))), /overflow: hidden/);
  assert.doesNotMatch(css, /\.btn--primary\.btn--lg \{[^}]*overflow: hidden/);
  // "Open the live map" (home) is a main button now, with the main buttons' darker orange: white on #FF5A36 read 3.0:1
  assert.match(css, /\.map-open \{[^}]*color: #fff; background: linear-gradient\(135deg, var\(--cta-a\), var\(--cta-b\)\);/);
});

test("live buttons: no size or place changes; the buttons themselves only get positioning, a press and their colours", () => {
  const SAFE = new Set(["position", "isolation", "transition-property", "transition-duration", "transition", "scale", "--rim-in", "background", "box-shadow", "text-decoration-thickness", "text-underline-offset"]);
  for (const r of rules) {
    if (/::(before|after)|^:root|\.seg__ind|\.footer-motion|\.motion-toggle/.test(r.sel)) continue; // pseudo layers, tokens, and the new footer button
    if (r.sel === ".seg") continue; // the marker's frame: position + isolation only
    for (const p of r.body.matchAll(/(^|;)\s*([a-z-]+)\s*:/g)) assert.ok(SAFE.has(p[2]), `${r.sel}: ${p[2]}`);
  }
  assert.match(section, /\n\.seg \{ position: relative; isolation: isolate; \}/);
  // every layer added to a button ignores the pointer, so no hit area changes (the map rail's ::after stays its 44 px target)
  for (const r of rules.filter((x) => /::(before|after)/.test(x.sel) && /content: ""/.test(x.body))) assert.match(r.body, /pointer-events: none/, r.sel);
  assert.doesNotMatch(section, /\.map-ctrl button::after/, "the map rail's ::after is its touch target");
  // the press uses the scale property, which adds to a button's own transform (the swap button is centred with one)
  assert.match(section, /\.su-tab:active, \.swapbox__flip:active \{ scale: \.94; transition-duration: \.08s; \}/);
});

test("live buttons: fast selectors, and the tabbed dashboard's own block stays its own", () => {
  for (const r of rules) for (const s of r.sel.split(",")) assert.doesNotMatch(s.trim(), /:is\([^)]*\)(::?[a-z-]+)?$/, `${s.trim()}: no :is() at the right end`);
  assert.doesNotMatch(section, /\.dv2\b|\.dtab|\.dpanel|\.fcard|\.today__|\.dpv/, "the dashboard's tabs are reached as links that act as tabs (a[role=\"tab\"])");
  assert.match(section, /\.nav a\[aria-current="page"\]::after, a\[role="tab"\]\[aria-selected="true"\]::after \{ animation: lbBreath/);
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
