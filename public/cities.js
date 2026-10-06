// Vicinity: the city map on /cities. Claimed vs open cities, live. Claiming itself happens in the dashboard.
// No trackers, nothing loaded from other sites. Needs site.js (window.V) and ticker.js (window.vicinityTicker).
//
// The map (the owner, 6 Oct 2026: "city boundaries without any zoom, no tapping required for a city on mobile to see its stats"):
// * every city's boundary from the first view: /data/bounds-overview.txt (scripts/boundaries/overview.mjs, ~190 KB gzipped) is
//   drawn below zoom 5; the detailed per-country files take over from there, cross-fading over zoom 4.5–5.5, a country at a time
//   as each file arrives, so there is never a blank moment;
// * the stats show without a tap: chips on the map (name, status, ticker; the founder amount closer in) and the "city in focus"
//   card at the bottom of the map, for the city under the crosshair, which follows the map as it moves;
// * three canvases: the base (graticule, land, borders, boundaries, dots: drawn when the view changes; below zoom 1.6 the land, the
//   borders and the boundaries come from one picture of the world built in idle time; during a gesture at most every 100 ms, or
//   three times what the last drawing took, the compositor moving the last drawing in between), the glow layer (status glow and
//   rings: at most 30 frames a second, only while something that moves is on screen, the tab is visible and motion is welcome, and
//   only for 6 s after the last thing that happened: then it rests on a still frame that breathes through CSS) and the label layer
//   (chips, crosshair: when the view changes).
(() => {
  "use strict";
  const sec = document.getElementById("cities");
  if (!sec) return;
  const $ = (s, r = document) => r.querySelector(s);
  const V = () => window.V || {};
  // less motion: the device asks for it, or the visitor pressed "Pause animations" (footer, theme.js); both can change while the page is open
  const stillNow = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "paused";
  let reduced = stillNow();
  const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // Wallets are shown as first 5 + ***** + last 3. Founder wallets arrive from /api/seats already masked: the map
  // never has a founder's full address, so it links nobody's wallet to a block explorer.
  const mask = (a) => (a && a.length > 10 ? `${a.slice(0, 5)}*****${a.slice(-3)}` : a || "");
  const solscan = (a) => { const l = el("a", "mono", mask(a)); l.href = `https://solscan.io/account/${a}`; l.target = "_blank"; l.rel = "noopener"; l.title = "Check this wallet on Solscan"; return l; };
  const walletText = (a) => el("span", "mono", a || "");
  // Is this seat the signed-in person's? The seat's wallet is masked, so compare the masked forms.
  const isMine = (cl) => Boolean(cl && me() && (cl.wallet === me() || cl.wallet === mask(me())));
  const norm = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}]+/gu, "");
  const kmBetween = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(x))); };
  const radiusOf = (c) => ((c.pop || 0) >= 1_000_000 ? 50 : 25);
  const ago = (iso) => { const s = Math.max(1, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
  // The founder amount: the Stake Ladder of src/policy.js (founderAmount), 100K × (population ÷ 10K)^(1/3), clamped to 100K–1M and
  // rounded down to 10K, held for qualifyingDays. The numbers come from /api/policy once the page loads (one request, not one per
  // city, and the map never waits for it); until then, and if that answer fails, these are the published ones (POLICY.founder.ladder / qualifyingDays).
  let ladder = { base: 100_000, max: 1_000_000, refPop: 10_000, rung: 10_000 }, qualifyingDays = 7;
  const ladderAmount = (pop, l) => Math.floor(Math.min(l.max, Math.max(l.base, l.base * Math.cbrt(Math.max(pop || 0, 1) / l.refPop))) / l.rung) * l.rung;
  /** What the next founder of this city must hold: the bar its open window was opened with (/api/seats sends it), otherwise the ladder for its population. A sitting founder's own bar is not shown: /api/seats doesn't send it, and this line is about becoming the founder. */
  const founderMin = (c, win) => (win && win.threshold > 0 ? win.threshold : ladderAmount(c.pop, ladder));
  const short = (n) => Number(n).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 }); // 180,000 → 180K · 1,000,000 → 1M

  /* map helpers: start (pure functions, no page: test/map-overview.test.js runs this block on its own) */
  const OV_UNIT = 0.05; // the overview file's grid: 1/20 degree
  const AREA_K = 5;     // the detailed boundaries take over from this zoom (cross-fading from 4.5 to 5.5)
  /** One line of /data/bounds-overview.txt → { id, kind, km2, rings: [Int16Array [x0, y0, x1, y1, …] in grid units], box: [w, s, e, n] in degrees }, or null. */
  function parseOverviewLine(line) {
    if (!line || line[0] === "#") return null;
    const [id, kind, km, json] = line.split("\t");
    if (!json || (kind !== "r" && kind !== "n")) return null;
    let w = 1e9, s = 1e9, e = -1e9, n = -1e9;
    const rings = JSON.parse(json).map((flat) => {
      const r = new Int16Array(flat.length);
      let x = 0, y = 0;
      for (let i = 0; i < flat.length; i += 2) {
        x += flat[i]; y += flat[i + 1]; r[i] = x; r[i + 1] = y;
        if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
      }
      return r;
    });
    return { id, kind, km2: Number(km), rings, box: [w * OV_UNIT, s * OV_UNIT, e * OV_UNIT, n * OV_UNIT] };
  }
  /** Is the point (degrees) inside one of the area's overview rings? (the overview keeps outer rings only) */
  function inOverview(lon, lat, a) {
    const x = lon / OV_UNIT, y = lat / OV_UNIT;
    for (const r of a.rings) {
      let inside = false;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }
  /** The points of a ring worth drawing when `d` grid units are about a pixel: a point closer than d to the last kept one is skipped. Never fewer than 3 (every city keeps an outline). */
  function thinRing(r, d) {
    if (d <= 1 || r.length <= 8) return r;
    const out = [r[0], r[1]];
    let lx = r[0], ly = r[1];
    for (let i = 2; i < r.length; i += 2) {
      if (Math.abs(r[i] - lx) >= d || Math.abs(r[i + 1] - ly) >= d) { out.push(r[i], r[i + 1]); lx = r[i]; ly = r[i + 1]; }
    }
    return out.length >= 6 ? out : r;
  }
  /** Grid units skipped per drawn point at this many pixels per degree (the overview is drawn with about one point per pixel). */
  const thinFor = (pxPerDeg) => { const g = pxPerDeg * OV_UNIT; return g < 0.25 ? 4 : g < 0.5 ? 2 : 1; };
  /** Where the map opens when it has no city to show: the visitor's part of the world, from the time zone alone (no location, no network). */
  function openingView(tz) {
    const z = String(tz || "");
    if (z.startsWith("America/")) return [-95, 38];
    if (z.startsWith("Europe/")) return [15, 50];
    if (z.startsWith("Africa/")) return [20, 5];
    if (z.startsWith("Asia/")) return [100, 25];
    if (z.startsWith("Australia/") || z.startsWith("Pacific/")) return [135, -25];
    return [10, 20];
  }
  /** The scale bar: the longest round distance (1, 2 or 5 × 10ⁿ km) that fits in maxPx at this many pixels per km. */
  function scaleBar(pxPerKm, maxPx = 96) {
    if (!(pxPerKm > 0)) return null;
    const raw = maxPx / pxPerKm, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const km = [5, 2, 1].map((m) => m * p).find((v) => v <= raw) || p;
    const text = km >= 1 ? `${km.toLocaleString("en-US")} km` : `${Math.round(km * 1000).toLocaleString("en-US")} m`;
    return { km, px: Math.round(km * pxPerKm), text };
  }
  /** A fly-to: how long (ms, ease in-out) and how far out the zoom dips on a long trip (null: no dip). */
  function flightPlan(k0, k1, distDeg) {
    const ms = Math.round(Math.min(1600, Math.max(600, 450 + 260 * Math.abs(Math.log2(k1 / k0)) + 3 * distDeg)));
    return { ms, dip: distDeg > 25 ? Math.max(1, Math.min(k0, k1) / 2.5) : null };
  }
  /**
   * The zoom of a fly-to at eased time e (0…1): from k0 to k1 in log space, pulled out toward `dip` mid-way on a long trip. Never
   * below the dip, never below the whole world (1) nor above maxK: a flight from the world view used to sink to 0.65× and a touch
   * mid-flight froze it there (the world shrank into a corner).
   */
  function flyK(k0, k1, dip, e, maxK = 900) {
    let lk = Math.log(k0) + (Math.log(k1) - Math.log(k0)) * e;
    if (dip) { const mid = (Math.log(k0) + Math.log(k1)) / 2, depth = Math.max(0, mid - Math.log(dip)); lk = Math.max(Math.log(dip), lk - depth * 4 * e * (1 - e)); }
    return Math.min(maxK, Math.max(1, Math.exp(lk)));
  }
  /** Label priority, smaller first: yours, selected, in focus, founded (by holders), choosing (by applicants), members, population. Shown last time: ahead of its own tier (no flicker). */
  function labelRank(x) {
    const tier = x.mine ? 1 : x.selected ? 2 : x.focus ? 3 : x.status === "founded" ? 4 : x.status === "choosing" ? 5 : x.members > 0 ? 6 : 7;
    const metric = tier === 4 ? x.holders || 0 : tier === 5 ? x.applicants || 0 : tier === 6 ? x.members : x.pop || 0;
    return [tier - (x.shown ? 0.5 : 0), -metric];
  }
  const byRank = (a, b) => { const p = labelRank(a), q = labelRank(b); return p[0] - q[0] || p[1] - q[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); };
  /**
   * Greedy placement of chips and labels, in priority order (sort with byRank first). Each item: { id, x, y (marker, px), tierWish: "A"|"B"|"C",
   * size: { A: [w, h], B: [w, h], C: [w, h] } }. A chip tries the right of its marker, then the left, above and below, then the same a little
   * farther out (with a leader line); a B chip that fits nowhere tries again as a plain name (C). Boxes keep 4 px apart and stay out of the
   * `avoid` rectangles ([x, y, w, h]: controls, the focus card) and 6 px inside the map; `soft` ones (the room around the crosshair) are
   * avoided by every chip but the one of the city in focus (item.focus), which sits right by it; `core` ones (the crosshair's own ring
   * and ticks) are covered by no chip at all, the focus chip included. Deterministic.
   * Returns [{ id, tier, x, y, w, h, ax, ay, leader }] (x, y: the box's top left).
   */
  function placeLabels(items, { W, H, avoid = [], soft = [], core = [], max = { A: 3, B: 10, C: 20 }, pad = 4, edge = 6 }) {
    const CELL = 64, grid = new Map(), out = [], used = { A: 0, B: 0, C: 0 };
    const cells = (x, y, w, h, f) => { for (let i = Math.floor(x / CELL); i <= Math.floor((x + w) / CELL); i++) for (let j = Math.floor(y / CELL); j <= Math.floor((y + h) / CELL); j++) f(i + "," + j); };
    const hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    const free = (bx, focus) => {
      if (bx[0] < edge || bx[1] < edge || bx[0] + bx[2] > W - edge || bx[1] + bx[3] > H - edge) return false;
      const p = [bx[0] - pad, bx[1] - pad, bx[2] + 2 * pad, bx[3] + 2 * pad];
      if (avoid.some((r) => hit(p, r)) || (!focus && soft.some((r) => hit(p, r))) || core.some((r) => hit(bx, r))) return false;
      let ok = true;
      cells(p[0], p[1], p[2], p[3], (key) => { if (ok) for (const o of grid.get(key) || []) if (hit(p, o)) { ok = false; break; } });
      return ok;
    };
    const spots = (x, y, w, h, far) => {
      const g = far ? 22 : 8;
      return [[x + g, y - h / 2], [x - g - w, y - h / 2], [x - w / 2, y - g - h], [x - w / 2, y + g]];
    };
    for (const it of items) {
      if (used.A >= (max.A ?? 0) && used.B >= (max.B ?? 0) && used.C >= (max.C ?? 0)) break; // every slot is taken
      const tiers = it.tierWish === "A" ? ["A"] : it.tierWish === "B" ? ["B", "C"] : ["C"];
      for (const tier of tiers) {
        if (used[tier] >= (max[tier] ?? 0) || !it.size[tier]) continue;
        const [w, h] = it.size[tier];
        let at = null, leader = false;
        for (const far of tier === "C" ? [false] : [false, true]) {
          for (const [bx, by] of spots(it.x, it.y, w, h, far)) { const b = [Math.round(bx), Math.round(by), w, h]; if (free(b, it.focus)) { at = b; leader = far; break; } }
          if (at) break;
        }
        if (!at) continue;
        used[tier]++;
        out.push({ id: it.id, tier, x: at[0], y: at[1], w, h, ax: it.x, ay: it.y, leader });
        cells(at[0], at[1], w, h, (key) => { (grid.get(key) || grid.set(key, []).get(key)).push(at); });
        break;
      }
    }
    return out;
  }
  /**
   * The city in focus: the area under the crosshair (from zoom 2: `inside`), else the nearest shown city within `radius` px. The current
   * one stays unless another is at least `keep` px closer (no flicker while panning). cands: [{ id, d }] (d: px from the crosshair).
   */
  function chooseFocus(cands, inside, current, radius = 56, keep = 8) {
    if (inside) return inside;
    let best = null;
    for (const c of cands) if (c.d <= radius && (!best || c.d < best.d || (c.d === best.d && c.id < best.id))) best = c;
    const cur = current != null ? cands.find((c) => c.id === current) : null;
    if (cur && cur.d <= radius && (!best || best.d > cur.d - keep)) return current;
    return best ? best.id : null;
  }
  /**
   * The city the card opens on when no link, pick or home city says which: the one nearest the crosshair (fx, fy), a bigger one
   * first at the same distance. cands: [{ id, x, y, pop }] (px). The map then centres on it, so the card and the crosshair agree
   * from the first view (it used to show the biggest city in view, up to 480 px away from the crosshair). null: no candidate.
   */
  function openingFocus(cands, fx, fy) {
    let best = null, bd = Infinity;
    for (const c of cands) {
      const d = Math.hypot(c.x - fx, c.y - fy);
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best && ((c.pop || 0) > (best.pop || 0) || ((c.pop || 0) === (best.pop || 0) && c.id < best.id)))) { best = c; bd = d; }
    }
    return best ? best.id : null;
  }
  /** "1d 4h", "3h 20m", "12m": how long until an ISO time (a window's close). */
  function until(iso, now) {
    const s = Math.max(0, (Date.parse(iso) - now) / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }
  /* map helpers: end */

  const canvas = $("#city-canvas"), ctx = canvas.getContext("2d"), tip = $("#city-tip"), wrapEl = $(".citymap__stage");
  const fxCanvas = $("#city-fx"), fctx = fxCanvas.getContext("2d"), labCanvas = $("#city-labels"), lctx = labCanvas.getContext("2d");
  const listEl = $("#city-list"), qEl = $("#city-q"), countryEl = $("#city-country"), filterEl = $("#city-filter");
  const btn = $("#claim-btn");
  let cities = [], byId = new Map(), countries = {}, admin = {}, claims = new Map(), tickers = new Map(), open = false, loaded = false;
  let selected = null, mode = "claim", memberCount = new Map(), holderCount = new Map(), totalMembers = 0, membersKnown = false;
  // the signed-in person's wallet (to show "Yours"), from site.js
  const me = () => V().me?.()?.user?.wallet || null;
  const myHome = () => V().me?.()?.user?.home?.id || null;

  const placeOf = (c) => [admin[`${c.cc}.${c.adm}`], countries[c.cc] || c.cc].filter(Boolean).join(", ");

  /* =================== the map =================== */
  // World → screen: equirectangular, latitude 84°N … 60°S. view: zoom k, offset tx/ty (CSS px).
  // s0 = pixels per degree at zoom 1, chosen so the world always fills the map box (wide screens and phones).
  // Shapes are Path2D objects in "degree space" (x = lon + 180, y = 84 − lat), drawn with a single transform.
  let W = 0, H = 0, s0 = 1, dpr = 1, k = 1, tx = 0, ty = 0, hover = null, hoverCountry = null, onScreen = false, raf = 0;
  const ripples = [];
  const wx = (lon) => (lon + 180) * s0;
  const wy = (lat) => (84 - lat) * s0;
  const sx = (lon) => wx(lon) * k + tx;
  const sy = (lat) => wy(lat) * k + ty;
  const clampView = () => { tx = Math.min(0, Math.max(W - 360 * s0 * k, tx)); ty = Math.min(0, Math.max(H - 144 * s0 * k, ty)); };
  const canPan = () => 360 * s0 * k > W + 1 || 144 * s0 * k > H + 1;
  const MAXK = 900;
  // What needs drawing: the base (expensive: only when the view changed), the labels (chips, crosshair), the glow layer.
  const dirty = { base: true, labels: true, layout: true, focus: true, fx: true };
  let moving = false, crispTimer = 0, lastCrisp = 0, lastLayout = 0, lastFocusAt = 0, lastFx = 0;

  // colours come from the theme (style.css --map-* and --st-*), so the map follows the dark / light toggle
  let pal = {}, sprites = {};
  const rgbOf = (hex) => { const h = hex.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)].join(","); };
  function readPalette() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const light = document.documentElement.dataset.theme === "light";
    const st = (n, d) => rgbOf(v(n) || d);
    pal = { light, land: v("--map-land"), landLine: v("--map-land-line"), area: v("--map-area"), areaLine: v("--map-area-line"), dot: v("--map-dot"), label: v("--map-label"), halo: v("--map-halo"),
      hoverFill: light ? "rgba(43,91,255,.14)" : "rgba(127,163,214,.2)", claimedText: light ? "#C23A1C" : "#FFB39C",
      tagBg: light ? "rgba(255,255,255,.95)" : "rgba(7,14,25,.9)", tagText: light ? "#8A5A00" : "#FFE3A3", grid: light ? "rgba(11,22,38,.06)" : "rgba(149,162,184,.07)",
      // status colours (rgb triplets, for rgba()), the chips' background and texts
      open: st("--st-open", light ? "#3F67A6" : "#7FA3D6"), choosing: st("--st-choosing", light ? "#B57F00" : "#FFC857"), founded: st("--st-founded", light ? "#E8431F" : "#FF5A36"), mine: st("--st-mine", light ? "#D99A1A" : "#FFC857"),
      openLine: light ? "rgba(30,70,160,.3)" : "rgba(160,190,235,.45)", chipBg: v("--chip-bg") || (light ? "rgba(255,255,255,.92)" : "rgba(7,14,25,.82)"),
      goldText: v("--gold-text") || (light ? "#8A5A00" : "#FFE3A3"), foundedText: light ? "#C23A1C" : "#FFB39C", choosingText: light ? "#8A5A00" : "#FFE3A3", ink: light ? "11,22,38" : "255,255,255",
      a: light ? 0.8 : 1 };
    sprites = {};
    for (const s of ["open", "choosing", "founded", "mine"]) sprites[s] = glowSprite(pal[s]);
    buildOvCache();
    markAll();
  }
  /** One soft glow per status colour, drawn once per theme (never a canvas blur on every frame): .9 in the middle, .35 at 20%, nothing from 50%. */
  function glowSprite(rgb) {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, `rgba(${rgb},.9)`); gr.addColorStop(0.4, `rgba(${rgb},.35)`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return c;
  }
  window.addEventListener("vicinity:theme", () => { if (loaded) readPalette(); });
  const motionChanged = () => { reduced = stillNow(); markAll(); };
  window.addEventListener("vicinity:motion", motionChanged);
  const rmq = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (rmq.addEventListener) rmq.addEventListener("change", motionChanged);

  // ---- map style: the plain map (default) or the coloured one (the 🎨 switch) ----
  let mapStyle = (() => { try { return localStorage.getItem("vicinity-map-style") === "colored" ? "colored" : "plain"; } catch { return "plain"; } })();
  // coloured map: soft colours for countries, brighter ones for city areas; neighbours never share a colour
  const COUNTRY_COLORS = {
    light: ["#f3e7cf", "#dfead0", "#e9dff0", "#f6dfd2", "#d7e8f0", "#ece4c3", "#e0efe3", "#f2dbe1"],
    dark: ["#22344f", "#233b37", "#312d48", "#3b3126", "#1f3b46", "#36361f", "#253f33", "#3c2835"],
  };
  const AREA_COLORS = ["#4cc9f0", "#90be6d", "#f9c74f", "#f8961e", "#f28482", "#b388eb", "#43aa8b", "#ff99c8"];
  const hexA = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  const boxesTouch = (p, q) => p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];
  /** Greedy colouring: each shape takes the first colour that no already-coloured neighbour (touching box) has. */
  function colorize(list, pool, n) {
    for (const it of list) {
      if (it.color != null) continue;
      const used = new Array(n).fill(0);
      for (const o of pool) if (o !== it && o.color != null && boxesTouch(it.box, o.box)) used[o.color]++;
      let best = used.indexOf(0);
      if (best < 0) best = used.indexOf(Math.min(...used));
      it.color = best;
    }
  }

  // ---- geometry (same encoding as src/geo.js) ----
  const decodeRing = (flat, unit) => { const out = new Array(flat.length / 2); let x = 0, y = 0; for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; out[i / 2] = [x * unit, y * unit]; } return out; };
  const inRing = (lon, lat, r) => { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  const inArea = (lon, lat, area) => area.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
  const inBox = (lon, lat, b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
  const boxOf = (area) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [o] of area) for (const [x, y] of o) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } return [a, b, c, d]; };
  const toPath = (area) => { const p = new Path2D(); for (const poly of area) for (const ring of poly) { ring.forEach(([lon, lat], i) => (i ? p.lineTo(lon + 180, 84 - lat) : p.moveTo(lon + 180, 84 - lat))); p.closePath(); } return p; };
  const kmArea = (area) => { let s = 0; for (const poly of area) poly.forEach((r, i) => { let t = 0; for (let a = 0, b = r.length - 1; a < r.length; b = a++) t += (r[b][0] - r[a][0]) * (r[b][1] + r[a][1]); s += (i ? -1 : 1) * Math.abs(t / 2) * 111.32 * Math.cos((r[0][1] * Math.PI) / 180) * 110.57; }); return s; };

  // ---- map data: country outlines + city boundaries (the world-wide overview, then the detailed files one country at a time) ----
  let world = [];                // [{ cc, box, area, path }]
  let boundsIndex = {};          // cc → { box, bytes }
  let boundsList = [];           // [[cc, { box, bytes }], …]
  let parts = new Map();         // neighbourhood id → id of the city it's part of (one coin per big city)
  let members = new Map();       // city id → the listed places that share its coin
  let joined = new Set();        // parts that were just outside the city and got added to its area
  const areas = new Map();       // city id → { kind: "r" official | "n" nearest land, box, area, path, km2 }
  const areasByCC = new Map();   // cc → [detailed areas], for the cross-fade
  const boundsDone = new Set();  // countries whose detailed file is in
  const boundsLoads = new Map(); // cc → Promise
  function loadBounds(cc) {
    if (!boundsIndex[cc]) return Promise.resolve();
    if (!boundsLoads.has(cc)) {
      boundsLoads.set(cc, fetch(`/data/bounds/${cc}.txt`).then((r) => { if (!r.ok) throw new Error("bounds"); return r.text(); }).then((text) => {
        const list = [];
        for (const line of text.split("\n")) {
          const [id, kind, box, json] = line.split("\t");
          if (!json) continue; // "part of" lines carry no shape
          const area = JSON.parse(json).map((poly) => poly.map((r) => decodeRing(r, 1e-4)));
          const a = { id, kind, box: box.split(",").map(Number), area, path: toPath(area), km2: kmArea(area) };
          areas.set(id, a); list.push(a);
        }
        areasByCC.set(cc, list); boundsDone.add(cc);
        colorize([...areas.values()].filter((a) => a.color == null).sort((p, q) => q.km2 - p.km2), [...areas.values()], AREA_COLORS.length);
        markAll();
      }).catch(() => { boundsLoads.delete(cc); }));
    }
    return boundsLoads.get(cc);
  }
  // The overview: every city's outline, simplified for world and continent zoom (one file for the whole world, loaded with the page)
  const ov = { byId: new Map(), byCC: new Map(), cells: new Map(), ready: false, failed: false };
  const ovPaths = new Map();     // `${cc}|${thin}` → { r: Path2D, n: Path2D } (all cities of a country, one stroke for each kind)
  const ovAreaPaths = new Map(); // city id → Path2D (one city, for the status colours and the focus outline)
  const CELL_DEG = 2;            // the overview's lookup grid (which areas may hold a point)
  function addOverview(a) {
    const c = byId.get(a.id); a.cc = c ? c.cc : "";
    ov.byId.set(a.id, a);
    (ov.byCC.get(a.cc) || ov.byCC.set(a.cc, []).get(a.cc)).push(a);
    for (let i = Math.floor(a.box[0] / CELL_DEG); i <= Math.floor(a.box[2] / CELL_DEG); i++)
      for (let j = Math.floor(a.box[1] / CELL_DEG); j <= Math.floor(a.box[3] / CELL_DEG); j++) { const key = i + "," + j; (ov.cells.get(key) || ov.cells.set(key, []).get(key)).push(a); }
  }
  /** Parse the overview a thousand lines at a time between frames (the map keeps answering), drawing what is in after each batch. */
  function loadOverview(textPromise) {
    textPromise.then((text) => {
      const lines = text.split("\n");
      let i = 0;
      const idle = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 60 }) : (f) => setTimeout(f, 0);
      const step = () => {
        const end = Math.min(lines.length, i + 1000);
        for (; i < end; i++) { const a = parseOverviewLine(lines[i]); if (a) addOverview(a); }
        ovPaths.clear();
        if (i < lines.length) idle(step); else { ov.ready = true; prebuild(); }
        dirty.focus = true; markAll();
      };
      idle(step);
    }).catch(() => { ov.failed = true; buildOvCache(); markAll(); });
  }
  const ovRingPath = (p, r) => { for (let i = 0; i < r.length; i += 2) { const x = r[i] * OV_UNIT + 180, y = 84 - r[i + 1] * OV_UNIT; if (i) p.lineTo(x, y); else p.moveTo(x, y); } p.closePath(); };
  /** One country's overview outlines at this level of detail, one Path2D per kind (official + nearest land, nearest land only). */
  function ovPathsFor(cc, thin) {
    const key = cc + "|" + thin;
    let p = ovPaths.get(key);
    if (!p) {
      p = { r: new Path2D(), n: new Path2D() };
      for (const a of ov.byCC.get(cc) || []) for (const r of a.rings) ovRingPath(p[a.kind], thinRing(r, thin));
      ovPaths.set(key, p);
    }
    return p;
  }
  /** Work in idle time, a slice at a time: f(deadline) gets at least one item done per call (a callback that timed out has no time left,
   *  and Safari has no requestIdleCallback: there, 8 ms slices between frames). */
  const idleSlice = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 1000 })
    : setTimeout(() => { const end = performance.now() + 8; f({ timeRemaining: () => Math.max(0, end - performance.now()) }); }, 40));
  /** Once the overview is in: the outlines of every country at the levels of detail zooming in will need, built in idle time (a zoom never waits for them). */
  function prebuild() {
    const todo = [];
    for (const thin of [...new Set([thinFor(s0 * k), 2, 1])]) for (const cc of ov.byCC.keys()) todo.push([cc, thin]);
    const step = (dl) => { do { const [cc, thin] = todo.shift(); ovPathsFor(cc, thin); } while (todo.length && dl.timeRemaining() > 2); if (todo.length) idleSlice(step); else buildOvCache(); };
    if (todo.length) idleSlice(step); else buildOvCache();
  }
  /*
   * The world view as one picture. Below zoom OV_CACHE_K the land, the country borders and every city's outline (8,000 of them,
   * filled and stroked) are drawn once, for the whole world at zoom 1, into a bitmap built in idle time a few countries at a time;
   * every redraw of the base then copies the part in view (one drawImage) instead of filling and stroking all of it again (about
   * 300 ms a redraw on a slow phone: a pan at world zoom ran at 3 frames a second). Built again when the theme, the map style, the
   * map's size or the overview changes; until it is ready, everything is drawn as before. At most about 6 million pixels (24 MB).
   */
  const OV_CACHE_K = 1.6, OV_MOVING_K = 3;
  const ovCache = { key: "", canvas: null, scale: 1, ready: false, job: 0 };
  const ovCacheKey = () => [pal.land, pal.landLine, pal.area, pal.openLine, mapStyle, s0.toFixed(5), dpr, world.length, ov.byId.size].join("|");
  function buildOvCache() {
    if (!(ov.ready || ov.failed) || !W || !pal.area || !world.length) return;
    const key = ovCacheKey();
    if (ovCache.key === key) return;
    ovCache.key = key; ovCache.ready = false;
    const job = ++ovCache.job;
    const px = Math.min(dpr, Math.sqrt(6e6 / (360 * s0 * 144 * s0))), sc = s0 * px;
    const c = document.createElement("canvas");
    c.width = Math.ceil(360 * sc); c.height = Math.ceil(144 * sc);
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(sc, 0, 0, sc, 0, 0); g.lineJoin = "round";
    const thin = thinFor(s0), lineW = 0.6 / s0, area = pal.area, line = pal.openLine, colors = COUNTRY_COLORS[pal.light ? "light" : "dark"], colored = mapStyle === "colored";
    // the same layers, in the same order, as renderBase draws them: land, borders, then each country's city outlines
    const todo = [...world.map((w) => ["land", w]), ...world.map((w) => ["border", w]), ...boundsList.filter(([cc]) => ov.byCC.has(cc)).map(([cc]) => ["areas", cc])];
    const step = (dl) => {
      if (job !== ovCache.job) return; // the theme, the style or the size changed meanwhile: a newer build took over
      do {
        const [what, x] = todo.shift();
        if (what === "land") { g.fillStyle = colored ? colors[x.color ?? 0] : pal.land; g.fill(x.path, "evenodd"); }
        else if (what === "border") { g.strokeStyle = pal.landLine; g.lineWidth = 1 / s0; g.stroke(x.path); }
        else { const p = ovPathsFor(x, thin); g.fillStyle = area; g.fill(p.r, "evenodd"); g.fill(p.n, "evenodd"); g.strokeStyle = line; g.lineWidth = lineW; g.stroke(p.r); g.stroke(p.n); }
      } while (todo.length && dl.timeRemaining() > 2);
      if (todo.length) { idleSlice(step); return; }
      ovCache.canvas = c; ovCache.scale = sc; ovCache.ready = true;
      if (k < OV_CACHE_K) markAll();
    };
    idleSlice(step);
  }
  function ovAreaPath(id) {
    let p = ovAreaPaths.get(id);
    if (!p) { const a = ov.byId.get(id); if (!a) return null; p = new Path2D(); for (const r of a.rings) ovRingPath(p, r); ovAreaPaths.set(id, p); }
    return p;
  }
  /** The best outline of a city at this zoom: the detailed one once its file is in (from zoom 4.5), else the overview's. */
  const shapeOf = (id) => { const a = areas.get(id); if (a && k >= AREA_K - 0.5) return { path: a.path, kind: a.kind, box: a.box }; const o = ov.byId.get(id); return o ? { path: ovAreaPath(id), kind: o.kind, box: o.box } : a ? { path: a.path, kind: a.kind, box: a.box } : null; };
  /** The facts of a city's area for the cards: the detailed one when it's in, else the overview's (same km², computed from the detailed file at build time). */
  const areaFacts = (id) => areas.get(id) || ov.byId.get(id) || null;

  // the visible part of the world in degrees: [west, south, east, north]
  const view = () => { const s = s0 * k; return [-tx / s - 180, 84 - (H - ty) / s, (W - tx) / s - 180, 84 + ty / s]; };
  const boxInView = (b, v) => b[0] <= v[2] && b[2] >= v[0] && b[1] <= v[3] && b[3] >= v[1];
  const toLonLat = (px, py) => [(px - tx) / (s0 * k) - 180, 84 - (py - ty) / (s0 * k)];
  function loadVisible() { const v = view(); for (const [cc, x] of boundsList) if (boxInView(x.box, v)) loadBounds(cc); }
  const countryAt = (lon, lat) => world.find((w) => inBox(lon, lat, w.box) && inArea(lon, lat, w.area)) || null;
  function cityAtPoint(lon, lat) {
    for (const [id, a] of areas) if (inBox(lon, lat, a.box) && inArea(lon, lat, a.area)) return byId.get(id) || null;
    return null;
  }
  /** The community whose area holds the point: the detailed boundary when its country is in, else the overview's outline. */
  function areaIdAt(lon, lat) {
    const c = cityAtPoint(lon, lat);
    if (c) return c.id;
    for (const a of ov.cells.get(Math.floor(lon / CELL_DEG) + "," + Math.floor(lat / CELL_DEG)) || []) {
      if (boundsDone.has(a.cc) && k >= AREA_K - 0.5) continue; // its detailed shape said no
      if (inBox(lon, lat, a.box) && inOverview(lon, lat, a)) return a.id;
    }
    return null;
  }
  /** Load every country file whose box holds the point, then find the city there. */
  async function findCityAt(lon, lat) {
    await Promise.all(Object.entries(boundsIndex).filter(([, x]) => inBox(lon, lat, x.box)).map(([cc]) => loadBounds(cc)));
    return cityAtPoint(lon, lat);
  }

  // ---- status of a city, and the overlays that are not the map itself ----
  /** open | choosing | founded | mine */
  const statusOf = (c) => { const cl = claims.get(c.id); return cl ? (isMine(cl) ? "mine" : "founded") : windows.has(c.id) ? "choosing" : "open"; };
  const isCommunity = (c) => c.com ?? (c.com = !parts.has(c.id) && !outside.has(c.id)); // parts and outside never change once loaded
  const tickerOf = (c) => tickers.get(c.id)?.ticker || null;

  // the focus point (the crosshair): the middle of the part of the map the city card doesn't cover
  const focusEl = $("#map-focus"), railEl = $(".map-ctrl"), scaleEl = $("#map-scale");
  let rects = { rail: null, card: null }, fcx = 0, fcy = 0;
  const relRect = (e) => { if (!e || e.hidden) return null; const r = e.getBoundingClientRect(), s = wrapEl.getBoundingClientRect(); return r.width ? [r.left - s.left, r.top - s.top, r.width, r.height] : null; };
  function measureOverlays() {
    rects = { rail: relRect(railEl), card: relRect(focusEl), exit: relRect($("#map-exit")), scale: relRect(scaleEl) };
    const c = rects.card;
    fcx = W / 2;
    fcy = c && c[2] > W * 0.6 ? Math.max(40, c[1] / 2) : H / 2; // a card across the whole width (phones): the middle of what's above it
  }
  const grow = (r, g) => (r ? [r[0] - g, r[1] - g, r[2] + 2 * g, r[3] + 2 * g] : null);

  function size() {
    const r = wrapEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // a resize that left the stage as it was (a phone's toolbar showing or hiding during a scroll, the window's height on a
    // computer): nothing to reallocate or redraw (each full redraw of the world costs about 300 ms on a slow phone)
    const nd = Math.min(window.devicePixelRatio || 1, 2);
    if (W && r.width === W && r.height === H && nd === dpr) return;
    // keep the same place under the crosshair when the box resizes; the first time, the visitor's part of the world
    const first = !W;
    let lon, lat;
    if (first) { let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {} [lon, lat] = openingView(tz); }
    else [lon, lat] = toLonLat(fcx, fcy);
    dpr = nd;
    W = r.width; H = r.height; s0 = Math.max(W / 360, H / 144);
    for (const c of [canvas, fxCanvas, labCanvas]) { const w = Math.round(W * dpr), h = Math.round(H * dpr); if (c.width !== w) c.width = w; if (c.height !== h) c.height = h; }
    baseView = null;
    measureOverlays();
    tx = fcx - wx(lon) * k; ty = fcy - wy(lat) * k; clampView();
    ovPaths.clear(); buildOvCache();
    zoomLabel(); zoomReadout(); markAll();
  }
  // the zoom, for screen readers, once the map rests (the scale bar shows it on screen)
  const zoomReadout = () => { const z = $("#map-zoom-level"), t = `${k < 10 ? k.toFixed(1) : Math.round(k)}×`; if (z.textContent !== t) z.textContent = t; };
  const zoomLabel = () => {
    canvas.style.touchAction = k > 1.01 ? "none" : "pan-y";
    const lat = toLonLat(fcx, fcy)[1], bar = scaleBar((s0 * k) / (111.32 * Math.max(0.05, Math.cos((Math.max(-80, Math.min(80, lat)) * Math.PI) / 180))));
    if (bar) { $("#map-scale-bar").style.width = `${bar.px}px`; $("#map-scale-text").textContent = bar.text; }
  };

  /** Something about the view changed: redraw the base (from the bitmap while it moves), relay the labels, find the focus again. */
  function viewMoved(interactive = false) {
    dirty.base = dirty.labels = dirty.layout = dirty.focus = true;
    if (interactive) { moving = true; clearTimeout(crispTimer); crispTimer = setTimeout(settle, 90); }
    else zoomReadout(); // a move that is not a gesture (the opening on your city, a fold) is already at rest: say its zoom now
    zoomLabel(); kick();
  }
  function settle() { if (cam) { crispTimer = setTimeout(settle, 90); return; } moving = false; zoomReadout(); dirty.base = dirty.layout = dirty.focus = dirty.labels = true; kick(); }
  /** Everything again (data, theme, size or status changed). */
  function markAll() { dirty.base = dirty.labels = dirty.layout = dirty.focus = true; kick(); }

  // ---- the camera: zoom steps, wheel, fling and fly-to all ease; reduced motion jumps ----
  let cam = null;     // { kind: "fly" | "zoom" | "wheel" | "fling", … }
  let userMoved = false; // the person moved the map: the focus follows the crosshair from now on
  function zoomTo(px, py, nk) { nk = Math.min(MAXK, Math.max(1, nk)); tx = px - (px - tx) * (nk / k); ty = py - (py - ty) * (nk / k); k = nk; clampView(); }
  function zoomAt(px, py, factor) { zoomTo(px, py, k * factor); viewMoved(true); }
  /** An eased zoom step around a point (the + and − buttons, a double tap). */
  function zoomStep(px, py, factor, ms) {
    if (reduced || !onScreen || document.hidden) { zoomAt(px, py, factor); return; }
    cam = { kind: "zoom", t0: performance.now(), ms, k0: k, k1: Math.min(MAXK, Math.max(1, k * factor)), px, py };
    viewMoved(true);
  }
  function flyTo(lon, lat, targetK) {
    targetK = Math.min(MAXK, Math.max(1, targetK));
    const [clon, clat] = toLonLat(fcx, fcy), dist = Math.hypot(lon - clon, lat - clat), plan = flightPlan(k, targetK, dist);
    if (reduced || !onScreen || document.hidden) { // off screen or less motion: jump straight there
      k = targetK; tx = fcx - wx(lon) * k; ty = fcy - wy(lat) * k; clampView(); cam = null; viewMoved(true); return;
    }
    cam = { kind: "fly", t0: performance.now(), ms: plan.ms, dip: plan.dip, k0: k, k1: targetK, cx0: (fcx - tx) / k, cy0: (fcy - ty) / k, cx1: wx(lon), cy1: wy(lat) };
    viewMoved(true);
  }
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  /** One step of whatever the camera is doing. True while it moves. */
  function stepCamera(now, dt) {
    if (!cam) return false;
    const c = cam;
    if (c.kind === "fly") {
      const t = Math.min(1, (now - c.t0) / c.ms), e = easeInOut(t);
      k = t >= 1 ? c.k1 : flyK(c.k0, c.k1, c.dip, e, MAXK);
      tx = fcx - (c.cx0 + (c.cx1 - c.cx0) * e) * k; ty = fcy - (c.cy0 + (c.cy1 - c.cy0) * e) * k; clampView();
      if (t >= 1) cam = null;
    } else if (c.kind === "zoom") {
      const t = Math.min(1, (now - c.t0) / c.ms), e = easeOut(t);
      zoomTo(c.px, c.py, Math.exp(Math.log(c.k0) + (Math.log(c.k1) - Math.log(c.k0)) * e));
      if (t >= 1) cam = null;
    } else if (c.kind === "wheel") {
      const d = Math.log(c.kT / k);
      if (Math.abs(d) < 0.002) { zoomTo(c.px, c.py, c.kT); cam = null; } else zoomTo(c.px, c.py, k * Math.exp(d * 0.28));
    } else if (c.kind === "fling") {
      const f = Math.min(4, dt / 16.7);
      tx += c.vx * dt; ty += c.vy * dt; const before = [tx, ty]; clampView();
      if (tx !== before[0]) c.vx = 0; if (ty !== before[1]) c.vy = 0;
      c.vx *= Math.pow(0.92, f); c.vy *= Math.pow(0.92, f);
      if (Math.hypot(c.vx, c.vy) < 0.05) cam = null;
    }
    viewMoved(true);
    return true;
  }
  /** The zoom at which the box [west, south, east, north] fits the free part of the map around the crosshair (left of the control
   *  rail, above the city card on a phone), with a margin. */
  function fitK(b) {
    const right = rects.rail && rects.rail[0] > fcx ? rects.rail[0] - 6 : W;
    const halfW = Math.max(30, Math.min(fcx, right - fcx) - 10), halfH = Math.max(30, fcy - 10);
    return Math.min((2 * halfW) / Math.max(0.0002, (b[2] - b[0]) * s0), (2 * halfH) / Math.max(0.0002, (b[3] - b[1]) * s0)) * 0.92;
  }
  /** Fly so the box [west, south, east, north] fills most of the free part of the map. */
  function flyToBox(b, minK = 1) {
    flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.min(MAXK, Math.max(minK, fitK(b))));
  }
  function flyToCity(c) {
    const a = areas.get(c.id) || ov.byId.get(c.id);
    if (a) return flyToBox(a.box, Math.min(AREA_K + 0.5, fitK(a.box))); // the whole boundary in view (closer than zoom 5.5 when it fits)
    const r = radiusOf(c);
    flyTo(c.lon, c.lat, Math.min(MAXK, Math.max(AREA_K + 0.5, (Math.min(W, H) * 0.3) / ((r / 111.32) * s0))));
  }
  function flyToCountry(cc) {
    const list = cities.filter((c) => c.cc === cc);
    if (!list.length) return;
    const lons = list.map((c) => c.lon), lats = list.map((c) => c.lat);
    flyToBox([Math.min(...lons) - 0.3, Math.min(...lats) - 0.3, Math.max(...lons) + 0.3, Math.max(...lats) + 0.3]);
  }

  // pulse phase per city, so cities don't all breathe in sync
  const phase = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };
  // the smallest place drawn as a dot at this zoom (13,000 places: towns show up as you zoom in)
  const dotMinPop = () => (k < 2 ? 150_000 : k < 4 ? 50_000 : k < 8 ? 15_000 : k < 20 ? 5_000 : 0);
  const MARGIN = 60;
  const inViewPx = (x, y, m = MARGIN) => x > -m && x < W + m && y > -m && y < H + m;
  /** Cities that always show, whatever their size: founded, choosing, yours, selected, in focus. */
  function specialIds() {
    const s = new Set([...claims.keys(), ...windows.keys()]);
    if (selected) s.add(selected.id);
    if (focusId) s.add(focusId);
    return s;
  }
  let shown = [];      // the cities with a marker in view (after the last base drawing)

  /* ---------- the base layer ---------- */
  // While the view moves, the base is drawn crisp at most every 100 ms, and never more often than three times what the last drawing
  // took (a slow phone that needs 150 ms for one would otherwise draw on every frame of a gesture and never let the compositor
  // help); in between, the compositor moves and scales the last drawing (a CSS transform on the canvas: no drawing, no copy), and
  // 90 ms after the last move it is drawn crisp where it ends.
  let baseView = null; // the view the base canvas was last drawn at: { k, tx, ty }
  let baseCost = 0;    // ms the last drawing took
  function drawBase(now) {
    if (moving && baseView && performance.now() - lastCrisp < Math.max(100, 3 * baseCost)) {
      const r = k / baseView.k;
      canvas.style.transform = `matrix(${r},0,0,${r},${(tx - baseView.tx * r).toFixed(2)},${(ty - baseView.ty * r).toFixed(2)})`;
      return;
    }
    const t0 = performance.now();
    renderBase();
    lastCrisp = performance.now(); baseCost = lastCrisp - t0; baseView = { k, tx, ty };
    if (canvas.style.transform) canvas.style.transform = "";
  }
  function renderBase() {
    const s = s0 * k, v = view();
    const colored = mapStyle === "colored";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // graticule
    const step = k < 3 ? 30 : k < 12 ? 10 : k < 40 ? 5 : k < 200 ? 1 : 0.25;
    ctx.lineWidth = 1; ctx.strokeStyle = pal.grid;
    ctx.beginPath();
    for (let lon = Math.ceil(v[0] / step) * step; lon <= v[2]; lon += step) { const x = Math.round(sx(lon)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let lat = Math.ceil(v[1] / step) * step; lat <= v[3]; lat += step) { const y = Math.round(sy(lat)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // land (one colour, or each country its own on the coloured map) and country borders
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
    ctx.lineJoin = "round";
    // the picture below zoom 1.6; while a gesture is under way, up to zoom 3 too (a little soft for a moment, drawn crisp when it stops)
    const pic = (k < OV_CACHE_K || (moving && k < OV_MOVING_K)) && ovCache.ready && ovCache.key === ovCacheKey();
    if (pic) {
      // the world view: the part in view of the world's picture (buildOvCache: land, borders, city outlines), in degree space
      const sc = ovCache.scale, cw = ovCache.canvas.width, ch = ovCache.canvas.height;
      const x0 = Math.max(0, Math.floor((v[0] + 180) * sc)), y0 = Math.max(0, Math.floor((84 - v[3]) * sc));
      const x1 = Math.min(cw, Math.ceil((v[2] + 180) * sc)), y1 = Math.min(ch, Math.ceil((84 - v[1]) * sc));
      if (x1 > x0 && y1 > y0) ctx.drawImage(ovCache.canvas, x0, y0, x1 - x0, y1 - y0, x0 / sc, y0 / sc, (x1 - x0) / sc, (y1 - y0) / sc);
    } else {
      const countryColors = COUNTRY_COLORS[pal.light ? "light" : "dark"];
      for (const w of world) if (boxInView(w.box, v)) { ctx.fillStyle = colored ? countryColors[w.color ?? 0] : pal.land; ctx.fill(w.path, "evenodd"); }
      ctx.strokeStyle = pal.landLine; ctx.lineWidth = 1 / s;
      for (const w of world) if (boxInView(w.box, v)) ctx.stroke(w.path);
    }

    // city boundaries: the overview below zoom 5, the detailed files above, cross-fading country by country as each file is in
    const fade = Math.max(0, Math.min(1, (k - (AREA_K - 0.5)) / 1));
    if (fade > 0) loadVisible();
    const thin = thinFor(s), dash = k >= 2;
    const openW = (k < 2 ? 0.6 : 0.8) / s;
    if (!pic) for (const [cc, info] of boundsList) {
      if (!boxInView(info.box, v)) continue;
      const detail = fade > 0 && boundsDone.has(cc);
      const ovAlpha = detail ? 1 - fade : 1;
      if (ovAlpha > 0.01 && ov.byCC.has(cc)) {
        const p = ovPathsFor(cc, thin);
        ctx.globalAlpha = ovAlpha;
        ctx.fillStyle = pal.area; ctx.fill(p.r, "evenodd"); ctx.fill(p.n, "evenodd");
        ctx.strokeStyle = pal.openLine; ctx.lineWidth = openW;
        ctx.stroke(p.r);
        if (dash) ctx.setLineDash([2 / s, 2 / s]);
        ctx.stroke(p.n); ctx.setLineDash([]);
      }
      if (detail) {
        ctx.globalAlpha = fade;
        const list = (areasByCC.get(cc) || []).filter((a) => boxInView(a.box, v));
        for (const a of list) {
          const tint = colored ? hexA(AREA_COLORS[a.color ?? 0], pal.light ? 0.3 : 0.24) : pal.area;
          ctx.fillStyle = tint; ctx.fill(a.path, "evenodd");
        }
        ctx.lineWidth = (k > 80 ? 1.6 : 1.15) / s; ctx.strokeStyle = pal.areaLine;
        for (const a of list) { ctx.setLineDash(a.kind === "n" ? [5 / s, 4 / s] : []); ctx.stroke(a.path); }
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
    // cities with a status, on top: choosing (gold, dashed), founded (orange), yours (gold), the selected one (gold)
    const STYLE = {
      choosing: { fill: `rgba(${pal.choosing},${0.18 * pal.a})`, line: `rgba(${pal.choosing},${0.85 * pal.a})`, w: 1, dash: [3, 2] },
      founded: { fill: `rgba(${pal.founded},${0.32 * pal.a})`, line: `rgba(${pal.founded},${0.85 * pal.a})`, w: 1 },
      mine: { fill: `rgba(${pal.mine},${0.3 * pal.a})`, line: `rgb(${pal.mine})`, w: 1.2 },
    };
    for (const id of specialIds()) {
      const c = byId.get(id); if (!c) continue;
      const st = statusOf(c), sh = shapeOf(id);
      if (!sh || !boxInView(sh.box, v)) continue;
      const style = STYLE[st];
      if (c === selected) { ctx.fillStyle = `rgba(${pal.mine},${0.14 * pal.a})`; ctx.fill(sh.path, "evenodd"); }
      if (!style) continue;
      ctx.fillStyle = style.fill; ctx.fill(sh.path, "evenodd");
      ctx.strokeStyle = style.line; ctx.lineWidth = style.w / s;
      ctx.setLineDash(style.dash ? style.dash.map((d) => d / s) : sh.kind === "n" ? [2 / s, 2 / s] : []);
      ctx.stroke(sh.path); ctx.setLineDash([]);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // open cities: small static dots (bigger as you zoom in); cities with a status: their bright core (the glow layer adds the rest)
    shown = [];
    const minPop = dotMinPop(), special = specialIds();
    const d = (k < 2 ? 2.2 : k < 5 ? 3 : 3.6) * (k >= AREA_K ? 0.85 : 1);
    ctx.fillStyle = `rgb(${pal.open})`; ctx.globalAlpha = pal.light ? 0.55 : 0.85;
    ctx.beginPath();
    for (const c of cities) {
      if (c.pop < minPop) break;
      if (parts.has(c.id) || special.has(c.id)) continue;
      const x = sx(c.lon), y = sy(c.lat);
      if (!inViewPx(x, y)) continue;
      shown.push(c);
      if (d < 2.6) ctx.rect(x - d / 2, y - d / 2, d, d); else { ctx.moveTo(x + d / 2, y); ctx.arc(x, y, d / 2, 0, Math.PI * 2); }
    }
    ctx.fill(); ctx.globalAlpha = 1;
    for (const id of special) {
      const c = byId.get(id); if (!c || parts.has(c.id)) continue;
      const x = sx(c.lon), y = sy(c.lat);
      if (!inViewPx(x, y)) continue;
      shown.push(c);
      const st = statusOf(c), r = st === "mine" ? 4.5 : st === "founded" ? 3.6 : st === "choosing" ? 3 : d / 2 + 0.6;
      ctx.fillStyle = `rgb(${pal[st]})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* ---------- labels and chips (layout only when the view changes; drawing when the view or a fade changes) ---------- */
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }); // short(), with one formatter for the hundreds of chips
  let labels = [], leaving = [], focusId = null, focusPinned = null, pinnedBy = null; // pinnedBy: "link" | "pick" | "home" | "nearest"
  const textW = new Map();
  const measure = (font, t) => { const key = font + "|" + t; let w = textW.get(key); if (w == null) { lctx.font = font; w = lctx.measureText(t).width; textW.set(key, w); } return w; };
  const FONT = { A1: "700 12px Inter, system-ui, sans-serif", A2: "600 11px Inter, system-ui, sans-serif", B: "600 11px Inter, system-ui, sans-serif", BT: "700 11px Inter, system-ui, sans-serif", C: "600 11px Inter, system-ui, sans-serif" };
  const STATUS_WORD = { open: "Open", choosing: "Choosing its founder", founded: "Founded", mine: "Yours" };
  const ellipsis = (font, t, max) => {
    if (measure(font, t) <= max) return t;
    let lo = 1, hi = t.length - 1; // the longest start of the name that fits with "…"
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measure(font, t.slice(0, mid) + "…") <= max) lo = mid; else hi = mid - 1; }
    return t.slice(0, lo).trimEnd() + "…";
  };
  /** What a chip says, per tier: A two lines, B "Name $TICKER" (+ the founder amount closer in), C the name. */
  function chipText(c, st) {
    const tk = tickerOf(c), amount = compact.format(founderMin(c, windows.get(c.id)));
    const bTicker = tk ? `$${tk}` : "", maxW = W < 600 ? 196 : 220;
    const tickW = bTicker ? measure(FONT.BT, " " + bTicker) : 0, nameW = measure(FONT.B, c.name);
    // the founder amount closer in, when the whole name still fits with it; else the name and the ticker; a very long name is shortened last
    let bTail = k >= 4 ? ` · ${amount}` : "";
    if (bTail && 26 + nameW + tickW + measure(FONT.B, bTail) > maxW) bTail = "";
    return { name: c.name, a2: `${STATUS_WORD[st]}${tk ? ` · $${tk}` : ""}${k >= 3 ? ` · ${amount}` : ""}`, bName: ellipsis(FONT.B, c.name, Math.max(48, maxW - 26 - tickW)), bTicker, bTail };
  }
  function layoutLabels(now) {
    const phone = W < 600;
    const prev = new Map(labels.map((l) => [l.id, l]));
    const max = { A: 3, B: phone ? 10 : 24, C: phone ? 20 : 60 };
    const cands = [];
    for (const c of shown) {
      if (!isCommunity(c)) continue;
      const x = sx(c.lon), y = sy(c.lat);
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const st = statusOf(c), win = st === "choosing" ? windows.get(c.id) : null;
      const it = { id: c.id, c, x, y, st, mine: st === "mine", selected: c === selected, focus: c.id === focusId, status: st, holders: st === "open" ? 0 : holderCount.get(c.id) || 0,
        applicants: win ? win.applicants : 0, members: memberCount.size ? memberCount.get(c.id) || 0 : 0, pop: c.pop, shown: prev.has(c.id) };
      const r = labelRank(it); it.key = r[0] * 1e13 + r[1]; // the same order as byRank, as one number
      cands.push(it);
    }
    cands.sort((p, q) => p.key - q.key || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    const items = [];
    let a = 0;
    for (const x of cands.slice(0, 3 * (max.A + max.B + max.C))) { // enough to fill every slot; the rest would never be placed
      const { t, size } = chipOf(x.c, x.st);
      const isA = (x.mine || x.selected || x.focus) && a < 3;
      if (isA) a++;
      items.push({ id: x.id, x: x.x, y: x.y, tierWish: isA ? "A" : "B", size, t, st: x.st, focus: x.focus });
    }
    const avoid = [grow(rects.rail, 8), grow(rects.card, 8), grow(rects.exit, 8), grow(rects.scale, 4)].filter(Boolean);
    const placed = placeLabels(items, { W, H, avoid, soft: [[fcx - 20, fcy - 20, 40, 40]], core: [[fcx - 16, fcy - 16, 32, 32]], max });
    const info = new Map(items.map((i) => [i.id, i]));
    const next = placed.map((p) => {
      const old = prev.get(p.id), it = info.get(p.id);
      return { ...p, dx: p.x - p.ax, dy: p.y - p.ay, t: it.t, st: it.st, born: old ? old.born : now, pop: popAt.get(p.id) || 0 };
    });
    const keep = new Set(next.map((l) => l.id));
    if (!reduced) for (const l of labels) if (!keep.has(l.id)) leaving.push({ ...l, died: now });
    labels = next;
    // the glow layer breathes for the open cities that carry a chip or a name
    fxItems = buildFxItems();
  }
  // text widths measured before the site's fonts arrive are the fallback font's: measure again once they are in
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { textW.clear(); chipCache.clear(); if (loaded) markAll(); }).catch(() => {});
  const popAt = new Map(); // city id → when its chip should pop (a new founder)
  /** A city's chip texts and sizes at this zoom band, measured once (cleared when statuses, tickers or the screen width change). */
  const chipCache = new Map();
  function chipOf(c, st) {
    const key = `${c.id}|${st}|${k >= 4 ? 2 : k >= 3 ? 1 : 0}|${W < 600 ? 1 : 0}`;
    let v = chipCache.get(key);
    if (!v) {
      const t = chipText(c, st);
      v = { t, size: {
        A: [Math.ceil(Math.max(measure(FONT.A1, t.name), measure(FONT.A2, t.a2)) + 22), 36],
        B: [Math.ceil(26 + measure(FONT.B, t.bName) + (t.bTicker ? measure(FONT.BT, " " + t.bTicker) : 0) + (t.bTail ? measure(FONT.B, t.bTail) : 0)), 22],
        C: [Math.ceil(measure(FONT.C, c.name)) + 4, 14],
      } };
      if (chipCache.size > 5000) chipCache.clear();
      chipCache.set(key, v);
    }
    return v;
  }
  function drawChip(l, alpha, now) {
    const c = byId.get(l.id); if (!c) return;
    const ax = sx(c.lon), ay = sy(c.lat), x = ax + l.dx, y = ay + l.dy;
    const g = lctx;
    let sc = 1;
    if (l.pop && !reduced) { const p = (now - l.pop) / 300; if (p >= 0 && p < 1) sc = 0.6 + 0.4 * (1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2)); } // a new founder's chip pops in (ease out, a little past 1)
    g.globalAlpha = alpha;
    if (l.leader) {
      g.strokeStyle = `rgba(${pal.ink},.35)`; g.lineWidth = 1;
      const tx2 = Math.max(x, Math.min(ax, x + l.w)), ty2 = Math.max(y, Math.min(ay, y + l.h));
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(tx2, ty2); g.stroke();
    }
    if (sc !== 1) { g.save(); g.translate(x + l.w / 2, y + l.h / 2); g.scale(sc, sc); g.translate(-(x + l.w / 2), -(y + l.h / 2)); }
    const col = pal[l.st];
    if (l.tier === "C") {
      g.font = FONT.C; g.textBaseline = "middle"; g.lineJoin = "round";
      g.strokeStyle = pal.halo; g.lineWidth = 3; g.strokeText(l.t.name, x + 2, y + l.h / 2);
      g.fillStyle = l.st === "founded" ? pal.foundedText : l.st === "open" ? pal.label : pal.choosingText; g.fillText(l.t.name, x + 2, y + l.h / 2);
    } else {
      const A = l.tier === "A";
      g.fillStyle = pal.chipBg; g.strokeStyle = `rgba(${col},${A ? 0.9 : 0.55})`; g.lineWidth = A ? 1.5 : 1;
      g.beginPath(); if (g.roundRect) g.roundRect(x, y, l.w, l.h, A ? 12 : 11); else g.rect(x, y, l.w, l.h); g.fill(); g.stroke();
      g.textBaseline = "middle";
      if (A) {
        g.font = FONT.A1; g.fillStyle = pal.label; g.fillText(l.t.name, x + 11, y + 12);
        g.font = FONT.A2; g.fillStyle = l.st === "founded" ? pal.foundedText : l.st === "open" ? `rgb(${pal.open})` : pal.choosingText; g.fillText(l.t.a2, x + 11, y + 26);
      } else {
        g.fillStyle = `rgb(${col})`; g.beginPath(); g.arc(x + 9, y + 11, 3, 0, Math.PI * 2); g.fill();
        let cx = x + 18;
        g.font = FONT.B; g.fillStyle = pal.label; g.fillText(l.t.bName, cx, y + 11.5); cx += measure(FONT.B, l.t.bName);
        if (l.t.bTicker) { g.font = FONT.BT; g.fillStyle = pal.goldText; g.fillText(" " + l.t.bTicker, cx, y + 11.5); cx += measure(FONT.BT, " " + l.t.bTicker); }
        if (l.t.bTail) { g.font = FONT.B; g.fillStyle = `rgba(${pal.ink},.62)`; g.fillText(l.t.bTail, cx, y + 11.5); }
      }
    }
    if (sc !== 1) g.restore();
    g.globalAlpha = 1;
  }
  /** The label layer: hover outlines, the focus outline, chips and names, the crosshair. True while a fade or a pop is running. */
  function drawLabels(now) {
    const s = s0 * k, g = lctx, v = view();
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    // outlines in degree space: the country under the mouse (zoomed out), the city under the mouse, the city in focus
    g.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty); g.lineJoin = "round";
    if (hoverCountry && k < 3) {
      g.fillStyle = pal.light ? "rgba(232,67,31,.08)" : "rgba(255,138,91,.1)"; g.fill(hoverCountry.path, "evenodd");
      g.strokeStyle = "rgba(255,120,80,.8)"; g.lineWidth = 1.5 / s; g.stroke(hoverCountry.path);
    }
    const hs = hover && hover !== selected && shapeOf(hover.id);
    if (hs && boxInView(hs.box, v)) { g.fillStyle = pal.hoverFill; g.fill(hs.path, "evenodd"); g.lineWidth = 2 / s; g.strokeStyle = pal.label; g.stroke(hs.path); }
    const fs = focusId && focusId !== selected?.id && shapeOf(focusId);
    if (fs && boxInView(fs.box, v)) { g.lineWidth = 1.5 / s; g.strokeStyle = pal.label; g.globalAlpha = 0.85; g.stroke(fs.path); g.globalAlpha = 1; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // hover ring on a dot (a mouse, zoomed out)
    if (hover && hover !== selected && k < AREA_K) { g.strokeStyle = pal.label; g.lineWidth = 1.5; g.beginPath(); g.arc(sx(hover.lon), sy(hover.lat), 7, 0, Math.PI * 2); g.stroke(); }
    let busy = false;
    for (let i = leaving.length - 1; i >= 0; i--) {
      const l = leaving[i], p = (now - l.died) / 120;
      if (p >= 1) { leaving.splice(i, 1); continue; }
      busy = true; drawChip(l, 1 - p, now);
    }
    // names first, chips on top of them, the most important last
    for (const tier of ["C", "B", "A"]) for (const l of labels) {
      if (l.tier !== tier) continue;
      const p = reduced ? 1 : Math.min(1, (now - l.born) / 160);
      if (p < 1 || (l.pop && now - l.pop < 300)) busy = true;
      drawChip(l, p, now);
    }
    // the crosshair: a ring and four ticks at the focus point
    g.strokeStyle = `rgba(${pal.ink},.55)`; g.lineWidth = 1.5;
    g.beginPath(); g.arc(fcx, fcy, 5, 0, Math.PI * 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(fcx + dx * 9, fcy + dy * 9); g.lineTo(fcx + dx * 15, fcy + dy * 15); }
    g.stroke();
    return busy;
  }

  /* ---------- the glow layer: status glow, rings, the marching boundary, ripples ---------- */
  let fxItems = [];
  function buildFxItems() {
    const out = [], seen = new Set();
    const add = (c) => { if (!c || seen.has(c.id) || parts.has(c.id) || !inViewPx(sx(c.lon), sy(c.lat), 30)) return; seen.add(c.id); out.push({ c, st: statusOf(c), ph: phase(c.id) }); };
    for (const id of specialIds()) add(byId.get(id));
    for (const l of labels) add(byId.get(l.id));
    return out;
  }
  const selectedInView = () => { if (!selected) return false; if (inViewPx(sx(selected.lon), sy(selected.lat), 20)) return true; const sh = shapeOf(selected.id); return Boolean(sh && boxInView(sh.box, view())); };
  /** Is anything on the glow layer moving? (no frames at all otherwise) */
  const fxAnimating = () => !reduced && (fxItems.length > 0 || ripples.length > 0 || selectedInView());
  // The glow is drawn frame by frame for FX_AWAKE_MS after the last thing that happened (a move, a tap, a hover, new data), then it
  // rests: one still frame, and the whole layer breathes through a CSS opacity animation (#city-fx.is-resting, the compositor's
  // work: no script, no drawing) until something happens again. It used to redraw 15 to 30 times a second for as long as the map
  // was on screen.
  const FX_AWAKE_MS = 6000;
  let lastActive = 0, fxResting = false;
  function setResting(on) { if (fxResting === on) return; fxResting = on; fxCanvas.classList.toggle("is-resting", on); }
  // Only what moves is redrawn: the rectangles drawn last time and this time are cleared and drawn again (a few dozen small squares,
  // not the whole layer); when the view itself moved, the whole layer.
  let fxDamage = null, fxAt = "";
  function drawFx(now, rest = false) {
    const g = fctx, t = now / 1000, s = s0 * k, v = view();
    const lightA = pal.light ? 0.6 : 1, still = reduced || rest;
    const wave = (period, ph) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (t / period + ph));
    const glows = [], rings = [], over = [];
    for (const it of fxItems) {
      const x = sx(it.c.lon), y = sy(it.c.lat);
      if (!inViewPx(x, y, 30)) continue;
      let a, size;
      if (it.st === "open") { const w = still ? 0.5 : wave(3.6, it.ph); a = 0.25 + 0.3 * w; size = 26 * (1 + 0.35 * w); }
      else if (it.st === "choosing") { a = 0.5; size = 34; }
      else if (it.st === "founded") { a = still ? 0.75 : 0.6 + 0.3 * wave(2.8, it.ph); size = 40; }
      else { a = 0.8; size = 46; }
      const R = Math.max(size / 2, it.st === "mine" ? 24 : it.st === "founded" ? 20 : it.st === "choosing" ? 11 : 0) + 2;
      glows.push([x - R, y - R, 2 * R, 2 * R, () => { g.globalAlpha = a * lightA; g.drawImage(sprites[it.st], x - size / 2, y - size / 2, size, size); }]);
      if (it.st === "choosing") rings.push([0, 0, 0, 0, () => {
        g.strokeStyle = `rgba(${pal.choosing},.95)`; g.lineWidth = 2; g.setLineDash([3.5, 3]); g.lineDashOffset = still ? 0 : -((t / 4) % 1) * 2 * Math.PI * 8;
        g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.lineDashOffset = 0;
      }]);
      else if (it.st === "founded" && !still) rings.push([0, 0, 0, 0, () => {
        const p = (t / 2.4 + it.ph) % 1, e = 1 - Math.pow(1 - p, 2);
        g.strokeStyle = `rgba(${pal.founded},${0.55 * (1 - p)})`; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 4 + 14 * e, 0, Math.PI * 2); g.stroke();
      }]);
      else if (it.st === "mine" && !still) rings.push([0, 0, 0, 0, () => {
        for (const off of [0, 0.5]) { const p = (t / 1.6 + off) % 1; g.strokeStyle = `rgba(${pal.mine},${0.6 * (1 - p)})`; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 6 + 16 * p, 0, Math.PI * 2); g.stroke(); }
      }]);
    }
    // the selected city and yours: a gold boundary with marching dashes (standing still with reduced motion)
    const golden = new Set();
    if (selected) golden.add(selected.id);
    for (const it of fxItems) if (it.st === "mine") golden.add(it.c.id);
    for (const id of golden) {
      const sh = shapeOf(id); if (!sh || !boxInView(sh.box, v)) continue;
      const x0 = sx(sh.box[0]) - 4, y0 = sy(sh.box[3]) - 4, x1 = sx(sh.box[2]) + 4, y1 = sy(sh.box[1]) + 4;
      over.push([x0, y0, x1 - x0, y1 - y0, () => {
        g.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
        g.lineWidth = (id === selected?.id ? 3 : 2) / s; g.strokeStyle = `rgba(${pal.mine},.95)`;
        g.setLineDash([8 / s, 6 / s]); g.lineDashOffset = still ? 0 : (-t * 20) / s; g.stroke(sh.path);
        g.setLineDash([]); g.lineDashOffset = 0; g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }]);
    }
    // the selected city: a gold dot that breathes
    if (selected) {
      const x = sx(selected.lon), y = sy(selected.lat);
      if (inViewPx(x, y, 20)) over.push([x - 26, y - 26, 52, 52, () => {
        const b = still ? 0 : (Math.sin(t * 3) + 1) / 2;
        g.globalCompositeOperation = pal.light ? "source-over" : "lighter"; g.globalAlpha = 0.8 * lightA;
        g.drawImage(sprites.mine, x - 24, y - 24, 48, 48); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
        g.fillStyle = `rgb(${pal.mine})`; g.beginPath(); g.arc(x, y, 4.5 + b * 1.5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = `rgba(${pal.mine},.9)`; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 10 + b * 3, 0, Math.PI * 2); g.stroke();
      }]);
    }
    // ripples (a tap, a fresh claim, your location)
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i], p = (now - r.t0) / 1300;
      if (p >= 1 || still) { ripples.splice(i, 1); continue; }
      const x = sx(r.lon), y = sy(r.lat);
      over.push([x - 56, y - 56, 112, 112, () => { g.beginPath(); g.arc(x, y, 6 + p * 46, 0, Math.PI * 2); g.strokeStyle = `rgba(${r.col},${(1 - p) * 0.8})`; g.lineWidth = 2; g.stroke(); }]);
    }
    // clear: everything when the view moved (or a lot is drawn), else last time's rectangles and this time's
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const at = `${k}|${tx}|${ty}|${W}|${H}`, rects = glows.concat(over);
    const area = rects.reduce((n, r) => n + r[2] * r[3], 0);
    if (at !== fxAt || !fxDamage || area > W * H * 0.4) g.clearRect(0, 0, W, H);
    else for (const r of fxDamage.concat(rects)) g.clearRect(Math.floor(r[0]) - 1, Math.floor(r[1]) - 1, Math.ceil(r[2]) + 2, Math.ceil(r[3]) + 2);
    fxAt = at; fxDamage = area > W * H * 0.4 ? null : rects.map((r) => r.slice(0, 4));
    g.globalCompositeOperation = pal.light ? "source-over" : "lighter";
    for (const op of glows) op[4]();
    g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    for (const op of rings) op[4]();
    for (const op of over) op[4]();
    // rings, pings, marching dashes and ripples want 30 frames a second; a slow breathing glow alone is smooth at 15
    fxStep = rings.length || over.length ? 33 : 66;
  }
  let fxStep = 33;

  /* ---------- the frame: one requestAnimationFrame at a time, and none when nothing changes ---------- */
  let lastFrame = 0, labelsBusy = false;
  function frame(now) {
    raf = 0;
    if (!onScreen || document.hidden || !W) { lastFrame = 0; return; }
    const dt = lastFrame ? Math.min(64, now - lastFrame) : 16.7;
    lastFrame = now;
    const camMoving = stepCamera(now, dt);
    if (dirty.base) { drawBase(now); dirty.base = false; }
    // the labels' layout (and the focus) run when the view changed: at most every 100 ms while it moves, at once when it stops
    if (dirty.layout && (!moving || now - lastLayout >= 100)) { layoutLabels(now); lastLayout = now; dirty.layout = false; dirty.labels = true; }
    if (dirty.focus && (!moving || now - lastFocusAt >= 100)) { updateFocus(); lastFocusAt = now; dirty.focus = false; }
    if (dirty.labels || labelsBusy) { labelsBusy = drawLabels(now); dirty.labels = false; }
    const anim = fxAnimating(), awake = anim && now - lastActive < FX_AWAKE_MS;
    if (dirty.fx || camMoving || moving || (awake && now - lastFx >= fxStep - 4)) { drawFx(now, anim && !awake); lastFx = now; dirty.fx = false; }
    else if (anim && !awake && !fxResting) { drawFx(now, true); lastFx = now; } // the still frame the layer rests on
    setResting(anim && !awake);
    if (raf) return;
    if (camMoving || moving || dirty.base || dirty.layout || dirty.focus || dirty.labels || labelsBusy) raf = requestAnimationFrame(frame);
    // only the glow is moving: wake up 30 (or 15) times a second, not 60, and not at all off screen, in a hidden tab, with less motion
    // or once it rests
    else if (awake) { lastFrame = 0; clearTimeout(idleTimer); idleTimer = setTimeout(() => { idleTimer = 0; if (!raf) raf = requestAnimationFrame(frame); }, Math.max(0, fxStep - 12 - (performance.now() - lastFx))); }
    else lastFrame = 0;
  }
  let idleTimer = 0;
  function kick() { dirty.fx = true; lastActive = performance.now(); if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; } if (!raf && loaded && W) raf = requestAnimationFrame(frame); }
  const ripple = (c, col = "255,200,87") => { if (reduced) return; ripples.push({ lon: c.lon, lat: c.lat, t0: performance.now(), col }); kick(); };

  function nearest(px, py, maxPx = 16) {
    let best = null, bd = maxPx * maxPx;
    const minPop = dotMinPop();
    for (const c of cities) {
      if (c.pop < minPop) break;
      if (parts.has(c.id)) continue;
      const x = sx(c.lon), y = sy(c.lat);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bd || (d === bd && best && c.pop > best.pop)) { bd = d; best = c; }
    }
    for (const id of specialIds()) { // founded, choosing and the selected city show at every zoom, whatever their size
      const c = byId.get(id); if (!c || parts.has(c.id)) continue;
      const d = (sx(c.lon) - px) ** 2 + (sy(c.lat) - py) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  /** The chip under the pointer (each one answers in at least 44 × 44 px). */
  function chipAt(px, py) {
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i], c = byId.get(l.id); if (!c || l.tier === "C") continue;
      const x = sx(c.lon) + l.dx, y = sy(c.lat) + l.dy, w = Math.max(44, l.w), h = Math.max(44, l.h);
      const cx = x + l.w / 2, cy = y + l.h / 2;
      if (Math.abs(px - cx) <= w / 2 && Math.abs(py - cy) <= h / 2) return c;
    }
    return null;
  }
  /** The city under the pointer: a chip, a nearby dot first (small cities stay easy to hit), then the area around it. */
  function pick(px, py, maxPx) {
    const chip = chipAt(px, py);
    if (chip) return chip;
    const c = nearest(px, py, k >= AREA_K ? Math.min(maxPx, 9) : maxPx);
    if (c || k < 3) return c;
    const id = areaIdAt(...toLonLat(px, py));
    return id ? byId.get(id) || null : null;
  }
  const areaNote = (a, c) => {
    if (!a) return "";
    const plus = c && (members.get(c.id) || []).some((m) => joined.has(m.id)) ? " + nearby towns" : "";
    return `${a.kind === "r" ? "Official boundary + nearest land" : "Nearest land"}${plus} · ${a.km2 >= 10 ? fmt(a.km2) : a.km2.toFixed(1)} km²`;
  };
  // "One coin for Manhattan, Brooklyn, Queens and 38 more listed places"
  const sharedNote = (c) => {
    const m = (members.get(c.id) || []).slice().sort((a, b) => b.pop - a.pop);
    if (!m.length) return "";
    const names = m.slice(0, 3).map((x) => x.name).join(", ");
    return m.length > 3 ? `One coin for ${names} and ${m.length - 3} more listed places` : `One coin, including ${names}`;
  };
  function showTip(c, px, py) {
    if (!c) { tip.hidden = true; return; }
    const cl = claims.get(c.id), tk = tickers.get(c.id), a = areaFacts(c.id);
    tip.replaceChildren(el("strong", null, c.name), el("span", null, ` ${placeOf(c)}`), document.createElement("br"),
      el("span", cl ? "tip-claimed" : "tip-open", cl ? `Founder: ${cl.founder || cl.wallet}${cl.status === "active" ? "" : ` (${cl.status})`}` : windows.has(c.id) ? `Choosing its founder: ${windows.get(c.id).applicants} applying` : "Open"), el("span", "tip-ticker", tk ? `  $${tk.ticker}` : ""));
    tip.append(document.createElement("br"), el("span", "tip-area", `Founder amount: ${short(founderMin(c, windows.get(c.id)))} $VICINITY`));
    if (a) tip.append(document.createElement("br"), el("span", "tip-area", areaNote(a, c)));
    const n = (members.get(c.id) || []).length;
    if (n) tip.append(document.createElement("br"), el("span", "tip-area", `Includes ${n} listed place${n === 1 ? "" : "s"}`));
    tip.style.left = `${Math.min(W - 10, Math.max(10, px))}px`; tip.style.top = `${py}px`; tip.hidden = false;
  }
  const cityCount = (cc) => cities.reduce((n, c) => n + (c.cc === cc && !parts.has(c.id)), 0);
  function showCountryTip(w, px, py) {
    const n = cityCount(w.cc);
    tip.replaceChildren(el("strong", null, countries[w.cc] || w.cc), document.createElement("br"),
      el("span", "tip-open", n ? `${fmt(n)} ${n === 1 ? "city" : "cities"} · click to zoom in` : "No listed cities yet"));
    tip.style.left = `${Math.min(W - 10, Math.max(10, px))}px`; tip.style.top = `${py}px`; tip.hidden = false;
  }

  /* ---------- the city in focus: the card at the bottom of the map, for the city under the crosshair ---------- */
  let focusSig = "", sayTimer = 0, nearestGo = null, swapping = 0;
  /** Which city the card shows: pinned (your city, a ?city= link, the one nearest the crosshair at the start, a pick) until the person moves the map, then the one under the crosshair. */
  function updateFocus() {
    if (!cities.length) return;
    let id = null;
    if (focusPinned && !userMoved && byId.has(focusPinned)) id = focusPinned;
    else {
      const [lon, lat] = toLonLat(fcx, fcy);
      const inside = k >= 2 ? areaIdAt(lon, lat) : null;
      const cands = [];
      for (const c of shown) { if (!isCommunity(c)) continue; const d = Math.hypot(sx(c.lon) - fcx, sy(c.lat) - fcy); if (d <= 70) cands.push({ id: c.id, d }); }
      id = chooseFocus(cands, inside && isCommunity(byId.get(inside) || { id: inside }) ? inside : null, focusId);
    }
    if (id !== focusId) { focusId = id; dirty.labels = dirty.layout = dirty.base = true; kick(); }
    renderFocus();
  }
  const FOCUS_TAG = { open: ["tag tag--ok", "Open"], choosing: ["tag tag--gold", "Choosing"], founded: ["tag tag--no", "Founded"], mine: ["tag tag--warn", "Yours"] };
  function renderFocus() {
    const c = focusId ? byId.get(focusId) : null;
    const name = $("#mf-name"), where = $("#mf-where"), mini = $("#mf-mini"), tag = $("#mf-status"), tk = $("#mf-ticker"), amount = $("#mf-amount"), areaEl = $("#mf-area"), line = $("#mf-line"), go = $("#mf-open");
    focusEl.classList.remove("is-loading", "is-error");
    if (!c) {
      // nothing under the crosshair: the nearest community, with a button that flies there
      const [lon, lat] = toLonLat(fcx, fcy), near = nearestCommunities(lon, lat, 1)[0];
      const sig = "none|" + (near ? near[0].id + "|" + Math.round(near[1]) : "");
      if (sig === focusSig) return;
      focusSig = sig; nearestGo = near ? near[0] : null; swapping++; focusEl.classList.remove("is-swapping"); // a city still fading in is dropped
      focusEl.dataset.status = "none";
      name.textContent = "No community here"; tk.textContent = ""; mini.textContent = ""; tag.hidden = true;
      where.textContent = "Nothing at the crosshair"; amount.textContent = near ? `Nearest: ${near[0].name}, ${near[1] < 10 ? near[1].toFixed(1) : fmt(near[1])} km` : "";
      areaEl.textContent = near ? `${placeOf(near[0])}` : ""; line.textContent = "Move the map, or go to the nearest one.";
      go.disabled = !near; go.textContent = "Go"; go.setAttribute("aria-label", near ? `Go to ${near[0].name}` : "Go");
      announce(near ? `No community at the crosshair. Nearest: ${near[0].name}, ${Math.round(near[1])} km.` : "No community at the crosshair.");
      return;
    }
    nearestGo = null;
    const st = statusOf(c), cl = claims.get(c.id), win = windows.get(c.id), t = tickerOf(c), a = areaFacts(c.id);
    const amt = `${compact.format(founderMin(c, win))} $VICINITY`, n = (members.get(c.id) || []).length;
    const m = memberCount.get(c.id) || 0, h = holderCount.get(c.id) || 0;
    let l4;
    if (st === "mine") l4 = `You founded ${c.name}`;
    else if (st === "founded") l4 = `${cl.status === "provisional" ? "Founder chosen" : "Founder"} ${cl.founder ? "@" + cl.founder : cl.wallet || ""}${membersKnown ? ` · ${fmt(h)} holder${h === 1 ? "" : "s"}` : ""}`;
    else if (st === "choosing") l4 = `${win.applicants} applying · closes in ${until(win.closesAt, Date.now())}`;
    else l4 = `No founder yet${membersKnown ? ` · ${fmt(m)} member${m === 1 ? "" : "s"}` : ""}`;
    // the area first, so a narrow screen that cuts the line keeps the number
    const plus = (members.get(c.id) || []).some((x) => joined.has(x.id)) ? " + nearby towns" : "";
    const r3 = a ? `${a.km2 >= 10 ? fmt(a.km2) : a.km2.toFixed(1)} km² · ${a.kind === "r" ? "Official boundary + nearest land" : "Nearest land"}${plus}${n ? ` · Includes ${n} listed place${n === 1 ? "" : "s"}` : ""}`
      : ov.failed ? "Boundary shows when you zoom in" : "Boundary loading…";
    const sig = [c.id, st, t, amt, r3, l4].join("|");
    if (sig === focusSig) return;
    // the card fades only when another city comes into focus; new numbers for the same city (the countdown, a member) go in at once
    const swap = Boolean(focusSig) && !reduced && focusSig.split("|")[0] !== c.id;
    focusSig = sig;
    const fill = () => {
      focusEl.dataset.status = st;
      name.textContent = c.name; where.textContent = placeOf(c);
      const [cls, word] = FOCUS_TAG[st];
      tag.className = `${cls} map-focus__status`; tag.textContent = word; tag.hidden = false; // "Choosing": how many apply and when it closes are on the last line
      mini.textContent = `${word} · ${compact.format(founderMin(c, win))}`;
      tk.textContent = t ? `$${t}` : ""; amount.textContent = `Founder amount ${amt}`;
      areaEl.textContent = r3;
      line.replaceChildren(document.createTextNode(l4));
      if (st === "mine") { const d = el("a", null, "dashboard ›"); d.href = "/dashboard"; line.append(document.createTextNode(" · "), d); }
      go.disabled = false; go.textContent = "›"; go.setAttribute("aria-label", `Show ${c.name}'s full details`);
    };
    const turn = ++swapping; // only the latest city fills the card (a quick pan can ask for several within 140 ms)
    // every path that fills the card ends the fade: a refresh of the numbers (focusSig reset) fills at once and must not leave a
    // fade that an older turn started (its timer sees a newer turn and returns), or the card stays blank
    if (swap) { focusEl.classList.add("is-swapping"); setTimeout(() => { if (turn !== swapping) return; fill(); focusEl.classList.remove("is-swapping"); }, 140); }
    else { fill(); focusEl.classList.remove("is-swapping"); }
    // said once per city and status: the countdown stays on the card only (re-reading the whole sentence every minute is noise)
    announce(`In focus: ${c.name}, ${placeOf(c)}. ${st === "choosing" ? `Choosing its founder, ${win.applicants} applying` : STATUS_WORD[st]}.${t ? ` $${t}.` : ""} Founder amount ${amt}.${a ? ` ${areaNote(a, c)}.` : ""}${st === "choosing" ? "" : ` ${l4}.`}`);
  }
  /** Screen readers hear the city in focus once the map rests (not on every step of a pan). */
  function announce(text) { clearTimeout(sayTimer); sayTimer = setTimeout(() => { const s = $("#mf-say"); if (s.textContent !== text) s.textContent = text; }, 600); }
  $("#mf-open").addEventListener("click", () => {
    if (nearestGo) { const c = nearestGo; focusPinned = c.id; pinnedBy = "pick"; userMoved = false; flyToCity(c); return; }
    const c = focusId && byId.get(focusId);
    if (!c) return;
    select(c, false);
    $("#claim-panel").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  });
  $("#mf-fold").addEventListener("click", () => {
    const folded = !focusEl.classList.contains("is-folded");
    focusEl.classList.toggle("is-folded", folded); wrapEl.classList.toggle("is-folded", folded);
    const b = $("#mf-fold"); b.setAttribute("aria-expanded", String(!folded)); b.setAttribute("aria-label", folded ? "Unfold the city card" : "Fold the city card"); b.textContent = folded ? "▴" : "▾";
    try { localStorage.setItem("vicinity-map-card", folded ? "folded" : "open"); } catch {}
    requestAnimationFrame(() => { const [lon, lat] = toLonLat(fcx, fcy); measureOverlays(); tx = fcx - wx(lon) * k; ty = fcy - wy(lat) * k; clampView(); viewMoved(); });
  });
  try { if (localStorage.getItem("vicinity-map-card") === "folded") { focusEl.classList.add("is-folded"); wrapEl.classList.add("is-folded"); const b = $("#mf-fold"); b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-label", "Unfold the city card"); b.textContent = "▴"; } } catch {}

  // pointer: drag to move (it glides on after a flick), pinch or double-tap to zoom, tap to pick a city (or a country when zoomed out).
  // Heard on the whole stage (the base canvas may be moved by the compositor mid-gesture), except on the controls and the city card.
  const pts = new Map();
  let drag = null, lastTap = null, wheelOK = false;
  let stageRect = null; // the stage's place, read once per gesture (reading it on every move would force a layout each time)
  const local = (e) => { const r = (pts.size && stageRect) || wrapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onMap = (e) => !(e.target instanceof Element) || !e.target.closest(".map-ctrl, .map-focus, .map-exit, .map-hint");
  wrapEl.addEventListener("pointerdown", (e) => {
    if (!loaded || !onMap(e)) return;
    wrapEl.setPointerCapture(e.pointerId);
    if (!pts.size) stageRect = wrapEl.getBoundingClientRect();
    const [x, y] = local(e);
    pts.set(e.pointerId, { x, y });
    cam = null; // a touch stops whatever the map was doing (and the zoom it stopped at is always a real one)
    if (!(k >= 1 && k <= MAXK)) { zoomTo(fcx, fcy, k); viewMoved(true); }
    drag = { x, y, tx, ty, moved: false, pinch: pts.size === 2 ? pinchInfo() : null, hist: [[performance.now(), x, y]] };
    wheelOK = true; $("#map-hint").classList.remove("is-shown");
  });
  function pinchInfo() { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k }; }
  wrapEl.addEventListener("pointermove", (e) => {
    if (!loaded) return;
    if (!pts.has(e.pointerId) && !onMap(e)) { if (hover || hoverCountry) { hover = null; hoverCountry = null; dirty.labels = true; kick(); } tip.hidden = true; return; }
    const [x, y] = local(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x, y });
    if (drag && pts.size === 2) {
      const p = pinchInfo();
      if (!drag.pinch) drag.pinch = p;
      cam = null; userMoved = true;
      zoomAt(p.cx, p.cy, (p.d / Math.max(1, drag.pinch.d)) * drag.pinch.k / k); drag.moved = true; return;
    }
    if (drag && pts.size === 1) {
      if (Math.hypot(x - drag.x, y - drag.y) > 5) drag.moved = true;
      if (drag.moved && canPan()) {
        cam = null; userMoved = true;
        tx = drag.tx + (x - drag.x); ty = drag.ty + (y - drag.y); clampView(); viewMoved(true); canvas.classList.add("is-dragging");
        const now = performance.now(); drag.hist.push([now, x, y]); while (drag.hist.length > 2 && now - drag.hist[0][0] > 100) drag.hist.shift();
      }
      return;
    }
    if (e.pointerType === "mouse") {
      const c = pick(x, y, 16);
      const w = !c && k < 3 ? countryAt(...toLonLat(x, y)) : null;
      if (c !== hover || w !== hoverCountry) { hover = c; hoverCountry = w; dirty.labels = true; kick(); }
      canvas.style.cursor = c || w ? "pointer" : "";
      if (c) showTip(c, x, y - 14); else if (w) showCountryTip(w, x, y - 14); else tip.hidden = true;
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const was = drag; pts.delete(e.pointerId);
    canvas.classList.remove("is-dragging");
    if (pts.size) { const [rest] = [...pts.values()]; drag = { x: rest.x, y: rest.y, tx, ty, moved: true, pinch: null, hist: [[performance.now(), rest.x, rest.y]] }; return; }
    drag = null;
    if (!was || e.type === "pointercancel") return;
    const [x, y] = local(e), now = performance.now();
    if (was.moved) {
      // a flick glides on: the speed of the last 80 ms, slowing down by 8% a frame
      const h = was.hist.filter((p) => now - p[0] <= 80);
      if (!reduced && !was.pinch && h.length >= 2) {
        const [t0, x0, y0] = h[0], dt = Math.max(1, now - t0), vx = (x - x0) / dt, vy = (y - y0) / dt;
        if (Math.hypot(vx, vy) > 0.25) { cam = { kind: "fling", vx, vy }; kick(); }
      }
      viewMoved(true);
      return;
    }
    if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) { lastTap = null; userMoved = true; zoomStep(x, y, 2.4, 320); return; }
    lastTap = { t: now, x, y };
    const c = pick(x, y, e.pointerType === "mouse" ? 14 : 22);
    if (c) { select(c, true); ripple(c); return; }
    const w = k < 3 ? countryAt(...toLonLat(x, y)) : null;
    if (w && cityCount(w.cc)) { countryEl.value = w.cc; renderList(); userMoved = true; flyToCountry(w.cc); hoverCountry = null; tip.hidden = true; }
    // zoomed in on land that no community covers: offer the three nearest
    else if (k >= AREA_K && countryAt(...toLonLat(x, y))) { const [lon, lat] = toLonLat(x, y); if (!reduced) ripples.push({ lon, lat, t0: performance.now(), col: "127,163,214" }); showNearby(lon, lat); }
  };
  wrapEl.addEventListener("pointerup", end);
  wrapEl.addEventListener("pointercancel", end);
  wrapEl.addEventListener("pointerleave", () => { if (hover || hoverCountry) { hover = null; hoverCountry = null; dirty.labels = true; kick(); } tip.hidden = true; });
  wrapEl.addEventListener("mouseleave", () => { wheelOK = false; });
  wrapEl.addEventListener("wheel", (e) => {
    if (!loaded || !onMap(e)) return;
    if (!wheelOK && !e.ctrlKey && !e.metaKey && !full) { $("#map-hint").classList.add("is-shown"); clearTimeout(canvas._h); canvas._h = setTimeout(() => $("#map-hint").classList.remove("is-shown"), 1600); return; }
    e.preventDefault(); userMoved = true;
    const [x, y] = local(e), f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022));
    if (reduced) { cam = null; zoomAt(x, y, f); return; }
    // the zoom eases toward where the wheel asks, around the pointer
    const base = cam && cam.kind === "wheel" ? cam.kT : k;
    cam = { kind: "wheel", kT: Math.min(MAXK, Math.max(1, base * f)), px: x, py: y };
    viewMoved(true);
  }, { passive: false });
  // keyboard: arrows move, + / − zoom, Enter opens the city in focus, Escape leaves the full-screen map (the map is focusable)
  canvas.addEventListener("focus", () => { wheelOK = true; });
  canvas.addEventListener("keydown", (e) => {
    if (!loaded) return;
    const pan = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[e.key];
    if (pan) { e.preventDefault(); cam = null; userMoved = true; tx += pan[0]; ty += pan[1]; clampView(); viewMoved(true); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); cam = null; userMoved = true; zoomStep(fcx, fcy, 1.6, 260); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); cam = null; userMoved = true; zoomStep(fcx, fcy, 1 / 1.6, 260); }
    else if (e.key === "Enter" && focusId && byId.get(focusId)) { e.preventDefault(); select(byId.get(focusId), false); }
  });
  $("#map-in").addEventListener("click", () => { userMoved = true; zoomStep(fcx, fcy, 1.8, 260); });
  $("#map-out").addEventListener("click", () => { userMoved = true; zoomStep(fcx, fcy, 1 / 1.8, 260); });
  $("#map-reset").addEventListener("click", () => { userMoved = true; const [lon, lat] = toLonLat(fcx, fcy); flyTo(lon, Math.max(-50, Math.min(70, lat)), 1); });
  // plain / coloured map switch (remembered on this device)
  function showStyle() {
    const b = $("#map-style"), colored = mapStyle === "colored";
    b.setAttribute("aria-pressed", String(colored));
    b.title = colored ? "Show the plain map" : "Show the coloured map";
    b.setAttribute("aria-label", b.title);
    canvas.classList.toggle("is-colored", colored);
    buildOvCache();
    markAll();
  }
  $("#map-style").addEventListener("click", () => {
    mapStyle = mapStyle === "colored" ? "plain" : "colored";
    try { localStorage.setItem("vicinity-map-style", mapStyle); } catch {}
    showStyle();
  });
  showStyle();
  // ⤢: the map over the whole screen (no Fullscreen API: an iPhone has none for a page element). ✕, Escape or Back close it.
  let full = false, inerted = [];
  /** While the map covers the screen, everything outside it is inert: Tab stays on the map's own controls (it used to walk on to the
   *  covered list, filters and feed, out of sight), and screen readers stay with the map. */
  function isolate(on) {
    for (const e of inerted) e.inert = false;
    inerted = [];
    if (!on) return;
    for (let n = wrapEl; n.parentElement && n !== document.body; n = n.parentElement)
      for (const sib of n.parentElement.children) if (sib !== n && !sib.inert && sib.tagName !== "SCRIPT") { sib.inert = true; inerted.push(sib); }
  }
  function setFull(on, fromHistory = false) {
    if (on === full) return;
    full = on;
    wrapEl.classList.toggle("is-full", on); document.documentElement.classList.toggle("map-is-full", on);
    isolate(on);
    const b = $("#map-full"); b.setAttribute("aria-pressed", String(on)); b.setAttribute("aria-label", on ? "Leave the full-screen map" : "Full-screen map"); b.title = b.getAttribute("aria-label"); b.textContent = on ? "⤡" : "⤢";
    $("#map-exit").hidden = !on;
    if (on && !fromHistory) { try { history.pushState({ vicinityMap: "full" }, ""); } catch {} }
    if (!on && !fromHistory && history.state && history.state.vicinityMap === "full") { try { history.back(); } catch {} }
    size();
    (on ? $("#map-exit") : b).focus({ preventScroll: true });
  }
  $("#map-full").addEventListener("click", () => setFull(!full));
  $("#map-exit").addEventListener("click", () => setFull(false));
  window.addEventListener("popstate", () => { if (full) setFull(false, true); });
  document.addEventListener("keydown", (e) => { if (full && e.key === "Escape") { e.preventDefault(); setFull(false); } });
  // ◎: find the city you're standing in (location is used on this device only, never sent)
  $("#map-locate").addEventListener("click", async () => {
    const b = $("#map-locate");
    if (!loaded || b.disabled) return;
    b.disabled = true; b.classList.add("is-busy");
    try {
      const loc = await V().getLocation();
      if (!reduced) ripples.push({ lon: loc.lon, lat: loc.lat, t0: performance.now(), col: "55,194,154" });
      const c = await findCityAt(loc.lon, loc.lat);
      const home = c && parts.has(c.id) ? byId.get(parts.get(c.id)) : c;
      if (home) { select(home, true); V().toast?.(`📍 You're in ${home.name}`); }
      else { userMoved = true; flyTo(loc.lon, loc.lat, 60); showNearby(loc.lon, loc.lat); V().toast?.("No community here yet: pick one of the three nearest."); }
    } catch (e) { V().toast?.(e?.inApp ? `${e.message} Open vicinity.city in Safari or Chrome to see where you are.` : e?.message || "Couldn't get your location."); }
    finally { b.disabled = false; b.classList.remove("is-busy"); }
  });
  let sizing = 0;
  const resized = () => { if (!loaded || sizing) return; sizing = requestAnimationFrame(() => { sizing = 0; size(); }); };
  window.addEventListener("resize", resized);
  if (window.ResizeObserver) new ResizeObserver(resized).observe(wrapEl);
  // back on the tab: the founders and members may have changed while it was hidden (the 30 s refresh skips a hidden tab)
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { dirty.fx = true; kick(); if (sec.classList.contains("is-ready") && Date.now() - lastRefresh >= 30000) refreshAll(); } });
  // on screen or not: the stage (the base canvas itself may be moved by the compositor for a moment)
  new IntersectionObserver((es) => { onScreen = es.some((x) => x.isIntersecting); fxCanvas.classList.toggle("mo-off", !onScreen); if (onScreen) markAll(); }).observe(wrapEl);

  /* =================== search list =================== */
  function renderList() {
    const q = norm(qEl.value.trim()), cc = countryEl.value, f = filterEl.value;
    const pass = (c) => (!cc || c.cc === cc) && (f === "all" || (f === "claimed") === claims.has(c.id));
    let hits;
    if (q) {
      const starts = [], has = [];
      for (const c of cities) { if (!pass(c)) continue; if (c.n.startsWith(q)) starts.push(c); else if (c.n.includes(q)) has.push(c); }
      hits = starts.concat(has);
    } else hits = cities.filter(pass);
    const total = hits.length; hits = hits.slice(0, 60);
    $("#city-count").textContent = total > 60 ? `Showing 60 of ${fmt(total)}. Type to narrow it down.` : `${fmt(total)} ${total === 1 ? "city" : "cities"}`;
    if (!hits.length) { listEl.replaceChildren(el("li", "muted", q ? "No match. You can add it below." : "Nothing here yet.")); return; }
    listEl.replaceChildren(...hits.map((c) => {
      const li = document.createElement("li");
      const b = el("button", "city-row" + (selected === c ? " is-selected" : "")); b.type = "button";
      const tk = tickers.get(c.id);
      const nm = el("span", "city-row__name");
      nm.append(el("strong", null, c.name), el("span", null, `${placeOf(c)}${c.pop ? " · " + fmt(c.pop) : ""}${c.added ? " · community-added" : ""}${tk ? " · $" + tk.ticker : ""}`));
      const cl = claims.get(c.id), mine = isMine(cl), parent = parts.has(c.id) && byId.get(parts.get(c.id));
      b.append(nm, parent ? el("span", "tag", `Part of ${parent.name}`)
        : outside.has(c.id) ? el("span", "tag", "No community yet")
        : el("span", mine ? "tag tag--warn" : cl ? "tag tag--no" : windows.has(c.id) ? "tag tag--gold" : "tag tag--ok", mine ? "Yours" : cl ? "Founded" : windows.has(c.id) ? "Choosing" : "Open"));
      b.addEventListener("click", () => select(c, true));
      li.append(b); return li;
    }));
  }
  let typing; qEl.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(renderList, 120); });
  countryEl.addEventListener("change", () => { renderList(); if (countryEl.value) { userMoved = true; flyToCountry(countryEl.value); } });
  filterEl.addEventListener("change", renderList);

  /* =================== coin preview + moderator =================== */
  function renderCoin(c) {
    const box = $("#coin-preview");
    if (!c) { box.hidden = true; return; }
    const tk = tickers.get(c.id) || { ticker: (c.name || "CITY").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10), shared: 1 };
    box.hidden = false;
    $("#coin-face").textContent = tk.ticker.slice(0, 4);
    $("#coin-ticker").textContent = `$${tk.ticker}`;
    $("#coin-name").textContent = `${c.name} Coin`;
    $("#coin-where").textContent = `${placeOf(c)} · city #${c.id}`;
    const note = $("#coin-same");
    if (tk.shared > 1) {
      note.hidden = false;
      note.textContent = tk.ticker === tk.base
        ? `${tk.shared} listed places share the name "${c.name}". This one is the biggest, so it keeps $${tk.ticker}; the others add their country or state code.`
        : `${tk.shared} listed places share the name "${c.name}". The biggest keeps $${tk.base}; this one is $${tk.ticker}.`;
    } else note.hidden = true;
    const coin = $("#coin-disc");
    coin.classList.remove("is-flip"); void coin.offsetWidth; if (!reduced) coin.classList.add("is-flip");
  }
  const modCache = new Map();
  async function renderModerator(c) {
    const row = $("#mod-row");
    if (!c) { row.hidden = true; return; }
    row.hidden = false;
    const cname = countries[c.cc] || c.cc;
    row.replaceChildren(el("span", "mod-row__icon", "🛡"), el("span", null, `Country moderator (${cname}): loading…`));
    try {
      let d = modCache.get(c.cc);
      if (!d) { d = await (await fetch(`/api/moderator?country=${c.cc}`)).json(); modCache.set(c.cc, d); }
      if (selected !== c && mode === "claim") return;
      const txt = el("span");
      if (d.moderator) {
        txt.append(document.createTextNode(`Country moderator (${cname}): `), solscan(d.moderator.wallet),
          document.createTextNode(` · founder of ${d.moderator.city} · holds ${fmt(d.moderator.amount)} $VICINITY`));
      } else txt.textContent = `Country moderator (${cname}): ${d.launched ? "no founders here yet." : "picked at launch."} It's the city founder in ${cname} who holds the most $VICINITY.`;
      row.replaceChildren(el("span", "mod-row__icon", "🛡"), txt);
    } catch { row.replaceChildren(el("span", "mod-row__icon", "🛡"), el("span", null, `Country moderator (${cname}): the city founder holding the most $VICINITY.`)); }
  }

  /* =================== empty land: pick one of the three nearest communities =================== */
  let outside = new Set(); // listed places too small to be a community, in empty land
  let nearby = null;       // { name, list: [[city, km], …] } while the panel offers nearby communities
  function nearestCommunities(lon, lat, n = 3) {
    const best = [];
    for (const c of cities) {
      if (parts.has(c.id) || outside.has(c.id)) continue;
      const d = kmBetween(lat, lon, c.lat, c.lon);
      if (best.length === n && d >= best[n - 1][1]) continue;
      best.push([c, d]); best.sort((a, b) => a[1] - b[1]); if (best.length > n) best.pop();
    }
    return best;
  }
  /** "No community here yet": offer the three nearest communities (their coin, leaderboard and check-ins). */
  function showNearby(lon, lat, name = null) {
    mode = "nearby"; selected = null;
    nearby = { name, list: nearestCommunities(lon, lat) };
    refreshPanel(); renderList(); renderCoin(null); $("#mod-row").hidden = true;
    markAll();
  }

  /* =================== city panel: claiming happens in the dashboard =================== */
  function refreshPanel() {
    $("#claim-reqs").hidden = mode === "nearby";
    const myCity = me() ? [...claims.entries()].find(([, v]) => isMine(v)) : null;
    const sub = $("#claim-sub"), mrow = $("#members-row");
    mrow.hidden = true;
    if (mode === "nearby" && nearby) {
      $("#claim-kicker").textContent = "No community here yet";
      $("#claim-title").textContent = nearby.name ? `${nearby.name} isn't a community yet` : "This spot isn't in a community yet";
      sub.replaceChildren(document.createTextNode("Join one of the nearest communities: its coin, leaderboard, check-ins and votes."));
      const ul = el("ul", "nearby-list");
      for (const [c, d] of nearby.list) {
        const b = el("button", "city-row"); b.type = "button";
        const nm = el("span", "city-row__name");
        nm.append(el("strong", null, c.name), el("span", null, `${placeOf(c)} · ${d < 10 ? d.toFixed(1) : Math.round(d)} km away`));
        b.append(nm, el("span", "tag tag--ok", "Join"));
        b.addEventListener("click", () => select(c, true));
        const li = document.createElement("li"); li.append(b); ul.append(li);
      }
      sub.append(ul, el("span", "tiny muted", "Is your town missing? Ask for it from your dashboard, standing in it; your Country Manager approves new communities."));
    } else if (selected) {
      const cl = claims.get(selected.id);
      $("#claim-kicker").textContent = cl ? (cl.status === "provisional" ? "Founder chosen · objection period" : "Founded") : windows.has(selected.id) ? "Choosing its founder now" : "Open city";
      $("#claim-title").textContent = selected.name;
      sub.textContent = `${placeOf(selected)}${selected.pop ? " · " + fmt(selected.pop) + " people" : ""}`;
      const a = areaFacts(selected.id);
      if (a) sub.append(document.createElement("br"), el("span", a.kind === "r" ? "area-note" : "area-note area-note--near", areaNote(a, selected)));
      const shared = sharedNote(selected);
      if (shared) sub.append(document.createElement("br"), el("span", "shared-note", shared));
      if (cl) sub.append(document.createElement("br"), document.createTextNode(`City Founder: ${cl.founder} `), walletText(cl.wallet), document.createTextNode(` · since ${new Date(cl.claimed_at).toLocaleDateString()}${cl.status === "grace" ? " · in grace" : ""}`));
      else sub.append(document.createElement("br"), document.createTextNode("City Founder: No city founder yet"));
      sub.append(document.createElement("br"), document.createTextNode(`Holders: ${fmt(holderCount.get(selected.id) || 0)}`));
      const win = windows.get(selected.id);
      sub.append(document.createElement("br"), document.createTextNode(`Founder amount: ${fmt(founderMin(selected, win))} $VICINITY · held ${qualifyingDays} days`));
      if (!cl && win) sub.append(document.createElement("br"), el("span", "shared-note", `${win.applicants} applying · window closes ${new Date(win.closesAt).toLocaleString()}`));
      const m = memberCount.get(selected.id) || 0;
      mrow.hidden = false;
      mrow.textContent = m ? `👥 ${fmt(m)} verified member${m === 1 ? "" : "s"} call ${selected.name} home${cl ? "" : " · founder seat open"}` : `👥 No members yet. Be the first to call ${selected.name} home.`;
    }
    // the button always leads to the dashboard, where wallet, holdings and location are checked together
    let label = "Claim a city in your dashboard →", href = "/dashboard";
    if (mode === "nearby") label = "Pick a community above";
    else if (myCity) { label = `You founded ${myCity[1].city_name} · open dashboard →`; }
    else if (selected && claims.has(selected.id)) { label = `${selected.name} has a founder · see your dashboard →`; }
    else if (selected && windows.has(selected.id)) { label = `${selected.name} is choosing its founder · apply or endorse in your dashboard →`; href = `/dashboard?claim=${encodeURIComponent(selected.id)}`; }
    else if (selected) { label = open ? `Apply to found ${selected.name} in your dashboard →` : `Get ready to found ${selected.name} →`; href = `/dashboard?claim=${encodeURIComponent(selected.id)}`; }
    btn.textContent = label; btn.href = href;
    const note = $("#claim-note");
    note.textContent = !open ? "Applications open after $VICINITY launches, for people who have held the founder amount for 7 days. There's no race: each city gets a 72-hour window and locals decide."
      : selected && myHome() && myHome() !== selected.id ? "You can only found the community you live in. Your dashboard shows yours."
      : "The first qualified claimer becomes Seed Steward at once (90-day probation, locals can challenge). If several claim together, a 72-hour window decides: 50% endorsements, 30% contribution, 20% holdings. Apply or endorse in your dashboard.";
  }
  function select(c, fly = false) {
    // too small to be a community, in empty land: offer the three nearest communities
    if (outside.has(c.id)) {
      if (fly) { userMoved = true; flyTo(c.lon, c.lat, Math.max(k, 60)); }
      return showNearby(c.lon, c.lat, c.name);
    }
    // a neighbourhood inside another city's official boundary belongs to that city
    if (parts.has(c.id) && byId.get(parts.get(c.id))) {
      const home = byId.get(parts.get(c.id));
      V().toast?.(`${c.name} is part of ${home.name}`);
      c = home;
    }
    mode = "claim"; selected = c;
    // the card shows the city you picked; once you move the map it follows the crosshair again
    focusPinned = c.id; pinnedBy = "pick"; userMoved = false;
    refreshPanel(); renderList(); renderCoin(c); renderModerator(c);
    if (fly) flyToCity(c);
    // the boundary may still be loading: show it (and re-frame the map) once it's here
    // (even mid-flight: a flight framed on a guess would end with the boundary cut off at both sides; never once the person moved the map)
    if (!areas.has(c.id)) loadBounds(c.cc).then(() => { if (selected !== c) return; refreshPanel(); if (fly && areas.has(c.id) && !userMoved && focusPinned === c.id) flyToCity(c); });
    markAll();
  }
  document.addEventListener("vicinity:me", () => { if (loaded) { refreshPanel(); renderList(); goHome(); markAll(); } });
  /** A signed-in person with a home city who arrived without ?city=: the map opens on their city, and the card shows it. */
  function goHome() {
    const h = myHome(), c = h && byId.get(String(h));
    if (!c || userMoved || selected || (focusPinned && pinnedBy !== "nearest")) return;
    focusPinned = c.id; pinnedBy = "home";
    k = 4; tx = fcx - wx(c.lon) * k; ty = fcy - wy(c.lat) * k; clampView(); viewMoved();
  }

  /* =================== live claims feed + stats =================== */
  function updateStats() {
    const communities = cities.length - parts.size - outside.size;
    $("#cs-cities").textContent = fmt(communities);
    $("#cs-countries").textContent = fmt(new Set(cities.map((c) => c.cc)).size);
    $("#cs-claimed").textContent = fmt(claims.size);
    $("#cs-open").textContent = fmt(Math.max(0, communities - claims.size));
    $("#cs-members").textContent = fmt(totalMembers);
    $("#cs-status").textContent = open ? "Open" : "At launch";
  }
  let membersSig = "";
  /** Where verified members call home (public counts only), and the communities filling up fastest. */
  async function refreshMembers() {
    const d = await V().api?.("/api/members");
    if (!d || !Array.isArray(d.communities)) return;
    totalMembers = d.members || 0;
    memberCount = new Map(d.communities.map((c) => [String(c.id), c.members]));
    holderCount = new Map(d.communities.map((c) => [String(c.id), c.holders || 0]));
    // nothing new: the card is written again (its countdown) but the map is not woken (its glow may be resting)
    const sig = JSON.stringify([d.members, d.communities]), same = membersKnown && sig === membersSig;
    membersSig = sig; membersKnown = true; focusSig = "";
    if (same) renderFocus(); else { dirty.focus = true; kick(); }
    updateStats();
    const list = $("#wanted-list");
    if (!d.communities.length) { list.replaceChildren(el("li", "muted", "No members yet. Sign in and set your home community to put your city on this list.")); return; }
    list.replaceChildren(...d.communities.slice(0, 24).map((c) => {
      const li = el("li"), city = byId.get(String(c.id)), cl = claims.get(String(c.id));
      const txt = el("div");
      txt.append(el("strong", null, c.name), el("span", null, `${countries[c.country] || c.country} · ${fmt(c.members)} member${c.members === 1 ? "" : "s"}`));
      li.append(txt, el("span", cl ? "tag tag--no" : "tag tag--ok", cl ? "Founded" : "Seat open"));
      if (city) {
        li.tabIndex = 0; li.style.cursor = "pointer";
        li.addEventListener("click", () => { select(city, true); sec.scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); });
      }
      return li;
    }));
  }
  function renderFeed(fresh = new Set()) {
    const feed = $("#claim-feed");
    const list = [...claims.values()].sort((a, b) => Date.parse(b.claimed_at) - Date.parse(a.claimed_at)).slice(0, 8);
    if (!list.length) { feed.replaceChildren(el("li", "claim-feed__empty", open ? "No founders yet. Qualify by holding for 7 days, then apply." : "No founders yet. Applications open after $VICINITY launches.")); return; }
    feed.replaceChildren(...list.map((c) => {
      const li = el("li", fresh.has(c.city_id) ? "is-new" : null);
      const city = byId.get(c.city_id);
      const go = el("button", "claim-feed__city", `📍 ${c.city_name}, ${c.country}`); go.type = "button";
      if (city) go.addEventListener("click", () => select(city, true));
      li.append(go, el("span", "muted", ` · ${c.status === "provisional" ? "chosen" : "founder"} ${c.founder} `), walletText(c.wallet), el("span", "muted", ` · ${ago(c.claimed_at)}`));
      return li;
    }));
  }
  // neighbourhoods that are part of another city don't get a coin of their own
  // One list of tickers for every page (public/data/tickers.json); computed here only if that file can't be loaded
  let tickerFile = null;
  function retick() {
    if (tickerFile) tickers = new Map(Object.entries(tickerFile).map(([id, v]) => [id, typeof v === "string" ? { ticker: v, base: v, shared: 1 } : { ticker: v[0], base: v[1], shared: v[2] }]));
    else tickers = window.vicinityTicker ? window.vicinityTicker.assign(cities.filter((c) => !parts.has(c.id))) : new Map();
  }

  let lastRefresh = 0;
  const refreshAll = () => { lastRefresh = Date.now(); refreshClaims(); refreshMembers(); };
  let firstClaims = true, claimsSig = "";
  let windows = new Map(); // cities choosing their founder right now
  /** Founder seats (founded, or chosen and in the objection period) and open application windows. */
  async function refreshClaims() {
    try {
      const d = await (await fetch("/api/seats", { cache: "no-store" })).json();
      if (!Array.isArray(d.seats)) return;
      const sig = JSON.stringify([d.seats, d.windows, d.launched]), same = !firstClaims && sig === claimsSig;
      claimsSig = sig;
      const list = d.seats.map((s) => ({ city_id: s.cityId, wallet: s.wallet, city_name: s.city, country: s.country, claimed_at: s.since, status: s.status, founder: s.founder }));
      const fresh = new Set();
      if (!firstClaims) for (const c of list) if (!claims.has(c.city_id)) {
        fresh.add(c.city_id); const city = byId.get(c.city_id);
        if (city) { ripple(city, "255,90,54"); popAt.set(city.id, performance.now()); V().toast?.(`🎉 ${city.name} has a founder`); }
      }
      firstClaims = false;
      claims = new Map(list.map((c) => [c.city_id, c]));
      windows = new Map((d.windows || []).map((w) => [w.cityId, w]));
      open = Boolean(d.launched);
      updateStats(); renderFeed(fresh);
      if (fresh.size) { renderList(); refreshPanel(); }
      focusSig = "";
      if (same) { renderFocus(); return; } // nothing new: the card's countdown moves on, the map (and its resting glow) is left alone
      chipCache.clear(); markAll();
    } catch {}
  }

  async function load() {
    if (loaded) return; loaded = true;
    // The Stake Ladder's numbers, applied when they land: /api/policy is a database round trip, so the map never waits for it.
    // The published numbers paint first; the panel re-renders only if the live policy differs (today it doesn't).
    fetch("/api/policy").then((r) => r.json()).then((pol) => {
      const L = pol?.policy?.founder?.ladder;
      if (L && ["base", "max", "refPop", "rung"].every((key) => Number.isFinite(L[key]) && L[key] > 0)) ladder = { base: L.base, max: L.max, refPop: L.refPop, rung: L.rung };
      if (Number.isFinite(pol?.policy?.founder?.qualifyingDays) && pol.policy.founder.qualifyingDays > 0) qualifyingDays = pol.policy.founder.qualifyingDays;
      chipCache.clear(); focusSig = ""; markAll(); // the chips and the city card say the founder amount too
      if (sec.classList.contains("is-ready")) refreshPanel();
    }).catch(() => {});
    // every city's outline, for the first view: fetched with the rest, parsed in small steps once the city list is in
    const overview = fetch("/data/bounds-overview.txt").then((r) => { if (!r.ok) throw new Error("overview"); return r.text(); });
    overview.catch(() => {});
    try {
      const [data, wd, bi, tf] = await Promise.all([
        fetch("/data/cities.json").then((r) => r.json()),
        fetch("/data/world.json").then((r) => r.json()).catch(() => null),        // map background (optional)
        fetch("/data/bounds/index.json").then((r) => r.json()).catch(() => null), // city boundaries (optional)
        fetch("/data/tickers.json").then((r) => r.json()).catch(() => null),      // every community's ticker (computed here if missing)
      ]);
      tickerFile = tf;
      countries = data.countries; admin = data.admin;
      readPalette();
      world = wd ? Object.entries(wd.countries).map(([cc, enc]) => { const area = enc.map((poly) => poly.map((r) => decodeRing(r, wd.unit))); return { cc, area, box: boxOf(area), path: toPath(area) }; }) : [];
      const boxArea = (b) => (b[2] - b[0]) * (b[3] - b[1]);
      colorize(world.slice().sort((p, q) => boxArea(q.box) - boxArea(p.box)), world, COUNTRY_COLORS.light.length);
      boundsIndex = bi?.countries || {}; boundsList = Object.entries(boundsIndex);
      parts = new Map(Object.entries(bi?.parts || {}));
      outside = new Set(bi?.outside || []);
      joined = new Set(bi?.joined || []);
      cities = Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map(([id, name, adm, lat, lon, pop]) => ({ id: String(id), name, cc, adm, lat, lon, pop, n: norm(name) })));
      cities.sort((a, b) => b.pop - a.pop);
      byId = new Map(cities.map((c) => [c.id, c]));
      members = new Map();
      for (const [child, parent] of parts) if (byId.has(child)) members.set(parent, [...(members.get(parent) || []), byId.get(child)]);
      retick();
      loadOverview(overview);
      await refreshClaims();
      retick();
      const counts = {}; for (const c of cities) if (!parts.has(c.id)) counts[c.cc] = (counts[c.cc] || 0) + 1;
      const opts = Object.keys(countries).sort((a, b) => countries[a].localeCompare(countries[b]));
      countryEl.append(...opts.filter((c) => counts[c]).map((c) => Object.assign(document.createElement("option"), { value: c, textContent: `${countries[c]} (${counts[c]})` })));
      sec.classList.add("is-ready");
      size(); renderList(); refreshPanel(); renderFeed(); refreshMembers();
      lastRefresh = Date.now();
      setInterval(() => { if (!document.hidden && onScreen && Date.now() - lastRefresh >= 25000) refreshAll(); }, 30000);
      // arriving with ?city=<id> (from other pages): open that city; signed in with a home city: start there; else the city nearest the
      // crosshair, with the map centred on it (as far as the world's edges allow), before anything is drawn
      const want = new URLSearchParams(location.search).get("city");
      if (want && byId.get(want)) select(byId.get(want), true);
      else goHome();
      if (!focusPinned) {
        const minPop = dotMinPop(), bottom = rects.card && rects.card[2] > W * 0.6 ? rects.card[1] : H, cands = [];
        for (const c of cities) {
          if (c.pop < minPop) break;
          if (!isCommunity(c)) continue;
          const x = sx(c.lon), y = sy(c.lat);
          if (x > 24 && x < W - 24 && y > 24 && y < bottom - 24) cands.push({ id: c.id, x, y, pop: c.pop });
        }
        const id = openingFocus(cands, fcx, fcy), c = id && byId.get(id);
        if (c) { focusPinned = c.id; pinnedBy = "nearest"; tx = fcx - wx(c.lon) * k; ty = fcy - wy(c.lat) * k; clampView(); viewMoved(); }
      }
      markAll();
    } catch {
      loaded = false;
      listEl.replaceChildren(el("li", "muted", "Couldn't load the city list. Refresh the page to try again."));
      focusEl.classList.remove("is-loading"); focusEl.classList.add("is-error");
      $("#mf-name").textContent = "Couldn't load the map"; $("#mf-area").textContent = ""; $("#mf-line").textContent = "";
      const go = $("#mf-open"); go.disabled = false; go.textContent = "↻"; go.setAttribute("aria-label", "Try loading the map again");
      go.addEventListener("click", () => location.reload(), { once: true });
    }
  }
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: "900px 0px" });
  io.observe(sec);
  if (location.hash === "#cities") load();
})();
