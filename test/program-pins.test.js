// Recognition step R3 (src/programpins.js): an approval, the allow-list step and a founder's launch wait while Meteora's bonding-curve
// (DBC) or DAMM v2 program on the cluster is not the build the team tested, and never go out blind while that cannot be read; the
// admin page shows the check (a standing line above the setup steps, the reason on the Approve button, the Overview's "Meteora build"
// card). The pins themselves are checked against solana/scripts/launchpad/fetch-fixtures.sh, the one place the team re-pins after a
// re-test. Through the real API with a fake chain (test/helpers/lpchain.js meteoraAsTested: stand-in program bytes pinned for the test
// process, since made-up bytes can never hash to the real pins) and the real admin scripts in the just-enough DOM of pagedom.js.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CACHE_MS, PINS, _resetProgramPins, fingerprint, programHashes, programRefusal, programSummary } from "../src/programpins.js";
import { DBC_PROGRAM_SHA256 } from "../src/sol/dbc-config-data.js";
import { GENESIS, _resetLpKit } from "../src/lpkit.js";
import { _resetRpcHealth } from "../src/rpcpool.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { LAYOUT } from "../src/sol/layout.js";
import { base58Decode } from "../src/solana.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { ADDRESSES, PROGRAM_IDS, launchpad as launchpadPdas, programDataAddress } from "../src/sol/pda.js";
import { MINT, advance, chain as mainChain, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { seedCoin, seedSeat } from "./helpers/launchpad.js";
import { LP_ON, METEORA_AUTHORITY, PROGRAM, REWARDS, SOL_CONFIG, addr, lpChain, meteoraAsTested, programDataAccount, sha256Hex } from "./helpers/lpchain.js";
import { openPage } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const NYC = "5128581", UTICA = "5142056", TABLE = "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe";
const OWNER = "Own3r1111111111111111111111111111111111111";
const b64 = (u8) => Buffer.from(u8).toString("base64");
const NEWER = new Uint8Array(4096).fill(9); // "Meteora upgraded": any bytes but the pinned ones
const LATER = 9_000; // the deploy slot of such an upgrade (every upgrade writes a later slot than the tested build's 1234)
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ---------------------------------------------------------------- accounts as the programs write them */
function layoutAccount(name, values) {
  const L = LAYOUT[name], out = new Uint8Array(L.size);
  out.set(L.discriminator, 0);
  for (const [k, v] of Object.entries(values)) {
    const f = L.fields[k];
    if (f.type === "pubkey") out.set(base58Decode(v), f.at);
    else if (f.type === "u64" || f.type === "i64") out.set(u64le(BigInt.asUintN(64, BigInt(v))), f.at);
    else out[f.at] = Number(v);
  }
  return { owner: PROGRAM, data: b64(out) };
}
function approvalAccount({ cityId, founder, dbcConfig = SOL_CONFIG, rentPayer = addr(5), name = "Utica Coin", symbol = "UTICA", expiresAt }) {
  const enc = new TextEncoder();
  const str = (s) => concat([u32le(enc.encode(s).length), enc.encode(s)]);
  const body = concat([Uint8Array.of(233, 9, 153, 49, 11, 222, 59, 130), u64le(BigInt(cityId)), base58Decode(founder), base58Decode(dbcConfig), base58Decode(rentPayer), str(name), str(symbol), u64le(1), u64le(BigInt(expiresAt)), Uint8Array.of(254)]);
  const out = new Uint8Array(179); out.set(body);
  return { owner: PROGRAM, data: b64(out) };
}
const built = (S, from = 0) => S.log.slice(from).filter((l) => l.method === "simulateTransaction" || l.method === "getLatestBlockhash").length;

/**
 * The owner on the admin routes: the launchpad started by them, the SOL price curve allowed, Meteora's programs as the builds the
 * team tested, and New York's coin designed by its founder (a city that can be approved).
 */
async function adminWorld() {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld(), ...LP_ON, LAUNCHPAD_DBC_CONFIGS: SOL_CONFIG };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const L = launchpadPdas(PROGRAM);
  const lp = lpChain({ accounts: {
    [await L.launchpad()]: layoutAccount("Launchpad", { admin: owner.w.address, rewards_program: REWARDS }),
    [await L.launchConfig(SOL_CONFIG)]: layoutAccount("LaunchConfig", { dbc_config: SOL_CONFIG, quote_mint: ADDRESSES.wsol, enabled: 1 }),
  } });
  const meteora = await meteoraAsTested(lp.S.accounts);
  const f = await person(env);
  await seedCoin(env.DB, { city: NYC, name: "New York City", coin: "Big Apple", seat: await seedSeat(env, f, { city: NYC, name: "New York City", handle: "nyc" }) });
  const call = async (path, body) => {
    const url = body === undefined ? `${path}${path.includes("?") ? "&" : "?"}cluster=devnet` : path;
    const r = await owner.send(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : { cluster: "devnet", ...body }, fetchImpl: lp.fetchImpl });
    return { status: r.status, data: await r.json() };
  };
  const card = async () => (await call("/api/admin/lp/candidates")).data.candidates.find((c) => c.cityId === NYC);
  const approve = async (c) => { c = c || await card(); return call("/api/admin/lp/approve/tx", { cityId: c.cityId, name: c.name, symbol: c.symbol, founder: c.founder, designAt: c.designAt, expiryDays: 7 }); };
  // how often Meteora's programs were read: whole, for their fingerprints (a getMultipleAccounts naming a Meteora ProgramData, no
  // dataSlice; `full()` the addresses of the last one), and their 45-byte headers alone (the deploy slots)
  const meteoraReads = (sliced) => lp.S.log.filter((l) => l.method === "getMultipleAccounts" && (l.params[0].includes(meteora.pdDbc) || l.params[0].includes(meteora.pdDamm)) && Boolean(l.params[1] && l.params[1].dataSlice) === sliced);
  const reads = () => meteoraReads(false).length, heads = () => meteoraReads(true).length, full = () => meteoraReads(false).at(-1).params[0];
  return { env, owner, lp, S: lp.S, call, card, approve, reads, heads, full, ...meteora };
}
/** The founder of Utica, approved on the fake chain, signed in on the founder's launch routes; Meteora's programs as tested. */
async function founderWorld() {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld(), ...LP_ON, LAUNCHPAD_DBC_CONFIGS: SOL_CONFIG, LAUNCHPAD_LOOKUP_TABLE: TABLE, VICINITY_MINT: MINT };
  const f = await person(env, { holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(UTICA, u.id, u.wallet, at, at).run();
  const lp = lpChain();
  const meteora = await meteoraAsTested(lp.S.accounts);
  lp.S.accounts[await launchpadPdas(PROGRAM).approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: f.w.address, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
  const main = mainChain();
  const fetchImpl = async (url, init) => (String(url).startsWith(LP_ON.LAUNCHPAD_RPC_URL) ? lp.fetchImpl(url, init) : main(url, init));
  const call = async (path, body) => {
    const url = body === undefined ? `${path}${path.includes("?") ? "&" : "?"}cluster=devnet` : path;
    const r = await f.send(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : { cluster: "devnet", ...body }, fetchImpl });
    return { status: r.status, data: await r.json() };
  };
  return { env, f, lp, S: lp.S, call, launch: () => call("/api/lp/launch/tx", { cityId: UTICA, mint: addr(90) }), status: () => call(`/api/lp/launch/status?city=${UTICA}`), ...meteora };
}

beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); _resetProgramPins(); realClock(); });

/* ---------------------------------------------------------------- the pins */
test("the pins are the ones fetch-fixtures.sh checks, per cluster; the ProgramData addresses are the loader's; the mainnet DBC pin is the build the expected config bytes came from", async () => {
  const sh = read("solana/scripts/launchpad/fetch-fixtures.sh");
  const [devnetPart, mainnetPart] = sh.split(/^else$/m);
  assert.ok(devnetPart && mainnetPart, "the script has a devnet block, then the mainnet block");
  const rows = (part) => Object.fromEntries([...part.matchAll(/"(dbc|damm_v2) (\S+) ([0-9a-f]{64})"/g)].map((m) => [m[1] === "damm_v2" ? "dammV2" : m[1], { programId: m[2], sha256: m[3] }]));
  const want = { devnet: rows(devnetPart), mainnet: rows(mainnetPart) };
  for (const cluster of ["mainnet", "devnet"]) {
    for (const k of ["dbc", "dammV2"]) {
      assert.ok(want[cluster][k], `${cluster} ${k} is in the script`);
      assert.equal(PINS[cluster][k].sha256, want[cluster][k].sha256, `${cluster} ${k}: the hash`);
      assert.equal(PINS[cluster][k].programId, want[cluster][k].programId, `${cluster} ${k}: the program id`);
      assert.equal(PINS[cluster][k].programData, await programDataAddress(PINS[cluster][k].programId), `${cluster} ${k}: the ProgramData address`);
    }
  }
  assert.deepEqual([PINS.mainnet.dbc.programId, PINS.mainnet.dammV2.programId], [PROGRAM_IDS.dbc, PROGRAM_IDS.damm]);
  assert.notEqual(PINS.mainnet.dbc.sha256, PINS.devnet.dbc.sha256, "devnet runs another build");
  assert.equal(PINS.mainnet.dbc.sha256, DBC_PROGRAM_SHA256, "src/sol/dbc-config-data.js (the expected PoolConfig bytes) was generated from the pinned mainnet build");
  const design = read("solana/LAUNCHPAD-DESIGN.md");
  for (const k of ["dbc", "dammV2"]) assert.ok(design.includes(PINS.mainnet[k].sha256), `LAUNCHPAD-DESIGN.md section 17 lists the ${k} pin`);
  assert.ok(Object.isFrozen(PINS) && Object.isFrozen(PINS.mainnet) && Object.isFrozen(PINS.mainnet.dbc));
});

test("fingerprint: the program bytes after the loader's 45-byte header, hashed like the admin tab hashes our own programs; not a ProgramData account, or not clearly all of one: null", async () => {
  const elf = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 255);
  const whole = (acc) => ({ ...acc, space: Buffer.from(acc.data, "base64").length }); // as the RPC answers: with the account's space
  const f = await fingerprint(whole(programDataAccount(addr(1), elf)));
  assert.deepEqual(f, { size: 1000, sha256: await sha256Hex(elf) });
  assert.deepEqual(await fingerprint(whole(programDataAccount(null, elf))), { size: 1000, sha256: await sha256Hex(elf) }, "a final program (no authority) hashes the same");
  assert.equal(await fingerprint(null), null);
  assert.equal(await fingerprint({ owner: PROGRAM_IDS.dbc, data: [b64(new Uint8Array(100)), "base64"], space: 100 }), null, "another owner");
  assert.equal(await fingerprint({ owner: PROGRAM_IDS.upgradeableLoader, data: [b64(new Uint8Array(44)), "base64"], space: 44 }), null, "too short");
  const acc = programDataAccount(addr(1), elf);
  assert.equal(await fingerprint({ data: acc.data, space: 45 + 1000 }), null, "an answer without its owner");
  assert.equal(await fingerprint({ ...acc, space: 45 + 1000 + 1 }), null, "fewer bytes than the account holds (cut short)");
  assert.equal(await fingerprint(acc), null, "an answer that does not say the account's space: it may be cut short, so not a fingerprint");
  assert.equal(await fingerprint({ ...acc, space: null }), null);
  assert.deepEqual(await fingerprint({ ...acc, space: 45 + 1000 }), { size: 1000, sha256: await sha256Hex(elf) }, "all of it");
});

test("programRefusal and programSummary: as tested → nothing; one or both programs changed → 409 with which and both fingerprints; nothing known → 503; never ok by default", () => {
  const ok = { ok: true, which: [], readAt: "2026-10-20T12:00:00.000Z", dbc: { sha256: "a".repeat(64), pinned: "a".repeat(64), ok: true }, dammV2: { sha256: "b".repeat(64), pinned: "b".repeat(64), ok: true } };
  assert.equal(programRefusal(ok), null);
  assert.deepEqual(programSummary(ok).state, "ok");
  const one = { ...ok, ok: false, which: ["dbc"], dbc: { sha256: "c".repeat(64), pinned: "a".repeat(64), ok: false } };
  const r1 = programRefusal(one);
  assert.deepEqual([r1.status, r1.error, r1.which], [409, "program_changed", ["dbc"]]);
  assert.equal(r1.message, `Meteora has updated its bonding-curve program since the team checked it (fingerprint now ${"c".repeat(12)}…, checked ${"a".repeat(12)}…). Approvals wait until the team re-tests it.`);
  assert.match(programRefusal(one, "Launches").message, /\. Launches wait until the team re-tests it\.$/);
  const both = { ...one, which: ["dbc", "dammV2"], dammV2: { sha256: "d".repeat(64), pinned: "b".repeat(64), ok: false } };
  assert.equal(programRefusal(both).message, `Meteora has updated its bonding-curve program and its DAMM v2 pool program since the team checked them (fingerprints now ${"c".repeat(12)}… / ${"d".repeat(12)}…, checked ${"a".repeat(12)}… / ${"b".repeat(12)}…). Approvals wait until the team re-tests them.`);
  assert.deepEqual([programSummary(both).state, programSummary(both).which], ["changed", ["dbc", "dammV2"]]);
  const none = { ok: false, unavailable: true, which: [], readAt: null, dbc: null, dammV2: null };
  const r3 = programRefusal(none);
  assert.deepEqual([r3.status, r3.error, r3.which], [503, "program_check_unavailable", []]);
  assert.match(r3.message, /could not be checked against the builds the team tested just now, so nothing was built/);
  assert.equal(programSummary(none).state, "unavailable");
  // a program that changed while the other could not be read: the change is a definite block
  const mixed = { ok: false, unavailable: true, which: ["dammV2"], readAt: null, dbc: null, dammV2: { sha256: "d".repeat(64), pinned: "b".repeat(64), ok: false } };
  assert.deepEqual([programRefusal(mixed).status, programRefusal(mixed).which], [409, ["dammV2"]]);
  assert.equal(programRefusal(undefined).status, 503, "no answer at all is not ok");
  assert.equal(programRefusal({}).status, 503);
});

test("the real pins, no stand-in: devnet pins on devnet, mainnet pins on mainnet; an unreadable chain or a site without the settings is unavailable", async () => {
  const bytes = new Uint8Array(512).fill(1);
  const [pdDbc, pdDamm] = [PINS.mainnet.dbc.programData, PINS.mainnet.dammV2.programData];
  const log = [];
  const fetchImpl = (down = false) => async (url, init) => {
    const body = JSON.parse(init.body);
    log.push({ url: String(url), method: body.method, params: body.params });
    if (down) throw new Error("network down");
    if (body.method !== "getMultipleAccounts") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unexpected" } }));
    const slice = body.params[1] && body.params[1].dataSlice;
    const data = (b64data) => (slice ? Buffer.from(b64data, "base64").subarray(slice.offset, slice.offset + slice.length).toString("base64") : b64data);
    const acc = (k) => ([pdDbc, pdDamm].includes(k) ? { owner: PROGRAM_IDS.upgradeableLoader, data: [data(programDataAccount(METEORA_AUTHORITY, bytes).data), "base64"], lamports: 1, executable: false, rentEpoch: 0, space: 45 + bytes.length } : null);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: body.params[0].map(acc) } }));
  };
  const got = await sha256Hex(bytes);
  const dev = await programHashes({ ...LP_ON }, fetchImpl(), Date.parse("2026-10-20T12:00:00Z"));
  assert.deepEqual([dev.cluster, dev.ok, dev.unavailable, dev.which], ["devnet", false, undefined, ["dbc", "dammV2"]]);
  assert.deepEqual([dev.dbc.pinned, dev.dammV2.pinned], [PINS.devnet.dbc.sha256, PINS.devnet.dammV2.sha256], "devnet's own builds");
  assert.deepEqual([dev.dbc.sha256, dev.dammV2.sha256, dev.dbc.size, dev.dbc.slot, dev.dbc.programData], [got, got, 512, "1234", pdDbc]);
  assert.equal(dev.readAt, "2026-10-20T12:00:00.000Z");
  assert.deepEqual(log.map((l) => [l.method, l.params[0], l.params[1].dataSlice || null]), [
    ["getMultipleAccounts", [pdDbc, pdDamm], { offset: 0, length: 45 }], // both deploy slots
    ["getMultipleAccounts", [pdDbc, pdDamm], null], // both programs, whole (slots new to this server)
  ], "one call for both headers, one for both programs, on the launchpad's RPC");
  assert.ok(log.every((l) => l.url.startsWith(LP_ON.LAUNCHPAD_RPC_URL)));
  assert.ok(Object.isFrozen(dev) && Object.isFrozen(dev.which) && Object.isFrozen(dev.dbc), "every caller shares the answer for ten minutes: nobody can change it");
  assert.throws(() => { dev.ok = true; }, TypeError);
  assert.throws(() => { dev.which.push("x"); }, TypeError);
  const mainnet = { LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(61), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(62), LAUNCHPAD_RPC_URL: "https://lp-rpc.test/mainnet" };
  const main = await programHashes(mainnet, fetchImpl(), Date.now());
  assert.deepEqual([main.cluster, main.dbc.pinned, main.dammV2.pinned, main.ok], ["mainnet", PINS.mainnet.dbc.sha256, PINS.mainnet.dammV2.sha256, false]);
  // the chain unreadable: unavailable, nothing cached (asked again), never ok
  const down = await programHashes({ ...mainnet, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/other" }, fetchImpl(true), Date.now());
  assert.deepEqual([down.ok, down.unavailable, down.which, down.readAt, down.dbc.sha256, down.dbc.pinned], [false, true, [], null, null, PINS.mainnet.dbc.sha256]);
  const n = log.length;
  await programHashes({ ...mainnet, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/other" }, fetchImpl(true), Date.now());
  assert.equal(log.length, n + 1, "a failed read is asked again");
  // no settings (the gate off): unavailable without a read
  const off = await programHashes({}, fetchImpl(), Date.now());
  assert.deepEqual([off.ok, off.unavailable, off.dbc], [false, true, null]);
  assert.equal(log.length, n + 1);
});

/* ---------------------------------------------------------------- the owner's approvals */
test("as tested: the approval builds; status and candidates say ok with the time; the allow-list step is refused only for its own reasons; one read", async () => {
  const w = await adminWorld();
  const st = (await w.call("/api/admin/lp/status")).data;
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.deepEqual([st.meteora.state, st.meteora.which, st.meteora.message], ["ok", [], null]);
  assert.equal(st.meteora.checkedAt, "2026-10-20T12:00:00.000Z");
  assert.deepEqual([st.meteora.dbc.sha256, st.meteora.dbc.pinned, st.meteora.dbc.ok, st.meteora.dammV2.sha256, st.meteora.dammV2.ok], [w.hashes.dbc, w.hashes.dbc, true, w.hashes.dammV2, true]);
  const c = await w.card();
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal((await w.call("/api/admin/lp/candidates")).data.meteora.state, "ok");
  const b = await w.approve();
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.ok, true);
  assert.ok(b.data.tx, "a transaction to sign");
  assert.equal(b.data.approve.symbol, "NYC");
  // step 4 (the allow-list) is checked the same way, on one reading of its own, before anything else; here it then says what the
  // chain says (the entry exists). A step that does not depend on Meteora's programs does not read them for its build.
  const h = w.heads();
  assert.equal((await w.call("/api/admin/lp/tx", { step: "allow" })).data.error, "already_done");
  assert.equal(w.heads(), h + 1, "step 4 read the deploy slots once, itself");
  await w.call("/api/admin/lp/tx", { step: "referral" });
  assert.equal(w.heads(), h + 1, "the other steps keep the pages' answer");
  assert.equal(w.reads(), 1, "both programs read whole once, for every request in these ten minutes");
  assert.deepEqual((await w.call("/api/admin/lp/pins")).data, { ok: true, cluster: "devnet", meteora: st.meteora });
});

test("Meteora's bonding-curve program differs: approve/tx is 409 program_changed with which=[dbc] and both fingerprints, nothing is built; the allow-list step too; the status line and the candidates say changed", async () => {
  const w = await adminWorld();
  w.S.accounts[w.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  const before = w.S.log.length;
  const r = await w.approve();
  assert.deepEqual([r.status, r.data.ok, r.data.error, r.data.which, r.data.cityId], [409, false, "program_changed", ["dbc"], NYC]);
  assert.equal(r.data.message, `Meteora has updated its bonding-curve program since the team checked it (fingerprint now ${(await sha256Hex(NEWER)).slice(0, 12)}…, checked ${w.hashes.dbc.slice(0, 12)}…). Approvals wait until the team re-tests it.`);
  assert.equal(r.data.tx, undefined);
  assert.equal(built(w.S, before), 0, "nothing was built or simulated");
  const a = await w.call("/api/admin/lp/tx", { step: "allow" });
  assert.deepEqual([a.status, a.data.error, a.data.which, a.data.step], [409, "program_changed", ["dbc"], "allow"]);
  assert.equal(built(w.S, before), 0);
  const st = (await w.call("/api/admin/lp/status")).data;
  assert.deepEqual([st.meteora.state, st.meteora.which], ["changed", ["dbc"]]);
  assert.deepEqual([st.meteora.dbc.sha256, st.meteora.dbc.pinned, st.meteora.dbc.ok, st.meteora.dammV2.ok], [await sha256Hex(NEWER), w.hashes.dbc, false, true]);
  assert.equal(st.meteora.message, r.data.message);
  const list = (await w.call("/api/admin/lp/candidates")).data;
  assert.equal(list.meteora.state, "changed");
  assert.equal(list.candidates.find((c) => c.cityId === NYC).ok, true, "the city itself is fine: the hold is Meteora's, said on the button");
  // revoking is not held (it takes an approval back; there is none here)
  assert.equal((await w.call("/api/admin/lp/revoke/tx", { cityId: NYC })).data.error, "no_approval");
});

test("DAMM v2 differs: which=[dammV2]; both differ: both named, plural fingerprints", async () => {
  const w = await adminWorld();
  w.S.accounts[w.pdDamm] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  let r = await w.approve();
  assert.deepEqual([r.status, r.data.error, r.data.which], [409, "program_changed", ["dammV2"]]);
  assert.match(r.data.message, /^Meteora has updated its DAMM v2 pool program since the team checked it \(fingerprint now [0-9a-f]{12}…, checked [0-9a-f]{12}…\)\. Approvals wait/);
  w.S.accounts[w.pdDbc] = programDataAccount(METEORA_AUTHORITY, new Uint8Array(100).fill(3), LATER + 1);
  r = await w.approve(); // a build reads the deploy slots again: no ten-minute wait
  assert.deepEqual([r.status, r.data.which], [409, ["dbc", "dammV2"]]);
  assert.match(r.data.message, /^Meteora has updated its bonding-curve program and its DAMM v2 pool program since the team checked them \(fingerprints now [0-9a-f]{12}… \/ [0-9a-f]{12}…, checked [0-9a-f]{12}… \/ [0-9a-f]{12}…\)\. Approvals wait until the team re-tests them\.$/);
});

test("the chain cannot be read (a program account missing, or the RPC down): approve/tx is 503 program_check_unavailable, never an approval blind; the status line says could not be checked", async () => {
  const w = await adminWorld();
  const seen = await w.card(); // what the card showed (and the RPC answered once: its genesis hash is remembered)
  assert.equal(seen.ok, true);
  delete w.S.accounts[w.pdDamm];
  advance(CACHE_MS + 1000);
  const before = w.S.log.length;
  let r = await w.approve(seen);
  assert.deepEqual([r.status, r.data.ok, r.data.error, r.data.which], [503, false, "program_check_unavailable", []]);
  assert.match(r.data.message, /Meteora's programs could not be checked against the builds the team tested just now, so nothing was built\. Approvals wait/);
  assert.equal(built(w.S, before), 0);
  const st = (await w.call("/api/admin/lp/status")).data;
  assert.deepEqual([st.meteora.state, st.meteora.which, st.meteora.checkedAt], ["unavailable", [], null]);
  assert.deepEqual([st.meteora.dbc.sha256, st.meteora.dammV2.sha256, st.meteora.dammV2.pinned], [w.hashes.dbc, null, w.hashes.dammV2]);
  assert.equal((await w.call("/api/admin/lp/candidates")).data.meteora.state, "unavailable");
  // the node down altogether
  w.S.accounts[w.pdDamm] = programDataAccount(METEORA_AUTHORITY, new Uint8Array(2048).fill(0x22));
  w.S.down = true;
  r = await w.approve(seen);
  assert.deepEqual([r.status, r.data.error], [503, "program_check_unavailable"]);
  // back: the next request reads again (a failure is never kept) and the approval builds
  w.S.down = false;
  r = await w.approve(seen);
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("the pages keep the check ten minutes per server; every build reads the deploy slots again, so an upgrade a minute ago is refused at once; whole programs are read only for a new slot", async () => {
  const w = await adminWorld();
  await w.call("/api/admin/lp/status");
  await w.call("/api/admin/lp/status");
  await w.call("/api/admin/lp/candidates");
  assert.deepEqual([w.heads(), w.reads()], [1, 1], "the pages: one check (the slots, then both programs, new to this server), remembered");
  assert.equal((await w.approve()).status, 200);
  assert.deepEqual([w.heads(), w.reads()], [2, 1], "the approval read the slots again (the same ones: the programs are not read again)");
  advance(CACHE_MS - 1000);
  assert.equal((await w.call("/api/admin/lp/status")).data.meteora.state, "ok");
  assert.deepEqual([w.heads(), w.reads()], [2, 1], "within ten minutes of the last check: remembered, no RPC call");
  // Meteora upgrades its bonding curve: the pages may show the answer of a moment ago (at most ten minutes old)...
  w.S.accounts[w.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  assert.equal((await w.call("/api/admin/lp/status")).data.meteora.state, "ok");
  // ...but nothing is built on it: the very next approval and step 4 see the new slot, read that one program and refuse
  const before = w.S.log.length;
  const r = await w.approve();
  assert.deepEqual([r.status, r.data.error, r.data.which], [409, "program_changed", ["dbc"]]);
  assert.equal(built(w.S, before), 0);
  assert.deepEqual([w.heads(), w.reads(), w.full()], [3, 2, [w.pdDbc]], "only the upgraded program was read whole");
  assert.equal((await w.call("/api/admin/lp/tx", { step: "allow" })).data.error, "program_changed");
  assert.deepEqual([w.heads(), w.reads()], [4, 2], "its slot is known now: no second whole read");
  // the pages now remember what the builds saw, without another read
  assert.equal((await w.call("/api/admin/lp/status")).data.meteora.state, "changed");
  assert.deepEqual([w.heads(), w.reads()], [4, 2]);
  // after ten minutes the pages read the slots again; the programs, whose slots are known, are not read whole again
  advance(CACHE_MS + 1000);
  assert.equal((await w.call("/api/admin/lp/status")).data.meteora.state, "changed");
  assert.deepEqual([w.heads(), w.reads()], [5, 2]);
});

/** How often Meteora's programs were read on `lp`: their 45-byte headers (the deploy slots), and whole. */
const headReads = (lp) => lp.S.log.filter((l) => l.method === "getMultipleAccounts" && l.params[1] && l.params[1].dataSlice).length;
const wholeReads = (lp, pd) => lp.S.log.filter((l) => l.method === "getMultipleAccounts" && !(l.params[1] && l.params[1].dataSlice) && l.params[0].includes(pd)).length;
/** `fetchImpl` whose answers arrive only once `open()` is called (each answer is what the chain held when it was asked). */
function held(fetchImpl) {
  let open;
  const gate = new Promise((r) => { open = r; });
  return { fetchImpl: async (url, init) => { const r = await fetchImpl(url, init); await gate; return r; }, open: () => open() };
}
/** `fetchImpl` with each getMultipleAccounts account passed through change(account, address, sliced) (a node that answers oddly). */
const reshape = (fetchImpl, change) => async (url, init) => {
  const r = await fetchImpl(url, init);
  const body = JSON.parse(init.body);
  if (body.method !== "getMultipleAccounts") return r;
  const j = await r.json();
  if (j.result && Array.isArray(j.result.value)) j.result.value = j.result.value.map((a, i) => change(a, body.params[0][i], Boolean(body.params[1] && body.params[1].dataSlice)));
  return new Response(JSON.stringify(j));
};
const T0 = Date.parse("2026-10-20T12:00:00Z");

test("programHashes: pages share a read under way; a build never joins one (it reads the deploy slots itself); a read through the backup alone (lpkit checkedRoute `only`) keeps neither its answer nor the program bytes", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  const slow = held(lp.fetchImpl);
  const pages = [programHashes({ ...LP_ON }, slow.fetchImpl, T0), programHashes({ ...LP_ON }, slow.fetchImpl, T0)];
  const build = programHashes({ ...LP_ON }, slow.fetchImpl, T0, { fresh: true });
  await tick();
  assert.equal(headReads(lp), 2, "one read for the two pages, one for the build");
  slow.open();
  const [a, b] = await Promise.all(pages);
  const c = await build;
  assert.equal(a, b, "the second page waited for the first page's read");
  assert.notEqual(c, a, "the build did not");
  assert.deepEqual([a.ok, c.ok, a.dbc.sha256, c.dbc.sha256], [true, true, m.hashes.dbc, m.hashes.dbc]);
  const later = await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 1000);
  assert.ok(later === a || later === c, "then remembered");
  assert.equal(headReads(lp), 2);
  // only the backup passed the genesis check: read there, every time; its answer and the bytes are not remembered (its deploy slots
  // are, like every reading's: "a build through the backup alone ... read a newer deploy", below)
  _resetProgramPins(); await meteoraAsTested(lp.S.accounts);
  const route = { cluster: "devnet", url: LP_ON.LAUNCHPAD_RPC_URL, only: "devnet" };
  const before = wholeReads(lp, m.pdDbc);
  const o = await programHashes({ ...LP_ON }, lp.fetchImpl, T0, { route });
  assert.equal(o.ok, true);
  assert.equal(headReads(lp), 3);
  await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 1000);
  assert.equal(headReads(lp), 4, "the plain read after it asked again");
  assert.equal(wholeReads(lp, m.pdDbc), before + 2, "and read the programs whole again: no bytes from the backup-only read were kept");
});

test("an upgrade while a page's read is under way (the build in the same millisecond): the build reads for itself and is refused; the page's older reading, finished last, is unavailable and never replaces the build's answer", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  await programHashes({ ...LP_ON }, lp.fetchImpl, T0); // the pages' check: as tested, slot 1234 known
  // ten minutes on a page asks again; the node answers as the chain is (slot 1234), but the answer is slow to arrive
  const at = T0 + CACHE_MS + 1;
  const slow = held(lp.fetchImpl);
  const page = programHashes({ ...LP_ON }, slow.fetchImpl, at);
  await tick();
  // Meteora upgrades its bonding curve, then the owner's approval (or a founder's launch) arrives, in the same millisecond
  lp.S.accounts[m.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  const build = await programHashes({ ...LP_ON }, lp.fetchImpl, at, { fresh: true });
  assert.deepEqual([build.ok, build.which, build.dbc.slot, programRefusal(build).status], [false, ["dbc"], String(LATER), 409], "its own read, after the upgrade");
  slow.open();
  const p = await page;
  assert.deepEqual([p.ok, p.unavailable, p.which, programRefusal(p).status], [false, true, [], 503], "slot 1234 is older than the deploy this server has read since: not the program that runs now");
  const heads = headReads(lp);
  const next = await programHashes({ ...LP_ON }, lp.fetchImpl, at + 1);
  assert.equal(next, build, "the pages keep the build's answer");
  assert.equal(headReads(lp), heads);
});

test("a read that ends while a build's read is still under way leaves the build's in place: a page that comes then waits for the build's", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  await programHashes({ ...LP_ON }, lp.fetchImpl, T0 - CACHE_MS - 1); // slot 1234 known: a page then reads only the deploy slots
  const pageRead = held(lp.fetchImpl), buildRead = held(lp.fetchImpl);
  const page = programHashes({ ...LP_ON }, pageRead.fetchImpl, T0);
  await tick();
  lp.S.accounts[m.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  const build = programHashes({ ...LP_ON }, buildRead.fetchImpl, T0 + 1, { fresh: true });
  await tick();
  pageRead.open();
  assert.equal((await page).ok, true, "read before the upgrade");
  const heads = headReads(lp);
  const late = programHashes({ ...LP_ON }, lp.fetchImpl, T0 + CACHE_MS + 1); // the page's answer too old by now
  await tick();
  assert.equal(headReads(lp), heads, "it waits for the build's read under way instead of reading again");
  buildRead.open();
  const [b, l] = await Promise.all([build, late]);
  assert.equal(l, b);
  assert.deepEqual([b.which, programRefusal(b).status], [["dbc"], 409]);
});

test("a node that lags: the deploy slot says Meteora upgraded but the whole program comes back older (a backup after a 429, a load-balanced backend): unavailable, never ok, and nothing of it kept", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  lp.S.accounts[m.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER); // the chain: upgraded
  const tested = programDataAccount(METEORA_AUTHORITY, new Uint8Array(4096).fill(0x11)); // what the lagging node still holds (slot 1234)
  const lagging = reshape(lp.fetchImpl, (a, address, sliced) => (a && !sliced && address === m.pdDbc ? { ...a, data: [tested.data, "base64"] } : a));
  const h = await programHashes({ ...LP_ON }, lagging, T0, { fresh: true });
  assert.deepEqual([h.ok, h.unavailable, h.which, h.dbc.sha256, h.dammV2.ok], [false, true, [], null, true]);
  assert.equal(programRefusal(h).status, 503);
  // a healthy answer next: the program is read whole again (the old bytes were kept under no slot) and the upgrade is seen
  const whole = wholeReads(lp, m.pdDbc);
  const next = await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 1, { fresh: true });
  assert.deepEqual([next.ok, next.which, next.dbc.slot, programRefusal(next).status], [false, ["dbc"], String(LATER), 409]);
  assert.equal(wholeReads(lp, m.pdDbc), whole + 1);
  // bytes NEWER than the slot just read (an upgrade between the two reads) are the program running now: judged on them
  _resetProgramPins(); await meteoraAsTested(lp.S.accounts);
  const between = reshape(lp.fetchImpl, (a, address, sliced) => (a && !sliced && address === m.pdDbc ? { ...a, data: [programDataAccount(METEORA_AUTHORITY, NEWER, LATER).data, "base64"] } : a));
  const u = await programHashes({ ...LP_ON }, between, T0 + 2, { fresh: true });
  assert.deepEqual([u.which, u.dbc.slot, programRefusal(u).status], [["dbc"], String(LATER), 409]);
});

test("a whole program cut short (fewer bytes than the account's space): unavailable, and not kept, so the next read is not stuck on a wrong hash", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  const withSpace = (cut) => reshape(lp.fetchImpl, (a, address, sliced) => {
    if (!a || sliced || ![m.pdDbc, m.pdDamm].includes(address)) return a;
    const all = Buffer.from(a.data[0], "base64");
    return { ...a, data: [(cut ? all.subarray(0, 1000) : all).toString("base64"), "base64"], space: all.length };
  });
  const h = await programHashes({ ...LP_ON }, withSpace(true), T0, { fresh: true });
  assert.deepEqual([h.ok, h.unavailable, h.which, programRefusal(h).status], [false, true, [], 503], "not a changed program: an unknown one");
  const next = await programHashes({ ...LP_ON }, withSpace(false), T0 + 1, { fresh: true });
  assert.deepEqual([next.ok, next.which, next.dbc.sha256, next.dbc.size, programRefusal(next)], [true, [], m.hashes.dbc, 4096, null]);
  // a node that does not say the account's space and cuts the program short: not "changed" (and kept as such), unavailable
  _resetProgramPins(); await meteoraAsTested(lp.S.accounts);
  const noSpace = reshape(lp.fetchImpl, (a, address, sliced) => {
    if (!a || sliced || ![m.pdDbc, m.pdDamm].includes(address)) return a;
    const { space, ...rest } = a;
    return { ...rest, data: [Buffer.from(a.data[0], "base64").subarray(0, 1000).toString("base64"), "base64"] };
  });
  const cut = await programHashes({ ...LP_ON }, noSpace, T0 + 2, { fresh: true });
  assert.deepEqual([cut.ok, cut.unavailable, cut.which, programRefusal(cut).status], [false, true, [], 503]);
  const after = await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 3, { fresh: true });
  assert.deepEqual([after.ok, programRefusal(after)], [true, null], "nothing of the cut answer was kept");
});

test("a node that lags on the deploy slot itself, after this server has read the newer deploy (a backup after a 429, a load-balanced backend): unavailable, never ok; the approval and the founder's launch are not built", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  const tested = lp.S.accounts[m.pdDbc];
  /** a node that has not seen DBC's latest deploy: it answers both reads with the tested build (slot 1234) */
  const behind = (fetchImpl) => reshape(fetchImpl, (a, address) => (a && address === m.pdDbc ? { ...a, data: [tested.data, "base64"], space: Buffer.from(tested.data, "base64").length } : a));
  assert.equal((await programHashes({ ...LP_ON }, lp.fetchImpl, T0, { fresh: true })).ok, true, "the tested build, hashed and remembered at slot 1234");
  lp.S.accounts[m.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  const seen = await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 1, { fresh: true });
  assert.equal(programRefusal(seen).status, 409, "the upgrade, read and refused");
  const lag = await programHashes({ ...LP_ON }, behind(lp.fetchImpl), T0 + 2, { fresh: true });
  assert.deepEqual([lag.ok, lag.unavailable, lag.which, programRefusal(lag).status], [false, true, [], 503], "slot 1234 after slot 9000 was read: a node behind, not a rollback");
  assert.equal(await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 3), seen, "the pages keep the newer reading");

  // the same through the routes: the owner presses Approve again after the 409, the founder Launch
  const w = await adminWorld();
  assert.equal((await w.approve()).status, 200);
  w.S.accounts[w.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  assert.equal((await w.approve()).data.error, "program_changed");
  const real = w.lp.fetchImpl;
  w.lp.fetchImpl = behind(real);
  const before = w.S.log.length;
  const r = await w.approve();
  assert.deepEqual([r.status, r.data.error], [503, "program_check_unavailable"]);
  assert.equal(built(w.S, before), 0);
  w.lp.fetchImpl = real;
  assert.equal((await w.approve()).data.error, "program_changed", "the node that answers clearly again: the upgrade");

  const f = await founderWorld(); // (a new world: what this server remembered is forgotten)
  assert.equal((await f.launch()).status, 200);
  f.S.accounts[f.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  assert.equal((await f.launch()).data.error, "program_changed");
  f.lp.fetchImpl = behind(f.lp.fetchImpl);
  const fb = f.S.log.length;
  const l = await f.launch();
  assert.deepEqual([l.status, l.data.error], [503, "program_check_unavailable"]);
  assert.equal(built(f.S, fb), 0);
});

test("a build through the backup alone (lpkit checkedRoute `only`) that read a newer deploy: its answer and bytes are not kept, but its deploy slot is, so the next build through a first node that still lags is unavailable, never ok", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  const tested = lp.S.accounts[m.pdDbc];
  assert.equal((await programHashes({ ...LP_ON }, lp.fetchImpl, T0, { fresh: true })).ok, true, "the tested build at slot 1234, through the first node");
  // Meteora upgrades DBC; the first node misses its genesis check once, so a build reads through the backup alone, which has the upgrade
  lp.S.accounts[m.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  const route = { cluster: "devnet", url: LP_ON.LAUNCHPAD_RPC_URL, only: "devnet" };
  const o = await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 1, { fresh: true, route });
  assert.deepEqual([o.which, o.dbc.slot, programRefusal(o).status], [["dbc"], String(LATER), 409]);
  // the next build goes through the first node again, which still answers the tested build (slot 1234) on both reads
  const behind = reshape(lp.fetchImpl, (a, address) => (a && address === m.pdDbc ? { ...a, data: [tested.data, "base64"], space: Buffer.from(tested.data, "base64").length } : a));
  const next = await programHashes({ ...LP_ON }, behind, T0 + 2, { fresh: true });
  assert.deepEqual([next.ok, next.unavailable, next.which, programRefusal(next).status], [false, true, [], 503], "slot 1234 after this server read slot 9000: a node behind");
  // and once the first node has the upgrade: the upgrade, refused
  assert.deepEqual(programRefusal(await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 3, { fresh: true })).which, ["dbc"]);
});

test("mainnet approve/tx: a build through the backup alone (the first node missed its genesis check) sees Meteora's upgrade and is refused; the next build, through a first node that still lags, is 503, never past the check", async () => {
  useClock("2026-10-20T12:00:00Z");
  const FIRST = "https://lp-first.test/", BACKUP = "https://lp-backup.test/";
  const env = { ...newWorld(), LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(1), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(2), LAUNCHPAD_RPC_URL: FIRST, SOLANA_RPC_URL: "https://site-rpc.test/", SOLANA_RPC_URL_BACKUP: BACKUP };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const first = lpChain({ genesis: GENESIS.mainnet }), backup = lpChain({ genesis: GENESIS.mainnet });
  const m = await meteoraAsTested(first.S.accounts, { cluster: "mainnet" });
  await meteoraAsTested(backup.S.accounts, { cluster: "mainnet" });
  const main = mainChain();
  let busy = 0; // how many genesis checks the first node answers with a plain 429
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith(FIRST)) return JSON.parse(init.body).method === "getGenesisHash" && busy-- > 0 ? new Response("Too Many Requests", { status: 429 }) : first.fetchImpl(url, init);
    return u.startsWith(BACKUP) ? backup.fetchImpl(url, init) : main(url, init);
  };
  const approve = async () => {
    const r = await owner.send("/api/admin/lp/approve/tx", { method: "POST", body: { cluster: "mainnet", cityId: NYC, name: "Big Apple", symbol: "NYC", founder: addr(7), designAt: "2026-10-09T08:00:00.000Z", expiryDays: 7 }, fetchImpl });
    const d = await r.json();
    return [r.status, d.error];
  };
  assert.deepEqual(await approve(), [404, "not_a_candidate"], "as tested: past the Meteora check (then refused for its own reason: no coin design here)");
  // a new server (nothing remembered, the first node's genesis neither); Meteora upgrades DBC: the backup has it, the first node lags
  _resetLpKit(); _resetRpcHealth(); _resetLpAdmin();
  backup.S.accounts[m.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  busy = 1;
  const firstCalls = first.S.log.length;
  assert.deepEqual(await approve(), [409, "program_changed"], "read through the backup alone: the upgrade");
  assert.equal(first.S.log.length, firstCalls, "nothing of that build was read on the first node");
  // the next build: the first node passes its genesis check now and still holds deploy 1234
  assert.deepEqual(await approve(), [503, "program_check_unavailable"], "older than the deploy this server read: unclear, not as tested");
  first.S.accounts[m.pdDbc] = backup.S.accounts[m.pdDbc];
  assert.deepEqual(await approve(), [409, "program_changed"], "the first node caught up");
});

test("an answer that names no owner is not a reading of Meteora's program: unavailable, also when its deploy slot is one this server knows", async () => {
  const lp = lpChain();
  const m = await meteoraAsTested(lp.S.accounts);
  const noOwner = reshape(lp.fetchImpl, (a, address) => (a && address === m.pdDbc ? { ...a, owner: undefined } : a));
  const h = await programHashes({ ...LP_ON }, noOwner, T0, { fresh: true });
  assert.deepEqual([h.ok, h.unavailable, programRefusal(h).status], [false, true, 503]);
  assert.equal((await programHashes({ ...LP_ON }, lp.fetchImpl, T0 + 1, { fresh: true })).ok, true, "slot 1234 known now");
  const again = await programHashes({ ...LP_ON }, noOwner, T0 + 2, { fresh: true });
  assert.deepEqual([again.ok, again.unavailable, programRefusal(again).status], [false, true, 503]);
});

/* ---------------------------------------------------------------- the founder's launch */
const FOUNDER_CHANGED = "Meteora has updated its programs since the team tested them. Launches wait until the team re-tests them; your approval stays.";
test("the founder's launch: as tested it builds; an upgrade a moment ago is 409 program_changed (state paused) at once and the status card says why, in a founder's words; unreadable is 503", async () => {
  const w = await founderWorld();
  assert.equal((await w.status()).data.state, "ready");
  let r = await w.launch();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.tx);
  w.S.accounts[w.pdDbc] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER);
  const before = w.S.log.length;
  r = await w.launch(); // the launch reads the deploy slots again: no ten-minute wait
  assert.deepEqual([r.status, r.data.ok, r.data.error, r.data.which, r.data.state], [409, false, "program_changed", ["dbc"], "paused"]);
  assert.equal(r.data.message, FOUNDER_CHANGED, "no fingerprints for a founder; their approval stays");
  assert.equal(built(w.S, before), 0, "nothing was built or simulated");
  const s = (await w.status()).data;
  assert.deepEqual([s.state, s.why, s.message], ["paused", "program_changed", FOUNDER_CHANGED]);
  assert.equal(s.quote, undefined);
  w.S.accounts[w.pdDbc] = programDataAccount(METEORA_AUTHORITY, new Uint8Array(4096).fill(0x11), LATER + 1); // the tested bytes again
  w.S.accounts[w.pdDamm] = programDataAccount(METEORA_AUTHORITY, NEWER, LATER + 1);
  r = await w.launch();
  assert.deepEqual([r.status, r.data.error, r.data.which], [409, "program_changed", ["dammV2"]]);
  delete w.S.accounts[w.pdDamm];
  r = await w.launch();
  assert.deepEqual([r.status, r.data.error, r.data.state], [503, "program_check_unavailable", "paused"]);
  assert.equal(r.data.message, "Meteora's programs could not be checked just now. Launches wait until the check works again; your approval stays. Try again in a minute.");
  advance(CACHE_MS + 1000); // the card's answer is kept ten minutes (a failure never is)
  assert.deepEqual([(await w.status()).data.state, (await w.status()).data.why], ["paused", "program_check_unavailable"]);
  // the other reasons come first: an expired approval says expired, not Meteora
  w.S.accounts[await launchpadPdas(PROGRAM).approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, expiresAt: Math.floor(Date.now() / 1000) - 5 });
  assert.deepEqual([(await w.status()).data.state, (await w.launch()).data.error], ["expired", "approval_expired"]);
});

/* ---------------------------------------------------------------- the admin page */
const step = (id, n, state, reason) => ({ id, n, title: `Title ${id}`, state, reason });
const statusOf = (meteora, paused = false) => ({
  ok: true, cluster: "mainnet", wallet: OWNER, devWallet: ADDRESSES.feeRecipient, isDevWallet: false,
  programs: { launchpad: { id: addr(1), exists: true, executable: true, upgradeable: true, upgradeAuthority: OWNER, size: 10, sha256: "ab".repeat(32) }, rewards: { id: addr(2), exists: true, executable: true, upgradeable: true, upgradeAuthority: OWNER, size: 10, sha256: "cd".repeat(32) } },
  launchpad: { admin: OWNER, launchesPaused: paused }, problems: [], complete: false, meteora,
  steps: [step("start", 1, "done", "Running."), step("handoff", 2, "done", "Handed over."), step("config", 3, "done", "Matches."), step("allow", 4, "blocked", "Wait."), step("referral", 5, "done", "Exists."), step("lookup", 6, "done", "Full."), step("partner", 7, "blocked", "Dev wallet only.")],
});
const candidatesOf = (meteora) => ({
  ok: true, global: [], paused: false, approvals: [], launched: [], meteora,
  candidates: [
    { cityId: NYC, cityName: "New York City", country: "US", name: "Big Apple", ticker: "NYC", symbol: "NYC", pair: "SOL", founder: addr(7), handle: "nyc", pitch: "", logo: false, designAt: "2026-10-09T08:00:00.000Z", ok: true, reasons: [], warnings: [] },
    { cityId: "5140405", cityName: "Syracuse", country: "US", name: "Salt City", ticker: "SYRACUSE", pair: "USDC", founder: addr(8), ok: false, reasons: ["The coin is paired with USDC; only SOL-paired coins can launch on the Vicinity curve for now. The founder must pick SOL."], warnings: [] },
  ],
});
const OK = { state: "ok", which: [], checkedAt: "2026-10-20T12:05:00.000Z", message: null, dbc: { sha256: "a".repeat(64), pinned: "a".repeat(64), ok: true }, dammV2: { sha256: "b".repeat(64), pinned: "b".repeat(64), ok: true } };
const CHANGED_MSG = `Meteora has updated its bonding-curve program since the team checked it (fingerprint now ${"c".repeat(12)}…, checked ${"a".repeat(12)}…). Approvals wait until the team re-tests it.`;
const CHANGED = { ...OK, state: "changed", which: ["dbc"], message: CHANGED_MSG, dbc: { sha256: "c".repeat(64), pinned: "a".repeat(64), ok: false } };
const UNAVAILABLE = { state: "unavailable", which: [], checkedAt: null, message: "Meteora's programs could not be checked against the builds the team tested just now, so nothing was built. Approvals wait until the check works again; try again in a minute.", dbc: null, dammV2: null };

/** The City coins tab (public/admin-lp.js) with a stand-in API: `meteora` is what status and candidates carry. */
async function lpTab(meteora, { paused = false } = {}) {
  const page = await openPage("admin.html", { agreed: "2026-10-01" });
  const win = page.window;
  win.setTimeout = (fn) => { setImmediate(fn); return 0; };
  const answers = { "/api/admin/lp": { ok: true, cluster: "mainnet" }, "/api/admin/lp/status": statusOf(meteora, paused), "/api/admin/lp/candidates": { ...candidatesOf(meteora), paused } };
  const api = async (path) => answers[path.replace(/[?&]cluster=[a-z]+/, "").split("?")[0]] || { ok: false, error: "not_found" };
  win.LP = { supported: async () => true, say: (code, extra) => (extra && extra.message) || `said:${code}`, renderSummary() {}, prepare: async () => { throw new Error("not in this test"); } };
  vm.runInContext(read("public/admin-lp.js"), win, { filename: "public/admin-lp.js" });
  const panel = page.doc.createElement("div");
  page.doc.body.append(panel);
  await win.AdminLP.mount(panel, { api, post: api, toast() {}, el: win.V.el, short: win.V.short, me: { wallet: OWNER, role: "owner" }, wallet: async () => ({ address: OWNER }) });
  await tick();
  return { panel, text: () => panel.textContent, button: (label) => panel.querySelectorAll("button").find((b) => b.textContent === label), line: () => panel.querySelector(".lp-pins") };
}

test("the City coins tab: a standing line above the steps (as tested with the time / changed: which / could not be checked), and the Approve button carries the hold", async () => {
  const CSS = read("public/admin.css");
  for (const cls of ["lp-pins", "lp-pins--changed", "lp-pins--unavailable", "lp-hold"]) assert.match(CSS, new RegExp(`\\.${cls}\\b`), cls);
  let t = await lpTab(OK);
  const line = t.line();
  assert.ok(line && line.classList.contains("lp-pins--ok"), "the line sits in the Setup section");
  assert.equal(line.getAttribute("role"), "status");
  assert.match(line.textContent, /^Meteora programs: as tested \(checked \d{1,2}:\d{2}( [AP]M)?\)\.$/);
  assert.equal(t.panel.querySelectorAll(".lp-step").length, 8, "the line is not a step");
  assert.ok(t.text().indexOf("Meteora programs:") < t.text().indexOf("Title start"), "above the steps");
  let approve = t.button("Approve on chain");
  assert.ok(approve && !approve.disabled, "approving is on");
  assert.equal(t.panel.querySelector(".lp-hold"), null);

  const PAUSE_TOO = " Founders who already hold an approval could still launch with other tools; to stop that too, press Pause launches below.";
  t = await lpTab(CHANGED);
  assert.ok(t.line().classList.contains("lp-pins--changed"));
  assert.equal(t.line().textContent, `Meteora programs changed: bonding-curve program. Approvals and launches wait until the team re-tests it.${PAUSE_TOO}`, "short; the fingerprints are on the held button");
  assert.ok(t.button("Pause launches"), "the button the line points to is below");
  approve = t.button("Approve on chain");
  assert.equal(approve.disabled, true, "the button is off");
  assert.equal(approve.title, CHANGED_MSG);
  const hold = t.panel.querySelector(".lp-hold");
  assert.equal(hold.textContent, CHANGED_MSG, "the reason, next to the button");
  assert.equal(approve.getAttribute("aria-describedby"), hold.id);
  assert.match(t.text(), /Not yet:.*paired with USDC/, "a city blocked for its own reasons still says them");

  t = await lpTab({ ...CHANGED, which: ["dbc", "dammV2"] }, { paused: true });
  assert.equal(t.line().textContent, "Meteora programs changed: bonding-curve program and DAMM v2 pool program. Approvals and launches wait until the team re-tests them.", "launches already paused: nothing more to press");

  t = await lpTab(UNAVAILABLE);
  assert.ok(t.line().classList.contains("lp-pins--unavailable"));
  assert.equal(t.line().textContent, `Meteora programs: could not be checked. Approvals and launches wait until the check works again; reload in a minute.${PAUSE_TOO}`);
  approve = t.button("Approve on chain");
  assert.equal(approve.disabled, true);
  assert.match(t.panel.querySelector(".lp-hold").textContent, /Meteora's programs could not be checked just now, so approvals wait\. Reload in a minute\./);

  // a server without the field (an older build) reads as "could not be checked", never as fine
  t = await lpTab(undefined);
  assert.ok(t.line().classList.contains("lp-pins--unavailable"));
  assert.equal(t.button("Approve on chain").disabled, false, "no hold is sent, so nothing can be said about it; the server refuses anyway");
});

/** The admin page (public/admin.js) signed in as the owner on the Overview, with every /api answer from `A`. */
async function overview(over = {}) {
  const page = await openPage("admin.html", { agreed: "2026-10-01" });
  const win = page.window, doc = page.doc;
  const A = {
    "/api/me": { ok: true, signedIn: true, user: { handle: "boss", wallet: OWNER } },
    "/api/admin/me": { ok: true, wallet: OWNER, role: "owner" },
    "/api/admin/config": { ok: true, siteMode: "live", policyVersion: 3, grantedRoles: 1, auditRows: 9, flags: {}, cityCoins: true },
    "/api/admin/lp": { ok: true, cluster: "mainnet" },
    "/api/admin/lp/pins": { ok: true, cluster: "mainnet", meteora: OK },
    "/api/admin/overview": { ok: true, users: 12, seats: {}, openElections: 0, pendingReports: 0, pendingObjections: 0, pendingLogos: 0, registeredTokens: 0, launchedCityCoins: 0, snapshots: 0, latestSnapshot: null },
    "/api/admin/feedback/count": { ok: true, new: 0, counts: { new: 0, seen: 0, done: 0 } },
    "/api/official": { launchpadV2: false },
    "/api/policy": { policy: { sampling: { maxGapMinutes: 180 } }, balanceHistory: { running: false, lastSample: null, samplesLast24h: 0 } },
    "/api/admin/growth": { ok: true, asOf: new Date().toISOString(), since: "2026-07-15", holders: [], members: [], countries: [] },
    "/api/admin/audit": { ok: true, audit: [] },
    ...over,
  };
  const calls = [];
  win.fetch = async (path) => { const p = String(path).split("?")[0]; calls.push(String(path)); const body = A[p] ?? { ok: false, error: "not_found" }; return { ok: body.ok !== false, status: body.ok === false ? 404 : 200, json: async () => JSON.parse(JSON.stringify(body)) }; };
  win.setTimeout = (fn) => { setImmediate(fn); return 0; };
  win.location = { hash: "", pathname: "/admin", href: "https://vicinity.test/admin" };
  win.VW = { list: () => [], isMobile: false, KNOWN: [], onChange() {}, safeIcon: () => null, mark: () => doc.createElement("span") };
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);
  vm.runInContext(read("public/admin-charts.js"), win, { filename: "public/admin-charts.js" });
  vm.runInContext(read("public/admin.js"), win, { filename: "public/admin.js" });
  await tick(40);
  const card = doc.querySelectorAll(".adm-metric").find((c) => c.querySelector(".adm-metric__label").textContent === "Meteora build");
  return { doc, calls, card, num: () => card.querySelector(".adm-metric__num").textContent, src: () => card.querySelector(".adm-metric__src").textContent, hot: () => card.classList.contains("is-hot") };
}

test("the Overview's Meteora build card: OK with the time; Changed and Unknown light up and lead to City coins; asked with the cluster; absent where City coins are off", async () => {
  let t = await overview();
  assert.ok(t.card, "the card is among the ones that need attention");
  assert.ok(t.card.classList.contains("adm-metric--attn"));
  assert.deepEqual([t.num(), t.hot()], ["OK", false]);
  assert.match(t.src(), /^Both Meteora programs are the builds the team tested · checked \d{1,2}:\d{2}/);
  assert.ok(t.calls.includes("/api/admin/lp/pins?cluster=mainnet"), JSON.stringify(t.calls.filter((c) => c.includes("/lp"))));

  t = await overview({ "/api/admin/lp/pins": { ok: true, cluster: "mainnet", meteora: CHANGED } });
  assert.deepEqual([t.num(), t.hot(), t.src()], ["Changed", true, "Bonding curve changed · approvals and launches wait"]);
  assert.equal(t.card.querySelector(".adm-metric__go").textContent, "Open City coins");

  t = await overview({ "/api/admin/lp/pins": { ok: true, cluster: "mainnet", meteora: UNAVAILABLE } });
  assert.deepEqual([t.num(), t.hot()], ["Unknown", true]);
  assert.match(t.src(), /could not be checked just now; approvals and launches wait/);
  t = await overview({ "/api/admin/lp/pins": { ok: false, error: "rpc_unavailable" } });
  assert.deepEqual([t.num(), t.hot()], ["Unknown", true], "a failed request is unknown, never OK");

  t = await overview({ "/api/admin/lp": { ok: false, error: "not_enabled" }, "/api/admin/config": { ok: true, siteMode: "live", flags: {}, cityCoins: false } });
  assert.equal(t.card, undefined, "nothing to check where the launchpad is not set up");
  assert.equal(t.calls.some((c) => c.includes("/api/admin/lp")), false);
});
