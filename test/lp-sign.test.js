// public/lp-sign.js (window.LP) with Node's WebCrypto Ed25519 and the REAL Worker relay behind a fake fetch: one-time keys that
// are not extractable; 1 to 3 of them signing at their own static-key slots after the wallet signed first; a wallet that changed
// the message, signed wrongly, is the wrong account or cancelled is refused with plain words and nothing is sent; the summary is
// built with textContent only.
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

/** A wallet with a Node key: signs its own slot (slot 0) of whatever it is given, or does `misbehave` first. */
async function wallet({ misbehave = null } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const asked = [];
  return {
    address, asked, canSign: true,
    async signTransaction(bytes, chain) {
      asked.push({ bytes: bytes.slice(), chain });
      if (misbehave === "reject") throw new Error("User rejected the request.");
      const tx = bytes.slice();
      const n = tx[0], msgAt = 1 + 64 * n;
      if (misbehave === "change") tx[tx.length - 1] ^= 1; // e.g. a wallet that rewrote the last instruction
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, misbehave === "badsig" ? new Uint8Array([9]) : tx.subarray(msgAt)));
      tx.set(sig, 1);
      return tx;
    },
  };
}

let env, chain, sends;
beforeEach(() => {
  _resetLpKit(); _resetRelay();
  env = { ...newWorld(), ...LP_ON };
  chain = lpChain();
  sends = [];
  // the page's fetch: the real Worker (relay and status) for /api/..., with this site's Origin like a browser
  globalThis.fetch = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("origin", ORIGIN);
    const req = new Request(ORIGIN + path, { method: init.method || "GET", headers, body: init.body });
    if (path.startsWith("/api/swap/send")) sends.push(JSON.parse(init.body));
    return handleApi(req, env, chain.fetchImpl);
  };
});
const build = (payer) => async (pubkeys) => buildTx(env, { payer, instructions: pubkeys.length ? pubkeys.map((k) => createAccount(payer, k)) : [systemTransfer(payer, addr(77), 1n)], extraSigners: pubkeys }, chain.fetchImpl);
async function verifySlots(tx) {
  const d = decodeHeader(tx);
  const message = tx.subarray(d.messageOffset);
  for (let i = 0; i < d.numSignatures; i++) {
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
  test(`LP.run: the wallet signs first, then ${n} one-time key(s) sign at their own slots, the relay sends, the status confirms`, async () => {
    const w = await wallet();
    const seen = [], statuses = [];
    const out = await LP.run({ wallet: w, build: build(w.address), ephemeral: n, cluster: "devnet", onSummary: (res) => { seen.push(res); return true; }, onStatus: (s) => statuses.push(s) });
    assert.equal(out.status, "confirmed");
    assert.match(out.solscan, /cluster=devnet/);
    assert.equal(w.asked.length, 1);
    assert.equal(w.asked[0].chain, "solana:devnet");
    // what the wallet was shown had NO signature at all: the wallet signs first
    const shown = w.asked[0].bytes;
    assert.ok(shown.subarray(1, 1 + 64 * (n + 1)).every((b) => b === 0), "the wallet saw an unsigned transaction");
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
