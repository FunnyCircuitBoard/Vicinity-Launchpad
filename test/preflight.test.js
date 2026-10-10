// npm run mainnet:preflight (scripts/mainnet-preflight.mjs): read-only PASS / WARN / FAIL rows. Against the devnet settings
// (the recorded defaults and the devnet accounts recorded on 9 Oct 2026) every chain row passes or warns for the right reason
// (a throwaway deployer holds the devnet keys); against mainnet settings without a program id and configs the program rows FAIL
// cleanly and the rest still runs; the expected multisig keys are compared when given; a live site's rows are read from a fake
// site; nothing is ever sent (every request is a GET or a JSON-RPC read, and the limit check posts invalid bodies only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, preflight, settingsFrom } from "../scripts/mainnet-preflight.mjs";
import { programDataAddress } from "../src/sol/pda.js";
import { base58Decode } from "../src/solana.js";
import { fakeWorld, REAL_VIC, SOL } from "./helpers/jupfake.js";
import { PROGRAM_IDS, ADDRESSES } from "../src/sol/pda.js";
import { PUBLIC_LIMITS } from "../src/guards.js";

const dev = JSON.parse(readFileSync(new URL("./fixtures/launchpad-worker/devnet-accounts.json", import.meta.url), "utf8"));
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEPLOYER = "9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa"; // the devnet throwaway deployer: upgrade authority and admin on devnet
const EXEC = (owner) => ({ owner, lamports: 1, data: ["", "base64"], executable: true });
const SITE = "https://site.test";

/** A fake chain + Jupiter + site: the recorded devnet accounts, executable programs, a mint, genesis and health per host, a live-looking site. */
const QUOTE_MAX = PUBLIC_LIMITS.swap_quote.max;
function world({ siteSwap = true, cronMinutesAgo = 4, limitAt = QUOTE_MAX + 1 } = {}) {
  const W = fakeWorld({ rpc: { mints: { [REAL_VIC]: { decimals: 6 } } } });
  for (const [k, a] of Object.entries(dev.accounts)) W.rpc.accounts[k] = { owner: a.owner, lamports: a.lamports, data: [a.data, "base64"], ...(a.executable ? { executable: true } : {}) };
  for (const p of [PROGRAM_IDS.jupiter, PROGRAM_IDS.dbc]) W.rpc.accounts[p] = EXEC("BPFLoaderUpgradeab1e11111111111111111111111");
  const sent = [], site = { posts: 0, paths: [] };
  const now = Date.parse("2026-10-09T12:00:00Z");
  const jsonRes = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const SEC = { "content-security-policy": "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(SITE)) {
      const path = new URL(u).pathname;
      site.paths.push(`${init.method || "GET"} ${path}`);
      if (path === "/api/health") return jsonRes({ ok: true, service: "vicinity-map", milestone: 2 }, 200, SEC);
      if (path === "/") return new Response("<!doctype html>", { status: 200, headers: SEC });
      if (path === "/api/official") return jsonRes({ tokenContract: REAL_VIC, ...(siteSwap ? { swap: true, launchpadTrading: { cluster: "devnet" } } : {}) });
      if (path === "/api/policy") return jsonRes({ launched: true, balanceHistory: { running: true, lastSample: { taken_at: new Date(now - cronMinutesAgo * 60_000).toISOString() }, samplesLast24h: 140 } });
      if (path === "/api/swap/config") return jsonRes({ ok: true, cluster: "mainnet", jupiter: { keyed: true, host: "api.jup.ag", rps: 10 }, tokens: [1, 2, 3, 4], launchpad: { enabled: true, cluster: "devnet", programId: PROGRAM_IDS.launchpadDevnet, dbcConfigs: ["a", "b"] } });
      if (path === "/api/swap/quote") {
        site.posts++;
        if (init.body === "{}") return site.posts >= limitAt ? jsonRes({ ok: false, error: "slow_down" }, 429, { "retry-after": "60" }) : jsonRes({ ok: false, error: "bad_json" }, 400);
        return jsonRes({ ok: true, source: "jupiter_quote", estimate: true, outUi: "152907.453914", route: ["Raydium Launchlab"] });
      }
      return new Response("not found", { status: 404 });
    }
    if (init.body && /sendTransaction|simulateTransaction/.test(init.body)) sent.push(u);
    if (init.body && /getGenesisHash/.test(init.body)) return jsonRes({ jsonrpc: "2.0", id: 1, result: /devnet/.test(u) ? DEVNET_GENESIS : MAINNET_GENESIS });
    if (init.body && /getHealth/.test(init.body)) return jsonRes({ jsonrpc: "2.0", id: 1, result: "ok" });
    if (init.body && /getAccountInfo/.test(init.body)) {
      const { params } = JSON.parse(init.body);
      const acc = W.rpc.accounts[params[0]];
      if (acc && acc.executable) return jsonRes({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { ...acc } } });
    }
    return W.fetch(url, init);
  };
  return { W, fetchImpl, sent, site, now };
}
const by = (rows, name) => rows.find((r) => r.name === name);
const levels = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.level]));
const DEVNET_ENV = { SWAP: "on", LAUNCHPAD_TRADING: "on", LAUNCHPAD_CLUSTER: "devnet", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test", JUPITER_API_KEY: "k".repeat(32), JUPITER_RPS: "10", ADMIN_WALLETS: ADDRESSES.feeRecipient, RPC_TIMEOUT_MS: "8000" };

test("preflight: devnet settings: every chain row passes, the devnet keys warn (a throwaway deployer), the keyed build passes the validator, nothing is sent", async () => {
  const { fetchImpl, sent, now } = world();
  const rows = await preflight(DEVNET_ENV, { fetchImpl, now });
  const L = levels(rows);
  for (const name of ["SWAP", "LAUNCHPAD_TRADING", "VICINITY_MINT", "SOLANA_RPC_URL", "RPC_TIMEOUT_MS", "JUPITER_API_KEY", "JUPITER_RPS", "SWAP_PLATFORM_FEE_BPS / SWAP_FEE_ACCOUNT",
    "Jupiter lite quote SOL → $VICINITY", "Jupiter build SOL → $VICINITY", "mainnet RPC answers", "mainnet RPC health", "$VICINITY mint on mainnet", "Jupiter program on mainnet",
    "no mainnet launchpad address in the code", "LAUNCHPAD_RPC_URL", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS", "launchpad RPC cluster", "launchpad RPC health", "launchpad program", "Meteora DBC program",
    "launchpad global account", "rewards program", "DBC config 4ZLtvU…", "DBC config 8ZcsWi…", "allow-list entry 4ZLtvU…", "allow-list entry 8ZcsWi…", "referral account SOL", "referral account HFFBwq…", "LAUNCHPAD_LOOKUP_TABLE", "dev wallet"]) {
    assert.equal(L[name], "PASS", `${name}: ${JSON.stringify(by(rows, name))}`);
  }
  // the devnet keys are a throwaway deployer's: a warning that names the key and says mainnet needs the multisig, never a FAIL on devnet
  assert.equal(L["upgrade authority"], "WARN"); assert.match(by(rows, "upgrade authority").detail, new RegExp(`^${DEPLOYER} is a single wallet key \\(the devnet deployer; mainnet needs the Squads multisig\\)`));
  assert.equal(L["launchpad admin"], "WARN"); assert.match(by(rows, "launchpad admin").detail, new RegExp(`^${DEPLOYER} is a single wallet key`));
  assert.equal(L.LAUNCHPAD_CLUSTER, "WARN"); assert.match(by(rows, "LAUNCHPAD_CLUSTER").detail, /DEVNET test coins/);
  assert.deepEqual(rows.filter((r) => r.level === "FAIL"), [], "no FAIL on the recorded devnet world");
  assert.match(by(rows, "launchpad global account").detail, /admin 9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa, launches open/);
  assert.match(by(rows, "rewards program").detail, /^Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi/);
  assert.match(by(rows, "DBC config 4ZLtvU…").detail, /quote SOL, graduates at 1000000000 raw \(1 SOL\), trade fee 125 bps, creator share 50%, pool creation fee 0\.01 SOL, fee claimer 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN \(= the dev wallet constant\)/);
  assert.match(by(rows, "DBC config 8ZcsWi…").detail, /quote HFFBwqSde8ehdE3AuoPjYZWbiaVdXJ25Su5QhhpWhBBX, graduates at 25000000000000 raw, trade fee 125 bps/);
  assert.match(by(rows, "allow-list entry 4ZLtvU…").detail, /^enabled, quote SOL, fee numerator 12500000, pool creation fee 0\.01 SOL/);
  assert.match(by(rows, "referral account SOL").detail, /^exists \(19937 raw units waiting for the dev wallet\)/);
  assert.match(by(rows, "LAUNCHPAD_LOOKUP_TABLE").detail, /^5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe: 25 addresses, 9 of the 9 a curve trade needs/);
  assert.match(by(rows, "Jupiter build SOL → $VICINITY").detail, /\(keyed\) and the Worker's validator accepts today's layout .*nothing was signed or sent/);
  assert.match(by(rows, "mainnet RPC health").detail, /^getHealth ok, two accounts in \d+ ms$/);
  assert.deepEqual(sent, [], "read-only: no sendTransaction, no simulateTransaction");
  assert.ok(!JSON.stringify(rows).includes("k".repeat(32)), "the key is never printed");
  assert.equal(rows.at, "2026-10-09T12:00:00.000Z");
});

test("preflight: the expected multisig keys: PASS when the chain agrees, FAIL naming the holder when it does not", async () => {
  const { fetchImpl, now } = world();
  const ok = await preflight(DEVNET_ENV, { fetchImpl, now, expectUpgradeAuthority: DEPLOYER, expectAdmin: DEPLOYER });
  assert.equal(by(ok, "upgrade authority").level, "PASS"); assert.match(by(ok, "upgrade authority").detail, /= the expected multisig \(last deploy slot 508501875\)/);
  assert.equal(by(ok, "launchpad admin").level, "PASS");
  const other = "GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL";
  const bad = await preflight(DEVNET_ENV, { fetchImpl, now, expectUpgradeAuthority: other, expectAdmin: other });
  assert.equal(by(bad, "upgrade authority").level, "FAIL"); assert.match(by(bad, "upgrade authority").detail, new RegExp(`^${DEPLOYER} is NOT the expected ${other}: whoever holds that key can replace the program`));
  assert.equal(by(bad, "launchpad admin").level, "FAIL"); assert.match(by(bad, "launchpad admin").detail, /approves launches, pauses and payouts/);
  // on MAINNET a plain wallet as upgrade authority or admin is a FAIL even without an expectation (the devnet world answers the mainnet genesis for any non-devnet host)
  const main = await preflight({ ...DEVNET_ENV, LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpadDevnet, LAUNCHPAD_DBC_CONFIGS: "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7", LAUNCHPAD_LOOKUP_TABLE: "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe" }, { fetchImpl, now });
  assert.equal(by(main, "upgrade authority").level, "FAIL"); assert.match(by(main, "upgrade authority").detail, /one person can replace the program\. Hand it to the Squads multisig.*needs --expect-upgrade-authority <squads vault> and passes only when it matches/);
  assert.equal(by(main, "launchpad admin").level, "FAIL"); assert.match(by(main, "launchpad admin").detail, /hand the admin role to the Squads multisig.*needs --expect-admin <squads vault> and passes only when it matches/);
  // on mainnet an upgrade authority that is NOT a plain wallet (any PDA, anyone's Squads vault) is a FAIL too when nobody named the multisig: the row cannot pass by accident
  const { fetchImpl: offCurve } = world();
  const pda = "ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw"; // the launchpad global PDA: off the curve, like a Squads vault (a program id from solana-keygen is ON the curve)
  const pdFetch = async (url, init) => {
    const r = await offCurve(url, init);
    if (init && init.body && /getAccountInfo/.test(init.body) && JSON.parse(init.body).params[0] === await programDataAddress(PROGRAM_IDS.launchpadDevnet)) {
      const d = await r.json(); const bytes = Buffer.from(d.result.value.data[0], "base64"); bytes.set(base58Decode(pda), 13); d.result.value.data[0] = bytes.toString("base64");
      return new Response(JSON.stringify(d), { headers: { "content-type": "application/json" } });
    }
    return r;
  };
  const vault = await preflight({ ...DEVNET_ENV, LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpadDevnet, LAUNCHPAD_DBC_CONFIGS: "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7" }, { fetchImpl: pdFetch, now });
  assert.equal(by(vault, "upgrade authority").level, "FAIL"); assert.match(by(vault, "upgrade authority").detail, new RegExp(`^${pda} is not a plain wallet \\(a multisig vault or a program address\\), but nobody said whose; on mainnet this row needs --expect-upgrade-authority`));
  const named = await preflight({ ...DEVNET_ENV, LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpadDevnet, LAUNCHPAD_DBC_CONFIGS: "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7" }, { fetchImpl: pdFetch, now, expectUpgradeAuthority: pda });
  assert.equal(by(named, "upgrade authority").level, "PASS", "naming the vault and matching it is the only way to pass");
  // the "no mainnet address in the code" row is computed, not a literal PASS
  const src = readFileSync(new URL("../scripts/mainnet-preflight.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /row\("PASS", "no mainnet launchpad address in the code"/);
  assert.match(src, /row\(noMainDefaults \? "PASS" : "FAIL", "no mainnet launchpad address in the code"/);
  assert.equal(by(main, "LAUNCHPAD_CLUSTER").level, "PASS");
  assert.equal(by(main, "DBC config 4ZLtvU…").level, "WARN", "a 1 SOL graduation on mainnet is not what LAUNCHPAD.md describes: a warning, an owner decision");
  assert.match(by(main, "DBC config 4ZLtvU…").detail, /graduates at 1 SOL, not the 85 SOL LAUNCHPAD.md describes/);
});

test("preflight: mainnet settings without a program id and configs FAIL those rows cleanly; the switch rows say what is off", async () => {
  const { fetchImpl, now } = world();
  const rows = await preflight({ SWAP: "on", LAUNCHPAD_TRADING: "on", LAUNCHPAD_CLUSTER: "mainnet", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test" }, { fetchImpl, now });
  const L = levels(rows);
  assert.equal(L.LAUNCHPAD_TRADING, "FAIL"); assert.match(by(rows, "LAUNCHPAD_TRADING").detail, /missing LAUNCHPAD_PROGRAM_ID, LAUNCHPAD_DBC_CONFIGS/);
  assert.equal(L.LAUNCHPAD_PROGRAM_ID, "FAIL"); assert.match(by(rows, "LAUNCHPAD_PROGRAM_ID").detail, /REQUIRED on mainnet \(there is no default\)/);
  assert.equal(L.LAUNCHPAD_DBC_CONFIGS, "FAIL");
  assert.equal(L["no mainnet launchpad address in the code"], "PASS"); assert.match(by(rows, "no mainnet launchpad address in the code").detail, /program null, configs \[\]/);
  assert.equal(by(rows, "launchpad program"), undefined, "no program row without a program id (nothing to read)");
  assert.equal(by(rows, "upgrade authority"), undefined);
  // no key here: the build row still runs (a read-only GET) so the validator check always happens, but it can only WARN: keyless builds live on Jupiter's anonymous allowance
  assert.equal(by(rows, "Jupiter build SOL → $VICINITY").level, "WARN"); assert.match(by(rows, "Jupiter build SOL → $VICINITY").detail, /KEYLESS \(Jupiter's anonymous allowance, which may stop without notice: set JUPITER_API_KEY before a launch\)/);
  assert.match(by(rows, "JUPITER_API_KEY").detail, /ANONYMOUS allowance, which may stop without notice/);
  assert.equal(L.JUPITER_API_KEY, "WARN"); assert.equal(L.JUPITER_RPS, "WARN"); assert.equal(L.LAUNCHPAD_CLUSTER, "PASS");
  assert.equal(L["$VICINITY mint on mainnet"], "PASS");
  assert.deepEqual(rows.filter((r) => r.level === "FAIL").map((r) => r.name), ["LAUNCHPAD_TRADING", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS"]);
  const withKeys = await preflight({ LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_TRADING: "on", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test" }, { fetchImpl, now, expectAdmin: "GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL" });
  assert.equal(by(withKeys, "launchpad keys").level, "FAIL", "an expectation with nothing to compare is said out loud");
  const off = await preflight({ LAUNCHPAD_CLUSTER: "mainnet", VICINITY_MINT: REAL_VIC }, { fetchImpl, now });
  const O = levels(off);
  assert.deepEqual([O.SWAP, O.LAUNCHPAD_TRADING, O.SOLANA_RPC_URL], ["WARN", "WARN", "FAIL"]);
  assert.match(by(off, "SOLANA_RPC_URL").detail, /public mainnet RPC/);
});

test("preflight: the live site's rows (--site): health, the switches, headers, the cron, the swap config, one live quote; --check-limits finds the 61st answer is 429", async () => {
  const { fetchImpl, site, sent, now } = world();
  const rows = await preflight(DEVNET_ENV, { fetchImpl, now, site: SITE, checkLimits: true });
  const L = levels(rows);
  for (const name of ["site /api/health", "site /api/official", "site security headers /", "site security headers /api/health", "site cron alive", "site /api/swap/config", "site live quote SOL → $VICINITY", "site attempt limit /api/swap/quote"]) assert.equal(L[name], "PASS", `${name}: ${JSON.stringify(by(rows, name))}`);
  assert.match(by(rows, "site /api/official").detail, /^swap on, launchpadTrading on \(devnet\), \$VICINITY 2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray$/);
  assert.match(by(rows, "site cron alive").detail, /^last balance sample 4 min ago, 140 in 24 h$/);
  assert.match(by(rows, "site live quote SOL → $VICINITY").detail, /0\.01 SOL → 152907\.453914 \$VICINITY \(jupiter_quote, an estimate: no wallet asked\) in \d+ ms via Raydium Launchlab \(read-only, nothing built\)/);
  assert.match(by(rows, "site attempt limit /api/swap/quote").detail, new RegExp(`^the first 429 came on request ${QUOTE_MAX} of ${QUOTE_MAX + 1} \\(limit ${QUOTE_MAX} per minute per connection\\)$`), `the live quote above counted as one of the ${QUOTE_MAX}`);
  assert.equal(site.posts, QUOTE_MAX + 2, `one live quote plus ${QUOTE_MAX + 1} invalid bodies`);
  assert.deepEqual(sent, []);
  // a stale cron, a site with the swap off, a limit that never answers 429
  const stale = await preflight(DEVNET_ENV, { fetchImpl: world({ cronMinutesAgo: 40 }).fetchImpl, now, site: SITE });
  assert.equal(by(stale, "site cron alive").level, "WARN"); assert.match(by(stale, "site cron alive").detail, /40 min ago.*has not sampled for a while/);
  const off = await preflight(DEVNET_ENV, { fetchImpl: world({ siteSwap: false }).fetchImpl, now, site: SITE });
  assert.equal(by(off, "site /api/official").level, "WARN"); assert.match(by(off, "site /api/official").detail, /swap off.*differs from the settings checked here/);
  assert.equal(by(off, "site /api/swap/config").level, "WARN"); assert.equal(by(off, "site live quote SOL → $VICINITY"), undefined);
  const noLimit = await preflight(DEVNET_ENV, { fetchImpl: world({ limitAt: 10_000 }).fetchImpl, now, site: SITE, checkLimits: true });
  assert.equal(by(noLimit, "site attempt limit /api/swap/quote").level, "FAIL"); assert.match(by(noLimit, "site attempt limit /api/swap/quote").detail, /no 429: the attempt counter is not working/);
});

test("preflight: settings come from wrangler.jsonc vars, then the environment, then --set / --cluster / --rpc; the other options are parsed apart", () => {
  const argv = ["--set", "SWAP=on", "--cluster", "mainnet", "--rpc", "https://rpc.example/x", "--site", "https://vicinity.city/", "--expect-upgrade-authority", "A1", "--expect-admin", "B2", "--check-limits"];
  const s = settingsFrom({ wranglerPath: new URL("../wrangler.jsonc", import.meta.url), env: { JUPITER_RPS: "10", HOME: "/x" }, argv });
  assert.equal(s.VICINITY_MINT, REAL_VIC, "the repo's mint");
  assert.deepEqual([s.JUPITER_RPS, s.SWAP, s.LAUNCHPAD_CLUSTER, s.SOLANA_RPC_URL, s.HOME], ["10", "on", "mainnet", "https://rpc.example/x", undefined]);
  assert.ok(!("SOLANA_RPC_URL" in settingsFrom({ wranglerPath: new URL("../wrangler.jsonc", import.meta.url), env: {} })), "secrets are not in the repo");
  assert.deepEqual(parseArgs(argv), { set: { SWAP: "on" }, cluster: "mainnet", rpc: "https://rpc.example/x", site: "https://vicinity.city", expectUpgradeAuthority: "A1", expectAdmin: "B2", checkLimits: true });
  void SOL;
});

test("preflight: SOLANA_RPC_URL_BACKUP (10 Oct 2026): unset WARNs; the public RPC or the same provider WARN; another mainnet provider that serves getProgramAccounts PASSes; any devnet URL FAILs; never its key", async () => {
  const { fetchImpl, now } = world();
  const KEY = "BACKUPKEY123";
  const gpa = (refuse) => async (url, init = {}) => {
    if (String(url).includes("backup-rpc.other.example") && init.body && /getProgramAccounts/.test(init.body)) {
      return new Response(JSON.stringify(refuse ? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id: 1, result: [{ pubkey: "a", account: { data: ["", "base64"] } }, { pubkey: "b", account: { data: ["", "base64"] } }] }), { headers: { "content-type": "application/json" } });
    }
    return fetchImpl(url, init);
  };
  const run = async (backup, f = gpa(false)) => by(await preflight({ ...DEVNET_ENV, SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=PRIMARYKEY", ...(backup ? { SOLANA_RPC_URL_BACKUP: backup } : {}) }, { fetchImpl: f, now }), "SOLANA_RPC_URL_BACKUP");
  let r = await run(null);
  assert.equal(r.level, "WARN"); assert.match(r.detail, /every chain read of the site fails/);
  r = await run("https://api.mainnet-beta.solana.com");
  assert.equal(r.level, "WARN"); assert.match(r.detail, /refuses getProgramAccounts/);
  r = await run(`https://other.helius-rpc.com/?api-key=${KEY}`);
  assert.equal(r.level, "WARN"); assert.match(r.detail, /same provider as SOLANA_RPC_URL \(helius-rpc\.com\)/);
  r = await run(`https://backup-rpc.other.example/v2/${KEY}`);
  assert.equal(r.level, "PASS", r.detail); assert.match(r.detail, /other\.example.*getProgramAccounts on the token program answers \(2 \$VICINITY token accounts\)/);
  r = await run(`https://backup-rpc.other.example/v2/${KEY}`, gpa(true));
  assert.equal(r.level, "FAIL"); assert.match(r.detail, /getProgramAccounts on the token program is refused/);
  r = await run(`https://backup-rpc.devnet.example/v2/${KEY}`);
  assert.equal(r.level, "FAIL"); assert.match(r.detail, /NOT mainnet/);
  r = await run("not a url");
  assert.equal(r.level, "FAIL");
  // the public DEVNET endpoint is not "the public RPC" (a WARN): it is another cluster, a FAIL; so is a devnet URL of the same provider
  r = await run("https://api.devnet.solana.com");
  assert.equal(r.level, "FAIL", r.detail); assert.match(r.detail, /NOT mainnet/);
  r = await run(`https://devnet.helius-rpc.com/?api-key=${KEY}`);
  assert.equal(r.level, "FAIL", r.detail); assert.match(r.detail, /NOT mainnet/);
  for (const b of [`https://backup-rpc.other.example/v2/${KEY}`, `https://other.helius-rpc.com/?api-key=${KEY}`]) assert.ok(!(await run(b)).detail.includes(KEY), "the key is never printed");
});
