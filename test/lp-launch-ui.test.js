// "Launch your city coin" in the dashboard and "Move to the open market" on the coin page (public/lp-launch.js), in the built pages:
// nothing at all while the launchpad's settings are off (the probe answers 404); the card's states from a stand-in /api (not
// approved, a pair that is not SOL, expired, paused, a wrong wallet, approved with the fee split, the expiry and the cost, the
// exact first-buy quote as the founder types, the launch: the page builds with a one-time key, shows the summary, the wallet signs,
// the coin is recorded, then "Your coin is live" with its page and the explorer; the founder's fees); the coin page's graduation
// (sign in first; then two one-time keys) and its last step. textContent only, no inline script. Runs the real scripts in the
// just-enough DOM of test/helpers/pagedom.js with a stand-in window.LP and wallet; real Chromium checks the looks.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { newEvent, openPage } from "./helpers/pagedom.js";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const LP_LAUNCH = read("public/lp-launch.js"), CSS = read("public/lp-launch.css");
const DASH = read("public/dashboard.html"), COIN = read("public/coin.html");
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));
const WALLET = "F0under1111111111111111111111111111111111111", MINT = "M1nt1111111111111111111111111111111111111111";

/** pure helpers, in node */
function pure() {
  const ctx = vm.createContext({ console });
  vm.runInContext(LP_LAUNCH, ctx, { filename: "public/lp-launch.js" });
  return ctx.LPLaunch.pure;
}
const READY = {
  ok: true, cluster: "mainnet", chain: "solana:mainnet", cityId: "5142056", city: { id: "5142056", name: "Utica", country: "US" }, wallet: WALLET, ticker: "UTICA", state: "ready",
  coin: { name: "Utica Coin", symbol: "UTICA", pair: "SOL" },
  fees: { totalPct: 1.25, meteoraPct: 0.25, vicinityPct: 0.5, holdersPct: 0.25, founderPct: 0.25, words: "Every trade pays 1.25%: Meteora 0.25%, Vicinity 0.5%, the coin's holders 0.25%, and you, the founder, 0.25%." },
  cost: { approxLamports: 82000000, words: "About 0.082 SOL from your wallet: the 0.05 SOL launch fee and the rent of the coin's accounts. The exact amount is shown before your wallet opens." },
  firstBuy: { maxLamports: "10000000000", allowed: true, reason: null },
  approval: { founder: WALLET, expiresAt: "2026-10-27T12:00:00.000Z", secondsLeft: 7 * 86400, dbcConfig: "Cfg" },
};
const LAUNCHED = { ...READY, state: "launched", mint: MINT, coinPage: `/coin?mint=${MINT}`, explorer: `https://solscan.io/token/${MINT}`, yours: true,
  founderFees: { inVaultLamports: "1000000", onCurveLamports: "234000", totalLamports: "1234000", words: "0.001234 SOL waiting for you" } };

/**
 * A built page with site.js, a stand-in window.LP and wallet, then lp-launch.js. `answers[path]` (the path without its query) is
 * what each API call returns (a function gets (body, url)); `probe` is the answer of GET /api/lp/launch/status without a city.
 */
async function open(file, { answers = {}, probe = { ok: true, on: true, cluster: "mainnet" }, wallets = null, me = { signedIn: true, user: { wallet: WALLET } }, lp = {} } = {}) {
  const page = await openPage(file, { agreed: "2026-10-01" });
  const win = page.window;
  win.setTimeout = (fn) => { setImmediate(fn); return 0; };
  win.clearTimeout = () => {};
  win.location = { href: `https://vicinity.city/${file}`, pathname: "/coin", search: `?mint=${MINT}` };
  const calls = [], prepared = [], toasts = [];
  win.fetch = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: String(path), body: body ?? null });
    const p = String(path).split("?")[0];
    let a;
    if (p === "/api/lp/launch/status" && !String(path).includes("city=")) a = probe === null ? { ok: false, error: "not_enabled", _code: 404 } : probe;
    else if (p.startsWith("/api/me")) a = me;
    else a = answers[p];
    if (typeof a === "function") a = a(body, String(path));
    const status = a && a._code ? a._code : a && a.ok === false ? 409 : 200;
    return { ok: status < 400, status, json: async () => a || { ok: false, error: "not_found" } };
  };
  const wallet = { name: "Phantom", canSign: true, account: { address: WALLET }, connect: async () => WALLET, signTransaction() {} };
  win.VW = { list: () => (wallets ?? [wallet]), isMobile: false, KNOWN: [{ id: "phantom", open: (u) => `https://phantom.com/ul/browse/${encodeURIComponent(u)}` }] };
  win.LP = {
    supported: async () => lp.supported ?? true,
    say: (code, extra) => (extra && extra.message) || `said:${code}`,
    renderSummary: (el, res) => { el.textContent = `summary of ${res.step}`; },
    prepare: async ({ wallet: w, ephemeral, cluster, build }) => {
      const keys = Array.from({ length: ephemeral }, (_, i) => `Eph${i}`);
      const res = await build(keys);
      prepared.push({ address: w.account.address, ephemeral, cluster, res });
      if (!res || !res.ok) throw Object.assign(new Error(res && res.message ? res.message : "refused"), { code: res && res.error, detail: res });
      return { response: res, keys, sign: async ({ onStatus }) => { onStatus("signing"); if (lp.reject) throw new Error("You cancelled in your wallet. Nothing was sent."); onStatus("done"); return { signature: "Sig111", status: "confirmed", solscan: "https://solscan.io/tx/Sig111" }; } };
    },
  };
  win.V.toast = (m) => toasts.push(m);
  vm.runInContext(LP_LAUNCH, win, { filename: "public/lp-launch.js" });
  const btn = (root, text) => root.querySelectorAll("button").find((b) => b.textContent === text) || null;
  return { ...page, win, calls, prepared, toasts, btn, L: win.LPLaunch };
}
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

test("pure: amounts of SOL, the card's words per state, the graduation box", () => {
  const P = pure();
  assert.deepEqual(plain(P.parseSol("0.5")), { lamports: "500000000" });
  assert.deepEqual(plain(P.parseSol(".25")), { lamports: "250000000" });
  assert.deepEqual(plain(P.parseSol("1,5")), { lamports: "1500000000" });
  assert.deepEqual(plain(P.parseSol("")), { lamports: "0" });
  assert.deepEqual(plain(P.parseSol("10")), { lamports: "10000000000" });
  assert.deepEqual(plain(P.parseSol("10.000000001")), { tooLarge: true });
  for (const bad of ["abc", "-1", "1e3", "0.0000000001", "1.2.3"]) assert.equal(P.parseSol(bad), null, bad);
  assert.equal(P.view({ ok: true, state: "not_approved" }, { pair: "SOL" }).lines[0], "An admin approves your coin on chain first; your pair must be SOL.");
  assert.match(P.view({ ok: true, state: "not_approved" }, { pair: "USDC" }).lines[1], /paired with USDC\. Pick SOL in the coin studio/);
  assert.match(P.view({ ok: true, state: "not_approved" }, null).lines[1], /Design your coin first/);
  assert.deepEqual(plain(P.view(READY).tag), ["Approved", "tag--gold"]);
  assert.equal(P.view(READY).canLaunch, true);
  assert.deepEqual(plain(P.view({ ok: true, state: "expired", message: "Your approval expired (x)." }).lines), ["Your approval expired (x)."]);
  assert.deepEqual(plain(P.view({ ok: true, state: "paused", message: "Launches are paused for now." }).tag), ["Paused", "tag--warn"]);
  assert.deepEqual(plain(P.view({ ok: false, error: "founder_mismatch", message: "This approval is for the wallet X." })), { state: "error", tag: ["Wrong wallet", "tag--warn"], canLaunch: false, lines: ["This approval is for the wallet X."] });
  assert.equal(P.gradView({ ok: true, canMigrate: true, message: "m", cost: { words: "c" } }).action, "migrate");
  assert.equal(P.gradView({ ok: true, canMigrate: false, leftoverDue: true, message: "m" }).action, "leftover");
  assert.deepEqual(plain(P.gradView({ ok: true, stage: "graduated", canMigrate: false, leftoverDue: false })), { action: null, title: null, text: null });
  assert.equal(P.solText("82000000"), "0.082 SOL");
  assert.equal(P.leftText(7 * 86400), "7 days left");
});

test("dark: with the settings off the probe answers 404 and the card stays hidden; nothing else is asked", async () => {
  const p = await open("dashboard.html", { probe: null });
  const card = p.$("#lp-launch");
  assert.equal(card.hidden, true);
  const r = await p.L.founder(card, { cityId: "5142056" });
  assert.deepEqual(plain(r), { on: false });
  assert.equal(card.hidden, true);
  assert.deepEqual(p.calls.map((c) => c.path), ["/api/lp/launch/status"]);
  // the dashboard page carries the gated copy markers: the LaunchLab words only while the gate is off
  assert.match(DASH, /<span data-launchlab-copy>, on Raydium LaunchLab<\/span>/);
  assert.match(DASH, /<details class="coin-launch" data-launchlab-copy>/);
  assert.match(DASH, /<p class="tiny muted" data-lp-only hidden>City coins launch on the Vicinity launchpad paired with SOL for now/);
});

test("not approved, a pair that is not SOL, expired, paused, a wrong wallet: plain words, no Launch button", async () => {
  for (const [st, design, want, tag] of [
    [{ ok: true, state: "not_approved", why: "not_approved", message: "An admin approves your coin on chain first; your pair must be SOL." }, { pair: "SOL" }, /An admin approves your coin on chain first; your pair must be SOL\./, "Not approved yet"],
    [{ ok: true, state: "not_approved", message: "An admin approves your coin on chain first; your pair must be SOL." }, { pair: "USDC" }, /Your design is paired with USDC/, "Not approved yet"],
    [{ ok: true, state: "expired", message: "Your approval expired (2026-10-01T00:00:00.000Z). Ask an admin to approve your coin again." }, { pair: "SOL" }, /Ask an admin to approve your coin again/, "Approval expired"],
    [{ ok: true, state: "paused", message: "Launches are paused for now. Your approval stays; try again later." }, { pair: "SOL" }, /Launches are paused for now/, "Paused"],
    [{ ok: false, error: "founder_mismatch", message: `This approval is for the wallet X; you are signed in with ${WALLET}.` }, { pair: "SOL" }, /This approval is for the wallet X/, "Wrong wallet"],
  ]) {
    const p = await open("dashboard.html", { answers: { "/api/lp/launch/status": { ...st, cluster: "mainnet" } } });
    const card = p.$("#lp-launch");
    const r = await p.L.founder(card, { cityId: "5142056", design });
    assert.equal(card.hidden, false);
    assert.match(text(card.querySelector("[data-lp-body]")), want);
    assert.equal(text(card.querySelector("[data-lp-state]")), tag);
    assert.equal(p.btn(card, "Launch $UTICA"), null);
    assert.equal(r.state, st.ok ? st.state : "error");
    assert.equal(text(card.querySelector("[data-lp-net]")), "Solana MAINNET: real SOL", "the red mainnet line");
    assert.match(p.calls[1].path, /^\/api\/lp\/launch\/status\?city=5142056&cluster=mainnet$/, "the status names the cluster the probe said");
  }
});

test("approved: the coin, the fee split, the expiry, the cost; the exact first-buy quote as the founder types", async () => {
  const p = await open("dashboard.html", { answers: { "/api/lp/launch/status": (b, url) => (url.includes("buy=") ? { ...READY, quote: { amountInLamports: "500000000", coinsOutUi: "12345678.123456", coinsOut: "12345678123456", minOut: "1" } } : READY) } });
  const card = p.$("#lp-launch");
  assert.deepEqual(plain(await p.L.founder(card, { cityId: "5142056", design: { pair: "SOL" } })), { on: true, state: "ready" });
  const body = text(card.querySelector("[data-lp-body]"));
  assert.match(body, /Utica Coin \$UTICA · paired with SOL/);
  assert.match(body, /Fees on every trade.*Meteora 0\.25%, Vicinity 0\.5%, the coin's holders 0\.25%, and you, the founder, 0\.25%/);
  assert.match(body, /Approved until.*Oct 27, 2026.*\(7 days left\)/);
  assert.match(body, /What it costs you.*About 0\.082 SOL/);
  assert.equal(text(card.querySelector("[data-lp-state]")), "Approved");
  const input = card.querySelector("input");
  assert.equal(input.getAttribute("inputmode"), "decimal");
  input.value = "0.5"; input.dispatchEvent(newEvent("input"));
  await tick();
  assert.match(p.calls.at(-1).path, /buy=500000000&slippageBps=50$/);
  assert.match(text(card.querySelector(".lp-quote")), /You get exactly 12,345,678\.12 \$UTICA for 0\.5 SOL/);
  input.value = "11"; input.dispatchEvent(newEvent("input"));
  await tick();
  assert.equal(text(card.querySelector(".lp-quote")), "The first buy is at most 10 SOL.");
  input.value = "lots"; input.dispatchEvent(newEvent("input"));
  await tick();
  assert.equal(text(card.querySelector(".lp-quote")), "Type an amount of SOL, like 0.5.");
  // no speed table: the first buy is not offered, and the page says why
  const q = await open("dashboard.html", { answers: { "/api/lp/launch/status": { ...READY, firstBuy: { allowed: false, reason: "A first buy in the same transaction needs the site's speed table, which is not set yet. Launch first, then buy on your coin's page." } } } });
  await q.L.founder(q.$("#lp-launch"), { cityId: "5142056" });
  assert.equal(q.$("#lp-launch").querySelector("input"), null);
  assert.match(text(q.$("#lp-launch")), /Launch first, then buy on your coin's page/);
});

test("the launch: a one-time key, the summary before the wallet, then recorded and 'Your coin is live' with its page and the explorer", async () => {
  let launched = false;
  const p = await open("dashboard.html", {
    answers: {
      "/api/lp/launch/status": () => (launched ? LAUNCHED : READY),
      "/api/lp/launch/tx": (b) => ({ ok: true, step: "launch", cluster: "mainnet", tx: "AA==", mint: b.mint, record: { cityId: "5142056" } }),
      "/api/lp/record": () => { launched = true; return { ok: true, recorded: true, mint: MINT }; },
    },
  });
  const card = p.$("#lp-launch");
  const changes = [];
  await p.L.founder(card, { cityId: "5142056", onChange: (r) => changes.push(plain(r)) });
  const input = card.querySelector("input");
  input.value = "0.25"; input.dispatchEvent(newEvent("input"));
  await tick();
  p.btn(card, "Launch $UTICA").click();
  await tick();
  assert.equal(p.prepared.length, 1);
  assert.deepEqual([p.prepared[0].address, p.prepared[0].ephemeral, p.prepared[0].cluster], [WALLET, 1, "mainnet"], "the session's wallet signs; one one-time key: the coin's address");
  const built = p.calls.find((c) => c.path === "/api/lp/launch/tx");
  assert.deepEqual(built.body, { cityId: "5142056", cluster: "mainnet", mint: "Eph0", firstBuyLamports: "250000000", slippageBps: 50 });
  assert.match(text(card), /summary of launch/, "what will be signed, before the wallet opens");
  p.btn(card, "Approve the launch in your wallet").click();
  await tick(40);
  assert.deepEqual(p.calls.filter((c) => c.path === "/api/lp/record").map((c) => c.body), [{ cityId: "5142056" }]);
  assert.match(text(card), /Your coin \$UTICA is live\./);
  const links = card.querySelectorAll("a").map((a) => [a.textContent, a.getAttribute("href")]);
  assert.deepEqual(links.slice(0, 2), [["Open your coin's page", `/coin?mint=${MINT}`], ["See it on Solscan", `https://solscan.io/token/${MINT}`]]);
  assert.equal(text(card.querySelector("[data-lp-state]")), "● Live");
  assert.deepEqual(changes, [{ on: true, state: "launched" }], "the dashboard hears it (the coin card refreshes)");
  assert.deepEqual(p.toasts, ["$UTICA is live"]);
});

test("the wallet cancels: nothing was sent, Launch comes back; no wallet here: plain words (and Phantom's link on a phone)", async () => {
  const p = await open("dashboard.html", { answers: { "/api/lp/launch/status": READY, "/api/lp/launch/tx": { ok: true, step: "launch", cluster: "mainnet", tx: "AA==" } }, lp: { reject: true } });
  const card = p.$("#lp-launch");
  await p.L.founder(card, { cityId: "5142056" });
  p.btn(card, "Launch $UTICA").click();
  await tick();
  p.btn(card, "Approve the launch in your wallet").click();
  await tick();
  assert.match(text(card), /You cancelled in your wallet\. Nothing was sent\./);
  assert.equal(p.calls.some((c) => c.path === "/api/lp/record"), false);
  const n = await open("dashboard.html", { answers: { "/api/lp/launch/status": READY }, wallets: [] });
  n.win.VW.isMobile = true;
  await n.L.founder(n.$("#lp-launch"), { cityId: "5142056" });
  n.btn(n.$("#lp-launch"), "Launch $UTICA").click();
  await tick();
  assert.match(text(n.$("#lp-launch")), /No wallet in this browser\. Open this page in your wallet app \(Phantom\)/);
  assert.match(n.$("#lp-launch").querySelectorAll("a").at(-1).getAttribute("href"), /^https:\/\/phantom\.com\/ul\/browse\//);
  assert.equal(n.prepared.length, 0, "nothing built without a wallet");
  // the Worker refuses: its plain words, and nothing to sign
  const r = await open("dashboard.html", { answers: { "/api/lp/launch/status": READY, "/api/lp/launch/tx": { ok: false, error: "first_buy_too_large", message: "Your launch and your first buy do not fit in one Solana transaction. Launch first, then buy on your coin's page." } } });
  await r.L.founder(r.$("#lp-launch"), { cityId: "5142056" });
  r.btn(r.$("#lp-launch"), "Launch $UTICA").click();
  await tick();
  assert.match(text(r.$("#lp-launch")), /do not fit in one Solana transaction\. Launch first, then buy/);
  assert.equal(r.btn(r.$("#lp-launch"), "Launch $UTICA").hidden, false);
});

test("launched: the founder's fees and Collect (the founder's own wallet; no one-time key)", async () => {
  const p = await open("dashboard.html", { answers: { "/api/lp/launch/status": LAUNCHED, "/api/lp/founder-claim/tx": { ok: true, step: "founder-claim", cluster: "mainnet", tx: "AA==" } } });
  const card = p.$("#lp-launch");
  await p.L.founder(card, { cityId: "5142056" });
  assert.match(text(card), /Your founder fees: 0\.001234 SOL waiting for you/);
  p.btn(card, "Collect your fees").click();
  await tick();
  assert.deepEqual(p.calls.find((c) => c.path === "/api/lp/founder-claim/tx").body, { cityId: "5142056", cluster: "mainnet" });
  assert.equal(p.prepared[0].ephemeral, 0);
  p.btn(card, "Approve in your wallet").click();
  await tick(30);
  assert.deepEqual(p.toasts, ["Fees collected"]);
});

test("the coin page: 'Move to the open market' needs a signed-in wallet; two one-time keys; then the last step", async () => {
  let migrated = false;
  const answers = {
    "/api/lp/graduate/status": () => (migrated ? { ok: true, stage: "graduated", canMigrate: false, leftoverDue: true, message: "One step left: return the coins the curve never sold." }
      : { ok: true, stage: "full", canMigrate: true, leftoverDue: true, message: "The curve is full. Anyone can move the coin to the open market now: a Meteora pool where it trades like any other token.", cost: { words: "About 0.033 SOL of rent, paid by the wallet that does it (you, if you press the button)." } }),
    "/api/lp/graduate/tx": (b) => ({ ok: true, step: b.step, cluster: "mainnet", tx: "AA==" }),
  };
  // signed out: the button explains and links to sign-in
  const out = await open("coin.html", { answers, me: { signedIn: false } });
  const box0 = out.$("#coin-grad");
  await out.L.graduate(box0, { mint: MINT, ticker: "UTICA" });
  assert.equal(box0.hidden, false);
  assert.equal(text(box0.querySelector("[data-lp-grad-title]")), "Move to the open market");
  assert.match(text(box0), /Cost: About 0\.033 SOL of rent, paid by the wallet that does it/);
  out.btn(box0, "Move to the open market").click();
  await tick();
  assert.match(text(box0), /Sign in with your wallet first/);
  assert.equal(box0.querySelectorAll("a").at(-1).getAttribute("href"), `/connect?mode=login&next=${encodeURIComponent(`/coin?mint=${MINT}`)}`);
  assert.equal(out.prepared.length, 0);
  // signed in: two one-time keys, step migrate; then the box shows the leftover step
  answers["/api/lp/graduate/tx"] = (b) => { if (b.step === "migrate") migrated = true; return { ok: true, step: b.step, cluster: "mainnet", tx: "AA==" }; };
  const p = await open("coin.html", { answers });
  const box = p.$("#coin-grad");
  await p.L.graduate(box, { mint: MINT, ticker: "UTICA" });
  p.btn(box, "Move to the open market").click();
  await tick();
  assert.deepEqual(p.calls.find((c) => c.path === "/api/lp/graduate/tx").body, { mint: MINT, cluster: "mainnet", step: "migrate", nft1: "Eph0", nft2: "Eph1" });
  assert.equal(p.prepared[0].ephemeral, 2);
  p.btn(box, "Approve the move in your wallet").click();
  await tick(40);
  assert.equal(text(box.querySelector("[data-lp-grad-title]")), "One step left");
  assert.deepEqual(p.toasts, ["$UTICA is on the open market"]);
  p.btn(box, "Return the unsold coins").click();
  await tick();
  assert.deepEqual(p.calls.filter((c) => c.path === "/api/lp/graduate/tx").at(-1).body, { mint: MINT, cluster: "mainnet", step: "leftover" });
  assert.equal(p.prepared.at(-1).ephemeral, 0);
  // the settings are off: no box at all
  const dark = await open("coin.html", { answers, probe: null });
  await dark.L.graduate(dark.$("#coin-grad"), { mint: MINT });
  assert.equal(dark.$("#coin-grad").hidden, true);
});

test("the pages: the scripts in order, the stylesheet, no inline code; lp-launch.js writes text only and makes no ids", () => {
  for (const html of [DASH, COIN]) {
    assert.match(html, /<script src="\/lp-sign\.js" defer><\/script>\s*<script src="\/lp-launch\.js" defer><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/lp-launch\.css">/);
    assert.doesNotMatch(html, /<script>|<script [^>]*>[^<]+<\/script>|\sstyle="|\son[a-z]+="/i, "no inline script, style or handler");
  }
  assert.match(COIN, /<div class="coin-grad" id="coin-grad" aria-live="polite" hidden>/);
  assert.doesNotMatch(LP_LAUNCH, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\.|setAttribute\(["']style/);
  assert.doesNotMatch(LP_LAUNCH, /\.id\s*=[^=]|setAttribute\(["']id["']/, "no element ids made");
  assert.doesNotMatch(LP_LAUNCH, /localStorage|sessionStorage/, "nothing kept in the browser (the one-time keys live only inside lp-sign.js)");
  assert.doesNotMatch(CSS, /@import|url\(\s*["']?https?:/, "no outside host");
});

/* ---------- the real dashboard (dashboard.js + dashboard-v2.js) with the card ---------- */
function founderMe() {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 2_000_000, rank: 3 });
  const seat = { id: 7, cityId: "5142056", city: "Utica", country: "US", status: "active", since: "2026-10-01T12:00:00Z", appealUntil: null, graceUntil: null, probationUntil: null, threshold: 100000, policy: 5 };
  me.roles.founder = true; me.level = "founder";
  me.founder.seat = seat;
  me.community.seat = { id: 7, status: "active", name: "SwiftHarbor10", wallet: "7Np41*****4K2", since: seat.since, appealUntil: null, graceUntil: null, probationUntil: null, you: true, openObjections: 0, threshold: 100000, policy: 5, cofounders: [], quorum: null };
  return me;
}
const DESIGN = { ok: true, coin: { city: "5142056", cityName: "Utica", country: "US", name: "Utica Coin", pitch: "", pair: "SOL", pairMint: "So11111111111111111111111111111111111111112", color: "gold", logo: null, mint: null, launched: false, waiting: false, by: "SwiftHarbor10", updatedAt: "2026-10-09T12:00:00Z" }, pairs: null, vicinity: null };
async function dashboard({ gate = true, status = { ...READY, wallet: ADDR } } = {}) {
  const lpCalls = [];
  const page = await openDashboard({
    me: founderMe(),
    api: async (path) => {
      if (path.startsWith("/api/lp/")) {
        lpCalls.push(path);
        if (!gate) return { ok: false, error: "not_enabled", _status: 404 };
        return path.includes("city=") ? status : { ok: true, on: true, cluster: "mainnet", configsSet: true, speedTable: true };
      }
      if (path.startsWith("/api/coins")) return DESIGN;
      return undefined;
    },
  });
  page.win.LP = { supported: async () => true, say: (c, x) => (x && x.message) || c, renderSummary() {}, prepare: async () => { throw new Error("not in this test"); } };
  vm.runInContext(LP_LAUNCH, page.win, { filename: "public/lp-launch.js" }); // the built page loads it before dashboard.js; here it joins on the next refresh
  await page.advance(61_000);
  await page.flush(60);
  return { page, lpCalls };
}

test("the dashboard, gate on: the founder's card in the Founder tab, the LaunchLab copy gone, the Founder card and Today point at the launch", async () => {
  const { page, lpCalls } = await dashboard();
  const card = page.$("#lp-launch");
  assert.equal(card.hidden, false);
  assert.equal(card.parentNode.id, "panel-founder", "the tabbed dashboard moved it into the Founder tab");
  assert.match(text(card), /Utica Coin \$UTICA · paired with SOL/);
  assert.deepEqual(lpCalls, ["/api/lp/launch/status", "/api/lp/launch/status?city=5142056&cluster=mainnet"], "the probe once, then the status once (a refresh does not ask again)");
  await page.advance(61_000);
  assert.equal(lpCalls.length, 2);
  for (const e of page.$$("[data-launchlab-copy]")) assert.equal(e.hidden, true, "no Raydium LaunchLab copy and no 'add the contract' field");
  for (const e of page.$$("[data-lp-only]")) assert.equal(e.hidden, false);
  assert.equal(page.text("#fcard-go"), "Launch your city coin");
  assert.match(page.text("#fcard-note"), /Launch it on the Vicinity launchpad: one signature in your wallet/);
  assert.match(page.text("#today-list"), /Launch your city coin/);
  assert.doesNotMatch(page.text("#today-list"), /Add your coin's contract/);
});

test("the dashboard, gate off: the card stays hidden, the LaunchLab path is unchanged, and only the probe was asked", async () => {
  const { page, lpCalls } = await dashboard({ gate: false });
  assert.equal(page.$("#lp-launch").hidden, true);
  assert.deepEqual(lpCalls, ["/api/lp/launch/status"]);
  for (const e of page.$$("[data-launchlab-copy]")) assert.equal(e.hidden, false);
  for (const e of page.$$("[data-lp-only]")) assert.equal(e.hidden, true);
  assert.equal(page.text("#fcard-go"), "Add the contract");
});

test("the coin page's words for a Vicinity launchpad coin: its curve, full (then the move below), graduated to its Meteora pool", () => {
  const ctx = vm.createContext({ console, window: {} });
  ctx.window = ctx;
  vm.runInContext(read("public/coin.js"), ctx, { filename: "public/coin.js" });
  const P = ctx.VCoin.pure;
  const coin = (lpCurve) => ({ ok: true, mint: MINT, coin: { kind: "city", ticker: "UTICA", city: { name: "Utica", country: "US" }, pair: { symbol: "SOL" } }, market: { launchpad: "vicinity", curve: null, lpCurve, sources: {}, missing: {} } });
  const on = P.curveOf(coin({ stage: "curve", symbol: "SOL", raised: 21.25, target: 85, progressPct: 25 }));
  assert.deepEqual([on.pct, on.of, on.graduated, on.full, on.venue], ["25.0%", "21.25 of 85.00 SOL raised", false, false, "Vicinity launchpad"]);
  assert.match(on.text, /moves to a Meteora pool \(the open market\)/);
  const full = P.curveOf(coin({ stage: "full", symbol: "SOL", raised: 85, target: 85, progressPct: 100 }));
  assert.deepEqual([full.pct, full.value, full.full], ["Full", 100, true]);
  assert.match(full.text, /The curve is full: \$UTICA moves to a Meteora pool \(the open market\) next\. Anyone can make the move below/);
  const grad = P.curveOf(coin({ stage: "graduated", symbol: "SOL", raised: 85, target: 85, progressPct: 100 }));
  assert.match(grad.text, /has moved to its Meteora pool/);
  assert.equal(P.onVicinity(coin({ stage: "curve" })), true);
  assert.equal(P.onLaunchLab(coin({ stage: "curve" })), false, "never called a Raydium LaunchLab coin");
  assert.match(P.cityAbout(coin({ stage: "curve" })), /launched by its founder on the Vicinity launchpad, paired with SOL/);
});

test("two wallets in this browser: the founder picks the one they signed in with (or stops)", async () => {
  // like public/wallets.js: connect() remembers the account it was given
  const other = { name: "Solflare", canSign: true, account: null, async connect() { this.account = { address: "0ther111111111111111111111111111111111111111" }; return this.account.address; }, signTransaction() {} };
  const mine = { name: "Phantom", canSign: true, account: null, async connect() { this.account = { address: WALLET }; return WALLET; }, signTransaction() {} };
  const p = await open("dashboard.html", { answers: { "/api/lp/launch/status": READY, "/api/lp/launch/tx": { ok: true, step: "launch", cluster: "mainnet", tx: "AA==" } }, wallets: [other, mine] });
  const card = p.$("#lp-launch");
  await p.L.founder(card, { cityId: "5142056" });
  p.btn(card, "Launch $UTICA").click();
  await tick();
  assert.match(text(card), /Pick the wallet that holds F0un…1111/);
  p.btn(card, "Use Solflare").click();
  await tick();
  assert.match(text(card), /Your wallet is on 0the…1111, but you are signed in with F0un…1111/);
  assert.equal(p.prepared.length, 0);
  p.btn(card, "Launch $UTICA").click();
  await tick();
  p.btn(card, "Use Phantom").click();
  await tick();
  assert.equal(p.prepared[0].address, WALLET);
  assert.match(text(card), /summary of launch/);
});
