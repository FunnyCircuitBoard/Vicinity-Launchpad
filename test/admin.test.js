// Admin dashboard: roles, permission tiers, audit trail, and test-lab isolation.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleAdmin } from "../src/admin.js";
import { sha256, randomToken } from "../src/http.js";
import { ensureSchema } from "../src/store.js";
import { iso } from "../src/policy.js";
import { base58Encode } from "../src/solana.js";
import { d1 } from "./helpers/d1.js";

const ORIGIN = "https://vicinity.test";
let env, OWNER;

async function newWallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
}

beforeEach(async () => {
  OWNER = await newWallet();
  env = { DB: d1(), ADMIN_WALLETS: OWNER, SITE_MODE: "preview" };
  await ensureSchema(env.DB);
});

/** A signed-in user with a session cookie (fresh wallet proof unless stale:true). */
async function sessionFor(wallet, { stale = false } = {}) {
  const now = Date.now();
  let user = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(wallet).first();
  if (!user) {
    const ins = await env.DB.prepare(
      "INSERT INTO users (wallet, provider, provider_id, handle, name, created_at) VALUES (?, 'test', ?, ?, 'T', ?)")
      .bind(wallet, wallet + ":" + randomToken(6), "t" + wallet.slice(0, 8), iso(now)).run();
    user = { id: ins.meta.last_row_id };
  }
  const tok = randomToken(24);
  await env.DB.prepare("INSERT INTO sessions (id, wallet, user_id, created_at, expires_at, proven_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(tok), wallet, user.id, iso(now), iso(now + 30 * 86400000),
      iso(stale ? now - 7200_000 : now)).run();
  return { cookie: `vs=${encodeURIComponent(tok)}`, userId: user.id };
}

function call(path, { method = "GET", body, cookie, origin = ORIGIN } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return handleAdmin(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

test("me: 401 without session; roles resolve for owner, granted admin, granted moderator", async () => {
  assert.equal((await call("/api/admin/me")).status, 401);
  const owner = await sessionFor(OWNER);
  assert.equal((await (await call("/api/admin/me", { cookie: owner.cookie })).json()).role, "owner");

  const aAddr = await newWallet(), mAddr = await newWallet();
  await sessionFor(aAddr); await sessionFor(mAddr);
  assert.ok((await (await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: aAddr, role: "admin" } })).json()).ok);
  assert.ok((await (await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: mAddr, role: "moderator" } })).json()).ok);
  const a = await sessionFor(aAddr), m = await sessionFor(mAddr);
  assert.equal((await (await call("/api/admin/me", { cookie: a.cookie })).json()).role, "admin");
  assert.equal((await (await call("/api/admin/me", { cookie: m.cookie })).json()).role, "moderator");
  // a signed-in user with no role gets 403 on admin reads
  const plain = await sessionFor(await newWallet());
  const r = await call("/api/admin/overview", { cookie: plain.cookie });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "forbidden");
});

test("permission tiers: moderator cannot ban, admin cannot grant roles, owner can", async () => {
  const owner = await sessionFor(OWNER);
  const aAddr = await newWallet(), mAddr = await newWallet(), victim = await newWallet();
  await sessionFor(aAddr); await sessionFor(mAddr); await sessionFor(victim);
  await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: aAddr, role: "admin" } });
  await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: mAddr, role: "moderator" } });
  const admin = await sessionFor(aAddr), mod = await sessionFor(mAddr);

  // moderator: content reads fine, user ban forbidden
  assert.ok((await (await call("/api/admin/overview", { cookie: mod.cookie })).json()).ok);
  let r = await call("/api/admin/users/ban", { method: "POST", cookie: mod.cookie, body: { wallet: victim } });
  assert.equal(r.status, 403);

  // admin: can ban, cannot grant roles
  r = await call("/api/admin/users/ban", { method: "POST", cookie: admin.cookie, body: { wallet: victim, reason: "test" } });
  assert.ok((await r.json()).ok, "admin should be able to ban");
  r = await call("/api/admin/roles/grant", { method: "POST", cookie: admin.cookie, body: { wallet: victim, role: "moderator" } });
  assert.equal(r.status, 403);

  // owner: can grant; cannot change their own role (lockout guard)
  r = await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: OWNER, role: "admin" } });
  assert.equal((await r.json()).error, "own_account");
  r = await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: victim, role: "moderator" } });
  assert.ok((await r.json()).ok, "owner should be able to grant");
});

test("sensitive actions need a fresh wallet proof; POSTs need same-site origin", async () => {
  const owner = await sessionFor(OWNER);
  const victim = await newWallet(); await sessionFor(victim);
  const stale = await sessionFor(await newWallet(), { stale: true });
  // grant the stale session an admin role first via the owner
  const staleAddr = await newWallet();
  await env.DB.prepare("INSERT OR REPLACE INTO admin_roles (wallet, role, granted_at) VALUES (?, 'admin', ?)")
    .bind(staleAddr, iso(Date.now())).run();
  const staleAdmin = await sessionFor(staleAddr, { stale: true });
  const r = await call("/api/admin/users/ban", { method: "POST", cookie: staleAdmin.cookie, body: { wallet: victim } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "reprove");
  // wrong origin
  const r2 = await call("/api/admin/users/ban", { method: "POST", cookie: owner.cookie, body: { wallet: victim }, origin: "https://evil.test" });
  assert.equal((await r2.json()).error, "wrong_origin");
  // wrong method
  assert.equal((await call("/api/admin/users/ban", { cookie: owner.cookie })).status, 405);
});

test("mutating calls append to the audit log", async () => {
  const owner = await sessionFor(OWNER);
  const victim = await newWallet(); await sessionFor(victim);
  await call("/api/admin/users/ban", { method: "POST", cookie: owner.cookie, body: { wallet: victim, reason: "audit check" } });
  const d = await (await call("/api/admin/audit", { cookie: owner.cookie })).json();
  const row = d.audit.find((a) => a.action === "users/ban");
  assert.ok(row, "ban should be audited");
  assert.equal(row.actor, OWNER);
  assert.equal(row.target, victim);
});

test("test lab: seed then reset removes only seeded rows", async () => {
  const owner = await sessionFor(OWNER);
  // a real user that must survive
  const realAddr = await newWallet();
  await sessionFor(realAddr);

  const seed = await (await call("/api/admin/test/seed", { method: "POST", cookie: owner.cookie, body: {} })).json();
  assert.ok(seed.ok);
  assert.equal(seed.seeded.users, 8);
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  assert.equal(before.n, 1 /* owner */ + 1 /* real */ + 8);

  // confirmation required
  assert.equal((await (await call("/api/admin/test/reset", { method: "POST", cookie: owner.cookie, body: { confirm: "nope" } })).json()).error, "need_confirm");

  const reset = await (await call("/api/admin/test/reset", { method: "POST", cookie: owner.cookie, body: { confirm: "RESET" } })).json();
  assert.ok(reset.ok);
  assert.ok(reset.deleted > 0);
  const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  assert.equal(after.n, 2, "only the owner and the real user remain");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM seats").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM elections").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_test").first()).n, 0);
  // the audit trail survives the reset
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action LIKE 'test/%'").first()).n >= 2);
});

test("test lab: upheld objection revokes the steward seat", async () => {
  const owner = await sessionFor(OWNER);
  const modAddr = await newWallet(); await sessionFor(modAddr);
  await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: modAddr, role: "admin" } });
  const mod = await sessionFor(modAddr);

  await (await call("/api/admin/test/seed", { method: "POST", cookie: owner.cookie, body: {} })).json();
  const obs = await (await call("/api/admin/objections", { cookie: mod.cookie })).json();
  assert.equal(obs.objections.length, 1);
  const d = await (await call("/api/admin/objections/decide", { method: "POST", cookie: mod.cookie, body: { id: obs.objections[0].id, uphold: true } })).json();
  assert.ok(d.ok && d.upheld);
  const seat = await env.DB.prepare("SELECT status, end_reason FROM seats WHERE city_id = 'testlab-la'").first();
  assert.equal(seat.status, "revoked");
  assert.equal(seat.end_reason, "objection_upheld");
});

test("test lab: preview-role sets and clears the cookie", async () => {
  const owner = await sessionFor(OWNER);
  let r = await call("/api/admin/test/preview-role", { method: "POST", cookie: owner.cookie, body: { role: "founder" } });
  assert.ok((await r.json()).ok);
  assert.match(r.headers.get("set-cookie") || "", /vicinity_preview_role=founder/);
  r = await call("/api/admin/test/preview-role", { method: "POST", cookie: owner.cookie, body: { role: "bogus" } });
  assert.equal(r.status, 400);
  r = await call("/api/admin/test/preview-role", { method: "POST", cookie: owner.cookie, body: { role: null } });
  assert.ok((await r.json()).ok);
  assert.match(r.headers.get("set-cookie") || "", /Max-Age=0/);
});

test("config exposes presence flags only, never secret values", async () => {
  env.GOOGLE_CLIENT_ID = "gid123"; env.GOOGLE_CLIENT_SECRET = "gsec-secret";
  env.GMAIL_USER = "me@example.test"; env.VICINITY_MINT = "mint"; env.SOLANA_RPC_URL = "rpc";
  const owner = await sessionFor(OWNER);
  const d = await (await call("/api/admin/config", { cookie: owner.cookie })).json();
  assert.ok(d.ok);
  assert.equal(d.siteMode, "preview");
  assert.equal(d.policyVersion, 5);
  assert.deepEqual(d.flags.GOOGLE_CLIENT_ID, true);
  assert.deepEqual(d.flags.GMAIL_USER, true);
  assert.deepEqual(d.flags.GMAIL_APP_PASSWORD, false);
  // X sign-in no longer exists; the e-mail settings are listed instead
  assert.ok(!Object.keys(d.flags).some((k) => k.startsWith("X_")));
  for (const k of ["GMAIL_USER", "GMAIL_APP_PASSWORD", "RESEND_API_KEY", "EMAIL_FROM", "EMAIL_MAX_PER_HOUR"]) assert.ok(k in d.flags, k);
  const raw = JSON.stringify(d);
  assert.ok(!raw.includes("gsec-secret") && !raw.includes("gid123") && !raw.includes("me@example.test"), "no secret values leak");
  // moderator cannot see config
  const mAddr = await newWallet(); await sessionFor(mAddr);
  await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: mAddr, role: "moderator" } });
  const mod = await sessionFor(mAddr);
  assert.equal((await call("/api/admin/config", { cookie: mod.cookie })).status, 403);
});

test("token registry round-trips", async () => {
  const owner = await sessionFor(OWNER);
  const mint = await newWallet(), founder = await newWallet();
  let r = await (await call("/api/admin/tokens/register", { method: "POST", cookie: owner.cookie,
    body: { mint, city: "Testville", founderWallet: founder, platform: "launchlab" } })).json();
  assert.ok(r.ok);
  r = await (await call("/api/admin/tokens/register", { method: "POST", cookie: owner.cookie, body: { mint, city: "Testville" } })).json();
  assert.equal(r.error, "already_registered");
  const d = await (await call("/api/admin/tokens", { cookie: owner.cookie })).json();
  assert.equal(d.registered.length, 1);
  assert.equal(d.registered[0].city, "Testville");
});

test("owner bootstrap: wallet-only session (no linked account) gets owner access", async () => {
  // A session with a proven wallet but no user row — e.g. Saki before linking Google.
  const now = Date.now();
  const tok = randomToken(24);
  await env.DB.prepare("INSERT INTO sessions (id, wallet, user_id, created_at, expires_at, proven_at) VALUES (?, ?, NULL, ?, ?, ?)")
    .bind(await sha256(tok), OWNER, iso(now), iso(now + 30 * 86400000), iso(now)).run();
  const cookie = `vs=${encodeURIComponent(tok)}`;

  const me = await (await call("/api/admin/me", { cookie })).json();
  assert.ok(me.ok);
  assert.equal(me.role, "owner");
  assert.equal(me.wallet, OWNER);

  // Bootstrap provisioned a user row and linked the session.
  const u = await env.DB.prepare("SELECT * FROM users WHERE wallet = ?").bind(OWNER).first();
  assert.ok(u, "owner user row provisioned");
  assert.equal(u.provider, "wallet");
  const s = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?").bind(await sha256(tok)).first();
  assert.equal(s.user_id, u.id, "session linked to provisioned user");

  // A non-owner wallet without a linked account still gets 401.
  const stranger = await newWallet();
  const tok2 = randomToken(24);
  await env.DB.prepare("INSERT INTO sessions (id, wallet, user_id, created_at, expires_at, proven_at) VALUES (?, ?, NULL, ?, ?, ?)")
    .bind(await sha256(tok2), stranger, iso(now), iso(now + 30 * 86400000), iso(now)).run();
  assert.equal((await call("/api/admin/me", { cookie: `vs=${encodeURIComponent(tok2)}` })).status, 401);
});

/* ---------------- hardening ---------------- */

/** A session for a wallet holding a granted role (fresh wallet proof unless stale:true). */
async function staff(role, opts = {}) {
  const wallet = await newWallet();
  const ses = await sessionFor(wallet, opts);
  await env.DB.prepare("INSERT OR REPLACE INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, ?, ?, ?)")
    .bind(wallet, role, OWNER, iso(Date.now())).run();
  return { wallet, ...ses };
}
const post = (path, who, body = {}) => call(path, { method: "POST", cookie: who.cookie, body });

test("every POST route needs a fresh wallet proof, GET routes do not", async () => {
  const owner = await sessionFor(OWNER, { stale: true });
  const POSTS = ["users/ban", "users/unban", "seats/decide", "objections/decide", "elections/create", "tokens/register",
    "reports/decide", "appeals/decide", "snapshots/create", "roles/grant", "roles/revoke", "test/seed", "test/reset", "test/preview-role"];
  for (const route of POSTS) {
    const r = await post("/api/admin/" + route, owner);
    assert.equal(r.status, 403, route);
    assert.equal((await r.json()).error, "reprove", route);
  }
  for (const route of ["overview", "users", "seats", "claims", "objections", "elections", "tokens", "reports", "appeals",
    "snapshots", "config", "roles", "audit"]) {
    assert.equal((await call("/api/admin/" + route, { cookie: owner.cookie })).status, 200, route);
  }
  // the role is still checked before the proof
  const mod = await staff("moderator", { stale: true });
  const r = await post("/api/admin/tokens/register", mod);
  assert.equal((await r.json()).error, "forbidden");
  // with a fresh proof a normal write goes through
  const fresh = await sessionFor(OWNER);
  const mint = await newWallet();
  assert.ok((await (await post("/api/admin/tokens/register", fresh, { mint, city: "Testville" })).json()).ok);
});

async function objectionFixture(objectorId) {
  const seat = await env.DB.prepare(
    "INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at) VALUES (?, 'City', 'XX', ?, 'W', 5, 0.5, 'active', ?)")
    .bind("c" + randomToken(4), (await sessionFor(await newWallet())).userId, iso(Date.now())).run();
  const o = await env.DB.prepare("INSERT INTO objections (seat_id, user_id, reason, created_at) VALUES (?, ?, 'reason enough here', ?)")
    .bind(seat.meta.last_row_id, objectorId, iso(Date.now())).run();
  return { seatId: seat.meta.last_row_id, id: o.meta.last_row_id };
}
const seatStatus = async (id) => (await env.DB.prepare("SELECT status FROM seats WHERE id = ?").bind(id).first()).status;

test("objections/decide: admin or owner with a fresh proof, never the objector, never a moderator", async () => {
  const other = await sessionFor(await newWallet());
  const { id, seatId } = await objectionFixture(other.userId);
  const mod = await staff("moderator");
  let r = await post("/api/admin/objections/decide", mod, { id, uphold: true });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "forbidden");
  const staleAdmin = await staff("admin", { stale: true });
  r = await post("/api/admin/objections/decide", staleAdmin, { id, uphold: true });
  assert.equal((await r.json()).error, "reprove");
  assert.equal(await seatStatus(seatId), "active", "nothing changed");

  // the decider is the objector: refused, for an admin and for the owner
  const admin = await staff("admin");
  const own = await objectionFixture(admin.userId);
  r = await post("/api/admin/objections/decide", admin, { id: own.id, uphold: true });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "own_objection");
  assert.equal(await seatStatus(own.seatId), "active");
  const owner = await sessionFor(OWNER);
  const ownerOwn = await objectionFixture(owner.userId);
  assert.equal((await (await post("/api/admin/objections/decide", owner, { id: ownerOwn.id, uphold: true })).json()).error, "own_objection");

  // someone else's objection: an admin decides it
  r = await post("/api/admin/objections/decide", admin, { id, uphold: true });
  assert.ok((await r.json()).ok);
  assert.equal(await seatStatus(seatId), "revoked");
});

test("snapshots/create: owner with a fresh proof only", async () => {
  const body = { cutoff: "2020-01-01T00:00:00Z" };
  const admin = await staff("admin");
  let r = await post("/api/admin/snapshots/create", admin, body);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "forbidden");
  const staleOwner = await sessionFor(OWNER, { stale: true });
  assert.equal((await (await post("/api/admin/snapshots/create", staleOwner, body)).json()).error, "reprove");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first()).n, 0);
  const owner = await sessionFor(OWNER);
  assert.ok((await (await post("/api/admin/snapshots/create", owner, body)).json()).ok);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first()).n, 1);
});

test("test/seed refuses outside preview mode; test/reset still works in live mode and deletes only tracked rows", async () => {
  const owner = await sessionFor(OWNER);
  for (const mode of [undefined, "live", "other"]) {
    env.SITE_MODE = mode;
    const r = await post("/api/admin/test/seed", owner);
    assert.equal(r.status, 403, String(mode));
    assert.equal((await r.json()).error, "not_in_preview");
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE provider = 'testlab'").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_test").first()).n, 0);

  // seed on the preview site, add real rows, then wipe it after the live cutover
  env.SITE_MODE = "preview";
  assert.ok((await (await post("/api/admin/test/seed", owner)).json()).ok);
  const real = await sessionFor(await newWallet());
  await env.DB.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (?, 'city', 'x', 'US', 'meme', 'real post', ?)")
    .bind(real.userId, iso(Date.now())).run();
  const tracked = (await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_test").first()).n;
  assert.equal(tracked, 20);

  env.SITE_MODE = "live";
  const reset = await (await post("/api/admin/test/reset", owner, { confirm: "RESET" })).json();
  assert.ok(reset.ok);
  assert.equal(reset.deleted, tracked);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n, 2, "owner and the real user remain");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE provider = 'testlab'").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first()).n, 1, "the real post remains");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM seats").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_test").first()).n, 0);
});

test("roles: owner can't be granted through the API, nobody bans or revokes an ADMIN_WALLETS wallet", async () => {
  const owner = await sessionFor(OWNER);
  const target = await newWallet(); await sessionFor(target);
  let r = await post("/api/admin/roles/grant", owner, { wallet: target, role: "owner" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "owner_not_grantable");
  assert.equal(await env.DB.prepare("SELECT role FROM admin_roles WHERE wallet = ?").bind(target).first(), null);
  assert.ok((await (await post("/api/admin/roles/grant", owner, { wallet: target, role: "admin" })).json()).ok);

  // a second env owner: nobody (not even the first owner) can ban or revoke it
  const owner2 = await newWallet(); await sessionFor(owner2);
  env.ADMIN_WALLETS = `${OWNER},${owner2}`;
  for (const route of ["users/ban", "users/unban", "roles/revoke"]) {
    r = await post("/api/admin/" + route, owner, { wallet: owner2 });
    assert.equal(r.status, 403, route);
    assert.equal((await r.json()).error, "protected_wallet", route);
  }
  // an admin can't ban the owner either
  const admin = await staff("admin");
  r = await post("/api/admin/users/ban", admin, { wallet: OWNER });
  assert.equal((await r.json()).error, "protected_wallet");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM bans").first()).n, 0);
});

test("ban, unban and revoke need a higher role than the target", async () => {
  const owner = await sessionFor(OWNER);
  const admin = await staff("admin"), admin2 = await staff("admin"), mod = await staff("moderator");
  const legacyOwner = await staff("owner");   // a DB owner row from before owners became env-only
  const plain = await newWallet(); await sessionFor(plain);
  const err = async (route, who, wallet) => (await (await post("/api/admin/" + route, who, { wallet })).json()).error;

  assert.equal(await err("users/ban", admin, admin2.wallet), "outranked", "peer");
  assert.equal(await err("users/ban", admin, legacyOwner.wallet), "outranked", "higher role");
  assert.equal(await err("users/ban", owner, legacyOwner.wallet), "outranked", "owner vs owner");
  assert.equal(await err("users/unban", admin, admin2.wallet), "outranked");
  assert.equal(await err("roles/revoke", owner, legacyOwner.wallet), "outranked");
  assert.equal(await err("users/ban", admin, admin.wallet), "own_account", "self-ban refusal kept");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM bans").first()).n, 0);

  // lower roles and plain accounts are fine
  assert.ok((await (await post("/api/admin/users/ban", admin, { wallet: mod.wallet, reason: "x" })).json()).ok);
  assert.ok((await (await post("/api/admin/users/unban", admin, { wallet: mod.wallet })).json()).ok);
  assert.ok((await (await post("/api/admin/users/ban", admin, { wallet: plain })).json()).ok);
  assert.ok((await (await post("/api/admin/users/ban", owner, { wallet: admin2.wallet })).json()).ok);
  assert.ok((await (await post("/api/admin/roles/revoke", owner, { wallet: admin2.wallet })).json()).revoked);
  assert.equal((await post("/api/admin/roles/revoke", owner, { wallet: plain })).status, 404);
});

test("moderators get masked wallets and no names in users, seats and claims; admins see everything", async () => {
  const owner = await sessionFor(OWNER);
  assert.ok((await (await post("/api/admin/test/seed", owner)).json()).ok);
  const win = await env.DB.prepare(
    "INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at, status) VALUES ('testlab-nyc', 'Testville', 'XX', 5, 0.5, ?, ?, 'open')")
    .bind(iso(Date.now()), iso(Date.now() + 3 * 86400000)).run();
  const u0 = await env.DB.prepare("SELECT id, wallet FROM users WHERE handle = '@testlab0'").first();
  await env.DB.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, pitch, created_at) VALUES (?, 'testlab-nyc', ?, ?, 'pitch', ?)")
    .bind(win.meta.last_row_id, u0.id, u0.wallet, iso(Date.now())).run();
  const mod = await staff("moderator"), admin = await staff("admin");
  const get = async (path, who) => (await call(path, { cookie: who.cookie })).json();

  for (const [path, key] of [["/api/admin/users", "users"], ["/api/admin/seats", "seats"], ["/api/admin/claims", "claims"]]) {
    const m = (await get(path, mod))[key];
    assert.ok(m.length, key);
    for (const row of m) {
      assert.ok(!("name" in row), `${key}: no name`);
      if (row.wallet) assert.match(row.wallet, /^.{5}\*{5}.{3}$/, `${key}: masked wallet`);
    }
    assert.ok(!JSON.stringify(m).includes("TestLab0"), `${key}: no full wallet`);
    const a = (await get(path, admin))[key];
    assert.ok(a.some((row) => row.wallet === u0.wallet), `${key}: admin sees the wallet`);
    assert.ok(a.some((row) => row.name === "Test Lab 0"), `${key}: admin sees the name`);
  }
  // no search by wallet or name for the lowest role (it would undo the masking), handles still work
  assert.equal((await get("/api/admin/users?q=TestLab03", mod)).users.length, 0);
  assert.equal((await get("/api/admin/users?q=Test%20Lab%203", mod)).users.length, 0);
  assert.equal((await get("/api/admin/users?q=testlab3", mod)).users.length, 1);
  assert.equal((await get("/api/admin/users?q=TestLab03", admin)).users.length, 1);
  assert.equal((await get("/api/admin/users?q=Test%20Lab%203", admin)).users.length, 1);
});

test("seats/decide: needs a fresh proof and an open window", async () => {
  const mk = async (status) => {
    const w = await env.DB.prepare(
      "INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at, status) VALUES (?, 'C', 'XX', 5, 0.5, ?, ?, ?)")
      .bind("c" + status + randomToken(3), iso(Date.now()), iso(Date.now() + 86400000), status).run();
    const u = await sessionFor(await newWallet());
    const a = await env.DB.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, created_at) VALUES (?, 'c', ?, 'W', ?)")
      .bind(w.meta.last_row_id, u.userId, iso(Date.now())).run();
    return a.meta.last_row_id;
  };
  const open = await mk("open"), decided = await mk("decided");
  const withdrawn = async (id) => (await env.DB.prepare("SELECT withdrawn FROM applications WHERE id = ?").bind(id).first()).withdrawn;
  const stale = await staff("admin", { stale: true }), admin = await staff("admin");
  assert.equal((await (await post("/api/admin/seats/decide", stale, { id: open, decision: "reject" })).json()).error, "reprove");
  let r = await post("/api/admin/seats/decide", admin, { id: decided, decision: "reject" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "window_closed");
  assert.equal(await withdrawn(decided), 0);
  assert.equal(await withdrawn(open), 0);
  assert.ok((await (await post("/api/admin/seats/decide", admin, { id: open, decision: "reject" })).json()).ok);
  assert.equal(await withdrawn(open), 1);
});
