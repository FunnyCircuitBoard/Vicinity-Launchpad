// Send from the Wallet tab (wallet onboarding, step 2; WALLET_SEND=on): POST /api/wallet/send/build builds an UNSIGNED transfer of SOL,
// $VICINITY or a launched city coin from the signed-in person's linked wallet, after checking the asset, the destination (format, not the
// sender, on the curve, no pool / program / team lock / mint / token account / program-owned account) and the amount against the live
// balance and the network's rent rule; the answer carries the relay ticket and a summary the page shows verbatim (an address the chain has
// no account for is said there in so many words). /relay and /status are the swap's relay and status poll. With the switch off the three
// paths answer like any unknown path and /api/me has no new key.
// The Worker (test/helpers/world.js, real SQL) against the fake RPC of test/helpers/jupfake.js; the built bytes run against the real
// programs in solana/tests-launchpad/19-wallet-send.test.mjs. The page's sheet: the second half of this file (test/helpers/dashpage.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handleApi } from "../src/index.js";
import { _resetRelay, checkTicket } from "../src/relay.js";
import { ensureOnboardSchema, ensureSchema } from "../src/store.js";
import { SESSION_SECONDS, createSession } from "../src/auth.js";
import { OFFICIAL } from "../src/official.js";
import { base58Decode } from "../src/solana.js";
import { ADDRESSES, PROGRAM_IDS, ata, findProgramAddress } from "../src/sol/pda.js";
import { decodeHeader } from "../src/sol/message.js";
import { fromBase64, readU64, toBase64, u32le, u64le } from "../src/sol/bytes.js";
import { CU, DATA_SLICE, DEFAULT_CU_PRICE, FRESH_LINE, LIVE_LIMIT, NETWORK_FEE_LAMPORTS, RENT_ATA_LAMPORTS, RENT_MIN_LAMPORTS, SEND_LIMIT, accountOf, destinationProblem, planSend, pretty, solText, tokenAccountOf } from "../src/walletsend.js";
import { PUBLIC_LIMITS } from "../src/guards.js";
import { newWorld as bareWorld } from "./helpers/world.js";
import { ORIGIN, browser, newWorld, person, wallet } from "./helpers/world.js";
import { REAL_VIC, USDC, fakeWorld } from "./helpers/jupfake.js";
import { ADDR, UA, memberMe, openDashboard } from "./helpers/dashpage.js";

const SYSTEM = PROGRAM_IDS.system, TOKEN = PROGRAM_IDS.token;
const UTICA = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p"; // the launched city coin of the tests (a mint on the fake chain)
const b64 = (u8) => Buffer.from(u8).toString("base64");
/** A classic SPL Token mint account's bytes (82): no authorities, a supply, `decimals`, initialised. */
const mintData = (decimals) => { const d = new Uint8Array(82); d.set(u64le(1_000_000_000_000_000n), 36); d[44] = decimals; d[45] = 1; return b64(d); };
/** A token account's bytes (165): mint, owner, amount, initialised. */
const tokenData = (mint, owner, amount, { frozen = false } = {}) => { const d = new Uint8Array(165); d.set(base58Decode(mint), 0); d.set(base58Decode(owner), 32); d.set(u64le(amount), 64); d[108] = frozen ? 2 : 1; return b64(d); };
/** A Token-2022 account with extensions: 165 bytes, the type byte at 165 (1 = mint, 2 = token account), then the extensions. */
const t22Data = (type, extra = 40) => { const d = new Uint8Array(166 + extra); d[108] = 1; d[165] = type; return b64(d); };
const sys = (lamports) => ({ owner: SYSTEM, lamports, data: ["", "base64"] });
const mintAcc = (decimals) => ({ owner: TOKEN, lamports: 1_461_600, data: [mintData(decimals), "base64"] });
const tokenAcc = (mint, owner, amount) => ({ owner: TOKEN, lamports: 2_039_280, data: [tokenData(mint, owner, amount), "base64"] });
/** Fill the fee payer's signature slot (the relay checks the envelope, the fake node does not verify). */
const signed = (txB64) => { const b = fromBase64(txB64); b.fill(7, 1, 65); return toBase64(b); };
const fee = (cuLimit) => NETWORK_FEE_LAMPORTS + (DEFAULT_CU_PRICE * BigInt(cuLimit) + 999_999n) / 1_000_000n; // 5000 + the priority fee at the live price
let seq = 0;
/** A launched city coin (an admin recorded its contract), the way test/portfolio.test.js records one. */
async function launch(env, cityId, mint, { cityName, name }) {
  await ensureSchema(env.DB);
  const at = new Date(Date.now() - 86400_000 + seq++ * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, mint, pending_mint, launched_at, updated_at, created_at)
    VALUES (?, ?, 'US', 1, 1, ?, 'SOL', 'emerald', ?, NULL, ?, ?, ?)`).bind(String(cityId), cityName, name, mint, at, at, at).run();
}
/**
 * A world with the switch on: a signed-in member whose linked wallet holds 2 SOL, 25,000 $VICINITY and 1,200.5 $UTICA on the fake chain
 * (test/helpers/jupfake.js fakeRpc: accounts in memory, a blockhash, a simulation that passes, a send that confirms).
 */
async function world(extra = {}, { on = true } = {}) {
  _resetRelay();
  const W = fakeWorld({ rpc: { mints: { [REAL_VIC]: { decimals: 6 }, [UTICA]: { decimals: 6 } } } });
  const env = newWorld({ ...(on ? { WALLET_SEND: "on" } : {}), VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test", ...extra });
  await launch(env, 5142056, UTICA, { cityName: "Utica", name: "Utica Coin" });
  const me = await person(env);
  const sender = me.w.address;
  const A = W.rpc.accounts;
  A[sender] = sys(2_000_000_000);
  A[REAL_VIC] = mintAcc(6); A[UTICA] = mintAcc(6);
  A[await ata(sender, REAL_VIC)] = tokenAcc(REAL_VIC, sender, 25_000_000_000n);
  A[await ata(sender, UTICA)] = tokenAcc(UTICA, sender, 1_200_500_000n);
  // each call from a connection of its own (10.200.x.x): the per-connection brake (20 taps a minute from one address) has its own test below
  let conn = 0;
  const call = async (b, path, { method = "POST", body, origin = ORIGIN, ip = `10.200.${(++conn >> 8) & 255}.${conn & 255}` } = {}) => { const r = await b.send(path, { method, body, fetchImpl: W.fetch, origin, ip }); return { status: r.status, data: await r.json(), headers: r.headers }; };
  const build = (body, opts) => call(me, "/api/wallet/send/build", { body, ...opts });
  const rpcCalls = () => W.rpc.log.flatMap((l) => l.methods);
  return { W, env, me, sender, build, call, rpcCalls };
}
/** Row counts of every table, to show a build writes nothing but the attempt counter. */
async function rowCounts(env) {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()).results.map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).first()).n);
  return out;
}

/* ---------------------------------------------------------------- the switch ---------------------------------------------------------------- */
test("WALLET_SEND off: the three paths answer like any unknown path (404 not_found, before any method or sign-in check) and /api/me has no walletSend key; on: /api/me says walletSend: true", async () => {
  const off = await world({}, { on: false });
  for (const [path, method] of [["/api/wallet/send/build", "POST"], ["/api/wallet/send/relay", "POST"], ["/api/wallet/send/status?sig=1", "GET"], ["/api/wallet/send/build", "GET"], ["/api/wallet/send/anything", "GET"]]) {
    const r = await off.call(off.me, path, { method, body: method === "POST" ? { to: "x", asset: "SOL", amount: "1" } : undefined });
    assert.deepEqual([r.status, r.data], [404, { error: "not_found" }], `${method} ${path}`);
  }
  const visitor = browser(off.env);
  assert.equal((await visitor.get("/api/me")).walletSend, undefined, "no new key for a visitor");
  assert.equal((await off.me.get("/api/me")).walletSend, undefined, "no new key for a member");
  assert.equal((await off.me.get("/api/me?lite=1")).walletSend, undefined);
  assert.equal(off.rpcCalls().length, 0, "nothing asked of the chain");
  const on = await world();
  assert.equal((await on.me.get("/api/me")).walletSend, true);
  assert.equal((await on.me.get("/api/me?lite=1")).walletSend, true);
  assert.equal((await browser(on.env).get("/api/me")).walletSend, true, "the switch is said to everyone (the page shows the button only with a linked wallet)");
  // "ON" with spaces is on; anything else is off
  assert.equal((await (await world({ WALLET_SEND: " On " })).me.get("/api/me")).walletSend, true);
  assert.equal((await (await world({ WALLET_SEND: "yes" })).me.get("/api/me")).walletSend, undefined);
});

test("the build route needs this site's Origin, a POST, a signed-in person and a linked wallet; nothing is asked of the chain before those", async () => {
  const w = await world();
  const body = { to: ADDR, asset: "SOL", amount: "0.5" };
  assert.deepEqual((await w.call(w.me, "/api/wallet/send/build", { method: "GET" })).data, { error: "method_not_allowed" });
  assert.deepEqual((await w.build(body, { origin: null })).data, { ok: false, error: "bad_origin" });
  assert.deepEqual((await w.build(body, { origin: "https://evil.example" })).data, { ok: false, error: "bad_origin" });
  const visitor = browser(w.env);
  const v = await w.call(visitor, "/api/wallet/send/build", { body });
  assert.deepEqual([v.status, v.data.error], [401, "sign_in"]);
  // a member made the v3 way, no wallet yet (test/no-wallet-dashboard.test.js): nothing to send from
  await ensureOnboardSchema(w.env.DB);
  const at = new Date().toISOString();
  const r = await w.env.DB.prepare(`INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, home_at, early, created_at, terms_version, terms_agreed_at)
    VALUES (NULL, 'google', 'nw-1', 'NoWallet1', 'Sa', '5142056', 'Utica', 'US', ?, 0, ?, '2026-10-01', ?) RETURNING id`).bind(at, at, at).first();
  const nw = browser(w.env);
  const c = await createSession(w.env, { wallet: null, userId: r.id, provenAt: null }, SESSION_SECONDS, Date.now());
  nw.jar.set("vs", decodeURIComponent(c.split(";")[0].split("=")[1]));
  const n = await w.call(nw, "/api/wallet/send/build", { body });
  assert.deepEqual([n.status, n.data.error, n.data.message], [400, "no_wallet", "Link a wallet to your account first."]);
  assert.equal(w.rpcCalls().length, 0, "nothing asked of the chain");
  // the relay and the status poll are the swap's (no sign-in: the ticket is the proof), with the same Origin rule for the POST
  assert.deepEqual((await w.call(visitor, "/api/wallet/send/relay", { body: { tx: "AA==" }, origin: null })).data, { ok: false, error: "bad_origin" });
  assert.equal((await w.call(visitor, "/api/wallet/send/relay", { body: { tx: "not base64!" } })).data.error, "bad_tx");
  assert.equal((await w.call(visitor, "/api/wallet/send/status?sig=1", { method: "GET" })).data.error, "bad_signature");
});

/* ---------------------------------------------------------------- the checks ---------------------------------------------------------------- */
test("validation before any chain call: the asset, the address, the sender's own wallet, a PDA, a pool authority, a program, the team lock, a mint", async () => {
  const w = await world();
  const bad = async (body, status, error, extra = {}) => {
    const r = await w.build(body);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.equal(r.data.ok, false); assert.equal(r.data.error, error, JSON.stringify(r.data));
    for (const [k, v] of Object.entries(extra)) assert.equal(r.data[k], v, `${k} of ${JSON.stringify(r.data)}`);
    assert.equal(typeof r.data.message, "string", "plain words for the page");
    return r.data;
  };
  const to = (await wallet()).address;
  assert.equal((await w.build("not json")).data.error, "bad_json");
  await bad({ to, asset: USDC, amount: "1" }, 400, "unsupported_asset");
  await bad({ to, asset: "sol", amount: "1" }, 400, "unsupported_asset");
  await bad({ to, asset: "", amount: "1" }, 400, "unsupported_asset");
  await bad({ to, asset: "SOL" }, 400, "bad_amount");
  await bad({ to, asset: "SOL", amount: 1 }, 400, "bad_amount", { message: "Type an amount above zero, with a point for decimals (like 0.5)." });
  await bad({ to: "nope", asset: "SOL", amount: "1" }, 400, "bad_address", { message: "That is not a Solana address." });
  await bad({ to: "", asset: "SOL", amount: "1" }, 400, "bad_address");
  await bad({ to: w.sender, asset: "SOL", amount: "1" }, 400, "same_wallet", { message: "That is your own wallet address." });
  const [pda] = await findProgramAddress([new TextEncoder().encode("a program's address")], PROGRAM_IDS.system);
  await bad({ to: pda, asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "pda", message: "This address belongs to a program, not to a person. Check the address." });
  await bad({ to: ADDRESSES.dbcPoolAuthority, asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "pool" });
  await bad({ to: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "pool" }); // a pool program the holder list labels
  await bad({ to: PROGRAM_IDS.token, asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "program" });
  await bad({ to: PROGRAM_IDS.jupiter, asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "program" });
  await bad({ to: OFFICIAL.teamLocks[0].address, asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "team_lock", message: "This is the team lock's address, not a wallet." });
  await bad({ to: REAL_VIC, asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "mint" });
  await bad({ to: UTICA, asset: REAL_VIC, amount: "1" }, 400, "not_a_wallet", { reason: "mint" });
  await bad({ to: ADDRESSES.wsol, asset: "SOL", amount: "1" }, 400, "not_a_wallet", { reason: "mint" });
  assert.equal(w.rpcCalls().length, 0, "not one chain call for a request that fails its free checks");
  // a team wallet is a person's wallet: allowed (the chain then says what it is)
  const team = await w.build({ to: OFFICIAL.teamWallets[1], asset: "SOL", amount: "0.5" });
  assert.equal(team.status, 200, JSON.stringify(team.data));
  // the launchpad's own program and configs on mainnet (src/cluster.js settings) are programs too
  const lp = await world({ LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: "AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai", LAUNCHPAD_DBC_CONFIGS: "EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP" });
  for (const a of ["AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai", "EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP"]) {
    const r = await lp.build({ to: a, asset: "SOL", amount: "1" });
    assert.deepEqual([r.status, r.data.error, r.data.reason], [400, "not_a_wallet", "program"], a);
  }
});

test("the destination as the chain sees it: a token account, a program-owned account and a program are refused (409); a plain wallet and a wallet nobody has used yet are fine", async () => {
  const w = await world();
  const A = w.W.rpc.accounts;
  const tokenAcct = (await wallet()).address, poolAcct = (await wallet()).address, program = (await wallet()).address, program2 = (await wallet()).address, nonce = (await wallet()).address, fresh = (await wallet()).address, used = (await wallet()).address;
  const otherMint = (await wallet()).address, t22Mint = (await wallet()).address, t22Acct = (await wallet()).address, huge = (await wallet()).address;
  A[tokenAcct] = tokenAcc(REAL_VIC, used, 5n); // an on-curve address that happens to hold a token account (the owner program says what it is)
  A[poolAcct] = { owner: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", lamports: 1_000_000, data: [b64(new Uint8Array(8)), "base64"] };
  A[program] = { owner: "BPFLoaderUpgradeab1e11111111111111111111111", lamports: 1_000_000, executable: true, data: [b64(new Uint8Array(36)), "base64"] };
  A[program2] = { owner: (await wallet()).address, lamports: 1_000_000, executable: true, data: [b64(new Uint8Array(36)), "base64"] }; // the flag alone says it (an owner no list knows)
  A[nonce] = { owner: SYSTEM, lamports: 1_500_000, data: [b64(new Uint8Array(80)), "base64"] };
  A[otherMint] = mintAcc(6); // a mint no list knows (USDC's, say): a token's contract, not a wallet
  A[t22Mint] = { owner: PROGRAM_IDS.token2022, lamports: 3_000_000, data: [t22Data(1), "base64"] };
  A[t22Acct] = { owner: PROGRAM_IDS.token2022, lamports: 3_000_000, data: [t22Data(2), "base64"] };
  A[huge] = { owner: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", lamports: 1_000_000, data: [b64(new Uint8Array(1 << 20)), "base64"] }; // a megabyte of data
  A[used] = sys(1_000_000_000);
  const r1 = await w.build({ to: tokenAcct, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r1.status, r1.data.error, r1.data.reason, r1.data.message], [409, "not_a_wallet", "token_account", "This is a token account, not a wallet. Send to its owner's wallet address instead."]);
  const r2 = await w.build({ to: poolAcct, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r2.status, r2.data.error, r2.data.reason], [409, "not_a_wallet", "program_owned"]);
  const r3 = await w.build({ to: program, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r3.status, r3.data.error, r3.data.reason], [409, "not_a_wallet", "program"]);
  const r3b = await w.build({ to: program2, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r3b.status, r3b.data.error, r3b.data.reason], [409, "not_a_wallet", "program"], "executable: true, whoever owns it");
  const r4 = await w.build({ to: nonce, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r4.status, r4.data.error, r4.data.reason], [409, "not_a_wallet", "system_data"]);
  // a mint is a token's contract, not a token account: said as such (classic 82 bytes; Token-2022 by its type byte), a Token-2022 token account likewise
  const r5 = await w.build({ to: otherMint, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r5.status, r5.data.error, r5.data.reason, r5.data.message], [409, "not_a_wallet", "mint", "This is a token's contract address, not a wallet."]);
  assert.deepEqual((await w.build({ to: t22Mint, asset: "SOL", amount: "0.5" })).data.reason, "mint");
  assert.deepEqual((await w.build({ to: t22Acct, asset: "SOL", amount: "0.5" })).data.reason, "token_account");
  // the chain is asked for the first 166 bytes of each account only: an address with a megabyte of data costs the same read and is refused the same way
  const r6 = await w.build({ to: huge, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r6.status, r6.data.error, r6.data.reason], [409, "not_a_wallet", "program_owned"]);
  const reads = w.W.rpc.log.flatMap((l) => l.params.filter((_, i) => l.methods[i] === "getMultipleAccounts"));
  assert.ok(reads.length >= 7);
  for (const params of reads) assert.deepEqual(params[1], { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: DATA_SLICE } });
  assert.equal(DATA_SLICE, 166);
  const ok1 = await w.build({ to: used, asset: "SOL", amount: "0.5" });
  assert.equal(ok1.status, 200, JSON.stringify(ok1.data)); assert.deepEqual(ok1.data.summary.destination, { exists: true, tokenAccount: null });
  const ok2 = await w.build({ to: fresh, asset: "SOL", amount: "0.5" });
  assert.equal(ok2.status, 200); assert.deepEqual(ok2.data.summary.destination, { exists: false, tokenAccount: null }, "a wallet nobody has used yet: no account, still a wallet");
  // the token program's version 2022 and a mint that is not a mint are refused as the asset, not as the destination
  A[UTICA] = { owner: PROGRAM_IDS.token2022, lamports: 1_461_600, data: [mintData(6), "base64"] };
  const t22 = await w.build({ to: used, asset: UTICA, amount: "1" });
  assert.deepEqual([t22.status, t22.data.error, t22.data.reason], [400, "unsupported_asset", "token2022"]);
  delete A[UTICA];
  const gone = await w.build({ to: used, asset: UTICA, amount: "1" });
  assert.deepEqual([gone.status, gone.data.error, gone.data.reason], [400, "unsupported_asset", "no_mint"]);
});

test("amounts: the mint's decimals, the live balance, the fee, and the network's rent rule (never 0 < remaining < 0.00089088 SOL; everything only with Max; a new wallet needs the minimum)", async () => {
  const w = await world();
  const to = (await wallet()).address, used = (await wallet()).address;
  w.W.rpc.accounts[used] = sys(1_000_000_000);
  const SOL_FEE = fee(CU.sol);
  assert.equal(SOL_FEE, 6000n, "5,000 for the signature plus 1,000 lamports of priority fee at 100,000 micro-lamports over 10,000 units");
  const bad = async (body, error, extra = {}) => {
    const r = await w.build(body);
    assert.equal(r.status, error === "bad_amount" || error === "too_many_decimals" ? 400 : 409, JSON.stringify(r.data));
    assert.equal(r.data.error, error, JSON.stringify(r.data));
    for (const [k, v] of Object.entries(extra)) assert.equal(r.data[k], v, `${k} of ${JSON.stringify(r.data)}`);
    return r.data;
  };
  await bad({ to: used, asset: "SOL", amount: "abc" }, "bad_amount");
  await bad({ to: used, asset: "SOL", amount: "0" }, "bad_amount");
  await bad({ to: used, asset: "SOL", amount: "-1" }, "bad_amount");
  await bad({ to: used, asset: "SOL", amount: "1e3" }, "bad_amount");
  await bad({ to: used, asset: "SOL", amount: "0.0000000001" }, "too_many_decimals", { decimals: 9, message: "SOL has 9 decimals: use at most that many." });
  await bad({ to: used, asset: REAL_VIC, amount: "1.1234567" }, "too_many_decimals", { decimals: 6, message: "$VICINITY has 6 decimals: use at most that many." });
  // more than the wallet holds
  const over = await bad({ to: used, asset: "SOL", amount: "3" }, "insufficient_sol", { have: "2" });
  assert.equal(over.max, "1.99910312", "2 SOL minus the fee minus the 0.00089088 SOL the wallet keeps");
  assert.match(over.message, /^Not enough SOL: you have 2 SOL and the network fee is about 0\.000006 SOL\. The most you can send and keep your wallet open is 1\.99910312 SOL; Max sends everything\.$/);
  await bad({ to: used, asset: "SOL", amount: "1.9999999" }, "insufficient_sol"); // just over, after the fee
  // the rent rule: what stays must be 0 or at least the minimum
  const dust = await bad({ to: used, asset: "SOL", amount: "1.9995" }, "leaves_dust", { min: "0.00089088" });
  assert.equal(dust.remaining, "0.000494", "the lamports that would be left (2 SOL − 1.9995 − the fee), exactly");
  assert.match(dust.message, /^This would leave 0\.000494 SOL in your wallet, less than the 0\.00089088 SOL the network needs to keep an account open\./);
  const everything = (2_000_000_000n - SOL_FEE).toString();
  await bad({ to: used, asset: "SOL", amount: `1.${everything.slice(1)}` }, "all_required");
  // the same amount with all: true goes through, and the summary says the wallet is emptied
  const all = await w.build({ to: used, asset: "SOL", all: true });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.equal(all.data.amount, "1.999994"); assert.equal(all.data.amountRaw, everything);
  assert.deepEqual(all.data.summary.remaining, { amount: "0", label: "SOL" });
  assert.equal(all.data.summary.lines[2], "You keep no SOL after this send: your wallet is emptied.");
  // the most that keeps the wallet open is accepted
  assert.equal((await w.build({ to: used, asset: "SOL", amount: "1.99910312" })).status, 200);
  // a wallet nobody has used yet must receive at least the minimum, or the network refuses it
  await bad({ to, asset: "SOL", amount: "0.0005" }, "amount_below_rent", { min: "0.00089088" });
  assert.equal((await w.build({ to, asset: "SOL", amount: "0.00089088" })).status, 200, "exactly the minimum opens it");
  assert.equal((await w.build({ to: used, asset: "SOL", amount: "0.0005" })).status, 200, "a wallet that exists can take less");
  // tokens: the token account's balance, and the SOL for the fee (and the recipient's account rent) stays above the minimum
  const tok = await bad({ to: used, asset: REAL_VIC, amount: "25000.000001" }, "insufficient_balance", { have: "25000", max: "25000" });
  assert.equal(tok.message, "You hold 25,000 $VICINITY in this wallet's main token account, less than 25,000.000001. This page sends from that account only.", "the Wallet tab sums every token account of the wallet; a send reads the associated one: said so");
  await bad({ to: used, asset: UTICA, amount: "1200.500001" }, "insufficient_balance", { have: "1200.5" });
  // a token account the issuer froze is said by name (not "you hold none"), the sender's and the recipient's
  const sAta = await ata(w.sender, REAL_VIC), kept = w.W.rpc.accounts[sAta];
  w.W.rpc.accounts[sAta] = { owner: TOKEN, lamports: 2_039_280, data: [tokenData(REAL_VIC, w.sender, 25_000_000_000n, { frozen: true }), "base64"] };
  const frozen = await bad({ to: used, asset: REAL_VIC, amount: "1" }, "account_frozen");
  assert.equal(frozen.message, "Your $VICINITY account is frozen by the token's issuer. Nothing can be sent from it.");
  assert.deepEqual(tokenAccountOf(accountOf(w.W.rpc.accounts[sAta])).frozen, true);
  w.W.rpc.accounts[sAta] = kept;
  w.W.rpc.accounts[await ata(used, REAL_VIC)] = { owner: TOKEN, lamports: 2_039_280, data: [tokenData(REAL_VIC, used, 0n, { frozen: true }), "base64"] };
  assert.equal((await bad({ to: used, asset: REAL_VIC, amount: "1" }, "account_frozen")).message, "The recipient's $VICINITY account is frozen by the token's issuer. Nothing can be sent to it.");
  delete w.W.rpc.accounts[await ata(used, REAL_VIC)];
  // an old rent-paying recipient (below the minimum, still there) can only be brought to at least the minimum: the network refuses less
  const paying = (await wallet()).address;
  w.W.rpc.accounts[paying] = sys(500_000);
  const low = await bad({ to: paying, asset: "SOL", amount: "0.0001" }, "amount_below_rent", { min: "0.00039088" });
  assert.equal(low.message, "That wallet holds less than the 0.00089088 SOL the network needs to keep an account open, and a send must bring it to at least that: send at least 0.00039088 SOL, or check the address.");
  assert.equal((await w.build({ to: paying, asset: "SOL", amount: "0.00039088" })).status, 200, "exactly what brings it to the minimum");
  const allTok = await w.build({ to: used, asset: REAL_VIC, all: true });
  assert.deepEqual([allTok.status, allTok.data.amount, allTok.data.summary.remaining.amount], [200, "25000", "0"]);
  w.W.rpc.accounts[w.sender] = sys(2_900_000); // 0.0029 SOL: the fee, the recipient's account rent and the minimum do not fit
  const poor = await bad({ to: used, asset: REAL_VIC, amount: "1" }, "insufficient_sol", { have: "0.0029" });
  assert.match(poor.message, /^Not enough SOL for this send: you have 0\.0029 SOL and need about 0\.00205 SOL for the network fee and the recipient's account rent, keeping at least 0\.00089088 SOL in your wallet\.$/);
  w.W.rpc.accounts[await ata(used, REAL_VIC)] = tokenAcc(REAL_VIC, used, 0n); // the recipient has the account: no rent, and it fits
  assert.equal((await w.build({ to: used, asset: REAL_VIC, amount: "1" })).status, 200);
  w.W.rpc.accounts[w.sender] = sys(895_000); // the fee would leave less than the minimum
  await bad({ to: used, asset: REAL_VIC, amount: "1" }, "insufficient_sol");
  // no SOL account at all
  delete w.W.rpc.accounts[w.sender];
  await bad({ to: used, asset: "SOL", amount: "0.1" }, "insufficient_sol", { have: "0" });
  const none = await bad({ to: used, asset: "SOL", all: true }, "insufficient_sol");
  assert.equal(none.message, "Not enough SOL: you have 0 SOL and the network fee is about 0.000006 SOL.");
});

/* ---------------------------------------------------------------- the build ---------------------------------------------------------------- */
test("SOL to a wallet: the unsigned legacy transaction (compute budget, then one System transfer from the linked wallet), the ticket, the summary verbatim; the simulation ran; only the attempt counter was written", async () => {
  const w = await world();
  const to = (await wallet()).address;
  w.W.rpc.accounts[to] = sys(1_000_000_000);
  const ip = "10.77.0.1"; // the same connection both times: its counter row, and the account's, exist after the first build
  await w.build({ to, asset: "SOL", amount: "0.1" }, { ip }); // the first build makes the counter's salt row (settings) and the two counters: the second one shows what a build writes
  const before = await rowCounts(w.env);
  const r = await w.build({ to, asset: "SOL", amount: "0.5" }, { ip });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.deepEqual(Object.keys(d), ["ok", "tx", "version", "bytes", "blockhash", "lastValidBlockHeight", "chain", "cluster", "taker", "simulated", "ticket", "amount", "amountRaw", "fees", "summary"]);
  assert.deepEqual([d.version, d.chain, d.cluster, d.taker, d.simulated, d.amount, d.amountRaw], ["legacy", "solana:mainnet", "mainnet", w.sender, true, "0.5", "500000000"]);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.match(d.ticket, /^\d{13}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(typeof d.lastValidBlockHeight, "number");
  const tx = fromBase64(d.tx), h = decodeHeader(tx);
  assert.equal(tx.length, d.bytes);
  assert.deepEqual([h.version, h.numSignatures, h.signaturesFilled, h.header.numRequiredSignatures, h.blockhash], ["legacy", 1, [false], 1, d.blockhash], "one signer, unsigned");
  assert.equal(h.staticKeys[0], w.sender, "the linked wallet pays and signs");
  const ixs = h.instructions.map((i) => ({ program: h.staticKeys[i.programIdIndex], accounts: i.accountKeyIndexes.map((k) => h.staticKeys[k]), data: [...i.data] }));
  assert.deepEqual(ixs, [
    { program: PROGRAM_IDS.computeBudget, accounts: [], data: [2, ...u32le(CU.sol)] },
    { program: PROGRAM_IDS.computeBudget, accounts: [], data: [3, ...u64le(DEFAULT_CU_PRICE)] },
    { program: PROGRAM_IDS.system, accounts: [w.sender, to], data: [...u32le(2), ...u64le(500_000_000n)] },
  ], "exactly these three instructions, nothing else in the transaction");
  assert.deepEqual(d.fees, { computeUnitLimit: 10_000, computeUnitPrice: "100000", priorityLamports: 1000, networkLamports: 5000, feeLamports: 6000, rentLamports: 0 });
  assert.deepEqual(d.summary, {
    asset: { id: "SOL", mint: null, label: "SOL", symbol: "SOL", name: "Solana", decimals: 9 },
    to, notice: "A send cannot be undone.",
    amount: "0.5", amountRaw: "500000000",
    fee: { lamports: "6000", sol: "0.000006" }, rent: null,
    remaining: { amount: "1.499994", label: "SOL" }, remainingSol: "1.499994",
    destination: { exists: true, tokenAccount: null },
    lines: ["Send 0.5 SOL", "No Vicinity fee. Network fee about 0.000006 SOL.", "You keep 1.499994 SOL after this send."],
  });
  // the chain was asked for the accounts and a blockhash, then the simulation; nothing was sent
  assert.deepEqual(w.rpcCalls().slice(-3), ["getMultipleAccounts", "getLatestBlockhash", "simulateTransaction"]);
  assert.equal(w.W.rpc.sent.length, 0);
  // an address the chain has no account for: allowed (a wallet nobody has used yet), and the summary says so where the person decides
  const fresh = (await wallet()).address;
  const f = (await w.build({ to: fresh, asset: "SOL", amount: "0.5" }, { ip })).data;
  assert.deepEqual(f.summary.destination, { exists: false, tokenAccount: null });
  assert.deepEqual(f.summary.lines, ["Send 0.5 SOL", "No Vicinity fee. Network fee about 0.000006 SOL.", "This address has not been used on Solana before. Check it twice.", "You keep 1.499994 SOL after this send."]);
  assert.equal(f.summary.lines[2], FRESH_LINE);
  // the database: one counter row changed (the same account's: no new row), nothing else
  const after = await rowCounts(w.env);
  assert.deepEqual(after, before, "no row anywhere: the counter rows of this account and this connection already existed");
  // the ticket verifies for these very bytes, signed or not, and for nothing else
  assert.equal(await checkTicket(w.env, tx, d.ticket), true);
  assert.equal(await checkTicket(w.env, fromBase64(signed(d.tx)), d.ticket), true, "a signature does not change the message");
  const altered = tx.slice(); altered[altered.length - 1] ^= 1; // the amount's last byte
  assert.equal(await checkTicket(w.env, altered, d.ticket), false);
  assert.equal(await checkTicket(w.env, tx, d.ticket.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), false);
  // a priority price above the cap is capped so the fee stays under 0.01 SOL; no setting = the default
  const pricey = await world({ LAUNCHPAD_CU_PRICE: "99999999999" });
  const p = await pricey.build({ to: w.sender, asset: "SOL", amount: "0.5" });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.ok(p.data.fees.priorityLamports <= 10_000_000 && p.data.fees.priorityLamports > 1);
  assert.equal(p.data.fees.computeUnitPrice, "1000000000", "0.01 SOL over 10,000 units");
  const def = await world({ LAUNCHPAD_CU_PRICE: "" });
  assert.equal((await def.build({ to: w.sender, asset: "SOL", amount: "0.5" })).data.fees.computeUnitPrice, "100000");
});

test("a token to a wallet without its token account: create-idempotent paid by the sender, then transfer-checked with the mint's decimals; the rent in the summary; with the account: no creation, no rent; a city coin by its ticker", async () => {
  const w = await world();
  const to = (await wallet()).address;
  w.W.rpc.accounts[to] = sys(1_000_000_000);
  const r = await w.build({ to, asset: REAL_VIC, amount: "1000" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data, tx = fromBase64(d.tx), h = decodeHeader(tx);
  const sAta = await ata(w.sender, REAL_VIC), tAta = await ata(to, REAL_VIC);
  const ixs = h.instructions.map((i) => ({ program: h.staticKeys[i.programIdIndex], accounts: i.accountKeyIndexes.map((k) => h.staticKeys[k]), data: [...i.data] }));
  assert.deepEqual(ixs, [
    { program: PROGRAM_IDS.computeBudget, accounts: [], data: [2, ...u32le(CU.tokenWithAccount)] },
    { program: PROGRAM_IDS.computeBudget, accounts: [], data: [3, ...u64le(DEFAULT_CU_PRICE)] },
    { program: PROGRAM_IDS.ata, accounts: [w.sender, tAta, to, REAL_VIC, PROGRAM_IDS.system, PROGRAM_IDS.token], data: [1] },
    { program: PROGRAM_IDS.token, accounts: [sAta, REAL_VIC, tAta, w.sender], data: [12, ...u64le(1_000_000_000n), 6] },
  ]);
  assert.equal(h.staticKeys[0], w.sender);
  const FEE = fee(CU.tokenWithAccount);
  assert.deepEqual(d.fees, { computeUnitLimit: 60_000, computeUnitPrice: "100000", priorityLamports: 6000, networkLamports: 5000, feeLamports: Number(FEE), rentLamports: 2_039_280 });
  assert.deepEqual(d.summary, {
    asset: { id: REAL_VIC, mint: REAL_VIC, label: "$VICINITY", symbol: "VICINITY", name: "Vicinity", decimals: 6 },
    to, notice: "A send cannot be undone.",
    amount: "1000", amountRaw: "1000000000",
    fee: { lamports: String(FEE), sol: "0.000011" }, rent: { lamports: "2039280", sol: "0.00203928" },
    remaining: { amount: "24000", label: "$VICINITY" }, remainingSol: "1.99794972",
    destination: { exists: true, tokenAccount: false },
    lines: ["Send 1,000 $VICINITY", "No Vicinity fee. Network fee about 0.000011 SOL.", "+0.00204 SOL one-time account rent for the recipient.", "You keep 24,000 $VICINITY after this send.", "Your SOL after the fee and the rent: about 1.99794972 SOL."],
  });
  assert.equal(await checkTicket(w.env, tx, d.ticket), true);
  // the recipient has the account already: no creation, no rent
  w.W.rpc.accounts[tAta] = tokenAcc(REAL_VIC, to, 5_000_000n);
  const r2 = await w.build({ to, asset: REAL_VIC, amount: "0.5" });
  const h2 = decodeHeader(fromBase64(r2.data.tx));
  assert.equal(h2.instructions.length, 3, "budget, price, transfer");
  assert.deepEqual([r2.data.summary.rent, r2.data.summary.destination, r2.data.fees.rentLamports, r2.data.fees.computeUnitLimit], [null, { exists: true, tokenAccount: true }, 0, CU.token]);
  assert.deepEqual(r2.data.summary.lines, ["Send 0.5 $VICINITY", "No Vicinity fee. Network fee about 0.000008 SOL.", "You keep 24,999.5 $VICINITY after this send.", "Your SOL after the fee: about 1.999992 SOL."]);
  // a city coin: its ticker from the city list ($UTICA), the recipient's account missing
  const c = await w.build({ to, asset: UTICA, amount: "200.5" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.deepEqual(c.data.summary.asset, { id: UTICA, mint: UTICA, label: "$UTICA", symbol: "UTICA", name: "Utica Coin", decimals: 6 });
  assert.deepEqual(c.data.summary.lines.slice(0, 1).concat(c.data.summary.lines.slice(2, 4)), ["Send 200.5 $UTICA", "+0.00204 SOL one-time account rent for the recipient.", "You keep 1,000 $UTICA after this send."]);
  // a fresh recipient wallet (no account at all) with a token: the token account is created, the SOL account is the token program's business; the summary says the address is new
  const fresh = (await wallet()).address;
  const f = await w.build({ to: fresh, asset: REAL_VIC, amount: "1" });
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.deepEqual(f.data.summary.destination, { exists: false, tokenAccount: false });
  assert.deepEqual(f.data.summary.lines, ["Send 1 $VICINITY", "No Vicinity fee. Network fee about 0.000011 SOL.", "+0.00204 SOL one-time account rent for the recipient.", FRESH_LINE, "You keep 24,999 $VICINITY after this send.", "Your SOL after the fee and the rent: about 1.99794972 SOL."]);
  // SOL already sitting at the recipient's token-account address (someone sent SOL to the derived address): the account is made around it,
  // and the sender pays only what is missing of the rent; with enough there, nothing, and no rent line
  const pre = (await wallet()).address, preAta = await ata(pre, REAL_VIC);
  w.W.rpc.accounts[pre] = sys(1_000_000_000);
  w.W.rpc.accounts[preAta] = sys(1_000_000);
  const g = (await w.build({ to: pre, asset: REAL_VIC, amount: "1" })).data;
  assert.deepEqual([g.fees.rentLamports, g.summary.rent, g.fees.computeUnitLimit, decodeHeader(fromBase64(g.tx)).instructions.length], [1_039_280, { lamports: "1039280", sol: "0.00103928" }, CU.tokenWithAccount, 4], "the difference, the account still created");
  assert.equal(g.summary.lines[2], "+0.00104 SOL one-time account rent for the recipient.");
  assert.equal(g.summary.remainingSol, "1.99894972");
  w.W.rpc.accounts[preAta] = sys(3_000_000);
  const g2 = (await w.build({ to: pre, asset: REAL_VIC, amount: "1" })).data;
  assert.deepEqual([g2.fees.rentLamports, g2.summary.rent, decodeHeader(fromBase64(g2.tx)).instructions.length], [0, null, 4]);
  assert.deepEqual(g2.summary.lines, ["Send 1 $VICINITY", "No Vicinity fee. Network fee about 0.000011 SOL.", "You keep 24,999 $VICINITY after this send.", "Your SOL after the fee: about 1.999989 SOL."]);
});

test("the node's own refusal is mapped before the wallet opens; a node that cannot simulate does not stop a send the checks passed; a dead node is 503", async () => {
  const w = await world();
  const to = (await wallet()).address;
  w.W.rpc.sim = () => ({ err: { InstructionError: [2, { Custom: 1 }] }, logs: ["Program 11111111111111111111111111111111 invoke [1]", "Transfer: insufficient lamports 1, need 500000000", "Program 11111111111111111111111111111111 failed: custom program error: 0x1"] });
  const r = await w.build({ to, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r.status, r.data.ok, r.data.error, r.data.stage], [409, false, "insufficient_sol", "simulation"]);
  w.W.rpc.sim = () => { throw { code: -32005, message: "node is behind" }; };
  const r2 = await w.build({ to, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r2.status, r2.data.ok, r2.data.simulated], [200, true, false], "the simulation is best effort: the checks here already passed");
  const dead = await world();
  dead.W.rpc.one = () => { throw { code: -32603, message: "down" }; };
  const r3 = await dead.build({ to, asset: "SOL", amount: "0.5" });
  assert.deepEqual([r3.status, r3.data.error], [503, "rpc_unavailable"]);
});

/* ---------------------------------------------------------------- the relay, the status, the limit ---------------------------------------------------------------- */
test("the relay takes the signed bytes only with the ticket of these very bytes (a foreign or expired ticket, altered bytes, an unsigned transaction are refused); the status poll follows the signature", async () => {
  const w = await world();
  const to = (await wallet()).address;
  w.W.rpc.accounts[to] = sys(1_000_000_000);
  const b = (await w.build({ to, asset: "SOL", amount: "0.5" })).data;
  const visitor = browser(w.env); // the relay needs no sign-in: the ticket is the proof, as for the swap
  const relay = (body, origin = ORIGIN) => w.call(visitor, "/api/wallet/send/relay", { body, origin });
  assert.deepEqual((await relay({ tx: b.tx, ticket: b.ticket, lastValidBlockHeight: b.lastValidBlockHeight })).data, { ok: false, error: "unsigned" });
  const foreign = await relay({ tx: signed(b.tx), ticket: `${Date.now() + 600_000}.AAAAAAAAAAAAAAAAAAAAAA`, lastValidBlockHeight: b.lastValidBlockHeight });
  assert.deepEqual([foreign.status, foreign.data.error], [400, "bad_ticket"]);
  assert.equal((await relay({ tx: signed(b.tx), ticket: `${Date.now() - 1}.${b.ticket.split(".")[1]}`, lastValidBlockHeight: b.lastValidBlockHeight })).data.error, "bad_ticket", "expired");
  assert.equal((await relay({ tx: signed(b.tx), lastValidBlockHeight: b.lastValidBlockHeight })).data.error, "bad_ticket", "no ticket");
  const other = (await w.build({ to, asset: "SOL", amount: "0.25" })).data;
  assert.equal((await relay({ tx: signed(b.tx), ticket: other.ticket, lastValidBlockHeight: b.lastValidBlockHeight })).data.error, "bad_ticket", "another build's ticket");
  const bytes = fromBase64(signed(b.tx)); bytes[bytes.length - 1] ^= 1;
  assert.equal((await relay({ tx: toBase64(bytes), ticket: b.ticket, lastValidBlockHeight: b.lastValidBlockHeight })).data.error, "bad_ticket", "altered bytes (the amount)");
  assert.equal(w.W.rpc.sent.length, 0, "nothing reached the node");
  const ok = await relay({ tx: signed(b.tx), ticket: b.ticket, lastValidBlockHeight: b.lastValidBlockHeight });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.ok, ok.data.cluster, typeof ok.data.signature], [true, "mainnet", "string"]);
  assert.equal(ok.data.solscan, `https://solscan.io/tx/${ok.data.signature}`);
  assert.deepEqual(w.W.rpc.sent.map((s) => s.tx), [signed(b.tx)], "the very bytes, once");
  const st = await w.call(visitor, `/api/wallet/send/status?sig=${ok.data.signature}&lvbh=${b.lastValidBlockHeight}`, { method: "GET" });
  assert.deepEqual([st.status, st.data.ok, st.data.status, st.data.signature], [200, true, "confirmed", ok.data.signature]);
  // a failure on the chain is said as such
  w.W.rpc.statuses[ok.data.signature] = { confirmationStatus: "confirmed", confirmations: 1, err: { InstructionError: [2, { Custom: 1 }] }, slot: 1 };
  const failed = await w.call(visitor, `/api/wallet/send/status?sig=${ok.data.signature}`, { method: "GET" });
  assert.deepEqual([failed.data.status, failed.data.err], ["failed", "program_error"]);
  // without a database nothing can be verified or counted: the three paths (and the swap's relay) answer 503 unavailable, nothing reaches the node
  const noDb = bareWorld({ WALLET_SEND: "on", SWAP: "on", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test" }); delete noDb.DB;
  const bare = browser(noDb);
  for (const [path, method] of [["/api/wallet/send/relay", "POST"], ["/api/wallet/send/status?sig=" + ok.data.signature, "GET"], ["/api/wallet/send/build", "POST"], ["/api/swap/send", "POST"]]) {
    const r = await bare.send(path, { method, body: method === "POST" ? { tx: signed(b.tx), ticket: b.ticket, lastValidBlockHeight: b.lastValidBlockHeight, to, asset: "SOL", amount: "0.5" } : undefined, fetchImpl: w.W.fetch });
    assert.deepEqual([r.status, await r.json()], [503, { ok: false, error: "unavailable" }], `${method} ${path}`);
  }
  assert.deepEqual(w.W.rpc.sent.map((s) => s.tx), [signed(b.tx)], "still the one send");
});

test("the counters: 30 taps an hour per account (the 31st is 429 with Retry-After 3600, whatever the connection), the page's own live checks (?live=1) apart (60 an hour, never using up a tap), and per connection 20 taps / 60 live checks a minute; another account or connection is not held back; nothing of a refused request reaches the chain", async () => {
  const w = await world();
  const to = (await wallet()).address;
  w.W.rpc.accounts[to] = sys(1_000_000_000);
  assert.deepEqual(SEND_LIMIT, { max: 30, windowMs: 3_600_000 });
  assert.deepEqual(LIVE_LIMIT, { max: 60, windowMs: 3_600_000 });
  assert.deepEqual([PUBLIC_LIMITS.wallet_send_build, PUBLIC_LIMITS.wallet_send_build_live], [{ max: 20, windowMs: 60_000 }, { max: 60, windowMs: 60_000 }]);
  const body = { to, asset: "SOL", amount: "0.5" };
  const tap = (b, ip, live = false) => b.send(`/api/wallet/send/build${live ? "?live=1" : ""}`, { method: "POST", body, fetchImpl: w.W.fetch, ip });
  // the account's taps: 30 an hour, from however many connections
  for (let i = 0; i < 30; i++) assert.equal((await tap(w.me, `10.0.0.${i % 7}`)).status, 200, `build ${i + 1}`);
  const calls = w.rpcCalls().length;
  const r = await w.build(body);
  assert.deepEqual([r.status, r.data, r.headers.get("Retry-After")], [429, { ok: false, error: "slow_down" }, "3600"]);
  assert.equal(w.rpcCalls().length, calls, "a refused build asks the chain for nothing");
  // the same account's live checks still run (their own counter), and another account is not held back
  assert.equal((await tap(w.me, "10.0.0.9", true)).status, 200, "a live check after the taps ran out");
  const other = await person(w.env);
  w.W.rpc.accounts[other.w.address] = sys(1_000_000_000);
  assert.equal((await w.call(other, "/api/wallet/send/build", { body })).status, 200);
  // the live checks: 60 an hour per account, and they never use up a tap
  const typer = await person(w.env);
  w.W.rpc.accounts[typer.w.address] = sys(1_000_000_000);
  for (let i = 0; i < 60; i++) assert.equal((await tap(typer, `10.1.0.${i % 3}`, true)).status, 200, `live check ${i + 1}`);
  const live61 = await tap(typer, "10.1.0.9", true);
  assert.deepEqual([live61.status, live61.headers.get("Retry-After")], [429, "3600"]);
  assert.equal((await tap(typer, "10.1.0.9")).status, 200, "a Review tap after 60 live checks: its own budget is untouched");
  // per connection: 20 taps a minute from one address, whoever is signed in; the same account from another address goes on
  const a = await person(w.env), b2 = await person(w.env);
  w.W.rpc.accounts[a.w.address] = sys(1_000_000_000); w.W.rpc.accounts[b2.w.address] = sys(1_000_000_000);
  for (let i = 0; i < 10; i++) { assert.equal((await tap(a, "10.2.0.1")).status, 200); assert.equal((await tap(b2, "10.2.0.1")).status, 200); }
  const conn = await tap(a, "10.2.0.1");
  assert.deepEqual([conn.status, conn.headers.get("Retry-After")], [429, "60"], "the 21st build from one address in a minute");
  assert.equal((await tap(a, "10.2.0.2")).status, 200, "the same account, another address");
  // per connection, the live checks: 60 a minute
  const c = await person(w.env), d = await person(w.env);
  w.W.rpc.accounts[c.w.address] = sys(1_000_000_000); w.W.rpc.accounts[d.w.address] = sys(1_000_000_000);
  for (let i = 0; i < 30; i++) { assert.equal((await tap(c, "10.3.0.1", true)).status, 200); assert.equal((await tap(d, "10.3.0.1", true)).status, 200); }
  const liveConn = await tap(c, "10.3.0.1", true);
  assert.deepEqual([liveConn.status, liveConn.headers.get("Retry-After")], [429, "60"]);
  assert.equal((await tap(c, "10.3.0.1")).status, 200, "a tap from that address still goes: the taps are counted apart");
});

/* ---------------------------------------------------------------- the planner, pure ---------------------------------------------------------------- */
test("planSend and its helpers (pure): accounts decode, the rent constants, the words for numbers", async () => {
  assert.equal(RENT_MIN_LAMPORTS, 890_880n); assert.equal(RENT_ATA_LAMPORTS, 2_039_280n);
  assert.deepEqual(accountOf(null), null);
  assert.deepEqual(accountOf({ owner: SYSTEM, lamports: 5, data: ["", "base64"] }), { owner: SYSTEM, lamports: 5n, executable: false, data: new Uint8Array(0) });
  assert.equal(accountOf({ owner: TOKEN, lamports: "7", executable: true, data: ["AQI=", "base64"] }).data.join(","), "1,2");
  assert.equal(pretty(1_234_567_890n, 9), "1.23456789"); assert.equal(pretty(25_000_000_000n, 6), "25,000"); assert.equal(pretty(0n, 9), "0");
  assert.equal(solText(5001n), "0.000005"); assert.equal(solText(2_039_280n), "0.00204"); assert.equal(solText(11_000n), "0.000011");
  assert.equal(destinationProblem(ADDR, "other", {}), null);
  assert.deepEqual(destinationProblem(ADDR, ADDR, {}), { error: "same_wallet", message: "That is your own wallet address." });
  assert.equal(destinationProblem(ADDR, "other", {}, { account: { owner: TOKEN, lamports: 1n, executable: false, data: new Uint8Array(165) } }).reason, "token_account");
  assert.equal(destinationProblem(ADDR, "other", {}, { account: { owner: TOKEN, lamports: 1n, executable: false, data: new Uint8Array(82) } }).reason, "mint");
  assert.equal(destinationProblem(ADDR, "other", {}, { account: { owner: TOKEN, lamports: 1n, executable: true, data: new Uint8Array(0) } }).reason, "program");
  assert.equal(tokenAccountOf(accountOf(tokenAcc(REAL_VIC, ADDR, 5n))).frozen, false);
  assert.equal(tokenAccountOf({ owner: TOKEN, lamports: 1n, executable: false, data: new Uint8Array(165) }), null, "not initialised");
  assert.equal(destinationProblem(ADDR, "other", {}, { account: { owner: SYSTEM, lamports: 1n, executable: false, data: new Uint8Array(0) } }), null);
  // a SOL plan with no sender account and `all`: insufficient; a token plan reads the balance from the token account's bytes
  const sender = (await wallet()).address, to = (await wallet()).address;
  const none = await planSend({ sender, to, asset: { id: "SOL", label: "SOL", decimals: 9 }, all: true, chain: { sender: null, to: null }, cuPrice: 0n });
  assert.deepEqual([none.ok, none.error, none.status], [false, "insufficient_sol", 409]);
  const sAta = await ata(sender, REAL_VIC), tAta = await ata(to, REAL_VIC);
  const chain = { sender: accountOf(sys(1_000_000_000)), to: accountOf(sys(1)), mint: accountOf(mintAcc(6)), senderAta: accountOf(tokenAcc(REAL_VIC, sender, 7_000_000n)), toAta: null };
  const p = await planSend({ sender, to, asset: { id: REAL_VIC, mint: REAL_VIC, label: "$VICINITY", symbol: "VICINITY", name: "Vicinity", decimals: 6 }, amount: "7", chain, addresses: { senderAta: sAta, toAta: tAta }, cuPrice: 0n });
  assert.equal(p.ok, true, JSON.stringify(p, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.deepEqual([p.amountRaw, p.fee, p.rent, p.remaining, p.remainingSol, p.cuLimit, p.cuPrice], [7_000_000n, 5000n, RENT_ATA_LAMPORTS, 0n, 1_000_000_000n - 5000n - RENT_ATA_LAMPORTS, CU.tokenWithAccount, 0n]);
  assert.equal(p.instructions.length, 3, "no price instruction at a price of 0: the limit, the account, the transfer");
  assert.equal(readU64(p.instructions[2].data, 1), 7_000_000n);
  // a token account of another mint at the sender's address is not a balance
  const wrong = { ...chain, senderAta: accountOf(tokenAcc(UTICA, sender, 7_000_000n)) };
  const q = await planSend({ sender, to, asset: { id: REAL_VIC, mint: REAL_VIC, label: "$VICINITY", decimals: 6 }, amount: "1", chain: wrong, addresses: { senderAta: sAta, toAta: tAta }, cuPrice: 0n });
  assert.deepEqual([q.ok, q.error, q.have], [false, "insufficient_balance", "0"]);
});

/* ================================================================ the page: the Send button and the Send sheet (test/helpers/dashpage.js) ================================================================ */
import { newEvent } from "./helpers/pagedom.js";
import { base58Encode } from "../src/solana.js";
import { compileLegacy, wrapUnsigned } from "../src/sol/message.js";
import { SOL as SOL_ID } from "../src/walletsend.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SOL_MINT = "So11111111111111111111111111111111111111112", VIC = REAL_VIC;
const OSWEGO = "47ugnHuxsmgNZu8KEv1VXW7wPVVwMWti8vVrK4ADDxWa", ROME = "G3aqFFHFeeWTYnnPPaNHUvgLj8XSUCN95fQtJQosdqWp";
const TO = ADDR, TO2 = "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN";
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", LVBH = 4321;
const SIGB58 = base58Encode(new Uint8Array(64).fill(3));
/** The linked wallet of the page tests: a real key, so the signing module can check the fake wallet's signature. */
async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return { address, sign: async (msg) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, msg)) };
}
/**
 * A Wallet Standard wallet as a wallet app injects one (registered through the real public/wallets.js by the harness): connect,
 * signTransaction (a real signature over the message) and, with `send`, signAndSendTransaction. `accounts`: the account it already
 * shares with this site (a wallet app's browser), so connectSilently answers without a prompt. `reject`: the person closes the wallet.
 */
function stdWallet(kp, { send = false, name = "Test Wallet", accounts = false, reject = false } = {}) {
  const calls = [];
  const account = { address: kp.address, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: ["solana:signMessage", "solana:signTransaction", ...(send ? ["solana:signAndSendTransaction"] : [])] };
  const w = {
    version: "1.0.0", name, icon: null, chains: ["solana:mainnet"], accounts: accounts ? [account] : [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async (input) => { calls.push(["connect", input || null]); return { accounts: [account] }; } },
      "solana:signMessage": { version: "1.0.0", signMessage: async () => [{ signature: new Uint8Array(64) }] },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async ({ transaction, chain }) => {
        calls.push(["sign", transaction.length, chain]);
        if (reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        const out = new Uint8Array(transaction); out.set(await kp.sign(out.subarray(65)), 1);
        return [{ signedTransaction: out }];
      } },
      ...(send ? { "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async ({ transaction, chain, options }) => {
        calls.push(["signAndSend", transaction.length, chain, options]);
        if (reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return [{ signature: new Uint8Array(64).fill(3) }];
      } } } : {}),
    },
  };
  return { wallet: w, calls };
}
/** The Wallet tab's two answers for a wallet holding SOL, $VICINITY and three city coins (as test/wallet-tab.test.js). */
const PORTFOLIO = { ok: true, portfolio: { asOf: "2026-10-09T14:04:50Z", totalUsd: 12.901, pricesComplete: false, items: [
  { kind: "vicinity", mint: VIC, symbol: "VICINITY", name: "Vicinity", amount: 25000, priceUsd: 0.0004, valueUsd: 10, sharePct: 77.5 },
  { kind: "city", mint: UTICA, symbol: "UTICA", name: "Utica Coin", tickerSource: "chain", city: { id: "5142056", name: "Utica", country: "US" }, amount: 1200.5, priceUsd: 0.002, valueUsd: 2.401, sharePct: 18.6 },
  { kind: "city", mint: ROME, symbol: "Rome Coin", name: "Rome Coin", tickerSource: null, city: { id: "5134295", name: "Rome", country: "US" }, amount: 0.5, priceUsd: 1, valueUsd: 0.5, sharePct: 3.9 },
  { kind: "city", mint: OSWEGO, symbol: "OSWEGO", name: "Oswego Coin", tickerSource: "registry", city: { id: "5129573", name: "Oswego", country: "US" }, amount: 3, priceUsd: null, valueUsd: null, sharePct: null },
] } };
const balancesOf = (owner, over = {}) => ({ ok: true, owner, cluster: "mainnet", at: "2026-10-09T14:05:00Z", sol: { lamports: 2_000_000_000, ui: 2 }, tokens: { [VIC]: { ui: 25000, hasAccount: true }, [UTICA]: { ui: 1200.5, hasAccount: true }, [ROME]: { ui: 0.5, hasAccount: true }, [OSWEGO]: { ui: 3, hasAccount: true } }, ...over });
const SOL_ASSET = { id: SOL_ID, label: "SOL", symbol: "SOL", name: "Solana", decimals: 9 };
/**
 * The page's fake server: the Wallet tab's answers, and the Send routes. The build answer is the Worker's own planner over a 2 SOL
 * wallet (src/walletsend.js planSend, compiled by the Worker's compiler), so the bytes the fake wallet signs are what the Worker would
 * build; `refuse`: a refusal instead; `relay` and `status` are programmable; every call is in `log`.
 */
function pageServer(kp, { refuse = null, relay = null, status = null } = {}) {
  const log = [];
  const S = {
    log, refuse, relayAnswer: relay, statusNow: status || "pending",
    hold: {}, // hold[path] = a promise: that answer waits until the test lets it go (a read or a build still on its way)
    async api(path, body) {
      const base = path.split("?")[0];
      log.push({ path, body });
      if (S.hold[base]) await S.hold[base];
      if (base === "/api/coins") return { ok: true, coin: null, pairs: null, vicinity: VIC };
      if (base === "/api/me/portfolio") return PORTFOLIO;
      if (base === "/api/swap/balances") return balancesOf(kp.address);
      if (base === "/api/prices") return { ok: true, prices: { [SOL_MINT]: 150.25 } };
      if (base === "/api/wallet/send/build") {
        if (S.refuse) return typeof S.refuse === "function" ? S.refuse(body) : S.refuse;
        // TO is a wallet the chain knows; TO2 an address nobody has used (no account)
        const plan = await planSend({ sender: kp.address, to: body.to, asset: SOL_ASSET, amount: body.amount, all: body.all === true, chain: { sender: accountOf(sys(2_000_000_000)), to: body.to === TO2 ? null : accountOf(sys(1_000_000_000)) }, cuPrice: 100_000n });
        if (!plan.ok) { const { status: st, ...rest } = plan; return { ...rest, _status: st }; }
        const tx = wrapUnsigned(compileLegacy({ payer: kp.address, instructions: plan.instructions, blockhash: BLOCKHASH }));
        return { ok: true, tx: toBase64(tx), version: "legacy", bytes: tx.length, blockhash: BLOCKHASH, lastValidBlockHeight: LVBH, chain: "solana:mainnet", cluster: "mainnet", taker: kp.address, simulated: true, ticket: `${Date.now() + 600_000}.AAAAAAAAAAAAAAAAAAAAAA`, amount: plan.summary.amount, amountRaw: plan.summary.amountRaw, fees: { computeUnitLimit: plan.cuLimit, computeUnitPrice: "100000", priorityLamports: 1000, networkLamports: 5000, feeLamports: 6000, rentLamports: 0 }, summary: plan.summary };
      }
      if (base === "/api/wallet/send/relay") return S.relayAnswer || { ok: true, signature: SIGB58, solscan: `https://solscan.io/tx/${SIGB58}`, cluster: "mainnet" };
      if (base === "/api/wallet/send/status") { const sig = new URL("https://x" + path).searchParams.get("sig"); return typeof S.statusNow === "object" ? S.statusNow : { ok: true, signature: sig, solscan: `https://solscan.io/tx/${sig}`, cluster: "mainnet", status: S.statusNow }; }
      return undefined;
    },
  };
  S.calls = (p) => log.filter((c) => c.path === p || c.path.startsWith(p + "?"));
  /** Hold the next answers of `base` until the returned function is called. */
  S.wait = (base) => { let go; S.hold[base] = new Promise((r) => { go = r; }); return () => { delete S.hold[base]; go(); }; };
  return S;
}
const sendMe = (kp, over = {}) => ({ ...memberMe({ wallet: kp.address, launched: true, amount: 25000, rank: 12 }), walletSend: true, ...over });
const type = async (p, e, v) => { e.value = v; e.dispatchEvent(newEvent("input")); await p.flush(); };
/** Real time for the browser's own crypto (the signature the signing module checks runs on a thread): a few short waits, the page flushed after each. */
const settle = async (p) => { for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 5)); await p.flush(); } };
const navigatorOf = (ua, clipboard = {}) => ({ userAgent: ua, maxTouchPoints: /iPhone|Android/.test(ua) ? 5 : 0, clipboard: { writeText: async () => {}, ...clipboard } });
/** Open the dashboard with the switch on, go to the Wallet tab and open the Send sheet. */
async function openSheet({ kp, server, wallets = [], ua = UA.desktop, clipboard = {}, me = null } = {}) {
  const p = await openDashboard({ ua, me: me || sendMe(kp), api: server.api, wallets, globals: { crypto, navigator: navigatorOf(ua, clipboard) } });
  await p.tap(p.$("#tab-wallet"));
  assert.equal(p.$("#wt-send").hidden, false, "the Send button");
  await p.tap(p.$("#wt-send"));
  const sheet = p.$(".wsend-sheet");
  assert.ok(sheet && sheet.hasAttribute("open"), "the sheet is open");
  return { p, sheet, ui: { amt: p.$("#wsend-amt"), to: p.$("#wsend-to"), check: p.$(".wsend__check"), status: p.$(".wsend__form .wsend__status"), review: p.$(".wsend__review"), max: p.$(".wsend__max"), paste: p.$(".wsend__paste"), confirm: p.$(".wsend__confirm"), go: p.$(".wsend__go"), cstatus: p.$(".wsend__confirm .wsend__status"), lines: () => [...p.$$(".wsend__lines li")].map((li) => li.textContent), addr: p.$(".wsend__addr"), notice: p.$(".wsend__notice"), links: p.$(".wsend__links"), back: p.$(".wsend__back"), wallets: p.$(".wsend__wallets") } };
}

test("page, switch off: no Send button, the Send code is never fetched, the Wallet tab is as before; switch on without a wallet: the code loads but the button stays hidden", async () => {
  const kp = await keypair();
  const off = await openDashboard({ me: memberMe({ wallet: kp.address, launched: true, amount: 25000 }), api: pageServer(kp).api, globals: { crypto } });
  await off.tap(off.$("#tab-wallet"));
  assert.equal(off.$("#wt-send"), null); assert.equal(typeof off.win.VWalletSend, "undefined", "nothing new exists");
  assert.equal(off.$(".wsend-sheet"), null);
  const noWallet = await openDashboard({ me: { ...memberMe(), walletSend: true }, api: pageServer(kp).api, globals: { crypto } });
  await noWallet.tap(noWallet.$("#tab-wallet"));
  assert.equal(typeof noWallet.win.VWalletSend, "object", "the switch is on: the code is here");
  assert.equal(noWallet.$("#wt-send").hidden, true, "nothing to send from yet");
});

test("page: the Send button (44 px, in the Balances card next to Buy & swap) opens the sheet with what the wallet holds; the live destination check: short, not an address, your own wallet, then the Worker's verdict after one build; Paste; Max asks the Worker", async () => {
  const kp = await keypair();
  const S = pageServer(kp);
  const { p, ui } = await openSheet({ kp, server: S, clipboard: { readText: async () => TO2 } });
  const btn = p.$("#wt-send");
  assert.equal(btn.textContent, "Send");
  const acts = p.$("#wt-balances .dv2-actions");
  assert.ok(btn.parentNode === acts, "in the Balances card's actions");
  assert.deepEqual(acts.children.map((c) => c.id), ["wt-send", "wt-buy"], "before Buy & swap");
  assert.match(read("public/wallet-send.css"), /\.dv2 \.wsend-open \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(p.text(".wsend__from"), new RegExp(`^From your linked wallet ${kp.address.slice(0, 4)}…${kp.address.slice(-4)}\\.$`));
  // what the wallet holds: the tab's own rows (the ticker rule included), SOL chosen first
  const radios = [...p.$$(".wsend__asset")];
  assert.deepEqual(radios.map((r) => r.querySelector(".wsend__asset-name").textContent), ["SOL", "$VICINITY", "$UTICA", "Rome Coin", "$OSWEGO"]);
  assert.deepEqual(radios.map((r) => r.querySelector(".wsend__asset-amt").textContent), ["2 held", "25,000 held", "1,200.5 held", "0.5 held", "3 held"]);
  assert.deepEqual(radios.map((r) => r.getAttribute("aria-checked")), ["true", "false", "false", "false", "false"]);
  assert.equal(radios[0].getAttribute("role"), "radio");
  assert.equal(S.calls("/api/wallet/send/build").length, 0, "nothing built yet");
  // the destination's live check, free part
  await type(p, ui.to, "7Np4");
  assert.equal(ui.check.textContent, "Keep typing or paste the full address.");
  await type(p, ui.to, "not an address at all, but long enough to be judged");
  assert.equal(ui.check.textContent, "That is not a Solana address."); assert.ok(ui.check.classList.contains("is-bad"));
  await type(p, ui.to, kp.address);
  assert.equal(ui.check.textContent, "That is your own wallet address."); assert.ok(ui.check.classList.contains("is-bad"));
  await type(p, ui.to, TO);
  assert.equal(ui.check.textContent, "Looks like a Solana address. Checking…");
  await p.advance(700);
  assert.equal(S.calls("/api/wallet/send/build").length, 0, "no amount yet: nothing to ask the Worker about");
  // the amount: the Worker is asked once, 600 ms after the last keystroke
  await type(p, ui.amt, "0.");
  await type(p, ui.amt, "0.5");
  await p.advance(300);
  assert.equal(S.calls("/api/wallet/send/build").length, 0, "not yet");
  await p.advance(400);
  const builds = S.calls("/api/wallet/send/build");
  assert.equal(builds.length, 1, "one build for the settled form");
  assert.deepEqual(builds[0].body, { to: TO, asset: "SOL", amount: "0.5" });
  assert.equal(builds[0].path, "/api/wallet/send/build?live=1", "the page's own check is counted apart from the taps on the Worker");
  assert.equal(ui.check.textContent, "A wallet on the Solana chain."); assert.ok(ui.check.classList.contains("is-ok"));
  await p.advance(5000);
  assert.equal(S.calls("/api/wallet/send/build").length, 1, "never twice for the same form");
  // Paste fills the field and checks it; an address the chain has no account for is said plainly, not in green
  await p.tap(ui.paste);
  assert.equal(ui.to.value, TO2);
  assert.equal(ui.check.textContent, "Looks like a Solana address. Checking…");
  await p.advance(700);
  assert.equal(S.calls("/api/wallet/send/build").length, 2);
  assert.equal(S.calls("/api/wallet/send/build")[1].body.to, TO2);
  assert.equal(ui.check.textContent, "An address that has not been used on Solana yet.");
  assert.equal(ui.check.className, "small wsend__check", "neutral: that is how a mistyped address usually looks");
  // Max: the Worker names the most that can go to this destination, and the field takes it (a tap: not a live check)
  await p.tap(ui.max);
  const mx = S.calls("/api/wallet/send/build")[2];
  assert.deepEqual([mx.path, mx.body], ["/api/wallet/send/build", { to: TO2, asset: "SOL", all: true }]);
  assert.equal(ui.amt.value, "1.999994", "2 SOL minus the fee, as the Worker said (nothing computed here)");
  // Review on that: the confirm screen carries the Worker's line about the unused address, word for word
  await p.tap(ui.review);
  assert.equal(S.calls("/api/wallet/send/build").length, 3, "the Max build is fresh and for this very form: no new build");
  assert.equal(ui.confirm.hidden, false);
  const fresh = (await S.api("/api/wallet/send/build", { to: TO2, asset: "SOL", all: true })).summary;
  assert.deepEqual(ui.lines(), fresh.lines);
  assert.deepEqual(ui.lines(), ["Send 1.999994 SOL", "No Vicinity fee. Network fee about 0.000006 SOL.", FRESH_LINE, "You keep no SOL after this send: your wallet is emptied."]);
  assert.equal(ui.addr.textContent, TO2);
  await p.tap(ui.back);
  assert.equal(ui.confirm.hidden, true);
  // ".5" is sent as 0.5 (the Worker wants the leading digit); nothing is spent on a refusal
  await type(p, ui.amt, ".5");
  await p.advance(700);
  assert.deepEqual(S.calls("/api/wallet/send/build").at(-1).body, { to: TO2, asset: "SOL", amount: "0.5" });
  // another asset: the form is a new one (the build on hand goes)
  await p.tap(radios[1]);
  assert.equal(p.$(".wsend__asset[aria-checked='true'] .wsend__asset-name").textContent, "$VICINITY");
  // the page computes no fee, no rent, no maximum: not one of those numbers in its code, and the lines come from the answer alone
  const js = read("public/wallet-send.js");
  assert.doesNotMatch(js, /2039280|890880|5000\b|0\.00204|0\.00089/, "no fee or rent number of its own");
  assert.match(js, /sum\.lines : \[\]\)\.map\(\(t\) => el\("li", null, String\(t\)\)\)/, "the summary's lines, word for word");
  assert.doesNotMatch(js, /innerHTML/);
  assert.doesNotMatch(read("public/wallet-send.css"), /animation|transition/, "nothing moves on its own");
});

test("page: Review shows the Worker's summary word for word, the full address with its ends emphasised and the one sentence; the linked wallet signs, the relay sends with the ticket, the status is watched, a Solscan link, and the balances are read again from the chain", async () => {
  const kp = await keypair();
  const S = pageServer(kp), w = stdWallet(kp);
  const { p, ui } = await openSheet({ kp, server: S, wallets: [w.wallet] });
  await type(p, ui.to, TO); await type(p, ui.amt, "0.5");
  await p.tap(ui.review);
  assert.equal(S.calls("/api/wallet/send/build").length, 1, "Review builds (the live check had not run yet)");
  assert.equal(ui.confirm.hidden, false); assert.equal(p.$(".wsend__form").hidden, true);
  const summary = (await S.api("/api/wallet/send/build", { to: TO, asset: "SOL", amount: "0.5" })).summary;
  assert.deepEqual(ui.lines(), summary.lines, "the Worker's lines, verbatim");
  assert.deepEqual(ui.lines(), ["Send 0.5 SOL", "No Vicinity fee. Network fee about 0.000006 SOL.", "You keep 1.499994 SOL after this send."]);
  assert.equal(ui.addr.textContent, TO, "the full address");
  assert.deepEqual([...ui.addr.querySelectorAll("b")].map((b) => b.textContent), [TO.slice(0, 4), TO.slice(-4)], "its first and last four characters emphasised");
  assert.equal(ui.notice.textContent, "A send cannot be undone. Check the address.");
  // the wallet: the one linked to the account, chosen here (no wallet app, no Buy panel connection)
  const opts = [...p.$$(".wsend__wallets .wallet-option")];
  assert.equal(opts.length, 1); assert.equal(opts[0].textContent, "TTest WalletSigns", "the wallet's mark, its name, what it does (signs; the relay sends)");
  assert.equal(ui.go.disabled, true, "Send waits for the wallet");
  assert.match(p.text(".wsend__wallets"), new RegExp(`Connect the wallet linked to this account \\(${kp.address.slice(0, 4)}…${kp.address.slice(-4)}\\) to sign:`));
  await p.tap(opts[0]);
  await p.advance(100);
  assert.equal(typeof p.win.LP, "object", "the signing module (public/lp-sign.js) was fetched when it was needed");
  assert.equal(ui.cstatus.textContent, `Connected ${kp.address.slice(0, 4)}…${kp.address.slice(-4)}. Tap Send: your wallet asks you to confirm.`);
  assert.equal(ui.go.disabled, false); assert.equal(ui.go.textContent, "Send");
  assert.equal(w.calls.filter((c) => c[0] === "sign").length, 0, "nothing signed before the tap");
  // the tap: the wallet signs inside it; this wallet only signs, so the site's relay sends, with the build's ticket and last valid block
  await p.tap(ui.go);
  assert.equal(w.calls.filter((c) => c[0] === "sign").length, 1, "the wallet was asked inside the tap");
  await settle(p); // the signature check and the relay's answer
  const signs = w.calls.filter((c) => c[0] === "sign");
  assert.equal(signs.length, 1); assert.equal(signs[0][2], "solana:mainnet");
  const relays = S.calls("/api/wallet/send/relay");
  assert.equal(relays.length, 1, "the relay, not the swap's path");
  assert.deepEqual(Object.keys(relays[0].body), ["tx", "ticket", "lastValidBlockHeight", "cluster"]);
  assert.deepEqual([relays[0].body.lastValidBlockHeight, relays[0].body.cluster], [LVBH, "mainnet"]);
  assert.match(relays[0].body.ticket, /^\d+\.A{22}$/, "the build's ticket");
  const built = fromBase64((await S.api("/api/wallet/send/build", { to: TO, asset: "SOL", amount: "0.5" })).tx), sent = fromBase64(relays[0].body.tx);
  assert.deepEqual([...sent.subarray(65)], [...built.subarray(65)], "the message the Worker built, byte for byte; only the signature slot was filled");
  assert.ok(sent.subarray(1, 65).some((x) => x !== 0), "signed");
  assert.equal(S.calls("/api/swap/send").length, 0);
  assert.equal(ui.cstatus.textContent, "Sent. Waiting for the network to confirm…");
  assert.equal(ui.go.textContent, "Confirming…"); assert.equal(ui.go.disabled, true); assert.equal(ui.back.hidden, true);
  const link = ui.links.querySelector("a");
  assert.equal(link.getAttribute("href"), `https://solscan.io/tx/${SIGB58}`); assert.equal(link.textContent, "View on Solscan ↗");
  // while the network is being asked the sheet stays: the ✕, a tap outside the card and Escape (the dialog's cancel) wait, so the outcome is seen here
  const sheet = p.$(".wsend-sheet");
  await p.tap(p.$(".wsend-sheet .swap-sheet__close"));
  assert.ok(sheet.hasAttribute("open"), "✕ waits");
  sheet.dispatchEvent(newEvent("click")); await p.flush();
  assert.ok(sheet.hasAttribute("open"), "a tap outside waits");
  const esc = newEvent("cancel"); sheet.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented, true, "Escape waits");
  assert.equal(ui.go.textContent, "Confirming…");
  // the status poll every 2 s on the Send status path; confirmed: the balances are read again, straight from the chain
  const bal0 = p.callsTo("/api/swap/balances").length;
  await p.advance(2000);
  const polls = S.calls("/api/wallet/send/status");
  assert.equal(polls.length, 1);
  assert.equal(polls[0].path, `/api/wallet/send/status?sig=${SIGB58}&lvbh=${LVBH}&cluster=mainnet`);
  S.statusNow = "confirmed";
  await p.advance(2000);
  assert.equal(S.calls("/api/wallet/send/status").length, 2);
  assert.match(ui.cstatus.textContent, /^Confirmed ✓ Sent\./); assert.ok(ui.cstatus.classList.contains("is-ok"));
  assert.equal(ui.go.textContent, "Done"); assert.equal(ui.go.disabled, false); assert.equal(ui.back.textContent, "Send more");
  const bal = p.callsTo("/api/swap/balances");
  assert.equal(bal.length, bal0 + 1, "one read after the send");
  assert.equal(new URL(bal[bal.length - 1].path, "https://vicinity.test").searchParams.get("fresh"), "1", "straight from the chain, past the Worker's memo");
  assert.equal(ui.cstatus.textContent, "Confirmed ✓ Sent. Your balances show the chain as it is now.");
  assert.match(p.text("#wt-read-text"), /^Balances read from the Solana chain at /, "the Wallet tab's line: the chain's time");
  await p.advance(10_000);
  assert.equal(S.calls("/api/wallet/send/status").length, 2, "no more polls after the answer");
  const esc2 = newEvent("cancel"); sheet.dispatchEvent(esc2);
  assert.equal(esc2.defaultPrevented, false, "done: Escape closes again");
  // Done closes the sheet; opening it again starts clean
  await p.tap(ui.go);
  assert.equal(p.$(".wsend-sheet").hasAttribute("open"), false);
  await p.tap(p.$("#wt-send"));
  assert.equal(p.$("#wsend-amt").value, ""); assert.equal(p.$("#wsend-to").value, ""); assert.equal(p.$(".wsend__confirm").hidden, true);
});

test("page: a wallet that sends itself signs and sends in the tap (no relay); the Buy panel's connected wallet is reused; a cancel in the wallet keeps the details and offers Send again; a failure on the chain is said with its link", async () => {
  const kp = await keypair();
  const S = pageServer(kp), w = stdWallet(kp, { send: true, name: "Phantom" });
  const { p, ui } = await openSheet({ kp, server: S, wallets: [w.wallet] });
  await type(p, ui.to, TO); await type(p, ui.amt, "0.25");
  await p.tap(ui.review);
  await p.tap(p.$(".wsend__wallets .wallet-option"));
  await p.advance(100);
  assert.equal(ui.go.disabled, false);
  await p.tap(ui.go);
  const sends = w.calls.filter((c) => c[0] === "signAndSend");
  assert.equal(sends.length, 1, "inside the tap");
  await p.advance(100);
  assert.deepEqual(JSON.parse(JSON.stringify(sends[0].slice(2))), ["solana:mainnet", { preflightCommitment: "confirmed", maxRetries: 3 }]);
  assert.equal(S.calls("/api/wallet/send/relay").length, 0, "the wallet broadcast it itself");
  assert.equal(ui.cstatus.textContent, "Sent. Waiting for the network to confirm…");
  S.statusNow = { ok: true, signature: SIGB58, status: "failed", err: "program_error", name: "1", solscan: `https://solscan.io/tx/${SIGB58}` };
  await p.advance(2000);
  assert.equal(ui.cstatus.textContent, "The transaction failed on the blockchain."); assert.ok(ui.cstatus.classList.contains("is-bad"));
  assert.equal(ui.go.hidden, true, "not offered again from this build: the chain has it");
  assert.equal(ui.links.querySelector("a").getAttribute("href"), `https://solscan.io/tx/${SIGB58}`);
  // a cancel in the wallet: nothing was sent, the same details can be sent again
  const kp2 = await keypair();
  const S2 = pageServer(kp2), w2 = stdWallet(kp2, { reject: true });
  const { p: p2, ui: u2 } = await openSheet({ kp: kp2, server: S2, wallets: [w2.wallet] });
  await type(p2, u2.to, TO); await type(p2, u2.amt, "0.25");
  await p2.tap(u2.review);
  await p2.tap(p2.$(".wsend__wallets .wallet-option"));
  await p2.advance(100);
  await p2.tap(u2.go);
  await p2.advance(100);
  assert.equal(u2.cstatus.textContent, "You cancelled in your wallet. Nothing was sent.");
  assert.equal(u2.go.hidden, false); assert.equal(u2.go.disabled, false, "Send again, from the same details (prepared again, the words left alone)");
  assert.deepEqual(u2.lines(), ["Send 0.25 SOL", "No Vicinity fee. Network fee about 0.000006 SOL.", "You keep 1.749994 SOL after this send."]);
  assert.equal(S2.calls("/api/wallet/send/relay").length, 0);
  // the Buy panel's connected wallet, when it is the linked one, signs without a second connection
  const kp3 = await keypair();
  const S3 = pageServer(kp3), w3 = stdWallet(kp3, { send: true });
  const p3 = await openDashboard({ me: sendMe(kp3), api: S3.api, wallets: [w3.wallet], globals: { crypto, navigator: navigatorOf(UA.desktop) } });
  const adapter = p3.win.VW.list()[0]; await adapter.connect();
  p3.win.VSwap = { wallet: { adapter, address: kp3.address } };
  await p3.tap(p3.$("#tab-wallet")); await p3.tap(p3.$("#wt-send"));
  await type(p3, p3.$("#wsend-to"), TO); await type(p3, p3.$("#wsend-amt"), "0.25");
  await p3.tap(p3.$(".wsend__review"));
  await p3.advance(100);
  assert.equal(p3.$$(".wsend__wallets .wallet-option").length, 0, "no chooser");
  assert.equal(p3.$(".wsend__go").disabled, false);
  assert.equal(w3.calls.filter((c) => c[0] === "connect").length, 1, "the one connection the Buy panel made");
});

test("page: the Worker's refusals are shown in its own words, under the destination for a destination problem and under the amount otherwise; a 429 stops the live checks for a minute; the confirm screen is never reached", async () => {
  const kp = await keypair();
  const S = pageServer(kp);
  const { p, ui } = await openSheet({ kp, server: S });
  await type(p, ui.to, TO); await type(p, ui.amt, "1.9995");
  await p.advance(700);
  assert.equal(ui.status.textContent, "This would leave 0.000494 SOL in your wallet, less than the 0.00089088 SOL the network needs to keep an account open. The most you can send and keep your wallet open is 1.99910312 SOL; Max sends everything.");
  assert.ok(ui.status.classList.contains("is-bad"));
  assert.equal(ui.check.textContent, "Looks like a Solana address. Checking…", "the destination line is not about the amount");
  await p.tap(ui.review);
  assert.equal(ui.confirm.hidden, true); assert.equal(S.calls("/api/wallet/send/build").length, 2, "Review asked again (a refusal is not kept)");
  S.refuse = { ok: false, error: "not_a_wallet", reason: "token_account", message: "This is a token account, not a wallet. Send to its owner's wallet address instead.", _status: 409 };
  await type(p, ui.amt, "0.5");
  await p.advance(700);
  assert.equal(ui.check.textContent, "This is a token account, not a wallet. Send to its owner's wallet address instead."); assert.ok(ui.check.classList.contains("is-bad"));
  assert.equal(ui.status.textContent, "");
  // a 429 on a live check: the live checks rest for a minute, said quietly (Review still works, on its own counter); a 429 on a tap says how long its window is (Retry-After)
  S.refuse = { ok: false, error: "slow_down", _status: 429, _headers: { "retry-after": "3600" } };
  await type(p, ui.amt, "0.6");
  await p.advance(700);
  assert.equal(ui.status.textContent, "Live checks are paused for a minute. Tap Review when you are ready.");
  assert.equal(ui.status.className, "small wsend__status", "not an error");
  const n = S.calls("/api/wallet/send/build").length;
  await type(p, ui.amt, "0.7");
  await p.advance(700);
  assert.equal(S.calls("/api/wallet/send/build").length, n, "no live check for a minute after a 429");
  await p.tap(ui.review);
  assert.equal(S.calls("/api/wallet/send/build").length, n + 1, "Review asks (a tap, its own counter)");
  assert.equal(ui.status.textContent, "Too many checks this hour. Try again in up to 60 minutes.", "the hour, not a minute: Retry-After 3600");
  assert.ok(ui.status.classList.contains("is-bad"));
  S.refuse = { ok: false, error: "slow_down", _status: 429, _headers: { "retry-after": "60" } };
  await p.tap(ui.review);
  assert.equal(ui.status.textContent, "Too many tries in a short time. Wait a minute and try again.");
  S.refuse = null;
  await p.advance(60_000);
  await type(p, ui.amt, "0.8");
  await p.advance(700);
  assert.equal(S.calls("/api/wallet/send/build").length, n + 3, "the live check is back");
  // no answer from the site at all (Review on a form whose live check has not run yet asks the Worker itself)
  S.refuse = () => ({ ok: false, error: "offline", _status: 0 });
  await type(p, ui.amt, "0.9");
  await p.tap(ui.review);
  assert.equal(ui.status.textContent, "You seem to be offline. Nothing was sent.");
  assert.equal(ui.confirm.hidden, true);
});

test("page: a phone's Safari (no wallet on the page) sends inside the wallet app, offered as app links on the confirm screen; inside a wallet app the account it shares is connected without a prompt", async () => {
  const kp = await keypair();
  const S = pageServer(kp);
  const { p, ui } = await openSheet({ kp, server: S, ua: UA.iphone });
  await type(p, ui.to, TO); await type(p, ui.amt, "0.25");
  await p.tap(ui.review);
  assert.equal(ui.confirm.hidden, false);
  assert.equal(ui.go.hidden, true, "nothing to sign with here");
  assert.equal(p.text(".wsend__lead"), "Sending happens in your wallet app. Open Vicinity there and send from its Wallet tab:");
  const links = [...p.$$(".wsend__wallets a.wallet-option")];
  assert.deepEqual(links.map((a) => a.dataset.app), ["phantom", "solflare", "backpack"]);
  const next = encodeURIComponent("/dashboard#wallet");
  assert.equal(links[0].getAttribute("href"), p.win.VW.KNOWN.find((k) => k.id === "phantom").open(`https://vicinity.test/connect?mode=login&with=phantom&next=${next}`), "this page, inside Phantom, signed in there");
  assert.equal(links[1].getAttribute("href"), p.win.VW.KNOWN.find((k) => k.id === "solflare").open(`https://vicinity.test/connect?mode=login&with=solflare&next=${next}`));
  // inside Phantom's browser: the one wallet already shares its account with this site: connected without a tap
  const kp2 = await keypair();
  const S2 = pageServer(kp2), w2 = stdWallet(kp2, { send: true, name: "Phantom", accounts: true });
  const { p: p2, ui: u2 } = await openSheet({ kp: kp2, server: S2, wallets: [w2.wallet], ua: UA.phantomApp });
  await type(p2, u2.to, TO); await type(p2, u2.amt, "0.25");
  await p2.tap(u2.review);
  await p2.advance(100);
  assert.equal(w2.calls.filter((c) => c[0] === "connect").length, 0, "never a prompt: the account it already shares");
  assert.equal(p2.$$(".wsend__wallets .wallet-option").length, 0);
  assert.equal(u2.go.disabled, false);
  assert.match(u2.cstatus.textContent, /^Connected /);
  // a different wallet inside the app: the chooser, and a connection that is not the linked wallet is refused
  const other = await keypair();
  const S3 = pageServer(kp2), w3 = stdWallet(other, { send: true, name: "Phantom", accounts: true });
  const { p: p3, ui: u3 } = await openSheet({ kp: kp2, server: S3, wallets: [w3.wallet], ua: UA.phantomApp });
  await type(p3, u3.to, TO); await type(p3, u3.amt, "0.25");
  await p3.tap(u3.review);
  await p3.advance(100);
  const opt = p3.$(".wsend__wallets .wallet-option");
  assert.ok(opt, "the shared account is another wallet: the person is asked");
  await p3.tap(opt);
  await p3.advance(50);
  assert.match(u3.cstatus.textContent, new RegExp(`^That is a different wallet \\(${other.address.slice(0, 4)}…${other.address.slice(-4)}\\)\\. Use the one linked to your account, ${kp2.address.slice(0, 4)}…${kp2.address.slice(-4)}: switch accounts in your wallet and try again\\.$`));
  assert.equal(u3.go.disabled, true);
});

test("page: an answer for a form that changed on the way is dropped (nothing is kept for the old amount); Back during the confirm screen's refresh frees the form; a read already running when the send confirms is waited for and the chain asked again", async () => {
  const kp = await keypair();
  const S = pageServer(kp), w = stdWallet(kp);
  const { p, ui } = await openSheet({ kp, server: S, wallets: [w.wallet] });
  await type(p, ui.to, TO); await type(p, ui.amt, "0.5");
  let go = S.wait("/api/wallet/send/build");
  await p.advance(700);
  assert.equal(S.calls("/api/wallet/send/build").length, 1, "the live check is on its way");
  await type(p, ui.amt, "0."); // the form is incomplete now: nothing new is asked, and the old answer must not be kept
  go(); await p.flush();
  assert.equal(ui.check.textContent, "Looks like a Solana address. Checking…", "no verdict for a form that is gone");
  assert.equal(ui.review.disabled, false); assert.equal(ui.review.textContent, "Review");
  await p.tap(ui.review);
  assert.equal(ui.status.textContent, "Type an amount above zero, with a point for decimals (like 0.5).");
  assert.equal(ui.confirm.hidden, true, "the old amount's build was not kept");
  // Review, the wallet, then a stale build (30 s) is made again on Send; Back meanwhile frees the form (Max works at once)
  await type(p, ui.amt, "0.5");
  await p.tap(ui.review);
  await p.tap(p.$(".wsend__wallets .wallet-option"));
  await p.advance(100);
  assert.equal(ui.go.disabled, false);
  await p.advance(31_000);
  const before = S.calls("/api/wallet/send/build").length;
  go = S.wait("/api/wallet/send/build");
  await p.tap(ui.go);
  assert.equal(S.calls("/api/wallet/send/build").length, before + 1, "the details are built again before the wallet opens");
  assert.equal(S.calls("/api/wallet/send/build").at(-1).path, "/api/wallet/send/build", "a tap, not a live check");
  assert.equal(ui.cstatus.textContent, "Checking the details again (they are kept fresh for half a minute)…");
  assert.equal(w.calls.filter((c) => c[0] === "sign").length, 0, "the wallet stays shut");
  await p.tap(ui.back);
  assert.equal(ui.confirm.hidden, true);
  go(); await p.flush();
  assert.equal(ui.confirm.hidden, true, "the refreshed build does not pull the confirm screen back");
  await p.tap(ui.max);
  assert.deepEqual(S.calls("/api/wallet/send/build").at(-1).body, { to: TO, asset: "SOL", all: true }, "Max works: the form is not stuck busy");
  assert.equal(ui.amt.value, "1.999994");
  // a send that confirms while the tab is already reading its balances: that read may carry the old numbers, so it is waited for and the chain asked again (fresh=1)
  await type(p, ui.amt, "0.5");
  await p.tap(ui.review);
  await p.advance(100);
  assert.equal(p.$$(".wsend__wallets .wallet-option").length, 0, "the wallet connected a moment ago is kept: no chooser");
  assert.equal(ui.go.disabled, false);
  await p.advance(10_000); // the tab's Refresh rests 10 s after a read
  const hold = S.wait("/api/swap/balances");
  const bal0 = p.callsTo("/api/swap/balances").length;
  await p.tap(p.$("#wt-refresh"));
  assert.equal(p.callsTo("/api/swap/balances").length, bal0 + 1, "a read is running");
  await p.tap(ui.go);
  await settle(p);
  assert.equal(ui.go.textContent, "Confirming…");
  S.statusNow = "confirmed";
  await p.advance(2000);
  assert.equal(ui.cstatus.textContent, "Confirmed ✓ Sent. Reading your balances again…", "waiting for the read that is running");
  assert.equal(p.callsTo("/api/swap/balances").length, bal0 + 1, "no second read yet");
  hold(); await settle(p);
  const bal = p.callsTo("/api/swap/balances");
  assert.equal(bal.length, bal0 + 2, "then the chain is asked again");
  assert.equal(new URL(bal[bal.length - 2].path, "https://vicinity.test").searchParams.get("fresh"), null, "the tab's own read");
  assert.equal(new URL(bal[bal.length - 1].path, "https://vicinity.test").searchParams.get("fresh"), "1", "the one after the send, past the Worker's memo");
  assert.equal(ui.cstatus.textContent, "Confirmed ✓ Sent. Your balances show the chain as it is now.");
});

test("page: the asset list is drawn again only when something changed (the keyboard stays on its radio through the minute's /api/me), and the arrow keys move through it", async () => {
  const kp = await keypair();
  const S = pageServer(kp);
  const { p } = await openSheet({ kp, server: S });
  await p.advance(100); // the sheet puts the keyboard on the amount field as it opens
  const radios = [...p.$$(".wsend__asset")];
  radios[1].focus();
  assert.equal(p.doc.activeElement === radios[1], true);
  const me0 = p.callsTo("/api/me").length;
  await p.advance(60_000);
  assert.ok(p.callsTo("/api/me").length > me0, "the dashboard asked /api/me again");
  assert.equal(p.$$(".wsend__asset")[1] === radios[1], true, "the same element: nothing was redrawn");
  assert.equal(p.doc.activeElement === radios[1], true, "the keyboard stayed");
  // ArrowDown chooses the next one and takes the keyboard there; ArrowUp back; the ends wrap
  const down = newEvent("keydown", { key: "ArrowDown" }); radios[1].dispatchEvent(down); await p.flush();
  assert.equal(down.defaultPrevented, true);
  assert.equal(p.$(".wsend__asset[aria-checked='true'] .wsend__asset-name").textContent, "$UTICA");
  assert.equal(p.doc.activeElement.dataset.asset, UTICA);
  p.doc.activeElement.dispatchEvent(newEvent("keydown", { key: "ArrowUp" })); await p.flush();
  assert.equal(p.$(".wsend__asset[aria-checked='true'] .wsend__asset-name").textContent, "$VICINITY");
  p.doc.activeElement.dispatchEvent(newEvent("keydown", { key: "ArrowUp" })); await p.flush();
  p.doc.activeElement.dispatchEvent(newEvent("keydown", { key: "ArrowUp" })); await p.flush();
  assert.equal(p.$(".wsend__asset[aria-checked='true'] .wsend__asset-name").textContent, "$OSWEGO", "wrapped to the last");
  assert.equal(S.calls("/api/wallet/send/build").length, 0, "choosing asks the Worker nothing without an amount and a destination");
});
