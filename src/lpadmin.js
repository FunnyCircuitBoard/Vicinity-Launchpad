/**
 * The admin "City coins" tab: /api/admin/lp/* (src/admin.js routes here only while lpSetup(env).on, for the OWNER only, with a
 * fresh wallet proof on every POST). Everything the owner does on chain after deploying the two programs from his Mac happens
 * here, one wallet signature per step, signed in his own wallet (Phantom): the Worker reads the chain, checks the step can run,
 * builds the transaction UNSIGNED with the SESSION wallet as the fee payer (never a wallet from the request), simulates it and
 * shows the decoded instruction list and the exact SOL change (src/lpkit.js buildTx); the page signs (public/lp-sign.js) and the
 * wallet sends (or the relay, for a wallet that only signs). The Worker never holds a key. Nothing here sends a transaction.
 *
 *   GET  ""                 { on, cluster, programs, wallet }: the page's cheap probe (no chain read)
 *   GET  status             settings, genesis, both programs (deployed, executable, upgrade authority, size, SHA-256), the
 *                           registry, the launchpad, the price curve against the defaults, the allow-list, the fee accounts, the
 *                           speed table, the partner name, the Squads vault; setup steps 1-7, each done | ready | blocked + why;
 *                           meteora: are Meteora's two programs still the builds the team tested (src/programpins.js)
 *   GET  pins               that Meteora check alone (the Overview's "Meteora build" card)
 *   GET  squads?address=    a pasted Squads multisig: decoded, checked, its vault derived (src/sol/squads.js)
 *   POST tx                 { step, cluster, params, ephemeral }: one setup step's transaction. Steps 3 and 4 are built on Meteora's
 *                           programs read fresh, once: step 3 (the price curve) is refused with 409 program_changed while DBC is not
 *                           the build the expected curve bytes came from, step 4 (the allow-list) while either program is not the
 *                           pinned build, and both with 503 program_check_unavailable while that cannot be read clearly
 *   POST record             { step, signature, cluster, params }: confirms it on chain, then lp_setup / lp_approvals_log. A price
 *                           curve (step 3) is recorded only while DBC, read fresh like the builds, is the build the expected curve
 *                           bytes came from: else dbc_changed, or dbc_unreadable (the page asks again) when it cannot be read clearly
 *   GET  summary            the setup summary the owner sends to the team (PLAN C5)
 *   GET  candidates         cities whose coin can be approved (PLAN D10), each blocked one with its reasons; approvals waiting
 *   POST approve/tx         { cityId, expiryDays, name, symbol, founder, designAt } (what the card showed: refused when it changed).
 *                           Like step 4 (the allow-list), refused with 409 program_changed while a Meteora program is not the tested
 *                           build, and with 503 program_check_unavailable while that cannot be read: never an approval blind. Both
 *                           read the programs' deploy slots fresh (src/programpins.js `fresh`), not the pages' ten-minute answer
 *   POST revoke/tx          { cityId }
 *   GET  coins              launched coins: stage, fees waiting, holder rewards set up or not
 *   POST collect/tx | init-city/tx | forward/tx { cityId }     POST pause/tx { launches }
 *   GET  platform/plan      the dev wallet's platform fees waiting       POST platform/tx  the next claim transaction (13qRam only)
 * Every request echoes the cluster the page shows (?cluster= / body.cluster) and is refused on a mismatch; the RPC's genesis hash
 * is checked against the cluster first (src/lpkit.js checkGenesis).
 * D1: lp_setup (cluster, program_id, step) -> the address and signature a setup step produced; lp_approvals_log, append only.
 */
import { json, readJson } from "./http.js";
import { isSolanaAddress, base58Encode } from "./solana.js";
import { codeOf } from "./sources.js";
import { activeMint } from "./official.js";
import { displayTicker, tickerOf } from "./tickers.js";
import { iso } from "./policy.js";
import { lpSetup } from "./cluster.js";
import { ensureLogoSchema } from "./store.js";
import { coinV2ReadyOn } from "./flags.js";
import { chosenOf, clearApproved, ensureReadySchema, markApprovedStatement } from "./coinart-store.js";
import { buildTx, checkCluster, checkGenesis, checkedRoute, lpRpc, readAccounts, respond } from "./lpkit.js";
import { ADDRESSES, PROGRAM_IDS, ata, launchpad as launchpadPdas, programDataAddress } from "./sol/pda.js";
import { createAtaIdempotent } from "./sol/ix.js";
import { accountBytes, decodeCoin, decodeConfig, decodeLaunchConfig, decodeLaunchpad, decodePool, decodeProgramAccount, decodeProgramData, decodeTokenAccount } from "./sol/dbc.js";
import { LAYOUT } from "./sol/layout.js";
import { fromBase64, readI64, readU32, readU64 } from "./sol/bytes.js";
import { compileLegacy, MAX_TX_BYTES, wrapUnsigned } from "./sol/message.js";
import { DBC_CONFIG_DEFAULTS, DBC_PROGRAM_SHA256, EXPECTED_POOL_CONFIG } from "./sol/dbc-config-data.js";
import { checkMultisig } from "./sol/squads.js";
import { holdDesign, unknownSymbols } from "./lpcoins.js";
import { settleLegacyContract } from "./coins.js";
import { feeSchedule } from "./fees.js";
import { _forgetProgramHashes, fingerprint, programHashes, programRefusal, programSummary } from "./programpins.js";
import * as IX from "./sol/lpadmin-ix.js";

const DEV = ADDRESSES.feeRecipient;
const WSOL = ADDRESSES.wsol;
const U64_MAX = (1n << 64n) - 1n;
const DAY_S = 86_400;
const APPROVAL_MAX_S = Number(LAYOUT.constants.APPROVAL_MAX_SECS); // 30 days: the program's own limit
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const TOKEN_ACCOUNT_BYTES = 165, LOOKUP_TABLE_META_BYTES = 56;
export const STEPS = Object.freeze(["start", "handoff", "config", "allow", "referral", "lookup", "partner"]);
const TITLE = {
  start: "Start the launchpad", handoff: "Hand the programs to your Squads", config: "Create the Meteora price curve", allow: "Allow the price curve",
  referral: "Fee accounts", lookup: "Speed table", partner: "Name Vicinity on Meteora", summary: "Send this to the team",
};
const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a || ""));
const sol = (lamports) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;
const err = (error, message, status = 409, extra = {}) => json({ ok: false, error, message, ...extra }, status, { "Cache-Control": "no-store" });

/* ---------------------------------------------------------------- D1 */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS lp_setup (
    cluster    TEXT NOT NULL,
    program_id TEXT NOT NULL,
    step       TEXT NOT NULL,
    address    TEXT,
    signature  TEXT,
    by_wallet  TEXT NOT NULL,
    at         TEXT NOT NULL,
    PRIMARY KEY (cluster, program_id, step)
  )`,
  `CREATE TABLE IF NOT EXISTS lp_approvals_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster    TEXT NOT NULL,
    program_id TEXT NOT NULL,
    city_id    TEXT NOT NULL,
    action     TEXT NOT NULL,
    founder    TEXT,
    name       TEXT,
    symbol     TEXT,
    expires_at TEXT,
    signature  TEXT NOT NULL UNIQUE,
    by_wallet  TEXT NOT NULL,
    at         TEXT NOT NULL
  )`,
];
const schemaReady = new WeakMap();
/** Create lp_setup and lp_approvals_log the first time they are needed (safe to repeat); a failure is forgotten so the next call retries. */
export function ensureLpAdminSchema(db) {
  if (!schemaReady.has(db)) {
    schemaReady.set(db, db.batch(TABLES.map((t) => db.prepare(t))).catch((e) => { schemaReady.delete(db); throw e; }));
  }
  return schemaReady.get(db);
}
async function setupRows(db, s) {
  await ensureLpAdminSchema(db);
  const rows = (await db.prepare("SELECT * FROM lp_setup WHERE cluster = ? AND program_id = ?").bind(s.cluster, s.programId).all()).results;
  return Object.fromEntries(rows.map((r) => [r.step, r]));
}
const putSetup = (db, s, step, { address = null, signature = null, wallet, now }) =>
  db.prepare(`INSERT INTO lp_setup (cluster, program_id, step, address, signature, by_wallet, at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (cluster, program_id, step) DO UPDATE SET address = excluded.address, signature = excluded.signature, by_wallet = excluded.by_wallet, at = excluded.at`)
    .bind(s.cluster, s.programId, step, address, signature, wallet, iso(now));
const audit = (db, wallet, action, target, detail, now) =>
  db.prepare("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)").bind(wallet, action, target, detail == null ? null : String(detail).slice(0, 500), iso(now));

/* ---------------------------------------------------------------- decoders of our own accounts not in src/sol/dbc.js */
const DISC = {
  Registry: [47, 174, 110, 246, 184, 182, 252, 218], CityConfig: [14, 136, 110, 28, 46, 68, 178, 115], Approval: [233, 9, 153, 49, 11, 222, 59, 130],
  PartnerMetadata: [68, 68, 130, 19, 16, 209, 98, 156], Position: [170, 188, 143, 228, 122, 64, 247, 208],
};
const hasDisc = (bytes, d) => bytes && bytes.length >= 8 && d.every((x, i) => bytes[i] === x);
const ownedBy = (acc, owner) => Boolean(acc && acc.owner === owner);
const key = (bytes, at) => base58Encode(bytes.subarray(at, at + 32));
/** vicinity_rewards Registry: { admin, pendingAdmin } or null. */
export function decodeRegistry(account, programId) {
  const a = accountBytes(account);
  if (!a || (programId && a.owner && a.owner !== programId) || a.bytes.length < 73 || !hasDisc(a.bytes, DISC.Registry)) return null;
  return { admin: key(a.bytes, 8), pendingAdmin: key(a.bytes, 40) };
}
/** vicinity_rewards CityConfig: the fields forward_holders_fees checks. */
export function decodeCityConfig(account, programId) {
  const a = accountBytes(account);
  if (!a || (programId && a.owner && a.owner !== programId) || a.bytes.length < 8 + 32 * 6 + 3 || !hasDisc(a.bytes, DISC.CityConfig)) return null;
  const b = a.bytes;
  return { authority: key(b, 8), founder: key(b, 72), mint: key(b, 104), rewardMint: key(b, 136), vault: key(b, 168), rewardModel: b[200], founderBps: b[201] | (b[202] << 8) };
}
/** vicinity_launchpad Approval: { cityId, founder, dbcConfig, rentPayer, name, symbol, approvedAt, expiresAt } or null. */
export function decodeApproval(account, programId) {
  const a = accountBytes(account);
  if (!a || (programId && a.owner && a.owner !== programId) || !hasDisc(a.bytes, DISC.Approval)) return null;
  const b = a.bytes;
  try {
    let at = 8;
    const cityId = readU64(b, at); at += 8;
    const founder = key(b, at); at += 32;
    const dbcConfig = key(b, at); at += 32;
    const rentPayer = key(b, at); at += 32;
    const text = () => { const n = readU32(b, at); at += 4; if (n > 64 || at + n > b.length) throw new Error("bad"); const s = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(at, at + n)); at += n; return s; };
    const name = text(), symbol = text();
    if (at + 16 > b.length) return null;
    const approvedAt = readI64(b, at); at += 8;
    const expiresAt = readI64(b, at);
    return { cityId, founder, dbcConfig, rentPayer, name, symbol, approvedAt: Number(approvedAt), expiresAt: Number(expiresAt) };
  } catch { return null; }
}
/** An address lookup table with its authority (bincode LookupTableMeta: authority Option at byte 21, addresses from 56). */
export function decodeTable(account) {
  const a = accountBytes(account);
  if (!a || (a.owner && a.owner !== PROGRAM_IDS.lookupTable) || a.bytes.length < 56 || (a.bytes.length - 56) % 32 !== 0 || readU32(a.bytes, 0) !== 1) return null;
  const addresses = [];
  for (let at = 56; at < a.bytes.length; at += 32) addresses.push(key(a.bytes, at));
  return { deactivated: readU64(a.bytes, 4) !== U64_MAX, authority: a.bytes[21] === 1 ? key(a.bytes, 22) : null, addresses };
}

/* ---------------------------------------------------------------- the price curve against the defaults */
const EXPECTED = fromBase64(EXPECTED_POOL_CONFIG);
const CONFIG_FIELDS = Object.entries(LAYOUT.PoolConfig.fields).filter(([, f]) => Number.isInteger(f.at) && Number.isInteger(f.size)).sort((x, y) => x[1].at - y[1].at);
/**
 * PoolConfig.version, the one byte that may differ: DBC 0.2.1 wrote 0 and DBC 0.2.2 (on mainnet since 16 Oct 2026) writes 1. The
 * live mainnet config (EZVHCg…, made on 12 Oct 2026) is version 0, a config made now is version 1, and DBC 0.2.2 runs both (a
 * version-0 config keeps the original graduation path; with a SOL quote the money is the same to the unit, LAUNCHPAD-DESIGN.md
 * section 17). Any other value is a config nobody has tested and differs as "version".
 */
const VERSION_AT = LAYOUT.PoolConfig.fields.version.at;
const ACCEPTED_VERSIONS = new Set([0, 1]);
const configByteOk = (bytes, i) => (i === VERSION_AT ? ACCEPTED_VERSIONS.has(bytes[i]) : bytes[i] === EXPECTED[i]);
/**
 * Compare a DBC config account with the one Meteora writes for the Vicinity defaults (src/sol/dbc-config-data.js): every byte
 * equal (the transfer-fee fields of DBC 0.2.2 included, all zero: our coins have no transfer fee), except PoolConfig.version,
 * which may be 0 or 1. [] when it matches, else the names of the fields that differ (plain field names of the IDL, e.g.
 * "migration_quote_threshold"). Every check of a price curve against the defaults goes through here (the City coins tab's step 3,
 * its record step and scripts/mainnet-preflight.mjs).
 */
export function configDiff(account) {
  const a = accountBytes(account);
  if (!a || (a.owner && a.owner !== PROGRAM_IDS.dbc)) return ["not a Meteora DBC config"];
  if (a.bytes.length !== EXPECTED.length) return ["size"];
  const bad = (from, to) => { for (let i = from; i < to; i++) if (!configByteOk(a.bytes, i)) return true; return false; };
  if (!bad(0, EXPECTED.length)) return [];
  const out = [];
  for (const [name, f] of CONFIG_FIELDS) {
    if (name.includes("[") && out.includes("curve")) continue;
    if (bad(f.at, f.at + f.size * (f.count || 1))) out.push(name.startsWith("curve[") ? "curve" : name);
  }
  return out.length ? [...new Set(out)] : ["other bytes"];
}
/** The plain-word facts of a config (what the page shows next to the defaults); the fee figures through src/fees.js, from its bytes. */
function configFacts(acc) {
  const c = decodeConfig(acc);
  if (!c) return null;
  const S = feeSchedule(c); // null for a fee that is not flat (our program refuses one): then no fee figure is named
  return {
    quoteMint: c.quoteMint, feeClaimer: c.feeClaimer, leftoverReceiver: c.leftoverReceiver, target: sol(c.migrationQuoteThreshold),
    tradeFeeBps: Number((c.feeNumerator * 10_000n) / 1_000_000_000n), tradeFee: S ? S.curve.text.total : null, launchFee: S ? `${S.launchFeeSol} SOL` : sol(c.poolCreationFee), migratedPoolFeeBps: c.migratedPoolFeeBps,
  };
}

/* ---------------------------------------------------------------- reading the chain */
const ownHashes = new Map(); // "<programData>|<slot>" -> { size, sha256 } (our two programs, for the status; Meteora's: src/programpins.js)
const rentRates = new Map(); // "<cluster>|<rpc>" -> lamports per byte (Solana's rent, read from the cluster once per server)
export const _resetLpAdmin = () => { ownHashes.clear(); rentRates.clear(); _forgetProgramHashes(); };
/**
 * Solana's rent per byte on this cluster (getMinimumBalanceForRentExemption(0) / 128: every account carries 128 bytes of
 * overhead), read once per server; null when the node did not answer (the page then names no number; the simulated SOL change is
 * exact anyway). The rent was cut from 6,960 to 5,080 lamports per byte in 2026, so no number here is hard-coded.
 */
async function rentPerByte(env, s, fetchImpl) {
  const k = `${s.cluster}|${s.rpc}`;
  if (rentRates.has(k)) return rentRates.get(k);
  try {
    const v = Number(await lpRpc(env, "getMinimumBalanceForRentExemption", [0], fetchImpl));
    if (!Number.isSafeInteger(v) || v <= 0 || v % 128 !== 0) return null;
    rentRates.set(k, v / 128);
    return v / 128;
  } catch (e) { console.error("rent read failed", codeOf(e)); return null; }
}
/** "about 0.006 SOL of rent" for an account of `dataBytes` (or for several), or a plain "a little rent" when the rate is unknown. */
const rentWords = (perByte, ...dataBytes) => (perByte ? `about ${sol(dataBytes.reduce((a, n) => a + (128 + n) * perByte, 0))} of rent` : "a little rent");
/** { size, sha256 } of one of OUR programs (the fingerprint the owner compares with the team's), once per deploy slot. */
async function programHash(env, programData, slot, fetchImpl) {
  const k = `${programData}|${slot}`;
  if (ownHashes.has(k)) return ownHashes.get(k);
  const r = await lpRpc(env, "getAccountInfo", [programData, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  const out = await fingerprint(r && r.value); // the same bytes and hash as Meteora's programs get (src/programpins.js)
  if (!out) return null;
  ownHashes.set(k, out);
  if (ownHashes.size > 50) ownHashes.delete(ownHashes.keys().next().value);
  return out;
}
function programInfo(id, acc, pdAddress, pdHead) {
  const out = { id, exists: Boolean(acc), executable: Boolean(acc && acc.executable), upgradeable: false, programData: pdAddress, upgradeAuthority: null, immutable: false, slot: null };
  if (!acc) return out;
  const p = decodeProgramAccount(acc);
  out.upgradeable = Boolean(p && p.programData === pdAddress && acc.owner === PROGRAM_IDS.upgradeableLoader);
  const d = pdHead ? decodeProgramData(pdHead) : null;
  if (out.upgradeable && d) { out.upgradeAuthority = d.upgradeAuthority; out.immutable = d.upgradeAuthority === null; out.slot = d.slot.toString(); }
  return out;
}
/** Every allow-listed config of our program: the LaunchConfig records (canonical ["launch_config", config] only). */
async function launchConfigs(env, s, fetchImpl) {
  const list = await lpRpc(env, "getProgramAccounts", [s.programId, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: LAYOUT.LaunchConfig.size }] }], fetchImpl);
  const rows = Array.isArray(list) ? list : list && Array.isArray(list.value) ? list.value : [];
  const L = launchpadPdas(s.programId), out = [];
  for (const r of rows) {
    const c = decodeLaunchConfig(r && r.account ? { ...r.account, owner: r.account.owner || s.programId } : null, s.programId);
    if (c && (await L.launchConfig(c.dbcConfig)) === r.pubkey) out.push({ ...c, address: r.pubkey });
  }
  return out;
}

/**
 * Everything the tab knows, read in a few calls: { s, wallet, programs: { launchpad, rewards }, launchpad, registry, config,
 * launchConfig, allowList, referral: [{ mint, account, exists }], lookup, partner, squads, setup, vicinityMint, meteora, dbc }.
 * `fresh` and `route` go to programHashes: the builds of steps 3 and 4 read Meteora's deploy slots again (src/programpins.js).
 */
async function readState(env, s, wallet, fetchImpl, { hashes = false, now = Date.now(), fresh = false, route = null } = {}) {
  const setup = await setupRows(env.DB, s);
  const L = launchpadPdas(s.programId), R = IX.rewards(s.rewardsProgramId);
  const allowList = await launchConfigs(env, s, fetchImpl);
  const config = s.dbcConfigs[0] || (setup.config && setup.config.address) || (allowList[0] && allowList[0].dbcConfig) || null;
  const configSource = s.dbcConfigs[0] ? "settings" : setup.config ? "recorded" : allowList[0] ? "allow-list" : null;
  const lookup = s.lookupTable || (setup.lookup && setup.lookup.address) || null;
  const vm = s.cluster === "mainnet" ? activeMint(env) : null;
  const vicinityMint = isSolanaAddress(vm) ? vm : null;
  const multisig = setup.squads && isSolanaAddress(setup.squads.address) ? setup.squads.address : null;
  const [lpPda, regPda, pdLp, pdRw, partnerPda, wsolAta, launchConfigPda] = await Promise.all([
    L.launchpad(), R.registry(), programDataAddress(s.programId), programDataAddress(s.rewardsProgramId), IX.partnerMetadataAddress(DEV), ata(DEV, WSOL),
    config ? L.launchConfig(config) : null,
  ]);
  const want = [s.programId, s.rewardsProgramId, lpPda, regPda, partnerPda, wsolAta, config, launchConfigPda, lookup, multisig, vicinityMint].filter(Boolean);
  const [acc, heads, meteora] = await Promise.all([
    readAccounts(env, want, fetchImpl),
    lpRpc(env, "getMultipleAccounts", [[pdLp, pdRw], { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 45 } }], fetchImpl),
    programHashes(env, fetchImpl, now, { fresh, route }), // Meteora's two programs against the tested builds (never throws)
  ]);
  const head = heads && Array.isArray(heads.value) ? heads.value : [null, null];
  const get = (a) => (a ? acc.get(a) || null : null);
  const programs = { launchpad: programInfo(s.programId, get(s.programId), pdLp, head[0]), rewards: programInfo(s.rewardsProgramId, get(s.rewardsProgramId), pdRw, head[1]) };
  if (hashes) {
    for (const p of Object.values(programs)) {
      if (!p.upgradeable || p.slot === null) continue;
      try { Object.assign(p, await programHash(env, p.programData, p.slot, fetchImpl)); } catch (e) { console.error("program hash read failed", codeOf(e)); }
    }
  }
  // the dev wallet's fee account for $VICINITY (mainnet only), under the mint's own token program
  const referral = [{ mint: WSOL, symbol: "SOL", account: wsolAta, exists: Boolean(get(wsolAta)) }];
  if (vicinityMint) {
    const m = get(vicinityMint);
    const tokenProgram = m && (m.owner === PROGRAM_IDS.token2022 ? PROGRAM_IDS.token2022 : m.owner === PROGRAM_IDS.token ? PROGRAM_IDS.token : null);
    if (tokenProgram) {
      const account = await ata(DEV, vicinityMint, tokenProgram);
      const r = await lpRpc(env, "getAccountInfo", [account, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }], fetchImpl);
      referral.push({ mint: vicinityMint, symbol: "VICINITY", account, exists: Boolean(r && r.value), tokenProgram });
    } else referral.push({ mint: vicinityMint, symbol: "VICINITY", account: null, exists: false, missingMint: true });
  }
  const cfgAcc = get(config);
  // Meteora's bonding-curve program for step 3 (and the record step's price curve), from the same read as the approvals' check
  // (src/programpins.js programHashes, the one fingerprint of Meteora's programs on this server), but compared, on EVERY cluster, with
  // the build the expected curve bytes came from (DBC_PROGRAM_SHA256, src/sol/dbc-config-data.js; on mainnet it is also the pin,
  // test/program-pins.test.js keeps them equal): the curve this tab creates is checked byte for byte against what that build writes,
  // so another build is caught BEFORE the owner spends anything (the devnet rehearsal: devnet's newer build wrote PoolConfig.version 1
  // before any pin knew of it, and the curve it made was refused at record time). Since PoolConfig.version 0 and 1 are both accepted,
  // the fingerprint is what tells builds apart: sha256 null when the program could not be read clearly, and then step 3 waits too
  // (curveRefusal) and the record step refuses a price curve (dbc_unreadable), never built or recorded blind.
  const dbc = { ...(meteora.dbc || { programData: null, slot: null, sha256: null }), pinned: DBC_PROGRAM_SHA256 };
  const table = lookup ? decodeTable(get(lookup)) : null;
  const ms = multisig ? await checkMultisig(multisig, get(multisig)) : null;
  const rent = await rentPerByte(env, s, fetchImpl);
  return {
    s, wallet, setup, programs, allowList, vicinityMint, dbc, meteora, rent,
    launchpad: decodeLaunchpad(get(lpPda), s.programId), launchpadAddress: lpPda,
    registry: decodeRegistry(get(regPda), s.rewardsProgramId), registryAddress: regPda,
    config: config ? { address: config, source: configSource, exists: Boolean(cfgAcc), diff: cfgAcc ? configDiff(cfgAcc) : null, facts: cfgAcc ? configFacts(cfgAcc) : null } : null,
    launchConfig: launchConfigPda ? { address: launchConfigPda, ...(decodeLaunchConfig(get(launchConfigPda), s.programId) || { missing: true }) } : null,
    referral,
    lookup: lookup ? { address: lookup, source: s.lookupTable ? "settings" : "recorded", exists: Boolean(get(lookup)), ...(table || {}) } : null,
    partner: { address: partnerPda, exists: ownedBy(get(partnerPda), PROGRAM_IDS.dbc) && hasDisc(accountBytes(get(partnerPda)).bytes, DISC.PartnerMetadata) },
    squads: ms ? { ...ms, recordedVault: setup.handoff ? setup.handoff.address : null } : null,
  };
}

/* ---------------------------------------------------------------- the setup steps */
const step = (id, state, reason, extra = {}) => ({ id, n: STEPS.indexOf(id) + 1, title: TITLE[id], state, reason, ...extra });
const notYours = (what, who, wallet) => `${what} is ${who}, not the wallet you are signed in with (${wallet}).`;
/** Expected addresses of the speed table for this state. */
async function tableWant(st) {
  if (!st.config) return null;
  return IX.lookupTableAddresses({ programId: st.s.programId, rewardsProgramId: st.s.rewardsProgramId, dbcConfigs: [st.config.address] });
}
/**
 * Steps 1-7 from the chain: each { id, n, title, state: done | ready | blocked, reason (plain words), ... }. "ready" means the
 * session wallet can sign it now; "blocked" says why not. Order matters: 2 needs 1 (after the hand-over step 1 can never run), and
 * 3-7 come after 2 so the upgrade authority stays in the wallet for minutes only.
 */
export async function setupSteps(st) {
  const { s, wallet, programs: P } = st;
  const out = [];
  const deployed = (p, name) => (!p.exists ? `The ${name} program is not on Solana ${s.cluster} at ${p.id} yet. Deploy it from your Mac first.`
    : !p.upgradeable ? `The ${name} program at ${p.id} was not deployed with the upgradeable loader, so it cannot be set up here.`
      : !p.executable ? `The ${name} program at ${p.id} is not executable.` : null);
  const authorityOf = (p, name) => (p.immutable ? `The ${name} program has no upgrade authority (it is final), so this step cannot run.`
    : p.upgradeAuthority !== wallet ? notYours(`The ${name} program's upgrade authority`, p.upgradeAuthority, wallet) + " Move it to your wallet first: in the Squads app with a \"Change authority\" transaction when your Squads controls the program, or on your Mac with set-upgrade-authority (the guide's step 10)." : null);

  // 1 start: init_registry + init_launchpad (a half that exists is skipped)
  const haveLp = Boolean(st.launchpad), haveReg = Boolean(st.registry);
  let s1;
  if (haveLp && haveReg) s1 = step("start", "done", "The launchpad and the rewards registry are running.");
  else {
    const why = deployed(P.rewards, "rewards") || deployed(P.launchpad, "launchpad")
      || (!haveReg ? authorityOf(P.rewards, "rewards") : null) || (!haveLp ? authorityOf(P.launchpad, "launchpad") : null);
    const halves = [!haveReg ? "the rewards registry" : null, !haveLp ? "the launchpad" : null].filter(Boolean);
    s1 = why ? step("start", "blocked", why) : step("start", "ready", `Starts ${halves.join(" and ")}${haveReg ? " (the rewards registry exists already)" : haveLp ? " (the launchpad exists already)" : ""}. Your wallet becomes the launchpad admin and the registry admin.`, { builds: halves });
  }
  out.push(s1);

  // 2 handoff: both upgrade authorities to the Squads vault
  const vault = st.squads && st.squads.ok ? st.squads.vault : null;
  const recorded = st.setup.handoff ? st.setup.handoff.address : null;
  const both = (a) => P.launchpad.upgradeAuthority === a && P.rewards.upgradeAuthority === a;
  let s2;
  if (recorded && both(recorded) && (!vault || vault === recorded)) s2 = step("handoff", "done", `Both programs are controlled by your Squads vault ${recorded}.`, { vault: recorded, multisig: st.squads ? st.squads.multisig : null });
  else if (s1.state !== "done") s2 = step("handoff", "blocked", "Do step 1 first: once the programs belong to your Squads, step 1 can never run.");
  else if (P.launchpad.immutable || P.rewards.immutable) s2 = step("handoff", "blocked", "A program has no upgrade authority (it is final); there is nothing to hand over.");
  else if ([P.launchpad.upgradeAuthority, P.rewards.upgradeAuthority].every((a) => a === wallet || (recorded && a === recorded))) s2 = step("handoff", "ready", "Paste your Squads multisig account; the page shows its vault for you to compare with the Squads app, then one signature hands both programs to it.");
  else s2 = step("handoff", "blocked", `The programs' upgrade authorities are ${P.launchpad.upgradeAuthority} (launchpad) and ${P.rewards.upgradeAuthority} (rewards), not your wallet. If that is already your Squads vault, paste your multisig account and press "Check" to record it.`, { adoptable: true });
  out.push(s2);
  const after2 = (id, ok, readyText, extra = {}) => (s2.state !== "done" ? step(id, "blocked", "Do step 2 first (hand the programs to your Squads).") : ok ? step(id, "ready", readyText, extra) : null);

  // 3 config
  const c = st.config;
  let s3;
  // the figures in the sentence are the config's own (configFacts: decoded from its bytes, the fee through src/fees.js), never a literal
  if (c && c.exists && c.diff && c.diff.length === 0) s3 = step("config", "done", `The price curve ${c.address} matches Vicinity's defaults (${c.facts && c.facts.tradeFee ? `${c.facts.target} target, ${c.facts.tradeFee} fee, ${c.facts.launchFee} launch fee, ` : ""}fees to ${short(DEV)}).`, { address: c.address });
  else if (c && c.exists && c.source === "settings") s3 = step("config", "done", `The price curve ${c.address} comes from the settings. It differs from the mainnet defaults in: ${c.diff.join(", ")}.`, { address: c.address, note: true });
  else if (c && c.exists) s3 = step("config", "blocked", `The price curve ${c.address} differs from Vicinity's defaults in: ${c.diff.join(", ")}. Tell the team; do not allow it.`, { address: c.address });
  else if (s2.state === "done" && curveRefusal(st.dbc)) s3 = step("config", "blocked", curveRefusal(st.dbc).message, { dbc: { sha256: st.dbc.sha256, pinned: st.dbc.pinned, slot: st.dbc.slot } });
  else s3 = after2("config", true, `Creates the Meteora price curve with a one-time key made in this browser (${rentWords(st.rent, LAYOUT.PoolConfig.size)}).${c && c.source === "recorded" ? ` The recorded curve ${c.address} is not on chain, so a new one is made.` : ""}`, { ephemeral: 1 });
  out.push(s3);

  // 4 allow
  let s4;
  if (st.launchConfig && !st.launchConfig.missing) s4 = st.launchConfig.enabled ? step("allow", "done", `The launchpad allows the price curve (allow-list entry ${st.launchConfig.address}).`) : step("allow", "blocked", "The price curve is allowed but switched off on chain. Tell the team.");
  else if (s3.state !== "done") s4 = step("allow", "blocked", "Do step 3 first (create the price curve).");
  else if (!st.launchpad || st.launchpad.admin !== wallet) s4 = step("allow", "blocked", notYours("The launchpad admin", st.launchpad ? st.launchpad.admin : "not set", wallet));
  // a Meteora program that is not the tested build, or that could not be read clearly: no new allow-list entry
  else if (programRefusal(st.meteora)) s4 = step("allow", "blocked", programRefusal(st.meteora, "This step and approvals").message, { meteora: programSummary(st.meteora) });
  else s4 = after2("allow", true, "Allows the price curve on the launchpad. The program checks every Vicinity rule again (fees to the dev wallet, locked liquidity, immutable names).");
  out.push(s4);

  // 5 referral (fee) accounts
  const missing = st.referral.filter((r) => !r.exists && r.account);
  const noMint = st.referral.find((r) => r.missingMint);
  let s5;
  if (!missing.length) s5 = step("referral", "done", `The dev wallet's fee account${st.referral.length > 1 ? "s exist" : " exists"}: ${st.referral.filter((r) => r.account).map((r) => `${r.symbol} ${r.account}`).join("; ")}.${noMint ? " The $VICINITY contract could not be read, so its account is missing." : ""}${!st.vicinityMint && s.cluster === "mainnet" ? " ($VICINITY's contract is not set, so only the SOL account is needed.)" : ""}`);
  else s5 = after2("referral", true, `Creates the dev wallet's fee account${missing.length > 1 ? "s" : ""} for ${missing.map((r) => r.symbol).join(" and ")} (every trade on the site pays its referral fee there; ${rentWords(st.rent, ...missing.map(() => TOKEN_ACCOUNT_BYTES))}, which anyone may pay).`, { missing: missing.map((r) => r.symbol) });
  out.push(s5);

  // 6 lookup (speed) table
  const want = await tableWant(st);
  const t = st.lookup;
  let s6;
  if (!want) s6 = step("lookup", "blocked", "Do step 3 first: the speed table holds the price curve's address.");
  else if (t && t.exists && !t.addresses) s6 = step("lookup", "blocked", `${t.address} is not an address lookup table. Tell the team.`);
  else if (t && t.exists && t.deactivated) s6 = step("lookup", "blocked", `The speed table ${t.address} is switched off (deactivated). Tell the team.`);
  else if (t && t.exists) {
    const lack = want.filter((a) => !t.addresses.includes(a));
    if (!lack.length) s6 = step("lookup", "done", `The speed table ${t.address} holds all ${want.length} shared addresses.`, { address: t.address });
    else if (t.authority !== wallet) s6 = step("lookup", "blocked", `${notYours(`The speed table's authority`, t.authority, wallet)} It misses ${lack.length} address${lack.length === 1 ? "" : "es"}.`);
    else s6 = after2("lookup", true, `Adds the ${lack.length} missing address${lack.length === 1 ? "" : "es"} to the speed table ${t.address}.`, { extend: lack.length, address: t.address });
  } else if (t && t.source === "settings") s6 = step("lookup", "blocked", `The speed table in the settings (${t.address}) is not on chain. Tell the team.`);
  else s6 = after2("lookup", true, `Creates the speed table (an address lookup table, ${rentWords(st.rent, LOOKUP_TABLE_META_BYTES + 32 * want.length)}) and fills it with the ${want.length} addresses every city-coin transaction shares, so a launch with a first buy fits in one transaction.`);
  out.push(s6 || step("lookup", "blocked", "Do step 2 first (hand the programs to your Squads)."));

  // 7 partner metadata (only the dev wallet can sign)
  let s7;
  if (st.partner.exists) s7 = step("partner", "done", `Meteora names the dev wallet's configs "Vicinity" (${st.partner.address}).`);
  else if (wallet !== DEV) s7 = step("partner", "blocked", `Only the dev wallet ${DEV} can sign this (it is Meteora's fee claimer for our price curve). Sign in to this page with it to do this step.`);
  else s7 = after2("partner", true, "Gives Meteora and Jupiter Vicinity's name, website and logo for our price curve (a little rent, once).");
  out.push(s7);
  return out;
}

/** Problems that are not one step's: wrong settings or a launchpad started differently. */
function problemsOf(st) {
  const p = [];
  if (st.launchpad && st.launchpad.rewardsProgram !== st.s.rewardsProgramId) p.push(`The launchpad was started with the rewards program ${st.launchpad.rewardsProgram}, but the setting LAUNCHPAD_REWARDS_PROGRAM_ID is ${st.s.rewardsProgramId}. Tell the team before going on.`);
  if (st.launchpad && st.launchpad.admin !== st.wallet) p.push(`The launchpad admin is ${st.launchpad.admin}, not the wallet you are signed in with: approving cities needs the admin's wallet.`);
  if (st.registry && st.registry.admin !== st.wallet) p.push(`The rewards registry admin is ${st.registry.admin}, not the wallet you are signed in with: setting up holder rewards needs it.`);
  if (st.config && st.s.dbcConfigs.length && st.setup.config && st.setup.config.address !== st.s.dbcConfigs[0]) p.push(`The price curve in the settings (${st.s.dbcConfigs[0]}) is not the one created here (${st.setup.config.address}).`);
  if (st.lookup && st.s.lookupTable && st.setup.lookup && st.setup.lookup.address !== st.s.lookupTable) p.push(`The speed table in the settings (${st.s.lookupTable}) is not the one created here (${st.setup.lookup.address}).`);
  if (st.launchpad && st.launchpad.launchesPaused) p.push("Launches are paused: approved founders cannot launch until you resume them.");
  return p;
}

/* ---------------------------------------------------------------- building a step */
/** The most recent produced slot at least 8 behind the finalized tip (the lookup-table program accepts only slots in SlotHashes). */
async function recentSlot(env, fetchImpl) {
  const tip = Number(await lpRpc(env, "getSlot", [{ commitment: "finalized" }], fetchImpl));
  if (!Number.isSafeInteger(tip) || tip < 100) throw new Error("rpc_bad_answer");
  try {
    const blocks = await lpRpc(env, "getBlocks", [tip - 72, tip - 8, { commitment: "finalized" }], fetchImpl);
    if (Array.isArray(blocks) && blocks.length) return Number(blocks[blocks.length - 1]);
  } catch (e) { console.error("getBlocks failed", codeOf(e)); }
  return tip - 8;
}
/** Does this instruction list fit one transaction (with the two compute-budget instructions buildTx adds)? */
function fits(payer, instructions, signers = 1) {
  try {
    const budget = [{ programAddress: PROGRAM_IDS.computeBudget, accounts: [], data: new Uint8Array(5) }, { programAddress: PROGRAM_IDS.computeBudget, accounts: [], data: new Uint8Array(9) }];
    const m = compileLegacy({ payer, instructions: [...budget, ...instructions], blockhash: PROGRAM_IDS.system });
    return wrapUnsigned(m, signers).length <= MAX_TX_BYTES;
  } catch { return false; }
}
/** Extend instructions for `addresses` in chunks of 20, as many as fit next to `before` in one transaction. */
function extendsThatFit(payer, table, addresses, before = []) {
  const out = [];
  for (let i = 0; i < addresses.length; i += IX.EXTEND_CHUNK) {
    const next = IX.extendLookupTable({ table, authority: payer, payer, addresses: addresses.slice(i, i + IX.EXTEND_CHUNK) });
    if (!fits(payer, [...before, ...out, next])) break;
    out.push(next);
  }
  return out;
}

/**
 * Step 3 against Meteora's bonding-curve program (readState's `dbc`): null when it is the build the expected curve bytes came from;
 * else what the step says and its build answers: 409 program_changed (another build), or 503 program_check_unavailable when it could
 * not be read clearly (src/programpins.js: never "ok" by default). Step 4 does the same with programRefusal on both programs.
 * Step 3 depends on DBC alone, by design: the curve is DBC's account, so DAMM v2 changed or unreadable does not hold it (programHashes
 * fills in a program's fingerprint only when that program's own reading was clear, also in an answer that is unavailable overall).
 */
const CURVE_UNREADABLE = "Meteora's bonding-curve program could not be read, so its fingerprint is unknown and this step waits (a price curve is made only on the build the team checked). Nothing was spent; try again in a minute.";
function curveRefusal(dbc) {
  if (!dbc || !dbc.sha256) return { status: 503, error: "program_check_unavailable", which: [], message: CURVE_UNREADABLE };
  if (dbc.sha256 === dbc.pinned) return null;
  return { status: 409, error: "program_changed", which: ["dbc"], message: `Meteora has updated its bonding-curve program since the team checked it (its fingerprint is now ${dbc.sha256.slice(0, 12)}…, the checked one ${dbc.pinned.slice(0, 12)}…). A price curve made now may differ from the tested one, so this step waits. Nothing was spent; tell the team, who re-check Meteora's new program first.` };
}

const refuse = (st, id) => {
  const x = st.find((y) => y.id === id);
  return err(x && x.state === "done" ? "already_done" : "step_not_ready", x ? (x.state === "done" ? `Already done: ${x.reason}` : x.reason) : "Unknown step.", 409, { step: id, state: x ? x.state : null });
};

async function buildStep(env, ctx, body, fetchImpl, now, route = null) {
  const s = lpSetup(env), wallet = ctx.wallet;
  const id = body.step, params = body.params && typeof body.params === "object" ? body.params : {};
  if (!STEPS.includes(id)) return err("bad_step", "Unknown setup step.", 400);
  const eph = Array.isArray(body.ephemeral) ? body.ephemeral : [];
  if (!eph.every(isSolanaAddress)) return err("bad_signers", "A one-time key is not a Solana address.", 400);
  // steps 3 (the price curve) and 4 (the allow-list) are built on Meteora's programs read for this request (the deploy slots again,
  // never the pages' ten-minute answer), once, and refused first when they are not the tested builds or could not be read clearly
  const gated = id === "config" || id === "allow";
  const st = await readState(env, s, wallet, fetchImpl, gated ? { now, fresh: true, route } : { now });
  const pr = id === "config" ? curveRefusal(st.dbc) : id === "allow" ? programRefusal(st.meteora, "This step and approvals") : null;
  if (pr) return err(pr.error, pr.message, pr.status, { step: id, which: pr.which });
  const steps = await setupSteps(st);
  const me = steps.find((x) => x.id === id);
  const labels = {};
  let instructions = [], extraSigners = [], watch = [];
  const record = { step: id, params: {} }; // what the page sends to /record once the transaction is confirmed
  if (id === "handoff") {
    // the multisig the owner pasted: checked again here, and the vault the page showed must be the one derived now
    const ms = isSolanaAddress(params.multisig) ? await checkMultisig(params.multisig, (await readAccounts(env, [params.multisig], fetchImpl)).get(params.multisig) || null) : await checkMultisig(params.multisig, null);
    if (!ms.ok) return err(ms.error, ms.message, 409);
    if (params.vault !== ms.vault) return err("vault_mismatch", "The vault you confirmed is not this multisig's vault. Press Check again and compare the vault with the Squads app.", 409);
    if (ms.vault === wallet) return err("vault_is_wallet", "That vault is your own wallet. Use a Squads multisig vault.", 409);
    // ready when step 1 is done and each program is either still yours or already this vault's (a hand-over half done by hand)
    if (steps[0].state !== "done") return refuse(steps, id);
    if (me.state === "done" && me.vault === ms.vault) return refuse(steps, id);
    for (const [name, p] of [["launchpad", st.programs.launchpad], ["rewards", st.programs.rewards]]) {
      if (p.upgradeAuthority === ms.vault) continue;
      if (p.upgradeAuthority !== wallet) return err("not_upgrade_authority", notYours(`The ${name} program's upgrade authority`, p.upgradeAuthority, wallet), 409);
      instructions.push(await IX.setUpgradeAuthority({ programId: p.id, currentAuthority: wallet, newAuthority: ms.vault }));
      labels[p.programData] = `the ${name} program's data (holds its upgrade authority)`;
    }
    labels[ms.vault] = "your Squads vault (the new upgrade authority)";
    record.params = { multisig: ms.multisig };
    if (!instructions.length) return err("already_done", "Both programs already belong to this vault.", 409);
  } else {
    if (me.state !== "ready") return refuse(steps, id);
    if (id === "start") {
      if (!st.registry) instructions.push(await IX.initRegistry({ rewardsProgramId: s.rewardsProgramId, payer: wallet, upgradeAuthority: wallet, admin: wallet }));
      if (!st.launchpad) instructions.push(await IX.initLaunchpad({ programId: s.programId, rewardsProgramId: s.rewardsProgramId, payer: wallet, admin: wallet, upgradeAuthority: wallet }));
      labels[st.programs.launchpad.programData] = "the launchpad program's data (its upgrade authority must be you)";
      labels[st.programs.rewards.programData] = "the rewards program's data (its upgrade authority must be you)";
      labels[st.launchpadAddress] = "the launchpad's settings (new)";
      labels[st.registryAddress] = "the rewards registry (new)";
    } else if (id === "config") {
      if (eph.length !== 1) return err("bad_signers", "This step needs exactly one one-time key made in the browser.", 400);
      const [k] = eph;
      if ((await readAccounts(env, [k], fetchImpl)).get(k)) return err("bad_signers", "The one-time key is not fresh. Start again.", 409);
      instructions.push(await IX.createConfig({ config: k, payer: wallet }));
      extraSigners = [k];
      record.params = { address: k };
      labels[k] = "the new price curve (a one-time key made in this browser)";
      labels[DEV] = "Vicinity dev wallet (fee claimer and leftover receiver)";
    } else if (id === "allow") {
      instructions.push(await IX.addLaunchConfig({ programId: s.programId, admin: wallet, payer: wallet, dbcConfig: st.config.address }));
      labels[st.config.address] = "the price curve";
    } else if (id === "referral") {
      for (const r of st.referral.filter((x) => !x.exists && x.account)) {
        instructions.push(await createAtaIdempotent({ payer: wallet, owner: DEV, mint: r.mint, tokenProgram: r.tokenProgram || PROGRAM_IDS.token }));
        labels[r.account] = `the dev wallet's ${r.symbol} fee account (new)`;
      }
    } else if (id === "lookup") {
      const want = await tableWant(st);
      if (st.lookup && st.lookup.exists) {
        const lack = want.filter((a) => !st.lookup.addresses.includes(a));
        instructions = extendsThatFit(wallet, st.lookup.address, lack);
        labels[st.lookup.address] = "the speed table";
        record.params = { address: st.lookup.address };
      } else {
        let slot;
        try { slot = await recentSlot(env, fetchImpl); } catch (e) { console.error("recent slot failed", codeOf(e)); return respond({ ok: false, error: "rpc_unavailable" }); }
        const c = await IX.createLookupTable({ authority: wallet, payer: wallet, recentSlot: slot });
        instructions = [c.ix, ...extendsThatFit(wallet, c.table, want, [c.ix])];
        labels[c.table] = "the new speed table";
        watch = [c.table];
        record.params = { address: c.table };
      }
      if (!instructions.length) return err("tx_too_large", "Nothing fits in one transaction. Tell the team.", 409);
    } else if (id === "partner") {
      instructions.push(await IX.createPartnerMetadata({ payer: wallet, feeClaimer: wallet }));
      labels[await IX.partnerMetadataAddress(wallet)] = "Vicinity's partner entry on Meteora (new)";
    }
  }
  const r = await buildTx(env, { payer: wallet, instructions, extraSigners, labels, watch }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: id, record });
  return respond(r);
}

/* ---------------------------------------------------------------- recording what landed */
/** The transaction behind a signature, confirmed and successful, paid by `wallet`: its account keys, or an error answer. */
async function confirmedTx(env, signature, wallet, fetchImpl) {
  if (!SIG_RE.test(String(signature || ""))) return { error: err("bad_signature", "That is not a transaction signature.", 400) };
  let st, tx;
  try {
    st = await lpRpc(env, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }], fetchImpl);
    tx = await lpRpc(env, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], fetchImpl);
  } catch (e) { console.error("record read failed", codeOf(e)); return { error: respond({ ok: false, error: "rpc_unavailable" }) }; }
  const s0 = st && Array.isArray(st.value) ? st.value[0] : null;
  if (!s0 || !["confirmed", "finalized"].includes(s0.confirmationStatus)) return { error: err("not_confirmed", "The network has not confirmed this transaction yet. Wait a few seconds and press Record again.") };
  if (s0.err || !tx || (tx.meta && tx.meta.err)) return { error: err("failed", "This transaction failed on the blockchain, so nothing was recorded.") };
  const msg = tx.transaction && tx.transaction.message;
  const keys = msg && Array.isArray(msg.accountKeys) ? msg.accountKeys.map((k) => (typeof k === "string" ? k : k && k.pubkey)) : [];
  const loaded = tx.meta && tx.meta.loadedAddresses ? [...(tx.meta.loadedAddresses.writable || []), ...(tx.meta.loadedAddresses.readonly || [])] : [];
  if (keys[0] !== wallet) return { error: err("not_yours", "This transaction was not paid by the wallet you are signed in with.", 409) };
  return { keys: new Set([...keys, ...loaded]) };
}

async function recordStep(env, ctx, body, fetchImpl, now, route = null) {
  const s = lpSetup(env), wallet = ctx.wallet, db = env.DB;
  const id = body.step, params = body.params && typeof body.params === "object" ? body.params : {};
  const PER_CITY = ["approve", "revoke", "initCity", "collect", "forward", "platform", "pause"];
  if (!STEPS.includes(id) && !PER_CITY.includes(id)) return err("bad_step", "Unknown step.", 400);
  // a hand-over done earlier (or by hand): recorded without a transaction once the chain shows both programs under the vault
  const adopt = id === "handoff" && (body.signature === null || body.signature === undefined || body.signature === "");
  let tx = null;
  if (!adopt) {
    tx = await confirmedTx(env, body.signature, wallet, fetchImpl);
    if (tx.error) return tx.error;
  }
  const signature = adopt ? null : body.signature;
  // a price curve is recorded only on Meteora's bonding-curve program read for this request (the deploy slot again, like the builds
  // of steps 3 and 4, never the pages' ten-minute answer): see the "config" case
  const st = await readState(env, s, wallet, fetchImpl, id === "config" ? { now, fresh: true, route } : { now });
  const writes = [];
  const done = (msg, extra = {}) => json({ ok: true, step: id, message: msg, ...extra }, 200, { "Cache-Control": "no-store" });
  switch (id) {
    case "start": {
      if (!st.launchpad || !st.registry) return err("not_done", "The chain does not show the launchpad and the registry yet. Wait a few seconds and press Record again.");
      writes.push(putSetup(db, s, "start", { address: st.launchpadAddress, signature, wallet, now }));
      break;
    }
    case "handoff": {
      const ms = await checkMultisig(params.multisig, isSolanaAddress(params.multisig) ? (await readAccounts(env, [params.multisig], fetchImpl)).get(params.multisig) || null : null);
      if (!ms.ok) return err(ms.error, ms.message);
      if (!(st.programs.launchpad.upgradeAuthority === ms.vault && st.programs.rewards.upgradeAuthority === ms.vault)) return err("not_done", `The chain does not show both programs under the vault ${ms.vault} yet.`);
      if (tx && !tx.keys.has(ms.vault)) return err("wrong_transaction", "This transaction did not name your Squads vault.");
      writes.push(putSetup(db, s, "squads", { address: ms.multisig, signature: null, wallet, now }), putSetup(db, s, "handoff", { address: ms.vault, signature, wallet, now }));
      break;
    }
    case "config": {
      const a = params.address;
      if (!isSolanaAddress(a) || !tx.keys.has(a)) return err("wrong_transaction", "This transaction did not create that price curve.");
      const acc = (await readAccounts(env, [a], fetchImpl)).get(a) || null;
      const diff = acc ? configDiff(acc) : ["missing"];
      if (diff.length) return err("config_differs", `The price curve ${a} ${acc ? `differs from Vicinity's defaults in: ${diff.join(", ")}` : "is not on chain yet"}. It was not recorded.`);
      // the bytes say "version 0 or 1", not which build wrote them: the program that made it must be the one the team checked
      // (readState's `dbc`, read fresh above through src/programpins.js; sha256 null when it could not be read clearly)
      const fp = st.dbc;
      if (!fp.sha256) return err("dbc_unreadable", `Meteora's bonding-curve program could not be read, so the price curve ${a} was not recorded. Press Record again in a minute.`);
      if (fp.sha256 !== fp.pinned) return err("dbc_changed", `Meteora has updated its bonding-curve program since the team checked it (its fingerprint is now ${fp.sha256.slice(0, 12)}…, the checked one ${fp.pinned.slice(0, 12)}…), so the price curve ${a} was not recorded. Tell the team, who re-check Meteora's new program first.`);
      writes.push(putSetup(db, s, "config", { address: a, signature, wallet, now }));
      break;
    }
    case "allow": {
      if (!st.launchConfig || st.launchConfig.missing || !st.launchConfig.enabled) return err("not_done", "The chain does not show the allow-list entry yet.");
      writes.push(putSetup(db, s, "allow", { address: st.launchConfig.address, signature, wallet, now }));
      break;
    }
    case "referral": {
      if (st.referral.some((r) => r.account && !r.exists)) return err("not_done", "The chain does not show every fee account yet.");
      writes.push(putSetup(db, s, "referral", { address: st.referral[0].account, signature, wallet, now }));
      break;
    }
    case "lookup": {
      const a = params.address || (st.lookup && st.lookup.address);
      if (!isSolanaAddress(a) || !tx.keys.has(a)) return err("wrong_transaction", "This transaction did not touch that speed table.");
      const t = decodeTable((await readAccounts(env, [a], fetchImpl)).get(a) || null);
      if (!t || t.authority !== wallet) return err("not_done", "The chain does not show that speed table (with your wallet as its authority) yet.");
      const rows = st.setup;
      if (rows.lookup && rows.lookup.address === a) {
        const n = Object.keys(rows).filter((k) => k.startsWith("lookup_extend_")).length + 1;
        writes.push(putSetup(db, s, `lookup_extend_${n}`, { address: a, signature, wallet, now }));
      } else writes.push(putSetup(db, s, "lookup", { address: a, signature, wallet, now }));
      break;
    }
    case "partner": {
      if (!st.partner.exists) return err("not_done", "The chain does not show the partner entry yet.");
      writes.push(putSetup(db, s, "partner", { address: st.partner.address, signature, wallet, now }));
      break;
    }
    case "approve": case "revoke": {
      const cityId = cityIdOf(params.cityId);
      if (!cityId) return err("bad_city", "Unknown city.", 400);
      const approvalAddr = await launchpadPdas(s.programId).approval(cityId);
      if (!tx.keys.has(approvalAddr)) return err("wrong_transaction", "This transaction did not touch that city's approval.");
      const ap = decodeApproval((await readAccounts(env, [approvalAddr], fetchImpl)).get(approvalAddr) || null, s.programId);
      if (id === "approve" && !ap) return err("not_done", "The chain does not show the approval yet.");
      if (id === "revoke" && ap) return err("not_done", "The chain still shows the approval.");
      writes.push(db.prepare(`INSERT OR IGNORE INTO lp_approvals_log (cluster, program_id, city_id, action, founder, name, symbol, expires_at, signature, by_wallet, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(s.cluster, s.programId, String(cityId), id, ap ? ap.founder : null, ap ? ap.name : null, ap ? ap.symbol : null,
        ap ? iso(ap.expiresAt * 1000) : null, signature, wallet, iso(now)));
      break;
    }
    default: break; // initCity, collect, forward, platform, pause: the audit line only (the chain is the record)
  }
  await ensureLpAdminSchema(db);
  writes.push(audit(db, wallet, `lp/${id}`, params.cityId ? `city:${params.cityId}` : id, `${s.cluster} ${signature || "adopted"}`, now));
  await db.batch(writes);
  return done(adopt ? "Recorded from the chain." : "Recorded.", { signature });
}

/* ---------------------------------------------------------------- the summary for the team (PLAN C5) */
async function summary(env, ctx, fetchImpl, now) {
  const s = lpSetup(env);
  const st = await readState(env, s, ctx.wallet, fetchImpl, { now });
  const r = st.setup;
  const sig = (k) => (r[k] ? r[k].signature : null);
  const out = {
    cluster: s.cluster, launchpadProgram: s.programId, rewardsProgram: s.rewardsProgramId,
    squadsMultisig: r.squads ? r.squads.address : null, squadsVault: r.handoff ? r.handoff.address : null,
    admin: st.launchpad ? st.launchpad.admin : null, registryAdmin: st.registry ? st.registry.admin : null,
    dbcConfig: st.config ? st.config.address : null, launchConfig: st.launchConfig && !st.launchConfig.missing ? st.launchConfig.address : null,
    lookupTable: st.lookup && st.lookup.exists ? st.lookup.address : null,
    referralAccounts: { wsol: st.referral[0].exists ? st.referral[0].account : null, vicinity: st.referral[1] && st.referral[1].exists ? st.referral[1].account : null },
    partnerMetadata: st.partner.exists ? st.partner.address : null,
    signatures: {
      init: sig("start"), handoff: sig("handoff"), config: sig("config"), allow: sig("allow"), referral: sig("referral"), lookupCreate: sig("lookup"),
      lookupExtend: Object.keys(r).filter((k) => k.startsWith("lookup_extend_")).sort((a, b) => Number(a.slice(14)) - Number(b.slice(14))).map((k) => r[k].signature),
      partner: sig("partner"),
    },
  };
  const steps = await setupSteps(st);
  return json({ ok: true, summary: out, complete: steps.every((x) => x.state === "done"), steps: steps.map((x) => ({ id: x.id, state: x.state })) }, 200, { "Cache-Control": "no-store" });
}

/* ---------------------------------------------------------------- per city: candidates, approve, revoke */
const cityIdOf = (v) => (typeof v === "string" || typeof v === "number") && /^\d{1,19}$/.test(String(v)) && BigInt(v) > 0n && BigInt(v) < U64_MAX ? BigInt(v) : null;
// Invisible characters: every Unicode default-ignorable code point and the other format characters, then blank characters:
// spaces other than U+0020, line and paragraph separators, the braille blank and the musical null notehead. Security review FA-1:
// "Paris" followed by a Hangul filler looked exactly like "Paris" and would have been written into the coin's permanent name.
const FORMAT_CHARS = [[0xad, 0xad], [0x34f, 0x34f], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a], [0xe0000, 0xe0fff]];
const BLANK_CHARS = [[0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x2800, 0x2800],
  [0x3000, 0x3000], [0x1d159, 0x1d159]];
/**
 * A coin name the website will prepare an approval for: 1 to 32 UTF-8 bytes (the program's limit), no control, invisible or
 * blank character, and U+0020 only as a single space between two characters. The vicinity_launchpad program itself checks less
 * (controls and some format characters), so this check is what keeps look-alike names out.
 */
export function nameProblem(name) {
  const n = typeof name === "string" ? name : "";
  const bytes = new TextEncoder().encode(n).length;
  if (!bytes) return "The coin has no name.";
  if (bytes > 32) return `The coin's name is ${bytes} bytes long; the most is 32 (accents and other non-English letters count 2 or more). The founder must shorten it.`;
  for (const ch of n) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || FORMAT_CHARS.some(([lo, hi]) => c >= lo && c <= hi) || BLANK_CHARS.some(([lo, hi]) => c >= lo && c <= hi)) {
      return "The coin's name has an invisible, blank or control character. The founder must retype it.";
    }
  }
  if (n.startsWith(" ") || n.endsWith(" ") || n.includes("  ")) return "The coin's name starts or ends with a space, or has two spaces in a row. The founder must retype it.";
  return null;
}
const symbolOk = (t) => typeof t === "string" && /^[A-Z0-9]{1,10}$/.test(t);

/** Every city with a coin design: its founder, name, ticker, pair and what keeps it from being approved now. */
async function candidateList(env, ctx, fetchImpl, now) {
  const s = lpSetup(env), db = env.DB;
  await ensureLogoSchema(db);
  const rows = (await db.prepare(`SELECT cc.city_id, cc.city_name, cc.country, cc.name, cc.pitch, cc.media_id, cc.approved_media_id, cc.logo_status, cc.updated_at, cc.pair, cc.mint, cc.pending_mint, cc.seat_id,
      s.id AS live_seat, s.status AS seat_status, s.wallet AS seat_wallet, u.wallet AS user_wallet, u.handle
    FROM city_coins cc
    LEFT JOIN seats s ON s.city_id = cc.city_id AND s.status IN ('provisional', 'active', 'grace', 'steward')
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY cc.updated_at DESC LIMIT 200`).all()).results;
  const L = launchpadPdas(s.programId);
  const ids = rows.map((r) => cityIdOf(r.city_id));
  const addrs = [];
  for (const id of ids) if (id) addrs.push(await L.approval(id), await L.coin(id));
  const [lp, acc] = await Promise.all([
    lpRpc(env, "getAccountInfo", [await L.launchpad(), { encoding: "base64", commitment: "confirmed" }], fetchImpl).then((r) => decodeLaunchpad(r && r.value, s.programId)),
    readAccounts(env, addrs, fetchImpl),
  ]);
  const config = s.dbcConfigs[0] || null;
  const lc = config ? decodeLaunchConfig((await readAccounts(env, [await L.launchConfig(config)], fetchImpl)).values().next().value || null, s.programId) : null;
  const global = [];
  if (!s.configsSet) global.push("City-coin trading is not switched on yet: the team switches it on after your setup steps and their read-only check.");
  else if (!lc || !lc.enabled) global.push("The price curve in the settings is not allowed on the launchpad yet (setup step 4).");
  else if (lc.quoteMint !== WSOL) global.push("The price curve in the settings is not priced in SOL.");
  if (!lp) global.push("The launchpad is not started yet (setup step 1).");
  else if (lp.admin !== ctx.wallet) global.push(`Only the launchpad admin (${lp.admin}) can approve; you are signed in with ${ctx.wallet}.`);
  const candidates = [], approvals = [], launched = [];
  // COIN_V2_READY=on (src/coinready.js): only a city's ready-made coin, chosen by its founder ("Use this coin") and still its design, is
  // approved; and a ticker is never approved twice: not when another city launched with it (lp_coins) nor when another city's approval
  // on chain names it (the registry gives each city its own, but a regenerated list could move one: scripts/cities/tickers.mjs pins them)
  const ready = coinV2ReadyOn(env);
  const takenBy = new Map(); // symbol -> the other city's id, launched or approved
  let unknown = []; // cities whose launched coin's symbol this site could not read: any ticker may be theirs
  if (ready) {
    unknown = await unknownSymbols(env, "", fetchImpl);
    try {
      for (const x of (await db.prepare("SELECT city_id, symbol FROM lp_coins WHERE symbol IS NOT NULL").all()).results) takenBy.set(x.symbol, `${x.city_id}`);
    } catch (e) { if (!/no such table/i.test(String((e && e.message) || e))) throw e; }
    for (let i = 0; i < rows.length; i++) {
      if (!ids[i]) continue;
      const ap = decodeApproval(acc.get(await L.approval(ids[i])) || null, s.programId);
      if (ap && ap.symbol && !takenBy.has(ap.symbol)) takenBy.set(ap.symbol, String(ids[i]));
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], id = ids[i];
    if (!id) continue;
    const ap = decodeApproval(acc.get(await L.approval(id)) || null, s.programId);
    // launched only when the program's own Coin record is there (owner, discriminator and size, as src/lplaunch.js launchState reads
    // it): anyone can send lamports to a city's Coin address (a plain system account), which must not block that city's approval
    const coin = decodeCoin(acc.get(await L.coin(id)) || null, s.programId);
    const t = await tickerOf(env, r.city_id); // the list's ticker: what an approval binds on chain (never a chain symbol read back)
    const shown = await displayTicker(env, { cityId: r.city_id, mint: r.mint || null, chainSymbol: r.mint ? undefined : null }); // a launched coin shows the chain's
    const base = { cityId: String(id), cityName: r.city_name, country: r.country, name: r.name, pair: r.pair, ticker: shown ? shown.ticker : null, founder: r.seat_wallet || null, handle: r.handle || null,
      // a Raydium LaunchLab contract still waits for this city: the card offers "Reject the old contract" (POST legacy/reject)
      ...(r.pending_mint ? { legacyContract: true } : {}) };
    if (coin || r.mint) { launched.push({ ...base, mint: r.mint || null }); continue; }
    if (ap) {
      // the program checks only the approved wallet, the expiry and the pause: a wallet that lost the founder seat can still launch
      // the city's official coin until the approval expires, so the owner is told to revoke it
      const expired = ap.expiresAt * 1000 <= now;
      const warnings = [];
      if (!expired) {
        if (!r.live_seat) warnings.push("The approved wallet no longer holds the founder seat (the city has no founder now), but it can still launch this city's coin on chain until the approval expires. Revoke it.");
        else if (r.seat_wallet !== ap.founder) warnings.push(`The approved wallet no longer holds the founder seat (it is now ${r.seat_wallet}), but it can still launch this city's coin on chain until the approval expires. Revoke it.`);
        else if (!["active", "steward"].includes(r.seat_status)) warnings.push(`The founder's seat is ${r.seat_status === "grace" ? "in its grace period (their balance fell below the bar)" : r.seat_status === "provisional" ? "not final (still in its appeal window)" : r.seat_status}. This website will not let them launch, but the approval still works on chain until it expires. Revoke it unless they recover soon.`);
        // one city, one coin: a contract sent through the old Raydium LaunchLab path still waits for this city (it may be a coin already)
        if (r.pending_mint) warnings.push("A Raydium LaunchLab contract sent for this city through the old path is still waiting (the city may have that coin already). This website will not let the founder launch while it waits, but the approval still works on chain until it expires. Revoke it, then reject that contract with “Reject the old contract” on this card.");
      }
      approvals.push({ ...base, approval: { founder: ap.founder, name: ap.name, symbol: ap.symbol, expiresAt: iso(ap.expiresAt * 1000), expired, rentPayer: ap.rentPayer },
        seat: { wallet: r.seat_wallet || null, status: r.live_seat ? r.seat_status : null }, warnings });
      continue;
    }
    const reasons = [...global];
    // a contract sent through the old Raydium LaunchLab path before the launchpad was set up (src/coins.js closes that path now):
    // the city may already have a coin there, and one city has one coin, so it is skipped until an admin rejects that contract
    if (r.pending_mint) reasons.push("A Raydium LaunchLab contract sent for this city through the old path is still waiting (the city may have that coin already, and one city has one coin). It can't be recorded any more: reject it with “Reject the old contract” on this card, then approve this city.");
    if (r.pair !== "SOL") reasons.push(`The coin is paired with ${r.pair}; only SOL-paired coins can launch on the Vicinity curve for now. The founder must pick SOL.`);
    const np = nameProblem(r.name);
    if (np) reasons.push(np);
    if (!t) reasons.push("This city has no ticker in the list.");
    else if (!symbolOk(t.ticker)) reasons.push(`The ticker ${t.ticker} is not 1 to 10 capital letters or digits.`);
    if (!r.live_seat) reasons.push("The city has no founder seat now.");
    else if (!["active", "steward"].includes(r.seat_status)) reasons.push(`The founder's seat is ${r.seat_status === "grace" ? "in its grace period (their balance fell below the bar)" : r.seat_status === "provisional" ? "not final yet (still in its appeal window)" : r.seat_status}.`);
    else if (r.live_seat !== r.seat_id) reasons.push("The coin design was made by a former founder; the current founder must save it again.");
    else if (!r.user_wallet || r.user_wallet !== r.seat_wallet) reasons.push(`The founder's account now uses another wallet (${r.user_wallet || "none"}) than the one that holds the seat (${r.seat_wallet}). Approve only the wallet that will sign the launch.`);
    let readyCoin = null;
    if (ready) {
      // (a Raydium LaunchLab contract still waiting for this city is the reason src/lpadmin.js gives on every candidate, switch or not)
      if (unknown.some((x) => x !== String(id))) reasons.push(`A coin launched for another city (${unknown.filter((x) => x !== String(id)).join(", ")}) has a ticker this site could not read from the blockchain yet, so nothing is approved until it is known. Reload in a minute.`);
      const other = t ? takenBy.get(t.ticker) : null;
      if (other && other !== String(id)) reasons.push(`The ticker ${t.ticker} is already launched or approved for another city (${other}). Nothing is approved twice: the city list must give this city another ticker first.`);
      const c = await chosenOf(db, r.city_id);
      if (c && c.current && t && c.symbol === t.ticker && c.name === r.name) readyCoin = { version: c.content_hash.slice(0, 8), contentHash: c.content_hash, template: c.template_version, art: `/coin-meta/art/${c.art_sha256}.png` };
      else reasons.push(c && c.current ? "The founder's chosen Vicinity coin no longer matches the city list (its ticker or name changed). The founder must use the coin again." : "The founder has not chosen the Vicinity coin yet (\"Use this coin\" in their Founder tab).");
    }
    const warnings = [];
    if (r.seat_wallet && lp && r.seat_wallet === lp.admin) warnings.push("The founder is the launchpad admin's own wallet.");
    // logo: a picture exists; logoStatus: where the working picture's check stands; approved: an approved picture shows to everyone
    // (src/logos.js: only an approved picture is ever shown to the public; a replacement waits while the approved one keeps showing)
    candidates.push({ ...base, symbol: t ? t.ticker : null, pitch: r.pitch || "", logo: Boolean(r.media_id), logoStatus: r.media_id ? r.logo_status || "pending" : null,
      approved: Boolean(r.approved_media_id), designAt: r.updated_at || null,
      nameBytes: new TextEncoder().encode(r.name || "").length, ok: reasons.length === 0, reasons, warnings, ...(ready ? { ready: readyCoin } : {}) });
  }
  // Meteora's programs against the tested builds: a city can be fine (ok) while every approval waits; the page says so on its button
  const meteora = programSummary(await programHashes(env, fetchImpl, now));
  return { candidates, approvals, launched, global, config, admin: lp ? lp.admin : null, paused: lp ? lp.launchesPaused : null, meteora };
}

async function approveTx(env, ctx, body, fetchImpl, now, route = null) {
  const s = lpSetup(env);
  const cityId = cityIdOf(body.cityId);
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const days = body.expiryDays === undefined ? 7 : Number(body.expiryDays);
  if (!Number.isInteger(days) || days < 1 || days > 30) return err("bad_expiry", "The approval lasts 1 to 30 days.", 400);
  // never an approval against a Meteora build the team has not tested (409), nor one blind while that cannot be read (503); read
  // fresh (the deploy slots again), so an upgrade a minute ago is seen now, not after the pages' ten minutes
  const pr = programRefusal(await programHashes(env, fetchImpl, now, { fresh: true, route }), "Approvals");
  if (pr) return err(pr.error, pr.message, pr.status, { which: pr.which, cityId: String(cityId) });
  const list = await candidateList(env, ctx, fetchImpl, now);
  const c = list.candidates.find((x) => x.cityId === String(cityId));
  if (!c) {
    if (list.approvals.some((x) => x.cityId === String(cityId))) return err("already_approved", "This city is approved already. Revoke the approval first to approve it again.");
    if (list.launched.some((x) => x.cityId === String(cityId))) return err("already_launched", "This city's coin is launched already.");
    return err("not_a_candidate", "This city has no coin design to approve.", 404);
  }
  if (!c.ok) return err("blocked", c.reasons.join(" "), 409, { reasons: c.reasons });
  // the owner approves what his page showed him: the card sends the coin's name, ticker, founder wallet and the time the design was
  // last saved, and nothing is built when any of them changed since (a founder renaming the coin while the card was on screen)
  const seen = { name: body.name, symbol: body.symbol, founder: body.founder, designAt: body.designAt };
  const changed = () => err("design_changed", "This coin's design changed since the page showed it to you (its name, ticker, founder, description, picture or version). Nothing was built. Reload the page, check the city again, then approve.", 409, { cityId: String(cityId) });
  if (seen.name !== c.name || seen.symbol !== c.symbol || seen.founder !== c.founder || seen.designAt !== c.designAt) return changed();
  // COIN_V2_READY=on: the approval stands for one exact ready-made version, the one whose picture and version the card showed (its
  // picture and words go into the coin's metadata for ever: src/coinart-store.js binds only a version an approval was built from)
  const ready = coinV2ReadyOn(env);
  if (ready) {
    if (!c.ready || body.contentHash !== c.ready.contentHash) return changed();
    // the hold FIRST (src/coinready.js checks it inside every write of "Use this coin"), then the design read again: a choice that
    // landed between the card's read and the hold is seen here, and nothing is built from a version the owner did not see
    await holdDesign(env, cityId, now);
    const row = await env.DB.prepare("SELECT updated_at, name FROM city_coins WHERE city_id = ?").bind(String(cityId)).first();
    const now2 = await chosenOf(env.DB, String(cityId), { fresh: true });
    if (!row || row.updated_at !== c.designAt || row.name !== c.name || !now2 || !now2.current || now2.content_hash !== c.ready.contentHash) return changed();
  }
  const nowS = Math.floor(now / 1000);
  // the program refuses more than 30 days after ITS clock: ten minutes of slack at the longest choice
  const expiresAt = nowS + Math.min(days * DAY_S, APPROVAL_MAX_S - 600);
  const ix = await IX.approveLaunch({ programId: s.programId, admin: ctx.wallet, cityId, founder: c.founder, name: c.name, symbol: c.symbol, expiresAt, dbcConfig: list.config });
  const L = launchpadPdas(s.programId);
  const r = await buildTx(env, { payer: ctx.wallet, instructions: [ix], labels: { [await L.approval(cityId)]: `${c.cityName}'s approval (new; its rent comes back at launch or revoke)`, [c.founder]: `the founder of ${c.cityName}` } }, fetchImpl, now);
  if (r.ok) {
    // from now until this transaction lands (or its blockhash dies), and then for as long as the approval is on chain, the founder
    // cannot change the design (src/coins.js handleDesign): what the owner approved is what launches and what /coin-meta shows
    if (ready) { await ensureReadySchema(env.DB); await markApprovedStatement(env.DB, { cityId, contentHash: c.ready.contentHash, designAt: c.designAt }).run(); } // held above already
    else { await holdDesign(env, cityId, now); await clearApproved(env.DB, cityId); } // not built from a ready-made version: it binds none
    Object.assign(r, { step: "approve", cityId: String(cityId), record: { step: "approve", params: { cityId: String(cityId) } }, approve: { name: c.name, symbol: c.symbol, founder: c.founder, expiresAt: iso(expiresAt * 1000), days } });
  }
  return respond(r);
}

async function revokeTx(env, ctx, body, fetchImpl, now) {
  const s = lpSetup(env);
  const cityId = cityIdOf(body.cityId);
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const L = launchpadPdas(s.programId);
  const [lpAcc, apAcc] = await Promise.all([L.launchpad(), L.approval(cityId)]).then((a) => readAccounts(env, a, fetchImpl).then((m) => a.map((k) => m.get(k) || null)));
  const lp = decodeLaunchpad(lpAcc, s.programId), ap = decodeApproval(apAcc, s.programId);
  if (!ap) return err("no_approval", "This city has no approval on chain.", 404);
  if (!lp || lp.admin !== ctx.wallet) return err("not_admin", `Only the launchpad admin (${lp ? lp.admin : "not set"}) can revoke.`, 403);
  const ix = await IX.revokeApproval({ programId: s.programId, admin: ctx.wallet, cityId, rentPayer: ap.rentPayer });
  const r = await buildTx(env, { payer: ctx.wallet, instructions: [ix], watch: [ap.rentPayer], labels: { [await L.approval(cityId)]: "the approval (closed)", [ap.rentPayer]: ap.rentPayer === ctx.wallet ? "your wallet (gets the rent back)" : "who paid the approval's rent (gets it back)" } }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "revoke", cityId: String(cityId), record: { step: "revoke", params: { cityId: String(cityId) } } });
  return respond(r);
}

/* ---------------------------------------------------------------- launched coins */
async function coinRecords(env, s, fetchImpl) {
  const list = await lpRpc(env, "getProgramAccounts", [s.programId, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: LAYOUT.Coin.size }] }], fetchImpl);
  const rows = Array.isArray(list) ? list : list && Array.isArray(list.value) ? list.value : [];
  const L = launchpadPdas(s.programId), out = [];
  for (const r of rows) {
    const c = decodeCoin(r && r.account ? { ...r.account, owner: r.account.owner || s.programId } : null, s.programId);
    if (c && (await L.coin(c.cityId)) === r.pubkey) out.push({ ...c, address: r.pubkey });
  }
  return out.sort((a, b) => (a.launchedAt < b.launchedAt ? 1 : -1)).slice(0, 100);
}
const poolFlag = (acc, field) => { const a = accountBytes(acc); const f = LAYOUT.VirtualPool.fields[field]; return a && f ? a.bytes[f.at] : null; };
/** Position NFTs the Coin record holds in its own graduated pool (found by owner, like the keeper; others are ignored). */
async function cityPositions(env, coin, fetchImpl) {
  const pool = await IX.canonicalPool(coin.mint, coin.quoteMint);
  const r = await lpRpc(env, "getTokenAccountsByOwner", [coin.address, { programId: PROGRAM_IDS.token2022 }, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  const held = (r && Array.isArray(r.value) ? r.value : []).map((x) => ({ account: x.pubkey, t: decodeTokenAccount(x.account) }))
    .filter((x) => x.t && x.t.owner === coin.address && x.t.amount === 1n).slice(0, 10);
  if (!held.length) return { pool, positions: [] };
  const posAddrs = await Promise.all(held.map((h) => IX.damm.position(h.t.mint)));
  const acc = await readAccounts(env, [pool, ...posAddrs], fetchImpl);
  if (!ownedBy(acc.get(pool), PROGRAM_IDS.damm)) return { pool, positions: [] };
  const positions = [];
  held.forEach((h, i) => {
    const p = accountBytes(acc.get(posAddrs[i]));
    if (p && ownedBy(acc.get(posAddrs[i]), PROGRAM_IDS.damm) && hasDisc(p.bytes, DISC.Position) && key(p.bytes, 8) === pool && key(p.bytes, 40) === h.t.mint) positions.push({ nftMint: h.t.mint, position: posAddrs[i] });
  });
  return { pool, positions };
}
/** One launched coin with what can be done for it now. */
async function coinView(env, s, c, acc, names) {
  const L = launchpadPdas(s.programId), R = IX.rewards(s.rewardsProgramId);
  const [pot, vault, cfg] = await Promise.all([L.holdersPot(c.address), L.founderVault(c.address), R.city(c.mint)]);
  const pool = decodePool(acc.get(c.dbcPool) || null), config = decodeConfig(acc.get(c.dbcConfig) || null);
  const potT = decodeTokenAccount(acc.get(pot) || null), vaultT = decodeTokenAccount(acc.get(vault) || null);
  const city = decodeCityConfig(acc.get(cfg) || null, s.rewardsProgramId);
  const target = config ? config.migrationQuoteThreshold : null;
  const stage = !pool ? "unknown" : pool.isMigrated ? "graduated" : target !== null && (pool.quoteReserve >= target || pool.migrationProgress >= 1) ? "full" : "curve";
  const creatorSurplusTaken = poolFlag(acc.get(c.dbcPool), "is_creator_withdraw_surplus");
  const surplusDue = Boolean(pool && target !== null && pool.quoteReserve >= target && creatorSurplusTaken === 0);
  const n = names.get(String(c.cityId)) || {};
  return {
    cityId: String(c.cityId), cityName: n.city_name || null, name: n.name || null, mint: c.mint, coin: c.address, founder: c.founder, quoteMint: c.quoteMint,
    dbcPool: c.dbcPool, dbcConfig: c.dbcConfig, stage, progressPct: pool && target ? (stage === "curve" ? Math.min(100, Number((pool.quoteReserve * 10000n) / target) / 100) : 100) : null,
    curveFees: pool ? pool.creatorQuoteFee.toString() : "0", surplusDue, holdersPot: potT ? potT.amount.toString() : "0", founderVault: vaultT ? vaultT.amount.toString() : "0",
    rewards: city ? { config: cfg, ok: city.rewardModel === 1 && city.founderBps === 0 && city.rewardMint === c.quoteMint } : null,
    coinPage: `/coin?mint=${c.mint}`,
  };
}
async function coinsList(env, ctx, fetchImpl) {
  const s = lpSetup(env);
  const coins = await coinRecords(env, s, fetchImpl);
  const names = new Map();
  if (coins.length) {
    const ids = coins.map((c) => String(c.cityId));
    const rows = (await env.DB.prepare(`SELECT city_id, city_name, name FROM city_coins WHERE city_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results;
    for (const r of rows) names.set(String(r.city_id), r);
  }
  const L = launchpadPdas(s.programId), R = IX.rewards(s.rewardsProgramId);
  const want = [];
  for (const c of coins) want.push(c.dbcPool, c.dbcConfig, await L.holdersPot(c.address), await L.founderVault(c.address), await R.city(c.mint));
  const acc = await readAccounts(env, want, fetchImpl);
  const out = [];
  for (const c of coins) out.push(await coinView(env, s, c, acc, names));
  return out;
}
async function oneCoin(env, s, cityId, fetchImpl) {
  const L = launchpadPdas(s.programId);
  const address = await L.coin(cityId);
  const c = decodeCoin((await readAccounts(env, [address], fetchImpl)).get(address) || null, s.programId);
  if (!c) return null;
  const coin = { ...c, address };
  const R = IX.rewards(s.rewardsProgramId);
  const acc = await readAccounts(env, [c.dbcPool, c.dbcConfig, await L.holdersPot(address), await L.founderVault(address), await R.city(c.mint)], fetchImpl);
  return { coin, view: await coinView(env, s, coin, acc, new Map()) };
}

async function collectTx(env, ctx, body, fetchImpl, now) {
  const s = lpSetup(env);
  const cityId = cityIdOf(body.cityId);
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const one = await oneCoin(env, s, cityId, fetchImpl);
  if (!one) return err("not_launched", "This city's coin is not launched.", 404);
  const { coin, view } = one;
  const instructions = [];
  if (view.stage !== "unknown" && (BigInt(view.curveFees) > 0n || view.surplusDue)) instructions.push(await IX.harvestCurveFees({ programId: s.programId, payer: ctx.wallet, coin }));
  if (view.stage === "graduated") {
    const { pool, positions } = await cityPositions(env, coin, fetchImpl);
    for (const p of positions) instructions.push(await IX.harvestPoolFees({ programId: s.programId, payer: ctx.wallet, coin, dammPool: pool, positionNftMint: p.nftMint }));
  }
  if (!instructions.length) return err("nothing_to_collect", "Nothing is waiting to be collected for this city right now.", 409);
  const L = launchpadPdas(s.programId);
  const r = await buildTx(env, { payer: ctx.wallet, instructions, labels: { [coin.address]: "the city's coin record", [await L.holdersPot(coin.address)]: "the city's holders pot", [await L.founderVault(coin.address)]: "the founder's vault" } }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "collect", cityId: String(cityId), record: { step: "collect", params: { cityId: String(cityId) } } });
  return respond(r);
}
async function initCityTx(env, ctx, body, fetchImpl, now) {
  const s = lpSetup(env);
  const cityId = cityIdOf(body.cityId);
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const one = await oneCoin(env, s, cityId, fetchImpl);
  if (!one) return err("not_launched", "This city's coin is not launched.", 404);
  if (one.view.rewards) return err("already_done", "Holder rewards are set up for this city already.", 409);
  const R = IX.rewards(s.rewardsProgramId);
  const reg = decodeRegistry((await readAccounts(env, [await R.registry()], fetchImpl)).values().next().value || null, s.rewardsProgramId);
  if (!reg) return err("no_registry", "The rewards registry is not started (setup step 1).", 409);
  if (reg.admin !== ctx.wallet) return err("not_admin", `Only the rewards registry admin (${reg.admin}) can set up holder rewards.`, 403);
  const { coin } = one;
  const ix = await IX.initCity({ rewardsProgramId: s.rewardsProgramId, payer: ctx.wallet, admin: ctx.wallet, authority: ctx.wallet, founder: coin.founder, mint: coin.mint, rewardMint: coin.quoteMint, cityId });
  const r = await buildTx(env, { payer: ctx.wallet, instructions: [ix], labels: { [await R.city(coin.mint)]: "the city's rewards settings (new: holders only, founder share 0)" } }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "initCity", cityId: String(cityId), record: { step: "initCity", params: { cityId: String(cityId) } } });
  return respond(r);
}
async function forwardTx(env, ctx, body, fetchImpl, now) {
  const s = lpSetup(env);
  const cityId = cityIdOf(body.cityId);
  if (!cityId) return err("bad_city", "Unknown city.", 400);
  const one = await oneCoin(env, s, cityId, fetchImpl);
  if (!one) return err("not_launched", "This city's coin is not launched.", 404);
  if (!one.view.rewards) return err("no_rewards", "Set up holder rewards for this city first.", 409);
  if (!one.view.rewards.ok) return err("bad_rewards", "This city's rewards settings are not the holders-only kind the launchpad forwards to. Tell the team.", 409);
  if (BigInt(one.view.holdersPot) === 0n) return err("nothing_to_forward", "The holders pot is empty; collect the city fees first.", 409);
  const ix = await IX.forwardHoldersFees({ programId: s.programId, rewardsProgramId: s.rewardsProgramId, coin: one.coin });
  const r = await buildTx(env, { payer: ctx.wallet, instructions: [ix] }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "forward", cityId: String(cityId), record: { step: "forward", params: { cityId: String(cityId) } } });
  return respond(r);
}
async function pauseTx(env, ctx, body, fetchImpl, now) {
  const s = lpSetup(env);
  if (typeof body.launches !== "boolean") return err("bad_request", "Say whether launches should be paused.", 400);
  const L = launchpadPdas(s.programId);
  const lp = decodeLaunchpad((await readAccounts(env, [await L.launchpad()], fetchImpl)).values().next().value || null, s.programId);
  if (!lp) return err("not_started", "The launchpad is not started (setup step 1).", 409);
  if (lp.admin !== ctx.wallet) return err("not_admin", `Only the launchpad admin (${lp.admin}) can pause or resume launches.`, 403);
  if (lp.launchesPaused === body.launches) return err("already_done", body.launches ? "Launches are paused already." : "Launches are running already.", 409);
  const ix = await IX.setPause({ programId: s.programId, authority: ctx.wallet, launches: body.launches });
  const r = await buildTx(env, { payer: ctx.wallet, instructions: [ix] }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "pause", launches: body.launches, record: { step: "pause", params: {} } });
  return respond(r);
}

/* ---------------------------------------------------------------- the dev wallet's platform fees (a port of planPlatformFeeClaims) */
const PARTNER_CREATION_FEE_CLAIMED = 0b10;
const CLAIM_CU = { tradingFee: 60_000, poolCreationFee: 25_000, surplus: 40_000, poolPositionFee: 70_000 };
async function platformPlan(env, fetchImpl) {
  const s = lpSetup(env);
  const configs = await launchConfigs(env, s, fetchImpl);
  const claims = [];
  for (const lc of configs) {
    const cfgAcc = (await readAccounts(env, [lc.dbcConfig], fetchImpl)).get(lc.dbcConfig) || null;
    const cfg = decodeConfig(cfgAcc);
    if (!cfg || cfg.feeClaimer !== DEV) continue;
    const pools = await lpRpc(env, "getProgramAccounts", [PROGRAM_IDS.dbc, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: LAYOUT.VirtualPool.size }, { memcmp: { offset: LAYOUT.VirtualPool.fields.config.at, bytes: lc.dbcConfig } }] }], fetchImpl);
    for (const pa of (Array.isArray(pools) ? pools : []).slice(0, 200)) {
      const p = decodePool(pa.account ? { ...pa.account, owner: pa.account.owner || PROGRAM_IDS.dbc } : null);
      if (!p || p.config !== lc.dbcConfig) continue;
      const raw = accountBytes(pa.account);
      const partnerBase = readU64(raw.bytes, LAYOUT.VirtualPool.fields.partner_base_fee.at);
      const mint = p.baseMint, quote = cfg.quoteMint;
      if (p.partnerQuoteFee > 0n || partnerBase > 0n) claims.push({ kind: "tradingFee", pool: pa.pubkey, config: lc.dbcConfig, mint, quoteMint: quote, amount: p.partnerQuoteFee.toString(), unit: "quote" });
      const bits = raw.bytes[LAYOUT.VirtualPool.fields.creation_fee_bits.at];
      if (cfg.poolCreationFee > 0n && (bits & PARTNER_CREATION_FEE_CLAIMED) === 0) claims.push({ kind: "poolCreationFee", pool: pa.pubkey, config: lc.dbcConfig, mint, quoteMint: quote, amount: (cfg.poolCreationFee - cfg.poolCreationFee / 10n).toString(), unit: "lamports" });
      const complete = p.quoteReserve >= cfg.migrationQuoteThreshold;
      const total = complete ? p.quoteReserve - cfg.migrationQuoteThreshold : 0n;
      const pc = (total * 80n) / 100n, partner = pc - (pc * cfg.creatorTradingFeePercentage) / 100n;
      if (complete && raw.bytes[LAYOUT.VirtualPool.fields.is_partner_withdraw_surplus.at] === 0 && partner > 0n) claims.push({ kind: "surplus", pool: pa.pubkey, config: lc.dbcConfig, mint, quoteMint: quote, amount: partner.toString(), unit: "quote" });
      if (p.isMigrated) {
        const { pool, positions } = await cityPositions(env, { address: DEV, mint, quoteMint: quote }, fetchImpl);
        for (const pos of positions) claims.push({ kind: "poolPositionFee", pool, nftMint: pos.nftMint, mint, quoteMint: quote, amount: "0", unit: "quote" });
      }
    }
  }
  const totals = { quote: claims.filter((c) => c.unit === "quote").reduce((a, c) => a + BigInt(c.amount), 0n).toString(), lamports: claims.filter((c) => c.unit === "lamports").reduce((a, c) => a + BigInt(c.amount), 0n).toString() };
  return { claims, totals };
}
async function claimInstructions(c) {
  const accounts = async () => [await createAtaIdempotent({ payer: DEV, owner: DEV, mint: c.mint }), await createAtaIdempotent({ payer: DEV, owner: DEV, mint: c.quoteMint })];
  if (c.kind === "tradingFee") return [...await accounts(), await IX.claimTradingFee({ pool: c.pool, config: c.config, baseMint: c.mint, quoteMint: c.quoteMint, baseAccount: await ata(DEV, c.mint), quoteAccount: await ata(DEV, c.quoteMint) })];
  if (c.kind === "poolCreationFee") return [await IX.claimPartnerPoolCreationFee({ pool: c.pool, config: c.config })];
  if (c.kind === "surplus") return [await createAtaIdempotent({ payer: DEV, owner: DEV, mint: c.quoteMint }), await IX.partnerWithdrawSurplus({ pool: c.pool, config: c.config, quoteMint: c.quoteMint, quoteAccount: await ata(DEV, c.quoteMint) })];
  return [...await accounts(), await IX.dammClaimPositionFee({ owner: DEV, pool: c.pool, nftMint: c.nftMint, mintA: c.mint, mintB: c.quoteMint, accountA: await ata(DEV, c.mint), accountB: await ata(DEV, c.quoteMint) })];
}
/** The claims packed in order into transactions that fit (a claim's own account creations always travel with it). */
async function packClaims(claims) {
  const groups = [];
  let cur = null;
  for (const c of claims) {
    const ixs = await claimInstructions(c);
    if (cur && cur.cu + CLAIM_CU[c.kind] <= 1_400_000 && fits(DEV, [...cur.instructions, ...ixs])) { cur.instructions.push(...ixs); cur.claims.push(c); cur.cu += CLAIM_CU[c.kind]; continue; }
    if (cur) groups.push(cur);
    cur = { instructions: ixs, claims: [c], cu: CLAIM_CU[c.kind] };
  }
  if (cur) groups.push(cur);
  return groups;
}
async function platformTx(env, ctx, fetchImpl, now) {
  if (ctx.wallet !== DEV) return err("dev_wallet_only", `Only the dev wallet ${DEV} can collect the platform fees. Sign in with it.`, 403);
  const plan = await platformPlan(env, fetchImpl);
  const groups = await packClaims(plan.claims);
  if (!groups.length) return err("nothing_to_collect", "No platform fees are waiting right now.", 409);
  const g = groups[0];
  const r = await buildTx(env, { payer: DEV, instructions: g.instructions, cuLimit: Math.min(1_400_000, g.cu + 60_000) }, fetchImpl, now);
  if (r.ok) Object.assign(r, { step: "platform", claims: g.claims, left: groups.length - 1, record: { step: "platform", params: {} } });
  return respond(r);
}

/* ---------------------------------------------------------------- the status */
async function status(env, ctx, fetchImpl, now) {
  const s = lpSetup(env);
  const st = await readState(env, s, ctx.wallet, fetchImpl, { hashes: true, now });
  const steps = await setupSteps(st);
  const want = await tableWant(st);
  return json({
    ok: true, cluster: s.cluster, wallet: ctx.wallet, devWallet: DEV, isDevWallet: ctx.wallet === DEV,
    settings: { programId: s.programId, rewardsProgramId: s.rewardsProgramId, dbcConfigs: s.dbcConfigs, configsSet: s.configsSet, lookupTable: s.lookupTable, trading: String(env.LAUNCHPAD_TRADING || "").trim().toLowerCase() === "on" },
    genesis: "ok", programs: st.programs, meteora: programSummary(st.meteora),
    launchpad: st.launchpad ? { address: st.launchpadAddress, admin: st.launchpad.admin, launchesPaused: st.launchpad.launchesPaused, payoutsPaused: st.launchpad.payoutsPaused, rewardsProgram: st.launchpad.rewardsProgram } : null,
    registry: st.registry ? { address: st.registryAddress, admin: st.registry.admin } : null,
    config: st.config ? { ...st.config, defaults: DBC_CONFIG_DEFAULTS } : null,
    allowList: st.allowList.map((x) => ({ address: x.address, dbcConfig: x.dbcConfig, quoteMint: x.quoteMint, enabled: x.enabled })),
    referral: st.referral.map(({ mint, symbol, account, exists }) => ({ mint, symbol, account, exists })),
    lookup: st.lookup ? { address: st.lookup.address, source: st.lookup.source, exists: st.lookup.exists, deactivated: Boolean(st.lookup.deactivated), authority: st.lookup.authority || null, count: st.lookup.addresses ? st.lookup.addresses.length : 0, missing: want && st.lookup.addresses ? want.filter((a) => !st.lookup.addresses.includes(a)).length : null } : null,
    partner: st.partner,
    squads: st.squads ? (st.squads.ok ? { multisig: st.squads.multisig, vault: st.squads.vault, threshold: st.squads.threshold, members: st.squads.members.length } : { multisig: st.setup.squads.address, error: st.squads.error, message: st.squads.message }) : null,
    steps, problems: problemsOf(st), complete: steps.every((x) => x.state === "done"),
  }, 200, { "Cache-Control": "no-store" });
}

/* ---------------------------------------------------------------- the router */
const GET = new Set(["", "status", "pins", "summary", "squads", "candidates", "coins", "platform/plan"]);
const POST = new Set(["tx", "record", "approve/tx", "revoke/tx", "collect/tx", "init-city/tx", "forward/tx", "pause/tx", "platform/tx", "legacy/reject"]);

/** /api/admin/lp/<sub> for the owner (src/admin.js already checked the gate, the role and, on POST, a fresh proof and the origin). */
export async function handleLpAdmin(request, ctx, sub, now = Date.now()) {
  const env = ctx.env, fetchImpl = ctx.fetchImpl || fetch;
  const s = lpSetup(env);
  if (!s.on) return json({ ok: false, error: "not_enabled" }, 404);
  const method = request.method;
  const isGet = GET.has(sub), isPost = POST.has(sub);
  if (!isGet && !isPost) return json({ ok: false, error: "not_found" }, 404);
  if ((isGet && method !== "GET") || (isPost && method !== "POST")) return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!isSolanaAddress(ctx.wallet)) return json({ ok: false, error: "sign_in" }, 401);
  if (sub === "") {
    return json({ ok: true, on: true, cluster: s.cluster, programId: s.programId, rewardsProgramId: s.rewardsProgramId, wallet: ctx.wallet, isDevWallet: ctx.wallet === DEV, configsSet: s.configsSet }, 200, { "Cache-Control": "no-store" });
  }
  const url = new URL(request.url);
  let body = {};
  if (isPost) {
    body = await readJson(request, 8192);
    if (!body || typeof body !== "object") return json({ ok: false, error: "bad_json" }, 400);
  }
  const mismatch = checkCluster(env, isPost ? body.cluster : url.searchParams.get("cluster"));
  if (mismatch) return respond(mismatch);
  // a Raydium LaunchLab contract still waiting for a city, rejected from its card (the owner may have no home community, which the
  // dashboard's queue needs, or may be the coin's own designer): the same rule as the dashboard's (src/coins.js settleLegacyContract).
  // Nothing on chain: it works whatever the blockchain answers
  if (sub === "legacy/reject") {
    const st = await settleLegacyContract(env, { cityId: String(body.cityId || ""), actorId: ctx.user && ctx.user.id, now });
    if (!st.ok) return json({ ok: false, error: st.error, message: st.error === "not_found" ? "No contract from the old Raydium LaunchLab path waits for this city (any more). Nothing was changed." : undefined }, st.status);
    await audit(env.DB, ctx.wallet, "lp_legacy_reject", String(body.cityId), "a waiting Raydium LaunchLab contract was rejected (not recorded)", now).run();
    return json({ ok: true, cityId: String(body.cityId) });
  }
  const g = await checkGenesis(env, fetchImpl);
  if (!g.ok) return respond(g);
  try {
    switch (sub) {
      case "status": return await status(env, ctx, fetchImpl, now);
      case "pins": return json({ ok: true, cluster: s.cluster, meteora: programSummary(await programHashes(env, fetchImpl, now)) }, 200, { "Cache-Control": "no-store" });
      case "summary": return await summary(env, ctx, fetchImpl, now);
      case "squads": {
        const a = String(url.searchParams.get("address") || "").trim();
        const acc = isSolanaAddress(a) ? (await readAccounts(env, [a], fetchImpl)).get(a) || null : null;
        const r = await checkMultisig(a, acc);
        if (!r.ok) return json(r, 200, { "Cache-Control": "no-store" }); // a refused paste is an answer, not a failure
        const st = await readState(env, s, ctx.wallet, fetchImpl, { now });
        const P = st.programs;
        return json({ ...r, members: r.members.map((m) => ({ key: m.key, vote: m.vote, execute: m.execute, initiate: m.initiate })), alreadyHandedOver: P.launchpad.upgradeAuthority === r.vault && P.rewards.upgradeAuthority === r.vault }, 200, { "Cache-Control": "no-store" });
      }
      case "candidates": return json({ ok: true, ...(await candidateList(env, ctx, fetchImpl, now)) }, 200, { "Cache-Control": "no-store" });
      case "coins": return json({ ok: true, coins: await coinsList(env, ctx, fetchImpl), isDevWallet: ctx.wallet === DEV }, 200, { "Cache-Control": "no-store" });
      case "platform/plan": {
        const plan = await platformPlan(env, fetchImpl);
        const groups = await packClaims(plan.claims);
        return json({ ok: true, ...plan, transactions: groups.length, isDevWallet: ctx.wallet === DEV }, 200, { "Cache-Control": "no-store" });
      }
      case "tx": return await buildStep(env, ctx, body, fetchImpl, now, checkedRoute(env, g));
      case "record": return await recordStep(env, ctx, body, fetchImpl, now, checkedRoute(env, g));
      case "approve/tx": return await approveTx(env, ctx, body, fetchImpl, now, checkedRoute(env, g));
      case "revoke/tx": return await revokeTx(env, ctx, body, fetchImpl, now);
      case "collect/tx": return await collectTx(env, ctx, body, fetchImpl, now);
      case "init-city/tx": return await initCityTx(env, ctx, body, fetchImpl, now);
      case "forward/tx": return await forwardTx(env, ctx, body, fetchImpl, now);
      case "pause/tx": return await pauseTx(env, ctx, body, fetchImpl, now);
      case "platform/tx": return await platformTx(env, ctx, fetchImpl, now);
      default: return json({ ok: false, error: "not_found" }, 404);
    }
  } catch (e) {
    console.error("lp admin failed", sub, codeOf(e));
    return respond({ ok: false, error: "rpc_unavailable" });
  }
}
