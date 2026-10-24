// Owner amendment 01 (stage S02A): every main-token consumer reads tokenMint (src/official.js). While MAIN_TOKEN_V5 counts it is the configured
// MAIN_TOKEN_MINT: no $VICINITY fact (its team wallets and lock, its Raydium LaunchLab launch and date, its name and ticker) is ever shown as
// the new token's, $VICINITY is a labelled legacy token with no swap, purchase links exist only once the quote path finds a route, an unset
// or refused mint keeps the switch from counting (today's site exactly: never "not launched", never a 500), and the scheduled job's steps
// read the same mint. The switch counts only with every precondition (src/v5policy.js mainTokenV5); this file stands in for a page build
// made with it (test/helpers/mainswitch.js). The main mint and the links here are clearly fake test fixtures; the owner has supplied none.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as W from "./helpers/world.js";
import { runJobs } from "../src/jobs.js";
import { _resetSwap } from "../src/swap.js";
import { _resetLaunchpad } from "../src/launchpad.js";
import { _resetCoin } from "../src/coin.js";
import { _resetPortfolio } from "../src/portfolio.js";
import { _resetDeploymentCheck } from "../src/maintoken.js";
import { OFFICIAL, VICINITY_LAUNCHED } from "../src/official.js";
import { dayKey, latestBalances, pruneLedger, tenure } from "../src/ledger.js";
import { supportedAssets } from "../src/walletsend.js";
import { allowListedCoins } from "../src/pricehistory.js";
import { getBlob, putBlob } from "../src/blobs.js";
import { ensureSchema } from "../src/store.js";
import { _resetPolicyCheck } from "../src/v5policy.js";
import { ACCEPTED, pagesBuiltWithSwitch } from "./helpers/mainswitch.js";

pagesBuiltWithSwitch();

const FAKE_MINT = "FakeMainTokenMint111111111111111111111111111"; // a clearly fake fixture with a valid key shape
const FAKE_X = "https://x.com/ZqFakeTestX";
const LEGACY = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const [TEAM_WALLET, FOMO_WALLET] = OFFICIAL.teamWallets;
const LOCK = OFFICIAL.teamLocks[0].address;
const H1 = "Hdr1111111111111111111111111111111111111111", H2 = "Hdr2222222222222222222222222222222222222222";
const BASE = { VICINITY_MINT: LEGACY, LAUNCHPAD_V2: "on", SWAP: "on" };
const V5 = { ...BASE, ...ACCEPTED, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: FAKE_X };

/** The test chain, a Jupiter that routes SOL into FAKE_MINT only when `route`, and a log of every mint a holder list was read for. */
function net({ route = false, decimals = null } = {}) {
  const rpc = W.chain(), seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (/(^|\.)jup\.ag$/.test(u.hostname)) {
      if (u.pathname.endsWith("/swap/v1/quote")) {
        return route && u.searchParams.get("outputMint") === FAKE_MINT
          ? json({ inAmount: u.searchParams.get("amount"), outAmount: "123456789", otherAmountThreshold: "122222222", routePlan: [{ swapInfo: { label: "ZqFakeDex" } }], priceImpactPct: "0.01" })
          : json({ error: "Could not find any route", errorCode: "COULD_NOT_FIND_ANY_ROUTE" }, 400);
      }
      return json(u.pathname === "/tokens/v2/search" ? [] : {});
    }
    if (/^launch-(mint|history)-v1\.raydium\.io$/.test(u.host)) return json({ success: true, data: { rows: [] } });
    if (init && typeof init.body === "string" && init.body.startsWith("{")) {
      const b = JSON.parse(init.body);
      if (b.method === "getProgramAccounts") seen.push(b.params[1].filters.find((f) => f.memcmp).memcmp.bytes);
      if (decimals != null && b.method === "getAccountInfo" && b.params[0] === FAKE_MINT)
        return json({ jsonrpc: "2.0", id: b.id, result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals, supply: "5000000000000000000", mintAuthority: null, freezeAuthority: null } } } } } });
    }
    return rpc(url, init);
  };
  return { fetchImpl, seen };
}
const get = async (env, path, fetchImpl = net().fetchImpl) => {
  const { handleApi } = await import("../src/index.js");
  const res = await handleApi(new Request(`https://vicinity.test${path}`), env, fetchImpl, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
};
/** No object that names the new main token carries a $VICINITY fact (its name or ticker, its launch venue or date). */
function noLegacyFactOn(value, where) {
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!node || typeof node !== "object") return;
    if (["mint", "contract", "tokenContract"].some((k) => node[k] === FAKE_MINT)) {
      for (const [k, v] of Object.entries(node)) {
        // `kind: "vicinity"` is the API's name for the site's main token (rebrand-inventory.md P08, pinned by test/persist-guard.test.js),
        // an identifier the pages key on, not a fact shown to anyone
        if (typeof v === "string" && k !== "kind") assert.doesNotMatch(v, /VICINITY|Raydium LaunchLab|LaunchLab/i, `${where} ${path}.${k}: ${v}`);
        if (k === "launchedAt") assert.ok(v == null || !Object.values(VICINITY_LAUNCHED).includes(v), `${where} ${path}.launchedAt is $VICINITY's launch`);
      }
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(value, "");
}

let errors = [];
const realError = console.error;
beforeEach(() => {
  W.useClock("2026-10-24T12:00:00Z");
  _resetSwap(); _resetLaunchpad(); _resetCoin(); _resetPortfolio(); _resetDeploymentCheck(); _resetPolicyCheck();
  errors = []; console.error = (...a) => errors.push(a.map(String).join(" "));
});
afterEach(() => { console.error = realError; W.realClock(); });
const holders = () => { W.setHolding(H1, 2_000_000); W.setHolding(H2, 150_000); W.setHolding(TEAM_WALLET, 5_000_000); W.setHolding(FOMO_WALLET, 4_000_000); W.setHolding(LOCK, 60_000_000); };

test("/api/official: the configured mint is the official token; $VICINITY, its team wallets and its lock are legacy facts only", async () => {
  const env = W.newWorld(V5); holders();
  const { body } = await get(env, "/api/official");
  assert.equal(body.tokenContract, FAKE_MINT);
  assert.deepEqual(body.teamWallets, [], "the published team wallets were listed for $VICINITY");
  assert.deepEqual(body.teamLocks, [], "the 60M Jupiter Lock holds $VICINITY: no lock card for the new token");
  assert.deepEqual(body.socials, ["@ZqFakeTestX"]);
  assert.deepEqual(body.officialLinks, { x: FAKE_X, telegram: null });
  assert.deepEqual(body.tokens[0], { network: "Solana", name: "Main token", symbol: "", contract: FAKE_MINT, platform: null, status: "Configured" },
    "shape-checked, not verified: never \"Live\" on a shape check alone (review finding SEC-8)");
  assert.equal(body.tokens[1].legacy, true);
  assert.equal(body.tokens[1].contract, null, "the legacy row never points at the page's contract card");
  const [legacy] = body.legacyTokens;
  assert.equal(legacy.mint, LEGACY);
  assert.equal(legacy.status, "legacy");
  assert.equal(legacy.swap, false);
  assert.equal(legacy.teamLocks[0].amount, 60_000_000);
  assert.deepEqual(legacy.teamWallets, OFFICIAL.teamWallets);
  noLegacyFactOn(body, "/api/official");
  // the same world with the switch unset: today's answer (no new key), $VICINITY the official token
  const off = (await get(W.newWorld(BASE), "/api/official")).body;
  assert.equal(off.tokenContract, LEGACY);
  assert.deepEqual(off.teamWallets, OFFICIAL.teamWallets);
  assert.ok(!("legacyTokens" in off) && !("officialLinks" in off));
  assert.deepEqual(off.socials, ["@VicinityCitySOL"]);
});

test("unset or refused MAIN_TOKEN_MINT, or a refused v5 configuration, under the switch: every main-token route answers exactly as with it off", async () => {
  // review findings SWON-4 and SEC-4: the switch counts only while both configuration checks accept the deployment; anything else is
  // today's site (never "not launched", never the legacy mint as the new token, never a 500)
  const routes = ["/api/token", "/api/holders", `/api/rank?address=${H1}`, "/api/seats", "/api/policy", "/api/official", "/api/launchpad", `/api/coin?mint=${LEGACY}`, "/api/swap/config",
    `/api/check?q=${LEGACY}`, "/api/check?q=%40VicinityCitySOL"];
  const answers = async (env) => { const out = {}; for (const r of routes) { _resetSwap(); _resetLaunchpad(); _resetCoin(); out[r] = await get(env, r); } return out; };
  W.useClock("2026-10-24T12:00:00Z");
  const offEnv = W.newWorld(BASE); holders();
  const today = await answers(offEnv);
  assert.equal(today["/api/official"].body.tokenContract, LEGACY);
  const cases = [
    ...[undefined, "", LEGACY, "not-a-mint", "11111111111111111111111111111111"].map((mint) => ({ ...BASE, ...ACCEPTED, ...(mint === undefined ? {} : { MAIN_TOKEN_MINT: mint }) })),
    { ...BASE, ...ACCEPTED, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: "https://x.com/VicinityCitySOL" }, // the old account refused as the new link
    { ...BASE, ...ACCEPTED, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_TELEGRAM_URL: "https://t.me/+invite" },
    { ...BASE, MAIN_TOKEN_V5: "on", MAIN_TOKEN_MINT: FAKE_MINT }, // no environment named and the legacy seats not frozen: the v5 check refuses
    { ...BASE, ...ACCEPTED, DEPLOYMENT_ENV: "", MAIN_TOKEN_MINT: FAKE_MINT },
    { ...BASE, ...ACCEPTED, LEGACY_SEATS: "on", MAIN_TOKEN_MINT: FAKE_MINT },
    { ...BASE, ...ACCEPTED, BRAND: "citycoin", MAIN_TOKEN_MINT: FAKE_MINT }, // not the label set the pages were built with
  ];
  for (const extra of cases) {
    W.useClock("2026-10-24T12:00:00Z");
    const env = W.newWorld(extra); holders();
    assert.deepEqual(await answers(env), today, JSON.stringify(extra));
    const offJob = await runJobs(W.newWorld(BASE), Date.now(), net().fetchImpl, () => 0);
    assert.deepEqual(await runJobs(env, Date.now(), net().fetchImpl, () => 0), offJob, `${JSON.stringify(extra)}: the job is today's too`);
  }
});

test("the holder list, ranks and the checker of the new token: no $VICINITY team wallet or lock label; $VICINITY answers as legacy", async () => {
  const env = W.newWorld(V5); holders();
  const list = (await get(env, "/api/holders")).body;
  assert.equal(list.mint, FAKE_MINT);
  assert.ok(list.holders.length >= 4);
  assert.ok(!list.holders.some((h) => /^Team /.test(h.label || "")), "no Team wallet / Team lock label in the new token's list");
  assert.equal(list.holders.find((h) => h.owner === TEAM_WALLET).rank > 0, true, "not set aside as a $VICINITY team wallet");
  const rank = (await get(env, `/api/rank?address=${FOMO_WALLET}`)).body;
  assert.equal(rank.team, false);
  assert.ok(!/Team wallet/.test(rank.label || ""));
  // with the switch off the same holders are labelled as before
  const off = W.newWorld(BASE); holders();
  const offList = (await get(off, "/api/holders")).body;
  assert.equal(offList.holders.find((h) => h.owner === FOMO_WALLET).label, "Team wallet (FOMO)");
  assert.equal(offList.holders.find((h) => h.owner === LOCK).label, "Team lock (Jupiter Lock)");

  const check = async (q) => (await get(env, `/api/check?q=${encodeURIComponent(q)}`)).body;
  assert.deepEqual(await check(FAKE_MINT), { verdict: "official", kind: "contract", message: "This is the official main token contract address." });
  const legacy = await check(LEGACY);
  assert.equal(legacy.verdict, "warning"); assert.equal(legacy.legacy, true); assert.match(legacy.message, /legacy \$VICINITY contract \(history only\)/);
  assert.match((await check("@VicinityCitySOL")).message, /former Vicinity account \(legacy\).*@ZqFakeTestX/);
  assert.equal((await check(FAKE_X)).verdict, "official");
  assert.match((await check(`https://raydium.io/launchpad/token/?mint=${LEGACY}`)).message, /legacy \$VICINITY token/);
  assert.match((await check(LOCK)).message, /for the legacy \$VICINITY token/);
  assert.equal((await check(`https://jup.ag/swap/SOL-${FAKE_MINT}`)).verdict, "official");
});

test("the token page's data, the Launchpad card and the coin page of the new token: its own facts only; purchase links only once a route exists", async () => {
  const env = W.newWorld(V5); holders();
  const token = (await get(env, "/api/token")).body;
  assert.equal(token.launched, true);
  assert.equal(token.facts.mint, FAKE_MINT);
  noLegacyFactOn(token, "/api/token");

  let lp = (await get(env, "/api/launchpad", net({ route: false }).fetchImpl)).body.vicinity;
  assert.equal(lp.mint, FAKE_MINT);
  assert.deepEqual([lp.name, lp.ticker, lp.launchedAt, lp.links], ["Main token", null, null, null], "no route: no purchase link at all");
  noLegacyFactOn(lp, "/api/launchpad");
  let coin = (await get(env, `/api/coin?mint=${FAKE_MINT}`, net({ route: false }).fetchImpl)).body;
  assert.deepEqual([coin.coin.name, coin.coin.ticker, coin.coin.launchedAt], ["Main token", null, null]);
  // no route: its Solscan page only (the coin page's own rule then blanks DEX Screener too while no pool is known)
  assert.deepEqual(Object.entries(coin.links).filter(([, v]) => v), [["solscan", `https://solscan.io/token/${FAKE_MINT}`]], "no route: no purchase link");

  _resetSwap(); _resetLaunchpad(); _resetCoin();
  const routed = net({ route: true }).fetchImpl;
  lp = (await get(env, "/api/launchpad", routed)).body.vicinity;
  assert.deepEqual(lp.links, { jupiter: `https://jup.ag/tokens/${FAKE_MINT}`, dexscreener: `https://dexscreener.com/solana/${FAKE_MINT}`, solscan: `https://solscan.io/token/${FAKE_MINT}`, here: "/token#buy-slot" });
  coin = (await get(env, `/api/coin?mint=${FAKE_MINT}`, routed)).body;
  assert.ok(!("raydium" in coin.links), "never a Raydium LaunchLab address for the new token");
  assert.equal(coin.links.here, "/token#buy-slot");
  noLegacyFactOn(coin, "/api/coin");
  assert.equal((await get(env, `/api/coin?mint=${LEGACY}`, routed)).status, 404);
});

test("the swap's token list: the main token (Buy panel default) only with a route, decimals read from the chain; never a $VICINITY entry", async () => {
  const env = W.newWorld(V5);
  let cfg = (await get(env, "/api/swap/config", net({ route: false, decimals: 9 }).fetchImpl)).body;
  assert.ok(!cfg.tokens.some((t) => t.kind === "vicinity" || t.mint === LEGACY || t.mint === FAKE_MINT), "no route: no default, no Buy");
  _resetSwap();
  cfg = (await get(env, "/api/swap/config", net({ route: true, decimals: 9 }).fetchImpl)).body;
  const main = cfg.tokens.filter((t) => t.kind === "vicinity");
  assert.deepEqual(main, [{ mint: FAKE_MINT, symbol: null, name: "Main token", decimals: 9, kind: "vicinity", stage: "jupiter" }], "decimals from the chain, never the 6 written for $VICINITY");
  assert.ok(!cfg.tokens.some((t) => t.mint === LEGACY));
  // switch off: today's entry
  _resetSwap();
  const off = (await get(W.newWorld(BASE), "/api/swap/config", net({ route: true }).fetchImpl)).body;
  assert.deepEqual(off.tokens.filter((t) => t.kind === "vicinity"), [{ mint: LEGACY, symbol: "VICINITY", name: "Vicinity", decimals: 6, kind: "vicinity", stage: "jupiter" }]);
});

test("Send and the portfolio: the main token by its neutral name, a member's own $VICINITY as a labelled legacy item", async () => {
  const env = W.newWorld(V5);
  await ensureSchema(env.DB);
  const assets = await supportedAssets(env);
  assert.deepEqual(assets.filter((a) => a.kind !== "sol" && a.kind !== "city").map((a) => [a.kind, a.mint, a.label]), [["vicinity", FAKE_MINT, "Main token"], ["legacy", LEGACY, "$VICINITY (legacy)"]]);
  _resetPortfolio();
  const off = W.newWorld(BASE);
  await ensureSchema(off.DB);
  assert.deepEqual((await supportedAssets(off)).filter((a) => a.kind !== "sol").map((a) => [a.kind, a.mint, a.label]), [["vicinity", LEGACY, "$VICINITY"]]);
});

test("a member's dashboard measures the new token; 'Early member' keeps meaning 'joined before $VICINITY launched'", async () => {
  const env = W.newWorld({ ...V5, MAIN_TOKEN_MINT: undefined });
  const p = await W.person(env, { home: W.IN_UTICA, holds: 3_000 });
  let me = await p.get("/api/me");
  assert.equal(me.launched, true, "no main token configured: the switch does not count, so $VICINITY is still the token (today's dashboard)");
  assert.equal(me.badges.find((b) => b.id === "holder").detail, "Hold any $VICINITY.");
  assert.equal(me.badges.find((b) => b.id === "early").earned, false, "VICINITY_MINT is set: $VICINITY had launched when this member joined");
  const env2 = W.newWorld(V5);
  const q = await W.person(env2, { home: W.IN_UTICA, holds: 3_000 });
  me = await q.get("/api/me");
  assert.equal(me.launched, true);
  assert.equal(me.badges.find((b) => b.id === "holder").detail, "Hold any main tokens.");
  assert.match(me.badges.find((b) => b.id === "early").detail, /Joined before \$VICINITY launched/);
});

test("the scheduled job's steps use tokenMint: the sample, the holder counts and the price history read the new mint only, in a series of its own", async () => {
  const env = W.newWorld(V5); holders();
  const { fetchImpl, seen } = net();
  const out = await runJobs(env, Date.now(), fetchImpl, () => 0);
  assert.equal(out.sample.sampled, true);
  assert.ok(seen.length > 0 && seen.every((m) => m === FAKE_MINT), `holder lists read for ${[...new Set(seen)].join(", ")}`);
  const keys = (await env.DB.prepare("SELECT DISTINCT key FROM blobs ORDER BY key").all()).results.map((r) => r.key);
  assert.deepEqual(keys, [`holders:v1:${FAKE_MINT}`, `mday:${FAKE_MINT}:2026-10-24`], "never summed into a $VICINITY day");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM streaks").first()).n, 0, "no legacy founder streak is started from the new token");
  assert.deepEqual((await env.DB.prepare("SELECT mint FROM coin_stats").all()).results.map((r) => r.mint), [FAKE_MINT]);
  assert.deepEqual((await allowListedCoins(env)).map((c) => [c.mint, c.launchedAt]), [[FAKE_MINT, null]]);
  assert.deepEqual(errors.filter((e) => /deployment config/.test(e)), [], "a valid configuration reports nothing");
  // with the switch off the same run is today's: the $VICINITY day and its streaks
  const off = W.newWorld(BASE); holders();
  const o = net();
  await runJobs(off, Date.now(), o.fetchImpl, () => 0);
  assert.ok(o.seen.every((m) => m === LEGACY));
  assert.ok((await off.DB.prepare("SELECT key FROM blobs WHERE key = 'day:2026-10-24'").first()));
  assert.ok((await off.DB.prepare("SELECT COUNT(*) AS n FROM streaks").first()).n > 0);
});

test("the job start runs the configuration check: a named problem is logged once per isolate, the run goes on, and it is today's run", async () => {
  const run = async (extra) => {
    W.useClock("2026-10-24T12:00:00Z");
    const env = W.newWorld({ ...BASE, ...extra }); holders();
    const a = await runJobs(env, Date.now(), net().fetchImpl, () => 0);
    W.advance(3 * 3600_000);
    const b = await runJobs(env, Date.now(), net().fetchImpl, () => 0);
    return [a, b];
  };
  const refused = await run({ ...ACCEPTED, MAIN_TOKEN_MINT: LEGACY });
  assert.deepEqual(errors.filter((e) => /deployment config/.test(e)), ["deployment config refused MAIN_TOKEN_IS_LEGACY_MINT env.MAIN_TOKEN_MINT"]);
  assert.deepEqual(errors.filter((e) => /main token switch/.test(e)), ["main token switch refused MAIN_TOKEN_V5_CONFIG_REFUSED", "main token switch refused MAIN_TOKEN_V5_POLICY_REFUSED"],
    "and why the switch does nothing, once");
  for (const r of refused) assert.equal(r.sample.sampled, true, "the legacy sampler runs as today");
  _resetDeploymentCheck(); _resetPolicyCheck(); errors = [];
  assert.deepEqual(await run({}), refused, "the same runs as with the switch off");
  assert.deepEqual(errors.filter((e) => /deployment config|main token switch/.test(e)), [], "switch off: nothing");
});

test("the balance history under the switch: the new token's own days, no $VICINITY streak counted, old days of its series pruned", async () => {
  const env = W.newWorld(V5);
  await ensureSchema(env.DB);
  assert.equal(dayKey({ VICINITY_MINT: LEGACY }, "2026-10-24"), "day:2026-10-24");
  assert.equal(dayKey(env, "2026-10-24"), `mday:${FAKE_MINT}:2026-10-24`);
  assert.equal(dayKey({ ...BASE, ...ACCEPTED }, "2026-10-24"), "day:2026-10-24", "no main token: the switch does not count, today's series");
  await putBlob(env.DB, "day:2026-10-24", { day: "2026-10-24", n: 1, sums: { [H1]: 9 }, last: { [H1]: 9 }, lastAt: "2026-10-24T01:00:00.000Z", labels: {} });
  assert.equal(await latestBalances(env, Date.now()), null, "a $VICINITY day is never read as the new token's");
  await env.DB.prepare("INSERT INTO streaks (wallet, level, above_since) VALUES (?, ?, ?)").bind(H1, 100000, "2026-09-01T00:00:00.000Z").run();
  assert.equal((await tenure(env, H1, 100000, Date.now())).qualified, false, "a $VICINITY hold streak never counts for the new token");
  assert.equal((await tenure({ ...BASE, DB: env.DB }, H1, 100000, Date.now())).qualified, true, "switch off: the streak counts as before");
  await putBlob(env.DB, `mday:${FAKE_MINT}:2026-08-01`, { n: 1 });
  await putBlob(env.DB, `mday:${FAKE_MINT}:2026-10-20`, { n: 1 });
  await pruneLedger(env, Date.now());
  assert.equal(await getBlob(env.DB, `mday:${FAKE_MINT}:2026-08-01`), null);
  assert.ok(await getBlob(env.DB, `mday:${FAKE_MINT}:2026-10-20`));
  assert.ok(await getBlob(env.DB, "day:2026-10-24"), "the $VICINITY days stay as history");
});
