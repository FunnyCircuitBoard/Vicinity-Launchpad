// Home page: the real New York City example (hero + step-by-step map), live numbers, and
// redirects for old links (/#cities → /cities ...).
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
  api("/api/members").then((m) => { if (typeof m.members === "number") setStat("members", m.members); });

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
  function hero(data) {
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
  function walkthrough(data) {
    const svg = $("#nyc-map"), box = $(".nyc"); if (!svg || !box) return;
    const P = projector(data.view);
    svg.setAttribute("viewBox", `0 0 1000 ${P.h.toFixed(0)}`);
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

    // every listed place that shares the coin, with a line to the coin
    const [cx, cy] = [P.x(-73.95), P.y(40.73)];
    const links = svgEl("g", {}, "m-link");
    const dots = svgEl("g");
    for (const [name, lon, lat, pop, st] of data.members) {
      const x = P.x(lon), y = P.y(lat);
      links.append(svgEl("line", { x1: x.toFixed(1), y1: y.toFixed(1), x2: cx.toFixed(1), y2: cy.toFixed(1) }));
      const d = svgEl("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: pop > 1e6 ? 8 : pop > 1e5 ? 6 : 4.5 }, "m-dot is-in");
      d.addEventListener("pointermove", (e) => showTip(e, `${name}, ${st} · ${fmt(pop)} people · part of $NYC`));
      d.addEventListener("pointerleave", hideTip);
      dots.append(d);
    }
    svg.append(links, dots);

    // labels
    const label = (x, y, text, cls = "m-label", group) => { const t = svgEl("text", { x: x.toFixed(0), y: y.toFixed(0), "text-anchor": "middle" }, cls); t.textContent = text; (group || svg).append(t); return t; };
    /** Keep a group's labels only where they fit: inside the map and not on top of each other (first come, first kept). */
    const declutter = (group) => {
      const kept = [];
      for (const t of [...group.querySelectorAll("text")]) {
        let b; try { b = t.getBBox(); } catch { continue; }
        const box = [b.x - 4, b.y - 2, b.x + b.width + 4, b.y + b.height + 2];
        const out = box[0] < 0 || box[2] > 1000 || box[1] < 0 || box[3] > P.h;
        if (out || kept.some((k) => box[0] < k[2] && k[0] < box[2] && box[1] < k[3] && k[1] < box[3])) t.remove(); else kept.push(box);
      }
    };
    const nbLabels = svgEl("g", {}, "m-nb");
    for (const n of data.neighbors) {
      const [lon, lat] = centroid(n.area);
      label(P.x(lon), P.y(lat), `${n.name} · $${ticker(n.name)}`, "m-label", nbLabels);
    }
    svg.append(nbLabels);
    const memberLabels = svgEl("g", {}, "m-link");
    for (const [name, lon, lat] of data.members.filter((m) => ["Manhattan", "Brooklyn", "Queens", "The Bronx", "Staten Island"].includes(m[0]))) {
      label(P.x(lon), P.y(lat) - 12, name, "m-label", memberLabels);
    }
    svg.append(memberLabels);
    const tidy = () => { declutter(nbLabels); declutter(memberLabels); };
    tidy();
    const ob = boxOf(data.official);
    label(P.x((ob[0] + ob[2]) / 2), P.y(ob[3]) - 16, "New York City · official boundary", "m-label m-label--big m-official-label");

    const coin = svgEl("g", { transform: `translate(${cx.toFixed(0)} ${cy.toFixed(0)})` }, "m-coin");
    coin.append(svgEl("circle", { r: 34 }), Object.assign(svgEl("text", { "text-anchor": "middle", y: 9 }), { textContent: "$NYC" }));
    svg.append(coin);

    // step 4: who leads it
    const lead = svgEl("g", {}, "m-lead");
    for (const [, lon, lat] of data.members.slice(0, 7)) lead.append(svgEl("circle", { cx: P.x(lon).toFixed(1), cy: P.y(lat).toFixed(1), r: 14 }, "m-pulse"));
    const flag = (x, y, text) => {
      const g = svgEl("g", { transform: `translate(${x} ${y})` }, "m-flag");
      const t = svgEl("text", { x: 14, y: 26 }); t.textContent = text;
      g.append(svgEl("rect", { width: text.length * 9.6 + 28, height: 40, rx: 20 }), t);
      lead.append(g);
    };
    flag(Math.max(20, cx - 300), cy + 60, "👑 City Founder: seat open · hold 7 days, then apply");
    flag(Math.max(20, cx - 300), cy + 115, "📍 Locals verify with wallet + location");
    svg.append(lead);
    // size each flag to its text (the text is bigger on phones)
    const fit = () => lead.querySelectorAll(".m-flag").forEach((g) => { try { g.querySelector("rect").setAttribute("width", (g.querySelector("text").getBBox().width + 28).toFixed(0)); } catch {} });
    fit(); window.addEventListener("resize", fit);

    $("#nyc-members").replaceChildren(...data.members.map(([name, , , pop], i) => { const li = document.createElement("li"); li.textContent = name; if (i < 12 || pop > 150_000) li.className = "is-big"; return li; }));

    // stepping
    const steps = $$("#nyc-steps button");
    let step = 1, timer = null, playing = !reduced;
    const go = (n) => {
      step = ((n - 1 + 4) % 4) + 1;
      box.dataset.step = String(step);
      steps.forEach((b) => (Number(b.dataset.go) === step ? b.setAttribute("aria-current", "step") : b.removeAttribute("aria-current")));
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
})();
