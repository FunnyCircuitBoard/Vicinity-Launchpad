// City identity, step 1: the ticker lock. A city coin's ticker is the city list's (public/data/tickers.json) until the coin is
// launched, and the chain's symbol from then on; nobody picks, changes or invents one.
//   (a) a ticker or symbol in the founder's design request is ignored: the saved design and every later answer show the list's
//       ticker and the request's value appears nowhere
//   (b) an approve/tx whose symbol or name differs from the server's values is refused (design_changed) and no transaction is built
//   (c) the launch instruction's data is exactly the 8-byte discriminator plus the little-endian u64 city id (no name, no symbol:
//       the program copies both from the Approval)
//   (d) a design for a city the list does not know is refused with a plain message, and nothing is saved
//   (e) the display pin: when the recorded on-chain symbol differs from the list's ticker, every reader (src/tickers.js
//       displayTicker: /api/me, the checker, the coin page, the Launchpad cards, the portfolio, the swap config, the admin's
//       candidates, the founder's launch status) shows the chain's and exactly one warning is logged; when the chain's symbol is
//       unknown the list's is shown and nothing is logged
//   and the pages: nothing derives a ticker from a name (dashboards, member pass, Buy panel, coin page, portfolio), the "$" goes only
//       on a ticker the server vouches for, the dashboard says where the ticker comes from, and the rules page's live Never list says so
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IN_UTICA, MINT, browser, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { CITY_COIN, LP, dexMock, seedCoin, seedSeat } from "./helpers/launchpad.js";
import { DEMOV, DEMOV_COIN, LP_ON, PROGRAM, REWARDS, SOL_CONFIG, addr, lpChain } from "./helpers/lpchain.js";
import { _resetTickers, chainSymbolOf, chainSymbolsOf, displayTicker, tickerOf } from "../src/tickers.js";
import { _resetLpCoins, ensureLpCoinsSchema } from "../src/lpcoins.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLaunchpad } from "../src/launchpad.js";
import { _resetMarket } from "../src/market.js";
import { _resetPortfolio, mintsFor } from "../src/portfolio.js";
import { officialCityCoin } from "../src/coins.js";
import { allowListed } from "../src/coin.js";
import * as IX from "../src/sol/lplaunch-ix.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { decodeHeader } from "../src/sol/message.js";
import { LAYOUT } from "../src/sol/layout.js";
import { ADDRESSES, launchpad as launchpadPdas } from "../src/sol/pda.js";
import { base58Decode } from "../src/solana.js";
import { POLICY } from "../src/policy.js";
import { memberMe, openDashboard } from "./helpers/dashpage.js";

const UTICA = "5142056", NYC = "5128581";
const WSOL = ADDRESSES.wsol;
const TABLE = "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe";
const b64 = (u8) => Buffer.from(u8).toString("base64");

beforeEach(() => { useClock("2026-10-20T12:00:00Z"); _resetLpKit(); _resetLpCoins(); _resetLaunchpad(); _resetMarket(); _resetPortfolio(); });
after(() => realClock());

/** console.warn captured while fn runs: the lines, and fn's value. */
async function warnings(fn) {
  const w = console.warn, lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try { return { value: await fn(), lines }; } finally { console.warn = w; }
}
/** The active founder of Utica, holding the founder amount (the seat made directly: a design needs only an active founder). */
async function uticaFounder(env) {
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(UTICA, u.id, u.wallet, at, at).run();
  return f;
}
/** A launched city coin as src/lpcoins.js records it from the chain: the lp_coins row with the symbol the chain's metadata gave it. */
async function recordOnChain(env, { cityId, mint, symbol, name = "Utica Coin" }) {
  await ensureLpCoinsSchema(env.DB);
  await env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
      VALUES ('devnet', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(PROGRAM, String(cityId), mint, addr(61), addr(62), name, symbol, WSOL, SOL_CONFIG, addr(63), new Date(Date.now()).toISOString()).run();
}
/** A program account from the generated layout (the fields given, zero elsewhere). */
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
/** An Approval account as the program writes it (name and symbol as Borsh strings). */
function approvalAccount({ cityId, founder, dbcConfig = SOL_CONFIG, rentPayer = addr(5), name = "Utica Coin", symbol = "UTICA", expiresAt }) {
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
/** The owner signed in to the admin's City coins routes, the launchpad started by them, the SOL price curve allowed. */
async function adminWorld() {
  const config = SOL_CONFIG;
  const env = { ...newWorld(), ...LP_ON, LAUNCHPAD_DBC_CONFIGS: config };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const L = launchpadPdas(PROGRAM);
  const chain = lpChain({ accounts: {
    [await L.launchpad()]: layoutAccount("Launchpad", { admin: owner.w.address, rewards_program: REWARDS }),
    [await L.launchConfig(config)]: layoutAccount("LaunchConfig", { dbc_config: config, quote_mint: WSOL, enabled: 1 }),
  } });
  const call = async (path, body) => {
    const url = body === undefined ? `${path}${path.includes("?") ? "&" : "?"}cluster=devnet` : path;
    const r = await owner.send(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : { cluster: "devnet", ...body }, fetchImpl: chain.fetchImpl });
    return { status: r.status, data: await r.json() };
  };
  return { env, owner, chain, call, L };
}
/** The founder of Utica signed in on the founder's launch routes: the approval on the fake chain, launches on. */
async function founderWorld({ approval = true } = {}) {
  const env = { ...newWorld(), ...LP_ON, LAUNCHPAD_DBC_CONFIGS: SOL_CONFIG, LAUNCHPAD_LOOKUP_TABLE: TABLE, VICINITY_MINT: MINT };
  const f = await uticaFounder(env);
  const lp = lpChain();
  const L = launchpadPdas(PROGRAM);
  if (approval) lp.S.accounts[await L.approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: f.w.address, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
  const main = (await import("./helpers/world.js")).chain();
  const fetchImpl = async (url, init) => (String(url).startsWith(LP_ON.LAUNCHPAD_RPC_URL) ? lp.fetchImpl(url, init) : main(url, init));
  const call = async (path, body) => {
    const url = body === undefined ? `${path}${path.includes("?") ? "&" : "?"}cluster=devnet` : path;
    const r = await f.send(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : { cluster: "devnet", ...body }, fetchImpl });
    return { status: r.status, data: await r.json() };
  };
  return { env, f, lp, L, call };
}

/* ---------------------------------------------------------------- (a) the design never carries a ticker */
test("(a) a ticker or symbol in the design request is ignored: the saved design and every later answer show the list's ticker, the request's value appears nowhere", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const f = await uticaFounder(env);
  const r = await f.post("/api/coins/design", { name: "Utica Coin", pitch: "The Handshake City.", pair: "SOL", color: "emerald", ticker: "HACK", symbol: "HACK" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!JSON.stringify(r).includes("HACK"), "the answer to the save");
  const row = await env.DB.prepare("SELECT * FROM city_coins WHERE city_id = ?").bind(UTICA).first();
  assert.ok(!JSON.stringify(row).includes("HACK"), "the saved row has no ticker column to carry it");
  const pub = await browser(env).get(`/api/coins?city=${UTICA}`);
  assert.equal(pub.coin.name, "Utica Coin");
  assert.ok(!JSON.stringify(pub).includes("HACK"));
  const me = await f.get("/api/me");
  assert.deepEqual([me.community.ticker, me.community.tickerSource], ["UTICA", "registry"], "the dashboard gets the list's ticker");
  assert.ok(!JSON.stringify(me).includes("HACK"));
  const lpd = await (await browser(env).send("/api/launchpad", { fetchImpl: dexMock({}).fetchImpl })).json();
  assert.equal(lpd.coins.find((c) => c.city.id === UTICA).ticker, "UTICA", "the Launchpad card");
  assert.ok(!JSON.stringify(lpd).includes("HACK"));
  const audit = (await browser(env).get("/api/audit?country=US")).actions.filter((a) => a.action === "coin_design");
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes("HACK"), "the public log");
});

/* ---------------------------------------------------------------- (b) the approval binds the server's values only */
test("(b) approve/tx with a symbol or name other than the server's is refused with design_changed and nothing is built; the real values build the Approval with the list's ticker", async () => {
  const w = await adminWorld();
  const f = await person(w.env);
  await seedCoin(w.env.DB, { city: NYC, name: "New York City", coin: "Big Apple", seat: await seedSeat(w.env, f, { city: NYC, name: "New York City", handle: "nyc" }) });
  const list = (await w.call("/api/admin/lp/candidates")).data;
  assert.equal(list.ok, true, JSON.stringify(list));
  const c = list.candidates.find((x) => x.cityId === NYC);
  assert.deepEqual([c.ok, c.symbol, c.ticker, c.name], [true, "NYC", "NYC", "Big Apple"], JSON.stringify(c));
  const seen = { cityId: c.cityId, name: c.name, symbol: c.symbol, founder: c.founder, designAt: c.designAt };
  const before = w.chain.S.log.length;
  for (const bad of [{ symbol: "HACK" }, { symbol: "nyc" }, { name: "Big Apple 2" }, { symbol: null }]) {
    const r = await w.call("/api/admin/lp/approve/tx", { ...seen, ...bad });
    assert.deepEqual([r.status, r.data.error], [409, "design_changed"], JSON.stringify(bad));
    assert.equal(r.data.tx, undefined, "no transaction in the answer");
  }
  assert.equal(w.chain.S.log.slice(before).filter((l) => l.method === "simulateTransaction" || l.method === "getLatestBlockhash").length, 0, "nothing was built or simulated");
  // the page's own values: built, and the instruction carries the list's ticker, read back from its bytes
  const ok = await w.call("/api/admin/lp/approve/tx", seen);
  assert.equal(ok.data.ok, true, JSON.stringify(ok.data));
  const shown = ok.data.summary.find((x) => x.ix === "approve_launch");
  assert.deepEqual([shown.fields.symbol, shown.fields.name, shown.fields.cityId], ["NYC", "Big Apple", NYC]);
  assert.equal(ok.data.approve.symbol, "NYC");
});

/* ---------------------------------------------------------------- (c) the launch instruction carries the city id only */
test("(c) the launch instruction's data is the 8-byte discriminator plus the little-endian u64 city id: 16 bytes, no name, no symbol", async () => {
  for (const cityId of [1n, 5142056n, 999000003n, (1n << 64n) - 2n]) {
    const ix = await IX.launch({ programId: PROGRAM, founder: addr(1), baseMint: addr(2), cityId, dbcConfig: SOL_CONFIG, quoteMint: WSOL, rentPayer: addr(3) });
    assert.equal(ix.data.length, 16, `city ${cityId}`);
    assert.deepEqual([...ix.data.subarray(0, 8)], IX.DISCRIMINATORS.launch);
    assert.deepEqual(Buffer.from(ix.data.subarray(8)), Buffer.from(u64le(cityId)));
    assert.equal(new DataView(ix.data.buffer, ix.data.byteOffset + 8, 8).getBigUint64(0, true), cityId, "little-endian");
    assert.deepEqual(Buffer.from(ix.data), Buffer.from(concat([Uint8Array.from(IX.DISCRIMINATORS.launch), u64le(cityId)])));
  }
  // and the founder's route builds exactly that (the approval's name and symbol stay on chain, never in the transaction)
  const w = await founderWorld();
  const mint = addr(90);
  const r = await w.call("/api/lp/launch/tx", { cityId: UTICA, mint });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = decodeHeader(Buffer.from(r.data.tx, "base64"));
  const launch = d.instructions[d.instructions.length - 1];
  assert.deepEqual(Buffer.from(launch.data), Buffer.from(concat([Uint8Array.from(IX.DISCRIMINATORS.launch), u64le(BigInt(UTICA))])));
  assert.equal(Buffer.from(r.data.tx, "base64").includes(Buffer.from("UTICA")), false, "no symbol bytes anywhere in the transaction");
  assert.deepEqual([r.data.coin.symbol, r.data.ticker], ["UTICA", undefined], "the page is told the approval's symbol; the transaction is not");
});

/* ---------------------------------------------------------------- (d) no invented tickers */
test("(d) a design for a city the list does not know is refused in plain words, and nothing is saved or logged", async () => {
  const env = newWorld({ VICINITY_MINT: MINT });
  const files = { "/data/tickers.json": JSON.stringify({ 5128581: "NYC" }) }; // Utica is not in the list
  const assets = env.ASSETS;
  env.ASSETS = { fetch: async (r) => (files[new URL(r.url).pathname] ? new Response(files[new URL(r.url).pathname]) : assets.fetch(r)) };
  _resetTickers();
  const f = await uticaFounder(env);
  assert.equal(await tickerOf(env, UTICA), null);
  const r = await f.send("/api/coins/design", { method: "POST", body: { name: "Utica Coin", pitch: "", pair: "SOL", color: "emerald" } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, error: "no_ticker", message: "This city has no ticker yet. Tell us and we will add it." });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM city_coins").first()).n, 0, "nothing saved");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'coin_design'").first()).n, 0, "nothing logged");
  assert.equal((await f.get("/api/me")).community.ticker, null, "and the dashboard is handed no ticker (it shows the city's name)");
  // the dashboard's error map carries the same words
  const { readFileSync } = await import("node:fs");
  const dash = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
  assert.match(dash, /no_ticker: "This city has no ticker yet\. Tell us and we will add it\.",/);
});

test("(d) when the city list cannot be read right now, the design is told so (503 list_unavailable); the failure is not kept as an empty list, so the next save with the list back goes through", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const assets = env.ASSETS;
  let down = true;
  env.ASSETS = { fetch: async (r) => (down && new URL(r.url).pathname === "/data/tickers.json" ? new Response("boom", { status: 500 }) : assets.fetch(r)) };
  _resetTickers();
  const f = await uticaFounder(env);
  const body = { name: "Utica Coin", pitch: "", pair: "SOL", color: "emerald" };
  const r = await f.send("/api/coins/design", { method: "POST", body });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: "list_unavailable", message: "The city list could not be read just now. Try again in a minute." });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM city_coins").first()).n, 0, "nothing saved");
  assert.equal((await f.get("/api/me")).community.ticker, null, "meanwhile the dashboard is handed no ticker, not a wrong one");
  down = false; // the list answers again: the failed read was never cached
  assert.deepEqual(await tickerOf(env, UTICA), { ticker: "UTICA", base: "UTICA", shared: 1 });
  const ok = await f.post("/api/coins/design", body);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await f.get("/api/me")).community.ticker, "UTICA");
  assert.match(readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8"), /list_unavailable: "The city list could not be read just now\. Try again in a minute\.",/, "the dashboard's error map carries the same words");
});

/* ---------------------------------------------------------------- (e) the display pin */
test("(e) displayTicker: the chain's symbol when known, else the list's; one warning per server when both are known and differ; null when neither", async () => {
  const env = newWorld();
  assert.deepEqual(await displayTicker(env, { cityId: UTICA }), { ticker: "UTICA", source: "registry" }, "no lp_coins table yet: the list's");
  assert.equal(await chainSymbolOf(env, { cityId: UTICA }), null);
  assert.deepEqual(await chainSymbolsOf(env, [CITY_COIN]), new Map());
  assert.deepEqual(await displayTicker(env, { cityId: UTICA, chainSymbol: "UTICA" }), { ticker: "UTICA", source: "chain" });
  assert.deepEqual(await displayTicker(env, { cityId: UTICA, chainSymbol: null }), { ticker: "UTICA", source: "registry" });
  assert.deepEqual(await displayTicker(env, { cityId: "999" }), null, "a city in no list and on no chain");
  assert.deepEqual(await displayTicker(env, { cityId: "999", chainSymbol: "ZZZ" }), { ticker: "ZZZ", source: "chain" });
  const { value, lines } = await warnings(async () => [
    await displayTicker(env, { cityId: UTICA, chainSymbol: "UTICA2" }), await displayTicker(env, { cityId: UTICA, chainSymbol: "UTICA2" }), await displayTicker(env, { cityId: UTICA, chainSymbol: "UTICA3" }),
  ]);
  assert.deepEqual(value, [{ ticker: "UTICA2", source: "chain" }, { ticker: "UTICA2", source: "chain" }, { ticker: "UTICA3", source: "chain" }]);
  assert.equal(lines.length, 2, "one line per differing pair, not per call");
  assert.match(lines[0], /5142056/); assert.match(lines[0], /UTICA2/); assert.match(lines[0], /\bUTICA\b/);
  _resetTickers();
  assert.equal((await warnings(() => displayTicker(env, { cityId: UTICA, chainSymbol: "UTICA2" }))).lines.length, 1, "a new server logs it once again");
});

test("(e) every reader shows the recorded chain symbol when it differs from the list, with one log line: /api/me, the checker, the coin page, the Launchpad, the portfolio, the swap config, the member profile", async () => {
  const env = LP({ VICINITY_MINT: MINT, SWAP: "on", JUPITER_API_KEY: "k", SOLANA_RPC_URL: "https://rpc.test", PROFILES: "on" });
  const f = await uticaFounder(env);
  await seedCoin(env.DB, { city: UTICA, name: "Utica", coin: "Utica Coin", mint: CITY_COIN, launchedAt: "2026-10-19T10:00:00.000Z", user: 1, seat: 1 });
  await recordOnChain(env, { cityId: UTICA, mint: CITY_COIN, symbol: "UTICA2" });
  _resetTickers();
  const { value: out, lines } = await warnings(async () => ({
    me: await f.get("/api/me"),
    checker: await officialCityCoin(env, CITY_COIN),
    coin: await allowListed(env, CITY_COIN),
    cards: await (await browser(env).send("/api/launchpad", { fetchImpl: dexMock({}).fetchImpl })).json(),
    mints: await mintsFor(env),
    swap: await browser(env).get("/api/swap/config"),
    profile: await f.get("/api/profile"),
  }));
  assert.deepEqual([out.me.community.ticker, out.me.community.tickerSource], ["UTICA2", "chain"]);
  assert.equal(out.profile.profile.home.ticker, "UTICA2", "the member pass's coin disc");
  const port = out.profile.profile.portfolio;
  if (port) for (const it of port.items.filter((i) => i.kind === "city")) assert.deepEqual([it.symbol, it.tickerSource], ["UTICA2", "chain"]);
  assert.equal(out.checker.ticker, "UTICA2"); assert.match(out.checker.message, /official \$UTICA2:/);
  assert.equal(out.coin.ticker, "UTICA2");
  assert.equal(out.cards.coins.find((c) => c.city.id === UTICA).ticker, "UTICA2");
  assert.deepEqual(out.mints.filter((m) => m.kind === "city").map((m) => m.symbol), ["UTICA2"]);
  const tok = out.swap.tokens.find((t) => t.kind === "city");
  assert.deepEqual([tok.symbol, tok.tickerSource], ["UTICA2", "chain"]);
  assert.equal(lines.length, 1, `one log line for the whole server, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /5142056.*UTICA2.*UTICA/);
  // the coin page's answer carries it too (the same object the route builds from)
  const page = await (await browser(env).send(`/api/coin?mint=${CITY_COIN}`, { fetchImpl: dexMock({}).fetchImpl })).json();
  assert.equal(page.coin.ticker, "UTICA2");
  // a design is locked, but a saved design never carried a ticker anyway: the list's entry is untouched
  assert.deepEqual(await tickerOf(env, UTICA), { ticker: "UTICA", base: "UTICA", shared: 1 });
});

test("(e) when the chain's symbol is unknown (not recorded, or recorded without one) every reader shows the list's ticker and nothing is logged", async () => {
  const env = LP({ VICINITY_MINT: MINT, SWAP: "on", JUPITER_API_KEY: "k", SOLANA_RPC_URL: "https://rpc.test", PROFILES: "on" });
  const f = await uticaFounder(env);
  await seedCoin(env.DB, { city: UTICA, name: "Utica", coin: "Utica Coin", mint: CITY_COIN, launchedAt: "2026-10-19T10:00:00.000Z", user: 1, seat: 1 });
  await recordOnChain(env, { cityId: UTICA, mint: CITY_COIN, symbol: null }); // the metadata could not be read when it was recorded
  _resetTickers();
  const { value: out, lines } = await warnings(async () => ({
    me: await f.get("/api/me"), checker: await officialCityCoin(env, CITY_COIN), coin: await allowListed(env, CITY_COIN),
    cards: await (await browser(env).send("/api/launchpad", { fetchImpl: dexMock({}).fetchImpl })).json(), mints: await mintsFor(env), swap: await browser(env).get("/api/swap/config"),
    profile: await f.get("/api/profile"),
  }));
  assert.deepEqual([out.me.community.ticker, out.me.community.tickerSource], ["UTICA", "registry"]);
  assert.equal(out.profile.profile.home.ticker, "UTICA");
  assert.equal(out.checker.ticker, "UTICA");
  assert.equal(out.coin.ticker, "UTICA");
  assert.equal(out.cards.coins.find((c) => c.city.id === UTICA).ticker, "UTICA");
  assert.deepEqual(out.mints.filter((m) => m.kind === "city").map((m) => m.symbol), ["UTICA"]);
  assert.deepEqual([out.swap.tokens.find((t) => t.kind === "city").symbol, out.swap.tokens.find((t) => t.kind === "city").tickerSource], ["UTICA", "registry"]);
  assert.deepEqual(lines, []);
  // the same chain symbol as the list: shown as the chain's, nothing to warn about
  await env.DB.prepare("UPDATE lp_coins SET symbol = 'UTICA' WHERE mint = ?").bind(CITY_COIN).run();
  const same = await warnings(() => f.get("/api/me"));
  assert.deepEqual([same.value.community.ticker, same.value.community.tickerSource, same.lines], ["UTICA", "chain", []]);
});

test("(e) the admin's candidates list shows a launched coin by its chain symbol, and still approves with the list's ticker", async () => {
  const w = await adminWorld();
  await seedCoin(w.env.DB, { city: UTICA, name: "Utica", coin: "Utica Coin", mint: CITY_COIN, launchedAt: "2026-10-19T10:00:00.000Z" });
  await recordOnChain(w.env, { cityId: UTICA, mint: CITY_COIN, symbol: "UTICA2" });
  const f = await person(w.env);
  await seedCoin(w.env.DB, { city: NYC, name: "New York City", coin: "Big Apple", seat: await seedSeat(w.env, f, { city: NYC, name: "New York City", handle: "nyc" }) });
  _resetTickers();
  const { value: list, lines } = await warnings(async () => (await w.call("/api/admin/lp/candidates")).data);
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.deepEqual(list.launched.map((x) => [x.cityId, x.ticker, x.mint]), [[UTICA, "UTICA2", CITY_COIN]]);
  assert.deepEqual(list.candidates.map((x) => [x.cityId, x.ticker, x.symbol]), [[NYC, "NYC", "NYC"]], "a coin not launched yet: the list's ticker, which the approval binds");
  assert.equal(lines.length, 1);
});

test("(e) the founder's launch status names the chain's symbol once the coin is recorded, the list's before", async () => {
  const w = await founderWorld();
  const before = await w.call(`/api/lp/launch/status?city=${UTICA}`);
  assert.deepEqual([before.data.state, before.data.ticker, before.data.coin.symbol], ["ready", "UTICA", "UTICA"]);
  // launched: the Coin record is on chain (the recorded demo coin, re-addressed to Utica and this founder)
  const coinAddr = await w.L.coin(BigInt(UTICA));
  w.lp.S.accounts[coinAddr] = { ...w.lp.S.accounts[DEMOV_COIN] };
  setField(w.lp.S, coinAddr, "Coin", "city_id", UTICA);
  setField(w.lp.S, coinAddr, "Coin", "founder", w.f.w.address);
  const launched = await w.call(`/api/lp/launch/status?city=${UTICA}`);
  assert.deepEqual([launched.data.state, launched.data.mint, launched.data.ticker], ["launched", DEMOV, "UTICA"], "not recorded here yet: the list's");
  await recordOnChain(w.env, { cityId: UTICA, mint: DEMOV, symbol: "UTICA2" });
  _resetTickers();
  const { value: after2, lines } = await warnings(() => w.call(`/api/lp/launch/status?city=${UTICA}`));
  assert.deepEqual([after2.data.state, after2.data.ticker], ["launched", "UTICA2"]);
  assert.equal(lines.length, 1);
});

/* ---------------------------------------------------------------- the pages */
test("no page makes a ticker up from a city's name (dashboards, member pass, Buy panel, coin page, portfolio), and the $ goes only on a ticker the server vouches for", () => {
  const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
  for (const p of ["public/dashboard.js", "public/dashboard-v2.js", "public/profile.js", "public/swap.js", "public/coin.js", "src/portfolio.js", "src/profiles.js"]) {
    assert.doesNotMatch(read(p), /vicinityTicker|baseTicker|toUpperCase\(\)\.replace\(\/\[\^A-Z|tickers\.json/, `${p} derives no ticker from a name and reads no list of its own`);
  }
  const dash = read("public/dashboard.js");
  assert.ok(dash.includes(`const coinDisc = (c) => (c && c.ticker) || (c && c.name ? initials(c.name) : "");`), "a city without a ticker wears its initial on the disc (a ticker-sized disc cannot hold a name), never a ticker made from the name");
  assert.match(dash, /const coinLabel = \(c\) => \(c && c\.ticker \? `\$\$\{c\.ticker\}` : c && c\.name \? c\.name : "your city coin"\);/);
  assert.ok(dash.includes(`me.community.tickerSource === "chain" ? "Ticker · on chain" : me.community.ticker ? "Ticker · fixed by the map" : "Ticker · none yet"`), "the studio's label says where the ticker comes from");
  assert.ok(dash.includes("`The one official ${c.ticker ? tk : `${c.name} coin`}. Buy or swap it in the panel on the right.`"), "a launched coin without a ticker is 'the Utica coin', never 'the Utica'");
  assert.match(read("public/dashboard-v2.js"), /const coinLabel = \(c\) => \(c\.ticker \? `\$\$\{c\.ticker\}` : c\.name\);/);
  assert.ok(read("public/dashboard-v2.js").includes(`if (note) { note.hidden = !c.ticker; note.textContent = c.tickerSource === "chain" ? "on chain" : "fixed by the map"; }`), "the About note says where the ticker comes from, nothing for a city without one");
  // the Buy panel and the coin page: "$" only on a ticker; a coin without one goes by its name, plain
  const swap = read("public/swap.js"), coin = read("public/coin.js");
  assert.ok(swap.includes("t.kind === \"city\" ? (t.symbol ? `$${String(t.symbol).replace(/^\\$/, \"\")}` : t.name || \"city coin\")"), "the Buy panel's symbol");
  assert.doesNotMatch(swap, /\|\| "COIN"/);
  assert.ok(coin.includes("const ticker = str(c.ticker) ? `$${str(c.ticker)}` : str(c.name) || \"city coin\";"), "the coin page's header");
  assert.ok(coin.includes("document.title = `${str(d.coin.ticker) ? `$${str(d.coin.ticker)}` : str(d.coin.name) || \"City coin\"}: live price, chart and holders · Vicinity`;"), "the coin page's title");
  assert.doesNotMatch(coin, /\|\| "COIN"|\|\| "Coin"\}/);
  // the member pass: the server's ticker (else the initial) on the disc, and the portfolio's $ only with a tickerSource
  const prof = read("public/profile.js");
  assert.ok(prof.includes(`discText($("#pf-coin"), p.home.ticker || window.V.initials(p.home.name))`));
  assert.ok(prof.includes(`const symbolOf = (it) => (it.kind === "city" && !it.tickerSource ? it.symbol || it.name || "city coin" : `));
  assert.ok(read("src/profiles.js").includes("ticker: homeTicker ? homeTicker.ticker : null"), "/api/profile hands the page the home city's ticker");
  const html = read("public/dashboard.html");
  assert.ok(html.includes('<span id="cs-ticker-label">Ticker · fixed by the map</span>'));
  assert.ok(html.includes('<span class="tiny muted" id="ca-ticker-note">fixed by the map</span>'));
  assert.ok(html.includes('the one official <span data-city-ticker>$CITY</span>.'), "the $ travels with the ticker, so a city without one shows its name alone");
  assert.ok(!html.includes('src="/ticker.js"'), "the dashboard no longer loads ticker.js: nothing on it derives a ticker");
  assert.ok(!read("public/profile.html").includes('src="/ticker.js"'), "nor does the member profile page");
});

test("the dashboard says where the ticker comes from ('on chain' for the chain's symbol, 'fixed by the map' for the list's, nothing for a city without one), and a city without a ticker wears its initial on the discs", async () => {
  const seat = { you: true, status: "active", name: "SwiftHarbor10", threshold: 100000 }; // the founder sees the studio, whose ticker field carries the label
  const paint = async (community) => { const me = memberMe(); me.community = { ...me.community, ...community, seat }; return openDashboard({ me }); };
  const chain = await paint({ ticker: "UTICA2", tickerSource: "chain" });
  assert.deepEqual([chain.text("#ca-ticker"), chain.$("#ca-ticker-note").hidden, chain.text("#ca-ticker-note")], ["$UTICA2", false, "on chain"]);
  assert.deepEqual([chain.$("#cs-ticker").value, chain.text("#cs-ticker-label")], ["$UTICA2", "Ticker · on chain"]);
  assert.deepEqual([chain.text("#cc-face"), chain.text("#pass-coin")], ["UTICA2", "UTICA2"]);
  const reg = await paint({ ticker: "UTICA", tickerSource: "registry" });
  assert.deepEqual([reg.text("#ca-ticker"), reg.$("#ca-ticker-note").hidden, reg.text("#ca-ticker-note")], ["$UTICA", false, "fixed by the map"]);
  assert.deepEqual([reg.$("#cs-ticker").value, reg.text("#cs-ticker-label")], ["$UTICA", "Ticker · fixed by the map"]);
  const none = await paint({ ticker: null, tickerSource: null, name: "Nowhere" });
  assert.deepEqual([none.text("#ca-ticker"), none.$("#ca-ticker-note").hidden], ["Nowhere", true], "no claim about the map without a ticker");
  assert.deepEqual([none.$("#cs-ticker").value, none.text("#cs-ticker-label")], ["Nowhere", "Ticker · none yet"]);
  assert.deepEqual([none.text("#cc-face"), none.text("#pass-coin"), none.$("#cc-face").parentNode.dataset.len], ["N", "N", "1"], "the initial on the disc: the name stands beside it");
  assert.equal(none.text("#cc-ticker"), "Nowhere · city coin preview · United States");
  for (const sel of ["#panel-home", "#panel-city", "#panel-founder"]) assert.ok(!none.$(sel).textContent.includes("NOWHERE"), `${sel}: no ticker made from the name`);
});

test("the rules page: the one sentence is in the live Never list (/api/policy, which public/rules.js paints) and in the static page", async () => {
  const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
  const sentence = "Pick or change a city coin's ticker, or keep a picture that breaks the rules: the ticker is fixed by the Vicinity city list and copied on chain at launch, a picture that breaks the rules is removed, and a launched coin without a picture shows the Vicinity badge.";
  assert.ok(POLICY.never.includes(sentence), "POLICY.never is what the page shows");
  assert.equal(POLICY.never.filter((t) => /ticker/i.test(t)).length, 1, "one sentence, in the Never list only");
  assert.ok((await browser(newWorld()).get("/api/policy")).policy.never.includes(sentence), "and /api/policy carries it");
  assert.match(read("public/rules.js"), /\$\("#never-list"\)\.replaceChildren\(\.\.\.p\.never\.map/, "the page repaints the list from the live rules (so the static list alone would not have shown it)");
  assert.ok(read("public/rules.html").includes(`<li>${sentence}</li>`), "the same sentence is the static fallback");
  assert.equal(read("scripts/pages/src/rules.html").includes(sentence), true, "from the source the build reads");
  assert.doesNotMatch(sentence, /risk|warning|moon|rocket/i, "no warning, no hype");
});
