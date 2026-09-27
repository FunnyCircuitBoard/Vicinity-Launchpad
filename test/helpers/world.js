// A small test world: a few US cities with boundaries, a fake Solana, a clock that tests can move,
// and signed-in people. Everything goes through the real API (handleApi) and real SQL (helpers/d1.js).
import assert from "node:assert/strict";
import { handleApi } from "../../src/index.js";
import { base58Decode, base58Encode, buildMessage, statementFor } from "../../src/solana.js";
import { _resetCityCache } from "../../src/cities.js";
import { _resetSnapshots } from "../../src/chain.js";
import { encodeArea } from "../../src/geo.js";
import { runJobs } from "../../src/jobs.js";
import { d1 } from "./d1.js";

export const HOST = "vicinity.test", ORIGIN = `https://${HOST}`;
export const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
export const POOL = "PooL1111111111111111111111111111111111111111";
export const DAY = 86400_000, HOUR = 3600_000;

export const CITIES = { source: "test", countries: { US: "United States" }, admin: {}, byCountry: { US: [
  [5128581, "New York City", "NY", 40.71, -74.01, 8800000],
  [5140405, "Syracuse", "NY", 43.05, -76.15, 142000],
  [5106834, "Albany", "NY", 42.65, -73.76, 99000],
  [5142056, "Utica", "NY", 43.1, -75.23, 61100],
] } };
const square = (w, s, e, n) => [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]];
const line = (id, kind, [w, s, e, n]) => `${id}\t${kind}\t${w},${s},${e},${n}\t${JSON.stringify(encodeArea(square(w, s, e, n)))}`;
export const BOUNDS = [
  line(5128581, "r", [-74.3, 40.5, -73.7, 40.95]),
  line(5140405, "n", [-76.3, 42.95, -76.0, 43.15]),
  line(5106834, "r", [-73.9, 42.55, -73.65, 42.75]),
  line(5142056, "r", [-75.35, 43.0, -75.1, 43.2]),
].join("\n");
export const IN_UTICA = { lat: 43.1, lon: -75.23, accuracy: 30 };
export const IN_NYC = { lat: 40.71, lon: -74.0, accuracy: 30 };
export const EMPTY = { lat: 42.4, lon: -75.0, accuracy: 30 };

// ---- the clock: Date.now() is whatever the test says ----
const realNow = Date.now;
export const clock = { now: Date.parse("2026-10-01T12:00:00Z") };
export const useClock = (at = "2026-10-01T12:00:00Z") => { clock.now = Date.parse(at); Date.now = () => clock.now; };
export const realClock = () => { Date.now = realNow; };
export const advance = (ms) => { clock.now += ms; _resetSnapshots(); };

// ---- a fake Solana: every holder via getProgramAccounts, balances, facts ----
export const holdings = {};
export const setHolding = (address, amount) => { holdings[address] = amount; _resetSnapshots(); };
export function chain() {
  return async (url, init) => {
    if (!String(url).startsWith("https://api.mainnet-beta.solana.com") && !String(url).includes("rpc")) return new Response("{}", { status: 404 });
    const body = JSON.parse(init.body);
    const one = ({ method, params }) => {
      if (method === "getAccountInfo") return { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } };
      if (method === "getProgramAccounts") return { context: { slot: Math.floor(clock.now / 400) }, value: Object.entries(holdings).filter(([, a]) => a > 0).map(([owner, amount], i) => {
        const bytes = new Uint8Array(40); bytes.set(base58Decode(owner), 0);
        let raw = BigInt(Math.round(amount * 1e6));
        for (let j = 0; j < 8; j++) { bytes[32 + j] = Number(raw & 255n); raw >>= 8n; }
        return { pubkey: "acc" + i, account: { data: [Buffer.from(bytes).toString("base64"), "base64"] } };
      }) };
      if (method === "getMultipleAccounts") return { value: params[0].map((k) => ({ owner: k === POOL ? "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" : "11111111111111111111111111111111" })) };
      if (method === "getTokenAccountsByOwner") { const a = holdings[params[0]] || 0; return { value: a ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: a } } } } } }] : [] }; }
      throw new Error("unexpected " + method);
    };
    const out = Array.isArray(body) ? body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: one(b) })) : { jsonrpc: "2.0", id: 1, result: one(body) };
    return new Response(JSON.stringify(out));
  };
}

export function newWorld(extra = {}) {
  _resetCityCache(); _resetSnapshots();
  for (const k of Object.keys(holdings)) delete holdings[k];
  const files = { "/data/cities.json": JSON.stringify(CITIES), "/data/bounds/US.txt": BOUNDS };
  const assets = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
  return { DB: d1(), ASSETS: assets, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "s", ...extra };
}

export async function wallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (text) => Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}
export const loginBody = async (w, pin) => {
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop", issuedAt: new Date(Date.now()).toISOString(), statement: statementFor("login", { pin }) });
  return { address: w.address, message, signature: await w.sign(message) };
};

/** A browser: keeps cookies, sends Origin like real browsers. */
export function browser(env) {
  const jar = new Map();
  const send = async (path, { method = "GET", body, fetchImpl = chain() } = {}) => {
    const headers = new Headers({ origin: ORIGIN });
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await handleApi(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, fetchImpl);
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split("; "); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  };
  return { send, jar, get: async (p) => (await send(p)).json(), post: async (p, body = {}) => (await send(p, { method: "POST", body })).json() };
}

let nextId = 1;
/** A signed-in person (wallet + Google), optionally with a home community (set via a real location attestation). */
export async function person(env, { home, holds } = {}) {
  const w = await wallet(), b = browser(env);
  await b.post("/api/auth/wallet", await loginBody(w));
  const start = await b.send("/api/auth/google/start");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const id = "g" + nextId++;
  const google = async () => new Response(JSON.stringify({ id_token: "x." + Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: "gid", sub: id, given_name: "P" + id })).toString("base64url") + ".y" }));
  await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: google });
  const me = { w, id, name: "P" + id, ...b };
  if (home) {
    const r = await me.post("/api/home", { attestation: await attest(me, home, "home") });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  if (holds != null) setHolding(w.address, holds);
  return me;
}
/** Get a location attestation for a purpose (the only way the API ever sees a location). */
export async function attest(p, point, purpose) {
  const r = await p.post("/api/locate", { location: point, purpose, country: "US" });
  return r.attestation || null;
}
/** Prove the wallet again (sensitive actions need it within 30 minutes); signs in again if the 30-day session ran out. */
export async function reprove(p) {
  const r = await p.post("/api/auth/reprove", await loginBody(p.w));
  return r.error === "sign_in" ? p.post("/api/auth/wallet", await loginBody(p.w)) : r;
}

/** Run the scheduled job. sample: true = take a balance sample this time. */
export const tick = (env, { sample = true } = {}) => runJobs(env, clock.now, chain(), () => (sample ? 0 : 0.99));
/** Move time forward in steps, running the job (with a sample) at every step. */
export async function passTime(env, ms, step = 6 * HOUR) {
  for (let t = 0; t < ms; t += step) { advance(Math.min(step, ms - t)); await tick(env); }
}
