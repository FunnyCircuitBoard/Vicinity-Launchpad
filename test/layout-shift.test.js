// Nothing on a page jumps when a script fills it in (review of 6 Oct 2026, measured in Chromium on the real Worker): the dashboard's
// "live · checked …" note, the signed-out dashboard while /api/me answers, and the token page's contract card while /api/token answers.
// Each keeps its room from the first paint. Browsers are not run here; this pins the rules and the scripts that keep the room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("public/style.css");

test("dashboard: the 'live · checked …' note keeps the room of its longest text, so the pass never re-wraps and the stats never jump", () => {
  // 390x844 signed in: at 5 s "live" became "live · checked 5s ago", the pass's bottom row wrapped, the stat row moved 27 px (CLS 0.19)
  const js = read("public/dashboard.js");
  assert.match(js, /\$\("#me-checked"\)\.textContent = s < 5 \? "live · just checked" : `live · checked \$\{s < 60 \? s \+ "s" : Math\.round\(s \/ 60\) \+ "m"\} ago`;/,
    "the texts it can show (the longest, 'live · checked 59m ago', is 141 px at the note's 12.8 px in the site font: 11 em)");
  assert.match(css, /\n#me-checked \{ display: inline-block; min-width: 11\.5em; \}\n/, "room for it from the start, in em so it follows the font size");
  assert.match(css, /\.live-note \{ white-space: nowrap; \}/, "and the note never breaks inside");
  for (const f of ["scripts/pages/src/dashboard.html", "public/dashboard.html"]) {
    assert.match(read(f), /<span class="live-note"><span class="live-dot" aria-hidden="true"><\/span> <span id="me-checked">live<\/span><\/span>/, f);
  }
});

test("signed-out dashboard: a guest's page holds the signed-out room from the first paint, so the roles under it never drop (CLS 0.60 on a computer)", () => {
  // 1280x900 signed out: #roles was at 67 px until /api/me answered, then 906 px (839 px down, under the taller example dashboard).
  // Holding the room from dashboard.js was too late (a deferred script runs after the first paint): theme.js, in <head>, marks a guest.
  const theme = read("public/theme.js");
  assert.match(theme, /try \{ if \(localStorage\.getItem\("vicinity-account"\) !== "1" && localStorage\.getItem\("vicinity:dash-v2"\) !== "1"\) root\.dataset\.guest = ""; \} catch \{\}/,
    "a guest: no sign-in remembered in this browser (site.js's key) and no tabbed dashboard last time (dashboard.js's key)");
  assert.match(read("public/site.js"), /localStorage\.setItem\("vicinity-account", "1"\)/, "the same key site.js sets for a signed-in visitor");
  assert.match(read("public/dashboard.js"), /const V2_KEY = "vicinity:dash-v2";/, "the same key dashboard.js sets");
  for (const f of ["scripts/pages/src/dashboard.html", "public/dashboard.html"]) {
    const h = read(f);
    assert.match(h, /<section class="dash-out is-pending" id="dash-out" hidden>/, `${f}: hidden without JavaScript, as before`);
  }
  assert.ok(read("public/dashboard.html").indexOf('<script src="/theme.js"></script>') < read("public/dashboard.html").indexOf("<body"), "theme.js runs in <head>, before the first paint");
  assert.match(css, /\n:root\[data-guest\] \.dash-out\.is-pending\[hidden\] \{ display: block !important; visibility: hidden; \}\n/, "laid out but unseen: no Tab stop, nothing read out");
  const js = read("public/dashboard.js"), start = js.slice(js.indexOf("/* ---------- start ---------- */"));
  assert.match(start, /const unhold = \(\) => out\.classList\.remove\("is-pending"\);/);
  assert.match(start, /unhold\(\);\n\s+preview\(\);\n\s+out\.hidden = false; return;/, "signed out: shown in the place it held, in the same task (no frame in between)");
  // a member on a browser with no hint (the first visit after signing in): the room is held until something of theirs takes it, never
  // given back first (that made #roles jump up, then down again: CLS 0.97 at 1280x900 instead of one shift)
  assert.match(start, /if \(tabbed\) \{ \$\("#dash-skel"\)\.hidden = false; unhold\(\); \}/, "the tabbed dashboard's placeholders take it");
  assert.match(start, /if \(!d\.user\.home\) \{ unhold\(\); onboard\(d\); return; \}/, "or the first steps");
  assert.match(start, /unhold\(\);\n\s+\$\("#dash-main"\)\.hidden = false;/, "or the dashboard itself");
  assert.equal((start.match(/unhold\(\)/g) || []).length, 4, "and nowhere else");
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{ \.dash-out\.is-pending \.dpv__frame, \.dash-out\.is-pending \.dpv__frame > \* \{ animation: none; \} \}/,
    "the example rises in when it shows, not behind the curtain");
});

test("the toast: one line when it fits (it wrapped 'Contract address copied' onto two lines over the trade tiles), never wider than the screen", () => {
  const t = /\n\.toast \{([^}]*)\}/.exec(css)[1];
  assert.match(t, /left: 50%; bottom: 24px; transform: translateX\(-50%\);/);
  assert.match(t, /width: max-content; max-width: calc\(100vw - 32px\); overflow-wrap: anywhere;/, "as wide as its words, within the gutters; a bare address still breaks");
});
