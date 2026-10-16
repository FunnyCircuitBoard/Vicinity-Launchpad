// The token page's Trades | Holders block (the owner's 15 Oct 2026 proposal, workstream 5, its first step): the Launchpad's tab strip
// over two cards. Trades lists the newest buys and sells from the coin answer the page already reads (/api/coin: Raydium LaunchLab's list
// for the curve; no new call upstream), under one coverage sentence (the venue and the answer's time), with a stage guard and honest
// loading, empty, unavailable and Delayed states. Holders is the live list as it was, plus "Delayed · list from HH:MM" when the server
// answered an older list, and the supply the percentages are a share of (to the mint's six decimals). Pinned here: the markup and the
// sheet, the tabs (click, Enter, arrow keys, Tab, the hash in the address bar, deep links), the rows (the masked wallet linked to its
// Solscan page, as the holder list's rows are), the guard, every state, one clock format for both cards, no redraw of the same rows,
// /api/holders' stale flag and the coin page's linked top five. public/token.js runs on the built page in node (test/helpers/tokenpage.js); how it looks is checked in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VICINITY, tokenPage } from "./helpers/tokenpage.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("public/token.html"), src = read("scripts/pages/src/token.html"), css = read("public/pages-token.css"), js = read("public/token.js");
const OFFICIAL = { ok: true, launchpadV2: true, teamWallets: [], teamLocks: [] };
const NOW = "2026-10-13T20:00:00Z";
const key = (i) => `T${String(i).replace(/\d/g, (d) => "abcdefghij"[d])}`.padEnd(44, "k"); // 44 base58 characters like a Solana address (no 0, O, I, l)
const B58 = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
const TX = (i) => "5Gxu1gBSDFAPLKUZihs9tRiFvHxrpgSfcZW8rgZGyfu5F96AWg13d9Czxz1sDxXKwW6DNnJ2x1nFRApqT9QJ".slice(0, 80) + B58[i % B58.length].repeat(4);
const LIST = [{ owner: key(1), amount: 400, percent: 0.00004, rank: 1, label: null }, { owner: key(2), amount: 100, percent: 0.00001, rank: 2, label: null }];
const RANK = (i, rank, next) => ({ launched: true, full: true, address: key(i), amount: LIST[i - 1].amount, percent: LIST[i - 1].percent, rank, total: 2, percentile: rank * 50, next, supply: 1e9, founderMin: 100_000 });
/** One trade as src/coin.js sends it: the wallet masked, its Solscan page as walletUrl (public on-chain data, as the holder list is), the time in ISO. */
const trade = (i, side, at, tokens = 158764.265017, amount = 0.009999621) => ({ txid: TX(i), at, side, tokens, amount, symbol: "SOL", wallet: `DEBQ${i}*****Q9R`, walletUrl: `https://solscan.io/account/${key(i)}`, url: `https://solscan.io/tx/${TX(i)}` });
/** An answer of GET /api/coin for $VICINITY on its curve (src/coin.js's shape), its three trades deliberately out of order. */
const coin = (o = {}) => ({
  ok: true, asOf: "2026-10-13T19:58:30.000Z", mint: VICINITY, coin: { kind: "vicinity", ticker: "VICINITY" },
  market: { priceChange24hPct: -1.5, stage: "curve", curve: { stage: "curve" }, sources: { change24h: "Jupiter" }, ...(o.market || {}) },
  trades: { source: "Raydium LaunchLab", rows: [trade(1, "sell", "2026-10-13T19:40:00Z", 2_500_000, 0.25), trade(2, "buy", "2026-10-13T17:58:40Z", 0.5, 150.4), trade(0, "buy", "2026-10-13T19:57:40Z")], ...(o.trades || {}) },
  links: {},
});
const open = (o = {}) => tokenPage({ official: Promise.resolve(OFFICIAL), list: LIST, now: NOW, coin: coin(), ...o });
/** The one clock format of both cards ("updated", "list from", "as of"): hour and minute in the reader's locale, no seconds. */
const HHMM = (iso) => new Date(Date.parse(iso)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/* ---------------- the markup and the sheet ---------------- */

test("markup: the strip (two tabs, the Launchpad's pill) over the Trades card and the Holders card; Trades first and chosen; Holders hidden until chosen; the list's head as it was", () => {
  for (const h of [html, src]) {
    const sec = h.slice(h.indexOf('<section id="holders" class="section">'), h.indexOf("</section>", h.indexOf('<section id="holders"')));
    assert.match(sec, /<p class="kicker">Trades and holders<\/p>\s*<h2>Who buys, sells and holds \$VICINITY\.<\/h2>\s*<p class="muted">Refreshed every minute\. Pools and team wallets are labeled; ranks are for people only\.<\/p>/);
    assert.doesNotMatch(sec, /kicker--live|live-dot|· live/, "no 'live' word or dot over cards that can read Delayed or unavailable: each card's own line carries its time");
    assert.match(sec, /<div class="seg seg--tabs tk-tabs" role="tablist" aria-label="Trades or holders" id="tk-tabs">\s*<button type="button" role="tab" id="tk-tab-trades" data-tab="trades" aria-selected="true" aria-controls="trades-panel">Trades<\/button>\s*<button type="button" role="tab" id="tk-tab-holders" data-tab="holders" aria-selected="false" aria-controls="holders-panel" tabindex="-1">Holders<\/button>\s*<\/div>/, "the launchpad's strip: role=tablist, one Tab stop, aria-controls");
    assert.match(sec, /<div class="trades card tabpanel is-loading" id="trades-panel" role="tabpanel" aria-labelledby="tk-tab-trades">/, "busy (the placeholder rows shimmer) until the first answer");
    assert.match(sec, /<div class="holders card tabpanel" id="holders-panel" role="tabpanel" aria-labelledby="tk-tab-holders" hidden>/);
    const at = (s) => { const i = sec.indexOf(s); assert.ok(i >= 0, s); return i; };
    assert.ok(at('id="tk-tabs"') < at('id="trades-panel"') && at('id="trades-panel"') < at('id="holders-panel"') && at('id="holders-panel"') < at('id="rank-pop"'), "the strip, Trades, Holders, then the pop-up");
    assert.match(sec, /<span class="trades__cover" id="trades-cover" role="status" aria-live="polite">Loading recent trades…<\/span>\s*<button class="link-btn" type="button" id="trades-refresh" hidden>Refresh<\/button>/, "the coverage sentence is the live region; Refresh beside it, as the list has");
    assert.match(sec, /<ol class="trades__list" id="trades-list" aria-label="Recent trades">\s*(<li class="trade skeleton" aria-hidden="true"><span><\/span><span><\/span><span><\/span><\/li>\s*){3}<\/ol>/, "three still placeholder rows until the answer");
    assert.match(sec, /<p class="trades__note" id="trades-note" hidden><\/p>\s*<button class="link-btn trades__all" type="button" id="trades-all" aria-expanded="false" aria-controls="trades-list" hidden>Show all<\/button>/);
    assert.match(sec, /<\/table>\s*<\/div>\s*<p class="holders__basis" id="holders-basis" hidden><\/p>\s*<\/div>/, "the supply line under the list, inside the Holders card");
    for (const id of ["tk-tabs", "tk-tab-trades", "tk-tab-holders", "trades-panel", "trades-cover", "trades-refresh", "trades-list", "trades-note", "trades-all", "holders-panel", "holders-basis"]) assert.equal(h.split(`id="${id}"`).length - 1, 1, id);
    assert.equal((h.match(/role="tablist"/g) || []).length, 1); assert.equal((h.match(/role="tabpanel"/g) || []).length, 2);
    assert.doesNotMatch(sec, /risk|not financial advice/i, "no risk line in the chrome (removed site-wide on purpose)");
  }
  for (const sel of [".tk-tabs {", ".trades__list {", ".trade {", ".trade__side.is-buy {", ".trade__side.is-sell {", ".trades__empty {", ".tk-delayed {", "#holders-status.is-delayed {", ".holders__basis {", ".trade.is-more {", ".trades__list.is-all .trade.is-more {", ".trade__meta a {", ".trades__list:empty {"]) assert.ok(css.includes(sel), sel);
  assert.match(css, /@media \(min-width: 700px\) \{ \.tk-tabs \{ display: inline-flex; width: auto; \}/, "a pill of its own width on a computer; full width on a phone (polish.css .seg--tabs: two short words fit at 320 px)");
  assert.match(css, /\.trades\.is-loading \.trade\.skeleton span \{[^}]*animation: shimmer 1\.6s linear infinite; \}/, "the shimmer loops only while the card is busy (test/motion.test.js's rule for every sheet)");
  assert.match(css, /\.trade__meta a \{ display: inline-block; padding: 13px 0; margin: -13px 0;/, "a 44 px hit area on the wallet and Solscan links at every width (the line is .76rem on a phone), like the list's wallets");
  assert.match(css, /\.trades__list:empty \{ display: none; \}/, "the guard's sentence has no empty bordered box under it");
  assert.match(css, /\.trade__side\.is-sell \{ color: var\(--bad-text\); background: var\(--bad-soft, rgba\(255,90,54,\.1\)\); \}/, "the sell pill reads a theme token");
  assert.equal((read("public/style.css").match(/--bad-soft: rgba\([^)]+\);/g) || []).length, 2, "--bad-soft next to --ok-soft, dark and light");
  assert.match(read("public/polish.css"), /\.tabpanel\[hidden\] \{ display: none; \}/, "a hidden panel is gone, card or not");
  assert.equal((js.match(/\/api\/coin\?/g) || []).length, 1, "one place asks for the coin answer: the chip and the tab share it (no new call upstream)");
});

/* ---------------- the tabs ---------------- */

test("tabs: Trades opens first; a click or Enter on the other switches (its card shown, the other hidden, aria-selected, the one Tab stop, the hash in the address bar) and back", async () => {
  const t = await open();
  const trades = t.$("#tk-tab-trades"), holders = t.$("#tk-tab-holders");
  const chosen = () => [trades.getAttribute("aria-selected"), holders.getAttribute("aria-selected"), trades.tabIndex, holders.tabIndex, t.$("#trades-panel").hidden, t.$("#holders-panel").hidden];
  assert.deepEqual(chosen(), ["true", "false", 0, -1, false, true]);
  assert.equal(t.win.location.hash, "", "no hash is written until the reader chooses");
  holders.click();
  assert.deepEqual(chosen(), ["false", "true", -1, 0, true, false]);
  assert.equal(t.win.location.hash, "#holders");
  assert.equal(t.$$("#holders-body tr").length, 2, "the live list was drawn in its card while it was hidden");
  trades.focus(); t.press("Enter");
  assert.deepEqual(chosen(), ["true", "false", 0, -1, false, true]);
  assert.equal(t.win.location.hash, "#trades");
  assert.deepEqual(t.errors, []);
});

test("tabs: arrow keys move between them and choose (wrapping), Home and End go to the ends; Tab from the chosen tab goes on into the shown card, never into the hidden one", async () => {
  const t = await open();
  const inside = (sel) => t.$(sel).contains(t.doc.activeElement);
  t.$("#tk-tab-trades").focus();
  t.press("ArrowRight");
  assert.equal(t.doc.activeElement.id, "tk-tab-holders"); assert.equal(t.$("#holders-panel").hidden, false); assert.equal(t.win.location.hash, "#holders");
  t.press("ArrowRight"); assert.equal(t.doc.activeElement.id, "tk-tab-trades", "wraps");
  t.press("ArrowLeft"); assert.equal(t.doc.activeElement.id, "tk-tab-holders", "wraps the other way");
  t.press("Home"); assert.equal(t.doc.activeElement.id, "tk-tab-trades");
  t.press("End"); assert.equal(t.doc.activeElement.id, "tk-tab-holders");
  t.press("Tab"); assert.ok(inside("#holders-panel"), `into the Holders card, not the hidden Trades card (${t.doc.activeElement.id})`);
  t.press("Tab", { shift: true }); assert.equal(t.doc.activeElement.id, "tk-tab-holders", "back to the chosen tab: the other is no Tab stop");
  t.press("Home"); t.press("Tab"); assert.ok(inside("#trades-panel"), `into the Trades card (${t.doc.activeElement.id})`);
  assert.deepEqual(t.errors, []);
});

test("deep links: #holders, #verify (the box takes the keyboard), #holders-scroll, #lookup and ?address= open Holders; #trades, #buy, #check and no hash open Trades; a link's own hash stays; a hash that changes while the page is open switches too", async () => {
  const rank = { [key(1)]: RANK(1, 1, null) };
  for (const [hash, search, want] of [["#holders", "", "holders"], ["#verify", "", "holders"], ["#holders-scroll", "", "holders"], ["#lookup", "", "holders"], ["", `?address=${key(1)}`, "holders"], ["#trades", "", "trades"], ["#buy", "", "trades"], ["#check", "", "trades"], ["", "", "trades"]]) {
    const t = await open({ hash, search, rank });
    const name = `${hash}${search}` || "(no hash)";
    assert.equal(t.$("#holders-panel").hidden, want !== "holders", name);
    assert.equal(t.$("#trades-panel").hidden, want === "holders", name);
    assert.equal(t.$("#tk-tab-holders").getAttribute("aria-selected"), String(want === "holders"), name);
    assert.equal(t.win.location.hash, hash, `${name}: the link's own hash stays`);
    if (hash === "#verify") assert.equal(t.doc.activeElement.id, "holders-find", "the box takes the keyboard, as before (it can, shown)");
    if (search) {
      assert.equal(t.$("#rank-pop").open, true, "the rank check's answer opened over the Holders card");
      assert.equal(t.$("#rank-num").textContent, "#1");
      t.$("#rank-show").click();
      assert.equal(t.$("#holders-panel").hidden, false, "Show it in the holder list keeps the Holders card");
    }
    assert.deepEqual(t.errors, [], name);
  }
  const t = await open();
  t.hashTo("#verify"); assert.equal(t.$("#holders-panel").hidden, false); assert.equal(t.doc.activeElement.id, "holders-find", "the FAQ's 'box above the holder list' link");
  t.hashTo("#trades"); assert.equal(t.$("#trades-panel").hidden, false); assert.equal(t.$("#holders-panel").hidden, true);
  t.hashTo("#check"); assert.equal(t.$("#trades-panel").hidden, false, "another section's link changes no tab");
  assert.deepEqual(t.errors, []);
});

/* ---------------- the Trades tab ---------------- */

test("Trades: the answer's buys and sells, newest first: side, token amount, SOL, the masked wallet linked to its Solscan page (plain text when the answer carries no link), when (the exact time as a title) and the transaction on Solscan; the coverage sentence names the venue and the answer's time; the chip reads the same answer", async () => {
  const t = await open();
  const rows = t.$$("#trades-list li.trade");
  assert.equal(rows.length, 3);
  const cell = (li, cls) => li.querySelector(`.${cls}`);
  assert.deepEqual(rows.map((li) => cell(li, "trade__side").textContent), ["Buy", "Sell", "Buy"], "newest first (the answer had them out of order)");
  assert.deepEqual(rows.map((li) => cell(li, "trade__side").className), ["trade__side is-buy", "trade__side is-sell", "trade__side is-buy"]);
  assert.deepEqual(rows.map((li) => li.className), ["trade is-buy", "trade is-sell", "trade is-buy"]);
  assert.deepEqual(rows.map((li) => cell(li, "trade__tok").textContent), ["158,764 $VICINITY", "2,500,000 $VICINITY", "0.5 $VICINITY"]);
  assert.deepEqual(rows.map((li) => cell(li, "trade__sol").textContent), ["0.0100 SOL", "0.2500 SOL", "150 SOL"]);
  assert.deepEqual(rows.map((li) => cell(li, "trade__who").childNodes[0].textContent), ["DEBQ0*****Q9R", "DEBQ1*****Q9R", "DEBQ2*****Q9R"], "masked by the server; the page invents nothing");
  assert.deepEqual(rows.map((li) => [cell(li, "trade__who").tagName, cell(li, "trade__who").href, cell(li, "trade__who").target, cell(li, "trade__who").rel]), [0, 1, 2].map((i) => ["A", `https://solscan.io/account/${key(i)}`, "_blank", "noopener"]), "linked to the wallet's Solscan page, like the holder list's rows (one rule for both tabs)");
  assert.equal(cell(rows[0], "trade__who").textContent, "DEBQ0*****Q9R (opens in a new tab)", "said for a screen reader");
  assert.deepEqual(rows.map((li) => cell(li, "trade__when").textContent), ["2m ago", "20m ago", "2h ago"]);
  assert.equal(cell(rows[0], "trade__when").title, new Date(Date.parse("2026-10-13T19:57:40Z")).toLocaleString(), "the exact time as a title");
  assert.equal(cell(rows[0], "trade__when").dateTime, "2026-10-13T19:57:40Z");
  const tx = cell(rows[0], "trade__tx");
  assert.deepEqual([tx.href, tx.target, tx.rel, tx.textContent], [`https://solscan.io/tx/${TX(0)}`, "_blank", "noopener", "Solscan (opens in a new tab)"]);
  assert.equal(t.$("#trades-cover").textContent, `Trades on the Raydium LaunchLab curve · as of ${HHMM("2026-10-13T19:58:30.000Z")}`);
  assert.equal(t.$("#trades-refresh").hidden, false); assert.equal(t.$("#trades-note").hidden, true); assert.equal(t.$("#trades-all").hidden, true);
  assert.ok(!t.$("#trades-panel").classList.contains("is-loading"), "the placeholder rows' shimmer ended with the answer");
  assert.equal(t.calls.filter((c) => c.startsWith("/api/coin")).length, 1, "one call: the 24-hour chip and the tab share it");
  assert.equal(t.$("#tk-chg").textContent, "▼ 1.50% 24h");
  assert.deepEqual(t.errors, []);
  // no link, or a link to anywhere but a Solscan account page: the masked text alone (the page never links what it cannot check)
  const plainRows = [{ ...trade(0, "buy", "2026-10-13T19:57:40Z"), walletUrl: undefined }, { ...trade(1, "buy", "2026-10-13T19:50:40Z"), walletUrl: "https://evil.example/account/" + key(1) }, { ...trade(2, "buy", "2026-10-13T19:40:40Z"), walletUrl: "https://solscan.io/account/not-an-address" }];
  const p = await open({ coin: coin({ trades: { rows: plainRows } }) });
  assert.deepEqual(p.$$("#trades-list .trade__who").map((w) => [w.tagName, w.textContent]), [["SPAN", "DEBQ0*****Q9R"], ["SPAN", "DEBQ1*****Q9R"], ["SPAN", "DEBQ2*****Q9R"]]);
  assert.equal(p.$$("#trades-list a").length, 3, "the three transaction links only");
  assert.deepEqual(p.errors, []);
});

test("Trades, the stage guard: a graduated (migrating, pool) answer never shows the last curve trades; it says where the open market's trades are, with links; an unknown stage says it could not check", async () => {
  for (const stage of ["graduated", "migrating", "pool"]) {
    const t = await open({ coin: coin({ market: { stage } }) });
    assert.equal(t.$$("#trades-list li.trade").length, 0, stage);
    const text = t.$("#trades-panel").textContent;
    assert.ok(!text.includes("DEBQ") && !text.includes(TX(0)) && !text.includes("Buy"), `${stage}: none of the curve's trades, nothing that reads as live`);
    assert.equal(t.$("#trades-cover").textContent, "Trade history for the open market is not available here yet.");
    assert.equal(t.$("#trades-note").hidden, false);
    assert.equal(t.$("#trades-note").textContent.replace(/ \(opens in a new tab\)/g, ""), "See Solscan or DEX Screener.");
    assert.deepEqual(t.$$("#trades-note a").map((a) => [a.href, a.target]), [[`https://solscan.io/token/${VICINITY}`, "_blank"], [`https://dexscreener.com/solana/${VICINITY}`, "_blank"]]);
    assert.deepEqual(t.errors, [], stage);
  }
  const t = await open({ coin: coin({ market: { stage: null } }) });
  assert.equal(t.$$("#trades-list li.trade").length, 0);
  assert.equal(t.$("#trades-cover").textContent, "Could not check the pool right now. Try Refresh in a minute.");
  assert.deepEqual(t.$$("#trades-note a").map((a) => a.href), [`https://solscan.io/token/${VICINITY}`]);
  assert.deepEqual(t.errors, []);
});

test("Trades, the other states: before launch; the coin pages switched off (no call made); the answer failed; no trades yet; Raydium out of reach; an older answer says Delayed", async () => {
  const before = await open({ token: { launched: false, registry: [] } });
  assert.equal(before.$("#trades-cover").textContent, "The live trade list opens the moment $VICINITY launches.");
  assert.equal(before.$$("#trades-list li").length, 0); assert.equal(before.$("#trades-refresh").hidden, true);
  const off = await open({ official: Promise.resolve({ ok: true, teamWallets: [], teamLocks: [] }) });
  assert.equal(off.$("#trades-cover").textContent, "Recent trades are not available here yet.");
  assert.equal(off.calls.filter((c) => c.startsWith("/api/coin")).length, 0, "no call the server would answer 404");
  assert.deepEqual(off.$$("#trades-note a").map((a) => a.href), [`https://solscan.io/token/${VICINITY}`]); assert.equal(off.$("#trades-refresh").hidden, true);
  const failed = await open({ coin: { ok: false, error: "coin_unavailable" } });
  assert.equal(failed.$("#trades-cover").textContent, "Recent trades are not available right now. Try Refresh in a minute.");
  assert.equal(failed.$$("#trades-list li.trade").length, 0); assert.equal(failed.$("#trades-refresh").hidden, false);
  const none = await open({ coin: coin({ trades: { rows: [], missing: "No trades yet" } }) });
  assert.equal(none.$("#trades-list").textContent, "No trades yet"); assert.equal(none.$$("#trades-list li.trade").length, 0);
  assert.equal(none.$("#trades-cover").textContent, `Trades on the Raydium LaunchLab curve · as of ${HHMM("2026-10-13T19:58:30.000Z")}`);
  const unreached = await open({ coin: coin({ trades: { rows: [], missing: "Raydium could not be reached" } }) });
  assert.equal(unreached.$("#trades-list").textContent, "Recent trades are not available right now. Try Refresh in a minute.");
  const stale = await open({ coin: coin({ trades: { stale: true } }) });
  assert.equal(stale.$("#trades-cover").textContent, "Trades on the Raydium LaunchLab curve · Delayed · older list, each trade shows its own time", "no 'as of': the answer's time is not the older list's");
  assert.equal(stale.$("#trades-cover .tk-delayed").textContent, "Delayed", "marked, not only said");
  assert.equal(stale.$$("#trades-list li.trade").length, 3, "the rows still show, marked");
  const named = await open({ coin: coin({ trades: { source: "Raydium LaunchLab v2" } }) });
  assert.equal(named.$("#trades-cover").textContent, `Trades on the Raydium LaunchLab v2 curve · as of ${HHMM("2026-10-13T19:58:30.000Z")}`, "the venue as the answer names it");
  const unnamed = await open({ coin: coin({ trades: { source: null } }) });
  assert.equal(unnamed.$("#trades-cover").textContent, `Trades on the Raydium LaunchLab curve · as of ${HHMM("2026-10-13T19:58:30.000Z")}`);
  for (const t of [before, off, failed, none, unreached, stale, named, unnamed]) assert.deepEqual(t.errors, []);
});

test("Trades: the newest 20 show, 'Show all N' opens the rest (at most 50; open, it stays open across a refresh); Refresh asks again; broken rows are skipped", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => trade(i, i % 2 ? "sell" : "buy", new Date(Date.parse(NOW) - (i + 1) * 60_000).toISOString()));
  rows.push({ ...trade(61, "buy", "2026-10-13T19:00:00Z"), txid: "not-a-signature" }, trade(62, "swap", "2026-10-13T19:00:00Z"), { ...trade(63, "buy", "2026-10-13T19:00:00Z"), tokens: -1 }, { ...trade(64, "buy", "not a time") }, null, "x");
  const t = await open({ coin: coin({ trades: { rows } }) });
  const shown = () => t.$$("#trades-list li.trade"), more = () => shown().filter((li) => li.classList.contains("is-more"));
  assert.equal(shown().length, 50, "capped at 50"); assert.equal(more().length, 30, "20 show, 30 wait behind Show all");
  assert.ok(!shown().slice(0, 20).some((li) => li.classList.contains("is-more")));
  assert.deepEqual([t.$("#trades-all").hidden, t.$("#trades-all").textContent, t.$("#trades-all").getAttribute("aria-expanded")], [false, "Show all 50", "false"]);
  t.$("#trades-all").click();
  assert.ok(t.$("#trades-list").classList.contains("is-all"));
  assert.deepEqual([t.$("#trades-all").textContent, t.$("#trades-all").getAttribute("aria-expanded")], ["Show fewer", "true"]);
  const calls = t.calls.filter((c) => c.startsWith("/api/coin")).length;
  t.$("#trades-refresh").click(); await t.settle();
  assert.equal(t.calls.filter((c) => c.startsWith("/api/coin")).length, calls + 1);
  assert.ok(t.$("#trades-list").classList.contains("is-all"), "still open"); assert.equal(shown().length, 50);
  assert.deepEqual(t.errors, []);
});

test("Trades: Refresh (and the minute refresh) with the same rows redraws nothing, so a reader's focus on a link in the list stays; the sentence is written again; a new trade redraws the list", async () => {
  let rows = coin().trades.rows;
  const t = await open({ coin: () => coin({ trades: { rows } }) });
  const first = t.$("#trades-list li.trade"), tx = first.querySelector(".trade__tx");
  tx.focus(); assert.equal(t.doc.activeElement, tx);
  t.$("#trades-refresh").click(); await t.settle();
  assert.equal(t.calls.filter((c) => c.startsWith("/api/coin")).length, 2, "asked again all the same");
  assert.equal(t.$("#trades-list li.trade"), first, "the same row node: nothing was redrawn");
  assert.equal(t.doc.activeElement, tx, "the keyboard stayed on the link");
  assert.equal(t.$("#trades-cover").textContent, `Trades on the Raydium LaunchLab curve · as of ${HHMM("2026-10-13T19:58:30.000Z")}`);
  rows = [trade(3, "buy", "2026-10-13T19:59:00Z"), ...rows];
  t.$("#trades-refresh").click(); await t.settle();
  assert.equal(t.$$("#trades-list li.trade").length, 4); assert.notEqual(t.$("#trades-list li.trade"), first, "a new trade: the list is drawn again");
  assert.deepEqual(t.errors, []);
});

/* ---------------- the Holders tab ---------------- */

test("Holders: 'N holders · updated HH:MM' as before; an older list the server answered while the chain could not be read reads 'N holders · Delayed · list from HH:MM' (the list's time, marked), also when the same list comes back on Refresh", async () => {
  const fresh = await open();
  const at = HHMM("2026-10-13T19:59:00Z");
  assert.equal(fresh.$("#holders-status").textContent, `2 holders · updated ${at}`, "hour and minute, as the Trades card's 'as of' (one clock format in the block)");
  assert.equal(fresh.$("#holders-basis").textContent, "Percentages use the live on-chain supply of 1,000,000,000 $VICINITY.");
  assert.ok(!fresh.$("#holders-status").classList.contains("is-delayed"));
  const stale = await open({ holdersExtra: { stale: true } });
  assert.equal(stale.$("#holders-status").textContent, `2 holders · Delayed · list from ${at}`);
  assert.ok(stale.$("#holders-status").classList.contains("is-delayed"));
  assert.equal(stale.$("#holders-refresh").hidden, false, "Refresh stays");
  assert.equal(stale.$$("#holders-body tr").length, 2, "the list itself shows, as the server meant");
  assert.equal(stale.$("#holders-basis").textContent, "Percentages use the on-chain supply of 1,000,000,000 $VICINITY, read with the list.", "not 'live': the supply came with the older list");
  stale.$("#holders-refresh").click(); await stale.settle();
  assert.equal(stale.$("#holders-status").textContent, `2 holders · Delayed · list from ${at}`, "the snapshot already on screen, still Delayed");
  assert.deepEqual(stale.errors, []);
  // the server side: /api/holders carries the flag only when the list is an older one (test/holders-global.test.js runs it against the route)
  assert.match(read("src/index.js"), /updatedAt: snap\.at, \.\.\.\(snap\.stale \? \{ stale: true \} : \{\}\) \}\);/);
});

test("Holders: under the list, the supply the percentages are a share of: the live on-chain number from the list's answer to the mint's six decimals (999,999,999.999998 on mainnet), never rounded to 1,000,000,000; a truly round supply reads round; nothing while the chain is busy", async () => {
  const t = await open({ holdersExtra: { supply: 999_999_999.999998 } });
  assert.equal(t.$("#holders-basis").hidden, false);
  assert.equal(t.$("#holders-basis").textContent, "Percentages use the live on-chain supply of 999,999,999.999998 $VICINITY.", "the chain's number as it is (fmt with the mint's 6 decimals)");
  assert.equal(t.$("#st-supply").textContent, "1B", "the hero's compact figure is what it was");
  const round = await open({ holdersExtra: { supply: 1e9 } });
  assert.equal(round.$("#holders-basis").textContent, "Percentages use the live on-chain supply of 1,000,000,000 $VICINITY.", "no trailing zeros for a round supply");
  assert.deepEqual(round.errors, []);
  const busy = await open({ list: null });
  assert.equal(busy.$("#holders-basis").hidden, true);
  assert.equal(busy.$("#holders-status").textContent, "The blockchain is busy right now. Try Refresh in a minute.");
  assert.deepEqual([...t.errors, ...busy.errors], []);
});

/* ---------------- the coin page's top five (an honesty extra) ---------------- */

test("the coin page's top five link each masked address to the wallet on Solscan, as the token page's rows do (one rule for both pages)", () => {
  const coinJs = read("public/coin.js");
  assert.match(coinJs, /if \(isAddr\(x\.owner\)\) \{ const a = newTab\(el\("a", "coin-holder__addr"\)\); a\.href = `https:\/\/solscan\.io\/account\/\$\{x\.owner\}`; a\.title = x\.owner; a\.prepend\(el\("code", null, mask\(x\.owner\)\)\); who\.append\(a\); \}/);
  assert.match(read("public/style.css"), /\.coin-holder__addr \{ display: inline-block; padding: 12px 0; margin: -12px 0; color: inherit; text-decoration: none; \}/, "a 44 px tap on the wallet, the row no taller (like the token page's list)");
  assert.match(js, /const a = el\("a", null, mask\(h\.owner\)\); a\.href = `https:\/\/solscan\.io\/account\/\$\{h\.owner\}`; a\.target = "_blank"; a\.rel = "noopener"; a\.title = h\.owner;/, "the token page's rows: the same masked text, the same Solscan page");
});
