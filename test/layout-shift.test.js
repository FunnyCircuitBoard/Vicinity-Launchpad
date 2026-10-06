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

test("signed-out dashboard: while /api/me answers, #dash-out holds its place unseen, so the roles under it never drop (CLS 0.60 on a computer)", () => {
  // 1280x900 signed out: #roles was at 67 px until /api/me answered, then 906 px (839 px down, under the taller example dashboard)
  const js = read("public/dashboard.js");
  const start = js.slice(js.indexOf("/* ---------- start ---------- */"));
  const hold = start.indexOf('else { out.classList.add("is-pending"); out.hidden = false; }'), ask = start.indexOf('const d = await api("/api/me");');
  assert.ok(hold > 0 && ask > hold, "held before /api/me is asked");
  assert.match(start, /if \(skel\) \$\("#dash-skel"\)\.hidden = false;\n\s+else \{ out\.classList\.add\("is-pending"\); out\.hidden = false; \}/,
    "not for someone whose last visit was the tabbed dashboard (they get its placeholders: almost surely signed in)");
  assert.match(start, /preview\(\);\n\s+out\.hidden = false; out\.classList\.remove\("is-pending"\); return;/, "signed out: shown in the place it held");
  assert.match(start, /out\.hidden = true; out\.classList\.remove\("is-pending"\);\n\s+me = d;/, "signed in: gone before the member's dashboard shows");
  assert.match(css, /\n\.dash-out\.is-pending \{ visibility: hidden; \}\n/, "unseen and out of reach (no Tab stop, nothing read out) while it waits");
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{ \.dash-out\.is-pending \.dpv__frame, \.dash-out\.is-pending \.dpv__frame > \* \{ animation: none; \} \}/,
    "the example rises in when it shows, not behind the curtain");
  // without the script nothing changes: it stays hidden as before (no empty room for a visitor without JavaScript)
  for (const f of ["scripts/pages/src/dashboard.html", "public/dashboard.html"]) assert.match(read(f), /<section class="dash-out" id="dash-out" hidden>/, f);
});

test("the toast: one line when it fits (it wrapped 'Contract address copied' onto two lines over the trade tiles), never wider than the screen", () => {
  const t = /\n\.toast \{([^}]*)\}/.exec(css)[1];
  assert.match(t, /left: 50%; bottom: 24px; transform: translateX\(-50%\);/);
  assert.match(t, /width: max-content; max-width: calc\(100vw - 32px\); overflow-wrap: anywhere;/, "as wide as its words, within the gutters; a bare address still breaks");
});
