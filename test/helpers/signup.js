// Helpers for the sign-up tests (v2, onboarding v3): a mail sender that remembers the codes, a Google stand-in, and the steps of
// the journey (start, location, terms, e-mail or Google: the account exists the moment the login is verified) as small functions
// that go through the real API. The wallet is no part of the sign-up any more: doWallet is a wallet LOG-IN (an existing member).
import assert from "node:assert/strict";
import { IN_UTICA, browser, chain, loginBody, wallet } from "./world.js";

export const TERMS = "2026-10-01";
export const GOOD_PASSWORD = "correct horse battery staple";

/**
 * A Resend stand-in. `sent` collects { to, code, kind, subject }; `fetch` also answers the Solana calls of the test chain,
 * so one fetchImpl serves a whole journey. fail(true) makes the mail service refuse (the slot must be given back).
 */
export function outbox() {
  const sent = [];
  const box = {
    sent,
    failing: false,
    last: () => sent[sent.length - 1],
    codeFor: (to) => [...sent].reverse().find((m) => m.to === to)?.code,
    fetch: async (url, init) => {
      if (String(url) !== "https://api.resend.com/emails") return chain()(url, init);
      if (box.failing) return new Response("{}", { status: 500 });
      const body = JSON.parse(init.body);
      const code = body.text.match(/code is (\d{6})/)[1];
      const kind = /verification code/.test(body.text) ? "signup" : /password reset code/.test(body.text) ? "reset" : "signin";
      sent.push({ to: body.to[0], code, kind, subject: body.subject });
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    },
  };
  return box;
}

/** What Google's token endpoint answers for one Google account. */
export const fakeGoogle = (sub, name = "G" + sub) => async () => new Response(JSON.stringify({
  id_token: "x." + Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: "gid", sub, given_name: name })).toString("base64url") + ".y",
}));

/* ---------- the steps ---------- */

export const startSignup = (b) => b.post("/api/signup/start");
export const stateOf = async (b) => (await b.get("/api/signup/state")).state;
export const doLocation = (b, point = IN_UTICA) => b.post("/api/signup/location", { location: point, country: "US" });
export const doTerms = (b, version = TERMS) => b.post("/api/signup/terms", { version });
export const pickCommunity = (b, id) => b.post("/api/signup/location/choice", { id });

/** Type an address and password, then the code from the mailbox. Returns { start, verify, email }. */
export async function doEmail(b, box, email, { password = GOOD_PASSWORD, verify = true } = {}) {
  const start = await (await b.send("/api/signup/email", { method: "POST", body: { email, password }, fetchImpl: box.fetch })).json();
  if (!verify || !start.ok) return { start, email };
  const code = box.codeFor(email.trim().toLowerCase());
  const done = await (await b.send("/api/signup/email/verify", { method: "POST", body: { email, code }, fetchImpl: box.fetch })).json();
  return { start, verify: done, email };
}

/** The Google step of a sign-up: start (with ?signup=1) and the callback. Returns { to } (where the callback sends the person) and the raw responses. */
export async function doGoogle(b, sub, { name } = {}) {
  const start = await b.send("/api/auth/google/start?signup=1");
  const loc = start.headers.get("location");
  if (!loc.startsWith("https://accounts.google.com/")) return { start, to: loc };
  const state = new URL(loc).searchParams.get("state");
  const cb = await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: fakeGoogle(sub, name) });
  return { start, cb, to: cb.headers.get("location") };
}

/** Sign in with a wallet (a signed login message): a member's wallet signs in, an unknown one is refused (no_account). Returns the API answer. */
export const doWallet = async (b, w) => b.post("/api/auth/wallet", await loginBody(w));
/** POST /api/signup/finish: the same atomic step the account step runs itself, for a page that reloads or retries. */
export const finish = (b) => b.post("/api/signup/finish");

let nextSub = 1;
/**
 * The whole journey for a new person, in the order the page asks. via: "email" | "google". Returns everything a test may need:
 * `finish` is what the account step answered about the account ({ ok, next } from the e-mail code, or { ok, next } read off the
 * Google callback's redirect), since the account is made the moment the login is verified.
 * Set `until` to stop early: "location" | "terms" (the last one done) | "finish" (default: the whole journey).
 * `w` is only kept on the result (tests that link or log in with a wallet afterwards): the sign-up itself never sees a wallet.
 */
export async function journey(b, box, { via = "email", email, sub, point = IN_UTICA, password = GOOD_PASSWORD, w, until = "finish" } = {}) {
  const out = { w: w || (await wallet()), via };
  const stop = (step) => until === step;
  out.start = await startSignup(b);
  assert.equal(out.start.ok, true, JSON.stringify(out.start));
  out.location = await doLocation(b, point);
  if (point && out.location.ok !== true) return out;
  if (stop("location")) return out;
  out.terms = await doTerms(b);
  if (stop("terms")) return out;
  if (via === "email") {
    out.email = email || `new${nextSub++}@example.com`;
    out.account = await doEmail(b, box, out.email, { password });
    const v = out.account.verify || {};
    out.finish = v.ok && v.isNew ? { ok: true, next: v.next, welcome: v.welcome } : { ok: false, error: v.error || v.finishError || (v.existing ? "existing" : "unverified"), verify: v };
  } else {
    out.sub = sub || "g-new-" + nextSub++;
    out.account = await doGoogle(b, out.sub);
    const to = out.account.to || "";
    out.finish = to === "/dashboard?welcome=1" ? { ok: true, next: to } : { ok: false, error: to, to };
  }
  return out;
}

/** A finished member made through the journey (the old callbacks can no longer create accounts in v2): no wallet linked yet. */
export async function member(env, box, opts = {}) {
  const b = browser(env, opts.net);
  const j = await journey(b, box, opts);
  assert.equal(j.finish && j.finish.ok, true, JSON.stringify(j.finish));
  return { b, ...j };
}

/** The users row of a member made by journey()/member(). */
export const userOf = (env, m) => env.DB.prepare("SELECT * FROM users WHERE provider = ? AND provider_id = ?").bind(m.via === "google" ? "google" : "email", m.via === "google" ? m.sub : m.email).first();

/**
 * Link the member's wallet (m.w) to their account the way the dashboard's link does (users.wallet set, every session of the user
 * carries it; this browser's session gets the proof time when `proven`): the tests of what a member WITH a wallet can do. Written
 * straight into the database, so these tests do not depend on the link routes (test/wallet-link.test.js covers those).
 */
export async function linkDirect(env, m, { proven = false } = {}) {
  const now = new Date(Date.now()).toISOString();
  const u = await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_id = ?").bind(m.via === "google" ? "google" : "email", m.via === "google" ? m.sub : m.email).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET wallet = ? WHERE id = ? AND wallet IS NULL").bind(m.w.address, u.id),
    env.DB.prepare("UPDATE sessions SET wallet = ?, proven_at = CASE WHEN ? THEN ? ELSE proven_at END WHERE user_id = ?").bind(m.w.address, proven ? 1 : 0, now, u.id),
  ]);
  return m;
}
/** A member whose wallet is linked (and, by default, freshly proven in their browser): what every member was before onboarding v3. */
export const memberWithWallet = async (env, box, opts = {}) => linkDirect(env, await member(env, box, opts), { proven: opts.proven !== false });

/** Every row of every table, as text: for "this number / this address is nowhere in the database". */
export async function dumpAll(db) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()).results.map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = (await db.prepare(`SELECT * FROM ${t}`).all()).results;
  return JSON.stringify(out);
}

export const rows = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
export const one = (db, sql, ...params) => db.prepare(sql).bind(...params).first();

/** The tables of a database, and the columns of the two the sign-up adds to: { tables, columns: { users, handoffs } }. */
export async function tablesAndColumns(db) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map((r) => r.name);
  const cols = async (t) => (await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((r) => r.name);
  return { tables, columns: { users: await cols("users"), handoffs: await cols("handoffs") } };
}

/** Remember the text of every answer a browser gets: returns the array it fills (and `.items`, the same with the path of each). */
export function recordAnswers(b) {
  const seen = [];
  seen.items = [];
  b.net.tap = async ({ path, response }) => { const text = await response.text(); seen.push(text); seen.items.push({ path, text }); };
  return seen;
}
