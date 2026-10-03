// Found by the independent review of sign-up v2 (fails without the fix): the common-password rules were bypassed by padding with
// spaces, tabs or invisible characters ("password" plus two spaces is 10 characters and was accepted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPassword } from "../src/password.js";

const ME = "someone@example.com";

test("a common password padded with spaces, tabs or invisible characters is still common", () => {
  for (const p of ["password  ", "password​​​", "  password  ", "letmein\t\t\t", "iloveyou  ", "pass­word12", "p a s s w o r d", "Password 1234 ",
    "password　　", "⁠password⁠⁠", "abcdefg hij", "1234 5678 90", "ab ab ab ab ab", "passwordpassword "]) {
    assert.equal(checkPassword(p, ME), "password_common", JSON.stringify(p));
  }
});

test("only invisible or blank characters is refused as before", () => {
  for (const p of ["          ", "​".repeat(12), "\t".repeat(10), "　".repeat(10)]) assert.equal(checkPassword(p, ME), "password_common", JSON.stringify(p));
});

test("an e-mail address or its first part, padded, is still the e-mail address", () => {
  assert.equal(checkPassword("someone@example.com  ", ME), "password_is_email");
  assert.equal(checkPassword("  someone@example.com", ME), "password_is_email");
  assert.equal(checkPassword("marguerite.dupont  ", "marguerite.dupont@example.com"), "password_is_email");
  assert.equal(checkPassword("marguerite dupont", "marguerite.dupont@example.com"), null, "a different text is fine");
});

test("passphrases with real words, and passwords with a space inside, are still accepted", () => {
  for (const p of ["correct horse battery staple", "My dog Rex ate 3 socks!", "I live near Syracuse NY", "the summer of 2024 was long", "vicinity is a nice place to live",
    "k7Qp2mXv9z", "k7Qp 2mXv 9z", "my pass word is very long", "été chaud en juillet", "天气很好 今天去公园玩吧"]) {
    assert.equal(checkPassword(p, ME), null, p);
  }
});

test("length is still counted on what the person typed (padding does not make a short password long enough by itself)", () => {
  assert.equal(checkPassword("k7Qp2mXv9", ME), "password_short");
  assert.equal(checkPassword("k7Qp2mXv9 ", ME), null, "ten characters, one a space: the same as before");
});
