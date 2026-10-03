// Dashboard v2 (DASHBOARD_V2=on), the look: the one "dashboard v2" block of public/style.css reaches nothing outside the tabbed
// page (every selector is scoped under .dv2 or .dv2-skel), so the flag-off dashboard renders exactly as before; the panels wrap
// long button labels (the eligible holder's "Apply to found <city> (checks your location)" widened the Founder panel past a
// 390px screen); the strip's sticky offset and the router's scroll offset are the same number; the Moderate deep link waits
// for /api/mod only until the person picks another tab. Found in real Chromium against a mock /api (scratchpad/dash-mock), pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("style.css"), v2 = read("dashboard-v2.js");
const MARK = "/* ---- dashboard v2 ---- */";
const block = css.slice(css.indexOf(MARK) + MARK.length);

/** Every rule of a stylesheet as { selectors, body, media }: a small splitter, enough for our own file (no nested at-rules beyond @media). */
function rules(text) {
  const out = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const readBlock = (from) => { let depth = 0; for (let j = from; j < clean.length; j++) { if (clean[j] === "{") depth++; else if (clean[j] === "}") { depth--; if (depth === 0) return j; } } throw new Error("unbalanced braces"); };
  const walk = (s, media) => {
    let k = 0;
    while (k < s.length) {
      const open = s.indexOf("{", k); if (open < 0) break;
      const head = s.slice(k, open).trim();
      const close = (() => { let d = 0; for (let j = open; j < s.length; j++) { if (s[j] === "{") d++; else if (s[j] === "}") { d--; if (d === 0) return j; } } throw new Error("unbalanced"); })();
      const body = s.slice(open + 1, close);
      if (head.startsWith("@media")) walk(body, head);
      else if (head) out.push({ selectors: head.split(",").map((x) => x.trim()).filter(Boolean), body: body.trim(), media });
      k = close + 1;
    }
  };
  walk(clean, null);
  void i; void readBlock;
  return out;
}

test("style.css has exactly one dashboard v2 block, at the end, and every selector in it is scoped under .dv2 or .dv2-skel", () => {
  assert.equal(css.split(MARK).length - 1, 1, "one block");
  const list = rules(block);
  assert.ok(list.length > 80, `the block has ${list.length} rules`);
  for (const r of list) for (const s of r.selectors) {
    assert.match(s, /^(:root\[data-theme="light"\] )?\.dv2(-skel)?(\b|[ .:#\[])/, `"${s}" could reach the flag-off page`);
  }
  // the part of the stylesheet before the block never mentions the v2 hooks (nothing about v2 leaks into shared rules)
  const before = css.slice(0, css.indexOf(MARK));
  assert.doesNotMatch(before, /\.dv2\b|\.dtab|\.dpanel|\.fcard|\.today__|\.dv2-skel/, "v2 hooks outside the v2 block");
});

test("buttons inside the panels wrap long labels (no horizontal scroll at 390px for an eligible holder); 44px targets", () => {
  const list = rules(block);
  const wrap = list.find((r) => r.selectors.includes(".dv2 .dpanel .btn"));
  assert.ok(wrap, "the .dv2 .dpanel .btn rule");
  assert.match(wrap.body, /white-space:\s*normal/);
  assert.match(wrap.body, /max-width:\s*100%/);
  assert.match(css, /^\.btn \{[^}]*white-space: nowrap;/m, "the site's own button still never wraps (flag-off unchanged)");
  const tab = list.find((r) => r.selectors.includes(".dv2 .dtab") && /min-height/.test(r.body));
  assert.match(tab.body, /min-height:\s*44px/);
  const sm = list.find((r) => r.selectors.includes(".dv2 .btn--sm"));
  assert.match(sm.body, /min-height:\s*44px/);
  // the older cards' controls reach 44px inside the panels too (measured at 15 to 38px before)
  for (const sel of [".dv2 .seg button", ".dv2 .chips button", ".dv2 .link-btn", ".dv2 .swapbox__amt", ".dv2 .field"]) {
    const r = list.find((x) => x.selectors.includes(sel));
    assert.ok(r && /min-height:\s*44px/.test(r.body), `${sel} reaches 44px`);
  }
  const flip = list.find((x) => x.selectors.includes(".dv2 .swapbox__flip"));
  assert.match(flip.body, /width:\s*44px; height:\s*44px/); assert.ok(flip.selectors.includes(".dv2 .post__vote button"), "the vote arrow too");
  const tiny = list.find((x) => x.selectors.includes(".dv2 .link-btn--tiny"));
  assert.match(tiny.body, /padding:\s*15px 10px; margin:\s*-15px -10px/, "the tiny links grow their hit area without moving the pass's row");
  // the coin studio's six colour swatches: the label is the control (its radio is hidden) and measured 34 x 34px, the one target left
  // under 44px in the panels; inside them the label grows to 44px around the same 34px circle
  const sw = list.find((x) => x.selectors.includes(".dv2 .swatches label"));
  assert.ok(sw, "the .dv2 .swatches label rule");
  assert.match(sw.body, /display:\s*grid/); assert.match(sw.body, /min-width:\s*44px; min-height:\s*44px/);
  assert.match(css, /^\.swatch \{ display: block; width: 34px; height: 34px;/m, "the circle itself keeps its size (flag-off unchanged)");
});

test("the sticky strip and the router agree on the header height, and the deep-link highlight exists", () => {
  const strip = rules(block).find((r) => r.selectors.includes(".dv2 .dtabs") && /position:\s*sticky/.test(r.body));
  const top = Number(strip.body.match(/top:\s*(\d+)px/)[1]);
  const header = Number(v2.match(/const HEADER = (\d+);/)[1]);
  assert.equal(top, header, "style.css sticky top and dashboard-v2.js HEADER");
  assert.ok(rules(block).some((r) => r.selectors.includes(".dv2 .is-target")), ".is-target highlight");
});

test("a Moderate deep link waits for /api/mod only until the person picks another tab", () => {
  assert.match(v2, /if \(tab === "moderate" && !modOn\(\)\) \{ pending = "moderate"; tab = "home"; push = false; replace = true; \}[^\n]*\n\s*else if \(push\) pending = null;/);
});
