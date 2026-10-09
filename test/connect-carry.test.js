// The wallet link on a phone (onboarding v3): Safari or Chrome has no wallet in it, and "Open app" opens the page inside the wallet
// app's own browser, which keeps its own cookies. So the tile first makes a one-time link code (POST /api/me/wallet/carry) and
// "Open Phantom" opens /connect?link=CODE in the app: that page shows whose account the wallet would join, the person confirms and
// signs there, the account has the wallet, and Safari's page says so. Never a location check, the Terms or a Google login at this
// stage (the account holds them already), so nothing can loop back to a sign-in screen inside the wallet app. Owner decision F4 (10 Oct
// 2026, "phones live inside the wallet app"): once linked, the person STAYS in the wallet app, on its own dashboard, logged in; the
// page goes there by itself. Runs the real connect page (test/helpers/connectpage.js); the server side is test/wallet-link-carry.test.js
// and test/wallet-link-relay.test.js (more of this page's phone behaviour: test/connect-inwallet.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, LINK_ME, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

const CODE = "Cc0de_Cc0de_Cc0de_Cc0de_Cc0de_Cc"; // 32 characters, like the server's
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const linkFor = (code) => `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/connect?link=${code}`)}?ref=${encodeURIComponent("https://vicinity.test")}`;
const LEAD = "Phantom opens Vicinity and asks to connect this wallet to your account. Check the number, connect, and sign the free message. Then you stay in Phantom, logged in.";
const OPEN_IN_PHANTOM = `https://phantom.com/ul/browse/${encodeURIComponent("https://vicinity.test/connect?mode=login&with=phantom")}?ref=${encodeURIComponent("https://vicinity.test")}`;

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
      if (world.linked) return { ok: true, status: "linked", wallet: world.linked, ...(world.app ? { app: world.app } : {}) };
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

test("a member without a wallet lands in the link mode: no tabs, no steps, 'Connect your wallet.', the wallet apps as 'Open app' rows, and a way to skip", async () => {
  const { p } = await safari();
  assert.equal(p.screen(), "pick");
  assert.equal(p.visible(p.$("#link-top")), true);
  assert.equal(p.$("#link-title").textContent, "Connect your wallet.");
  assert.equal(p.visible(p.$(".su-tabs")), false, "no New here / Log in");
  assert.equal(p.visible(p.$("#su-steps")), false, "no step bar");
  assert.equal(p.visible(p.$("#lg-block")), false);
  assert.equal(p.$(".connect__intro .kicker").textContent, "Almost done");
  assert.equal(p.$("#more-label").textContent, "Open Vicinity in your wallet app");
  assert.ok(p.$("#wallets-known").classList.contains("wallet-grid--apps"));
  // F6: the six wallet apps that can open this page are the list; the eleven to install wait behind a second "More wallets"
  assert.deepEqual(p.$("#wallets-known").children.map((t) => t.querySelector(".go").textContent), new Array(6).fill("Open app"));
  assert.equal(p.visible(p.$("#wallets-more")), true); assert.ok(!p.$("#wallets-more").open, "closed until tapped");
  assert.deepEqual([...new Set(p.$("#wallets-rest").children.map((t) => t.querySelector(".go").textContent))], ["Get"]);
  assert.equal(p.$("#wallets-rest").children.length, 10, "the sixteen known wallets: six open this page, ten are to install");
  assert.equal(p.visible(p.$("#wallets-none")), false, "a phone's browser never holds a wallet: the lead says what to tap instead");
  assert.equal(p.$("#su-wallet-lead").textContent, "Tap your wallet app. It opens Vicinity there: check the number, then sign once. You stay in the app, logged in.");
  assert.equal(p.visible(p.$("#link-noapp")), true, "no wallet app yet: get Phantom first (a new tab: this page stays)");
  assert.match(p.$("#link-noapp").textContent, /^No wallet app yet\? Get Phantom \(free\), set it up, then come back here and tap Phantom\.$/);
  assert.equal(p.$("#link-noapp a").getAttribute("target"), "_blank");
  assert.equal(p.visible(p.$(".connect__intro")), false, "the hero said the same as #link-top: shown once on a phone");
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
  assert.deepEqual(p.callsTo("/api/me/wallet/carry")[0].body, { app: "phantom" }, "the server knows which app (a relay code is only for an app with real app links)");
  assert.equal(p.local.get("vicinity.walletApp"), "phantom", "remembered for this phone (the Buy panel lists it first)");
  assert.equal(p.screen(), "carry");
  assert.equal(p.$("#carry-h").textContent, "Connect your wallet in Phantom");
  assert.equal(p.$("#carry-lead").textContent, LEAD);
  const open = p.$("#carry-open");
  assert.equal(open.textContent, "Open Phantom");
  assert.equal(open.href, linkFor(CODE.slice(0, 31) + "0"));
  assert.equal(open.getAttribute("rel"), "noreferrer");
  assert.equal(open.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(open.getAttribute("target"), null, "a plain tap on a ready link: what iPhones need to open the app");
  assert.equal(p.$("#carry-pin").textContent, "47");
  assert.equal(p.visible(p.$("#carry-pinrow")), true);
  assert.equal(p.$("#carry-small").textContent, "This link works once, for 10 minutes, only on this phone. Never send it to anyone.");
  assert.equal(p.$("#carry-get").textContent, "No Phantom on this phone? Get it first.");
  assert.equal(p.$("#carry-get").href, "https://phantom.com/download");
  assert.equal(p.$("#carry-get").getAttribute("target"), "_blank", "a new tab: the link screen stays here");
  assert.equal(p.visible(p.$("#carry-hint")), false);
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
  world.linked = ADDR; world.app = "phantom";
  await p.advance(3000);
  // MOVED (owner decision F4): Safari no longer goes to its own dashboard: the person keeps going in Phantom, logged in there
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-h").textContent, "Phantom connected ✓");
  assert.equal(p.$("#done-sub").textContent, "Wallet 7Np4…T4K2 is on your account. Keep going in Phantom: you're logged in there.");
  assert.equal(p.$("#done-go").textContent, "Open Phantom");
  assert.equal(p.$("#done-go").getAttribute("href"), OPEN_IN_PHANTOM);
  assert.equal(p.visible(p.$("#done-stay")), true); assert.equal(p.$("#done-stay").getAttribute("href"), "/dashboard?linked=1");
  assert.equal(p.session.get("vl-started"), undefined, "nothing left for the dashboard to wait for");
  assert.equal(p.local.get("vicinity.walletApp"), "phantom", "the app that linked it, from the server");
  await p.advance(3000);
  assert.deepEqual(p.assigned, [], "nothing moves by itself: Open Phantom or Stay here");
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
  assert.equal(p.$("#pair-apps").children[0].href, `https://phantom.com/ul/browse/${encodeURIComponent("https://vicinity.test/connect?pair=Pp41r_Pp41r_Pp41r_Pp41r_&on=phone")}?ref=${encodeURIComponent("https://vicinity.test")}`, "(on=phone: the approve page says back to Safari or Chrome)");
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

test("Safari finished a PAIRING (the 'Didn't work?' way): 'Keep going in Phantom' says one signature signs in there, never 'you're logged in there' (a pairing gives the wallet app no session: review finding safety-F6)", async () => {
  const { p, world } = await safari();
  const api0 = p.win.fetch;
  p.win.fetch = async (path, init) => {
    if (String(path).startsWith("/api/pair?code=")) return { ok: true, status: 200, json: async () => ({ ok: true, status: "ready" }) };
    if (String(path) === "/api/pair/finish") { world.linked = ADDR; return { ok: true, status: 200, json: async () => ({ ok: true, linked: true, wallet: ADDR, status: "done", next: "/dashboard?linked=1" }) }; }
    return api0(path, init);
  };
  await p.tap(phantomTile(p));
  await p.tap(p.$("#carry-pair"));
  assert.equal(p.screen(), "phone");
  await p.setHidden(true); await p.setHidden(false); await p.flush(); await p.advance(100);
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-h").textContent, "Phantom connected ✓");
  assert.equal(p.$("#done-sub").textContent, "Wallet 7Np4…T4K2 is on your account. Keep going in Phantom: sign in there with one free signature.");
  assert.equal(p.$("#done-go").textContent, "Open Phantom");
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
async function inPhantom({ info = () => INFO, claim = () => ({ ok: true, wallet: ADDR, next: "/dashboard?linked=1" }), message = null, ua = UA.phantomApp, wallets, me, search = `link=${CODE}`, session } = {}) {
  const { wallet, ctl } = fakeWallet("Phantom");
  let n = 0;
  const asked = [];
  const api = async (path, body) => {
    if (path === "/api/me/wallet/carry/info") return info(body);
    if (path === "/api/me/wallet/carry/claim") return claim(body);
    if (path.startsWith("/api/message")) { asked.push(path); return message ? message(path) : { message: MESSAGE + ++n }; }
    return { ok: true };
  };
  const geolocation = { getCurrentPosition: () => { geolocation.asked = true; } };
  const p = await openConnect({ ua, search, agreed: null, wallets: wallets || [wallet], api, me, geolocation, session });
  return { p, ctl, asked, geolocation };
}
const KEPT = "vicinity-link";

test("S8: Phantom's browser links NOTHING on load: whose account it is (masked name, the @handle, community, the check number), a warning, a choice; no location, Terms or Google", async () => {
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
  assert.match(words, /Only continue if YOU just tapped Connect wallet on this phone\. If someone sent you this link, stop: your wallet would join THEIR account\./);
  assert.equal(p.visible(p.$("#carry-in-here")), false, "this browser is nobody's: nothing to log out");
  assert.match(words, /The Terms of Use were accepted on that account\./);
  assert.equal(p.$("#carry-in-yes").textContent, "Yes, link my wallet");
  assert.equal(p.$("#carry-in-no").textContent, "No, that is not me");
  assert.equal(p.visible(p.$("#su-steps")), false);
  assert.equal(p.visible(p.$(".su-tabs")), false);
  assert.equal(p.$("#termsgate").hidden, true, "no Terms gate: they were accepted on that account");
  assert.equal(p.local.get("vicinity_terms"), undefined, "...but not noted in this browser before the person says it is theirs");
  assert.equal(p.$(".connect__intro .kicker").textContent, "Almost done");
  assert.equal(p.visible(p.$(".connect__intro")), false, "the question is the heading: no hero above it on a phone");
  assert.equal(JSON.parse(p.session.get(KEPT)).code, CODE, "kept in this tab, so a reload shows the question again");
});

test("F1: a reload (pull-to-refresh) on the confirm screen offers the kept code again: the same question, no Terms gate, no step 1; forgotten after an hour, after the link, or on 'not me'", async () => {
  const { p } = await inPhantom();
  const { p: r } = await inPhantom({ search: "", session: p.session }); // the same tab, reloaded: the address bar holds nothing
  assert.deepEqual(r.callsTo("/api/me/wallet/carry/info").map((c) => c.body), [{ code: CODE }]);
  assert.equal(r.screen(), "carry-in");
  assert.equal(r.$("#carry-in-pin").textContent, "47");
  assert.equal(r.$("#termsgate").hidden, true);
  assert.equal(r.visible(r.$("#su-steps")), false);
  assert.equal(r.calls.filter((c) => c.path.startsWith("/api/signup/") || c.path.startsWith("/api/auth/google")).length, 0);
  // kept more than an hour ago: an ordinary visit (the gate, the sign-up)
  const old = new Map([[KEPT, JSON.stringify({ code: CODE, at: Date.now() - 61 * 60_000 })]]);
  const { p: s } = await inPhantom({ search: "", session: old });
  assert.equal(s.callsTo("/api/me/wallet/carry/info").length, 0);
  assert.equal(s.screen(), "pick", "(inside the wallet app an ordinary visit opens on Log in)"); assert.equal(s.$("#termsgate").hidden, false);
  assert.equal(s.session.get(KEPT), undefined, "and thrown away");
  // a pairing in the address bar, or a code there, wins over a kept one (never two codes)
  const { p: t } = await inPhantom({ session: p.session, info: () => ({ ...INFO, pin: "58" }) });
  assert.equal(t.$("#carry-in-pin").textContent, "58");
  // forgotten once the link went through (one wallet in the app: "Yes" connects and signs at once), and when the person says it is not them
  const { p: u } = await inPhantom(); await u.tap(u.$("#carry-in-yes")); await u.flush();
  assert.equal(u.screen(), "done"); assert.equal(u.session.get(KEPT), undefined);
  const { p: v } = await inPhantom(); await v.tap(v.$("#carry-in-no"));
  assert.equal(v.screen(), "su-location"); assert.equal(v.session.get(KEPT), undefined);
});

test("S8: 'Yes, link my wallet' with one wallet in the app: its connect and sign sheets follow at once (no tile), the server links it, and this browser STAYS: its own dashboard opens here, logged in", async () => {
  const { p, ctl, asked } = await inPhantom({ info: () => ({ ...INFO, opener: "N0nce_N0nce_N0nce_N0nce_N0nce_N0" }) });
  await p.tap(p.$("#carry-in-yes"));
  await p.flush();
  assert.equal(p.visible(p.$("#carry-in-yes")), false);
  assert.equal(p.local.get("vicinity_terms"), "2026-10-01", "confirmed: the account's Terms are noted here, so nothing pops later");
  assert.equal(p.$("#termsgate").hidden, true);
  assert.equal(ctl.connects, 1, "no tile to tap: one wallet, so it is that one");
  assert.deepEqual(asked, [`/api/message?address=${ADDR}&action=link&code=${CODE}&opener=N0nce_N0nce_N0nce_N0nce_N0nce_N0`], "the LINK statement for the owner of this code, with the opener nonce (a browser that drops cookies)");
  assert.equal(ctl.signs, 1);
  const claims = p.callsTo("/api/me/wallet/carry/claim");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].body.code, CODE);
  assert.equal(claims[0].body.address, ADDR);
  assert.equal(claims[0].body.message, ctl.messages[0]);
  assert.equal(claims[0].body.opener, "N0nce_N0nce_N0nce_N0nce_N0nce_N0");
  assert.equal(claims[0].body.app, "phantom", "the app it is linked in (Safari's dashboard names it)");
  assert.equal(Buffer.from(claims[0].body.signature, "base64").length, 64);
  assert.equal(p.screen(), "done");
  // MOVED (owner decision F4): the wallet app's browser no longer sends the person back to Safari; it opens its own dashboard
  assert.equal(p.$("#done-h").textContent, "Phantom connected ✓");
  assert.equal(p.$("#done-sub").textContent, "Wallet 7Np4…T4K2 is on your account. Opening your dashboard…");
  assert.equal(p.$("#done-go").getAttribute("href"), "/dashboard?linked=1");
  assert.equal(p.visible(p.$("#done-stay")), false);
  assert.equal(p.local.get("vicinity.walletApp"), "phantom");
  await p.advance(1400);
  assert.deepEqual(p.assigned, []);
  await p.advance(200);
  assert.deepEqual(p.replaced, ["/dashboard?linked=1"], "replace: Back from the dashboard does not bounce through this page");
});

test("S8: several wallets in the app (or a refused sheet): the tiles, one tap each; the first sheet refused leaves the tile to try again", async () => {
  const two = [fakeWallet("Phantom"), fakeWallet("Backpack")];
  const { p } = await inPhantom({ wallets: two.map((w) => w.wallet) });
  await p.tap(p.$("#carry-in-yes"));
  assert.equal(p.$("#carry-in-tap").textContent, "Tap your wallet and sign. Nothing is paid or moved.");
  assert.deepEqual(p.$("#carry-in-wallets").children.map((t) => t.textContent), ["PhantomDetected", "BackpackDetected"]);
  assert.equal(two[0].ctl.connects + two[1].ctl.connects, 0, "nothing until a tile is tapped");
  // one wallet, the sign sheet refused: said, and the tile is there to try again
  const { p: q, ctl } = await inPhantom();
  ctl.sign = "reject";
  await q.tap(q.$("#carry-in-yes")); await q.flush();
  assert.equal(q.$("#carry-in-error").textContent, "Signing cancelled in your wallet. Nothing happened.");
  assert.deepEqual(q.$("#carry-in-wallets").children.map((t) => t.textContent), ["PhantomDetected"]);
  ctl.sign = "ok";
  await q.tap(q.$("#carry-in-wallets").children[0]); await q.flush();
  assert.equal(q.screen(), "done");
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
    assert.equal(p.session.get(KEPT), undefined, "nothing kept: this browser cannot use it");
  }
});

test("F1 S8: a used or expired link, another connection, or an account that got its wallet meanwhile: ONE plain screen inside the wallet app, no Terms gate, no step 1, nothing linked, and the code is kept so a reload shows the same screen", async () => {
  for (const [error, status, h, words] of [
    ["carry_expired", 410, "Almost there", /^This link is old\. Go back to Safari or Chrome and tap “Connect wallet” again\.$/],
    // (it quotes the button Safari shows once it learns the link was refused here: review finding ux-UX-2)
    ["carry_network", 403, "That link can't be used here", /^Your wallet app and Safari are on different internet connections \(Wi-Fi and mobile data\?\)\. Go back to Safari or Chrome and tap “Approve in Phantom instead”: that way works on any connection\.$/],
    ["carry_opened", 403, "That link was opened in another app", /^For your safety it no longer works\. Go back to Safari or Chrome and tap “Get a new link”\. That stops the old one\.$/],
    ["link_done", 409, "A wallet is already linked", /^This account has its wallet\. If it is the one in Phantom, sign in with it here\.$/],
  ]) {
    const { p, geolocation } = await inPhantom({ info: () => ({ ok: false, error, _status: status }) });
    assert.equal(p.screen(), "link-dead", error);
    assert.equal(p.$("#ld-h").textContent, h, error);
    assert.match(p.$("#ld-body").textContent, words, error);
    assert.equal(p.$("#termsgate").hidden, true, `${error}: no Terms gate at the wallet stage`);
    assert.equal(p.visible(p.$("#su-steps")), false); assert.equal(p.visible(p.$(".su-tabs")), false); assert.equal(p.visible(p.$(".connect__intro")), false);
    assert.equal(p.calls.filter((c) => c.path.startsWith("/api/signup/") || c.path.startsWith("/api/auth/google")).length, 0, "no sign-up, no Google");
    assert.equal(geolocation.asked, undefined, "no location check");
    assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0);
    assert.equal(p.$("#ld-copy"), null, "no 'Copy vicinity.city/connect': a button only where there is something to do here");
    assert.equal(p.visible(p.$("#ld-retry")), false);
    assert.equal(p.visible(p.$("#ld-signin")), error === "link_done", `${error}: Sign in with Phantom only when the account has its wallet`);
    assert.equal(JSON.parse(p.session.get(KEPT)).code, CODE, "kept: a reload shows this screen again, never the sign-up");
    const { p: again } = await inPhantom({ search: "", session: p.session, info: () => ({ ok: false, error, _status: status }) });
    assert.equal(again.screen(), "link-dead"); assert.equal(again.$("#termsgate").hidden, true);
  }
  // no answer at all (offline, a 503): say so and offer to try again; the code stays kept for that
  const { p } = await inPhantom({ info: () => ({ ok: false, error: "offline", _status: 0 }) });
  assert.equal(p.screen(), "link-dead");
  assert.equal(p.$("#ld-h").textContent, "Couldn't check your link");
  assert.equal(p.$("#ld-body").textContent, "Couldn't reach Vicinity. Check your connection and try again.");
  assert.equal(p.visible(p.$("#ld-retry")), true); assert.equal(p.visible(p.$("#ld-signin")), false);
  await p.tap(p.$("#ld-retry"));
  assert.deepEqual(p.assigned, ["reload"]); assert.equal(JSON.parse(p.session.get(KEPT)).code, CODE);
  // "log in here with your e-mail and password": the ordinary Log in tab, and only now the Terms gate (the person chose the ordinary page)
  const { p: q } = await inPhantom({ info: () => ({ ok: false, error: "carry_expired", _status: 410 }) });
  await q.tap(q.$("#ld-login"));
  assert.equal(q.screen(), "pick"); assert.equal(q.$("#tab-login").getAttribute("aria-pressed"), "true");
  assert.equal(q.$("#termsgate").hidden, false);
  assert.equal(q.session.get(KEPT), undefined, "forgotten: a reload is an ordinary visit now");
  assert.equal(q.visible(q.$("#lg-google")), false, "Google cannot run inside a wallet app: e-mail and the wallet only");
});

test("S8: the claim fails after the person signed: used meanwhile (back to Safari), another account logged in here, the wallet is another account's, or a passing failure (try again)", async () => {
  let { p } = await inPhantom({ claim: () => ({ ok: false, error: "carry_expired", _status: 410 }) });
  await p.tap(p.$("#carry-in-yes")); await p.flush();
  assert.equal(p.$("#termsgate").hidden, true, "the person said the account was theirs: its Terms count here");
  assert.equal(p.screen(), "link-dead", "used meanwhile: the one plain screen, back to Safari (never the sign-up)");
  assert.equal(p.$("#ld-h").textContent, "Almost there");
  assert.match(p.$("#ld-body").textContent, /This link is old/);

  ({ p } = await inPhantom({ claim: () => ({ ok: false, error: "already_signed_in", _status: 409 }) }));
  await p.tap(p.$("#carry-in-yes")); await p.flush();
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-error").textContent, "This app is logged in to another Vicinity account. Open the link again from Safari or Chrome: it offers to log it out here.");

  // the wallet belongs to another account: said, with the one tap that signs in to THAT account (its own)
  ({ p } = await inPhantom({ claim: () => ({ ok: false, error: "wallet_taken", _status: 409 }) }));
  await p.tap(p.$("#carry-in-yes")); await p.flush();
  assert.equal(p.$("#carry-in-error").textContent, "This wallet already has a Vicinity account. Pick another wallet in Phantom, or sign in to that account with it.");
  assert.equal(p.visible(p.$("#carry-in-signin")), true); assert.equal(p.$("#carry-in-signin").textContent, "Sign in with Phantom");
  await p.tap(p.$("#carry-in-signin"));
  assert.deepEqual(p.assigned, ["/connect?mode=login&with=phantom"]);
  assert.equal(p.session.get(KEPT), undefined);

  let n = 0;
  ({ p } = await inPhantom({ claim: () => (++n === 1 ? { ok: false, error: "offline", _status: 503 } : { ok: true, wallet: ADDR, next: "/dashboard?linked=1" }) }));
  await p.tap(p.$("#carry-in-yes")); await p.flush();
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-error").textContent, "Couldn't reach Vicinity. Check your connection and try again.");
  await p.tap(p.$("#carry-in-wallets").children[0]); await p.flush();
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#carry-in-error").textContent, "");
});

test("S8: the link died while the question was on screen (it ran out, or someone else opened it): the statement is refused, so the same one plain screen as a refused claim, nothing signed, no tile that could never work", async () => {
  for (const [error, status, h, body] of [
    ["carry_expired", 410, "Almost there", /^This link is old\. Go back to Safari or Chrome and tap “Connect wallet” again\.$/],
    ["carry_opened", 403, "That link was opened in another app", /^For your safety it no longer works\./],
    ["carry_network", 403, "That link can't be used here", /different internet connections/],
  ]) {
    const { p, ctl } = await inPhantom({ message: () => ({ ok: false, error, _status: status }) });
    await p.tap(p.$("#carry-in-yes")); await p.flush();
    assert.equal(p.screen(), "link-dead", error);
    assert.equal(p.$("#ld-h").textContent, h, error);
    assert.match(p.$("#ld-body").textContent, body, error);
    assert.equal(ctl.signs, 0, `${error}: nothing signed`);
    assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0, error);
    assert.equal(p.$("#termsgate").hidden, true, `${error}: the gate stays shut (the person said the account was theirs)`);
  }
});

test("S8: signing cancelled in the wallet: said on the question, nothing sent, the tile works again", async () => {
  const { p, ctl } = await inPhantom();
  ctl.sign = "reject";
  await p.tap(p.$("#carry-in-yes")); await p.flush();
  assert.equal(p.$("#carry-in-error").textContent, "Signing cancelled in your wallet. Nothing happened.");
  assert.equal(p.callsTo("/api/me/wallet/carry/claim").length, 0);
  ctl.sign = "ok";
  await p.tap(p.$("#carry-in-wallets").children[0]); await p.flush();
  assert.equal(p.screen(), "done");
});

test("S8: the same person is already logged in inside the wallet app's browser: the question still shows (the claim replaces that session), never a jump to the dashboard", async () => {
  const { p } = await inPhantom({ me: LINK_ME });
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 1);
});

test("a wallet app's browser opened without a code: no info, no claim, the gate; it opens on Log in with ONE button for its wallet (MOVED, owner decision F4: a sign-up's location rarely works in a wallet app), New here one tap away", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openConnect({ ua: UA.phantomApp, agreed: null, wallets: [wallet], state: STATE.empty() });
  assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 0);
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
  assert.equal(p.visible(p.$("#lg-wallet")), true); assert.equal(p.$("#lg-wallet").textContent, "Sign in with Phantom");
  assert.equal(p.$("#lg-wallet-note").textContent, "One free signature. Nothing is paid or moved.");
  await p.tap(p.$("#lg-join"));
  assert.equal(p.screen(), "su-location");
});

test("the old sign-up's /connect?carry= link: one calm line, the ordinary tabs, the gate; a member without a wallet lands in the link mode", async () => {
  const { p } = await inPhantom({ search: `carry=${CODE}` });
  assert.equal(p.callsTo("/api/me/wallet/carry/info").length, 0);
  assert.equal(p.calls.filter((c) => c.path.startsWith("/api/signup/carry")).length, 0, "the old routes are gone: never called");
  assert.equal(p.addressBar.at(-1), "https://vicinity.test/connect");
  assert.equal(p.$("#termsgate").hidden, false);
  assert.equal(p.screen(), "pick", "inside the wallet app: the Log in tab (its wallet signs in with one tap)");
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
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

test("/connect?mode=link&app=phantom (the dashboard's 'Link with Phantom'): the code is made and the Open Phantom screen shows at once, the name leaves the address bar", async () => {
  const { p } = await safari({ search: "mode=link&app=phantom" });
  assert.equal(p.callsTo("/api/me/wallet/carry").length, 1, "one code, made without a tap");
  assert.equal(p.screen(), "carry");
  assert.equal(p.$("#carry-h").textContent, "Connect your wallet in Phantom");
  assert.equal(p.$("#carry-pin").textContent, "47");
  assert.equal(p.$("#carry-open").textContent, "Open Phantom");
  assert.ok(!p.addressBar[p.addressBar.length - 1].includes("app="), p.addressBar.join(" "));
  assert.equal(p.session.get("su-carry"), "Phantom");
  assert.equal(p.session.get("vl-started"), "1");
  // an unknown app name, or a computer: the tiles, nothing made
  const { p: q } = await safari({ search: "mode=link&app=nosuchwallet" });
  assert.equal(q.callsTo("/api/me/wallet/carry").length, 0); assert.equal(q.screen(), "pick");
  const r = await openConnect({ ua: UA.desktop, search: "mode=link&app=phantom", me: LINK_ME });
  assert.equal(r.callsTo("/api/me/wallet/carry").length, 0, "a computer has no app to open"); assert.equal(r.screen(), "pick");
});
