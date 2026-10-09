// The wallet link on a phone (onboarding v3): Safari or Chrome has no wallet in it, and "Open app" opens the page inside the wallet
// app's own browser, which keeps its own cookies. So the tile first makes a one-time link code (POST /api/me/wallet/carry) and
// "Open Phantom" opens /connect?link=CODE in the app: that page shows whose account the wallet would join, the person confirms and
// signs there, the account has the wallet, and Safari's page says so. Never a location check, the Terms or a Google login at this
// stage (the account holds them already), so nothing can loop back to a sign-in screen inside the wallet app. Runs the real connect
// page (test/helpers/connectpage.js); the server side is test/wallet-link-carry.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, LINK_ME, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

const CODE = "Cc0de_Cc0de_Cc0de_Cc0de_Cc0de_Cc"; // 32 characters, like the server's
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const linkFor = (code) => `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/connect?link=${code}`)}?ref=${encodeURIComponent("https://vicinity.test")}`;
const LEAD = "Phantom opens Vicinity on a page that asks you to link the wallet to your account. Check that it shows the same number, connect, sign the free message, and you are done. Your dashboard here updates by itself.";

/**
 * Safari on the phone, signed in to an account without a wallet (the link mode). `world.codes` the codes the server made; `world.live`
 * the ref of the one live link; `world.status` what GET /api/me/wallet/carry/status answers for it; `world.linked` the wallet once linked.
 */
async function safari(opts = {}) {
  const world = { codes: [], live: null, status: "waiting", linked: null, carryAnswer: null, pairs: [] };
  const api = async (path, body) => {
    if (path === "/api/me/wallet/carry") {
      if (world.carryAnswer) return world.carryAnswer;
      const code = CODE.slice(0, 31) + world.codes.length;
      world.codes.push(code);
      world.live = `ref${world.codes.length}`;
      return { ok: true, code, pin: "47", ref: world.live, url: `https://vicinity.test/connect?link=${code}`, expiresAt: inMinutes(10) };
    }
    if (path.startsWith("/api/me/wallet/carry/status?ref=")) {
      const ref = decodeURIComponent(path.split("ref=")[1]);
      if (world.linked) return { ok: true, status: "linked", wallet: world.linked };
      if (ref !== world.live) return { ok: true, status: world.live ? "replaced" : "expired" };
      return { ok: true, status: world.status };
    }
    if (path === "/api/pair") { world.pairs.push(body); return { ok: true, code: "Pp41r_Pp41r_Pp41r_Pp41r_", pin: "42", purpose: "link", url: "https://vicinity.test/connect?pair=Pp41r_Pp41r_Pp41r_Pp41r_", expiresAt: inMinutes(10) }; }
    return { ok: true };
  };
  const p = await openConnect({ ua: UA.iphone, api, me: () => ({ ...LINK_ME, user: { ...LINK_ME.user, wallet: world.linked } }), ...opts });
  return { p, world };
}
const phantomTile = (p) => p.$("#wallets-known").children.find((t) => /Phantom/.test(t.textContent));

/* ---------------- Safari: the link mode and the "Open app" link ---------------- */

test("a member without a wallet lands in the link mode: no tabs, no steps, 'Link your wallet.', the wallet apps as 'Open app' rows, and a way to skip", async () => {
  const { p } = await safari();
  assert.equal(p.screen(), "pick");
  assert.equal(p.visible(p.$("#link-top")), true);
  assert.equal(p.$("#link-title").textContent, "Link your wallet.");
  assert.equal(p.visible(p.$(".su-tabs")), false, "no New here / Log in");
  assert.equal(p.visible(p.$("#su-steps")), false, "no step bar");
  assert.equal(p.visible(p.$("#lg-block")), false);
  assert.equal(p.$(".connect__intro .kicker").textContent, "Almost done");
  assert.equal(p.$("#more-label").textContent, "Open Vicinity in your wallet app");
  assert.ok(p.$("#wallets-known").classList.contains("wallet-grid--apps"));
  const tile = phantomTile(p);
  assert.equal(tile.tagName, "BUTTON", "a button that makes the code first, not a bare link");
  assert.equal(tile.textContent, "PPhantomOpen app");
  assert.equal(p.visible(p.$("#alt-skip")), true);
  assert.equal(p.$("#alt-skip").getAttribute("href"), "/dashboard");
  assert.equal(p.visible(p.$("#alt-check")), false);
  assert.equal(p.callsTo("/api/me/wallet/carry").length, 0, "no code until the person taps");
  assert.equal(p.callsTo("/api/signup/state").length, 0, "no sign-up here");
  assert.equal(p.$("#termsgate").hidden, true, "the account holds the Terms: no gate");
});

test("tapping Phantom makes ONE code, then 'Open Phantom' carries the link to the app (phantom.com, /connect?link=, no referrer)", async () => {
  const { p } = await safari();
  const tile = phantomTile(p);
  tile.click(); tile.click(); // a double tap
  await p.flush();
  assert.equal(p.callsTo("/api/me/wallet/carry").length, 1);
  assert.equal(p.screen(), "carry");
  assert.equal(p.$("#carry-h").textContent, "Link your wallet in Phantom");
  assert.equal(p.$("#carry-lead").textContent, LEAD);
  const open = p.$("#carry-open");
  assert.equal(open.textContent, "Open Phantom");
  assert.equal(open.href, linkFor(CODE.slice(0, 31) + "0"));
  assert.equal(open.getAttribute("rel"), "noreferrer");
  assert.equal(open.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(open.getAttribute("target"), null, "a plain tap on a ready link: what iPhones need to open the app");
  assert.equal(p.$("#carry-pin").textContent, "47");
  assert.equal(p.visible(p.$("#carry-pinrow")), true);
  assert.match(p.$("#carry-go").textContent, /This link works for 10 minutes, once, and only from this phone's own internet connection\. Never send it to anyone\./);
  assert.match(p.$("#carry-status").textContent, /Waiting for Phantom…/);
  assert.equal(p.$("#carry-pair").textContent, "Didn't work? Approve in Phantom and finish here instead");
  assert.equal(p.$("#carry-skip").getAttribute("href"), "/dashboard");
  assert.equal(p.session.get("vl-started"), "1", "the dashboard (same tab, later) knows a link was started");
  assert.equal(p.session.get("su-carry"), "Phantom");
});

test("Safari asks every 3 s while on screen (not in the background), says when Phantom opened the link, and lands on the dashboard once it is linked", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  const asks = () => p.callsTo("/api/me/wallet/carry/status").length;
  const before = asks();
  await p.advance(3000);
  assert.equal(asks(), before + 1, "every 3 s while on screen");
  assert.match(p.calls.find((c) => c.path.startsWith("/api/me/wallet/carry/status")).path, /\?ref=ref1$/);
  await p.setHidden(true);
  await p.advance(30000);
  assert.equal(asks(), before + 1, "nothing while Phantom is in front");
  world.status = "opened";
  await p.setHidden(false);
  assert.equal(asks(), before + 2, "asked the moment the page is back");
  assert.equal(p.$("#carry-status-text").textContent, "Phantom opened your link…");
  world.linked = ADDR;
  await p.advance(3000);
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-h").textContent, "Wallet linked.");
  assert.equal(p.$("#done-go").getAttribute("href"), "/dashboard?linked=1");
  assert.equal(p.session.get("vl-started"), undefined, "nothing left for the dashboard to wait for");
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard?linked=1"]);
  const n = asks();
  await p.advance(60000);
  assert.equal(asks(), n, "nothing left to ask");
});

test("an unused link runs out after 10 minutes: 'Get a new link' makes a new code; 'Choose another way' goes back to the wallets", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  const first = p.$("#carry-open").href;
  world.status = "expired";
  await p.advance(3000);
  assert.equal(p.visible(p.$("#carry-open")), false, "the dead link is gone");
  assert.equal(p.$("#carry-error").textContent, "That link ran out (links work for 10 minutes). Get a new link.");
  assert.equal(p.visible(p.$("#carry-renew")), true);
  world.status = "waiting";
  await p.tap(p.$("#carry-renew"));
  assert.equal(p.callsTo("/api/me/wallet/carry").length, 2);
  assert.notEqual(p.$("#carry-open").href, first);
  assert.equal(p.visible(p.$("#carry-open")), true);
  await p.tap(p.$("#carry-back"));
  assert.equal(p.screen(), "pick");
  assert.equal(p.visible(p.$("#link-top")), true);
  const n = p.callsTo("/api/me/wallet/carry/status").length;
  await p.advance(20000);
  assert.equal(p.callsTo("/api/me/wallet/carry/status").length, n, "no more asking once the person chose another way");
});

test("another tab made a newer link: this tab says its link stopped working (no dead 'Open Phantom') and gets a new one", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  world.live = "ref-other-tab"; // the second tab tapped Phantom: one live link per person, the server replaced this one
  await p.advance(3000);
  assert.equal(p.screen(), "carry");
  assert.equal(p.visible(p.$("#carry-open")), false);
  assert.equal(p.visible(p.$("#carry-status")), false, "no 'Waiting for Phantom…' for a link that can't be used");
  assert.equal(p.$("#carry-error").textContent, "A newer link was made (another tab?). Get a new link here.");
  await p.tap(p.$("#carry-renew"));
  assert.equal(p.callsTo("/api/me/wallet/carry").length, 2);
  assert.equal(p.visible(p.$("#carry-open")), true, "a working link again");
});

test("a refused code (too many) is said right under the wallet apps, and the tile works again; a relay goes straight to 'approve in Phantom, finish here'", async () => {
  const { p, world } = await safari();
  world.carryAnswer = { ok: false, error: "slow_down", _status: 429 };
  const tile = phantomTile(p);
  await p.tap(tile);
  assert.equal(p.screen(), "pick");
  assert.match(p.$("#c-error").textContent, /That's a lot of attempts/);
  assert.equal(p.next(p.$("#more-wallets")), p.$("#c-error"));
  assert.equal(tile.disabled, false);
  // Safari behind iCloud Private Relay: the wallet app can't share the connection, so the pairing, for the LINK
  world.carryAnswer = { ok: false, error: "carry_relay", _status: 409 };
  await p.tap(tile);
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.deepEqual(world.pairs, [{ purpose: "link" }], "a link pairing, not a login one");
  assert.equal(p.$("#pair-h").textContent, "Approve in Phantom, then finish here");
  assert.equal(p.$("#pair-why").textContent, "Your iPhone hides its connection (iCloud Private Relay), so the link can't move into Phantom. Approve there instead, then come back here: this page finishes the link by itself.");
  assert.equal(p.$("#pair-apps").children[0].href, `https://phantom.com/ul/browse/${encodeURIComponent("https://vicinity.test/connect?pair=Pp41r_Pp41r_Pp41r_Pp41r_")}?ref=${encodeURIComponent("https://vicinity.test")}`);
});

test("'Didn't work?' on the link screen: approve in the wallet app and finish here (a link pairing), app links instead of a QR code", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  await p.tap(p.$("#carry-pair"));
  assert.equal(p.screen(), "phone");
  assert.deepEqual(world.pairs, [{ purpose: "link" }]);
  assert.equal(p.$("#pair-h").textContent, "Approve in Phantom, then finish here");
  assert.equal(p.visible(p.$("#pair-why")), false, "no relay here: no reason to give");
  assert.equal(p.$("#pair-qr").hidden, true, "no QR code: this phone can't scan itself");
  assert.equal(p.$("#pair-pin").textContent, "42");
  const n = p.callsTo("/api/pair").length;
  await p.setHidden(true); await p.setHidden(false);
  assert.equal(p.callsTo("/api/pair").length, n + 1, "back from the wallet app: asked at once");
});

test("a member whose account already has a wallet never sees the link mode: straight to the dashboard", async () => {
  const p = await openConnect({ ua: UA.iphone, me: { ...LINK_ME, user: { ...LINK_ME.user, wallet: ADDR } } });
  assert.equal(p.screen(), "done");
  await p.advance(1000);
  assert.deepEqual(p.assigned, ["/dashboard"]);
});

/* ---------------- the wallet app's browser: /connect?link=CODE ---------------- */

const INFO = { ok: true, pin: "47", owner: { name: "Sa•••", handle: "Sw•••", initial: "S" }, community: { name: "Utica", country: "US" }, terms: "2026-10-01", expiresAt: inMinutes(9) };
/**
 * Phantom's in-app browser opened by the link: no cookies, the Terms never agreed in this browser, Phantom injected.
 * `info(body)` and `claim(body)` play POST /api/me/wallet/carry/info and /claim.
 */
async function inPhantom({ info = () => INFO, claim = () => ({ ok: true, wallet: ADDR, next: "/dashboard?linked=1" }), ua = UA.phantomApp, wallets, me, search = `link=${CODE}` } = {}) {
  const { wallet, ctl } = fakeWallet("Phantom");
  let n = 0;
  const asked = [];
  const api = async (path, body) => {
    if (path === "/api/me/wallet/carry/info") return info(body);
    if (path === "/api/me/wallet/carry/claim") return claim(body);
    if (path.startsWith("/api/message")) { asked.push(path); return { message: MESSAGE + ++n }; }
    return { ok: true };
  };
  const geolocation = { getCurrentPosition: () => { geolocation.asked = true; } };
  const p = await openConnect({ ua, search, agreed: null, wallets: wallets || [wallet], api, me, geolocation });
  return { p, ctl, asked, geolocation };
}

test("S8: Phantom's browser links NOTHING on load: whose account it is (masked name, @handle, community, the check number), a warning, a choice; no location, Terms or Google", async () => {
  const { p, geolocation } = await inPhantom();
  assert.equal(p.addressBar[1], "https://vicinity.test/connect", "the code left the address bar...");
  assert.ok(p.calls.every((c) => !c.addressBar.includes("link=")), "...before the first request (no Referer, no history keeps it)");
  assert.deepEqual(p.callsTo("/api/me/wallet/carry/info").map((c) => c.body), [{ code: CODE }]);
  assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0, "not claimed on load");
  assert.equal(p.calls.filter((c) => c.path.startsWith("/api/signup/")).length, 0, "no sign-up call of any kind");
  assert.equal(p.calls.filter((c) => c.path.startsWith("/api/auth/google")).length, 0, "no Google");
  assert.equal(geolocation.asked, undefined, "no location check");
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-h").textContent, "Link this wallet to Sa•••'s Vicinity account?");
  assert.equal(p.$("#carry-in-handle").textContent, "@Sw•••");
  assert.equal(p.$("#carry-in-avatar").textContent, "S");
  assert.equal(p.$("#carry-in-city").textContent, "📍 Utica, US");
  assert.equal(p.$("#carry-in-pin").textContent, "47", "the number Safari shows");
  const words = p.$('.cstate[data-state="carry-in"]').textContent.replace(/\s+/g, " ");
  assert.match(words, /Safari, where you started, shows the same number\./);
  assert.match(words, /Only continue if you started this yourself, in Safari or Chrome on this phone, a moment ago, and the number matches\. Never continue from a link someone sent you: your wallet would join THEIR account\./);
  assert.match(words, /The Terms of Use were accepted on that account\./);
  assert.equal(p.$("#carry-in-yes").textContent, "Yes, link my wallet");
  assert.equal(p.$("#carry-in-no").textContent, "No, that is not me");
  assert.equal(p.visible(p.$("#su-steps")), false);
  assert.equal(p.visible(p.$(".su-tabs")), false);
  assert.equal(p.$("#termsgate").hidden, true, "no Terms gate: they were accepted on that account");
  assert.equal(p.local.get("vicinity_terms"), undefined, "...but not noted in this browser before the person says it is theirs");
  assert.equal(p.$(".connect__intro .kicker").textContent, "Almost done");
});

test("S8: 'Yes, link my wallet' shows the wallet; tap, sign the link statement (with the code), and the server links it: done, logged in here, Safari knows", async () => {
  const { p, ctl, asked } = await inPhantom();
  await p.tap(p.$("#carry-in-yes"));
  assert.equal(p.visible(p.$("#carry-in-yes")), false);
  assert.equal(p.local.get("vicinity_terms"), "2026-10-01", "confirmed: the account's Terms are noted here, so nothing pops later");
  assert.equal(p.$("#termsgate").hidden, true);
  assert.equal(p.$("#carry-in-tap").textContent, "Tap Phantom and sign. Nothing is paid or moved.");
  assert.deepEqual(p.$("#carry-in-wallets").children.map((t) => t.textContent), ["PhantomDetected"]);
  await p.tap(p.$("#carry-in-wallets").children[0]);
  assert.equal(ctl.connects, 1);
  assert.deepEqual(asked, [`/api/message?address=${ADDR}&action=link&code=${CODE}`], "the LINK statement for the owner of this code");
  assert.equal(ctl.signs, 1);
  const claims = p.callsTo("/api/me/wallet/carry/claim");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].body.code, CODE);
  assert.equal(claims[0].body.address, ADDR);
  assert.equal(claims[0].body.message, ctl.messages[0]);
  assert.equal(Buffer.from(claims[0].body.signature, "base64").length, 64);
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-h").textContent, "Wallet linked.");
  assert.equal(p.$("#done-sub").textContent, "7Np4…T4K2 is now the wallet of your account, and you're logged in here too. Back in Safari your dashboard already knows.");
  assert.equal(p.$("#done-go").getAttribute("href"), "/dashboard?linked=1");
  assert.equal(p.$("#done-go").textContent, "Open my dashboard");
  await p.advance(3000);
  assert.deepEqual(p.assigned, [], "the words stay: the person taps when ready");
});

test("S8: the wallet injected late (the app takes a moment): the tiles fill in when it turns up", async () => {
  const { p } = await inPhantom({ wallets: [] });
  await p.advance(3500); // the page waits a moment for a wallet app's wallet before it calls this a wallet app
  assert.equal(p.screen(), "carry-in", "the user agent says it is a wallet app: the question shows");
  await p.tap(p.$("#carry-in-yes"));
  assert.equal(p.$("#carry-in-tap").textContent, "Waiting for your wallet app to connect…");
  assert.equal(p.$("#carry-in-wallets").children.length, 0);
  p.register(fakeWallet("Phantom").wallet);
  await p.flush();
  assert.deepEqual(p.$("#carry-in-wallets").children.map((t) => t.textContent), ["PhantomDetected"]);
  assert.equal(p.$("#carry-in-tap").textContent, "Tap Phantom and sign. Nothing is paid or moved.");
});

test("S8: 'No, that is not me' links nothing: the code stays unused, the Terms gate, an ordinary first visit", async () => {
  const { p } = await inPhantom();
  await p.tap(p.$("#carry-in-no"));
  assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0);
  assert.equal(p.$("#termsgate").hidden, false, "a first visit here: the gate");
  assert.equal(p.screen(), "su-location");
  assert.equal(p.$("#su-note").textContent, "OK, nothing was linked. The link stays unused.");
});

test("S8: a link opened outside a phone's wallet app (a computer, or Safari) is never looked at", async () => {
  for (const ua of [UA.desktop, UA.iphone]) {
    const { p } = await inPhantom({ ua, wallets: ua === UA.desktop ? undefined : [] });
    await p.advance(3500);
    assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 0, ua);
    assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0, ua);
    assert.equal(p.$("#termsgate").hidden, false, ua);
    assert.equal(p.screen(), "su-location", ua);
    assert.equal(p.$("#su-note").textContent, "That link only works inside your wallet app, on the phone where you started. Nothing was changed.", ua);
    assert.equal(p.addressBar.at(-1), "https://vicinity.test/connect", "the code still leaves the address bar");
  }
});

test("S8: a used or expired link, another connection, or an account that got its wallet meanwhile: said plainly, the gate, nothing linked", async () => {
  for (const [error, status, words] of [
    ["carry_expired", 410, /^That link was already used or has run out \(it works once, for 10 minutes\)\. Go back to Safari or Chrome and tap Link again\.$/],
    ["carry_network", 403, /^That link only works on the phone and internet connection where you started \(a VPN or iCloud Private Relay counts as a different one\)\. Go back to Safari or Chrome and tap “Didn't work\?” there\.$/],
    ["link_done", 409, /^A wallet was linked to this account a moment ago\. Nothing changed here\.$/],
  ]) {
    const { p } = await inPhantom({ info: () => ({ ok: false, error, _status: status }) });
    assert.equal(p.$("#termsgate").hidden, false, `${error}: the Terms gate shows as for anyone new here`);
    assert.match(p.$("#su-note").textContent, words, error);
    assert.equal(p.screen(), "su-location");
    assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0);
  }
});

test("S8: the claim fails after the person signed: used meanwhile (back to Safari), another account logged in here, or a passing failure (try again)", async () => {
  let { p } = await inPhantom({ claim: () => ({ ok: false, error: "carry_expired", _status: 410 }) });
  await p.tap(p.$("#carry-in-yes"));
  await p.tap(p.$("#carry-in-wallets").children[0]);
  assert.equal(p.$("#termsgate").hidden, true, "the person said the account was theirs: its Terms count here");
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true", "the Log in tab: the person has an account");
  assert.match(p.$("#su-note").textContent, /already used or has run out/);

  ({ p } = await inPhantom({ claim: () => ({ ok: false, error: "already_signed_in", _status: 409 }) }));
  await p.tap(p.$("#carry-in-yes"));
  await p.tap(p.$("#carry-in-wallets").children[0]);
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-error").textContent, "This browser is logged in to another Vicinity account. Log out of it first, then open the link again.");

  let n = 0;
  ({ p } = await inPhantom({ claim: () => (++n === 1 ? { ok: false, error: "offline", _status: 503 } : { ok: true, wallet: ADDR, next: "/dashboard?linked=1" }) }));
  await p.tap(p.$("#carry-in-yes"));
  await p.tap(p.$("#carry-in-wallets").children[0]);
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-error").textContent, "Couldn't reach Vicinity. Check your connection and try again.");
  await p.tap(p.$("#carry-in-wallets").children[0]);
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#carry-in-error").textContent, "");
});

test("S8: signing cancelled in the wallet: said on the question, nothing sent, the tile works again", async () => {
  const { p, ctl } = await inPhantom();
  ctl.sign = "reject";
  await p.tap(p.$("#carry-in-yes"));
  await p.tap(p.$("#carry-in-wallets").children[0]);
  assert.equal(p.$("#carry-in-error").textContent, "Signing cancelled in your wallet. Nothing happened.");
  assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0);
  ctl.sign = "ok";
  await p.tap(p.$("#carry-in-wallets").children[0]);
  assert.equal(p.screen(), "done");
});

test("S8: the same person is already logged in inside the wallet app's browser: the question still shows (the claim replaces that session), never a jump to the dashboard", async () => {
  const { p } = await inPhantom({ me: LINK_ME });
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 1);
});

test("a wallet app's browser opened without a code keeps today's behaviour: no info, no claim, the gate, step 1", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openConnect({ ua: UA.phantomApp, agreed: null, wallets: [wallet], state: STATE.empty() });
  assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 0);
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.screen(), "su-location");
});

test("the old sign-up's /connect?carry= link: one calm line, the ordinary tabs, the gate; a member without a wallet lands in the link mode", async () => {
  const { p } = await inPhantom({ search: `carry=${CODE}` });
  assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 0);
  assert.equal(p.calls.filter((c) => c.path.startsWith("/api/signup/carry")).length, 0, "the old routes are gone: never called");
  assert.equal(p.addressBar.at(-1), "https://vicinity.test/connect");
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.screen(), "su-location");
  assert.equal(p.visible(p.$(".su-tabs")), true);
  assert.equal(p.$("#su-note").textContent, "That link is from the old sign-up. Your account is a tap away: log in, or start here.");
  const { p: member } = await inPhantom({ search: `carry=${CODE}`, me: LINK_ME });
  assert.equal(member.screen(), "pick");
  assert.equal(member.visible(member.$("#link-top")), true);
  assert.equal(member.$("#termsgate").hidden, true);
});

test("a link code on a page that can't use it (the old sign-up is back): never looked at, and the Terms gate still shows", async () => {
  const p = await openConnect({ ua: UA.phantomApp, search: `link=${CODE}`, agreed: null, me: { signupFlow: undefined }, state: STATE.empty() });
  assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 0);
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.addressBar.at(-1), "https://vicinity.test/connect");
});
