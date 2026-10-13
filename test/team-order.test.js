// The owner, 13 Oct 2026: "mention the fomo team wallet as fomo in [parenthesis]. Also put all the team wallets on the top after the
// pool and lock". The holder list is put in that order on the server (src/chain.js ranked(), so every page of /api/holders is in it):
// pools and program accounts first, then the team lock, then the team wallets, then people, each group biggest first. Ranks still
// count people in amount order, and percentages, the token page's bars and every rank answer are what they were. The team's FOMO
// account reads "Team wallet (FOMO)" wherever the label shows. Pinned here: the snapshot, /api/holders' pages, the top-20 fallback, a
// copy saved before the change, rankOf and /api/rank, the token page's rows, bars and rank check, and the coin page's top five (the five
// biggest by size, on purpose: see public/coin.js topHolders).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { MINT, browser, chain, clock, newWorld, realClock, setHolding, useClock } from "./helpers/world.js";
import { newEvent } from "./helpers/pagedom.js";
import { tokenPage } from "./helpers/tokenpage.js";
import { OFFICIAL } from "../src/official.js";
import { _forgetServerMemory, getTopHolders, holderSnapshot, isOnCurve, publishHolders, rankOf } from "../src/chain.js";
import { getBlob, putBlob } from "../src/blobs.js";
import { ensureSchema } from "../src/store.js";
import { base58Encode } from "../src/solana.js";

// people's wallets are points on the curve; an off-curve owner is some program's account: the pool, and a second, smaller one
const key = (onCurve) => { for (;;) { const b = randomBytes(32); if (isOnCurve(b) === onCurve) return base58Encode(b); } };
const [OWNER, FOMO] = OFFICIAL.teamWallets, LOCK = OFFICIAL.teamLocks[0].address, POOL = key(false), PROGRAM = key(false);
const LABELS = { [POOL]: "Pool or program account", [PROGRAM]: "Pool or program account", [LOCK]: "Team lock (Jupiter Lock)", [OWNER]: "Team wallet (public)", [FOMO]: "Team wallet (FOMO)" };
const P = Array.from({ length: 9 }, () => key(true)); // the people, biggest first

/**
 * The live picture of 13 Oct 2026, in small: the pool 444.5M, the lock 60M, five people at 31-36M, the owner's wallet 28.5M,
 * more people, the FOMO wallet about 5.8M further down. And a second program account, smaller than everyone but two people.
 */
const PICTURE = [
  [POOL, 444_500_000], [LOCK, 60_000_000],
  [P[0], 36_000_000], [P[1], 35_000_000], [P[2], 33_500_000], [P[3], 32_000_000], [P[4], 31_000_000],
  [OWNER, 28_500_000], [P[5], 20_000_000], [P[6], 9_000_000], [FOMO, 5_812_345], [PROGRAM, 2_000_000], [P[7], 1_000_000], [P[8], 10],
];
const SHOWN = [POOL, PROGRAM, LOCK, OWNER, FOMO, ...P]; // the order the owner asked for
const holdAll = () => { for (const [w, a] of PICTURE) setHolding(w, a); };
const amountOf = Object.fromEntries(PICTURE);

let env;
beforeEach(() => { useClock("2026-10-13T20:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
after(() => realClock());

/* ---------------- the server's order ---------------- */

test("the snapshot: the pools, then the lock, then the team wallets (each biggest first), then people; ranks count people in amount order", async () => {
  holdAll();
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(snap.rows.map((r) => r.owner), SHOWN);
  assert.deepEqual(snap.rows.map((r) => [r.owner, r.rank, r.label]), [
    [POOL, null, "Pool or program account"], [PROGRAM, null, "Pool or program account"],
    [LOCK, null, "Team lock (Jupiter Lock)"],
    [OWNER, null, "Team wallet (public)"], [FOMO, null, "Team wallet (FOMO)"],
    ...P.map((p, i) => [p, i + 1, null]),
  ]);
  // ranks are what plain amount order gives the people: the biggest person is #1, whatever is listed above them
  const people = PICTURE.filter(([w]) => !LABELS[w]).sort((x, y) => y[1] - x[1]).map(([w]) => w);
  assert.deepEqual(people.map((w) => snap.byOwner.get(w).rank), people.map((_, i) => i + 1));
  assert.equal(snap.people, 9, "of 9 holders: pools, the lock and the team wallets are not people");
  assert.equal(snap.rows.length, PICTURE.length, "every holder listed once");
  for (const r of snap.rows) assert.ok(Math.abs(r.percent - (amountOf[r.owner] / 1e9) * 100) < 1e-9, `${r.owner}: its share of the supply`);
  assert.deepEqual(snap.rows.map((r) => r.amount), SHOWN.map((w) => amountOf[w]));
});

test("/api/holders: the first page starts pool → lock → team wallets → #1, and the pages continue the same order, every holder once", async () => {
  holdAll();
  const crowd = Array.from({ length: 1_100 }, () => key(true));
  crowd.forEach((w, i) => setHolding(w, (1_200 - i) / 1_000)); // 1.2 down to 0.101: smaller than everyone above
  const b = browser(env);
  const first = await b.get("/api/holders");
  assert.deepEqual([first.full, first.count, first.total, first.more, first.holders.length], [true, 1_114, 1_109, true, 1_000]);
  assert.deepEqual(first.holders.slice(0, 6).map((h) => [h.owner, h.rank, h.label]), [
    [POOL, null, "Pool or program account"], [PROGRAM, null, "Pool or program account"], [LOCK, null, "Team lock (Jupiter Lock)"],
    [OWNER, null, "Team wallet (public)"], [FOMO, null, "Team wallet (FOMO)"], [P[0], 1, null],
  ]);
  const second = await b.get("/api/holders?offset=1000");
  assert.equal(second.more, false);
  const all = [...first.holders, ...second.holders];
  assert.deepEqual(all.map((h) => h.owner), [...SHOWN, ...crowd], "the pages put together are the snapshot's order");
  assert.deepEqual(all.filter((h) => h.rank).map((h) => h.rank), Array.from({ length: 1_109 }, (_, i) => i + 1), "#1 to #1,109 with no gap across the pages");
  assert.equal(second.holders[0].rank, 1_000 - 5 + 1, "the second page goes on from the first page's last person");
});

test("the top-20 fallback (an RPC that cannot list every holder) uses the same order", async () => {
  const CURVE = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  const largest = [["accCurve", CURVE, "444500000000000"], ["accLock", LOCK, "60000000000000"], ["accA", P[0], "36000000000000"], ["accOwner", OWNER, "28500000000000"],
    ["accB", P[1], "9000000000000"], ["accFomo", FOMO, "5800000000000"], ["accC", P[2], "10000000"]];
  const programOf = { [CURVE]: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", [LOCK]: "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn" };
  const rpc = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getAccountInfo") return ok({ value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } });
    if (method === "getTokenLargestAccounts") return ok({ value: largest.map(([address, , amount]) => ({ address, amount, decimals: 6 })) });
    if (method === "getMultipleAccounts") {
      if (params[0][0] === "accCurve") return ok({ value: largest.map(([, owner]) => ({ data: { parsed: { info: { owner } } } })) });
      return ok({ value: params[0].map((k) => ({ owner: programOf[k] || "11111111111111111111111111111111" })) });
    }
    throw new Error("unexpected " + method);
  };
  const { holders } = await getTopHolders({}, MINT, rpc);
  assert.deepEqual(holders.map((h) => [h.owner, h.rank, h.label]), [
    [CURVE, null, "Raydium LaunchLab curve"], [LOCK, null, "Team lock (Jupiter Lock)"],
    [OWNER, null, "Team wallet (public)"], [FOMO, null, "Team wallet (FOMO)"],
    [P[0], 1, null], [P[1], 2, null], [P[2], 3, null],
  ]);
  for (const [, owner, raw] of largest) assert.ok(Math.abs(holders.find((h) => h.owner === owner).percent - (Number(raw) / 1e6 / 1e9) * 100) < 1e-9, `${owner}: its share`);
});

test("a list saved before the change (plain amount order, the FOMO wallet labelled '(public)') comes out in the new order with the new label", async () => {
  // the job's read published as it was stored: biggest first, with the labels the old code gave
  const facts = { mint: MINT, program: "SPL Token", decimals: 6, supply: 1e9 };
  const list = [...PICTURE].sort((x, y) => y[1] - x[1]);
  const oldLabels = new Map([[POOL, "Pool or program account"], [LOCK, "Team lock (Jupiter Lock)"], [OWNER, "Team wallet (public)"], [FOMO, "Team wallet (public)"], [PROGRAM, "Pool or program account"]]);
  await publishHolders(env, MINT, { facts, list, labels: oldLabels, slot: 1 });
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(snap.rows.map((r) => r.owner), SHOWN);
  assert.equal(snap.byOwner.get(FOMO).label, "Team wallet (FOMO)");

  // the shared D1 copy the display routes fall back on while the chain cannot be read (an error's e.stale)
  await ensureSchema(env.DB);
  holdAll();
  const b = browser(env);
  const before = await b.get("/api/holders");
  const KEY = `holders:v1:${MINT}`, saved = await getBlob(env.DB, KEY);
  assert.deepEqual(saved.list.map(([w]) => w), list.map(([w]) => w), "the copy keeps the plain list, biggest first");
  await putBlob(env.DB, KEY, { ...saved, labels: [...oldLabels] }); // as the code before this change wrote it
  clock.now += 3 * 60_000;
  _forgetServerMemory();
  const down = (url, init) => (JSON.parse(init.body).method === "getProgramAccounts"
    ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "max usage reached" } })) : chain()(url, init));
  const during = await (await b.send("/api/holders", { fetchImpl: down })).json();
  assert.equal(during.updatedAt, before.updatedAt, "the saved list, with its real time");
  assert.deepEqual(during.holders.map((h) => [h.owner, h.rank, h.label]), before.holders.map((h) => [h.owner, h.rank, h.label]));
  assert.deepEqual(during.holders.slice(0, 5).map((h) => h.label), [LABELS[POOL], LABELS[PROGRAM], LABELS[LOCK], LABELS[OWNER], LABELS[FOMO]]);
});

test("rankOf and /api/rank are what they were: the FOMO wallet has no rank and its label; a person's wallet to pass is the person above", async () => {
  holdAll();
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(rankOf(snap, FOMO), { amount: 5_812_345, rank: null, total: 9, label: "Team wallet (FOMO)", percent: (5_812_345 / 1e9) * 100, percentile: null, next: null, team: true });
  assert.deepEqual(rankOf(snap, P[5]).next, { rank: 5, amount: 31_000_000, gap: 11_000_000 }, "#6 passes #5, a person, not the team wallet between them");
  assert.equal(rankOf(snap, P[0]).next, null, "#1 passes nobody: the pool, the lock and the team wallets above it are not people");
  assert.deepEqual(rankOf(snap, "NobodyHoldsThis1111111111111111111111111111").next, { rank: 9, amount: 10, gap: 10 }, "any amount enters after the last person");
  const b = browser(env);
  const fomo = await b.get(`/api/rank?address=${FOMO}`);
  assert.deepEqual([fomo.full, fomo.rank, fomo.total, fomo.team, fomo.label], [true, null, 9, true, "Team wallet (FOMO)"]);
  const sixth = await b.get(`/api/rank?address=${P[5]}`);
  assert.deepEqual([sixth.rank, sixth.total, sixth.next], [6, 9, { rank: 5, amount: 31_000_000, gap: 11_000_000 }]);
  // the RPC refuses the full list: the balance alone still names it
  const noList = (url, init) => (JSON.parse(init.body).method === "getProgramAccounts"
    ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32010, message: "excluded" } })) : chain()(url, init));
  _forgetServerMemory();
  const slow = await (await b.send(`/api/rank?address=${FOMO}`, { fetchImpl: noList })).json();
  assert.deepEqual([slow.full, slow.amount, slow.rank, slow.team, slow.label], [false, 5_812_345, null, true, "Team wallet (FOMO)"]);
  _forgetServerMemory();
  assert.ok(!("label" in (await (await b.send(`/api/rank?address=${P[0]}`, { fetchImpl: noList })).json())), "a person's answer is as before");
});

/* ---------------- the token page ---------------- */

const row = (owner, rank, pct) => ({ owner, amount: amountOf[owner], percent: pct ?? (amountOf[owner] / 1e9) * 100, rank, label: LABELS[owner] || null });
/** /api/holders as the server answers it now: the shown order. */
const LIST = SHOWN.map((w) => row(w, P.includes(w) ? P.indexOf(w) + 1 : null));
const OFFICIAL_ANSWER = { teamWallets: OFFICIAL.teamWallets, teamLocks: OFFICIAL.teamLocks };
const width = (tr) => parseFloat(tr.children[3].children[0].children[0].style.width);

test("token.js: the rows in the server's order, 'Pool', 'Lock', 'Team', 'Team' then #1; the FOMO wallet's tag reads 'Team wallet (FOMO)'", async () => {
  const t = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: LIST });
  const rows = t.page.$$("#holders-body tr");
  assert.deepEqual(rows.map((tr) => tr.dataset.owner), SHOWN);
  assert.deepEqual(rows.map((tr) => tr.children[0].textContent), ["Pool", "Pool", "Lock", "Team", "Team", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(t.rowOf(FOMO).children[1].children[1].textContent, "Team wallet (FOMO)");
  assert.equal(t.rowOf(OWNER).children[1].children[1].textContent, "Team wallet (public)");
  assert.equal(t.$("#st-holders").textContent, "9", "people only");
  assert.equal(t.$("#st-top10").textContent, "19.8%", "the people's shares, not the pool's, the lock's or the team wallets'");
  // the bars: the biggest holding is the full width, the rest in proportion (the pool is the biggest today)
  for (const w of SHOWN) assert.ok(Math.abs(width(t.rowOf(w)) - Math.max(2, (amountOf[w] / amountOf[POOL]) * 100)) < 1e-9, w);
});

test("token.js: the bars when the first row is not the biggest (a pool smaller than the lock and a person): the biggest is the full width, none past it", async () => {
  const small = [row(POOL, null, 2), row(LOCK, null, 6), row(OWNER, null, 2.85), row(FOMO, null, 0.58), row(P[0], 1, 3.6), row(P[1], 2, 0.9)];
  const t = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: small });
  assert.deepEqual([POOL, LOCK, OWNER, FOMO, P[0], P[1]].map((w) => Math.round(width(t.rowOf(w)) * 100) / 100), [33.33, 100, 47.5, 9.67, 60, 15]);
});

test("token.js: the rank check names the FOMO wallet ('Team wallet (FOMO): …'); the owner's wallet keeps 'Team wallet: …'", async () => {
  const answer = (owner, extra = {}) => ({ launched: true, full: true, address: owner, amount: amountOf[owner], rank: null, total: 9, label: LABELS[owner], percent: (amountOf[owner] / 1e9) * 100, percentile: null, next: null, team: true, founderMin: 100_000, ...extra });
  const rank = { [FOMO]: answer(FOMO), [OWNER]: answer(OWNER) };
  const t = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: LIST, rank });
  const look = async (a) => { t.$("#holders-find").value = a; t.$("#lookup").dispatchEvent(newEvent("submit")); await t.settle(); };
  const text = (id) => t.$(id).textContent;
  await look(FOMO);
  assert.deepEqual(["#rank-num", "#rank-of", "#rank-pct", "#rank-amount"].map(text),
    ["—", "", "Team wallet (FOMO): published by Vicinity and labeled in the list. Ranks are for people only.", "5,812,345 $VICINITY"]);
  assert.deepEqual(["#rank-bar", "#rank-next-row", "#rank-founder-row"].map((id) => t.$(id).hidden), [true, true, true], "no meter, nothing to pass, no founder amount");
  await look(OWNER);
  assert.equal(text("#rank-pct"), "Team wallet: published by Vicinity and labeled in the list. Ranks are for people only.", "'(public)' is not repeated");
  // the balance-only answer (the list out of reach) carries the label too
  rank[FOMO] = { launched: true, full: false, address: FOMO, amount: amountOf[FOMO], rank: null, total: null, team: true, label: "Team wallet (FOMO)", founderMin: 100_000 };
  await look(FOMO);
  assert.equal(text("#rank-pct"), "Team wallet (FOMO): published by Vicinity and labeled in the list. Ranks are for people only.");
});

/* ---------------- the coin page ---------------- */

test("the coin page's Holders card shows the five biggest by size (a preview of who holds the most), not the server's first five", () => {
  const win = {};
  const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
  vm.runInNewContext(read("coinchart.js"), { window: win, Intl, Date, Math, Number, JSON });
  vm.runInNewContext(read("coin.js"), { window: win, Intl, URLSearchParams, Date });
  const top = (list, n) => JSON.parse(JSON.stringify(win.VCoin.pure.topHolders(list, n).map((h) => h.owner))); // out of the page's realm
  assert.deepEqual(top(LIST), [POOL, LOCK, P[0], P[1], P[2]], "the server's first five would be Pool, Pool, Lock, Team, Team");
  assert.deepEqual(top(LIST, 9), [POOL, LOCK, P[0], P[1], P[2], P[3], P[4], OWNER, P[5]]);
  assert.deepEqual(top([]), []); assert.deepEqual(top(null), []);
  assert.deepEqual(top([{ owner: "a", amount: 5 }, { owner: "b" }, { owner: "c", amount: 5 }]), ["a", "c", "b"], "equal amounts keep the server's order; a row without one goes last");
  assert.ok(read("coin.js").includes("...topHolders(r.holders).map((x) => {"), "the card draws topHolders' rows");
});
