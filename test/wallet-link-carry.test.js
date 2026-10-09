// The "Open app" link on a phone (src/walletlink.js, the carry): Safari / Chrome, signed in to an account without a wallet, makes a
// one-time code that opens the link inside the wallet app's browser; that browser shows whose account it is, the person signs the
// link statement there, the account has the wallet, Safari's dashboard sees it, and the wallet app's browser is signed in too.
// Since 10 Oct 2026 (the owner's "phones live inside the wallet app") the FIRST browser that opens a code is its only opener: only it
// gets the statement and may claim (test/wallet-link-relay.test.js has the relay codes, the opener race and "here").
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, advance, browser, linkBody, loginBody, realClock, useClock, wallet } from "./helpers/world.js";
import { GOOD_PASSWORD, journey, linkDirect, member, one, outbox, rows, userOf } from "./helpers/signup.js";
import { buildMessage, parseMessage, statementFor } from "../src/solana.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const count = async (sql, ...p) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${sql}`, ...p)).n;
const near = { country: "US", latitude: 43.1, longitude: -75.2 };
const PHONE = { ip: "198.51.100.7", cf: { ...near, asn: 21928, asOrganization: "T-Mobile USA, Inc." } };          // Safari and the wallet app share it
const PHONE6 = { ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd", cf: PHONE.cf };                                           // the same phone over IPv6 ...
const PHONE6B = { ip: "2001:db8:1:2:1111:2222:3333:4444", cf: PHONE.cf };                                          // ... rotating inside its /64
const ELSEWHERE = { ip: "203.0.113.9", cf: { ...near, asn: 7922, asOrganization: "Comcast Cable" } };
const RELAY = { ip: "172.224.226.5", cf: { ...near, asn: 54113, asOrganization: "Fastly, Inc." } };

/** A member without a wallet, signed in from their phone's Safari. */
async function safariMember(net = PHONE, opts = {}) {
  const m = await member(env, box, { via: "google", net, ...opts });
  m.u = await userOf(env, m);
  return m;
}
const carry = (b) => b.send("/api/me/wallet/carry", { method: "POST", body: {} });
const info = (b, code) => b.send("/api/me/wallet/carry/info", { method: "POST", body: { code } });
const claim = async (b, code, w, handle, extra = {}) => b.send("/api/me/wallet/carry/claim", { method: "POST", body: { code, ...(await linkBody(w, handle)), ...extra } });
const status = async (b, ref) => (await b.send(`/api/me/wallet/carry/status?ref=${ref}`)).json();

test("the whole way: Safari makes the code, the wallet app's browser sees whose account it is, signs, and both browsers are the same person", async () => {
  const m = await safariMember();
  const made = await (await carry(m.b)).json();
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.match(made.code, /^[A-Za-z0-9_-]{32}$/, "192 random bits");
  assert.match(made.pin, /^[1-9][0-9]$/);
  assert.match(made.ref, /^[A-Za-z0-9_-]{12}$/);
  assert.ok(made.url.endsWith(`/connect?link=${made.code}`), made.url);
  assert.equal(made.expiresAt, new Date(Date.now() + 10 * 60_000).toISOString());
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "waiting" });
  const row = await one(env.DB, "SELECT * FROM handoffs");
  assert.deepEqual([row.kind, row.purpose, row.user_id, row.signup_id, row.result, row.wallet], ["carry", "link", m.u.id, null, null, null]);
  assert.ok(!row.id.includes(made.code) && row.id.length >= 40 && made.ref === row.id.slice(0, 12), "only a hash of the code is kept");
  assert.ok(!row.net.includes(PHONE.ip), "the connection is kept as a salted hash, never the address");

  // the wallet app's browser: own cookies, no session, same phone. The first browser that opens the code becomes its opener.
  const app = browser(env, PHONE);
  const seen = await info(app, made.code);
  const shown = await seen.json();
  assert.equal(seen.status, 200);
  assert.match(shown.opener, /^[A-Za-z0-9_-]{32}$/, "the opener nonce, for a wallet browser that drops cookies");
  assert.deepEqual(shown, { ok: true, pin: made.pin, owner: { name: `${m.u.name.slice(0, 2)}•••`, handle: m.u.handle, initial: m.u.name[0] }, community: { name: "Utica", country: "US" }, terms: "2026-10-01", expiresAt: made.expiresAt,
    relay: false, here: null, opener: shown.opener });
  // (MOVED, owner decision F4: the @username is shown in full on the confirm screen, as the signed statement names it; it reaches ONLY
  // the opener, which is the one browser that can get that statement anyway: a second browser gets nothing, below)
  assert.ok(!JSON.stringify(shown).includes(m.u.name) && !JSON.stringify(shown).includes(m.w.address), "the name masked, and no address anywhere");
  const vlo = seen.headers.getSetCookie().find((c) => c.startsWith("__Host-vlo="));
  assert.match(vlo, /^__Host-vlo=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/, "HttpOnly, Secure, host-only (no Domain)");
  assert.equal(vlo.split(";")[0].slice(11), shown.opener);
  const row1 = await one(env.DB, "SELECT opener, result FROM handoffs");
  assert.ok(row1.opener && !row1.opener.includes(shown.opener), "only a hash of the opener nonce is kept");
  assert.equal(row1.result, "opened");
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "opened" }, "Safari knows the link was opened");
  assert.equal(((await info(app, made.code)).status), 200, "looking twice from the same browser is fine: nothing was used");
  // (TIGHTENED: the statement used to go to anyone on the connection; now only to the opener) a second browser on the very same
  // connection gets nothing (statement and claim refused), and its try kills the code: it is tested on its own in wallet-link-relay
  // the statement the app signs names the owner (the server gives it to the opener: its cookie)
  const msg = parseMessage((await app.get(`/api/message?address=${m.w.address}&action=link&code=${made.code}`)).message);
  assert.equal(msg.statement, statementFor("link", { handle: m.u.handle }));
  const message = buildMessage({ ...msg, issuedAt: new Date(Date.now()).toISOString() }); // (rebuilt on the test clock: /api/message dates it with the real one)
  const r = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, address: m.w.address, message, signature: await m.w.sign(message) } });
  const body = await r.json();
  assert.deepEqual([r.status, body], [200, { ok: true, wallet: m.w.address, next: "/dashboard?linked=1" }]);
  assert.match(r.headers.getSetCookie().find((c) => c.startsWith("vs=")), /^vs=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/, "the wallet app's browser is signed in for 30 days");
  assert.ok(r.headers.getSetCookie().includes("__Host-vlo=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"), "the opener cookie is cleared");
  const how = await one(env.DB, "SELECT wallet_at, wallet_via, wallet_app FROM users WHERE id = ?", m.u.id);
  assert.deepEqual(how, { wallet_at: new Date(Date.now()).toISOString(), wallet_via: "app", wallet_app: null }, "when and how (no app named in this claim)");
  // the account has the wallet; Safari's session carries it (no proof there), the app's session is proven
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, m.w.address);
  const ss = await rows(env.DB, "SELECT wallet, proven_at FROM sessions WHERE user_id = ? ORDER BY created_at", m.u.id);
  assert.deepEqual(ss.map((s) => [s.wallet, Boolean(s.proven_at)]), [[m.w.address, false], [m.w.address, true]]);
  const appMe = await app.get("/api/me?lite=1");
  assert.deepEqual([appMe.signedIn, appMe.user.wallet, appMe.fresh], [true, m.w.address, true]);
  const safariMe = await m.b.get("/api/me?lite=1");
  assert.deepEqual([safariMe.signedIn, safariMe.user.wallet, safariMe.fresh], [true, m.w.address, false], "Safari's dashboard sees the wallet by itself; signing there is still needed for sensitive actions");
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "linked", wallet: m.w.address });
  // the code is used up
  assert.deepEqual([(await info(app, made.code)).status, (await claim(app, made.code, m.w, m.u.handle)).status], [410, 410]);
  assert.equal(await count("sessions WHERE user_id IS NULL"), 0);
});

test("only a signed-in member without a wallet gets a code; behind a relay only a RELAY code, for an app-link wallet with a known country (else carry_relay); a new code replaces the old one", async () => {
  assert.equal((await carry(browser(env, PHONE))).status, 401);
  const m = await safariMember();
  const r = await (await carry(m.b)).json();
  const again = await (await carry(m.b)).json();
  assert.notEqual(again.code, r.code);
  assert.deepEqual(await status(m.b, r.ref), { ok: true, status: "replaced" });
  assert.deepEqual(await status(m.b, again.ref), { ok: true, status: "waiting" });
  assert.equal(await count("handoffs"), 1, "one live code per person");
  assert.equal((await info(browser(env, PHONE), r.code)).status, 410, "the replaced code is dead");
  assert.equal((await m.b.send("/api/me/wallet/carry/status?ref=nope")).status, 400);
  // MOVED (owner decision F4, 10 Oct 2026): behind a relay (iCloud Private Relay, WARP) there used to be no code at all; now there is a
  // RELAY code (first opener + the same country + opened within 2 minutes: test/wallet-link-relay.test.js), only for a wallet app with a
  // real app link and a known country. Every other relay case still answers carry_relay (the page pairs, as before).
  const relay = await safariMember(RELAY, { sub: "g-relay" });
  for (const body of [{}, { app: "okx" }, { app: "nope" }]) {
    const no = await relay.b.send("/api/me/wallet/carry", { method: "POST", body });
    assert.deepEqual([no.status, (await no.json()).error], [409, "carry_relay"], JSON.stringify(body));
  }
  for (const country of ["XX", "T1", undefined, ""]) {
    const no = await relay.b.send("/api/me/wallet/carry", { method: "POST", body: { app: "phantom" }, cf: { ...RELAY.cf, country } });
    assert.deepEqual([no.status, (await no.json()).error], [409, "carry_relay"], `country ${country}`);
  }
  const vps = await relay.b.send("/api/me/wallet/carry", { method: "POST", body: { app: "phantom" }, cf: { ...RELAY.cf, asn: 63949, asOrganization: "Akamai Connected Cloud" } });
  assert.deepEqual([vps.status, (await vps.json()).error], [409, "carry_relay"], "a cloud server named Akamai is no relay for this: no unbound code from it");
  const yes = await (await relay.b.send("/api/me/wallet/carry", { method: "POST", body: { app: "phantom" } })).json();
  assert.deepEqual([yes.ok, yes.relay, yes.openBy], [true, true, new Date(Date.now() + 2 * 60_000).toISOString()]);
  assert.deepEqual(await one(env.DB, "SELECT net, country FROM handoffs WHERE user_id = ?", relay.u.id), { net: "relay", country: "US" });
  await linkDirect(env, m);
  const has = await carry(m.b);
  assert.deepEqual([has.status, (await has.json()).error], [409, "has_wallet"]);
  assert.deepEqual(await status(m.b, again.ref), { ok: true, status: "linked", wallet: m.w.address }, "whatever the code, a linked wallet is the answer");
});

test("the code works only from the connection that made it (the same IPv4 address, or the same IPv6 /64), once, for 10 minutes", async () => {
  const m = await safariMember(PHONE6);
  const made = await (await carry(m.b)).json();
  const elsewhere = browser(env, ELSEWHERE);
  assert.deepEqual([(await info(elsewhere, made.code)).status, (await (await info(elsewhere, made.code)).json()).error], [403, "carry_network"]);
  assert.deepEqual([(await claim(elsewhere, made.code, m.w, m.u.handle)).status], [403]);
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "refused" }, "Safari: the wallet app opened it on another connection (Wi-Fi vs mobile data?)");
  const same64 = browser(env, PHONE6B);
  assert.equal((await info(same64, made.code)).status, 200, "the phone rotated inside its /64: still the same phone");
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "opened" });
  const made4 = await (await carry((await safariMember(PHONE, { sub: "g-v4" })).b)).json();
  assert.equal((await info(same64, made4.code)).status, 403, "an IPv4 code is not an IPv6 one");
  // made-up and malformed codes
  for (const code of ["short", "x".repeat(32), made.code.slice(0, -1) + (made.code.endsWith("A") ? "B" : "A"), 42, null]) {
    assert.equal((await info(same64, code)).status, 410, String(code));
  }
  advance(10 * 60_000 + 1);
  assert.deepEqual([(await info(same64, made.code)).status, (await (await info(same64, made.code)).json()).error], [410, "carry_expired"]);
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "expired" });
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, null);
});

test("the claim needs the link statement with the owner's name and a real signature; a login statement, another name, a replay, a stranger's session are refused; nothing changes on a refusal", async () => {
  const m = await safariMember();
  // a browser signed in as somebody else opens the code and claims: refused BEFORE the signature is used, the code untouched
  const other = await member(env, box, { via: "email", net: PHONE });
  const first = await (await carry(m.b)).json();
  assert.equal((await info(other.b, first.code)).status, 200);
  const asOther = await claim(other.b, first.code, m.w, m.u.handle);
  assert.deepEqual([asOther.status, (await asOther.json()).error], [409, "already_signed_in"]);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, null);
  assert.equal(await count("sessions"), 2);
  assert.equal(await count("handoffs WHERE result = 'opened' AND wallet IS NULL"), 1, "the code is still unused");
  // (the claim needs the opener since 10 Oct 2026: the wallet app's browser opens the new code first)
  const made = await (await carry(m.b)).json();
  const app = browser(env, PHONE);
  assert.equal((await info(app, made.code)).status, 200);
  const refused = async (body, error, status = 400) => {
    const r = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...body } });
    assert.deepEqual([r.status, (await r.json()).error], [status, error], error);
  };
  await refused(await loginBody(m.w), "bad_message");
  await refused(await linkBody(m.w, "SomebodyElse1"), "bad_message");
  await refused(await linkBody(m.w, m.u.handle, "47"), "bad_message");
  const good = await linkBody(m.w, m.u.handle);
  await refused({ ...good, signature: good.signature.slice(0, -4) + "AAAA" }, "signature_mismatch", 401);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, null);
  assert.equal(await count("handoffs WHERE result = 'opened'"), 1, "the code is still unused");
  // a wallet that already belongs to another account: wallet_taken, the code stays usable
  const owner = await member(env, box, { via: "email", email: "owner@example.com" });
  await linkDirect(env, owner);
  const taken = await claim(app, made.code, owner.w, m.u.handle);
  assert.deepEqual([taken.status, (await taken.json()).error], [409, "wallet_taken"]);
  assert.equal((await info(app, made.code)).status, 200);
  // the right signature works once; the same signed message again is a replay, and the code is spent anyway
  const r = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...good } });
  assert.equal(r.status, 200);
  const replay = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...good } });
  assert.ok([409, 410].includes(replay.status), String(replay.status));
  assert.equal(await count("users WHERE wallet = ?", m.w.address), 1);
});

test("the owner linked a wallet meanwhile (another browser): link_done, and the wallet app's browser gets nothing; the owner's own earlier session in that browser is replaced", async () => {
  const m = await safariMember();
  const made = await (await carry(m.b)).json();
  const app = browser(env, PHONE);
  assert.equal((await info(app, made.code)).status, 200);
  await linkDirect(env, m); // linked from a computer in the meantime
  const r = await claim(app, made.code, await wallet(), m.u.handle);
  assert.deepEqual([r.status, (await r.json()).error], [409, "link_done"]);
  assert.deepEqual([(await info(app, made.code)).status, (await (await info(app, made.code)).json()).error], [409, "link_done"]);
  assert.equal(app.has("vs"), false);

  // the same person is already signed in inside the wallet app's browser (an old session there): the claim replaces it
  const n = await safariMember(PHONE, { sub: "g-two" });
  const code2 = (await (await carry(n.b)).json()).code;
  const app2 = browser(env, PHONE);
  assert.equal((await app2.post("/api/auth/email/login", { email: "x@example.com", password: GOOD_PASSWORD })).ok, false);
  app2.jar.set("vs", n.b.jar.get("vs")); // the very same session cookie copied over (same person)
  assert.equal((await (await info(app2, code2)).json()).here, null, "signed in as the owner: nothing to warn about");
  const before = await count("sessions WHERE user_id = ?", n.u.id);
  const ok = await claim(app2, code2, n.w, n.u.handle);
  assert.equal(ok.status, 200);
  assert.notEqual(app2.jar.get("vs"), n.b.jar.get("vs"), "a new token for the wallet app's browser");
  assert.equal(await count("sessions WHERE user_id = ?", n.u.id), before, "the copied session is gone, the new one is there");
  assert.equal((await n.b.get("/api/me?lite=1")).signedIn, false, "Safari held the replaced token: it logs in again (a cookie copied between browsers is not the normal way)");
});

test("logging out in Safari kills a pending code: the wallet app's claim is refused (carry_expired), nothing linked, no session there; the next login starts clean", async () => {
  const m = await safariMember();
  const made = await (await carry(m.b)).json();
  const app = browser(env, PHONE);
  assert.equal((await info(app, made.code)).status, 200, "opened in the wallet app...");
  assert.equal((await m.b.send("/api/auth/logout", { method: "POST", body: {} })).status, 200, "...then the person signs out of Safari");
  assert.equal(await count("handoffs WHERE user_id = ? AND (result IS NULL OR result = 'opened')", m.u.id), 0, "the live code died with the session");
  const r = await claim(app, made.code, m.w, m.u.handle);
  assert.deepEqual([r.status, (await r.json()).error], [410, "carry_expired"]);
  assert.equal(app.has("vs"), false, "no session was minted in the wallet app");
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, null);
  assert.equal(await count("sessions WHERE user_id = ?", m.u.id), 0);
  // a code that was never opened dies the same way
  const again = await safariMember(PHONE6);
  const made2 = await (await carry(again.b)).json();
  await again.b.send("/api/auth/logout", { method: "POST", body: {} });
  assert.deepEqual([(await info(browser(env, PHONE6), made2.code)).status, await count("handoffs WHERE user_id = ?", again.u.id)], [410, 0]);
});

test("a refused claim leaves the wallet app's browser as it was: the owner's own session there survives wallet_taken, and is replaced only by a claim that went through", async () => {
  const owner = await linkDirect(env, await member(env, box, { via: "google", net: ELSEWHERE })); // owner.w belongs to another account
  const m = await safariMember(PHONE, { via: "email" });
  const made = await (await carry(m.b)).json();
  const app = browser(env, PHONE);
  assert.equal((await app.post("/api/auth/email/login", { email: m.email, password: GOOD_PASSWORD })).ok, true, "the same person is logged in inside the wallet app already");
  const token = app.jar.get("vs");
  assert.equal((await info(app, made.code)).status, 200);
  const taken = await claim(app, made.code, owner.w, m.u.handle);
  assert.deepEqual([taken.status, (await taken.json()).error], [409, "wallet_taken"]);
  assert.deepEqual(taken.headers.getSetCookie(), [], "no cookie change on a refusal");
  assert.equal(app.jar.get("vs"), token);
  assert.equal((await app.get("/api/me?lite=1")).signedIn, true, "still logged in there");
  assert.equal(await count("sessions WHERE user_id = ?", m.u.id), 2, "Safari's and the app's: nothing dropped");
  assert.equal((await one(env.DB, "SELECT result FROM handoffs WHERE user_id = ?", m.u.id)).result, "opened", "the code is still usable");
  // the right wallet goes through: the app gets a new session and its earlier one is gone
  const ok = await claim(app, made.code, m.w, m.u.handle);
  assert.equal(ok.status, 200);
  assert.notEqual(app.jar.get("vs"), token);
  assert.equal(await count("sessions WHERE user_id = ?", m.u.id), 2, "Safari's and the app's new one; the app's earlier session was replaced");
  assert.equal((await app.get("/api/me?lite=1")).user.wallet, m.w.address);
});

test("limits: ten codes an hour per person, sixty looks and thirty claims an hour per connection; the old sign-up carry routes are gone", async () => {
  const m = await safariMember();
  let last;
  for (let i = 0; i < 11; i++) last = await carry(m.b);
  assert.deepEqual([last.status, (await last.json()).error], [429, "slow_down"]);
  const code = (await (await carry((await safariMember(PHONE, { sub: "g-looks" })).b)).json()).code;
  const app = browser(env, PHONE);
  for (let i = 0; i < 60; i++) assert.equal((await info(app, code)).status, 200, `look ${i + 1}`);
  assert.equal((await info(app, code)).status, 429);
  const other = browser(env, PHONE6);
  for (let i = 0; i < 30; i++) assert.equal((await claim(other, "x".repeat(40), m.w, m.u.handle)).status, 410, `claim ${i + 1}`);
  assert.equal((await claim(other, "x".repeat(40), m.w, m.u.handle)).status, 429);
  for (const path of ["/api/signup/carry", "/api/signup/carry/info", "/api/signup/carry/claim"]) {
    assert.equal((await m.b.send(path, { method: "POST", body: {} })).status, 404, path);
  }
  const anon = browser(env, PHONE);
  await journey(anon, box, { via: "email", until: "terms" });
  assert.equal((await anon.send("/api/signup/state")).status, 200);
  assert.equal((await anon.get("/api/signup/state")).state.carry, undefined, "the sign-up state has no carry any more");
});
