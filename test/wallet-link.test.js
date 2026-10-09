// The wallet link (src/walletlink.js) and THE ONE RULE for a proven wallet (src/auth.js walletProven): an account made with
// Google or an e-mail links a wallet later, from the dashboard, with one signed "link" statement that names the account; the
// same rule covers a signed login message, a pairing a phone approved and a found tiny transfer.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, advance, browser, linkBody, loginBody, realClock, useClock, wallet } from "./helpers/world.js";
import { GOOD_PASSWORD, linkDirect, member, memberWithWallet, one, outbox, rows, userOf } from "./helpers/signup.js";
import { buildMessage, parseMessage, statementFor } from "../src/solana.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const count = async (sql, ...p) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${sql}`, ...p)).n;
const sessionsOf = (userId) => rows(env.DB, "SELECT wallet, proven_at FROM sessions WHERE user_id = ? ORDER BY created_at", userId);
/** The same person signed in from a second browser (the password log-in). */
async function secondBrowser(m) {
  const c = browser(env);
  const r = await c.post("/api/auth/email/login", { email: m.email, password: GOOD_PASSWORD });
  assert.equal(r.ok, true, JSON.stringify(r));
  return c;
}

test("the link statement names the account, in a plain and a check-number variant, and is not a login statement", () => {
  assert.equal(statementFor("link", { handle: "SwiftHarbor10" }), "Link this wallet to my Vicinity account @SwiftHarbor10. Free, not a transaction, cannot move funds.");
  assert.equal(statementFor("link", { handle: "SwiftHarbor10", pin: "47" }), "Link this wallet to my Vicinity account @SwiftHarbor10 on my other device (check number 47). Free, not a transaction, cannot move funds.");
  const msg = (statement) => ["vicinity.city wants you to sign in with your Solana account:", "11111111111111111111111111111111", "", statement, "", "URI: https://vicinity.city", "Version: 1", "Chain ID: mainnet", "Nonce: abcdefghijklmnop", "Issued At: 2026-10-01T12:00:00.000Z"].join("\n");
  assert.deepEqual((({ action, handle, pin }) => ({ action, handle, pin }))(parseMessage(msg(statementFor("link", { handle: "Ada_9" })))), { action: "link", handle: "Ada_9", pin: undefined });
  assert.deepEqual((({ action, handle, pin }) => ({ action, handle, pin }))(parseMessage(msg(statementFor("link", { handle: "Ada_9", pin: "08" })))), { action: "link", handle: "Ada_9", pin: "08" });
  assert.equal(parseMessage(msg(statementFor("login"))).action, "login");
  for (const bad of ["Link this wallet to my Vicinity account @. Free, not a transaction, cannot move funds.", "Link this wallet to my Vicinity account @9abc. Free, not a transaction, cannot move funds.",
    "Link this wallet to my Vicinity account @Ada_9 (check number 08). Free, not a transaction, cannot move funds.", "Link this wallet to my Vicinity account @Ada_9. Free, not a transaction."]) {
    assert.equal(parseMessage(msg(bad)), null, bad);
  }
});

test("POST /api/me/wallet/link: the account takes the wallet, every session of the person carries it, only the one that signed is proven", async () => {
  const m = await member(env, box, { via: "email" });
  const u = await userOf(env, m);
  const c = await secondBrowser(m);
  assert.equal((await c.get("/api/me?lite=1")).fresh, true, "a wallet-less login is fresh for 30 minutes");
  advance(5 * 60_000);
  const r = await m.b.send("/api/me/wallet/link", { method: "POST", body: await linkBody(m.w, u.handle) });
  const body = await r.json();
  assert.deepEqual([r.status, body.ok, body.wallet, body.fresh, body.provenAt], [200, true, m.w.address, true, new Date(Date.now()).toISOString()], JSON.stringify(body));
  assert.deepEqual(r.headers.getSetCookie(), [], "the session stays the same: no new cookie");
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, m.w.address);
  assert.deepEqual(await one(env.DB, "SELECT wallet_at, wallet_via, wallet_app FROM users WHERE id = ?", u.id), { wallet_at: new Date(Date.now()).toISOString(), wallet_via: "page", wallet_app: null },
    "when and how: signed in this very browser (no 'Wasn't you?' for it)");
  assert.equal((await m.b.get("/api/me")).walletNew, undefined);
  const ss = await sessionsOf(u.id);
  assert.equal(ss.length, 2);
  assert.deepEqual(ss.map((s) => s.wallet), [m.w.address, m.w.address], "both browsers see the wallet");
  assert.deepEqual(ss.map((s) => Boolean(s.proven_at)), [true, false], "only the browser that signed holds the proof");
  const mine = await m.b.get("/api/me?lite=1");
  assert.deepEqual([mine.user.wallet, mine.fresh], [m.w.address, true]);
  const other = await c.get("/api/me?lite=1");
  assert.deepEqual([other.user.wallet, other.fresh], [m.w.address, false], "with a wallet on the account only a wallet proof is fresh");
  const full = await m.b.get("/api/me");
  assert.deepEqual([full.setup.percent, full.badges.find((b) => b.id === "wallet").earned], [100, true]);
  advance(31 * 60_000);
  assert.equal((await m.b.get("/api/me?lite=1")).fresh, false);
});

test("linking again is idempotent (and renews the proof); another wallet is has_wallet; somebody else's wallet is wallet_taken; nothing changes on a refusal", async () => {
  const m = await member(env, box, { via: "email" });
  const u = await userOf(env, m);
  assert.equal((await m.b.post("/api/me/wallet/link", await linkBody(m.w, u.handle))).ok, true);
  advance(10 * 60_000);
  const again = await m.b.post("/api/me/wallet/link", await linkBody(m.w, u.handle));
  assert.deepEqual([again.ok, again.wallet, again.provenAt], [true, m.w.address, new Date(Date.now()).toISOString()]);
  const other = await m.b.send("/api/me/wallet/link", { method: "POST", body: await linkBody(await wallet(), u.handle) });
  assert.equal(other.status, 409);
  assert.deepEqual(await other.json(), { ok: false, error: "has_wallet", wallet: `${m.w.address.slice(0, 4)}…${m.w.address.slice(-4)}` });
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, m.w.address);

  const n = await member(env, box, { via: "google" });
  const nu = await userOf(env, n);
  const taken = await n.b.send("/api/me/wallet/link", { method: "POST", body: await linkBody(m.w, nu.handle) });
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { ok: false, error: "wallet_taken" });
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", nu.id)).wallet, null);
  assert.deepEqual((await sessionsOf(nu.id)).map((s) => [s.wallet, s.proven_at]), [[null, null]]);
  assert.equal((await n.b.get("/api/me?lite=1")).signedIn, true, "the refusal never drops the session");
});

test("the wrong statement is refused: a login message, another account's name, the check-number variant, a replay, and nobody signed in", async () => {
  const m = await member(env, box, { via: "email" });
  const u = await userOf(env, m);
  const refused = async (body, error, status = 400) => {
    const r = await m.b.send("/api/me/wallet/link", { method: "POST", body });
    assert.deepEqual([r.status, (await r.json()).error], [status, error]);
  };
  await refused(await loginBody(m.w), "bad_message");
  await refused(await linkBody(m.w, "SomebodyElse1"), "bad_message");
  await refused(await linkBody(m.w, u.handle, "47"), "bad_message");
  const good = await linkBody(m.w, u.handle);
  assert.equal((await m.b.post("/api/me/wallet/link", good)).ok, true);
  await refused(good, "replayed", 409);
  await refused({ address: m.w.address, message: good.message, signature: "not base64!" }, "bad_signature");
  await refused({ address: m.w.address, message: good.message, signature: "AAAA" }, "signature_mismatch", 401);
  await refused({ ...good, address: (await wallet()).address }, "address_mismatch");
  const anon = browser(env);
  const r = await anon.send("/api/me/wallet/link", { method: "POST", body: await linkBody(m.w, u.handle) });
  assert.deepEqual([r.status, (await r.json()).error], [401, "sign_in"]);
  assert.equal((await browser(env).send("/api/me/wallet/link", { method: "GET" })).status, 405);
  const foreign = await m.b.send("/api/me/wallet/link", { method: "POST", body: good, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal((await m.b.send("/api/me/wallet/nothing", { method: "POST", body: {} })).status, 404);
});

test("GET /api/message?action=link gives the signed-in person the statement with their own username, and nobody else anything", async () => {
  const m = await member(env, box, { via: "google" });
  const u = await userOf(env, m);
  const r = await m.b.get(`/api/message?address=${m.w.address}&action=link`);
  assert.equal(parseMessage(r.message).statement, statementFor("link", { handle: u.handle }));
  const pinned = await m.b.get(`/api/message?address=${m.w.address}&action=link&pin=47`);
  assert.equal(parseMessage(pinned.message).statement, statementFor("link", { handle: u.handle, pin: "47" }));
  const anon = await browser(env).send(`/api/message?address=${m.w.address}&action=link`);
  assert.deepEqual([anon.status, (await anon.json()).error], [401, "sign_in"]);
  assert.equal((await m.b.send(`/api/message?address=${m.w.address}&action=link&pin=4`)).status, 400);
  // and the statement the server hands out does link (the message is rebuilt on the test clock: /api/message dates it with the real one)
  const signed = parseMessage((await m.b.get(`/api/message?address=${m.w.address}&action=link`)).message);
  const message = buildMessage({ ...signed, issuedAt: new Date(Date.now()).toISOString() });
  assert.equal((await m.b.post("/api/me/wallet/link", { address: m.w.address, message, signature: await m.w.sign(message) })).ok, true);
});

test("the one rule on /api/auth/wallet: signed in without a wallet, a LOGIN signature links nothing (use_link); a LINK signature links it and the session stays; the same wallet re-proves; another wallet is wrong_wallet", async () => {
  const m = await member(env, box, { via: "email" });
  const u = await userOf(env, m);
  const token = m.b.jar.get("vs");
  // a login statement promised a sign-in, not a binding to an account: it links nothing, whoever submits it
  const asLogin = await m.b.send("/api/auth/wallet", { method: "POST", body: await loginBody(m.w) });
  assert.deepEqual([asLogin.status, await asLogin.json()], [400, { ok: false, error: "use_link" }]);
  assert.deepEqual(asLogin.headers.getSetCookie(), []);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, null, "nothing linked");
  assert.equal((await m.b.get("/api/me?lite=1")).signedIn, true, "and the member is still signed in");
  const r = await m.b.send("/api/auth/wallet", { method: "POST", body: await linkBody(m.w, u.handle) });
  const body = await r.json();
  assert.deepEqual([r.status, body.ok, body.linked, body.wallet, body.next, body.fresh], [200, true, true, m.w.address, "/dashboard?linked=1", true], JSON.stringify(body));
  assert.deepEqual(r.headers.getSetCookie(), [], "no new session");
  assert.equal(m.b.jar.get("vs"), token);
  assert.equal(await count("sessions WHERE user_id = ?", u.id), 1, "the member's session was never dropped");
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, m.w.address);
  assert.equal((await one(env.DB, "SELECT wallet_via FROM users WHERE id = ?", u.id)).wallet_via, "page");

  advance(10 * 60_000);
  const again = await m.b.post("/api/auth/wallet", await loginBody(m.w));
  assert.deepEqual([again.ok, again.reproven, again.next, again.provenAt], [true, true, "/dashboard", new Date(Date.now()).toISOString()]);
  assert.equal((await one(env.DB, "SELECT proven_at FROM sessions WHERE user_id = ?", u.id)).proven_at, new Date(Date.now()).toISOString());
  const w2 = await wallet();
  const wrong = await m.b.send("/api/auth/wallet", { method: "POST", body: await loginBody(w2) });
  assert.deepEqual([wrong.status, (await wrong.json()).error], [403, "wrong_wallet"]);
  assert.equal((await m.b.get("/api/me?lite=1")).user.wallet, m.w.address, "still signed in, still the same wallet");

  // the link signature on the same route, for a second person
  const n = await member(env, box, { via: "google" });
  const nu = await userOf(env, n);
  const l = await n.b.post("/api/auth/wallet", await linkBody(n.w, nu.handle));
  assert.deepEqual([l.ok, l.linked, l.next], [true, true, "/dashboard?linked=1"]);
  // a link signature for another account's name, or by nobody, links nothing
  const p = await member(env, box, { via: "google" });
  const bad = await p.b.send("/api/auth/wallet", { method: "POST", body: await linkBody(p.w, nu.handle) });
  assert.deepEqual([bad.status, (await bad.json()).error], [400, "bad_message"]);
  const anon = await browser(env).send("/api/auth/wallet", { method: "POST", body: await linkBody(await wallet(), nu.handle) });
  assert.deepEqual([anon.status, (await anon.json()).error], [401, "sign_in"]);
  assert.equal(await count("users WHERE wallet IS NOT NULL"), 2);
});

test("a phished login signature cannot capture a wallet: submitted from an attacker's own wallet-less account it is use_link, the wallet stays free, and later links to its real owner", async () => {
  // the attacker: a member without a wallet, logged in; the victim's wallet signed "Sign in to Vicinity with this wallet." somewhere
  const attacker = await member(env, box, { via: "google" });
  const victim = await wallet();
  const r = await attacker.b.send("/api/auth/wallet", { method: "POST", body: await loginBody(victim) });
  assert.deepEqual([r.status, (await r.json()).error], [400, "use_link"]);
  assert.equal(await count("users WHERE wallet = ?", victim.address), 0, "the wallet belongs to nobody");
  // the same signature cannot be replayed as a link either (a link needs the LINK statement with the attacker's own name, which the victim never signed)
  assert.equal((await attacker.b.send("/api/auth/wallet", { method: "POST", body: await loginBody(victim) })).status, 400);
  // the victim keeps the wallet: their own account links it with the link statement; the attacker's account is still wallet-less
  const owner = await member(env, box, { via: "email" });
  const ou = await userOf(env, owner);
  assert.equal((await owner.b.post("/api/auth/wallet", await linkBody(victim, ou.handle))).linked, true);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", (await userOf(env, attacker)).id)).wallet, null);
  // and that wallet alone now signs in as the owner, nobody else
  const anon = browser(env);
  assert.equal((await anon.post("/api/auth/wallet", await loginBody(victim))).next, "/dashboard");
  assert.equal((await anon.get("/api/me?lite=1")).user.id, ou.id);
});

test("a link pairing: Safari (or a computer) asks with purpose link, the wallet app approves with the link statement and the check number, Safari finishes and the account has the wallet; the app gets no session", async () => {
  const m = await member(env, box, { via: "google" });
  const u = await userOf(env, m);
  const pair = await m.b.post("/api/pair", { purpose: "link" });
  assert.deepEqual([pair.ok, pair.purpose, pair.url.endsWith(`/connect?pair=${pair.code}`)], [true, "link", true]);
  assert.match(pair.pin, /^[1-9][0-9]$/);
  const phone = browser(env);
  const seen = await phone.get(`/api/pair?code=${pair.code}`);
  assert.deepEqual(seen, { status: "waiting", pin: pair.pin, purpose: "link", name: `${u.name.slice(0, 1)}•••`.replace(/^(.)(•••)$/, (s, a) => (Array.from(u.name).length > 3 ? u.name.slice(0, 2) + "•••" : a + "•••")), handle: `${u.handle.slice(0, 2)}•••`, community: { name: "Utica", country: "US" }, terms: "2026-10-01" });
  assert.ok(!JSON.stringify(seen).includes(u.handle), "the username is shown masked");
  // a login signature cannot approve a link pairing; a link signature for another account cannot either
  const asLogin = await phone.send("/api/auth/wallet", { method: "POST", body: { ...(await loginBody(m.w, pair.pin)), pair: pair.code } });
  assert.deepEqual([asLogin.status, (await asLogin.json()).error], [400, "bad_message"]);
  const asOther = await phone.send("/api/auth/wallet", { method: "POST", body: { ...(await linkBody(m.w, "SomebodyElse1", pair.pin)), pair: pair.code } });
  assert.deepEqual([asOther.status, (await asOther.json()).error], [400, "bad_message"]);
  const wrongPin = await phone.send("/api/auth/wallet", { method: "POST", body: { ...(await linkBody(m.w, u.handle, pair.pin === "10" ? "11" : "10")), pair: pair.code } });
  assert.deepEqual([wrongPin.status, (await wrongPin.json()).error], [400, "pin_mismatch"]);
  // the statement the app gets from the server carries the owner's name and the check number (rebuilt on the test clock)
  const msg = parseMessage((await phone.get(`/api/message?address=${m.w.address}&action=link&pin=${pair.pin}&pair=${pair.code}`)).message);
  assert.equal(msg.statement, statementFor("link", { handle: u.handle, pin: pair.pin }));
  const message = buildMessage({ ...msg, issuedAt: new Date(Date.now()).toISOString() });
  assert.equal((await m.b.post("/api/pair/finish", { code: pair.code })).status, "waiting");
  const ok = await phone.post("/api/auth/wallet", { address: m.w.address, message, signature: await m.w.sign(message), pair: pair.code });
  assert.deepEqual(ok, { ok: true, paired: true });
  assert.equal((await phone.get(`/api/pair?code=${pair.code}`)).status, "ready");
  assert.equal(phone.has("vs"), false, "the wallet app's browser only approved: no session there");
  // only the account's own browser finishes it: a stranger, or nobody, gets nothing
  const stranger = await member(env, box, { via: "email" });
  assert.equal((await stranger.b.send("/api/pair/finish", { method: "POST", body: { code: pair.code } })).status, 410);
  assert.equal((await browser(env).send("/api/pair/finish", { method: "POST", body: { code: pair.code } })).status, 410);
  const fin = await m.b.post("/api/pair/finish", { code: pair.code });
  assert.deepEqual([fin.ok, fin.status, fin.linked, fin.wallet, fin.next], [true, "done", true, m.w.address, "/dashboard?linked=1"], JSON.stringify(fin));
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, m.w.address);
  assert.deepEqual(await one(env.DB, "SELECT wallet_at, wallet_via FROM users WHERE id = ?", u.id), { wallet_at: new Date(Date.now()).toISOString(), wallet_via: "pair" },
    "a wallet app approved it (whoever held the code could have): the account's older browsers may say 'Wasn't you?' for 7 days");
  assert.deepEqual((await sessionsOf(u.id)).map((s) => [s.wallet, Boolean(s.proven_at)]), [[m.w.address, true]]);
  assert.equal(await count("pairs"), 0, "the pairing is used up");
  assert.equal((await m.b.post("/api/pair/finish", { code: pair.code })).status, "expired");
  // who may ask for a link pairing
  assert.deepEqual([(await browser(env).send("/api/pair", { method: "POST", body: { purpose: "link" } })).status, (await m.b.send("/api/pair", { method: "POST", body: { purpose: "link" } })).status,
    (await m.b.send("/api/pair", { method: "POST", body: { purpose: "steal" } })).status], [401, 409, 400], "nobody signed in / a wallet already / a made-up purpose");
});

test("a login pairing never links and a signed-in person cannot finish one; a link pairing never signs anyone in", async () => {
  // a member without a wallet made a LOGIN pairing (an old page, say): the phone approves an unknown wallet with it
  const m = await member(env, box, { via: "email" });
  const u = await userOf(env, m);
  const login = await m.b.post("/api/pair");
  assert.equal(login.purpose, "login");
  const phone = browser(env);
  assert.deepEqual(await phone.post("/api/auth/wallet", { ...(await loginBody(m.w, login.pin)), pair: login.code }), { ok: true, paired: true });
  const fin = await m.b.send("/api/pair/finish", { method: "POST", body: { code: login.code } });
  assert.deepEqual([fin.status, (await fin.json()).status], [410, "expired"], "a login pairing does not link while signed in");
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, null);
  assert.equal((await m.b.get("/api/me?lite=1")).signedIn, true, "and the member's session was not touched");
  // ... and finished by a browser that is not signed in it is the rule for a wallet nobody owns: no account, nothing made
  const anon = browser(env);
  const r = await anon.send("/api/pair/finish", { method: "POST", body: { code: login.code } });
  assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: "no_account" }]);
  assert.deepEqual(r.headers.getSetCookie(), []);
  assert.equal(await count("pairs"), 0, "used up all the same");
  assert.equal(await count("sessions WHERE user_id IS NULL"), 0);

  // a LINK pairing approved by a wallet that has an account: it links nothing elsewhere and signs nobody in
  const owner = await memberWithWallet(env, box, { via: "google" });
  const n = await member(env, box, { via: "google" });
  const nu = await userOf(env, n);
  const link = await n.b.post("/api/pair", { purpose: "link" });
  assert.deepEqual(await phone.post("/api/auth/wallet", { ...(await linkBody(owner.w, nu.handle, link.pin)), pair: link.code }), { ok: true, paired: true });
  const taken = await n.b.send("/api/pair/finish", { method: "POST", body: { code: link.code } });
  assert.deepEqual([taken.status, (await taken.json()).error], [409, "wallet_taken"]);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", nu.id)).wallet, null);
  assert.equal((await n.b.get("/api/me?lite=1")).signedIn, true);
  assert.equal(await count("sessions WHERE user_id IS NOT NULL"), 3, "nobody got a session out of it");
});

test("the tiny transfer under the one rule: signed in without a wallet, { link: true } keeps the session and the found transfer links; a stranger's unknown wallet is no_account", async () => {
  const m = await member(env, box, { via: "email" });
  const u = await userOf(env, m);
  const token = m.b.jar.get("vs");
  const start = await m.b.post("/api/auth/transfer", { address: m.w.address, link: true });
  assert.deepEqual([start.ok, start.link, start.reprove], [true, true, false], JSON.stringify(start));
  assert.equal(m.b.jar.get("vs"), token, "the session stays");
  let sent = null;
  const chain = async (_u, init) => {
    const { method } = JSON.parse(init.body);
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getSignaturesForAddress") return ok(sent ? [{ signature: "sig1", err: null, blockTime: Math.floor(Date.now() / 1000) }] : []);
    if (method === "getTransaction") return ok({ meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [
      { program: "system", parsed: { type: "transfer", info: { source: sent.from, destination: sent.from, lamports: sent.lamports } } }] } } });
    throw new Error("unexpected " + method);
  };
  const check = (b) => b.send("/api/auth/transfer/check", { method: "POST", body: {}, fetchImpl: chain });
  assert.equal((await (await check(m.b)).json()).error, "not_found_yet");
  await env.DB.prepare("UPDATE sessions SET proof = json_remove(proof, '$.lastCheck')").run();
  sent = { from: m.w.address, lamports: start.lamports };
  const found = await check(m.b);
  const body = await found.json();
  assert.deepEqual([found.status, body.ok, body.linked, body.wallet, body.next], [200, true, true, m.w.address, "/dashboard?linked=1"], JSON.stringify(body));
  assert.deepEqual(found.headers.getSetCookie(), []);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, m.w.address);
  assert.equal((await one(env.DB, "SELECT wallet_via FROM users WHERE id = ?", u.id)).wallet_via, "transfer");
  assert.deepEqual((await sessionsOf(u.id)).map((s) => [s.wallet, Boolean(s.proven_at)]), [[m.w.address, true]]);
  // without link (or reprove) a wallet-less member is a stranger to the route, and a transfer for ANOTHER wallet is wrong_wallet once one is linked
  const other = await m.b.send("/api/auth/transfer", { method: "POST", body: { address: (await wallet()).address, link: true } });
  assert.deepEqual([other.status, (await other.json()).error], [403, "wrong_wallet"]);
  const n = await member(env, box, { via: "google" });
  const nope = await n.b.send("/api/auth/transfer", { method: "POST", body: { address: n.w.address, reprove: true } });
  assert.deepEqual([nope.status, (await nope.json()).error], [403, "wrong_wallet"], "reprove is for a wallet the account has; link is the word for a new one");

  // a stranger proves an unknown wallet by transfer: no account, nothing made
  const anon = browser(env), w = await wallet();
  const s2 = await anon.post("/api/auth/transfer", { address: w.address });
  assert.ok(anon.has("vs"), "the pending proof rides on a 30-minute session, as today");
  sent = { from: w.address, lamports: s2.lamports };
  await env.DB.prepare("UPDATE sessions SET proof = json_remove(proof, '$.lastCheck') WHERE user_id IS NULL").run();
  const r = await check(anon);
  assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: "no_account" }]);
  assert.equal(await count("sessions WHERE user_id IS NULL"), 0, "the proof session is spent");
  assert.equal((await anon.get("/api/me")).signedIn, false);
});

test("unlink: a fresh proof by the wallet on the account takes it off (every session), refused while a seat, an open application or a squad place depends on it", async () => {
  const m = await memberWithWallet(env, box, { via: "email" });
  const u = await userOf(env, m);
  const c = await secondBrowser(m);
  assert.equal((await c.get("/api/me?lite=1")).user.wallet, m.w.address);
  // not fresh in the second browser (it only logged in): reprove
  const stale = await c.send("/api/me/wallet/unlink", { method: "POST", body: {} });
  assert.deepEqual([stale.status, (await stale.json()).error], [403, "reprove"]);
  // a live seat, an open application, a squad place: resign or withdraw first
  const now = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at) VALUES ('5142056', 'Utica', 'US', ?, ?, 1, 0, 'active', ?)").bind(u.id, m.w.address, now).run();
  let busy = await m.b.send("/api/me/wallet/unlink", { method: "POST", body: {} });
  assert.deepEqual([busy.status, (await busy.json()).error], [409, "seat_or_application"]);
  await env.DB.prepare("UPDATE seats SET status = 'released', ended_at = ? WHERE user_id = ?").bind(now, u.id).run();
  await env.DB.prepare("INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at, status) VALUES ('5142056', 'Utica', 'US', 1, 0, ?, ?, 'open')").bind(now, now).run();
  await env.DB.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, created_at) VALUES (1, '5142056', ?, ?, ?)").bind(u.id, m.w.address, now).run();
  busy = await m.b.send("/api/me/wallet/unlink", { method: "POST", body: {} });
  assert.deepEqual([busy.status, (await busy.json()).error], [409, "seat_or_application"]);
  await env.DB.prepare("UPDATE applications SET withdrawn = 1").run();
  await env.DB.prepare("INSERT INTO squads (city_id, city_name, country, created_by, created_at) VALUES ('5142056', 'Utica', 'US', ?, ?)").bind(u.id, now).run();
  await env.DB.prepare("INSERT INTO squad_members (squad_id, user_id, wallet, joined_at) VALUES (1, ?, ?, ?)").bind(u.id, m.w.address, now).run();
  busy = await m.b.send("/api/me/wallet/unlink", { method: "POST", body: {} });
  assert.deepEqual([busy.status, (await busy.json()).error], [409, "seat_or_application"]);
  await env.DB.prepare("DELETE FROM squad_members").run();
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, m.w.address, "nothing changed so far");
  await env.DB.prepare("UPDATE users SET wallet_at = ?, wallet_via = 'page', wallet_app = 'phantom' WHERE id = ?").bind(now, u.id).run();

  const r = await m.b.post("/api/me/wallet/unlink");
  assert.deepEqual(r, { ok: true });
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", u.id)).wallet, null);
  assert.deepEqual(await one(env.DB, "SELECT wallet_at, wallet_via, wallet_app FROM users WHERE id = ?", u.id), { wallet_at: null, wallet_via: null, wallet_app: null }, "when and how go with it");
  assert.deepEqual((await sessionsOf(u.id)).map((s) => [s.wallet, s.proven_at]), [[null, null], [null, null]]);
  let me = await m.b.get("/api/me");
  assert.deepEqual([me.user.wallet, me.setup.percent, me.fresh], [null, 67, true], "a wallet-less account again: its login (just now) counts as fresh for 30 minutes");
  advance(31 * 60_000);
  me = await m.b.get("/api/me");
  assert.equal(me.fresh, false, "and then it is not, until a new login or a wallet proof");
  // nothing to unlink twice; the same wallet can be linked again (by this account, or by another)
  const twice = await m.b.send("/api/me/wallet/unlink", { method: "POST", body: {} });
  assert.deepEqual([twice.status, (await twice.json()).error], [409, "no_wallet"]);
  const n = await member(env, box, { via: "google" });
  assert.equal((await n.b.post("/api/me/wallet/link", await linkBody(m.w, (await userOf(env, n)).handle))).ok, true, "the freed wallet can join another account");
  assert.equal((await browser(env).send("/api/me/wallet/unlink", { method: "POST", body: {} })).status, 401);
});

test("the old pending wallet sessions are gone in v2: an unknown wallet never gets one, and /api/me?lite=1 of a wallet-less member has pending null", async () => {
  const m = await member(env, box, { via: "email" });
  assert.equal((await m.b.get("/api/me")).pending ?? null, null);
  const anon = browser(env);
  assert.equal((await anon.post("/api/auth/wallet", await loginBody(await wallet()))).error, "no_account");
  assert.equal(await count("sessions WHERE user_id IS NULL"), 0);
  await linkDirect(env, m);
  assert.equal((await m.b.get("/api/me?lite=1")).user.wallet, m.w.address);
});
