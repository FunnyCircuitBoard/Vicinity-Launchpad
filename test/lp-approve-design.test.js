// The owner approves exactly the coin design he saw, and that design is what launches (security review SEC-1, SEC-2, SEC-3, SEC-4,
// SEC-6 of the city-coins mainnet branch): the City coins card sends the name, ticker, founder and design time it showed, and the
// Worker builds nothing when any changed; the approval's own arguments are read back from the instruction bytes into the list the
// page shows; from the build on (a 5-minute hold, then the Approval record on chain) the founder cannot change the design; when
// the coin is recorded the design's name and pair become the chain's, and moderation can still drop the description from the
// coin's /coin-meta JSON; an approval whose wallet lost the founder seat is flagged; unknown mints never cost a program-wide
// lookup; and the bytes handed to the wallet are the bytes simulated.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, advance, browser, newWorld, person, realClock, useClock, chain } from "./helpers/world.js";
import { _resetLpKit, GENESIS } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins, DESIGN_HOLD_MS } from "../src/lpcoins.js";
import { base58Decode, base58Encode } from "../src/solana.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { decodeHeader } from "../src/sol/message.js";
import { LAYOUT } from "../src/sol/layout.js";
import { ADDRESSES, PROGRAM_IDS, launchpad as launchpadPdas, programDataAddress } from "../src/sol/pda.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { EXPECTED_POOL_CONFIG } from "../src/sol/dbc-config-data.js";

const PROGRAM = "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", REWARDS = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
const LOADER = PROGRAM_IDS.upgradeableLoader, WSOL = ADDRESSES.wsol, METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const UTICA = "5142056";
const b64 = (u8) => Buffer.from(u8).toString("base64");
let n = 0;
const fresh = () => base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (++n * 37 + j * 11 + 5) & 255));
const CONFIG = fresh();
const enc = new TextEncoder();
const s32 = (s) => concat([u32le(enc.encode(s).length), enc.encode(s)]);

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
const programAccount = (pd) => ({ owner: LOADER, executable: true, data: b64(concat([u32le(2), base58Decode(pd)])) });
const programDataAccount = (authority) => ({ owner: LOADER, data: b64(concat([u32le(3), u64le(1234), Uint8Array.of(1), base58Decode(authority), new Uint8Array(64).fill(7)])) });
function approvalAccount({ cityId, founder, rentPayer, name, symbol, expiresAt }) {
  const body = concat([Uint8Array.of(233, 9, 153, 49, 11, 222, 59, 130), u64le(cityId), base58Decode(founder), base58Decode(CONFIG), base58Decode(rentPayer), s32(name), s32(symbol), u64le(1), u64le(expiresAt), Uint8Array.of(254)]);
  const out = new Uint8Array(179); out.set(body);
  return { owner: PROGRAM, data: b64(out) };
}
const metadataAccount = (mint, name, symbol, uri) => ({ owner: METAPLEX, data: b64(concat([Uint8Array.of(4), new Uint8Array(32), base58Decode(mint), s32(name), s32(symbol), s32(uri), Uint8Array.of(0, 0, 0, 0, 0)])) });

/** The launchpad's RPC: accounts by address, getProgramAccounts with filters, a simulation; every call logged. */
function fakeChain(accounts = {}) {
  const S = { accounts: { ...accounts }, log: [], down: false };
  const acc = (k, slice) => {
    const a = S.accounts[k];
    if (!a) return null;
    let data = Buffer.from(a.data, "base64");
    if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
    return { owner: a.owner, lamports: a.lamports ?? 2_000_000, data: [data.toString("base64"), "base64"], executable: Boolean(a.executable), rentEpoch: 0 };
  };
  const one = ({ method, params }) => {
    if (S.down && method !== "getGenesisHash") throw new Error("down");
    switch (method) {
      case "getGenesisHash": return GENESIS.devnet;
      case "getLatestBlockhash": return { context: { slot: 1 }, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } };
      case "getAccountInfo": return { context: { slot: 1 }, value: acc(params[0], params[1] && params[1].dataSlice) };
      case "getMultipleAccounts": return { context: { slot: 1 }, value: params[0].map((k) => acc(k, params[1] && params[1].dataSlice)) };
      case "getProgramAccounts": {
        const [program, cfg] = params;
        return Object.entries(S.accounts).filter(([, a]) => a.owner === program).filter(([, a]) => {
          const d = Buffer.from(a.data, "base64");
          return (cfg.filters || []).every((f) => (f.dataSize != null ? d.length === f.dataSize : Buffer.from(base58Decode(f.memcmp.bytes)).equals(d.subarray(f.memcmp.offset, f.memcmp.offset + 32))));
        }).map(([k]) => ({ pubkey: k, account: acc(k) }));
      }
      case "getSignaturesForAddress": return [];
      case "simulateTransaction": return { context: { slot: 1 }, value: { err: null, logs: ["Program log: ok"], unitsConsumed: 30_000, accounts: (params[1].accounts ? params[1].accounts.addresses : []).map(() => ({ lamports: 1_995_000, owner: PROGRAM_IDS.system, data: ["", "base64"] })) } };
      default: throw new Error("unexpected " + method);
    }
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    S.log.push({ method: body.method, params: body.params });
    try { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: one(body) })); }
    catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: String(e.message) } })); }
  };
  return { S, fetchImpl, count: (m, at) => S.log.filter((l) => l.method === m && (at === undefined || l.params[0] === at)).length };
}

const LP_ON = { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/devnet", LAUNCHPAD_DBC_CONFIGS: CONFIG };
const design = (over = {}) => ({ name: "Utica Coin", pitch: "The Handshake City, on the map.", pair: "SOL", color: "emerald", ...over });
const seenOf = (c) => ({ cityId: c.cityId, name: c.name, symbol: c.symbol, founder: c.founder, designAt: c.designAt });

/** The owner (ADMIN_WALLETS) with a started launchpad and the SOL curve allowed; Utica's active founder holding the bar. */
async function world() {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld({ VICINITY_MINT: MINT }), ...LP_ON };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const L = launchpadPdas(PROGRAM);
  const [pdLp, pdRw] = await Promise.all([programDataAddress(PROGRAM), programDataAddress(REWARDS)]);
  const lp = fakeChain({
    [PROGRAM]: programAccount(pdLp), [REWARDS]: programAccount(pdRw), [pdLp]: programDataAccount(owner.w.address), [pdRw]: programDataAccount(owner.w.address),
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: owner.w.address, rewards_program: REWARDS })) },
    [await L.launchConfig(CONFIG)]: { owner: PROGRAM, data: b64(layoutAccount("LaunchConfig", { dbc_config: CONFIG, quote_mint: WSOL, enabled: 1 })) },
    [CONFIG]: { owner: PROGRAM_IDS.dbc, data: EXPECTED_POOL_CONFIG },
  });
  const main = chain();
  const both = (url, init) => (String(url).startsWith("https://lp-rpc.test") ? lp.fetchImpl(url, init) : main(url, init));
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)").bind(UTICA, u.id, u.wallet, at, at).run();
  const post = async (who, path, body) => { const r = await who.send(path, { method: "POST", body, fetchImpl: both }); return { status: r.status, ...(await r.json()) }; };
  const get = async (who, path) => (await who.send(path, { fetchImpl: both })).json();
  const card = async () => (await get(owner, "/api/admin/lp/candidates?cluster=devnet")).candidates.find((c) => c.cityId === UTICA);
  return { env, owner, f, lp, both, post, get, card, L };
}

beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); realClock(); });

test("SEC-1: a design changed after the card loaded is refused (nothing built); the built approval shows its name, ticker, founder and expiry from its own bytes", async () => {
  const w = await world();
  assert.equal((await w.post(w.f, "/api/coins/design", design())).ok, true);
  const before = await w.card();
  assert.deepEqual([before.ok, before.name, before.symbol, before.pitch, before.logo], [true, "Utica Coin", "UTICA", "The Handshake City, on the map.", false]);
  assert.ok(before.designAt);
  // the founder renames the coin while the card is on screen
  advance(5000);
  const r1 = await w.post(w.f, "/api/coins/design", design({ name: "Vicinity Official Airdrop" }));
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const stale = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(before), expiryDays: 7 });
  assert.deepEqual([stale.status, stale.error], [409, "design_changed"]);
  assert.match(stale.message, /changed since the page showed it to you.*Nothing was built.*Reload the page/);
  assert.equal(w.lp.count("simulateTransaction"), 0, "nothing built");
  // a pitch-only or logo-only change counts too (the description goes into the coin's public JSON for ever)
  const renamed = await w.card();
  advance(5000);
  assert.equal((await w.post(w.f, "/api/coins/design", design({ name: "Vicinity Official Airdrop", pitch: "Guaranteed 100x" }))).ok, true);
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(renamed) })).error, "design_changed");
  // reloaded: the owner now sees the new name and approves exactly that; the list the page shows carries it
  const now = await w.card();
  assert.equal(now.name, "Vicinity Official Airdrop");
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(now), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  const ix = b.summary.find((x) => x.ix === "approve_launch");
  assert.deepEqual(ix.fields, { cityId: UTICA, founder: w.f.w.address, name: "Vicinity Official Airdrop", symbol: "UTICA", expiresAt: "2026-10-27T12:00:10.000Z" });
  const shown = JSON.stringify(b.summary);
  assert.ok(shown.includes("Vicinity Official Airdrop") && shown.includes(w.f.w.address) && shown.includes("$UTICA"), "name, ticker and founder are in what the page renders");
  // the instruction's bytes are the ones decoded
  const d = decodeHeader(Buffer.from(b.tx, "base64"));
  assert.ok(Buffer.from(d.instructions[d.instructions.length - 1].data).includes(Buffer.from("Vicinity Official Airdrop")));
  realClock();
});

test("SEC-2: from the approval's build on, the founder cannot change the design; the recorded coin takes the chain's name and pair; the description can be taken down from /coin-meta", async () => {
  const w = await world();
  assert.equal((await w.post(w.f, "/api/coins/design", design())).ok, true);
  const c = await w.card();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c) });
  assert.equal(b.ok, true, JSON.stringify(b));
  // built, not yet on chain: held for 5 minutes (the transaction's blockhash is dead long before)
  const held = await w.post(w.f, "/api/coins/design", design({ name: "Utica Moon Rocket" }));
  assert.deepEqual([held.status, held.error], [409, "coin_being_approved"]);
  // landed: the Approval record on chain keeps it fixed after the hold
  const ap = await w.L.approval(BigInt(UTICA));
  w.lp.S.accounts[ap] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: "Utica Coin", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
  advance(DESIGN_HOLD_MS + 1000);
  for (const change of [{ name: "Utica Moon Rocket" }, { pair: "USDC" }, { pitch: "Guaranteed 100x airdrop for early holders" }]) {
    const r = await w.post(w.f, "/api/coins/design", design(change));
    assert.deepEqual([r.status, r.error], [409, "coin_approved"], JSON.stringify(change));
  }
  // the chain cannot be read: refused, never let through
  w.lp.S.down = true;
  const down = await w.post(w.f, "/api/coins/design", design({ name: "Utica Moon Rocket" }));
  assert.deepEqual([down.status, down.error], [503, "chain_unavailable"]);
  w.lp.S.down = false;
  // a design row that disagrees with the chain anyway (written before this rule): recording the coin puts the chain's name and pair in
  await w.env.DB.prepare("UPDATE city_coins SET name = 'Utica Moon Rocket', pair = 'USDC' WHERE city_id = ?").bind(UTICA).run();
  const mint = fresh();
  w.lp.S.accounts[await w.L.coin(BigInt(UTICA))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: UTICA, founder: w.f.w.address, mint, quote_mint: WSOL, dbc_config: CONFIG, dbc_pool: fresh() })) };
  w.lp.S.accounts[await metadataAddress(mint)] = metadataAccount(mint, "Utica Coin", "UTICA", `https://vicinity.city/coin-meta/${mint}.json`);
  delete w.lp.S.accounts[ap];
  assert.equal((await w.post(w.f, "/api/coins/design", design())).error, "coin_locked", "launched on chain (not recorded yet): locked");
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const cc = await w.env.DB.prepare("SELECT name, pair, mint FROM city_coins WHERE city_id = ?").bind(UTICA).first();
  assert.deepEqual([cc.name, cc.pair, cc.mint], ["Utica Coin", "SOL", mint]);
  const pub = await browser(w.env).get(`/api/coins?city=${UTICA}`);
  assert.deepEqual([pub.coin.name, pub.coin.pair, pub.coin.pairMint], ["Utica Coin", "SOL", WSOL]);
  const lc = await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first();
  assert.equal(JSON.parse(lc.meta_json).description, "The Handshake City, on the map. Launched on Vicinity (https://vicinity.city) on Solana.", "the description the owner saw on the card");
  // moderation after the launch: the description goes, from the site and from the coin's /coin-meta JSON (the name is on chain)
  const t = await w.post(w.owner, "/api/coins/takedown", { city: UTICA, what: "text", reason: "abuse", note: "misleading promise" });
  assert.equal(t.ok, true, JSON.stringify(t));
  const after = await w.env.DB.prepare("SELECT c.name, c.pitch, l.meta_json FROM city_coins c JOIN lp_coins l ON l.mint = c.mint WHERE c.city_id = ?").bind(UTICA).first();
  assert.deepEqual([after.name, after.pitch], ["Utica Coin", null]);
  assert.equal(JSON.parse(after.meta_json).description, "The city coin of Utica. Launched on Vicinity (https://vicinity.city) on Solana.");
  assert.equal(JSON.parse(after.meta_json).name, "Utica Coin");
  realClock();
});

test("SEC-2: an approval withdrawn (revoked or expired away) frees the design again once the hold is over", async () => {
  const w = await world();
  assert.equal((await w.post(w.f, "/api/coins/design", design())).ok, true);
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) })).ok, true);
  assert.equal((await w.post(w.f, "/api/coins/design", design({ name: "Utica Two" }))).error, "coin_being_approved");
  advance(DESIGN_HOLD_MS + 1000); // the owner cancelled in his wallet: nothing on chain
  assert.equal((await w.post(w.f, "/api/coins/design", design({ name: "Utica Two" }))).ok, true);
  realClock();
});

test("SEC-3: an approval whose wallet lost the founder seat (ended, another founder, grace) is flagged for revoking", async () => {
  const w = await world();
  assert.equal((await w.post(w.f, "/api/coins/design", design())).ok, true);
  const ap = await w.L.approval(BigInt(UTICA));
  w.lp.S.accounts[ap] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: "Utica Coin", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 });
  const row = async () => (await w.get(w.owner, "/api/admin/lp/candidates?cluster=devnet")).approvals.find((x) => x.cityId === UTICA);
  assert.deepEqual((await row()).warnings, [], "the approved wallet holds the seat");
  await w.env.DB.prepare("UPDATE seats SET status = 'grace' WHERE city_id = ?").bind(UTICA).run();
  assert.match((await row()).warnings.join(" "), /grace period.*approval still works on chain until it expires\. Revoke it unless/);
  await w.env.DB.prepare("UPDATE seats SET status = 'ended' WHERE city_id = ?").bind(UTICA).run();
  const ended = await row();
  assert.match(ended.warnings.join(" "), /no longer holds the founder seat \(the city has no founder now\).*Revoke it\./);
  assert.deepEqual(ended.seat, { wallet: null, status: null });
  const other = await person(w.env);
  const u = await w.env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(other.w.address).first();
  await w.env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)").bind(UTICA, u.id, other.w.address, new Date().toISOString(), new Date().toISOString()).run();
  assert.match((await row()).warnings.join(" "), new RegExp(`no longer holds the founder seat \\(it is now ${other.w.address}\\)`));
  realClock();
});

test("SEC-4: an unknown mint never costs a program-wide lookup: one metadata read, remembered for 5 minutes", async () => {
  const w = await world();
  const m = fresh();
  for (let i = 0; i < 5; i++) {
    const r = await browser(w.env, { ip: "198.51.100.7" }).send(`/api/lp/graduate/status?mint=${m}`, { fetchImpl: w.both });
    assert.equal(r.status, 404);
  }
  assert.equal(w.lp.count("getProgramAccounts"), 0);
  assert.equal(w.lp.count("getAccountInfo", await metadataAddress(m)), 1, "remembered as unknown");
  realClock();
});

test("SEC-6: the approval handed to the wallet is the very transaction simulated last (tuned compute limit included)", async () => {
  const w = await world();
  assert.equal((await w.post(w.f, "/api/coins/design", design())).ok, true);
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) });
  assert.equal(b.ok, true, JSON.stringify(b));
  const sims = w.lp.S.log.filter((l) => l.method === "simulateTransaction");
  assert.equal(sims.length, 2);
  assert.equal(sims[1].params[0], b.tx);
  assert.equal(b.fees.computeUnitLimit, 50_000);
  realClock();
});
