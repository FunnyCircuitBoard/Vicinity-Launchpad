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
      "INSERT INTO users (wallet, provider, provider_id, handle, name, created_at) VALUES (?, 'test', ?, 't', 'T', ?)")
      .bind(wallet, wallet + ":" + randomToken(6), iso(now)).run();
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
  await call("/api/admin/roles/grant", { method: "POST", cookie: owner.cookie, body: { wallet: modAddr, role: "moderator" } });
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
  env.X_CLIENT_ID = "xid"; env.VICINITY_MINT = "mint"; env.SOLANA_RPC_URL = "rpc";
  const owner = await sessionFor(OWNER);
  const d = await (await call("/api/admin/config", { cookie: owner.cookie })).json();
  assert.ok(d.ok);
  assert.equal(d.siteMode, "preview");
  assert.equal(d.policyVersion, 5);
  assert.deepEqual(d.flags.GOOGLE_CLIENT_ID, true);
  assert.deepEqual(d.flags.X_CLIENT_SECRET, false);
  const raw = JSON.stringify(d);
  assert.ok(!raw.includes("gsec-secret") && !raw.includes("gid123"), "no secret values leak");
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
