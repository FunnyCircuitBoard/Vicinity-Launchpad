// The shared kit of the city-coin launch (src/lpkit.js, src/cluster.js lpSetup): the explicit-settings gate, the genesis guard,
// buildTx (legacy / v0, the 1232-byte limit, the signer rule, the measured compute limit, the exact SOL change from the simulated
// post-state, the decoded instruction list, the relay ticket, plain errors), the cluster echo, the answers' statuses, and the
// Anchor instruction names against the IDLs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchpadCluster, launchpadTradingOn, lpSetup } from "../src/cluster.js";
import { ANCHOR_NAMES, GENESIS, PROGRAM_NAMES, _resetLpKit, buildTx, checkCluster, checkGenesis, nameInstruction, programNames, respond } from "../src/lpkit.js";
import { checkTicket } from "../src/relay.js";
import { decodeHeader } from "../src/sol/message.js";
import { fromBase64 } from "../src/sol/bytes.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { systemTransfer } from "../src/sol/ix.js";
import { newWorld } from "./helpers/world.js";
import { LP_ON, PROGRAM, REWARDS, addr, lpChain } from "./helpers/lpchain.js";

const wranglerVars = () => JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")).vars;
// The live settings without the three City-coins setup settings (production before PR-1, or any deploy that drops them):
// everything must stay dark there. The live settings themselves (setup on, trading off) are pinned in lpkit.test.js.
const darkVars = () => { const v = wranglerVars(); for (const k of ["LAUNCHPAD_CLUSTER", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_REWARDS_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS", "LAUNCHPAD_LOOKUP_TABLE", "LAUNCHPAD_TRADING"]) delete v[k]; return v; };
const PAYER = addr(1), OTHER = addr(2), EPH = addr(3), EPH2 = addr(4);
const env = (extra = {}) => ({ ...newWorld(), ...LP_ON, ...extra });
/** The compute limit a (base64) transaction asks for. */
const limitOf = (b64) => { const d = decodeHeader(fromBase64(b64)); const ix = d.instructions.find((i) => d.staticKeys[i.programIdIndex] === PROGRAM_IDS.computeBudget && i.data[0] === 2); return ix ? new DataView(Uint8Array.from(ix.data).buffer).getUint32(1, true) : null; };
const createAccount = (from, to) => ({ programAddress: PROGRAM_IDS.system, accounts: [{ address: from, role: 3 }, { address: to, role: 3 }], data: Uint8Array.of(0, 0, 0, 0, ...new Uint8Array(8).fill(1), ...new Uint8Array(8), ...new Uint8Array(32)) });
beforeEach(() => _resetLpKit());

test("lpSetup: the live settings (PR-1 10 Oct, PR-2 12 Oct 2026) run the owner's two programs on mainnet with his price curve and speed table; curve trading on", () => {
  const live = wranglerVars();
  const s = lpSetup(live);
  assert.deepEqual([s.on, s.cluster, s.chain, s.programId, s.rewardsProgramId], [true, "mainnet", "solana:mainnet", "AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai", "EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG"]);
  // the owner's setup summary of 12 Oct 2026, checked by the read-only preflight (44 pass, 7 warn, 0 fail)
  assert.deepEqual([s.configsSet, s.dbcConfigs, s.lookupTable], [true, ["EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP"], "u2V4Y3KagE2nBZ1656sL4XsV3K7iAZ5C7cQV475DEZ5"], "the price curve and the speed table of the owner's steps 3 and 6");
  assert.equal(live.LAUNCHPAD_TRADING, "on", "switched on by PR-2, after the owner's setup and the preflight");
  assert.equal(launchpadTradingOn(live), true);
});

test("the live settings carry a priority fee, so Phantom does not add its own and change the bytes (owner's setup step 1, 11 Oct 2026)", async () => {
  const live = wranglerVars();
  assert.match(String(live.LAUNCHPAD_CU_PRICE), /^[1-9]\d{0,11}$/, "a positive LAUNCHPAD_CU_PRICE");
  const c = lpChain();
  const r = await buildTx(env({ LAUNCHPAD_CU_PRICE: live.LAUNCHPAD_CU_PRICE }), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)] }, c.fetchImpl);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.summary.some((x) => /set_compute_unit_price/.test(JSON.stringify(x))), "the transaction names its own priority fee");
  assert.equal(r.fees.computeUnitPrice, live.LAUNCHPAD_CU_PRICE);
  assert.ok(r.fees.priorityLamports > 0 && r.fees.priorityLamports < 100_000, "a small fee: " + r.fees.priorityLamports);
});

test("lpSetup: production-like settings without the setup settings keep it OFF although launchpadCluster().ready is already true through the devnet defaults", () => {
  const prod = darkVars();
  assert.equal(prod.LAUNCHPAD_CLUSTER, undefined, "without the three setup settings there is no launchpad switch");
  assert.equal(launchpadCluster(prod).ready, true, "the devnet defaults make the old helper ready");
  const s = lpSetup(prod);
  assert.equal(s.on, false);
  assert.deepEqual(s.missing, ["LAUNCHPAD_CLUSTER", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_REWARDS_PROGRAM_ID"]);
  assert.deepEqual([s.cluster, s.programId, s.rewardsProgramId, s.rpc], [null, null, null, null], "nothing leaks out while off");
  // each of the three alone, or two of them, is not enough
  assert.equal(lpSetup({ ...prod, LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS }).on, false, "no explicit cluster");
  assert.equal(lpSetup({ ...prod, LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM }).on, false, "no rewards program");
  assert.equal(lpSetup({ LAUNCHPAD_CLUSTER: "testnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS }).on, false, "an unknown cluster");
  assert.equal(lpSetup({ LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: PROGRAM }).on, false, "the same id twice");
  assert.equal(lpSetup({ LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: "not-an-address", LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS }).on, false);
  // mainnet never takes the devnet program ids (a copied devnet setting)
  assert.deepEqual(lpSetup({ LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS }).missing, ["LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_REWARDS_PROGRAM_ID"]);
  const main = lpSetup({ LAUNCHPAD_CLUSTER: "Mainnet", LAUNCHPAD_PROGRAM_ID: addr(9), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(10), SOLANA_RPC_URL: "https://rpc.example/key" });
  assert.deepEqual([main.on, main.cluster, main.chain, main.rpc, main.configsSet, main.dbcConfigs, main.lookupTable], [true, "mainnet", "solana:mainnet", "https://rpc.example/key", false, [], null]);
  // configs and the lookup table count only when set explicitly (approve, launch and graduate need them)
  const dev = lpSetup(LP_ON);
  assert.deepEqual([dev.on, dev.configsSet, dev.dbcConfigs, dev.lookupTable, dev.rpc], [true, false, [], null, LP_ON.LAUNCHPAD_RPC_URL]);
  const full = lpSetup({ ...LP_ON, LAUNCHPAD_DBC_CONFIGS: "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7", LAUNCHPAD_LOOKUP_TABLE: "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe" });
  assert.deepEqual([full.configsSet, full.dbcConfigs, full.lookupTable], [true, ["4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7"], "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe"]);
});

test("checkGenesis: the node must be the cluster the settings name; a match is remembered, a failure is asked again", async () => {
  const c = lpChain();
  assert.deepEqual(await checkGenesis(env(), c.fetchImpl), { ok: true, cluster: "devnet" });
  assert.deepEqual(await checkGenesis(env(), c.fetchImpl), { ok: true, cluster: "devnet" });
  assert.equal(c.calls("getGenesisHash").length, 1, "memoised per server");
  _resetLpKit();
  const main = lpChain(); // a devnet node behind a "mainnet" label
  const r = await checkGenesis(env({ LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(9), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(10) }), main.fetchImpl);
  assert.deepEqual([r.ok, r.error], [false, "wrong_cluster"]);
  assert.match(r.message, /not Solana mainnet/);
  const r2 = await checkGenesis(env({ LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(9), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(10) }), main.fetchImpl);
  assert.equal(r2.error, "wrong_cluster");
  assert.equal(main.calls("getGenesisHash").length, 2, "a mismatch is not remembered as ok");
  const real = lpChain({ genesis: GENESIS.mainnet });
  assert.equal((await checkGenesis(env({ LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(9), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(10) }), real.fetchImpl)).ok, true);
  const down = lpChain(); down.S.down = true;
  _resetLpKit();
  assert.deepEqual(await checkGenesis(env(), down.fetchImpl), { ok: false, error: "rpc_unavailable" });
  assert.deepEqual(await checkGenesis({ ...newWorld() }, down.fetchImpl), { ok: false, error: "not_enabled" });
});

test("buildTx: a legacy transfer, simulated, with the exact SOL change, the plain-word list, the measured limit and a ticket", async () => {
  const c = lpChain({ accounts: { [PAYER]: { owner: PROGRAM_IDS.system, lamports: 2_000_000_000, data: "" } } });
  c.S.delta[PAYER] = -50_005_000; c.S.units = 30_000;
  const e = env();
  const r = await buildTx(e, { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 50_000_000n)], labels: { [OTHER]: "the receiver" } }, c.fetchImpl);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.cluster, r.chain, r.version, r.signers], ["devnet", "solana:devnet", "legacy", [PAYER]]);
  assert.deepEqual(r.solChange, { [PAYER]: -50_005_000 });
  assert.equal(r.fees.computeUnitLimit, 50_000, "measured 30,000 +15%, at least 50,000");
  assert.equal(r.fees.priorityLamports, 0);
  assert.equal(r.fees.networkLamports, 5000);
  assert.equal(c.calls("simulateTransaction").length, 2, "the measuring run at the full limit, then the very bytes handed out");
  assert.deepEqual(c.calls("simulateTransaction").map((x) => limitOf(x.params[0])), [1_400_000, 50_000]);
  assert.equal(c.calls("simulateTransaction")[1].params[0], r.tx, "the bytes handed to the wallet are the bytes simulated last");
  const sim = c.calls("simulateTransaction")[0].params[1];
  assert.deepEqual([sim.sigVerify, sim.replaceRecentBlockhash, sim.accounts.addresses], [false, true, [PAYER]]);
  const tx = fromBase64(r.tx);
  const d = decodeHeader(tx);
  assert.deepEqual([d.version, d.numSignatures, d.signaturesFilled[0]], ["legacy", 1, false], "unsigned");
  assert.equal(r.bytes, tx.length);
  assert.ok(await checkTicket(e, tx, r.ticket), "the relay ticket is this very message's");
  assert.deepEqual(r.summary.map((s) => [s.programName, s.ix, s.say]), [
    ["Compute budget", "set_compute_unit_limit", "set the compute limit"], ["System program", "transfer", "send SOL"]]);
  assert.equal(r.summary[0].detail, "50,000 units");
  assert.equal(r.summary[1].detail, "0.05 SOL");
  assert.deepEqual(r.summary[1].accounts, [{ address: PAYER, role: "writable signer", label: "your wallet (pays)" }, { address: OTHER, role: "writable", label: "the receiver" }]);
  assert.equal(r.simulation.unitsConsumed, 30_000);
  assert.equal(respond(r).status, 200);
  assert.equal(respond(r).headers.get("cache-control"), "no-store");
});

test("buildTx: when the tuned limit fails its own simulation, the full-limit bytes that passed are handed out instead", async () => {
  const c = lpChain();
  c.S.units = 30_000;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "simulateTransaction" && limitOf(body.params[0]) < 1_400_000) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: { err: "ProgramFailedToComplete", logs: ["Program log: exceeded CUs meter at BPF instruction"], unitsConsumed: 50_000, accounts: null } } }));
    }
    return c.fetchImpl(url, init);
  };
  const r = await buildTx(env(), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)] }, fetchImpl);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.fees.computeUnitLimit, 1_400_000);
  assert.equal(limitOf(r.tx), 1_400_000);
  assert.equal(r.simulation.ok, true);
});

test("buildTx: a priority fee is read again from the final bytes; a fixed limit is kept", async () => {
  const c = lpChain();
  const r = await buildTx(env({ LAUNCHPAD_CU_PRICE: "200000" }), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)] }, c.fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(c.calls("simulateTransaction").length, 2);
  assert.deepEqual([r.fees.computeUnitLimit, r.fees.computeUnitPrice, r.fees.priorityLamports], [50_000, "200000", 10_000]);
  assert.deepEqual(r.summary.slice(0, 2).map((s) => s.ix), ["set_compute_unit_limit", "set_compute_unit_price"]);
  const fixed = await buildTx(env(), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)], cuLimit: 400_000 }, lpChain().fetchImpl);
  assert.equal(fixed.fees.computeUnitLimit, 400_000);
});

test("buildTx: one-time browser keys must be exactly the other signers; v0 with a lookup table; too big is refused", async () => {
  const c = lpChain();
  const two = await buildTx(env(), { payer: PAYER, instructions: [createAccount(PAYER, EPH), createAccount(PAYER, EPH2)], extraSigners: [EPH, EPH2], watch: [EPH] }, c.fetchImpl);
  assert.equal(two.ok, true, JSON.stringify(two));
  assert.deepEqual(two.signers, [PAYER, EPH, EPH2]);
  assert.deepEqual(Object.keys(two.solChange), [PAYER, EPH]);
  assert.equal(two.fees.networkLamports, 15_000);
  assert.equal(two.summary[1].accounts[1].label, "a one-time key made in this browser");
  // a signer that is neither the payer nor a declared browser key: never built (it would need somebody else's key)
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [createAccount(PAYER, EPH)] }, c.fetchImpl)).error, "unexpected_signer");
  // a declared key the instructions do not use
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)], extraSigners: [EPH] }, c.fetchImpl)).error, "unexpected_signer");
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)], extraSigners: [addr(5), addr(6), addr(7), addr(8)] }, c.fetchImpl)).error, "bad_signers");
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)], extraSigners: [PAYER] }, c.fetchImpl)).error, "bad_signers");
  assert.equal((await buildTx(env(), { payer: "nope", instructions: [systemTransfer(PAYER, OTHER, 1n)] }, c.fetchImpl)).error, "bad_wallet");
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [{ programAddress: PROGRAM_IDS.computeBudget, accounts: [], data: Uint8Array.of(2, 0, 0, 1, 0) }] }, c.fetchImpl)).error, "bad_request", "the kit adds the compute budget itself");
  // v0 with a table given as { key, addresses }, and read from the chain by its address
  const many = Array.from({ length: 30 }, (_, i) => addr(100 + i));
  const wide = { programAddress: PROGRAM, accounts: many.map((a) => ({ address: a, role: 1 })), data: new Uint8Array(8) };
  const legacy = await buildTx(env(), { payer: PAYER, instructions: [wide] }, c.fetchImpl);
  assert.equal(legacy.ok, true);
  const v0 = await buildTx(env(), { payer: PAYER, instructions: [wide], lookupTable: { key: addr(99), addresses: many } }, c.fetchImpl);
  assert.equal(v0.version, 0);
  assert.ok(v0.bytes < legacy.bytes - 800, `${v0.bytes} vs ${legacy.bytes}`);
  const fromChain = await buildTx(env(), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)], lookupTable: "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe" }, c.fetchImpl);
  assert.equal(fromChain.version, 0);
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [systemTransfer(PAYER, OTHER, 1n)], lookupTable: addr(98) }, c.fetchImpl)).error, "lookup_table_missing");
  // more than 1232 bytes
  const huge = Array.from({ length: 40 }, (_, i) => addr(200 + i));
  const big = await buildTx(env(), { payer: PAYER, instructions: [{ programAddress: PROGRAM, accounts: huge.map((a) => ({ address: a, role: 1 })), data: new Uint8Array(8) }] }, c.fetchImpl);
  assert.deepEqual([big.ok, big.error, big.max], [false, "tx_too_large", 1232]);
  assert.equal(respond(big).status, 400);
});

test("buildTx: a failing simulation answers the plain error with the program's own error name and the list; gate and genesis guard come first", async () => {
  const c = lpChain();
  c.S.simErr = { InstructionError: [1, { Custom: 6000 }] };
  const ix = { programAddress: PROGRAM, accounts: [{ address: PAYER, role: 3 }], data: new Uint8Array(8) };
  const r = await buildTx(env(), { payer: PAYER, instructions: [ix] }, c.fetchImpl);
  assert.deepEqual([r.ok, r.error, r.stage, r.program, r.programName], [false, "program_error", "simulation", PROGRAM, "Vicinity launchpad"]);
  assert.ok(r.name && r.name !== "6000", `the IDL name: ${r.name}`);
  assert.equal(r.summary.length, 2);
  assert.equal(respond(r).status, 409);
  c.S.simErr = "InsufficientFundsForFee";
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [ix] }, c.fetchImpl)).error, "insufficient_sol");
  // off: nothing is asked of any node
  const off = lpChain();
  assert.equal((await buildTx({ ...newWorld() }, { payer: PAYER, instructions: [ix] }, off.fetchImpl)).error, "not_enabled");
  assert.equal(off.S.log.length, 0);
  assert.equal(respond({ ok: false, error: "not_enabled" }).status, 404);
  // a mainnet label in front of a devnet node: refused before anything is built
  _resetLpKit();
  const wrong = await buildTx(env({ LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(9), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(10) }), { payer: PAYER, instructions: [ix] }, lpChain().fetchImpl);
  assert.equal(wrong.error, "wrong_cluster");
  assert.equal(respond(wrong).status, 503);
  const down = lpChain(); down.S.down = true;
  _resetLpKit();
  assert.equal((await buildTx(env(), { payer: PAYER, instructions: [ix] }, down.fetchImpl)).error, "rpc_unavailable");
});

test("checkCluster: the page's cluster echo must be this Worker's", () => {
  assert.equal(checkCluster(env(), "devnet"), null);
  assert.deepEqual(checkCluster(env(), "mainnet"), { ok: false, error: "cluster_mismatch", cluster: "devnet", message: "This site works on Solana devnet. Reload the page." });
  assert.equal(checkCluster(env(), undefined).error, "cluster_mismatch");
  assert.equal(checkCluster(newWorld(), "devnet").error, "not_enabled");
  assert.equal(respond(checkCluster(env(), "mainnet")).status, 409);
});

test("instruction names: every Anchor name the kit knows has the discriminator of its IDL; programs have plain names", async () => {
  const idl = (p) => JSON.parse(readFileSync(new URL(`../solana/${p}`, import.meta.url), "utf8"));
  const IDLS = { launchpad: idl("sdk/idl/vicinity_launchpad.json"), rewards: idl("sdk/idl/vicinity_rewards.json"), dbc: idl("idls/dynamic_bonding_curve.json"), damm: idl("idls/cp_amm.json") };
  const ids = { launchpad: PROGRAM, rewards: REWARDS, dbc: PROGRAM_IDS.dbc, damm: PROGRAM_IDS.damm };
  const e = env();
  let n = 0;
  for (const [key, names] of Object.entries(ANCHOR_NAMES)) {
    for (const name of names) {
      const def = IDLS[key].instructions.find((i) => i.name === name);
      assert.ok(def, `${key}.${name} is in its IDL`);
      const got = await nameInstruction(e, { programAddress: ids[key], data: Uint8Array.from([...def.discriminator, 0, 0]) });
      assert.equal(got.ix, name, `${key}.${name}`);
      n++;
    }
  }
  assert.ok(n >= 50);
  assert.equal((await nameInstruction(e, { programAddress: PROGRAM, data: new Uint8Array(8) })).ix, null, "an unknown discriminator");
  assert.deepEqual(await nameInstruction(e, { programAddress: PROGRAM_IDS.upgradeableLoader, data: Uint8Array.of(4, 0, 0, 0) }), { ix: "set_authority", say: "hand over control of a program", detail: null });
  assert.equal((await nameInstruction(e, { programAddress: PROGRAM_IDS.lookupTable, data: Uint8Array.of(2, 0, 0, 0, 1) })).ix, "extend_lookup_table");
  assert.equal((await nameInstruction(e, { programAddress: PROGRAM_IDS.ata, data: Uint8Array.of(1) })).ix, "create_idempotent");
  assert.equal((await nameInstruction(e, { programAddress: PROGRAM_IDS.token, data: Uint8Array.of(17) })).ix, "sync_native");
  const names = programNames(e);
  assert.deepEqual([names[PROGRAM], names[REWARDS], names[PROGRAM_IDS.dbc], names[PROGRAM_IDS.damm]], ["Vicinity launchpad", "Vicinity rewards", "Meteora DBC (bonding curve)", "Meteora DAMM v2 (pool)"]);
  assert.equal(programNames(newWorld())[PROGRAM], undefined, "off: the site's programs are not named");
  assert.equal(PROGRAM_NAMES[PROGRAM_IDS.upgradeableLoader], "Program loader (upgradeable)");
});
