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
  // the line under the list names the real sources (DEX Screener lists nothing while a coin is on its curve); the script swaps in the
  // answer's own attribution, Jupiter's "Powered by Jupiter" included
  assert.match(sec, /<p class="tiny muted lp-honesty" id="lp-honesty">Every number says where it comes from: prices, market caps and 24 h volumes from Jupiter \(Powered by Jupiter\), each bonding curve read from the Solana chain, holders counted by vicinity\.city\. They refresh every 30 seconds\. You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds\.<\/p>/);
  assert.doesNotMatch(sec, /DexScreener|DEX Screener/, "no claim about a site that lists nothing for a coin on its curve");
  assert.match(sec, /<ul class="lp-featured" id="lp-featured" aria-label="Live now: the Vicinity token"><\/ul>/, "the featured strip: an empty list until the script fills it");
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
  assert.deepEqual([...part.matchAll(/\bapi\(([^)]*)\)/g)].map((m) => m[1]).sort(), ['"/api/launchpad"', "`/api/coin/chart?mint=${encodeURIComponent(mint", "`/api/coin/chart?mint=${encodeURIComponent(mint"],
    "the list, and each live coin's chart (its sparkline, 24 h then 7 d): nothing else");
  assert.match(part, /api\(`\/api\/coin\/chart\?mint=\$\{encodeURIComponent\(mint\)\}&tf=24h`\)/); assert.match(part, /api\(`\/api\/coin\/chart\?mint=\$\{encodeURIComponent\(mint\)\}&tf=7d`\)/);
  assert.match(part, /if \(!isAddr\(mint\) \|\| asking\.has\(mint\)\) return;/, "only a real address is ever asked about, once at a time");
  assert.match(part, /SPARK_MS = 300000/, "a sparkline is asked again at most every 5 minutes");
  assert.match(part, /new IntersectionObserver\(\(es\) => \{ for \(const e of es\) if \(e\.isIntersecting\) \{ sparkIO\.unobserve\(e\.target\); fetchSpark\(e\.target\.dataset\.mint\); \} \}, \{ rootMargin: "200px 0px" \}\)/, "and only once its card is near the screen");
  assert.doesNotMatch(part, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon/);
  assert.match(part, /sec\.hidden = false;/); assert.equal((part.match(/\.hidden = false/g) || []).length, 2, "only the section and the retry button are ever shown by the script");
  assert.match(part, /const REFRESH_MS = 30000, BACKOFF = \[30000, 60000, 120000, 300000\];/, "30 s refresh, slower after a failure");
  assert.match(part, /document\.visibilityState === "hidden"\) return;/, "no refresh while the page is not looked at");
});

test("the strict security policy holds in the new part: no markup from text, no style attributes, no logging, only our API and the four trading sites", () => {
  assert.doesNotMatch(part, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\.|cssText|setAttribute\(["']style/);
  assert.doesNotMatch(part, /console\.|localStorage|sessionStorage|document\.cookie|indexedDB/);
  // (the SVG namespace of the sparklines is a name, never a request: it is left out)
  const hosts = [...new Set([...part.replace(/"http:\/\/www\.w3\.org\/2000\/svg"/g, "").matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(hosts, ["dexscreener.com", "jup.ag", "raydium.io", "solscan.io"], "no other website is named");
  assert.match(part, /target = "_blank"; a\.rel = "noopener";/, "outside links open in a new tab without handing over the window");
  assert.match(part, /img\.src = logo; img\.alt = "";/); assert.match(part, /\/\^\\\/api\\\/media\\\/\[A-Za-z0-9_-\]\{1,64\}\$\//, "a logo only from our own media route");
  assert.match(part, /\.textContent = /); assert.ok(!/\$\{[^}]*\}<\//.test(part), "no HTML strings built from values");
  assert.match(part, /const na = \(why = "No data yet"\) => \{ const s = el\("span", "lp-na"\); s\.title = why;/, "a dash with a title (the server's reason) where a value is unknown");
  assert.match(part, /el\("span", "sr-only", why\)/, "and the same words for a screen reader");
  assert.match(part, /dd\.append\(s\.value == null \? na\(s\.title\) : el\("span", "lp-val lp-num", s\.value\)\);/, "a live card's missing number says why");
  assert.match(part, /\["Live", "tag--ok"\]/); assert.doesNotMatch(part, /"● Live"/);
});

test("styles: one block, every control 44 px or taller, nothing moves by itself, both themes", () => {
  const i = css.indexOf("Launchpad city coins (LAUNCHPAD_V2=on)"); assert.ok(i > 0, "the block exists");
  const next = css.indexOf("\n/* ", i); // up to the next top-level block (other switches add theirs after this one)
  const block = next < 0 ? css.slice(i) : css.slice(i, next);
  assert.ok(block.length > 2000 && block.length < 9000, "a block, not a stylesheet: " + block.length);
  assert.match(block, /\.lp-tabs button \{[^}]*min-height: 44px/); assert.match(block, /\.lp-search input \{[^}]*min-height: 48px/);
  assert.match(block, /\.lp-field select \{[^}]*min-height: 44px/); assert.match(block, /\.lp-card__actions \.btn \{ min-height: 44px; \}/);
assert.match(block, /\.lp-empty \.btn \{ min-height: 44px; \}/);
  assert.doesNotMatch(block, /@keyframes|animation\s*:|transition\s*:/, "nothing moves by itself");
  assert.match(block, /\.lp-tabs button:focus-visible \{ outline: 2px solid var\(--pin-2\)/, "a visible focus ring on the tabs");
  assert.match(block, /:root\[data-theme="light"\] \.lp-tabs__n/, "a light-theme touch");
  assert.match(block, /\.lp-grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 300px\), 1fr\)\)/, "cards never force a horizontal scroll");
  assert.match(block, /@media \(max-width: 600px\) \{[\s\S]*\.lp-stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/, "two stat columns on phones");
  assert.match(block, /\.lp-card__disc\[data-color\] \{ background: radial-gradient\(circle at 32% 28%, var\(--c1\), var\(--c2\) 45%, var\(--c3\) 100%\); \}/, "the six coin colours of the dashboard");
  assert.equal((css.match(/Launchpad city coins \(LAUNCHPAD_V2=on\)/g) || []).length, 1);
});

/* ---------- the live card (6 Oct 2026: real live numbers, a sparkline, the curve, the whole card opens the coin page) ---------- */
const CURVE = { poolId: MINT, stage: "curve", symbol: "SOL", raised: 14.795544124, target: 85, progressPct: 17.406522498823527, tokensSold: 354403438.2, tokensForSale: 793100000, supply: 1e9, slot: 1 };
const LIVE_MARKET = {
  priceUsd: 0.000007577217833193381, marketCapUsd: 7577.217833193381, fdvUsd: 7577.217833193381, liquidityUsd: 1787.13, volume24hUsd: 536.2005, priceChange24hPct: -0.7440200264703254,
  liquidityKind: "bonding_curve", stage: "curve", curve: CURVE, stale: false,
  sources: { price: "Jupiter (last trade)", marketCap: "Jupiter", fdv: "Jupiter", liquidity: "SOL in the bonding curve (on-chain) × SOL price (Jupiter)", volume24h: "Jupiter", change24h: "Jupiter", curve: "Solana blockchain, read by vicinity.city" },
  missing: {},
};
test("live card: the whole card leads to the coin page once a mint is recorded; before that to its city or the token page", () => {
  assert.equal(P.coinHref(city("A")), `/coin?mint=${MINT}`);
  assert.equal(P.coinHref({ kind: "vicinity", status: "live", mint: MINT }), `/coin?mint=${MINT}`);
  assert.equal(P.coinHref(city("A", { mint: "not-an-address" })), "/cities?city=1", "a bad mint never goes into an address");
  assert.equal(P.coinHref(city("A", { status: "designed", mint: null })), "/cities?city=1");
  assert.equal(P.coinHref({ kind: "vicinity", status: "upcoming", mint: null }), "/token");
});
test("live card: the 24-hour chip, the price's source and age, or why there is no price (never a 0)", () => {
  assert.deepEqual(plain(P.chipOf(2.314)), { text: "▲ 2.31% 24h", cls: "is-up" });
  assert.deepEqual(plain(P.chipOf(-0.7440200264703254)), { text: "▼ 0.74% 24h", cls: "is-down" });
  assert.deepEqual(plain(P.chipOf(-12.34)), { text: "▼ 12.3% 24h", cls: "is-down" });
  assert.deepEqual(plain(P.chipOf(0)), { text: "0.00% 24h", cls: "is-flat" });
  for (const v of [null, undefined, NaN, "3"]) assert.deepEqual(plain(P.chipOf(v)), { text: "— 24h", cls: "is-flat" }, String(v));
  assert.equal(P.priceSource(LIVE_MARKET, 2), "Jupiter (last trade) · just now");
  assert.equal(P.priceSource(LIVE_MARKET, 12), "Jupiter (last trade) · 12 s ago");
  assert.equal(P.priceSource(LIVE_MARKET, 190), "Jupiter (last trade) · 3 min ago");
  assert.equal(P.priceSource({ priceUsd: null, missing: { price: "jupiter has no price for it (no trade in the last 7 days); no SOL price; no DEX Screener pool" } }, 3),
    "No price right now: Jupiter has no price for it (no trade in the last 7 days)", "the server's first reason, as a sentence");
  assert.equal(P.priceSource(null, 3), "No price right now: no source has one");
  assert.equal(P.money(LIVE_MARKET.priceUsd), "$0.00000758"); assert.equal(P.fullMoney(LIVE_MARKET.priceUsd), "$0.00000757722");
});
test("live card: Market cap · 24h volume · Holders · Liquidity, each value titled with its full figure and source; on a curve the liquidity is starred and explained", () => {
  const cells = P.statCells(city("A", { market: LIVE_MARKET, holders: { count: 37, asOf: ago(0) } }));
  assert.deepEqual(plain(cells.map((c) => [c.key, c.label, c.value])), [["mcap", "Market cap", "$7.6K"], ["vol", "24h volume", "$536.20"], ["holders", "Holders", "37"], ["liq", "In the curve*", "$1.8K"]],
    "the coin page's words for what the curve holds");
  // on screen under each number (a phone has no tooltip: review OA-5, DATA-CARD-SOURCES-INVISIBLE): its source in a word or two
  assert.deepEqual(plain(cells.map((c) => [c.src, c.why])), [["Jupiter", null], ["Jupiter", null], ["vicinity.city", null], ["Chain × Jupiter*", null]]);
  assert.equal(P.curveFoot(city("A", { market: LIVE_MARKET })), "* In the curve: the SOL the bonding curve holds (on-chain) × the SOL price (Jupiter). It is not a trading pool.");
  assert.equal(P.curveFoot(city("A", { market: { ...LIVE_MARKET, liquidityKind: "pool" } })), null, "no star, no footnote");
  for (const [label, short] of [["Raydium LaunchLab", "Raydium"], ["Price × on-chain supply", "Price × supply"], ["On-chain curve × SOL price (Jupiter)", "Curve × Jupiter"], ["DEX Screener", "DEX Screener"], ["Jupiter (last trade)", "Jupiter"], ["", ""]]) assert.equal(P.shortSource(label), short, label);
  assert.equal(cells[0].title, "$7,577.22 · Jupiter");
  assert.equal(cells[2].title, "37 · Counted by vicinity.city (pools and team wallets excluded)");
  assert.match(cells[3].title, /^\$1,787\.13 · SOL in the bonding curve \(on-chain\) × SOL price \(Jupiter\)\. On the bonding curve this is what the curve holds, not a trading pool$/);
  const none = P.statCells(city("B", { market: { liquidityKind: "pool", missing: { marketCap: "no price to multiply; Jupiter could not be reached", volume24h: "Jupiter could not be reached" } }, holders: null }));
  assert.deepEqual(plain(none.map((c) => [c.label, c.value, c.title])), [["Market cap", null, "No price to multiply"], ["24h volume", null, "Jupiter could not be reached"],
    ["Holders", null, "Not counted yet: vicinity.city counts every 10 minutes"], ["Liquidity", null, "No source has it right now"]], "every missing number says why");
  assert.deepEqual(plain(none.map((c) => [c.src, c.why])), [[null, "No price to multiply"], [null, "Jupiter could not be reached"], [null, "Not counted yet: vicinity.city counts every 10 minutes"], [null, "No source has it right now"]],
    "and says it on screen, under the dash");
  const js = readFileSync(new URL("../public/launchpad.js", import.meta.url), "utf8");
  assert.match(js, /const note = field\(el\("dd", `lp-stat__src\$\{s\.value == null \? " is-why" : ""\}`, s\.value == null \? s\.why : s\.src \|\| ""\), `n-\$\{s\.key\}`\);/);
  assert.match(js, /if \(foot\) li\.append\(field\(el\("p", "lp-src lp-stats__foot", foot\), "stats-foot"\)\);/);
  assert.equal(P.statCells(city("C", { market: null })).length, 4, "a card without a market still has its four places");
});
test("live card: the bonding curve is SOL raised against the target (the real migration rule), clamped, and graduation is said in words", () => {
  const cv = P.curveView({ market: LIVE_MARKET });
  assert.deepEqual(plain(cv), { graduated: false, value: 17.406522498823527, pct: "17.4%", text: "14.80 of 85.00 SOL raised · moves to a Raydium pool at 85.00 SOL · Solana chain" });
  assert.equal(P.curveView({ market: { curve: { ...CURVE, progressPct: 4.5 } } }).pct, "4.50%");
  assert.equal(P.curveView({ market: { curve: { ...CURVE, progressPct: 140 } } }).value, 100, "never past full");
  assert.equal(P.curveView({ market: { curve: { ...CURVE, progressPct: null } } }).pct, "—");
  assert.deepEqual(plain(P.curveView({ market: { curve: { ...CURVE, stage: "graduated" } } })), { graduated: true, value: 100, pct: "Graduated", text: "Graduated to a Raydium pool · Solana chain" });
  assert.equal(P.curveView({ market: {} }), null); assert.equal(P.curveView(null), null);
  assert.notEqual(P.shapeOf(city("A", { market: LIVE_MARKET })), P.shapeOf(city("A", { market: { ...LIVE_MARKET, curve: { ...CURVE, stage: "graduated" } } })), "a graduated coin is drawn anew");
  assert.notEqual(P.shapeOf(city("A")), P.shapeOf(city("A", { status: "waiting", mint: null })));
  assert.equal(P.shapeOf(city("A", { market: LIVE_MARKET })), P.shapeOf(city("A", { market: { ...LIVE_MARKET, priceUsd: 1 } })), "a new price is an update in place");
});
test("live card sparkline: vicinity.city's USD readings when there are 6, else Raydium's SOL candles run flat to now, else nothing (never a made-up line)", () => {
  const now = 1_791_300_000;
  const usd = (n) => Array.from({ length: n }, (_, i) => [now - (n - i) * 600, 0.0000075 + i * 1e-8, "j", 6e-8]);
  const usdPick = P.sparkPick({ ok: true, line: { points: usd(8) }, candles: { interval: "15m", rows: [[now - 3600, 6e-8, 7e-8, 6e-8, 7e-8]] } }, now);
  assert.equal(usdPick.unit, "USD"); assert.equal(usdPick.points.length, 8); assert.equal(usdPick.to, now);
  const solPick = P.sparkPick({ ok: true, line: { points: usd(2) }, candles: { interval: "15m", rows: [[now - 7200, 6e-8, 6.5e-8, 6e-8, 6.4e-8], [now - 3600, 6.4e-8, 7e-8, 6.4e-8, 6.9e-8], [now - 1800, 6.9e-8, 7e-8, 6.8e-8, 6.8e-8]] } }, now);
  assert.equal(solPick.unit, "SOL");
  assert.deepEqual(plain(solPick.points), [[now - 7200, 6e-8], [now - 6300, 6.4e-8], [now - 3600, 6.4e-8], [now - 2700, 6.9e-8], [now - 1800, 6.9e-8], [now - 900, 6.8e-8], [now, 6.8e-8]],
    "each candle opens where it starts and closes where it ends; after the last one the curve's price stays (nobody traded)");
  assert.equal(P.sparkPick({ ok: true, line: { points: usd(3) }, candles: null }, now).unit, "USD", "fewer than 6 readings and no candles: the readings there are");
  assert.equal(P.sparkPick({ ok: true, line: { points: [] }, candles: { rows: [] } }, now), null);
  assert.equal(P.sparkPick({ ok: false, error: "chart_unavailable" }, now), null);
  assert.equal(P.sparkPick({ ok: true, line: { points: [[now, null, null, null], ["x", 1], [now - 60, -1], [now - 30, Infinity]] }, candles: { rows: [["t", 1, 1, 1, 1], [now, 0, 1, 1, 1]] } }, now), null, "junk rows are dropped");
  assert.equal(P.sparkWhy({ ok: true, candles: { rows: [] }, line: { points: [] } }), "No trades in 7 days", "only when Raydium's candles of a known curve say so");
  assert.equal(P.sparkWhy({ ok: true, candles: null, line: { points: [] } }), "No price history recorded yet", "a coin without a curve: nothing recorded, not 'no trades'");
  assert.equal(P.sparkWhy({ ok: false }), "Price history didn't load"); assert.equal(P.sparkWhy(null), "Price history didn't load");
});
test("live card sparkline: a polyline and its area in a 240 × 44 box, x by time, coloured by the way it went; a corner label with the span and unit", () => {
  const g = P.sparkGeometry({ points: [[0, 1], [50, 3], [100, 2]], from: 0, to: 100 }, 240, 44);
  assert.equal(g.line, "0,40 120,4 240,22"); assert.equal(g.area, "M0,44 L0,40 L120,4 L240,22 L240,44 Z"); assert.equal(g.endY, 22); assert.equal(g.dir, "up");
  assert.equal(P.sparkGeometry({ points: [[0, 3], [100, 1]], from: 0, to: 100 }).dir, "down");
  const flat = P.sparkGeometry({ points: [[0, 2], [100, 2]], from: 0, to: 100 });
  assert.equal(flat.dir, "flat"); assert.equal(flat.line, "0,22 240,22", "a flat line sits in the middle");
  assert.equal(P.sparkGeometry({ points: [[0, 1]], from: 0, to: 1 }), null); assert.equal(P.sparkGeometry(null), null);
  assert.equal(P.sparkGeometry({ points: [[50, 1], [100, 2]], from: 50, to: 200 }).line, "0,40 80,4", "x is proportional to time up to now");
  assert.equal(P.sparkLabel({ unit: "USD", from: 0, to: 86400 }, "24h"), "24h · USD");
  assert.equal(P.sparkLabel({ unit: "SOL", from: 0, to: 5 * 3600 }, "24h"), "5h · SOL", "a shorter history says how short");
  assert.equal(P.sparkLabel({ unit: "SOL", from: 0, to: 3 * 86400 }, "7d"), "3d · SOL");
  assert.equal(P.sparkLabel(null, "24h"), "");
});
test("live card markup: price, chip, source, sparkline, four numbers, the curve as a native progress bar, Buy on Raydium and Chart & details; no DEX Screener on a card", () => {
  const cardFn = part.slice(part.indexOf("  function card(c, now, featured) {"), part.indexOf("  function morph(old, fresh) {"));
  assert.ok(cardFn.length > 2000);
  assert.match(cardFn, /link\.href = coinHref\(c\); link\.dataset\.act = "view";/, "the title is the card's link");
  assert.match(cardFn, /el\("a", "btn btn--primary btn--sm", "Buy on Raydium ↗"\)\); buy\.href = lk\.raydium;/);
  assert.match(cardFn, /el\("a", "btn btn--glass btn--sm", "Chart & details →"\); more\.href = coinHref\(c\);/);
  assert.doesNotMatch(cardFn, /dexscreener|DEX Screener|lk\.jupiter/, "Jupiter and DEX Screener live on the coin page (DEX Screener only once it lists a pool)");
  assert.match(cardFn, /field\(el\("progress", "lp-bar"\), "curve-bar"\); bar\.max = 100; bar\.value = cv\.value;/, "a progress element: its width needs no style attribute");
  assert.match(cardFn, /"lp-price__val lp-num"/); assert.match(cardFn, /"lp-val lp-num"/);
  assert.match(part, /window\.V\.liveNums\(list\.querySelectorAll\("\.lp-num"\)\);/, "the numbers ease through the motion layer (a price never counts up from 0)");
  assert.match(part, /if \(old\.dataset\.shape !== fresh\.dataset\.shape\) return fresh;/, "the 30-second refresh updates a card of the same shape in place");
  // the whole card: a click anywhere opens the coin page, except on its own links and buttons, or while selecting text
  assert.match(part, /const li = e\.target\.closest && e\.target\.closest\("\.lp-card--live"\);\n\s+if \(!li \|\| e\.target\.closest\("a, button, input, select, label, summary"\)\) return;/);
  assert.match(part, /if \(window\.getSelection && String\(window\.getSelection\(\)\) !== ""\) return;/);
  // the sparkline: inline SVG, its gradient inside it, no style attribute, the end dot drawn 1:1 so it stays round
  assert.match(part, /svg\("svg", \{ class: "lp-spark__svg", viewBox: `0 0 240 \$\{h\}`, preserveAspectRatio: "none", focusable: "false" \}\)/);
  assert.match(part, /svg\("polyline", \{ class: "lp-spark__line", points: g\.line, "vector-effect": "non-scaling-stroke" \}\)/);
  assert.match(part, /box\.setAttribute\("aria-hidden", "true"\);/, "decoration: the numbers say it in words");
});
test("live card styles: still in the Launchpad block; the motion (pings, flash, shimmer) only in its own block before the profiles, with reduced motion nothing moves", () => {
  const at = css.indexOf("Launchpad live market (LAUNCHPAD_V2=on): the live coin cards and the coin page");
  const end = css.indexOf("/* ---- dashboard v2 ---- */");
  assert.ok(at > css.indexOf("Member profiles (PROFILES=on)") && end > at, "the still part sits with the Launchpad block, before the dashboard v2 block");
  const still = css.slice(at, end);
  assert.doesNotMatch(still, /@keyframes|animation\s*:/, "nothing moves by itself there");
  for (const m of still.matchAll(/transition\s*:/g)) assert.fail("a transition outside the motion block: " + still.slice(m.index - 60, m.index + 30));
  assert.match(still, /\.lp-stats--live \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/); assert.match(still, /@container \(min-width: 400px\) \{ \.lp-stats--live \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \} \}/);
  assert.match(still, /\.lp-bar::-webkit-progress-value \{ background: linear-gradient\(90deg, #FF5A36, #FFC857\);/); assert.match(still, /\.lp-bar::-moz-progress-bar \{/);
  assert.match(still, /:root\[data-theme="light"\] \{ --up: #1E9E78; --down: #E8431F;/, "a light theme of its own");
  const mo = css.slice(css.indexOf("Launchpad live market: motion (LAUNCHPAD_V2=on"), css.indexOf("Member profiles (PROFILES=on)"));
  assert.ok(mo.length > 500 && mo.length < 4000);
  assert.match(mo, /@media \(prefers-reduced-motion: no-preference\) \{\n  \.lp-card__ping::after, \.coin-pill__dot::after \{ animation: livePing 1\.8s cubic-bezier\(0,0,\.2,1\) infinite var\(--lb-play, running\); \}/,
    "the live dot pings, and pauses off screen or in a hidden tab (--lb-play)");
  for (const m of mo.matchAll(/animation: (\w+)[^;}]*infinite([^;}]*)/g)) { assert.ok(["livePing", "shimmer"].includes(m[1]), m[1]); assert.match(m[2], /var\(--lb-play, running\)/, m[0]); }
  for (const name of ["lpFlash", "coinTradeIn"]) {
    const kf = css.slice(css.indexOf(`@keyframes ${name} {`), css.indexOf("\n", css.indexOf(`@keyframes ${name} {`)));
    const props = [...kf.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
    assert.ok(props.length && props.every((p) => ["transform", "opacity"].includes(p)), `${name}: ${props}`);
  }
  assert.match(read("site.js"), /const LIVE = "[^"]*\.lp-card, \.coin-live";/, "the cards and the coin page's live parts are watched on and off screen");
});

test("honesty (review): a card names Raydium LaunchLab only when the chain found the coin's pool or Jupiter says it launched there", () => {
  const coin = (market) => ({ kind: "city", status: "live", ticker: "UTICA", pair: { symbol: "SOL" }, market });
  assert.equal(P.venueLine(coin({ curve: null, launchpad: null })), "SOL pair", "no LaunchLab curve on the chain: no venue");
  assert.equal(P.venueLine(coin({ curve: null, launchpad: "raydium-launchlab" })), "Raydium LaunchLab · SOL pair");
  assert.equal(P.venueLine(coin({ curve: { stage: "curve" } })), "Raydium LaunchLab · SOL pair");
  assert.equal(P.venueLine({ kind: "city", status: "live", pair: { symbol: "USDC" }, market: null }), "USDC pair");
  const js = readFileSync(new URL("../public/launchpad.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /`Raydium LaunchLab · \$\{str\(c\.pair/, "never said unconditionally");
});
