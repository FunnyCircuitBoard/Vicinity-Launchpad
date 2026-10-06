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
