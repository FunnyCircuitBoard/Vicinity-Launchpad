// The pairing on a phone ("approve in the wallet app, finish here"), in onboarding v3 the way a member links a wallet when "Open app"
// can't carry the link (Safari behind iCloud Private Relay, or "Didn't work?"), and the way the Log in tab signs a device in:
//  (1) the pending pairing is kept in this tab's sessionStorage: when iOS throws Safari's tab away while the person is in Phantom,
//      the reloaded page picks it up again and finishes with the approval already given (no second approval). Forgotten once used,
//      run out, or left. Never in localStorage or the address bar.
//  (3) plain words: "Approve in Phantom, then finish here"; the relay reason; the "Didn't work?" button and the message that quotes it.
//  (4) the wallet app's approve page: a LINK pairing names the account the wallet joins (no Terms gate: they are on that account), a
//      login pairing keeps today's words; no old hero / 1-2-3 bar, the card and the wallet tile at the top, "Tap Phantom below".
//  (5) the pairing screen is brought into view under the sticky header (the person tapped far down the page).
// Runs the real connect page (test/helpers/connectpage.js); the server side is test/wallet-link.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, LINK_ME, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

const PAIR = "Pp41r_Pp41r_Pp41r_Pp41r_"; // 24 characters, like the server's
const KEY = "vicinity-pair";
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
// (on=phone: the pairing was started on this phone, so the wallet app's approve page says "go back to Safari or Chrome", not "your computer")
const appLink = (code) => `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/connect?pair=${code}&on=phone`)}?ref=${encodeURIComponent("https://vicinity.test")}`;
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const RELAY_WHY = "Your iPhone hides its connection (iCloud Private Relay), so the link can't move into Phantom. Approve there instead, then come back here: this page finishes the link by itself.";

/**
 * Safari on the phone, a member without a wallet (the link mode). The server: "Open app" answers carry_relay (or makes a code),
 * POST /api/pair makes PAIR (a link pairing), GET /api/pair?code= answers world.pair ("waiting" | "ready" | "expired"),
 * /api/pair/finish takes a ready pairing once and links the wallet. `me` follows: once linked, /api/me says so.
 */
async function safari({ relay = true, pair = "waiting", ua = UA.iphone, finishAnswer, me, ...opts } = {}) {
  const world = { pair, finished: [], linked: null, pairs: [] };
  const api = async (path, body) => {
    if (path === "/api/me/wallet/carry") return relay ? { ok: false, error: "carry_relay", _status: 409 } : { ok: true, code: "Cc0de_Cc0de_Cc0de_Cc0de_Cc0de_Cc", pin: "47", ref: "r1", url: "https://vicinity.test/connect?link=Cc0de_Cc0de_Cc0de_Cc0de_Cc0de_Cc", expiresAt: inMinutes(10) };
    if (path === "/api/pair") { world.pairs.push(body); return { ok: true, code: PAIR, pin: "42", purpose: (body && body.purpose) || "login", url: `https://vicinity.test/connect?pair=${PAIR}`, expiresAt: inMinutes(10) }; }
    if (path.startsWith("/api/pair?code=")) return world.pair === "gone" || world.pair === "expired" ? { status: "expired" } : { status: world.pair, pin: "42", purpose: "link" };
    if (path === "/api/pair/finish") {
      world.finished.push(body);
      if (world.pair !== "ready") return { ok: false, status: world.pair === "waiting" ? "waiting" : "expired", _status: world.pair === "waiting" ? 200 : 410 };
      world.pair = "gone"; world.linked = ADDR;
      return finishAnswer || { ok: true, status: "done", linked: true, wallet: ADDR, next: "/dashboard?linked=1" };
    }
    return { ok: true };
  };
  const whoAmI = me || (() => ({ ...LINK_ME, user: { ...LINK_ME.user, wallet: world.linked } }));
  const p = await openConnect({ ua, api, me: whoAmI, ...opts });
  return { p, world };
}
const phantomTile = (p) => p.$("#wallets-known").children.find((t) => /Phantom/.test(t.textContent));
const kept = (p) => { const v = p.session.get(KEY); return v ? JSON.parse(v) : null; };
const newPairings = (p) => p.calls.filter((c) => c.path === "/api/pair" && c.method === "POST");
const statusAsks = (p) => p.calls.filter((c) => c.path.startsWith("/api/pair?code="));

/* ---------------- (1) the pairing survives a reload of Safari's tab ---------------- */

test("(1) the pairing is kept in this tab only (sessionStorage): what it is for (the link), never in localStorage or the address bar", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.deepEqual(world.pairs, [{ purpose: "link" }], "a link pairing: the account of this page takes the wallet the phone approves");
  const k = kept(p);
  assert.ok(k, "kept while it waits");
  assert.equal(k.code, PAIR);
  assert.equal(k.pin, "42");
  assert.equal(k.for, "link", "for the link of this account");
  assert.equal(k.name, "Phantom");
  assert.equal(k.relay, true);
  assert.ok(Math.abs(k.until - (Date.now() + 10 * 60_000)) < 5_000, "it runs out when the code does");
  assert.equal([...p.local.values()].some((v) => String(v).includes(PAIR)), false, "never in localStorage");
  assert.equal(p.addressBar.some((u) => u.includes(PAIR)), false, "never in the address bar");
  assert.equal(p.session.get("vl-started"), "1", "the dashboard knows a link was started in this tab");
});

test("(1) iOS threw the tab away after Phantom approved: the reloaded page finishes with that approval (no second one) and lands on the dashboard, linked", async () => {
  const a = await safari();
  await a.p.tap(phantomTile(a.p));
  await a.p.flush();
  // ... the person approves in Phantom; meanwhile iOS discards Safari's tab, which reloads when the person comes back
  const b = await safari({ pair: "ready", session: a.p.session });
  await b.p.flush();
  assert.equal(newPairings(b.p).length, 0, "no new pairing: the kept one is used");
  assert.deepEqual(b.world.finished, [{ code: PAIR }], "the approved pairing is finished once");
  assert.equal(b.p.screen(), "done");
  assert.equal(b.p.$("#done-h").textContent, "Wallet linked.");
  await b.p.advance(1300);
  assert.deepEqual(b.p.assigned, ["/dashboard?linked=1"]);
  assert.equal(kept(b.p), null, "forgotten once used");
});

test("(1) reloaded BEFORE approving: the same pairing screen comes back (same code, same check number, same reason), then finishes when approved", async () => {
  const a = await safari();
  await a.p.tap(phantomTile(a.p));
  await a.p.flush();
  const b = await safari({ pair: "waiting", session: a.p.session });
  await b.p.flush();
  assert.equal(b.p.screen(), "phone");
  assert.equal(newPairings(b.p).length, 0);
  assert.equal(b.p.$("#pair-pin").textContent, "42");
  assert.equal(b.p.$("#pair-h").textContent, "Approve in Phantom, then finish here");
  assert.equal(b.p.$("#pair-why").textContent, RELAY_WHY);
  assert.equal(b.p.visible(b.p.$("#pair-why")), true);
  assert.equal(b.p.$("#pair-apps").children[0].href, appLink(PAIR));
  assert.equal(b.p.visible(b.p.$("#su-steps")), false, "the link mode has no steps");
  // the approval comes now; back on screen, the page asks at once and finishes
  b.world.pair = "ready";
  await b.p.setHidden(true); await b.p.setHidden(false);
  assert.deepEqual(b.world.finished, [{ code: PAIR }]);
  await b.p.advance(1300);
  assert.deepEqual(b.p.assigned, ["/dashboard?linked=1"]);
});

test("(1) a kept pairing that was used or ran out on the server is forgotten: the plain link screen, nothing finished", async () => {
  const a = await safari();
  await a.p.tap(phantomTile(a.p));
  await a.p.flush();
  const b = await safari({ pair: "expired", session: a.p.session });
  await b.p.flush();
  await b.p.advance(1600); // (was it used by another tab of this browser? looked at twice, 1.5 s apart)
  assert.equal(b.p.screen(), "pick");
  assert.equal(b.p.visible(b.p.$("#link-top")), true);
  assert.equal(b.world.finished.length, 0);
  assert.equal(kept(b.p), null);
});

test("(1) no answer at all on the reload (offline): the pairing screen shows and is not forgotten; the next answer finishes it", async () => {
  const a = await safari();
  await a.p.tap(phantomTile(a.p));
  await a.p.flush();
  let offline = true;
  const world = { pair: "ready", finished: [] };
  const api = async (path, body) => {
    if (path.startsWith("/api/pair?code=")) return offline ? { ok: false, error: "offline", _status: 503 } : { status: world.pair, pin: "42", purpose: "link" };
    if (path === "/api/pair/finish") { world.finished.push(body); return { ok: true, status: "done", linked: true, wallet: ADDR, next: "/dashboard?linked=1" }; }
    return { ok: true };
  };
  const p = await openConnect({ ua: UA.iphone, api, me: LINK_ME, session: a.p.session });
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.ok(kept(p), "kept");
  assert.equal(world.finished.length, 0);
  offline = false;
  await p.advance(2000);
  assert.deepEqual(world.finished, [{ code: PAIR }]);
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard?linked=1"]);
});

test("(1) a kept pairing past its time is forgotten without asking the server", async () => {
  const old = JSON.stringify({ code: PAIR, pin: "42", until: Date.now() - 1000, for: "link", name: "Phantom", relay: true });
  const { p } = await safari({ session: { [KEY]: old } });
  assert.equal(statusAsks(p).length, 0);
  assert.equal(p.screen(), "pick");
  assert.equal(kept(p), null);
});

test("(1) the account got its wallet meanwhile (another browser): the reloaded page goes to the dashboard, the kept pairing is forgotten", async () => {
  const a = await safari();
  await a.p.tap(phantomTile(a.p));
  await a.p.flush();
  const b = await safari({ pair: "ready", session: a.p.session, me: { ...LINK_ME, user: { ...LINK_ME.user, wallet: ADDR } } });
  await b.p.flush();
  assert.equal(b.p.screen(), "done");
  assert.equal(b.world.finished.length, 0, "nothing to finish: the wallet is on the account");
  assert.equal(kept(b.p), null);
});

test("(1) Back on the pairing screen forgets it; a later 'Wallet on my phone' is a plain link pairing (no wallet name, no relay reason)", async () => {
  const { p } = await safari();
  await p.tap(phantomTile(p));
  await p.flush();
  assert.ok(kept(p));
  await p.tap(p.$('.cstate[data-state="phone"] [data-back]'));
  assert.equal(p.screen(), "pick");
  assert.equal(kept(p), null, "cancelled: forgotten");
  await p.tap(p.$("#alt-phone"));
  assert.equal(p.$("#pair-h").textContent, "Approve in your wallet app, then finish here");
  assert.equal(p.visible(p.$("#pair-why")), false);
  assert.equal(kept(p).name, null);
  assert.equal(kept(p).relay, false);
  assert.equal(kept(p).for, "link");
});

test("(1) the code runs out while the page waits: said, and forgotten", async () => {
  const { p, world } = await safari();
  await p.tap(phantomTile(p));
  await p.flush();
  world.pair = "expired";
  await p.advance(2000 + 1600);
  assert.equal(p.$("#pair-status").textContent, "The code expired. Go back and try again.");
  assert.equal(kept(p), null);
});

test("(1) without sessionStorage (blocked) the pairing still works in the open page", async () => {
  const { p, world } = await safari({ session: "throws" });
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.screen(), "phone");
  world.pair = "ready";
  await p.advance(2000);
  assert.deepEqual(world.finished, [{ code: PAIR }]);
  // MOVED (owner decision F4): a phone's Safari that finished a link pairing sends the person on to the wallet app they tapped
  assert.equal(p.$("#done-h").textContent, "Phantom connected ✓");
  assert.equal(p.$("#done-go").textContent, "Open Phantom");
  assert.equal(p.$("#done-go").getAttribute("href"), `https://phantom.com/ul/browse/${encodeURIComponent("https://vicinity.test/connect?mode=login&with=phantom")}?ref=${encodeURIComponent("https://vicinity.test")}`);
  await p.advance(1300);
  assert.deepEqual(p.assigned, [], "nothing moves by itself (Open Phantom, or Stay here)");
});

test("(1) a pairing started on the Log in tab comes back on the Log in tab, and signs that wallet in", async () => {
  const saved = JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "login", name: null, relay: false });
  const { p, world } = await safari({ pair: "waiting", me: { signedIn: false }, state: STATE.empty(), session: { [KEY]: saved }, finishAnswer: { ok: true, status: "done", wallet: ADDR, next: "/dashboard" } });
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
  assert.equal(p.$("#pair-h").textContent, "Approve in your wallet app, then finish here");
  world.pair = "ready";
  await p.setHidden(true); await p.setHidden(false);
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard"]);
  assert.equal(kept(p), null);
});

test("(1) a Log in pairing for a wallet nobody owns: the no-account screen, never step 1 by surprise", async () => {
  const saved = JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "login", name: null, relay: false });
  const { p } = await safari({ pair: "ready", me: { signedIn: false }, state: STATE.empty(), session: { [KEY]: saved }, finishAnswer: { ok: false, error: "no_account", _status: 404 } });
  await p.flush();
  assert.equal(p.screen(), "no-account");
  assert.equal(p.$("#na-h").textContent, "No account for this wallet yet");
  assert.equal(kept(p), null);
});

test("(1) a pairing of the old sign-up's wallet step is forgotten (there is no such step any more); today's page (v2 off) resumes its own only", async () => {
  const oldStep = JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "signup", name: "Phantom", relay: true });
  const { p } = await safari({ me: { signedIn: false }, state: STATE.empty(), session: { [KEY]: oldStep } });
  await p.flush();
  assert.equal(p.screen(), "su-location");
  assert.equal(kept(p), null);
  const mine = JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "connect", name: null, relay: false });
  const q = await safari({ me: { signupFlow: undefined }, session: { [KEY]: mine } });
  await q.p.flush();
  assert.equal(q.p.screen(), "phone");
  const v2s = await safari({ me: { signupFlow: undefined }, session: { [KEY]: JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "link", name: "Phantom", relay: true }) } });
  await v2s.p.flush();
  assert.equal(v2s.p.screen(), "pick");
  assert.equal(kept(v2s.p), null);
});

/* ---------------- (3) plain words ---------------- */

test("(3) the pairing screen says approve (not 'sign in'), naming the wallet when known, and the reason speaks of the link", async () => {
  const { p } = await safari();
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.$("#pair-h").textContent, "Approve in Phantom, then finish here");
  assert.equal(p.$("#pair-why").textContent, RELAY_WHY);
  assert.doesNotMatch(p.$('.cstate[data-state="phone"]').textContent, /Sign in your wallet|other way round|sign-up/);
});

test("(3) an Android phone behind a relay (a VPN) is not told about its 'iPhone'", async () => {
  const { p } = await safari({ ua: ANDROID });
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.equal(p.$("#pair-h").textContent, "Approve in Phantom, then finish here");
  assert.equal(p.$("#pair-why").textContent, "This browser hides its connection (a VPN or a private relay), so the link can't move into Phantom. Approve there instead, then come back here: this page finishes the link by itself.");
});

test("(3) the carry_network message quotes the button exactly as Safari shows it", async () => {
  const { p } = await safari({ relay: false });
  await p.tap(phantomTile(p));
  const label = p.$("#carry-pair").textContent;
  assert.equal(label, "Didn't work? Approve in Phantom and finish here instead");
  const said = p.win.VSignup.pure.ERR.carry_network;
  const quoted = said.match(/tap “([^”]+)”/)[1];
  assert.ok(label.startsWith(quoted), `“${quoted}” is on the button “${label}”`);
  assert.doesNotMatch(said, /Sign in|sign-up/);
});

test("(3) the link screen's lead on a phone says what the wallet app does, in one sentence each", async () => {
  const { p } = await safari();
  assert.equal(p.$("#su-wallet-lead").textContent, "Tap your wallet app. It opens Vicinity there: check the number, then sign once. You stay in the app, logged in.");
});

/* ---------------- (4) the wallet app's approve page ---------------- */

async function approvePage({ wallets, me = {}, sign, purpose = "link", on = null } = {}) {
  const ws = (wallets || ["Phantom"]).map((n) => fakeWallet(n));
  if (sign) ws[0].ctl.sign = sign;
  const asked = [];
  const api = async (path, body) => {
    if (path.startsWith("/api/pair?code=")) return purpose === "link" ? { status: "waiting", pin: "42", purpose: "link", name: "Sa•••", handle: "Sw•••", community: { name: "Utica", country: "US" }, terms: "2026-10-01" } : { status: "waiting", pin: "42", purpose: "login" };
    if (path.startsWith("/api/message?")) { asked.push(path); return { message: MESSAGE }; }
    if (path === "/api/auth/wallet") { asked.push(body); return { ok: true, paired: true }; }
    return { ok: true };
  };
  const p = await openConnect({ ua: UA.phantomApp, search: `pair=${PAIR}${on ? `&on=${on}` : ""}`, me, api, agreed: null, wallets: ws.map((w) => w.wallet) });
  await p.flush();
  return { p, asked };
}
const indexIn = (p, sel) => { const card = p.$('.cstate[data-state="approve"]'); return card.children.indexOf(p.$(sel)); };

test("(4) a LINK pairing: the approve page names the account the wallet joins, asks about the check number, no Terms gate (they are on that account), 'Tap Phantom below and sign'", async () => {
  const { p, asked } = await approvePage();
  assert.equal(p.screen(), "approve");
  assert.equal(p.visible(p.$(".connect__intro")), false, "the old hero is gone");
  assert.equal(p.visible(p.$("#stepper")), false, "and its old 3 steps");
  assert.equal(p.$("#approve-h").textContent, "Link this wallet to Sa•••'s Vicinity account?");
  assert.equal(p.$("#approve-owner").textContent, "@Sw•••");
  assert.equal(p.$("#approve-city").textContent, "📍 Utica, US");
  // (a computer's or tablet's QR code: the link has no on=phone. Review finding ux-UX-5: the phone wording was shown here too)
  assert.equal(p.$("#approve-ask").textContent, "Does your computer (or tablet), where you started, show check number 42?");
  assert.equal(p.$("#approve-warn").textContent, "Only continue if you started this yourself. Never sign for a code someone sent you.");
  assert.equal(p.visible(p.$("#approve-terms")), true);
  assert.equal(p.$("#termsgate").hidden, true, "no gate: the Terms were accepted on that account");
  assert.equal(p.local.get("vicinity_terms"), "2026-10-01");
  assert.equal(p.$("#approve-tap").textContent, "Tap Phantom below and sign. Nothing is paid or moved.");
  assert.ok(indexIn(p, "#approve-tap") === indexIn(p, "#approve-wallets") - 1, "the line sits right above the wallet tile");
  await p.tap(p.$("#approve-wallets").children[0]);
  await p.flush();
  assert.equal(asked[0], `/api/message?address=${ADDR}&action=link&pin=42&pair=${PAIR}`, "the LINK statement with the check number, for the owner of this pairing");
  assert.equal(asked[1].pair, PAIR);
  assert.equal(p.visible(p.$("#approve-done")), true);
  assert.equal(p.$("#approve-done-text").textContent, "Approved. Go back to your computer (or tablet): it finishes the link by itself.");
  assert.equal(p.visible(p.$("#approve-tap")), false);
  assert.equal(p.calls.filter((c) => c.path.startsWith("/api/signup/") || c.path.startsWith("/api/auth/google")).length, 0, "no sign-up, no Google: nothing can loop back to a sign-in screen here");
});

test("(4) a LINK pairing started on this phone (Safari's app tiles say on=phone): back to Safari or Chrome, then Open Phantom there to come back and sign in", async () => {
  const { p } = await approvePage({ on: "phone" });
  assert.equal(p.$("#approve-ask").textContent, "Does Safari or Chrome, where you started, show check number 42?");
  await p.tap(p.$("#approve-wallets").children[0]);
  await p.flush();
  assert.equal(p.$("#approve-done-text").textContent, "Approved. Go back to Safari or Chrome. It finishes the link, then tap “Open Phantom” there to come back and sign in here.");
});

test("(4) a LOGIN pairing keeps today's words and the Terms gate (a first visit like any other); its statement is the login one", async () => {
  const { p, asked } = await approvePage({ purpose: "login" });
  assert.equal(p.$("#approve-h").textContent, "Approve the sign-in you started");
  assert.equal(p.visible(p.$("#approve-who")), false);
  assert.equal(p.visible(p.$("#approve-terms")), false);
  assert.equal(p.$("#termsgate").hidden, false, "a first visit here: the gate");
  assert.match(p.$('.cstate[data-state="approve"]').textContent, /Never sign for a code someone sent you\./);
  await p.tap(p.$("#approve-wallets").children[0]);
  await p.flush();
  assert.equal(asked[0], `/api/message?address=${ADDR}&action=login&pin=42`);
  assert.match(p.$("#approve-done-text").textContent, /Go back to where you started \(your computer, or Safari or Chrome on this phone\)\./);
});

test("(4) several wallets: 'Tap your wallet below'; none: no line (the app links say what to do)", async () => {
  const { p: two } = await approvePage({ wallets: ["Phantom", "Solflare"] });
  assert.equal(two.$("#approve-tap").textContent, "Tap your wallet below and sign. Nothing is paid or moved.");
  const { p: none } = await approvePage({ wallets: [] });
  assert.equal(none.visible(none.$("#approve-tap")), false);
  assert.equal(none.visible(none.$("#approve-open")), true);
});

test("(4) with sign-up v2 off the approve page is today's (hero and steps kept, no new line)", async () => {
  const { p } = await approvePage({ me: { signupFlow: undefined }, purpose: "login" });
  assert.equal(p.screen(), "approve");
  assert.equal(p.visible(p.$(".connect__intro")), true);
  assert.equal(p.visible(p.$("#approve-tap")), false);
});

/* ---------------- (5) the pairing screen under the sticky header ---------------- */

test("(5) the person tapped Phantom far down the page: the pairing screen's top is scrolled to just under the sticky header", async () => {
  const { p } = await safari();
  const scrolls = [];
  p.$(".site-header").getBoundingClientRect = () => ({ top: 0, bottom: 67, left: 0, right: 390, width: 390, height: 67 });
  p.$("#connect-panel").getBoundingClientRect = () => ({ top: -480, bottom: 900, left: 16, right: 374, width: 358, height: 1380 });
  p.win.scrollY = 1200;
  p.win.scrollTo = (o) => scrolls.push({ ...o }); // (a plain object of this realm: the page runs in its own)
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.deepEqual(scrolls, [{ top: 1200 - 480 - 67 - 12, behavior: "auto" }], "the panel's top lands 12 px under the header");
});

test("(5) a reloaded tab that shows the pairing again brings it under the header (it starts at the top, above the old hero)", async () => {
  const saved = JSON.stringify({ code: PAIR, pin: "42", until: Date.now() + 9 * 60_000, for: "link", name: "Phantom", relay: true });
  const scrolls = [];
  const setup = ({ doc, win }) => {
    doc.querySelector(".site-header").getBoundingClientRect = () => ({ top: 0, bottom: 67, left: 0, right: 390, width: 390, height: 67 });
    doc.querySelector("#connect-panel").getBoundingClientRect = () => ({ top: 465, bottom: 1800, left: 16, right: 374, width: 358, height: 1335 });
    win.scrollY = 0;
    win.scrollTo = (o) => scrolls.push({ ...o });
  };
  const { p } = await safari({ session: { [KEY]: saved }, setup });
  assert.equal(p.screen(), "phone");
  assert.deepEqual(scrolls, [{ top: 465 - 67 - 12, behavior: "auto" }]);
});

test("(5) while a pairing is kept, a reload does not scroll the page back to where the old one was (scrollRestoration manual); back to normal after", async () => {
  const { p } = await safari();
  p.win.history.scrollRestoration = "auto";
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.win.history.scrollRestoration, "manual");
  await p.tap(p.$('.cstate[data-state="phone"] [data-back]'));
  assert.equal(p.win.history.scrollRestoration, "auto");
});

test("(5) the pairing screen already in view: no scroll", async () => {
  const { p } = await safari();
  const scrolls = [];
  p.$(".site-header").getBoundingClientRect = () => ({ top: 0, bottom: 67, left: 0, right: 390, width: 390, height: 67 });
  p.$("#connect-panel").getBoundingClientRect = () => ({ top: 84, bottom: 900, left: 16, right: 374, width: 358, height: 816 });
  p.win.scrollY = 300;
  p.win.scrollTo = (o) => scrolls.push(o);
  await p.tap(phantomTile(p));
  await p.flush();
  assert.equal(p.screen(), "phone");
  assert.deepEqual(scrolls, []);
});
