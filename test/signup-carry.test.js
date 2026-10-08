// "Open app" on a phone carries the sign-up into the wallet app's own browser (live bug, 8 Oct 2026: Safari did the location and
// Google, Phantom's browser has its own cookies and showed step 1 again, where Google can't run, so the owner could not finish).
// POST /api/signup/carry makes a one-time code in Safari; POST /api/signup/carry/claim in the wallet app's browser gives it its own
// cookie for THE SAME sign-up (which moves there); Safari's GET /api/signup/state then says it went on there, and finished.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, V2, advance, browser, loginBody, realClock, useClock, wallet } from "./helpers/world.js";
import { doGoogle, doLocation, doTerms, doWallet, dumpAll, fakeGoogle, finish, journey, one, outbox, recordAnswers, rows, startSignup, stateOf } from "./helpers/signup.js";
import { sha256 } from "../src/http.js";

let env, box;
beforeEach(() => { useClock("2026-10-08T17:43:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const comcast = (extra = {}) => ({ country: "US", asn: 7922, asOrganization: "Comcast Cable", latitude: 43.1, longitude: -75.2, ...extra });
const PHONE_NET = { ip: "203.0.113.9", cf: comcast() };
/** Safari on the phone, at the wallet step: location (Utica) and Google done, exactly the owner's row on live. */
async function safariAtWallet(sub = "g-owner") {
  const safari = browser(env, PHONE_NET);
  const j = await journey(safari, box, { via: "google", sub, until: "account" });
  assert.equal(j.account.to, "/connect?step=wallet", "Google brought the person back to the wallet step");
  assert.equal((await stateOf(safari)).next, "wallet");
  return safari;
}
const carry = (b) => b.post("/api/signup/carry");
const claim = (b, code) => b.post("/api/signup/carry/claim", { code });
/** Phantom's in-app browser on the same phone: no cookies at all, the same connection. */
const phantom = () => browser(env, { ip: "203.0.113.9", cf: comcast() });

test("the owner's journey: Safari (location + Google) → Open app → Phantom lands on the wallet step, signs, and the account is made", async () => {
  const safari = await safariAtWallet();
  const made = await carry(safari);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.match(made.code, /^[A-Za-z0-9_-]{32}$/, "24 random bytes: 192 bits");
  assert.equal(made.url, `https://vicinity.test/connect?carry=${made.code}`);
  assert.equal(Date.parse(made.expiresAt) - Date.now(), 10 * 60_000, "ten minutes");

  const app = phantom();
  const got = await app.send("/api/signup/carry/claim", { method: "POST", body: { code: made.code } });
  assert.equal(got.status, 200);
  const sc = got.headers.getSetCookie().filter((c) => c.startsWith("vsu="));
  assert.equal(sc.length, 1);
  assert.match(sc[0], /^vsu=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600$/);
  assert.notEqual(app.jar.get("vsu"), safari.jar.get("vsu"), "the wallet app's browser gets its own token");
  const st = (await got.json()).state;
  assert.equal(st.next, "wallet", "it lands straight on the wallet step");
  assert.equal(st.location.done, true);
  assert.equal(st.location.community.name, "Utica");
  assert.equal(st.terms.done, true);
  assert.equal(st.account.done, true);
  assert.equal(st.account.provider, "google");
  assert.equal(st.wallet.done, false);

  // Safari no longer owns it, and says where it went
  assert.deepEqual((await stateOf(safari)).carried, { done: false, live: true, provider: "google" });
  assert.equal((await safari.post("/api/signup/finish")).error, "no_signup", "Safari can't act on it any more");

  // Phantom: the wallet, then the one atomic finish
  const w = await wallet();
  assert.equal((await doWallet(app, w)).next, "signup");
  assert.equal((await stateOf(app)).next, "finish");
  const fin = await finish(app);
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(fin.next, "/dashboard?welcome=1");
  const u = await one(env.DB, "SELECT * FROM users WHERE wallet = ?", w.address);
  assert.equal(u.provider, "google");
  assert.equal(u.provider_id, "g-owner", "the Google login done in Safari is the account's login");
  assert.equal(u.home_name, "Utica", "and the location done in Safari is its home");
  assert.equal((await app.get("/api/me")).signedIn, true, "signed in inside the wallet app");

  // Safari learns it is done (and which login to use there), and nothing is left but that note
  assert.deepEqual((await stateOf(safari)).carried, { done: true, live: false, provider: "google" });
  assert.equal((await rows(env.DB, "SELECT * FROM signups")).length, 0);
  const left = await rows(env.DB, "SELECT kind, user_id FROM handoffs");
  assert.deepEqual(left, [{ kind: "carry", user_id: u.id }]);
});

test("Safari can log in too afterwards, the normal way (Google again): no session comes from the leftover sign-up cookie", async () => {
  const safari = await safariAtWallet("g-two");
  const app = phantom();
  assert.equal((await claim(app, (await carry(safari)).code)).ok, true);
  await doWallet(app, await wallet());
  assert.equal((await finish(app)).ok, true);
  assert.equal((await safari.get("/api/me")).signedIn, false, "Safari is not signed in by itself");
  for (const path of ["/api/signup/finish", "/api/signup/terms", "/api/signup/carry"]) {
    assert.equal((await safari.post(path, { version: "2026-10-01" })).error, "no_signup", path);
  }
  // Log in with Google (no ?signup=1) signs the new account in, and tidies the note away
  const start = await safari.send("/api/auth/google/start");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cb = await safari.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: fakeGoogle("g-two") });
  assert.equal(cb.headers.get("location"), "/dashboard");
  assert.equal((await safari.get("/api/me")).signedIn, true);
  assert.equal((await rows(env.DB, "SELECT * FROM handoffs")).length, 0, "the note went with the old sign-up cookie");
});

test("only a sign-up at its wallet step can be carried: nobody skips location, Terms or account by changing browsers", async () => {
  const b = browser(env, PHONE_NET);
  assert.equal((await carry(b)).error, "no_signup");
  await startSignup(b);
  let r = await b.send("/api/signup/carry", { method: "POST", body: {} });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "not_ready");
  await doLocation(b, IN_UTICA);
  assert.equal((await carry(b)).error, "not_ready", "location only");
  await doTerms(b);
  assert.equal((await carry(b)).error, "not_ready", "Terms but no account");
  await doGoogle(b, "g-x");
  assert.equal((await carry(b)).ok, true, "location, Terms and account: yes");
  assert.equal((await rows(env.DB, "SELECT * FROM handoffs WHERE kind = 'carry'")).length, 1);
});

test("the code: only its hash is stored, it works once, for ten minutes, and a new tap replaces the old one", async () => {
  const safari = await safariAtWallet();
  const first = await carry(safari);
  const stored = await rows(env.DB, "SELECT * FROM handoffs WHERE kind = 'carry'");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, await sha256(first.code));
  assert.ok(!(await dumpAll(env.DB)).includes(first.code), "the code itself is in no row");

  const second = await carry(safari);
  assert.notEqual(second.code, first.code);
  assert.equal((await claim(phantom(), first.code)).error, "carry_expired", "the code before is dead");

  // ten minutes
  advance(10 * 60_000 + 1000);
  assert.equal((await claim(phantom(), second.code)).error, "carry_expired");

  // once
  const third = await carry(safari);
  assert.equal((await claim(phantom(), third.code)).ok, true);
  const again = await phantom().send("/api/signup/carry/claim", { method: "POST", body: { code: third.code } });
  assert.equal(again.status, 410);
  assert.deepEqual(await again.json(), { ok: false, error: "carry_expired" });
  assert.equal(again.headers.getSetCookie().length, 0);
});

test("the same phone only: another internet connection can't use the code (and doesn't use it up)", async () => {
  const safari = await safariAtWallet();
  const { code } = await carry(safari);
  const friend = browser(env, { ip: "198.51.100.5", cf: comcast({ asn: 701 }) });
  const r = await friend.send("/api/signup/carry/claim", { method: "POST", body: { code } });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: "carry_network" });
  assert.equal(friend.has("vsu"), false);
  // review F1: another customer of the SAME internet provider (same country and network operator, another address) is not this phone
  const neighbour = browser(env, { ip: "203.0.113.200", cf: comcast() });
  assert.equal((await claim(neighbour, code)).error, "carry_network");
  assert.equal((await neighbour.post("/api/signup/carry/info", { code })).error, "carry_network", "and can't even read whose sign-up it is");
  assert.equal(neighbour.has("vsu"), false);
  assert.equal((await stateOf(safari)).next, "wallet", "Safari still has it");
  assert.equal((await claim(phantom(), code)).ok, true, "the phone itself still can");
});

test("IPv6: the code is bound to the phone's /64 (Safari and the wallet app may use different addresses in it), never to the provider", async () => {
  const net6 = (ip) => ({ ip, cf: comcast() });
  const safari = browser(env, net6("2001:db8:44:7:1111:2222:3333:4444"));
  const j = await journey(safari, box, { via: "google", sub: "g-v6", until: "account" });
  assert.equal(j.account.to, "/connect?step=wallet");
  const { code } = await carry(safari);
  assert.equal((await claim(browser(env, net6("2001:db8:44:8::9")), code)).error, "carry_network", "another /64 of the same provider");
  assert.equal((await claim(browser(env, net6("203.0.113.9")), code)).error, "carry_network", "IPv4 is another connection too");
  assert.equal((await claim(browser(env, net6("2001:db8:44:7:abcd::9")), code)).ok, true, "the same /64: the same phone");
  const stored = await rows(env.DB, "SELECT net FROM handoffs WHERE kind = 'carry'");
  assert.ok(stored.every((h) => /^carryip:[A-Za-z0-9_-]{22}$/.test(h.net)), "kept only as a salted hash, never the address");
  assert.ok(!(await dumpAll(env.DB)).includes("2001:db8:44:7"), "the address is in no row");
});

test("made-up, wrong-kind and malformed codes open nothing; claims are counted per connection", async () => {
  const safari = await safariAtWallet();
  const app = phantom();
  for (const code of [undefined, null, 7, {}, [], "", "short", "x".repeat(65), "a b c d e f g h i j k l m n o p q r s t u v w"]) {
    assert.equal((await claim(app, code)).error, "carry_expired", JSON.stringify(code));
  }
  // a location hand-off code is not an "Open app" code
  const b = browser(env, PHONE_NET);
  await startSignup(b);
  const ho = await b.post("/api/signup/location/handoff");
  assert.equal((await claim(app, ho.code)).error, "carry_expired");
  // and an "Open app" code is not a location hand-off
  const { code } = await carry(safari);
  assert.equal((await b.post("/api/signup/location/handoff/info", { code })).error, "expired");
  assert.equal((await b.post("/api/signup/location/handoff/complete", { code, location: IN_UTICA })).error, "expired");
  assert.equal(app.has("vsu"), false);
  // 30 tries an hour per connection
  const noisy = browser(env, { ip: "203.0.113.77", cf: comcast() });
  let last;
  for (let i = 0; i < 31; i++) last = await noisy.send("/api/signup/carry/claim", { method: "POST", body: { code: "y".repeat(32) } });
  assert.equal(last.status, 429);
});

test("making codes is counted: ten an hour per sign-up", async () => {
  const safari = await safariAtWallet();
  for (let i = 0; i < 10; i++) assert.equal((await carry(safari)).ok, true, `try ${i + 1}`);
  const r = await safari.send("/api/signup/carry", { method: "POST", body: {} });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "slow_down");
});

test("a signed-in wallet app browser goes to its dashboard and leaves the code unused", async () => {
  const safari = await safariAtWallet();
  const { code } = await carry(safari);
  const app = phantom();
  const m = await journey(browser(env, PHONE_NET), box, { via: "google", sub: "g-member" });
  assert.equal(m.finish.ok, true);
  // sign that member in inside the app's browser
  const w = m.w;
  assert.equal((await app.post("/api/auth/wallet", await loginBody(w))).next, "/dashboard");
  const r = await app.send("/api/signup/carry/claim", { method: "POST", body: { code } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "already_signed_in");
  assert.equal((await claim(phantom(), code)).ok, true, "still usable by the person's own wallet app");
});

test("a sign-up that ran out can't be carried, and an old carried note runs out with it", async () => {
  const safari = await safariAtWallet();
  const { code } = await carry(safari);
  advance(61 * 60_000); // an hour with nothing done: the sign-up is gone, and the code too
  assert.equal((await claim(phantom(), code)).error, "carry_expired");

  const s2 = await safariAtWallet("g-late");
  const app = phantom();
  assert.equal((await claim(app, (await carry(s2)).code)).ok, true);
  assert.equal((await stateOf(s2)).carried.live, true);
  advance(61 * 60_000); // the wallet app did nothing for an hour
  const gone = (await stateOf(s2)).carried;
  assert.equal(gone.done, false);
  assert.equal(gone.live, false, "it ran out there: Safari can say so (and start again)");
  advance(2 * 3600_000); // past the three hours a sign-up can ever live: the note is gone too
  assert.equal((await stateOf(s2)).carried, undefined);
});

test("the code is in exactly one answer (the one that made it), and in no log line", async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    const safari = await safariAtWallet();
    const seenSafari = recordAnswers(safari);
    const { code } = await carry(safari);
    const app = phantom();
    const seenApp = recordAnswers(app);
    await claim(app, code);
    await doWallet(app, await wallet());
    await finish(app);
    await stateOf(safari);
    assert.equal(seenSafari.filter((t) => t.includes(code)).length, 1, "only the answer that made it");
    assert.equal(seenApp.filter((t) => t.includes(code)).length, 0);
    assert.ok(!lines.some((l) => l.includes(code)), "never logged");
  } finally { Object.assign(console, orig); }
});

/* ---------------- review fixes: whose sign-up it is, before anything is taken over (SEC-1, F1, F2, F5, F7, COR-1) ---------------- */

test("info: the wallet app's page sees the check number Safari shows, the community and the login (masked), and nothing is taken over", async () => {
  const safari = await safariAtWallet("g-sakib");
  const made = await carry(safari);
  assert.match(made.pin, /^[1-9]\d$/, "two digits");
  assert.match(made.ref, /^[A-Za-z0-9_-]{12}$/);
  const app = phantom();
  const info = await app.post("/api/signup/carry/info", { code: made.code });
  assert.deepEqual(info, { ok: true, pin: made.pin, community: { name: "Utica", country: "US" }, login: { provider: "google", name: "Gg•••" }, expiresAt: made.expiresAt });
  assert.equal(app.has("vsu"), false, "no sign-up cookie: nothing moved");
  assert.equal((await stateOf(safari)).next, "wallet", "Safari still has it");
  assert.equal((await stateOf(safari)).carry.ref, made.ref, "and its live link is the one it made");
  assert.equal((await claim(app, made.code)).ok, true, "the code still works after being looked at");
  assert.equal((await app.post("/api/signup/carry/info", { code: made.code })).error, "carry_expired", "a used code shows nothing");
  for (const code of [undefined, 7, "short", "x".repeat(32)]) assert.equal((await app.post("/api/signup/carry/info", { code })).error, "carry_expired");
});

test("info for an e-mail sign-up shows the masked address, never the whole one", async () => {
  const safari = browser(env, PHONE_NET);
  await journey(safari, box, { via: "email", email: "owner@example.com", until: "account" });
  const { code } = await carry(safari);
  const info = await phantom().post("/api/signup/carry/info", { code });
  assert.deepEqual(info.login, { provider: "email", name: "o***@example.com" });
});

test("SEC-1: a browser that proved a wallet BEFORE it claims someone's code can't finish with that proof (no zero-click account)", async () => {
  // the attacker's own sign-up, carried; the victim's browser proved a NEW wallet a minute earlier (a pending session, no account)
  const attacker = await safariAtWallet("g-attacker");
  const { code } = await carry(attacker);
  const victim = phantom(), vw = await wallet();
  assert.equal((await doWallet(victim, vw)).next, "signup");
  const pending = victim.jar.get("vs");
  advance(60_000);
  const got = await victim.send("/api/signup/carry/claim", { method: "POST", body: { code } });
  assert.equal(got.status, 200);
  assert.ok(got.headers.getSetCookie().some((c) => /^vs=; /.test(c)), "the earlier wallet session is cleared...");
  assert.equal(await one(env.DB, "SELECT id FROM sessions WHERE id = ?", await sha256(pending)), null, "...and deleted");
  const st = (await got.json()).state;
  assert.equal(st.wallet.done, false, "the wallet step is open again");
  assert.equal(st.next, "wallet", "nothing finishes by itself");
  assert.equal((await stateOf(victim)).next, "wallet");
  assert.equal((await finish(victim)).error, "wallet_required");
  assert.equal((await rows(env.DB, "SELECT * FROM users")).length, 0);
});

test("SEC-1: finish wants a wallet proven AFTER the claim, even with a session the claim did not see", async () => {
  const safari = await safariAtWallet("g-guard");
  const { code } = await carry(safari);
  // a wallet proven a minute BEFORE the claim, in another jar (the claim can't drop it), then handed to the claiming browser
  const other = phantom(), w = await wallet();
  assert.equal((await doWallet(other, w)).next, "signup");
  advance(60_000);
  const app = phantom();
  assert.equal((await claim(app, code)).ok, true);
  app.jar.set("vs", other.jar.get("vs"));
  const r = await app.send("/api/signup/finish", { method: "POST", body: {} });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "wallet_required");
  assert.equal((await rows(env.DB, "SELECT * FROM users")).length, 0, "nothing was created");
  // signing now (after the claim) is what counts
  advance(1000);
  assert.equal((await doWallet(app, w)).next, "signup");
  assert.equal((await finish(app)).ok, true);
  assert.equal((await one(env.DB, "SELECT provider_id FROM users WHERE wallet = ?", w.address)).provider_id, "g-guard");
});

test("COR-1: Safari behind iCloud Private Relay (or another relay) gets no code: the page pairs instead", async () => {
  for (const cf of [comcast({ asn: 13335, asOrganization: "Cloudflare, Inc." }), comcast({ asn: 36183, asOrganization: "Akamai Technologies, Inc." }),
    comcast({ asn: 54113, asOrganization: "Fastly, Inc." }), comcast({ asn: 209242, asOrganization: "Cloudflare London, LLC" })]) {
    const safari = browser(env, { ip: "172.16.4.4", cf });
    const j = await journey(safari, box, { via: "google", sub: `g-relay-${cf.asn}`, until: "account" });
    assert.equal(j.account.to, "/connect?step=wallet", "the location and the account work behind a relay");
    const r = await safari.send("/api/signup/carry", { method: "POST", body: {} });
    assert.equal(r.status, 409, cf.asOrganization);
    assert.deepEqual(await r.json(), { ok: false, error: "carry_relay" });
  }
  assert.equal((await rows(env.DB, "SELECT * FROM handoffs WHERE kind = 'carry'")).length, 0, "no code was made");
});

test("F5: the state names the live link (a newer tap replaces it, a used one is gone), so a tab can tell its link was replaced", async () => {
  const safari = await safariAtWallet();
  assert.equal((await stateOf(safari)).carry, undefined, "no link yet");
  const first = await carry(safari);
  assert.equal((await stateOf(safari)).carry.ref, first.ref);
  const second = await carry(safari);
  assert.notEqual(second.ref, first.ref);
  assert.equal((await stateOf(safari)).carry.ref, second.ref, "the first tab's link is no longer the live one");
  assert.equal((await claim(phantom(), second.code)).ok, true);
  const st = await stateOf(safari);
  assert.equal(st.carry, undefined);
  assert.equal(st.carried.live, true);
});

test("F7: a carried sign-up that ends because the wallet already has an account: Safari learns it was a log-in, not that it ran out", async () => {
  const m = await journey(browser(env, PHONE_NET), box, { via: "google", sub: "g-member" });
  assert.equal(m.finish.ok, true);
  const safari = await safariAtWallet("g-newcomer");
  const app = phantom();
  assert.equal((await claim(app, (await carry(safari)).code)).ok, true);
  assert.equal((await doWallet(app, m.w)).next, "/dashboard", "the member's wallet signs that member in");
  assert.deepEqual((await stateOf(safari)).carried, { done: false, live: false, provider: null, login: true });
  assert.equal((await rows(env.DB, "SELECT * FROM signups")).length, 0);
});
