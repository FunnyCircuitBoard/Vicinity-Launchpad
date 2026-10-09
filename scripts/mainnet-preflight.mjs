// Mainnet preflight: are the settings, the live site and the chain ready for the in-app swap and the launchpad's curve trades?
//   npm run mainnet:preflight                                   (the vars of wrangler.jsonc + this shell's environment)
//   npm run mainnet:preflight -- --cluster mainnet              (force LAUNCHPAD_CLUSTER; --set KEY=VALUE repeatable; --rpc <url> = SOLANA_RPC_URL)
//   npm run mainnet:preflight -- --site https://vicinity.city   (also check the live Worker: health, switches, headers, cron, a live quote)
//       --expect-upgrade-authority <squads vault> --expect-admin <squads vault>   (the launchpad's keys on mainnet; FAIL when they differ)
//       --check-limits                                          (61 invalid quote POSTs to the site: the 61st must be 429; opt-in, it uses your own allowance)
// READ-ONLY: a few GETs and JSON-RPC reads; nothing is sent, nothing is changed, no key is printed (the Jupiter key goes out as a
// request header only, like the Worker sends it). Every row is PASS, WARN or FAIL with the reason; the exit code is 1 when any
// row FAILs. Secrets (SOLANA_RPC_URL, JUPITER_API_KEY, LAUNCHPAD_RPC_URL) live in Cloudflare: export them in the shell for this
// check or the rows say "not set here". docs/MAINNET.md lists every row and what to do about it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchpadCluster, jupiterConfig, swapOn, DEVNET } from "../src/cluster.js";
import { ADDRESSES, PROGRAM_IDS, ata, dbc as dbcPdas, launchpad as launchpadPdas, programDataAddress } from "../src/sol/pda.js";
import { decodeConfig, decodeLaunchConfig, decodeLaunchpad, decodeLookupTable, decodeProgramData, decodeTokenAccount, PROGRAM_CONSTANTS } from "../src/sol/dbc.js";
import { checkJupiterBuild } from "../src/jupswap.js";
import { PUBLIC_LIMITS } from "../src/guards.js";
import { isOnCurve } from "../src/sol/oncurve.js";
import { base58Decode, isSolanaAddress } from "../src/solana.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUBLIC_RPC = { mainnet: "https://api.mainnet-beta.solana.com", devnet: "https://api.devnet.solana.com" };
const SOL = ADDRESSES.wsol, SYSTEM = PROGRAM_IDS.system;
const SOL_THRESHOLD_MAINNET = 85_000_000_000n; // LAUNCHPAD.md: a SOL curve graduates at 85 SOL
const SLOW_RPC_MS = 1500, CRON_STALE_MS = 25 * 60_000, QUOTE_LIMIT = PUBLIC_LIMITS.swap_quote.max; // src/guards.js swap_quote per minute per connection
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…` : a);
const lamportsToSol = (n) => `${(Number(n) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;
const plainWallet = (address) => { try { return isOnCurve(base58Decode(address)); } catch { return false; } }; // an on-curve key = one person's key; a Squads vault or any PDA is off the curve

/** The command line: --set KEY=VALUE (repeatable), --cluster devnet|mainnet, --rpc <url>, --site <url>, --expect-upgrade-authority, --expect-admin, --check-limits. */
export function parseArgs(argv = []) {
  const o = { set: {}, cluster: null, rpc: null, site: null, expectUpgradeAuthority: null, expectAdmin: null, checkLimits: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--set" && v) { const [k, ...rest] = argv[++i].split("="); o.set[k] = rest.join("="); }
    else if (a === "--cluster" && v) o.cluster = argv[++i];
    else if (a === "--rpc" && v) o.rpc = argv[++i];
    else if (a === "--site" && v) o.site = argv[++i].replace(/\/+$/, "");
    else if (a === "--expect-upgrade-authority" && v) o.expectUpgradeAuthority = argv[++i];
    else if (a === "--expect-admin" && v) o.expectAdmin = argv[++i];
    else if (a === "--check-limits") o.checkLimits = true;
  }
  return o;
}
/** The vars of wrangler.jsonc (comments and trailing commas stripped), the shell's environment on top, then --set KEY=VALUE / --cluster / --rpc. */
export function settingsFrom({ wranglerPath, env = process.env, argv = [] } = {}) {
  let vars = {};
  if (wranglerPath) {
    const text = readFileSync(wranglerPath, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
    vars = JSON.parse(text).vars || {};
  }
  const out = { ...vars };
  for (const k of Object.keys(env)) if (/^(SWAP|LAUNCHPAD_|JUPITER_|SOLANA_|VICINITY_MINT|ADMIN_WALLETS|RPC_TIMEOUT_MS)/.test(k)) out[k] = env[k];
  const a = parseArgs(argv);
  Object.assign(out, a.set);
  if (a.cluster) out.LAUNCHPAD_CLUSTER = a.cluster;
  if (a.rpc) out.SOLANA_RPC_URL = a.rpc;
  return out;
}

async function rpc(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const d = await res.json();
  if (d.error) throw new Error(`rpc_${d.error.code}: ${d.error.message}`);
  return d.result;
}
const acct = (url, address, fetchImpl, encoding = "base64", extra = {}) => rpc(url, "getAccountInfo", [address, { encoding, commitment: "confirmed", ...extra }], fetchImpl).then((r) => (r && r.value) || null);
const getJson = async (fetchImpl, url, init = {}) => {
  const t0 = Date.now();
  const res = await fetchImpl(url, { ...init, headers: { accept: "application/json", ...(init.headers || {}) }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
  let body = null; try { body = await res.json(); } catch { body = null; }
  return { res, body, ms: Date.now() - t0 };
};
const errText = (e) => String((e && e.message) || e).replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "<address>").slice(0, 100);

/**
 * The rows. `env` = the settings; options: fetchImpl (tests pass a fake), site (the live Worker's origin, optional), the expected
 * mainnet keys, checkLimits. Returns [{ level: PASS|WARN|FAIL, name, detail }]. Every read is a GET or a JSON-RPC read.
 */
export async function preflight(env, { fetchImpl = fetch, now = Date.now(), site = null, expectUpgradeAuthority = null, expectAdmin = null, checkLimits = false } = {}) {
  const rows = [];
  const row = (level, name, detail = "") => { rows.push({ level, name, detail }); return level; };
  const lp = launchpadCluster(env), jc = jupiterConfig(env);
  const swap = swapOn(env), trading = String(env.LAUNCHPAD_TRADING || "").trim().toLowerCase() === "on";
  const mainnetLp = lp.cluster === "mainnet";

  // ---- the site's own settings ----
  row(swap ? "PASS" : "WARN", "SWAP", swap ? "on: the Buy & swap panel and /api/swap/* are live" : `"${env.SWAP ?? ""}": the panel is hidden and /api/swap/* answers 404 (set SWAP=on to open it)`);
  row(trading ? (lp.ready ? "PASS" : "FAIL") : "WARN", "LAUNCHPAD_TRADING", trading ? (lp.ready ? `on, ${lp.cluster}` : `on but NOT ready on ${lp.cluster}: missing ${lp.missing.join(", ")} (curve trades stay off until set)`) : `"${env.LAUNCHPAD_TRADING ?? ""}": curve trades of city coins are off`);
  row(trading && !mainnetLp ? "WARN" : "PASS", "LAUNCHPAD_CLUSTER", mainnetLp ? "mainnet" : `devnet${trading ? ": curve trades are DEVNET test coins (test SOL, no value) — a test path, not the real thing; set LAUNCHPAD_CLUSTER=mainnet after docs/MAINNET.md section 4" : ""}`);
  const mint = String(env.VICINITY_MINT || "").trim();
  row(isSolanaAddress(mint) ? "PASS" : "FAIL", "VICINITY_MINT", isSolanaAddress(mint) ? mint : "not a Solana address: the panel has no $VICINITY and /token shows the countdown");
  const mainRpc = String(env.SOLANA_RPC_URL || "").trim();
  row(mainRpc ? "PASS" : "FAIL", "SOLANA_RPC_URL", mainRpc ? `set (${new URL(mainRpc).host})` : "not set here: the Worker would fall back to the public mainnet RPC, which rate-limits and refuses getProgramAccounts (set the provider's URL as a Secret)");
  const rpcUrl = mainRpc || PUBLIC_RPC.mainnet;
  row(/^\d+$/.test(String(env.RPC_TIMEOUT_MS || "")) ? "PASS" : "WARN", "RPC_TIMEOUT_MS", /^\d+$/.test(String(env.RPC_TIMEOUT_MS || "")) ? `${env.RPC_TIMEOUT_MS} ms` : "unset: the default of src/chain.js applies");

  // ---- the live site (only with --site) ----
  if (site) await siteRows(site, { row, env, mint, swap, trading, fetchImpl, now, checkLimits });

  // ---- Jupiter ----
  row(jc.keyed ? "PASS" : "WARN", "JUPITER_API_KEY", jc.keyed ? `set (${jc.key.length} characters, never printed): builds on the plan's own allowance` : "not set here: previews are keyless estimates and builds run on Jupiter's ANONYMOUS allowance, which may stop without notice (portal.jup.ag gives a key; required for a launch)");
  row(jc.keyed && jc.rps > 1 ? "PASS" : "WARN", "JUPITER_RPS", `${jc.rps} per second per server${jc.rps === 1 ? " (the default: set the plan's rate, e.g. 10, or most previews during a rush become estimates)" : jc.rps < 10 ? " (below 10: a launch-day rush will see estimates instead of builds)" : ""}`);
  row(jc.platformFeeBps ? (jc.feeAccount ? "PASS" : "FAIL") : "PASS", "SWAP_PLATFORM_FEE_BPS / SWAP_FEE_ACCOUNT", jc.platformFeeBps ? (jc.feeAccount ? `${jc.platformFeeBps} bps to ${jc.feeAccount}` : `${jc.platformFeeBps} bps but no valid SWAP_FEE_ACCOUNT: no fee will be charged`) : "no platform fee (an owner decision; 0 by default)");
  if (isSolanaAddress(mint)) {
    try {
      const { res: q, body: d, ms } = await getJson(fetchImpl, `${jc.lite}/swap/v1/quote?inputMint=${SOL}&outputMint=${mint}&amount=10000000&slippageBps=100&swapMode=ExactIn`);
      if (q.ok && d && d.outAmount) row("PASS", "Jupiter lite quote SOL → $VICINITY", `0.01 SOL → ${d.outAmount} raw units via ${(d.routePlan || []).map((r) => r.swapInfo && r.swapInfo.label).filter(Boolean).join(" + ") || "?"} in ${ms} ms (read-only)`);
      else row("FAIL", "Jupiter lite quote SOL → $VICINITY", `HTTP ${q.status} ${d && (d.error || d.errorCode) ? String(d.error || d.errorCode).slice(0, 80) : ""}: no route today means no one can buy $VICINITY here`);
    } catch (e) { row("FAIL", "Jupiter lite quote SOL → $VICINITY", `unreachable: ${errText(e)}`); }
    // the build the Worker would ask for a 0.01 SOL buy by the dev wallet (with the key when set, on Jupiter's anonymous allowance when
    // not: the Worker builds either way), run through the Worker's own validator: a layout Jupiter changed fails closed HERE first,
    // key or no key. Read-only: a GET, nothing signed, nothing sent.
    const BUILD = "Jupiter build SOL → $VICINITY", host = new URL(jc.base).host, how = jc.keyed ? "keyed" : "KEYLESS (Jupiter's anonymous allowance, which may stop without notice: set JUPITER_API_KEY before a launch)";
    try {
      const q = new URLSearchParams({ inputMint: SOL, outputMint: mint, amount: "10000000", taker: ADDRESSES.feeRecipient, slippageBps: "100", maxAccounts: "64", wrapAndUnwrapSol: "true" });
      if (jc.platformFeeBps && jc.feeAccount) { q.set("platformFeeBps", String(jc.platformFeeBps)); q.set("feeAccount", jc.feeAccount); }
      const { res, body, ms } = await getJson(fetchImpl, `${jc.base}/swap/v2/build?${q}`, { headers: jc.headers });
      if (res.status === 429) row("WARN", BUILD, `429 from ${host} (${how}): the allowance is used up right now (Retry-After ${res.headers.get("retry-after") || "?"} s)`);
      else if (!res.ok || !body) row(jc.keyed ? "FAIL" : "WARN", BUILD, `HTTP ${res.status} ${body && (body.error || body.message) ? String(body.error || body.message).slice(0, 80) : ""} from ${host} (${how}): ${jc.keyed ? "the key or the plan is not accepted" : "the anonymous allowance refused it; a key is the fix"}`);
      else {
        try {
          await checkJupiterBuild(body, { taker: ADDRESSES.feeRecipient, inputMint: SOL, outputMint: mint, inAmount: 10_000_000n, platformFeeBps: jc.platformFeeBps, feeAccount: jc.feeAccount });
          row(jc.keyed ? "PASS" : "WARN", BUILD, `${host} answered in ${ms} ms (${how}) and the Worker's validator accepts today's layout (${(body.routePlan || []).map((r) => r.swapInfo && r.swapInfo.label).filter(Boolean).join(" + ") || "?"}, ${Object.keys(body.addressesByLookupTableAddress || {}).length} lookup tables${jc.platformFeeBps ? `, platform fee ${jc.platformFeeBps} bps to ${short(jc.feeAccount)}` : ""}); nothing was signed or sent`);
        } catch (e) { row("FAIL", BUILD, `Jupiter answered (${how}) but the Worker's validator refuses it (${e && e.code ? e.code : errText(e)}): swaps would answer jupiter_refused until src/jupswap.js learns the new layout${jc.platformFeeBps ? " (a platform fee is on: the fee-on layout was never recorded from a real answer, see docs/MAINNET.md)" : ""}`); }
      }
    } catch (e) { row(jc.keyed ? "FAIL" : "WARN", BUILD, `unreachable (${how}): ${errText(e)}`); }
  }

  // ---- mainnet reads: the mint and the programs (read-only) ----
  try {
    const genesis = await rpc(rpcUrl, "getGenesisHash", [], fetchImpl);
    row(genesis === MAINNET_GENESIS ? "PASS" : "FAIL", "mainnet RPC answers", genesis === MAINNET_GENESIS ? `${new URL(rpcUrl).host} is mainnet` : `${new URL(rpcUrl).host} is NOT mainnet (genesis ${genesis})`);
    try {
      const health = await rpc(rpcUrl, "getHealth", [], fetchImpl);
      const t0 = Date.now();
      await rpc(rpcUrl, "getMultipleAccounts", [[isSolanaAddress(mint) ? mint : PROGRAM_IDS.jupiter, PROGRAM_IDS.jupiter], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], fetchImpl);
      const ms = Date.now() - t0;
      row(health === "ok" && ms <= SLOW_RPC_MS ? "PASS" : "WARN", "mainnet RPC health", `getHealth ${health}, two accounts in ${ms} ms${ms > SLOW_RPC_MS ? " (slow: a swap waits for a simulation and a status poll per trade; size the plan)" : ""}`);
    } catch (e) { row("WARN", "mainnet RPC health", `getHealth / getMultipleAccounts failed: ${errText(e)}`); }
    if (isSolanaAddress(mint)) {
      const a = await acct(rpcUrl, mint, fetchImpl, "jsonParsed");
      const info = a && a.data && a.data.parsed && a.data.parsed.info;
      if (info && a.data.parsed.type === "mint") row(info.mintAuthority == null && info.freezeAuthority == null ? "PASS" : "WARN", "$VICINITY mint on mainnet", `${info.decimals} decimals, supply ${info.supply}, mint authority ${info.mintAuthority ?? "none"}, freeze authority ${info.freezeAuthority ?? "none"}`);
      else row("FAIL", "$VICINITY mint on mainnet", "the address is not a token mint");
    }
    const jup = await acct(rpcUrl, PROGRAM_IDS.jupiter, fetchImpl, "base64", { dataSlice: { offset: 0, length: 0 } });
    row(jup && jup.executable ? "PASS" : "FAIL", "Jupiter program on mainnet", jup && jup.executable ? PROGRAM_IDS.jupiter : "not an executable account");
  } catch (e) { row("FAIL", "mainnet RPC answers", `unreachable: ${errText(e)}`); }

  // ---- the launchpad cluster: the program, its upgrade authority, the configs, the allow-list, the referral accounts, the table, the global account ----
  const mainDefaults = launchpadCluster({ LAUNCHPAD_CLUSTER: "mainnet" }); // the settings alone: nothing from this shell
  const noMainDefaults = mainDefaults.programId == null && mainDefaults.dbcConfigs.length === 0 && mainDefaults.lookupTable == null;
  row(noMainDefaults ? "PASS" : "FAIL", "no mainnet launchpad address in the code", `mainnet defaults: program ${JSON.stringify(mainDefaults.programId)}, configs ${JSON.stringify(mainDefaults.dbcConfigs)}, lookup table ${JSON.stringify(mainDefaults.lookupTable)} (devnet defaults ${DEVNET.programId.slice(0, 6)}…)${noMainDefaults ? "" : " — a mainnet address crept into src/cluster.js: the launchpad's mainnet addresses are SETTINGS the team sets after deploying, never code"}`);
  if (mainnetLp && !String(env.LAUNCHPAD_RPC_URL || "").trim() && !mainRpc) row("WARN", "LAUNCHPAD_RPC_URL", "unset and SOLANA_RPC_URL unset: curve trades would use the public mainnet RPC");
  else row("PASS", "LAUNCHPAD_RPC_URL", mainnetLp ? (String(env.LAUNCHPAD_RPC_URL || "").trim() ? `set (${new URL(lp.rpc).host})` : `unset: = SOLANA_RPC_URL (${new URL(lp.rpc).host})`) : `devnet: ${new URL(lp.rpc).host}`);
  for (const k of ["LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS"]) {
    const missing = lp.missing.includes(k);
    row(missing ? "FAIL" : "PASS", k, missing ? `not set: ${mainnetLp ? "REQUIRED on mainnet (there is no default): set it after deploying the program and creating the Meteora configs" : "the devnet default is missing?!"}` : k === "LAUNCHPAD_PROGRAM_ID" ? lp.programId : lp.dbcConfigs.join(", "));
  }
  if (lp.ready) await launchpadRows(lp, { row, env, fetchImpl, mainnetLp, expectUpgradeAuthority, expectAdmin });
  else if (expectUpgradeAuthority || expectAdmin) row("FAIL", "launchpad keys", "an expected upgrade authority / admin was given but the program id and configs are not set: nothing to compare");
  // ---- the dev wallet ----
  const admins = String(env.ADMIN_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
  row(admins.includes(ADDRESSES.feeRecipient) ? "PASS" : "WARN", "dev wallet", `${ADDRESSES.feeRecipient} is the fee recipient compiled into the program${admins.includes(ADDRESSES.feeRecipient) ? " and an admin wallet" : "; it is NOT in ADMIN_WALLETS"}`);
  rows.at = new Date(now).toISOString();
  return rows;
}

/** The live Worker: health, the switches it reports, the swap config, the security headers, the cron, one live quote, the attempt limit (opt-in). */
async function siteRows(site, { row, env, mint, swap, trading, fetchImpl, now, checkLimits }) {
  const host = (() => { try { return new URL(site).host; } catch { return site; } })();
  let official = null;
  try {
    const { res, body, ms } = await getJson(fetchImpl, `${site}/api/health`);
    row(res.status === 200 && body && body.ok ? "PASS" : "FAIL", "site /api/health", res.status === 200 && body && body.ok ? `${host} answers in ${ms} ms` : `HTTP ${res.status}`);
  } catch (e) { row("FAIL", "site /api/health", `unreachable: ${errText(e)}`); return; }
  try {
    const { body } = await getJson(fetchImpl, `${site}/api/official`);
    official = body;
    const siteSwap = Boolean(body && body.swap === true), siteTrading = Boolean(body && body.launchpadTrading);
    const mintOk = !body || !isSolanaAddress(mint) || body.tokenContract === mint;
    row(siteSwap === swap && siteTrading === trading && mintOk ? "PASS" : "WARN", "site /api/official", `swap ${siteSwap ? "on" : "off"}, launchpadTrading ${siteTrading ? `on (${body.launchpadTrading.cluster})` : "off"}, $VICINITY ${body && body.tokenContract ? body.tokenContract : "not published"}${siteSwap !== swap || siteTrading !== trading ? " — differs from the settings checked here (the dashboard variables may differ from wrangler.jsonc)" : ""}${mintOk ? "" : " — a different mint than VICINITY_MINT here"}`);
  } catch (e) { row("FAIL", "site /api/official", `unreadable: ${errText(e)}`); }
  for (const path of ["/", "/api/health"]) {
    try {
      const res = await fetchImpl(`${site}${path}`, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
      const h = (n) => res.headers.get(n) || "";
      const missing = [];
      if (!/default-src 'self'/.test(h("content-security-policy")) || !/connect-src 'self'/.test(h("content-security-policy"))) missing.push("CSP default-src/connect-src 'self'");
      if (!/max-age=/.test(h("strict-transport-security"))) missing.push("HSTS");
      if (!/nosniff/i.test(h("x-content-type-options"))) missing.push("nosniff");
      if (!/deny/i.test(h("x-frame-options")) && !/frame-ancestors 'none'/.test(h("content-security-policy"))) missing.push("frame-ancestors / X-Frame-Options");
      row(missing.length ? "FAIL" : "PASS", `site security headers ${path}`, missing.length ? `missing: ${missing.join(", ")}` : "CSP (self only), HSTS, nosniff, no framing");
    } catch (e) { row("FAIL", `site security headers ${path}`, `unreachable: ${errText(e)}`); }
  }
  try {
    const { body } = await getJson(fetchImpl, `${site}/api/policy`);
    const bh = body && body.balanceHistory;
    const takenAt = bh && bh.lastSample && Date.parse(bh.lastSample.taken_at);
    const age = Number.isFinite(takenAt) ? now - takenAt : null;
    if (bh && bh.running && age != null) row(age <= CRON_STALE_MS ? "PASS" : "WARN", "site cron alive", `last balance sample ${Math.round(age / 60_000)} min ago, ${bh.samplesLast24h} in 24 h${age > CRON_STALE_MS ? " (the 10-minute cron has not sampled for a while: check Cloudflare → Workers → Cron)" : ""}`);
    else row(body && body.launched ? "FAIL" : "WARN", "site cron alive", body && body.launched ? "no balance sample yet although the mint is set: the cron has never run" : "no sample yet (nothing to sample before the launch)");
  } catch (e) { row("WARN", "site cron alive", `/api/policy unreadable: ${errText(e)}`); }
  if (official && official.swap === true) {
    try {
      const { body } = await getJson(fetchImpl, `${site}/api/swap/config`);
      const ok = body && body.ok && body.cluster === "mainnet";
      row(ok ? (body.jupiter && body.jupiter.keyed ? "PASS" : "WARN") : "FAIL", "site /api/swap/config", ok ? `cluster ${body.cluster}, Jupiter ${body.jupiter.keyed ? "keyed" : "KEYLESS (estimates for previews; builds on Jupiter's anonymous allowance, which may stop without notice: set JUPITER_API_KEY)"} at ${body.jupiter.host} (${body.jupiter.rps}/s), ${body.tokens.length} tokens, launchpad ${body.launchpad.enabled ? `on (${body.launchpad.cluster}, program ${short(body.launchpad.programId)}, ${body.launchpad.dbcConfigs.length} configs)` : "off"}` : `HTTP body ${JSON.stringify(body).slice(0, 80)}`);
    } catch (e) { row("FAIL", "site /api/swap/config", `unreadable: ${errText(e)}`); }
    if (isSolanaAddress(mint)) {
      try {
        const { res, body, ms } = await getJson(fetchImpl, `${site}/api/swap/quote`, { method: "POST", headers: { "content-type": "application/json", origin: site }, body: JSON.stringify({ inputMint: SOL, outputMint: mint, amount: "0.01", slippageBps: 100 }) });
        if (res.ok && body && body.ok) row("PASS", "site live quote SOL → $VICINITY", `0.01 SOL → ${body.outUi} $VICINITY (${body.source}${body.estimate ? ", an estimate: no wallet asked" : ""}) in ${ms} ms via ${(body.route || []).join(" + ")} (read-only, nothing built)`);
        else row(res.status === 503 ? "WARN" : "FAIL", "site live quote SOL → $VICINITY", `HTTP ${res.status} ${body && body.error ? body.error : ""}${res.status === 503 ? " (Jupiter busy or unreachable right now)" : ""}`);
      } catch (e) { row("FAIL", "site live quote SOL → $VICINITY", `unreachable: ${errText(e)}`); }
    }
    if (checkLimits) {
      // 61 invalid bodies: counted BEFORE any work (src/guards.js), answered 400 bad_json, so nothing reaches Jupiter; the 61st must be 429
      try {
        let last = null, first429 = null;
        for (let i = 1; i <= QUOTE_LIMIT + 1; i++) {
          const res = await fetchImpl(`${site}/api/swap/quote`, { method: "POST", headers: { "content-type": "application/json", origin: site }, body: "{}", signal: AbortSignal.timeout(10_000) });
          last = res.status;
          if (res.status === 429 && first429 == null) first429 = i;
        }
        row(first429 != null && first429 > 1 && last === 429 ? "PASS" : "FAIL", "site attempt limit /api/swap/quote", first429 != null ? `the first 429 came on request ${first429} of ${QUOTE_LIMIT + 1} (limit ${QUOTE_LIMIT} per minute per connection)${first429 < QUOTE_LIMIT ? " — earlier than the code's own limit: another limit (WAF?) sits in front" : ""}` : `${QUOTE_LIMIT + 1} requests and no 429: the attempt counter is not working (is the database bound?)`);
      } catch (e) { row("FAIL", "site attempt limit /api/swap/quote", `unreachable: ${errText(e)}`); }
    }
  } else row("WARN", "site /api/swap/config", "the site says swap is off: the config, the live quote and the limit check are skipped");
}

/** The launchpad cluster's chain: program, upgrade authority, DBC, global account, each config + allow-list entry + referral account, the lookup table. */
async function launchpadRows(lp, { row, env, fetchImpl, mainnetLp, expectUpgradeAuthority, expectAdmin }) {
  const lrpc = lp.rpc;
  try {
    const genesis = await rpc(lrpc, "getGenesisHash", [], fetchImpl);
    const want = mainnetLp ? MAINNET_GENESIS : DEVNET_GENESIS;
    row(genesis === want ? "PASS" : "FAIL", "launchpad RPC cluster", genesis === want ? `${new URL(lrpc).host} is ${lp.cluster}` : `${new URL(lrpc).host} is not ${lp.cluster}`);
    try {
      const health = await rpc(lrpc, "getHealth", [], fetchImpl);
      const t0 = Date.now();
      await rpc(lrpc, "getMultipleAccounts", [lp.dbcConfigs, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], fetchImpl);
      const ms = Date.now() - t0;
      row(health === "ok" && ms <= SLOW_RPC_MS ? "PASS" : "WARN", "launchpad RPC health", `getHealth ${health}, the configs in ${ms} ms${ms > SLOW_RPC_MS ? " (slow: every curve quote reads the pool)" : ""}`);
    } catch (e) { row("WARN", "launchpad RPC health", `getHealth / getMultipleAccounts failed: ${errText(e)}`); }
    const prog = await acct(lrpc, lp.programId, fetchImpl);
    row(prog && prog.executable && prog.owner === PROGRAM_IDS.upgradeableLoader ? "PASS" : "FAIL", "launchpad program", prog && prog.executable ? `${lp.programId} (owner ${prog.owner})` : `${lp.programId} is not a deployed program on ${lp.cluster}`);
    if (prog && prog.executable) {
      // the first 45 bytes of ProgramData: state, last deploy slot, Option<upgrade authority>
      const pd = await acct(lrpc, await programDataAddress(lp.programId), fetchImpl, "base64", { dataSlice: { offset: 0, length: 45 } });
      const data = pd ? decodeProgramData(pd) : null;
      if (!data) row("FAIL", "upgrade authority", "the program's ProgramData account could not be read or decoded");
      else if (data.upgradeAuthority == null) row("PASS", "upgrade authority", `none: the program is immutable (no upgrade can ever happen; last deploy slot ${data.slot})`);
      else if (expectUpgradeAuthority) row(data.upgradeAuthority === expectUpgradeAuthority ? "PASS" : "FAIL", "upgrade authority", data.upgradeAuthority === expectUpgradeAuthority ? `${data.upgradeAuthority} = the expected multisig (last deploy slot ${data.slot})` : `${data.upgradeAuthority} is NOT the expected ${expectUpgradeAuthority}: whoever holds that key can replace the program`);
      // on mainnet the only way this row passes is to NAME the multisig and match it: a stranger's vault or any program address must never read as fine by accident
      else if (mainnetLp) row("FAIL", "upgrade authority", `${data.upgradeAuthority} ${plainWallet(data.upgradeAuthority) ? "is a single wallet key: one person can replace the program. Hand it to the Squads multisig (solana program set-upgrade-authority)" : "is not a plain wallet (a multisig vault or a program address), but nobody said whose"}; on mainnet this row needs --expect-upgrade-authority <squads vault> and passes only when it matches`);
      else if (plainWallet(data.upgradeAuthority)) row("WARN", "upgrade authority", `${data.upgradeAuthority} is a single wallet key (the devnet deployer; mainnet needs the Squads multisig)`);
      else row("WARN", "upgrade authority", `${data.upgradeAuthority} is not a plain wallet (a multisig vault or a program address): confirm it is yours with --expect-upgrade-authority`);
    }
    const dbc = await acct(lrpc, PROGRAM_IDS.dbc, fetchImpl, "base64", { dataSlice: { offset: 0, length: 0 } });
    row(dbc && dbc.executable ? "PASS" : "FAIL", "Meteora DBC program", dbc && dbc.executable ? PROGRAM_IDS.dbc : "not an executable account on this cluster");
    const P = launchpadPdas(lp.programId);
    const g = await acct(lrpc, await P.launchpad(), fetchImpl);
    const global = g ? decodeLaunchpad(g, lp.programId) : null;
    row(global ? (global.launchesPaused ? "WARN" : "PASS") : "FAIL", "launchpad global account", global ? `admin ${global.admin}, launches ${global.launchesPaused ? "PAUSED" : "open"}, payouts ${global.payoutsPaused ? "PAUSED" : "open"}, rewards program ${global.rewardsProgram}` : "not initialised: run the launchpad setup (scripts/launchpad/setup.mjs)");
    if (global) {
      if (expectAdmin) row(global.admin === expectAdmin ? "PASS" : "FAIL", "launchpad admin", global.admin === expectAdmin ? `${global.admin} = the expected multisig` : `${global.admin} is NOT the expected ${expectAdmin}: that key approves launches, pauses and payouts`);
      else if (mainnetLp) row("FAIL", "launchpad admin", `${global.admin} ${plainWallet(global.admin) ? "is a single wallet key: hand the admin role to the Squads multisig (propose_admin / accept_admin)" : "is not a plain wallet, but nobody said whose"}; on mainnet this row needs --expect-admin <squads vault> and passes only when it matches`);
      else if (plainWallet(global.admin)) row("WARN", "launchpad admin", `${global.admin} is a single wallet key (the devnet deployer; mainnet needs the Squads multisig)`);
      else row("WARN", "launchpad admin", `${global.admin} is not a plain wallet: confirm it is your multisig with --expect-admin`);
      row(global.rewardsProgram && global.rewardsProgram !== SYSTEM ? "PASS" : "FAIL", "rewards program", global.rewardsProgram && global.rewardsProgram !== SYSTEM ? `${global.rewardsProgram} (vicinity_rewards: holder rewards per city)` : "unset: the global account names no rewards program");
    }
    for (const c of lp.dbcConfigs) {
      const a = await acct(lrpc, c, fetchImpl);
      const cfg = a && a.owner === PROGRAM_IDS.dbc ? decodeConfig(a) : null;
      if (!cfg) { row("FAIL", `DBC config ${short(c)}`, "not a Meteora DBC config account on this cluster"); continue; }
      const feeOk = cfg.feeClaimer === ADDRESSES.feeRecipient && cfg.leftoverReceiver === ADDRESSES.feeRecipient;
      const feeBps = Number(cfg.feeNumerator) / 100_000; // Meteora's fee denominator is 1e9: 12,500,000 = 125 bps
      const feeFine = feeBps === 125 && cfg.feeNumerator <= BigInt(PROGRAM_CONSTANTS.MAX_TRADE_FEE_NUMERATOR);
      const creatorFine = cfg.creatorTradingFeePercentage === BigInt(PROGRAM_CONSTANTS.REQUIRED_CREATOR_FEE_PERCENT);
      const poolFeeFine = cfg.poolCreationFee <= BigInt(PROGRAM_CONSTANTS.MAX_POOL_CREATION_FEE_LAMPORTS);
      const quote = cfg.quoteMint === SOL ? "SOL" : cfg.quoteMint;
      const thresholdNote = mainnetLp && cfg.quoteMint === SOL && cfg.migrationQuoteThreshold !== SOL_THRESHOLD_MAINNET ? ` — graduates at ${lamportsToSol(cfg.migrationQuoteThreshold)}, not the 85 SOL LAUNCHPAD.md describes (an owner decision)` : "";
      const problems = [...(feeOk ? [] : ["fee claimer / leftover receiver is NOT the dev wallet: fees would go elsewhere"]), ...(feeFine ? [] : [`trade fee ${feeBps} bps (125 expected)`]), ...(creatorFine ? [] : [`creator share ${cfg.creatorTradingFeePercentage}% (${PROGRAM_CONSTANTS.REQUIRED_CREATOR_FEE_PERCENT} expected)`]), ...(poolFeeFine ? [] : [`pool creation fee ${lamportsToSol(cfg.poolCreationFee)} above the program's cap`])];
      row(problems.length ? "FAIL" : thresholdNote ? "WARN" : "PASS", `DBC config ${short(c)}`, `quote ${quote}, graduates at ${cfg.migrationQuoteThreshold} raw${cfg.quoteMint === SOL ? ` (${lamportsToSol(cfg.migrationQuoteThreshold)})` : ""}, trade fee ${feeBps} bps, creator share ${cfg.creatorTradingFeePercentage}%, pool creation fee ${lamportsToSol(cfg.poolCreationFee)}, fee claimer ${cfg.feeClaimer}${feeOk ? " (= the dev wallet constant)" : ""}${problems.length ? ` — ${problems.join("; ")}` : ""}${thresholdNote}`);
      // our program's allow-list entry for this config: launches with a config that is not listed (or disabled) are refused by the program
      const lc = await acct(lrpc, await P.launchConfig(c), fetchImpl);
      const entry = lc ? decodeLaunchConfig(lc, lp.programId) : null;
      row(entry && entry.enabled && entry.dbcConfig === c ? "PASS" : "FAIL", `allow-list entry ${short(c)}`, entry ? `${entry.enabled ? "enabled" : "DISABLED"}, quote ${entry.quoteMint === SOL ? "SOL" : entry.quoteMint}, fee numerator ${entry.tradeFeeNumerator}, pool creation fee ${lamportsToSol(entry.poolCreationFee)}` : "no LaunchConfig record under our program for this config: run setup.mjs add-config");
      // the dev wallet's referral account for the quote mint: Meteora refuses a trade whose referral account is missing, so every trade recreates it (the trader pays 0.002 SOL)
      const ref = await acct(lrpc, await ata(ADDRESSES.feeRecipient, cfg.quoteMint), fetchImpl);
      const tok = ref ? decodeTokenAccount(ref) : null;
      row(tok && tok.owner === ADDRESSES.feeRecipient && tok.mint === cfg.quoteMint ? "PASS" : "WARN", `referral account ${quote === "SOL" ? "SOL" : short(quote)}`, tok ? `exists (${tok.amount} raw units waiting for the dev wallet)` : "missing: the next trade of each curve recreates it and THAT TRADER pays about 0.002 SOL of rent that is not returned (the quote says so); setup.mjs referral-accounts creates it, and claim-platform-fees must stop closing it when it unwraps SOL");
    }
    if (lp.lookupTable) {
      const t = await acct(lrpc, lp.lookupTable, fetchImpl);
      const table = t && t.owner === PROGRAM_IDS.lookupTable ? decodeLookupTable(t) : null;
      const expected = [ADDRESSES.feeRecipient, PROGRAM_IDS.dbc, ADDRESSES.dbcPoolAuthority, await dbcPdas.eventAuthority(), PROGRAM_IDS.token, PROGRAM_IDS.ata, SYSTEM, SOL, lp.programId];
      const have = table ? expected.filter((x) => table.addresses.includes(x)) : [];
      row(table && table.addresses.length ? (have.length === expected.length ? "PASS" : "WARN") : "FAIL", "LAUNCHPAD_LOOKUP_TABLE", table ? `${lp.lookupTable}: ${table.addresses.length} addresses, ${have.length} of the ${expected.length} a curve trade needs${have.length === expected.length ? " (the dev wallet, Meteora's program and authorities, the token programs, SOL, our program)" : `; missing ${expected.filter((x) => !have.includes(x)).map(short).join(", ")} (trades are built without those: larger)`}` : "not an address lookup table (trades would be built without it: larger, maybe too large)");
    } else row("WARN", "LAUNCHPAD_LOOKUP_TABLE", "unset: trades are built without a lookup table (legacy size; fine while they fit in 1232 bytes)");
  } catch (e) { row("FAIL", "launchpad RPC answers", `unreachable: ${errText(e)}`); }
}

export function print(rows) {
  for (const r of rows) console.log(`${r.level.padEnd(4)}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const fails = rows.filter((r) => r.level === "FAIL").length, warns = rows.filter((r) => r.level === "WARN").length;
  console.log(`\n${rows.length} rows: ${rows.length - fails - warns} pass, ${warns} warn, ${fails} fail${fails ? " — NOT READY" : warns ? " — ready with warnings" : " — READY"}`);
  return fails;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2), a = parseArgs(argv);
  const env = settingsFrom({ wranglerPath: new URL("../wrangler.jsonc", import.meta.url), argv });
  console.log(`mainnet preflight (read-only) — LAUNCHPAD_CLUSTER=${launchpadCluster(env).cluster}, SWAP=${env.SWAP ?? ""}, LAUNCHPAD_TRADING=${env.LAUNCHPAD_TRADING ?? ""}${a.site ? `, site ${a.site}` : ""}\n`);
  const fails = print(await preflight(env, { site: a.site, expectUpgradeAuthority: a.expectUpgradeAuthority, expectAdmin: a.expectAdmin, checkLimits: a.checkLimits }));
  process.exit(fails ? 1 : 0);
}
