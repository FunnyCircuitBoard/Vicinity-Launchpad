// Location without an account: the same checks and the same generic answers as /api/locate, only the community is kept,
// the hand-off to the phone's own browser, and the check again when the account is made.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, IN_NYC, IN_UTICA, V2, advance, browser, realClock, useClock, wallet } from "./helpers/world.js";
import { doEmail, doLocation, doTerms, doWallet, dumpAll, finish, journey, member, one, outbox, pickCommunity, rows, startSignup, stateOf } from "./helpers/signup.js";
import { communityOf } from "../src/attest.js";
import { locate } from "../src/community.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const comcast = (extra = {}) => ({ country: "US", asn: 7922, asOrganization: "Comcast Cable", latitude: 43.1, longitude: -75.2, ...extra });
const NET = { ip: "203.0.113.9", cf: comcast() };

test("every refusal of /api/locate is the same refusal here, with the same generic answer", async () => {
  const cases = {
    "inaccurate GPS": { location: { ...IN_UTICA, accuracy: 50_000 }, country: "US" },
    "no location": { country: "US" },
    "nonsense location": { location: { lat: "north", lon: 1 }, country: "US" },
    "a country with no data": { location: IN_UTICA, country: "ZZ" },
    "no country": { location: IN_UTICA },
  };
  const cfCases = {
    "a hosting network (VPN)": comcast({ asOrganization: "DigitalOcean, LLC" }),
    "a VPN company": comcast({ asOrganization: "NordVPN" }),
    "Tor": comcast({ country: "T1" }),
    "a connection far away (London)": comcast({ latitude: 51.5, longitude: -0.12 }),
    "another country": comcast({ country: "CA" }),
  };
  const mem = await member(env, box, { via: "google", net: NET });
  const answer = async (b, body, cf) => { const r = await b.send(b === mem.b ? "/api/locate" : "/api/signup/location", { method: "POST", body: b === mem.b ? { ...body, purpose: "home" } : body, cf }); return [r.status, await r.json()]; };
  for (const [name, body] of Object.entries(cases)) {
    const guest = browser(env, NET);
    await startSignup(guest);
    const [s1, a1] = await answer(guest, body, null); // (off Cloudflare, like the tests of /api/locate: the country comes from the page)
    const [s2, a2] = await answer(mem.b, body, null);
    assert.equal(s1, s2, name);
    assert.deepEqual(a1, a2, name);
    assert.equal(a1.ok, false, name);
  }
  for (const [name, cf] of Object.entries(cfCases)) {
    const guest = browser(env, NET);
    await startSignup(guest);
    const body = { location: IN_UTICA, country: "US" };
    const [s1, a1] = await answer(guest, body, cf);
    const [s2, a2] = await answer(mem.b, body, cf);
    assert.equal(s1, s2, name);
    assert.deepEqual(a1, a2, name);
    assert.equal(a1.error, "location_unverified", name);
    assert.equal((await stateOf(guest)).location.done, false, name + ": nothing was kept");
  }
});

test("the person must have a sign-up, must not be signed in, and the call must come from this site", async () => {
  const body = { location: IN_UTICA, country: "US" };
  const none = browser(env);
  let r = await none.send("/api/signup/location", { method: "POST", body });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "no_signup");

  const guest = browser(env);
  await startSignup(guest);
  r = await guest.send("/api/signup/location", { method: "POST", body, origin: null });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "wrong_origin");
  r = await guest.send("/api/signup/location", { method: "POST", body: undefined });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "bad_json");

  const mem = await member(env, box, { via: "google" });
  r = await mem.b.send("/api/signup/location", { method: "POST", body });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "already_signed_in");
  assert.equal((await mem.b.send("/api/signup/start", { method: "POST", body: {} })).status, 409);
});

test("coordinates are in no response and in no row of the database, at any step", async () => {
  const point = { lat: 43.1234567, lon: -75.2345678, accuracy: 31.5 };
  const seen = [];
  const b = browser(env, NET);
  const send = b.send;
  b.send = async (...a) => { const r = await send(...a); seen.push(await r.clone().text()); return r; };
  await startSignup(b);
  assert.equal((await doLocation(b, point)).ok, true);
  const h = await b.post("/api/signup/location/handoff");
  const phone = browser(env, NET);
  const done = await phone.post("/api/locate/handoff/complete", { code: h.code, location: point, country: "US" });
  assert.deepEqual(done, { ok: true, city: "Utica", nearby: null });
  await b.post("/api/signup/location/handoff/claim", { code: h.code });
  await doTerms(b);
  await doEmail(b, box, "coords@example.com");
  await doWallet(b, await wallet());
  await finish(b);
  const everything = seen.join("\n") + (await dumpAll(env.DB));
  for (const digits of ["43.1234567", "75.2345678", "1234567", "2345678", "31.5"]) assert.ok(!everything.includes(digits), digits);
});

test("a community inside the boundary is kept as the community; the proven community is never taken from the client", async () => {
  const b = browser(env);
  await startSignup(b);
  const r = await b.post("/api/signup/location", { location: IN_NYC, country: "US", community: { id: "5142056", name: "Utica" }, city: "5142056" });
  assert.deepEqual(r, { ok: true, community: { id: "5128581", name: "New York City", country: "US" } });
  const row = await one(env.DB, "SELECT loc_city, loc_name, loc_country, loc_choices, loc_net FROM signups");
  assert.deepEqual({ ...row }, { loc_city: "5128581", loc_name: "New York City", loc_country: "US", loc_choices: null, loc_net: null });
});

test("empty land: a choice only from the three that were offered, changeable, and never invented by the client", async () => {
  const b = browser(env);
  await startSignup(b);
  let r = await pickCommunity(b, "5142056");
  assert.equal(r.error, "no_choices", "before any location");
  await doLocation(b, IN_UTICA);
  r = await pickCommunity(b, "5142056");
  assert.equal(r.error, "no_choices", "inside a community there is nothing to choose");

  const loc = await b.post("/api/signup/location", { location: EMPTY, country: "US" });
  const offered = loc.choices.map((c) => c.id);
  assert.equal((await pickCommunity(b, "999999")).error, "bad_choice");
  assert.equal((await pickCommunity(b, undefined)).error, "bad_choice");
  assert.equal((await pickCommunity(b, { id: offered[0] })).error, "bad_choice");
  const notOffered = ["5128581", "5140405", "5106834", "5142056"].find((id) => !offered.includes(id));
  if (notOffered) assert.equal((await pickCommunity(b, notOffered)).error, "bad_choice", "a real community that was not offered");
  assert.equal((await stateOf(b)).location.done, false, "nothing was picked by the bad tries");
  assert.equal((await pickCommunity(b, Number(offered[1]))).ok, true, "a number works like its text");
  assert.equal((await pickCommunity(b, offered[0])).community.id, offered[0]);
  // another location check starts over: the earlier pick is gone
  await doLocation(b, IN_UTICA);
  assert.equal((await stateOf(b)).location.community.id, "5142056");
  assert.equal((await stateOf(b)).location.choices, undefined, "no choices left over from the earlier check");
});

test("the hand-off: the wallet app asks, the phone's own browser answers without any cookie, only that sign-up collects it, once", async () => {
  const wallet = browser(env, { ip: "203.0.113.20", cf: comcast({ asn: 701 }) });
  const phone = browser(env, { ip: "203.0.113.21", cf: comcast({ asn: 701 }) });
  await startSignup(wallet);
  const h = await wallet.post("/api/signup/location/handoff");
  assert.equal(h.ok, true);
  assert.match(h.url, /^https:\/\/vicinity\.test\/locate\?code=[A-Za-z0-9_-]{16,}$/);
  assert.ok(Date.parse(h.expiresAt) - Date.now() === 10 * 60_000);

  assert.deepEqual(await wallet.post("/api/signup/location/handoff/claim", { code: h.code }), { ok: false, status: "waiting" });
  // the page /locate uses today's routes: info says what the link is for
  const info = await phone.post("/api/locate/handoff/info", { code: h.code });
  assert.deepEqual(info, { ok: true, purpose: "signup", done: false, expiresAt: h.expiresAt });
  assert.equal((await phone.post("/api/signup/location/handoff/info", { code: h.code })).purpose, "signup", "the alias says the same");

  const done = await phone.post("/api/locate/handoff/complete", { code: h.code, location: IN_UTICA, country: "US" });
  assert.deepEqual(done, { ok: true, city: "Utica", nearby: null });
  assert.equal((await phone.post("/api/locate/handoff/complete", { code: h.code, location: IN_NYC, country: "US" })).error, "already_done");
  assert.equal((await phone.post("/api/locate/handoff/info", { code: h.code })).done, true);
  assert.equal((await stateOf(wallet)).location.done, false, "nothing reaches the sign-up until it is collected");

  // somebody else's sign-up, a signed-in member, and a stranger cannot collect it
  const other = browser(env);
  await startSignup(other);
  assert.deepEqual(await other.post("/api/signup/location/handoff/claim", { code: h.code }), { ok: false, status: "expired" });
  assert.equal((await browser(env).post("/api/signup/location/handoff/claim", { code: h.code })).error, "no_signup");
  const mem = await member(env, box, { via: "google" });
  assert.equal((await mem.b.post("/api/locate/handoff/claim", { code: h.code })).status, "expired", "today's claim route is not for sign-up links");

  const got = await wallet.post("/api/signup/location/handoff/claim", { code: h.code });
  assert.deepEqual(got, { ok: true, community: { id: "5142056", name: "Utica", country: "US" } });
  const s = await stateOf(wallet);
  assert.equal(s.location.done, true);
  assert.equal(s.location.community.name, "Utica");
  assert.equal((await one(env.DB, "SELECT loc_net FROM signups WHERE id = ?", (await one(env.DB, "SELECT id FROM signups ORDER BY created_at, rowid LIMIT 1")).id)).loc_net, "US|701", "the network of the wallet app is kept for the check at the end");
  assert.deepEqual(await wallet.post("/api/signup/location/handoff/claim", { code: h.code }), { ok: false, status: "expired" }, "replay: gone");
  assert.equal((await rows(env.DB, "SELECT id FROM handoffs")).length, 0, "nothing is kept");
});

test("the hand-off in empty land gives the three nearest, and the same choice rules apply", async () => {
  const wallet = browser(env), phone = browser(env);
  await startSignup(wallet);
  const h = await wallet.post("/api/signup/location/handoff");
  const done = await phone.post("/api/signup/location/handoff/complete", { code: h.code, location: EMPTY, country: "US" });
  assert.equal(done.city, null);
  assert.equal(done.nearby.length, 3);
  const got = await wallet.post("/api/signup/location/handoff/claim", { code: h.code });
  assert.equal(got.ok, true);
  assert.equal(got.choices.length, 3);
  assert.ok(got.choices.every((c) => c.country === "US" && c.km % 5 === 0));
  assert.equal((await stateOf(wallet)).location.done, false);
  assert.equal((await pickCommunity(wallet, got.choices[0].id)).ok, true);
});

test("hand-off safety: ten minutes, the same connection as the wallet app, the same risk checks, and a new link kills the old one", async () => {
  const wallet = browser(env, { ip: "203.0.113.20", cf: comcast({ asn: 701 }) });
  await startSignup(wallet);
  const h = await wallet.post("/api/signup/location/handoff");

  // a friend on another network operator cannot answer for you: the same generic answer, and the link stays open
  const friend = browser(env, { ip: "198.51.100.5", cf: comcast({ asn: 7922 }) });
  const bad = await friend.post("/api/locate/handoff/complete", { code: h.code, location: IN_UTICA, country: "US" });
  assert.equal(bad.error, "location_unverified");
  const vpn = browser(env, { cf: comcast({ asn: 701, asOrganization: "Hetzner Online" }) });
  assert.equal((await vpn.post("/api/locate/handoff/complete", { code: h.code, location: IN_UTICA, country: "US" })).error, "location_unverified", "same network id but a hosting company still refused");
  const inaccurate = browser(env, { cf: comcast({ asn: 701 }) });
  assert.equal((await inaccurate.post("/api/locate/handoff/complete", { code: h.code, location: { ...IN_UTICA, accuracy: 90_000 }, country: "US" })).error, "location_unverified");
  assert.deepEqual(await wallet.post("/api/signup/location/handoff/claim", { code: h.code }), { ok: false, status: "waiting" });

  // a new link replaces the old one
  const h2 = await wallet.post("/api/signup/location/handoff");
  assert.equal((await inaccurate.post("/api/locate/handoff/info", { code: h.code })).error, "expired");
  assert.equal((await wallet.post("/api/signup/location/handoff/claim", { code: h.code })).status, "expired");
  assert.equal((await inaccurate.post("/api/locate/handoff/info", { code: h2.code })).ok, true);

  // junk and ten minutes later
  assert.equal((await inaccurate.post("/api/locate/handoff/info", { code: "x" })).error, "expired");
  assert.equal((await inaccurate.post("/api/signup/location/handoff/complete", { code: "not-a-code-at-all-1234" })).error, "expired");
  useClock("2026-10-01T12:11:00Z");
  assert.equal((await inaccurate.post("/api/locate/handoff/info", { code: h2.code })).error, "expired");
  assert.equal((await inaccurate.post("/api/locate/handoff/complete", { code: h2.code, location: IN_UTICA, country: "US" })).error, "expired");
  assert.equal((await wallet.post("/api/signup/location/handoff/claim", { code: h2.code })).status, "expired");
});

test("a hand-off link made for a sign-up stops working the moment the switch is off, and the alias routes are not there", async () => {
  const wallet = browser(env), phone = browser(env);
  await startSignup(wallet);
  const h = await wallet.post("/api/signup/location/handoff");
  env.SIGNUP_FLOW = "v1";
  assert.equal((await phone.post("/api/locate/handoff/complete", { code: h.code, location: IN_UTICA, country: "US" })).error, "expired");
  const alias = await phone.send("/api/signup/location/handoff/complete", { method: "POST", body: { code: h.code, location: IN_UTICA } });
  assert.equal(alias.status, 404);
  assert.equal((await rows(env.DB, "SELECT result FROM handoffs"))[0].result, null, "nothing was recorded");
});

test("a link made by a member (today's hand-off) cannot be answered through the sign-up routes", async () => {
  const mem = await member(env, box, { via: "google" });
  const h = await mem.b.post("/api/locate/handoff", { purpose: "home" });
  const phone = browser(env);
  assert.equal((await phone.post("/api/signup/location/handoff/complete", { code: h.code, location: IN_UTICA, country: "US" })).error, "expired");
  assert.equal((await phone.post("/api/signup/location/handoff/info", { code: h.code })).error, "expired");
  // and today's own route still works for it
  assert.equal((await phone.post("/api/locate/handoff/complete", { code: h.code, location: IN_UTICA, country: "US" })).ok, true);
});

test("limits: 20 location checks an hour per sign-up and 60 per connection, counted before the check", async () => {
  const b = browser(env, { ip: "203.0.113.50" });
  await startSignup(b);
  const bad = { location: { ...IN_UTICA, accuracy: 50_000 }, country: "US" };
  for (let i = 0; i < 20; i++) assert.equal((await b.send("/api/signup/location", { method: "POST", body: bad })).status, 403, "try " + (i + 1));
  const r = await b.send("/api/signup/location", { method: "POST", body: { location: IN_UTICA, country: "US" } });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "slow_down");
  advance(61 * 60_000);

  // one connection, many sign-ups: 60 in the hour
  const ip = "203.0.113.51";
  let n = 0, last;
  for (let s = 0; s < 4 && !last; s++) {
    const g = browser(env, { ip });
    await startSignup(g);
    for (let i = 0; i < 20 && !last; i++) { const res = await g.send("/api/signup/location", { method: "POST", body: bad }); n++; if (res.status === 429) last = res; }
  }
  assert.equal(n, 61, "the 61st try from one connection is refused");
  assert.equal((await last.json()).error, "slow_down");
});

test("finish checks the location again: same network is fine; another operator, country, a VPN or a far-away connection clears ONLY the location", async () => {
  const setup = async (cf = comcast(), point = IN_UTICA, pick = false) => {
    const b = browser(env, { ip: "203.0.113.9", cf });
    const j = await journey(b, box, { via: "email", point, until: "wallet" });
    if (pick) assert.equal((await pickCommunity(b, j.location.choices[0].id)).ok, true);
    return { b, j };
  };

  // the same connection: fine
  let { b } = await setup();
  assert.equal((await finish(b)).ok, true);

  const attempts = {
    "another network operator": comcast({ asn: 701 }),
    "another country": comcast({ country: "CA" }),
    "a hosting company": comcast({ asOrganization: "Amazon.com, Inc." }),
    "Tor": comcast({ country: "T1" }),
    "a connection 500+ km from the community": comcast({ latitude: 51.5, longitude: -0.12 }),
  };
  for (const [name, cf] of Object.entries(attempts)) {
    ({ b } = await setup());
    const before = await b.get("/api/signup/state");
    assert.equal(before.state.next, "finish", name);
    const r = await b.send("/api/signup/finish", { method: "POST", body: {}, cf });
    assert.equal(r.status, 403, name);
    assert.deepEqual(await r.json(), { ok: false, error: "location_unverified" }, name);
    const s = await stateOf(b);
    assert.equal(s.location.done, false, name + ": the location is forgotten");
    assert.equal(s.terms.done, true, name + ": the Terms stay");
    assert.equal(s.account.done, true, name + ": the account stays");
    assert.equal(s.wallet.done, true, name + ": the proven wallet stays");
    assert.equal(s.next, "location", name);
    assert.equal((await b.get("/api/me")).pending.wallet.length > 20, true, name + ": still signed in with the wallet only");
    // one tap to redo it from the real connection, then the account is made
    assert.equal((await doLocation(b)).ok, true, name);
    assert.equal((await finish(b)).ok, true, name);
  }
});

test("a community picked from the three nearest only needs the same network and country at the end (the person is not at its centre)", async () => {
  const b = browser(env, { ip: "203.0.113.9", cf: comcast() });
  const j = await journey(b, box, { via: "email", point: EMPTY, until: "account" });
  assert.equal(j.location.choices.length, 3);
  assert.equal((await pickCommunity(b, j.location.choices[0].id)).ok, true);
  await doWallet(b, j.w);
  const far = comcast({ latitude: 48.0, longitude: -75.0 }); // the same operator, the geo-guess of the IP is far from every candidate
  const r = await (await b.send("/api/signup/finish", { method: "POST", body: {}, cf: far })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("communityOf is exactly what an attestation says (inside a community, and in empty land)", async () => {
  const mem = await member(env, box, { via: "google" });
  const decode = (t) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());
  for (const point of [IN_UTICA, IN_NYC, EMPTY]) {
    const res = await mem.b.post("/api/locate", { location: point, purpose: "home", country: "US" });
    assert.equal(res.ok, true);
    const att = decode(res.attestation);
    const mine = communityOf(await locate(env, "US", point.lon, point.lat));
    assert.equal(mine.city ? mine.city.id : null, att.city);
    assert.equal(mine.city ? mine.city.name : null, att.cityName);
    assert.deepEqual(mine.nearby, att.nearby);
  }
});
