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
      return { ok: true, status: world.status, ...(world.status === "expired" && world.relay ? { relay: true } : {}) };
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
  assert.equal(p.$("#carry-error").textContent, "That link ran out (open it within 2 minutes). Get a new link.");
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

test("back in Safari and Phantom never opened the link: what to do, on an iPhone (press and hold) and on Android", async () => {
  for (const [ua, words] of [[UA.iphone, "Phantom didn't open Vicinity? Press and hold “Open Phantom”, then choose “Open in Phantom”. No Phantom yet? Get it first."],
    [UAS.android, "Phantom didn't open Vicinity? Make sure Phantom is installed, or open this page in Chrome and try again."]]) {
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
