// The city list, city coin tickers, and the network check that stops VPNs and far-away spoofing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleApi } from "../src/index.js";
import { _resetCityCache, distanceKm, normName } from "../src/cities.js";
import { networkCheck } from "../src/network.js";
import { founderAmount, founderLevels, POLICY } from "../src/policy.js";

const UTICA = { lat: 43.1, lon: -75.23 };

test("real city list covers every inhabited country", async () => {
  const text = readFileSync(new URL("../public/data/cities.json", import.meta.url), "utf8");
  const data = JSON.parse(text);
  const all = Object.values(data.byCountry).flat();
  assert.ok(all.length > 10_000);
  assert.ok(Object.keys(data.byCountry).length >= 240);
  assert.match(data.source, /GeoNames/);
  for (const n of ["Utica", "Dhaka", "Tokyo", "Lagos", "São Paulo"]) assert.ok(all.some((c) => c[1] === n), n);
  // the server's fast one-country reader gives the same answer as a full parse, for every country
  const { countryCities } = await import("../src/cities.js");
  _resetCityCache();
  const realEnv = { ASSETS: { fetch: async () => new Response(text) } };
  for (const [cc, rows] of Object.entries(data.byCountry)) assert.equal((await countryCities(realEnv, cc)).length, rows.length, cc);
  assert.equal(await countryCities(realEnv, "ZZ"), null);
});

test("helpers: distance and name matching", () => {
  assert.ok(Math.abs(distanceKm(43.1, -75.23, 40.71, -74.01) - 285) < 10);
  assert.equal(normName("São Paulo"), normName("sao paulo"));
});

test("network check: VPNs, Tor, other countries and far-away connections are refused", () => {
  assert.equal(networkCheck({ country: "US", asOrganization: "DigitalOcean, LLC", latitude: "43.1", longitude: "-75.2" }, UTICA, "US").error, "vpn_detected");
  assert.equal(networkCheck({ country: "US", asOrganization: "Mullvad VPN AB" }, UTICA, "US").error, "vpn_detected");
  assert.equal(networkCheck({ country: "T1" }, UTICA, "US").error, "vpn_detected");
  assert.equal(networkCheck({ country: "DE", asOrganization: "Deutsche Telekom AG", latitude: "52.5", longitude: "13.4" }, UTICA, "US").error, "network_mismatch");
  assert.ok(networkCheck({ country: "US", asOrganization: "Comcast Cable", latitude: "34.05", longitude: "-118.24" }, UTICA, "US").networkKm > 3000); // Los Angeles
  // a normal home/mobile connection nearby passes (mobile IPs are often 100-300 km off, so that's allowed)
  assert.equal(networkCheck({ country: "US", asOrganization: "Charter Communications", latitude: "43.05", longitude: "-76.15" }, UTICA, "US"), null);
  assert.equal(networkCheck(undefined, UTICA, "US"), null, "local tests have no network data");
});

test("rules: founder stake ladder is published (100K–1M by city size)", async () => {
  // rule of eight: 8x the people → 2x the stake, floored to 10K rungs, clamped [100K, 1M]
  assert.equal(founderAmount(10_000), 100_000);
  assert.equal(founderAmount(80_000), 200_000);
  assert.equal(founderAmount(640_000), 400_000);
  assert.equal(founderAmount(5_120_000), 800_000);
  assert.equal(founderAmount(8_800_000), 950_000);   // NYC
  assert.equal(founderAmount(61_100), 180_000);     // Utica
  assert.equal(founderAmount(142_000), 240_000);    // Syracuse
  assert.equal(founderAmount(99_000), 210_000);     // Albany
  assert.equal(founderAmount(100_000_000), 1_000_000); // clamped at the top
  const levels = founderLevels();
  assert.equal(levels.length, 100);
  assert.equal(levels[0], 10_000);
  assert.equal(levels[levels.length - 1], 1_000_000);
  assert.ok(levels.every((x, i) => i === 0 || x === levels[i - 1] + 10_000), "every 10K rung");
  const r = await (await handleApi(new Request("https://vicinity.test/api/policy"))).json();
  assert.equal(r.policy.version, POLICY.version);
  assert.equal(r.policy.founder.ladder.base, 100_000);
  assert.equal(r.policy.founder.ladder.max, 1_000_000);
  assert.ok(r.policy.never.length >= 5);
  assert.equal(r.balanceHistory.running, false);
});

test("country manager endpoint: nobody before any election; bad codes refused", async () => {
  const r = await (await handleApi(new Request("https://vicinity.test/api/moderator?country=US"), {})).json();
  assert.equal(r.manager, null);
  assert.match(r.rule, /Elected for 90 days/);
  assert.equal((await handleApi(new Request("https://vicinity.test/api/moderator?country=us"), {})).status, 400);
});

test("city coin tickers are unique for every listed city, and same names are resolved", async () => {
  await import("../public/ticker.js");
  const data = JSON.parse(readFileSync(new URL("../public/data/cities.json", import.meta.url), "utf8"));
  const cities = Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map(([id, name, adm, , , pop]) => ({ id: String(id), name, cc, adm, pop })));
  const t = globalThis.vicinityTicker.assign(cities);
  const all = [...t.values()].map((v) => v.ticker);
  assert.equal(new Set(all).size, cities.length, "no two cities share a ticker");
  assert.ok(all.every((x) => /^[A-Z0-9]{2,10}$/.test(x)), "tickers are 2-10 capital letters/digits");
  const of = (name, cc) => t.get(cities.find((c) => c.name === name && c.cc === cc).id).ticker;
  assert.equal(of("Utica", "US"), "UTICA");
  assert.equal(of("London", "GB"), "LONDON");    // biggest keeps the plain ticker
  assert.equal(of("London", "CA"), "LONDONCA");  // the other adds its country
  assert.equal(of("New York City", "US"), "NYC");
  assert.equal(globalThis.vicinityTicker.baseTicker("Łódź"), "LODZ");
});
