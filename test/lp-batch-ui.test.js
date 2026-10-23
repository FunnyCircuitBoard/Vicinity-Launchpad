// The owner's daily approval round in the page (COIN_V2_BATCH): public/lp-sign.js LP.signAll with Node's WebCrypto and the REAL Worker
// relay behind a fake fetch (one prompt for every transaction; nothing is sent unless every message comes back byte for byte with a
// valid signature; then each is sent in order and watched), public/wallets.js signAllTransactions (the Wallet Standard's many-input
// signTransaction), and the "Launch approvals to sign" card of public/admin-lp.js in the just-enough DOM of test/helpers/pagedom.js
// (the four groups, masked founders with the full wallet on hover, versions and checks; unticking leaves a city out of what is echoed;
// every built transaction is checked against the rows shown before the wallet opens; one prompt for all, or one at a time with each next
// transaction built again; every landed one recorded with step "batch"). textContent only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { handleApi } from "../src/index.js";
import { _resetLpKit, buildTx } from "../src/lpkit.js";
import { _resetRelay } from "../src/relay.js";
import { base58Encode } from "../src/solana.js";
import { decodeHeader } from "../src/sol/message.js";
import { systemTransfer } from "../src/sol/ix.js";
import { newWorld, ORIGIN } from "./helpers/world.js";
import { LP_ON, addr, lpChain } from "./helpers/lpchain.js";
import { openPage, newEvent } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const SIGN = read("public/lp-sign.js"), ADMIN_LP = read("public/admin-lp.js"), WALLETS = read("public/wallets.js"), CSS = read("public/admin.css");
const tick = async (n = 16) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------------------------------------------------------------- LP.signAll against the real relay */
vm.runInThisContext(SIGN, { filename: "lp-sign.js" });
const LP = globalThis.LP;
LP._pollMs = 1;
let env, chain, sends;
beforeEach(() => {
  _resetLpKit(); _resetRelay();
  env = { ...newWorld(), ...LP_ON };
  chain = lpChain();
  sends = [];
  globalThis.fetch = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", ORIGIN);
    if (path.startsWith("/api/swap/send")) sends.push(JSON.parse(init.body));
    return handleApi(new Request(ORIGIN + path, { method: init.method || "GET", headers, body: init.body }), env, chain.fetchImpl);
  };
});
/** A wallet with a Node key and signAllTransactions (`misbehave`: "change" one message, "badsig", "reject", "short" answers fewer). */
async function wallet({ misbehave = null } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const asked = [];
  const signOne = async (bytes, i) => {
    const tx = bytes.slice(), msgAt = 1 + 64 * tx[0];
    if (misbehave === "change" && i === 1) tx[tx.length - 1] ^= 1;
    tx.set(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, misbehave === "badsig" ? new Uint8Array([7]) : tx.subarray(msgAt))), 1);
    return tx;
  };
  return {
    address, asked, canSign: true,
    async signTransaction(bytes) { return signOne(bytes, 0); },
    async signAllTransactions(list, chainId) {
      asked.push({ n: list.length, chain: chainId });
      if (misbehave === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      const out = await Promise.all(list.map(signOne));
      return misbehave === "short" ? out.slice(0, 1) : out;
    },
  };
}
const builds = (payer, n = 3) => Promise.all(Array.from({ length: n }, (_, i) => buildTx(env, { payer, instructions: [systemTransfer(payer, addr(60 + i), BigInt(i + 1))] }, chain.fetchImpl)));

test("LP.signAll: one prompt for every transaction; each sent through the relay in order with its own ticket, then all watched", async () => {
  const w = await wallet();
  const res = await builds(w.address);
  const seen = [];
  const out = await LP.signAll({ wallet: w, responses: res, cluster: "devnet", onStatus: (i, s) => seen.push(`${i}:${s}`) });
  assert.equal(out.error, null);
  assert.deepEqual(w.asked, [{ n: 3, chain: "solana:devnet" }], "ONE prompt for the three");
  assert.equal(out.results.length, 3);
  assert.ok(out.results.every((r) => r && r.status === "confirmed"));
  assert.deepEqual(sends.map((s) => s.ticket), res.map((r) => r.ticket), "in order, each with its own build's ticket");
  assert.equal(chain.S.sent.length, 3);
  for (let i = 0; i < 3; i++) assert.equal(decodeHeader(chain.S.sent[i]).staticKeys[0], w.address);
  assert.deepEqual(seen.filter((x) => x.endsWith(":done")), ["0:done", "1:done", "2:done"]);
  assert.ok(seen.indexOf("2:sending") < seen.indexOf("0:done"), "all are sent before any is watched");
  assert.equal(LP.canSignAll(w), true);
  assert.equal(LP.canSignAll({ ...w, signAllTransactions: undefined }), false);
  assert.equal(LP.canSignAll({ ...w, canSign: false }), false);
});

test("LP.signAll: a changed message, a bad signature, a short answer, a cancel or another signer: refused in plain words and NOTHING is sent", async () => {
  for (const [m, code] of [["change", "changed"], ["badsig", "bad_signature"], ["short", "changed"], ["reject", "rejected"]]) {
    const w = await wallet({ misbehave: m });
    await assert.rejects(LP.signAll({ wallet: w, responses: await builds(w.address), cluster: "devnet" }), (e) => e.code === code, m);
  }
  const w = await wallet();
  const other = await wallet();
  await assert.rejects(LP.signAll({ wallet: w, responses: await builds(other.address), cluster: "devnet" }), (e) => e.code === "wrong_wallet");
  await assert.rejects(LP.signAll({ wallet: w, responses: await builds(w.address), cluster: "mainnet" }), (e) => e.code === "cluster_mismatch");
  // a transaction that needs a second signer (a one-time key) is never signed in a round
  const two = await buildTx(env, { payer: w.address, instructions: [systemTransfer(w.address, addr(70), 1n)], extraSigners: [addr(71)] }, chain.fetchImpl);
  await assert.rejects(LP.signAll({ wallet: w, responses: [two], cluster: "devnet" }), (e) => e.code === "unexpected_signer");
  await assert.rejects(LP.signAll({ wallet: { address: w.address, signTransaction() {} }, responses: [two], cluster: "devnet" }), (e) => e.code === "no_sign");
  assert.equal(w.asked.length, 0, "the wallet was never opened for a refused list");
  assert.equal(sends.length, 0);
  assert.equal(chain.S.sent.length, 0);
});

test("public/wallets.js: a Wallet Standard wallet signs several transactions in one call (solana:signTransaction with many inputs)", async () => {
  const calls = [];
  const std = {
    name: "Std", icon: "", chains: ["solana:mainnet"], accounts: [],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [{ address: "Acc111", chains: ["solana:mainnet"] }] }) },
      "solana:signMessage": { signMessage: async () => [{ signature: new Uint8Array(64) }] },
      "solana:signTransaction": { signTransaction: async (...inputs) => { calls.push(inputs); return inputs.map((x) => ({ signedTransaction: Uint8Array.from([...x.transaction, 9]) })); } },
    },
  };
  const listeners = {};
  const win = {
    navigator: { userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0", maxTouchPoints: 0 }, V: { webView: false }, console,
    addEventListener: (t, f) => (listeners[t] ||= []).push(f), dispatchEvent: () => true, setTimeout, clearTimeout,
    document: { hidden: false, addEventListener() {}, createElement: () => ({ style: {} }) }, location: { origin: "https://vicinity.test" },
  };
  win.window = win;
  vm.runInContext(WALLETS, vm.createContext(win), { filename: "public/wallets.js" });
  (listeners["wallet-standard:register-wallet"] || []).forEach((f) => f({ detail: (api) => api.register(std) }));
  const vw = win.VW;
  assert.ok(vw, "window.VW");
  const w = vw.list().find((x) => x.name === "Std");
  await w.connect();
  const out = await w.signAllTransactions([Uint8Array.of(1, 2), Uint8Array.of(3)], "solana:mainnet");
  assert.equal(calls.length, 1, "one call for both");
  assert.deepEqual(calls[0].map((x) => [x.account.address, [...x.transaction], x.chain]), [["Acc111", [1, 2], "solana:mainnet"], ["Acc111", [3], "solana:mainnet"]]);
  assert.deepEqual(out.map((x) => [...x]), [[1, 2, 9], [3, 9]]);
});

/* ---------------------------------------------------------------- the card */
const OWNER = "Own3r1111111111111111111111111111111111111";
const F = (n) => `F${n}under111111111111111111111111111111111111`.slice(0, 44);
const H = (c) => c.repeat(64);
const ROUND = {
  ok: true, global: [], paused: false, settled: 2, meteora: { state: "ok" }, rules: { days: 14, renewUnderHours: 48, perTx: 5, maxRows: 40 },
  groups: {
    approve: [
      { cityId: "5142056", cityName: "Utica", country: "US", action: "approve", founder: F(1), founderMasked: "F1und…1111", handle: "uticafan", name: "Utica", symbol: "UTICA", contentHash: H("a"), version: "aaaaaaaa", why: "A new founder's chosen coin: it passes every check.", checks: ["c1", "c2"], warnings: [] },
      { cityId: "5140405", cityName: "Syracuse", country: "US", action: "approve", founder: F(2), founderMasked: "F2und…1111", handle: null, name: "Syracuse", symbol: "SYRACUSE", contentHash: H("b"), version: "bbbbbbbb", why: "A new founder's chosen coin: it passes every check.", checks: ["c1"], warnings: [] },
    ],
    renew: [{ cityId: "5106834", cityName: "Albany", country: "US", action: "renew", founder: F(3), founderMasked: "F3und…1111", handle: null, name: "Albany", symbol: "ALBANY", contentHash: H("c"), version: "cccccccc", why: "It ends in 30 hours (renewed under 48).", checks: ["c1"], warnings: [],
      approval: { founder: F(3), founderMasked: "F3und…1111", name: "Albany", symbol: "ALBANY", expiresAt: "2026-10-21T18:00:00.000Z", rentPayer: OWNER } }],
    revoke: [{ cityId: "5128581", cityName: "New York City", country: "US", action: "revoke", founder: F(4), founderMasked: "F4und…1111", handle: null, name: "Big Apple", symbol: "NYC", contentHash: null, version: null, why: "The city has no founder now, but the approved wallet can still launch its coin on chain until the approval expires.", warnings: [],
      approval: { founder: F(4), founderMasked: "F4und…1111", name: "Big Apple", symbol: "NYC", expiresAt: "2026-10-30T12:00:00.000Z", rentPayer: OWNER } }],
    blocked: [{ cityId: "5101001", cityName: "Saratoga Springs", country: "US", name: "Saratoga Springs", symbol: "SARATOGASP", founderMasked: "F5und…1111", reasons: ["The founder's account is suspended (a ban), so nothing is approved for them."] }],
  },
};
const fields = (r) => ({ cityId: r.cityId, founder: r.founder, name: r.name, symbol: r.symbol, expiresAt: "2026-11-03T12:00:00.000Z" });
/** A built transaction for rows (as src/lpbatch.js answers it): the summary carries every approve_launch's and revoke_approval's fields. */
function txFor(rows, i) {
  const summary = [{ ix: "set_compute_unit_limit" }];
  for (const r of rows) {
    if (r.action !== "approve") summary.push({ ix: "revoke_approval", fields: { cityId: r.cityId } });
    if (r.action !== "revoke") summary.push({ ix: "approve_launch", fields: fields(r) });
  }
  return { ok: true, tx: "AA==", cluster: "mainnet", index: i, summary, signers: [OWNER], solChange: {}, cities: rows.map((r) => ({ cityId: r.cityId, cityName: r.cityName, action: r.action, founder: r.founder, name: r.name, symbol: r.symbol, contentHash: r.contentHash })),
    record: { step: "batch", params: { cities: rows.map((r) => ({ cityId: r.cityId, action: r.action })) } } };
}
async function card({ probe = { ok: true, cluster: "mainnet", batch: true }, round = ROUND, build = null, signAll = null, canAll = true } = {}) {
  const page = await openPage("admin.html", { agreed: "2026-10-01" });
  const win = page.window;
  win.setTimeout = (fn) => { setImmediate(fn); return 0; };
  const calls = [], signed = [], prepared = [];
  const answers = {
    "/api/admin/lp": probe, "/api/admin/lp/batch": round, "/api/admin/lp/status": { ok: true, cluster: "mainnet", wallet: OWNER, programs: { launchpad: { exists: true }, rewards: { exists: true } }, launchpad: { admin: OWNER }, problems: [], steps: [] },
    "/api/admin/lp/candidates": { ok: true, global: [], candidates: [], approvals: [], launched: [] }, "/api/admin/lp/coins": { ok: true, coins: [] }, "/api/admin/lp/platform/plan": { ok: true, claims: [], totals: { quote: "0", lamports: "0" }, transactions: 0 },
    "/api/admin/lp/summary": { ok: true, summary: {} },
    "/api/admin/lp/batch/tx": build || ((body) => { const rows = body.rows.map((x) => [...round.groups.approve, ...round.groups.renew, ...round.groups.revoke].find((r) => r.cityId === x.cityId)); return { ok: true, cluster: "mainnet", days: 14, expiresAt: "2026-11-03T12:00:00.000Z", dropped: [], transactions: [txFor(rows.slice(0, 2), 0), ...(rows.length > 2 ? [txFor(rows.slice(2), 1)] : [])] }; }),
    "/api/admin/lp/record": () => ({ ok: true }),
  };
  const reply = (path, body) => { const p = path.replace(/[?&]cluster=[a-z]+/, "").replace(/\?$/, ""); const a = answers[p]; return typeof a === "function" ? a(body) : a || { ok: false, error: "not_found" }; };
  const api = async (path) => { calls.push({ path }); return reply(path); };
  const post = async (path, body) => { calls.push({ path, body: plain(body), post: true }); return reply(path, body); };
  win.LP = {
    supported: async () => true, say: (code, extra) => (extra && extra.message) || `said:${code}`,
    renderSummary: (el, res) => { el.textContent = `summary ${res.index}`; },
    canSignAll: () => canAll,
    signAll: async ({ responses, onStatus }) => {
      signed.push(responses.map((r) => r.index));
      if (signAll) return signAll(responses, onStatus);
      responses.forEach((_, i) => onStatus(i, "done"));
      return { results: responses.map((_, i) => ({ signature: `Sig${i}`, status: "confirmed", solscan: null })), error: null, failedAt: null };
    },
    prepare: async ({ build: b }) => { const res = await b([]); prepared.push(res.index); return { response: res, keys: [], sign: async ({ onStatus }) => { onStatus("done"); return { signature: `One${prepared.length}`, status: "confirmed" }; } }; },
  };
  vm.runInContext(ADMIN_LP, win, { filename: "public/admin-lp.js" });
  const panel = page.doc.createElement("div");
  page.doc.body.append(panel);
  await win.AdminLP.mount(panel, { api, post, toast: () => {}, el: win.V.el, short: win.V.short, me: { wallet: OWNER, role: "owner" }, wallet: async () => ({ name: "Phantom", address: OWNER, signTransaction() {} }) });
  await tick();
  const button = (re) => panel.querySelectorAll("button").find((b) => re.test(b.textContent));
  return { page, win, panel, calls, signed, prepared, button, text: () => panel.textContent };
}

test("the card: shown only with the switch's probe key; four groups with every row's city, $TICKER, name, masked founder (full on hover), version and checks", async () => {
  const off = await card({ probe: { ok: true, cluster: "mainnet" } });
  assert.doesNotMatch(off.text(), /Launch approvals to sign/);
  assert.equal(off.calls.some((c) => c.path.startsWith("/api/admin/lp/batch")), false, "the round is never asked for");
  const t = await card();
  assert.match(t.text(), /Launch approvals to sign/);
  assert.match(t.text(), /Approve 2 · Renew 1 · Revoke 1 · Blocked 1 · 2 approvals on chain need nothing today/);
  const legends = t.panel.querySelectorAll("legend").map((l) => l.textContent);
  assert.deepEqual(legends, ["Approve (2)", "Renew (1)", "Revoke (1)"]);
  const rows = t.panel.querySelectorAll(".lp-round__row");
  assert.match(rows[0].textContent, /Utica \(US\) · \$UTICA “Utica”/);
  const founder = rows[0].querySelectorAll("span").find((s) => /F1und…1111/.test(s.textContent));
  assert.equal(founder.textContent, "@uticafan · F1und…1111");
  assert.equal(founder.getAttribute("title"), F(1), "the full wallet on hover");
  const version = rows[0].querySelectorAll("span").find((s) => s.textContent === "Version aaaaaaaa");
  assert.equal(version.getAttribute("title"), H("a"));
  assert.match(rows[0].textContent, /Checks ✓.*✓ c1.*✓ c2/);
  assert.match(rows[2].textContent, /On chain now“Albany” \(\$ALBANY\) for F3und…1111/);
  assert.match(t.text(), /Blocked \(1\): nothing is built for these.*Saratoga Springs.*suspended \(a ban\)/);
  assert.match(t.text(), /never a time/);
  assert.doesNotMatch(t.text(), /24 hours|tomorrow/);
  assert.ok(t.button(/^Sign today's approvals \(4 cities\)$/));
  for (const cls of ["lp-round", "lp-round__group", "lp-round__row", "lp-round__txs"]) assert.match(CSS, new RegExp(`\\.${cls}\\b`), cls);
  assert.doesNotMatch(ADMIN_LP, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(/);
});

test("BATCH-1: every row shows the description that goes into the metadata for ever and whose words it is; the founder's own start unticked", async () => {
  const round = structuredClone(ROUND);
  Object.assign(round.groups.approve[0], { description: "Utica coin: home of the half moon cookie and the tomato pie.", descriptionBy: "founder" });
  Object.assign(round.groups.approve[1], { description: "The city coin of Syracuse, New York, United States.", descriptionBy: "vicinity" });
  Object.assign(round.groups.renew[0], { description: "The city coin of Albany, New York, United States.", descriptionBy: "vicinity" });
  const t = await card({ round });
  const rows = t.panel.querySelectorAll(".lp-round__row");
  assert.match(rows[0].textContent, /Description \(in the coin's metadata for ever\)The founder's own wordsUtica coin: home of the half moon cookie and the tomato pie\./);
  assert.match(rows[1].textContent, /Description \(in the coin's metadata for ever\)Vicinity's sentenceThe city coin of Syracuse, New York, United States\./);
  assert.doesNotMatch(rows[3].textContent, /Description/, "a revoke approves nothing");
  const box = (id) => t.panel.querySelectorAll("input").find((i) => i.id === id);
  assert.equal(box("lp-round-approve-5142056").checked, false, "the founder's own words: the owner reads them, then ticks the city");
  assert.equal(box("lp-round-approve-5140405").checked, true);
  assert.match(t.text(), /1 city has a description in the founder's own words\. A reviewer approved it, and it goes into the coin's metadata for ever\. Read it too, then tick the city/);
  assert.ok(t.button(/^Sign today's approvals \(3 cities\)$/), "the unticked city is not in the count");
  // ticked by the owner, it is echoed like any other row
  box("lp-round-approve-5142056").checked = true; box("lp-round-approve-5142056").dispatchEvent(newEvent("change"));
  t.button(/^Sign today's approvals \(4 cities\)$/).click();
  await tick();
  const sent = t.calls.find((c) => c.path === "/api/admin/lp/batch/tx");
  assert.deepEqual(sent.body.rows.map((r) => r.cityId).sort(), ["5106834", "5128581", "5140405", "5142056"]);
  assert.match(CSS, /\.lp-desc\b/);
});

test("unticking leaves a city out; the build echoes exactly the ticked rows; one prompt signs all; each landed one is recorded with step batch", async () => {
  const t = await card();
  const box = t.panel.querySelectorAll("input").find((i) => i.id === "lp-round-approve-5140405");
  box.checked = false; box.dispatchEvent(newEvent("change"));
  assert.ok(t.button(/^Sign today's approvals \(3 cities\)$/));
  t.button(/^Sign today's approvals/).click();
  await tick();
  const sent = t.calls.find((c) => c.path === "/api/admin/lp/batch/tx");
  assert.deepEqual(sent.body.rows, [
    { cityId: "5142056", action: "approve", founder: F(1), name: "Utica", symbol: "UTICA", contentHash: H("a") },
    { cityId: "5106834", action: "renew", founder: F(3), name: "Albany", symbol: "ALBANY", contentHash: H("c") },
    { cityId: "5128581", action: "revoke", founder: F(4), name: "Big Apple", symbol: "NYC", contentHash: null },
  ]);
  assert.match(t.text(), /Transaction 1 of 2: approve Utica \(\$UTICA\), renew Albany \(\$ALBANY\)/);
  assert.match(t.text(), /Transaction 2 of 2: revoke New York City \(\$NYC\)/);
  t.button(/^Sign all 2 in your wallet \(one prompt\)$/).click();
  await tick(30);
  assert.deepEqual(t.signed, [[0, 1]]);
  const recs = t.calls.filter((c) => c.path === "/api/admin/lp/record");
  assert.deepEqual(recs.map((r) => [r.body.step, r.body.signature, r.body.params]), [
    ["batch", "Sig0", { cities: [{ cityId: "5142056", action: "approve" }, { cityId: "5106834", action: "renew" }] }],
    ["batch", "Sig1", { cities: [{ cityId: "5128581", action: "revoke" }] }],
  ]);
  assert.match(t.text(), /Done and recorded\..*Done and recorded\./);
});

test("a built transaction that is not exactly the rows shown (another name, an extra instruction, a city not shown) is never signed", async () => {
  for (const tamper of [
    (tx) => { tx.summary.find((x) => x.ix === "approve_launch").fields.name = "Other"; },
    (tx) => { tx.summary.push({ ix: "transfer" }); },
    (tx) => { tx.cities.push({ cityId: "9", action: "approve" }); },
    (tx) => { tx.summary = tx.summary.filter((x) => x.ix !== "revoke_approval"); },
  ]) {
    const t = await card({ build: (body) => { const rows = body.rows.map((x) => [...ROUND.groups.approve, ...ROUND.groups.renew, ...ROUND.groups.revoke].find((r) => r.cityId === x.cityId)); const tx = txFor(rows, 0); tamper(tx); return { ok: true, cluster: "mainnet", days: 14, expiresAt: "2026-11-03T12:00:00.000Z", dropped: [], transactions: [tx] }; } });
    t.button(/^Sign today's approvals/).click();
    await tick();
    assert.match(t.text(), /A transaction the site built holds .*Nothing was sent/);
    assert.equal(t.button(/Sign all|Sign transaction/), undefined);
    assert.deepEqual([t.signed.length, t.prepared.length], [0, 0]);
  }
});

test("a wallet that changes transactions signed together: nothing sent, remembered, then one at a time (each next one built again just before)", async () => {
  const t = await card({ signAll: async () => { throw Object.assign(new Error("changed"), { code: "changed" }); } });
  t.button(/^Sign today's approvals/).click();
  await tick();
  t.button(/^Sign all 2/).click();
  await tick();
  assert.match(t.text(), /changed the transactions when signing them together, so nothing was sent/);
  assert.equal(t.page.storage.get("vicinity_lp_batch_one"), JSON.stringify(["Phantom"]));
  t.button(/^Sign one at a time$/).click();
  await tick();
  t.button(/^Sign transaction 1 of 2$/).click();
  await tick(30);
  // each one is built again just before it is signed (a fresh blockhash), with exactly its own rows
  const builds = t.calls.filter((c) => c.path === "/api/admin/lp/batch/tx");
  assert.equal(builds.length, 3);
  assert.deepEqual(builds[1].body.rows.map((r) => r.cityId), ["5142056", "5140405"]);
  assert.deepEqual(builds[2].body.rows.map((r) => r.cityId), ["5106834", "5128581"]);
  t.button(/^Sign transaction 2 of 2$/).click();
  await tick(30);
  assert.equal(t.calls.filter((c) => c.path === "/api/admin/lp/record").length, 2);
  // the next round on this browser asks one at a time from the start
  const t2 = await card();
  t2.page.storage.set("vicinity_lp_batch_one", JSON.stringify(["Phantom"]));
  t2.button(/^Sign today's approvals/).click();
  await tick();
  assert.ok(t2.button(/^Sign transaction 1 of 2$/));
  assert.equal(t2.button(/^Sign all/), undefined);
});
