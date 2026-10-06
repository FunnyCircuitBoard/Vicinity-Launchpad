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
  // every place that decides "mine" uses it: the map's status of a city (areas, markers, chips, the city-in-focus card all ask statusOf),
  // the list and the panel. Three calls since the map's layers share statusOf (6 Oct 2026); four before, one per layer.
  assert.equal((js.match(/isMine\(/g) || []).length, 3, "statusOf, the list, the panel");
  assert.ok(js.includes('const statusOf = (c) => { const cl = claims.get(c.id); return cl ? (isMine(cl) ? "mine" : "founded")'), "the map's status of a city");
  assert.ok(js.includes("mine = isMine(cl), parent = parts.has(c.id)") && js.includes("[...claims.entries()].find(([, v]) => isMine(v))"), "the list and the panel");
  assert.doesNotMatch(js, /\.wallet === me\(\)(?!\s*\|\|)/, "no other comparison with the signed-in wallet");
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

/* ---------------- launchpad: which snapshot is "the" snapshot ---------------- */

test("launchpad: the admin console's one-click test snapshot (root 'admin-manual', no holders) is never shown as the Founding Supporter list", () => {
  const js = read("launchpad.js");
  assert.match(js, /\.find\(\(s\) => s\.status !== "cancelled" && s\.merkleRoot !== "admin-manual" && s\.holders > 0\)/);
  // the admin route really does write that marker, so the filter matches reality
  const admin = readFileSync(new URL("../src/admin.js", import.meta.url), "utf8");
  assert.match(admin, /'admin-manual'/);
  // and the public answer carries the two fields the filter reads
  const snap = readFileSync(new URL("../src/snapshot.js", import.meta.url), "utf8");
  assert.match(snap, /holders: s\.holders/);
  assert.match(snap, /merkleRoot: s\.merkle_root/);
});

/* ---------------- wallets: late-injecting in-app wallets ---------------- */

test("wallets: the installed-wallet scan runs again when the tab comes back and when a wallet announces itself late, so in-app browsers do not need a reload", () => {
  const js = read("wallets.js");
  assert.match(js, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(!document\.hidden\) scanLegacy\(\); \}\);/);
  assert.match(js, /window\.addEventListener\("wallet-standard:register-wallet", \(e\) => \{ try \{ e\.detail\(\{ register \}\); \} catch \{\} scanLegacy\(\); \}\);/);
  assert.ok(js.includes("rescan: scanLegacy"), "pages can still ask for a scan themselves");
  assert.ok(js.includes("setTimeout(scanLegacy, 350)"), "the first scans are unchanged");
});

/* ---------------- dashboard: the trade panel tells the truth, the admin's decision names the address ---------------- */

test("dashboard trade panel: '● Live' only once both prices are known, the estimate is called a price ratio, no Raydium button on the swap route", () => {
  const js = read("dashboard.js");
  const panel = js.slice(js.indexOf("function renderTrade()"), js.indexOf('$("#tr-amt").addEventListener'));
  // the state is set to "Listed · no price yet" when the contract exists, and flips to Live only in estimate(), after /api/prices answered
  assert.ok(!/missing \?[^\n]*: "● Live"/.test(panel), "a recorded contract alone is not 'Live'");
  assert.ok(panel.includes('"Listed · no price yet"'));
  const est = panel.slice(panel.indexOf("async function estimate()"));
  assert.ok(est.indexOf("if (!pa || !pb)") < est.indexOf('state.textContent = "● Live"'), "Live comes after both prices are there");
  assert.ok(est.includes('state.className = "tag tag--ok"; state.textContent = "● Live"'));
  assert.ok(est.includes('state.textContent = "Listed · no price yet"; return;'), "no price: back to Listed");
  assert.ok(panel.includes("Price ratio, not a quote. Slippage and fees are set in your wallet."));
  assert.ok(!panel.includes("Estimates use live prices"), "the old wording is gone");
  assert.ok(panel.includes("You sign every swap in your own wallet on Jupiter or Raydium; Vicinity never touches your funds."), "the safety sentence stays");
  assert.ok(panel.includes('go2.hidden = route === "swap";'), "no Raydium button for city coin <-> $VICINITY: no direct pool is known");
  assert.ok(!panel.includes("raydium.io/swap/"), "no link to a Raydium pair page that would be empty");
  assert.ok(panel.includes("https://raydium.io/launchpad/token/?mint="), "the LaunchLab page stays for $VICINITY and the city coin");
  assert.ok(panel.includes("https://jup.ag/swap/"), "Jupiter stays the primary button");
});

test("dashboard admin queue: the decision sent to /api/coins/mint/decide carries the address the admin looked at", () => {
  const js = read("dashboard.js");
  assert.ok(js.includes('api("/api/coins/mint/decide", { city: w.city, mint: w.pendingMint, approve, note })'));
  assert.ok(js.includes("link.href = `https://solscan.io/token/${w.pendingMint}`"), "it is the same address the Solscan link opened");
});
