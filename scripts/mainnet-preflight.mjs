// Mainnet preflight: are the settings, the live site and the chain ready for the in-app swap and the launchpad's curve trades?
//   npm run mainnet:preflight                                   (the vars of wrangler.jsonc + this shell's environment)
//   npm run mainnet:preflight -- --cluster mainnet              (force LAUNCHPAD_CLUSTER; --set KEY=VALUE repeatable; --rpc <url> = SOLANA_RPC_URL)
//   npm run mainnet:preflight -- --site https://vicinity.city   (also check the live Worker: health, switches, headers, cron, a live quote,
//                                                               /coin-meta, the brand logo, the city-coin routes)
//       --expect-upgrade-authority <squads vault> --expect-admin <admin wallet>   (both programs' keys on chain; FAIL when they differ)
//       --setup <summary.json>                                  (the City coins tab's "Send this to the team" box: every address in it is
//                                                               read from the chain and compared with the settings; a launchpad setting
//                                                               that is not set yet is taken from it for this run, and the row says so)
//       --build-record <build-record.json>                      (from solana/scripts/launchpad/build-mainnet.sh: the programs' fingerprints)
//       --expect-sha256-launchpad <hex> --expect-sha256-rewards <hex>   (the same, one by one)
//       --check-limits                                          (61 invalid quote POSTs to the site: the 61st must be 429; opt-in, it uses your own allowance)
// READ-ONLY: a few GETs and JSON-RPC reads; nothing is sent, nothing is changed, no key is printed (the Jupiter key goes out as a
// request header only, like the Worker sends it). Every row is PASS, WARN or FAIL with the reason; the exit code is 1 when any
// row FAILs. Secrets (SOLANA_RPC_URL, JUPITER_API_KEY, LAUNCHPAD_RPC_URL) live in Cloudflare: export them in the shell for this
// check or the rows say "not set here". docs/MAINNET.md lists every row and what to do about it.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { launchpadCluster, jupiterConfig, lpSetup, swapOn, DEVNET } from "../src/cluster.js";
import { ADDRESSES, PROGRAM_IDS, ata, dbc as dbcPdas, launchpad as launchpadPdas, programDataAddress } from "../src/sol/pda.js";
import { decodeConfig, decodeLaunchConfig, decodeLaunchpad, decodeLookupTable, decodeProgramData, decodeTokenAccount, PROGRAM_CONSTANTS } from "../src/sol/dbc.js";
import { checkJupiterBuild } from "../src/jupswap.js";
import { PUBLIC_LIMITS } from "../src/guards.js";
import { isOnCurve } from "../src/sol/oncurve.js";
import { base58Decode, base58Encode, isSolanaAddress } from "../src/solana.js";
import { configDiff, decodeRegistry, decodeTable } from "../src/lpadmin.js";
import { lookupTableAddresses, partnerMetadataAddress, rewards as rewardsPdas } from "../src/sol/lpadmin-ix.js";
import { checkMultisig } from "../src/sol/squads.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUBLIC_RPC = { mainnet: "https://api.mainnet-beta.solana.com", devnet: "https://api.devnet.solana.com" };
const SOL = ADDRESSES.wsol, SYSTEM = PROGRAM_IDS.system;
const SOL_THRESHOLD_MAINNET = 85_000_000_000n; // LAUNCHPAD.md: a SOL curve graduates at 85 SOL
const SLOW_RPC_MS = 1500, CRON_STALE_MS = 25 * 60_000, QUOTE_LIMIT = PUBLIC_LIMITS.swap_quote.max; // src/guards.js swap_quote per minute per connection
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…` : a);
const lamportsToSol = (n) => `${(Number(n) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;
const plainWallet = (address) => { try { return isOnCurve(base58Decode(address)); } catch { return false; } }; // an on-curve key = one person's key; a Squads vault or any PDA is off the curve
const DEVNET_REWARDS_ID = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
const PARTNER_METADATA_DISC = [68, 68, 130, 19, 16, 209, 98, 156]; // Meteora DBC PartnerMetadata
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const str = (v) => (v == null ? "" : String(v).trim());

/**
 * The command line: --set KEY=VALUE (repeatable), --cluster devnet|mainnet, --rpc <url>, --site <url>, --expect-upgrade-authority,
 * --expect-admin, --setup <file>, --build-record <file>, --expect-sha256-launchpad <hex>, --expect-sha256-rewards <hex>, --check-limits.
 */
export function parseArgs(argv = []) {
  const o = { set: {}, cluster: null, rpc: null, site: null, expectUpgradeAuthority: null, expectAdmin: null, checkLimits: false, setup: null, buildRecord: null, expectSha256Launchpad: null, expectSha256Rewards: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--set" && v) { const [k, ...rest] = argv[++i].split("="); o.set[k] = rest.join("="); }
    else if (a === "--cluster" && v) o.cluster = argv[++i];
    else if (a === "--rpc" && v) o.rpc = argv[++i];
    else if (a === "--site" && v) o.site = argv[++i].replace(/\/+$/, "");
    else if (a === "--expect-upgrade-authority" && v) o.expectUpgradeAuthority = argv[++i];
    else if (a === "--expect-admin" && v) o.expectAdmin = argv[++i];
    else if (a === "--check-limits") o.checkLimits = true;
    else if (a === "--setup" && v) o.setup = argv[++i];
    else if (a === "--build-record" && v) o.buildRecord = argv[++i];
    else if (a === "--expect-sha256-launchpad" && v) o.expectSha256Launchpad = argv[++i].toLowerCase();
    else if (a === "--expect-sha256-rewards" && v) o.expectSha256Rewards = argv[++i].toLowerCase();
  }
  return o;
}

/** The setup summary as the City coins tab shows it (PLAN C5), whether pasted bare or with the API's { ok, summary } around it. */
export function readSummary(value) {
  const s = value && typeof value === "object" && value.summary && typeof value.summary === "object" ? value.summary : value;
  if (!s || typeof s !== "object" || !["mainnet", "devnet"].includes(s.cluster) || !isSolanaAddress(s.launchpadProgram) || !isSolanaAddress(s.rewardsProgram)) return null;
  return s;
}
const SUMMARY_SETTINGS = [["LAUNCHPAD_CLUSTER", "cluster"], ["LAUNCHPAD_PROGRAM_ID", "launchpadProgram"], ["LAUNCHPAD_REWARDS_PROGRAM_ID", "rewardsProgram"], ["LAUNCHPAD_DBC_CONFIGS", "dbcConfig"], ["LAUNCHPAD_LOOKUP_TABLE", "lookupTable"]];
/**
 * The settings for this run with the summary's addresses: a launchpad setting that is set must agree with the summary (a list of
 * configs must include it); one that is not set yet is taken from the summary (exactly what the pull request after the setup sets).
 * { env, filled: [[key, value]], conflicts: [[key, here, summary]] }
 */
export function settingsWithSummary(env, summary) {
  const out = { ...env }, filled = [], conflicts = [];
  for (const [k, f] of SUMMARY_SETTINGS) {
    const want = summary[f];
    if (want == null || want === "") continue;
    const here = str(env[k]);
    if (!here) { out[k] = String(want); filled.push([k, String(want)]); continue; }
    const same = k === "LAUNCHPAD_DBC_CONFIGS" ? here.split(",").map((x) => x.trim()).includes(want) : k === "LAUNCHPAD_CLUSTER" ? here.toLowerCase() === want : here === want;
    if (!same) conflicts.push([k, here, String(want)]);
  }
  return { env: out, filled, conflicts };
}
/** Fingerprint expectations from build-mainnet.sh's build-record.json and/or the --expect-sha256-* flags: { launchpad, rewards } of { sha256, bytes, programId }. */
export function fingerprintsFrom({ buildRecord = null, launchpad = null, rewards = null } = {}) {
  const P = (buildRecord && buildRecord.programs) || {};
  const one = (rec, flag) => {
    const sha = flag || (rec && rec.sha256) || null;
    if (!sha) return null;
    return { sha256: String(sha).toLowerCase(), bytes: rec && Number.isSafeInteger(rec.bytes) ? rec.bytes : null, programId: rec && rec.programId ? rec.programId : null, source: flag ? "--expect-sha256" : "build record" };
  };
  return { launchpad: one(P.vicinity_launchpad, launchpad), rewards: one(P.vicinity_rewards, rewards) };
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
export async function preflight(env, { fetchImpl = fetch, now = Date.now(), site = null, expectUpgradeAuthority = null, expectAdmin = null, checkLimits = false, setup = null, fingerprints = null } = {}) {
  const rows = [];
  const row = (level, name, detail = "") => { rows.push({ level, name, detail }); return level; };
  // ---- the setup summary (--setup) first: a launchpad setting that is not set yet comes from it for this run, a different one FAILs
  let summary = null;
  if (setup) {
    summary = readSummary(setup);
    if (!summary) row("FAIL", "setup summary", "not the JSON of the City coins tab's \"Send this to the team\" box (it needs cluster, launchpadProgram and rewardsProgram)");
    else {
      const m = settingsWithSummary(env, summary);
      env = m.env;
      if (m.conflicts.length) row("FAIL", "setup summary vs settings", `${m.conflicts.map(([k, here, want]) => `${k} is ${here} here but the summary says ${want}`).join("; ")}: the settings and the website's setup disagree; find out which one is right before anything is switched on`);
      else if (m.filled.length) row("WARN", "setup summary vs settings", `not set here yet, so this run takes them from the summary: ${m.filled.map(([k, v]) => `${k}=${v}`).join(", ")} (the pull request after the setup sets exactly these)`);
      else row("PASS", "setup summary vs settings", "every launchpad setting here equals the summary");
    }
  }
  const lp = launchpadCluster(env), jc = jupiterConfig(env), lps = lpSetup(env);
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
  if (site) await siteRows(site, { row, env, mint, swap, trading, fetchImpl, now, checkLimits, lp, lps });

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
    const when = k === "LAUNCHPAD_PROGRAM_ID" ? "the first settings change sets it to the owner's launchpad address (docs/OWNER-LAUNCH-GUIDE.md step 3)" : "the second settings change sets it to the price curve of the City coins tab's step 3 (run with --setup <summary.json> to check before that)";
    row(missing ? "FAIL" : "PASS", k, missing ? `not set: ${mainnetLp ? `REQUIRED on mainnet (there is no default): ${when}` : "the devnet default is missing?!"}` : k === "LAUNCHPAD_PROGRAM_ID" ? lp.programId : lp.dbcConfigs.join(", "));
  }
  // the city-coin launch (the admin City coins tab, /api/lp/*, /coin-meta): its own program setting and its explicit-settings gate
  const rewardsId = str(env.LAUNCHPAD_REWARDS_PROGRAM_ID);
  const rewardsProblem = !rewardsId ? null : !isSolanaAddress(rewardsId) ? "not an address" : rewardsId === lp.programId ? "the same address as the launchpad program" : mainnetLp && rewardsId === DEVNET_REWARDS_ID ? "the DEVNET rewards program" : null;
  if (rewardsId && !rewardsProblem) row("PASS", "LAUNCHPAD_REWARDS_PROGRAM_ID", rewardsId);
  else row(mainnetLp || rewardsProblem ? "FAIL" : "WARN", "LAUNCHPAD_REWARDS_PROGRAM_ID", rewardsProblem ? `${rewardsId} is ${rewardsProblem}` : mainnetLp ? "not set: REQUIRED on mainnet (the City coins tab, approvals, launches and /coin-meta stay off without it; there is no default)" : "not set: the City coins tab and /api/lp/* stay off (curve trades do not need it)");
  row(lps.on ? "PASS" : "WARN", "city coins gate", lps.on ? `on (${lps.cluster}): the owner's City coins tab, /api/lp/* and /coin-meta answer${lps.configsSet ? "" : "; approving, launching and graduating wait for LAUNCHPAD_DBC_CONFIGS"}` : `off: ${lps.missing.join(", ")} not set explicitly (the devnet defaults never count), so the City coins tab, /api/lp/* and /coin-meta stay dark`);
  const goodRewardsId = rewardsId && !rewardsProblem ? rewardsId : null;
  // the chain rows run as soon as the program id is set (right after the deploy the programs, their fingerprints and keys can be
  // checked; the configs come later)
  if (lp.programId) await launchpadRows(lp, { row, env, fetchImpl, mainnetLp, expectUpgradeAuthority, expectAdmin, rewardsId: goodRewardsId, summary, fingerprints: fingerprints || {}, mint });
  else if (expectUpgradeAuthority || expectAdmin || summary) row("FAIL", "launchpad keys", "an expected upgrade authority / admin or a setup summary was given but the program id is not set: nothing to compare");
  // ---- the dev wallet ----
  const admins = String(env.ADMIN_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
  row(admins.includes(ADDRESSES.feeRecipient) ? "PASS" : "WARN", "dev wallet", `${ADDRESSES.feeRecipient} is the fee recipient compiled into the program${admins.includes(ADDRESSES.feeRecipient) ? " and an admin wallet" : "; it is NOT in ADMIN_WALLETS"}`);
  rows.at = new Date(now).toISOString();
  return rows;
}

/** The live Worker: health, the switches it reports, the swap config, the security headers, the cron, one live quote, the attempt limit (opt-in). */
async function siteRows(site, { row, env, mint, swap, trading, fetchImpl, now, checkLimits, lp, lps }) {
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
  await cityCoinSiteRows(site, { row, fetchImpl, lp, lps });
}

/**
 * The live Worker's city-coin pieces: /coin-meta/<mint>.json (the URI every coin carries for ever), the logo it points to, and the
 * launch routes behind the gate. Needed before the first approval: FAIL while the gate is on here, WARN while it is off.
 */
async function cityCoinSiteRows(site, { row, fetchImpl, lp, lps }) {
  const need = lps.on ? "FAIL" : "WARN";
  const unknownMint = base58Encode(randomBytes(32)); // a coin that does not exist: the route must answer, in JSON, that it does not
  try {
    const res = await fetchImpl(`${site}/coin-meta/${unknownMint}.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
    const type = res.headers.get("content-type") || "", cors = res.headers.get("access-control-allow-origin") || "";
    let body = null; try { body = await res.json(); } catch { body = null; }
    const ok = res.status === 404 && /application\/json/.test(type) && cors === "*" && body && body.ok === false;
    row(ok ? "PASS" : need, "site /coin-meta", ok ? "an unknown coin answers 404 in JSON with Access-Control-Allow-Origin * (the Worker serves the route every coin's metadata points to)" : `an unknown coin answered HTTP ${res.status} ${type || "(no type)"}${cors ? "" : ", no CORS header"}: the Worker does not serve /coin-meta yet, so a coin approved now would point wallets and explorers at a dead address for ever`);
  } catch (e) { row(need, "site /coin-meta", `unreachable: ${errText(e)}`); }
  try {
    const res = await fetchImpl(`${site}/brand/vicinity-512.png`, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
    const type = res.headers.get("content-type") || "";
    const ok = res.status === 200 && /^image\/png/.test(type);
    row(ok ? "PASS" : need, "site /brand/vicinity-512.png", ok ? "200 image/png (the logo a coin without its own shows, and Meteora's partner logo)" : `HTTP ${res.status} ${type || "(no type)"}: the logo every coin's metadata and Meteora's partner name point to is missing`);
  } catch (e) { row(need, "site /brand/vicinity-512.png", `unreachable: ${errText(e)}`); }
  try {
    const { res, body } = await getJson(fetchImpl, `${site}/api/lp/launch/status`);
    if (res.status === 404) {
      row(lps.on ? "FAIL" : "PASS", "site city-coin routes", lps.on ? "the site answers 404 not_enabled: the settings checked here switch the city coins on, the live site does not (the pull request is not deployed, or the dashboard variables differ)" : "off on the site (404 not_enabled), as the settings here say");
    } else if (res.status === 200 && body && body.on === true) {
      const city = await fetchImpl(`${site}/api/lp/launch/status?city=1`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
      const clusterOk = body.cluster === (lps.cluster || lp.cluster);
      const problems = [...(clusterOk ? [] : [`the site runs them on ${body.cluster}, the settings here on ${lps.cluster || lp.cluster}`]), ...(city.status === 401 ? [] : [`a signed-out launch status answered HTTP ${city.status}, not 401`])];
      const differs = lps.on && Boolean(body.configsSet) !== lps.configsSet ? ` — the price curve is ${body.configsSet ? "" : "not "}set on the site but ${lps.configsSet ? "" : "not "}here` : "";
      row(problems.length ? "FAIL" : lps.on ? (differs ? "WARN" : "PASS") : "WARN", "site city-coin routes", problems.length ? problems.join("; ") : `on (${body.cluster}; price curve ${body.configsSet ? "set" : "not set yet"}, speed table ${body.speedTable ? "set" : "not set"}); a signed-out launch status answers 401${lps.on ? differs : " — on at the site but off in the settings checked here"}`);
    } else row("FAIL", "site city-coin routes", `/api/lp/launch/status answered HTTP ${res.status}: neither the probe nor not_enabled`);
  } catch (e) { row(need, "site city-coin routes", `unreachable: ${errText(e)}`); }
}

/**
 * An upgrade authority row: immutable PASS; = the expectation PASS (on mainnet only when it is not one person's key); a different key
 * FAIL; no expectation: FAIL on mainnet (the row passes only by naming the multisig and matching it), WARN on devnet.
 */
function authorityRow(row, name, data, { expected, mainnetLp, from = null }) {
  if (!data) return row("FAIL", name, "the program's ProgramData account could not be read or decoded");
  const a = data.upgradeAuthority;
  if (a == null) return row("PASS", name, `none: the program is immutable (no upgrade can ever happen; last deploy slot ${data.slot})`);
  if (expected) {
    if (a !== expected) return row("FAIL", name, `${a} is NOT the expected ${expected}${from ? ` (${from})` : ""}: whoever holds that key can replace the program`);
    if (mainnetLp && plainWallet(a)) return row("FAIL", name, `${a} = the expected key, but it is a single wallet key: one person can replace the program. The City coins tab's step 2 hands it to the Squads vault`);
    return row("PASS", name, `${a} = the expected multisig${from ? ` (${from})` : ""} (last deploy slot ${data.slot})`);
  }
  if (mainnetLp) return row("FAIL", name, `${a} ${plainWallet(a) ? "is a single wallet key: one person can replace the program. Hand it to the Squads multisig (the City coins tab's step 2)" : "is not a plain wallet (a multisig vault or a program address), but nobody said whose"}; on mainnet this row needs --expect-upgrade-authority <squads vault> (or a --setup summary whose Squads multisig checks out) and passes only when it matches`);
  if (plainWallet(a)) return row("WARN", name, `${a} is a single wallet key (the devnet deployer; mainnet needs the Squads multisig)`);
  return row("WARN", name, `${a} is not a plain wallet (a multisig vault or a program address): confirm it is yours with --expect-upgrade-authority`);
}
/** An admin row (the launchpad's or the rewards registry's): = --expect-admin PASS, a plain wallet included (decided: the owner's Phantom). */
function adminRow(row, name, admin, { expected, mainnetLp, power }) {
  if (expected) {
    if (admin !== expected) return row("FAIL", name, `${admin} is NOT the expected ${expected}: that key ${power}`);
    return row("PASS", name, plainWallet(admin) ? `${admin} = --expect-admin (one wallet, as planned: the owner signs on the website with it; it can move to the Squads vault later with propose_admin / accept_admin)` : `${admin} = the expected multisig`);
  }
  if (mainnetLp) return row("FAIL", name, `${admin} ${plainWallet(admin) ? "is a single wallet key" : "is not a plain wallet"}, but nobody said whose: that key ${power}; on mainnet this row needs --expect-admin <address> and passes only when it matches`);
  if (plainWallet(admin)) return row("WARN", name, `${admin} is a single wallet key (the devnet deployer; mainnet needs the Squads multisig)`);
  return row("WARN", name, `${admin} is not a plain wallet: confirm it is your multisig with --expect-admin`);
}
/**
 * The program's fingerprint: the SHA-256 of ProgramData from byte 45 (what `solana program dump` writes). With a known build size
 * and zero padding after it (a program deployed with room to grow), the build's bytes are hashed. Read only when there is something
 * to compare, or on mainnet (about 0.5 MB per program).
 */
async function fingerprintRow(row, name, { lrpc, programId, expect, mainnetLp, fetchImpl }) {
  if (!expect && !mainnetLp) return;
  const pd = await acct(lrpc, await programDataAddress(programId), fetchImpl);
  const bytes = pd && Array.isArray(pd.data) ? Buffer.from(pd.data[0], "base64") : null;
  if (!bytes || bytes.length < 45) return row("FAIL", name, "the program's ProgramData account could not be read");
  let body = bytes.subarray(45), note = "";
  if (expect && expect.bytes && body.length > expect.bytes && body.subarray(expect.bytes).every((x) => x === 0)) { note = ` (the first ${expect.bytes} of ${body.length} bytes; the rest is zero padding)`; body = body.subarray(0, expect.bytes); }
  const sha = sha256Hex(body);
  if (!expect) return row("WARN", name, `${body.length} bytes, SHA-256 ${sha}: not compared (pass --build-record <build-record.json> from build-mainnet.sh, or --expect-sha256-…)`);
  if (expect.programId && expect.programId !== programId) return row("FAIL", name, `the build record is for ${expect.programId}, not ${programId}`);
  return row(sha === expect.sha256 ? "PASS" : "FAIL", name, sha === expect.sha256 ? `${body.length} bytes, SHA-256 ${sha} = the ${expect.source}${note}` : `SHA-256 ${sha} (${body.length} bytes) is NOT the ${expect.source}'s ${expect.sha256}${expect.bytes ? ` (${expect.bytes} bytes)` : ""}: the program on chain is not the build that was checked`);
}

/**
 * The launchpad cluster's chain: the Squads vault of the setup summary, both programs (deployed, upgrade authority, fingerprint), DBC,
 * the global account, the rewards registry, each config + allow-list entry + referral account, the lookup table, and with a setup
 * summary every address in it.
 */
async function launchpadRows(lp, { row, env, fetchImpl, mainnetLp, expectUpgradeAuthority, expectAdmin, rewardsId, summary, fingerprints, mint }) {
  const lrpc = lp.rpc;
  try {
    const genesis = await rpc(lrpc, "getGenesisHash", [], fetchImpl);
    const want = mainnetLp ? MAINNET_GENESIS : DEVNET_GENESIS;
    row(genesis === want ? "PASS" : "FAIL", "launchpad RPC cluster", genesis === want ? `${new URL(lrpc).host} is ${lp.cluster}` : `${new URL(lrpc).host} is not ${lp.cluster}`);
    try {
      const health = await rpc(lrpc, "getHealth", [], fetchImpl);
      const t0 = Date.now();
      await rpc(lrpc, "getMultipleAccounts", [lp.dbcConfigs.length ? lp.dbcConfigs : [lp.programId], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], fetchImpl);
      const ms = Date.now() - t0;
      row(health === "ok" && ms <= SLOW_RPC_MS ? "PASS" : "WARN", "launchpad RPC health", `getHealth ${health}, ${lp.dbcConfigs.length ? "the configs" : "the program"} in ${ms} ms${ms > SLOW_RPC_MS ? " (slow: every curve quote reads the pool)" : ""}`);
    } catch (e) { row("WARN", "launchpad RPC health", `getHealth / getMultipleAccounts failed: ${errText(e)}`); }

    // the setup summary's Squads multisig: decoded from the chain; its vault is the expected upgrade authority unless one was named
    let expectUA = expectUpgradeAuthority, uaFrom = null;
    if (summary) {
      const ms = summary.squadsMultisig, vault = summary.squadsVault;
      let verified = null;
      if (!isSolanaAddress(ms)) row("FAIL", "setup Squads multisig", "missing: step 2 (hand the programs to your Squads) is not recorded in the summary");
      else {
        const c = await checkMultisig(ms, await acct(lrpc, ms, fetchImpl));
        if (!c.ok) row("FAIL", "setup Squads multisig", `${ms}: ${c.message}`);
        else if (c.vault !== vault) row("FAIL", "setup Squads multisig", `${ms} is a ${c.threshold}-of-${c.members.length} Squads multisig whose vault is ${c.vault}, but the summary names ${vault ? `the vault ${vault}` : "no vault"}`);
        else { verified = c.vault; row("PASS", "setup Squads multisig", `${ms}: ${c.says}${c.timeLock ? ` (time lock ${c.timeLock} s)` : ""}`); }
      }
      if (verified && expectUpgradeAuthority && expectUpgradeAuthority !== verified) row("FAIL", "setup Squads vault", `--expect-upgrade-authority ${expectUpgradeAuthority} is not the vault of the summary's multisig (${verified})`);
      if (!expectUA && verified) { expectUA = verified; uaFrom = "the vault of the summary's Squads multisig"; }
    }

    const prog = await acct(lrpc, lp.programId, fetchImpl);
    row(prog && prog.executable && prog.owner === PROGRAM_IDS.upgradeableLoader ? "PASS" : "FAIL", "launchpad program", prog && prog.executable ? `${lp.programId} (owner ${prog.owner})` : `${lp.programId} is not a deployed program on ${lp.cluster}`);
    if (prog && prog.executable) {
      // the first 45 bytes of ProgramData: state, last deploy slot, Option<upgrade authority>
      const pd = await acct(lrpc, await programDataAddress(lp.programId), fetchImpl, "base64", { dataSlice: { offset: 0, length: 45 } });
      authorityRow(row, "upgrade authority", pd ? decodeProgramData(pd) : null, { expected: expectUA, mainnetLp, from: uaFrom });
      await fingerprintRow(row, "launchpad program fingerprint", { lrpc, programId: lp.programId, expect: fingerprints.launchpad, mainnetLp, fetchImpl });
    }
    const dbc = await acct(lrpc, PROGRAM_IDS.dbc, fetchImpl, "base64", { dataSlice: { offset: 0, length: 0 } });
    row(dbc && dbc.executable ? "PASS" : "FAIL", "Meteora DBC program", dbc && dbc.executable ? PROGRAM_IDS.dbc : "not an executable account on this cluster");
    const P = launchpadPdas(lp.programId);
    const g = await acct(lrpc, await P.launchpad(), fetchImpl);
    const global = g ? decodeLaunchpad(g, lp.programId) : null;
    row(global ? (global.launchesPaused ? "WARN" : "PASS") : "FAIL", "launchpad global account", global ? `admin ${global.admin}, launches ${global.launchesPaused ? "PAUSED" : "open"}, payouts ${global.payoutsPaused ? "PAUSED" : "open"}, rewards program ${global.rewardsProgram}` : "not initialised: the City coins tab's step 1 starts it (only while the upgrade authority is the owner's wallet)");
    if (global) {
      adminRow(row, "launchpad admin", global.admin, { expected: expectAdmin, mainnetLp, power: "approves launches, pauses and payouts" });
      const rp = global.rewardsProgram;
      if (!rp || rp === SYSTEM) row("FAIL", "rewards program", "unset: the global account names no rewards program");
      else if (rewardsId && rp !== rewardsId) row("FAIL", "rewards program", `${rp} is the rewards program the launchpad was started with, but LAUNCHPAD_REWARDS_PROGRAM_ID is ${rewardsId}: the site would set up holder rewards in a program the launchpad does not pay`);
      else row("PASS", "rewards program", `${rp} (vicinity_rewards: holder rewards per city)${rewardsId ? " = LAUNCHPAD_REWARDS_PROGRAM_ID" : ""}`);
    }

    // ---- the rewards program: deployed, its upgrade authority and fingerprint, its registry and the registry's admin
    const rid = rewardsId || (global && global.rewardsProgram && global.rewardsProgram !== SYSTEM ? global.rewardsProgram : null);
    let registry = null;
    if (rid) {
      const rprog = await acct(lrpc, rid, fetchImpl, "base64", { dataSlice: { offset: 0, length: 0 } });
      const deployed = Boolean(rprog && rprog.executable && rprog.owner === PROGRAM_IDS.upgradeableLoader);
      row(deployed ? "PASS" : "FAIL", "rewards program deployed", deployed ? `${rid} (owner ${rprog.owner})` : `${rid} is not a deployed program on ${lp.cluster}`);
      if (deployed) {
        const pd = await acct(lrpc, await programDataAddress(rid), fetchImpl, "base64", { dataSlice: { offset: 0, length: 45 } });
        authorityRow(row, "rewards upgrade authority", pd ? decodeProgramData(pd) : null, { expected: expectUA, mainnetLp, from: uaFrom });
        await fingerprintRow(row, "rewards program fingerprint", { lrpc, programId: rid, expect: fingerprints.rewards, mainnetLp, fetchImpl });
      }
      const reg = await acct(lrpc, await rewardsPdas(rid).registry(), fetchImpl);
      registry = reg ? decodeRegistry(reg, rid) : null;
      row(registry ? "PASS" : "FAIL", "rewards registry", registry ? `admin ${registry.admin}${registry.pendingAdmin !== SYSTEM ? `, pending admin ${registry.pendingAdmin}` : ""}` : "not initialised: the City coins tab's step 1 starts it (only while the upgrade authority is the owner's wallet)");
      if (registry) adminRow(row, "registry admin", registry.admin, { expected: expectAdmin, mainnetLp, power: "sets up each city's holder rewards (init_city)" });
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
      row(entry && entry.enabled && entry.dbcConfig === c ? "PASS" : "FAIL", `allow-list entry ${short(c)}`, entry ? `${entry.enabled ? "enabled" : "DISABLED"}, quote ${entry.quoteMint === SOL ? "SOL" : entry.quoteMint}, fee numerator ${entry.tradeFeeNumerator}, pool creation fee ${lamportsToSol(entry.poolCreationFee)}` : "no LaunchConfig record under our program for this config: the City coins tab's step 4 allows it");
      // the dev wallet's referral account for the quote mint: Meteora refuses a trade whose referral account is missing, so every trade recreates it (the trader pays 0.002 SOL)
      const ref = await acct(lrpc, await ata(ADDRESSES.feeRecipient, cfg.quoteMint), fetchImpl);
      const tok = ref ? decodeTokenAccount(ref) : null;
      row(tok && tok.owner === ADDRESSES.feeRecipient && tok.mint === cfg.quoteMint ? "PASS" : "WARN", `referral account ${quote === "SOL" ? "SOL" : short(quote)}`, tok ? `exists (${tok.amount} raw units waiting for the dev wallet)` : "missing: the next trade of each curve recreates it and THAT TRADER pays about 0.002 SOL of rent that is not returned (the quote says so); the City coins tab's step 5 creates it, and claim-platform-fees must stop closing it when it unwraps SOL");
    }
    let tableAcc = null;
    if (lp.lookupTable) {
      tableAcc = await acct(lrpc, lp.lookupTable, fetchImpl);
      const table = tableAcc && tableAcc.owner === PROGRAM_IDS.lookupTable ? decodeLookupTable(tableAcc) : null;
      const expected = [ADDRESSES.feeRecipient, PROGRAM_IDS.dbc, ADDRESSES.dbcPoolAuthority, await dbcPdas.eventAuthority(), PROGRAM_IDS.token, PROGRAM_IDS.ata, SYSTEM, SOL, lp.programId];
      const have = table ? expected.filter((x) => table.addresses.includes(x)) : [];
      row(table && table.addresses.length ? (have.length === expected.length ? "PASS" : "WARN") : "FAIL", "LAUNCHPAD_LOOKUP_TABLE", table ? `${lp.lookupTable}: ${table.addresses.length} addresses, ${have.length} of the ${expected.length} a curve trade needs${have.length === expected.length ? " (the dev wallet, Meteora's program and authorities, the token programs, SOL, our program)" : `; missing ${expected.filter((x) => !have.includes(x)).map(short).join(", ")} (trades are built without those: larger)`}` : "not an address lookup table (trades would be built without it: larger, maybe too large)");
      // the addresses the website's launch, graduation and fee transactions share (the City coins tab's step 6 writes exactly these)
      const t = table ? decodeTable(tableAcc) : null;
      if (t) {
        const all = (await lookupTableAddresses({ programId: lp.programId, rewardsProgramId: rid || SYSTEM, dbcConfigs: lp.dbcConfigs }));
        const lack = all.filter((x) => !t.addresses.includes(x));
        row(t.deactivated ? "FAIL" : lack.length ? "WARN" : "PASS", "speed table for city coins", t.deactivated ? `${lp.lookupTable} is being switched off (deactivated): every transaction that uses it will fail; make a new one (the City coins tab's step 6)` : lack.length ? `${lack.length} of the ${all.length} shared addresses missing (${lack.map(short).join(", ")}): a launch with a first buy may not fit in one transaction (the City coins tab's step 6 adds them)` : `holds all ${all.length} addresses the launch, graduation and fee transactions share; authority ${t.authority || "none (frozen)"}`);
      }
    } else row("WARN", "LAUNCHPAD_LOOKUP_TABLE", "unset: trades are built without a lookup table (legacy size; fine while they fit in 1232 bytes)");

    if (summary) await setupRows(summary, { row, lp, lrpc, fetchImpl, mainnetLp, global, registry, expectAdmin, tableAcc, mint, P });
  } catch (e) { row("FAIL", "launchpad RPC answers", `unreachable: ${errText(e)}`); }
}

/** Every address of the setup summary, read from the chain (the program, settings and Squads rows above cover the rest). */
async function setupRows(summary, { row, lp, lrpc, fetchImpl, mainnetLp, global, registry, expectAdmin, tableAcc, mint, P }) {
  // the price curve: exactly the account Meteora writes for Vicinity's defaults (src/sol/dbc-config-data.js), and in the settings
  const cfgAddr = summary.dbcConfig;
  if (!isSolanaAddress(cfgAddr)) row("FAIL", "setup price curve", "missing: step 3 (create the Meteora price curve) is not in the summary");
  else {
    const acc = await acct(lrpc, cfgAddr, fetchImpl);
    const diff = acc ? configDiff(acc) : ["not on chain"];
    const inSettings = lp.dbcConfigs.includes(cfgAddr);
    if (!acc || acc.owner !== PROGRAM_IDS.dbc) row("FAIL", "setup price curve", `${cfgAddr} is not a Meteora DBC config on ${lp.cluster}`);
    else if (!inSettings) row("FAIL", "setup price curve", `${cfgAddr} is not in LAUNCHPAD_DBC_CONFIGS`);
    else if (diff.length) row(mainnetLp ? "FAIL" : "WARN", "setup price curve", `${cfgAddr} differs from Vicinity's mainnet defaults in: ${diff.join(", ")}${mainnetLp ? " (the City coins tab only creates the defaults: find out where this one came from)" : " (a devnet curve)"}`);
    else row("PASS", "setup price curve", `${cfgAddr} is byte for byte the config Meteora writes for Vicinity's defaults (85 SOL target, 1.25% fee, 0.05 SOL launch fee, fees and leftovers to the dev wallet)`);
    // its allow-list entry
    const lcAddr = await P.launchConfig(cfgAddr);
    if (summary.launchConfig !== lcAddr) row("FAIL", "setup allow-list entry", `the summary names ${summary.launchConfig || "nothing"}, but the allow-list entry of ${short(cfgAddr)} is ${lcAddr}`);
    else {
      const e = decodeLaunchConfig(await acct(lrpc, lcAddr, fetchImpl), lp.programId);
      row(e && e.enabled && e.dbcConfig === cfgAddr ? "PASS" : "FAIL", "setup allow-list entry", e ? `${lcAddr}: ${e.enabled ? "enabled" : "DISABLED"} for ${short(cfgAddr)}` : `${lcAddr} is not on chain under the launchpad program`);
    }
    // the speed table holds the curve and its allow-list entry
    const t = tableAcc ? decodeTable(tableAcc) : null;
    if (!isSolanaAddress(summary.lookupTable) || summary.lookupTable !== lp.lookupTable) row("FAIL", "setup speed table", `the summary names ${summary.lookupTable || "no table"}, LAUNCHPAD_LOOKUP_TABLE is ${lp.lookupTable || "unset"}`);
    else if (!t) row("FAIL", "setup speed table", `${summary.lookupTable} is not an address lookup table on ${lp.cluster}`);
    else {
      const lack = [cfgAddr, lcAddr].filter((x) => !t.addresses.includes(x));
      row(!t.deactivated && !lack.length ? "PASS" : "FAIL", "setup speed table", t.deactivated ? `${summary.lookupTable} is deactivated` : lack.length ? `${summary.lookupTable} misses ${lack.map(short).join(" and ")} (the price curve${lack.length > 1 ? " and its allow-list entry" : " or its allow-list entry"})` : `${summary.lookupTable} holds the price curve and its allow-list entry (${t.addresses.length} addresses; authority ${t.authority || "none (frozen)"})`);
    }
  }
  // the admins the summary names are the admins on chain (and the one the team expects)
  const adminProblems = [];
  if (!global) adminProblems.push("the launchpad is not started");
  else if (summary.admin !== global.admin) adminProblems.push(`the summary names ${summary.admin || "no admin"} but the launchpad admin is ${global.admin}`);
  if (summary.registryAdmin !== undefined && registry && summary.registryAdmin !== registry.admin) adminProblems.push(`the summary names the registry admin ${summary.registryAdmin} but it is ${registry.admin}`);
  if (expectAdmin && summary.admin && summary.admin !== expectAdmin) adminProblems.push(`it is not --expect-admin ${expectAdmin}`);
  row(adminProblems.length ? "FAIL" : "PASS", "setup admin", adminProblems.length ? adminProblems.join("; ") : `${summary.admin} is the launchpad admin${registry ? " and the rewards registry admin" : ""} on chain`);
  // the dev wallet's fee (referral) accounts: SOL, and $VICINITY under its own token program
  const wsolWant = await ata(ADDRESSES.feeRecipient, SOL);
  const ra = summary.referralAccounts || {};
  const feeRows = [];
  let feeLevel = "PASS";
  const check = async (label, said, wantAddr) => {
    if (said !== wantAddr) { feeLevel = "FAIL"; feeRows.push(`${label}: the summary names ${said || "nothing"}, the dev wallet's account is ${wantAddr}`); return; }
    const a = await acct(lrpc, wantAddr, fetchImpl, "base64", { dataSlice: { offset: 0, length: 0 } });
    if (!a) { if (feeLevel === "PASS") feeLevel = "WARN"; feeRows.push(`${label} ${wantAddr} is not on chain`); } else feeRows.push(`${label} ${wantAddr}`);
  };
  await check("SOL", ra.wsol, wsolWant);
  if (lp.cluster === "mainnet" && isSolanaAddress(mint)) {
    const m = await acct(lrpc, mint, fetchImpl, "base64", { dataSlice: { offset: 0, length: 0 } });
    const tp = m && (m.owner === PROGRAM_IDS.token2022 || m.owner === PROGRAM_IDS.token) ? m.owner : null;
    if (!tp) { feeLevel = "FAIL"; feeRows.push(`$VICINITY ${mint} is not a token mint here`); } else await check("$VICINITY", ra.vicinity, await ata(ADDRESSES.feeRecipient, mint, tp));
  }
  row(feeLevel, "setup fee accounts", feeRows.join("; "));
  // Meteora's partner name for the dev wallet (step 7, dev wallet only): a WARN, never a blocker
  const pm = await partnerMetadataAddress(ADDRESSES.feeRecipient);
  if (summary.partnerMetadata && summary.partnerMetadata !== pm) row("FAIL", "setup partner metadata", `the summary names ${summary.partnerMetadata}, the dev wallet's partner record is ${pm}`);
  else {
    const a = await acct(lrpc, pm, fetchImpl);
    const b = a && Array.isArray(a.data) ? Buffer.from(a.data[0], "base64") : null;
    const ok = Boolean(a && a.owner === PROGRAM_IDS.dbc && b && PARTNER_METADATA_DISC.every((x, i) => b[i] === x));
    row(ok ? "PASS" : "WARN", "setup partner metadata", ok ? `${pm}: Meteora names the dev wallet's configs "Vicinity"` : `${pm} is not on chain yet: Meteora and Jupiter show no "Vicinity" name for the price curve until the dev wallet signs the City coins tab's step 7 (not a blocker)`);
  }
  // the setup transactions themselves
  const sg = summary.signatures || {};
  const sigs = [sg.init, sg.handoff, sg.config, sg.allow, sg.referral, sg.lookupCreate, ...(Array.isArray(sg.lookupExtend) ? sg.lookupExtend : []), sg.partner].filter((x) => typeof x === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(x));
  if (!sigs.length) row("WARN", "setup signatures", "the summary lists no transaction");
  else {
    const st = await rpc(lrpc, "getSignatureStatuses", [sigs, { searchTransactionHistory: true }], fetchImpl);
    const v = (st && st.value) || [];
    const failed = sigs.filter((_, i) => v[i] && v[i].err), unknown = sigs.filter((_, i) => !v[i]);
    row(failed.length ? "FAIL" : unknown.length ? "WARN" : "PASS", "setup signatures", failed.length ? `${failed.length} of the ${sigs.length} setup transactions FAILED on chain: ${failed.map(short).join(", ")}` : unknown.length ? `${sigs.length - unknown.length} of ${sigs.length} found; ${unknown.map(short).join(", ")} not found by this RPC (its history may be short; the accounts above are what count)` : (sigs.length === 1 ? "the setup transaction landed and succeeded" : `all ${sigs.length} setup transactions landed and succeeded`));
  }
}

export function print(rows) {
  for (const r of rows) console.log(`${r.level.padEnd(4)}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const fails = rows.filter((r) => r.level === "FAIL").length, warns = rows.filter((r) => r.level === "WARN").length;
  console.log(`\n${rows.length} rows: ${rows.length - fails - warns} pass, ${warns} warn, ${fails} fail${fails ? " — NOT READY" : warns ? " — ready with warnings" : " — READY"}`);
  return fails;
}

/** A JSON file named on the command line (the setup summary, the build record), or a plain-word exit. */
function readJsonFile(path, what) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`${what} ${path} could not be read as JSON: ${e.message}`); process.exit(2); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2), a = parseArgs(argv);
  const env = settingsFrom({ wranglerPath: new URL("../wrangler.jsonc", import.meta.url), argv });
  const setup = a.setup ? readJsonFile(a.setup, "--setup") : null;
  const fingerprints = fingerprintsFrom({ buildRecord: a.buildRecord ? readJsonFile(a.buildRecord, "--build-record") : null, launchpad: a.expectSha256Launchpad, rewards: a.expectSha256Rewards });
  console.log(`mainnet preflight (read-only) — LAUNCHPAD_CLUSTER=${launchpadCluster(env).cluster}, SWAP=${env.SWAP ?? ""}, LAUNCHPAD_TRADING=${env.LAUNCHPAD_TRADING ?? ""}${a.site ? `, site ${a.site}` : ""}${a.setup ? `, setup ${a.setup}` : ""}\n`);
  const fails = print(await preflight(env, { site: a.site, expectUpgradeAuthority: a.expectUpgradeAuthority, expectAdmin: a.expectAdmin, checkLimits: a.checkLimits, setup, fingerprints }));
  process.exit(fails ? 1 : 0);
}
