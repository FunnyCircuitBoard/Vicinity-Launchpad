// The coin page (public/coin.js, the real script in the built page on test/helpers/pagedom.js) for a coin of the Vicinity
// launchpad: while its curve is full nobody can buy or sell it, so no Buy anywhere and no "Live" pill (the curve card says why);
// on the curve and once graduated the Buy opens the in-app swap, and it stays there after the 30-second refresh (a launchpad coin
// has no Raydium link, which used to hide it at the first refresh). Merge review B, minor 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { openPage } from "./helpers/pagedom.js";

const COIN_JS = readFileSync(new URL("../public/coin.js", import.meta.url), "utf8");
const MINT = "M1nt1111111111111111111111111111111111111111";
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const coinAnswer = (stage) => ({
  ok: true, asOf: new Date().toISOString(), mint: MINT,
  coin: { kind: "city", ticker: "UTICA", name: "Utica Coin", city: { name: "Utica", country: "US" }, pair: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" }, color: "gold", logo: null },
  facts: null, holders: null, trades: { rows: [] }, samples: [],
  market: { launchpad: "vicinity", curve: null, lpCurve: { stage, symbol: "SOL", raised: stage === "curve" ? 21.25 : 85, target: 85, progressPct: stage === "curve" ? 25 : 100, pool: MINT }, sources: {}, missing: {} },
  links: { raydium: null, jupiter: stage === "graduated" ? `https://jup.ag/tokens/${MINT}` : null, dexscreener: null, solscan: `https://solscan.io/token/${MINT}`, here: `/coin?mint=${MINT}` },
});

/** The built coin page with the real coin.js; `stage` is what /api/coin answers (a function of the call number may change it). */
async function coinPage({ stage, swap = true }) {
  const page = await openPage("coin.html", { agreed: "2026-10-01" });
  const win = page.window;
  const timers = [];
  win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  win.clearTimeout = () => {};
  win.setInterval = () => 0;
  win.location = { href: `https://vicinity.city/coin?mint=${MINT}`, pathname: "/coin", search: `?mint=${MINT}` };
  win.history = { replaceState() {} };
  win.Intl = Intl;
  let n = 0;
  win.fetch = async (path) => {
    const p = String(path).split("?")[0];
    const body = p === "/api/coin" ? coinAnswer(typeof stage === "function" ? stage(n++) : stage) : p === "/api/official" ? { ok: true, ...(swap ? { swap: true } : {}) } : { ok: false, error: "not_found" };
    return { ok: body.ok !== false, status: body.ok === false ? 404 : 200, json: async () => body };
  };
  win.V.official = Promise.resolve({ ok: true, ...(swap ? { swap: true } : {}) });
  const opened = [];
  win.VSwap = { open: (o) => opened.push(o) };
  const chart = new Proxy({}, { get: () => () => undefined }); // every chart method a no-op (the chart is not what this checks)
  win.VChart = { create: () => chart, pure: { INTERVALS: {} } };
  vm.runInContext(COIN_JS, win, { filename: "public/coin.js" });
  await tick(40);
  const refresh = async () => { const due = timers.splice(0); for (const fn of due) fn(); await tick(40); };
  const buys = () => ["#coin-head-buy", "#coin-buybar-buy", "#coin-mini-buy"].map((id) => page.$(id).hidden);
  const pills = () => page.$$("#coin-pills .coin-pill").map((e) => e.textContent);
  return { page, win, opened, refresh, buys, pills };
}

test("a full launchpad curve: no Buy anywhere and no 'Live' pill; the curve card says nobody can trade it", async () => {
  const p = await coinPage({ stage: "full" });
  assert.deepEqual(p.buys(), [true, true, true], "no Buy in the hero, the phone's bar or the slim header");
  assert.ok(!p.pills().includes("Live"), `pills: ${p.pills().join(" | ")}`);
  assert.ok(p.pills().includes("Curve full · trading paused"));
  assert.match(p.page.$("#coin-curve-text").textContent, /The curve is full: nobody can trade \$UTICA until it moves to a Meteora pool \(the open market\)\./);
  await p.refresh();
  assert.deepEqual(p.buys(), [true, true, true], "still none after the refresh");
});

test("on the curve and once graduated: the Buy opens the in-app swap and is still there after the 30-second refresh", async () => {
  const p = await coinPage({ stage: "curve" });
  assert.deepEqual(p.buys(), [false, false, false]);
  assert.equal(p.pills()[0], "Live");
  await p.refresh();
  assert.deepEqual(p.buys(), [false, false, false], "a launchpad coin has no Raydium link: the refresh used to hide its Buy");
  p.page.$("#coin-head-buy").click();
  assert.deepEqual(p.opened.map((o) => o.out), [MINT]);
  // the curve fills between two refreshes: Buy goes; it moves to the open market: Buy comes back
  const q = await coinPage({ stage: (i) => (i === 0 ? "curve" : i === 1 ? "full" : "graduated") });
  assert.deepEqual(q.buys(), [false, false, false]);
  await q.refresh();
  assert.deepEqual(q.buys(), [true, true, true]);
  await q.refresh();
  assert.deepEqual(q.buys(), [false, false, false]);
  assert.equal(q.pills()[0], "Live");
});

test("with the swap off a full launchpad curve shows no Buy either (it has no Raydium link to fall back on)", async () => {
  const p = await coinPage({ stage: "full", swap: false });
  assert.deepEqual(p.buys(), [true, true, true]);
});
