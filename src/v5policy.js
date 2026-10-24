/**
 * The v5 policy at run time (Citycoin.dev master v5, stage S07; docs/citycoin-master/schema-and-api.md sections 2.1, 2.2 and 4.9;
 * implementation-report.md stage S07). One of the two modules of the Worker that read the policy module (the other is the amendment-01
 * adapter src/maintoken.js; test/masterpolicy.test.js keeps it that way).
 *
 *   deploymentFromEnv(env)   the policy's deployment block as this Worker's settings describe it: the switches of FLAG_VALUES (an unset
 *                            or blank one is its default), the environment (DEPLOYMENT_ENV), the inputs that have a Worker setting today
 *                            (INPUT_SETTINGS) and the presence, never the value, of the two archive secrets. Every other input (the
 *                            program, the cluster, the role keys, the quote configs and their chain facts) has no Worker setting yet: it
 *                            stays null, so a switch that needs one is refused with its MISSING_* name until the stage that builds that
 *                            switch adds the setting here.
 *   policyConfig(env)        { ok, errors: [{ code, path }], environment }: the policy's validatePolicy on that deployment. With every
 *                            v5 switch and setting unset the deployment is the policy's own default block, which validates (a test
 *                            checks it), so that case is answered without walking the policy again. Memoized per deployment; never
 *                            throws (a failure of the check itself is CONFIG_CHECK_FAILED, which counts as refused).
 *   checkPolicyConfig(env)   the check run at the first request of an isolate (src/index.js) and at each job start (src/jobs.js): each named
 *                            error is logged once per isolate, as its code and path only, never a value. With everything unset it logs
 *                            nothing: today's site. While MAIN_TOKEN_V5 is on, the three amendment-01 keys are reported by
 *                            src/maintoken.js checkDeploymentConfig (stage S02A), so they are not logged a second time here. While
 *                            HOST_REDIRECT is set on, each reason that holds it off is logged once too.
 *   publicV5(env)            PUBLIC_V5 is on AND the configuration is accepted (schema-and-api.md 2.2: validation "keeps every dependent
 *                            feature off while any error exists"). Off: GET /api/policy answers as before and /api/policy/master is an
 *                            unknown path.
 *   mainTokenV5(env)         MAIN_TOKEN_V5 as the Worker applies it: on only while every precondition holds (mainTokenRefusals below:
 *                            the deployed pages were built with the switch, the label set they were built with is this Worker's, and both
 *                            configuration checks accept the deployment). Otherwise the whole Worker answers exactly as with the switch
 *                            off. Every main-token consumer reads the switch through this, never through src/flags.js mainTokenV5On.
 *   hostRedirect(env)        HOST_REDIRECT as the Worker applies it (stage S03, src/hostroute.js): on only while every precondition holds
 *                            (hostRedirectRefusals below: the deployed wrangler.jsonc sends every page through the Worker, SITE_ORIGIN and
 *                            SITE_ORIGINS are accepted, and the v5 configuration check accepts the deployment, which needs DEPLOYMENT_ENV and
 *                            SITE_ORIGIN = https://citycoin.dev). Otherwise src/index.js answers exactly as with the switch off.
 *   publicMaster(env, opts)  the `master` key of GET /api/policy: version, approved and active pairs, the selection schedule, the fee
 *                            policy, the main_token block (mint null until configured, verified and in use), legacy_tokens, official_links
 *                            (null when unset) and the public authority addresses. Every part says its own status.
 *   masterPolicyAnswer(env, opts)  GET /api/policy/master: the same, plus the policy values and their master sections.
 *   policyDigest()           sha256 (hex) of the canonical JSON (sorted keys, no spaces) of the policy values as the document holds them
 *                            (the three configured values null), so two deployments can tell whether they run the same policy.
 *
 * Nothing here holds a mint, an X address or a Telegram address of its own: the main token and the links come from src/maintoken.js,
 * which reads MAIN_TOKEN_MINT, OFFICIAL_X_URL and OFFICIAL_TELEGRAM_URL (none of them supplied by the owner yet).
 */
import { FLAG_VALUES, MASTER_POLICY, nextSelectionBoundary, validatePolicy } from "./masterpolicy.js";
import { hostRedirectOn, mainTokenV5On, publicV5On } from "./flags.js";
import { deploymentAccepted, mainMint, officialLinks } from "./maintoken.js";
import { DEFAULT_SITE_ORIGIN, DEFAULT_SITE_ORIGINS, normalizeOrigin, siteConfig } from "./site-config.js";
import { brandOf } from "./brand.js";
import { PAGES_BUILT } from "./pages-built.js";

const P = MASTER_POLICY.policy;
const DEFAULT_DEPLOYMENT = MASTER_POLICY.deployment;

/** The Worker setting that names the deployment environment (unset, test, preview, production; unset or blank = "unset"). */
export const ENVIRONMENT_SETTING = "DEPLOYMENT_ENV";
/** The deployment inputs that have a Worker setting of the same name today. */
export const INPUT_SETTINGS = Object.freeze(["SITE_ORIGIN", "SITE_ORIGINS", "LEGACY_LINK_UNTIL", "MAIN_TOKEN_MINT", "OFFICIAL_X_URL", "OFFICIAL_TELEGRAM_URL"]);
/** The public authority roles of the policy's deployment inputs (public keys, never secrets). */
export const AUTHORITY_ROLES = Object.freeze(["program_id", "governance_vault", "treasury", "keeper", "selection_publisher", "selection_verifier",
  "hourly_verifier_a", "hourly_verifier_b", "metadata_admin", "guardian"]);

const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** SITE_ORIGINS as src/site-config.js reads it (a list, or one string of origins separated by commas or spaces), each origin normalized
 *  when it is one; anything else is kept as given, so the check names it (SITE_ORIGINS_INVALID). */
function originList(raw) {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/).filter(Boolean) : [raw];
  if (!items.length) return [raw]; // "," names no origin: malformed, never "unset"
  return items.map((o) => normalizeOrigin(o) ?? o);
}

/** The deployment block this Worker's settings describe (see the top of this file). */
export function deploymentFromEnv(env) {
  const e = env !== null && typeof env === "object" ? env : {};
  const flags = {};
  for (const name of Object.keys(FLAG_VALUES)) if (!blank(e[name])) flags[name] = String(e[name]).trim().toLowerCase();
  const environment = blank(e[ENVIRONMENT_SETTING]) ? "unset" : String(e[ENVIRONMENT_SETTING]).trim().toLowerCase();
  const inputs = {};
  // the site's own origins, read the way src/site-config.js reads them: when one of the pair is set, a blank other one is today's value
  if (!blank(e.SITE_ORIGIN) || !blank(e.SITE_ORIGINS)) {
    inputs.SITE_ORIGIN = blank(e.SITE_ORIGIN) ? DEFAULT_SITE_ORIGIN : (normalizeOrigin(e.SITE_ORIGIN) ?? e.SITE_ORIGIN);
    inputs.SITE_ORIGINS = blank(e.SITE_ORIGINS) ? [...DEFAULT_SITE_ORIGINS] : originList(e.SITE_ORIGINS);
  }
  for (const key of ["LEGACY_LINK_UNTIL", "MAIN_TOKEN_MINT", "OFFICIAL_X_URL", "OFFICIAL_TELEGRAM_URL"]) {
    if (!blank(e[key])) inputs[key] = typeof e[key] === "string" ? e[key].trim() : e[key];
  }
  const secrets = {};
  for (const name of Object.keys(DEFAULT_DEPLOYMENT.inputs.secrets_present)) secrets[name] = !blank(e[name]); // presence only
  return {
    environment,
    fixture: false, // local test fixtures never run in a Worker
    flags: { ...DEFAULT_DEPLOYMENT.flags, ...flags },
    inputs: { ...DEFAULT_DEPLOYMENT.inputs, ...inputs, secrets_present: secrets },
  };
}

const DEFAULT_KEY = JSON.stringify(DEFAULT_DEPLOYMENT);
const ACCEPTED_DEFAULT = Object.freeze({ ok: true, errors: Object.freeze([]), environment: DEFAULT_DEPLOYMENT.environment });
const CHECK_FAILED = Object.freeze({ ok: false, errors: Object.freeze([Object.freeze({ code: "CONFIG_CHECK_FAILED", path: "deployment" })]), environment: "unset" });
let memo = { key: null, value: null };

const SITE_PATHS = Object.freeze({ SITE_ORIGIN_INVALID: "deployment.inputs.SITE_ORIGIN", SITE_ORIGIN_NOT_ALLOWED: "deployment.inputs.SITE_ORIGIN",
  SITE_ORIGINS_INVALID: "deployment.inputs.SITE_ORIGINS" });

/**
 * { ok, errors, environment }: the v5 configuration check for this environment (see the top of this file). The site origins count by the
 * stricter of the two readers: what src/site-config.js refuses (it takes bare https origins only, and the redirect and host code then fall
 * back to today's values) is refused here by the same name, even where validatePolicy alone would accept it (an http://localhost origin in
 * the test and preview environments), so an accepted configuration is one the Worker really runs with.
 */
export function policyConfig(env) {
  try {
    const deployment = deploymentFromEnv(env);
    const key = JSON.stringify(deployment); // public values and presence booleans only: never a secret
    if (key === DEFAULT_KEY) return ACCEPTED_DEFAULT;
    const site = siteConfig(env).problems;
    const memoKey = `${key}|${site.join(",")}`;
    if (memo.key === memoKey) return memo.value;
    const r = validatePolicy({ ...MASTER_POLICY, deployment });
    const errors = r.errors.map((x) => ({ code: x.code, path: x.path }));
    for (const code of site) if (!errors.some((x) => x.code === code)) errors.push({ code, path: SITE_PATHS[code] || "deployment.inputs.SITE_ORIGIN" });
    const value = Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors.map((x) => Object.freeze(x))), environment: deployment.environment });
    memo = { key: memoKey, value };
    return value;
  } catch {
    return CHECK_FAILED;
  }
}

/** The amendment-01 keys that src/maintoken.js reports while MAIN_TOKEN_V5 is on. */
const MAIN_TOKEN_PATHS = new Set(["MAIN_TOKEN_MINT", "OFFICIAL_X_URL", "OFFICIAL_TELEGRAM_URL"].map((k) => `deployment.inputs.${k}`));
let reported = new Set();
/** Tests: a fresh isolate. */
export const _resetPolicyCheck = () => { reported = new Set(); memo = { key: null, value: null }; };

/**
 * { ok, codes }: the configuration check at the first request of an isolate and at each job start. Each named error is logged once per
 * isolate (its code and path, never a value). While MAIN_TOKEN_V5 is set on, each reason that holds it off is logged once too
 * ("main token switch refused <code>"), so a switch that does nothing says why. It never throws, and it changes no answer by itself: what
 * it refuses stays off.
 */
export function checkPolicyConfig(env, { log = (...args) => console.error(...args) } = {}) {
  const r = policyConfig(env);
  let tokenOn = false;
  try { tokenOn = mainTokenV5On(env); } catch { /* the switch reads as off */ }
  const say = (key, ...line) => {
    if (reported.has(key)) return;
    reported.add(key);
    try { log(...line); } catch { /* a log line is never worth a failed request */ }
  };
  for (const e of r.errors) {
    if (tokenOn && MAIN_TOKEN_PATHS.has(e.path)) continue; // reported by src/maintoken.js checkDeploymentConfig
    say(`${e.code}|${e.path}`, "policy config refused", e.code, e.path);
  }
  if (tokenOn) for (const code of mainTokenRefusals(env)) say(`gate|${code}`, "main token switch refused", code);
  let redirectOn = false;
  try { redirectOn = hostRedirectOn(env); } catch { /* the switch reads as off */ }
  if (redirectOn) for (const code of hostRedirectRefusals(env)) say(`host|${code}`, "host redirect switch refused", code);
  return { ok: r.ok, codes: r.errors.map((e) => e.code) };
}

/** PUBLIC_V5 is on and the configuration is accepted: the only way to read the switch. Never throws (anything odd reads as off). */
export function publicV5(env) {
  try { return publicV5On(env) && policyConfig(env).ok; } catch { return false; }
}

/* ---------------------------------------------------------------- MAIN_TOKEN_V5 as the Worker applies it */

let pagesBuilt = PAGES_BUILT;
/** Tests only: stand in for a page build made with the switch ({ mainTokenV5: true, brand }) or with every page sent through the Worker
 *  ({ pagesReachWorker: true }), or null for the committed src/pages-built.js. */
export const _pagesBuiltForTests = (p) => { pagesBuilt = p ? Object.freeze({ ...PAGES_BUILT, ...p }) : PAGES_BUILT; };

/**
 * Why MAIN_TOKEN_V5 does not count in this environment: [] when every precondition holds, else the reasons (codes only, never a value).
 *   MAIN_TOKEN_V5_PAGES_NOT_BUILT   the deployed pages and the client scripts were not built for the switch (src/pages-built.js, written
 *                                   by the page build from wrangler.jsonc). The pages are static files the Worker never sees (wrangler.jsonc
 *                                   run_worker_first lists only /api/*, /coin-meta/* and /official-coins.csv, and not_found_handling serves
 *                                   the 404 page from the assets too), so their footers, their /official groups and the client scripts'
 *                                   $VICINITY labels can follow the switch only through the build, and the build refuses the switch until
 *                                   the label migration (stage S48). A switch set only in the Cloudflare dashboard therefore does nothing.
 *   MAIN_TOKEN_V5_BRAND_MISMATCH    BRAND is unknown or is not the label set the pages were built with (the build accepts the switch only
 *                                   with a known label set other than today's, so the main token never appears under today's labels).
 *   MAIN_TOKEN_V5_CONFIG_REFUSED    src/maintoken.js refuses MAIN_TOKEN_MINT, OFFICIAL_X_URL or OFFICIAL_TELEGRAM_URL (unset, malformed,
 *                                   legacy): the switch never runs without a usable main token (amendment 01 section 5).
 *   MAIN_TOKEN_V5_POLICY_REFUSED    the v5 configuration check refuses the deployment (an unnamed environment, legacy seats not frozen, any
 *                                   other named error): "keeps every dependent feature off while any error exists" (schema-and-api.md 2.2).
 */
export function mainTokenRefusals(env) {
  try {
    const out = [];
    if (pagesBuilt.mainTokenV5 !== true) out.push("MAIN_TOKEN_V5_PAGES_NOT_BUILT");
    const b = brandOf(env);
    if (b.problem || b.value !== pagesBuilt.brand) out.push("MAIN_TOKEN_V5_BRAND_MISMATCH");
    if (!deploymentAccepted(env)) out.push("MAIN_TOKEN_V5_CONFIG_REFUSED");
    if (!policyConfig(env).ok) out.push("MAIN_TOKEN_V5_POLICY_REFUSED");
    return out;
  } catch {
    return ["MAIN_TOKEN_V5_CHECK_FAILED"];
  }
}

/** MAIN_TOKEN_V5 is set on AND nothing refuses it (above). Never throws: anything odd reads as off, which is today's site. */
export function mainTokenV5(env) {
  try { return mainTokenV5On(env) && mainTokenRefusals(env).length === 0; } catch { return false; }
}

/* ---------------------------------------------------------------- HOST_REDIRECT as the Worker applies it */

/**
 * Why HOST_REDIRECT does not count in this environment: [] when every precondition holds, else the reasons (codes only, never a value).
 *   HOST_REDIRECT_PAGES_BYPASS_WORKER  the deployed wrangler.jsonc does not send every request through the Worker first (its assets block's
 *                                      run_worker_first is not true; the page build records it in src/pages-built.js pagesReachWorker).
 *                                      Today run_worker_first lists only /api/*, /coin-meta/* and /official-coins.csv, so on an old host
 *                                      the pages would still be served straight from the static assets while their /api writes answered
 *                                      421: a half-moved site. The switch stays off until the pages reach the Worker.
 *   HOST_REDIRECT_SITE_REFUSED         src/site-config.js has no accepted configuration (SITE_ORIGIN and SITE_ORIGINS unset, or refused):
 *                                      no configured redirect target.
 *   HOST_REDIRECT_POLICY_REFUSED       the v5 configuration check refuses the deployment: DEPLOYMENT_ENV unset (ENVIRONMENT_UNSET),
 *                                      SITE_ORIGIN missing (MISSING_SITE_ORIGIN) or not https://citycoin.dev
 *                                      (HOST_REDIRECT_TARGET_NOT_CANONICAL), or any other named error (schema-and-api.md 2.2: "keeps every
 *                                      dependent feature off while any error exists").
 */
export function hostRedirectRefusals(env) {
  try {
    const out = [];
    if (pagesBuilt.pagesReachWorker !== true) out.push("HOST_REDIRECT_PAGES_BYPASS_WORKER");
    if (!siteConfig(env).configured) out.push("HOST_REDIRECT_SITE_REFUSED");
    if (!policyConfig(env).ok) out.push("HOST_REDIRECT_POLICY_REFUSED");
    return out;
  } catch {
    return ["HOST_REDIRECT_CHECK_FAILED"];
  }
}

/** HOST_REDIRECT is set on AND nothing refuses it (above). Never throws: anything odd reads as off, which is today's site. With the switch
 *  unset this reads one setting and nothing else, so the Worker's every request costs what it cost before. */
export function hostRedirect(env) {
  try { return hostRedirectOn(env) && hostRedirectRefusals(env).length === 0; } catch { return false; }
}

/* ---------------------------------------------------------------- the public policy */

/** JSON with every object's keys sorted (UTF-16 code unit order) and no spaces: the form the digest is taken of. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

let digest = null;
/** sha256 (lower-case hex) of canonicalJson(policy values); null if this runtime cannot hash. Computed once per isolate. */
export function policyDigest() {
  if (!digest) {
    try {
      digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(P)))
        .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), () => null);
    } catch { digest = Promise.resolve(null); }
  }
  return digest;
}

const STATEMENT = "Approved target values of the Citycoin.dev master change order v5. Approval is not evidence that anything is built, deployed, "
  + "audited or active: each part of this answer carries its own status, read from this deployment's configuration.";

/**
 * The main token as published: the configured MAIN_TOKEN_MINT (shape-checked by the policy, never a legacy mint) only while MAIN_TOKEN_V5
 * counts (mainTokenV5 above), the moment the site's own main-token consumers read it (amendment 01: the switch goes on only after the
 * verification record exists, section 4.3). Otherwise null: not configured, not shown. The official links follow the same rule as the
 * page footers (src/official.js socialProfiles): configured and accepted, and only while the switch counts.
 */
function configuredValues(env) {
  if (!mainTokenV5(env)) return { mint: null, xUrl: null, telegramUrl: null };
  const links = officialLinks(env);
  return { mint: mainMint(env), xUrl: links.xUrl, telegramUrl: links.telegramUrl };
}

/**
 * The `master` key of GET /api/policy (PUBLIC_V5). `routeFor(mint)` (optional) answers whether a live quote finds a route for the main
 * token (src/swap.js mainTokenRoute): purchase links read "hidden" until it says so.
 */
export async function publicMaster(env, { now = Date.now(), routeFor = null } = {}) {
  const cfg = policyConfig(env), inputs = deploymentFromEnv(env).inputs, v = configuredValues(env);
  let purchase = "hidden";
  if (v.mint && typeof routeFor === "function") {
    try { if ((await routeFor(v.mint)) === true) purchase = "shown"; } catch { /* no route known: hidden */ }
  }
  const fs = P.founder_selection, t = P.trading, pf = P.platform_fees;
  return {
    policy_version: MASTER_POLICY.policy_version,
    owner_delegation_date: MASTER_POLICY.owner_delegation_date,
    policy_digest: await policyDigest(),
    environment: cfg.environment,
    server_time: new Date(now).toISOString(),
    status: { policy: MASTER_POLICY.status.policy, statement: STATEMENT },
    // pairs read from the custom program's enabled quote configs on chain: none while no program is configured (program_id unset)
    active_pairs: [],
    approved_pairs: Object.entries(P.quote_configs).map(([id, q]) => ({ id, quote_symbol: q.quote_symbol, quote_mint: q.quote_mint,
      quote_decimals: q.quote_decimals, activation: q.activation, status: "approved_target" })),
    // the six-hour schedule; no selection runs in this deployment (SELECTION_V5 is not built)
    selection_schedule: { cycle_seconds: fs.cycle_seconds, epoch_formula: fs.epoch_formula, clock: fs.clock, boundaries_utc: [...fs.boundaries_utc],
      next_boundary: new Date(nextSelectionBoundary(Math.floor(now / 1000)) * 1000).toISOString(), first_selection_for_new_city: fs.first_selection_for_new_city,
      status: "approved_target" },
    // the fee of the custom curve and pool (not deployed); the live legacy launchpad fees are on /api/fees
    fee_status: { total_fee_bps: t.total_fee_bps, bps_denominator: t.bps_denominator, split_bps: { ...t.split_bps }, applies_to: t.applies_to,
      platform_fees: { launch_fee: pf.launch_fee, send_fee: pf.send_fee, receive_fee: pf.receive_fee }, transfer_tax: pf.transfer_tax,
      live_legacy_fees: "/api/fees", status: "approved_target" },
    // no hourly processing exists in this deployment (CC_HOURLY is not built)
    hourly_job_status: { mode: "off", status: "approved_target" },
    // a configured mint is shape-checked, not verified: "configured_unverified" until the verification record is machine-readable
    main_token: { mint: v.mint, config_key: P.main_token.config_key, verified: null, purchase_links: purchase, status: v.mint ? "configured_unverified" : "approved_target" },
    // $VICINITY is legacy (and the old X account a legacy link) only once the main token is in use; until then that is the approved target
    legacy_tokens: clone(P.legacy_tokens).map((t) => ({ ...t, status: v.mint ? "active" : "approved_target" })),
    official_links: { x_url: v.xUrl, telegram_url: v.telegramUrl, legacy: { x_url: P.official_links.legacy.x_url, status: v.mint ? "active" : "approved_target" } },
    // the configured public keys of each role (none has a Worker setting yet, so each is null until its stage adds one)
    public_authority_addresses: AUTHORITY_ROLES.map((role) => ({ role, address: typeof inputs[role] === "string" ? inputs[role] : null })),
  };
}

/** GET /api/policy/master (PUBLIC_V5): the public status above, the policy values (the three configured ones filled as published) and
 *  their master sections. Never the deployment block: no switch value, input or secret presence leaves the server here. */
export async function masterPolicyAnswer(env, opts = {}) {
  const master = await publicMaster(env, opts);
  const policy = clone(P);
  policy.main_token.mint = master.main_token.mint;
  policy.official_links.x_url = master.official_links.x_url;
  policy.official_links.telegram_url = master.official_links.telegram_url;
  const S = MASTER_POLICY.master_sections;
  return {
    policyVersion: master.policy_version,
    ownerDelegationDate: master.owner_delegation_date,
    policyDigest: master.policy_digest,
    serverTime: master.server_time,
    status: master.status,
    master,
    policy,
    masterSections: { policy_version: S.policy_version, owner_delegation_date: S.owner_delegation_date, policy: clone(S.policy) },
  };
}
