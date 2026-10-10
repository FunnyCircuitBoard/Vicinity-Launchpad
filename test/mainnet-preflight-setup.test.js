// npm run mainnet:preflight -- --setup <summary.json> (scripts/mainnet-preflight.mjs): the City coins tab's "Send this to the team" box
// checked against a fake MAINNET chain built the way the programs, Meteora and Squads write their accounts. Every address of the
// summary is read and compared with the settings; a setting that is not set yet is taken from the summary (and the row says so);
// the Squads multisig is decoded and its vault becomes the expected upgrade authority of BOTH programs; the rewards program, its
// registry and both admins are checked (a plain-wallet admin passes when it is --expect-admin, a plain-wallet upgrade authority never
// does on mainnet); the programs' fingerprints are compared with build-mainnet.sh's build record; the live site's /coin-meta, logo
// and launch routes are probed. Read-only: no sendTransaction, no simulateTransaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fingerprintsFrom, preflight, readSummary, settingsWithSummary } from "../scripts/mainnet-preflight.mjs";
import { base58Decode, base58Encode } from "../src/solana.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { LAYOUT } from "../src/sol/layout.js";
import { ADDRESSES, PROGRAM_IDS, ata, launchpad as launchpadPdas, programDataAddress } from "../src/sol/pda.js";
import { EXPECTED_POOL_CONFIG } from "../src/sol/dbc-config-data.js";
import { lookupTableAddresses, partnerMetadataAddress, rewards as rewardsPdas } from "../src/sol/lpadmin-ix.js";
import { fakeWorld, REAL_VIC } from "./helpers/jupfake.js";

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/squads/vectors.json", import.meta.url), "utf8"));
const MS = VECTORS.synthetic[0]; // 2 of 3, no config authority: what app.squads.so makes
const VAULT = MS.expected.vaults[0];
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LOADER = PROGRAM_IDS.upgradeableLoader, SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const DEV = ADDRESSES.feeRecipient, WSOL = ADDRESSES.wsol;
// stand-in program ids (the owner's real ones arrive later; they are only addresses here)
const LP = "BZhZJSbCFq1S8RbJTXa6Sjze1mri3EdQmEjeV1GQE9EX", RW = "4yES9yRW384gnoJkL6bwc9wyWBBaZVALs3zteo3fz2Ft";
const addrOf = (n) => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 13 + i * 29) % 256));
const CONFIG = addrOf(1), TABLE = addrOf(2); // the price curve (a browser key on the website) and the speed table
const SITE = "https://site.test";
const b64 = (u8) => Buffer.from(u8).toString("base64");
const sig = (n) => base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + n) % 256 || 1));
const sha = (u8) => createHash("sha256").update(u8).digest("hex");
// the two "binaries": distinct bytes; the rewards program is deployed with 64 bytes of room to grow (zero padding)
const LP_ELF = Uint8Array.from({ length: 4000 }, (_, i) => (i * 31 + 7) % 251);
const RW_ELF = Uint8Array.from({ length: 5000 }, (_, i) => (i * 17 + 3) % 253);
const BUILD_RECORD = { programs: { vicinity_launchpad: { programId: LP, bytes: LP_ELF.length, sha256: sha(LP_ELF) }, vicinity_rewards: { programId: RW, bytes: RW_ELF.length, sha256: sha(RW_ELF) } } };

function layoutAccount(name, values) {
  const L = LAYOUT[name], out = new Uint8Array(L.size);
  out.set(L.discriminator, 0);
  for (const [k, v] of Object.entries(values)) {
    const f = L.fields[k];
    if (f.type === "pubkey") out.set(base58Decode(v), f.at);
    else if (f.type === "u64" || f.type === "i64") out.set(u64le(BigInt.asUintN(64, BigInt(v))), f.at);
    else out[f.at] = Number(v);
  }
  return out;
}
const tokenAccount = (mint, owner, program = PROGRAM_IDS.token) => ({ owner: program, data: b64(concat([base58Decode(mint), base58Decode(owner), u64le(0n), new Uint8Array(36), Uint8Array.of(1), new Uint8Array(12), u64le(0), new Uint8Array(36)])) });
function tableAccount(authority, addresses, { deactivated = false } = {}) {
  const head = new Uint8Array(56);
  head.set(u32le(1), 0); head.set(u64le(deactivated ? 123n : (1n << 64n) - 1n), 4);
  head[21] = 1; head.set(base58Decode(authority), 22);
  return { owner: PROGRAM_IDS.lookupTable, data: b64(concat([head, ...addresses.map((a) => base58Decode(a))])) };
}
const programAccount = (pd) => ({ owner: LOADER, executable: true, data: b64(concat([u32le(2), base58Decode(pd)])) });
const programDataAccount = (authority, elf) => ({ owner: LOADER, data: b64(concat([u32le(3), u64le(400_000_000), Uint8Array.of(1), base58Decode(authority), elf])) });

/** The mainnet chain right after the website setup (steps 1-7), plus what `change` alters. */
async function chainAfterSetup(change = {}) {
  const L = launchpadPdas(LP);
  const [pdLp, pdRw, global, registry, launchConfig, wsolAta, vicAta, partner] = await Promise.all([
    programDataAddress(LP), programDataAddress(RW), L.launchpad(), rewardsPdas(RW).registry(), L.launchConfig(CONFIG), ata(DEV, WSOL), ata(DEV, REAL_VIC), partnerMetadataAddress(DEV),
  ]);
  const tableAddrs = await lookupTableAddresses({ programId: LP, rewardsProgramId: RW, dbcConfigs: [CONFIG] });
  const accounts = {
    [LP]: programAccount(pdLp), [RW]: programAccount(pdRw),
    [pdLp]: programDataAccount(VAULT, LP_ELF), [pdRw]: programDataAccount(VAULT, concat([RW_ELF, new Uint8Array(64)])),
    [global]: { owner: LP, data: b64(layoutAccount("Launchpad", { admin: DEV, rewards_program: RW })) },
    [registry]: { owner: RW, data: b64(concat([Uint8Array.of(47, 174, 110, 246, 184, 182, 252, 218), base58Decode(DEV), new Uint8Array(32), Uint8Array.of(255)])) },
    [CONFIG]: { owner: PROGRAM_IDS.dbc, data: EXPECTED_POOL_CONFIG },
    [launchConfig]: { owner: LP, data: b64(layoutAccount("LaunchConfig", { dbc_config: CONFIG, quote_mint: WSOL, migration_quote_threshold: 85_000_000_000n, trade_fee_numerator: 12_500_000n, pool_creation_fee: 50_000_000n, enabled: 1 })) },
    [wsolAta]: tokenAccount(WSOL, DEV), [vicAta]: tokenAccount(REAL_VIC, DEV),
    [TABLE]: tableAccount(DEV, tableAddrs),
    [MS.address]: { owner: SQUADS, data: MS.data },
    [partner]: { owner: PROGRAM_IDS.dbc, data: b64(concat([Uint8Array.of(68, 68, 130, 19, 16, 209, 98, 156), new Uint8Array(100)])) },
    [PROGRAM_IDS.dbc]: { owner: LOADER, executable: true, data: "" }, [PROGRAM_IDS.jupiter]: { owner: LOADER, executable: true, data: "" },
    ...change,
  };
  for (const [k, v] of Object.entries(change)) if (v === null) delete accounts[k];
  const sigs = { init: sig(1), handoff: sig(2), config: sig(3), allow: sig(4), referral: sig(5), lookupCreate: sig(6), lookupExtend: [sig(7)], partner: sig(8) };
  const summary = {
    cluster: "mainnet", launchpadProgram: LP, rewardsProgram: RW, squadsMultisig: MS.address, squadsVault: VAULT, admin: DEV, registryAdmin: DEV,
    dbcConfig: CONFIG, launchConfig, lookupTable: TABLE, referralAccounts: { wsol: wsolAta, vicinity: vicAta }, partnerMetadata: partner, signatures: sigs,
  };
  return { accounts, summary, pdLp, pdRw, global, launchConfig, partner, tableAddrs };
}

/** A fake mainnet RPC (the accounts above, signature statuses), Jupiter (jupfake) and a live site. */
function world(accounts, { statuses = {}, site = {} } = {}) {
  const W = fakeWorld({ rpc: { mints: { [REAL_VIC]: { decimals: 6 } } } });
  const sent = [], paths = [];
  const SEC = { "content-security-policy": "default-src 'self'; connect-src 'self'; frame-ancestors 'none'", "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff" };
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...SEC, ...headers } });
  const S = { lpOn: true, cluster: "mainnet", configsSet: false, coinMeta: "json", brand: true, cityStatus: 401, ...site };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(SITE)) {
      const { pathname, search } = new URL(u);
      paths.push(pathname + search);
      if (pathname.startsWith("/coin-meta/")) return S.coinMeta === "json" ? json({ ok: false, error: "not_found" }, 404, { "access-control-allow-origin": "*" }) : new Response("<!doctype html>Not found", { status: 404, headers: { "content-type": "text/html" } });
      if (pathname === "/brand/vicinity-512.png") return S.brand ? new Response(new Uint8Array(8), { status: 200, headers: { "content-type": "image/png" } }) : new Response("nope", { status: 404 });
      if (pathname === "/api/lp/launch/status") {
        if (!S.lpOn) return json({ ok: false, error: "not_enabled" }, 404);
        if (search.includes("city=")) return json({ ok: false, error: "sign_in" }, S.cityStatus);
        return json({ ok: true, on: true, cluster: S.cluster, chain: `solana:${S.cluster}`, configsSet: S.configsSet, speedTable: S.configsSet });
      }
      if (pathname === "/api/health") return json({ ok: true });
      if (pathname === "/api/official") return json({ tokenContract: REAL_VIC, swap: true });
      if (pathname === "/api/policy") return json({ launched: true, balanceHistory: { running: true, lastSample: { taken_at: new Date().toISOString() }, samplesLast24h: 140 } });
      if (pathname === "/api/swap/config") return json({ ok: true, cluster: "mainnet", jupiter: { keyed: true, host: "api.jup.ag", rps: 10 }, tokens: [1], launchpad: { enabled: false } });
      if (pathname === "/api/swap/quote") return json({ ok: true, source: "jupiter_quote", outUi: "1", route: ["x"] });
      return new Response("<!doctype html>", { status: 200, headers: SEC });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    if (body && /sendTransaction|simulateTransaction/.test(body.method)) sent.push(body.method);
    const ok = (result) => json({ jsonrpc: "2.0", id: 1, result });
    if (body && body.method === "getGenesisHash") return ok(MAINNET_GENESIS);
    if (body && body.method === "getHealth") return ok("ok");
    if (body && body.method === "getSignatureStatuses") return ok({ context: { slot: 1 }, value: body.params[0].map((s) => (s in statuses ? statuses[s] : { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" })) });
    if (body && body.method === "getAccountInfo" && accounts[body.params[0]]) {
      const a = accounts[body.params[0]], slice = body.params[1] && body.params[1].dataSlice;
      let data = Buffer.from(a.data, "base64");
      if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
      return ok({ context: { slot: 1 }, value: { owner: a.owner, lamports: 1, executable: Boolean(a.executable), rentEpoch: 0, data: [data.toString("base64"), "base64"] } });
    }
    if (body && body.method === "getAccountInfo" && body.params[1] && body.params[1].encoding === "base64" && body.params[0] !== REAL_VIC) return ok({ context: { slot: 1 }, value: null });
    return W.fetch(url, init);
  };
  return { fetchImpl, sent, paths };
}
const by = (rows, name) => rows.find((r) => r.name === name);
const levels = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.level]));
/** PR-1 is merged (cluster, both program ids); the price curve, the speed table and trading are not set yet (that is PR-2). */
const PR1_ENV = { SWAP: "on", LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: LP, LAUNCHPAD_REWARDS_PROGRAM_ID: RW, VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test", JUPITER_API_KEY: "k".repeat(32), JUPITER_RPS: "10", ADMIN_WALLETS: DEV, RPC_TIMEOUT_MS: "8000" };
const PR2_ENV = { ...PR1_ENV, LAUNCHPAD_DBC_CONFIGS: CONFIG, LAUNCHPAD_LOOKUP_TABLE: TABLE, LAUNCHPAD_TRADING: "on" };
const run = (env, w, opts = {}) => preflight(env, { fetchImpl: w.fetchImpl, expectAdmin: DEV, fingerprints: fingerprintsFrom({ buildRecord: BUILD_RECORD }), ...opts });

test("setup preflight: right after the website setup (before PR-2) every row passes or warns for the right reason; the summary supplies the curve and the table; nothing is sent", async () => {
  const c = await chainAfterSetup();
  const w = world(c.accounts);
  const rows = await run(PR1_ENV, w, { setup: c.summary, site: SITE });
  const L = levels(rows);
  assert.deepEqual(rows.filter((r) => r.level === "FAIL"), [], "no FAIL");
  for (const name of ["setup Squads multisig", "launchpad program", "upgrade authority", "launchpad program fingerprint", "launchpad global account", "launchpad admin", "rewards program",
    "rewards program deployed", "rewards upgrade authority", "rewards program fingerprint", "rewards registry", "registry admin", `DBC config ${CONFIG.slice(0, 6)}…`, `allow-list entry ${CONFIG.slice(0, 6)}…`,
    "referral account SOL", "LAUNCHPAD_LOOKUP_TABLE", "speed table for city coins", "setup price curve", "setup allow-list entry", "setup speed table", "setup admin", "setup fee accounts",
    "setup partner metadata", "setup signatures", "LAUNCHPAD_REWARDS_PROGRAM_ID", "city coins gate", "site /coin-meta", "site /brand/vicinity-512.png"]) {
    assert.equal(L[name], "PASS", `${name}: ${JSON.stringify(by(rows, name))}`);
  }
  // the settings PR-2 sets come from the summary for this run, and the row prints them
  assert.equal(L["setup summary vs settings"], "WARN");
  assert.equal(by(rows, "setup summary vs settings").detail, `not set here yet, so this run takes them from the summary: LAUNCHPAD_DBC_CONFIGS=${CONFIG}, LAUNCHPAD_LOOKUP_TABLE=${TABLE} (the pull request after the setup sets exactly these)`);
  // the multisig, decoded from the chain; its vault is the expected upgrade authority of both programs
  assert.equal(by(rows, "setup Squads multisig").detail, `${MS.address}: 2 of 3: ${MS.expected.members.map((m) => m.key).join(", ")}; vault ${VAULT}`);
  assert.match(by(rows, "upgrade authority").detail, new RegExp(`^${VAULT} = the expected multisig \\(the vault of the summary's Squads multisig\\)`));
  assert.match(by(rows, "rewards upgrade authority").detail, new RegExp(`^${VAULT} = the expected multisig`));
  // the admin is the owner's Phantom wallet (D1): a plain wallet passes because it is --expect-admin
  assert.match(by(rows, "launchpad admin").detail, new RegExp(`^${DEV} = --expect-admin \\(one wallet, as planned`));
  assert.match(by(rows, "rewards program").detail, new RegExp(`^${RW} \\(vicinity_rewards: holder rewards per city\\) = LAUNCHPAD_REWARDS_PROGRAM_ID$`));
  // the fingerprints: ProgramData from byte 45 against build-mainnet.sh's record; the rewards program carries zero padding after the build
  assert.equal(by(rows, "launchpad program fingerprint").detail, `${LP_ELF.length} bytes, SHA-256 ${sha(LP_ELF)} = the build record`);
  assert.equal(by(rows, "rewards program fingerprint").detail, `${RW_ELF.length} bytes, SHA-256 ${sha(RW_ELF)} = the build record (the first ${RW_ELF.length} of ${RW_ELF.length + 64} bytes; the rest is zero padding)`);
  assert.match(by(rows, "setup price curve").detail, /byte for byte the config Meteora writes for Vicinity's defaults \(85 SOL target, 1\.25% fee, 0\.05 SOL launch fee/);
  assert.match(by(rows, "setup speed table").detail, new RegExp(`^${TABLE} holds the price curve and its allow-list entry \\(${c.tableAddrs.length} addresses; authority ${DEV}\\)$`));
  assert.match(by(rows, "speed table for city coins").detail, new RegExp(`^holds all ${c.tableAddrs.length} addresses`));
  assert.match(by(rows, "setup fee accounts").detail, /^SOL \w+; \$VICINITY \w+$/);
  assert.equal(by(rows, "setup signatures").detail, "all 8 setup transactions landed and succeeded");
  assert.match(by(rows, "city coins gate").detail, /^on \(mainnet\): the owner's City coins tab/);
  // the live site is on (PR-1 deployed) but has no price curve yet: a WARN that names the difference, never a FAIL
  assert.equal(L["site city-coin routes"], "WARN"); assert.match(by(rows, "site city-coin routes").detail, /^on \(mainnet; price curve not set yet, speed table not set\); a signed-out launch status answers 401 — the price curve is not set on the site but here/);
  assert.equal(L.LAUNCHPAD_TRADING, "WARN", "trading stays off until PR-2");
  assert.deepEqual(w.sent, [], "read-only");
  assert.ok(w.paths.some((p) => /^\/coin-meta\/[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(p)), "an unknown coin is asked for");
  assert.ok(w.paths.includes("/api/lp/launch/status?city=1"));
});

test("setup preflight: after PR-2 the settings equal the summary (PASS), trading is ready, and the site's routes pass", async () => {
  const c = await chainAfterSetup();
  const rows = await run(PR2_ENV, world(c.accounts, { site: { configsSet: true } }), { setup: { ok: true, summary: c.summary, complete: true }, site: SITE });
  const L = levels(rows);
  assert.equal(L["setup summary vs settings"], "PASS", "the API's { ok, summary } wrapper is accepted too");
  assert.equal(L.LAUNCHPAD_TRADING, "PASS");
  assert.equal(L["site city-coin routes"], "PASS"); assert.match(by(rows, "site city-coin routes").detail, /^on \(mainnet; price curve set, speed table set\); a signed-out launch status answers 401$/);
  assert.deepEqual(rows.filter((r) => r.level === "FAIL"), []);
});

test("setup preflight: a setting that disagrees with the summary FAILs and names both values", async () => {
  const c = await chainAfterSetup();
  const other = "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7";
  const rows = await run({ ...PR2_ENV, LAUNCHPAD_DBC_CONFIGS: other, LAUNCHPAD_REWARDS_PROGRAM_ID: RW }, world(c.accounts), { setup: c.summary });
  assert.equal(by(rows, "setup summary vs settings").level, "FAIL");
  assert.match(by(rows, "setup summary vs settings").detail, new RegExp(`^LAUNCHPAD_DBC_CONFIGS is ${other} here but the summary says ${CONFIG}: the settings and the website's setup disagree`));
  assert.equal(by(rows, "setup price curve").level, "FAIL", "the summary's curve is not in the settings");
  // the pure helpers
  assert.deepEqual(settingsWithSummary({ LAUNCHPAD_CLUSTER: "MAINNET", LAUNCHPAD_DBC_CONFIGS: `${other}, ${CONFIG}` }, c.summary).conflicts, [], "a list of configs that includes the summary's agrees; the cluster is compared without case");
  assert.equal(readSummary({ hello: 1 }), null);
  assert.equal(readSummary({ ...c.summary, cluster: "testnet" }), null);
  const junk = await run(PR2_ENV, world(c.accounts), { setup: { not: "a summary" } });
  assert.equal(by(junk, "setup summary").level, "FAIL"); assert.match(by(junk, "setup summary").detail, /not the JSON of the City coins tab's "Send this to the team" box/);
});

test("setup preflight: the Squads multisig: a pasted vault or wallet, a 1-of-2 multisig, a vault that is not the multisig's: FAIL, and then the upgrade authority cannot pass by accident", async () => {
  const c = await chainAfterSetup();
  // the summary names the VAULT as the multisig (a system-owned address): refused in Squads' own words; no expectation is left
  const vaultAsMs = await run(PR2_ENV, world({ ...c.accounts, [VAULT]: { owner: PROGRAM_IDS.system, data: "" } }), { setup: { ...c.summary, squadsMultisig: VAULT } });
  assert.equal(by(vaultAsMs, "setup Squads multisig").level, "FAIL"); assert.match(by(vaultAsMs, "setup Squads multisig").detail, /a wallet or a Squads vault, not the multisig account/);
  assert.equal(by(vaultAsMs, "upgrade authority").level, "FAIL"); assert.match(by(vaultAsMs, "upgrade authority").detail, /nobody said whose; on mainnet this row needs --expect-upgrade-authority/);
  // a 1-of-2 multisig: one key alone could replace the programs
  const weak = VECTORS.synthetic[1];
  const one = await run(PR2_ENV, world({ ...c.accounts, [weak.address]: { owner: SQUADS, data: weak.data } }), { setup: { ...c.summary, squadsMultisig: weak.address, squadsVault: weak.expected.vaults[0] } });
  assert.equal(by(one, "setup Squads multisig").level, "FAIL"); assert.match(by(one, "setup Squads multisig").detail, /needs only 1 approval/);
  // the summary's vault is not the multisig's vault
  const wrongVault = await run(PR2_ENV, world(c.accounts), { setup: { ...c.summary, squadsVault: DEV } });
  assert.equal(by(wrongVault, "setup Squads multisig").level, "FAIL"); assert.match(by(wrongVault, "setup Squads multisig").detail, new RegExp(`whose vault is ${VAULT}, but the summary names the vault ${DEV}`));
  // the team's own expectation must be the multisig's vault
  const mismatch = await run(PR2_ENV, world(c.accounts), { setup: c.summary, expectUpgradeAuthority: DEV });
  assert.equal(by(mismatch, "setup Squads vault").level, "FAIL");
  assert.equal(by(mismatch, "upgrade authority").level, "FAIL", "the named expectation wins and the chain does not match it");
  // the hand-over was never done: both programs still answer to the owner's Phantom
  const notHanded = await chainAfterSetup({ [c.pdLp]: programDataAccount(DEV, LP_ELF), [c.pdRw]: programDataAccount(DEV, RW_ELF) });
  const nh = await run(PR2_ENV, world(notHanded.accounts), { setup: notHanded.summary });
  assert.equal(by(nh, "upgrade authority").level, "FAIL"); assert.match(by(nh, "upgrade authority").detail, new RegExp(`^${DEV} is NOT the expected ${VAULT} \\(the vault of the summary's Squads multisig\\)`));
  assert.equal(by(nh, "rewards upgrade authority").level, "FAIL");
  // and naming that plain wallet as the expected authority does not help on mainnet
  const named = await run(PR2_ENV, world(notHanded.accounts), { setup: notHanded.summary, expectUpgradeAuthority: DEV });
  assert.equal(by(named, "upgrade authority").level, "FAIL"); assert.match(by(named, "upgrade authority").detail, /= the expected key, but it is a single wallet key/);
});

test("setup preflight: fingerprints, admins, the price curve, the table, the partner record and the setup transactions each FAIL (or WARN) for their own reason", async () => {
  const c = await chainAfterSetup();
  // a program on chain that is not the build: FAIL; no record on mainnet: WARN with the fingerprint printed; the flag alone works too
  const other = await chainAfterSetup({ [c.pdLp]: programDataAccount(VAULT, LP_ELF.map((x, i) => (i === 100 ? x ^ 1 : x))) });
  const fp = await run(PR2_ENV, world(other.accounts), { setup: other.summary });
  assert.equal(by(fp, "launchpad program fingerprint").level, "FAIL"); assert.match(by(fp, "launchpad program fingerprint").detail, /is NOT the build record's .*: the program on chain is not the build that was checked/);
  const none = await run(PR2_ENV, world(c.accounts), { setup: c.summary, fingerprints: {} });
  assert.equal(by(none, "launchpad program fingerprint").level, "WARN"); assert.equal(by(none, "launchpad program fingerprint").detail, `${LP_ELF.length} bytes, SHA-256 ${sha(LP_ELF)}: not compared (pass --build-record <build-record.json> from build-mainnet.sh, or --expect-sha256-…)`);
  const flag = await run(PR2_ENV, world(c.accounts), { setup: c.summary, fingerprints: fingerprintsFrom({ launchpad: sha(LP_ELF).toUpperCase() }) });
  assert.equal(by(flag, "launchpad program fingerprint").level, "PASS"); assert.match(by(flag, "launchpad program fingerprint").detail, /= the --expect-sha256$/);
  const wrongIds = await run(PR2_ENV, world(c.accounts), { setup: c.summary, fingerprints: fingerprintsFrom({ buildRecord: { programs: { vicinity_launchpad: { ...BUILD_RECORD.programs.vicinity_launchpad, programId: RW } } } }) });
  assert.equal(by(wrongIds, "launchpad program fingerprint").level, "FAIL"); assert.match(by(wrongIds, "launchpad program fingerprint").detail, /the build record is for/);
  // admins: the summary's admin is not the chain's; the team expects another admin
  const adm = await run(PR2_ENV, world(c.accounts), { setup: { ...c.summary, admin: VAULT } });
  assert.equal(by(adm, "setup admin").level, "FAIL"); assert.match(by(adm, "setup admin").detail, new RegExp(`the summary names ${VAULT} but the launchpad admin is ${DEV}`));
  const exp = await run(PR2_ENV, world(c.accounts), { setup: c.summary, expectAdmin: VAULT });
  assert.equal(by(exp, "launchpad admin").level, "FAIL"); assert.equal(by(exp, "registry admin").level, "FAIL"); assert.equal(by(exp, "setup admin").level, "FAIL");
  // a price curve that differs from the defaults (the graduation target), a table without the allow-list entry, no partner record,
  // one failed and one unknown setup transaction
  const cfg = Buffer.from(EXPECTED_POOL_CONFIG, "base64");
  const f = LAYOUT.PoolConfig.fields.migration_quote_threshold;
  cfg.set(u64le(20_000_000_000n), f.at);
  const bad = await chainAfterSetup({ [CONFIG]: { owner: PROGRAM_IDS.dbc, data: cfg.toString("base64") }, [TABLE]: tableAccount(DEV, c.tableAddrs.filter((a) => a !== c.launchConfig)), [c.partner]: null });
  const sg = bad.summary.signatures;
  const br = await run(PR2_ENV, world(bad.accounts, { statuses: { [sg.allow]: { slot: 1, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" }, [sg.partner]: null } }), { setup: bad.summary });
  assert.equal(by(br, "setup price curve").level, "FAIL"); assert.match(by(br, "setup price curve").detail, /differs from Vicinity's mainnet defaults in: migration_quote_threshold/);
  assert.equal(by(br, `DBC config ${CONFIG.slice(0, 6)}…`).level, "WARN", "the config row itself: a 20 SOL target is an owner decision");
  assert.equal(by(br, "setup speed table").level, "FAIL"); assert.match(by(br, "setup speed table").detail, /misses \w+… \(the price curve or its allow-list entry\)/);
  assert.equal(by(br, "speed table for city coins").level, "WARN");
  assert.equal(by(br, "setup partner metadata").level, "WARN"); assert.match(by(br, "setup partner metadata").detail, /not on chain yet: Meteora and Jupiter show no "Vicinity" name .* \(not a blocker\)/);
  assert.equal(by(br, "setup signatures").level, "FAIL"); assert.match(by(br, "setup signatures").detail, /^1 of the 8 setup transactions FAILED on chain/);
  const unknown = await run(PR2_ENV, world(c.accounts, { statuses: { [c.summary.signatures.partner]: null } }), { setup: c.summary });
  assert.equal(by(unknown, "setup signatures").level, "WARN"); assert.match(by(unknown, "setup signatures").detail, /^7 of 8 found; .* not found by this RPC/);
  // a deactivated table is a FAIL of its own
  const off = await chainAfterSetup({ [TABLE]: tableAccount(DEV, c.tableAddrs, { deactivated: true }) });
  const offRows = await run(PR2_ENV, world(off.accounts), { setup: off.summary });
  assert.equal(by(offRows, "speed table for city coins").level, "FAIL"); assert.equal(by(offRows, "setup speed table").level, "FAIL");
  // fee accounts the summary names wrong / missing on chain
  const fee = await run(PR2_ENV, world({ ...c.accounts, [c.summary.referralAccounts.vicinity]: undefined }), { setup: { ...c.summary, referralAccounts: { wsol: DEV, vicinity: c.summary.referralAccounts.vicinity } } });
  assert.equal(by(fee, "setup fee accounts").level, "FAIL"); assert.match(by(fee, "setup fee accounts").detail, new RegExp(`^SOL: the summary names ${DEV}, the dev wallet's account is \\w+`));
});

test("setup preflight: the live site's city-coin rows: off here and there passes; on here but off there, /coin-meta answered by the static 404 page, no logo: FAIL", async () => {
  const c = await chainAfterSetup();
  const offEverywhere = await preflight({ SWAP: "on", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test" }, { fetchImpl: world(c.accounts, { site: { lpOn: false, coinMeta: "html", brand: false } }).fetchImpl, site: SITE });
  assert.equal(by(offEverywhere, "site city-coin routes").level, "PASS"); assert.match(by(offEverywhere, "site city-coin routes").detail, /^off on the site \(404 not_enabled\), as the settings here say$/);
  assert.equal(by(offEverywhere, "site /coin-meta").level, "WARN", "not needed while the city coins are off");
  assert.equal(by(offEverywhere, "site /brand/vicinity-512.png").level, "WARN");
  const onHereOnly = await run(PR2_ENV, world(c.accounts, { site: { lpOn: false, coinMeta: "html", brand: false } }), { setup: c.summary, site: SITE });
  assert.equal(by(onHereOnly, "site city-coin routes").level, "FAIL"); assert.match(by(onHereOnly, "site city-coin routes").detail, /the live site does not \(the pull request is not deployed/);
  assert.equal(by(onHereOnly, "site /coin-meta").level, "FAIL"); assert.match(by(onHereOnly, "site /coin-meta").detail, /answered HTTP 404 text\/html, no CORS header: the Worker does not serve \/coin-meta yet, so a coin approved now would point wallets and explorers at a dead address for ever/);
  assert.equal(by(onHereOnly, "site /brand/vicinity-512.png").level, "FAIL");
  const devnetSite = await run(PR2_ENV, world(c.accounts, { site: { cluster: "devnet", configsSet: true, cityStatus: 404 } }), { site: SITE });
  assert.equal(by(devnetSite, "site city-coin routes").level, "FAIL"); assert.match(by(devnetSite, "site city-coin routes").detail, /the site runs them on devnet, the settings here on mainnet; a signed-out launch status answered HTTP 404, not 401/);
});

test("setup preflight: right after the Mac deploy (PR-1 merged, nothing set up yet) the program rows already run: fingerprints, sizes, the keys", async () => {
  const c = await chainAfterSetup();
  // guide step 10 done: both programs answer to the owner's Phantom; website step 1 not done yet (no global account, no registry)
  const fresh = { ...c.accounts, [c.pdLp]: programDataAccount(DEV, LP_ELF), [c.pdRw]: programDataAccount(DEV, concat([RW_ELF, new Uint8Array(64)])), [c.global]: undefined, [await rewardsPdas(RW).registry()]: undefined };
  const rows = await preflight(PR1_ENV, { fetchImpl: world(fresh).fetchImpl, fingerprints: fingerprintsFrom({ buildRecord: BUILD_RECORD }) });
  const L = levels(rows);
  assert.equal(L.LAUNCHPAD_DBC_CONFIGS, "FAIL"); assert.match(by(rows, "LAUNCHPAD_DBC_CONFIGS").detail, /REQUIRED on mainnet \(there is no default\): the second settings change sets it/);
  assert.equal(L["launchpad program"], "PASS"); assert.equal(L["rewards program deployed"], "PASS");
  assert.equal(L["launchpad program fingerprint"], "PASS"); assert.equal(L["rewards program fingerprint"], "PASS");
  assert.equal(L["upgrade authority"], "FAIL", "one wallet on mainnet: right for the minutes between guide step 10 and website step 2, never for the launch");
  assert.equal(L["launchpad global account"], "FAIL"); assert.match(by(rows, "launchpad global account").detail, /not initialised: the City coins tab's step 1 starts it/);
  assert.equal(L["rewards registry"], "FAIL");
  assert.match(by(rows, "launchpad RPC health").detail, /^getHealth ok, the program in \d+ ms$/);
});

test("setup preflight: the command line refuses a --setup or --build-record file that is not JSON before reading anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  try {
    writeFileSync(join(dir, "s.json"), "not json");
    const r = spawnSync(process.execPath, [new URL("../scripts/mainnet-preflight.mjs", import.meta.url).pathname, "--setup", join(dir, "s.json")], { encoding: "utf8" });
    assert.equal(r.status, 2); assert.match(r.stderr, /--setup .*s\.json could not be read as JSON/);
    const b = spawnSync(process.execPath, [new URL("../scripts/mainnet-preflight.mjs", import.meta.url).pathname, "--build-record", join(dir, "missing.json")], { encoding: "utf8" });
    assert.equal(b.status, 2); assert.match(b.stderr, /--build-record .*missing\.json could not be read as JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // build-mainnet.sh's record shape becomes the expectations (the flags win over the record)
  const fp = fingerprintsFrom({ buildRecord: BUILD_RECORD, rewards: "AA" });
  assert.deepEqual(fp.launchpad, { sha256: sha(LP_ELF), bytes: LP_ELF.length, programId: LP, source: "build record" });
  assert.deepEqual(fp.rewards, { sha256: "aa", bytes: RW_ELF.length, programId: RW, source: "--expect-sha256" });
});
