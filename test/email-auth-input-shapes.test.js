// E-mail sign-in routes: fields that are not text (e.g. {"toString":1}) get the normal 400 answers, never a 500.
// String() of an object whose toString is not a function throws, so the routes only read strings and numbers as text.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApi } from "../src/index.js";
import { d1 } from "./helpers/d1.js";

const HOST = "vicinity.test";
const ORIGIN = `https://${HOST}`;
let env, sentCodes;

// Resend stand-in: captures the code out of the e-mail text.
function resendFetch() {
  return async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    const body = JSON.parse(init.body);
    sentCodes.push({ to: body.to[0], code: body.text.match(/code is (\d{6})/)[1] });
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  };
}

const request = (path, raw) => new Request(ORIGIN + path, {
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/json" },
  body: raw,
});
// Through the Worker's own fetch, like curl: a thrown error there becomes HTTP 500 {"error":"internal_error"}.
const viaWorker = (path, raw) => worker.fetch(request(path, raw), env, { waitUntil() {} });
const viaApi = (path, body) => handleApi(request(path, JSON.stringify(body)), env, resendFetch());

beforeEach(() => {
  env = { DB: d1(), RESEND_API_KEY: "rk-test" };
  sentCodes = [];
});

test("the fuzzed bodies get bad_email / bad_code, not a 500", async () => {
  const cases = [
    ["/api/auth/email/start", '{"email":{"toString":1}}', "bad_email"],
    ["/api/auth/email/verify", '{"email":{"toString":1},"code":"123456"}', "bad_code"],
    ["/api/auth/email/verify", '{"email":"a@b.cc","code":{"toString":1}}', "bad_code"],
  ];
  for (const [path, raw, error] of cases) {
    const r = await viaWorker(path, raw);
    assert.notEqual(r.status, 500, `${path} ${raw}`);
    assert.equal(r.status, 400, `${path} ${raw}`);
    assert.deepEqual(await r.json(), { ok: false, error }, `${path} ${raw}`);
  }
  assert.equal(sentCodes.length, 0, "nothing was mailed");
});

test("other values that are not text are treated as empty too", async () => {
  const odd = [{ toString: 1 }, { toString: { toString: 1 } }, { valueOf: 1, toString: 1 }, ["a@b.cc"], [], {}, null, true, false];
  for (const v of odd) {
    let r = await viaWorker("/api/auth/email/start", JSON.stringify({ email: v }));
    assert.equal(r.status, 400, `start email=${JSON.stringify(v)}`);
    assert.equal((await r.json()).error, "bad_email");
    r = await viaWorker("/api/auth/email/verify", JSON.stringify({ email: v, code: "123456" }));
    assert.equal(r.status, 400, `verify email=${JSON.stringify(v)}`);
    assert.equal((await r.json()).error, "bad_code");
    r = await viaWorker("/api/auth/email/verify", JSON.stringify({ email: "a@b.cc", code: v }));
    assert.equal(r.status, 400, `verify code=${JSON.stringify(v)}`);
    assert.equal((await r.json()).error, "bad_code");
  }
});

test("strings and numbers still work as before", async () => {
  // a string address is normalized and mailed
  let r = await viaApi("/api/auth/email/start", { email: " Shape@Example.com " });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(sentCodes[0].to, "shape@example.com");

  // a number is still read as text: not an address, so bad_email
  r = await viaApi("/api/auth/email/start", { email: 12345 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "bad_email");

  // short or empty codes are still bad_code
  for (const code of ["12345", 12345, 0, ""]) {
    r = await viaApi("/api/auth/email/verify", { email: "shape@example.com", code });
    assert.equal(r.status, 400, `code=${JSON.stringify(code)}`);
    assert.equal((await r.json()).error, "bad_code");
  }

  // a six-digit code sent as a number is still compared, and the right one is accepted
  const right = Number(sentCodes[0].code);
  const wrong = right === 999999 ? 100000 : right + 1;
  r = await viaApi("/api/auth/email/verify", { email: "shape@example.com", code: wrong });
  assert.equal((await r.json()).error, "code_wrong");
  r = await viaApi("/api/auth/email/verify", { email: "shape@example.com", code: right });
  const d = await r.json();
  assert.notEqual(d.error, "bad_code");
  assert.notEqual(d.error, "code_wrong");
  assert.equal(d.error, "wallet_first", "the code matched; this browser just has no wallet yet");
});
