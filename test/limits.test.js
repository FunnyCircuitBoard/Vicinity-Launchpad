// Attempt counters for people who are not signed in (src/limits.js): atomic, windowed, refundable, and anonymous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { d1 } from "./helpers/d1.js";
import { slowDb } from "./helpers/slowdb.js";
import { ensureSignupSchema } from "../src/store.js";
import { limitKey, clientKey, hits, check, refund } from "../src/limits.js";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const HOUR = 3600_000, MIN = 60_000;
async function world(extra = {}) {
  const env = { DB: d1(), ...extra };
  await ensureSignupSchema(env.DB);
  return env;
}
const row = (env, key) => env.DB.prepare("SELECT n, window_start FROM auth_limits WHERE key = ?").bind(key).first();
const req = (ip) => new Request("https://vicinity.test/x", { headers: ip === undefined ? {} : { "cf-connecting-ip": ip } });

test("60 parallel hits on one key get the distinct counts 1..60 (nobody shares a number)", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const slow = { ...env, DB: slowDb(env.DB) };
  const key = await limitKey(slow, "pwp", "a@example.com");
  const got = await Promise.all(Array.from({ length: 60 }, () => hits(slow, [{ key, windowMs: 15 * MIN }], T0).then((n) => n[0])));
  assert.deepEqual([...got].sort((a, b) => a - b), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.equal((await row(env, key)).n, 60);
});

test("61 parallel checks with a maximum of 5: exactly five get through", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const slow = { ...env, DB: slowDb(env.DB) };
  const key = await limitKey(slow, "sve", "sid-1");
  const results = await Promise.all(Array.from({ length: 61 }, () => check(slow, [{ key, windowMs: HOUR, max: 5 }], T0)));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(results.filter((r) => !r.ok).length, 56);
});

test("several counters are hit in one batch, each its own count, any one over its maximum refuses", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const a = await limitKey(env, "pwi", "1.2.3.4"), b = await limitKey(env, "pwp", "x@example.com", "1.2.3.4"), c = await limitKey(env, "pwa", "x@example.com");
  const specs = [{ key: a, windowMs: 15 * MIN, max: 60 }, { key: b, windowMs: 15 * MIN, max: 2 }, { key: c, windowMs: 15 * MIN, max: 15 }];
  let r = await check(env, specs, T0);
  assert.deepEqual(r, { ok: true, n: [1, 1, 1] });
  r = await check(env, specs, T0 + 1);
  assert.deepEqual(r, { ok: true, n: [2, 2, 2] });
  r = await check(env, specs, T0 + 2);
  assert.deepEqual(r, { ok: false, n: [3, 3, 3] }, "the middle counter is over 2");
  assert.deepEqual(await hits(env, [], T0), [], "no counters, no work");
  assert.deepEqual(await hits(env, [{ key: a, windowMs: HOUR }, { key: a, windowMs: HOUR }], T0 + 3), [4, 5], "the same key twice in one batch counts twice");
});

test("a window is fixed: counts keep adding inside it, and the first hit at or after its end starts again at 1", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const key = await limitKey(env, "loc:ip", "9.9.9.9");
  const spec = [{ key, windowMs: HOUR }];
  assert.deepEqual(await hits(env, spec, T0), [1]);
  assert.deepEqual(await hits(env, spec, T0 + 10 * MIN), [2]);
  assert.deepEqual(await hits(env, spec, T0 + 59 * MIN), [3]);
  assert.equal((await row(env, key)).window_start, new Date(T0).toISOString(), "later hits do not slide the window");
  assert.deepEqual(await hits(env, spec, T0 + HOUR - 1), [4], "one millisecond before the end is still the old window");
  assert.deepEqual(await hits(env, spec, T0 + HOUR), [1], "a new window");
  assert.equal((await row(env, key)).window_start, new Date(T0 + HOUR).toISOString());
  assert.deepEqual(await hits(env, spec, T0 + HOUR + 5), [2]);
  // a 24 hour counter (per address mail cap) behaves the same
  const day = [{ key: await limitKey(env, "mail:addr", "a@example.com"), windowMs: 24 * HOUR }];
  assert.deepEqual(await hits(env, day, T0), [1]);
  assert.deepEqual(await hits(env, day, T0 + 23 * HOUR), [2]);
  assert.deepEqual(await hits(env, day, T0 + 24 * HOUR), [1]);
});

test("counters are independent per key", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const x = await limitKey(env, "pwa", "x@example.com"), y = await limitKey(env, "pwa", "y@example.com");
  await hits(env, [{ key: x, windowMs: HOUR }], T0);
  await hits(env, [{ key: x, windowMs: HOUR }], T0);
  assert.deepEqual(await hits(env, [{ key: y, windowMs: HOUR }], T0), [1]);
});

test("refund gives one hit back, never goes below zero, and ignores unknown keys", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const a = await limitKey(env, "pwi", "1.1.1.1"), b = await limitKey(env, "pwa", "p@example.com");
  await hits(env, [{ key: a, windowMs: HOUR }, { key: b, windowMs: HOUR }], T0);
  await hits(env, [{ key: a, windowMs: HOUR }], T0 + 1);
  assert.equal((await row(env, a)).n, 2);
  await refund(env, [a, b]);
  assert.equal((await row(env, a)).n, 1);
  assert.equal((await row(env, b)).n, 0);
  await refund(env, [a, b, a, b]);
  assert.equal((await row(env, a)).n, 0, "floors at zero");
  assert.equal((await row(env, b)).n, 0, "floors at zero");
  await refund(env, [await limitKey(env, "pwi", "never-seen")]);
  await refund(env, []);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_limits").first("n")), 2, "refunding does not create rows");
  assert.deepEqual(await hits(env, [{ key: a, windowMs: HOUR }], T0 + 2), [1], "counting continues from the refunded value");
});

test("a refund after a success makes room again: five failures and a success leave the next try allowed", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const key = await limitKey(env, "pwp", "q@example.com", "5.5.5.5");
  const spec = [{ key, windowMs: 15 * MIN, max: 5 }];
  for (let i = 0; i < 4; i++) assert.equal((await check(env, spec, T0 + i)).ok, true);
  assert.equal((await check(env, spec, T0 + 5)).ok, true);   // 5th attempt, the right password
  await refund(env, [key]);                                    // success gives it back
  assert.equal((await check(env, spec, T0 + 6)).ok, true);
  assert.equal((await check(env, spec, T0 + 7)).ok, false);
});

test("keys never contain the address or the connection: only kind plus 22 characters of an HMAC", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const ip = "203.0.113.77", v6 = "2001:db8:85a3:1:abcd:ef01:2345:6789", email = "someone.private@example.com";
  const keys = [
    await limitKey(env, "loc:ip", clientKey(req(ip))),
    await limitKey(env, "loc:ip", clientKey(req(v6))),
    await limitKey(env, "mail:addr", email),
    await limitKey(env, "pwp", email, clientKey(req(ip))),
  ];
  for (const k of keys) assert.match(k, /^[a-z]+(:[a-z]+)?:[A-Za-z0-9_-]{22}$/, k);
  await hits(env, keys.map((key) => ({ key, windowMs: HOUR })), T0);
  const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM auth_limits").all()).results);
  for (const secret of [ip, "203.0.113", v6, "2001:db8", "85a3", "someone", "example.com", "private"]) assert.ok(!dump.includes(secret), `${secret} must not be stored`);
  assert.equal(new Set(keys).size, 4, "different inputs, different keys");
});

test("limitKey: the same input always gives the same key, kinds and parts never blur into each other", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  assert.equal(await limitKey(env, "pwa", "a@example.com"), await limitKey(env, "pwa", "a@example.com"));
  assert.notEqual(await limitKey(env, "pwa", "a@example.com"), await limitKey(env, "rss", "a@example.com"), "kind is part of the key");
  assert.notEqual(await limitKey(env, "pwp", "a", "bc"), await limitKey(env, "pwp", "ab", "c"), "parts are separated");
  assert.notEqual(await limitKey(env, "pwp", "a@example.com"), await limitKey(env, "pwp", "a@example.com", "none"));
});

test("the salt: LIMIT_SALT when set, otherwise one random value kept in settings, and a different salt gives different keys", async () => {
  const withEnv = await world({ LIMIT_SALT: "one" }), other = await world({ LIMIT_SALT: "two" }), same = await world({ LIMIT_SALT: "one" });
  const k = await limitKey(withEnv, "pwa", "a@example.com");
  assert.equal(k, await limitKey(same, "pwa", "a@example.com"), "same salt, same key, whatever server it runs on");
  assert.notEqual(k, await limitKey(other, "pwa", "a@example.com"));
  assert.equal((await withEnv.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'limit_salt'").first("n")), 0, "LIMIT_SALT is never copied into the database");

  const auto = await world();
  const k1 = await limitKey(auto, "pwa", "a@example.com");
  const stored = await auto.DB.prepare("SELECT value FROM settings WHERE key = 'limit_salt'").first("value");
  assert.ok(stored && stored.length >= 40, "a random 32 byte salt was made once");
  const k2 = await limitKey({ DB: auto.DB }, "pwa", "a@example.com");     // another server on the same database
  assert.equal(k1, k2);
  assert.equal((await auto.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'limit_salt'").first("n")), 1);
  assert.equal((await auto.DB.prepare("SELECT value FROM settings WHERE key = 'limit_salt'").first("value")), stored, "never replaced");
});

test("servers that start at the same moment without LIMIT_SALT agree on one salt", async () => {
  const base = await world();
  const servers = Array.from({ length: 12 }, () => ({ DB: slowDb(base.DB) }));
  const keys = await Promise.all(servers.map((e) => limitKey(e, "pwa", "a@example.com")));
  assert.equal(new Set(keys).size, 1);
  assert.equal((await base.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'limit_salt'").first("n")), 1);
});

test("a failure reading the salt is not remembered, and a database failure while counting is an error, not 'allowed'", async () => {
  const base = await world();
  let broken = true;
  const flaky = { ...base.DB, prepare: (sql) => { if (broken && /limit_salt/.test(sql)) throw new Error("D1 down"); return base.DB.prepare(sql); } };
  const env = { DB: flaky };
  await assert.rejects(limitKey(env, "pwa", "x"), /D1 down/);
  broken = false;
  assert.match(await limitKey(env, "pwa", "x"), /^pwa:[A-Za-z0-9_-]{22}$/);
  const down = { LIMIT_SALT: "s", DB: { ...base.DB, batch: async () => { throw new Error("D1 down"); } } };
  await assert.rejects(check(down, [{ key: "k", windowMs: HOUR, max: 5 }], T0), /D1 down/);
  await assert.rejects(refund(down, ["k"]), /D1 down/);
});

test("clientKey: IPv4 as is, IPv6 reduced to its /64, wrapped IPv4 treated as IPv4, nothing usable is 'none'", () => {
  assert.equal(clientKey(req("203.0.113.9")), "203.0.113.9");
  assert.equal(clientKey(req(" 203.0.113.9 ")), "203.0.113.9");
  assert.equal(clientKey(req("2001:db8:85a3:1:abcd:ef01:2345:6789")), "2001:db8:85a3:1::/64");
  assert.equal(clientKey(req("2001:db8:85a3:1:ffff:ffff:ffff:ffff")), "2001:db8:85a3:1::/64", "the whole /64 is one connection");
  assert.equal(clientKey(req("2001:DB8:85A3:0001:0:0:0:1")), "2001:db8:85a3:1::/64", "case and leading zeros do not matter");
  assert.equal(clientKey(req("2001:db8::1")), "2001:db8:0:0::/64");
  assert.equal(clientKey(req("2001:db8:1::5")), "2001:db8:1:0::/64");
  assert.equal(clientKey(req("2001:db8:1:2:3::")), "2001:db8:1:2::/64");
  assert.equal(clientKey(req("::1")), "0:0:0:0::/64");
  assert.equal(clientKey(req("fe80::1%eth0")), "fe80:0:0:0::/64", "zone id dropped");
  assert.equal(clientKey(req("::ffff:198.51.100.7")), "198.51.100.7");
  assert.equal(clientKey(req("::198.51.100.7")), "198.51.100.7");
  assert.equal(clientKey(req("64:ff9b::198.51.100.7")), "64:ff9b:0:0::/64");
  assert.equal(clientKey(req("2001:db8:1:2:3:4:5:6:7")), "none", "too many groups");
  assert.equal(clientKey(req("2001:db8::1::2")), "none", "two ::");
  assert.equal(clientKey(req("2001:db8:xyz::1")), "none");
  assert.equal(clientKey(req("999.1.1.1")), "none");
  assert.equal(clientKey(req("1.2.3")), "none");
  assert.equal(clientKey(req("not an ip")), "none");
  assert.equal(clientKey(req("")), "none");
  assert.equal(clientKey(req(undefined)), "none");
  assert.equal(clientKey(req("1".repeat(80))), "none");
  // a visitor cannot choose their own bucket with other headers
  assert.equal(clientKey(new Request("https://vicinity.test/x", { headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" } })), "none");
});

test("two addresses inside one IPv6 /64 share the counter, another /64 and another IPv4 do not", async () => {
  const env = await world({ LIMIT_SALT: "s" });
  const key = (ip) => limitKey(env, "loc:ip", clientKey(req(ip)));
  assert.equal(await key("2001:db8:aaaa:bbbb:1:2:3:4"), await key("2001:db8:aaaa:bbbb:ffff:eeee:dddd:cccc"));
  assert.notEqual(await key("2001:db8:aaaa:bbbb:1:2:3:4"), await key("2001:db8:aaaa:bbbc:1:2:3:4"));
  assert.equal(await key("::ffff:198.51.100.7"), await key("198.51.100.7"));
  assert.notEqual(await key("198.51.100.7"), await key("198.51.100.8"));
  assert.equal(await key("198.51.100.7"), await limitKey(env, "loc:ip", "198.51.100.7"));
  const spec = async (ip) => [{ key: await key(ip), windowMs: HOUR }];
  assert.deepEqual(await hits(env, await spec("2001:db8:aaaa:bbbb::1"), T0), [1]);
  assert.deepEqual(await hits(env, await spec("2001:db8:aaaa:bbbb::2"), T0), [2], "rotating inside the /64 does not escape the limit");
});
