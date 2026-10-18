// Launched tickers are pinned (scripts/cities/ticker-pins.json, scripts/cities/tickers.mjs): tickers.json is rebuilt from the whole city
// list, and adding a town could move a ticker that is already on the blockchain. A pinned city keeps its ticker, nobody else is given it,
// and the build fails (nothing is written) when a pin cannot hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PINS_FILE, buildTickers, loadPins, verifyPins } from "../scripts/cities/tickers.mjs";

const plain = (v) => (typeof v === "string" ? v : v[0]);
const list = (rows) => ({ source: "test", countries: { US: "United States" }, admin: {}, byCountry: { US: rows } });
const SPRING_MA = [1, "Springfield", "MA", 42.1, -72.59, 155000];
const SPRING_MO = [2, "Springfield", "MO", 37.2, -93.29, 169000];
const UTICA = [3, "Utica", "NY", 43.1, -75.23, 61100];

test("the committed list holds every committed pin, and the pins file is well formed", () => {
  const file = JSON.parse(readFileSync(PINS_FILE, "utf8"));
  assert.deepEqual(Object.keys(file).sort(), ["about", "pins"]);
  assert.match(file.about, /LAUNCHED city coin's on-chain symbol/);
  for (const [id, t] of Object.entries(loadPins())) assert.ok(/^\d+$/.test(id) && /^[A-Z0-9]{1,10}$/.test(t), `${id} ${t}`);
  const tickers = JSON.parse(readFileSync(new URL("../public/data/tickers.json", import.meta.url), "utf8"));
  assert.equal(verifyPins(tickers, loadPins()), true);
});

test("a pinned ticker never moves when a bigger town with the same name joins the list; without the pin it would (the failure is caught)", () => {
  const pins = { 1: "SPRINGFIEL" };
  const before = buildTickers({ cities: list([SPRING_MA, UTICA]), parts: {}, pins });
  assert.equal(before[1], "SPRINGFIEL");
  // the hazard: the same rules without the pin give the plain ticker to the bigger new town, and the check refuses that list
  const unpinned = buildTickers({ cities: list([SPRING_MA, SPRING_MO, UTICA]), parts: {}, pins: {} });
  assert.equal(plain(unpinned[2]), "SPRINGFIEL");
  assert.notEqual(plain(unpinned[1]), "SPRINGFIEL");
  assert.throws(() => verifyPins(unpinned, pins), /launched ticker moved: city 1 launched as \$SPRINGFIEL/);
  // with the pin: the launched city keeps it, the new town gets another, still all unique
  const after = buildTickers({ cities: list([SPRING_MA, SPRING_MO, UTICA]), parts: {}, pins });
  assert.equal(plain(after[1]), "SPRINGFIEL");
  assert.notEqual(plain(after[2]), "SPRINGFIEL");
  assert.equal(new Set(Object.values(after).map(plain)).size, 3);
  assert.equal(plain(after[3]), "UTICA");
});

test("the build fails when a pin cannot hold: the city left the list or became a part, a malformed pin, two pins on one ticker", () => {
  assert.throws(() => buildTickers({ cities: list([UTICA]), parts: {}, pins: { 1: "SPRINGFIEL" } }), /city 1 is no longer a community/);
  assert.throws(() => buildTickers({ cities: list([SPRING_MA, UTICA]), parts: { 1: 3 }, pins: { 1: "SPRINGFIEL" } }), /city 1 is no longer a community/);
  assert.throws(() => buildTickers({ cities: list([SPRING_MA, UTICA]), parts: {}, pins: { 1: "springfiel" } }), /is not a city id with a ticker/);
  assert.throws(() => buildTickers({ cities: list([SPRING_MA, UTICA]), parts: {}, pins: { 1: "UTICA", 3: "UTICA" } }), /pinned to two cities/);
  // a pin that names another city's natural ticker takes it (it is on chain), and that city gets another
  const t = buildTickers({ cities: list([SPRING_MA, UTICA]), parts: {}, pins: { 1: "UTICA" } });
  assert.deepEqual([plain(t[1]), plain(t[3]) !== "UTICA"], ["UTICA", true]);
});
