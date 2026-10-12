// public/lp-sign.js (window.LP) with Node's WebCrypto Ed25519 and the REAL Worker relay behind a fake fetch: one-time keys that
// are not extractable; 1 to 3 of them signing FIRST at their own static-key slots (the wallet's slot 0 left empty); a wallet that
// sends (signAndSendTransaction, like Phantom) then signs and sends itself and our relay is not used; a wallet that only signs is
// held to the strict path (a changed message, a wrong signature, the wrong account or a cancel is refused with plain words and
// nothing is sent; otherwise the relay sends with the ticket); an outcome nobody knows is never worded "nothing was sent", not even
// on a second tap; the summary is built with textContent only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { handleApi } from "../src/index.js";
import { _resetLpKit, buildTx } from "../src/lpkit.js";
import { _resetRelay } from "../src/relay.js";
import { base58Decode, base58Encode } from "../src/solana.js";
import { decodeHeader } from "../src/sol/message.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { systemTransfer } from "../src/sol/ix.js";
import { newWorld, ORIGIN } from "./helpers/world.js";
import { LP_ON, addr, lpChain } from "./helpers/lpchain.js";

const SRC = readFileSync(new URL("../public/lp-sign.js", import.meta.url), "utf8");
vm.runInThisContext(SRC, { filename: "lp-sign.js" });
const LP = globalThis.LP;
LP._pollMs = 1;
const createAccount = (from, to) => ({ programAddress: PROGRAM_IDS.system, accounts: [{ address: from, role: 3 }, { address: to, role: 3 }], data: Uint8Array.of(0, 0, 0, 0, ...new Uint8Array(8).fill(1), ...new Uint8Array(8), ...new Uint8Array(32)) });

/**
 * A wallet with a Node key: signs its own slot (slot 0) of whatever it is given, or does `misbehave` first ("strip": gives back
 * its own signature only, the other slots emptied). With `send` it also signs AND sends (signAndSendTransaction, like Phantom):
 * straight to the fake chain (its own node, not our relay), answering its 64-byte signature; like Phantom it changes a transaction
 * that no other key signed yet before it signs it (its own protection instructions), and leaves one that others signed as it is.
 * Its own ways to go wrong: "reject" (code 4001), "closed" (a closed window, no code), "fail" (any other error), "blockhash" (a
 * wallet on the wrong network fails its own check), "nosig" (answers nothing), "vwnosig" (public/wallets.js: the call answered
 * without a 64-byte signature, code no_signature), "drop" (signs and answers its signature, but the transaction never lands).
 * `canSend: false` is how public/wallets.js marks a wallet that only signs.
 */
async function wallet({ misbehave = null, send = false, canSend } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const asked = [], sendAsked = [];
  const w = {
    address, asked, sendAsked, canSign: true,
    async signTransaction(bytes, chainId) {
      asked.push({ bytes: bytes.slice(), chain: chainId });
      if (misbehave === "reject") throw new Error("User rejected the request.");
      const tx = bytes.slice();
      const n = tx[0], msgAt = 1 + 64 * n;
      if (misbehave === "change") tx[tx.length - 1] ^= 1; // e.g. a wallet that rewrote the last instruction
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, misbehave === "badsig" ? new Uint8Array([9]) : tx.subarray(msgAt)));
      tx.set(sig, 1);
      if (misbehave === "strip") tx.fill(0, 65, msgAt);
      return tx;
    },
  };
  if (send) {
    w.signAndSendTransaction = async (bytes, chainId, options) => {
      sendAsked.push({ bytes: bytes.slice(), chain: chainId, options });
      if (misbehave === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      if (misbehave === "closed") throw new Error("Plugin Closed");
      if (misbehave === "fail") throw Object.assign(new Error("Unexpected error"), { code: -32603 });
      if (misbehave === "blockhash") throw new Error("Transaction simulation failed: Blockhash not found");
      if (misbehave === "nosig") return undefined;
      if (misbehave === "vwnosig") throw Object.assign(new Error("The wallet gave back no signature."), { code: "no_signature" });
      const tx = bytes.slice();
      const n = tx[0], msgAt = 1 + 64 * n;
      if (tx.subarray(65, msgAt).every((b) => b === 0)) tx[tx.length - 1] ^= 1; // signed by no one else yet: the wallet adds its own
      tx.set(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, tx.subarray(msgAt))), 1);
      if (misbehave !== "drop") await chain.fetchImpl("https://wallet-node.test", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(tx).toString("base64"), { encoding: "base64" }] }) });
      return tx.slice(1, 65);
    };
  }
  if (canSend !== undefined) w.canSend = canSend;
  return w;
}

let env, chain, sends, polls;
beforeEach(() => {
  _resetLpKit(); _resetRelay();
  env = { ...newWorld(), ...LP_ON };
  chain = lpChain();
  sends = []; polls = [];
  // the page's fetch: the real Worker (relay and status) for /api/..., with this site's Origin like a browser
  globalThis.fetch = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", ORIGIN);
    const req = new Request(ORIGIN + path, { method: init.method || "GET", headers, body: init.body });
    if (path.startsWith("/api/swap/send")) sends.push(JSON.parse(init.body));
    if (path.startsWith("/api/swap/status")) polls.push(new URL(ORIGIN + path).searchParams.get("sig"));
    return handleApi(req, env, chain.fetchImpl);
  };
});
const build = (payer) => async (pubkeys) => buildTx(env, { payer, instructions: pubkeys.length ? pubkeys.map((k) => createAccount(payer, k)) : [systemTransfer(payer, addr(77), 1n)], extraSigners: pubkeys }, chain.fetchImpl);
/** Every slot from `from` on carries its own key's valid signature over the message (from = 1: the one-time keys only). */
async function verifySlots(tx, from = 0) {
  const d = decodeHeader(tx);
  const message = tx.subarray(d.messageOffset);
  for (let i = from; i < d.numSignatures; i++) {
    const key = await crypto.subtle.importKey("raw", base58Decode(d.staticKeys[i]), { name: "Ed25519" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, key, tx.subarray(1 + 64 * i, 65 + 64 * i), message), `slot ${i} (${d.staticKeys[i].slice(0, 6)}) carries its own key's signature`);
  }
  return d;
}

test("LP.supported and LP.ephemeral: WebCrypto Ed25519, the private half not extractable, a valid public key per key", async () => {
  assert.equal(await LP.supported(), true);
  const keys = await LP.ephemeral(3);
  assert.equal(new Set(keys.map((k) => k.publicKey)).size, 3);
  for (const k of keys) {
    assert.equal(base58Decode(k.publicKey).length, 32);
    assert.deepEqual(Object.keys(k).sort(), ["publicKey", "sign"], "nothing but the public key and a sign function");
    const sig = await k.sign(new Uint8Array([1, 2, 3]));
    const pub = await crypto.subtle.importKey("raw", base58Decode(k.publicKey), { name: "Ed25519" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, new Uint8Array([1, 2, 3])));
  }
  assert.deepEqual(await LP.ephemeral(0), []);
  await assert.rejects(LP.ephemeral(4), (e) => e.code === "unexpected_signer");
  // a browser without Ed25519: no fallback, the page explains
  const ctx = vm.createContext({ crypto: { subtle: { generateKey: async () => { throw new Error("NotSupportedError"); } } }, atob, btoa, setTimeout, TextEncoder, Uint8Array });
  vm.runInContext(SRC, ctx);
  assert.equal(await ctx.LP.supported(), false);
  await assert.rejects(ctx.LP.ephemeral(1), (e) => e.code === "unsupported" && /up-to-date Chrome or Safari, or in Phantom's own browser/.test(e.message));
});

for (const n of [1, 2, 3]) {
  test(`LP.run, a wallet that only signs: ${n} one-time key(s) sign first at their own slots, then the wallet, the relay sends, the status confirms`, async () => {
    const w = await wallet();
    const seen = [], statuses = [];
    const out = await LP.run({ wallet: w, build: build(w.address), ephemeral: n, cluster: "devnet", onSummary: (res) => { seen.push(res); return true; }, onStatus: (s) => statuses.push(s) });
    assert.equal(out.status, "confirmed");
    assert.match(out.solscan, /cluster=devnet/);
    assert.equal(w.asked.length, 1);
    assert.equal(w.asked[0].chain, "solana:devnet");
    // what the wallet was shown: the one-time keys' signatures already in place, its own slot (0) still empty
    const shown = w.asked[0].bytes;
    assert.ok(shown.subarray(1, 65).every((b) => b === 0), "the wallet's own slot was empty");
    await verifySlots(shown, 1);
    assert.deepEqual(statuses, ["signing", "sending", "confirming", "done"]);
    assert.equal(seen.length, 1);
    assert.equal(chain.S.sent.length, 1);
    const d = await verifySlots(chain.S.sent[0]);
    assert.equal(d.numSignatures, n + 1);
    assert.equal(d.staticKeys[0], w.address, "the wallet pays");
    assert.equal(sends[0].cluster, "devnet");
  });
}

test("LP: a wallet that changed the message, signed wrongly, cancelled, or is the wrong account: refused in plain words, nothing sent", async () => {
  const changer = await wallet({ misbehave: "change" });
  await assert.rejects(LP.run({ wallet: changer, build: build(changer.address), ephemeral: 1, cluster: "devnet" }), (e) => e.code === "changed" && /changed the transaction/.test(e.message));
  const bad = await wallet({ misbehave: "badsig" });
  await assert.rejects(LP.run({ wallet: bad, build: build(bad.address), ephemeral: 2, cluster: "devnet" }), (e) => e.code === "bad_signature");
  const no = await wallet({ misbehave: "reject" });
  await assert.rejects(LP.run({ wallet: no, build: build(no.address), ephemeral: 1, cluster: "devnet" }), (e) => e.code === "rejected" && /cancelled/.test(e.message));
  const other = await wallet();
  const w = await wallet();
  await assert.rejects(LP.run({ wallet: w, build: build(other.address), ephemeral: 1, cluster: "devnet" }), (e) => e.code === "wrong_wallet");
  assert.equal(w.asked.length, 0, "the wrong account's wallet was never opened");
  await assert.rejects(LP.run({ wallet: w, build: build(w.address), ephemeral: 1, cluster: "mainnet" }), (e) => e.code === "cluster_mismatch");
  await assert.rejects(LP.run({ wallet: w, build: build(w.address), ephemeral: 1, cluster: "devnet", onSummary: () => false }), (e) => e.code === "cancelled");
  await assert.rejects(LP.run({ wallet: { address: w.address }, build: build(w.address) }), (e) => e.code === "no_sign");
  await assert.rejects(LP.run({ wallet: null, build: build(w.address) }), (e) => e.code === "no_wallet");
  assert.equal(sends.length, 0);
  assert.equal(chain.S.sent.length, 0);
});

test("LP: the build's own errors and the relay's become plain words; a failed or expired transaction says so", async () => {
  const w = await wallet();
  await assert.rejects(LP.run({ wallet: w, build: async () => ({ ok: false, error: "insufficient_sol" }) }), (e) => e.code === "insufficient_sol" && /enough SOL/.test(e.message));
  await assert.rejects(LP.run({ wallet: w, build: async () => ({ ok: false, error: "program_error", name: "ApprovalExpired", programName: "Vicinity launchpad" }) }),
    (e) => e.message === "The program refused this step (Vicinity launchpad): ApprovalExpired. Nothing was sent.");
  await assert.rejects(LP.run({ wallet: w, build: async () => ({ ok: false, error: "reprove" }) }), (e) => /confirm it's you/.test(e.message));
  await assert.rejects(LP.run({ wallet: w, build: async () => null }), (e) => e.code === "rpc_unavailable");
  // the relay refuses (a forged ticket): the plain words of bad_ticket
  await assert.rejects(LP.run({ wallet: w, build: async (k) => ({ ...(await build(w.address)(k)), ticket: "1.x" }), ephemeral: 1 }), (e) => e.code === "bad_ticket");
  // landed but failed on chain
  const orig = chain.fetchImpl;
  chain.fetchImpl = async (url, init) => { const r = await orig(url, init); const b = JSON.parse(init.body); if (b.method === "sendTransaction") { const sig = (await r.clone().json()).result; chain.S.statuses[sig] = { slot: 5, err: { InstructionError: [2, { Custom: 1 }] }, confirmationStatus: "confirmed" }; } return r; };
  await assert.rejects(LP.run({ wallet: w, build: build(w.address), ephemeral: 1 }), (e) => e.code === "failed" && typeof e.signature === "string");
  assert.equal(LP.say("nonsense"), "Something went wrong. Nothing was sent. Start again.");
});

test("LP.renderSummary: the network, the SOL change and every instruction in plain words, with textContent only", async () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(SRC), "no HTML is ever written");
  const w = await wallet();
  const res = await build(w.address)([]);
  const made = [];
  const node = (tag) => { const n = { tag, className: "", children: [], _text: "", append(...c) { this.children.push(...c); }, set textContent(v) { this._text = v; this.children = []; }, get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); } }; made.push(n); return n; };
  const doc = { createElement: node };
  const el = node("div"); el.ownerDocument = doc;
  const approved = `the coin "Utica Coin", ticker $UTICA, founder wallet ${addr(7)}, who can launch it until 2026-10-27 12:00 UTC`;
  LP.renderSummary(el, { ...res, summary: [...res.summary, { programName: "Vicinity launchpad", ix: "approve_launch", say: "approve a city coin", detail: approved, accounts: [{ address: addr(8), role: "writable", label: "<img src=x onerror=alert(1)>" }] }],
    solChange: { [w.address]: -2_039_280 - 5000, [addr(9)]: 2_039_280 } });
  const text = el.textContent;
  assert.match(text, /Solana devnet \(test network\)/);
  assert.match(text, /Your wallet: −0\.00204428 SOL \(network fee included\)/);
  assert.match(text, /\+0\.00203928 SOL/);
  assert.match(text, /Compute budget: set the compute limit \(set_compute_unit_limit\)/);
  assert.match(text, /Vicinity launchpad: approve a city coin \(approve_launch\)/);
  assert.ok(text.includes(` · ${approved}`), "what an approval fixes on chain (name, ticker, founder, expiry) is in the rendered list, not only in the instruction data");
  assert.match(text, /<img src=x onerror=alert\(1\)>/, "a label is shown as text, never parsed");
  assert.match(text, /Signed by your wallet only/);
  LP.renderSummary(el, { ...res, cluster: "mainnet" });
  assert.match(el.textContent, /Solana MAINNET: real SOL/);
  LP.renderSummary(el, { ok: false, error: "insufficient_sol" });
  assert.match(el.textContent, /enough SOL/);
});

test("LP: a send whose outcome is unclear (the relay's unclear: true, or no answer from the site at all) is watched by the wallet's own signature, never 'nothing was sent'", async () => {
  const w = await wallet();
  // 1. the relay answers unclear: true (src/relay.js, after a timeout of the node that had the bytes): the page watches that signature
  const real = globalThis.fetch;
  const relayUnclear = async (path, init) => {
    const r = await real(path, init);
    if (!String(path).startsWith("/api/swap/send")) return r;
    const d = await r.json();
    return new Response(JSON.stringify({ ...d, unclear: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = relayUnclear;
  const statuses = [];
  const out = await LP.run({ wallet: w, build: build(w.address), ephemeral: 1, cluster: "devnet", onStatus: (s, sig, extra) => statuses.push([s, Boolean(extra && extra.unclear)]) });
  assert.equal(out.status, "confirmed");
  assert.deepEqual(statuses, [["signing", false], ["sending", false], ["confirming", true], ["done", false]]);
  // 2. the site never answered the send (a dropped connection, a gateway's error page) although the relay passed it on: the wallet's
  //    own signature (slot 0) is watched; the chain says confirmed
  globalThis.fetch = async (path, init) => {
    if (!String(path).startsWith("/api/swap/send")) return real(path, init);
    await real(path, init); // it reached the Worker and went out
    return new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  };
  const seen = [];
  const out2 = await LP.run({ wallet: w, build: build(w.address), ephemeral: 0, cluster: "devnet", onStatus: (s, sig, extra) => seen.push([s, sig || null, Boolean(extra && extra.unclear)]) });
  const sent = chain.S.sent[chain.S.sent.length - 1];
  const own = base58Encode(sent.subarray(1, 65));
  assert.deepEqual([out2.status, out2.signature], ["confirmed", own], "the wallet's own signature, read from the signed bytes");
  assert.deepEqual(seen.find(([s]) => s === "confirming"), ["confirming", own, true]);
  // 3. no answer, and the bytes never reached the network: the chain decides "expired" (the only proof that nothing was spent)
  globalThis.fetch = async (path, init) => (String(path).startsWith("/api/swap/send") ? Promise.reject(new TypeError("Failed to fetch")) : real(path, init));
  chain.S.statuses = {};
  const origFetch = chain.fetchImpl;
  chain.fetchImpl = async (url, init) => { const b = JSON.parse(init.body); if (b.method === "getBlockHeight") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 5000 })); return origFetch(url, init); };
  await assert.rejects(LP.run({ wallet: w, build: build(w.address), ephemeral: 0, cluster: "devnet" }), (e) => e.code === "expired" && typeof e.signature === "string" && /Nothing was spent/.test(e.message));
  chain.fetchImpl = origFetch;
  globalThis.fetch = real;
});

/* ---------------------------------------------------------------- a wallet that sends itself (Phantom, the Buy panel's way) */
const builtOf = (h) => new Uint8Array(Buffer.from(h.response.tx, "base64"));
/** What the sending wallet was handed: exactly the built message, slot 0 (the wallet's) empty, every one-time slot validly signed. */
async function handedPartlySigned(handed, built) {
  const d = decodeHeader(handed);
  assert.deepEqual(handed.subarray(d.messageOffset), built.subarray(decodeHeader(built).messageOffset), "the message is the one the Worker built");
  assert.ok(handed.subarray(1, 65).every((b) => b === 0), "slot 0 (the wallet's) is empty");
  await verifySlots(handed, 1);
  return d;
}

for (const n of [1, 2, 3]) {
  test(`LP, a wallet that sends: ${n} one-time key(s) sign first, the wallet signs AND sends, our relay is not called, its signature is watched`, async () => {
    const w = await wallet({ send: true });
    const h = await LP.prepare({ wallet: w, build: build(w.address), ephemeral: n, cluster: "devnet" });
    const statuses = [];
    const out = await h.sign({ onStatus: (s, sig) => statuses.push([s, sig || null]) });
    assert.equal(w.asked.length, 0, "signTransaction is never asked");
    assert.equal(w.sendAsked.length, 1);
    const { bytes, chain: chainId, options } = w.sendAsked[0];
    assert.equal(chainId, "solana:devnet");
    assert.deepEqual(options, { preflightCommitment: "confirmed", maxRetries: 3 }, "the Buy panel's options (public/swap.js)");
    const d = await handedPartlySigned(bytes, builtOf(h));
    assert.equal(d.numSignatures, n + 1);
    assert.equal(sends.length, 0, "/api/swap/send is not called");
    assert.equal(chain.S.sent.length, 1, "the wallet sent it, once");
    await verifySlots(chain.S.sent[0]); // a transaction others signed already is left as it is: every slot checks out
    const id = base58Encode(chain.S.sent[0].subarray(1, 65));
    assert.deepEqual([out.signature, out.status], [id, "confirmed"]);
    assert.match(out.solscan, /cluster=devnet/);
    assert.deepEqual(statuses, [["signing", null], ["confirming", id], ["done", id]]);
    assert.ok(polls.length >= 1 && polls.every((s) => s === id), "watched by the wallet's own signature");
  });
}

test("LP, a wallet that sends, no one-time key (the owner's setup step 1): it may add its own instructions and sends what it signed; never 'changed'", async () => {
  const w = await wallet({ send: true });
  const h = await LP.prepare({ wallet: w, build: build(w.address), ephemeral: 0, cluster: "devnet" });
  const built = builtOf(h);
  const out = await h.sign();
  assert.equal(w.sendAsked.length, 1);
  const d = await handedPartlySigned(w.sendAsked[0].bytes, built);
  assert.equal(d.numSignatures, 1);
  assert.equal(sends.length, 0, "/api/swap/send is not called");
  const went = chain.S.sent[0];
  assert.notDeepEqual(went.subarray(decodeHeader(went).messageOffset), built.subarray(decodeHeader(built).messageOffset), "the wallet changed it, as Phantom does");
  await verifySlots(went);
  const id = base58Encode(went.subarray(1, 65));
  assert.deepEqual([out.signature, out.status], [id, "confirmed"]);
  assert.ok(polls.length >= 1 && polls.every((s) => s === id));
});

test("LP, a wallet that sends: a cancel says 'rejected', any other failure the new plain words; nothing relayed, one tap is one use", async () => {
  const no = await wallet({ send: true, misbehave: "reject" });
  const h = await LP.prepare({ wallet: no, build: build(no.address), ephemeral: 1, cluster: "devnet" });
  await assert.rejects(h.sign(), (e) => e.code === "rejected" && /cancelled/.test(e.message) && e.signature === undefined && !e.unclear);
  await assert.rejects(h.sign(), (e) => e.code === "cancelled");
  assert.equal(no.sendAsked.length, 1, "the wallet is not opened a second time");
  // a window closed without a 4001 code is a cancel too, worded like the Buy panel's (public/swap.js isReject)
  const closer = await wallet({ send: true, misbehave: "closed" });
  await assert.rejects(LP.run({ wallet: closer, build: build(closer.address), ephemeral: 0, cluster: "devnet" }), (e) => e.code === "rejected");
  // an error, or an answer with no id: no id to watch, so the words hedge, the error is `unclear` (the page drops its button), and a
  // second tap repeats the same words, never "Stopped. Nothing was sent."
  for (const [misbehave, code] of [["fail", "wallet_send_failed"], ["nosig", "wallet_send_unclear"], ["vwnosig", "wallet_send_unclear"]]) {
    const bad = await wallet({ send: true, misbehave });
    const hb = await LP.prepare({ wallet: bad, build: build(bad.address), ephemeral: misbehave === "fail" ? 2 : 0, cluster: "devnet" });
    const first = await hb.sign().then(() => null, (e) => e);
    assert.ok(first && first.code === code && first.message === LP.say(code) && first.signature === undefined && first.unclear === true, `${misbehave}: ${first && first.code}`);
    await assert.rejects(hb.sign(), (e) => e === first && !/Nothing was sent/.test(e.message), `${misbehave}: the second tap repeats the hedged words`);
    assert.equal(bad.sendAsked.length, 1);
    assert.equal(bad.asked.length, 0, "no second way round: signTransaction and the relay are not tried");
  }
  // honest: the wallet's own words say what it did, never that nothing was sent for certain
  const words = LP.say("wallet_send_failed");
  assert.match(words, /^Your wallet answered with an error instead of sending this \(for example, its own check of the transaction found a problem\), so most likely nothing was sent\./);
  assert.match(words, /Reload the page to see where things stand, then start again; if it happens again, tell the team\.$/);
  assert.doesNotMatch(words, /Nothing was sent/);
  // the wallet ANSWERED without an id: it may well have sent it, so never "nothing was sent" in any form, and not "start again" yet
  const unclear = LP.say("wallet_send_unclear");
  assert.match(unclear, /may have sent it/);
  assert.match(unclear, /Do not start again yet: check the activity in your wallet, then reload this page in a minute/);
  assert.doesNotMatch(unclear, /nothing was sent/i);
  assert.equal(sends.length, 0);
  assert.equal(chain.S.sent.length, 0);
});

test("LP, a wallet that sends, on devnet: a network error points to the wallet's network (Testnet Mode); on mainnet it is the plain wallet_send_failed", async () => {
  const w = await wallet({ send: true, misbehave: "blockhash" });
  await assert.rejects(LP.run({ wallet: w, build: build(w.address), ephemeral: 1, cluster: "devnet" }), (e) =>
    e.code === "wallet_devnet" && e.unclear === true && /not on devnet/.test(e.message) && /Testnet Mode/.test(e.message) && !/Nothing was sent/.test(e.message));
  const main = await wallet({ send: true, misbehave: "blockhash" });
  const mainBuild = async (k) => ({ ...(await build(main.address)(k)), cluster: "mainnet", chain: "solana:mainnet" });
  await assert.rejects(LP.run({ wallet: main, build: mainBuild, ephemeral: 0, cluster: "mainnet" }), (e) => e.code === "wallet_send_failed" && e.unclear === true);
  assert.equal(main.sendAsked[0].chain, "solana:mainnet");
  assert.equal(sends.length, 0);
});

test("LP, a wallet that sends: 'expired' says nothing was spent only when one-time keys pinned the message; signed alone it is only 'not seen in time'", async () => {
  const orig = chain.fetchImpl;
  chain.fetchImpl = async (url, init) => { const b = JSON.parse(init.body); if (b.method === "getBlockHeight") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 5000 })); return orig(url, init); };
  // with a one-time key the wallet cannot change the message (it would void that signature): the build's blockhash, so truly expired
  const pinned = await wallet({ send: true, misbehave: "drop" });
  await assert.rejects(LP.run({ wallet: pinned, build: build(pinned.address), ephemeral: 1, cluster: "devnet" }), (e) =>
    e.code === "expired" && typeof e.signature === "string" && /Nothing was spent/.test(e.message));
  // signed alone (the owner's step 1): the wallet may have put a newer blockhash in, so the words hedge and the step is not offered again
  const alone = await wallet({ send: true, misbehave: "drop" });
  const h = await LP.prepare({ wallet: alone, build: build(alone.address), ephemeral: 0, cluster: "devnet" });
  const first = await h.sign().then(() => null, (e) => e);
  assert.ok(first && first.code === "expired_unclear" && typeof first.signature === "string", first && first.code);
  assert.equal(first.message, LP.say("expired_unclear"));
  assert.match(first.message, /could still go through\. Check the activity in your wallet, or reload this page in a minute, before starting again\.$/);
  assert.doesNotMatch(first.message, /Nothing was (spent|sent)/i);
  await assert.rejects(h.sign(), (e) => e === first, "a second tap repeats it");
  assert.equal(alone.sendAsked.length, 1);
  assert.equal(sends.length, 0);
  chain.fetchImpl = orig;
});

test("LP, a wallet that only signs (canSend: false): the strict path; a changed message is refused, an unchanged one is relayed with the ticket and every one-time signature", async () => {
  const changer = await wallet({ send: true, canSend: false, misbehave: "change" });
  await assert.rejects(LP.run({ wallet: changer, build: build(changer.address), ephemeral: 1, cluster: "devnet" }), (e) => e.code === "changed");
  assert.equal(changer.sendAsked.length, 0, "canSend: false: the wallet is never asked to send");
  assert.equal(sends.length, 0);
  assert.equal(chain.S.sent.length, 0);
  // the wallet gives back its own signature only (the one-time slots emptied): they are put back, the relay sends with the ticket
  const w = await wallet({ send: true, canSend: false, misbehave: "strip" });
  const h = await LP.prepare({ wallet: w, build: build(w.address), ephemeral: 2, cluster: "devnet" });
  const statuses = [];
  const out = await h.sign({ onStatus: (s) => statuses.push(s) });
  assert.equal(w.sendAsked.length, 0);
  assert.equal(w.asked.length, 1);
  await handedPartlySigned(w.asked[0].bytes, builtOf(h));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].ticket, h.response.ticket, "relayed with the build's ticket");
  const d = await verifySlots(chain.S.sent[0]);
  assert.equal(d.numSignatures, 3);
  assert.equal(out.signature, base58Encode(chain.S.sent[0].subarray(1, 65)));
  assert.deepEqual(statuses, ["signing", "sending", "confirming", "done"]);
});
