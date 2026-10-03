// Launchpad v2, browser side: the pure helpers of public/launchpad.js (run in node, no DOM) and checks that the page
// markup, the stylesheet and the script agree with each other and with the backend contract (LAUNCHPAD-SPEC section 3).
// With the switch off nothing here shows: the section stays hidden and the script makes no request beyond today's.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildPages } from "../scripts/pages/build.mjs";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const src = read("launchpad.js");
const html = read("launchpad.html");
const srcHtml = readFileSync(new URL("../scripts/pages/src/launchpad.html", import.meta.url), "utf8");
const css = read("style.css");
const START = "// City coins (switched on with LAUNCHPAD_V2=on)";
assert.ok(src.includes(START), "the city-coins part of launchpad.js starts with its banner");
const part = src.slice(src.indexOf(START)); // the new part; the countdown and the snapshot checker above it are untouched
const before = src.slice(0, src.indexOf(START));

// The countdown and the snapshot checker run as soon as the file loads and expect a page: a stand-in element keeps them
// quiet. The city-coins part sees no `document` and only defines its helpers.
const fakeEl = () => ({ textContent: "", classList: { toggle() {}, add() {}, remove() {} }, style: {}, offsetWidth: 0, addEventListener() {}, dataset: {}, hidden: false, replaceChildren() {} });
const V = { $: () => fakeEl(), $$: () => [], el: () => fakeEl(), official: Promise.resolve({ launchpadV2: true }), opensAt: () => 0, reduced: true, api: async () => ({}), fmt: String, isAddr: () => false };
const win = { V };
vm.runInNewContext(src, { window: win, Intl, URLSearchParams, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {} });
const P = win.VLaunchpad.pure;
const plain = (x) => JSON.parse(JSON.stringify(x)); // the script runs in its own realm: compare plain copies

const DAY = 86_400_000, NOW = Date.parse("2026-10-12T12:00:00Z");
const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const city = (ticker, o = {}) => ({
  kind: "city", status: "live", city: { id: 1, name: ticker, country: "US" }, ticker, name: ticker, pitch: "", color: "gold", logo: null,
  pair: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" }, mint: MINT, launchedAt: ago(1), designedAt: ago(5), founder: null, members: null, market: null, holders: null, links: null, rewardModel: null, ...o,
});
const mk = (volume24hUsd, priceChange24hPct = null, holders = null, extra = {}) => ({ market: { priceUsd: 0.01, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd, priceChange24hPct, pairAddress: null, dex: null, url: null, ...extra }, holders: holders == null ? null : { count: holders, asOf: ago(0) } });

/* ---------- tabs ---------- */
test("tabs: Live = recorded contract, New = live under 7 days, Upcoming = waiting + designed + $VICINITY before its mint, Trending = live", () => {
  assert.deepEqual(plain(P.TABS), ["live", "new", "upcoming", "trending"]);
  assert.equal(P.NEW_DAYS, 7);
  const live = city("A", { launchedAt: ago(1) }), old = city("B", { launchedAt: ago(8) }), edge = city("C", { launchedAt: ago(6.99) });
  const waiting = city("W", { status: "waiting", mint: null, launchedAt: null }), designed = city("D", { status: "designed", mint: null, launchedAt: null });
  const vic = { kind: "vicinity", status: "upcoming", ticker: "VICINITY", name: "Vicinity", city: null, mint: null, launchedAt: null, designedAt: null };
  const all = [live, old, edge, waiting, designed, vic];
  assert.deepEqual(plain(P.counts(all, NOW)), { live: 3, new: 2, upcoming: 3, trending: 3 });
  assert.equal(P.inTab(old, "new", NOW), false, "eight days is not new");
  assert.equal(P.inTab(edge, "new", NOW), true, "just under seven days is");
  assert.equal(P.inTab(city("F", { launchedAt: new Date(NOW + DAY).toISOString() }), "new", NOW), false, "a launch date in the future is not new (a clock problem, not a launch)");
  assert.equal(P.inTab(city("X", { status: "live", launchedAt: "garbage" }), "new", NOW), false);
  assert.equal(P.inTab(city("X", { status: "live", launchedAt: "garbage" }), "live", NOW), true);
  assert.equal(P.inTab(vic, "upcoming", NOW), true); assert.equal(P.inTab(vic, "live", NOW), false);
  assert.equal(P.inTab({ status: "weird" }, "upcoming", NOW), false, "an unknown status shows nowhere");
  assert.equal(P.inTab(live, "nonsense", NOW), false);
  assert.deepEqual(plain(P.counts([], NOW)), { live: 0, new: 0, upcoming: 0, trending: 0 });
  for (const t of P.TABS) assert.match(P.TAB_NOTE[t], /^(Live|New|Upcoming|Trending): /, "every tab is labelled with its rule");
  assert.match(P.TAB_NOTE.new, /less than 7 days/); assert.match(P.TAB_NOTE.trending, /24-hour volume/);
});

test("rowsFor: each tab's own order, and nothing from another tab", () => {
  const a = city("A", mk(100, 1, 10)), b = city("B", { launchedAt: ago(0.5), ...mk(300, -2, 5) }), c = city("C", { launchedAt: ago(10), ...mk(300, 9, 1) });
  const d = city("D", { launchedAt: ago(2), ...mk(null, 50, 999) }), e = city("E", { launchedAt: ago(3), market: null, holders: null });
  const w = city("W", { status: "waiting", mint: null, launchedAt: null, designedAt: ago(1) }), g = city("G", { status: "designed", mint: null, launchedAt: null, designedAt: ago(0.2) });
  const vic = { kind: "vicinity", status: "upcoming", ticker: "VICINITY", name: "Vicinity", city: null, designedAt: null };
  const cards = [e, d, c, b, a, w, g, vic];
  const names = (o) => P.rowsFor(cards, { now: NOW, ...o }).map((x) => x.ticker).join(",");
  assert.equal(names({ tab: "live" }), "B,A,D,E,C", "Live: newest first");
  assert.equal(names({ tab: "new" }), "B,A,D,E", "New: newest first, nothing older than 7 days");
  assert.equal(names({ tab: "upcoming" }), "VICINITY,G,W", "Upcoming: $VICINITY first, then most recently updated");
  assert.equal(names({ tab: "trending" }), "C,B,A,D,E", "Trending: volume desc, then change desc, then holders desc; no data last");
  assert.equal(names({}), "B,A,D,E,C", "Live is the default"); assert.equal(names({ tab: "zzz" }), "B,A,D,E,C", "an unknown tab is Live");
  assert.equal(P.rowsFor(null, { tab: "live" }).length, 0); assert.equal(P.rowsFor([null, undefined, 5], { tab: "live" }).length, 0, "junk in the list is skipped");
  assert.equal(names({ tab: "live", sort: "name" }), "A,B,C,D,E", "a chosen sort replaces the tab's order");
});

test("rowsFor: a live $VICINITY leads the Live tab (it has no recorded launch time) but competes honestly in Trending and in a chosen sort", () => {
  const a = city("A", mk(100, 1, 10)), b = city("B", { launchedAt: ago(0.5), ...mk(300, -2, 5) }), c = city("C", { launchedAt: ago(10), ...mk(300, 9, 1) });
  const vic = { kind: "vicinity", status: "live", ticker: "VICINITY", name: "Vicinity", city: null, mint: MINT, launchedAt: null, designedAt: null, ...mk(200, 3, 50) };
  const names = (o) => P.rowsFor([a, c, vic, b], { now: NOW, ...o }).map((x) => x.ticker).join(",");
  assert.equal(names({ tab: "live" }), "VICINITY,B,A,C", "Live: $VICINITY first, then newest first");
  assert.equal(names({ tab: "new" }), "B,A", "New: never $VICINITY (no recorded launch time)");
  assert.equal(names({ tab: "trending" }), "C,B,VICINITY,A", "Trending: by volume, no pinning");
  assert.equal(names({ tab: "live", sort: "newest" }), "B,A,C,VICINITY", "a chosen sort by newest: no launch time goes last");
  assert.equal(names({ tab: "live", sort: "holders" }), "VICINITY,A,B,C", "a chosen sort by holders: by the numbers");
});

/* ---------- sorts ---------- */
test("sorts: every key descending with unknown values last and ties by ticker; name A-Z", () => {
  // P and Q launched a day ago; R this morning; S nine days ago. Q knows nothing about its market.
  const cards = () => [city("S", { launchedAt: ago(9), ...mk(50, 0, 3) }), city("Q", mk(null, null, null)), city("R", { launchedAt: ago(0.1), market: { ...mk(50, -1).market, marketCapUsd: 10, liquidityUsd: 9 }, holders: { count: 7 } }), city("P", { market: { ...mk(5, 2).market, marketCapUsd: 10, liquidityUsd: 1 }, holders: { count: 1 } })];
  const rows = (o) => P.rowsFor(cards(), { now: NOW, ...o }).map((x) => x.ticker).join(",");
  assert.equal(rows({ sort: "volume" }), "R,S,P,Q", "volume: ties by ticker, unknown last");
  assert.equal(rows({ sort: "mcap" }), "P,R,Q,S", "market cap: ties by ticker; Q and S have none (Q before S by name)");
  assert.equal(rows({ sort: "liquidity" }), "R,P,Q,S");
  assert.equal(rows({ sort: "holders" }), "R,S,P,Q");
  assert.equal(rows({ sort: "newest" }), "R,P,Q,S", "newest: P and Q tie, by ticker");
  assert.equal(rows({ sort: "change" }), "P,S,R,Q", "change: +2, 0, -1, none");
  assert.equal(rows({ sort: "name" }), "P,Q,R,S");
  assert.deepEqual(plain(P.SORTS), ["volume", "mcap", "liquidity", "holders", "newest", "change", "name"]);
  assert.equal(rows({ sort: "nonsense" }), rows({}), "an unknown sort is the tab's order");
  // newest: a launch date beats a design date; both unknown go last
  const n = P.rowsFor([city("K", { launchedAt: "x", designedAt: ago(1) }), city("L", { launchedAt: ago(2) }), city("M", { launchedAt: null, designedAt: null })], { sort: "newest", now: NOW }).map((x) => x.ticker);
  assert.deepEqual(plain(n), ["K", "L", "M"]);
});

/* ---------- search and filters ---------- */
test("search: accents, case and a leading $ do not matter; every word must start a word of the ticker, name, city or country", () => {
  assert.equal(P.norm("  $SÃO Paulo "), "sao paulo"); assert.equal(P.norm(null), ""); assert.equal(P.norm("Ÿ"), "y");
  const sp = city("SAOPAULO", { name: "São Paulo", city: { id: 1, name: "São Paulo", country: "BR" } });
  const names = { BR: "Brazil", US: "United States" };
  for (const q of ["sao", "São", "SAO PA", "$saop", "paulo", "br", "brazil", "braz", "", "   "]) assert.equal(P.matches(sp, q, names), true, q);
  for (const q of ["aulo", "sao x", "united"]) assert.equal(P.matches(sp, q, names), false, q);
  const ny = city("NYC", { name: "New York City", city: { id: 2, name: "New York City", country: "US" } });
  assert.equal(P.matches(ny, "york", names), true, "a later word"); assert.equal(P.matches(ny, "new york", names), true); assert.equal(P.matches(ny, "united", names), true, "the country's name");
  assert.equal(P.matches(ny, "united", null), false, "without the names list only the code matches");
  assert.equal(P.matches(ny, "us", null), true);
  assert.equal(P.matches({ ticker: null, name: undefined, city: null }, "x", names), false, "a card with nothing to search");
  assert.deepEqual(plain(P.searchText(sp, names)), ["saopaulo", "sao paulo", "sao paulo", "br", "brazil"]);
});

test("filters: country and status, where 'designed' also means $VICINITY before its mint", () => {
  const cards = [city("A", { city: { id: 1, name: "A", country: "US" } }), city("B", { city: { id: 2, name: "B", country: "GB" } }), city("W", { status: "waiting", mint: null, city: { id: 3, name: "W", country: "US" } }), city("D", { status: "designed", mint: null, city: { id: 4, name: "D", country: "GB" } }), { kind: "vicinity", status: "upcoming", ticker: "VICINITY", name: "Vicinity", city: null }];
  const t = (o) => P.rowsFor(cards, { now: NOW, ...o }).map((x) => x.ticker).join(",");
  assert.equal(t({ tab: "live", country: "US" }), "A"); assert.equal(t({ tab: "live", country: "XX" }), "");
  assert.equal(t({ tab: "upcoming", status: "waiting" }), "W"); assert.equal(t({ tab: "upcoming", status: "designed" }), "VICINITY,D");
  assert.equal(t({ tab: "upcoming", country: "GB" }), "D", "$VICINITY has no country"); assert.equal(t({ tab: "live", status: "live" }), "A,B");
  assert.equal(t({ tab: "live", status: "designed" }), "", "a status that is not in the tab gives nothing, not an error");
});

/* ---------- numbers ---------- */
test("money: $1.2M / $45.3K / $12.50 / $0.0042 on the card, the full amount in the title; never an exponent", () => {
  assert.equal(P.money(1_234_567), "$1.2M"); assert.equal(P.money(45_312), "$45.3K"); assert.equal(P.money(1000), "$1K"); assert.equal(P.money(999.4), "$999.40");
  assert.equal(P.money(12.5), "$12.50"); assert.equal(P.money(1), "$1.00"); assert.equal(P.money(0.0042), "$0.0042"); assert.equal(P.money(0.00042), "$0.00042");
  assert.equal(P.money(0.000000123456), "$0.000000123"); assert.equal(P.money(0.5), "$0.50"); assert.equal(P.money(0.123456), "$0.123"); assert.equal(P.money(0), "$0");
  assert.equal(P.money(-3.2), "-$3.20"); assert.equal(P.money(310_250.5), "$310.3K"); assert.equal(P.money(2_500_000_000), "$2.5B");
  for (const bad of [null, undefined, NaN, Infinity, "12", "", {}]) assert.equal(P.money(bad), null, String(bad));
  assert.equal(P.fullMoney(1_234_567.891), "$1,234,567.89"); assert.equal(P.fullMoney(310_250.5), "$310,250.50"); assert.equal(P.fullMoney(0.0042), "$0.0042");
  assert.equal(P.fullMoney(0.000000123456), "$0.000000123456"); assert.equal(P.fullMoney(0.5), "$0.50"); assert.equal(P.fullMoney(0), "$0.00"); assert.equal(P.fullMoney(null), null);
  assert.doesNotMatch(P.money(1e-9), /e/); assert.doesNotMatch(P.fullMoney(1e-9), /e/);
});
test("count: 45.3K / 1.2M on the card, 45,312 in the title; a 24-hour change is always signed", () => {
  assert.equal(P.count(45_312), "45.3K"); assert.equal(P.count(1_204_560), "1.2M"); assert.equal(P.count(88), "88"); assert.equal(P.count(999), "999"); assert.equal(P.count(0), "0"); assert.equal(P.count(null), null); assert.equal(P.count("5"), null);
  assert.equal(P.fullCount(45_312), "45,312"); assert.equal(P.fullCount(1_204_560), "1,204,560"); assert.equal(P.fullCount(null), null);
  assert.equal(P.pct(12.34), "+12.3%"); assert.equal(P.pct(-4.06), "-4.1%"); assert.equal(P.pct(0), "0.0%"); assert.equal(P.pct(null), null); assert.equal(P.pct(NaN), null);
});

test("community line: singular and plural, the full numbers in the title, nothing without a member count", () => {
  assert.deepEqual(plain(P.communityText({ members: 1, holders: 0 })), { short: "1 member · 0 hold $VICINITY", full: "1 member, 0 of them hold $VICINITY" });
  assert.deepEqual(plain(P.communityText({ members: 1, holders: 1 })), { short: "1 member · 1 holds $VICINITY", full: "1 member, 1 who holds $VICINITY" });
  assert.deepEqual(plain(P.communityText({ members: 4821, holders: 912 })), { short: "4.8K members · 912 hold $VICINITY", full: "4,821 members, 912 of them hold $VICINITY" });
  assert.deepEqual(plain(P.communityText({ members: 3, holders: null })), { short: "3 members", full: "3 members" }, "no holder count: members only");
  assert.equal(P.communityText(null), null); assert.equal(P.communityText({ members: null, holders: 2 }), null); assert.equal(P.communityText({ members: "3" }), null);
});

/* ---------- time ---------- */
test("countdown text: days and hours, then hours and minutes, then minutes and seconds; 'Launching' once passed (never 'Live' without a mint)", () => {
  assert.equal(P.countdownText(3 * DAY + 2 * 3600_000 + 5 * 60_000), "Opens in 3d 02h");
  assert.equal(P.countdownText(2 * 3600_000 + 5 * 60_000 + 9000), "Opens in 2h 05m");
  assert.equal(P.countdownText(45 * 60_000 + 7000), "Opens in 45m 07s"); assert.equal(P.countdownText(999), "Opens in 0m 00s");
  assert.equal(P.countdownText(0), "Launching"); assert.equal(P.countdownText(-5), "Launching"); assert.equal(P.countdownText(NaN), "Launching");
  assert.deepEqual(plain(P.statusLabel({ status: "upcoming", opensAt: new Date(NOW - 1000).toISOString() }, { now: NOW })), ["Launching", "tag--gold"]);
});
test("'Updated N s ago': since the answer arrived plus what the server's cache had already aged; a wrong clock cannot inflate it", () => {
  const t = 1_800_000_000_000, asOf = (agoMs) => new Date(t - agoMs).toISOString();
  assert.equal(P.ageSeconds({ asOf: asOf(4000), receivedAt: t, now: t }), 4);
  assert.equal(P.ageSeconds({ asOf: asOf(4000), receivedAt: t, now: t + 26_000 }), 30);
  assert.equal(P.ageSeconds({ asOf: "no", receivedAt: t, now: t + 7000 }), 7);
  assert.equal(P.ageSeconds({ asOf: asOf(-DAY), receivedAt: t, now: t + 2000 }), 2, "server a day ahead: ignored");
  assert.equal(P.ageSeconds({ asOf: asOf(DAY), receivedAt: t, now: t + 2000 }), 2, "server a day behind: ignored");
  assert.equal(P.ageSeconds({ asOf: asOf(0), receivedAt: t, now: t - 9000 }), 0, "never negative");
  assert.equal(P.agoText(0), "Updated just now"); assert.equal(P.agoText(4), "Updated just now"); assert.equal(P.agoText(5), "Updated 5 s ago"); assert.equal(P.agoText(59), "Updated 59 s ago");
  assert.equal(P.agoText(60), "Updated 1 min ago"); assert.equal(P.agoText(3599), "Updated 59 min ago"); assert.equal(P.agoText(3600), "Updated 1 h ago"); assert.equal(P.agoText(-1), "");
});

/* ---------- words on a card ---------- */
test("status tag: Live / Contract being checked / Designed, and the countdown on $VICINITY before its mint", () => {
  assert.deepEqual(plain(P.statusLabel({ status: "live" })), ["Live", "tag--ok"]);
  assert.deepEqual(plain(P.statusLabel({ status: "waiting" })), ["Contract being checked", "tag--warn"]);
  assert.deepEqual(plain(P.statusLabel({ status: "designed" })), ["Designed", ""]);
  assert.deepEqual(plain(P.statusLabel({ status: "nonsense" })), ["Designed", ""], "never 'Live' without a recorded mint");
  assert.deepEqual(plain(P.statusLabel({ status: "upcoming", opensAt: new Date(NOW + 3 * DAY + 2 * 3600_000).toISOString() }, { now: NOW })), ["Opens in 3d 02h", "tag--gold"]);
  assert.deepEqual(plain(P.statusLabel({ status: "upcoming" }, { now: NOW, opensAt: NOW + 3600_000 })), ["Opens in 1h 00m", "tag--gold"], "the site's own opening time as fallback");
  assert.deepEqual(plain(P.statusLabel({ status: "upcoming" }, { now: NOW })), ["Opens soon", "tag--gold"]);
  assert.equal(P.notLiveWhy({ status: "waiting" }), "Trades once an admin records the contract.");
  assert.equal(P.notLiveWhy({ status: "designed" }), "Trades once the founder launches it on Raydium LaunchLab.");
  assert.equal(P.notLiveWhy({ kind: "vicinity", status: "upcoming" }), "Trades once $VICINITY launches on Raydium LaunchLab.");
});
test("founder line: the handle or the masked wallet, the role, never a full address", () => {
  assert.equal(P.founderText({ handle: "UticaMayor", wallet: null, status: "active" }), "Founder ✓ @UticaMayor");
  assert.equal(P.founderText({ handle: "@Twice", wallet: null, status: "active" }), "Founder ✓ @Twice", "one @");
  assert.equal(P.founderText({ handle: null, wallet: "AbCde*****yz1", status: "steward" }), "Seed Steward ✓ AbCde*****yz1");
  assert.equal(P.founderText({ handle: null, wallet: "AbCde*****yz1", status: "provisional" }), "Founder (provisional) ✓ AbCde*****yz1");
  assert.equal(P.founderText({ handle: null, wallet: MINT, status: "active" }), `Founder ✓ ${MINT.slice(0, 5)}*****${MINT.slice(-3)}`, "a full address slipping through is masked here with the dashboard's rule");
  assert.equal(P.founderText(null), "No founder yet"); assert.equal(P.founderText({ handle: null, wallet: null }), "No founder yet"); assert.equal(P.founderText({}), "No founder yet");
  assert.equal(P.pairText({ ticker: "NYC", pair: { symbol: "USDC", mint: "x" } }), "Pair: $NYC / USDC");
  assert.equal(P.pairText({ kind: "vicinity", ticker: "VICINITY", pair: null }), "Pair: $VICINITY / SOL");
  assert.equal(P.pairText({ ticker: "A", pair: null }), "Pair: chosen by the founder");
});

/* ---------- links ---------- */
test("links: the dashboard's and token page's templates, only for a real mint, only to the four sites", () => {
  const SOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const l = P.links({ mint: MINT, pair: { symbol: "SOL", mint: SOL } });
  assert.deepEqual(plain(l), { raydium: `https://raydium.io/launchpad/token/?mint=${MINT}`, jupiter: `https://jup.ag/swap/SOL-${MINT}`, dexscreener: `https://dexscreener.com/solana/${MINT}`, solscan: `https://solscan.io/token/${MINT}` });
  assert.equal(P.links({ mint: MINT, pair: { symbol: "USDC", mint: USDC } }).jupiter, `https://jup.ag/swap/${USDC}-${MINT}`, "the designed pair is the Jupiter input");
  assert.equal(P.links({ mint: MINT, pair: { symbol: "RAY", mint: "not-an-address" } }).jupiter, `https://jup.ag/swap/SOL-${MINT}`, "a bad pair mint falls back to SOL");
  assert.equal(P.links({ mint: null }), null); assert.equal(P.links({ mint: "short" }), null); assert.equal(P.links(null), null);
  const given = { raydium: `https://raydium.io/launchpad/token/?mint=${MINT}&x=1`, jupiter: "https://evil.example/jup.ag/", dexscreener: `javascript:alert(1)`, solscan: `https://solscan.io/token/${MINT}" onclick="x` };
  const s = P.links({ mint: MINT, pair: null, links: given });
  assert.equal(s.raydium, given.raydium, "a server link on the right site is used");
  assert.equal(s.jupiter, `https://jup.ag/swap/SOL-${MINT}`, "another site: the template instead");
  assert.equal(s.dexscreener, `https://dexscreener.com/solana/${MINT}`); assert.equal(s.solscan, `https://solscan.io/token/${MINT}`, "a quote in it: the template instead");
  assert.equal(P.viewHref({ kind: "vicinity" }), "/token"); assert.equal(P.viewHref({ kind: "city", city: { id: 5142056 } }), "/cities?city=5142056");
  assert.equal(P.viewHref({ kind: "city", city: { id: "a b" } }), "/cities", "an odd id never goes into an address"); assert.equal(P.viewHref({ kind: "city", city: null }), "/cities");
  assert.equal(P.logoSrc({ logo: "/api/media/7" }), "/api/media/7"); assert.equal(P.logoSrc({ logo: "https://x/y.png" }), null); assert.equal(P.logoSrc({ logo: "/api/media/../me" }), null); assert.equal(P.logoSrc({}), null);
  assert.equal(P.colorOf({ color: "ocean" }), "ocean"); assert.equal(P.colorOf({ color: "red" }), "gold"); assert.equal(P.colorOf(null), "gold");
  assert.equal(P.cardKey({ kind: "city", city: { id: 5 }, ticker: "A" }), "city:5"); assert.equal(P.cardKey({ kind: "vicinity", ticker: "VICINITY" }), "vicinity:VICINITY");
});

/* ---------- the address bar ---------- */
test("the address keeps the tab and the search: /launchpad?tab=trending&q=utica, nothing when they are the defaults", () => {
  assert.deepEqual(plain(P.stateFromUrl("?tab=trending&q=utica")), { tab: "trending", q: "utica" });
  assert.deepEqual(plain(P.stateFromUrl("?tab=TRENDING")), { tab: "trending", q: "" });
  assert.deepEqual(plain(P.stateFromUrl("?tab=nope&q=" + "x".repeat(100))), { tab: "live", q: "x".repeat(60) });
  assert.deepEqual(plain(P.stateFromUrl("")), { tab: "live", q: "" }); assert.deepEqual(plain(P.stateFromUrl(null)), { tab: "live", q: "" });
  assert.equal(P.urlFor({ tab: "trending", q: "utica" }), "/launchpad?tab=trending&q=utica");
  assert.equal(P.urlFor({ tab: "live", q: "" }), "/launchpad"); assert.equal(P.urlFor({ tab: "live", q: "   " }), "/launchpad"); assert.equal(P.urlFor({}), "/launchpad");
  assert.equal(P.urlFor({ tab: "new", q: "são paulo" }), "/launchpad?tab=new&q=s%C3%A3o+paulo"); assert.equal(P.urlFor({ tab: "zzz", q: "a" }), "/launchpad?q=a");
  assert.equal(P.urlFor({ q: "x".repeat(80) }), "/launchpad?q=" + "x".repeat(60));
});

/* ---------- page and script agree ---------- */
test("the built page: every id the script uses exists, the section starts hidden, tabs and panel are marked up for assistive tech", () => {
  assert.equal(new Map(buildPages()).get("launchpad.html"), html, "public/launchpad.html is built from scripts/pages/src (npm run pages)");
  const ids = [...new Set([...part.matchAll(/#(lp-[a-z-]+)/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 12, "the script addresses the section by ids: " + ids.length);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `page is missing #${id}`);
  assert.match(html, /<section class="section lp-coins" id="lp-coins" hidden>/, "hidden until the switch is on");
  const sec = html.slice(html.indexOf('id="lp-coins"'), html.indexOf("How it will work"));
  assert.ok(sec.includes('role="tablist"') && sec.includes('aria-label="City coin lists"'));
  for (const t of P.TABS) assert.match(sec, new RegExp(`<button type="button" role="tab" id="lp-tab-${t}" data-tab="${t}" aria-selected="${t === "live"}" aria-controls="lp-panel"${t === "live" ? "" : ' tabindex="-1"'}>`), t);
  assert.equal((sec.match(/role="tab"/g) || []).length, 4);
  assert.match(sec, /<div id="lp-panel" role="tabpanel" aria-labelledby="lp-tab-live">/);
  assert.match(sec, /<ul class="lp-grid" id="lp-grid" aria-label="City coins"><\/ul>/, "cards are a list");
  assert.match(sec, /<label class="sr-only" for="lp-q">Search city coins/); assert.match(sec, /<form class="lp-search" id="lp-search" role="search" novalidate>/);
  assert.match(sec, /<input id="lp-q" type="search" autocomplete="off" spellcheck="false" maxlength="60"/);
  for (const k of ["country", "status", "sort"]) assert.match(sec, new RegExp(`<label class="lp-field"><span>[A-Z][a-z]+</span><select id="lp-${k}">`), k);
  const options = (id) => sec.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))[1].match(/value="([a-z]*)"/g).map((v) => v.slice(7, -1));
  assert.deepEqual(options("lp-sort"), ["", ...P.SORTS], "the sort options are the script's sorts");
  assert.deepEqual(options("lp-status"), ["", "live", "waiting", "designed"]);
  assert.match(sec, /<option value="waiting">Contract being checked<\/option>/);
  assert.match(sec, /<span id="lp-count" role="status" aria-live="polite">/);
  assert.match(sec, /<button class="btn btn--glass btn--sm" type="button" id="lp-retry" hidden>Try again<\/button>/);
  assert.match(sec, /Prices, liquidity and volumes come from DexScreener and can be up to a minute old\. You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds\./);
  assert.doesNotMatch(sec, /\sstyle="|<style|\son[a-z]+="|<script/);
  assert.ok(html.indexOf('id="lp-coins"') > html.indexOf('id="lp-cal"') && html.indexOf('id="lp-coins"') < html.indexOf("How it will work"), "between the hero and the phases");
});

test("with the switch off the page is today's: every pinned id and the pre-launch copy are untouched; the section is the only addition", () => {
  for (const id of ["launchpad", "countdown", "lp-date", "lp-bar", "lp-local", "lp-cal", "supporters", "snap-status", "snap-form", "snap-input", "snap-result"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<p class="kicker">Vicinity Launchpad · coming next<\/p>/);
  assert.match(html, /<a class="btn btn--primary btn--lg" href="\/connect">Get ready: connect &amp; claim →<\/a>/);
  assert.match(html, /Opening <strong id="lp-date">October 10, 2026 · 10:10:10 AM New York time<\/strong>\./);
  assert.match(html, /<p class="kicker">How it will work<\/p>/); assert.match(html, /Planned order\. The exact times are announced here before launch\./);
  assert.match(html, /Sample tickers\. Nothing is minted yet\./);
  assert.equal((srcHtml.match(/<section/g) || []).length, 6, "one section was added to the five");
  const hiddenOnes = [...srcHtml.matchAll(/<[a-z]+ [^>]*?id="([a-z-]+)"[^>]*?\shidden(?=\s|>)/g)].map((m) => m[1]);
  assert.deepEqual(hiddenOnes, ["lp-coins", "lp-empty", "lp-retry"], "the section, the empty card and the retry button start hidden; nothing else gained the attribute");
  assert.deepEqual([...html.matchAll(/<script src="\/([a-z/-]+)\.js"/g)].map((m) => m[1]), ["theme", "site", "launchpad"], "no new script file: nothing extra is requested");
  // the script: the old parts come first and are intact, the new part asks /api/official (already fetched by site.js) and nothing else until the switch says on
  assert.ok(before.startsWith("// Launchpad page: live countdown to the opening, and an \"add to my calendar\" file.\n"));
  assert.ok(before.includes("official.then(tick); tick(); setInterval(tick, 1000);") && before.includes("// Founding Supporter snapshot: status, and any wallet's amount + Merkle proof."));
  assert.match(part, /official\.then\(\(o\) => \{ if \(o && o\.launchpadV2 === true\) start\(\); \}\);\s*\}\)\(\);\s*$/, "the only way in is launchpadV2 === true");
  assert.match(part, /if \(typeof document === "undefined" \|\| !window\.V\) return;/);
  assert.deepEqual([...part.matchAll(/\bapi\(([^)]*)\)/g)].map((m) => m[1]), ['"/api/launchpad"'], "the one request, nothing else");
  assert.doesNotMatch(part, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon/);
  assert.match(part, /sec\.hidden = false;/); assert.equal((part.match(/\.hidden = false/g) || []).length, 2, "only the section and the retry button are ever shown by the script");
  assert.match(part, /const REFRESH_MS = 30000, BACKOFF = \[30000, 60000, 120000, 300000\];/, "30 s refresh, slower after a failure");
  assert.match(part, /document\.visibilityState === "hidden"\) return;/, "no refresh while the page is not looked at");
});

test("the strict security policy holds in the new part: no markup from text, no style attributes, no logging, only our API and the four trading sites", () => {
  assert.doesNotMatch(part, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\.|cssText|setAttribute\(["']style/);
  assert.doesNotMatch(part, /console\.|localStorage|sessionStorage|document\.cookie|indexedDB/);
  const hosts = [...new Set([...part.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(hosts, ["dexscreener.com", "jup.ag", "raydium.io", "solscan.io"], "no other website is named");
  assert.match(part, /target = "_blank"; a\.rel = "noopener";/, "outside links open in a new tab without handing over the window");
  assert.match(part, /img\.src = logo; img\.alt = "";/); assert.match(part, /\/\^\\\/api\\\/media\\\/\[A-Za-z0-9_-\]\{1,64\}\$\//, "a logo only from our own media route");
  assert.match(part, /\.textContent = /); assert.ok(!/\$\{[^}]*\}<\//.test(part), "no HTML strings built from values");
  assert.match(part, /const na = \(\) => \{ const s = el\("span", "lp-na"\); s\.title = "No data yet";/, "a dash with a title where a value is unknown");
  assert.match(part, /el\("span", "sr-only", "No data yet"\)/, "and words for a screen reader");
  assert.match(part, /\["Live", "tag--ok"\]/); assert.doesNotMatch(part, /"● Live"/);
});

test("styles: one block, every control 44 px or taller, nothing moves by itself, both themes", () => {
  const i = css.indexOf("Launchpad city coins (LAUNCHPAD_V2=on)"); assert.ok(i > 0, "the block exists");
  const block = css.slice(i);
  assert.ok(block.length > 2000 && block.length < 9000, "a block, not a stylesheet: " + block.length);
  assert.match(block, /\.lp-tabs button \{[^}]*min-height: 44px/); assert.match(block, /\.lp-search input \{[^}]*min-height: 48px/);
  assert.match(block, /\.lp-field select \{[^}]*min-height: 44px/); assert.match(block, /\.lp-card__actions \.btn \{ min-height: 44px; \}/);
  assert.match(block, /\.lp-card__alt \{ min-height: 44px;/); assert.match(block, /\.lp-empty \.btn \{ min-height: 44px; \}/);
  assert.doesNotMatch(block, /@keyframes|animation\s*:|transition\s*:/, "nothing moves by itself");
  assert.match(block, /\.lp-tabs button:focus-visible \{ outline: 2px solid var\(--pin-2\)/, "a visible focus ring on the tabs");
  assert.match(block, /:root\[data-theme="light"\] \.lp-tabs__n/, "a light-theme touch");
  assert.match(block, /\.lp-grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 300px\), 1fr\)\)/, "cards never force a horizontal scroll");
  assert.match(block, /@media \(max-width: 600px\) \{[\s\S]*\.lp-stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/, "two stat columns on phones");
  assert.match(block, /\.lp-card__disc\[data-color\] \{ background: radial-gradient\(circle at 32% 28%, var\(--c1\), var\(--c2\) 45%, var\(--c3\) 100%\); \}/, "the six coin colours of the dashboard");
  assert.equal((css.match(/Launchpad city coins \(LAUNCHPAD_V2=on\)/g) || []).length, 1);
});
