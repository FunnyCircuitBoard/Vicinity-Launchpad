// The dashboard's tab strip on a tablet or a computer and its glass pill (the owner, 12 Oct 2026, a 1200 px screenshot with an arrow at
// the empty right half of the bar: the tabs were "kind of gathered to the left"; and "when switching tabs, a glassmorphic animation").
//   * the tabs fill the whole bar from 601 px: a tablet gives every tab, Profile too, the same share of the room left over (equal gaps
//     between the words); a computer (1000 px and up) gives each tab one equal part, the word centred, never narrower than its words.
//     A tablet keeps its fit steps (is-snug, is-short, is-compact, is-scrollable). A phone (owner, 17 Oct 2026) shows icons, the pill
//     behind the chosen tab's icon and its name under it; its row only scrolls (with snap) or fits (test/phone-dash.test.js).
//   * one glass pill (.dtabs__ind, static in the page, hidden from screen readers and the pointer) behind the chosen tab, inside the
//     scrolling list; it slides to the next tab with a short stretch at the middle of its way on a click, a key, a hash change, back and
//     forward, follows its tab on every resize, turns from where it is when its target moves mid-slide, and glides with the tabs when
//     the bar re-divides on screen (Moderate arriving late); at once with reduced motion or "Pause animations". The panel comes in from
//     the side of the tab that was left.
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
const r2 = (n) => Math.round(n * 100) / 100;

/** The blocks of a stylesheet at one level: { head, body } for every rule, @media and @keyframes (a small walker, enough for our sheet). */
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
/** Every style rule of the sheet, those inside an @media too (keyframes left out): { head, body }. */
const rules = top.flatMap((b) => (b.head.startsWith("@media") ? blocks(b.body) : b.head.startsWith("@") ? [] : [b]));

/** dashboard-v2.js with a stub window (its top level only reads window.V and publishes window.VDash). */
function loadV2() {
  const window = { V: {}, addEventListener() {} };
  vm.runInNewContext(v2, { window });
  return window.VDash;
}

/* ---------- the fill ---------- */
test("the tabs fill the whole bar from 601 px (nothing gathered to the left): a tablet shares the room left equally, a computer gives each tab one equal part; a tablet keeps its fit steps", () => {
  // every tab grows from its words (the base rule), Profile too (its word, no exception of its own since the header's avatar took the initial)
  assert.match(css, /\.dv2 \.dtab \{ flex: 1 0 auto; justify-content: center; gap: 4px; min-width: 44px; min-height: 44px; padding: 0 8px;/);
  // 601 px: Profile takes the same share and padding as every tab (equal gaps between the words); its one rule of its own is a phone's
  // (up to 600 px: not in the strip, the header's avatar opens it, test/phone-dash.test.js)
  // (and, a phone's too, the strip's icons sit in its middle while the Profile tab is open: review UX-5)
  const own = [".dv2 #tab-profile { display: none; }",
    '.dv2 .dtabs:has(#tab-profile[aria-selected="true"]) .dtab { padding-top: 11px; }',
    '.dv2 .dtabs:has(#tab-profile[aria-selected="true"]) .dtab__badge { top: 8px; }',
    '.dv2 .dtabs:has(#tab-profile[aria-selected="true"]) .dtab.is-alert .dtab__ico::after { top: 13px; }'];
  assert.deepEqual(rules.filter((r) => /#tab-profile\b/.test(r.head)).map((r) => `${r.head} { ${r.body.trim()} }`), own);
  for (const r of own) assert.ok(media("(max-width: 600px)").some((b) => b.includes(r)), `and it is a phone's: ${r}`);
  // a computer: one equal part each, never narrower than its words, the same padding for all
  const wide = media("(min-width: 1000px)").join("\n");
  assert.ok(wide, "the 1000 px block (the strip lines up with the cards)");
  assert.match(wide, /\.dv2 \.dtab \{ flex: 1 1 0; min-width: max-content; padding: 0 16px; \}/);
  assert.match(wide, /\.dv2 \.dtabs__list \{ padding: 4px 6px; \}/);
  // nothing packs the tabs at the start or sizes them by their words alone (a phone's icon tab stacks its icon over its name: its
  // main axis is vertical, so its flex-start is the top, and its tabs share the row equally)
  for (const r of rules.filter((x) => /\.dtabs__list|\.dtab\b|#tab-/.test(x.head))) {
    if (!/flex-direction:\s*column/.test(r.body)) assert.doesNotMatch(r.body, /justify-content:\s*flex-start/, `${r.head}: the tabs are not pushed to the left`);
    assert.doesNotMatch(r.body, /flex:\s*0 1 auto/, `${r.head}: no tab sized by its words alone`);
  }
  // a tablet: the fit steps (a phone shows icons; its row only scrolls or fits)
  assert.match(v2, /const steps = \["is-snug", "is-short", "is-compact", "is-scrollable"\];/);
  for (const step of ["is-snug", "is-short", "is-compact", "is-scrollable"]) assert.match(css, new RegExp(`\\.dv2 \\.dtabs\\.${step} `), step);
});

/* ---------- the pill: markup and look ---------- */
test("the glass pill: one static marker, the last child of the tab list, hidden from screen readers and from the pointer, behind the tabs; its glow stays inside the list", () => {
  for (const [name, page] of [["source", src], ["built page", html]]) {
    assert.equal((page.match(/class="dtabs__ind"/g) || []).length, 1, `${name}: one pill`);
    assert.match(page, /<span class="dtab__text dtab__long">Profile<\/span><\/a>\n\s*<span class="dtabs__ind" aria-hidden="true"><\/span>\n\s*<\/div>\n\s*<\/nav>/, `${name}: inside #dash-tablist, after the last tab`);
  }
  const list = html.slice(html.indexOf('id="dash-tablist"'), html.indexOf("</nav>", html.indexOf('id="dash-tablist"')));
  assert.equal((list.match(/role="tab"/g) || []).length, 9, "the tab list holds nine tabs (Wallet since the wallet step; Notifications hidden until NOTIFY is on), and only the tabs are tabs");
  assert.doesNotMatch(list, /<span class="dtabs__ind"[^>]*\b(id|role|tabindex)=/, "no id, no role, never focused");
  // the script finds the static marker, never builds one, never writes markup
  assert.match(v2, /const pillEl = \(\) => \$\("#dash-tablist \.dtabs__ind"\);/);
  assert.doesNotMatch(v2, /el\("span", "dtabs__ind"\)|innerHTML|insertAdjacentHTML/);
  // under the tabs inside the scrolling list (it scrolls with them), never takes a tap
  assert.match(css, /\.dv2 \.dtabs__list \{ gap: 2px; padding: 4px 8px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: none; position: relative; isolation: isolate; \}/);
  const ind = top.find((b) => b.head === ".dv2 .dtabs__ind");
  assert.ok(ind, "the pill's rule");
  for (const decl of ["position: absolute", "z-index: -1", "display: none", "pointer-events: none", "border-radius: 999px", "transform-origin: 0 0"]) assert.ok(ind.body.includes(decl), decl);
  // the glass is drawn (gradient, rim, lit edge): no blur of its own (the bar already blurs the page; it showed nothing and cost every frame)
  const pillRules = rules.filter((r) => r.head.includes(".dtabs__ind"));
  for (const r of pillRules) assert.doesNotMatch(r.body, /backdrop-filter/, `${r.head}: no backdrop-filter`);
  // one gradient over the whole pill, under the rim too (from the padding box it repeated and its ember foot showed along the top edge)
  const light = top.find((b) => b.head === ':root[data-theme="light"] .dv2 .dtabs__ind');
  assert.ok(light && /border-color/.test(light.body), "a light-theme pill");
  for (const r of [ind, light]) assert.match(r.body, /background: linear-gradient\([^;]*\)\) border-box;/, `${r.head}: the gradient from the border box`);
  // every outer shadow (the pill's and its ember line's, which sits on the pill's bottom edge) fades out within the 4 px of list under
  // the pill: the scrolling list clips there, and a glow cut flat looked wrong. Reach below = y offset + spread + blur.
  const shadows = (value) => value.split(/,(?![^(]*\))/).filter((s) => !/\binset\b/.test(s)).map((s) => {
    const [, y = 0, blur = 0, spread = 0] = [...s.replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi, "").matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
    return { s: s.trim(), reach: y + spread + blur };
  });
  let seen = 0;
  for (const r of pillRules) for (const m of r.body.matchAll(/box-shadow: ([^;]+);/g)) for (const sh of shadows(m[1])) { seen++; assert.ok(sh.reach <= 4, `${r.head}: "${sh.s}" reaches ${sh.reach}px below the pill`); }
  assert.ok(seen >= 6, "the shadows were read");
  assert.ok(top.some((b) => b.head === ".dv2 .dtabs__ind::after" && /bottom: -1px; height: 2px/.test(b.body)), "the ember line on the pill");
  // a phone: the tabs hug their words, so no rim
  assert.match(media("(max-width: 600px)").join("\n"), /\.dv2 \.dtabs__ind, :root\[data-theme="light"\] \.dv2 \.dtabs__ind \{ border-color: transparent; \}/);
  // the light line a shade deeper than --pin, so it keeps 3:1 against the pill at its faintest breath
  assert.match(css, /:root\[data-theme="light"\] \.dv2 \.dtabs__ind::after \{ background: linear-gradient\(90deg, rgba\(207,58,26,0\), #CF3A1A 25%, #CF3A1A 75%, rgba\(207,58,26,0\)\);/);
  assert.match(css, /\.dv2 \.dtabs\.has-ind \.dtabs__ind \{ display: block; \}/, "shown once it has measured its tab");
  assert.match(css, /\.dv2 \.dtabs\.has-ind \.dtab\[aria-selected="true"\] \{ background: none; \}/, "the pill takes over the chosen tab's fill");
  assert.match(css, /\.dv2 \.dtabs\.has-ind \.dtab\[aria-selected="true"\]::after \{ content: none; \}/, "and its ember line (it rides on the pill)");
  assert.match(css, /\.dv2 \.dtab\[aria-selected="true"\] \{ background: var\(--card-2\); color: var\(--text\);/, "without the pill (no script, not measured yet) the chosen tab keeps its own look");
  // the chosen tab's words stay var(--text) on the pill: measured 14.5:1 (dark) and 15.6:1 (light) on the pixels, AA needs 4.5:1
  assert.doesNotMatch(clean, /\.dtabs\.has-ind \.dtab\[aria-selected="true"\] \{[^}]*color:/);
  assert.match(read("public/style.css"), /\.dv2 \.dtab:focus-visible \{ outline-offset: -3px; \}/, "the focus ring is drawn inside the tab, above the pill");
});

/* ---------- motion only when it is welcome ---------- */
test("reduced motion: the pill is set at once, the tabs never glide and the panel just shows; every slide, fade and breath is inside prefers-reduced-motion: no-preference", () => {
  assert.ok(motion, "a no-preference block");
  // design v4 (no Pause control, WCAG 2.2.2): one breath, then the line rests (it ran forever while "Pause animations" could stop it)
  assert.match(motion, /\.dv2 \.dtabs__ind::after \{ animation: ddLineBreath 4s steps\(16\) var\(--dur-3, 320ms\) 1 alternate var\(--lb-play, running\); \}/);
  assert.doesNotMatch(read("public/polish-dash.css"), /animation:[^;}]*\binfinite\b/, "nothing on the dashboard loops");
  assert.match(motion, /\.dv2 \.dtabs\.has-ind \.dtab \{ transition: color var\(--dur-3, 320ms\)/);
  assert.match(motion, /\.dv2\[data-dir="next"\] \.dpanel:not\(\[hidden\]\) \{ animation-name: ddPanelNext; \}/);
  assert.match(motion, /\.dv2\[data-dir="prev"\] \.dpanel:not\(\[hidden\]\) \{ animation-name: ddPanelPrev; \}/);
  // outside that block (keyframes left out), however a rule is written, none of these motions is named and the pill never moves
  const outside = top.filter((b) => !b.head.startsWith("@keyframes") && !/^@media \(prefers-reduced-motion: no-preference\)/.test(b.head)).map((b) => `${b.head} {${b.body}}`).join("\n");
  assert.doesNotMatch(outside, /\bdd(PanelNext|PanelPrev|LineBreath)\b/, "a panel slide or the line's breath outside the block");
  assert.doesNotMatch(outside, /\.dtabs__ind[^{]*\{[^}]*\b(animation|transition)\b/, "the pill animated outside the block");
  for (const k of ["ddPanelNext", "ddPanelPrev", "ddLineBreath"]) {
    const kf = top.find((b) => b.head === `@keyframes ${k}`);
    assert.ok(kf, k);
    assert.ok([...kf.body.matchAll(/([a-z-]+)\s*:/g)].every((m) => ["opacity", "transform"].includes(m[1])), `${k}: opacity and transform only`);
  }
  // the line breathes between 85% and full, never fainter: it keeps 3:1 against the pill at every moment (WCAG 1.4.11)
  assert.match(css, /@keyframes ddLineBreath \{ from \{ opacity: \.85; \} to \{ opacity: 1; \} \}/);
  // the slides are the script's: it asks every time (the visitor may turn "Pause animations" on while the page is open)
  assert.match(v2, /if \(ms && from && !near\(from, to\) && !window\.V\.reduced && typeof ind\.animate === "function"\) \{/);
  assert.match(v2, /if \(reflowing \|\| !started \|\| !pill \|\| !list \|\| window\.V\.reduced\) \{ fn\(\); return; \}/, "the tabs glide only when motion is welcome");
  assert.match(read("public/site.js"), /get reduced\(\) \{ return reducedNow\(\); \}/);
  assert.match(read("public/site.js"), /const reducedNow = \(\) => window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \|\| document\.documentElement\.dataset\.motion === "paused";/);
});

/* ---------- the geometry (pure) ---------- */
test("the pill's geometry: the tab's box in the list's scrolled coordinates; a slide that is longest at its middle, capped, with no kink; transform alone between tabs of one width", () => {
  const { pill } = loadV2();
  assert.ok(Object.isFrozen(pill));
  assert.equal(pill.ms, 320); assert.equal(pill.followMs, 240); assert.equal(pill.easing, "cubic-bezier(.2,.8,.2,1)");
  // the tab's rectangle minus the list's, plus how far the list has scrolled (so the pill rides with the tabs)
  assert.deepEqual(plain(pill.box({ left: 130.5, top: 104, width: 80.25, height: 44 }, { left: 20, top: 100 }, 30, 0)), { x: 140.5, y: 4, w: 80.25, h: 44 });
  assert.deepEqual(plain(pill.box({ left: 11.111, top: 4, width: 99.999, height: 44 }, { left: 0, top: 0 })), { x: 11.11, y: 4, w: 100, h: 44 }, "to the hundredth of a pixel");
  const IN = pill.easeIn, OUT = pill.easeOut;
  // a computer (every tab one width): transform alone, which the compositor runs; the stretch is a scaleX from the left edge. Home to
  // Profile at 1280 px: the centre 55% of the way at 45% of the time, 48 px longer there (a quarter of 960 px, capped at 48), then home.
  const home = { x: 6, y: 4, w: 160, h: 44 }, profile = { x: 966, y: 4, w: 160, h: 44 };
  assert.deepEqual(plain(pill.frames(home, profile)), [
    { transform: "translate(6px, 4px) scaleX(1)", easing: IN },
    { transform: "translate(510px, 4px) scaleX(1.3)", offset: 0.45, easing: OUT },
    { transform: "translate(966px, 4px) scaleX(1)" },
  ]);
  // tabs of different widths (a phone, a tablet): the width moves too, with the same shape. To the right, then back to the left.
  const a = { x: 4, y: 4, w: 100, h: 44 }, b = { x: 304, y: 4, w: 120, h: 44 };
  assert.deepEqual(plain(pill.frames(a, b)), [
    { transform: "translate(4px, 4px)", width: "100px", easing: IN },
    { transform: "translate(140.5px, 4px)", width: "168px", offset: 0.45, easing: OUT },
    { transform: "translate(304px, 4px)", width: "120px" },
  ]);
  assert.deepEqual(plain(pill.frames(b, a)[1]), { transform: "translate(109.5px, 4px)", width: "168px", offset: 0.45, easing: OUT });
  // the stretch is capped: at most a quarter of the way, 48 px, and half the wider tab (a phone's 50 px tab is never more than 75 px)
  for (const [from, to] of [[home, profile], [a, b], [{ x: 4, y: 4, w: 50, h: 44 }, { x: 300, y: 4, w: 44, h: 44 }], [{ x: 4, y: 4, w: 50, h: 44 }, { x: 60, y: 4, w: 44, h: 44 }]]) {
    const f = pill.frames(from, to), mid = f[1], wide = Math.max(from.w, to.w), d = Math.abs(to.x + to.w / 2 - from.x - from.w / 2);
    const w = mid.width ? parseFloat(mid.width) : to.w * Number(/scaleX\(([\d.]+)\)/.exec(mid.transform)[1]);
    assert.ok(w <= wide + Math.min(d / 4, 48, wide / 2) + 0.01 && w > wide, `${JSON.stringify([from, to])}: ${w}px at the middle`);
    assert.ok(f.every((k) => !("height" in k)), "the height never animates (it is set once)");
  }
  // the two halves meet at the same speed: the first ends as fast as the second starts (no kink at the middle)
  const bez = (e) => e.match(/[\d.]+/g).map(Number);
  const [, , x2, y2] = bez(IN), [x1, y1] = bez(OUT);
  const v1 = ((1 - y2) / (1 - x2)) * (0.55 / 0.45), v2s = (y1 / x1) * (0.45 / 0.55);
  assert.ok(Math.abs(v1 - v2s) / v1 < 0.02, `${v1.toFixed(3)} then ${v2s.toFixed(3)}`);
  // a move without the stretch (the pill turning mid-slide, or following its tab): one smooth step with the site's ease
  assert.deepEqual(plain(pill.frames(a, b, false)), [{ transform: "translate(4px, 4px)", width: "100px", easing: "cubic-bezier(.2,.8,.2,1)" }, { transform: "translate(304px, 4px)", width: "120px" }]);
  assert.deepEqual(plain(pill.frames(a, { ...a, x: 4.4, w: 100.2 })), [{ transform: "translate(4px, 4px) scaleX(0.998)", easing: "cubic-bezier(.2,.8,.2,1)" }, { transform: "translate(4.4px, 4px) scaleX(1)" }], "no stretch in place");
  // where the running slide has it now (getComputedStyle gives a matrix; its scaleX times the width), so a new slide starts there
  assert.deepEqual(plain(pill.fromStyle("matrix(1, 0, 0, 1, 150.5, 4)", "90.25px", "44px")), { x: 150.5, y: 4, w: 90.25, h: 44 });
  assert.deepEqual(plain(pill.fromStyle("matrix(1.3, 0, 0, 1, 510, 4)", "160px", "44px")), { x: 510, y: 4, w: 208, h: 44 });
  assert.equal(pill.fromStyle("none", "90px", "44px"), null);
  assert.equal(pill.fromStyle("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)", "90px", "44px"), null);
  assert.equal(pill.fromStyle("matrix(1, 0, 0, 1, 1, 2)", "auto", "44px"), null);
});

/* ---------- the pill at runtime (the real page in node, with the rectangles a browser would give) ---------- */
test("the pill follows the chosen tab: set once the strip has a size, slides on a click, a hash change and a key, turns in the time it had left, ignores a height-only resize; the panel comes from the side left", async () => {
  const ros = [];
  class RO { constructor(cb) { this.cb = cb; this.els = []; ros.push(this); } observe(e) { this.els.push(e); } }
  // (the Terms already agreed in this browser: no gate holding the keyboard)
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }), storage: { vicinity_terms: "2026-10-01" }, globals: { ResizeObserver: RO } });
  const list = p.$("#dash-tablist"), strip = p.$("#dash-tabs"), ind = p.$("#dash-tablist .dtabs__ind"), dv2 = p.$("#dv2");
  const tabs = [...p.$$(".dtab")];
  const { easeIn: IN, easing: EASE } = p.win.VDash.pill;
  // the observer watches the list and every tab (a font that loads late, a badge, a fit step, Moderate shown or hidden)
  assert.equal(ros.length, 1);
  assert.deepEqual(ros[0].els, [list, ...tabs]);
  // no layout yet (the node DOM has no sizes): no pill, the chosen tab keeps its own look
  assert.equal(strip.classList.contains("has-ind"), false);
  // a browser's rectangles: the list at (10, 100), tab i at 14 + 100 i, 96 x 44 (i counts every tab in the markup, the hidden
  // Notifications tab at 4 included: Home 0, Wallet 1, City 2, Feed 3, Notifications 4, Rankings 5, Founder 6, Moderate 7, Profile 8)
  let step = 100, left = 10;
  list.getBoundingClientRect = () => ({ left, top: 100, width: 700, height: 52 });
  tabs.forEach((t, i) => { t.getBoundingClientRect = () => ({ left: left + 4 + i * step, top: 104, width: step - 4, height: 44 }); });
  const at = (i, scroll = 0) => ({ transform: `translate(${4 + i * step + scroll}px, 4px)`, width: `${step - 4}px`, height: "44px" });
  const slid = (i) => `translate(${4 + i * step}px, 4px) scaleX(1)`; // tabs of one width: the slide is transform alone
  const style = () => ({ transform: ind.style.transform, width: ind.style.width, height: ind.style.height });
  ros[0].cb(); // the observer's first answer
  assert.equal(strip.classList.contains("has-ind"), true, "measured: the pill shows");
  assert.deepEqual(style(), at(0), "behind Home, set at once");
  // motion welcome from here on (the page's matchMedia answers "reduce" by default), and a browser's element.animate
  const anims = [];
  ind.animate = (frames, opts) => { const a = { frames, opts, currentTime: 0, cancelled: false, cancel() { this.cancelled = true; }, onfinish: null }; anims.push(a); return a; };
  p.win.matchMedia = () => ({ matches: false, addEventListener() {} });
  // a click: Home -> Rankings (the sixth tab in the markup: Home, Wallet, City, Feed, Notifications, Rankings) slides (transform alone, the
  // stretch in the middle); the Rankings panel comes from the right
  await p.tap(p.$("#tab-rankings"));
  assert.equal(p.win.VDash.active, "rankings");
  assert.deepEqual(style(), at(5), "the pill's own box is the new tab's at once (the slide runs over it)");
  assert.equal(anims.length, 1);
  assert.deepEqual(plain(anims[0].frames), [{ transform: slid(0), easing: IN }, { transform: "translate(255px, 4px) scaleX(1.5)", offset: 0.45, easing: p.win.VDash.pill.easeOut }, { transform: slid(5) }]);
  assert.deepEqual(plain(anims[0].opts), { duration: 320 });
  assert.equal(dv2.dataset.dir, "next");
  // the observer answers mid-slide: the same place, the slide goes on
  p.win.getComputedStyle = () => ({ transform: "matrix(1.25, 0, 0, 1, 180, 4)", width: "104px", height: "44px" }); // where it is: 180, 130 px wide
  ros[0].cb();
  assert.equal(anims.length, 1, "already on its way there");
  // the tab grew mid-slide (its badge, a font): the pill turns there from where it is, in the time the slide had left, no new stretch
  const rk = p.$("#tab-rankings"), rect = rk.getBoundingClientRect;
  rk.getBoundingClientRect = () => ({ ...rect(), width: 110 });
  anims[0].currentTime = 150;
  ros[0].cb();
  assert.equal(anims[0].cancelled, true); assert.equal(anims.length, 2);
  assert.deepEqual(plain(anims[1].frames), [{ transform: "translate(180px, 4px)", width: "130px", easing: EASE }, { transform: "translate(504px, 4px)", width: "110px" }]);
  assert.deepEqual(plain(anims[1].opts), { duration: 170 }, "320 ms in all");
  rk.getBoundingClientRect = rect;
  // a hash change mid-slide (back, a link): the running slide stops where it is and a full new one starts there, towards City
  p.win.location.hash = "#city";
  p.win.dispatchEvent(newEvent("hashchange"));
  await p.flush();
  assert.equal(p.win.VDash.active, "city");
  assert.equal(anims[1].cancelled, true);
  assert.equal(anims.length, 3);
  assert.deepEqual(plain(anims[2].frames[0]), { transform: "translate(180px, 4px)", width: "130px", easing: IN }, "from where the pill was");
  assert.equal(anims[2].frames[1].offset, 0.45);
  assert.deepEqual(plain(anims[2].frames.at(-1)), { transform: "translate(204px, 4px)", width: "96px" });
  assert.deepEqual(plain(anims[2].opts), { duration: 320 });
  assert.equal(dv2.dataset.dir, "prev", "the City panel comes from the left");
  anims[2].onfinish();
  // a key: ArrowRight from City to Feed (the roving tabindex is unchanged)
  p.$("#tab-city").focus();
  list.dispatchEvent(newEvent("keydown", { key: "ArrowRight" }));
  await p.flush();
  assert.equal(p.win.VDash.active, "community");
  assert.equal(p.$("#tab-community").getAttribute("aria-selected"), "true"); assert.equal(p.$("#tab-community").getAttribute("tabindex"), "0");
  assert.equal(p.doc.activeElement, p.$("#tab-community"));
  assert.equal(anims.length, 4); assert.equal(anims[3].frames[0].transform, slid(2)); assert.equal(anims[3].frames.at(-1).transform, slid(3));
  anims[3].onfinish();
  // a resize: the tabs are wider and the list has scrolled 30 px; the pill is simply set on its tab (content coordinates), no slide
  step = 120; left = 0;
  Object.defineProperty(list, "scrollLeft", { configurable: true, get: () => 30 });
  p.win.innerWidth = 1280;
  p.win.dispatchEvent(newEvent("resize"));
  assert.equal(anims.length, 4, "a resize never slides");
  assert.deepEqual(style(), at(3, 30));
  // a slide on its way, then the phone's address bar shows (only the height changes): nothing happens to the slide
  await p.tap(p.$("#tab-founder"));
  assert.equal(anims.length, 5);
  anims[4].currentTime = 100;
  p.win.innerHeight = 700;
  p.win.dispatchEvent(newEvent("resize"));
  assert.equal(anims[4].cancelled, false, "a height-only resize leaves the slide alone");
  assert.equal(anims.length, 5);
  // the width really changes mid-slide: the fit check runs and the pill turns to the new place in the 220 ms the slide had left
  step = 110; p.win.innerWidth = 1100;
  p.win.dispatchEvent(newEvent("resize"));
  assert.equal(anims[4].cancelled, true); assert.equal(anims.length, 6);
  assert.deepEqual(plain(anims[5].frames), [{ transform: "translate(180px, 4px)", width: "130px", easing: EASE }, { transform: "translate(694px, 4px)", width: "106px" }]);
  assert.deepEqual(plain(anims[5].opts), { duration: 220 });
  anims[5].onfinish();
  // the same tab again (a deep link inside the tab): nothing moves, the panel is not restarted
  p.win.VDash.go("founder");
  assert.equal(anims.length, 6); assert.equal(dv2.dataset.dir, "next");
  // reduced motion again (or "Pause animations"): the next switch is at once
  p.win.matchMedia = (q) => ({ matches: /reduce/.test(q), addEventListener() {} }); // (still a computer: the text strip)
  await p.tap(p.$("#tab-profile"));
  assert.equal(anims.length, 6, "no slide");
  assert.deepEqual(style(), { transform: `translate(${4 + 8 * 110 + 30}px, 4px)`, width: "106px", height: "44px" });
  // the strip loses its size (hidden): no pill, the chosen tab's own look comes back
  list.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  ros[0].cb();
  assert.equal(strip.classList.contains("has-ind"), false);
});

test("the bar re-divides as one glide when Moderate arrives after the strip is on screen: every tab slides from where it was, Moderate fades in, the pill goes with its tab; at once with reduced motion", async () => {
  const ros = [];
  class RO { constructor(cb) { this.cb = cb; ros.push(this); } observe() {} }
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }), storage: { vicinity_terms: "2026-10-01" }, globals: { ResizeObserver: RO } });
  const list = p.$("#dash-tablist"), ind = p.$("#dash-tablist .dtabs__ind"), mod = p.$("#tab-moderate"), prof = p.$("#tab-profile");
  const tabs = [...p.$$(".dtab")];
  const { followMs, easing: EASE } = p.win.VDash.pill;
  assert.equal(mod.hidden, true, "a member: no Moderate yet");
  // a computer's layout: the shown tabs share 700 px equally (7 tabs of 100 px, then 8 of 87.5 px)
  list.getBoundingClientRect = () => ({ left: 0, top: 0, width: 708, height: 52 });
  const layout = (t) => { const shown = tabs.filter((x) => !x.hidden), w = 700 / shown.length; return { left: 4 + shown.indexOf(t) * w, top: 4, width: w, height: 44 }; };
  for (const t of tabs) t.getBoundingClientRect = () => layout(t);
  ros[0].cb();
  // motion welcome, and a browser's element.animate on the list, the pill and every tab
  p.win.matchMedia = () => ({ matches: false, addEventListener() {} });
  const anims = [];
  for (const e of [list, ind, ...tabs]) e.animate = (frames, opts) => { const a = { el: e, frames, opts, currentTime: 0, cancelled: false, cancel() { this.cancelled = true; }, onfinish: null }; anims.push(a); return a; };
  await p.tap(prof);
  anims.splice(0).forEach((a) => a.onfinish && a.onfinish()); // the slide to Profile, done
  const before = new Map(tabs.filter((t) => !t.hidden).map((t) => [t, layout(t).left]));
  // /api/mod answers: this person moderates. The pill was behind Profile (x 604, 100 wide); where the follow starts from:
  p.win.getComputedStyle = (e) => (e === ind ? { transform: "matrix(1, 0, 0, 1, 604, 4)", width: "100px", height: "44px" } : { transform: "none" });
  p.win.VDash.mod({ ok: true, moderator: true, role: "founder", posts: [], proposals: [], appeals: [], objections: [], towns: [] });
  assert.equal(mod.hidden, false, "Moderate shows");
  // every tab that moved glides from its old place to its new one (transform only), at the follow's pace (a hidden tab, Notifications
  // with NOTIFY off, is not on the bar and does not glide)
  for (const t of tabs.filter((x) => x !== mod && !x.hidden)) {
    const mine = anims.filter((a) => a.el === t), dx = r2(before.get(t) - layout(t).left);
    if (Math.abs(dx) < 0.5) { assert.equal(mine.length, 0, `${t.id} did not move`); continue; }
    assert.equal(mine.length, 1, `${t.id} glides`);
    assert.deepEqual(plain(mine[0].frames), [{ transform: `translateX(${dx}px)` }, { transform: "none" }]);
    assert.deepEqual(plain(mine[0].opts), { duration: followMs, easing: EASE });
  }
  assert.ok(anims.some((a) => a.el === prof), "Profile moved over");
  const fade = anims.filter((a) => a.el === mod);
  assert.equal(fade.length, 1); assert.deepEqual(plain(fade[0].frames), [{ opacity: 0 }, { opacity: 1 }], "Moderate fades in");
  // the pill goes with its tab, the same glide (no stretch), to Profile's new box
  const pillMoves = anims.filter((a) => a.el === ind && !a.cancelled);
  assert.equal(pillMoves.length, 1);
  assert.deepEqual(plain(pillMoves[0].frames), [{ transform: "translate(604px, 4px)", width: "100px", easing: EASE }, { transform: "translate(616.5px, 4px)", width: "87.5px" }]);
  assert.deepEqual(plain(pillMoves[0].opts), { duration: followMs });
  assert.deepEqual({ transform: ind.style.transform, width: ind.style.width }, { transform: "translate(616.5px, 4px)", width: "87.5px" });
  // the observer answers while the tabs glide: Profile is drawn 8 px short of its place; the pill is measured where the layout has
  // Profile, so it does not turn towards the glide
  p.win.getComputedStyle = (e) => (e === prof ? { transform: "matrix(1, 0, 0, 1, -8, 0)" } : e === ind ? { transform: "matrix(1, 0, 0, 1, 600, 4)", width: "102px", height: "44px" } : { transform: "none" });
  prof.getBoundingClientRect = () => ({ ...layout(prof), left: layout(prof).left - 8 });
  const n = anims.length;
  ros[0].cb();
  assert.equal(anims.length, n, "no new slide: the pill is already on its way to Profile's place");
  assert.equal(pillMoves[0].cancelled, false, "the glide goes on");
  assert.equal(ind.style.transform, "translate(616.5px, 4px)", "towards Profile's place in the layout, not where its glide draws it");
  prof.getBoundingClientRect = () => layout(prof);
  anims.forEach((a) => a.onfinish && a.onfinish());
  // with reduced motion the bar re-divides at once: Moderate goes, nothing glides, the pill is simply on Profile
  p.win.matchMedia = (q) => ({ matches: /reduce/.test(q), addEventListener() {} }); // (still a computer: the text strip)
  const m = anims.length;
  p.win.VDash.mod({ ok: true, moderator: false });
  assert.equal(mod.hidden, true);
  assert.equal(anims.length, m, "nothing animates");
  assert.equal(ind.style.transform, `translate(${r2(4 + 6 * (700 / 7))}px, 4px)`);
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
  p.win.innerWidth = 400;
  p.win.dispatchEvent(newEvent("resize"));
  assert.ok(seen.length > 0 && seen.every((w) => w === "0px"), `the fit check saw the pill at ${seen.join(", ")}`);
  assert.doesNotMatch(strip.className, /is-snug|is-short|is-compact|is-scrollable/, "no fit step for a pill left behind");
  assert.equal(ind.style.width, "54px", "back on Home");
  assert.match(v2, /const left = park\(\);\n\s+const steps = \["is-snug", "is-short", "is-compact", "is-scrollable"\];\n\s+strip\.classList\.remove\(\.\.\.steps, "is-flush"\);\n\s+for \(const step of icons \? \["is-flush", "is-scrollable"\] : steps\) \{ if \(!over\(\)\) break; strip\.classList\.add\(step\); \}[^\n]*\n\s+edges\(\);\n\s+keyStop\(\);\n\s+place\(how \|\| \(reflowing \? "follow" : ""\), left\);/);
  assert.match(v2, /window\.addEventListener\("resize", \(\) => \{ const w = window\.innerWidth; if \(typeof w === "number" && w === lastWidth\) return; lastWidth = w; measure\(\); \}\);/, "a resize is never taken for a slide, and only a new width re-fits");
  assert.match(v2, /if \(document\.fonts && document\.fonts\.ready\) document\.fonts\.ready\.then\(\(\) => measure\(\)\);/, "the fit check runs again once the fonts are in");
});
