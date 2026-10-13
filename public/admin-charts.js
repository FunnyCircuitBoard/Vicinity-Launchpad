// The admin Overview's charts (window.AdminCharts): plain SVG made with createElementNS, no library and no HTML strings. One series
// per chart (its title names it, so no legend box), one y axis, a hairline grid, 2 px lines with a 10 % wash and an end dot ringed in the
// surface colour, columns and bars at most 24 px thick with a 4 px rounded data end, the last value written at the line's end only.
// Every chart answers a pointer and the keyboard (Left / Right / Home / End move a crosshair, Escape hides it), has an aria-label
// summary, a "Show as table" fold with a real table, and an empty state that says why. Colours come from the site's chart tokens
// (--chart-1, --chart-2; checked with the dataviz validator on the dark and the light card) through classes in admin.css: text never
// wears a series colour. Redrawn only when the plot's width changes.
(() => {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const doc = document;
  let uid = 0;

  const svgEl = (tag, attrs = {}, cls) => {
    const e = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (cls) e.setAttribute("class", cls);
    return e;
  };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const DAY_MS = 86400000;

  /* ---------------------------------------------------------------- numbers and dates */
  const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  /** 0 / 950 / 1.2K / 3.4M: axis ticks and short labels. */
  const compact = (n) => (Math.abs(n) < 1000 ? intFmt.format(n) : compactFmt.format(n));
  /** A US-dollar price with enough digits to show a small one ($0.000421), never more than 4 significant. */
  const usd = (n) => (n == null || !Number.isFinite(n) ? "—" : `$${Number(n).toLocaleString("en-US", n >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 })}`);
  /** "Oct 3" (UTC: the data is per UTC day). */
  const day = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const dayLong = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const dateTime = (t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";

  /** 3 or 4 round tick values from lo to hi (lo itself may be moved down to a round number). */
  function niceTicks(lo, hi, want = 4, whole = false) {
    if (!(hi > lo)) hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
    const raw = (hi - lo) / want;
    const p = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
    if (whole) step = Math.max(1, Math.round(step)); // counts: never a tick between two whole numbers
    const start = Math.floor(lo / step) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
    return ticks;
  }
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------------- the frame every chart shares */
  /**
   * Fills `host` with: head (title, subtitle), the plot (a focusable figure with the SVG, a crosshair and a tooltip), an optional
   * note line, and the table fold. Returns the pieces the chart kinds draw into.
   */
  function frame(host, o) {
    const fig = el("figure", "chart");
    const head = el("figcaption", "chart__head");
    head.append(el("h3", "chart__title", o.title));
    if (o.sub) head.append(el("p", "chart__sub", o.sub));
    const plot = el("div", "chart__plot");
    plot.style.height = `${o.height || 200}px`; // the room is held before the data arrives: nothing below moves
    const tip = el("div", "chart__tip"); tip.hidden = true; tip.setAttribute("aria-hidden", "true");
    const say = el("p", "sr-only"); say.setAttribute("aria-live", "polite"); // what the keyboard's crosshair reads out
    fig.append(head, plot, say);
    if (o.note) { const n = el("p", "chart__note"); if (typeof o.note === "object") n.append(o.note); else n.textContent = o.note; fig.append(n); }
    host.replaceChildren(fig);
    return { fig, plot, tip, say };
  }
  /** "Show as table": the same numbers, readable without the chart. */
  function tableFold(fig, head, rows) {
    const d = el("details", "fold chart__table");
    d.append(el("summary", null, "Show as table"));
    const wrap = el("div", "table-wrap adm-table-wrap");
    const t = el("table", "admin-table");
    const thead = el("thead"), hr = el("tr");
    head.forEach((h, i) => { const th = el("th", i ? "num" : null, h); th.scope = "col"; hr.append(th); });
    thead.append(hr);
    const tb = el("tbody");
    for (const r of rows) { const tr = el("tr"); r.forEach((c, i) => tr.append(el("td", i ? "num" : null, c))); tb.append(tr); }
    t.append(thead, tb); wrap.append(t); d.append(wrap);
    fig.append(d);
  }
  function emptyState(plot, why) {
    plot.classList.add("is-empty");
    plot.replaceChildren(el("p", "chart__empty", why || "No data yet."));
  }
  /** Calls draw(width) now and again whenever the plot's width changes (never for a height change), once per frame at most. */
  function onWidth(plot, draw) {
    let w = 0, queued = 0;
    const go = () => { queued = 0; const nw = Math.round(plot.clientWidth); if (nw && nw !== w) { w = nw; draw(w); } };
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (!queued) queued = window.requestAnimationFrame ? window.requestAnimationFrame(go) : setTimeout(go, 16); }).observe(plot);
    }
    go();
    if (!w) draw(Math.round(plot.clientWidth) || 320); // not laid out yet (a hidden panel): a first drawing at a guess
  }
  /** The tooltip at (x, y) inside the plot, kept inside it. */
  function placeTip(plot, tip, x, y, lines) {
    tip.replaceChildren(...lines.map(([cls, text]) => el("span", cls, text)));
    tip.hidden = false;
    const pw = plot.clientWidth, tw = tip.offsetWidth || 140, th = tip.offsetHeight || 48;
    const left = Math.max(0, Math.min(pw - tw, x - tw / 2));
    const top = y - th - 12 < 0 ? y + 14 : y - th - 12;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  /**
   * Pointer and keyboard for a chart with `n` positions along x: `at(i)` shows position i (crosshair, tooltip) and returns what a screen
   * reader hears; `xs` are the positions' x in the plot; `hide()` clears them.
   */
  function interact(fig, plot, say, n, xs, at, hide) {
    let cur = -1;
    const nearest = (x) => { let best = 0; for (let i = 1; i < n; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i; return best; };
    const off = () => { cur = -1; hide(); };
    plot.onpointermove = (e) => { const r = plot.getBoundingClientRect(); cur = nearest(e.clientX - r.left); at(cur); };
    plot.onpointerdown = plot.onpointermove; // a tap on a phone shows the value too
    plot.onpointerleave = (e) => { if (e.pointerType === "mouse") off(); };
    fig.tabIndex = 0;
    fig.onkeydown = (e) => {
      if (e.target !== fig) return; // the table fold's own keys
      const k = e.key;
      if (k === "Escape") { off(); say.textContent = ""; return; }
      const next = k === "ArrowRight" ? Math.min(n - 1, cur < 0 ? n - 1 : cur + 1) : k === "ArrowLeft" ? Math.max(0, cur < 0 ? n - 1 : cur - 1)
        : k === "Home" ? 0 : k === "End" ? n - 1 : null;
      if (next == null) return;
      e.preventDefault();
      cur = next;
      say.textContent = at(cur);
    };
    fig.onblur = () => { if (!fig.contains(doc.activeElement)) off(); };
  }

  /* ---------------------------------------------------------------- line: a value over time */
  /**
   * line(host, points, o): points [{ t (ms), v }], oldest first. o: title, sub, height, fmt (a value, for the tooltip, the end label and
   * the table), tick (an axis value), zero (start the axis at 0; default true), whole (a count: whole-number ticks only), empty (why there is nothing to draw), when (a point's
   * date for the tooltip and table: "day" or "time"), head (the table's two column names), summary (the chart in words), note.
   */
  function line(host, points, o = {}) {
    const fmt = o.fmt || compact, tick = o.tick || compact, when = o.when === "time" ? dateTime : dayLong;
    const { fig, plot, tip, say } = frame(host, o);
    const pts = (points || []).filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t));
    if (!pts.length) { emptyState(plot, o.empty); return; }
    const svg = svgEl("svg", { role: "img", "aria-label": o.summary || summary(o.title, pts, fmt, when) }, "chart__svg");
    plot.append(svg, tip);
    const H = o.height || 200, mt = 16, mb = 28;
    const vmin = Math.min(...pts.map((p) => p.v)), vmax = Math.max(...pts.map((p) => p.v));
    const zero = o.zero !== false;
    const pad = (vmax - vmin) * 0.12 || Math.abs(vmax) * 0.1 || 1;
    const ticks = niceTicks(zero ? 0 : Math.max(0, vmin - pad), vmax + (zero ? 0 : pad), 3, Boolean(o.whole));
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const labels = ticks.map(tick);
    const ml = Math.max(...labels.map((s) => s.length)) * 7 + 12, mr = 12;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    let xs = [], ys = [];
    const cross = svgEl("line", {}, "chart__cross"), hot = svgEl("circle", { r: 4 }, "chart__dot chart__dot--hot");
    cross.style.display = "none"; hot.style.display = "none";
    const draw = (W) => {
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
      const X = (t) => (t1 === t0 ? ml + (W - ml - mr) / 2 : ml + ((t - t0) / (t1 - t0)) * (W - ml - mr));
      const Y = (v) => mt + (1 - (v - y0) / (y1 - y0 || 1)) * (H - mt - mb);
      xs = pts.map((p) => X(p.t)); ys = pts.map((p) => Y(p.v));
      const parts = [];
      // grid and y ticks
      ticks.forEach((v, i) => {
        parts.push(svgEl("line", { x1: ml, x2: W - mr, y1: Y(v), y2: Y(v) }, "chart__grid"));
        const tx = svgEl("text", { x: ml - 8, y: Y(v) + 4, "text-anchor": "end" }, "chart__tick"); tx.textContent = labels[i]; parts.push(tx);
      });
      // x ticks: up to 4 dates, evenly spread, never overlapping
      const room = Math.max(1, Math.floor((W - ml - mr) / 72));
      const nx = Math.min(pts.length, room, 4);
      const seen = new Set();
      for (let k = 0; k < nx; k++) {
        const i = nx === 1 ? pts.length - 1 : Math.round((k * (pts.length - 1)) / (nx - 1));
        if (seen.has(i)) continue; seen.add(i);
        const anchor = nx === 1 ? "middle" : k === 0 ? "start" : k === nx - 1 ? "end" : "middle";
        const tx = svgEl("text", { x: xs[i], y: H - 8, "text-anchor": anchor }, "chart__tick"); tx.textContent = day(pts[i].t); parts.push(tx);
      }
      // the wash under the line, the line, the end dot and its value
      const id = `chart-wash-${++uid}`;
      const defs = svgEl("defs"), grad = svgEl("linearGradient", { id, x1: 0, x2: 0, y1: 0, y2: 1 });
      grad.append(svgEl("stop", { offset: "0" }, "chart__stop chart__stop--top"), svgEl("stop", { offset: "1" }, "chart__stop chart__stop--bottom"));
      defs.append(grad); parts.push(defs);
      const d = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join("");
      if (pts.length > 1) {
        parts.push(svgEl("path", { d: `${d}L${xs[xs.length - 1].toFixed(1)},${Y(y0).toFixed(1)}L${xs[0].toFixed(1)},${Y(y0).toFixed(1)}Z`, fill: `url(#${id})` }, "chart__area"));
        parts.push(svgEl("path", { d }, "chart__line"));
      }
      const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
      parts.push(svgEl("circle", { cx: lx, cy: ly, r: 4 }, "chart__dot"));
      const end = svgEl("text", { x: lx - 8, y: ly < mt + 18 ? ly + 18 : ly - 10, "text-anchor": "end" }, "chart__end");
      end.textContent = o.endLabel ? o.endLabel(pts[pts.length - 1].v) : fmt(pts[pts.length - 1].v);
      parts.push(end);
      cross.setAttribute("y1", mt); cross.setAttribute("y2", H - mb);
      svg.replaceChildren(...parts, cross, hot);
    };
    onWidth(plot, draw);
    const show = (i) => {
      const x = xs[i], y = ys[i];
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.style.display = "";
      hot.setAttribute("cx", x); hot.setAttribute("cy", y); hot.style.display = "";
      placeTip(plot, tip, x, y, [["chart__tip-v", fmt(pts[i].v)], ["chart__tip-k", when(pts[i].t)]]);
      return `${when(pts[i].t)}: ${fmt(pts[i].v)}`;
    };
    const hide = () => { cross.style.display = "none"; hot.style.display = "none"; tip.hidden = true; };
    bindLive(fig, plot, say, () => xs, pts.length, show, hide);
    if (o.head) tableFold(fig, o.head, pts.map((p) => [when(p.t), fmt(p.v)]));
  }
  /** interact() with x positions read fresh at each event (the chart redraws when its width changes). */
  function bindLive(fig, plot, say, getXs, n, show, hide) {
    const xsProxy = new Proxy([], { get: (_, k) => (k === "length" ? getXs().length : getXs()[k]) });
    interact(fig, plot, say, n, xsProxy, show, hide);
  }
  function summary(title, pts, fmt, when) {
    const first = pts[0], last = pts[pts.length - 1];
    const hi = pts.reduce((a, b) => (b.v > a.v ? b : a)), lo = pts.reduce((a, b) => (b.v < a.v ? b : a));
    return pts.length === 1 ? `${title}: ${fmt(last.v)} on ${when(last.t)}.`
      : `${title}: ${fmt(first.v)} on ${when(first.t)}, ${fmt(last.v)} on ${when(last.t)}. Highest ${fmt(hi.v)}, lowest ${fmt(lo.v)}.`;
  }

  /* ---------------------------------------------------------------- columns: a count per day */
  /** columns(host, rows, o): rows [{ t (ms, a UTC day), v }], one per day, oldest first (zeros included). o as for line. */
  function columns(host, rows, o = {}) {
    const fmt = o.fmt || ((v) => intFmt.format(v));
    const { fig, plot, tip, say } = frame(host, o);
    const data = (rows || []).filter((r) => Number.isFinite(r.v));
    if (!data.length || data.every((r) => r.v === 0) && o.emptyWhenZero) { emptyState(plot, o.empty); return; }
    const total = data.reduce((s, r) => s + r.v, 0), max = data.reduce((a, b) => (b.v > a.v ? b : a));
    const svg = svgEl("svg", { role: "img", "aria-label": o.summary || `${o.title}: ${fmt(total)} in ${data.length} days; the most in one day ${fmt(max.v)} on ${dayLong(max.t)}.` }, "chart__svg");
    plot.append(svg, tip);
    const H = o.height || 200, mt = 16, mb = 28;
    const ticks = niceTicks(0, Math.max(1, max.v), 3, true), y1 = ticks[ticks.length - 1];
    const labels = ticks.map(compact);
    const ml = Math.max(...labels.map((s) => s.length)) * 7 + 12, mr = 4;
    let xs = [], bw = 0;
    const band = svgEl("rect", { rx: 4 }, "chart__band"); band.style.display = "none";
    let marks = [];
    const draw = (W) => {
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
      const Y = (v) => mt + (1 - v / y1) * (H - mt - mb);
      const slot = (W - ml - mr) / data.length;
      bw = Math.max(1, Math.min(24, slot - 2)); // at most 24 px, a 2 px surface gap between neighbours
      xs = data.map((_, i) => ml + slot * i + slot / 2);
      const parts = [];
      ticks.forEach((v, i) => {
        parts.push(svgEl("line", { x1: ml, x2: W - mr, y1: Y(v), y2: Y(v) }, "chart__grid"));
        const tx = svgEl("text", { x: ml - 8, y: Y(v) + 4, "text-anchor": "end" }, "chart__tick"); tx.textContent = labels[i]; parts.push(tx);
      });
      band.setAttribute("y", mt - 6); band.setAttribute("height", H - mt - mb + 6); band.setAttribute("width", Math.max(slot, 6));
      parts.push(band);
      const base = Y(0), r = Math.min(4, bw / 2);
      marks = data.map((d, i) => {
        if (!d.v) return null;
        const x = xs[i] - bw / 2, y = Y(d.v), h = base - y;
        const rr = Math.min(r, h);
        // square at the baseline, rounded at the data end
        const p = svgEl("path", { d: `M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + bw - rr}Q${x + bw},${y} ${x + bw},${y + rr}V${base}Z` }, "chart__col");
        parts.push(p);
        return p;
      });
      const room = Math.max(1, Math.floor((W - ml - mr) / 72)), nx = Math.min(data.length, room, 4);
      for (let k = 0; k < nx; k++) {
        const i = nx === 1 ? data.length - 1 : Math.round((k * (data.length - 1)) / (nx - 1));
        const anchor = nx === 1 ? "middle" : k === 0 ? "start" : k === nx - 1 ? "end" : "middle";
        const tx = svgEl("text", { x: k === 0 && nx > 1 ? xs[i] - bw / 2 : k === nx - 1 && nx > 1 ? xs[i] + bw / 2 : xs[i], y: H - 8, "text-anchor": anchor }, "chart__tick");
        tx.textContent = day(data[i].t); parts.push(tx);
      }
      svg.replaceChildren(...parts);
    };
    onWidth(plot, draw);
    let lit = null;
    const show = (i) => {
      const slot = xs.length > 1 ? xs[1] - xs[0] : Math.max(bw, 6);
      band.setAttribute("x", xs[i] - Math.max(slot, 6) / 2); band.style.display = "";
      if (lit) lit.classList.remove("is-hot");
      lit = marks[i]; if (lit) lit.classList.add("is-hot");
      placeTip(plot, tip, xs[i], 24, [["chart__tip-v", fmt(data[i].v)], ["chart__tip-k", dayLong(data[i].t)]]);
      return `${dayLong(data[i].t)}: ${fmt(data[i].v)}`;
    };
    const hide = () => { band.style.display = "none"; tip.hidden = true; if (lit) lit.classList.remove("is-hot"); lit = null; };
    bindLive(fig, plot, say, () => xs, data.length, show, hide);
    if (o.head) tableFold(fig, o.head, data.map((d) => [dayLong(d.t), fmt(d.v)]));
  }

  /* ---------------------------------------------------------------- bars: a count per category, largest first */
  /** bars(host, rows, o): rows [{ label, v }] in the order to draw (the caller sorts and folds the tail into "Other"). */
  function bars(host, rows, o = {}) {
    const fmt = o.fmt || ((v) => intFmt.format(v));
    const data = (rows || []).filter((r) => Number.isFinite(r.v));
    const rowH = 32;
    const { fig, plot, tip, say } = frame(host, { ...o, height: data.length ? data.length * rowH + 8 : o.minHeight || o.height || 200 });
    if (!data.length) { emptyState(plot, o.empty); return; }
    const total = data.reduce((s, r) => s + r.v, 0);
    const svg = svgEl("svg", { role: "img", "aria-label": o.summary || `${o.title}: ${data.slice(0, 3).map((r) => `${r.label} ${fmt(r.v)}`).join(", ")}${data.length > 3 ? `, and ${data.length - 3} more` : ""}; ${fmt(total)} in all.` }, "chart__svg");
    plot.append(svg, tip);
    const H = data.length * rowH + 8, max = Math.max(...data.map((r) => r.v), 1);
    let ys = [];
    let marks = [];
    const draw = (W) => {
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
      const lw = Math.min(Math.round(W * 0.38), Math.max(...data.map((r) => r.label.length)) * 7 + 12);
      const vw = Math.max(...data.map((r) => fmt(r.v).length)) * 7 + 12;
      const span = Math.max(8, W - lw - vw - 4), bh = 16;
      ys = data.map((_, i) => 4 + i * rowH + rowH / 2);
      const parts = [svgEl("line", { x1: lw, x2: lw, y1: 4, y2: H - 4 }, "chart__grid")];
      marks = data.map((r, i) => {
        const w = Math.max(2, (r.v / max) * span), y = ys[i] - bh / 2, x = lw, rr = Math.min(4, w / 2);
        const name = svgEl("text", { x: lw - 10, y: ys[i] + 4, "text-anchor": "end" }, "chart__cat");
        name.textContent = r.label.length * 7 + 12 > lw ? `${r.label.slice(0, Math.max(3, Math.floor((lw - 24) / 7)))}…` : r.label;
        const p = svgEl("path", { d: `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + bh - rr}Q${x + w},${y + bh} ${x + w - rr},${y + bh}H${x}Z` }, "chart__bar");
        const v = svgEl("text", { x: x + w + 8, y: ys[i] + 4 }, "chart__val"); v.textContent = fmt(r.v);
        parts.push(name, p, v);
        return p;
      });
      svg.replaceChildren(...parts);
    };
    onWidth(plot, draw);
    // rows sit one under the other: the pointer's y picks the row (each row's hit area is its whole 32 px band)
    let lit = null;
    const show = (i) => {
      if (lit) lit.classList.remove("is-hot");
      lit = marks[i]; if (lit) lit.classList.add("is-hot");
      placeTip(plot, tip, plot.clientWidth / 2, ys[i] - 8, [["chart__tip-v", fmt(data[i].v)], ["chart__tip-k", `${data[i].label} · ${Math.round((data[i].v / total) * 100)}%`]]);
      return `${data[i].label}: ${fmt(data[i].v)}`;
    };
    const hide = () => { tip.hidden = true; if (lit) lit.classList.remove("is-hot"); lit = null; };
    bindLive(fig, plot, say, () => ys, data.length, show, hide);
    plot.onpointermove = (e) => { const r = plot.getBoundingClientRect(); const yy = e.clientY - r.top; let best = 0; ys.forEach((y, i) => { if (Math.abs(y - yy) < Math.abs(ys[best] - yy)) best = i; }); show(best); };
    plot.onpointerdown = plot.onpointermove;
    if (o.head) tableFold(fig, o.head, data.map((r) => [r.label, fmt(r.v)]));
  }

  /* ---------------------------------------------------------------- the sparkline of a metric card */
  /** spark(values): a small decorative line (the card states the number): history in --chart-2 at 60 %, the last point in --chart-1. */
  function spark(values) {
    const v = (values || []).filter(Number.isFinite);
    if (v.length < 2) return null;
    const W = 120, H = 32, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const X = (i) => 2 + (i / (v.length - 1)) * (W - 6), Y = (x) => 4 + (1 - (x - lo) / span) * (H - 8);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true", focusable: "false" }, "adm-spark");
    svg.append(svgEl("path", { d: v.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(x).toFixed(1)}`).join("") }, "adm-spark__line"));
    svg.append(svgEl("circle", { cx: X(v.length - 1), cy: Y(v[v.length - 1]), r: 2.5 }, "adm-spark__end"));
    return svg;
  }

  window.AdminCharts = { line, columns, bars, spark, compact, usd, day, dayLong, DAY_MS, reduced };
})();
