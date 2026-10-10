// The "Is this link official?" checker knows the official accounts by their full links too (10 Oct 2026: it called
// https://x.com/VicinityCitySOL "not on our official list" while the bare @VicinityCitySOL passed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOfficial, OFFICIAL, SOCIAL_PROFILES } from "../src/official.js";

const isAddr = () => false;
const check = (q) => checkOfficial(q, isAddr, {});

test("official: the X account's links pass like its @handle", () => {
  assert.deepEqual(OFFICIAL.socials, ["@VicinityCitySOL"], "the @handles still come from one list");
  assert.equal(check("@VicinityCitySOL").verdict, "official");
  for (const q of ["https://x.com/VicinityCitySOL", "x.com/VicinityCitySOL", "https://x.com/vicinitycitysol", "https://www.x.com/VicinityCitySOL/",
    "https://twitter.com/VicinityCitySOL", "https://mobile.twitter.com/VicinityCitySOL", "https://x.com/VicinityCitySOL/status/1844000000000000000",
    "https://x.com/VicinityCitySOL?s=21"]) {
    const v = check(q);
    assert.equal(v.verdict, "official", q);
    assert.equal(v.kind, "social", q);
    assert.match(v.message, /official account on X/, q);
  }
});

test("official: any other X account, or X itself, is not us, and the answer names the real one", () => {
  for (const q of ["https://x.com/VicinityCitySOL_", "https://x.com/VicinityCity", "x.com/elonmusk", "https://x.com/i/flow/login", "https://x.com/search?q=VicinityCitySOL"]) {
    const v = check(q);
    assert.equal(v.verdict, "not_official", q);
    assert.equal(v.kind, "social", q);
    assert.match(v.message, /@VicinityCitySOL/, q);
  }
  assert.match(check("https://x.com/").message, /doesn't open an account/);
  assert.match(check("https://x.com/VicinityCity").message, /This X account is not us/);
});

test("official: only the real hosts count (no lookalike host, no host hidden in the path or the user part)", () => {
  for (const q of ["https://x.com.evil.io/VicinityCitySOL", "https://evil.io/x.com/VicinityCitySOL", "https://x.com@evil.io/VicinityCitySOL",
    "https://xx.com/VicinityCitySOL", "https://twitter.co/VicinityCitySOL", "https://evil.io/?u=https://x.com/VicinityCitySOL"]) {
    const v = check(q);
    assert.equal(v.verdict, "not_official", q);
    assert.notEqual(v.kind, "social", q);
  }
});

test("official: no Telegram is listed yet, so a t.me link is not on the list (it becomes official only by a public commit here)", () => {
  assert.equal(SOCIAL_PROFILES.some((p) => p.hosts.includes("t.me")), false);
  const v = check("https://t.me/VicinityCitySOL");
  assert.equal(v.verdict, "not_official");
  assert.match(v.message, /not on our official list/);
});
