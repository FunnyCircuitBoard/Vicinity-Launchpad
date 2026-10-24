// scripts/brand/residual.mjs, the residual "vicinity" report (Citycoin.dev master v5, BR-01, stage S02): report only, it exits 0 and
// prints counts per class (rebrand-inventory.md section 1). It becomes a gate on unclassified labels with BRAND=citycoin in stage S48.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLASSES, SELF, areaOf, classifyToken, scanText } from "../scripts/brand/residual.mjs";

const script = fileURLToPath(new URL("../scripts/brand/residual.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

test("the report exits 0 and prints a count for every class and a total", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const label of ["migrate (labels)", "migrate (URLs)", "compatibility-required", "persistent identifier", "third-party", "history", "developer-only", "Total"])
    assert.match(r.stdout, new RegExp(`^${label.replace(/[()]/g, "\\$&")}\\s+[0-9,]+`, "m"), label);
  assert.match(r.stdout, /report only, exits 0/);
});

test("--json: the class counts add up to the total, and the tracked tree has items in every class", () => {
  const r = run("--json");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(s.classes), [...CLASSES]);
  assert.equal(Object.values(s.classes).reduce((a, c) => a + c.tokens, 0), s.total);
  for (const c of CLASSES) assert.ok(s.classes[c].tokens > 0, `${c} has items`);
  assert.ok(s.binaries >= 2, "the two mainnet release binaries");
  assert.equal(Object.values(s.areas).reduce((a, x) => a + x.total, 0), s.total);
});

test("--list prints path:line, class, rule and token; an unknown class name is reported and still exits 0", () => {
  const r = run("--list", "history");
  assert.equal(r.status, 0);
  const rows = r.stdout.trim().split("\n");
  assert.ok(rows.length > 0 && rows.every((x) => /^[^\t]+:\d+\thistory\t[^\t]+\t.+$/.test(x)));
  assert.ok(!r.stdout.includes(SELF), "the classifier leaves its own rule data out");
  const bad = run("--list", "nonsense");
  assert.equal(bad.status, 0);
  assert.match(bad.stderr, /unknown class "nonsense"/);
});

test("the rules put the inventory's examples in their classes (first matching rule wins)", () => {
  const cls = (path, line) => { const items = scanText(path, line); assert.equal(items.length, 1, `${path}: ${line}`); return items[0].cls; };
  const cases = [
    ["solana/AUDIT.md", "Vicinity launchpad audit", "history"],
    ["migrations/0001_city_claims.sql", "-- vicinity", "history"],
    ["solana/programs/vicinity-launchpad/src/x.rs", "// Vicinity", "persistent-identifier"],
    ["wrangler.jsonc", '  "name": "vicinity-map",', "persistent-identifier"],
    ["src/official.js", "const m = env.VICINITY_MINT;", "persistent-identifier"],
    ["src/seats.js", "await sha256hex(`vicinity-seat|${w.id}`);", "persistent-identifier"],
    ["src/sol/layout.js", '  "METADATA_URI_PREFIX": "https://vicinity.city/coin-meta/",', "persistent-identifier"],
    ["src/admin.js", 'export const PREVIEW_COOKIE = "vicinity_preview_role";', "persistent-identifier"],
    ["public/theme.js", '  const KEY = "vicinity-theme";', "persistent-identifier"],
    ["src/coin.js", '  return { kind: "vicinity" };', "persistent-identifier"],
    ["src/x.js", '  logo: "https://vicinity.city/brand/vicinity-512.png",', "compatibility-required"],
    ["src/x.js", '  uri: "https://vicinity.city/coin-meta/abc.json",', "compatibility-required"],
    ["src/site-config.js", 'export const LEGACY_FORWARD_HOSTS = Object.freeze(["vicinitycity.net"]);', "compatibility-required"],
    ["src/x.js", '  const t = "$VICINITY";', "third-party"],
    ["src/x.js", '  ticker: "VICINITY",', "third-party"],
    ["src/x.js", '  handle: "@VicinityCitySOL",', "third-party"],
    ["src/mail.js", "  const link = `https://vicinity.city/connect`;", "migrate-url"],
    ["src/x.js", "  // Vicinity, in a comment", "developer-only"],
    ["src/x.js", "  window.addEventListener(\"vicinity:theme\", f);", "developer-only"],
    ["src/x.js", "const VICINITY_LAUNCHED = 1;", "developer-only"],
    ["docs/DEPLOY.md", "Deploy Vicinity", "developer-only"],
    ["public/style.css", ".vicinity-badge { color: red }", "developer-only"],
    ["scripts/pages/src/index.html", "<h1>Vicinity</h1>", "migrate-label"],
    ["src/x.js", '  message: "Vicinity never asks for your recovery phrase.",', "migrate-label"],
  ];
  for (const [path, line, want] of cases) assert.equal(cls(path, line), want, `${path}: ${line}`);
  assert.equal(classifyToken({ path: "src/x.js", raw: "Vicinity" }).cls, "migrate-label");
});

test("areas follow the inventory's grouping", () => {
  assert.equal(areaOf("test/api.test.js"), "test/");
  assert.equal(areaOf("public/index.html"), "public/*.html (generated)");
  assert.equal(areaOf("public/site.js"), "public/");
  assert.equal(areaOf("scripts/pages/build.mjs"), "scripts/pages/");
  assert.equal(areaOf("src/index.js"), "src/");
  assert.equal(areaOf("solana/release/mainnet-2026-10-10/BUILD.md"), "solana/ deployed programs, IDL, release");
  assert.equal(areaOf("solana/LAUNCHPAD.md"), "solana/ docs");
  assert.equal(areaOf("countdown/src/index.js"), "countdown/");
  assert.equal(areaOf("wrangler.jsonc"), "repository config");
});
