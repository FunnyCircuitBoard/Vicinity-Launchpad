// The fee schedule (src/fees.js): every fee figure the site shows is read from the deployed Meteora DBC config, never a literal.
//   * feeSchedule on the live config's bytes (the PoolConfig Meteora writes for Vicinity's defaults, src/sol/dbc-config-data.js, byte
//     for byte the mainnet curve) and on the recorded devnet config: the split the fee check of 16 Oct 2026 measured, in whole basis
//     points; on synthetic configs with other values (a 2% curve; a 2.3% curve with a 33% creator share and 60/40 locked liquidity;
//     another Meteora percentage): the helper assumes nothing, keeps one decimal of a basis point and says "about" where a split is
//     not whole; the words carry the accurate labels.
//   * GET /api/fees through the real API with the fake launchpad chain: dark without the gate, the live config, a coin's own config
//     (?mint=), the cache header, the 10-minute memo of the config bytes, the edge cache, the public limit, 404s and a chain outage.
//   * a guard: no "1.25%" literal is left in src/*.js or public/*.js except the generated config preset and a comment that says "today".
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { METEORA, _resetFees, feeSchedule, feeWords } from "../src/fees.js";
import { decodeConfig } from "../src/sol/dbc.js";
import { EXPECTED_POOL_CONFIG, DBC_CONFIG_DEFAULTS } from "../src/sol/dbc-config-data.js";
import { fromBase64 } from "../src/sol/bytes.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { PUBLIC_LIMITS } from "../src/guards.js";
import { LAYOUT } from "../src/sol/layout.js";
import { ensureLpCoinsSchema, _resetLpCoins } from "../src/lpcoins.js";
import { _resetLpKit } from "../src/lpkit.js";
import { browser, chain as mainChain, newWorld, realClock, useClock, advance } from "./helpers/world.js";
import { DEMOV, DEMOV_CITY, DEMOV_COIN, DEMOV_POOL, DEV, LP_ON, PROGRAM, SOL_CONFIG, addr, lpChain } from "./helpers/lpchain.js";
import { fakeCaches } from "./helpers/launchpad.js";

const LIVE_CONFIG = "EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP"; // LAUNCHPAD_DBC_CONFIGS on mainnet (wrangler.jsonc)
const WSOL = "So11111111111111111111111111111111111111112";
const liveConfig = () => decodeConfig(fromBase64(EXPECTED_POOL_CONFIG));
const devnetConfig = () => decodeConfig({ owner: PROGRAM_IDS.dbc, data: [DEV.accounts[SOL_CONFIG].data, "base64"] });
const bps = (part) => Object.fromEntries(Object.entries(part).filter(([k]) => k.endsWith("Bps")));

beforeEach(() => { _resetFees(); _resetLpKit(); _resetLpCoins(); });
after(() => realClock());

/* ---------------------------------------------------------------- the helper */

test("the live config's bytes: 1.25% a trade, Meteora protocol fee 0.25% (a fifth of it the referral), Vicinity 0.5%, founder 0.25%, holders 0.25%; the pool fee 1.25% the same way; 0.05 SOL launch fee 90/10", () => {
  const c = liveConfig();
  assert.equal(c.feeNumerator, 12_500_000n); assert.equal(c.creatorTradingFeePercentage, 50n); assert.equal(c.migratedPoolFeeBps, 125); assert.equal(c.poolCreationFee, 50_000_000n);
  assert.deepEqual([c.partnerLockedLpPercentage, c.partnerLpPercentage, c.creatorLockedLpPercentage, c.creatorLpPercentage], [50, 0, 50, 0], "the two permanently locked positions, half each");
  const S = feeSchedule(c, { address: LIVE_CONFIG, readAt: Date.parse("2026-10-16T14:03:00Z") });
  assert.deepEqual(bps(S.curve), { totalBps: 125, meteoraBps: 25, referralBps: 5, vicinityBps: 50, cityBps: 50, founderBps: 25, holdersBps: 25 });
  assert.deepEqual(bps(S.pool), { totalBps: 125, meteoraBps: 25, positionsBps: 100, vicinityBps: 50, cityBps: 50, founderBps: 25, holdersBps: 25 });
  assert.deepEqual([S.curve.exact, S.pool.exact, S.pool.sameAsCurve], [true, true, true]);
  assert.deepEqual([S.launchFeeLamports, S.launchFeeSol, S.launchSplit], ["50000000", "0.05", { vicinity: 90, meteora: 10 }]);
  assert.deepEqual(S.meteora, { protocolPercent: 20, referralPercent: 20, creationFeeProtocolPercent: 10, migrationFeeBps: 20, source: METEORA.source });
  assert.equal(METEORA.source, "Meteora's program (measured 16 Oct 2026 on copies of its mainnet programs pinned in October 2026; re-measured identical on Meteora's upgraded programs on 16 Oct 2026)");
  assert.deepEqual(S.source, { config: LIVE_CONFIG, readAt: "2026-10-16T14:03:00.000Z" });
  // the same figures the preset names, read from the bytes rather than from the preset
  assert.equal(S.curve.totalBps, DBC_CONFIG_DEFAULTS.tradeFeeBps); assert.equal(S.pool.totalBps, DBC_CONFIG_DEFAULTS.migratedPoolFeeBps); assert.equal(S.launchFeeLamports, DBC_CONFIG_DEFAULTS.poolCreationFee);
  const W = feeWords(S);
  // only the 20% and the fifth are Meteora's program's (said next to them); the referral goes to Vicinity, it is not a refund
  assert.equal(W.curve, "Every buy and sell on the price curve pays 1.25%: Meteora protocol fee 0.25% (20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here), Vicinity 0.5%, the city's founder 0.25%, the city's holder pot 0.25%. After a coin graduates, its pool fee is 1.25%, split the same way, except that none of the Meteora protocol fee goes to Vicinity (anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee).");
  // reward rounds are not on the site yet: the holders' share waits on chain, it is never said to be paid or promised; the referral
  // is the one part paid inside the trade (the fee check of 16 Oct 2026)
  assert.equal(W.steps, "On curve trades made here, only Vicinity's part of the Meteora protocol fee reaches a wallet during the trade. The rest waits on chain until collected: Meteora collects its own, the founder collects theirs, Vicinity claims its own, and the holders' share stays on chain for holder reward rounds. Those rounds are not on the site yet and are not a promise (see the Terms).");
  // the 90 / 10 and the 0.2% are Meteora's program's, not the config's: each names it
  assert.equal(W.oneOff, "Launch fee: 0.05 SOL, paid once by the founder (90% Vicinity, 10% Meteora, as Meteora's program splits it). At graduation Meteora's program keeps 0.2% of the SOL and of the coins moved into the pool, once. No Vicinity fee on wallet transfers; only Solana's network fee and, for a first-time recipient, one-time account rent.");
  assert.equal(W.source, "Read from the price-curve settings on Solana (EZVH…1kSP) at 14:03 UTC. Vicinity's program splits the city's share evenly between the founder and the holder pot.");
  // the founder / holder-pot halving is Vicinity's program's rule, not a field of the settings: said as its own, for the pages to add
  assert.equal(W.halves, "Vicinity's program splits the city's share evenly between the founder and the holder pot.");
  // a coin page: the settings that coin launched under, and a pool sentence that reads true before and after graduation
  const C = feeWords(S, "coin");
  assert.equal(C.source, "Read from this coin's price-curve settings on Solana (EZVH…1kSP) at 14:03 UTC. Vicinity's program splits the city's share evenly between the founder and the holder pot.");
  assert.equal(C.curve, W.curve.replace("After a coin graduates, its pool fee", "After graduation, this coin's pool fee"));
  assert.deepEqual([C.steps, C.oneOff], [W.steps, W.oneOff]);
  // a coin that has moved to its pool: the pool's fee leads, with its own figures and Meteora's 20% sourced; the curve's follows in
  // the past tense; the steps say only what waits on chain
  assert.equal(C.graduated.curve, "This coin has graduated. Every buy and sell in its pool pays 1.25%: Meteora protocol fee 0.25% (20% of the fee, set by Meteora's program), Vicinity 0.5%, the city's founder 0.25%, the city's holder pot 0.25%. Anyone else who adds liquidity to the pool takes part of everything but the Meteora protocol fee, so these shares can be smaller. Before graduation, every buy and sell on the price curve paid 1.25%, split the same way, except that Meteora's program sent a fifth of the Meteora protocol fee to Vicinity on trades made here.");
  assert.equal(C.graduated.steps, "Each share waits on chain until collected: Meteora collects its own, the founder collects theirs, Vicinity claims its own, and the holders' share stays on chain for holder reward rounds. Those rounds are not on the site yet and are not a promise (see the Terms).");
  assert.equal(W.graduated, undefined, "the Launchpad speaks of no one coin");
  // every number carries its source: the 20% and the fifth are named as Meteora's program's in the same clause
  assert.match(W.curve, /\(20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here\)/);
  for (const t of [W.curve, W.steps, W.oneOff, W.source, W.halves, C.curve, C.source, C.graduated.curve, C.graduated.steps]) {
    assert.doesNotMatch(t, /liquidity provider|LP revenue|LP fee|protocol\/liquidity/i, "Meteora's cut is its protocol fee, never liquidity");
    assert.doesNotMatch(t, /comes back|refund|will claim|\bconfig\b/i, "no refund, no promise, no jargon");
    assert.doesNotMatch(t, /referral|position/i, "plain words: no referral, no position");
    assert.doesNotMatch(t, /Meteora's (cut|fee)\b|\bits cut\b/, "one name for Meteora's cut: the Meteora protocol fee");
  }
  // the devnet curve the tests record (4ZLtvU…): the same split, a 0.01 SOL launch fee
  const D = feeSchedule(devnetConfig());
  assert.deepEqual([bps(D.curve), D.launchFeeSol, D.pool.sameAsCurve], [bps(S.curve), "0.01", true]);
  assert.equal(feeSchedule(null), null, "no config: no schedule (nothing is ever said that was not read)");
});

test("synthetic configs: a 2% curve and a 2.3% curve with a 33% creator share and 60/40 liquidity; the helper assumes no value, says 'about' where a split is not whole", () => {
  const base = { partnerLockedLpPercentage: 50, partnerLpPercentage: 0, creatorLockedLpPercentage: 50, creatorLpPercentage: 0 };
  const two = feeSchedule({ ...base, feeNumerator: 20_000_000n, creatorTradingFeePercentage: 50n, migratedPoolFeeBps: 200, poolCreationFee: 50_000_000n });
  assert.deepEqual(bps(two.curve), { totalBps: 200, meteoraBps: 40, referralBps: 8, vicinityBps: 80, cityBps: 80, founderBps: 40, holdersBps: 40 });
  assert.deepEqual(bps(two.pool), { totalBps: 200, meteoraBps: 40, positionsBps: 160, vicinityBps: 80, cityBps: 80, founderBps: 40, holdersBps: 40 });
  assert.equal(feeWords(two).curve, "Every buy and sell on the price curve pays 2%: Meteora protocol fee 0.4% (20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here), Vicinity 0.8%, the city's founder 0.4%, the city's holder pot 0.4%. After a coin graduates, its pool fee is 2%, split the same way, except that none of the Meteora protocol fee goes to Vicinity (anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee).");
  // 2.3%, creator 33%, pool 1.8% to positions holding 60 / 40 of the liquidity, a 0.123 SOL launch fee
  const odd = feeSchedule({ feeNumerator: 23_000_000n, creatorTradingFeePercentage: 33n, migratedPoolFeeBps: 180, poolCreationFee: 123_000_000n,
    partnerLockedLpPercentage: 60, partnerLpPercentage: 0, creatorLockedLpPercentage: 40, creatorLpPercentage: 0 });
  assert.deepEqual(bps(odd.curve), { totalBps: 230, meteoraBps: 46, referralBps: 9.2, vicinityBps: 123.3, cityBps: 60.7, founderBps: 30.4, holdersBps: 30.4 });
  assert.equal(odd.curve.exact, false);
  assert.deepEqual(odd.curve.text, { total: "2.3%", meteora: "0.46%", referral: "0.092%", vicinity: "about 1.233%", city: "about 0.607%", founder: "about 0.304%", holders: "about 0.304%" });
  assert.deepEqual(bps(odd.pool), { totalBps: 180, meteoraBps: 36, positionsBps: 144, vicinityBps: 86.4, cityBps: 57.6, founderBps: 28.8, holdersBps: 28.8 });
  assert.deepEqual([odd.pool.exact, odd.pool.sameAsCurve, odd.launchFeeSol], [true, false, "0.123"]);
  const W = feeWords(odd);
  assert.equal(W.curve, "Every buy and sell on the price curve pays 2.3%: Meteora protocol fee 0.46% (20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here), Vicinity about 1.233%, the city's founder about 0.304%, the city's holder pot about 0.304%. After a coin graduates, its pool fee is 1.8%, split: Meteora protocol fee 0.36%, Vicinity 0.864%, the city's founder 0.288%, the city's holder pot 0.288%; none of the Meteora protocol fee goes to Vicinity (anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee).");
  assert.ok(W.oneOff.startsWith("Launch fee: 0.123 SOL, paid once by the founder (90% Vicinity, 10% Meteora, as Meteora's program splits it)."), W.oneOff);
  assert.equal(W.source, "Read from the price-curve settings on Solana. Vicinity's program splits the city's share evenly between the founder and the holder pot.", "no address, no time: nothing made up");
  // graduated, a pool whose figures differ from the curve's: each named in full, the curve's in the past tense with its source
  assert.equal(feeWords(odd, "coin").graduated.curve, "This coin has graduated. Every buy and sell in its pool pays 1.8%: Meteora protocol fee 0.36% (20% of the fee, set by Meteora's program), Vicinity 0.864%, the city's founder 0.288%, the city's holder pot 0.288%. Anyone else who adds liquidity to the pool takes part of everything but the Meteora protocol fee, so these shares can be smaller. Before graduation, every buy and sell on the price curve paid 2.3%: Meteora protocol fee 0.46% (20% of the fee, set by Meteora's program, which sent a fifth of that to Vicinity on trades made here), Vicinity about 1.233%, the city's founder about 0.304%, the city's holder pot about 0.304%.");
  // Meteora's percentages are options, not assumptions
  const other = feeSchedule(liveConfig(), { protocolPercent: 25, referralPercent: 50, creationFeeProtocolPercent: 20 });
  assert.deepEqual([other.curve.meteoraBps, other.curve.text.meteora, other.curve.referralBps, other.curve.vicinityBps, other.launchSplit], [31.3, "about 0.313%", 15.6, 46.9, { vicinity: 80, meteora: 20 }]);
  assert.match(feeWords(other).curve, /Meteora protocol fee about 0\.313% \(25% of the fee, set by Meteora's program, which sends half of that to Vicinity on trades made here\)/);
  assert.ok(feeWords(other).steps.startsWith("On curve trades made here, only Vicinity's part of the Meteora protocol fee reaches a wallet during the trade. The rest waits on chain until collected:"));
  // no referral: nothing reaches a wallet in the trade, and nothing of Meteora's cut is said to go to Vicinity, on the curve or after
  const none = feeWords(feeSchedule(liveConfig(), { referralPercent: 0 }));
  assert.equal(none.steps, "No share reaches a wallet during the trade. Each waits on chain until collected: Meteora collects its own, the founder collects theirs, Vicinity claims its own, and the holders' share stays on chain for holder reward rounds. Those rounds are not on the site yet and are not a promise (see the Terms).");
  assert.match(none.curve, /Meteora protocol fee 0\.25% \(20% of the fee, set by Meteora's program\), Vicinity/);
  assert.match(none.curve, /its pool fee is 1\.25%, split the same way \(anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee\)\.$/);
  const noneCoin = feeWords(feeSchedule(liveConfig(), { referralPercent: 0 }), "coin").graduated;
  assert.ok(noneCoin.curve.endsWith("Before graduation, every buy and sell on the price curve paid 1.25%, split the same way."), noneCoin.curve);
  assert.ok(noneCoin.steps.startsWith("Each share waits on chain until collected:"), noneCoin.steps);
  // "about" only where the figure is not exact to a tenth of a basis point: 9.2 bps IS 0.092%, so it is said plainly
  assert.equal(odd.curve.text.referral, "0.092%");
});

test("a fee that is not flat is never described: a fee scheduler or rate limiter, a dynamic fee, a pool fee that is not the customizable one (our program allows none of them)", () => {
  const c = liveConfig();
  assert.deepEqual([c.baseFeeMode, c.firstFactor, c.secondFactor, c.thirdFactor, c.dynamicFeeOn, c.migrationFeeOption, c.migratedDynamicFee, c.migratedPoolBaseFeeMode], [0, 0, 0n, 0n, 0, 6, 0, 0], "the live config's bytes: flat");
  assert.ok(feeSchedule({ ...c, baseFeeMode: 1 }), "exponential mode with no decay is flat too (validate.rs:215)");
  for (const [k, v] of [["baseFeeMode", 2], ["firstFactor", 10], ["secondFactor", 1n], ["thirdFactor", 1n], ["dynamicFeeOn", 1], ["migrationFeeOption", 3], ["migratedDynamicFee", 1], ["migratedPoolBaseFeeMode", 1]]) {
    assert.equal(feeSchedule({ ...c, [k]: v }), null, k);
  }
  assert.ok(feeSchedule(devnetConfig()), "the devnet config is flat");
});

/* ---------------------------------------------------------------- the route */

/** The gate on, on devnet with the recorded accounts (the SOL price curve 4ZLtvU…); `extra` over the settings. */
function world(extra = {}) {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld(), ...LP_ON, LAUNCHPAD_DBC_CONFIGS: SOL_CONFIG, ...extra };
  const lp = lpChain(), main = mainChain();
  const fetchImpl = async (url, init) => (String(url).startsWith(LP_ON.LAUNCHPAD_RPC_URL) ? lp.fetchImpl(url, init) : main(url, init));
  const b = browser(env, { ip: "203.0.113.5" });
  const get = async (path, method = "GET") => { const r = await b.send(path, { method, fetchImpl, body: method === "POST" ? {} : undefined }); return { status: r.status, headers: r.headers, data: await r.json() }; };
  const configReads = () => lp.S.log.filter((l) => l.method === "getMultipleAccounts" && l.params[0].includes(SOL_CONFIG)).length;
  return { env, lp, S: lp.S, get, fetchImpl, configReads };
}
async function recordDemov(env) {
  await ensureLpCoinsSchema(env.DB);
  await env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, launch_sig, launched_at, recorded_at)
      VALUES ('devnet', ?, ?, ?, ?, ?, 'Demo Village', 'DEMOV', ?, ?, ?, NULL, '2026-10-09T10:00:00.000Z', '2026-10-09T10:05:00.000Z')`)
    .bind(PROGRAM, DEMOV_CITY, DEMOV, DEMOV_COIN, addr(7), WSOL, SOL_CONFIG, DEMOV_POOL).run();
}

test("GET /api/fees: dark without the gate; the live config's schedule with its words and source, Cache-Control public 300; POST is 405", async () => {
  const dark = browser(newWorld());
  for (const path of ["/api/fees", `/api/fees?mint=${DEMOV}`]) { const r = await dark.send(path); assert.deepEqual([r.status, (await r.json()).error], [404, "not_enabled"], path); }
  const w = world();
  const r = await w.get("/api/fees");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.headers.get("Cache-Control"), "public, max-age=300");
  const d = r.data;
  assert.deepEqual([d.ok, d.cluster, d.config, d.coin, d.readAt], [true, "devnet", SOL_CONFIG, undefined, "2026-10-20T12:00:00.000Z"]);
  assert.deepEqual(bps(d.curve), { totalBps: 125, meteoraBps: 25, referralBps: 5, vicinityBps: 50, cityBps: 50, founderBps: 25, holdersBps: 25 });
  assert.deepEqual([d.pool.totalBps, d.pool.sameAsCurve, d.launchFeeLamports, d.launchFeeSol, d.launchSplit], [125, true, "10000000", "0.01", { vicinity: 90, meteora: 10 }]);
  assert.equal(d.meteora.source, METEORA.source);
  assert.equal(d.words.curve, feeWords(feeSchedule(devnetConfig())).curve);
  assert.ok(d.words.oneOff.startsWith("Launch fee: 0.01 SOL, paid once by the founder (90% Vicinity, 10% Meteora, as Meteora's program splits it)."), d.words.oneOff);
  assert.equal(d.words.source, "Read from the price-curve settings on Solana (4ZLt…nrD7) at 12:00 UTC. Vicinity's program splits the city's share evenly between the founder and the holder pot.");
  assert.equal((await w.get("/api/fees", "POST")).status, 405);
  // the config bytes are kept 10 minutes per server: a second answer costs no chain read; after 10 minutes the config is read again
  assert.equal(w.configReads(), 1);
  await w.get("/api/fees");
  assert.equal(w.configReads(), 1, "memo");
  advance(10 * 60_000 + 1);
  await w.get("/api/fees");
  assert.equal(w.configReads(), 2, "read again after 10 minutes");
});

test("GET /api/fees?mint=: the config THAT coin launched under (coins keep theirs for ever), named as the coin's; a bad mint is 400, an unknown one 404 (cached a minute)", async () => {
  const w = world();
  await recordDemov(w.env);
  const r = await w.get(`/api/fees?mint=${DEMOV}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.headers.get("Cache-Control"), "public, max-age=300");
  assert.deepEqual([r.data.config, r.data.coin], [SOL_CONFIG, { mint: DEMOV, cityId: DEMOV_CITY, symbol: "DEMOV" }]);
  assert.equal(r.data.words.source, "Read from this coin's price-curve settings on Solana (4ZLt…nrD7) at 12:00 UTC. Vicinity's program splits the city's share evenly between the founder and the holder pot.");
  assert.match(r.data.words.curve, /After graduation, this coin's pool fee is 1\.25%/, "a coin's own words");
  assert.equal(r.data.curve.totalBps, 125);
  assert.deepEqual([(await w.get("/api/fees?mint=nope")).status, (await w.get("/api/fees?mint=nope")).data.error], [400, "bad_mint"]);
  const unknown = await w.get(`/api/fees?mint=${addr(42)}`);
  assert.deepEqual([unknown.status, unknown.data.error, unknown.headers.get("Cache-Control")], [404, "not_found", "public, max-age=60"]);
});

test("GET /api/fees: an unknown mint's chain lookup is counted once under lp_coin (as /api/lp/coin counts it), not a second time under fees; a config that is not flat answers 404 config_not_flat", async () => {
  const w = world({ LIMIT_SALT: "s" });
  for (let i = 0; i < 59; i++) { _resetFees(); assert.equal((await w.get("/api/fees")).status, 200, `miss ${i + 1}`); }
  // the 60th count of "fees": allowed; the lookup of the unknown mint is lp_coin's (before: a 61st "fees", a 429)
  const unknown = await w.get(`/api/fees?mint=${addr(43)}`);
  assert.deepEqual([unknown.status, unknown.data.error], [404, "not_found"]);
  // a dynamic fee switched on in the config's bytes: no schedule is said
  _resetFees(); _resetLpKit();
  const odd = world();
  const bytes = Buffer.from(odd.S.accounts[SOL_CONFIG].data, "base64");
  bytes[LAYOUT.PoolConfig.fields["pool_fees.dynamic_fee.initialized"].at] = 1;
  odd.S.accounts[SOL_CONFIG] = { ...odd.S.accounts[SOL_CONFIG], data: bytes.toString("base64") };
  const r = await odd.get("/api/fees");
  assert.deepEqual([r.status, r.data.error], [404, "config_not_flat"]);
});

test("GET /api/fees: no live config set is 404 config_not_set; a chain outage is 503 rpc_unavailable (no-store); the edge cache serves the second viewer; the public limit counts a miss", async () => {
  const unset = world({ LAUNCHPAD_DBC_CONFIGS: "" });
  assert.deepEqual([(await unset.get("/api/fees")).status, (await unset.get("/api/fees")).data.error], [404, "config_not_set"]);
  const down = world();
  down.S.down = true;
  const r = await down.get("/api/fees");
  assert.deepEqual([r.status, r.data.error, r.headers.get("Cache-Control")], [503, "rpc_unavailable", "no-store"]);
  // the edge cache (src/index.js cached): one chain read for every viewer in a region for 5 minutes
  _resetFees();
  const edge = fakeCaches(); edge.install();
  try {
    const w = world();
    assert.equal((await w.get("/api/fees")).status, 200);
    _resetFees(); // the server memo gone (another server): the edge copy answers
    const again = await w.get("/api/fees");
    assert.deepEqual([again.status, again.headers.get("Cache-Control"), w.configReads()], [200, "public, max-age=300", 1]);
  } finally { edge.uninstall(); }
  assert.deepEqual(PUBLIC_LIMITS.fees, { max: 60, windowMs: 60_000 });
  const w = world({ LIMIT_SALT: "s" });
  for (let i = 0; i < 60; i++) { _resetFees(); assert.equal((await w.get("/api/fees")).status, 200, `miss ${i + 1}`); }
  _resetFees();
  const slow = await w.get("/api/fees");
  assert.deepEqual([slow.status, slow.data.error], [429, "slow_down"]);
});

/* ---------------------------------------------------------------- the guard */

test("no fee literal is left: '1.25%' appears in src/*.js and public/*.js only in the generated config preset or in a comment that says 'today'", () => {
  const root = new URL("../", import.meta.url);
  const files = [...readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`),
    ...readdirSync(new URL("src/sol/", root)).filter((f) => f.endsWith(".js")).map((f) => `src/sol/${f}`),
    ...readdirSync(new URL("public/", root)).filter((f) => f.endsWith(".js")).map((f) => `public/${f}`)];
  assert.ok(files.includes("src/fees.js") && files.includes("public/swap.js"));
  const bad = [];
  for (const f of files) {
    if (f === "src/sol/dbc-config-data.js") continue; // GENERATED from the preset solana/sdk/launchpad/config.mjs: the one place a default lives
    readFileSync(new URL(f, root), "utf8").split("\n").forEach((line, i) => {
      if (!/1\.25\s?%/.test(line)) return;
      const comment = /^\s*(\/\/|\*|\/\*)/.test(line) && /today/.test(line);
      if (!comment) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], "every fee figure comes from the deployed config (src/fees.js)");
  // the figures the pages show come through the helper: the launch card, the Buy panel and the two Fees sections ask the site, never a constant
  assert.match(readFileSync(new URL("public/lp-launch.js", root), "utf8"), /const t = st && st\.fees && typeof st\.fees\.totalText === "string" \? st\.fees\.totalText : "";/);
  assert.match(readFileSync(new URL("public/lp-launch.js", root), "utf8"), /const shareNote = \(f\) => \(f && typeof f\.sharePct === "string"/);
  assert.match(readFileSync(new URL("public/swap.js", root), "utf8"), /api\(`\/api\/fees\?mint=\$\{encodeURIComponent\(mint\)\}`\)/);
  assert.match(readFileSync(new URL("public/coin.js", root), "utf8"), /api\(`\/api\/fees\?mint=\$\{encodeURIComponent\(d\.mint\)\}`\)/);
  assert.match(readFileSync(new URL("public/launchpad.js", root), "utf8"), /await api\("\/api\/fees"\)/);
  const lpadmin = readFileSync(new URL("src/lpadmin.js", root), "utf8");
  assert.match(lpadmin, /\$\{c\.facts\.target\} target, \$\{c\.facts\.tradeFee\} fee, \$\{c\.facts\.launchFee\} launch fee/, "the admin's defaults sentence derives its figures from the decoded config");
  assert.match(lpadmin, /const S = feeSchedule\(c\);[\s\S]{0,600}tradeFee: S \? S\.curve\.text\.total : null, launchFee: S \? `\$\{S\.launchFeeSol\} SOL`/, "through the helper");
});
