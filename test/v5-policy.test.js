// Citycoin.dev master v5, stage S07 (implementation-report.md S07; schema-and-api.md sections 2.1, 2.2 and 4.9): the policy module's
// validatePolicy runs on the Worker's own settings at the first request of an isolate and at each job start (named errors logged once,
// codes and paths only, never thrown at a visitor), and the PUBLIC_V5 switch publishes the policy: GET /api/policy gains `master` and
// GET /api/policy/master exists. With the switch off, or on with a refused configuration, both answer exactly as today: /api/policy/master
// is an unknown path. The main mint and the links below are clearly fake test fixtures; the owner has supplied none of the three values.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as W from "./helpers/world.js";
import worker, { handleApi } from "../src/index.js";
import { runJobs } from "../src/jobs.js";
import { MASTER_POLICY, nextSelectionBoundary, validatePolicy } from "../src/masterpolicy.js";
import { AUTHORITY_ROLES, ENVIRONMENT_SETTING, INPUT_SETTINGS, _resetPolicyCheck, canonicalJson, checkPolicyConfig, deploymentFromEnv, masterPolicyAnswer,
  policyConfig, policyDigest, publicMaster, publicV5 } from "../src/v5policy.js";
import { _resetDeploymentCheck } from "../src/maintoken.js";
import { publicV5On } from "../src/flags.js";
import { siteConfig } from "../src/site-config.js";
import { POLICY } from "../src/policy.js";
import { tokenMint } from "../src/official.js";
import { snapshotCutoff } from "../src/snapshot.js";
import { settingsFrom } from "../scripts/mainnet-preflight.mjs";

const POLICY_JSON = JSON.parse(readFileSync(new URL("../docs/citycoin-master/policy.json", import.meta.url), "utf8"));
const P = MASTER_POLICY.policy;
// production settings exactly as wrangler.jsonc ships them (no v5 switch, no v5 setting), plus the test chain
const LIVE = { ...settingsFrom({ wranglerPath: new URL("../wrangler.jsonc", import.meta.url), env: {} }), SOLANA_RPC_URL: "https://rpc.test" };
const FAKE_MINT = "FakeMainTokenMint111111111111111111111111111"; // a clearly fake fixture with a valid key shape
const FAKE_X = "https://x.com/ZqFakeTestX", FAKE_TG = "https://t.me/zq_fake_test_tg";
const LEGACY_MINT = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray", LEGACY_X = "https://x.com/VicinityCitySOL";
const ON = { PUBLIC_V5: "on", [ENVIRONMENT_SETTING]: "production" };

let errors = [];
const realError = console.error;
beforeEach(() => {
  W.useClock("2026-10-24T12:00:00Z");
  _resetPolicyCheck(); _resetDeploymentCheck();
  errors = []; console.error = (...a) => errors.push(a.map(String).join(" "));
});
afterEach(() => { console.error = realError; W.realClock(); });

const answer = async (res) => ({ status: res.status, headers: [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)), body: await res.text() });
const call = async (env, path, init = {}) => answer(await handleApi(new Request(`https://vicinity.city${path}`, init), env, W.chain(), { waitUntil() {} }));
const policyLines = () => errors.filter((e) => e.startsWith("policy config refused"));

/* ---------------------------------------------------------------- with the switch off: today's site */

test("the default: today's settings describe the policy's own default deployment, which validates; the fast answer equals the full check", () => {
  for (const env of [{}, LIVE, { ...LIVE, PUBLIC_V5: "off" }, { ...LIVE, PUBLIC_V5: "", MAIN_TOKEN_V5: "  " }, { ...LIVE, [ENVIRONMENT_SETTING]: "", SITE_ORIGINS: [] },
    { ...LIVE, LEGACY_SEATS: "On", LEGACY_LAUNCH: "on", MAIN_TOKEN_V5: "OFF " }]) {
    assert.deepEqual(deploymentFromEnv(env), MASTER_POLICY.deployment, JSON.stringify(env).slice(0, 80));
    assert.deepEqual(validatePolicy({ ...MASTER_POLICY, deployment: deploymentFromEnv(env) }), { ok: true, errors: [] });
    assert.deepEqual(policyConfig(env), { ok: true, errors: [], environment: "unset" });
    assert.equal(publicV5(env), false);
  }
  // none of today's settings is a v5 switch or input: the check reads only names the policy defines
  const read = new Set([...Object.keys(MASTER_POLICY.deployment.flags), ENVIRONMENT_SETTING, ...INPUT_SETTINGS, ...Object.keys(MASTER_POLICY.deployment.inputs.secrets_present)]);
  assert.deepEqual(Object.keys(LIVE).filter((k) => read.has(k)), []);
  assert.deepEqual(checkPolicyConfig(LIVE), { ok: true, codes: [] });
  assert.deepEqual(errors, [], "nothing is logged");
});

test("switch off (or on with a refused configuration): GET /api/policy is today's answer, byte for byte, with today's headers", async () => {
  const env = W.newWorld(LIVE);
  const today = await call(env, "/api/policy");
  assert.equal(today.status, 200);
  const body = JSON.parse(today.body);
  assert.deepEqual(Object.keys(body), ["policy", "snapshotCutoff", "launched", "balanceHistory"]);
  assert.deepEqual(body.policy, JSON.parse(JSON.stringify(POLICY)));
  assert.equal(body.snapshotCutoff, snapshotCutoff(env));
  assert.equal(body.launched, Boolean(tokenMint(env)));
  // (MAIN_TOKEN_V5 is left out: its own effect on `launched` is stage S02A's, test/main-token-consumers.test.js)
  for (const extra of [{ PUBLIC_V5: "off" }, { PUBLIC_V5: "yes" }, { PUBLIC_V5: "on" }, { PUBLIC_V5: "on", [ENVIRONMENT_SETTING]: "prod" },
    { ...ON, MAIN_TOKEN_MINT: "not-a-mint" }, { ...ON, OFFICIAL_X_URL: LEGACY_X }, { ...ON, LAUNCH_V5: "on" }, { ...ON, SELECTION_V5: "shadow" }]) {
    assert.deepEqual(await call({ ...env, ...extra }, "/api/policy"), today, JSON.stringify(extra));
  }
  // a method other than GET: today's 405, before anything is read
  const post = await call(env, "/api/policy", { method: "POST" });
  assert.equal(post.status, 405);
  assert.deepEqual(await call({ ...env, ...ON }, "/api/policy", { method: "POST" }), post);
});

test("switch off (or on with a refused configuration): /api/policy/master is an unknown path, the same 404 as any other, for every method", async () => {
  const env = W.newWorld(LIVE);
  for (const method of ["GET", "POST", "HEAD", "PUT", "DELETE"]) {
    const unknown = await call(env, "/api/no-such-route", { method });
    assert.equal(unknown.status, 404);
    for (const extra of [{}, { PUBLIC_V5: "off" }, { PUBLIC_V5: "on" }, { PUBLIC_V5: "on", [ENVIRONMENT_SETTING]: "prod" }, { ...ON, MAIN_TOKEN_V5: "on" },
      { ...ON, OFFICIAL_TELEGRAM_URL: "https://t.me/+invite" }, { ...ON, SITE_ORIGIN: "https://citycoin.dev" }]) {
      assert.deepEqual(await call({ ...env, ...extra }, "/api/policy/master", { method }), unknown, `${method} ${JSON.stringify(extra)}`);
    }
  }
});

test("the job start runs the check: nothing logged with today's settings, and the run's answer is the same with the switch on", async () => {
  const run = async (extra) => {
    W.useClock("2026-10-24T12:00:00Z");
    const env = W.newWorld({ ...LIVE, ...extra });
    W.setHolding("Hdr1111111111111111111111111111111111111111", 2_000_000);
    const a = await runJobs(env, Date.now(), W.chain(), () => 0);
    W.advance(3 * 3600_000);
    const b = await runJobs(env, Date.now(), W.chain(), () => 0);
    return [a, b];
  };
  const today = await run({});
  assert.deepEqual(policyLines(), [], "today's settings: not a line");
  assert.deepEqual(await run({ PUBLIC_V5: "on" }), today, "the job does not depend on the switch");
  assert.deepEqual(policyLines(), ["policy config refused ENVIRONMENT_UNSET deployment.environment"], "a refused configuration: one line per isolate, over two runs");
  assert.deepEqual(await run(ON), today);
  assert.equal(policyLines().length, 1, "an accepted configuration adds nothing");
});

/* ---------------------------------------------------------------- the check itself */

test("named errors: each refused setting is named, logged once per isolate as its code and path, never a value", () => {
  const cases = [
    [{ PUBLIC_V5: "on" }, ["ENVIRONMENT_UNSET"]],
    [{ PUBLIC_V5: "yes", [ENVIRONMENT_SETTING]: "prod" }, ["ENVIRONMENT_INVALID", "FLAG_VALUE_INVALID"]],
    [{ ...ON, MAIN_TOKEN_V5: "on" }, ["MAIN_TOKEN_MINT_MISSING"]],
    [{ ...ON, MAIN_TOKEN_MINT: LEGACY_MINT }, ["MAIN_TOKEN_IS_LEGACY_MINT"]],
    [{ ...ON, OFFICIAL_X_URL: LEGACY_X, OFFICIAL_TELEGRAM_URL: "https://t.me/+invite" }, ["LEGACY_SOCIAL_LINK_AS_OFFICIAL", "OFFICIAL_TELEGRAM_URL_INVALID"]],
    [{ ...ON, LEGACY_LINK: "on" }, ["LEGACY_LINK_WITHOUT_WALLET_ONLY", "MISSING_LEGACY_LINK_UNTIL"]],
    [{ ...ON, HOST_REDIRECT: "on" }, ["MISSING_SITE_ORIGIN"]],
    [{ ...ON, LAUNCH_V5: "on" }, ["LAUNCH_V5_WITH_LEGACY_LAUNCH", "LAUNCH_V5_WITHOUT_FOUNDER_RECORD", "LAUNCH_V5_WITHOUT_METADATA_V5", "MISSING_PROGRAM_ID", "MISSING_CLUSTER",
      "MISSING_TREASURY", "MISSING_METADATA_ADMIN", "MISSING_GOVERNANCE_VAULT", "MISSING_GUARDIAN", "NO_ENABLED_QUOTE_CONFIG"]],
    // the program, cluster and role inputs have no Worker setting yet: a switch that needs one stays refused
    [{ ...ON, SELECTION_V5: "shadow", MAIN_TOKEN_MINT: FAKE_MINT }, ["MISSING_ARCHIVE_PROVIDER_A", "MISSING_ARCHIVE_PROVIDER_B"]],
    [{ ...ON, CC_HOURLY: "shadow" }, ["MISSING_PROGRAM_ID", "MISSING_CLUSTER"]],
  ];
  for (const [env, codes] of cases) {
    const r = checkPolicyConfig(env);
    assert.equal(r.ok, false, JSON.stringify(env));
    assert.deepEqual([...r.codes].sort(), [...codes].sort(), JSON.stringify(env));
    assert.equal(publicV5(env), false);
  }
  assert.ok(policyLines().length > 0 && policyLines().every((l) => /^policy config refused [A-Z0-9_]+ deployment(\.[A-Za-z0-9_]+)+$/.test(l)), policyLines().join("\n"));
  const before = policyLines().length;
  for (const [env] of cases) checkPolicyConfig(env);
  assert.equal(policyLines().length, before, "once per isolate");

  // values never reach a log line or the check's answer: not a mint, a link, a secret archive address or a malformed value
  _resetPolicyCheck(); errors = [];
  const secret = "https://archive.zq-fake.test/v1?key=ZqFakeSecretValue";
  const env = { ...ON, SELECTION_V5: "shadow", MAIN_TOKEN_MINT: "zzzNotAMintButMaybePrivate", OFFICIAL_TELEGRAM_URL: "https://t.me/+invitecode", SELECTION_ARCHIVE_URL_A: secret };
  const r = checkPolicyConfig(env);
  assert.deepEqual([...r.codes].sort(), ["MAIN_TOKEN_MINT_INVALID", "MISSING_ARCHIVE_PROVIDER_B", "OFFICIAL_TELEGRAM_URL_INVALID"]);
  for (const text of [...errors, JSON.stringify(policyConfig(env))]) {
    for (const value of ["zzzNotAMint", "invitecode", "ZqFakeSecretValue", "archive.zq-fake"]) assert.ok(!text.includes(value), `${value} leaked: ${text}`);
  }
  assert.equal(deploymentFromEnv(env).inputs.secrets_present.SELECTION_ARCHIVE_URL_A, true, "a secret counts by its presence only");
  assert.ok(!JSON.stringify(deploymentFromEnv(env)).includes("ZqFakeSecretValue"));
});

test("while MAIN_TOKEN_V5 is on, the amendment-01 keys are reported by src/maintoken.js only: one line per problem, never two", () => {
  const off = checkPolicyConfig({ ...ON, MAIN_TOKEN_MINT: LEGACY_MINT });
  assert.deepEqual(off.codes, ["MAIN_TOKEN_IS_LEGACY_MINT"]);
  assert.deepEqual(policyLines(), ["policy config refused MAIN_TOKEN_IS_LEGACY_MINT deployment.inputs.MAIN_TOKEN_MINT"], "switch off: a set value is always shape-checked here");
  _resetPolicyCheck(); errors = [];
  const on = checkPolicyConfig({ ...ON, MAIN_TOKEN_V5: "on", MAIN_TOKEN_MINT: LEGACY_MINT, LEGACY_LINK: "on" });
  assert.deepEqual([...on.codes].sort(), ["LEGACY_LINK_WITHOUT_WALLET_ONLY", "MAIN_TOKEN_IS_LEGACY_MINT", "MISSING_LEGACY_LINK_UNTIL"]);
  assert.deepEqual(policyLines().sort(), ["policy config refused LEGACY_LINK_WITHOUT_WALLET_ONLY deployment.flags.LEGACY_LINK",
    "policy config refused MISSING_LEGACY_LINK_UNTIL deployment.inputs.LEGACY_LINK_UNTIL"], "the token's line is src/maintoken.js's");
});

test("the check never throws: a broken environment or a failing log is refused, not raised", () => {
  const hostile = { PUBLIC_V5: "on", get [ENVIRONMENT_SETTING]() { throw new Error("boom"); } };
  assert.deepEqual(policyConfig(hostile).errors, [{ code: "CONFIG_CHECK_FAILED", path: "deployment" }]);
  assert.equal(publicV5(hostile), false);
  assert.doesNotThrow(() => checkPolicyConfig(hostile));
  assert.deepEqual(policyLines(), ["policy config refused CONFIG_CHECK_FAILED deployment"]);
  assert.doesNotThrow(() => checkPolicyConfig({ PUBLIC_V5: "on", LEGACY_LINK: "on" }, { log: () => { throw new Error("log down"); } }));
  assert.equal(publicV5({ get PUBLIC_V5() { throw new Error("boom"); } }), false);
  assert.equal(publicV5On(null), false);
});

test("the site origins are read as src/site-config.js reads them: whatever it refuses, the check refuses by the same name", () => {
  // [settings, src/site-config.js problems, the check's codes]; an invalid list also cannot contain the origin, which validatePolicy names too
  const cases = [
    [{ SITE_ORIGIN: "https://vicinity.city" }, [], []],
    [{ SITE_ORIGIN: "HTTPS://Vicinity.City" }, [], []],
    [{ SITE_ORIGIN: "https://citycoin.dev" }, ["SITE_ORIGIN_NOT_ALLOWED"], ["SITE_ORIGIN_NOT_ALLOWED"]],
    [{ SITE_ORIGINS: "https://citycoin.dev" }, ["SITE_ORIGIN_NOT_ALLOWED"], ["SITE_ORIGIN_NOT_ALLOWED"]],
    [{ SITE_ORIGIN: "https://citycoin.dev", SITE_ORIGINS: "https://citycoin.dev, https://vicinity.city" }, [], []],
    [{ SITE_ORIGIN: "https://citycoin.dev", SITE_ORIGINS: ["https://citycoin.dev", "https://vicinity.city"] }, [], []],
    [{ SITE_ORIGIN: "https://citycoin.dev/", SITE_ORIGINS: "https://citycoin.dev" }, ["SITE_ORIGIN_INVALID"], ["SITE_ORIGIN_INVALID"]],
    [{ SITE_ORIGIN: "http://citycoin.dev", SITE_ORIGINS: "https://citycoin.dev" }, ["SITE_ORIGIN_INVALID"], ["SITE_ORIGIN_INVALID"]],
    [{ SITE_ORIGINS: "https://citycoin.dev/path" }, ["SITE_ORIGINS_INVALID"], ["SITE_ORIGINS_INVALID", "SITE_ORIGIN_NOT_ALLOWED"]],
    [{ SITE_ORIGINS: "," }, ["SITE_ORIGINS_INVALID"], ["SITE_ORIGINS_INVALID", "SITE_ORIGIN_NOT_ALLOWED"]],
  ];
  for (const [env, problems, codes] of cases) {
    assert.deepEqual([...siteConfig(env).problems].sort(), [...problems].sort(), `site-config ${JSON.stringify(env)}`);
    const got = policyConfig({ ...ON, ...env }).errors.map((e) => e.code);
    assert.deepEqual([...got].sort(), [...codes].sort(), `policy ${JSON.stringify(env)}`);
    for (const p of problems) assert.ok(got.includes(p), `${p} is named by both`);
  }
  // the redirect switch needs the canonical origin as the target (schema-and-api.md 2.2)
  assert.deepEqual(policyConfig({ ...ON, HOST_REDIRECT: "on", SITE_ORIGINS: "https://citycoin.dev https://vicinity.city" }).errors.map((e) => e.code), ["HOST_REDIRECT_TARGET_NOT_CANONICAL"]);
  assert.equal(policyConfig({ ...ON, HOST_REDIRECT: "on", SITE_ORIGIN: "https://citycoin.dev", SITE_ORIGINS: "https://citycoin.dev https://vicinity.city" }).ok, true);
});

test("the Worker's first request runs the check once per isolate; the answer is unchanged", async () => {
  const env = W.newWorld({ ...LIVE, PUBLIC_V5: "on" }); // refused: no environment named
  const a = await answer(await worker.fetch(new Request("https://vicinity.city/api/health"), env, { waitUntil() {} }));
  const b = await answer(await worker.fetch(new Request("https://vicinity.city/api/health"), env, { waitUntil() {} }));
  assert.deepEqual(a, b);
  assert.equal(a.status, 200);
  assert.deepEqual(policyLines(), ["policy config refused ENVIRONMENT_UNSET deployment.environment"]);
  assert.deepEqual(await answer(await worker.fetch(new Request("https://vicinity.city/api/policy/master"), env, { waitUntil() {} })),
    await answer(await worker.fetch(new Request("https://vicinity.city/api/nope"), env, { waitUntil() {} })), "refused: still an unknown path");
});

/* ---------------------------------------------------------------- with the switch on */

/** Every path in `value` whose key is one of `names`. */
function keysNamed(value, names, path = "") {
  if (Array.isArray(value)) return value.flatMap((x, i) => keysNamed(x, names, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [...(names.includes(k) ? [`${path}.${k}`] : []), ...keysNamed(v, names, `${path}.${k}`)]);
}
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

test("switch on: GET /api/policy is today's answer plus `master`, the public v5 policy with nothing configured shown as null", async () => {
  const env = W.newWorld(LIVE);
  const today = await call(env, "/api/policy");
  const on = await call({ ...env, ...ON }, "/api/policy");
  assert.equal(on.status, 200);
  assert.deepEqual(on.headers, today.headers, "the same headers");
  const t = JSON.parse(today.body), b = JSON.parse(on.body);
  assert.deepEqual(Object.keys(b), ["policy", "snapshotCutoff", "launched", "balanceHistory", "master"]);
  for (const k of Object.keys(t)) assert.deepEqual(b[k], t[k], `${k} unchanged`);
  const m = b.master;
  assert.deepEqual(Object.keys(m), ["policy_version", "owner_delegation_date", "policy_digest", "environment", "server_time", "status", "active_pairs", "approved_pairs",
    "selection_schedule", "fee_status", "hourly_job_status", "main_token", "legacy_tokens", "official_links", "public_authority_addresses"]);
  assert.equal(m.policy_version, "citycoin-master-v5");
  assert.equal(m.owner_delegation_date, "2026-10-23");
  assert.equal(m.environment, "production");
  assert.equal(m.server_time, "2026-10-24T12:00:00.000Z");
  assert.equal(m.status.policy, "approved_target");
  // the digest identifies the committed policy document: sha256 of its canonical JSON (sorted keys, no spaces)
  assert.match(m.policy_digest, /^[0-9a-f]{64}$/);
  assert.equal(m.policy_digest, createHash("sha256").update(canon(POLICY_JSON.policy)).digest("hex"));
  assert.equal(canonicalJson(P), canon(P));
  // nothing is active: no custom program is configured, no selection or hourly processing runs
  assert.deepEqual(m.active_pairs, []);
  assert.deepEqual(m.approved_pairs.map((p) => [p.id, p.quote_mint, p.status]), [["sol", P.quote_configs.sol.quote_mint, "approved_target"],
    ["usdc", P.quote_configs.usdc.quote_mint, "approved_target"], ["main_token", null, "approved_target"]]);
  assert.deepEqual(m.selection_schedule, { cycle_seconds: 21600, epoch_formula: "floor(unix_seconds / 21600)", clock: "UTC", boundaries_utc: ["00:00", "06:00", "12:00", "18:00"],
    next_boundary: "2026-10-24T18:00:00.000Z", first_selection_for_new_city: "next_boundary", status: "approved_target" });
  const f = m.fee_status;
  assert.equal(Object.values(f.split_bps).reduce((s, x) => s + x, 0), f.total_fee_bps);
  assert.deepEqual([f.total_fee_bps, f.bps_denominator, f.split_bps, f.platform_fees, f.status], [250, 10000, { liquidity: 50, platform: 70, founder: 50, holders: 50, buyback: 30 },
    { launch_fee: 0, send_fee: 0, receive_fee: 0 }, "approved_target"]);
  assert.deepEqual(m.hourly_job_status, { mode: "off", status: "approved_target" });
  // amendment 01: no main token, no official link and no authority is configured, so each is null; $VICINITY is a legacy token
  assert.deepEqual(m.main_token, { mint: null, config_key: "MAIN_TOKEN_MINT", verified: null, purchase_links: "hidden", status: "approved_target" });
  assert.deepEqual(m.legacy_tokens, POLICY_JSON.policy.legacy_tokens);
  assert.equal(m.legacy_tokens[0].mint, LEGACY_MINT);
  assert.deepEqual(m.official_links, { x_url: null, telegram_url: null, legacy: { x_url: LEGACY_X } });
  assert.deepEqual(m.public_authority_addresses, AUTHORITY_ROLES.map((role) => ({ role, address: null })));
  for (const role of AUTHORITY_ROLES) assert.ok(Object.hasOwn(MASTER_POLICY.deployment.inputs, role), role);
  // never the deployment block: no switch value, input or secret presence
  assert.deepEqual(keysNamed(b, ["deployment", "flags", "inputs", "secrets_present", "code_verification"]), []);
  for (const word of ["SELECTION_ARCHIVE", "PUBLIC_V5", "DEPLOYMENT_ENV"]) assert.ok(!on.body.includes(word), word);
});

test("switch on: GET /api/policy/master is the policy values, their master sections and the same public status; GET only", async () => {
  const env = W.newWorld({ ...LIVE, ...ON });
  const res = await call(env, "/api/policy/master");
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, (await call(env, "/api/policy")).headers, "the JSON headers every API answer carries (no-store)");
  const a = JSON.parse(res.body);
  assert.deepEqual(Object.keys(a), ["policyVersion", "ownerDelegationDate", "policyDigest", "serverTime", "status", "master", "policy", "masterSections"]);
  assert.equal(a.policyVersion, "citycoin-master-v5");
  assert.equal(a.policyDigest, await policyDigest());
  assert.deepEqual(a.master, JSON.parse((await call(env, "/api/policy")).body).master);
  assert.deepEqual(a.status, a.master.status);
  assert.deepEqual(a.policy, POLICY_JSON.policy, "nothing configured: the document's own values, the three configured ones null");
  assert.deepEqual(a.masterSections, { policy_version: POLICY_JSON.master_sections.policy_version, owner_delegation_date: POLICY_JSON.master_sections.owner_delegation_date,
    policy: POLICY_JSON.master_sections.policy });
  assert.deepEqual(keysNamed(a, ["deployment", "flags", "inputs", "secrets_present", "code_verification"]), []);
  for (const method of ["POST", "HEAD", "PUT"]) {
    const r = await call(env, "/api/policy/master", { method });
    assert.equal(r.status, 405, method);
    assert.deepEqual(JSON.parse(r.body), { error: "method_not_allowed" });
  }
  // other public answers do not change with the switch
  const off = W.newWorld(LIVE);
  for (const p of ["/api/health", "/api/official", "/api/check?q=%40VicinityCitySOL"]) assert.deepEqual(await call(env, p), await call(off, p), p);
});

test("switch on with the main token configured: the mint and the links appear only while MAIN_TOKEN_V5 uses them; purchase links only with a route", async () => {
  const V5 = { ...ON, MAIN_TOKEN_V5: "on", MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: "https://twitter.com/ZqFakeTestX/", OFFICIAL_TELEGRAM_URL: FAKE_TG };
  assert.equal(publicV5(V5), true);
  const now = Date.parse("2026-10-24T18:00:00Z"); // at a boundary the next one is the following
  const hidden = await publicMaster(V5, { now });
  assert.equal(hidden.selection_schedule.next_boundary, "2026-10-25T00:00:00.000Z");
  assert.equal(nextSelectionBoundary(now / 1000) * 1000, Date.parse("2026-10-25T00:00:00Z"));
  assert.deepEqual(hidden.main_token, { mint: FAKE_MINT, config_key: "MAIN_TOKEN_MINT", verified: null, purchase_links: "hidden", status: "active" });
  assert.deepEqual(hidden.official_links, { x_url: FAKE_X, telegram_url: FAKE_TG, legacy: { x_url: LEGACY_X } }, "normalized; the old account stays legacy");
  assert.equal((await publicMaster(V5, { now, routeFor: async (m) => m === FAKE_MINT })).main_token.purchase_links, "shown");
  assert.equal((await publicMaster(V5, { now, routeFor: async () => false })).main_token.purchase_links, "hidden");
  assert.equal((await publicMaster(V5, { now, routeFor: async () => { throw new Error("quote down"); } })).main_token.purchase_links, "hidden");
  assert.equal((await publicMaster(V5, { now, routeFor: async () => "yes" })).main_token.purchase_links, "hidden", "only a true route counts");
  const full = await masterPolicyAnswer(V5, { now });
  assert.equal(full.policy.main_token.mint, FAKE_MINT);
  assert.deepEqual([full.policy.official_links.x_url, full.policy.official_links.telegram_url], [FAKE_X, FAKE_TG]);
  assert.equal(full.policyDigest, createHash("sha256").update(canon(POLICY_JSON.policy)).digest("hex"), "the digest names the policy, not the configuration");
  assert.equal(P.main_token.mint, null, "the frozen document is never filled in");
  // the same values with MAIN_TOKEN_V5 off are accepted but not announced: the site does not use them yet
  const quiet = { ...ON, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: FAKE_X, OFFICIAL_TELEGRAM_URL: FAKE_TG };
  assert.equal(publicV5(quiet), true);
  const q = await publicMaster(quiet, { now, routeFor: async () => true });
  assert.deepEqual([q.main_token.mint, q.main_token.purchase_links, q.main_token.status, q.official_links.x_url, q.official_links.telegram_url], [null, "hidden", "approved_target", null, null]);
  // through the Worker (no route from the test chain): the master key carries the configured mint, with purchase links hidden
  const env = W.newWorld({ ...LIVE, ...V5 });
  const m = JSON.parse((await call(env, "/api/policy")).body).master;
  assert.deepEqual([m.main_token.mint, m.main_token.purchase_links], [FAKE_MINT, "hidden"]);
  assert.ok(!JSON.stringify(m).includes(LEGACY_MINT) || m.legacy_tokens[0].mint === LEGACY_MINT);
  assert.ok(!JSON.stringify(m.main_token).includes(LEGACY_MINT), "the legacy mint is never the main token");
});

test("canonical JSON: sorted keys at every depth, arrays in order, no spaces", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: "x" }, 2], é: true }), '{"a":[{"c":"x","d":null},2],"b":1,"é":true}');
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson("q\"uote"), '"q\\"uote"');
});
