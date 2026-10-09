// Found by the independent review of sign-up v2 (each test fails without its fix), all in step 2 of the new page: a double tap on
// "Send a new code" sent two requests and showed a false error; a failed submit by keyboard dropped the keyboard to the page; "New here"
// with an e-mail that already has an account did not say the typed password was ignored; and inside a wallet app the page sent a NEW
// account to Safari for Google, which loops (a wallet cannot be proven there). The controller runs against a fake page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { EMPTY_STATE, callsTo, page, submit, tap } from "./helpers/fakedom.js";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const html = read("connect.html");
const win = {};
vm.runInContext(read("signup.js"), vm.createContext({ window: win }));
const P = win.VSignup.pure;
const atAccount = () => ({ ...EMPTY_STATE(), location: { done: true, community: { id: "5142056", name: "Utica", country: "US" } }, next: "account" });
const OK = { ok: true };
const serverFor = (answers) => async (path) => (typeof answers[path] === "function" ? answers[path]() : answers[path] ?? OK);

/** The e-mail form of step 2, filled in and sent. */
async function sendCodeFrom(p, email = "ada@example.com") {
  p.$("#su-email").value = email; p.$("#su-pw").value = "correct horse battery staple"; p.$("#su-terms").checked = true;
  await submit(p.$("#su-email-form"));
}


test("'Send a new code': two quick taps send one request, and the person is not told 'a code was just sent'", async () => {
  const p = await page({ state: atAccount(), api: serverFor({ "/api/signup/start": { ok: true, state: atAccount() } }) });
  await sendCodeFrom(p);
  assert.equal(callsTo(p, "/api/signup/email").length, 1, "the first code");
  await p.flush(); // the minute is over
  const resend = p.$("#su-code-resend");
  assert.equal(resend.disabled, false);
  await Promise.all([tap(resend), tap(resend)]);
  assert.equal(callsTo(p, "/api/signup/email").length, 2, "one more request, not two");
  assert.equal(p.$("#su-code-error").textContent, "");
  assert.equal(resend.disabled, true, "and the minute starts again");
});

test("'Send a new code' that fails can be tried again", async () => {
  let sends = 0;
  const p = await page({ state: atAccount(), api: serverFor({ "/api/signup/email": () => (sends++ ? { ok: false, error: "email_unavailable" } : OK) }) });
  await sendCodeFrom(p);
  await p.flush();
  await tap(p.$("#su-code-resend"));
  assert.match(p.$("#su-code-error").textContent, /can't send e-mails/);
  assert.equal(p.$("#su-code-resend").disabled, false, "the button works again after a refusal");
});

test("a failed submit by keyboard leaves the keyboard on the button (a disabled button drops it to the page)", async () => {
  const p = await page({ state: atAccount(), api: serverFor({ "/api/signup/email/verify": { ok: false, error: "code_wrong", left: 3 } }) });
  await sendCodeFrom(p);
  p.$("#su-code").value = "123456";
  const verify = p.$("#su-code-verify");
  verify.focus(); // Enter or Space on it
  await submit(p.$("#su-code-form"));
  assert.match(p.$("#su-code-error").textContent, /3 tries left/);
  assert.equal(p.doc.activeElement, verify, "focus is back on Verify, not on the page");
});

test("focus is not pulled back when the page has moved it on", async () => {
  const p = await page({ state: atAccount(), api: serverFor({ "/api/signup/email": OK }) });
  p.$("#su-email").value = "ada@example.com"; p.$("#su-pw").value = "correct horse battery staple"; p.$("#su-terms").checked = true;
  const send = p.$("#su-email-send");
  send.focus();
  await submit(p.$("#su-email-form"));
  assert.equal(p.doc.activeElement, p.$("#su-code"), "after a good send the code box has the keyboard");
});

test("New here with an e-mail that already has an account: the person is told the typed password was not saved, and has time to read it", async () => {
  const p = await page({ state: atAccount(), api: serverFor({ "/api/signup/email/verify": { ok: true, existing: true, isNew: false, next: "/dashboard" } }) });
  await sendCodeFrom(p);
  p.$("#su-code").value = "123456";
  await submit(p.$("#su-code-form"));
  assert.equal(p.$("#done-sub").textContent, P.SAME_EMAIL);
  assert.match(P.SAME_EMAIL, /already has a Vicinity account/);
  assert.match(P.SAME_EMAIL, /password you just typed was not saved/);
  assert.match(P.SAME_EMAIL, /Forgot or never set a password\?/, "points at the button on the Log in tab");
  assert.match(html, />Forgot or never set a password\? E-mail me a code</);
  assert.ok(p.delays.includes(5000) && !p.delays.includes(1200), "the page waits longer than usual before leaving: " + p.delays.join());
  await p.flush();
  assert.deepEqual(p.assigned, ["/dashboard"]);
});

test("a normal sign-in still leaves after 1.2 seconds", async () => {
  const p = await page({ mode: "login", api: serverFor({ "/api/auth/email/login": { ok: true, next: "/dashboard" } }) });
  p.$("#lg-email").value = "ada@example.com"; p.$("#lg-pw").value = "correct horse battery staple";
  await submit(p.$("#lg-form"));
  assert.ok(p.delays.includes(1200), p.delays.join());
});

test("inside a wallet app the account step says to use e-mail here, or Safari or Chrome for Google (an account needs no wallet now, so nothing loops)", () => {
  const callout = (html.match(/<p class="callout small" id="su-inapp"[^>]*>([^]*?)<\/p>/) || [])[1];
  assert.ok(callout, "the callout is there");
  assert.match(callout, /Google cannot sign you in inside a wallet app\. Use e-mail here, or open <strong>vicinity\.city\/connect<\/strong> in Safari or Chrome\./);
  assert.match(callout, /id="su-copy"/, "one tap copies the link for Safari");
  for (const id of ["lg-inapp", "login-inapp"]) assert.match(html, new RegExp(`id="${id}"[^>]*>[^]*?Safari or Chrome`), `${id}: on the Log in tab the same advice`);
});
