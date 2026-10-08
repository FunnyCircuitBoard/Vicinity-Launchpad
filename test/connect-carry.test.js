// The live bug of 8 Oct 2026, on the page: on an iPhone, Safari did the location and Google; "Open app" on the wallet step opened
// Phantom's own browser, which has its own cookies, so the sign-up showed step 1 again ("New here", "Check my location") and Google
// can't run there. Now the tile makes a one-time code first (POST /api/signup/carry) and "Open Phantom" opens /connect?carry=CODE in
// the app, whose page takes the sign-up over at the wallet step. Safari says what became of it. Runs the real connect page
// (test/helpers/connectpage.js); the server side is test/signup-carry.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

const CODE = "Cc0de_Cc0de_Cc0de_Cc0de_Cc0de_Cc"; // 32 characters, like the server's
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const linkFor = (code) => `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/connect?carry=${code}`)}?ref=${encodeURIComponent("https://vicinity.test")}`;

/**
 * Safari on the phone at the wallet step. `world.state` is what the server says; `world.codes` the codes it made; `world.live` the
 * ref of the one live link (the server names it in the state, as GET /api/signup/state does).
 */
async function safari(opts = {}) {
  const world = { state: STATE.wallet(), codes: [], carryAnswer: null, live: null };
  const api = async (path) => {
    if (path === "/api/signup/carry") {
      if (world.carryAnswer) return world.carryAnswer;
      const code = CODE.slice(0, 31) + world.codes.length;
      world.codes.push(code);
      world.live = `ref${world.codes.length}`;
      return { ok: true, code, pin: "47", ref: world.live, url: `https://vicinity.test/connect?carry=${code}`, expiresAt: inMinutes(10) };
    }
    if (path === "/api/signup/start") { world.state = STATE.empty(); return { ok: true, state: world.state }; }
    return { ok: true };
  };
  const state = () => (world.live && !world.state.carried && world.state.next ? { ...world.state, carry: { ref: world.live } } : world.state);
  const p = await openConnect({ ua: UA.iphone, api, state, ...opts });
  return { p, world };
}
const phantomTile = (p) => p.$("#wallets-known").children.find((t) => /Phantom/.test(t.textContent));

test("phone, no wallet in Safari: the wallet apps are full rows that say 'Open app', and the page says the sign-up goes along", async () => {
  const { p } = await safari();
  assert.equal(p.screen(), "pick");
  assert.match(p.$("#su-wallet-lead").textContent, /“Open app” takes this sign-up into your wallet app: you carry on there at this step, with your location and login already done\./);
  assert.doesNotMatch(p.$("#su-wallet-lead").textContent, /starts again|not carried over/);
  assert.equal(p.$("#more-label").textContent, "Open Vicinity in your wallet app");
  assert.ok(p.$("#wallets-known").classList.contains("wallet-grid--apps"));
  const tile = phantomTile(p);
  assert.equal(tile.tagName, "BUTTON", "a button that makes the code first, not a bare link");
  assert.equal(tile.textContent, "PPhantomOpen app");
  assert.equal(p.callsTo("/api/signup/carry").length, 0, "no code until the person taps");
});

test("tapping Phantom makes ONE code, then 'Open Phantom' carries it to the app (phantom.com, no referrer)", async () => {
  const { p } = await safari();
  const tile = phantomTile(p);
  tile.click(); tile.click(); // a double tap
  await p.flush();
  assert.equal(p.callsTo("/api/signup/carry").length, 1);
  assert.equal(p.screen(), "carry");
  assert.equal(p.$("#carry-h").textContent, "Continue in Phantom");
  assert.match(p.$("#carry-lead").textContent, /Phantom opens this sign-up at the wallet step, with your location and login already done/);
  const open = p.$("#carry-open");
  assert.equal(open.textContent, "Open Phantom");
  assert.equal(open.href, linkFor(CODE.slice(0, 31) + "0"));
  assert.equal(open.getAttribute("rel"), "noreferrer");
  assert.equal(open.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(open.getAttribute("target"), null, "a plain tap on a ready link: what iPhones need to open the app");
  assert.equal(p.visible(p.$("#su-steps")), true, "still step 3 of 3");
  // review F1: a check number the wallet app's page shows too, and no "this phone" promise the server can't keep
  assert.equal(p.$("#carry-pin").textContent, "47");
  assert.equal(p.visible(p.$("#carry-pinrow")), true);
  assert.match(p.$("#carry-lead").textContent, /Check that Phantom shows the same number/);
  assert.match(p.$("#carry-go").textContent, /only from this phone's own internet connection\. Never send it to anyone\./);
});

test("Safari asks while it is on screen (not in the background) and says plainly: it continues in Phantom, then it is done", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  const asks = () => p.callsTo("/api/signup/state").length;
  const before = asks();
  await p.advance(3000);
  assert.equal(asks(), before + 1, "every 3 s while on screen");
  await p.setHidden(true);
  await p.advance(30000);
  assert.equal(asks(), before + 1, "nothing while Phantom is in front");
  // Phantom took the sign-up over; the person comes back to Safari
  world.state = { ...STATE.empty(), carried: { done: false, live: true, provider: "google" } };
  await p.setHidden(false);
  assert.equal(asks(), before + 2, "asked the moment the page is back");
  assert.equal(p.screen(), "carry");
  assert.equal(p.$("#carry-h").textContent, "Your sign-up continues in Phantom");
  assert.match(p.$("#carry-away-text").textContent, /^Go back to Phantom to finish: connect your wallet there and sign the free message\./);
  assert.equal(p.visible(p.$("#su-steps")), false);
  assert.equal(p.visible(p.$("#carry-away")), true);
  // finished in Phantom
  world.state = { ...STATE.empty(), carried: { done: true, live: false, provider: "google" } };
  await p.advance(5000);
  assert.equal(p.$("#carry-h").textContent, "Your account is ready");
  assert.match(p.$("#carry-done-text").textContent, /^You finished signing up in Phantom, and you're logged in there\. To use Vicinity in this browser too, log in here once with the same Google account\.$/);
  const google = p.$("#carry-login-google");
  assert.equal(p.visible(google), true);
  assert.equal(google.getAttribute("href"), "/api/auth/google/start", "the normal Google log-in (no sign-up, no shortcut)");
  const n = asks();
  await p.advance(60000);
  assert.equal(asks(), n, "nothing left to wait for");
});

test("an e-mail sign-up finished in the app: 'Log in here' opens the Log in tab", async () => {
  const { p, world } = await safari();
  world.state = { ...STATE.empty(), carried: { done: true, live: false, provider: "email" } };
  await p.tap(phantomTile(p));
  await p.advance(3000);
  assert.equal(p.visible(p.$("#carry-login-google")), false);
  assert.equal(p.visible(p.$("#carry-login")), true);
  assert.match(p.$("#carry-done-text").textContent, /with the e-mail and password you chose/);
  await p.tap(p.$("#carry-login"));
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
  assert.equal(p.screen(), "pick");
});

test("Safari reloaded after the carry shows where the sign-up went, never step 1 again (even for a remembered member)", async () => {
  const q = await openConnect({ ua: UA.iphone, state: { ...STATE.empty(), carried: { done: false, live: true, provider: "google" } }, storage: { "vicinity-account": "1" } });
  assert.equal(q.screen(), "carry");
  assert.equal(q.$("#carry-h").textContent, "Your sign-up continues in your wallet app");
  assert.equal(q.$("#tab-new").getAttribute("aria-pressed"), "true");
});

test("a sign-up that ran out in the app: Safari says so and starts again only when asked", async () => {
  const q = await openConnect({ ua: UA.iphone, state: { ...STATE.empty(), carried: { done: false, live: false, provider: "google" } },
    api: async (path) => (path === "/api/signup/start" ? { ok: true, state: STATE.empty() } : { ok: true }) });
  assert.equal(q.$("#carry-h").textContent, "Your sign-up ran out");
  assert.equal(q.callsTo("/api/signup/start").length, 0);
  await q.tap(q.$("#carry-again"));
  assert.equal(q.callsTo("/api/signup/start").length, 1);
});

test("an unused link runs out after 10 minutes: 'Get a new link' makes a new code; 'Choose another way' goes back", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  // the server's ten minutes, as the page sees them
  const first = p.$("#carry-open").href;
  const realNow = Date.now; // the page reads the real clock for "ten minutes"
  Date.now = () => realNow() + 11 * 60_000;
  try {
    await p.advance(3000);
    assert.equal(p.visible(p.$("#carry-open")), false, "the dead link is gone");
    assert.match(p.$("#carry-error").textContent, /That link ran out \(links work for 10 minutes\)\. Get a new one to open Phantom\./);
    assert.equal(p.visible(p.$("#carry-renew")), true);
  } finally { Date.now = realNow; }
  await p.tap(p.$("#carry-renew"));
  assert.equal(p.callsTo("/api/signup/carry").length, 2);
  assert.notEqual(p.$("#carry-open").href, first);
  assert.equal(p.visible(p.$("#carry-open")), true);
  await p.tap(p.$("#carry-back"));
  assert.equal(p.screen(), "pick");
  const n = p.callsTo("/api/signup/state").length;
  await p.advance(20000);
  assert.equal(p.callsTo("/api/signup/state").length, n, "no more asking once the person chose another way");
});

test("a refused code (too many) is said right under the wallet apps, and the tile works again", async () => {
  const { p, world } = await safari();
  world.carryAnswer = { ok: false, error: "slow_down", _status: 429 };
  const tile = phantomTile(p);
  await p.tap(tile);
  assert.equal(p.screen(), "pick");
  assert.match(p.$("#c-error").textContent, /That's a lot of attempts/);
  assert.equal(p.next(p.$("#more-wallets")), p.$("#c-error"));
  assert.equal(tile.disabled, false);
});

test("'Didn't work?' on a phone: sign in the wallet app and finish here (the pairing), with app links instead of a QR code the phone can't scan", async () => {
  const PAIR = "Pp41r_Pp41r_Pp41r_Pp41r_";
  const { p } = await safari({ api: async (path) => (path === "/api/signup/carry" ? { ok: true, code: CODE, url: `https://vicinity.test/connect?carry=${CODE}`, expiresAt: inMinutes(10) }
    : path === "/api/pair" ? { ok: true, code: PAIR, pin: "42", url: `https://vicinity.test/connect?pair=${PAIR}`, expiresAt: inMinutes(10) } : { ok: true }) });
  await p.tap(phantomTile(p));
  assert.equal(p.$("#carry-pair").textContent, "Didn't work? Sign in Phantom and finish here instead");
  await p.tap(p.$("#carry-pair"));
  assert.equal(p.screen(), "phone");
  assert.equal(p.$("#pair-h").textContent, "Sign in your wallet app");
  assert.equal(p.$("#pair-qr").hidden, true, "no QR code: this phone can't scan itself");
  assert.equal(p.$("#pair-howto-phone").hidden, false);
  assert.equal(p.$("#pair-pin").textContent, "42");
  const tile = p.$("#pair-apps").children[0];
  assert.equal(tile.href, `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/connect?pair=${PAIR}`)}?ref=${encodeURIComponent("https://vicinity.test")}`);
  assert.match(p.$("#pair-status").textContent, /Waiting for your wallet app…/);
  // back from the wallet app: asked at once
  const n = p.callsTo("/api/pair").length;
  await p.setHidden(true); await p.setHidden(false);
  assert.equal(p.callsTo("/api/pair").length, n + 1);
});

test("the approve page says where to go back to on a phone too (not only 'your computer')", async () => {
  const html = (await import("node:fs")).readFileSync(new URL("../public/connect.html", import.meta.url), "utf8");
  assert.match(html, /<h2 class="h2--sm">Approve the sign-in you started<\/h2>/);
  assert.match(html, /Go back to where you started \(your computer, or Safari or Chrome on this phone\)\./);
  assert.doesNotMatch(html, /Go back to your computer/);
});

test("the Log in tab on a phone has no sign-up to carry: the tiles stay plain links to the app", async () => {
  const p = await openConnect({ ua: UA.iphone, search: "mode=login", state: STATE.empty() });
  const tile = phantomTile(p);
  assert.equal(tile.tagName, "A");
  assert.equal(tile.href, `https://phantom.com/ul/browse/${encodeURIComponent("https://vicinity.test/connect")}?ref=${encodeURIComponent("https://vicinity.test")}`);
});

/* ---------------- Safari: the review fixes ---------------- */

test("F5: another tab made a newer link: this tab says its link stopped working (no dead 'Open Phantom') and gets a new one", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  assert.equal(p.visible(p.$("#carry-open")), true);
  world.live = "ref-other-tab"; // the second tab tapped Phantom: one live link per sign-up, the server deleted this one
  await p.advance(3000);
  assert.equal(p.screen(), "carry");
  assert.equal(p.visible(p.$("#carry-open")), false, "the dead link is gone");
  assert.equal(p.visible(p.$("#carry-status")), false, "no 'Waiting for Phantom…' for a link that can't be used");
  assert.equal(p.$("#carry-error").textContent, "This link stopped working: a newer one was made (in another tab?). Get a new link here.");
  assert.equal(p.visible(p.$("#carry-renew")), true);
  await p.tap(p.$("#carry-renew"));
  assert.equal(p.callsTo("/api/signup/carry").length, 2);
  assert.equal(p.visible(p.$("#carry-open")), true, "a working link again");
  const n = p.callsTo("/api/signup/state").length;
  await p.advance(3000);
  assert.equal(p.callsTo("/api/signup/state").length, n + 1);
  assert.equal(p.visible(p.$("#carry-open")), true, "and it stays: it is the live one now");
});

test("F4: Safari no longer showed its link (reloaded) and the wallet app took the sign-up: tapping Phantom again says where it is, never 'cleared'", async () => {
  const { p, world } = await safari();
  // Phantom claimed it: this browser's cookie opens nothing, POST /api/signup/carry answers no_signup
  world.carryAnswer = { ok: false, error: "no_signup", _status: 401 };
  world.state = { ...STATE.empty(), carried: { done: false, live: true, provider: "google" } };
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.callsTo("/api/signup/start").length, 0, "no new sign-up replaces the cookie that knows where it went");
  assert.equal(p.screen(), "carry");
  assert.equal(p.$("#carry-h").textContent, "Your sign-up continues in your wallet app");
  assert.equal(p.visible(p.$("#carry-away")), true);
  assert.equal(p.visible(p.$("#su-note")), false, "no 'open too long, cleared'");
});

test("F4: Safari back on screen at the wallet step (no link shown) asks at once whether the wallet app took the sign-up over", async () => {
  const { p, world } = await safari();
  const n = p.callsTo("/api/signup/state").length;
  await p.setHidden(true);
  world.state = { ...STATE.empty(), carried: { done: false, live: true, provider: "google" } };
  await p.setHidden(false);
  assert.equal(p.callsTo("/api/signup/state").length, n + 1);
  assert.equal(p.screen(), "carry");
  assert.equal(p.$("#carry-h").textContent, "Your sign-up continues in your wallet app");
});

test("F7: the wallet in the app already had an account: Safari says the person was logged in there, not that the sign-up ran out", async () => {
  const q = await openConnect({ ua: UA.iphone, state: { ...STATE.empty(), carried: { done: false, live: false, provider: null, login: true } } });
  assert.equal(q.screen(), "carry");
  assert.equal(q.$("#carry-h").textContent, "You're logged in, in your wallet app");
  assert.match(q.$("#carry-done-text").textContent, /already has a Vicinity account, so you were logged in to that account there and this sign-up was closed\. To use Vicinity in this browser too, log in here once\./);
  assert.doesNotMatch(q.$("#connect-panel").textContent.replace(/\s+/g, " "), /ran out/);
  assert.equal(q.visible(q.$("#carry-login")), true);
  assert.equal(q.visible(q.$("#carry-again")), false);
  await q.tap(q.$("#carry-login"));
  assert.equal(q.$("#tab-login").getAttribute("aria-pressed"), "true");
});

test("COR-1: Safari behind iCloud Private Relay is never sent to Phantom to be refused: it goes straight to 'sign in Phantom, finish here'", async () => {
  const PAIR = "Pp41r_Pp41r_Pp41r_Pp41r_";
  const { p } = await safari({ api: async (path) => (path === "/api/signup/carry" ? { ok: false, error: "carry_relay", _status: 409 }
    : path === "/api/pair" ? { ok: true, code: PAIR, pin: "42", url: `https://vicinity.test/connect?pair=${PAIR}`, expiresAt: inMinutes(10) } : { ok: true }) });
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.callsTo("/api/pair").length, 1);
  assert.equal(p.screen(), "phone");
  assert.equal(p.$("#pair-h").textContent, "Sign in your wallet app");
  assert.equal(p.visible(p.$("#pair-why")), true);
  assert.equal(p.$("#pair-why").textContent, "This browser uses iCloud Private Relay or a VPN, so your wallet app can't take this sign-up over. Do it the other way round: sign in your wallet app as shown below, then come back here to finish.");
  assert.equal(p.$("#pair-apps").children[0].href, `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/connect?pair=${PAIR}`)}?ref=${encodeURIComponent("https://vicinity.test")}`);
  // "Back", then the ordinary "Wallet on my phone": no relay note left over
  await p.tap(p.$('.cstate[data-state="phone"] [data-back]'));
  await p.tap(p.$("#alt-phone"));
  assert.equal(p.screen(), "phone");
  assert.equal(p.visible(p.$("#pair-why")), false);
});

test("F3: tablets keep the QR code for 'Wallet on my phone' (only a phone gets app links for itself)", async () => {
  const PAIR = "Pp41r_Pp41r_Pp41r_Pp41r_";
  const api = async (path) => (path === "/api/pair" ? { ok: true, code: PAIR, pin: "42", url: `https://vicinity.test/connect?pair=${PAIR}`, expiresAt: inMinutes(10) } : { ok: true });
  for (const [ua, touchPoints, phone] of [[UA.ipad, 5, false], [UA.androidTablet, 5, false], [UA.iphone, 5, true]]) {
    const p = await openConnect({ ua, touchPoints, api, search: "mode=login", state: STATE.empty() });
    assert.equal(p.win.VW.isMobile, true);
    p.$("#qr").getContext = () => ({ fillRect() {} }); // the QR code is drawn on a canvas (Chromium draws it in the end-to-end runs)
    p.win.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => false });
    await p.tap(p.$("#alt-phone"));
    assert.equal(p.screen(), "phone");
    assert.equal(p.$("#pair-h").textContent, phone ? "Sign in your wallet app" : "Scan with your phone", ua);
    assert.equal(p.$("#pair-qr").hidden, phone, ua);
    assert.equal(p.$("#pair-apps").hidden, !phone, ua);
  }
});

/* ---------------- the wallet app's browser ---------------- */

const INFO = { ok: true, pin: "47", community: { name: "Utica", country: "US" }, login: { provider: "google", name: "Sa•••" }, expiresAt: inMinutes(9) };
/**
 * Phantom's in-app browser opened by the link: no cookies, the Terms never agreed in this browser, Phantom injected.
 * `info(body)` and `claim(body)` play POST /api/signup/carry/info and /claim; `world.state` is GET /api/signup/state.
 */
async function inPhantom({ info = () => INFO, claim = () => ({ ok: true, state: STATE.wallet() }), state = STATE.empty(), ua = UA.phantomApp, wallets } = {}) {
  const { wallet, ctl } = fakeWallet("Phantom");
  const world = { state };
  let n = 0;
  const api = async (path, body) => {
    if (path === "/api/signup/carry/info") return info(body);
    if (path === "/api/signup/carry/claim") { const r = claim(body); if (r.ok) world.state = r.state; return r; }
    if (path.startsWith("/api/message")) return { message: MESSAGE + ++n };
    if (path === "/api/auth/wallet") { world.state = STATE.finish(); return { ok: true, wallet: body.address, next: "signup" }; }
    if (path === "/api/signup/finish") return { ok: true, next: "/dashboard?welcome=1" };
    return { ok: true };
  };
  const p = await openConnect({ ua, search: `carry=${CODE}`, agreed: null, wallets: wallets || [wallet], api, state: () => world.state });
  return { p, ctl, world };
}

test("SEC-1 / F1: Phantom's browser takes NOTHING over on load: whose sign-up it is (check number, community, masked login), a warning, a choice", async () => {
  const { p } = await inPhantom();
  assert.equal(p.addressBar[1], "https://vicinity.test/connect", "the code left the address bar...");
  assert.ok(p.calls.every((c) => !c.addressBar.includes("carry")), "...before the first request (no Referer, no history keeps it)");
  assert.deepEqual(p.callsTo("/api/signup/carry/info").map((c) => c.body), [{ code: CODE }]);
  assert.equal(p.callsTo("/api/signup/carry/claim").length, 0, "not claimed on load");
  assert.equal(p.callsTo("/api/signup/finish").length, 0);
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-h").textContent, "Continue the sign-up you started?");
  assert.equal(p.$("#carry-in-pin").textContent, "47", "the number Safari shows");
  assert.equal(p.$("#carry-in-city").textContent, "Utica, US");
  assert.equal(p.$("#carry-in-login").textContent, "Google account Sa•••");
  const words = p.$('.cstate[data-state="carry-in"]').textContent.replace(/\s+/g, " ");
  assert.match(words, /Only continue if you started this sign-up yourself, on this phone, a moment ago\. Never continue from a link someone sent you: your wallet would join their account\./);
  assert.match(words, /Safari or Chrome, where you started, shows the same number/);
  assert.equal(p.visible(p.$("#su-steps")), false, "not this browser's sign-up (yet): no step bar");
  assert.equal(p.$("#termsgate").hidden, true, "the Terms are on the confirm screen (accepted in that sign-up)");
  assert.equal(p.local.get("vicinity_terms"), undefined, "...but not recorded in this browser before the person confirms");
  assert.equal(p.visible(p.$("#su-google")), false);
});

test("Phantom's browser: 'Yes, it's mine' takes it over and lands on the wallet step; connect, sign, and the account is made there", async () => {
  const { p, ctl } = await inPhantom();
  await p.tap(p.$("#carry-in-yes"));
  const claims = p.callsTo("/api/signup/carry/claim");
  assert.deepEqual(claims.map((c) => c.body), [{ code: CODE }]);
  assert.equal(p.local.get("vicinity_terms"), "2026-10-01", "confirmed: the Terms of that sign-up are noted here");
  assert.equal(p.$("#termsgate").hidden, true);
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#wallet-h").textContent, "Connect your wallet");
  assert.equal(p.$("#su-steps li[data-step=\"wallet\"]").classList.contains("is-active"), true);
  assert.equal(p.$("#su-note").textContent, "You're in your wallet app now. Your location (Utica) and your Google login came with you: connect your wallet below to finish.");
  assert.deepEqual(p.$("#wallets-detected").children.map((t) => t.textContent), ["PhantomDetected"]);
  await p.tap(p.$("#wallets-detected").children[0]);
  assert.equal(p.$("#c-sign").textContent, "Verify wallet");
  await p.tap(p.$("#c-sign"));
  assert.equal(ctl.signs, 1);
  assert.equal(p.callsTo("/api/auth/wallet")[0].body.address, ADDR);
  await p.advance(100);
  assert.equal(p.callsTo("/api/signup/finish").length, 1);
  await p.advance(2000);
  assert.deepEqual(p.assigned, ["/dashboard?welcome=1"]);
});

test("SEC-1: a browser holding a proven wallet (a pending session) opens someone's link: no claim, no finish, until the person says yes; then it signs again", async () => {
  const { p, ctl } = await inPhantom({ state: STATE.finish(), claim: () => ({ ok: true, state: STATE.wallet() }) });
  await p.advance(5000);
  assert.equal(p.callsTo("/api/signup/carry/claim").length, 0);
  assert.equal(p.callsTo("/api/signup/finish").length, 0, "no account made by just opening a link");
  assert.equal(p.screen(), "carry-in");
  await p.tap(p.$("#carry-in-yes"));
  await p.advance(1000);
  assert.equal(p.callsTo("/api/signup/finish").length, 0, "the claim dropped the earlier proof: the wallet step again");
  assert.equal(p.screen(), "pick");
  assert.equal(ctl.signs, 0);
});

test("Phantom's browser: 'No, that's not mine' takes nothing over: the code stays unused, the Terms gate and an ordinary step 1", async () => {
  const { p } = await inPhantom();
  await p.tap(p.$("#carry-in-no"));
  assert.equal(p.callsTo("/api/signup/carry/claim").length, 0);
  assert.equal(p.$("#termsgate").hidden, false, "a first visit here: the gate");
  assert.equal(p.screen(), "su-location");
  assert.equal(p.$("#su-note").textContent, "OK, nothing was taken over. If you want an account, start your own sign-up here.");
});

test("SEC-1: a code opened outside a phone's wallet app (a computer, or Safari) is never looked at or claimed", async () => {
  for (const ua of [UA.desktop, UA.iphone]) {
    const { p } = await inPhantom({ ua, wallets: ua === UA.desktop ? undefined : [] });
    await p.advance(3500); // the page waits a moment for a wallet app's wallet to appear
    assert.equal(p.callsTo("/api/signup/carry/info").length, 0, ua);
    assert.equal(p.callsTo("/api/signup/carry/claim").length, 0, ua);
    assert.equal(p.$("#termsgate").hidden, false, ua);
    assert.equal(p.screen(), "su-location", ua);
    assert.equal(p.$("#su-note").textContent, "That “Open app” link only works inside your wallet app, on the phone where you started. Nothing was changed.", ua);
    assert.equal(p.addressBar.at(-1), "https://vicinity.test/connect", "the code still leaves the address bar");
  }
});

test("Phantom's browser with a used or expired code (or another connection): the gate, a plain way back to Safari, and today's page", async () => {
  for (const [error, words] of [["carry_expired", /already used or has run out \(it works once, for 10 minutes\)\. Go back to Safari or Chrome, where you started, and tap Open app again\./],
    ["carry_network", /only works on the phone and internet connection where you started \(a VPN or iCloud Private Relay counts as a different one\)\. Go back to Safari or Chrome and tap “Didn't work\? Sign in your wallet app and finish here instead”\./]]) {
    const { p } = await inPhantom({ info: () => ({ ok: false, error, _status: error === "carry_expired" ? 410 : 403 }) });
    assert.equal(p.$("#termsgate").hidden, false, `${error}: the Terms gate shows as for anyone new here`);
    assert.match(p.$("#su-note").textContent, words, error);
    assert.equal(p.screen(), "su-location");
    assert.equal(p.callsTo("/api/signup/carry/claim").length, 0);
  }
});

test("F2: the same link opened again in Phantom (a double tap) while the sign-up is already here: the wallet step, no error, no 'go back to Safari'", async () => {
  const { p } = await inPhantom({ info: () => ({ ok: false, error: "carry_expired", _status: 410 }), state: STATE.wallet() });
  assert.equal(p.callsTo("/api/signup/carry/claim").length, 0);
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#su-steps li[data-step=\"wallet\"]").classList.contains("is-active"), true);
  assert.equal(p.$("#su-note").textContent, "You're in your wallet app now. Your location (Utica) and your Google login came with you: connect your wallet below to finish.");
  assert.doesNotMatch(p.$("#connect-panel").textContent, /Go back to Safari/);
  assert.equal(p.$("#termsgate").hidden, true);
});

test("Phantom's browser: the claim fails after the person said yes (used meanwhile): said plainly, the gate, step 1", async () => {
  const { p } = await inPhantom({ claim: () => ({ ok: false, error: "carry_expired", _status: 410 }) });
  await p.tap(p.$("#carry-in-yes"));
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.screen(), "su-location");
  assert.match(p.$("#su-note").textContent, /already used or has run out/);
});

test("Phantom's browser: a claim that fails for a passing reason (offline) keeps the question, with the reason, so Yes can be pressed again", async () => {
  let n = 0;
  const { p } = await inPhantom({ claim: () => (++n === 1 ? { ok: false, error: "offline", _status: 503 } : { ok: true, state: STATE.wallet() }) });
  await p.tap(p.$("#carry-in-yes"));
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-error").textContent, "Couldn't reach Vicinity. Check your connection and try again.");
  assert.equal(p.$("#termsgate").hidden, true);
  await p.tap(p.$("#carry-in-yes"));
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#carry-in-error").textContent, "");
});

test("a wallet app's browser opened without a code keeps today's behaviour: no claim, the gate, step 1", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openConnect({ ua: UA.phantomApp, agreed: null, wallets: [wallet], state: STATE.empty() });
  assert.equal(p.callsTo("/api/signup/carry/claim").length, 0);
  assert.equal(p.callsTo("/api/signup/carry/info").length, 0);
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.screen(), "su-location");
});

test("a code on a page that can't use it (the old sign-up is back): never claimed, and the Terms gate still shows", async () => {
  const p = await openConnect({ ua: UA.phantomApp, search: `carry=${CODE}`, agreed: null, me: { signupFlow: undefined }, state: STATE.empty() });
  assert.equal(p.callsTo("/api/signup/carry/claim").length, 0);
  assert.equal(p.callsTo("/api/signup/carry/info").length, 0);
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.addressBar.at(-1), "https://vicinity.test/connect");
});
