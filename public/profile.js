// Member profiles (switched on with PROFILES=on, so nothing here runs for anyone else): the portfolio chart, the bio, the
// network line and the one-time notice on the dashboard, and the /profile page (search, a member's pass, holdings, follow, block).
// Needs site.js (window.V). The dashboard loads this file ONLY when /api/me says profilesFlag is true; /profile loads it as its script.
(() => {
  "use strict";

  /* =====================================================================
     Pure helpers: no page, no network (test/profiles-ui.test.js runs them in node)
     ===================================================================== */
  const BIO_MAX = 100;
  const HANDLE_RE = /^[A-Za-z][A-Za-z0-9_]{2,19}$/; // the username rule on the dashboard: 3-20, letters, numbers, underscores, starts with a letter
  const MIN_SHARE = 0.005; // a coin under half a percent of the total is too thin to see: it joins the grey slice
  const MAX_COLOURS = 8; // the categorical palette has 8 slots; past that the tail folds into "Other"
  const LEVEL = { admin: "Admin", manager: "Country Manager", founder: "City Founder", holder: "Holder", member: "Member" };

  /** Characters as people count them (an emoji is one), the way the server counts a bio. */
  const cpLen = (s) => [...String(s == null ? "" : s)].length;
  /** What the server stores: NFC, invisible characters dropped, one line (every run of blanks and line breaks is one space), trimmed. */
  const bioClean = (s) => String(s == null ? "" : s).normalize("NFC").replace(/[\r\n\t\u0085\u2028\u2029]+/g, " ").replace(/[\u200B\u200C\u2060-\u2064\uFEFF\u00AD\u180E\u0080-\u009F\u{E0000}-\u{E007F}]/gu, "").replace(/\s+/g, " ").trim();
  /**
   * Live check of a bio while typing. Only the length is certain; the others are a friendly early warning (the server has the
   * last word and answers bio_not_allowed): a link, a wallet address, an e-mail address, a phone number.
   */
  function bioCheck(raw) {
    const text = bioClean(raw), count = cpLen(text);
    const RULES = [
      ["email", /[^\s@]+@[^\s@]+\.[^\s@]{2,}/],
      ["address", /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}($|[^1-9A-HJ-NP-Za-km-z])/],
      ["longword", /[A-Za-z0-9]{26,}/], // the server refuses any run of 26+ letters or digits as address-like, whatever it is
      ["link", /(https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|app|co|me|sol|fun|gg|ly|to|tv|dev|info|site|online|link)\b)/i],
      ["phone", /\+?\d[\d\s().-]{6,}\d/],
    ];
    const hit = RULES.find(([k, re]) => re.test(text) && (k !== "phone" || (text.match(/\d/g) || []).length >= 7));
    return { text, count, max: BIO_MAX, over: count > BIO_MAX, problem: hit ? hit[0] : null };
  }
  const BIO_HINT = {
    link: "That looks like a link. Bios can't have links.",
    address: "That looks like a wallet address. Bios can't have wallet addresses.",
    email: "That looks like an e-mail address. Bios can't have e-mail addresses.",
    phone: "That looks like a phone number. Bios can't have phone numbers.",
    longword: "That's one very long word (26 or more letters or digits in a row). Bios can't have those: add a space or shorten it.",
  };

  const validHandle = (h) => typeof h === "string" && HANDLE_RE.test(h);
  /** The search box text as a query: a leading @ and spaces dropped; only what a username can contain. */
  const cleanQuery = (s) => String(s == null ? "" : s).trim().replace(/^@+/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
  const profileHref = (h) => (validHandle(h) ? `/profile?u=${encodeURIComponent(h)}` : "/profile");

  /**
   * How old the numbers are, in whole seconds: the time since they arrived plus how old they already were when the server sent
   * them (it keeps prices for a few seconds). A wrong clock on this device can't push that far: only a plausible server age counts.
   */
  function ageSeconds({ asOf, receivedAt, now }) {
    const server = Date.parse(asOf), lag = receivedAt - server;
    const already = Number.isFinite(server) && lag >= 0 && lag <= 60_000 ? lag : 0;
    return Math.max(0, Math.round((now - receivedAt + already) / 1000));
  }
  function agoText(s) {
    if (!(s >= 0)) return "";
    if (s < 5) return "just now";
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    return `${Math.floor(s / 3600)} h ago`;
  }
  /** Milliseconds until the next automatic refresh: the base, doubled after each failure, then nothing (null) after the 4th in a row. */
  const nextDelay = (failures, base = 30_000) => (failures >= 4 ? null : base * 2 ** failures);

  const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const compactNum = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
  const num = (x) => typeof x === "number" && Number.isFinite(x);
  /** A dollar value, or an em dash where there is no price. */
  const fmtUsd = (x) => (!num(x) ? "—" : x > 0 && x < 0.01 ? "<$0.01" : x >= 1e9 ? `$${compactNum.format(x)}` : usd2.format(x));
  /** Short form for the middle of the ring. */
  const fmtUsdShort = (x) => (!num(x) ? "—" : x < 1000 ? fmtUsd(x) : x < 100_000 ? usd0.format(x) : `$${compactNum.format(x)}`);
  const fmtAmount = (x) => (!num(x) ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: x >= 1000 ? 0 : x >= 1 ? 2 : 6 }).format(x));
  const fmtPct = (x) => (!num(x) ? "—" : x > 0 && x < 0.1 ? "<0.1%" : `${x.toFixed(1)}%`);
  const symbolOf = (it) => `$${String(it.symbol || it.name || "?").replace(/^\$/, "")}`;

  /** Items the way the table lists them: biggest value first, coins without a price after those, then by amount. */
  function sortItems(items) {
    return [...(items || [])].sort((a, b) => (num(b.valueUsd) ? b.valueUsd : -1) - (num(a.valueUsd) ? a.valueUsd : -1) || (b.amount || 0) - (a.amount || 0));
  }
  /**
   * Which colour (palette slot 0-7) each coin wears. $VICINITY is always slot 0, and a coin keeps its slot while it stays in the
   * list, so a refresh that reorders the values never repaints anyone. -1 = no slot left: the coin joins the grey "Other" slice.
   */
  function assignSlots(prev, items, max = MAX_COLOURS) {
    const next = new Map(), used = new Set();
    const vic = items.find((i) => i.kind === "vicinity");
    if (vic) { next.set(vic.mint, 0); used.add(0); }
    for (const it of items) {
      const s = prev && prev.get(it.mint);
      if (it !== vic && s != null && s > 0 && s < max && !used.has(s)) { next.set(it.mint, s); used.add(s); }
    }
    for (const it of sortItems(items)) {
      if (next.has(it.mint)) continue;
      let s = 1; while (used.has(s) && s < max) s++;
      next.set(it.mint, s < max ? s : -1);
      if (s < max) used.add(s);
    }
    return next;
  }
  /** The slices of the ring: every coin with a price, thin ones and the tail past the palette folded into one "Other". */
  function chartSlices(items, slots) {
    const priced = sortItems(items).filter((i) => num(i.valueUsd) && i.valueUsd > 0);
    const total = priced.reduce((s, i) => s + i.valueUsd, 0);
    if (!(total > 0)) return [];
    const main = [], rest = [];
    for (const it of priced) {
      const slot = slots.get(it.mint);
      if (slot != null && slot >= 0 && it.valueUsd / total >= MIN_SHARE) main.push({ key: it.mint, label: symbolOf(it), slot, value: it.valueUsd, count: 1 });
      else rest.push(it);
    }
    if (rest.length) main.push({ key: "other", label: rest.length === 1 ? symbolOf(rest[0]) : `${rest.length} smaller holdings`, slot: -1, value: rest.reduce((s, i) => s + i.valueUsd, 0), count: rest.length });
    return main.map((s) => ({ ...s, frac: s.value / total }));
  }

  const TAU = Math.PI * 2, START = -Math.PI / 2; // the first slice starts at 12 o'clock and runs clockwise
  const r2 = (x) => Math.round(x * 100) / 100;
  const polar = (cx, cy, r, a) => [r2(cx + r * Math.cos(a)), r2(cy + r * Math.sin(a))];
  /** One ring segment from angle a0 to a1 (radians, a1 > a0, less than a full turn). */
  function ringPath(cx, cy, R, r, a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1), [x2, y2] = polar(cx, cy, r, a1), [x3, y3] = polar(cx, cy, r, a0);
    return `M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x3} ${y3}Z`;
  }
  /** A whole ring (one slice has nothing to be separated from): two half circles each way, filled with the even-odd rule. */
  const fullRing = (cx, cy, R, r) =>
    `M${cx + R} ${cy}A${R} ${R} 0 1 1 ${cx - R} ${cy}A${R} ${R} 0 1 1 ${cx + R} ${cy}ZM${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}Z`;
  /** Geometry of the ring: each slice gets its path and its angles, with a small gap of empty space (about `gap` px) between neighbours. */
  function donutSlices(slices, { cx = 100, cy = 100, R = 92, r = 60, gap = 2 } = {}) {
    const total = slices.reduce((s, x) => s + x.frac, 0) || 1;
    if (slices.length === 1) return [{ ...slices[0], a0: START, a1: START + TAU, d: fullRing(cx, cy, R, r), full: true }];
    const half = gap / (R + r); // half the gap, as an angle at the middle of the ring
    let at = START;
    return slices.map((s) => {
      const span = (s.frac / total) * TAU, a0 = at, a1 = at + span;
      at = a1;
      const g = Math.min(half, span / 4);
      return { ...s, a0, a1, d: ringPath(cx, cy, R, r, a0 + g, a1 - g) };
    });
  }
  /** The sentence a screen reader gets for the chart (the table next to it has every number). */
  function describePortfolio(slices, total) {
    if (!slices.length) return "Portfolio chart: no priced coins yet.";
    const parts = slices.map((s) => `${s.label} ${fmtPct(s.frac * 100)}`);
    return `Portfolio chart, ${num(total) ? `worth ${fmtUsd(total)}` : "total unknown"}: ${parts.join(", ")}.`;
  }

  /** Every code the profile routes can answer with, as one plain sentence (the page picks the place with `ctx`). */
  const ERR = {
    generic: "Something went wrong. Please try again.",
    offline: "Can't reach Vicinity right now. Check your connection and try again.",
    not_enabled: "Member profiles aren't open yet.",
    login_required: "Please log in to see member profiles.",
    sign_in: "Your session ended. Please log in again.",
    not_found: "We couldn't find that member.",
    self: "You can't follow yourself.",
    cannot_follow: "You can't follow this member right now.",
    too_many_following: "You follow 1,000 members, the most we allow. Unfollow someone to follow more.",
    cannot_block: "Members with an admin role can't be blocked.",
    unblock_first: "You blocked this member. Unblock them first.",
    too_many_blocks: "You've blocked as many members as we allow. Unblock someone first.",
    no_bio: "This member has no bio to report.",
    profiles_unavailable: "Member profiles are having trouble right now. Please try again in a few minutes.",
    unavailable: "Member profiles are having trouble right now. Please try again in a few minutes.",
    bio_too_long: "Keep your bio to 100 characters or fewer.",
    bio_not_allowed: "A bio can't have links, wallet addresses, e-mail addresses, phone numbers or an unbroken word of 26+ letters or digits.",
    bad_request: "That didn't look right. Please check it and try again.",
    wrong_origin: "Something went wrong. Reload the page and try again.",
    reprove: "Please confirm it's you with your wallet first, then try again.",
    slow_down: "That's a lot of requests. Take a short break and try again in a few minutes.",
  };
  const SLOW = {
    bio: "You can change your bio 10 times a day. Try again tomorrow.",
    follow: "You're following and unfollowing quickly. Take a short break and try again.",
    search: "You've searched a lot. Try again in a few minutes.",
    profile: "You've looked at a lot of profiles. Take a short break and try again.",
    report: "You've sent a lot of reports. Try again later.",
  };
  function errText(d, ctx) {
    const code = typeof d === "string" ? d : d && d.error;
    if (code === "slow_down" && SLOW[ctx]) return SLOW[ctx];
    return ERR[code] || ERR.generic;
  }
  const levelLabel = (l) => LEVEL[l] || "Member";

  const pure = { BIO_MAX, HANDLE_RE, MIN_SHARE, MAX_COLOURS, ERR, SLOW, BIO_HINT, cpLen, bioClean, bioCheck, validHandle, cleanQuery, profileHref, ageSeconds, agoText, nextDelay,
    fmtUsd, fmtUsdShort, fmtAmount, fmtPct, symbolOf, sortItems, assignSlots, chartSlices, ringPath, donutSlices, describePortfolio, errText, levelLabel };

  /* =====================================================================
     Everything below touches the page
     ===================================================================== */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs, cls) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, String(attrs[k]));
    if (cls) e.setAttribute("class", cls);
    return e;
  };
  const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
  const countryName = (cc) => { try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; } };
  const homeText = (h) => (h ? `${h.name}, ${countryName(h.country)}` : "No home community yet");
  const sinceText = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? `Member since ${new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric" })}` : ""; };
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  const tickerOf = (name) => (window.vicinityTicker ? window.vicinityTicker.baseTicker(name) : String(name || "").toUpperCase().replace(/[^A-Z]/g, "")).slice(0, 5);

  let uid = 0;
  /**
   * The portfolio as a ring + the real table. The table is the data (every number, in the same order as the ring, clockwise from
   * the top); the ring is the picture, so it has a one-sentence text alternative instead of a second copy of the numbers.
   */
  function drawPortfolio(host, p, { slots, who, launched }) {
    const { el } = window.V;
    host.replaceChildren();
    const items = sortItems(p.items);
    if (!items.length) {
      const e = el("div", "pf__empty");
      e.append(el("strong", null, !launched ? "Your portfolio starts at launch." : who === "you" ? "No Vicinity coins yet." : "No Vicinity coins held."),
        el("span", "muted small", !launched
          ? "$VICINITY and the city coins appear here as soon as they exist and you hold some. Anything else in a wallet is never shown."
          : who === "you" ? "When you hold $VICINITY or a city coin, it appears here with its live value. Other tokens in your wallet are never shown."
          : "Only $VICINITY and city coins are shown on a profile. Other tokens in a wallet never are."));
      host.append(e);
      return;
    }
    const slices = chartSlices(items, slots), geo = donutSlices(slices), id = ++uid;
    const body = el("div", "pf__body");

    // the ring
    const chart = el("div", "pf__chart");
    const s = svg("svg", { viewBox: "0 0 200 200", role: "img", "aria-labelledby": `pf-t${id} pf-d${id}`, focusable: "false" }, "pf-donut");
    const title = svg("title", { id: `pf-t${id}` }); title.textContent = who === "you" ? "Your portfolio" : "Portfolio";
    const desc = svg("desc", { id: `pf-d${id}` }); desc.textContent = describePortfolio(slices, p.totalUsd);
    s.append(title, desc);
    if (!geo.length) s.append(svg("circle", { cx: 100, cy: 100, r: 76, fill: "none", "stroke-width": 32 }, "pf-track"));
    for (const g of geo) {
      const path = svg("path", { d: g.d, "data-key": g.key }, `pf-slice ${g.slot >= 0 ? `pf-s${g.slot}` : "pf-sx"}`);
      if (g.full) path.setAttribute("fill-rule", "evenodd");
      const tip = svg("title"); tip.textContent = `${g.label}: ${fmtPct(g.frac * 100)} (${fmtUsd(g.value)})`;
      path.append(tip);
      s.append(path);
    }
    const label = svg("text", { x: 100, y: 93, "text-anchor": "middle" }, "pf-total__label"); label.textContent = geo.length ? "Total" : "No prices";
    const total = svg("text", { x: 100, y: 118, "text-anchor": "middle" }, "pf-total__value"); total.textContent = fmtUsdShort(p.totalUsd);
    s.append(label, total);
    chart.append(s);

    // the table
    const legend = el("div", "pf__legend");
    const table = el("table", "pf-table");
    const cap = el("caption", "sr-only", `${who === "you" ? "Your" : "Their"} $VICINITY and city coins: amount, value in US dollars and share of the total, biggest first.`);
    const head = el("thead"), hr = el("tr");
    for (const [t, c] of [["Coin", "pf-c-coin"], ["Amount", "pf-c-amt"], ["Value", "pf-c-val"]]) { const th = el("th", c, t); th.scope = "col"; hr.append(th); }
    head.append(hr);
    const tb = el("tbody");
    for (const it of items) {
      const slot = slots.get(it.mint), inChart = geo.some((g) => g.key === it.mint), key = inChart ? it.mint : geo.some((g) => g.key === "other") && num(it.valueUsd) && it.valueUsd > 0 ? "other" : "";
      const tr = el("tr"); if (key) tr.dataset.key = key;
      const c1 = el("th", "pf-c-coin"); c1.scope = "row";
      const sw = el("span", `pf-sw ${inChart && slot >= 0 ? `pf-s${slot}` : key === "other" ? "pf-sx" : "pf-sn"}`); sw.setAttribute("aria-hidden", "true");
      const nm = el("span", "pf-coin"); nm.append(el("strong", null, symbolOf(it)), el("span", "pf-sub", it.city ? `${it.city.name}, ${countryName(it.city.country)}` : it.name || "Vicinity"));
      c1.append(sw, nm);
      const c2 = el("td", "pf-c-amt", fmtAmount(it.amount));
      const c3 = el("td", "pf-c-val");
      if (num(it.valueUsd)) c3.append(el("strong", null, fmtUsd(it.valueUsd)), el("span", "pf-sub", fmtPct(it.sharePct)));
      else { c3.append(el("strong", null, "—"), el("span", "sr-only", "No price yet")); c3.title = "No price yet"; }
      tr.append(c1, c2, c3); tb.append(tr);
    }
    const foot = el("tfoot"), fr = el("tr");
    const f1 = el("th", "pf-c-coin", "Total"); f1.scope = "row"; f1.colSpan = 2;
    const f3 = el("td", "pf-c-val"); f3.append(el("strong", null, fmtUsd(p.totalUsd)));
    fr.append(f1, f3); foot.append(fr);
    table.append(cap, head, tb, foot);
    legend.append(table);
    const notes = [];
    if (p.pricesComplete === false || items.some((i) => !num(i.valueUsd))) notes.push("Some coins have no price right now, so they are left out of the ring and the total.");
    if (geo.some((g) => g.key === "other" && g.count > 1) || items.length > MAX_COLOURS) notes.push("Smaller holdings share the grey slice.");
    for (const n of notes) legend.append(el("p", "tiny muted pf-note", n));
    body.append(chart, legend);

    // hovering a row or a slice lights up its partner
    const hot = (key) => { if (key) { body.dataset.hot = key; } else delete body.dataset.hot; $$all(body, "[data-key]").forEach((n) => n.classList.toggle("is-hot", n.dataset.key === key)); };
    $$all(body, "[data-key]").forEach((n) => { n.addEventListener("mouseenter", () => hot(n.dataset.key)); n.addEventListener("mouseleave", () => hot(null)); });
    host.append(body);
  }
  const $$all = (root, sel) => [...root.querySelectorAll(sel)];

  /**
   * A portfolio that keeps itself fresh: asks again every `base` ms while the tab is visible, waits twice as long after each
   * failure and stops after four in a row (Refresh asks again), shows "Updated N s ago".
   *   load() -> the server's answer; pick(answer) -> the portfolio object or null; onAnswer(answer) -> any other part of the answer
   */
  function livePortfolio({ body, updated, msg, refresh, who, load, pick, onAnswer, launched, base = 30_000, maxAuto = Infinity, failText, errCtx = "profile" }) {
    const { el } = window.V;
    let slots = new Map(), last = null, failures = 0, timer = 0, ticker = 0, busy = false, stopped = false, autoRuns = 0, lastTry = 0;
    const say = (t) => { msg.textContent = t || ""; msg.hidden = !t; };
    const paintAge = () => {
      updated.textContent = last ? `Updated ${agoText(ageSeconds({ asOf: last.p.asOf, receivedAt: last.at, now: Date.now() }))}` : "";
    };
    function paint() {
      if (!last) return;
      slots = assignSlots(slots, last.p.items || []);
      drawPortfolio(body, last.p, { slots, who, launched: launched() });
      paintAge();
    }
    const auto = () => { autoRuns++; run(false); };
    function plan() {
      clearTimeout(timer);
      if (document.hidden || stopped) return;
      const wait = autoRuns >= maxAuto ? null : nextDelay(failures, base);
      if (wait == null) { stopped = true; say(autoRuns >= maxAuto && failures === 0 ? "Live updates paused. Tap Refresh to continue." : failText || "We couldn't update this. Tap Refresh to try again."); return; }
      timer = setTimeout(auto, wait);
    }
    async function run(manual) {
      if (busy) return;
      busy = true; lastTry = Date.now();
      if (manual) { stopped = false; failures = 0; autoRuns = 0; refresh.disabled = true; }
      const d = await load();
      busy = false; refresh.disabled = false;
      const p = d && d.ok ? pick(d) : null;
      if (d && d.ok && onAnswer) onAnswer(d);
      if (p) { last = { p, at: Date.now() }; failures = 0; say(""); paint(); }
      else {
        failures++;
        const text = d && d.ok ? "Balances are loading, try again." : errText(d, errCtx);
        if (last) say(`${text} Showing the last numbers we had.`);
        else { body.replaceChildren(el("p", "muted small", text)); say(""); }
      }
      plan();
    }
    function onVisible() {
      if (document.hidden) { clearTimeout(timer); return; }
      if (stopped) return;
      if (Date.now() - lastTry >= base) auto(); else plan();
    }
    return {
      /** `first` = numbers the page already has (they came with a profile); without it the first ask is made at once. */
      start(first) {
        document.addEventListener("visibilitychange", onVisible);
        ticker = setInterval(() => { if (!document.hidden) paintAge(); }, 1000);
        refresh.addEventListener("click", () => run(true));
        if (first) { last = { p: first, at: Date.now() }; lastTry = Date.now(); paint(); plan(); return Promise.resolve(); }
        body.replaceChildren(el("p", "muted small", "Loading…"));
        return run(false);
      },
      /** New numbers from the page itself (a reload of the profile): show them, keep the timer. */
      apply(p) { last = { p, at: Date.now() }; failures = 0; say(""); paint(); },
      run, paint,
      stop() { clearTimeout(timer); clearInterval(ticker); document.removeEventListener("visibilitychange", onVisible); },
    };
  }

  /* =====================================================================
     The dashboard: bio on the pass, bio field, network line, portfolio card, the one-time notice
     ===================================================================== */
  const NOTICE_KEY = "vicinity-profiles-notice";
  function dashboard(ctx) {
    const { $, el, api, toast } = window.V;
    let started = false, dismissed = false, pv = null;
    const counts = (d) => d.counts || (d.user && d.user.counts) || null;

    // ---- the bio
    const input = $("#bio-input"), count = $("#bio-count"), hint = $("#bio-hint"), err = $("#bio-err"), save = $("#bio-save");
    function check() {
      const c = bioCheck(input.value);
      count.textContent = `${c.count}/${c.max}`;
      count.classList.toggle("is-over", c.over);
      hint.textContent = c.over ? `${c.count - c.max} too many. Keep it to ${c.max} characters.` : c.problem ? BIO_HINT[c.problem] : "";
      hint.classList.toggle("is-warn", Boolean(c.over || c.problem));
      save.disabled = c.over;
      return c;
    }
    input.addEventListener("input", () => { err.hidden = true; check(); });
    $("#bio-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const c = check(); if (c.over) return;
      save.disabled = true; save.setAttribute("aria-busy", "true");
      const r = await ctx.sensitive(() => api("/api/me/bio", { bio: c.text }));
      save.removeAttribute("aria-busy"); check();
      if (!r || !r.ok) { err.textContent = errText(r, "bio"); err.hidden = false; return; }
      const me = ctx.me(); me.user.bio = r.bio == null ? "" : r.bio;
      input.value = me.user.bio; check(); paintPass(me);
      toast(me.user.bio ? "Bio saved ✓" : "Bio cleared ✓");
    });
    function paintPass(d) {
      const bio = (d.user && d.user.bio) || "";
      $("#me-bio").textContent = bio; $("#me-bio").hidden = !bio;
    }

    // ---- the one-time notice
    const seen = () => { try { return localStorage.getItem(NOTICE_KEY) === "1"; } catch { return false; } };
    const markSeen = () => { try { localStorage.setItem(NOTICE_KEY, "1"); } catch { /* private mode: it only stays hidden until the next visit */ } };
    $("#pf-notice-ok").addEventListener("click", () => { dismissed = true; markSeen(); $("#pf-notice").hidden = true; });

    function paintNetwork(d) {
      const c = counts(d), h = d.user && d.user.handle;
      const text = c ? `${fmt0(c.followers)} follower${c.followers === 1 ? "" : "s"} · ${fmt0(c.following)} following` : "";
      for (const sel of ["#pf-net", "#profile-net"]) { const n = $(sel); if (n) { n.textContent = text; n.hidden = !c; } }
      for (const sel of ["#pf-net-me", "#profile-net-link", "#pf-notice-open"]) { const a = $(sel); if (a) a.href = profileHref(h); }
    }
    const fmt0 = (n) => Number(n || 0).toLocaleString("en-US");

    return {
      render(d) {
        paintPass(d); paintNetwork(d);
        for (const sel of ["#bio-sec", "#profile-net-sec", "#profile-public-note"]) $(sel).hidden = false;
        if (!started) {
          started = true;
          if (new URLSearchParams(location.search).get("welcome")) { markSeen(); dismissed = true; } // someone who just signed up read it on the sign-up page
          pv = livePortfolio({
            body: $("#pf-body"), updated: $("#pf-updated"), msg: $("#pf-msg"), refresh: $("#pf-refresh"), who: "you",
            load: () => api("/api/me/portfolio"), pick: (r) => r.portfolio, launched: () => Boolean(ctx.me().launched),
            failText: "We couldn't update your portfolio. Tap Refresh to try again.", errCtx: "portfolio",
          });
          $("#portfolio").hidden = false;
          pv.start(null);
        }
        $("#pf-notice").hidden = dismissed || seen();
      },
      /** The profile window opened: fill the bio field with what is saved. */
      openModal(d) {
        input.value = (d.user && d.user.bio) || ""; err.hidden = true; check();
        paintNetwork(d);
      },
    };
  }

  /* =====================================================================
     The /profile page
     ===================================================================== */
  function page() {
    const { $, $$, el, api, toast, copy, fmt } = window.V;
    const params = new URLSearchParams(location.search);
    const show = (sel, on = true) => { const n = $(sel); if (n) n.hidden = !on; };
    const setErr = (t) => { const n = $("#pf-error"); n.textContent = t || ""; n.hidden = !t; };
    const say = (t) => { $("#pf-live").textContent = ""; setTimeout(() => ($("#pf-live").textContent = t), 30); }; // a polite announcement, repeated text included
    let meUser = null, cur = null, busy = false, pv = null, list = null, tickers = null;

    /* ----- who is looking ----- */
    async function start() {
      const lite = await window.V.ready;
      if (!lite || !lite.signedIn) return show("#pf-out");
      let on = lite.profilesFlag === true, user = lite.user;
      if (!on) { // the short answer may leave the switch out: ask the full one once
        const full = await api("/api/me");
        on = Boolean(full && full.signedIn && full.profilesFlag === true); user = (full && full.user) || user;
      }
      if (!on) return show("#pf-off");
      meUser = user || {};
      show("#pf-main");
      wireSearch(); wireActions(); wireLists(); wireDialog();
      const u = (params.get("u") || "").trim().replace(/^@+/, "");
      if (!u) return landing();
      if (!validHandle(u)) { $("#pf-q").value = u.slice(0, 20); show("#pf-intro"); return setErr("That isn't a username. Usernames are 3 to 20 letters, numbers or underscores."); }
      $("#pf-q").value = u;
      await load(u);
    }
    function landing() {
      show("#pf-intro");
      const mine = $("#pf-mine"); mine.hidden = !meUser.handle; if (meUser.handle) mine.href = profileHref(meUser.handle);
    }

    /* ----- search ----- */
    function wireSearch() {
      const q = $("#pf-q"), box = $("#pf-results"), status = $("#pf-search-status");
      let timer = 0, seq = 0; const cache = new Map();
      const results = () => $$("a", box);
      const clear = () => { box.replaceChildren(); box.hidden = true; };
      function draw(rows, text) {
        box.replaceChildren(...rows.map((r) => {
          const li = el("li"), a = el("a", "prof-result"); a.href = profileHref(r.handle);
          a.append(el("strong", null, r.handle), el("span", "muted small", r.home ? `${r.home.name}, ${countryName(r.home.country)}` : "No home community yet"));
          li.append(a); return li;
        }));
        box.hidden = !rows.length; status.textContent = text; status.classList.remove("is-err");
      }
      async function search(text) {
        const mine = ++seq;
        if (cache.has(text)) return draw(cache.get(text), cache.get(text).length ? `${cache.get(text).length} found` : `No member starts with “${text}”.`);
        status.textContent = "Searching…"; status.classList.remove("is-err");
        const d = await api(`/api/members/search?q=${encodeURIComponent(text)}`);
        if (mine !== seq) return;
        if (!d || !d.ok) { clear(); status.textContent = errText(d, "search"); status.classList.add("is-err"); return; }
        if (cache.size > 30) cache.clear();
        cache.set(text, d.results);
        draw(d.results, d.results.length ? `${d.results.length} found` : `No member starts with “${text}”.`);
      }
      q.addEventListener("input", () => {
        clearTimeout(timer); seq++;
        const text = cleanQuery(q.value);
        if (text.length < 2) { clear(); status.textContent = text.length ? "Type at least 2 characters." : ""; status.classList.remove("is-err"); return; }
        timer = setTimeout(() => search(text), 250);
      });
      $("#pf-search").addEventListener("submit", (e) => {
        e.preventDefault(); clearTimeout(timer);
        const text = cleanQuery(q.value);
        if (text.length < 2) { status.textContent = "Type at least 2 characters."; return; }
        const exact = () => results().find((a) => a.querySelector("strong").textContent.toLowerCase() === text.toLowerCase());
        if (exact()) return location.assign(exact().href);
        search(text).then(() => { if (exact()) return location.assign(exact().href); const first = results()[0]; if (first) first.focus(); });
      });
      q.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" && results().length) { e.preventDefault(); results()[0].focus(); } else if (e.key === "Escape") { q.value = ""; clear(); status.textContent = ""; } });
      box.addEventListener("keydown", (e) => {
        const r = results(), i = r.indexOf(document.activeElement);
        if (e.key === "ArrowDown") { e.preventDefault(); (r[i + 1] || r[0]).focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) q.focus(); else r[i - 1].focus(); }
        else if (e.key === "Home") { e.preventDefault(); r[0].focus(); }
        else if (e.key === "End") { e.preventDefault(); r[r.length - 1].focus(); }
        else if (e.key === "Escape") { e.preventDefault(); q.focus(); }
      });
    }

    /* ----- loading a profile ----- */
    async function load(handle, { quiet = false } = {}) {
      if (!quiet) { setErr(""); show("#pf-intro", false); show("#pf-view", false); show("#pf-loading"); }
      const d = await api(`/api/profile?u=${encodeURIComponent(handle)}`);
      show("#pf-loading", false);
      if (!d || !d.ok) {
        if (quiet) return d;
        if (d && (d.error === "sign_in" || d.error === "login_required")) { show("#pf-main", false); show("#pf-out"); return d; }
        show("#pf-intro");
        setErr(d && d.error === "not_found" ? `We couldn't find a member called “${handle}”. Check the spelling, or search above.` : errText(d, "profile"));
        return d;
      }
      cur = d.profile; show("#pf-view");
      paint(cur);
      document.title = `${cur.handle} · Member profile · Vicinity`;
      return d;
    }

    function paint(p) {
      const self = Boolean(p.viewer && p.viewer.self);
      $("#pf-avatar").textContent = window.V.initials(p.handle);
      $("#pf-handle").textContent = p.handle;
      $("#pf-home").textContent = homeText(p.home);
      const lvl = $("#pf-level"); lvl.textContent = levelLabel(p.level); lvl.dataset.level = p.level;
      $("#pf-coin").textContent = p.home ? tickerOf(p.home.name) : "—";
      if (p.home && tickers) { const t = tickers[p.home.id]; const tk = t ? (typeof t === "string" ? t : t[0]) : null; if (tk) $("#pf-coin").textContent = tk.slice(0, 5); }
      $("#pf-since").textContent = sinceText(p.since);
      const bio = $("#pf-bio");
      bio.textContent = p.bio || (self ? "You haven't written a bio yet." : "");
      bio.hidden = !p.bio && !self; bio.classList.toggle("is-empty", !p.bio);
      $("#pf-badges").replaceChildren(...(p.badges || []).filter((b) => b.earned).map((b) => { const li = el("li"); li.append(el("span", null, b.icon), el("span", null, b.name)); li.firstChild.setAttribute("aria-hidden", "true"); return li; }));
      // a member may have no wallet yet (onboarding v3: it is linked later, from the dashboard): say so, and offer nothing to copy or look up
      const linked = Boolean(p.wallet);
      $("#pf-wallet").textContent = linked ? p.wallet : "Wallet: not linked";
      $("#pf-wallet").classList.toggle("mono", linked);
      $("#pf-copy").hidden = !linked;
      $("#pf-solscan").hidden = !linked;
      $("#pf-solscan").href = linked ? `https://solscan.io/account/${p.wallet}` : "#";
      if (!tickers && p.home) loadTickers();

      // holdings
      const h = p.holding;
      $("#pf-hold-amount").textContent = h ? `${fmt(h.amount)} $VICINITY` : "—";
      $("#pf-hold-rank").textContent = h && h.rank ? `#${fmt(h.rank)} of ${fmt(h.total)}` : h && h.team ? "Team wallet" : "—";
      $("#pf-hold-pct").textContent = h && h.rank ? `Top ${pctText(h.percentile)}%` : h && h.team ? "Not ranked" : "—";
      $("#pf-hold-note").textContent = !linked ? (self ? "No wallet linked yet. Link one from your dashboard to show your $VICINITY here." : "No wallet linked yet.") : !h ? "No $VICINITY figures to show right now. They appear once $VICINITY is live." : h.amount > 0 ? "" : "Doesn't hold $VICINITY yet.";
      $("#pf-hold-note").hidden = !$("#pf-hold-note").textContent;

      // who is this, to me
      $("#pf-self").hidden = !self;
      const v = p.viewer || {};
      $("#pf-follow").hidden = self || Boolean(v.blocked);
      $("#pf-unblock").hidden = self || !v.blocked;
      $("#pf-menu-wrap").hidden = self;
      $("#pf-blocked-note").hidden = !v.blocked;
      paintFollow();
      paintCounts();
      $("#pf-blocks").hidden = !self;
      $("#pf-menu-block").textContent = v.blocked ? "Unblock" : "Block";
      $("#pf-menu-report").closest("li").hidden = !p.bio; // a report is about the bio: nothing to report without one
      paintPosts(p);

      // portfolio
      livePortfolioFor(p);
    }
    function paintCounts() {
      const c = (cur && cur.counts) || {};
      $("#pf-followers-n").textContent = fmt(c.followers); $("#pf-followers-l").textContent = c.followers === 1 ? "follower" : "followers";
      $("#pf-following-n").textContent = fmt(c.following);
    }
    const KIND = { meme: "Meme", checkin: "Check-in", talk: "Discussion" };
    /** The member's latest posts this viewer may see (the server picks them: same city or country feed). Read-only. */
    function paintPosts(p) {
      const posts = p.posts || [];
      $("#pf-posts").hidden = !posts.length;
      $("#pf-posts-list").replaceChildren(...posts.map((x) => {
        const li = el("li", "prof-post"), n = x.replies || 0;
        li.append(el("p", "tiny muted prof-post__meta", `${KIND[x.kind] || "Post"} · ${window.V.ago(x.at)} · ▲ ${fmt(x.score)}${n ? ` · ${fmt(n)} repl${n === 1 ? "y" : "ies"}` : ""}`));
        if (x.body) li.append(el("p", "prof-post__body", x.kind === "checkin" ? `📍 ${x.body}` : x.body));
        if (typeof x.image === "string" && /^\/api\/media\/\d+$/.test(x.image)) { const img = el("img", "prof-post__img"); img.src = x.image; img.alt = "Picture in this post"; img.loading = "lazy"; li.append(img); }
        return li;
      }));
    }
    function paintFollow() {
      const f = cur && cur.viewer && cur.viewer.following, b = $("#pf-follow");
      b.textContent = f ? "Following" : "Follow";
      b.setAttribute("aria-pressed", String(Boolean(f)));
      b.classList.toggle("btn--primary", !f); b.classList.toggle("btn--glass", Boolean(f));
      b.setAttribute("aria-label", `${f ? "Following" : "Follow"} ${cur ? cur.handle : ""}. ${f ? "Press to unfollow." : ""}`.trim());
    }

    function livePortfolioFor(p) {
      if (pv && pv.handle === p.handle) { if (p.portfolio) pv.apply(p.portfolio); return; }
      const handle = p.handle;
      pv = livePortfolio({
        body: $("#pp-body"), updated: $("#pp-updated"), msg: $("#pp-msg"), refresh: $("#pp-refresh"), who: p.viewer && p.viewer.self ? "you" : "them",
        // a profile counts against 120 views an hour: update once a minute, for ten minutes, then wait to be asked
        base: 60_000, maxAuto: 10, load: () => api(`/api/profile?u=${encodeURIComponent(handle)}`), pick: (r) => r.profile && r.profile.portfolio,
        launched: () => Boolean(cur && cur.holding),
        onAnswer: (r) => { cur = r.profile; paintLive(r.profile); },
        failText: "We couldn't update these balances. Tap Refresh to try again.",
      });
      pv.handle = handle;
      if (p.portfolio) pv.start(p.portfolio);
      else { $("#pp-body").replaceChildren(el("p", "muted small", "Balances are loading, try again.")); pv.start(null); }
    }
    function paintLive(p) {
      const h = p.holding;
      $("#pf-hold-amount").textContent = h ? `${fmt(h.amount)} $VICINITY` : "—";
      $("#pf-hold-rank").textContent = h && h.rank ? `#${fmt(h.rank)} of ${fmt(h.total)}` : h && h.team ? "Team wallet" : "—";
      $("#pf-hold-pct").textContent = h && h.rank ? `Top ${pctText(h.percentile)}%` : h && h.team ? "Not ranked" : "—";
      paintCounts();
    }
    async function loadTickers() {
      tickers = {}; // asked once; the page shows the name-based ticker until it arrives
      try {
        const r = await fetch("/data/tickers.json", { credentials: "same-origin" });
        if (r.ok) { tickers = await r.json(); if (cur) paint(cur); }
      } catch { /* the name-based ticker stays */ }
    }

    /* ----- follow, block, report ----- */
    function wireActions() {
      $("#pf-follow").addEventListener("click", toggleFollow);
      $("#pf-unblock").addEventListener("click", () => setBlock(false));
      $("#pf-copy").addEventListener("click", () => cur && cur.wallet && copy(cur.wallet, "Wallet address copied"));
      // the "…" menu: opens with Enter, Space or a click; arrows move; Escape or Tab closes
      const btn = $("#pf-menu-btn"), menu = $("#pf-menu"), items = () => $$("button", menu);
      const close = (focus) => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); if (focus) btn.focus(); };
      const open = () => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); items()[0].focus(); };
      btn.addEventListener("click", () => (menu.hidden ? open() : close(true)));
      btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); if (menu.hidden) open(); } });
      menu.addEventListener("keydown", (e) => {
        const r = items(), i = r.indexOf(document.activeElement);
        if (e.key === "ArrowDown") { e.preventDefault(); r[(i + 1) % r.length].focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); r[(i - 1 + r.length) % r.length].focus(); }
        else if (e.key === "Home") { e.preventDefault(); r[0].focus(); }
        else if (e.key === "End") { e.preventDefault(); r[r.length - 1].focus(); }
        else if (e.key === "Escape") { e.preventDefault(); close(true); }
        else if (e.key === "Tab") close(false);
      });
      document.addEventListener("click", (e) => { if (!menu.hidden && !$("#pf-menu-wrap").contains(e.target)) close(false); });
      $("#pf-menu-block").addEventListener("click", () => { close(false); if (cur.viewer.blocked) setBlock(false); else askBlock(); });
      $("#pf-menu-report").addEventListener("click", () => { close(false); askReport(); });
    }

    async function toggleFollow() {
      if (busy || !cur) return;
      busy = true; setErr(""); $("#pf-follow").setAttribute("aria-disabled", "true"); // stays focusable (a disabled button would drop the keyboard's place); a second press waits for the answer
      const was = Boolean(cur.viewer.following), before = { ...cur.counts };
      cur.viewer.following = !was; // optimistic: shows at once, taken back if the server says no
      cur.counts = { ...cur.counts, followers: Math.max(0, (cur.counts.followers || 0) + (was ? -1 : 1)) };
      paintFollow(); paintCounts();
      const d = await api("/api/follow", { handle: cur.handle, follow: !was });
      busy = false; $("#pf-follow").removeAttribute("aria-disabled");
      if (!d || !d.ok) {
        cur.viewer.following = was; cur.counts = before;
        paintFollow(); paintCounts();
        const t = errText(d, "follow"); setErr(t); toast(t);
        return;
      }
      cur.viewer.following = Boolean(d.following);
      if (d.counts) cur.counts = d.counts;
      paintFollow(); paintCounts();
      say(d.following ? `You now follow ${cur.handle}.` : `You no longer follow ${cur.handle}.`);
      if (list && list.kind === "followers" && !list.loading) openList("followers", true); // a list that is still loading already has the newest answer
    }
    async function setBlock(on) {
      if (busy || !cur) return;
      busy = true; setErr("");
      const d = await api("/api/block", { handle: cur.handle, block: on });
      busy = false;
      if (!d || !d.ok) { const t = errText(d, "block"); setErr(t); toast(t); return false; }
      say(on ? `You blocked ${cur.handle}.` : `You unblocked ${cur.handle}.`);
      await load(cur.handle, { quiet: true });
      const b = on ? $("#pf-unblock") : $("#pf-follow"); if (!b.hidden) b.focus();
      return true;
    }

    /* ----- followers / following ----- */
    function wireLists() {
      $("#pf-followers-btn").addEventListener("click", () => openList("followers"));
      $("#pf-following-btn").addEventListener("click", () => openList("following"));
      $("#pf-list-close").addEventListener("click", () => closeList(true));
      $("#pf-list-more").addEventListener("click", () => more());
      $("#pf-blocks-sum").addEventListener("click", () => setTimeout(() => { if ($("#pf-blocks").open) loadBlocks(); }, 0));
    }
    function closeList(focus) {
      const k = list && list.kind; list = null; show("#pf-lists", false);
      for (const b of ["#pf-followers-btn", "#pf-following-btn"]) $(b).setAttribute("aria-expanded", "false");
      if (focus && k) $(k === "followers" ? "#pf-followers-btn" : "#pf-following-btn").focus();
    }
    async function openList(kind, refresh) {
      if (!cur) return;
      if (!refresh && list && list.kind === kind) return closeList(true);
      list = { kind, next: null, loading: false, handle: cur.handle };
      for (const [k, b] of [["followers", "#pf-followers-btn"], ["following", "#pf-following-btn"]]) $(b).setAttribute("aria-expanded", String(k === kind));
      $("#pf-list-title").textContent = kind === "followers" ? `Followers of ${cur.handle}` : `${cur.handle} follows`;
      $("#pf-list").replaceChildren(); show("#pf-list-empty", false); show("#pf-list-more", false); show("#pf-list-err", false);
      show("#pf-lists");
      await more(true, !refresh);
    }
    async function more(first, focusTitle) {
      const l = list; if (!l || l.loading) return;
      l.loading = true; $("#pf-lists").setAttribute("aria-busy", "true"); show("#pf-list-err", false);
      const d = await api(`/api/follows?u=${encodeURIComponent(l.handle)}&list=${l.kind}${l.next ? `&after=${encodeURIComponent(l.next)}` : ""}`);
      l.loading = false; $("#pf-lists").removeAttribute("aria-busy");
      if (list !== l) return;
      if (!d || !d.ok) { const e = $("#pf-list-err"); e.textContent = errText(d, "profile"); e.hidden = false; show("#pf-list-more", Boolean(l.next) || !first); if (!first) $("#pf-list-more").textContent = "Try again"; return; }
      const rows = d.users.map((u) => {
        const li = el("li"), a = el("a", "prof-person"); a.href = profileHref(u.handle);
        const av = el("span", "idcard__avatar prof-person__av", window.V.initials(u.handle)); av.setAttribute("aria-hidden", "true");
        const id = el("span", "prof-person__id"); id.append(el("strong", null, u.handle), el("span", "muted small", u.home ? `${u.home.name}, ${countryName(u.home.country)}` : "No home community yet"));
        a.append(av, id); li.append(a); return li;
      });
      $("#pf-list").append(...rows);
      l.next = d.next || null;
      const empty = !$("#pf-list").children.length;
      $("#pf-list-empty").textContent = empty ? (l.kind === "followers" ? `${l.handle} has no followers yet.` : `${l.handle} doesn't follow anyone yet.`) : "";
      $("#pf-list-empty").hidden = !empty;
      $("#pf-list-more").textContent = "Load more"; $("#pf-list-more").hidden = !l.next;
      if (first && focusTitle) $("#pf-list-title").focus();
      else if (!first && rows.length) rows[0].querySelector("a").focus();
    }
    async function loadBlocks() {
      const box = $("#pf-blocks-list"); box.replaceChildren(el("li", "muted small", "Loading…"));
      const d = await api("/api/me/blocks");
      if (!d || !d.ok) return box.replaceChildren(el("li", "muted small", errText(d, "profile")));
      if (!d.users.length) return box.replaceChildren(el("li", "muted small", "You haven't blocked anyone."));
      box.replaceChildren(...d.users.map((u) => {
        const li = el("li", "prof-blocked"), a = el("a", null, u.handle); a.href = profileHref(u.handle);
        const b = el("button", "btn btn--glass btn--sm", "Unblock"); b.type = "button"; b.setAttribute("aria-label", `Unblock ${u.handle}`);
        b.addEventListener("click", async () => {
          b.disabled = true;
          const r = await api("/api/block", { handle: u.handle, block: false });
          if (!r || !r.ok) { b.disabled = false; return toast(errText(r, "block")); }
          li.remove(); say(`You unblocked ${u.handle}.`);
          if (!box.children.length) box.append(el("li", "muted small", "You haven't blocked anyone."));
        });
        li.append(a, b); return li;
      }));
    }

    /* ----- the dialog (confirm a block, send a report) ----- */
    let dialogFrom = null, dialogGo = null;
    function wireDialog() {
      const box = $("#pf-dialog");
      $("#pf-dialog-cancel").addEventListener("click", () => closeDialog());
      box.addEventListener("click", (e) => { if (e.target === box) closeDialog(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !box.hidden) { e.preventDefault(); closeDialog(); } });
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const f = $$("button, select, textarea, input, a[href]", box).filter((n) => !n.disabled && !n.closest("[hidden]"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      });
      $("#pf-dialog-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!dialogGo) return;
        const ok = $("#pf-dialog-ok"); ok.disabled = true; show("#pf-dialog-err", false);
        const msg = await dialogGo();
        ok.disabled = false;
        if (msg) { $("#pf-dialog-err").textContent = msg; show("#pf-dialog-err"); ok.focus(); return; }
        closeDialog(true);
      });
    }
    function openDialog({ title, text, ok, report, go }) {
      dialogFrom = $("#pf-menu-btn"); dialogGo = go; // both dialogs are opened from the "…" menu; its items are gone by now, so focus goes back to its button
      $("#pf-dialog-title").textContent = title; $("#pf-dialog-text").textContent = text;
      $("#pf-dialog-ok").textContent = ok; show("#pf-dialog-fields", Boolean(report)); show("#pf-dialog-err", false);
      $("#pf-dialog-ok").classList.toggle("btn--primary", true);
      show("#pf-dialog");
      $(report ? "#pf-report-reason" : "#pf-dialog-cancel").focus();
    }
    function closeDialog(done) {
      show("#pf-dialog", false); dialogGo = null;
      const back = dialogFrom && document.contains(dialogFrom) && !dialogFrom.closest("[hidden]") ? dialogFrom : $("#pf-menu-btn");
      if (back && !back.closest("[hidden]")) back.focus();
      dialogFrom = null;
    }
    function askBlock() {
      openDialog({
        title: `Block ${cur.handle}?`, ok: "Block",
        text: `${cur.handle} will stop following you and won't be able to follow you again. If you follow them, that stops too. You can unblock any time. They can still open your profile, as every member can.`,
        go: async () => { const r = await api("/api/block", { handle: cur.handle, block: true }); if (!r || !r.ok) return errText(r, "block"); say(`You blocked ${cur.handle}.`); await load(cur.handle, { quiet: true }); return ""; },
      });
    }
    function askReport() {
      $("#pf-report-note").value = "";
      openDialog({
        title: `Report ${cur.handle}'s bio`, ok: "Send report", report: true,
        text: "Tell us what's wrong with this bio. A moderator looks at it. Reports are not shared with the member.",
        go: async () => {
          const label = $("#pf-report-reason").selectedOptions[0].textContent, note = $("#pf-report-note").value.trim();
          let reason = (note ? `${label}: ${note}` : label).slice(0, 140); // the server keeps up to 140 characters
          if (/[\ud800-\udbff]$/.test(reason)) reason = reason.slice(0, -1);
          const r = await api("/api/profile/report", { handle: cur.handle, reason });
          if (!r || !r.ok) return errText(r, "report");
          toast("Thanks. A moderator will take a look."); return "";
        },
      });
    }

    start();
  }

  window.VProfile = { pure, dashboard };
  if (typeof document !== "undefined" && document.body && document.body.dataset.page === "profile" && window.V) page();
})();
