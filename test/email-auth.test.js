// E-mail sign-in: 6-digit codes (hashed, 10-minute life), rate limits, and linking.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/index.js";
import { base58Encode, buildMessage, statementFor } from "../src/solana.js";
import { d1 } from "./helpers/d1.js";

const HOST = "vicinity.test";
const ORIGIN = `https://${HOST}`;
let env, jar, sentCodes;

// Resend stand-in: captures the code out of the e-mail text.
function resendFetch() {
  return async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.headers.authorization, "Bearer rk-test");
    const body = JSON.parse(init.body);
    const to = body.to[0];
    const code = body.text.match(/code is (\d{6})/)[1];
    assert.ok(body.html.includes(code), "html version carries the code");
    assert.ok(body.html.includes("vicinity.city/connect"), "html links back to the site");
    sentCodes.push({ to, code, from: body.from });
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  };
}

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

async function wallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (text) => Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}
const loginBody = async (w) => {
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop", issuedAt: new Date().toISOString(), statement: statementFor("login", {}) });
  return { address: w.address, message, signature: await w.sign(message) };
};
const start = (b, email) => b.send("/api/auth/email/start", { method: "POST", body: { email }, fetchImpl: resendFetch() });
const verify = (b, email, code) => b.send("/api/auth/email/verify", { method: "POST", body: { email, code }, fetchImpl: resendFetch() });

beforeEach(() => {
  env = { DB: d1(), RESEND_API_KEY: "rk-test" };
  jar = browser();
  sentCodes = [];
});

test("start validates the address and refuses to work without a mail key", async () => {
  let r = await jar.send("/api/auth/email/start", { method: "POST", body: { email: "not-an-email" }, fetchImpl: resendFetch() });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "bad_email");

  const noKey = browser();
  const envBefore = env;
  env = { DB: envBefore.DB };
  r = await noKey.send("/api/auth/email/start", { method: "POST", body: { email: "a@b.co" }, fetchImpl: resendFetch() });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "email_unavailable");
  env = envBefore;
});

test("a code is sent, stored hashed, and a second send inside a minute is refused", async () => {
  const r = await start(jar, "Ada@Example.com");
  assert.equal((await r.json()).ok, true);
  assert.equal(sentCodes.length, 1);
  assert.equal(sentCodes[0].to, "ada@example.com", "addresses are normalized");

  const row = await env.DB.prepare("SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?").bind("ada@example.com").first();
  assert.ok(row);
  assert.ok(!/^\d{6}$/.test(row.code_hash), "only a hash is stored");
  assert.ok(Date.parse(row.expires_at) - Date.now() > 9 * 60_000, "lives ~10 minutes");

  const r2 = await start(jar, "ada@example.com");
  assert.equal(r2.status, 429);
  assert.equal((await r2.json()).error, "too_soon");
  assert.equal(sentCodes.length, 1, "nothing re-sent");
});

test("wrong codes count down; the right code links the proven wallet and creates the account", async () => {
  const w = await wallet();
  let d = await (await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) })).json();
  assert.equal(d.next, "social");

  await start(jar, "new@example.com");
  const code = sentCodes[0].code;

  let r = await verify(jar, "new@example.com", "000000");
  assert.equal((await r.json()).error, "code_wrong");
  r = await verify(jar, "new@example.com", code);
  d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.next, "/dashboard?welcome=1");
  assert.equal(d.isNew, true);

  const me = await (await jar.send("/api/me?lite=1")).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.user.wallet, w.address);
  assert.equal(me.user.provider, "email");
  assert.match(me.user.handle, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/, "auto username, privacy kept");
  const row = await env.DB.prepare("SELECT provider, provider_id FROM users WHERE wallet = ?").bind(w.address).first();
  assert.deepEqual([row.provider, row.provider_id], ["email", "new@example.com"]);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) c FROM email_codes").first().then((x) => x.c), 0, "used codes are deleted");
});

test("a verified e-mail signs a returning person straight in; unknown e-mails need a wallet first", async () => {
  const w = await wallet();
  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) });
  await start(jar, "back@example.com");
  await verify(jar, "back@example.com", sentCodes[0].code);

  const fresh = browser();
  await start(fresh, "back@example.com");
  const d = await (await verify(fresh, "back@example.com", sentCodes[1].code)).json();
  assert.equal(d.ok, true);
  assert.equal(d.next, "/dashboard");
  assert.equal((await (await fresh.send("/api/me?lite=1")).json()).user.wallet, w.address);

  const stranger = browser();
  await start(stranger, "nobody@example.com");
  const r = await verify(stranger, "nobody@example.com", sentCodes[2].code);
  assert.equal((await r.json()).error, "wallet_first");
});

test("an e-mail can't be linked to two wallets, and five wrong guesses burn the code", async () => {
  const w1 = await wallet(), w2 = await wallet();
  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w1) });
  await start(jar, "one@example.com");
  await verify(jar, "one@example.com", sentCodes[0].code);

  const other = browser();
  await other.send("/api/auth/wallet", { method: "POST", body: await loginBody(w2) });
  await start(other, "one@example.com");
  // the 60s cooldown blocks an immediate re-send; clear it for the test
  await env.DB.prepare("UPDATE email_codes SET last_sent_at = ?, window_start = ?").bind(new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 120_000).toISOString()).run();
  await start(other, "one@example.com");
  const r = await verify(other, "one@example.com", sentCodes[sentCodes.length - 1].code);
  assert.equal((await r.json()).error, "social_taken");

  const brute = browser();
  await start(brute, "brute@example.com");
  for (let i = 0; i < 5; i++) {
    const rr = await verify(brute, "brute@example.com", "111111");
    assert.equal((await rr.json()).error, "code_wrong");
  }
  const locked = await verify(brute, "brute@example.com", "111111");
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, "too_many");
});

test("expired codes are rejected", async () => {
  await start(jar, "old@example.com");
  const code = sentCodes[0].code;
  await env.DB.prepare("UPDATE email_codes SET expires_at = ? WHERE email = ?").bind(new Date(Date.now() - 1000).toISOString(), "old@example.com").run();
  const r = await verify(jar, "old@example.com", code);
  assert.equal((await r.json()).error, "code_expired");
});

test("providers() advertises e-mail only when the mail key is set", async () => {
  const { providers } = await import("../src/auth.js");
  assert.deepEqual(providers({ RESEND_API_KEY: "x" }), { google: false, email: true });
  assert.deepEqual(providers({ GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "x" }), { google: false, email: true });
  assert.deepEqual(providers({}), { google: false, email: false });
});

test("gmail path sends the code via SMTP when configured", async () => {
  const { handleEmailStart } = await import("../src/auth.js");
  env = { DB: d1(), GMAIL_USER: "vicinity.test@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" };
  const calls = [];
  const req = new Request(ORIGIN + "/api/auth/email/start", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: "user@example.com" }),
  });
  const r = await handleEmailStart(req, env, fetch, Date.now(), {
    smtpImpl: async (m) => { calls.push(m); return { ok: true }; },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "user@example.com");
  assert.equal(calls[0].user, "vicinity.test@gmail.com");
  assert.equal(calls[0].pass, "abcdefghijklmnop"); // spaces stripped
  assert.match(calls[0].subject, /^\d{6} is your Vicinity code$/);
});

test("verification e-mail template is branded and carries the code", async () => {
  const { verificationEmail } = await import("../src/mail.js");
  const { subject, text, html } = verificationEmail("482916");
  assert.equal(subject, "482916 is your Vicinity code");
  assert.ok(text.includes("482916"));
  assert.ok(html.includes("482916"));
  assert.ok(html.includes("VICINITY"));
  assert.ok(html.includes("ONE CITY"));
  assert.ok(html.includes("https://vicinity.city/connect"));
});

test("gmail is preferred over resend when both are configured", async () => {
  const { sendMail } = await import("../src/mail.js");
  let via = null;
  const deps = {
    smtpImpl: async () => { via = "gmail"; return { ok: true }; },
    fetchImpl: async () => { via = "resend"; return new Response("{}", { status: 200 }); },
  };
  await sendMail({ GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "x", RESEND_API_KEY: "y" },
    { to: "t@example.com", subject: "s", text: "t" }, deps);
  assert.equal(via, "gmail");
});

// ---- Parallel requests (security): the database answers a little later than the code runs, like the real one,
// so requests that arrive together really do overlap.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function slowDb(db, ms = 2) {
  const wrap = (stmt) => ({
    sql: stmt.sql,
    bind: (...p) => wrap(stmt.bind(...p)),
    first: async (...a) => { await sleep(ms); const r = await stmt.first(...a); await sleep(ms); return r; },
    run: async () => { await sleep(ms); const r = await stmt.run(); await sleep(ms); return r; },
    all: async () => { await sleep(ms); const r = await stmt.all(); await sleep(ms); return r; },
  });
  return { ...db, prepare: (sql) => wrap(db.prepare(sql)) };
}
const attemptsOf = (email) => env.DB.prepare("SELECT attempts, send_count FROM email_codes WHERE email = ?").bind(email).first();

test("60 guesses sent at the same moment still only get five tries (the right code in the middle loses)", async () => {
  await start(jar, "victim@example.com");
  const right = sentCodes[0].code;
  env.DB = slowDb(env.DB);
  const wrong = (i) => String(100000 + ((Number(right) - 100000 + 1 + i) % 900000));
  const guesses = Array.from({ length: 61 }, (_, i) => (i === 30 ? right : wrong(i)));
  const answers = await Promise.all(guesses.map((g) => verify(browser(), "victim@example.com", g).then((r) => r.json())));
  const compared = answers.filter((a) => a.error === "code_wrong" || a.ok || a.error === "wallet_first").length;
  assert.ok(compared <= 5, `only five guesses may be compared, got ${compared}`);
  assert.equal(answers.filter((a) => a.ok).length, 0, "nobody got in with the code in 31st place");
  assert.ok(answers.every((a) => ["code_wrong", "too_many", "code_expired", "wallet_first"].includes(a.error)));
  assert.equal((await attemptsOf("victim@example.com")).attempts, 5);
});

test("two requests carrying the right code at once: only one can use it", async () => {
  const { consumeEmailCode } = await import("../src/auth.js");
  await start(jar, "once@example.com");
  const code = sentCodes[0].code;
  const slow = slowDb(env.DB);
  const results = await Promise.all([consumeEmailCode(slow, "once@example.com", code), consumeEmailCode(slow, "once@example.com", code)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("30 parallel requests for one address send one e-mail, not thirty", async () => {
  env.DB = slowDb(env.DB);
  const answers = await Promise.all(Array.from({ length: 30 }, () => start(browser(), "bomb@example.com")));
  assert.equal(sentCodes.length, 1);
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, ...Array(29).fill(429)]);
  assert.equal((await attemptsOf("bomb@example.com")).send_count, 1);
});

test("burning the five guesses does not reset the one-a-minute and five-an-hour limits", async () => {
  const E = "loop@example.com", ago = (ms) => new Date(Date.now() - ms).toISOString();
  await start(jar, E);
  for (let i = 0; i < 5; i++) await verify(jar, E, "111111");
  assert.equal((await verify(jar, E, "111111")).status, 429, "code is dead");
  const r = await start(jar, E);
  assert.equal(r.status, 429, "the mailing limits survived the burn");
  assert.equal((await r.json()).error, "too_soon");
  // five an hour: a minute passes between sends, the count keeps growing through burns
  for (let i = 2; i <= 5; i++) {
    await env.DB.prepare("UPDATE email_codes SET last_sent_at = ? WHERE email = ?").bind(ago(61_000), E).run();
    assert.equal((await start(jar, E)).status, 200, `send ${i}`);
    for (let k = 0; k < 6; k++) await verify(jar, E, "111111");
  }
  await env.DB.prepare("UPDATE email_codes SET last_sent_at = ? WHERE email = ?").bind(ago(61_000), E).run();
  const sixth = await start(jar, E);
  assert.equal(sixth.status, 429);
  assert.equal((await sixth.json()).error, "too_many");
  assert.equal(sentCodes.length, 5);
});

test("a failed mail gives the send slot back and leaves no usable code", async () => {
  const bad = async () => new Response("nope", { status: 500 });
  let r = await jar.send("/api/auth/email/start", { method: "POST", body: { email: "flaky@example.com" }, fetchImpl: bad });
  assert.equal(r.status, 503);
  assert.equal((await attemptsOf("flaky@example.com")).send_count, 0);
  r = await start(jar, "flaky@example.com");
  assert.equal(r.status, 200, "retry right away works");
  assert.equal(sentCodes.length, 1);
});

test("a site-wide hourly cap protects the mail quota (EMAIL_MAX_PER_HOUR)", async () => {
  env.EMAIL_MAX_PER_HOUR = "3";
  const answers = [];
  for (const n of ["a", "b", "c", "d"]) answers.push((await start(jar, `${n}@example.com`)).status);
  assert.deepEqual(answers, [200, 200, 200, 429]);
  assert.equal(sentCodes.length, 3);
});

test("control characters and brackets never reach the mail server", async () => {
  const { validEmail } = await import("../src/auth.js");
  const { sendMail } = await import("../src/mail.js");
  for (const bad of ["a@b.co\u0085", "a@b.co\u0000x", "a@b.co>", "<a@b.co", "a@b.co\r\nRCPT TO:<x@y.zz>", "a b@c.de"]) assert.equal(validEmail(bad), false, JSON.stringify(bad));
  assert.equal(validEmail("o'brien+tag@example.co.uk"), true);
  let called = 0;
  const smtpImpl = async () => { called++; return { ok: true }; };
  for (const bad of ["a@b.co\r\nRCPT TO:<x@y.zz>", "a@b.co>", "a@b.co\u0085", "", null]) {
    const r = await sendMail({ GMAIL_USER: "u@gmail.com", GMAIL_APP_PASSWORD: "p" }, { to: bad, subject: "s", text: "t" }, { smtpImpl });
    assert.deepEqual(r, { ok: false, error: "bad_email" });
  }
  assert.equal(called, 0);
  assert.equal((await sendMail({ GMAIL_USER: "u@gmail.com", GMAIL_APP_PASSWORD: "p" }, { to: "a@b.co", subject: "s", text: "t" }, { smtpImpl })).ok, true);
});
