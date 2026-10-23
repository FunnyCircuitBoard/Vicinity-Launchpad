// The owner's daily launch-approval round (COIN_V2_BATCH=on with COIN_V2_READY=on, src/lpbatch.js) through the real API and real SQL,
// with the launchpad's fake chain (test/helpers/readyworld.js) taught to confirm and show what the owner's wallet "landed": switched off
// it is exactly as before (no route, key or record step); the list groups every city (Approve / Renew / Revoke / Blocked) with the
// one-at-a-time card's checks plus a ban and the founder amount read live; the build re-runs every check, builds only rows echoed exactly,
// holds each design, and packs up to 5 cities per transaction within Solana's 1,232 bytes (measured: 6 of these do not fit); renew is a
// revoke and an approve in ONE transaction; a lost seat, an expired approval, a ban and a coin that may no longer launch are revoked; a
// pending request, a flagged description and a duplicate ticker block; the record step logs every city and tells the founder, who then
// launches with no per-launch admin step. Owner only, a fresh wallet proof, same site, counted.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { BOUNDS, CITIES, advance, browser, person, realClock, reprove, setHolding } from "./helpers/world.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpAdmin, fits } from "../src/lpadmin.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _setArtRenderer } from "../src/coinready.js";
import { _resetReview, _setScreener } from "../src/coinreview.js";
import { BATCH, CHECKS } from "../src/lpbatch.js";
import { RULES_VERSION } from "../src/screen.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { base58Encode } from "../src/solana.js";
import { decodeHeader, MAX_TX_BYTES } from "../src/sol/message.js";
import { fromBase64 } from "../src/sol/bytes.js";
import * as IX from "../src/sol/lpadmin-ix.js";
import { programDataAddress, PROGRAM_IDS } from "../src/sol/pda.js";
import { LAYOUT } from "../src/sol/layout.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { CONFIG, PROGRAM, SYRACUSE, UTICA, approvalAccount, fresh, ownDescription, world } from "./helpers/readyworld.js";
import { programDataAccount as meteoraProgramData, METEORA_AUTHORITY } from "./helpers/lpchain.js";

before(async () => { const r = await nodeRenderer(); _setArtRenderer(r); });
after(() => { _setArtRenderer(null); _setScreener(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); _resetReview(); realClock(); });

const ALBANY = "5106834", NYC = "5128581";
// more cities of the list, with long names and 10-character tickers (the size limit is measured on them)
const MORE = [
  ["5101001", "Saratoga Springs", "SARATOGASP"], ["5101002", "Poughkeepsie", "POUGHKEEPS"], ["5101003", "Niagara Falls", "NIAGARAFAL"],
  ["5101004", "New Rochelle", "NEWROCHELL"], ["5101005", "Mount Vernon", "MOUNTVERNO"], ["5101006", "Schenectady", "SCHENECTAD"], ["5101007", "Binghamton", "BINGHAMTON"],
];
const sig = () => base58Encode(crypto.getRandomValues(new Uint8Array(64)));
const tables = async (env) => (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name).sort();

/** The ready-made coin world with the round on (or `batch` as given), the review switch, notices, the extra cities, and a chain that lands. */
async function batchWorld({ batch = "on", review = "on", tickers = {} } = {}) {
  const w = await world();
  if (batch !== null) w.env.COIN_V2_BATCH = batch;
  if (review) w.env.COIN_V2_REVIEW = review;
  w.env.NOTIFY = "on";
  const list = { ...CITIES, admin: { "US.NY": "New York" }, byCountry: { US: [...CITIES.byCountry.US, ...MORE.map(([id, name]) => [Number(id), name, "NY", 42.8, -73.9, 60_000])] } };
  const files = { "/data/cities.json": JSON.stringify(list), "/data/bounds/US.txt": BOUNDS,
    "/data/tickers.json": JSON.stringify({ 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA", ...Object.fromEntries(MORE.map(([id, , t]) => [id, t])), ...tickers }) };
  w.env.ASSETS = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
  _resetCityCache(); _resetTickers(); _resetReview();
  // the launchpad's node also confirms what the owner's wallet sent (getSignatureStatuses / getTransaction of the landed transactions)
  const landed = new Map(), inner = w.lp.fetchImpl;
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  w.lp.fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.method === "getSignatureStatuses") return ok({ context: { slot: 6 }, value: b.params[0].map((s) => (landed.has(s) ? { slot: 5, confirmations: null, err: null, confirmationStatus: "confirmed" } : null)) });
    if (b.method === "getTransaction") { const keys = landed.get(b.params[0]); return ok(keys ? { slot: 5, transaction: { message: { accountKeys: keys } }, meta: { err: null } } : null); }
    return inner(url, init);
  };
  /** The owner's wallet signed and the network ran transaction t: each city's approval is made (approve, renew) or closed (revoke). */
  w.land = async (t, { skip = [] } = {}) => {
    const keys = decodeHeader(fromBase64(t.tx)).staticKeys;
    for (const c of t.cities) {
      if (skip.includes(c.cityId)) continue;
      const at = await w.L.approval(BigInt(c.cityId));
      if (c.action === "revoke") { delete w.lp.S.accounts[at]; continue; }
      const f = t.summary.find((x) => x.ix === "approve_launch" && x.fields.cityId === c.cityId).fields;
      w.lp.S.accounts[at] = approvalAccount({ cityId: c.cityId, founder: f.founder, rentPayer: w.owner.w.address, name: f.name, symbol: f.symbol, expiresAt: Math.floor(Date.parse(f.expiresAt) / 1000) });
    }
    const s = sig();
    landed.set(s, keys);
    return s;
  };
  w.landKeys = (keys) => { const s = sig(); landed.set(s, keys); return s; };
  w.round = (who = w.owner) => w.get(who, "/api/admin/lp/batch?cluster=devnet");
  w.build = (rows, who = w.owner) => w.post(who, "/api/admin/lp/batch/tx", { cluster: "devnet", rows });
  w.record = (t, signature, who = w.owner) => w.post(who, "/api/admin/lp/record", { cluster: "devnet", step: "batch", signature, params: t.record.params });
  w.row = (q, ...p) => w.env.DB.prepare(q).bind(...p).first();
  w.all = async (q, ...p) => (await w.env.DB.prepare(q).bind(...p).all()).results;
  /** A signed-in founder of `cityId` holding the founder amount; `use`: they take the ready-made coin ("Use this coin"). */
  w.founder = async (cityId, cityName, { use = true, holds = 2_000_000 } = {}) => {
    const p = await person(w.env, { holds });
    const u = await w.row("SELECT id, wallet FROM users WHERE wallet = ?", p.w.address);
    const at = new Date(Date.now()).toISOString();
    await w.env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
      .bind(cityId, cityName, u.id, u.wallet, at, at).run();
    if (use) {
      const a = await w.post(p, "/api/coins/ready/art", { cityId });
      assert.equal(a.ok, true, JSON.stringify(a));
      const r = await w.post(p, "/api/coins/ready/use", { cityId, contentHash: a.coin.contentHash });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    return Object.assign(p, { uid: u.id, cityId });
  };
  return w;
}
const echo = (r) => ({ cityId: r.cityId, action: r.action, founder: r.founder, name: r.name, symbol: r.symbol, contentHash: r.contentHash });
const rowsOf = (round) => [...round.groups.approve, ...round.groups.renew, ...round.groups.revoke];
const ofCity = (round, cityId) => Object.entries(round.groups).flatMap(([g, list]) => list.filter((r) => r.cityId === cityId).map((r) => ({ group: g, ...r })))[0] || null;
/** Build every row of the round, land each transaction on the fake chain and record it. */
async function signRound(w, rows) {
  const b = await w.build(rows.map(echo));
  assert.equal(b.ok, true, JSON.stringify(b).slice(0, 600));
  for (const t of b.transactions) { const s = await w.land(t); const r = await w.record(t, s); assert.equal(r.ok, true, JSON.stringify(r)); }
  return b;
}

test("switched off (unset, off, anything but on, or COIN_V2_READY off): the round's paths are unknown paths, no key, no record step, the founder's words as before", async () => {
  const baseline = {}; // the tables the same steps make with the switch unset (the existing routes make some lazily, as on main)
  for (const [ready, batch] of [["on", null], ["on", "off"], ["on", "yes"], ["on", "true"], ["off", null], ["off", "on"], [null, "on"]]) {
    const w = await batchWorld({ batch });
    if (ready !== "on") { if (ready) w.env.COIN_V2_READY = ready; else delete w.env.COIN_V2_READY; }
    else await w.useCoin();
    for (const [path, method] of [["/api/admin/lp/batch?cluster=devnet", "GET"], ["/api/admin/lp/batch/tx", "POST"], ["/api/admin/lp/batch", "POST"], ["/api/admin/lp/batch/tx", "GET"]]) {
      const unknown = await w.owner.send(path.replace("batch", "nothing"), { method, body: method === "POST" ? { cluster: "devnet" } : undefined });
      const r = await w.owner.send(path, { method, body: method === "POST" ? { cluster: "devnet", rows: [] } : undefined });
      assert.equal(r.status, unknown.status, `${ready}/${batch} ${method} ${path}`);
      assert.deepEqual(await r.json(), await unknown.json(), "the very answer of an unknown path");
      assert.equal(r.status, 404);
    }
    const probe = await w.get(w.owner, "/api/admin/lp");
    assert.equal(probe.ok, true);
    assert.equal("batch" in probe, false, "no new key on the City coins probe");
    const rec = await w.post(w.owner, "/api/admin/lp/record", { cluster: "devnet", step: "batch", signature: sig(), params: { cities: [{ cityId: UTICA, action: "approve" }] } });
    assert.deepEqual([rec.status, rec.error, rec.message], [400, "bad_step", "Unknown step."], "the record step does not exist either");
    if (ready === "on") assert.equal("approvalRound" in (await w.get(w.f, `/api/coins/ready?city=${UTICA}`)), false);
    const st = await w.get(w.f, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
    assert.equal(st.message, "An admin approves your coin on chain first; your pair must be SOL.", "the launch card's words as before");
    const made = await tables(w.env);
    if (batch === null) baseline[ready === "on" ? "on" : "off"] = made;
    else assert.deepEqual(made, baseline[ready === "on" ? "on" : "off"], `${ready}/${batch}: no table is made`);
  }
});

test("the list: every city in its group, each row with the city, $TICKER, name, masked founder and version; the checks are the card's plus a ban and the live balance", async () => {
  const w = await batchWorld();
  const coin = await w.useCoin(); // Utica: approve
  const syr = await w.founder(SYRACUSE, "Syracuse", { use: false }); // an earlier studio design, the Vicinity coin not chosen: blocked
  await w.env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) VALUES (?, 'Syracuse', 'US', (SELECT id FROM seats WHERE city_id = ?), ?, 'Salt City', '', 'SOL', 'gold', ?, ?)")
    .bind(SYRACUSE, SYRACUSE, syr.uid, new Date(Date.now()).toISOString(), new Date(Date.now()).toISOString()).run();
  await w.founder("5101004", "New Rochelle", { use: false }); // a founder with no design at all is not in the round until they choose
  const alb = await w.founder(ALBANY, "Albany"); // a change request waiting for review: blocked
  const d = await w.post(alb, "/api/coins/review/draft", { cityId: ALBANY, name: "Albany Capital", reason: "Locals call it the capital city for years." });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal((await w.post(alb, "/api/coins/review/submit", { cityId: ALBANY, draftUpdatedAt: d.review.request.draft.updatedAt })).ok, true);
  const sar = await w.founder("5101001", "Saratoga Springs"); // banned: blocked
  await w.env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at) VALUES (?, 'US', 1, 'spam', ?)").bind(sar.uid, new Date(Date.now()).toISOString()).run();
  const pok = await w.founder("5101002", "Poughkeepsie"); // the founder amount is not held right now (read live): blocked
  setHolding(pok.w.address, 10);
  const nia = await w.founder("5101003", "Niagara Falls"); // a description flagged and sent for review: blocked
  _setScreener((text) => ({ result: "flag", issues: [{ code: "financial", severity: "flag", start: 0, end: 5 }], rulesVersion: RULES_VERSION, text }));
  const fl = await w.post(nia, "/api/coins/review/description", { cityId: "5101003", text: "Niagara coin goes 100x soon, guaranteed." });
  assert.equal(fl.screening.result, "flag", JSON.stringify(fl));
  _setScreener(null);
  const sent = await w.post(nia, "/api/coins/review/description/review", { cityId: "5101003", screeningId: fl.screening.id });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const before = await tables(w.env);
  const r = await w.round();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.rules, { days: 14, renewUnderHours: 48, perTx: 5, maxRows: 40 });
  assert.deepEqual([r.groups.approve.length, r.groups.renew.length, r.groups.revoke.length, r.global], [1, 0, 0, []]);
  const u = r.groups.approve[0];
  assert.deepEqual([u.cityId, u.cityName, u.action, u.symbol, u.name, u.founder, u.contentHash, u.version, u.art], [UTICA, "Utica", "approve", "UTICA", "Utica", w.f.w.address, coin.contentHash, coin.version, coin.art]);
  // BATCH-1: the description that goes into the metadata for ever, and whose words it is
  assert.deepEqual([u.description, u.descriptionBy], ["The city coin of Utica, New York, United States.", "vicinity"]);
  assert.equal(u.founderMasked, `${w.f.w.address.slice(0, 5)}…${w.f.w.address.slice(-4)}`);
  assert.deepEqual(u.checks, [...CHECKS]);
  const why = (id) => ofCity(r, id) && ofCity(r, id).reasons.join(" ");
  assert.equal(ofCity(r, SYRACUSE).group, "blocked");
  assert.match(why(SYRACUSE), /has not chosen the Vicinity coin yet/);
  assert.match(why(ALBANY), /change request waits for review/);
  assert.match(why("5101001"), /suspended \(a ban\)/);
  assert.match(why("5101002"), /below the founder amount right now/);
  assert.match(why("5101003"), /description waits for review/);
  assert.doesNotMatch(JSON.stringify(r), /24 hours|within a day|tomorrow/i);
  assert.equal(ofCity(r, NYC), null, "a city with no seat and no design is not listed");
  assert.equal(ofCity(r, "5101004"), null, "nor a founder who has not chosen a coin (their card says to choose it)");
  assert.deepEqual(await tables(w.env), before, "the list makes no table");
  // only the owner: an admin of the site, a moderator, a founder or a visitor gets nothing
  const admin = await person(w.env);
  await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, 'admin', ?, ?)").bind(admin.w.address, w.owner.w.address, new Date().toISOString()).run();
  for (const [who, status] of [[admin, 403], [w.f, 403], [syr, 403], [browser(w.env), 401]]) assert.equal((await who.send("/api/admin/lp/batch?cluster=devnet")).status, status);
  assert.equal((await w.get(w.owner, "/api/admin/lp/batch?cluster=mainnet")).error, "cluster_mismatch");
});

test("the build: only rows echoed exactly; up to 5 cities a transaction within 1,232 bytes (6 of these do not fit); each design held and its version bound; nothing signed by the Worker", async () => {
  const w = await batchWorld();
  await w.useCoin();
  const fs = [];
  for (const [id, name] of MORE) fs.push(await w.founder(id, name));
  const r = await w.round();
  assert.equal(r.groups.approve.length, 8, JSON.stringify(r.groups.blocked));
  const rows = r.groups.approve;
  // the measured limit: the 6 longest approvals of this round do not fit one transaction, the 5 longest do
  const nowS = Math.floor(Date.now() / 1000), longest = [...rows].sort((a, b) => b.name.length + b.symbol.length - a.name.length - a.symbol.length);
  const ixOf = (x) => IX.approveLaunch({ programId: PROGRAM, admin: w.owner.w.address, cityId: BigInt(x.cityId), founder: x.founder, name: x.name, symbol: x.symbol, expiresAt: nowS, dbcConfig: CONFIG });
  assert.equal(fits(w.owner.w.address, await Promise.all(longest.slice(0, 6).map(ixOf))), false, "six do not fit");
  assert.equal(fits(w.owner.w.address, await Promise.all(longest.slice(0, 5).map(ixOf))), true, "five do");
  // a row that is not what the list shows (here: another name) is dropped with the reason, never swapped; the rest is built
  const sent = rows.map(echo);
  sent[1] = { ...sent[1], name: "Another Name" };
  const b = await w.build(sent);
  assert.equal(b.ok, true, JSON.stringify(b).slice(0, 500));
  assert.deepEqual(b.dropped.map((x) => [x.cityId, /changed since the page loaded/.test(x.why)]), [[rows[1].cityId, true]]);
  assert.equal(b.days, 14);
  assert.equal(b.expiresAt, new Date((nowS + 14 * 86_400) * 1000).toISOString());
  assert.deepEqual(b.transactions.map((t) => t.cities.length), [5, 2]);
  const built = new Set();
  for (const t of b.transactions) {
    const bytes = fromBase64(t.tx);
    assert.ok(bytes.length <= MAX_TX_BYTES && t.bytes === bytes.length, `${bytes.length} bytes`);
    const d = decodeHeader(bytes);
    assert.deepEqual(d.staticKeys.slice(0, d.header.numRequiredSignatures), [w.owner.w.address], "the owner's wallet is the only signer: the Worker signs nothing");
    assert.ok(bytes.subarray(1, 65).every((x) => x === 0), "unsigned");
    assert.deepEqual(t.summary.map((x) => x.ix).filter((x) => !x.startsWith("set_compute")), t.cities.map(() => "approve_launch"));
    for (const c of t.cities) {
      const f = t.summary.find((x) => x.ix === "approve_launch" && x.fields.cityId === c.cityId).fields;
      const row = rows.find((x) => x.cityId === c.cityId);
      assert.deepEqual([f.founder, f.name, f.symbol, f.expiresAt], [row.founder, row.name, row.symbol, b.expiresAt]);
      built.add(c.cityId);
      // held, and the version the approval stands for is marked (a launch publishes only that one)
      assert.ok(Date.parse((await w.row("SELECT value FROM settings WHERE key = ?", `lp_design_hold:${c.cityId}`)).value) > Date.now());
      const cr = await w.row("SELECT content_hash, approved_hash FROM coin_ready WHERE city_id = ?", c.cityId);
      assert.equal(cr.approved_hash, cr.content_hash);
    }
    assert.deepEqual(t.record, { step: "batch", params: { cities: t.cities.map((c) => ({ cityId: c.cityId, action: "approve" })) } });
    assert.match(JSON.stringify(t.summary), /approval \(new\)/);
  }
  assert.equal(built.size, 7);
  assert.equal(await w.row("SELECT approved_hash FROM coin_ready WHERE city_id = ?", rows[1].cityId).then((x) => x.approved_hash), null, "the dropped row is not marked");
  assert.match((await w.row("SELECT detail FROM admin_audit WHERE action = 'lp/batch-built'")).detail, /devnet: 2 transaction\(s\): 7 approve\/renew, 0 revoke/);
});

test("the build refuses: no rows, a malformed or duplicate row, too many, a stale proof, another site, not the owner, not the launchpad admin, an untested Meteora build, and counts every try", async () => {
  const w = await batchWorld();
  const coin = await w.useCoin();
  const row = (await w.round()).groups.approve[0];
  const r = (x) => [x.status, x.error];
  assert.deepEqual(r(await w.build([])), [400, "no_rows"]);
  assert.deepEqual(r(await w.build([{ ...echo(row), action: "launch" }])), [400, "bad_row"]);
  assert.deepEqual(r(await w.build([{ ...echo(row), contentHash: "x" }])), [400, "bad_row"]);
  assert.deepEqual(r(await w.build([echo(row), echo(row)])), [400, "duplicate_city"]);
  assert.deepEqual(r(await w.build(Array.from({ length: BATCH.maxRows + 1 }, (_, i) => ({ ...echo(row), cityId: String(1000 + i) })))), [400, "too_many"]);
  // every echoed field must be the list's: all dropped, nothing built
  for (const k of ["founder", "symbol", "contentHash"]) {
    const x = await w.build([{ ...echo(row), [k]: k === "contentHash" ? "f".repeat(64) : k === "founder" ? fresh() : "OTHER" }]);
    assert.deepEqual(r(x), [409, "batch_changed"], k);
    assert.equal(x.dropped[0].cityId, UTICA);
  }
  assert.deepEqual(r(await w.build([{ ...echo(row), action: "renew" }])), [409, "batch_changed"], "another action than the list's");
  // another site's page, an old proof
  const cross = await w.owner.send("/api/admin/lp/batch/tx", { method: "POST", body: { cluster: "devnet", rows: [echo(row)] }, origin: "https://evil.example" });
  assert.deepEqual([cross.status, (await cross.json()).error], [403, "wrong_origin"]);
  advance(31 * 60_000);
  assert.deepEqual(r(await w.build([echo(row)])), [403, "reprove"]);
  await reprove(w.owner);
  // a site admin or a founder is not the owner
  const admin = await person(w.env);
  await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, 'admin', ?, ?)").bind(admin.w.address, w.owner.w.address, new Date().toISOString()).run();
  assert.deepEqual(r(await w.build([echo(row)], admin)), [403, "forbidden"]);
  assert.deepEqual(r(await w.build([echo(row)], w.f)), [403, "forbidden"]);
  // Meteora's bonding-curve program changed since the team tested it: nothing is built
  const pd = await programDataAddress(PROGRAM_IDS.dbc);
  const kept = w.lp.S.accounts[pd];
  w.lp.S.accounts[pd] = meteoraProgramData(METEORA_AUTHORITY, new Uint8Array(4096).fill(0x99), 9999);
  _resetLpAdmin();
  assert.deepEqual(r(await w.build([echo(row)])), [409, "program_changed"]);
  w.lp.S.accounts[pd] = kept; _resetLpAdmin();
  // a second owner wallet (ADMIN_WALLETS) that is not the launchpad's admin cannot sign approvals
  const other = await person(w.env);
  w.env.ADMIN_WALLETS = `${w.owner.w.address},${other.w.address}`;
  assert.deepEqual(r(await w.build([echo(row)], other)), [403, "not_admin"]);
  assert.equal(await w.row("SELECT value FROM settings WHERE key = ?", `lp_design_hold:${UTICA}`), null, "nothing was held by a refused build");
  // a founder who changed their coin between the list and the build: dropped, nothing built from a version the owner did not see
  await reprove(w.f);
  const desc = await ownDescription(w, "The Handshake City on the Mohawk River, home of tomato pie."); // a person approved it
  const x = await w.build([echo(row)]);
  assert.deepEqual(r(x), [409, "batch_changed"]);
  assert.notEqual(desc.coin.contentHash, coin.contentHash);
  // counted before the work: 30 builds an hour per owner wallet
  let last;
  for (let i = 0; i < 40 && !(last && last.status === 429); i++) last = await w.build([{ ...echo(row), cityId: String(7000 + i) }]);
  assert.deepEqual(r(last), [429, "slow_down"]);
});

test("record: the chain must show every city; renew is a revoke and an approve in ONE transaction; a lost seat, a ban, an expiry and a coin that can't launch are revoked; the founder then launches with no admin step", async () => {
  const w = await batchWorld();
  await w.useCoin();
  const sar = await w.founder("5101001", "Saratoga Springs");
  const pok = await w.founder("5101002", "Poughkeepsie");
  const nia = await w.founder("5101003", "Niagara Falls");
  const sch = await w.founder("5101006", "Schenectady");
  // a description that passed by itself under an older engine (a stand-in plays it: today a founder's own words always go to a person)
  _setScreener((text) => ({ result: "pass", issues: [], rulesVersion: RULES_VERSION, text }));
  const desc = await w.post(nia, "/api/coins/review/description", { cityId: "5101003", text: "The city of the falls, mist and rainbows over the river." });
  assert.equal(desc.used, true, JSON.stringify(desc));
  advance(6 * 60_000);
  const first = await w.round();
  assert.equal(first.groups.approve.length, 5);
  const b = await w.build(first.groups.approve.map(echo));
  assert.equal(b.transactions.length, 1);
  const t = b.transactions[0];
  // a transaction that did not touch every city's approval, or one the chain does not show yet: not recorded
  const s0 = await w.land(t, { skip: [UTICA] });
  assert.deepEqual([(await w.record(t, s0)).error], ["not_done"]);
  assert.deepEqual([(await w.record(t, w.landKeys([w.owner.w.address]))).error], ["wrong_transaction"], "a transaction that did not touch these approvals");
  assert.deepEqual([(await w.record(t, w.landKeys([w.f.w.address]))).error], ["not_yours"], "one the owner's wallet did not pay");
  assert.deepEqual([(await w.record({ record: { params: { cities: [{ cityId: UTICA, action: "launch" }] } } }, s0)).error], ["bad_params"]);
  const s1 = await w.land(t);
  const rec = await w.record(t, s1);
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal((await w.record(t, s1)).ok, true, "recording again changes nothing");
  const log = await w.all("SELECT city_id, action, founder, symbol, signature FROM lp_approvals_log ORDER BY id");
  assert.equal(log.length, 5);
  assert.deepEqual(log.map((x) => x.signature), t.cities.map((c) => `${s1}:${c.cityId}:approve`));
  assert.ok(log.every((x) => x.action === "approve"));
  assert.match((await w.row("SELECT action, detail FROM admin_audit WHERE action = 'lp/batch'")).detail, new RegExp(`devnet ${s1}: approve`));
  const notices = await w.all("SELECT user_id, text FROM notices ORDER BY id");
  assert.ok(notices.some((n) => n.user_id === sar.uid && n.text === "Your launch approval is on the blockchain. You can launch $SARATOGASP now."), JSON.stringify(notices));
  // nothing more to do today
  let r = await w.round();
  assert.deepEqual([r.groups.approve.length, r.groups.renew.length, r.groups.revoke.length, r.settled], [0, 0, 0, 5]);
  // the founder launches with no per-launch admin step: the existing launch path
  const st = await w.get(w.f, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
  assert.equal(st.state, "ready", JSON.stringify(st));
  const tx = await w.post(w.f, "/api/lp/launch/tx", { cityId: UTICA, cluster: "devnet", mint: fresh() });
  assert.equal(tx.ok, true, JSON.stringify(tx).slice(0, 400));
  // 12.5 days later: under 48 hours left. Utica renews; Saratoga's founder lost the seat (no founder), Poughkeepsie's is banned,
  // Schenectady's seat is in grace, and Niagara's description no longer passes the current rules: those are revoked
  advance(12.5 * 86_400_000);
  await reprove(w.owner);
  await w.env.DB.prepare("UPDATE seats SET status = 'released' WHERE id = (SELECT id FROM seats WHERE city_id = ?)").bind("5101001").run();
  await w.env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at) VALUES (?, '*', 1, 'spam', ?)").bind(pok.uid, new Date(Date.now()).toISOString()).run();
  await w.env.DB.prepare("UPDATE seats SET status = 'grace', grace_until = ? WHERE city_id = ?").bind(new Date(Date.now() + 86_400_000).toISOString(), "5101006").run();
  _setScreener((text) => ({ result: "flag", issues: [{ code: "abuse", severity: "flag", start: 0, end: 3 }], rulesVersion: "s1-newer", text }));
  r = await w.round();
  _setScreener(null);
  assert.deepEqual(r.groups.renew.map((x) => x.cityId), [UTICA]);
  assert.match(r.groups.renew[0].why, /^It ends in 36 hours/);
  assert.equal(r.groups.renew[0].approval.symbol, "UTICA");
  const revoke = Object.fromEntries(r.groups.revoke.map((x) => [x.cityId, x.why]));
  assert.deepEqual(Object.keys(revoke).sort(), ["5101001", "5101002", "5101003", "5101006"]);
  assert.match(revoke["5101001"], /no founder now/);
  assert.match(revoke["5101002"], /suspended \(a ban\)/);
  assert.match(revoke["5101006"], /grace period/);
  assert.match(revoke["5101003"], /can't launch as it is/);
  // the build of the renew and the revokes (the screener as it is now: Niagara's revoke is echoed, and stays a revoke)
  _setScreener((text) => ({ result: "flag", issues: [{ code: "abuse", severity: "flag", start: 0, end: 3 }], rulesVersion: "s1-newer", text }));
  const b2 = await w.build(rowsOf(r).map(echo));
  _setScreener(null);
  assert.equal(b2.ok, true, JSON.stringify(b2).slice(0, 500));
  assert.equal(b2.transactions.length, 1);
  const t2 = b2.transactions[0];
  assert.ok(fromBase64(t2.tx).length <= MAX_TX_BYTES);
  const ixs = t2.summary.filter((x) => !x.ix.startsWith("set_compute"));
  // Utica: revoke then approve, in the same transaction; the four others: revoke only
  const uticaAt = ixs.findIndex((x) => x.fields && x.fields.cityId === UTICA);
  assert.deepEqual([ixs[uticaAt].ix, ixs[uticaAt + 1].ix, ixs[uticaAt + 1].fields.cityId], ["revoke_approval", "approve_launch", UTICA]);
  assert.deepEqual(ixs.filter((x) => x.ix === "revoke_approval").map((x) => x.fields.cityId).sort(), [UTICA, "5101001", "5101002", "5101003", "5101006"].sort());
  const s2 = await w.land(t2);
  assert.equal((await w.record(t2, s2)).ok, true);
  const after = await w.all("SELECT city_id, action, signature FROM lp_approvals_log WHERE signature LIKE ? ORDER BY id", `${s2}:%`);
  assert.deepEqual(after.filter((x) => x.city_id === UTICA).map((x) => x.action), ["revoke", "approve"], "renew: a revoke line, then an approve line");
  assert.deepEqual(after.filter((x) => x.city_id !== UTICA).map((x) => x.action), ["revoke", "revoke", "revoke", "revoke"]);
  r = await w.round();
  assert.deepEqual([r.groups.renew.length, r.groups.revoke.length], [0, 0]);
  assert.equal(r.settled, 1);
  // an expired approval of a founder who is not eligible now (no choice) is closed (its rent comes back)
  const alb = await w.founder(ALBANY, "Albany", { use: false });
  w.lp.S.accounts[await w.L.approval(BigInt(ALBANY))] = approvalAccount({ cityId: ALBANY, founder: alb.w.address, rentPayer: w.owner.w.address, name: "Albany", symbol: "ALBANY", expiresAt: Math.floor(Date.now() / 1000) - 60 });
  r = await w.round();
  assert.match(ofCity(r, ALBANY).why, /expired before the founder launched/);
  assert.equal(ofCity(r, ALBANY).group, "revoke");
});

test("one coin per ticker: a second city can't take a ticker another city chose; another city's approval on chain blocks it; one city is never in a signing twice", async () => {
  const w = await batchWorld({ tickers: { 5101002: "SARATOGASP" } }); // the list gives Poughkeepsie Saratoga's ticker too
  await w.founder("5101001", "Saratoga Springs");
  const pok = await w.founder("5101002", "Poughkeepsie", { use: false });
  const a = await w.post(pok, "/api/coins/ready/art", { cityId: "5101002" });
  assert.deepEqual([a.status, a.gate && a.gate.code], [200, "symbol_taken"], JSON.stringify(a).slice(0, 300));
  let r = await w.round();
  assert.deepEqual(r.groups.approve.map((x) => [x.cityId, x.symbol]), [["5101001", "SARATOGASP"]]);
  assert.equal(ofCity(r, "5101002"), null, "Poughkeepsie never chose a coin");
  assert.deepEqual([(await w.build([echo(r.groups.approve[0]), echo(r.groups.approve[0])])).error], ["duplicate_city"]);
  // an approval on chain names a ticker: another city with it is blocked (one coin per ticker, as the one-at-a-time card)
  const w2 = await batchWorld();
  await w2.useCoin();
  w2.lp.S.accounts[await w2.L.approval(BigInt(NYC))] = approvalAccount({ cityId: NYC, founder: fresh(), rentPayer: w2.owner.w.address, name: "Utica", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 5 * 86_400 });
  r = await w2.round();
  assert.match(ofCity(r, UTICA).reasons.join(" "), /The ticker UTICA is already launched or approved for another city \(5128581\)/);
  assert.equal(ofCity(r, NYC).group, "revoke", "an approval for a city with no founder is withdrawn");
  assert.match(ofCity(r, NYC).why, /no founder now/);
});

test("the founder's words with the round on: the launch opens after the owner's next approval round, never a time", async () => {
  const w = await batchWorld();
  await w.useCoin();
  const v = await w.get(w.f, `/api/coins/ready?city=${UTICA}`);
  assert.equal(v.approvalRound, true);
  const st = await w.get(w.f, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
  assert.deepEqual([st.state, st.message], ["not_approved", "Your launch opens after the owner's next approval round, once your coin is chosen and passes every check."]);
  // an expired approval: renewed at the next round
  w.lp.S.accounts[await w.L.approval(BigInt(UTICA))] = approvalAccount({ cityId: UTICA, founder: w.f.w.address, rentPayer: w.owner.w.address, name: "Utica", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) - 10 });
  const ex = await w.get(w.f, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
  assert.deepEqual([ex.state, ex.message], ["expired", "Your approval ran out before you launched. It is renewed at the owner's next approval round."]);
  for (const x of [v, st, ex]) assert.doesNotMatch(JSON.stringify(x), /24 hours|within a day|tomorrow|hours? from now/i);
  const probe = await w.get(w.owner, "/api/admin/lp");
  assert.equal(probe.batch, true);
});

/** Set one field of a fake account (the owner's switches on the launchpad: launches_paused). */
function setField(S, address, layout, field, value) {
  const f = LAYOUT[layout].fields[field];
  const bytes = Buffer.from(S.accounts[address].data, "base64");
  bytes[f.at] = Number(value);
  S.accounts[address].data = bytes.toString("base64");
}

test("SEC-4: a pre-approved founder can still ask for changes or write a description: the round withdraws the approval while a request waits, and renews it for a changed coin", async () => {
  const w = await batchWorld();
  await w.useCoin();
  advance(6 * 60_000);
  await signRound(w, (await w.round()).groups.approve);
  advance(6 * 60_000); // the round's hold on the design is over
  await reprove(w.f);
  // a request while approved: accepted (no "ask Vicinity to withdraw it first"); the round withdraws the approval while it waits
  const d = await w.post(w.f, "/api/coins/review/draft", { cityId: UTICA, name: "Utica Falls", reason: "Locals call it the falls city since 1850." });
  assert.equal(d.ok, true, JSON.stringify(d));
  const s = await w.post(w.f, "/api/coins/review/submit", { cityId: UTICA, draftUpdatedAt: d.review.request.draft.updatedAt });
  assert.equal(s.ok, true, JSON.stringify(s));
  let r = await w.round();
  const rv = ofCity(r, UTICA);
  assert.equal(rv.group, "revoke");
  assert.match(rv.why, /change request waits for review/);
  assert.equal((await w.post(w.f, "/api/coins/review/cancel", { cityId: UTICA, requestId: s.review.request.id })).ok, true);
  assert.equal(ofCity(await w.round(), UTICA), null, "cancelled: the approval stands, nothing to do today");
  // a description written under the approval goes to a person: sent for review, the round withdraws the approval while it waits
  const own = await w.post(w.f, "/api/coins/review/description", { cityId: UTICA, text: "The Handshake City on the Mohawk River, home of tomato pie." });
  assert.deepEqual([own.screening.result, own.used], ["flag", undefined]);
  const sent = await w.post(w.f, "/api/coins/review/description/review", { cityId: UTICA, screeningId: own.screening.id });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.match(ofCity(await w.round(), UTICA).why, /description waits for review/);
  assert.equal((await w.post(w.f, "/api/coins/review/cancel", { cityId: UTICA, requestId: sent.review.request.id })).ok, true);
  // a description used by itself under an older engine (a stand-in plays it), written under the approval: the next round renews it for
  // the coin as it is now (whatever time is left)
  _setScreener((text) => ({ result: "pass", issues: [], rulesVersion: RULES_VERSION, text }));
  const desc = await w.post(w.f, "/api/coins/review/description", { cityId: UTICA, text: "The Handshake City on the Mohawk River, home of tomato pie." });
  assert.equal(desc.used, true, JSON.stringify(desc));
  assert.equal((await w.get(w.f, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`)).why, "approval_changed");
  r = await w.round();
  const rn = ofCity(r, UTICA);
  assert.deepEqual([rn.group, rn.contentHash], ["renew", desc.review.selected.contentHash]);
  // BATCH-1: the owner reads the founder's own words in the row (the card leaves it unticked until then)
  assert.deepEqual([rn.description, rn.descriptionBy], ["The Handshake City on the Mohawk River, home of tomato pie.", "founder"]);
  assert.match(rn.why, /changed the coin after this approval/);
  advance(6 * 60_000);
  await signRound(w, [rn]);
  const st = await w.get(w.f, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`);
  assert.equal(st.state, "ready", JSON.stringify(st));
});

test("SEC-8: the round reads every city with a design, not only the 200 saved last: an older eligible founder is approved, an older approval renewed", async () => {
  const w = await batchWorld();
  await w.useCoin();
  const old = "2026-01-01T00:00:00.000Z";
  await w.env.DB.prepare("UPDATE city_coins SET updated_at = ? WHERE city_id = ?").bind(old, UTICA).run();
  await w.env.DB.prepare("UPDATE coin_ready SET design_at = ? WHERE city_id = ?").bind(old, UTICA).run();
  // 200 newer designs of other cities (no founder: blocked, but listed first)
  const at = new Date(Date.now()).toISOString();
  await w.env.DB.batch(Array.from({ length: 200 }, (_, i) => w.env.DB.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at)
    VALUES (?, ?, 'US', 0, 0, ?, '', 'SOL', 'ink', ?, ?)`).bind(String(9_000_000 + i), `Town ${i}`, `Town ${i}`, at, at)));
  advance(6 * 60_000);
  const card = (await w.get(w.owner, "/api/admin/lp/candidates?cluster=devnet")).candidates;
  assert.equal(card.length, 200, "the one-at-a-time card still lists the 200 saved last");
  assert.equal(card.some((c) => c.cityId === UTICA), false);
  const r = await w.round();
  const u = ofCity(r, UTICA);
  assert.equal(u && u.group, "approve", JSON.stringify(u));
});

test("UX-3: launches paused when the round lands: the founder is told the approval is there, never that they can launch now", async () => {
  const w = await batchWorld();
  await w.useCoin();
  advance(6 * 60_000);
  setField(w.lp.S, await w.L.launchpad(), "Launchpad", "launches_paused", 1);
  const round = await w.round();
  await signRound(w, round.groups.approve);
  const texts = (await w.all("SELECT text FROM notices ORDER BY id")).map((n) => n.text);
  assert.ok(texts.includes("Your launch approval is on the blockchain. Launches are paused for now; you can launch $UTICA once they resume."), JSON.stringify(texts));
  assert.equal(texts.some((t) => /launch \$UTICA now/.test(t)), false);
  assert.equal((await w.get(w.f, `/api/lp/launch/status?city=${UTICA}&cluster=devnet`)).state, "paused");
});
