// Opening another member's profile (GET /api/profile), finding members (GET /api/members/search), and what the answers contain:
// signed-in members only, every field the owner decided is public, and nothing that is not (real name, sign-in method, contact
// e-mail, phone, IP, sessions): every answer a browser gets is scanned for those. The blockchain and the price API are mocks that
// record what is asked, so the tests also prove that only $VICINITY and city coins are looked up, and only for the member being viewed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { HOUR, MINT, V2, advance, browser, chain, clock, loginBody, realClock, setHolding, useClock, wallet } from "./helpers/world.js";
import { PF, expectStatus, keysOf, one, quick, rows, seedUsers, spyDb } from "./helpers/profiles.js";
import { _resetPortfolio } from "../src/portfolio.js";
import { ensureProfilesSchema } from "../src/store.js";

beforeEach(() => { useClock("2026-10-01T12:00:00Z"); _resetPortfolio(); });
after(() => realClock());

const UTICA_COIN = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const iso = (ms) => new Date(ms).toISOString();
const sorted = (o) => Object.keys(o).sort();
const OTHER_TOKEN = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/**
 * The test blockchain (every holder, ranks) plus the answers about one wallet's balance of one mint, and the price API. It records
 * every balance question in `calls` ({ owner, mint }) and every price question in `priced`. rpcDown: the blockchain cannot be reached.
 */
function net({ balances = {}, prices = {} } = {}) {
  const base = chain();
  const n = { balances, prices, calls: [], priced: [], rpcDown: false, priceDown: false };
  n.give = (wallet, mint, amount) => { (n.balances[wallet] ||= {})[mint] = amount; if (mint === MINT) setHolding(wallet, amount); };
  n.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://lite-api.jup.ag/price/v3?ids=")) {
      const ids = url.split("ids=")[1].split(",");
      n.priced.push(...ids);
      if (n.priceDown) return new Response("down", { status: 500 });
      return new Response(JSON.stringify(Object.fromEntries(ids.filter((m) => m in n.prices).map((m) => [m, { usdPrice: n.prices[m] }]))));
    }
    if (init.body) {
      if (n.rpcDown) throw new Error("connection reset");
      let body = null;
      try { body = JSON.parse(init.body); } catch {}
      const list = body ? (Array.isArray(body) ? body : [body]) : [];
      if (list.length && list.every((b) => b.method === "getTokenAccountsByOwner")) {
        const answer = (b) => {
          const owner = b.params[0], mint = b.params[1].mint;
          n.calls.push({ owner, mint });
          const x = n.balances[owner]?.[mint] || 0;
          return { jsonrpc: "2.0", id: b.id, result: { value: x > 0 ? [{ account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(Math.round(x * 1e6)), decimals: 6, uiAmount: x } } } } } }] : [] } };
        };
        const out = list.map(answer);
        return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
      }
    }
    return base(url, init);
  };
  return n;
}

/** [parent key, key] for every key at any depth (an array's items count under the array's own key). */
function keyPairs(v, parent = "", out = []) {
  if (Array.isArray(v)) for (const x of v) keyPairs(x, parent, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push([parent, k]); keyPairs(x, k, out); }
  return out;
}

/** A launched $VICINITY, one launched city coin (Utica) and one that is only waiting for its contract to be checked. */
async function launched(extra = {}) {
  const env = PF({ VICINITY_MINT: MINT, ...extra });
  await ensureProfilesSchema(env.DB);
  const at = iso(clock.now - 86400_000);
  await env.DB.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, mint, launched_at, updated_at, created_at)
    VALUES ('5142056', 'Utica', 'US', 1, 1, 'Utica Coin', 'SOL', 'emerald', ?, ?, ?, ?)`).bind(UTICA_COIN, at, at, at).run();
  await env.DB.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, pending_mint, updated_at, created_at)
    VALUES ('5140405', 'Syracuse', 'US', 1, 1, 'Syracuse Coin', 'SOL', 'ocean', ?, ?, ?)`).bind(OTHER_TOKEN, at, at).run();
  return env;
}
/** Open a profile with this network behind it. */
const view = (p, n, handle) => p.send("/api/profile" + (handle === undefined ? "" : "?u=" + encodeURIComponent(handle)), { fetchImpl: n.fetch });

/* ---------------- who may look ---------------- */

test("signed out, a half-made account and a test-lab row see nothing on any profile route: sign_in, and no data in the answer", async () => {
  const env = PF();
  const bob = await quick(env, "BobBrave", { bio: "my secret bio" });
  const lab = await quick(env, "Labby", { provider: "testlab" });
  const pending = browser(env);
  await pending.post("/api/auth/wallet", await loginBody(await wallet()));
  const out = browser(env);
  for (const who of [out, pending, lab]) {
    // (a test-lab row's own portfolio is only its own wallet's balances: it is not one of the routes that show other members)
    for (const path of ["/api/profile?u=BobBrave", "/api/profile", "/api/members/search?q=bo", "/api/follows?u=BobBrave&list=followers", "/api/me/blocks", ...(who === lab ? [] : ["/api/me/portfolio"])]) {
      const r = await who.send(path);
      assert.equal(r.status, 401, path);
      const text = await r.text();
      assert.deepEqual(JSON.parse(text), { ok: false, error: "sign_in" }, path);
      assert.ok(!/BobBrave|secret|wallet/i.test(text));
    }
  }
  void bob;
});

/* ---------------- what the answer holds ---------------- */

test("a profile has exactly the fields the owner decided are public, and the member's full wallet address", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave", { bio: "Utica born" });
  await env.DB.prepare("UPDATE users SET created_at = '2026-09-28T08:00:00.000Z' WHERE handle = 'BobBrave'").run();
  const n = net();
  const r = await (await view(alice, n, "BobBrave")).json();
  assert.equal(r.ok, true);
  const p = r.profile;
  assert.deepEqual(sorted(p), ["badges", "bio", "counts", "handle", "holding", "home", "level", "portfolio", "posts", "since", "viewer", "wallet"]);
  assert.equal(p.handle, "BobBrave");
  assert.equal(p.since, "2026-09-28T08:00:00.000Z");
  assert.equal(p.bio, "Utica born");
  assert.equal(p.wallet, bob.w.address, "the whole address");
  assert.deepEqual(p.home, { id: "5142056", name: "Utica", country: "US" });
  assert.deepEqual(p.counts, { followers: 0, following: 0 });
  assert.deepEqual(sorted(p.viewer), ["blocked", "blockedBy", "followedBy", "following", "self"]);
  assert.equal(p.level, "member");
  assert.ok(p.badges.length >= 10);
  for (const b of p.badges) { assert.deepEqual(sorted(b), ["earned", "icon", "id", "name"]); assert.equal(typeof b.earned, "boolean"); }
  assert.deepEqual(p.badges.filter((b) => b.earned).map((b) => b.id), ["early", "verified", "local"]);
  assert.equal(p.holding, null, "before launch there is no holding");
  assert.deepEqual(p.portfolio, { asOf: iso(clock.now), totalUsd: 0, items: [], pricesComplete: true });
  assert.ok(!/message|inbox|chat|\bdm\b/i.test([...keysOf(r)].join(" ")), "no messaging anywhere");
});

test("a member without a community or a bio: home is null and bio is an empty text", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), drifter = await quick(env, "Drifter", { home: null });
  const p = (await (await view(alice, net(), "Drifter")).json()).profile;
  assert.equal(p.home, null);
  assert.equal(p.bio, "");
  assert.equal(p.badges.find((b) => b.id === "local").earned, false);
  void drifter;
});

test("NEVER in any answer: real name, sign-in method, contact e-mail, phone, IP, session; scanned over every profile route and both sides", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave", { bio: "hello" });
  await env.DB.prepare("UPDATE users SET contact_email = 'secret.mail@example.com', phone = '+1 555 123 4567', name = 'Zed Realname' WHERE handle = 'BobBrave'").run();
  bob.net.ip = "203.0.113.77";
  await bob.get("/api/me");
  await bob.post("/api/follow", { handle: "Alice77", follow: true });
  alice.net.ip = "198.51.100.9";
  const seen = [];
  for (const b of [alice, bob]) b.net.tap = async ({ path, response }) => { seen.push({ path, text: await response.text() }); };
  const n = net();
  for (const who of [alice, bob]) {
    await view(who, n, "BobBrave"); await view(who, n, "Alice77"); await view(who, n);
    await who.get("/api/members/search?q=al"); await who.get("/api/members/search?q=br");
    await who.get("/api/follows?u=BobBrave&list=followers"); await who.get("/api/follows?u=Alice77&list=following");
    await who.get("/api/me/blocks"); await who.send("/api/me/portfolio", { fetchImpl: n.fetch });
  }
  await alice.post("/api/block", { handle: "BobBrave", block: true });
  await view(alice, n, "BobBrave");
  assert.ok(seen.length >= 20);
  const jar = [...bob.jar.values(), ...alice.jar.values()].map(decodeURIComponent);
  const forbiddenText = ["Realname", "Zed ", "secret.mail", "555 123", "5551234567", "203.0.113", "198.51.100", "q-BobBrave", "q-Alice77", ...jar];
  const forbiddenKeys = ["provider", "provider_id", "providerId", "contact_email", "contactEmail", "email", "phone", "ip", "session", "sessionId", "user_id", "userId", "password", "terms_version", "badgesStored", "home_city", "created_at"];
  for (const { path, text } of seen) {
    for (const bad of forbiddenText) assert.ok(!text.includes(bad), `${path} contains ${bad}`);
    const keys = keysOf(JSON.parse(text));
    for (const k of forbiddenKeys) assert.ok(!keys.has(k), `${path} has the key ${k}`);
    // "name" is only ever the name of a badge, a community or a coin, never a person's
    for (const [parent, key] of keyPairs(JSON.parse(text))) if (key === "name") assert.ok(["badges", "home", "city", "items"].includes(parent), `${path}: a name under ${parent}`);
  }
  // the profile and the lists never carry an internal number for a person either
  for (const { path, text } of seen.filter((s) => /^\/api\/(profile|follows|members\/search)/.test(s.path))) {
    const j = JSON.parse(text);
    assert.ok(!("id" in (j.profile || {})), path);
    for (const u of j.users || j.results || []) assert.deepEqual(sorted(u), ["handle", "home"], path);
  }
});

/* ---------------- holdings, level, badges ---------------- */

test("a holder's profile: exact $VICINITY, rank among people, percentile, level and badges as the pass shows them", async () => {
  const env = await launched();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave"), carol = await quick(env, "CarolCalm"), dan = await quick(env, "DanDry");
  const n = net({ prices: { [MINT]: 0.002 } });
  n.give(carol.w.address, MINT, 5000); n.give(bob.w.address, MINT, 1234.5); n.give(alice.w.address, MINT, 10);
  const p = (await (await view(alice, n, "BobBrave")).json()).profile;
  assert.equal(p.holding.amount, 1234.5);
  assert.equal(p.holding.rank, 2);
  assert.equal(p.holding.total, 3, "three people hold it");
  assert.ok(Math.abs(p.holding.percentile - (2 / 3) * 100) < 1e-9);
  assert.equal(p.level, "holder");
  assert.equal(p.badges.find((b) => b.id === "holder").earned, true);
  assert.equal(p.badges.find((b) => b.id === "top10").earned, true, "rank 2 is in the top 10");
  assert.equal(p.badges.find((b) => b.id === "whale").earned, false);

  const none = (await (await view(alice, n, "DanDry")).json()).profile;
  assert.deepEqual(none.holding, { amount: 0, rank: null, total: 3, percentile: null }, "a member who holds nothing");
  assert.equal(none.level, "member");
  assert.equal(none.badges.find((b) => b.id === "holder").earned, false);
  void dan;
});

test("level and badges for an admin and for a city founder (and a Seed Steward)", async () => {
  const env = await launched();
  const alice = await quick(env, "Alice77"), admin = await quick(env, "AdminAl"), founder = await quick(env, "FounderFay"), steward = await quick(env, "StewardSam");
  env.ADMIN_WALLETS = admin.w.address;
  const seat = (p, city, name, status) => env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'US', ?, ?, 5, 1, ?, ?, ?)")
    .bind(city, name, p.id, p.w.address, status, iso(clock.now), iso(clock.now)).run();
  await seat(founder, "5142056", "Utica", "active"); await seat(steward, "5140405", "Syracuse", "steward");
  const n = net();
  const get = async (h) => (await (await view(alice, n, h)).json()).profile;
  const a = await get("AdminAl"), f = await get("FounderFay"), s = await get("StewardSam");
  assert.equal(a.level, "admin"); assert.equal(a.badges.find((b) => b.id === "admin").earned, true);
  assert.equal(f.level, "founder"); assert.equal(f.badges.find((b) => b.id === "city_founder").name, "City Founder");
  assert.equal(f.badges.find((b) => b.id === "city_founder").earned, true);
  assert.equal(s.level, "founder"); assert.equal(s.badges.find((b) => b.id === "city_founder").name, "Seed Steward");
  assert.equal((await get("Alice77")).badges.some((b) => b.id === "admin"), false, "only an admin has the admin badge");
});

test("the founder-ready badge is the last answer on the member's own dashboard, and only while they still hold something", async () => {
  const env = await launched();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  await env.DB.prepare("UPDATE users SET badges = '[\"founder_ready\",\"holder\"]' WHERE handle = 'BobBrave'").run();
  const n = net();
  assert.equal((await (await view(alice, n, "BobBrave")).json()).profile.badges.find((b) => b.id === "founder_ready").earned, false, "sold everything: no longer");
  n.give(bob.w.address, MINT, 5_000_000);
  assert.equal((await (await view(alice, n, "BobBrave")).json()).profile.badges.find((b) => b.id === "founder_ready").earned, true);
});

test("the blockchain being down is not an error: the profile opens with holding and portfolio null", async () => {
  const env = await launched();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  const n = net(); n.give(bob.w.address, MINT, 100); n.rpcDown = true;
  const noisy = console.error; const logged = [];
  console.error = (...a) => { logged.push(a.join(" ")); };
  let r;
  try { r = await view(alice, n, "BobBrave"); } finally { console.error = noisy; }
  assert.equal(r.status, 200);
  const p = (await r.json()).profile;
  assert.equal(p.holding, null);
  assert.equal(p.portfolio, null, "the page says: balances are loading, try again");
  assert.equal(p.handle, "BobBrave");
  assert.ok(logged.every((l) => !l.includes(bob.w.address)), "an address is never logged");
});

/* ---------------- the portfolio inside a profile ---------------- */

test("the portfolio of the viewed member: only $VICINITY and launched city coins are asked about, only for that member's wallet, and a repeat view is cached", async () => {
  const env = await launched();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  const n = net({ prices: { [MINT]: 0.002, [UTICA_COIN]: 0.5 } });
  n.give(bob.w.address, MINT, 1000); n.give(bob.w.address, UTICA_COIN, 50); n.give(bob.w.address, OTHER_TOKEN, 99); n.give(bob.w.address, "So11111111111111111111111111111111111111112", 7);
  n.give(alice.w.address, UTICA_COIN, 123456);
  const p = (await (await view(alice, n, "BobBrave")).json()).profile.portfolio;
  assert.equal(p.totalUsd, 27);
  assert.deepEqual(p.items.map((i) => [i.kind, i.symbol, i.amount, i.valueUsd, i.sharePct]), [["city", "UTICA", 50, 25, 92.5926], ["vicinity", "VICINITY", 1000, 2, 7.4074]]);
  assert.deepEqual(p.items[0].city, { id: "5142056", name: "Utica", country: "US" });
  assert.equal(p.pricesComplete, true);
  assert.ok(n.calls.length >= 2);
  for (const c of n.calls) { assert.equal(c.owner, bob.w.address, "never the viewer's own wallet, never anybody else's"); assert.ok([MINT, UTICA_COIN].includes(c.mint), "only allowed mints: " + c.mint); }
  assert.ok(n.priced.every((m) => [MINT, UTICA_COIN].includes(m)));
  assert.ok(!n.calls.some((c) => c.mint === OTHER_TOKEN) && !n.priced.includes(OTHER_TOKEN), "a coin that is still waiting for its contract check is not a coin yet");
  const before = n.calls.length;
  await view(alice, n, "BobBrave"); await view(alice, n, "bobbrave");
  assert.equal(n.calls.length, before, "viewed again within 20 seconds: no new question to the blockchain");
  advance(21_000);
  await view(alice, n, "BobBrave");
  assert.ok(n.calls.length > before, "after that it asks again");
});

test("a price that cannot be had leaves the coin in the list with its amount and no value", async () => {
  const env = await launched();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  const n = net({ prices: { [MINT]: 0.002 } }); n.priceDown = true;
  n.give(bob.w.address, MINT, 1000); n.give(bob.w.address, UTICA_COIN, 50);
  const p = (await (await view(alice, n, "BobBrave")).json()).profile.portfolio;
  assert.equal(p.totalUsd, null);
  assert.equal(p.pricesComplete, false);
  assert.deepEqual(p.items.map((i) => [i.symbol, i.amount, i.priceUsd, i.valueUsd]), [["VICINITY", 1000, null, null], ["UTICA", 50, null, null]], "no value to sort by: the bigger amount first");
});

/* ---------------- your own profile ---------------- */

test("with no username you get your own profile, marked as yours; with your own username too", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77", { bio: "me" }), bob = await quick(env, "BobBrave");
  for (const p of [(await (await view(alice, net())).json()).profile, (await (await view(alice, net(), "alice77")).json()).profile]) {
    assert.equal(p.handle, "Alice77");
    assert.equal(p.bio, "me");
    assert.deepEqual(p.viewer, { self: true, following: false, followedBy: false, blocked: false, blockedBy: false });
  }
  assert.equal((await (await view(bob, net())).json()).profile.viewer.self, true);
});

test("a member under a ban can still open their own profile, while everybody else gets not_found", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  await env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, '*', 1, 'x', ?, ?)").bind(bob.id, iso(clock.now), iso(clock.now + HOUR)).run();
  await expectStatus(await view(alice, net(), "BobBrave"), 404, "not_found");
  assert.equal((await (await view(bob, net())).json()).profile.handle, "BobBrave");
  assert.equal((await (await view(bob, net(), "BobBrave")).json()).profile.viewer.self, true);
});

/* ---------------- who can be found ---------------- */

test("unknown, test-lab and banned members are not found; the handle is matched without regard to case; odd input is only text", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), banned = await quick(env, "BannedBen"), lab = await quick(env, "Labby", { provider: "testlab" });
  await quick(env, "BobBrave");
  await env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, 'US', 1, 'x', ?, ?)").bind(banned.id, iso(clock.now), iso(clock.now + HOUR)).run();
  for (const h of ["Nobody", "BannedBen", "Labby", "bannedben", "Bob Brave", "' OR 1=1 --", "%", "_", "Bob%", "B_bBrave", "*", "../etc"]) await expectStatus(await view(alice, net(), h), 404, "not_found");
  for (const h of ["BobBrave", "bobbrave", "BOBBRAVE", "  bobbrave\t", "bObBrAvE"]) assert.equal((await view(alice, net(), h)).status, 200, h);
  for (const h of ["x".repeat(41), "a\nb", "a\u0000b", "\u007f"]) await expectStatus(await view(alice, net(), h), 400, "bad_request");
  advance(2 * HOUR);
  assert.equal((await view(alice, net(), "BannedBen")).status, 200, "the ban is over");
  void lab;
});

test("a ban in another country, or one that is over, hides nobody", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  await env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, 'FR', 1, 'x', ?, ?)").bind(bob.id, iso(clock.now), iso(clock.now + HOUR)).run();
  assert.equal((await view(alice, net(), "BobBrave")).status, 200);
});

test("120 profile views an hour: the 121st is slow_down (a refused one counts too), per viewer, and an hour later it is open", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  const n = net();
  for (let i = 0; i < 119; i++) assert.equal((await view(alice, n, "BobBrave")).status, 200);
  assert.equal((await view(alice, n, "Nobody")).status, 404, "the 120th, for somebody who is not there, still counts");
  await expectStatus(await view(alice, n, "BobBrave"), 429, "slow_down");
  await expectStatus(await view(alice, n, "BobBrave"), 429, "slow_down");
  assert.equal((await view(bob, n, "Alice77")).status, 200, "somebody else has their own count");
  advance(HOUR + 1000);
  assert.equal((await view(alice, n, "BobBrave")).status, 200);
});

/* ---------------- search ---------------- */

test("search: the start of a username, any case, at least two characters, at most eight, in alphabetical order, only username and community", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77");
  for (const n of ["Sam1", "sam2", "SAM3", "Samantha", "Sammy", "Samuel", "Samir", "Samson", "Samwise", "Sandy", "Sa"]) await quick(env, n);
  await quick(env, "Drifter", { home: null });
  const r = await alice.get("/api/members/search?q=sam");
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.handle), ["Sam1", "sam2", "SAM3", "Samantha", "Sammy", "Samir", "Samson", "Samuel"].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).slice(0, 8));
  assert.equal(r.results.length, 8);
  for (const x of r.results) assert.deepEqual(sorted(x), ["handle", "home"]);
  assert.deepEqual(r.results[0].home, { name: "Utica", country: "US" });
  assert.deepEqual((await alice.get("/api/members/search?q=SAMW")).results.map((x) => x.handle), ["Samwise"]);
  assert.deepEqual((await alice.get("/api/members/search?q=Dr")).results, [{ handle: "Drifter", home: null }]);
  assert.deepEqual((await alice.get("/api/members/search?q=%20%20sand%20")).results.map((x) => x.handle), ["Sandy"], "blanks around it do not matter");
  assert.deepEqual((await alice.get("/api/members/search?q=zz")).results, []);
});

test("search: one character, nothing or a very long text is a bad request; % and _ are only characters; SQL is only text", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77");
  await quick(env, "A_ice"); await quick(env, "Ab");
  for (const q of ["", "a", " a ", "   ", "x".repeat(41), "a\u0000b"]) await expectStatus(await alice.send("/api/members/search?q=" + encodeURIComponent(q)), 400, "bad_request");
  await expectStatus(await alice.send("/api/members/search"), 400, "bad_request");
  assert.deepEqual((await alice.get("/api/members/search?q=" + encodeURIComponent("%%"))).results, [], "a percent sign is not a wildcard");
  assert.deepEqual((await alice.get("/api/members/search?q=" + encodeURIComponent("A_"))).results.map((x) => x.handle), ["A_ice"], "an underscore is not a wildcard (Ab and Alice77 are not matched)");
  assert.deepEqual((await alice.get("/api/members/search?q=" + encodeURIComponent("' OR 1=1 --"))).results, []);
  assert.equal((await rows(env.DB, "SELECT name FROM sqlite_master WHERE name = 'users'")).length, 1);
});

test("search leaves out yourself, test-lab rows and members under an active ban", async () => {
  const env = PF();
  const alice = await quick(env, "Zoe1"), banned = await quick(env, "Zoe2");
  await quick(env, "Zoe3"); await quick(env, "Zoe4", { provider: "testlab" });
  await env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, '*', 1, 'x', ?, ?)").bind(banned.id, iso(clock.now), iso(clock.now + HOUR)).run();
  assert.deepEqual((await alice.get("/api/members/search?q=zo")).results.map((x) => x.handle), ["Zoe3"]);
  advance(2 * HOUR);
  assert.deepEqual((await alice.get("/api/members/search?q=zo")).results.map((x) => x.handle), ["Zoe2", "Zoe3"]);
});

test("60 searches an hour: the 61st is slow_down", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  for (let i = 0; i < 60; i++) assert.equal((await alice.send("/api/members/search?q=bo")).status, 200);
  await expectStatus(await alice.send("/api/members/search?q=bo"), 429, "slow_down");
  assert.equal((await bob.send("/api/members/search?q=al")).status, 200);
  advance(HOUR + 1000);
  assert.equal((await alice.send("/api/members/search?q=bo")).status, 200);
});

test("the username lookups use the unique index on lower(handle), not a scan of every member", async () => {
  const env = PF();
  env.DB = spyDb(env.DB);
  const alice = await quick(env, "Alice77");
  await seedUsers(env.DB, "Many", 200);
  const mark = env.DB.log.length;
  await view(alice, net(), "bobbrave");
  await alice.get("/api/members/search?q=man");
  await alice.post("/api/follow", { handle: "Many5", follow: true });
  const lookups = env.DB.log.slice(mark).filter((x) => /lower\(u\.handle\)/.test(x.sql));
  assert.ok(lookups.length >= 3, "the lookups were seen");
  for (const q of lookups) {
    const plan = (await env.DB._raw.prepare("EXPLAIN QUERY PLAN " + q.sql).all(...q.params)).map((r) => r.detail).join(" | ");
    assert.match(plan, /users_handle_unique/, plan);
    assert.ok(!/SCAN u\b|SCAN users/.test(plan.replace(/SCAN u USING/g, "")), "no full scan: " + plan);
  }
});

/* ---------------- posts ---------------- */

test("a profile shows the member's latest feed posts that the viewer may see (the feeds' own rule), newest first, five at most", async () => {
  const env = PF();
  const bob = await quick(env, "BobBrave"), alice = await quick(env, "Alice77"), carol = await quick(env, "CarolNYC", { home: { id: "5128581", name: "New York City", country: "US" } });
  await env.DB.prepare("UPDATE users SET early = 1").run();
  for (let i = 1; i <= 7; i++) assert.equal((await bob.post("/api/posts", { scope: "city", kind: "meme", body: "city meme " + i })).ok, true);
  await bob.post("/api/posts", { scope: "country", kind: "talk", body: "national talk" });
  const mid = (await rows(env.DB, "SELECT id FROM posts WHERE body = 'city meme 3'"))[0].id;
  await env.DB.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(mid).run();
  await alice.post("/api/posts", { parent: (await rows(env.DB, "SELECT id FROM posts WHERE body = 'city meme 7'"))[0].id, body: "a reply" });
  await bob.post("/api/posts", { parent: (await rows(env.DB, "SELECT id FROM posts WHERE body = 'city meme 7'"))[0].id, body: "bob replies" });
  const p = (await (await view(alice, net(), "BobBrave")).json()).profile;
  assert.deepEqual(p.posts.map((x) => x.body), ["national talk", "city meme 7", "city meme 6", "city meme 5", "city meme 4"]);
  for (const x of p.posts) assert.deepEqual(sorted(x), ["at", "body", "id", "image", "kind", "replies", "score"]);
  assert.equal(p.posts[1].replies, 2);
  const far = (await (await view(carol, net(), "BobBrave")).json()).profile;
  assert.deepEqual(far.posts.map((x) => x.body), ["national talk"], "NYC does not see Utica's local feed, but the country shares the national one");
  const own = (await (await view(bob, net())).json()).profile;
  assert.equal(own.posts.length, 5);
});

/* ---------------- /api/me and the portfolio route ---------------- */

test("/api/me with the switch on: profilesFlag in every shape, the bio in the signed-in ones, exact counts in the full one", async () => {
  const env = PF();
  const alice = await quick(env, "Alice77", { bio: "hi" }), bob = await quick(env, "BobBrave");
  await bob.post("/api/follow", { handle: "Alice77", follow: true });
  await alice.post("/api/follow", { handle: "BobBrave", follow: true });
  const out = browser(env);
  assert.deepEqual(Object.keys(await out.get("/api/me")), ["signedIn", "providers", "profilesFlag"]);
  const pending = browser(env);
  await pending.post("/api/auth/wallet", await loginBody(await wallet()));
  assert.deepEqual(Object.keys(await pending.get("/api/me")), ["signedIn", "providers", "pending", "proof", "profilesFlag"]);
  const lite = await alice.get("/api/me?lite=1");
  assert.deepEqual(Object.keys(lite), ["signedIn", "user", "providers", "fresh", "profilesFlag"]);
  assert.equal(lite.user.bio, "hi");
  assert.equal(lite.profilesFlag, true);
  const full = await alice.get("/api/me");
  assert.equal(full.profilesFlag, true);
  assert.equal(full.user.bio, "hi");
  assert.deepEqual(full.counts, { followers: 1, following: 1 });
  assert.equal(full.user.handle, "Alice77", "everything that was there is still there");
  assert.ok(full.level && full.holding && full.badges, "and the dashboard data too");
  const both = V2({ PROFILES: "on" });
  assert.deepEqual(Object.keys(await browser(both).get("/api/me")), ["signedIn", "providers", "signupFlow", "profilesFlag"]);
});

test("GET /api/me/portfolio: your own wallet only (a query changes nothing), null when the blockchain is down, and POST is refused", async () => {
  const env = await launched();
  const alice = await quick(env, "Alice77"), bob = await quick(env, "BobBrave");
  const n = net({ prices: { [MINT]: 0.01 } });
  n.give(alice.w.address, MINT, 300); n.give(bob.w.address, MINT, 999);
  const r = await (await alice.send("/api/me/portfolio?wallet=" + bob.w.address + "&u=BobBrave", { fetchImpl: n.fetch })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.portfolio.items.map((i) => [i.symbol, i.amount, i.valueUsd]), [["VICINITY", 300, 3]]);
  assert.ok(n.calls.every((c) => c.owner === alice.w.address));
  await expectStatus(await alice.send("/api/me/portfolio", { method: "POST", body: {} }), 405);
  _resetPortfolio();
  n.rpcDown = true;
  const down = await alice.send("/api/me/portfolio", { fetchImpl: n.fetch });
  assert.equal(down.status, 200);
  assert.deepEqual(await down.json(), { ok: true, portfolio: null });
});
