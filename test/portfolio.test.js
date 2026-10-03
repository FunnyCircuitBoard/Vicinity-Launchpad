// The portfolio (src/portfolio.js): what a wallet holds of $VICINITY and launched city coins, with live USD values.
// The blockchain and the price API are mocks that RECORD every request, so the tests can prove what was (and was never) asked.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { base58Encode, isSolanaAddress } from "../src/solana.js";
import { ensureSchema } from "../src/store.js";
import { MAX_ENTRIES, WALLET_FAIL_TTL, PRICE_FAIL_TTL, WALLET_TTL, _cacheSizes, _resetPortfolio, handlePortfolio, mintsFor, portfolioOf } from "../src/portfolio.js";
import { MINT, ORIGIN, clock, newWorld, person, realClock, useClock } from "./helpers/world.js";

const RPC = "https://rpc.test/key";
const T0 = Date.parse("2026-10-20T12:00:00Z");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RAY = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const UTICA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SYRACUSE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A valid-looking Solana address for any number n (a base58 key of 32 bytes). */
const addr = (n) => { const a = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 + (n % 250) : i === 1 ? Math.floor(n / 250) : (i * 7 + 3) & 255))); assert.ok(isSolanaAddress(a)); return a; };

beforeEach(() => { useClock("2026-10-20T12:00:00Z"); _resetPortfolio(); });
after(() => realClock());

/** One token account as getTokenAccountsByOwner (jsonParsed) answers it. */
function acct(mint, ui, { decimals = 6, t22 = false, uiOnly = false, rawOnly = false, reportedMint = mint } = {}) {
  const raw = BigInt(Math.round(ui * 10 ** decimals)).toString();
  const tokenAmount = uiOnly ? { uiAmount: ui }
    : rawOnly ? { amount: raw, decimals, uiAmount: null }
    : { amount: raw, decimals, uiAmount: ui, uiAmountString: String(ui) };
  return { pubkey: addr(9000 + Math.floor(Math.random() * 1e6)), account: { lamports: 2039280, executable: false, rentEpoch: 0, owner: t22 ? TOKEN_2022 : TOKEN_PROGRAM,
    data: { program: t22 ? "spl-token-2022" : "spl-token", space: 165, parsed: { type: "account", info: { mint: reportedMint, owner: "x", state: "initialized", tokenAmount } } } } };
}

/**
 * A fake blockchain + Jupiter that records everything it is asked.
 *   balances  { [wallet]: { [mint]: [account, ...] } }       (what the wallet really holds, including things we must never ask about)
 *   prices    { [mint]: usd }
 *   http      one entry per HTTP request to the RPC: { body, signal }       calls  one entry per JSON-RPC call: { method, owner, filter }
 *   priceIds  the mints of every price request
 * A request with a programId filter (it would list EVERY token) is answered with everything the wallet owns, so a leak would show.
 */
function fakeNet({ balances = {}, prices = {} } = {}) {
  const net = { balances, prices, rpcMode: "ok", priceMode: "ok", delay: 0, http: [], calls: [], priceUrls: [], priceIds: [] };
  net.fetch = async (url, init = {}) => {
    url = String(url);
    if (net.delay) await sleep(net.delay);
    if (url.startsWith("https://lite-api.jup.ag/price/v3?ids=")) {
      net.priceUrls.push(url);
      const ids = url.split("ids=")[1].split(",");
      net.priceIds.push(ids);
      if (!init.signal) throw new Error("the price call must have a timeout");
      if (net.priceMode === "http500") return new Response("down", { status: 500 });
      if (net.priceMode === "throw") throw new Error("offline");
      if (net.priceMode === "badjson") return new Response("<html>");
      return new Response(JSON.stringify(Object.fromEntries(ids.filter((m) => m in net.prices).map((m) => [m, { usdPrice: net.prices[m] }]))));
    }
    if (url !== RPC) throw new Error("unexpected host " + url);
    const body = JSON.parse(init.body);
    net.http.push({ body, signal: init.signal });
    const list = Array.isArray(body) ? body : [body];
    for (const b of list) net.calls.push({ method: b.method, owner: b.params[0], filter: b.params[1] });
    if (net.rpcMode === "throw") throw new Error("connection reset");
    if (net.rpcMode === "http500") return new Response("down", { status: 500 });
    if (net.rpcMode === "http429") return new Response("slow down", { status: 429 });
    if (net.rpcMode === "badjson") return new Response("<html>");
    if (net.rpcMode === "ratelimit") return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limited" } }));
    const accountsOf = (b) => {
      const w = net.balances[b.params[0]] || {};
      const f = b.params[1] || {};
      if (f.mint) return w[f.mint] || [];
      return Object.values(w).flat(); // programId filter: everything
    };
    let out = list.map((b) => ({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: accountsOf(b) } }));
    if (net.rpcMode === "entryerror") out[1] = { jsonrpc: "2.0", id: list[1].id, error: { code: -32602, message: "bad params" } };
    if (net.rpcMode === "missing") out = out.slice(0, -1);
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
  };
  return net;
}

let seq = 0;
/** A launched city coin (an admin recorded its contract), or a pending one. */
async function launch(env, cityId, mint, { cityName = "Town " + cityId, name = cityName + " Coin", pending = false } = {}) {
  await ensureSchema(env.DB);
  const at = new Date(T0 - 86400_000 + seq++ * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, mint, pending_mint, launched_at, updated_at, created_at)
    VALUES (?, ?, 'US', 1, 1, ?, 'SOL', 'emerald', ?, ?, ?, ?, ?)`).bind(String(cityId), cityName, name, pending ? null : mint, pending ? mint : null, pending ? null : at, at, at).run();
}
const world = async () => {
  const env = newWorld({ VICINITY_MINT: MINT, SOLANA_RPC_URL: RPC });
  await launch(env, 5142056, UTICA, { cityName: "Utica", name: "Utica Coin" });
  await launch(env, 5140405, SYRACUSE, { cityName: "Syracuse", name: "Syracuse Coin" });
  return env;
};
const get = (env, w, net, now = T0) => portfolioOf(env, w, { fetchImpl: net.fetch, now });

test("before launch and with no city coins: a valid empty portfolio, and the blockchain and the price API are never called", async () => {
  const env = newWorld({ SOLANA_RPC_URL: RPC }); // no VICINITY_MINT, no city coins
  const net = fakeNet({ balances: { [addr(1)]: { [SOL]: [acct(SOL, 5)] } } });
  const p = await get(env, addr(1), net);
  assert.deepEqual(p, { asOf: new Date(T0).toISOString(), totalUsd: 0, items: [], pricesComplete: true });
  assert.equal(net.http.length, 0);
  assert.equal(net.priceUrls.length, 0);
  assert.deepEqual(await mintsFor(env), []);
});

test("an empty wallet after launch: the same empty shape, one balance call per allowed mint, no price call", async () => {
  const env = await world();
  const net = fakeNet();
  const p = await get(env, addr(1), net);
  assert.deepEqual(p, { asOf: new Date(T0).toISOString(), totalUsd: 0, items: [], pricesComplete: true });
  assert.equal(net.calls.length, 3, "$VICINITY and the two city coins");
  assert.equal(net.priceUrls.length, 0, "nothing held, nothing to price");
});

test("only the allow-list is ever asked about, with the {mint} filter, even for a wallet that holds hundreds of other tokens", async () => {
  const env = await world();
  await launch(env, 111, addr(700), { pending: true }); // a contract still waiting for an admin: not a launched coin
  const wallet = addr(2);
  const others = Array.from({ length: 40 }, (_, i) => addr(500 + i));
  const w = { [MINT]: [acct(MINT, 1234.5)], [UTICA]: [acct(UTICA, 10)], [SOL]: [acct(SOL, 3)], [USDC]: [acct(USDC, 99)], [RAY]: [acct(RAY, 7)], [addr(700)]: [acct(addr(700), 1)] };
  for (const o of others) w[o] = [acct(o, 1000)];
  const net = fakeNet({ balances: { [wallet]: w }, prices: { [MINT]: 0.002, [UTICA]: 0.5, [SOL]: 150, [USDC]: 1, [addr(500)]: 8 } });
  const p = await get(env, wallet, net);

  const allowed = new Set([MINT, UTICA, SYRACUSE]);
  assert.equal(net.http.length, 1);
  assert.equal(net.calls.length, 3);
  assert.equal(net.http[0].body.length, 3);
  for (const c of net.calls) {
    assert.equal(c.method, "getTokenAccountsByOwner");
    assert.equal(c.owner, wallet, "only the member's own wallet");
    assert.deepEqual(Object.keys(c.filter), ["mint"], "the {mint} filter and nothing else (a programId filter would list every token)");
    assert.ok(allowed.has(c.filter.mint), "an allowed mint");
  }
  assert.deepEqual(new Set(net.calls.map((c) => c.filter.mint)), allowed, "every allowed mint, once");
  for (const h of net.http) assert.ok(h.signal, "the RPC call has a timeout");

  assert.deepEqual(p.items.map((i) => i.mint), [UTICA, MINT], "only $VICINITY and the held city coin (UTICA 5 USD, then VICINITY 2.469 USD)");
  for (const i of p.items) assert.ok(allowed.has(i.mint));
  assert.equal(net.priceUrls.length, 1);
  for (const id of net.priceIds.flat()) assert.ok(allowed.has(id), "prices are asked only for allowed mints: " + id);
  assert.deepEqual(new Set(net.priceIds[0]), new Set([MINT, UTICA]), "and only for the ones held");
});

test("what an item looks like: kind, ticker, names, city, amount, price, value, share, total, order", async () => {
  const env = await world();
  const wallet = addr(3);
  const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 5000)], [UTICA]: [acct(UTICA, 100)] } }, prices: { [MINT]: 0.002, [UTICA]: 0.3 } });
  const p = await get(env, wallet, net);
  assert.equal(p.asOf, new Date(T0).toISOString());
  assert.equal(p.pricesComplete, true);
  assert.equal(p.totalUsd, 40); // 5000 × 0.002 = 10, 100 × 0.3 = 30
  assert.deepEqual(p.items, [
    { kind: "city", mint: UTICA, symbol: "UTICA", name: "Utica Coin", city: { id: "5142056", name: "Utica", country: "US" }, amount: 100, priceUsd: 0.3, valueUsd: 30, sharePct: 75 },
    { kind: "vicinity", mint: MINT, symbol: "VICINITY", name: "Vicinity", amount: 5000, priceUsd: 0.002, valueUsd: 10, sharePct: 25 },
  ]);
  assert.ok(!("city" in p.items[1]), "$VICINITY has no city");
});

test("a city coin whose city has no ticker still gets a symbol", async () => {
  const env = newWorld({ VICINITY_MINT: MINT, SOLANA_RPC_URL: RPC });
  await launch(env, "nowhere-1", UTICA, { cityName: "Nowhere Land", name: "Nowhere Coin" });
  const net = fakeNet({ balances: { [addr(4)]: { [UTICA]: [acct(UTICA, 1)] } } });
  const p = await get(env, addr(4), net);
  assert.equal(p.items[0].symbol, "NOWHERELAND");
});

test("balances: two accounts of one mint are summed, Token-2022 works, raw amount and decimals are used, zero and foreign accounts are dropped", async () => {
  const env = await world();
  const wallet = addr(5);
  const net = fakeNet({ balances: { [wallet]: {
    [MINT]: [acct(MINT, 1500.25), acct(MINT, 0.75)],                                   // two accounts of one mint
    [UTICA]: [acct(UTICA, 123.456789012, { decimals: 9, t22: true, rawOnly: true })],  // Token-2022, 9 decimals, no uiAmount: from the raw amount
    [SYRACUSE]: [acct(SYRACUSE, 0), acct(SYRACUSE, 5, { reportedMint: SOL })],         // a zero account, and one the RPC claims is another mint: neither counts
  } } });
  const p = await get(env, wallet, net);
  assert.deepEqual(p.items.map((i) => [i.symbol, i.amount]), [["VICINITY", 1501], ["UTICA", 123.456789012]]);

  // an RPC that only reports uiAmount (older nodes) still works
  const net2 = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 12.5, { uiOnly: true })] } } });
  _resetPortfolio();
  assert.equal((await get(env, wallet, net2)).items[0].amount, 12.5);
});

test("zero-balance mints are dropped, and not priced", async () => {
  const env = await world();
  const wallet = addr(6);
  const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 0)], [UTICA]: [acct(UTICA, 3)] } }, prices: { [MINT]: 1, [UTICA]: 2 } });
  const p = await get(env, wallet, net);
  assert.deepEqual(p.items.map((i) => i.mint), [UTICA]);
  assert.deepEqual(net.priceIds, [[UTICA]]);
});

test("many mints: 25 per HTTP request on the blockchain, 50 per request to the price API", async () => {
  const env = newWorld({ VICINITY_MINT: MINT, SOLANA_RPC_URL: RPC });
  const wallet = addr(7), balances = { [MINT]: [acct(MINT, 10)] }, prices = { [MINT]: 1 };
  const coins = Array.from({ length: 120 }, (_, i) => addr(2000 + i));
  for (const [i, m] of coins.entries()) { await launch(env, 8000 + i, m); balances[m] = [acct(m, i + 1)]; prices[m] = 0.5; }
  const net = fakeNet({ balances: { [wallet]: balances }, prices });
  const p = await get(env, wallet, net);
  assert.deepEqual(net.http.map((h) => h.body.length).sort((a, b) => b - a), [25, 25, 25, 25, 21], "121 mints = 4 × 25 + 21");
  for (const h of net.http) assert.deepEqual(h.body.map((b) => b.id), h.body.map((_, j) => j), "ids are 0..n-1 in each batch");
  assert.equal(new Set(net.calls.map((c) => c.filter.mint)).size, 121);
  assert.deepEqual(net.priceIds.map((x) => x.length).sort((a, b) => b - a), [50, 50, 21], "121 held mints = 50 + 50 + 21");
  assert.equal(p.items.length, 121);
  assert.equal(p.pricesComplete, true);
  // ids of different batches never mix up: each coin has its own amount
  for (const [i, m] of coins.entries()) assert.equal(p.items.find((x) => x.mint === m).amount, i + 1);
});

test("prices: values, total, shares and order (biggest value first, then no price by amount)", async () => {
  const env = await world();
  await launch(env, 1, addr(801), { cityName: "Aa", name: "A coin" });
  await launch(env, 2, addr(802), { cityName: "Bb", name: "B coin" });
  const [A, B] = [addr(801), addr(802)];
  const wallet = addr(8);
  const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 5000)], [UTICA]: [acct(UTICA, 40)], [SYRACUSE]: [acct(SYRACUSE, 9000)], [A]: [acct(A, 100)], [B]: [acct(B, 100)] } },
    prices: { [MINT]: 0.002 /* 10 */, [UTICA]: 1.25 /* 50 */, [A]: 0.1 /* 10, ties with $VICINITY: bigger amount first */ } });
  const p = await get(env, wallet, net);
  assert.deepEqual(p.items.map((i) => [i.symbol, i.valueUsd, i.sharePct]), [
    ["UTICA", 50, 71.4286], ["VICINITY", 10, 14.2857], ["AA", 10, 14.2857], // equal value: the larger amount (5000 vs 100) comes first
    ["SYRACUSE", null, null], ["BB", null, null],                           // no price: after the priced ones, by amount
  ]);
  assert.equal(p.totalUsd, 70, "the sum of the priced items only");
  assert.equal(p.pricesComplete, false);
  assert.equal(p.items[3].priceUsd, null);
  assert.equal(p.items[3].amount, 9000, "an item without a price keeps its amount");
});

test("prices: when the price API fails every which way, the amounts still show", async () => {
  for (const mode of ["http500", "throw", "badjson"]) {
    const env = await world();
    const wallet = addr(9);
    const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 5000)], [UTICA]: [acct(UTICA, 40)] } }, prices: { [MINT]: 1, [UTICA]: 1 } });
    net.priceMode = mode;
    const p = await get(env, wallet, net);
    assert.equal(p.items.length, 2, mode);
    assert.deepEqual(p.items.map((i) => [i.priceUsd, i.valueUsd, i.sharePct]), [[null, null, null], [null, null, null]], mode);
    assert.equal(p.items[0].amount, 5000);
    assert.equal(p.totalUsd, null, mode);
    assert.equal(p.pricesComplete, false);
  }
});

test("prices: junk prices (zero, negative, text) count as no price", async () => {
  const env = await world();
  const wallet = addr(10);
  const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 5)], [UTICA]: [acct(UTICA, 5)], [SYRACUSE]: [acct(SYRACUSE, 5)] } }, prices: { [MINT]: 0, [UTICA]: -3, [SYRACUSE]: "abc" } });
  const p = await get(env, wallet, net);
  assert.deepEqual(p.items.map((i) => i.priceUsd), [null, null, null]);
  assert.equal(p.totalUsd, null);
});

test("caches: a wallet for 20 s, prices for 20 s shared between wallets, then fresh again", async () => {
  const env = await world();
  const [a, b] = [addr(11), addr(12)];
  const net = fakeNet({ balances: { [a]: { [MINT]: [acct(MINT, 100)] }, [b]: { [MINT]: [acct(MINT, 200)] } }, prices: { [MINT]: 2 } });
  const first = await get(env, a, net);
  assert.equal(first.totalUsd, 200);
  assert.equal(net.http.length, 1);
  assert.equal(net.priceUrls.length, 1);

  assert.deepEqual(await get(env, a, net, T0 + WALLET_TTL - 1), first, "inside 20 s: the same answer (asOf is when it was read)");
  assert.equal(net.http.length, 1, "no new blockchain call");
  assert.equal(net.priceUrls.length, 1);

  // another member inside the price window: a new balance lookup, but the price comes from the cache
  const other = await get(env, b, net, T0 + 5_000);
  assert.equal(other.totalUsd, 400);
  assert.equal(net.http.length, 2);
  assert.equal(net.priceUrls.length, 1, "prices are shared between wallets");

  // after 20 s: balances and price are read again, with the new numbers
  net.balances[a][MINT] = [acct(MINT, 150)];
  net.prices[MINT] = 3;
  const later = await get(env, a, net, T0 + WALLET_TTL);
  assert.equal(later.totalUsd, 450);
  assert.equal(later.asOf, new Date(T0 + WALLET_TTL).toISOString());
  assert.equal(net.http.length, 3);
  assert.equal(net.priceUrls.length, 2);
});

test("asOf never claims to be fresher than its oldest price", async () => {
  const env = await world();
  const [a, b] = [addr(13), addr(14)];
  const net = fakeNet({ balances: { [a]: { [MINT]: [acct(MINT, 1)] }, [b]: { [MINT]: [acct(MINT, 1)] } }, prices: { [MINT]: 2 } });
  await get(env, a, net, T0); // price fetched at T0
  const p = await get(env, b, net, T0 + 15_000); // balances read at T0+15 s, price still the one from T0
  assert.equal(p.asOf, new Date(T0).toISOString());
});

test("every caller gets its own copy: changing it does not change the cache", async () => {
  const env = await world();
  const wallet = addr(15);
  const net = fakeNet({ balances: { [wallet]: { [UTICA]: [acct(UTICA, 4)] } }, prices: { [UTICA]: 1 } });
  const one = await get(env, wallet, net);
  one.items[0].amount = 999; one.items[0].city.name = "X"; one.items.length = 0; one.totalUsd = -1;
  const two = await get(env, wallet, net);
  assert.equal(two.items[0].amount, 4);
  assert.equal(two.items[0].city.name, "Utica");
  assert.equal(two.totalUsd, 4);
});

test("identical requests that arrive together share ONE lookup, and so do prices across wallets", async () => {
  const env = await world();
  const wallet = addr(16);
  const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 10)], [UTICA]: [acct(UTICA, 10)] } }, prices: { [MINT]: 1, [UTICA]: 2 } });
  net.delay = 20;
  const many = await Promise.all(Array.from({ length: 12 }, () => get(env, wallet, net)));
  assert.equal(net.http.length, 1, "one blockchain request for twelve callers");
  assert.equal(net.priceUrls.length, 1);
  for (const p of many) assert.deepEqual(p, many[0]);
  assert.notEqual(many[0], many[1], "each with its own copy");
  assert.deepEqual(_cacheSizes(env).walletFlights + _cacheSizes(env).priceFlights, 0, "nothing stays in flight");

  // five other wallets at once: five balance lookups, but the price of a mint is fetched once
  const wallets = Array.from({ length: 5 }, (_, i) => addr(20 + i));
  for (const w of wallets) net.balances[w] = { [MINT]: [acct(MINT, 1)], [UTICA]: [acct(UTICA, 1)] };
  _resetPortfolio();
  net.http.length = 0; net.priceUrls.length = 0; net.priceIds.length = 0;
  await Promise.all(wallets.map((w) => get(env, w, net)));
  assert.equal(net.http.length, 5);
  assert.equal(net.priceUrls.length, 1, "one price request for five wallets");
});

test("a mint already being priced for one wallet is not asked again for another wallet that needs more", async () => {
  const env = await world();
  const [a, b] = [addr(30), addr(31)];
  const net = fakeNet({ balances: { [a]: { [MINT]: [acct(MINT, 1)] }, [b]: { [MINT]: [acct(MINT, 1)], [UTICA]: [acct(UTICA, 1)] } }, prices: { [MINT]: 1, [UTICA]: 2 } });
  net.delay = 10;
  const [pa, pb] = await Promise.all([get(env, a, net), get(env, b, net)]);
  const ids = net.priceIds.flat();
  assert.equal(ids.length, new Set(ids).size, "no mint priced twice: " + ids.join());
  assert.equal(pa.totalUsd, 1);
  assert.equal(pb.totalUsd, 3);
});

test("the caches are bounded, and expired entries are swept out", async () => {
  const env = await world();
  const net = fakeNet();
  const wallets = Array.from({ length: MAX_ENTRIES + 100 }, (_, i) => addr(3000 + i));
  for (let i = 0; i < wallets.length; i += 50) await Promise.all(wallets.slice(i, i + 50).map((w) => get(env, w, net)));
  assert.ok(_cacheSizes(env).wallets <= MAX_ENTRIES, `at most ${MAX_ENTRIES} wallets are kept, not ${_cacheSizes(env).wallets}`);
  assert.ok(_cacheSizes(env).wallets > 0);
  // twenty-one seconds later one new wallet is cached and everything that expired is gone
  await get(env, addr(9999), net, T0 + WALLET_TTL + 1_000);
  assert.equal(_cacheSizes(env).wallets, 1);
  assert.deepEqual([_cacheSizes(env).walletFlights, _cacheSizes(env).priceFlights], [0, 0]);
});

test("the blockchain failing in every way gives null (never a throw, never a fake empty portfolio), and the failure is remembered only briefly", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));
  const wallet = addr(40);
  for (const mode of ["http500", "http429", "ratelimit", "entryerror", "missing", "badjson", "throw"]) {
    _resetPortfolio();
    const env = await world();
    const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 5)] } }, prices: { [MINT]: 1 } });
    net.rpcMode = mode;
    assert.equal(await get(env, wallet, net), null, mode);
    assert.equal(net.priceUrls.length, 0, "nothing is priced when the balances are unknown");

    // right away: the failure is still remembered (a failing service is not hammered)
    const calls = net.http.length;
    assert.equal(await get(env, wallet, net, T0 + WALLET_FAIL_TTL - 1), null);
    assert.equal(net.http.length, calls, mode + ": no new call inside the brief failure window");
    // service back: asked again after the window, and the page gets the real numbers
    net.rpcMode = "ok";
    const ok = await get(env, wallet, net, T0 + WALLET_FAIL_TTL);
    assert.equal(ok.totalUsd, 5, mode);
  }
  const all = logged.join("\n");
  assert.ok(logged.length > 0);
  assert.ok(!all.includes(wallet) && !all.includes(MINT), "errors are logged as codes only, never an address");
});

test("a wallet that is not an address, or a database that fails, gives null and never throws", async (t) => {
  t.mock.method(console, "error", () => {});
  const env = await world();
  const net = fakeNet();
  for (const bad of [null, undefined, "", "not-an-address", 42, {}, addr(1).slice(0, -1) + "0"]) assert.equal(await get(env, bad, net), null); // the last one has a character that is not in base58
  assert.equal(net.http.length, 0);
  const broken = newWorld({ VICINITY_MINT: MINT, SOLANA_RPC_URL: RPC });
  broken.DB = { prepare() { throw new Error("D1 is down"); }, batch() { throw new Error("D1 is down"); } };
  assert.equal(await get(broken, addr(41), net), null);
  assert.equal(net.http.length, 0);
});

test("a price failure is remembered for 5 s only; a missing price (the API answers, but has none) is an answer for 20 s", async () => {
  const env = await world();
  const wallet = addr(42);
  const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 10)], [UTICA]: [acct(UTICA, 10)] } }, prices: { [MINT]: 1 } });
  net.priceMode = "http500";
  const down = await get(env, wallet, net);
  assert.deepEqual(down.items.map((i) => i.priceUsd), [null, null]);
  await get(env, wallet, net, T0 + PRICE_FAIL_TTL - 1);
  assert.equal(net.priceUrls.length, 1, "the failed price is not asked again inside 5 s");
  net.priceMode = "ok";
  const back = await get(env, wallet, net, T0 + PRICE_FAIL_TTL);
  assert.equal(net.priceUrls.length, 2);
  assert.equal(back.items.find((i) => i.mint === MINT).priceUsd, 1);
  assert.equal(back.items.find((i) => i.mint === UTICA).priceUsd, null, "this coin has no price (it has no pool yet)");
  await get(env, wallet, net, T0 + PRICE_FAIL_TTL + 10_000);
  assert.equal(net.priceUrls.length, 2, "an honest 'no price' is cached like any answer");
  assert.equal(net.http.length, 2, "and the portfolio too");
});

test("mintsFor: $VICINITY first, then launched city coins only, never SOL/USDC/RAY, pending or malformed contracts", async () => {
  const env = await world();
  await launch(env, 1, addr(900), { pending: true });
  await launch(env, 2, SOL, { cityName: "Solville" });          // a table that (wrongly) lists a pair token
  await launch(env, 3, MINT, { cityName: "Twin" });             // a city coin with the $VICINITY contract: $VICINITY wins
  await launch(env, 4, "not-a-mint", { cityName: "Broken" });
  const list = await mintsFor(env);
  assert.deepEqual(list, [
    { kind: "vicinity", mint: MINT, symbol: "VICINITY", name: "Vicinity" },
    { kind: "city", mint: UTICA, symbol: "UTICA", name: "Utica Coin", city: { id: "5142056", name: "Utica", country: "US" } },
    { kind: "city", mint: SYRACUSE, symbol: "SYRACUSE", name: "Syracuse Coin", city: { id: "5140405", name: "Syracuse", country: "US" } },
  ]);
  list[0].symbol = "X"; list[1].city.name = "X"; list.pop();
  const again = await mintsFor(env);
  assert.equal(again.length, 3);
  assert.equal(again[0].symbol, "VICINITY");
  assert.equal(again[1].city.name, "Utica", "the caller's copy is its own");
});

test("mintsFor: no live $VICINITY yet means no $VICINITY entry, a malformed one is ignored", async () => {
  const before = newWorld({ SOLANA_RPC_URL: RPC });
  await launch(before, 5142056, UTICA, { cityName: "Utica" });
  assert.deepEqual((await mintsFor(before)).map((m) => m.kind), ["city"]);
  const junk = newWorld({ VICINITY_MINT: "paste-it-here" });
  assert.deepEqual(await mintsFor(junk), []);
});

test("a newly launched coin shows up within 20 s even while a wallet's portfolio is still cached", async () => {
  const env = await world();
  const wallet = addr(50), fresh = addr(951);
  const net = fakeNet({ balances: { [wallet]: { [MINT]: [acct(MINT, 1)], [fresh]: [acct(fresh, 7)] } }, prices: { [MINT]: 1, [fresh]: 2 } });
  await mintsFor(env, { now: T0 }); // the allow-list is read at T0 (kept until T0+20 s)
  const before = await get(env, wallet, net, T0 + 15_000); // this wallet's entry is kept until T0+35 s
  assert.equal(before.items.length, 1);
  await launch(env, 77, fresh, { cityName: "Fresh" });
  assert.equal((await get(env, wallet, net, T0 + 16_000)).items.length, 1, "the allow-list is cached for 20 s: still the old one");
  const after = await get(env, wallet, net, T0 + 21_000); // the allow-list is read again; the wallet's old entry has NOT expired, but belongs to the old list
  assert.deepEqual(after.items.map((i) => i.symbol).sort(), ["FRESH", "VICINITY"]);
});

// ---- the HTTP handler ----
const cookieOf = (p) => [...p.jar].map(([k, v]) => `${k}=${v}`).join("; ");
const call = (env, p, net, { method = "GET", path = "/api/me/portfolio" } = {}) =>
  handlePortfolio(new Request(ORIGIN + path, { method, headers: p ? { cookie: cookieOf(p), origin: ORIGIN } : {} }), env, net.fetch, clock.now);

test("GET /api/me/portfolio: signed-in only, always the member's own wallet", async () => {
  const env = await world();
  const me = await person(env);
  const stranger = addr(60);
  const net = fakeNet({ balances: { [me.w.address]: { [MINT]: [acct(MINT, 2500)], [SOL]: [acct(SOL, 4)] }, [stranger]: { [MINT]: [acct(MINT, 9)] } }, prices: { [MINT]: 0.01 } });

  const nobody = await call(env, null, net);
  assert.equal(nobody.status, 401);
  assert.deepEqual(await nobody.json(), { ok: false, error: "sign_in" });
  assert.equal(net.http.length, 0, "no blockchain call for a visitor");

  const res = await call(env, me, net, { path: `/api/me/portfolio?wallet=${stranger}&owner=${stranger}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.portfolio.items.map((i) => [i.symbol, i.amount, i.valueUsd]), [["VICINITY", 2500, 25]]);
  assert.equal(body.portfolio.totalUsd, 25);
  assert.ok(net.calls.length > 0 && net.calls.every((c) => c.owner === me.w.address), "nobody else's wallet is ever asked about");

  assert.equal((await call(env, me, net, { method: "POST" })).status, 405);
  assert.equal((await call(env, me, net, { method: "DELETE" })).status, 405);
});

test("GET /api/me/portfolio: when balances cannot be read the answer is 200 with portfolio null", async (t) => {
  t.mock.method(console, "error", () => {});
  const env = await world();
  const me = await person(env);
  const net = fakeNet();
  net.rpcMode = "http500";
  const res = await call(env, me, net);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, portfolio: null });
});
