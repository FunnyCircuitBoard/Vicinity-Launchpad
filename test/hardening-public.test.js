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
