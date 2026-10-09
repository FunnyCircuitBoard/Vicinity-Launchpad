// The launch-week robustness sweep (feat/swap): every outbound call has a timeout and a plain code, the 10-minute job never
// runs twice at once (a lease in the settings table), the expiry columns the cleanup deletes by are indexed, a broken edge
// cache never breaks an answer, and CI fails on an unhandled rejection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleApi } from "../src/index.js";
import { runJobs, takeJobLease, JOB_LEASE_MS } from "../src/jobs.js";
import { sendViaResend } from "../src/mail.js";
import { ensureSchema, MIGRATIONS } from "../src/store.js";
import { newWorld, ORIGIN } from "./helpers/world.js";

/** A fetch that never answers but honours the caller's AbortSignal, like a stuck upstream. */
const stuck = () => (url, init) => new Promise((_, reject) => { init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError"))); });
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("robustness: Google's token endpoint has an 8 s timeout; a stuck or failing exchange answers login_unavailable, a bad token login_failed", async () => {
  const env = { ...newWorld(), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };
  const src = read("src/auth.js");
  assert.match(src, /oauth2\.googleapis\.com\/token[\s\S]{0,600}signal: AbortSignal\.timeout\(OAUTH_TIMEOUT_MS\)/, "the token exchange carries a timeout signal");
  assert.match(src, /OAUTH_TIMEOUT_MS = 8_000/);
  const cookie = "google.st4te.verifier.s";
  const req = (f) => handleApi(new Request(`${ORIGIN}/api/auth/google/callback?code=abc&state=st4te`, { headers: { cookie: `vo=${encodeURIComponent(cookie)}` } }), env, f);
  // the real cookie name
  const cookieName = /OAUTH_COOKIE = "([^"]+)"/.exec(src)[1];
  const call = (f) => handleApi(new Request(`${ORIGIN}/api/auth/google/callback?code=abc&state=st4te`, { headers: { cookie: `${cookieName}=${encodeURIComponent(cookie)}` } }), env, f);
  void req;
  let seenSignal = false;
  const slow = (url, init) => { seenSignal = Boolean(init && init.signal); return stuck()(url, init); };
  const timer = setTimeout(() => {}, 0); void timer;
  const t0 = Date.now();
  // abort right away through a fake signal: AbortSignal.timeout waits 8 s, which a unit test must not, so abort the real signal by hand
  const res = await handleApi(new Request(`${ORIGIN}/api/auth/google/callback?code=abc&state=st4te`, { headers: { cookie: `${cookieName}=${encodeURIComponent(cookie)}` } }), env, (url, init) => { seenSignal = Boolean(init && init.signal); return Promise.reject(new DOMException("The operation was aborted", "AbortError")); });
  assert.ok(seenSignal, "the signal reached the fetch");
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /\/connect\?error=login_unavailable/);
  assert.ok(Date.now() - t0 < 2000);
  const bad = await call(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
  assert.match(bad.headers.get("location"), /\/connect\?error=login_failed/);
  const down = await call(async () => { throw new TypeError("fetch failed"); });
  assert.match(down.headers.get("location"), /\/connect\?error=login_unavailable/, "a network failure is 'unavailable', not the person's fault");
  void slow;
});

test("robustness: Resend has an 8 s timeout and answers email_unavailable when stuck or down", async () => {
  assert.match(read("src/mail.js"), /api\.resend\.com\/emails[\s\S]{0,400}signal: AbortSignal\.timeout\(8_000\)/);
  const env = { RESEND_API_KEY: "rk", EMAIL_FROM: "Vicinity <noreply@vicinity.city>" };
  let signal = null;
  const r = await sendViaResend(env, { to: "a@b.c", subject: "s", text: "t" }, (url, init) => { signal = init.signal; return Promise.reject(new DOMException("aborted", "AbortError")); });
  assert.deepEqual(r, { ok: false, error: "email_unavailable" });
  assert.ok(signal && typeof signal.aborted === "boolean", "an AbortSignal was passed");
});

test("robustness: the 10-minute job takes a lease: a second run while one holds it is skipped, a finished run releases it, a stale lease is taken over", async () => {
  const env = newWorld();
  await ensureSchema(env.DB);
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(await takeJobLease(env.DB, now), true, "first taker");
  assert.equal(await takeJobLease(env.DB, now + 1000), false, "a live lease is not given twice");
  assert.deepEqual(await runJobs(env, now + 2000, async () => { throw new Error("no network in this test"); }), { skipped: "another run holds the lease" });
  assert.equal(await takeJobLease(env.DB, now + JOB_LEASE_MS + 1), true, "an expired lease (a crashed run) is taken over");
  // a run that finishes releases it: the next firing works at once, even at the same clock
  const quiet = async () => { throw new Error("no network in this test"); };
  const r1 = await runJobs(env, now + JOB_LEASE_MS + 2, quiet); // runs (the lease above is ours but this is a new taker? no: it is held) -> skipped
  assert.deepEqual(r1, { skipped: "another run holds the lease" });
  await env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'job_lease'").run(); // the holder finished
  const r2 = await runJobs(env, now + JOB_LEASE_MS + 3, quiet);
  assert.ok(r2.cleanup && r2.cleanup.ok, "the run went through: " + JSON.stringify(r2).slice(0, 200));
  const r3 = await runJobs(env, now + JOB_LEASE_MS + 3, quiet);
  assert.ok(r3.cleanup && r3.cleanup.ok, "and the lease was released at the end, so the next run at the same clock also goes through");
  const lease = await env.DB.prepare("SELECT value FROM settings WHERE key = 'job_lease'").first();
  assert.equal(lease.value, "", "released");
});

test("robustness: the expiry columns the cleanup deletes by are indexed (a repeatable migration), and it is part of the migrations every request runs", async () => {
  const env = newWorld();
  await ensureSchema(env.DB);
  const m = MIGRATIONS.find((x) => x.id === "2026-10-09-expiry-indexes");
  assert.ok(m, "the migration exists");
  for (const [table, index] of [["sessions", "sessions_expires"], ["pairs", "pairs_expires"], ["handoffs", "handoffs_expires"]]) {
    const list = (await env.DB.prepare(`PRAGMA index_list(${table})`).all()).results.map((r) => r.name);
    assert.ok(list.includes(index), `${table} has ${index}: ${list.join(",")}`);
  }
  assert.ok(m.sql.split(";").filter((s) => s.trim()).every((s) => /^\s*CREATE INDEX IF NOT EXISTS/.test(s)), "nothing but CREATE INDEX IF NOT EXISTS: safe to repeat, no data touched");
});

test("robustness: a broken edge cache (match or put throwing) never breaks a cached answer", async () => {
  const env = { ...newWorld(), SWAP: "on", VICINITY_MINT: "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray" };
  const realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => { throw new Error("cache exploded"); }, put: async () => { throw new Error("cache exploded"); } } };
  try {
    const res = await handleApi(new Request(`${ORIGIN}/api/swap/config`), env, async () => new Response("{}", { status: 404 }));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.ok, true);
    assert.ok(d.tokens.length >= 3);
  } finally { if (realCaches === undefined) delete globalThis.caches; else globalThis.caches = realCaches; }
});

test("robustness: CI runs the tests with --unhandled-rejections=strict", () => {
  assert.match(read(".github/workflows/ci.yml"), /NODE_OPTIONS: --unhandled-rejections=strict/);
});
