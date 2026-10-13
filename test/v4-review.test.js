// Design v4, the review of 13 Oct 2026 (premium, honesty and legal, security, accessibility and motion lenses) and its fixes, pinned.
// What each fix looks like in a browser (tab widths, the footer at the bottom of a short page, the phone's numbers card, focus above
// the tab bar, LCP) was measured in Chromium on the real Worker; this file keeps the rules that make it so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openPage } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const style = read("public/style.css"), polish = read("public/polish.css");
const cities = read("public/pages-cities.css");
const TERMS = "2026-10-01";
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/* ---------- honesty and the Terms ---------- */
test("a member whose account has no agreement to the current Terms sees one quiet bar; I agree records it; nobody else sees it", async () => {
  const stale = { ok: true, signedIn: true, signupFlow: "v2", termsVersion: null, user: { handle: "jo_utica" } };
  const p = await openPage("launchpad.html", { me: stale });
  const bar = p.$(".terms-note");
  assert.ok(bar, "the bar is there");
  assert.equal(bar.getAttribute("aria-label"), "Terms of Use");
  assert.equal(p.$(".terms-note a").getAttribute("href"), "/terms");
  assert.ok(!p.calls.some((c) => c.path === "/api/me/terms"), "nothing is recorded before the tap");
  p.$(".terms-note__yes").click();
  await flush();
  const rec = p.calls.find((c) => c.path === "/api/me/terms");
  assert.deepEqual(rec && rec.body, { version: TERMS }, "the same call as /terms' own I agree, with the current version");
  assert.equal(p.$(".terms-note"), null, "gone once recorded");
  // never a blocker: nothing on the page is made inert, and Later just hides it
  const q = await openPage("token.html", { me: stale });
  assert.equal([...q.$$("main, header, footer")].filter((e) => e.inert).length, 0);
  q.$(".terms-note__later").click();
  assert.equal(q.$(".terms-note"), null);
  // a visitor, a member who agreed at sign-up, the old sign-up (no version in its answer), /terms and /connect: no bar
  for (const [file, me] of [["launchpad.html", undefined], ["launchpad.html", { ...stale, termsVersion: TERMS }], ["launchpad.html", { ok: true, signedIn: true, user: { handle: "x" } }],
    ["terms.html", stale], ["connect.html", stale]]) {
    const r = await openPage(file, me ? { me } : {});
    assert.equal(r.$(".terms-note"), null, `${file} ${JSON.stringify(me && me.termsVersion)}`);
  }
  assert.match(read("public/site.js"), /const TERMS_NOW = "2026-10-01";/);
  assert.equal(TERMS, /export const TERMS_VERSION = "([^"]+)"/.exec(read("src/signup-core.js"))[1], "the bar asks for the version the sign-up records");
  assert.match(style, /@media \(max-width: 900px\) \{ \.terms-note \{ bottom: calc\(var\(--bottom-bars, 64px\) \+ 10px\); \} \}/, "above the phone's tab bar");
  assert.match(read("docs/DEPLOY.md"), /the old sign-up has no Terms of Use step of its own any more/, "switching SIGNUP_FLOW back says what it means for the Terms");
});

test("every Buy panel names the Terms of Use next to its button (the entry pop-up is gone: a buyer without an account meets them here)", () => {
  const js = read("public/swap.js");
  assert.match(js, /const terms = el\("p", "tiny muted swap__terms", "By trading here you agree to the "\);/);
  assert.match(js, /termsLink\.href = "\/terms";/);
  assert.match(js, /r\.append\(head, note, box, picker, status, warn, go, walletBox, again, links, foot, terms, more\);/);
  assert.match(read("public/swap.css"), /\.swap__terms \{ margin: -4px 0 0; font-size: var\(--fs-xs, \.75rem\);/);
});

test("the copy says only what is true: boundaries where they exist, city coins as they launch, a device (not a phone) shares the location", () => {
  assert.match(read("src/official.js"), /platform: "Vicinity Launchpad", status: "Launching city by city" \}/);
  assert.match(read("scripts/pages/src/token.html"), /<td><a class="registry__above" href="\/launchpad">On the Launchpad →<\/a><\/td><td><span class="tag tag--warn">Launching city by city<\/span><\/td>/);
});

/* ---------- the footer ---------- */
test("the footer: a security line kept (not a risk line), no Privacy link, and SOCIAL_PROFILES' names escaped into the page", () => {
  const build = read("scripts/pages/build.mjs");
  assert.match(build, /const esc = \(s\) => String\(s\)\.replace\(\/&\/g, "&amp;"\)\.replace\(\/<\/g, "&lt;"\)\.replace\(\/>\/g, "&gt;"\)\.replace\(\/"\/g, "&quot;"\);/);
  assert.match(build, /aria-label="Vicinity on \$\{esc\(p\.network\)\} \(\$\{esc\(p\.handle\)\}\), opens in a new tab"/);
  assert.match(build, /<span class="social-link__name">\$\{esc\(p\.network\)\}<\/span>/);
  assert.match(build, /if \(!\/\^https:\\\/\\\/\[\^\\s"'<>\]\+\$\/\.test\(url\)\)/, "a quote of either kind ends an address");
  assert.doesNotMatch(build, /rules#privacy/);
  assert.match(style, /\.site-footer__safe \{ flex: 1 1 100%; order: 9;/);
});

test("a short page keeps its footer at the bottom of the screen (the page is a column at least the screen's height)", () => {
  assert.match(style, /body \{ display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh; \}\nbody > main \{ flex: 1 0 auto; \}/);
});

/* ---------- accessibility ---------- */
test("a control reached with Tab stops above the phone's tab bar; forced colours keep the bars solid and the chosen tab outlined", () => {
  assert.match(polish, /html \{ scroll-padding-bottom: calc\(var\(--tabbar-h\) \+ env\(safe-area-inset-bottom\) \+ 12px\); \}/);
  assert.match(style, /@media \(forced-colors: active\) \{\n  \.site-header, \.tabbar, \.terms-note \{ background: Canvas;/);
  assert.match(style, /\.seg :is\(button\[aria-selected="true"\], button\[aria-pressed="true"\]\), \.tabbar a\[aria-current="page"\], \.nav a\[aria-current="page"\] \{ outline: 2px solid Highlight;/);
  assert.match(cities, /:root\[data-theme="light"\] #cities \.city-status \{ color: #0C6B4E; \}/, "the 12 px status pill at AA in light");
});

test("the header's scroll shadow fades on a layer of its own (opacity), the bar itself never transitions", () => {
  assert.match(style, /\.site-header::after \{ content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none; box-shadow: var\(--e3\); opacity: 0; \}/);
  assert.match(style, /\.site-header::after \{ transition: opacity var\(--dur-2\) var\(--ease-out\); \}/);
  assert.doesNotMatch(style, /\.site-header \{ transition: [^}]*(box-shadow|background)/, "no shadow or background transition on the blurred bar (the coin page's slide is a transform)");
});
