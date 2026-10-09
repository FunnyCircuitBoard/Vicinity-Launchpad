// Onboarding v3 on the /connect page: two steps (location, then the account), one tap that agrees to the Terms and goes to Google,
// the location step moving on by itself, the e-mail code sent on its sixth digit, the bounce-backs from Google, the no-account screen,
// and the link mode of a member whose account has no wallet. Runs the real page (test/helpers/connectpage.js); the "Open app" link and
// the pairing have their own files (test/connect-carry.test.js, test/connect-pairing.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, LINK_ME, MESSAGE, STATE, UA, fakeWallet, openConnect } from "./helpers/connectpage.js";

const COMMUNITY = { id: "5142056", name: "Utica", country: "US" };
/** A server for a sign-up: `world.state` is what GET /api/signup/state answers; the location and the Terms update it. */
function server(start = STATE.empty()) {
  const world = { state: start, calls: [], verify: () => ({ ok: true, existing: false, isNew: true, next: "/dashboard?welcome=1", welcome: { name: null, city: "Utica", memberNumber: 1 } }) };
  const api = async (path, body) => {
    world.calls.push({ path, body });
    if (path === "/api/signup/start") return { ok: true, state: world.state };
    if (path === "/api/signup/location") { world.state = { ...world.state, location: { done: true, community: COMMUNITY }, next: world.state.account.done ? "finish" : "account" }; return { ok: true, community: COMMUNITY }; }
    if (path === "/api/signup/terms") { world.state = { ...world.state, terms: { done: true, version: "2026-10-01" } }; return { ok: true, state: world.state }; }
    if (path === "/api/signup/email") return { ok: true };
    if (path === "/api/signup/email/verify") return world.verify(body);
    if (path === "/api/signup/finish") return { ok: true, next: "/dashboard?welcome=1", isNew: true, welcome: { name: "Sa", city: "Utica", memberNumber: 3 } };
    return { ok: true };
  };
  return { world, api, state: () => world.state };
}
const geo = { getCurrentPosition: (ok) => ok({ coords: { latitude: 43.1, longitude: -75.23, accuracy: 30 } }) };

test("New here: a two-step bar with a 'Wallet · later' chip that is not a step; the lead says two quick steps and no wallet", async () => {
  const s = server();
  const p = await openConnect({ api: s.api, state: s.state });
  assert.equal(p.screen(), "su-location");
  assert.equal(p.visible(p.$("#su-steps")), true);
  assert.deepEqual(p.$("#su-steps").children.map((li) => li.getAttribute("data-step")), ["location", "account", null]);
  assert.equal(p.$("#su-later").textContent.replace(/\s+/g, " ").trim(), "Wallet · later: your wallet comes later, from your dashboard. Free, one signature.");
  assert.equal(p.$("#su-later").getAttribute("title"), "Your wallet comes later, from your dashboard. Free, one signature.");
  assert.ok(p.$("#su-steps li[data-step=\"location\"]").classList.contains("is-active"));
  assert.match(p.$(".connect__intro .lead").textContent, /^Two quick steps: where you are, then who you are\. Your dashboard opens right after\. Link a wallet there whenever you like\./);
  assert.match(p.$("#su-live").textContent, /Step 1 of 2: Location/);
  assert.equal(p.$("#su-loc-go").textContent, "Share my location");
});

test("the location confirmed: a moment to see it, then step 2 by itself (announced); the bar still leads back to the done view", async () => {
  const s = server();
  const p = await openConnect({ api: s.api, state: s.state, geolocation: geo });
  await p.tap(p.$("#su-loc-go"));
  assert.equal(p.screen(), "su-location");
  assert.equal(p.$("#su-loc-title").textContent, "Location confirmed");
  assert.equal(p.$("#su-loc-city").textContent, "Utica, US");
  assert.match(p.$("#su-loc-note").textContent, /This will be your home community\. You can change it once after 7 days\. Your exact location was not saved\./);
  await p.advance(0); // reduced motion in this DOM: the move is immediate (800 ms otherwise)
  assert.equal(p.screen(), "su-account");
  assert.match(p.$("#su-live").textContent, /Location confirmed: Utica\. Step 2 of 2: Account/);
  assert.ok(p.$("#su-steps li[data-step=\"location\"]").classList.contains("is-done"));
  assert.ok(p.$("#su-steps li[data-step=\"account\"]").classList.contains("is-active"));
  assert.equal(p.$("#su-step-location").disabled, false, "the done view stays reachable from the bar");
  await p.tap(p.$("#su-step-location"));
  assert.equal(p.screen(), "su-location");
  assert.equal(p.$("#su-loc-title").textContent, "Location confirmed");
  await p.advance(5000);
  assert.equal(p.screen(), "su-location", "looked at on purpose: it does not move on by itself again");
  await p.tap(p.$("#su-loc-continue"));
  assert.equal(p.screen(), "su-account");
  assert.equal(p.$("#su-recap-city").textContent, "Utica, US");
});

test("step 2: 'Agree and continue with Google' is one tap: it ticks the box, records the Terms and goes to Google; nothing asks for a wallet", async () => {
  const s = server(STATE.account());
  const p = await openConnect({ api: s.api, state: s.state });
  assert.equal(p.screen(), "su-account");
  const google = p.$("#su-google");
  assert.equal(p.visible(google), true);
  assert.equal(google.disabled, false, "enabled although the box is not ticked yet");
  assert.equal(p.$("#su-terms").checked, undefined);
  assert.equal(p.visible(p.$("#su-google-note")), true);
  assert.equal(p.visible(p.$("#su-terms-hint")), false);
  assert.equal(p.$("#su-email-alt").open, true, "on a computer the e-mail way is open as well (the page opens the details)");
  await p.tap(google);
  assert.equal(p.$("#su-terms").checked, true, "the tap ticked the box");
  assert.deepEqual(s.world.calls.filter((c) => c.path === "/api/signup/terms").map((c) => c.body), [{ version: "2026-10-01" }]);
  assert.deepEqual(p.assigned, ["/api/auth/google/start?signup=1"]);
  assert.equal(s.world.calls.some((c) => /wallet|pair|auth\/wallet/.test(c.path)), false);
});

test("step 2: unticking the box by hand holds both primaries with a hint; ticking it again frees them", async () => {
  const s = server(STATE.account());
  const p = await openConnect({ api: s.api, state: s.state });
  const box = p.$("#su-terms");
  box.checked = true; box.dispatchEvent(Object.assign({ type: "change", bubbles: true, target: box, preventDefault() {}, stopPropagation() {} }));
  await p.flush();
  box.checked = false; box.dispatchEvent(Object.assign({ type: "change", bubbles: true, target: box, preventDefault() {}, stopPropagation() {} }));
  await p.flush();
  assert.equal(p.$("#su-google").disabled, true);
  assert.equal(p.$("#su-email-send").disabled, true);
  assert.equal(p.visible(p.$("#su-terms-hint")), true);
  assert.equal(p.$("#su-terms-hint").textContent, "Tick the box to continue.");
  await p.tap(p.$("#su-google"));
  assert.deepEqual(p.assigned, [], "a disabled primary goes nowhere");
  box.checked = true; box.dispatchEvent(Object.assign({ type: "change", bubbles: true, target: box, preventDefault() {}, stopPropagation() {} }));
  await p.flush();
  assert.equal(p.$("#su-google").disabled, false);
  assert.equal(p.visible(p.$("#su-terms-hint")), false);
});

test("step 2 inside a wallet app: no Google button, the callout says e-mail here or Safari (with a copy button), the e-mail way is open", async () => {
  const s = server(STATE.account());
  const { wallet } = fakeWallet("Phantom");
  const p = await openConnect({ ua: UA.phantomApp, wallets: [wallet], api: s.api, state: s.state });
  assert.equal(p.screen(), "su-account");
  assert.equal(p.visible(p.$("#su-google")), false);
  assert.equal(p.visible(p.$("#su-inapp")), true);
  assert.match(p.$("#su-inapp").textContent, /Google cannot sign you in inside a wallet app\. Use e-mail here, or open vicinity\.city\/connect in Safari or Chrome\./);
  assert.equal(p.visible(p.$("#su-copy")), true);
  assert.equal(p.$("#su-email-alt").open, true);
  assert.equal(p.calls.some((c) => c.path.startsWith("/api/auth/google")), false, "no Google start fires in a wallet app");
});

test("the e-mail way: 'Agree and send me a code' ticks the box too; the code form sends itself on the sixth digit, and the account is made with it", async () => {
  const s = server(STATE.account());
  const p = await openConnect({ api: s.api, state: s.state });
  p.$("#su-email").value = "ada@example.com"; p.$("#su-pw").value = "correct horse battery staple";
  assert.equal(p.$("#su-email-send").textContent, "Agree and send me a code");
  p.$("#su-email-form").dispatchEvent(Object.assign({ type: "submit", bubbles: true, target: p.$("#su-email-form"), preventDefault() {}, stopPropagation() {} }));
  await p.flush();
  assert.equal(p.$("#su-terms").checked, true);
  assert.deepEqual(s.world.calls.filter((c) => c.path === "/api/signup/terms").length, 1);
  assert.deepEqual(s.world.calls.filter((c) => c.path === "/api/signup/email").map((c) => c.body), [{ email: "ada@example.com", password: "correct horse battery staple" }]);
  assert.equal(p.visible(p.$("#su-code-form")), true);
  assert.match(p.$("#su-code-form").textContent, /We sent a 6-digit code to ada@example\.com\. It works for 10 minutes\. Check spam too\./);
  const code = p.$("#su-code");
  code.value = "12345"; code.dispatchEvent(Object.assign({ type: "input", bubbles: true, target: code, preventDefault() {}, stopPropagation() {} }));
  await p.flush();
  assert.equal(s.world.calls.filter((c) => c.path === "/api/signup/email/verify").length, 0, "five digits: not yet");
  code.value = "123456"; code.dispatchEvent(Object.assign({ type: "input", bubbles: true, target: code, preventDefault() {}, stopPropagation() {} }));
  await p.flush();
  assert.deepEqual(s.world.calls.filter((c) => c.path === "/api/signup/email/verify").map((c) => c.body), [{ email: "ada@example.com", code: "123456" }]);
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-sub").textContent, "Your account is ready. Taking you to your dashboard…");
  assert.equal(p.$("#done-go").getAttribute("href"), "/dashboard?welcome=1");
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard?welcome=1"]);
});

test("the verified code when the location is missing: the login is kept, step 1 is next, and the finish is one tap once the location is in", async () => {
  const s = server({ ...STATE.empty(), terms: { done: true, version: "2026-10-01" } });
  s.world.verify = () => { s.world.state = { ...s.world.state, account: { done: true, provider: "email", email: "a***@example.com" }, next: "location" }; return { ok: true, existing: false, state: s.world.state, finishError: "location_required" }; };
  const p = await openConnect({ api: s.api, state: s.state, geolocation: geo, search: "step=account" });
  // (the page shows step 1 first: the location is missing; the test types the e-mail through the account step reached from a bounce)
  assert.equal(p.screen(), "su-location");
  await p.tap(p.$("#su-loc-go"));
  await p.advance(0);
  assert.equal(p.screen(), "su-account");
});

test("bounce-backs from Google: location_unverified lands on step 1 with the login kept; social_taken is the stuck screen; ?step=finish retries the finish", async () => {
  const back = { ...STATE.empty(), terms: { done: true, version: "2026-10-01" }, account: { done: true, provider: "google" }, next: "location" };
  let p = await openConnect({ search: "error=location_unverified", state: back, api: server(back).api });
  assert.equal(p.screen(), "su-location");
  assert.equal(p.$("#su-note").textContent, "Your connection no longer matches the place you shared (a different network, or a VPN?), so please check your location again. Your login is saved.");
  assert.ok(p.$("#su-steps li[data-step=\"account\"]").classList.contains("is-done"), "the login is ticked");
  assert.equal(p.addressBar.at(-1), "https://vicinity.test/connect", "the error left the address bar");

  p = await openConnect({ search: "error=social_taken", state: STATE.finish(), api: server(STATE.finish()).api });
  assert.equal(p.screen(), "su-finish");
  assert.equal(p.$("#su-fin-title").textContent, "That login already has a Vicinity account");
  assert.equal(p.$("#su-fin-error").textContent, "That login already has a Vicinity account. Log in with it instead, or choose another login.");
  assert.equal(p.visible(p.$("#su-fin-login")), true, "Log in instead");
  assert.equal(p.visible(p.$("#su-fin-ident")), true, "Use a different login");
  assert.equal(p.visible(p.$("#su-fin-retry")), false);
  assert.equal(p.callsTo("/api/signup/finish").length, 0, "nothing is retried by itself: the server already said no");
  await p.tap(p.$("#su-fin-login"));
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");

  const s = server(STATE.finish());
  p = await openConnect({ search: "step=finish", state: s.state, api: s.api });
  assert.equal(p.callsTo("/api/signup/finish").length, 1);
  assert.equal(p.screen(), "done");
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard?welcome=1"]);
});

test("no wallet step anywhere in the sign-up: the Log in tab is the only place with wallets for a visitor, and its wallet says 'Sign in'", async () => {
  const s = server();
  const p = await openConnect({ api: s.api, state: s.state, wallets: [fakeWallet("Phantom").wallet] });
  assert.equal(p.screen(), "su-location");
  assert.equal(p.visible(p.$("#wallets-detected")), false);
  await p.tap(p.$("#tab-login"));
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#wallet-h").textContent, "Log in with your wallet");
  assert.equal(p.visible(p.$("#link-top")), false);
  assert.equal(p.visible(p.$("#alt-skip")), false);
  await p.tap(p.$("#wallets-detected").children[0]);
  assert.equal(p.$("#c-sign").textContent, "Sign in");
});

test("S10 inside a wallet app: a wallet with no account gets the copy-the-link screen and the tiny 'already a member' line; nothing else fires", async () => {
  const { wallet } = fakeWallet("Phantom");
  let n = 0;
  const api = async (path) => (path.startsWith("/api/message") ? { message: MESSAGE + ++n } : path === "/api/auth/wallet" ? { ok: false, error: "no_account", _status: 404 } : { ok: true });
  const geolocation = { getCurrentPosition: () => { geolocation.asked = true; } };
  const p = await openConnect({ ua: UA.phantomApp, search: "mode=login", wallets: [wallet], api, state: STATE.empty(), geolocation });
  await p.tap(p.$("#wallets-detected").children[0]);
  await p.tap(p.$("#c-sign"));
  assert.equal(p.screen(), "no-account");
  assert.equal(p.$("#na-body").textContent, "Vicinity accounts start with Google or e-mail. Create yours in Safari or Chrome (it takes a minute), then link this wallet from your dashboard, one tap.");
  assert.equal(p.visible(p.$("#na-copy")), true);
  assert.equal(p.$("#na-copy").textContent, "Copy vicinity.city/connect");
  assert.equal(p.visible(p.$("#na-create")), false);
  assert.equal(p.visible(p.$("#na-tiny")), true);
  assert.equal(geolocation.asked, undefined);
  assert.equal(p.calls.some((c) => c.path.startsWith("/api/auth/google") || c.path === "/api/signup/location" || c.path === "/api/signup/terms"), false);
  await p.tap(p.$("#na-login"));
  assert.equal(p.screen(), "pick");
  assert.equal(p.$("#tab-login").getAttribute("aria-pressed"), "true");
});

test("the link mode on a computer: 'Almost done · Link your wallet.', the detected wallet, the phone and app-wallet ways, Skip for now; the intro follows", async () => {
  const { wallet } = fakeWallet("Phantom");
  const p = await openConnect({ me: LINK_ME, wallets: [wallet] });
  assert.equal(p.screen(), "pick");
  assert.equal(p.$(".connect__intro .kicker").textContent, "Almost done");
  assert.equal(p.$(".connect__intro .page-title").textContent, "Link your wallet.One signature.");
  assert.equal(p.visible(p.$("#link-top")), true);
  assert.equal(p.visible(p.$(".su-tabs")), false);
  assert.equal(p.visible(p.$("#su-steps")), false);
  assert.equal(p.visible(p.$("#su-top")), false, "no empty top above the panel");
  assert.equal(p.$("#wallet-h").textContent, "Choose your wallet");
  assert.equal(p.$("#su-wallet-lead").textContent, "Pick the wallet you want on your account. One free signature, nothing is paid or moved.");
  assert.deepEqual(p.$("#wallets-detected").children.map((t) => t.textContent), ["PhantomDetected"]);
  assert.equal(p.$("#alt-phone em").textContent, "Scan a code with your phone, sign there, finish here.");
  assert.equal(p.visible(p.$("#alt-app")), true);
  assert.equal(p.visible(p.$("#alt-skip")), true);
  assert.equal(p.visible(p.$("#alt-check")), false);
  assert.equal(p.$("#termsgate").hidden, true);
  assert.equal(p.callsTo("/api/signup/state").length, 0);
  await p.tap(p.$("#wallets-detected").children[0]);
  assert.equal(p.session.get("vl-started"), "1", "the dashboard (same tab) will poll for the wallet while this is set");
});

test("the link mode: the tiny transfer asks with link: true and keeps the session; a found transfer links the wallet", async () => {
  let found = false;
  const api = async (path, body) => {
    if (path === "/api/auth/transfer") return { ok: true, address: body.address, lamports: 1234000, sol: "0.001234", link: true, reprove: false };
    if (path === "/api/auth/transfer/check") return found ? { ok: true, linked: true, wallet: ADDR, next: "/dashboard?linked=1" } : { ok: false, error: "not_found_yet" };
    return { ok: true };
  };
  const p = await openConnect({ me: LINK_ME, api });
  await p.tap(p.$("#alt-app"));
  assert.equal(p.screen(), "app");
  p.$("#tp-addr").value = ADDR;
  p.$("#tp-form").dispatchEvent(Object.assign({ type: "submit", bubbles: true, target: p.$("#tp-form"), preventDefault() {}, stopPropagation() {} }));
  await p.flush();
  assert.deepEqual(p.callsTo("/api/auth/transfer").map((c) => c.body), [{ address: ADDR, link: true }]);
  assert.equal(p.$("#tp-sol").textContent, "0.001234");
  await p.advance(8000);
  assert.equal(p.callsTo("/api/auth/transfer/check").length, 1);
  found = true;
  await p.advance(10000);
  assert.equal(p.screen(), "done");
  assert.equal(p.$("#done-h").textContent, "Wallet linked.");
  await p.advance(1300);
  assert.deepEqual(p.assigned, ["/dashboard?linked=1"]);
});

test("the strict security policy holds on the new pieces: no inline style or script, no markup from text, the stylesheet is a file", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/connect.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/onboard.css", import.meta.url), "utf8");
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /<style/);
  assert.match(html, /<link rel="stylesheet" href="\/onboard\.css">/);
  for (const sel of [".su-later", ".link-top", ".link-in", ".no-account", ".wcard", ".ring", ".welcome"]) assert.ok(css.includes(sel), `${sel} is styled`);
  assert.ok(css.split("\n").filter((l) => /^\.[a-z]/.test(l)).every((l) => /^\.(su-later|su-alt|su-why|link-top|link-skip|link-in|no-account|welcome|ring|wcard|stepper--two|alt-ways|cstate\[data-state="su-account"\])/.test(l)), "every rule is scoped to the new pieces");
});
