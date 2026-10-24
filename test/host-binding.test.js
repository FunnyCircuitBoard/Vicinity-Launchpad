// Session and challenge host binding (Citycoin.dev master v5, stage S04; master section 05 BR-03 "Authentication handover" and
// "Acceptance": wrong-origin signatures, copied cookies, replayed hand-offs and untrusted return URLs fail safely; src/hostbind.js).
// With SITE_ORIGIN and SITE_ORIGINS unset everything is exactly today's: no host is compared or written, the links and the signed text
// name the request's own host as before (on vicinity.city that is the configuration's value), and no column is added. Once SITE_ORIGINS
// lists a second host (a fixture: citycoin.dev, which is NOT attached to the Worker; every request here stays in this process), a
// session, pairing, hand-off or sign-up made on one host is unknown on any other; rows made before (host NULL) belong to vicinity.city,
// so every member signed in today stays signed in there; links come from the allowlist; a host outside it is refused.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApi } from "../src/index.js";
import * as W from "./helpers/world.js";
import { journey, one, outbox, rows } from "./helpers/signup.js";
import { base58Encode, buildMessage, parseMessage, statementFor } from "../src/solana.js";
import { NULL_HOST, hostBound, hostWrite, onThisHost, servedHost } from "../src/hostbind.js";
import { siteConfig } from "../src/site-config.js";
import { HOST_MIGRATION, HOST_SIGNUP_MIGRATION, ensureHostSchema } from "../src/store.js";
import { SECURITY_HEADERS, sha256 } from "../src/http.js";
import { checkSigned } from "../src/signed.js";

beforeEach(() => W.useClock("2026-10-20T12:00:00Z"));
after(() => W.realClock());

/** The fixture: citycoin.dev canonical, its www and vicinity.city served in place (the S06 shape; HOST_REDIRECT off). */
const SITES = Object.freeze({ SITE_ORIGIN: "https://citycoin.dev", SITE_ORIGINS: "https://citycoin.dev https://www.citycoin.dev https://vicinity.city" });
const VC = "https://vicinity.city", CC = "https://citycoin.dev";
const COOKIE_RE = /^vs=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/;
const ctx = { waitUntil() {}, passThroughOnException() {} };

const setSites = (env, on) => { if (on) Object.assign(env, SITES); else { delete env.SITE_ORIGIN; delete env.SITE_ORIGINS; } return env; };
/** Something made before the settings changed (today's rows: host NULL). */
async function before(env, fn) {
  const saved = [env.SITE_ORIGIN, env.SITE_ORIGINS];
  setSites(env, false);
  try { return await fn(); } finally { if (saved[0] !== undefined) env.SITE_ORIGIN = saved[0]; if (saved[1] !== undefined) env.SITE_ORIGINS = saved[1]; }
}
/** A browser on `origin` (the world's browser is fixed to vicinity.test): its own cookies, Origin like a real page, the same API. */
function at(env, origin, { ip, cf, jar = new Map() } = {}) {
  const net = { ip, cf };
  const send = async (path, { method = "GET", body, fetchImpl = W.chain(), from = origin } = {}) => {
    const headers = new Headers();
    if (from) headers.set("origin", from);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (net.ip) headers.set("cf-connecting-ip", net.ip);
    const request = new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (net.cf) Object.defineProperty(request, "cf", { value: net.cf });
    const res = await handleApi(request, env, fetchImpl, null);
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split("; "); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  };
  return { env, origin, jar, net, send, get: async (p) => (await send(p)).json(), post: async (p, body = {}) => (await send(p, { method: "POST", body })).json() };
}
/** The same cookies, carried by hand to another host (what a browser never does: host-only cookies). */
const copyTo = (b, origin, net = b.net) => at(b.env, origin, { ...net, jar: new Map(b.jar) });
/** A signed message naming `host` (the browser builds it from /api/message; dated on the test clock). */
async function signedFor(w, host, statement = statementFor("login")) {
  const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
  const message = buildMessage({ host, address: w.address, nonce, issuedAt: new Date(Date.now()).toISOString(), statement });
  return { address: w.address, message, signature: await w.sign(message) };
}
/** A member with a wallet, signed in before the settings changed (wallet + Google, the old sign-up path, on the world's host). */
const oldMember = (env) => before(env, () => W.person(env, { home: W.IN_UTICA }));
const columns = async (env, table) => (await rows(env.DB, `PRAGMA table_info(${table})`)).map((c) => c.name);
const signedIn = async (b) => (await b.get("/api/me?lite=1")).signedIn;
const sessionRows = (env) => rows(env.DB, "SELECT * FROM sessions ORDER BY created_at, id");
/** The session row a Set-Cookie answer made (only a hash of the token is stored). */
async function sessionOf(env, res) {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("vs="));
  return c ? one(env.DB, "SELECT * FROM sessions WHERE id = ?", await sha256(decodeURIComponent(c.slice(3).split(";")[0]))) : null;
}

/* ---------------------------------------------------------------- the switch */

test("the binding counts only once SITE_ORIGINS lists a host other than vicinity.city, or a site setting is refused (fails closed)", () => {
  for (const env of [{}, { SITE_ORIGIN: "" }, { SITE_ORIGINS: [] }, { SITE_ORIGIN: "https://vicinity.city" }, { SITE_ORIGINS: "https://vicinity.city" },
    { SITE_ORIGIN: "HTTPS://Vicinity.City", SITE_ORIGINS: "https://vicinity.city" }]) assert.equal(hostBound(siteConfig(env)), false, JSON.stringify(env));
  for (const env of [SITES, { SITE_ORIGINS: "https://vicinity.city https://citycoin.dev" }, { SITE_ORIGIN: "https://citycoin.dev", SITE_ORIGINS: "https://citycoin.dev" },
    { SITE_ORIGINS: "nonsense" }, { SITE_ORIGIN: "https://citycoin.dev" }, { SITE_ORIGIN: "http://vicinity.city" }]) assert.equal(hostBound(siteConfig(env)), true, JSON.stringify(env));
});

test("unset: servedHost gives exactly today's origin and host for every host (on vicinity.city, the configuration's own value)", () => {
  for (const url of ["https://vicinity.city/a?b=1", "https://VICINITY.CITY/a", "https://vicinity.city:443/a", "https://vicinity.city:8443/a", "https://vicinity.test/a",
    "https://citycoin.dev/a", "https://evil.example/a", "http://localhost:8787/a", "http://vicinity.city/a", "https://www.vicinity.city/a"]) {
    const s = servedHost({}, new Request(url)), u = new URL(url);
    assert.deepEqual(s, { bound: false, refused: false, origin: u.origin, host: u.host, key: null }, url);
  }
});

test("bound: the allowlist entry is the value used (never the request's text); a host outside it is refused; a local host is its own", () => {
  const cases = [
    ["https://citycoin.dev/x", { origin: CC, host: "citycoin.dev", key: "citycoin.dev" }],
    ["https://WWW.CityCoin.Dev/x", { origin: "https://www.citycoin.dev", host: "www.citycoin.dev", key: "www.citycoin.dev" }],
    ["https://vicinity.city/x", { origin: VC, host: "vicinity.city", key: "vicinity.city" }],
    ["https://vicinity.city:8443/x", { origin: VC, host: "vicinity.city", key: "vicinity.city" }],           // the port is not part of the entry
    ["https://www.vicinity.city/x", { origin: "https://www.vicinity.city", host: "www.vicinity.city", key: "www.vicinity.city" }], // a legacy host
    ["http://localhost:8787/x", { origin: "http://localhost:8787", host: "localhost:8787", key: "localhost" }],
  ];
  for (const [url, want] of cases) assert.deepEqual(servedHost(SITES, new Request(url)), { bound: true, refused: false, ...want }, url);
  for (const url of ["https://evil.example/x", "https://citycoin.dev.evil.example/x", "https://vicinity.city.evil.example/x", "https://evilcitycoin.dev/x",
    "https://vicinity.city./x", "https://127.0.0.2/x", "https://vicinity.test/x"]) {
    assert.deepEqual(servedHost(SITES, new Request(url)), { bound: true, refused: true, origin: null, host: null, key: null }, url);
  }
  // a refused setting: today's site, every other host refused
  assert.equal(servedHost({ SITE_ORIGINS: "nonsense" }, new Request("https://vicinity.city/x")).key, "vicinity.city");
  assert.equal(servedHost({ SITE_ORIGINS: "nonsense" }, new Request("https://citycoin.dev/x")).refused, true);
  // rows: NULL is vicinity.city; nothing matters while unbound
  const vc = servedHost(SITES, new Request(`${VC}/x`)), cc = servedHost(SITES, new Request(`${CC}/x`)), off = servedHost({}, new Request(`${CC}/x`));
  assert.equal(NULL_HOST, "vicinity.city");
  assert.deepEqual([onThisHost(vc, null), onThisHost(vc, undefined), onThisHost(vc, "vicinity.city"), onThisHost(vc, "citycoin.dev")], [true, true, true, false]);
  assert.deepEqual([onThisHost(cc, null), onThisHost(cc, "citycoin.dev"), onThisHost(cc, "www.citycoin.dev")], [false, true, false]);
  assert.deepEqual([onThisHost(off, null), onThisHost(off, "anything")], [true, true]);
  assert.equal(onThisHost(servedHost(SITES, new Request("https://evil.example/")), null), false);
  const db = W.newWorld().DB;
  assert.equal(hostWrite(db, "sessions", "id", off), null, "unbound: nothing is written");
  assert.throws(() => hostWrite(db, "users", "id", cc), /unknown table/);
  assert.throws(() => hostWrite(db, "sessions", "id", servedHost(SITES, new Request("https://evil.example/"))), /wrong_host/);
});

/* ---------------------------------------------------------------- unset: today's behaviour, no D1 change */

test("unset: sign-in, pairing, hand-off and Google links are today's (the request's own origin), sessions work by token alone, nothing is added to D1", async () => {
  const env = W.newWorld();
  const p = await oldMember(env);
  const vc = at(env, VC);
  // the wallet signs in on vicinity.city: today's cookie, exactly
  const r = await vc.send("/api/auth/wallet", { method: "POST", body: await signedFor(p.w, "vicinity.city") });
  assert.equal(r.status, 200);
  assert.match(r.headers.getSetCookie()[0], COOKIE_RE);
  assert.ok(!/Domain=/i.test(r.headers.getSetCookie()[0]), "host-only: no Domain attribute");
  assert.equal((await vc.post("/api/pair")).url.startsWith(`${VC}/connect?pair=`), true);
  assert.equal((await vc.post("/api/locate/handoff", { purpose: "home" })).url.startsWith(`${VC}/locate?code=`), true);
  const g = new URL((await vc.send("/api/auth/google/start")).headers.get("location"));
  assert.equal(g.searchParams.get("redirect_uri"), `${VC}/api/auth/google/callback`);
  assert.equal(parseMessage((await vc.get(`/api/message?address=${p.w.address}&action=login`)).message).host, "vicinity.city");
  // today a session is found by its token alone: the same cookie answers on any host that reaches the Worker (unchanged while unset)
  for (const o of [VC, CC, "https://vicinity.test"]) assert.equal(await signedIn(copyTo(vc, o)), true, o);
  // and on any other host the links and the signed text name that host, as before
  const other = at(env, "https://vicinity.test", { jar: new Map(vc.jar) });
  assert.equal((await other.post("/api/pair")).url.startsWith("https://vicinity.test/connect?pair="), true);
  // nothing was added: no column, no migration record
  for (const t of ["sessions", "pairs", "handoffs"]) assert.ok(!(await columns(env, t)).includes("host"), t);
  assert.equal(await one(env.DB, "SELECT id FROM schema_migrations WHERE id = ?", HOST_MIGRATION.id), null);
});

/* ---------------------------------------------------------------- existing members */

test("existing NULL-host sessions stay valid on vicinity.city once the binding counts, are signed out on citycoin.dev, and work everywhere again on rollback", async () => {
  const env = W.newWorld();
  const p = await oldMember(env);
  const beforeRows = await sessionRows(env);
  setSites(env, true);
  const vc = at(env, VC, { jar: new Map(p.jar) });
  const me = await vc.get("/api/me");
  assert.equal(me.signedIn, true, "a member signed in today is still signed in on vicinity.city");
  assert.equal(me.user.wallet, p.w.address);
  assert.equal(await signedIn(copyTo(vc, CC)), false, "the same cookie, copied to citycoin.dev, is signed out there");
  assert.equal(await signedIn(copyTo(vc, "https://www.citycoin.dev")), false);
  // the migration added a nullable column and rewrote nothing
  assert.ok((await columns(env, "sessions")).includes("host"));
  const afterRows = await sessionRows(env);
  assert.deepEqual(afterRows.map(({ host, ...r }) => { assert.equal(host, null); return r; }), beforeRows, "every existing row as it was, host NULL");
  // a sensitive action on vicinity.city still works with the old session (re-prove with a vicinity.city signature)
  const re = await vc.post("/api/auth/reprove", await signedFor(p.w, "vicinity.city"));
  assert.equal(re.ok, true, JSON.stringify(re));
  // rollback: SITE_ORIGINS unset, every session is found by its token again (today's)
  setSites(env, false);
  assert.equal(await signedIn(copyTo(vc, CC)), true);
});

/* ---------------------------------------------------------------- wrong-host session, copied cookie */

test("a session made on citycoin.dev records it and is refused on every other host (a copied cookie fails safely); cookies stay host-only", async () => {
  const env = setSites(W.newWorld(), true);
  const p = await oldMember(env);
  const cc = at(env, CC);
  const r = await cc.send("/api/auth/wallet", { method: "POST", body: await signedFor(p.w, "citycoin.dev") });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  const set = r.headers.getSetCookie()[0];
  assert.match(set, COOKIE_RE, "today's name, Path, HttpOnly, Secure and SameSite");
  assert.ok(!/Domain=/i.test(set) && !/__Host-|__Secure-/.test(set), "host-only, never shared across domains, same name");
  const made = (await sessionRows(env)).filter((s) => s.host === "citycoin.dev");
  assert.equal(made.length, 1, "the new session records citycoin.dev (an allowlist entry)");
  assert.equal(await signedIn(cc), true);
  for (const o of [VC, "https://www.citycoin.dev", "https://www.vicinity.city"]) {
    const copied = copyTo(cc, o);
    assert.equal(await signedIn(copied), false, `copied to ${o}`);
    const re = await copied.send("/api/auth/reprove", { method: "POST", body: await signedFor(p.w, new URL(o).host) });
    assert.deepEqual([re.status, (await re.json()).error], [401, "sign_in"], `a sensitive action with the copied cookie on ${o}`);
  }
  // a session made on this computer (wrangler dev) is that host's only
  const local = at(env, "http://localhost:8787");
  assert.equal((await local.send("/api/auth/wallet", { method: "POST", body: await signedFor(p.w, "localhost:8787") })).status, 200);
  assert.equal((await sessionRows(env)).filter((s) => s.host === "localhost").length, 1);
  assert.equal(await signedIn(copyTo(local, CC)), false);
  assert.equal(await signedIn(copyTo(cc, "http://localhost:8787")), false);
  // the cookie carried to a host outside the allowlist: refused before any route
  const evil = await copyTo(cc, "https://evil.example").send("/api/me");
  assert.deepEqual([evil.status, await evil.json(), evil.headers.get("location"), evil.headers.getSetCookie().length], [421, { error: "wrong_host" }, null, 0]);
});

/* ---------------------------------------------------------------- old-domain signatures */

test("a signature made for one host never authorizes a session on another (bound or not); the challenge names the allowlist entry", async () => {
  for (const bound of [false, true]) {
    const env = setSites(W.newWorld(), bound);
    const p = await oldMember(env);
    const n = (await sessionRows(env)).length;
    for (const [signedHost, postTo] of [["vicinity.city", CC], ["citycoin.dev", VC], ["citycoin.dev", "https://www.citycoin.dev"], ["vicinity.city", "https://vicinity.city:8443"]]) {
      if (!bound && postTo.endsWith(":8443")) continue; // (unset: a port is part of today's host, as before)
      const b = at(env, postTo);
      const r = await b.send("/api/auth/wallet", { method: "POST", body: await signedFor(p.w, signedHost) });
      if (bound && postTo === "https://vicinity.city:8443") { assert.equal(r.status, 200, "the same host on another port is the same allowlist entry"); continue; }
      assert.deepEqual([r.status, (await r.json()).error, r.headers.getSetCookie().length], [400, "wrong_site", 0], `${bound} ${signedHost} -> ${postTo}`);
      const v = await b.send("/api/verify", { method: "POST", body: await signedFor(p.w, signedHost, statementFor("verify")) });
      assert.deepEqual([v.status, (await v.json()).error], [400, "wrong_site"], `verify ${signedHost} -> ${postTo}`);
    }
    assert.equal((await sessionRows(env)).length, n + (bound ? 1 : 0), "no session from a wrong-host signature");
  }
  const env = setSites(W.newWorld(), true);
  const p = await oldMember(env);
  // the text a wallet signs names the allowlist entry: lower case, without a port, whatever the request's spelling
  for (const [origin, host] of [[CC, "citycoin.dev"], ["https://WWW.CITYCOIN.DEV", "www.citycoin.dev"], ["https://vicinity.city:8443", "vicinity.city"], [VC, "vicinity.city"]]) {
    const m = parseMessage((await at(env, origin).get(`/api/message?address=${p.w.address}&action=login`)).message);
    assert.equal(m.host, host, origin);
  }
  const refused = await at(env, "https://citycoin.dev.evil.example").send(`/api/message?address=${p.w.address}&action=login`);
  assert.deepEqual([refused.status, await refused.json()], [421, { error: "wrong_host" }]);
  // a message used once is refused the next time (single use, as before) and, on another host, for the host first
  const body = await signedFor(p.w, "citycoin.dev");
  assert.equal((await at(env, CC).send("/api/auth/wallet", { method: "POST", body })).status, 200);
  assert.equal((await (await at(env, CC).send("/api/auth/wallet", { method: "POST", body })).json()).error, "replayed");
  assert.equal((await (await at(env, VC).send("/api/auth/wallet", { method: "POST", body })).json()).error, "wrong_site");
});

test("src/signed.js keeps its host binding: the text must name the host it is checked on; a refused host (null) matches nothing", async () => {
  const w = await W.wallet();
  const bad = (error, status = 400) => ({ error, status });
  const req = (url) => new Request(url, { method: "POST" });
  const now = Date.now();
  const forVC = await signedFor(w, "vicinity.city");
  assert.equal((await checkSigned(forVC, req(`${VC}/api/auth/wallet`), now, ["login"], bad)).parsed.host, "vicinity.city", "left out: the request's own host, as before");
  assert.equal((await checkSigned(forVC, req(`${CC}/api/auth/wallet`), now, ["login"], bad)).error, "wrong_site");
  assert.equal((await checkSigned(forVC, req("https://vicinity.city:8443/api/auth/wallet"), now, ["login"], bad, null, "vicinity.city")).parsed.host, "vicinity.city", "the served host decides");
  assert.equal((await checkSigned(forVC, req(`${VC}/api/auth/wallet`), now, ["login"], bad, null, "citycoin.dev")).error, "wrong_site");
  for (const host of [null, ""]) assert.equal((await checkSigned(forVC, req(`${VC}/api/auth/wallet`), now, ["login"], bad, null, host)).error, "wrong_site", String(host));
});

/* ---------------------------------------------------------------- replayed hand-offs */

test("a pairing made on vicinity.city cannot be read, approved or finished on citycoin.dev (no session there); on its own host it works", async () => {
  const env = setSites(W.newWorld(), true);
  const p = await oldMember(env);
  const computer = at(env, VC);
  const made = await computer.post("/api/pair");
  assert.equal(made.url, `${VC}/connect?pair=${made.code}`, "the QR code names the allowlist entry's origin");
  assert.equal((await one(env.DB, "SELECT host FROM pairs")).host, "vicinity.city");
  const phoneCC = at(env, CC);
  assert.deepEqual(await phoneCC.get(`/api/pair?code=${made.code}`), { status: "expired" });
  const approve = await phoneCC.send("/api/auth/wallet", { method: "POST", body: { ...(await signedFor(p.w, "citycoin.dev", statementFor("login", { pin: made.pin }))), pair: made.code } });
  assert.deepEqual([approve.status, (await approve.json()).error], [410, "pair_expired"]);
  assert.equal((await one(env.DB, "SELECT wallet FROM pairs")).wallet, null, "not approved");
  // approved on its own host, then the code replayed on citycoin.dev to collect the session: refused, nothing made
  const phoneVC = at(env, VC);
  assert.equal((await phoneVC.post("/api/auth/wallet", { ...(await signedFor(p.w, "vicinity.city", statementFor("login", { pin: made.pin }))), pair: made.code })).paired, true);
  const n = (await sessionRows(env)).length;
  const stolen = await at(env, CC).send("/api/pair/finish", { method: "POST", body: { code: made.code } });
  assert.deepEqual([stolen.status, (await stolen.json()).status, stolen.headers.getSetCookie().length], [410, "expired", 0]);
  assert.equal((await sessionRows(env)).length, n);
  const done = await computer.send("/api/pair/finish", { method: "POST", body: { code: made.code } });
  assert.equal(done.status, 200);
  assert.equal((await sessionOf(env, done)).host, "vicinity.city", "the session lands on the host the pairing was made on");
  assert.equal(await signedIn(computer), true);
  // a pairing made on citycoin.dev names citycoin.dev
  assert.match((await at(env, CC).post("/api/pair")).url, /^https:\/\/citycoin\.dev\/connect\?pair=[A-Za-z0-9_-]+$/);
});

test("a wallet-link carry code made on vicinity.city is unknown on citycoin.dev (nothing opened, marked or linked), and works on vicinity.city", async () => {
  const env = W.V2();
  const box = outbox();
  const PHONE = { ip: "198.51.100.7", cf: { country: "US", latitude: 43.1, longitude: -75.2, asn: 21928, asOrganization: "T-Mobile USA, Inc." } };
  // a member without a wallet, signed in before the settings changed (their session row: host NULL, which is vicinity.city)
  const m = await before(env, async () => { const b = W.browser(env, PHONE); const j = await journey(b, box, { via: "google" }); assert.equal(j.finish.ok, true); return { b, ...j }; });
  setSites(env, true);
  const safari = at(env, VC, { ...PHONE, jar: new Map(m.b.jar) });
  const made = await safari.post("/api/me/wallet/carry", {});
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.url, `${VC}/connect?link=${made.code}`);
  assert.equal((await one(env.DB, "SELECT host FROM handoffs WHERE kind = 'carry'")).host, "vicinity.city");
  const owner = await one(env.DB, "SELECT id, handle FROM users WHERE provider = 'google' AND provider_id = ?", m.sub);
  // the wallet app's browser on citycoin.dev: the code is unknown there, and nothing about it changes
  const app = at(env, CC, PHONE);
  const seen = await app.send("/api/me/wallet/carry/info", { method: "POST", body: { code: made.code } });
  assert.deepEqual([seen.status, (await seen.json()).error, seen.headers.getSetCookie().length], [410, "carry_expired", 0]);
  const claim = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...(await signedFor(m.w, "citycoin.dev", statementFor("link", { handle: owner.handle }))) } });
  assert.deepEqual([claim.status, (await claim.json()).error, claim.headers.getSetCookie().length], [410, "carry_expired", 0]);
  const row = await one(env.DB, "SELECT opener, refused_at, result FROM handoffs WHERE kind = 'carry'");
  assert.deepEqual(row, { opener: null, refused_at: null, result: null }, "not opened, not marked, not used");
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", owner.id)).wallet, null, "no wallet linked");
  // on its own host the same code works: opened, signed for vicinity.city, claimed, and the app's session records vicinity.city
  const appVC = at(env, VC, PHONE);
  assert.equal((await appVC.send("/api/me/wallet/carry/info", { method: "POST", body: { code: made.code } })).status, 200);
  const ok = await appVC.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...(await signedFor(m.w, "vicinity.city", statementFor("link", { handle: owner.handle }))) } });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.match(ok.headers.getSetCookie().find((c) => c.startsWith("vs=")), COOKIE_RE);
  assert.equal((await sessionOf(env, ok)).host, "vicinity.city");
});

test("a location hand-off and a sign-up are bound to their host; a copied sign-up cookie finds nothing on another host", async () => {
  const env = setSites(W.newWorld(), true);
  const p = await oldMember(env);
  const vc = at(env, VC, { jar: new Map(p.jar) });
  const h = await vc.post("/api/locate/handoff", { purpose: "home" });
  assert.equal(h.url, `${VC}/locate?code=${h.code}`);
  assert.equal((await one(env.DB, "SELECT host FROM handoffs WHERE kind = 'locate'")).host, "vicinity.city");
  for (const path of ["/api/locate/handoff/info", "/api/locate/handoff/complete"]) {
    const r = await at(env, CC).send(path, { method: "POST", body: { code: h.code, location: W.IN_UTICA, country: "US" } });
    assert.deepEqual([r.status, (await r.json()).error], [410, "expired"], path);
  }
  assert.equal((await at(env, VC).send("/api/locate/handoff/info", { method: "POST", body: { code: h.code } })).status, 200);
  // the new sign-up (v2): started on citycoin.dev, its vsu cookie copied to vicinity.city finds nothing there
  const v2 = setSites(W.V2(), true);
  const s = at(v2, CC);
  assert.equal((await s.post("/api/signup/start")).ok, true);
  assert.equal((await one(v2.DB, "SELECT host FROM signups")).host, "citycoin.dev");
  assert.ok((await columns(v2, "signups")).includes("host"));
  assert.equal(await one(v2.DB, "SELECT id FROM schema_migrations WHERE id = ?", HOST_SIGNUP_MIGRATION.id) !== null, true);
  const copied = copyTo(s, VC);
  const terms = await copied.send("/api/signup/terms", { method: "POST", body: { version: "2026-10-01" } });
  assert.deepEqual([terms.status, (await terms.json()).error], [401, "no_signup"]);
  assert.equal((await one(v2.DB, "SELECT terms_version FROM signups")).terms_version, null, "nothing recorded through the copied cookie");
  assert.equal((await s.post("/api/signup/terms", { version: "2026-10-01" })).ok, true, "on its own host the sign-up goes on");
});

test("a Google callback replayed on another host fails: the return address differs, so the code is not accepted, and no session is made", async () => {
  const env = setSites(W.newWorld(), true);
  const p = await oldMember(env);
  const cc = at(env, CC);
  const start = await cc.send("/api/auth/google/start");
  const go = new URL(start.headers.get("location"));
  assert.equal(go.origin, "https://accounts.google.com");
  assert.equal(go.searchParams.get("redirect_uri"), `${CC}/api/auth/google/callback`);
  // Google exchanges a code only with the return address it was issued for (RFC 6749 section 4.1.3); this stand-in does the same
  const issuedFor = go.searchParams.get("redirect_uri");
  const seen = [];
  const google = async (url, init) => {
    const form = new URLSearchParams(init.body);
    seen.push(form.get("redirect_uri"));
    if (form.get("redirect_uri") !== issuedFor) return new Response(JSON.stringify({ error: "redirect_uri_mismatch" }), { status: 400 });
    return new Response(JSON.stringify({ id_token: "x." + Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: "gid", sub: p.id, given_name: "P" })).toString("base64url") + ".y" }));
  };
  const state = go.searchParams.get("state");
  const n = (await sessionRows(env)).length;
  const replay = await copyTo(cc, VC).send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: google });
  assert.equal(replay.headers.get("location"), "/connect?error=login_failed");
  assert.deepEqual(seen, [`${VC}/api/auth/google/callback`], "the callback on vicinity.city names vicinity.city's address, never citycoin.dev's");
  assert.ok(!replay.headers.getSetCookie().some((c) => c.startsWith("vs=")), "no session cookie");
  assert.equal((await sessionRows(env)).length, n);
  // on its own host: signed in, the session records citycoin.dev
  const ok = await cc.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: google });
  assert.equal(ok.headers.get("location"), "/dashboard");
  assert.equal((await sessionOf(env, ok)).host, "citycoin.dev");
});

/* ---------------------------------------------------------------- untrusted return URLs and hosts */

test("untrusted return addresses: request parameters and the Host never choose a redirect target, a link or the Google return address", async () => {
  const env = setSites(W.newWorld(), true);
  const p = await oldMember(env);
  const cc = at(env, CC, { jar: new Map() });
  const start = await cc.send("/api/auth/google/start?next=https%3A%2F%2Fevil.example&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&return=%2F%2Fevil.example");
  const loc = start.headers.get("location");
  assert.equal(new URL(loc).origin, "https://accounts.google.com");
  assert.equal(new URL(loc).searchParams.get("redirect_uri"), `${CC}/api/auth/google/callback`);
  assert.ok(!loc.includes("evil") && !start.headers.getSetCookie().join().includes("evil"));
  // every answer of the callback is a path of this site
  for (const q of ["error=access_denied&next=https://evil.example", "code=c&state=nope&redirect_uri=https://evil.example", "next=//evil.example"]) {
    const r = await cc.send(`/api/auth/google/callback?${q}`);
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /^\/connect\?error=[a-z_]+$/, q);
  }
  // a Host outside the allowlist (spoofed, or a look-alike) is refused before any route: no link, no Location, no cookie, no row
  const snapshot = async () => JSON.stringify([await rows(env.DB, "SELECT * FROM sessions ORDER BY id"), await rows(env.DB, "SELECT * FROM pairs ORDER BY id"), await rows(env.DB, "SELECT * FROM handoffs ORDER BY id")]);
  const rowsBefore = await snapshot();
  for (const origin of ["https://evil.example", "https://citycoin.dev.evil.example", "https://vicinity.city.evil.example", "https://evilcitycoin.dev", "https://vicinity.test"]) {
    for (const [method, path, body] of [["GET", "/api/auth/google/start"], ["POST", "/api/pair", {}], ["POST", "/api/locate/handoff", { purpose: "home" }],
      ["GET", `/api/message?address=${p.w.address}&action=login`], ["POST", "/api/auth/wallet", await signedFor(p.w, new URL(origin).host)], ["GET", "/api/health"]]) {
      const b = at(env, origin, { jar: new Map(p.jar) });
      const r = await b.send(path, { method, body });
      assert.deepEqual([r.status, await r.json(), r.headers.get("location"), r.headers.getSetCookie().length], [421, { error: "wrong_host" }, null, 0], `${method} ${origin}${path}`);
      // and through the Worker's own entry, for every path the Worker answers (the official list and the coin metadata too)
      const e = await worker.fetch(new Request(origin + path, { method, headers: { origin, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
      assert.equal(e.status, 421, `entry ${method} ${origin}${path}`);
    }
    for (const path of ["/official-coins.csv", "/coin-meta/x.json", "/brand/vicinity-512.png"]) {
      const e = await worker.fetch(new Request(origin + path), { ...env, ASSETS: { fetch: async () => new Response("asset") } }, ctx);
      assert.deepEqual([e.status, e.headers.get("location")], [421, null], `entry ${origin}${path}`);
    }
  }
  assert.equal(await snapshot(), rowsBefore);
  // the refusal carries today's security headers and no caching
  const r = await worker.fetch(new Request("https://evil.example/api/health"), env, ctx);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v, k);
  // this computer is served (wrangler dev), and its links name it
  assert.equal((await worker.fetch(new Request("http://localhost:8787/api/health"), env, ctx)).status, 200);
  assert.match((await at(env, "http://localhost:8787").post("/api/pair")).url, /^http:\/\/localhost:8787\/connect\?pair=/);
});

test("every hand-off, QR, pairing and Google return link names the allowlist entry's origin, never the request's own spelling of its host", async () => {
  const env = setSites(W.V2(), true);
  const box = outbox();
  const PHONE = { ip: "198.51.100.7", cf: { country: "US", latitude: 43.1, longitude: -75.2, asn: 21928, asOrganization: "T-Mobile USA, Inc." } };
  const m = await before(env, async () => { const b = W.browser(env, PHONE); const j = await journey(b, box, { via: "google" }); assert.equal(j.finish.ok, true); return { b, ...j }; });
  // the same host on another port (the request's text differs from the allowlist entry): every link is the entry's origin
  const o = "https://vicinity.city:8443";
  const b = at(env, o, { ...PHONE, jar: new Map(m.b.jar) });
  assert.equal(await signedIn(b), true, "a NULL-host session is vicinity.city's, on any port of it");
  assert.match((await b.post("/api/pair")).url, /^https:\/\/vicinity\.city\/connect\?pair=[A-Za-z0-9_-]+$/);
  assert.match((await b.post("/api/me/wallet/carry", {})).url, /^https:\/\/vicinity\.city\/connect\?link=[A-Za-z0-9_-]+$/);
  assert.match((await b.post("/api/locate/handoff", { purpose: "home" })).url, /^https:\/\/vicinity\.city\/locate\?code=[A-Za-z0-9_-]+$/);
  assert.equal(new URL((await b.send("/api/auth/google/start")).headers.get("location")).searchParams.get("redirect_uri"), `${VC}/api/auth/google/callback`);
  const s = at(env, "https://WWW.CityCoin.dev:8443", PHONE);
  assert.equal((await s.post("/api/signup/start")).ok, true);
  assert.match((await s.post("/api/signup/location/handoff")).url, /^https:\/\/www\.citycoin\.dev\/locate\?code=[A-Za-z0-9_-]+$/);
  assert.equal((await one(env.DB, "SELECT host FROM signups")).host, "www.citycoin.dev");
  // and the Google callback names the same address the start did (the token exchange is made with it)
  const seen = [];
  const g = at(env, o, { jar: new Map() });
  const state = new URL((await g.send("/api/auth/google/start")).headers.get("location")).searchParams.get("state");
  await g.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: async (url, init) => { seen.push(new URLSearchParams(init.body).get("redirect_uri")); return new Response("{}", { status: 400 }); } });
  assert.deepEqual(seen, [`${VC}/api/auth/google/callback`]);
});

test("every way a session is made records its host: the new sign-up's finish (Google, e-mail), a password log-in and reset, a pending transfer proof, a link pairing", async () => {
  const env = setSites(W.V2(), true);
  const box = outbox();
  const PHONE = { ip: "198.51.100.7", cf: { country: "US", latitude: 43.1, longitude: -75.2, asn: 21928, asOrganization: "T-Mobile USA, Inc." } };
  // the whole new sign-up on citycoin.dev, by Google and by e-mail: the account's first session records citycoin.dev
  for (const via of ["google", "email"]) {
    const b = at(env, CC, PHONE);
    const j = await journey(b, box, { via });
    assert.equal(j.finish.ok, true, JSON.stringify(j.finish));
    const s = await one(env.DB, "SELECT s.host FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.provider = ? AND u.provider_id = ?", via, via === "google" ? j.sub : j.email);
    assert.equal(s.host, "citycoin.dev", via);
    assert.equal(await signedIn(b), true);
    assert.equal(await signedIn(copyTo(b, VC)), false, `${via}: the new member's cookie, copied to vicinity.city`);
    if (via !== "email") continue;
    // a password log-in on vicinity.city records vicinity.city
    const vc = at(env, VC, PHONE);
    const login = await vc.send("/api/auth/email/login", { method: "POST", body: { email: j.email, password: "correct horse battery staple" } });
    assert.equal(login.status, 200, JSON.stringify(await login.clone().json()));
    assert.equal((await sessionOf(env, login)).host, "vicinity.city");
    // a link pairing made on vicinity.city by this member (no wallet yet): its statement is not given out on citycoin.dev
    const pairing = await at(env, VC, { ...PHONE, jar: new Map(vc.jar) }).post("/api/pair", { purpose: "link" });
    assert.equal(pairing.ok, true, JSON.stringify(pairing));
    const w = await W.wallet();
    const other = await at(env, CC, PHONE).send(`/api/message?address=${w.address}&action=link&pair=${pairing.code}`);
    assert.deepEqual([other.status, (await other.json()).error], [410, "pair_expired"]);
    assert.equal((await at(env, VC, PHONE).send(`/api/message?address=${w.address}&action=link&pair=${pairing.code}`)).status, 200);
    // a password reset on citycoin.dev: the new session (made in the reset's own transaction) records citycoin.dev
    const rs = at(env, CC, PHONE);
    assert.equal((await (await rs.send("/api/auth/password/reset/start", { method: "POST", body: { email: j.email }, fetchImpl: box.fetch })).json()).ok, true);
    const code = [...box.sent].reverse().find((x) => x.to === j.email && x.kind === "reset").code;
    const reset = await rs.send("/api/auth/password/reset", { method: "POST", body: { email: j.email, code, password: "another long passphrase here" } });
    assert.equal(reset.status, 200, JSON.stringify(await reset.clone().json()));
    assert.equal((await sessionOf(env, reset)).host, "citycoin.dev");
  }
  // a pending tiny-transfer proof (no account yet) records its host too
  const t = at(env, CC);
  const w = await W.wallet();
  const started = await t.send("/api/auth/transfer", { method: "POST", body: { address: w.address } });
  assert.equal(started.status, 200);
  assert.equal((await sessionOf(env, started)).host, "citycoin.dev");
  const check = await copyTo(t, VC).send("/api/auth/transfer/check", { method: "POST", body: {} });
  assert.deepEqual([check.status, (await check.json()).error], [400, "no_proof"], "the proof's cookie, copied to vicinity.city, finds no proof there");
});

/* ---------------------------------------------------------------- the migration */

test("the host columns are added lazily, once, only while the binding counts; additive and nullable; safe to repeat", async () => {
  const env = W.newWorld();
  await oldMember(env);
  for (const t of ["sessions", "pairs", "handoffs"]) assert.ok(!(await columns(env, t)).includes("host"), `unset: no ${t}.host`);
  setSites(env, true);
  // a request with no cookie and no write touches nothing
  await at(env, VC).get("/api/me");
  assert.ok(!(await columns(env, "sessions")).includes("host"));
  await at(env, CC).post("/api/pair");
  for (const t of ["sessions", "pairs", "handoffs"]) {
    const col = (await rows(env.DB, `PRAGMA table_info(${t})`)).find((c) => c.name === "host");
    assert.deepEqual([col.type, col.notnull, col.dflt_value], ["TEXT", 0, null], t);
  }
  assert.notEqual(await one(env.DB, "SELECT id FROM schema_migrations WHERE id = ?", HOST_MIGRATION.id), null);
  await ensureHostSchema(env.DB);
  await ensureHostSchema(W.newWorld().DB);
  assert.equal((await one(env.DB, "SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?", HOST_MIGRATION.id)).n, 1);
  // the old sessions keep host NULL (vicinity.city): nothing was rewritten
  assert.ok((await rows(env.DB, "SELECT host FROM sessions")).every((r) => r.host === null));
});
