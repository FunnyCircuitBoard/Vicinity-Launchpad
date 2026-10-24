/**
 * The main token and the official social links, in one place (owner amendment 01; Citycoin.dev master v5, stage S02A;
 * docs/citycoin-master/amendment-01-new-main-token.md sections 3 to 7). This is the only module of the Worker that reads the v5
 * policy module: every other module asks here (or src/official.js tokenMint, which applies the MAIN_TOKEN_V5 switch).
 *
 *   mainMint(env)            the configured main-token mint (MAIN_TOKEN_MINT), or null when it is unset, blank, malformed, the all-zero
 *                            key or a legacy mint. It never reads VICINITY_MINT and never answers the legacy $VICINITY mint.
 *   officialLinks(env)       { xUrl, telegramUrl, configKeys, problems }: OFFICIAL_X_URL and OFFICIAL_TELEGRAM_URL normalized, or null
 *                            when unset or refused (the legacy X account is refused as an official link). Empty means not shown.
 *   mainTokenFeatures(env)   the features of the policy's MAIN_TOKEN_FEATURES that the switches turn on: none with MAIN_TOKEN_V5 off;
 *                            the token page and the purchase links with it on (amendment section 3, "How validatePolicy maps switches")
 *   deploymentAccepted(env)  that check accepts the three keys for those features. src/v5policy.js mainTokenV5 counts the switch only
 *                            while it does: with MAIN_TOKEN_MINT unset, malformed, all-zero or a legacy mint, or a refused link, the
 *                            switch does nothing and the site is today's (never "not launched", never the legacy mint as the new token).
 *   checkDeploymentConfig(env)  the policy's validateDeploymentConfig for those features, run at the first request of an isolate and at
 *                            each job start. With MAIN_TOKEN_V5 off it logs nothing and changes nothing. With it on, each named error is
 *                            logged once per isolate, as its code and the key's name only (never a value). It never throws.
 *
 * Shape is not verification: a value only reaches the configuration after the verification record of the amendment's section 4.
 * The owner has supplied none of the three values; they stay unset, and nothing here holds a default for them.
 */
import { MASTER_POLICY, mainTokenConfig, officialLinks as configuredLinks, validateDeploymentConfig } from "./masterpolicy.js";
import { mainTokenV5On } from "./flags.js";

const P = MASTER_POLICY.policy;

/** The legacy tokens of the policy ($VICINITY): history only, never the main token, a balance source or a purchase link. */
export const LEGACY_TOKENS = P.legacy_tokens;
export const LEGACY_MINTS = Object.freeze(LEGACY_TOKENS.map((t) => t.mint));
export const isLegacyMint = (mint) => typeof mint === "string" && LEGACY_MINTS.includes(mint);
/** The former official X account (policy.official_links.legacy): answered as legacy by the link checker, never shown as official. */
export const LEGACY_X_URL = P.official_links.legacy.x_url;
/** The neutral name of the main token until its on-chain name is recorded (policy.pairs_and_branding.main_token_label). */
export const MAIN_TOKEN_LABEL = P.pairs_and_branding.main_token_label;

let memo = { raw: undefined, mint: null };
/** The configured main-token mint, or null (see the top of this file). */
export function mainMint(env) {
  const raw = env && typeof env === "object" ? env.MAIN_TOKEN_MINT : undefined;
  if (raw === undefined || raw === null) return null;
  if (memo.raw !== raw) memo = { raw, mint: mainTokenConfig(env).mint };
  return memo.mint;
}

/** The configured official links (see the top of this file). */
export const officialLinks = (env) => configuredLinks(env);

/** The main-token features the switches turn on (names of the policy's MAIN_TOKEN_FEATURES). */
export const mainTokenFeatures = (env) => (mainTokenV5On(env) ? ["token_page", "purchase_links"] : []);

/** The amendment-01 check accepts this environment's three keys for the features its switch asks for (see the top of this file). */
export function deploymentAccepted(env) {
  try { return validateDeploymentConfig(env, mainTokenFeatures(env)).ok === true; } catch { return false; }
}

const isSet = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
/**
 * The admin view of amendment 01 (GET /api/admin/config): presence and error codes only, never a value. null (no key in the answer)
 * while MAIN_TOKEN_V5 is off and none of the three settings is set: today's answer exactly.
 */
export function mainTokenStatus(env) {
  const on = mainTokenV5On(env), e = env || {};
  if (!on && !isSet(e.MAIN_TOKEN_MINT) && !isSet(e.OFFICIAL_X_URL) && !isSet(e.OFFICIAL_TELEGRAM_URL)) return null;
  let codes;
  try { codes = validateDeploymentConfig(env, mainTokenFeatures(env)).errors.map((x) => x.code); } catch { codes = ["CONFIG_CHECK_FAILED"]; }
  return { MAIN_TOKEN_V5: on, MAIN_TOKEN_MINT: isSet(e.MAIN_TOKEN_MINT), OFFICIAL_X_URL: isSet(e.OFFICIAL_X_URL), OFFICIAL_TELEGRAM_URL: isSet(e.OFFICIAL_TELEGRAM_URL), errors: codes };
}

let reported = new Set();
/** Tests: a fresh isolate. */
export const _resetDeploymentCheck = () => { reported = new Set(); memo = { raw: undefined, mint: null }; };

/**
 * { ok, codes }: the configuration check of amendment 01 for this environment. Never throws: a failure of the check itself is
 * reported as CONFIG_CHECK_FAILED (with the switch on) and the request or the job goes on.
 */
export function checkDeploymentConfig(env, { log = (...args) => console.error(...args) } = {}) {
  let r;
  try { r = validateDeploymentConfig(env, mainTokenFeatures(env)); }
  catch { r = { ok: false, errors: [{ code: "CONFIG_CHECK_FAILED", path: "env" }] }; }
  let on = false;
  try { on = mainTokenV5On(env); } catch { /* a setting that cannot be read is off */ }
  if (!on) return { ok: true, codes: [] }; // off: today's site, nothing reported
  for (const e of r.errors) {
    const key = `${e.code}|${e.path}`;
    if (reported.has(key)) continue;
    reported.add(key);
    try { log("deployment config refused", e.code, e.path); } catch { /* a log line is never worth a failed request */ }
  }
  return { ok: r.ok, codes: r.errors.map((e) => e.code) };
}
