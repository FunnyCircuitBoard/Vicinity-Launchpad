// The official city coins (src/officialcoins.js) and the Official addresses page (/official):
//   * GET /official-coins.csv (made for Jupiter's token tags: one mint per line, nothing else) and GET /api/official-coins (JSON) read
//     ONLY from the chain, through the real API and the fake launchpad chain on mainnet settings (the deployed ones of wrangler.jsonc):
//     an empty registry is an empty 200; a coin whose Coin record (["coin", city id], our program, the Coin discriminator) created its
//     Meteora pool on an allowed config with its own mint is listed; look-alikes are never read (a pool no record names, also one whose
//     creator role was handed to one of our real records, one created by an empty account of its maker's that shows our program as its
//     owner, a record without the Coin discriminator); a coin is left out (and logged with public addresses only) for ONE reason, its
//     config no longer in LAUNCHPAD_DBC_CONFIGS, and the edge key names the configs (a config added lists its coins at once). Every
//     other mismatch cannot be the chain's (launch.rs:193-201) and is 503: a record's pool whose creator, config or mint is not the
//     record's, owned by another program, not decodable whatever its bytes (empty, cut short, a flipped first byte, a config's), two
//     pool entries swapped. So are a node of another network, a failed read, a first node that passes the genesis check and then
//     refuses (never the backup nobody checked, even when its own genesis probe got no answer), pools read on a node behind the
//     records' slot, records read on a node behind this server's last whole reading or without a coin this site recorded (or with
//     the database unreadable), and every answer that cannot be the chain's (a row that is not one of our canonical Coin records, or
//     comes twice; a pool entry that is not null or a whole account, a pool the node calls absent, a short or stale getMultipleAccounts
//     answer, two records with one mint): 503 and never a list, empty or partial (nothing kept, in memory or at the edge); a backup
//     whose genesis hash was checked serves the list when the first node is down; the headers (HEAD too), the 10-minute edge copy
//     (browsers 5), the 1-minute memo per server and the public limit; dark without the settings; the CSV only on mainnet; the
//     recorded devnet coin passes the same rule on its real bytes.
//   * the page: built from src/official.js officialAddresses() with the deployed settings, every address with a Copy button and its
//     Solscan page (the upgrade authority with its multisig too), the same labels as the token page, the coin table read from
//     /api/official-coins (rows with the pool and the coin record, none yet, a failed read, not on this site, another network), the
//     "check it yourself" paragraph (the discriminator, the address, the offsets with the record's config; nothing promised about
//     other sites; never "go by the pool's creator"), no "verified" or "audited", no warning banner, never style.css's
//     .addr pill on a row; the footer link on every page.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import worker from "../src/index.js";
import { EDGE_SECONDS, BROWSER_SECONDS, READ_MS, _resetOfficialCoins, officialCacheKey, ruleOf } from "../src/officialcoins.js";
import { GENESIS, _resetLpKit, checkGenesis } from "../src/lpkit.js";
import { _resetLpCoins, recordLaunchedCoin } from "../src/lpcoins.js";
import { lpSetup } from "../src/cluster.js";
import { _resetRpcHealth } from "../src/rpcpool.js";
import { PUBLIC_LIMITS } from "../src/guards.js";
import { OFFICIAL, PROGRAM_UPGRADE_AUTHORITY, PROGRAM_UPGRADE_MULTISIG, officialAddresses, teamLockLabel, teamWalletLabel } from "../src/official.js";
import { ADDRESSES, PROGRAM_IDS, findProgramAddress, launchpad as launchpadPdas } from "../src/sol/pda.js";
import { base58Decode } from "../src/solana.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { LAYOUT } from "../src/sol/layout.js";
import { buildPages, deployedVars } from "../scripts/pages/build.mjs";
import { advance, browser, newWorld, realClock, useClock } from "./helpers/world.js";
import { fakeCaches, seedCoin } from "./helpers/launchpad.js";
import { DEMOV, DEMOV_COIN, DEMOV_POOL, LP_ON, METAPLEX, SOL_CONFIG, addr, layoutData, lpChain, metaplexData } from "./helpers/lpchain.js";
import { openPage } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
// the facts (16 Oct 2026; the programs' upgrade authority read on chain that day, solana/release/mainnet-2026-10-10/BUILD.md)
const PROGRAM = "AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai", REWARDS = "EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG";
const CONFIG = "EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP", VAULT = "AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X";
const MULTISIG = "6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV", SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
// the Coin discriminator d7c335eed9c4d533 in base58, as getProgramAccounts' memcmp at byte 0 carries it
const COIN_DISC = "d6AgYymcV8v";
const FEE_WALLET = "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN", VICINITY = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const WSOL = "So11111111111111111111111111111111111111112", RPC = "https://lp-rpc.test/mainnet";
const LIVE_CONFIG = JSON.parse(read("test/fixtures/launchpad-worker/mainnet-pool-config.json")).accounts[CONFIG];
const UTICA = 5142056, SYRACUSE = 5140405, ALBANY = 5106834, NYC = 5128581;

/** The deployed city-coin settings (wrangler.jsonc), with the fake chain's address as the RPC. */
const ON = () => {
  const v = deployedVars();
  return { LAUNCHPAD_CLUSTER: v.LAUNCHPAD_CLUSTER, LAUNCHPAD_PROGRAM_ID: v.LAUNCHPAD_PROGRAM_ID, LAUNCHPAD_REWARDS_PROGRAM_ID: v.LAUNCHPAD_REWARDS_PROGRAM_ID, LAUNCHPAD_DBC_CONFIGS: v.LAUNCHPAD_DBC_CONFIGS, LAUNCHPAD_RPC_URL: RPC };
};
const errors = [];
const realError = console.error;
beforeEach(() => {
  _resetOfficialCoins(); _resetLpKit(); _resetLpCoins(); _resetRpcHealth();
  useClock("2026-10-20T12:00:00Z");
  errors.length = 0;
  console.error = (...a) => errors.push(a.map(String).join(" "));
});
after(() => { realClock(); console.error = realError; });

function world(extra = {}) {
  const env = { ...newWorld(), ...ON(), ...extra };
  const chain = lpChain({ genesis: GENESIS.mainnet, accounts: { [CONFIG]: { ...LIVE_CONFIG } } });
  const b = browser(env, { ip: "203.0.113.7" });
  const get = async (path, method = "GET") => { const r = await b.send(path, { method, fetchImpl: chain.fetchImpl }); return { status: r.status, headers: r.headers, text: await r.text() }; };
  const json = async (path) => { const r = await get(path); return { ...r, data: JSON.parse(r.text) }; };
  return { env, chain, S: chain.S, get, json, reads: () => chain.calls("getProgramAccounts").length };
}
let n = 0;
/**
 * One launched city coin on the fake chain: the Coin record at ["coin", city id] of our program, its Meteora pool and its Metaplex
 * metadata, exactly as a launch leaves them; every option makes one thing different (a look-alike's creator, another config, ...).
 */
async function launch(w, { cityId, symbol = "UTICA", mint = addr(400 + ++n), pool = addr(600 + n), creator = null, config = CONFIG, recordConfig = config, baseMint = null,
  quoteReserve = 3_000_000_000n, migrated = 0, poolOwner = PROGRAM_IDS.dbc, withPool = true, at = null, discriminator = true }) {
  const record = await launchpadPdas(PROGRAM).coin(BigInt(cityId));
  let data = layoutData("Coin", { city_id: cityId, founder: addr(900), mint, quote_mint: WSOL, dbc_config: recordConfig, dbc_pool: pool, launched_at: 1_792_000_000 });
  if (!discriminator) { const b = Buffer.from(data, "base64"); b[0] ^= 0xff; data = b.toString("base64"); }
  w.S.accounts[at || record] = { owner: PROGRAM, data };
  if (withPool) w.S.accounts[pool] = { owner: poolOwner, data: layoutData("VirtualPool", { config, creator: creator || record, base_mint: baseMint || mint, quote_reserve: quoteReserve, is_migrated: migrated }) };
  w.S.accounts[await metadataAddress(mint)] = { owner: METAPLEX, data: metaplexData({ mint, name: `${symbol} city coin`, symbol, uri: `https://vicinity.city/coin-meta/${mint}.json` }) };
  return { record, mint, pool };
}

/* ---------------------------------------------------------------- the facts */

test("the deployed settings name our programs and our price-curve setting on mainnet; who can upgrade the programs is the Squads vault the build record names", async () => {
  assert.deepEqual(ON(), { LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_DBC_CONFIGS: CONFIG, LAUNCHPAD_RPC_URL: RPC });
  assert.equal(PROGRAM_UPGRADE_AUTHORITY, VAULT);
  // the vault is index 0 of the multisig /official links (Squads v4: ["multisig", multisig, "vault", 0]); its 2-of-3 rule is that account's
  assert.equal(PROGRAM_UPGRADE_MULTISIG, MULTISIG);
  const te = (x) => new TextEncoder().encode(x);
  assert.equal((await findProgramAddress([te("multisig"), base58Decode(MULTISIG), te("vault"), Uint8Array.of(0)], SQUADS_V4))[0], VAULT);
  const build = read("solana/release/mainnet-2026-10-10/BUILD.md");
  for (const p of [PROGRAM, REWARDS]) assert.match(build, new RegExp(`\\| \`${p}\` \\([a-z]+\\) \\| SHA-256 [^|]+\\| \`${VAULT}\` \\(Squads vault, 2 of 3\\) \\|`), p);
  assert.ok(read("wrangler.jsonc").includes(`Squads vault\n    // ${VAULT}`), "the settings' own note names the same vault");
  assert.equal(ADDRESSES.feeRecipient, FEE_WALLET);
  assert.deepEqual(LAYOUT.Coin.discriminator, [0xd7, 0xc3, 0x35, 0xee, 0xd9, 0xc4, 0xd5, 0x33], "the Coin discriminator d7c335eed9c4d533");
  assert.deepEqual([LAYOUT.VirtualPool.fields.config.at, LAYOUT.VirtualPool.fields.creator.at, LAYOUT.VirtualPool.fields.base_mint.at], [72, 104, 136]);
  assert.deepEqual(PUBLIC_LIMITS.official_coins, { max: 60, windowMs: 60_000 });
  assert.deepEqual([EDGE_SECONDS, BROWSER_SECONDS, READ_MS], [600, 300, 60_000], "the edge keeps 10 minutes; a server's memo only joins the CSV and the JSON");
  // the settings' own warning: a config a coin launched on is never removed (the coin would leave the list, and its tag with it)
  assert.match(read("wrangler.jsonc"), /LAUNCHPAD_DBC_CONFIGS: only add configs \(comma-separated\), never remove one a coin launched on/);
  // the CSV path reaches the Worker, not the static files
  assert.ok(JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, "")).assets.run_worker_first.includes("/official-coins.csv"));
});

/* ---------------------------------------------------------------- the routes */

test("dark: without the city-coin settings both paths are 404 not_enabled before anything is read; the CSV is mainnet only (devnet: 404, the JSON says devnet)", async () => {
  const dark = browser(newWorld());
  const lp = lpChain();
  const csv = await dark.send("/official-coins.csv", { fetchImpl: lp.fetchImpl });
  assert.deepEqual([csv.status, csv.headers.get("content-type"), await csv.text()], [404, "text/plain; charset=utf-8", "not_enabled\n"]);
  const js = await dark.send("/api/official-coins", { fetchImpl: lp.fetchImpl });
  assert.deepEqual([js.status, await js.json()], [404, { ok: false, error: "not_enabled" }]);
  assert.equal(lp.S.log.length, 0, "no chain call while dark");
  // through the Worker's own fetch: the CSV is answered in code, never handed to the static files
  const asked = [];
  const r = await worker.fetch(new Request("https://vicinity.city/official-coins.csv"), { ...newWorld(), ASSETS: { fetch: async (q) => { asked.push(q.url); return new Response("page", { status: 404 }); } } }, {});
  assert.deepEqual([r.status, await r.text(), asked], [404, "not_enabled\n", []]);
  // devnet (the recorded launchpad): no CSV, which could not say its network; the JSON lists the recorded coin DEMOV, whose real bytes
  // pass the same rule (its pool's creator IS its Coin record)
  const dev = { ...newWorld(), ...LP_ON, LAUNCHPAD_DBC_CONFIGS: SOL_CONFIG };
  const devChain = lpChain();
  const b = browser(dev);
  assert.equal((await b.send("/official-coins.csv", { fetchImpl: devChain.fetchImpl })).status, 404);
  const d = await (await b.send("/api/official-coins", { fetchImpl: devChain.fetchImpl })).json();
  assert.deepEqual([d.ok, d.cluster, d.coins.length], [true, "devnet", 1], JSON.stringify(d));
  assert.deepEqual([d.coins[0].mint, d.coins[0].pool, d.coins[0].coinAccount, d.coins[0].config, d.coins[0].cityId], [DEMOV, DEMOV_POOL, DEMOV_COIN, SOL_CONFIG, "999000003"]);
  // the price-curve settings unset: no list can be checked, so none is given (503, never an empty list)
  _resetOfficialCoins();
  const unset = world({ LAUNCHPAD_DBC_CONFIGS: "" });
  const u = await unset.json("/api/official-coins");
  assert.deepEqual([u.status, u.data, u.headers.get("cache-control")], [503, { ok: false, error: "config_not_set" }, "no-store"]);
  assert.equal(unset.S.log.length, 0);
});

test("an empty registry (mainnet today): the CSV is 200 with an empty body, text/csv; the JSON says so with the rule, the program and the settings", async () => {
  const w = world();
  const csv = await w.get("/official-coins.csv");
  assert.equal(csv.status, 200);
  assert.equal(csv.text, "");
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(csv.headers.get("cache-control"), "public, max-age=300");
  const j = await w.json("/api/official-coins");
  assert.equal(j.status, 200);
  assert.deepEqual(j.data, { ok: true, cluster: "mainnet", readAt: "2026-10-20T12:00:00.000Z", program: PROGRAM, configs: [CONFIG], coins: [], rule: ruleOf(PROGRAM) });
  // the rule starts from the coin record, never from a pool's creator (which a look-alike can copy)
  assert.equal(j.data.rule, `A city coin is listed only if its coin record for that city is owned by the Vicinity launchpad program (${PROGRAM}), the record names the coin's mint and its Meteora pool, and that pool's creator is the record, its price-curve setting is one of those listed in configs, and it holds that mint.`);
  // one chain reading served both: the node's genesis hash first, then getProgramAccounts on our program for 243-byte accounts that
  // start with the Coin discriminator, with the slot of the reading, once
  assert.deepEqual(w.chain.S.log.map((l) => l.method), ["getGenesisHash", "getProgramAccounts"]);
  const gpa = w.chain.calls("getProgramAccounts");
  assert.deepEqual(gpa[0].params, [PROGRAM, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: LAYOUT.Coin.size }, { memcmp: { offset: 0, bytes: COIN_DISC } }], withContext: true }]);
  assert.ok(w.chain.S.log.every((l) => l.url === RPC), "only the launchpad's mainnet RPC is asked");
  assert.deepEqual(errors, []);
});

test("a real coin is listed (CSV: its mint and a newline, nothing else; JSON: city, ticker, mint, pool, config, record, stage), in city order; $VICINITY never is", async () => {
  const w = world();
  w.S.slot = 321_000_000;
  await seedCoin(w.env.DB, { city: UTICA, name: "Utica", coin: "Utica Coin" });
  await seedCoin(w.env.DB, { city: SYRACUSE, name: "Syracuse", coin: "Syracuse Coin" });
  const u = await launch(w, { cityId: UTICA, symbol: "UTICA" });
  const s = await launch(w, { cityId: SYRACUSE, symbol: "SYRACUSE", quoteReserve: 85_000_000_000n }); // the curve is full: 85 SOL
  const a = await launch(w, { cityId: ALBANY, symbol: "ALBANY", migrated: 1 }); // graduated; no design row here: no city name
  const csv = await w.get("/official-coins.csv");
  assert.equal(csv.status, 200);
  assert.equal(csv.text, `${a.mint}\n${s.mint}\n${u.mint}\n`, "one mint per line, by city id, nothing else");
  assert.match(csv.text, /^([1-9A-HJ-NP-Za-km-z]{32,44}\n)*$/);
  assert.ok(!csv.text.includes(VICINITY), "$VICINITY is the platform token, not a city coin");
  const j = await w.json("/api/official-coins");
  assert.deepEqual(j.data.coins, [
    { city: null, cityId: String(ALBANY), ticker: "ALBANY", mint: a.mint, pool: a.pool, config: CONFIG, coinAccount: a.record, stage: "graduated" },
    { city: "Syracuse", cityId: String(SYRACUSE), ticker: "SYRACUSE", mint: s.mint, pool: s.pool, config: CONFIG, coinAccount: s.record, stage: "full" },
    { city: "Utica", cityId: String(UTICA), ticker: "UTICA", mint: u.mint, pool: u.pool, config: CONFIG, coinAccount: u.record, stage: "curve" },
  ]);
  assert.deepEqual(errors, [], "nothing left out");
  // the pools (with the metadata and the config) were read at the records' slot or later
  const gma = w.chain.calls("getMultipleAccounts");
  assert.equal(gma.length, 1);
  assert.deepEqual(gma[0].params[1], { encoding: "base64", commitment: "confirmed", minContextSlot: 321_000_000 });
});

test("look-alikes are never read; a coin is left out (logged with public addresses only) for one reason alone: its pool's config is no longer in LAUNCHPAD_DBC_CONFIGS", async () => {
  const w = world();
  const good = await launch(w, { cityId: UTICA });
  // a look-alike: someone's own pool on our public config, with a coin of the same name; no Coin record of ours names it
  const fakeMint = addr(801), fakePool = addr(802);
  w.S.accounts[fakePool] = { owner: PROGRAM_IDS.dbc, data: layoutData("VirtualPool", { config: CONFIG, creator: addr(803), base_mint: fakeMint, quote_reserve: 1n }) };
  w.S.accounts[await metadataAddress(fakeMint)] = { owner: METAPLEX, data: metaplexData({ mint: fakeMint, name: "UTICA city coin", symbol: "UTICA", uri: "https://example.com/x.json" }) };
  // a coin of ours launched on a price-curve setting the settings no longer list (the record names the same config: a real launch)
  const otherConfig = await launch(w, { cityId: ALBANY, config: addr(804) });
  // a Coin-sized account of our program without the Coin discriminator (the node does not return it)
  const notCoin = await launch(w, { cityId: 1005, discriminator: false });
  // a look-alike that handed its creator role to one of our REAL records (Meteora's transfer_pool_creator: the new creator never signs):
  // its own mint on our public config, creator = Utica's record. On Solscan its creator is owned by our program and holds real Coin data
  const stolenMint = addr(811), stolenPool = addr(812);
  w.S.accounts[stolenPool] = { owner: PROGRAM_IDS.dbc, data: layoutData("VirtualPool", { config: CONFIG, creator: good.record, base_mint: stolenMint, quote_reserve: 1n }) };
  // a look-alike created by an empty 243-byte account of its maker's own key that shows our program as its owner (CreateAccount with our
  // program as the owner): no Coin discriminator, so the node does not even return it
  const emptyKey = addr(813), emptyPool = addr(814), emptyMint = addr(815);
  w.S.accounts[emptyKey] = { owner: PROGRAM, data: Buffer.alloc(LAYOUT.Coin.size).toString("base64") };
  w.S.accounts[emptyPool] = { owner: PROGRAM_IDS.dbc, data: layoutData("VirtualPool", { config: CONFIG, creator: emptyKey, base_mint: emptyMint, quote_reserve: 1n }) };

  const csv = await w.get("/official-coins.csv");
  assert.deepEqual([csv.status, csv.text], [200, `${good.mint}\n`], "only the real one");
  for (const x of [fakeMint, otherConfig.mint, notCoin.mint, stolenMint, emptyMint]) assert.ok(!csv.text.includes(x));
  // the list starts from our records: the node never returned the empty account, and no pool a record does not name was ever read
  const gpa = w.chain.calls("getProgramAccounts")[0];
  assert.deepEqual(gpa.params[1].filters, [{ dataSize: LAYOUT.Coin.size }, { memcmp: { offset: 0, bytes: COIN_DISC } }]);
  const answer = await (await w.chain.fetchImpl(RPC, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: gpa.params }) })).json();
  assert.deepEqual(answer.result.value.map((r) => r.pubkey).sort(), [good.record, otherConfig.record].sort(), "the empty account (and the record without the Coin discriminator) are not in the node's answer");
  const asked = w.chain.calls("getMultipleAccounts").flatMap((c) => c.params[0]);
  for (const x of [stolenPool, emptyPool, fakePool]) assert.ok(!asked.includes(x), x);
  const j = await w.json("/api/official-coins");
  assert.deepEqual(j.data.coins.map((c) => c.mint), [good.mint]);
  // the one reason: an operator's change to LAUNCHPAD_DBC_CONFIGS (wrangler.jsonc says never to remove one a coin launched on)
  assert.deepEqual(errors, [`official coins: left out config_not_allowed city ${ALBANY} coin record ${otherConfig.record}`], "nothing else was logged: the reading was whole");
  for (const e of errors) assert.ok(!e.includes("lp-rpc.test") && !e.includes("203.0.113"), `no URL or connection in a log line: ${e}`);
});

test("the edge key names the configs: a config added to LAUNCHPAD_DBC_CONFIGS lists its coins at once, never the old list for 10 minutes", async () => {
  const edge = fakeCaches(); edge.install();
  try {
    const w = world();
    const good = await launch(w, { cityId: UTICA });
    const albany = await launch(w, { cityId: ALBANY, config: addr(804) });
    const first = await w.get("/official-coins.csv");
    assert.deepEqual([first.status, first.text, w.reads()], [200, `${good.mint}\n`, 1]);
    // the same settings: an edge hit (another server, nothing in its memory, asks the chain nothing)
    _resetOfficialCoins();
    assert.deepEqual([(await w.get("/official-coins.csv")).text, w.reads()], [`${good.mint}\n`, 1]);
    // the config added: a new key, so the chain is read again at once and the coin on it is listed
    const env2 = { ...w.env, LAUNCHPAD_DBC_CONFIGS: `${CONFIG},${addr(804)}` };
    const r = await browser(env2, { ip: "203.0.113.10" }).send("/official-coins.csv", { fetchImpl: w.chain.fetchImpl });
    assert.deepEqual([r.status, await r.text(), w.reads()], [200, `${albany.mint}\n${good.mint}\n`, 2]);
    const keys = [...edge.store.keys()];
    assert.equal(keys.length, 2);
    assert.notEqual(officialCacheKey(lpSetup(w.env), true), officialCacheKey(lpSetup(env2), true));
    assert.deepEqual(keys.sort(), [officialCacheKey(lpSetup(w.env), true), officialCacheKey(lpSetup(env2), true)].map((k) => "https://cache.vicinity.internal/" + k).sort());
    assert.match(officialCacheKey(lpSetup(w.env), false), new RegExp(`^official-coins-json-mainnet-${PROGRAM}-[0-9a-f]{8}$`));
  } finally { edge.uninstall(); }
});

test("a failed chain read is 503 with no list (the CSV's answer is plain text, never text/csv), a half-read too; it is not kept: the next request reads again", async () => {
  const w = world();
  await launch(w, { cityId: UTICA });
  w.S.down = true;
  const csv = await w.get("/official-coins.csv");
  assert.equal(csv.status, 503);
  assert.equal(csv.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.deepEqual([csv.headers.get("cache-control"), csv.headers.get("retry-after")], ["no-store", "60"]);
  assert.doesNotMatch(csv.text, /[1-9A-HJ-NP-Za-km-z]{32,44}/, "no address in it");
  assert.match(csv.text, /^rpc_unavailable: /);
  const j = await w.json("/api/official-coins");
  assert.deepEqual([j.status, j.data, j.headers.get("cache-control")], [503, { ok: false, error: "rpc_unavailable" }, "no-store"]);
  // the records read, the pools not: still no list (never the coins whose pools happened to be read)
  w.S.down = false;
  const realFetch = w.chain.fetchImpl;
  const half = async (url, init) => (JSON.parse(init.body).method === "getMultipleAccounts" ? new Response("busy", { status: 503 }) : realFetch(url, init));
  const b = browser(w.env, { ip: "203.0.113.8" });
  const r = await b.send("/official-coins.csv", { fetchImpl: half });
  assert.deepEqual([r.status, r.headers.get("content-type")], [503, "text/plain; charset=utf-8"]);
  const r2 = await b.send("/api/official-coins", { fetchImpl: half });
  assert.deepEqual([r2.status, (await r2.json()).error], [503, "rpc_unavailable"]);
  // back: read again at once (a failed reading is never kept)
  const ok = await w.get("/official-coins.csv");
  assert.deepEqual([ok.status, ok.text.split("\n").length], [200, 2]);
});

test("a node of another network (a devnet RPC behind the mainnet settings answers 'no Coin record' without an error) is 503 on both paths with nothing read and nothing kept, in memory or at the edge", async () => {
  const edge = fakeCaches(); edge.install();
  try {
    const w = world();
    await launch(w, { cityId: UTICA });
    w.S.genesis = GENESIS.devnet;
    const csv = await w.get("/official-coins.csv");
    assert.deepEqual([csv.status, csv.headers.get("content-type"), csv.headers.get("cache-control")], [503, "text/plain; charset=utf-8", "no-store"]);
    assert.match(csv.text, /^rpc_unavailable: /);
    const j = await w.json("/api/official-coins");
    assert.deepEqual([j.status, j.data], [503, { ok: false, error: "rpc_unavailable" }]);
    assert.equal(w.reads(), 0, "no getProgramAccounts on a node of another network");
    assert.deepEqual(w.chain.S.log.map((l) => l.method), ["getGenesisHash", "getGenesisHash"], "only its genesis hash was asked, each time");
    assert.equal(edge.store.size, 0, "nothing at the edge");
    assert.ok(errors.some((e) => e === "official coins: not read wrong_cluster"), errors.join("\n"));
    // the right node again: read at once (no failed reading was kept)
    w.S.genesis = GENESIS.mainnet;
    const ok = await w.get("/official-coins.csv");
    assert.deepEqual([ok.status, ok.text.split("\n").length, w.reads()], [200, 2, 1]);
  } finally { edge.uninstall(); }
});

test("the pools are read at the records' slot or later: a node behind it refuses, and that is 503 with no list (never a coin left out because its pool was read on an older node)", async () => {
  const w = world();
  await launch(w, { cityId: UTICA });
  w.S.slot = 500;
  // the records come from a node 7 slots ahead of the one that then answers getMultipleAccounts
  const realFetch = w.chain.fetchImpl;
  const ahead = async (url, init) => {
    const res = await realFetch(url, init);
    if (JSON.parse(init.body).method !== "getProgramAccounts") return res;
    const body = await res.json();
    body.result.context.slot += 7;
    return new Response(JSON.stringify(body));
  };
  const b = browser(w.env, { ip: "203.0.113.9" });
  const r = await b.send("/official-coins.csv", { fetchImpl: ahead });
  assert.deepEqual([r.status, r.headers.get("content-type")], [503, "text/plain; charset=utf-8"]);
  assert.deepEqual(w.chain.calls("getMultipleAccounts").map((c) => c.params[1].minContextSlot), [507]);
  const r2 = await b.send("/api/official-coins", { fetchImpl: ahead });
  assert.deepEqual([r2.status, (await r2.json()).error], [503, "rpc_unavailable"]);
  // a node that has caught up: listed
  const ok = await w.get("/official-coins.csv");
  assert.deepEqual([ok.status, ok.text.split("\n").length], [200, 2]);
});

/* ---------------------------------------------------------------- broken answers: 503, never a list */

/** The fake chain, with the answer to `method` changed by `edit(result, params)` (in place, or by returning a new one): a broken node. */
const tamper = (w, method, edit) => async (url, init) => {
  const res = await w.chain.fetchImpl(url, init);
  const asked = JSON.parse(init.body);
  if (asked.method !== method) return res;
  const body = await res.json();
  if (body.result !== undefined) { const out = edit(body.result, asked.params); if (out !== undefined) body.result = out; }
  return new Response(JSON.stringify(body));
};
const rowsOf = (result) => (Array.isArray(result) ? result : result.value);
let brokenIp = 0;
/**
 * A real coin (Utica) on the fake chain, `setup` then makes the node's answers broken (it returns that node's fetch) or the fake chain
 * itself (it returns { heal }, which puts it back), or both ({ fetchImpl, heal }); both paths must answer 503 with no list (the CSV
 * in plain text), nothing at the edge, nothing kept in memory (the next request, on the healthy node, reads the chain again and lists
 * Utica), and a log line that says why. Each case starts on a fresh server.
 */
async function brokenIs503(label, setup, logged) {
  _resetOfficialCoins(); _resetLpKit(); _resetRpcHealth();
  errors.length = 0;
  const edge = fakeCaches(); edge.install();
  try {
    const w = world();
    w.S.slot = 4_000;
    const good = await launch(w, { cityId: UTICA });
    const got = await setup(w, good);
    const fetchImpl = typeof got === "function" ? got : got && got.fetchImpl ? got.fetchImpl : w.chain.fetchImpl;
    const b = browser(w.env, { ip: `198.51.100.${++brokenIp}` });
    const csv = await b.send("/official-coins.csv", { fetchImpl });
    const text = await csv.text();
    assert.deepEqual([csv.status, csv.headers.get("content-type"), csv.headers.get("cache-control")], [503, "text/plain; charset=utf-8", "no-store"], `${label}: ${text}`);
    assert.match(text, /^rpc_unavailable: /, label);
    assert.doesNotMatch(text, /[1-9A-HJ-NP-Za-km-z]{32,44}/, `${label}: no address, so never a list`);
    const js = await b.send("/api/official-coins", { fetchImpl });
    assert.deepEqual([js.status, await js.json(), js.headers.get("cache-control")], [503, { ok: false, error: "rpc_unavailable" }, "no-store"], label);
    assert.equal(edge.store.size, 0, `${label}: nothing at the edge`);
    assert.ok(errors.includes(`official coins: not read ${logged}`), `${label}: ${errors.join(" | ")}`);
    assert.ok(!errors.some((e) => e.startsWith("official coins: left out")), `${label}: no coin was left out instead`);
    // nothing kept: the healthy node is asked again at once, and the coin is listed
    if (got && got.heal) await got.heal();
    const readsBefore = w.reads();
    const ok = await w.get("/official-coins.csv");
    assert.deepEqual([ok.status, ok.text, w.reads()], [200, `${good.mint}\n`, readsBefore + 1], `${label}: read again, listed`);
  } finally { edge.uninstall(); }
}

test("getProgramAccounts rows that cannot be our canonical Coin records (undecodable, at another address, of another owner, malformed, twice) fail the whole reading: 503, never a list without them", async () => {
  // every row already passed dataSize 243 and the Coin discriminator, which only our program writes, and only at ["coin", city id]
  const gpa = (edit) => (w) => tamper(w, "getProgramAccounts", (r) => { edit(rowsOf(r), w); });
  const zeros = Buffer.alloc(LAYOUT.Coin.size).toString("base64");
  await brokenIs503("an undecodable row (the node ignored the discriminator filter)", gpa((rows) => { rows.push({ pubkey: addr(820), account: { ...rows[0].account, data: [zeros, "base64"] } }); }), "rpc_bad_answer");
  await brokenIs503("a row whose bytes are cut short", gpa((rows) => { rows[0].account.data = [Buffer.from(rows[0].account.data[0], "base64").subarray(0, 100).toString("base64"), "base64"]; }), "rpc_bad_answer");
  await brokenIs503("a row whose data is not base64", gpa((rows) => { rows[0].account.data = ["!!not base64!!", "base64"]; }), "rpc_bad_answer");
  await brokenIs503("a row without an account", gpa((rows) => { delete rows[0].account; }), "rpc_bad_answer");
  await brokenIs503("a row without its address", gpa((rows) => { delete rows[0].pubkey; }), "rpc_bad_answer");
  await brokenIs503("a row another program owns", gpa((rows) => { rows[0].account.owner = addr(821); }), "rpc_bad_answer");
  await brokenIs503("a row with no owner", gpa((rows) => { delete rows[0].account.owner; }), "rpc_bad_answer");
  await brokenIs503("a row that is not an object", gpa((rows) => { rows.push("x"); }), "rpc_bad_answer");
  await brokenIs503("the same record twice", gpa((rows) => { rows.push(JSON.parse(JSON.stringify(rows[0]))); }), "rpc_bad_answer");
  // a real Coin record's bytes at an address that is not ["coin", its city id]: only a broken node can show one
  await brokenIs503("a Coin record at a non-canonical address", async (w) => { await launch(w, { cityId: SYRACUSE, at: addr(822) }); return { heal: () => { delete w.S.accounts[addr(822)]; } }; }, "rpc_bad_answer");
  await brokenIs503("Utica's record bytes under another address", gpa((rows) => { rows[0].pubkey = addr(823); }), "rpc_bad_answer");
});

test("a pool answer that cannot be the chain's (an entry that is not null or a whole account, a pool the node calls absent, a pool that does not decode, too few entries, older than the records) fails the whole reading: 503, never a coin left out", async () => {
  /** getMultipleAccounts with the entry for Utica's pool (or the whole answer) changed. */
  const pool = (edit) => (w, good) => tamper(w, "getMultipleAccounts", (r, params) => { const i = params[0].indexOf(good.pool); assert.ok(i >= 0); const out = edit(r.value[i], r); if (out !== undefined) r.value[i] = out; });
  for (const [label, entry] of [["false", false], ["0", 0], ["an empty string", ""], ["a string", "x"], ["an array", []], ["an empty object", {}]]) {
    await brokenIs503(`a pool entry that is ${label}`, pool(() => entry), "rpc_bad_answer");
  }
  await brokenIs503("a pool entry without an owner", pool((a) => { delete a.owner; }), "rpc_bad_answer");
  await brokenIs503("a pool entry whose owner is not an address", pool((a) => { a.owner = "dbc"; }), "rpc_bad_answer");
  await brokenIs503("a pool entry without lamports", pool((a) => { delete a.lamports; }), "rpc_bad_answer");
  await brokenIs503("a pool entry whose data is not base64", pool((a) => { a.data = ["!!not base64!!", "base64"]; }), "rpc_bad_answer");
  await brokenIs503("a pool entry in another encoding", pool((a) => { a.data = [a.data[0], "base58"]; }), "rpc_bad_answer");
  await brokenIs503("a pool entry whose data is a bare string", pool((a) => { a.data = a.data[0]; }), "rpc_bad_answer");
  // DBC's pool discriminator but not its size: a broken answer or a new DBC layout; either way the list stops, it never empties
  await brokenIs503("a VirtualPool cut short", pool((a) => { a.data = [Buffer.from(a.data[0], "base64").subarray(0, 200).toString("base64"), "base64"]; }), "pool_undecodable");
  // the node says the pool is not there: our launch creates the pool and the record in one instruction and DBC cannot close a pool
  await brokenIs503("a pool the node calls absent (the answer)", pool(() => null), "pool_absent");
  await brokenIs503("a pool the node calls absent (the chain)", async (w, good) => {
    const kept = w.S.accounts[good.pool];
    delete w.S.accounts[good.pool];
    return { heal: () => { w.S.accounts[good.pool] = kept; } };
  }, "pool_absent");
  // too few entries, a missing value, an answer older than the records' slot (a node that ignored minContextSlot), no slot at all
  await brokenIs503("a short value array", pool((a, r) => { r.value.pop(); }), "rpc_bad_answer");
  await brokenIs503("no value array", pool((a, r) => { delete r.value; }), "rpc_bad_answer");
  await brokenIs503("an answer older than the records", pool((a, r) => { r.context.slot = 3_999; }), "rpc_bad_answer");
  await brokenIs503("an answer without its slot", pool((a, r) => { delete r.context; }), "rpc_bad_answer");
  // the coin's Metaplex entry malformed (the ticker decides nothing, but a malformed answer is still not a reading)
  await brokenIs503("a malformed metadata entry", async (w, good) => {
    const md = await metadataAddress(good.mint);
    return tamper(w, "getMultipleAccounts", (r, params) => { r.value[params[0].indexOf(md)] = "x"; });
  }, "rpc_bad_answer");
  // two records whose pools both hold one mint: impossible on chain (DBC creates each pool's mint), so not a reading
  await brokenIs503("two records with one mint", async (w, good) => {
    const twin = await launch(w, { cityId: SYRACUSE, mint: good.mint, pool: addr(824) });
    return { heal: () => { delete w.S.accounts[twin.record]; } };
  }, "duplicate_mint");
});

test("a record's pool that the chain cannot show (launch.rs:193-201 checks creator, config and mint in the launch itself, and none of them can change) fails the whole reading: 503, never a coin left out", async () => {
  /** A second coin of ours (Syracuse) whose pool is not what its launch would have left; heal: the record is gone. */
  const second = (opts, logged) => [async (w) => { const x = await launch(w, { cityId: SYRACUSE, ...opts }); return { heal: () => { delete w.S.accounts[x.record]; } }; }, logged];
  const cases = {
    "a pool whose creator is somebody else's key (a look-alike the record names)": second({ creator: addr(803) }, "creator_not_coin_record"),
    "a pool whose creator is another of our records": [async (w, good) => { const x = await launch(w, { cityId: 1006, creator: good.record }); return { heal: () => { delete w.S.accounts[x.record]; } }; }, "creator_not_coin_record"],
    "a pool on our config while the record names another": second({ recordConfig: addr(807) }, "config_mismatch"),
    "a pool on another config than the record's (one the settings do not list either)": second({ config: addr(804), recordConfig: CONFIG }, "config_mismatch"),
    "a pool that holds another mint than the record's": second({ baseMint: addr(805) }, "mint_mismatch"),
    "a pool another program owns": second({ poolOwner: addr(806) }, "pool_not_meteora"),
    "a pool the System program owns": second({ poolOwner: "11111111111111111111111111111111" }, "pool_not_meteora"),
    "an account of DBC's that is not a pool (a price-curve setting's bytes)": [async (w) => { const x = await launch(w, { cityId: 1004 }); w.S.accounts[x.pool] = { owner: PROGRAM_IDS.dbc, data: LIVE_CONFIG.data }; return { heal: () => { delete w.S.accounts[x.record]; } }; }, "pool_undecodable"],
  };
  for (const [label, [setup, logged]] of Object.entries(cases)) await brokenIs503(label, setup, logged);
  /** getMultipleAccounts with the entry for Utica's pool changed: still owned by DBC and a whole account, so strict readAccounts passes it. */
  const pool = (edit) => (w, good) => tamper(w, "getMultipleAccounts", (r, params) => { const a = r.value[params[0].indexOf(good.pool)]; assert.equal(a.owner, PROGRAM_IDS.dbc); edit(a); });
  const bytes = (a) => Buffer.from(a.data[0], "base64");
  await brokenIs503("a pool entry with no data (an empty base64 string)", pool((a) => { a.data = ["", "base64"]; }), "pool_undecodable");
  await brokenIs503("a pool entry of 4 bytes", pool((a) => { a.data = [bytes(a).subarray(0, 4).toString("base64"), "base64"]; }), "pool_undecodable");
  await brokenIs503("a pool entry whose first byte is flipped", pool((a) => { const b = bytes(a); b[0] ^= 1; a.data = [b.toString("base64"), "base64"]; }), "pool_undecodable");
  await brokenIs503("a pool entry the System program owns", pool((a) => { a.owner = "11111111111111111111111111111111"; }), "pool_not_meteora");
  // two coins' pool entries swapped in one getMultipleAccounts answer: each record then sees the other's pool (was a 200 EMPTY list)
  await brokenIs503("two pool entries swapped", async (w, good) => {
    const syr = await launch(w, { cityId: SYRACUSE });
    const fetchImpl = tamper(w, "getMultipleAccounts", (r, params) => {
      const i = params[0].indexOf(good.pool), k = params[0].indexOf(syr.pool);
      assert.ok(i >= 0 && k >= 0);
      [r.value[i], r.value[k]] = [r.value[k], r.value[i]];
    });
    return { fetchImpl, heal: () => { delete w.S.accounts[syr.record]; } };
  }, "creator_not_coin_record");
});

/** A second node at SOLANA_RPC_URL_BACKUP: `answer(method, params)` gives its result, or { http } / { error } for a refusal. */
const BACKUP = "https://backup-rpc.test/node";
function twoNodes(w, { first = {}, backup }) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url: String(url), method: body.method });
    if (String(url) === BACKUP) {
      const out = backup(body.method, body.params);
      if (out && out.http) return new Response("refused", { status: out.http });
      if (out && out.error) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: out.error }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: out }));
    }
    const refuse = first[body.method];
    if (refuse && refuse.http) return new Response("refused", { status: refuse.http });
    if (refuse && refuse.down) throw new TypeError("network down");
    return w.chain.fetchImpl(url, init);
  };
  return { fetchImpl, asked, at: (u) => asked.filter((a) => a.url === u).map((a) => a.method) };
}
/** A devnet node: its genesis hash is devnet's (or its probe is refused), and it answers "no Coin record" without an error. */
const devnetNode = (genesis) => (method) => {
  if (method === "getGenesisHash") return genesis;
  if (method === "getProgramAccounts") return { context: { slot: 999_999 }, value: [] };
  if (method === "getMultipleAccounts") return { context: { slot: 999_999 }, value: [] };
  return { error: { code: -32601, message: "unexpected" } };
};

test("every read goes to the node whose genesis hash was just checked, and to it alone: a first node that passes the check and then refuses is 503, never the backup's answer (a devnet node whose own genesis probe got no answer), even after the check was remembered", async () => {
  const cases = [
    ["429 on getProgramAccounts, the backup's genesis probe answered 503", { http: 429 }, devnetNode({ http: 503 })],
    ["502 on getProgramAccounts, the backup's genesis probe refused with -32005", { http: 502 }, devnetNode({ error: { code: -32005, message: "Node is unhealthy" } })],
    ["the network gone on getProgramAccounts, the backup's genesis probe answered 429", { down: true }, devnetNode({ http: 429 })],
  ];
  for (const [label, refusal, backup] of cases) {
    for (const remembered of [false, true]) {
      _resetOfficialCoins(); _resetLpKit(); _resetRpcHealth();
      errors.length = 0;
      const edge = fakeCaches(); edge.install();
      try {
        const w = world({ SOLANA_RPC_URL_BACKUP: BACKUP });
        const good = await launch(w, { cityId: UTICA });
        // the launchpad's own kit checked the first node earlier (buildTx): that memory never lets the list fail over
        if (remembered) assert.deepEqual(await checkGenesis(w.env, w.chain.fetchImpl), { ok: true, cluster: "mainnet" });
        const net = twoNodes(w, { first: { getProgramAccounts: refusal }, backup });
        const b = browser(w.env, { ip: "198.51.100.200" });
        const csv = await b.send("/official-coins.csv", { fetchImpl: net.fetchImpl });
        const text = await csv.text();
        const tag = `${label}${remembered ? " (remembered)" : ""}`;
        assert.deepEqual([csv.status, csv.headers.get("content-type"), csv.headers.get("cache-control")], [503, "text/plain; charset=utf-8", "no-store"], `${tag}: ${text}`);
        const js = await b.send("/api/official-coins", { fetchImpl: net.fetchImpl });
        assert.deepEqual([js.status, await js.json()], [503, { ok: false, error: "rpc_unavailable" }], tag);
        assert.equal(edge.store.size, 0, `${tag}: nothing at the edge`);
        assert.deepEqual(net.at(BACKUP), [], `${tag}: the backup was never asked anything`);
        assert.deepEqual(net.at(RPC), ["getGenesisHash", "getProgramAccounts", "getGenesisHash", "getProgramAccounts"], `${tag}: the genesis hash on every reading, then only that node`);
        // the first node serves getProgramAccounts again: listed (nothing failed was kept)
        const ok = await b.send("/official-coins.csv", { fetchImpl: twoNodes(w, { backup }).fetchImpl });
        assert.deepEqual([ok.status, await ok.text()], [200, `${good.mint}\n`], tag);
      } finally { edge.uninstall(); }
    }
  }
});

test("a backup whose genesis hash was checked serves the whole reading when the first node is down; a backup of another network is 503", async () => {
  // the backup is the same (mainnet) chain behind another address
  const w = world({ SOLANA_RPC_URL_BACKUP: BACKUP });
  const good = await launch(w, { cityId: UTICA });
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url: String(url), method: body.method });
    if (String(url) === RPC) throw new TypeError("network down");
    return w.chain.fetchImpl(url, init);
  };
  const r = await browser(w.env, { ip: "198.51.100.201" }).send("/official-coins.csv", { fetchImpl });
  assert.deepEqual([r.status, await r.text()], [200, `${good.mint}\n`]);
  // the first node failed the check; the backup answered it (its own probe first), and then every read went to the backup alone
  const reads = asked.filter((a) => !["getGenesisHash"].includes(a.method));
  assert.ok(reads.length >= 2 && reads.every((a) => a.url === BACKUP), JSON.stringify(asked));
  assert.ok(asked.some((a) => a.url === BACKUP && a.method === "getGenesisHash"));
  // a backup of another network, the first node down: 503 (wrong_cluster), nothing read
  _resetOfficialCoins(); _resetLpKit(); _resetRpcHealth();
  const dev = twoNodes(w, { first: { getGenesisHash: { down: true }, getProgramAccounts: { down: true } }, backup: devnetNode(GENESIS.devnet) });
  const d = await browser(w.env, { ip: "198.51.100.202" }).send("/api/official-coins", { fetchImpl: dev.fetchImpl });
  assert.deepEqual([d.status, await d.json()], [503, { ok: false, error: "rpc_unavailable" }]);
  assert.ok(!dev.asked.some((a) => a.method === "getProgramAccounts"), "nothing read");
});

test("a node that lags behind never drops a coin already listed: the records are read at the slot of this server's last whole reading or later (else 503), and a coin this site recorded must be among them (else 503)", async () => {
  const w = world();
  w.S.slot = 5_000;
  const u = await launch(w, { cityId: UTICA });
  const s = await launch(w, { cityId: SYRACUSE });
  const first = await w.get("/official-coins.csv");
  assert.deepEqual([first.status, first.text], [200, `${s.mint}\n${u.mint}\n`]);
  // 61 s later the node that answers is 300 slots behind, before Syracuse's launch
  advance(61_000);
  const kept = w.S.accounts[s.record];
  delete w.S.accounts[s.record];
  w.S.slot = 4_700;
  const b = browser(w.env, { ip: "198.51.100.210" });
  const behind = await b.send("/official-coins.csv", { fetchImpl: w.chain.fetchImpl });
  assert.deepEqual([behind.status, behind.headers.get("content-type")], [503, "text/plain; charset=utf-8"], await behind.text());
  assert.deepEqual(w.chain.calls("getProgramAccounts").map((c) => c.params[1].minContextSlot), [undefined, 5_000], "the second reading asks for the first one's slot or later");
  assert.ok(errors.includes("official coins: not read rpc__32016"), errors.join(" | "));
  // a node that ignores minContextSlot and answers an older slot: not a reading either
  const ignores = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "getProgramAccounts") delete body.params[1].minContextSlot;
    return w.chain.fetchImpl(url, { ...init, body: JSON.stringify(body) });
  };
  const old = await b.send("/api/official-coins", { fetchImpl: ignores });
  assert.deepEqual([old.status, await old.json()], [503, { ok: false, error: "rpc_unavailable" }]);
  assert.ok(errors.includes("official coins: not read rpc_bad_answer"), errors.join(" | "));
  // a fresh server knows no slot: the coin this site recorded from the chain must be among the records
  w.S.accounts[s.record] = kept; w.S.slot = 5_000;
  assert.equal((await recordLaunchedCoin(w.env, { cityId: SYRACUSE }, w.chain.fetchImpl)).ok, true);
  delete w.S.accounts[s.record]; w.S.slot = 4_700;
  _resetOfficialCoins(); _resetLpKit(); _resetRpcHealth();
  errors.length = 0;
  const fresh = await b.send("/official-coins.csv", { fetchImpl: w.chain.fetchImpl });
  assert.equal(fresh.status, 503);
  assert.deepEqual(errors, [`official coins: a recorded coin is not in the reading city ${SYRACUSE} coin record ${s.record}`, "official coins: not read recorded_coin_missing"]);
  // the node caught up: both listed again
  w.S.accounts[s.record] = kept; w.S.slot = 5_100;
  const ok = await b.send("/official-coins.csv", { fetchImpl: w.chain.fetchImpl });
  assert.deepEqual([ok.status, await ok.text()], [200, `${s.mint}\n${u.mint}\n`]);
});

test("the recorded coins cannot be checked (a database that does not answer): 503, never a list that skipped the check", async () => {
  await brokenIs503("the database refuses lp_coins", async (w) => {
    const real = w.env.DB.prepare;
    w.env.DB.prepare = (sql) => (/FROM lp_coins/.test(sql) ? { bind: () => ({ all: async () => { throw new Error("D1_ERROR: unavailable"); } }) } : real(sql));
    return { heal: () => { w.env.DB.prepare = real; } };
  }, "recorded_unreadable");
  // a recorded coin with another mint than the chain's record for its city: not a reading either
  await brokenIs503("a recorded coin whose mint is not the record's", async (w, good) => {
    assert.equal((await recordLaunchedCoin(w.env, { cityId: UTICA }, w.chain.fetchImpl)).ok, true);
    await w.env.DB.prepare("UPDATE lp_coins SET mint = ? WHERE mint = ?").bind(addr(890), good.mint).run();
    return { heal: () => w.env.DB.prepare("UPDATE lp_coins SET mint = ? WHERE mint = ?").bind(good.mint, addr(890)).run() };
  }, "recorded_coin_missing");
});

test("readAccounts keeps its old reading for every other caller; strict is only the official list's", async () => {
  const { readAccounts, wholeAccount } = await import("../src/lpkit.js");
  const w = world();
  const a = addr(830), b = addr(831);
  w.S.accounts[a] = { owner: PROGRAM_IDS.dbc, data: Buffer.from("hi").toString("base64") };
  const odd = tamper(w, "getMultipleAccounts", (r) => { r.value[1] = 0; });
  const loose = await readAccounts(w.env, [a, b], odd);
  assert.deepEqual([loose.get(a).owner, loose.get(b)], [PROGRAM_IDS.dbc, null], "a falsy entry still reads as no account");
  await assert.rejects(readAccounts(w.env, [a, b], odd, { strict: true }), /rpc_bad_answer/);
  const strict = await readAccounts(w.env, [a, b], w.chain.fetchImpl, { strict: true });
  assert.deepEqual([strict.get(a).owner, strict.get(b)], [PROGRAM_IDS.dbc, null], "null is a well-formed answer: no account");
  assert.equal(wholeAccount({ owner: PROGRAM_IDS.dbc, lamports: 1, data: ["aGk=", "base64"] }), true);
  for (const x of [null, undefined, 0, "", "x", [], {}, { owner: "x", lamports: 1, data: ["aGk=", "base64"] }, { owner: PROGRAM_IDS.dbc, data: ["aGk=", "base64"] }, { owner: PROGRAM_IDS.dbc, lamports: 1, data: ["%%", "base64"] }, { owner: PROGRAM_IDS.dbc, lamports: 1, data: "aGk=" }]) {
    assert.equal(wholeAccount(x), false, JSON.stringify(x));
  }
});

test("headers: text/csv; charset=utf-8, public max-age=300 for browsers, the site's security headers, open to other sites' reads; HEAD is answered like GET; POST is 405", async () => {
  const w = world();
  for (const path of ["/official-coins.csv", "/api/official-coins"]) {
    const r = await w.get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-type"), path.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    assert.equal(r.headers.get("cache-control"), "public, max-age=300");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("x-vicinity-max-age"), null, "the internal header never leaves");
    assert.equal((await w.get(path, "POST")).status, 405);
    // link checkers and pollers ask a file's address with HEAD first (the Workers runtime drops the body of a HEAD answer)
    const head = await w.get(path, "HEAD");
    assert.deepEqual([head.status, head.headers.get("content-type")], [200, path.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8"]);
  }
});

test("caching: one reading per server for 1 minute (the CSV and the JSON share it); the edge keeps each answer 10 minutes and tells browsers 5", async () => {
  const w = world();
  await launch(w, { cityId: UTICA });
  await w.get("/official-coins.csv"); await w.get("/api/official-coins"); await w.get("/official-coins.csv");
  assert.equal(w.reads(), 1, "the CSV and the JSON share one reading");
  advance(60_000 + 1);
  await w.get("/api/official-coins");
  assert.equal(w.reads(), 2, "read again after 1 minute");
  // the edge (src/index.js cached): another server asks nothing for 10 minutes; the browser is told 5
  _resetOfficialCoins();
  const edge = fakeCaches(); edge.install();
  try {
    const e = world();
    await launch(e, { cityId: UTICA });
    const first = await e.get("/official-coins.csv");
    assert.deepEqual([first.status, first.headers.get("cache-control"), e.reads()], [200, "public, max-age=300", 1]);
    const kept = [...edge.store.values()];
    assert.deepEqual(kept.map((k) => k.maxAge), [600], "the edge copy lives 10 minutes");
    advance(6 * 60_000);
    _resetOfficialCoins(); // another server: nothing in its memory
    const again = await e.get("/official-coins.csv");
    assert.deepEqual([again.status, again.text, again.headers.get("cache-control"), e.reads()], [200, first.text, "public, max-age=300", 1]);
    advance(4 * 60_000 + 1);
    _resetOfficialCoins();
    await e.get("/official-coins.csv");
    assert.equal(e.reads(), 2, "after 10 minutes the edge asks the chain again");
  } finally { edge.uninstall(); }
});

test("the public limit: 60 edge misses a minute per connection over both paths, the 61st is 429 slow_down", async () => {
  const w = world({ LIMIT_SALT: "s" });
  for (let i = 0; i < 60; i++) assert.equal((await w.get(i % 2 ? "/api/official-coins" : "/official-coins.csv")).status, 200, `miss ${i + 1}`);
  const slow = await w.json("/api/official-coins");
  assert.deepEqual([slow.status, slow.data.error], [429, "slow_down"]);
  assert.equal((await w.get("/official-coins.csv")).status, 429);
  assert.equal(w.reads(), 1, "the chain was read once all along");
});

test("through the Worker's own fetch with the settings on: /official-coins.csv is answered in code", async () => {
  const w = world();
  const c = await launch(w, { cityId: UTICA });
  const realFetch = globalThis.fetch;
  globalThis.fetch = w.chain.fetchImpl;
  try {
    const asked = [];
    const r = await worker.fetch(new Request("https://vicinity.city/official-coins.csv"), { ...w.env, ASSETS: { fetch: async (q) => { asked.push(q.url); return new Response("", { status: 404 }); } } }, {});
    assert.deepEqual([r.status, r.headers.get("content-type"), await r.text(), asked], [200, "text/csv; charset=utf-8", `${c.mint}\n`, []]);
  } finally { globalThis.fetch = realFetch; }
});

/* ---------------------------------------------------------------- the page */

const html = new Map(buildPages()).get("official.html");
const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));

test("the page is built from src/official.js with the deployed settings: our programs and who upgrades them, the fee wallet, the price-curve setting, $VICINITY, the team lock and wallets with the token page's labels", () => {
  assert.equal(read("public/official.html"), html, "public/official.html is built from scripts/pages/src/official.html (npm run pages)");
  assert.match(read("scripts/pages/src/official.html"), /<!--@official-addresses-->/, "no address is typed into the page source");
  const sections = [...main.matchAll(/<section class="credits__group" aria-labelledby="(off-[a-z]+)">\s*<h2 class="credits__h" id="\1">([^<]+)<\/h2>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(sections, [["off-programs", "Programs"], ["off-fees", "Fees and price curve"], ["off-vicinity", "$VICINITY"], ["off-team", "Team"], ["off-coins", "Official city coins"], ["off-check", "How to check a city coin yourself"]]);
  const rows = [...main.matchAll(/<div class="credits__row off-row" data-address="([^"]+)">\s*<dt>([^<]+)<\/dt>([\s\S]*?)<\/div>/g)].map((m) => ({ address: m[1], label: m[2].replace(/&amp;/g, "&"), body: m[3] }));
  // never style.css's .addr (the round address pill, overflow hidden): on a row it clipped the label and the address
  assert.doesNotMatch(main, /class="(?:[^"]*\s)?addr(?:\s[^"]*)?"/, "the bare .addr class is style.css's address pill");
  assert.doesNotMatch(read("public/official.js"), /["']addr(?:__[a-z]+)?["']/, "nor in the coin table the page's script builds");
  const lock = OFFICIAL.teamLocks[0];
  assert.deepEqual(rows.map((r) => [r.label, r.address]), [
    ["Launchpad program", PROGRAM], ["Rewards program", REWARDS], ["Upgrade authority of both programs", VAULT],
    ["Fee wallet", FEE_WALLET], ["Price-curve setting (Meteora)", CONFIG],
    ["$VICINITY token", VICINITY],
    ["Team lock (Jupiter Lock)", lock.address], ["Team wallet (public)", FEE_WALLET], ["Team wallet (FOMO)", OFFICIAL.teamWallets[1]],
  ]);
  assert.deepEqual(rows.map((r) => r.address), officialAddresses(deployedVars()).flatMap((g) => g.rows.map((x) => x.address)), "exactly the list of src/official.js");
  // the same labels as the token page's holder list (src/chain.js labels with these two)
  assert.deepEqual([teamLockLabel(lock), ...OFFICIAL.teamWallets.map(teamWalletLabel)], ["Team lock (Jupiter Lock)", "Team wallet (public)", "Team wallet (FOMO)"]);
  for (const r of rows) {
    assert.ok(r.body.includes(`<code class="off-row__value">${r.address}</code>`), r.label);
    assert.ok(r.body.includes(`<button class="btn btn--ghost btn--sm" type="button" data-copy="${r.address}" aria-label="Copy the address (${r.label.replace(/&/g, "&amp;")})" hidden>Copy</button>`), `${r.label}: a Copy button (shown by the page's script)`);
    const kind = r.address === VICINITY ? "token" : "account";
    assert.ok(r.body.includes(`<a class="btn btn--ghost btn--sm" href="https://solscan.io/${kind}/${r.address}" target="_blank" rel="noopener">Solscan<span class="sr-only">: ${r.label.replace(/&/g, "&amp;")} (opens in a new tab)</span></a>`), `${r.label}: its Solscan page`);
  }
  assert.ok(main.includes(`href="${lock.url}" target="_blank" rel="noopener">Jupiter Lock page`), "the lock's own page too");
  // the upgrade authority's 2-of-3 rule lives on its multisig, which the row links (the vault's own page does not show it)
  const upgrade = rows.find((r) => r.address === VAULT).body;
  assert.ok(upgrade.includes(`<a class="btn btn--ghost btn--sm" href="https://solscan.io/account/${MULTISIG}" target="_blank" rel="noopener">Squads multisig<span class="sr-only">: Upgrade authority of both programs (opens in a new tab)</span></a>`));
  assert.ok(upgrade.includes("A Squads multisig vault. Its multisig, linked here, needs 2 of its 3 signers to upgrade a program."));
  // one wallet, two labels: each row says it is the other one
  const [feeRow, teamRow] = rows.filter((r) => r.address === FEE_WALLET).map((r) => r.body);
  assert.ok(feeRow.includes("It is also the team's public wallet, listed under Team."), feeRow);
  assert.ok(teamRow.includes("It is also the fee wallet, listed above."), teamRow);
  assert.match(main, /The platform token, launched on Raydium LaunchLab on October 3, 2026\. It is not a city coin\./);
  // the list and its files; the check, in plain words
  assert.match(main, /<a href="\/official-coins\.csv">official-coins\.csv<\/a>/);
  assert.match(main, /<a href="\/api\/official-coins">JSON<\/a>/);
  assert.match(main, /<p class="off-state" id="coins-state" role="status">Reading the list from the chain…<\/p>/);
  // the check, starting from the list and the coin record, every step doable today with an RPC call: the Coin discriminator, the
  // record's address, the byte offsets (those of src/sol/layout.js) with the record's own config. Our programs' IDL is not published
  // yet (so Solscan shows raw bytes), and the page promises nothing about what other sites will show. Never "go by the pool's creator"
  // (a look-alike can copy that)
  const C = LAYOUT.Coin.fields, V = LAYOUT.VirtualPool.fields;
  assert.deepEqual([C.city_id.at, C.mint.at, C.dbc_config.at, C.dbc_pool.at, V.creator.at, V.config.at, V.base_mint.at], [8, 48, 112, 144, 104, 72, 136], "the offsets the page gives");
  const disc = Buffer.from(LAYOUT.Coin.discriminator).toString("hex");
  assert.equal(disc, "d7c335eed9c4d533");
  assert.ok(main.includes(`A city coin is official only if its mint address is on the list above (or in <a href="/official-coins.csv">official-coins.csv</a>). For each coin, the table and the JSON show its coin record, its mint and its pool as this site read them from the chain. To check them yourself, ask any Solana RPC node for the coin record (getAccountInfo; coinAccount in the JSON): its owner is the launchpad program listed above; its data starts with the 8 bytes ${disc}, which mark a coin record, followed by the city id (8 bytes, little-endian); its address is the one derived from the launchpad program and the seeds "coin" and that city id, so each city has one; and in its data the mint starts at byte ${C.mint.at}, the price-curve setting at byte ${C.dbc_config.at} and the pool at byte ${C.dbc_pool.at} (32 bytes each). Then ask for the pool: its owner is Meteora's bonding-curve program, and in its data the creator (byte ${V.creator.at}) is the coin record, the price-curve setting (byte ${V.config.at}) is the record's and one listed above, and the mint (byte ${V.base_mint.at}) is the coin's. Our programs' description (IDL) is not published yet, so Solscan shows the record's data as raw bytes; the byte offsets above are how to read it. Do not go by a pool's creator alone: anyone can open a pool on our public price-curve setting and then hand its creator role to one of our records, and anyone can make an empty account of their own show our program as its owner. The list above starts from our coin records and makes all of these checks.`));
  assert.doesNotMatch(main, /explorers show these fields by name|after that, explorers/, "nothing promised about other sites");
  assert.doesNotMatch(main, /look at who created it|only our program can make|it names the coin's mint and its Meteora pool/);
  // no age the page cannot keep: the time of the reading is shown instead
  assert.match(main, /This list is read from the chain by this site; the time of the reading is shown below\. Nobody types it in\./);
  assert.doesNotMatch(main, /minutes old/);
  // never "verified" or "audited", no warning banner
  assert.doesNotMatch(main, /verif|audit/i);
  assert.doesNotMatch(main, /role="alert"|banner|warning|class="[^"]*warn/i);
  assert.match(html, /<link rel="stylesheet" href="\/pages-credits\.css">\n  <link rel="stylesheet" href="\/pages-official\.css">/);
  assert.match(html, /<script src="\/official\.js" defer><\/script>/);
});

test("the address list: the programs, the fee wallet and the price-curve setting only while the settings name mainnet", () => {
  const ids = (env) => officialAddresses(env).map((g) => g.id);
  assert.deepEqual(ids(deployedVars()), ["programs", "fees", "vicinity", "team"]);
  assert.deepEqual(ids({}), ["team"], "dark and no mint: the team only");
  assert.deepEqual(ids({ ...LP_ON, VICINITY_MINT: VICINITY }), ["vicinity", "team"], "devnet: none of the launchpad's addresses");
});

test("every page's footer links /official next to the Rules", () => {
  const pages = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
  assert.ok(pages.includes("official.html") && pages.length >= 15);
  for (const f of pages) assert.match(read("public/" + f), /<a href="\/terms">Terms<\/a><a href="\/rules">Rules<\/a><a href="\/official">Official addresses<\/a><a href="\/credits">Data<\/a>/, f);
});

/** The built page with site.js and the real public/official.js, /api/official-coins answering `answer` ({ status, body }). */
async function officialPage(answer) {
  const page = await openPage("official.html");
  const win = page.window, calls = [], copied = [];
  win.navigator.clipboard = { writeText: async (t) => { copied.push(t); } };
  win.fetch = async (path) => { calls.push(String(path)); const a = String(path) === "/api/official-coins" ? answer : { status: 200, body: { ok: true } }; return { ok: a.status === 200, status: a.status, json: async () => a.body }; };
  vm.runInContext(read("public/official.js"), win, { filename: "public/official.js" });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return { ...page, calls, copied };
}

test("the page's script: the Copy buttons show and copy; the coin table from /api/official-coins (rows with Copy, Solscan, the pool and the coin record), none yet, a failed read, not on this site, another network", async () => {
  const coin = { city: "Utica", cityId: String(UTICA), ticker: "UTICA", mint: addr(41), pool: addr(42), config: CONFIG, coinAccount: addr(43), stage: "curve" };
  const other = { city: null, cityId: "1001", ticker: null, mint: addr(44), pool: addr(45), config: CONFIG, coinAccount: addr(46), stage: "graduated" };
  const p = await officialPage({ status: 200, body: { ok: true, cluster: "mainnet", readAt: "2026-10-20T12:03:00.000Z", program: PROGRAM, configs: [CONFIG], coins: [coin, other], rule: ruleOf(PROGRAM) } });
  assert.ok(p.calls.includes("/api/official-coins"));
  const statics = p.$$(".credits__row.off-row [data-copy]");
  assert.equal(statics.length, 9);
  assert.ok(statics.every((b) => !b.hidden), "every Copy button shows once the script runs");
  statics[0].click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.copied, [PROGRAM]);
  assert.equal(p.$("#coins-wrap").hidden, false);
  assert.equal(p.$("#coins-state").textContent, "2 official city coins. Read from the chain at 12:03 UTC.");
  const rows = p.$$("#coins-body tr");
  assert.deepEqual(rows.map((tr) => tr.dataset.mint), [coin.mint, other.mint]);
  const cells = (tr) => tr.children.map((td) => td.textContent);
  assert.deepEqual(cells(rows[0]), ["Utica", "$UTICA", `${coin.mint}CopySolscan: Utica mint (opens in a new tab)`, "On its price curve Pool: Utica pool on Solscan (opens in a new tab)Record: Utica coin record on Solscan (opens in a new tab)"]);
  assert.deepEqual(cells(rows[1]).map((t) => t.split(coin.mint).join("")), ["City 1001", "Not read", `${other.mint}CopySolscan: City 1001 mint (opens in a new tab)`, "Graduated to its pool Pool: City 1001 pool on Solscan (opens in a new tab)Record: City 1001 coin record on Solscan (opens in a new tab)"]);
  // the mint on Solscan, the pool, and the coin record (the paragraph's check starts there: its owner is our program)
  const links = rows[0].querySelectorAll("a");
  assert.deepEqual(links.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]), [[`https://solscan.io/token/${coin.mint}`, "_blank", "noopener"], [`https://solscan.io/account/${coin.pool}`, "_blank", "noopener"], [`https://solscan.io/account/${coin.coinAccount}`, "_blank", "noopener"]]);
  assert.ok([...rows[0].querySelectorAll("code"), ...rows[0].querySelectorAll("span")].every((e) => !/(^|\s)addr(__|\s|$)/.test(e.getAttribute("class") || "")), "never style.css's .addr pill");
  const copyMint = rows[0].querySelector("[data-copy]");
  assert.equal(copyMint.hidden, false);
  copyMint.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.copied, [PROGRAM, coin.mint]);

  const none = await officialPage({ status: 200, body: { ok: true, cluster: "mainnet", readAt: "2026-10-20T12:03:00.000Z", program: PROGRAM, configs: [CONFIG], coins: [], rule: ruleOf(PROGRAM) } });
  assert.deepEqual([none.$("#coins-state").textContent, none.$("#coins-wrap").hidden], ["No city coin is on the list yet. Read from the chain at 12:03 UTC.", true]);
  const down = await officialPage({ status: 503, body: { ok: false, error: "rpc_unavailable" } });
  assert.deepEqual([down.$("#coins-state").textContent, down.$("#coins-wrap").hidden, down.$$("#coins-body tr").length], ["The list could not be read from the chain just now. Please try again in a few minutes.", true, 0], "never an empty list in its place");
  const off = await officialPage({ status: 404, body: { ok: false, error: "not_enabled" } });
  assert.equal(off.$("#coins-state").textContent, "The city-coin list is not on this site right now.");
  const slow = await officialPage({ status: 429, body: { ok: false, error: "slow_down" } });
  assert.equal(slow.$("#coins-state").textContent, "Too many requests from your connection just now. Please try again in a minute.");
  // a list of another network (a devnet deploy) is not shown as the official city coins: its Solscan links would open mainnet pages
  const devnet = await officialPage({ status: 200, body: { ok: true, cluster: "devnet", readAt: "2026-10-20T12:03:00.000Z", program: PROGRAM, configs: [CONFIG], coins: [coin], rule: ruleOf(PROGRAM) } });
  assert.deepEqual([devnet.$("#coins-state").textContent, devnet.$("#coins-wrap").hidden, devnet.$$("#coins-body tr").length], ["The city-coin list is not on this site right now.", true, 0]);
});
