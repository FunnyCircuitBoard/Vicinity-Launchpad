// The dashboard's tab strip on a computer and its glass pill (the owner, 12 Oct 2026, a 1200 px screenshot with an arrow at the empty
// right half of the bar: the tabs were "kind of gathered to the left"; and "when switching tabs, a glassmorphic animation").
//   * a tablet or a computer (601 px and up): the tabs share the whole bar, one equal part each, the words centred; a tab whose words
//     need more keeps them whole and the others share the rest. A phone keeps its fit steps (is-snug, is-short, is-compact, is-scrollable).
//   * one glass pill (.dtabs__ind, static in the page, hidden from screen readers and the pointer) behind the chosen tab, inside the
//     scrolling list; it slides and stretches to the next tab (Web Animations: transform and width, 320 ms) on a click, a key, a hash
//     change, back and forward, and follows its tab on every resize; at once with reduced motion or "Pause animations". The panel comes
//     in from the side of the tab that was left.
// How it looks, and that it sits exactly on its tab at 320 to 1920 px in both themes, is checked in real Chromium (the scratch sweep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";
import { newEvent } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("public/dashboard.html"), src = read("scripts/pages/src/dashboard.html"), css = read("public/polish-dash.css"), v2 = read("public/dashboard-v2.js");
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
// objects made inside the page's vm context have that context's prototypes: compared as plain data
const plain = (x) => JSON.parse(JSON.stringify(x));

/** The top-level blocks of a stylesheet: { head, body } for every rule and @media (a small walker, enough for our own sheet). */
function blocks(s) {
  const out = [];
  let k = 0;
  while (k < s.length) {
    const open = s.indexOf("{", k); if (open < 0) break;
    let d = 0, close = open;
    for (let j = open; j < s.length; j++) { if (s[j] === "{") d++; else if (s[j] === "}") { d--; if (d === 0) { close = j; break; } } }
    out.push({ head: s.slice(k, open).trim(), body: s.slice(open + 1, close) });
    k = close + 1;
  }
  return out;
}
const top = blocks(clean);
const media = (q) => top.filter((b) => b.head === `@media ${q}`).map((b) => b.body);
const motion = media("(prefers-reduced-motion: no-preference)").join("\n");
const outside = top.filter((b) => !/^@media \(prefers-reduced-motion: no-preference\)/.test(b.head)).map((b) => `${b.head} {${b.body}}`).join("\n");

/** dashboard-v2.js with a stub window (its top level only reads window.V and publishes window.VDash). */
function loadV2() {
  const window = { V: {}, addEventListener() {} };
  vm.runInNewContext(v2, { window });
  return window.VDash;
}

/* ---------- the even fill ---------- */
test("a tablet or a computer: the tabs share the whole bar, one equal part each (nothing gathered to the left); a phone keeps its fit steps", () => {
  // 601 px and up: every tab grows from nothing to one equal part, never narrower than its own words
  assert.ok(media("(min-width: 601px)").some((b) => /^\s*\.dv2 \.dtab, \.dv2 #tab-profile \{ flex: 1 1 0; min-width: max-content; \}\s*$/.test(b)), "the even-fill rule, alone in a 601 px block");
  // the wide block no longer packs the tabs at the start or sizes them by their words
  const wide = media("(min-width: 1000px)").join("\n");
  assert.ok(wide, "the 1000 px block (the strip lines up with the cards)");
  assert.doesNotMatch(wide, /justify-content:\s*flex-start/, "the tabs are not pushed to the left");
  assert.doesNotMatch(wide, /flex:\s*0 1 auto/, "no tab sized by its words alone");
  assert.doesNotMatch(clean, /\.dtabs__list \{[^}]*justify-content:\s*flex-start/);
  assert.match(wide, /\.dv2 \.dtabs__list \{ padding: 4px 6px; \}/);
  // with flex-basis 0 a tab's padding stays outside its part: every tab has the same padding, so every part is the same width
  const pad = (body, sel) => { const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.#]/g, "\\$&")}[^{]*\\{[^}]*padding: ([^;]+);`).exec(body); return m && m[1]; };
  const base = top.find((b) => b.head === ".dv2 .dtab").body;
  assert.equal(pad(media("(min-width: 601px)").join("\n"), ".dv2 #tab-profile"), / padding: ([^;]+);/.exec(base)[1], "601-999 px: Profile has the padding of every tab");
  assert.match(wide, /\.dv2 \.dtab, \.dv2 #tab-profile \{ padding: 0 16px; \}/, "1000 px and up: the same padding for all, Profile too");
  // a phone: unchanged (the tabs grow from their words, the fit steps, Profile as the person's initial)
  assert.match(css, /\.dv2 \.dtab \{ flex: 1 0 auto; justify-content: center; gap: 4px; min-width: 44px; min-height: 44px; padding: 0 8px;/);
  assert.match(css, /\.dv2 #tab-profile \{ flex: 0 0 auto; padding: 0 4px; \}/);
  assert.match(v2, /const steps = \["is-snug", "is-short", "is-compact", "is-scrollable"\];/);
  for (const step of ["is-snug", "is-short", "is-compact", "is-scrollable"]) assert.match(css, new RegExp(`\\.dv2 \\.dtabs\\.${step} `), step);
});

/* ---------- the pill: markup and look ---------- */
test("the glass pill: one static marker, the last child of the tab list, hidden from screen readers and from the pointer, behind the tabs", () => {
  for (const [name, page] of [["source", src], ["built page", html]]) {
    assert.equal((page.match(/class="dtabs__ind"/g) || []).length, 1, `${name}: one pill`);
    assert.match(page, /<span class="dtab__text dtab__long">Profile<\/span><\/a>\n\s*<span class="dtabs__ind" aria-hidden="true"><\/span>\n\s*<\/div>\n\s*<\/nav>/, `${name}: inside #dash-tablist, after the last tab`);
  }
  const list = html.slice(html.indexOf('id="dash-tablist"'), html.indexOf("</nav>", html.indexOf('id="dash-tablist"')));
  assert.equal((list.match(/role="tab"/g) || []).length, 7, "the tab list still holds seven tabs, and only the tabs are tabs");
  assert.doesNotMatch(list, /<span class="dtabs__ind"[^>]*\b(id|role|tabindex)=/, "no id, no role, never focused");
  // the script finds the static marker, never builds one, never writes markup
  assert.match(v2, /const pillEl = \(\) => \$\("#dash-tablist \.dtabs__ind"\);/);
  assert.doesNotMatch(v2, /el\("span", "dtabs__ind"\)|innerHTML|insertAdjacentHTML/);
  // the look: under the tabs inside the scrolling list (it scrolls with them), never takes a tap, glass, both themes
  assert.match(css, /\.dv2 \.dtabs__list \{ gap: 2px; padding: 4px 8px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: none; position: relative; isolation: isolate; \}/);
  const ind = top.find((b) => b.head === ".dv2 .dtabs__ind");
  assert.ok(ind, "the pill's rule");
  for (const decl of ["position: absolute", "z-index: -1", "display: none", "pointer-events: none", "border-radius: 999px", "backdrop-filter: blur(12px) saturate(1.8)", "-webkit-backdrop-filter: blur(12px) saturate(1.8)"]) assert.ok(ind.body.includes(decl), decl);
  assert.match(css, /\.dv2 \.dtabs\.has-ind \.dtabs__ind \{ display: block; \}/, "shown once it has measured its tab");
  assert.match(css, /\.dv2 \.dtabs\.has-ind \.dtab\[aria-selected="true"\] \{ background: none; \}/, "the pill takes over the chosen tab's fill");
  assert.match(css, /\.dv2 \.dtabs\.has-ind \.dtab\[aria-selected="true"\]::after \{ content: none; \}/, "and its ember line (it rides on the pill)");
  assert.match(css, /\.dv2 \.dtab\[aria-selected="true"\] \{ background: var\(--card-2\); color: var\(--text\);/, "without the pill (no script, not measured yet) the chosen tab keeps its own look");
  assert.ok(top.some((b) => b.head === ':root[data-theme="light"] .dv2 .dtabs__ind' && /border-color/.test(b.body) && /background/.test(b.body)), "a light-theme pill");
  assert.ok(top.some((b) => b.head === ".dv2 .dtabs__ind::after" && /bottom: -1px; height: 2px/.test(b.body)), "the ember line on the pill");
  // the chosen tab's words stay var(--text) on the pill: measured 14.5:1 (dark) and 16.9:1 (light) on the pixels, AA needs 4.5:1
  assert.doesNotMatch(clean, /\.dtabs\.has-ind \.dtab\[aria-selected="true"\] \{[^}]*color:/);
  assert.match(read("public/style.css"), /\.dv2 \.dtab:focus-visible \{ outline-offset: -3px; \}/, "the focus ring is drawn inside the tab, above the pill");
});

/* ---------- motion only when it is welcome ---------- */
test("reduced motion: the pill is set at once and the panel just shows; every slide, fade and breath is inside prefers-reduced-motion: no-preference", () => {
  assert.ok(motion, "a no-preference block");
  assert.match(motion, /\.dv2 \.dtabs__ind::after \{ animation: lbBreath 4s steps\(16\) var\(--dur-3, 320ms\) infinite alternate var\(--lb-play, running\); \}/);
  assert.match(motion, /\.dv2 \.dtabs\.has-ind \.dtab \{ transition: color var\(--dur-3, 320ms\)/);
  assert.match(motion, /\.dv2\[data-dir="next"\] \.dpanel:not\(\[hidden\]\) \{ animation-name: ddPanelNext; \}/);
  assert.match(motion, /\.dv2\[data-dir="prev"\] \.dpanel:not\(\[hidden\]\) \{ animation-name: ddPanelPrev; \}/);
  assert.doesNotMatch(outside, /ddPanel(Next|Prev);|\.dtabs__ind[^{]*\{[^}]*\b(animation|transition)\b/, "nothing moves outside the block");
  for (const k of ["ddPanelNext", "ddPanelPrev"]) {
    const kf = top.find((b) => b.head === `@keyframes ${k}`);
    assert.ok(kf, k);
    assert.deepEqual([...kf.body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]), ["opacity", "transform"], `${k}: opacity and transform only`);
  }
  // the slide is the script's: it asks every time (the visitor may turn "Pause animations" on while the page is open)
  assert.match(v2, /if \(glide && from && !near\(from, to\) && !window\.V\.reduced && typeof ind\.animate === "function"\) \{/);
  assert.match(read("public/site.js"), /get reduced\(\) \{ return reducedNow\(\); \}/);
  assert.match(read("public/site.js"), /const reducedNow = \(\) => window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \|\| document\.documentElement\.dataset\.motion === "paused";/);
});

/* ---------- the geometry (pure) ---------- */
test("the pill's geometry: the tab's box in the list's scrolled coordinates; a slide whose leading edge runs ahead; the box read back mid-slide", () => {
  const { pill } = loadV2();
  assert.ok(Object.isFrozen(pill));
  assert.equal(pill.ms, 320); assert.equal(pill.easing, "cubic-bezier(.2,.8,.2,1)");
  // the tab's rectangle minus the list's, plus how far the list has scrolled (so the pill rides with the tabs)
  assert.deepEqual(plain(pill.box({ left: 130.5, top: 104, width: 80.25, height: 44 }, { left: 20, top: 100 }, 30, 0)), { x: 140.5, y: 4, w: 80.25, h: 44 });
  assert.deepEqual(plain(pill.box({ left: 11.111, top: 4, width: 99.999, height: 44 }, { left: 0, top: 0 })), { x: 11.11, y: 4, w: 100, h: 44 }, "to the hundredth of a pixel");
  // to the right: the right edge leads (80% of its way at the middle), the left edge follows (35%), then both settle
  const a = { x: 4, y: 4, w: 100, h: 44 }, b = { x: 304, y: 4, w: 120, h: 44 };
  assert.deepEqual(plain(pill.frames(a, b)), [
    { transform: "translate(4px, 4px)", width: "100px", height: "44px" },
    { transform: "translate(109px, 4px)", width: "251px", height: "44px", offset: 0.45 },
    { transform: "translate(304px, 4px)", width: "120px", height: "44px" },
  ]);
  // to the left: the left edge leads
  assert.deepEqual(plain(pill.frames(b, a)[1]), { transform: "translate(64px, 4px)", width: "248px", height: "44px", offset: 0.45 });
  // the same place (a width change only): a plain two-step change, no stretch
  assert.deepEqual(plain(pill.frames(a, { ...a, w: 90 })), [{ transform: "translate(4px, 4px)", width: "100px", height: "44px" }, { transform: "translate(4px, 4px)", width: "90px", height: "44px" }]);
  // where the running slide has it now (getComputedStyle gives a matrix), so a new slide starts there, never jumps
  assert.deepEqual(plain(pill.fromStyle("matrix(1, 0, 0, 1, 150.5, 4)", "90.25px", "44px")), { x: 150.5, y: 4, w: 90.25, h: 44 });
  assert.equal(pill.fromStyle("none", "90px", "44px"), null);
  assert.equal(pill.fromStyle("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)", "90px", "44px"), null);
  assert.equal(pill.fromStyle("matrix(1, 0, 0, 1, 1, 2)", "auto", "44px"), null);
});

/* ---------- the pill at runtime (the real page in node, with the rectangles a browser would give) ---------- */
test("the pill follows the chosen tab: set once the strip has a size, slides on a click, a hash change and a key, turns from where it is mid-slide, follows a resize; the panel comes from the side left", async () => {
  const ros = [];
  class RO { constructor(cb) { this.cb = cb; this.els = []; ros.push(this); } observe(e) { this.els.push(e); } }
  // (the Terms already agreed in this browser: no gate holding the keyboard)
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }), storage: { vicinity_terms: "2026-10-01" }, globals: { ResizeObserver: RO } });
  const list = p.$("#dash-tablist"), strip = p.$("#dash-tabs"), ind = p.$("#dash-tablist .dtabs__ind"), dv2 = p.$("#dv2");
  const tabs = [...p.$$(".dtab")];
  // the observer watches the list and every tab (a font that loads late, a badge, a fit step, Moderate shown or hidden)
  assert.equal(ros.length, 1);
  assert.deepEqual(ros[0].els, [list, ...tabs]);
  // no layout yet (the node DOM has no sizes): no pill, the chosen tab keeps its own look
  assert.equal(strip.classList.contains("has-ind"), false);
  // a browser's rectangles: the list at (10, 100), tab i at 14 + 100 i, 96 x 44
  let step = 100, left = 10;
  list.getBoundingClientRect = () => ({ left, top: 100, width: 700, height: 52 });
  tabs.forEach((t, i) => { t.getBoundingClientRect = () => ({ left: left + 4 + i * step, top: 104, width: step - 4, height: 44 }); });
  const at = (i) => ({ transform: `translate(${4 + i * step}px, 4px)`, width: `${step - 4}px`, height: "44px" });
  const style = () => ({ transform: ind.style.transform, width: ind.style.width, height: ind.style.height });
  ros[0].cb(); // the observer's first answer
  assert.equal(strip.classList.contains("has-ind"), true, "measured: the pill shows");
  assert.deepEqual(style(), at(0), "behind Home, set at once");
  // motion welcome from here on (the page's matchMedia answers "reduce" by default), and a browser's element.animate
  const anims = [];
  ind.animate = (frames, opts) => { const a = { frames, opts, cancelled: false, cancel() { this.cancelled = true; }, onfinish: null }; anims.push(a); return a; };
  p.win.matchMedia = () => ({ matches: false, addEventListener() {} });
  // a click: Home -> Rankings slides, with the stretch; the Rankings panel comes from the right
  await p.tap(p.$("#tab-rankings"));
  assert.equal(p.win.VDash.active, "rankings");
  assert.deepEqual(style(), at(3));
  assert.equal(anims.length, 1);
  assert.deepEqual(plain(anims[0].frames[0]), at(0)); assert.deepEqual(plain(anims[0].frames.at(-1)), at(3)); assert.equal(anims[0].frames[1].offset, 0.45);
  assert.deepEqual(plain(anims[0].opts), { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  assert.equal(dv2.dataset.dir, "next");
  // the observer answers mid-slide: the same place, the slide goes on; the tab grew (its badge, a font), it turns there from where it is
  p.win.getComputedStyle = () => ({ transform: "matrix(1, 0, 0, 1, 180, 4)", width: "130px", height: "44px" });
  ros[0].cb();
  assert.equal(anims.length, 1, "already on its way there");
  const rk = p.$("#tab-rankings"), rect = rk.getBoundingClientRect;
  rk.getBoundingClientRect = () => ({ ...rect(), width: 110 });
  ros[0].cb();
  assert.equal(anims[0].cancelled, true); assert.equal(anims.length, 2);
  assert.deepEqual(plain(anims[1].frames[0]), { transform: "translate(180px, 4px)", width: "130px", height: "44px" }, "from where the pill was");
  assert.deepEqual(plain(anims[1].frames.at(-1)), { transform: "translate(304px, 4px)", width: "110px", height: "44px" });
  rk.getBoundingClientRect = rect;
  // a hash change mid-slide (back, a link): the running slide stops where it is and a new one starts there, towards City
  p.win.location.hash = "#city";
  p.win.dispatchEvent(newEvent("hashchange"));
  await p.flush();
  assert.equal(p.win.VDash.active, "city");
  assert.equal(anims[1].cancelled, true);
  assert.equal(anims.length, 3);
  assert.deepEqual(plain(anims[2].frames[0]), { transform: "translate(180px, 4px)", width: "130px", height: "44px" }, "from where the pill was");
  assert.deepEqual(plain(anims[2].frames.at(-1)), at(1));
  assert.equal(dv2.dataset.dir, "prev", "the City panel comes from the left");
  anims[2].onfinish();
  // a key: ArrowRight from City to Feed (the roving tabindex is unchanged)
  p.$("#tab-city").focus();
  list.dispatchEvent(newEvent("keydown", { key: "ArrowRight" }));
  await p.flush();
  assert.equal(p.win.VDash.active, "community");
  assert.equal(p.$("#tab-community").getAttribute("aria-selected"), "true"); assert.equal(p.$("#tab-community").getAttribute("tabindex"), "0");
  assert.equal(p.doc.activeElement, p.$("#tab-community"));
  assert.equal(anims.length, 4); assert.deepEqual(plain(anims[3].frames[0]), at(1)); assert.deepEqual(plain(anims[3].frames.at(-1)), at(2));
  anims[3].onfinish();
  // a resize: the tabs are wider and the list has scrolled 30 px; the pill is simply set on its tab (content coordinates), no slide
  step = 120; left = 0;
  Object.defineProperty(list, "scrollLeft", { configurable: true, get: () => 30 });
  p.win.dispatchEvent(newEvent("resize"));
  assert.equal(anims.length, 4, "a resize never slides");
  assert.deepEqual(style(), { transform: `translate(${4 + 2 * 120 + 30}px, 4px)`, width: "116px", height: "44px" });
  // the same tab again (a deep link inside the tab): nothing moves, the panel is not restarted
  p.win.VDash.go("community");
  assert.equal(anims.length, 4); assert.equal(dv2.dataset.dir, "next");
  // reduced motion again (or "Pause animations"): the next switch is at once
  p.win.matchMedia = () => ({ matches: true, addEventListener() {} });
  await p.tap(p.$("#tab-profile"));
  assert.equal(anims.length, 4, "no slide");
  assert.deepEqual(style(), { transform: `translate(${4 + 6 * 120 + 30}px, 4px)`, width: "116px", height: "44px" });
  // the strip loses its size (hidden): no pill, the chosen tab's own look comes back
  list.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  ros[0].cb();
  assert.equal(strip.classList.contains("has-ind"), false);
});

test("the pill never counts as overflow: the fit check parks it at no size first, then puts it back on the chosen tab", async () => {
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }) });
  const list = p.$("#dash-tablist"), strip = p.$("#dash-tabs"), ind = p.$("#dash-tablist .dtabs__ind");
  const tabs = [...p.$$(".dtab")];
  // the strip is 400 px wide; the pill was last set at a wider screen's Profile (x 600): if it counted, the strip would look too narrow
  list.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 52 });
  tabs.forEach((t, i) => { t.getBoundingClientRect = () => ({ left: 4 + i * 56, top: 4, width: 54, height: 44 }); });
  ind.style.transform = "translate(600px, 4px)"; ind.style.width = "160px";
  const seen = [];
  Object.defineProperty(list, "clientWidth", { configurable: true, get: () => 400 });
  Object.defineProperty(list, "scrollWidth", { configurable: true, get: () => { const w = parseFloat(ind.style.width) || 0; seen.push(ind.style.width); return Math.max(396, w ? 600 + w : 0); } });
  p.win.dispatchEvent(newEvent("resize"));
  assert.ok(seen.length > 0 && seen.every((w) => w === "0px"), `the fit check saw the pill at ${seen.join(", ")}`);
  assert.doesNotMatch(strip.className, /is-snug|is-short|is-compact|is-scrollable/, "no fit step for a pill left behind");
  assert.equal(ind.style.width, "54px", "back on Home");
  assert.match(v2, /const sliding = park\(\);\n\s+const steps = \["is-snug", "is-short", "is-compact", "is-scrollable"\];\n\s+strip\.classList\.remove\(\.\.\.steps\);\n\s+for \(const step of steps\) \{ if \(!over\(\)\) break; strip\.classList\.add\(step\); \}\n\s+place\(glide === true \|\| sliding\);/);
  assert.match(v2, /window\.addEventListener\("resize", \(\) => measure\(\)\);/, "a resize event is never taken for a slide");
  assert.match(v2, /if \(document\.fonts && document\.fonts\.ready\) document\.fonts\.ready\.then\(\(\) => measure\(\)\);/, "the fit check runs again once the fonts are in");
});
