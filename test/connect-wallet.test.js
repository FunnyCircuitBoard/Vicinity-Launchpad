// The wallet step never leaves the person with "nothing happening" (live report, 8 Oct 2026: "I click the check my wallet button and
// then nothing is happening"). Runs the real connect.html with site.js, wallets.js, connect.js and signup.js (test/helpers/connectpage.js):
//   * a wallet that never answers the signature or the connection: a hint after 8 s, then after 30 s the button works again and a
//     plain message sits right under it (scrolled into view); an answer that comes late still counts, a newer press wins
//   * "Use another wallet" and every new sign screen give back a working button labelled for this step ("Verify wallet")
//   * wallet errors show right next to what failed (even on a phone scrolled far down the Log in tab), in plain words
//   * one tile per wallet (Phantom also sets window.solana), and the signature answer shapes wallets really give
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

/** The server of a normal sign-up at its wallet step: a message, then the signed one is accepted (a new wallet: next "signup"). */
function server(extra = {}) {
  let proven = false, n = 0;
  const api = async (path, body) => {
    if (extra[path]) return extra[path](body);
    if (path.startsWith("/api/message")) return { message: `${MESSAGE}${++n}` };
    if (path === "/api/auth/wallet") { proven = true; return { ok: true, wallet: body.address, next: "signup" }; }
    if (path === "/api/signup/finish") return { ok: true, next: "/dashboard?welcome=1" };
    return { ok: true };
  };
  return { api, state: () => (proven ? STATE.finish() : STATE.wallet()) };
}
async function atSign(opts = {}) {
  const { wallet, ctl } = fakeWallet(opts.name || "Phantom");
  if (opts.sign) ctl.sign = opts.sign;
  const s = server(opts.extra);
  const p = await openConnect({ wallets: [wallet], api: s.api, state: s.state, ua: opts.ua });
  await p.tap(p.$("#wallets-detected").children[0]);
  assert.equal(p.screen(), "sign");
  return { p, ctl };
}

test("the sign button says 'Verify wallet' from the start in the sign-up (it said 'Sign in' until the first press)", async () => {
  const { p } = await atSign();
  assert.equal(p.$("#sign-h").textContent, "Verify this wallet");
  assert.equal(p.$("#c-sign").textContent, "Verify wallet");
  assert.equal(p.$("#c-sign").disabled, false);
});

test("a signature that never comes: a hint after 8 s, then the button works again with a plain message right under it", async () => {
  const { p, ctl } = await atSign({ sign: "hang" });
  const btn = p.$("#c-sign");
  await p.tap(btn);
  assert.equal(ctl.signs, 1);
  assert.equal(btn.textContent, "Check your wallet…");
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute("aria-busy"), "true");
  await p.advance(8000);
  const wait = p.$("#c-wait");
  assert.equal(p.visible(wait), true, "the hint shows");
  assert.match(wait.textContent, /Waiting for Phantom to sign\. No Phantom window\? Click the Phantom icon in your browser's toolbar/);
  assert.equal(p.next(btn), wait, "right under the button");
  assert.equal(wait.getAttribute("role"), "status");
  await p.advance(22000);
  assert.equal(btn.disabled, false, "after 30 s the button works again");
  assert.equal(btn.textContent, "Verify wallet");
  const err = p.$("#c-error");
  assert.equal(p.visible(err), true);
  assert.match(err.textContent, /^Phantom hasn't answered yet\. Open Phantom \(its icon in your browser's toolbar\) and approve the request, or press Verify wallet to ask again\.$/);
  assert.equal(p.next(btn), err, "the message sits right under the button");
  assert.equal(err.getAttribute("role"), "alert", "and is read out");
  assert.ok(p.scrolledTo(err), "and brought into view");
  assert.equal(p.visible(wait), false);
  assert.equal(p.callsTo("/api/auth/wallet").length, 0, "nothing was sent");
});

test("a signature that comes late (after the message) still counts: the page goes on without a second press", async () => {
  const { p, ctl } = await atSign({ sign: "hang" });
  await p.tap(p.$("#c-sign"));
  await p.advance(31000);
  assert.match(p.$("#c-error").textContent, /hasn't answered yet/);
  ctl.answerSign();
  await p.flush();
  const sent = p.callsTo("/api/auth/wallet");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.address, ADDR);
  assert.equal(sent[0].body.message, ctl.messages[0], "the message that was signed");
  await p.advance(1000);
  assert.equal(p.callsTo("/api/signup/finish").length, 1, "the account is made");
});

test("pressing again asks the wallet again, and the first (late) answer is thrown away: one sign-in, from the newest request", async () => {
  const { p, ctl } = await atSign({ sign: "hang" });
  await p.tap(p.$("#c-sign"));
  await p.advance(31000);
  const first = ctl.answerSign;
  await p.tap(p.$("#c-sign"));
  assert.equal(ctl.signs, 2, "asked again");
  const second = ctl.answerSign;
  first(); await p.flush();
  assert.equal(p.callsTo("/api/auth/wallet").length, 0, "the old answer is ignored");
  second(); await p.flush();
  const sent = p.callsTo("/api/auth/wallet");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.message, ctl.messages[1], "the message of the request that was answered (still unused: it was never sent)");
});

test("'Use another wallet' while the wallet is silent: the next sign screen has a working button (it stayed on 'Check your wallet…' forever)", async () => {
  const { p, ctl } = await atSign({ sign: "hang" });
  await p.tap(p.$("#c-sign"));
  const late = ctl.answerSign;
  await p.tap(p.$('.cstate[data-state="sign"] [data-back]'));
  assert.equal(p.screen(), "pick");
  assert.equal(p.visible(p.$("#c-wait")), false);
  await p.advance(40000);
  assert.equal(p.visible(p.$("#c-error")), false, "no message about a request the person left");
  await p.tap(p.$("#wallets-detected").children[0]);
  assert.equal(p.screen(), "sign");
  assert.equal(p.$("#c-sign").disabled, false);
  assert.equal(p.$("#c-sign").textContent, "Verify wallet");
  late(); await p.flush();
  assert.equal(p.callsTo("/api/auth/wallet").length, 0, "the abandoned request counts for nothing");
  ctl.sign = "ok";
  await p.tap(p.$("#c-sign"));
  assert.equal(p.callsTo("/api/auth/wallet").length, 1, "and the new press works");
});

test("a connection that never comes: the tile says Waiting…, a hint after 8 s, a message after 30 s; tapping again asks again", async () => {
  const { wallet, ctl } = fakeWallet("Phantom");
  ctl.connect = "hang";
  const s = server();
  const p = await openConnect({ wallets: [wallet], api: s.api, state: s.state });
  const tile = p.$("#wallets-detected").children[0];
  await p.tap(tile);
  assert.equal(tile.getAttribute("aria-busy"), "true");
  assert.match(tile.textContent, /Waiting…/);
  await p.tap(tile);
  assert.equal(ctl.connects, 1, "a double tap is one request");
  await p.advance(8000);
  assert.match(p.$("#c-wait").textContent, /Waiting for Phantom to connect\. No Phantom window\? Click the Phantom icon/);
  assert.equal(p.next(p.$("#wallets-detected")), p.$("#c-wait"), "right under the wallet list");
  await p.advance(22000);
  assert.equal(tile.getAttribute("aria-busy"), null);
  assert.match(p.$("#c-error").textContent, /^Phantom hasn't answered yet\. No Phantom window\? Click the Phantom icon in your browser's toolbar \(top right\)\. Or tap Phantom again\.$/);
  assert.equal(p.next(p.$("#wallets-detected")), p.$("#c-error"));
  ctl.connect = "ok";
  await p.tap(tile);
  assert.equal(ctl.connects, 2);
  assert.equal(p.screen(), "sign");
});

test("wallet errors in plain words, right under the button: cancelled, a broken answer, a refused sign-in", async () => {
  // the person said no
  let { p } = await atSign({ sign: "reject" });
  await p.tap(p.$("#c-sign"));
  assert.equal(p.$("#c-error").textContent, "Signing cancelled in your wallet. Nothing happened.");
  assert.equal(p.next(p.$("#c-sign")), p.$("#c-error"));
  assert.equal(p.$("#c-sign").disabled, false);
  // an answer with no signature in it: never "(intermediate value) is not iterable" or an empty signature sent to the server
  ({ p } = await atSign({ sign: () => ({}) }));
  await p.tap(p.$("#c-sign"));
  assert.equal(p.$("#c-error").textContent, "Phantom couldn't sign the message. Please try again, or use another wallet.");
  assert.equal(p.callsTo("/api/auth/wallet").length, 0);
  // the server refuses the signature
  ({ p } = await atSign({ extra: { "/api/auth/wallet": () => ({ ok: false, error: "bad_signature" }) } }));
  await p.tap(p.$("#c-sign"));
  assert.equal(p.$("#c-error").textContent, "Sign-in failed. Please try again.");
  assert.equal(p.next(p.$("#c-sign")), p.$("#c-error"));
});

test("the answer shapes wallets give are all understood (the standard array, the object alone, an array of signatures)", async () => {
  for (const [label, shape] of [
    ["standard", (m, sig) => [{ signedMessage: m, signature: sig }]],
    ["object alone", (m, sig) => ({ signedMessage: m, signature: sig })],
    ["array of signatures", (m, sig) => [sig]],
  ]) {
    const { p } = await atSign({ sign: shape });
    await p.tap(p.$("#c-sign"));
    const sent = p.callsTo("/api/auth/wallet");
    assert.equal(sent.length, 1, label);
    assert.equal(Buffer.from(sent[0].body.signature, "base64").length, 64, label);
  }
});

test("one tile per wallet: Phantom's window.solana is not listed again as 'Solana wallet'", async () => {
  const { wallet } = fakeWallet("Phantom");
  const legacy = { isPhantom: true, connect: async () => ({ publicKey: { toString: () => ADDR } }), signMessage: async () => ({ signature: new Uint8Array(64) }) };
  const s = server();
  const p = await openConnect({ wallets: [wallet], api: s.api, state: s.state });
  p.win.phantom = { solana: legacy }; p.win.solana = legacy;
  await p.setHidden(false); // the page looks again for older wallets
  assert.deepEqual(p.$("#wallets-detected").children.map((t) => t.textContent), ["PhantomDetected"]);
});

test("Log in tab on a phone, scrolled far down: a refused connection is shown right under the wallet list, and scrolled to", async () => {
  const { wallet, ctl } = fakeWallet("Phantom");
  ctl.connect = "reject";
  const p = await openConnect({ ua: UA.phantomApp, search: "mode=login", wallets: [wallet], state: STATE.empty() });
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
  await p.tap(p.$("#wallets-detected").children[0]);
  const err = p.$("#c-error");
  assert.equal(err.textContent, "Connection cancelled in your wallet.");
  assert.equal(p.next(p.$("#wallets-detected")), err, "under the list, not under the step bar at the top");
  assert.ok(p.scrolledTo(err));
});

test("a proven wallet the state does not show (offline, or the cookie was not kept): an error, never 'Wallet verified' over the same step", async () => {
  const { wallet } = fakeWallet("Phantom");
  let n = 0;
  const api = async (path, body) => (path.startsWith("/api/message") ? { message: MESSAGE + ++n } : path === "/api/auth/wallet" ? { ok: true, wallet: body.address, next: "signup" } : { ok: true });
  const p = await openConnect({ wallets: [wallet], api, state: STATE.wallet() }); // the state never says the wallet is done
  await p.tap(p.$("#wallets-detected").children[0]);
  await p.tap(p.$("#c-sign"));
  await p.advance(100);
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#c-error").textContent, "Your wallet signed, but this browser couldn't keep the result. Please connect it and sign again.");
  assert.equal(p.next(p.$("#wallets-detected")), p.$("#c-error"));
  assert.doesNotMatch(p.$("#su-live").textContent, /Wallet verified/);
});

test("location: a browser that never answers (no prompt, no error) gives up after 40 s instead of 'Checking your location…' forever", async () => {
  const geolocation = { getCurrentPosition() { /* never calls back */ } };
  const p = await openConnect({ ua: UA.phantomApp, state: STATE.empty(), geolocation, api: async (path) => (path === "/api/signup/start" ? { ok: true, state: STATE.empty() } : path === "/api/signup/location/handoff" ? { ok: true, code: "c".repeat(24), url: "https://vicinity.test/locate?code=" + "c".repeat(24), expiresAt: new Date(Date.now() + 600000).toISOString() } : { ok: true }) });
  assert.equal(p.screen(), "su-location");
  await p.tap(p.$("#su-loc-go"));
  assert.equal(p.$("#su-loc-go").textContent, "Checking your location…");
  await p.advance(39000);
  assert.equal(p.$("#su-loc-go").textContent, "Checking your location…");
  await p.advance(1500);
  assert.equal(p.$("#su-loc-go").textContent, "Share my location", "it stopped waiting");
  assert.equal(p.callsTo("/api/signup/location/handoff").length, 1, "inside a wallet app: the step goes on in Safari or Chrome");
  assert.equal(p.visible(p.$("#su-loc-handoff")), true);
});
