// Host-safe routing (Citycoin.dev master v5, stage S03): src/hostroute.js, the HOST_REDIRECT gate in src/v5policy.js and the Worker entry
// in src/index.js. With HOST_REDIRECT unset (or set but refused) every host, scheme, method and path answers exactly as before: the old
// names 301 to vicinity.city and plain http 301 to https, for every method. With HOST_REDIRECT accepted (a fixture configuration:
// SITE_ORIGIN https://citycoin.dev, DEPLOYMENT_ENV production, and a stand-in for a page build made with run_worker_first true, which the
// committed wrangler.jsonc does not have): 308 for ordinary public GET and HEAD on every other accepted host, 421 wrong_host for every
// other method, wallet challenge, sign-in, hand-off, callback or webhook, the immutable legacy files and the read-only API in place on
// every accepted host, unknown hosts refused. citycoin.dev is not attached to the Worker; no request here leaves this process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import worker from "../src/index.js";
import * as W from "./helpers/world.js";
import { SECURITY_HEADERS } from "../src/http.js";
import { _pagesBuiltForTests, checkPolicyConfig, hostRedirect, hostRedirectRefusals, _resetPolicyCheck } from "../src/v5policy.js";
import { HANDOFF_QUERY_KEYS, IMMUTABLE_PATHS, SAFE_QUERY_KEYS, acceptedHost, hostAnswer, isImmutable, isOriginBound, onOrigin, safeQuery } from "../src/hostroute.js";
import { LEGACY_FORWARD_HOSTS, LEGACY_HOSTS, siteConfig } from "../src/site-config.js";
import { PAGES_BUILT } from "../src/pages-built.js";
import { deployedAssets, deployedVars, pageRouting, pagesBuiltSource } from "../scripts/pages/build.mjs";

// nothing here reaches the network: the test world's fake chain answers RPC, the market sources answer empty, anything else fails at once
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const ok = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  if (/(^|\.)jup\.ag$/.test(u.hostname)) return ok(u.pathname === "/tokens/v2/search" ? [] : {});
  if (/raydium\.io$|dexscreener/.test(u.hostname)) return ok({ success: true, data: { rows: [] }, pairs: [] });
  return W.chain()(url, init);
};
W.useClock("2026-10-20T12:00:00Z");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const WRANGLER = JSON.parse(read("wrangler.jsonc").toString("utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
const VARS = WRANGLER.vars;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
// the static assets as the ASSETS binding serves them (public/, clean URLs, the 404 page)
const ASSETS = { fetch: async (req) => {
  let p = decodeURIComponent(new URL(req.url).pathname);
  if (p.endsWith("/")) p += "index.html";
  for (const t of [p, `${p}.html`]) {
    try { const bytes = read(`public${t}`); return new Response(bytes, { status: 200, headers: { "content-type": TYPES[extname(t)] || "application/octet-stream", etag: '"fixed"' } }); } catch { /* next */ }
  }
  return new Response(read("public/404.html"), { status: 404, headers: { "content-type": TYPES[".html"] } });
} };
const world = (extra = {}) => W.newWorld({ ...VARS, GOOGLE_CLIENT_ID: "gid", ASSETS, ...extra });
/** A member signed in today (wallet + Google, a home community), made the way the test world makes one (the old sign-up path). */
async function member(env) {
  const flow = env.SIGNUP_FLOW; delete env.SIGNUP_FLOW;
  try { return await W.person(env, { home: W.IN_UTICA, holds: 1_000_000 }); } finally { env.SIGNUP_FLOW = flow; }
}
const ctx = { waitUntil() {}, passThroughOnException() {} };

/** The accepted fixture: the switch, a named environment and SITE_ORIGIN https://citycoin.dev (the only target the v5 check accepts). */
const ON = Object.freeze({ HOST_REDIRECT: "on", DEPLOYMENT_ENV: "production", SITE_ORIGIN: "https://citycoin.dev",
  SITE_ORIGINS: "https://citycoin.dev https://www.citycoin.dev https://vicinity.city" });
const CANON = "https://citycoin.dev";
const pagesReachWorker = () => _pagesBuiltForTests({ pagesReachWorker: true });
const pagesAsCommitted = () => _pagesBuiltForTests(null);

const ADDR = "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN";
const MINT = VARS.VICINITY_MINT;
// [path, class]: page = an ordinary public page or file; immutable; read = read-only /api; bound = origin-bound GET
const PATHS = [
  ["/", "page"], ["/dashboard", "page"], ["/cities?city=5128581", "page"], ["/style.css", "page"], ["/no-such-page-zq", "page"],
  [`/connect?link=L1&carry=C1&pair=P1&code=X1&state=S1&register=1&ref=R1&next=%2Fadmin&mode=login&utm_source=mail`, "page"],
  [`/token?address=${ADDR}&tab=holders&token=T1`, "page"],
  [`/coin-meta/${MINT}.json`, "immutable"], [`/coin-meta/${MINT}.png`, "immutable"], [`/coin-meta/art/${"ab".repeat(32)}.png`, "immutable"],
  ["/brand/vicinity-512.png", "immutable"], ["/official-coins.csv", "immutable"],
  ["/api/health", "read"], ["/api/official", "read"], ["/api/official-coins", "read"], ["/api/policy", "read"], ["/api/me", "read"],
  ["/api/check?q=%40VicinityCitySOL", "read"],
  [`/api/message?address=${ADDR}&action=login`, "bound"], ["/api/auth/google/start", "bound"], ["/api/auth/google/callback?code=c&state=s", "bound"],
  ["/api/pair?code=abc", "bound"], ["/api/signup/state", "bound"], ["/api/me/wallet/carry/info", "bound"], ["/api/locate", "bound"],
  ["/api/payments/webhook", "bound"],
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ACCEPTED_HOSTS = ["citycoin.dev", "www.citycoin.dev", "vicinity.city", "www.vicinity.city", "vicinitycity.net", "www.vicinitycity.net"];
const UNKNOWN_HOSTS = ["evil.example", "vicinity.city.evil.example", "citycoin.dev.evil.example", "evilcitycoin.dev", "vicinity.city.", "127.0.0.2"];

const request = (url, method = "GET", headers = {}) => new Request(url, { method, headers: { origin: new URL(url).origin, ...headers },
  body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined });
/** An answer as data. Random values (nonces, codes, ids) and wall-clock times are masked so two worlds given the same requests compare equal. */
const mask = (t) => String(t).replace(/[A-Za-z0-9_-]{20,}/g, (m) => (m === MINT || m === ADDR ? m : "<r>"))
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>").replace(/"pin":"\d+"/g, '"pin":"<r>"');
/** Routes whose answer names the request's own host today (the wallet challenge's text, the Google return address: stage S04 moves them
 *  to configuration). Their served answer is compared with the same request, not with the same path on vicinity.city. */
const HOST_NAMED = new Set(["/api/message", "/api/auth/google/start"]);
/** The switch-off request whose answer a served request must equal: the same request on the canonical host (and on a host whose answer
 *  names it), else the same path on vicinity.city, which the switch-off Worker serves in place (it 301s the old names). */
const reference = (url, path) => {
  const u = new URL(url);
  return (u.protocol === "https:" && u.hostname === "citycoin.dev") || HOST_NAMED.has(u.pathname) ? url : `https://vicinity.city${path}`;
};
async function snap(res) {
  const bytes = res.body ? Buffer.from(await res.arrayBuffer()) : null;
  const text = bytes && /json|text|csv|html|javascript|svg/.test(res.headers.get("content-type") || "") ? mask(bytes.toString("utf8")) : bytes && bytes.toString("base64");
  return { status: res.status, headers: [...res.headers].map(([k, v]) => [k, mask(v)]).sort(), body: text };
}
const call = async (env, url, method = "GET", headers = {}) => snap(await worker.fetch(request(url, method, headers), env, ctx));
const headerOf = (s, name) => (s.headers.find(([k]) => k === name) || [])[1] ?? null;

/** What today's Worker answers before any route (the rule HOST_REDIRECT off keeps): a 301 for the old names and plain http, or null. */
function todays(url) {
  const u = new URL(url);
  const forward = LEGACY_FORWARD_HOSTS.includes(u.hostname);
  if (!forward && u.protocol !== "http:") return null;
  return `https://${forward ? "vicinity.city" : u.hostname}${u.pathname}${u.search}`;
}
const REDIRECT_HEADERS = (location) => [["cache-control", "public, max-age=3600"], ["location", location],
  ...Object.entries(SECURITY_HEADERS).filter(([k]) => k !== "Cache-Control").map(([k, v]) => [k.toLowerCase(), v])].sort();
/** A redirect with exactly today's headers (the security headers, one hour of caching, the Location) and no body, masked like snap(). */
const redirectTo = (status, location) => ({ status, headers: REDIRECT_HEADERS(location).map(([k, v]) => [k, mask(v)]), body: null });

/* ---------------------------------------------------------------- the gate */

test("HOST_REDIRECT unset reads one setting and nothing else; a throwing setting reads as off", () => {
  const seen = [];
  const env = new Proxy({}, { get(_, k) { seen.push(k); return undefined; } });
  assert.equal(hostRedirect(env), false);
  assert.deepEqual(seen, ["HOST_REDIRECT"], "with the switch unset the Worker's every request costs what it cost before");
  const boom = new Proxy({}, { get() { throw new Error("boom"); } });
  assert.equal(hostRedirect(boom), false);
  assert.deepEqual(hostRedirectRefusals(boom), ["HOST_REDIRECT_CHECK_FAILED"]);
});

test("the switch counts only with every precondition: the pages reach the Worker, an accepted site configuration and an accepted v5 check", () => {
  pagesAsCommitted();
  assert.equal(PAGES_BUILT.pagesReachWorker, false, "the committed wrangler.jsonc serves the pages without the Worker");
  assert.deepEqual(hostRedirectRefusals(ON), ["HOST_REDIRECT_PAGES_BYPASS_WORKER"]);
  assert.equal(hostRedirect(ON), false, "as committed, even a complete configuration does nothing");
  pagesReachWorker();
  try {
    assert.equal(hostRedirect(ON), true);
    assert.equal(hostRedirect({ ...ON, HOST_REDIRECT: " ON " }), true, "trimmed, any letter case");
    for (const v of [undefined, "", "off", "true", "1", "yes", "onn"]) assert.equal(hostRedirect({ ...ON, HOST_REDIRECT: v }), false, String(v));
    const refused = [
      [{ ...ON, DEPLOYMENT_ENV: "" }, ["HOST_REDIRECT_POLICY_REFUSED"]],                                 // ENVIRONMENT_UNSET
      [{ HOST_REDIRECT: "on", DEPLOYMENT_ENV: "production" }, ["HOST_REDIRECT_SITE_REFUSED", "HOST_REDIRECT_POLICY_REFUSED"]], // no target
      [{ ...ON, SITE_ORIGIN: "" }, ["HOST_REDIRECT_POLICY_REFUSED"]],                                   // a blank SITE_ORIGIN is today's vicinity.city
      [{ ...ON, SITE_ORIGIN: "https://vicinity.city" }, ["HOST_REDIRECT_POLICY_REFUSED"]],              // HOST_REDIRECT_TARGET_NOT_CANONICAL
      [{ ...ON, SITE_ORIGIN: "https://example.test", SITE_ORIGINS: "https://example.test" }, ["HOST_REDIRECT_POLICY_REFUSED"]],
      [{ ...ON, SITE_ORIGINS: "https://citycoin.dev/path" }, ["HOST_REDIRECT_SITE_REFUSED", "HOST_REDIRECT_POLICY_REFUSED"]],
      [{ ...ON, SITE_ORIGINS: "https://vicinity.city" }, ["HOST_REDIRECT_SITE_REFUSED", "HOST_REDIRECT_POLICY_REFUSED"]],      // origin not allowed
      [{ ...ON, LEGACY_LINK: "on" }, ["HOST_REDIRECT_POLICY_REFUSED"]],                                 // any other named error
    ];
    for (const [env, codes] of refused) {
      assert.deepEqual(hostRedirectRefusals(env), codes, JSON.stringify(env));
      assert.equal(hostRedirect(env), false);
    }
  } finally { pagesAsCommitted(); }
});

test("a switch set on but refused says why, once per isolate, as codes only; unset says nothing", () => {
  const lines = [];
  const log = (...a) => lines.push(a.join(" "));
  _resetPolicyCheck();
  checkPolicyConfig({}, { log });
  checkPolicyConfig({ HOST_REDIRECT: "off" }, { log });
  assert.deepEqual(lines, []);
  _resetPolicyCheck();
  checkPolicyConfig(ON, { log }); checkPolicyConfig(ON, { log });
  assert.deepEqual(lines, ["host redirect switch refused HOST_REDIRECT_PAGES_BYPASS_WORKER"]);
  lines.length = 0; _resetPolicyCheck();
  checkPolicyConfig({ HOST_REDIRECT: "on" }, { log });
  assert.ok(lines.includes("policy config refused ENVIRONMENT_UNSET deployment.environment"));
  assert.ok(lines.includes("host redirect switch refused HOST_REDIRECT_SITE_REFUSED"));
  for (const l of lines) assert.doesNotMatch(l, /citycoin\.dev|vicinity\.city|https?:/, "a code and a path, never a value");
  _resetPolicyCheck();
});

/* ---------------------------------------------------------------- switch off: exactly today */

test("switch unset: every host, scheme, method and path class answers as today (301 from the old names and from http, the same answer elsewhere)", async () => {
  const env = world(), ref = world();
  for (const host of [...ACCEPTED_HOSTS, ...UNKNOWN_HOSTS, "VICINITY.CITY", "localhost"]) {
    for (const proto of ["https", "http"]) {
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        for (const [path] of PATHS) {
          const url = `${proto}://${host}${path}`, got = await call(env, url, method);
          const location = todays(url);
          if (location && host !== "localhost") {
            assert.deepEqual(got, redirectTo(301, location), `${method} ${url}`);
          } else {
            // served in place: no answer of the entry (a redirect or a refusal), the route's own answer, as a second world gives it
            assert.ok(got.status !== 308 && got.status !== 421 && !(got.status === 301 && got.body === null), `${method} ${url}`);
            assert.deepEqual(got, await call(ref, url, method), `${method} ${url}`);
          }
        }
      }
    }
  }
});

test("switch set but refused (each reason): every answer, header and D1 row is exactly the switch-off one", async () => {
  const variants = [
    { ...ON },                                                         // as committed: the pages bypass the Worker
    { ...ON, DEPLOYMENT_ENV: "" }, { HOST_REDIRECT: "on" }, { ...ON, SITE_ORIGIN: "https://vicinity.city" },
    { ...ON, SITE_ORIGINS: "nonsense" }, { HOST_REDIRECT: "true", DEPLOYMENT_ENV: "production", SITE_ORIGIN: ON.SITE_ORIGIN, SITE_ORIGINS: ON.SITE_ORIGINS },
  ];
  const urls = [];
  for (const host of ["vicinity.city", "www.vicinity.city", "vicinitycity.net", "citycoin.dev", "www.citycoin.dev", "evil.example"]) {
    for (const proto of ["https", "http"]) for (const [path] of PATHS) urls.push(`${proto}://${host}${path}`);
  }
  for (const v of variants) {
    if (v !== variants[0]) pagesReachWorker(); // every refusal but the first is a refusal of the configuration, not of the page routing
    try {
      const off = world(), on = world(v);
      for (const url of urls) for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
        assert.deepEqual(await call(on, url, method), await call(off, url, method), `${JSON.stringify(v)} ${method} ${url}`);
      }
      const dump = async (env) => { const t = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results;
        return Promise.all(t.map(async ({ name }) => [name, mask(JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results))])); };
      assert.deepEqual(await dump(on), await dump(off), "every D1 row too");
    } finally { pagesAsCommitted(); }
  }
});

/* ---------------------------------------------------------------- switch accepted: the route contract */

/** The rule the switch applies, restated: [kind, location] for a request on an accepted host. */
function contract(url, method, kind) {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  if (secure && u.hostname === "citycoin.dev") return ["serve"];
  if (method !== "GET" && method !== "HEAD") return ["421"];
  if (kind === "immutable" || kind === "read") return secure ? ["serve"] : ["308", `https://${u.hostname}${u.pathname}${u.search}`];
  if (kind === "bound") return ["421"];
  return ["308", `${CANON}${u.pathname}${safeQuery(u.search)}`];
}

test("switch accepted: every accepted host, scheme, method and path class follows the route contract", async () => {
  pagesReachWorker();
  try {
    const env = world(ON), ref = world();
    let n308 = 0, n421 = 0, nServe = 0;
    for (const host of ACCEPTED_HOSTS) for (const proto of ["https", "http"]) for (const method of METHODS) for (const [path, kind] of PATHS) {
      const url = `${proto}://${host}${path}`, label = `${method} ${url}`;
      const [want, location] = contract(url, method, kind);
      const got = await call(env, url, method);
      if (want === "308") {
        n308++;
        assert.deepEqual(got, redirectTo(308, location), label);
        // one hop: the target answers (no loop, no second redirect, never a refusal)
        const next = await call(env, location, method);
        assert.ok(![301, 302, 307, 308, 421].includes(next.status), `${label} -> ${location} answered ${next.status}`);
      } else if (want === "421") {
        n421++;
        assert.equal(got.status, 421, label);
        assert.equal(headerOf(got, "location"), null, `${label}: no Location`);
        assert.equal(headerOf(got, "cache-control"), "no-store");
        assert.equal(headerOf(got, "content-type"), "application/json; charset=utf-8");
        assert.equal(headerOf(got, "content-security-policy"), mask(SECURITY_HEADERS["Content-Security-Policy"]));
        assert.deepEqual(JSON.parse(got.body), { error: "wrong_host" }, label);
      } else {
        nServe++;
        // served in place: the switch-off answer of the same request on a host served in place, byte for byte
        assert.deepEqual(got, await call(ref, reference(url, path), method), label);
      }
    }
    assert.ok(n308 > 100 && n421 > 400 && nServe > 100, `${n308} redirects, ${n421} refusals, ${nServe} in place`);
  } finally { pagesAsCommitted(); }
});

test("switch accepted: unknown hosts are refused for every method and path, never served and never a redirect target", async () => {
  pagesReachWorker();
  try {
    const env = world(ON);
    for (const host of UNKNOWN_HOSTS) for (const proto of ["https", "http"]) for (const method of METHODS) for (const [path] of PATHS) {
      const got = await call(env, `${proto}://${host}${path}`, method);
      assert.equal(got.status, 421, `${method} ${proto}://${host}${path}`);
      assert.equal(headerOf(got, "location"), null);
      assert.deepEqual(JSON.parse(got.body), { error: "wrong_host" });
    }
  } finally { pagesAsCommitted(); }
});

test("switch accepted: the legacy hosts stay accepted even when SITE_ORIGINS leaves them out, and their immutable files keep their bytes", async () => {
  pagesReachWorker();
  try {
    const only = { ...ON, SITE_ORIGINS: "https://citycoin.dev" };
    assert.equal(hostRedirect(only), true);
    const env = world(only), ref = world();
    for (const host of LEGACY_HOSTS) {
      for (const p of ["/brand/vicinity-512.png", `/coin-meta/${MINT}.json`, "/official-coins.csv", "/api/health"]) {
        for (const method of ["GET", "HEAD"]) assert.deepEqual(await call(env, `https://${host}${p}`, method), await call(ref, `https://vicinity.city${p}`, method), `${method} ${host}${p}`);
      }
      const page = await call(env, `https://${host}/launchpad?tab=new`);
      assert.equal(page.status, 308);
      assert.equal(headerOf(page, "location"), `${CANON}/launchpad?tab=new`, "one hop straight to the canonical origin, never via vicinity.city");
    }
    const logo = await call(env, "https://vicinity.city/brand/vicinity-512.png");
    assert.equal(logo.status, 200);
    assert.equal(logo.body, read("public/brand/vicinity-512.png").toString("base64"), "the logo named on chain: the file's exact bytes");
    // www.citycoin.dev is not listed here, and it is no legacy host: refused
    assert.equal((await call(env, "https://www.citycoin.dev/")).status, 421);
  } finally { pagesAsCommitted(); }
});

test("switch accepted: no open redirect; the target is always SITE_ORIGIN with the request's path appended as text", async () => {
  pagesReachWorker();
  try {
    const env = world(ON);
    const tricky = ["//evil.example/x", "/\\evil.example/x", "/%2F%2Fevil.example", "/..//evil.example", "/@evil.example", "/./evil.example",
      "/x?next=https://evil.example&city=1", "/x?city=1#frag", "/%0d%0aSet-Cookie:%20a=b", "/x?city=%0d%0aSet-Cookie:a=b", "/x?mode=login&mode=https://evil.example"];
    for (const host of ["vicinity.city", "www.vicinity.city", "vicinitycity.net", "www.citycoin.dev"]) for (const proto of ["https", "http"]) for (const p of tricky) {
      const res = await worker.fetch(request(`${proto}://${host}${p}`), env, ctx);
      assert.equal(res.status, 308, `${host}${p}`);
      const location = res.headers.get("location");
      assert.ok(location.startsWith(`${CANON}/`), `${host}${p} -> ${location}`);
      assert.equal(new URL(location).origin, CANON);
      assert.equal(new URL(location, "https://other.example/").origin, CANON, "absolute: a browser resolves it to the canonical origin from any base");
      assert.equal(res.headers.get("set-cookie"), null);
      assert.doesNotMatch(location, /[\r\n]/);
    }
    // the last guard: a path that would change the origin once appended (never one a parsed URL gives) is refused, not sent
    for (const pathname of ["@evil.example/x", ".evil.example/x", ":443@evil.example/"]) {
      assert.equal(onOrigin(CANON, { pathname }, ""), null, pathname);
      const fake = { hostname: "vicinity.city", protocol: "https:", pathname, search: "" };
      assert.equal(hostAnswer(new Request("https://vicinity.city/"), fake, siteConfig(ON)).status, 421, pathname);
    }
    assert.equal(onOrigin(CANON, { pathname: "//evil.example/x" }, "?city=1"), `${CANON}//evil.example/x?city=1`);
    // the Host header never moves the target: the request's own URL host decides acceptance, and the target is configuration
    const spoof = await worker.fetch(new Request("https://vicinity.city/a", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } }), env, ctx);
    assert.equal(spoof.headers.get("location"), `${CANON}/a`);
  } finally { pagesAsCommitted(); }
});

test("switch accepted: a moved page keeps only the safe query keys; hand-off, sign-in and one-time-code keys never travel", async () => {
  pagesReachWorker();
  try {
    const env = world(ON);
    const handoff = HANDOFF_QUERY_KEYS.map((k, i) => `${k}=secret${i}`).join("&");
    const res = await worker.fetch(request(`https://vicinity.city/connect?${handoff}&mode=login&utm_source=mail&city=5128581`), env, ctx);
    assert.equal(res.headers.get("location"), `${CANON}/connect?mode=login&utm_source=mail&city=5128581`);
    assert.doesNotMatch(res.headers.get("location"), /secret/);
    const bare = await worker.fetch(request(`https://vicinity.city/connect?link=${"a".repeat(43)}`), env, ctx);
    assert.equal(bare.headers.get("location"), `${CANON}/connect`, "no dangling ?");
  } finally { pagesAsCommitted(); }
});

test("the query filter: exact keys only, each kept pair byte for byte and in order, malformed keys dropped", () => {
  for (const k of HANDOFF_QUERY_KEYS) assert.ok(!SAFE_QUERY_KEYS.includes(k), `${k} is a hand-off key`);
  for (const k of ["link", "pair", "code", "register", "carry", "state", "ref"]) assert.ok(HANDOFF_QUERY_KEYS.includes(k), `inventory C02 names ${k}`);
  assert.equal(safeQuery(""), "");
  assert.equal(safeQuery("?"), "");
  assert.equal(safeQuery("?code=1&state=2"), "");
  assert.equal(safeQuery("?city=1&code=2&city=3"), "?city=1&city=3", "a repeated safe key is kept, in order");
  assert.equal(safeQuery("?q=a%20b+c&tab=new"), "?q=a%20b+c&tab=new", "the encoding is kept as sent");
  assert.equal(safeQuery("?c%69ty=1"), "?c%69ty=1", "an encoded safe key is that key");
  assert.equal(safeQuery("?%63ode=1&Code=2&CITY=3"), "", "an encoded hand-off key is that key; keys are case-sensitive");
  assert.equal(safeQuery("?%zz=1&city=2"), "?city=2", "a malformed key is dropped");
  assert.equal(safeQuery("?&&welcome&city="), "?welcome&city=", "empty pairs dropped, keys without a value kept");
  assert.equal(safeQuery("?swap_in=SOL&swap_out=X&swap_amt=1&swap_slip=50&swap_open=1&utm_campaign=c"), "?swap_in=SOL&swap_out=X&swap_amt=1&swap_slip=50&swap_open=1&utm_campaign=c");
  assert.equal(safeQuery("?unknown=1&city=2"), "?city=2", "unknown keys are dropped, so a later secret key never travels by default");
});

test("the path classes: the immutable files, the origin-bound routes of today's index.js, exact host matching", () => {
  for (const p of ["/coin-meta/x.json", "/coin-meta/art/ab.png", "/brand/vicinity-512.png", "/official-coins.csv"]) assert.ok(isImmutable(p), p);
  for (const p of ["/coin-meta", "/Coin-Meta/x", "/brand/vicinity-512.png/x", "/brand/vicinity-512.PNG", "/official-coins.csv/", "/brand/logo.svg"]) assert.ok(!isImmutable(p), p);
  assert.deepEqual([...IMMUTABLE_PATHS], ["/brand/vicinity-512.png", "/official-coins.csv"]);
  // every /api route literal of src/index.js: exactly these are origin-bound (a new route under these prefixes is refused off-host until reviewed)
  const src = read("src/index.js").toString("utf8");
  const routes = [...new Set([...src.matchAll(/["'](\/api\/[a-z0-9/_-]+)["']/g)].map((m) => m[1]))].sort();
  assert.deepEqual(routes.filter(isOriginBound), ["/api/auth/email/login", "/api/auth/email/start", "/api/auth/email/verify", "/api/auth/logout",
    "/api/auth/password/reset", "/api/auth/password/reset/start", "/api/auth/reprove", "/api/auth/transfer", "/api/auth/transfer/check", "/api/auth/wallet",
    "/api/locate", "/api/locate/handoff", "/api/locate/handoff/claim", "/api/locate/handoff/complete", "/api/locate/handoff/info", "/api/me/wallet/",
    "/api/message", "/api/pair", "/api/pair/finish", "/api/signup/"]);
  for (const p of ["/api/auth/google/start", "/api/auth/google/callback", "/api/signup/location/handoff/info", "/api/me/wallet/carry/status", "/x/callback", "/api/hooks/webhooks/y", "/api/Webhook"]) assert.ok(isOriginBound(p), p);
  for (const p of ["/api/me", "/api/messages", "/api/pairs", "/api/locatex", "/api/token", "/api/wallet/send/status", "/api/callbacking"]) assert.ok(!isOriginBound(p), p);
  const site = siteConfig(ON);
  assert.equal(acceptedHost(site, "www.citycoin.dev"), "www.citycoin.dev");
  assert.equal(acceptedHost(site, "WWW.VICINITY.CITY"), "www.vicinity.city");
  for (const h of ["evil.citycoin.dev", "citycoin.dev.evil.example", "xcitycoin.dev", "vicinity.city.", "", null]) assert.equal(acceptedHost(site, h), null, String(h));
});

test("switch accepted: this computer (wrangler dev) is served as today; a local visit by a route's name follows the host rule", async () => {
  pagesReachWorker();
  try {
    const env = world(ON), site = siteConfig(ON);
    for (const url of ["http://localhost:8787/dashboard", "http://127.0.0.1/api/health", "http://[::1]/", "http://app.localhost/x"]) {
      assert.equal(hostAnswer(new Request(url, { method: "POST" }), new URL(url), site, true), null, url);
    }
    const local = { "cf-connecting-ip": "127.0.0.1" };
    assert.equal((await call(env, "http://citycoin.dev/api/health", "GET", local)).status, 200, "the canonical host, presented as http by wrangler dev");
    const page = await call(env, "http://vicinity.city/rules", "GET", local);
    assert.equal(headerOf(page, "location"), `${CANON}/rules`, "a route's name from this computer: the host rule, not the https upgrade");
    assert.equal((await call(env, "http://vicinity.city/api/health", "GET", local)).status, 200, "read-only API in place (no upgrade from this computer)");
  } finally { pagesAsCommitted(); }
});

/* ---------------------------------------------------------------- members stay signed in; nothing is written */

test("existing members stay signed in: a session made today (no host on its row) answers on vicinity.city with the switch off and on", async () => {
  for (const flip of [false, true]) {
    if (flip) pagesReachWorker();
    try {
      const env = world(flip ? ON : {});
      const p = await member(env);
      const cookie = [...p.jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const sessions = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n;
      const before = await sessions();
      assert.ok(before >= 1);
      const me = await worker.fetch(request("https://vicinity.city/api/me", "GET", { cookie }), env, ctx);
      assert.equal(me.status, 200);
      const body = await me.json();
      assert.equal(body.signedIn, true, `signed in on vicinity.city (switch ${flip ? "on" : "off"})`);
      assert.equal(body.user.wallet, p.w.address);
      if (flip) {
        // a write from an old tab on vicinity.city is refused, never replayed elsewhere, and the session is untouched
        const out = await worker.fetch(request("https://vicinity.city/api/auth/logout", "POST", { cookie }), env, ctx);
        assert.equal(out.status, 421);
        assert.equal(out.headers.get("set-cookie"), null);
        assert.equal(await sessions(), before, "the 421 changed no row");
        // a cookie scoped to vicinity.city never reaches citycoin.dev: there the browser starts signed out, as the master requires
        const fresh = await (await worker.fetch(request("https://citycoin.dev/api/me"), env, ctx)).json();
        assert.equal(fresh.signedIn, false);
        const again = await (await worker.fetch(request("https://vicinity.city/api/me", "GET", { cookie }), env, ctx)).json();
        assert.equal(again.signedIn, true, "still signed in on vicinity.city after the refused write");
      }
    } finally { pagesAsCommitted(); }
  }
});

test("switch accepted: redirects and refusals write nothing (every D1 row before and after a sweep)", async () => {
  pagesReachWorker();
  try {
    const env = world(ON);
    await member(env);
    const dump = async () => { const t = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results;
      return Promise.all(t.map(async ({ name }) => [name, JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results)])); };
    const before = await dump();
    for (const host of ["vicinity.city", "www.vicinity.city", "evil.example"]) for (const method of METHODS) for (const [path, kind] of PATHS) {
      if (kind === "read" || kind === "immutable") continue; // served in place: the same reads as on the canonical host
      await worker.fetch(request(`https://${host}${path}`, method), env, ctx);
    }
    assert.deepEqual(await dump(), before);
  } finally { pagesAsCommitted(); }
});

/* ---------------------------------------------------------------- the deployment: pages must reach the Worker */

test("the committed wrangler.jsonc: no HOST_REDIRECT, the pages bypass the Worker, so the switch does nothing until a configuration PR", () => {
  assert.equal(VARS.HOST_REDIRECT, undefined);
  for (const k of ["SITE_ORIGIN", "SITE_ORIGINS", "DEPLOYMENT_ENV"]) assert.equal(VARS[k], undefined, k);
  assert.deepEqual(WRANGLER.assets.run_worker_first, ["/api/*", "/coin-meta/*", "/official-coins.csv"], "not changed by this stage");
  assert.deepEqual(WRANGLER.routes.map((r) => r.pattern), ["vicinity.city", "www.vicinity.city"], "citycoin.dev is not attached here");
  assert.deepEqual(pageRouting(), { pagesReachWorker: false });
  assert.match(pagesBuiltSource(), /pagesReachWorker: false/);
  assert.deepEqual(deployedAssets(), WRANGLER.assets);
});

test("the page build refuses HOST_REDIRECT=on in wrangler.jsonc unless the pages reach the Worker and the Worker would accept it", () => {
  const vars = { ...deployedVars(), ...ON };
  const listed = WRANGLER.assets, first = { ...WRANGLER.assets, run_worker_first: true };
  assert.throws(() => pageRouting(vars, listed), /HOST_REDIRECT=on in wrangler\.jsonc.*HOST_REDIRECT_PAGES_BYPASS_WORKER/);
  assert.throws(() => pagesBuiltSource(vars, listed), /run_worker_first/);
  assert.throws(() => pageRouting({ ...vars, DEPLOYMENT_ENV: "" }, first), /ENVIRONMENT_UNSET/);
  assert.throws(() => pageRouting({ ...vars, SITE_ORIGIN: "https://vicinity.city" }, first), /HOST_REDIRECT_TARGET_NOT_CANONICAL/);
  assert.deepEqual(pageRouting(vars, first), { pagesReachWorker: true });
  assert.match(pagesBuiltSource(vars, first), /mainTokenV5: false, brand: "", pagesReachWorker: true/);
  assert.deepEqual(pageRouting({ ...deployedVars(), HOST_REDIRECT: "off" }, listed), { pagesReachWorker: false });
  assert.deepEqual(pageRouting(deployedVars(), first), { pagesReachWorker: true }, "run_worker_first alone changes no answer: the switch is off");
});
