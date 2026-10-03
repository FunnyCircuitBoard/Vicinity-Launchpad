// Passwords (src/password.js): format, normalization, pepper, constant-time compare, corrupt input, rules, blocklist.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { hashPassword, verifyPassword, checkPassword, constantTimeEqual, currentRounds, _stats, PASSWORD_MIN, PASSWORD_MAX, PBKDF2_ROUNDS } from "../src/password.js";
import { COMMON, COMMON_LIST } from "../src/common-passwords.js";

const FAST = { PASSWORD_ITERATIONS: "1000" };            // 1,000 rounds keeps the many hashes in this file quick
const PEPPER = { ...FAST, PASSWORD_PEPPER: "test-pepper-one-not-a-secret-0123456789abcdef" };
const OTHER_PEPPER = { ...FAST, PASSWORD_PEPPER: "test-pepper-two-not-a-secret-0123456789abcdef" };
const FORMAT = /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})(\$p1)?$/;
const derivesDuring = async (fn) => { const before = _stats.derives; const r = await fn(); return [r, _stats.derives - before]; };

// ---- hashing ----

test("a hash has exactly the documented format, with the 100,000-round default and no pepper field", async () => {
  const h = await hashPassword({}, "correct horse battery staple");
  const m = h.match(FORMAT);
  assert.ok(m, h);
  assert.equal(m[1], "100000");
  assert.equal(m[4], undefined, "no pepper, no $p1");
  assert.ok(!h.includes("correct"));
});

test("real cost: a full 100,000-round hash and check finish well under two seconds, and the rounds are in the stored value", async (t) => {
  const t0 = performance.now();
  const h = await hashPassword({}, "correct horse battery staple");
  const hashMs = performance.now() - t0;
  const t1 = performance.now();
  assert.deepEqual(await verifyPassword({}, h, "correct horse battery staple"), { ok: true, rehash: false });
  const verifyMs = performance.now() - t1;
  assert.match(h, /^pbkdf2-sha256\$100000\$/);
  assert.ok(hashMs < 2000 && verifyMs < 2000, `hash ${hashMs.toFixed(0)} ms, verify ${verifyMs.toFixed(0)} ms`);
  t.diagnostic(`one 100,000-round hash: ${hashMs.toFixed(0)} ms, one check: ${verifyMs.toFixed(0)} ms`);
});

test("every hash gets its own random 16-byte salt, and both hashes of the same password verify", async () => {
  const a = await hashPassword(FAST, "correct horse battery staple"), b = await hashPassword(FAST, "correct horse battery staple");
  assert.notEqual(a, b);
  const [sa, sb] = [a.match(FORMAT)[2], b.match(FORMAT)[2]];
  assert.notEqual(sa, sb);
  assert.equal(Buffer.from(sa, "base64url").length, 16);
  assert.equal(Buffer.from(a.match(FORMAT)[3], "base64url").length, 32);
  assert.equal((await verifyPassword(FAST, a, "correct horse battery staple")).ok, true);
  assert.equal((await verifyPassword(FAST, b, "correct horse battery staple")).ok, true);
});

test("right password ok, wrong password not, near misses not", async () => {
  const h = await hashPassword(FAST, "Correct Horse 42!");
  assert.deepEqual(await verifyPassword(FAST, h, "Correct Horse 42!"), { ok: true, rehash: false });
  for (const wrong of ["correct horse 42!", "Correct Horse 42", "Correct Horse 42! ", " Correct Horse 42!", "", "x", "Correct Horse 43!"]) {
    assert.deepEqual(await verifyPassword(FAST, h, wrong), { ok: false, rehash: false }, JSON.stringify(wrong));
  }
});

test("hashPassword refuses what it could never verify, and never echoes the password", async () => {
  await assert.rejects(hashPassword(FAST, 12345678901), TypeError);
  await assert.rejects(hashPassword(FAST, undefined), TypeError);
  await assert.rejects(hashPassword(FAST, "x".repeat(1025)), RangeError);
  const h = await hashPassword(FAST, "x".repeat(1024));
  assert.equal((await verifyPassword(FAST, h, "x".repeat(1024))).ok, true);
});

test("PASSWORD_ITERATIONS can only lower the cost: never above 100,000, never below 1,000, garbage falls back to 100,000", () => {
  assert.equal(currentRounds({}), 100000);
  assert.equal(currentRounds(undefined), 100000);
  assert.equal(currentRounds({ PASSWORD_ITERATIONS: "1000" }), 1000);
  assert.equal(currentRounds({ PASSWORD_ITERATIONS: 5000 }), 5000);
  assert.equal(currentRounds({ PASSWORD_ITERATIONS: "99999" }), 99999);
  assert.equal(currentRounds({ PASSWORD_ITERATIONS: "100000" }), 100000);
  assert.equal(currentRounds({ PASSWORD_ITERATIONS: "100001" }), 100000, "hard cap");
  assert.equal(currentRounds({ PASSWORD_ITERATIONS: "600000" }), 100000, "the guideline number is not reachable here");
  assert.equal(currentRounds({ PASSWORD_ITERATIONS: "1000000000" }), 100000);
  for (const junk of ["", "0", "-5", "10", "999", "abc", "1e2", "1000.5", null, NaN, {}, [], "Infinity"]) assert.equal(currentRounds({ PASSWORD_ITERATIONS: junk }), 100000, `junk ${String(junk)}`);
  assert.equal(PBKDF2_ROUNDS, 100000);
});

test("the stored rounds follow PASSWORD_ITERATIONS", async () => {
  assert.match(await hashPassword({ PASSWORD_ITERATIONS: "2500" }, "correct horse battery staple"), /^pbkdf2-sha256\$2500\$/);
  assert.match(await hashPassword({ PASSWORD_ITERATIONS: "7" }, "correct horse battery staple"), /^pbkdf2-sha256\$100000\$/, "a number below the floor is ignored, not obeyed");
});

// ---- normalization ----

test("the same text typed on any device is the same password (NFKC)", async () => {
  const composed = "Café au lait 2026", decomposed = "Café au lait 2026";
  assert.notEqual(composed, decomposed);
  const h = await hashPassword(FAST, composed);
  assert.equal((await verifyPassword(FAST, h, decomposed)).ok, true);
  const wide = "Ｃorrect-Ｈorse-９９", plain = "Correct-Horse-99";    // full-width letters and digits
  const h2 = await hashPassword(FAST, wide);
  assert.equal((await verifyPassword(FAST, h2, plain)).ok, true);
  assert.equal((await verifyPassword(FAST, await hashPassword(FAST, plain), wide)).ok, true);
  assert.equal((await verifyPassword(FAST, h, "cafe au lait 2026")).ok, false, "accents still matter");
  assert.equal((await verifyPassword(FAST, h2, "correct-horse-99")).ok, false, "case still matters");
});

// ---- the pepper ----

test("pepper: unset gives no $p1, set gives $p1 and verifies only with the same pepper", async () => {
  const plain = await hashPassword(FAST, "correct horse battery staple");
  const peppered = await hashPassword(PEPPER, "correct horse battery staple");
  assert.ok(!plain.endsWith("$p1") && peppered.endsWith("$p1"));
  assert.ok(FORMAT.test(peppered));
  assert.deepEqual(await verifyPassword(PEPPER, peppered, "correct horse battery staple"), { ok: true, rehash: false });
  assert.equal((await verifyPassword(PEPPER, peppered, "wrong horse battery staple")).ok, false);
  assert.equal((await verifyPassword(OTHER_PEPPER, peppered, "correct horse battery staple")).ok, false, "a different pepper never matches");
  // the pepper really is part of the hash: with the marker removed the stored value does not verify without the pepper either
  assert.equal((await verifyPassword(FAST, peppered.slice(0, -3), "correct horse battery staple")).ok, false);
});

test("pepper: an empty PASSWORD_PEPPER counts as no pepper", async () => {
  const h = await hashPassword({ ...FAST, PASSWORD_PEPPER: "" }, "correct horse battery staple");
  assert.ok(!h.endsWith("$p1"));
  assert.deepEqual(await verifyPassword({ ...FAST, PASSWORD_PEPPER: "" }, h, "correct horse battery staple"), { ok: true, rehash: false });
});

test("pepper: a peppered hash with no pepper configured fails closed (even for the right password), says so once, costs one derive", async () => {
  const peppered = await hashPassword(PEPPER, "correct horse battery staple");
  const err = mock.method(console, "error", () => {});
  try {
    const [r, derives] = await derivesDuring(() => verifyPassword(FAST, peppered, "correct horse battery staple"));
    assert.deepEqual(r, { ok: false, rehash: false });
    assert.equal(derives, 1);
    assert.equal(err.mock.callCount(), 1);
    assert.deepEqual(err.mock.calls[0].arguments, ["pepper missing"], "no password, no hash, no address in the message");
  } finally { err.mock.restore(); }
});

test("pepper added later: an old unpeppered hash still works once, asks to be rewritten, and the rewrite is peppered", async () => {
  const old = await hashPassword(FAST, "correct horse battery staple");
  const r = await verifyPassword(PEPPER, old, "correct horse battery staple");
  assert.deepEqual(r, { ok: true, rehash: true });
  assert.deepEqual(await verifyPassword(PEPPER, old, "wrong horse battery staple"), { ok: false, rehash: false }, "a wrong password never asks for a rewrite");
  const upgraded = await hashPassword(PEPPER, "correct horse battery staple");
  assert.ok(upgraded.endsWith("$p1"));
  assert.deepEqual(await verifyPassword(PEPPER, upgraded, "correct horse battery staple"), { ok: true, rehash: false });
  // and the pepper can be switched off again only by the owner removing it: the upgraded hash then fails closed
  const err = mock.method(console, "error", () => {});
  try { assert.equal((await verifyPassword(FAST, upgraded, "correct horse battery staple")).ok, false); } finally { err.mock.restore(); }
});

test("rehash when the stored hash used fewer rounds than now, never the other way round", async () => {
  const weak = await hashPassword({ PASSWORD_ITERATIONS: "1000" }, "correct horse battery staple");
  assert.match(weak, /^pbkdf2-sha256\$1000\$/);
  assert.deepEqual(await verifyPassword({ PASSWORD_ITERATIONS: "2000" }, weak, "correct horse battery staple"), { ok: true, rehash: true });
  const strong = await hashPassword({ PASSWORD_ITERATIONS: "2000" }, "correct horse battery staple");
  assert.deepEqual(await verifyPassword({ PASSWORD_ITERATIONS: "1000" }, strong, "correct horse battery staple"), { ok: true, rehash: false }, "lowering the setting never downgrades stored hashes");
  assert.deepEqual(await verifyPassword({ PASSWORD_ITERATIONS: "2000" }, strong, "correct horse battery staple"), { ok: true, rehash: false });
});

// ---- constant-time compare, corrupt input, equal work ----

test("constantTimeEqual: correct answers, and it reads every byte of both inputs whatever the difference", () => {
  const a = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal(constantTimeEqual(a, Uint8Array.from(a)), true);
  const first = Uint8Array.from(a); first[0] ^= 1;
  const last = Uint8Array.from(a); last[31] ^= 0x80;
  assert.equal(constantTimeEqual(a, first), false);
  assert.equal(constantTimeEqual(a, last), false);
  assert.equal(constantTimeEqual(a, a.slice(0, 31)), false);
  assert.equal(constantTimeEqual(a.slice(0, 31), a), false);
  assert.equal(constantTimeEqual(new Uint8Array(0), new Uint8Array(0)), true);
  assert.equal(constantTimeEqual(new Uint8Array(0), new Uint8Array(1)), false);
  // no early exit: count every element read
  const counted = (bytes) => { const reads = new Set(); const p = new Proxy(bytes, { get(t, k) { if (typeof k === "string" && /^\d+$/.test(k)) reads.add(Number(k)); const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; } }); return { p, reads }; };
  for (const other of [first, last, Uint8Array.from(a)]) {
    const x = counted(a), y = counted(other);
    constantTimeEqual(x.p, y.p);
    assert.equal(x.reads.size, 32);
    assert.equal(y.reads.size, 32);
  }
});

test("a corrupt or foreign stored value never throws, never verifies, and still costs exactly one derive", async () => {
  const good = await hashPassword(FAST, "correct horse battery staple");
  const [, , salt, hash] = good.split("$");
  const bad = [
    "", "x", "$", "$$$", "pbkdf2-sha256", "pbkdf2-sha256$1000", "pbkdf2-sha256$1000$a$b", good + "$", good + "$p2", good + "$p1$x", good + "x", " " + good,
    `pbkdf2-sha1$1000$${salt}$${hash}`, `pbkdf2-sha256$0$${salt}$${hash}`, `pbkdf2-sha256$999$${salt}$${hash}`, `pbkdf2-sha256$100001$${salt}$${hash}`,
    `pbkdf2-sha256$1000000000$${salt}$${hash}`, `pbkdf2-sha256$-1000$${salt}$${hash}`, `pbkdf2-sha256$1e3$${salt}$${hash}`, `pbkdf2-sha256$01000$${salt}$${hash}`,
    `pbkdf2-sha256$1000.0$${salt}$${hash}`, `pbkdf2-sha256$abc$${salt}$${hash}`, `pbkdf2-sha256$1000$${salt.slice(1)}$${hash}`, `pbkdf2-sha256$1000$${salt}A$${hash}`,
    `pbkdf2-sha256$1000$${salt}$${hash.slice(1)}`, `pbkdf2-sha256$1000$${salt}$${hash}A`, `pbkdf2-sha256$1000$${salt.replace(/./, "!")}$${hash}`,
    `pbkdf2-sha256$1000$${"A".repeat(22)}$${"B".repeat(42)}!`, `pbkdf2-sha256$1000$${salt}$${hash.slice(0, 42)}B`, "x".repeat(500), "pbkdf2-sha256$".repeat(40),
    null, undefined, 42, true, {}, [], ["a"], () => 1,
  ];
  for (const stored of bad) {
    const [r, derives] = await derivesDuring(() => verifyPassword(FAST, stored, "correct horse battery staple"));
    assert.deepEqual(r, { ok: false, rehash: false }, `value: ${String(stored).slice(0, 60)}`);
    assert.equal(derives, 1, `exactly one derive for: ${String(stored).slice(0, 60)}`);
  }
});

test("equal work on every path: unknown address (null), wrong password, right password, corrupt value, odd input, each exactly one derive", async () => {
  const h = await hashPassword(FAST, "correct horse battery staple");
  const cases = [
    [null, "anything at all"], [undefined, "anything at all"], [h, "wrong horse battery staple"], [h, "correct horse battery staple"], ["garbage", "x"],
    [h, ""], [h, undefined], [h, null], [h, 12345], [h, {}], [h, "x".repeat(5000)], [null, "x".repeat(5000)], [null, undefined],
  ];
  for (const [stored, pw] of cases) {
    const [r, derives] = await derivesDuring(() => verifyPassword(FAST, stored, pw));
    assert.equal(derives, 1, `${String(stored).slice(0, 12)} / ${String(pw).slice(0, 12)}`);
    assert.equal(r.ok, stored === h && pw === "correct horse battery staple");
  }
});

test("the stand-in derive for an unknown address uses the same number of rounds as a real check", async () => {
  const rounds = [];
  const original = crypto.subtle.deriveBits;
  crypto.subtle.deriveBits = function (algo, ...rest) { rounds.push(algo.iterations); return original.call(this, algo, ...rest); };
  try {
    const env = { PASSWORD_ITERATIONS: "3000" };
    const h = await hashPassword(env, "correct horse battery staple");   // 3000
    await verifyPassword(env, h, "wrong horse battery staple");           // 3000
    await verifyPassword(env, null, "wrong horse battery staple");        // must be 3000 too
    await verifyPassword(env, "garbage", "wrong horse battery staple");   // and this
    assert.deepEqual(rounds, [3000, 3000, 3000, 3000]);
    rounds.length = 0;
    const full = await hashPassword({}, "correct horse battery staple");
    await verifyPassword({}, null, "x");
    assert.deepEqual(rounds, [100000, 100000]);
    void full;
  } finally { delete crypto.subtle.deriveBits; }
});

// ---- the rules ----

test("policy: not text is bad_password", () => {
  for (const v of [undefined, null, 12345678901, {}, [], true, () => "abcdefghijkl"]) assert.equal(checkPassword(v, "a@example.com"), "bad_password");
});

test("policy: length counts characters people see, 10 to 128 after NFKC", () => {
  assert.equal(PASSWORD_MIN, 10);
  assert.equal(PASSWORD_MAX, 128);
  assert.equal(checkPassword("", "a@example.com"), "password_short");
  assert.equal(checkPassword("Tr0ub4dor", "a@example.com"), "password_short", "nine characters");
  assert.equal(checkPassword("k7Qp2mXv9", "a@example.com"), "password_short");
  assert.equal(checkPassword("k7Qp2mXv9z", "a@example.com"), null, "ten characters");
  const mixed = (n) => Array.from({ length: n }, (_, i) => "kQ7pXv2mZjR9wTb4HnYc8sLd3gFa5eUo6iBt".charAt((i * 7) % 36)).join("");
  assert.equal(checkPassword(mixed(128), "a@example.com"), null);
  assert.equal(checkPassword(mixed(129), "a@example.com"), "password_long");
  assert.equal(checkPassword(mixed(5000), "a@example.com"), "password_long");
  assert.equal(checkPassword("x".repeat(10000), "a@example.com"), "password_long", "huge input is refused before any work");
  // emoji are two UTF-16 units but one character: nine of them are short, ten are fine
  const emoji = ["\u{1F600}", "\u{1F680}", "\u{1F355}", "\u{1F984}", "\u{1F308}", "\u{1F3B8}", "\u{1F40C}", "\u{1F33B}", "\u{1F9C0}", "\u{1F3AF}"];
  assert.equal(checkPassword(emoji.slice(0, 9).join(""), "a@example.com"), "password_short");
  assert.equal(checkPassword(emoji.join(""), "a@example.com"), null);
  // a decomposed accent is one character after NFKC: nine visible letters are still short
  assert.equal(checkPassword("Café aule", "a@example.com"), "password_short");
  assert.equal(checkPassword("Café au lait", "a@example.com"), null);
  // full-width characters normalize to plain ones before counting (and before the common check)
  assert.equal(checkPassword("ｐａｓｓｗｏｒｄ１２３", "a@example.com"), "password_common");
});

test("policy: common passwords, with digits or symbols added on the end, in any capitals, are refused", () => {
  const refused = [
    "password123", "Password1234!", "PASSWORD123456", "qwertyuiop", "Qwerty12345", "iloveyou2026", "ILoveYou!!!!!!", "letmein12345",
    "vicinity2026", "Vicinity-2026", "VICINITY_2026!", "vicinity.city", "solana2026!!", "Solana123456", "summer2024!!", "monkey1234567", "football2026",
    "welcome12345", "dragon!@#$%^&*", "1234567890", "12345678910", "0123456789", "123456789012", "qwertyuiop123", "p@ssw0rd1234", "trustno11234", "abc123456789", "Qwerty123!@#", "trustno1!!!!!",
    "ｐａｓｓｗｏｒｄ１２３",
  ];
  for (const p of refused) assert.equal(checkPassword(p, "someone@example.com"), "password_common", p);
});

test("policy: one character repeated, short patterns repeated, plain runs, and a common word repeated are refused", () => {
  for (const p of ["aaaaaaaaaa", "AAAAAAAAAAAA", "1111111111", "0000000000000", "          ", "!!!!!!!!!!", "ああああああああああ",
    "1212121212", "abababababab", "123123123123", "abcabcabcabc", "xyzxyzxyzxyz", "k7k7k7k7k7k7",
    "abcdefghij", "klmnopqrst", "9876543210", "zyxwvutsrq", "ABCDEFGHIJKL", "0123456789012", "12345678901234", "98765432109876", "5432109876543",
    "passwordpassword", "iloveyouiloveyou", "vicinityvicinity", "qwertyqwerty"]) {
    assert.equal(checkPassword(p, "someone@example.com"), "password_common", JSON.stringify(p));
  }
});

test("policy: good passwords and passphrases are accepted, including ones that merely contain a common word", () => {
  for (const p of ["k7Qp2mXv9z", "correct horse battery staple", "My dog Rex ate 3 socks!", "xylophone-quartz-lamp-47", "vicinity is a nice place to live",
    "I live near Syracuse NY", "Tr0ub4dor&3-horse", "monkeybusiness-rocks", "football-with-grandpa", "the summer of 2024 was long", "été chaud en juillet",
    "天气很好今天去公园玩吧", "abcdefghijk1x", "a1b2c3d4e5f6g7", "1357924680-zyx"]) {
    assert.equal(checkPassword(p, "someone@example.com"), null, p);
  }
});

test("policy: not the e-mail address and not the part before the @ (any capitals, with spaces round the address)", () => {
  assert.equal(checkPassword("someone.private@example.com", "someone.private@example.com"), "password_is_email");
  assert.equal(checkPassword("Someone.Private@Example.com", "someone.private@example.com"), "password_is_email");
  assert.equal(checkPassword("someone.private@example.com", " Someone.Private@EXAMPLE.com "), "password_is_email");
  assert.equal(checkPassword("marguerite.dupont", "marguerite.dupont@example.com"), "password_is_email");
  assert.equal(checkPassword("MARGUERITE.DUPONT", "Marguerite.Dupont@example.com"), "password_is_email");
  assert.equal(checkPassword("marguerite.dupont", "someone.else@example.com"), null);
  assert.equal(checkPassword("marguerite.dupont", undefined), null);
  assert.equal(checkPassword("marguerite.dupont", ""), null);
  assert.equal(checkPassword("marguerite.dupont", null), null);
  assert.equal(checkPassword("marguerite.dupont", 42), null);
  assert.equal(checkPassword("marguerite.dupont2", "marguerite.dupont@example.com"), null, "only an exact match");
});

test("policy: the first reason wins in the documented order (short, long, common, e-mail), and a reason is only a code", () => {
  assert.equal(checkPassword("password", "password@example.com"), "password_short");
  assert.equal(checkPassword("password1234567890", "x@example.com"), "password_common");
  const address = "qwertyuiop@example.com";
  assert.equal(checkPassword("qwertyuiop", address), "password_common", "common is checked before e-mail");
  const results = ["short", "password123", "k7Qp2mXv9z", "someone.private@example.com"].map((p) => checkPassword(p, "someone.private@example.com"));
  assert.deepEqual(results, ["password_short", "password_common", null, "password_is_email"]);
});

// ---- the blocklist file ----

test("blocklist: lowercase, unique, sorted, printable, a sensible size, and the words this site cares about", () => {
  assert.equal(COMMON_LIST.length, COMMON.size, "no duplicates");
  assert.deepEqual([...COMMON_LIST], [...COMMON_LIST].sort(), "sorted");
  for (const w of COMMON_LIST) {
    assert.ok(w.length > 0 && w.length <= 40, `length of ${JSON.stringify(w)}`);
    assert.equal(w, w.toLowerCase(), `lowercase: ${w}`);
    assert.match(w, /^[\x21-\x7e]+$/, `printable, no spaces: ${w}`);
  }
  assert.ok(COMMON.size >= 2000 && COMMON.size <= 20000, `size ${COMMON.size}`);
  for (const w of ["password", "123456", "qwerty", "iloveyou", "letmein", "welcome", "monkey", "dragon", "vicinity", "solana", "bitcoin", "1234567890", "qwertyuiop"]) assert.ok(COMMON.has(w), w);
  assert.ok(!COMMON.has(""), "no empty entry");
});
