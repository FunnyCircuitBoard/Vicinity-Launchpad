// Home page: the real New York City example (hero + step-by-step map), live numbers, the two tab lists (what $VICINITY gets you,
// the FAQ), the "+N more" of the member chips, and redirects for old links (/#cities → /cities ...).
(() => {
  "use strict";
  const { $, $$, fmt, api, reduced } = window.V;

  // Old one-page links still work.
  const OLD = { "#token": "/token", "#holders": "/token#holders", "#wallet": "/connect", "#cities": "/cities", "#launchpad": "/launchpad", "#check": "/token#check", "#story": "#nyc", "#demo": "#nyc" };
  if (OLD[location.hash] && OLD[location.hash] !== location.hash) {
    if (OLD[location.hash].startsWith("/")) { location.replace(OLD[location.hash]); return; }
  }

  /* ---------- numbers ---------- */
  const setStat = (k, v) => $$(`[data-stat="${k}"]`).forEach((e) => (e.textContent = fmt(v)));
  fetch("/data/stats.json").then((r) => r.json()).then((s) => { for (const [k, v] of Object.entries(s)) setStat(k, v); }).catch(() => {});
  // The members count shows only once it says something: at 100 or more it takes the countries tile's place (a phone keeps three tiles,
  // a computer four). Below that there is no tile at all, never "…" and never a small number that makes the map look empty (d3).
  const MEMBERS_MIN = 100;
  api("/api/members").then((m) => {
    if (!m || typeof m.members !== "number" || m.members < MEMBERS_MIN) return;
    const countries = $(".hero__fact--countries"); if (!countries) return;
    const li = document.createElement("li"), n = document.createElement("strong"), label = document.createElement("span");
    li.className = "hero__fact--members"; n.textContent = fmt(m.members); label.textContent = "verified members";
    li.append(n, label); countries.replaceWith(li);
  });

  /* ---------- map drawing ---------- */
  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}, cls) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (cls) e.setAttribute("class", cls); return e; };
  const ticker = (name) => (window.vicinityTicker ? window.vicinityTicker.baseTicker(name) : name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10));

  function projector(view) {
    const [w, s, e, n] = view, kx = Math.cos((((s + n) / 2) * Math.PI) / 180), S = 1000 / ((e - w) * kx);
    return { x: (lon) => (lon - w) * kx * S, y: (lat) => (n - lat) * S, h: (n - s) * S };
  }
  const pathOf = (P, area) => area.map((poly) => poly.map((ring) => "M" + ring.map(([lon, lat]) => `${P.x(lon).toFixed(1)},${P.y(lat).toFixed(1)}`).join("L") + "Z").join("")).join("");
  const boxOf = (area) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of area) for (const [x, y] of p[0]) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); } return [a, b, c, d]; };
  const centroid = (area) => { const [a, b, c, d] = boxOf(area); return [(a + c) / 2, (b + d) / 2]; };

  function drawBase(svg, data, P) {
    svg.append(svgEl("rect", { x: 0, y: 0, width: 1000, height: P.h.toFixed(0), fill: "var(--map-water)" }));
    svg.append(svgEl("path", { d: pathOf(P, data.land), "fill-rule": "evenodd" }, "m-land"));
  }

  /* ---------- hero: New York City's community, glowing ---------- */
  // On a phone the hero's map is hidden (the walkthrough's bigger map comes right after): a faint outline of New York City's real
  // boundary sits behind the headline instead (decoration: aria-hidden, absolutely placed in the hero's background, so nothing moves).
  function outline(data) {
    const bg = $(".hero__bg"); if (!bg || $(".hero__outline", bg)) return;
    const P = projector(data.view), [a, b, c, d] = boxOf(data.official);
    const x0 = P.x(a), x1 = P.x(c), y0 = P.y(d), y1 = P.y(b), pad = 12;
    const svg = svgEl("svg", { viewBox: `${(x0 - pad).toFixed(0)} ${(y0 - pad).toFixed(0)} ${(x1 - x0 + 2 * pad).toFixed(0)} ${(y1 - y0 + 2 * pad).toFixed(0)}`, "aria-hidden": "true", focusable: "false", preserveAspectRatio: "xMidYMid meet" }, "hero__outline");
    svg.append(svgEl("path", { d: pathOf(P, data.official), "fill-rule": "evenodd" }));
    bg.append(svg);
  }
  function hero(data) {
    outline(data);
    const svg = $("#hero-map"); if (!svg) return;
    const P = projector(data.view);
    drawBase(svg, data, P);
    const g = svgEl("g", {}, "m-nb");
    for (const nb of data.neighbors) g.append(svgEl("path", { d: pathOf(P, nb.area), "fill-rule": "evenodd" }, "m-area" + (nb.kind === "n" ? " is-near" : "")));
    svg.append(g);
    svg.append(svgEl("path", { d: pathOf(P, data.nyc.area), "fill-rule": "evenodd" }, "m-nyc"));
    svg.append(svgEl("path", { d: pathOf(P, data.official), "fill-rule": "evenodd" }, "m-official"));
    for (const [, lon, lat, pop] of data.members) svg.append(svgEl("circle", { cx: P.x(lon).toFixed(1), cy: P.y(lat).toFixed(1), r: pop > 1e6 ? 7 : pop > 1e5 ? 5 : 3.5 }, "m-dot is-in"));
    const [cx, cy] = [P.x(-73.95), P.y(40.73)];
    svg.append(svgEl("circle", { cx, cy, r: 40 }, "m-pulse"));
    const coin = svgEl("g", { transform: `translate(${cx.toFixed(0)} ${cy.toFixed(0)})` }, "m-coin");
    coin.append(svgEl("circle", { r: 36 }), Object.assign(svgEl("text", { "text-anchor": "middle", y: 9 }), { textContent: "NYC" }));
    svg.append(coin);
    // zoom in on the city: frame its community area
    const [a, b, c, d] = boxOf(data.nyc.area);
    const x0 = P.x(a), x1 = P.x(c), y0 = P.y(d), y1 = P.y(b), pad = 30;
    svg.setAttribute("viewBox", `${(x0 - pad).toFixed(0)} ${(y0 - pad).toFixed(0)} ${(x1 - x0 + 2 * pad).toFixed(0)} ${(y1 - y0 + 2 * pad).toFixed(0)}`);
  }

  /* ---------- the step-by-step New York City map ---------- */
  // d3 (11 Oct 2026, the owner's phone screenshot: labels on top of each other, two "flags" over the map and each other, 6-10 px text):
  // * one view per step: steps 1-2 zoom in on the city (its outline about two thirds of the map's width), steps 3-4 zoom out to the four
  //   neighbours step 3 names. The map is square at every width (the views are square and CSS fixes the ratio), so nothing below moves;
  //   the view glides between the two with motion welcome, and jumps with reduced motion, "Pause animations" or off screen;
  // * labels, the coin, the dots and the rings keep their size on screen whatever the zoom: --u (map units per CSS pixel) is set on the
  //   svg through the CSSOM and style.css sizes the text with it (13 px names, a 15 px city label);
  // * labels are laid out per view, after the fonts load and again when the map's width changes: New York City's own label first, then
  //   the neighbours the copy names (Newark, Yonkers, Paterson, Hempstead), then the biggest (six at most; on a phone the four and Stamford,
  //   names only). Each tries a few spots (on its area, above, below, beside) and is left out when every spot touches another label, the
  //   coin, New York City's area or the map's edge: nothing is ever drawn on top of something else;
  // * no flags: what step 4 says sits in its caption, and the legend under the map says what the colours mean.
  const VIEW_CITY = [290, 255, 440, 440], VIEW_REGION = [250, 170, 560, 560];
  const NAMED = ["Newark", "Yonkers", "Paterson", "Hempstead"], BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "The Bronx", "Staten Island"];
  const PHONE_MAP = 500; // a phone's map (398 px at most) gets short labels (names only, a fixed list); every computer's (544 px and up) the long ones
  function walkthrough(data) {
    const svg = $("#nyc-map"), box = $(".nyc"); if (!svg || !box) return;
    const P = projector(data.view);
    drawBase(svg, data, P);
    const tip = $("#nyc-tip");
    const showTip = (e, text) => {
      const r = svg.parentElement.getBoundingClientRect();
      tip.textContent = text; tip.hidden = false;
      tip.style.left = `${e.clientX - r.left}px`; tip.style.top = `${e.clientY - r.top}px`;
    };
    const hideTip = () => (tip.hidden = true);
    // clicking the map opens that city on the live map page (a neighbour opens itself, anything else New York City)
    svg.addEventListener("click", (e) => { location.href = `/cities?city=${encodeURIComponent(e.target.dataset.city || data.nyc.id)}`; });

    // neighbours: their own communities and coins
    const nb = svgEl("g", {}, "m-nb");
    for (const n of data.neighbors) {
      const p = svgEl("path", { d: pathOf(P, n.area), "fill-rule": "evenodd", "data-city": n.id }, "m-area" + (n.kind === "n" ? " is-near" : ""));
      p.addEventListener("pointermove", (e) => showTip(e, `${n.name}, ${n.state} · own coin ${ticker(n.name)} · ${fmt(n.pop)} people · click to open`));
      p.addEventListener("pointerleave", hideTip);
      nb.append(p);
    }
    svg.append(nb);

    // New York City's community area, and its official boundary
    const nyc = svgEl("path", { d: pathOf(P, data.nyc.area), "fill-rule": "evenodd" }, "m-nyc");
    nyc.addEventListener("pointermove", (e) => showTip(e, `New York City community · ${data.members.length + 1} places, one coin: $NYC · click to open`));
    nyc.addEventListener("pointerleave", hideTip);
    svg.append(nyc);
    svg.append(svgEl("path", { d: pathOf(P, data.official), "fill-rule": "evenodd" }, "m-official"));

    // every listed place that shares the coin, with a line to the coin (dots sized in screen pixels: see size())
    const [cx, cy] = [P.x(-73.95), P.y(40.73)];
    const links = svgEl("g", {}, "m-link"), dots = svgEl("g"), dotList = [];
    for (const [name, lon, lat, pop, st] of data.members) {
      const x = P.x(lon), y = P.y(lat);
      links.append(svgEl("line", { x1: x.toFixed(1), y1: y.toFixed(1), x2: cx.toFixed(1), y2: cy.toFixed(1) }));
      const d = svgEl("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 4 }, "m-dot is-in");
      d.addEventListener("pointermove", (e) => showTip(e, `${name}, ${st} · ${fmt(pop)} people · part of $NYC`));
      d.addEventListener("pointerleave", hideTip);
      dots.append(d); dotList.push([d, pop > 1e6 ? 5.5 : pop > 1e5 ? 4.2 : 3.2]);
    }
    svg.append(links, dots);

    // labels: the neighbours (steps 3-4), the five boroughs (step 2, on a wider map), New York City's own (every step)
    const text = (cls, group) => { const t = svgEl("text", { x: 0, y: 0, "text-anchor": "middle" }, cls); group.append(t); return t; };
    const nbLabels = svgEl("g", {}, "m-nb m-labels"), boroLabels = svgEl("g", {}, "m-boro m-labels");
    const nbOrder = [...data.neighbors].sort((a, b) => (NAMED.includes(b.name) - NAMED.includes(a.name)) || (NAMED.indexOf(a.name) - NAMED.indexOf(b.name)) || (b.pop - a.pop));
    const nbItems = nbOrder.map((n) => { const [lon, lat] = centroid(n.area); return { n, x: P.x(lon), y: P.y(lat), named: NAMED.includes(n.name), t: text("m-label", nbLabels) }; });
    const boroItems = data.members.filter((m) => BOROUGHS.includes(m[0])).map(([name, lon, lat]) => ({ name, x: P.x(lon), y: P.y(lat), t: text("m-label", boroLabels) }));
    const ob = boxOf(data.official), bigX = P.x((ob[0] + ob[2]) / 2), bigTop = P.y(ob[3]);
    const big = text("m-label m-label--big m-official-label", svg);
    svg.append(nbLabels, boroLabels, big);

    const coin = svgEl("g", { transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})` }, "m-coin"), disc = svgEl("g");
    disc.append(svgEl("circle", { r: 34 }), Object.assign(svgEl("text", { "text-anchor": "middle", y: 9 }), { textContent: "$NYC" }));
    coin.append(disc);
    svg.append(coin);

    // step 4: who leads it (the rings pulse on the biggest places)
    const lead = svgEl("g", {}, "m-lead"), rings = [];
    for (const [, lon, lat] of data.members.slice(0, 7)) { const r = svgEl("circle", { cx: P.x(lon).toFixed(1), cy: P.y(lat).toFixed(1), r: 14 }, "m-pulse"); rings.push(r); lead.append(r); }
    svg.append(lead);

    /* sizes in screen pixels, for one view: everything that marks a place keeps its size on screen whatever the zoom */
    let W = 0, phone = true, view = VIEW_CITY.slice();
    const coinPx = () => Math.max(22, Math.min(32, W * 0.05));
    function size(v) {
      const u = v[2] / W;
      svg.setAttribute("viewBox", v.map((n) => n.toFixed(1)).join(" "));
      svg.style.setProperty("--u", u.toFixed(4));
      disc.setAttribute("transform", `scale(${((coinPx() * u) / 34).toFixed(4)})`);
      for (const [d, px] of dotList) d.setAttribute("r", (px * u).toFixed(2));
      for (const r of rings) r.setAttribute("r", (10 * u).toFixed(2));
      big.setAttribute("x", bigX.toFixed(1)); big.setAttribute("y", (bigTop - 9 * u).toFixed(1));
      return u;
    }
    /* the layout of one view's labels: first come, first kept; a spot is free when it is inside the map and touches nothing taken */
    const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const area = (t) => { const b = t.getBBox(); return [b.x, b.y, b.x + b.width, b.y + b.height]; };
    const onNyc = (b) => { // any of 12 points of the label's box inside New York City's area
      try { for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) if (nyc.isPointInFill(new DOMPoint(b[0] + ((b[2] - b[0]) * (i + 0.5)) / 4, b[1] + ((b[3] - b[1]) * (j + 0.5)) / 3))) return true; } catch { return false; }
      return false;
    };
    const put = (t, x, y) => { t.setAttribute("x", x.toFixed(1)); t.setAttribute("y", y.toFixed(1)); for (const ts of t.children) ts.setAttribute("x", x.toFixed(1)); };
    // each label is measured once at its place (centred on it), then its box is moved to each candidate spot by arithmetic: the nearest
    // free spot wins (a named neighbour may move up to about three lines away; the others only on, above, below or beside their place)
    function layoutView(v, items, opts) {
      const u = size(v), f = 13 * u, m = 4 * u;
      const edge = [v[0] + m, v[1] + m, v[0] + v[2] - m, v[1] + v[3] - m];
      const cr = coinPx() * u + m, taken = [[cx - cr, cy - cr, cx + cr, cy + cr]];
      const bb = area(big); taken.push([bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m]);
      let kept = 0;
      for (const it of items) {
        const t = it.t;
        t.classList.remove("is-off");
        const lift = t.childElementCount > 1 ? 0.6 * f : 0; // a two-line label (name, then its coin) is centred on its place too
        put(t, it.x, it.y + 0.35 * f - lift); t.setAttribute("text-anchor", "middle");
        const raw = area(t), w = raw[2] - raw[0];
        let best = null;
        if (kept < opts.max) for (const [dx, dy] of opts.spots(it, f, w)) {
          const r = [raw[0] + dx, raw[1] + dy, raw[2] + dx, raw[3] + dy], b = [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
          if (b[0] < edge[0] || b[1] < edge[1] || b[2] > edge[2] || b[3] > edge[3]) continue;
          if (taken.some((k) => hit(b, k))) continue;
          if (opts.avoidNyc && onNyc(r)) continue;
          best = [dx, dy, b]; break;
        }
        if (!best) { t.classList.add("is-off"); continue; }
        put(t, it.x + best[0], it.y + 0.35 * f - lift + best[1]);
        taken.push(best[2]); kept++;
      }
    }
    // candidate moves of a label's box [dx, dy], nearest first: on the place, above, below, beside; a named neighbour searches a wider ring
    const nbSpots = ({ named }, f, w) => {
      const s = [[0, 0], [0, -1.15 * f], [0, 1.15 * f], [w / 2 + 0.5 * f, 0], [-w / 2 - 0.5 * f, 0]];
      if (named) {
        const ring = [];
        for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) ring.push([i * 0.25 * w, j * 0.8 * f]);
        ring.sort((a, b) => Math.hypot(a[0], a[1] * 1.6) - Math.hypot(b[0], b[1] * 1.6));
        s.push(...ring);
      }
      return s;
    };
    const boroSpots = (it, f, w) => [[0, -1.1 * f], [0, 1.1 * f], [w / 2 + 0.6 * f, 0], [-w / 2 - 0.6 * f, 0]];
    function layout() {
      const w = svg.getBoundingClientRect().width;
      if (!w) return;
      W = w; phone = W < PHONE_MAP;
      // the words: a phone names the places; a wider map adds each neighbour's coin and says what the city's line is
      big.textContent = phone ? "New York City" : "New York City · official boundary";
      for (const it of nbItems) { // a phone: the name; a computer: the name, and the coin it gets on a second line
        it.t.textContent = "";
        if (phone) { it.t.textContent = it.n.name; continue; }
        const name = svgEl("tspan"), coinName = svgEl("tspan", { dy: "1.15em" }, "m-tick");
        name.textContent = it.n.name; coinName.textContent = `$${ticker(it.n.name)}`;
        it.t.append(name, coinName);
      }
      for (const it of boroItems) it.t.textContent = it.name;
      const phoneList = new Set([...NAMED, "Stamford"]);
      layoutView(VIEW_REGION, phone ? nbItems.filter((it) => phoneList.has(it.n.name)) : nbItems, { spots: nbSpots, max: phone ? 5 : 6, avoidNyc: true });
      for (const it of nbItems) if (phone && !phoneList.has(it.n.name)) it.t.classList.add("is-off");
      layoutView(VIEW_CITY, boroItems, { spots: boroSpots, max: phone ? 0 : 5, avoidNyc: false }); // a phone's step 2 has no borough names (the dots, the lines and the coin say it)
      size(view);
    }

    /* the view of a step, and the glide between two views (transform-free: the viewBox itself moves, a few hundred ms) */
    const viewFor = (s) => (s <= 2 ? VIEW_CITY : VIEW_REGION);
    let anim = 0;
    function moveTo(target) {
      cancelAnimationFrame(anim);
      const from = view.slice(), still = window.V.reduced || box.classList.contains("mo-off") || !W || from.every((n, i) => Math.abs(n - target[i]) < 0.5);
      if (still) { view = target.slice(); if (W) size(view); return; }
      const t0 = performance.now(), D = 650, ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const frame = (now) => {
        const k = ease(Math.min(1, (now - t0) / D));
        view = from.map((n, i) => n + (target[i] - n) * k);
        size(view);
        if (k < 1) anim = requestAnimationFrame(frame); else view = target.slice();
      };
      anim = requestAnimationFrame(frame);
    }
    layout();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
    if (window.ResizeObserver) { let lastW = 0; new ResizeObserver(() => { const w = Math.round(svg.getBoundingClientRect().width); if (w && w !== lastW) { lastW = w; cancelAnimationFrame(anim); view = viewFor(step); layout(); } }).observe(svg); }

    // the member chips: the five boroughs, then one "+N more" that unfolds the rest in place (on every screen: the column stays as tall as the map)
    const SHOWN = 5;
    const cloud = $("#nyc-members"), chips = data.members.map(([name, , , pop], i) => { const li = document.createElement("li"); li.textContent = name; if (i < SHOWN) li.className = "is-big"; else li.className = "is-more"; return li; });
    const hidden = chips.filter((li) => li.className === "is-more").length;
    cloud.replaceChildren(...chips);
    if (hidden) {
      const li = document.createElement("li"), more = document.createElement("button");
      more.type = "button"; more.className = "member-cloud__more"; more.textContent = `+${fmt(hidden)} more`; more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", () => { const open = cloud.classList.toggle("is-open"); more.setAttribute("aria-expanded", String(open)); more.textContent = open ? "Show fewer" : `+${fmt(hidden)} more`; });
      li.append(more); cloud.append(li);
    }

    // stepping
    const steps = $$("#nyc-steps button");
    let step = 1, timer = null, playing = !reduced;
    const go = (n) => {
      step = ((n - 1 + 4) % 4) + 1;
      box.dataset.step = String(step);
      steps.forEach((b) => (Number(b.dataset.go) === step ? b.setAttribute("aria-current", "step") : b.removeAttribute("aria-current")));
      moveTo(viewFor(step));
    };
    const schedule = () => { clearTimeout(timer); if (playing && onScreen) timer = setTimeout(() => { go(step + 1); schedule(); }, 6500); };
    const setPlaying = (p) => { playing = p; $("#nyc-play").textContent = p ? "Pause" : "Play"; $("#nyc-play").setAttribute("aria-pressed", String(p)); schedule(); };
    steps.forEach((b) => b.addEventListener("click", () => { go(Number(b.dataset.go)); setPlaying(false); }));
    $("#nyc-prev").addEventListener("click", () => { go(step - 1); setPlaying(false); });
    $("#nyc-next").addEventListener("click", () => { go(step + 1); setPlaying(false); });
    $("#nyc-play").addEventListener("click", () => setPlaying(!playing));
    let onScreen = false;
    new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); schedule(); }, { threshold: 0.3 }).observe(box);
    setPlaying(playing);
    go(1);
  }

  fetch("/data/demo-nyc.json").then((r) => r.json()).then((data) => { hero(data); walkthrough(data); })
    .catch(() => { const m = $("#nyc-members"); if (m) m.replaceChildren(Object.assign(document.createElement("li"), { textContent: "Couldn't load the map. Refresh to try again." })); });

  /* ---------- the roadmap: the rail's colours follow the stops; the Launchpad stop turns "Open now" once it is open ---------- */
  // The rail (style.css .timeline::before) is green up to the last stop done and orange at the next one: --rail-done and --rail-at are
  // the centres of those two dots along the rail, measured (a stop's text wraps differently at every width). Once the Launchpad is open
  // (site.js: on load, or on its 30 s tick for a page left open across 10:10:10) its stop is done and live, with the way in under it,
  // and the Passport becomes the next stop.
  const timeline = $("#timeline");
  function rail() {
    if (!timeline) return;
    const items = $$(".timeline__item", timeline), across = getComputedStyle(timeline).display === "flex";
    const len = across ? timeline.clientWidth : timeline.clientHeight - 12;
    if (!len) return;
    const at = (li) => (across ? li.offsetLeft + 10 : li.offsetTop + 12 - 6) / len * 100;
    const done = items.filter((li) => li.classList.contains("is-done")).pop(), next = items.find((li) => li.classList.contains("is-next"));
    if (done) timeline.style.setProperty("--rail-done", `${at(done).toFixed(1)}%`);
    if (next) timeline.style.setProperty("--rail-at", `${at(next).toFixed(1)}%`); else timeline.style.setProperty("--rail-at", "100%");
  }
  function launchpadLive() {
    const stop = timeline && $$(".timeline__item", timeline).find((li) => /Vicinity\sLaunchpad/.test(li.textContent)); // \s: the title has a no-break space
    if (!stop || stop.classList.contains("is-now")) return;
    stop.classList.remove("is-next"); stop.classList.add("is-done", "is-now");
    const status = $(".timeline__status", stop); if (status) status.textContent = "Open now"; // the page is open; a city's coin launches once its founder qualifies
    const go = document.createElement("a"); go.className = "timeline__go"; go.href = "/launchpad"; go.textContent = "Open the Launchpad →";
    stop.append(go);
    const later = stop.nextElementSibling; if (later) later.classList.add("is-next");
    rail();
  }
  if (timeline) {
    if (window.V.launchOpen && window.V.launchOpen()) launchpadLive();
    window.V.official.then(() => { if (window.V.launchOpen()) launchpadLive(); });
    document.addEventListener("vicinity:launchpad-open", launchpadLive);
    rail();
    if (window.ResizeObserver) new ResizeObserver(() => rail()).observe(timeline);
  }

  /* ---------- tabs: the incentives block and the FAQ (role=tablist; the panels carry hidden until their tab is chosen) ---------- */
  // Arrow keys move between tabs (Home/End to the ends), the chosen tab is the only Tab stop of its list (WAI-ARIA tabs), and a link
  // to something inside a panel that is not showing (/#why-launchlab, /#roles) opens that panel first, then lands on the target.
  const lists = $$('[role="tablist"]').map((list) => {
    const tabs = $$('[role="tab"]', list);
    const panelOf = (t) => document.getElementById(t.getAttribute("aria-controls"));
    const choose = (tab, focus) => {
      for (const t of tabs) {
        const on = t === tab, panel = panelOf(t);
        t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
        if (panel) { const was = !panel.hidden; panel.hidden = !on; panel.classList.toggle("is-shown", on && !was && !reduced); }
      }
      if (focus) tab.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => choose(t, false));
      t.addEventListener("keydown", (e) => {
        const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
        if (n === null) return;
        e.preventDefault(); choose(tabs[(n + tabs.length) % tabs.length], true);
      });
    });
    return { tabs, panelOf, choose };
  });
  function openFor(hash) {
    if (!hash || hash.length < 2) return;
    let target; try { target = document.getElementById(decodeURIComponent(hash.slice(1))); } catch { return; }
    if (!target) return;
    for (const { tabs, panelOf, choose } of lists) {
      const tab = tabs.find((t) => { const p = panelOf(t); return p && (p === target || p.contains(target)); });
      if (tab && tab.getAttribute("aria-selected") !== "true") { choose(tab, false); requestAnimationFrame(() => target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" })); }
    }
    if (target.tagName === "DETAILS") target.open = true;
  }
  openFor(location.hash);
  window.addEventListener("hashchange", () => openFor(location.hash));
})();
