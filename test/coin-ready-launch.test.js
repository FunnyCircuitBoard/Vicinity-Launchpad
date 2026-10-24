// The ready-made coin through the EXISTING approval and launch path (COIN_V2_READY=on): the owner's City coins tab approves only the
// founder's chosen ready-made coin (its name, ticker and description are the defaults; the version and picture are on the card), never a
// ticker another city launched or holds an approval for; the approval binds the defaults as today; the launch record then publishes the
// template picture at /coin-meta/art/<sha256>.png and the metadata JSON built on the server from the version, bound to the coin for good
// and served whatever any switch says afterwards. With the switch off the candidate list is exactly as before.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { advance, browser, person, realClock } from "./helpers/world.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins, ensureLpCoinsSchema } from "../src/lpcoins.js";
import { _setArtRenderer } from "../src/coinready.js";
import { sha256Hex } from "../src/coinart.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { LP_ON, PROGRAM, SYRACUSE, UTICA, WSOL, CONFIG, approvalAccount, b64, fresh, launchOnChain, layoutAccount, meta, metadataAccount, seenOf, world } from "./helpers/readyworld.js";

before(async () => { const r = await nodeRenderer(); _setArtRenderer(r); });
after(() => { _setArtRenderer(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); realClock(); });

test("the owner approves the founder's chosen ready-made coin as today: defaults on the card, its version and picture; the approval binds them", async () => {
  const w = await world();
  assert.equal(await w.card(), undefined, "no design row yet: nothing to approve");
  const coin = await w.useCoin();
  const c = await w.card();
  assert.deepEqual([c.ok, c.name, c.symbol, c.pair, c.pitch, c.logo, c.founder], [true, "Utica", "UTICA", "SOL", "The city coin of Utica, New York, United States.", false, w.f.w.address], JSON.stringify(c.reasons));
  assert.deepEqual(c.ready, { version: coin.version, contentHash: coin.contentHash, template: "t1", art: coin.art, description: "The city coin of Utica, New York, United States.", descriptionBy: "vicinity" });
  // the approval stands for that exact version: none sent (a page from before), or another one, builds nothing
  for (const contentHash of [undefined, "f".repeat(64)]) {
    const x = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), contentHash, expiryDays: 7 });
    assert.deepEqual([x.status, x.error], [409, "design_changed"], String(contentHash));
  }
  assert.equal(await w.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`lp_design_hold:${UTICA}`).first(), null, "nothing held either");
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(b.summary.find((x) => x.ix === "approve_launch").fields, { cityId: UTICA, founder: w.f.w.address, name: "Utica", symbol: "UTICA", expiresAt: "2026-10-27T12:00:00.000Z" });
  // from the build on, the choice is frozen too (the hold, then the Approval on chain)
  const again = await w.post(w.f, "/api/coins/ready/use", { cityId: UTICA, contentHash: coin.contentHash });
  assert.deepEqual([again.status, again.error], [409, "held"]);
});

test("switch on: a studio design the founder never replaced, or a ticker another city launched or holds an approval for, is not approved", async () => {
  const w = await world();
  // an earlier studio design (made before the switch): kept, but not approvable while the switch is on
  await w.env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) SELECT ?, 'Utica', 'US', id, user_id, 'Utica Coin', 'The Handshake City.', 'SOL', 'gold', ?, ? FROM seats WHERE city_id = ?")
    .bind(UTICA, "2026-10-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z", UTICA).run();
  let c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /has not chosen the Vicinity coin yet/);
  assert.equal(c.ready, null);
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c) })).error, "blocked");
  await w.useCoin();
  assert.equal((await w.card()).ok, true);
  // (a Raydium LaunchLab contract still waiting for the city: stage 0's rule, whatever the switch says. The candidates skip such a city
  // (fix/close-launchlab-path, test/lpadmin.test.js) and nothing launches while it waits (test/legacy-contract.test.js))
  // another city launched with UTICA (a moved ticker): never approved twice
  await ensureLpCoinsSchema(w.env.DB);
  await w.env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', ?, ?, ?, 'c', 'f', 'Syracuse', 'UTICA', 'q', 'd', 'p', 'now')`).bind(PROGRAM, SYRACUSE, fresh()).run();
  c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), new RegExp(`The ticker UTICA is already launched or approved for another city \\(${SYRACUSE}\\)`));
  await w.env.DB.prepare("DELETE FROM lp_coins").run();
  assert.equal((await w.card()).ok, true);
  // another city's approval on chain names UTICA
  const other = await person(w.env);
  const ou = await w.env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(other.w.address).first();
  await w.env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) VALUES (?, 'Syracuse', 'US', 99, ?, 'Syracuse', NULL, 'SOL', 'gold', 'x', 'x')").bind(SYRACUSE, ou.id).run();
  w.lp.S.accounts[await w.L.approval(BigInt(SYRACUSE))] = approvalAccount({ cityId: SYRACUSE, founder: other.w.address, rentPayer: w.owner.w.address, name: "Syracuse", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
  c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /already launched or approved for another city/);
  // the city list changed under the choice (another ticker now): the founder must use the coin again
  delete w.lp.S.accounts[await w.L.approval(BigInt(SYRACUSE))];
  await w.env.DB.prepare("UPDATE coin_ready SET symbol = 'UTICAOLD' WHERE city_id = ?").bind(UTICA).run();
  await w.env.DB.prepare("UPDATE coin_versions SET symbol = 'UTICAOLD'").run();
  assert.match((await w.card()).reasons.join(" "), /no longer matches the city list/);
});

test("switch off: the candidate list is exactly as before (a studio design is approvable, no ready key)", async () => {
  const w = await world({ ready: null });
  await w.env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) SELECT ?, 'Utica', 'US', id, user_id, 'Utica Coin', 'The Handshake City.', 'SOL', 'gold', ?, ? FROM seats WHERE city_id = ?")
    .bind(UTICA, "2026-10-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z", UTICA).run();
  const c = await w.card();
  assert.deepEqual([c.ok, c.reasons, "ready" in c], [true, [], false]);
});

test("the launch record publishes the template picture and the server-built JSON from the version, bound to the coin for good", async () => {
  const w = await world();
  const coin = await w.useCoin();
  const sha = coin.art.slice(15, 79);
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) });
  assert.equal(b.ok, true, JSON.stringify(b));
  // the approval lands, then the founder launches with it (the program copies the approved name and symbol into the coin's metadata)
  const mint = fresh();
  w.lp.S.accounts[await w.L.coin(BigInt(UTICA))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: UTICA, founder: w.f.w.address, mint, quote_mint: WSOL, dbc_config: CONFIG, dbc_pool: fresh() })) };
  w.lp.S.accounts[await metadataAddress(mint)] = metadataAccount(mint, "Utica", "UTICA", `https://vicinity.city/coin-meta/${mint}.json`);
  advance(10 * 60_000);
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const lc = await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first();
  const j = JSON.parse(lc.meta_json);
  assert.deepEqual([j.name, j.symbol, j.image, j.description], ["Utica", "UTICA", `https://vicinity.city/coin-meta/art/${sha}.png`,
    "The city coin of Utica, New York, United States. Launched on Vicinity (https://vicinity.city) on Solana."]);
  assert.deepEqual(j.city, { id: 5142056, name: "Utica", country: "US", region: "New York", countryName: "United States", ticker: "UTICA" });
  const bound = await w.env.DB.prepare("SELECT mint, bound_at, approved_hash FROM coin_ready WHERE city_id = ?").bind(UTICA).first();
  assert.equal(bound.mint, mint, "the version is the coin's for good");
  assert.equal(bound.approved_hash, coin.contentHash, "the approval was built from it");
  // wallets that guess /coin-meta/<mint>.png are sent to the permanent picture
  const png = await meta(w.env, `/coin-meta/${mint}.png`);
  assert.deepEqual([png.status, png.headers.get("location")], [302, `/coin-meta/art/${sha}.png`]);
  // a moderator's text takedown: the published description is Vicinity's own sentence (the version's), not the founder's text, so it is
  // refused in plain words and nothing is logged as removed (the public log never claims a removal that did not happen); the JSON stays
  const before = (await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json;
  const t = await w.post(w.owner, "/api/coins/takedown", { city: UTICA, what: "text", reason: "abuse", note: "testing the rebuild" });
  assert.deepEqual([t.status, t.ok, t.error], [409, false, "system_text"], JSON.stringify(t));
  assert.match(t.message, /Vicinity's own sentence from the city list .* nothing to take down\. Nothing was changed\./);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'coin_text_removed'").first()).n, 0);
  assert.equal((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json, before);
  assert.equal(JSON.parse(before).image, `https://vicinity.city/coin-meta/art/${sha}.png`);
  // every switch off (the ready coin and the launchpad's settings): the picture and the JSON keep being served
  const dark = { ...w.env };
  for (const k of ["COIN_V2_READY", ...Object.keys(LP_ON)]) delete dark[k];
  const pic = await meta(dark, `/coin-meta/art/${sha}.png`);
  assert.equal(pic.status, 200);
  assert.equal(await sha256Hex(new Uint8Array(await pic.arrayBuffer())), sha);
  const js = await meta(dark, `/coin-meta/${mint}.json`);
  assert.equal(js.status, 200);
  assert.equal((await js.json()).image, `https://vicinity.city/coin-meta/art/${sha}.png`);
  assert.equal((await meta(dark, `/coin-meta/${mint}.png`)).headers.get("location"), `/coin-meta/art/${sha}.png`);
});

test("a coin launched with another name than the chosen version (or none chosen) gets the old JSON: a version is never published unmatched", async () => {
  const w = await world();
  await w.useCoin();
  const mint = fresh();
  w.lp.S.accounts[await w.L.coin(BigInt(UTICA))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: UTICA, founder: w.f.w.address, mint, quote_mint: WSOL, dbc_config: CONFIG, dbc_pool: fresh() })) };
  w.lp.S.accounts[await metadataAddress(mint)] = metadataAccount(mint, "Utica Coin", "UTICA", `https://vicinity.city/coin-meta/${mint}.json`);
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const j = JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.image, `https://vicinity.city/coin-meta/${mint}.png`, "the legacy picture URL");
  assert.equal((await w.env.DB.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, null, "not bound");
});


test("switch off at record time: a choice made while it was on is NOT published (the legacy JSON and badge), and stays unbound", async () => {
  const w = await world();
  const coin = await w.useCoin();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) });
  assert.equal(b.ok, true, JSON.stringify(b));
  w.env.COIN_V2_READY = "off"; // rolled back (the owner turned the template's look down)
  const mint = await launchOnChain(w);
  advance(10 * 60_000);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  const j = JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.image, `https://vicinity.city/coin-meta/${mint}.png`, "the legacy picture URL, not the template");
  assert.equal((await w.env.DB.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, null);
  assert.equal((await meta(w.env, `/coin-meta/${mint}.png`)).headers.get("location"), "/brand/vicinity-512.png");
  // the picture itself is still served (it was stored), whatever the switch says
  assert.equal((await meta(w.env, coin.art)).status, 200);
});

test("an approval built with the switch off binds no ready-made version, even if the switch is on again when the launch is recorded", async () => {
  const w = await world();
  await w.useCoin();
  w.env.COIN_V2_READY = "off";
  const c = await w.card(); // the legacy card: no ready key, the badge line
  assert.equal("ready" in c, false);
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c) });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal((await w.env.DB.prepare("SELECT approved_hash FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).approved_hash, null);
  w.env.COIN_V2_READY = "on";
  const mint = await launchOnChain(w);
  advance(10 * 60_000);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  const j = JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.image, `https://vicinity.city/coin-meta/${mint}.png`, "never a picture the owner did not see at approval");
  assert.equal((await w.env.DB.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, null);
});

test("approving writes the hold first, then reads the design again: a choice that lands meanwhile is never built from", async () => {
  const w = await world();
  await w.useCoin();
  const c = await w.card();
  // a "Use this coin" lands at the last moment before the owner's hold is written (after his request read the candidates): here the
  // design row changes right before that write. Built first and held after (as before), the approval would name a version nobody showed
  const db = w.env.DB;
  let landed = false;
  w.env.DB = new Proxy(db, { get: (t, k) => (k === "prepare" ? (sql) => {
    const st = t.prepare(sql);
    if (!/^INSERT INTO settings \(key, value\)/.test(sql)) return st;
    return { bind: (...a) => { const b = st.bind(...a); return { ...b, first: (...x) => b.first(...x), all: (...x) => b.all(...x), run: async () => {
      if (!landed && String(a[0]) === `lp_design_hold:${UTICA}`) { landed = true; await db.prepare("UPDATE city_coins SET updated_at = ? WHERE city_id = ?").bind("2026-10-20T12:00:00.900Z", UTICA).run(); }
      return b.run();
    } }; } };
  } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  const r = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c) });
  w.env.DB = db;
  assert.equal(landed, true, "the change landed inside the request");
  assert.deepEqual([r.status, r.error], [409, "design_changed"], JSON.stringify(r).slice(0, 300));
  assert.equal(w.lp.S.log.filter((l) => l.method === "simulateTransaction").length, 0, "nothing built");
  assert.equal((await db.prepare("SELECT approved_hash FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).approved_hash, null, "no version marked approved");
});

test("a launched coin whose symbol the site never read blocks approvals until it is known", async () => {
  const w = await world();
  await w.useCoin();
  await ensureLpCoinsSchema(w.env.DB);
  const other = fresh();
  await w.env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', ?, ?, ?, 'c', 'f', NULL, NULL, 'q', 'd', 'p', 'now')`).bind(PROGRAM, SYRACUSE, other).run();
  let c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), new RegExp(`A coin launched for another city \\(${SYRACUSE}\\) has a ticker this site could not read`));
  // the chain has it (SYRACUSE): stored, and the card is free again
  w.lp.S.accounts[await metadataAddress(other)] = metadataAccount(other, "Syracuse", "SYRACUSE", `https://vicinity.city/coin-meta/${other}.json`);
  c = await w.card();
  assert.equal(c.ok, true, JSON.stringify(c.reasons));
  assert.equal((await w.env.DB.prepare("SELECT symbol FROM lp_coins WHERE mint = ?").bind(other).first()).symbol, "SYRACUSE");
});
