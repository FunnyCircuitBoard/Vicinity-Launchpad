// The signed-out dashboard (/dashboard, #dash-out) shows a snapshot of a member's Home tab instead of blurred cards and a
// "Members only" lock: the Vicinity Pass, how much they hold and their rank, their city with the path to founding it, and
// "Next for you", all with made-up sample values for an example member (@UticaSam in Utica), labelled "Preview · example data"
// and read by screen readers as one image with one label. It is HTML and CSS (sharp, themed, no image file). It comes alive once:
// it rises in, the numbers count, the bar fills, the next steps slide in, the pass shines and a dot pings; with reduced motion
// none of that runs and every value shows as written. The real dashboard never shows it and never mistakes it for its own cards.
// How it looks is checked in Chromium on the real Worker (320x640, 390x844, 1280x900, dark and light); this pins the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { founderAmount, POLICY } from "../src/policy.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("public/style.css"), js = read("public/dashboard.js"), site = read("public/site.js");
const both = [["public", read("public/dashboard.html")], ["src", read("scripts/pages/src/dashboard.html")]];
/** #dash-out's markup, from its opening tag to the section after it. */
const outOf = (h) => { const a = h.indexOf('<section class="dash-out" id="dash-out" hidden>'), b = h.indexOf("</section>", a); assert.ok(a >= 0 && b > a, "#dash-out"); return h.slice(a, b); };
/** The preview's markup (balanced divs from its opening tag). */
const previewOf = (h) => {
  const a = h.indexOf('<div class="teaser__preview dpv"'); assert.ok(a >= 0, "the preview");
  const re = /<(\/?)div\b[^>]*>/g; re.lastIndex = a; let depth = 0;
  for (let m; (m = re.exec(h)); ) { depth += m[1] ? -1 : 1; if (!depth) return h.slice(a, m.index + m[0].length); }
  throw new Error("unclosed preview");
};
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
// the same number formats the page uses (site.js), so "what the markup says" and "where the count ends" are compared exactly
const fmt = vm.runInNewContext(/const fmt = (.*);\n/.exec(site)[1]);
const compact = vm.runInNewContext(/const compact = (.*);\n/.exec(site)[1]);

/* ---------------- the markup ---------------- */

test("signed-out dashboard: the blurred cards and the 'Members only' lock are replaced by an example dashboard, after the copy and its call to action", () => {
  for (const [where, h] of both) {
    const out = outOf(h);
    assert.doesNotMatch(out, /blur-card|teaser__lock|Members only|\?\?\?|🔒/, `${where}: nothing of the old lock screen is left`);
    const cta = out.indexOf('<a class="btn btn--primary btn--lg" href="/connect">Connect &amp; sign in →</a>'), pv = out.indexOf('class="teaser__preview dpv"');
    assert.ok(cta > 0 && pv > cta, `${where}: "Connect & sign in" stays the main action, before the preview`);
    assert.equal((out.match(/btn--primary/g) || []).length, 1, `${where}: the only primary button is the call to action`);
  }
});

test("the preview says it is an example: a visible 'Preview · example data' tag, and one accurate label for screen readers", () => {
  for (const [where, h] of both) {
    const pv = previewOf(h);
    const open = pv.slice(0, pv.indexOf(">") + 1);
    assert.match(open, /\brole="img"/, `${where}: read as one picture`);
    const label = /aria-label="([^"]+)"/.exec(open)?.[1] || "";
    assert.match(label, /^Example of a member's dashboard, with sample data:/, `${where}: the label says example and sample data`);
    assert.match(pv, /<div class="dpv__frame" aria-hidden="true">/, `${where}: the inner values (which count) are not read out one by one`);
    assert.match(pv, /<span class="dpv__tag">Preview · example data<\/span>/, `${where}: the visible tag`);
    assert.ok(pv.indexOf("dpv__tag") < pv.indexOf("dpv__pass"), `${where}: the tag comes first, above every sample value`);
  }
});

test("the preview mirrors a member's Home tab: pass with username and city, holding and rank, the city with members and founder path, Next for you", () => {
  for (const [where, h] of both) {
    const t = text(previewOf(h));
    const order = ["Preview · example data", "Home City Community Rankings Founder", "Vicinity Pass", "Holder", "@UticaSam", "📍 Utica, United States", "live",
      "💰 You hold", "250K", "250,000 $VICINITY", "🏆 Rank · all holders", "#126", "of 4,200 · top 3.00%",
      "Your community", "Utica", "Open seat 🔥", "Members", "312", "Holders here", "148", "Founder path", "33%",
      "Next for you", "A squad is forming in Utica", "Vote for your Country Manager"];
    let at = 0;
    for (const s of order) { const i = t.indexOf(s, at); assert.ok(i >= at, `${where}: "${s}" after position ${at}, in the order a member sees them: ${t}`); at = i + s.length; }
  }
});

test("the example's founder path follows the real rules: Utica's Stake Ladder amount and the qualifying days", () => {
  const cities = JSON.parse(read("public/data/cities.json"));
  const utica = cities.byCountry.US.find((c) => c[0] === 5142056);
  assert.ok(utica && utica[1] === "Utica", "Utica in the city data");
  const amount = founderAmount(utica[5]);
  for (const [where, h] of both) {
    const t = text(previewOf(h));
    assert.ok(t.includes(`Hold ${amount.toLocaleString("en-US")}+ for ${POLICY.founder.qualifyingDays} days`), `${where}: the hold step says ${amount}`);
    const held = /(\d+) \/ (\d+) days/.exec(t);
    assert.ok(held && Number(held[2]) === POLICY.founder.qualifyingDays && Number(held[1]) < Number(held[2]), `${where}: still qualifying`);
    assert.match(t, /250,000 \$VICINITY/);
    assert.ok(250000 >= amount, "the example holds at least the amount it is qualifying with");
  }
});

test("the preview is a picture only: nothing to tap or tab to, no ids, no inline styles, nothing the dashboard scripts look up", () => {
  for (const [where, h] of both) {
    const pv = previewOf(h);
    assert.doesNotMatch(pv, /<(a|button|input|select|textarea|details|summary)\b|tabindex=/, `${where}: no controls`);
    assert.doesNotMatch(pv, /\sid="/, `${where}: no ids (the dashboard's id table stays as it is)`);
    assert.doesNotMatch(pv, /\sstyle="/, `${where}: no inline styles (blocked by the security policy)`);
    // classes and attributes the dashboard / site scripts select across the whole page: the real dashboard must never fill the example
    assert.doesNotMatch(pv, /data-me-|data-city-t|data-countdown|data-account|data-profiles-only|data-btab|data-scope|data-kind|data-sort|data-policy-version/, `${where}: no data hooks`);
    for (const cls of ["pass__coin", "reveal", "dtab", "dpanel", "role-row", "seg", "chips", "card"]) assert.doesNotMatch(pv, new RegExp(`class="([^"]* )?${cls}( [^"]*)?"`), `${where}: no .${cls}`);
  }
});

test("without the script (or with reduced motion) every value shows as written, and each counted number ends exactly on that text", () => {
  for (const [where, h] of both) {
    const nums = [...previewOf(h).matchAll(/<span class="[^"]*" ((?:data-dpv-[a-z]+="[^"]*" ?)+)>([^<]*)<\/span>/g)];
    assert.equal(nums.length, 5, `${where}: five counted numbers`);
    for (const [, attrs, shown] of nums) {
      const d = Object.fromEntries([...attrs.matchAll(/data-dpv-([a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      const end = (d.pre || "") + (d.fmt === "compact" ? compact(Number(d.to)) : fmt(Number(d.to))) + (d.suf || "");
      assert.equal(shown, end, `${where}: ${attrs}`);
    }
  }
});

/* ---------------- the script ---------------- */

/** Runs dashboard.js's preview() against a small fake page. */
function harness({ reduced = false, io = true } = {}) {
  const src = js.slice(js.indexOf("  function preview() {"), js.indexOf("  /* ---------- start ---------- */"));
  assert.ok(src.length > 200, "preview() is in dashboard.js");
  const cls = () => { const s = new Set(); return { add: (c) => s.add(c), contains: (c) => s.has(c), has: s }; };
  const el = (dataset = {}, textContent = "", kind = "") => ({ dataset, textContent, kind, classList: cls() });
  const nums = [el({ dpvTo: "250000", dpvFmt: "compact" }, "250K"), el({ dpvFrom: "4200", dpvTo: "126", dpvPre: "#" }, "#126"), el({ dpvTo: "312" }, "312"), el({ dpvTo: "148" }, "148"), el({ dpvTo: "33", dpvSuf: "%" }, "33%")];
  const bar = el({}, "", "bar"), todos = el({}, "", "todos");
  const box = el(); box.nums = nums;
  const frames = [], timers = [], observers = [];
  let now = 0;
  const ctx = {
    window: { V: { reduced } }, performance: { now: () => now },
    requestAnimationFrame: (f) => frames.push(f), setTimeout: (f, ms) => timers.push([f, ms]),
    $: (s) => (s === "#dash-out .dpv" ? box : null),
    $$: (s, root) => { assert.equal(root, box, "looks only inside the preview"); return s === "[data-dpv-to]" ? nums : s === ".dpv__bar, .dpv__todos" ? [bar, todos] : []; },
    fmt, compact,
  };
  if (io) ctx.IntersectionObserver = class { constructor(cb, opts) { this.cb = cb; this.opts = opts; this.seen = new Set(); observers.push(this); } observe(t) { this.seen.add(t); } unobserve(t) { this.seen.delete(t); } };
  if (io) ctx.window.IntersectionObserver = ctx.IntersectionObserver;
  vm.runInNewContext(`${src}\npreview();`, ctx);
  const runFrames = (step) => { let n = 0; while (frames.length) { const f = frames.shift(); now += step; f(now); if (++n > 1000) throw new Error("the frame loop never ends"); } return n; };
  return { box, nums, bar, todos, frames, timers, observers, runFrames, tick: (ms) => { now += ms; } };
}

test("preview(): with reduced motion, or without IntersectionObserver, it does nothing at all (nothing armed, nothing hidden, values as written)", () => {
  for (const opts of [{ reduced: true }, { io: false }]) {
    const h = harness(opts);
    assert.equal(h.box.classList.contains("is-armed"), false, JSON.stringify(opts));
    assert.deepEqual(h.nums.map((n) => n.textContent), ["250K", "#126", "312", "148", "33%"]);
    assert.equal(h.observers.length + h.frames.length + h.timers.length, 0);
  }
});

test("preview(): arms the preview, then plays each piece once when it is on screen; the count is a short frame loop that ends on the written value", () => {
  const h = harness();
  assert.equal(h.box.classList.contains("is-armed"), true);
  assert.deepEqual(h.nums.map((n) => n.textContent), ["0", "#4,200", "0", "0", "0%"], "numbers start from their start values");
  assert.equal(h.observers.length, 1);
  const o = h.observers[0];
  assert.equal(o.opts.threshold, 0.6, "a piece plays when most of it is on screen");
  assert.equal(o.seen.size, 7, "five numbers, the bar, the next steps");
  // the bar and the next steps scroll into view: they get is-on (CSS fills and slides them) and are never watched again
  o.cb([{ isIntersecting: false, target: h.nums[0] }, { isIntersecting: true, target: h.bar }, { isIntersecting: true, target: h.todos }]);
  assert.ok(h.bar.classList.contains("is-on") && h.todos.classList.contains("is-on"));
  assert.equal(h.nums[0].textContent, "0", "a number that is not on screen yet waits");
  assert.equal(o.seen.size, 5);
  // the numbers come into view: each counts once after a short pause, through a frame loop that stops at the end
  o.cb(h.nums.map((target) => ({ isIntersecting: true, target })));
  assert.equal(o.seen.size, 0, "nothing is watched any more");
  assert.equal(h.timers.length, 5);
  for (const [f, ms] of h.timers) { assert.ok(ms > 0 && ms < 1000); f(); }
  h.frames.splice(0, 5).forEach((f) => f(0)); // the first frame of each count: at the start
  h.tick(0);
  const frames = h.runFrames(16);
  assert.ok(frames > 50 && frames < 120, `about 1.3 s of frames, then the loop ends (${frames})`);
  assert.deepEqual(h.nums.map((n) => n.textContent), ["250K", "#126", "312", "148", "33%"], "every count ends on the written value");
  assert.equal(h.frames.length, 0, "no frame is requested after the end");
});

test("dashboard.js calls preview() only for someone signed out, just before #dash-out is shown (a member never gets it)", () => {
  assert.equal((js.match(/\bpreview\(\);/g) || []).length, 1, "called once");
  assert.match(js, /if \(!d\.signedIn\) \{\n\s+if \(d\.pending \|\| d\.proof\) \{ location\.assign\("\/connect"\); return; \}\n\s+preview\(\);\n\s+out\.hidden = false; out\.classList\.remove\("is-pending"\); return;\n\s+\}\n\s+out\.hidden = true; out\.classList\.remove\("is-pending"\);\n\s+me = d;/,
    "a member: the held place goes away before anything of theirs shows");
  assert.match(js, /if \(!box \|\| window\.V\.reduced \|\| !\("IntersectionObserver" in window\)\) return;/);
});

/* ---------------- the styles ---------------- */

/** Character ranges of every `@media <...prefers-reduced-motion: no-preference...> { ... }` block. */
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

test("styles: every animation and transition of the preview, and its 'armed' start state, only exist when motion is welcome", () => {
  const rules = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]*\.dpv[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 40);
  for (const m of rules) {
    const [, sel, body] = m;
    if (/\b(animation|transition)\s*:/.test(body) || /is-armed/.test(sel)) assert.ok(inNoPreference(m.index), `${sel.trim()} is inside @media (prefers-reduced-motion: no-preference)`);
  }
  assert.ok(rules.some((m) => /is-armed/.test(m[1])), "the armed state");
  // the keyframes move only transform and opacity (no layout); the shine reuses the pass's own sweep
  for (const name of ["dpvRise", "dpvPing", "dpvSheen", "dpvFloat"]) {
    const at = css.indexOf(`@keyframes ${name} {`); assert.ok(at >= 0, name);
    const body = css.slice(at, css.indexOf("\n", at));
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
    assert.ok(props.length && props.every((p) => p === "transform" || p === "opacity"), `${name}: ${props}`);
  }
  assert.match(css, /\.dpv__shine \{ animation: passShine /);
});

test("styles: crisp (no blur on the preview), fits a 320px phone, and the light theme has its own touches", () => {
  const rules = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]*\.dpv[^{}]*)\{([^}]*)\}/g)];
  for (const [, sel, body] of rules) assert.doesNotMatch(body, /filter:\s*blur|backdrop-filter/, `${sel.trim()}: sharp`);
  assert.match(css, /\.dpv \{[^}]*width: 100%; max-width: 540px; min-width: 0;/);
  assert.match(css, /\.dpv__frame > \* \{ min-width: 0; \}/);
  assert.match(css, /@media \(max-width: 360px\) \{\n[^@]*\.dpv__frame \{ padding: 12px; \}/);
  for (const sel of [".dpv::before", ".dpv__frame", ".dpv__tag"]) assert.ok(css.includes(`:root[data-theme="light"] ${sel} {`), `light ${sel}`);
  // the float only on wide screens, never on a phone
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) and \(min-width: 901px\) \{ \.dpv__frame \{ animation: dpvFloat/);
});
