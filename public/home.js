// Home page (design v4, 12 Oct 2026): the hero's second button (Sign up, or My dashboard for a member), the live numbers bar under the
// hero, the FAQ's tabs, and redirects for old links (/#cities → /cities, /#nyc → New York City on the live map ...).
// The numbers bar (rule R1: every number is a real answer, a number nobody answered for is left out):
//   $VICINITY price + 24 h change, market cap, 24 h volume, holders, live city coins  ← /api/launchpad (its `vicinity` card and `coins`)
//                                                                          (/api/token's price and market cap while the Launchpad list is off)
//   members (shown from 100)                                               ← /api/members
//   communities, countries & territories                                  ← /data/stats.json
// It is drawn ONCE, when every source has answered or after 2.5 s, whichever comes first, in a bar whose height is fixed from the first
// paint, so nothing on the page moves (CLS); an item is never removed after that, and a later failure keeps the last value. The plain
// counts count up once (site.js's motion layer, V.liveNums), a price never counts from $0; the market numbers refresh every 60 s while
// the tab is visible and ease to a new value. A computer shows the first five items with a value; a phone swipes through all of them.
(() => {
  "use strict";
  const { $, $$, api, reduced } = window.V;

  // Old one-page links still work: a section that moved opens where it lives now; one that is gone stays on this page without a dead
  // anchor in the address bar (#how is this page's "How it works"; #faq, #buy-faq and #why-launchlab are the FAQ's).
  const NYC = "/cities?city=5128581";
  const OLD = { "#token": "/token", "#holders": "/token#holders", "#wallet": "/connect", "#cities": "/cities", "#launchpad": "/launchpad", "#check": "/token#check",
    "#nyc": NYC, "#story": NYC, "#demo": NYC, "#roles": "/dashboard#roles", "#get": "/token#buy-slot" };
  const GONE = ["#why", "#why-now", "#for-cities", "#problem", "#roadmap"];
  /** true when the hash was an old link (it left for its new page, or was cleared); the page's own hashes are left alone */
  const oldLink = () => {
    if (OLD[location.hash]) { location.replace(OLD[location.hash]); return true; }
    if (GONE.includes(location.hash)) { history.replaceState(history.state, "", location.pathname + location.search); return true; }
    return false;
  };
  if (oldLink() && location.hash) return; // on its way to another page

  /* ---------- the hero's second button: "Sign up" for a guest, "My dashboard" for a member ---------- */
  // Both labels sit in the button, one over the other, so it is as wide as the wider one whichever shows (no shift when it swaps).
  // Before the first paint the browser's memory picks the label (theme.js: :root[data-guest], pages-home.css); /api/me corrects it
  // only when that guess was wrong (a member whose session ended, a member on a new browser).
  const second = $("[data-hero-second]");
  const member = (yes) => {
    if (!second) return;
    second.classList.toggle("is-member", yes); second.classList.toggle("is-guest", !yes);
    second.href = yes ? "/dashboard" : "/connect";
  };
  if (second && !("guest" in document.documentElement.dataset)) second.href = "/dashboard"; // the label already says My dashboard
  window.V.ready.then((d) => member(Boolean(d && d.signedIn)));

  /* ---------- the live numbers bar ---------- */
  const bar = $("#tk"), src = $("#tk-src");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const plainFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const centsFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  /** 0 < a < 1 with `sig` significant digits, never in exponent form (the Launchpad cards' rule). */
  const small = (a, sig) => a.toFixed(Math.min(16, Math.max(2, -Math.floor(Math.log10(a)) - 1 + sig))).replace(/(\.\d\d\d*?)0+$/, "$1");
  /** A dollar amount the way the Launchpad cards write it: $1.2M, $45.3K, $12.50, $0.0042 (three significant digits). */
  function money(v) {
    const n = num(v); if (n == null) return null;
    const a = Math.abs(n), sign = n < 0 ? "-" : "";
    if (a >= 1000) return `${sign}$${compactFmt.format(a)}`;
    if (a >= 1) return `${sign}$${centsFmt.format(a)}`;
    return a === 0 ? "$0" : `${sign}$${small(a, 3)}`;
  }
  const fullMoney = (v) => { const n = num(v); return n == null ? null : Math.abs(n) >= 1 || n === 0 ? `$${centsFmt.format(n)}` : `$${small(Math.abs(n), 6)}`; };
  /** The 24-hour change: "▲ 2.31%" / "▼ 0.74%" (the arrow says the direction, never the colour alone). */
  const change = (v) => { const n = num(v); if (n == null) return null; const a = Math.abs(n); return { text: `${n > 0 ? "▲ " : n < 0 ? "▼ " : ""}${a.toFixed(a >= 10 ? 1 : 2)}%`, cls: n > 0 ? "is-up" : n < 0 ? "is-down" : "is-flat", title: `${n > 0 ? "+" : n < 0 ? "-" : ""}${a.toFixed(2)}% in 24 hours` }; };
  const MEMBERS_MIN = 100; // a small count makes the map look empty (d3): no members item below 100
  const STALE_MS = 3 * 60 * 1000; // a market answer older than this (its source kept failing since) shows the Delayed tag

  /** Every item the bar can show, in its order, from the answers so far: { key, label, text, title, chg?, stale? } or null (left out). */
  function items(a) {
    const lp = a.lp && a.lp.ok ? a.lp : null, vic = lp && lp.vicinity, mk = (vic && vic.market) || {}, from = mk.sources || {};
    const tok = !lp && a.token && a.token.launched ? a.token : null; // the Launchpad list is off: the token page's own price
    const said = (how, source) => [how, source].filter(Boolean).join(" · ");
    const out = [];
    // the market numbers are $VICINITY's own (not the network's): their titles and screen-reader labels say so
    // a source that kept failing leaves its last answer on screen: once it is older than STALE_MS it is marked Delayed, like a stale copy
    const at = lp ? a.lpAt : tok ? a.tokenAt : null, old = num(at) != null && Date.now() - at > STALE_MS;
    const stale = Boolean((lp && mk.stale) || old);
    const price = lp ? num(mk.priceUsd) : num(tok && tok.price);
    if (price != null) out.push({ key: "price", label: "$VICINITY", text: money(price), chg: lp ? change(mk.priceChange24hPct) : null, stale,
      title: said(`$VICINITY price ${fullMoney(price)}`, lp ? from.price : "Jupiter") + (stale ? " · last good copy" : "") });
    const mcap = lp ? num(mk.marketCapUsd) : num(tok && tok.marketCap);
    if (mcap != null) out.push({ key: "mcap", label: "Market cap", sr: "$VICINITY ", text: money(mcap), title: said(`$VICINITY market cap ${fullMoney(mcap)}`, lp ? from.marketCap : "Jupiter price × supply") });
    const vol = lp ? num(mk.volume24hUsd) : null;
    if (vol != null) out.push({ key: "vol", label: "24h volume", sr: "$VICINITY ", text: money(vol), title: said(`$VICINITY 24 h volume ${fullMoney(vol)}`, from.volume24h) });
    const holders = num(vic && vic.holders && vic.holders.count);
    if (holders != null) out.push({ key: "holders", label: "Holders", sr: "$VICINITY ", text: plainFmt.format(holders), title: `${plainFmt.format(holders)} people hold $VICINITY · counted by vicinity.city (pools and team wallets excluded)` });
    // "live" is a coin with a recorded contract: it may not have traded yet, so the title says live, not "trade"
    const live = lp && Array.isArray(lp.coins) ? lp.coins.filter((c) => c && c.status === "live").length : null;
    if (live) out.push({ key: "coins", label: "City coins live", text: plainFmt.format(live), title: `${plainFmt.format(live)} city ${live === 1 ? "coin" : "coins"} live on the Vicinity Launchpad` });
    const members = num(a.members && a.members.members);
    if (members != null && members >= MEMBERS_MIN) out.push({ key: "members", label: "Members", text: plainFmt.format(members), title: `${plainFmt.format(members)} verified members` });
    const st = a.stats || {};
    if (num(st.communities)) out.push({ key: "communities", label: "Communities", text: plainFmt.format(st.communities), title: `${plainFmt.format(st.communities)} communities mapped, from OpenStreetMap and GeoNames` });
    if (num(st.countries)) out.push({ key: "countries", label: "Countries & territories", text: plainFmt.format(st.countries), title: `${plainFmt.format(st.countries)} countries and territories` });
    return out;
  }

  /** The line under the bar, one short line: whose market data the $VICINITY numbers are (Jupiter's terms ask for "Powered by Jupiter"
   *  wherever its data shows; only the sources behind a number shown), then where every other number comes from. Links only to the
   *  three market hosts. "$VICINITY market data: Powered by Jupiter · All sources" */
  const SHORT = { "Jupiter": "Powered by Jupiter", "Raydium": "Raydium LaunchLab", "DEX Screener": "DEX Screener" };
  function sourceLine(a, shown) {
    const lp = a.lp && a.lp.ok ? a.lp : null, mk = (lp && lp.vicinity && lp.vicinity.market) || {};
    const market = shown.some((i) => ["price", "mcap", "vol"].includes(i.key));
    const named = [];
    if (market && lp && Array.isArray(lp.attribution)) {
      const used = Object.values(mk.sources || {}).filter((s) => typeof s === "string").join(" ");
      for (const x of lp.attribution) {
        if (!x || typeof x.text !== "string") continue;
        const names = ["Jupiter", "DEX Screener", "Raydium"].filter((n) => x.text.includes(n) && used.includes(n));
        if (!names.length) continue; // e.g. the bonding curve's line: the bar shows none of its numbers
        const u = typeof x.url === "string" && /^https:\/\/(jup\.ag|raydium\.io|dexscreener\.com)(\/|$)/.test(x.url) && !/[\s"'<>]/.test(x.url) ? x.url : null;
        if (!named.some((n) => n.textContent.startsWith(SHORT[names[0]]))) named.push(link(SHORT[names[0]], u));
      }
    } else if (market) named.push(link("Powered by Jupiter", "https://jup.ag"));
    const parts = [];
    if (named.length) { const lead = document.createElement("span"); lead.textContent = "$VICINITY market data: "; parts.push([lead, ...named.flatMap((n, i) => (i ? [", ", n] : [n]))]); }
    const all = document.createElement("a"); all.href = "/credits"; all.textContent = "All sources";
    parts.push([all]);
    return parts.flatMap((n, i) => (i ? [" · ", ...n] : n));
  }
  function link(text, url) {
    if (!url) { const s = document.createElement("span"); s.textContent = text; return s; }
    const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = text;
    const sr = document.createElement("span"); sr.className = "sr-only"; sr.textContent = " (opens in a new tab)"; a.append(sr);
    return a;
  }

  const answers = {};
  const cells = new Map(); // key → { val, chg, tag } once drawn
  let drawn = false;

  /** Draws the bar once (see the top of this file): every item with a value, the first five marked for a computer. */
  function draw() {
    if (drawn || !bar) return;
    const list = items(answers);
    if (!list.length) return; // nothing yet: the bar keeps its room and waits for the first answer
    drawn = true;
    const dot = document.createElement("li"); dot.className = "tk__dot"; dot.setAttribute("aria-hidden", "true");
    const ping = document.createElement("span"); ping.className = "live-dot"; dot.append(ping);
    const lis = list.map((it, i) => {
      // a computer shows the first five; a phone the first four, two by two (an odd last one takes the whole row)
      const li = document.createElement("li"); li.className = `tk__item tk__item--${it.key}` + (i >= 5 ? " tk__item--more" : "") + (i >= 4 ? " tk__item--p5" : "") + (i === Math.min(4, list.length) - 1 && i % 2 === 0 ? " tk__item--wide" : ""); li.title = it.title;
      const label = document.createElement("span"); label.className = "tk__label"; label.textContent = it.label;
      if (it.sr) { const sr = document.createElement("span"); sr.className = "sr-only"; sr.textContent = it.sr; label.prepend(sr); } // "$VICINITY Market cap" read aloud
      const line = document.createElement("span"); line.className = "tk__line";
      const val = document.createElement("strong"); val.className = "tk__val"; val.textContent = "—";
      line.append(val);
      const c = { li, val, chg: null, tag: null, key: it.key };
      if (it.key === "price") {
        c.chg = document.createElement("span"); c.chg.className = "tk__chg"; line.append(c.chg);
        c.tag = document.createElement("span"); c.tag.className = "tag tag--gold tk__delayed"; c.tag.textContent = "Delayed"; c.tag.title = "A source answered with its last good copy (at most a few minutes old)"; line.append(c.tag);
      }
      li.append(label, line);
      cells.set(it.key, c);
      return li;
    });
    bar.replaceChildren(dot, ...lis);
    bar.removeAttribute("aria-busy");
    bar.classList.add("is-drawn");
    if (window.V.liveNums) window.V.liveNums([...cells.values()].map((c) => c.val)); // followed before the first value: a count starts from 0 once
    paint(list);
    if (src) src.replaceChildren(...sourceLine(answers, list));
  }
  /** Writes the values into the items already drawn (a refresh never adds or removes an item: nothing moves). */
  function paint(list = items(answers)) {
    for (const it of list) {
      const c = cells.get(it.key); if (!c) continue;
      if (c.val.textContent !== it.text) c.val.textContent = it.text;
      c.li.title = it.title;
      if (c.chg) { c.chg.hidden = !it.chg; if (it.chg) { c.chg.textContent = it.chg.text; c.chg.className = `tk__chg ${it.chg.cls}`; c.chg.title = it.chg.title; } }
      if (c.tag) c.tag.hidden = !it.stale;
    }
  }

  const get = (path) => fetch(path, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  /** The market answers: the Launchpad list, or the token page's price while that list is switched off (404 not_enabled). */
  async function market() {
    const lp = await api("/api/launchpad");
    if (lp && lp.ok) { answers.lp = lp; answers.lpAt = Date.now(); return; }
    if (!answers.lp) { const t = await api("/api/token"); if (t && t.launched && (num(t.price) != null || answers.token == null)) { answers.token = t; answers.tokenAt = Date.now(); } }
  }
  async function people() { const m = await api("/api/members"); if (m && typeof m.members === "number") answers.members = m; }

  if (bar) {
    const sources = [market(), people(), get("/data/stats.json").then((s) => { if (s) answers.stats = s; })];
    Promise.race([Promise.allSettled(sources), new Promise((r) => setTimeout(r, 2500))]).then(() => {
      draw();
      // nothing had answered by then: the first answer draws it
      if (!drawn) sources.forEach((p) => p.then(draw));
    });
    // only the API sources refresh (stats.json is a file of the build); a hidden tab asks nothing, and catches up when it shows again
    let last = Date.now();
    const refresh = () => { if (!drawn || document.hidden) return; last = Date.now(); Promise.allSettled([market(), people()]).then(() => paint()); };
    setInterval(() => { if (Date.now() - last >= 59000) refresh(); }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - last >= 60000) refresh(); });
  }

  /* ---------- the FAQ's tabs (role=tablist; the panels carry hidden until their tab is chosen) ---------- */
  // Arrow keys move between tabs (Home/End to the ends), the chosen tab is the only Tab stop of its list (WAI-ARIA tabs), and a link
  // to a question inside a panel that is not showing (/#why-launchlab) opens that panel first, then lands on the question.
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
  window.addEventListener("hashchange", () => { if (!oldLink()) openFor(location.hash); }); // an old link typed into an open page too
})();
