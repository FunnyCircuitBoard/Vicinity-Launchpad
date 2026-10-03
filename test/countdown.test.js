// vicinitycity.com (countdown/): until 3 Oct 2026 3:10 PM New York the countdown site works as it did; from that
// moment on every request is sent to https://vicinity.city/, and an open page goes there by itself when the clock hits zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { _redirect } from "../countdown/src/index.js";

const { at: LAUNCH_AT, to: REDIRECT_TO } = _redirect();

const read = (p) => readFileSync(new URL(`../countdown/${p}`, import.meta.url), "utf8");
const env = (extra = {}) => ({ ASSETS: { fetch: async () => new Response("the countdown page", { status: 200, headers: { "content-type": "text/html" } }) }, ...extra });
async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}

test("the countdown ends at 3:10 PM New York on 3 Oct 2026 (19:10 UTC), the moment the page counts to", () => {
  assert.equal(new Date(LAUNCH_AT).toISOString(), "2026-10-03T19:10:00.000Z");
  assert.match(read("public/teaser.js"), /const LAUNCH = Date\.parse\("2026-10-03T15:10:00-04:00"\)/);
  assert.equal(REDIRECT_TO, "https://vicinity.city/");
});

test("before the end: the page, its files and the forwarding of http and www are exactly as they were", async () => {
  await at(LAUNCH_AT - 1, async () => {
    const page = await worker.fetch(new Request("https://vicinitycity.com/"), env());
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "the countdown page");
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    const www = await worker.fetch(new Request("https://www.vicinitycity.com/teaser.js"), env());
    assert.deepEqual([www.status, www.headers.get("location")], [301, "https://vicinitycity.com/teaser.js"]);
    const api = await worker.fetch(new Request("https://vicinitycity.com/api/nope"), env());
    assert.equal(api.status, 404);
  });
});

test("from the end on: every path, file, API call and host goes to https://vicinity.city/ (302, never cached)", async () => {
  for (const ms of [LAUNCH_AT, LAUNCH_AT + 1, LAUNCH_AT + 86400e3 * 30]) {
    await at(ms, async () => {
      for (const u of ["https://vicinitycity.com/", "https://vicinitycity.com/teaser.js", "https://vicinitycity.com/api/pulse", "http://www.vicinitycity.com/rep?x=1"]) {
        const r = await worker.fetch(new Request(u), env());
        assert.equal(r.status, 302, u);
        assert.equal(r.headers.get("location"), "https://vicinity.city/", u);
        assert.equal(r.headers.get("cache-control"), "no-store", u);
      }
      const post = await worker.fetch(new Request("https://vicinitycity.com/api/answers", { method: "POST", body: "{}" }), env());
      assert.equal(post.status, 302);
    });
  }
});

test("an open countdown page goes to the live site by itself once the clock reaches zero", () => {
  const js = read("public/teaser.js");
  const zero = js.slice(js.indexOf("if (ms === 0 &&"), js.indexOf("const when = new Date(LAUNCH)"));
  assert.match(zero, /location\.replace\("https:\/\/vicinity\.city\/"\)/);
});

test("the Worker module exports only functions (the runtime refuses to start on any other export)", async () => {
  const mod = await import("../countdown/src/index.js");
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default") assert.equal(typeof value.fetch, "function");
    else assert.equal(typeof value, "function", name);
  }
});

test("the deploy settings keep the domain attached (no routes) and run the Worker first on every path", () => {
  const cfg = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(cfg.name, "vicinity-countdown");
  assert.equal(cfg.routes, undefined, "a deploy without routes leaves vicinitycity.com attached as it is");
  assert.equal(cfg.assets.run_worker_first, true, "otherwise the files would be served without the redirect");
  assert.equal(cfg.d1_databases[0].database_id, "3cd376ee-8690-451a-ace5-815ee2858720");
  assert.equal(cfg.keep_vars, true);
});
