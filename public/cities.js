// Vicinity: the city map on /cities. Claimed vs open cities, live. Claiming itself happens in the dashboard.
// No trackers, nothing loaded from other sites. Needs site.js (window.V) and ticker.js (window.vicinityTicker).
(() => {
  "use strict";
  const sec = document.getElementById("cities");
  if (!sec) return;
  const $ = (s, r = document) => r.querySelector(s);
  const V = () => window.V || {};
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  // The founder minimum: the Stake Ladder of src/policy.js (founderAmount), 100K × (population ÷ 10K)^(1/3), clamped to 100K–1M and
  // rounded down to 10K, held for qualifyingDays. The numbers come from /api/policy once the page loads (one request, not one per
  // city); until then, and if that answer fails, these are the published ones (POLICY.founder.ladder / qualifyingDays).
  let ladder = { base: 100_000, max: 1_000_000, refPop: 10_000, rung: 10_000 }, qualifyingDays = 7;
  const ladderAmount = (pop, l) => Math.floor(Math.min(l.max, Math.max(l.base, l.base * Math.cbrt(Math.max(pop || 0, 1) / l.refPop))) / l.rung) * l.rung;
  /** What a founder of this city must hold: a seat keeps the bar it was claimed under (when /api/seats gives it), an open window shows the bar it opened with, otherwise the ladder for its population. */
  const founderMin = (c, cl, win) => (cl ? (cl.threshold > 0 ? { amount: cl.threshold, seat: true } : { amount: ladderAmount(c.pop, ladder), seat: false }) : { amount: win && win.threshold > 0 ? win.threshold : ladderAmount(c.pop, ladder), seat: false });
  const short = (n) => Number(n).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 }); // 180,000 → 180K · 1,000,000 → 1M

  const canvas = $("#city-canvas"), ctx = canvas.getContext("2d"), tip = $("#city-tip"), wrapEl = $(".citymap__stage");
  const listEl = $("#city-list"), qEl = $("#city-q"), countryEl = $("#city-country"), filterEl = $("#city-filter");
  const btn = $("#claim-btn");
  let cities = [], byId = new Map(), countries = {}, admin = {}, claims = new Map(), tickers = new Map(), open = false, loaded = false;
  let selected = null, mode = "claim", memberCount = new Map(), holderCount = new Map(), totalMembers = 0;
  // the signed-in person's wallet (to show "Yours"), from site.js
  const me = () => V().me?.()?.user?.wallet || null;
  const myHome = () => V().me?.()?.user?.home?.id || null;

  const placeOf = (c) => [admin[`${c.cc}.${c.adm}`], countries[c.cc] || c.cc].filter(Boolean).join(", ");

  /* =================== the map =================== */
  // World → screen: equirectangular, latitude 84°N … 60°S. view: zoom k, offset tx/ty (CSS px).
  // s0 = pixels per degree at zoom 1, chosen so the world always fills the map box (wide screens and phones).
  // Shapes are Path2D objects in "degree space" (x = lon + 180, y = 84 − lat), drawn with a single transform.
  let W = 0, H = 0, s0 = 1, dpr = 1, k = 1, tx = 0, ty = 0, hover = null, hoverCountry = null, onScreen = false, raf = 0, needDraw = true;
  const ripples = [];
  const wx = (lon) => (lon + 180) * s0;
  const wy = (lat) => (84 - lat) * s0;
  const sx = (lon) => wx(lon) * k + tx;
  const sy = (lat) => wy(lat) * k + ty;
  const clampView = () => { tx = Math.min(0, Math.max(W - 360 * s0 * k, tx)); ty = Math.min(0, Math.max(H - 144 * s0 * k, ty)); };
  const canPan = () => 360 * s0 * k > W + 1 || 144 * s0 * k > H + 1;
  const MAXK = 900;
  const AREA_K = 5; // city boundaries appear from this zoom

  // colours come from the theme (style.css --map-*), so the map follows the dark / light toggle
  let pal = {};
  function readPalette() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const light = document.documentElement.dataset.theme === "light";
    pal = { light, land: v("--map-land"), landLine: v("--map-land-line"), area: v("--map-area"), areaLine: v("--map-area-line"), dot: v("--map-dot"), label: v("--map-label"), halo: v("--map-halo"),
      hoverFill: light ? "rgba(43,91,255,.14)" : "rgba(127,163,214,.2)", claimedText: light ? "#C23A1C" : "#FFB39C",
      tagBg: light ? "rgba(255,255,255,.95)" : "rgba(7,14,25,.9)", tagText: light ? "#8A5A00" : "#FFE3A3", grid: light ? "rgba(11,22,38,.06)" : "rgba(149,162,184,.07)" };
    needDraw = true; kick();
  }
  window.addEventListener("vicinity:theme", readPalette);

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

  // ---- map data: country outlines + city boundaries (loaded one country at a time) ----
  let world = [];                // [{ cc, box, area, path }]
  let boundsIndex = {};          // cc → { box, bytes }
  let parts = new Map();         // neighbourhood id → id of the city it's part of (one coin per big city)
  let members = new Map();       // city id → the listed places that share its coin
  let joined = new Set();        // parts that were just outside the city and got added to its area
  const areas = new Map();       // city id → { kind: "r" official | "n" nearest land, box, area, path, km2 }
  const boundsLoads = new Map(); // cc → Promise
  function loadBounds(cc) {
    if (!boundsIndex[cc]) return Promise.resolve();
    if (!boundsLoads.has(cc)) {
      boundsLoads.set(cc, fetch(`/data/bounds/${cc}.txt`).then((r) => { if (!r.ok) throw new Error("bounds"); return r.text(); }).then((text) => {
        for (const line of text.split("\n")) {
          const [id, kind, box, json] = line.split("\t");
          if (!json) continue; // "part of" lines carry no shape
          const area = JSON.parse(json).map((poly) => poly.map((r) => decodeRing(r, 1e-4)));
          const a = { kind, box: box.split(",").map(Number), area, path: toPath(area), km2: kmArea(area) };
          areas.set(id, a);
        }
        colorize([...areas.values()].filter((a) => a.color == null).sort((p, q) => q.km2 - p.km2), [...areas.values()], AREA_COLORS.length);
        needDraw = true; kick();
      }).catch(() => { boundsLoads.delete(cc); }));
    }
    return boundsLoads.get(cc);
  }
  // the visible part of the world in degrees: [west, south, east, north]
  const view = () => { const s = s0 * k; return [-tx / s - 180, 84 - (H - ty) / s, (W - tx) / s - 180, 84 + ty / s]; };
  const boxInView = (b, v) => b[0] <= v[2] && b[2] >= v[0] && b[1] <= v[3] && b[3] >= v[1];
  const toLonLat = (px, py) => [(px - tx) / (s0 * k) - 180, 84 - (py - ty) / (s0 * k)];
  function loadVisible() { const v = view(); for (const [cc, x] of Object.entries(boundsIndex)) if (boxInView(x.box, v)) loadBounds(cc); }
  const countryAt = (lon, lat) => world.find((w) => inBox(lon, lat, w.box) && inArea(lon, lat, w.area)) || null;
  function cityAtPoint(lon, lat) {
    for (const [id, a] of areas) if (inBox(lon, lat, a.box) && inArea(lon, lat, a.area)) return byId.get(id) || null;
    return null;
  }
  /** Load every country file whose box holds the point, then find the city there. */
  async function findCityAt(lon, lat) {
    await Promise.all(Object.entries(boundsIndex).filter(([, x]) => inBox(lon, lat, x.box)).map(([cc]) => loadBounds(cc)));
    return cityAtPoint(lon, lat);
  }

  function size() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    // keep the same place in the middle when the box resizes
    const lon = W ? (W / 2 - tx) / (s0 * k) - 180 : 10, lat = H ? 84 - (H / 2 - ty) / (s0 * k) : 20;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height; s0 = Math.max(W / 360, H / 144);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    tx = W / 2 - wx(lon) * k; ty = H / 2 - wy(lat) * k; clampView();
    needDraw = true; kick();
  }
  const zoomLabel = () => { canvas.style.touchAction = k > 1.01 ? "none" : "pan-y"; $("#map-zoom-level").textContent = `${k < 10 ? k.toFixed(1) : Math.round(k)}×`; };
  function zoomAt(px, py, factor) {
    const nk = Math.min(MAXK, Math.max(1, k * factor));
    tx = px - (px - tx) * (nk / k); ty = py - (py - ty) * (nk / k); k = nk; clampView();
    zoomLabel(); needDraw = true; kick();
  }
  // Smooth "fly to" a place (used when you pick a city or a country).
  let flight = null;
  function flyTo(lon, lat, targetK, ms = 1100) {
    if (reduced || !onScreen || document.hidden) ms = 0; // off-screen: jump straight there
    const k0 = k, cx0 = (W / 2 - tx) / k, cy0 = (H / 2 - ty) / k;
    flight = { t0: performance.now(), ms, k0, k1: Math.min(MAXK, Math.max(1, targetK)), cx0, cy0, cx1: wx(lon), cy1: wy(lat) };
    if (!ms) stepFlight(performance.now());
    kick();
  }
  function stepFlight(now) {
    if (!flight) return;
    const f = flight, t = f.ms ? Math.min(1, (now - f.t0) / f.ms) : 1;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    k = Math.exp(Math.log(f.k0) + (Math.log(f.k1) - Math.log(f.k0)) * e);
    tx = W / 2 - (f.cx0 + (f.cx1 - f.cx0) * e) * k; ty = H / 2 - (f.cy0 + (f.cy1 - f.cy0) * e) * k; clampView();
    zoomLabel();
    if (t >= 1) flight = null;
    needDraw = true;
  }
  /** Fly so the box [west, south, east, north] fills most of the map. */
  function flyToBox(b, minK = 1) {
    const fit = Math.min(W / Math.max(0.02, (b[2] - b[0]) * s0), H / Math.max(0.02, (b[3] - b[1]) * s0)) * 0.72;
    flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.min(MAXK, Math.max(minK, fit)));
  }
  function flyToCity(c) {
    const a = areas.get(c.id);
    if (a) return flyToBox(a.box, AREA_K + 0.5);
    const r = radiusOf(c);
    flyTo(c.lon, c.lat, Math.min(MAXK, Math.max(AREA_K + 0.5, (Math.min(W, H) * 0.3) / ((r / 111.32) * s0))));
  }
  function flyToCountry(cc) {
    const list = cities.filter((c) => c.cc === cc);
    if (!list.length) return;
    const lons = list.map((c) => c.lon), lats = list.map((c) => c.lat);
    flyToBox([Math.min(...lons) - 0.3, Math.min(...lats) - 0.3, Math.max(...lons) + 0.3, Math.max(...lats) + 0.3]);
  }

  // pulse phase per city, so claimed cities don't all breathe in sync
  const phase = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };

  function draw(now) {
    const t = now / 1000, s = s0 * k, v = view();
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
    const countryColors = COUNTRY_COLORS[pal.light ? "light" : "dark"];
    for (const w of world) if (boxInView(w.box, v)) { ctx.fillStyle = colored ? countryColors[w.color ?? 0] : pal.land; ctx.fill(w.path, "evenodd"); }
    ctx.strokeStyle = pal.landLine; ctx.lineWidth = 1 / s;
    for (const w of world) if (boxInView(w.box, v)) ctx.stroke(w.path);
    if (hoverCountry && k < AREA_K) {
      ctx.fillStyle = pal.light ? "rgba(232,67,31,.08)" : "rgba(255,138,91,.1)"; ctx.fill(hoverCountry.path, "evenodd");
      ctx.strokeStyle = "rgba(255,120,80,.8)"; ctx.lineWidth = 1.5 / s; ctx.stroke(hoverCountry.path);
    }

    // city areas: coloured by status, every boundary drawn as a clear line on top of the fills
    if (k >= AREA_K) {
      loadVisible();
      ctx.globalAlpha = Math.min(1, 0.35 + (k - AREA_K) / 3);
      const shown = [];
      for (const [id, a] of areas) {
        if (!boxInView(a.box, v)) continue;
        const c = byId.get(id); if (!c) continue;
        const cl = claims.get(id), mine = isMine(cl);
        const tint = colored ? hexA(AREA_COLORS[a.color ?? 0], c === hover ? 0.5 : pal.light ? 0.3 : 0.24) : c === hover ? pal.hoverFill : pal.area;
        ctx.fillStyle = mine ? "rgba(255,200,87,.24)" : cl ? "rgba(255,90,54,.2)" : tint;
        ctx.fill(a.path, "evenodd");
        shown.push([a, cl, mine]);
      }
      ctx.lineWidth = (k > 80 ? 1.6 : 1.15) / s;
      for (const [a, cl, mine] of shown) {
        ctx.strokeStyle = mine ? "rgba(255,200,87,.95)" : cl ? "rgba(255,90,54,.9)" : pal.areaLine;
        ctx.setLineDash(a.kind === "n" ? [5 / s, 4 / s] : []);
        ctx.stroke(a.path);
      }
      ctx.setLineDash([]);
      const ha = hover && hover !== selected && areas.get(hover.id);
      if (ha) { ctx.lineWidth = 2.4 / s; ctx.strokeStyle = pal.label; ctx.stroke(ha.path); }
      ctx.globalAlpha = 1;
    }
    // the selected city's boundary: gold with moving dashes
    const sa = selected && areas.get(selected.id);
    if (sa && boxInView(sa.box, v)) {
      ctx.fillStyle = "rgba(255,200,87,.14)"; ctx.fill(sa.path, "evenodd");
      ctx.lineWidth = 3 / s; ctx.strokeStyle = "rgba(255,200,87,.95)";
      if (!reduced) { ctx.setLineDash([8 / s, 6 / s]); ctx.lineDashOffset = (-t * 20) / s; }
      ctx.stroke(sa.path); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const m = 60;
    const inView = (x, y) => x > -m && x < W + m && y > -m && y < H + m;
    const visible = [];
    // open cities: soft dots, bigger as you zoom in (smaller once their areas are showing)
    const zs = Math.min(3.2, Math.pow(k, 0.45)) * (k >= AREA_K ? 0.55 : 1);
    ctx.fillStyle = pal.dot;
    ctx.globalAlpha = 0.7;
    const minPop = dotMinPop(); // zoomed out, only bigger places (the list is sorted biggest first)
    for (const c of cities) {
      if (c.pop < minPop) break;
      if (parts.has(c.id)) continue;
      const x = sx(c.lon), y = sy(c.lat);
      if (!inView(x, y)) continue;
      visible.push(c);
      if (claims.has(c.id)) continue;
      const r = Math.max(0.9, (Math.log10(c.pop || 20000) - 3.7) * 0.7) * zs * (W < 600 ? 0.8 : 1);
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    ctx.globalAlpha = 1;
    // claimed cities: glowing markers with a slow pulse
    for (const c of visible) {
      const cl = claims.get(c.id); if (!cl) continue;
      const x = sx(c.lon), y = sy(c.lat), mine = isMine(cl);
      const col = mine ? "255,200,87" : "255,90,54";
      if (!reduced) {
        const p = (t * 0.55 + phase(c.id)) % 1;
        ctx.beginPath(); ctx.arc(x, y, 4 + p * 16, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},${(1 - p) * 0.55})`; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.shadowColor = `rgb(${col})`; ctx.shadowBlur = 12;
      ctx.fillStyle = `rgb(${col})`; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    // cities choosing their founder right now: a gold ring
    if (windows.size) {
      ctx.strokeStyle = "rgba(255,200,87,.95)"; ctx.lineWidth = 2;
      for (const c of visible) {
        if (!windows.has(c.id) || claims.has(c.id)) continue;
        ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(sx(c.lon), sy(c.lat), 7, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // labels once you zoom in (biggest first, never overlapping)
    if (k >= 2.5) {
      const boxes = [], maxLabels = W < 600 ? 18 : k >= AREA_K ? 70 : 42;
      ctx.font = "600 11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
      const order = visible.filter((c) => c !== selected).sort((a, b) => (claims.has(b.id) - claims.has(a.id)) || b.pop - a.pop);
      for (const c of order) {
        if (boxes.length >= maxLabels) break;
        const x = sx(c.lon) + 7, y = sy(c.lat), w = ctx.measureText(c.name).width;
        if (x < 0 || x + w > W || y < 8 || y > H - 8) continue;
        if (boxes.some((b) => x < b[0] + b[2] + 6 && x + w + 6 > b[0] && Math.abs(y - b[1]) < 15)) continue;
        boxes.push([x, y, w]);
        ctx.strokeStyle = pal.halo; ctx.lineWidth = 3; ctx.strokeText(c.name, x, y);
        ctx.fillStyle = claims.has(c.id) ? pal.claimedText : pal.label; ctx.fillText(c.name, x, y);
      }
    }
    // hover + selected
    if (hover && hover !== selected && k < AREA_K) {
      ctx.strokeStyle = pal.label; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx(hover.lon), sy(hover.lat), 7, 0, Math.PI * 2); ctx.stroke();
    }
    if (selected && sx(selected.lon) > -20 && sx(selected.lon) < W + 20 && sy(selected.lat) > -20 && sy(selected.lat) < H + 20) {
      const x = sx(selected.lon), y = sy(selected.lat), b = reduced ? 0 : (Math.sin(t * 3) + 1) / 2;
      ctx.fillStyle = "#FFC857"; ctx.shadowColor = "#FFC857"; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(x, y, 4.5 + b * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,200,87,.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10 + b * 3, 0, Math.PI * 2); ctx.stroke();
      const tk = tickers.get(selected.id), label = tk ? `${selected.name} · $${tk.ticker}` : selected.name;
      ctx.font = "700 12px Inter, system-ui, sans-serif";
      const w = ctx.measureText(label).width + 18, lx = Math.min(W - w - 6, Math.max(6, x - w / 2)), ly = Math.max(6, y - 40);
      ctx.fillStyle = pal.tagBg; ctx.strokeStyle = "rgba(255,200,87,.7)"; ctx.lineWidth = 1;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx, ly, w, 24, 12); else ctx.rect(lx, ly, w, 24); ctx.fill(); ctx.stroke();
      ctx.fillStyle = pal.tagText; ctx.textBaseline = "middle"; ctx.fillText(label, lx + 9, ly + 12);
    }
    // ripples (a tap, a fresh claim, your location)
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i], p = (now - r.t0) / 1300;
      if (p >= 1) { ripples.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(sx(r.lon), sy(r.lat), 6 + p * 46, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r.col},${(1 - p) * 0.8})`; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  const animating = () => !reduced && (flight || ripples.length || selected || claims.size > 0);
  function loop(now) {
    raf = 0;
    if (!onScreen || document.hidden || !W) return;
    stepFlight(now);
    if (needDraw || animating()) { draw(now); needDraw = false; }
    if (flight || ripples.length || animating()) raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(loop); }
  const ripple = (c, col = "255,200,87") => { ripples.push({ lon: c.lon, lat: c.lat, t0: performance.now(), col }); kick(); };

  // the smallest place drawn as a dot at this zoom (148,000 places: towns show up as you zoom in)
  const dotMinPop = () => (k < 2 ? 150_000 : k < 4 ? 50_000 : k < 8 ? 15_000 : k < 20 ? 5_000 : 0);
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
    return best;
  }
  /** The city under the pointer: a nearby dot first (small cities stay easy to hit), then the area around it. */
  function pick(px, py, maxPx) {
    const c = nearest(px, py, k >= AREA_K ? Math.min(maxPx, 9) : maxPx);
    if (c || k < AREA_K) return c;
    const [lon, lat] = toLonLat(px, py);
    return cityAtPoint(lon, lat);
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
    const cl = claims.get(c.id), tk = tickers.get(c.id), a = areas.get(c.id);
    tip.replaceChildren(el("strong", null, c.name), el("span", null, ` ${placeOf(c)}`), document.createElement("br"),
      el("span", cl ? "tip-claimed" : "tip-open", cl ? `Founder: ${cl.founder || cl.wallet}${cl.status === "active" ? "" : ` (${cl.status})`}` : windows.has(c.id) ? `Choosing its founder: ${windows.get(c.id).applicants} applying` : "Open"), el("span", "tip-ticker", tk ? `  $${tk.ticker}` : ""),
      el("span", "tip-area", ` · min ${short(founderMin(c, cl, windows.get(c.id)).amount)}`));
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

  // pointer: drag to move, pinch or double-tap to zoom, tap to pick a city (or a country when zoomed out)
  const pts = new Map();
  let drag = null, lastTap = 0, wheelOK = false;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", (e) => {
    if (!loaded) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    pts.set(e.pointerId, { x, y });
    drag = { x, y, tx, ty, moved: false, pinch: pts.size === 2 ? pinchInfo() : null };
    wheelOK = true; $("#map-hint").classList.remove("is-shown");
  });
  function pinchInfo() { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k }; }
  canvas.addEventListener("pointermove", (e) => {
    if (!loaded) return;
    const [x, y] = local(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x, y });
    if (drag && pts.size === 2) {
      const p = pinchInfo();
      if (!drag.pinch) drag.pinch = p;
      const f = (p.d / Math.max(1, drag.pinch.d)) * drag.pinch.k / k;
      zoomAt(p.cx, p.cy, f); drag.moved = true; return;
    }
    if (drag && pts.size === 1) {
      if (Math.hypot(x - drag.x, y - drag.y) > 5) drag.moved = true;
      if (drag.moved && canPan()) { tx = drag.tx + (x - drag.x); ty = drag.ty + (y - drag.y); clampView(); needDraw = true; kick(); canvas.classList.add("is-dragging"); }
      return;
    }
    if (e.pointerType === "mouse") {
      const c = pick(x, y, 16);
      const w = !c && k < AREA_K ? countryAt(...toLonLat(x, y)) : null;
      if (c !== hover || w !== hoverCountry) { hover = c; hoverCountry = w; needDraw = true; kick(); }
      canvas.style.cursor = c || w ? "pointer" : "";
      if (c) showTip(c, x, y - 14); else if (w) showCountryTip(w, x, y - 14); else tip.hidden = true;
    }
  });
  const end = (e) => {
    const was = drag; pts.delete(e.pointerId);
    canvas.classList.remove("is-dragging");
    if (pts.size) { const [rest] = [...pts.values()]; drag = { x: rest.x, y: rest.y, tx, ty, moved: true, pinch: null }; return; }
    drag = null;
    if (!was || was.moved || e.type === "pointercancel") return;
    const [x, y] = local(e), now = performance.now();
    if (now - lastTap < 320) { lastTap = 0; flight = null; zoomAt(x, y, 2.4); return; }
    lastTap = now;
    const c = pick(x, y, e.pointerType === "mouse" ? 14 : 22);
    if (c) { select(c, true); ripple(c); return; }
    const w = k < AREA_K ? countryAt(...toLonLat(x, y)) : null;
    if (w && cityCount(w.cc)) { countryEl.value = w.cc; renderList(); flyToCountry(w.cc); hoverCountry = null; tip.hidden = true; }
    // zoomed in on land that no community covers: offer the three nearest
    else if (k >= AREA_K && countryAt(...toLonLat(x, y))) { const [lon, lat] = toLonLat(x, y); ripples.push({ lon, lat, t0: performance.now(), col: "127,163,214" }); showNearby(lon, lat); }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { hover = null; hoverCountry = null; tip.hidden = true; needDraw = true; kick(); });
  wrapEl.addEventListener("mouseleave", () => { wheelOK = false; });
  canvas.addEventListener("wheel", (e) => {
    if (!loaded) return;
    if (!wheelOK && !e.ctrlKey && !e.metaKey) { $("#map-hint").classList.add("is-shown"); clearTimeout(canvas._h); canvas._h = setTimeout(() => $("#map-hint").classList.remove("is-shown"), 1600); return; }
    e.preventDefault(); flight = null;
    const [x, y] = local(e);
    zoomAt(x, y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022)));
  }, { passive: false });
  // keyboard: arrows move, + / − zoom (the map is focusable)
  canvas.addEventListener("focus", () => { wheelOK = true; });
  canvas.addEventListener("keydown", (e) => {
    if (!loaded) return;
    const pan = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[e.key];
    if (pan) { e.preventDefault(); flight = null; tx += pan[0]; ty += pan[1]; clampView(); needDraw = true; kick(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); flight = null; zoomAt(W / 2, H / 2, 1.6); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); flight = null; zoomAt(W / 2, H / 2, 1 / 1.6); }
  });
  $("#map-in").addEventListener("click", () => { flight = null; zoomAt(W / 2, H / 2, 1.8); });
  $("#map-out").addEventListener("click", () => { flight = null; zoomAt(W / 2, H / 2, 1 / 1.8); });
  $("#map-reset").addEventListener("click", () => flyTo(10, 12, 1, 800));
  // plain / coloured map switch (remembered on this device)
  function showStyle() {
    const b = $("#map-style"), colored = mapStyle === "colored";
    b.setAttribute("aria-pressed", String(colored));
    b.title = colored ? "Show the plain map" : "Show the coloured map";
    b.setAttribute("aria-label", b.title);
    canvas.classList.toggle("is-colored", colored);
    needDraw = true; kick();
  }
  $("#map-style").addEventListener("click", () => {
    mapStyle = mapStyle === "colored" ? "plain" : "colored";
    try { localStorage.setItem("vicinity-map-style", mapStyle); } catch {}
    showStyle();
  });
  showStyle();
  // ◎: find the city you're standing in (location is used on this device only, never sent)
  $("#map-locate").addEventListener("click", async () => {
    const b = $("#map-locate");
    if (!loaded || b.disabled) return;
    b.disabled = true; b.classList.add("is-busy");
    try {
      const loc = await V().getLocation();
      ripples.push({ lon: loc.lon, lat: loc.lat, t0: performance.now(), col: "55,194,154" });
      const c = await findCityAt(loc.lon, loc.lat);
      const home = c && parts.has(c.id) ? byId.get(parts.get(c.id)) : c;
      if (home) { select(home, true); V().toast?.(`📍 You're in ${home.name}`); }
      else { flyTo(loc.lon, loc.lat, 60); showNearby(loc.lon, loc.lat); V().toast?.("No community here yet: pick one of the three nearest."); }
    } catch (e) { V().toast?.(e?.inApp ? `${e.message} Open vicinity.city in Safari or Chrome to see where you are.` : e?.message || "Couldn't get your location."); }
    finally { b.disabled = false; b.classList.remove("is-busy"); }
  });
  window.addEventListener("resize", () => { if (loaded) size(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { needDraw = true; kick(); } });
  new IntersectionObserver((es) => { onScreen = es.some((x) => x.isIntersecting); if (onScreen) { needDraw = true; kick(); } }).observe(canvas);

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
  countryEl.addEventListener("change", () => { renderList(); if (countryEl.value) flyToCountry(countryEl.value); });
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
    needDraw = true; kick();
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
      const a = areas.get(selected.id);
      if (a) sub.append(document.createElement("br"), el("span", a.kind === "r" ? "area-note" : "area-note area-note--near", areaNote(a, selected)));
      const shared = sharedNote(selected);
      if (shared) sub.append(document.createElement("br"), el("span", "shared-note", shared));
      if (cl) sub.append(document.createElement("br"), document.createTextNode(`City Founder: ${cl.founder} `), walletText(cl.wallet), document.createTextNode(` · since ${new Date(cl.claimed_at).toLocaleDateString()}${cl.status === "grace" ? " · in grace" : ""}`));
      else sub.append(document.createElement("br"), document.createTextNode("City Founder: No city founder yet"));
      sub.append(document.createElement("br"), document.createTextNode(`Holders: ${fmt(holderCount.get(selected.id) || 0)}`));
      const fm = founderMin(selected, cl, windows.get(selected.id));
      sub.append(document.createElement("br"), document.createTextNode(`Founder minimum: ${fmt(fm.amount)} $VICINITY · held ${qualifyingDays} days${fm.seat ? " (the seat's bar)" : ""}`));
      const win = windows.get(selected.id);
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
      if (fly) flyTo(c.lon, c.lat, Math.max(k, 60));
      return showNearby(c.lon, c.lat, c.name);
    }
    // a neighbourhood inside another city's official boundary belongs to that city
    if (parts.has(c.id) && byId.get(parts.get(c.id))) {
      const home = byId.get(parts.get(c.id));
      V().toast?.(`${c.name} is part of ${home.name}`);
      c = home;
    }
    mode = "claim"; selected = c;
    refreshPanel(); renderList(); renderCoin(c); renderModerator(c);
    if (fly) flyToCity(c);
    // the boundary may still be loading: show it (and re-frame the map) once it's here
    if (!areas.has(c.id)) loadBounds(c.cc).then(() => { if (selected !== c) return; refreshPanel(); if (fly && areas.has(c.id)) flyToCity(c); });
    needDraw = true; kick();
  }
  document.addEventListener("vicinity:me", () => { if (loaded) { refreshPanel(); renderList(); needDraw = true; kick(); } });

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
  /** Where verified members call home (public counts only), and the communities filling up fastest. */
  async function refreshMembers() {
    const d = await V().api?.("/api/members");
    if (!d || !Array.isArray(d.communities)) return;
    totalMembers = d.members || 0;
    memberCount = new Map(d.communities.map((c) => [String(c.id), c.members]));
    holderCount = new Map(d.communities.map((c) => [String(c.id), c.holders || 0]));
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

  let firstClaims = true;
  let windows = new Map(); // cities choosing their founder right now
  /** Founder seats (founded, or chosen and in the objection period) and open application windows. */
  async function refreshClaims() {
    try {
      const d = await (await fetch("/api/seats", { cache: "no-store" })).json();
      if (!Array.isArray(d.seats)) return;
      const list = d.seats.map((s) => ({ city_id: s.cityId, wallet: s.wallet, city_name: s.city, country: s.country, claimed_at: s.since, status: s.status, founder: s.founder, threshold: s.threshold }));
      const fresh = new Set();
      if (!firstClaims) for (const c of list) if (!claims.has(c.city_id)) { fresh.add(c.city_id); const city = byId.get(c.city_id); if (city) ripple(city, "255,90,54"); }
      firstClaims = false;
      claims = new Map(list.map((c) => [c.city_id, c]));
      windows = new Map((d.windows || []).map((w) => [w.cityId, w]));
      open = Boolean(d.launched);
      updateStats(); renderFeed(fresh);
      if (fresh.size) { renderList(); refreshPanel(); }
      needDraw = true; kick();
    } catch {}
  }

  async function load() {
    if (loaded) return; loaded = true;
    try {
      const [data, wd, bi, tf, pol] = await Promise.all([
        fetch("/data/cities.json").then((r) => r.json()),
        fetch("/data/world.json").then((r) => r.json()).catch(() => null),        // map background (optional)
        fetch("/data/bounds/index.json").then((r) => r.json()).catch(() => null), // city boundaries (optional)
        fetch("/data/tickers.json").then((r) => r.json()).catch(() => null),      // every community's ticker (computed here if missing)
        fetch("/api/policy").then((r) => r.json()).catch(() => null),            // the Stake Ladder's numbers (the published ones if missing)
      ]);
      tickerFile = tf;
      const L = pol?.policy?.founder?.ladder;
      if (L && ["base", "max", "refPop", "rung"].every((key) => Number.isFinite(L[key]) && L[key] > 0)) ladder = { base: L.base, max: L.max, refPop: L.refPop, rung: L.rung };
      if (Number.isFinite(pol?.policy?.founder?.qualifyingDays) && pol.policy.founder.qualifyingDays > 0) qualifyingDays = pol.policy.founder.qualifyingDays;
      countries = data.countries; admin = data.admin;
      readPalette();
      world = wd ? Object.entries(wd.countries).map(([cc, enc]) => { const area = enc.map((poly) => poly.map((r) => decodeRing(r, wd.unit))); return { cc, area, box: boxOf(area), path: toPath(area) }; }) : [];
      const boxArea = (b) => (b[2] - b[0]) * (b[3] - b[1]);
      colorize(world.slice().sort((p, q) => boxArea(q.box) - boxArea(p.box)), world, COUNTRY_COLORS.light.length);
      boundsIndex = bi?.countries || {};
      parts = new Map(Object.entries(bi?.parts || {}));
      outside = new Set(bi?.outside || []);
      joined = new Set(bi?.joined || []);
      cities = Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map(([id, name, adm, lat, lon, pop]) => ({ id: String(id), name, cc, adm, lat, lon, pop, n: norm(name) })));
      cities.sort((a, b) => b.pop - a.pop);
      byId = new Map(cities.map((c) => [c.id, c]));
      members = new Map();
      for (const [child, parent] of parts) if (byId.has(child)) members.set(parent, [...(members.get(parent) || []), byId.get(child)]);
      retick();
      await refreshClaims();
      retick();
      const counts = {}; for (const c of cities) if (!parts.has(c.id)) counts[c.cc] = (counts[c.cc] || 0) + 1;
      const opts = Object.keys(countries).sort((a, b) => countries[a].localeCompare(countries[b]));
      countryEl.append(...opts.filter((c) => counts[c]).map((c) => Object.assign(document.createElement("option"), { value: c, textContent: `${countries[c]} (${counts[c]})` })));
      sec.classList.add("is-ready");
      size(); renderList(); refreshPanel(); renderFeed(); refreshMembers();
      setInterval(() => { if (!document.hidden && onScreen) { refreshClaims(); refreshMembers(); } }, 30000);
      // arriving with ?city=<id> (from other pages): open that city
      const want = new URLSearchParams(location.search).get("city");
      if (want && byId.get(want)) select(byId.get(want), true);
    } catch {
      loaded = false;
      listEl.replaceChildren(el("li", "muted", "Couldn't load the city list. Refresh the page to try again."));
    }
  }
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: "900px 0px" });
  io.observe(sec);
  if (location.hash === "#cities") load();
})();
