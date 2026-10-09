// Phones live inside the wallet app (owner decision F4, 10 Oct 2026), the /connect page's side. Runs the real page in node
// (test/helpers/connectpage.js): Safari's "Connect Phantom" screen (relay links renewed quietly, a link that never opened Phantom, a
// link this tab kept), and inside the wallet app: one tap signs in, "Sign in with Phantom" links (/connect?mode=login&with=phantom)
// start by themselves, the Terms gate is the account's, and a browser signed in to someone else is told so before anything is signed.
// Instagram's or Facebook's in-app browser is NOT a wallet app: it keeps the ordinary sign-up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, LINK_ME, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

const UAS = {
  ...UA,
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0", // a web view, no wallet
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
};
const CODE = "Cc0de_Cc0de_Cc0de_Cc0de_Cc0de_Cc";
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const phantomLink = (url) => `https://phantom.com/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent("https://vicinity.test")}`;

/** A wallet app's browser on /connect (a visitor), its wallet on the page. `signIn` = what POST /api/auth/wallet answers. */
async function inApp({ search = "", wallets, signIn = (b) => ({ ok: true, wallet: b.address, next: "/dashboard" }), me = {}, agreed = null, ua = UA.phantomApp, extra = {} } = {}) {
  const made = wallets || [fakeWallet("Phantom")];
  let n = 0;
  const api = async (path, body) => {
    if (extra[path]) return extra[path](body);
    if (path.startsWith("/api/message")) return { message: `${MESSAGE}${++n}` };
    if (path === "/api/auth/wallet") return signIn(body);
    return { ok: true };
  };
  const p = await openConnect({ ua, search, agreed, wallets: made.map((w) => w.wallet), api, me, state: STATE.empty() });
  return { p, ctl: made[0] && made[0].ctl };
}

/* ---------------- inside the wallet app: one tap, and "Sign in with Phantom" links ---------------- */

test("inside a wallet app one tile tap connects AND signs (no 'Sign in' tap); on a computer the sign screen still waits for it", async () => {
  const { p, ctl } = await inApp({ search: "mode=login", agreed: "2026-10-01" });
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
  await p.tap(p.$("#wallets-detected").children[0]); await p.flush();
  assert.deepEqual([ctl.connects, ctl.signs], [1, 1], "the connect sheet, then the sign sheet");
  assert.equal(p.callsTo("/api/auth/wallet").length, 1);
  assert.equal(p.screen(), "done");
  assert.equal(p.local.get("vicinity.walletApp"), "phantom", "signed in inside Phantom: the app this phone uses");
  // a computer with the extension: today's two steps
  const { wallet, ctl: c2 } = fakeWallet("Phantom");
  const q = await openConnect({ ua: UA.desktop, search: "mode=login", wallets: [wallet], api: async (path) => (path.startsWith("/api/message") ? { message: MESSAGE } : { ok: true }), state: STATE.empty() });
  await q.tap(q.$("#wallets-detected").children[0]); await q.flush();
  assert.equal(q.screen(), "sign");
  assert.deepEqual([c2.connects, c2.signs], [1, 0], "the computer waits for the person's 'Sign in'");
  assert.equal(q.local.get("vicinity.walletApp"), undefined, "a computer is no wallet app");
});

test("the Log in tab inside a wallet app leads with ONE 'Sign in with Phantom' button (connect + one signature); several wallets: the tiles", async () => {
  const { p, ctl } = await inApp({ agreed: "2026-10-01" });
  assert.equal(p.screen(), "pick"); assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true", "a wallet app opens on Log in");
  assert.equal(p.visible(p.$("#lg-wallet")), true); assert.equal(p.$("#lg-wallet").textContent, "Sign in with Phantom");
  await p.tap(p.$("#lg-wallet")); await p.flush();
  assert.deepEqual([ctl.connects, ctl.signs], [1, 1]);
  assert.equal(p.screen(), "done");
  const two = [fakeWallet("Phantom"), fakeWallet("Backpack")];
  const { p: q } = await inApp({ wallets: two, agreed: "2026-10-01" });
  assert.equal(q.visible(q.$("#lg-wallet")), false, "several wallets: one tap on the right tile");
  assert.equal(q.visible(q.$("#lg-join")), true);
});

test("/connect?mode=login&with=phantom inside Phantom (a visitor): the sign-in starts by itself, once; the Terms gate waits and is noted from the account; the parameter leaves the address bar", async () => {
  let signed = false; // /api/me answers for the account once the wallet signed in (its Terms version included)
  const { p, ctl } = await inApp({
    search: "mode=login&with=phantom",
    signIn: (b) => { signed = true; return { ok: true, wallet: b.address, next: "/dashboard" }; },
    me: () => (signed ? { signedIn: true, user: { id: 1, wallet: ADDR, handle: "Sam" }, termsVersion: "2026-10-01" } : {}),
  });
  await p.flush();
  assert.deepEqual([ctl.connects, ctl.signs], [1, 1], "connect, then ONE signature, with no tap");
  assert.ok(!p.addressBar.at(-1).includes("with="), p.addressBar.join(" "));
  assert.equal(p.$("#termsgate").hidden, true, "no gate while the sign-in runs");
  assert.equal(p.screen(), "done");
  await p.flush();
  assert.equal(p.local.get("vicinity_terms"), "2026-10-01", "the account agreed: noted here, so the dashboard shows no gate");
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard"]);
});

test("with=phantom refused or cancelled in the wallet: today's Sign in button stays, and this is a first visit after all (the gate)", async () => {
  const { p, ctl } = await inApp({ search: "mode=login&with=phantom", wallets: [(() => { const w = fakeWallet("Phantom"); w.ctl.sign = "reject"; return w; })()] });
  await p.flush();
  assert.equal(ctl.signs, 1);
  assert.equal(p.screen(), "sign");
  assert.match(p.$("#c-error").textContent, /cancelled/);
  assert.equal(p.$("#termsgate").hidden, false);
  // no account for that wallet: the no-account screen, and the gate
  const { p: q } = await inApp({ search: "mode=login&with=phantom", signIn: () => ({ ok: false, error: "no_account", _status: 404 }) });
  await q.flush();
  assert.equal(q.screen(), "no-account"); assert.equal(q.$("#termsgate").hidden, false);
});

test("with=phantom anywhere else (Safari, a computer, another wallet app's browser): nothing starts, the ordinary Log in tab and the gate", async () => {
  for (const [ua, wallets] of [[UA.iphone, []], [UA.desktop, [fakeWallet("Phantom")]], [UA.phantomApp, [fakeWallet("Backpack")]]]) {
    const { p, ctl } = await inApp({ ua, wallets, search: "mode=login&with=phantom" });
    await p.advance(3500);
    if (ctl) assert.equal(ctl.connects, 0, ua);
    assert.equal(p.callsTo("/api/auth/wallet").length, 0, ua);
    assert.equal(p.$("#termsgate").hidden, false, `${ua}: the gate`);
    assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
  }
});

test("with=phantom in a wallet app that is signed in already: straight to the dashboard (replace), the account's Terms noted", async () => {
  const { p, ctl } = await inApp({ search: "mode=login&with=phantom", me: { signedIn: true, user: { id: 1, wallet: ADDR, handle: "Sam" }, termsVersion: "2026-10-01" } });
  assert.deepEqual(p.replaced, ["/dashboard"]);
  assert.equal(ctl.connects, 0);
  assert.equal(p.local.get("vicinity_terms"), "2026-10-01");
  assert.equal(p.$("#termsgate").hidden, true);
});

test("'Open Phantom' from Safari's 'confirm it's you' lands where the person was (next=/dashboard#profile), signed in already or after the one signature; anything else in next= is the dashboard (review finding ux-UX-3)", async () => {
  const { p } = await inApp({ search: `mode=login&with=phantom&next=${encodeURIComponent("/dashboard#profile")}`, me: { signedIn: true, user: { id: 1, wallet: ADDR, handle: "Sam" }, termsVersion: "2026-10-01" } });
  assert.deepEqual(p.replaced, ["/dashboard#profile"]);
  let signed = false;
  const { p: q, ctl } = await inApp({
    search: `mode=login&with=phantom&next=${encodeURIComponent("/dashboard#city")}`,
    signIn: (b) => { signed = true; return { ok: true, wallet: b.address, next: "/dashboard" }; },
    me: () => (signed ? { signedIn: true, user: { id: 1, wallet: ADDR, handle: "Sam" }, termsVersion: "2026-10-01" } : {}),
  });
  await q.flush();
  assert.deepEqual([ctl.connects, ctl.signs], [1, 1]);
  assert.ok(!q.addressBar.at(-1).includes("next="), "next= leaves the address bar with with=");
  await q.advance(1300);
  assert.deepEqual(q.assigned, ["/dashboard#city"]);
  for (const bad of ["https://evil.example/x", "//evil.example", "/connect", "/dashboard#x y", "/dashboard?welcome=2", "/dashboard#Profile"]) {
    const { p: r } = await inApp({ search: `mode=login&with=phantom&next=${encodeURIComponent(bad)}`, me: { signedIn: true, user: { id: 1, wallet: ADDR, handle: "Sam" }, termsVersion: "2026-10-01" } });
    assert.deepEqual(r.replaced, ["/dashboard"], bad);
  }
});

test("a wallet app whose wallet turns up a few seconds late (review finding ux-UX-4): a visitor who has not touched the page gets the Log in tab and 'Sign in with Phantom' after all; someone already on New here is never moved", async () => {
  const late = fakeWallet("Phantom");
  const p = await openConnect({ ua: UA.phantomApp, state: STATE.empty(), agreed: "2026-10-01" });
  assert.equal(p.$("#tab-new").getAttribute("aria-pressed"), "true", "no wallet yet: New here, as for anyone");
  await p.advance(2000);
  p.register(late.wallet); await p.flush();
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
  assert.equal(p.screen(), "pick");
  assert.equal(p.visible(p.$("#lg-wallet")), true);
  assert.equal(p.$("#lg-wallet").textContent, "Sign in with Phantom");
  // touched first: stays
  const q = await openConnect({ ua: UA.phantomApp, state: STATE.empty(), agreed: "2026-10-01" });
  q.$("#connect-panel").click(); await q.flush();
  q.register(fakeWallet("Phantom").wallet); await q.flush();
  assert.equal(q.$("#tab-new").getAttribute("aria-pressed"), "true");
  // on the Log in tab already, a late wallet shows its button
  const r = await openConnect({ ua: UA.phantomApp, search: "mode=login", state: STATE.empty(), agreed: "2026-10-01" });
  assert.equal(r.visible(r.$("#lg-wallet")), false);
  r.register(fakeWallet("Phantom").wallet); await r.flush();
  assert.equal(r.visible(r.$("#lg-wallet")), true);
  // Safari: a wallet never turns up, nothing moves
  const s = await openConnect({ ua: UA.iphone, state: STATE.empty(), agreed: "2026-10-01" });
  await s.advance(6000);
  assert.equal(s.$("#tab-new").getAttribute("aria-pressed"), "true");
});

test("Instagram's (or Facebook's) in-app browser is not a wallet app: New here first, no 'Sign in with' button, Google is still hidden there", async () => {
  const p = await openConnect({ ua: UAS.instagram, state: STATE.empty() });
  assert.equal(p.win.V.walletApp.here(), null);
  assert.equal(p.screen(), "su-location");
  assert.equal(p.$("#tab-new").getAttribute("aria-pressed"), "true");
  await p.tap(p.$("#tab-login"));
  assert.equal(p.visible(p.$("#lg-wallet")), false);
  assert.equal(p.visible(p.$("#lg-join")), false);
});

/* ---------------- the wallet app's confirm screen: signed in to someone else ---------------- */

test("the wallet app is logged in to SOMEONE ELSE: said before anything is signed; 'Yes, log out Jo••• and link' logs out here first, then connects, signs and claims", async () => {
  const { wallet, ctl } = fakeWallet("Phantom");
  const order = [];
  const api = async (path, body) => {
    order.push(path.split("?")[0]);
    if (path === "/api/me/wallet/carry/info") return { ok: true, pin: "47", owner: { name: "Sa•••", handle: "SwiftHarbor10", initial: "S" }, community: { name: "Utica", country: "US" }, terms: "2026-10-01", expiresAt: inMinutes(9), relay: true, here: "Jo•••", opener: "N0nce_N0nce_N0nce_N0nce_N0nce_N0" };
    if (path.startsWith("/api/message")) return { message: MESSAGE };
    if (path === "/api/me/wallet/carry/claim") return { ok: true, wallet: ADDR, app: "phantom", next: "/dashboard?linked=1" };
    return { ok: true };
  };
  const p = await openConnect({ ua: UA.phantomApp, search: `link=${CODE}`, agreed: null, wallets: [wallet], api, me: { signedIn: true, user: { id: 9, handle: "Jo99", wallet: null } } });
  assert.equal(p.screen(), "carry-in");
  assert.equal(p.$("#carry-in-handle").textContent, "@SwiftHarbor10", "the whole @username: the same as the statement it signs");
  assert.equal(p.visible(p.$("#carry-in-here")), true);
  assert.equal(p.$("#carry-in-here").textContent, "This app is logged in to Jo•••'s account. Linking logs it out here.");
  assert.equal(p.$("#carry-in-yes").textContent, "Yes, log out Jo••• and link");
  assert.equal(ctl.connects, 0);
  await p.tap(p.$("#carry-in-yes")); await p.flush();
  const at = (x) => order.indexOf(x);
  assert.ok(at("/api/auth/logout") > -1 && at("/api/auth/logout") < at("/api/message") && at("/api/message") < at("/api/me/wallet/carry/claim"), order.join(" "));
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-h").textContent, "Phantom connected ✓");
});

test("a link_done dead screen inside the wallet app: Sign in with Phantom (one tap, one signature); the kept link is forgotten first", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openConnect({ ua: UA.phantomApp, search: `link=${CODE}`, agreed: null, wallets: [wallet], api: async (path) => (path === "/api/me/wallet/carry/info" ? { ok: false, error: "link_done", _status: 409 } : { ok: true }) });
  assert.equal(p.screen(), "link-dead");
  assert.equal(p.$("#ld-signin").textContent, "Sign in with Phantom");
  await p.tap(p.$("#ld-signin"));
  assert.deepEqual(p.assigned, ["/connect?mode=login&with=phantom"]);
  assert.equal(p.session.get("vicinity-link"), undefined);
});

test("a dead link this tab kept never hides what the address bar asks for next ('Sign in with Phantom' after another way linked it); a bare reload still shows it", async () => {
  const { wallet } = fakeWallet("Phantom");
  const dead = async (path) => (path === "/api/me/wallet/carry/info" ? { ok: false, error: "carry_network", relay: true, _status: 403 } : { ok: true });
  const p = await openConnect({ ua: UA.phantomApp, search: `link=${CODE}`, agreed: null, wallets: [wallet], api: dead });
  assert.equal(p.screen(), "link-dead");
  assert.equal(JSON.parse(p.session.get("vicinity-link")).code, CODE, "kept: a reload shows the same screen");
  const again = await openConnect({ ua: UA.phantomApp, search: "", agreed: null, wallets: [fakeWallet("Phantom").wallet], session: p.session, api: dead });
  assert.equal(again.screen(), "link-dead");
  // the same tab, later: Safari's "Open Phantom" (/connect?mode=login&with=phantom) after the pairing linked the wallet
  const { wallet: w2, ctl } = fakeWallet("Phantom");
  let signed = false;
  const q = await openConnect({ ua: UA.phantomApp, search: "mode=login&with=phantom", agreed: null, wallets: [w2], session: p.session,
    api: async (path, body) => (path.startsWith("/api/message") ? { message: MESSAGE } : path === "/api/auth/wallet" ? ((signed = true), { ok: true, wallet: body.address, next: "/dashboard" }) : { ok: true }),
    me: () => (signed ? { signedIn: true, user: { id: 1, wallet: ADDR, handle: "Sam" }, termsVersion: "2026-10-01" } : {}) });
  await q.flush();
  assert.equal(q.callsTo("/api/me/wallet/carry/info").length, 0, "the kept code is not offered again");
  assert.equal(q.session.get("vicinity-link"), undefined, "and it is forgotten");
  assert.deepEqual([ctl.connects, ctl.signs], [1, 1], "the sign-in starts by itself");
  assert.equal(q.screen(), "done");
});

test("a link code's page never shows the sign-up's hero first (site.js marks it); the ordinary page gets it back", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openConnect({ ua: UA.phantomApp, search: `link=${CODE}`, agreed: null, wallets: [wallet], api: async (path) => (path === "/api/me/wallet/carry/info" ? { ok: true, pin: "47", owner: {}, terms: "2026-10-01" } : { ok: true }) });
  assert.ok(p.doc.documentElement.classList.contains("has-link"));
  await p.tap(p.$("#carry-in-no"));
  assert.equal(p.doc.documentElement.classList.contains("has-link"), false, "'not me': the ordinary page, with its hero");
  const q = await openConnect({ ua: UA.iphone, state: STATE.empty() });
  assert.equal(q.doc.documentElement.classList.contains("has-link"), false);
});

/* ---------------- Safari: the "Connect Phantom" screen ---------------- */

/**
 * Safari on a phone in the link mode. world.relay: the server makes relay codes (openBy in 2 minutes); world.status: the code's status.
 * opts.world: the server as it is before the page loads (a reloaded tab's kept link is asked about while the page opens).
 */
async function safari(opts = {}) {
  const world = { codes: 0, status: "waiting", relay: false, linked: null, live: null, ...(opts.world || {}) };
  const api = async (path, body) => {
    if (path === "/api/me/wallet/carry") {
      world.codes++;
      world.live = `ref${String(world.codes).padStart(9, "0")}`;
      const code = `${CODE.slice(0, 30)}${String(world.codes).padStart(2, "0")}`;
      return { ok: true, code, pin: String(40 + world.codes), ref: world.live, url: `https://vicinity.test/connect?link=${code}`, expiresAt: inMinutes(10), ...(world.relay ? { relay: true, openBy: inMinutes(2) } : {}) };
    }
    if (path.startsWith("/api/me/wallet/carry/status?ref=")) {
      const ref = decodeURIComponent(path.split("ref=")[1]);
      if (world.linked) return { ok: true, status: "linked", wallet: world.linked, app: "phantom" };
      if (ref !== world.live) return { ok: true, status: "replaced" };
      return { ok: true, status: world.status, ...((world.status === "expired" || world.status === "refused") && world.relay ? { relay: true } : {}) };
    }
    return { ok: true };
  };
  const p = await openConnect({ ua: opts.ua || UA.iphone, api, me: () => ({ ...LINK_ME, user: { ...LINK_ME.user, wallet: world.linked } }), session: opts.session, storage: opts.storage, search: opts.search || "" });
  return { p, world };
}
const tile = (p) => p.$("#wallets-known").children.find((t) => /Phantom/.test(t.textContent));

test("relay link (iCloud Private Relay): the plain small print, and while it is on screen and nobody opened it, a new one comes quietly before its 2 minutes are up (at most 3 times), then 'ran out'", async () => {
  const { p, world } = await safari();
  world.relay = true;
  await p.tap(tile(p));
  assert.equal(p.$("#carry-small").textContent, "This link works once, only on this phone. Never send it to anyone.");
  const first = p.$("#carry-open").href;
  await p.advance(106_000);
  assert.equal(world.codes, 2, "renewed 15 s before the 2 minutes");
  assert.notEqual(p.$("#carry-open").href, first);
  assert.equal(p.$("#carry-pin").textContent, "42", "the new number");
  assert.match(p.$("#carry-status-text").textContent, /^New link ready\. Waiting for Phantom…$/);
  await p.advance(106_000); await p.advance(106_000);
  assert.equal(world.codes, 4, "three quiet renewals");
  world.status = "expired";
  await p.advance(120_000);
  assert.equal(world.codes, 4, "no fourth");
  // (review finding ux-UX-7: no "(open it within 2 minutes)": the small print deliberately never mentions that rule)
  assert.equal(p.$("#carry-error").textContent, "That link ran out. Get a new link.");
  assert.equal(p.visible(p.$("#carry-renew")), true);
});

test("relay link: never renewed while Phantom is in front (the person may be opening it), nor once Phantom opened it", async () => {
  const { p, world } = await safari();
  world.relay = true;
  await p.tap(tile(p));
  await p.setHidden(true);
  await p.advance(110_000);
  assert.equal(world.codes, 1);
  world.status = "opened";
  await p.setHidden(false);
  await p.advance(60_000);
  assert.equal(world.codes, 1);
  assert.equal(p.$("#carry-status-text").textContent, "Phantom opened your link…");
});

test("someone else opened the link (contested): said plainly, the dead link is gone, and 'Get a new link' makes one", async () => {
  const { p, world } = await safari();
  await p.tap(tile(p));
  world.status = "contested";
  await p.advance(3000);
  assert.equal(p.$("#carry-error").textContent, "Someone else opened your link. It no longer works. Get a new link.");
  assert.equal(p.visible(p.$("#carry-open")), false);
  world.status = "waiting";
  await p.tap(p.$("#carry-renew"));
  assert.equal(world.codes, 2); assert.equal(p.visible(p.$("#carry-open")), true);
});

test("back in Safari and Phantom never opened the link: what to do, on an iPhone (press and hold), in Chrome on Android, and in another Android browser", async () => {
  // (review finding ux-UX-6: Chrome on Android was told to "open this page in Chrome": that line is for the other Android browsers)
  for (const [ua, words] of [[UA.iphone, "Phantom didn't open Vicinity? Press and hold “Open Phantom”, then choose “Open in Phantom”. No Phantom yet? Get it first."],
    [UAS.android, "Phantom didn't open Vicinity? Make sure Phantom is installed, then tap “Open Phantom” again. Or tap “Didn't work?” below."],
    [UAS.firefoxAndroid, "Phantom didn't open Vicinity? Make sure Phantom is installed, or open this page in Chrome and try again."]]) {
    const { p } = await safari({ ua });
    await p.tap(tile(p));
    assert.equal(p.visible(p.$("#carry-hint")), false);
    await p.setHidden(true); await p.setHidden(false); await p.flush();
    assert.equal(p.visible(p.$("#carry-hint")), true, ua);
    assert.equal(p.$("#carry-hint").textContent, words);
  }
});

test("'Open Phantom' fell back to phantom.com in this tab (no app, app links off) and the person comes Back: the same screen, with a NEW link (the old one may have been seen on the way) and the hint", async () => {
  const { p, world } = await safari();
  await p.tap(tile(p));
  const kept = JSON.parse(p.session.get("vicinity-carry"));
  assert.deepEqual(Object.keys(kept).sort(), ["id", "openBy", "pin", "ref", "relay", "until", "url"]);
  assert.equal(kept.id, "phantom");
  // the reloaded tab (Back from phantom.com reloads it): the server never saw the link opened
  const { p: back, world: w2 } = await safari({ session: p.session, storage: { "vicinity.walletApp": "phantom" }, world: { live: kept.ref, codes: world.codes } });
  await back.flush(); await back.advance(10);
  assert.equal(back.screen(), "carry");
  assert.equal(w2.codes, 2, "a fresh link at once, without a tap");
  assert.match(back.$("#carry-status-text").textContent, /^New link ready\./);
  assert.equal(back.visible(back.$("#carry-hint")), true);
  assert.notEqual(back.$("#carry-open").href, phantomLink(kept.url));
  // opened meanwhile: kept as it is (Phantom has it)
  const { p: again, world: w3 } = await safari({ session: p.session, world: { live: JSON.parse(p.session.get("vicinity-carry")).ref, codes: 5, status: "opened" } });
  await again.flush(); await again.advance(10);
  assert.equal(w3.codes, 5);
  assert.equal(again.$("#carry-status-text").textContent, "Phantom opened your link…");
});

test("back in Safari after installing the app (the tab stayed, minutes went by): a link nobody opened that ran out is replaced at once, quietly, never 'ran out'; at most 3 times a visit", async () => {
  // review finding ux-UX-7: only a RELOADED tab got this; the usual path ("Get it first" opens a new tab, this one stays) met "ran out"
  const { p, world } = await safari();
  world.relay = true;
  await p.tap(tile(p));
  await p.setHidden(true);
  world.status = "expired"; // 3 minutes in the App Store
  await p.setHidden(false); await p.flush();
  assert.equal(world.codes, 2, "a new link, no tap");
  assert.equal(p.$("#carry-status-text").textContent, "New link ready. Waiting for Phantom…");
  assert.equal(p.visible(p.$("#carry-open")), true);
  assert.equal(p.$("#carry-error").textContent, "");
  for (let i = 0; i < 4; i++) { await p.setHidden(true); world.status = "expired"; await p.setHidden(false); await p.flush(); }
  assert.equal(world.codes, 4, "three such renewals a visit, then the plain 'ran out' with its button");
  assert.equal(p.visible(p.$("#carry-renew")), true);
  // a link Phantom DID open and that ran out is not replaced behind the person's back
  const { p: q, world: w } = await safari();
  await q.tap(tile(q));
  w.status = "opened"; await q.advance(3000);
  await q.setHidden(true); w.status = "expired"; await q.setHidden(false); await q.flush();
  assert.equal(w.codes, 1);
});

test("Phantom opened the link but on another connection (status 'refused', review finding ux-UX-2): Safari says why, hides 'press and hold', and the pairing becomes THE button", async () => {
  const { p, world } = await safari();
  await p.tap(tile(p));
  await p.setHidden(true);
  world.status = "refused";
  await p.setHidden(false); await p.flush();
  assert.equal(p.$("#carry-error").textContent, "Phantom opened your link, but it is on another internet connection (Wi-Fi and mobile data?), so the link can't be used there. Approve in Phantom instead: that way works on any connection.");
  assert.equal(p.visible(p.$("#carry-hint")), false, "never 'press and hold': Phantom DID open it");
  assert.equal(p.visible(p.$("#carry-open")), false);
  assert.equal(p.visible(p.$("#carry-renew")), false);
  assert.equal(p.$("#carry-pair").className, "btn btn--primary btn--block");
  assert.equal(p.$("#carry-pair").textContent, "Approve in Phantom instead");
  // ...and if the right connection opens it after all, the ordinary screen comes back
  world.status = "opened"; await p.advance(3000);
  assert.equal(p.$("#carry-status-text").textContent, "Phantom opened your link…");
  assert.equal(p.$("#carry-pair").className, "link-btn");
  world.status = "refused"; // (a later refusal of an opened link changes nothing on screen)
});

test("a RELAY link opened in another country or through a VPN (status 'refused', relay; audit SEC-2): never 'approve instead' as the button (the pairing is bound to nothing): neutral words, a new link is the button, the pairing stays the quiet way", async () => {
  const { p, world } = await safari();
  world.relay = true;
  await p.tap(tile(p));
  await p.setHidden(true);
  world.status = "refused";
  await p.setHidden(false); await p.flush();
  assert.equal(p.$("#carry-error").textContent, "Your link was opened in another country or through a VPN, so it can't be used there. If that wasn't you, someone else has your link: get a new one, and never send it to anyone.");
  assert.doesNotMatch(p.$("#carry-error").textContent, /Approve in/, "the words never steer the person to the pairing");
  for (const id of ["#carry-open", "#carry-hint", "#carry-pinrow"]) assert.equal(p.visible(p.$(id)), false, id);
  assert.equal(p.visible(p.$("#carry-renew")), true, "Get a new link: THE button");
  assert.equal(p.$("#carry-pair").className, "link-btn", "the pairing: a quiet link, never the button");
  assert.equal(p.$("#carry-pair").textContent, "Didn't work? Approve in Phantom and finish here instead");
  await p.advance(130_000);
  assert.equal(world.codes, 1, "a refused relay link is not renewed away behind the person's back (the screen says why)");
  // the tap: a new link (the old one dies on the server), the ordinary screen again
  world.status = "waiting";
  await p.tap(p.$("#carry-renew"));
  assert.equal(world.codes, 2);
  assert.equal(p.visible(p.$("#carry-open")), true);
  assert.equal(p.$("#carry-error").textContent, "");
  assert.equal(p.$("#carry-pair").className, "link-btn");
});

test("the link this tab kept is forgotten when it is linked, and a bad or foreign one is never shown", async () => {
  const { p, world } = await safari();
  await p.tap(tile(p));
  world.linked = ADDR;
  await p.advance(3000);
  assert.equal(p.session.get("vicinity-carry"), undefined);
  const bad = new Map([["vicinity-carry", JSON.stringify({ id: "phantom", url: "https://evil.example/x", pin: "1", ref: "ref000000001", until: Date.now() + 60_000 })]]);
  const { p: q, world: w } = await safari({ session: bad });
  assert.equal(q.screen(), "pick"); assert.equal(w.codes, 0); assert.equal(q.session.get("vicinity-carry"), undefined);
});
