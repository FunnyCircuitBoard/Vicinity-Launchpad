// Helpers for the sign-up v2 tests: a mail sender that remembers the codes, a Google stand-in, and the steps of the
// journey (start, location, terms, e-mail or Google, wallet, finish) as small functions that go through the real API.
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

/** Prove a wallet the normal way (a signed message). Returns the API answer. */
export const doWallet = async (b, w) => b.post("/api/auth/wallet", await loginBody(w));
export const finish = (b) => b.post("/api/signup/finish");

let nextSub = 1;
/**
 * The whole journey for a new person, in the order the page asks. via: "email" | "google". Returns everything a test may need.
 * Set `until` to stop early: "location" | "terms" | "account" | "wallet" (the last one done) | "finish" (default: finish).
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
  } else {
    out.sub = sub || "g-new-" + nextSub++;
    out.account = await doGoogle(b, out.sub);
  }
  if (stop("account")) return out;
  out.wallet = await doWallet(b, out.w);
  if (stop("wallet")) return out;
  out.finish = await finish(b);
  return out;
}

/** A finished member made through the v2 journey (the old callbacks can no longer create accounts in v2). */
export async function member(env, box, opts = {}) {
  const b = browser(env, opts.net);
  const j = await journey(b, box, opts);
  assert.equal(j.finish && j.finish.ok, true, JSON.stringify(j.finish));
  return { b, ...j };
}

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
