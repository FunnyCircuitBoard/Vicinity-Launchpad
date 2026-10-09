// Phones live inside the wallet app (src/walletlink.js, owner decision F4 of 10 Oct 2026): Safari's "Connect Phantom" makes a code,
// Phantom's own browser opens it, the person signs once there and STAYS there, signed in. Behind iCloud Private Relay the code can't be
// bound to the connection (Phantom's browser is not on the relay), so a RELAY code is bound to the first browser that opens it, to
// Safari's country, and must be opened within 2 minutes. Any code (relay or not) belongs to its first opener: a second browser gets
// nothing and kills it. Here: the whole relay journey, the clocks, the country, the opener race, a browser signed in as someone else.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, advance, browser, linkBody, realClock, useClock, wallet } from "./helpers/world.js";
import { member, one, outbox, userOf } from "./helpers/signup.js";
import { buildMessage, parseMessage } from "../src/solana.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const near = { country: "US", latitude: 43.1, longitude: -75.2 };
const RELAY = { ip: "172.224.226.5", cf: { ...near, asn: 54113, asOrganization: "Fastly, Inc." } };                // Safari behind iCloud Private Relay
const CARRIER = { ip: "198.51.100.7", cf: { ...near, asn: 21928, asOrganization: "T-Mobile USA, Inc." } };          // Phantom's own browser: the phone's mobile data
const ABROAD = { ip: "203.0.113.50", cf: { country: "DE", asn: 3320, asOrganization: "Deutsche Telekom AG" } };
const PHONE = { ip: "198.51.100.7", cf: { ...near, asn: 21928, asOrganization: "T-Mobile USA, Inc." } };            // relay OFF: Safari and Phantom share it

async function safari(net = RELAY, opts = {}) {
  const m = await member(env, box, { via: "google", net, ...opts });
  m.u = await userOf(env, m);
  return m;
}
const carry = async (b, app = "phantom") => (await b.send("/api/me/wallet/carry", { method: "POST", body: { app } })).json();
const info = (b, code, extra = {}) => b.send("/api/me/wallet/carry/info", { method: "POST", body: { code, ...extra } });
const status = async (b, ref) => (await b.send(`/api/me/wallet/carry/status?ref=${ref}`)).json();
const err = async (r) => [r.status, (await r.clone().json()).error];
/** The wallet app's whole claim: the statement from /api/message (as its page gets it), signed, then the claim. */
async function claimWith(b, code, w, extra = {}, { query = "" } = {}) {
  const got = await b.get(`/api/message?address=${w.address}&action=link&code=${code}${query}`);
  if (!got.message) return { status: got.error === "carry_opened" ? 403 : 0, body: got, statement: null };
  const message = buildMessage({ ...parseMessage(got.message), issuedAt: new Date(Date.now()).toISOString() }); // (the test clock)
  const r = await b.send("/api/me/wallet/carry/claim", { method: "POST", body: { code, address: w.address, message, signature: await w.sign(message), ...extra } });
  return { status: r.status, body: await r.json(), r, statement: parseMessage(got.message).statement };
}
const rows = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results;

test("relay ON: Safari behind iCloud Private Relay gets a relay code; Phantom (mobile data, same country) opens it, signs once, and is signed in there on the dashboard; Safari sees it and may say 'Wasn't you?'", async () => {
  const m = await safari();
  const made = await carry(m.b);
  assert.deepEqual([made.ok, made.relay, made.openBy], [true, true, new Date(Date.now() + 2 * 60_000).toISOString()]);
  const row = await one(env.DB, "SELECT net, country, opener, result FROM handoffs");
  assert.deepEqual(row, { net: "relay", country: "US", opener: null, result: null }, "bound to no address: to the country, and soon to its opener");
  const app = browser(env, CARRIER);
  const seen = await info(app, made.code);
  const shown = await seen.json();
  assert.equal(seen.status, 200, JSON.stringify(shown));
  assert.deepEqual([shown.relay, shown.here, shown.owner.handle, shown.pin], [true, null, m.u.handle, made.pin]);
  const vlo = seen.headers.getSetCookie().find((c) => c.startsWith("__Host-vlo="));
  assert.match(vlo, /^__Host-vlo=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  const stored = await one(env.DB, "SELECT opener, result FROM handoffs");
  assert.ok(stored.opener && stored.opener.length >= 40 && !stored.opener.includes(shown.opener), "only a hash of the nonce");
  assert.equal(stored.result, "opened");
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "opened" });
  advance(60_000);
  const c = await claimWith(app, made.code, m.w, { app: "phantom" });
  assert.deepEqual([c.status, c.body], [200, { ok: true, wallet: m.w.address, app: "phantom", next: "/dashboard?linked=1" }]);
  assert.ok(c.r.headers.getSetCookie().some((x) => x.startsWith("vs=")) && c.r.headers.getSetCookie().includes("__Host-vlo=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"));
  const u = await one(env.DB, "SELECT wallet, wallet_at, wallet_via, wallet_app FROM users WHERE id = ?", m.u.id);
  assert.deepEqual(u, { wallet: m.w.address, wallet_at: new Date(Date.now()).toISOString(), wallet_via: "app", wallet_app: "phantom" });
  // Phantom's browser: signed in, the wallet proven (sensitive actions work there at once), on the dashboard
  const inApp = await app.get("/api/me");
  assert.deepEqual([inApp.signedIn, inApp.user.wallet, inApp.fresh, inApp.user.walletApp], [true, m.w.address, true, "phantom"]);
  assert.deepEqual(inApp.walletNew, { wallet: `${m.w.address.slice(0, 4)}…${m.w.address.slice(-4)}`, via: "app", app: "phantom", at: u.wallet_at, notMe: false }, "the wallet app's own session can't say 'that wasn't me'");
  // Safari: its poll sees it (with the app it was linked in), and its older session may remove it
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "linked", wallet: m.w.address, app: "phantom" });
  const saf = await m.b.get("/api/me");
  assert.deepEqual([saf.user.wallet, saf.walletNew.notMe, saf.walletNew.app, saf.fresh], [m.w.address, true, "phantom", false]);
  assert.ok(!JSON.stringify(saf.walletNew).includes(m.w.address), "masked");
});

test("relay: the code must be OPENED within 2 minutes (1:59 opens, 2:00 does not, Safari says expired); once opened it can be claimed until the 10 minutes are over", async () => {
  const m = await safari();
  const late = await carry(m.b);
  advance(2 * 60_000);
  const r = await info(browser(env, CARRIER), late.code);
  assert.deepEqual(await err(r), [410, "carry_expired"]);
  assert.deepEqual(r.headers.getSetCookie(), [], "a refusal sets no cookie");
  assert.equal((await one(env.DB, "SELECT opener FROM handoffs")).opener, null, "nothing bound");
  assert.deepEqual(await status(m.b, late.ref), { ok: true, status: "expired", relay: true }, "Safari: that link ran out (open it within 2 minutes)");
  // in time: opened at 1:59, claimed at 9:59
  const made = await carry(m.b);
  advance(119_000);
  const app = browser(env, CARRIER);
  assert.equal((await info(app, made.code)).status, 200);
  advance(8 * 60_000);
  assert.equal((await status(m.b, made.ref)).status, "opened");
  assert.equal((await claimWith(app, made.code, m.w)).status, 200);
  // and one claimed at 10:01 is refused
  const n = await safari(RELAY, { sub: "g-late" });
  const made2 = await carry(n.b);
  const app2 = browser(env, CARRIER);
  assert.equal((await info(app2, made2.code)).status, 200);
  advance(10 * 60_000 + 1000);
  const tooLate = await claimWith(app2, made2.code, n.w);
  assert.equal(tooLate.body.error, "carry_expired");
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", n.u.id)).wallet, null);
});

test("relay: the bind and the 2-minute window are ONE statement: an info at 2:01 binds nothing even if it raced one at 1:59 that did not happen", async () => {
  const m = await safari();
  const made = await carry(m.b);
  // two looks at the very same moment, at 2:01: neither binds
  advance(121_000);
  const both = await Promise.all([info(browser(env, CARRIER), made.code), info(browser(env, CARRIER), made.code)]);
  assert.deepEqual(both.map((r) => r.status), [410, 410]);
  assert.equal((await one(env.DB, "SELECT opener, result FROM handoffs")).opener, null);
});

test("relay: the wallet app's connection must be in Safari's country: from Germany it gets carry_network and NOTHING is bound (a later US opener still opens and claims); a relay with no country still pairs", async () => {
  const m = await safari();
  const made = await carry(m.b);
  const abroad = browser(env, ABROAD);
  const r = await info(abroad, made.code);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: "carry_network", relay: true });
  assert.deepEqual(r.headers.getSetCookie(), []);
  assert.deepEqual(await one(env.DB, "SELECT opener, result FROM handoffs"), { opener: null, result: null });
  const app = browser(env, CARRIER);
  assert.equal((await info(app, made.code)).status, 200);
  assert.equal((await claimWith(app, made.code, m.w)).status, 200);
  // the old answer stays for a relay whose country Cloudflare doesn't know: the page pairs (approve in Phantom, finish in Safari)
  const n = await safari(RELAY, { sub: "g-xx" });
  n.b.net.cf = { asn: 13335, asOrganization: "Cloudflare, Inc.", country: "XX" }; // WARP, country unknown
  const no = await n.b.send("/api/me/wallet/carry", { method: "POST", body: { app: "phantom" } });
  assert.deepEqual(await err(no), [409, "carry_relay"]);
  const pair = await n.b.post("/api/pair", { purpose: "link" });
  assert.equal(pair.ok, true);
});

test("CARRY_RELAY=off (an emergency switch in the Cloudflare dashboard): relay connections pair again, ordinary connections are unchanged", async () => {
  env = V2({ CARRY_RELAY: " OFF " });
  const m = await safari();
  assert.deepEqual(await err(await m.b.send("/api/me/wallet/carry", { method: "POST", body: { app: "phantom" } })), [409, "carry_relay"]);
  const p = await safari(PHONE, { sub: "g-plain" });
  assert.equal((await carry(p.b)).ok, true);
  env.CARRY_RELAY = "on";
  assert.equal((await carry(m.b)).relay, true, "anything but off is on");
});

test("first opener wins (relay and ordinary codes): a second browser gets 403 carry_opened on info, the statement and the claim, the code dies (Safari: contested), and the first opener's claim is refused too", async () => {
  for (const [net, appNet] of [[RELAY, CARRIER], [PHONE, PHONE]]) {
    const m = await safari(net, { sub: `g-race-${net.ip}` });
    const made = await carry(m.b);
    const x = browser(env, appNet), y = browser(env, appNet); // Y: another browser on the same Wi-Fi / mobile network
    assert.equal((await info(x, made.code)).status, 200);
    assert.deepEqual(await err(await info(y, made.code)), [403, "carry_opened"]);
    assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "contested" }, "Safari: someone else opened your link, get a new one");
    const ym = await y.send(`/api/message?address=${m.w.address}&action=link&code=${made.code}`);
    assert.equal(ym.status, 410, "dead now");
    const yc = await y.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...(await linkBody(m.w, m.u.handle)) } });
    assert.equal(yc.status, 410);
    const xc = await claimWith(x, made.code, m.w);
    assert.equal(xc.body.error, "carry_expired", "the first opener lost it too: a link someone else saw is not trusted");
    assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, null, "nothing linked");
    // a new link kills the contested one and works
    const again = await carry(m.b);
    const z = browser(env, appNet);
    assert.equal((await info(z, again.code)).status, 200);
    assert.equal((await claimWith(z, again.code, m.w)).status, 200);
  }
});

test("the statement and the claim go only to the opener: a code nobody opened can't be claimed (and nothing changes); a browser that dropped its cookie uses the nonce its page kept; one browser may open two people's codes", async () => {
  const m = await safari(PHONE);
  const made = await carry(m.b);
  const never = browser(env, PHONE);
  const direct = await never.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...(await linkBody(m.w, m.u.handle)) } });
  assert.deepEqual(await err(direct), [403, "carry_opened"]);
  assert.deepEqual(await one(env.DB, "SELECT opener, result FROM handoffs"), { opener: null, result: null }, "a claim never opens a code");
  const st = await never.send(`/api/message?address=${m.w.address}&action=link&code=${made.code}`);
  assert.deepEqual([st.status, (await st.json()).error], [403, "carry_opened"]);
  // a wallet browser that throws its cookies away: the page sends the nonce it kept back (opener), and that works
  const app = browser(env, PHONE);
  const opened = await (await info(app, made.code)).json();
  app.jar.clear();
  const c = await claimWith(app, made.code, m.w, { opener: opened.opener }, { query: `&opener=${opened.opener}` });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  // one wallet browser opening two different people's codes keeps one nonce: both stay claimable by it
  const a = await safari(PHONE, { sub: "g-two-a" }), b = await safari(PHONE, { sub: "g-two-b" });
  const ca = await carry(a.b), cb = await carry(b.b);
  const shared = browser(env, PHONE);
  const oa = await (await info(shared, ca.code)).json(), ob = await (await info(shared, cb.code)).json();
  assert.equal(oa.opener, ob.opener, "the browser's nonce is reused");
  assert.equal((await claimWith(shared, ca.code, a.w)).status, 200);
  shared.jar.delete("vs"); // (signed in as a now: log out of it before claiming for b, as the page does on an explicit tap)
  shared.jar.set("__Host-vlo", oa.opener); // (the claim cleared the cookie; the page still has the nonce)
  assert.equal((await claimWith(shared, cb.code, b.w)).status, 200);
});

test("'here': the wallet app is signed in to SOMEONE ELSE: info says so (masked), the claim is refused before the signature is used, and after logging out there the same code claims", async () => {
  const jo = await safari(PHONE, { sub: "g-jo" });
  const m = await safari(RELAY);
  const made = await carry(m.b);
  const app = browser(env, CARRIER);
  app.jar.set("vs", jo.b.jar.get("vs")); // Phantom's browser holds Jo's session
  const shown = await (await info(app, made.code)).json();
  assert.equal(shown.here, `${jo.u.handle.slice(0, 2)}•••`);
  const body = await linkBody(m.w, m.u.handle);
  const r = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...body } });
  assert.deepEqual(await err(r), [409, "already_signed_in"]);
  assert.deepEqual(await one(env.DB, "SELECT result, wallet FROM handoffs"), { result: "opened", wallet: null }, "the code untouched");
  assert.equal((await app.send("/api/auth/logout", { method: "POST", body: {} })).status, 200);
  assert.equal((await jo.b.get("/api/me?lite=1")).signedIn, false, "(the copied cookie was Jo's session: it is gone)");
  const ok = await app.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, ...body } }); // the very same signature: it was never used
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await app.get("/api/me?lite=1")).user.id, m.u.id);
});

test("logout in Safari still kills a relay code: the wallet app's claim answers carry_expired and gets no session", async () => {
  const m = await safari();
  const made = await carry(m.b);
  const app = browser(env, CARRIER);
  assert.equal((await info(app, made.code)).status, 200);
  await m.b.send("/api/auth/logout", { method: "POST", body: {} });
  const c = await claimWith(app, made.code, m.w);
  assert.equal(c.body.error, "carry_expired");
  assert.equal(app.has("vs"), false);
});

test("relay codes are counted per person only (strangers share a relay exit), ordinary ones per person and per connection", async () => {
  const people = [];
  for (let i = 0; i < 12; i++) people.push(await safari(RELAY, { sub: `g-exit-${i}` }));
  for (const p of people) for (let k = 0; k < 3; k++) assert.equal((await carry(p.b)).ok, true, "36 codes from one relay exit: fine");
  const one10 = people[0];
  for (let k = 0; k < 7; k++) await carry(one10.b);
  assert.equal((await carry(one10.b)).error, "slow_down", "but ten an hour per person");
});

test("the code a link was made in only names a KNOWN wallet app (anything else is dropped), and the status of a dead or replaced code is plain", async () => {
  const m = await safari(PHONE);
  const made = await carry(m.b);
  const app = browser(env, PHONE);
  await info(app, made.code);
  const c = await claimWith(app, made.code, m.w, { app: "<script>" });
  assert.equal(c.status, 200);
  assert.equal(c.body.app, undefined);
  assert.equal((await one(env.DB, "SELECT wallet_app FROM users WHERE id = ?", m.u.id)).wallet_app, null);
  assert.deepEqual(await status(m.b, made.ref), { ok: true, status: "linked", wallet: m.w.address });
  assert.equal((await wallet()).address.length > 30, true);
});
