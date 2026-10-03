// Launch-week hardening, the pages: what public/*.js prints and promises. These pin the few lines that matter, the way
// test/site.test.js does; the pages are built from scripts/pages and keep passing that file's checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* ---------------- the map: founders' wallets ---------------- */

test("map: founder lines show the masked wallet as text and link nobody's wallet to a block explorer", () => {
  const js = read("cities.js");
  assert.ok(!js.includes("solscan(cl.wallet)") && !js.includes("solscan(c.wallet)"), "no Solscan link on a founder's wallet");
  assert.ok(js.includes("walletText(cl.wallet)") && js.includes("walletText(c.wallet)"), "the masked text stays in the same place");
  assert.ok(js.includes("wallet: s.wallet"), "the map still takes the wallet from /api/seats (masked there)");
  // "Yours" still works although the seat's wallet is masked: the comparison is on the masked forms
  assert.match(js, /const isMine = \(cl\) => Boolean\(cl && me\(\) && \(cl\.wallet === me\(\) \|\| cl\.wallet === mask\(me\(\)\)\)\);/);
  assert.equal((js.match(/isMine\(/g) || []).length, 4, "every place that decided 'mine' by the raw wallet uses it (areas, markers, the list, the panel)");
  assert.ok(!/cl\.wallet === me\(\)(?!\s*\|\|)/.test(js.replace(/const isMine[^\n]*\n/, "")), "no raw comparison left");
  assert.ok(!js.includes("mask(cl.wallet)"), "the wallet is not masked twice");
});

/* ---------------- token page: "Team wallets public" ---------------- */

test("token page: the team-wallet proof says how many are listed, from the official list, instead of 'Listed at launch' forever", () => {
  const js = read("token.js"), h = read("token.html");
  assert.match(h, /<span class="proof__live" id="team-count">/);
  assert.ok(js.includes('$("#team-count")'), "the page fills it");
  assert.ok(js.includes("o.teamWallets.length"), "from /api/official teamWallets");
  assert.ok(js.includes('"No team wallets yet"'), "an empty list is said plainly");
  assert.ok(js.includes("listed`"), "N wallets listed");
  assert.match(js, /official\.then\(renderTeamCount/, "waits for the /api/official answer site.js already fetches");
  assert.ok(js.includes("renderTeamCount(null)"), "a failed fetch still replaces the placeholder");
  const src = readFileSync(new URL("../src/official.js", import.meta.url), "utf8");
  assert.match(src, /teamWallets: \[/, "the list the page counts is the one the checker uses");
});
