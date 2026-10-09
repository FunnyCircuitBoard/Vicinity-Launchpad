// The "Open app" link on a phone (src/walletlink.js, the carry): Safari / Chrome, signed in to an account without a wallet, makes a
// one-time code that opens the link inside the wallet app's browser; that browser shows whose account it is, the person signs the
// link statement there, the account has the wallet, Safari's dashboard sees it, and the wallet app's browser is signed in too.
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

  // the wallet app's browser: own cookies, no session, same phone
  const app = browser(env, PHONE);
  const seen = await info(app, made.code);
  const shown = await seen.json();
  assert.equal(seen.status, 200);
  assert.deepEqual(shown, { ok: true, pin: made.pin, owner: { name: `${m.u.name.slice(0, 2)}•••`, handle: `${m.u.handle.slice(0, 2)}•••`, initial: m.u.name[0] }, community: { name: "Utica", country: "US" }, terms: "2026-10-01", expiresAt: made.expiresAt });
  assert.ok(!JSON.stringify(shown).includes(m.u.handle) && !JSON.stringify(shown).includes(m.w.address), "masked, and no address anywhere");
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "opened" }, "Safari knows the link was opened");
  assert.equal(((await info(app, made.code)).status), 200, "looking twice is fine: nothing was used");
  // the statement the app signs names the owner (the server gives it to the code holder, no cookie needed)
  const msg = parseMessage((await app.get(`/api/message?address=${m.w.address}&action=link&code=${made.code}`)).message);
  assert.equal(msg.statement, statementFor("link", { handle: m.u.handle }));
  const message = buildMessage({ ...msg, issuedAt: new Date(Date.now()).toISOString() }); // (rebuilt on the test clock: /api/message dates it with the real one)
  const r = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, address: m.w.address, message, signature: await m.w.sign(message) } });
  const body = await r.json();
  assert.deepEqual([r.status, body], [200, { ok: true, wallet: m.w.address, next: "/dashboard?linked=1" }]);
  assert.match(r.headers.getSetCookie().find((c) => c.startsWith("vs=")), /^vs=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/, "the wallet app's browser is signed in for 30 days");
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

test("only a signed-in member without a wallet gets a code; behind a relay there is none (carry_relay); a new code replaces the old one", async () => {
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
  const relay = await safariMember(RELAY, { sub: "g-relay" });
  const no = await carry(relay.b);
  assert.deepEqual([no.status, (await no.json()).error], [409, "carry_relay"]);
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
  const same64 = browser(env, PHONE6B);
  assert.equal((await info(same64, made.code)).status, 200, "the phone rotated inside its /64: still the same phone");
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
  const made = await (await carry(m.b)).json();
  const app = browser(env, PHONE);
  const refused = async (body, error, status = 400) => {
    const r = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...body } });
    assert.deepEqual([r.status, (await r.json()).error], [status, error], error);
  };
  await refused(await loginBody(m.w), "bad_message");
  await refused(await linkBody(m.w, "SomebodyElse1"), "bad_message");
  await refused(await linkBody(m.w, m.u.handle, "47"), "bad_message");
  const good = await linkBody(m.w, m.u.handle);
  await refused({ ...good, signature: good.signature.slice(0, -4) + "AAAA" }, "signature_mismatch", 401);
  // a browser signed in as somebody else cannot claim for this account
  const other = await member(env, box, { via: "email", net: PHONE });
  const asOther = await claim(other.b, made.code, m.w, m.u.handle);
  assert.deepEqual([asOther.status, (await asOther.json()).error], [409, "already_signed_in"]);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, null);
  assert.equal(await count("sessions"), 2);
  assert.equal(await count("handoffs WHERE result IS NULL"), 1, "the code is still unused");
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
  const before = await count("sessions WHERE user_id = ?", n.u.id);
  const ok = await claim(app2, code2, n.w, n.u.handle);
  assert.equal(ok.status, 200);
  assert.notEqual(app2.jar.get("vs"), n.b.jar.get("vs"), "a new token for the wallet app's browser");
  assert.equal(await count("sessions WHERE user_id = ?", n.u.id), before, "the copied session is gone, the new one is there");
  assert.equal((await n.b.get("/api/me?lite=1")).signedIn, false, "Safari held the replaced token: it logs in again (a cookie copied between browsers is not the normal way)");
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
