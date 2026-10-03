// Found by the independent review of sign-up v2 (fails without the fix): on the Log in tab, after one reset code had been sent, a later
// refusal on the first form was written into the hidden second form, so the person saw nothing. The page also now says, when a reset
// is refused for too many tries, that the wallet always works. The controller runs against a fake page (test/helpers/fakedom.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { page, submit, tap } from "./helpers/fakedom.js";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const win = {};
vm.runInContext(read("signup.js"), vm.createContext({ window: win }));
const P = win.VSignup.pure;
const OK = { ok: true };
const serverFor = (answers) => async (path) => (typeof answers[path] === "function" ? answers[path]() : answers[path] ?? OK);


test("reset: a refusal after a code was already sent shows on the form that is on screen, not in the hidden one", async () => {
  let refuse = false;
  const p = await page({ mode: "login", api: serverFor({ "/api/auth/password/reset/start": () => (refuse ? { ok: false, error: "too_soon" } : OK) }) });
  await tap(p.$("#lg-forgot"));
  p.$("#rs-email").value = "ada@example.com";
  await submit(p.$("#rs-form1"));
  assert.equal(p.$("#rs-form2").hidden, false, "the code form is open after the first send");
  await tap(p.$("#rs-back")); await tap(p.$("#lg-forgot")); // back to log in, and open it again: the first form shows
  assert.equal(p.$("#rs-form1").hidden, false);
  assert.equal(p.$("#rs-form2").hidden, true);
  refuse = true;
  p.$("#rs-email").value = "ada@example.com";
  await submit(p.$("#rs-form1"));
  assert.match(p.$("#rs-email-error").textContent, /A code was just sent/, "the person sees it where they are looking");
  assert.equal(p.$("#rs-code-error").textContent, "", "nothing is written into the form nobody can see");
});

test("reset: 'Send a new code' that is refused says so in the code form, and a later success clears it", async () => {
  let refuse = false;
  const p = await page({ mode: "login", api: serverFor({ "/api/auth/password/reset/start": () => (refuse ? { ok: false, error: "too_soon" } : OK) }) });
  await tap(p.$("#lg-forgot"));
  p.$("#rs-email").value = "ada@example.com";
  await submit(p.$("#rs-form1"));
  refuse = true;
  await p.flush();
  await tap(p.$("#rs-resend"));
  assert.match(p.$("#rs-code-error").textContent, /A code was just sent/);
  assert.equal(p.$("#rs-email-error").textContent, "");
  refuse = false;
  await p.flush();
  await tap(p.$("#rs-resend"));
  assert.equal(p.$("#rs-code-error").textContent, "", "the old refusal is gone once a code went out");
});

test("reset: being over the limit says the wallet always works, for the reset form", () => {
  assert.match(P.errText("slow_down", "reset"), /log in with your wallet/);
  assert.match(P.errText("too_many", "reset"), /Wait an hour[^]*wallet/);
  assert.doesNotMatch(P.errText("slow_down"), /wallet/, "the plain sentence is unchanged");
  assert.match(P.errText("too_many"), /Wait an hour/);
  assert.equal(P.resetField(true), "rs-email");
  assert.equal(P.resetField(false), "rs-code");
});

