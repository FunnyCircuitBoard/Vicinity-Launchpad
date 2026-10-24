// Citycoin.dev master v5, stage S08: the switches-off parity claim (docs/citycoin-master/schema-migrations.md). The Worker's normal request
// paths (through its real entry, src/index.js default fetch) and its job (the cron's scheduled handler, and the 03:00 pruning run) are run
// against a fake D1 that records every statement: the production shape with synthetic rows (test/helpers/cc5-d1copy.js; no member data).
// With every switch at its default, and with the switches as committed in wrangler.jsonc, no statement touches a cc5 object, no table is
// created, and the Worker's statements are the same either way. Nothing in the Worker imports src/cc5schema.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { CC5_GROUPS } from "../src/cc5schema.js";
import { FLAG_VALUES } from "../src/masterpolicy.js";
import { buildCopy, nodeEngine, rootPath, synthSessionToken, synthWallet } from "./helpers/cc5-d1copy.js";
import { recorder } from "./helpers/cc5-d1copy-worker.js";
import { chain, newWorld, realClock, setHolding, useClock } from "./helpers/world.js";

const read = (p) => readFileSync(rootPath(p), "utf8");
const VARS = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")).vars;
const objectName = (s) => (/^CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS (\w+)/.exec(s) || [])[1];
const CC5_NAMES = [...new Set(Object.values(CC5_GROUPS).flatMap((g) => g.statements).map(objectName))];
const CC5_WORD = new RegExp(`\\b(${CC5_NAMES.join("|")})\\b|cc5-`, "i");
const SITE = "https://vicinity.city";

/** A tiny seeded generator, so the job's random sampling and the routes' occasional tidy-ups take the same branches every run. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** The requests a visitor and a signed-in member make, and the job: through the Worker's real entry points. */
async function runWorker(env) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} };
  const cookie = `vs=${synthSessionToken(1)}`;
  const w1 = synthWallet(1);
  const send = async (path, { method = "GET", body, signedIn = false } = {}) => {
    const headers = new Headers({ origin: SITE, "cf-connecting-ip": "192.0.2.10" });
    if (signedIn) headers.set("cookie", cookie);
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await worker.fetch(new Request(SITE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    const text = await res.text();
    let error = "";
    try { error = JSON.parse(text).error || ""; } catch { /* a page or a CSV */ }
    return error ? `${res.status} ${error}` : res.status;
  };
  const statuses = {};
  const visitor = ["/", "/api/health", "/api/official", "/api/policy", "/api/policy/master", "/api/token", "/api/holders", `/api/rank?address=${w1}`,
    `/api/message?address=${w1}&action=login`, `/api/check?q=${w1}`, "/api/seats", "/api/claims", "/api/moderator?country=US", "/api/members?country=US",
    "/api/audit?country=US", "/api/snapshots", "/api/coins", "/api/launchpad", "/api/fees", "/api/official-coins", "/official-coins.csv",
    "/api/profile?u=synthetic-member-2", "/api/members/search?q=synthetic", "/api/swap/config", "/api/selection/status", "/api/managers/apply"];
  for (const p of visitor) statuses[p] = await send(p);
  const member = ["/api/me", "/api/home", "/api/posts?scope=city&place=5128581", "/api/notices", "/api/follows", "/api/me/blocks", "/api/me/portfolio", "/api/mutes"];
  for (const p of member) statuses[`member ${p}`] = await send(p, { signedIn: true });
  for (const [p, body] of [["/api/posts", { kind: "meme", body: "A synthetic post" }], ["/api/posts/vote", { id: 2 }], ["/api/notices/read", {}],
    ["/api/feedback", { kind: "question", message: "A synthetic question", page: "/" }], ["/api/auth/logout", {}]]) {
    statuses[`member POST ${p}`] = await send(p, { method: "POST", body, signedIn: true });
  }
  await Promise.all(pending.splice(0));
  // the cron: the scheduled handler, then the run at 03:05 UTC that also prunes the balance history
  await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, ctx);
  await Promise.all(pending.splice(0));
  useClock("2026-10-25T03:05:00Z");
  await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, ctx);
  await Promise.all(pending.splice(0));
  return statuses;
}

/** One run on a fresh copy: the statements the Worker issued, the objects before and after, the answers it gave. */
async function traceWith(vars) {
  const engine = nodeEngine(["W"]);
  await buildCopy(engine, "W");
  const raw = engine.env.W;
  const objects = () => raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().then((r) => r.results);
  const before = await objects();
  const rec = recorder(raw);
  const env = { ...vars, DB: rec.db, ASSETS: newWorld().ASSETS };
  setHolding(synthWallet(1), 250000); // member 1 holds the token on the fake chain, so the member paths go all the way (a post, a vote)
  const saved = { fetch: globalThis.fetch, random: Math.random, log: console.log, error: console.error, warn: console.warn };
  globalThis.fetch = chain();
  Math.random = seeded(7);
  console.log = console.error = console.warn = () => {};
  useClock("2026-10-24T12:00:00Z");
  let statuses;
  try { statuses = await runWorker(env); }
  finally {
    realClock();
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn });
    globalThis.fetch = saved.fetch;
    Math.random = saved.random;
  }
  return { seen: rec.state.seen, before, after: await objects(), statuses };
}

const V5_DEFAULTS = Object.fromEntries(Object.entries(FLAG_VALUES).map(([k, v]) => [k, v[0]]));
// the switches whose groups this stage defines, each away from its default (shadow where it has one)
const GROUP_SWITCHES_LEFT = { SELECTION_V5: "shadow", ACTIVITY_POINTS: "shadow", MANAGER_APPS: "on", METADATA_V5: "on", LAUNCH_V5: "on", CC_HOURLY: "shadow" };

test("the Worker never loads src/cc5schema.js: it is not in the import graph of src/index.js (static or dynamic imports)", () => {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = read(rel);
    for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const target = new URL(m[1] || m[2], new URL(rel, "file:///r/")).pathname.slice(3);
      walk(target);
    }
  };
  walk("src/index.js");
  assert.ok(seen.has("src/jobs.js") && seen.has("src/store.js") && seen.has("src/v5policy.js") && seen.size > 60, `the walk found the Worker (${seen.size} modules)`);
  assert.ok(!seen.has("src/cc5schema.js"), "src/cc5schema.js is not reachable from the Worker");
  assert.ok(![...seen].some((f) => /cc5/.test(f)));
});

test("switches at their defaults: the Worker's normal requests and its job issue no statement on any cc5 object, create no table, and issue exactly the same statements as with the switches as committed", async () => {
  const committed = await traceWith(VARS);
  const defaults = await traceWith({ ...VARS, ...V5_DEFAULTS });
  // and with no setting at all (every switch of the Worker at the code's own default)
  const bare = await traceWith({});
  assert.ok(bare.seen.length > 100);
  assert.deepEqual(bare.seen.filter((s) => CC5_WORD.test(s)), [], "no setting at all: no cc5 statement");
  assert.deepEqual(bare.after, bare.before, "no setting at all: no object added or changed");
  for (const [label, run] of [["as committed", committed], ["every v5 switch at its default", defaults]]) {
    assert.ok(run.seen.length > 100, `${label}: the paths really ran (${run.seen.length} statements)`);
    for (const [what, re] of [["a member's post", /^INSERT INTO posts\b/i], ["a member's vote", /^INSERT INTO votes\b/i], ["a feedback message", /^INSERT INTO feedback\b/i],
      ["a signed-in read", /^SELECT \* FROM users WHERE id = \?/i], ["the job lease", /job_lease/], ["the job's cleanup", /^DELETE FROM sessions WHERE expires_at/i],
      ["the 03:00 pruning", /^DELETE FROM balance_samples WHERE day/i]]) {
      assert.ok(run.seen.some((s) => re.test(s.trim())), `${label}: ${what} is among the statements`);
    }
    assert.deepEqual(run.seen.filter((s) => CC5_WORD.test(s)), [], `${label}: no cc5 statement`);
    const tables = (objs) => objs.filter((o) => o.type === "table").map((o) => o.name);
    assert.deepEqual(tables(run.after), tables(run.before), `${label}: no new table`);
    assert.deepEqual(run.after, run.before, `${label}: no object added or changed at all`);
  }
  assert.deepEqual(defaults.seen, committed.seen, "the same statements, in the same order");
  assert.deepEqual(defaults.statuses, committed.statuses, "the same answers");
});

test("even with the group switches set away from their defaults, nothing in this stage calls the runner: no cc5 statement, no new table", async () => {
  const run = await traceWith({ ...VARS, ...GROUP_SWITCHES_LEFT, DEPLOYMENT_ENV: "test" });
  assert.ok(run.seen.length > 100);
  assert.deepEqual(run.seen.filter((s) => CC5_WORD.test(s)), []);
  assert.deepEqual(run.after.filter((o) => o.type === "table").map((o) => o.name), run.before.filter((o) => o.type === "table").map((o) => o.name));
});
