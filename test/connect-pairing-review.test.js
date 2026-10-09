// The phone pairing after the review of fix/pairing-polish, kept true for the link mode of onboarding v3 (test/connect-pairing.test.js
// has the rest):
//  F1 a pairing kept by this tab is forgotten only on a definite answer: one request that fails while the reloaded tab starts
//     (GET /api/me, /signup.js) keeps it, and the next load finishes with the approval already given.
//  F2 the wallet app's approve page shows the approve card at once, never today's pick screen while /api/me is on its way.
//  F3 a kept pairing that ran out before the person came back says so in one calm line, where it was started.
//  F4 a duplicated tab (same sessionStorage) that loses the race for the same pairing carries on from where the other tab got to,
//     and never tells a person whose wallet is linked that "the code expired".
//  F5 a tablet behind a relay shows the QR code for a phone, and the reason says that, not "approve in Phantom below".
//  and the nits: a failed start keeps the wallet and the reason for the retry; blocked storage leaves scrolling alone; plain words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, LINK_ME, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

const PAIR = "Pp41r_Pp41r_Pp41r_Pp41r_";
const KEY = "vicinity-pair";
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const RELAY_WHY = "Your iPhone hides its connection (iCloud Private Relay), so the link can't move into Phantom. Approve there instead, then come back here: this page finishes the link by itself.";
const RAN_OUT = "That approval ran out (it lasts 10 minutes). Tap Phantom again for a new check number.";

/**
 * Safari on the phone, a member without a wallet, behind a relay. world.pair: "waiting" | "ready" | "expired". race: another tab of
 * this browser finishes the same pairing first, so /api/pair/finish answers 410 here; "linked" = that tab linked the wallet,
 * true = nobody did (the pairing simply ran out).
 */
async function safari({ pair = "waiting", ua = UA.iphone, me, pairStart, race = false, ...opts } = {}) {
  const world = { pair, finished: [], raced: race, linked: null };
  const api = async (path, body) => {
    if (path === "/api/me/wallet/carry") return { ok: false, error: "carry_relay", _status: 409 };
    if (path === "/api/pair") return pairStart ? pairStart() : { ok: true, code: PAIR, pin: "42", purpose: "link", url: `https://vicinity.test/connect?pair=${PAIR}`, expiresAt: inMinutes(10) };
    if (path.startsWith("/api/pair?code=")) return world.pair === "expired" ? { status: "expired" } : { status: world.pair, pin: "42", purpose: "link" };
    if (path === "/api/pair/finish") {
      world.finished.push(body);
      if (world.raced) {
        if (world.raced === "linked") world.linked = ADDR;
        world.pair = "expired";
        return { ok: false, status: "expired", _status: 410 };
      }
      if (world.pair !== "ready") return { ok: false, status: "waiting" };
      world.pair = "expired"; world.linked = ADDR;
      return { ok: true, status: "done", linked: true, wallet: ADDR, next: "/dashboard?linked=1" };
    }
    return { ok: true };
  };
  const whoAmI = me || (() => ({ ...LINK_ME, user: { ...LINK_ME.user, wallet: world.linked } }));
  const p = await openConnect({ ua, api, me: whoAmI, ...opts });
  return { p, world };
}
const phantomTile = (p) => p.$("#wallets-known").children.find((t) => /Phantom/.test(t.textContent));
const kept = (p) => { const v = p.session.get(KEY); return v ? JSON.parse(v) : null; };
const keptPairing = (over = {}) => ({ [KEY]: JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "link", name: "Phantom", relay: true, ...over }) });
const statusAsks = (p) => p.calls.filter((c) => c.path.startsWith("/api/pair?code="));
/** The pairing screen of a first tab, kept in its sessionStorage (what a reload or a duplicated tab starts from). */
async function pairingTab() {
  const a = await safari();
  await a.p.tap(phantomTile(a.p));
  await a.p.flush();
  assert.equal(a.p.screen(), "phone");
  assert.ok(kept(a.p), "the first tab keeps the pairing");
  return a.p.session;
}

/* ---------------- F1: one failed request while the reloaded tab starts does not throw the approval away ---------------- */

test("F1 GET /api/me fails once as the reloaded tab starts: the pairing stays kept, the page says to reload, and the next load finishes with it", async () => {
  const session = await pairingTab();
  const b = await safari({ pair: "ready", session, net: (path) => (path.startsWith("/api/me") ? "offline" : undefined) });
  await b.p.flush();
  assert.ok(kept(b.p), "still kept: no answer is not 'used' or 'ran out'");
  assert.deepEqual(b.world.finished, [], "nothing finished on a page that doesn't know who it is");
  assert.equal(b.p.$("#c-error").textContent, "Couldn't reach Vicinity to finish. Check your connection, then reload this page.");
  assert.equal(b.p.visible(b.p.$("#c-error")), true);
  const c = await safari({ pair: "ready", session: b.p.session }); // reloaded, the network is fine now
  await c.p.flush();
  assert.deepEqual(c.world.finished, [{ code: PAIR }], "the approval already given is used");
  assert.equal(c.p.screen(), "done");
  await c.p.advance(1300);
  assert.deepEqual(c.p.assigned, ["/dashboard?linked=1"]);
  assert.equal(kept(c.p), null);
});

test("F1 /signup.js fails to load as the reloaded tab starts: the pairing stays kept for the reload", async () => {
  const session = await pairingTab();
  const b = await safari({ pair: "ready", session, noSignupJs: true });
  await b.p.flush();
  assert.equal(b.p.$("#su-loading-text").textContent, "The sign-up didn't load.");
  assert.ok(kept(b.p), "still kept");
  const c = await safari({ pair: "ready", session: b.p.session });
  await c.p.flush();
  assert.deepEqual(c.world.finished, [{ code: PAIR }]);
});

test("F1 a definite answer still forgets it: the page loaded and the person is no longer a member without a wallet", async () => {
  const b = await safari({ pair: "ready", session: keptPairing(), me: { signedIn: false }, state: STATE.empty() });
  await b.p.flush();
  assert.equal(b.p.screen(), "su-location");
  assert.equal(kept(b.p), null);
  assert.equal(b.world.finished.length, 0);
});

/* ---------------- F2: the approve page, before /api/me answers ---------------- */

async function approvePage({ me = {}, net } = {}) {
  const w = fakeWallet("Phantom");
  const api = async (path) => {
    if (path.startsWith("/api/pair?code=")) return { status: "waiting", pin: "42", purpose: "link", name: "Sa•••", handle: "Sw•••", terms: "2026-10-01" };
    if (path.startsWith("/api/message?")) return { message: MESSAGE };
    if (path === "/api/auth/wallet") return { ok: true, paired: true };
    return { ok: true };
  };
  const p = await openConnect({ ua: UA.phantomApp, search: `pair=${PAIR}`, me, api, wallets: [w.wallet], net });
  await p.flush();
  return p;
}
const pickTiles = (p) => p.$("#wallets-detected").children.filter((t) => p.visible(t));

test("F2 the wallet app's approve page: the approve card (with its check number) at once while /api/me is slow, never today's pick screen or hero", async () => {
  let answer; const slow = new Promise((r) => { answer = r; });
  const p = await approvePage({ net: (path) => (path.startsWith("/api/me") ? slow : undefined) });
  assert.equal(p.screen(), "approve", "the approve card, before /api/me answers");
  assert.equal(p.$("#approve-pin").textContent, "42");
  assert.equal(p.visible(p.$(".connect__intro")), false, "no old hero and no old 1-2-3 bar");
  assert.equal(p.visible(p.$("#stepper")), false);
  assert.equal(pickTiles(p).length, 0, "no wallet tile that would start an ordinary sign-in");
  assert.equal(p.$("#approve-wallets").children.length, 1, "the approve card's own tile");
  assert.equal(p.$("#approve-tap").textContent, "Tap Phantom below and sign. Nothing is paid or moved.", "the line is there from the start (the tile does not move when /api/me answers)");
  assert.equal(p.visible(p.$("#approve-tap")), true);
  assert.equal(p.$("#approve-h").textContent, "Link this wallet to Sa•••'s Vicinity account?");
  answer(); await p.flush();
  assert.equal(p.screen(), "approve");
  assert.equal(p.visible(p.$("#approve-tap")), true);
  assert.equal(p.visible(p.$(".connect__intro")), false);
});

test("F2 sign-up v2 off: today's hero comes back once /api/me says so; /api/me failing leaves the card alone", async () => {
  let answer; const slow = new Promise((r) => { answer = r; });
  const off = await approvePage({ me: { signupFlow: undefined }, net: (path) => (path.startsWith("/api/me") ? slow : undefined) });
  assert.equal(off.screen(), "approve");
  assert.equal(off.visible(off.$(".connect__intro")), false, "the live (v2) look until /api/me says otherwise");
  answer(); await off.flush();
  assert.equal(off.visible(off.$(".connect__intro")), true, "today's approve page, as before");
  assert.equal(off.visible(off.$("#approve-tap")), false);
  const failed = await approvePage({ net: (path) => (path.startsWith("/api/me") ? "offline" : undefined) });
  assert.equal(failed.screen(), "approve");
  assert.equal(failed.visible(failed.$(".connect__intro")), false);
  assert.equal(failed.$("#approve-pin").textContent, "42");
});

/* ---------------- F3: a kept pairing that ran out ---------------- */

test("F3 approved, then the code ran out on the server before the person came back: the link screen says so in one calm line, naming the wallet", async () => {
  const session = await pairingTab();
  const b = await safari({ pair: "expired", session });
  await b.p.flush();
  assert.equal(b.p.screen(), "phone", "the kept pairing shows at once (no plain link screen while the server is asked)");
  await b.p.advance(1600); // (gone: was it used by another tab of this browser? looked at twice, 1.5 s apart)
  assert.equal(b.p.screen(), "pick");
  assert.equal(b.p.$("#su-note").textContent, RAN_OUT);
  assert.equal(b.p.visible(b.p.$("#su-note")), true);
  assert.equal(b.p.visible(b.p.$("#c-error")), false, "a note, not an error");
  assert.equal(kept(b.p), null);
  assert.equal(b.world.finished.length, 0);
});

test("F3 the kept pairing's own time has passed: the same line, without asking the server", async () => {
  const b = await safari({ session: keptPairing({ until: Date.now() - 1000 }) });
  await b.p.flush();
  assert.equal(statusAsks(b.p).length, 0);
  assert.equal(b.p.screen(), "pick");
  assert.equal(b.p.$("#su-note").textContent, RAN_OUT);
  assert.equal(kept(b.p), null);
});

test("F3 a Log in pairing (no wallet named) that ran out: the Log in tab says to tap “Wallet on my phone” again", async () => {
  const b = await safari({ pair: "expired", me: { signedIn: false }, state: STATE.empty(), session: keptPairing({ for: "login", name: null, relay: false }) });
  await b.p.flush();
  await b.p.advance(1600);
  assert.equal(b.p.$("#tab-login").getAttribute("aria-pressed"), "true");
  assert.equal(b.p.screen(), "pick");
  assert.equal(b.p.$("#su-note").textContent, "That approval ran out (it lasts 10 minutes). Tap “Wallet on my phone” again for a new check number.");
});

test("F3 without a reload, a code that runs out on the pairing screen still says so there", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  await p.flush();
  world.pair = "expired";
  await p.advance(2000 + 1600);
  assert.equal(p.screen(), "phone");
  assert.equal(p.$("#pair-status").textContent, "The code expired. Go back and try again.");
  assert.equal(kept(p), null);
});

/* ---------------- F4: a duplicated tab loses the race for the same pairing ---------------- */

test("F4 duplicated tab: the other tab finished it (410 here) and the wallet is linked: this tab says so and goes to the dashboard, never 'The code expired'", async () => {
  const session = await pairingTab();
  const b = await safari({ pair: "ready", session, race: "linked" }); // the other tab was faster and linked the wallet
  await b.p.flush();
  assert.equal(b.world.finished.length, 1, "this tab tried once");
  assert.doesNotMatch(b.p.$("#pair-status").textContent, /expired/);
  assert.equal(b.p.screen(), "done");
  assert.equal(b.p.$("#done-h").textContent, "Wallet linked.");
  await b.p.advance(1300);
  assert.deepEqual(b.p.assigned, ["/dashboard?linked=1"]);
  assert.equal(kept(b.p), null);
});

test("F4 the other tab's answer is still on its way at the first look: the second look (1.5 s later) finds the wallet linked", async () => {
  const session = await pairingTab();
  const b = await safari({ pair: "ready", session, race: true });
  await b.p.flush();
  assert.equal(b.world.finished.length, 1);
  b.world.linked = ADDR; // the other tab's link lands a moment later
  await b.p.advance(1600);
  assert.equal(b.p.screen(), "done");
  assert.doesNotMatch(b.p.$("#pair-status").textContent, /expired/);
  await b.p.advance(1300);
  assert.deepEqual(b.p.assigned, ["/dashboard?linked=1"]);
});

test("F4 the code is gone and nobody used it here or elsewhere: 'The code expired' as before", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  await p.flush();
  world.pair = "ready"; world.raced = true; // finish refused, nobody is in, the account still has no wallet
  await p.advance(2000);
  assert.match(p.$("#pair-status").textContent, /Waiting/, "not yet: the other tab's answer may still be on its way");
  await p.advance(1600);
  assert.equal(p.$("#pair-status").textContent, "The code expired. Go back and try again.");
  assert.equal(p.screen(), "phone");
});

test("F4 today's page (sign-up v2 off): the other tab made the wallet pending: this one goes on to step 2 as well", async () => {
  const mine = { [KEY]: JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "connect", name: null, relay: false }) };
  let pending = null;
  const api = async (path) => {
    if (path.startsWith("/api/pair?code=")) return { status: "ready", pin: "42" };
    if (path === "/api/pair/finish") { pending = { wallet: ADDR }; return { ok: false, status: "expired", _status: 410 }; }
    return { ok: true };
  };
  const p = await openConnect({ ua: UA.iphone, api, me: () => ({ signupFlow: undefined, pending }), session: mine });
  await p.flush();
  assert.equal(p.screen(), "social");
  assert.doesNotMatch(p.$("#pair-status").textContent, /expired/);
});

/* ---------------- F5: a tablet behind a relay ---------------- */

test("F5 iPad behind a relay: the QR code for a phone, and the reason says to scan it (not 'approve in Phantom below')", async () => {
  const qr = ({ doc, win }) => { // the QR code is drawn on a canvas (Chromium draws it in the end-to-end runs)
    doc.querySelector("#qr").getContext = () => ({ fillRect() {} });
    win.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => false });
  };
  const { p } = await safari({ ua: UA.ipad, touchPoints: 5, setup: qr });
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.equal(p.$("#pair-h").textContent, "Scan with your phone");
  assert.equal(p.visible(p.$("#pair-apps")), false);
  const why = p.$("#pair-why").textContent;
  assert.equal(why, "This browser hides its connection (a VPN or a private relay), so the link can't move into Phantom here. Instead, scan the code below with your phone and approve there, then come back here: this page finishes the link by itself.");
  assert.doesNotMatch(why, /approve in Phantom below/);
  const { p: phone } = await safari();
  await phone.tap(phantomTile(phone));
  await phone.flush();
  assert.equal(phone.$("#pair-why").textContent, RELAY_WHY, "a phone keeps its own words");
});

/* ---------------- nits ---------------- */

test("nit: 'Couldn't start' keeps the wallet and the reason for the retry ('Wallet on my phone' then still says Approve in Phantom)", async () => {
  let n = 0;
  const { p } = await safari({ pairStart: () => (n++ === 0 ? { ok: false, error: "offline", _status: 0 } : { ok: true, code: PAIR, pin: "42", purpose: "link", url: `https://vicinity.test/connect?pair=${PAIR}`, expiresAt: inMinutes(10) }) });
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.$("#c-error").textContent, "Couldn't start. Please try again.");
  await p.tap(p.$("#alt-phone"));
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.equal(p.$("#pair-h").textContent, "Approve in Phantom, then finish here");
  assert.equal(p.$("#pair-why").textContent, RELAY_WHY);
  assert.equal(kept(p).name, "Phantom");
  assert.equal(kept(p).relay, true);
  // used up once started: Back, then a plain "Wallet on my phone"
  await p.tap(p.$('.cstate[data-state="phone"] [data-back]'));
  await p.tap(p.$("#alt-phone"));
  assert.equal(p.$("#pair-h").textContent, "Approve in your wallet app, then finish here");
});

test("nit: a resumed pairing shows its screen at once, not the plain link screen while GET /api/pair is on its way", async () => {
  let answer; const slow = new Promise((r) => { answer = r; });
  const b = await safari({ pair: "ready", session: keptPairing(), net: (path) => (path.startsWith("/api/pair?code=") ? slow : undefined) });
  await b.p.flush();
  assert.equal(b.p.screen(), "phone");
  assert.equal(b.p.$("#pair-pin").textContent, "42");
  assert.equal(b.p.$("#pair-h").textContent, "Approve in Phantom, then finish here");
  answer(); await b.p.flush();
  assert.deepEqual(b.world.finished, [{ code: PAIR }]);
});

test("nit: storage blocked: nothing is kept, so a reload is not kept from restoring its scroll position", async () => {
  const { p } = await safari({ session: "throws" });
  p.win.history.scrollRestoration = "auto";
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.equal(p.win.history.scrollRestoration, "auto");
});

test("nit: 'Wallet on my phone' on a phone says what it does there (no code to scan); a computer and a tablet keep the QR words", async () => {
  const { p } = await safari();
  assert.equal(p.$("#alt-phone em").textContent, "Approve in your wallet app, then finish here.");
  for (const opts of [{ ua: UA.desktop }, { ua: UA.ipad, touchPoints: 5 }]) {
    const { p: q } = await safari(opts);
    assert.equal(q.$("#alt-phone em").textContent, "Scan a code with your phone, sign there, finish here.", opts.ua);
  }
});

test("nit: the approve page's dead-code messages send the person back to where they started (a computer, or Safari on this same phone)", async () => {
  const api = async (path) => (path.startsWith("/api/pair?code=") ? { status: "expired" } : { ok: true });
  const p = await openConnect({ ua: UA.phantomApp, search: `pair=${PAIR}`, api, wallets: [fakeWallet("Phantom").wallet] });
  await p.flush();
  assert.equal(p.$("#c-error").textContent, "This code has expired. Go back to where you started and try again.");
  assert.doesNotMatch(p.$("#c-error").textContent, /computer/);
});
