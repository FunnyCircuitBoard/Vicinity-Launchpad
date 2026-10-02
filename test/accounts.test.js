// Accounts: one wallet + one Google login or e-mail address per person, sessions, phone pairing, tiny-transfer proof.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/index.js";
import { base58Encode, buildMessage, statementFor } from "../src/solana.js";
import { _resetCityCache } from "../src/cities.js";
import { d1 } from "./helpers/d1.js";

const HOST = "vicinity.test";
const ORIGIN = `https://${HOST}`;
let env, jar;

async function wallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (text) => Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}

// A browser: keeps cookies between requests, sends Origin on POST like real browsers do.
function browser() {
  const cookies = new Map();
  const send = async (path, { method = "GET", body, origin = ORIGIN, fetchImpl } = {}) => {
    const headers = new Headers();
    if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (method !== "GET" && origin) headers.set("origin", origin);
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await handleApi(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, fetchImpl);
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split("; ");
      const [k, v] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.some((a) => a === "Max-Age=0")) cookies.delete(k); else cookies.set(k, v);
    }
    return res;
  };
  return { send, cookies };
}

const loginBody = async (w, { pin, host = HOST } = {}) => {
  const message = buildMessage({ host, address: w.address, nonce: "abcdefghijklmnop", issuedAt: new Date().toISOString(), statement: statementFor("login", { pin }) });
  return { address: w.address, message, signature: await w.sign(message) };
};

// Fake Google: code "good-<id>" logs in as account <id>.
function oauthFetch() {
  return async (url, init) => {
    const u = String(url);
    const form = init && init.body ? new URLSearchParams(String(init.body)) : null;
    if (u === "https://oauth2.googleapis.com/token") {
      const code = form.get("code");
      if (!code.startsWith("good-") || !form.get("code_verifier")) return new Response("{}", { status: 400 });
      const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "gid", sub: code.slice(5), given_name: "Sakib" })).toString("base64url");
      return new Response(JSON.stringify({ id_token: `x.${payload}.y` }));
    }
    throw new Error("unexpected " + u);
  };
}
async function oauth(b, provider, id) {
  const start = await b.send(`/api/auth/${provider}/start`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  return b.send(`/api/auth/${provider}/callback?code=good-${id}&state=${state}`, { fetchImpl: oauthFetch() });
}


// Fake mail service (Resend): keeps what was "sent" so a test can read the 6-digit code out of the message.
function mailbox() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    sent.push(JSON.parse(init.body));
    return new Response("{}");
  };
  return { sent, fetchImpl, code: () => sent.at(-1).text.match(/code is (\d{6})/)[1] };
}
// Ask for a code, then type it back.
async function emailIn(b, mail, email) {
  const start = await b.send("/api/auth/email/start", { method: "POST", body: { email }, fetchImpl: mail.fetchImpl });
  assert.equal(start.status, 200);
  return b.send("/api/auth/email/verify", { method: "POST", body: { email, code: mail.code() } });
}
const later = (ms) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  _resetCityCache();
  env = { DB: d1(), GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", RESEND_API_KEY: "re_test" };
  jar = browser();
});

test("new person: wallet first, then Google, then signed in for good", async () => {
  const w = await wallet();
  let r = await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) });
  let d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.next, "social");
  const me = await (await jar.send("/api/me")).json();
  assert.equal(me.signedIn, false);
  assert.equal(me.pending.wallet, w.address);
  assert.deepEqual(me.providers, { google: true, email: true });

  r = await oauth(jar, "google", "g-1");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/dashboard?welcome=1");
  d = await (await jar.send("/api/me?lite=1")).json();
  assert.equal(d.signedIn, true);
  assert.equal(d.user.wallet, w.address);
  assert.equal(d.user.provider, "google");
  assert.equal(d.user.name, "Sakib");
  const row = await env.DB.prepare("SELECT * FROM users").first();
  assert.equal(row.email, undefined, "no e-mail is ever stored");
  assert.equal(row.early, 1, "joined before launch");
});

test("one wallet ↔ one login: a second wallet can't reuse the Google account, and the linked wallet signs straight in", async () => {
  const w1 = await wallet(), w2 = await wallet();
  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w1) });
  await oauth(jar, "google", "g-1");

  const other = browser();
  await other.send("/api/auth/wallet", { method: "POST", body: await loginBody(w2) });
  const r = await oauth(other, "google", "g-1");
  assert.equal(r.headers.get("location"), "/connect?error=social_taken");
  assert.equal((await (await other.send("/api/me")).json()).signedIn, false);

  const again = browser();
  const d = await (await again.send("/api/auth/wallet", { method: "POST", body: await loginBody(w1) })).json();
  assert.equal(d.next, "/dashboard");
  assert.equal((await (await again.send("/api/me?lite=1")).json()).signedIn, true);
});

test("returning person can sign in with the linked e-mail alone; an unknown e-mail must connect a wallet first", async () => {
  const w = await wallet(), mail = mailbox();
  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) });
  let d = await (await emailIn(jar, mail, "Sakib@Example.com ")).json();
  assert.deepEqual([d.ok, d.next, d.isNew], [true, "/dashboard?welcome=1", true]);
  const me = await (await jar.send("/api/me?lite=1")).json();
  assert.equal(me.user.provider, "email");
  assert.equal(me.user.wallet, w.address);
  assert.match(me.user.handle, /^\S+$/, "a made-up username, never the e-mail address");
  assert.doesNotMatch(JSON.stringify(me), /sakib@example\.com/i, "the e-mail address is not sent back to the page");

  const fresh = browser();
  d = await (await emailIn(fresh, mail, "sakib@example.com")).json();
  assert.deepEqual([d.ok, d.next, d.isNew], [true, "/dashboard", false]);
  assert.equal((await (await fresh.send("/api/me?lite=1")).json()).user.wallet, w.address);

  const stranger = browser();
  const r = await emailIn(stranger, mail, "someone-else@example.com");
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "wallet_first");
});

test("e-mail codes: shape, setup, one every minute, five wrong guesses, expiry, one use, five an hour", async () => {
  const mail = mailbox(), start = (email, b = jar) => b.send("/api/auth/email/start", { method: "POST", body: { email }, fetchImpl: mail.fetchImpl });
  const verify = (email, code) => jar.send("/api/auth/email/verify", { method: "POST", body: { email, code } }).then((r) => r.json());
  const row = (email) => env.DB.prepare("SELECT * FROM email_codes WHERE email = ?").bind(email).first();
  const E = "a@example.com";

  assert.equal((await start("not an address")).status, 400);
  assert.equal((await start("a@b.c\r\nRCPT TO:<x@y.zz>")).status, 400, "no line breaks can reach the mail server");
  assert.equal((await jar.send("/api/auth/email/start", { method: "POST", body: { email: E }, origin: "https://evil.example" })).status, 403);
  assert.equal(mail.sent.length, 0);

  const noMail = { ...env }; delete noMail.RESEND_API_KEY;
  const saved = env; env = noMail;
  assert.equal((await start(E)).status, 503, "no mail setup: say so, don't pretend");
  env = saved;

  assert.deepEqual(await (await start(E)).json(), { ok: true });
  assert.match(mail.sent[0].subject, /^\d{6} is your Vicinity code$/);
  assert.deepEqual(mail.sent[0].to, [E]);
  assert.equal((await row(E)).code_hash.includes(mail.code()), false, "only a hash of the code is stored");
  assert.equal((await start(E)).status, 429, "a second mail within a minute is refused");

  // wrong guesses are counted; a code can't be used for another address
  const wrong = mail.code() === "123456" ? "654321" : "123456";
  let d = await verify(E, wrong);
  assert.deepEqual([d.error, d.left], ["code_wrong", 4]);
  assert.equal((await verify("b@example.com", mail.code())).error, "code_expired");
  assert.equal((await verify(E, "12ab")).error, "bad_code");
  for (let i = 0; i < 3; i++) await verify(E, wrong);
  d = await verify(E, wrong);
  assert.deepEqual([d.error, d.left], ["code_wrong", 0]);
  assert.equal((await jar.send("/api/auth/email/verify", { method: "POST", body: { email: E, code: mail.code() } })).status, 429, "after five wrong guesses even the right code is dead");
  assert.equal(await row(E), null);

  // a code expires after ten minutes
  await start(E);
  await env.DB.prepare("UPDATE email_codes SET expires_at = ? WHERE email = ?").bind(later(1000), E).run();
  assert.equal((await verify(E, mail.code())).error, "code_expired");

  // five mails an hour per address (the expired code above was removed with its row, so this count starts fresh)
  assert.equal((await start(E)).status, 200);
  for (let i = 2; i <= 6; i++) {
    await env.DB.prepare("UPDATE email_codes SET last_sent_at = ? WHERE email = ?").bind(later(61_000), E).run();
    assert.equal((await start(E)).status, i <= 5 ? 200 : 429, `mail ${i}`);
  }
});

test("login safety: other sites, wrong state, missing settings, logout", async () => {
  const w = await wallet();
  assert.equal((await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w), origin: "https://evil.example" })).status, 403);
  assert.equal((await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w), origin: null })).status, 403);
  assert.equal((await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w, { host: "evil.example" }) })).status, 400);

  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) });
  await jar.send("/api/auth/google/start");
  const r = await jar.send("/api/auth/google/callback?code=good-1&state=forged", { fetchImpl: oauthFetch() });
  assert.equal(r.headers.get("location"), "/connect?error=login_expired");

  env.GOOGLE_CLIENT_ID = "";
  assert.equal((await jar.send("/api/auth/google/start")).headers.get("location"), "/connect?error=login_unavailable");

  env.GOOGLE_CLIENT_ID = "gid";
  await oauth(jar, "google", "g-5");
  assert.equal((await (await jar.send("/api/me?lite=1")).json()).signedIn, true);
  await jar.send("/api/auth/logout", { method: "POST", body: {} });
  assert.equal((await (await jar.send("/api/me?lite=1")).json()).signedIn, false);
});

test("sign in on a computer with the wallet on your phone (code + 2-digit check number)", async () => {
  const w = await wallet();
  const computer = browser(), phone = browser();
  const start = await (await computer.send("/api/pair", { method: "POST", body: {} })).json();
  assert.match(start.url, /\/connect\?pair=/);
  assert.match(start.pin, /^[0-9]{2}$/);

  const seen = await (await phone.send(`/api/pair?code=${start.code}`)).json();
  assert.deepEqual(seen, { status: "waiting", pin: start.pin });
  const wrongPin = start.pin === "42" ? "43" : "42";
  let r = await phone.send("/api/auth/wallet", { method: "POST", body: { ...(await loginBody(w, { pin: wrongPin })), pair: start.code } });
  assert.equal((await r.json()).error, "pin_mismatch");
  r = await phone.send("/api/auth/wallet", { method: "POST", body: { ...(await loginBody(w, { pin: start.pin })), pair: start.code } });
  assert.equal((await r.json()).paired, true);
  assert.equal(phone.cookies.size, 0, "the phone itself isn't signed in");

  assert.equal((await (await computer.send(`/api/pair?code=${start.code}`)).json()).status, "ready");
  const done = await (await computer.send("/api/pair/finish", { method: "POST", body: { code: start.code } })).json();
  assert.equal(done.status, "done");
  assert.equal(done.wallet, w.address);
  assert.equal((await (await computer.send("/api/me")).json()).pending.wallet, w.address);
  assert.equal((await (await computer.send("/api/pair/finish", { method: "POST", body: { code: start.code } })).json()).status, "expired", "a code works once");
});

test("apps that can't sign (FOMO...): prove the wallet by sending yourself an exact tiny amount", async () => {
  const w = await wallet();
  const start = await (await jar.send("/api/auth/transfer", { method: "POST", body: { address: w.address } })).json();
  assert.ok(start.lamports >= 1_001_000 && start.lamports <= 9_999_000 && start.lamports % 1000 === 0);
  assert.equal(start.sol, (start.lamports / 1e9).toFixed(6));

  let sent = null;
  const chain = async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getSignaturesForAddress") return ok(sent ? [{ signature: "sig1", err: null, blockTime: Math.floor(Date.now() / 1000) }] : []);
    if (method === "getTransaction") return ok({ meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [
      { program: "system", parsed: { type: "transfer", info: { source: sent.from, destination: sent.from, lamports: sent.lamports } } }] } } });
    throw new Error("unexpected " + method + params);
  };
  let looks = 0;
  const counted = async (u, init) => { looks++; return chain(u, init); };
  const check = () => jar.send("/api/auth/transfer/check", { method: "POST", body: {}, fetchImpl: counted }).then((r) => r.json());
  const later = () => env.DB.prepare("UPDATE sessions SET proof = json_remove(proof, '$.lastCheck')").run(); // 8+ seconds pass
  let d = await check();
  assert.equal(d.error, "not_found_yet");
  assert.equal(looks, 1);
  await check();
  assert.equal(looks, 1, "checking again right away doesn't touch the blockchain");
  await later();
  sent = { from: w.address, lamports: start.lamports + 1000 };
  d = await check();
  assert.equal(d.error, "not_found_yet", "a different amount doesn't count");
  await later();
  sent = { from: w.address, lamports: start.lamports };
  d = await check();
  assert.equal(d.ok, true);
  assert.equal(d.next, "social");
  assert.equal((await (await jar.send("/api/me")).json()).pending.wallet, w.address);
});
