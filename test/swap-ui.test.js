// public/swap.js in node (no browser): the panel's states and copy, which route it calls with what, wallet feature detection
// (signAndSendTransaction, signTransaction + our relay, a wallet that can do neither), the legacy-version flag, a phone with no
// wallet (deep links that carry the trade, no sign-up), curve coins handed over to the launchpad routes with the devnet chain, the
// price-impact guards, a stale quote refreshed before building, the bottom sheet, and that the panel never calls a session route.
// Every trade goes Review (the build, shown) then Approve (the wallet); the review's own clock, the links that carry a trade and
// the phone QR code are in test/swap-review.test.js. The real pages are checked in Chromium by the all-e2e harness; this is for
// regressions in what the controller DOES.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Doc, Target, newEvent, parse } from "./helpers/pagedom.js";
import { SOL, USDC, VIC, CITY, TAKER, CONFIG, QUOTE, TX, walletOf, swapPage as page, paths, byPath, click, text } from "./helpers/swappage.js";

const SWAP_JS = readFileSync(new URL("../public/swap.js", import.meta.url), "utf8");
const type = async (P, value) => { const i = P.$(".swap__amt"); i.value = value; i.dispatchEvent(newEvent("input")); await P.flush(); };

test("swap panel: with the switch off nothing mounts and the slot is hidden; nothing but /api/swap/config is asked", async () => {
  const P = await page({ answers: { "/api/swap/config": { ok: true, swap: false } } });
  assert.equal(P.slot.hidden, true);
  assert.deepEqual(paths(P.calls), ["/api/swap/config"]);
});

test("swap panel: mounts from data-swap, quotes while typing (no taker before a wallet), shows the details and the attribution", async () => {
  const P = await page({ answers: { "/api/swap/config": CONFIG, "/api/swap/quote": (b) => QUOTE({ source: "jupiter_quote", estimate: true, taker: b.taker }) } });
  assert.equal(P.slot.getAttribute("data-swap-mounted"), "1");
  assert.equal(text(P.$(".swap__title")), "Buy $VICINITY");
  assert.deepEqual(P.$$(".swap__token").map((b) => [text(b).replace(/▾/, "").trim(), b.disabled]), [["SSOL", false], ["V$VICINITY", true]], "SOL pickable, $VICINITY fixed");
  assert.equal(text(P.$(".swap__go")), "Connect wallet");
  assert.match(text(P.$(".swap__foot")), /Powered by Jupiter/);
  assert.equal(text(P.$(".swap__status")), "You pay SOL, the market gives you $VICINITY; your own wallet asks you to confirm.", "a first-time buyer is told what happens before typing anything");
  await type(P, "0.25");
  const q = P.calls.find((c) => c.path === "/api/swap/quote");
  assert.deepEqual(q.body, { inputMint: SOL, outputMint: VIC, amount: "0.25", slippageBps: 100 }, "no taker before a wallet is connected");
  assert.equal(text(P.$(".swap__state")), "Estimate");
  assert.equal(text(P.$(".swap__amt--out")), "89,166.22", "thousands get two decimals: the whole figure fits a phone");
  const dds = P.$$(".swap__details dd").map(text);
  assert.deepEqual(dds.slice(0, 4), ["88,274.56 $VICINITY", "0.12%", "network ≈ 0.000005 SOL · priority ≤ 0.0000003 SOL · no platform fee", "Routed by Jupiter · executed on Raydium Launchlab"], "the priority fee is in the fee line, as the most the Worker allows for this quote");
  assert.equal(P.$$(".swap__details dd")[4].hidden, true, "no rent row while nothing says a token account is missing");
  assert.match(text(P.$(".swap__help")), /^Slippage is how much worse than this quote you still accept\. If the price moves past Min received, the trade stops and nothing is spent; Price impact is how much your own trade moves the price\.$/, "the three words are explained in one sentence");
  assert.match(text(P.$(".swap__status")), /Estimate: the exact amount is fixed when you tap Review/);
  assert.ok(P.$(".swap__usd") && /≈ \$37\.56/.test(text(P.$(".swap__usd"))));
  // a changed amount re-quotes after the debounce; garbage is cleaned out of the field
  await type(P, "0,5abc");
  assert.equal(P.$(".swap__amt").value, "0.5");
  assert.equal(P.calls.filter((c) => c.path === "/api/swap/quote").length, 2);
  assert.ok(!paths(P.calls).some((p) => /\/api\/(me|auth|signup|session)/.test(p)), "never a session route");
});

test("swap panel: connect, quote with the taker, balances and MAX, then the whole buy with signAndSendTransaction, confirmed", async () => {
  const w = walletOf();
  const statuses = ["pending", "confirmed"];
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": (b) => QUOTE({ source: b.taker ? "jupiter_build" : "jupiter_quote", estimate: !b.taker }), "/api/swap/balances": { ok: true, sol: { lamports: 1_500_000_000, ui: 1.5 }, tokens: { [VIC]: { ui: 12.5, hasAccount: true } } }, "/api/swap/tx": TX(), "/api/swap/status": () => ({ ok: true, status: statuses.shift() || "confirmed", solscan: "x" }) } });
  await type(P, "0.25");
  click(P.$(".swap__go"));
  await P.flush();
  const opts = P.$$(".swap__wallets .wallet-option");
  assert.equal(opts.length, 1);
  assert.equal(text(opts[0]), "TTest WalletConnect");
  click(opts[0]); await P.flush();
  assert.deepEqual(w.calls, [["connect"]]);
  assert.match(text(P.$(".swap__status")), /Connected CnQM…zz6p|Getting the best price|Price impact/);
  assert.equal(P.$(".swap__wallets").hidden, true);
  const bal = byPath(P.calls, "/api/swap/balances")[0];
  assert.match(bal.path, new RegExp(`owner=${TAKER}&mints=${VIC}&cluster=mainnet`));
  // the quote is asked again with the taker (a build, not an estimate)
  await type(P, "0.25");
  const last = P.calls.filter((c) => c.path === "/api/swap/quote").pop();
  assert.equal(last.body.taker, TAKER);
  assert.equal(text(P.$(".swap__state")), "Live");
  assert.equal(P.$(".swap__max").hidden, false);
  assert.equal(text(P.$(".swap__max")), "MAX · 1.5 SOL");
  assert.equal(text(P.$(".swap__bal")), "You hold 12.5");
  click(P.$(".swap__max")); await P.flush();
  assert.equal(P.$(".swap__amt").value, "1.49", "MAX keeps 0.01 SOL for fees");
  await type(P, "0.25");
  assert.equal(text(P.$(".swap__go")), "Review buy");
  click(P.$(".swap__go")); await P.flush();
  const tx = P.calls.find((c) => c.path === "/api/swap/tx");
  assert.deepEqual(tx.body, { inputMint: SOL, outputMint: VIC, amount: "0.25", slippageBps: 100, taker: TAKER, quoteId: "q1" }, "no v: legacy for a wallet with version 0");
  assert.deepEqual(w.calls, [["connect"]], "Review only builds: the wallet is not asked yet");
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__go")), P.$(".swap__go").disabled], ["Ready to approve", "Approve in Test Wallet", false]);
  click(P.$(".swap__go")); // Approve
  const sent = w.calls.find((c) => c[0] === "signAndSend");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), ["signAndSend", 300, "solana:mainnet", { preflightCommitment: "confirmed", maxRetries: 3 }], "the bytes of the Worker's transaction, the chain, the options");
  await P.flush(60);
  const st = byPath(P.calls, "/api/swap/status");
  assert.ok(st.length >= 2, "polled until confirmed");
  assert.match(st[0].path, /sig=[1-9A-HJ-NP-Za-km-z]{43,88}&lvbh=4321&cluster=mainnet/);
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
  assert.equal(text(P.$(".swap__status")), "Swapped ✓ 0.25 SOL → 89,166.22 $VICINITY");
  assert.match(P.$(".swap__links a").getAttribute("href"), /^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(text(P.$(".swap__go")), "Swap again");
  assert.ok(!paths(P.calls).some((p) => /\/api\/(me|auth|signup)/.test(p)), "a swap needs no login");
  assert.ok(!paths(P.calls).includes("/api/swap/send"), "a wallet that sends needs no relay");
});

test("swap panel: a wallet that only signs goes through our relay; a wallet without version 0 asks for a legacy transaction", async () => {
  const w = walletOf({ kind: "sign", versions: ["legacy"] });
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE(), "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} }, "/api/swap/tx": TX({ version: "legacy", ticket: "1791900000000.relay-ticket-of-build" }), "/api/swap/send": { ok: true, signature: "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk", solscan: "x" }, "/api/swap/status": { ok: true, status: "finalized" } } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.25");
  click(P.$(".swap__go")); await P.flush(); // Review
  click(P.$(".swap__go")); await P.flush(60); // Approve
  assert.equal(P.calls.find((c) => c.path === "/api/swap/tx").body.v, "legacy");
  assert.deepEqual(w.calls.find((c) => c[0] === "sign"), ["sign", 300, "solana:mainnet"]);
  const send = P.calls.find((c) => c.path === "/api/swap/send");
  assert.deepEqual([send.body.lastValidBlockHeight, send.body.cluster, send.body.tx.length > 300, send.body.ticket], [4321, "mainnet", true, "1791900000000.relay-ticket-of-build"], "the relay gets the ticket of the build that was reviewed");
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
});

test("swap panel: plain words for every way it stops: cancelled, slippage, not enough SOL, no route, busy; a legacy provider is told what to do", async () => {
  const w = walletOf({ reject: true });
  let txAnswer = TX();
  let quoteAnswer = QUOTE();
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": () => quoteAnswer, "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} }, "/api/swap/tx": () => txAnswer } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.25"); click(P.$(".swap__go")); await P.flush(30); // Review
  click(P.$(".swap__go")); await P.flush(30); // Approve, cancelled in the wallet
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status")), text(P.$(".swap__go"))], ["Stopped", "Cancelled in your wallet. Nothing was sent.", "Try again"]);
  // Try again builds and shows it again (a build that fails says why, before any wallet)
  txAnswer = { ok: false, error: "slippage", name: "SlippageToleranceExceeded", _status: 409 };
  click(P.$(".swap__go")); await P.flush(30);
  assert.equal(text(P.$(".swap__status")), "The price moved more than your slippage allows. Nothing was spent. Try again or raise slippage.");
  txAnswer = { ok: false, error: "insufficient_sol", _status: 409 };
  click(P.$(".swap__go")); await P.flush(30);
  assert.match(text(P.$(".swap__status")), /^Not enough SOL for this plus the network fee, the priority fee \(up to 0\.01 SOL\) and about 0\.002 SOL of rent for each token account that does not exist yet\.$/);
  txAnswer = { ok: false, error: "program_error", name: "InvalidPermission", _status: 409 };
  click(P.$(".swap__go")); await P.flush(30);
  assert.equal(text(P.$(".swap__status")), "The market refused this trade (InvalidPermission). Nothing was spent.");
  quoteAnswer = { ok: false, error: "no_route", _status: 404 };
  await type(P, "0.3");
  assert.deepEqual([text(P.$(".swap__status")), P.$(".swap__go").disabled], ["No market can trade this pair right now.", false]);
  quoteAnswer = { ok: false, error: "jupiter_busy", retryAfterS: 5, _status: 503 };
  await type(P, "0.31");
  assert.equal(text(P.$(".swap__status")), "The price service is busy. Try again in a few seconds.");
  // a wallet that can neither send nor sign a transaction here
  const legacy = walletOf({ kind: "legacy" });
  const L = await page({ wallets: [legacy], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE(), "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} } } });
  click(L.$(".swap__go")); await L.flush();
  assert.equal(text(L.$(".swap__wallets .wallet-option .go")), "No transactions");
  click(L.$(".swap__wallets .wallet-option")); await L.flush();
  assert.match(text(L.$(".swap__status")), /This wallet can sign messages here but not transactions: open this page in Phantom, Solflare or Backpack/);
  assert.match(L.win.VSwap.words({ error: "needs_v0" }), /^This route needs a version-0 transaction, which this wallet does not support here\. Update the wallet, or use one that supports version-0 transactions\.$/, "no 'try Phantom, Solflare or Backpack' to a wallet that is one of them");
  await type(L, "0.25"); click(L.$(".swap__go")); await L.flush(30);
  assert.equal(text(L.$(".swap__status")), "This wallet can sign messages here but not transactions: open this page in Phantom, Solflare or Backpack.");
  assert.ok(!paths(L.calls).includes("/api/swap/tx"), "nothing is built for it");
});

test("swap panel: a phone with no wallet gets Open in Phantom / Solflare / Backpack with this very page and its trade, and the address to copy; no sign-up", async () => {
  const P = await page({ isMobile: true, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE({ estimate: true, source: "jupiter_quote" }) }, href: "https://vicinity.test/token#buy-slot" });
  click(P.$(".swap__go")); await P.flush();
  const links = P.$$(".swap__deeplinks a");
  assert.deepEqual(links.map(text), ["POpen in Phantom↗", "SOpen in Solflare↗", "BOpen in Backpack↗"]);
  assert.equal(links[0].getAttribute("href"), `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_slip=100#buy-slot`)}`, "this page, with the pair and slippage (no amount typed yet), its hash kept");
  assert.equal(text(P.$(".swap__ca code")), VIC);
  assert.ok(!paths(P.calls).some((p) => /\/api\/(me|auth|signup|connect)/.test(p)));
});

test("swap panel: a city coin on its curve is quoted and built by the launchpad routes on the devnet chain; a wallet without devnet is told to switch", async () => {
  const curveQuote = { ok: true, quoteId: "c1", source: "curve", side: "buy", inputMint: SOL, outputMint: CITY, decimals: { in: 9, out: 6 }, inAmount: "5000000", outAmount: "13286006275533", minOut: "13153146212777", inUi: "0.005", outUi: "13286006.275533", minOutUi: "13153146.212777", slippageBps: 100, priceImpactPct: "1.32", refund: "0", partialFill: false, route: ["Meteora bonding curve"], fees: { curveFeeBps: 125, networkLamports: 5000, split: {} }, chain: "solana:devnet", cluster: "devnet", poweredBy: "Meteora DBC", expiresAt: new Date(Date.now() + 12000).toISOString() };
  const mainnetOnly = walletOf({ chains: ["solana:mainnet"] });
  const answers = { "/api/swap/config": CONFIG, "/api/swap/quote": { ok: true, source: "curve", mint: CITY, side: "buy", chain: "solana:devnet", cluster: "devnet", quoteMint: SOL, useRoute: "/api/launchpad/trade" }, "/api/launchpad/trade/quote": curveQuote, "/api/launchpad/trade/tx": TX({ chain: "solana:devnet", cluster: "devnet", quote: curveQuote }), "/api/swap/balances": { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: {} }, "/api/swap/status": { ok: true, status: "confirmed" } };
  const P = await page({ wallets: [mainnetOnly], answers, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy" data-title="Buy $DEMOV"></div>` });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.005");
  assert.deepEqual(P.calls.find((c) => c.path === "/api/launchpad/trade/quote").body, { mint: CITY, side: "buy", amount: "0.005", slippageBps: 100, taker: TAKER });
  assert.deepEqual([text(P.$(".swap__state")), P.$$(".swap__details dd").map(text)[3]], ["Devnet test coin", "Executed on the Meteora bonding curve"]);
  assert.match(text(P.$(".swap__foot")), /Meteora bonding curve.*Devnet test coin/);
  click(P.$(".swap__go")); await P.flush(30);
  assert.equal(text(P.$(".swap__status")), "Switch your wallet to devnet for this test coin.");
  assert.ok(!paths(P.calls).includes("/api/launchpad/trade/tx"), "nothing is built for the wrong chain");
  // the same with a wallet whose account is on devnet too
  const both = walletOf({ chains: ["solana:mainnet", "solana:devnet"] });
  const Q = await page({ wallets: [both], answers, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>` });
  click(Q.$(".swap__go")); await Q.flush(); click(Q.$(".swap__wallets .wallet-option")); await Q.flush();
  await type(Q, "0.005");
  assert.equal(text(Q.$(".swap__go")), "Review buy");
  click(Q.$(".swap__go")); await Q.flush(); // Review
  assert.deepEqual(Q.calls.find((c) => c.path === "/api/launchpad/trade/tx").body, { mint: CITY, side: "buy", amount: "0.005", slippageBps: 100, taker: TAKER, quoteId: "c1" });
  assert.equal(text(Q.$(".swap__status")), "You pay 0.005 SOL → you get 13,286,006.28 $DEMOV (at least 13,153,146.21). Check it, then approve in your wallet.");
  click(Q.$(".swap__go")); await Q.flush(60); // Approve
  assert.deepEqual(both.calls.find((c) => c[0] === "signAndSend").slice(0, 3), ["signAndSend", 300, "solana:devnet"]);
  assert.match(byPath(Q.calls, "/api/swap/status").pop().path, /cluster=devnet/);
  assert.match(Q.$(".swap__links a").getAttribute("href"), /\?cluster=devnet$/);
  assert.equal(text(Q.$(".swap__state")), "Swapped ✓");
});

test("swap panel: price impact above 3% tints, above 10% needs 'I understand'; slippage chips; a stale quote is refreshed before building; the flip", async () => {
  let impact = "4.5";
  const w = walletOf();
  let quotes = 0;
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": () => { quotes++; return QUOTE({ priceImpactPct: impact, expiresAt: new Date(Date.now() - 1000).toISOString() }); }, "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} }, "/api/swap/tx": TX(), "/api/swap/status": { ok: true, status: "confirmed" } } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "2");
  assert.ok(P.slot.classList.contains("is-warn") && !P.slot.classList.contains("is-bad"));
  assert.equal(P.$(".swap__warn").hidden, true);
  impact = "12";
  await type(P, "20");
  assert.ok(P.slot.classList.contains("is-bad"));
  assert.deepEqual([P.$(".swap__warn").hidden, P.$(".swap__go").disabled], [false, true], "the button waits for the checkbox");
  const cb = P.$(".swap__warn input"); cb.checked = true; cb.dispatchEvent(newEvent("change")); await P.flush();
  assert.equal(P.$(".swap__go").disabled, false);
  const before = quotes;
  click(P.$(".swap__go")); await P.flush(60); // Review
  assert.equal(quotes, before + 1, "the expired quote was refreshed before building");
  assert.ok(P.calls.some((c) => c.path === "/api/swap/tx"));
  click(P.$(".swap__go")); await P.flush(60); // Approve
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
  // slippage chips
  const chips = P.$$(".swap__chip:not(.swap__chip--custom)");
  assert.deepEqual(chips.map((c) => c.getAttribute("aria-pressed")), ["false", "true", "false"]);
  click(P.$(".swap__go")); await P.flush(); // "Swap again" resets
  click(chips[2]); await P.flush();
  await type(P, "1");
  assert.equal(P.calls.filter((c) => c.path === "/api/swap/quote").pop().body.slippageBps, 300);
  const custom = P.$(".swap__chip--custom"); custom.value = "2.5"; custom.dispatchEvent(newEvent("change")); await P.flush();
  assert.equal(P.calls.filter((c) => c.path === "/api/swap/quote").pop().body.slippageBps, 250);
  // the flip sells
  click(P.$(".swap__flip")); await P.flush();
  assert.deepEqual(P.$$(".swap__token").map((b) => [text(b).replace(/▾/, "").trim(), b.disabled]), [["V$VICINITY", true], ["SSOL", false]]);
  assert.equal(text(P.$(".swap__go")), "Sell $VICINITY");
});

test("swap panel: open() shows the panel in a sheet over the page and closes on the ✕ or a tap outside", async () => {
  const P = await page({ answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE() }, slot: "" });
  const p = await P.VSwap.open({ out: VIC });
  await P.flush();
  const sheet = P.$(".swap-sheet");
  assert.ok(sheet && sheet.hasAttribute("open"));
  assert.equal(text(sheet.querySelector(".swap__title")), "Buy $VICINITY");
  assert.ok(p && p.root === sheet.querySelector(".swap-sheet__body"));
  click(sheet.querySelector(".swap-sheet__close"));
  assert.equal(sheet.hasAttribute("open"), false);
  await P.VSwap.open({ out: USDC, in: "SOL", mode: "swap", title: "Swap" }); await P.flush();
  assert.equal(text(sheet.querySelector(".swap__title")), "Swap");
  sheet.dispatchEvent(newEvent("click"));
  assert.equal(sheet.hasAttribute("open"), false, "a tap on the backdrop closes it");
});

test("swap panel: the build the wallet signs is the truth: Review shows the /tx quote, one that came out worse says 'The price changed' with no wallet call; Approve signs exactly that build and the done line shows the BUILD's numbers", async () => {
  const w = walletOf();
  let txAnswer = TX({ quote: QUOTE({ outAmount: "52470000000", minOut: "51945300000", outUi: "52470", minOutUi: "51945.3", priceImpactPct: "35" }), fees: { computeUnitLimit: 200000, computeUnitPrice: "1000", priorityLamports: 200, networkLamports: 5000, rentLamports: 2039280 } });
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE(), "/api/swap/balances": { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: { [VIC]: { ui: 0, hasAccount: false } } }, "/api/swap/tx": () => txAnswer, "/api/swap/status": { ok: true, status: "confirmed" } } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.25");
  assert.equal(text(P.$$(".swap__details dd")[4]), "about 0.00203928 SOL once creates your $VICINITY account (returned when you close it)", "the rent of a missing token account is said before the wallet opens");
  assert.equal(P.$$(".swap__details dd")[4].hidden, false);
  click(P.$(".swap__go")); await P.flush(60); // Review
  assert.ok(!w.calls.some((c) => c[0] === "signAndSend"), "the wallet was NOT opened for a build worse than the preview");
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__amt--out")), P.$$(".swap__details dd").map(text)[0], P.$$(".swap__details dd").map(text)[1]], ["Ready to approve", "52,470", "51,945.3 $VICINITY", "35.00%"], "the panel now shows the build's own numbers, not the preview's");
  assert.equal(text(P.$(".swap__status")), "The price changed: you would now get 52,470 $VICINITY (at least 51,945.3). Nothing was sent.");
  assert.ok(P.$(".swap__status").classList.contains("is-moved"));
  assert.ok(P.slot.classList.contains("is-bad") && P.$(".swap__warn").hidden === false && P.$(".swap__go").disabled === true, "the 10 % guard is judged on the build: the checkbox is back and Approve waits for it");
  click(P.$(".swap__go")); await P.flush();
  assert.ok(!w.calls.some((c) => c[0] === "signAndSend"), "Approve does nothing while the box is not ticked");
  assert.equal(P.$$(".swap__details dd").map(text)[2], "network ≈ 0.000005 SOL · priority 0.0000002 SOL · no platform fee", "after /tx the fee line carries the exact priority fee of the transaction");
  const cb = P.$(".swap__warn input"); cb.checked = true; cb.dispatchEvent(newEvent("change")); await P.flush();
  // ticked (and the 1.5 s pause after a changed price over): Approve signs exactly the build on the screen; the done line reads it
  assert.equal(P.$(".swap__go").disabled, false);
  click(P.$(".swap__go")); await P.flush(60);
  assert.equal(P.calls.filter((c) => c.path === "/api/swap/tx").length, 1, "Approve built nothing new: the reviewed build is the one signed");
  assert.ok(w.calls.some((c) => c[0] === "signAndSend"));
  assert.equal(text(P.$(".swap__status")), "Swapped ✓ 0.25 SOL → 52,470 $VICINITY");
  // a better build never stops anyone
  const w2 = walletOf();
  const Q = await page({ wallets: [w2], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE(), "/api/swap/balances": { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: {} }, "/api/swap/tx": TX({ quote: QUOTE({ outAmount: "89600000000", outUi: "89600", minOut: "88704000000", minOutUi: "88704" }) }), "/api/swap/status": { ok: true, status: "confirmed" } } });
  click(Q.$(".swap__go")); await Q.flush(); click(Q.$(".swap__wallets .wallet-option")); await Q.flush();
  await type(Q, "0.25"); click(Q.$(".swap__go")); await Q.flush(60);
  assert.equal(text(Q.$(".swap__status")), "You pay 0.25 SOL → you get 89,600 $VICINITY (at least 88,704). Check it, then approve in your wallet.", "a better build just updates");
  assert.equal(Q.$(".swap__go").disabled, false);
  click(Q.$(".swap__go")); await Q.flush(60);
  assert.equal(text(Q.$(".swap__status")), "Swapped ✓ 0.25 SOL → 89,600 $VICINITY");
  // the comparison itself
  const W = Q.win.VSwap.worseThan;
  assert.deepEqual(W({ outAmount: "1000", minOut: "990", priceImpactPct: "0.1" }, { outAmount: "996", minOut: "986", priceImpactPct: "0.2" }).worse, false, "0.4 % less is within the tolerance");
  assert.deepEqual(W({ outAmount: "1000", minOut: "990", priceImpactPct: "0.1" }, { outAmount: "994", minOut: "984", priceImpactPct: "0.2" }).worse, true, "0.6 % less stops");
  assert.deepEqual(W({ outAmount: "1000", minOut: "990", priceImpactPct: "2.9" }, { outAmount: "1000", minOut: "990", priceImpactPct: "3.1" }).worse, true, "crossing 3 % stops even with the same amounts");
  assert.deepEqual(W({ outAmount: "1000", minOut: "990", priceImpactPct: "0.1" }, { outAmount: "1200", minOut: "1100", priceImpactPct: "0.1" }).worse, false, "more out never stops");
});

test("swap panel: a 429 on the status poll says 'Still checking…', waits Retry-After and never turns into 'expired'; 90 s of real 'pending' answers say 'could not confirm', not 'nothing was spent'", async () => {
  const w = walletOf();
  const statuses = [{ ok: false, error: "slow_down", _status: 429, retryAfterS: 3 }, { ok: false, error: "slow_down", _status: 429, retryAfterS: 3 }, { ok: true, status: "confirmed" }];
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE(), "/api/swap/balances": { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: {} }, "/api/swap/tx": TX(), "/api/swap/status": () => statuses.shift() || { ok: true, status: "confirmed" } } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.25"); click(P.$(".swap__go")); await P.flush(); // Review
  click(P.$(".swap__go")); // Approve
  // the timers are stepped by hand here: the poll's waits are the point of the test
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  const runNext = async (ms) => { await settle(); const idx = P.timers.findIndex((t) => t && t.ms === ms); assert.ok(idx >= 0, `a ${ms} ms timer is pending (pending: ${JSON.stringify(P.timers.filter(Boolean).map((t) => t.ms))})`); const t = P.timers[idx]; P.timers[idx] = null; t.fn(); await settle(); };
  await runNext(1200); // the first poll (after 1.2 s) is refused
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status"))], ["Confirming…", "Still checking with the network… this can take a moment. Nothing more to sign."], "a refused poll is not silence");
  await runNext(4000); // the next poll waits twice the usual 2 s (Retry-After 3 s is under that floor); refused again
  assert.equal(text(P.$(".swap__state")), "Confirming…");
  await runNext(4000); // answered: confirmed
  assert.equal(text(P.$(".swap__state")), "Swapped ✓", "the confirmed answer wins once the polls are answered again");
  // the words for a trade still pending after the whole watch
  assert.match(P.win.VSwap.words({ error: "unconfirmed" }), /^We could not confirm it in time\. Open the Solscan link or check your wallet: if it went through, your balance already shows it; if not, nothing was spent\.$/);
  assert.match(P.win.VSwap.words({ error: "bad_ticket" }), /not built here/);
});

test("swap panel: open() retires the previous panel (one live panel per sheet), closing the sheet retires it too, mount() on a reused slot retires the old one; refresh() sees only live panels", async () => {
  const P = await page({ answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE() }, slot: "" });
  const a = await P.VSwap.open({ out: VIC }); await P.flush();
  const b = await P.VSwap.open({ out: USDC, in: "SOL", mode: "swap" }); await P.flush();
  assert.ok(a.dead && !b.dead, "the first panel is retired when the second opens");
  assert.deepEqual([...P.VSwap._panels].map((p) => p === b), [true], "exactly one live panel");
  assert.equal(P.listeners.length >= 1, true);
  const sheet = P.$(".swap-sheet");
  click(sheet.querySelector(".swap-sheet__close"));
  sheet.dispatchEvent(newEvent("close"));
  assert.ok(b.dead, "closing the sheet retires its panel");
  assert.equal(P.VSwap._panels.size, 0);
  // a slot mounted again (the dashboard changes the route): the old panel goes
  const slot = P.doc.createElement("div"); slot.setAttribute("data-swap", ""); P.doc.body.append(slot);
  const m1 = await P.VSwap.mount(slot, { out: VIC }); await P.flush();
  slot.removeAttribute("data-swap-mounted");
  const m2 = await P.VSwap.mount(slot, { out: USDC, mode: "swap" }); await P.flush();
  assert.ok(m1.dead && !m2.dead && P.VSwap._panels.size === 1);
  // a retired panel ignores late answers: no render after destroy
  m2.destroy();
  assert.equal(P.VSwap._panels.size, 0);
});

test("swap panel: numbers by magnitude; the platform fee, when the owner sets one, is in the fee line and the footer (never a fixed 'takes no fee')", async () => {
  const P = await page({ answers: { "/api/swap/config": { ...CONFIG, platformFeeBps: 50 }, "/api/swap/quote": QUOTE({ fees: { networkLamports: 5000, priorityLamportsMax: 300, platformFeeBps: 50, rentLamports: 2039280 } }) } });
  const n = P.win.VSwap.num;
  assert.deepEqual(["178332.440476", "89166.220238", "1234.5", "1.49", "12.5", "0.004749928", "0.000005", "2", "0.25"].map((v) => n(v)), ["178,332.44", "89,166.22", "1,234.5", "1.49", "12.5", "0.00474993", "0.000005", "2", "0.25"]);
  await type(P, "0.25");
  assert.equal(P.$$(".swap__details dd").map(text)[2], "network ≈ 0.000005 SOL · priority ≤ 0.0000003 SOL · 0.5% platform fee");
  assert.match(text(P.$(".swap__foot")), /Vicinity never touches your funds and takes a 0\.5% platform fee\./);
  const Q = await page({ answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE() } });
  await type(Q, "0.25");
  assert.match(text(Q.$(".swap__foot")), /takes no fee\./);
});

test("swap panel: a curve trade whose quote says the platform's referral account is missing shows that rent as NOT returned; one that does not says nothing", async () => {
  const curveQuote = (over = {}) => ({ ok: true, quoteId: "c1", source: "curve", side: "buy", inputMint: SOL, outputMint: CITY, decimals: { in: 9, out: 6 }, inAmount: "5000000", outAmount: "13286006275533", minOut: "13153146212777", inUi: "0.005", outUi: "13286006.275533", minOutUi: "13153146.212777", slippageBps: 100, priceImpactPct: "1.32", refund: "0", partialFill: false, route: ["Meteora bonding curve"], fees: { curveFeeBps: 125, networkLamports: 5000, split: {}, referralRentLamports: 2039280, referralNote: "about 0.002 SOL re-creates the platform's fee account for this coin's pair token and is not returned to you", ...over }, chain: "solana:devnet", cluster: "devnet", poweredBy: "Meteora DBC", expiresAt: new Date(Date.now() + 12000).toISOString() });
  const answers = { "/api/swap/config": CONFIG, "/api/swap/quote": { ok: true, source: "curve", mint: CITY, side: "buy", chain: "solana:devnet", cluster: "devnet", quoteMint: SOL, useRoute: "/api/launchpad/trade" }, "/api/launchpad/trade/quote": curveQuote() };
  const P = await page({ answers, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>` });
  await type(P, "0.005");
  const dds = P.$$(".swap__details dd");
  assert.equal(text(dds[2]), "1.25% curve fee · network ≈ 0.000005 SOL");
  assert.deepEqual([dds[4].hidden, text(dds[4])], [false, "about 0.002 SOL re-creates the platform's fee account for this coin's pair token and is not returned to you"]);
  const Q = await page({ answers: { ...answers, "/api/launchpad/trade/quote": curveQuote({ referralRentLamports: 0, referralNote: null }) }, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>` });
  await type(Q, "0.005");
  assert.equal(Q.$$(".swap__details dd")[4].hidden, true);
});

/* ---------------------------------------------------------------- the words on the pages, behind the switch */
const HOME = `<body data-page="home"><ol class="buy-steps"><li class="card"><span class="buy-steps__n">2</span><h3>Add SOL</h3><p class="muted">Buy SOL in the wallet app.</p></li><li class="card"><span class="buy-steps__n">3</span><h3>Buy on Raydium</h3><p class="muted">On Raydium LaunchLab, only through the <strong>Buy on Raydium</strong> button on our <a href="/token#buy">Token page</a>, so you get the real $VICINITY.</p></li></ol><p class="scam-note"><strong>The only real Raydium is raydium.io.</strong> Look-alike addresses copy it to empty wallets.</p><details id="buy-faq"><summary>How do I buy $VICINITY?</summary><p>Get a Solana wallet (Phantom, Solflare or Backpack), add SOL, then use the <strong>Buy on Raydium</strong> button on the <a href="/token#buy">Token page</a>. It opens the official $VICINITY on Raydium LaunchLab (raydium.io). Look-alike sites that copy Raydium are scams that empty wallets.</p></details></body>`;
/** A page whose <body data-page> and markup are given, with /api/official already read by site.js (window.V.official). */
async function pageWith(body, { official, answers = {} }) {
  const doc = new Doc();
  doc.append(...parse(doc, `<html>${body}</html>`));
  const calls = [];
  const answer = async (path) => { calls.push(path); const a = answers[path.split("?")[0]]; return a === undefined ? { ok: false, error: "not_found", _status: 404 } : a; };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const win = new Target();
  Object.assign(win, { document: doc, location: { href: "https://vicinity.test/" }, console,
    V: { $: (s, r = doc) => r.querySelector(s), $$: (s, r = doc) => r.querySelectorAll(s), el, api: answer, toast() {}, copy() {}, burst() {}, isAddr: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a)), official: Promise.resolve(official) },
    VW: { KNOWN: [], isMobile: false, list: () => [], onChange() {}, safeIcon: () => null, mark: () => el("span") },
    fetch: async (path) => ({ ok: false, status: 404, json: async () => answer(path) }), setTimeout: () => 0, clearTimeout() {}, AbortController, atob, btoa, Uint8Array, TextEncoder, Promise, Array, Object, String, Number, Math, JSON, Date, Boolean, Error });
  win.window = win; doc.defaultView = win;
  vm.runInContext(SWAP_JS, vm.createContext(win), { filename: "public/swap.js" });
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  return { doc, win, calls, $: (s) => doc.querySelector(s), $$: (s) => doc.querySelectorAll(s) };
}

test("copy behind the switch: on the home page with the swap ON the 'Buy on Raydium' step and FAQ say Buy here (routed by Jupiter, executed on Raydium LaunchLab); no /api/swap/config is asked when nothing mounts", async () => {
  const P = await pageWith(HOME, { official: { swap: true, tokenContract: VIC } });
  assert.equal(text(P.$$(".buy-steps h3")[1]), "Buy here");
  assert.equal(text(P.$$(".buy-steps h3")[0]), "Add SOL", "the other steps are untouched");
  const step = P.$$(".buy-steps p")[1];
  assert.match(text(step), /^Right here, on our Token page: the Buy panel quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet, so you get the real \$VICINITY without leaving vicinity\.city\.$/);
  assert.equal(step.querySelector("a").getAttribute("href"), "/token#buy-slot", "the link goes to the panel");
  assert.match(text(P.$("#buy-faq p")), /^Get a Solana wallet \(Phantom, Solflare or Backpack\), add SOL, then use the Buy panel on the Token page\. It quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet; you never leave this site\. Look-alike sites that copy Raydium are scams that empty wallets\.$/);
  assert.doesNotMatch(text(P.$("#buy-faq p")), /raydium\.io/, "nobody is sent to raydium.io");
  assert.match(text(P.$(".scam-note")), /The only real Raydium is raydium\.io/, "the warning about look-alikes stays");
  assert.deepEqual(P.calls, [], "the switch came from /api/official, which the page reads anyway: nothing else was asked");
  assert.equal(P.$$(".buy-steps p")[1].dataset.swapCopy, "1", "marked, so a second sweep leaves it alone");
  P.win.VSwap.copySweep();
  assert.equal(P.$$(".buy-steps h3")[1].textContent, "Buy here");
});

test("copy behind the switch: with the swap OFF (no swap key in /api/official) every word stays exactly as it is and nothing is asked", async () => {
  const P = await pageWith(HOME, { official: { tokenContract: VIC } });
  assert.equal(text(P.$$(".buy-steps h3")[1]), "Buy on Raydium");
  assert.match(text(P.$("#buy-faq p")), /use the Buy on Raydium button on the Token page\. It opens the official \$VICINITY on Raydium LaunchLab \(raydium\.io\)/);
  assert.deepEqual(P.calls, []);
  const slot = await pageWith(`<body data-page="token"><div id="buy-slot" data-swap data-out="${VIC}"></div></body>`, { official: { tokenContract: VIC } });
  assert.equal(slot.$("#buy-slot").hidden, true, "a slot on a page is hidden without a request");
  assert.deepEqual(slot.calls, []);
});

test("copy behind the switch: the token page's FAQ step and the Launchpad's honesty line (its links kept) change; a slot on the page still mounts through /api/swap/config", async () => {
  const T = await pageWith(`<body data-page="token"><details id="buy"><ol class="faq__steps"><li><strong>Add SOL.</strong> Keep a little extra.</li><li><strong>Buy on Raydium.</strong> Use the <strong>Buy on Raydium</strong> button at the top of this page. It opens the official $VICINITY on Raydium LaunchLab (raydium.io); the contract address there must match the one here.</li></ol></details><div id="buy-slot" data-swap data-out="${VIC}" data-in="SOL" data-mode="buy"></div></body>`,
    { official: { swap: true, tokenContract: VIC }, answers: { "/api/swap/config": CONFIG } });
  const steps = T.$$("#buy li").map(text);
  assert.equal(steps[0], "Add SOL. Keep a little extra.");
  assert.equal(steps[1], "Buy here. Use the Buy panel under the contract address at the top of this page: it quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet. You never leave vicinity.city.");
  assert.equal(T.$$("#buy li")[1].querySelector("strong").textContent, "Buy here.");
  assert.deepEqual(T.calls, ["/api/swap/config"], "the panel on the page needed the config, once");
  assert.equal(T.$("#buy-slot").getAttribute("data-swap-mounted"), "1");
  const L = await pageWith(`<body data-page="launchpad"><p class="tiny muted lp-honesty" id="lp-honesty">Prices from <a href="https://jup.ag">Powered by Jupiter</a>. They refresh every 30 seconds. You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds.</p></body>`, { official: { swap: true } });
  assert.equal(text(L.$("#lp-honesty")), "Prices from Powered by Jupiter. They refresh every 30 seconds. You buy and sell here, in your own wallet (routed by Jupiter, executed on Raydium LaunchLab or the Meteora curve); Vicinity never touches your funds.");
  assert.equal(L.$("#lp-honesty a").getAttribute("href"), "https://jup.ag", "the attribution link survives the sweep");
  assert.equal(L.win.VSwap.tradeSentence, "You buy and sell here, in your own wallet (routed by Jupiter, executed on Raydium LaunchLab or the Meteora curve); Vicinity never touches your funds.");
  // launchpad.js writes the same sentence when it redraws the line with the answer's attribution (source check: the words live in swap.js)
  const lp = readFileSync(new URL("../public/launchpad.js", import.meta.url), "utf8");
  assert.match(lp, /const trade = swapOn && window\.VSwap && window\.VSwap\.tradeSentence \? window\.VSwap\.tradeSentence : "You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds\.";/);
  assert.match(lp, /says how old its numbers are\. \$\{trade\}`\);/);
});
