// The coin page's chart (public/coinchart.js): our own canvas code, no library. Its pure helpers run here in node (no canvas, no
// page): number and time words, scales and ticks, the gaps of a line, the nearest point, and what is drawn from one /api/coin/chart
// answer. Rendering, the crosshair by mouse, touch and keyboard, and the motion are checked in Chromium on the real Worker.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../public/coinchart.js", import.meta.url), "utf8");
const win = {};
vm.runInNewContext(src, { window: win, Intl, Date, Math, Number, JSON });
const C = win.VChart.pure;
const plain = (x) => JSON.parse(JSON.stringify(x));

test("numbers: every digit for the price at the top, the short form trading sites use (0.0₅7577) for the axis and the pills; never an exponent", () => {
  assert.equal(C.zerosOf(0.000007577), 5); assert.equal(C.zerosOf(0.5), 0); assert.equal(C.zerosOf(2), 0);
  assert.equal(C.fmtValue(0.000007577217833), "$0.000007577");
  assert.equal(C.fmtValue(0.000007577217833, "USD", { short: true }), "$0.0₅7577");
  assert.equal(C.fmtValue(6.233650881956076e-8, "SOL"), "0.00000006234");
  assert.equal(C.fmtValue(6.233650881956076e-8, "SOL", { short: true }), "0.0₇6234");
  assert.equal(C.fmtValue(0.0042, "USD", { short: true }), "$0.0042", "fewer than four zeros: written out");
  assert.equal(C.fmtValue(7577.2178), "$7.58K"); assert.equal(C.fmtValue(12.5), "$12.50"); assert.equal(C.fmtValue(1234567), "$1.23M");
  for (const bad of [null, NaN, Infinity, "1"]) assert.equal(C.fmtValue(bad), "—");
  for (const v of [1e-12, 3e-9, 0.000001]) assert.doesNotMatch(C.fmtValue(v), /e/);
  assert.equal(C.shortZeros("0.000007577"), "0.0₅7577"); assert.equal(C.shortZeros("0.0042"), "0.0042"); assert.equal(C.shortZeros("12.5"), "12.5");
  assert.equal(C.shortZeros("0.0000000000001"), "0.0₁₂1", "two-digit zero counts");
  assert.equal(C.fmtChange(4.123), "▲ 4.12%"); assert.equal(C.fmtChange(-0.744), "▼ 0.74%"); assert.equal(C.fmtChange(0), "0.00%"); assert.equal(C.fmtChange(123.4), "▲ 123%"); assert.equal(C.fmtChange(null), "—");
  assert.equal(C.changePct(2, 3), 50); assert.equal(C.changePct(0, 3), null); assert.equal(C.changePct(null, 3), null);
});

test("axis: nice steps (1, 2, 2.5, 5 × 10ⁿ), ticks inside the range, labels that tell neighbours apart", () => {
  assert.equal(C.niceStep(10, 4), 2.5); assert.equal(C.niceStep(7, 4), 2); assert.equal(C.niceStep(0.0000004, 4), 1e-7); assert.equal(C.niceStep(0, 4), 0);
  const t = C.niceTicks(0.0000072, 0.0000081, 4);
  assert.deepEqual(plain(t.ticks), [0.00000725, 0.0000075, 0.00000775, 0.000008]);
  assert.equal(t.step, 2.5e-7);
  assert.equal(C.fmtAxis(0.00000725, t.step), "$0.0₅725", "as many decimals as the step: never rounded into its neighbour");
  assert.equal(C.fmtAxis(0.000008, t.step), "$0.0₅800");
  const u = C.niceTicks(0.0000072, 0.0000079, 4);
  assert.equal(u.step, 2e-7); assert.equal(C.fmtAxis(0.0000074, u.step), "$0.0₅74");
  assert.equal(C.fmtAxis(6.2e-8, 1e-9, "SOL"), "0.0₇62"); assert.equal(C.fmtAxis(7500, 500), "$7.5K"); assert.equal(C.fmtAxis(12.5, 2.5), "$12.5");
  assert.deepEqual(plain(C.niceTicks(5, 5)), { ticks: [5], step: 0 }, "a flat range has one tick");
  assert.deepEqual(plain(C.padRange(1, 1)), [0.98, 1.02], "a flat series sits in the middle");
  const [lo, hi] = C.padRange(10, 20); assert.ok(lo < 10 && lo >= 5 && hi > 20);
  const s = C.scale(0, 10, 100, 200); assert.equal(s(5), 150); assert.equal(s.invert(150), 5);
});

test("time: steps that leave room for the labels, ticks on round local times, '14:00' within a day, 'Mon 14:00' over a week, 'Oct 4' for days", () => {
  assert.equal(C.timeStep(86400, 320, 64), 21600, "24 h on a phone: every 6 hours");
  assert.equal(C.timeStep(7 * 86400, 1000, 84), 86400, "a week on a computer: every day");
  assert.equal(C.timeStep(3600, 300, 64), 900);
  const utc = () => 0;
  const t0 = Date.parse("2026-10-04T13:20:00Z") / 1000;
  assert.deepEqual(plain(C.timeTicks(t0, t0 + 86400, 21600, utc).map((t) => new Date(t * 1000).toISOString().slice(11, 16))), ["18:00", "00:00", "06:00", "12:00"]);
  const ny = () => -4 * 3600; // a zone four hours behind: ticks fall on its own round hours
  assert.deepEqual(plain(C.timeTicks(t0, t0 + 86400, 21600, ny).map((t) => new Date((t - 4 * 3600) * 1000).toISOString().slice(11, 16))), ["12:00", "18:00", "00:00", "06:00"]);
  assert.deepEqual(plain(C.timeTicks(5, 1, 60)), [], "an empty span has no ticks");
  const at = Date.parse("2026-10-05T14:00:00Z") / 1000, midnight = Date.parse("2026-10-05T00:00:00Z") / 1000;
  assert.equal(C.fmtTick(at, 3600, 86400, "UTC"), "14:00");
  assert.equal(C.fmtTick(at, 43200, 7 * 86400, "UTC"), "Mon 14:00");
  assert.equal(C.fmtTick(midnight, 43200, 7 * 86400, "UTC"), "Oct 5", "a new day is named");
  assert.equal(C.fmtTick(at, 86400, 30 * 86400, "UTC"), "Oct 5");
  assert.equal(C.fmtWhen(at, 3600, "UTC"), "Oct 5, 14:00"); assert.equal(C.fmtWhen(at, 86400, "UTC"), "Oct 5");
  assert.equal(C.fmtSpan(1800), "30 min"); assert.equal(C.fmtSpan(5 * 3600), "5 h"); assert.equal(C.fmtSpan(3 * 86400), "3 days");
});

test("the line: a missing reading breaks it, a pause longer than 6 intervals is its own dashed stretch, nothing joins across a hole", () => {
  const p = (t, v) => [t, v, null];
  const pts = [p(0, 1), p(600, 2), p(1200, 3), p(1800 + 600 * 7, 3), p(1800 + 600 * 8, 4), p(9000, null), p(9600, 5), p(10200, 6)];
  assert.deepEqual(plain(C.runsOf(pts, 600 * 6)), [
    { from: 0, to: 2, dashed: false }, { from: 2, to: 3, dashed: true }, { from: 3, to: 4, dashed: false }, { from: 6, to: 7, dashed: false },
  ]);
  assert.deepEqual(plain(C.runsOf([p(0, 1)], 3600)), [], "one lone reading: no line (it is drawn as a dot)");
  assert.deepEqual(plain(C.runsOf([p(0, null), p(1, null)], 3600)), []);
  assert.equal(C.nearestIndex([0, 10, 20, 30], 14), 1); assert.equal(C.nearestIndex([0, 10, 20, 30], 16), 2);
  assert.equal(C.nearestIndex([0, 10], -5), 0); assert.equal(C.nearestIndex([0, 10], 99), 1); assert.equal(C.nearestIndex([], 3), -1); assert.equal(C.nearestIndex([1], NaN), -1);
});

const NOW = 1_791_300_000;
const answer = {
  ok: true, tf: "24h",
  candles: { unit: "SOL", interval: "15m", source: "Raydium LaunchLab", rows: [[NOW - 7200, 6e-8, 6.6e-8, 6e-8, 6.5e-8], [NOW - 3600, 6.5e-8, 7e-8, 6.4e-8, 6.9e-8], ["bad", 1, 1, 1, 1], [NOW - 1800, 6.9e-8, 6.8e-8, 6.9e-8, 6.8e-8]] },
  line: { unit: "USD", interval: "10m", source: "vicinity.city samples", points: [[NOW - 1200, 0.0000075, "j", 6.2e-8], [NOW - 600, null, null, 6.2e-8], [NOW, 0.0000076, "c", 6.3e-8], ["x", 1, "j", null], [NOW + 1, -2, "j", null]], recordingSince: "2026-10-06T10:00:00.000Z" },
  missing: {},
};
test("series: USD from vicinity.city's readings (a missing one breaks the line), SOL from Raydium's candles as they happened, market cap only with a fixed supply", () => {
  const usd = C.seriesFrom(answer, { unit: "USD" });
  assert.equal(usd.kind, "line"); assert.equal(usd.unit, "USD"); assert.equal(usd.interval, 600); assert.equal(usd.gapWord, "no reading");
  assert.deepEqual(plain(usd.points), [[NOW - 1200, 0.0000075, "j"], [NOW - 600, null, null], [NOW, 0.0000076, "c"], [NOW + 1, null, "j"]], "junk times are dropped, junk values become holes");
  assert.equal(usd.first, 0.0000075); assert.equal(usd.last, 0.0000076); assert.equal(usd.empty, null);
  const sol = C.seriesFrom(answer, { unit: "SOL" });
  assert.equal(sol.kind, "line"); assert.equal(sol.gapWord, "no trades"); assert.equal(sol.interval, 900);
  assert.deepEqual(plain(sol.points.map((p) => [p[0] - NOW, p[1]])), [[-7200, 6e-8], [-6300, 6.5e-8], [-3600, 6.5e-8], [-2700, 6.9e-8]],
    "each candle: its open where it starts, its close where it ends; between candles the curve's price stays (nobody traded)");
  assert.equal(C.seriesFrom(answer, { unit: "SOL", style: "candles" }).candles.length, 2, "a row with a bad time, or a low above its high, is no candle");
  const candles = C.seriesFrom(answer, { unit: "SOL", style: "candles" });
  assert.equal(candles.kind, "candles"); assert.deepEqual(plain(candles.points.map((p) => p[0] - NOW)), [-7200 + 450, -3600 + 450], "the crosshair sits mid-candle");
  const mcap = C.seriesFrom(answer, { unit: "MCAP", supply: 1e9 });
  assert.equal(mcap.unit, "MCAP"); assert.equal(Math.round(mcap.last), 7600, "price × 1,000,000,000");
  assert.match(C.seriesFrom(answer, { unit: "MCAP", supply: null }).empty, /supply is not known to be fixed/, "never a market cap without a fixed supply");
  assert.equal(C.seriesFrom(answer, { unit: "USD", style: "candles" }).kind, "line", "candles exist in SOL only");
});

test("series: empty ranges say why, in the server's words when it gave them", () => {
  const none = { ok: true, candles: { unit: "SOL", interval: "1h", rows: [] }, line: { unit: "USD", interval: "1h", points: [] }, missing: { candles: "No trades in this range", line: "Not recorded yet: vicinity.city samples the price every 10 minutes from its first run on" } };
  assert.equal(C.seriesFrom(none, { unit: "SOL" }).empty, "No trades in this range");
  assert.equal(C.seriesFrom(none, { unit: "USD" }).empty, "Not recorded yet: vicinity.city samples the price every 10 minutes from its first run on");
  assert.equal(C.seriesFrom({ ok: true, candles: null, line: null }, { unit: "SOL" }).empty, "No trades in this range");
  assert.equal(C.seriesFrom(null, { unit: "USD" }).empty, "No reading in this range");
});

test("domain: the range up to now; a shorter history starts at its first point and says so; 'all' starts at the first point", () => {
  const s = C.seriesFrom(answer, { unit: "USD" });
  const week = C.domainOf(s, "7d", NOW);
  assert.deepEqual(plain(week), { x0: NOW - 1200, x1: NOW + 1, short: true, firstT: NOW - 1200 }, "20 minutes of readings in a 7-day range: the chart shows those 20 minutes and says the history is short");
  const full = C.domainOf({ kind: "line", points: [[NOW - 90000, 1], [NOW, 2]], candles: [], interval: 600 }, "24h", NOW);
  assert.equal(full.x0, NOW - 86400); assert.equal(full.short, false);
  const all = C.domainOf({ kind: "line", points: [[NOW - 900000, 1], [NOW, 2]], candles: [], interval: 600 }, "all", NOW);
  assert.equal(all.x0, NOW - 900000); assert.equal(all.short, false);
  assert.ok(C.domainOf({ kind: "line", points: [[NOW, 1]], candles: [], interval: 600 }, "1h", NOW).x1 - C.domainOf({ kind: "line", points: [[NOW, 1]], candles: [], interval: 600 }, "1h", NOW).x0 >= 600, "never narrower than 10 minutes");
  assert.deepEqual(plain(C.extentOf(s, NOW - 1200, NOW)), [0.0000075, 0.0000076]);
  assert.deepEqual(plain(C.extentOf(C.seriesFrom(answer, { unit: "SOL", style: "candles" }), NOW - 7200, NOW)), [6e-8, 7e-8], "candles: their lows and highs");
  assert.equal(C.valueAt(s, NOW - 300), 0.0000075, "the price stays until the next reading");
});

test("the canvas code keeps the rules: our own drawing, nothing from another site, no markup from text, frames only while something moves", () => {
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(|XMLHttpRequest|import\(/);
  assert.doesNotMatch(src, /https?:\/\//, "names no website");
  assert.match(src, /dpr = Math\.min\(2, window\.devicePixelRatio \|\| 1\);/, "at most 2 device pixels per CSS pixel");
  assert.match(src, /if \(reducedNow\(\) \|\| document\.hidden\) \{ anim = null; draw\(\); return; \}/, "reduced motion, Pause animations or a hidden tab: no animation, one still drawing");
  assert.match(src, /anim = \{ kind, t0: null, ms: kind === "reveal" \? 450 : 1200 \};/, "a 450 ms reveal, a 1.2 s ping");
  assert.match(src, /if \(k < 1\) frame = requestAnimationFrame\(step\); else \{ anim = null; frame = 0; draw\(\); \}/, "frames stop when it ends: no loop");
  assert.equal((src.match(/requestAnimationFrame\(/g) || []).length, 2, "the only frames are the reveal's and the ping's");
  assert.match(src, /if \(dy > 8 && dy > dx\) \{ clearTimeout\(touch\.timer\); touch = null; return; \} \/\/ a vertical swipe: the page scrolls/);
  assert.match(src, /if \(dx > 8\) \{ touch\.live = true;/); assert.match(src, /setTimeout\(\(\) => \{ if \(touch\) \{ touch\.live = true; scrubbing = true; point\(at\(ev\)\); \} \}, 180\)/, "a 180 ms press also scrubs");
  for (const k of ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"]) assert.ok(src.includes(k), k);
});
