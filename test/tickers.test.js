// A city coin's ticker is its identity: one list, built once, used by the map, the dashboard and the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTickers } from "../scripts/cities/tickers.mjs";
import { tickerOf, _resetTickers } from "../src/tickers.js";

const file = JSON.parse(readFileSync(new URL("../public/data/tickers.json", import.meta.url), "utf8"));
const plain = (v) => (typeof v === "string" ? v : v[0]);

test("public/data/tickers.json is up to date (run: npm run tickers)", () => {
  assert.deepEqual(file, buildTickers());
});

test("every community has exactly one ticker, nobody shares one, and the biggest city keeps the plain name", () => {
  const all = Object.values(file).map(plain);
  assert.ok(all.length > 8000);
  assert.equal(new Set(all).size, all.length, "two communities share a ticker");
  assert.ok(all.every((t) => t.length >= 2 && t.length <= 10), "tickers are 2 to 10 characters");
  // London, Ontario and London, England: the bigger one keeps $LONDON
  assert.equal(plain(file["2643743"]), "LONDON", "London (GB) keeps the plain ticker");
  assert.notEqual(plain(file["6058560"]), "LONDON", "London (CA) adds a code");
  assert.deepEqual(file["5128581"], "NYC");
});

test("the server reads the same list", async () => {
  _resetTickers();
  const env = { ASSETS: { fetch: async () => new Response(JSON.stringify({ 1: "ONE", 2: ["LONDONCA", "LONDON", 2] })) } };
  assert.deepEqual(await tickerOf(env, "1"), { ticker: "ONE", base: "ONE", shared: 1 });
  assert.deepEqual(await tickerOf(env, 2), { ticker: "LONDONCA", base: "LONDON", shared: 2 });
  assert.equal(await tickerOf(env, "999"), null);
  _resetTickers();
  assert.equal(await tickerOf({ ASSETS: { fetch: async () => new Response("", { status: 404 }) } }, "1"), null, "no file: null, never a crash");
  _resetTickers();
});
