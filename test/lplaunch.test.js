// The founder's launch and the move to the open market (src/lplaunch.js, src/sol/lplaunch-ix.js) through the real API with a fake
// chain: dark without the gate; the status of a founder's coin from the chain (not approved, ready, expired, paused, a disabled
// price curve, launched) and the exact first-buy quote; the launch transaction (the session wallet pays and is the founder, the
// mint is a one-time key, v0 through the speed table, the first buy at most 10 SOL, refused in plain words without the table or
// past 1232 bytes); a founder mismatch, a seat below the bar; graduation only when the curve is full, then the leftover; the
// founder's fees. Every transaction here is only built and simulated; solana/tests-launchpad/18 runs them for real.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _resetProgramPins } from "../src/programpins.js";
import { ensureOnboardSchema } from "../src/store.js";
import { feeSplit, founderFees } from "../src/lplaunch.js";
import { lpSetup } from "../src/cluster.js";
import * as IX from "../src/sol/lplaunch-ix.js";
import { base58Decode } from "../src/solana.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { decodeHeader } from "../src/sol/message.js";
import { LAYOUT } from "../src/sol/layout.js";
import { decodeCoin, decodeConfig } from "../src/sol/dbc.js";
import { quoteBuy } from "../src/sol/quote.js";
import { ADDRESSES, PROGRAM_IDS, ata, launchpad as launchpadPdas } from "../src/sol/pda.js";
import { MINT, browser, chain as mainChain, newWorld, person, realClock, setHolding, useClock, advance } from "./helpers/world.js";
import { DEMOV, DEMOV_COIN, DEMOV_CITY, DEMOV_POOL, DEV, LP_ON, METAPLEX, PROGRAM, SOL_CONFIG, addr, lpChain, metaplexData, meteoraAsTested } from "./helpers/lpchain.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { metadataUriFor } from "../src/coinmeta.js";

const TABLE = "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe";
const CITY = "5142056"; // Utica (ticker UTICA in the test world)
const ADMIN = addr(5);
const ON = { ...LP_ON, LAUNCHPAD_DBC_CONFIGS: SOL_CONFIG, LAUNCHPAD_LOOKUP_TABLE: TABLE, VICINITY_MINT: MINT };
const wranglerVars = () => JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")).vars;
// The live settings without the three City-coins setup settings (production before PR-1, or any deploy that drops them):
// everything must stay dark there. The live settings themselves (setup on, trading off) are pinned in lpkit.test.js.
const darkVars = () => { const v = wranglerVars(); for (const k of ["LAUNCHPAD_CLUSTER", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_REWARDS_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS", "LAUNCHPAD_LOOKUP_TABLE", "LAUNCHPAD_TRADING"]) delete v[k]; return v; };
const b64 = (u8) => Buffer.from(u8).toString("base64");
const idl = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

/* ---------------------------------------------------------------- accounts as the programs write them */
function approvalAccount({ cityId, founder, dbcConfig = SOL_CONFIG, rentPayer = ADMIN, name = "Utica Coin", symbol = "UTICA", expiresAt }) {
  const enc = new TextEncoder();
  const str = (s) => concat([u32le(enc.encode(s).length), enc.encode(s)]);
  const body = concat([Uint8Array.of(233, 9, 153, 49, 11, 222, 59, 130), u64le(BigInt(cityId)), base58Decode(founder), base58Decode(dbcConfig), base58Decode(rentPayer), str(name), str(symbol), u64le(1), u64le(BigInt(expiresAt)), Uint8Array.of(254)]);
  const out = new Uint8Array(179); out.set(body);
  return { owner: PROGRAM, data: b64(out) };
}
function setField(S, address, layout, field, value) {
  const f = LAYOUT[layout].fields[field];
  const bytes = Buffer.from(S.accounts[address].data, "base64");
  if (f.type === "pubkey") bytes.set(base58Decode(value), f.at);
  else if (f.type === "u64" || f.type === "i64") bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), f.at);
  else bytes[f.at] = Number(value);
  S.accounts[address].data = bytes.toString("base64");
}
const tokenAccount = (mint, owner, amount = 0n) => ({ owner: PROGRAM_IDS.token, data: b64(concat([base58Decode(mint), base58Decode(owner), u64le(amount), new Uint8Array(36), Uint8Array.of(1), new Uint8Array(12), u64le(0), new Uint8Array(36)])) });

/**
 * A founder of Utica (an active seat, holding the founder amount), signed in with their wallet; the launchpad RPC is the fake chain
 * (the recorded devnet accounts: the launchpad, the SOL price curve 4ZLtvU and its allow-list entry, the speed table) and every other
 * call (the $VICINITY holders for the live founder check) goes to the test world's chain.
 */
async function world({ env: extra = {}, approval = true, holds = 2_000_000 } = {}) {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld(), ...ON, ...extra };
  const f = await person(env, { holds });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(CITY, u.id, u.wallet, at, at).run();
  const lp = lpChain();
  await meteoraAsTested(lp.S.accounts); // Meteora's programs as the builds the team tested (src/programpins.js; test/program-pins.test.js)
  const L = launchpadPdas(PROGRAM);
  const approvalAddr = await L.approval(BigInt(CITY));
  if (approval) lp.S.accounts[approvalAddr] = approvalAccount({ cityId: CITY, founder: f.w.address, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
  const main = mainChain();
  const fetchImpl = async (url, init) => (String(url).startsWith(LP_ON.LAUNCHPAD_RPC_URL) ? lp.fetchImpl(url, init) : main(url, init));
  const call = async (path, body, { who = f, cluster = "devnet", origin } = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = body === undefined && cluster !== null ? `${path}${sep}cluster=${cluster}` : path;
    const r = await who.send(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : { ...(cluster !== null ? { cluster } : {}), ...body }, fetchImpl, ...(origin !== undefined ? { origin } : {}) });
    return { status: r.status, data: await r.json() };
  };
  return { env, f, wallet: f.w.address, lp, S: lp.S, call, approvalAddr, L, fetchImpl };
}
const status = (w, extra = "") => w.call(`/api/lp/launch/status?city=${CITY}${extra}`);
const signersOf = (tx) => { const d = decodeHeader(Buffer.from(tx, "base64")); return d.staticKeys.slice(0, d.header.numRequiredSignatures); };

beforeEach(() => { _resetLpKit(); _resetLpCoins(); _resetProgramPins(); realClock(); });

test("the discriminators and account lists are the IDLs' own", async () => {
  const lp = idl("../solana/sdk/idl/vicinity_launchpad.json"), dbc = idl("../solana/idls/dynamic_bonding_curve.json");
  const find = (i, n) => i.instructions.find((x) => x.name === n);
  for (const [name, i] of [["launch", lp], ["claim_founder_fees", lp], ["migration_damm_v2", dbc], ["withdraw_leftover", dbc]]) {
    assert.deepEqual(IX.DISCRIMINATORS[name], find(i, name).discriminator, name);
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`))).subarray(0, 8);
    assert.deepEqual(IX.DISCRIMINATORS[name], [...d], `${name} = sha256("global:${name}")[..8]`);
  }
  const roleOf = (a) => (a.signer ? 2 : 0) | (a.writable ? 1 : 0);
  const check = (ix, i, name, extra = 0) => {
    const want = find(i, name).accounts;
    assert.equal(ix.accounts.length, want.length + extra, `${name}: account count`);
    want.forEach((a, k) => assert.equal(ix.accounts[k].role, roleOf(a), `${name}: ${a.name}`));
  };
  const [w, m, n1, n2] = [addr(1), addr(2), addr(3), addr(4)];
  check(await IX.launch({ programId: PROGRAM, founder: w, baseMint: m, cityId: 7n, dbcConfig: SOL_CONFIG, quoteMint: ADDRESSES.wsol, rentPayer: ADMIN }), lp, "launch");
  check(await IX.claimFounderFees({ programId: PROGRAM, founder: w, coin: { cityId: 7n, quoteMint: ADDRESSES.wsol } }), lp, "claim_founder_fees");
  check(await IX.migrateToDammV2({ payer: w, dbcPool: addr(6), dbcConfig: SOL_CONFIG, coinMint: m, quoteMint: ADDRESSES.wsol, firstNftMint: n1, secondNftMint: n2 }), dbc, "migration_damm_v2", 1);
  check(await IX.withdrawLeftover({ dbcPool: addr(6), dbcConfig: SOL_CONFIG, coinMint: m, receiverAccount: addr(8) }), dbc, "withdraw_leftover");
});

test("dark: with production-like settings every founder route answers 404 not_enabled and reads nothing", async () => {
  const env = { ...newWorld(), ...darkVars() };
  const p = await person(env);
  const lp = lpChain();
  for (const [path, method] of [["/api/lp/launch/status", "GET"], ["/api/lp/launch/status?city=1&cluster=mainnet", "GET"], ["/api/lp/launch/tx", "POST"], ["/api/lp/graduate/status?mint=" + DEMOV, "GET"],
    ["/api/lp/graduate/tx", "POST"], ["/api/lp/founder-claim/tx", "POST"]]) {
    const r = await p.send(path, { method, body: method === "POST" ? { cluster: "mainnet" } : undefined, fetchImpl: lp.fetchImpl });
    assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: "not_enabled" }], path);
  }
  assert.equal(lp.S.log.length, 0);
});

test("/api/official says cityCoins only while the settings are there (the pages ask /api/lp/* only then); production-like: no key, exactly as before", async () => {
  const prod = { ...newWorld(), ...darkVars() };
  const lp = lpChain();
  const off = await (await browser(prod).send("/api/official", { fetchImpl: lp.fetchImpl })).json();
  assert.equal("cityCoins" in off, false, "no key at all while dark");
  const on = await (await browser({ ...newWorld(), ...ON }).send("/api/official", { fetchImpl: lp.fetchImpl })).json();
  assert.deepEqual(on.cityCoins, { cluster: "devnet" });
  assert.equal(lp.S.log.length, 0, "no chain read for it");
});

test("status: signed out 401, the cluster echo first, a member who is not the founder 403; a wrong method 405", async () => {
  const w = await world();
  assert.deepEqual([(await w.call(`/api/lp/launch/status?city=${CITY}`, undefined, { cluster: "mainnet" })).status], [409]);
  assert.equal((await w.call(`/api/lp/launch/status?city=${CITY}`, undefined, { who: browser(w.env) })).data.error, "sign_in");
  assert.equal(w.S.log.length, 0, "nothing read before the sign-in and the echo");
  const other = await person(w.env, { holds: 5 });
  const r = await w.call(`/api/lp/launch/status?city=${CITY}`, undefined, { who: other });
  assert.deepEqual([r.status, r.data.error], [403, "not_founder"]);
  // an account with no wallet linked (onboarding v3): nothing to pay or sign with
  await ensureOnboardSchema(w.env.DB); // users.wallet nullable, as in production since onboarding v3
  await w.env.DB.prepare("UPDATE users SET wallet = NULL WHERE wallet = ?").bind(other.w.address).run();
  for (const [path, body] of [[`/api/lp/launch/status?city=${CITY}`], ["/api/lp/launch/tx", { cityId: CITY, mint: addr(90) }], ["/api/lp/graduate/tx", { mint: DEMOV, step: "leftover" }], ["/api/lp/founder-claim/tx", { cityId: CITY }]]) {
    const x = await w.call(path, body, { who: other });
    assert.deepEqual([x.status, x.data.error], [403, "no_wallet"], path);
  }
  assert.equal((await w.f.send("/api/lp/launch/tx?cluster=devnet", { fetchImpl: w.fetchImpl })).status, 405);
  // the pages' probe: no sign-in, nothing read
  const n = w.S.log.length;
  assert.deepEqual((await w.call("/api/lp/launch/status", undefined, { who: browser(w.env), cluster: null })).data, { ok: true, on: true, cluster: "devnet", chain: "solana:devnet", configsSet: true, speedTable: true });
  assert.equal(w.S.log.length, n);
  // a read may leave the cluster out: the page learns it from the answer; every POST must echo it
  const learn = await w.call(`/api/lp/launch/status?city=${CITY}`, undefined, { cluster: null });
  assert.deepEqual([learn.status, learn.data.cluster, learn.data.state], [200, "devnet", "ready"]);
  assert.deepEqual([(await w.call("/api/lp/launch/tx", { cityId: CITY, mint: addr(90) }, { cluster: null })).data.error], ["cluster_mismatch"]);
  assert.equal((await w.call(`/api/lp/launch/status?city=abc`)).data.error, "bad_city");
});

test("status from the chain: ready with the name, the ticker, the fee split, the expiry and the cost; an exact first-buy quote", async () => {
  const w = await world();
  const r = await status(w);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.equal(d.state, "ready");
  assert.deepEqual([d.cluster, d.cityId, d.ticker, d.coin.name, d.coin.symbol, d.coin.pair, d.wallet], ["devnet", CITY, "UTICA", "Utica Coin", "UTICA", "SOL", w.wallet]);
  // the split is read from the config's bytes (src/fees.js), with the accurate label for Meteora's cut
  assert.deepEqual([d.fees.totalPct, d.fees.meteoraPct, d.fees.vicinityPct, d.fees.holdersPct, d.fees.founderPct, d.fees.poolPct], [1.25, 0.25, 0.5, 0.25, 0.25, 1.25]);
  assert.equal(d.fees.totalText, "1.25%");
  // the same clauses as the Fees sections (src/fees.js meteoraWords, poolSplitWords): Meteora's cut with its source, no refund, the
  // pool's split with the later-liquidity note
  assert.equal(d.fees.halves, "Vicinity's program splits the city's share evenly between you and the holder pot.", "the founder / holder-pot halving is our program's rule: said as its own");
  assert.equal(d.fees.words, "Every buy and sell on the price curve pays 1.25%: Meteora protocol fee 0.25% (20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here), Vicinity 0.5%, the city's holder pot 0.25%, and you, the founder, 0.25%. After your coin graduates, its pool fee is 1.25%, split the same way, except that none of the Meteora protocol fee goes to Vicinity (anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee).");
  assert.equal(d.approval.expiresAt, new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z"));
  assert.equal(d.cost.approxLamports, 41_200_000, "the devnet curve's 0.01 SOL launch fee + the rent");
  assert.match(d.cost.words, /^About 0\.0412 SOL from your wallet: the 0\.01 SOL launch fee and about 0\.0312 SOL of rent/);
  assert.deepEqual([d.firstBuy.allowed, d.firstBuy.maxLamports], [true, "10000000000"]);
  // the exact quote at the curve's start: the config's start price, nothing in the curve yet
  const q = await status(w, "&buy=200000000");
  const cfg = decodeConfig({ owner: PROGRAM_IDS.dbc, data: [DEV.accounts[SOL_CONFIG].data, "base64"] });
  const want = quoteBuy({ sqrtPrice: cfg.sqrtStartPrice, quoteReserve: 0n, baseReserve: 0n }, cfg, { amountIn: 200_000_000n, slippageBps: 50 });
  assert.deepEqual([q.data.quote.coinsOut, q.data.quote.minOut, q.data.quote.amountInSol], [want.amountOut.toString(), want.minOut.toString(), "0.2"]);
  assert.equal((await status(w, "&buy=10000000001")).data.error, "first_buy_too_large");
  assert.equal((await status(w, "&buy=1.5")).data.error, "bad_first_buy");
  assert.equal(feeSplit(null), null, "without a config there is no figure to show: nothing is said that was not read from the chain");
});

test("status: not approved, expired, paused, a disabled price curve, the settings not set, a founder mismatch, launched", async () => {
  const w = await world({ approval: false });
  let d = (await status(w)).data;
  assert.deepEqual([d.state, d.why, d.message], ["not_approved", "not_approved", "An admin approves your coin on chain first; your pair must be SOL."]);
  const nowS = Math.floor(Date.now() / 1000);
  w.S.accounts[w.approvalAddr] = approvalAccount({ cityId: CITY, founder: w.wallet, expiresAt: nowS - 5 });
  d = (await status(w)).data;
  assert.deepEqual([d.state, d.why], ["expired", "approval_expired"]);
  w.S.accounts[w.approvalAddr] = approvalAccount({ cityId: CITY, founder: w.wallet, expiresAt: nowS + 3600 });
  const lpAddr = await w.L.launchpad(), lcAddr = await w.L.launchConfig(SOL_CONFIG);
  setField(w.S, lpAddr, "Launchpad", "launches_paused", 1);
  d = (await status(w)).data;
  assert.deepEqual([d.state, d.why], ["paused", "launches_paused"]);
  setField(w.S, lpAddr, "Launchpad", "launches_paused", 0);
  setField(w.S, lcAddr, "LaunchConfig", "enabled", 0);
  d = (await status(w)).data;
  assert.deepEqual([d.state, d.why], ["paused", "config_disabled"]);
  setField(w.S, lcAddr, "LaunchConfig", "enabled", 1);
  assert.equal((await status(w)).data.state, "ready");
  // the approval names a price curve the site's settings do not trade
  w.env.LAUNCHPAD_DBC_CONFIGS = "8ZcsWij7BWkhrkvoJuGULN3XreHT9De4dj4ZEVgRMi8J";
  assert.deepEqual([(await status(w)).data.state, (await status(w)).data.why], ["paused", "config_not_set"]);
  w.env.LAUNCHPAD_DBC_CONFIGS = SOL_CONFIG;
  // approved for another wallet
  w.S.accounts[w.approvalAddr] = approvalAccount({ cityId: CITY, founder: addr(44), expiresAt: nowS + 3600 });
  const mm = await status(w);
  assert.deepEqual([mm.status, mm.data.error], [403, "founder_mismatch"]);
  assert.match(mm.data.message, new RegExp(`approval is for the wallet ${addr(44)}; you are signed in with ${w.wallet}`));
  // launched: the Coin record exists (the DEMOV record moved to this city id)
  const coinAddr = await w.L.coin(BigInt(CITY));
  w.S.accounts[coinAddr] = { ...w.S.accounts[DEMOV_COIN] };
  setField(w.S, coinAddr, "Coin", "city_id", CITY);
  setField(w.S, coinAddr, "Coin", "founder", w.wallet);
  d = (await status(w)).data;
  assert.deepEqual([d.state, d.mint, d.coinPage, d.yours], ["launched", DEMOV, `/coin?mint=${DEMOV}`, true]);
  assert.match(d.explorer, /^https:\/\/solscan\.io\/token\/EAXz.*\?cluster=devnet$/);
  assert.ok(d.founderFees && d.founderFees.words);
  assert.equal(d.founderFees.sharePct, "0.25%", "the founder's part of every trade, read from the config the coin launched under");
  assert.equal(d.founderFees.shareUpTo, false, "on the curve the share is exact");
  // the chain slot of the status's own fee reading: the founder card refuses an older fee reading that still shows money this one
  // saw leave (public/lp-launch.js olderThanStatus)
  w.S.slot = 4242;
  d = (await status(w)).data;
  assert.equal(d.founderFees.slot, 4242);
  // and the Coin record's counters as that same answer has them (founder_accrued; founder_claimed + founder_paid_out): they only grow,
  // so the card refuses a fee reading with a lower one, whatever its slot (olderThanStatus)
  setField(w.S, coinAddr, "Coin", "founder_accrued", 900);
  setField(w.S, coinAddr, "Coin", "founder_claimed", 300);
  setField(w.S, coinAddr, "Coin", "founder_paid_out", 40);
  const asked = w.lp.calls("getMultipleAccounts").length;
  d = (await status(w)).data;
  assert.deepEqual([d.founderFees.earnedLamports, d.founderFees.collectedLamports, d.founderFees.slot], ["900", "340", 4242]);
  const rec = decodeCoin({ owner: PROGRAM, data: [w.S.accounts[coinAddr].data, "base64"] }, PROGRAM), vault = await w.L.founderVault(coinAddr);
  const lists = w.lp.calls("getMultipleAccounts").slice(asked).map((c) => c.params[0]);
  assert.ok(lists.some((l) => [vault, rec.dbcPool, rec.dbcConfig, coinAddr].every((a) => l.includes(a))), "the record, the vault, the curve and its settings in ONE call (one slot)");
  // the record missing from that answer, or no longer naming this coin's mint: no counters (null), the rest as read; never a throw
  const saved = w.S.accounts[coinAddr];
  delete w.S.accounts[coinAddr];
  let ff = await founderFees(w.env, lpSetup(w.env), rec, w.fetchImpl);
  assert.deepEqual([ff.earnedLamports, ff.collectedLamports, ff.slot, typeof ff.inVaultLamports], [null, null, 4242, "string"]);
  w.S.accounts[coinAddr] = { ...saved };
  setField(w.S, coinAddr, "Coin", "mint", addr(77));
  ff = await founderFees(w.env, lpSetup(w.env), rec, w.fetchImpl);
  assert.deepEqual([ff.earnedLamports, ff.collectedLamports], [null, null]);
  w.S.accounts[coinAddr] = { ...saved, data: Buffer.from(Buffer.from(saved.data, "base64").subarray(0, 50)).toString("base64") };
  ff = await founderFees(w.env, lpSetup(w.env), rec, w.fetchImpl);
  assert.deepEqual([ff.earnedLamports, ff.collectedLamports], [null, null], "bytes that do not decode");
  w.S.accounts[coinAddr] = saved;
  assert.deepEqual([(await founderFees(w.env, lpSetup(w.env), rec, w.fetchImpl)).collectedLamports], ["340"]);
  // graduated: the pool's figure, and a ceiling (anyone who adds liquidity later takes part of what the locked positions earn)
  setField(w.S, DEMOV_POOL, "VirtualPool", "is_migrated", 1);
  d = (await status(w)).data;
  assert.deepEqual([d.founderFees.sharePct, d.founderFees.shareUpTo], ["0.25%", true]);
});

test("launch/tx: the session wallet pays and is the founder, the mint is a one-time key, v0 through the speed table; the SOL change", async () => {
  const w = await world();
  const mint = addr(90);
  w.S.delta[w.wallet] = -76_123_456;
  const r = await w.call("/api/lp/launch/tx", { cityId: CITY, mint, payer: addr(13) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.deepEqual(signersOf(d.tx), [w.wallet, mint], "fee payer = the session wallet, never a body field; the mint signs");
  assert.equal(d.version, 0, "v0 through LAUNCHPAD_LOOKUP_TABLE");
  assert.equal(decodeHeader(Buffer.from(d.tx, "base64")).lookups[0].key, TABLE);
  assert.ok(d.bytes <= 1232);
  assert.deepEqual(d.solChange, { [w.wallet]: -76_123_456 });
  assert.deepEqual(d.summary.map((x) => x.ix), ["set_compute_unit_limit", "launch"]);
  assert.equal(d.summary[1].programName, "Vicinity launchpad");
  assert.equal(d.summary[1].say, "launch a city coin");
  assert.deepEqual([d.step, d.cityId, d.mint, d.coin.symbol, d.record.cityId, d.coinPage], ["launch", CITY, mint, "UTICA", CITY, `/coin?mint=${mint}`]);
  assert.equal(typeof d.ticket, "string");
  // the launch instruction as built: founder, payer, mint, the approval's rent payer
  const ix = await IX.launch({ programId: PROGRAM, founder: w.wallet, baseMint: mint, cityId: BigInt(CITY), dbcConfig: SOL_CONFIG, quoteMint: ADDRESSES.wsol, rentPayer: ADMIN });
  assert.deepEqual([ix.accounts[0].address, ix.accounts[1].address, ix.accounts[2].address, ix.accounts[5].address], [w.wallet, w.wallet, mint, ADMIN]);
  // without a speed table the launch alone is a legacy transaction
  w.env.LAUNCHPAD_LOOKUP_TABLE = "";
  const r2 = await w.call("/api/lp/launch/tx", { cityId: CITY, mint });
  assert.deepEqual([r2.status, r2.data.version], [200, "legacy"]);
});

test("launch/tx with a first buy: the SDK's buy in the same transaction; at most 10 SOL; refused without the table and past 1232 bytes", async () => {
  const w = await world();
  const mint = addr(91);
  const r = await w.call("/api/lp/launch/tx", { cityId: CITY, mint, firstBuyLamports: "500000000" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.summary.map((x) => x.ix), ["set_compute_unit_limit", "launch", "create_idempotent", "create_idempotent", "transfer", "sync_native", "create_idempotent", "swap2", "close_account"]);
  assert.ok(r.data.bytes <= 1232, `${r.data.bytes} bytes`);
  assert.equal(r.data.quote.amountInLamports, "500000000");
  assert.ok(BigInt(r.data.quote.minOut) > 0n);
  const t = await w.call("/api/lp/launch/tx", { cityId: CITY, mint, firstBuyLamports: 10_000_000_001 });
  assert.deepEqual([t.status, t.data.error], [400, "first_buy_too_large"]);
  assert.match(t.data.message, /at most 10 SOL/);
  // no speed table: the buy is refused in plain words (the launch alone still works)
  w.env.LAUNCHPAD_LOOKUP_TABLE = "";
  const n = await w.call("/api/lp/launch/tx", { cityId: CITY, mint, firstBuyLamports: "500000000" });
  assert.deepEqual([n.status, n.data.error], [409, "first_buy_needs_table"]);
  assert.match(n.data.message, /Launch first, then buy on your coin's page/);
  // a transaction that cannot be compiled into one Solana transaction (here: the speed table holds the launchpad's own account past
  // index 255, which a transaction cannot point at): the buy is refused in plain words and nothing is simulated
  const odd = addr(77);
  w.S.accounts[odd] = (() => {
    const head = new Uint8Array(56); head.set(u32le(1), 0); head.set(u64le((1n << 64n) - 1n), 4);
    return { owner: PROGRAM_IDS.lookupTable, data: b64(concat([head, ...Array.from({ length: 256 }, (_, i) => base58Decode(addr(1000 + i))), base58Decode("ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw")])) };
  })();
  w.env.LAUNCHPAD_LOOKUP_TABLE = odd;
  const big = await w.call("/api/lp/launch/tx", { cityId: CITY, mint, firstBuyLamports: "500000000" });
  assert.deepEqual([big.status, big.data.error], [400, "first_buy_too_large"]);
  assert.match(big.data.message, /do not fit in one Solana transaction\. Launch first, then buy/);
  assert.equal(w.S.log.filter((l) => l.method === "simulateTransaction").length, 2, "nothing too large was ever simulated (the good one twice: measured, then its final bytes)");
});

test("launch/tx refusals: a founder mismatch, expired, paused, a disabled curve, no mint, a seat below the bar, the wrong origin", async () => {
  const w = await world();
  const nowS = Math.floor(Date.now() / 1000);
  const go = (extra = {}) => w.call("/api/lp/launch/tx", { cityId: CITY, mint: addr(92), ...extra });
  assert.equal((await go({ mint: undefined })).data.error, "bad_mint");
  assert.equal((await go({ mint: w.wallet })).data.error, "bad_mint");
  assert.equal((await w.call("/api/lp/launch/tx", { cityId: CITY, mint: addr(92) }, { origin: "https://evil.example" })).data.error, "wrong_origin");
  w.S.accounts[w.approvalAddr] = approvalAccount({ cityId: CITY, founder: addr(44), expiresAt: nowS + 3600 });
  assert.deepEqual([(await go()).status, (await go()).data.error], [403, "founder_mismatch"]);
  w.S.accounts[w.approvalAddr] = approvalAccount({ cityId: CITY, founder: w.wallet, expiresAt: nowS + 30 });
  assert.equal((await go()).data.error, "approval_expired", "less than a minute left is refused too");
  w.S.accounts[w.approvalAddr] = approvalAccount({ cityId: CITY, founder: w.wallet, expiresAt: nowS + 3600 });
  setField(w.S, await w.L.launchpad(), "Launchpad", "launches_paused", 1);
  assert.equal((await go()).data.error, "launches_paused");
  setField(w.S, await w.L.launchpad(), "Launchpad", "launches_paused", 0);
  setField(w.S, await w.L.launchConfig(SOL_CONFIG), "LaunchConfig", "enabled", 0);
  assert.equal((await go()).data.error, "config_disabled");
  setField(w.S, await w.L.launchConfig(SOL_CONFIG), "LaunchConfig", "enabled", 1);
  assert.equal((await go()).status, 200);
  assert.equal(w.S.log.filter((l) => l.method === "simulateTransaction").length, 2, "only the good one was simulated (measured, then its final bytes)");
  // the founder's balance fell below the bar: the seat goes into grace now and nothing is built
  setHolding(w.wallet, 10);
  const g = await go();
  assert.deepEqual([g.status, g.data.error], [403, "in_grace"]);
  assert.equal((await w.env.DB.prepare("SELECT status FROM seats WHERE city_id = ?").bind(CITY).first()).status, "grace");
  realClock();
});

test("launch/tx: the price-curve settings are required; a simulation failure answers the program's error and nothing to sign", async () => {
  const w = await world({ env: { LAUNCHPAD_DBC_CONFIGS: "" } });
  const r = await w.call("/api/lp/launch/tx", { cityId: CITY, mint: addr(93) });
  assert.deepEqual([r.status, r.data.error], [409, "config_not_set"]);
  w.env.LAUNCHPAD_DBC_CONFIGS = SOL_CONFIG;
  w.S.simErr = { InstructionError: [1, { Custom: 6000 }] };
  const s = await w.call("/api/lp/launch/tx", { cityId: CITY, mint: addr(93) });
  assert.equal(s.status, 409);
  assert.equal(s.data.stage, "simulation");
  assert.equal(s.data.tx, undefined);
});

test("graduate: only when the curve is full; three signers (the payer and two one-time keys) at 400k compute; then the leftover", async () => {
  const w = await world();
  // the coin's metadata, as the program writes it at launch (a mint is looked up program-wide only when it points at /coin-meta)
  w.S.accounts[await metadataAddress(DEMOV)] = { owner: METAPLEX, data: metaplexData({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", uri: metadataUriFor(DEMOV) }) };
  const keys = { nft1: addr(101), nft2: addr(102) };
  let st = await w.call(`/api/lp/graduate/status?mint=${DEMOV}`);
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.deepEqual([st.data.stage, st.data.canMigrate, st.data.leftoverDue], ["curve", false, false]);
  let r = await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "migrate", ...keys });
  assert.deepEqual([r.status, r.data.error], [409, "not_full"]);
  assert.match(r.data.message, /not full yet/);
  // the curve fills (DBC: quote reserve at the target, migration progress "locked vesting")
  setField(w.S, DEMOV_POOL, "VirtualPool", "quote_reserve", 1_000_000_000n);
  setField(w.S, DEMOV_POOL, "VirtualPool", "migration_progress", 2);
  st = await w.call(`/api/lp/graduate/status?mint=${DEMOV}`);
  assert.deepEqual([st.data.stage, st.data.canMigrate, st.data.leftoverDue], ["full", true, true]);
  assert.match(st.data.cost.words, /About 0.033 SOL of rent, paid by the wallet that does it/);
  assert.equal((await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "migrate", nft1: addr(101), nft2: addr(101) })).data.error, "bad_keys");
  r = await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "migrate", ...keys });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(signersOf(r.data.tx), [w.wallet, keys.nft1, keys.nft2]);
  assert.deepEqual(r.data.summary.map((x) => x.ix), ["set_compute_unit_limit", "migration_damm_v2"]);
  assert.equal(r.data.summary[0].detail, "400,000 units");
  assert.equal(r.data.fees.computeUnitLimit, 400_000);
  assert.deepEqual([r.data.step, r.data.next], ["migrate", "leftover"]);
  // anyone signed in pays: another member builds it too, as the payer
  const other = await person(w.env);
  const o = await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "migrate", ...keys }, { who: other });
  assert.equal(signersOf(o.data.tx)[0], other.w.address);
  // graduated: the leftover is the one step left; then nothing
  setField(w.S, DEMOV_POOL, "VirtualPool", "is_migrated", 1);
  assert.equal((await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "migrate", ...keys })).data.error, "already_graduated");
  const lo = await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "leftover" });
  assert.equal(lo.status, 200, JSON.stringify(lo.data));
  assert.deepEqual(signersOf(lo.data.tx), [w.wallet]);
  assert.deepEqual(lo.data.summary.map((x) => x.ix), ["set_compute_unit_limit", "create_idempotent", "withdraw_leftover"]);
  assert.equal(lo.data.summary[1].accounts[1].address, await ata(ADDRESSES.feeRecipient, DEMOV), "the dev wallet's coin account");
  setField(w.S, DEMOV_POOL, "VirtualPool", "is_withdraw_leftover", 1);
  assert.equal((await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "leftover" })).data.error, "nothing_left");
  assert.equal((await w.call(`/api/lp/graduate/status?mint=${addr(55)}`)).data.error, "not_found");
  assert.equal((await w.call("/api/lp/graduate/tx", { mint: DEMOV, step: "leftover" }, { who: browser(w.env) })).data.error, "sign_in");
});

test("founder-claim: only the coin's founder on chain; the curve's city share is collected first, the SOL is unwrapped", async () => {
  const w = await world();
  const coinAddr = DEMOV_COIN;
  let r = await w.call("/api/lp/founder-claim/tx", { cityId: DEMOV_CITY });
  assert.deepEqual([r.status, r.data.error], [403, "founder_mismatch"]);
  setField(w.S, coinAddr, "Coin", "founder", w.wallet);
  r = await w.call("/api/lp/founder-claim/tx", { cityId: DEMOV_CITY });
  assert.deepEqual([r.status, r.data.error], [409, "nothing_to_claim"], "an empty vault and nothing on the curve");
  setField(w.S, DEMOV_POOL, "VirtualPool", "creator_quote_fee", 400_000n);
  const vault = await w.L.founderVault(coinAddr);
  w.S.accounts[vault] = tokenAccount(ADDRESSES.wsol, coinAddr, 123_456n);
  r = await w.call("/api/lp/founder-claim/tx", { cityId: DEMOV_CITY });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(signersOf(r.data.tx), [w.wallet]);
  assert.deepEqual(r.data.summary.map((x) => x.ix), ["set_compute_unit_limit", "harvest_curve_fees", "claim_founder_fees", "close_account"]);
  assert.deepEqual([r.data.fees.inVaultLamports, r.data.fees.onCurveLamports], ["123456", "200000"]);
  assert.equal(r.data.summary[3].accounts[0].address, await ata(w.wallet, ADDRESSES.wsol));
  assert.equal((await w.call("/api/lp/founder-claim/tx", { cityId: "1" })).data.error, "not_launched");
});
