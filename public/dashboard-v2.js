// Dashboard v2 (DASHBOARD_V2=on only): the tab strip the existing cards move into, the Today strip, the Rankings tiles,
// the City header, Founder Status and the Founder card. dashboard.js fetches this file only when /api/me says
// dashboardV2: true, then drives it through window.VDash: init(ctx) before the page shows, render(d) after every
// /api/me, coin() after every coin answer, mod() after /api/mod, coinQueue(n) after the admin queue, start() once.
// It never asks the server for anything and never builds markup from text: every element it fills is static in
// dashboard.html, and it creates no element with an id.
//
// Where every element of dashboard.html lives (one place each; test/dashboard-v2.test.js checks the built page against ORDER):
//   GLOBAL (never moved)  #dash-skel, #dash-out, #dash-onboard, #proof-modal, #locate-modal, #toast, #termsgate
//   RETIRED (hidden)      #dash-main .dash-tools (#layout-edit, #layout-reset), #dash-main .dash-grid (#col-main, #col-side, emptied)
//   home      -> #panel-home       #pf-notice, #ban-notice, #lost-alert, #welcome, #dash-top, #today, #trade, #wallet-card, #role-home, #portfolio, #badges
//                                  (#wallet-card stands right after #welcome while it asks for something, after #trade as a phone's buy card: placeCard)
//   city      -> #panel-city       #city-subnav, #community, #coin, #city-about, #request
//   community -> #panel-community  #feed, #national
//   rankings  -> #panel-rankings   #rankings-card
//   founder   -> #panel-founder    #fcard, #lp-launch (the launch on the Vicinity launchpad, public/lp-launch.js), #progress, #squad,
//                                  #studio-card (gets #coin-studio out of #coin), #danger-zone, #founder-foot
//   moderate  -> #panel-moderate   #mod, #coin-admin-card (gets #coin-admin out of #coin)
//   profile   -> #panel-profile    #profile-modal (as an in-flow block), #roles-fold (gets #roles)
//   strip                          #dash-tabs (#dash-tablist, the #tab-* links, the glass pill .dtabs__ind and the #panel-* sections above)
(() => {
  "use strict";
  const { $, $$, el, fmt, mask, initials } = window.V;
  const byId = (id) => document.getElementById(id);

  const TABS = Object.freeze(["home", "city", "community", "rankings", "founder", "moderate", "profile"]);
  const LABEL = { home: "Home", city: "City", community: "Community", rankings: "Rankings", founder: "Founder", moderate: "Moderate", profile: "Profile" };
  // the cards, in the order they stand in each panel (the static v2 blocks are listed too, so the order is one list)
  const ORDER = Object.freeze({
    home: ["#pf-notice", "#ban-notice", "#lost-alert", "#welcome", "#dash-top", "#today", "#trade", "#wallet-card", "#role-home", "#portfolio", "#badges"],
    city: ["#city-subnav", "#community", "#coin", "#city-about", "#request"],
    community: ["#feed", "#national"],
    rankings: ["#rankings-card"],
    founder: ["#fcard", "#lp-launch", "#progress", "#squad", "#studio-card", "#danger-zone", "#founder-foot"],
    moderate: ["#mod", "#coin-admin-card"],
    profile: ["#profile-modal", "#roles-fold"],
  });
  // a link to a card by its old hash (#progress, #coin, ...) opens the card's tab, then scrolls to the card
  const ALIAS = { progress: "founder", squad: "founder", "coin-studio": "founder", "lp-launch": "founder", coin: "city", "cc-top": "city", request: "city", "city-about": "city",
    feed: "community", national: "community", mod: "moderate", roles: "profile", trade: "home", badges: "home", portfolio: "home", "role-home": "home", "wallet-card": "home", welcome: "home" };
  const HEADER = 67; // the site header: 66px plus its 1px border
  const QUEUE = [["posts", "reported post", "reported posts"], ["proposals", "ban proposal", "ban proposals"], ["appeals", "appeal", "appeals"],
    ["objections", "objection", "objections"], ["towns", "town request", "town requests"], ["coins", "coin contract to check", "coin contracts to check"]];

  let ctx = null, active = "home", pending = null, lastMod = null, coin = null, coinKnown = false, coinQueueN = 0, fcardAction = null, lastTarget = null, targetTimer = 0;
  // the glass pill behind the chosen tab: its box now ({ x, y, w, h }, or null until it has measured a tab), its slide on the way, and
  // whether the first tab has been shown (the first panel rises in; later ones come from the side of the tab that was left)
  let pill = null, pillAnim = null, started = false;
  // the launch on our own launchpad (public/lp-launch.js through dashboard.js): { on, state } once known; off = the LaunchLab path
  let lp = { on: false, state: null };
  const me = () => (ctx ? ctx.me() : null);
  const countryName = (cc) => (ctx ? ctx.countryName(cc) : cc);
  const behavior = () => (window.V.reduced ? "auto" : "smooth");
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const left = (iso) => { const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return "closing now"; const h = Math.floor(ms / 3600000); return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h}h left` : `${Math.ceil(ms / 60000)} min left`; };
  const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  const ticker = (name) => (window.vicinityTicker ? window.vicinityTicker.baseTicker(name) : String(name).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10));
  const modOn = () => { const m = me(); return Boolean((lastMod && lastMod.moderator === true) || (m && m.roles && m.roles.admin)); };
  // with the city-coin launch on (lp, public/lp-launch.js): the chain's word wins, so this fact agrees with the launch card's tag
  const coinState = () => (!coin ? "Not designed yet" : coin.launched || (lp.on && lp.state === "launched") ? "Live" : coin.waiting ? "Contract being checked"
    : lp.on && lp.state === "ready" ? "Approved" : "Designed");

  /* ---------- set-up: the cards move into their panels, the old two-column tools retire ---------- */
  function init(c) {
    ctx = c;
    for (const tab of TABS) {
      const panel = byId("panel-" + tab);
      for (const sel of ORDER[tab]) { const n = $(sel); if (n) panel.append(n); }
    }
    $("#studio-card").append($("#coin-studio"));
    $("#coin-admin-card").append($("#coin-admin"));
    $("#roles-fold").append($("#roles")); // the public roles section, folded under "How roles work"
    document.body.classList.add("is-dv2"); // polish-dash.css: the band above the strip goes, the header's line too
    $("#dash-main .dash-tools").hidden = true;
    $("#dash-main .dash-grid").hidden = true;
    // the profile modal becomes a block of the Profile tab; dashboard.js keeps filling it and its forms keep working
    const pm = $("#profile-modal");
    pm.classList.add("modal--panel"); pm.removeAttribute("role"); pm.removeAttribute("aria-modal");
    $("#profile-close").hidden = true;
    $("#community").classList.add("city-head");
    for (const id of ["studio-step-1", "studio-step-2", "studio-step-3"]) byId(id).hidden = false;
    window.V.openProfile = () => go("profile"); // the header button: dashboard.js's own opener runs when the tab is entered
    try { history.scrollRestoration = "manual"; } catch {}
    $("#dash-main").addEventListener("click", onClick);
    $("#dash-tablist").addEventListener("keydown", onKey);
    $("#dash-tablist").addEventListener("scroll", () => $("#dash-tabs").classList.toggle("is-scrolled", $("#dash-tablist").scrollLeft > 4), { passive: true });
    $("#fcard-go").addEventListener("click", () => { if (fcardAction) fcardAction(); });
    $("#trade").addEventListener("click", postProcess); // dashboard.js redraws the trade card on its own clicks
    window.addEventListener("hashchange", onHash);
    window.addEventListener("resize", () => measure());
    // the pill follows its tab whenever a tab changes size (the strip shown, a badge, a fit step, Moderate shown or hidden, a font
    // that loads late): it only moves the pill, which nothing observes, so it never loops. The fonts change the words' widths, so
    // the fit check runs again once they are in.
    if (window.ResizeObserver) {
      const ro = new window.ResizeObserver(() => place(false));
      ro.observe($("#dash-tablist"));
      for (const t of $$(".dtab", $("#dash-tablist"))) ro.observe(t);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => measure());
    try { localStorage.setItem("vicinity:dash-v2", "1"); } catch {}
    $("#dv2").hidden = false;
    $("#dash-skel").hidden = true;
  }

  /* ---------- the router: the URL hash is always a tab name ---------- */
  function parseHash() {
    const h = location.hash.slice(1);
    if (TABS.includes(h)) return { tab: h, target: null, ok: true };
    if (ALIAS[h]) return { tab: ALIAS[h], target: "#" + h, ok: false };
    return { tab: "home", target: null, ok: false };
  }
  const dv2Top = () => $("#dv2").getBoundingClientRect().top + window.scrollY - HEADER - 8;
  function go(tab, { push = true, scroll = true, replace = false } = {}) {
    if (!TABS.includes(tab)) tab = "home";
    if (tab === "moderate" && !modOn()) { pending = "moderate"; tab = "home"; push = false; replace = true; } // opens once /api/mod says so
    else if (push) pending = null; // the person chose another tab meanwhile: a late /api/mod answer must not pull them away from it
    const was = active;
    active = tab;
    // the panel comes in from the side of the tab that was left (polish-dash.css; set before the panel shows, and only on a change,
    // so the panel on screen never starts again)
    if (started && was !== tab) $("#dv2").dataset.dir = TABS.indexOf(tab) > TABS.indexOf(was) ? "next" : "prev";
    for (const t of $$(".dtab")) { const on = t.dataset.tab === tab; t.setAttribute("aria-selected", String(on)); t.setAttribute("tabindex", on ? "0" : "-1"); }
    for (const p of $$(".dpanel")) p.hidden = p.id !== "panel-" + tab;
    document.title = tab === "home" ? "Dashboard · Vicinity" : `${LABEL[tab]} · Dashboard · Vicinity`;
    const url = location.pathname + location.search + "#" + tab;
    if (replace) history.replaceState(null, "", url);
    else if (push && was !== tab) history.pushState(null, "", url);
    if (scroll) { const y = dv2Top(); if (window.scrollY > y) window.scrollTo({ top: y, behavior: behavior() }); }
    centerTab(tab);
    if (tab === "profile" && ctx) ctx.openProfile();
    measure(started && was !== tab); // a new tab the person chose: the pill slides there (the first one is simply set)
  }
  /** Only when the strip scrolls (200% text): bring the tab into view by the least distance ("nearest"), so Home is never pushed out. */
  function centerTab(tab) {
    const list = $("#dash-tablist"), t = byId("tab-" + tab);
    if (!list || !t || list.scrollWidth <= list.clientWidth + 1) return;
    const lr = list.getBoundingClientRect(), tr = t.getBoundingClientRect(), pad = 28;
    const dx = tr.left < lr.left + pad ? tr.left - lr.left - pad : tr.right > lr.right - pad ? tr.right - lr.right + pad : 0;
    if (dx) list.scrollTo({ left: list.scrollLeft + dx, behavior: behavior() });
  }
  /**
   * The strip fits the screen: every tab whole and shown, no sideways strip. Should seven tabs not fit (a moderator on a phone), one step
   * at a time: the gaps close (.is-snug), "Rankings" says "Rank" (.is-short), Founder and Moderate show as their icons (.is-compact). The
   * tabs never shrink below their words, so a tight strip is seen as one. Only if it still does not fit (a large text setting) does the
   * strip scroll (.is-scrollable, with edge fades). Then the glass pill goes to the chosen tab: it slides when `glide` is true (a new
   * tab), else it is set at once (a resize, a badge), unless it is already on its way. While the tabs are measured the pill is parked
   * at no size, so where it was a moment ago (a wider strip) never counts as overflow.
   */
  function measure(glide) {
    const list = $("#dash-tablist"), strip = $("#dash-tabs");
    if (!list || !strip) return;
    const over = () => list.scrollWidth > list.clientWidth + 1;
    const sliding = park();
    const steps = ["is-snug", "is-short", "is-compact", "is-scrollable"];
    strip.classList.remove(...steps);
    for (const step of steps) { if (!over()) break; strip.classList.add(step); }
    place(glide === true || sliding);
  }

  /* ---------- the glass pill: one marker behind the chosen tab that slides (and stretches a little) to the next one ---------- */
  // .dtabs__ind is static in dashboard.html, hidden from screen readers and the pointer (polish-dash.css), and sits inside the list,
  // so it scrolls with the tabs on a phone. Its box is the chosen tab's, to the sub-pixel, in the list's scrolled coordinates. It
  // slides with the Web Animations API (transform and width, 320 ms; the CSP allows script-set styles) and is set at once with
  // reduced motion or "Pause animations". Until it has measured a tab (the strip not laid out yet) the chosen tab keeps its own look.
  const PILL_MS = 320, PILL_EASE = "cubic-bezier(.2,.8,.2,1)";
  const r2 = (n) => Math.round(n * 100) / 100;
  /** Where the pill goes: the tab's rectangle in the list's content coordinates (rectangles from getBoundingClientRect). Pure. */
  function pillBox(tab, list, scrollLeft = 0, scrollTop = 0) {
    return { x: r2(tab.left - list.left + scrollLeft), y: r2(tab.top - list.top + scrollTop), w: r2(tab.width), h: r2(tab.height) };
  }
  const near = (a, b) => Boolean(a && b) && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
  const pillStyle = (b) => ({ transform: `translate(${b.x}px, ${b.y}px)`, width: `${b.w}px`, height: `${b.h}px` });
  /** The slide from one box to another: the leading edge runs ahead, the trailing edge follows (a short liquid stretch), then both
   *  settle on the new tab. Keyframes for element.animate. Pure. */
  function pillFrames(from, to) {
    if (Math.abs(to.x - from.x) < 1) return [pillStyle(from), pillStyle(to)];
    const right = to.x > from.x, lerp = (a, b, t) => a + (b - a) * t;
    const lead = 0.8, trail = 0.35; // how far each edge has gone at the middle of the slide
    const left = lerp(from.x, to.x, right ? trail : lead), end = lerp(from.x + from.w, to.x + to.w, right ? lead : trail);
    const mid = { x: r2(left), y: r2(lerp(from.y, to.y, 0.5)), w: r2(end - left), h: r2(lerp(from.h, to.h, 0.5)) };
    return [pillStyle(from), { ...pillStyle(mid), offset: 0.45 }, pillStyle(to)];
  }
  /** The pill's box from its computed style (mid-slide: where the animation has it now), or null. Pure. */
  function pillFromStyle(transform, width, height) {
    const m = /^matrix\(([^)]+)\)$/.exec(String(transform || "").trim());
    const p = m ? m[1].split(",").map(Number) : null;
    const w = parseFloat(width), h = parseFloat(height);
    return p && p.length === 6 && p.every(Number.isFinite) && Number.isFinite(w) && Number.isFinite(h) ? { x: r2(p[4]), y: r2(p[5]), w: r2(w), h: r2(h) } : null;
  }
  const pillEl = () => $("#dash-tablist .dtabs__ind");
  /** Stops a slide on its way (remembering where the pill is right now) and parks the pill at no size. True if it was sliding. */
  function park() {
    const ind = pillEl();
    if (!ind) return false;
    const sliding = Boolean(pillAnim);
    if (sliding) {
      const cs = window.getComputedStyle(ind);
      pill = pillFromStyle(cs.transform, cs.width, cs.height) || pill;
      pillAnim.cancel(); pillAnim = null;
    }
    ind.style.width = "0px"; ind.style.transform = "none";
    return sliding;
  }
  /** Puts the pill behind the chosen tab; `glide`: it slides there from where it is. */
  function place(glide) {
    const list = $("#dash-tablist"), strip = $("#dash-tabs"), ind = pillEl(), tab = byId("tab-" + active);
    if (!list || !strip || !ind) return;
    const tr = tab && !tab.hidden ? tab.getBoundingClientRect() : null, lr = list.getBoundingClientRect();
    if (!tr || !tr.width || !lr.width) { // not laid out (a hidden strip) or no chosen tab: the tab's own look, no pill
      if (pillAnim) { pillAnim.cancel(); pillAnim = null; }
      pill = null; strip.classList.remove("has-ind");
      return;
    }
    const to = pillBox(tr, lr, list.scrollLeft, list.scrollTop);
    if (pillAnim) {
      if (near(pill, to)) return; // already sliding there (a ResizeObserver answer mid-slide)
      glide = true; // sliding elsewhere: turn towards the new place from where it is now
      const cs = window.getComputedStyle(ind);
      pill = pillFromStyle(cs.transform, cs.width, cs.height) || pill;
      pillAnim.cancel(); pillAnim = null;
    }
    const from = pill;
    Object.assign(ind.style, pillStyle(to));
    pill = to;
    strip.classList.add("has-ind");
    if (glide && from && !near(from, to) && !window.V.reduced && typeof ind.animate === "function") {
      const anim = ind.animate(pillFrames(from, to), { duration: PILL_MS, easing: PILL_EASE });
      pillAnim = anim;
      anim.onfinish = () => { if (pillAnim === anim) pillAnim = null; };
    }
  }
  /** Open the tab a card is in and scroll to the card (opening any <details> around it). */
  function goTo(selector, { focus = true, openRole, noAlias = false } = {}) {
    let sel = selector;
    if (!noAlias && sel === "#coin" && !$("#studio-card").hidden) sel = "#coin-studio"; // the founder lands on the studio, everyone else on the coin
    if (sel === "#trade" && $("#trade").hidden && !$("#wallet-card").hidden) sel = "#wallet-card"; // a phone's Safari buys in the wallet app
    const target = $(sel);
    if (!target) return;
    const panel = target.closest(".dpanel");
    if (!panel) { window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - HEADER - 12, behavior: behavior() }); return; }
    const tab = panel.id.slice("panel-".length);
    go(tab, { push: tab !== active, scroll: false });
    if (active !== tab) return; // the tab is gated (Moderate without rights): it opens when the rights arrive
    for (let d = target.closest("details"); d; d = d.parentElement ? d.parentElement.closest("details") : null) d.open = true;
    if (openRole) { const r = $("#roles").querySelector(`details[data-role="${openRole}"]`); if (r) r.open = true; }
    if (target.closest("[hidden]")) return; // a card that is not shown right now (no squad, no studio): the tab is enough
    const top = target.getBoundingClientRect().top + window.scrollY - (HEADER + $("#dash-tabs").offsetHeight + 12);
    window.scrollTo({ top, behavior: behavior() });
    if (focus) {
      if (!target.matches("input, textarea, select, button, a[href], [tabindex]")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
    if (lastTarget) lastTarget.classList.remove("is-target");
    lastTarget = target; target.classList.add("is-target");
    clearTimeout(targetTimer);
    targetTimer = setTimeout(() => { target.classList.remove("is-target"); if (lastTarget === target) lastTarget = null; }, 1200);
  }
  function start() {
    const params = new URLSearchParams(location.search);
    if (params.get("claim")) { go("founder", { push: false, replace: true, scroll: false }); goTo("#progress", { focus: false }); }
    else { const p = parseHash(); go(p.tab, { push: false, replace: !p.ok, scroll: false }); if (p.target) goTo(p.target, { focus: false }); }
    measure();
    started = true;
  }
  function onHash() {
    const p = parseHash();
    if (p.target) { goTo(p.target, { focus: false }); return; }
    if (p.tab === active && p.ok) return;
    go(p.tab, { push: false, replace: !p.ok });
    const f = document.activeElement, inPanel = f && f.closest ? f.closest(".dpanel") : null;
    if (inPanel && inPanel.hidden) byId("tab-" + active).focus({ preventScroll: true });
  }
  function onClick(e) {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href[0] !== "#") return;
    if (a.dataset.go) { e.preventDefault(); goTo(a.dataset.go, { openRole: a.dataset.openRole, noAlias: a.dataset.exact === "1" }); return; }
    const h = href.slice(1);
    if (TABS.includes(h)) { e.preventDefault(); go(h); return; }
    if (ALIAS[h]) { e.preventDefault(); goTo(href); }
  }
  function onKey(e) {
    const tabs = $$(".dtab", $("#dash-tablist")).filter((t) => !t.hidden && t.getClientRects().length); // (a tab stepped out of a tight strip is skipped)
    const cur = tabs.indexOf(document.activeElement);
    let next = -1;
    if (e.key === "ArrowRight") next = cur < 0 ? 0 : (cur + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = cur < 0 ? tabs.length - 1 : (cur - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if ((e.key === " " || e.key === "Spacebar") && cur >= 0) { e.preventDefault(); tabs[cur].click(); return; }
    else return;
    e.preventDefault();
    const t = tabs[next];
    go(t.dataset.tab);
    t.focus({ preventScroll: true });
  }

  /* ---------- the Moderate tab: only when /api/mod (or the admin role) says so ---------- */
  function gate() {
    const on = modOn();
    $("#tab-moderate").hidden = !on;
    if (!on) $("#panel-moderate").hidden = true;
    if (on && pending === "moderate") { pending = null; go("moderate", { push: false, replace: true }); }
    else if (!on && active === "moderate") go("home", { push: false, replace: true });
    measure();
  }
  function queueCounts() {
    const m = lastMod && lastMod.moderator === true ? lastMod : null;
    const n = (k) => (m && Array.isArray(m[k]) ? (k === "proposals" ? m[k].filter((x) => x.canApprove).length : m[k].length) : 0);
    const counts = { posts: n("posts"), proposals: n("proposals"), appeals: n("appeals"), objections: n("objections"), towns: n("towns"), coins: coinQueueN };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const parts = QUEUE.filter(([k]) => counts[k]).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
    return { counts, total, parts };
  }
  function badge() {
    const { total } = queueCounts(), b = $("#tab-moderate-n");
    b.textContent = total ? String(total) : ""; b.hidden = !total;
    $("#tab-moderate").setAttribute("aria-label", total ? `Moderate, ${total} to review` : "Moderate"); // the count stays in the tab's name
    measure();
  }

  /* ---------- Today: up to four next steps, every one from a field /api/me, /api/mod or /api/coins already sends ---------- */
  function opensIn() {
    const at = window.V.opensAt ? window.V.opensAt() : 0, ms = at - Date.now();
    if (ms <= 0) return "";
    const dd = Math.floor(ms / 86400000), hh = Math.floor((ms % 86400000) / 3600000), mm = Math.floor((ms % 3600000) / 60000);
    return dd > 0 ? `${dd}d ${hh}h` : `${hh}h ${mm}m`;
  }
  function today(d) {
    const f = d.founder || {}, seat = f.seat, c = d.community, n = d.national, sq = d.squad, h = d.holding || {}, u = d.user;
    const city = u.home ? u.home.name : "your city", seated = Boolean(seat && (seat.status === "active" || seat.status === "steward"));
    const rows = [];
    const add = (title, sub, tone, tab, go, exact) => rows.push({ title, sub, tone, href: tab[0] === "/" ? tab : "#" + tab, go, exact });
    // (an account without a wallet: the wallet card is the first card of Home, so Today does not repeat "Link your wallet")
    if (seat && (seat.status === "grace" || (seat.status === "steward" && seat.graceUntil))) add("Top up your holding", `Hold ${fmt(seat.threshold)} $VICINITY again before ${when(seat.graceUntil)}`, "warn", "home", "#trade");
    if (seat && seat.status === "provisional") add("Objection period", `${seat.city} chose you · ends ${when(seat.appealUntil)}`, "info", "founder", "#progress");
    if (!seat && f.application) add(`You applied to found ${city}`, `Window closes ${when(f.application.closesAt)} (${left(f.application.closesAt)})`, "info", "founder", "#progress");
    if (!seat && !f.application && f.eligible) add(f.challenging ? `Challenge ${city}'s steward` : `Claim ${city}`, "You qualify. Apply from inside the city.", "ok", "founder", "#progress");
    const w = c && c.window;
    if (w && w.canEndorse && !w.myEndorsement && !(w.applicants || []).some((a) => a.you)) add("Endorse a founder", `${w.applicants.length} applying to found ${c.name} · ${left(w.closesAt)}`, "info", "founder", "#p-window");
    const e = n && n.election;
    if (e && e.canVote && !e.myVote) add("Vote for your Country Manager", `Election closes ${left(e.closesAt)}`, "info", "community", "#national");
    if (seated && coinKnown && !coin) add(`Design ${seat.city}'s coin`, "Name, pitch, pair, colour, logo. Public and logged.", "ok", "founder", "#coin-studio");
    if (seated && coin && !coin.mint && !coin.waiting && !lp.on) add("Add your coin's contract", "Launched it on Raydium LaunchLab? Send the address for a check.", "ok", "founder", "#cs-mint");
    if (seated && lp.on && lp.state === "ready") add("Launch your city coin", "An admin approved it. One signature in your wallet.", "ok", "founder", "#lp-launch");
    if (seated && coin && coin.waiting) add("Contract being checked", "An admin checks it on the blockchain. Nothing to do.", "info", "city", "#coin", true);
    const q = queueCounts();
    if (modOn() && q.total > 0) add(`${q.total} waiting for you`, q.parts.join(" · "), "warn", "moderate", q.total === q.counts.coins ? "#coin-admin" : "#mod");
    if (sq && sq.joinable && !sq.joinable.full) add(`A squad is forming in ${city}`, `${sq.joinable.members.length} of ${sq.joinable.max} members · join to pool holdings`, "info", "founder", "#squad");
    if (sq && sq.mine && sq.mine.ready && sq.mine.status !== "applied") add("Your squad is ready", "Apply as a squad from inside the city.", "ok", "founder", "#squad");
    if (!u.handle) add("Pick a username", "Your public name everywhere on Vicinity.", "info", "profile", "#username-input");
    if (d.launched && h.amount === 0 && !seat && u.wallet) add("Get $VICINITY", "Holding any amount unlocks posting, voting and your rank.", "info", "home", "#trade");
    if (!d.launched) {
      const soon = opensIn();
      add(soon ? `Launch in ${soon}` : "Launching now", soon ? "$VICINITY launches on Raydium LaunchLab. The Launchpad has the countdown." : "The contract is published on the Token page first.", "info", soon ? "/launchpad" : "/token", null);
    }
    $("#today-list").replaceChildren(...rows.slice(0, 4).map((r) => {
      const a = el("a", "today__card");
      a.href = r.href; a.dataset.tone = r.tone;
      if (r.go) a.dataset.go = r.go;
      if (r.exact) a.dataset.exact = "1";
      const arrow = el("span", "today__go", "→"); arrow.setAttribute("aria-hidden", "true");
      a.append(el("span", "today__title", r.title), el("span", "today__sub", r.sub), arrow);
      return a;
    }));
    $("#today").hidden = !rows.length;
  }

  /* ---------- Home's standing card: what you hold and your three ranks; one line and one button when there is nothing to rank ---------- */
  function standingState(d) {
    const h = d.holding || {};
    return !d.user.wallet ? "nowallet" : !d.launched ? "prelaunch" : h.team ? "team" : !(h.amount > 0) ? "none" : !h.rank ? "ranking" : "ranked";
  }
  const STANDING_WHY = { nowallet: "Link a wallet to see your rank.", prelaunch: "Ranks go live the moment $VICINITY launches.", team: "A team wallet: shown without a rank.",
    none: "Not ranked yet.", ranking: "Your rank is on its way: ranks refresh about every minute." };
  function standing(d) {
    const h = d.holding || {}, state = standingState(d), box = $("#standing");
    box.dataset.state = state;
    $("#standing .standing__hold").hidden = !["team", "ranking", "ranked"].includes(state);
    $("#standing .standing__ranks").hidden = state !== "ranked";
    // a rank chip with nothing in it is not shown (never a "—")
    for (const [id, has] of [["#d-rank", Boolean(h.rank)], ["#d-crank", Boolean(d.community && d.community.rank)], ["#d-nrank", Boolean(d.national && d.national.rank)]]) $(id).parentNode.hidden = !has;
    // the exact amount only when the short one rounds it (62.7M, not 50 twice)
    $("#d-amount-sub").hidden = !(h.amount > 0) || $("#d-amount").textContent === fmt(h.amount);
    const why = STANDING_WHY[state] || "", empty = $("#standing .standing__empty"), go = $("#standing .standing__go");
    empty.hidden = !why;
    $("#standing .standing__why").textContent = why;
    // (no wallet: the first card of Home is the wallet card with its Connect wallet button, so this line has none of its own)
    go.hidden = state !== "none";
  }

  /* ---------- where the wallet card stands, and the Buy card's state (dashboard.js calls this after every draw of the wallet card) ---------- */
  function placeCard() {
    const card = $("#wallet-card"), welcome = $("#welcome"), trade = $("#trade"), m = me();
    // asking for something (link a wallet, "wallet linked", "was this you?"): right under the welcome, the first card; a phone's buy card: where the Buy card was
    const top = card.dataset.place !== "buy";
    (top ? welcome : trade).after(card);
    const merged = top && !welcome.hidden && !card.hidden; // the welcome and the wallet card read as one card
    welcome.classList.toggle("is-merged", merged); card.classList.toggle("is-merged", merged);
    trade.hidden = Boolean(ctx && ctx.buyInApp && ctx.buyInApp());
    const locked = Boolean(m && m.user && !m.user.wallet && m.signupFlow === "v2"); // no wallet yet: buying needs one first, one line
    trade.classList.toggle("is-locked", locked);
    $("#trade .trade__lock").hidden = !locked;
  }

  /* ---------- Rankings: the same three numbers as the Home stat row, as tiles with the next wallet to pass ---------- */
  function tile(id, num, sub) {
    byId(id + "-rank").textContent = num; byId(id + "-sub").textContent = sub;
    byId(id).classList.toggle("is-empty", num === "—");
  }
  function board(id, b, label, fallback) {
    byId(id + "-label").textContent = label;
    tile(id, b && b.rank ? `#${fmt(b.rank)}` : "—", b && b.rank ? `of ${fmt(b.holders)} holders · top ${pctText((b.rank / b.holders) * 100)}%` : fallback);
    const note = byId(id + "-note");
    note.hidden = !b;
    if (b) note.textContent = `${fmt(b.members)} member${b.members === 1 ? "" : "s"}`;
  }
  function rankings(d) {
    const h = d.holding || {}, c = d.community, n = d.national, launched = d.launched, st = $("#rk-state");
    st.textContent = launched ? "● Live" : "Live at launch"; st.className = launched ? "tag tag--ok" : "tag";
    const fallback = !d.user.wallet ? "link a wallet" : launched ? (h.team ? "team wallet, not ranked" : h.amount > 0 ? "ranking…" : "not holding yet") : "live at launch";
    tile("rk-global", h.rank ? `#${fmt(h.rank)}` : "—", h.rank ? `of ${fmt(h.total)} · top ${pctText(h.percentile)}%` : fallback);
    const gap = $("#rk-global-gap");
    gap.hidden = !(h.next && h.next.gap > 0);
    if (!gap.hidden) gap.textContent = `${fmt(h.next.gap)} $VICINITY to catch #${h.next.rank}`;
    board("rk-country", n, n ? countryName(n.country) : "Your country", fallback);
    board("rk-city", c, c ? c.name : "Your city", fallback);
    $("#rk-note").textContent = launched ? "Ranks count people, not pools, program accounts or team wallets. Refreshed about every minute."
      : "Every rank goes live the moment $VICINITY launches. Your Early member badge is already yours.";
    // no rank anywhere: one clear empty state instead of three tiles of dashes
    const any = Boolean(h.rank || (c && c.rank) || (n && n.rank)), empty = $("#rankings-card .rk-empty"), state = standingState(d);
    empty.hidden = any; $("#rk-tiles").hidden = !any;
    if (!any) {
      $("#rankings-card .rk-empty__why").textContent = { nowallet: "Link a wallet to see where you stand among every holder.", prelaunch: "Every rank goes live the moment $VICINITY launches.",
        team: "Team wallets are shown without a rank.", none: "Hold any $VICINITY to get your rank.", ranking: "Your rank is on its way: ranks refresh about every minute." }[state] || "";
      $("#rankings-card .rk-empty__link").hidden = !(state === "nowallet" && d.signupFlow === "v2");
      $("#rankings-card .rk-empty__go").hidden = state !== "none";
    }
  }

  /* ---------- City: the community card as the city's header, and the About card ---------- */
  function cityHeader(d) {
    const c = d.community;
    if (!c) return;
    const tk = c.ticker || ticker(c.name), s = c.seat, st = $("#ch-status");
    const [text, cls] = s && s.status === "active" ? ["Founded", "tag tag--ok"]
      : s && s.status === "steward" ? ["Seed Steward on probation", "tag tag--gold"]
      : s && s.status === "provisional" ? ["Founder chosen · objections open", "tag tag--warn"]
      : s && s.status === "grace" ? ["Founder in grace", "tag tag--warn"]
      : c.window ? [`Choosing · ${c.window.applicants.length} applying`, "tag tag--warn"]
      : [d.launched ? "Seat open" : "Seat opens at launch", "tag"];
    st.textContent = text; st.className = cls; st.hidden = false;
    const q = s && s.quorum; // "verified locals" exists only as a steward's confirmation count
    $("#ch-locals").hidden = !q;
    if (q) $("#ch-locals-n").textContent = `${q.have} of ${q.need}`;
    $("#ch-coin").hidden = !coinKnown;
    if (coinKnown) $("#ch-coin-v").textContent = `$${tk} · ${coinState()}`;
    $("#ca-city").textContent = c.name;
    $("#ca-ticker").textContent = `$${tk}`;
    $("#ca-country").textContent = countryName(c.country);
    const T = (s && s.threshold) || (d.founder && d.founder.threshold);
    $("#ca-threshold").textContent = T ? `${fmt(T)} $VICINITY` : "Set by city size when the first claim is made (100K to 1M)";
    $("#ca-map").href = `/cities?city=${encodeURIComponent(c.id)}`;
    $("#studio-city").textContent = c.name;
  }

  /* ---------- Founder Status: the server's six steps (rendered by dashboard.js), plus the current step, a state pill and the informational rank ---------- */
  function statePill(d) {
    const f = d.founder || {}, s = f.seat;
    if (s) return { active: ["Founder confirmed", "tag--ok"], steward: ["Seed Steward · probation", "tag--gold"], provisional: ["Chosen · objections open", "tag--warn"], grace: ["In grace", "tag--no"] }[s.status] || null;
    if (f.application) return ["Applied · window open", "tag--warn"];
    if (!d.launched) return ["Opens at launch", ""];
    if (f.eligible) return f.challenging ? ["Qualified to challenge", "tag--ok"] : ["Qualified", "tag--ok"];
    return { no_home: ["Set your home", ""], home_too_new: ["Home too new", ""], not_qualified: f.tenure && f.tenure.days > 0 ? [`${f.tenure.needed}-day clock running`, "tag--gold"] : ["Below the bar", ""],
      below_threshold: ["Below the bar", "tag--warn"], cooldown: ["Cooling down", ""], city_taken: ["City has a founder", ""], banned: ["Banned", "tag--no"] }[f.why] || null;
  }
  function founderStatus(d) {
    const seat = d.founder && d.founder.seat, c = d.community, h = d.holding || {};
    const steps = $$("#p-steps > li");
    steps.forEach((li) => li.classList.remove("is-now"));
    const now = steps.find((li) => !li.classList.contains("is-ok"));
    if (now) now.classList.add("is-now");
    const pill = statePill(d), st = $("#fs-state");
    st.hidden = !pill;
    if (pill) { st.textContent = pill[0]; st.className = `tag fs-state ${pill[1]}`.trim(); }
    const ranked = Boolean(c && typeof c.rank === "number"), rk = $("#fs-rank");
    rk.hidden = !ranked;
    if (ranked) {
      $("#fs-rank-text").textContent = `You are #${c.rank} of ${c.holders} $VICINITY holder${c.holders === 1 ? "" : "s"} in ${c.name}, with ${fmt(h.amount)} $VICINITY.`;
      $("#fs-rank-note").textContent = "For information only: rank does not decide the founder. The first qualified claimer becomes Seed Steward at once; if several claim together, a 72-hour window scores them (50% local endorsements, 30% contribution, 20% holdings, capped at 2× the bar).";
    }
    $("#progress").classList.toggle("is-done", Boolean(seat && (seat.status === "active" || seat.status === "steward")));
  }

  /* ---------- the Founder card: shown to a seat holder of any status; the primary button follows the coin's state ---------- */
  function founderCard(d) {
    const seat = d.founder && d.founder.seat, card = $("#fcard");
    if (!seat) { card.hidden = true; return; }
    const u = d.user, c = d.community, q = c && c.seat && c.seat.quorum, st = seat.status;
    card.hidden = false; card.dataset.state = st;
    $("#fcard-kicker").textContent = { active: "City Founder ✓", steward: "Seed Steward · trial founder", provisional: "Chosen founder", grace: "City Founder · in grace" }[st] || "City Founder";
    const [stateText, stateCls] = st === "active" ? ["Active", "tag--ok"] : st === "steward" ? [`Probation · ${daysLeft(seat.probationUntil)} days left`, "tag--gold"]
      : st === "provisional" ? ["Objection period", "tag--warn"] : [`Until ${when(seat.graceUntil)}`, "tag--warn"];
    const state = $("#fcard-state"); state.textContent = stateText; state.className = `tag fcard__tag ${stateCls}`;
    $("#fcard-title").textContent = `${seat.city}, ${countryName(seat.country)}`;
    const who = $("#fcard-who"); who.textContent = u.handle ? `@${u.handle}` : mask(u.wallet); who.classList.toggle("mono", !u.handle);
    $("#fcard-pick").hidden = Boolean(u.handle);
    $("#fcard-since-label").textContent = st === "steward" ? "Steward since" : st === "provisional" ? "Chosen on" : "Founder since";
    $("#fcard-since").textContent = date(seat.since);
    $("#fcard-coin").textContent = coinKnown ? coinState() : "Checking…";
    const row = $("#fcard-clock-row"), clockLabel = $("#fcard-clock-label"), clock = $("#fcard-clock");
    row.hidden = st === "active"; // the only clocks that exist: probation, the 48-hour objection period, grace
    if (st === "steward") { clockLabel.textContent = "Probation until"; clock.textContent = `${date(seat.probationUntil)}${q ? ` · ${q.have} of ${q.need} verified local holders` : ""}`; }
    else if (st === "provisional") { clockLabel.textContent = "Objections until"; clock.textContent = when(seat.appealUntil); }
    else if (st === "grace") { clockLabel.textContent = "Grace ends"; clock.textContent = when(seat.graceUntil); }
    const go = $("#fcard-go"), note = $("#fcard-note");
    const button = (label, cls, fn) => { go.hidden = false; go.textContent = label; go.className = cls; fcardAction = fn; };
    if (st === "provisional") { note.textContent = "No founder powers yet. Locals can object until then; if no objection is upheld, you become the founder."; button("Founder path", "btn btn--primary", () => goTo("#progress")); }
    else if (st === "grace") { note.textContent = `Hold ${fmt(seat.threshold)} $VICINITY again before the deadline or the seat reopens. Moderation is paused meanwhile.`; button("Buy & swap", "btn btn--primary", () => goTo("#trade")); }
    else if (!coinKnown) { note.textContent = ""; go.hidden = true; fcardAction = null; }
    else if (!coin) { note.textContent = `Your coin, your call. Design ${seat.city}'s coin: everyone in ${seat.city} sees it.`; button("Design the city coin", "btn btn--primary", () => goTo("#coin-studio")); }
    else if (coin.launched) { note.textContent = `${seat.city}'s coin is live. Its design is locked for good, as the rules promise.`; button("Manage city coin", "btn btn--primary", () => goTo("#coin", { noAlias: true })); }
    else if (coin.waiting) { note.textContent = "An admin is checking the contract. Once recorded, the design is locked and it becomes the one official coin."; button("See the coin", "btn btn--glass", () => goTo("#coin", { noAlias: true })); }
    else if (lp.on) {
      const s = lp.state;
      note.textContent = s === "ready" ? "An admin approved your coin. Launch it on the Vicinity launchpad: one signature in your wallet."
        : s === "launched" ? "Your coin is live on the Vicinity launchpad."
          : s === "expired" ? "Your approval expired. Ask an admin to approve your coin again."
            : s === "paused" ? "Launches are paused for now. Your approval stays."
              : "An admin approves your coin on chain first; your pair must be SOL. Then you launch it here.";
      button(s === "ready" ? "Launch your city coin" : s === "launched" ? "See your coin" : "See the launch", s === "ready" ? "btn btn--primary" : "btn btn--glass", () => goTo("#lp-launch"));
    }
    else { note.textContent = "Launch it on Raydium LaunchLab, then add the contract here. An admin (never you) checks and records it."; button("Add the contract", "btn btn--primary", () => goTo("#cs-mint")); }
    $("#fcard-alt").hidden = !((st === "active" || st === "steward") && modOn());
    $("#fcard-meter").hidden = st !== "steward";
  }

  /* ---------- the studio card wraps the existing form; a few sentences point at tabs instead of "below" or "on the right" ---------- */
  function studioSync() {
    const cs = $("#coin-status"), ss = $("#studio-state");
    ss.textContent = cs.textContent; ss.className = cs.className;
    $("#studio-card").hidden = $("#coin-studio").hidden;
  }
  function postProcess() {
    const note = $("#coin-note");
    if (note.textContent.endsWith(" in the panel on the right.")) note.textContent = note.textContent.replace(" in the panel on the right.", " on the Home tab.");
    for (const p of $$("#role-home > p.small")) if (p.textContent.endsWith(" below.")) p.textContent = p.textContent.slice(0, -" below.".length) + " on the Founder tab.";
    const go = $("#tr-go");
    if (go.textContent.endsWith(" ↓")) go.textContent = go.textContent.slice(0, -2) + " →";
  }

  /* ---------- what dashboard.js calls ---------- */
  function render(d) {
    $("#tab-home").classList.toggle("is-alert", !$("#ban-notice").hidden || !$("#lost-alert").hidden);
    $("#tab-profile .dtab__av").textContent = initials(d.user.handle || d.user.name || "V");
    gate();
    placeCard(); standing(d); today(d); rankings(d); cityHeader(d); founderStatus(d); founderCard(d); studioSync(); postProcess();
  }
  function setCoin(c) {
    coin = c && c.coin ? c.coin : null; coinKnown = true;
    const d = me(); if (!d) return;
    today(d); cityHeader(d); founderCard(d); studioSync(); postProcess();
  }
  function mod(d) {
    lastMod = d || null;
    gate(); badge();
    const m = me(); if (m) { today(m); founderCard(m); }
  }
  function coinQueue(n) {
    coinQueueN = n;
    $("#coin-admin-card").hidden = $("#coin-admin").hidden;
    badge();
    const m = me(); if (m) today(m);
  }

  /** The launch card's state (dashboard.js after LPLaunch.founder): the Today strip and the Founder card follow it. */
  function setLp(info) {
    lp = { on: Boolean(info && info.on), state: (info && info.state) || null };
    const d = me(); if (d) { today(d); founderCard(d); }
  }

  window.VDash = { init, render, coin: setCoin, lp: setLp, mod, coinQueue, start, go, goTo, placeCard, get active() { return active; }, TABS, ORDER, ALIAS: Object.freeze(ALIAS),
    pill: Object.freeze({ box: pillBox, frames: pillFrames, fromStyle: pillFromStyle, ms: PILL_MS, easing: PILL_EASE }) };
})();
