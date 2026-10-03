// Found by the independent review of sign-up v2 (fails without the fix): the public FAQ and the rules page said "No passwords", which
// stops being true the moment the switch goes to v2 (an e-mail account then keeps a salted password hash). The wording is true in both
// modes, so the pages are the same with the switch off or on (they are static files, the switch cannot change them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const PAGES = ["index.html", "rules.html"]; // test/site.test.js already checks that the built pages match their sources

test("no page says 'No passwords', neither the built page nor its source", () => {
  for (const f of PAGES) for (const where of [`public/${f}`, `scripts/pages/src/${f}`]) assert.doesNotMatch(read(where), /No passwords/i, where);
});

test("the FAQ and the rules say what is kept about a password: only a salted hash, never one anyone could read", () => {
  assert.match(read("public/index.html"), /We never keep a password anyone could read: if an e-mail account has one, only a salted hash of it is stored\./);
  assert.match(read("public/rules.html"), /We never keep a password anyone could read \(an e-mail account that has one keeps only a salted hash of it\)/);
});

test("the sentences the privacy checks of test/site.test.js pin are still there, and the connect page still says it keeps a hashed password", () => {
  assert.match(read("public/index.html"), /the e-mail address itself \(it is your account id\) and a hash of the 6-digit code, which expires in 10 minutes/);
  assert.match(read("public/rules.html"), /the address itself \(it is your account id\) and a hash of the code/);
  assert.match(read("public/connect.html"), /a scrambled \(hashed\) copy of your password/);
});

test("'How do I get my dashboard?' does not say which comes first, the wallet or the login (the new sign-up asks for the location first, the wallet last)", () => {
  const faq = (read("public/index.html").match(/How do I get my dashboard\?<\/summary><p>([^]*?)<\/p>/) || [])[1];
  assert.ok(faq, "the answer is there");
  assert.doesNotMatch(faq, /\bthen sign in\b|\bfirst\b/i);
  assert.match(faq, /Connect a Solana wallet/);
  assert.match(faq, /sign in with Google or an e-mail address/);
});
