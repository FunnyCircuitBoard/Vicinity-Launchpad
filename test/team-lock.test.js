// The team lock (13 Oct 2026, the owner: "Yes"): the team wallet 13qRam…sRiN locked 60,000,000 $VICINITY on Jupiter Lock, escrow
// CnRn…ejB6. Read on-chain the same day (program LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn, creation transaction XYkk74…cCgNf):
// cliff 2027-04-13 16:00 UTC with nothing unlocked at it, then 500,000 every 24 hours for 120 days (the last on 2027-08-11 16:00 UTC),
// to the team wallet; nobody can cancel it or change who receives it. Pinned here: the official entry (src/official.js teamLocks) and
// /api/official, the checker's verdict, the holder list's "Team lock (Jupiter Lock)" label (never ranked, never a person), the rank
// check, the Founding Supporter snapshot leaving it out, and the token page's "60M team tokens locked" card, holder row and rank pop-up
// (the built page with the real public/token.js on test/helpers/pagedom.js).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MINT, browser, chain, newWorld, realClock, setHolding, useClock } from "./helpers/world.js";
import { newEvent, openPage } from "./helpers/pagedom.js";
import { OFFICIAL, VICINITY_LAUNCHED, checkOfficial } from "../src/official.js";
import { _resetSnapshots, getTopHolders, holderSnapshot, isOnCurve, isTeamLock, isTeamWallet, publishHolders, rankOf } from "../src/chain.js";
import { computeSnapshot } from "../src/snapshot.js";
import { ensureSchema } from "../src/store.js";
import { putBlob, getBlob } from "../src/blobs.js";
import { base58Decode, base58Encode, isSolanaAddress } from "../src/solana.js";
import { randomBytes } from "node:crypto";

const LOCK = "CnRn4NiHSfezUHxh7EUytzcoJv98yeH5CpbCgsvyejB6";
const URL_ = `https://lock.jup.ag/escrow/${LOCK}`;
const TEAM = "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN";
const VICINITY = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const A = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", B = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
// a pool: some program's account (off the curve), labelled by the list itself
const POOL = (() => { for (;;) { const b = randomBytes(32); if (!isOnCurve(b)) return base58Encode(b); } })();
const LABEL = "Team lock (Jupiter Lock)";
const MESSAGE = "This is the Vicinity team lock on Jupiter Lock. The team locked 60,000,000 $VICINITY here: nothing unlocks before April 13, 2027, and nobody can cancel it or change who receives it.";
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

let env;
beforeEach(() => { useClock("2026-10-13T20:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
after(() => realClock());

/* ---------------- the official entry ---------------- */

test("the official list has the one team lock, exactly as read on-chain on 13 Oct 2026", () => {
  assert.deepEqual(OFFICIAL.teamLocks, [{
    address: LOCK, platform: "Jupiter Lock", url: URL_, mint: VICINITY, recipient: TEAM, amount: 60_000_000,
    cliff: "2027-04-13T16:00:00Z", end: "2027-08-11T16:00:00Z", perDay: 500_000, cancel: "none", changeRecipient: "none",
  }]);
  const [lock] = OFFICIAL.teamLocks;
  assert.ok(isSolanaAddress(lock.address) && isSolanaAddress(lock.mint) && isSolanaAddress(lock.recipient));
  assert.ok(Object.hasOwn(VICINITY_LAUNCHED, lock.mint), "it locks the real $VICINITY");
  assert.ok(OFFICIAL.teamWallets.includes(lock.recipient), "what unlocks goes back to the published team wallet");
  // the schedule adds up: 120 days of 500,000 from the cliff to the end, nothing at the cliff itself
  const days = (Date.parse(lock.end) - Date.parse(lock.cliff)) / 86_400_000;
  assert.equal(days, 120);
  assert.equal(days * lock.perDay, lock.amount);
  assert.deepEqual([day(lock.cliff), day(lock.end)], ["April 13, 2027", "August 11, 2027"]);
  assert.equal(isOnCurve(base58Decode(LOCK)), false, "the escrow is a program's account (no key can sign for it)");
});

test("/api/official carries the lock to the pages, with or without the contract set", async () => {
  for (const extra of [{}, { VICINITY_MINT: MINT }, { SITE_MODE: "preview" }]) {
    const o = await browser(newWorld(extra)).get("/api/official");
    assert.deepEqual(o.teamLocks, OFFICIAL.teamLocks, JSON.stringify(extra));
    assert.deepEqual(o.teamWallets, OFFICIAL.teamWallets);
    assert.equal(o.teamWallets[0], TEAM);
  }
});

/* ---------------- the checker ---------------- */

test("the checker: the lock's address and the lock's own page are the official team lock; anything near them is not", async () => {
  const check = (q) => checkOfficial(q, isSolanaAddress, { VICINITY_MINT: VICINITY });
  assert.deepEqual(check(LOCK), { verdict: "official", kind: "lock", message: MESSAGE });
  assert.deepEqual(check(` ${LOCK} `), { verdict: "official", kind: "lock", message: MESSAGE }, "spaces around a paste");
  for (const q of [URL_, `${URL_}/`, `lock.jup.ag/escrow/${LOCK}`, `${URL_}?tab=claims`]) assert.deepEqual(check(q), { verdict: "official", kind: "lock", message: MESSAGE }, q);
  // before the contract is set (the line in official.js is null), the lock is still the team's
  assert.equal(checkOfficial(LOCK, isSolanaAddress, {}).kind, "lock");
  // another escrow, the address with its case changed, another host: not ours
  assert.equal(check("https://lock.jup.ag/escrow/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin").verdict, "not_official");
  assert.equal(check(`https://lock.jup.ag/escrow/${LOCK.toLowerCase()}`).verdict, "not_official");
  assert.equal(check(`https://lock.jup.ag.evil.io/escrow/${LOCK}`).verdict, "not_official");
  // the right page over http: named, but a warning, like an http link to this site
  assert.deepEqual(check(`http://lock.jup.ag/escrow/${LOCK}`), { verdict: "warning", kind: "lock", message: "Right lock page, but the link uses http. Use the https version." });
  assert.equal(check("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin").verdict, "not_official");
  assert.equal(check(TEAM).kind, "wallet", "the team wallet is still a team wallet");
  // through the route the token page asks
  const b = browser(env);
  assert.deepEqual(await b.get(`/api/check?q=${LOCK}`), { verdict: "official", kind: "lock", message: MESSAGE });
  assert.deepEqual(await b.get(`/api/check?q=${encodeURIComponent(URL_)}`), { verdict: "official", kind: "lock", message: MESSAGE });
});

/* ---------------- the holder list ---------------- */

/** Today's picture, in small: the lock, the team wallet, a pool and two people. */
function holders() {
  setHolding(LOCK, 60_000_000); setHolding(TEAM, 30_459_975.105287); setHolding(POOL, 20_000_000);
  setHolding(A, 1_000); setHolding(B, 10);
}

test("the holder list: the lock is labelled 'Team lock (Jupiter Lock)', never ranked, and not counted as a person", async () => {
  holders();
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(snap.rows.map((r) => [r.owner, r.rank, r.label]), [
    [LOCK, null, LABEL],
    [TEAM, null, "Team wallet (public)"],
    [POOL, null, "Pool or program account"],
    [A, 1, null], [B, 2, null],
  ]);
  assert.equal(snap.people, 2, "of 2 holders: the lock, the team wallet and the pool are not people");
  assert.equal(snap.rows[0].percent, 6, "6% of the 1,000,000,000 supply");
  assert.ok(isTeamLock(LOCK) && !isTeamLock(TEAM) && !isTeamLock(A));
  assert.ok(!isTeamWallet(LOCK), "a lock is not a wallet anyone can sign for");
});

test("a list read before the lock was listed (labelled 'Pool or program account') shows the lock's own label", async () => {
  const facts = { mint: MINT, program: "SPL Token", decimals: 6, supply: 1e9 };
  await publishHolders(env, MINT, { facts, list: [[LOCK, 60_000_000], [A, 1_000]], labels: new Map([[LOCK, "Pool or program account"]]), slot: 1 });
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(snap.rows.map((r) => [r.owner, r.rank, r.label]), [[LOCK, null, LABEL], [A, 1, null]]);
});

test("the top-20 fallback (an RPC that cannot list every holder) labels the lock the same way", async () => {
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  const rpc = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getAccountInfo") return ok({ value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } });
    if (method === "getTokenLargestAccounts") return ok({ value: [["accLock", "60000000000000"], ["accTeam", "30000000000000"], ["accA", "1000000000"]].map(([address, amount]) => ({ address, amount, decimals: 6 })) });
    if (method === "getMultipleAccounts") {
      if (params[0][0] === "accLock") return ok({ value: [LOCK, TEAM, A].map((owner) => ({ data: { parsed: { info: { owner } } } })) });
      return ok({ value: params[0].map((k) => ({ owner: k === LOCK ? "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn" : "11111111111111111111111111111111" })) });
    }
    throw new Error("unexpected " + method);
  };
  const { holders: top } = await getTopHolders({}, MINT, rpc);
  assert.deepEqual(top.map((h) => [h.owner, h.rank, h.label]), [[LOCK, null, LABEL], [TEAM, null, "Team wallet (public)"], [A, 1, null]]);
});

test("rankOf and /api/rank on the lock: what it holds and its share, no rank, nothing to pass, lock: true; nobody else gets the key", async () => {
  holders();
  const snap = await holderSnapshot(env, MINT, chain());
  assert.deepEqual(rankOf(snap, LOCK), { amount: 60_000_000, rank: null, total: 2, label: LABEL, percent: 6, percentile: null, next: null, team: false, lock: true });
  assert.ok(!("lock" in rankOf(snap, A)) && !("lock" in rankOf(snap, TEAM)), "the answer for anyone else is exactly as before");
  assert.equal(rankOf(snap, A).rank, 1, "the first person is #1: the lock above is not a wallet to pass");
  const b = browser(env);
  const r = await b.get(`/api/rank?address=${LOCK}`);
  assert.deepEqual([r.full, r.amount, r.rank, r.total, r.label, r.next, r.team, r.lock], [true, 60_000_000, null, 2, LABEL, null, false, true]);
  // the RPC refuses the full list: the balance alone still says it is the team lock
  const noList = (url, init) => (JSON.parse(init.body).method === "getProgramAccounts"
    ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32010, message: "excluded" } })) : chain()(url, init));
  _resetSnapshots();
  const slow = await (await b.send(`/api/rank?address=${LOCK}`, { fetchImpl: noList })).json();
  assert.deepEqual([slow.full, slow.amount, slow.rank, slow.team, slow.lock], [false, 60_000_000, null, false, true]);
  _resetSnapshots();
  assert.ok(!("lock" in (await (await b.send(`/api/rank?address=${A}`, { fetchImpl: noList })).json())));
});

/* ---------------- the Founding Supporter snapshot ---------------- */

test("the Founding Supporter snapshot leaves the lock out by name, even from balances that carry no label for it; the published rule is unchanged", async () => {
  await ensureSchema(env.DB);
  const cutoff = "2026-10-16T00:00:00Z", amounts = { [LOCK]: 60_000_000, [TEAM]: 30_000_000, [A]: 1_000 };
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.parse(cutoff) - i * 86_400_000).toISOString().slice(0, 10);
    const sums = Object.fromEntries(Object.entries(amounts).map(([w, a]) => [w, a * 4]));
    await putBlob(env.DB, `day:${d}`, { day: d, n: 4, sums, last: amounts, lastAt: `${d}T18:00:00.000Z`, lastSlot: 1, labels: {}, decimals: 6 });
  }
  const { id } = await computeSnapshot(env, cutoff, Date.parse(cutoff) + 60_000);
  const data = await getBlob(env.DB, `snapshot:${id}`);
  assert.deepEqual(data.rows.map((r) => [r[0], r[1]]), [[A, 1_000_000_000]], "only the person: 1,000 $VICINITY in base units");
  assert.ok(data.inputs.excluded.includes(LOCK) && data.inputs.excluded.includes(TEAM), "both named in the published inputs");
  const rule = await (await browser(env).send("/api/snapshots")).json();
  // the rule's words are the rules page's (the lock is a program account, which the list already labelled and left out)
  assert.equal(rule.rule, "eligible = min(balance at the cutoff, 14-day average); pools and team wallets excluded");
});

/* ---------------- the token page ---------------- */

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CARD = `<div class="proof card"><span class="proof__icon">✓</span><h3>60M team tokens locked</h3><p>The team locked 60,000,000 $VICINITY (6% of the 1,000,000,000 supply) on Jupiter Lock. Nothing unlocks before April 13, 2027. Then 500,000 unlock each day for the team's main wallet, the last on August 11, 2027. No one, including us, can cancel it or change who receives it. Tokens in the team wallets are not locked.</p><span class="proof__live" id="team-lock-live">Checking on-chain…</span></div>`;

test("the token page's 'No rug pull' grid: a '60M team tokens locked' card after 'Team wallets public', its words from the official entry", () => {
  const [lock] = OFFICIAL.teamLocks;
  const fmt = (n) => n.toLocaleString("en-US");
  // every number and date in the card is the official entry's (dates as days, from the UTC times: no clock time to misread), in words
  // that stay true once unlocks start ("the team locked", not "is locked")
  assert.ok(CARD.includes(`<h3>${lock.amount / 1e6}M team tokens locked</h3>`), "only the 60M: the heading never says all the team's tokens");
  assert.ok(CARD.includes(`The team locked ${fmt(lock.amount)} $VICINITY (${(lock.amount / 1e9) * 100}% of the 1,000,000,000 supply) on ${lock.platform}.`));
  assert.ok(CARD.includes(`Nothing unlocks before ${day(lock.cliff)}. Then ${fmt(lock.perDay)} unlock each day for the team's main wallet, the last on ${day(lock.end)}.`));
  assert.ok(CARD.endsWith("Tokens in the team wallets are not locked.</p><span class=\"proof__live\" id=\"team-lock-live\">Checking on-chain…</span></div>"));
  for (const h of [read("scripts/pages/src/token.html"), read("public/token.html")]) {
    assert.equal(h.split(CARD).length - 1, 1, "the card, word for word, once");
    const at = (s) => h.indexOf(s);
    assert.ok(at("<h3>Team wallets public</h3>") < at("<h3>60M team tokens locked</h3>") && at("<h3>60M team tokens locked</h3>") < at("<h3>No presale</h3>"));
    assert.equal(h.split('id="team-lock-live"').length - 1, 1);
    assert.doesNotMatch(h, /two-thirds|12:00 PM|immutable|can never be touched|nobody can move|burn(ed)? (the|its) lock|<h3>Team tokens locked<\/h3>/i, "no claim the site cannot check, no clock time, no 'immutable', no heading that says all the team's tokens");
  }
  // "See the lock" is a 44 px tap, like the wallet links, and the line stays one line high
  assert.ok(read("public/polish.css").includes("#team-lock-live a { display: inline-block; padding: 12px 0; margin: -12px 0; }"));
});

/** The built token page with the real token.js: `official` is what /api/official answers (a promise), `list` the holder rows. */
async function tokenPage({ official, list, rank = {}, now = "2026-10-13T20:00:00Z" }) {
  const page = await openPage("token.html");
  const win = page.window, frames = [];
  const T = Date.parse(now);
  win.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } };
  win.location = { hash: "", search: "", pathname: "/token", href: "https://vicinity.city/token" };
  win.requestAnimationFrame = (f) => frames.push(f);
  Object.assign(win, { scrollX: 0, scrollY: 0, innerHeight: 800, scrollTo() {} });
  const answer = (path) => {
    const p = String(path).split("?")[0];
    if (p === "/api/token") return { launched: true, registry: [], facts: { mint: VICINITY, program: "SPL Token", decimals: 6, supply: 1e9, mintAuthority: null, freezeAuthority: null, mintingDisabled: true, freezingDisabled: true, mintHeldByProgram: false }, price: null };
    if (p === "/api/holders") return list === null ? { launched: true, error: "chain_unavailable" }
      : { launched: true, mint: VICINITY, supply: 1e9, total: list.filter((h) => h.rank).length, count: list.length, full: true, holders: list, more: false, updatedAt: "2026-10-13T19:59:00Z" };
    if (p === "/api/rank") return rank[new URL(path, "https://x").searchParams.get("address")];
    return { ok: true };
  };
  win.fetch = async (path) => { const body = answer(path); return { ok: true, status: 200, json: async () => body }; };
  win.V.official = official;
  const pop = page.$("#rank-pop"); pop.showModal = () => { pop.open = true; }; pop.close = () => { pop.open = false; };
  vm.runInContext(read("public/token.js"), win, { filename: "public/token.js" });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  await settle();
  const rowOf = (owner) => page.$$("#holders-body tr").find((tr) => tr.dataset.owner === owner);
  return { page, settle, rowOf, $: page.$ };
}
const LIST = [
  { owner: LOCK, amount: 60_000_000, percent: 6, rank: null, label: LABEL },
  { owner: TEAM, amount: 30_459_975.105287, percent: 3.05, rank: null, label: "Team wallet (public)" },
  { owner: POOL, amount: 20_000_000, percent: 2, rank: null, label: "Raydium LaunchLab curve" },
  { owner: A, amount: 1_000, percent: 0.0001, rank: 1, label: null },
];
const OFFICIAL_ANSWER = { teamWallets: [TEAM], teamLocks: OFFICIAL.teamLocks };

test("token.js: the lock's row says 'Lock' (not 'Pool') and its tag opens the lock's page in a new tab; the card's line shows what it holds", async () => {
  const t = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: LIST });
  const cells = (owner) => t.rowOf(owner).children;
  assert.deepEqual([LOCK, TEAM, POOL, A].map((o) => cells(o)[0].textContent), ["Lock", "Team", "Pool", "1"]);
  assert.ok(cells(LOCK)[0].classList.contains("is-unranked"), "'Lock' takes the label size on phones, like 'Team' and 'Pool'");
  const tag = cells(LOCK)[1].children[1];
  assert.deepEqual([tag.tagName, tag.className, tag.getAttribute("href"), tag.target, tag.rel], ["A", "tag tag--ok", URL_, "_blank", "noopener"]);
  assert.equal(tag.textContent, `${LABEL} (opens in a new tab)`);
  assert.deepEqual([cells(TEAM)[1].children[1].tagName, cells(POOL)[1].children[1].tagName], ["SPAN", "SPAN"], "other labels stay plain tags");
  assert.equal(t.$("#st-holders").textContent, "1", "people only: not the lock");
  // "60M team tokens locked": the lock's balance from the list, and the link
  const live = t.$("#team-lock-live"), a = t.$("#team-lock-live a");
  assert.equal(live.textContent, "60,000,000 still locked · See the lock (opens in a new tab)");
  // one span holds the words and the link: the line is a flex box, and two items would wrap as two columns on a narrow card
  assert.deepEqual([live.children.length, live.children[0].tagName, live.children[0].children[0]], [1, "SPAN", a]);
  assert.deepEqual([a.getAttribute("href"), a.target, a.rel], [URL_, "_blank", "noopener"]);
  assert.ok(live.classList.contains("is-live"));
  assert.equal(t.$("#team-count").textContent, "1 wallet and 1 lock listed");
});

test("token.js: after the cliff the line says 'still in the lock' (some of it may be unlocked and not yet taken out)", async () => {
  const t = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: [{ ...LIST[0], amount: 59_500_000 }, ...LIST.slice(1)], now: "2027-04-14T17:00:00Z" });
  assert.equal(t.$("#team-lock-live").textContent, "59,500,000 still in the lock · See the lock (opens in a new tab)");
});

test("token.js: the lock missing from the list, or the chain busy: the link alone; /api/official failing: no endless 'Checking'", async () => {
  const missing = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: LIST.slice(1) });
  assert.equal(missing.$("#team-lock-live").textContent, "See the lock (opens in a new tab)");
  assert.ok(!missing.$("#team-lock-live").classList.contains("is-live"));
  const busy = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: null });
  assert.equal(busy.$("#team-lock-live").textContent, "See the lock (opens in a new tab)");
  const offline = Promise.reject(new Error("offline")); offline.catch(() => {}); // handled by token.js once it runs
  const failed = await tokenPage({ official: offline, list: LIST });
  assert.equal(failed.$("#team-lock-live").textContent, "Couldn't check right now");
  assert.equal(failed.rowOf(LOCK).children[1].children[1].tagName, "SPAN", "no page to link: a plain tag");
  assert.equal(failed.rowOf(LOCK).children[0].textContent, "Lock");
  // a list without locks counts the wallets as before
  const before = await tokenPage({ official: Promise.resolve({ teamWallets: [TEAM] }), list: LIST });
  assert.equal(before.$("#team-count").textContent, "1 wallet listed");
});

test("token.js: /api/official answering after the list is drawn still links the lock's tag and fills the line", async () => {
  let release;
  const t = await tokenPage({ official: new Promise((r) => { release = r; }), list: LIST });
  assert.equal(t.rowOf(LOCK).children[1].children[1].tagName, "SPAN");
  assert.equal(t.$("#team-lock-live").textContent, "Checking on-chain…");
  release(OFFICIAL_ANSWER); await t.settle();
  const tag = t.rowOf(LOCK).children[1].children[1];
  assert.deepEqual([tag.tagName, tag.getAttribute("href")], ["A", URL_]);
  assert.deepEqual(t.page.$$("#holders-body tr").map((tr) => tr.dataset.owner), [LOCK, TEAM, POOL, A], "the row replaced in place, once");
  assert.equal(t.$("#team-lock-live").textContent, "60,000,000 still locked · See the lock (opens in a new tab)");
});

test("token.js: the rank check on the lock says it is the team lock: what it holds, no rank, no meter, nothing to pass, no founder amount", async () => {
  const rank = {
    [LOCK]: { launched: true, full: true, address: LOCK, amount: 60_000_000, rank: null, total: 1, label: LABEL, percent: 6, percentile: null, next: null, team: false, lock: true, founderMin: 100_000 },
  };
  const t = await tokenPage({ official: Promise.resolve(OFFICIAL_ANSWER), list: LIST, rank });
  t.$("#holders-find").value = LOCK;
  t.$("#lookup").dispatchEvent(newEvent("submit"));
  await t.settle();
  const text = (id) => t.$(id).textContent, shown = (id) => !t.$(id).hidden;
  assert.deepEqual(["#rank-num", "#rank-of", "#rank-pct", "#rank-amount", "#rank-share", "#rank-founder"].map(text),
    ["—", "", "Team lock: the team's $VICINITY on Jupiter Lock, labeled in the list. Ranks are for people only.", "60,000,000 $VICINITY", "6.00%", "—"]);
  assert.deepEqual(["#rank-big", "#rank-bar", "#rank-next-row", "#rank-founder-row", "#rank-show"].map(shown), [false, false, false, false, true],
    "no 'Rank Pool' line, no meter, no wallet to pass, no founder amount; its row in the list");
  assert.ok(t.$("#rank-pop").open);
  // the balance-only answer (the full list out of reach) says the same
  rank[LOCK] = { launched: true, full: false, address: LOCK, amount: 60_000_000, rank: null, total: null, team: false, lock: true, founderMin: 100_000 };
  t.$("#lookup").dispatchEvent(newEvent("submit"));
  await t.settle();
  assert.deepEqual(["#rank-pct", "#rank-share"].map(text), ["Team lock: the team's $VICINITY on Jupiter Lock, labeled in the list. Ranks are for people only.", "—"]);
  assert.deepEqual(["#rank-next-row", "#rank-founder-row"].map(shown), [false, false]);
});

test("the coin page's top five says 'Lock' for the lock, like the token page", () => {
  assert.ok(read("public/coin.js").includes('/^Team lock/.test(str(x.label)) ? "Lock" : "Pool"'));
});
