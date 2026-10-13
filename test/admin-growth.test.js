// GET /api/admin/growth (src/admin.js handleGrowth): the admin Overview's charts. Owner only, GET only, read only, from rows the site
// already keeps: the last balance sample of each day (wallets holding $VICINITY), accounts made per day with the running total (test-lab
// rows never count), and accounts per home country (the 12 largest, then "other"). No wallets and no names in the answer.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleAdmin } from "../src/admin.js";
import { sha256, randomToken } from "../src/http.js";
import { ensureSchema } from "../src/store.js";
import { DAY, iso } from "../src/policy.js";
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
  env = { DB: d1(), ADMIN_WALLETS: OWNER, SITE_MODE: "live" };
  await ensureSchema(env.DB);
});

/** A signed-in account with a session cookie; `createdAt` dates the account (the owner's is made long before the window). */
async function sessionFor(wallet, { createdAt = iso(Date.now() - 400 * DAY) } = {}) {
  const now = Date.now();
  let user = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(wallet).first();
  if (!user) {
    const ins = await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, name, created_at) VALUES (?, 'test', ?, ?, 'T', ?)")
      .bind(wallet, wallet + ":" + randomToken(6), "t" + wallet.slice(0, 8), createdAt).run();
    user = { id: ins.meta.last_row_id };
  }
  const tok = randomToken(24);
  await env.DB.prepare("INSERT INTO sessions (id, wallet, user_id, created_at, expires_at, proven_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(tok), wallet, user.id, iso(now), iso(now + 30 * DAY), iso(now)).run();
  return { cookie: `vs=${encodeURIComponent(tok)}` };
}
const grant = (wallet, role) => env.DB.prepare("INSERT OR REPLACE INTO admin_roles (wallet, role, granted_at) VALUES (?, ?, ?)").bind(wallet, role, iso(Date.now())).run();
function call(path, { method = "GET", cookie } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET") { headers.set("origin", ORIGIN); headers.set("content-type", "application/json"); }
  return handleAdmin(new Request(ORIGIN + path, { method, headers, body: method === "GET" ? undefined : "{}" }), env);
}
let n = 0;
const member = (createdAt, { country = null, provider = "google" } = {}) => env.DB.prepare(
  "INSERT INTO users (wallet, provider, provider_id, handle, home_country, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  .bind(`W${++n}${"1".repeat(40)}`.slice(0, 44), provider, `p${n}`, `m${n}`, country, createdAt).run();
const sample = (takenAt, holders) => env.DB.prepare("INSERT INTO balance_samples (taken_at, day, slot, holders, hash) VALUES (?, ?, 1, ?, 'h')")
  .bind(takenAt, takenAt.slice(0, 10), holders).run();

test("owner only: signed out 401, a moderator 403, an admin 403, the owner 200; GET only (POST 405)", async () => {
  assert.equal((await call("/api/admin/growth")).status, 401);
  const modW = await newWallet(), adminW = await newWallet();
  await grant(modW, "moderator"); await grant(adminW, "admin");
  const mod = await sessionFor(modW), admin = await sessionFor(adminW), owner = await sessionFor(OWNER);
  for (const s of [mod, admin]) {
    const r = await call("/api/admin/growth", { cookie: s.cookie });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { ok: false, error: "forbidden", need: "owner" });
  }
  const ok = await call("/api/admin/growth", { cookie: owner.cookie });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.equal((await call("/api/admin/growth", { method: "POST", cookie: owner.cookie })).status, 405);
  // the route reads only: nothing was written to the audit log
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit").first()).n, 0);
});

test("an empty site: empty lists, still ok", async () => {
  const owner = await sessionFor(OWNER); // the owner's own account is from before the 90-day window and has no home country
  const d = await (await call("/api/admin/growth", { cookie: owner.cookie })).json();
  assert.equal(d.ok, true);
  assert.deepEqual(d.holders, []);
  assert.deepEqual(d.members, []);
  assert.deepEqual(d.countries, []);
  assert.match(d.asOf, /^\d{4}-\d\d-\d\dT/);
  assert.match(d.since, /^\d{4}-\d\d-\d\d$/);
});

test("holders: the last balance sample of each day (wallets, pools included), oldest day first", async () => {
  const owner = await sessionFor(OWNER);
  await sample("2026-10-10T01:00:00.000Z", 10);
  await sample("2026-10-11T02:00:00.000Z", 12);
  await sample("2026-10-10T23:00:00.000Z", 11); // inserted later, same day: the day's last sample
  await sample("2026-10-11T20:00:00.000Z", 15);
  const d = await (await call("/api/admin/growth", { cookie: owner.cookie })).json();
  assert.deepEqual(d.holders, [
    { day: "2026-10-10", holders: 11, at: "2026-10-10T23:00:00.000Z" },
    { day: "2026-10-11", holders: 15, at: "2026-10-11T20:00:00.000Z" },
  ]);
});

test("members: accounts per day in the last 90 days with the running total (accounts before the window counted in it, test-lab rows never)", async () => {
  const owner = await sessionFor(OWNER); // made 400 days ago: before the window, counted in the total
  const day = (k) => iso(Date.now() - k * DAY);
  await member(day(120)); // before the window too
  await member(day(3)); await member(day(3)); await member(day(1)); await member(day(0));
  await member(day(1), { provider: "testlab" }); // a test-lab account: never a member
  const d = await (await call("/api/admin/growth", { cookie: owner.cookie })).json();
  assert.deepEqual(d.members, [
    { day: day(3).slice(0, 10), joined: 2, total: 4 },
    { day: day(1).slice(0, 10), joined: 1, total: 5 },
    { day: day(0).slice(0, 10), joined: 1, total: 6 },
  ]);
  assert.equal(d.since, day(90).slice(0, 10));
  assert.doesNotMatch(JSON.stringify(d), /W\d+1{10}|"handle"|"wallet"|"name"/, "no wallets and no names in the answer");
});

test("countries: the 12 largest home countries, then the rest as one 'other'; no country and test-lab rows left out", async () => {
  const owner = await sessionFor(OWNER);
  const codes = ["US", "GB", "DE", "FR", "BR", "CA", "JP", "BD", "IN", "NG", "MX", "ES", "IT", "NL"];
  // US 14 accounts, GB 13, ... NL 1: a clear order
  for (const [i, cc] of codes.entries()) for (let k = 0; k < codes.length - i; k++) await member(iso(Date.now() - 2 * DAY), { country: cc });
  await member(iso(Date.now() - DAY)); // no home yet
  await member(iso(Date.now() - DAY), { country: "XX", provider: "testlab" });
  const d = await (await call("/api/admin/growth", { cookie: owner.cookie })).json();
  assert.equal(d.countries.length, 13);
  assert.deepEqual(d.countries.slice(0, 12).map((c) => c.country), codes.slice(0, 12));
  assert.deepEqual(d.countries[0], { country: "US", members: 14 });
  assert.deepEqual(d.countries[12], { country: "other", members: 2 + 1 }, "IT (2) and NL (1)");
  assert.ok(!d.countries.some((c) => c.country === "XX"), "test-lab rows never count");
});
