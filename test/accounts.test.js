// Accounts: one wallet + one X / Google login per person, sessions, phone pairing, tiny-transfer proof.
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

// Fake Google / X: code "good-<id>" logs in as account <id>.
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
    if (u === "https://api.x.com/2/oauth2/token") return new Response(JSON.stringify({ access_token: "tok-" + form.get("code").slice(5) }));
    if (u === "https://api.x.com/2/users/me") {
      const id = init.headers.authorization.slice("Bearer tok-".length);
      return new Response(JSON.stringify({ data: { id, username: "utica_" + id, name: "Utica Fan" } }));
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

beforeEach(() => {
  _resetCityCache();
  env = { DB: d1(), GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", X_CLIENT_ID: "xid" };
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
  assert.deepEqual(me.providers, { google: true, x: true });

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

test("returning person can sign in with the linked login alone; an unknown login must connect a wallet first", async () => {
  const w = await wallet();
  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) });
  await oauth(jar, "x", "777");
  const me = await (await jar.send("/api/me?lite=1")).json();
  assert.equal(me.user.handle, "@utica_777");

  const fresh = browser();
  let r = await oauth(fresh, "x", "777");
  assert.equal(r.headers.get("location"), "/dashboard");
  assert.equal((await (await fresh.send("/api/me?lite=1")).json()).user.wallet, w.address);

  const stranger = browser();
  r = await oauth(stranger, "x", "999");
  assert.equal(r.headers.get("location"), "/connect?error=wallet_first");
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

test("finish the sign-up in the phone's own browser: link X / Google there, the wallet app takes over", async () => {
  const w = await wallet();
  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) });        // inside the wallet app: proven, not linked yet
  const started = await (await jar.send("/api/auth/handoff", { method: "POST", body: {} })).json();
  assert.equal(started.ok, true);
  assert.match(started.pin, /^[0-9]{2}$/);
  assert.match(started.url, /^https:\/\/vicinity\.test\/connect\?link=[A-Za-z0-9_-]{16,}$/);
  const code = new URL(started.url).searchParams.get("link");

  const phone = browser();                                                                  // Safari / Chrome: no cookies at all
  const info = await (await phone.send(`/api/auth/handoff?code=${code}`)).json();
  assert.equal(info.ok, true);
  assert.equal(info.pin, started.pin, "the same check number on both screens");
  assert.equal(info.wallet, `${w.address.slice(0, 4)}…${w.address.slice(-4)}`);
  assert.equal((await (await jar.send("/api/auth/handoff/finish", { method: "POST", body: { code } })).json()).status, "waiting");

  const start = await phone.send(`/api/auth/google/start?link=${code}`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const back = await phone.send(`/api/auth/google/callback?code=good-g-77&state=${state}`, { fetchImpl: oauthFetch() });
  assert.equal(back.headers.get("location"), "/connect?linked=1");
  assert.equal((await (await phone.send("/api/me?lite=1")).json()).signedIn, false, "the phone's browser is not signed in: it only linked the login");
  const row = await env.DB.prepare("SELECT wallet, provider, provider_id FROM users").first();
  assert.deepEqual(row, { wallet: w.address, provider: "google", provider_id: "g-77" });

  const fin = await jar.send("/api/auth/handoff/finish", { method: "POST", body: { code } });
  assert.equal(fin.status, 200);
  assert.equal((await fin.json()).next, "/dashboard?welcome=1");
  const me = await (await jar.send("/api/me?lite=1")).json();
  assert.equal(me.signedIn, true, "the wallet app is signed in now");
  assert.equal(me.user.wallet, w.address);
  assert.equal(me.fresh, true, "the wallet proof from a moment ago still counts");

  assert.equal((await jar.send("/api/auth/handoff/finish", { method: "POST", body: { code } })).status, 410, "once only");
  assert.equal((await phone.send(`/api/auth/handoff?code=${code}`)).status, 410);
});

test("hand-off safety: needs a proven wallet, the right browser, a live link, and the usual one-wallet-one-login rules", async () => {
  // nothing proven yet, or already signed in: no link to hand off
  assert.equal((await (await browser().send("/api/auth/handoff", { method: "POST", body: {} })).json()).error, "no_pending");
  const done = browser(); const dw = await wallet();
  await done.send("/api/auth/wallet", { method: "POST", body: await loginBody(dw) }); await oauth(done, "google", "g-done");
  assert.equal((await (await done.send("/api/auth/handoff", { method: "POST", body: {} })).json()).error, "no_pending");
  assert.equal((await browser().send("/api/auth/google/start?link=nope-not-a-real-link-code")).headers.get("location"), "/connect?error=link_expired");

  const w = await wallet();
  await jar.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) });
  const code = new URL((await (await jar.send("/api/auth/handoff", { method: "POST", body: {} })).json()).url).searchParams.get("link");
  const link = async (provider, id) => {
    const b = browser();
    const state = new URL((await b.send(`/api/auth/${provider}/start?link=${code}`)).headers.get("location")).searchParams.get("state");
    return (await b.send(`/api/auth/${provider}/callback?code=good-${id}&state=${state}`, { fetchImpl: oauthFetch() })).headers.get("location");
  };

  // another wallet's browser can't take the sign-in over
  const other = browser(); const ow = await wallet();
  await other.send("/api/auth/wallet", { method: "POST", body: await loginBody(ow) });
  assert.equal((await other.send("/api/auth/handoff/finish", { method: "POST", body: { code } })).status, 410);

  // that Google account already belongs to a different wallet
  assert.equal(await link("google", "g-done"), "/connect?error=social_taken");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n, 1, "nothing was linked");

  // the wallet got an account some other way in the meantime
  await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, name, early, created_at) VALUES (?, 'x', 'x-1', 'N', 1, ?)").bind(w.address, new Date().toISOString()).run();
  assert.equal(await link("google", "g-fresh"), "/connect?error=wallet_taken");
  await env.DB.prepare("DELETE FROM users WHERE provider_id = 'x-1'").run();

  // the link only lives 15 minutes: it's refused at the start, and a callback that was already under way is refused too
  const mid = browser();
  const state = new URL((await mid.send(`/api/auth/google/start?link=${code}`)).headers.get("location")).searchParams.get("state");
  await env.DB.prepare("UPDATE handoffs SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
  assert.equal((await mid.send(`/api/auth/google/callback?code=good-g-late&state=${state}`, { fetchImpl: oauthFetch() })).headers.get("location"), "/connect?error=link_expired");
  assert.equal((await browser().send(`/api/auth/google/start?link=${code}`)).headers.get("location"), "/connect?error=link_expired");
});
