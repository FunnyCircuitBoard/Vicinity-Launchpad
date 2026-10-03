// Found by the independent review of sign-up v2 (each test fails without its fix): on a phone with no wallet in the browser, step 3's
// "Open app" starts the sign-up again inside the wallet app (its browser keeps its own cookies), and the page did not say so; an old
// /connect page that was open (or whose first answer was lost) when the switch went to v2 ended at "Sign-in is being switched on";
// and a long e-mail address at the code step widened the whole page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { EMPTY_STATE, page } from "./helpers/fakedom.js";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const html = read("connect.html"), css = read("style.css"), connectJs = read("connect.js");
const win = {};
vm.runInContext(read("signup.js"), vm.createContext({ window: win }));
const P = win.VSignup.pure;
const atAccount = () => ({ ...EMPTY_STATE(), location: { done: true, community: { id: "5142056", name: "Utica", country: "US" } }, next: "account" });
const OK = { ok: true };
const serverFor = (answers) => async (path) => (typeof answers[path] === "function" ? answers[path]() : answers[path] ?? OK);
const atWallet = () => ({ ...atAccount(), terms: { done: true, version: "2026-10-01" }, account: { done: true, provider: "email", email: "a***@b.co" }, next: "wallet" });


const leadOf = async (opts) => (await page({ state: atWallet(), ...opts, api: serverFor({}) })).$("#su-wallet-lead");

test("step 3 on a phone with no wallet in the browser warns that 'Open app' starts the sign-up again", async () => {
  const lead = await leadOf({ isMobile: true });
  assert.equal(lead.hidden, false);
  assert.match(lead.textContent, /Last step\./);
  assert.match(lead.textContent, /Open app[^]*starts again from step 1/);
  assert.match(lead.textContent, /not carried over/);
});

test("step 3 does not give that warning on a computer, inside a wallet app, or when a wallet is there", async () => {
  for (const opts of [{ isMobile: false }, { isMobile: true, inApp: true }, { isMobile: true, wallets: [{ name: "Phantom" }] }]) {
    const lead = await leadOf(opts);
    assert.match(lead.textContent, /Last step\./);
    assert.doesNotMatch(lead.textContent, /Open app/, JSON.stringify(opts));
  }
  assert.doesNotMatch(P.walletLead(false), /Open app/);
  assert.match(P.walletLead(true), /Open app/);
});

/* ---- the old page meets the new sign-up ---- */

test("an old page whose wallet answer says 'signup' reloads into the new sign-up, not 'Sign-in is being switched on'", () => {
  const after = connectJs.slice(connectJs.indexOf("function after(d)"), connectJs.indexOf("function showSocial"));
  const at = (s) => after.indexOf(s);
  assert.ok(at('d.next === "signup"') > 0 && at("location.reload()") > 0, "it reloads");
  assert.ok(at('d.next === "signup"') < at("showSocial("), "before it can show the old social screen");
  assert.ok(at("signup.walletProven(d)") < at('d.next === "signup"'), "the new page's own handler still comes first");
});

/* ---- long e-mail addresses ---- */

test("a long e-mail address at the code step wraps instead of widening the page", () => {
  assert.match(css, /#su-code-to, #rs-sent-to \{ overflow-wrap: anywhere; \}/);
  assert.match(html, /id="su-code-to"/);
  assert.match(html, /id="rs-sent-to"/);
});

