import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApi, handleVerify } from "../src/index.js";
import { base58Encode, buildMessage, parseMessage } from "../src/solana.js";

const HOST = "vicinity.test";
const req = (path, init = {}) => new Request(`https://${HOST}${path}`, init);

async function newWallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (text) =>
    Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}
const postVerify = (body) =>
  handleVerify(req("/api/verify", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

test("health endpoint returns ok with security headers", async () => {
  const res = await handleApi(req("/api/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "vicinity-map", milestone: 2 });
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("wrong method is rejected; unknown route is 404", async () => {
  assert.equal((await handleApi(req("/api/health", { method: "POST" }))).status, 405);
  assert.equal((await handleApi(req("/api/verify"))).status, 405);
  assert.equal((await handleApi(req("/api/nope"))).status, 404);
});

test("official list says no token and no socials yet", async () => {
  const data = await (await handleApi(req("/api/official"))).json();
  assert.equal(data.tokenContract, null);
  assert.deepEqual(data.socials, []);
});

test("link checker: official site, official GitHub, fakes", async () => {
  const check = async (q) => (await (await handleApi(req("/api/check?q=" + encodeURIComponent(q)))).json()).verdict;
  assert.equal(await check("https://vicinity-map.noyonsakibul.workers.dev/"), "official");
  assert.equal(await check("https://vicinity-map.sakibul-noyon.workers.dev/"), "official");
  assert.equal(await check("https://vicinitycity.net"), "official");
  assert.equal(await check("https://vicinity.city/launchpad"), "official");
  assert.equal(await check("vicinity.city.evil.io"), "not_official");
  assert.equal(await check("www.vicinitycity.net/whatever"), "official");
  assert.equal(await check("vicinitycity.net.evil.io"), "not_official");
  assert.equal(await check("https://github.com/someone/vicinity-map"), "not_official");
  assert.equal(await check("vicinity-airdrop.xyz"), "not_official");
  assert.equal(await check("@vicinity_official"), "not_official");
  assert.equal(await check("So11111111111111111111111111111111111111112"), "not_official");
  assert.equal(await check("http://vicinity-map.noyonsakibul.workers.dev"), "warning");
  assert.equal(await check(""), "empty");
});

test("message endpoint builds a parseable message for this site", async () => {
  const { address } = await newWallet();
  const { message } = await (await handleApi(req("/api/message?address=" + address))).json();
  const parsed = parseMessage(message);
  assert.equal(parsed.host, HOST);
  assert.equal(parsed.address, address);
  assert.equal((await handleApi(req("/api/message?address=nope"))).status, 400);
});

test("verify: a real signature from the right wallet passes", async () => {
  const w = await newWallet();
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: new Date().toISOString() });
  const res = await postVerify({ address: w.address, message, signature: await w.sign(message) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).verified, true);
});

test("verify: someone else's signature fails", async () => {
  const w = await newWallet(), attacker = await newWallet();
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: new Date().toISOString() });
  const res = await postVerify({ address: w.address, message, signature: await attacker.sign(message) });
  assert.equal(res.status, 401);
});

test("verify: tampered, expired, or other-site messages fail", async () => {
  const w = await newWallet();
  const fresh = new Date().toISOString();
  const good = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: fresh });
  const sig = await w.sign(good);
  assert.equal((await postVerify({ address: w.address, message: good.replace("Vicinity", "Vicinlty"), signature: sig })).status, 400);

  const old = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: new Date(Date.now() - 11 * 60e3).toISOString() });
  assert.equal((await (await postVerify({ address: w.address, message: old, signature: await w.sign(old) })).json()).error, "expired");

  const other = buildMessage({ host: "evil.example", address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: fresh });
  assert.equal((await (await postVerify({ address: w.address, message: other, signature: await w.sign(other) })).json()).error, "wrong_site");
});

test("verify: junk input is rejected safely", async () => {
  assert.equal((await handleVerify(req("/api/verify", { method: "POST", body: "{not json" }))).status, 400);
  assert.equal((await postVerify({ address: "x", message: "y", signature: "z" })).status, 400);
  assert.equal((await handleVerify(req("/api/verify", { method: "POST", body: "x".repeat(5000) }))).status, 413);
});

test("non-API requests go to static assets with security headers", async () => {
  const env = { ASSETS: { fetch: async () => new Response("<h1>hi</h1>", { headers: { "Content-Type": "text/html" } }) } };
  const res = await worker.fetch(req("/"), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>hi</h1>");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});

test("crashes become a safe 500 without leaking details", async () => {
  const env = { ASSETS: { fetch: async () => { throw new Error("secret detail"); } } };
  const orig = console.error; console.error = () => {};
  const res = await worker.fetch(req("/"), env);
  console.error = orig;
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal_error" });
});

test("the Worker entry file only exports functions (Cloudflare refuses to start otherwise)", async () => {
  const mod = await import("../src/index.js");
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default") assert.equal(typeof value.fetch, "function");
    else assert.equal(typeof value, "function", `export "${name}" must be a function`);
  }
});

test("old and www addresses forward to vicinity.city, keeping the path", async () => {
  for (const host of ["vicinitycity.net", "www.vicinitycity.net", "www.vicinity.city"]) {
    const res = await worker.fetch(new Request(`https://${host}/cities?city=5142056`), {});
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "https://vicinity.city/cities?city=5142056");
  }
  const own = await worker.fetch(new Request("https://vicinity.city/api/health"), {});
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("strict-transport-security"), "max-age=31536000");
});

test("http:// visits go to https://, except on this computer", async () => {
  const cases = [
    ["http://vicinity.city/rules?x=1", "https://vicinity.city/rules?x=1"],
    ["http://www.vicinity.city/", "https://vicinity.city/"],
    ["http://vicinitycity.net/cities", "https://vicinity.city/cities"],
    ["http://vicinity-map.sakibul-noyon.workers.dev/api/health", "https://vicinity-map.sakibul-noyon.workers.dev/api/health"],
  ];
  for (const [from, to] of cases) {
    const res = await worker.fetch(new Request(from), {});
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get("location"), to);
  }
  for (const local of ["http://localhost:8787/api/health", "http://127.0.0.1:8787/api/health"]) {
    assert.equal((await worker.fetch(new Request(local), {})).status, 200, local);
  }
  // how `wrangler dev` presents a local visit
  const dev = new Request("http://vicinity.city/api/health", { headers: { "cf-connecting-ip": "127.0.0.1" } });
  assert.equal((await worker.fetch(dev, {})).status, 200);
});
