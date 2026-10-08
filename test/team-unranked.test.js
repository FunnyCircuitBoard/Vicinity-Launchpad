// The owner's decision (8 Oct 2026): a published team wallet (src/official.js OFFICIAL.teamWallets) is shown and labelled
// "Team wallet (public)" in the holder list, but never ranked, exactly like pools and bonding curves. The people below it move up
// a rank, "of N holders" and every other count of people leave it out, and nothing that ranks people (the rank check, /api/me's
// position, badges and community boards, profiles) treats it as one of them.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, browser, chain, newWorld, person, realClock, setHolding, tick, useClock } from "./helpers/world.js";
import { PF, quick } from "./helpers/profiles.js";
import { CITY_COIN, LP, dexMock, seedCoin } from "./helpers/launchpad.js";
import { _resetLaunchpad } from "../src/launchpad.js";
import { OFFICIAL } from "../src/official.js";
import { _resetSnapshots, getTopHolders, holderSnapshot, isOnCurve, isTeamWallet, rankOf } from "../src/chain.js";
import { ensureProfilesSchema } from "../src/store.js";
import { base58Encode } from "../src/solana.js";
import { randomBytes } from "node:crypto";

// people's wallets are points on the curve (an off-curve owner is a program's account, listed as a pool)
const key = (onCurve) => { for (;;) { const b = randomBytes(32); if (isOnCurve(b) === onCurve) return base58Encode(b); } };
const TEAM = OFFICIAL.teamWallets[0], POOL = key(false), A = key(true), B = key(true), C = key(true);

let env;
beforeEach(() => { useClock("2026-10-08T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
after(() => realClock());

/** The live picture of 8 Oct, in small: the team wallet is the biggest holder, then a pool, then three people. */
function holders() {
  setHolding(TEAM, 5_000_000); setHolding(POOL, 3_000_000);
  setHolding(A, 1_000); setHolding(B, 500); setHolding(C, 10);
}
/** Make a member's wallet a published team wallet for one test (the real one's key is the owner's), and put the list back after. */
async function asTeam(address, fn) {
  OFFICIAL.teamWallets.push(address); _resetSnapshots();
  try { return await fn(); } finally { OFFICIAL.teamWallets.splice(OFFICIAL.teamWallets.indexOf(address), 1); _resetSnapshots(); }
}

test("the holder snapshot: the team wallet is listed and labelled but has no rank; people are ranked 1, 2, 3 under it and only they are counted", async () => {
  holders();
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(snap.rows.map((r) => [r.owner, r.rank, r.label]), [
    [TEAM, null, "Team wallet (public)"],
    [POOL, null, "Pool or program account"],
    [A, 1, null], [B, 2, null], [C, 3, null],
  ]);
  assert.equal(snap.people, 3, "of 3 holders: neither the pool nor the team wallet is a person");
  assert.equal(snap.rows.length, 5, "both are still in the list");
  assert.ok(isTeamWallet(TEAM) && !isTeamWallet(A));
});

test("rankOf a team wallet: what it holds and its share, but no rank, no percentile, no wallet to pass; the new #1 passes nobody", async () => {
  holders();
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(rankOf(snap, TEAM), { amount: 5_000_000, rank: null, total: 3, label: "Team wallet (public)", percent: 0.5, percentile: null, next: null, team: true });
  const first = rankOf(snap, A);
  assert.deepEqual([first.rank, first.total, first.next, first.team], [1, 3, null, false], "#1 of 3: the team wallet above it is not a wallet to pass");
  assert.ok(Math.abs(first.percentile - 100 / 3) < 1e-9);
  assert.deepEqual(rankOf(snap, B).next, { rank: 1, amount: 1_000, gap: 500 }, "#2 passes #1, a person");
  assert.deepEqual(rankOf(snap, "NobodyHoldsThis1111111111111111111111111111").next, { rank: 3, amount: 10, gap: 10 }, "any amount enters after the last person, as before");
  // a team wallet that holds nothing at the moment is still a team wallet: no "any amount enters at #4" for it
  setHolding(TEAM, 0);
  const empty = rankOf(await holderSnapshot(env, MINT, chain()), TEAM);
  assert.deepEqual([empty.amount, empty.rank, empty.next, empty.team], [0, null, null, true]);
});

test("/api/holders and /api/rank: the team wallet's row has no rank, the total counts people only; the rank check says it is a team wallet", async () => {
  holders();
  const b = browser(env);
  const list = await b.get("/api/holders");
  assert.deepEqual([list.total, list.count], [3, 5]);
  assert.deepEqual(list.holders.map((h) => h.rank), [null, null, 1, 2, 3], "today's #2 is #1");
  assert.equal(list.holders[0].label, "Team wallet (public)");
  const team = await b.get(`/api/rank?address=${TEAM}`);
  assert.deepEqual([team.rank, team.total, team.team, team.next, team.percentile, team.amount, team.label], [null, 3, true, null, null, 5_000_000, "Team wallet (public)"]);
  const top = await b.get(`/api/rank?address=${A}`);
  assert.deepEqual([top.rank, top.total, top.team], [1, 3, false]);
  // the RPC refuses the full list: the balance alone still says it is a team wallet
  const noList = (url, init) => (JSON.parse(init.body).method === "getProgramAccounts"
    ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32010, message: "excluded" } })) : chain()(url, init));
  _resetSnapshots();
  const slow = await (await b.send(`/api/rank?address=${TEAM}`, { fetchImpl: noList })).json();
  assert.deepEqual([slow.full, slow.amount, slow.rank, slow.team], [false, 5_000_000, null, true]);
  _resetSnapshots();
  assert.equal((await (await b.send(`/api/rank?address=${A}`, { fetchImpl: noList })).json()).team, false);
});

test("the top-20 fallback (an RPC that cannot list every holder) ranks the same way: team wallets and pools listed, people ranked", async () => {
  const CURVE = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  const rpc = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getAccountInfo") return ok({ value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } });
    if (method === "getTokenLargestAccounts") return ok({ value: [["accTeam", "500000000000000"], ["accCurve", "300000000000000"], ["accA", "1000000000"], ["accB", "500000000"]].map(([address, amount]) => ({ address, amount, decimals: 6 })) });
    if (method === "getMultipleAccounts") {
      if (params[0][0] === "accTeam") return ok({ value: [TEAM, CURVE, A, B].map((owner) => ({ data: { parsed: { info: { owner } } } })) });
      return ok({ value: params[0].map((k) => ({ owner: k === CURVE ? "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" : "11111111111111111111111111111111" })) });
    }
    throw new Error("unexpected " + method);
  };
  const { holders: top } = await getTopHolders({}, MINT, rpc);
  assert.deepEqual(top.map((h) => [h.owner, h.rank, h.label]), [[TEAM, null, "Team wallet (public)"], [CURVE, null, "Raydium LaunchLab curve"], [A, 1, null], [B, 2, null]]);
});

test("/api/me for a member whose wallet is a team wallet: no rank, no Top 10 / Top 100, no 'balance dropped' notice, not on the city's board", async () => {
  holders();
  const owner = await person(env, { home: IN_UTICA, holds: 9_000_000 }); // the biggest holder of all
  const local = await person(env, { home: IN_UTICA, holds: 2_000 });
  await env.DB.prepare("UPDATE users SET badges = ? WHERE wallet = ?").bind(JSON.stringify(["early", "verified", "local", "holder", "top100", "top10"]), owner.w.address).run();
  await asTeam(owner.w.address, async () => {
    const me = await owner.get("/api/me");
    assert.deepEqual([me.holding.amount, me.holding.rank, me.holding.total, me.holding.next, me.holding.team], [9_000_000, null, 4, null, true]);
    const earned = (id) => me.badges.find((b) => b.id === id).earned;
    assert.deepEqual([earned("top10"), earned("top100"), earned("holder"), earned("whale")], [false, false, true, false]);
    assert.deepEqual(me.lost, [], "not ranked is not a sale: no 'badges removed after your balance dropped'");
    assert.deepEqual([me.community.rank, me.community.holders], [null, 1], "the city's board counts the one person who holds there");
    assert.match(me.badges.find((b) => b.id === "top100").detail, /pools and team wallets not counted/);
    const other = await local.get("/api/me");
    assert.deepEqual([other.holding.rank, other.holding.total, other.holding.team], [1, 4, false], "the biggest person is #1 of 4 people");
    assert.deepEqual([other.community.rank, other.community.holders], [1, 1]);
    assert.deepEqual(other.community.top.map((x) => x.you), [true], "the team wallet is not on the city's top list");
    assert.equal(other.badges.find((b) => b.id === "top10").earned, true);
  });
  const after = await local.get("/api/me");
  assert.deepEqual([after.holding.rank, after.holding.total], [2, 5], "the same wallet unlisted is a person again: a check that the test changed only the list");
});

test("a city's holder count leaves the team wallet out everywhere: the map's 'Holders' (/api/members), the Launchpad's 'hold $VICINITY' and the dashboard's 'Holders here'", async () => {
  // the 8 Oct review: the dashboard's count left the team wallet's account out, the map's and the Launchpad's still counted it (one apart)
  useClock("2026-10-12T12:00:00Z"); _resetLaunchpad();
  const lp = LP({ VICINITY_MINT: MINT });
  const owner = await person(lp, { home: IN_UTICA, holds: 9_000_000 });
  const local = await person(lp, { home: IN_UTICA, holds: 2_000 });
  await person(lp, { home: IN_UTICA }); // a member who holds nothing
  await seedCoin(lp.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  await tick(lp); // the balance sample both counts read
  const counts = async () => {
    _resetLaunchpad();
    const map = (await browser(lp).get("/api/members")).communities.find((c) => c.id === "5142056");
    const coin = (await (await browser(lp).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json()).coins.find((c) => c.city.id === "5142056");
    const here = (await local.get("/api/me")).community;
    return { members: [map.members, coin.members.members], holders: [map.holders, coin.members.holders, here.holders] };
  };
  await asTeam(owner.w.address, async () => {
    assert.deepEqual(await counts(), { members: [3, 3], holders: [1, 1, 1] }, "three members; one person holds: the team wallet is a member, not a holder in the count");
  });
  assert.deepEqual(await counts(), { members: [3, 3], holders: [2, 2, 2] }, "the same wallet unlisted is counted again: the test changed only the list");
});

test("a profile of a team wallet: its holdings, no rank, team: true", async () => {
  const pf = PF({ VICINITY_MINT: MINT });
  await ensureProfilesSchema(pf.DB);
  const viewer = await quick(pf, "Alice77"), owner = await quick(pf, "OwnerOz");
  setHolding(owner.w.address, 9_000_000); setHolding(viewer.w.address, 100);
  const noisy = console.error; console.error = () => {}; // the test chain has no prices: the portfolio part says so in the log
  try {
    await asTeam(owner.w.address, async () => {
      const p = (await viewer.get("/api/profile?u=OwnerOz")).profile;
      assert.deepEqual(p.holding, { amount: 9_000_000, rank: null, total: 1, percentile: null, team: true });
      assert.equal(p.badges.find((b) => b.id === "top10").earned, false);
      const me = (await viewer.get("/api/profile?u=Alice77")).profile;
      assert.deepEqual([me.holding.rank, me.holding.total, me.holding.team], [1, 1, false]);
    });
  } finally { console.error = noisy; }
});

test("the pages that show a rank say 'team wallet' where a team wallet has none, and every count of people says what it leaves out", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
  const dash = read("dashboard.js"), v2 = read("dashboard-v2.js"), prof = read("profile.js"), coin = read("coin.js"), lp = read("launchpad.js");
  assert.ok(dash.includes('h.team ? "team wallet, not ranked" : h.amount > 0 ? "ranking…"'), "the dashboard's rank tile: not 'ranking…' forever");
  assert.ok(v2.includes('(h.team ? "team wallet, not ranked" : h.amount > 0 ? "ranking…" : "not holding yet")'), "Rankings tab: the global, country and city tiles");
  assert.ok(v2.includes("Ranks count people, not pools, program accounts or team wallets."));
  assert.equal((prof.match(/h && h\.team \? "Team wallet" : "—"/g) || []).length, 2, "a profile's Rank, drawn and refreshed");
  assert.ok(coin.includes('x.rank ? `#${x.rank}` : /^Team wallet/.test(str(x.label)) ? "Team" : "Pool"'), "the coin page's top five");
  assert.ok(lp.includes('"Counted by vicinity.city (pools and team wallets excluded)"'));
  assert.ok(dash.includes('else if (h.team) t.textContent = `${fmt(h.amount)} $VICINITY · team wallet, not ranked`;'), "the first visit's 'Your position among all holders'");
  // the rules page's count is every holding wallet (the balance sample's list.length): it says so, and is not read as people
  assert.ok(read("rules.js").includes("${fmt(h.lastSample.holders)} holding wallets, pools and team wallets included)"));
  const { badgesFor } = await import("../src/me.js");
  const details = Object.fromEntries(badgesFor({ u: {}, launched: true, amount: 0, position: null }).map((b) => [b.id, b.detail]));
  assert.deepEqual([details.top10, details.top100], ["One of the 10 biggest holders (pools and team wallets not counted).", "One of the 100 biggest holders (pools and team wallets not counted)."]);
});
