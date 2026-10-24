// The brand and site adapters (Citycoin.dev master v5, stage S02): src/site-config.js (SITE_ORIGIN, SITE_ORIGINS) and src/brand.js
// (BRAND). Unset, both give today's values byte for byte, and the Worker call sites that read them answer exactly as before.
// Every non-default value here is a clearly fake fixture (example.test, example.org); none is a real Citycoin.dev setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { DEFAULT_SITE, DEFAULT_SITE_ORIGIN, LEGACY_FORWARD_HOSTS, USER_AGENT, isAcceptedHost, isForwardHost, normalizeOrigin, siteConfig, userAgent } from "../src/site-config.js";
import { BRANDS, LEGACY_BRAND, brandOf } from "../src/brand.js";
import { sendViaResend } from "../src/mail.js";
import { USER_AGENT as SOURCES_USER_AGENT } from "../src/sources.js";

/* ---------------------------------------------------------------- src/site-config.js */
test("site config unset is today's hard-coded values", () => {
  for (const env of [undefined, {}, { SITE_ORIGIN: "" }, { SITE_ORIGIN: "  ", SITE_ORIGINS: "" }, { SITE_ORIGINS: [] }]) {
    const s = siteConfig(env);
    assert.equal(s, DEFAULT_SITE);
    assert.equal(s.origin, "https://vicinity.city");
    assert.equal(s.host, "vicinity.city");
    assert.deepEqual([...s.origins], ["https://vicinity.city"]);
    assert.deepEqual([...s.hosts], ["vicinity.city"]);
    assert.deepEqual([...s.forwardHosts], ["www.vicinity.city", "vicinitycity.net", "www.vicinitycity.net"]);
    assert.equal(s.configured, false);
    assert.deepEqual([...s.problems], []);
  }
  assert.equal(DEFAULT_SITE_ORIGIN, "https://vicinity.city");
  assert.deepEqual([...LEGACY_FORWARD_HOSTS], ["www.vicinity.city", "vicinitycity.net", "www.vicinitycity.net"]);
  assert.ok(Object.isFrozen(DEFAULT_SITE) && Object.isFrozen(DEFAULT_SITE.origins) && Object.isFrozen(DEFAULT_SITE.forwardHosts));
});

test("site config: a valid setting is used whole", () => {
  const s = siteConfig({ SITE_ORIGINS: "https://vicinity.city, https://example.test" });
  assert.equal(s.origin, "https://vicinity.city", "SITE_ORIGIN unset keeps today's canonical origin");
  assert.deepEqual([...s.hosts], ["vicinity.city", "example.test"]);
  assert.equal(s.configured, true);
  const t = siteConfig({ SITE_ORIGIN: "https://Example.Test", SITE_ORIGINS: ["https://example.test", "https://vicinity.city", "https://www.vicinity.city"] });
  assert.equal(t.origin, "https://example.test");
  assert.equal(t.host, "example.test");
  assert.deepEqual([...t.forwardHosts], ["vicinitycity.net", "www.vicinitycity.net"], "a host served in place is never forwarded");
  assert.ok(isAcceptedHost(t, "WWW.vicinity.city") && !isForwardHost(t, "www.vicinity.city"));
  assert.ok(!isAcceptedHost(t, "evil-example.test") && !isAcceptedHost(t, "x.example.test"), "exact host match, never a suffix");
});

test("site config: anything malformed falls back to today's values whole and names the refusal", () => {
  const cases = [
    [{ SITE_ORIGIN: "http://example.test", SITE_ORIGINS: "http://example.test" }, ["SITE_ORIGIN_INVALID", "SITE_ORIGINS_INVALID"]],
    [{ SITE_ORIGIN: "https://example.test/" }, ["SITE_ORIGIN_INVALID"]],
    [{ SITE_ORIGIN: "https://example.test" }, ["SITE_ORIGIN_NOT_ALLOWED"]],
    [{ SITE_ORIGIN: "https://example.test", SITE_ORIGINS: "https://vicinity.city" }, ["SITE_ORIGIN_NOT_ALLOWED"]],
    [{ SITE_ORIGINS: "https://vicinity.city https://example.test/path" }, ["SITE_ORIGINS_INVALID"]],
    [{ SITE_ORIGINS: "https://vicinity.city,https://example.test:8443" }, ["SITE_ORIGINS_INVALID"]],
    [{ SITE_ORIGINS: ["https://vicinity.city", 42] }, ["SITE_ORIGINS_INVALID"]],
    [{ SITE_ORIGIN: "https://user@example.test", SITE_ORIGINS: "https://example.test" }, ["SITE_ORIGIN_INVALID"]],
    [{ SITE_ORIGIN: "https://localhost", SITE_ORIGINS: "https://localhost" }, ["SITE_ORIGIN_INVALID", "SITE_ORIGINS_INVALID"]],
  ];
  for (const [env, problems] of cases) {
    const s = siteConfig(env);
    assert.deepEqual([...s.problems], problems, JSON.stringify(env));
    assert.equal(s.configured, false);
    for (const k of ["origin", "host"]) assert.equal(s[k], DEFAULT_SITE[k], `${JSON.stringify(env)} ${k}`);
    for (const k of ["origins", "hosts", "forwardHosts"]) assert.deepEqual([...s[k]], [...DEFAULT_SITE[k]], `${JSON.stringify(env)} ${k}`);
  }
  for (const bad of ["https://exa mple.test", "https://example.test?x=1", "https://example.test#x", "https://-x.example", "ftp://example.test", "https://", "https://example", null, 7])
    assert.equal(normalizeOrigin(bad), null, String(bad));
});

test("site config never reads a request: it takes the environment only", () => {
  const src = readFileSync(new URL("../src/site-config.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\brequest\b|headers|\.get\(\s*["']host["']/i);
  assert.equal(siteConfig({ HOST: "evil.example", host: "evil.example" }), DEFAULT_SITE, "no setting named like a header changes it");
});

test("the User-Agent the Worker sends is today's, from src/site-config.js", () => {
  assert.equal(USER_AGENT, "vicinity.city/1.0 (+https://vicinity.city)");
  assert.equal(SOURCES_USER_AGENT, USER_AGENT);
  assert.equal(userAgent(), USER_AGENT);
  assert.equal(userAgent(siteConfig({ SITE_ORIGIN: "https://example.test", SITE_ORIGINS: "https://example.test" })), "example.test/1.0 (+https://example.test)");
  const swap = readFileSync(new URL("../src/swap.js", import.meta.url), "utf8");
  assert.match(swap, /"user-agent": USER_AGENT,/);
  assert.doesNotMatch(swap, /vicinity\.city\/1\.0/, "no second copy of the agent string");
});

test("the old-name redirect: unset settings answer exactly as before; the target is today's host, never the request or SITE_ORIGIN", async () => {
  const go = async (url, env = {}) => { const r = await worker.fetch(new Request(url), env); return [r.status, r.headers.get("location"), r.headers.get("cache-control")]; };
  for (const host of LEGACY_FORWARD_HOSTS) {
    assert.deepEqual(await go(`https://${host}/a/b?c=1`), [301, "https://vicinity.city/a/b?c=1", "public, max-age=3600"]);
    assert.deepEqual(await go(`https://${host}/a`, { SITE_ORIGIN: "nonsense" }), [301, "https://vicinity.city/a", "public, max-age=3600"], "a malformed setting changes nothing");
  }
  assert.equal((await go("https://evil.example/api/health"))[0], 200, "an unknown host is served in place as today, never a redirect target");
  // a fixture configuration (clearly fake): SITE_ORIGIN alone never makes the permanent redirect cross domains (that is HOST_REDIRECT's,
  // stage S03, with its own policy check), so the old names keep forwarding to vicinity.city; a host listed in SITE_ORIGINS is served in place
  const env = { SITE_ORIGIN: "https://example.test", SITE_ORIGINS: "https://example.test https://www.vicinity.city" };
  assert.deepEqual(await go("https://vicinitycity.net/x", env), [301, "https://vicinity.city/x", "public, max-age=3600"]);
  assert.deepEqual(await go("http://www.vicinity.city/x?y=1", { SITE_ORIGIN: "https://example.test", SITE_ORIGINS: "https://example.test https://vicinity.city" }),
    [301, "https://vicinity.city/x?y=1", "public, max-age=3600"], "the review's case: not a 301 to the configured origin");
  assert.deepEqual(await go("https://vicinitycity.net/x", { SITE_ORIGIN: "https://example.test", SITE_ORIGINS: "https://example.test https://vicinity.city", HOST_REDIRECT: "on", DEPLOYMENT_ENV: "test" }),
    [301, "https://vicinity.city/x", "public, max-age=3600"], "not even with HOST_REDIRECT set: the configured target is stage S03's");
  assert.equal((await go("https://www.vicinity.city/api/health", env))[0], 200);
});

/* ---------------------------------------------------------------- src/brand.js */
test("BRAND unset is today's label set; any other value keeps it and names the refusal", () => {
  assert.deepEqual(Object.keys(BRANDS), [""]);
  assert.deepEqual({ ...LEGACY_BRAND }, { key: "", productName: "Vicinity", shortName: "Vicinity", domain: "vicinity.city", siteLabel: "Vicinity.city", senderName: "Vicinity", tagline: "One city. One coin. One community." });
  assert.ok(Object.isFrozen(LEGACY_BRAND) && Object.isFrozen(BRANDS));
  for (const env of [undefined, {}, { BRAND: "" }, { BRAND: "  " }, { BRAND: null }]) {
    const b = brandOf(env);
    assert.equal(b.problem, null);
    assert.equal(b.value, "");
    for (const k of Object.keys(LEGACY_BRAND)) assert.equal(b[k], LEGACY_BRAND[k]);
  }
  for (const BRAND of ["citycoin", " CITYCOIN ", "constructor", "toString", "__proto__"]) {
    const b = brandOf({ BRAND });
    assert.equal(b.problem, "BRAND_UNKNOWN", BRAND);
    assert.equal(b.senderName, "Vicinity");
  }
});

test("the mail sender keeps today's display name and address while BRAND is unset", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  await sendViaResend({ RESEND_API_KEY: "rk-test" }, { to: "a@example.org", subject: "s", text: "t" }, fetchImpl);
  await sendViaResend({ RESEND_API_KEY: "rk-test", BRAND: "citycoin" }, { to: "a@example.org", subject: "s", text: "t" }, fetchImpl);
  await sendViaResend({ RESEND_API_KEY: "rk-test", EMAIL_FROM: "Fixture <noreply@example.org>" }, { to: "a@example.org", subject: "s", text: "t" }, fetchImpl);
  assert.deepEqual(sent.map((b) => b.from), ["Vicinity <noreply@vicinity.city>", "Vicinity <noreply@vicinity.city>", "Fixture <noreply@example.org>"]);
  const mail = readFileSync(new URL("../src/mail.js", import.meta.url), "utf8");
  assert.match(mail, /const from = `\$\{brandOf\(env\)\.senderName\} <\$\{user\}>`;/, "the Gmail sender's display name comes from src/brand.js too");
  assert.doesNotMatch(mail, /from: `Vicinity </);
});
