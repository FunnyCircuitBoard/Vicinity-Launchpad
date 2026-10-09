// Onboarding v3: an account WITHOUT a wallet (Google or e-mail first, the wallet linked later from the dashboard). Every reader of
// users.wallet treats NULL as "no wallet linked": holdings 0, no rank, no holder badges, no founder path, leaderboards and holder
// counts skip the member, the profile says so, admin standing needs a wallet, and nothing answers a 500. Also the freshness rule: a
// wallet-less account's login counts as its proof for 30 minutes (there is nothing a wallet proof would protect), a wallet's proof
// is the only proof once one is linked.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { IN_UTICA, MINT, advance, attest, browser, loginBody, newWorld, person, realClock, tick, useClock, wallet } from "./helpers/world.js";
import { ensureOnboardSchema } from "../src/store.js";
import { SESSION_SECONDS, createSession, isFresh } from "../src/auth.js";
import { POLICY } from "../src/policy.js";

let env;
beforeEach(() => { useClock("2026-10-09T12:00:00Z"); env = newWorld(); });
after(() => realClock());

const launch = () => { env.VICINITY_MINT = MINT; };
let n = 0;
/** A member made the v3 way: a Google (or e-mail) account with no wallet, a home community, and a 30-day session without a proof. */
async function walletless(env, { home = true, provider = "google", handle } = {}) {
  await ensureOnboardSchema(env.DB);
  n++;
  const now = Date.now(), at = new Date(now).toISOString();
  const r = await env.DB.prepare(`INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, home_at, early, created_at, terms_version, terms_agreed_at)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '2026-10-01', ?) RETURNING id`)
    .bind(provider, `${provider}-nw-${n}`, handle || `NoWallet${n}`, `Sa${n}`, home ? "5142056" : null, home ? "Utica" : null, home ? "US" : null, home ? at : null, at, at).first();
  const b = browser(env);
  const c = await createSession(env, { wallet: null, userId: r.id, provenAt: null }, SESSION_SECONDS, now);
  b.jar.set("vs", decodeURIComponent(c.split(";")[0].split("=")[1]));
  return { b, id: r.id, ...b };
}

test("/api/me for a member without a wallet: wallet null, holding zeros, no rank, setup 2 of 3, member number, badges, founder path waits for a wallet", async () => {
  launch();
  const holder = await person(env, { home: IN_UTICA, holds: 5000 }); // a member with a wallet, for the boards
  const { b, id } = await walletless(env);
  const me = await b.get("/api/me");
  assert.equal(me.signedIn, true);
  assert.equal(me.user.wallet, null, "the shape stays: wallet is there, null");
  assert.equal(me.user.id, id);
  assert.equal(me.fresh, true, "a Google login a moment ago counts as fresh for an account that holds nothing");
  assert.deepEqual(me.holding, { amount: 0, rank: null, total: null, percent: null, percentile: null, next: null, team: false });
  assert.equal(me.level, "member");
  assert.deepEqual(me.roles, { admin: false, manager: false, founder: false, steward: false, holder: false, weight: 1 });
  assert.deepEqual(me.setup, { percent: 67, steps: [{ id: "location", done: true }, { id: "account", done: true }, { id: "wallet", done: false }] });
  assert.equal(me.community.memberNumber, 2, "the holder joined first: this account is member #2 of Utica");
  assert.equal(me.community.members, 2, "counted as a member");
  assert.equal(me.community.rank, null);
  assert.equal(me.community.holders, 1, "only the wallet holder is on the board");
  assert.deepEqual(me.community.top.map((t) => t.you), [false], "never 'you' on a board without a wallet");
  assert.equal(me.national.rank, null);
  const badge = (idx) => me.badges.find((x) => x.id === idx);
  assert.equal(badge("verified").detail, "A verified Google login or e-mail.");
  assert.equal(badge("verified").earned, true);
  assert.deepEqual(me.badges.map((x) => x.id).slice(0, 4), ["early", "verified", "wallet", "local"], "the wallet badge sits right after verified");
  assert.equal(badge("wallet").earned, false);
  for (const idx of ["holder", "founder_ready", "whale", "top100", "top10"]) assert.equal(badge(idx).earned, false, idx);
  assert.equal(badge("local").earned, true);
  assert.equal(me.founder.eligible, false);
  assert.equal(me.founder.why, "no_wallet");
  assert.equal(me.founder.amount, 0);
  assert.deepEqual(me.progress.steps[0], { id: "account", label: "Link a wallet", done: false });
  assert.equal(me.progress.steps.find((s) => s.id === "hold").done, false);
  // the member with a wallet: the same keys, done
  const hm = await holder.get("/api/me");
  assert.deepEqual(hm.setup, { percent: 100, steps: [{ id: "location", done: true }, { id: "account", done: true }, { id: "wallet", done: true }] });
  assert.equal(hm.community.memberNumber, 1);
  assert.deepEqual(hm.progress.steps[0], { id: "account", label: "Account verified, wallet linked", done: true });
  assert.equal(hm.badges.find((x) => x.id === "wallet").earned, true);
  assert.equal(hm.holding.amount, 5000);
  // lite: the same user shape
  const lite = await b.get("/api/me?lite=1");
  assert.equal(lite.user.wallet, null);
  assert.equal(lite.fresh, true);
  assert.ok(!("setup" in lite), "lite stays small");
});

test("before launch: the founder path waits for launch first (not_launched), then for the wallet", async () => {
  const { b } = await walletless(env);
  let me = await b.get("/api/me");
  assert.equal(me.launched, false);
  assert.equal(me.founder.why, "not_launched");
  assert.equal(me.holding.amount, 0);
  launch();
  me = await b.get("/api/me");
  assert.equal(me.founder.why, "no_wallet");
});

test("leaderboards, /api/members and the Launchpad counts: a member without a wallet is a member, never a holder", async () => {
  launch();
  const a = await person(env, { home: IN_UTICA, holds: 100 });
  await walletless(env);
  await walletless(env);
  const me = await a.get("/api/me");
  assert.equal(me.community.members, 3);
  assert.equal(me.community.holders, 1);
  assert.equal(me.community.rank, 1);
  await tick(env); // a balance sample: /api/members counts holders from it
  const members = await browser(env).get("/api/members");
  assert.equal(members.members, 3);
  const utica = members.communities.find((c) => c.id === "5142056");
  assert.equal(utica.members, 3);
  assert.equal(utica.holders, 1);
  // the Launchpad list (LAUNCHPAD_V2=on): the community counts of a coin's city follow the same rule
  env.LAUNCHPAD_V2 = "on";
  const { communityCounts } = await import("../src/launchpad.js").then((m) => ({ communityCounts: m._communityCounts }));
  if (communityCounts) {
    const counts = await communityCounts(env, new Set(["5142056"]), Date.now());
    assert.deepEqual(counts.get("5142056"), { members: 3, holders: 1 });
  }
});

test("the founder path and squads need a wallet: eligibility says no_wallet, apply / squad create / join / apply refuse before any row is written", async () => {
  launch();
  const { b } = await walletless(env);
  const att = await attest(b, IN_UTICA, "apply");
  const apply = await b.send("/api/seats/apply", { method: "POST", body: { attestation: att, pitch: "me" } });
  assert.equal(apply.status, 403);
  assert.equal((await apply.json()).error, "no_wallet");
  for (const [path, body] of [["/api/seats/squad/create", {}], ["/api/seats/squad/join", { squadId: 1 }], ["/api/seats/squad/apply", { squadId: 1, attestation: att }]]) {
    const r = await b.send(path, { method: "POST", body });
    assert.equal(r.status, 400, path);
    assert.equal((await r.json()).error, "no_wallet", path);
  }
  for (const t of ["applications", "squads", "squad_members", "seats", "windows"]) assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n, 0, t);
});

test("verified local holders (the steward quorum) never count a member without a wallet, even with a check-in", async () => {
  launch();
  const { b } = await walletless(env);
  const post = await b.post("/api/posts", { kind: "checkin", body: "here", attestation: await attest(b, IN_UTICA, "checkin") });
  assert.equal(post.error, "holders_only", "after launch only holders post; a wallet-less member holds nothing");
  const { checkedInWallets } = await import("../src/seats.js");
  await env.DB.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (?, 'city', '5142056', 'US', 'checkin', 'x', ?)").bind((await b.get("/api/me")).user.id, new Date().toISOString()).run();
  assert.deepEqual(await checkedInWallets(env.DB, "5142056"), []);
});

test("posting: works before launch (a member), holders_only after launch; voting and reporting work before launch", async () => {
  const { b } = await walletless(env);
  const other = await person(env, { home: IN_UTICA });
  const p = await b.post("/api/posts", { kind: "meme", scope: "city", body: "hello Utica" });
  assert.equal(p.ok, true, JSON.stringify(p));
  const theirs = await other.post("/api/posts", { kind: "meme", scope: "city", body: "hi" });
  assert.equal((await b.post("/api/posts/vote", { id: theirs.post.id })).ok, true);
  assert.equal((await b.post("/api/posts/report", { id: theirs.post.id, reason: "x" })).ok, true);
  const feed = await b.get("/api/posts?scope=city&kind=meme");
  assert.equal(feed.ok, true);
  assert.equal(feed.posts.length, 2);
  launch();
  assert.equal((await b.post("/api/posts", { kind: "meme", scope: "city", body: "again" })).error, "holders_only");
});

test("the profile of a member without a wallet: wallet null, walletLinked false, holding and portfolio null; their own portfolio is null too", async () => {
  env.PROFILES = "on";
  launch();
  const viewer = await person(env, { home: IN_UTICA, holds: 10 });
  const { b } = await walletless(env, { handle: "SaNoWallet" });
  const r = await viewer.get("/api/profile?u=SaNoWallet");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.profile.wallet, null);
  assert.equal(r.profile.walletLinked, false);
  assert.equal(r.profile.holding, null);
  assert.equal(r.profile.portfolio, null);
  assert.equal(r.profile.level, "member");
  assert.equal(r.profile.badges.find((x) => x.id === "wallet").earned, false);
  assert.equal(r.profile.badges.find((x) => x.id === "holder").earned, false);
  const own = await b.get("/api/profile");
  assert.equal(own.ok, true);
  assert.equal(own.profile.walletLinked, false);
  const pf = await b.get("/api/me/portfolio");
  assert.equal(pf.ok, true);
  assert.equal(pf.portfolio, null);
  // the viewer with a wallet: unchanged
  const vp = await viewer.get("/api/profile");
  assert.equal(vp.profile.walletLinked, true);
  assert.equal(vp.profile.wallet, viewer.w.address);
});

test("admin standing needs a wallet: /api/admin/* answers 401 sign_in for a member without one, whatever ADMIN_WALLETS says; the user list shows wallet null", async () => {
  const { b } = await walletless(env);
  const r = await b.send("/api/admin/me");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "sign_in");
  assert.equal((await b.send("/api/admin/users")).status, 401);
  // an admin sees the row with wallet null, and can ban it by id
  const admin = await person(env, { home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;
  const list = await admin.get("/api/admin/users");
  assert.equal(list.ok, true);
  const row = list.users.find((u) => u.wallet === null);
  assert.ok(row, "the wallet-less member is listed with wallet null");
  assert.equal(await (async () => { const x = await admin.post("/api/auth/reprove", await loginBody(admin.w)); return x.ok; })(), true);
  const ban = await admin.post("/api/admin/users/ban", { userId: row.id, reason: "spam" });
  assert.equal(ban.ok, true, JSON.stringify(ban));
  assert.equal((await b.get("/api/me")).ban.country, "*");
  const unban = await admin.post("/api/admin/users/unban", { userId: row.id });
  assert.equal(unban.ok, true);
  assert.equal((await admin.post("/api/admin/users/ban", { reason: "spam" })).error, "bad_wallet", "neither a wallet nor an id");
  assert.equal((await admin.post("/api/admin/users/ban", { userId: 99999, reason: "spam" })).error, "not_found");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE provider = 'wallet'").first()).n, 0, "no bootstrap row was ever made for a NULL wallet");
});

test("re-proving needs a wallet: /api/auth/reprove answers 403 no_wallet; a transfer re-proof refuses too", async () => {
  const { b } = await walletless(env);
  const w = await wallet();
  const r = await b.send("/api/auth/reprove", { method: "POST", body: await loginBody(w) });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: "no_wallet" });
  const t = await b.post("/api/auth/transfer", { address: w.address, reprove: true });
  assert.equal(t.error, "wrong_wallet", "a wallet-less account has no wallet to re-prove with");
});

test("freshness: for an account without a wallet the login counts for 30 minutes (a username change works), then it is stale (reprove); a linked wallet's proof is the only proof", async () => {
  const { b } = await walletless(env);
  advance(10 * 60_000);
  let r = await b.post("/api/me/username", { username: "Freshname1" });
  assert.equal(r.ok, true, JSON.stringify(r));
  advance(21 * 60_000);
  r = await b.post("/api/me/username", { username: "Freshname2" });
  assert.equal(r.error, "reprove", "31 minutes after the login: no longer fresh");
  // the rule on its own
  const now = Date.now();
  const mk = (o) => ({ id: "s", created_at: new Date(now - 10 * 60_000).toISOString(), proven_at: null, ...o });
  assert.equal(isFresh(mk({ user: { wallet: null } }), now), true);
  assert.equal(isFresh(mk({ user: { wallet: null }, created_at: new Date(now - 31 * 60_000).toISOString() }), now), false);
  assert.equal(isFresh(mk({ user: { wallet: "W" } }), now), false, "a wallet is linked: the login alone proves nothing");
  assert.equal(isFresh(mk({ user: { wallet: "W" }, proven_at: new Date(now - 5 * 60_000).toISOString() }), now), true);
  assert.equal(isFresh(mk({ user: null, wallet: "W" }), now), false, "a pending session (no account) is only fresh by its proof");
  assert.equal(isFresh(null, now), false);
  assert.equal(POLICY.freshProofMinutes, 30);
});

test("every signed-in route answers a member without a wallet without a 500", async () => {
  launch();
  env.PROFILES = "on";
  const { b } = await walletless(env);
  const w = await wallet();
  const calls = [
    ["GET", "/api/me"], ["GET", "/api/me?lite=1"], ["POST", "/api/me/terms", { version: "2026-10-01" }], ["POST", "/api/me/phone", { phone: "+1 315 555 0100" }],
    ["POST", "/api/locate", { location: IN_UTICA, purpose: "home", country: "US" }], ["POST", "/api/locate/handoff", { purpose: "home" }],
    ["GET", "/api/posts?scope=city&kind=meme"], ["GET", "/api/posts?scope=country&kind=checkin"], ["POST", "/api/posts", { kind: "talk", scope: "city", body: "x" }],
    ["POST", "/api/posts/vote", { id: 1 }], ["POST", "/api/posts/report", { id: 1 }],
    ["POST", "/api/seats/withdraw", {}], ["POST", "/api/seats/endorse", { applicationId: 1 }], ["POST", "/api/seats/object", { seatId: 1, reason: "x" }], ["POST", "/api/seats/resign", {}],
    ["POST", "/api/seats/squad/leave", { squadId: 1 }], ["GET", "/api/seats/squad/1"], ["POST", "/api/elections/vote", { electionId: 1, seatId: 1 }], ["POST", "/api/appeals", { actionId: 1, text: "please reconsider this" }],
    ["GET", "/api/towns"], ["POST", "/api/towns", { name: "New Hartford" }], ["GET", "/api/mod"], ["POST", "/api/mod/hide", { id: 1, reason: "spam" }],
    ["GET", "/api/coins?city=5142056"], ["POST", "/api/coins/design", { name: "X" }], ["GET", "/api/me/portfolio"], ["GET", "/api/profile"], ["GET", "/api/follows"], ["GET", "/api/me/blocks"],
    ["POST", "/api/me/bio", { bio: "hi" }], ["GET", "/api/admin/me"], ["GET", "/api/admin/users"], ["POST", "/api/auth/reprove", await loginBody(w)], ["POST", "/api/auth/transfer", { address: w.address, reprove: true }],
    ["POST", "/api/snapshots/cancel", { id: 1 }], ["POST", "/api/home", { attestation: "x" }], ["POST", "/api/me/username", { username: "Okname7" }],
  ];
  for (const [method, path, body] of calls) {
    const r = await b.send(path, { method, body });
    assert.ok(r.status < 500, `${method} ${path} answered ${r.status}: ${await r.text()}`);
  }
});

test("drift guard: the files that read users.wallet are the ones this change reviewed", () => {
  // Every source file that touches a member's wallet column had to learn that NULL means "no wallet linked". A new file reading it must be
  // reviewed the same way (and added here on purpose).
  const reviewed = new Set(["admin.js", "attest.js", "auth.js", "coins.js", "elections.js", "launchpad.js", "me.js", "moderation.js", "profiles.js", "portfolio.js", "pwlogin.js",
    "roles.js", "seats.js", "signup.js", "snapshot.js", "social.js", "walletlink.js", "handoff.js", "signup-core.js", "profile-core.js"]);
  const dir = new URL("../src/", import.meta.url);
  const offenders = readdirSync(dir).filter((f) => f.endsWith(".js") && !reviewed.has(f)).filter((f) => {
    const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    return /\b(u|user|a\.u|s\.user|m|who|me|member)\.wallet\b/.test(src) || /\bFROM users\b[^;]*\bwallet\b/.test(src);
  });
  assert.deepEqual(offenders, [], "new readers of users.wallet: handle NULL (no wallet linked), then add the file to `reviewed`");
});
