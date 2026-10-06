// The coin page's price chart (/coin): our own canvas code, no chart library (the security policy loads nothing from another
// site, and nothing is vendored for this). public/coin.js feeds it the series of GET /api/coin/chart and listens to the crosshair.
//
// What it draws, and the honesty rules it keeps:
// * a line (with a soft fill under it) or candles, x proportional to time, y from the lowest to the highest value shown;
// * only what the answer holds: a candle that does not exist is never drawn, a gap longer than 6 intervals is a dashed stretch
//   ("no trades" for Raydium's candles, "no reading" for vicinity.city's samples), a missing USD reading breaks the line;
// * the SOL line follows Raydium's candles as they happened: the open where a bucket starts, the close where it ends, and between
//   two candles the price the curve kept (nobody traded, so nothing moved: Raydium's open of a bucket is the close before it);
// * the last value as a dashed line across with a pill at the right edge;
// * a crosshair (mouse: on move; touch: a sideways drag after 8 px, or a 180 ms press, so a vertical swipe still scrolls the
//   page; keyboard: the canvas takes the focus, ← → step one point, Home / End jump to the ends, Esc lets go) with a pill on top
//   saying when, what and from where.
// Motion: a range change reveals the series from left to right in 450 ms; a live update pings the last point for 1.2 s. Each asks
// for animation frames only while it lasts; nothing loops, nothing moves with reduced motion or "Pause animations".
// Pure helpers (scales, ticks, number and time words, gaps, the nearest point, the series) are window.VChart.pure, run in node by
// test/coinchart.test.js.
(() => {
  "use strict";

  /* =====================================================================
     Pure helpers
     ===================================================================== */
  const SUB = "₀₁₂₃₄₅₆₇₈₉";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const INTERVALS = { "1m": 60, "5m": 300, "10m": 600, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  const RANGES = { "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, all: null };
  const GAP_INTERVALS = 6; // a pause longer than this many intervals is drawn dashed
  const SUPPLY_FIXED = 1e9;

  /** How many zeros follow the decimal point before the first digit: 0.000007577 → 5. */
  const zerosOf = (a) => (a > 0 && a < 1 ? -Math.floor(Math.log10(a)) - 1 : 0);
  const subDigits = (n) => String(n).split("").map((d) => SUB[Number(d)]).join("");
  /** "0.000007577" → "0.0₅7577" (four or more zeros): the short form trading sites use, for the axis and the pills. */
  const shortZeros = (text) => { const m = /^(-?)0\.(0{4,})(\d+)$/.exec(text); return m ? `${m[1]}0.0${subDigits(m[2].length)}${m[3]}` : text; };
  const group = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
  /** A plain decimal with `sig` significant digits, never an exponent, trailing zeros dropped (two decimals kept). */
  function decimals(a, sig = 4) {
    if (!(a > 0)) return "0";
    const d = Math.min(20, Math.max(2, zerosOf(a) + sig));
    return a.toFixed(d).replace(/(\.\d\d\d*?)0+$/, "$1");
  }
  /**
   * A value as the chart writes it. unit "USD" ($), "SOL" (no sign), "MCAP" ($, compact). `short` uses the subscript form for
   * tiny numbers (axis, pills); otherwise every digit is written out (the price at the top, the tiles).
   */
  function fmtValue(v, unit = "USD", { short = false, sig = 4 } = {}) {
    if (!isNum(v)) return "—";
    const a = Math.abs(v), sign = v < 0 ? "-" : "", cur = unit === "SOL" ? "" : "$";
    let body;
    if (a >= 1000) body = compactFmt.format(a);
    else if (a >= 1) body = group.format(a);
    else body = decimals(a, sig);
    if (short) body = shortZeros(body);
    return `${sign}${cur}${body}`;
  }
  /** Axis labels for evenly spaced ticks: enough decimals to tell neighbours apart, the short form for tiny numbers. */
  function fmtAxis(v, step, unit = "USD") {
    if (!isNum(v)) return "";
    const cur = unit === "SOL" ? "" : "$", a = Math.abs(v), sign = v < 0 ? "-" : "";
    if (a >= 1000) return `${sign}${cur}${compactFmt.format(a)}`;
    // as many decimals as the step has: 2e-7 needs 7, 2.5e-7 needs 8 (so 0.00000725 is never rounded to 0.0000073)
    const p = Math.floor(Math.log10(step)), m = step / 10 ** p;
    const d = Math.min(20, Math.max(0, -p + (Math.abs(m - Math.round(m)) > 1e-6 ? 1 : 0)));
    return `${sign}${cur}${shortZeros(a.toFixed(d))}`;
  }
  /** A change in percent with its arrow: "▲ 4.1%", "▼ 0.7%", "0.0%". */
  const fmtChange = (p) => (!isNum(p) ? "—" : `${p > 0 ? "▲ " : p < 0 ? "▼ " : ""}${Math.abs(p).toFixed(Math.abs(p) >= 100 ? 0 : Math.abs(p) >= 10 ? 1 : 2)}%`);
  const changePct = (from, to) => (isNum(from) && isNum(to) && from > 0 ? ((to - from) / from) * 100 : null);

  /** A "nice" step (1, 2, 2.5 or 5 × a power of ten) that gives about `count` intervals over `span`. */
  function niceStep(span, count = 4) {
    if (!(span > 0)) return 0;
    const raw = span / Math.max(1, count), p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  /** Ticks inside [min, max] on a nice step (about `count` gaps). { ticks, step }. */
  function niceTicks(min, max, count = 4) {
    if (!isNum(min) || !isNum(max) || max <= min) return { ticks: isNum(min) ? [min] : [], step: 0 };
    const step = niceStep(max - min, count), out = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9 && out.length < 50; v += step) out.push(Number(v.toPrecision(12)));
    return { ticks: out, step };
  }
  /** The y range of some values with room above and below (a flat series gets ±2 % so it sits in the middle). */
  function padRange(lo, hi, pad = 0.12) {
    if (!isNum(lo) || !isNum(hi)) return [0, 1];
    if (hi <= lo) { const m = Math.abs(lo) || 1; return [lo - m * 0.02, hi + m * 0.02]; }
    const d = (hi - lo) * pad;
    return [Math.max(lo > 0 ? lo * 0.5 : -Infinity, lo - d), hi + d];
  }
  /** A linear scale [d0, d1] → [r0, r1] and back. */
  function scale(d0, d1, r0, r1) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    const f = (v) => r0 + (v - d0) * k;
    f.invert = (r) => (k === 0 ? d0 : d0 + (r - r0) / k);
    return f;
  }

  /* ----- time ----- */
  const STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 345600, 604800, 1209600, 2592000, 7776000];
  /** The first time step from STEPS that keeps labels at least `minPx` apart over `widthPx`. */
  function timeStep(spanSec, widthPx, minPx = 64) {
    const max = Math.max(1, Math.floor(widthPx / minPx));
    return STEPS.find((s) => spanSec / s <= max) || STEPS[STEPS.length - 1];
  }
  /** Local time offset in seconds at a moment (the browser's own zone unless a function is given). */
  const localOffset = (t) => -new Date(t * 1000).getTimezoneOffset() * 60;
  /** Tick times inside [t0, t1] (unix seconds) on `step`, on round local times (midnight, whole hours). */
  function timeTicks(t0, t1, step, offsetOf = localOffset) {
    const out = [];
    if (!(t1 > t0) || !(step > 0)) return out;
    const off = offsetOf(t0);
    for (let t = Math.ceil((t0 + off) / step) * step - off; t <= t1 && out.length < 60; t += step) {
      const drift = offsetOf(t) - off; // a daylight-saving change inside the range: keep the labels on round local times
      out.push(step >= 3600 ? t - drift : t);
    }
    return out;
  }
  const fmts = new Map();
  const dtf = (opts, tz) => { const k = JSON.stringify([opts, tz || ""]); if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat("en-US", { ...opts, ...(tz ? { timeZone: tz } : {}) })); return fmts.get(k); };
  const hm = (t, tz) => dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, tz).format(new Date(t * 1000));
  const md = (t, tz) => dtf({ month: "short", day: "numeric" }, tz).format(new Date(t * 1000));
  const wd = (t, tz) => dtf({ weekday: "short" }, tz).format(new Date(t * 1000));
  const isMidnight = (t, tz) => hm(t, tz) === "00:00";
  /**
   * A tick label: "14:00" within a day, "Mon 14:00" over a week, "Oct 4" for whole days (and at each midnight, so a day change
   * is always named). spanSec is the visible span.
   */
  function fmtTick(t, step, spanSec, tz) {
    if (step >= 86400 || isMidnight(t, tz)) return md(t, tz);
    return spanSec > 86400 ? `${wd(t, tz)} ${hm(t, tz)}` : hm(t, tz);
  }
  /** When a point is, for the crosshair: "Oct 5, 14:00"; a day candle: "Oct 5". */
  const fmtWhen = (t, intervalSec, tz) => (intervalSec >= 86400 ? md(t, tz) : `${md(t, tz)}, ${hm(t, tz)}`);
  /** "2 h", "3 d", "45 min": how long a stretch of history is. */
  function fmtSpan(sec) {
    if (!(sec >= 0)) return "";
    if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
    if (sec < 2 * 86400) return `${Math.round(sec / 3600)} h`;
    return `${Math.round(sec / 86400)} days`;
  }

  /* ----- the series ----- */
  /** The first index whose x is ≥ x (xs ascending); xs.length when none. */
  function lowerBound(xs, x) { let a = 0, b = xs.length; while (a < b) { const m = (a + b) >> 1; if (xs[m] < x) a = m + 1; else b = m; } return a; }
  /** The index of the x nearest to x (xs ascending), or -1. */
  function nearestIndex(xs, x) {
    if (!xs.length || !isNum(x)) return -1;
    const i = lowerBound(xs, x);
    if (i <= 0) return 0;
    if (i >= xs.length) return xs.length - 1;
    return x - xs[i - 1] <= xs[i] - x ? i - 1 : i;
  }
  /**
   * The runs of a line: [{ from, to, dashed }] over point indices. A null value breaks the line (no run joins across it); two
   * consecutive points further apart than `gapSec` are joined by a dashed run of their own.
   */
  function runsOf(points, gapSec) {
    const runs = [];
    let start = -1;
    for (let i = 0; i < points.length; i++) {
      const ok = isNum(points[i][1]);
      if (!ok) { if (start >= 0 && i - 1 > start) runs.push({ from: start, to: i - 1, dashed: false }); start = -1; continue; }
      if (start < 0) { start = i; continue; }
      if (gapSec > 0 && points[i][0] - points[i - 1][0] > gapSec) {
        if (i - 1 > start) runs.push({ from: start, to: i - 1, dashed: false });
        runs.push({ from: i - 1, to: i, dashed: true });
        start = i;
      }
    }
    if (start >= 0 && points.length - 1 > start) runs.push({ from: start, to: points.length - 1, dashed: false });
    return runs;
  }
  const SRC_WORDS = { j: "Jupiter (last trade)", c: "on-chain curve × SOL price (Jupiter)", d: "DEX Screener" };
  const okCandle = (r) => Array.isArray(r) && r.length >= 5 && Number.isSafeInteger(r[0]) && r.slice(1, 5).every((v) => isNum(v) && v > 0) && r[3] <= r[2];
  /**
   * What to draw from one /api/coin/chart answer. unit "USD" | "SOL" | "MCAP", style "line" | "candles" (candles exist in SOL
   * only: Raydium's). supply: the fixed supply (for MCAP), null when it is not known to be fixed.
   * { kind, unit, points: [[t, v, src]], candles: [[t,o,h,l,c]], interval, source, first, last, empty: reason | null, gapWord }
   */
  function seriesFrom(answer, { unit = "USD", style = "line", supply = SUPPLY_FIXED } = {}) {
    const a = answer && typeof answer === "object" ? answer : {};
    const missing = a.missing && typeof a.missing === "object" ? a.missing : {};
    if (unit === "SOL") {
      const c = a.candles && typeof a.candles === "object" ? a.candles : null;
      const interval = INTERVALS[c && c.interval] || 900;
      const rows = (c && Array.isArray(c.rows) ? c.rows : []).filter(okCandle).map((r) => r.slice(0, 5)).sort((x, y) => x[0] - y[0]);
      const base = { unit: "SOL", interval, source: (c && typeof c.source === "string" && c.source) || "Raydium LaunchLab", gapWord: "no trades", note: c && typeof c.note === "string" ? c.note : null };
      if (!rows.length) return { ...base, kind: style === "candles" ? "candles" : "line", points: [], candles: [], first: null, last: null, empty: typeof missing.candles === "string" ? missing.candles : "No trades in this range" };
      if (style === "candles") return { ...base, kind: "candles", points: rows.map((r) => [r[0] + interval / 2, r[4], null]), candles: rows, first: rows[0][1], last: rows[rows.length - 1][4], empty: null };
      const points = [];
      for (const [t, o, , , cl] of rows) {
        const prev = points[points.length - 1];
        if (prev && prev[0] === t) prev[1] = o; else points.push([t, o, null]);
        points.push([t + interval, cl, null]);
      }
      return { ...base, kind: "line", points, candles: rows, first: rows[0][1], last: rows[rows.length - 1][4], empty: null };
    }
    const l = a.line && typeof a.line === "object" ? a.line : null;
    const interval = INTERVALS[l && l.interval] || 600;
    const mult = unit === "MCAP" ? supply : 1;
    const points = (l && Array.isArray(l.points) ? l.points : [])
      .filter((p) => Array.isArray(p) && Number.isSafeInteger(p[0]))
      .map((p) => [p[0], isNum(p[1]) && p[1] > 0 && isNum(mult) && mult > 0 ? p[1] * mult : null, typeof p[2] === "string" && SRC_WORDS[p[2]] ? p[2] : null])
      .sort((x, y) => x[0] - y[0]);
    const vals = points.filter((p) => p[1] != null);
    const base = { kind: "line", unit: unit === "MCAP" ? "MCAP" : "USD", interval, candles: [], source: (l && typeof l.source === "string" && l.source) || "vicinity.city samples", gapWord: "no reading",
      recordingSince: l && typeof l.recordingSince === "string" ? l.recordingSince : null, note: null };
    if (unit === "MCAP" && !(supply > 0)) return { ...base, points: [], first: null, last: null, empty: "The supply is not known to be fixed, so no market cap is drawn" };
    if (!vals.length) return { ...base, points: [], first: null, last: null, empty: typeof missing.line === "string" ? missing.line : "No reading in this range" };
    return { ...base, points, first: vals[0][1], last: vals[vals.length - 1][1], empty: null };
  }
  /**
   * The time span shown: the range up to now, but starting at the first point when the history is shorter than the range (the
   * chart then says so: `short` is true). "all" starts at the first point.
   */
  function domainOf(series, range, nowSec) {
    const span = RANGES[range];
    const pts = series && series.points ? series.points : [];
    const firstT = series && series.kind === "candles" && series.candles.length ? series.candles[0][0] : pts.length ? pts[0][0] : null;
    const lastT = series && series.kind === "candles" && series.candles.length ? series.candles[series.candles.length - 1][0] + series.interval : pts.length ? pts[pts.length - 1][0] : null;
    const end = Math.max(nowSec, lastT || 0);
    let start = span ? end - span : firstT != null ? firstT : end - 86400;
    let short = false;
    if (firstT != null && firstT > start + (span || 0) * 0.02) { start = firstT; short = Boolean(span); }
    if (end - start < 600) start = end - 600; // never narrower than 10 minutes
    return { x0: start, x1: end, short, firstT };
  }
  /** The y extent of what is visible in [x0, x1] (candles: lows and highs). [lo, hi] or null. */
  function extentOf(series, x0, x1) {
    let lo = Infinity, hi = -Infinity;
    if (series.kind === "candles") for (const [t, , h, l] of series.candles) { if (t + series.interval < x0 || t > x1) continue; if (l < lo) lo = l; if (h > hi) hi = h; }
    else {
      const p = series.points;
      for (let i = 0; i < p.length; i++) {
        const v = p[i][1]; if (!isNum(v)) continue;
        const inside = p[i][0] >= x0 && p[i][0] <= x1, edge = (p[i + 1] && p[i + 1][0] >= x0 && p[i][0] < x0) || (p[i - 1] && p[i - 1][0] <= x1 && p[i][0] > x1);
        if (!inside && !edge) continue;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }
  /** The value the series had at time t: the last point at or before t (the price stays until the next reading or trade). */
  function valueAt(series, t) {
    const p = series.points;
    let best = null;
    for (let i = 0; i < p.length && p[i][0] <= t; i++) if (isNum(p[i][1])) best = p[i][1];
    return best;
  }

  const pure = { INTERVALS, RANGES, GAP_INTERVALS, zerosOf, shortZeros, decimals, fmtValue, fmtAxis, fmtChange, changePct, niceStep, niceTicks, padRange, scale,
    timeStep, timeTicks, fmtTick, fmtWhen, fmtSpan, nearestIndex, runsOf, seriesFrom, domainOf, extentOf, valueAt, SRC_WORDS };
  window.VChart = { pure };
  if (typeof document === "undefined") return; // node: the helpers are enough

  /* =====================================================================
     The canvas
     ===================================================================== */
  const reducedNow = () => (window.V ? window.V.reduced : window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const css = (el, name, fallback) => (getComputedStyle(el).getPropertyValue(name) || "").trim() || fallback;
  const alpha = (color, a) => {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (m) { const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
    const r = /^rgba?\(([^)]+)\)$/.exec(color);
    if (r) { const [x, y, z] = r[1].split(",").map((s) => s.trim()); return `rgba(${x},${y},${z},${a})`; }
    return color;
  };

  /**
   * create(canvas, { onScrub, tz }) → { set(series, { range, nowSec, animate: "reveal" | "ping" | false }), clear(), redraw(), destroy() }
   * onScrub({ t, v, src, candle, index, first, series }) while the crosshair is on a point, onScrub(null) when it lets go.
   */
  function create(canvas, { onScrub = () => {}, tz } = {}) {
    const ctx = canvas.getContext("2d");
    let S = null, dom = null, range = "7d", W = 0, H = 0, dpr = 1, theme = null;
    let hover = -1, xs = [], scrubbing = false, anim = null, frame = 0;

    function colors() {
      return {
        up: css(canvas, "--up", "#37C29A"), down: css(canvas, "--down", "#FF5A36"), text: css(canvas, "--text", "#EEF2F8"), muted: css(canvas, "--muted", "#93A0B6"),
        faint: css(canvas, "--faint", "#6E7B92"), ink: css(canvas, "--ink", "255,255,255"), halo: css(canvas, "--chart-halo", "rgba(6,12,23,.86)"),
        mono: css(canvas, "--mono", "monospace"), display: css(canvas, "--display", "sans-serif"), pillText: "#06101C",
      };
    }
    function size() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      const w = Math.round(W * dpr), h = Math.round(H * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    /** The plot's box: the price axis sits inside the plot on a phone, in a 64 px column of its own from 720 px. */
    const box = () => { const wide = W >= 720; return { l: 12, r: W - (wide ? 70 : 12), t: 30, b: H - 24, wide }; };

    function draw(reveal = 1, ping = 0) {
      size();
      if (!theme) theme = colors();
      const c = theme;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!S || S.empty || !dom) return;
      const b = box();
      const ext = extentOf(S, dom.x0, dom.x1) || [S.last, S.last];
      const [y0, y1] = padRange(Math.min(ext[0], S.last), Math.max(ext[1], S.last));
      const X = scale(dom.x0, dom.x1, b.l, b.r), Y = scale(y0, y1, b.b, b.t);
      const color = S.last >= S.first ? c.up : c.down;
      // gridlines and the price axis
      const { ticks, step } = niceTicks(y0, y1, 4);
      ctx.font = `10px ${c.mono}`; ctx.textBaseline = "middle";
      ctx.strokeStyle = `rgba(${c.ink},.06)`; ctx.lineWidth = 1;
      for (const v of ticks) { const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(b.l, y); ctx.lineTo(b.wide ? b.r : W - 12, y); ctx.stroke(); }
      // time axis
      const spanSec = dom.x1 - dom.x0, tstep = timeStep(spanSec, b.r - b.l, spanSec > 86400 && spanSec <= 8 * 86400 ? 84 : 64);
      ctx.fillStyle = c.muted; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      for (const t of timeTicks(dom.x0, dom.x1, tstep)) {
        const x = X(t); if (x < b.l + 20 || x > b.r - 20) continue;
        ctx.fillText(fmtTick(t, tstep, spanSec, tz), x, H - 7);
      }
      // the series, revealed from the left during a range change
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, b.l + (b.r - b.l) * reveal, H); ctx.clip();
      if (S.kind === "candles") drawCandles(S, X, Y, b, c);
      else drawLine(S, X, Y, b, color);
      ctx.restore();
      // the last value: a dashed line across, a pill at the right edge
      const ly = Math.round(Y(S.last)) + 0.5;
      ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = alpha(color, 0.7); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(b.l, ly); ctx.lineTo(b.r, ly); ctx.stroke(); ctx.restore();
      // axis labels (inside the plot on a phone, with a halo so the line under them stays readable)
      ctx.font = `10px ${c.mono}`; ctx.textBaseline = "middle"; ctx.textAlign = b.wide ? "left" : "right";
      const ax = b.wide ? b.r + 8 : W - 14;
      for (const v of ticks) {
        const y = Y(v); if (y < b.t - 4 || y > b.b + 4 || Math.abs(y - ly) < 12) continue;
        const text = fmtAxis(v, step, S.unit === "SOL" ? "SOL" : "USD");
        if (!b.wide) { ctx.lineWidth = 3; ctx.strokeStyle = c.halo; ctx.lineJoin = "round"; ctx.strokeText(text, ax, y); }
        ctx.fillStyle = c.muted; ctx.fillText(text, ax, y);
      }
      pill(fmtValue(S.last, S.unit === "SOL" ? "SOL" : "USD", { short: true }), b.wide ? b.r + 4 : W - 12, ly, color, c, b.wide ? "left" : "right");
      // the last point pings after a live update (1.2 s)
      if (ping > 0 && S.kind === "line") {
        const lp = lastPoint(S); if (lp) {
          const x = X(lp[0]), y = Y(lp[1]);
          ctx.beginPath(); ctx.arc(x, y, 4 + 14 * ping, 0, Math.PI * 2); ctx.strokeStyle = alpha(color, 0.6 * (1 - ping)); ctx.lineWidth = 2; ctx.stroke();
        }
      }
      if (S.kind === "line") { const lp = lastPoint(S); if (lp && lp[0] >= dom.x0) { ctx.beginPath(); ctx.arc(X(lp[0]), Y(lp[1]), 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); } }
      // the crosshair
      xs = S.points.map((p) => X(p[0]));
      if (hover >= 0 && hover < S.points.length && reveal >= 1) {
        const p = S.points[hover], x = Math.round(xs[hover]) + 0.5;
        ctx.strokeStyle = `rgba(${c.ink},.45)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, b.t - 6); ctx.lineTo(x, b.b); ctx.stroke();
        if (isNum(p[1])) { ctx.beginPath(); ctx.arc(x, Y(p[1]), 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = c.halo; ctx.stroke(); }
        const label = crossText(S, hover, tz);
        ctx.font = `600 11px ${c.display}`;
        const w = Math.min(W - 8, ctx.measureText(label).width + 16), px = Math.max(4, Math.min(W - 4 - w, x - w / 2));
        ctx.fillStyle = c.halo; roundRect(px, 4, w, 22, 11); ctx.fill();
        ctx.strokeStyle = `rgba(${c.ink},.18)`; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = c.text; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(label, px + 8, 15, w - 16);
      }
    }
    const lastPoint = (s) => { for (let i = s.points.length - 1; i >= 0; i--) if (isNum(s.points[i][1])) return s.points[i]; return null; };
    function roundRect(x, y, w, h, r) {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function pill(text, x, y, fill, c, align) {
      ctx.font = `600 11px ${c.display}`;
      const w = ctx.measureText(text).width + 12, h = 18, px = align === "left" ? x : x - w;
      ctx.fillStyle = fill; roundRect(px, y - h / 2, w, h, 9); ctx.fill();
      ctx.fillStyle = c.pillText; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(text, px + 6, y + 0.5);
    }
    function drawLine(s, X, Y, b, color) {
      const runs = runsOf(s.points, s.interval * GAP_INTERVALS);
      const p = s.points;
      // the fill under every solid run: the line's colour fading to nothing
      const g = ctx.createLinearGradient(0, b.t, 0, b.b);
      g.addColorStop(0, alpha(color, 0.28)); g.addColorStop(1, alpha(color, 0));
      for (const r of runs) {
        if (r.dashed) continue;
        ctx.beginPath(); ctx.moveTo(X(p[r.from][0]), b.b);
        for (let i = r.from; i <= r.to; i++) ctx.lineTo(X(p[i][0]), Y(p[i][1]));
        ctx.lineTo(X(p[r.to][0]), b.b); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      }
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      for (const r of runs) {
        ctx.beginPath(); ctx.setLineDash(r.dashed ? [4, 4] : []);
        ctx.strokeStyle = r.dashed ? alpha(color, 0.55) : color; ctx.lineWidth = r.dashed ? 1.5 : 2;
        ctx.moveTo(X(p[r.from][0]), Y(p[r.from][1]));
        for (let i = r.from + 1; i <= r.to; i++) ctx.lineTo(X(p[i][0]), Y(p[i][1]));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // a lone reading (no neighbour to join) is a dot, never a line made up
      for (let i = 0; i < p.length; i++) {
        if (!isNum(p[i][1])) continue;
        const prev = i > 0 && isNum(p[i - 1][1]), next = i < p.length - 1 && isNum(p[i + 1][1]);
        if (!prev && !next) { ctx.beginPath(); ctx.arc(X(p[i][0]), Y(p[i][1]), 2, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
      }
    }
    function drawCandles(s, X, Y, b, c) {
      const wpx = Math.max(1, (X(s.interval) - X(0)) * 0.7);
      for (const [t, o, h, l, cl] of s.candles) {
        const x = X(t + s.interval / 2);
        if (x < b.l - wpx || x > b.r + wpx) continue;
        const col = cl >= o ? c.up : c.down;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(h)); ctx.lineTo(Math.round(x) + 0.5, Y(l)); ctx.stroke();
        const top = Y(Math.max(o, cl)), bot = Y(Math.min(o, cl));
        ctx.fillRect(x - wpx / 2, top, wpx, Math.max(1, bot - top));
      }
    }
    function crossText(s, i, zone) {
      const p = s.points[i], unit = s.unit === "SOL" ? "SOL" : "USD";
      if (s.kind === "candles") {
        const [t, o, h, l, cl] = s.candles[i];
        const f = (v) => fmtValue(v, unit, { short: true });
        return `${fmtWhen(t, s.interval, zone)} · O ${f(o)} H ${f(h)} L ${f(l)} C ${f(cl)} ${fmtChange(changePct(o, cl))}`;
      }
      const gap = i > 0 && p[0] - s.points[i - 1][0] > s.interval * GAP_INTERVALS;
      const v = fmtValue(p[1], unit, { short: true }) + (unit === "SOL" ? " SOL" : "");
      return `${fmtWhen(p[0], s.interval, zone)} · ${v}${gap ? ` · after a stretch with ${s.gapWord}` : ""}`;
    }

    /* ----- motion: a reveal (450 ms) or a ping (1.2 s), frames only while it runs ----- */
    function run(kind) {
      cancelAnimationFrame(frame);
      if (reducedNow() || document.hidden) { anim = null; draw(); return; }
      anim = { kind, t0: null, ms: kind === "reveal" ? 450 : 1200 };
      const step = (now) => {
        if (!anim) return;
        if (anim.t0 === null) anim.t0 = now;
        const k = Math.min(1, (now - anim.t0) / anim.ms), e = 1 - (1 - k) ** 3;
        if (anim.kind === "reveal") draw(e, 0); else draw(1, e);
        if (k < 1) frame = requestAnimationFrame(step); else { anim = null; frame = 0; draw(); }
      };
      frame = requestAnimationFrame(step);
    }

    /* ----- the crosshair ----- */
    function point(i) {
      if (!S || S.empty || i < 0 || i >= S.points.length) { hover = -1; onScrub(null); draw(); return; }
      hover = i; draw();
      const p = S.points[i];
      onScrub({ t: p[0], v: p[1], src: p[2], candle: S.kind === "candles" ? S.candles[i] : null, index: i, first: S.first, series: S });
    }
    const xOf = (ev) => ev.clientX - canvas.getBoundingClientRect().left;
    const at = (ev) => nearestIndex(xs, xOf(ev));
    let touch = null; // { id, x, y, timer, live }
    canvas.addEventListener("pointermove", (ev) => {
      if (ev.pointerType === "mouse" || ev.pointerType === "pen") { point(at(ev)); return; }
      if (!touch || ev.pointerId !== touch.id) return;
      if (!touch.live) {
        const dx = Math.abs(ev.clientX - touch.x), dy = Math.abs(ev.clientY - touch.y);
        if (dy > 8 && dy > dx) { clearTimeout(touch.timer); touch = null; return; } // a vertical swipe: the page scrolls
        if (dx > 8) { touch.live = true; clearTimeout(touch.timer); scrubbing = true; }
      }
      if (touch.live) { ev.preventDefault(); point(at(ev)); }
    });
    canvas.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;
      touch = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, live: false, timer: setTimeout(() => { if (touch) { touch.live = true; scrubbing = true; point(at(ev)); } }, 180) };
    });
    const letGo = (ev) => { if (ev.pointerType === "mouse" || (touch && ev.pointerId === touch.id)) { if (touch) clearTimeout(touch.timer); touch = null; scrubbing = false; point(-1); } };
    canvas.addEventListener("pointerup", letGo);
    canvas.addEventListener("pointercancel", letGo);
    canvas.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") point(-1); });
    canvas.addEventListener("keydown", (ev) => {
      if (!S || S.empty) return;
      const n = S.points.length, i = hover < 0 ? n - 1 : hover;
      const go = { ArrowLeft: Math.max(0, i - 1), ArrowRight: Math.min(n - 1, i + 1), Home: 0, End: n - 1 }[ev.key];
      if (ev.key === "Escape") { point(-1); return; }
      if (go === undefined) return;
      ev.preventDefault(); point(hover < 0 && (ev.key === "ArrowLeft" || ev.key === "ArrowRight") ? n - 1 : go);
    });
    canvas.addEventListener("blur", () => { if (hover >= 0 && !scrubbing) point(-1); });

    const ro = window.ResizeObserver ? new ResizeObserver(() => { if (!anim) draw(); }) : null;
    if (ro) ro.observe(canvas);
    const onTheme = () => { theme = null; draw(); };
    window.addEventListener("vicinity:theme", onTheme);

    return {
      /** Shows a series. animate: "reveal" (a new range or unit), "ping" (a live update of the same view) or false. */
      set(series, { range: r = range, nowSec = Math.floor(Date.now() / 1000), animate = false } = {}) {
        const keep = hover >= 0 && S && series && S.kind === series.kind && S.unit === series.unit ? S.points[hover] && S.points[hover][0] : null;
        S = series; range = r; dom = series && !series.empty ? domainOf(series, r, nowSec) : null;
        hover = -1;
        if (keep != null && S && !S.empty) { const i = S.points.findIndex((p) => p[0] === keep); if (i >= 0) hover = i; }
        if (animate && S && !S.empty) run(animate); else draw();
        return dom;
      },
      clear() { S = null; dom = null; hover = -1; cancelAnimationFrame(frame); anim = null; draw(); },
      redraw() { theme = null; draw(); },
      get scrubbing() { return hover >= 0; },
      destroy() { cancelAnimationFrame(frame); if (ro) ro.disconnect(); window.removeEventListener("vicinity:theme", onTheme); },
    };
  }
  window.VChart.create = create;
})();
