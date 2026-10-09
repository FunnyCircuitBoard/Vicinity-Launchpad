// The wallet screens never leave the person with "nothing happening" (live report, 8 Oct 2026: "I click the check my wallet button and
// then nothing is happening"). Since onboarding v3 the wallet is linked from the dashboard (the link mode of /connect: a member whose
// account has no wallet) or logs a member in (the Log in tab); the sign-up itself has no wallet step. Runs the real connect.html with
// site.js, wallets.js, connect.js and signup.js (test/helpers/connectpage.js):
//   * a wallet that never answers the signature or the connection: a hint after 8 s, then after 30 s the button works again and a
//     plain message sits right under it (scrolled into view); an answer that comes late still counts, a newer press wins
//   * "Use another wallet" and every new sign screen give back a working button labelled for what it does ("Link wallet")
//   * wallet errors show right next to what failed (even on a phone scrolled far down the Log in tab), in plain words
//   * one tile per wallet (Phantom also sets window.solana), and the signature answer shapes wallets really give
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, LINK_ME, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

/** The server of the link mode: a link statement, then the signed one links the wallet (the one rule of /api/auth/wallet). */
function server(extra = {}) {
  let n = 0;
  const api = async (path, body) => {
    if (extra[path]) return extra[path](body);
    if (path.startsWith("/api/message")) return { message: `${MESSAGE}${++n}` };
    if (path === "/api/auth/wallet") return { ok: true, linked: true, wallet: body.address, next: "/dashboard?linked=1", fresh: true };
    return { ok: true };
  };
  return { api };
}
async function atSign(opts = {}) {
  const { wallet, ctl } = fakeWallet(opts.name || "Phantom");
  if (opts.sign) ctl.sign = opts.sign;
  const s = server(opts.extra);
  const p = await openConnect({ wallets: [wallet], api: s.api, me: LINK_ME, ua: opts.ua });
  assert.equal(p.screen(), "pick");
  await p.tap(p.$("#wallets-detected").children[0]);
  assert.equal(p.screen(), "sign");
  return { p, ctl };
}

test("the link mode: a member without a wallet lands on 'Link your wallet.', and the sign button says 'Link wallet' from the start", async () => {
  const { p } = await atSign();
  assert.equal(p.$("#sign-h").textContent, "Sign to link this wallet");
  assert.equal(p.$("#c-sign").textContent, "Link wallet");
  assert.equal(p.$("#c-sign").disabled, false);
  assert.equal(p.$("#c-msg-label").textContent, "See the message you will sign");
  assert.match(p.callsTo("/api/message")[0].path, /action=link$/, "the LINK statement, not the login one");
  assert.equal(p.callsTo("/api/signup/state").length, 0, "no sign-up here");
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
  assert.equal(btn.textContent, "Link wallet");
  const err = p.$("#c-error");
  assert.equal(p.visible(err), true);
  assert.match(err.textContent, /^Phantom hasn't answered yet\. Open Phantom \(its icon in your browser's toolbar\) and approve the request, or press Link wallet to ask again\.$/);
  assert.equal(p.next(btn), err, "the message sits right under the button");
  assert.equal(err.getAttribute("role"), "alert", "and is read out");
  assert.ok(p.scrolledTo(err), "and brought into view");
  assert.equal(p.visible(wait), false);
  assert.equal(p.callsTo("/api/auth/wallet").length, 0, "nothing was sent");
});

test("a signature that comes late (after the message) still counts: the wallet is linked without a second press", async () => {
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
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-h").textContent, "Wallet linked.");
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard?linked=1"]);
});

test("pressing again asks the wallet again, and the first (late) answer is thrown away: one link, from the newest request", async () => {
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

test("review F6: the person pressed again after the 30 s message and the wallet refused that one; the FIRST request is then approved: it counts", async () => {
  const { p, ctl } = await atSign({ sign: "hang" });
  await p.tap(p.$("#c-sign"));
  await p.advance(31000);
  const first = ctl.answerSign;
  ctl.sign = "reject"; // e.g. a wallet that refuses a second request while the first one is still open
  await p.tap(p.$("#c-sign"));
  assert.equal(ctl.signs, 2);
  assert.equal(p.$("#c-error").textContent, "Signing cancelled in your wallet. Nothing happened.");
  first(); await p.flush();
  const sent = p.callsTo("/api/auth/wallet");
  assert.equal(sent.length, 1, "the approval the person gave is sent, not dropped");
  assert.equal(sent[0].body.message, ctl.messages[0], "the message that first request signed");
  assert.equal(p.visible(p.$("#c-error")), false, "the old 'cancelled' message is gone");
  assert.equal(p.screen(), "done", "the wallet is linked");
});

test("review F6: an old request refused while a newer one is still open says nothing (the newer one owns the button)", async () => {
  const { p, ctl } = await atSign({ sign: "hang" });
  await p.tap(p.$("#c-sign"));
  await p.advance(31000);
  const firstAnswer = ctl.answerSign;
  await p.tap(p.$("#c-sign")); // a second request, still open
  const btn = p.$("#c-sign");
  assert.equal(btn.textContent, "Check your wallet…");
  firstAnswer(); await p.flush();
  assert.equal(p.callsTo("/api/auth/wallet").length, 0, "a newer request is open: the old answer waits for nothing");
  assert.equal(btn.textContent, "Check your wallet…", "the button still belongs to the newer request");
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
  assert.equal(p.$("#c-sign").textContent, "Link wallet");
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
  const p = await openConnect({ wallets: [wallet], api: s.api, me: LINK_ME });
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

test("wallet errors in plain words, right under the button: cancelled, a broken answer, a refused signature", async () => {
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

test("a wallet that belongs to another account, or another wallet than the account's: said under the wallet list, the person picks again", async () => {
  let { p } = await atSign({ extra: { "/api/auth/wallet": () => ({ ok: false, error: "wallet_taken", _status: 409 }) } });
  await p.tap(p.$("#c-sign"));
  assert.equal(p.screen(), "pick", "back to the wallets");
  assert.equal(p.$("#c-error").textContent, "This wallet already belongs to another Vicinity account. Choose a different wallet, or log in to that account with it.");
  assert.equal(p.next(p.$("#wallets-detected")), p.$("#c-error"));
  ({ p } = await atSign({ extra: { "/api/auth/wallet": () => ({ ok: false, error: "wrong_wallet", _status: 403 }) } }));
  await p.tap(p.$("#c-sign"));
  assert.match(p.$("#c-error").textContent, /^That is not the wallet on your account\./);
  ({ p } = await atSign({ extra: { "/api/auth/wallet": () => ({ ok: false, error: "has_wallet", wallet: "7Np4…T4K2", _status: 409 }) } }));
  await p.tap(p.$("#c-sign"));
  assert.equal(p.$("#c-error").textContent, "Your account already has a wallet (7Np4…T4K2).");
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
  const p = await openConnect({ wallets: [wallet], api: s.api, me: LINK_ME });
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

test("Log in tab: a wallet nobody owns is one plain screen (no account), never step 1 by surprise; the sign button there says 'Sign in'", async () => {
  const { wallet } = fakeWallet("Phantom");
  let n = 0;
  const api = async (path) => (path.startsWith("/api/message") ? { message: MESSAGE + ++n } : path === "/api/auth/wallet" ? { ok: false, error: "no_account", _status: 404 } : { ok: true });
  const p = await openConnect({ search: "mode=login", wallets: [wallet], api, state: STATE.empty() });
  await p.tap(p.$("#wallets-detected").children[0]);
  assert.equal(p.$("#sign-h").textContent, "Sign in with this wallet");
  assert.equal(p.$("#c-sign").textContent, "Sign in");
  assert.match(p.callsTo("/api/message")[0].path, /action=login$/);
  await p.tap(p.$("#c-sign"));
  assert.equal(p.screen(), "no-account");
  assert.equal(p.$("#na-h").textContent, "No account for this wallet yet");
  assert.equal(p.$("#na-body").textContent, "Create one with Google in a minute, then link this wallet from your dashboard.");
  assert.equal(p.visible(p.$("#na-create")), true);
  assert.equal(p.visible(p.$("#na-copy")), false);
  assert.equal(p.callsTo("/api/signup/location").length, 0);
  assert.equal(p.callsTo("/api/auth/google/start").length, 0);
  await p.tap(p.$("#na-create"));
  assert.equal(p.screen(), "su-location", "'Create my account': step 1, on the New here tab");
  assert.equal(p.$("#tab-new").getAttribute("aria-pressed"), "true");
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
