// With the new sign-up on, a wallet nobody owns gets no account and no session from a wallet proof: /api/auth/wallet,
// /api/pair/finish and /api/auth/transfer/check answer 404 no_account with no cookie (the page says how to join). A wallet
// that is linked to an account signs its owner in exactly as before. With the switch off nothing changed (next "social").
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, browser, loginBody, newWorld, realClock, useClock, wallet } from "./helpers/world.js";
import { doLocation, doTerms, memberWithWallet, one, outbox, rows, startSignup, stateOf } from "./helpers/signup.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const count = async (sql) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${sql}`)).n;
const noAccount = async (res) => {
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, error: "no_account" });
  assert.deepEqual(res.headers.getSetCookie(), [], "no cookie of any kind");
};
let sent = null;
const chain = async (_u, init) => {
  const { method } = JSON.parse(init.body);
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  if (method === "getSignaturesForAddress") return ok(sent ? [{ signature: "sig1", err: null, blockTime: Math.floor(Date.now() / 1000) }] : []);
  if (method === "getTransaction") return ok({ meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [
    { program: "system", parsed: { type: "transfer", info: { source: sent.from, destination: sent.from, lamports: sent.lamports } } }] } } });
  throw new Error("unexpected " + method);
};

test("/api/auth/wallet: an unknown wallet is no_account, no session row, no cookie; /api/me stays signed out with no pending", async () => {
  const b = browser(env), w = await wallet();
  await noAccount(await b.send("/api/auth/wallet", { method: "POST", body: await loginBody(w) }));
  assert.equal(await count("sessions"), 0);
  assert.equal(await count("users"), 0);
  assert.deepEqual(await b.get("/api/me"), { signedIn: false, providers: { google: true, email: true }, signupFlow: "v2" });
  // during a half-done sign-up the sign-up simply stays (nothing signed in, nothing ended)
  await startSignup(b);
  await doLocation(b);
  await doTerms(b);
  await noAccount(await b.send("/api/auth/wallet", { method: "POST", body: await loginBody(await wallet()) }));
  assert.ok(b.has("vsu"));
  assert.deepEqual([(await stateOf(b)).location.done, (await stateOf(b)).terms.done, (await stateOf(b)).next], [true, true, "account"]);
});

test("/api/pair/finish: a phone approved an unknown wallet for this computer: no_account, the pairing is used up, nothing is made", async () => {
  const computer = browser(env), phone = browser(env), w = await wallet();
  const pair = await computer.post("/api/pair");
  assert.deepEqual(await phone.post("/api/auth/wallet", { ...(await loginBody(w, pair.pin)), pair: pair.code }), { ok: true, paired: true });
  assert.equal(phone.has("vs"), false);
  await noAccount(await computer.send("/api/pair/finish", { method: "POST", body: { code: pair.code } }));
  assert.equal(await count("pairs"), 0, "a code works once, whatever it found");
  assert.equal(await count("sessions"), 0);
  assert.equal((await computer.post("/api/pair/finish", { code: pair.code })).status, "expired");
});

test("/api/auth/transfer/check: a tiny transfer from an unknown wallet is found and still makes nothing: no_account, the proof session is spent", async () => {
  const b = browser(env), w = await wallet();
  const start = await b.post("/api/auth/transfer", { address: w.address });
  assert.equal(start.ok, true);
  assert.equal(await count("sessions WHERE user_id IS NULL"), 1, "the proof itself rides on a 30-minute row, as today");
  sent = { from: w.address, lamports: start.lamports };
  await noAccount(await b.send("/api/auth/transfer/check", { method: "POST", body: {}, fetchImpl: chain }));
  assert.equal(await count("sessions"), 0);
  assert.equal((await b.get("/api/me")).signedIn, false);
  const again = await b.send("/api/auth/transfer/check", { method: "POST", body: {}, fetchImpl: chain });
  assert.deepEqual([again.status, (await again.json()).error], [400, "no_proof"]);
});

test("a wallet linked to an account signs its owner in as before, on every one of the three routes", async () => {
  const m = await memberWithWallet(env, box, { via: "google" });
  const b = browser(env);
  const r = await b.send("/api/auth/wallet", { method: "POST", body: await loginBody(m.w) });
  assert.deepEqual([r.status, await r.json()], [200, { ok: true, wallet: m.w.address, next: "/dashboard" }]);
  assert.match(r.headers.getSetCookie()[0], /^vs=.*Max-Age=2592000$/);
  assert.equal((await b.get("/api/me?lite=1")).fresh, true);

  const computer = browser(env), phone = browser(env);
  const pair = await computer.post("/api/pair");
  await phone.post("/api/auth/wallet", { ...(await loginBody(m.w, pair.pin)), pair: pair.code });
  const fin = await computer.post("/api/pair/finish", { code: pair.code });
  assert.deepEqual(fin, { ok: true, status: "done", wallet: m.w.address, next: "/dashboard" });
  assert.equal((await computer.get("/api/me?lite=1")).signedIn, true);

  const c = browser(env);
  const start = await c.post("/api/auth/transfer", { address: m.w.address });
  sent = { from: m.w.address, lamports: start.lamports };
  const res = await c.send("/api/auth/transfer/check", { method: "POST", body: {}, fetchImpl: chain });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true, wallet: m.w.address, next: "/dashboard" }]);
  assert.equal((await c.get("/api/me?lite=1")).signedIn, true);
  assert.equal((await rows(env.DB, "SELECT id FROM sessions WHERE user_id IS NOT NULL")).length, 4, "the member's own and the three sign-ins");
  assert.equal(await count("sessions WHERE user_id IS NULL"), 0);
});

test("with the switch off (v1) nothing changed: an unknown wallet gets the 30-minute pending session and next 'social' on all three routes", async () => {
  env = newWorld();
  const b = browser(env), w = await wallet();
  const r = await b.post("/api/auth/wallet", await loginBody(w));
  assert.deepEqual([r.ok, r.next], [true, "social"]);
  assert.equal((await b.get("/api/me")).pending.wallet, w.address);
  const computer = browser(env), phone = browser(env), w2 = await wallet();
  const pair = await computer.post("/api/pair");
  await phone.post("/api/auth/wallet", { ...(await loginBody(w2, pair.pin)), pair: pair.code });
  assert.equal((await computer.post("/api/pair/finish", { code: pair.code })).next, "social");
  const c = browser(env), w3 = await wallet();
  const start = await c.post("/api/auth/transfer", { address: w3.address });
  sent = { from: w3.address, lamports: start.lamports };
  assert.equal((await (await c.send("/api/auth/transfer/check", { method: "POST", body: {}, fetchImpl: chain })).json()).next, "social");
  assert.equal(await count("sessions WHERE user_id IS NULL"), 3);
  // and a link statement is not a thing in v1
  const link = await b.send("/api/auth/wallet", { method: "POST", body: await (await import("./helpers/world.js")).linkBody(w, "Somebody1") });
  assert.deepEqual([link.status, (await link.json()).error], [400, "bad_message"]);
  assert.equal((await b.send("/api/me/wallet/link", { method: "POST", body: {} })).status, 404);
  assert.equal((await b.send("/api/pair", { method: "POST", body: { purpose: "link" } })).status, 400);
});
