// Phones live inside the wallet app (owner decision F4, 10 Oct 2026), the dashboard's side. Runs the real page in node
// (test/helpers/dashpage.js). On a phone's Safari / Chrome a member with a linked wallet sees ONE card: "On this phone you buy in
// Phantom" with "Connect Phantom" (Vicinity opens inside Phantom, logged in or one signature away); inside the wallet app the card says
// who is logged in and how to come back next time (until "Got it"); a browser that was logged in before a wallet joined from a wallet
// app gets "Wasn't you? Remove it" for 7 days; a visitor inside a wallet app gets "Sign in with Phantom"; a proof on a phone's Safari
// opens the wallet app. Instagram's or Facebook's in-app browser is NOT a wallet app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, UA, memberMe, openDashboard } from "./helpers/dashpage.js";
import { fakeWallet } from "./helpers/connectpage.js";

const UAS = {
  ...UA,
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0",
};
const MASKED = `${ADDR.slice(0, 4)}…${ADDR.slice(-4)}`;
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
/** A member whose wallet is linked; `extra` lands on the user (walletApp…) and `top` on the answer (walletNew…). */
const linkedMe = (extra = {}, top = {}) => { const m = memberMe({ wallet: ADDR }); return { ...m, user: { ...m.user, ...extra }, ...top }; };
/** The link that opens Vicinity inside wallet app `id` (/connect?mode=login&with=<id>[&next=]), as public/wallets.js builds it for that app. */
const openInApp = (p, id, next = null) => p.win.VW.KNOWN.find((k) => k.id === id).open(`https://vicinity.test/connect?mode=login&with=${id}${next ? `&next=${encodeURIComponent(next)}` : ""}`);

/* ---------------- a phone's Safari / Chrome: "On this phone you buy in Phantom" ---------------- */

test("a phone's Safari with the wallet linked: ONE card, 'On this phone you buy in Phantom', and Connect Phantom opens Vicinity inside Phantom (signed in there)", async () => {
  const p = await openDashboard({ ua: UA.iphone, me: linkedMe(), storage: { "vicinity.walletApp": "phantom" } });
  assert.equal(p.$("#wallet-card").hidden, false);
  assert.equal(p.text("#wcard-kicker"), "Your wallet app");
  assert.equal(p.text("#wcard-title"), "On this phone you buy in Phantom");
  assert.equal(p.text("#wcard-lead"), "Opens Vicinity inside Phantom, logged in. You buy there.");
  assert.equal(p.text("#wcard-go"), "Connect Phantom");
  const href = p.$("#wcard-go").getAttribute("href");
  assert.equal(href, openInApp(p, "phantom"));
  assert.match(decodeURIComponent(href), /^https:\/\/phantom\.com\/ul\/browse\/https:\/\/vicinity\.test\/connect\?mode=login&with=phantom\?ref=/);
  for (const id of ["#wcard-perks", "#wcard-skip", "#wcard-tiny", "#wcard-note", "#wcard-tip", "#wcard-wait", "#wcard-other", "#wcard-apps"]) assert.equal(p.$(id).hidden, true, id);
  // another wallet app: the chips (one per app that can open this site); a tap remembers it
  assert.equal(p.$("#wcard-another").hidden, false); assert.equal(p.$("#wcard-another").getAttribute("aria-expanded"), "false");
  await p.tap(p.$("#wcard-another"));
  assert.equal(p.$("#wcard-apps").hidden, false); assert.equal(p.$("#wcard-another").getAttribute("aria-expanded"), "true");
  const chips = p.$("#wcard-apps").children;
  // (review finding ux-UX-8: not the app the main button already opens, and the three with real app links first)
  const names = [...chips.map((c) => c.textContent)];
  assert.deepEqual(names.slice(0, 2), ["Solflare", "Backpack"]);
  assert.ok(!names.includes("Phantom"));
  assert.deepEqual([...names].sort(), [...p.win.VW.KNOWN.filter((k) => k.open && k.id !== "phantom").map((k) => k.name)].sort());
  const solflare = chips.find((c) => c.textContent === "Solflare");
  assert.equal(solflare.getAttribute("href"), openInApp(p, "solflare"));
  await p.tap(solflare);
  assert.equal(p.local.get("vicinity.walletApp"), "solflare");
  // the dashboard never sends a Safari person to /connect's link mode once the wallet is there
  assert.ok(!p.$$("#wallet-card a").some((a) => p.visible(a) && /mode=link/.test(a.getAttribute("href") || "")));
});

test("Safari that never remembered an app: the server's (the app that linked the wallet); neither: 'your wallet app' and the chips, no button", async () => {
  const p = await openDashboard({ ua: UA.iphone, me: linkedMe({ walletApp: "solflare" }) });
  assert.equal(p.text("#wcard-title"), "On this phone you buy in Solflare");
  assert.equal(p.text("#wcard-go"), "Connect Solflare"); assert.equal(p.$("#wcard-go").getAttribute("href"), openInApp(p, "solflare"));
  // (integration finding INT-2: the Buy panel's list of wallet apps reads the same key, so it names Solflare first too, before any tap)
  assert.equal(p.local.get("vicinity.walletApp"), "solflare", "kept again as soon as the card says it");
  await p.tap(p.$("#wcard-go"));
  assert.equal(p.local.get("vicinity.walletApp"), "solflare", "the tap remembers it");
  // what Safari remembered itself wins over the account's (another app on this phone)
  const s = await openDashboard({ ua: UA.iphone, me: linkedMe({ walletApp: "solflare" }), storage: { "vicinity.walletApp": "backpack" } });
  assert.equal(s.text("#wcard-title"), "On this phone you buy in Backpack");
  assert.equal(s.local.get("vicinity.walletApp"), "backpack");
  const q = await openDashboard({ ua: UAS.android, me: linkedMe() });
  assert.equal(q.text("#wcard-title"), "On this phone you buy in your wallet app");
  assert.equal(q.text("#wcard-lead"), "Pick the wallet app you use: it opens Vicinity there, logged in. You buy there.");
  assert.equal(q.$("#wcard-go").hidden, true); assert.equal(q.$("#wcard-another").hidden, true);
  assert.equal(q.$("#wcard-apps").hidden, false);
  assert.ok(q.$("#wcard-apps").children.some((c) => c.textContent === "Phantom"));
  // a remembered id that is not a known wallet app is ignored
  const r = await openDashboard({ ua: UA.iphone, me: linkedMe(), storage: { "vicinity.walletApp": "javascript:alert(1)" } });
  assert.equal(r.$("#wcard-go").hidden, true);
});

test("a computer with the wallet linked: no card at all (it was the place to link, not the place to buy); the old sign-up never shows the phone card", async () => {
  const p = await openDashboard({ ua: UA.desktop, me: linkedMe({ walletApp: "phantom" }) });
  assert.equal(p.$("#wallet-card").hidden, true);
  const q = await openDashboard({ ua: UA.iphone, me: { ...linkedMe(), signupFlow: "v1" }, storage: { "vicinity.walletApp": "phantom" } });
  assert.equal(q.$("#wallet-card").hidden, true);
});

/* ---------------- inside the wallet app ---------------- */

test("inside Phantom: 'Phantom connected ✓', who is logged in, and the next-time tip until 'Got it'; the app is remembered for Safari", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openDashboard({ ua: UA.phantomApp, me: linkedMe(), wallets: [wallet] });
  assert.equal(p.win.V.walletApp.here().id, "phantom");
  assert.equal(p.local.get("vicinity.walletApp"), "phantom", "signed in inside Phantom: the app this phone uses");
  assert.equal(p.$("#wallet-card").hidden, false);
  assert.equal(p.text("#wcard-title"), "Phantom connected ✓");
  assert.equal(p.text("#wcard-lead"), "You're logged in as @SwiftHarbor10.");
  assert.equal(p.text("#wcard-tip-text"), "Next time: open Phantom, open its browser and type vicinity.city. You'll still be logged in. Save it there to make it one tap.");
  assert.equal(p.$("#wcard-tip").hidden, false); assert.equal(p.$("#wcard-actions").hidden, true);
  await p.tap(p.$("#wcard-tip-ok"));
  assert.equal(p.$("#wallet-card").hidden, true);
  assert.equal(p.local.get("vicinity:inapp-tip"), "1");
  // the next visit: the tip was put away
  const q = await openDashboard({ ua: UA.phantomApp, me: linkedMe(), wallets: [fakeWallet("Phantom").wallet], storage: { "vicinity:inapp-tip": "1" } });
  assert.equal(q.$("#wallet-card").hidden, true);
});

test("arriving in Phantom right after the link (/dashboard?linked=1): 'Phantom connected ✓' (the app the server names), and the card even after the tip was put away once", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openDashboard({ ua: UA.phantomApp, search: "linked=1", me: linkedMe({ walletApp: "phantom" }), wallets: [wallet], storage: { "vicinity:inapp-tip": "1" } });
  await p.advance(100);
  assert.ok(p.toasts.includes("Phantom connected ✓"), JSON.stringify(p.toasts));
  // a wallet linked on a computer (no app): the short address
  const q = await openDashboard({ ua: UA.desktop, search: "linked=1", me: linkedMe(), wallets: [fakeWallet("Phantom").wallet] });
  await q.advance(100);
  assert.ok(q.toasts.includes("Wallet linked ✓"), JSON.stringify(q.toasts));
});

test("Safari waiting for the link made in Phantom: the poll sees it, 'Phantom connected ✓', and the card turns into 'On this phone you buy in Phantom'", async () => {
  let wallet = null;
  const p = await openDashboard({ ua: UA.iphone, me: () => linkedMe({ wallet, walletApp: wallet ? "phantom" : null }), session: { "vl-started": "1", "su-carry": "Phantom" } });
  assert.equal(p.$("#wcard-wait").hidden, false); assert.equal(p.text("#wcard-wait-text"), "Waiting for Phantom…");
  wallet = ADDR;
  await p.advance(4100);
  // the toast names the wallet itself: the app is only what the other side said (review finding safety-F5)
  assert.ok(p.toasts.includes(`Wallet ${MASKED} connected in Phantom ✓`), JSON.stringify(p.toasts));
  assert.equal(p.local.get("vicinity.walletApp"), "phantom", "the app that really linked it");
  assert.equal(p.text("#wcard-title"), "On this phone you buy in Phantom");
  assert.equal(p.$("#wcard-wait").hidden, true);
});

/* ---------------- "Wasn't you? Remove it" ---------------- */

const NEW = (over = {}) => ({ walletNew: { wallet: MASKED, via: "app", app: "phantom", at: minutesAgo(5), notMe: true, ...over } });

test("a computer logged in before a wallet joined from Phantom: what joined, when, and 'Remove it' (asks first, then logs every other browser out)", async () => {
  let removed = false;
  const answers = [{ ok: true }];
  const p = await openDashboard({
    ua: UA.desktop, me: () => (removed ? memberMe() : linkedMe({ walletApp: "phantom" }, NEW())),
    api: async (path) => { if (path === "/api/me/wallet/disown") { const a = answers.shift(); if (a.ok) removed = true; return a; } },
  });
  assert.equal(p.$("#wallet-card").hidden, false);
  // (review finding safety-F5: never "Phantom connected ✓" while asking "was this you?", and the line names the wallet itself)
  assert.equal(p.text("#wcard-kicker"), "New wallet on your account");
  assert.equal(p.text("#wcard-title"), `Wallet ${MASKED} joined your account`);
  assert.equal(p.text("#wcard-note-text"), `Connected 5m ago in Phantom (wallet ${MASKED}). Wasn't you?`);
  assert.equal(p.$("#wcard-note").hidden, false); assert.equal(p.text("#wcard-remove"), "Remove it");
  await p.tap(p.$("#wcard-remove")); await p.advance(100);
  assert.deepEqual(p.confirms, [`Remove this wallet (${MASKED}) from your account? Phantom will be logged out of Vicinity.`]);
  assert.equal(p.callsTo("/api/me/wallet/disown").length, 1);
  assert.ok(p.toasts.includes("Wallet removed. Other browsers are logged out."), JSON.stringify(p.toasts));
  assert.equal(p.text("#wcard-title"), "Connect your wallet", "the account is back to no wallet");
  // a password set since the link was cleared too: said
  const q = await openDashboard({ ua: UA.desktop, me: linkedMe({}, NEW()), api: async (path) => (path === "/api/me/wallet/disown" ? { ok: true, passwordCleared: true } : undefined) });
  await q.tap(q.$("#wcard-remove")); await q.advance(100);
  assert.ok(q.toasts.includes("Wallet removed. Other browsers are logged out. Set a new password with “Forgot password”."), JSON.stringify(q.toasts));
});

test("'Remove it': said no in the confirm sends nothing; a stale login logs in again first; refusals are plain", async () => {
  const r = await openDashboard({ ua: UA.desktop, me: linkedMe({}, NEW()), confirm: false });
  await r.tap(r.$("#wcard-remove"));
  assert.equal(r.callsTo("/api/me/wallet/disown").length, 0);
  const s = await openDashboard({ ua: UA.desktop, me: linkedMe({}, NEW()), api: async (path) => (path === "/api/me/wallet/disown" ? { ok: false, error: "relogin", _status: 403 } : undefined) });
  await s.tap(s.$("#wcard-remove")); await s.advance(10);
  assert.equal(s.callsTo("/api/auth/logout").length, 1);
  assert.deepEqual(s.assigned, ["/connect?mode=login&error=relogin"]);
  for (const [error, words] of [["too_late", "It's been more than 7 days. Tap Feedback and we'll help."],
    ["not_allowed", "Only a browser you were logged in on before the wallet joined can do this. Tap Feedback and we'll help."],
    ["seat_or_application", "A seat or an application from before depends on this wallet. Tap Feedback and we'll help."]]) {
    const t = await openDashboard({ ua: UA.desktop, me: linkedMe({}, NEW()), api: async (path) => (path === "/api/me/wallet/disown" ? { ok: false, error, _status: 409 } : undefined) });
    await t.tap(t.$("#wcard-remove")); await t.advance(10);
    assert.ok(t.toasts.includes(words), `${error}: ${JSON.stringify(t.toasts)}`);
    assert.equal(t.$("#wcard-note").hidden, false, "nothing changed");
  }
});

test("the note sits on the phone's buy card too; a browser the wallet made (notMe false) or a wallet app (no app named) words it plainly", async () => {
  const p = await openDashboard({ ua: UA.iphone, me: linkedMe({ walletApp: "phantom" }, NEW({ at: minutesAgo(120) })) });
  assert.equal(p.text("#wcard-kicker"), "New wallet on your account", "while it asks: not the app the claim reported (and never the wallet: the kicker is in capitals)");
  assert.equal(p.text("#wcard-title"), "On this phone you buy in Phantom");
  assert.equal(p.text("#wcard-note-text"), `Connected 2h ago in Phantom (wallet ${MASKED}). Wasn't you?`);
  // the browser the wallet made (or one that may not ask): "Phantom connected ✓", nothing to ask
  const o = await openDashboard({ ua: UA.iphone, me: linkedMe({ walletApp: "phantom" }, NEW({ notMe: false })) });
  assert.equal(o.text("#wcard-kicker"), "Phantom connected ✓"); assert.equal(o.$("#wcard-note").hidden, true);
  const q = await openDashboard({ ua: UA.desktop, me: linkedMe({}, NEW({ notMe: false })) });
  assert.equal(q.$("#wallet-card").hidden, true, "the browser the wallet made has nothing to remove");
  const r = await openDashboard({ ua: UA.desktop, me: linkedMe({}, NEW({ app: null, via: "pair" })) });
  assert.equal(r.text("#wcard-kicker"), "New wallet on your account");
  assert.equal(r.text("#wcard-note-text"), `Connected 5m ago from a wallet app (wallet ${MASKED}). Wasn't you?`);
  await r.tap(r.$("#wcard-remove"));
  assert.deepEqual(r.confirms, [`Remove this wallet (${MASKED}) from your account? The wallet app will be logged out of Vicinity.`]);
});

test("a username change refused with link_new (a session the new wallet made, during its 7 days) says where it works instead, naming the app", async () => {
  // (review finding ux-UX-1: "use the browser you first logged in with" sent people round in a loop; it now names the step that works)
  for (const [answer, words] of [[{ app: "phantom" }, "For your safety, for 7 days after connecting Phantom, you do this in Safari or Chrome, where you logged in before."],
    [{}, "For your safety, for 7 days after connecting a wallet app, you do this in Safari or Chrome, where you logged in before."]]) {
    const p = await openDashboard({ me: linkedMe(), api: async (path) => (path === "/api/me/username" ? { ok: false, error: "link_new", _status: 403, ...answer } : undefined) });
    p.win.V.openProfile(); await p.flush();
    p.$("#username-input").value = "NewName";
    p.$("#username-form").dispatchEvent(Object.assign(new (p.win.CustomEvent)("submit"), { preventDefault() {} }));
    await p.flush(); await p.advance(10);
    assert.equal(p.$("#username-err").hidden, false);
    assert.equal(p.text("#username-err"), words);
  }
});

test("Safari during those 7 days (review finding ux-UX-1): a proof for the username offers 'Log in again', never the wallet app (it would refuse); Unlink is 'Remove it'", async () => {
  const ask = async (p) => {
    p.win.V.openProfile(); await p.flush();
    p.$("#username-input").value = "NewName";
    p.$("#username-form").dispatchEvent(Object.assign(new (p.win.CustomEvent)("submit"), { preventDefault() {} }));
    await p.flush();
  };
  const relogin = async (path) => (path === "/api/me/username" ? { ok: false, error: "reprove", relogin: true, _status: 403 } : undefined);
  const p = await openDashboard({ ua: UA.iphone, me: linkedMe({ walletApp: "phantom" }, NEW()), api: relogin, storage: { "vicinity.walletApp": "phantom" } });
  await ask(p);
  assert.equal(p.$("#proof-modal").hidden, false);
  assert.equal(p.$("#proof-app").hidden, true, "no 'Open Phantom'"); assert.equal(p.$("#proof-apps").hidden, true);
  assert.equal(p.$("#proof-login").hidden, false); assert.equal(p.text("#proof-login"), "Log in again");
  assert.equal(p.text("#proof-app-line"), "For 7 days after connecting Phantom, you confirm this here: log in again, then try once more.");
  assert.equal(p.$("#proof-transfer").hidden, true);
  await p.tap(p.$("#proof-login")); await p.advance(10);
  assert.equal(p.callsTo("/api/auth/logout").length, 1);
  assert.deepEqual(p.assigned, ["/connect?mode=login&error=relogin_confirm"]);
  // a computer with the extension: its wallet still works, and "Log in again" is there too
  const c = await openDashboard({ ua: UA.desktop, me: linkedMe({ walletApp: "phantom" }, NEW()), api: relogin, wallets: [fakeWallet("Phantom").wallet] });
  await ask(c);
  assert.equal(c.$("#proof-wallets").children.length, 1); assert.equal(c.$("#proof-login").hidden, false);
  // Unlink in Profile, from such a browser: the Remove-it way (that wallet's own proof is locked in its app then)
  let removed = false;
  const u = await openDashboard({ ua: UA.iphone, me: () => (removed ? memberMe() : linkedMe({ walletApp: "phantom" }, NEW())),
    api: async (path) => { if (path === "/api/me/wallet/disown") { removed = true; return { ok: true }; } } });
  u.win.V.openProfile(); await u.flush();
  await u.tap(u.$("#profile-unlink")); await u.advance(100);
  assert.deepEqual(u.confirms, [`Remove this wallet (${MASKED}) from your account? Phantom will be logged out of Vicinity.`]);
  assert.equal(u.callsTo("/api/me/wallet/disown").length, 1); assert.equal(u.callsTo("/api/me/wallet/unlink").length, 0);
  // without the window: today's unlink
  const v = await openDashboard({ ua: UA.desktop, me: linkedMe(), api: async (path) => (path === "/api/me/wallet/unlink" ? { ok: true } : undefined) });
  v.win.V.openProfile(); await v.flush();
  await v.tap(v.$("#profile-unlink")); await v.advance(100);
  assert.equal(v.callsTo("/api/me/wallet/unlink").length, 1);
});

test("inside Phantom, its wallet injected a few seconds late (review finding ux-UX-4): the card turns from Safari's 'Connect Phantom' into the in-app one", async () => {
  const p = await openDashboard({ ua: UA.phantomApp, me: linkedMe({ walletApp: "phantom" }) });
  assert.equal(p.text("#wcard-title"), "On this phone you buy in Phantom", "(no wallet yet: it looks like any phone browser)");
  await p.advance(2000);
  await p.register(fakeWallet("Phantom").wallet);
  assert.equal(p.text("#wcard-title"), "Phantom connected ✓");
  assert.equal(p.$("#wcard-tip").hidden, false);
  assert.equal(p.$("#wcard-actions").hidden, true, "no 'Connect Phantom' (it would leave for phantom.com) inside Phantom");
  assert.equal(p.local.get("vicinity.walletApp"), "phantom");
});

test("the wallet-app chips are full touch targets (44 px) in the stylesheet", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../public/onboard.css", import.meta.url), "utf8");
  assert.match(css, /\.wcard__apps \.chip-link, #proof-apps \.chip-link \{ min-height: 44px;/);
});

/* ---------------- a visitor ---------------- */

test("a visitor inside Phantom: 'Sign in with Phantom' (one tap, one signature); Safari, a computer and Instagram: 'Join or log in'", async () => {
  const guest = { ok: true, signedIn: false };
  const p = await openDashboard({ ua: UA.phantomApp, me: guest, wallets: [fakeWallet("Phantom").wallet] });
  assert.equal(p.text("#out-cta"), "Sign in with Phantom");
  assert.equal(p.$("#out-cta").getAttribute("href"), "/connect?mode=login&with=phantom");
  assert.match(p.text("#out-cta-note"), /^One free signature\. Nothing is paid or moved\./);
  for (const ua of [UA.iphone, UA.desktop, UAS.instagram]) {
    const q = await openDashboard({ ua, me: guest });
    assert.equal(q.text("#out-cta"), "Join or log in →", ua); assert.equal(q.$("#out-cta").getAttribute("href"), "/connect");
  }
  // the wallet app's wallet turns up a moment late: the button follows
  const late = await openDashboard({ ua: UA.phantomApp, me: guest });
  assert.equal(late.text("#out-cta"), "Join or log in →");
  for (const l of late.win.listeners.filter((x) => x.type === "wallet-standard:register-wallet")) l.fn({ detail: (a) => a.register(fakeWallet("Phantom").wallet) });
  await late.advance(500);
  assert.equal(late.text("#out-cta"), "Sign in with Phantom");
});

/* ---------------- a proof on a phone ---------------- */

test("a proof asked on a phone's Safari (no wallet in the browser): 'Open Phantom' opens this page inside Phantom; no app known: the chips", async () => {
  const reprove = async (path) => (path === "/api/me/username" ? { ok: false, error: "reprove" } : undefined);
  const ask = async (p) => {
    p.win.V.openProfile(); await p.flush();
    p.$("#username-input").value = "NewName";
    p.$("#username-form").dispatchEvent(Object.assign(new (p.win.CustomEvent)("submit"), { preventDefault() {} }));
    await p.flush();
  };
  const p = await openDashboard({ ua: UA.iphone, me: linkedMe(), api: reprove, storage: { "vicinity.walletApp": "phantom" } });
  await ask(p);
  assert.equal(p.$("#proof-modal").hidden, false);
  assert.equal(p.$("#proof-app").hidden, false); assert.equal(p.text("#proof-app"), "Open Phantom");
  // it opens THIS page there: the tab comes along as next= (review finding ux-UX-3; /connect checks it and lands there: connect-inwallet)
  assert.equal(p.win.location.hash, "#profile");
  assert.equal(p.$("#proof-app").getAttribute("href"), openInApp(p, "phantom", "/dashboard#profile"));
  assert.equal(p.text("#proof-app-line"), "On this phone you confirm in Phantom. It opens this page there, logged in.");
  assert.equal(p.$("#proof-none").hidden, true); assert.equal(p.$("#proof-apps").hidden, true);
  const q = await openDashboard({ ua: UA.iphone, me: linkedMe(), api: reprove });
  await ask(q);
  assert.equal(q.$("#proof-app").hidden, true); assert.equal(q.$("#proof-apps").hidden, false);
  assert.ok(q.$("#proof-apps").children.some((c) => c.textContent === "Phantom" && c.getAttribute("href") === openInApp(q, "phantom", "/dashboard#profile")));
  // a computer: the wallet list and the transfer, as before
  const r = await openDashboard({ ua: UA.desktop, me: linkedMe(), api: reprove });
  await ask(r);
  assert.equal(r.$("#proof-app").hidden, true); assert.equal(r.$("#proof-app-line").hidden, true); assert.equal(r.$("#proof-apps").hidden, true);
});
